//! 「この Mac で続きを受ける」を ON にしている間の常駐（#18804 S2）。
//!
//! - メニューバー（ON の間だけ）: 状態の 1 行・「NIHO docs を開く」・「続きを受ける」（チェック）・「NIHO docs を終了」。
//!   文は設定の行と同じ（design-guide-docs.md §4.1）。
//! - 窓を閉じても終わらない: 窓を隠して Dock から消える（Accessory）。画面が書きかけを保存してから窓を壊しても、最後の窓が
//!   閉じたことによる終了（`RunEvent::ExitRequested { code: None }`）を止めてメニューバーに残る。「開く」・Dock の再度の起動
//!   （`RunEvent::Reopen`）で窓を出す（壊れていれば設定から作り直す）。⌘Q・「終了」は今までどおり終わる。
//! - Mac へのログイン時の起動: `~/Library/LaunchAgents/life.niho.docs.pc-runner.plist`（`--background` で起動して窓を出さない）。
//!   launchctl は呼ばない（次のログインから効く）。開発・試験の起動と、隔離された場所（App Translocation）から開いたときは入れない。
//! - 常駐中の自動更新（#18823）: 窓を隠していて何も動いていないときに、取得した新しい版へ再起動する（判定は lib.rs の
//!   `restart_if_idle`）。差し替えた後は `--background` で起動し直し、窓を出さない。

use crate::pc_runner::{status_line, LogFn, PcRunner, PcRunnerStatus};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

/// ログイン時の起動の引数（窓を出さずにメニューバーだけで起動する）。
pub(crate) const BACKGROUND_ARG: &str = "--background";
pub(crate) const LAUNCH_AGENT_LABEL: &str = "life.niho.docs.pc-runner";
const TRAY_ID: &str = "niho-docs-pc-runner";
const MENU_STATUS: &str = "pc-runner-status";
const MENU_OPEN: &str = "pc-runner-open";
const MENU_TOGGLE: &str = "pc-runner-toggle";
const MENU_QUIT: &str = "pc-runner-quit";
const MAIN_WINDOW: &str = "main";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// 起動の引数（先頭は実行ファイル）に `--background` があるか。
pub(crate) fn is_background_launch<I: IntoIterator<Item = String>>(args: I) -> bool {
  args.into_iter().skip(1).any(|arg| arg == BACKGROUND_ARG)
}

// ---------------------------------------------------------------------------
// Mac へのログイン時の起動（LaunchAgent）

/// `~/Library/LaunchAgents` の plist（テストは置き場を差し替える）。
pub(crate) struct LaunchAgent {
  dir: PathBuf,
}

impl LaunchAgent {
  pub(crate) fn new(dir: PathBuf) -> Self {
    Self { dir }
  }

  pub(crate) fn for_user() -> Option<Self> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    home
      .is_absolute()
      .then(|| Self::new(home.join("Library").join("LaunchAgents")))
  }

  pub(crate) fn path(&self) -> PathBuf {
    self.dir.join(format!("{LAUNCH_AGENT_LABEL}.plist"))
  }

  /// 書いたら true（同じ内容ならそのまま。実行ファイルの場所が変わっていれば書き直す）。
  pub(crate) fn install(&self, exe: &Path) -> std::io::Result<bool> {
    let contents = plist(exe);
    if std::fs::read_to_string(self.path()).is_ok_and(|current| current == contents) {
      return Ok(false);
    }
    crate::pc_runner::write_atomic(&self.path(), contents.as_bytes())?;
    Ok(true)
  }

  /// 消したら true（無ければ false）。
  pub(crate) fn remove(&self) -> std::io::Result<bool> {
    match std::fs::remove_file(self.path()) {
      Ok(()) => Ok(true),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
      Err(error) => Err(error),
    }
  }
}

fn xml_escape(text: &str) -> String {
  text
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
    .replace('\'', "&apos;")
}

pub(crate) fn plist(exe: &Path) -> String {
  format!(
    r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>{arg}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
"#,
    label = LAUNCH_AGENT_LABEL,
    exe = xml_escape(&exe.to_string_lossy()),
    arg = BACKGROUND_ARG,
  )
}

/// ログイン時の起動を入れない理由（開発・試験の起動は本番の登録に触れない。隔離された場所の実行ファイルは次に開くと消える）。
pub(crate) fn skip_reason(dev: bool, exe: &Path) -> Option<&'static str> {
  if dev {
    Some("dev")
  } else if exe.to_string_lossy().contains("/AppTranslocation/") {
    Some("translocated")
  } else if !exe.is_absolute() {
    Some("relative")
  } else {
    None
  }
}

