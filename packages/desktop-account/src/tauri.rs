//! Tauri の層（feature `tauri`）。アプリは
//! `.plugin(niho_desktop_account::tauri::deep_link()).plugin(niho_desktop_account::tauri::init(env))` を足すだけ
//! （`tauri.conf.json` の `plugins.deep-link.desktop.schemes` にスキームを書く）。
//!
//! - deep link（`tauri-plugin-deep-link` の `on_open_url` と起動時の `get_current`）を [`AccountService::handle_callback`] に繋ぐ。
//!   `state` が合わない URL は捨ててログだけ残す。
//! - commands: `account_state` / `account_begin_login`（接続 URL を既定のブラウザで開く）/ `account_cancel_login` /
//!   `account_logout`（引数 `everywhere`。既定 false。true なら「ほかの端末でもログアウトする」）/ `account_open_my_page`。
//!   permission は `permissions/`（`default` で全部）。
//! - 接続 refresh token と pending の保存先は app data のファイル（[`FileSecretStore`]。`data_dir/account-secrets/`。spec D-16 改）。
//!   Keychain（[`crate::secret::KeychainStore`]）は使わず、旧版が Keychain に置いた項目も読まない。
//! - event: `niho-account://changed`（[`AccountState`] の JSON）。画面はこれで再描画する。
//! - 顔写真は `data_dir` のファイル。画面は `convertFileSrc` で出す（CSP の `img-src` に `asset:` が要る）。

use crate::client::Environment;
use crate::error::AccountError;
use crate::http::ReqwestClient;
use crate::ready::UiReady;
use crate::secret::FileSecretStore;
use crate::service::{AccountService, AccountState, LogFn, ServiceConfig};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::plugin::{Builder, Plugin, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// plugin 名（permission の識別子 `niho-desktop-account:allow-…`・JS の `plugin:niho-desktop-account|…`）。
pub const PLUGIN_NAME: &str = "niho-desktop-account";
/// 状態が変わったときの event。payload は [`AccountState`]。
pub const CHANGED_EVENT: &str = "niho-account://changed";
/// deep link の処理（コードの交換）に失敗したときの event。payload は [`AccountError`]（`state` 不一致・2 回目は送らない）。
pub const LOGIN_FAILED_EVENT: &str = "niho-account://login-failed";
const LOG_FILE_NAME: &str = "niho-account.log";
const LOG_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// 手入れの間隔（次の予定が無いとき）と、その上限・下限。
const MAINTAIN_IDLE: Duration = Duration::from_secs(60);
const MAINTAIN_MIN: Duration = Duration::from_secs(1);
const MAINTAIN_MAX: Duration = Duration::from_secs(10 * 60);

/// managed state（`tauri::State<AccountHandle>`）。アプリ側で ID token を要する API を足すときはここから `service()` を取る。
pub struct AccountHandle {
  service: Arc<AccountService>,
  ui_ready: Arc<UiReady>,
  start_ready: tokio::sync::watch::Receiver<bool>,
}

impl AccountHandle {
  pub fn service(&self) -> &Arc<AccountService> {
    &self.service
  }
}

/// `init_with` の調整（既定でよいアプリは [`init`]）。
#[derive(Default)]
pub struct Options {
  /// この Mac の名前（既定は `scutil --get ComputerName`、無ければ hostname）
  pub device_name: Option<String>,
  /// ログの書き先（既定は app log dir の `niho-account.log`）
  pub log: Option<LogFn>,
  /// プロフィール・顔写真・接続 refresh token（`account-secrets/`）の置き場（既定は app data dir の `account/`）
  pub data_dir: Option<PathBuf>,
}

/// `tauri-plugin-deep-link` の plugin（この crate が使う版をアプリに直接依存させない）。[`init`] より前に登録する。
pub fn deep_link<R: Runtime>() -> impl Plugin<R> {
  tauri_plugin_deep_link::init()
}

/// 起動時に OS から受けた URL を、重複起動の判定前に取り出す。
/// 呼び出し側は同じユーザーだけが接続できる経路で既存プロセスへ渡す。
pub fn startup_callback_urls<R: Runtime>(app: &AppHandle<R>, scheme: &str) -> std::io::Result<Vec<String>> {
  let deep_link = app
    .try_state::<tauri_plugin_deep_link::DeepLink<R>>()
    .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "deep link を確認できません。"))?;
  Ok(
    deep_link
      .get_current()
      .map_err(|_| std::io::Error::other("起動時の deep link を確認できません。"))?
      .unwrap_or_default()
      .into_iter()
      .filter(|url| url.scheme() == scheme)
      .map(|url| url.to_string())
      .collect(),
  )
}

