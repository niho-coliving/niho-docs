//! API キーの保存先（S2b #18383・#18769）。
//!
//! 本番は app data のファイル（`<data_dir>/api-keys/<account>`。account は `anthropic`／`openai`／`gemini`／`deepgram`。
//! ディレクトリ 0700・ファイル 0600・一時ファイルに書いて fsync してから rename）。配布物は ad-hoc 署名で、ビルドごとに
//! designated requirement（`cdhash`）が変わる。Keychain の項目は作ったビルドだけを信頼するので、版を上げるたびに確認
//! （ログインのパスワード）が出て、拒否すると読めない（#18769 で実測: 別の cdhash のビルドの読み取りは errSecAuthFailed、
//! 削除は errSecInvalidOwnerEdit。あるかどうかの確認だけは確認なしで通る）。Developer ID 署名（2027 年の予定）の後は Keychain に
//! 戻す（[`MigratingStore`] の向きを逆にする）。
//!
//! #18769 より前の版が Keychain（service `life.niho.docs.api-key`）に置いた鍵は、[`MigratingStore`] が鍵ごとに 1 回だけ読んで
//! ファイルへ移す（そのとき 1 回だけ確認が出る）。拒否・失敗なら [`REENTER`]（入れ直しの案内）を返し、以後その鍵の Keychain は
//! 見ない（記録は `<data_dir>/api-keys/legacy.json`）。Keychain の項目は消さない（新しいビルドからは消せない）。
//!
//! 鍵は画面へ返さない（返すのは保存済みか・末尾 4 文字だけ）。ログ・エラー文にも入れない。テストは同じ trait のメモリの
//! 保存先・一時ディレクトリのファイル・テスト用の service 名（`life.niho.docs.api-key.test`）の Keychain を使う。

use crate::process::set_mode;
use niho_api_ai::{Account, LogFn, Secret};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// app data の下の鍵の置き場。
pub const API_KEYS_DIR: &str = "api-keys";
/// Keychain から移した結果の記録（`api-keys/` の中。鍵は入れない）。
pub const LEGACY_RECORD: &str = "legacy.json";
/// #18769 より前の版の鍵の置き場（移すときに読むだけ。書かない・消さない）。
pub const LEGACY_KEYCHAIN_SERVICE: &str = "life.niho.docs.api-key";
/// 同じく開発・試験の起動の置き場（本番の鍵を読まない）。
pub const DEV_LEGACY_KEYCHAIN_SERVICE: &str = "life.niho.docs.dev.api-key";

/// 保存先の失敗（`message` は画面に出せる日本語。鍵は入れない）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretError {
  pub code: &'static str,
  pub message: &'static str,
}

/// 以前の版が Keychain に置いた鍵を読めなかった（確認を拒否した・読み取りの失敗）。入れ直すまで返す。
pub const REENTER: SecretError = SecretError {
  code: "api_key_reenter",
  message: "以前の版で保存した API キーを読めませんでした。設定 › 接続設定で API キーを入れ直してください。",
};

const READ_FAILED: SecretError = SecretError {
  code: "api_key_read_failed",
  message: "この Mac に保存した API キーを読めませんでした。もう一度お試しください。",
};
const WRITE_FAILED: SecretError = SecretError {
  code: "api_key_write_failed",
  message: "この Mac に API キーを保存できませんでした。もう一度お試しください。",
};
const DELETE_FAILED: SecretError = SecretError {
  code: "api_key_delete_failed",
  message: "この Mac から API キーを削除できませんでした。もう一度お試しください。",
};

const KEYCHAIN_READ_FAILED: SecretError = SecretError {
  code: "keychain_read_failed",
  message:
    "キーチェーンから API キーを読めませんでした。キーチェーンのアクセスを許可してから、もう一度お試しください。",
};
const KEYCHAIN_WRITE_FAILED: SecretError = SecretError {
  code: "keychain_write_failed",
  message:
    "キーチェーンに API キーを保存できませんでした。キーチェーンのアクセスを許可してから、もう一度お試しください。",
};
const KEYCHAIN_DELETE_FAILED: SecretError = SecretError {
  code: "keychain_delete_failed",
  message: "キーチェーンから API キーを削除できませんでした。もう一度お試しください。",
};

