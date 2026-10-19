mod support;

use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::{collections::BTreeMap, fs};

use niho_desktop_vault::{
    CommitRequest, FileKind, Manifest, ManifestFile, NihoProvider, ProviderKind, Result,
    SyncOptions, SyncStatus, VaultError, VaultProvider,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use support::{walk_files, FakeServer, Reply};
use tempfile::tempdir;

fn file(path: &str, sha: &str, bytes: u64, kind: FileKind) -> ManifestFile {
    ManifestFile {
        path: path.into(),
        sha256: sha.into(),
        bytes,
        kind,
        modified_at: "2026-10-16T00:00:00Z".into(),
        writer_device_id: "d_device".into(),
        writer_device_kind: None,
        retained_until: None,
        available: true,
    }
}

#[test]
fn nested_api_error_and_minimal_tombstone_are_accepted() {
    let server = FakeServer::start(|request| {
        if request.method == "PUT" && request.target.ends_with("/projects/p123") {
            return Reply::json(200, json!({"deleted": true, "revision": 7}));
        }
        if request.method == "POST" && request.target.ends_with("/commit") {
            return Reply::json(
                409,
                json!({"error":{"code":"DOCS_VAULT_REVISION_CONFLICT","message":"again","supportId":"s"}}),
            );
        }
        Reply::json(500, json!({"error":{"code":"UNEXPECTED","message":"bad"}}))
    })
    .expect("fake server bind");
    let provider = NihoProvider::new_for_test(
        &server.base,
        Arc::new(|| async { Ok("token".to_owned()) as Result<String> }),
    )
    .unwrap();
    support::runtime().block_on(async {
        let tombstone = provider.get_or_create_project("p123", None).await.unwrap();
        assert!(tombstone.deleted);
        assert_eq!(tombstone.project_id, "p123");
        assert_eq!(tombstone.revision, 7);
        let error = provider
            .commit(
                "p123",
                &CommitRequest {
                    mutation_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
                    device_id: "d_test".into(),
                    device_kind: None,
                    base_revision: 7,
                    name: None,
                    upserts: vec![],
                    deletes: vec!["page.md".into()],
                    lease_id: None,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(error, VaultError::RevisionConflict));
    });
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[test]
fn two_niho_providers_round_trip_conflict_and_offline_recovery() {
    struct ApiState {
        manifest: Manifest,
        blobs: BTreeMap<String, Vec<u8>>,
    }

    let state = Arc::new(Mutex::new(ApiState {
        manifest: Manifest::empty("p123"),
        blobs: BTreeMap::new(),
    }));
    let offline = Arc::new(AtomicBool::new(false));
    let state_in_server = state.clone();
    let offline_in_server = offline.clone();
    let server = FakeServer::start(move |request| {
        if offline_in_server.load(Ordering::SeqCst) {
            return Reply::json(
                503,
                json!({"error":{"code":"UNAVAILABLE","message":"offline"}}),
            );
        }
        if request.method == "PUT" && request.target.ends_with("/projects/p123") {
            return Reply::json(
                200,
                serde_json::to_value(&state_in_server.lock().unwrap().manifest).unwrap(),
            );
        }
        if request.method == "POST" && request.target.ends_with("/blobs") {
            let input: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
            let sha = input["sha256"].as_str().unwrap().to_owned();
            let bytes = input["inline"].as_str().unwrap().as_bytes().to_vec();
            state_in_server.lock().unwrap().blobs.insert(sha, bytes);
            return Reply::json(200, json!({"status":"stored"}));
        }
        if request.method == "GET" && request.target.ends_with("/content") {
            let sha = request
                .target
                .trim_end_matches("/content")
                .rsplit('/')
                .next()
                .unwrap();
            return Reply::bytes(
                200,
                state_in_server
                    .lock()
                    .unwrap()
                    .blobs
                    .get(sha)
                    .cloned()
                    .unwrap(),
            );
        }
        if request.method == "POST" && request.target.ends_with("/commit") {
            let input: CommitRequest = serde_json::from_slice(&request.body).unwrap();
            let mut state = state_in_server.lock().unwrap();
            if input.base_revision != state.manifest.revision {
                return Reply::json(
                    409,
                    json!({"error":{"code":"DOCS_VAULT_REVISION_CONFLICT","message":"again"}}),
                );
            }
            state
                .manifest
                .files
                .retain(|file| !input.deletes.contains(&file.path));
            for upsert in input.upserts {
                state.manifest.files.retain(|file| file.path != upsert.path);
                state.manifest.files.push(ManifestFile {
                    kind: FileKind::from_path(&upsert.path),
                    path: upsert.path,
                    sha256: upsert.sha256,
                    bytes: upsert.bytes,
                    modified_at: upsert.modified_at,
                    writer_device_id: input.device_id.clone(),
                    writer_device_kind: input.device_kind.clone(),
                    retained_until: None,
                    available: true,
                });
            }
            state.manifest.revision += 1;
            return Reply::json(
                200,
                json!({"mutationId": input.mutation_id, "revision": state.manifest.revision, "replayed": false}),
            );
        }
        Reply::json(
            500,
            json!({"error":{"code":"UNEXPECTED","message":request.target}}),
        )
    })
    .expect("fake server bind");

    let temp = tempdir().unwrap();
    let copy_a = temp.path().join("copy-a");
    let copy_b = temp.path().join("copy-b");
    let app_a = temp.path().join("app-a");
    let app_b = temp.path().join("app-b");
    for path in [&copy_a, &copy_b, &app_a, &app_b] {
        fs::create_dir_all(path).unwrap();
    }
    let provider_a = Arc::new(
        NihoProvider::new_for_test(
            &server.base,
            Arc::new(|| async { Ok("token-a".into()) as Result<String> }),
        )
        .unwrap(),
    );
    let provider_b = Arc::new(
        NihoProvider::new_for_test(
            &server.base,
            Arc::new(|| async { Ok("token-b".into()) as Result<String> }),
        )
        .unwrap(),
    );
    support::runtime().block_on(async {
        let engine_a = support::engine(provider_a, &app_a, "device-a");
        let engine_b = support::engine(provider_b, &app_b, "device-b");
        let target_a = support::target("p123", &copy_a);
        let target_b = support::target("p123", &copy_b);
        fs::write(copy_a.join("page.md"), "one").unwrap();
        engine_a
            .sync_now(&target_a, SyncOptions::default())
            .await
            .unwrap();
        engine_b
            .sync_now(&target_b, SyncOptions::default())
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(copy_b.join("page.md")).unwrap(), "one");

        let same_time = filetime::FileTime::from_unix_time(1_800_000_000, 0);
        fs::write(copy_a.join("page.md"), "from-a").unwrap();
        fs::write(copy_b.join("page.md"), "from-b").unwrap();
        filetime::set_file_mtime(copy_a.join("page.md"), same_time).unwrap();
        filetime::set_file_mtime(copy_b.join("page.md"), same_time).unwrap();
        engine_a
            .sync_now(&target_a, SyncOptions::default())
            .await
            .unwrap();
        assert!(matches!(
            engine_b
                .sync_now(&target_b, SyncOptions::default())
                .await
                .unwrap(),
            SyncStatus::Conflicted { .. }
        ));
        // 同じ mtime でも勝者を決めない。双方の写しが残り、remote は上書きしない。
        let copies: Vec<String> = walk_files(&copy_b.join(".conflicts"))
            .into_iter()
            .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
            .map(|path| fs::read_to_string(path).unwrap())
            .collect();
        assert_eq!(copies.len(), 2);
        assert!(copies.contains(&"from-a".to_owned()));
        assert!(copies.contains(&"from-b".to_owned()));
        assert_eq!(
            fs::read_to_string(copy_b.join("page.md")).unwrap(),
            "from-b"
        );
        {
            let api = state.lock().unwrap();
            let page = api
                .manifest
                .files
                .iter()
                .find(|file| file.path == "page.md")
                .unwrap();
            assert_eq!(api.blobs.get(&page.sha256).unwrap(), b"from-a");
            assert!(api
                .manifest
                .files
                .iter()
                .any(|file| file.path.starts_with("versions/files/")));
        }

        offline.store(true, Ordering::SeqCst);
        fs::write(copy_a.join("offline.md"), "queued").unwrap();
        assert_eq!(
            engine_a
                .sync_now(&target_a, SyncOptions::default())
                .await
                .unwrap(),
            SyncStatus::Offline
        );
        offline.store(false, Ordering::SeqCst);
        engine_a
            .sync_now(&target_a, SyncOptions::default())
            .await
            .unwrap();
        engine_b
            .sync_now(&target_b, SyncOptions::default())
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(copy_b.join("offline.md")).unwrap(),
            "queued"
        );
    });
}

#[test]
fn raw_commit_keeps_the_frozen_serialization_instead_of_encoding_it_again() {
    let server = FakeServer::start(|_| {
        Reply::json(
            200,
            json!({"mutationId":"AAAAAAAAAAAAAAAAAAAAAA","revision":1,"replayed":false}),
        )
    })
    .expect("fake server bind");
    let request = CommitRequest {
        mutation_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
        device_id: "device".into(),
        device_kind: None,
        base_revision: 0,
        name: Some("案件".into()),
        upserts: vec![],
        deletes: vec!["page.md".into()],
        lease_id: None,
    };
    let frozen = serde_json::to_vec_pretty(&request).unwrap();
    assert_ne!(frozen, serde_json::to_vec(&request).unwrap());
    support::runtime().block_on(async {
        let provider = NihoProvider::new_for_test(&server.base, token()).unwrap();
        provider
            .commit_raw("p123", &request, &frozen)
            .await
            .unwrap();
    });
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].body, frozen);
}

