//! アカウントの状態と流れ（spec「流れ」「token の寿命と更新」「更新の失敗時」「失効」）。
//!
//! - 状態は [`AccountState`]（未ログイン・ログイン中・ログイン済み・オフライン・期限切れ）。変わるたびに [`AccountService::subscribe`]
//!   の listener へ渡す（Tauri の層が event `niho-account://changed` にする）。
//! - ID token はメモリだけ（[`AccountService::id_token`]。期限の 5 分前から更新・single-flight）。接続 refresh token と pending は保存先（app data のファイル。spec D-16 改）、
//!   プロフィールと顔写真はこの Mac のファイル（[`crate::store`]）。
//! - 失敗の分岐は spec の表のとおり。401 `app_connection_revoked` / `session_revoked` → 期限切れ、403 `ACCOUNT_DELETED` /
//!   `firebase_user_disabled` → 全部消す、ネットワーク・5xx・503・429 → 状態は変えずオフライン＋指数バックオフ（1→2→4→… 最大 5 分）。

use crate::api::{self, ApiFailure, CallFailure};
use crate::client::{EnvKind, Environment};
use crate::error::AccountError;
use crate::http::{HttpClient, HttpErrorKind};
use crate::pending::{epoch_ms, Pending};
use crate::pkce;
use crate::secret::{AccountSecretStore, Secret, SecretKind};
use crate::store::{AccountStore, StoredAccount, AVATAR_MAX_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};
use url::Url;

/// ログへ書く（kind, payload）。アプリが自分のログ（camera.log など）へ書く closure を渡す。秘密は渡さない。
pub type LogFn = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// 時計（テストで進める）。
pub trait Clock: Send + Sync {
  fn now(&self) -> SystemTime;
}

pub struct SystemClock;

impl Clock for SystemClock {
  fn now(&self) -> SystemTime {
    SystemTime::now()
  }
}

/// ID token を更新し始める、期限までの余裕。
pub const REFRESH_LEAD: Duration = Duration::from_secs(5 * 60);
/// 一時的な失敗の再試行の間隔の上限。
pub const BACKOFF_MAX: Duration = Duration::from_secs(5 * 60);
/// 覚えておく、処理済みの `state` の数（同じ `state` の 2 回目を捨てる）。
const CONSUMED_STATES_MAX: usize = 16;

/// 画面に出すプロフィール（token は含まない）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
  pub user_id: String,
  /// 空なら画面が「NIHO アカウント」などで補う
  pub display_name: String,
  pub handle: Option<String>,
  /// この Mac に保存した顔写真（`asset:` / `convertFileSrc` で出す）
  pub avatar_path: Option<PathBuf>,
  pub connection_id: String,
}

/// API 呼び出し開始時に捕捉する、接続先と login generation の変更不能 ticket。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountSessionTicket {
  pub user_id: String,
  pub connection_id: String,
  pub environment: EnvKind,
  pub generation: u64,
}

/// 「期限切れ」の理由。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExpiredReason {
  /// 接続の解除・期限切れ・再利用の検知・ほかの端末でのログアウト（401 `app_connection_revoked`）・保存先に接続 refresh token が無い
  ConnectionRevoked,
  /// パスワード変更などユーザー全体の失効（401 `session_revoked`）
  SessionRevoked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AccountState {
  SignedOut,
  /// pending あり（ブラウザで続行中）
  SigningIn {
    since_ms: u64,
  },
  SignedIn {
    profile: Profile,
  },
  /// 接続 refresh token はあるが更新できていない（ネットワーク・5xx）
  Offline {
    profile: Profile,
  },
  /// もう一度ログインが要る
  Expired {
    profile: Profile,
    reason: ExpiredReason,
  },
}

impl AccountState {
  pub fn kind(&self) -> &'static str {
    match self {
      AccountState::SignedOut => "signedOut",
      AccountState::SigningIn { .. } => "signingIn",
      AccountState::SignedIn { .. } => "signedIn",
      AccountState::Offline { .. } => "offline",
      AccountState::Expired { .. } => "expired",
    }
  }

  pub fn profile(&self) -> Option<&Profile> {
    match self {
      AccountState::SignedIn { profile }
      | AccountState::Offline { profile }
      | AccountState::Expired { profile, .. } => Some(profile),
      _ => None,
    }
  }
}

/// `begin_login` の返り。`url` を既定のブラウザで開くのは呼び出し側（Tauri の層）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BeginLogin {
  pub url: Url,
  pub expires_at: SystemTime,
}

pub struct ServiceConfig {
  pub env: Environment,
  pub secrets: Arc<dyn AccountSecretStore>,
  pub http: Arc<dyn HttpClient>,
  pub data_dir: PathBuf,
  /// この Mac の名前（`exchange` の body でだけ送る）
  pub device_name: String,
  pub clock: Arc<dyn Clock>,
  pub log: LogFn,
}

impl ServiceConfig {
  pub fn new(
    env: Environment,
    secrets: Arc<dyn AccountSecretStore>,
    http: Arc<dyn HttpClient>,
    data_dir: PathBuf,
    device_name: impl Into<String>,
  ) -> ServiceConfig {
    ServiceConfig {
      env,
      secrets,
      http,
      data_dir,
      device_name: device_name.into(),
      clock: Arc::new(SystemClock),
      log: Arc::new(|_, _| {}),
    }
  }

  pub fn clock(mut self, clock: Arc<dyn Clock>) -> ServiceConfig {
    self.clock = clock;
    self
  }

  pub fn log(mut self, log: LogFn) -> ServiceConfig {
    self.log = log;
    self
  }
}

#[derive(Clone)]
enum Account {
  SignedOut,
  Connected {
    stored: StoredAccount,
  },
  Expired {
    stored: StoredAccount,
    reason: ExpiredReason,
  },
}

struct IdToken {
  token: Secret,
  expires_at: SystemTime,
}

#[derive(Default)]
struct Backoff {
  failures: u32,
  next_retry_at: Option<SystemTime>,
}

impl Backoff {
  fn blocks(&self, now: SystemTime) -> bool {
    self.next_retry_at.is_some_and(|at| at > now)
  }

  fn record_failure(&mut self, now: SystemTime) {
    self.failures = self.failures.saturating_add(1);
    let exponent = self.failures.saturating_sub(1).min(16);
    let delay = Duration::from_secs(1u64 << exponent).min(BACKOFF_MAX);
    self.next_retry_at = Some(now + delay);
  }

  fn reset(&mut self) {
    self.failures = 0;
    self.next_retry_at = None;
  }
}