pub trait SecretStore: Send + Sync {
  fn get(&self, account: Account) -> Result<Option<Secret>, SecretError>;
  fn set(&self, account: Account, secret: &Secret) -> Result<(), SecretError>;
  /// 無ければ何もしない。
  fn delete(&self, account: Account) -> Result<(), SecretError>;
  /// 鍵があるか（中身は読まない。Keychain では確認を出さない）。
  fn exists(&self, account: Account) -> Result<bool, SecretError> {
    self.get(account).map(|secret| secret.is_some())
  }
}

/// アプリの保存先: app data のファイル。#18769 より前の版の Keychain の鍵は、初めて要るときに 1 回だけ移す。
pub fn app_store(data_dir: &Path, dev: bool, log: Option<LogFn>) -> MigratingStore {
  let dir = data_dir.join(API_KEYS_DIR);
  MigratingStore::new(
    Box::new(FileStore::new(&dir)),
    Box::new(KeychainStore::new(if dev {
      DEV_LEGACY_KEYCHAIN_SERVICE
    } else {
      LEGACY_KEYCHAIN_SERVICE
    })),
    // 旧いビルドの Keychain の項目は新しいビルドから消せない（errSecInvalidOwnerEdit）。試すと確認が出るおそれもある
    false,
    dir.join(LEGACY_RECORD),
  )
  .with_log(log)
}

// ---------------------------------------------------------------------------
// app data のファイル

/// 鍵ごとに 1 つのファイル（ディレクトリ 0700・ファイル 0600）。同じユーザーで動く別のプログラムからは読める
/// （NIHO Desktop の WebView に残る niho.life のログインや Safari の cookie と同じ守りの強さ。#18769 の引き換え）。
pub struct FileStore {
  dir: PathBuf,
}

impl FileStore {
  pub fn new(dir: &Path) -> Self {
    Self { dir: dir.to_path_buf() }
  }

  fn path(&self, account: Account) -> PathBuf {
    self.dir.join(account.as_str())
  }

  /// `write_private` が書く一時ファイル（`.<account>.tmp-<pid>-<n>`）のうち、この鍵の分で残っているもの。
  fn remove_temp_files(&self, account: Account) -> Result<(), SecretError> {
    let entries = match fs::read_dir(&self.dir) {
      Ok(entries) => entries,
      Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
      Err(_) => return Err(DELETE_FAILED),
    };
    let prefix = format!(".{}.tmp-", account.as_str());
    let mut failed = false;
    for entry in entries.flatten() {
      if !entry.file_name().to_str().is_some_and(|name| name.starts_with(&prefix)) {
        continue;
      }
      match fs::remove_file(entry.path()) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => failed = true,
      }
    }
    if failed {
      Err(DELETE_FAILED)
    } else {
      Ok(())
    }
  }
}

impl SecretStore for FileStore {
  fn get(&self, account: Account) -> Result<Option<Secret>, SecretError> {
    match fs::read(self.path(account)) {
      // 空のファイルは書かない（保存の前に形を確かめる）。あれば無いのと同じに扱う
      Ok(bytes) if bytes.is_empty() => Ok(None),
      Ok(bytes) => String::from_utf8(bytes)
        .map(|value| Some(Secret::new(value)))
        .map_err(|_| READ_FAILED),
      Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
      Err(_) => Err(READ_FAILED),
    }
  }

  fn set(&self, account: Account, secret: &Secret) -> Result<(), SecretError> {
    write_private(&self.dir, account.as_str(), secret.expose().as_bytes()).map_err(|_| WRITE_FAILED)
  }

  fn delete(&self, account: Account) -> Result<(), SecretError> {
    let removed = match fs::remove_file(self.path(account)) {
      Ok(()) => Ok(()),
      Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
      Err(_) => Err(DELETE_FAILED),
    };
    // 保存・上書きの途中で落ちて残った一時ファイルにも鍵が入っている。同じ鍵の分も消す（消せなければ削除は失敗）
    removed.and(self.remove_temp_files(account))
  }

