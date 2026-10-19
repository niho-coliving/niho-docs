//! 同期の契機（spec §7.2・§7.2.2）。ローカル保存の後は idle 1.5 秒／最初の未送信保存から最大 5 秒で開始する。
//!
//! 時間は `tokio::time` で測る（テストは pause／advance で確かめる）。flight 中に期限が来たら、
//! 終わった直後にちょうど 1 回だけもう一度走らせる。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;

use crate::engine::SyncEngine;
use crate::types::ProjectTarget;

/// ローカル保存の後、最後の保存からこの時間で同期を始める。
pub const SYNC_IDLE: Duration = Duration::from_millis(1_500);
/// 最初の未送信の保存から、この時間を超えて同期の開始を遅らせない。
pub const SYNC_MAX_WAIT: Duration = Duration::from_millis(5_000);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncReason {
    /// ローカル保存の成功。idle 1.5 秒／最大 5 秒。
    LocalSave,
    /// 開く・前面・再接続・工程終了・今すぐ同期・保護の解除・音声の完了。すぐ始め、backoff も越える。
    Now,
    /// 開いている案件の 5 分ごとの確認。すぐ始めるが backoff は守る。
    Periodic,
}

struct ProjectSchedule {
    target: ProjectTarget,
    save_deadline: Option<Instant>,
    immediate: Option<Instant>,
    first_unsent: Option<Instant>,
    force: bool,
    timer: u64,
    running: bool,
    rerun: bool,
}

impl ProjectSchedule {
    fn new(target: ProjectTarget) -> Self {
        Self {
            target,
            save_deadline: None,
            immediate: None,
            first_unsent: None,
            force: false,
            timer: 0,
            running: false,
            rerun: false,
        }
    }

    fn deadline(&self) -> Option<Instant> {
        match (self.save_deadline, self.immediate) {
            (Some(save), Some(immediate)) => Some(save.min(immediate)),
            (save, immediate) => save.or(immediate),
        }
    }

    /// 期限までの要求をまとめて取り出す（次の保存から max-wait を数え直す）。
    fn take_request(&mut self) -> (ProjectTarget, bool) {
        self.save_deadline = None;
        self.immediate = None;
        self.first_unsent = None;
        (self.target.clone(), std::mem::take(&mut self.force))
    }
}

#[derive(Default)]
pub(crate) struct SchedulerState {
    projects: HashMap<String, ProjectSchedule>,
}

impl SchedulerState {
    pub(crate) fn clear(&mut self) {
        self.projects.clear();
    }
}

impl SyncEngine {
    /// 同期を予約する。flight の直前に FlightOptions（無ければ既定）から SyncOptions を取る。
    pub fn schedule(self: &Arc<Self>, target: ProjectTarget, reason: SyncReason) {
        if self.is_shut_down() || self.namespace().is_local() {
            return;
        }
        let now = Instant::now();
        let project_id = target.project_id.clone();
        let (deadline, timer) = {
            let mut scheduler = self
                .scheduler
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = scheduler
                .projects
                .entry(project_id.clone())
                .or_insert_with(|| ProjectSchedule::new(target.clone()));
            entry.target = target;
            match reason {
                SyncReason::LocalSave => {
                    let first = *entry.first_unsent.get_or_insert(now);
                    entry.save_deadline = Some((now + SYNC_IDLE).min(first + SYNC_MAX_WAIT));
                }
                SyncReason::Now => {
                    entry.force = true;
                    entry.immediate = Some(now);
                }
                SyncReason::Periodic => {
                    entry.immediate = Some(entry.immediate.map_or(now, |at| at.min(now)));
                }
            }
            entry.timer = entry.timer.wrapping_add(1);
            (entry.deadline().unwrap_or(now), entry.timer)
        };
        if deadline <= now {
            // 期限が今なら timer を介さずに始める（tokio の timer は 1ms 単位に切り上げる）。
            self.fire(&project_id, timer);
            return;
        }
        let weak = Arc::downgrade(self);
        self.spawn_task(async move {
            tokio::time::sleep_until(deadline).await;
            if let Some(engine) = weak.upgrade() {
                engine.fire(&project_id, timer);
            }
        });
    }

    fn fire(self: &Arc<Self>, project_id: &str, timer: u64) {
        let request = {
            let mut scheduler = self
                .scheduler
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(entry) = scheduler.projects.get_mut(project_id) else {
                return;
            };
            if entry.timer != timer {
                return;
            }
            if entry.running {
                entry.rerun = true;
                return;
            }
            entry.running = true;
            entry.take_request()
        };
        let engine = self.clone();
        let project_id = project_id.to_owned();
        self.spawn_task(async move { engine.run_scheduled(project_id, request).await });
    }

    async fn run_scheduled(
        self: Arc<Self>,
        project_id: String,
        mut request: (ProjectTarget, bool),
    ) {
        loop {
            if self.is_shut_down() {
                return;
            }
            let (target, force) = request;
            let mut options = self.flight_options_for(&target).await;
            if force {
                options.force = true;
            }
            let _ = self.sync(&target, options).await;
            let next = {
                let mut scheduler = self
                    .scheduler
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let Some(entry) = scheduler.projects.get_mut(&project_id) else {
                    return;
                };
                if entry.rerun && !self.is_shut_down() {
                    // flight 中に期限が来た。ちょうど 1 回だけ続けて走らせる。
                    entry.rerun = false;
                    entry.timer = entry.timer.wrapping_add(1);
                    Some(entry.take_request())
                } else {
                    entry.running = false;
                    None
                }
            };
            match next {
                Some(next) => request = next,
                None => return,
            }
        }
    }
}