struct Inner {
  pending: Option<Pending>,
  account: Account,
  /// 取り替えた接続 refresh token を保存先に書けなかったときだけ持つ（この起動の間はこれを使う。spec D-15 改・§token の寿命と更新）。
  /// 保存に成功したら消す。ログアウト・期限切れ・新しいログイン・再起動で消える
  unsaved_refresh_token: Option<Secret>,
  /// `Connected` で、最後の更新が成功している（か、まだ失敗していない）
  online: bool,
  id_token: Option<IdToken>,
  backoff: Backoff,
  consumed_states: VecDeque<String>,
  /// ログアウト・期限切れで進める。更新の途中でこれが変わっていたら、その結果は捨てる
  generation: u64,
}

type Listener = Box<dyn Fn(&AccountState) + Send + Sync>;

pub struct AccountService {
  env: Environment,
  secrets: Arc<dyn AccountSecretStore>,
  http: Arc<dyn HttpClient>,
  store: AccountStore,
  device_name: String,
  clock: Arc<dyn Clock>,
  log: LogFn,
  inner: Mutex<Inner>,
  /// 更新（refresh → signInWithCustomToken）の single-flight
  refresh_lock: tokio::sync::Mutex<()>,
  /// deep link の処理・ログアウトの single-flight
  flow_lock: tokio::sync::Mutex<()>,
  /// pending の開始・消費・削除を直列化する（保存先とメモリの状態をずらさない）。
  pending_lock: Mutex<()>,
  /// この Mac のファイル（プロフィール・顔写真）の書き込みと、全部消す（wipe）を直列化する。await をまたいで持たない
  storage_lock: Mutex<()>,
  listeners: Mutex<Vec<Listener>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn fresh(token: &IdToken, now: SystemTime) -> bool {
  token.expires_at > now + REFRESH_LEAD
}

fn usable(token: &IdToken, now: SystemTime) -> bool {
  token.expires_at > now
}

/// 更新の失敗の分類（spec「更新の失敗時」の表）。
enum RefreshOutcome {
  Expired(ExpiredReason),
  AccountGone,
  Disabled,
  Temporary,
}

fn classify_refresh_failure(failure: &CallFailure) -> RefreshOutcome {
  match failure {
    CallFailure::Api(api) if api.status == 401 => {
      if api.reason_is("session_revoked") {
        RefreshOutcome::Expired(ExpiredReason::SessionRevoked)
      } else {
        RefreshOutcome::Expired(ExpiredReason::ConnectionRevoked)
      }
    }
    CallFailure::Api(api)
      if api.status == 403 && (api.code_is("ACCOUNT_DELETED") || api.reason_is("firebase_user_disabled")) =>
    {
      RefreshOutcome::AccountGone
    }
    CallFailure::Api(api) if api.status == 404 && api.reason_is("app_connect_disabled") => RefreshOutcome::Disabled,
    _ => RefreshOutcome::Temporary,
  }
}

/// `load_pending` の結果。
enum LoadedPending {
  None,
  /// 期限内で、まだ交換を始めていない
  Live(Pending),
  /// 交換を始めたあとアプリが終わっていた（state だけ。同じコードは再提示しない）
  Consumed(String),
}

/// 処理済みの `state` を覚える（同じ `state` の 2 回目を捨てる）。
fn remember_consumed(inner: &mut Inner, state: &str) {
  if inner.consumed_states.iter().any(|known| known == state) {
    return;
  }
  inner.consumed_states.push_back(state.to_string());
  while inner.consumed_states.len() > CONSUMED_STATES_MAX {
    inner.consumed_states.pop_front();
  }
}

impl AccountService {
  pub fn new(config: ServiceConfig) -> AccountService {
    AccountService {
      env: config.env,
      secrets: config.secrets,
      http: config.http,
      store: AccountStore::new(config.data_dir),
      device_name: config.device_name,
      clock: config.clock,
      log: config.log,
      inner: Mutex::new(Inner {
        pending: None,
        account: Account::SignedOut,
        unsaved_refresh_token: None,
        online: true,
        id_token: None,
        backoff: Backoff::default(),
        consumed_states: VecDeque::new(),
        generation: 0,
      }),
      refresh_lock: tokio::sync::Mutex::new(()),
      flow_lock: tokio::sync::Mutex::new(()),
      pending_lock: Mutex::new(()),
      storage_lock: Mutex::new(()),
      listeners: Mutex::new(Vec::new()),
    }
  }

  pub fn env(&self) -> &Environment {
    &self.env
  }

  /// 現在の verified 接続と login generation を 1 つの ticket として捕捉する。
  pub fn session_ticket(&self) -> Result<AccountSessionTicket, AccountError> {
    let inner = lock(&self.inner);
    let stored = match &inner.account {
      Account::Connected { stored } => stored,
      Account::Expired { .. } => return Err(AccountError::expired()),
      Account::SignedOut => return Err(AccountError::signed_out()),
    };
    Ok(AccountSessionTicket {
      user_id: stored.user_id.clone(),
      connection_id: stored.connection_id.clone(),
      environment: self.env.kind(),
      generation: inner.generation,
    })
  }

  /// token refresh は generation を変えず、logout/relogin（同じ UID を含む）は無効化する。
  pub fn is_session_current(&self, ticket: &AccountSessionTicket) -> bool {
    if ticket.environment != self.env.kind() {
      return false;
    }
    let inner = lock(&self.inner);
    inner.generation == ticket.generation
      && matches!(&inner.account, Account::Connected { stored }
        if stored.user_id == ticket.user_id && stored.connection_id == ticket.connection_id)
  }

  /// ticket を token await の前後で検査する。別接続の token は返さない。
  pub async fn id_token_for(&self, ticket: &AccountSessionTicket) -> Result<Secret, AccountError> {
    if !self.is_session_current(ticket) {
      return Err(AccountError::signed_out());
    }
    let token = self.id_token().await?;
    if !self.is_session_current(ticket) {
      return Err(AccountError::signed_out());
    }
    Ok(token)
  }

  fn now(&self) -> SystemTime {
    self.clock.now()
  }

  fn log(&self, kind: &str, payload: Value) {
    (self.log)(kind, payload);
  }

  /// 状態が変わったときに呼ばれる（Tauri の層が event にする）。登録した時点の状態も 1 回渡す。
  pub fn subscribe(&self, listener: impl Fn(&AccountState) + Send + Sync + 'static) {
    let state = self.state();
    listener(&state);
    lock(&self.listeners).push(Box::new(listener));
  }

  fn notify(&self) {
    let state = self.state();
    let listeners = lock(&self.listeners);
    for listener in listeners.iter() {
      listener(&state);
    }
  }

  fn state_of(&self, inner: &Inner, now: SystemTime) -> AccountState {
    if let Some(pending) = &inner.pending {
      if !pending.is_expired(now) {
        return AccountState::SigningIn {
          since_ms: pending.started_at_ms,
        };
      }
    }
    match &inner.account {
      Account::SignedOut => AccountState::SignedOut,
      Account::Connected { stored } => {
        let profile = self.store.profile(stored);
        if inner.online {
          AccountState::SignedIn { profile }
        } else {
          AccountState::Offline { profile }
        }
      }
      Account::Expired { stored, reason } => AccountState::Expired {
        profile: self.store.profile(stored),
        reason: *reason,
      },
    }
  }

