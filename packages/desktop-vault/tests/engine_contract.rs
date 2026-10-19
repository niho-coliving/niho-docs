mod support;

use std::fs;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use niho_desktop_vault::*;
use support::memory::{sha, MemoryProvider};
use support::{dirs, engine, put, state, target, walk_files};
use tempfile::tempdir;

#[test]
fn two_working_copies_round_trip_and_offline_changes_recover() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy_a, copy_b, app_a, app_b] = dirs(temp.path(), &["a", "b", "app-a", "app-b"])
            .try_into()
            .unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let engine_a = engine(provider.clone(), &app_a, "device-a");
        let engine_b = engine(provider.clone(), &app_b, "device-b");
        let target_a = target("p123", &copy_a);
        let target_b = target("p123", &copy_b);
        put(&engine_a.saver(), &target_a, "project.json", b"one");
        engine_a
            .sync(&target_a, SyncOptions::default())
            .await
            .unwrap();
        engine_b
            .sync(&target_b, SyncOptions::default())
            .await
            .unwrap();
        assert_eq!(fs::read(copy_b.join("project.json")).unwrap(), b"one");

        provider.offline.store(true, Ordering::SeqCst);
        put(&engine_a.saver(), &target_a, "project.json", b"two");
        assert_eq!(
            engine_a
                .sync(&target_a, SyncOptions::default())
                .await
                .unwrap(),
            SyncStatus::Offline
        );
        let snapshot = engine_a.project_snapshot(&target_a).unwrap();
        assert!(snapshot.dirty.contains_key("project.json"));
        assert_eq!(
            snapshot.last_error.map(|error| error.kind),
            Some(SyncErrorKind::Offline)
        );
        provider.offline.store(false, Ordering::SeqCst);
        engine_a
            .sync(&target_a, SyncOptions::default())
            .await
            .unwrap();
        engine_b
            .sync(&target_b, SyncOptions::default())
            .await
            .unwrap();
        assert_eq!(fs::read(copy_b.join("project.json")).unwrap(), b"two");
        let snapshot = engine_a.project_snapshot(&target_a).unwrap();
        assert!(snapshot.dirty.is_empty());
        assert_eq!(snapshot.acknowledged_generation, snapshot.local_generation);
        assert!(snapshot.last_error.is_none());
    });
}

#[test]
fn quota_is_partial_and_three_revision_conflicts_set_backoff() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        provider
            .quota_paths
            .lock()
            .unwrap()
            .insert("large.md".into());
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        put(&engine.saver(), &target, "ok.md", b"ok");
        put(&engine.saver(), &target, "large.md", b"large");
        let status = engine.sync(&target, SyncOptions::default()).await.unwrap();
        assert!(matches!(status, SyncStatus::Partial { ref quota_paths, .. } if quota_paths == &["large.md"]));
        assert!(provider.remote_file("p123", "ok.md").is_some());
        assert!(state(&app, "p123").dirty.contains_key("large.md"));
        assert_eq!(
            engine.project_snapshot(&target).unwrap().last_error.map(|error| error.kind),
            Some(SyncErrorKind::Quota)
        );

        provider.quota_paths.lock().unwrap().clear();
        provider.revision_conflicts.store(3, Ordering::SeqCst);
        put(&engine.saver(), &target, "again.md", b"again");
        assert!(matches!(
            engine.sync(&target, SyncOptions::default()).await,
            Err(VaultError::RevisionConflict)
        ));
        assert_eq!(provider.commit_calls.load(Ordering::SeqCst), 4); // quota の部分 commit 1 + retry 3
        let commits = provider.commits.lock().unwrap();
        let conflict_mutations: std::collections::BTreeSet<_> = commits[1..]
            .iter()
            .map(|(_, request)| request.mutation_id.as_str())
            .collect();
        assert_eq!(conflict_mutations.len(), 3);
        drop(commits);
        let current = state(&app, "p123");
        assert_eq!(current.conflict_failures, 1);
        assert!(current.retry_after.is_some());
        assert!(current.dirty.contains_key("again.md"));
        assert!(current.pending_mutations.is_empty());
        assert!(matches!(
            engine.sync(&target, SyncOptions::default()).await.unwrap(),
            SyncStatus::Backoff { .. }
        ));
        assert_eq!(provider.commit_calls.load(Ordering::SeqCst), 4);
        engine
            .sync_now(&target, SyncOptions::default())
            .await
            .unwrap();
        assert!(!state(&app, "p123").dirty.contains_key("again.md"));
    });
}

