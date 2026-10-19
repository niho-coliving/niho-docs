//! 実行環境（CLI の場所・一時ファイルの置き場・停止の猶予・ログ）と、子プロセスの起動コマンドの組み立て。

use crate::process::run_capture;
use crate::types::Provider;
use serde_json::Value;
use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

/// 診断ログ（kind, payload）。指示文・システムプロンプト・本文は渡さない。
pub type LogFn = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// SIGTERM から SIGKILL までの既定の猶予。
pub(crate) const DEFAULT_KILL_GRACE: Duration = Duration::from_secs(3);
/// ログインシェルで CLI を探すときの上限（利用者の .zprofile が止まっても待ち続けない）。
const LOGIN_SHELL_LOOKUP_TIME_LIMIT: Duration = Duration::from_secs(5);

/// 親の環境を丸ごと渡さず、実行に必要な非秘密の環境だけを明示的に引き継ぐ（Desktop の記事エージェントと同じ 21 個）。
/// ANTHROPIC_API_KEY・OPENAI_API_KEY・GEMINI_API_KEY など課金先を変えうる変数や、GH_TOKEN などの秘密はここに無いので渡らない。
pub(crate) const CHILD_ENV_ALLOWLIST: [&str; 21] = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "TERM",
  "TERM_PROGRAM",
  "COLORTERM",
  "NO_COLOR",
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

/// その CLI にだけ足す、利用者の環境の変数。設定の置き場を変えている人のログインを見つけるため。
/// agy は allowlist だけで動く（GEMINI_API_KEY は渡さない。渡すと API の従量課金になる）。
/// codex は `Runtime.codex_home` があればそちらで上書きする（[`provider_command`]）。
pub(crate) fn provider_env_keys(provider: Provider) -> &'static [&'static str] {
  match provider {
    Provider::ClaudeCode | Provider::GeminiCli => &[],
    Provider::CodexCli => &["CODEX_HOME"],
  }
}

/// Claude Code の公式インストーラの取り方（テストでは偽の curl と shell に差し替える）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallerConfig {
  pub curl: PathBuf,
  pub shell: PathBuf,
  pub url: String,
}

impl Default for InstallerConfig {
  fn default() -> Self {
    Self {
      curl: PathBuf::from("/usr/bin/curl"),
      shell: PathBuf::from("/bin/bash"),
      url: "https://claude.ai/install.sh".to_string(),
    }
  }
}

/// 実行環境。既定のままで本物の CLI を探して動かす。テスト・診断では CLI の場所や置き場を差し替える。
#[derive(Clone)]
pub struct Runtime {
  /// 上書き（テスト・診断用）。指定があればそこだけを見る。無ければ探す
  pub cli_paths: BTreeMap<Provider, PathBuf>,
  /// 0600 の一時ファイルの置き場（既定 std::env::temp_dir()/niho-local-ai。0700 にする）
  pub scratch_dir: PathBuf,
  /// CLI の候補・子プロセスの PATH に使う HOME（None なら環境変数 HOME）
  pub home_dir: Option<PathBuf>,
  /// 止めるときの SIGTERM → SIGKILL の猶予
  pub kill_grace: Duration,
  pub claude_installer: InstallerConfig,
  /// 診断ログ（指示文・本文は絶対に渡さない）
  pub log: Option<LogFn>,
  /// Codex CLI の置き場（`CODEX_HOME`。設定・ログイン・会話の記録）。None なら利用者の環境のまま（~/.codex か環境変数）。
  /// 利用者の ~/.codex/AGENTS.md は外す設定が無く工程の指示に混ざるので、NIHO docs は app data の下の専用の置き場を渡す
  /// （ログインもこのアプリ用になる。#18383）。無ければ 0700 で作る
  pub codex_home: Option<PathBuf>,
}

impl Default for Runtime {
  fn default() -> Self {
    Self {
      cli_paths: BTreeMap::new(),
      scratch_dir: env::temp_dir().join("niho-local-ai"),
      home_dir: None,
      kill_grace: DEFAULT_KILL_GRACE,
      claude_installer: InstallerConfig::default(),
      log: None,
      codex_home: None,
    }
  }
}