  /// 今の状態（副作用なし）。
  pub fn state(&self) -> AccountState {
    let now = self.now();
    let inner = lock(&self.inner);
    self.state_of(&inner, now)
  }

  /// 保存してあるプロフィール（ログイン済み・オフライン・期限切れのとき）。
  pub fn profile(&self) -> Option<Profile> {
    self.state().profile().cloned()
  }

  // ───────────────────────── 起動 ─────────────────────────

  /// 起動時: この Mac のプロフィール・保存先の接続 refresh token と pending を読んで状態を決める（通信はしない）。
  pub fn restore(&self) {
    let now = self.now();
    let _storage = lock(&self.storage_lock);
    let stored = self.store.load();
    let mut account = match stored {
      None => Account::SignedOut,
      Some(stored) => match stored.expired {
        Some(reason) => Account::Expired { stored, reason },
        None => Account::Connected { stored },
      },
    };
    let mut online = true;
    if let Account::Connected { stored } = &account {
      match self.secrets.get(SecretKind::RefreshToken) {
        Ok(Some(_)) => {}
        Ok(None) => {
          // 接続 refresh token だけが無い（保存先の項目が消された）。もう一度ログイン
          self.log(
            "account.restore.refresh_token_missing",
            json!({ "connectionId": stored.connection_id }),
          );
          let mut expired = stored.clone();
          expired.expired = Some(ExpiredReason::ConnectionRevoked);
          let _ = self.store.save(&expired);
          account = Account::Expired {
            stored: expired,
            reason: ExpiredReason::ConnectionRevoked,
          };
        }
        Err(error) => {
          self.log(
            "account.keychain.failed",
            json!({ "op": "get", "kind": "refreshToken", "code": error.code }),
          );
          online = false;
        }
      }
    }
    let mut consumed_state = None;
    let pending = match self.secrets.get(SecretKind::Pending) {
      Ok(Some(secret)) => match Pending::from_secret(&secret, self.env.client) {
        Some(pending) if pending.is_expired(now) => {
          self.log("account.pending.expired", json!({ "at": "restore" }));
          let _ = self.secrets.delete(SecretKind::Pending);
          None
        }
        Some(pending) if pending.consumed => {
          // 交換の途中でアプリが終わった。同じコードを API に再提示しない（再利用と見なされる）。戻りが来ても捨てる
          self.log("account.pending.consumed_dropped", json!({ "at": "restore" }));
          let _ = self.secrets.delete(SecretKind::Pending);
          consumed_state = Some(pending.state);
          None
        }
        Some(pending) => Some(pending),
        None => {
          self.log("account.pending.invalid", json!({ "at": "restore" }));
          let _ = self.secrets.delete(SecretKind::Pending);
          None
        }
      },
      Ok(None) => None,
      Err(error) => {
        self.log(
          "account.keychain.failed",
          json!({ "op": "get", "kind": "pending", "code": error.code }),
        );
        None
      }
    };
    {
      let mut inner = lock(&self.inner);
      inner.account = account;
      inner.online = online;
      inner.pending = pending;
      inner.id_token = None;
      inner.unsaved_refresh_token = None;
      if let Some(state) = consumed_state {
        remember_consumed(&mut inner, &state);
      }
    }
    let state = self.state();
    self.log("account.restore", json!({ "state": state.kind() }));
    self.notify();
  }

  /// 起動の一連: `restore` → 接続があれば更新してプロフィールを取り直す（失敗は状態に反映し、Err にしない）。
  pub async fn start(&self) {
    self.restore();
    if matches!(lock(&self.inner).account, Account::Connected { .. }) {
      if let Err(error) = self.refresh_profile().await {
        self.log("account.start.profile_failed", json!({ "code": error.code }));
      }
    }
  }

  // ───────────────────────── ログインの開始・中止 ─────────────────────────

  /// verifier / challenge / state を作り、pending を保存先に置き、接続 URL を返す。開くのは呼び出し側。
  /// ログイン済みのとき・有効な pending がある間は `busy`（先に開いたブラウザの戻りを無効にしない。やり直しは「やめる」から）。
  pub fn begin_login(&self) -> Result<BeginLogin, AccountError> {
    let _pending_operation = lock(&self.pending_lock);
    let now = self.now();
    {
      let inner = lock(&self.inner);
      if matches!(inner.account, Account::Connected { .. }) {
        return Err(AccountError::busy());
      }
      if inner.pending.as_ref().is_some_and(|pending| !pending.is_expired(now)) {
        return Err(AccountError::busy());
      }
    }
    let verifier = pkce::random_base64url_32()?;
    let state = pkce::random_base64url_32()?;
    let challenge = pkce::code_challenge(&verifier);
    let pending = Pending {
      verifier,
      state,
      client: self.env.client,
      started_at_ms: epoch_ms(now),
      consumed: false,
    };
    self
      .secrets
      .set(SecretKind::Pending, &pending.to_secret())
      .inspect_err(|error| {
        self.log(
          "account.keychain.failed",
          json!({ "op": "set", "kind": "pending", "code": error.code }),
        );
      })?;
    let url = pkce::connect_url(&self.env, &challenge, &pending.state);
    let expires_at = pending.expires_at();
    {
      let mut inner = lock(&self.inner);
      inner.pending = Some(pending);
      inner.generation = inner.generation.wrapping_add(1);
    }
    self.log("account.begin_login", json!({ "client": self.env.client.as_str() }));
    self.notify();
    Ok(BeginLogin { url, expires_at })
  }

  /// pending を捨てる（「やめる」）。進行中の戻りの処理があれば、その結果は捨てられ、作った接続は解除される。
  pub fn cancel_login(&self) -> Result<(), AccountError> {
    match self.drop_pending(None) {
      Ok(true) => {
        self.log("account.cancel_login", json!({}));
        self.notify();
        Ok(())
      }
      Ok(false) => Ok(()),
      Err(error) => {
        self.notify();
        Err(error)
      }
    }
  }

  /// pending をメモリと保存先から消す。`only_state` を渡すと、今の pending がその state のときだけ消す（古い試行が、
  /// 「やめる」のあとに始めた新しい pending を消さない）。メモリから消したら true。
  fn drop_pending(&self, only_state: Option<&str>) -> Result<bool, AccountError> {
    let _pending_operation = lock(&self.pending_lock);
    self.drop_pending_locked(only_state)
  }

