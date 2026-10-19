mod support;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use niho_desktop_vault::*;
use serde_json::json;
use support::memory::{sha, MemoryProvider};
use support::{dirs, engine, put, state, target};
use tempfile::tempdir;

const RUN_1: &str = "{\"at\":\"2026-10-16T00:00:00Z\",\"id\":\"r1\"}\n";
const RUN_2: &str =
    "{\"at\":\"2026-10-16T00:00:01Z\",\"id\":\"r2\",\"versionPath\":\"versions/step/v_1.md\"}\n";

fn project_dir(app: &Path) -> PathBuf {
    support::account("me").dir(app).join("p123")
}

fn write_snapshot(app: &Path, bytes: &[u8]) {
    let directory = project_dir(app).join("snapshots");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(sha(bytes)), bytes).unwrap();
}

fn write_journal(
    app: &Path,
    id: &str,
    generation: u64,
    status: &str,
    entries: &[(&str, Option<&[u8]>, Option<&[u8]>)],
) {
    let paths: Vec<_> = entries
        .iter()
        .map(|(path, previous, next)| {
            json!({
                "path": path,
                "previousSha256": previous.map(sha),
                "nextSha256": next.map(sha),
                "snapshotRef": next.map(sha),
            })
        })
        .collect();
    let journal = json!({
        "localSaveId": id,
        "generation": generation,
        "kind": {"type": "version"},
        "status": status,
        "createdAt": "2026-10-16T00:00:00.000Z",
        "paths": paths,
    });
    let directory = project_dir(app).join("journal");
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join(format!("{id}.json")),
        serde_json::to_vec(&journal).unwrap(),
    )
    .unwrap();
}