impl Runtime {
  pub(crate) fn home(&self) -> Option<PathBuf> {
    self
      .home_dir
      .clone()
      .or_else(|| env::var_os("HOME").filter(|value| !value.is_empty()).map(PathBuf::from))
  }

  pub(crate) fn log(&self, kind: &str, payload: Value) {
    if let Some(log) = &self.log {
      log(kind, payload);
    }
  }
}

/// GUI アプリの PATH は最小限なので、CLI がよく入る場所を足す（Desktop の macos_gui_path_var と同じ並び）。
pub(crate) fn macos_gui_path_var(home: Option<&Path>) -> OsString {
  let mut segments: Vec<OsString> = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .iter()
    .map(OsString::from)
    .collect();
  if let Some(home) = home {
    segments.push(home.join(".local/bin").into_os_string());
    segments.push(home.join(".npm-global/bin").into_os_string());
  }
  if let Some(existing) = env::var_os("PATH").filter(|value| !value.is_empty()) {
    segments.push(existing);
  }
  join_path_segments(&segments)
}

/// 子プロセスの PATH。見つけた CLI のファイルの親フォルダ（シンボリックリンクは解かない）を先頭に置く。
/// codex は `#!/usr/bin/env node` なので、nvm などで CLI と同じフォルダに入れた node をここで見つけられる。
pub(crate) fn child_path_var(program: &Path, home: Option<&Path>) -> OsString {
  let base = macos_gui_path_var(home);
  match program.parent().filter(|parent| !parent.as_os_str().is_empty()) {
    Some(parent) => join_path_segments(&[parent.as_os_str().to_os_string(), base]),
    None => base,
  }
}

fn join_path_segments(segments: &[OsString]) -> OsString {
  let mut joined = OsString::new();
  for (index, segment) in segments.iter().enumerate() {
    if index > 0 {
      joined.push(":");
    }
    joined.push(segment);
  }
  joined
}

/// 子プロセスの起動コマンド（環境・引数・プロセスグループ）。標準入出力と cwd は呼び出し側で決める。
/// 親の環境を `env_clear` してから PATH → allowlist → その CLI の分 → 呼び出し側の値（`extra_env`）の順に足す。
pub(crate) fn build_child_command(
  program: &Path,
  args: &[String],
  home: Option<&Path>,
  extra_keys: &[&str],
  extra_env: &[(&str, OsString)],
) -> Command {
  let mut command = Command::new(program);
  command.env_clear().env("PATH", child_path_var(program, home));
  for key in CHILD_ENV_ALLOWLIST.iter().chain(extra_keys) {
    if let Some(value) = env::var_os(key) {
      command.env(key, value);
    }
  }
  for (key, value) in extra_env {
    command.env(key, value);
  }
  command.args(args);
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    // 停止・時間切れで子孫ごと止められるよう、自分のプロセスグループで起動する
    command.process_group(0);
  }
  command
}

/// その CLI 用の起動コマンド（`--version`・`auth status`・ログイン・本番の実行で共通）。
/// codex は `Runtime.codex_home` があれば、どの呼び出しも `CODEX_HOME` をそこにする（無ければ 0700 で作る。作れなくても
/// 起動はして、CLI の失敗として返す）。
pub(crate) fn provider_command(
  runtime: &Runtime,
  provider: Provider,
  cli: &Path,
  args: &[String],
  extra_env: &[(&str, OsString)],
) -> Command {
  let home = runtime.home();
  let mut env: Vec<(&str, OsString)> = extra_env.to_vec();
  if let (Provider::CodexCli, Some(codex_home)) = (provider, runtime.codex_home.as_ref()) {
    let _ = crate::process::ensure_private_dir(codex_home);
    env.push(("CODEX_HOME", codex_home.clone().into_os_string()));
  }
  build_child_command(cli, args, home.as_deref(), provider_env_keys(provider), &env)
}

