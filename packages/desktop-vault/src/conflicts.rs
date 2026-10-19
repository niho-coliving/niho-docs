//! 競合の双方の保護（`.conflicts/` の写し・index と、クラウドに上げる immutable な版）。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::namespace::random_id_or_fallback;
use crate::scanner::{
    atomic_write, read_file_no_follow, remove_file_no_follow, sha256_hex, validate_relative_path,
};
use crate::types::{
    ConflictEntry, ConflictKind, ConflictOrigin, ConflictStatus, ManifestFile, Result, VaultError,
};

pub(crate) const CONFLICTS_DIR: &str = ".conflicts";
const INDEX_PATH: &str = ".conflicts/index.json";

/// 新しい版 ID（`v_` + 16 バイト乱数の base64url）。版を作る操作・競合の保護・解決で 1 回だけ作る。
pub fn new_version_id() -> String {
    random_id_or_fallback("v_")
}

/// 元 path の版を置く immutable な path。
///
/// - `<prefix>artifacts/<stepId>.md` → `<prefix>versions/<stepId>/<versionId>.md`
/// - `<prefix>transcript.md` → `<prefix>versions/source/<versionId>.md`
/// - それ以外 → `versions/files/<SHA-256(path)>/<versionId>.<拡張子|bin>`
///
/// prefix は空か `recordings/<recId>/`。
pub fn version_path_for(path: &str, version_id: &str) -> String {
    let (prefix, rest) = split_recording_prefix(path);
    if let Some(step) = rest
        .strip_prefix("artifacts/")
        .and_then(|value| value.strip_suffix(".md"))
        .filter(|value| !value.is_empty() && !value.contains('/'))
    {
        return format!("{prefix}versions/{step}/{version_id}.md");
    }
    if rest == "transcript.md" {
        return format!("{prefix}versions/source/{version_id}.md");
    }
    format!(
        "versions/files/{}/{version_id}.{}",
        sha256_hex(path.as_bytes()),
        extension_for(path)
    )
}

fn split_recording_prefix(path: &str) -> (&str, &str) {
    if let Some(rest) = path.strip_prefix("recordings/") {
        if let Some((id, tail)) = rest.split_once('/') {
            if !id.is_empty() && !tail.is_empty() {
                let prefix_len = "recordings/".len() + id.len() + 1;
                return (&path[..prefix_len], tail);
            }
        }
    }
    ("", path)
}

/// 元の拡張子（無い・長い・記号を含むときは bin）。
pub(crate) fn extension_for(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((_, extension))
            if (1..=16).contains(&extension.len())
                && extension.bytes().all(|byte| byte.is_ascii_alphanumeric()) =>
        {
            extension.to_owned()
        }
        _ => "bin".to_owned(),
    }
}

pub(crate) fn copy_path_for(path: &str, version_id: &str) -> String {
    format!(
        "{CONFLICTS_DIR}/{}/{version_id}.{}",
        sha256_hex(path.as_bytes()),
        extension_for(path)
    )
}

fn write_copy_with_id(
    working_copy: &Path,
    path: &str,
    version_id: &str,
    bytes: &[u8],
    write_version: bool,
) -> Result<Option<(String, Option<String>)>> {
    let copy = copy_path_for(path, version_id);
    let version = write_version.then(|| version_path_for(path, version_id));
    if fs::symlink_metadata(working_copy.join(&copy)).is_ok()
        || version
            .as_ref()
            .is_some_and(|version| fs::symlink_metadata(working_copy.join(version)).is_ok())
    {
        return Ok(None);
    }
    atomic_write(working_copy, &copy, bytes)?;
    if let Some(version) = &version {
        if let Err(error) = atomic_write(working_copy, version, bytes) {
            let _ = remove_file_no_follow(working_copy, &copy);
            return Err(error);
        }
    }
    Ok(Some((copy, version)))
}

