//! ログインの流れ（spec「流れ」「失敗の分岐」）: 偽の HttpClient とメモリの SecretStore で、state の照合・同じ state の
//! 2 回目・pending の期限・再起動後の継続・exchange の各エラー・Keychain 書込失敗時のロールバック・ログに秘密が出ないことを確かめる。

use super::*;
use crate::client::{ClientId, EnvKind};
use crate::http::{HttpError, HttpErrorKind, HttpRequest, HttpResponse};
use crate::pkce::code_challenge;
use crate::test_support::{
  api_error, bytes_response, json_response, CapturedLog, FakeClock, FakeHttp, MemorySecretStore,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, Mutex};

struct GatedPendingStore {
  inner: Arc<MemorySecretStore>,
  first_pending_set: Mutex<bool>,
  first_entered: SyncSender<()>,
  second_entered: SyncSender<()>,
  release_first: Mutex<Receiver<()>>,
}

impl crate::secret::AccountSecretStore for GatedPendingStore {
  fn get(&self, kind: SecretKind) -> Result<Option<crate::secret::Secret>, AccountError> {
    self.inner.get(kind)
  }

  fn set(&self, kind: SecretKind, secret: &crate::secret::Secret) -> Result<(), AccountError> {
    if kind == SecretKind::Pending {
      let is_first = {
        let mut first = self.first_pending_set.lock().unwrap();
        let is_first = !*first;
        *first = true;
        is_first
      };
      if is_first {
        let _ = self.first_entered.send(());
        self.release_first.lock().unwrap().recv().unwrap();
      } else {
        let _ = self.second_entered.send(());
      }
    }
    self.inner.set(kind, secret)
  }

  fn delete(&self, kind: SecretKind) -> Result<(), AccountError> {
    self.inner.delete(kind)
  }
}

#[test]
fn concurrent_begin_login_calls_cannot_overwrite_each_others_pending_state() {
  let dir = TempDir::new();
  let inner = Arc::new(MemorySecretStore::new());
  let (first_entered_tx, first_entered_rx) = mpsc::sync_channel(1);
  let (second_entered_tx, second_entered_rx) = mpsc::sync_channel(1);
  let (release_first_tx, release_first_rx) = mpsc::sync_channel(1);
  let secrets = Arc::new(GatedPendingStore {
    inner,
    first_pending_set: Mutex::new(false),
    first_entered: first_entered_tx,
    second_entered: second_entered_tx,
    release_first: Mutex::new(release_first_rx),
  });
  let service = Arc::new(AccountService::new(ServiceConfig::new(
    crate::client::Environment::new(ClientId::Camera, EnvKind::Prod, "web-api-key"),
    secrets,
    Arc::new(FakeHttp::new()),
    dir.0.join("data"),
    "Test Mac",
  )));

  let first_service = service.clone();
  let first = std::thread::spawn(move || first_service.begin_login());
  first_entered_rx.recv().unwrap();

  let second_service = service.clone();
  let second = std::thread::spawn(move || second_service.begin_login());
  assert!(
    second_entered_rx.recv_timeout(Duration::from_millis(100)).is_err(),
    "先のKeychain保存が終わるまで2本目はpendingを書かない"
  );
  release_first_tx.send(()).unwrap();

  assert!(first.join().unwrap().is_ok());
  assert_eq!(second.join().unwrap().unwrap_err().code, "busy");
}

pub(super) const CODE: &str = "Q0RFQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTI";
pub(super) const CUSTOM_TOKEN: &str = "custom-token-SECRET-aaaaaaaaaaaaaaaaaaaaaaaa";
pub(super) const REFRESH_TOKEN: &str = "refresh-token-SECRET-bbbbbbbbbbbbbbbbbbbbbb";
/// `refresh` が取り替えて返す新しい接続 refresh token（L6・D-15 改）
pub(super) const REFRESH_TOKEN_2: &str = "refresh-token-SECRET-2-ffffffffffffffffffff";
pub(super) const ID_TOKEN: &str = "id-token-SECRET-cccccccccccccccccccccccccccccc";
pub(super) const CUSTOM_TOKEN_2: &str = "custom-token-SECRET-2-dddddddddddddddddddddd";
pub(super) const ID_TOKEN_2: &str = "id-token-SECRET-2-eeeeeeeeeeeeeeeeeeeeeeeeeee";
pub(super) const AVATAR_URL: &str = "https://img.example/avatar.jpg?sig=1";

pub(super) type Reply = Result<HttpResponse, HttpError>;

/// 偽の API（経路ごとの返事と回数）。
#[derive(Clone)]
pub(super) struct Server {
  inner: Arc<Mutex<ServerState>>,
}

struct ServerState {
  replies: BTreeMap<&'static str, Reply>,
  counts: BTreeMap<&'static str, usize>,
}

pub(super) fn route(request: &HttpRequest) -> &'static str {
  let url = Url::parse(&request.url).expect("request url");
  let path = url.path();
  if path.ends_with("/app-connect/exchange") {
    "exchange"
  } else if path.ends_with("/app-connect/refresh") {
    "refresh"
  } else if path.contains("signInWithCustomToken") {
    "signIn"
  } else if path.ends_with("/auth/me") {
    "me"
  } else if path.contains("/auth/app-connections/") {
    "delete"
  } else if path.ends_with("/auth/sign-out-everywhere") {
    "signOutEverywhere"
  } else if url.host_str() == Some("img.example") {
    "avatar"
  } else {
    "other"
  }
}

pub(super) fn exchange_ok() -> Reply {
  Ok(json_response(
    200,
    &json!({
      "customToken": CUSTOM_TOKEN, "refreshToken": REFRESH_TOKEN, "connectionId": "conn_1",
      "connectionExpiresAt": "2027-04-14T00:00:00.000Z",
      "user": { "id": "user_1", "displayName": "たくや", "handle": "takuya", "iconImage": { "objectKey": "k", "signedUrl": AVATAR_URL, "expiresAt": "x" } }
    }),
  ))
}