/// 既存プロセスが受け取った callback を、そこで保持している pending login に渡す。
/// `true` は処理を受け付けたことを表し、認証の成否は既存の event で通知する。
pub fn accept_forwarded_callback<R: Runtime>(app: &AppHandle<R>, raw: &str) -> bool {
  let Ok(url) = url::Url::parse(raw) else {
    return false;
  };
  let Some(account) = app.try_state::<AccountHandle>() else {
    return false;
  };
  if url.scheme() != account.service.env().client.scheme() {
    return false;
  }
  let service = account.service.clone();
  let mut start_ready = account.start_ready.clone();
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    if !*start_ready.borrow() && start_ready.changed().await.is_err() {
      return;
    }
    handle_callback_url(&app, &service, url.as_str()).await;
  });
  true
}

pub fn init<R: Runtime>(env: Environment) -> TauriPlugin<R> {
  init_with(env, Options::default())
}

pub fn init_with<R: Runtime>(env: Environment, options: Options) -> TauriPlugin<R> {
  let options = Mutex::new(Some(options));
  Builder::new(PLUGIN_NAME)
    .invoke_handler(tauri::generate_handler![
      account_state,
      account_begin_login,
      account_cancel_login,
      account_logout,
      account_open_my_page
    ])
    .setup(move |app, _api| {
      let options = options.lock().map(|mut slot| slot.take()).unwrap_or_default().unwrap_or_default();
      let log = options.log.unwrap_or_else(|| file_log(app.path().app_log_dir().ok()));
      let data_dir = match options.data_dir {
        Some(dir) => dir,
        None => app.path().app_data_dir()?.join("account"),
      };
      std::fs::create_dir_all(&data_dir)?;
      let device_name = options.device_name.unwrap_or_else(device_name);
      let http = ReqwestClient::new().map_err(|_| "niho-desktop-account: HTTP client could not be created")?;
      // Developer ID 署名までは app data のファイル（spec D-16 改）。旧版の Keychain の項目は読まない（確認を出さない）
      let secrets = FileSecretStore::in_data_dir(&data_dir);
      let scheme = env.client.scheme().to_string();
      let service = Arc::new(AccountService::new(
        ServiceConfig::new(env, Arc::new(secrets), Arc::new(http), data_dir, device_name).log(log.clone()),
      ));

      // 状態が変わったら画面へ（起動の裏の手入れも起こす）
      let wake = Arc::new(tokio::sync::Notify::new());
      let emitter = app.clone();
      let waker = wake.clone();
      service.subscribe(move |state| {
        let _ = emitter.emit(CHANGED_EVENT, state);
        waker.notify_one();
      });

      // deep link の受け口（plugin は先に登録されていること）
      let Some(deep_link) = app.try_state::<tauri_plugin_deep_link::DeepLink<R>>() else {
        return Err(
          "niho-desktop-account: register niho_desktop_account::tauri::deep_link() before niho_desktop_account::tauri::init()"
            .into(),
        );
      };
      let callback_service = service.clone();
      let callback_scheme = scheme.clone();
      let callback_app = app.clone();
      deep_link.on_open_url(move |event| {
        for url in event.urls() {
          if url.scheme() != callback_scheme {
            continue;
          }
          let service = callback_service.clone();
          let app = callback_app.clone();
          tauri::async_runtime::spawn(async move {
            handle_callback_url(&app, &service, url.as_str()).await;
          });
        }
      });
      let initial_urls: Vec<_> = deep_link
        .get_current()
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter(|url| url.scheme() == scheme)
        .collect();
      let ui_ready = Arc::new(UiReady::default());
      let (start_signal, start_ready) = tokio::sync::watch::channel(false);

      app.manage(AccountHandle {
        service: service.clone(),
        ui_ready: ui_ready.clone(),
        start_ready,
      });

      // 起動: 保存した状態を出し、接続があれば更新してプロフィールを取り直し、起動時の deep link を処理し、裏で手入れを回す
      let launch_app = app.clone();
      let launch_ui_ready = ui_ready;
      tauri::async_runtime::spawn(async move {
        service.start().await;
        let _ = start_signal.send(true);
        if !initial_urls.is_empty() {
          // account_state は画面が changed/login-failed listener を登録してから呼ぶ。
          // 初回 deep link の失敗 event を購読前に emit しないよう、UI の準備を待つ。
          let _ = launch_ui_ready.wait(Duration::from_secs(15)).await;
        }
        for url in initial_urls {
          handle_callback_url(&launch_app, &service, url.as_str()).await;
        }
        loop {
          let due = service.maintain().await;
          let wait = due
            .map(|at| at.duration_since(SystemTime::now()).unwrap_or(Duration::ZERO))
            .unwrap_or(MAINTAIN_IDLE)
            .clamp(MAINTAIN_MIN, MAINTAIN_MAX);
          let _ = tokio::time::timeout(wait, wake.notified()).await;
        }
      });
      Ok(())
    })
    .build()
}

