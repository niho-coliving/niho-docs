//! 案件ごとの IO gate。ローカル保存（同期 API）と同期 engine（async）が共有する。
//!
//! `io` は state の読み書き・journal の 1 段・取得済みファイルの適用・競合の写しの書込みだけを
//! 短く囲む std の Mutex。`.await`・通信・全走査・音声の hash の間は持たない。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};

use tokio::sync::Notify;

use crate::types::{ProjectTarget, Result, SyncOptions, SyncStatus};

#[derive(Default)]
pub(crate) struct FlightState {
    pub(crate) running: bool,
    pub(crate) pending: bool,
    pub(crate) last: Option<Result<SyncStatus>>,
    pub(crate) pending_request: Option<(ProjectTarget, SyncOptions)>,
}

#[derive(Default)]
pub(crate) struct ProjectIo {
    io: Mutex<()>,
    flight: Mutex<FlightState>,
    pub(crate) notify: Notify,
    pub(crate) syncing: AtomicBool,
}

impl ProjectIo {
    pub(crate) fn lock(&self) -> MutexGuard<'_, ()> {
        self.io
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn flight(&self) -> MutexGuard<'_, FlightState> {
        self.flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

type GateKey = (PathBuf, String);

static GATES: OnceLock<Mutex<HashMap<GateKey, Weak<ProjectIo>>>> = OnceLock::new();

/// (namespace の directory, projectId) ごとに 1 つ。誰も持っていなければ作り直す。
pub(crate) fn project_io(namespace_dir: &Path, project_id: &str) -> Arc<ProjectIo> {
    let mut gates = GATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let key = (namespace_dir.to_path_buf(), project_id.to_owned());
    if let Some(io) = gates.get(&key).and_then(Weak::upgrade) {
        return io;
    }
    gates.retain(|_, weak| weak.strong_count() > 0);
    let io = Arc::new(ProjectIo::default());
    gates.insert(key, Arc::downgrade(&io));
    io
}