pub(super) fn sign_in_ok(id_token: &str) -> Reply {
  Ok(json_response(
    200,
    &json!({ "idToken": id_token, "refreshToken": "firebase-refresh-token-SECRET", "expiresIn": "3600" }),
  ))
}

/// L6 のサーバー: 新しい custom token と、取り替えた接続 refresh token を返す。
pub(super) fn refresh_ok() -> Reply {
  Ok(json_response(
    200,
    &json!({ "customToken": CUSTOM_TOKEN_2, "expiresAt": "x", "refreshToken": REFRESH_TOKEN_2, "connectionExpiresAt": "y" }),
  ))
}

/// 旧サーバー（取り替えない）: 返りに refreshToken が無い。
pub(super) fn refresh_ok_legacy() -> Reply {
  Ok(json_response(
    200,
    &json!({ "customToken": CUSTOM_TOKEN_2, "expiresAt": "x", "connectionExpiresAt": "y" }),
  ))
}

pub(super) fn me_ok() -> Reply {
  Ok(json_response(
    200,
    &json!({
      "user": { "id": "user_1", "displayName": "たくや（更新）", "handle": "takuya" },
      "userIconImage": { "objectKey": "k", "signedUrl": AVATAR_URL, "expiresAt": "x", "thumb": { "signedUrl": AVATAR_URL } },
      "memberships": []
    }),
  ))
}

pub(super) fn avatar_ok() -> Reply {
  Ok(bytes_response(200, "image/jpeg", vec![0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]))
}

impl Server {
  pub(super) fn happy() -> Server {
    let mut replies = BTreeMap::new();
    replies.insert("exchange", exchange_ok());
    replies.insert("signIn", sign_in_ok(ID_TOKEN));
    replies.insert("refresh", refresh_ok());
    replies.insert("me", me_ok());
    replies.insert("avatar", avatar_ok());
    replies.insert(
      "delete",
      Ok(HttpResponse {
        status: 204,
        headers: vec![],
        body: vec![],
      }),
    );
    replies.insert(
      "signOutEverywhere",
      Ok(HttpResponse {
        status: 204,
        headers: vec![],
        body: vec![],
      }),
    );
    Server {
      inner: Arc::new(Mutex::new(ServerState {
        replies,
        counts: BTreeMap::new(),
      })),
    }
  }

  pub(super) fn install(&self, http: &FakeHttp) {
    let inner = self.inner.clone();
    http.respond(move |request| {
      let key = route(request);
      let mut state = inner.lock().unwrap();
      *state.counts.entry(key).or_default() += 1;
      state
        .replies
        .get(key)
        .cloned()
        .unwrap_or_else(|| Ok(json_response(404, &json!({ "error": { "code": "NOT_FOUND" } }))))
    });
  }

  pub(super) fn set(&self, key: &'static str, reply: Reply) {
    self.inner.lock().unwrap().replies.insert(key, reply);
  }

  pub(super) fn count(&self, key: &str) -> usize {
    self.inner.lock().unwrap().counts.get(key).copied().unwrap_or(0)
  }
}

static DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(super) struct TempDir(pub PathBuf);

impl TempDir {
  pub(super) fn new() -> TempDir {
    let dir = std::env::temp_dir().join(format!(
      "niho-desktop-account-test-{}-{}",
      std::process::id(),
      DIR_COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.0);
  }
}

pub(super) struct Harness {
  pub(super) dir: TempDir,
  pub(super) secrets: Arc<MemorySecretStore>,
  pub(super) http: Arc<FakeHttp>,
  pub(super) clock: Arc<FakeClock>,
  pub(super) log: Arc<CapturedLog>,
  pub(super) server: Server,
  pub(super) service: Arc<AccountService>,
  pub(super) states: Arc<Mutex<Vec<String>>>,
}

impl Harness {
  pub(super) fn new() -> Harness {
    let dir = TempDir::new();
    let secrets = Arc::new(MemorySecretStore::new());
    let http = Arc::new(FakeHttp::new());
    let clock = Arc::new(FakeClock::new());
    let log = CapturedLog::new();
    let server = Server::happy();
    server.install(&http);
    let service = Harness::service(&dir, &secrets, &http, &clock, &log);
    let states = Arc::new(Mutex::new(Vec::new()));
    let recorder = states.clone();
    service.subscribe(move |state| recorder.lock().unwrap().push(state.kind().to_string()));
    Harness {
      dir,
      secrets,
      http,
      clock,
      log,
      server,
      service,
      states,
    }
  }

  fn service(
    dir: &TempDir,
    secrets: &Arc<MemorySecretStore>,
    http: &Arc<FakeHttp>,
    clock: &Arc<FakeClock>,
    log: &Arc<CapturedLog>,
  ) -> Arc<AccountService> {
    let env = Environment::new(ClientId::Camera, EnvKind::Prod, "web-api-key");
    Arc::new(AccountService::new(
      ServiceConfig::new(
        env,
        secrets.clone(),
        http.clone(),
        dir.0.join("data"),
        "Taku の MacBook",
      )
      .clock(clock.clone())
      .log(log.log_fn()),
    ))
  }

  /// アプリの再起動（同じ Keychain・同じフォルダ・新しい service）。
  pub(super) fn restart(&self) -> Arc<AccountService> {
    let service = Harness::service(&self.dir, &self.secrets, &self.http, &self.clock, &self.log);
    service.restore();
    service
  }

  pub(super) fn callback_url(&self, begin: &BeginLogin, code: &str) -> String {
    let state = query(&begin.url, "state");
    format!("niho-camera://auth?code={code}&state={state}")
  }

  pub(super) fn request_body(&self, index: usize) -> Value {
    serde_json::from_slice(self.http.requests()[index].body.as_deref().unwrap()).unwrap()
  }

  pub(super) fn account_file(&self) -> PathBuf {
    self.dir.0.join("data").join("account.json")
  }

  /// ログイン済みまで進める。
  pub(super) async fn sign_in(&self) -> Profile {
    let begin = self.service.begin_login().unwrap();
    let profile = self
      .service
      .handle_callback(&self.callback_url(&begin, CODE))
      .await
      .unwrap();
    self.http.clear();
    profile
  }

