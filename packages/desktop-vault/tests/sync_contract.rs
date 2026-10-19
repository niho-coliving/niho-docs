mod support;

use std::fs;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use niho_desktop_vault::*;
use serde_json::json;
use support::memory::{sha, MemoryProvider};
use support::{dirs, engine, put, state, target, walk_files};
use tempfile::tempdir;

fn resolution(conflict: &ConflictEntry, writes: Vec<SaveWrite>) -> SaveGroup {
    SaveGroup {
        writes,
        kind: SaveKind::Resolution {
            conflict_id: conflict.conflict_id.clone(),
            remote_sha256: conflict.remote_sha256.clone(),
        },
    }
}

fn put_write(path: &str, bytes: &[u8]) -> SaveWrite {
    SaveWrite::Put {
        path: path.into(),
        bytes: bytes.to_vec(),
    }
}

fn conflict_copies(copy: &Path) -> Vec<Vec<u8>> {
    walk_files(&copy.join(".conflicts"))
        .into_iter()
        .filter(|path| path.file_name().is_some_and(|name| name != "index.json"))
        .map(|path| fs::read(path).unwrap())
        .collect()
}

fn seed_legacy_pending(app: &Path, project_id: &str, status: &str, write_entry: bool) {
    let mutation_id = "LLLLLLLLLLLLLLLLLLLLLL";
    let project = support::account("me").dir(app).join(project_id);
    let mut current = state(app, project_id);
    current.pending_mutations.push(mutation_id.into());
    fs::write(
        project.join("state.json"),
        serde_json::to_vec_pretty(&current).unwrap(),
    )
    .unwrap();
    if !write_entry {
        return;
    }
    fs::create_dir_all(project.join("outbox")).unwrap();
    fs::write(
        project.join(format!("outbox/{mutation_id}.json")),
        serde_json::to_vec_pretty(&json!({
            "mutationId": mutation_id,
            "createdAt": "2026-10-17T00:00:00.000Z",
            "request": {
                "mutationId": mutation_id,
                "deviceId": "legacy-device",
                "baseRevision": 0,
                "upserts": [],
                "deletes": []
            },
            "generations": {},
            "snapshotRefs": [],
            "status": status
        }))
        .unwrap(),
    )
    .unwrap();
}

#[test]
fn docs_root_is_created_before_its_first_blob_and_stays_distinct_from_a_folder_page() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [docs, app] = dirs(temp.path(), &["docs", "app"]).try_into().unwrap();
        let folder = docs.join("projects/abcdefgh23");
        fs::create_dir_all(folder.join("pages")).unwrap();
        fs::create_dir_all(docs.join("pages")).unwrap();
        fs::write(docs.join("pages.json"), "{}").unwrap();
        fs::write(docs.join("pages/same.md"), "root page").unwrap();
        fs::write(folder.join("pages/same.md"), "folder page").unwrap();

        let provider = Arc::new(MemoryProvider::new());
        let engine = engine(provider.clone(), &app, "device");
        let root = ProjectTarget::docs_root(&docs);
        let folder_target = ProjectTarget::new("abcdefgh23", &folder);
        engine.sync(&root, SyncOptions::default()).await.unwrap();
        assert_eq!(
            provider.call_order.lock().unwrap().first().copied(),
            Some("manifest"),
            "root manifest must exist before blob reservation"
        );
        engine
            .sync(&folder_target, SyncOptions::default())
            .await
            .unwrap();

        assert_eq!(
            provider
                .remote_bytes(DOCS_ROOT_PROJECT_ID, "pages/same.md")
                .unwrap(),
            b"root page"
        );
        assert_eq!(
            provider
                .remote_bytes("abcdefgh23", "pages/same.md")
                .unwrap(),
            b"folder page"
        );
    });
}

#[test]
fn reply_from_an_old_root_epoch_is_not_applied() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [docs, app] = dirs(temp.path(), &["docs", "app"]).try_into().unwrap();
        let namespace = support::account("me");
        let key = namespace.account_key().unwrap().to_owned();
        let binding = root_binding(&app, &docs).unwrap();
        let binding = bind_root(&app, &binding.root_id, Some(&key)).unwrap();
        let provider = Arc::new(MemoryProvider::new());
        provider.put_remote(
            DOCS_ROOT_PROJECT_ID,
            "pages/remote.md",
            b"old owner",
            "other",
        );
        provider.get_gate.arm();
        let engine = SyncEngine::new(
            provider.clone(),
            &app,
            namespace,
            binding.root_id.clone(),
            support::device("device"),
            Arc::new(EditProtection::default()),
        );
        let target = ProjectTarget::docs_root(&docs);
        let running = {
            let engine = engine.clone();
            let target = target.clone();
            tokio::spawn(async move { engine.sync(&target, SyncOptions::default()).await })
        };
        provider.get_gate.started().await;
        let rebound = bind_root(&app, &binding.root_id, None).unwrap();
        assert!(rebound.epoch > binding.epoch);
        provider.get_gate.open();
        let result = running.await.unwrap();
        assert!(!matches!(result, Ok(SyncStatus::Synced { .. })));
        assert!(!docs.join("pages/remote.md").exists());
    });
}

struct TwoMacs {
    provider: Arc<MemoryProvider>,
    a: Arc<SyncEngine>,
    b: Arc<SyncEngine>,
    target_a: ProjectTarget,
    target_b: ProjectTarget,
    copy_a: std::path::PathBuf,
    copy_b: std::path::PathBuf,
    app_b: std::path::PathBuf,
    _temp: tempfile::TempDir,
}

/// page.md = "base" を両方の Mac で同期済みにする。
async fn two_macs() -> TwoMacs {
    let temp = tempdir().unwrap();
    let [copy_a, copy_b, app_a, app_b] = dirs(temp.path(), &["a", "b", "app-a", "app-b"])
        .try_into()
        .unwrap();
    let provider = Arc::new(MemoryProvider::new());
    let a = engine(provider.clone(), &app_a, "device-a");
    let b = engine(provider.clone(), &app_b, "device-b");
    let target_a = target("p123", &copy_a);
    let target_b = target("p123", &copy_b);
    put(&a.saver(), &target_a, "page.md", b"base");
    a.sync(&target_a, SyncOptions::default()).await.unwrap();
    b.sync(&target_b, SyncOptions::default()).await.unwrap();
    assert_eq!(fs::read(copy_b.join("page.md")).unwrap(), b"base");
    TwoMacs {
        provider,
        a,
        b,
        target_a,
        target_b,
        copy_a,
        copy_b,
        app_b,
        _temp: temp,
    }
}

