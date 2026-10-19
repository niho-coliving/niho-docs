//! CLI のログイン・Claude Code の更新とインストール（Desktop の claude_auth・claude_update・claude_maintenance の写し）。
//!
//! - 画面からコマンド・パス・引数は受け取らず、見つけた CLI へ決まった引数（`auth login`・`login`・`update`）だけを渡す。
//!   ログインは CLI が開くブラウザで本人が行い、NIHO は認証情報を受け取らない（標準入出力もつながない）。
//! - 更新・ログイン・インストールは同時に 1 つだけ。実行中の工程とも排他にする（工程の側もここを確認する）。

use crate::claude::reset_thinking_display_support;
use crate::process::{
  has_running_turns, kill_leftover_group, run_capture, sanitize_stderr_tail, signal_process_group, write_private_file,
  CaptureError, Captured, PrivateDir, INSTALL_DIR_PREFIX,
};
use crate::runtime::{build_child_command, provider_command, resolve_cli, Runtime};
use crate::status::provider_status_with;
use crate::types::{ClaudeUpdateResult, LocalAiError, Provider, ProviderStatus};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU8, Ordering};
use std::time::{Duration, Instant};

const IDLE: u8 = 0;
const UPDATE: u8 = 1;
const AUTH: u8 = 2;
const INSTALL: u8 = 3;

static MAINTENANCE_STATE: AtomicU8 = AtomicU8::new(IDLE);

const AUTH_TIME_LIMIT: Duration = Duration::from_secs(10 * 60);
const AUTH_KILL_GRACE: Duration = Duration::from_secs(2);
const UPDATE_TIME_LIMIT: Duration = Duration::from_secs(5 * 60);
const UPDATE_KILL_GRACE: Duration = Duration::from_secs(2);
const INSTALL_DOWNLOAD_TIME_LIMIT: Duration = Duration::from_secs(2 * 60);
const INSTALL_RUN_TIME_LIMIT: Duration = Duration::from_secs(10 * 60);
const OUTPUT_MAX_BYTES: usize = 16 * 1024;

/// ログイン待ちの `auth login` / `login`（自分のプロセスグループの先頭）の pid。0 は無し。アプリを閉じたときに止める
/// ための共有状態で、`Child` は起動した関数の中にしか無く、アプリの終了とともに時間上限の監視も失われるため。
static RUNNING_AUTH_PID: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Copy, Debug)]
pub(crate) enum MaintenanceKind {
  Update,
  Auth,
  Install,
}

impl MaintenanceKind {
  fn value(self) -> u8 {
    match self {
      Self::Update => UPDATE,
      Self::Auth => AUTH,
      Self::Install => INSTALL,
    }
  }
}

pub(crate) fn is_in_progress() -> bool {
  MAINTENANCE_STATE.load(Ordering::SeqCst) != IDLE
}

#[derive(Debug)]
pub(crate) struct MaintenanceRegistration<'a> {
  state: &'a AtomicU8,
}

impl Drop for MaintenanceRegistration<'_> {
  fn drop(&mut self) {
    self.state.store(IDLE, Ordering::SeqCst);
  }
}

fn acquire_at(state: &AtomicU8, kind: MaintenanceKind) -> Result<MaintenanceRegistration<'_>, LocalAiError> {
  state
    .compare_exchange(IDLE, kind.value(), Ordering::SeqCst, Ordering::SeqCst)
    .map_err(|running| match running {
      UPDATE => LocalAiError::new(
        "update_in_progress",
        "AI の CLI を更新しています。完了までそのままお待ちください。",
      ),
      AUTH => LocalAiError::new(
        "auth_in_progress",
        "AI の CLI のログインを確認しています。ブラウザでログインを完了してください。",
      ),
      INSTALL => LocalAiError::new(
        "install_in_progress",
        "Claude Code をインストールしています。完了までそのままお待ちください。",
      ),
      _ => LocalAiError::new(
        "maintenance_in_progress",
        "AI の CLI の準備が終わってから、もう一度お試しください。",
      ),
    })?;
  Ok(MaintenanceRegistration { state })
}

