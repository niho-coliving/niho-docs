//! cloud.rs の決まりと、本物の `LocalSaver` を temp の app data・保存先で通すテスト（通信はしない）。

use super::*;
use crate::docs_storage_api::{ClosingState, StorageApiError};
use niho_desktop_account::{ExpiredReason, Profile};
use niho_desktop_vault::{
  save_state, CommitRequest, CommitResponse, ConflictOrigin, ConflictStatus, Lease, Manifest, ManifestFile,
  ProjectSummary, ProviderSettings, VaultState,
};
use std::collections::VecDeque;

struct FakeStorageStatus {
  reads: Mutex<VecDeque<Result<StorageState, StorageApiError>>>,
  selects: Mutex<VecDeque<Result<StorageState, StorageApiError>>>,
  selections: Mutex<Vec<(StorageMode, String)>>,
}

impl FakeStorageStatus {
  fn new(reads: Vec<Result<StorageState, StorageApiError>>) -> Self {
    Self {
      reads: Mutex::new(VecDeque::from(reads)),
      selects: Mutex::new(VecDeque::new()),
      selections: Mutex::new(Vec::new()),
    }
  }
}

#[async_trait]
impl StorageStatusClient for FakeStorageStatus {
  async fn get(&self, _: &dyn IdTokenProvider) -> Result<StorageState, StorageApiError> {
    lock(&self.reads).pop_front().expect("unexpected status GET")
  }

  async fn select_initial(
    &self,
    _: &dyn IdTokenProvider,
    mode: StorageMode,
    expected_epoch: &str,
  ) -> Result<StorageState, StorageApiError> {
    lock(&self.selections).push((mode, expected_epoch.to_owned()));
    lock(&self.selects).pop_front().expect("unexpected status PUT")
  }
}

fn verified_storage(mode: StorageMode) -> StorageState {
  StorageState {
    mode,
    epoch: "1".into(),
    changed_at: None,
    cleanup_pending: false,
    quota_bytes: 5 * 1024 * 1024 * 1024,
    closing: (mode == StorageMode::Closing).then(|| ClosingState {
      device_name: "Studio".into(),
      expires_at: "2026-10-19T00:00:00.000Z".into(),
    }),
  }
}

#[test]
fn fake_storage_api_observes_every_mode_and_fails_closed_when_unavailable() {
  tauri::async_runtime::block_on(async {
    let app = temp_dir("fake-storage-states-app");
    let root = temp_dir("fake-storage-states-root");
    let (account, login) = offline_account(&app);
    login("u1");
    let responses = [
      StorageMode::Unset,
      StorageMode::Cloud,
      StorageMode::Closing,
      StorageMode::Local,
    ]
    .into_iter()
    .map(|mode| Ok(verified_storage(mode)))
    .chain([Err(StorageApiError::Unavailable)])
    .collect();
    let fake = Arc::new(FakeStorageStatus::new(responses));
    let mut raw = CloudInner::new(None, &app, Some(account), "prod", NihoEnvironment::Production, device());
    raw.storage_api = Some(fake);
    let inner = Arc::new(raw);
    inner.storage_gate_enabled.store(true, Ordering::SeqCst);
    inner.open_root(&root);
    for (mode, status) in [
      (StorageMode::Unset, CloudStatus::Unselected),
      (StorageMode::Cloud, CloudStatus::Starting),
      (StorageMode::Closing, CloudStatus::Closing),
      (StorageMode::Local, CloudStatus::Local),
    ] {
      inner.refresh_storage_status().await;
      let state = inner.state();
      assert_eq!(state.storage.unwrap().mode, mode);
      assert_eq!(state.status, status);
      assert!(!inner.context().unwrap().active);
    }
    inner.refresh_storage_status().await;
    assert_eq!(inner.state().status, CloudStatus::StorageUnavailable);
    assert!(inner.state().storage.is_none());
    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root);
  });
}

#[test]
fn initial_local_choice_recovers_lost_put_response_with_get() {
  tauri::async_runtime::block_on(async {
    let app = temp_dir("fake-storage-lost-response-app");
    let root = temp_dir("fake-storage-lost-response-root");
    let (account, login) = offline_account(&app);
    login("u1");
    let fake = Arc::new(FakeStorageStatus::new(vec![Ok(verified_storage(StorageMode::Local))]));
    lock(&fake.selects).push_back(Err(StorageApiError::Unavailable));
    let mut raw = CloudInner::new(
      None,
      &app,
      Some(account.clone()),
      "prod",
      NihoEnvironment::Production,
      device(),
    );
    raw.storage_api = Some(fake.clone());
    let inner = Arc::new(raw);
    inner.storage_gate_enabled.store(true, Ordering::SeqCst);
    inner.open_root(&root);
    *lock(&inner.storage) = Some((account.session_ticket().unwrap(), verified_storage(StorageMode::Unset)));
    assert_eq!(
      inner.select_initial_storage(StorageMode::Local).await.unwrap().status,
      CloudStatus::Local
    );
    assert_eq!(*lock(&fake.selections), vec![(StorageMode::Local, "1".into())]);
    assert!(root_binding(&app, &root).unwrap().account_key.is_none());
    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root);
  });
}

#[test]
fn unset_storage_never_binds_or_starts_sync_before_choice() {
  tauri::async_runtime::block_on(async {
    let app = temp_dir("unselected-gate-app");
    let root = temp_dir("unselected-gate-root");
    let (account, login) = offline_account(&app);
    let inner = Arc::new(CloudInner::new(
      None,
      &app,
      Some(account.clone()),
      "prod",
      NihoEnvironment::Production,
      device(),
    ));
    inner.storage_gate_enabled.store(true, Ordering::SeqCst);
    inner.open_root(&root);
    login("u1");
    let ticket = account.session_ticket().unwrap();
    *lock(&inner.storage) = Some((ticket, verified_storage(StorageMode::Unset)));
    inner.reconcile_with_transition(false).await;
    assert_eq!(inner.state().status, CloudStatus::Unselected);
    assert!(!inner.context().unwrap().active);
    assert!(root_binding(&app, &root).unwrap().account_key.is_none());
    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root);
  });
}

#[test]
fn other_mac_local_choice_keeps_unacknowledged_account_state() {
  tauri::async_runtime::block_on(async {
    let app = temp_dir("local-detach-app");
    let root = temp_dir("local-detach-root");
    let (project_id, _, page) = write_test_document(&root, "未送信の本文");
    let (account, login) = offline_account(&app);
    login("u1");
    let key = account_key("prod", "u1");
    let first = root_binding(&app, &root).unwrap();
    bind_root(&app, &first.root_id, Some(&key)).unwrap();
    let namespace = Namespace::Account {
      account_key: key.clone(),
    };
    let mut pending = VaultState::new(&project_id, &first.root_id, Some(key));
    pending.mark_dirty("pages/docpage23.md");
    save_state(&app, &namespace, &pending).unwrap();
    let inner = Arc::new(CloudInner::new(
      None,
      &app,
      Some(account.clone()),
      "prod",
      NihoEnvironment::Production,
      device(),
    ));
    inner.storage_gate_enabled.store(true, Ordering::SeqCst);
    inner.open_root(&root);
    *lock(&inner.storage) = Some((account.session_ticket().unwrap(), verified_storage(StorageMode::Local)));
    inner.ensure_local_detached().await;
    assert_eq!(inner.state().status, CloudStatus::Local);
    assert!(root_binding(&app, &root).unwrap().account_key.is_none());
    assert_eq!(fs::read_to_string(page).unwrap(), "未送信の本文");
    let archived = app.join(format!(
      "vault/archive/{}/1/{}/{}/state.json",
      namespace.account_key().unwrap(),
      first.root_id,
      project_id
    ));
    let archived_state: VaultState = serde_json::from_slice(&fs::read(archived).unwrap()).unwrap();
    assert!(archived_state.dirty.contains_key("pages/docpage23.md"));
    assert!(!namespace_has_pending(&app, &namespace, &first.root_id).unwrap());
    assert_eq!(
      inner.context().unwrap().binding.namespace(),
      Namespace::Local { root_id: first.root_id }
    );
    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root);
  });
}
use sha2::{Digest, Sha256};
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};

#[test]
fn public_docs_share_links_accept_only_fragment_tokens_on_the_public_page_route() {
  let public_id = "a".repeat(22);
  validate_public_docs_share_url(&format!("https://niho.life/docs/p#{public_id}"), "niho.life").unwrap();

  for url in [
    format!("https://niho.life/docs/p/{public_id}"),
    format!("https://niho.life/docs/p?publicId={public_id}"),
    format!("https://user@niho.life/docs/p#{public_id}"),
    format!("https://evil.test/docs/p#{public_id}"),
    "http://niho.life/docs/p#aaaaaaaaaaaaaaaaaaaaaa".to_owned(),
  ] {
    assert!(validate_public_docs_share_url(&url, "niho.life").is_err(), "{url}");
  }
}

fn temp_dir(name: &str) -> PathBuf {
  let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
    "niho-docs-cloud-{name}-{}-{}",
    std::process::id(),
    crate::process::hex(&crate::process::random_bytes::<4>().unwrap())
  ));
  fs::create_dir_all(&dir).unwrap();
  dir
}

fn sha(bytes: &[u8]) -> String {
  crate::process::hex(&Sha256::digest(bytes))
}

fn sha_path(path: &Path) -> String {
  let mut file = fs::File::open(path).unwrap();
  let mut hasher = Sha256::new();
  let mut buffer = vec![0_u8; 256 * 1024];
  loop {
    let count = file.read(&mut buffer).unwrap();
    if count == 0 {
      break;
    }
    hasher.update(&buffer[..count]);
  }
  format!("{:x}", hasher.finalize())
}

fn sparse_file(path: &Path, bytes: u64, marker: u8) -> String {
  let mut file = fs::OpenOptions::new()
    .create_new(true)
    .read(true)
    .write(true)
    .open(path)
    .unwrap();
  file.set_len(bytes).unwrap();
  file.seek(SeekFrom::Start(bytes - 1)).unwrap();
  file.write_all(&[marker]).unwrap();
  drop(file);
  sha_path(path)
}