/// 両方で page.md を変えた競合を B で作る。`same_mtime` は同じ modifiedAt、false は B の時計が遅れている。
async fn edit_conflict(macs: &TwoMacs, same_mtime: bool) -> ConflictEntry {
    put(&macs.a.saver(), &macs.target_a, "page.md", b"from-a");
    put(&macs.b.saver(), &macs.target_b, "page.md", b"from-b");
    let a_time = filetime::FileTime::from_unix_time(1_800_000_000, 0);
    let b_time = if same_mtime {
        a_time
    } else {
        filetime::FileTime::from_unix_time(1_000_000_000, 0)
    };
    filetime::set_file_mtime(macs.copy_a.join("page.md"), a_time).unwrap();
    filetime::set_file_mtime(macs.copy_b.join("page.md"), b_time).unwrap();
    macs.a
        .sync(&macs.target_a, SyncOptions::default())
        .await
        .unwrap();
    let status = macs
        .b
        .sync(&macs.target_b, SyncOptions::default())
        .await
        .unwrap();
    assert!(
        matches!(status, SyncStatus::Conflicted { ref paths, .. } if paths == &["page.md"]),
        "{status:?}"
    );
    let conflicts = macs.b.list_conflicts(&macs.target_b).unwrap();
    assert_eq!(conflicts.len(), 1);
    conflicts[0].clone()
}

#[test]
fn two_local_macs_rejoin_with_the_same_path_keep_both_versions() {
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
        put(&a.saver(), &target_a, "page.md", b"mac-a-local");
        put(&b.saver(), &target_b, "page.md", b"mac-b-local");

        a.sync(&target_a, SyncOptions::default()).await.unwrap();
        let status = b.sync(&target_b, SyncOptions::default()).await.unwrap();
        assert!(
            matches!(status, SyncStatus::Conflicted { ref paths, .. } if paths == &["page.md"])
        );
        let conflicts = b.list_conflicts(&target_b).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].kind, ConflictKind::AddAdd);
        assert_eq!(fs::read(copy_b.join("page.md")).unwrap(), b"mac-b-local");
        assert_eq!(
            provider.remote_bytes("p123", "page.md").unwrap(),
            b"mac-a-local"
        );
        let copies = conflict_copies(&copy_b);
        assert_eq!(copies.len(), 2);
        assert!(copies.contains(&b"mac-a-local".to_vec()));
        assert!(copies.contains(&b"mac-b-local".to_vec()));
        for version_path in [
            conflicts[0].local_version_path.as_ref().unwrap(),
            conflicts[0].remote_version_path.as_ref().unwrap(),
        ] {
            assert!(provider.remote_file("p123", version_path).is_some());
        }
    });
}

#[test]
fn lost_commit_response_is_resent_with_the_same_mutation_id_and_body() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        provider.drop_commit_responses.store(1, Ordering::SeqCst);
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        put(&engine.saver(), &target, "page.md", b"one");
        put(&engine.saver(), &target, "notes.md", b"two");
        assert_eq!(
            engine.sync(&target, SyncOptions::default()).await.unwrap(),
            SyncStatus::Offline
        );
        // サーバーは確定済み。手元は結果不明として outbox に残す。
        assert_eq!(provider.revision("p123"), 1);
        let snapshot = engine.project_snapshot(&target).unwrap();
        assert!(snapshot.pending_mutation);
        assert!(snapshot.dirty.contains_key("page.md"));

        engine.sync(&target, SyncOptions::default()).await.unwrap();
        let commits = provider.commits.lock().unwrap().clone();
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].1.mutation_id, commits[1].1.mutation_id);
        assert_eq!(
            serde_json::to_vec(&commits[0].1).unwrap(),
            serde_json::to_vec(&commits[1].1).unwrap()
        );
        assert_eq!(provider.revision("p123"), 1);
        let remote = provider.remote_paths("p123");
        assert_eq!(remote, ["notes.md", "page.md"]);
        let snapshot = engine.project_snapshot(&target).unwrap();
        assert!(!snapshot.pending_mutation);
        assert!(snapshot.dirty.is_empty());
        assert_eq!(snapshot.revision, 1);
        assert!(walk_files(&support::account("me").dir(&app).join("p123/outbox")).is_empty());
    });
}

#[test]
fn legacy_outbox_without_exact_body_is_frozen_from_its_request_and_resent() {
    // 旧版（本文を固定する前）の送信待ちが残ったまま更新しても、同期が止まったままにならない（#18747 review）
    support::runtime().block_on(async {
        for status in ["prepared", "sent"] {
            let temp = tempdir().unwrap();
            let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
            let provider = Arc::new(MemoryProvider::new());
            let target = target("p123", &copy);
            let first = engine(provider.clone(), &app, "device");
            put(&first.saver(), &target, "page.md", b"keep");
            drop(first);
            seed_legacy_pending(&app, "p123", status, true);

            let restarted = engine(provider.clone(), &app, "device");
            restarted
                .sync(&target, SyncOptions::default())
                .await
                .unwrap();
            let current = state(&app, "p123");
            assert!(current.pending_mutations.is_empty(), "{status}");
            assert!(current.dirty.is_empty(), "{status}");
            assert!(
                provider.commit_calls.load(Ordering::SeqCst) >= 1,
                "{status}"
            );
            assert_eq!(provider.remote_bytes("p123", "page.md").unwrap(), b"keep");
        }
    });
}

#[test]
fn missing_or_unreadable_outbox_entry_fails_closed() {
    support::runtime().block_on(async {
        for (status, write_entry, corrupt) in [("sent", false, false), ("sent", true, true)] {
            let temp = tempdir().unwrap();
            let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
            let provider = Arc::new(MemoryProvider::new());
            let target = target("p123", &copy);
            let first = engine(provider.clone(), &app, "device");
            put(&first.saver(), &target, "page.md", b"keep");
            drop(first);
            seed_legacy_pending(&app, "p123", status, write_entry);
            let snapshots = support::account("me").dir(&app).join("p123/snapshots");
            fs::create_dir_all(&snapshots).unwrap();
            let recovery_body = b"older dispatched body for manual recovery";
            fs::write(snapshots.join(sha(recovery_body)), recovery_body).unwrap();
            let outbox_file = support::account("me")
                .dir(&app)
                .join("p123/outbox/LLLLLLLLLLLLLLLLLLLLLL.json");
            if corrupt {
                fs::write(&outbox_file, b"{broken json").unwrap();
            }
            let snapshots_before = walk_files(&snapshots);

            let restarted = engine(provider.clone(), &app, "device");
            let error = restarted
                .sync(&target, SyncOptions::default())
                .await
                .unwrap_err();
            assert!(matches!(
                error,
                VaultError::OutboxRecoveryRequired { ref mutation_id, .. }
                    if mutation_id == "LLLLLLLLLLLLLLLLLLLLLL"
            ));
            let current = state(&app, "p123");
            assert_eq!(
                current.pending_mutations,
                ["LLLLLLLLLLLLLLLLLLLLLL".to_owned()]
            );
            assert!(current.dirty.contains_key("page.md"));
            assert_eq!(walk_files(&snapshots), snapshots_before);
            assert_eq!(
                fs::read(snapshots.join(sha(recovery_body))).unwrap(),
                recovery_body
            );
            assert_eq!(provider.commit_calls.load(Ordering::SeqCst), 0);
            if corrupt {
                assert_eq!(fs::read(outbox_file).unwrap(), b"{broken json");
            }
            let _ = (status, write_entry);
        }
    });
}