#[cfg(unix)]
pub(crate) fn is_executable(path: &Path) -> bool {
  use std::os::unix::fs::PermissionsExt;
  path
    .metadata()
    .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    .unwrap_or(false)
}

#[cfg(not(unix))]
pub(crate) fn is_executable(path: &Path) -> bool {
  path.is_file()
}

/// CLI の場所。`Runtime.cli_paths` に指定があればそこだけを見る（テスト・診断で本物の CLI を拾わないため）。
/// 無ければ Desktop の resolve_claude_binary と同じ順で探す: curl のインストール先（~/.local/bin）→ npm の global →
/// Homebrew → /usr/local/bin → ログインシェルの `command -v`。実行できないファイル（失敗したインストールの残り）は飛ばす。
pub(crate) fn resolve_cli(runtime: &Runtime, provider: Provider) -> Option<PathBuf> {
  if let Some(path) = runtime.cli_paths.get(&provider) {
    return is_executable(path).then(|| path.clone());
  }
  let name = provider.cli_name();
  let mut candidates = Vec::new();
  if let Some(home) = runtime.home() {
    candidates.push(home.join(".local/bin").join(name));
    candidates.push(home.join(".npm-global/bin").join(name));
  }
  candidates.push(Path::new("/opt/homebrew/bin").join(name));
  candidates.push(Path::new("/usr/local/bin").join(name));
  if let Some(found) = candidates.into_iter().find(|candidate| is_executable(candidate)) {
    return Some(found);
  }
  login_shell_lookup(name, runtime.home().as_deref())
}

fn login_shell_command(name: &str, home: Option<&Path>) -> Command {
  let args = ["-l", "-c", &format!("command -v {name}")].map(str::to_string);
  build_child_command(Path::new("/bin/zsh"), &args, home, &[], &[])
}