#[test]
fn running_skips_pull_without_advancing_base_then_fetches_afterward() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy_a, copy_b, app_a, app_b] = dirs(temp.path(), &["a", "b", "app-a", "app-b"])
            .try_into()
            .unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let a = engine(provider.clone(), &app_a, "a");
        let b = engine(provider.clone(), &app_b, "b");
        let target_a = target("p123", &copy_a);
        let target_b = target("p123", &copy_b);
        put(&a.saver(), &target_a, "page.md", b"old");
        a.sync(&target_a, SyncOptions::default()).await.unwrap();
        b.sync(&target_b, SyncOptions::default()).await.unwrap();
        put(&b.saver(), &target_b, "page.md", b"new");
        b.sync(&target_b, SyncOptions::default()).await.unwrap();

        fs::write(copy_a.join(".run.lock"), "running").unwrap();
        a.sync_now(&target_a, SyncOptions::default()).await.unwrap();
        assert_eq!(fs::read_to_string(copy_a.join("page.md")).unwrap(), "old");
        assert_eq!(
            state(&app_a, "p123").base_file("page.md").unwrap().sha256,
            sha(b"old")
        );
        fs::remove_file(copy_a.join(".run.lock")).unwrap();
        a.sync(&target_a, SyncOptions::default()).await.unwrap();
        assert_eq!(fs::read_to_string(copy_a.join("page.md")).unwrap(), "new");
    });
}

#[test]
fn a_clean_project_open_in_the_editor_is_not_moved_aside_until_protection_is_released() {
    // 編集を守っている間は、変更がまだ無くても削除された案件を自動で退避しない（開いている文書が消えないように）
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let copy = temp.path().join("projects").join("p123");
        let app = temp.path().join("app");
        fs::create_dir_all(&copy).unwrap();
        fs::create_dir_all(&app).unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        put(&engine.saver(), &target, "page.md", b"saved");
        engine.sync(&target, SyncOptions::default()).await.unwrap();
        provider.delete_project("p123").await.unwrap();
        let handle = engine.protection().protect("p123", vec!["page.md".into()]);
        assert_eq!(
            engine
                .sync_now(&target, SyncOptions::default())
                .await
                .unwrap(),
            SyncStatus::TombstoneChoiceRequired
        );
        assert!(copy.join("page.md").exists());
        engine.protection().release(handle);
        let status = engine
            .sync_now(&target, SyncOptions::default())
            .await
            .unwrap();
        assert!(
            matches!(status, SyncStatus::MovedDeletedProject { .. }),
            "{status:?}"
        );
        assert!(!copy.exists());
    });
}

#[test]
fn tombstone_requires_choice_when_dirty_and_clean_copy_moves_aside() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let projects = temp.path().join("projects");
        let copy = projects.join("p123");
        let app = temp.path().join("app");
        fs::create_dir_all(&copy).unwrap();
        fs::create_dir_all(&app).unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        put(&engine.saver(), &target, "page.md", b"saved");
        engine.sync(&target, SyncOptions::default()).await.unwrap();
        provider.delete_project("p123").await.unwrap();
        put(&engine.saver(), &target, "page.md", b"dirty");
        assert_eq!(
            engine.sync(&target, SyncOptions::default()).await.unwrap(),
            SyncStatus::TombstoneChoiceRequired
        );
        assert_eq!(
            engine.project_snapshot(&target).unwrap().tombstone,
            Some(TombstoneInfo { needs_choice: true })
        );
        engine
            .sync_now(
                &target,
                SyncOptions {
                    tombstone_choice: Some(TombstoneChoice::Restore),
                    ..SyncOptions::default()
                },
            )
            .await
            .unwrap();
        assert!(!provider.manifest("p123").deleted);
        assert!(state(&app, "p123").dirty.is_empty());
        assert_eq!(engine.project_snapshot(&target).unwrap().tombstone, None);

        provider.delete_project("p123").await.unwrap();
        fs::write(copy.join(".run.lock"), "running").unwrap();
        assert_eq!(
            engine
                .sync_now(&target, SyncOptions::default())
                .await
                .unwrap(),
            SyncStatus::TombstoneChoiceRequired
        );
        assert!(copy.exists());
        fs::remove_file(copy.join(".run.lock")).unwrap();
        let status = engine
            .sync_now(&target, SyncOptions::default())
            .await
            .unwrap();
        let SyncStatus::MovedDeletedProject { path: destination } = status else {
            panic!("not moved: {status:?}")
        };
        assert!(destination.ends_with(".conflicts/deleted-projects/p123"));
        assert!(destination.join("page.md").exists());
        // 案件の state と outbox は消さずに休止する。
        let namespace_dir = support::account("me").dir(&app);
        assert!(!namespace_dir.join("p123").exists());
        let paused: Vec<_> = fs::read_dir(namespace_dir.join(".deleted"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(paused.len(), 1);
        assert!(paused[0].starts_with("p123-"));
    });
}