  fn exists(&self, account: Account) -> Result<bool, SecretError> {
    match fs::metadata(self.path(account)) {
      Ok(meta) => Ok(meta.is_file() && meta.len() > 0),
      Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
      Err(_) => Err(READ_FAILED),
    }
  }
}

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// `dir/name` を 0600 で書き換える（一時ファイルに書いて fsync → rename。途中で落ちても前の中身か新しい中身のどちらかが残る）。
fn write_private(dir: &Path, name: &str, contents: &[u8]) -> std::io::Result<()> {
  fs::create_dir_all(dir)?;
  set_mode(dir, 0o700)?;
  let temp = dir.join(format!(
    ".{name}.tmp-{}-{}",
    std::process::id(),
    NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
  ));
  let written = (|| {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
      use std::os::unix::fs::OpenOptionsExt;
      options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    set_mode(&temp, 0o600)?;
    file.write_all(contents)?;
    file.sync_all()?;
    fs::rename(&temp, dir.join(name))?;
    // rename をディスクに確定させる（失敗しても書き換え自体は済んでいる）
    if let Ok(dir) = fs::File::open(dir) {
      let _ = dir.sync_all();
    }
    Ok(())
  })();
  if written.is_err() {
    let _ = fs::remove_file(&temp);
  }
  written
}

// ---------------------------------------------------------------------------
// 旧い置き場から 1 回だけ移す層

/// 旧い置き場の鍵の扱いの記録（鍵ごと）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum LegacyState {
  /// 旧い置き場に無かった。
  Absent,
  /// 旧い置き場から移した。
  Moved,
  /// 旧い置き場にあったが読めなかった（確認の拒否・失敗）。入れ直すまで [`REENTER`] を返す。
  Unreadable,
  /// 利用者が保存・削除した（旧い置き場はもう見ない）。
  Replaced,
}

type LegacyRecord = BTreeMap<String, LegacyState>;

/// 新しい置き場を正とし、旧い置き場の鍵を鍵ごとに 1 回だけ移す層。
///
/// - 読む: 新しい置き場にあればそれ。無ければ、まだ扱っていない鍵だけ旧い置き場を見る（あるかどうかを確認なしで確かめ、
///   あれば 1 回だけ読む）。読めたら新しい置き場へ書き、読めなければ [`REENTER`]。結果を記録し、以後その鍵の旧い置き場は
///   見ない（拒否された確認を何度も出さない・削除した鍵を戻さない）。記録はこの起動の間はメモリにも持つ（ファイルに書けなくても
///   同じ起動で 2 回目の確認を出さない）。
/// - 保存・削除: 新しい置き場だけ。記録を `replaced` にする。
/// - 今: 新しい = [`FileStore`]、旧い = Keychain（`remove_legacy: false`）。Developer ID 署名の後: 新しい = Keychain
///   （**新しい service 名**。旧い service の項目は ad-hoc のビルドの持ち物で、上書きも削除もできない）、旧い = [`FileStore`]
///   （`remove_legacy: true`。移したら平文のファイルを消す）、記録は別のファイル。
pub struct MigratingStore {
  current: Box<dyn SecretStore>,
  legacy: Box<dyn SecretStore>,
  remove_legacy: bool,
  record_path: PathBuf,
  /// None は未読込。移す処理と記録の読み書きはこの lock の中だけ（同じ鍵の確認を並べて出さない）。
  record: Mutex<Option<LegacyRecord>>,
  log: Option<LogFn>,
}

impl MigratingStore {
  pub fn new(
    current: Box<dyn SecretStore>,
    legacy: Box<dyn SecretStore>,
    remove_legacy: bool,
    record_path: PathBuf,
  ) -> Self {
    Self {
      current,
      legacy,
      remove_legacy,
      record_path,
      record: Mutex::new(None),
      log: None,
    }
  }

  pub fn with_log(mut self, log: Option<LogFn>) -> Self {
    self.log = log;
    self
  }

  fn log(&self, kind: &str, account: Account) {
    if let Some(log) = &self.log {
      log(kind, serde_json::json!({ "account": account.as_str() }));
    }
  }

  fn load(&self, slot: &mut Option<LegacyRecord>) -> LegacyRecord {
    slot
      .get_or_insert_with(|| {
        fs::read(&self.record_path)
          .ok()
          .and_then(|bytes| serde_json::from_slice(&bytes).ok())
          .unwrap_or_default()
      })
      .clone()
  }

