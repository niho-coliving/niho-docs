//! ローカル保存の境界（spec §7.2.1）。本文・版・履歴の書込みはすべてここを通す。
//!
//! 1 つの保存は snapshot → journal（prepared）→ 写しへの適用 → state → journal（localCommitted）→ journal の削除。
//! 各書込みは同じ directory の一時ファイル → fsync → rename → 親 directory の fsync。通信しない。

use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::conflicts::{self, now_millis, ConflictIndex, ProtectRequest};
use crate::merge::is_immutable_version_path;
use crate::namespace::{random_id, Namespace};
use crate::outbox;
use crate::protect::EditProtection;
use crate::scanner::{
    atomic_write, file_sha, format_system_time, is_private_path, is_sync_ignored,
    open_file_no_follow, read_file_no_follow, remove_file_no_follow, sha256_hex,
    validate_relative_path, OpenedFileSource, PreparedAtomicWrite, TEXT_MAX_BYTES,
};
use crate::state::ProjectPaths;
use crate::types::{
    ConflictEntry, ConflictKind, ConflictOrigin, ConflictStatus, Device, FileKind, ManifestFile,
    ProjectTarget, Result, SyncEvent, VaultError, VaultState,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaveGroup {
    pub writes: Vec<SaveWrite>,
    pub kind: SaveKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SaveWrite {
    Put { path: String, bytes: Vec<u8> },
    Delete { path: String },
}

impl SaveWrite {
    pub fn path(&self) -> &str {
        match self {
            Self::Put { path, .. } | Self::Delete { path } => path,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SaveKind {
    Edit,
    Version,
    Run,
    System,
    /// 競合の解決。`remote_sha256` は利用者が確認したときの remote 側（削除なら None）。
    Resolution {
        conflict_id: String,
        remote_sha256: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSaveReceipt {
    pub local_save_id: String,
    pub generation: u64,
    pub paths: Vec<String>,
}

/// 編集開始時に project gate の中で保護と一緒に固定した本文。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapturedTextSnapshot {
    pub text: String,
    pub sha256: Option<String>,
    pub protection_id: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    pub rolled_forward: Vec<String>,
    pub protected_conflicts: Vec<String>,
    pub discarded_snapshots: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum JournalStatus {
    Prepared,
    LocalCommitted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JournalPath {
    pub(crate) path: String,
    pub(crate) previous_sha256: Option<String>,
    pub(crate) next_sha256: Option<String>,
    #[serde(default)]
    pub(crate) next_bytes: Option<u64>,
    #[serde(default)]
    pub(crate) previous_snapshot_ref: Option<String>,
    pub(crate) snapshot_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Journal {
    pub(crate) local_save_id: String,
    pub(crate) generation: u64,
    pub(crate) kind: SaveKind,
    pub(crate) status: JournalStatus,
    pub(crate) created_at: String,
    pub(crate) paths: Vec<JournalPath>,
}

/// ローカル保存の入口。同期 API（`.await` しない）。保存は案件の IO gate の中で行う。
#[derive(Clone)]
pub struct LocalSaver {
    app_data: PathBuf,
    namespace: Namespace,
    root_id: String,
    device: Device,
    events: Option<broadcast::Sender<SyncEvent>>,
}

struct CapturedWorkingFile {
    source: Option<OpenedFileSource>,
}

impl CapturedWorkingFile {
    fn capture(root: &Path, relative: &str) -> Result<Self> {
        Ok(Self {
            source: OpenedFileSource::capture(root, relative)?,
        })
    }

    fn sha256(&self) -> Option<&str> {
        self.source.as_ref().map(|source| source.sha256())
    }

    fn verify_current(&self, root: &Path, relative: &str) -> Result<()> {
        match &self.source {
            Some(source) => source.verify_identity(),
            None => match fs::symlink_metadata(root.join(relative)) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                _ => Err(VaultError::ConflictChanged),
            },
        }
    }
}

/// 大きな 1 ファイルの hash/copy/fsync を gate 外で済ませた保存。
pub struct PreparedStreamSave {
    project_id: String,
    working_copy: PathBuf,
    path: String,
    kind: SaveKind,
    expected_path_generation: Option<u64>,
    expected_conflict: Option<ConflictEntry>,
    current: CapturedWorkingFile,
    source: OpenedFileSource,
    next_snapshot: PreparedAtomicWrite,
    previous_snapshot: Option<PreparedAtomicWrite>,
    working: PreparedAtomicWrite,
}

impl LocalSaver {
    pub fn new(
        app_data: impl Into<PathBuf>,
        namespace: Namespace,
        root_id: String,
        device: Device,
    ) -> Self {
        Self {
            app_data: app_data.into(),
            namespace,
            root_id,
            device,
            events: None,
        }
    }

    /// 保存の完了で `LocalSaved` を送る。
    pub fn with_events(mut self, events: broadcast::Sender<SyncEvent>) -> Self {
        self.events = Some(events);
        self
    }

    pub fn namespace(&self) -> &Namespace {
        &self.namespace
    }

    /// remote apply と同じ project gate の中で path を保護してから、編集開始時の本文を読む。
    /// 無い本文は空文字として開き、保存時の CAS では「無いこと」を照合する。
    pub fn capture_text(
        &self,
        target: &ProjectTarget,
        path: &str,
        protection: &EditProtection,
        validate_current: impl FnOnce() -> Result<()>,
    ) -> Result<CapturedTextSnapshot> {
        validate_writable_path(target, path)?;
        if FileKind::from_path(path) != FileKind::Text {
            return Err(VaultError::InvalidPath(path.to_owned()));
        }
        self.recover(target)?;
        let paths = self.paths(&target.project_id)?;
        let _guard = paths.lock();
        // 台帳上の現在の編集対象かどうかも、remote apply と同じ gate の中で再確認する。
        validate_current()?;
        let protection_id = protection.protect(&target.project_id, vec![path.to_owned()]);
        let result = (|| {
            let (bytes, existed) = match open_file_no_follow(&target.working_copy, path)? {
                Some(file) => {
                    if file.metadata()?.len() > TEXT_MAX_BYTES {
                        return Err(VaultError::InvalidPath(path.to_owned()));
                    }
                    let mut bytes = Vec::new();
                    file.take(TEXT_MAX_BYTES + 1).read_to_end(&mut bytes)?;
                    if bytes.len() as u64 > TEXT_MAX_BYTES {
                        return Err(VaultError::InvalidPath(path.to_owned()));
                    }
                    (bytes, true)
                }
                None => (Vec::new(), false),
            };
            let sha256 = existed.then(|| sha256_hex(&bytes));
            let text = String::from_utf8(bytes)
                .ok()
                .filter(|text| !text.contains('\0'))
                .ok_or_else(|| VaultError::InvalidPath(path.to_owned()))?;
            Ok(CapturedTextSnapshot {
                text,
                sha256,
                protection_id,
            })
        })();
        if result.is_err() {
            protection.release(protection_id);
        }
        result
    }

    /// 写しを持たない大きな競合を明示的に再試行するとき、現在の候補を新しい CAS 基準にする。
    /// hash は gate 外で取り、同じ opened identity と同じ remote が残る場合だけ index を更新する。
    pub fn refresh_streamed_conflict_reference(
        &self,
        target: &ProjectTarget,
        conflict_id: &str,
        expected_remote: Option<&str>,
    ) -> Result<()> {
        let paths = self.paths(&target.project_id)?;
        let captured_entry = {
            let _guard = paths.lock();
            conflicts::read_index(&target.working_copy)?
                .by_id(conflict_id)
                .cloned()
                .ok_or(VaultError::ConflictChanged)?
        };
        if captured_entry.remote_sha256.as_deref() != expected_remote {
            return Err(VaultError::ConflictChanged);
        }
        let captured = CapturedWorkingFile::capture(&target.working_copy, &captured_entry.path)?;
        let local_sha256 = captured.sha256().map(str::to_owned);
        let local_modified_at = local_sha256
            .as_ref()
            .map(|_| modified_at_of(&target.working_copy, &captured_entry.path));

        let _guard = paths.lock();
        captured.verify_current(&target.working_copy, &captured_entry.path)?;
        let mut index = conflicts::read_index(&target.working_copy)?;
        let entry = index
            .entries
            .iter_mut()
            .find(|entry| entry.conflict_id == conflict_id)
            .ok_or(VaultError::ConflictChanged)?;
        if entry.path != captured_entry.path
            || entry.remote_sha256.as_deref() != expected_remote
            || entry.status != captured_entry.status
        {
            return Err(VaultError::ConflictChanged);
        }
        entry.local_sha256 = local_sha256;
        entry.local_modified_at = local_modified_at;
        entry.updated_at = now_millis();
        conflicts::write_index(&target.working_copy, &index)
    }

    fn paths(&self, project_id: &str) -> Result<ProjectPaths> {
        ProjectPaths::new(&self.app_data, &self.namespace, &self.root_id, project_id)
    }

    fn emit(&self, event: SyncEvent) {
        if let Some(events) = &self.events {
            let _ = events.send(event);
        }
    }

    fn emit_conflicts(&self, project_id: &str, entries: Vec<ConflictEntry>) {
        for entry in entries {
            self.emit(SyncEvent::Conflict {
                project_id: project_id.to_owned(),
                conflict_id: entry.conflict_id,
                path: entry.path,
                kind: entry.kind,
            });
        }
    }

    /// 1 つの保存単位（本文・版・runs など）を回復可能に書く。成功が返れば「このMacに保存済み」。
    pub fn save(&self, target: &ProjectTarget, group: SaveGroup) -> Result<LocalSaveReceipt> {
        self.save_checked(target, group, None)
    }

    /// 編集開始時（または読み取った直後）の内容と同じときだけ保存する。
    /// `expected_sha256=None` は path が存在しないことを表す。
    pub fn save_if_current(
        &self,
        target: &ProjectTarget,
        group: SaveGroup,
        path: &str,
        expected_sha256: Option<&str>,
    ) -> Result<LocalSaveReceipt> {
        self.save_checked(
            target,
            group,
            Some((path.to_owned(), expected_sha256.map(str::to_owned))),
        )
    }

    fn save_checked(
        &self,
        target: &ProjectTarget,
        group: SaveGroup,
        expected_current: Option<(String, Option<String>)>,
    ) -> Result<LocalSaveReceipt> {
        if group.writes.is_empty() {
            return Err(VaultError::InvalidPath("empty save group".into()));
        }
        let paths = self.paths(&target.project_id)?;
        let mut recovery = prepare_recovery(&paths, target)?;
        let guard = paths.lock();
        // 前回の途中の保存を先に終わらせてから重ねる。
        let (_, recovered) = recover_locked(&paths, target, &self.device, &mut recovery)?;
        let mut state = paths.read_state()?;
        let mut index = conflicts::read_index(&target.working_copy)?;

        if let Some((path, expected)) = &expected_current {
            validate_writable_path(target, path)?;
            if !group.writes.iter().any(|write| write.path() == path) {
                return Err(VaultError::InvalidPath(format!(
                    "guarded path is not in save group: {path}"
                )));
            }
            if file_sha(&target.working_copy, path)? != *expected {
                return Err(VaultError::ConflictChanged);
            }
        }

        let resolution = match &group.kind {
            SaveKind::Resolution {
                conflict_id,
                remote_sha256,
            } => {
                let entry = index
                    .by_id(conflict_id)
                    .ok_or(VaultError::ConflictChanged)?;
                if entry.remote_sha256 != *remote_sha256 {
                    return Err(VaultError::ConflictChanged);
                }
                Some(entry.clone())
            }
            _ => None,
        };

        let mut seen = BTreeSet::new();
        let mut journal_paths = Vec::new();
        for write in &group.writes {
            let path = write.path();
            validate_writable_path(target, path)?;
            if !seen.insert(path.to_owned()) {
                return Err(VaultError::InvalidPath(format!("duplicate path: {path}")));
            }
            let current = file_sha(&target.working_copy, path)?;
            match write {
                SaveWrite::Put { bytes, .. } => {
                    let next = sha256_hex(bytes);
                    if is_immutable_version_path(path) {
                        let adopting_remote = resolution.as_ref().is_some_and(|entry| {
                            entry.path == path
                                && entry.remote_sha256.as_deref() == Some(next.as_str())
                        });
                        let base = state.base_file(path).map(|file| file.sha256.clone());
                        let differs = [current.as_ref(), base.as_ref()]
                            .into_iter()
                            .flatten()
                            .any(|existing| *existing != next);
                        if differs && !adopting_remote {
                            return Err(VaultError::ImmutableVersion {
                                path: path.to_owned(),
                            });
                        }
                    }
                    journal_paths.push(JournalPath {
                        path: path.to_owned(),
                        previous_sha256: current,
                        next_sha256: Some(next.clone()),
                        next_bytes: Some(bytes.len() as u64),
                        previous_snapshot_ref: None,
                        snapshot_ref: Some(next),
                    });
                }
                SaveWrite::Delete { .. } => {
                    if is_immutable_version_path(path) {
                        return Err(VaultError::ImmutableVersion {
                            path: path.to_owned(),
                        });
                    }
                    journal_paths.push(JournalPath {
                        path: path.to_owned(),
                        previous_sha256: current,
                        next_sha256: None,
                        next_bytes: None,
                        previous_snapshot_ref: None,
                        snapshot_ref: None,
                    });
                }
            }
        }
        if let Some(entry) = &resolution {
            if !seen.contains(&entry.path) {
                return Err(VaultError::InvalidPath(format!(
                    "resolution must write the conflicted path: {}",
                    entry.path
                )));
            }
        }

        for write in &group.writes {
            if let SaveWrite::Put { bytes, .. } = write {
                let child = format!("snapshots/{}", sha256_hex(bytes));
                if !paths.exists(&child) {
                    paths.write_bytes(&child, bytes)?;
                }
            }
        }

        let generation = state.dirty_generation.saturating_add(1);
        let mut journal = Journal {
            local_save_id: random_id("s_")?,
            generation,
            kind: group.kind.clone(),
            status: JournalStatus::Prepared,
            created_at: now_millis(),
            paths: journal_paths,
        };
        let journal_child = format!("journal/{}.json", journal.local_save_id);
        paths.write_json(&journal_child, &journal)?;

        for write in &group.writes {
            match write {
                SaveWrite::Put { path, bytes } => atomic_write(&target.working_copy, path, bytes)?,
                SaveWrite::Delete { path } => {
                    remove_file_no_follow(&target.working_copy, path)?;
                }
            }
        }

        let index_changed = apply_journal(&mut state, &journal, &mut index);
        for entry in &journal.paths {
            state.quota_paths.remove(&entry.path);
        }
        paths.write_state(&mut state)?;
        if index_changed {
            conflicts::write_index(&target.working_copy, &index)?;
        }
        journal.status = JournalStatus::LocalCommitted;
        paths.write_json(&journal_child, &journal)?;
        paths.remove(&journal_child)?;
        gc_snapshots(&paths)?;
        drop(guard);

        self.emit_conflicts(&target.project_id, recovered);
        let receipt = LocalSaveReceipt {
            local_save_id: journal.local_save_id,
            generation,
            paths: journal.paths.into_iter().map(|entry| entry.path).collect(),
        };
        self.emit(SyncEvent::LocalSaved {
            project_id: target.project_id.clone(),
            generation,
            paths: receipt.paths.clone(),
        });
        Ok(receipt)
    }

    /// 大きな audio/blob の hash/copy/fsync を gate 外で済ませる。
    pub fn prepare_streamed(
        &self,
        target: &ProjectTarget,
        path: String,
        mut source: OpenedFileSource,
        kind: SaveKind,
    ) -> Result<PreparedStreamSave> {
        validate_writable_path(target, &path)?;
        // 先行 journal の大きな copy も、下の gate を取る前に準備する。
        self.recover(target)?;
        let paths = self.paths(&target.project_id)?;
        let (expected_path_generation, expected_conflict, base_sha256) = {
            let _guard = paths.lock();
            let state = paths.read_state()?;
            let index = conflicts::read_index(&target.working_copy)?;
            let conflict = match &kind {
                SaveKind::Resolution {
                    conflict_id,
                    remote_sha256,
                } => {
                    let entry = index
                        .by_id(conflict_id)
                        .ok_or(VaultError::ConflictChanged)?;
                    if entry.remote_sha256 != *remote_sha256 || entry.path != path {
                        return Err(VaultError::ConflictChanged);
                    }
                    Some(entry.clone())
                }
                _ => None,
            };
            (
                state.dirty.get(&path).copied(),
                conflict,
                state.base_file(&path).map(|file| file.sha256.clone()),
            )
        };

        let mut current = CapturedWorkingFile::capture(&target.working_copy, &path)?;
        let current_sha = current.sha256().map(str::to_owned);
        if expected_conflict
            .as_ref()
            .is_some_and(|entry| entry.local_sha256.as_ref() != current_sha.as_ref())
        {
            return Err(VaultError::ConflictChanged);
        }
        let next = source.sha256().to_owned();
        if is_immutable_version_path(&path) {
            let adopting_remote = expected_conflict
                .as_ref()
                .is_some_and(|entry| entry.remote_sha256.as_deref() == Some(next.as_str()));
            let differs = [current_sha.as_ref(), base_sha256.as_ref()]
                .into_iter()
                .flatten()
                .any(|existing| *existing != next);
            if differs && !adopting_remote {
                return Err(VaultError::ImmutableVersion { path });
            }
        }

        // snapshot と working copy の全 copy は lock 外。snapshot は既存名を信用せず、同じ
        // opened handle から作った fsync 済み temp を短い commit で置く。
        let next_snapshot_child = format!("snapshots/{next}");
        let next_snapshot =
            source.prepare_atomic(&paths.app_data, &paths.rel(&next_snapshot_child))?;
        let working = source.prepare_atomic(&target.working_copy, &path)?;
        let previous_snapshot = match current.source.as_mut() {
            Some(previous) => {
                let child = format!("snapshots/{}", previous.sha256());
                Some(previous.prepare_atomic(&paths.app_data, &paths.rel(&child))?)
            }
            None => None,
        };

        Ok(PreparedStreamSave {
            project_id: target.project_id.clone(),
            working_copy: target.working_copy.clone(),
            path,
            kind,
            expected_path_generation,
            expected_conflict,
            current,
            source,
            next_snapshot,
            previous_snapshot,
            working,
        })
    }

    /// gate の中では identity/CAS と journal/rename/state だけを行う。
    pub fn commit_streamed(
        &self,
        target: &ProjectTarget,
        prepared: PreparedStreamSave,
    ) -> Result<LocalSaveReceipt> {
        if prepared.project_id != target.project_id || prepared.working_copy != target.working_copy
        {
            return Err(VaultError::ConflictChanged);
        }
        let paths = self.paths(&target.project_id)?;
        let guard = paths.lock();
        let mut state = paths.read_state()?;
        let mut index = conflicts::read_index(&target.working_copy)?;
        if state.dirty.get(&prepared.path).copied() != prepared.expected_path_generation {
            return Err(VaultError::ConflictChanged);
        }
        if let Some(expected) = &prepared.expected_conflict {
            let current = index
                .by_id(&expected.conflict_id)
                .ok_or(VaultError::ConflictChanged)?;
            if current.path != expected.path
                || current.remote_sha256 != expected.remote_sha256
                || current.local_sha256 != expected.local_sha256
                || current.status != expected.status
            {
                return Err(VaultError::ConflictChanged);
            }
        }
        prepared
            .current
            .verify_current(&target.working_copy, &prepared.path)
            .map_err(|_| VaultError::ConflictChanged)?;
        prepared.source.verify_identity()?;

        let next = prepared.source.sha256().to_owned();
        let previous = prepared.current.sha256().map(str::to_owned);
        prepared.next_snapshot.commit()?;
        if let Some(snapshot) = prepared.previous_snapshot {
            snapshot.commit()?;
        }
        let generation = state.dirty_generation.saturating_add(1);
        let mut journal = Journal {
            local_save_id: random_id("s_")?,
            generation,
            kind: prepared.kind,
            status: JournalStatus::Prepared,
            created_at: now_millis(),
            paths: vec![JournalPath {
                path: prepared.path.clone(),
                previous_sha256: previous.clone(),
                next_sha256: Some(next.clone()),
                next_bytes: Some(prepared.source.bytes()),
                previous_snapshot_ref: previous,
                snapshot_ref: Some(next),
            }],
        };
        let journal_child = format!("journal/{}.json", journal.local_save_id);
        paths.write_json(&journal_child, &journal)?;

        prepared.working.commit()?;
        let index_changed = apply_journal(&mut state, &journal, &mut index);
        state.quota_paths.remove(&prepared.path);
        paths.write_state(&mut state)?;
        if index_changed {
            conflicts::write_index(&target.working_copy, &index)?;
        }
        journal.status = JournalStatus::LocalCommitted;
        paths.write_json(&journal_child, &journal)?;
        paths.remove(&journal_child)?;
        gc_snapshots(&paths)?;
        drop(guard);
        let receipt = LocalSaveReceipt {
            local_save_id: journal.local_save_id,
            generation,
            paths: vec![prepared.path],
        };
        self.emit(SyncEvent::LocalSaved {
            project_id: target.project_id.clone(),
            generation,
            paths: receipt.paths.clone(),
        });
        Ok(receipt)
    }

    pub fn save_streamed(
        &self,
        target: &ProjectTarget,
        path: String,
        source: OpenedFileSource,
        kind: SaveKind,
    ) -> Result<LocalSaveReceipt> {
        let prepared = self.prepare_streamed(target, path, source, kind)?;
        self.commit_streamed(target, prepared)
    }

    /// アプリの保存 API を通らない変更（音声の写し・画像・削除）を dirty にする。
    pub fn note_changed(&self, target: &ProjectTarget, changed: &[String]) -> Result<u64> {
        let paths = self.paths(&target.project_id)?;
        let mut accepted: Vec<String> = Vec::new();
        for path in changed {
            validate_relative_path(path)?;
            if is_sync_ignored(path) || is_private_path(path) || !target.scope.contains(path) {
                continue;
            }
            if !accepted.contains(path) {
                accepted.push(path.clone());
            }
        }
        let mut recovery = prepare_recovery(&paths, target)?;
        let guard = paths.lock();
        let (_, recovered) = recover_locked(&paths, target, &self.device, &mut recovery)?;
        let mut state = paths.read_state()?;
        if accepted.is_empty() {
            return Ok(state.dirty_generation);
        }
        for path in &accepted {
            state.quota_paths.remove(path);
        }
        let generation = state.mark_dirty_paths(accepted.clone());
        paths.write_state(&mut state)?;
        drop(guard);
        self.emit_conflicts(&target.project_id, recovered);
        self.emit(SyncEvent::LocalSaved {
            project_id: target.project_id.clone(),
            generation,
            paths: accepted,
        });
        Ok(generation)
    }

    /// 通信より前に呼ぶ。prepared の journal を roll forward し、previous／next のどちらとも違う path は
    /// 上書きせず両方を保護して競合にする。
    pub fn recover(&self, target: &ProjectTarget) -> Result<RecoveryReport> {
        let paths = self.paths(&target.project_id)?;
        let mut recovery = prepare_recovery(&paths, target)?;
        let guard = paths.lock();
        let (report, recovered) = recover_locked(&paths, target, &self.device, &mut recovery)?;
        drop(guard);
        self.emit_conflicts(&target.project_id, recovered);
        Ok(report)
    }
}

fn validate_writable_path(target: &ProjectTarget, path: &str) -> Result<()> {
    validate_relative_path(path)?;
    if is_sync_ignored(path) || is_private_path(path) || !target.scope.contains(path) {
        return Err(VaultError::InvalidPath(path.to_owned()));
    }
    Ok(())
}

/// journal の内容を state（と解決中の競合）へ反映する。同じ journal を 2 回反映しても同じ結果。
pub(crate) fn apply_journal(
    state: &mut VaultState,
    journal: &Journal,
    index: &mut ConflictIndex,
) -> bool {
    let generation = journal.generation;
    for entry in &journal.paths {
        let value = state
            .dirty
            .get(&entry.path)
            .copied()
            .unwrap_or(0)
            .max(generation);
        state.dirty.insert(entry.path.clone(), value);
    }
    state.dirty_generation = state.dirty_generation.max(generation);
    state.local_generation = state.local_generation.max(generation);
    if journal.paths.len() > 1 {
        state.groups.insert(
            generation,
            journal
                .paths
                .iter()
                .map(|entry| entry.path.clone())
                .collect(),
        );
    }
    let mut changed = false;
    if let SaveKind::Resolution {
        conflict_id,
        remote_sha256,
    } = &journal.kind
    {
        if let Some(entry) = index
            .entries
            .iter_mut()
            .find(|entry| &entry.conflict_id == conflict_id)
        {
            let already = entry.status == ConflictStatus::Resolving
                && entry.resolution_generation == Some(generation);
            if !already && entry.remote_sha256 == *remote_sha256 {
                if entry.origin == ConflictOrigin::Sync {
                    match &entry.remote_file {
                        Some(file) => state.set_base(file.clone()),
                        None => state.remove_base(&entry.path),
                    }
                }
                entry.status = ConflictStatus::Resolving;
                entry.resolution_generation = Some(generation);
                entry.updated_at = now_millis();
                state
                    .conflicts
                    .insert(entry.path.clone(), entry.conflict_id.clone());
                state.deferred_remote.remove(&entry.path);
                state.deferred_deletes.remove(&entry.path);
                changed = true;
            }
        }
    }
    changed
}

fn modified_at_of(root: &Path, relative: &str) -> String {
    fs::symlink_metadata(root.join(relative))
        .and_then(|metadata| metadata.modified())
        .map(format_system_time)
        .unwrap_or_else(|_| now_millis())
}

enum PreparedRecoveryAction {
    AlreadyApplied,
    Put(PreparedAtomicWrite),
    Delete,
    Diverged,
}

pub(crate) struct PreparedRecoveryEntry {
    journal_child: String,
    journal: Journal,
    path: String,
    current: CapturedWorkingFile,
    action: PreparedRecoveryAction,
}

fn recovery_snapshot_error(path: &str) -> VaultError {
    VaultError::InvalidResponse(format!("recovery snapshot missing or corrupt: {path}"))
}

/// 大きな prepared journal の hash と copy は gate 外で行う。journal 自体は commit 時に再照合する。
pub(crate) fn prepare_recovery(
    paths: &ProjectPaths,
    target: &ProjectTarget,
) -> Result<Vec<PreparedRecoveryEntry>> {
    let mut prepared = Vec::new();
    for name in paths.list("journal")? {
        if !name.ends_with(".json") {
            continue;
        }
        let child = format!("journal/{name}");
        let journal = match paths.read_json::<Journal>(&child) {
            Ok(Some(journal)) => journal,
            Ok(None) => continue,
            // malformed journal の退避は従来どおり gate 内の recover_locked に任せる。
            Err(_) => return Ok(Vec::new()),
        };
        if journal.status != JournalStatus::Prepared {
            continue;
        }
        for entry in &journal.paths {
            if !entry.next_bytes.is_some_and(|bytes| bytes > TEXT_MAX_BYTES) {
                continue;
            }
            let current = CapturedWorkingFile::capture(&target.working_copy, &entry.path)?;
            let current_sha = current.sha256();
            let action = if current_sha == entry.next_sha256.as_deref() {
                PreparedRecoveryAction::AlreadyApplied
            } else if current_sha == entry.previous_sha256.as_deref() {
                match (&entry.next_sha256, &entry.snapshot_ref) {
                    (Some(next), Some(snapshot)) => {
                        let bytes = entry
                            .next_bytes
                            .ok_or_else(|| recovery_snapshot_error(&entry.path))?;
                        let snapshot_child = format!("snapshots/{snapshot}");
                        let mut source = OpenedFileSource::open(
                            &paths.app_data,
                            &paths.rel(&snapshot_child),
                            next,
                            bytes,
                        )
                        .map_err(|_| recovery_snapshot_error(&entry.path))?;
                        PreparedRecoveryAction::Put(
                            source.prepare_atomic(&target.working_copy, &entry.path)?,
                        )
                    }
                    (None, _) => PreparedRecoveryAction::Delete,
                    (Some(_), None) => {
                        return Err(recovery_snapshot_error(&entry.path));
                    }
                }
            } else {
                PreparedRecoveryAction::Diverged
            };
            prepared.push(PreparedRecoveryEntry {
                journal_child: child.clone(),
                journal: journal.clone(),
                path: entry.path.clone(),
                current,
                action,
            });
        }
    }
    Ok(prepared)
}

/// 途中で終わった journal を片付ける（gate を持って呼ぶ）。新しく保護した競合を返す。
pub(crate) fn recover_locked(
    paths: &ProjectPaths,
    target: &ProjectTarget,
    device: &Device,
    prepared: &mut Vec<PreparedRecoveryEntry>,
) -> Result<(RecoveryReport, Vec<ConflictEntry>)> {
    let mut report = RecoveryReport::default();
    let mut new_conflicts = Vec::new();
    for subdir in ["journal", "snapshots", "outbox", "staging"] {
        paths.remove_stale_temporaries(subdir);
    }
    let mut journals = Vec::new();
    for name in paths.list("journal")? {
        if !name.ends_with(".json") {
            continue;
        }
        let child = format!("journal/{name}");
        match paths.read_json::<Journal>(&child) {
            Ok(Some(journal)) => journals.push((child, journal)),
            Ok(None) => {}
            Err(error) => {
                // 読めない journal は成功扱いにせず写しを退避し、原本と snapshot を残して停止する。
                if let Some(bytes) = paths.read_bytes(&child)? {
                    paths.write_bytes(&format!("journal/{name}.corrupt"), &bytes)?;
                }
                return Err(error);
            }
        }
    }
    if journals.is_empty() {
        report.discarded_snapshots = gc_snapshots(paths)?;
        return Ok((report, new_conflicts));
    }
    journals.sort_by(|left, right| {
        (left.1.generation, &left.1.local_save_id)
            .cmp(&(right.1.generation, &right.1.local_save_id))
    });
    let mut state = paths.read_state()?;
    let mut index = conflicts::read_index(&target.working_copy)?;
    let write_versions = |path: &str| target.scope.allows_version_of(path);
    for (child, journal) in journals {
        let mut index_changed = false;
        if journal.status == JournalStatus::Prepared {
            for entry in &journal.paths {
                if entry.next_bytes.is_some_and(|bytes| bytes > TEXT_MAX_BYTES) {
                    let position = prepared
                        .iter()
                        .position(|item| {
                            item.journal_child == child
                                && item.journal == journal
                                && item.path == entry.path
                        })
                        .ok_or_else(|| {
                            VaultError::InvalidResponse(format!(
                                "streamed recovery was not prepared: {}",
                                entry.path
                            ))
                        })?;
                    let item = prepared.remove(position);
                    item.current
                        .verify_current(&target.working_copy, &entry.path)?;
                    match item.action {
                        PreparedRecoveryAction::AlreadyApplied => {}
                        PreparedRecoveryAction::Put(write) => {
                            write.commit()?;
                            report.rolled_forward.push(entry.path.clone());
                        }
                        PreparedRecoveryAction::Delete => {
                            remove_file_no_follow(&target.working_copy, &entry.path)?;
                            report.rolled_forward.push(entry.path.clone());
                        }
                        PreparedRecoveryAction::Diverged => {
                            return Err(VaultError::InvalidResponse(format!(
                                "streamed recovery conflict retained: {}",
                                entry.path
                            )));
                        }
                    }
                    continue;
                }
                let current = file_sha(&target.working_copy, &entry.path)?;
                if current == entry.next_sha256 {
                    continue;
                }
                if current == entry.previous_sha256 {
                    match (&entry.next_sha256, &entry.snapshot_ref) {
                        (Some(next), Some(snapshot)) => {
                            let snapshot_child = format!("snapshots/{snapshot}");
                            if let Some(bytes) = entry.next_bytes {
                                let mut source = OpenedFileSource::open(
                                    &paths.app_data,
                                    &paths.rel(&snapshot_child),
                                    next,
                                    bytes,
                                )
                                .map_err(|_| recovery_snapshot_error(&entry.path))?;
                                source.write_atomic(&target.working_copy, &entry.path)?;
                            } else {
                                // v1 journal は byte 数を持たないため、従来どおり小さい snapshot を読む。
                                let bytes = paths
                                    .read_bytes(&snapshot_child)?
                                    .ok_or_else(|| recovery_snapshot_error(&entry.path))?;
                                if sha256_hex(&bytes) != *next {
                                    return Err(recovery_snapshot_error(&entry.path));
                                }
                                atomic_write(&target.working_copy, &entry.path, &bytes)?;
                            }
                        }
                        (None, _) => {
                            remove_file_no_follow(&target.working_copy, &entry.path)?;
                        }
                        (Some(_), None) => return Err(recovery_snapshot_error(&entry.path)),
                    }
                    report.rolled_forward.push(entry.path.clone());
                    continue;
                }
                // previous とも next とも違う: 上書きせず、現在のファイルと保存しようとした内容の両方を残す。
                // 大きな streamed save は journal/snapshot を保持したまま止める。双方を Vec にして保護しない。
                if entry.next_bytes.is_some_and(|bytes| bytes > TEXT_MAX_BYTES) {
                    return Err(VaultError::InvalidResponse(format!(
                        "streamed recovery conflict retained: {}",
                        entry.path
                    )));
                }
                let local = read_file_no_follow(&target.working_copy, &entry.path)?
                    .map(|bytes| (bytes, modified_at_of(&target.working_copy, &entry.path)));
                let next_bytes = match &entry.snapshot_ref {
                    Some(snapshot) => paths.read_bytes(&format!("snapshots/{snapshot}"))?,
                    None => None,
                };
                let remote = entry.next_sha256.as_ref().map(|sha| ManifestFile {
                    path: entry.path.clone(),
                    sha256: sha.clone(),
                    bytes: next_bytes.as_ref().map_or(0, |bytes| bytes.len() as u64),
                    kind: FileKind::from_path(&entry.path),
                    modified_at: journal.created_at.clone(),
                    writer_device_id: device.device_id.clone(),
                    writer_device_kind: device.device_kind.clone(),
                    retained_until: None,
                    available: true,
                });
                let kind = match (&local, &remote) {
                    (Some(_), Some(_)) => ConflictKind::Edit,
                    (None, Some(_)) => ConflictKind::LocalDeletedRemoteEdited,
                    (Some(_), None) => ConflictKind::RemoteDeletedLocalEdited,
                    (None, None) => continue,
                };
                let existing = index.by_path(&entry.path).cloned();
                let protected = conflicts::protect(
                    &target.working_copy,
                    existing.as_ref(),
                    ProtectRequest {
                        path: &entry.path,
                        kind,
                        origin: ConflictOrigin::Recovery,
                        base_sha256: entry.previous_sha256.clone(),
                        local,
                        remote,
                        remote_bytes: next_bytes,
                        remote_revision: state.base_revision,
                        write_versions: write_versions(&entry.path),
                    },
                )?;
                let version_paths: Vec<String> = protected
                    .version_files
                    .iter()
                    .map(|(path, _)| path.clone())
                    .collect();
                if !version_paths.is_empty() {
                    state.mark_dirty_paths(version_paths);
                }
                state
                    .conflicts
                    .insert(entry.path.clone(), protected.entry.conflict_id.clone());
                index.upsert(protected.entry.clone());
                index_changed = true;
                new_conflicts.push(protected.entry);
                report.protected_conflicts.push(entry.path.clone());
            }
        }
        index_changed |= apply_journal(&mut state, &journal, &mut index);
        paths.write_state(&mut state)?;
        if index_changed {
            conflicts::write_index(&target.working_copy, &index)?;
        }
        paths.remove(&child)?;
    }
    report.discarded_snapshots = gc_snapshots(paths)?;
    Ok((report, new_conflicts))
}

/// journal・outbox のどれからも参照されない snapshot を消す。
pub(crate) fn gc_snapshots(paths: &ProjectPaths) -> Result<usize> {
    let mut referenced = BTreeSet::new();
    for name in paths.list("journal")? {
        if !name.ends_with(".json") {
            continue;
        }
        if let Ok(Some(journal)) = paths.read_json::<Journal>(&format!("journal/{name}")) {
            referenced.extend(
                journal
                    .paths
                    .into_iter()
                    .flat_map(|entry| [entry.snapshot_ref, entry.previous_snapshot_ref])
                    .flatten(),
            );
        }
    }
    referenced.extend(outbox::all_snapshot_refs(paths)?);
    let mut removed = 0;
    for name in paths.list("snapshots")? {
        if !referenced.contains(&name) {
            paths.remove(&format!("snapshots/{name}"))?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::{fail_next_directory_sync_at, hash_file};
    use std::fs::File;
    use tempfile::tempdir;

    fn saver(app: &Path) -> (LocalSaver, Namespace) {
        let namespace = Namespace::Local {
            root_id: "r_AAAAAAAAAAAAAAAAAAAAAA".into(),
        };
        let device = Device {
            device_id: "d_test".into(),
            device_name: "test".into(),
            device_kind: None,
        };
        (
            LocalSaver::new(
                app,
                namespace.clone(),
                "r_AAAAAAAAAAAAAAAAAAAAAA".into(),
                device,
            ),
            namespace,
        )
    }

    #[test]
    fn captured_text_validates_protects_and_reads_under_the_project_gate_then_uses_cas() {
        let app = tempdir().unwrap();
        let working = tempdir().unwrap();
        fs::write(working.path().join("page.md"), b"before gate").unwrap();
        let (saver, _) = saver(app.path());
        let target = ProjectTarget::new("p123", working.path());
        let protection = EditProtection::new();

        let captured = saver
            .capture_text(&target, "page.md", &protection, || {
                // current-editable の再照合と本文読み込みは同じ gate 内。この時点の内容を捕捉する。
                fs::write(working.path().join("page.md"), b"current in gate").unwrap();
                Ok(())
            })
            .unwrap();
        assert_eq!(captured.text, "current in gate");
        assert!(protection.is_protected("p123", "page.md"));

        saver
            .save(
                &target,
                SaveGroup {
                    writes: vec![SaveWrite::Put {
                        path: "page.md".into(),
                        bytes: b"intervening native save".to_vec(),
                    }],
                    kind: SaveKind::Edit,
                },
            )
            .unwrap();
        assert!(matches!(
            saver.save_if_current(
                &target,
                SaveGroup {
                    writes: vec![SaveWrite::Put {
                        path: "page.md".into(),
                        bytes: b"stale editor".to_vec(),
                    }],
                    kind: SaveKind::Edit,
                },
                "page.md",
                captured.sha256.as_deref(),
            ),
            Err(VaultError::ConflictChanged)
        ));
        assert_eq!(
            fs::read(working.path().join("page.md")).unwrap(),
            b"intervening native save"
        );
        protection.release(captured.protection_id);
        assert!(!protection.is_protected("p123", "page.md"));
    }

    #[test]
    fn rejected_current_editable_validation_does_not_leave_a_protection() {
        let app = tempdir().unwrap();
        let working = tempdir().unwrap();
        fs::write(working.path().join("page.md"), b"body").unwrap();
        let (saver, _) = saver(app.path());
        let target = ProjectTarget::new("p123", working.path());
        let protection = EditProtection::new();
        assert!(saver
            .capture_text(&target, "page.md", &protection, || {
                Err(VaultError::InvalidPath("no longer editable".into()))
            })
            .is_err());
        assert!(protection.paths("p123").is_empty());
    }

    #[test]
    fn failed_working_copy_parent_fsync_keeps_prepared_recovery_data_and_emits_no_ack() {
        let app = tempdir().unwrap();
        let working = tempdir().unwrap();
        let namespace = Namespace::Local {
            root_id: "r_AAAAAAAAAAAAAAAAAAAAAA".into(),
        };
        let device = Device {
            device_id: "d_test".into(),
            device_name: "test".into(),
            device_kind: None,
        };
        let (events, mut receiver) = broadcast::channel(8);
        let saver = LocalSaver::new(
            app.path(),
            namespace.clone(),
            "r_AAAAAAAAAAAAAAAAAAAAAA".into(),
            device,
        )
        .with_events(events);
        let target = ProjectTarget::new("p123", working.path());
        fail_next_directory_sync_at(working.path());
        assert!(saver
            .save(
                &target,
                SaveGroup {
                    writes: vec![SaveWrite::Put {
                        path: "page.md".into(),
                        bytes: b"durable".to_vec(),
                    }],
                    kind: SaveKind::Edit,
                },
            )
            .is_err());

        let project = namespace.dir(app.path()).join("p123");
        assert_eq!(fs::read_dir(project.join("journal")).unwrap().count(), 1);
        assert_eq!(fs::read_dir(project.join("snapshots")).unwrap().count(), 1);
        assert!(matches!(
            receiver.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        let state = ProjectPaths::new(app.path(), &namespace, "r_AAAAAAAAAAAAAAAAAAAAAA", "p123")
            .unwrap()
            .read_state()
            .unwrap();
        assert_eq!(state.local_generation, 0);
    }

    #[test]
    fn missing_or_corrupt_recovery_snapshot_keeps_journal_all_snapshots_and_no_ack() {
        for corrupt in [false, true] {
            let app = tempdir().unwrap();
            let working = tempdir().unwrap();
            fs::write(working.path().join("page.md"), b"old current").unwrap();
            let previous = sha256_hex(b"old current");
            let next = sha256_hex(b"intended next");
            let (events, mut receiver) = broadcast::channel(8);
            let (base, namespace) = saver(app.path());
            let saver = base.with_events(events);
            let target = ProjectTarget::new("p123", working.path());
            let paths =
                ProjectPaths::new(app.path(), &namespace, "r_AAAAAAAAAAAAAAAAAAAAAA", "p123")
                    .unwrap();
            paths
                .write_bytes(&format!("snapshots/{previous}"), b"old current")
                .unwrap();
            paths
                .write_bytes("snapshots/unrelated", b"must remain")
                .unwrap();
            if corrupt {
                paths
                    .write_bytes(&format!("snapshots/{next}"), b"wrong")
                    .unwrap();
            }
            let journal = Journal {
                local_save_id: "s_recovery".into(),
                generation: 1,
                kind: SaveKind::Edit,
                status: JournalStatus::Prepared,
                created_at: now_millis(),
                paths: vec![JournalPath {
                    path: "page.md".into(),
                    previous_sha256: Some(previous.clone()),
                    next_sha256: Some(next.clone()),
                    next_bytes: Some(b"intended next".len() as u64),
                    previous_snapshot_ref: Some(previous.clone()),
                    snapshot_ref: Some(next.clone()),
                }],
            };
            paths
                .write_json("journal/s_recovery.json", &journal)
                .unwrap();

            assert!(saver.recover(&target).is_err());
            assert!(paths.exists("journal/s_recovery.json"));
            assert!(paths.exists(&format!("snapshots/{previous}")));
            assert!(paths.exists("snapshots/unrelated"));
            if corrupt {
                assert_eq!(
                    paths.read_bytes(&format!("snapshots/{next}")).unwrap(),
                    Some(b"wrong".to_vec())
                );
            }
            assert_eq!(
                fs::read(working.path().join("page.md")).unwrap(),
                b"old current"
            );
            assert_eq!(paths.read_state().unwrap().local_generation, 0);
            assert!(matches!(
                receiver.try_recv(),
                Err(broadcast::error::TryRecvError::Empty)
            ));
        }
    }

    #[test]
    fn streamed_save_copies_more_than_eight_mib_without_a_vec_payload() {
        let app = tempdir().unwrap();
        let working = tempdir().unwrap();
        let source_dir = tempdir().unwrap();
        let source_path = source_dir.path().join("remote.bin");
        let file = File::create(&source_path).unwrap();
        file.set_len(TEXT_MAX_BYTES + 1).unwrap();
        drop(file);
        let sha256 = hash_file(&source_path).unwrap();
        let source =
            OpenedFileSource::open(source_dir.path(), "remote.bin", &sha256, TEXT_MAX_BYTES + 1)
                .unwrap();
        let (saver, _) = saver(app.path());
        let target = ProjectTarget::new("p123", working.path());
        let receipt = saver
            .save_streamed(&target, "archive.bin".into(), source, SaveKind::System)
            .unwrap();
        assert_eq!(receipt.paths, ["archive.bin"]);
        assert_eq!(
            fs::metadata(working.path().join("archive.bin"))
                .unwrap()
                .len(),
            TEXT_MAX_BYTES + 1
        );
        assert!(!working.path().join("versions").exists());
    }

    #[test]
    fn streamed_save_rejects_a_changed_open_source_and_keeps_the_current_candidate() {
        let app = tempdir().unwrap();
        let working = tempdir().unwrap();
        let source_dir = tempdir().unwrap();
        fs::write(working.path().join("audio.m4a"), b"local candidate").unwrap();
        let source_path = source_dir.path().join("remote.m4a");
        fs::write(&source_path, b"remote candidate").unwrap();
        let sha256 = hash_file(&source_path).unwrap();
        let source = OpenedFileSource::open(
            source_dir.path(),
            "remote.m4a",
            &sha256,
            b"remote candidate".len() as u64,
        )
        .unwrap();
        fs::write(&source_path, b"changed candidate").unwrap();
        let (saver, _) = saver(app.path());
        let target = ProjectTarget::new("p123", working.path());
        assert!(saver
            .save_streamed(&target, "audio.m4a".into(), source, SaveKind::System,)
            .is_err());
        assert_eq!(
            fs::read(working.path().join("audio.m4a")).unwrap(),
            b"local candidate"
        );
    }

    #[test]
    fn unrelated_document_save_does_not_clean_a_live_stream_preparation() {
        let app = tempdir().unwrap();
        let working = tempdir().unwrap();
        let source_dir = tempdir().unwrap();
        fs::write(working.path().join("audio.m4a"), b"local").unwrap();
        fs::write(source_dir.path().join("remote.m4a"), b"remote").unwrap();
        let source =
            OpenedFileSource::open(source_dir.path(), "remote.m4a", &sha256_hex(b"remote"), 6)
                .unwrap();
        let (saver, _) = saver(app.path());
        let target = ProjectTarget::new("p123", working.path());
        let prepared = saver
            .prepare_streamed(&target, "audio.m4a".into(), source, SaveKind::System)
            .unwrap();
        saver
            .save(
                &target,
                SaveGroup {
                    writes: vec![SaveWrite::Put {
                        path: "other.md".into(),
                        bytes: b"other".to_vec(),
                    }],
                    kind: SaveKind::Edit,
                },
            )
            .unwrap();
        saver.commit_streamed(&target, prepared).unwrap();
        assert_eq!(
            fs::read(working.path().join("audio.m4a")).unwrap(),
            b"remote"
        );
        assert_eq!(fs::read(working.path().join("other.md")).unwrap(), b"other");
    }

    #[test]
    fn staged_stream_commit_allows_an_unrelated_save_then_rejects_a_changed_current() {
        let app = tempdir().unwrap();
        let working = tempdir().unwrap();
        let source_dir = tempdir().unwrap();
        fs::write(working.path().join("audio.m4a"), b"reviewed local").unwrap();
        fs::write(source_dir.path().join("remote.m4a"), b"remote candidate").unwrap();
        let remote_sha = sha256_hex(b"remote candidate");
        let source = OpenedFileSource::open(
            source_dir.path(),
            "remote.m4a",
            &remote_sha,
            b"remote candidate".len() as u64,
        )
        .unwrap();
        let (saver, _) = saver(app.path());
        let target = ProjectTarget::new("p123", working.path());
        let prepared = saver
            .prepare_streamed(&target, "audio.m4a".into(), source, SaveKind::System)
            .unwrap();

        saver
            .save(
                &target,
                SaveGroup {
                    writes: vec![SaveWrite::Put {
                        path: "other.md".into(),
                        bytes: b"unrelated".to_vec(),
                    }],
                    kind: SaveKind::Edit,
                },
            )
            .unwrap();
        saver
            .save(
                &target,
                SaveGroup {
                    writes: vec![SaveWrite::Put {
                        path: "audio.m4a".into(),
                        bytes: b"new local candidate".to_vec(),
                    }],
                    kind: SaveKind::Edit,
                },
            )
            .unwrap();

        assert!(matches!(
            saver.commit_streamed(&target, prepared),
            Err(VaultError::ConflictChanged)
        ));
        assert_eq!(
            fs::read(working.path().join("audio.m4a")).unwrap(),
            b"new local candidate"
        );
        assert_eq!(
            fs::read(working.path().join("other.md")).unwrap(),
            b"unrelated"
        );
    }
}