#[test]
fn lease_contention_and_two_lost_heartbeats_remove_commit_lease() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let engine = engine(provider.clone(), &app, "a");
        let mut engine_events = engine.subscribe();
        let session = engine.acquire_lease("p123", None).await.unwrap();
        let mut lease_events = session.subscribe();
        assert!(matches!(
            LeaseSession::acquire(provider.clone(), "p123", &support::device("b"), None).await,
            Err(VaultError::LeaseHeld { .. })
        ));
        provider.renew_failures.store(2, Ordering::SeqCst);
        assert!(!session.heartbeat_once().await);
        assert!(session.commit_lease_id().await.is_some());
        assert!(!session.heartbeat_once().await);
        assert!(session.commit_lease_id().await.is_none());
        assert!(matches!(
            lease_events.recv().await.unwrap(),
            SyncEvent::Offline { .. }
        ));
        // engine の channel にも流れる。
        assert!(matches!(
            engine_events.recv().await.unwrap(),
            SyncEvent::Offline { .. }
        ));
        fs::write(copy.join("result.md"), "done").unwrap();
        let target = target("p123", &copy);
        let options = SyncOptions {
            running: true,
            lease_id: session.commit_lease_id().await,
            force: true,
            ..SyncOptions::default()
        };
        engine.sync(&target, options).await.unwrap();
        assert_eq!(
            provider.commit_lease_ids.lock().unwrap().last(),
            Some(&None)
        );
        session.finish().await.unwrap();
    });
}

#[test]
fn expired_lease_is_not_returned_for_commit() {
    support::runtime().block_on(async {
        let provider = Arc::new(MemoryProvider::new());
        *provider.lease_expires_at.lock().unwrap() = "2020-01-01T00:00:00Z".into();
        let session = LeaseSession::acquire(provider, "p123", &support::device("a"), None)
            .await
            .unwrap();
        assert!(session.commit_lease_id().await.is_none());
    });
}

#[test]
fn expired_commit_lease_falls_back_to_a_normal_edit_with_a_new_mutation() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        provider.reject_commit_lease.store(true, Ordering::SeqCst);
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        fs::write(copy.join("result.md"), "result").unwrap();
        engine
            .sync_now(
                &target,
                SyncOptions {
                    lease_id: Some("expired".into()),
                    ..SyncOptions::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            *provider.commit_lease_ids.lock().unwrap(),
            vec![Some("expired".into()), None]
        );
        let commits = provider.commits.lock().unwrap();
        assert_ne!(commits[0].1.mutation_id, commits[1].1.mutation_id);
        assert!(provider.remote_file("p123", "result.md").is_some());
        assert!(state(&app, "p123").pending_mutations.is_empty());
    });
}