/// ログイン時の起動を書く。入れない理由（開発・隔離された場所など）は Ok、書けなかったら Err（ON にしない）。
pub(crate) fn install_launch_agent(dev: bool, log: &LogFn) -> std::io::Result<()> {
  let Ok(exe) = std::env::current_exe() else {
    log("pc_runner.login_item_skipped", json!({ "reason": "no_exe" }));
    return Ok(());
  };
  if let Some(reason) = skip_reason(dev, &exe) {
    log("pc_runner.login_item_skipped", json!({ "reason": reason }));
    return Ok(());
  }
  let Some(agent) = LaunchAgent::for_user() else {
    log("pc_runner.login_item_skipped", json!({ "reason": "no_home" }));
    return Ok(());
  };
  match agent.install(&exe) {
    Ok(written) => {
      log("pc_runner.login_item_installed", json!({ "written": written }));
      Ok(())
    }
    Err(error) => {
      log("pc_runner.login_item_failed", json!({}));
      Err(error)
    }
  }
}

pub(crate) fn remove_launch_agent(dev: bool, log: &LogFn) {
  if dev {
    return;
  }
  if let Some(agent) = LaunchAgent::for_user() {
    match agent.remove() {
      Ok(removed) => log("pc_runner.login_item_removed", json!({ "removed": removed })),
      Err(_) => log("pc_runner.login_item_remove_failed", json!({})),
    }
  }
}

// ---------------------------------------------------------------------------
// メニューバー

/// managed state（メニューの状態の 1 行とチェックを、状態が変わるたびに書き換える）。
#[derive(Default)]
pub(crate) struct Tray {
  items: Mutex<Option<TrayItems>>,
  /// メニューの操作の受け口を入れたか（tauri の受け口はアプリ全体で、外せないので 1 回だけ入れる）。
  listening: AtomicBool,
}

#[derive(Clone)]
struct TrayItems {
  status: MenuItem<Wry>,
  toggle: CheckMenuItem<Wry>,
}

fn show_tray(app: &AppHandle, status: &PcRunnerStatus) -> tauri::Result<()> {
  if app.tray_by_id(TRAY_ID).is_some() {
    update_tray(app, status);
    return Ok(());
  }
  let status_item = MenuItem::with_id(app, MENU_STATUS, status_line(status), false, None::<&str>)?;
  let open = MenuItem::with_id(app, MENU_OPEN, "NIHO docs を開く", true, None::<&str>)?;
  let toggle = CheckMenuItem::with_id(app, MENU_TOGGLE, "続きを受ける", true, status.enabled, None::<&str>)?;
  let quit = MenuItem::with_id(app, MENU_QUIT, "NIHO docs を終了", true, None::<&str>)?;
  let menu = Menu::with_items(
    app,
    &[
      &status_item,
      &PredefinedMenuItem::separator(app)?,
      &open,
      &toggle,
      &PredefinedMenuItem::separator(app)?,
      &quit,
    ],
  )?;
  if let Some(tray) = app.try_state::<Tray>() {
    if !tray.listening.swap(true, Ordering::SeqCst) {
      app.on_menu_event(|app, event| on_menu(app, event.id().as_ref()));
    }
  }
  let mut builder = TrayIconBuilder::with_id(TRAY_ID).menu(&menu).tooltip("NIHO docs");
  if let Some(icon) = app.default_window_icon() {
    builder = builder.icon(icon.clone());
  }
  builder.build(app)?;
  if let Some(tray) = app.try_state::<Tray>() {
    *lock(&tray.items) = Some(TrayItems {
      status: status_item,
      toggle,
    });
  }
  Ok(())
}

fn hide_tray(app: &AppHandle) {
  if let Some(tray) = app.try_state::<Tray>() {
    *lock(&tray.items) = None;
  }
  // メニューバーのアイコンは main thread で外して手放す（作ったのも main thread）。外し終えてから戻る
  // （すぐに ON に戻したとき、外す前のアイコンを残っているものと見違えない）
  let handle = app.clone();
  let (done, finished) = std::sync::mpsc::channel();
  let _ = app.run_on_main_thread(move || {
    drop(handle.remove_tray_by_id(TRAY_ID));
    let _ = done.send(());
  });
  let _ = finished.recv_timeout(std::time::Duration::from_secs(5));
}

/// 状態の 1 行とチェックを今の状態にする（メニューバーが無ければ何もしない）。
pub(crate) fn update_tray(app: &AppHandle, status: &PcRunnerStatus) {
  let Some(items) = app.try_state::<Tray>().and_then(|tray| lock(&tray.items).clone()) else {
    return;
  };
  let _ = items.status.set_text(status_line(status));
  let _ = items.toggle.set_checked(status.enabled);
}