#[test]
fn save_during_an_in_flight_commit_stays_dirty_after_the_ack() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        let first = put(&engine.saver(), &target, "page.md", b"first");
        provider.commit_gate.arm();
        let task_engine = engine.clone();
        let task_target = target.clone();
        let flight =
            tokio::spawn(
                async move { task_engine.sync(&task_target, SyncOptions::default()).await },
            );
        provider.commit_gate.started().await;
        let second = put(&engine.saver(), &target, "page.md", b"second");
        provider.get_gate.arm();
        provider.commit_gate.open();
        // ack の後、次の周の GET で止まっている間の state。
        provider.get_gate.started().await;
        let current = state(&app, "p123");
        assert_eq!(current.dirty.get("page.md"), Some(&second.generation));
        assert_eq!(current.base_file("page.md").unwrap().sha256, sha(b"first"));
        assert_eq!(current.acknowledged_generation, first.generation);
        assert!(current.acknowledged_generation < current.local_generation);
        provider.get_gate.open();
        flight.await.unwrap().unwrap();
        assert_eq!(provider.remote_bytes("p123", "page.md").unwrap(), b"second");
        let current = state(&app, "p123");
        assert!(current.dirty.is_empty());
        assert_eq!(current.acknowledged_generation, current.local_generation);
    });
}

#[test]
fn both_sides_edited_keep_both_versions_without_a_winner() {
    support::runtime().block_on(async {
        for same_mtime in [true, false] {
            let macs = two_macs().await;
            let conflict = edit_conflict(&macs, same_mtime).await;
            assert_eq!(conflict.kind, ConflictKind::Edit);
            assert_eq!(conflict.status, ConflictStatus::Open);
            assert_eq!(conflict.origin, ConflictOrigin::Sync);
            // 画面向けの要約はクラウド側を変えた端末を持つ。
            let summary = macs.b.project_snapshot(&macs.target_b).unwrap().conflicts;
            assert_eq!(summary.len(), 1);
            assert_eq!(summary[0].remote_device_id.as_deref(), Some("device-a"));
            assert_eq!(summary[0].remote_device_kind.as_deref(), Some("mac"));
            // 手元は local のまま、remote も上書きしない。
            assert_eq!(fs::read(macs.copy_b.join("page.md")).unwrap(), b"from-b");
            assert_eq!(
                macs.provider.remote_bytes("p123", "page.md").unwrap(),
                b"from-a"
            );
            let copies = conflict_copies(&macs.copy_b);
            assert_eq!(copies.len(), 2);
            assert!(copies.contains(&b"from-a".to_vec()));
            assert!(copies.contains(&b"from-b".to_vec()));
            let hash = sha(b"page.md");
            assert!(walk_files(&macs.copy_b.join(".conflicts").join(&hash)).len() == 2);
            // 双方の版はクラウドにも保護される。
            for version_path in [&conflict.local_version_path, &conflict.remote_version_path] {
                let version_path = version_path.clone().unwrap();
                assert!(version_path.starts_with(&format!("versions/files/{hash}/v_")));
                assert!(macs.provider.remote_file("p123", &version_path).is_some());
            }
            assert_eq!(
                macs.provider
                    .remote_bytes("p123", conflict.remote_version_path.as_ref().unwrap())
                    .unwrap(),
                b"from-a"
            );
            assert_eq!(
                macs.provider
                    .remote_bytes("p123", conflict.local_version_path.as_ref().unwrap())
                    .unwrap(),
                b"from-b"
            );
            // 同じ競合を何度同期しても版を増やさない。
            let before = macs.provider.remote_paths("p123").len();
            macs.b
                .sync(&macs.target_b, SyncOptions::default())
                .await
                .unwrap();
            assert_eq!(macs.provider.remote_paths("p123").len(), before);
            assert_eq!(macs.b.list_conflicts(&macs.target_b).unwrap().len(), 1);
        }
    });
}

#[test]
fn resolution_commits_the_chosen_content_with_a_new_version() {
    support::runtime().block_on(async {
        for (choice, expected) in [
            ("remote", b"from-a".to_vec()),
            ("local", b"from-b".to_vec()),
            ("merged", b"merged".to_vec()),
        ] {
            let macs = two_macs().await;
            let conflict = edit_conflict(&macs, true).await;
            let version_id = new_version_id();
            let version_path = version_path_for("page.md", &version_id);
            let runs_line = format!(
                "{{\"at\":\"2026-10-16T00:00:09Z\",\"id\":\"resolve\",\"versionPath\":\"{version_path}\"}}\n"
            );
            let receipt = macs
                .b
                .saver()
                .save(
                    &macs.target_b,
                    resolution(
                        &conflict,
                        vec![
                            put_write("page.md", &expected),
                            put_write(&version_path, &expected),
                            put_write("runs.jsonl", runs_line.as_bytes()),
                        ],
                    ),
                )
                .unwrap();
            let resolving = macs.b.list_conflicts(&macs.target_b).unwrap();
            assert_eq!(resolving[0].status, ConflictStatus::Resolving);
            assert_eq!(resolving[0].resolution_generation, Some(receipt.generation));
            let status = macs
                .b
                .sync(&macs.target_b, SyncOptions::default())
                .await
                .unwrap();
            assert!(matches!(status, SyncStatus::Synced { .. }), "{choice}: {status:?}");
            assert_eq!(
                macs.provider.remote_bytes("p123", "page.md").unwrap(),
                expected,
                "{choice}"
            );
            assert_eq!(
                macs.provider.remote_bytes("p123", &version_path).unwrap(),
                expected
            );
            assert!(macs.provider.remote_file("p123", "runs.jsonl").is_some());
            assert!(macs.b.list_conflicts(&macs.target_b).unwrap().is_empty());
            assert!(conflict_copies(&macs.copy_b).is_empty(), "{choice}");
            assert!(state(&macs.app_b, "p123").conflicts.is_empty());
            // A も同じ内容になる。
            macs.a
                .sync(&macs.target_a, SyncOptions::default())
                .await
                .unwrap();
            assert_eq!(fs::read(macs.copy_a.join("page.md")).unwrap(), expected);
        }
    });
}