  /// `pending_lock` を保持している呼び出し元から使う。pending の読込と破棄の間に新しいログインが始まる競合を防ぐ。
  fn drop_pending_locked(&self, only_state: Option<&str>) -> Result<bool, AccountError> {
    let pending = {
      let mut inner = lock(&self.inner);
      match (&inner.pending, only_state) {
        (Some(pending), Some(state)) if pending.state != state => return Ok(false),
        (None, Some(_)) => return Ok(false),
        (Some(_), _) => {
          let mut pending = inner.pending.take().expect("pending was checked above");
          pending.consumed = true;
          inner.pending = Some(pending.clone());
          inner.generation = inner.generation.wrapping_add(1);
          Some(pending)
        }
        (None, None) => None,
      }
    };

    // 永続側を先に consumed にする。保存先 delete が失敗しても、再起動後に古い callback を認証へ使わせない。
    if let Some(pending_to_consume) = &pending {
      if let Err(error) = self.secrets.set(SecretKind::Pending, &pending_to_consume.to_secret()) {
        self.log(
          "account.keychain.failed",
          json!({ "op": "set", "kind": "pending", "code": &error.code }),
        );
        // consumed を保存できない場合は削除を試す。両方失敗したら、現在のプロセスでは consumed を保持し、
        // キャンセル失敗を呼び出し元へ返す（保存先に live pending が残ったまま成功扱いしない）。
        if let Err(delete_error) = self.secrets.delete(SecretKind::Pending) {
          self.log(
            "account.keychain.failed",
            json!({ "op": "delete", "kind": "pending", "code": delete_error.code }),
          );
          return Err(error);
        }
        if let Some(pending_state) = &pending {
          let mut inner = lock(&self.inner);
          if inner
            .pending
            .as_ref()
            .is_some_and(|current| current.state == pending_state.state)
          {
            inner.pending = None;
          }
        }
        return Ok(pending.is_some());
      }
    }

    if let Err(error) = self.secrets.delete(SecretKind::Pending) {
      self.log(
        "account.keychain.failed",
        json!({ "op": "delete", "kind": "pending", "code": error.code }),
      );
    }
    if let Some(pending) = pending {
      let mut inner = lock(&self.inner);
      if inner
        .pending
        .as_ref()
        .is_some_and(|current| current.state == pending.state)
      {
        // delete failureでも保存先にはconsumedが残るので、次の試行は安全に開始できる。
        inner.pending = None;
      }
      Ok(true)
    } else {
      Ok(false)
    }
  }

  /// 今の pending（期限内）。メモリに無ければ保存先から（アプリを閉じたままブラウザで進めた）。
  fn load_pending(&self, now: SystemTime) -> LoadedPending {
    if let Some(pending) = lock(&self.inner).pending.clone() {
      if pending.is_expired(now) {
        return LoadedPending::None;
      }
      return if pending.consumed {
        LoadedPending::Consumed(pending.state)
      } else {
        LoadedPending::Live(pending)
      };
    }
    match self.secrets.get(SecretKind::Pending) {
      Ok(Some(secret)) => match Pending::from_secret(&secret, self.env.client) {
        Some(pending) if pending.is_expired(now) => LoadedPending::None,
        Some(pending) if pending.consumed => LoadedPending::Consumed(pending.state),
        Some(pending) => LoadedPending::Live(pending),
        None => LoadedPending::None,
      },
      Ok(None) => LoadedPending::None,
      Err(error) => {
        self.log(
          "account.keychain.failed",
          json!({ "op": "get", "kind": "pending", "code": error.code }),
        );
        LoadedPending::None
      }
    }
  }

  /// 試行（deep link の処理）がまだ有効か: 「やめる」・ログアウト・期限切れ・別の試行で generation が進んでいない、かつ pending が同じ state。
  fn attempt_is_current(&self, generation: u64, state: &str) -> bool {
    let inner = lock(&self.inner);
    inner.generation == generation && inner.pending.as_ref().is_some_and(|pending| pending.state == state)
  }

  // ───────────────────────── 戻りの deep link ─────────────────────────

