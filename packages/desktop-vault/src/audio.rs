//! 音声の転送 queue（spec §7.4.3・§7.4.5）。文書の flight はここを待たない。
//!
//! engine ごとに背景の task が 1 本。job は (projectId, path, sha256) で重複を除き、1 本ずつ処理する。
//! 大きいファイルの読み書きは spawn_blocking で行い、gate は state の更新と rename の間だけ持つ。

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::time::Instant;

use crate::engine::{download_to_temporary, error_info, set_mtime, SyncEngine};
use crate::scanner::{commit_temporary, open_file_no_follow, verify_open_file};
use crate::scheduler::SyncReason;
use crate::types::{
    AudioTransferState, BlockedReason, ManifestFile, ProjectTarget, SyncEvent, VaultError,
};

const RETRY_DELAYS: [Duration; 3] = [
    Duration::from_secs(5),
    Duration::from_secs(30),
    Duration::from_secs(120),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum AudioDirection {
    Upload,
    Download,
}

#[derive(Clone, Debug)]
pub(crate) struct AudioJob {
    pub(crate) target: ProjectTarget,
    pub(crate) file: ManifestFile,
    pub(crate) direction: AudioDirection,
    /// 下ろす前の手元（計画時）。適用の直前に照合する。
    pub(crate) expected_local: Option<ManifestFile>,
    pub(crate) snapshot_generation: u64,
    pub(crate) attempts: u32,
    pub(crate) not_before: Option<Instant>,
}

impl AudioJob {
    fn key(&self) -> (String, String, String) {
        (
            self.target.project_id.clone(),
            self.file.path.clone(),
            self.file.sha256.clone(),
        )
    }
}

#[derive(Default)]
struct QueueState {
    jobs: VecDeque<AudioJob>,
    keys: BTreeSet<(String, String, String)>,
    transfers: BTreeMap<(String, String), AudioTransferState>,
    worker: Option<tokio::task::AbortHandle>,
}

#[derive(Default)]
pub(crate) struct AudioQueue {
    state: Mutex<QueueState>,
    notify: Notify,
    stopped: AtomicBool,
}

enum Next {
    Job(Box<AudioJob>),
    Wait(Option<Instant>),
    Stop,
}

impl AudioQueue {
    fn lock(&self) -> MutexGuard<'_, QueueState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 重複でなければ積む。積んだら true。
    fn push(&self, job: AudioJob) -> bool {
        if self.stopped.load(Ordering::SeqCst) {
            return false;
        }
        let mut state = self.lock();
        if !state.keys.insert(job.key()) {
            return false;
        }
        state.transfers.insert(
            (job.target.project_id.clone(), job.file.path.clone()),
            AudioTransferState::Queued,
        );
        state.jobs.push_back(job);
        drop(state);
        self.notify.notify_one();
        true
    }

    fn retry(&self, mut job: AudioJob) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let delay = RETRY_DELAYS[(job.attempts as usize).min(RETRY_DELAYS.len() - 1)];
        job.attempts = job.attempts.saturating_add(1);
        job.not_before = Some(Instant::now() + delay);
        let mut state = self.lock();
        state.transfers.insert(
            (job.target.project_id.clone(), job.file.path.clone()),
            AudioTransferState::Queued,
        );
        state.jobs.push_back(job);
        drop(state);
        self.notify.notify_one();
    }

    fn finish(&self, job: &AudioJob, outcome: Option<AudioTransferState>) {
        let mut state = self.lock();
        state.keys.remove(&job.key());
        let key = (job.target.project_id.clone(), job.file.path.clone());
        match outcome {
            Some(outcome) => {
                state.transfers.insert(key, outcome);
            }
            None => {
                state.transfers.remove(&key);
            }
        }
    }

    fn set(&self, job: &AudioJob, transfer: AudioTransferState) {
        self.lock().transfers.insert(
            (job.target.project_id.clone(), job.file.path.clone()),
            transfer,
        );
    }

    pub(crate) fn transfers_for(&self, project_id: &str) -> BTreeMap<String, AudioTransferState> {
        self.lock()
            .transfers
            .iter()
            .filter(|((project, _), _)| project == project_id)
            .map(|((_, path), transfer)| (path.clone(), *transfer))
            .collect()
    }

    fn next(&self) -> Next {
        if self.stopped.load(Ordering::SeqCst) {
            return Next::Stop;
        }
        let mut state = self.lock();
        let now = Instant::now();
        if let Some(index) = state
            .jobs
            .iter()
            .position(|job| job.not_before.is_none_or(|at| at <= now))
        {
            if let Some(job) = state.jobs.remove(index) {
                return Next::Job(Box::new(job));
            }
        }
        Next::Wait(state.jobs.iter().filter_map(|job| job.not_before).min())
    }

    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let mut state = self.lock();
        state.jobs.clear();
        state.keys.clear();
        if let Some(worker) = state.worker.take() {
            worker.abort();
        }
        drop(state);
        self.notify.notify_waiters();
    }

    fn needs_worker(&self) -> bool {
        let state = self.lock();
        state
            .worker
            .as_ref()
            .is_none_or(|worker| worker.is_finished())
    }

    fn set_worker(&self, worker: tokio::task::AbortHandle) {
        self.lock().worker = Some(worker);
    }
}