fn write_unique_copy(
    working_copy: &Path,
    path: &str,
    bytes: &[u8],
    write_version: bool,
) -> Result<(String, String, Option<String>)> {
    for _ in 0..16 {
        let version_id = new_version_id();
        if let Some((copy, version)) =
            write_copy_with_id(working_copy, path, &version_id, bytes, write_version)?
        {
            return Ok((version_id, copy, version));
        }
    }
    Err(VaultError::InvalidPath(format!(
        "conflict copy name collision: {path}"
    )))
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConflictIndex {
    #[serde(default = "index_schema")]
    pub(crate) schema_version: u8,
    #[serde(default)]
    pub(crate) entries: Vec<ConflictEntry>,
}

fn index_schema() -> u8 {
    1
}

impl ConflictIndex {
    pub(crate) fn by_path(&self, path: &str) -> Option<&ConflictEntry> {
        self.entries.iter().find(|entry| entry.path == path)
    }

    pub(crate) fn by_id(&self, conflict_id: &str) -> Option<&ConflictEntry> {
        self.entries
            .iter()
            .find(|entry| entry.conflict_id == conflict_id)
    }

    pub(crate) fn upsert(&mut self, entry: ConflictEntry) {
        match self
            .entries
            .iter_mut()
            .find(|candidate| candidate.path == entry.path)
        {
            Some(existing) => *existing = entry,
            None => self.entries.push(entry),
        }
        self.entries
            .sort_by(|left, right| left.path.cmp(&right.path));
    }

    pub(crate) fn take(&mut self, path: &str) -> Option<ConflictEntry> {
        let index = self.entries.iter().position(|entry| entry.path == path)?;
        Some(self.entries.remove(index))
    }
}

pub(crate) fn read_index(working_copy: &Path) -> Result<ConflictIndex> {
    match read_file_no_follow(working_copy, INDEX_PATH) {
        Ok(Some(bytes)) => {
            let index: ConflictIndex = serde_json::from_slice(&bytes)?;
            if index.schema_version != 1 {
                return Err(VaultError::InvalidResponse(
                    "unsupported conflict index schemaVersion".into(),
                ));
            }
            Ok(index)
        }
        Ok(None) => Ok(ConflictIndex {
            schema_version: 1,
            entries: Vec::new(),
        }),
        Err(VaultError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(ConflictIndex {
                schema_version: 1,
                entries: Vec::new(),
            })
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn write_index(working_copy: &Path, index: &ConflictIndex) -> Result<()> {
    if index.entries.is_empty() {
        remove_file_no_follow(working_copy, INDEX_PATH)?;
        return Ok(());
    }
    let index = ConflictIndex {
        schema_version: 1,
        entries: index.entries.clone(),
    };
    atomic_write(
        working_copy,
        INDEX_PATH,
        &serde_json::to_vec_pretty(&index)?,
    )
}

fn valid_copy_path(path: &str) -> bool {
    path.starts_with(".conflicts/") && validate_relative_path(path).is_ok()
}

/// 解決済みの写しを消す（index からの除去は呼ぶ側）。
pub(crate) fn remove_copies(working_copy: &Path, entry: &ConflictEntry) {
    for copy in [&entry.local_copy, &entry.remote_copy]
        .into_iter()
        .flatten()
    {
        if valid_copy_path(copy) {
            let _ = remove_file_no_follow(working_copy, copy);
            if let Some(parent) = Path::new(copy).parent() {
                let _ = fs::remove_dir(working_copy.join(parent));
            }
        }
    }
}

pub(crate) fn read_copy(working_copy: &Path, copy: &str) -> Result<Option<Vec<u8>>> {
    if !valid_copy_path(copy) {
        return Err(VaultError::InvalidPath(copy.to_owned()));
    }
    read_file_no_follow(working_copy, copy)
}

pub(crate) struct ProtectRequest<'a> {
    pub(crate) path: &'a str,
    pub(crate) kind: ConflictKind,
    pub(crate) origin: ConflictOrigin,
    pub(crate) base_sha256: Option<String>,
    /// 現在の手元の bytes と mtime（無ければ削除）。
    pub(crate) local: Option<(Vec<u8>, String)>,
    /// remote 側の版（None は削除）。
    pub(crate) remote: Option<ManifestFile>,
    /// remote の bytes（取れなかったときは None）。
    pub(crate) remote_bytes: Option<Vec<u8>>,
    pub(crate) remote_revision: u64,
    /// working copy に版のファイルを書く（profile では書かない）。
    pub(crate) write_versions: bool,
}

pub(crate) struct Protected {
    pub(crate) entry: ConflictEntry,
    /// 新しく書いた版の path と bytes（クラウドへ上げる）。
    pub(crate) version_files: Vec<(String, Vec<u8>)>,
}

/// 双方を `.conflicts/` と immutable な版に保護して index の entry を作る／更新する（gate の中で呼ぶ）。
pub(crate) fn protect(
    working_copy: &Path,
    existing: Option<&ConflictEntry>,
    request: ProtectRequest<'_>,
) -> Result<Protected> {
    let now = now_millis();
    let mut entry = existing
        .cloned()
        .unwrap_or_else(|| new_entry(request.path, request.kind, request.origin, &now));
    entry.kind = request.kind;
    entry.origin = request.origin;
    entry.status = ConflictStatus::Open;
    entry.resolution_generation = None;
    entry.base_sha256 = request.base_sha256.clone();
    entry.remote_revision = request.remote_revision;
    entry.updated_at = now;
    let mut version_files = Vec::new();

    match &request.local {
        Some((bytes, modified_at)) => {
            let sha = sha256_hex(bytes);
            if entry.local_sha256.as_deref() != Some(sha.as_str()) || entry.local_copy.is_none() {
                let (version_id, copy, version_path) =
                    write_unique_copy(working_copy, request.path, bytes, request.write_versions)?;
                remove_copy(working_copy, entry.local_copy.replace(copy));
                entry.local_version_id = Some(version_id.clone());
                entry.local_version_path = version_path.clone();
                if let Some(version_path) = version_path {
                    version_files.push((version_path.clone(), bytes.clone()));
                }
                entry.local_sha256 = Some(sha);
            }
            entry.local_modified_at = Some(modified_at.clone());
        }
        None => {
            remove_copy(working_copy, entry.local_copy.take());
            entry.local_sha256 = None;
            entry.local_version_id = None;
            entry.local_version_path = None;
            entry.local_modified_at = None;
        }
    }

    match &request.remote {
        Some(file) => {
            let changed = entry.remote_sha256.as_deref() != Some(file.sha256.as_str());
            let stale_copy = changed.then(|| entry.remote_copy.take()).flatten();
            if changed {
                entry.remote_version_id = None;
                entry.remote_version_path = None;
            }
            if changed || entry.remote_copy.is_none() {
                match &request.remote_bytes {
                    Some(bytes) => {
                        let write_version =
                            request.write_versions && request.kind != ConflictKind::Version;
                        let (version_id, copy, version_path) =
                            write_unique_copy(working_copy, request.path, bytes, write_version)?;
                        entry.remote_copy = Some(copy);
                        entry.remote_version_id = Some(version_id.clone());
                        // version path 自体の競合は remote が既に immutable なので書かない。
                        entry.remote_version_path = version_path.clone();
                        if let Some(version_path) = version_path {
                            version_files.push((version_path.clone(), bytes.clone()));
                        }
                        remove_copy(working_copy, stale_copy);
                        entry.remote_available = true;
                    }
                    None => {
                        remove_copy(working_copy, stale_copy);
                        entry.remote_available = false;
                    }
                }
            }
            entry.remote_sha256 = Some(file.sha256.clone());
            entry.remote_device_id = Some(file.writer_device_id.clone());
            entry.remote_modified_at = Some(file.modified_at.clone());
            entry.remote_file = Some(file.clone());
        }
        None => {
            remove_copy(working_copy, entry.remote_copy.take());
            entry.remote_sha256 = None;
            entry.remote_device_id = None;
            entry.remote_modified_at = None;
            entry.remote_version_id = None;
            entry.remote_version_path = None;
            entry.remote_file = None;
            entry.remote_available = true;
        }
    }
    Ok(Protected {
        entry,
        version_files,
    })
}

fn new_entry(path: &str, kind: ConflictKind, origin: ConflictOrigin, now: &str) -> ConflictEntry {
    ConflictEntry {
        conflict_id: random_id_or_fallback("c_"),
        path: path.to_owned(),
        kind,
        origin,
        status: ConflictStatus::Open,
        base_sha256: None,
        local_sha256: None,
        remote_sha256: None,
        remote_revision: 0,
        remote_device_id: None,
        remote_modified_at: None,
        local_modified_at: None,
        local_version_id: None,
        remote_version_id: None,
        local_version_path: None,
        remote_version_path: None,
        local_copy: None,
        remote_copy: None,
        remote_available: true,
        resolution_generation: None,
        remote_file: None,
        created_at: now.to_owned(),
        updated_at: now.to_owned(),
    }
}

/// 音声・大きいファイルの競合。写しは作らず、双方の sha と remote の版だけを記録する。
pub(crate) fn record_reference(
    existing: Option<&ConflictEntry>,
    path: &str,
    kind: ConflictKind,
    base: Option<&ManifestFile>,
    local: Option<&ManifestFile>,
    remote: Option<&ManifestFile>,
    remote_revision: u64,
) -> ConflictEntry {
    let now = now_millis();
    let mut entry = existing
        .cloned()
        .unwrap_or_else(|| new_entry(path, kind, ConflictOrigin::Sync, &now));
    if entry.remote_sha256.as_deref() != remote.map(|file| file.sha256.as_str()) {
        entry.remote_version_id = None;
        entry.remote_version_path = None;
    }
    entry.kind = kind;
    entry.origin = ConflictOrigin::Sync;
    entry.status = ConflictStatus::Open;
    entry.resolution_generation = None;
    entry.base_sha256 = base.map(|file| file.sha256.clone());
    entry.local_sha256 = local.map(|file| file.sha256.clone());
    entry.local_modified_at = local.map(|file| file.modified_at.clone());
    entry.remote_sha256 = remote.map(|file| file.sha256.clone());
    entry.remote_device_id = remote.map(|file| file.writer_device_id.clone());
    entry.remote_modified_at = remote.map(|file| file.modified_at.clone());
    entry.remote_file = remote.cloned();
    entry.remote_revision = remote_revision;
    // copy を持たないことと provider blob が取得できないことは別。available な大容量 remote は
    // resolve 時に download_blob_file で逐次取得できる。
    entry.remote_available = remote.is_none_or(|file| file.available);
    entry.updated_at = now;
    entry
}

fn remove_copy(working_copy: &Path, copy: Option<String>) {
    if let Some(copy) = copy {
        if valid_copy_path(&copy) {
            let _ = remove_file_no_follow(working_copy, &copy);
        }
    }
}

pub(crate) fn now_millis() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn version_paths_follow_the_spec_layout() {
        assert_eq!(
            version_path_for("artifacts/summary.md", "v_x"),
            "versions/summary/v_x.md"
        );
        assert_eq!(
            version_path_for("recordings/r1/artifacts/summary.md", "v_x"),
            "recordings/r1/versions/summary/v_x.md"
        );
        assert_eq!(
            version_path_for("transcript.md", "v_x"),
            "versions/source/v_x.md"
        );
        assert_eq!(
            version_path_for("recordings/r1/transcript.md", "v_x"),
            "recordings/r1/versions/source/v_x.md"
        );
        let hash = sha256_hex(b"pages/p1.md");
        assert_eq!(
            version_path_for("pages/p1.md", "v_x"),
            format!("versions/files/{hash}/v_x.md")
        );
        let hash = sha256_hex(b"Makefile");
        assert_eq!(
            version_path_for("Makefile", "v_x"),
            format!("versions/files/{hash}/v_x.bin")
        );
        assert!(crate::merge::is_immutable_version_path(&version_path_for(
            "recordings/r1/artifacts/a.md",
            "v_x"
        )));
    }

    #[test]
    fn version_ids_are_random_base64url() {
        let first = new_version_id();
        let second = new_version_id();
        assert_ne!(first, second);
        assert_eq!(first.len(), 24);
        assert!(first.starts_with("v_"));
    }

    #[test]
    fn a_second_conflict_copy_name_collision_never_overwrites_the_first_copy() {
        let temp = tempdir().unwrap();
        let path = "audio.m4a";
        let version_id = "v_AAAAAAAAAAAAAAAAAAAAAA";
        let copy = copy_path_for(path, version_id);
        atomic_write(temp.path(), &copy, b"first candidate").unwrap();
        assert!(
            write_copy_with_id(temp.path(), path, version_id, b"second candidate", false)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            fs::read(temp.path().join(copy)).unwrap(),
            b"first candidate"
        );
    }

    #[test]
    fn streamed_audio_reference_keeps_remote_availability_and_retention() {
        let remote = ManifestFile {
            path: "audio.m4a".into(),
            sha256: "a".repeat(64),
            bytes: crate::scanner::TEXT_MAX_BYTES + 1,
            kind: crate::types::FileKind::Audio,
            modified_at: "2026-10-17T00:00:00.000Z".into(),
            writer_device_id: "d_remote".into(),
            writer_device_kind: None,
            retained_until: Some("2026-11-16T00:00:00.000Z".into()),
            available: true,
        };
        let entry = record_reference(
            None,
            "audio.m4a",
            ConflictKind::Edit,
            None,
            None,
            Some(&remote),
            2,
        );
        assert!(entry.remote_available);
        assert_eq!(
            entry.remote_file.unwrap().retained_until,
            remote.retained_until
        );
    }
}