  pub(super) fn assert_no_secret_in_logs(&self) {
    let text = self.log.text();
    for secret in [
      CODE,
      CUSTOM_TOKEN,
      REFRESH_TOKEN,
      REFRESH_TOKEN_2,
      ID_TOKEN,
      CUSTOM_TOKEN_2,
      ID_TOKEN_2,
      "firebase-refresh-token-SECRET",
    ] {
      assert!(!text.contains(secret), "ログに秘密が出ている: {secret}\n{text}");
    }
    if let Some(pending) = self.secrets.peek(SecretKind::Pending) {
      let pending: Pending = serde_json::from_str(pending.expose()).unwrap();
      assert!(!text.contains(&pending.verifier), "ログに verifier が出ている");
    }
    assert!(!text.contains("SECRET"), "{text}");
  }
}

#[tokio::test]
async fn session_ticket_survives_refresh_but_not_logout_or_same_user_relogin() {
  let h = Harness::new();
  h.sign_in().await;
  let ticket = h.service.session_ticket().unwrap();
  assert!(h.service.is_session_current(&ticket));

  h.clock.advance(Duration::from_secs(56 * 60));
  h.server.set("signIn", sign_in_ok(ID_TOKEN_2));
  assert_eq!(h.service.id_token_for(&ticket).await.unwrap().expose(), ID_TOKEN_2);
  assert!(
    h.service.is_session_current(&ticket),
    "token refresh は同じ login session"
  );

  h.service.logout().await.unwrap();
  assert!(!h.service.is_session_current(&ticket));
  let begin = h.service.begin_login().unwrap();
  let profile = h.service.handle_callback(&h.callback_url(&begin, CODE)).await.unwrap();
  assert_eq!(profile.user_id, ticket.user_id, "同じ UID で再ログイン");
  assert!(
    !h.service.is_session_current(&ticket),
    "同じ UID でも古い generation は無効"
  );
  assert!(h.service.is_session_current(&h.service.session_ticket().unwrap()));
}

#[tokio::test]
async fn session_flip_while_token_refresh_waits_never_returns_the_old_request_a_token() {
  let h = Harness::new();
  h.sign_in().await;
  h.clock.advance(Duration::from_secs(56 * 60));
  let ticket = h.service.session_ticket().unwrap();
  h.http.hold_path("app-connect/refresh");
  let service = h.service.clone();
  let task = tokio::spawn(async move { service.id_token_for(&ticket).await });
  while !h.http.paths().iter().any(|path| path.ends_with("/app-connect/refresh")) {
    tokio::task::yield_now().await;
  }
  h.service.expire(ExpiredReason::ConnectionRevoked);
  h.http.release();
  assert_eq!(task.await.unwrap().unwrap_err().code, "signed_out");
}

pub(super) fn query(url: &Url, key: &str) -> String {
  url
    .query_pairs()
    .find(|(k, _)| k == key)
    .map(|(_, v)| v.into_owned())
    .unwrap_or_else(|| panic!("{key} が無い: {url}"))
}

#[tokio::test]
async fn begin_login_puts_the_pending_in_the_keychain_and_returns_the_connect_url() {
  let h = Harness::new();
  assert_eq!(h.service.state(), AccountState::SignedOut);
  let begin = h.service.begin_login().unwrap();
  assert!(
    begin
      .url
      .as_str()
      .starts_with("https://niho.life/connect/niho-camera?v=1&challenge="),
    "{}",
    begin.url
  );
  let challenge = query(&begin.url, "challenge");
  let state = query(&begin.url, "state");
  let pending: Pending = serde_json::from_str(h.secrets.peek(SecretKind::Pending).unwrap().expose()).unwrap();
  assert_eq!(pending.state, state);
  assert_eq!(
    code_challenge(&pending.verifier),
    challenge,
    "challenge は verifier の S256"
  );
  assert_eq!(pending.client, ClientId::Camera);
  assert!(
    !begin.url.as_str().contains(&pending.verifier),
    "URL に verifier を入れない"
  );
  assert!(matches!(h.service.state(), AccountState::SigningIn { .. }));
  assert_eq!(begin.expires_at, pending.started_at() + Duration::from_secs(600));
  assert!(h.http.requests().is_empty(), "開始では通信しない");
  h.assert_no_secret_in_logs();
}

#[tokio::test]
async fn keychain_failure_on_begin_login_keeps_signed_out() {
  let h = Harness::new();
  h.secrets.fail_set(SecretKind::Pending, true);
  let error = h.service.begin_login().unwrap_err();
  assert_eq!(error.code, "keychain_write_failed");
  assert_eq!(h.service.state(), AccountState::SignedOut);
}

#[tokio::test]
async fn callback_exchanges_the_code_signs_in_and_saves_the_profile() {
  let h = Harness::new();
  let begin = h.service.begin_login().unwrap();
  let pending: Pending = serde_json::from_str(h.secrets.peek(SecretKind::Pending).unwrap().expose()).unwrap();

  let profile = h.service.handle_callback(&h.callback_url(&begin, CODE)).await.unwrap();

  // 1. exchange（clientId・code・codeVerifier・deviceName）
  assert_eq!(h.http.paths()[0], "POST /api/auth/app-connect/exchange");
  assert_eq!(
    h.request_body(0),
    json!({ "clientId": "niho-camera", "code": CODE, "codeVerifier": pending.verifier, "deviceName": "Taku の MacBook" })
  );
  // 2. signInWithCustomToken（JSON・Web API key）
  let sign_in = &h.http.requests()[1];
  assert_eq!(
    sign_in.url,
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=web-api-key"
  );
  assert_eq!(
    h.request_body(1),
    json!({ "token": CUSTOM_TOKEN, "returnSecureToken": true })
  );
  // 3. /api/auth/me（ID token）と顔写真
  assert_eq!(h.http.paths()[2], "GET /api/auth/me");
  assert_eq!(
    h.http.requests()[2].header_value("authorization"),
    Some(format!("Bearer {ID_TOKEN}").as_str())
  );
  assert_eq!(h.http.requests()[3].url, AVATAR_URL);
  assert_eq!(h.http.requests()[3].max_body_bytes, Some(512 * 1024));
  assert_eq!(h.http.requests().len(), 4);

  // 保存: 接続 refresh token は Keychain、pending は消える、プロフィールと顔写真はこの Mac
  assert_eq!(
    h.secrets.peek(SecretKind::RefreshToken).unwrap().expose(),
    REFRESH_TOKEN
  );
  assert_eq!(h.secrets.peek(SecretKind::Pending), None);
  let stored: StoredAccount = serde_json::from_str(&std::fs::read_to_string(h.account_file()).unwrap()).unwrap();
  assert_eq!(stored.user_id, "user_1");
  assert_eq!(stored.display_name, "たくや（更新）", "/me の名前で取り直す");
  assert_eq!(stored.handle.as_deref(), Some("takuya"));
  assert_eq!(stored.connection_id, "conn_1");
  assert_eq!(stored.avatar_file.as_deref(), Some("account-avatar.jpg"));
  assert_eq!(stored.expired, None);
  let account_json = std::fs::read_to_string(h.account_file()).unwrap();
  assert!(!account_json.contains("SECRET"), "account.json に token を置かない");
  assert_eq!(
    std::fs::read(h.dir.0.join("data/account-avatar.jpg")).unwrap(),
    vec![0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]
  );

  assert_eq!(profile.display_name, "たくや（更新）");
  assert_eq!(
    profile.avatar_path.as_deref(),
    Some(h.dir.0.join("data/account-avatar.jpg").as_path())
  );
  assert_eq!(
    h.service.state(),
    AccountState::SignedIn {
      profile: profile.clone()
    }
  );
  assert_eq!(
    h.service.id_token().await.unwrap().expose(),
    ID_TOKEN,
    "ID token はメモリ"
  );
  assert_eq!(h.http.requests().len(), 4, "期限内なら更新しない");

  let states = h.states.lock().unwrap().clone();
  assert_eq!(
    states,
    vec!["signedOut", "signingIn", "signedIn", "signedIn"],
    "subscribe は変化のたび"
  );
  assert!(h.log.has("account.exchange.succeeded"));
  h.assert_no_secret_in_logs();
}

#[tokio::test]
async fn switching_accounts_without_an_avatar_removes_the_previous_avatar_file() {
  let h = Harness::new();
  let old_profile = h.sign_in().await;
  let old_avatar = old_profile.avatar_path.unwrap();
  assert!(old_avatar.exists());

  h.service.expire(ExpiredReason::ConnectionRevoked);
  h.server.set(
    "exchange",
    Ok(json_response(
      200,
      &json!({
        "customToken": CUSTOM_TOKEN_2,
        "refreshToken": "refresh-token-SECRET-new",
        "connectionId": "conn_2",
        "connectionExpiresAt": "2027-04-14T00:00:00.000Z",
        "user": { "id": "user_2", "displayName": "新しい利用者", "handle": "new-user" }
      }),
    )),
  );
  h.server.set(
    "me",
    Ok(json_response(
      200,
      &json!({ "user": { "id": "user_2", "displayName": "新しい利用者", "handle": "new-user" }, "memberships": [] }),
    )),
  );

  let begin = h.service.begin_login().unwrap();
  let profile = h.service.handle_callback(&h.callback_url(&begin, CODE)).await.unwrap();

  assert_eq!(profile.user_id, "user_2");
  assert_eq!(profile.avatar_path, None);
  assert!(!old_avatar.exists(), "切替前アカウントの画像を残さない");
  let stored: StoredAccount = serde_json::from_str(&std::fs::read_to_string(h.account_file()).unwrap()).unwrap();
  assert_eq!(stored.avatar_file, None);
}

#[tokio::test]
async fn login_succeeds_without_profile_and_avatar_when_me_fails() {
  let h = Harness::new();
  h.server.set("me", Err(HttpError::new(HttpErrorKind::Network)));
  let begin = h.service.begin_login().unwrap();
  let profile = h.service.handle_callback(&h.callback_url(&begin, CODE)).await.unwrap();
  assert_eq!(profile.display_name, "たくや", "交換の返りの要約で出す");
  assert_eq!(profile.avatar_path, None);
  assert!(matches!(h.service.state(), AccountState::SignedIn { .. }));
  assert!(h.log.has("account.profile.failed"));

  // 顔写真だけ失敗（大きすぎる）でもログインは成立
  let h = Harness::new();
  h.server.set("avatar", Err(HttpError::new(HttpErrorKind::TooLarge)));
  let begin = h.service.begin_login().unwrap();
  let profile = h.service.handle_callback(&h.callback_url(&begin, CODE)).await.unwrap();
  assert_eq!(profile.display_name, "たくや（更新）");
  assert_eq!(profile.avatar_path, None);
  assert_eq!(
    h.log.payloads("account.avatar.skipped"),
    vec![json!({ "reason": "too_large" })]
  );

  // 知らない形式は書かない
  let h = Harness::new();
  h.server
    .set("avatar", Ok(bytes_response(200, "image/svg+xml", b"<svg/>".to_vec())));
  let begin = h.service.begin_login().unwrap();
  let profile = h.service.handle_callback(&h.callback_url(&begin, CODE)).await.unwrap();
  assert_eq!(profile.avatar_path, None);
}

#[tokio::test]
async fn callback_with_another_state_is_dropped_and_the_pending_stays() {
  let h = Harness::new();
  let _begin = h.service.begin_login().unwrap();
  let other = "b3RoZXItc3RhdGUtb3RoZXItc3RhdGUtb3RoZXItc3Q";
  let error = h
    .service
    .handle_callback(&format!("niho-camera://auth?code={CODE}&state={other}"))
    .await
    .unwrap_err();
  assert_eq!(error.code, "callback_state_mismatch");
  assert!(h.http.requests().is_empty(), "通信しない");
  assert!(h.secrets.peek(SecretKind::Pending).is_some(), "pending はそのまま待つ");
  assert!(matches!(h.service.state(), AccountState::SigningIn { .. }));
  assert_eq!(
    h.log.payloads("account.callback.rejected"),
    vec![json!({ "reason": "state_mismatch" })]
  );
}

#[tokio::test]
async fn the_second_callback_with_the_same_state_is_dropped() {
  let h = Harness::new();
  let begin = h.service.begin_login().unwrap();
  let url = h.callback_url(&begin, CODE);
  h.service.handle_callback(&url).await.unwrap();
  let before = h.http.requests().len();
  let error = h.service.handle_callback(&url).await.unwrap_err();
  assert_eq!(error.code, "callback_duplicate");
  assert_eq!(
    h.http.requests().len(),
    before,
    "2 回目は API に出さない（再利用と見なされて失効しないため）"
  );
  assert!(matches!(h.service.state(), AccountState::SignedIn { .. }));

  // 同時に 2 本来ても交換は 1 回
  let h = Harness::new();
  let begin = h.service.begin_login().unwrap();
  let url = h.callback_url(&begin, CODE);
  let (a, b) = tokio::join!(h.service.handle_callback(&url), h.service.handle_callback(&url));
  assert!(a.is_ok() != b.is_ok(), "片方だけ成立");
  assert_eq!(h.server.count("exchange"), 1);
}

#[tokio::test]
async fn callback_without_pending_or_after_ten_minutes_is_dropped() {
  let h = Harness::new();
  let error = h
    .service
    .handle_callback(&format!(
      "niho-camera://auth?code={CODE}&state=c3RhdGUtc3RhdGUtc3RhdGUtc3RhdGUtc3RhdGUtc3Q"
    ))
    .await
    .unwrap_err();
  assert_eq!(error.code, "login_not_pending");
  assert_eq!(
    h.log.payloads("account.callback.rejected"),
    vec![json!({ "reason": "no_pending" })]
  );

  // 10 分で pending は捨てる（maintain で消え、deep link も捨てる）
  let begin = h.service.begin_login().unwrap();
  let due = h.service.maintain().await;
  assert_eq!(due, Some(begin.expires_at), "次の手入れは pending の期限");
  h.clock.advance(Duration::from_secs(9 * 60 + 59));
  assert!(matches!(h.service.state(), AccountState::SigningIn { .. }));
  h.clock.advance(Duration::from_secs(1));
  assert_eq!(
    h.service.state(),
    AccountState::SignedOut,
    "期限が来たら未ログインに戻る"
  );
  let error = h
    .service
    .handle_callback(&h.callback_url(&begin, CODE))
    .await
    .unwrap_err();
  assert_eq!(error.code, "login_not_pending");
  assert_eq!(h.secrets.peek(SecretKind::Pending), None);
  h.service.maintain().await;
  assert!(h.http.requests().is_empty());

  // 「やめる」のあとも同じ
  let begin = h.service.begin_login().unwrap();
  h.service.cancel_login().unwrap();
  assert_eq!(h.service.state(), AccountState::SignedOut);
  assert_eq!(h.secrets.peek(SecretKind::Pending), None);
  let error = h
    .service
    .handle_callback(&h.callback_url(&begin, CODE))
    .await
    .unwrap_err();
  assert_eq!(error.code, "login_not_pending");

  // 形が違う deep link
  let error = h
    .service
    .handle_callback("niho-camera://auth?code=x")
    .await
    .unwrap_err();
  assert_eq!(error.code, "callback_invalid");
}

#[tokio::test]
async fn the_pending_survives_a_restart_and_the_login_continues() {
  let h = Harness::new();
  let begin = h.service.begin_login().unwrap();
  // アプリを閉じたままブラウザで進めた → deep link で起動
  let restarted = h.restart();
  assert!(
    matches!(restarted.state(), AccountState::SigningIn { .. }),
    "再起動後も「ブラウザで続けています…」"
  );
  let profile = restarted.handle_callback(&h.callback_url(&begin, CODE)).await.unwrap();
  assert_eq!(profile.connection_id, "conn_1");
  assert!(matches!(restarted.state(), AccountState::SignedIn { .. }));
  assert_eq!(h.secrets.peek(SecretKind::Pending), None);
  h.assert_no_secret_in_logs();

  // 再起動後に pending が期限切れなら捨てる
  let h = Harness::new();
  h.service.begin_login().unwrap();
  h.clock.advance(Duration::from_secs(11 * 60));
  let restarted = h.restart();
  assert_eq!(restarted.state(), AccountState::SignedOut);
  assert_eq!(h.secrets.peek(SecretKind::Pending), None);
}

#[tokio::test]
async fn exchange_errors_map_to_the_spec_table_and_drop_the_pending() {
  let cases: Vec<(&str, Reply, &str)> = vec![
    (
      "code_expired",
      Ok(api_error(400, "BAD_REQUEST", Some("code_expired"))),
      "code_expired",
    ),
    (
      "code_invalid",
      Ok(api_error(400, "BAD_REQUEST", Some("code_invalid"))),
      "code_invalid",
    ),
    (
      "validation",
      Ok(api_error(400, "VALIDATION_ERROR", Some("unknown_client"))),
      "code_invalid",
    ),
    (
      "session_revoked",
      Ok(api_error(401, "UNAUTHORIZED", Some("session_revoked"))),
      "session_revoked",
    ),
    (
      "deleted",
      Ok(api_error(403, "ACCOUNT_DELETED", None)),
      "account_unavailable",
    ),
    (
      "disabled user",
      Ok(api_error(403, "FORBIDDEN", Some("firebase_user_disabled"))),
      "account_unavailable",
    ),
    (
      "flag off",
      Ok(api_error(404, "NOT_FOUND", Some("app_connect_disabled"))),
      "connect_disabled",
    ),
    (
      "rate limited",
      Ok(api_error(429, "RATE_LIMITED", Some("rate_limited"))),
      "rate_limited",
    ),
    (
      "503",
      Ok(api_error(
        503,
        "SERVICE_UNAVAILABLE",
        Some("firebase_user_lookup_failed"),
      )),
      "service_unavailable",
    ),
    ("500", Ok(api_error(500, "INTERNAL", None)), "service_unavailable"),
    ("network", Err(HttpError::new(HttpErrorKind::Network)), "network"),
    ("timeout", Err(HttpError::new(HttpErrorKind::Timeout)), "network"),
    (
      "malformed",
      Ok(json_response(200, &json!({ "unexpected": true }))),
      "service_unavailable",
    ),
  ];
  for (name, reply, expected) in cases {
    let h = Harness::new();
    h.server.set("exchange", reply);
    let begin = h.service.begin_login().unwrap();
    let error = h
      .service
      .handle_callback(&h.callback_url(&begin, CODE))
      .await
      .unwrap_err();
    assert_eq!(error.code, expected, "{name}");
    assert_eq!(h.service.state(), AccountState::SignedOut, "{name}: pending を捨てる");
    assert_eq!(h.secrets.peek(SecretKind::Pending), None, "{name}");
    assert_eq!(h.secrets.peek(SecretKind::RefreshToken), None, "{name}");
    assert!(!h.account_file().exists(), "{name}");
    assert_eq!(h.server.count("signIn"), 0, "{name}: 交換に失敗したら signIn しない");
    assert!(h.log.has("account.exchange.failed"), "{name}");
    h.assert_no_secret_in_logs();
  }
}

#[tokio::test]
async fn sign_in_failure_after_exchange_does_not_establish_the_login() {
  for (reply, expected) in [
    (Err(HttpError::new(HttpErrorKind::Network)), "network"),
    (
      Ok(json_response(
        400,
        &json!({ "error": { "code": 400, "message": "INVALID_CUSTOM_TOKEN" } }),
      )),
      "sign_in_failed",
    ),
    (Ok(api_error(503, "x", None)), "service_unavailable"),
  ] {
    let h = Harness::new();
    h.server.set("signIn", reply);
    let begin = h.service.begin_login().unwrap();
    let error = h
      .service
      .handle_callback(&h.callback_url(&begin, CODE))
      .await
      .unwrap_err();
    assert_eq!(error.code, expected);
    assert_eq!(h.service.state(), AccountState::SignedOut);
    assert_eq!(
      h.secrets.peek(SecretKind::RefreshToken),
      None,
      "接続 refresh token を残さない"
    );
    assert!(!h.account_file().exists());
    let failed = h.log.payloads("account.exchange.sign_in_failed");
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0]["connectionId"], "conn_1");
    h.assert_no_secret_in_logs();
  }
  // 400 の理由はログに残る
  let h = Harness::new();
  h.server.set(
    "signIn",
    Ok(json_response(
      400,
      &json!({ "error": { "code": 400, "message": "CREDENTIAL_MISMATCH" } }),
    )),
  );
  let begin = h.service.begin_login().unwrap();
  let _ = h.service.handle_callback(&h.callback_url(&begin, CODE)).await;
  assert_eq!(
    h.log.payloads("account.sign_in.rejected"),
    vec![json!({ "reason": "CREDENTIAL_MISMATCH" })]
  );
}

