//! 秘密の値（接続 refresh token・pending の JSON・ID token・custom token）と、その置き場。
//!
//! 置き場（spec D-16 改・2026-10-17）: Developer ID 署名が入るまで（2027 年の予定）は **app data のファイル**
//! （[`FileSecretStore`]。`data_dir/account-secrets/`・ディレクトリ 0700・ファイル 0600・原子的な書き換え）。Tauri の層はこれを使う。
//! ad-hoc 署名ではビルドごとに designated requirement（`cdhash`）が変わり、Keychain の項目が版の更新ごとに確認を求めるため。
//! 旧版が Keychain に置いた項目は読まない（読むと確認が出る。旧版でログインしていた人は 1 回ログインし直す）。
//!
//! Keychain の generic password の呼び出しは apps/docs の `secrets.rs`（API キー用）と同じ crate・同じ呼び出しで、ここでは
//! service / account を引数に取る**共通の adapter**（[`keychain`]）と [`KeychainStore`] として残す（署名の後に戻すため。
//! いまは Tauri の層から使わない）。この crate の [`AccountSecretStore`] は refresh token と pending の 2 種だけの小さな口。

use crate::error::AccountError;
use std::fmt;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// 秘密の文字列。`Debug` でも中身を出さない。ログ・エラーの文に入れない。
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
  pub fn new(value: impl Into<String>) -> Secret {
    Secret(value.into())
  }

  /// 中身（API の body・Keychain への書き込みにだけ使う）。
  pub fn expose(&self) -> &str {
    &self.0
  }
}

impl fmt::Debug for Secret {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("Secret(…)")
  }
}

/// この crate が保存する secret の種類。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SecretKind {
  /// 接続 refresh token（`exchange` の返り。`refresh` のたびに取り替わる）
  RefreshToken,
  /// pending（`{ verifier, state, client, startedAtMs }` の JSON。10 分）
  Pending,
}

impl SecretKind {
  /// 保存の名前（spec: `refresh-token` / `pending`）。[`FileSecretStore`] のファイル名と Keychain の account 名を兼ねる。
  pub fn account(self) -> &'static str {
    match self {
      SecretKind::RefreshToken => "refresh-token",
      SecretKind::Pending => "pending",
    }
  }
}

pub trait AccountSecretStore: Send + Sync {
  fn get(&self, kind: SecretKind) -> Result<Option<Secret>, AccountError>;
  fn set(&self, kind: SecretKind, secret: &Secret) -> Result<(), AccountError>;
  /// 無ければ何もしない。
  fn delete(&self, kind: SecretKind) -> Result<(), AccountError>;
}

/// macOS Keychain の generic password の共通の adapter（service と account を指定して読む・書く・消す）。
/// macOS 以外では失敗を返す（この crate のアプリは Mac だけ）。
pub mod keychain {
  /// Keychain の失敗（中身・鍵は入らない）。
  #[derive(Clone, Copy, Debug, PartialEq, Eq)]
  pub enum KeychainError {
    ReadFailed,
    WriteFailed,
    DeleteFailed,
  }

  #[cfg(target_os = "macos")]
  mod imp {
    use super::KeychainError;
    use security_framework::base::Error;
    use security_framework::passwords::{
      delete_generic_password, generic_password, set_generic_password, PasswordOptions,
    };

    /// errSecItemNotFound
    const NOT_FOUND: i32 = -25300;

    fn missing(error: &Error) -> bool {
      error.code() == NOT_FOUND
    }

    pub fn read(service: &str, account: &str) -> Result<Option<Vec<u8>>, KeychainError> {
      match generic_password(PasswordOptions::new_generic_password(service, account)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if missing(&error) => Ok(None),
        Err(_) => Err(KeychainError::ReadFailed),
      }
    }

    pub fn write(service: &str, account: &str, value: &[u8]) -> Result<(), KeychainError> {
      set_generic_password(service, account, value).map_err(|_| KeychainError::WriteFailed)
    }

    pub fn delete(service: &str, account: &str) -> Result<(), KeychainError> {
      match delete_generic_password(service, account) {
        Ok(()) => Ok(()),
        Err(error) if missing(&error) => Ok(()),
        Err(_) => Err(KeychainError::DeleteFailed),
      }
    }
  }

  #[cfg(not(target_os = "macos"))]
  mod imp {
    use super::KeychainError;

    pub fn read(_service: &str, _account: &str) -> Result<Option<Vec<u8>>, KeychainError> {
      Err(KeychainError::ReadFailed)
    }
    pub fn write(_service: &str, _account: &str, _value: &[u8]) -> Result<(), KeychainError> {
      Err(KeychainError::WriteFailed)
    }
    pub fn delete(_service: &str, _account: &str) -> Result<(), KeychainError> {
      Err(KeychainError::DeleteFailed)
    }
  }

  /// generic password を読む。無ければ `Ok(None)`。
  pub fn read(service: &str, account: &str) -> Result<Option<Vec<u8>>, KeychainError> {
    imp::read(service, account)
  }

  /// generic password を書く（あれば上書き）。
  pub fn write(service: &str, account: &str, value: &[u8]) -> Result<(), KeychainError> {
    imp::write(service, account, value)
  }

  /// generic password を消す。無ければ何もしない。
  pub fn delete(service: &str, account: &str) -> Result<(), KeychainError> {
    imp::delete(service, account)
  }
}