  /// `niho-<app>://auth?code=…&state=…` を処理する。`state` が合わない・2 回目・pending が無いときは Err（ログだけ）。
  pub async fn handle_callback(&self, url: &str) -> Result<Profile, AccountError> {
    let _flow = self.flow_lock.lock().await;
    let callback = pkce::parse_callback(self.env.client, url).inspect_err(|_| {
      self.log("account.callback.rejected", json!({ "reason": "invalid" }));
    })?;
    // 同じ state の 2 回目（「開く」の二度押し・成功のあとの古い deep link）は、pending の有無より先に捨てる
    if lock(&self.inner)
      .consumed_states
      .iter()
      .any(|state| *state == callback.state)
    {
      self.log("account.callback.rejected", json!({ "reason": "duplicate" }));
      return Err(AccountError::callback_duplicate());
    }
    let now = self.now();
    let pending_operation = lock(&self.pending_lock);
    let pending = match self.load_pending(now) {
      LoadedPending::Live(pending) => pending,
      LoadedPending::Consumed(state) => {
        // 交換の途中でアプリが終わっていた。同じコードを API に再提示しない
        remember_consumed(&mut lock(&self.inner), &state);
        drop(pending_operation);
        let _ = self.drop_pending(Some(&state));
        let duplicate = state == callback.state;
        self.log(
          "account.callback.rejected",
          json!({ "reason": if duplicate { "duplicate" } else { "no_pending" } }),
        );
        self.notify();
        return Err(if duplicate {
          AccountError::callback_duplicate()
        } else {
          AccountError::login_not_pending()
        });
      }
      LoadedPending::None => {
        self.log("account.callback.rejected", json!({ "reason": "no_pending" }));
        // このpending_lockを保持したまま掃除する。解除してから破棄すると、間で始まった新しいログインを消し得る。
        let _ = self.drop_pending_locked(None);
        self.notify();
        return Err(AccountError::login_not_pending());
      }
    };
    if pending.state != callback.state {
      self.log("account.callback.rejected", json!({ "reason": "state_mismatch" }));
      return Err(AccountError::callback_state_mismatch());
    }

    // 試行の開始: state を処理済みにし、pending を「消費開始済み」として保存先にも残す（交換の途中でアプリが終わっても、
    // 次の起動で同じコードを再提示しない）。この generation が進んだら（やめる・ログアウト・別の試行）結果は捨てる
    let mut consumed = pending.clone();
    consumed.consumed = true;
    let attempt_generation = {
      let mut inner = lock(&self.inner);
      remember_consumed(&mut inner, &callback.state);
      inner.pending = Some(consumed.clone());
      inner.generation
    };
    if let Err(error) = self.secrets.set(SecretKind::Pending, &consumed.to_secret()) {
      self.log(
        "account.keychain.failed",
        json!({ "op": "set", "kind": "pending", "code": &error.code }),
      );
      // 消費開始を保存先に残せないと、交換中の終了後に callback が再利用される。
      // 交換リクエストを送らず、pending の削除を試してから失敗を返す。
      let _ = self.drop_pending_locked(Some(&callback.state));
      drop(pending_operation);
      self.notify();
      return Err(error);
    }
    drop(pending_operation);

    let verifier = Secret::new(pending.verifier.clone());
    let exchange = match self
      .http
      .send(api::exchange_request(
        &self.env,
        &callback.code,
        &verifier,
        &self.device_name,
      ))
      .await
      .map_err(CallFailure::from)
      .and_then(|response| api::parse_exchange(&response))
    {
      Ok(exchange) => exchange,
      Err(failure) => {
        self.log("account.exchange.failed", failure.log_value());
        let _ = self.drop_pending(Some(&callback.state));
        let error = match &failure {
          CallFailure::Transport(_) => AccountError::network(),
          CallFailure::Malformed => AccountError::service_unavailable(),
          CallFailure::Api(api) => match api.status {
            400 if api.reason_is("code_expired") => AccountError::code_expired(),
            400 => AccountError::code_invalid(),
            401 => AccountError::session_revoked(),
            403 if api.code_is("ACCOUNT_DELETED") || api.reason_is("firebase_user_disabled") => {
              let _ = self.wipe_local("account_unavailable");
              AccountError::account_unavailable()
            }
            403 => AccountError::code_invalid(),
            404 if api.reason_is("app_connect_disabled") => AccountError::connect_disabled(),
            429 => AccountError::rate_limited(),
            _ => AccountError::service_unavailable(),
          },
        };
        self.notify();
        return Err(error);
      }
    };

    let sign_in = match self.sign_in(&exchange.custom_token).await {
      Ok(sign_in) => sign_in,
      Err(failure) => {
        // 接続は API 側に出来ている（ID token が無いので DELETE は出来ない）。手元には何も残さず、始めからやり直してもらう
        self.log(
          "account.exchange.sign_in_failed",
          json!({ "connectionId": exchange.connection_id, "failure": failure.log_value() }),
        );
        let _ = self.drop_pending(Some(&callback.state));
        self.notify();
        return Err(match failure {
          CallFailure::Transport(_) => AccountError::network(),
          CallFailure::Api(api) if api.status == 400 => AccountError::sign_in_failed(),
          _ => AccountError::service_unavailable(),
        });
      }
    };

    // await をまたいだ。「やめる」・ログアウト・別の試行が入っていたら、作った接続を解除して結果を捨てる（pending には触れない）
    if !self.attempt_is_current(attempt_generation, &callback.state) {
      self
        .roll_back(&exchange.connection_id, &sign_in.id_token, "cancelled")
        .await;
      self.log("account.callback.rejected", json!({ "reason": "cancelled" }));
      return Err(AccountError::callback_cancelled());
    }

    let now = self.now();
    let id_token = IdToken {
      token: sign_in.id_token.clone(),
      expires_at: now + sign_in.expires_in,
    };

    if let Err(error) = self.secrets.set(SecretKind::RefreshToken, &exchange.refresh_token) {
      self.log(
        "account.keychain.failed",
        json!({ "op": "set", "kind": "refreshToken", "code": error.code }),
      );
      self
        .roll_back(&exchange.connection_id, &sign_in.id_token, "keychain_write_failed")
        .await;
      let _ = self.drop_pending(Some(&callback.state));
      self.notify();
      return Err(AccountError::keychain_write_failed());
    }

    let stored = StoredAccount {
      version: 1,
      user_id: exchange.user.id.clone(),
      display_name: display_name_of(exchange.user.display_name.as_deref(), exchange.user.handle.as_deref()),
      handle: exchange.user.handle.clone(),
      connection_id: exchange.connection_id.clone(),
      avatar_file: None,
      expired: None,
    };
    // 保存と状態の切り替え（ログアウトの wipe と直列化。もう一度、試行が有効なことを確かめてから書く）
    let committed = {
      let _storage = lock(&self.storage_lock);
      if !self.attempt_is_current(attempt_generation, &callback.state) {
        Err(AccountError::callback_cancelled())
      } else {
        self.store.save(&stored).map(|()| {
          if let Err(error) = self.store.clear_avatar() {
            self.log(
              "account.avatar.skipped",
              json!({ "reason": error.code, "at": "account_changed" }),
            );
          }
          let mut inner = lock(&self.inner);
          inner.account = Account::Connected { stored: stored.clone() };
          inner.online = true;
          inner.id_token = Some(id_token);
          inner.unsaved_refresh_token = None;
          inner.backoff.reset();
          inner.pending = None;
          inner.generation = inner.generation.wrapping_add(1);
        })
      }
    };
    if let Err(error) = committed {
      self
        .roll_back(&exchange.connection_id, &sign_in.id_token, &error.code)
        .await;
      if error.is(crate::error::code::CALLBACK_CANCELLED) {
        self.log("account.callback.rejected", json!({ "reason": "cancelled" }));
      } else {
        let _ = self.drop_pending(Some(&callback.state));
        self.notify();
      }
      return Err(error);
    }
    if let Err(error) = self.secrets.delete(SecretKind::Pending) {
      self.log(
        "account.keychain.failed",
        json!({ "op": "delete", "kind": "pending", "code": error.code }),
      );
    }
    self.log(
      "account.exchange.succeeded",
      json!({ "connectionId": exchange.connection_id, "client": self.env.client.as_str() }),
    );
    self.notify();

    // 名前・@handle・顔写真を取り直す。失敗してもログインは成立（交換の返りの要約で出す）
    match self.refresh_profile().await {
      Ok(profile) => Ok(profile),
      Err(error) => {
        self.log(
          "account.profile.failed",
          json!({ "code": error.code, "at": "exchange" }),
        );
        Ok(self.store.profile(&stored))
      }
    }
  }

  /// 交換のあとに成立させられないとき（保存先に書けない・保存できない・やめた）の後片付け: 接続 refresh token を保存先から消す
  /// （書きかけが残らないように。失敗もログ）→ 作った接続を `DELETE`（best effort）。pending は呼び出し側が消す。
  async fn roll_back(&self, connection_id: &str, id_token: &Secret, reason: &str) {
    if let Err(error) = self.secrets.delete(SecretKind::RefreshToken) {
      self.log(
        "account.keychain.failed",
        json!({ "op": "delete", "kind": "refreshToken", "code": error.code }),
      );
    }
    let deleted = self
      .http
      .send(api::delete_connection_request(&self.env, id_token, connection_id))
      .await
      .map(|response| (200..300).contains(&response.status))
      .unwrap_or(false);
    self.log(
      "account.exchange.rolled_back",
      json!({ "connectionId": connection_id, "reason": reason, "deleted": deleted }),
    );
  }

  async fn sign_in(&self, custom_token: &Secret) -> Result<api::SignInResponse, CallFailure> {
    let response = self.http.send(api::sign_in_request(&self.env, custom_token)).await?;
    match api::parse_sign_in(&response) {
      Ok(sign_in) => Ok(sign_in),
      Err(failure) => {
        if response.status == 400 {
          // 設定の誤り（鍵と project の不一致など）。reason だけ残す
          self.log(
            "account.sign_in.rejected",
            json!({ "reason": api::identity_toolkit_reason(&response) }),
          );
        }
        Err(failure)
      }
    }
  }