#[tokio::test]
async fn keychain_write_failure_rolls_the_connection_back() {
  let h = Harness::new();
  h.secrets.fail_set(SecretKind::RefreshToken, true);
  let begin = h.service.begin_login().unwrap();
  let error = h
    .service
    .handle_callback(&h.callback_url(&begin, CODE))
    .await
    .unwrap_err();
  assert_eq!(error.code, "keychain_write_failed");
  assert_eq!(
    error.message,
    "この Mac に保存できませんでした。もう一度お試しください。"
  );
  // 接続を DELETE（best effort。ID token で）
  let paths = h.http.paths();
  assert_eq!(
    paths,
    vec![
      "POST /api/auth/app-connect/exchange",
      "POST /v1/accounts:signInWithCustomToken",
      "DELETE /api/auth/app-connections/conn_1"
    ]
  );
  let delete = &h.http.requests()[2];
  assert_eq!(
    delete.header_value("authorization"),
    Some(format!("Bearer {ID_TOKEN}").as_str())
  );
  assert!(delete.url.ends_with("?reason=logout"));
  assert_eq!(h.service.state(), AccountState::SignedOut);
  assert_eq!(h.secrets.peek(SecretKind::Pending), None);
  assert!(!h.account_file().exists());
  assert_eq!(
    h.log.payloads("account.exchange.rolled_back"),
    vec![json!({ "connectionId": "conn_1", "reason": "keychain_write_failed", "deleted": true })]
  );
  h.assert_no_secret_in_logs();

  // DELETE まで失敗しても（ネット断）結果は同じで、deleted: false が残る
  let h = Harness::new();
  h.secrets.fail_set(SecretKind::RefreshToken, true);
  h.server.set("delete", Err(HttpError::new(HttpErrorKind::Network)));
  let begin = h.service.begin_login().unwrap();
  let error = h
    .service
    .handle_callback(&h.callback_url(&begin, CODE))
    .await
    .unwrap_err();
  assert_eq!(error.code, "keychain_write_failed");
  assert_eq!(h.log.payloads("account.exchange.rolled_back")[0]["deleted"], false);
}