#[test]
fn engine_restart_replays_the_exact_http_body_before_sending_a_later_edit() {
    struct ReplayState {
        manifest: Manifest,
        commit_bodies: Vec<Vec<u8>>,
        statuses_at_dispatch: Vec<Option<String>>,
    }

    let temp = tempdir().unwrap();
    let copy = temp.path().join("copy");
    let app = temp.path().join("app");
    fs::create_dir_all(&copy).unwrap();
    fs::create_dir_all(&app).unwrap();
    let outbox = support::account("me").dir(&app).join("p123/outbox");
    let state = Arc::new(Mutex::new(ReplayState {
        manifest: Manifest::empty("p123"),
        commit_bodies: Vec::new(),
        statuses_at_dispatch: Vec::new(),
    }));
    let server_state = state.clone();
    let server_outbox = outbox.clone();
    let server = FakeServer::start(move |request| {
        if request.method == "PUT" && request.target.ends_with("/projects/p123") {
            return Reply::json(
                200,
                serde_json::to_value(&server_state.lock().unwrap().manifest).unwrap(),
            );
        }
        if request.method == "POST" && request.target.ends_with("/blobs") {
            return Reply::json(200, json!({"status": "stored"}));
        }
        if request.method == "POST" && request.target.ends_with("/commit") {
            let input: CommitRequest = serde_json::from_slice(&request.body).unwrap();
            let persisted_status = walk_files(&server_outbox)
                .into_iter()
                .filter_map(|path| fs::read(path).ok())
                .filter_map(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .find(|entry| entry["mutationId"].as_str() == Some(input.mutation_id.as_str()))
                .and_then(|entry| entry["status"].as_str().map(str::to_owned));
            let mut state = server_state.lock().unwrap();
            state.commit_bodies.push(request.body.clone());
            state.statuses_at_dispatch.push(persisted_status);
            let attempt = state.commit_bodies.len();
            if attempt != 2 {
                if let Some(name) = &input.name {
                    state.manifest.name = name.clone();
                }
                state
                    .manifest
                    .files
                    .retain(|file| !input.deletes.contains(&file.path));
                for upsert in &input.upserts {
                    state.manifest.files.retain(|file| file.path != upsert.path);
                    state.manifest.files.push(ManifestFile {
                        path: upsert.path.clone(),
                        sha256: upsert.sha256.clone(),
                        bytes: upsert.bytes,
                        kind: FileKind::from_path(&upsert.path),
                        modified_at: upsert.modified_at.clone(),
                        writer_device_id: input.device_id.clone(),
                        writer_device_kind: None,
                        retained_until: None,
                        available: true,
                    });
                }
                state.manifest.revision = input.base_revision + 1;
            }
            if attempt == 1 {
                // The original mutation committed at revision 1, then another server-side
                // mutation advanced the current manifest. Its replay receipt must still be 1.
                state.manifest.revision = 2;
                return Reply::json(
                    503,
                    json!({"error":{"code":"UNAVAILABLE","message":"response lost"}}),
                );
            }
            return Reply::json(
                200,
                json!({
                    "mutationId": input.mutation_id,
                    "revision": input.base_revision + 1,
                    "replayed": attempt == 2
                }),
            );
        }
        Reply::json(
            500,
            json!({"error":{"code":"UNEXPECTED","message":request.target}}),
        )
    })
    .expect("fake server bind");
    support::runtime().block_on(async {
        let provider = Arc::new(NihoProvider::new_for_test(&server.base, token()).unwrap());
        let first = support::engine(provider, &app, "device");
        let target = support::target("p123", &copy);
        support::put(&first.saver(), &target, "page.md", b"first");
        assert_eq!(
            first
                .sync(
                    &target,
                    SyncOptions {
                        project_name: Some("案件".into()),
                        ..SyncOptions::default()
                    },
                )
                .await
                .unwrap(),
            SyncStatus::Offline
        );
        drop(first);

        let provider = Arc::new(NihoProvider::new_for_test(&server.base, token()).unwrap());
        let restarted = support::engine(provider, &app, "device");
        support::put(&restarted.saver(), &target, "page.md", b"later dirty edit");
        restarted
            .sync_now(&target, SyncOptions::default())
            .await
            .unwrap();
    });

    let state = state.lock().unwrap();
    assert_eq!(state.commit_bodies.len(), 3);
    assert_eq!(
        state.statuses_at_dispatch,
        [
            Some("sent".into()),
            Some("sent".into()),
            Some("sent".into())
        ]
    );
    assert_eq!(state.commit_bodies[0], state.commit_bodies[1]);
    assert_ne!(state.commit_bodies[1], state.commit_bodies[2]);
    let first: CommitRequest = serde_json::from_slice(&state.commit_bodies[0]).unwrap();
    let later: CommitRequest = serde_json::from_slice(&state.commit_bodies[2]).unwrap();
    assert_ne!(first.mutation_id, later.mutation_id);
    assert_eq!(first.name.as_deref(), Some("案件"));
    assert_eq!(first.base_revision, 0);
    assert_eq!(later.base_revision, 2);
    drop(state);
    let commits: Vec<_> = server
        .requests()
        .into_iter()
        .filter(|request| request.target.ends_with("/commit"))
        .collect();
    assert!(commits
        .iter()
        .all(|request| request.header("content-type") == Some("application/json")));
}

#[test]
fn malformed_commit_receipts_keep_pending_mutation_and_dirty_state() {
    for mode in 0..4 {
        let server = FakeServer::start(move |request| {
            if request.method == "PUT" && request.target.ends_with("/projects/p123") {
                return Reply::json(200, serde_json::to_value(Manifest::empty("p123")).unwrap());
            }
            if request.method == "POST" && request.target.ends_with("/blobs") {
                return Reply::json(200, json!({"status": "stored"}));
            }
            if request.method == "POST" && request.target.ends_with("/commit") {
                let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                return match mode {
                    0 => Reply::json(200, json!({"revision": 1, "replayed": false})),
                    1 => Reply::json(
                        200,
                        json!({"mutationId": body["mutationId"], "revision": 1}),
                    ),
                    2 => Reply::json(
                        200,
                        json!({"mutationId": "WWWWWWWWWWWWWWWWWWWWWW", "revision": 1, "replayed": false}),
                    ),
                    _ => Reply::json(
                        200,
                        json!({"mutationId": body["mutationId"], "revision": 2, "replayed": false}),
                    ),
                };
            }
            Reply::json(
                500,
                json!({"error":{"code":"UNEXPECTED","message":request.target}}),
            )
        })
        .expect("fake server bind");
        let temp = tempdir().unwrap();
        let copy = temp.path().join("copy");
        let app = temp.path().join("app");
        fs::create_dir_all(&copy).unwrap();
        fs::create_dir_all(&app).unwrap();
        support::runtime().block_on(async {
            let provider = Arc::new(NihoProvider::new_for_test(&server.base, token()).unwrap());
            let engine = support::engine(provider, &app, "device");
            let target = support::target("p123", &copy);
            support::put(&engine.saver(), &target, "page.md", b"keep dirty");
            assert!(matches!(
                engine.sync(&target, SyncOptions::default()).await,
                Err(VaultError::InvalidResponse(_))
            ));
        });
        let current = support::state(&app, "p123");
        assert_eq!(current.pending_mutations.len(), 1, "mode {mode}");
        assert!(current.dirty.contains_key("page.md"), "mode {mode}");
        assert_eq!(
            walk_files(&support::account("me").dir(&app).join("p123/outbox")).len(),
            1,
            "mode {mode}"
        );
    }
}

#[test]
fn invalid_durable_body_stops_before_any_http_request() {
    let server = FakeServer::start(|request| {
        Reply::json(
            500,
            json!({"error":{"code":"UNEXPECTED","message":request.target}}),
        )
    })
    .expect("fake server bind");
    let temp = tempdir().unwrap();
    let copy = temp.path().join("copy");
    let app = temp.path().join("app");
    fs::create_dir_all(&copy).unwrap();
    fs::create_dir_all(&app).unwrap();
    let provider = Arc::new(NihoProvider::new_for_test(&server.base, token()).unwrap());
    let engine = support::engine(provider, &app, "device");
    let target = support::target("p123", &copy);
    support::put(&engine.saver(), &target, "page.md", b"keep");

    let mutation_id = "BBBBBBBBBBBBBBBBBBBBBB";
    let project = support::account("me").dir(&app).join("p123");
    let mut current = support::state(&app, "p123");
    current.pending_mutations.push(mutation_id.into());
    fs::write(
        project.join("state.json"),
        serde_json::to_vec_pretty(&current).unwrap(),
    )
    .unwrap();
    let request = CommitRequest {
        mutation_id: mutation_id.into(),
        device_id: "device".into(),
        device_kind: None,
        base_revision: 0,
        name: None,
        upserts: vec![],
        deletes: vec![],
        lease_id: None,
    };
    let frozen_utf8 = serde_json::to_string(&request).unwrap();
    fs::create_dir_all(project.join("outbox")).unwrap();
    fs::write(
        project.join(format!("outbox/{mutation_id}.json")),
        serde_json::to_vec_pretty(&json!({
            "mutationId": mutation_id,
            "createdAt": "2026-10-17T00:00:00.000Z",
            "request": request,
            "frozenBody": {
                "version": 1,
                "sha256": "0".repeat(64),
                "utf8": frozen_utf8
            },
            "generations": {},
            "snapshotRefs": [],
            "status": "prepared"
        }))
        .unwrap(),
    )
    .unwrap();

    support::runtime().block_on(async {
        assert!(matches!(
            engine.sync(&target, SyncOptions::default()).await,
            Err(VaultError::OutboxRecoveryRequired { .. })
        ));
    });
    assert!(server.requests().is_empty());
    let current = support::state(&app, "p123");
    assert_eq!(current.pending_mutations, [mutation_id.to_owned()]);
    assert!(current.dirty.contains_key("page.md"));
    let entry: serde_json::Value = serde_json::from_slice(
        &fs::read(project.join(format!("outbox/{mutation_id}.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(entry["status"], "prepared");
}

#[test]
fn signed_resumable_complete_and_expired_audio_use_the_wire_contract() {
    let downloaded = b"downloaded".to_vec();
    let other_sha = sha(&downloaded);
    let other_sha_for_server = other_sha.clone();
    let resumable_calls = Arc::new(AtomicUsize::new(0));
    let resumable_calls_in_server = resumable_calls.clone();
    let resumable_chunks = Arc::new(Mutex::new(Vec::new()));
    let resumable_chunks_in_server = resumable_chunks.clone();
    let server = FakeServer::start(move |request| {
        let host = request.header("host").unwrap();
        if request.method == "POST" && request.target.ends_with("/blobs") {
            let input: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
            let resumable = input["contentType"].as_str().unwrap().starts_with("audio/");
            return Reply::json(
                200,
                json!({
                  "status": "upload",
                  "uploadId": if resumable { "audio-upload" } else { "put-upload" },
                  "method": if resumable { "resumable" } else { "put" },
                  "url": format!("http://{host}/upload"),
                  "headers": {"x-goog-if-generation-match": "0"},
                  "expiresAt": "2026-10-16T01:00:00Z"
                }),
            );
        }
        if request.method == "PUT" && request.target == "/upload" {
            if let Some(content_range) = request.header("content-range") {
                resumable_chunks_in_server
                    .lock()
                    .unwrap()
                    .push((content_range.to_owned(), request.body.len()));
                if resumable_calls_in_server.fetch_add(1, Ordering::SeqCst) == 0 {
                    let mut reply = Reply::bytes(308, Vec::new());
                    reply.headers.push(("Range".into(), "bytes=0-0".into()));
                    return reply;
                }
                let range = content_range
                    .strip_prefix("bytes ")
                    .unwrap()
                    .split('/')
                    .next()
                    .unwrap();
                let (start, end) = range.split_once('-').unwrap();
                let total = content_range
                    .rsplit('/')
                    .next()
                    .unwrap()
                    .parse::<usize>()
                    .unwrap();
                assert_eq!(
                    request.body.len(),
                    end.parse::<usize>().unwrap() + 1 - start.parse::<usize>().unwrap()
                );
                if end.parse::<usize>().unwrap() + 1 < total {
                    let mut reply = Reply::bytes(308, Vec::new());
                    reply
                        .headers
                        .push(("Range".into(), format!("bytes=0-{end}")));
                    return reply;
                }
            }
            return Reply::bytes(200, Vec::new());
        }
        if request.method == "POST" && request.target.ends_with("/complete") {
            return Reply::json(200, json!({}));
        }
        if request.method == "GET"
            && request
                .target
                .ends_with(&format!("/blobs/{other_sha_for_server}"))
        {
            return Reply::json(
                200,
                json!({"method":"get", "url":format!("http://{host}/download?generation=42"), "expiresAt":"2026-10-16T01:00:00Z"}),
            );
        }
        if request.method == "GET" && request.target == "/download?generation=42" {
            return Reply::bytes(200, b"downloaded".to_vec());
        }
        if request.method == "GET" && request.target.ends_with("/blobs/expired-lookup") {
            return Reply::json(
                410,
                json!({"error":{"code":"DOCS_VAULT_BLOB_EXPIRED","message":"expired"}}),
            );
        }
        Reply::json(
            500,
            json!({"error":{"code":"UNEXPECTED","message":request.target}}),
        )
    });
    let server = server.expect("fake server bind");
    let token_calls = Arc::new(AtomicUsize::new(0));
    let calls = token_calls.clone();
    let token = move || {
        let count = calls.fetch_add(1, Ordering::SeqCst);
        async move { Ok(format!("token-{count}")) as Result<String> }
    };
    let provider = NihoProvider::new_for_test(&server.base, Arc::new(token)).unwrap();
    let transfer_temp = tempdir().unwrap();
    support::runtime().block_on(async {
        let large = vec![b'x'; 256 * 1024 + 1];
        let large_sha = sha(&large);
        let large_path = transfer_temp.path().join("large.md");
        fs::write(&large_path, &large).unwrap();
        let large_len = large.len() as u64;
        drop(large);
        let mut large_source = fs::File::open(&large_path).unwrap();
        provider
            .upload_blob_file(
                "p123",
                &file("large.md", &large_sha, large_len, FileKind::Text),
                &mut large_source,
            )
            .await
            .unwrap();
        let audio_sha = sha(b"abc");
        let audio_path = transfer_temp.path().join("audio.aifc");
        fs::write(&audio_path, b"abc").unwrap();
        let mut audio_source = fs::File::open(&audio_path).unwrap();
        provider
            .upload_blob_file(
                "p123",
                &file("audio.aifc", &audio_sha, 3, FileKind::Audio),
                &mut audio_source,
            )
            .await
            .unwrap();
        let large_audio = vec![b'a'; 8 * 1024 * 1024 + 1];
        let large_audio_sha = sha(&large_audio);
        let large_audio_path = transfer_temp.path().join("large-audio.aifc");
        fs::write(&large_audio_path, &large_audio).unwrap();
        drop(large_audio);
        let mut large_audio_source = fs::File::open(&large_audio_path).unwrap();
        provider
            .upload_blob_file(
                "p123",
                &file(
                    "large-audio.aifc",
                    &large_audio_sha,
                    8 * 1024 * 1024 + 1,
                    FileKind::Audio,
                ),
                &mut large_audio_source,
            )
            .await
            .unwrap();
        let download_path = transfer_temp.path().join("download");
        let mut download = fs::File::create(&download_path).unwrap();
        assert!(provider
            .download_blob_file(
                "p123",
                &file(
                    "blob.bin",
                    &other_sha,
                    downloaded.len() as u64,
                    FileKind::Other
                ),
                &mut download,
            )
            .await
            .unwrap());
        drop(download);
        assert_eq!(fs::read(download_path).unwrap(), b"downloaded");
        let mut expired = file("old.m4a", "expired", 3, FileKind::Audio);
        expired.available = false;
        assert_eq!(
            provider.download_blob("p123", &expired).await.unwrap(),
            None
        );
        let expired_sha = sha(b"old");
        provider
            .upload_blob(
                "p123",
                &file("old.m4a", &expired_sha, 3, FileKind::Audio),
                b"old".to_vec(),
            )
            .await
            .unwrap();
        let lookup = file("lookup.m4a", "expired-lookup", 3, FileKind::Audio);
        assert_eq!(provider.download_blob("p123", &lookup).await.unwrap(), None);
    });

    let requests = server.requests();
    let chunks = resumable_chunks.lock().unwrap();
    assert_eq!(chunks.len(), 5);
    assert!(chunks.iter().all(|(_, size)| *size <= 8 * 1024 * 1024));
    assert_eq!(chunks[2].1, 8 * 1024 * 1024);
    assert_eq!(chunks[3].1, 1);
    let api_requests: Vec<_> = requests
        .iter()
        .filter(|request| request.target.starts_with("/api/"))
        .collect();
    assert_eq!(token_calls.load(Ordering::SeqCst), api_requests.len());
    let tokens: Vec<_> = api_requests
        .iter()
        .map(|request| request.header("authorization").unwrap())
        .collect();
    assert_eq!(tokens.len(), 10);
    assert_eq!(
        tokens
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        10
    );
    assert!(requests
        .iter()
        .any(|request| request.header("content-range") == Some("bytes 0-2/3")));
    assert!(requests.iter().any(|request| {
        request.method == "PUT"
            && request.target == "/upload"
            && request.header("content-range").is_none()
            && request.body.len() == 256 * 1024 + 1
    }));
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.target.ends_with("/complete"))
            .count(),
        4
    );
    assert!(requests
        .iter()
        .any(|request| request.header("content-range") == Some("bytes 1-2/3")));
    assert!(requests
        .iter()
        .any(|request| request.target == "/download?generation=42"));
    assert!(requests
        .iter()
        .filter(|request| !request.target.starts_with("/api/"))
        .all(|request| request.header("authorization").is_none()));
}

fn token() -> Arc<dyn niho_desktop_vault::IdTokenProvider> {
    Arc::new(|| async { Ok("token".to_owned()) as Result<String> })
}

#[test]
fn settings_list_and_commit_use_the_server_wire_shapes_behind_an_api_base() {
    let server = FakeServer::start(|request| {
        let path = request.target.split('?').next().unwrap_or_default();
        match (request.method.as_str(), path) {
            ("GET", "/api/me/docs-vault/settings") => {
                Reply::json(200, json!({"provider": "niho", "updatedAt": null}))
            }
            ("PUT", "/api/me/docs-vault/settings") => Reply::json(
                200,
                json!({"provider": "local", "updatedAt": "2026-10-16T00:00:00.000Z"}),
            ),
            ("GET", "/api/me/docs-vault/projects") => Reply::json(
                200,
                json!([{"projectId": "p123", "name": "案件", "revision": 1, "updatedAt": "2026-10-16T00:00:00.000Z", "bytes": 3, "lease": null}]),
            ),
            ("POST", "/api/me/docs-vault/projects/p123/commit") => {
                let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                Reply::json(
                    200,
                    json!({"mutationId": body["mutationId"], "revision": 8, "replayed": true}),
                )
            }
            _ => Reply::json(404, json!({"error": {"code": "NOT_FOUND", "message": request.target}})),
        }
    })
    .expect("fake server bind");
    // Environment.api_base は `/api` で終わる。
    let provider = NihoProvider::new_for_test(&format!("{}/api", server.base), token()).unwrap();
    support::runtime().block_on(async {
        let settings = provider.get_settings("d_mac+1").await.unwrap();
        assert_eq!(settings.provider, ProviderKind::Niho);
        assert_eq!(settings.updated_at, None);
        let updated = provider
            .put_settings("d_mac+1", ProviderKind::Local)
            .await
            .unwrap();
        assert_eq!(
            updated.updated_at.as_deref(),
            Some("2026-10-16T00:00:00.000Z")
        );
        for (reserved, deleted) in [(false, false), (true, false), (false, true), (true, true)] {
            assert_eq!(
                provider.list_projects(reserved, deleted).await.unwrap()[0].project_id,
                "p123"
            );
        }
        let response = provider
            .commit(
                "p123",
                &CommitRequest {
                    mutation_id: "AbCdEfGhIjKlMnOpQrSt_-".into(),
                    device_id: "d_mac".into(),
                    device_kind: Some("mac".into()),
                    base_revision: 7,
                    name: None,
                    upserts: vec![niho_desktop_vault::CommitUpsert {
                        path: "empty.md".into(),
                        sha256: sha(b""),
                        bytes: 0,
                        modified_at: "2026-10-16T00:00:00.000Z".into(),
                    }],
                    deletes: vec![],
                    lease_id: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(response.mutation_id, "AbCdEfGhIjKlMnOpQrSt_-");
        assert_eq!(response.revision, 8);
        assert!(response.replayed);
    });
    let requests = server.requests();
    let targets: Vec<&str> = requests
        .iter()
        .map(|request| request.target.as_str())
        .collect();
    assert_eq!(
        targets,
        [
            "/api/me/docs-vault/settings?deviceId=d_mac%2B1",
            "/api/me/docs-vault/settings",
            "/api/me/docs-vault/projects",
            "/api/me/docs-vault/projects?reserved=1",
            "/api/me/docs-vault/projects?deleted=1",
            "/api/me/docs-vault/projects?reserved=1&deleted=1",
            "/api/me/docs-vault/projects/p123/commit",
        ]
    );
    let put: serde_json::Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(put, json!({"deviceId": "d_mac+1", "provider": "local"}));
    let commit: serde_json::Value = serde_json::from_slice(&requests[6].body).unwrap();
    assert_eq!(
        commit,
        json!({
            "mutationId": "AbCdEfGhIjKlMnOpQrSt_-",
            "deviceId": "d_mac",
            "deviceKind": "mac",
            "baseRevision": 7,
            "upserts": [{"path": "empty.md", "sha256": sha(b""), "bytes": 0, "modifiedAt": "2026-10-16T00:00:00.000Z"}],
            "deletes": []
        })
    );
}

#[test]
fn empty_documents_are_sent_inline_as_an_empty_string() {
    let server = FakeServer::start(|request| {
        if request.method == "POST" && request.target.ends_with("/blobs") {
            return Reply::json(200, json!({"status": "stored"}));
        }
        Reply::json(
            500,
            json!({"error": {"code": "UNEXPECTED", "message": "x"}}),
        )
    })
    .expect("fake server bind");
    let provider = NihoProvider::new_for_test(&server.base, token()).unwrap();
    support::runtime().block_on(async {
        provider
            .upload_blob(
                "p123",
                &file("empty.md", &sha(b""), 0, FileKind::Text),
                Vec::new(),
            )
            .await
            .unwrap();
    });
    let body: serde_json::Value = serde_json::from_slice(&server.requests()[0].body).unwrap();
    assert_eq!(body["inline"], json!(""));
    assert_eq!(body["bytes"], json!(0));
}

#[test]
fn api_errors_map_to_specific_vault_errors() {
    let server = FakeServer::start(|request| {
        let code = request
            .target
            .rsplit('/')
            .nth(1)
            .unwrap_or_default()
            .to_owned();
        let (status, code, details) = match code.as_str() {
            "auth" => (401, "UNAUTHORIZED", json!({})),
            // 停止スイッチ（#18892・D-18）: 接続は失効していない一時停止。再ログインではなく通信できないときと同じ扱い
            "paused" => (
                401,
                "UNAUTHORIZED",
                json!({"reason": "app_connect_disabled"}),
            ),
            "camera" => (
                403,
                "FORBIDDEN",
                json!({"reason": "app_client_not_allowed"}),
            ),
            "busy" => (409, "DOCS_VAULT_PROJECT_GC_IN_PROGRESS", json!({})),
            "immutable" => (
                409,
                "DOCS_VAULT_IMMUTABLE_VERSION",
                json!({"path": "versions/s/1.md"}),
            ),
            "mismatch" => (409, "DOCS_VAULT_MUTATION_MISMATCH", json!({})),
            "missing" => (400, "DOCS_VAULT_BLOB_MISSING", json!({"path": "page.md"})),
            "purged" => (410, "DOCS_VAULT_PROJECT_PURGED", json!({})),
            "limited" => (429, "RATE_LIMITED", json!({})),
            "revision" => (409, "DOCS_VAULT_REVISION_CONFLICT", json!({"revision": 9})),
            "quota" => (413, "DOCS_VAULT_QUOTA_EXCEEDED", json!({})),
            _ => (503, "SERVICE_UNAVAILABLE", json!({})),
        };
        Reply::json(
            status,
            json!({"error": {"code": code, "message": "server message", "details": details}}),
        )
    })
    .expect("fake server bind");
    let provider = NihoProvider::new_for_test(&server.base, token()).unwrap();
    let request = CommitRequest {
        mutation_id: "AAAAAAAAAAAAAAAAAAAAAA".into(),
        device_id: "d".into(),
        device_kind: None,
        base_revision: 0,
        name: None,
        upserts: vec![],
        deletes: vec!["page.md".into()],
        lease_id: None,
    };
    support::runtime().block_on(async {
        for (project, check) in [
            ("auth", (|error: &VaultError| matches!(error, VaultError::AuthRequired)) as fn(&VaultError) -> bool),
            ("paused", |error| matches!(error, VaultError::Offline(_))),
            ("camera", |error| matches!(error, VaultError::Forbidden)),
            ("busy", |error| matches!(error, VaultError::ProjectBusy)),
            ("immutable", |error| {
                matches!(error, VaultError::ImmutableVersion { path } if path == "versions/s/1.md")
            }),
            ("mismatch", |error| matches!(error, VaultError::MutationMismatch)),
            ("missing", |error| matches!(error, VaultError::BlobMissing)),
            ("purged", |error| matches!(error, VaultError::ProjectPurged)),
            ("limited", |error| matches!(error, VaultError::RateLimited)),
            ("revision", |error| matches!(error, VaultError::RevisionConflict)),
            ("quota", |error| matches!(error, VaultError::QuotaExceeded { .. })),
            ("down", |error| matches!(error, VaultError::Offline(_))),
        ] {
            let error = provider.commit(project, &request).await.unwrap_err();
            assert!(check(&error), "{project}: {error:?}");
        }
        assert!(provider.commit("auth", &request).await.unwrap_err().is_auth_required());
        assert!(!provider.commit("paused", &request).await.unwrap_err().is_auth_required());
        assert!(provider.commit("limited", &request).await.unwrap_err().is_unknown_result());
        assert!(provider.commit("busy", &request).await.unwrap_err().is_retryable_later());
    });
}

#[test]
fn rejected_token_stops_the_flight_with_auth_required_status() {
    let server = FakeServer::start(|_| {
        Reply::json(
            401,
            json!({"error": {"code": "UNAUTHORIZED", "message": "expired"}}),
        )
    })
    .expect("fake server bind");
    let temp = tempdir().unwrap();
    let copy = temp.path().join("copy");
    let app = temp.path().join("app");
    fs::create_dir_all(&copy).unwrap();
    fs::create_dir_all(&app).unwrap();
    fs::write(copy.join("page.md"), "page").unwrap();
    let provider = Arc::new(NihoProvider::new_for_test(&server.base, token()).unwrap());
    support::runtime().block_on(async {
        let engine = support::engine(provider, &app, "device");
        let target = support::target("p123", &copy);
        assert_eq!(
            engine.sync(&target, SyncOptions::default()).await.unwrap(),
            SyncStatus::AuthRequired
        );
        let snapshot = engine.project_snapshot(&target).unwrap();
        assert_eq!(
            snapshot.last_error.map(|error| error.kind),
            Some(niho_desktop_vault::SyncErrorKind::AuthRequired)
        );
        assert!(snapshot.dirty.contains_key("page.md"));
    });
    // 署名切れの token は送らない側（app）の責任。crate は 1 回だけ問い合わせて止まる。
    assert_eq!(server.requests().len(), 1);
}

#[test]
fn root_uses_its_dedicated_endpoint_and_normal_project_route_rejects_the_reserved_id() {
    let server = FakeServer::start(|request| {
        if request.method == "PUT" && request.target == "/api/me/docs-vault/root" {
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&request.body).unwrap(),
                json!({})
            );
            let mut manifest = serde_json::to_value(Manifest::empty("docs-root")).unwrap();
            manifest["scope"] = json!("ROOT");
            return Reply::json(200, manifest);
        }
        Reply::json(500, json!({"error":{"code":"UNEXPECTED","message":"bad"}}))
    })
    .unwrap();
    let provider = NihoProvider::new_for_test(&server.base, token()).unwrap();
    support::runtime().block_on(async {
        assert_eq!(
            provider.get_or_create_root().await.unwrap().project_id,
            "docs-root"
        );
        assert!(provider
            .get_or_create_project("docs-root", None)
            .await
            .is_err());
    });
    assert_eq!(server.requests().len(), 1);
}

#[test]
fn wire_scope_is_required_for_root_and_cannot_impersonate_a_folder() {
    for (project_id, scope, valid) in [
        ("docs-root", Some("ROOT"), true),
        ("docs-root", None, false),
        ("docs-root", Some("FOLDER"), false),
        ("docs-root", Some("PROFILE"), false),
        ("p123", Some("ROOT"), false),
        ("profile", Some("ROOT"), false),
        ("p123", Some("FOLDER"), true),
        ("profile", Some("FOLDER"), true),
        ("p123", None, true),
    ] {
        let mut manifest = serde_json::to_value(Manifest::empty(project_id)).unwrap();
        if let Some(scope) = scope {
            manifest["scope"] = json!(scope);
        }
        let server = FakeServer::start(move |_| Reply::json(200, manifest.clone())).unwrap();
        let provider = NihoProvider::new_for_test(&server.base, token()).unwrap();
        support::runtime().block_on(async {
            let response = if project_id == "docs-root" {
                provider.get_root().await
            } else {
                provider.get_project(project_id).await
            };
            assert_eq!(response.is_ok(), valid, "{project_id} / {scope:?}");
        });
    }
}

#[test]
fn a_context_change_while_awaiting_a_token_sends_no_http_request() {
    struct DelayedToken {
        current: AtomicBool,
        started: tokio::sync::Notify,
        released: tokio::sync::Notify,
    }
    #[async_trait::async_trait]
    impl niho_desktop_vault::IdTokenProvider for DelayedToken {
        fn ensure_current(&self) -> Result<()> {
            self.current
                .load(Ordering::SeqCst)
                .then_some(())
                .ok_or(VaultError::AuthRequired)
        }

        async fn id_token(&self) -> Result<String> {
            self.started.notify_one();
            self.released.notified().await;
            Ok("fixture-token".into())
        }
    }
    let server =
        FakeServer::start(|_| Reply::json(200, json!({"provider":"local","updatedAt":null})))
            .unwrap();
    let delayed = Arc::new(DelayedToken {
        current: AtomicBool::new(true),
        started: tokio::sync::Notify::new(),
        released: tokio::sync::Notify::new(),
    });
    let provider = NihoProvider::new_for_test(&server.base, delayed.clone()).unwrap();
    support::runtime().block_on(async {
        let task = tokio::spawn(async move { provider.get_settings("device-a").await });
        delayed.started.notified().await;
        delayed.current.store(false, Ordering::SeqCst);
        delayed.released.notify_one();
        assert!(matches!(task.await.unwrap(), Err(VaultError::AuthRequired)));
    });
    assert!(server.requests().is_empty());
}

#[test]
fn redirects_untrusted_signed_hosts_and_oversized_secret_errors_are_rejected_without_leaking() {
    let redirected =
        FakeServer::start(|_| Reply::json(200, json!({"provider":"local","updatedAt":null})))
            .unwrap();
    let redirect_target = redirected.base.clone();
    let redirecting = FakeServer::start(move |_| {
        let mut reply = Reply::bytes(302, Vec::new());
        reply
            .headers
            .push(("Location".into(), format!("{redirect_target}/stolen")));
        reply
    })
    .unwrap();
    let provider = NihoProvider::new_for_test(&redirecting.base, token()).unwrap();
    support::runtime().block_on(async {
        assert!(provider.get_settings("d").await.is_err());
    });
    assert!(
        redirected.requests().is_empty(),
        "Authorization を redirect しない"
    );

    let signed_redirected = FakeServer::start(|_| Reply::bytes(200, Vec::new())).unwrap();
    let signed_redirect_target = signed_redirected.base.clone();
    let signed_redirecting = FakeServer::start(move |_| {
        let mut reply = Reply::bytes(307, Vec::new());
        reply.headers.push((
            "Location".into(),
            format!("{signed_redirect_target}/stolen"),
        ));
        reply
    })
    .unwrap();
    let signed_upload_url = format!("{}/upload", signed_redirecting.base);
    let signed_api = FakeServer::start(move |request| {
        if request.target.ends_with("/blobs") {
            return Reply::json(
                200,
                json!({
                    "status":"upload", "uploadId":"u", "method":"put",
                    "url":signed_upload_url, "headers":{}, "expiresAt":"x"
                }),
            );
        }
        Reply::json(500, json!({}))
    })
    .unwrap();
    let provider = NihoProvider::new_for_test(&signed_api.base, token()).unwrap();
    support::runtime().block_on(async {
        assert!(provider
            .upload_blob(
                "p123",
                &file("page.md", &sha(b"x"), 1, FileKind::Text),
                b"x".to_vec()
            )
            .await
            .is_err());
    });
    assert!(
        signed_redirected.requests().is_empty(),
        "signed URL の redirect を追わない"
    );
    assert!(signed_redirecting
        .requests()
        .iter()
        .all(|request| request.header("authorization").is_none()));

    let signed = FakeServer::start(|request| {
        if request.target.ends_with("/blobs") {
            return Reply::json(
                200,
                json!({
                    "status":"upload", "uploadId":"u", "method":"put",
                    "url":"https://evil.example/upload?token=SECRET", "headers":{}, "expiresAt":"x"
                }),
            );
        }
        Reply::json(500, json!({}))
    })
    .unwrap();
    let provider = NihoProvider::new_for_test(&signed.base, token()).unwrap();
    support::runtime().block_on(async {
        let error = provider
            .upload_blob(
                "p123",
                &file("page.md", &sha(b"x"), 1, FileKind::Text),
                b"x".to_vec(),
            )
            .await
            .unwrap_err();
        assert!(!error.to_string().contains("evil.example"));
        assert!(!error.to_string().contains("SECRET"));
    });

    let huge = FakeServer::start(|_| {
        Reply::bytes(
            400,
            format!(
                "{{\"error\":{{\"code\":\"BAD\",\"message\":\"token=SECRET?{}\"}}}}",
                "x".repeat(70_000)
            )
            .into_bytes(),
        )
    })
    .unwrap();
    let provider = NihoProvider::new_for_test(&huge.base, token()).unwrap();
    support::runtime().block_on(async {
        let text = provider.get_settings("d").await.unwrap_err().to_string();
        assert!(text.len() < 1_000);
        assert!(!text.contains("SECRET"));
        assert!(!text.contains("token="));
    });
}