/// 更新・ログイン・インストールの排他を取る。登録した後で実行中の工程を確かめる（工程の側は登録の前後でここを確かめる）
/// ので、同時開始はどちらの順でも成立しない。
fn acquire(kind: MaintenanceKind) -> Result<MaintenanceRegistration<'static>, LocalAiError> {
  let registration = acquire_at(&MAINTENANCE_STATE, kind)?;
  if has_running_turns() {
    return Err(LocalAiError::new(
      "turn_running",
      "このMacの AI で実行中の工程が終わってから、もう一度お試しください。",
    ));
  }
  Ok(registration)
}

fn cli_not_found(provider: Provider) -> LocalAiError {
  LocalAiError::new(
    "cli_not_found",
    format!("このMacに {} が見つかりません。", provider.label()),
  )
}

// ---------------------------------------------------------------------------
// ログイン

struct RunningAuthRegistration;

impl RunningAuthRegistration {
  fn register(pid: u32) -> Self {
    RUNNING_AUTH_PID.store(pid, Ordering::SeqCst);
    Self
  }
}

impl Drop for RunningAuthRegistration {
  fn drop(&mut self) {
    RUNNING_AUTH_PID.store(0, Ordering::SeqCst);
  }
}

/// アプリを閉じるときに、ログイン待ちの CLI をプロセスグループごと止める。
/// 止めないと、閉じたアプリの認証処理が孤児として残り、後から完了したり待ち続けたりする。
pub(crate) fn shutdown_running_auth() {
  let pid = RUNNING_AUTH_PID.swap(0, Ordering::SeqCst);
  if pid == 0 {
    return;
  }
  signal_process_group(pid, libc::SIGTERM);
  std::thread::sleep(Duration::from_millis(200));
  signal_process_group(pid, libc::SIGKILL);
}

fn login_args(provider: Provider) -> &'static [&'static str] {
  match provider {
    Provider::ClaudeCode => &["auth", "login"],
    Provider::CodexCli => &["login"],
    Provider::GeminiCli => &[],
  }
}

/// ブラウザでのログインが自動で戻らない環境（認証コードを標準入力へ貼り戻す必要がある）は、画面からは完了できない。
/// 標準入力を渡さない（認証情報を NIHO に通さない）ので、端末でのログインへ案内する。
fn auth_timeout_message(provider: Provider) -> String {
  format!(
    "{label} のログイン確認を終了しました。もう一度お試しください。ブラウザでのログインが完了しないときは、ターミナルで「{name} {args}」を実行してログインしてください。",
    label = provider.label(),
    name = provider.cli_name(),
    args = login_args(provider).join(" "),
  )
}

fn auth_command(runtime: &Runtime, provider: Provider, cli: &std::path::Path) -> Command {
  let args: Vec<String> = login_args(provider).iter().map(|arg| arg.to_string()).collect();
  provider_command(runtime, provider, cli, &args, &[])
}

fn run_auth_at(
  mut command: Command,
  provider: Provider,
  time_limit: Duration,
  kill_grace: Duration,
) -> Result<ExitStatus, LocalAiError> {
  // OAuth の URL・アカウントの情報を NIHO のログや画面へ渡さない
  command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
  let label = provider.label();
  let mut child = command.spawn().map_err(|error| {
    LocalAiError::new(
      "auth_start_failed",
      format!("{label} のログインを始められませんでした。"),
    )
    .with_details(Some(error.to_string()))
  })?;
  let pid = child.id();
  // 戻る（正常・時間切れ・失敗）どの経路でも登録を外す。アプリ終了時はこの pid のグループを止める。
  let _running = RunningAuthRegistration::register(pid);
  let deadline = Instant::now() + time_limit;
  loop {
    match child.try_wait() {
      Ok(Some(status)) => {
        kill_leftover_group(pid);
        return Ok(status);
      }
      Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
      Ok(None) => {
        signal_process_group(pid, libc::SIGTERM);
        let kill_deadline = Instant::now() + kill_grace;
        while Instant::now() < kill_deadline {
          if matches!(child.try_wait(), Ok(Some(_))) {
            kill_leftover_group(pid);
            return Err(LocalAiError::new("auth_timeout", auth_timeout_message(provider)));
          }
          std::thread::sleep(Duration::from_millis(50));
        }
        signal_process_group(pid, libc::SIGKILL);
        let _ = child.kill();
        let _ = child.wait();
        kill_leftover_group(pid);
        return Err(LocalAiError::new("auth_timeout", auth_timeout_message(provider)));
      }
      Err(error) => {
        signal_process_group(pid, libc::SIGKILL);
        let _ = child.kill();
        let _ = child.wait();
        kill_leftover_group(pid);
        return Err(
          LocalAiError::new(
            "auth_wait_failed",
            format!("{label} のログイン結果を確認できませんでした。"),
          )
          .with_details(Some(error.to_string())),
        );
      }
    }
  }
}