#[tokio::test]
async fn storage_failure_rolls_back_and_removes_the_refresh_token() {
  let h = Harness::new();
  // data_dir の場所にファイルを置いて書けなくする
  std::fs::write(h.dir.0.join("data"), b"not a dir").unwrap();
  let begin = h.service.begin_login().unwrap();
  let error = h
    .service
    .handle_callback(&h.callback_url(&begin, CODE))
    .await
    .unwrap_err();
  assert_eq!(error.code, "storage_failed");
  assert_eq!(h.secrets.peek(SecretKind::RefreshToken), None);
  assert_eq!(h.http.paths()[2], "DELETE /api/auth/app-connections/conn_1");
  assert_eq!(h.service.state(), AccountState::SignedOut);
}

#[tokio::test]
async fn begin_login_is_refused_while_signed_in_but_allowed_when_expired() {
  let h = Harness::new();
  h.sign_in().await;
  assert_eq!(h.service.begin_login().unwrap_err().code, "busy");

  // 期限切れ → もう一度ログイン → 新しい接続で上書き
  h.server.set(
    "refresh",
    Ok(api_error(401, "UNAUTHORIZED", Some("app_connection_revoked"))),
  );
  h.clock.advance(Duration::from_secs(56 * 60));
  assert_eq!(h.service.id_token().await.unwrap_err().code, "expired");
  assert!(matches!(h.service.state(), AccountState::Expired { .. }));
  h.server.set("refresh", refresh_ok());
  let begin = h.service.begin_login().unwrap();
  assert!(matches!(h.service.state(), AccountState::SigningIn { .. }));
  // 「やめる」で期限切れ（名前つき）に戻る
  h.service.cancel_login().unwrap();
  assert!(matches!(h.service.state(), AccountState::Expired { .. }));
  let begin2 = h.service.begin_login().unwrap();
  assert_ne!(query(&begin.url, "state"), query(&begin2.url, "state"));
  let profile = h.service.handle_callback(&h.callback_url(&begin2, CODE)).await.unwrap();
  assert_eq!(h.service.state(), AccountState::SignedIn { profile });
  assert_eq!(
    h.secrets.peek(SecretKind::RefreshToken).unwrap().expose(),
    REFRESH_TOKEN
  );
}