  /// 記録を書く（lock の中で呼ぶ）。ファイルに書けなくてもメモリの記録は進める。
  fn mark(&self, slot: &mut Option<LegacyRecord>, account: Account, state: LegacyState) {
    if self.load(slot).get(account.as_str()) == Some(&state) {
      return;
    }
    self.persist(slot, account, state);
  }

  /// 記録を必ずファイルへ書く（lock の中で呼ぶ）。書けたら true。書けなくてもメモリの記録は進める。
  fn persist(&self, slot: &mut Option<LegacyRecord>, account: Account, state: LegacyState) -> bool {
    let mut record = self.load(slot);
    record.insert(account.as_str().to_string(), state);
    let written = match (self.record_path.parent(), self.record_path.file_name()) {
      (Some(dir), Some(name)) => serde_json::to_vec_pretty(&record)
        .map_err(std::io::Error::other)
        .and_then(|bytes| write_private(dir, &name.to_string_lossy(), &bytes)),
      _ => Err(std::io::Error::other("no record path")),
    };
    let persisted = written.is_ok();
    if !persisted {
      self.log("api_key_legacy_record_failed", account);
    }
    *slot = Some(record);
    persisted
  }

  /// 利用者が保存・削除した鍵の旧い置き場を、以後見ない印（`replaced`）をファイルへ書く。書けたら true。
  fn forget_legacy(&self, account: Account) -> Result<bool, SecretError> {
    let mut slot = self.record.lock().map_err(|_| WRITE_FAILED)?;
    Ok(self.persist(&mut slot, account, LegacyState::Replaced))
  }
}

impl SecretStore for MigratingStore {
  fn get(&self, account: Account) -> Result<Option<Secret>, SecretError> {
    if let Some(secret) = self.current.get(account)? {
      return Ok(Some(secret));
    }
    let mut slot = self.record.lock().map_err(|_| READ_FAILED)?;
    // 待っている間に別の呼び出しが移したかもしれない
    if let Some(secret) = self.current.get(account)? {
      return Ok(Some(secret));
    }
    match self.load(&mut slot).get(account.as_str()) {
      Some(LegacyState::Unreadable) => return Err(REENTER),
      Some(_) => return Ok(None),
      None => {}
    }
    match self.legacy.exists(account) {
      Ok(true) => {}
      Ok(false) => {
        self.mark(&mut slot, account, LegacyState::Absent);
        return Ok(None);
      }
      // 確かめられない（キーチェーンがロック中など）: 記録せず、次の呼び出しでもう一度
      Err(_) => return Ok(None),
    }
    // ここで 1 回だけ確認が出る（Keychain の項目を作ったビルドと署名が違うため）
    match self.legacy.get(account) {
      Ok(Some(secret)) => {
        // 書けなければ記録しない（この呼び出しでは使える。次の呼び出しでもう一度移す）
        if self.current.set(account, &secret).is_ok() {
          self.mark(&mut slot, account, LegacyState::Moved);
          self.log("api_key_legacy_moved", account);
          if self.remove_legacy {
            let _ = self.legacy.delete(account);
          }
        }
        Ok(Some(secret))
      }
      Ok(None) => {
        self.mark(&mut slot, account, LegacyState::Absent);
        Ok(None)
      }
      Err(_) => {
        self.mark(&mut slot, account, LegacyState::Unreadable);
        self.log("api_key_legacy_unreadable", account);
        Err(REENTER)
      }
    }
  }

  fn set(&self, account: Account, secret: &Secret) -> Result<(), SecretError> {
    self.current.set(account, secret)?;
    // 印を書けなくても、新しい置き場に鍵があるうちは旧い置き場を見ない（保存した鍵は戻らない・消えない）
    self.forget_legacy(account).map(|_| ())
  }

  fn delete(&self, account: Account) -> Result<(), SecretError> {
    // 先に「以後、旧い置き場を見ない」を確定する。確定できなければ消さずに断る。消してから断ると、再起動の後に旧い置き場の鍵が
    // 新しい置き場へ移り直って、削除した資格情報が戻る
    if !self.forget_legacy(account).map_err(|_| DELETE_FAILED)? {
      return Err(DELETE_FAILED);
    }
    self.current.delete(account)
  }
}