#[test]
fn remote_change_during_resolution_is_rechecked() {
    support::runtime().block_on(async {
        let macs = two_macs().await;
        let conflict = edit_conflict(&macs, true).await;
        // 確認中に A がもう一度変えた。
        put(&macs.a.saver(), &macs.target_a, "page.md", b"from-a-2");
        macs.a
            .sync(&macs.target_a, SyncOptions::default())
            .await
            .unwrap();
        let mut events = macs.b.subscribe();
        macs.b
            .sync(&macs.target_b, SyncOptions::default())
            .await
            .unwrap();
        let updated = macs.b.list_conflicts(&macs.target_b).unwrap();
        assert_eq!(updated[0].conflict_id, conflict.conflict_id);
        assert_eq!(
            updated[0].remote_sha256.as_deref(),
            Some(sha(b"from-a-2").as_str())
        );
        let mut saw_conflict = false;
        while let Ok(event) = events.try_recv() {
            saw_conflict |= matches!(event, SyncEvent::Conflict { .. });
        }
        assert!(saw_conflict);
        // 古い確認結果はそのまま保存できない。
        assert!(matches!(
            macs.b.saver().save(
                &macs.target_b,
                resolution(&conflict, vec![put_write("page.md", b"from-a")]),
            ),
            Err(VaultError::ConflictChanged)
        ));
        assert_eq!(fs::read(macs.copy_b.join("page.md")).unwrap(), b"from-b");

        // 解決を保存した後、送る前に remote が変わったら確認待ちに戻る。
        let current = updated[0].clone();
        macs.b
            .saver()
            .save(
                &macs.target_b,
                resolution(&current, vec![put_write("page.md", b"merged")]),
            )
            .unwrap();
        put(&macs.a.saver(), &macs.target_a, "page.md", b"from-a-3");
        macs.a
            .sync(&macs.target_a, SyncOptions::default())
            .await
            .unwrap();
        macs.b
            .sync(&macs.target_b, SyncOptions::default())
            .await
            .unwrap();
        let reopened = macs.b.list_conflicts(&macs.target_b).unwrap();
        assert_eq!(reopened[0].status, ConflictStatus::Open);
        assert_eq!(
            reopened[0].remote_sha256.as_deref(),
            Some(sha(b"from-a-3").as_str())
        );
        assert_eq!(
            macs.provider.remote_bytes("p123", "page.md").unwrap(),
            b"from-a-3"
        );
        assert_eq!(fs::read(macs.copy_b.join("page.md")).unwrap(), b"merged");
    });
}

#[test]
fn delete_versus_edit_is_a_conflict_in_both_directions() {
    support::runtime().block_on(async {
        // 手元で消し、remote で変えた。
        for keep in [true, false] {
            let macs = two_macs().await;
            macs.b
                .saver()
                .save(
                    &macs.target_b,
                    SaveGroup {
                        writes: vec![SaveWrite::Delete {
                            path: "page.md".into(),
                        }],
                        kind: SaveKind::Edit,
                    },
                )
                .unwrap();
            put(&macs.a.saver(), &macs.target_a, "page.md", b"edited");
            macs.a
                .sync(&macs.target_a, SyncOptions::default())
                .await
                .unwrap();
            macs.b
                .sync(&macs.target_b, SyncOptions::default())
                .await
                .unwrap();
            let conflict = macs.b.list_conflicts(&macs.target_b).unwrap()[0].clone();
            assert_eq!(conflict.kind, ConflictKind::LocalDeletedRemoteEdited);
            assert!(!macs.copy_b.join("page.md").exists());
            assert_eq!(conflict_copies(&macs.copy_b), vec![b"edited".to_vec()]);
            assert!(macs
                .provider
                .remote_file("p123", conflict.remote_version_path.as_ref().unwrap())
                .is_some());
            let writes = if keep {
                vec![put_write("page.md", b"edited")]
            } else {
                vec![SaveWrite::Delete {
                    path: "page.md".into(),
                }]
            };
            macs.b
                .saver()
                .save(&macs.target_b, resolution(&conflict, writes))
                .unwrap();
            macs.b
                .sync(&macs.target_b, SyncOptions::default())
                .await
                .unwrap();
            assert!(macs.b.list_conflicts(&macs.target_b).unwrap().is_empty());
            assert_eq!(macs.provider.remote_file("p123", "page.md").is_some(), keep);
            assert_eq!(macs.copy_b.join("page.md").exists(), keep);
        }
        // remote で消し、手元で変えた。
        for keep in [true, false] {
            let macs = two_macs().await;
            macs.a
                .saver()
                .save(
                    &macs.target_a,
                    SaveGroup {
                        writes: vec![SaveWrite::Delete {
                            path: "page.md".into(),
                        }],
                        kind: SaveKind::Edit,
                    },
                )
                .unwrap();
            macs.a
                .sync(&macs.target_a, SyncOptions::default())
                .await
                .unwrap();
            assert!(macs.provider.remote_file("p123", "page.md").is_none());
            put(&macs.b.saver(), &macs.target_b, "page.md", b"edited-b");
            macs.b
                .sync(&macs.target_b, SyncOptions::default())
                .await
                .unwrap();
            let conflict = macs.b.list_conflicts(&macs.target_b).unwrap()[0].clone();
            assert_eq!(conflict.kind, ConflictKind::RemoteDeletedLocalEdited);
            assert_eq!(conflict.remote_sha256, None);
            assert_eq!(fs::read(macs.copy_b.join("page.md")).unwrap(), b"edited-b");
            assert!(macs.provider.remote_file("p123", "page.md").is_none());
            assert!(macs
                .provider
                .remote_file("p123", conflict.local_version_path.as_ref().unwrap())
                .is_some());
            let writes = if keep {
                vec![put_write("page.md", b"edited-b")]
            } else {
                vec![SaveWrite::Delete {
                    path: "page.md".into(),
                }]
            };
            macs.b
                .saver()
                .save(&macs.target_b, resolution(&conflict, writes))
                .unwrap();
            macs.b
                .sync(&macs.target_b, SyncOptions::default())
                .await
                .unwrap();
            assert!(macs.b.list_conflicts(&macs.target_b).unwrap().is_empty());
            assert_eq!(macs.provider.remote_file("p123", "page.md").is_some(), keep);
        }
    });
}