impl SyncEngine {
    pub(crate) fn enqueue_audio(&self, job: AudioJob) {
        let event = SyncEvent::Audio {
            project_id: job.target.project_id.clone(),
            path: job.file.path.clone(),
            state: AudioTransferState::Queued,
            message: None,
        };
        if self.audio.push(job) {
            self.emit(event);
            self.ensure_audio_worker();
        }
    }

    fn ensure_audio_worker(&self) {
        if self.is_shut_down() || !self.audio.needs_worker() {
            return;
        }
        let handle = match tokio::runtime::Handle::try_current() {
            Ok(handle) => handle,
            Err(_) => return,
        };
        let queue = self.audio.clone();
        let engine = self.weak.clone();
        let worker = handle.spawn(audio_worker(queue, engine));
        self.audio.set_worker(worker.abort_handle());
    }

    fn emit_audio(&self, job: &AudioJob, state: AudioTransferState, message: Option<String>) {
        self.emit(SyncEvent::Audio {
            project_id: job.target.project_id.clone(),
            path: job.file.path.clone(),
            state,
            message,
        });
    }

    async fn run_audio_job(&self, job: AudioJob) {
        match job.direction {
            AudioDirection::Upload => self.audio_upload(job).await,
            AudioDirection::Download => self.audio_download(job).await,
        }
    }