#[tokio::test]
async fn errors_and_states_never_carry_secrets() {
  let h = Harness::new();
  let profile = h.sign_in().await;
  let state_json = serde_json::to_string(&h.service.state()).unwrap();
  assert!(!state_json.contains("SECRET"), "{state_json}");
  assert!(state_json.contains("\"kind\":\"signedIn\""));
  assert!(state_json.contains("\"connectionId\":\"conn_1\""));
  assert_eq!(profile.user_id, "user_1");
  let error = AccountError::keychain_write_failed();
  assert!(!serde_json::to_string(&error).unwrap().contains("SECRET"));
  h.assert_no_secret_in_logs();
}

// ───────────────────────── codex-review（実装後）の P1 への追加 ─────────────────────────

#[tokio::test]
async fn cancelling_during_the_exchange_discards_the_result_and_revokes_the_connection() {
  let h = Harness::new();
  let begin = h.service.begin_login().unwrap();
  let url = h.callback_url(&begin, CODE);
  h.http.hold();
  let service = h.service.clone();
  let task = tokio::spawn(async move { service.handle_callback(&url).await });
  tokio::task::yield_now().await;
  assert_eq!(
    h.http.paths(),
    vec!["POST /api/auth/app-connect/exchange"],
    "交換を待っている"
  );

  // 待っている間に「やめる」
  h.service.cancel_login().unwrap();
  assert_eq!(h.service.state(), AccountState::SignedOut);
  h.http.release();
  let result = task.await.unwrap();
  assert_eq!(result.unwrap_err().code, "callback_cancelled");

  // 結果は捨て、作った接続は解除し、手元には何も残さない
  assert_eq!(h.service.state(), AccountState::SignedOut);
  assert_eq!(h.secrets.peek(SecretKind::RefreshToken), None);
  assert_eq!(h.secrets.peek(SecretKind::Pending), None);
  assert!(!h.account_file().exists());
  assert_eq!(
    h.http.paths().last().unwrap(),
    "DELETE /api/auth/app-connections/conn_1"
  );
  assert_eq!(
    h.log.payloads("account.exchange.rolled_back"),
    vec![json!({ "connectionId": "conn_1", "reason": "cancelled", "deleted": true })]
  );
  h.assert_no_secret_in_logs();
}