// ---------------------------------------------------------------------------
// macOS Keychain

/// macOS Keychain の generic password（今は #18769 より前の版の鍵を移すときに読むだけ。Developer ID 署名の後に戻す）。
pub struct KeychainStore {
  service: String,
}

impl KeychainStore {
  pub fn new(service: &str) -> Self {
    Self {
      service: service.to_string(),
    }
  }
}

#[cfg(target_os = "macos")]
mod keychain {
  use super::*;
  use security_framework::base::Error;
  use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
  use security_framework::passwords::{
    delete_generic_password, generic_password, set_generic_password, PasswordOptions,
  };

  /// errSecItemNotFound
  const NOT_FOUND: i32 = -25300;

  fn missing(error: &Error) -> bool {
    error.code() == NOT_FOUND
  }

  impl SecretStore for KeychainStore {
    fn get(&self, account: Account) -> Result<Option<Secret>, SecretError> {
      match generic_password(PasswordOptions::new_generic_password(&self.service, account.as_str())) {
        Ok(bytes) => String::from_utf8(bytes)
          .map(|value| Some(Secret::new(value)))
          .map_err(|_| KEYCHAIN_READ_FAILED),
        Err(error) if missing(&error) => Ok(None),
        Err(_) => Err(KEYCHAIN_READ_FAILED),
      }
    }

    fn set(&self, account: Account, secret: &Secret) -> Result<(), SecretError> {
      set_generic_password(&self.service, account.as_str(), secret.expose().as_bytes())
        .map_err(|_| KEYCHAIN_WRITE_FAILED)
    }

    fn delete(&self, account: Account) -> Result<(), SecretError> {
      match delete_generic_password(&self.service, account.as_str()) {
        Ok(()) => Ok(()),
        Err(error) if missing(&error) => Ok(()),
        Err(_) => Err(KEYCHAIN_DELETE_FAILED),
      }
    }

    /// 属性だけを探す（中身を読まないので、作ったビルドと署名が違っても確認は出ない。#18769 で実測）。
    fn exists(&self, account: Account) -> Result<bool, SecretError> {
      match ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(&self.service)
        .account(account.as_str())
        .load_attributes(true)
        .limit(Limit::Max(1))
        .search()
      {
        Ok(found) => Ok(!found.is_empty()),
        Err(error) if missing(&error) => Ok(false),
        Err(_) => Err(KEYCHAIN_READ_FAILED),
      }
    }
  }
}

#[cfg(not(target_os = "macos"))]
impl SecretStore for KeychainStore {
  fn get(&self, _account: Account) -> Result<Option<Secret>, SecretError> {
    Err(KEYCHAIN_READ_FAILED)
  }
  fn set(&self, _account: Account, _secret: &Secret) -> Result<(), SecretError> {
    Err(KEYCHAIN_WRITE_FAILED)
  }
  fn delete(&self, _account: Account) -> Result<(), SecretError> {
    Err(KEYCHAIN_DELETE_FAILED)
  }
  fn exists(&self, _account: Account) -> Result<bool, SecretError> {
    Ok(false)
  }
}

// ---------------------------------------------------------------------------
// テスト

/// メモリの保存先（テスト用）。
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
  secrets: Mutex<BTreeMap<Account, Secret>>,
}

#[cfg(test)]
impl SecretStore for MemoryStore {
  fn get(&self, account: Account) -> Result<Option<Secret>, SecretError> {
    Ok(self.secrets.lock().map_err(|_| READ_FAILED)?.get(&account).cloned())
  }

  fn set(&self, account: Account, secret: &Secret) -> Result<(), SecretError> {
    self
      .secrets
      .lock()
      .map_err(|_| WRITE_FAILED)?
      .insert(account, secret.clone());
    Ok(())
  }

  fn delete(&self, account: Account) -> Result<(), SecretError> {
    self.secrets.lock().map_err(|_| DELETE_FAILED)?.remove(&account);
    Ok(())
  }
}

#[cfg(test)]
#[path = "secrets_tests.rs"]
mod tests;