#[test]
fn edit_protection_defers_remote_changes_until_released() {
    support::runtime().block_on(async {
        let macs = two_macs().await;
        let protection_id = macs.b.protection().protect("p123", vec!["page.md".into()]);
        put(&macs.a.saver(), &macs.target_a, "page.md", b"remote-edit");
        macs.a
            .sync(&macs.target_a, SyncOptions::default())
            .await
            .unwrap();
        let mut events = macs.b.subscribe();
        macs.b
            .sync(&macs.target_b, SyncOptions::default())
            .await
            .unwrap();
        let mut deferred_event = false;
        while let Ok(event) = events.try_recv() {
            deferred_event |=
                matches!(event, SyncEvent::Deferred { ref path, .. } if path == "page.md");
        }
        assert!(deferred_event);
        assert_eq!(fs::read(macs.copy_b.join("page.md")).unwrap(), b"base");
        let current = state(&macs.app_b, "p123");
        assert_eq!(current.base_file("page.md").unwrap().sha256, sha(b"base"));
        assert_eq!(
            current
                .deferred_remote
                .get("page.md")
                .map(|file| file.sha256.clone()),
            Some(sha(b"remote-edit"))
        );
        let staged = support::account("me")
            .dir(&macs.app_b)
            .join("p123/staging")
            .join(sha(b"remote-edit"));
        assert_eq!(fs::read(&staged).unwrap(), b"remote-edit");
        let snapshot = macs.b.project_snapshot(&macs.target_b).unwrap();
        assert_eq!(snapshot.deferred, vec!["page.md".to_owned()]);
        // 取り込みを待っている版の書き手（画面が「別の Mac で更新されています」と名指す）。
        assert_eq!(
            snapshot.remote_writers.get("page.md"),
            Some(&RemoteWriter {
                device_id: "device-a".into(),
                device_kind: Some("mac".into()),
            })
        );

        // 解除して Now を予約すると適用される（取り置いた bytes を使う）。
        macs.provider.offline.store(false, Ordering::SeqCst);
        let released = macs.b.protection().release(protection_id).unwrap();
        assert_eq!(released.1, vec!["page.md".to_owned()]);
        let mut events = macs.b.subscribe();
        macs.b.schedule(macs.target_b.clone(), SyncReason::Now);
        let mut applied = false;
        loop {
            match tokio::time::timeout(Duration::from_secs(10), events.recv())
                .await
                .expect("flight finished")
                .unwrap()
            {
                SyncEvent::Applied { paths, .. } => {
                    applied |= paths.contains(&"page.md".to_owned())
                }
                SyncEvent::Done { .. } => break,
                _ => {}
            }
        }
        assert!(applied);
        assert_eq!(
            fs::read(macs.copy_b.join("page.md")).unwrap(),
            b"remote-edit"
        );
        let current = state(&macs.app_b, "p123");
        assert!(current.deferred_remote.is_empty());
        assert_eq!(
            current.base_file("page.md").unwrap().sha256,
            sha(b"remote-edit")
        );
        assert!(!staged.exists());
    });
}

#[test]
fn nested_runs_union_and_versions_are_never_lost() {
    support::runtime().block_on(async {
        let macs = two_macs().await;
        let line_a = "{\"at\":\"2026-10-16T00:00:01Z\",\"id\":\"a\"}\n";
        let line_b = "{\"at\":\"2026-10-16T00:00:02Z\",\"id\":\"b\"}\n";
        put(
            &macs.a.saver(),
            &macs.target_a,
            "recordings/r1/runs.jsonl",
            line_a.as_bytes(),
        );
        put(
            &macs.a.saver(),
            &macs.target_a,
            "recordings/r1/versions/s/v_1.md",
            b"version",
        );
        macs.a
            .sync(&macs.target_a, SyncOptions::default())
            .await
            .unwrap();
        put(
            &macs.b.saver(),
            &macs.target_b,
            "recordings/r1/runs.jsonl",
            line_b.as_bytes(),
        );
        let mut events = macs.b.subscribe();
        let status = macs
            .b
            .sync(&macs.target_b, SyncOptions::default())
            .await
            .unwrap();
        assert!(matches!(status, SyncStatus::Synced { .. }), "{status:?}");
        while let Ok(event) = events.try_recv() {
            assert!(!matches!(event, SyncEvent::Conflict { .. }));
        }
        let union = format!("{line_a}{line_b}");
        assert_eq!(
            fs::read_to_string(macs.copy_b.join("recordings/r1/runs.jsonl")).unwrap(),
            union
        );
        assert_eq!(
            String::from_utf8(
                macs.provider
                    .remote_bytes("p123", "recordings/r1/runs.jsonl")
                    .unwrap()
            )
            .unwrap(),
            union
        );
        // 録音配下の版は手元で消しても remote から消さない。
        fs::remove_file(macs.copy_b.join("recordings/r1/versions/s/v_1.md")).unwrap();
        macs.b
            .saver()
            .note_changed(&macs.target_b, &["recordings/r1/versions/s/v_1.md".into()])
            .unwrap();
        macs.b
            .sync(&macs.target_b, SyncOptions::default())
            .await
            .unwrap();
        assert!(macs
            .provider
            .remote_file("p123", "recordings/r1/versions/s/v_1.md")
            .is_some());
        assert_eq!(
            fs::read(macs.copy_b.join("recordings/r1/versions/s/v_1.md")).unwrap(),
            b"version"
        );
        for (_, request) in macs.provider.commits.lock().unwrap().iter() {
            assert!(request
                .deletes
                .iter()
                .all(|path| !is_immutable_version_path(path)));
        }
    });
}

#[test]
fn immutable_version_rejection_becomes_a_version_conflict_and_other_paths_commit() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let engine = engine(provider.clone(), &app, "device-b");
        let target = target("p123", &copy);
        put(
            &engine.saver(),
            &target,
            "versions/step/3.md",
            b"local-version",
        );
        put(&engine.saver(), &target, "other.md", b"other");
        // GET の後、commit の直前に別の端末が同じ版の path を確定した。
        let remote_bytes = b"remote-version".to_vec();
        let remote = ManifestFile {
            path: "versions/step/3.md".into(),
            sha256: sha(&remote_bytes),
            bytes: remote_bytes.len() as u64,
            kind: FileKind::Text,
            modified_at: "2026-10-16T00:00:00.000Z".into(),
            writer_device_id: "device-a".into(),
            writer_device_kind: None,
            retained_until: None,
            available: true,
        };
        // revision を進めない差し込みで、サーバーの immutable version の検査に当てる。
        *provider.inject_before_commit.lock().unwrap() =
            Some(("p123".into(), remote, remote_bytes.clone(), false));
        let status = engine.sync(&target, SyncOptions::default()).await.unwrap();
        assert!(
            matches!(status, SyncStatus::Conflicted { .. }),
            "{status:?}"
        );
        assert_eq!(provider.remote_bytes("p123", "other.md").unwrap(), b"other");
        assert_eq!(
            provider.remote_bytes("p123", "versions/step/3.md").unwrap(),
            remote_bytes
        );
        assert_eq!(
            fs::read(copy.join("versions/step/3.md")).unwrap(),
            b"local-version"
        );
        let snapshot = engine.project_snapshot(&target).unwrap();
        assert!(snapshot.blocked.contains(&BlockedPath {
            path: "versions/step/3.md".into(),
            reason: BlockedReason::ImmutableVersion,
        }));
        let conflict = engine.list_conflicts(&target).unwrap()[0].clone();
        assert_eq!(conflict.kind, ConflictKind::Version);
        let protected_local = conflict.local_version_path.clone().unwrap();
        assert!(protected_local.starts_with("versions/files/"));
        assert_eq!(
            provider.remote_bytes("p123", &protected_local).unwrap(),
            b"local-version"
        );
        // クラウドの版を採ると解決し、blocked も消える。
        engine
            .saver()
            .save(
                &target,
                resolution(
                    &conflict,
                    vec![put_write("versions/step/3.md", &remote_bytes)],
                ),
            )
            .unwrap();
        engine.sync(&target, SyncOptions::default()).await.unwrap();
        let snapshot = engine.project_snapshot(&target).unwrap();
        assert!(snapshot.conflicts.is_empty());
        assert!(snapshot.blocked.is_empty());
    });
}