#[test]
fn local_namespace_and_local_provider_never_sync() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        fs::write(copy.join("keep.md"), "keep").unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let local = SyncEngine::new(
            provider.clone(),
            &app,
            Namespace::Local {
                root_id: support::ROOT_ID.into(),
            },
            support::ROOT_ID.into(),
            support::device("local"),
            Arc::new(EditProtection::default()),
        );
        let target = target("p123", &copy);
        assert_eq!(
            local.sync(&target, SyncOptions::default()).await.unwrap(),
            SyncStatus::LocalOnly
        );
        let noop = SyncEngine::new(
            Arc::new(LocalProvider),
            &app,
            support::account("me"),
            support::ROOT_ID.into(),
            support::device("local"),
            Arc::new(EditProtection::default()),
        );
        assert_eq!(
            noop.sync(&target, SyncOptions::default()).await.unwrap(),
            SyncStatus::LocalOnly
        );
        assert_eq!(fs::read_to_string(copy.join("keep.md")).unwrap(), "keep");
        assert!(!app.join("vault").exists());
        assert_eq!(provider.get_calls.load(Ordering::SeqCst), 0);
        // local でもローカル保存の契約は同じ（journal → 写し → state）。
        let receipt = put(&local.saver(), &target, "page.md", b"local");
        assert_eq!(receipt.generation, 1);
        assert!(app
            .join("vault/local")
            .join(support::ROOT_ID)
            .join("p123/state.json")
            .exists());
    });
}

#[test]
fn append_only_paths_preserve_deleted_versions_and_runs_union_on_one_sided_change() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy_a, copy_b, app_a, app_b] = dirs(temp.path(), &["a", "b", "app-a", "app-b"])
            .try_into()
            .unwrap();
        fs::create_dir_all(copy_a.join("versions/step")).unwrap();
        fs::write(copy_a.join("versions/step/1.md"), "version-a").unwrap();
        fs::write(copy_a.join("runs.jsonl"), "{\"at\":\"1\",\"id\":\"a\"}\n").unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let a = engine(provider.clone(), &app_a, "device-a");
        let b = engine(provider.clone(), &app_b, "device-b");
        let target_a = target("p123", &copy_a);
        let target_b = target("p123", &copy_b);
        a.sync_now(&target_a, SyncOptions::default()).await.unwrap();
        for file in &state(&app_a, "p123").base {
            assert_eq!(
                file.sha256,
                provider.remote_file("p123", &file.path).unwrap().sha256
            );
        }
        b.sync_now(&target_b, SyncOptions::default()).await.unwrap();

        fs::remove_file(copy_b.join("versions/step/1.md")).unwrap();
        b.saver()
            .note_changed(&target_b, &["versions/step/1.md".into()])
            .unwrap();
        fs::write(copy_a.join("runs.jsonl"), "{\"at\":\"2\",\"id\":\"b\"}\n").unwrap();
        a.sync_now(&target_a, SyncOptions::default()).await.unwrap();
        let runs_base = state(&app_a, "p123")
            .base_file("runs.jsonl")
            .unwrap()
            .clone();
        assert_eq!(
            runs_base.sha256,
            sha(&fs::read(copy_a.join("runs.jsonl")).unwrap())
        );
        b.sync_now(&target_b, SyncOptions::default()).await.unwrap();

        assert_eq!(
            fs::read_to_string(copy_b.join("versions/step/1.md")).unwrap(),
            "version-a"
        );
        assert!(provider.remote_file("p123", "versions/step/1.md").is_some());
        assert_eq!(
            fs::read_to_string(copy_b.join("runs.jsonl")).unwrap(),
            "{\"at\":\"1\",\"id\":\"a\"}\n{\"at\":\"2\",\"id\":\"b\"}\n"
        );
    });
}

#[test]
fn save_during_upload_keeps_new_generation_and_single_flight_drains_it() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        provider.upload_gate.arm();
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        put(&engine.saver(), &target, "page.md", b"first");
        let task_engine = engine.clone();
        let task_target = target.clone();
        let sync = tokio::spawn(async move {
            task_engine
                .sync_now(&task_target, SyncOptions::default())
                .await
        });
        provider.upload_gate.started().await;
        put(&engine.saver(), &target, "page.md", b"second");
        provider.upload_gate.open();
        sync.await.unwrap().unwrap();

        assert_eq!(provider.remote_bytes("p123", "page.md").unwrap(), b"second");
        assert!(state(&app, "p123").dirty.is_empty());
    });
}

#[test]
fn sync_round_limit_reports_remaining_dirty_paths_as_pending() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        provider.upload_gate.arm();
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        put(&engine.saver(), &target, "page.md", b"first");
        let task_engine = engine.clone();
        let task_target = target.clone();
        let sync = tokio::spawn(async move {
            task_engine
                .sync_now(&task_target, SyncOptions::default())
                .await
        });
        for content in ["second", "third", "fourth"] {
            provider.upload_gate.started().await;
            put(&engine.saver(), &target, "page.md", content.as_bytes());
            provider.upload_gate.release_one();
        }
        assert_eq!(
            sync.await.unwrap().unwrap(),
            SyncStatus::Pending {
                revision: 3,
                paths: vec!["page.md".into()],
            }
        );
        assert!(state(&app, "p123").dirty.contains_key("page.md"));
    });
}