fn write_reference_conflict(
  project: &Path,
  path: &str,
  kind: ConflictKind,
  local_sha256: Option<String>,
  remote: ManifestFile,
) -> String {
  let conflict_id = format!("c_{}", store::new_id(22));
  fs::create_dir_all(project.join(".conflicts")).unwrap();
  let entry = ConflictEntry {
    conflict_id: conflict_id.clone(),
    path: path.into(),
    kind,
    origin: ConflictOrigin::Sync,
    status: ConflictStatus::Open,
    base_sha256: None,
    local_sha256,
    remote_sha256: Some(remote.sha256.clone()),
    remote_revision: 2,
    remote_device_id: Some(remote.writer_device_id.clone()),
    remote_modified_at: Some(remote.modified_at.clone()),
    local_modified_at: Some("2026-10-17T00:00:00.000Z".into()),
    local_version_id: None,
    remote_version_id: None,
    local_version_path: None,
    remote_version_path: None,
    local_copy: None,
    remote_copy: None,
    remote_available: true,
    resolution_generation: None,
    remote_file: Some(remote),
    created_at: "2026-10-17T00:00:00.000Z".into(),
    updated_at: "2026-10-17T00:00:00.000Z".into(),
  };
  fs::write(
    project.join(".conflicts/index.json"),
    serde_json::to_vec(&json!({ "schemaVersion": 1, "entries": [entry] })).unwrap(),
  )
  .unwrap();
  conflict_id
}

fn add_local_conflict_copy(project: &Path, conflict_id: &str, bytes: &[u8]) {
  let copy = format!(".conflicts/{conflict_id}/local.md");
  fs::create_dir_all(project.join(format!(".conflicts/{conflict_id}"))).unwrap();
  fs::write(project.join(&copy), bytes).unwrap();
  let index_path = project.join(".conflicts/index.json");
  let mut index: Value = serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
  let entry = index["entries"]
    .as_array_mut()
    .unwrap()
    .iter_mut()
    .find(|entry| entry["conflictId"] == conflict_id)
    .unwrap();
  entry["localCopy"] = json!(copy);
  fs::write(index_path, serde_json::to_vec(&index).unwrap()).unwrap();
}

struct StreamingOnlyProvider {
  bytes: u64,
  marker: u8,
  file_calls: AtomicU64,
  gate: Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>,
}

#[async_trait::async_trait]
impl VaultProvider for StreamingOnlyProvider {
  async fn get_settings(&self, _device_id: &str) -> Result<ProviderSettings, VaultError> {
    unreachable!()
  }

  async fn put_settings(&self, _device_id: &str, _provider: ProviderKind) -> Result<ProviderSettings, VaultError> {
    unreachable!()
  }

  async fn list_projects(&self, _reserved: bool, _deleted: bool) -> Result<Vec<ProjectSummary>, VaultError> {
    unreachable!()
  }

  async fn get_or_create_project(&self, _project_id: &str, _name: Option<&str>) -> Result<Manifest, VaultError> {
    unreachable!()
  }

  async fn get_project(&self, _project_id: &str) -> Result<Manifest, VaultError> {
    unreachable!()
  }

  async fn upload_blob(&self, _project_id: &str, _file: &ManifestFile, _bytes: Vec<u8>) -> Result<(), VaultError> {
    unreachable!()
  }

  async fn download_blob(&self, _project_id: &str, _file: &ManifestFile) -> Result<Option<Vec<u8>>, VaultError> {
    panic!("buffered download must not be used")
  }

  async fn download_blob_file(
    &self,
    _project_id: &str,
    _file: &ManifestFile,
    destination: &mut fs::File,
  ) -> Result<bool, VaultError> {
    self.file_calls.fetch_add(1, Ordering::SeqCst);
    let gate = self.gate.lock().unwrap().take();
    if let Some((started, release)) = gate {
      let _ = started.send(());
      let _ = release.await;
    }
    destination.set_len(self.bytes).map_err(VaultError::from)?;
    destination
      .seek(SeekFrom::Start(self.bytes - 1))
      .map_err(VaultError::from)?;
    destination.write_all(&[self.marker]).map_err(VaultError::from)?;
    destination.seek(SeekFrom::Start(0)).map_err(VaultError::from)?;
    Ok(true)
  }

  async fn commit(&self, _project_id: &str, _request: &CommitRequest) -> Result<CommitResponse, VaultError> {
    unreachable!()
  }

  async fn delete_project(&self, _project_id: &str) -> Result<(), VaultError> {
    unreachable!()
  }

  async fn restore_project(&self, _project_id: &str) -> Result<(), VaultError> {
    unreachable!()
  }

  async fn acquire_lease(
    &self,
    _project_id: &str,
    _device_id: &str,
    _device_name: &str,
    _lease_id: Option<&str>,
  ) -> Result<Lease, VaultError> {
    unreachable!()
  }

  async fn renew_lease(&self, _project_id: &str, _lease_id: &str) -> Result<Lease, VaultError> {
    unreachable!()
  }

  async fn release_lease(&self, _project_id: &str, _lease_id: &str) -> Result<(), VaultError> {
    unreachable!()
  }

  async fn usage(&self) -> Result<Usage, VaultError> {
    unreachable!()
  }
}

fn profile(user_id: &str) -> Profile {
  Profile {
    user_id: user_id.into(),
    display_name: "高浜".into(),
    handle: None,
    avatar_path: None,
    connection_id: "conn".into(),
  }
}

fn binding(account_key: Option<String>) -> RootBinding {
  RootBinding {
    root_id: "r_AAAAAAAAAAAAAAAAAAAAAA".into(),
    path: PathBuf::from("/docs"),
    account_key,
    epoch: 1,
  }
}

fn device() -> Device {
  Device {
    device_id: "d_test".into(),
    device_name: "Studio".into(),
    device_kind: Some("mac".into()),
  }
}

/// 保存先 root と、その結び付き（未ログインの local）の通信しない口。
fn reader(name: &str) -> (PathBuf, PathBuf, Arc<Context>) {
  let app = temp_dir(&format!("{name}-app"));
  let root = temp_dir(&format!("{name}-root"));
  let binding = root_binding(&app, &root).unwrap();
  let context = Context::reader(&app, binding, device(), Arc::new(EditProtection::new()), 1);
  (app, root, Arc::new(context))
}

fn write_test_document(root: &Path, body: &str) -> (String, String, PathBuf) {
  let project_id = "abcdefgh23".to_string();
  let page_id = "docpage23".to_string();
  let project = root.join("projects").join(&project_id);
  let page = project.join("pages").join(format!("{page_id}.md"));
  fs::create_dir_all(page.parent().unwrap()).unwrap();
  fs::write(
    project.join("project.json"),
    serde_json::to_vec(&json!({
      "version": 1,
      "id": project_id.clone(),
      "name": "capture",
      "createdAt": "2026-10-17T00:00:00.000Z",
      "info": { "terms": [], "background": "" },
      "pages": {
        "version": 1,
        "order": [page_id.clone()],
        "items": {
          (page_id.clone()): {
            "id": page_id.clone(),
            "kind": "document",
            "title": "文書",
            "createdAt": "2026-10-17T00:00:00.000Z"
          }
        }
      }
    }))
    .unwrap(),
  )
  .unwrap();
  fs::write(&page, body).unwrap();
  (project_id, page_id, page)
}

#[test]
fn root_change_during_token_await_rejects_before_send() {
  tauri::async_runtime::block_on(async {
    let app = temp_dir("root-token-fence-app");
    let root_a = temp_dir("root-token-fence-a");
    let root_b = temp_dir("root-token-fence-b");
    let inner = Arc::new(CloudInner::new(
      None,
      &app,
      None,
      "prod",
      NihoEnvironment::Production,
      device(),
    ));
    inner.open_root(&root_a);
    let context = inner.context().unwrap();
    let fence = ContextFence {
      inner: Arc::downgrade(&inner),
      generation: context.generation,
      binding: context.binding.clone(),
    };
    let sent = Arc::new(AtomicU64::new(0));
    let request_sent = sent.clone();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let request = tauri::async_runtime::spawn(async move {
      fence.ensure_current()?;
      let _ = started_tx.send(());
      // token await の故障注入。この間に同じ account/session の Root だけを変える。
      let _ = release_rx.await;
      fence.ensure_current()?;
      request_sent.fetch_add(1, Ordering::SeqCst);
      Ok::<(), VaultError>(())
    });
    started_rx.await.unwrap();
    inner.open_root(&root_b);
    let _ = release_tx.send(());
    assert!(matches!(request.await.unwrap(), Err(VaultError::AuthRequired)));
    assert_eq!(sent.load(Ordering::SeqCst), 0, "旧 Root の request は send しない");
    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root_a);
    let _ = fs::remove_dir_all(root_b);
  });
}

#[test]
fn checking_a_missing_root_binding_does_not_register_it_again() {
  tauri::async_runtime::block_on(async {
    let app = temp_dir("missing-root-binding-app");
    let root = temp_dir("missing-root-binding-root");
    let inner = Arc::new(CloudInner::new(
      None,
      &app,
      None,
      "prod",
      NihoEnvironment::Production,
      device(),
    ));
    inner.open_root(&root);
    let context = inner.context().unwrap();
    let fence = ContextFence {
      inner: Arc::downgrade(&inner),
      generation: context.generation,
      binding: context.binding.clone(),
    };
    let registry = app.join("vault/roots.json");
    fs::remove_file(&registry).unwrap();
    assert!(fence.ensure_current().is_err());
    assert!(!inner.context_is_current(&context));
    assert!(!registry.exists(), "照合で所有者不明の保存先を作り直さない");
    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root);
  });
}