#[test]
fn accounts_never_send_each_others_outbox_or_dirty() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [docs, other_docs, app] = dirs(temp.path(), &["docs", "docs-b", "app"])
            .try_into()
            .unwrap();
        fs::create_dir_all(docs.join("projects/p123")).unwrap();
        fs::create_dir_all(other_docs.join("projects/p123")).unwrap();
        let root = root_binding(&app, &docs).unwrap();
        let key_a = account_key("test", "alice");
        let key_b = account_key("test", "bob");
        bind_root(&app, &root.root_id, Some(&key_a)).unwrap();
        let namespace_a = Namespace::Account {
            account_key: key_a.clone(),
        };
        let namespace_b = Namespace::Account {
            account_key: key_b.clone(),
        };
        let provider_a = Arc::new(MemoryProvider::new());
        provider_a.drop_commit_responses.store(1, Ordering::SeqCst);
        let protection = Arc::new(EditProtection::default());
        let engine_a = SyncEngine::new(
            provider_a.clone(),
            &app,
            namespace_a.clone(),
            root.root_id.clone(),
            support::device("mac"),
            protection.clone(),
        );
        let project = target("p123", &docs.join("projects/p123"));
        put(&engine_a.saver(), &project, "page.md", b"alice");
        engine_a
            .sync(&project, SyncOptions::default())
            .await
            .unwrap();
        let alice_mutation = provider_a.commits.lock().unwrap()[0].1.mutation_id.clone();
        assert!(namespace_has_pending(&app, &namespace_a, &root.root_id).unwrap());
        assert!(!namespace_has_pending(&app, &namespace_b, &root.root_id).unwrap());

        // ログアウトして bob に切り替えた。alice の root は bob では同期しない。
        engine_a.shutdown();
        let provider_b = Arc::new(MemoryProvider::new());
        let engine_b_same_root = SyncEngine::new(
            provider_b.clone(),
            &app,
            namespace_b.clone(),
            root.root_id.clone(),
            support::device("mac"),
            protection.clone(),
        );
        assert!(matches!(
            engine_b_same_root
                .sync(&project, SyncOptions::default())
                .await,
            Err(VaultError::NamespaceMismatch(_))
        ));
        assert_eq!(provider_b.get_calls.load(Ordering::SeqCst), 0);
        assert_eq!(provider_b.commit_calls.load(Ordering::SeqCst), 0);

        // bob は別の保存先 root を使う。同じ projectId でも alice の outbox は送らない。
        let other_root = root_binding(&app, &other_docs).unwrap();
        bind_root(&app, &other_root.root_id, Some(&key_b)).unwrap();
        let engine_b = SyncEngine::new(
            provider_b.clone(),
            &app,
            namespace_b.clone(),
            other_root.root_id.clone(),
            support::device("mac"),
            protection.clone(),
        );
        let bob_project = target("p123", &other_docs.join("projects/p123"));
        put(&engine_b.saver(), &bob_project, "page.md", b"bob");
        engine_b
            .sync(&bob_project, SyncOptions::default())
            .await
            .unwrap();
        for (_, request) in provider_b.commits.lock().unwrap().iter() {
            assert_ne!(request.mutation_id, alice_mutation);
        }
        assert_eq!(provider_b.remote_bytes("p123", "page.md").unwrap(), b"bob");
        assert!(provider_b
            .uploads
            .lock()
            .unwrap()
            .iter()
            .all(|file| file.sha256 != sha(b"alice")));

        // alice が戻ると、同じ mutationId で再送して確定する。
        let engine_a = SyncEngine::new(
            provider_a.clone(),
            &app,
            namespace_a.clone(),
            root.root_id.clone(),
            support::device("mac"),
            protection,
        );
        engine_a
            .sync(&project, SyncOptions::default())
            .await
            .unwrap();
        let commits = provider_a.commits.lock().unwrap().clone();
        assert_eq!(commits.last().unwrap().1.mutation_id, alice_mutation);
        assert_eq!(provider_a.revision("p123"), 1);
        assert!(!namespace_has_pending(&app, &namespace_a, &root.root_id).unwrap());
    });
}

#[test]
fn stuck_audio_upload_does_not_hold_back_documents() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        provider.audio_gate.arm();
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        fs::create_dir_all(copy.join("inputs")).unwrap();
        fs::write(copy.join("inputs/a.m4a"), b"audio-bytes").unwrap();
        engine
            .saver()
            .note_changed(&target, &["inputs/a.m4a".into()])
            .unwrap();
        put(&engine.saver(), &target, "page.md", b"document");
        let mut events = engine.subscribe();
        let status = tokio::time::timeout(
            Duration::from_secs(10),
            engine.sync(&target, SyncOptions::default()),
        )
        .await
        .expect("document flight does not wait for audio")
        .unwrap();
        assert!(
            matches!(status, SyncStatus::Pending { ref paths, .. } if paths == &["inputs/a.m4a"])
        );
        assert_eq!(
            provider.remote_bytes("p123", "page.md").unwrap(),
            b"document"
        );
        assert!(provider.remote_file("p123", "inputs/a.m4a").is_none());
        for paths in provider.committed_paths() {
            assert!(!paths.contains(&"inputs/a.m4a".to_owned()));
        }
        provider.audio_gate.started().await;
        let snapshot = engine.project_snapshot(&target).unwrap();
        assert_eq!(
            snapshot.audio.get("inputs/a.m4a"),
            Some(&AudioTransferState::Uploading)
        );
        assert!(snapshot.dirty.contains_key("inputs/a.m4a"));

        // complete が済むと次の flight の commit に入る。
        provider.audio_gate.open();
        let mut uploaded = false;
        loop {
            match tokio::time::timeout(Duration::from_secs(10), events.recv())
                .await
                .expect("audio follow-up")
                .unwrap()
            {
                SyncEvent::Audio {
                    state: AudioTransferState::Uploaded,
                    ..
                } => uploaded = true,
                SyncEvent::Done { status, .. } if uploaded => {
                    assert!(matches!(status, SyncStatus::Synced { .. }), "{status:?}");
                    break;
                }
                _ => {}
            }
        }
        assert_eq!(
            provider.remote_bytes("p123", "inputs/a.m4a").unwrap(),
            b"audio-bytes"
        );
        let commits = provider.committed_paths();
        assert_eq!(commits.last().unwrap(), &vec!["inputs/a.m4a".to_owned()]);
        assert!(state(&app, "p123").dirty.is_empty());
    });
}