#[test]
fn cancelled_flight_releases_single_flight_and_keeps_dirty() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        provider.upload_gate.arm();
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        put(&engine.saver(), &target, "page.md", b"pending");
        let task_engine = engine.clone();
        let task_target = target.clone();
        let task = tokio::spawn(async move {
            task_engine
                .sync_now(&task_target, SyncOptions::default())
                .await
        });
        provider.upload_gate.started().await;
        task.abort();
        let _ = task.await;
        assert!(state(&app, "p123").dirty.contains_key("page.md"));
        provider.upload_gate.disarm();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            engine.sync_now(&target, SyncOptions::default()),
        )
        .await
        .expect("cancelled flight left the project gate running");
        result.unwrap();
        assert!(state(&app, "p123").dirty.is_empty());
    });
}

#[test]
fn editor_save_during_download_is_not_overwritten_or_accepted_into_base() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy_a, copy_b, app_a, app_b] = dirs(temp.path(), &["a", "b", "app-a", "app-b"])
            .try_into()
            .unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let a = engine(provider.clone(), &app_a, "device-a");
        let b = engine(provider.clone(), &app_b, "device-b");
        let target_a = target("p123", &copy_a);
        let target_b = target("p123", &copy_b);
        put(&a.saver(), &target_a, "page.md", b"old");
        a.sync_now(&target_a, SyncOptions::default()).await.unwrap();
        b.sync_now(&target_b, SyncOptions::default()).await.unwrap();
        put(&a.saver(), &target_a, "page.md", b"remote");
        a.sync_now(&target_a, SyncOptions::default()).await.unwrap();

        provider.download_gate.arm();
        let task_engine = b.clone();
        let task_target = target_b.clone();
        let task = tokio::spawn(async move {
            task_engine
                .sync_now(&task_target, SyncOptions::default())
                .await
        });
        provider.download_gate.started().await;
        put(&b.saver(), &target_b, "page.md", b"editor");
        provider.download_gate.open();
        task.await.unwrap().unwrap();

        assert_eq!(fs::read(copy_b.join("page.md")).unwrap(), b"editor");
        assert_eq!(
            state(&app_b, "p123").base_file("page.md").unwrap().sha256,
            sha(b"old")
        );
        let preserved: Vec<Vec<u8>> = walk_files(&copy_b.join(".conflicts"))
            .into_iter()
            .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
            .map(|path| fs::read(path).unwrap())
            .collect();
        assert!(preserved.iter().any(|bytes| bytes == b"editor"));
        assert!(preserved.iter().any(|bytes| bytes == b"remote"));
    });
}

#[test]
fn pending_caller_keeps_its_non_running_options() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy_a, copy_b, app_a, app_b] = dirs(temp.path(), &["a", "b", "app-a", "app-b"])
            .try_into()
            .unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let a = engine(provider.clone(), &app_a, "device-a");
        let b = engine(provider.clone(), &app_b, "device-b");
        let target_a = target("p123", &copy_a);
        let target_b = target("p123", &copy_b);
        put(&a.saver(), &target_a, "page.md", b"old");
        a.sync_now(&target_a, SyncOptions::default()).await.unwrap();
        b.sync_now(&target_b, SyncOptions::default()).await.unwrap();
        put(&a.saver(), &target_a, "page.md", b"remote");
        a.sync_now(&target_a, SyncOptions::default()).await.unwrap();

        provider.get_gate.arm();
        let leader_engine = b.clone();
        let leader_target = target_b.clone();
        let leader = tokio::spawn(async move {
            leader_engine
                .sync_now(
                    &leader_target,
                    SyncOptions {
                        running: true,
                        ..SyncOptions::default()
                    },
                )
                .await
        });
        provider.get_gate.started().await;
        let waiter_engine = b.clone();
        let waiter_target = target_b.clone();
        let waiter = tokio::spawn(async move {
            waiter_engine
                .sync_now(&waiter_target, SyncOptions::default())
                .await
        });
        tokio::task::yield_now().await;
        provider.get_gate.open();
        leader.await.unwrap().unwrap();
        waiter.await.unwrap().unwrap();
        assert_eq!(
            fs::read_to_string(copy_b.join("page.md")).unwrap(),
            "remote"
        );
    });
}