#[test]
fn opened_document_capture_rejects_stale_and_old_context_saves_without_touching_the_new_root() {
  tauri::async_runtime::block_on(async {
    let app = temp_dir("opened-document-app");
    let root_a = temp_dir("opened-document-root-a");
    let root_b = temp_dir("opened-document-root-b");
    let (project_id, page_id, page_a) = write_test_document(&root_a, "Root A snapshot");
    let (_, _, page_b) = write_test_document(&root_b, "Root B current");
    let inner = Arc::new(CloudInner::new(
      None,
      &app,
      None,
      "prod",
      NihoEnvironment::Production,
      device(),
    ));
    inner.open_root(&root_a);

    let opened = capture_document(
      inner.clone(),
      OpenedDocumentKind::Page {
        project_id: Some(project_id.clone()),
        page_id: page_id.clone(),
      },
    )
    .await
    .unwrap();
    assert_eq!(opened.markdown, "Root A snapshot");
    assert!(inner
      .protection
      .is_protected(&project_id, &format!("pages/{page_id}.md")));

    fs::write(&page_a, "intervening native save").unwrap();
    let stale = save_captured_document(inner.clone(), opened.handle.clone(), "stale editor".into())
      .await
      .unwrap_err();
    assert_eq!(stale.code, "store_stale_document");
    assert_eq!(fs::read_to_string(&page_a).unwrap(), "intervening native save");
    lock(&inner.opened_documents).remove(&opened.handle);

    let current = capture_document(
      inner.clone(),
      OpenedDocumentKind::Page {
        project_id: Some(project_id.clone()),
        page_id: page_id.clone(),
      },
    )
    .await
    .unwrap();
    assert_eq!(current.markdown, "intervening native save");
    assert!(
      save_captured_document(inner.clone(), current.handle.clone(), "current generation".into())
        .await
        .unwrap()
        .is_some()
    );
    assert_eq!(fs::read_to_string(&page_a).unwrap(), "current generation");

    // 同じ永続 RootBinding の session/engine refresh では、dirty editor の local capture を失効させない。
    let before_refresh = current.context_generation;
    inner.open_root(&root_a);
    assert_ne!(inner.context().unwrap().generation, before_refresh);
    assert!(
      save_captured_document(inner.clone(), current.handle.clone(), "saved after refresh".into())
        .await
        .unwrap()
        .is_some()
    );
    assert_eq!(fs::read_to_string(&page_a).unwrap(), "saved after refresh");
    assert!(inner
      .protection
      .is_protected(&project_id, &format!("pages/{page_id}.md")));

    // 別 RootBinding の install は旧 handle と protection を捨てる。遅延 save は Root B の同じ id へ流れない。
    let delayed = capture_document(
      inner.clone(),
      OpenedDocumentKind::Page {
        project_id: Some(project_id.clone()),
        page_id: page_id.clone(),
      },
    )
    .await
    .unwrap();
    assert_eq!(delayed.scope_id, current.scope_id);
    inner.open_root(&root_b);
    let changed = save_captured_document(inner.clone(), delayed.handle, "old Root A draft".into())
      .await
      .unwrap_err();
    assert_eq!(changed.code, "store_context_changed");
    assert_eq!(fs::read_to_string(&page_b).unwrap(), "Root B current");
    assert!(inner.protection.paths(&project_id).is_empty());
    let opened_b = capture_document(
      inner.clone(),
      OpenedDocumentKind::Page {
        project_id: Some(project_id.clone()),
        page_id: page_id.clone(),
      },
    )
    .await
    .unwrap();
    assert_ne!(opened_b.scope_id, current.scope_id);
    lock(&inner.opened_documents).remove(&opened_b.handle);

    // UI が scope A の draft を保持していれば、A に戻った後の新しい capture でだけ回復できる。
    inner.open_root(&root_a);
    let reopened = capture_document(
      inner.clone(),
      OpenedDocumentKind::Page {
        project_id: Some(project_id.clone()),
        page_id: page_id.clone(),
      },
    )
    .await
    .unwrap();
    save_captured_document(inner.clone(), reopened.handle, "old Root A draft".into())
      .await
      .unwrap();
    assert_eq!(fs::read_to_string(page_a).unwrap(), "old Root A draft");
    assert_eq!(fs::read_to_string(&page_b).unwrap(), "Root B current");

    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root_a);
    let _ = fs::remove_dir_all(root_b);
  });
}

#[test]
fn captured_operation_survives_a_context_refresh_and_blocks_root_commit_until_drop() {
  tauri::async_runtime::block_on(async {
    let app = temp_dir("captured-operation-app");
    let root_a = temp_dir("captured-operation-root-a");
    let root_b = temp_dir("captured-operation-root-b");
    let (project_id, page_id, page) = write_test_document(&root_a, "before");
    let inner = Arc::new(CloudInner::new(
      None,
      &app,
      None,
      "prod",
      NihoEnvironment::Production,
      device(),
    ));
    inner.open_root(&root_a);
    let cloud = Cloud { inner: inner.clone() };
    let operation = cloud.capture_operation().await.unwrap();
    let persisted = AtomicBool::new(false);
    let error = cloud
      .commit_root_change(&root_b, || {
        persisted.store(true, Ordering::SeqCst);
        Ok(())
      })
      .await
      .unwrap_err();
    assert_eq!(error.code, "store_busy");
    assert!(!persisted.load(Ordering::SeqCst));
    assert_eq!(inner.context().unwrap().root, root_a.canonicalize().unwrap());
    // 保存先は NIHO クラウドだけ（#18728）なので、付け替えは「このアカウントで使う」（rebind）で確かめる
    assert_eq!(
      inner.set_provider(ProviderKind::Niho, true).await.unwrap_err().code,
      "store_busy"
    );

    // account/session による Context refresh 後も、長い処理は開始時の Store と namespace へ書ける。
    inner.open_root(&root_a);
    let generation = operation
      .run(|store| store.write_page(&project_id, &page_id, "captured namespace"))
      .unwrap();
    assert!(generation.is_some());
    assert_eq!(fs::read_to_string(page).unwrap(), "captured namespace");
    drop(operation);
    assert!(cloud.check_root_change().is_ok());

    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root_a);
    let _ = fs::remove_dir_all(root_b);
  });
}

/// 本物の AccountService を、保存済みの接続から「ログイン済み」に戻せる状態にする（通信は全部失敗させ、外へ出さない）。
fn offline_account(app: &Path) -> (Arc<AccountService>, impl Fn(&str)) {
  use niho_desktop_account::store::{AccountStore, StoredAccount};
  use niho_desktop_account::test_support::{network_error, FakeHttp, MemorySecretStore};
  use niho_desktop_account::{ClientId, EnvKind, Environment, Secret, SecretKind, ServiceConfig};
  let secrets = Arc::new(MemorySecretStore::new());
  let http = Arc::new(FakeHttp::new());
  http.respond(|_| Err(network_error()));
  let data_dir = app.join("account");
  let account = Arc::new(AccountService::new(ServiceConfig::new(
    Environment::new(ClientId::Docs, EnvKind::Prod, "test-api-key"),
    secrets.clone(),
    http,
    data_dir.clone(),
    "テストの Mac",
  )));
  let login = {
    let account = account.clone();
    move |user_id: &str| {
      AccountStore::new(data_dir.clone())
        .save(&StoredAccount {
          version: 1,
          user_id: user_id.to_string(),
          display_name: "テスト".into(),
          handle: None,
          connection_id: "connection-1".into(),
          avatar_file: None,
          expired: None,
        })
        .unwrap();
      secrets.put(SecretKind::RefreshToken, Secret::new("refresh-token"));
      account.restore();
    }
  };
  (account, login)
}

/// 移行・同期の task を止める（テストの後に temp を消すため）。
fn stop_engine(inner: &Arc<CloudInner>) {
  lock(&inner.migration).cancel.store(true, Ordering::SeqCst);
  if let Some(context) = inner.context() {
    context.engine.shutdown();
  }
}

#[test]
fn first_login_binds_the_existing_local_root_before_a_document_capture_takes_its_lease() {
  tauri::async_runtime::block_on(async {
    let app = temp_dir("first-login-capture-app");
    let root = temp_dir("first-login-capture-root");
    let (project_id, page_id, page) = write_test_document(&root, "手元の文書");
    let (account, login) = offline_account(&app);
    let inner = Arc::new(CloudInner::new(
      None,
      &app,
      Some(account.clone()),
      "prod",
      NihoEnvironment::Production,
      device(),
    ));
    inner.open_root(&root);
    inner.reconcile().await;
    let open = |inner: Arc<CloudInner>| {
      capture_document(
        inner,
        OpenedDocumentKind::Page {
          project_id: Some(project_id.clone()),
          page_id: page_id.clone(),
        },
      )
    };

    // ログイン前（サーバーが受付を閉じている間）は、結び付いていない手元の Root のまま開ける。
    let local = open(inner.clone()).await.unwrap();
    assert_eq!(local.markdown, "手元の文書");
    assert!(root_binding(&app, &root).unwrap().account_key.is_none());
    lock(&inner.opened_documents).remove(&local.handle);

    // 初回ログイン: account の通知による reconcile より先に、文書の capture が lock を取る。
    login("u1");
    assert_eq!(account.state().kind(), "signedIn");
    let key = account_key("prod", "u1");
    let opened = open(inner.clone()).await.unwrap();

    // lease を取る前に今の本人へ結び付き、owner の namespace で capture している。
    let binding = root_binding(&app, &root).unwrap();
    assert_eq!(binding.account_key.as_deref(), Some(key.as_str()));
    let context = inner.context().unwrap();
    assert!(context.active);
    assert_eq!(context.binding, binding);
    assert_eq!(opened.scope_id, document_scope_id(&binding));
    assert_ne!(opened.scope_id, local.scope_id);
    assert!(
      !lock(&inner.operations).reconcile_pending,
      "開いている文書が自動移行を保留させない"
    );
    // 移行が始まっている（走っている間は running、終われば進みのファイルが残る）。
    assert!(lock(&inner.migration).running || read_migration(&app, &key).is_some());
    assert!(
      save_captured_document(inner.clone(), opened.handle.clone(), "ログイン後の編集".into())
        .await
        .unwrap()
        .is_some()
    );
    assert_eq!(fs::read_to_string(&page).unwrap(), "ログイン後の編集");
    assert!(namespace_has_pending(
      &app,
      &Namespace::Account {
        account_key: key.clone()
      },
      &binding.root_id
    )
    .unwrap());
    stop_engine(&inner);

    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root);
  });
}

#[test]
fn a_capture_waits_briefly_for_earlier_captures_before_first_login_binding_and_then_refuses() {
  tauri::async_runtime::block_on(async {
    let app = temp_dir("first-login-deferred-app");
    let root = temp_dir("first-login-deferred-root");
    let (project_id, page_id, _) = write_test_document(&root, "手元の文書");
    let (account, login) = offline_account(&app);
    let inner = Arc::new(CloudInner::new(
      None,
      &app,
      Some(account),
      "prod",
      NihoEnvironment::Production,
      device(),
    ));
    inner.open_root(&root);
    inner.reconcile().await;
    let cloud = Cloud { inner: inner.clone() };
    // ログイン前に始めた長い処理は、開始時の Store のまま続ける（その間は結び付けない）。
    let running = cloud.capture_operation().await.unwrap();
    login("u1");
    let key = account_key("prod", "u1");
    let open = || {
      capture_document(
        inner.clone(),
        OpenedDocumentKind::Page {
          project_id: Some(project_id.clone()),
          page_id: page_id.clone(),
        },
      )
    };

    // 待っても前の捕捉が残るなら、開くと保留を延ばすので、開かずに断る（lease も protection も残さない）。
    let refused = open().await.err().unwrap();
    assert_eq!(refused.code, "store_binding_pending");
    assert_eq!(
      cloud.capture_operation().await.err().unwrap().code,
      "store_binding_pending"
    );
    assert_eq!(lock(&inner.operations).active, 1);
    assert!(lock(&inner.operations).reconcile_pending);
    assert!(inner.protection.paths(&project_id).is_empty());
    assert!(root_binding(&app, &root).unwrap().account_key.is_none());

    // 前の捕捉（前に開いていた文書を保存して閉じる・処理が終わる）が待つ間に外れれば、結び付けてから owner の
    // namespace で開く（画面の移動で、閉じるより先に次の文書を開いても失敗にしない）。
    tauri::async_runtime::spawn(async move {
      tokio::time::sleep(Duration::from_millis(100)).await;
      drop(running);
    });
    let opened = open().await.unwrap();
    let binding = root_binding(&app, &root).unwrap();
    assert_eq!(binding.account_key.as_deref(), Some(key.as_str()));
    assert_eq!(opened.scope_id, document_scope_id(&binding));
    assert!(inner.context().unwrap().active);
    stop_engine(&inner);

    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root);
  });
}