fn login_shell_lookup(name: &str, home: Option<&Path>) -> Option<PathBuf> {
  let command = login_shell_command(name, home);
  let output = run_capture(
    command,
    LOGIN_SHELL_LOOKUP_TIME_LIMIT,
    Duration::from_millis(500),
    16 * 1024,
  )
  .ok()?;
  if !output.status.success() {
    return None;
  }
  // .zprofile が何か表示しても拾わないよう、最後の絶対パスの行だけを見る（alias・関数の定義は飛ばす）
  String::from_utf8_lossy(&output.stdout)
    .lines()
    .rev()
    .map(str::trim)
    .find(|line| line.starts_with('/'))
    .map(PathBuf::from)
    .filter(|path| is_executable(path))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::BTreeSet;

  #[test]
  fn child_command_only_carries_allowlisted_environment() {
    // 環境変数は書き換えない。組み立てた Command に載るキーが「allowlist ∪ PATH ∪ その CLI の分」に収まることだけを見る
    let extra_env = [("NIHO_LOCAL_AI_EXAMPLE_PATH", OsString::from("/tmp/x/file"))];
    // agy は allowlist だけで動く（GEMINI_CLI_HOME などは足さない）
    assert!(provider_env_keys(Provider::GeminiCli).is_empty());
    for provider in Provider::ALL {
      let extra: &[(&str, OsString)] = &extra_env;
      let command = build_child_command(
        Path::new("/opt/example/bin/cli"),
        &["--version".to_string()],
        Some(Path::new("/Users/example")),
        provider_env_keys(provider),
        extra,
      );
      let mut allowed: BTreeSet<String> = CHILD_ENV_ALLOWLIST.iter().map(|key| key.to_string()).collect();
      allowed.insert("PATH".to_string());
      allowed.extend(provider_env_keys(provider).iter().map(|key| key.to_string()));
      allowed.extend(extra.iter().map(|(key, _)| key.to_string()));
      let keys: Vec<String> = command
        .get_envs()
        .map(|(key, _)| key.to_string_lossy().into_owned())
        .collect();
      for key in &keys {
        assert!(allowed.contains(key), "{provider:?} must not pass {key}");
      }
      assert!(keys.iter().any(|key| key == "PATH"));
      for (key, _) in extra {
        assert!(keys.iter().any(|value| value == key), "{key} is set for {provider:?}");
      }
      for secret in [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_CLI_HOME",
        "GH_TOKEN",
        "DATABASE_URL",
      ] {
        assert!(!keys.iter().any(|key| key == secret));
      }
    }
  }

  #[test]
  fn codex_home_is_set_for_every_codex_command_and_created_private() {
    let unique = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    let codex_home = env::temp_dir().join(format!("niho-local-ai-codex-home-{}-{unique}", std::process::id()));
    let runtime = Runtime {
      codex_home: Some(codex_home.join("codex-home")),
      ..Runtime::default()
    };
    let value_of = |command: &Command, key: &str| {
      command
        .get_envs()
        .find(|(name, _)| *name == key)
        .and_then(|(_, value)| value.map(|value| value.to_os_string()))
    };
    let codex = provider_command(&runtime, Provider::CodexCli, Path::new("/x/codex"), &[], &[]);
    assert_eq!(
      value_of(&codex, "CODEX_HOME"),
      Some(codex_home.join("codex-home").into_os_string())
    );
    assert!(codex_home.join("codex-home").is_dir());
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let mode = std::fs::metadata(codex_home.join("codex-home"))
        .unwrap()
        .permissions()
        .mode();
      assert_eq!(mode & 0o777, 0o700);
    }
    // ほかの CLI には渡さない
    let claude = provider_command(&runtime, Provider::ClaudeCode, Path::new("/x/claude"), &[], &[]);
    assert_eq!(value_of(&claude, "CODEX_HOME"), None);
    let _ = std::fs::remove_dir_all(codex_home);
  }

  #[test]
  fn child_path_starts_with_the_cli_folder_without_resolving_links() {
    let path = child_path_var(
      Path::new("/Users/example/.nvm/versions/node/v22/bin/codex"),
      Some(Path::new("/h")),
    );
    let path = path.to_string_lossy().into_owned();
    assert!(
      path.starts_with("/Users/example/.nvm/versions/node/v22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
    );
    assert!(path.contains(":/h/.local/bin:/h/.npm-global/bin"));
  }

  #[test]
  fn configured_cli_path_is_used_alone() {
    let runtime = Runtime {
      cli_paths: BTreeMap::from([(Provider::CodexCli, PathBuf::from("/nonexistent/niho-local-ai/codex"))]),
      home_dir: Some(PathBuf::from("/nonexistent/home")),
      ..Runtime::default()
    };
    // 指定が実行できなければ、ほかの場所（本物の CLI）を探さずに「無い」とする
    assert_eq!(resolve_cli(&runtime, Provider::CodexCli), None);
  }

  #[test]
  fn login_shell_lookup_uses_the_child_environment_allowlist() {
    let command = login_shell_command("codex", Some(Path::new("/Users/example")));
    let keys: Vec<String> = command
      .get_envs()
      .map(|(key, _)| key.to_string_lossy().into_owned())
      .collect();
    assert!(keys.iter().any(|key| key == "PATH"));
    for secret in [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "GH_TOKEN",
      "DATABASE_URL",
    ] {
      assert!(
        !keys.iter().any(|key| key == secret),
        "login shell must not receive {secret}"
      );
    }
  }

  #[test]
  fn default_runtime_uses_a_private_scratch_dir_and_three_second_grace() {
    let runtime = Runtime::default();
    assert_eq!(runtime.scratch_dir, env::temp_dir().join("niho-local-ai"));
    assert_eq!(runtime.kill_grace, Duration::from_secs(3));
    assert_eq!(runtime.claude_installer.curl, PathBuf::from("/usr/bin/curl"));
    assert_eq!(runtime.claude_installer.shell, PathBuf::from("/bin/bash"));
    assert_eq!(runtime.claude_installer.url, "https://claude.ai/install.sh");
    assert!(runtime.cli_paths.is_empty());
    assert_eq!(runtime.codex_home, None);
  }
}