/// deep link を処理し、利用者に見せる失敗だけを event にする（`state` 不一致・2 回目は Rust のログだけ。spec「失敗の分岐」）。
async fn handle_callback_url<R: Runtime>(app: &AppHandle<R>, service: &Arc<AccountService>, url: &str) {
  if let Err(error) = service.handle_callback(url).await {
    if !error.is_silent() {
      let _ = app.emit(LOGIN_FAILED_EVENT, &error);
    }
  }
}

#[tauri::command]
async fn account_state(handle: State<'_, AccountHandle>) -> Result<AccountState, AccountError> {
  let state = handle.service.state();
  handle.ui_ready.signal();
  Ok(state)
}

/// pending を作って接続 URL を既定のブラウザで開く。開けなければ pending を捨てる。
#[tauri::command]
async fn account_begin_login(handle: State<'_, AccountHandle>) -> Result<(), AccountError> {
  let begin = handle.service.begin_login()?;
  if tauri_plugin_opener::open_url(begin.url.as_str(), None::<&str>).is_err() {
    handle.service.cancel_login()?;
    return Err(AccountError::browser_failed());
  }
  Ok(())
}

#[tauri::command]
async fn account_cancel_login(handle: State<'_, AccountHandle>) -> Result<(), AccountError> {
  handle.service.cancel_login()
}

/// ログアウト。`everywhere: true` なら「ほかの端末でもログアウトする」（`POST /api/auth/sign-out-everywhere` が通ったときだけ
/// この Mac もログアウトする。失敗したらこの Mac はログイン済みのまま）。
#[tauri::command]
async fn account_logout(handle: State<'_, AccountHandle>, everywhere: Option<bool>) -> Result<(), AccountError> {
  if everywhere.unwrap_or(false) {
    handle.service.logout_everywhere().await
  } else {
    handle.service.logout().await
  }
}

/// マイページ（`https://niho.life/account`）を既定のブラウザで開く。
#[tauri::command]
async fn account_open_my_page(handle: State<'_, AccountHandle>) -> Result<(), AccountError> {
  let url = handle.service.env().my_page_url();
  tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(|_| AccountError::browser_failed())
}

/// この Mac の名前（`scutil --get ComputerName` → hostname → "Mac"）。`exchange` の body でだけ送る。
pub fn device_name() -> String {
  fn run(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program).args(args).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !text.is_empty()).then_some(text)
  }
  run("scutil", &["--get", "ComputerName"])
    .or_else(|| run("hostname", &["-s"]))
    .unwrap_or_else(|| "Mac".to_string())
}

/// 既定のログ（app log dir の `niho-account.log`。1 行 1 JSON。2 MB を超えたら `.1` へ回す）。秘密は crate が渡さない。
pub fn file_log(dir: Option<PathBuf>) -> LogFn {
  let guard = Arc::new(Mutex::new(()));
  Arc::new(move |kind, payload| {
    if let Some(dir) = &dir {
      let _lock = guard.lock().unwrap_or_else(|poison| poison.into_inner());
      append_log(dir, kind, payload);
    }
  })
}

fn append_log(dir: &Path, kind: &str, payload: Value) {
  let epoch_ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|elapsed| elapsed.as_millis())
    .unwrap_or_default();
  let line = json!({ "epochMs": epoch_ms, "kind": kind, "data": payload });
  let Ok(mut bytes) = serde_json::to_vec(&line) else {
    return;
  };
  bytes.push(b'\n');
  if std::fs::create_dir_all(dir).is_err() {
    return;
  }
  let path = dir.join(LOG_FILE_NAME);
  if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > LOG_MAX_BYTES) {
    let _ = std::fs::rename(&path, dir.join(format!("{LOG_FILE_NAME}.1")));
  }
  if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
    let _ = file.write_all(&bytes);
  }
}

#[allow(dead_code)]
fn _assert_handle_is_send(_: &AppHandle<tauri::Wry>) {}