/// macOS Keychain に置く [`AccountSecretStore`]（service は [`crate::ClientId::keychain_service`]: `life.niho.<app>.account`）。
/// Developer ID 署名の後に戻すために残す。いまは Tauri の層から使わない（spec D-16 改。保存先は [`FileSecretStore`]）。
pub struct KeychainStore {
  service: String,
}

impl KeychainStore {
  pub fn new(service: &str) -> KeychainStore {
    KeychainStore {
      service: service.to_string(),
    }
  }

  pub fn for_client(client: crate::ClientId) -> KeychainStore {
    KeychainStore::new(&client.keychain_service())
  }

  pub fn service(&self) -> &str {
    &self.service
  }
}

impl AccountSecretStore for KeychainStore {
  fn get(&self, kind: SecretKind) -> Result<Option<Secret>, AccountError> {
    match keychain::read(&self.service, kind.account()) {
      Ok(Some(bytes)) => String::from_utf8(bytes)
        .map(|value| Some(Secret::new(value)))
        .map_err(|_| AccountError::keychain_read_failed()),
      Ok(None) => Ok(None),
      Err(_) => Err(AccountError::keychain_read_failed()),
    }
  }

  fn set(&self, kind: SecretKind, secret: &Secret) -> Result<(), AccountError> {
    keychain::write(&self.service, kind.account(), secret.expose().as_bytes())
      .map_err(|_| AccountError::keychain_write_failed())
  }

  fn delete(&self, kind: SecretKind) -> Result<(), AccountError> {
    keychain::delete(&self.service, kind.account()).map_err(|_| AccountError::keychain_delete_failed())
  }
}

/// [`FileSecretStore`] のディレクトリ名（`data_dir/account-secrets/`）。
pub const SECRETS_DIR: &str = "account-secrets";

/// 同じプロセスの中で一時ファイルの名前がぶつからないようにする通し番号。
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// app data のファイルに置く [`AccountSecretStore`]（spec D-16 改）。
///
/// - 置き場は `dir`（Tauri の層では `data_dir/account-secrets/`）。ディレクトリは 0700、ファイル（`refresh-token` / `pending`）は 0600。
/// - 書き込みは同じディレクトリの一時ファイル（0600）に書いて fsync してから rename する（途中で落ちても、古い値か新しい値の
///   どちらかが残る。書きかけは残らない）。rename のあとディレクトリも fsync する（best effort）。
/// - 無ければ `Ok(None)`、delete は冪等。失敗の文に値・パスは入れない。
pub struct FileSecretStore {
  dir: PathBuf,
}

impl FileSecretStore {
  pub fn new(dir: impl Into<PathBuf>) -> FileSecretStore {
    FileSecretStore { dir: dir.into() }
  }

  /// `data_dir/account-secrets/` に置く。
  pub fn in_data_dir(data_dir: &Path) -> FileSecretStore {
    FileSecretStore::new(data_dir.join(SECRETS_DIR))
  }

  pub fn dir(&self) -> &Path {
    &self.dir
  }

  pub fn path(&self, kind: SecretKind) -> PathBuf {
    self.dir.join(kind.account())
  }

  /// ディレクトリを 0700 で作る（既にあれば 0700 に直す）。
  fn ensure_dir(&self) -> io::Result<()> {
    #[cfg(unix)]
    {
      use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
      if !self.dir.is_dir() {
        fs::DirBuilder::new().recursive(true).mode(0o700).create(&self.dir)?;
      }
      let permissions = fs::metadata(&self.dir)?.permissions();
      if permissions.mode() & 0o777 != 0o700 {
        fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o700))?;
      }
      Ok(())
    }
    #[cfg(not(unix))]
    {
      fs::create_dir_all(&self.dir)
    }
  }

  fn write_atomic(&self, kind: SecretKind, bytes: &[u8]) -> io::Result<()> {
    self.ensure_dir()?;
    let tmp = self.dir.join(format!(
      ".{}.tmp-{}-{}",
      kind.account(),
      std::process::id(),
      TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| {
      let mut options = fs::OpenOptions::new();
      options.write(true).create_new(true);
      #[cfg(unix)]
      {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
      }
      let mut file = options.open(&tmp)?;
      file.write_all(bytes)?;
      file.sync_all()?;
      drop(file);
      fs::rename(&tmp, self.path(kind))
    })();
    if written.is_err() {
      let _ = fs::remove_file(&tmp);
      return written;
    }
    // rename をディスクに残す（失敗しても値は書けている）
    if let Ok(dir) = fs::File::open(&self.dir) {
      let _ = dir.sync_all();
    }
    Ok(())
  }
}

impl AccountSecretStore for FileSecretStore {
  fn get(&self, kind: SecretKind) -> Result<Option<Secret>, AccountError> {
    match fs::read(self.path(kind)) {
      Ok(bytes) if bytes.is_empty() => Ok(None),
      Ok(bytes) => String::from_utf8(bytes)
        .map(|value| Some(Secret::new(value)))
        .map_err(|_| AccountError::keychain_read_failed()),
      Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
      Err(_) => Err(AccountError::keychain_read_failed()),
    }
  }

  fn set(&self, kind: SecretKind, secret: &Secret) -> Result<(), AccountError> {
    self
      .write_atomic(kind, secret.expose().as_bytes())
      .map_err(|_| AccountError::keychain_write_failed())
  }

  fn delete(&self, kind: SecretKind) -> Result<(), AccountError> {
    match fs::remove_file(self.path(kind)) {
      Ok(()) => Ok(()),
      Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
      Err(_) => Err(AccountError::keychain_delete_failed()),
    }
  }
}

#[cfg(test)]
#[path = "secret_tests.rs"]
mod secret_tests;
