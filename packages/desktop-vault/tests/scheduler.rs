mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use niho_desktop_vault::*;
use support::memory::MemoryProvider;
use support::{dirs, engine, put, target, wait_done};
use tempfile::tempdir;
use tokio::time::Instant;

struct Setup {
    provider: Arc<MemoryProvider>,
    engine: Arc<SyncEngine>,
    target: ProjectTarget,
    app: std::path::PathBuf,
    _temp: tempfile::TempDir,
}

fn setup() -> Setup {
    let temp = tempdir().unwrap();
    let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
    let provider = Arc::new(MemoryProvider::new());
    let engine = engine(provider.clone(), &app, "device");
    Setup {
        provider,
        engine,
        target: target("p123", &copy),
        app,
        _temp: temp,
    }
}

async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

fn gets(provider: &MemoryProvider) -> usize {
    provider.get_calls.load(Ordering::SeqCst)
}

/// tokio の timer は期限を 1ms 単位に切り上げる。その分だけ許す。
fn assert_started_at(start: Instant, expected: Duration) {
    let elapsed = start.elapsed();
    assert!(
        elapsed >= expected && elapsed <= expected + Duration::from_millis(1),
        "flight started at {elapsed:?}, expected {expected:?}"
    );
}

#[test]
fn single_local_save_starts_the_flight_after_one_and_a_half_seconds() {
    support::runtime().block_on(async {
        tokio::time::pause();
        let setup = setup();
        let mut events = setup.engine.subscribe();
        put(&setup.engine.saver(), &setup.target, "page.md", b"one");
        let start = Instant::now();
        setup
            .engine
            .schedule(setup.target.clone(), SyncReason::LocalSave);
        tokio::time::advance(Duration::from_millis(1_499)).await;
        settle().await;
        assert_eq!(gets(&setup.provider), 0);
        tokio::time::advance(Duration::from_millis(1)).await;
        wait_done(&mut events).await;
        assert_started_at(start, SYNC_IDLE);
        assert_eq!(gets(&setup.provider), 1);
        assert!(setup.provider.remote_file("p123", "page.md").is_some());
    });
}

#[test]
fn continuous_saves_start_the_flight_five_seconds_after_the_first_unsent_save() {
    support::runtime().block_on(async {
        tokio::time::pause();
        let setup = setup();
        let mut events = setup.engine.subscribe();
        let start = Instant::now();
        for second in 0..5 {
            put(
                &setup.engine.saver(),
                &setup.target,
                "page.md",
                format!("save {second}").as_bytes(),
            );
            setup
                .engine
                .schedule(setup.target.clone(), SyncReason::LocalSave);
            if second < 4 {
                tokio::time::advance(Duration::from_secs(1)).await;
                settle().await;
                assert_eq!(gets(&setup.provider), 0, "no flight at {}s", second + 1);
            }
        }
        tokio::time::advance(Duration::from_millis(999)).await;
        settle().await;
        assert_eq!(gets(&setup.provider), 0);
        tokio::time::advance(Duration::from_millis(1)).await;
        wait_done(&mut events).await;
        assert_started_at(start, SYNC_MAX_WAIT);
        assert_eq!(gets(&setup.provider), 1);
        assert_eq!(
            setup.provider.remote_bytes("p123", "page.md").unwrap(),
            b"save 4"
        );
    });
}

#[test]
fn now_starts_immediately() {
    support::runtime().block_on(async {
        tokio::time::pause();
        let setup = setup();
        let mut events = setup.engine.subscribe();
        let start = Instant::now();
        setup.engine.schedule(setup.target.clone(), SyncReason::Now);
        wait_done(&mut events).await;
        assert_eq!(start.elapsed(), Duration::ZERO);
        assert_eq!(gets(&setup.provider), 1);
    });
}

#[test]
fn deadlines_during_a_running_flight_cause_exactly_one_follow_up() {
    support::runtime().block_on(async {
        tokio::time::pause();
        let setup = setup();
        let mut events = setup.engine.subscribe();
        setup.provider.get_gate.arm();
        setup.engine.schedule(setup.target.clone(), SyncReason::Now);
        setup.provider.get_gate.started().await;
        for _ in 0..3 {
            setup
                .engine
                .schedule(setup.target.clone(), SyncReason::LocalSave);
            tokio::time::advance(Duration::from_millis(1_500)).await;
            settle().await;
        }
        setup
            .engine
            .schedule(setup.target.clone(), SyncReason::Periodic);
        settle().await;
        assert_eq!(gets(&setup.provider), 1);
        setup.provider.get_gate.open();
        wait_done(&mut events).await;
        wait_done(&mut events).await;
        assert_eq!(gets(&setup.provider), 2);
        tokio::time::advance(Duration::from_secs(30)).await;
        settle().await;
        assert_eq!(gets(&setup.provider), 2);
        while let Ok(event) = events.try_recv() {
            assert!(!matches!(event, SyncEvent::Done { .. }), "{event:?}");
        }
    });
}

#[test]
fn periodic_respects_backoff_but_now_bypasses_it() {
    support::runtime().block_on(async {
        tokio::time::pause();
        let setup = setup();
        let namespace = support::account("me");
        let mut current =
            load_or_default_state(&setup.app, &namespace, support::ROOT_ID, "p123").unwrap();
        current.retry_after = Some(
            (chrono::Utc::now() + chrono::Duration::hours(1))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        );
        save_state(&setup.app, &namespace, &current).unwrap();
        let mut events = setup.engine.subscribe();
        setup
            .engine
            .schedule(setup.target.clone(), SyncReason::Periodic);
        assert!(matches!(
            wait_done(&mut events).await,
            SyncStatus::Backoff { .. }
        ));
        assert_eq!(gets(&setup.provider), 0);
        setup.engine.schedule(setup.target.clone(), SyncReason::Now);
        assert!(matches!(
            wait_done(&mut events).await,
            SyncStatus::Synced { .. }
        ));
        assert_eq!(gets(&setup.provider), 1);
    });
}

struct CountingOptions {
    calls: AtomicUsize,
}

#[async_trait]
impl FlightOptions for CountingOptions {
    async fn options(&self, target: &ProjectTarget) -> SyncOptions {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        SyncOptions {
            project_name: Some(format!("案件 {}", target.project_id)),
            lease_id: Some(format!("{call:032x}")),
            ..SyncOptions::default()
        }
    }
}

#[test]
fn scheduled_flights_ask_flight_options_every_time() {
    support::runtime().block_on(async {
        let setup = setup();
        let options = Arc::new(CountingOptions {
            calls: AtomicUsize::new(0),
        });
        setup.engine.set_flight_options(options.clone());
        let mut events = setup.engine.subscribe();
        for content in ["one", "two"] {
            put(
                &setup.engine.saver(),
                &setup.target,
                "page.md",
                content.as_bytes(),
            );
            setup.engine.schedule(setup.target.clone(), SyncReason::Now);
            wait_done(&mut events).await;
        }
        assert_eq!(options.calls.load(Ordering::SeqCst), 2);
        let commits = setup.provider.commits.lock().unwrap().clone();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].1.name.as_deref(), Some("案件 p123"));
        assert_eq!(commits[0].1.lease_id, Some(format!("{:032x}", 1)));
        assert_eq!(commits[1].1.lease_id, Some(format!("{:032x}", 2)));
    });
}