fn listing(directory: &Path) -> Vec<String> {
    match fs::read_dir(directory) {
        Ok(entries) => entries
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// page.md v1 と runs.jsonl（1 行）を保存済みにした写し。
fn saved_copy(app: &Path, copy: &Path) -> (LocalSaver, ProjectTarget) {
    let provider = Arc::new(MemoryProvider::new());
    let engine = engine(provider, app, "device");
    let saver = engine.saver();
    let target = target("p123", copy);
    saver
        .save(
            &target,
            SaveGroup {
                writes: vec![
                    SaveWrite::Put {
                        path: "page.md".into(),
                        bytes: b"v1".to_vec(),
                    },
                    SaveWrite::Put {
                        path: "runs.jsonl".into(),
                        bytes: RUN_1.as_bytes().to_vec(),
                    },
                ],
                kind: SaveKind::Run,
            },
        )
        .unwrap();
    (saver, target)
}

fn next_group() -> Vec<(&'static str, Option<&'static [u8]>, Option<Vec<u8>>)> {
    vec![
        ("page.md", Some(b"v1" as &[u8]), Some(b"v2".to_vec())),
        ("versions/step/v_1.md", None, Some(b"v2".to_vec())),
        (
            "runs.jsonl",
            Some(RUN_1.as_bytes()),
            Some(format!("{RUN_1}{RUN_2}").into_bytes()),
        ),
    ]
}

fn prepare_next_group(app: &Path, generation: u64) {
    let group = next_group();
    for (_, _, next) in &group {
        write_snapshot(app, next.as_deref().unwrap());
    }
    let entries: Vec<(&str, Option<&[u8]>, Option<&[u8]>)> = group
        .iter()
        .map(|(path, previous, next)| (*path, *previous, next.as_deref()))
        .collect();
    write_journal(app, "s_crash", generation, "prepared", &entries);
}

fn assert_group_applied_once(copy: &Path) {
    assert_eq!(fs::read(copy.join("page.md")).unwrap(), b"v2");
    assert_eq!(fs::read(copy.join("versions/step/v_1.md")).unwrap(), b"v2");
    let runs = fs::read_to_string(copy.join("runs.jsonl")).unwrap();
    assert_eq!(runs, format!("{RUN_1}{RUN_2}"));
    assert_eq!(
        runs.lines().filter(|line| line.contains("\"r2\"")).count(),
        1
    );
}

#[test]
fn save_writes_the_group_then_clears_journal_and_snapshots() {
    let temp = tempdir().unwrap();
    let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
    let (_, _) = saved_copy(&app, &copy);
    assert_eq!(fs::read(copy.join("page.md")).unwrap(), b"v1");
    assert!(listing(&project_dir(&app).join("journal")).is_empty());
    assert!(listing(&project_dir(&app).join("snapshots")).is_empty());
    let current = state(&app, "p123");
    assert_eq!(current.dirty.get("page.md"), Some(&1));
    assert_eq!(current.dirty.get("runs.jsonl"), Some(&1));
    assert_eq!(current.local_generation, 1);
    assert_eq!(current.acknowledged_generation, 0);
    assert_eq!(current.groups.get(&1).map(Vec::len), Some(2));
}

#[test]
fn orphan_snapshot_without_journal_is_collected() {
    let temp = tempdir().unwrap();
    let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
    let (saver, target) = saved_copy(&app, &copy);
    write_snapshot(&app, b"orphan");
    let report = saver.recover(&target).unwrap();
    assert_eq!(report.discarded_snapshots, 1);
    assert!(report.rolled_forward.is_empty());
    assert!(listing(&project_dir(&app).join("snapshots")).is_empty());
    assert_eq!(fs::read(copy.join("page.md")).unwrap(), b"v1");
}

#[test]
fn prepared_journal_with_nothing_applied_rolls_forward_the_whole_group_once() {
    let temp = tempdir().unwrap();
    let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
    let (saver, target) = saved_copy(&app, &copy);
    prepare_next_group(&app, 2);
    let report = saver.recover(&target).unwrap();
    assert_eq!(
        report.rolled_forward,
        ["page.md", "versions/step/v_1.md", "runs.jsonl"]
    );
    assert!(report.protected_conflicts.is_empty());
    assert_group_applied_once(&copy);
    let current = state(&app, "p123");
    for path in ["page.md", "versions/step/v_1.md", "runs.jsonl"] {
        assert_eq!(current.dirty.get(path), Some(&2), "{path}");
    }
    assert_eq!(current.dirty_generation, 2);
    assert_eq!(current.groups.get(&2).map(Vec::len), Some(3));
    assert!(listing(&project_dir(&app).join("journal")).is_empty());
    assert!(listing(&project_dir(&app).join("snapshots")).is_empty());
    // もう一度 recover しても何も起きない。
    let again = saver.recover(&target).unwrap();
    assert!(again.rolled_forward.is_empty());
    assert_group_applied_once(&copy);
}

#[test]
fn prepared_journal_with_part_of_the_group_applied_finishes_the_rest() {
    let temp = tempdir().unwrap();
    let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
    let (saver, target) = saved_copy(&app, &copy);
    prepare_next_group(&app, 2);
    // page.md の rename までは終わっていた。
    fs::write(copy.join("page.md"), b"v2").unwrap();
    let report = saver.recover(&target).unwrap();
    assert_eq!(
        report.rolled_forward,
        ["versions/step/v_1.md", "runs.jsonl"]
    );
    assert_group_applied_once(&copy);
    assert_eq!(state(&app, "p123").dirty.get("page.md"), Some(&2));
}

#[test]
fn prepared_journal_never_overwrites_a_file_that_changed_outside_the_app() {
    let temp = tempdir().unwrap();
    let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
    let (saver, target) = saved_copy(&app, &copy);
    prepare_next_group(&app, 2);
    fs::write(copy.join("page.md"), b"external").unwrap();
    let mut events = {
        let (sender, receiver) = tokio::sync::broadcast::channel(16);
        let saver = saver.clone().with_events(sender);
        let report = saver.recover(&target).unwrap();
        assert_eq!(report.protected_conflicts, ["page.md"]);
        assert_eq!(
            report.rolled_forward,
            ["versions/step/v_1.md", "runs.jsonl"]
        );
        receiver
    };
    assert!(matches!(
        events.try_recv().unwrap(),
        SyncEvent::Conflict { ref path, .. } if path == "page.md"
    ));
    assert_eq!(fs::read(copy.join("page.md")).unwrap(), b"external");
    let provider = Arc::new(MemoryProvider::new());
    let engine = engine(provider, &app, "device");
    let conflicts = engine.list_conflicts(&target).unwrap();
    assert_eq!(conflicts.len(), 1);
    let entry = &conflicts[0];
    assert_eq!(entry.origin, ConflictOrigin::Recovery);
    assert_eq!(
        entry.local_sha256.as_deref(),
        Some(sha(b"external").as_str())
    );
    assert_eq!(entry.remote_sha256.as_deref(), Some(sha(b"v2").as_str()));
    assert_eq!(
        engine
            .read_conflict_copy(&target, &entry.conflict_id, ConflictSide::Local)
            .unwrap()
            .unwrap(),
        b"external"
    );
    assert_eq!(
        engine
            .read_conflict_copy(&target, &entry.conflict_id, ConflictSide::Remote)
            .unwrap()
            .unwrap(),
        b"v2"
    );
    // 双方は immutable な版としても残り、次の同期で上がる。
    for version_path in [&entry.local_version_path, &entry.remote_version_path] {
        let version_path = version_path.as_ref().unwrap();
        assert!(is_immutable_version_path(version_path));
        assert!(copy.join(version_path).exists());
        assert!(state(&app, "p123").dirty.contains_key(version_path));
    }
    assert!(state(&app, "p123").conflicts.contains_key("page.md"));
}

#[test]
fn committed_journal_that_was_not_deleted_is_only_finished() {
    let temp = tempdir().unwrap();
    let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
    let (saver, target) = saved_copy(&app, &copy);
    let before = state(&app, "p123");
    write_journal(
        &app,
        "s_done",
        1,
        "localCommitted",
        &[
            ("page.md", None, Some(b"v1")),
            ("runs.jsonl", None, Some(RUN_1.as_bytes())),
        ],
    );
    let report = saver.recover(&target).unwrap();
    assert!(report.rolled_forward.is_empty());
    assert!(listing(&project_dir(&app).join("journal")).is_empty());
    let after = state(&app, "p123");
    assert_eq!(after.dirty, before.dirty);
    assert_eq!(after.dirty_generation, before.dirty_generation);
    assert_eq!(fs::read_to_string(copy.join("runs.jsonl")).unwrap(), RUN_1);
}

#[test]
fn recovered_group_is_committed_once_with_its_version_and_runs_line() {
    support::runtime().block_on(async {
        let temp = tempdir().unwrap();
        let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
        let (_, target) = saved_copy(&app, &copy);
        prepare_next_group(&app, 2);
        let provider = Arc::new(MemoryProvider::new());
        let engine = engine(provider.clone(), &app, "device");
        // flight は通信より前に journal を回復する。
        engine.sync(&target, SyncOptions::default()).await.unwrap();
        assert_eq!(provider.remote_bytes("p123", "page.md").unwrap(), b"v2");
        assert_eq!(
            provider
                .remote_bytes("p123", "versions/step/v_1.md")
                .unwrap(),
            b"v2"
        );
        assert_eq!(
            String::from_utf8(provider.remote_bytes("p123", "runs.jsonl").unwrap()).unwrap(),
            format!("{RUN_1}{RUN_2}")
        );
        let commits = provider.committed_paths();
        assert_eq!(commits.len(), 1);
        assert_eq!(
            commits[0]
                .iter()
                .filter(|path| path.as_str() == "versions/step/v_1.md")
                .count(),
            1
        );
        let current = state(&app, "p123");
        assert!(current.dirty.is_empty());
        assert_eq!(current.acknowledged_generation, current.local_generation);
    });
}

#[test]
fn immutable_versions_and_scope_are_enforced_before_anything_is_written() {
    let temp = tempdir().unwrap();
    let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
    let (saver, target) = saved_copy(&app, &copy);
    put(&saver, &target, "versions/step/v_1.md", b"first");
    let rewrite = saver.save(
        &target,
        SaveGroup {
            writes: vec![
                SaveWrite::Put {
                    path: "page.md".into(),
                    bytes: b"should not be written".to_vec(),
                },
                SaveWrite::Put {
                    path: "versions/step/v_1.md".into(),
                    bytes: b"second".to_vec(),
                },
            ],
            kind: SaveKind::Version,
        },
    );
    assert!(matches!(rewrite, Err(VaultError::ImmutableVersion { .. })));
    assert_eq!(fs::read(copy.join("page.md")).unwrap(), b"v1");
    assert!(matches!(
        saver.save(
            &target,
            SaveGroup {
                writes: vec![SaveWrite::Delete {
                    path: "recordings/r1/versions/s/v_1.md".into()
                }],
                kind: SaveKind::Edit,
            },
        ),
        Err(VaultError::ImmutableVersion { .. })
    ));
    // 同じ bytes の再保存は通る。
    put(&saver, &target, "versions/step/v_1.md", b"first");
    for invalid in ["../x.md", ".conflicts/x.md", "settings.json", "a/.run.lock"] {
        assert!(saver
            .save(
                &target,
                SaveGroup {
                    writes: vec![SaveWrite::Put {
                        path: invalid.into(),
                        bytes: b"x".to_vec(),
                    }],
                    kind: SaveKind::Edit,
                },
            )
            .is_err());
    }
    let profile = ProjectTarget::profile(&copy);
    assert!(saver
        .save(
            &profile,
            SaveGroup {
                writes: vec![SaveWrite::Put {
                    path: "projects/x.md".into(),
                    bytes: b"x".to_vec(),
                }],
                kind: SaveKind::Edit,
            },
        )
        .is_err());
    assert!(listing(&project_dir(&app).join("journal")).is_empty());
}

#[test]
fn note_changed_marks_outside_changes_with_one_generation() {
    let temp = tempdir().unwrap();
    let [copy, app] = dirs(temp.path(), &["copy", "app"]).try_into().unwrap();
    let (saver, target) = saved_copy(&app, &copy);
    fs::create_dir_all(copy.join("inputs")).unwrap();
    fs::write(copy.join("inputs/a.m4a"), b"audio").unwrap();
    let generation = saver
        .note_changed(
            &target,
            &[
                "inputs/a.m4a".into(),
                "images/x.png".into(),
                ".DS_Store".into(),
            ],
        )
        .unwrap();
    assert_eq!(generation, 2);
    let current = state(&app, "p123");
    assert_eq!(current.dirty.get("inputs/a.m4a"), Some(&2));
    assert_eq!(current.dirty.get("images/x.png"), Some(&2));
    assert!(!current.dirty.contains_key(".DS_Store"));
}