/// 既定の実行環境でログインを始める。[`start_auth_with`] を見る。
pub fn start_auth(provider: Provider) -> Result<ProviderStatus, LocalAiError> {
  start_auth_with(&Runtime::default(), provider)
}

/// 見つけた CLI で公式のログインを始め（claude は `auth login`、codex は `login`）、終わったら状態を確かめ直して返す。
/// すでにログインしていれば何もしない。agy は画面から始められない（端末で `agy` を起動してログインする）。
pub fn start_auth_with(runtime: &Runtime, provider: Provider) -> Result<ProviderStatus, LocalAiError> {
  if provider == Provider::GeminiCli {
    return Err(LocalAiError::new(
      "auth_unsupported",
      "Antigravity CLI のログインは、ターミナルで agy を起動して行ってください（初回は Google のアカウントでログインします）。",
    ));
  }
  let _registration = acquire(MaintenanceKind::Auth)?;
  let Some(cli) = resolve_cli(runtime, provider) else {
    return Err(cli_not_found(provider));
  };
  let before = provider_status_with(runtime, provider);
  if !before.installed {
    return Err(cli_not_found(provider));
  }
  let label = provider.label();
  if !before.authenticated {
    let status = run_auth_at(
      auth_command(runtime, provider, &cli),
      provider,
      AUTH_TIME_LIMIT,
      AUTH_KILL_GRACE,
    )?;
    if !status.success() {
      return Err(
        LocalAiError::new(
          "auth_failed",
          format!("{label} にログインできませんでした。ブラウザでログインを完了して、もう一度お試しください。"),
        )
        .with_details(status.code().map(|code| format!("exit code {code}"))),
      );
    }
  }
  let after = provider_status_with(runtime, provider);
  if !after.authenticated {
    return Err(LocalAiError::new(
      "auth_incomplete",
      format!("{label} のログインを確認できませんでした。ブラウザでログインを完了して、もう一度お試しください。"),
    ));
  }
  Ok(after)
}

// ---------------------------------------------------------------------------
// 更新

fn capture_error(code_prefix: &str, action: &str, error: CaptureError) -> LocalAiError {
  match error {
    CaptureError::Spawn(error) => LocalAiError::new(
      &format!("{code_prefix}_start_failed"),
      format!("{action}を始められませんでした。"),
    )
    .with_details(Some(error.to_string())),
    CaptureError::TimedOut => LocalAiError::new(
      &format!("{code_prefix}_timeout"),
      format!("{action}に時間がかかりすぎました。通信を確認して、もう一度お試しください。"),
    ),
    CaptureError::Wait(error) => LocalAiError::new(
      &format!("{code_prefix}_wait_failed"),
      format!("{action}の結果を確認できませんでした。"),
    )
    .with_details(Some(error.to_string())),
  }
}

/// 失敗した CLI の出力（stdout と stderr）の末尾。秘密に見える値は伏せる。
fn command_output_details(output: &Captured) -> Option<String> {
  let stdout = String::from_utf8_lossy(&output.stdout);
  let stderr = String::from_utf8_lossy(&output.stderr);
  let combined = match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
    (false, false) => format!("stdout:\n{}\nstderr:\n{}", stdout.trim(), stderr.trim()),
    (false, true) => stdout.trim().to_string(),
    (true, false) => stderr.trim().to_string(),
    (true, true) => String::new(),
  };
  let sanitized = sanitize_stderr_tail(&combined, OUTPUT_MAX_BYTES);
  (!sanitized.is_empty()).then_some(sanitized)
}

fn run_update_at(command: Command, time_limit: Duration) -> Result<Captured, LocalAiError> {
  run_capture(command, time_limit, UPDATE_KILL_GRACE, OUTPUT_MAX_BYTES)
    .map_err(|error| capture_error("update", "Claude Code の更新", error))
}

/// 既定の実行環境で Claude Code を更新する。[`update_claude_with`] を見る。
pub fn update_claude() -> Result<ClaudeUpdateResult, LocalAiError> {
  update_claude_with(&Runtime::default())
}