#[test]
fn remote_audio_is_downloaded_by_the_queue_not_the_flight() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        provider.put_remote("p123", "inputs/a.m4a", b"remote-audio", "other");
        provider.put_remote("p123", "transcript.md", b"text", "other");
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        let mut events = engine.subscribe();
        engine.sync(&target, SyncOptions::default()).await.unwrap();
        assert_eq!(fs::read(copy.join("transcript.md")).unwrap(), b"text");
        let mut downloaded = false;
        while !downloaded {
            if let SyncEvent::Audio {
                state: AudioTransferState::Downloaded,
                ..
            } = tokio::time::timeout(Duration::from_secs(10), events.recv())
                .await
                .expect("audio download")
                .unwrap()
            {
                downloaded = true;
            }
        }
        assert_eq!(
            fs::read(copy.join("inputs/a.m4a")).unwrap(),
            b"remote-audio"
        );
        assert_eq!(
            state(&app, "p123")
                .base_file("inputs/a.m4a")
                .unwrap()
                .sha256,
            sha(b"remote-audio")
        );
    });
}

#[test]
fn corrupt_remote_audio_fails_without_leaving_a_partial_file() {
    // 音声は一時ファイルへ逐次で下ろして照合する（#18653）。合わなければ一時ファイルも残さない。
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let remote = provider.put_remote("p123", "inputs/a.aifc", b"expected", "other");
        provider
            .blobs
            .lock()
            .unwrap()
            .insert(remote.sha256.clone(), b"corrupt!".to_vec());
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        let mut events = engine.subscribe();
        engine.sync(&target, SyncOptions::default()).await.unwrap();
        loop {
            if let SyncEvent::Audio {
                state: AudioTransferState::Failed,
                ..
            } = tokio::time::timeout(Duration::from_secs(10), events.recv())
                .await
                .expect("audio failure")
                .unwrap()
            {
                break;
            }
        }
        assert!(!copy.join("inputs/a.aifc").exists());
        assert!(walk_files(&copy)
            .iter()
            .all(|path| !path.to_string_lossy().ends_with(".tmp")));
        assert!(state(&app, "p123").base_file("inputs/a.aifc").is_none());
    });
}

#[test]
fn empty_documents_upload_while_blocked_private_and_temp_paths_are_never_sent() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        fs::write(copy.join("empty.md"), b"").unwrap();
        fs::write(copy.join("ok.md"), b"ok").unwrap();
        fs::write(copy.join("silence.m4a"), b"").unwrap();
        fs::write(copy.join("big.bin"), vec![7_u8; 64]).unwrap();
        fs::create_dir_all(copy.join("codex-home")).unwrap();
        fs::write(copy.join("codex-home/auth.json"), b"{}").unwrap();
        fs::write(copy.join("settings.json"), b"{}").unwrap();
        fs::create_dir_all(copy.join("pages")).unwrap();
        fs::write(copy.join("pages/.p1.md.tmp-1-ab"), b"partial").unwrap();
        fs::write(copy.join(".x.md.tmp-1-ab"), b"partial").unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let engine = engine(provider.clone(), &app, "device");
        engine.set_scan_limits(ScanLimits {
            max_blob_bytes: 32,
            max_audio_blob_bytes: 32,
            max_text_bytes: 32,
            max_files: 100,
        });
        let target = target("p123", &copy);
        let status = engine
            .sync_now(&target, SyncOptions::default())
            .await
            .unwrap();
        assert!(matches!(status, SyncStatus::Partial { .. }), "{status:?}");
        assert_eq!(provider.remote_paths("p123"), ["empty.md", "ok.md"]);
        assert_eq!(provider.remote_bytes("p123", "empty.md").unwrap(), b"");
        let uploaded: Vec<String> = provider
            .uploads
            .lock()
            .unwrap()
            .iter()
            .map(|file| file.path.clone())
            .collect();
        for never in [
            "silence.m4a",
            "big.bin",
            "codex-home/auth.json",
            "settings.json",
            "pages/.p1.md.tmp-1-ab",
            ".x.md.tmp-1-ab",
        ] {
            assert!(!uploaded.contains(&never.to_owned()), "{never}");
        }
        let blocked = engine.project_snapshot(&target).unwrap().blocked;
        assert!(blocked.contains(&BlockedPath {
            path: "silence.m4a".into(),
            reason: BlockedReason::EmptyAudio
        }));
        assert!(blocked.contains(&BlockedPath {
            path: "big.bin".into(),
            reason: BlockedReason::TooLarge
        }));
        assert!(blocked.contains(&BlockedPath {
            path: "codex-home".into(),
            reason: BlockedReason::PrivatePath
        }));
        assert!(blocked.contains(&BlockedPath {
            path: "settings.json".into(),
            reason: BlockedReason::PrivatePath
        }));
        // 上限を超えたファイルは remote から消さない。
        provider.put_remote("p123", "big.bin", b"small", "other");
        engine
            .sync_now(&target, SyncOptions::default())
            .await
            .unwrap();
        assert!(provider.remote_file("p123", "big.bin").is_some());
        assert_eq!(fs::read(copy.join("big.bin")).unwrap(), vec![7_u8; 64]);
    });
}