#[test]
fn simultaneous_requests_collapse_to_one_followup_and_share_errors() {
    support::runtime().block_on(async {
        for fail in [false, true] {
            let temp = tempdir().unwrap();
            let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
            if fail {
                fs::write(copy.join("page.md"), "saved").unwrap();
            }
            let provider = Arc::new(MemoryProvider::new());
            provider.get_gate.arm();
            provider
                .revision_conflicts
                .store(if fail { 3 } else { 0 }, Ordering::SeqCst);
            let engine = engine(provider.clone(), &app, "device");
            let target = target("p123", &copy);
            let leader_engine = engine.clone();
            let leader_target = target.clone();
            let leader = tokio::spawn(async move {
                leader_engine
                    .sync_now(&leader_target, SyncOptions::default())
                    .await
            });
            provider.get_gate.started().await;
            let mut waiters = Vec::new();
            for _ in 0..8 {
                let engine = engine.clone();
                let target = target.clone();
                waiters.push(tokio::spawn(async move {
                    engine.sync_now(&target, SyncOptions::default()).await
                }));
            }
            tokio::task::yield_now().await;
            provider.get_gate.open();
            let mut results = vec![leader.await.unwrap()];
            for waiter in waiters {
                results.push(waiter.await.unwrap());
            }
            if fail {
                assert!(results
                    .iter()
                    .all(|result| matches!(result, Err(VaultError::RevisionConflict))));
                assert_eq!(provider.get_calls.load(Ordering::SeqCst), 3);
            } else {
                assert!(results.iter().all(Result::is_ok));
                assert_eq!(provider.get_calls.load(Ordering::SeqCst), 2);
            }
        }
    });
}

#[test]
fn execution_starting_during_download_defers_the_local_write() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        provider.put_remote("p123", "page.md", b"remote", "remote-device");
        provider.download_gate.arm();
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        let task_engine = engine.clone();
        let task_target = target.clone();
        let task = tokio::spawn(async move {
            task_engine
                .sync_now(&task_target, SyncOptions::default())
                .await
        });
        provider.download_gate.started().await;
        fs::write(copy.join(".run.lock"), "running").unwrap();
        provider.download_gate.open();
        task.await.unwrap().unwrap();
        assert!(!copy.join("page.md").exists());
        assert!(state(&app, "p123").base.is_empty());
        fs::remove_file(copy.join(".run.lock")).unwrap();
        engine
            .sync_now(&target, SyncOptions::default())
            .await
            .unwrap();
        assert_eq!(fs::read(copy.join("page.md")).unwrap(), b"remote");
    });
}

#[test]
fn shutdown_stops_all_network_use() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        put(&engine.saver(), &target, "page.md", b"saved");
        engine.shutdown();
        assert!(matches!(
            engine.sync(&target, SyncOptions::default()).await,
            Err(VaultError::ShutDown)
        ));
        engine.schedule(target.clone(), SyncReason::Now);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(provider.get_calls.load(Ordering::SeqCst), 0);
        assert!(matches!(
            engine.acquire_lease("p123", None).await,
            Err(VaultError::ShutDown)
        ));
        // 保存は通信しないので続けられ、dirty は残る。
        put(&engine.saver(), &target, "page.md", b"after");
        assert!(state(&app, "p123").dirty.contains_key("page.md"));
    });
}

#[test]
fn projects_with_pending_lists_dirty_and_unsent_projects() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy_1, copy_2, app] = dirs(temp.path(), &["p1", "p2", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let engine = engine(provider.clone(), &app, "device");
        let first = target("p001", &copy_1);
        let second = target("p002", &copy_2);
        put(&engine.saver(), &first, "a.md", b"a");
        put(&engine.saver(), &second, "b.md", b"b");
        engine.sync(&second, SyncOptions::default()).await.unwrap();
        assert_eq!(
            engine.projects_with_pending().unwrap(),
            vec!["p001".to_owned()]
        );
    });
}