#[tokio::test]
async fn a_new_login_started_after_cancelling_is_not_disturbed_by_the_old_callback() {
  let h = Harness::new();
  let begin_a = h.service.begin_login().unwrap();
  let url_a = h.callback_url(&begin_a, CODE);
  h.http.hold();
  let service = h.service.clone();
  let task = tokio::spawn(async move { service.handle_callback(&url_a).await });
  tokio::task::yield_now().await;
  h.service.cancel_login().unwrap();
  // 新しい試行 B（有効な pending が無いので始められる）
  let begin_b = h.service.begin_login().unwrap();
  assert_ne!(query(&begin_a.url, "state"), query(&begin_b.url, "state"));
  h.http.release();
  assert_eq!(task.await.unwrap().unwrap_err().code, "callback_cancelled");
  // A の後片付けが B の pending を消していない
  assert!(matches!(h.service.state(), AccountState::SigningIn { .. }));
  let kept: Pending = serde_json::from_str(h.secrets.peek(SecretKind::Pending).unwrap().expose()).unwrap();
  assert_eq!(kept.state, query(&begin_b.url, "state"));
  // B は普通に成立する
  let profile = h
    .service
    .handle_callback(&h.callback_url(&begin_b, CODE))
    .await
    .unwrap();
  assert_eq!(h.service.state(), AccountState::SignedIn { profile });
}

#[tokio::test]
async fn begin_login_is_busy_while_a_pending_is_alive() {
  let h = Harness::new();
  let begin = h.service.begin_login().unwrap();
  assert_eq!(
    h.service.begin_login().unwrap_err().code,
    "busy",
    "先に開いたブラウザの戻りを無効にしない"
  );
  // 「やめる」のあとは始められる。期限が切れても始められる
  h.service.cancel_login().unwrap();
  let again = h.service.begin_login().unwrap();
  assert_ne!(query(&begin.url, "state"), query(&again.url, "state"));
  h.clock.advance(Duration::from_secs(10 * 60));
  assert!(h.service.begin_login().is_ok());
}

#[tokio::test]
async fn failed_pending_delete_keeps_the_cancelled_callback_consumed_after_restart() {
  let h = Harness::new();
  let begin = h.service.begin_login().unwrap();
  let url = h.callback_url(&begin, CODE);
  h.secrets.fail_delete(SecretKind::Pending, true);

  h.service.cancel_login().unwrap();

  let pending: Pending = serde_json::from_str(h.secrets.peek(SecretKind::Pending).unwrap().expose()).unwrap();
  assert!(pending.consumed, "削除失敗時にも永続pendingをconsumedにする");
  assert_eq!(
    h.service.handle_callback(&url).await.unwrap_err().code,
    "callback_duplicate"
  );
  assert!(h.http.requests().is_empty(), "キャンセル済みcallbackをAPIへ送らない");

  let restarted = h.restart();
  assert_eq!(
    restarted.handle_callback(&url).await.unwrap_err().code,
    "callback_duplicate"
  );
  assert!(h.http.requests().is_empty(), "再起動後もcallbackをAPIへ送らない");
}

