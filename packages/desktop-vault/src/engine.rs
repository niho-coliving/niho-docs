use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, Weak};

use async_trait::async_trait;
use chrono::{SecondsFormat, Utc};
use tokio::sync::broadcast;

use crate::audio::{AudioDirection, AudioJob, AudioQueue};
use crate::conflicts::{self, now_millis, ProtectRequest};
use crate::journal::{gc_snapshots, prepare_recovery, recover_locked, LocalSaver};
use crate::lease::{LeaseInner, LeaseSession};
use crate::merge::{is_immutable_version_path, merge_runs_jsonl, plan_merge};
use crate::namespace::{lookup_root, pending_projects, random_token, Namespace};
use crate::outbox::{self, CommitItem, CommitOp, OutboxEntry, OutboxStatus};
use crate::protect::EditProtection;
use crate::provider::VaultProvider;
use crate::provider::BUFFERED_TRANSFER_MAX_BYTES;
use crate::scanner::{
    atomic_write, commit_temporary, format_system_time, hash_file, is_private_path,
    is_sync_ignored, open_file_no_follow, read_file_no_follow, reject_symlink_parents,
    remove_file_no_follow, same_instant, scan_target, sha256_hex, validate_relative_path,
    AtomicFileWriter, ScanLimits,
};
use crate::scheduler::SchedulerState;
use crate::state::{validate_project_id, ProjectPaths};
use crate::types::{
    BlockedPath, BlockedReason, CommitRequest, CommitResponse, CommitUpsert, ConflictEntry,
    ConflictKind, ConflictOrigin, ConflictPlan, ConflictSide, ConflictStatus, ConflictSummary,
    Device, FileKind, ManifestFile, ProjectSyncSnapshot, ProjectTarget, RemoteWriter, Result,
    ScannedCopy, SyncErrorInfo, SyncErrorKind, SyncEvent, SyncOptions, SyncScope, SyncStatus,
    TombstoneChoice, TombstoneInfo, Transfer, VaultError, VaultState, PROFILE_PROJECT_ID,
};

/// 1 回の gate で適用する取得済みファイルの上限（件数・bytes）。
const APPLY_CHUNK_FILES: usize = 16;
const APPLY_CHUNK_BYTES: usize = 16 * 1024 * 1024;
/// これより大きいファイルは gate の中で hash せず、長さと mtime で照合する。
const QUICK_CHECK_BYTES: u64 = 8 * 1024 * 1024;
/// 競合の写しを作るファイルの上限（音声と大きい other は写さない）。
const CONFLICT_COPY_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// schedule による flight の直前に、案件ごとの SyncOptions（案件名・lease・実行中）を返す。
#[async_trait]
pub trait FlightOptions: Send + Sync {
    async fn options(&self, target: &ProjectTarget) -> SyncOptions;
}

pub(crate) struct FlightOutcome {
    status: SyncStatus,
    newer_dirty: bool,
}

/// 本人（または未ログインの保存先）ごとの同期 engine。`Arc` で持つ。
pub struct SyncEngine {
    provider: Arc<dyn VaultProvider>,
    app_data: PathBuf,
    namespace: Namespace,
    root_id: String,
    root_epoch: Option<u64>,
    device: Device,
    protection: Arc<EditProtection>,
    limits: StdMutex<ScanLimits>,
    events: broadcast::Sender<SyncEvent>,
    pub(crate) weak: Weak<SyncEngine>,
    runtime: Option<tokio::runtime::Handle>,
    pub(crate) scheduler: StdMutex<SchedulerState>,
    pub(crate) audio: Arc<AudioQueue>,
    flight_options: StdMutex<Option<Arc<dyn FlightOptions>>>,
    shut_down: AtomicBool,
    tasks: StdMutex<Vec<tokio::task::AbortHandle>>,
    leases: StdMutex<Vec<Weak<LeaseInner>>>,
}

impl Drop for SyncEngine {
    fn drop(&mut self) {
        self.audio.stop();
        for task in lock(&self.tasks).drain(..) {
            task.abort();
        }
    }
}