/// 見つけた Claude Code へ `update` だけを渡して最新にし、必要なフラグがそろっているかを確かめ直して返す。
pub fn update_claude_with(runtime: &Runtime) -> Result<ClaudeUpdateResult, LocalAiError> {
  let provider = Provider::ClaudeCode;
  let _registration = acquire(MaintenanceKind::Update)?;
  let Some(cli) = resolve_cli(runtime, provider) else {
    return Err(cli_not_found(provider));
  };
  let before = provider_status_with(runtime, provider);
  if !before.installed {
    return Err(cli_not_found(provider));
  }
  let output = run_update_at(
    provider_command(runtime, provider, &cli, &["update".to_string()], &[]),
    UPDATE_TIME_LIMIT,
  )?;
  if !output.status.success() {
    return Err(
      LocalAiError::new(
        "update_failed",
        "Claude Code を更新できませんでした。通信を確認して、もう一度お試しください。",
      )
      .with_details(command_output_details(&output)),
    );
  }
  // 新しい版は `--thinking-display` に対応しているかもしれない（だめならまた 1 回だけやり直して覚える）
  reset_thinking_display_support();
  let after = provider_status_with(runtime, provider);
  if !after.installed || !after.missing_cli_flags.is_empty() {
    let missing = after.missing_cli_flags.join(", ");
    return Err(
      LocalAiError::new(
        "update_incompatible",
        "更新後の Claude Code でも、必要な機能を確認できませんでした。運営に連絡してください。",
      )
      .with_details((!missing.is_empty()).then(|| format!("missing CLI flags: {missing}"))),
    );
  }
  Ok(ClaudeUpdateResult {
    before_version: before.version,
    after_version: after.version.clone(),
    status: after,
  })
}

// ---------------------------------------------------------------------------
// インストール

/// 既定の実行環境で Claude Code を入れる。[`install_claude_with`] を見る。
pub fn install_claude() -> Result<ProviderStatus, LocalAiError> {
  install_claude_with(&Runtime::default())
}