  // ───────────────────────── ID token（更新・single-flight） ─────────────────────────

  /// ID token（メモリ）。期限の 5 分前から更新する（`refresh` → `signInWithCustomToken`）。同時に 2 本走らせない。
  /// 画面へは出さない（crate の中で API を呼ぶときに使う）。
  pub async fn id_token(&self) -> Result<Secret, AccountError> {
    let now = self.now();
    if let Some(token) = self.cached_token(now, true) {
      return Ok(token);
    }
    let _guard = self.refresh_lock.lock().await;
    let now = self.now();
    if let Some(token) = self.cached_token(now, true) {
      return Ok(token);
    }
    let (stored, generation, blocked) = {
      let inner = lock(&self.inner);
      let stored = match &inner.account {
        Account::Connected { stored } => stored.clone(),
        Account::Expired { .. } => return Err(AccountError::expired()),
        Account::SignedOut => return Err(AccountError::signed_out()),
      };
      (stored, inner.generation, inner.backoff.blocks(now))
    };
    if blocked {
      // 再試行の時刻まで待つ。期限内の token があればそれを使う
      return self.cached_token(now, false).ok_or_else(AccountError::offline);
    }
    let refresh_token = match self.read_refresh_token() {
      Ok(Some(token)) => token,
      Ok(None) => {
        self.log("account.refresh.failed", json!({ "reason": "refresh_token_missing" }));
        self.expire(ExpiredReason::ConnectionRevoked);
        return Err(AccountError::expired());
      }
      Err(error) => {
        self.log(
          "account.keychain.failed",
          json!({ "op": "get", "kind": "refreshToken", "code": error.code }),
        );
        self.mark_offline(now);
        return self.cached_token(now, false).ok_or_else(AccountError::offline);
      }
    };

    let refreshed = self
      .http
      .send(api::refresh_request(&self.env, &refresh_token))
      .await
      .map_err(CallFailure::from)
      .and_then(|response| api::parse_refresh(&response));
    let custom_token = match refreshed {
      Ok(refreshed) => {
        // 取り替えた接続 refresh token は signInWithCustomToken より前に保存する（spec D-15 改。サーバーはもう取り替え済み）。
        // 旧サーバー（返りに refreshToken が無い）は今の token を使い続ける
        if let Some(next) = &refreshed.refresh_token {
          if !self.keep_rotated_refresh_token(&stored.connection_id, generation, next) {
            // 更新の途中でログアウト・期限切れ・別のログインになった。結果は捨てる
            return Err(AccountError::signed_out());
          }
        }
        refreshed.custom_token
      }
      Err(failure) => {
        self.log("account.refresh.failed", failure.log_value());
        return Err(match classify_refresh_failure(&failure) {
          RefreshOutcome::Expired(reason) => {
            self.expire(reason);
            AccountError::expired()
          }
          RefreshOutcome::AccountGone => {
            let _ = self.wipe_local("account_unavailable");
            self.notify();
            AccountError::account_unavailable()
          }
          RefreshOutcome::Disabled => {
            lock(&self.inner).backoff.record_failure(now);
            // feature flag の停止中も期限内の ID token は使える。再試行は backoff に従う。
            match self.cached_token(now, false) {
              Some(token) => return Ok(token),
              None => AccountError::connect_disabled(),
            }
          }
          RefreshOutcome::Temporary => {
            self.mark_offline(now);
            // 期限内の token があればそのまま使える（更新は次の再試行で）
            match self.cached_token(now, false) {
              Some(token) => return Ok(token),
              None => AccountError::offline(),
            }
          }
        });
      }
    };

    match self.sign_in(&custom_token).await {
      Ok(sign_in) => {
        let now = self.now();
        let token = sign_in.id_token.clone();
        let mut inner = lock(&self.inner);
        if inner.generation != generation
          || !matches!(&inner.account, Account::Connected { stored: s } if s.connection_id == stored.connection_id)
        {
          // 更新の途中でログアウト・期限切れになった。結果は捨てる
          return Err(AccountError::signed_out());
        }
        let was_offline = !inner.online;
        inner.id_token = Some(IdToken {
          token: token.clone(),
          expires_at: now + sign_in.expires_in,
        });
        inner.online = true;
        inner.backoff.reset();
        drop(inner);
        self.log(
          "account.refresh.succeeded",
          json!({ "connectionId": stored.connection_id }),
        );
        if was_offline {
          self.notify();
        }
        Ok(token)
      }
      Err(failure) => {
        // signInWithCustomToken の 5xx・ネットワーク・400（設定の誤り）はどれも一時的として扱う
        self.log(
          "account.refresh.failed",
          json!({ "step": "signIn", "failure": failure.log_value() }),
        );
        self.mark_offline(now);
        self.cached_token(now, false).ok_or_else(AccountError::offline)
      }
    }
  }

  fn cached_token(&self, now: SystemTime, require_fresh: bool) -> Option<Secret> {
    let inner = lock(&self.inner);
    if !matches!(inner.account, Account::Connected { .. }) {
      return None;
    }
    let token = inner.id_token.as_ref()?;
    let ok = if require_fresh {
      fresh(token, now)
    } else {
      usable(token, now)
    };
    ok.then(|| token.token.clone())
  }

  /// 接続 refresh token（メモリに保存できなかった新しい token があればそれ、無ければ保存先）。
  fn read_refresh_token(&self) -> Result<Option<Secret>, AccountError> {
    if let Some(token) = lock(&self.inner).unsaved_refresh_token.clone() {
      return Ok(Some(token));
    }
    self.secrets.get(SecretKind::RefreshToken)
  }

  /// 取り替えた接続 refresh token を保存先へ原子的に書く（ログアウトの wipe と直列化）。書けなければメモリに持って続け、
  /// ログに reason を残す（秘密は出さない）。更新を始めたときの接続でなくなっていたら何もせず false。
  fn keep_rotated_refresh_token(&self, connection_id: &str, generation: u64, token: &Secret) -> bool {
    let _storage = lock(&self.storage_lock);
    {
      let inner = lock(&self.inner);
      let same_connection =
        matches!(&inner.account, Account::Connected { stored } if stored.connection_id == connection_id);
      if inner.generation != generation || !same_connection {
        drop(inner);
        self.log(
          "account.refresh.rotated_token_dropped",
          json!({ "reason": "account_changed" }),
        );
        return false;
      }
    }
    match self.secrets.set(SecretKind::RefreshToken, token) {
      Ok(()) => {
        lock(&self.inner).unsaved_refresh_token = None;
      }
      Err(error) => {
        lock(&self.inner).unsaved_refresh_token = Some(token.clone());
        self.log(
          "account.refresh.token_save_failed",
          json!({ "connectionId": connection_id, "reason": error.code }),
        );
      }
    }
    true
  }