/// 口を store に入れている間（落ちても外す。ほかの口のテストと重ならないよう 1 つずつ）。
struct Installed {
  _lock: std::sync::MutexGuard<'static, ()>,
}

impl Drop for Installed {
  fn drop(&mut self) {
    store::set_save_sink(None);
    store::set_device_id(None);
  }
}

fn install(context: &Arc<Context>) -> Installed {
  let lock = store::sink_test_lock();
  store::set_save_sink(Some(context.clone()));
  store::set_device_id(Some(context.device.device_id.clone()));
  Installed { _lock: lock }
}

fn install_cloud_sink(inner: &Arc<CloudInner>) -> Installed {
  let lock = store::sink_test_lock();
  store::set_save_sink(Some(Arc::new(CloudSink {
    inner: Arc::downgrade(inner),
    managed_roots: inner.managed_roots.clone(),
  })));
  Installed { _lock: lock }
}

/// 途中で終わった保存（prepared の journal と snapshot）を、crate の形のまま app data に置く。
fn crashed_save(app: &Path, context: &Context, project_id: &str, path: &str, previous: Option<&[u8]>, next: &[u8]) {
  let dir = context.binding.namespace().dir(app).join(project_id);
  fs::create_dir_all(dir.join("journal")).unwrap();
  fs::create_dir_all(dir.join("snapshots")).unwrap();
  fs::write(dir.join("snapshots").join(sha(next)), next).unwrap();
  let journal = json!({
    "localSaveId": "s_crashed",
    "generation": 1,
    "kind": { "type": "edit" },
    "status": "prepared",
    "createdAt": "2026-10-17T00:00:00.000Z",
    "paths": [{
      "path": path,
      "previousSha256": previous.map(sha),
      "nextSha256": sha(next),
      "snapshotRef": sha(next),
    }],
  });
  fs::write(
    dir.join("journal/s_crashed.json"),
    serde_json::to_vec(&journal).unwrap(),
  )
  .unwrap();
}

#[test]
fn remote_list_carries_docs_root_for_its_lease_but_not_flows_or_profile() {
  // フォルダ外のページの実行の lease を別の Mac が持つかを知るため、docs-root だけは一覧に載せる
  assert!(listed_in_remote("docs-root"));
  assert!(listed_in_remote("abcdefgh23"));
  assert!(!listed_in_remote("flows"));
  assert!(!listed_in_remote("profile"));
}

#[test]
fn store_paths_map_to_their_sync_targets() {
  let root = Path::new("/docs");
  let located = |path: &str| locate(root, &root.join(path)).map(|(target, inner)| (target.project_id, inner));
  assert_eq!(located("about.json"), Some(("profile".into(), "about.json".into())));
  assert_eq!(
    located("execution.json"),
    Some(("profile".into(), "execution.json".into()))
  );
  assert_eq!(located("pages.json"), Some(("docs-root".into(), "pages.json".into())));
  assert_eq!(located("pages/p1.md"), Some(("docs-root".into(), "pages/p1.md".into())));
  assert_eq!(
    located("recordings/r1/runs.jsonl"),
    Some(("docs-root".into(), "recordings/r1/runs.jsonl".into()))
  );
  assert_eq!(located("flows/f1.json"), Some(("flows".into(), "f1.json".into())));
  assert_eq!(
    located("flows/samples/f1/s1.txt"),
    Some(("flows".into(), "samples/f1/s1.txt".into()))
  );
  assert_eq!(
    located("projects/abcdefgh23/pages/p1.md"),
    Some(("abcdefgh23".into(), "pages/p1.md".into()))
  );
  assert_eq!(
    located("projects/abcdefgh23/recordings/r1/runs.jsonl"),
    Some(("abcdefgh23".into(), "recordings/r1/runs.jsonl".into()))
  );
  // フォルダ外のページ（保存先直下。予約の docs-root・#18721）
  for (path, inner) in [
    ("pages.json", "pages.json"),
    ("pages/p1.md", "pages/p1.md"),
    ("recordings/r1/artifacts/s1.md", "recordings/r1/artifacts/s1.md"),
    ("recordings/r1/inputs/a1.m4a", "recordings/r1/inputs/a1.m4a"),
    (
      "page-chats/p1/conversations/c1.json",
      "page-chats/p1/conversations/c1.json",
    ),
    ("page-chats/p1/runs.jsonl", "page-chats/p1/runs.jsonl"),
    ("assets/img1.jpeg", "assets/img1.jpeg"),
    (
      "versions/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/v_1234567890123456789012.jpeg",
      "versions/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/v_1234567890123456789012.jpeg",
    ),
  ] {
    assert_eq!(located(path), Some(("docs-root".into(), inner.into())), "{path}");
  }
  // 対象の外・同期しない path・予約の id・保管庫で使えない id
  for outside in [
    "settings.json",
    "pages.json.bak",
    "recent.json",
    "pages",
    "pagesx/p1.md",
    "versions/source/1.md",
    "pages/.p1.md.tmp-1-abc",
    "projects/docs-root/project.json",
    "projects/abcdefgh23",
    "projects/abcdefgh23/.run.lock",
    "projects/abcdefgh23/pages/.p1.md.tmp-1-abc",
    "projects/abcdefgh23/vault/x.json",
    "projects/flows/project.json",
    "projects/profile/project.json",
    "projects/docs-root/project.json",
    "projects/abc/project.json",
    "projects/ABCDEFGH23/project.json",
    "flows",
  ] {
    assert_eq!(located(outside), None, "{outside}");
  }
  assert_eq!(
    locate(root, Path::new("/elsewhere/projects/abcdefgh23/project.json")),
    None
  );
  let profile = target_for(root, "profile").unwrap();
  assert_eq!((profile.working_copy.as_path(), profile.scope.is_all()), (root, false));
  let docs_root = target_for(root, "docs-root").unwrap();
  assert_eq!(
    (
      docs_root.working_copy.as_path(),
      docs_root.scope.is_all(),
      docs_root.scope.allows_version_of("assets/img1.jpeg")
    ),
    (root, false, true)
  );
  assert!(is_reserved_project("docs-root"));
  assert_eq!(target_for(root, "flows").unwrap().working_copy, root.join("flows"));
  assert_eq!(target_for(root, "docs-root").unwrap().working_copy, root);
  assert_eq!(
    target_for(root, "abcdefgh23").unwrap().working_copy,
    root.join("projects/abcdefgh23")
  );
  assert!(target_for(root, "../x").is_none());
}

#[test]
fn saves_go_through_the_journal_of_the_roots_namespace() {
  let (app, root, context) = reader("journal");
  let installed = install(&context);
  let store = Store::new(root.clone());
  let created = store
    .create_project_named(
      &json!({ "version": 1, "id": "", "name": "保管庫", "createdAt": "2026-10-17T00:00:00.000Z", "pages": [] }),
      None,
      None,
      &[],
      &[],
    )
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let page = store
    .create_page(&id, "doc", "メモ", "2026-10-17T00:00:00.000Z", None)
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let generation = store.write_page(&id, &page, "# 本文").unwrap().expect("journal の世代");
  let path = format!("pages/{page}.md");
  let namespace = context.binding.namespace();
  assert_eq!(
    namespace,
    Namespace::Local {
      root_id: context.binding.root_id.clone()
    }
  );
  let state = load_or_default_state(&app, &namespace, &context.binding.root_id, &id).unwrap();
  assert_eq!(state.dirty.get(&path), Some(&generation));
  assert_eq!(
    fs::read_to_string(root.join(format!("projects/{id}/{path}"))).unwrap(),
    "# 本文"
  );
  // 通信しない口でも案件の状態を読める
  let target = context.target(&id).unwrap();
  let snapshot = context.engine.project_snapshot(&target).unwrap();
  assert_eq!(snapshot.local_generation, generation);
  assert!(snapshot.dirty.contains_key(&path));
  // 「あなたについて」は profile、工程は flows の対象
  store
    .save_about(&json!({ "version": 1, "name": "高浜", "text": "編集者" }))
    .unwrap();
  store
    .save_execution(&json!({ "version": 1, "route": "own_mac", "preferredMacRunnerId": "runner_mac_1" }))
    .unwrap();
  let profile = load_or_default_state(&app, &namespace, &context.binding.root_id, "profile").unwrap();
  assert!(profile.dirty.contains_key("about.json") && profile.dirty.contains_key("execution.json"));
  let flow = json!({ "version": 1, "id": "flow1", "name": "工程", "revision": 1, "guide": "", "terms": [], "samples": [], "steps": [] });
  store.save_flow(&flow).unwrap();
  let flows = load_or_default_state(&app, &namespace, &context.binding.root_id, "flows").unwrap();
  assert!(flows.dirty.contains_key("flow1.json") && flows.dirty.contains_key("index.json"));
  // 版は 1 つの保存単位（依存 group）
  let version = store
    .create_page(
      &id,
      "rec",
      "",
      "2026-10-17T00:00:00.000Z",
      Some(&json!({ "version": 1, "id": "", "flowSnapshot": { "steps": [] }, "source": { "kind": "text" } })),
    )
    .unwrap();
  let rec = version["id"].as_str().unwrap().to_string();
  // 録音のフォルダは録音 id（P6 でページ id と分かれた）
  let rec_dir = version["recordingId"].as_str().unwrap_or(&rec).to_string();
  store
    .save_artifact(&id, &rec, "k7m2q9xa", false, "# 方針", &json!({ "id": "r1", "kind": "run", "at": "2026-10-17T01:00:00.000Z", "stepId": "k7m2q9xa", "stepName": "方針", "result": "saved" }))
    .unwrap();
  let state = load_or_default_state(&app, &namespace, &context.binding.root_id, &id).unwrap();
  let group = state.groups.values().last().unwrap();
  assert_eq!(group.len(), 3, "{group:?}");
  assert!(group.contains(&format!("recordings/{rec_dir}/runs.jsonl")));
  assert!(group.contains(&format!("recordings/{rec_dir}/artifacts/k7m2q9xa.md")));
  // 保存の口を通さない変更（画像）は note_changed で dirty になる
  let image = temp_dir("journal-image").join("photo.png");
  fs::write(&image, b"\x89PNG\r\n\x1a\nimage").unwrap();
  let name = store.import_image_asset(&id, &image).unwrap();
  let state = load_or_default_state(&app, &namespace, &context.binding.root_id, &id).unwrap();
  assert!(state.dirty.contains_key(&format!("assets/{name}")));
  drop(installed);
  let _ = fs::remove_dir_all(app);
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(image.parent().unwrap());
}