fn on_menu(app: &AppHandle, id: &str) {
  match id {
    MENU_OPEN => show_main_window(app),
    MENU_TOGGLE => {
      let Some(runner) = app.try_state::<PcRunner>().map(|runner| runner.inner().clone()) else {
        return;
      };
      let app = app.clone();
      tauri::async_runtime::spawn(async move {
        let _ = runner.set_enabled(!runner.enabled()).await;
        update_tray(&app, &runner.status());
      });
    }
    MENU_QUIT => app.exit(0),
    _ => {}
  }
}

/// ON にしたとき・ON で起動したとき。
pub(crate) fn turn_on(app: &AppHandle, dev: bool, status: &PcRunnerStatus, log: &LogFn) -> std::io::Result<()> {
  install_launch_agent(dev, log)?;
  if show_tray(app, status).is_err() {
    log("pc_runner.tray_failed", json!({}));
  }
  Ok(())
}

/// OFF にしたとき。窓を隠していたら出す（メニューバーが消えると、開く場所が無くなるため）。
pub(crate) fn turn_off(app: &AppHandle, log: &LogFn) {
  let dev = app.try_state::<crate::AppState>().is_none_or(|state| state.dev);
  remove_launch_agent(dev, log);
  hide_tray(app);
  if !main_window_visible(app) {
    show_main_window(app);
  }
}

// ---------------------------------------------------------------------------
// 窓

/// 窓を出して前に（Dock にも戻す）。画面が窓を壊していたら、設定から作り直す。
pub(crate) fn show_main_window(app: &AppHandle) {
  #[cfg(target_os = "macos")]
  let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
  let window = app
    .get_webview_window(MAIN_WINDOW)
    .or_else(|| recreate_main_window(app));
  if let Some(window) = window {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

fn recreate_main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
  let config = app
    .config()
    .app
    .windows
    .iter()
    .find(|window| window.label == MAIN_WINDOW)?
    .clone();
  let window = tauri::WebviewWindowBuilder::from_config(app, &config)
    .ok()?
    .build()
    .ok()?;
  if app.try_state::<crate::AppState>().is_some_and(|state| state.dev) {
    let _ = window.set_title(crate::DEV_WINDOW_TITLE);
  }
  Some(window)
}

/// 窓を閉じた（ON の間）: 窓を隠し、Dock から消えてメニューバーに残る。
pub(crate) fn hide_to_menu_bar(window: &tauri::Window) {
  let _ = window.hide();
  stay_in_menu_bar(window.app_handle());
}

/// 主の窓が見えているか（無い・隠れているなら false。最小化は見えている扱い）。
pub(crate) fn main_window_visible(app: &AppHandle) -> bool {
  app
    .get_webview_window(MAIN_WINDOW)
    .and_then(|window| window.is_visible().ok())
    .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// 常駐中の自動更新（#18823）

/// 窓を隠して常駐している間の自動更新の再起動を、確かめにいくか（何も動いていないかは呼ぶ側が別に確かめる）。
pub(crate) fn idle_restart_wanted(resident_on: bool, staged: bool, window_visible: bool) -> bool {
  resident_on && staged && !window_visible
}

/// 終わった後（`.app` の差し替えの後）に、窓を出さずに起動し直すか。
static BACKGROUND_RELAUNCH: AtomicBool = AtomicBool::new(false);

pub(crate) fn request_background_relaunch() {
  BACKGROUND_RELAUNCH.store(true, Ordering::SeqCst);
}

/// 頼まれていれば true を返して取り下げる（`RunEvent::Exit` で 1 回だけ読む）。
pub(crate) fn take_background_relaunch() -> bool {
  BACKGROUND_RELAUNCH.swap(false, Ordering::SeqCst)
}

/// 差し替えた新しい版を `--background` で起動する（Tauri の再起動は起動時の引数を引き継ぐので、ふつうに開いた後に窓を閉じた
/// 常駐では窓が出てしまう）。失敗しても終了は止めない（次のログイン時の起動で戻る）。
pub(crate) fn relaunch_in_background() {
  if let Ok(exe) = std::env::current_exe() {
    let _ = std::process::Command::new(exe).arg(BACKGROUND_ARG).spawn();
  }
}

/// Dock に出さずメニューバーだけにする（ログイン時の起動・窓を閉じた後）。
pub(crate) fn stay_in_menu_bar(app: &AppHandle) {
  #[cfg(target_os = "macos")]
  let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
  #[cfg(not(target_os = "macos"))]
  let _ = app;
}

#[cfg(test)]
#[path = "resident_tests.rs"]
mod tests;