  fn mark_offline(&self, now: SystemTime) {
    let changed = {
      let mut inner = lock(&self.inner);
      inner.backoff.record_failure(now);
      let changed = inner.online;
      inner.online = false;
      changed
    };
    if changed {
      self.notify();
    }
  }

  /// 「期限切れ」へ: 保存先の接続 refresh token を消し、プロフィールは残す。
  fn expire(&self, reason: ExpiredReason) {
    if let Err(error) = self.secrets.delete(SecretKind::RefreshToken) {
      self.log(
        "account.keychain.failed",
        json!({ "op": "delete", "kind": "refreshToken", "code": error.code }),
      );
    }
    let _storage = lock(&self.storage_lock);
    let mut inner = lock(&self.inner);
    let stored = match &inner.account {
      Account::Connected { stored } | Account::Expired { stored, .. } => stored.clone(),
      Account::SignedOut => return,
    };
    let mut expired = stored;
    expired.expired = Some(reason);
    let _ = self.store.save(&expired);
    inner.account = Account::Expired {
      stored: expired,
      reason,
    };
    inner.id_token = None;
    inner.unsaved_refresh_token = None;
    inner.backoff.reset();
    inner.generation = inner.generation.wrapping_add(1);
    drop(inner);
    self.log("account.expired", json!({ "reason": format!("{reason:?}") }));
    self.notify();
  }

  /// 全部消す（退会・無効化・ログアウト）。保存先の削除の失敗は返す（呼び出し側がログに残す）。
  fn wipe_local(&self, reason: &str) -> Result<(), AccountError> {
    let _storage = lock(&self.storage_lock);
    let mut result = Ok(());
    for kind in [SecretKind::RefreshToken, SecretKind::Pending] {
      if let Err(error) = self.secrets.delete(kind) {
        self.log(
          "account.keychain.failed",
          json!({ "op": "delete", "kind": kind.account(), "code": error.code }),
        );
        result = Err(error);
      }
    }
    if let Err(error) = self.store.clear() {
      self.log("account.storage.failed", json!({ "op": "clear", "code": error.code }));
      if result.is_ok() {
        result = Err(error);
      }
    }
    let mut inner = lock(&self.inner);
    inner.account = Account::SignedOut;
    inner.pending = None;
    inner.id_token = None;
    inner.unsaved_refresh_token = None;
    inner.online = true;
    inner.backoff.reset();
    inner.generation = inner.generation.wrapping_add(1);
    drop(inner);
    self.log("account.wiped", json!({ "reason": reason }));
    result
  }

  // ───────────────────────── プロフィール ─────────────────────────

  /// `/api/auth/me` で名前・@handle・顔写真を取り直す（顔写真は 512 KB までこの Mac に保存。画像の失敗は Err にしない）。
  /// 取り直しの途中でログアウト・期限切れ・別の接続になっていたら、何も書かずに Err。
  pub async fn refresh_profile(&self) -> Result<Profile, AccountError> {
    let token = self.id_token().await?;
    let (stored, generation) = {
      let inner = lock(&self.inner);
      match &inner.account {
        Account::Connected { stored } => (stored.clone(), inner.generation),
        Account::Expired { .. } => return Err(AccountError::expired()),
        Account::SignedOut => return Err(AccountError::signed_out()),
      }
    };
    let me = match self
      .http
      .send(api::me_request(&self.env, &token))
      .await
      .map_err(CallFailure::from)
      .and_then(|response| api::parse_me(&response))
    {
      Ok(me) => me,
      Err(failure) => {
        self.log("account.profile.failed", failure.log_value());
        return Err(match &failure {
          CallFailure::Api(api) if api.status == 401 && api.reason_is("app_connection_revoked") => {
            self.expire(ExpiredReason::ConnectionRevoked);
            AccountError::expired()
          }
          CallFailure::Api(api)
            if api.status == 403 && (api.code_is("ACCOUNT_DELETED") || api.reason_is("firebase_user_disabled")) =>
          {
            let _ = self.wipe_local("account_unavailable");
            self.notify();
            AccountError::account_unavailable()
          }
          _ => AccountError::profile_failed(),
        });
      }
    };
    if me.id != stored.user_id {
      // 別の人の token になっているはずは無い。念のため記録だけして名前は更新する
      self.log(
        "account.profile.user_mismatch",
        json!({ "connectionId": stored.connection_id }),
      );
    }
    let avatar = match &me.icon_url {
      Some(url) => self.fetch_avatar(url).await,
      None => None,
    };

    // 保存（ログアウトの wipe と直列化。await をまたいだので、まだ同じ接続でログイン済みかを確かめてから書く）
    let storage = lock(&self.storage_lock);
    {
      let inner = lock(&self.inner);
      let same_connection = matches!(&inner.account, Account::Connected { stored: current } if current.connection_id == stored.connection_id);
      if inner.generation != generation || !same_connection {
        drop(inner);
        drop(storage);
        self.log("account.profile.skipped", json!({ "reason": "account_changed" }));
        return Err(AccountError::signed_out());
      }
    }
    let mut updated = stored.clone();
    updated.display_name = display_name_of(me.display_name.as_deref(), me.handle.as_deref());
    updated.handle = me.handle.clone();
    match (&me.icon_url, avatar) {
      (Some(_), Some((content_type, bytes))) => match self.store.save_avatar(&content_type, &bytes) {
        Ok(Some(file)) => updated.avatar_file = Some(file),
        Ok(None) => self.log("account.avatar.skipped", json!({ "reason": "unsupported_or_empty" })),
        Err(error) => self.log("account.avatar.skipped", json!({ "reason": error.code })),
      },
      // 取得に失敗: 前の顔写真のまま
      (Some(_), None) => {}
      // 顔写真が無くなった
      (None, _) => {
        updated.avatar_file = None;
        if let Err(error) = self.store.clear_avatar() {
          self.log(
            "account.avatar.skipped",
            json!({ "reason": error.code, "at": "profile_missing" }),
          );
        }
      }
    }
    if updated != stored {
      self.store.save(&updated)?;
    }
    let profile = {
      let mut inner = lock(&self.inner);
      if let Account::Connected { stored: current } = &mut inner.account {
        *current = updated.clone();
      }
      self.store.profile(&updated)
    };
    drop(storage);
    self.log(
      "account.profile.updated",
      json!({ "avatar": updated.avatar_file.is_some() }),
    );
    if updated != stored {
      self.notify();
    }
    Ok(profile)
  }

  async fn fetch_avatar(&self, url: &str) -> Option<(String, Vec<u8>)> {
    match self.http.send(api::avatar_request(url, AVATAR_MAX_BYTES)).await {
      Ok(response) if (200..300).contains(&response.status) => {
        let content_type = response.header_value("content-type").unwrap_or("").to_string();
        Some((content_type, response.body))
      }
      Ok(response) => {
        self.log("account.avatar.skipped", json!({ "status": response.status }));
        None
      }
      Err(error) => {
        let reason = match error.kind {
          HttpErrorKind::TooLarge => "too_large",
          HttpErrorKind::Timeout => "timeout",
          HttpErrorKind::Network => "network",
          HttpErrorKind::Other => "other",
        };
        self.log("account.avatar.skipped", json!({ "reason": reason }));
        None
      }
    }
  }