#[test]
fn profile_target_syncs_only_about_json_from_the_docs_root() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [docs, other_docs, app_a, app_b] =
            dirs(temp.path(), &["docs", "docs-b", "app-a", "app-b"])
                .try_into()
                .unwrap();
        fs::write(docs.join("about.json"), b"{\"name\":\"taku\"}").unwrap();
        fs::create_dir_all(docs.join("projects/p1")).unwrap();
        fs::write(docs.join("projects/p1/page.md"), b"page").unwrap();
        fs::create_dir_all(docs.join("flows")).unwrap();
        fs::write(docs.join("flows/active.json"), b"{}").unwrap();
        fs::write(docs.join("settings.json"), b"{\"secret\":true}").unwrap();
        fs::create_dir_all(docs.join("private")).unwrap();
        fs::write(docs.join("private/session.json"), b"{\"token\":\"secret\"}").unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let a = engine(provider.clone(), &app_a, "device-a");
        let profile = ProjectTarget::profile(&docs);
        a.sync(&profile, SyncOptions::default()).await.unwrap();
        assert_eq!(provider.remote_paths(PROFILE_PROJECT_ID), ["about.json"]);
        assert!(provider.remote_paths("p1").is_empty());
        let uploaded: Vec<String> = provider
            .uploads
            .lock()
            .unwrap()
            .iter()
            .map(|file| file.path.clone())
            .collect();
        assert_eq!(uploaded, ["about.json"]);

        // 2 台目の保存先ルートに適用する。
        let b = engine(provider.clone(), &app_b, "device-b");
        fs::create_dir_all(other_docs.join("projects/p9")).unwrap();
        b.sync(&ProjectTarget::profile(&other_docs), SyncOptions::default())
            .await
            .unwrap();
        assert_eq!(
            fs::read(other_docs.join("about.json")).unwrap(),
            b"{\"name\":\"taku\"}"
        );
        assert!(!other_docs.join("projects/p1").exists());

        // 両方で変えたら about.json の path SHA 配下の JSON 版だけで双方を保護する。
        put(&a.saver(), &profile, "about.json", b"{\"name\":\"a\"}");
        a.sync(&profile, SyncOptions::default()).await.unwrap();
        let profile_b = ProjectTarget::profile(&other_docs);
        put(&b.saver(), &profile_b, "about.json", b"{\"name\":\"b\"}");
        b.sync(&profile_b, SyncOptions::default()).await.unwrap();
        let conflicts = b.list_conflicts(&profile_b).unwrap();
        assert_eq!(conflicts.len(), 1);
        let conflict = &conflicts[0];
        let namespace = sha(b"about.json");
        let prefix = format!("versions/files/{namespace}/v_");
        let local_version = conflict.local_version_path.as_ref().unwrap();
        let remote_version = conflict.remote_version_path.as_ref().unwrap();
        assert!(local_version.starts_with(&prefix) && local_version.ends_with(".json"));
        assert!(remote_version.starts_with(&prefix) && remote_version.ends_with(".json"));
        assert_eq!(
            fs::read(other_docs.join(local_version)).unwrap(),
            b"{\"name\":\"b\"}"
        );
        assert_eq!(
            fs::read(other_docs.join(remote_version)).unwrap(),
            b"{\"name\":\"a\"}"
        );
        assert_eq!(
            provider
                .remote_bytes(PROFILE_PROJECT_ID, local_version)
                .unwrap(),
            b"{\"name\":\"b\"}"
        );
        assert_eq!(
            provider
                .remote_file(PROFILE_PROJECT_ID, local_version)
                .unwrap()
                .sha256,
            sha(b"{\"name\":\"b\"}")
        );
        assert_eq!(
            provider
                .remote_bytes(PROFILE_PROJECT_ID, remote_version)
                .unwrap(),
            b"{\"name\":\"a\"}"
        );
        assert_eq!(
            provider
                .remote_file(PROFILE_PROJECT_ID, remote_version)
                .unwrap()
                .sha256,
            sha(b"{\"name\":\"a\"}")
        );
        let mut paths = provider.remote_paths(PROFILE_PROJECT_ID);
        paths.sort();
        let mut expected = vec![
            "about.json".to_string(),
            local_version.clone(),
            remote_version.clone(),
        ];
        expected.sort();
        assert_eq!(paths, expected);
        assert!(provider.remote_paths("p1").is_empty());
        assert!(!other_docs.join("projects/p1").exists());
        assert!(!other_docs.join("flows").exists());
        assert!(!other_docs.join("settings.json").exists());
        assert!(!other_docs.join("private").exists());
    });
}

#[test]
fn expired_audio_is_reported_once_and_is_not_a_failure() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        provider.put_remote("p123", "inputs/old.m4a", b"old-audio", "other");
        {
            let mut projects = provider.projects.lock().unwrap();
            let manifest = projects.get_mut("p123").unwrap();
            manifest.files[0].available = false;
        }
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        let mut events = engine.subscribe();
        let status = engine.sync(&target, SyncOptions::default()).await.unwrap();
        assert!(matches!(status, SyncStatus::Synced { .. }), "{status:?}");
        engine.sync(&target, SyncOptions::default()).await.unwrap();
        let mut expired = 0;
        while let Ok(event) = events.try_recv() {
            expired += usize::from(matches!(event, SyncEvent::Expired { .. }));
        }
        assert_eq!(expired, 1);
        assert_eq!(
            engine.project_snapshot(&target).unwrap().expired_audio,
            vec!["inputs/old.m4a".to_owned()]
        );
        assert!(!copy.join("inputs/old.m4a").exists());
    });
}

#[test]
fn removing_the_local_copy_of_a_conflicting_version_adopts_the_cloud_version() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        provider.put_remote("p123", "versions/step/3.md", b"cloud-version", "device-a");
        let engine = engine(provider.clone(), &app, "device-b");
        let target = target("p123", &copy);
        fs::create_dir_all(copy.join("versions/step")).unwrap();
        fs::write(copy.join("versions/step/3.md"), b"local-version").unwrap();
        engine.sync(&target, SyncOptions::default()).await.unwrap();
        let conflict = engine.list_conflicts(&target).unwrap()[0].clone();
        assert_eq!(conflict.kind, ConflictKind::Version);
        let protected_local = conflict.local_version_path.clone().unwrap();
        assert_eq!(
            provider.remote_bytes("p123", &protected_local).unwrap(),
            b"local-version"
        );
        fs::remove_file(copy.join("versions/step/3.md")).unwrap();
        engine.sync(&target, SyncOptions::default()).await.unwrap();
        engine.sync(&target, SyncOptions::default()).await.unwrap();
        assert_eq!(
            fs::read(copy.join("versions/step/3.md")).unwrap(),
            b"cloud-version"
        );
        let snapshot = engine.project_snapshot(&target).unwrap();
        assert!(snapshot.conflicts.is_empty());
        assert!(snapshot.blocked.is_empty());
        assert_eq!(
            fs::read(copy.join(&protected_local)).unwrap(),
            b"local-version"
        );
    });
}

#[test]
fn recreated_cloud_project_never_deletes_local_files() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let provider = Arc::new(MemoryProvider::new());
        let engine = engine(provider.clone(), &app, "device");
        let target = target("p123", &copy);
        put(&engine.saver(), &target, "page.md", b"keep me");
        put(&engine.saver(), &target, "notes.md", b"and me");
        engine.sync(&target, SyncOptions::default()).await.unwrap();
        assert_eq!(provider.revision("p123"), 1);
        // 長い休止の間に案件が回収され、同じ projectId で空の案件が作り直された。
        provider
            .projects
            .lock()
            .unwrap()
            .insert("p123".into(), Manifest::empty("p123"));
        engine.sync(&target, SyncOptions::default()).await.unwrap();
        assert_eq!(fs::read(copy.join("page.md")).unwrap(), b"keep me");
        assert_eq!(fs::read(copy.join("notes.md")).unwrap(), b"and me");
        assert_eq!(provider.remote_paths("p123"), ["notes.md", "page.md"]);
    });
}