fn lock<T>(mutex: &StdMutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct UploadPlan {
    ready: Vec<CommitItem>,
    held: BTreeSet<String>,
    quota: BTreeSet<String>,
    too_large: BTreeSet<String>,
}

impl SyncEngine {
    /// tokio runtime の中で作る（音声の worker と schedule の timer がその runtime で動く）。
    pub fn new(
        provider: Arc<dyn VaultProvider>,
        app_data: impl Into<PathBuf>,
        namespace: Namespace,
        root_id: String,
        device: Device,
        protection: Arc<EditProtection>,
    ) -> Arc<Self> {
        let (events, _) = broadcast::channel(1024);
        let app_data = app_data.into();
        let root_epoch = lookup_root(&app_data, &root_id)
            .ok()
            .flatten()
            .map(|binding| binding.epoch);
        Arc::new_cyclic(|weak| Self {
            provider,
            app_data,
            namespace,
            root_id,
            root_epoch,
            device,
            protection,
            limits: StdMutex::new(ScanLimits::default()),
            events,
            weak: weak.clone(),
            runtime: tokio::runtime::Handle::try_current().ok(),
            scheduler: StdMutex::new(SchedulerState::default()),
            audio: Arc::new(AudioQueue::default()),
            flight_options: StdMutex::new(None),
            shut_down: AtomicBool::new(false),
            tasks: StdMutex::new(Vec::new()),
            leases: StdMutex::new(Vec::new()),
        })
    }

    pub fn set_scan_limits(&self, limits: ScanLimits) {
        *lock(&self.limits) = limits;
    }

    /// schedule の flight が使う SyncOptions の供給元。実行時に差し替えられる。
    pub fn set_flight_options(&self, options: Arc<dyn FlightOptions>) {
        *lock(&self.flight_options) = Some(options);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SyncEvent> {
        self.events.subscribe()
    }

    /// engine の event channel（LeaseSession::with_events に渡せる）。
    pub fn event_sender(&self) -> broadcast::Sender<SyncEvent> {
        self.events.clone()
    }

    /// 同じ namespace・同じ event channel のローカル保存の入口。
    pub fn saver(&self) -> LocalSaver {
        LocalSaver::new(
            self.app_data.clone(),
            self.namespace.clone(),
            self.root_id.clone(),
            self.device.clone(),
        )
        .with_events(self.events.clone())
    }

    pub fn namespace(&self) -> &Namespace {
        &self.namespace
    }

    pub fn root_id(&self) -> &str {
        &self.root_id
    }

    pub fn device(&self) -> &Device {
        &self.device
    }

    pub fn protection(&self) -> &Arc<EditProtection> {
        &self.protection
    }

    pub fn is_shut_down(&self) -> bool {
        self.shut_down.load(Ordering::SeqCst)
    }

    /// timer・音声の queue・この engine が始めた lease の心拍を止める。outbox は disk に残る。
    /// 以後この engine は通信しない。
    pub fn shutdown(&self) {
        self.shut_down.store(true, Ordering::SeqCst);
        self.audio.stop();
        for task in lock(&self.tasks).drain(..) {
            task.abort();
        }
        for lease in lock(&self.leases).drain(..) {
            if let Some(inner) = lease.upgrade() {
                inner.stopped.store(true, Ordering::SeqCst);
            }
        }
        lock(&self.scheduler).clear();
    }

    pub(crate) fn net(&self) -> Result<&dyn VaultProvider> {
        if self.is_shut_down() {
            return Err(VaultError::ShutDown);
        }
        self.check_context()?;
        Ok(self.provider.as_ref())
    }

    pub(crate) fn emit(&self, event: SyncEvent) {
        if self.check_context().is_err() {
            return;
        }
        let _ = self.events.send(event);
    }

    pub(crate) fn paths(&self, project_id: &str) -> Result<ProjectPaths> {
        ProjectPaths::new(&self.app_data, &self.namespace, &self.root_id, project_id)
    }

    pub(crate) fn limits(&self) -> ScanLimits {
        *lock(&self.limits)
    }

    pub(crate) fn is_protected(&self, project_id: &str, path: &str) -> bool {
        self.protection.is_protected(project_id, path)
    }

    pub(crate) fn spawn_task<F>(&self, future: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        if self.is_shut_down() {
            return;
        }
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(handle) => handle,
            Err(_) => match &self.runtime {
                Some(handle) => handle.clone(),
                None => return,
            },
        };
        let task = handle.spawn(future);
        let mut tasks = lock(&self.tasks);
        tasks.retain(|task| !task.is_finished());
        tasks.push(task.abort_handle());
    }

    pub(crate) async fn flight_options_for(&self, target: &ProjectTarget) -> SyncOptions {
        let source = lock(&self.flight_options).clone();
        match source {
            Some(source) => source.options(target).await,
            None => SyncOptions::default(),
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

    /// この namespace で dirty・未確定 mutation・延期中の remote・未解決競合がある案件。起動時に schedule する。
    pub fn projects_with_pending(&self) -> Result<Vec<String>> {
        pending_projects(&self.app_data, &self.namespace, &self.root_id)
    }

    /// state・競合の index・メモリ上の音声と flight から UI 向けの状態を作る。通信しない。
    pub fn project_snapshot(&self, target: &ProjectTarget) -> Result<ProjectSyncSnapshot> {
        let paths = self.paths(&target.project_id)?;
        let (state, index) = {
            let _guard = paths.lock();
            (
                paths.read_state()?,
                conflicts::read_index(&target.working_copy)?,
            )
        };
        let mut deferred: BTreeSet<String> = state.deferred_remote.keys().cloned().collect();
        deferred.extend(state.deferred_deletes.iter().cloned());
        let remote_writers = state
            .deferred_remote
            .iter()
            .map(|(path, file)| {
                (
                    path.clone(),
                    RemoteWriter {
                        device_id: file.writer_device_id.clone(),
                        device_kind: file.writer_device_kind.clone(),
                    },
                )
            })
            .collect();
        Ok(ProjectSyncSnapshot {
            project_id: target.project_id.clone(),
            revision: state.base_revision,
            syncing: paths.io.syncing.load(Ordering::SeqCst),
            local_generation: state.local_generation,
            acknowledged_generation: state.acknowledged_generation,
            dirty: state.dirty.clone(),
            pending_mutation: !state.pending_mutations.is_empty(),
            conflicts: index
                .entries
                .iter()
                .map(|entry| ConflictSummary {
                    conflict_id: entry.conflict_id.clone(),
                    path: entry.path.clone(),
                    kind: entry.kind,
                    status: entry.status,
                    remote_device_id: entry.remote_device_id.clone(),
                    remote_device_kind: entry
                        .remote_file
                        .as_ref()
                        .and_then(|file| file.writer_device_kind.clone()),
                })
                .collect(),
            deferred: deferred.into_iter().collect(),
            remote_writers,
            quota_paths: state.quota_paths.iter().cloned().collect(),
            blocked: state
                .blocked
                .iter()
                .map(|(path, reason)| BlockedPath {
                    path: path.clone(),
                    reason: *reason,
                })
                .collect(),
            expired_audio: state.expired_audio.iter().cloned().collect(),
            audio: self.audio.transfers_for(&target.project_id),
            last_synced_at: state.last_synced_at.clone(),
            last_error: state.last_error.clone(),
            retry_after: state.retry_after.clone(),
            tombstone: state.tombstone,
        })
    }

    pub fn list_conflicts(&self, target: &ProjectTarget) -> Result<Vec<ConflictEntry>> {
        let paths = self.paths(&target.project_id)?;
        let _guard = paths.lock();
        Ok(conflicts::read_index(&target.working_copy)?.entries)
    }

    pub fn read_conflict_copy(
        &self,
        target: &ProjectTarget,
        conflict_id: &str,
        side: ConflictSide,
    ) -> Result<Option<Vec<u8>>> {
        let paths = self.paths(&target.project_id)?;
        let _guard = paths.lock();
        let index = conflicts::read_index(&target.working_copy)?;
        let Some(entry) = index.by_id(conflict_id) else {
            return Ok(None);
        };
        let copy = match side {
            ConflictSide::Local => entry.local_copy.as_deref(),
            ConflictSide::Remote => entry.remote_copy.as_deref(),
        };
        match copy {
            Some(copy) => conflicts::read_copy(&target.working_copy, copy),
            None => Ok(None),
        }
    }

    /// この engine の provider・端末で lease を取り、心拍の Offline を engine の event へ流す。
    /// shutdown で心拍を止める。
    pub async fn acquire_lease(
        &self,
        project_id: &str,
        lease_id: Option<String>,
    ) -> Result<LeaseSession> {
        self.net()?;
        let session = LeaseSession::acquire(
            self.provider.clone(),
            project_id.to_owned(),
            &self.device,
            lease_id,
        )
        .await?
        .with_events(self.events.clone());
        lock(&self.leases).push(Arc::downgrade(&session.inner));
        Ok(session)
    }

    /// 案件ごとの single-flight。実行中の要求は次の 1 回へ畳み、完了を待って同じ結果を受け取る。
    pub async fn sync(&self, target: &ProjectTarget, options: SyncOptions) -> Result<SyncStatus> {
        validate_project_id(&target.project_id)?;
        if self.is_shut_down() {
            return Err(VaultError::ShutDown);
        }
        if self.provider.is_local() || self.namespace.is_local() {
            return Ok(SyncStatus::LocalOnly);
        }
        let paths = self.paths(&target.project_id)?;
        let io = paths.io.clone();
        let (target, options) = loop {
            let notified = io.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut flight = io.flight();
                if !flight.running {
                    flight.running = true;
                    flight.pending = false;
                    flight.last = None;
                    flight.pending_request = None;
                    break (target.clone(), options);
                }
                flight.pending = true;
                flight.pending_request = Some((target.clone(), options.clone()));
            }
            notified.await;
            let flight = io.flight();
            if !flight.running {
                if let Some(result) = &flight.last {
                    if !(options.force && matches!(result, Ok(SyncStatus::Backoff { .. }))) {
                        return result.clone();
                    }
                }
            }
        };
        let guard = FlightGuard {
            io: io.clone(),
            active: true,
        };
        io.syncing.store(true, Ordering::SeqCst);
        self.emit(SyncEvent::Syncing {
            project_id: target.project_id.clone(),
        });
        let result = self.sync_flight(&target, &options, &paths).await;
        let status = match &result {
            Ok(status) => status.clone(),
            Err(error) => self.status_for_error(&paths, error),
        };
        {
            let mut flight = io.flight();
            flight.running = false;
            flight.last = Some(result.clone());
        }
        io.syncing.store(false, Ordering::SeqCst);
        guard.disarm();
        io.notify.notify_waiters();
        self.emit(SyncEvent::Done {
            project_id: target.project_id.clone(),
            status,
        });
        result
    }

    /// 利用者の「今すぐ同期」。保存済み backoff を無視する。
    pub async fn sync_now(
        &self,
        target: &ProjectTarget,
        mut options: SyncOptions,
    ) -> Result<SyncStatus> {
        options.force = true;
        self.sync(target, options).await
    }

    fn check_root_binding(&self) -> Result<()> {
        let current = lookup_root(&self.app_data, &self.root_id)?;
        if let Some(expected_epoch) = self.root_epoch {
            let binding = current.ok_or_else(|| {
                VaultError::NamespaceMismatch("the docs root binding disappeared".into())
            })?;
            if binding.account_key.as_deref() != self.namespace.account_key() {
                return Err(VaultError::NamespaceMismatch(
                    "the docs root is bound to another account".into(),
                ));
            }
            if binding.epoch != expected_epoch {
                return Err(VaultError::NamespaceMismatch(
                    "the docs root binding changed".into(),
                ));
            }
        } else if let Some(binding) = current {
            if binding.account_key.as_deref() != self.namespace.account_key() {
                return Err(VaultError::NamespaceMismatch(
                    "the docs root is bound to another account".into(),
                ));
            }
        }
        Ok(())
    }

    fn check_context(&self) -> Result<()> {
        self.check_root_binding()?;
        self.provider.check_context()
    }

    async fn sync_flight(
        &self,
        target: &ProjectTarget,
        options: &SyncOptions,
        paths: &ProjectPaths,
    ) -> Result<SyncStatus> {
        self.check_root_binding()?;
        if !options.force {
            let state = {
                let _guard = paths.lock();
                paths.read_state()?
            };
            if let Some(retry_after) = state.retry_after.as_deref() {
                if chrono::DateTime::parse_from_rfc3339(retry_after)
                    .is_ok_and(|retry| retry > Utc::now())
                {
                    return Ok(SyncStatus::Backoff {
                        retry_after: retry_after.to_owned(),
                    });
                }
            }
        }
        let mut rounds = 0;
        let mut target = target.clone();
        let mut options = options.clone();
        loop {
            rounds += 1;
            let mut conflicts = 0;
            let mut replans = 0;
            let result = loop {
                match self.sync_once(&target, &options, paths).await {
                    Err(VaultError::RevisionConflict)
                        if conflicts + 1 < options.max_revision_retries =>
                    {
                        conflicts += 1;
                    }
                    Err(VaultError::BlobMissing | VaultError::ImmutableVersion { .. })
                        if replans < 2 =>
                    {
                        replans += 1;
                    }
                    other => break other,
                }
            };
            let outcome = match result {
                Ok(outcome) => outcome,
                Err(error) => return self.handle_flight_error(paths, &options, error),
            };
            if matches!(
                outcome.status,
                SyncStatus::MovedDeletedProject { .. } | SyncStatus::Purged
            ) {
                return Ok(outcome.status);
            }
            let (pending, request) = {
                let mut flight = paths.io.flight();
                (
                    std::mem::take(&mut flight.pending),
                    flight.pending_request.take(),
                )
            };
            if rounds >= 3 {
                return Ok(outcome.status);
            }
            if (!pending && !outcome.newer_dirty)
                || (request.is_none()
                    && matches!(outcome.status, SyncStatus::TombstoneChoiceRequired))
            {
                return Ok(outcome.status);
            }
            if let Some((next_target, next_options)) = request {
                if next_target.project_id == target.project_id {
                    target = next_target;
                    options = next_options;
                }
            }
        }
    }

    fn handle_flight_error(
        &self,
        paths: &ProjectPaths,
        options: &SyncOptions,
        error: VaultError,
    ) -> Result<SyncStatus> {
        match &error {
            VaultError::RevisionConflict => {
                self.record_revision_backoff(paths, options)?;
                Err(error)
            }
            VaultError::ShutDown | VaultError::NamespaceMismatch(_) => Err(error),
            error if error.is_offline() => {
                let info = error_info(error);
                let _ = self.record_error(paths, info.clone(), None);
                self.emit(SyncEvent::Offline {
                    project_id: paths.project_id.clone(),
                    message: info.message,
                });
                Ok(SyncStatus::Offline)
            }
            VaultError::AuthRequired | VaultError::Forbidden => {
                let _ = self.record_error(paths, error_info(&error), None);
                Ok(SyncStatus::AuthRequired)
            }
            VaultError::RateLimited | VaultError::ProjectBusy => {
                let retry_after = (Utc::now() + chrono::Duration::seconds(60))
                    .to_rfc3339_opts(SecondsFormat::Secs, true);
                let _ = self.record_error(paths, error_info(&error), Some(retry_after.clone()));
                Ok(SyncStatus::Backoff { retry_after })
            }
            VaultError::ProjectPurged => {
                let _ = self.record_error(paths, error_info(&error), None);
                Ok(SyncStatus::Purged)
            }
            _ => {
                let _ = self.record_error(paths, error_info(&error), None);
                Err(error)
            }
        }
    }

    fn status_for_error(&self, paths: &ProjectPaths, error: &VaultError) -> SyncStatus {
        if matches!(error, VaultError::RevisionConflict) {
            let retry_after = {
                let _guard = paths.lock();
                paths.read_state().ok().and_then(|state| state.retry_after)
            };
            if let Some(retry_after) = retry_after {
                return SyncStatus::Backoff { retry_after };
            }
        }
        SyncStatus::Failed {
            error: error_info(error),
        }
    }

    fn record_error(
        &self,
        paths: &ProjectPaths,
        info: SyncErrorInfo,
        retry_after: Option<String>,
    ) -> Result<()> {
        let _guard = paths.lock();
        let mut state = paths.read_state()?;
        state.last_error = Some(info);
        if retry_after.is_some() {
            state.retry_after = retry_after;
        }
        paths.write_state(&mut state)
    }

    fn record_revision_backoff(&self, paths: &ProjectPaths, options: &SyncOptions) -> Result<()> {
        let _guard = paths.lock();
        let mut state = paths.read_state()?;
        state.conflict_failures = state.conflict_failures.saturating_add(1).min(3);
        let index = usize::from(state.conflict_failures.saturating_sub(1));
        let delay = options.conflict_backoff[index.min(options.conflict_backoff.len() - 1)];
        state.retry_after = Some(
            (Utc::now()
                + chrono::Duration::from_std(delay).unwrap_or(chrono::Duration::minutes(4)))
            .to_rfc3339_opts(SecondsFormat::Secs, true),
        );
        state.last_error = Some(error_info(&VaultError::RevisionConflict));
        paths.write_state(&mut state)
    }

    async fn sync_once(
        &self,
        target: &ProjectTarget,
        options: &SyncOptions,
        paths: &ProjectPaths,
    ) -> Result<FlightOutcome> {
        let project_id = target.project_id.as_str();
        let working_copy = target.working_copy.as_path();

        // 1. 通信より前に journal を片付ける。
        {
            let mut prepared = prepare_recovery(paths, target)?;
            let guard = paths.lock();
            let (_, recovered) = recover_locked(paths, target, &self.device, &mut prepared)?;
            drop(guard);
            self.emit_conflicts(project_id, recovered);
        }

        // 2. 結果の分からない mutation を同じ payload で再送する。
        self.resend_pending(target, paths).await?;

        // 3. 走査は gate の外。
        let scan_state = {
            let _guard = paths.lock();
            paths.read_state()?
        };
        let scanned = scan_target(
            working_copy,
            &target.scope,
            &scan_state,
            &self.device.device_id,
            self.device.device_kind.as_deref(),
            self.limits(),
        )?;

        // 4. gate の中で走査後の変化を確かめ、手元の差分を dirty にする。
        let (snapshot_generation, local, mut excluded) = {
            let _guard = paths.lock();
            let mut state = paths.read_state()?;
            let unstable = find_unstable(target, &scanned, &state);
            let local: Vec<ManifestFile> = scanned
                .files
                .iter()
                .filter(|file| !unstable.contains(&file.path))
                .cloned()
                .collect();
            state
                .blocked
                .retain(|_, reason| *reason == BlockedReason::ImmutableVersion);
            for (path, reason) in &scanned.blocked {
                state.blocked.insert(path.clone(), *reason);
            }
            let mut excluded = unstable;
            excluded.extend(scanned.blocked.keys().cloned());
            discover_dirty(&mut state, &local, &target.scope, &excluded);
            paths.write_state(&mut state)?;
            (state.dirty_generation, local, excluded)
        };
        let running = options.running || working_copy.join(".run.lock").exists();

        // 5. remote の manifest。
        let name = sanitize_name(options.project_name.as_deref());
        let remote = if target.scope.wire_scope() == crate::types::ProjectWireScope::Root {
            self.net()?.get_or_create_root().await?
        } else {
            self.net()?
                .get_or_create_project(project_id, name.as_deref())
                .await?
        };
        self.check_context()?;
        if remote.project_id != project_id
            || remote.files.iter().any(|file| {
                !target.scope.contains(&file.path)
                    || is_private_path(&file.path)
                    || is_sync_ignored(&file.path)
            })
        {
            return Err(VaultError::InvalidResponse(
                "remote manifest does not match the target scope".into(),
            ));
        }

        let (mut state, index) = {
            let _guard = paths.lock();
            (paths.read_state()?, conflicts::read_index(working_copy)?)
        };
        if remote.revision < state.base_revision {
            // 案件が作り直された（回収後・復元など）。古い base で手元の削除を計画しない。
            let _guard = paths.lock();
            let mut latest = paths.read_state()?;
            latest.base.clear();
            latest.base_revision = 0;
            paths.write_state(&mut latest)?;
            state = latest;
        }
        for (path, generation) in &state.dirty {
            if *generation > snapshot_generation {
                excluded.insert(path.clone());
            }
        }
        let keep = |path: &str| {
            target.scope.contains(path)
                && !is_sync_ignored(path)
                && !is_private_path(path)
                && !excluded.contains(path)
        };
        let base_files: Vec<ManifestFile> = state
            .base
            .iter()
            .filter(|file| keep(&file.path))
            .cloned()
            .collect();
        let local_files: Vec<ManifestFile> =
            local.into_iter().filter(|file| keep(&file.path)).collect();

        if remote.deleted {
            return self
                .handle_tombstone(
                    target,
                    options,
                    paths,
                    &state,
                    &base_files,
                    &local_files,
                    running,
                )
                .await;
        }

        let remote_files: Vec<ManifestFile> = remote
            .files
            .iter()
            .filter(|file| keep(&file.path))
            .cloned()
            .collect();
        let mut protected = self.protection.paths(project_id);
        protected.extend(index.entries.iter().map(|entry| entry.path.clone()));
        protected.extend(self.unknown_mutation_paths(paths, &state));
        let plan = plan_merge(&base_files, &local_files, &remote_files, &protected);
        let base_by = by_path(&base_files);
        let local_by = by_path(&local_files);
        let remote_by = by_path(&remote_files);

        // 6. 内容が一致した path は base を進め、dirty と解決中の競合を片付ける。
        let unavailable_shas: BTreeSet<String> = remote_files
            .iter()
            .filter(|file| file.kind == FileKind::Audio && !file.available)
            .map(|file| file.sha256.clone())
            .collect();
        // 3 つの一覧のどれにも無い path（作ってすぐ消した・解決で消した）も一致として片付ける。
        let candidates: BTreeSet<String> = index
            .entries
            .iter()
            .map(|entry| entry.path.clone())
            .chain(state.dirty.keys().cloned())
            .filter(|path| keep(path))
            .collect();
        self.settle_equal(
            target,
            paths,
            &base_by,
            &local_by,
            &remote_by,
            &candidates,
            snapshot_generation,
            &unavailable_shas,
        )?;
        let expired: BTreeSet<String> = remote_files
            .iter()
            .filter(|file| {
                file.kind == FileKind::Audio
                    && !file.available
                    && local_by.get(file.path.as_str()).map(|local| &local.sha256)
                        != Some(&file.sha256)
            })
            .map(|file| file.path.clone())
            .collect();

        // 7. 計画を競合の entry と照らして振り分ける。
        let mut conflict_plans: Vec<ConflictPlan> = Vec::new();
        let mut uploads: Vec<ManifestFile> = Vec::new();
        let mut remote_deletes: Vec<String> = Vec::new();
        let mut downloads: Vec<ManifestFile> = Vec::new();
        let mut local_deletes: Vec<String> = Vec::new();
        let mut defers: Vec<ManifestFile> = Vec::new();
        let mut defer_deletes: Vec<String> = Vec::new();
        let mut held: BTreeSet<String> = excluded.clone();
        for transfer in plan.transfers {
            let path = match &transfer {
                Transfer::Upload(file) | Transfer::Download(file) | Transfer::Defer(file) => {
                    file.path.clone()
                }
                Transfer::DeleteRemote(path)
                | Transfer::DeleteLocal(path)
                | Transfer::DeferDelete(path) => path.clone(),
            };
            let entry = index.by_path(&path);
            match transfer {
                Transfer::Upload(file) => {
                    let open = entry.is_some_and(|entry| entry.status == ConflictStatus::Open);
                    let immutable_blocked =
                        state.blocked.get(&path) == Some(&BlockedReason::ImmutableVersion);
                    if open || immutable_blocked {
                        held.insert(path);
                    } else {
                        uploads.push(file);
                    }
                }
                Transfer::DeleteRemote(path) => {
                    if entry.is_some_and(|entry| entry.status == ConflictStatus::Open) {
                        held.insert(path);
                    } else {
                        remote_deletes.push(path);
                    }
                }
                // 版の同名競合で手元の版が消された。手元側は versions/files/ に保護済みなので、クラウドの版を下ろす。
                Transfer::Download(file) | Transfer::Defer(file)
                    if entry.is_some_and(|entry| {
                        entry.kind == ConflictKind::Version
                            && entry.remote_sha256.as_deref() == Some(file.sha256.as_str())
                            && !local_by.contains_key(path.as_str())
                    }) && !self.is_protected(project_id, &path) =>
                {
                    downloads.push(file)
                }
                Transfer::Download(_)
                | Transfer::DeleteLocal(_)
                | Transfer::Defer(_)
                | Transfer::DeferDelete(_)
                    if entry.is_some() =>
                {
                    // 確認待ち・解決中に remote が変わった。双方を保護し直して確認を待つ。
                    let local = local_by.get(path.as_str()).copied().cloned();
                    let remote = remote_by.get(path.as_str()).copied().cloned();
                    conflict_plans.push(ConflictPlan {
                        kind: derive_kind(
                            &path,
                            base_by.contains_key(path.as_str()),
                            &local,
                            &remote,
                        ),
                        base: base_by.get(path.as_str()).copied().cloned(),
                        path: path.clone(),
                        local,
                        remote,
                    });
                    held.insert(path);
                }
                Transfer::Download(file) => downloads.push(file),
                Transfer::DeleteLocal(path) => local_deletes.push(path),
                Transfer::Defer(file) => defers.push(file),
                Transfer::DeferDelete(path) => defer_deletes.push(path),
            }
        }
        for conflict in &plan.conflicts {
            held.insert(conflict.path.clone());
        }
        conflict_plans.extend(plan.conflicts);

        let mut applied: Vec<String> = Vec::new();
        let mut extra_uploads: Vec<(ManifestFile, Vec<u8>, u64)> = Vec::new();
        let mut reference_upserts: Vec<CommitItem> = Vec::new();
        if !running {
            // 8. clean で保護されていない path に remote を適用し、保護中は取り置く。
            self.apply_remote(
                target,
                paths,
                &downloads,
                &local_deletes,
                &local_by,
                snapshot_generation,
                &mut applied,
            )
            .await?;
            self.defer_remote(target, paths, &defers, &defer_deletes)
                .await?;
            // 9. 競合は双方を保護して確認を待つ。
            let remote_paths: BTreeSet<String> =
                remote.files.iter().map(|file| file.path.clone()).collect();
            self.protect_conflicts(
                target,
                paths,
                &conflict_plans,
                remote.revision,
                &remote_paths,
                &mut extra_uploads,
                &mut reference_upserts,
            )
            .await?;
            // 10. runs.jsonl は行の和集合。
            self.union_runs(
                target,
                paths,
                &plan.runs_union,
                &local_by,
                &remote_by,
                snapshot_generation,
                &mut applied,
                &mut extra_uploads,
            )
            .await?;
        } else {
            for path in &plan.runs_union {
                held.insert(path.clone());
            }
        }
        if !applied.is_empty() {
            self.emit(SyncEvent::Applied {
                project_id: project_id.to_owned(),
                paths: applied.clone(),
            });
        }

        // engine 自身が書いた版・和集合は、走査後の保存として次の周を起こさない。
        let engine_marked: BTreeSet<String> = extra_uploads
            .iter()
            .map(|(file, _, _)| file.path.clone())
            .collect();

        // 11. 文書は通信枠の中で上げ、音声は queue へ渡す（待たない）。
        let upload_plan = self
            .upload_documents(
                target,
                options,
                paths,
                &uploads,
                extra_uploads,
                &remote_deletes,
                held,
                snapshot_generation,
            )
            .await?;
        let UploadPlan {
            mut ready,
            held,
            quota,
            too_large,
        } = upload_plan;
        ready.extend(reference_upserts);

        // 12. outbox を通して batch ごとに commit する。
        let (revision, oversized) = self
            .commit_ready(target, options, paths, ready, &held, remote.revision)
            .await?;

        // 13. 結果を state に残す。base は適用／確定した path だけが進んでいる。
        self.finish_flight(
            target,
            paths,
            revision,
            snapshot_generation,
            &quota,
            &too_large,
            &expired,
            oversized,
            running,
            &defers,
            &defer_deletes,
            &excluded,
            &engine_marked,
        )
    }

    fn unknown_mutation_paths(&self, paths: &ProjectPaths, state: &VaultState) -> BTreeSet<String> {
        let mut result = BTreeSet::new();
        for id in &state.pending_mutations {
            let entry = {
                let _guard = paths.lock();
                outbox::load(paths, id)
            };
            if let Ok(Some(entry)) = entry {
                result.extend(entry.paths().map(str::to_owned));
            }
        }
        result
    }

    async fn resend_pending(&self, target: &ProjectTarget, paths: &ProjectPaths) -> Result<()> {
        let ids = {
            let _guard = paths.lock();
            paths.read_state()?.pending_mutations
        };
        for id in ids {
            let entry = {
                let _guard = paths.lock();
                outbox::load(paths, &id)?
            };
            let Some(entry) = entry else {
                return Err(VaultError::OutboxRecoveryRequired {
                    mutation_id: id,
                    reason: "referenced outbox file is missing".into(),
                });
            };
            let result = self.send_entry(target, paths, &entry).await;
            match result {
                Ok(response) => {
                    self.acknowledge(target, paths, &entry, &response)?;
                }
                Err(error) => {
                    if let Some(stop) = self.commit_rejected(target, paths, &entry, error)? {
                        return Err(stop);
                    }
                }
            }
        }
        Ok(())
    }

    /// commit の失敗を outbox に反映する。flight を止める失敗は Some で返す。
    fn commit_rejected(
        &self,
        target: &ProjectTarget,
        paths: &ProjectPaths,
        entry: &OutboxEntry,
        error: VaultError,
    ) -> Result<Option<VaultError>> {
        match &error {
            VaultError::MutationMismatch
            | VaultError::OutboxRecoveryRequired { .. }
            | VaultError::ShutDown => Ok(Some(error.clone())),
            error if error.is_unknown_result() || error.is_auth_required() => {
                self.mark_sent(paths, entry)?;
                Ok(Some(error.clone()))
            }
            VaultError::BlobMissing => {
                self.discard_entry(paths, entry, |state| {
                    for upsert in &entry.request.upserts {
                        state.confirmed_blobs.remove(&upsert.sha256);
                    }
                })?;
                Ok(None)
            }
            VaultError::ImmutableVersion { path } => {
                let path = path.clone();
                self.discard_entry(paths, entry, |state| {
                    if !path.is_empty() {
                        state
                            .blocked
                            .insert(path.clone(), BlockedReason::ImmutableVersion);
                    }
                })?;
                Ok(None)
            }
            VaultError::QuotaExceeded { .. } => {
                self.discard_entry(paths, entry, |state| {
                    for upsert in &entry.request.upserts {
                        state.quota_paths.insert(upsert.path.clone());
                    }
                })?;
                for upsert in &entry.request.upserts {
                    self.emit(SyncEvent::Quota {
                        project_id: target.project_id.clone(),
                        path: upsert.path.clone(),
                    });
                }
                Ok(None)
            }
            _ => {
                // 未確定と分かった（409 revision・lease・tombstone・400 など）。新しい mutation で再計画する。
                self.discard_entry(paths, entry, |_| {})?;
                Ok(None)
            }
        }
    }

    async fn send_entry(
        &self,
        target: &ProjectTarget,
        paths: &ProjectPaths,
        entry: &OutboxEntry,
    ) -> Result<CommitResponse> {
        let frozen_body = entry.frozen_body()?;
        // A durable Sent marker must exist before the provider can dispatch any network request.
        self.mark_sent(paths, entry)?;
        self.net()?
            .commit_raw(&target.project_id, &entry.request, frozen_body)
            .await
    }

    fn mark_sent(&self, paths: &ProjectPaths, entry: &OutboxEntry) -> Result<()> {
        let _guard = paths.lock();
        let mut sent = entry.clone();
        sent.status = OutboxStatus::Sent;
        let recovery = |reason: &str| VaultError::OutboxRecoveryRequired {
            mutation_id: entry.mutation_id.clone(),
            reason: reason.to_owned(),
        };
        let current = outbox::load(paths, &entry.mutation_id)
            .map_err(|_| recovery("outbox file cannot be read before dispatch"))?
            .ok_or_else(|| recovery("referenced outbox file is missing before dispatch"))?;
        if current == sent {
            return Ok(());
        }
        if &current != entry {
            return Err(recovery("outbox entry changed before dispatch"));
        }
        outbox::store(paths, &sent)
            .map_err(|_| recovery("sent marker could not be persisted before dispatch"))
    }

    fn discard_entry(
        &self,
        paths: &ProjectPaths,
        entry: &OutboxEntry,
        update: impl FnOnce(&mut VaultState),
    ) -> Result<()> {
        let _guard = paths.lock();
        let mut state = paths.read_state()?;
        state
            .pending_mutations
            .retain(|pending| pending != &entry.mutation_id);
        update(&mut state);
        paths.write_state(&mut state)?;
        outbox::remove(paths, &entry.mutation_id)?;
        gc_snapshots(paths)?;
        Ok(())
    }

    /// 200 の応答を ack として永続化する。同じ世代の dirty だけを消す。
    fn acknowledge(
        &self,
        target: &ProjectTarget,
        paths: &ProjectPaths,
        entry: &OutboxEntry,
        response: &CommitResponse,
    ) -> Result<u64> {
        self.check_context()?;
        if response.mutation_id != entry.mutation_id {
            return Err(VaultError::InvalidResponse(
                "commit response mutationId mismatch".into(),
            ));
        }
        let expected_revision =
            entry.request.base_revision.checked_add(1).ok_or_else(|| {
                VaultError::InvalidResponse("commit base revision overflow".into())
            })?;
        if response.revision != expected_revision {
            return Err(VaultError::InvalidResponse(
                "commit response revision mismatch".into(),
            ));
        }
        let working_copy = target.working_copy.as_path();
        let guard = paths.lock();
        let mut state = paths.read_state()?;
        let mut index = conflicts::read_index(working_copy)?;
        for upsert in &entry.request.upserts {
            state.set_base(ManifestFile {
                path: upsert.path.clone(),
                sha256: upsert.sha256.clone(),
                bytes: upsert.bytes,
                kind: FileKind::from_path(&upsert.path),
                modified_at: upsert.modified_at.clone(),
                writer_device_id: entry.request.device_id.clone(),
                writer_device_kind: entry.request.device_kind.clone(),
                retained_until: None,
                available: true,
            });
        }
        for path in &entry.request.deletes {
            state.remove_base(path);
        }
        let mut index_changed = false;
        for (path, generation) in &entry.generations {
            if state.dirty.get(path) == Some(generation) {
                state.dirty.remove(path);
            }
            state.quota_paths.remove(path);
            let resolved = index.by_path(path).is_some_and(|conflict| {
                conflict.status == ConflictStatus::Resolving
                    && conflict
                        .resolution_generation
                        .is_some_and(|resolution| resolution <= *generation)
            });
            if resolved {
                if let Some(conflict) = index.take(path) {
                    conflicts::remove_copies(working_copy, &conflict);
                }
                state.conflicts.remove(path);
                if state.blocked.get(path) == Some(&BlockedReason::ImmutableVersion) {
                    state.blocked.remove(path);
                }
                index_changed = true;
            }
        }
        state.base_revision = state.base_revision.max(response.revision);
        state
            .pending_mutations
            .retain(|pending| pending != &entry.mutation_id);
        paths.write_state(&mut state)?;
        if index_changed {
            conflicts::write_index(working_copy, &index)?;
        }
        outbox::remove(paths, &entry.mutation_id)?;
        gc_snapshots(paths)?;
        drop(guard);
        self.emit(SyncEvent::Committed {
            project_id: target.project_id.clone(),
            revision: response.revision,
            paths: entry.paths().map(str::to_owned).collect(),
        });
        Ok(response.revision)
    }

    #[allow(clippy::too_many_arguments)]
    fn settle_equal(
        &self,
        target: &ProjectTarget,
        paths: &ProjectPaths,
        base_by: &BTreeMap<&str, &ManifestFile>,
        local_by: &BTreeMap<&str, &ManifestFile>,
        remote_by: &BTreeMap<&str, &ManifestFile>,
        candidates: &BTreeSet<String>,
        snapshot_generation: u64,
        unavailable_shas: &BTreeSet<String>,
    ) -> Result<()> {
        let all: BTreeSet<&str> = base_by
            .keys()
            .chain(local_by.keys())
            .chain(remote_by.keys())
            .copied()
            .chain(candidates.iter().map(String::as_str))
            .collect();
        let equal: Vec<&str> = all
            .into_iter()
            .filter(|path| {
                local_by.get(path).map(|file| &file.sha256)
                    == remote_by.get(path).map(|file| &file.sha256)
            })
            .collect();
        let working_copy = target.working_copy.as_path();
        let _guard = paths.lock();
        let mut state = paths.read_state()?;
        let mut index = conflicts::read_index(working_copy)?;
        let mut index_changed = false;
        for sha in unavailable_shas {
            state.confirmed_blobs.remove(sha);
        }
        for path in equal {
            match remote_by.get(path) {
                Some(file) => {
                    if state.base_file(path) != Some(*file) {
                        state.set_base((*file).clone());
                    }
                }
                None => state.remove_base(path),
            }
            if state
                .dirty
                .get(path)
                .is_some_and(|generation| *generation <= snapshot_generation)
            {
                state.dirty.remove(path);
            }
            state.quota_paths.remove(path);
            state.deferred_remote.remove(path);
            state.deferred_deletes.remove(path);
            if state.blocked.get(path) == Some(&BlockedReason::ImmutableVersion) {
                state.blocked.remove(path);
            }
            if let Some(entry) = index.take(path) {
                conflicts::remove_copies(working_copy, &entry);
                state.conflicts.remove(path);
                index_changed = true;
            }
        }
        // index に無い競合の写しは state から外す。
        let open: BTreeSet<String> = index
            .entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect();
        state.conflicts.retain(|path, _| open.contains(path));
        for entry in &index.entries {
            state
                .conflicts
                .insert(entry.path.clone(), entry.conflict_id.clone());
        }
        paths.write_state(&mut state)?;
        if index_changed {
            conflicts::write_index(working_copy, &index)?;
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn apply_remote(
        &self,
        target: &ProjectTarget,
        paths: &ProjectPaths,
        downloads: &[ManifestFile],
        local_deletes: &[String],
        local_by: &BTreeMap<&str, &ManifestFile>,
        snapshot_generation: u64,
        applied: &mut Vec<String>,
    ) -> Result<()> {
        let project_id = target.project_id.as_str();
        let mut chunk: Vec<(ManifestFile, Vec<u8>)> = Vec::new();
        let mut chunk_bytes = 0;
        for file in downloads {
            if file.kind == FileKind::Audio {
                // 音声は flight で待たず queue で下ろす。base はそこで進む。
                self.enqueue_audio(AudioJob {
                    target: target.clone(),
                    file: file.clone(),
                    direction: AudioDirection::Download,
                    expected_local: local_by.get(file.path.as_str()).copied().cloned(),
                    snapshot_generation,
                    attempts: 0,
                    not_before: None,
                });
                continue;
            }
            if file.bytes > BUFFERED_TRANSFER_MAX_BYTES {
                // 大きいファイルはメモリへ載せず、一時ファイルへ下ろして照合してから gate の中で rename する（#18653）。
                let Some(temporary) =
                    download_to_temporary(self.net()?, project_id, &target.working_copy, file)
                        .await?
                else {
                    continue;
                };
                self.apply_temporary(
                    target,
                    paths,
                    file,
                    &temporary,
                    local_by,
                    snapshot_generation,
                    applied,
                )?;
                continue;
            }
            let bytes = match staged_bytes(paths, file) {
                Some(bytes) => bytes,
                None => match self.net()?.download_blob(project_id, file).await? {
                    Some(bytes) => bytes,
                    None => continue,
                },
            };
            if !content_is(file, &bytes) {
                return Err(VaultError::InvalidResponse(format!(
                    "blob sha256 mismatch: {}",
                    file.path
                )));
            }
            chunk_bytes += bytes.len();
            chunk.push((file.clone(), bytes));
            if chunk.len() >= APPLY_CHUNK_FILES || chunk_bytes >= APPLY_CHUNK_BYTES {
                self.apply_chunk(
                    target,
                    paths,
                    &mut chunk,
                    local_by,
                    snapshot_generation,
                    applied,
                )?;
                chunk_bytes = 0;
            }
        }
        self.apply_chunk(
            target,
            paths,
            &mut chunk,
            local_by,
            snapshot_generation,
            applied,
        )?;
        if local_deletes.is_empty() {
            return Ok(());
        }
        self.check_context()?;
        let working_copy = target.working_copy.as_path();
        let _guard = paths.lock();
        if working_copy.join(".run.lock").exists() {
            return Ok(());
        }
        let mut state = paths.read_state()?;
        for path in local_deletes {
            if !self.clean_for_apply(
                &state,
                project_id,
                working_copy,
                path,
                local_by.get(path.as_str()).copied(),
                snapshot_generation,
            )? {
                continue;
            }
            remove_file_no_follow(working_copy, path)?;
            state.remove_base(path);
            state.deferred_remote.remove(path);
            state.deferred_deletes.remove(path);
            applied.push(path.clone());
        }
        paths.write_state(&mut state)
    }

    /// 取得済みの bytes を gate の中で再確認してから書く。
    fn apply_chunk(
        &self,
        target: &ProjectTarget,
        paths: &ProjectPaths,
        chunk: &mut Vec<(ManifestFile, Vec<u8>)>,
        local_by: &BTreeMap<&str, &ManifestFile>,
        snapshot_generation: u64,
        applied: &mut Vec<String>,
    ) -> Result<()> {
        if chunk.is_empty() {
            return Ok(());
        }
        self.check_context()?;
        let items = std::mem::take(chunk);
        let working_copy = target.working_copy.as_path();
        let _guard = paths.lock();
        if working_copy.join(".run.lock").exists() {
            return Ok(());
        }
        let mut state = paths.read_state()?;
        for (file, bytes) in items {
            if !self.clean_for_apply(
                &state,
                &target.project_id,
                working_copy,
                &file.path,
                local_by.get(file.path.as_str()).copied(),
                snapshot_generation,
            )? {
                continue;
            }
            write_download(working_copy, &file, &bytes)?;
            let _ = paths.remove(&format!("staging/{}", file.sha256));
            state.deferred_remote.remove(&file.path);
            state.deferred_deletes.remove(&file.path);
            applied.push(file.path.clone());
            state.set_base(file);
        }
        paths.write_state(&mut state)
    }

    /// 一時ファイルへ下ろした 1 件を、gate の中で再確認してから rename する。反映しなければ一時ファイルを消す。
    #[allow(clippy::too_many_arguments)]
    fn apply_temporary(
        &self,
        target: &ProjectTarget,
        paths: &ProjectPaths,
        file: &ManifestFile,
        temporary: &Path,
        local_by: &BTreeMap<&str, &ManifestFile>,
        snapshot_generation: u64,
        applied: &mut Vec<String>,
    ) -> Result<()> {
        let working_copy = target.working_copy.as_path();
        let result = (|| -> Result<bool> {
            self.check_context()?;
            let _guard = paths.lock();
            if working_copy.join(".run.lock").exists() {
                return Ok(false);
            }
            let mut state = paths.read_state()?;
            if !self.clean_for_apply(
                &state,
                &target.project_id,
                working_copy,
                &file.path,
                local_by.get(file.path.as_str()).copied(),
                snapshot_generation,
            )? {
                return Ok(false);
            }
            commit_temporary(working_copy, &file.path, temporary)?;
            set_mtime(working_copy, file);
            let _ = paths.remove(&format!("staging/{}", file.sha256));
            state.deferred_remote.remove(&file.path);
            state.deferred_deletes.remove(&file.path);
            applied.push(file.path.clone());
            state.set_base(file.clone());
            paths.write_state(&mut state)?;
            Ok(true)
        })();
        if !matches!(result, Ok(true)) {
            let _ = fs::remove_file(temporary);
        }
        result.map(|_| ())
    }

    /// 走査後に保存・編集保護・内容の変化が無いこと（gate の中で呼ぶ）。
    pub(crate) fn clean_for_apply(
        &self,
        state: &VaultState,
        project_id: &str,
        working_copy: &Path,
        path: &str,
        expected: Option<&ManifestFile>,
        snapshot_generation: u64,
    ) -> Result<bool> {
        if self.is_protected(project_id, path)
            || state
                .dirty
                .get(path)
                .is_some_and(|generation| *generation > snapshot_generation)
        {
            return Ok(false);
        }
        content_matches(working_copy, path, expected)
    }

    async fn defer_remote(
        &self,
        target: &ProjectTarget,
        paths: &ProjectPaths,
        defers: &[ManifestFile],
        defer_deletes: &[String],
    ) -> Result<()> {
        if defers.is_empty() && defer_deletes.is_empty() {
            return Ok(());
        }
        let (deferred, deferred_deletes) = {
            let _guard = paths.lock();
            let state = paths.read_state()?;
            (state.deferred_remote, state.deferred_deletes)
        };
        let mut newly: Vec<ManifestFile> = Vec::new();
        for file in defers {
            if deferred
                .get(&file.path)
                .is_some_and(|existing| existing.sha256 == file.sha256)
            {
                continue;
            }
            // 一時置き場へはメモリで扱える大きさだけ置く。大きいファイルは反映するときに下ろす（#18653）。
            if file.kind != FileKind::Audio
                && file.bytes <= BUFFERED_TRANSFER_MAX_BYTES
                && staged_bytes(paths, file).is_none()
            {
                if let Some(bytes) = self.net()?.download_blob(&target.project_id, file).await? {
                    if content_is(file, &bytes) {
                        paths.write_bytes(&format!("staging/{}", file.sha256), &bytes)?;
                    }
                }
            }
            newly.push(file.clone());
        }
        let newly_deleted: Vec<String> = defer_deletes
            .iter()
            .filter(|path| !deferred_deletes.contains(*path))
            .cloned()
            .collect();
        if newly.is_empty() && newly_deleted.is_empty() {
            return Ok(());
        }
        {
            let _guard = paths.lock();
            let mut state = paths.read_state()?;
            for file in &newly {
                state.deferred_deletes.remove(&file.path);
                state
                    .deferred_remote
                    .insert(file.path.clone(), file.clone());
            }
            for path in &newly_deleted {
                state.deferred_remote.remove(path);
                state.deferred_deletes.insert(path.clone());
            }
            paths.write_state(&mut state)?;
        }
        for path in newly
            .iter()
            .map(|file| file.path.clone())
            .chain(newly_deleted)
        {
            self.emit(SyncEvent::Deferred {
                project_id: target.project_id.clone(),
                path,
            });
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn protect_conflicts(
        &self,
        target: &ProjectTarget,
        paths: &ProjectPaths,
        plans: &[ConflictPlan],
        remote_revision: u64,
        remote_paths: &BTreeSet<String>,
        extra_uploads: &mut Vec<(ManifestFile, Vec<u8>, u64)>,
        reference_upserts: &mut Vec<CommitItem>,
    ) -> Result<()> {
        let working_copy = target.working_copy.as_path();
        let write_versions = |path: &str| target.scope.allows_version_of(path);
        let mut new_conflicts = Vec::new();
        for plan in plans {
            let existing = {
                let _guard = paths.lock();
                conflicts::read_index(working_copy)?
                    .by_path(&plan.path)
                    .cloned()
            };
            let remote_sha = plan.remote.as_ref().map(|file| file.sha256.clone());
            let copyable = |file: Option<&ManifestFile>| {
                file.is_none_or(|file| {
                    file.kind != FileKind::Audio && file.bytes <= CONFLICT_COPY_MAX_BYTES
                })
            };
            let copy = copyable(plan.local.as_ref()) && copyable(plan.remote.as_ref());
            if let Some(existing) = &existing {
                let same_remote = existing.remote_sha256 == remote_sha;
                let retry_remote_copy = same_remote
                    && copy
                    && plan.remote.as_ref().is_some_and(|file| file.available)
                    && existing.remote_copy.is_none();
                let missing_reference = same_remote
                    && !copy
                    && existing
                        .remote_version_path
                        .as_ref()
                        .is_some_and(|path| !remote_paths.contains(path));
                if same_remote && !retry_remote_copy && !missing_reference {
                    continue;
                }
            }
            // remote の bytes は gate の外で取る。取れなければ手元だけを保護して確認待ちにする。
            let remote_bytes = match &plan.remote {
                Some(file) if copy && file.available => match staged_bytes(paths, file) {
                    Some(bytes) => Some(bytes),
                    None => match self.net()?.download_blob(&target.project_id, file).await {
                        Ok(Some(bytes)) if content_is(file, &bytes) => Some(bytes),
                        Ok(_) => None,
                        Err(VaultError::ShutDown) => return Err(VaultError::ShutDown),
                        Err(_) => None,
                    },
                },
                _ => None,
            };
            let guard = paths.lock();
            let mut state = paths.read_state()?;
            let mut index = conflicts::read_index(working_copy)?;
            let existing = index.by_path(&plan.path).cloned();
            let entry = if copy {
                let local = read_file_no_follow(working_copy, &plan.path)?.map(|bytes| {
                    let modified_at = fs::symlink_metadata(working_copy.join(&plan.path))
                        .and_then(|metadata| metadata.modified())
                        .map(format_system_time)
                        .unwrap_or_else(|_| now_millis());
                    (bytes, modified_at)
                });
                let kind = if plan.kind == ConflictKind::Version {
                    ConflictKind::Version
                } else {
                    derive_kind(
                        &plan.path,
                        plan.base.is_some(),
                        &local.as_ref().map(|_| ()),
                        &plan.remote,
                    )
                };
                let protected = conflicts::protect(
                    working_copy,
                    existing.as_ref(),
                    ProtectRequest {
                        path: &plan.path,
                        kind,
                        origin: ConflictOrigin::Sync,
                        base_sha256: plan.base.as_ref().map(|file| file.sha256.clone()),
                        local,
                        remote: plan.remote.clone(),
                        remote_bytes,
                        remote_revision,
                        write_versions: write_versions(&plan.path),
                    },
                )?;
                if !protected.version_files.is_empty() {
                    let generation = state.mark_dirty_paths(
                        protected.version_files.iter().map(|(path, _)| path.clone()),
                    );
                    if protected.version_files.len() > 1 {
                        state.groups.insert(
                            generation,
                            protected
                                .version_files
                                .iter()
                                .map(|(path, _)| path.clone())
                                .collect(),
                        );
                    }
                    for (path, bytes) in protected.version_files {
                        let modified_at = fs::symlink_metadata(working_copy.join(&path))
                            .and_then(|metadata| metadata.modified())
                            .map(format_system_time)
                            .unwrap_or_else(|_| now_millis());
                        let file = ManifestFile {
                            sha256: sha256_hex(&bytes),
                            bytes: bytes.len() as u64,
                            kind: FileKind::from_path(&path),
                            modified_at,
                            writer_device_id: self.device.device_id.clone(),
                            writer_device_kind: self.device.device_kind.clone(),
                            retained_until: None,
                            available: true,
                            path,
                        };
                        extra_uploads.push((file, bytes, generation));
                    }
                }
                protected.entry
            } else {
                // 音声・大きいファイルは写さない。remote の版はクラウドの blob を参照する版 path で残す。
                let mut entry = conflicts::record_reference(
                    existing.as_ref(),
                    &plan.path,
                    plan.kind,
                    plan.base.as_ref(),
                    plan.local.as_ref(),
                    plan.remote.as_ref(),
                    remote_revision,
                );
                if write_versions(&plan.path) && plan.kind != ConflictKind::Version {
                    if let Some(remote) = plan.remote.as_ref().filter(|file| file.available) {
                        if entry.remote_version_path.is_none() {
                            let version_id = conflicts::new_version_id();
                            entry.remote_version_path =
                                Some(conflicts::version_path_for(&plan.path, &version_id));
                            entry.remote_version_id = Some(version_id);
                        }
                        if let Some(version_path) = &entry.remote_version_path {
                            if !remote_paths.contains(version_path) {
                                reference_upserts.push(CommitItem {
                                    path: version_path.clone(),
                                    generation: 0,
                                    op: CommitOp::Upsert(CommitUpsert {
                                        path: version_path.clone(),
                                        sha256: remote.sha256.clone(),
                                        bytes: remote.bytes,
                                        modified_at: remote.modified_at.clone(),
                                    }),
                                });
                            }
                        }
                    }
                }
                entry
            };
            if entry.kind == ConflictKind::Version {
                state
                    .blocked
                    .insert(plan.path.clone(), BlockedReason::ImmutableVersion);
            }
            state
                .conflicts
                .insert(plan.path.clone(), entry.conflict_id.clone());
            state.deferred_remote.remove(&plan.path);
            state.deferred_deletes.remove(&plan.path);
            index.upsert(entry.clone());
            paths.write_state(&mut state)?;
            conflicts::write_index(working_copy, &index)?;
            drop(guard);
            new_conflicts.push(entry);
        }
        self.emit_conflicts(&target.project_id, new_conflicts);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn union_runs(
        &self,
        target: &ProjectTarget,
        paths: &ProjectPaths,
        runs: &[String],
        local_by: &BTreeMap<&str, &ManifestFile>,
        remote_by: &BTreeMap<&str, &ManifestFile>,
        snapshot_generation: u64,
        applied: &mut Vec<String>,
        extra_uploads: &mut Vec<(ManifestFile, Vec<u8>, u64)>,
    ) -> Result<()> {
        let working_copy = target.working_copy.as_path();
        for path in runs {
            if self.is_protected(&target.project_id, path) {
                continue;
            }
            let remote_file = remote_by.get(path.as_str()).copied();
            let remote_bytes = match remote_file {
                Some(file) => match staged_bytes(paths, file) {
                    Some(bytes) => bytes,
                    None => match self.net()?.download_blob(&target.project_id, file).await? {
                        Some(bytes) => bytes,
                        None => continue,
                    },
                },
                None => Vec::new(),
            };
            let _guard = paths.lock();
            if working_copy.join(".run.lock").exists() {
                continue;
            }
            let mut state = paths.read_state()?;
            if !self.clean_for_apply(
                &state,
                &target.project_id,
                working_copy,
                path,
                local_by.get(path.as_str()).copied(),
                snapshot_generation,
            )? {
                continue;
            }
            let local_bytes = read_file_no_follow(working_copy, path)?;
            let merged =
                merge_runs_jsonl(local_bytes.as_deref().unwrap_or_default(), &remote_bytes)?;
            let merged_sha = sha256_hex(&merged);
            if let Some(remote) = remote_file.filter(|file| file.sha256 == merged_sha) {
                // 和集合が remote と同じ。手元を揃えて base を進める。
                if local_bytes.as_deref() != Some(merged.as_slice()) {
                    write_download(working_copy, remote, &merged)?;
                    applied.push(path.clone());
                }
                state.set_base(remote.clone());
                if state
                    .dirty
                    .get(path)
                    .is_some_and(|generation| *generation <= snapshot_generation)
                {
                    state.dirty.remove(path);
                }
                paths.write_state(&mut state)?;
                continue;
            }
            let generation = if local_bytes.as_deref() == Some(merged.as_slice()) {
                match state.dirty.get(path) {
                    Some(generation) => *generation,
                    None => state.mark_dirty(path.clone()),
                }
            } else {
                atomic_write(working_copy, path, &merged)?;
                applied.push(path.clone());
                state.mark_dirty(path.clone())
            };
            let modified_at = fs::symlink_metadata(working_copy.join(path))
                .and_then(|metadata| metadata.modified())
                .map(format_system_time)
                .unwrap_or_else(|_| now_millis());
            paths.write_state(&mut state)?;
            extra_uploads.push((
                ManifestFile {
                    path: path.clone(),
                    sha256: merged_sha,
                    bytes: merged.len() as u64,
                    kind: FileKind::from_path(path),
                    modified_at,
                    writer_device_id: self.device.device_id.clone(),
                    writer_device_kind: self.device.device_kind.clone(),
                    retained_until: None,
                    available: true,
                },
                merged,
                generation,
            ));
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn upload_documents(
        &self,
        target: &ProjectTarget,
        options: &SyncOptions,
        paths: &ProjectPaths,
        uploads: &[ManifestFile],
        extra_uploads: Vec<(ManifestFile, Vec<u8>, u64)>,
        remote_deletes: &[String],
        mut held: BTreeSet<String>,
        snapshot_generation: u64,
    ) -> Result<UploadPlan> {
        let project_id = target.project_id.as_str();
        let working_copy = target.working_copy.as_path();
        let state = {
            let _guard = paths.lock();
            paths.read_state()?
        };
        let mut ready = Vec::new();
        let mut quota = BTreeSet::new();
        let mut too_large = BTreeSet::new();
        let mut candidates: Vec<(ManifestFile, Option<Vec<u8>>, u64)> = uploads
            .iter()
            .map(|file| {
                (
                    file.clone(),
                    None,
                    state.dirty.get(&file.path).copied().unwrap_or(0),
                )
            })
            .collect();
        candidates.extend(
            extra_uploads
                .into_iter()
                .map(|(file, bytes, generation)| (file, Some(bytes), generation)),
        );
        for (file, bytes, generation) in candidates {
            if file.kind == FileKind::Audio {
                if state.confirmed_blobs.contains(&file.sha256) {
                    ready.push(upsert_item(&file, generation));
                } else {
                    held.insert(file.path.clone());
                    // 容量で止まった音声は、次の保存か「今すぐ同期」まで上げ直さない。
                    if !state.quota_paths.contains(&file.path) || options.force {
                        self.enqueue_audio(AudioJob {
                            target: target.clone(),
                            file: file.clone(),
                            direction: AudioDirection::Upload,
                            expected_local: None,
                            snapshot_generation,
                            attempts: 0,
                            not_before: None,
                        });
                    }
                }
                continue;
            }
            let result = match bytes {
                Some(bytes) => self.net()?.upload_blob(project_id, &file, bytes).await,
                None if file.bytes > BUFFERED_TRANSFER_MAX_BYTES => {
                    // 大きいファイルはメモリへ載せず、開いたファイルから送る（#18653）。照合は provider が送る前後に行う。
                    match open_file_no_follow(working_copy, &file.path)? {
                        Some(mut source) => {
                            match self
                                .net()?
                                .upload_blob_file(project_id, &file, &mut source)
                                .await
                            {
                                Err(VaultError::InvalidResponse(_))
                                    if !content_matches(working_copy, &file.path, Some(&file))? =>
                                {
                                    // 走査の後に変わった。次の flight で計画し直す。
                                    held.insert(file.path.clone());
                                    continue;
                                }
                                result => result,
                            }
                        }
                        None => {
                            held.insert(file.path.clone());
                            continue;
                        }
                    }
                }
                None => match read_file_no_follow(working_copy, &file.path)? {
                    Some(bytes) if content_is(&file, &bytes) => {
                        self.net()?.upload_blob(project_id, &file, bytes).await
                    }
                    _ => {
                        // 走査の後に変わった。次の flight で計画し直す。
                        held.insert(file.path.clone());
                        continue;
                    }
                },
            };
            match result {
                Ok(()) => ready.push(upsert_item(&file, generation)),
                Err(VaultError::QuotaExceeded { .. }) => {
                    held.insert(file.path.clone());
                    quota.insert(file.path.clone());
                    self.emit(SyncEvent::Quota {
                        project_id: project_id.to_owned(),
                        path: file.path.clone(),
                    });
                }
                Err(VaultError::BlobTooLarge(_)) => {
                    held.insert(file.path.clone());
                    too_large.insert(file.path.clone());
                }
                Err(error) => return Err(error),
            }
        }
        for path in remote_deletes {
            ready.push(CommitItem {
                path: path.clone(),
                generation: state.dirty.get(path).copied().unwrap_or(0),
                op: CommitOp::Delete,
            });
        }
        Ok(UploadPlan {
            ready,
            held,
            quota,
            too_large,
        })
    }

    /// 依存 group を保ったまま batch に分け、outbox に固定してから送る。
    async fn commit_ready(
        &self,
        target: &ProjectTarget,
        options: &SyncOptions,
        paths: &ProjectPaths,
        ready: Vec<CommitItem>,
        held: &BTreeSet<String>,
        mut revision: u64,
    ) -> Result<(u64, bool)> {
        if ready.is_empty() {
            return Ok((revision, false));
        }
        let state = {
            let _guard = paths.lock();
            paths.read_state()?
        };
        let mut grouped: BTreeMap<u64, Vec<CommitItem>> = BTreeMap::new();
        let mut groups: Vec<Vec<CommitItem>> = Vec::new();
        for item in ready {
            let in_group = state
                .groups
                .get(&item.generation)
                .is_some_and(|members| members.contains(&item.path));
            if in_group {
                grouped.entry(item.generation).or_default().push(item);
            } else {
                groups.push(vec![item]);
            }
        }
        // 依存 group は 1 つでも欠けた member（上げられなかった・除外中）があれば揃うまで送らない。
        let mut ordered: Vec<Vec<CommitItem>> = Vec::new();
        for (generation, items) in grouped {
            let members = &state.groups[&generation];
            let missing = members.iter().any(|member| {
                held.contains(member) && state.dirty.get(member) == Some(&generation)
            });
            if !missing {
                ordered.push(items);
            }
        }
        ordered.extend(groups);
        let groups = ordered;
        let name = sanitize_name(options.project_name.as_deref());
        let mut lease_id = options.lease_id.clone();
        let template = CommitRequest {
            mutation_id: String::new(),
            device_id: self.device.device_id.clone(),
            device_kind: self.device.device_kind.clone(),
            base_revision: revision,
            name: name.clone(),
            upserts: Vec::new(),
            deletes: Vec::new(),
            lease_id: lease_id.clone(),
        };
        let (batches, oversized) = outbox::pack_batches(groups, &template)?;
        for batch in batches {
            loop {
                let entry =
                    self.prepare_entry(paths, &batch, revision, name.clone(), lease_id.clone())?;
                let result = self.send_entry(target, paths, &entry).await;
                match result {
                    Ok(response) => {
                        revision = self.acknowledge(target, paths, &entry, &response)?;
                        break;
                    }
                    Err(VaultError::LeaseHeld { .. }) if entry.request.lease_id.is_some() => {
                        // lease が失効していた。実行の結果を普通の編集として送り直す。
                        self.discard_entry(paths, &entry, |_| {})?;
                        lease_id = None;
                        self.emit(SyncEvent::Offline {
                            project_id: target.project_id.clone(),
                            message: "実行の印が失効したため、通常の編集として同期します".into(),
                        });
                    }
                    Err(error) => {
                        let original = error.clone();
                        if let Some(flight_stop) =
                            self.commit_rejected(target, paths, &entry, error)?
                        {
                            return Err(flight_stop);
                        }
                        // 容量で止まった batch だけを残して次へ進む。
                        if matches!(original, VaultError::QuotaExceeded { .. }) {
                            break;
                        }
                        // 未確定と分かった。最新の manifest で再計画する。
                        return Err(match original {
                            VaultError::ProjectDeleted | VaultError::LeaseHeld { .. } => {
                                VaultError::RevisionConflict
                            }
                            other => other,
                        });
                    }
                }
            }
        }
        Ok((revision, !oversized.is_empty()))
    }

    fn prepare_entry(
        &self,
        paths: &ProjectPaths,
        batch: &[CommitItem],
        revision: u64,
        name: Option<String>,
        lease_id: Option<String>,
    ) -> Result<OutboxEntry> {
        let mutation_id = random_token()?;
        let mut upserts = Vec::new();
        let mut deletes = Vec::new();
        let mut generations = BTreeMap::new();
        for item in batch {
            generations.insert(item.path.clone(), item.generation);
            match &item.op {
                CommitOp::Upsert(upsert) => upserts.push(upsert.clone()),
                CommitOp::Delete => deletes.push(item.path.clone()),
            }
        }
        let snapshot_refs = upserts
            .iter()
            .filter(|upsert| FileKind::from_path(&upsert.path) != FileKind::Audio)
            .map(|upsert| upsert.sha256.clone())
            .collect();
        let entry = OutboxEntry::new(
            mutation_id.clone(),
            now_millis(),
            CommitRequest {
                mutation_id,
                device_id: self.device.device_id.clone(),
                device_kind: self.device.device_kind.clone(),
                base_revision: revision,
                name,
                upserts,
                deletes,
                lease_id,
            },
            generations,
            snapshot_refs,
        )?;
        let _guard = paths.lock();
        let mut state = paths.read_state()?;
        outbox::store(paths, &entry)?;
        state.pending_mutations.push(entry.mutation_id.clone());
        paths.write_state(&mut state)?;
        Ok(entry)
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_flight(
        &self,
        target: &ProjectTarget,
        paths: &ProjectPaths,
        revision: u64,
        snapshot_generation: u64,
        quota: &BTreeSet<String>,
        too_large: &BTreeSet<String>,
        expired: &BTreeSet<String>,
        oversized: bool,
        running: bool,
        defers: &[ManifestFile],
        defer_deletes: &[String],
        excluded: &BTreeSet<String>,
        engine_marked: &BTreeSet<String>,
    ) -> Result<FlightOutcome> {
        self.check_context()?;
        let guard = paths.lock();
        let mut state = paths.read_state()?;
        state.base_revision = state.base_revision.max(revision);
        state.last_synced_at = Some(now_millis());
        state.retry_after = None;
        state.conflict_failures = 0;
        state.tombstone = None;
        state.quota_paths.extend(quota.iter().cloned());
        let dirty = state.dirty.clone();
        state.quota_paths.retain(|path| dirty.contains_key(path));
        for path in too_large {
            state.blocked.insert(path.clone(), BlockedReason::TooLarge);
        }
        let newly_expired: Vec<String> = expired
            .iter()
            .filter(|path| !state.expired_audio.contains(*path))
            .cloned()
            .collect();
        state.expired_audio = expired.clone();
        if !running {
            let keep: BTreeSet<&str> = defers
                .iter()
                .map(|file| file.path.as_str())
                .chain(defer_deletes.iter().map(String::as_str))
                .chain(excluded.iter().map(String::as_str))
                .collect();
            state
                .deferred_remote
                .retain(|path, _| keep.contains(path.as_str()));
            state
                .deferred_deletes
                .retain(|path| keep.contains(path.as_str()));
            let staged: BTreeSet<String> = state
                .deferred_remote
                .values()
                .map(|file| file.sha256.clone())
                .collect();
            for name in paths.list("staging").unwrap_or_default() {
                if !staged.contains(&name) {
                    let _ = paths.remove(&format!("staging/{name}"));
                }
            }
        }
        state.last_error = if !state.quota_paths.is_empty() {
            Some(SyncErrorInfo {
                kind: SyncErrorKind::Quota,
                message: "クラウドの容量が足りません".into(),
            })
        } else if oversized {
            Some(SyncErrorInfo {
                kind: SyncErrorKind::Invalid,
                message: "一度に送れる量を超える変更があり、同期できません".into(),
            })
        } else {
            None
        };
        paths.write_state(&mut state)?;
        drop(guard);
        for path in newly_expired {
            self.emit(SyncEvent::Expired {
                project_id: target.project_id.clone(),
                path,
            });
        }
        let newer_dirty = state.dirty.iter().any(|(path, generation)| {
            *generation > snapshot_generation && !engine_marked.contains(path)
        });
        Ok(FlightOutcome {
            status: status_from_state(&state),
            newer_dirty,
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn handle_tombstone(
        &self,
        target: &ProjectTarget,
        options: &SyncOptions,
        paths: &ProjectPaths,
        state: &VaultState,
        base: &[ManifestFile],
        local: &[ManifestFile],
        running: bool,
    ) -> Result<FlightOutcome> {
        let project_id = target.project_id.as_str();
        let changed = manifest_hashes(local) != manifest_hashes(base)
            || !state.dirty.is_empty()
            || !state.pending_mutations.is_empty()
            || !state.conflicts.is_empty();
        self.emit(SyncEvent::Tombstone {
            project_id: project_id.to_owned(),
            needs_choice: changed,
        });
        {
            let _guard = paths.lock();
            let mut latest = paths.read_state()?;
            latest.tombstone = Some(TombstoneInfo {
                needs_choice: changed,
            });
            if changed {
                latest.last_error = Some(error_info(&VaultError::TombstoneChoiceRequired));
            }
            paths.write_state(&mut latest)?;
        }
        let choice_required = FlightOutcome {
            status: SyncStatus::TombstoneChoiceRequired,
            newer_dirty: false,
        };
        // 実行中・保存先ルート（profile）は動かさない。
        if running
            || !target.scope.is_all()
            || project_id == PROFILE_PROJECT_ID
            || target.working_copy.join(".run.lock").exists()
        {
            return Ok(choice_required);
        }
        // 文書を開いて編集を守っている間は、変更がまだ保存されていなくても手元を自動で退避しない（開いている案件が消えて
        // 後の自動保存が失敗する）。保護を外すとアプリが同期し直し、そこで退避する。利用者が選んだときは選んだとおりにする。
        if options.tombstone_choice.is_none() && !self.protection.paths(project_id).is_empty() {
            return Ok(choice_required);
        }
        match (changed, options.tombstone_choice) {
            (true, None) => Ok(choice_required),
            (_, Some(TombstoneChoice::Restore)) => {
                self.net()?.restore_project(project_id).await?;
                {
                    let _guard = paths.lock();
                    let mut latest = paths.read_state()?;
                    latest.tombstone = None;
                    latest.last_error = None;
                    paths.write_state(&mut latest)?;
                }
                Err(VaultError::RevisionConflict)
            }
            (_, _) => {
                let destination = deleted_project_destination(&target.working_copy, project_id)?;
                if let Some(parent) = destination.parent() {
                    let storage_root = parent
                        .parent()
                        .and_then(Path::parent)
                        .ok_or_else(|| VaultError::InvalidPath(parent.display().to_string()))?;
                    let relative = parent
                        .strip_prefix(storage_root)
                        .map_err(|_| VaultError::InvalidPath(parent.display().to_string()))?;
                    atomic_write(storage_root, &format!("{}/.keep", relative.display()), b"")?;
                    fs::remove_file(parent.join(".keep"))?;
                }
                let _guard = paths.lock();
                fs::rename(&target.working_copy, &destination)?;
                // outbox は消さず休止する（`<ns>/.deleted/<projectId>-<ms>/`）。
                let source = paths.abs("");
                if fs::symlink_metadata(&source).is_ok_and(|metadata| metadata.is_dir()) {
                    let deleted_rel = format!(
                        "{}/.deleted/{}-{}",
                        self.namespace.relative_dir(),
                        project_id,
                        Utc::now().timestamp_millis()
                    );
                    atomic_write(
                        &self.app_data,
                        &format!("{}/.deleted/.keep", self.namespace.relative_dir()),
                        b"",
                    )?;
                    let _ = fs::remove_file(
                        self.app_data
                            .join(format!("{}/.deleted/.keep", self.namespace.relative_dir())),
                    );
                    fs::rename(&source, self.app_data.join(deleted_rel))?;
                }
                Ok(FlightOutcome {
                    status: SyncStatus::MovedDeletedProject { path: destination },
                    newer_dirty: false,
                })
            }
        }
    }
}

struct FlightGuard {
    io: Arc<crate::gate::ProjectIo>,
    active: bool,
}

impl FlightGuard {
    fn disarm(mut self) {
        self.active = false;
    }
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        // flight が取り消された。待っている呼び出しを起こす（同期的に戻す）。
        {
            let mut flight = self.io.flight();
            flight.running = false;
            flight.last = None;
        }
        self.io
            .syncing
            .store(false, std::sync::atomic::Ordering::SeqCst);
        self.io.notify.notify_waiters();
    }
}

fn by_path(files: &[ManifestFile]) -> BTreeMap<&str, &ManifestFile> {
    files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect()
}

fn upsert_item(file: &ManifestFile, generation: u64) -> CommitItem {
    CommitItem {
        path: file.path.clone(),
        generation,
        op: CommitOp::Upsert(CommitUpsert {
            path: file.path.clone(),
            sha256: file.sha256.clone(),
            bytes: file.bytes,
            modified_at: file.modified_at.clone(),
        }),
    }
}

fn derive_kind<T>(
    path: &str,
    has_base: bool,
    local: &Option<T>,
    remote: &Option<ManifestFile>,
) -> ConflictKind {
    if is_immutable_version_path(path) && local.is_some() && remote.is_some() {
        return ConflictKind::Version;
    }
    match (local.is_some(), remote.is_some()) {
        (true, true) if has_base => ConflictKind::Edit,
        (true, true) => ConflictKind::AddAdd,
        (false, true) => ConflictKind::LocalDeletedRemoteEdited,
        (true, false) => ConflictKind::RemoteDeletedLocalEdited,
        (false, false) => ConflictKind::Edit,
    }
}

/// 走査と照合の間に変わった path（今回は計画から外す）。
fn find_unstable(
    target: &ProjectTarget,
    scanned: &ScannedCopy,
    state: &VaultState,
) -> BTreeSet<String> {
    let working_copy = target.working_copy.as_path();
    let mut unstable = BTreeSet::new();
    let scanned_paths: BTreeSet<&str> = scanned
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect();
    for file in &scanned.files {
        let same = fs::symlink_metadata(working_copy.join(&file.path)).is_ok_and(|metadata| {
            metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() == file.bytes
                && metadata
                    .modified()
                    .map(format_system_time)
                    .is_ok_and(|modified| same_instant(&modified, &file.modified_at))
        });
        if !same {
            unstable.insert(file.path.clone());
        }
    }
    for path in state
        .base
        .iter()
        .map(|file| &file.path)
        .chain(state.dirty.keys())
    {
        if scanned_paths.contains(path.as_str())
            || scanned.blocked.contains_key(path)
            || !target.scope.contains(path)
            || is_sync_ignored(path)
            || is_private_path(path)
            || validate_relative_path(path).is_err()
        {
            continue;
        }
        if fs::symlink_metadata(working_copy.join(path)).is_ok() {
            unstable.insert(path.clone());
        }
    }
    unstable
}

/// base と手元の内容が違う path を dirty にする（アプリの保存 API を通らない変更の発見）。
fn discover_dirty(
    state: &mut VaultState,
    local: &[ManifestFile],
    scope: &SyncScope,
    excluded: &BTreeSet<String>,
) {
    let local: BTreeMap<&str, &str> = local
        .iter()
        .map(|file| (file.path.as_str(), file.sha256.as_str()))
        .collect();
    let base: BTreeMap<&str, &str> = state
        .base
        .iter()
        .filter(|file| scope.contains(&file.path))
        .map(|file| (file.path.as_str(), file.sha256.as_str()))
        .collect();
    let discovered: Vec<String> = base
        .keys()
        .chain(local.keys())
        .copied()
        .collect::<BTreeSet<&str>>()
        .into_iter()
        .filter(|path| {
            !excluded.contains(*path)
                && !is_sync_ignored(path)
                && !is_private_path(path)
                && base.get(path) != local.get(path)
                && !state.dirty.contains_key(*path)
        })
        .map(str::to_owned)
        .collect();
    if !discovered.is_empty() {
        state.mark_dirty_paths(discovered);
    }
}

fn status_from_state(state: &VaultState) -> SyncStatus {
    let revision = state.base_revision;
    if !state.conflicts.is_empty() {
        return SyncStatus::Conflicted {
            revision,
            paths: state.conflicts.keys().cloned().collect(),
        };
    }
    if !state.quota_paths.is_empty() || !state.blocked.is_empty() {
        return SyncStatus::Partial {
            revision,
            quota_paths: state.quota_paths.iter().cloned().collect(),
            blocked_paths: state.blocked.keys().cloned().collect(),
        };
    }
    if !state.dirty.is_empty() {
        return SyncStatus::Pending {
            revision,
            paths: state.dirty.keys().cloned().collect(),
        };
    }
    SyncStatus::Synced { revision }
}

/// UI 向けの失敗の種類と文言（内部のコードを出さない）。
pub(crate) fn error_info(error: &VaultError) -> SyncErrorInfo {
    let (kind, message) = match error {
        VaultError::Offline(_) | VaultError::Http(_) => {
            (SyncErrorKind::Offline, "NIHO に接続できません")
        }
        VaultError::AuthRequired => (SyncErrorKind::AuthRequired, "ログインが必要です"),
        VaultError::Forbidden => (
            SyncErrorKind::AuthRequired,
            "この接続ではクラウドを使えません。ログインし直してください",
        ),
        VaultError::RateLimited => (
            SyncErrorKind::RateLimited,
            "混み合っています。しばらくしてから同期します",
        ),
        VaultError::ProjectBusy => (
            SyncErrorKind::Server,
            "クラウドで整理中です。しばらくしてから同期します",
        ),
        VaultError::QuotaExceeded { .. } => (SyncErrorKind::Quota, "クラウドの容量が足りません"),
        VaultError::ProjectDeleted | VaultError::TombstoneChoiceRequired => (
            SyncErrorKind::Tombstone,
            "この案件は別の Mac で削除されました",
        ),
        VaultError::ProjectPurged => (
            SyncErrorKind::Purged,
            "この案件はクラウドから完全に削除されました。手元の内容は残っています",
        ),
        VaultError::MutationMismatch => (
            SyncErrorKind::MutationMismatch,
            "送信済みの変更を確認できません",
        ),
        VaultError::OutboxRecoveryRequired { .. } => (
            SyncErrorKind::Invalid,
            "同期の送信記録を自動復旧できません。手元のファイルを保持して停止しました",
        ),
        VaultError::RevisionConflict | VaultError::Backoff => (
            SyncErrorKind::Server,
            "同時更新が続いたため、同期を一時停止しました。今すぐ同期できます。",
        ),
        VaultError::Api { status, .. } if *status >= 500 => {
            (SyncErrorKind::Server, "NIHO のサーバーで問題が起きています")
        }
        VaultError::Api { .. }
        | VaultError::BlobMissing
        | VaultError::ImmutableVersion { .. }
        | VaultError::ConflictChanged
        | VaultError::LeaseHeld { .. } => (
            SyncErrorKind::Server,
            "クラウドが変更を受け付けませんでした",
        ),
        VaultError::InvalidResponse(_) | VaultError::Json(_) => (
            SyncErrorKind::Server,
            "クラウドの応答を確認できませんでした",
        ),
        VaultError::InvalidPath(_)
        | VaultError::Symlink(_)
        | VaultError::TooManyFiles
        | VaultError::BlobTooLarge(_) => (SyncErrorKind::Invalid, "同期できないファイルがあります"),
        VaultError::Io(_) => (
            SyncErrorKind::Invalid,
            "このMacのファイルを読み書きできません",
        ),
        VaultError::NamespaceMismatch(_) => (
            SyncErrorKind::Invalid,
            "この保存先は別のアカウントに結び付いています",
        ),
        VaultError::ShutDown => (SyncErrorKind::Offline, "同期を停止しました"),
    };
    SyncErrorInfo {
        kind,
        message: message.to_owned(),
    }
}

/// サーバーの案件名の規則（1〜200 字・制御文字なし）。外れる名前は送らない。
fn sanitize_name(name: Option<&str>) -> Option<String> {
    let name = name?;
    let length = name.encode_utf16().count();
    if (1..=200).contains(&length) && !name.chars().any(|character| character.is_control()) {
        Some(name.to_owned())
    } else {
        None
    }
}

fn manifest_hashes(files: &[ManifestFile]) -> BTreeMap<&str, &str> {
    files
        .iter()
        .map(|entry| (entry.path.as_str(), entry.sha256.as_str()))
        .collect()
}

/// blob をメモリへ載せずに、対象と同じ directory の一時ファイルへ下ろす（#18653）。provider が
/// byte 数と sha256 を照合する。下ろせない（保存期限切れの音声など）ときは None で、一時ファイルは残さない。
pub(crate) async fn download_to_temporary(
    provider: &dyn VaultProvider,
    project_id: &str,
    working_copy: &Path,
    file: &ManifestFile,
) -> Result<Option<PathBuf>> {
    let mut output = AtomicFileWriter::new(working_copy, &file.path)?;
    if !provider
        .download_blob_file(project_id, file, output.file_mut())
        .await?
    {
        return Ok(None);
    }
    output.into_temporary().map(Some)
}

pub(crate) fn content_is(file: &ManifestFile, bytes: &[u8]) -> bool {
    bytes.len() as u64 == file.bytes && sha256_hex(bytes) == file.sha256
}

fn staged_bytes(paths: &ProjectPaths, file: &ManifestFile) -> Option<Vec<u8>> {
    let bytes = paths
        .read_bytes(&format!("staging/{}", file.sha256))
        .ok()
        .flatten()?;
    content_is(file, &bytes).then_some(bytes)
}

/// 手元が期待どおりか（大きいファイルは長さと mtime だけ見る）。
pub(crate) fn content_matches(
    root: &Path,
    path: &str,
    expected: Option<&ManifestFile>,
) -> Result<bool> {
    reject_symlink_parents(root, path)?;
    let target = root.join(path);
    match (expected, fs::symlink_metadata(&target)) {
        (None, Err(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        (Some(expected), Ok(metadata))
            if metadata.is_file() && !metadata.file_type().is_symlink() =>
        {
            if metadata.len() != expected.bytes {
                return Ok(false);
            }
            if expected.bytes > QUICK_CHECK_BYTES {
                return Ok(metadata
                    .modified()
                    .map(format_system_time)
                    .is_ok_and(|modified| same_instant(&modified, &expected.modified_at)));
            }
            Ok(hash_file(&target)? == expected.sha256)
        }
        _ => Ok(false),
    }
}

pub(crate) fn set_mtime(working_copy: &Path, file: &ManifestFile) {
    if let Ok(modified) = chrono::DateTime::parse_from_rfc3339(&file.modified_at) {
        let _ = filetime::set_file_mtime(
            working_copy.join(&file.path),
            filetime::FileTime::from_unix_time(
                modified.timestamp(),
                modified.timestamp_subsec_nanos(),
            ),
        );
    }
}

fn write_download(working_copy: &Path, file: &ManifestFile, bytes: &[u8]) -> Result<()> {
    atomic_write(working_copy, &file.path, bytes)?;
    set_mtime(working_copy, file);
    Ok(())
}

fn deleted_project_destination(working_copy: &Path, project_id: &str) -> Result<PathBuf> {
    let parent = working_copy
        .parent()
        .ok_or_else(|| VaultError::InvalidPath(working_copy.display().to_string()))?;
    let storage_root = if parent.file_name().and_then(|name| name.to_str()) == Some("projects") {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    };
    let base = storage_root
        .join(".conflicts/deleted-projects")
        .join(project_id);
    match fs::symlink_metadata(&base) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(base),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(VaultError::Symlink(base.display().to_string()))
        }
        Ok(_) => {}
        Err(error) => return Err(error.into()),
    }
    for sequence in 2..=10_000 {
        let candidate = storage_root
            .join(".conflicts/deleted-projects")
            .join(format!("{project_id}-{sequence}"));
        match fs::symlink_metadata(&candidate) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(VaultError::Symlink(candidate.display().to_string()))
            }
            Ok(_) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(VaultError::InvalidPath(
        "deleted project destination exhausted".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_outside_the_server_rule_are_not_sent() {
        assert_eq!(sanitize_name(Some("案件")), Some("案件".into()));
        assert_eq!(sanitize_name(Some("")), None);
        assert_eq!(sanitize_name(Some("a\nb")), None);
        assert_eq!(sanitize_name(Some(&"あ".repeat(201))), None);
        assert_eq!(sanitize_name(None), None);
    }

    #[test]
    fn status_prefers_conflicts_then_partial_then_pending() {
        let mut state = VaultState::empty("p123");
        assert_eq!(
            status_from_state(&state),
            SyncStatus::Synced { revision: 0 }
        );
        state.mark_dirty("a.md");
        assert!(matches!(
            status_from_state(&state),
            SyncStatus::Pending { .. }
        ));
        state.quota_paths.insert("a.md".into());
        assert!(matches!(
            status_from_state(&state),
            SyncStatus::Partial { .. }
        ));
        state.conflicts.insert("b.md".into(), "c_x".into());
        assert!(matches!(
            status_from_state(&state),
            SyncStatus::Conflicted { .. }
        ));
    }

    #[test]
    fn error_messages_are_japanese_without_internal_codes() {
        for error in [
            VaultError::Offline("x".into()),
            VaultError::AuthRequired,
            VaultError::MutationMismatch,
            VaultError::Api {
                status: 400,
                code: "DOCS_VAULT_X".into(),
                message: "secret".into(),
            },
        ] {
            let info = error_info(&error);
            assert!(!info.message.contains("DOCS_VAULT"));
            assert!(!info.message.contains("secret"));
        }
    }
}