/// 公式のインストーラ（`curl -fsSL https://claude.ai/install.sh | bash` と同じもの）を 0600 の一時ファイルに取ってから
/// 実行し、入ったことを確かめて返す。すでに入っていれば何もしない。一時ファイルは成功・失敗のどれでも消す。
pub fn install_claude_with(runtime: &Runtime) -> Result<ProviderStatus, LocalAiError> {
  let provider = Provider::ClaudeCode;
  let _registration = acquire(MaintenanceKind::Install)?;
  let current = provider_status_with(runtime, provider);
  if current.installed {
    return Ok(current);
  }
  let installer = &runtime.claude_installer;
  let dir = PrivateDir::create(&runtime.scratch_dir, INSTALL_DIR_PREFIX).map_err(|error| {
    LocalAiError::new(
      "install_prepare_failed",
      "Claude Code のインストールを準備できませんでした。",
    )
    .with_details(Some(error.to_string()))
  })?;
  let script = dir.path().join("install.sh");
  // 先に 0600 で作っておき、curl はそこへ上書きする（取得の途中でほかの人に読まれない・差し替えられない）
  write_private_file(&script, b"", true).map_err(|error| {
    LocalAiError::new(
      "install_prepare_failed",
      "Claude Code のインストールを準備できませんでした。",
    )
    .with_details(Some(error.to_string()))
  })?;
  let home = runtime.home();
  let download_args: Vec<String> = vec![
    "-fsSL".to_string(),
    "--proto".to_string(),
    "=https".to_string(),
    "--tlsv1.2".to_string(),
    "--output".to_string(),
    script.to_string_lossy().into_owned(),
    installer.url.clone(),
  ];
  let download = run_capture(
    build_child_command(&installer.curl, &download_args, home.as_deref(), &[], &[]),
    INSTALL_DOWNLOAD_TIME_LIMIT,
    runtime.kill_grace,
    OUTPUT_MAX_BYTES,
  )
  .map_err(|error| capture_error("install_download", "Claude Code のインストーラの取得", error))?;
  if !download.status.success() {
    return Err(
      LocalAiError::new(
        "install_download_failed",
        "Claude Code のインストーラを取得できませんでした。通信を確認して、もう一度お試しください。",
      )
      .with_details(command_output_details(&download)),
    );
  }
  let run = run_capture(
    build_child_command(
      &installer.shell,
      &[script.to_string_lossy().into_owned()],
      home.as_deref(),
      &[],
      &[],
    ),
    INSTALL_RUN_TIME_LIMIT,
    runtime.kill_grace,
    OUTPUT_MAX_BYTES,
  )
  .map_err(|error| capture_error("install", "Claude Code のインストール", error))?;
  drop(dir);
  if !run.status.success() {
    return Err(
      LocalAiError::new(
        "install_failed",
        "Claude Code をインストールできませんでした。通信を確認して、もう一度お試しください。",
      )
      .with_details(command_output_details(&run)),
    );
  }
  let after = provider_status_with(runtime, provider);
  if !after.installed {
    return Err(LocalAiError::new(
      "install_incomplete",
      "Claude Code のインストールを確認できませんでした。もう一度お試しください。",
    ));
  }
  Ok(after)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  #[cfg(unix)]
  use std::os::unix::fs::PermissionsExt;
  use std::path::PathBuf;
  use std::sync::{Mutex, MutexGuard};
  use std::time::{SystemTime, UNIX_EPOCH};

  /// `RUNNING_AUTH_PID` はプロセス内で共有される。ログイン待ちを止めるテストが、並行して走る別のテストの
  /// 偽 CLI を止めないよう、`run_auth_at` を呼ぶテストはすべてこの鍵を取って直列にする。
  fn auth_test_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
  }

  fn fake_cli(name: &str, script: &str) -> PathBuf {
    let unique = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("niho-local-ai-maintenance-{}-{unique}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    #[cfg(unix)]
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
  }

  fn runtime() -> Runtime {
    Runtime {
      home_dir: Some(PathBuf::from("/nonexistent/niho-local-ai/home")),
      ..Runtime::default()
    }
  }

  #[test]
  fn authenticator_passes_only_the_fixed_auth_login_arguments() {
    let _lock = auth_test_lock();
    let cli = fake_cli(
      "claude",
      "test \"$#\" -eq 2 && test \"$1\" = auth && test \"$2\" = login",
    );
    let command = auth_command(&runtime(), Provider::ClaudeCode, &cli);
    let status = run_auth_at(
      command,
      Provider::ClaudeCode,
      Duration::from_secs(2),
      Duration::from_millis(100),
    )
    .unwrap();
    assert!(status.success());
    let codex = fake_cli("codex", "test \"$#\" -eq 1 && test \"$1\" = login");
    let command = auth_command(&runtime(), Provider::CodexCli, &codex);
    let status = run_auth_at(
      command,
      Provider::CodexCli,
      Duration::from_secs(2),
      Duration::from_millis(100),
    )
    .unwrap();
    assert!(status.success());
    let _ = fs::remove_dir_all(cli.parent().unwrap());
    let _ = fs::remove_dir_all(codex.parent().unwrap());
  }

  #[test]
  fn authenticator_reports_non_zero_exit() {
    let _lock = auth_test_lock();
    let cli = fake_cli("claude", "exit 7");
    let command = auth_command(&runtime(), Provider::ClaudeCode, &cli);
    let status = run_auth_at(
      command,
      Provider::ClaudeCode,
      Duration::from_secs(2),
      Duration::from_millis(100),
    )
    .unwrap();
    assert_eq!(status.code(), Some(7));
    let _ = fs::remove_dir_all(cli.parent().unwrap());
  }

  #[test]
  fn timeout_message_points_to_the_terminal_login_for_the_code_paste_case() {
    assert!(auth_timeout_message(Provider::ClaudeCode).contains("claude auth login"));
    assert!(auth_timeout_message(Provider::CodexCli).contains("codex login"));
  }

  #[test]
  fn app_exit_stops_a_login_that_is_still_waiting_and_clears_the_registration() {
    let _lock = auth_test_lock();
    // アプリを閉じたときにログイン待ちのプロセスグループを止める（孤児にしない）。
    let cli = fake_cli("claude", "sleep 30");
    let command = auth_command(&runtime(), Provider::ClaudeCode, &cli);
    let runner = std::thread::spawn(move || {
      run_auth_at(
        command,
        Provider::ClaudeCode,
        Duration::from_secs(60),
        Duration::from_millis(100),
      )
    });
    let started = Instant::now();
    while RUNNING_AUTH_PID.load(Ordering::SeqCst) == 0 {
      assert!(
        started.elapsed() < Duration::from_secs(5),
        "login process was not registered"
      );
      std::thread::sleep(Duration::from_millis(20));
    }
    shutdown_running_auth();
    let status = runner.join().unwrap().unwrap();
    assert!(!status.success(), "the waiting login is killed, not completed");
    assert!(
      started.elapsed() < Duration::from_secs(10),
      "stopped promptly, not after the wall-clock limit"
    );
    assert_eq!(RUNNING_AUTH_PID.load(Ordering::SeqCst), 0);
    let _ = fs::remove_dir_all(cli.parent().unwrap());
  }

  #[test]
  fn shutdown_without_a_running_login_does_nothing() {
    let _lock = auth_test_lock();
    assert_eq!(RUNNING_AUTH_PID.load(Ordering::SeqCst), 0);
    shutdown_running_auth();
    assert_eq!(RUNNING_AUTH_PID.load(Ordering::SeqCst), 0);
  }

  #[test]
  fn authenticator_stops_after_its_wall_clock_limit() {
    let _lock = auth_test_lock();
    let cli = fake_cli("claude", "trap '' TERM\nsleep 30");
    let command = auth_command(&runtime(), Provider::ClaudeCode, &cli);
    let error = run_auth_at(
      command,
      Provider::ClaudeCode,
      Duration::from_millis(100),
      Duration::from_millis(100),
    )
    .unwrap_err();
    assert_eq!(error.code, "auth_timeout");
    let _ = fs::remove_dir_all(cli.parent().unwrap());
  }

  #[test]
  fn authenticator_kills_group_members_when_parent_exits_during_term_grace() {
    let _lock = auth_test_lock();
    let marker = std::env::temp_dir().join(format!("niho-auth-child-marker-{}", std::process::id()));
    let marker_arg = format!("{:?}", marker.to_string_lossy());
    let cli = fake_cli(
      "claude",
      &format!("(trap '' TERM; sleep 1; touch {marker_arg}) &\ntrap 'exit 0' TERM\nsleep 30"),
    );
    let command = auth_command(&runtime(), Provider::ClaudeCode, &cli);
    let error = run_auth_at(
      command,
      Provider::ClaudeCode,
      Duration::from_millis(100),
      Duration::from_millis(500),
    )
    .unwrap_err();
    assert_eq!(error.code, "auth_timeout");
    std::thread::sleep(Duration::from_millis(1200));
    assert!(!marker.exists(), "a child process outlived the authentication timeout");
    let _ = fs::remove_file(marker);
    let _ = fs::remove_dir_all(cli.parent().unwrap());
  }

  #[test]
  fn updater_passes_only_the_fixed_update_argument() {
    let cli = fake_cli("claude", "printf '%s' \"$*\"");
    let command = provider_command(&runtime(), Provider::ClaudeCode, &cli, &["update".to_string()], &[]);
    let output = run_update_at(command, Duration::from_secs(2)).unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "update");
    let _ = fs::remove_dir_all(cli.parent().unwrap());
  }

  #[test]
  fn updater_reports_non_zero_output_without_running_a_shell_command_from_the_screen() {
    let cli = fake_cli("claude", "echo 'update failed' >&2\nexit 7");
    let command = provider_command(&runtime(), Provider::ClaudeCode, &cli, &["update".to_string()], &[]);
    let output = run_update_at(command, Duration::from_secs(2)).unwrap();
    assert_eq!(output.status.code(), Some(7));
    assert_eq!(command_output_details(&output).as_deref(), Some("update failed"));
    let _ = fs::remove_dir_all(cli.parent().unwrap());
  }

  #[test]
  fn one_maintenance_action_runs_at_a_time_and_drop_releases_it() {
    let state = AtomicU8::new(IDLE);
    let update = acquire_at(&state, MaintenanceKind::Update).unwrap();
    assert_eq!(
      acquire_at(&state, MaintenanceKind::Auth).unwrap_err().code,
      "update_in_progress"
    );
    drop(update);

    let auth = acquire_at(&state, MaintenanceKind::Auth).unwrap();
    assert_eq!(
      acquire_at(&state, MaintenanceKind::Update).unwrap_err().code,
      "auth_in_progress"
    );
    drop(auth);

    let install = acquire_at(&state, MaintenanceKind::Install).unwrap();
    assert_eq!(
      acquire_at(&state, MaintenanceKind::Auth).unwrap_err().code,
      "install_in_progress"
    );
    drop(install);
    assert_eq!(state.load(Ordering::SeqCst), IDLE);
  }
}
