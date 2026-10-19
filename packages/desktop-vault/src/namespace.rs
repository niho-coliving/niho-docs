use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::scanner::{
    atomic_write, create_directories_without_symlinks, reject_symlinks_along, sync_directory,
};
use crate::state::{validate_project_id, ProjectPaths};
use crate::types::{Result, VaultError};

const ROOTS_FILE: &str = "vault/roots.json";

static ROOTS_LOCK: Mutex<()> = Mutex::new(());

/// SHA-256(environment + "\n" + user_id) の小文字 hex。environment は "prod" / "stg"。
pub fn account_key(environment: &str, user_id: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{environment}\n{user_id}").as_bytes())
    )
}

/// state・journal・outbox の置き場。本人ごと（`vault/<accountKey>/`）か、未ログインの保存先ごと（`vault/local/<rootId>/`）。
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Namespace {
    Account { account_key: String },
    Local { root_id: String },
}

impl Namespace {
    /// app_data/vault/<accountKey>/ または app_data/vault/local/<rootId>/。
    pub fn dir(&self, app_data: &Path) -> PathBuf {
        app_data.join(self.relative_dir())
    }

    pub fn account_key(&self) -> Option<&str> {
        match self {
            Self::Account { account_key } => Some(account_key),
            Self::Local { .. } => None,
        }
    }

    pub fn is_local(&self) -> bool {
        matches!(self, Self::Local { .. })
    }

    pub(crate) fn relative_dir(&self) -> String {
        match self {
            Self::Account { account_key } => format!("vault/{account_key}"),
            Self::Local { root_id } => format!("vault/local/{root_id}"),
        }
    }