#[test]
fn actual_cloud_sink_fails_closed_for_managed_groups_but_keeps_private_settings_unmanaged() {
  let app = temp_dir("managed-sink-app");
  let root = temp_dir("managed-sink-root");
  let next_root = temp_dir("managed-sink-next-root");
  let inner = Arc::new(CloudInner::new(
    None,
    &app,
    None,
    "prod",
    NihoEnvironment::Production,
    device(),
  ));
  inner.open_root(&root);
  let context = inner.context().unwrap();
  let installed = install_cloud_sink(&inner);
  let project = root.join("projects/abcdefgh23");
  fs::create_dir_all(&project).unwrap();

  // managed と private/unmanaged を 1 group に混ぜたら、どちらも plain write しない。
  let managed = project.join("page.md");
  let private = root.join("settings.json");
  assert!(store::save_writes(
    vec![
      SinkWrite::Put(managed.clone(), b"managed".to_vec()),
      SinkWrite::Put(private.clone(), b"private".to_vec()),
    ],
    SinkKind::Edit,
  )
  .is_err());
  assert!(!managed.exists() && !private.exists());

  // settings が Root B を返し始めても Context がまだ Root A の transition 中は、既知の B を plain write しない。
  inner.remember_managed_root(&next_root);
  let next_managed = next_root.join("projects/abcdefgh23/pages/docpage23.md");
  fs::create_dir_all(next_managed.parent().unwrap()).unwrap();
  assert!(store::save_writes(
    vec![SinkWrite::Put(next_managed.clone(), b"must not fall through".to_vec())],
    SinkKind::Edit,
  )
  .is_err());
  assert!(!next_managed.exists());

  // journal が壊れていても managed 本文だけを成功扱いにしない。
  let state_dir = context.binding.namespace().dir(&app).join("abcdefgh23");
  fs::create_dir_all(state_dir.join("journal")).unwrap();
  fs::write(state_dir.join("journal/s_broken.json"), b"{").unwrap();
  assert!(store::save_writes(vec![SinkWrite::Put(managed.clone(), b"body".to_vec())], SinkKind::Edit,).is_err());
  assert!(!managed.exists());
  assert!(state_dir.join("journal/s_broken.json").exists());
  assert!(state_dir.join("journal/s_broken.json.corrupt").exists());

  // namespace が違う state も plain write に落とさず、dirty/ack を進めない。
  fs::remove_file(state_dir.join("journal/s_broken.json")).unwrap();
  fs::remove_file(state_dir.join("journal/s_broken.json.corrupt")).unwrap();
  let wrong = VaultState::new(
    "abcdefgh23",
    context.binding.root_id.clone(),
    Some("a_wrong-account".into()),
  );
  fs::write(state_dir.join("state.json"), serde_json::to_vec(&wrong).unwrap()).unwrap();
  assert!(store::save_writes(vec![SinkWrite::Put(managed.clone(), b"body".to_vec())], SinkKind::Edit,).is_err());
  assert!(!managed.exists());
  let unchanged: VaultState = serde_json::from_slice(&fs::read(state_dir.join("state.json")).unwrap()).unwrap();
  assert_eq!(unchanged.local_generation, 0);

  // Context/CloudInner が無い window でも既知の managed root は fail closed。
  inner
    .context
    .write()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .take();
  drop(context);
  drop(inner);
  assert!(store::save_writes(vec![SinkWrite::Put(managed.clone(), b"lost".to_vec())], SinkKind::Edit,).is_err());
  assert!(!managed.exists());

  // root 内でも明示的な private 設定は従来どおり local plain save できる。
  assert_eq!(
    store::save_writes(
      vec![SinkWrite::Put(private.clone(), b"settings".to_vec())],
      SinkKind::System,
    )
    .unwrap(),
    None
  );
  assert_eq!(fs::read(&private).unwrap(), b"settings");
  drop(installed);
  let _ = fs::remove_dir_all(app);
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(next_root);
}

#[test]
fn fetched_stream_file_is_removed_on_drop() {
  let dir = temp_dir("fetched-stream-drop");
  let path = dir.join("remote.tmp");
  let mut file = fs::OpenOptions::new()
    .create_new(true)
    .read(true)
    .write(true)
    .open(&path)
    .unwrap();
  file.write_all(b"remote").unwrap();
  let source = OpenedFileSource::from_opened(file, path.clone(), &sha(b"remote"), 6).unwrap();
  drop(FetchedRemote::streamed(source, path.clone()));
  assert!(!path.exists());
  let _ = fs::remove_dir_all(dir);
}