    async fn audio_upload(&self, job: AudioJob) {
        self.audio.set(&job, AudioTransferState::Uploading);
        self.emit_audio(&job, AudioTransferState::Uploading, None);
        let working_copy = job.target.working_copy.clone();
        let file = job.file.clone();
        // 2 GiB までの音声をメモリへ載せず、開いたファイルを照合してから送る（#18653）。
        let opened = tokio::task::spawn_blocking(move || {
            let mut source = open_file_no_follow(&working_copy, &file.path)
                .ok()
                .flatten()?;
            verify_open_file(&mut source, &file).ok()?;
            Some(source)
        })
        .await
        .ok()
        .flatten();
        let Some(mut source) = opened else {
            // 計画の後に変わった・消えた。次の flight が計画し直す。
            self.audio.finish(&job, None);
            return;
        };
        let result = match self.net() {
            Ok(provider) => {
                provider
                    .upload_blob_file(&job.target.project_id, &job.file, &mut source)
                    .await
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => {
                let recorded = self.update_state(&job.target, |state| {
                    state.confirmed_blobs.insert(job.file.sha256.clone());
                    state.quota_paths.remove(&job.file.path);
                });
                if recorded.is_err() {
                    self.audio.finish(&job, Some(AudioTransferState::Failed));
                    return;
                }
                self.audio.finish(&job, Some(AudioTransferState::Uploaded));
                self.emit_audio(&job, AudioTransferState::Uploaded, None);
                if let Some(engine) = self.weak.upgrade() {
                    engine.schedule(job.target.clone(), SyncReason::Now);
                }
            }
            Err(VaultError::QuotaExceeded { .. }) => {
                let _ = self.update_state(&job.target, |state| {
                    state.quota_paths.insert(job.file.path.clone());
                });
                self.audio.finish(&job, Some(AudioTransferState::Failed));
                self.emit(SyncEvent::Quota {
                    project_id: job.target.project_id.clone(),
                    path: job.file.path.clone(),
                });
                self.emit_audio(
                    &job,
                    AudioTransferState::Failed,
                    Some("クラウドの容量が足りません".into()),
                );
            }
            Err(VaultError::BlobTooLarge(_)) => {
                let _ = self.update_state(&job.target, |state| {
                    state
                        .blocked
                        .insert(job.file.path.clone(), BlockedReason::TooLarge);
                });
                self.audio.finish(&job, Some(AudioTransferState::Failed));
                self.emit_audio(
                    &job,
                    AudioTransferState::Failed,
                    Some(error_info(&VaultError::BlobTooLarge(String::new())).message),
                );
            }
            Err(VaultError::ShutDown) => self.audio.finish(&job, None),
            Err(error) if error.is_retryable_later() => {
                let message = error_info(&error).message;
                self.audio.retry(job.clone());
                self.emit_audio(&job, AudioTransferState::Queued, Some(message));
            }
            Err(error) => {
                self.audio.finish(&job, Some(AudioTransferState::Failed));
                self.emit_audio(
                    &job,
                    AudioTransferState::Failed,
                    Some(error_info(&error).message),
                );
            }
        }
    }

    async fn audio_download(&self, job: AudioJob) {
        self.audio.set(&job, AudioTransferState::Downloading);
        self.emit_audio(&job, AudioTransferState::Downloading, None);
        // 2 GiB までの音声をメモリへ載せず、一時ファイルへ下ろして照合する（#18653）。
        // 手元に書けないときは Io として下の失敗（「このMacのファイルを読み書きできません」）になる。
        let result = match self.net() {
            Ok(provider) => {
                download_to_temporary(
                    provider,
                    &job.target.project_id,
                    &job.target.working_copy,
                    &job.file,
                )
                .await
            }
            Err(error) => Err(error),
        };
        match result {
            Ok(Some(temporary)) => match self.apply_audio(&job, &temporary) {
                Ok(true) => {
                    self.audio
                        .finish(&job, Some(AudioTransferState::Downloaded));
                    self.emit(SyncEvent::Applied {
                        project_id: job.target.project_id.clone(),
                        paths: vec![job.file.path.clone()],
                    });
                    self.emit_audio(&job, AudioTransferState::Downloaded, None);
                }
                Ok(false) => {
                    let _ = std::fs::remove_file(&temporary);
                    self.audio.finish(&job, None);
                }
                Err(error) => {
                    let _ = std::fs::remove_file(&temporary);
                    self.audio.finish(&job, Some(AudioTransferState::Failed));
                    self.emit_audio(
                        &job,
                        AudioTransferState::Failed,
                        Some(error_info(&error).message),
                    );
                }
            },
            Ok(None) => {
                let newly = self
                    .update_state(&job.target, |state| {
                        state.expired_audio.insert(job.file.path.clone())
                    })
                    .unwrap_or(false);
                self.audio.finish(&job, Some(AudioTransferState::Failed));
                if newly {
                    self.emit(SyncEvent::Expired {
                        project_id: job.target.project_id.clone(),
                        path: job.file.path.clone(),
                    });
                }
                self.emit_audio(
                    &job,
                    AudioTransferState::Failed,
                    Some("クラウドの音声は保存期限が過ぎています".into()),
                );
            }
            Err(VaultError::ShutDown) => self.audio.finish(&job, None),
            Err(error) if error.is_retryable_later() => {
                let message = error_info(&error).message;
                self.audio.retry(job.clone());
                self.emit_audio(&job, AudioTransferState::Queued, Some(message));
            }
            Err(error) => {
                self.audio.finish(&job, Some(AudioTransferState::Failed));
                self.emit_audio(
                    &job,
                    AudioTransferState::Failed,
                    Some(error_info(&error).message),
                );
            }
        }
    }

    /// 下ろした音声を gate の中で再確認してから rename する。
    fn apply_audio(
        &self,
        job: &AudioJob,
        temporary: &std::path::Path,
    ) -> crate::types::Result<bool> {
        let paths = self.paths(&job.target.project_id)?;
        let working_copy = job.target.working_copy.as_path();
        let _guard = paths.lock();
        if working_copy.join(".run.lock").exists() {
            return Ok(false);
        }
        let mut state = paths.read_state()?;
        if !self.clean_for_apply(
            &state,
            &job.target.project_id,
            working_copy,
            &job.file.path,
            job.expected_local.as_ref(),
            job.snapshot_generation,
        )? {
            return Ok(false);
        }
        commit_temporary(working_copy, &job.file.path, temporary)?;
        set_mtime(working_copy, &job.file);
        state.deferred_remote.remove(&job.file.path);
        state.deferred_deletes.remove(&job.file.path);
        state.expired_audio.remove(&job.file.path);
        state.set_base(job.file.clone());
        paths.write_state(&mut state)?;
        Ok(true)
    }

    fn update_state<T>(
        &self,
        target: &ProjectTarget,
        update: impl FnOnce(&mut crate::types::VaultState) -> T,
    ) -> crate::types::Result<T> {
        let paths = self.paths(&target.project_id)?;
        let _guard = paths.lock();
        let mut state = paths.read_state()?;
        let value = update(&mut state);
        paths.write_state(&mut state)?;
        Ok(value)
    }
}

async fn audio_worker(queue: Arc<AudioQueue>, engine: Weak<SyncEngine>) {
    loop {
        let notified = queue.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        match queue.next() {
            Next::Stop => return,
            Next::Job(job) => {
                let Some(engine) = engine.upgrade() else {
                    return;
                };
                engine.run_audio_job(*job).await;
            }
            Next::Wait(Some(deadline)) => {
                let _ = tokio::time::timeout_at(deadline, notified.as_mut()).await;
            }
            Next::Wait(None) => {
                if engine.strong_count() == 0 {
                    return;
                }
                notified.await;
            }
        }
    }
}