    pub(crate) fn validate(&self) -> Result<()> {
        match self {
            Self::Account { account_key } => validate_account_key(account_key),
            Self::Local { root_id } => validate_root_id(root_id),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootBinding {
    pub root_id: String,
    pub path: PathBuf,
    pub account_key: Option<String>,
    /// account binding が変わるたび増える。古い通信応答の apply fence。
    #[serde(default = "initial_root_epoch")]
    pub epoch: u64,
}

fn initial_root_epoch() -> u64 {
    1
}

impl RootBinding {
    /// 本人に結び付いていれば Account、無ければ Local。
    pub fn namespace(&self) -> Namespace {
        match &self.account_key {
            Some(account_key) => Namespace::Account {
                account_key: account_key.clone(),
            },
            None => Namespace::Local {
                root_id: self.root_id.clone(),
            },
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RootsFile {
    schema_version: u8,
    #[serde(default)]
    roots: Vec<RootBinding>,
}

pub(crate) fn validate_account_key(value: &str) -> Result<()> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(VaultError::NamespaceMismatch("invalid accountKey".into()))
    }
}

pub(crate) fn validate_root_id(value: &str) -> Result<()> {
    let valid = value.strip_prefix("r_").is_some_and(|rest| {
        rest.len() == 22
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    });
    if valid {
        Ok(())
    } else {
        Err(VaultError::NamespaceMismatch("invalid rootId".into()))
    }
}

fn read_roots(app_data: &Path) -> Result<RootsFile> {
    let empty = RootsFile {
        schema_version: 1,
        roots: Vec::new(),
    };
    if fs::symlink_metadata(app_data).is_err() {
        return Ok(empty);
    }
    reject_symlinks_along(app_data, ROOTS_FILE)?;
    match fs::read(app_data.join(ROOTS_FILE)) {
        Ok(bytes) => {
            let file: RootsFile = serde_json::from_slice(&bytes)?;
            if file.schema_version != 1 {
                return Err(VaultError::InvalidResponse(
                    "unsupported roots.json schemaVersion".into(),
                ));
            }
            Ok(file)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(empty),
        Err(error) => Err(error.into()),
    }
}

fn write_roots(app_data: &Path, file: &RootsFile) -> Result<()> {
    atomic_write(app_data, ROOTS_FILE, &serde_json::to_vec_pretty(file)?)
}

/// 保存先 root の結び付け。canonical path で引き、無ければ新しい rootId で作る。
pub fn root_binding(app_data: &Path, root: &Path) -> Result<RootBinding> {
    let canonical = fs::canonicalize(root)?;
    let _lock = ROOTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut file = read_roots(app_data)?;
    if let Some(found) = file.roots.iter().find(|binding| binding.path == canonical) {
        return Ok(found.clone());
    }
    let binding = RootBinding {
        root_id: random_id("r_")?,
        path: canonical,
        account_key: None,
        epoch: initial_root_epoch(),
    };
    file.roots.push(binding.clone());
    write_roots(app_data, &file)?;
    Ok(binding)
}

/// rootId を本人（accountKey）に結び付ける。None で未ログインの local に戻す。
pub fn bind_root(app_data: &Path, root_id: &str, account_key: Option<&str>) -> Result<RootBinding> {
    validate_root_id(root_id)?;
    if let Some(account_key) = account_key {
        validate_account_key(account_key)?;
    }
    let _lock = ROOTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut file = read_roots(app_data)?;
    let binding = file
        .roots
        .iter_mut()
        .find(|binding| binding.root_id == root_id)
        .ok_or_else(|| VaultError::NamespaceMismatch(format!("unknown rootId: {root_id}")))?;
    let next_account_key = account_key.map(str::to_owned);
    if binding.account_key != next_account_key {
        binding.account_key = next_account_key;
        binding.epoch = binding.epoch.saturating_add(1);
    }
    let binding = binding.clone();
    write_roots(app_data, &file)?;
    Ok(binding)
}

/// CLOUD を閉じた root の app data を、削除せず epoch ごとの退避場所へ移す。
/// 案件ディレクトリ単位の rename なので落下後は残った案件から再開でき、旧 base/outbox/receipt/cursor を
/// 次の CLOUD baseline に混ぜない。working copy はこの関数では変更しない。
pub fn archive_account_root(
    app_data: &Path,
    account_key: &str,
    root_id: &str,
    storage_epoch: u64,
) -> Result<usize> {
    validate_account_key(account_key)?;
    validate_root_id(root_id)?;
    let _lock = ROOTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let roots = read_roots(app_data)?;
    let same_account_roots = roots
        .roots
        .iter()
        .filter(|binding| binding.account_key.as_deref() == Some(account_key))
        .count();
    let source_relative = format!("vault/{account_key}");
    reject_symlinks_along(app_data, &source_relative)?;
    let source_dir = app_data.join(&source_relative);
    let archive_relative = format!("vault/archive/{account_key}/{storage_epoch}/{root_id}");
    reject_symlinks_along(app_data, &archive_relative)?;
    let archive_dir = app_data.join(&archive_relative);
    let entries = match fs::read_dir(&source_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // rename の直後に落ちた再試行でも、移動済み directory の耐久化を確認する。
            if archive_dir.exists() {
                sync_directory(&archive_dir)?;
            }
            return Ok(0);
        }
        Err(error) => return Err(error.into()),
    };
    let mut moved = 0;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(project_id) = name.to_str() else {
            continue;
        };
        if validate_project_id(project_id).is_err() {
            continue;
        }
        let source = entry.path();
        let metadata = fs::symlink_metadata(&source)?;
        if metadata.file_type().is_symlink() {
            return Err(VaultError::Symlink(source.display().to_string()));
        }
        if !metadata.is_dir() {
            continue;
        }
        let paths = ProjectPaths::new(
            app_data,
            &Namespace::Account {
                account_key: account_key.into(),
            },
            root_id,
            project_id,
        )?;
        let _project_guard = paths.lock();
        let state = paths
            .read_state_raw()?
            .ok_or_else(|| VaultError::NamespaceMismatch("account project state missing".into()))?;
        if state.root_id != root_id {
            if !state.root_id.is_empty() {
                continue;
            }
            if same_account_roots != 1 {
                return Err(VaultError::NamespaceMismatch(
                    "ambiguous legacy root".into(),
                ));
            }
        }
        create_directories_without_symlinks(app_data, &archive_dir)?;
        let destination = archive_dir.join(project_id);
        if fs::symlink_metadata(&destination).is_ok() {
            return Err(VaultError::NamespaceMismatch(
                "archive project already exists".into(),
            ));
        }
        fs::rename(&source, &destination)?;
        sync_directory(&source_dir)?;
        sync_directory(&archive_dir)?;
        moved += 1;
    }
    // 全案件を移動した後の再試行でも、既存の archive を同期して完了とする。
    if archive_dir.exists() {
        sync_directory(&archive_dir)?;
    }
    Ok(moved)
}

/// 既存の結び付きを読むだけ。検証時に欠けた root を登録し直さない。
pub fn lookup_root(app_data: &Path, root_id: &str) -> Result<Option<RootBinding>> {
    let _lock = ROOTS_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(read_roots(app_data)?
        .roots
        .into_iter()
        .find(|binding| binding.root_id == root_id))
}

/// その root の案件で、dirty・未確定 mutation・未解決競合・延期中の remote のどれかがあるか。
pub fn namespace_has_pending(
    app_data: &Path,
    namespace: &Namespace,
    root_id: &str,
) -> Result<bool> {
    Ok(!pending_projects(app_data, namespace, root_id)?.is_empty())
}

pub(crate) fn pending_projects(
    app_data: &Path,
    namespace: &Namespace,
    root_id: &str,
) -> Result<Vec<String>> {
    namespace.validate()?;
    validate_root_id(root_id)?;
    let relative = namespace.relative_dir();
    if fs::symlink_metadata(app_data).is_err() {
        return Ok(Vec::new());
    }
    reject_symlinks_along(app_data, &relative)?;
    let entries = match fs::read_dir(app_data.join(&relative)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if validate_project_id(&name).is_err() {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            return Err(VaultError::Symlink(entry.path().display().to_string()));
        }
        if metadata.is_dir() {
            names.push(name);
        }
    }
    names.sort();
    let mut pending = Vec::new();
    for name in names {
        let paths = ProjectPaths::new(app_data, namespace, root_id, &name)?;
        let _guard = paths.lock();
        let Some(state) = paths.read_state_raw()? else {
            continue;
        };
        let same_root = state.root_id == root_id || state.root_id.is_empty();
        if same_root && state.has_pending_work() {
            pending.push(name);
        }
    }
    Ok(pending)
}

fn secure_random_16() -> Result<[u8; 16]> {
    let mut value = [0_u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut value)?;
    Ok(value)
}

/// 16 バイト乱数の base64url（22 字）。mutationId など一意性が要る ID に使う。
pub(crate) fn random_token() -> Result<String> {
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(secure_random_16()?))
}

pub(crate) fn random_id(prefix: &str) -> Result<String> {
    Ok(format!("{prefix}{}", random_token()?))
}

/// /dev/urandom が読めない環境だけ一時名用の乱数で代える（ID の書式は同じ）。
pub(crate) fn random_id_or_fallback(prefix: &str) -> String {
    random_id(prefix).unwrap_or_else(|_| {
        format!(
            "{prefix}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(crate::scanner::fallback_random_bytes())
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::save_state;
    use crate::types::VaultState;
    use tempfile::tempdir;

    #[test]
    fn account_key_is_lower_hex_sha256_of_environment_and_user() {
        let key = account_key("prod", "user-1");
        assert_eq!(key.len(), 64);
        assert!(validate_account_key(&key).is_ok());
        assert_ne!(key, account_key("stg", "user-1"));
        assert_eq!(key, format!("{:x}", Sha256::digest(b"prod\nuser-1")));
    }

    #[test]
    fn archive_is_resumable_and_keeps_other_roots_state() {
        let temp = tempdir().unwrap();
        let app = temp.path().join("app");
        let root_a = temp.path().join("a");
        let root_b = temp.path().join("b");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(&root_a).unwrap();
        fs::create_dir_all(&root_b).unwrap();
        let key = account_key("prod", "user-1");
        let a = root_binding(&app, &root_a).unwrap();
        let b = root_binding(&app, &root_b).unwrap();
        bind_root(&app, &a.root_id, Some(&key)).unwrap();
        bind_root(&app, &b.root_id, Some(&key)).unwrap();
        let namespace = Namespace::Account {
            account_key: key.clone(),
        };
        for (root_id, project_id) in [(&a.root_id, "projecta23"), (&b.root_id, "projectb23")] {
            let mut state = VaultState::new(project_id, root_id, Some(key.clone()));
            state.mark_dirty("pages/page.md");
            save_state(&app, &namespace, &state).unwrap();
        }
        assert_eq!(archive_account_root(&app, &key, &a.root_id, 7).unwrap(), 1);
        assert_eq!(archive_account_root(&app, &key, &a.root_id, 7).unwrap(), 0);
        assert!(app
            .join(format!(
                "vault/archive/{key}/7/{}/projecta23/state.json",
                a.root_id
            ))
            .exists());
        assert!(app
            .join(format!("vault/{key}/projectb23/state.json"))
            .exists());
        assert!(!app.join(format!("vault/{key}/projecta23")).exists());
    }

    #[test]
    fn root_binding_is_stable_by_canonical_path_and_can_be_bound() {
        let temp = tempdir().unwrap();
        let app = temp.path().join("app");
        let root = temp.path().join("docs");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(&root).unwrap();
        let first = root_binding(&app, &root).unwrap();
        assert!(validate_root_id(&first.root_id).is_ok());
        assert_eq!(
            first.namespace(),
            Namespace::Local {
                root_id: first.root_id.clone()
            }
        );
        let again = root_binding(&app, &root.join(".")).unwrap();
        assert_eq!(first, again);
        let key = account_key("prod", "a");
        let bound = bind_root(&app, &first.root_id, Some(&key)).unwrap();
        assert_eq!(
            bound.namespace(),
            Namespace::Account {
                account_key: key.clone()
            }
        );
        assert_eq!(lookup_root(&app, &first.root_id).unwrap().unwrap(), bound);
        assert!(bind_root(&app, "r_AAAAAAAAAAAAAAAAAAAAAA", Some(&key)).is_err());
        assert!(bind_root(&app, &first.root_id, Some("not-hex")).is_err());
    }

    #[test]
    fn namespace_serializes_with_kind_tag() {
        let value = serde_json::to_value(Namespace::Account {
            account_key: "k".into(),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"kind":"account","accountKey":"k"})
        );
    }
}