#[test]
fn journals_are_recovered_before_the_project_list_is_read() {
  let app = temp_dir("recover-app");
  let root = temp_dir("recover-root");
  let project = root.join("projects/abcdefgh23");
  fs::create_dir_all(&project).unwrap();
  let before = br#"{"version":1,"id":"abcdefgh23","name":"before"}"#;
  let after = br#"{"version":1,"id":"abcdefgh23","name":"after"}"#;
  fs::write(project.join("project.json"), before).unwrap();
  let inner = Arc::new(CloudInner::new(
    None,
    &app,
    None,
    "prod",
    NihoEnvironment::Production,
    device(),
  ));
  inner.open_root(&root);
  let context = inner.context().unwrap();
  // project.json の保存の途中（journal は prepared、写しはまだ前の内容）で落ちた
  crashed_save(&app, &context, "abcdefgh23", "project.json", Some(before), after);
  assert!(!*inner.recovered.borrow());
  let cloud = Cloud { inner: inner.clone() };
  tauri::async_runtime::block_on(async {
    inner.recover_all().await;
    cloud.wait_recovered().await;
  });
  assert!(*inner.recovered.borrow());
  let listed = Store::new(root.clone()).list_projects().unwrap();
  assert_eq!(listed[0].project["name"], "after");
  assert!(!context
    .binding
    .namespace()
    .dir(&app)
    .join("abcdefgh23/journal/s_crashed.json")
    .exists());
  // 対象は docs-root・案件・flows（あれば）・profile
  fs::create_dir_all(root.join("flows")).unwrap();
  let ids: Vec<String> = targets_of_root(&root)
    .into_iter()
    .map(|target| target.project_id)
    .collect();
  assert_eq!(ids, vec!["docs-root", "abcdefgh23", "flows", "profile"]);
  assert_eq!(recover_root(&context.saver, &root), 4);
  fs::write(root.join("pages.json"), br#"{"version":1,"order":[],"items":{}}"#).unwrap();
  let ids: Vec<String> = targets_of_root(&root)
    .into_iter()
    .map(|target| target.project_id)
    .collect();
  assert_eq!(ids, vec!["docs-root", "abcdefgh23", "flows", "profile"]);
  // 移行（この Mac → NIHO クラウド）も docs-root を重複せず運ぶ
  let migrating: Vec<(String, String)> = migration_targets(&root)
    .into_iter()
    .map(|(target, name, _)| (target.project_id, name))
    .collect();
  assert_eq!(migrating.iter().filter(|(id, _)| id == "docs-root").count(), 1);
  let _ = fs::remove_dir_all(app);
  let _ = fs::remove_dir_all(root);
}

#[test]
fn the_engine_runs_only_for_niho_signed_in_and_the_same_account() {
  let key = account_key("prod", "u1");
  let signed_in = AccountState::SignedIn { profile: profile("u1") };
  let offline = AccountState::Offline { profile: profile("u1") };
  let expired = AccountState::Expired {
    profile: profile("u1"),
    reason: ExpiredReason::ConnectionRevoked,
  };
  let bound = binding(Some(key.clone()));
  let niho = ProviderKind::Niho;
  assert_eq!(
    decide_mode(ProviderKind::Local, &signed_in, &bound, "prod"),
    Mode::Local
  );
  assert_eq!(
    decide_mode(niho, &AccountState::SignedOut, &bound, "prod"),
    Mode::SignedOut
  );
  assert_eq!(
    decide_mode(niho, &AccountState::SigningIn { since_ms: 1 }, &bound, "prod"),
    Mode::SignedOut
  );
  assert_eq!(decide_mode(niho, &expired, &bound, "prod"), Mode::Expired);
  assert_eq!(
    decide_mode(niho, &signed_in, &bound, "prod"),
    Mode::Active {
      account_key: key.clone()
    }
  );
  assert_eq!(
    decide_mode(niho, &offline, &bound, "prod"),
    Mode::Active {
      account_key: key.clone()
    }
  );
  // 別の本人・別の環境（stg）に結び付いた保存先
  let other = account_key("prod", "u2");
  assert_eq!(
    decide_mode(niho, &signed_in, &binding(Some(other.clone())), "prod"),
    Mode::OtherAccount { bound: other }
  );
  assert_eq!(
    decide_mode(niho, &signed_in, &bound, "stg"),
    Mode::OtherAccount { bound: key.clone() }
  );
  assert_eq!(
    decide_mode(niho, &signed_in, &binding(None), "prod"),
    Mode::Unbound { account_key: key }
  );
}

#[test]
fn id_token_failures_become_login_required_or_offline() {
  assert!(matches!(
    token_error(&AccountError::signed_out()),
    VaultError::AuthRequired
  ));
  assert!(matches!(
    token_error(&AccountError::expired()),
    VaultError::AuthRequired
  ));
  for error in [
    AccountError::offline(),
    AccountError::network(),
    AccountError::connect_disabled(),
    AccountError::account_unavailable(),
  ] {
    let mapped = token_error(&error);
    assert!(mapped.is_offline(), "{error:?} → {mapped:?}");
  }
}

#[test]
fn a_lease_held_elsewhere_names_the_other_mac() {
  let held = LeaseHeldBy {
    device_name: "Studio".into(),
    since: "2026-10-17T00:00:00.000Z".into(),
    expires_at: "2026-10-17T00:01:30.000Z".into(),
  };
  let error = lease_held_error(Some(&held));
  assert_eq!(error.code, "lease_held");
  assert_eq!(
    error.message,
    "別の Mac（Studio）で実行中です。終わってから実行してください。"
  );
  let blank = LeaseHeldBy {
    device_name: "  ".into(),
    ..held
  };
  for unknown in [None, Some(&blank)] {
    assert_eq!(
      lease_held_error(unknown).message,
      "別の Mac で実行中です。終わってから実行してください。"
    );
  }
}

#[test]
fn migration_failures_have_japanese_reasons() {
  let quota = SyncStatus::Partial {
    revision: 1,
    quota_paths: vec!["inputs/a.m4a".into()],
    blocked_paths: vec![],
  };
  let blocked_only = SyncStatus::Partial {
    revision: 1,
    quota_paths: vec![],
    blocked_paths: vec!["big.bin".into()],
  };
  assert_eq!(migration_failure(&Ok(SyncStatus::Synced { revision: 2 })), None);
  assert_eq!(migration_failure(&Ok(blocked_only)), None);
  assert_eq!(migration_failure(&Ok(quota)), Some("クラウドの容量が足りません"));
  assert_eq!(
    migration_failure(&Ok(SyncStatus::Offline)),
    Some("NIHO に接続できません")
  );
  assert_eq!(
    migration_failure(&Ok(SyncStatus::AuthRequired)),
    Some("ログインが必要です")
  );
  assert_eq!(
    migration_failure(&Err(VaultError::Offline("x".into()))),
    Some("NIHO に接続できません")
  );
  assert_eq!(
    migration_failure(&Err(VaultError::QuotaExceeded { path: String::new() })),
    Some("クラウドの容量が足りません")
  );
  assert_eq!(
    migration_failure(&Err(VaultError::Forbidden)),
    Some("ログインが必要です")
  );
  assert_eq!(
    migration_failure(&Ok(SyncStatus::TombstoneChoiceRequired)),
    Some("同期できませんでした")
  );
}

#[test]
fn window_settings_keep_the_vault_object_owned_by_the_cloud_commands() {
  let app = temp_dir("settings");
  update_vault_settings(&app, |vault| {
    vault.insert("provider".into(), json!("niho"));
  })
  .unwrap();
  // 画面の保存は vault を変えない（無い・違う値を送っても）
  save_window_settings(
    &app,
    json!({ "version": 3, "docsRoot": "/x", "vault": { "provider": "local", "deviceName": "偽" } }),
  )
  .unwrap();
  let saved = read_settings(&app).unwrap();
  assert_eq!(saved["docsRoot"], "/x");
  assert_eq!(saved["vault"], json!({ "provider": "niho" }));
  assert_eq!(read_vault_settings(&app), (ProviderKind::Niho, None));
  update_vault_settings(&app, |vault| {
    vault.insert("deviceName".into(), json!(" 書斎の Mac \n"));
  })
  .unwrap();
  assert_eq!(read_settings(&app).unwrap()["docsRoot"], "/x");
  assert_eq!(
    read_vault_settings(&app),
    (ProviderKind::Niho, Some("書斎の Mac".to_string()))
  );
  // ディスクに vault が無ければ、画面から送られても書かない
  let fresh = temp_dir("settings-fresh");
  save_window_settings(&fresh, json!({ "version": 3, "vault": { "provider": "niho" } })).unwrap();
  assert!(read_settings(&fresh).unwrap().get("vault").is_none());
  assert_eq!(device_name_override("   "), None);
  assert_eq!(device_name_override(&"あ".repeat(100)).unwrap().chars().count(), 80);
  let _ = fs::remove_dir_all(app);
  let _ = fs::remove_dir_all(fresh);
}

#[test]
fn a_conflict_is_resolved_with_the_normal_path_a_new_version_and_a_run_row_in_one_group() {
  let (app, root, context) = reader("conflict");
  let installed = install(&context);
  let project = root.join("projects/abcdefgh23");
  fs::create_dir_all(project.join("artifacts")).unwrap();
  fs::write(
    project.join("project.json"),
    br#"{"version":1,"id":"abcdefgh23","name":"c"}"#,
  )
  .unwrap();
  let step = "artifacts/k7m2q9xa.md";
  // 保存の途中で落ち、その後に写しが別の内容に変わった（再起動の回復が双方を残して競合にする）
  fs::write(project.join(step), "この Mac").unwrap();
  crashed_save(
    &app,
    &context,
    "abcdefgh23",
    step,
    Some("前".as_bytes()),
    "保存しかけ".as_bytes(),
  );
  let target = context.target("abcdefgh23").unwrap();
  context.saver.recover(&target).unwrap();
  let conflicts = context.engine.list_conflicts(&target).unwrap();
  assert_eq!(conflicts.len(), 1);
  let entry = conflicts[0].clone();
  assert_eq!(entry.path, step);
  let copy = |side| {
    context
      .engine
      .read_conflict_copy(&target, &entry.conflict_id, side)
      .unwrap()
      .and_then(text_of)
  };
  assert_eq!(copy(ConflictSide::Local).as_deref(), Some("この Mac"));
  assert_eq!(copy(ConflictSide::Remote).as_deref(), Some("保存しかけ"));
  // 確かめた後でクラウド側が変わっていれば断る
  let stale = resolve_conflict(
    &context,
    &target,
    &entry.conflict_id,
    ResolveChoice::Local,
    None,
    Some("0000"),
    None,
  )
  .unwrap_err();
  assert_eq!(stale.code, "conflict_changed");
  // 「クラウドで削除」を見た（None）のにクラウド側に内容があれば断り、手元を消さない
  assert_eq!(
    resolve_conflict(
      &context,
      &target,
      &entry.conflict_id,
      ResolveChoice::Delete,
      None,
      None,
      None
    )
    .unwrap_err()
    .code,
    "conflict_changed"
  );
  assert!(project.join(step).is_file());
  // この Mac の側が読めない（ファイルでない）ときは、削除として扱わずに解決をやめる
  fs::remove_file(project.join(step)).unwrap();
  fs::create_dir(project.join(step)).unwrap();
  assert_eq!(
    resolve_conflict(
      &context,
      &target,
      &entry.conflict_id,
      ResolveChoice::Local,
      None,
      entry.remote_sha256.as_deref(),
      None,
    )
    .unwrap_err()
    .code,
    "cloud_conflict_failed"
  );
  assert!(project.join(step).is_dir());
  fs::remove_dir(project.join(step)).unwrap();
  fs::write(project.join(step), "この Mac").unwrap();
  assert_eq!(
    resolve_conflict(&context, &target, "c_missing", ResolveChoice::Local, None, None, None)
      .unwrap_err()
      .code,
    "conflict_changed"
  );
  // 写しの無い競合（音声・8 MiB 超）は先に取ったクラウド側の内容を使う。競合のクラウド側と違えば確かめ直す
  let remote_copy = project.join(entry.remote_copy.as_deref().unwrap());
  let saved_copy = fs::read(&remote_copy).unwrap();
  fs::remove_file(&remote_copy).unwrap();
  let remote_with = |fetched: Option<&[u8]>| {
    resolve_conflict(
      &context,
      &target,
      &entry.conflict_id,
      ResolveChoice::Remote,
      None,
      entry.remote_sha256.as_deref(),
      fetched.map(<[u8]>::to_vec),
    )
    .unwrap_err()
    .code
  };
  assert_eq!(remote_with(Some(b"other".as_slice())), "conflict_changed");
  assert_eq!(remote_with(None), "cloud_conflict_failed");
  assert_eq!(fs::read_to_string(project.join(step)).unwrap(), "この Mac");
  fs::write(&remote_copy, saved_copy).unwrap();
  // 両方を編集して保存: 通常の path・新しい版・runs の行（resolution）を 1 つの group で
  let generation = resolve_conflict(
    &context,
    &target,
    &entry.conflict_id,
    ResolveChoice::Merged,
    Some("両方を合わせた".into()),
    entry.remote_sha256.as_deref(),
    None,
  )
  .unwrap();
  assert_eq!(fs::read_to_string(project.join(step)).unwrap(), "両方を合わせた");
  let rows = fs::read_to_string(project.join("runs.jsonl")).unwrap();
  let row: Value = serde_json::from_str(rows.lines().last().unwrap()).unwrap();
  assert_eq!(
    (row["kind"].as_str(), row["resolution"].as_bool()),
    (Some("save"), Some(true))
  );
  assert_eq!(row["stepId"], "k7m2q9xa");
  assert_eq!(row["version"], 1);
  assert_eq!(row["originDeviceId"], "d_test");
  let version_path = row["versionPath"].as_str().unwrap();
  assert!(version_path.starts_with("versions/k7m2q9xa/v_"), "{version_path}");
  assert_eq!(
    fs::read_to_string(project.join(version_path)).unwrap(),
    "両方を合わせた"
  );
  let state = load_or_default_state(
    &app,
    &context.binding.namespace(),
    &context.binding.root_id,
    "abcdefgh23",
  )
  .unwrap();
  let group = state.groups.get(&generation).unwrap();
  assert!(group.contains(&step.to_string()) && group.contains(&"runs.jsonl".to_string()));
  assert!(group.contains(&version_path.to_string()));
  let resolving = context.engine.list_conflicts(&target).unwrap();
  assert_eq!(resolving[0].status, niho_desktop_vault::ConflictStatus::Resolving);
  drop(installed);
  let _ = fs::remove_dir_all(app);
  let _ = fs::remove_dir_all(root);
}

#[test]
fn explicit_local_and_keep_refresh_a_small_conflict_to_the_latest_current_candidate() {
  for (label, choice) in [
    ("small-fresh-local", ResolveChoice::Local),
    ("small-fresh-keep", ResolveChoice::Keep),
  ] {
    let (app, root, context) = reader(label);
    let project = root.join("projects/abcdefgh23");
    fs::create_dir_all(&project).unwrap();
    let path = "page.md";
    fs::write(project.join(path), b"at conflict detection").unwrap();
    let remote = ManifestFile {
      path: path.into(),
      sha256: sha(b"remote"),
      bytes: 6,
      kind: FileKind::Text,
      modified_at: "2026-10-17T00:00:00.000Z".into(),
      writer_device_id: "d_remote".into(),
      writer_device_kind: None,
      retained_until: None,
      available: true,
    };
    let remote_sha = remote.sha256.clone();
    let conflict_id = write_reference_conflict(
      &project,
      path,
      ConflictKind::Edit,
      Some(sha(b"at conflict detection")),
      remote,
    );
    add_local_conflict_copy(&project, &conflict_id, b"at conflict detection");
    fs::write(project.join(path), b"latest current edit").unwrap();
    let target = context.target("abcdefgh23").unwrap();

    resolve_conflict_guarded(
      &context,
      &target,
      &conflict_id,
      choice,
      None,
      Some(&remote_sha),
      None,
      &|| true,
    )
    .unwrap();
    assert_eq!(fs::read(project.join(path)).unwrap(), b"latest current edit", "{label}");
    assert_eq!(
      context.engine.list_conflicts(&target).unwrap()[0].status,
      ConflictStatus::Resolving,
      "{label}"
    );
    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root);
  }
}

