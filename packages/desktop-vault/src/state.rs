use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, MutexGuard};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::gate::{project_io, ProjectIo};
use crate::namespace::{random_id, validate_root_id, Namespace};
use crate::scanner::{
    atomic_write, reject_symlinks_along, remove_inactive_atomic_temporary, sync_directory,
    validate_relative_path,
};
use crate::types::{Device, Result, VaultError, VaultState};

pub fn validate_project_id(project_id: &str) -> Result<()> {
    if (4..=32).contains(&project_id.len())
        && project_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        Ok(())
    } else {
        Err(VaultError::InvalidPath(project_id.into()))
    }
}

/// 案件 1 つの app data（`<namespace>/<projectId>/`）。state.json・journal/・snapshots/・outbox/・staging/。
pub(crate) struct ProjectPaths {
    pub(crate) app_data: PathBuf,
    pub(crate) namespace: Namespace,
    pub(crate) root_id: String,
    pub(crate) project_id: String,
    project_rel: String,
    pub(crate) io: Arc<ProjectIo>,
}

impl ProjectPaths {
    pub(crate) fn new(
        app_data: &Path,
        namespace: &Namespace,
        root_id: &str,
        project_id: &str,
    ) -> Result<Self> {
        validate_project_id(project_id)?;
        namespace.validate()?;
        validate_root_id(root_id)?;
        let namespace_rel = namespace.relative_dir();
        let io = project_io(&app_data.join(&namespace_rel), project_id);
        Ok(Self {
            app_data: app_data.to_path_buf(),
            namespace: namespace.clone(),
            root_id: root_id.to_owned(),
            project_id: project_id.to_owned(),
            project_rel: format!("{namespace_rel}/{project_id}"),
            io,
        })
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, ()> {
        self.io.lock()
    }

    pub(crate) fn rel(&self, child: &str) -> String {
        if child.is_empty() {
            self.project_rel.clone()
        } else {
            format!("{}/{child}", self.project_rel)
        }
    }

    pub(crate) fn abs(&self, child: &str) -> PathBuf {
        self.app_data.join(self.rel(child))
    }

    pub(crate) fn read_bytes(&self, child: &str) -> Result<Option<Vec<u8>>> {
        let relative = self.rel(child);
        validate_relative_path(&relative)?;
        if fs::symlink_metadata(&self.app_data).is_err() {
            return Ok(None);
        }
        reject_symlinks_along(&self.app_data, &relative)?;
        match fs::read(self.app_data.join(&relative)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn write_bytes(&self, child: &str, bytes: &[u8]) -> Result<()> {
        atomic_write(&self.app_data, &self.rel(child), bytes)
    }

    pub(crate) fn remove(&self, child: &str) -> Result<()> {
        let relative = self.rel(child);
        validate_relative_path(&relative)?;
        reject_symlinks_along(&self.app_data, &relative)?;
        let target = self.app_data.join(&relative);
        match fs::remove_file(&target) {
            Ok(()) => {
                if let Some(parent) = target.parent() {
                    sync_directory(parent)?;
                }
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub(crate) fn exists(&self, child: &str) -> bool {
        fs::symlink_metadata(self.abs(child)).is_ok_and(|metadata| metadata.is_file())
    }

    /// directory の中のファイル名（無ければ空）。一時ファイルは除く。
    pub(crate) fn list(&self, subdir: &str) -> Result<Vec<String>> {
        let relative = self.rel(subdir);
        if fs::symlink_metadata(&self.app_data).is_err() {
            return Ok(Vec::new());
        }
        reject_symlinks_along(&self.app_data, &relative)?;
        let entries = match fs::read_dir(self.app_data.join(&relative)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut names = Vec::new();
        for entry in entries {
            let entry = entry?;
            if let Some(name) = entry.file_name().to_str() {
                if !name.starts_with('.') {
                    names.push(name.to_owned());
                }
            }
        }
        names.sort();
        Ok(names)
    }

    /// 書込み途中で残った `.vault-*.tmp` を消す。
    pub(crate) fn remove_stale_temporaries(&self, subdir: &str) {
        let directory = self.abs(subdir);
        if let Ok(entries) = fs::read_dir(&directory) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with(".vault-") && name.ends_with(".tmp") {
                    remove_inactive_atomic_temporary(&entry.path());
                }
            }
        }
    }

    pub(crate) fn read_json<T: DeserializeOwned>(&self, child: &str) -> Result<Option<T>> {
        match self.read_bytes(child)? {
            Some(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            None => Ok(None),
        }
    }

    pub(crate) fn write_json<T: Serialize>(&self, child: &str, value: &T) -> Result<()> {
        self.write_bytes(child, &serde_json::to_vec_pretty(value)?)
    }

    /// 検査しないで読む（gate を持って呼ぶ）。
    pub(crate) fn read_state_raw(&self) -> Result<Option<VaultState>> {
        self.read_json("state.json")
    }

    /// 検査して読む。無ければ空の state（gate を持って呼ぶ）。
    pub(crate) fn read_state(&self) -> Result<VaultState> {
        let Some(mut state) = self.read_state_raw()? else {
            return Ok(VaultState::new(
                &self.project_id,
                &self.root_id,
                self.namespace.account_key().map(str::to_owned),
            ));
        };
        if state.schema_version != 2 {
            return Err(VaultError::InvalidResponse(
                "unsupported state schemaVersion".into(),
            ));
        }
        if state.project_id != self.project_id {
            return Err(VaultError::InvalidResponse(
                "state projectId mismatch".into(),
            ));
        }
        if state.account_key.as_deref() != self.namespace.account_key() {
            return Err(VaultError::NamespaceMismatch(
                "state accountKey mismatch".into(),
            ));
        }
        if state.root_id != self.root_id {
            // 保存先を移した等で rootId が変わった。未同期が無いときだけ引き継ぐ。
            if state.has_pending_work() {
                return Err(VaultError::NamespaceMismatch(format!(
                    "project {} belongs to another root",
                    self.project_id
                )));
            }
            state.root_id = self.root_id.clone();
        }
        for path in state
            .dirty
            .keys()
            .chain(state.base.iter().map(|file| &file.path))
            .chain(state.deferred_remote.keys())
            .chain(state.deferred_deletes.iter())
            .chain(state.blocked.keys())
            .chain(state.conflicts.keys())
        {
            validate_relative_path(path)?;
        }
        state.sort_base();
        Ok(state)
    }

    /// 世代の水位線を更新して atomic write する（gate を持って呼ぶ）。
    pub(crate) fn write_state(&self, state: &mut VaultState) -> Result<()> {
        state.schema_version = 2;
        state.refresh_acknowledged();
        self.write_json("state.json", state)
    }
}

/// state を読む（gate を取る）。無ければ空の state。
pub fn load_or_default_state(
    app_data: &Path,
    namespace: &Namespace,
    root_id: &str,
    project_id: &str,
) -> Result<VaultState> {
    let paths = ProjectPaths::new(app_data, namespace, root_id, project_id)?;
    let _guard = paths.lock();
    paths.read_state()
}

/// state を書く（gate を取る）。通常は engine と LocalSaver だけが書く。
pub fn save_state(app_data: &Path, namespace: &Namespace, state: &VaultState) -> Result<()> {
    let paths = ProjectPaths::new(app_data, namespace, &state.root_id, &state.project_id)?;
    let _guard = paths.lock();
    let mut state = state.clone();
    state.account_key = namespace.account_key().map(str::to_owned);
    paths.write_state(&mut state)
}

pub fn load_or_create_device(app_data: &Path, default_name: &str) -> Result<Device> {
    let relative = "device.json";
    if fs::symlink_metadata(app_data).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(VaultError::Symlink(app_data.display().to_string()));
    }
    if fs::symlink_metadata(app_data).is_ok() {
        reject_symlinks_along(app_data, relative)?;
    }
    match fs::read(app_data.join(relative)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let device = Device {
                device_id: random_id("d_")?,
                device_name: default_name.to_owned(),
                device_kind: None,
            };
            atomic_write(app_data, relative, &serde_json::to_vec_pretty(&device)?)?;
            Ok(device)
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn local() -> Namespace {
        Namespace::Local {
            root_id: "r_AAAAAAAAAAAAAAAAAAAAAA".into(),
        }
    }

    #[test]
    fn state_and_device_are_atomic_and_stable() {
        let temp = tempdir().unwrap();
        let namespace = local();
        let mut state = VaultState::new("p123", "r_AAAAAAAAAAAAAAAAAAAAAA", None);
        state.mark_dirty("project.json");
        save_state(temp.path(), &namespace, &state).unwrap();
        let loaded =
            load_or_default_state(temp.path(), &namespace, "r_AAAAAAAAAAAAAAAAAAAAAA", "p123")
                .unwrap();
        assert_eq!(loaded.dirty, state.dirty);
        assert_eq!(loaded.acknowledged_generation, 0);
        assert!(temp
            .path()
            .join("vault/local/r_AAAAAAAAAAAAAAAAAAAAAA/p123/state.json")
            .exists());
        let first = load_or_create_device(temp.path(), "Mac").unwrap();
        let second = load_or_create_device(temp.path(), "Different").unwrap();
        assert_eq!(first, second);
        assert!(first.device_id.starts_with("d_"));
    }

    #[test]
    fn project_id_and_state_symlinks_are_rejected_on_read() {
        let temp = tempdir().unwrap();
        let namespace = local();
        assert!(load_or_default_state(
            temp.path(),
            &namespace,
            "r_AAAAAAAAAAAAAAAAAAAAAA",
            "../escape"
        )
        .is_err());
        #[cfg(unix)]
        {
            let outside = tempdir().unwrap();
            std::fs::create_dir_all(outside.path().join("local/r_AAAAAAAAAAAAAAAAAAAAAA/p123"))
                .unwrap();
            std::fs::write(
                outside
                    .path()
                    .join("local/r_AAAAAAAAAAAAAAAAAAAAAA/p123/state.json"),
                "{}",
            )
            .unwrap();
            std::os::unix::fs::symlink(outside.path(), temp.path().join("vault")).unwrap();
            assert!(matches!(
                load_or_default_state(temp.path(), &namespace, "r_AAAAAAAAAAAAAAAAAAAAAA", "p123"),
                Err(VaultError::Symlink(_))
            ));
        }
    }

    #[test]
    fn state_of_another_account_is_rejected() {
        let temp = tempdir().unwrap();
        let a = Namespace::Account {
            account_key: "a".repeat(64),
        };
        let mut state = VaultState::new("p123", "r_AAAAAAAAAAAAAAAAAAAAAA", Some("a".repeat(64)));
        state.mark_dirty("page.md");
        save_state(temp.path(), &a, &state).unwrap();
        // 同じ directory に別の本人の key を書いた state は読まない。
        let paths = ProjectPaths::new(temp.path(), &a, "r_AAAAAAAAAAAAAAAAAAAAAA", "p123").unwrap();
        let mut raw = paths.read_state_raw().unwrap().unwrap();
        raw.account_key = Some("b".repeat(64));
        paths.write_json("state.json", &raw).unwrap();
        assert!(matches!(
            paths.read_state(),
            Err(VaultError::NamespaceMismatch(_))
        ));
    }
}