  // ───────────────────────── ログアウト ─────────────────────────

  /// `DELETE /api/auth/app-connections/{自分}?reason=logout`（best effort。期限内の ID token があるときだけ）→ 保存先・
  /// プロフィール・顔写真を消す。ネットが無ければ手元だけ消す。
  pub async fn logout(&self) -> Result<(), AccountError> {
    let _flow = self.flow_lock.lock().await;
    let _refresh = self.refresh_lock.lock().await;
    let now = self.now();
    let target = {
      let inner = lock(&self.inner);
      match &inner.account {
        Account::Connected { stored } => inner
          .id_token
          .as_ref()
          .filter(|token| usable(token, now))
          .map(|token| (stored.connection_id.clone(), token.token.clone())),
        _ => None,
      }
    };
    let deleted = match target {
      Some((connection_id, token)) => {
        let ok = self
          .http
          .send(api::delete_connection_request(&self.env, &token, &connection_id))
          .await
          .map(|response| (200..300).contains(&response.status))
          .unwrap_or(false);
        Some(ok)
      }
      None => None,
    };
    let result = self.wipe_local("logout");
    self.log("account.logout", json!({ "deleted": deleted }));
    self.notify();
    result
  }

  /// 「ほかの端末でもログアウトする」（spec D-17・§失効）: 有効な ID token を得て（必要なら更新）`POST /api/auth/sign-out-everywhere`
  /// を呼び、204 か 401 `app_connection_revoked`（応答を受け取れずに再送した・すでに失効していた）なら手元を `logout` と同じく消す
  /// （この接続も API 側で失効済みなので DELETE は呼ばない）。ネットワーク・5xx・503・429 などの失敗は
  /// `sign_out_everywhere_failed` で、手元は変えない（この Mac はログイン済みのまま）。オフライン・期限切れ・未ログインでは呼ばない。
  pub async fn logout_everywhere(&self) -> Result<(), AccountError> {
    let _flow = self.flow_lock.lock().await;
    {
      let inner = lock(&self.inner);
      match &inner.account {
        Account::Connected { .. } if inner.online => {}
        Account::Connected { .. } => {
          drop(inner);
          self.log("account.logout_everywhere.failed", json!({ "reason": "offline" }));
          return Err(AccountError::sign_out_everywhere_failed());
        }
        Account::Expired { .. } => return Err(AccountError::expired()),
        Account::SignedOut => return Err(AccountError::signed_out()),
      }
    }
    let token = match self.id_token().await {
      Ok(token) => token,
      Err(error) => {
        self.log(
          "account.logout_everywhere.failed",
          json!({ "reason": "id_token", "code": error.code }),
        );
        // 更新で期限切れ・退会がわかったときはその失敗を返す（状態はもう変わっている）
        return Err(
          if error.is(crate::error::code::EXPIRED)
            || error.is(crate::error::code::SIGNED_OUT)
            || error.is(crate::error::code::ACCOUNT_UNAVAILABLE)
          {
            error
          } else {
            AccountError::sign_out_everywhere_failed()
          },
        );
      }
    };
    // 呼んでいる間に裏の更新（maintain）が走って、失効の前後の結果を書き戻さないようにする
    let _refresh = self.refresh_lock.lock().await;
    let response = self
      .http
      .send(api::sign_out_everywhere_request(&self.env, &token))
      .await;
    let outcome = match response {
      Ok(response) if (200..300).contains(&response.status) => Ok("revoked"),
      Ok(response) => {
        let failure = ApiFailure::from_response(&response);
        if failure.status == 401 && failure.reason_is("app_connection_revoked") {
          Ok("already_revoked")
        } else {
          Err(CallFailure::Api(failure))
        }
      }
      Err(error) => Err(CallFailure::from(error)),
    };
    match outcome {
      Ok(how) => {
        let result = self.wipe_local("logout_everywhere");
        self.log("account.logout_everywhere", json!({ "result": how }));
        self.notify();
        result
      }
      Err(failure) => {
        self.log("account.logout_everywhere.failed", failure.log_value());
        if let CallFailure::Api(api) = &failure {
          if api.status == 403 && (api.code_is("ACCOUNT_DELETED") || api.reason_is("firebase_user_disabled")) {
            let _ = self.wipe_local("account_unavailable");
            self.notify();
            return Err(AccountError::account_unavailable());
          }
        }
        Err(AccountError::sign_out_everywhere_failed())
      }
    }
  }

  // ───────────────────────── 定期の手入れ ─────────────────────────

  /// pending の期限切れを捨て、ID token を期限の 5 分前から更新する。次に呼ぶべき時刻を返す（無ければ None）。
  /// Tauri の層が裏で回す。
  pub async fn maintain(&self) -> Option<SystemTime> {
    let now = self.now();
    let pending_expired = {
      let inner = lock(&self.inner);
      inner.pending.as_ref().is_some_and(|pending| pending.is_expired(now))
    };
    if pending_expired {
      let _ = self.drop_pending(None);
      self.log("account.pending.expired", json!({ "at": "maintain" }));
      self.notify();
    }
    let needs_refresh = {
      let inner = lock(&self.inner);
      matches!(inner.account, Account::Connected { .. })
        && !inner.backoff.blocks(now)
        && !inner.id_token.as_ref().is_some_and(|token| fresh(token, now))
    };
    if needs_refresh {
      let _ = self.id_token().await;
    }
    let inner = lock(&self.inner);
    let mut due: Option<SystemTime> = None;
    let mut consider = |at: SystemTime| {
      due = Some(due.map_or(at, |current| current.min(at)));
    };
    if let Some(pending) = &inner.pending {
      consider(pending.expires_at());
    }
    if matches!(inner.account, Account::Connected { .. }) {
      if let Some(at) = inner.backoff.next_retry_at {
        consider(at);
      } else if let Some(token) = &inner.id_token {
        consider(token.expires_at.checked_sub(REFRESH_LEAD).unwrap_or(now));
      }
    }
    due
  }

  /// テスト・診断用: 次の再試行の時刻（バックオフ中なら Some）。
  pub fn next_retry_at(&self) -> Option<SystemTime> {
    lock(&self.inner).backoff.next_retry_at
  }
}

fn display_name_of(display_name: Option<&str>, handle: Option<&str>) -> String {
  display_name
    .map(str::trim)
    .filter(|name| !name.is_empty())
    .or(handle)
    .unwrap_or_default()
    .to_string()
}

#[cfg(test)]
#[path = "service_refresh_tests.rs"]
mod service_refresh_tests;
#[cfg(test)]
#[path = "service_tests.rs"]
mod service_tests;