#[test]
fn a_small_current_edit_between_read_and_publication_is_not_overwritten_or_acknowledged() {
  let (app, root, context) = reader("small-publication-cas");
  let project = root.join("projects/abcdefgh23");
  fs::create_dir_all(&project).unwrap();
  let path = "page.md";
  fs::write(project.join(path), b"reviewed current").unwrap();
  let remote = ManifestFile {
    path: path.into(),
    sha256: sha(b"remote"),
    bytes: 6,
    kind: FileKind::Text,
    modified_at: "2026-10-17T00:00:00.000Z".into(),
    writer_device_id: "d_remote".into(),
    writer_device_kind: None,
    retained_until: None,
    available: true,
  };
  let remote_sha = remote.sha256.clone();
  let conflict_id = write_reference_conflict(
    &project,
    path,
    ConflictKind::Edit,
    Some(sha(b"reviewed current")),
    remote,
  );
  add_local_conflict_copy(&project, &conflict_id, b"reviewed current");
  let target = context.target("abcdefgh23").unwrap();
  let injected = AtomicBool::new(false);
  let error = resolve_conflict_guarded(
    &context,
    &target,
    &conflict_id,
    ResolveChoice::Local,
    None,
    Some(&remote_sha),
    None,
    &|| {
      if !injected.swap(true, Ordering::SeqCst) {
        fs::write(project.join(path), b"native save after read").unwrap();
      }
      true
    },
  )
  .unwrap_err();
  assert_eq!(error.code, "conflict_changed");
  assert_eq!(fs::read(project.join(path)).unwrap(), b"native save after read");
  assert_eq!(
    context.engine.list_conflicts(&target).unwrap()[0].status,
    ConflictStatus::Open,
    "CAS failure must not acknowledge the resolution"
  );

  resolve_conflict_guarded(
    &context,
    &target,
    &conflict_id,
    ResolveChoice::Local,
    None,
    Some(&remote_sha),
    None,
    &|| true,
  )
  .unwrap();
  assert_eq!(fs::read(project.join(path)).unwrap(), b"native save after read");
  let _ = fs::remove_dir_all(app);
  let _ = fs::remove_dir_all(root);
}

#[test]
fn large_sparse_conflicts_use_streams_for_local_remote_and_keep_and_reject_changed_sources() {
  const BYTES: u64 = TEXT_MAX_BYTES + 1;
  for (label, choice, expected_marker) in [
    ("large-local", ResolveChoice::Local, 1_u8),
    ("large-remote", ResolveChoice::Remote, 2_u8),
    ("large-keep", ResolveChoice::Keep, 1_u8),
  ] {
    let (app, root, context) = reader(label);
    let project = root.join("projects/abcdefgh23");
    fs::create_dir_all(&project).unwrap();
    let path = "audio.m4a";
    let local_sha = sparse_file(&project.join(path), BYTES, 1);
    let remote_path = temp_dir(label).join("remote.m4a");
    let remote_sha = sparse_file(&remote_path, BYTES, 2);
    let remote = ManifestFile {
      path: path.into(),
      sha256: remote_sha.clone(),
      bytes: BYTES,
      kind: FileKind::Audio,
      modified_at: "2026-10-17T00:00:00.000Z".into(),
      writer_device_id: "d_remote".into(),
      writer_device_kind: None,
      retained_until: Some("2026-11-16T00:00:00.000Z".into()),
      available: true,
    };
    let conflict_id = write_reference_conflict(&project, path, ConflictKind::Edit, Some(local_sha), remote.clone());
    let fetched = if choice == ResolveChoice::Remote {
      let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&remote_path)
        .unwrap();
      let source = OpenedFileSource::from_opened(file, remote_path.clone(), &remote_sha, BYTES).unwrap();
      Some(FetchedRemote::streamed(source, remote_path.clone()))
    } else {
      None
    };
    let target = context.target("abcdefgh23").unwrap();
    resolve_conflict_guarded(
      &context,
      &target,
      &conflict_id,
      choice,
      None,
      Some(&remote_sha),
      fetched,
      &|| true,
    )
    .unwrap();
    let mut resolved = fs::File::open(project.join(path)).unwrap();
    resolved.seek(SeekFrom::Start(BYTES - 1)).unwrap();
    let mut marker = [0_u8; 1];
    resolved.read_exact(&mut marker).unwrap();
    assert_eq!(marker[0], expected_marker);
    assert!(!project.join("versions").exists(), "{label}");
    if choice == ResolveChoice::Remote {
      assert!(!remote_path.exists(), "取得一時ファイルは解決後に消す");
      let state = load_or_default_state(
        &app,
        &context.binding.namespace(),
        &context.binding.root_id,
        "abcdefgh23",
      )
      .unwrap();
      assert_eq!(
        state.base_file(path).and_then(|file| file.retained_until.as_deref()),
        remote.retained_until.as_deref()
      );
    }
    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root);
    if let Some(parent) = remote_path.parent() {
      let _ = fs::remove_dir_all(parent);
    }
  }

  let (app, root, context) = reader("large-source-changed");
  let project = root.join("projects/abcdefgh23");
  fs::create_dir_all(&project).unwrap();
  let path = "audio.m4a";
  let local_sha = sparse_file(&project.join(path), BYTES, 3);
  let remote_dir = temp_dir("large-source-changed-remote");
  let remote_path = remote_dir.join("remote.m4a");
  let remote_sha = sparse_file(&remote_path, BYTES, 4);
  let remote = ManifestFile {
    path: path.into(),
    sha256: remote_sha.clone(),
    bytes: BYTES,
    kind: FileKind::Audio,
    modified_at: "2026-10-17T00:00:00.000Z".into(),
    writer_device_id: "d_remote".into(),
    writer_device_kind: None,
    retained_until: None,
    available: true,
  };
  let conflict_id = write_reference_conflict(&project, path, ConflictKind::Edit, Some(local_sha.clone()), remote);
  let file = fs::OpenOptions::new()
    .read(true)
    .write(true)
    .open(&remote_path)
    .unwrap();
  let source = OpenedFileSource::from_opened(file, remote_path.clone(), &remote_sha, BYTES).unwrap();
  let fetched = FetchedRemote::streamed(source, remote_path.clone());
  let mut changed = fs::OpenOptions::new().write(true).open(&remote_path).unwrap();
  changed.seek(SeekFrom::Start(BYTES - 1)).unwrap();
  changed.write_all(&[9]).unwrap();
  drop(changed);
  let target = context.target("abcdefgh23").unwrap();
  assert_eq!(
    resolve_conflict_guarded(
      &context,
      &target,
      &conflict_id,
      ResolveChoice::Remote,
      None,
      Some(&remote_sha),
      Some(fetched),
      &|| true,
    )
    .unwrap_err()
    .code,
    "conflict_changed"
  );
  assert_eq!(sha_path(&project.join(path)), local_sha);
  assert!(!remote_path.exists());
  let _ = fs::remove_dir_all(app);
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(remote_dir);
}

#[test]
fn fetched_small_document_still_publishes_its_version_and_history_together() {
  tauri::async_runtime::block_on(async {
    let (app, root, original) = reader("small-stream-fallback");
    let project = root.join("projects/abcdefgh23");
    let path = "recordings/rec23/artifacts/minutes.md";
    fs::create_dir_all(project.join("recordings/rec23/artifacts")).unwrap();
    fs::write(project.join(path), b"local").unwrap();
    let remote_sha = sha(b"x");
    let remote = ManifestFile {
      path: path.into(),
      sha256: remote_sha.clone(),
      bytes: 1,
      kind: FileKind::Text,
      modified_at: "2026-10-17T00:00:00.000Z".into(),
      writer_device_id: "remote".into(),
      writer_device_kind: None,
      retained_until: None,
      available: true,
    };
    let conflict_id = write_reference_conflict(&project, path, ConflictKind::Edit, Some(sha(b"local")), remote);
    let provider = Arc::new(StreamingOnlyProvider {
      bytes: 1,
      marker: b'x',
      file_calls: AtomicU64::new(0),
      gate: Mutex::new(None),
    });
    let engine = SyncEngine::new(
      provider.clone(),
      &app,
      original.binding.namespace(),
      original.binding.root_id.clone(),
      device(),
      Arc::new(EditProtection::new()),
    );
    let context = Context {
      generation: 1,
      root: original.root.clone(),
      binding: original.binding.clone(),
      device: device(),
      saver: engine.saver(),
      engine,
      active: true,
      provider: Some(provider.clone()),
      session: None,
    };
    let target = context.target("abcdefgh23").unwrap();
    let fetched = fetch_remote_side(&context, &target, &conflict_id, &ResolveChoice::Remote)
      .await
      .unwrap()
      .unwrap();
    let temporary = fetched.temporary.clone().unwrap();
    resolve_conflict_guarded(
      &context,
      &target,
      &conflict_id,
      ResolveChoice::Remote,
      None,
      Some(&remote_sha),
      Some(fetched),
      &|| true,
    )
    .unwrap();
    assert_eq!(fs::read(project.join(path)).unwrap(), b"x");
    let runs: Value = serde_json::from_str(
      fs::read_to_string(project.join("recordings/rec23/runs.jsonl"))
        .unwrap()
        .trim(),
    )
    .unwrap();
    assert_eq!(runs["resolution"], true);
    assert_eq!(runs["versionSha256"], remote_sha);
    assert_eq!(
      fs::read(project.join(runs["versionPath"].as_str().unwrap())).unwrap(),
      b"x"
    );
    assert!(!temporary.exists());
    assert_eq!(provider.file_calls.load(Ordering::SeqCst), 1);
    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root);
  });
}

