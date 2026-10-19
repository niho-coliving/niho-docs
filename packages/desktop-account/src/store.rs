//! この Mac に保存するプロフィール（`data_dir/account.json`）と顔写真（`data_dir/account-avatar.<ext>`）。起動時に Keychain に
//! 触らず画面を出せるように、名前・handle・connectionId・userId・顔写真のファイル名はここに置く。token は置かない。

use crate::error::AccountError;
use crate::service::{ExpiredReason, Profile};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const ACCOUNT_FILE: &str = "account.json";
pub const AVATAR_FILE_STEM: &str = "account-avatar";
/// 顔写真の上限（spec: 512 KB まで）。
pub const AVATAR_MAX_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredAccount {
  pub version: u32,
  pub user_id: String,
  pub display_name: String,
  pub handle: Option<String>,
  pub connection_id: String,
  /// 顔写真のファイル名（`account-avatar.jpg` など。`data_dir` の中）
  pub avatar_file: Option<String>,
  /// 「期限切れ」で終わったときの理由（次の起動でも「もう一度ログイン」を出す）
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub expired: Option<ExpiredReason>,
}

pub struct AccountStore {
  data_dir: PathBuf,
}

impl AccountStore {
  pub fn new(data_dir: PathBuf) -> AccountStore {
    AccountStore { data_dir }
  }

  pub fn data_dir(&self) -> &Path {
    &self.data_dir
  }

  fn account_path(&self) -> PathBuf {
    self.data_dir.join(ACCOUNT_FILE)
  }

  pub fn load(&self) -> Option<StoredAccount> {
    let text = fs::read_to_string(self.account_path()).ok()?;
    let stored: StoredAccount = serde_json::from_str(&text).ok()?;
    (stored.version == 1 && !stored.user_id.is_empty() && !stored.connection_id.is_empty()).then_some(stored)
  }

  pub fn save(&self, stored: &StoredAccount) -> Result<(), AccountError> {
    let bytes = serde_json::to_vec_pretty(stored).map_err(|_| AccountError::storage_failed())?;
    write_atomic(&self.account_path(), &bytes).map_err(|_| AccountError::storage_failed())
  }

  /// プロフィールと顔写真を消す（ログアウト・退会）。無ければ何もしない。
  pub fn clear(&self) -> Result<(), AccountError> {
    let avatar = self.load().and_then(|stored| stored.avatar_file);
    remove_if_exists(&self.account_path()).map_err(|_| AccountError::storage_failed())?;
    if let Some(file) = avatar {
      remove_if_exists(&self.data_dir.join(file)).map_err(|_| AccountError::storage_failed())?;
    }
    // 拡張子が変わって残った古い顔写真も消す
    for ext in AVATAR_EXTENSIONS {
      remove_if_exists(&self.data_dir.join(format!("{AVATAR_FILE_STEM}.{ext}")))
        .map_err(|_| AccountError::storage_failed())?;
    }
    Ok(())
  }

  /// 顔写真を書く（`content_type` から拡張子を決める。知らない形式なら `None` で何もしない）。古い拡張子のファイルは消す。
  pub fn save_avatar(&self, content_type: &str, bytes: &[u8]) -> Result<Option<String>, AccountError> {
    let Some(ext) = avatar_extension(content_type) else {
      return Ok(None);
    };
    if bytes.is_empty() || bytes.len() > AVATAR_MAX_BYTES {
      return Ok(None);
    }
    let file = format!("{AVATAR_FILE_STEM}.{ext}");
    write_atomic(&self.data_dir.join(&file), bytes).map_err(|_| AccountError::storage_failed())?;
    for other in AVATAR_EXTENSIONS.iter().filter(|other| **other != ext) {
      let _ = remove_if_exists(&self.data_dir.join(format!("{AVATAR_FILE_STEM}.{other}")));
    }
    Ok(Some(file))
  }

  /// 顔写真だけを消す（`/api/auth/me` で顔写真が無くなったとき）。
  pub fn clear_avatar(&self) -> Result<(), AccountError> {
    for ext in AVATAR_EXTENSIONS {
      remove_if_exists(&self.data_dir.join(format!("{AVATAR_FILE_STEM}.{ext}")))
        .map_err(|_| AccountError::storage_failed())?;
    }
    Ok(())
  }

  pub fn avatar_path(&self, stored: &StoredAccount) -> Option<PathBuf> {
    let file = stored.avatar_file.as_ref()?;
    let path = self.data_dir.join(file);
    path.is_file().then_some(path)
  }

  pub fn profile(&self, stored: &StoredAccount) -> Profile {
    Profile {
      user_id: stored.user_id.clone(),
      display_name: stored.display_name.clone(),
      handle: stored.handle.clone(),
      avatar_path: self.avatar_path(stored),
      connection_id: stored.connection_id.clone(),
    }
  }
}

pub const AVATAR_EXTENSIONS: [&str; 4] = ["jpg", "png", "webp", "gif"];

/// `Content-Type` → 拡張子（`asset:` で出すときに mime が決まる形式だけ）。
pub fn avatar_extension(content_type: &str) -> Option<&'static str> {
  let mime = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
  match mime.as_str() {
    "image/jpeg" | "image/jpg" => Some("jpg"),
    "image/png" => Some("png"),
    "image/webp" => Some("webp"),
    "image/gif" => Some("gif"),
    _ => None,
  }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)?;
  }
  let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
  {
    let mut file = fs::File::create(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
  }
  fs::rename(&tmp, path)
}

fn remove_if_exists(path: &Path) -> std::io::Result<()> {
  match fs::remove_file(path) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(error),
  }
}