#[tokio::test]
async fn failed_to_persist_callback_consumption_does_not_send_the_exchange_request() {
  let h = Harness::new();
  let begin = h.service.begin_login().unwrap();
  let url = h.callback_url(&begin, CODE);
  h.secrets.fail_set(SecretKind::Pending, true);

  let error = h.service.handle_callback(&url).await.unwrap_err();

  assert_eq!(error.code, "keychain_write_failed");
  assert!(
    h.http.requests().is_empty(),
    "消費開始を保存できないcallbackをAPIへ送らない"
  );
  assert_eq!(
    h.secrets.peek(SecretKind::Pending),
    None,
    "失敗時はKeychain削除へフォールバックする"
  );
  assert_eq!(
    h.service.handle_callback(&url).await.unwrap_err().code,
    "callback_duplicate"
  );
  assert!(h.http.requests().is_empty());
}

#[tokio::test]
async fn cancel_login_reports_failure_when_consumed_write_and_delete_both_fail() {
  let h = Harness::new();
  let begin = h.service.begin_login().unwrap();
  let url = h.callback_url(&begin, CODE);
  h.secrets.fail_set(SecretKind::Pending, true);
  h.secrets.fail_delete(SecretKind::Pending, true);

  let error = h.service.cancel_login().unwrap_err();

  assert_eq!(error.code, "keychain_write_failed");
  assert!(matches!(h.service.state(), AccountState::SigningIn { .. }));
  assert_eq!(
    h.service.handle_callback(&url).await.unwrap_err().code,
    "callback_duplicate",
    "Keychainの両操作が失敗しても現在のプロセスではcallbackを拒否する"
  );
  assert!(h.http.requests().is_empty());
  let stored: Pending = serde_json::from_str(h.secrets.peek(SecretKind::Pending).unwrap().expose()).unwrap();
  assert!(!stored.consumed, "Keychain書込失敗時に古いlive pendingを偽装しない");
}

#[tokio::test]
async fn a_consumed_pending_is_not_re_presented_after_a_restart() {
  let h = Harness::new();
  let begin = h.service.begin_login().unwrap();
  let url = h.callback_url(&begin, CODE);
  h.http.hold();
  let service = h.service.clone();
  let task = tokio::spawn({
    let url = url.clone();
    async move { service.handle_callback(&url).await }
  });
  tokio::task::yield_now().await;
  // 交換を始めた印が Keychain にある（verifier はそのまま、consumed: true）
  let pending: Pending = serde_json::from_str(h.secrets.peek(SecretKind::Pending).unwrap().expose()).unwrap();
  assert!(pending.consumed);

  // ここでアプリが終わったとする → 再起動。pending は捨て、同じ deep link が来ても API に出さない
  let restarted = h.restart();
  assert_eq!(restarted.state(), AccountState::SignedOut);
  assert_eq!(h.secrets.peek(SecretKind::Pending), None);
  assert!(h.log.has("account.pending.consumed_dropped"));
  let before = h.http.paths().len();
  assert_eq!(
    restarted.handle_callback(&url).await.unwrap_err().code,
    "callback_duplicate"
  );
  assert_eq!(h.http.paths().len(), before, "同じコードを再提示しない");

  h.http.release();
  let _ = task.await.unwrap();
}

#[tokio::test]
async fn rollback_order_is_refresh_token_then_connection_then_pending() {
  let h = Harness::new();
  h.secrets.fail_set(SecretKind::RefreshToken, true);
  let begin = h.service.begin_login().unwrap();
  let error = h
    .service
    .handle_callback(&h.callback_url(&begin, CODE))
    .await
    .unwrap_err();
  assert_eq!(error.code, "keychain_write_failed");
  let ops = h.secrets.ops();
  let set_at = ops.iter().rposition(|op| op == "set:refresh-token").unwrap();
  let delete_token_at = ops.iter().rposition(|op| op == "delete:refresh-token").unwrap();
  let delete_pending_at = ops.iter().rposition(|op| op == "delete:pending").unwrap();
  assert!(
    set_at < delete_token_at && delete_token_at < delete_pending_at,
    "{ops:?}"
  );
  assert_eq!(
    h.http.paths().last().unwrap(),
    "DELETE /api/auth/app-connections/conn_1"
  );
}

#[test]
fn debug_output_of_public_types_is_redacted() {
  let pending = Pending {
    verifier: "verifier-SECRET-0123456789012345678901234567890".into(),
    state: "state-value".into(),
    client: ClientId::Camera,
    started_at_ms: 1,
    consumed: false,
  };
  let text = format!("{pending:?}");
  assert!(!text.contains("SECRET"), "{text}");
  assert!(text.contains("state-value") && text.contains("[REDACTED]"));

  let callback = crate::pkce::Callback {
    code: "code-SECRET".into(),
    state: "s".into(),
  };
  assert!(!format!("{callback:?}").contains("SECRET"));

  let request = api::sign_in_request(
    &Environment::new(ClientId::Camera, EnvKind::Prod, "api-key-SECRET"),
    &Secret::new("ct-SECRET"),
  )
  .bearer("id-SECRET");
  let text = format!("{request:?}");
  assert!(!text.contains("SECRET"), "{text}");
  assert!(text.contains("authorization") && text.contains("body_bytes"));

  let response = HttpResponse {
    status: 200,
    headers: vec![("set-cookie".into(), "value-SECRET".into())],
    body: b"{\"idToken\":\"id-SECRET\"}".to_vec(),
  };
  let text = format!("{response:?}");
  assert!(!text.contains("SECRET"), "{text}");
  assert!(text.contains("set-cookie"));
}