#[test]
fn remote_large_conflict_fetch_uses_only_the_provider_file_port() {
  tauri::async_runtime::block_on(async {
    const BYTES: u64 = TEXT_MAX_BYTES + 1;
    let app = temp_dir("stream-provider-app");
    let root = temp_dir("stream-provider-root");
    let project = root.join("projects/abcdefgh23");
    fs::create_dir_all(&project).unwrap();
    let path = "audio.m4a";
    let local_sha = sparse_file(&project.join(path), BYTES, 1);
    let expected_dir = temp_dir("stream-provider-expected");
    let expected_path = expected_dir.join("remote.m4a");
    let remote_sha = sparse_file(&expected_path, BYTES, 7);
    let remote = ManifestFile {
      path: path.into(),
      sha256: remote_sha.clone(),
      bytes: BYTES,
      kind: FileKind::Audio,
      modified_at: "2026-10-17T00:00:00.000Z".into(),
      writer_device_id: "d_remote".into(),
      writer_device_kind: None,
      retained_until: Some("2026-11-16T00:00:00.000Z".into()),
      available: true,
    };
    let conflict_id = write_reference_conflict(&project, path, ConflictKind::Edit, Some(local_sha), remote);
    let binding = root_binding(&app, &root).unwrap();
    let provider = Arc::new(StreamingOnlyProvider {
      bytes: BYTES,
      marker: 7,
      file_calls: AtomicU64::new(0),
      gate: Mutex::new(None),
    });
    let engine = SyncEngine::new(
      provider.clone(),
      &app,
      binding.namespace(),
      binding.root_id.clone(),
      device(),
      Arc::new(EditProtection::new()),
    );
    let context = Context {
      generation: 1,
      root: binding.path.clone(),
      binding,
      device: device(),
      saver: engine.saver(),
      engine,
      active: true,
      provider: Some(provider.clone()),
      session: None,
    };
    let target = context.target("abcdefgh23").unwrap();
    let fetched = fetch_remote_side(&context, &target, &conflict_id, &ResolveChoice::Remote)
      .await
      .unwrap()
      .unwrap();
    let temporary = fetched.temporary.clone().unwrap();
    assert_eq!(provider.file_calls.load(Ordering::SeqCst), 1);
    resolve_conflict_guarded(
      &context,
      &target,
      &conflict_id,
      ResolveChoice::Remote,
      None,
      Some(&remote_sha),
      Some(fetched),
      &|| true,
    )
    .unwrap();
    assert!(!temporary.exists());
    let mut resolved = fs::File::open(project.join(path)).unwrap();
    resolved.seek(SeekFrom::Start(BYTES - 1)).unwrap();
    let mut marker = [0_u8; 1];
    resolved.read_exact(&mut marker).unwrap();
    assert_eq!(marker, [7]);
    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root);
    let _ = fs::remove_dir_all(expected_dir);
  });
}

#[test]
fn large_remote_fetch_rejects_an_intervening_local_save_then_explicit_retry_refreshes_cas() {
  tauri::async_runtime::block_on(async {
    const BYTES: u64 = TEXT_MAX_BYTES + 1;
    let app = temp_dir("stream-retry-app");
    let root = temp_dir("stream-retry-root");
    let project = root.join("projects/abcdefgh23");
    fs::create_dir_all(&project).unwrap();
    let path = "audio.m4a";
    let local_sha = sparse_file(&project.join(path), BYTES, 1);
    let expected_dir = temp_dir("stream-retry-expected");
    let remote_path = expected_dir.join("remote.m4a");
    let remote_sha = sparse_file(&remote_path, BYTES, 7);
    let remote = ManifestFile {
      path: path.into(),
      sha256: remote_sha.clone(),
      bytes: BYTES,
      kind: FileKind::Audio,
      modified_at: "2026-10-17T00:00:00.000Z".into(),
      writer_device_id: "d_remote".into(),
      writer_device_kind: None,
      retained_until: Some("2026-11-16T00:00:00.000Z".into()),
      available: true,
    };
    let conflict_id = write_reference_conflict(&project, path, ConflictKind::Edit, Some(local_sha), remote);
    let binding = root_binding(&app, &root).unwrap();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let provider = Arc::new(StreamingOnlyProvider {
      bytes: BYTES,
      marker: 7,
      file_calls: AtomicU64::new(0),
      gate: Mutex::new(Some((started_tx, release_rx))),
    });
    let engine = SyncEngine::new(
      provider.clone(),
      &app,
      binding.namespace(),
      binding.root_id.clone(),
      device(),
      Arc::new(EditProtection::new()),
    );
    let context = Arc::new(Context {
      generation: 1,
      root: binding.path.clone(),
      binding,
      device: device(),
      saver: engine.saver(),
      engine,
      active: true,
      provider: Some(provider.clone()),
      session: None,
    });
    let target = context.target("abcdefgh23").unwrap();
    let fetch_context = context.clone();
    let fetch_target = target.clone();
    let fetch_conflict = conflict_id.clone();
    let fetch = tauri::async_runtime::spawn(async move {
      fetch_remote_side(&fetch_context, &fetch_target, &fetch_conflict, &ResolveChoice::Remote).await
    });
    started_rx.await.unwrap();

    let mut new_local = vec![0_u8; BYTES as usize];
    *new_local.last_mut().unwrap() = 9;
    let new_local_sha = sha(&new_local);
    store::with_write_lock(|| {
      context
        .saver
        .save(
          &target,
          SaveGroup {
            writes: vec![SaveWrite::Put {
              path: path.into(),
              bytes: new_local,
            }],
            kind: SaveKind::Edit,
          },
        )
        .unwrap()
    });
    let _ = release_tx.send(());
    let fetched = fetch.await.unwrap().unwrap().unwrap();
    assert_eq!(
      resolve_conflict_guarded(
        &context,
        &target,
        &conflict_id,
        ResolveChoice::Remote,
        None,
        Some(&remote_sha),
        Some(fetched),
        &|| true,
      )
      .unwrap_err()
      .code,
      "conflict_changed"
    );
    assert_eq!(sha_path(&project.join(path)), new_local_sha);

    let fetched = fetch_remote_side(&context, &target, &conflict_id, &ResolveChoice::Remote)
      .await
      .unwrap()
      .unwrap();
    resolve_conflict_guarded(
      &context,
      &target,
      &conflict_id,
      ResolveChoice::Remote,
      None,
      Some(&remote_sha),
      Some(fetched),
      &|| true,
    )
    .unwrap();
    assert_eq!(sha_path(&project.join(path)), remote_sha);
    assert_eq!(provider.file_calls.load(Ordering::SeqCst), 2);
    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root);
    let _ = fs::remove_dir_all(expected_dir);
  });
}

#[test]
fn development_launches_use_the_cloud_only_when_asked() {
  assert!(cloud_allowed(false, None));
  assert!(!cloud_allowed(true, None));
  assert!(!cloud_allowed(true, Some("0")));
  assert!(cloud_allowed(true, Some("1")));
  assert!(cloud_allowed(true, Some(" 1\n")));

  // 開発・試験の起動: 設定に niho が残っていても同期せず、選ぼうとすると理由を返す
  let app = temp_dir("dev-cloud-app");
  let root = temp_dir("dev-cloud-root");
  fs::write(
    app.join("settings.json"),
    r#"{"version":3,"vault":{"provider":"niho","deviceName":null}}"#,
  )
  .unwrap();
  let inner = Arc::new(CloudInner::new(
    None,
    &app,
    None,
    "prod",
    NihoEnvironment::Production,
    device(),
  ));
  inner.cloud_allowed.store(false, Ordering::SeqCst);
  inner.open_root(&root);
  assert_eq!(inner.provider_kind(), ProviderKind::Local);
  let error = tauri::async_runtime::block_on(inner.set_provider(ProviderKind::Niho, false)).unwrap_err();
  assert_eq!(error.code, "vault_dev_disabled");
  assert!(error.message.contains("NIHO_DOCS_CLOUD=1"));
  let _ = fs::remove_dir_all(app);
  let _ = fs::remove_dir_all(root);
}

#[test]
fn the_save_destination_is_niho_cloud_only_outside_dev_launches() {
  // 保存先は NIHO クラウドだけ（#18728）: settings.json に旧い local が残っていても NIHO クラウドとして動き、
  // 「この Mac だけ」へは切り替えられない
  let app = temp_dir("cloud-only-app");
  let root = temp_dir("cloud-only-root");
  fs::write(
    app.join("settings.json"),
    r#"{"version":3,"vault":{"provider":"local","deviceName":null}}"#,
  )
  .unwrap();
  let inner = Arc::new(CloudInner::new(
    None,
    &app,
    None,
    "prod",
    NihoEnvironment::Production,
    device(),
  ));
  inner.open_root(&root);
  assert_eq!(inner.provider_kind(), ProviderKind::Niho);
  let error = tauri::async_runtime::block_on(inner.set_provider(ProviderKind::Local, false)).unwrap_err();
  assert_eq!(error.code, "vault_cloud_only");
  assert_eq!(
    read_vault_settings(&app).0,
    ProviderKind::Local,
    "断ったときは設定を書き換えない"
  );
  // 開発・試験の起動だけは、この Mac だけとして動く
  inner.cloud_allowed.store(false, Ordering::SeqCst);
  assert_eq!(inner.provider_kind(), ProviderKind::Local);
  let _ = fs::remove_dir_all(app);
  let _ = fs::remove_dir_all(root);
}

#[test]
fn migration_starts_unless_it_finished_or_the_person_paused_it() {
  let file = |total: usize, done: usize, failed: usize, cancelled: bool| MigrationFile {
    root_id: "r".into(),
    done: (0..done).map(|index| format!("p{index}")).collect(),
    failed: (0..failed)
      .map(|index| MigrationFailure {
        project_id: format!("f{index}"),
        name: String::new(),
        reason: String::new(),
      })
      .collect(),
    total,
    cancelled,
    ..MigrationFile::default()
  };
  // まだ一度も上げていない（アップデート後の初回ログイン）
  assert!(migration_should_start(None));
  // 途中で終わった（アプリを閉じた・ログアウトした）
  assert!(migration_should_start(Some(&file(3, 1, 0, false))));
  // 終わった（失敗した案件は「再開する」で上げ直す）
  assert!(!migration_should_start(Some(&file(3, 3, 0, false))));
  assert!(!migration_should_start(Some(&file(3, 2, 1, false))));
  // 本人が中断した
  assert!(!migration_should_start(Some(&file(3, 1, 0, true))));
}

#[test]
fn tombstone_choices_succeed_only_when_the_choice_was_carried_out() {
  assert!(tombstone_choice_result(true, &SyncStatus::Synced { revision: 3 }).is_ok());
  assert!(tombstone_choice_result(
    false,
    &SyncStatus::MovedDeletedProject {
      path: PathBuf::from("/x")
    }
  )
  .is_ok());
  for status in [
    SyncStatus::Offline,
    SyncStatus::AuthRequired,
    SyncStatus::Backoff {
      retry_after: "2026-10-17T00:00:00.000Z".into(),
    },
    SyncStatus::TombstoneChoiceRequired,
  ] {
    for restore in [true, false] {
      assert_eq!(
        tombstone_choice_result(restore, &status).unwrap_err().code,
        "cloud_tombstone_incomplete",
        "{status:?}"
      );
    }
  }
  // 手元から消すのは、写しを退避できたときだけ
  assert!(tombstone_choice_result(false, &SyncStatus::Synced { revision: 3 }).is_err());
}
