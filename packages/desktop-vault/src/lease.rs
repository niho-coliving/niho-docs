//! lease（実行の排他・best effort。spec §9）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, Weak};
use std::time::Duration;

use chrono::Utc;
use tokio::sync::{broadcast, Mutex};

use crate::provider::VaultProvider;
use crate::types::{Device, Result, SyncEvent};

fn lock<T>(mutex: &StdMutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) struct LeaseInner {
    provider: Arc<dyn VaultProvider>,
    project_id: String,
    lease_id: Mutex<Option<String>>,
    expires_at: Mutex<Option<chrono::DateTime<chrono::FixedOffset>>>,
    consecutive_failures: Mutex<u8>,
    events: broadcast::Sender<SyncEvent>,
    forward: StdMutex<Option<broadcast::Sender<SyncEvent>>>,
    pub(crate) stopped: AtomicBool,
}

/// lease は best effort。2 回連続の renew 失敗で所有権を外すが、呼び出し側の CLI は止めない。
pub struct LeaseSession {
    pub(crate) inner: Arc<LeaseInner>,
}

impl LeaseSession {
    pub async fn acquire(
        provider: Arc<dyn VaultProvider>,
        project_id: impl Into<String>,
        device: &Device,
        lease_id: Option<String>,
    ) -> Result<Self> {
        let project_id = project_id.into();
        let lease = provider
            .acquire_lease(
                &project_id,
                &device.device_id,
                &device.device_name,
                lease_id.as_deref(),
            )
            .await?;
        let inner = Arc::new(LeaseInner {
            provider,
            project_id,
            lease_id: Mutex::new(Some(lease.lease_id)),
            expires_at: Mutex::new(chrono::DateTime::parse_from_rfc3339(&lease.expires_at).ok()),
            consecutive_failures: Mutex::new(0),
            events: broadcast::channel(16).0,
            forward: StdMutex::new(None),
            stopped: AtomicBool::new(false),
        });
        spawn_heartbeat(Arc::downgrade(&inner));
        Ok(Self { inner })
    }

    /// 心拍の Offline を engine などの channel にも流す。
    pub fn with_events(self, events: broadcast::Sender<SyncEvent>) -> Self {
        *lock(&self.inner.forward) = Some(events);
        self
    }

    pub async fn commit_lease_id(&self) -> Option<String> {
        let valid = self
            .inner
            .expires_at
            .lock()
            .await
            .as_ref()
            .is_some_and(|expires| *expires > Utc::now());
        if !valid {
            *self.inner.lease_id.lock().await = None;
            return None;
        }
        self.inner.lease_id.lock().await.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SyncEvent> {
        self.inner.events.subscribe()
    }

    pub async fn heartbeat_once(&self) -> bool {
        heartbeat(&self.inner).await
    }

    pub async fn finish(self) -> Result<()> {
        let lease_id = self.inner.lease_id.lock().await.take();
        if self.inner.stopped.load(Ordering::SeqCst) {
            return Ok(());
        }
        if let Some(lease_id) = lease_id {
            self.inner
                .provider
                .release_lease(&self.inner.project_id, &lease_id)
                .await?;
        }
        Ok(())
    }
}

fn spawn_heartbeat(inner: Weak<LeaseInner>) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let Some(inner) = inner.upgrade() else { return };
            if inner.stopped.load(Ordering::SeqCst) || inner.lease_id.lock().await.is_none() {
                return;
            }
            heartbeat(&inner).await;
        }
    });
}

async fn heartbeat(inner: &Arc<LeaseInner>) -> bool {
    if inner.stopped.load(Ordering::SeqCst) {
        return false;
    }
    let Some(lease_id) = inner.lease_id.lock().await.clone() else {
        return false;
    };
    match inner
        .provider
        .renew_lease(&inner.project_id, &lease_id)
        .await
    {
        Ok(lease) => {
            *inner.consecutive_failures.lock().await = 0;
            *inner.expires_at.lock().await =
                chrono::DateTime::parse_from_rfc3339(&lease.expires_at).ok();
            true
        }
        Err(_) => {
            let mut failures = inner.consecutive_failures.lock().await;
            *failures = failures.saturating_add(1);
            if *failures >= 2 {
                *inner.lease_id.lock().await = None;
                *inner.expires_at.lock().await = None;
                let event = SyncEvent::Offline {
                    project_id: inner.project_id.clone(),
                    message: "実行の印の心拍が2回続けて失敗しました".into(),
                };
                let _ = inner.events.send(event.clone());
                if let Some(forward) = lock(&inner.forward).clone() {
                    let _ = forward.send(event);
                }
            }
            false
        }
    }
}
