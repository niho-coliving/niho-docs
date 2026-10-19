//! 子プロセス（niho-speech）の起動の決まり（NIHO Desktop の article_agent.rs と同じ）。AI の CLI は crate（niho-local-ai）が起動する。
//!
//! - 親の環境を丸ごと渡さず、非秘密の値だけを allowlist で引き継ぐ（`GH_TOKEN`・`DATABASE_URL` などを漏らさない）。
//! - 自分のプロセスグループで起動し、停止・時間切れは SIGTERM → 猶予 → SIGKILL でグループごと止める。

use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// niho-speech に引き継ぐ非秘密の環境（Desktop と crate の CHILD_ENV_ALLOWLIST と同じ）。
pub const CHILD_ENV_ALLOWLIST: [&str; 21] = [
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

/// Finder から起動したアプリの PATH には Homebrew・~/.local/bin が無いので足す（Desktop の macos_gui_path_var と同じ）。
pub fn gui_path_var() -> String {
  let mut segments = vec![
    "/opt/homebrew/bin".to_string(),
    "/usr/local/bin".to_string(),
    "/usr/bin".to_string(),
    "/bin".to_string(),
  ];
  if let Ok(home) = env::var("HOME") {
    segments.push(format!("{home}/.local/bin"));
    segments.push(format!("{home}/.npm-global/bin"));
  }
  if let Ok(existing) = env::var("PATH") {
    segments.push(existing);
  }
  segments.join(":")
}

/// allowlist で環境を組み直したコマンド。標準入出力はすべて pipe、自分のプロセスグループで起動する。
pub fn child_command(program: &Path, args: &[String], workdir: Option<&Path>) -> Command {
  let mut command = Command::new(program);
  command.env_clear().env("PATH", gui_path_var());
  for key in CHILD_ENV_ALLOWLIST {
    if let Some(value) = env::var_os(key) {
      command.env(key, value);
    }
  }
  command
    .args(args)
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
  if let Some(dir) = workdir {
    command.current_dir(dir);
  }
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
  }
  command
}

/// プロセスグループ全体へシグナルを送る（`process_group(0)` で起動しているので pgid = pid）。
pub fn signal_group(pid: u32, signal: i32) {
  #[cfg(unix)]
  unsafe {
    libc::killpg(pid as libc::pid_t, signal);
  }
  #[cfg(not(unix))]
  {
    let _ = (pid, signal);
  }
}

#[cfg(unix)]
pub const SIGTERM: i32 = libc::SIGTERM;
#[cfg(unix)]
pub const SIGKILL: i32 = libc::SIGKILL;
#[cfg(not(unix))]
pub const SIGTERM: i32 = 15;
#[cfg(not(unix))]
pub const SIGKILL: i32 = 9;

#[cfg(unix)]
pub fn is_executable(path: &Path) -> bool {
  use std::os::unix::fs::PermissionsExt;
  path
    .metadata()
    .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    .unwrap_or(false)
}

#[cfg(not(unix))]
pub fn is_executable(path: &Path) -> bool {
  path.is_file()
}

/// 環境変数で指定された実行ファイル（開発・テスト用の差し替え）。実行できなければ None。
pub fn executable_from_env(var: &str) -> Option<PathBuf> {
  let value = env::var(var).ok()?;
  let path = PathBuf::from(value.trim());
  is_executable(&path).then_some(path)
}

pub fn random_bytes<const N: usize>() -> std::io::Result<[u8; N]> {
  let mut bytes = [0u8; N];
  fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
  Ok(bytes)
}

pub fn hex(bytes: &[u8]) -> String {
  bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(unix)]
pub(crate) fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
  use std::os::unix::fs::PermissionsExt;
  fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
pub(crate) fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
  Ok(())
}

/// 使い終わったら消える一時フォルダ（0700）。中のファイルは 0600 で書く。
pub struct PrivateTempDir {
  path: PathBuf,
}

impl PrivateTempDir {
  pub fn create(prefix: &str) -> std::io::Result<Self> {
    let path = env::temp_dir().join(format!("{prefix}-{}", hex(&random_bytes::<8>()?)));
    fs::create_dir_all(&path)?;
    set_mode(&path, 0o700)?;
    Ok(Self { path })
  }

  pub fn path(&self) -> &Path {
    &self.path
  }

  /// 0600 のファイルを書く（中身はログに出さない）。
  pub fn write_private(&self, name: &str, contents: &[u8]) -> std::io::Result<PathBuf> {
    let path = self.path.join(name);
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
    set_mode(&path, 0o600)?;
    file.write_all(contents)?;
    file.flush()?;
    Ok(path)
  }
}

impl Drop for PrivateTempDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.path);
  }
}

/// stderr の末尾だけを残す（全部読み切らないと子が書き込みで止まる）。
pub fn read_tail(mut pipe: impl Read, max_bytes: usize) -> String {
  let mut tail: Vec<u8> = Vec::new();
  let mut chunk = [0u8; 8192];
  loop {
    match pipe.read(&mut chunk) {
      Ok(0) | Err(_) => break,
      Ok(read) => {
        tail.extend_from_slice(&chunk[..read]);
        if tail.len() > max_bytes * 2 {
          tail.drain(..tail.len() - max_bytes);
        }
      }
    }
  }
  String::from_utf8_lossy(&tail).into_owned()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn private_temp_dir_is_removed_on_drop() {
    let dir = PrivateTempDir::create("niho-docs-test").unwrap();
    let file = dir.write_private("a.txt", b"x").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
      assert_eq!(fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777, 0o700);
    }
    let path = dir.path().to_path_buf();
    drop(dir);
    assert!(!path.exists());
  }

  #[test]
  fn child_command_uses_the_env_allowlist() {
    let command = child_command(Path::new("/bin/echo"), &[], None);
    let keys: Vec<String> = command
      .get_envs()
      .map(|(key, _)| key.to_string_lossy().into_owned())
      .collect();
    assert!(keys.contains(&"PATH".to_string()));
    for key in &keys {
      assert!(key == "PATH" || CHILD_ENV_ALLOWLIST.contains(&key.as_str()), "{key}");
    }
  }
}
