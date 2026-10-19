//! personal_run.rs のテスト。通信はしない: 本物の AccountService を偽の HttpClient（通信は全部失敗）で動かし、同期する口は
//! 偽の provider（lease だけ答える）、工程の実行は偽の runner（呼ばれた回数を数える）。

use super::*;
use crate::cloud::{RemoteLease, RemoteProject};
use crate::contract::{
  ClaudeUpdate, EventSink, LlmRunner, MaintenanceError, Provider, ProviderStatus, ProviderUsage, ReasonCode, TurnEvent,
  TurnHandle, TurnRequest,
};
use crate::{
  guarded_deepgram_http, register_prepared_audio, run_turn_with, transcribe_audio_part_with, transcribe_with,
  AudioPartRef, AudioPartRequestWire, PreparedAudio, TranscribeRequest, TurnRequestWire,
};

#[test]
fn deepgram_uses_the_captured_recording_and_rechecks_marker_owner_and_cancel_before_each_paid_send() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("deepgram-guard", LeaseMode::Grant);
    let opened = open(
      &h.state,
      &h.cloud,
      request("intent-dg", "local_transcription_only", Some("deepgram")),
    )
    .await
    .unwrap();
    let material = read_material(&h.state, &opened.handle, vec![]).await.unwrap();
    let snapshot = snapshot_from(
      &opened,
      &material,
      json!({ "kind": "local_transcription_only" }),
      Some("proj1"),
      "pg1",
      "rec1",
    );
    reserve_intent(&h.state, &opened.handle, "intent-dg", &snapshot).unwrap();
    let op = operation_for(&h.state, &opened.handle).unwrap();
    assert!(op.matches_recording(Some("proj1"), "rec1"));
    assert!(!op.matches_recording(None, "orec"));
    let paths = op.audio_paths().unwrap();
    assert_eq!(fs::read(&paths[0]).unwrap(), AUDIO);

    let calls = AtomicU64::new(0);
    let no_marker = guarded_deepgram_http(&h.cloud, Some(op.as_ref()), || {
      calls.fetch_add(1, Ordering::SeqCst);
      Ok(())
    })
    .await;
    assert_eq!(no_marker.unwrap_err().code, "personal_guard_failed");
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    mark_dispatch(&h.state, &h.cloud, &opened.handle, "intent-dg", "source")
      .await
      .unwrap();
    guarded_deepgram_http(&h.cloud, Some(op.as_ref()), || {
      calls.fetch_add(1, Ordering::SeqCst);
      Ok(())
    })
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // 1個目の後に本人が変わった場合、2個目のpaid HTTP直前guardで追加送信しない。
    (h.login)("u2");
    let changed = guarded_deepgram_http(&h.cloud, Some(op.as_ref()), || {
      calls.fetch_add(1, Ordering::SeqCst);
      Ok(())
    })
    .await;
    assert_eq!(changed.unwrap_err().code, "personal_guard_failed");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    drop(op);
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    let h = Harness::signed_in("deepgram-cancel", LeaseMode::Grant);
    let opened = open(
      &h.state,
      &h.cloud,
      request("intent-dgc", "local_transcription_only", Some("deepgram")),
    )
    .await
    .unwrap();
    let material = read_material(&h.state, &opened.handle, vec![]).await.unwrap();
    let snapshot = snapshot_from(
      &opened,
      &material,
      json!({ "kind": "local_transcription_only" }),
      Some("proj1"),
      "pg1",
      "rec1",
    );
    reserve_intent(&h.state, &opened.handle, "intent-dgc", &snapshot).unwrap();
    mark_dispatch(&h.state, &h.cloud, &opened.handle, "intent-dgc", "source")
      .await
      .unwrap();
    let op = operation_for(&h.state, &opened.handle).unwrap();
    let calls = AtomicU64::new(0);
    guarded_deepgram_http(&h.cloud, Some(op.as_ref()), || {
      calls.fetch_add(1, Ordering::SeqCst);
      Ok(())
    })
    .await
    .unwrap();
    cancel(&h.state, &opened.handle).unwrap();
    let canceled = guarded_deepgram_http(&h.cloud, Some(op.as_ref()), || {
      calls.fetch_add(1, Ordering::SeqCst);
      Ok(())
    })
    .await;
    assert_eq!(canceled.unwrap_err().code, "personal_guard_failed");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    drop(op);
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    // spawn前のguardを通った後にleaseを失った場合も、worker内のpaid HTTP直前に送信0で拒否する。
    let h = Harness::signed_in("deepgram-lease", LeaseMode::Grant);
    let opened = open(
      &h.state,
      &h.cloud,
      request("intent-dgl", "local_transcription_only", Some("deepgram")),
    )
    .await
    .unwrap();
    let material = read_material(&h.state, &opened.handle, vec![]).await.unwrap();
    let snapshot = snapshot_from(
      &opened,
      &material,
      json!({ "kind": "local_transcription_only" }),
      Some("proj1"),
      "pg1",
      "rec1",
    );
    reserve_intent(&h.state, &opened.handle, "intent-dgl", &snapshot).unwrap();
    mark_dispatch(&h.state, &h.cloud, &opened.handle, "intent-dgl", "source")
      .await
      .unwrap();
    let op = operation_for(&h.state, &opened.handle).unwrap();
    send_guard(&h.cloud, &op, SendKind::Deepgram).await.unwrap();
    h.cloud
      .release_owned_lease(&op.captured, &op.lease_project, &op.lease_id, true)
      .await;
    let calls = AtomicU64::new(0);
    let expired = guarded_deepgram_http(&h.cloud, Some(op.as_ref()), || {
      calls.fetch_add(1, Ordering::SeqCst);
      Ok(())
    })
    .await;
    assert_eq!(expired.unwrap_err().code, "personal_guard_failed");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    drop(op);
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}
use niho_desktop_account::AccountService;
use niho_desktop_vault::{
  account_key, bind_root, root_binding, CommitRequest, CommitResponse, Lease, LeaseHeldBy, Manifest, ManifestFile,
  ProjectSummary, ProviderKind, ProviderSettings, Usage, VaultError, VaultProvider,
};
use std::sync::atomic::AtomicU64;
use tauri::ipc::Channel;

fn temp_dir(name: &str) -> PathBuf {
  let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
    "niho-docs-personal-{name}-{}-{}",
    std::process::id(),
    crate::process::hex(&crate::process::random_bytes::<4>().unwrap())
  ));
  fs::create_dir_all(&dir).unwrap();
  dir
}

fn sha(bytes: &[u8]) -> String {
  sha256_hex(bytes)
}

/// 本物の AccountService を、保存済みの接続から「ログイン済み」に戻せる状態にする（cloud_tests.rs と同じ手法。通信は全部失敗）。
fn offline_account(app: &Path) -> (Arc<AccountService>, Box<dyn Fn(&str)>) {
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
          connection_id: format!("connection-{user_id}"),
          avatar_file: None,
          expired: None,
        })
        .unwrap();
      secrets.put(SecretKind::RefreshToken, Secret::new("refresh-token"));
      account.restore();
    }
  };
  (account, Box::new(login))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LeaseMode {
  Grant,
  Held,
  Offline,
}

/// lease だけ答える provider（ほかは通信できない扱い）。
struct FakeProvider {
  mode: Mutex<LeaseMode>,
  acquired: Mutex<Vec<String>>,
  released: AtomicU64,
  /// 入れると、次の lease の取得が始まったことを知らせ、続けてよいと言われるまで待つ（1 回だけ）。
  gate: Mutex<LeaseGate>,
}

type LeaseGate = Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>;

impl FakeProvider {
  fn new(mode: LeaseMode) -> Arc<Self> {
    Arc::new(Self {
      mode: Mutex::new(mode),
      acquired: Mutex::new(Vec::new()),
      released: AtomicU64::new(0),
      gate: Mutex::new(None),
    })
  }

  fn lease() -> Lease {
    Lease {
      lease_id: "cloud-lease-1".into(),
      expires_at: (chrono::Utc::now() + chrono::Duration::minutes(10)).to_rfc3339(),
    }
  }
}

fn offline<T>() -> std::result::Result<T, VaultError> {
  Err(VaultError::Offline("test".into()))
}

#[async_trait::async_trait]
impl VaultProvider for FakeProvider {
  async fn get_settings(&self, _device_id: &str) -> std::result::Result<ProviderSettings, VaultError> {
    offline()
  }
  async fn put_settings(
    &self,
    _device_id: &str,
    _provider: ProviderKind,
  ) -> std::result::Result<ProviderSettings, VaultError> {
    offline()
  }
  async fn list_projects(
    &self,
    _reserved: bool,
    _deleted: bool,
  ) -> std::result::Result<Vec<ProjectSummary>, VaultError> {
    offline()
  }
  async fn get_or_create_project(
    &self,
    _project_id: &str,
    _name: Option<&str>,
  ) -> std::result::Result<Manifest, VaultError> {
    offline()
  }
  async fn get_project(&self, _project_id: &str) -> std::result::Result<Manifest, VaultError> {
    offline()
  }
  async fn upload_blob(
    &self,
    _project_id: &str,
    _file: &ManifestFile,
    _bytes: Vec<u8>,
  ) -> std::result::Result<(), VaultError> {
    offline()
  }
  async fn download_blob(
    &self,
    _project_id: &str,
    _file: &ManifestFile,
  ) -> std::result::Result<Option<Vec<u8>>, VaultError> {
    offline()
  }
  async fn commit(
    &self,
    _project_id: &str,
    _request: &CommitRequest,
  ) -> std::result::Result<CommitResponse, VaultError> {
    offline()
  }
  async fn delete_project(&self, _project_id: &str) -> std::result::Result<(), VaultError> {
    offline()
  }
  async fn restore_project(&self, _project_id: &str) -> std::result::Result<(), VaultError> {
    offline()
  }
  async fn acquire_lease(
    &self,
    project_id: &str,
    _device_id: &str,
    _device_name: &str,
    _lease_id: Option<&str>,
  ) -> std::result::Result<Lease, VaultError> {
    let gate = lock(&self.gate).take();
    if let Some((started, release)) = gate {
      let _ = started.send(());
      let _ = release.await;
    }
    let mode = *lock(&self.mode);
    match mode {
      LeaseMode::Grant => {
        lock(&self.acquired).push(project_id.to_string());
        Ok(Self::lease())
      }
      LeaseMode::Held => Err(VaultError::LeaseHeld {
        held_by: Some(LeaseHeldBy {
          device_name: "Mac mini".into(),
          since: String::new(),
          expires_at: String::new(),
        }),
      }),
      LeaseMode::Offline => offline(),
    }
  }
  async fn renew_lease(&self, _project_id: &str, _lease_id: &str) -> std::result::Result<Lease, VaultError> {
    Ok(Self::lease())
  }
  async fn release_lease(&self, _project_id: &str, _lease_id: &str) -> std::result::Result<(), VaultError> {
    self.released.fetch_add(1, Ordering::SeqCst);
    Ok(())
  }
  async fn usage(&self) -> std::result::Result<Usage, VaultError> {
    offline()
  }
}

struct NoopHandle;

impl TurnHandle for NoopHandle {
  fn stop(&self) {}
}

/// 呼ばれた回数だけ数え、すぐに終わる runner（外部 AI へは何も送らない）。
#[derive(Default)]
struct FakeRunner {
  calls: AtomicU64,
}

impl LlmRunner for FakeRunner {
  fn run_turn(&self, _request: TurnRequest, mut on_event: EventSink) -> Arc<dyn TurnHandle> {
    self.calls.fetch_add(1, Ordering::SeqCst);
    on_event(TurnEvent::Error {
      reason_code: ReasonCode::CliLoginRequired,
      message: "fake".into(),
    });
    Arc::new(NoopHandle)
  }
  fn provider_status(&self, _provider: Provider) -> ProviderStatus {
    unimplemented!()
  }
  fn start_auth(&self, _provider: Provider) -> std::result::Result<ProviderStatus, MaintenanceError> {
    unimplemented!()
  }
  fn install_claude(&self) -> std::result::Result<ProviderStatus, MaintenanceError> {
    unimplemented!()
  }
  fn update_claude(&self) -> std::result::Result<ClaudeUpdate, MaintenanceError> {
    unimplemented!()
  }
  fn has_running_turns(&self) -> bool {
    false
  }
  fn provider_usage(&self, _provider: Provider) -> std::result::Result<ProviderUsage, MaintenanceError> {
    unimplemented!()
  }
  fn shutdown(&self) {}
}

const AUDIO: &[u8] = b"fake-audio-bytes-for-a-recording";
const OUTSIDE_AUDIO: &[u8] = b"outside-audio";

fn flow_snapshot() -> Value {
  let model = json!({
    "provider": "claude",
    "model": "claude-sonnet-5",
    "effort": "high",
    "profileId": "standard",
    "profileName": "標準",
    "connection": "subscription",
  });
  json!({
    "version": 1,
    "id": "flow-1",
    "name": "議事録",
    "revision": 3,
    "guide": "固有名詞を守る",
    "terms": [],
    "samples": [],
    "steps": [
      { "id": "outline", "name": "要点", "instruction": "要点", "provider": "claude", "profile": "standard" },
      { "id": "minutes", "name": "議事録", "instruction": "整理", "provider": "claude", "profile": "standard" },
    ],
    "models": { "outline": model.clone(), "minutes": model },
  })
}

fn write_json(path: &Path, value: &Value) {
  fs::create_dir_all(path.parent().unwrap()).unwrap();
  fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

/// 保存先: フォルダ `proj1` の録音（ページ `pg1`・録音 `rec1`・参考 `ref1`）と、フォルダ外の録音（ページ `opg`・録音 `orec`）。
fn write_docs(root: &Path, audio: &[u8]) {
  let at = "2026-10-17T00:00:00.000Z";
  write_json(
    &root.join("projects/proj1/project.json"),
    &json!({
      "version": 1,
      "id": "proj1",
      "name": "案件",
      "createdAt": at,
      "info": {
        "terms": [{ "term": "朝市", "reading": "あさいち", "variants": [], "note": "" }],
        "background": "朝市の取材",
        "entities": [{ "id": "e1", "name": "高浜", "reading": "", "role": "", "note": "" }],
      },
      "pages": {
        "version": 1,
        "order": ["pg1", "ref1"],
        "items": {
          "pg1": { "kind": "recording", "title": "録音", "createdAt": at, "recordingId": "rec1" },
          "ref1": { "kind": "document", "title": "参考の文書", "createdAt": at },
        },
      },
    }),
  );
  fs::create_dir_all(root.join("projects/proj1/pages")).unwrap();
  fs::write(root.join("projects/proj1/pages/ref1.md"), "参考の本文").unwrap();
  let recording = |id: &str, page: &str, file: &str, bytes: &[u8], refs: Value| {
    json!({
      "version": 1,
      "id": id,
      "pageId": page,
      "createdAt": at,
      "flowSnapshot": flow_snapshot(),
      "info": { "speakers": "2", "language": "ja" },
      "source": { "kind": "audio", "audio": [{ "file": file, "hash": sha(bytes), "name": "a.m4a", "durationSec": 5.712562358276644 }] },
      "refs": refs,
    })
  };
  let rec_dir = root.join("projects/proj1/recordings/rec1");
  write_json(
    &rec_dir.join("recording.json"),
    &recording("rec1", "pg1", "a1.m4a", audio, json!(["ref1"])),
  );
  fs::create_dir_all(rec_dir.join("inputs")).unwrap();
  fs::write(rec_dir.join("inputs/a1.m4a"), audio).unwrap();
  write_json(
    &root.join("pages.json"),
    &json!({
      "version": 1,
      "order": ["opg"],
      "items": { "opg": { "kind": "recording", "title": "", "createdAt": at, "recordingId": "orec" } },
    }),
  );
  let outside = root.join("recordings/orec");
  write_json(
    &outside.join("recording.json"),
    &recording("orec", "opg", "o1.m4a", OUTSIDE_AUDIO, json!([])),
  );
  fs::create_dir_all(outside.join("inputs")).unwrap();
  fs::write(outside.join("inputs/o1.m4a"), OUTSIDE_AUDIO).unwrap();
}

struct Harness {
  app: PathBuf,
  root: PathBuf,
  login: Box<dyn Fn(&str)>,
  cloud: Cloud,
  state: AppState,
  provider: Arc<FakeProvider>,
  runner: Arc<FakeRunner>,
  key: String,
}

impl Harness {
  /// ログイン済み（u1）・保存先は u1 に結び付き・同期する口は偽の provider。
  fn signed_in(name: &str, mode: LeaseMode) -> Self {
    Self::signed_in_with_root(name, mode, None)
  }

  /// `root_id` を渡すと、保存先の id をその値に固定する（golden fixture の hash を実行ごとに変えないため。app data の
  /// `vault/roots.json` に先に結び付きを置く）。
  fn signed_in_with_root(name: &str, mode: LeaseMode, root_id: Option<&str>) -> Self {
    let app = temp_dir(&format!("{name}-app"));
    let root = temp_dir(&format!("{name}-root"));
    write_docs(&root, AUDIO);
    if let Some(root_id) = root_id {
      write_json(
        &app.join("vault/roots.json"),
        &json!({
          "schemaVersion": 1,
          "roots": [{ "rootId": root_id, "path": root, "accountKey": null, "epoch": 1 }],
        }),
      );
    }
    let (account, login) = offline_account(&app);
    login("u1");
    let key = account_key("prod", "u1");
    let binding = root_binding(&app, &root).unwrap();
    bind_root(&app, &binding.root_id, Some(&key)).unwrap();
    let cloud = Cloud::for_tests(&app, Some(account));
    cloud.test_open_root(&root);
    let provider = FakeProvider::new(mode);
    cloud.test_install_active(provider.clone());
    let runner = Arc::new(FakeRunner::default());
    let state = AppState::for_tests(runner.clone(), app.clone());
    Self {
      app,
      root,
      login,
      cloud,
      state,
      provider,
      runner,
      key,
    }
  }

  fn root_id(&self) -> String {
    root_binding(&self.app, &self.root).unwrap().root_id
  }

  /// アプリを開き直した（同じ app data・同じ保存先の新しい AppState）。
  fn restart_state(&self) -> AppState {
    AppState::for_tests(self.runner.clone(), self.app.clone())
  }

  fn rec_dir(&self) -> PathBuf {
    self.root.join("projects/proj1/recordings/rec1")
  }
}

impl Drop for Harness {
  fn drop(&mut self) {
    self.cloud.test_stop();
    let _ = fs::remove_dir_all(&self.app);
    let _ = fs::remove_dir_all(&self.root);
  }
}

#[test]
fn niho_model_swap_is_captured_guarded_and_rejects_a_changed_flow() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("niho-model-swap", LeaseMode::Grant);
    let mut request = request("intent-swap", "generation_only", None);
    request.route.executor = Some("niho_api".into());
    let opened = open(&h.state, &h.cloud, request).await.unwrap();
    let recording_path = h.rec_dir().join("recording.json");
    let mut recording: Value = serde_json::from_slice(&fs::read(&recording_path).unwrap()).unwrap();
    recording["futureField"] = json!({ "keep": true });
    write_json(&recording_path, &recording);
    let expected_flow = recording["flowSnapshot"].clone();
    let target = json!({
      "provider": "gemini",
      "model": "gemini-2.5-flash",
      "effort": "low",
      "profileName": "NIHO API",
      "connection": "apiKey",
    });

    let mut stale_flow = expected_flow.clone();
    stale_flow["guide"] = json!("確認後に別端末で変わった指示");
    assert!(!swap_models(
      &h.state,
      &opened.handle,
      stale_flow,
      json!({ "outline": target.clone() })
    )
    .unwrap());
    let unchanged: Value = serde_json::from_slice(&fs::read(&recording_path).unwrap()).unwrap();
    assert_eq!(unchanged["flowSnapshot"], expected_flow);
    assert_eq!(unchanged["futureField"], json!({ "keep": true }));

    assert!(swap_models(
      &h.state,
      &opened.handle,
      expected_flow.clone(),
      json!({ "outline": target.clone() }),
    )
    .unwrap());
    let saved: Value = serde_json::from_slice(&fs::read(&recording_path).unwrap()).unwrap();
    assert_eq!(saved["flowSnapshot"]["models"]["outline"], target);
    assert_eq!(
      saved["flowSnapshot"]["models"]["minutes"],
      expected_flow["models"]["minutes"]
    );
    assert_eq!(saved["futureField"], json!({ "keep": true }));

    // 本人が切り替わった後は、開始時に捕捉した本人の録音にも書かない。
    (h.login)("u2");
    let refused = swap_models(
      &h.state,
      &opened.handle,
      saved["flowSnapshot"].clone(),
      json!({ "minutes": target }),
    )
    .unwrap_err();
    assert_eq!(refused.code, "personal_guard_failed");
    let after_switch: Value = serde_json::from_slice(&fs::read(&recording_path).unwrap()).unwrap();
    assert_eq!(after_switch, saved);
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

fn request(intent: &str, route: &str, transcription: Option<&str>) -> OpenRequestWire {
  OpenRequestWire {
    project_id: Some("proj1".into()),
    recording_page_id: "pg1".into(),
    recording_id: "rec1".into(),
    intent_id: intent.into(),
    run_id: format!("run-{intent}"),
    route: RouteWire {
      kind: route.into(),
      executor: (route == "generation_only").then(|| "this_pc".to_string()),
    },
    transcription_provider: transcription.map(str::to_string),
    transcription_connection: None,
    output_target: None,
  }
}

fn outside_request(intent: &str) -> OpenRequestWire {
  OpenRequestWire {
    project_id: None,
    recording_page_id: "opg".into(),
    recording_id: "orec".into(),
    ..request(intent, "local_transcription_only", Some("this-mac"))
  }
}

/// material から、controller と同じ欄を持つ固定入力を作る（hash は Native の canonical で付ける）。
fn snapshot_from(
  open: &OpenResult,
  material: &Value,
  route: Value,
  project: Option<&str>,
  page: &str,
  rec: &str,
) -> Value {
  let selected: Vec<Value> = material["expectedCurrentArtifactShaByStep"]
    .as_object()
    .unwrap()
    .keys()
    .filter(|key| *key != "source")
    .map(|key| Value::from(key.clone()))
    .collect();
  let fixed: Map<String, Value> = selected
    .iter()
    .map(|step| {
      let step = step.as_str().unwrap();
      (step.to_string(), material["flow"]["models"][step].clone())
    })
    .collect();
  let refs: Vec<Value> = material["referencePages"]
    .as_array()
    .unwrap()
    .iter()
    .map(|item| {
      let content = item["content"].as_str().unwrap();
      json!({
        "pageId": item["pageId"], "path": item["path"], "versionId": item["versionId"],
        "sha256": sha(content.as_bytes()), "bytes": content.len(),
      })
    })
    .collect();
  let snapshot = json!({
    "schemaVersion": 1,
    "ownerAccountId": open.owner_account_id,
    "rootId": open.root_id,
    "containerRef": container_json(project),
    "recordingPageId": page,
    "recordingId": rec,
    "baseManifestRevision": material["baseManifestRevision"],
    "route": route,
    "continuationOfRunId": null,
    "consentVersion": "consent-v1",
    "transcriptionModel": material["transcriptionModel"],
    "selectedStepIds": selected,
    "stepNames": {},
    "input": {
      "audio": material["audio"],
      "sourceVersion": null,
      "referencePages": refs,
      "priorSteps": [],
      "expectedCurrentArtifactShaByStep": material["expectedCurrentArtifactShaByStep"],
      "recordingMetadataSha256": sha(canonical(&material["recordingMetadata"]).unwrap().as_bytes()),
    },
    "flowSnapshotSha256": sha(canonical(&material["flow"]).unwrap().as_bytes()),
    "fixedModels": fixed,
    "snapshotSha256": "",
  });
  Value::Object(with_hash(snapshot.as_object().unwrap().clone()).unwrap())
}

fn rehash(mut snapshot: Value, change: impl FnOnce(&mut Value)) -> Value {
  change(&mut snapshot);
  Value::Object(with_hash(snapshot.as_object().unwrap().clone()).unwrap())
}

/// 開いて素材を読み、受け付けるまで（フォルダの録音・Gemini の全工程）。
async fn reserved(h: &Harness, intent: &str) -> (OpenResult, Value) {
  reserved_as(h, intent, &format!("run-{intent}")).await
}

/// `reserved` の runId 違い（画面が作る `run_<22字>` は大文字を含む）。
async fn reserved_as(h: &Harness, intent: &str, run_id: &str) -> (OpenResult, Value) {
  let opened = open(
    &h.state,
    &h.cloud,
    OpenRequestWire {
      run_id: run_id.into(),
      ..request(intent, "local_full", Some("gemini"))
    },
  )
  .await
  .unwrap();
  let material = read_material(&h.state, &opened.handle, vec!["outline".into(), "minutes".into()])
    .await
    .unwrap();
  let snapshot = snapshot_from(
    &opened,
    &material,
    json!({ "kind": "local_full" }),
    Some("proj1"),
    "pg1",
    "rec1",
  );
  assert_eq!(
    reserve_intent(&h.state, &opened.handle, intent, &snapshot).unwrap(),
    ReserveResult::New
  );
  (opened, snapshot)
}

fn candidate(step: &str, kind: &str, name: &str, text: &str, provider: &str, model: Value) -> CandidateWire {
  CandidateWire {
    step_id: step.into(),
    artifact_id: step.into(),
    kind: kind.into(),
    version_id: name.into(),
    path: format!("recordings/rec1/versions/{step}/{name}.md"),
    text: text.into(),
    provider: provider.into(),
    model,
    reported_model: None,
    sha256: sha(text.as_bytes()),
    bytes: text.len() as u64,
  }
}

fn source_candidate(name: &str, text: &str) -> CandidateWire {
  candidate(
    "source",
    "source",
    name,
    text,
    "gemini",
    json!(GEMINI_TRANSCRIPTION_MODEL),
  )
}

fn artifact_candidate(step: &str, name: &str, text: &str) -> CandidateWire {
  candidate(step, "artifact", name, text, "claude", json!("claude-sonnet-5"))
}

fn aggregate(intent: &str) -> Value {
  json!({
    "schemaVersion": 1,
    "runId": format!("run-{intent}"),
    "intentId": intent,
    "originDeviceId": "d_test",
    "recordingPageId": "pg1",
    "recordingId": "rec1",
    "origin": "this_pc",
    "state": "running",
    "versions": [],
    "retainedCandidates": [],
  })
}

fn publish_input(intent: &str, step: &str, kind: &str, version: &str, expected: Option<String>) -> PublishWire {
  PublishWire {
    intent_id: intent.into(),
    step_id: step.into(),
    artifact_id: step.into(),
    kind: kind.into(),
    candidate_version_id: version.into(),
    expected_current_sha: expected,
    aggregate: aggregate(intent),
    record: Some(json!({ "id": "r6-event", "kind": "run", "stepName": "工程", "at": "2026-10-17T01:00:00.000Z" })),
  }
}

/// 保管庫の版 ID（`v_` ＋ 22 字）。
fn vid(tag: &str) -> String {
  format!("v_{tag:A<22}")
}

/// 2 つの future を同じ task で並べて進める（どちらも終わるまで）。
async fn join2<A: std::future::Future, B: std::future::Future>(a: A, b: B) -> (A::Output, B::Output) {
  let mut a = std::pin::pin!(a);
  let mut b = std::pin::pin!(b);
  let mut left = None;
  let mut right = None;
  std::future::poll_fn(|cx| {
    if left.is_none() {
      if let std::task::Poll::Ready(value) = a.as_mut().poll(cx) {
        left = Some(value);
      }
    }
    if right.is_none() {
      if let std::task::Poll::Ready(value) = b.as_mut().poll(cx) {
        right = Some(value);
      }
    }
    if left.is_some() && right.is_some() {
      std::task::Poll::Ready(())
    } else {
      std::task::Poll::Pending
    }
  })
  .await;
  (left.unwrap(), right.unwrap())
}

/// 録音のフォルダに版を足す（版のファイルと runs.jsonl の行。`extra` は行に足す欄）。
fn add_version(dir: &Path, step: &str, version_id: &str, number: u64, text: &str, extra: Value) -> String {
  let recording = dir.file_name().unwrap().to_str().unwrap();
  let relative = format!("recordings/{recording}/versions/{step}/{version_id}.md");
  fs::create_dir_all(dir.join("versions").join(step)).unwrap();
  fs::write(dir.join(format!("versions/{step}/{version_id}.md")), text).unwrap();
  let mut row = json!({
    "id": format!("run-{number}"), "kind": "run", "at": format!("2026-10-16T00:00:0{number}.000Z"), "stepId": step,
    "stepName": "", "version": number, "result": "saved", "versionPath": relative, "versionSha256": sha(text.as_bytes()),
  });
  for (key, value) in extra.as_object().unwrap() {
    row[key] = value.clone();
  }
  let mut runs = fs::read_to_string(dir.join("runs.jsonl")).unwrap_or_default();
  runs.push_str(&serde_json::to_string(&row).unwrap());
  runs.push('\n');
  fs::write(dir.join("runs.jsonl"), runs).unwrap();
  relative
}

fn channel() -> Channel<Value> {
  Channel::new(|_| Ok(()))
}

fn turn_request() -> TurnRequestWire {
  TurnRequestWire {
    provider: Provider::ClaudeCode,
    model: "claude-sonnet-5".into(),
    effort: None,
    system_prompt: "s".into(),
    user_prompt: "u".into(),
    resume_session: None,
    workspace: "ws1".into(),
    max_budget_usd: None,
  }
}

fn runs(h: &Harness) -> Vec<Value> {
  fs::read_to_string(h.rec_dir().join("runs.jsonl"))
    .unwrap_or_default()
    .lines()
    .map(|line| serde_json::from_str(line).unwrap())
    .collect()
}

// ---------------------------------------------------------------------------

#[test]
fn open_holds_the_run_lock_and_lease_blocks_root_changes_and_close_releases_on_the_captured_store() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("open-close", LeaseMode::Grant);
    let opened = open(&h.state, &h.cloud, request("intent-a", "local_full", Some("gemini")))
      .await
      .unwrap();
    assert!(opened.handle.starts_with("pop_") && opened.handle.len() == 36);
    assert!(opened.lease_id.starts_with("ls_") && opened.lease_id.len() == 25);
    assert!(opened.cloud_lease);
    assert_eq!(opened.owner_account_id, h.key);
    assert_eq!(opened.root_id, h.root_id());
    let lock_file = h.root.join("projects/proj1/.run.lock");
    assert_eq!(fs::read_to_string(&lock_file).unwrap(), std::process::id().to_string());
    assert!(lock(&h.state.run_locks).contains("proj1"));
    assert!(h.cloud.test_has_lease("proj1").await);
    assert_eq!(*lock(&h.provider.acquired), vec!["proj1".to_string()]);

    // 同じ案件の二重の開始は store_busy（別の intent でも）
    let twice = open(&h.state, &h.cloud, request("intent-b", "local_full", Some("gemini")))
      .await
      .err()
      .unwrap();
    assert_eq!(twice.code, "store_busy");

    // 開いている間は保存先の変更・結び直しが止まる
    let other = temp_dir("open-close-other");
    let changed = h.cloud.commit_root_change(&other, || Ok(())).await.err().unwrap();
    assert_eq!(changed.code, "store_busy");
    assert_eq!(h.cloud.test_rebind().await.err().unwrap().code, "store_busy");

    let closed = close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert!(closed.released);
    assert_eq!(closed.lease_id, opened.lease_id);
    assert!(!lock_file.exists());
    assert!(lock(&h.state.run_locks).is_empty());
    assert!(!h.cloud.test_has_lease("proj1").await);
    assert_eq!(h.provider.released.load(Ordering::SeqCst), 1);
    let again = close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert!(!again.released);
    // 捕捉（OperationLease）が外れた（閉じた後の同期の予約で未送信が残ることはあるので store_busy でないことだけ見る）
    assert_ne!(
      h.cloud.check_root_change().err().map(|error| error.code),
      Some("store_busy".to_string())
    );

    // フォルダ外の録音も、予約の docs-root の lease を取る
    let outside = open(&h.state, &h.cloud, outside_request("intent-o")).await.unwrap();
    assert!(outside.cloud_lease);
    assert!(h.root.join(".run.lock").exists());
    assert!(lock(&h.state.run_locks).contains(OUTSIDE_LOCK_KEY));
    assert_eq!(lock(&h.provider.acquired).last().unwrap(), DOCS_ROOT_PROJECT_ID);
    assert!(close(&h.state, &h.cloud, &outside.handle).await.unwrap().released);
    let _ = fs::remove_dir_all(other);
  });
}

#[test]
fn a_lease_elsewhere_is_refused_and_without_niho_only_on_device_transcription_starts() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("lease", LeaseMode::Held);
    let held = open(
      &h.state,
      &h.cloud,
      request("i1", "local_transcription_only", Some("this-mac")),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(held.code, "lease_held");
    assert!(held.message.contains("Mac mini"));
    assert!(
      !h.root.join("projects/proj1/.run.lock").exists(),
      "断ったら実行のロックを戻す"
    );

    *lock(&h.provider.mode) = LeaseMode::Offline;
    for (route, transcription) in [
      ("local_full", Some("gemini")),
      ("local_full", Some("this-mac")),
      ("local_transcription_only", Some("gemini")),
      ("generation_only", None),
    ] {
      let refused = open(&h.state, &h.cloud, request("i2", route, transcription))
        .await
        .err()
        .unwrap();
      assert_eq!(refused.code, "personal_lease_unavailable", "{route}");
      assert!(lock(&h.state.run_locks).is_empty());
    }
    let local = open(
      &h.state,
      &h.cloud,
      request("i3", "local_transcription_only", Some("this-mac")),
    )
    .await
    .unwrap();
    assert!(!local.cloud_lease);
    assert!(local.lease_id.starts_with("ls_"));
    close(&h.state, &h.cloud, &local.handle).await.unwrap();

    // 通信できなくても、最後に読んだ一覧で別の Mac が持つ期限内の lease は断る（端末内の文字起こしでも）
    h.cloud.test_set_remote(vec![RemoteProject {
      project_id: "proj1".into(),
      name: "案件".into(),
      revision: 1,
      updated_at: String::new(),
      bytes: 0,
      local: true,
      lease: Some(RemoteLease {
        device_name: "MacBook".into(),
        expires_at: (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
        mine: false,
      }),
    }]);
    let known = open(
      &h.state,
      &h.cloud,
      request("i4", "local_transcription_only", Some("this-mac")),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(known.code, "lease_held");
    assert!(known.message.contains("MacBook"));
    assert!(lock(&h.state.run_locks).is_empty());
  });
}

#[test]
fn opening_requires_a_signed_in_owner_bound_to_the_root() {
  tauri::async_runtime::block_on(async {
    let app = temp_dir("signed-out-app");
    let root = temp_dir("signed-out-root");
    write_docs(&root, AUDIO);
    let (account, _login) = offline_account(&app);
    let cloud = Cloud::for_tests(&app, Some(account));
    cloud.test_open_root(&root);
    let state = AppState::for_tests(Arc::new(FakeRunner::default()), app.clone());
    let refused = open(
      &state,
      &cloud,
      request("i1", "local_transcription_only", Some("this-mac")),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(refused.code, "personal_not_signed_in");
    assert!(!root.join("projects/proj1/.run.lock").exists());
    cloud.test_stop();
    let _ = fs::remove_dir_all(app);
    let _ = fs::remove_dir_all(root);
  });
}

#[test]
fn an_account_switch_while_waiting_for_ai_stops_sending_keeps_the_candidate_and_closes_without_the_old_account() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("switch", LeaseMode::Grant);
    let (opened, _) = reserved(&h, "intent-s").await;
    mark_dispatch(&h.state, &h.cloud, &opened.handle, "intent-s", "outline")
      .await
      .unwrap();
    let before = guard(&h.state, &h.cloud, &opened.handle, "before_dispatch", None)
      .await
      .unwrap();
    assert_eq!(before.owner_account_id, h.key);
    assert_eq!(before.lease_id, opened.lease_id);

    // AI を待っている間に別のアカウント（u2）へ切り替わる
    (h.login)("u2");
    h.cloud.test_reconcile().await;
    let after = guard(&h.state, &h.cloud, &opened.handle, "before_persist", None)
      .await
      .unwrap();
    assert_eq!(after.owner_account_id, "", "controller が ACCOUNT_CHANGED にする");
    assert_eq!(after.root_id, h.root_id());

    let sent = run_turn_with(
      &h.state,
      &h.cloud,
      "turn-1".into(),
      turn_request(),
      Some(opened.handle.clone()),
      channel(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(sent.code, "personal_guard_failed");
    let op = operation_for(&h.state, &opened.handle).unwrap();
    bind_job(&h.state, &opened.handle, &op, "job-s").unwrap();
    drop(op);
    let part = transcribe_audio_part_with(
      &h.state,
      &h.cloud,
      "turn-part".into(),
      AudioPartRef {
        job_id: "job-s".into(),
        file: 0,
        part: 0,
      },
      AudioPartRequestWire {
        provider: Provider::GeminiCli,
        model: GEMINI_TRANSCRIPTION_MODEL.into(),
        effort: None,
        system_prompt: "s".into(),
        user_prompt: "u".into(),
      },
      Some(opened.handle.clone()),
      channel(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(part.code, "personal_guard_failed");
    assert_eq!(h.runner.calls.load(Ordering::SeqCst), 0, "切替の後は送らない");

    // 返ってきた結果は、捕捉した元の本人・Root に候補として残す。今の本文は変えない
    let stored = persist_candidate(
      &h.state,
      &opened.handle,
      artifact_candidate("outline", "v_lateAAAAAAAAAAAAAAAAAA", "遅れて返った要点"),
    )
    .unwrap();
    assert_eq!(stored["immutable"], json!(true));
    assert_eq!(
      fs::read_to_string(h.rec_dir().join("versions/outline/v_lateAAAAAAAAAAAAAAAAAA.md")).unwrap(),
      "遅れて返った要点"
    );
    assert!(!h.rec_dir().join("artifacts/outline.md").exists());
    let published = publish(
      &h.state,
      &h.cloud,
      &opened.handle,
      publish_input("intent-s", "outline", "artifact", "v_lateAAAAAAAAAAAAAAAAAA", None),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(published.code, "personal_guard_failed");
    assert!(!h.rec_dir().join("artifacts/outline.md").exists());
    assert!(runs(&h).is_empty());

    // 閉じるときは旧本人の通信をしない（lease は手元の記録だけ捨てる）
    let closed = close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert!(closed.released);
    assert_eq!(h.provider.released.load(Ordering::SeqCst), 0);
    assert!(!h.cloud.test_has_lease("proj1").await);
    assert!(!h.root.join("projects/proj1/.run.lock").exists());
  });
}

#[test]
fn a_reserved_intent_that_never_sent_is_resumed_after_a_restart_but_not_reserved_twice() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("reserved-resume", LeaseMode::Grant);
    let (first, snapshot) = reserved(&h, "intent-r").await;
    // 受け付けた operation の二重の受付は断る（再開ではない）
    assert_eq!(
      reserve_intent(&h.state, &first.handle, "intent-r", &snapshot).unwrap(),
      ReserveResult::Existing {
        state: "running".into()
      }
    );
    // 最初の dispatch marker の前に終わった（一度も送っていない）→ 開き直した同じ固定入力は再開できる
    close(&h.state, &h.cloud, &first.handle).await.unwrap();
    let restarted = h.restart_state();
    let second = open(&restarted, &h.cloud, request("intent-r", "local_full", Some("gemini")))
      .await
      .unwrap();
    read_material(&restarted, &second.handle, vec!["outline".into(), "minutes".into()])
      .await
      .unwrap();
    assert_eq!(
      reserve_intent(&restarted, &second.handle, "intent-r", &snapshot).unwrap(),
      ReserveResult::Resumed
    );
    // 再開した operation の二重の受付はやはり断る
    assert_eq!(
      reserve_intent(&restarted, &second.handle, "intent-r", &snapshot).unwrap(),
      ReserveResult::Existing {
        state: "running".into()
      }
    );
    close(&restarted, &h.cloud, &second.handle).await.unwrap();
    let third = open(&restarted, &h.cloud, request("intent-r", "local_full", Some("gemini")))
      .await
      .unwrap();
    read_material(&restarted, &third.handle, vec!["outline".into(), "minutes".into()])
      .await
      .unwrap();
    let changed = rehash(snapshot.clone(), |snapshot| {
      snapshot["consentVersion"] = json!("consent-v2")
    });
    // 違う固定入力は再開しない
    assert_eq!(
      reserve_intent(&restarted, &third.handle, "intent-r", &changed).unwrap(),
      ReserveResult::Existing {
        state: "running".into()
      }
    );
    // 違う固定入力は再開せず、受付済みにもしない（同じ固定入力ならそのあと再開できる）
    assert_eq!(
      reserve_intent(&restarted, &third.handle, "intent-r", &snapshot).unwrap(),
      ReserveResult::Resumed
    );
    // 送った後（marker がある）は再開しない
    mark_dispatch(&restarted, &h.cloud, &third.handle, "intent-r", "source")
      .await
      .unwrap();
    close(&restarted, &h.cloud, &third.handle).await.unwrap();
    let fourth = open(&restarted, &h.cloud, request("intent-r", "local_full", Some("gemini")))
      .await
      .unwrap();
    read_material(&restarted, &fourth.handle, vec!["outline".into(), "minutes".into()])
      .await
      .unwrap();
    assert_eq!(
      reserve_intent(&restarted, &fourth.handle, "intent-r", &snapshot).unwrap(),
      ReserveResult::Existing {
        state: "result_unknown".into()
      }
    );
    close(&restarted, &h.cloud, &fourth.handle).await.unwrap();
  });
}

#[test]
fn intents_are_reserved_once_survive_a_restart_and_never_resend_an_unknown_result() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("intent", LeaseMode::Grant);
    let (first, snapshot) = reserved(&h, "intent-1").await;
    // 二重クリック: 同じ intent はもう new にならない
    assert_eq!(
      reserve_intent(&h.state, &first.handle, "intent-1", &snapshot).unwrap(),
      ReserveResult::Existing {
        state: "running".into()
      }
    );
    let file = h
      .app
      .join(format!("personal-runs/{}/{}/intents/intent-1.json", h.key, h.root_id()));
    assert!(file.is_file(), "本人 namespace の下（同期しない app data）");
    save_private(
      &h.state,
      &first.handle,
      "intent-1",
      "checkpoint",
      &json!({ "output": "途中" }),
    )
    .unwrap();
    assert!(file
      .with_file_name("intent-1.private")
      .join("checkpoint.json")
      .is_file());
    assert!(runs(&h).is_empty(), "途中記録は runs.jsonl に書かない");
    assert_eq!(
      save_private(&h.state, &first.handle, "intent-1", "secrets", &json!({}))
        .err()
        .unwrap()
        .code,
      "personal_bad_request"
    );

    // 外部実行の直前に marker を書いたまま落ちた → 開き直しても結果不明（自動で送り直さない）
    mark_dispatch(&h.state, &h.cloud, &first.handle, "intent-1", "source")
      .await
      .unwrap();
    close(&h.state, &h.cloud, &first.handle).await.unwrap();
    let restarted = h.restart_state();
    let second = open(&restarted, &h.cloud, request("intent-1", "local_full", Some("gemini")))
      .await
      .unwrap();
    read_material(&restarted, &second.handle, vec!["outline".into(), "minutes".into()])
      .await
      .unwrap();
    assert_eq!(
      reserve_intent(&restarted, &second.handle, "intent-1", &snapshot).unwrap(),
      ReserveResult::Existing {
        state: "result_unknown".into()
      }
    );
    close(&restarted, &h.cloud, &second.handle).await.unwrap();

    // waiting_auth: 同じ固定入力は再開、違う固定入力は記録された状態
    let (waiting, waiting_snapshot) = reserved(&h, "intent-w").await;
    mark_intent(&h.state, &waiting.handle, "intent-w", "waiting_auth").unwrap();
    close(&h.state, &h.cloud, &waiting.handle).await.unwrap();
    let resumed = open(&restarted, &h.cloud, request("intent-w", "local_full", Some("gemini")))
      .await
      .unwrap();
    read_material(&restarted, &resumed.handle, vec!["outline".into(), "minutes".into()])
      .await
      .unwrap();
    assert_eq!(
      reserve_intent(&restarted, &resumed.handle, "intent-w", &waiting_snapshot).unwrap(),
      ReserveResult::Resumed
    );
    mark_intent(&restarted, &resumed.handle, "intent-w", "waiting_auth").unwrap();
    close(&restarted, &h.cloud, &resumed.handle).await.unwrap();
    let other = open(&restarted, &h.cloud, request("intent-w", "local_full", Some("gemini")))
      .await
      .unwrap();
    read_material(&restarted, &other.handle, vec!["outline".into(), "minutes".into()])
      .await
      .unwrap();
    let changed = rehash(waiting_snapshot.clone(), |snapshot| {
      snapshot["consentVersion"] = json!("consent-v2")
    });
    assert_eq!(
      reserve_intent(&restarted, &other.handle, "intent-w", &changed).unwrap(),
      ReserveResult::Existing {
        state: "waiting_auth".into()
      }
    );
    close(&restarted, &h.cloud, &other.handle).await.unwrap();

    // dispatch の後の waiting_auth は再開しない（結果が分からない）・result_unknown は上書きしない
    let (sent, sent_snapshot) = reserved(&h, "intent-d").await;
    mark_dispatch(&h.state, &h.cloud, &sent.handle, "intent-d", "source")
      .await
      .unwrap();
    mark_intent(&h.state, &sent.handle, "intent-d", "result_unknown").unwrap();
    mark_intent(&h.state, &sent.handle, "intent-d", "completed").unwrap();
    close(&h.state, &h.cloud, &sent.handle).await.unwrap();
    let after = open(&h.state, &h.cloud, request("intent-d", "local_full", Some("gemini")))
      .await
      .unwrap();
    read_material(&h.state, &after.handle, vec!["outline".into(), "minutes".into()])
      .await
      .unwrap();
    assert_eq!(
      reserve_intent(&h.state, &after.handle, "intent-d", &sent_snapshot).unwrap(),
      ReserveResult::Existing {
        state: "result_unknown".into()
      }
    );

    // hash の改ざん・識別の不一致・intent の取り違えは断る
    let mut tampered = sent_snapshot.clone();
    tampered["consentVersion"] = json!("tampered");
    assert_eq!(
      reserve_intent(&h.state, &after.handle, "intent-d", &tampered)
        .err()
        .unwrap()
        .code,
      "personal_snapshot_invalid"
    );
    let other_owner = rehash(sent_snapshot.clone(), |snapshot| {
      snapshot["ownerAccountId"] = json!("b".repeat(64))
    });
    assert_eq!(
      reserve_intent(&h.state, &after.handle, "intent-d", &other_owner)
        .err()
        .unwrap()
        .code,
      "personal_snapshot_mismatch"
    );
    let other_recording = rehash(sent_snapshot.clone(), |snapshot| {
      snapshot["recordingId"] = json!("rec2")
    });
    assert_eq!(
      reserve_intent(&h.state, &after.handle, "intent-d", &other_recording)
        .err()
        .unwrap()
        .code,
      "personal_snapshot_mismatch"
    );
    assert_eq!(
      reserve_intent(&h.state, &after.handle, "intent-x", &sent_snapshot)
        .err()
        .unwrap()
        .code,
      "personal_intent_mismatch"
    );
    close(&h.state, &h.cloud, &after.handle).await.unwrap();
  });
}

#[test]
fn transcription_engine_fixes_the_gemini_connection_apart_from_the_model_connection() {
  let local = Route {
    kind: RouteKind::LocalFull,
    executor: None,
  };
  let generation = Route {
    kind: RouteKind::GenerationOnly,
    executor: Some(Executor::ThisPc),
  };
  // Gemini は方式が無ければサブスクリプション（以前と同じ固定値）、API キーだけ別のエンジン
  assert_eq!(
    parse_transcription(local, Some("gemini"), None).unwrap(),
    Some(Transcription::Gemini)
  );
  assert_eq!(
    parse_transcription(local, Some("gemini"), Some("subscription")).unwrap(),
    Some(Transcription::Gemini)
  );
  assert_eq!(
    parse_transcription(local, Some("gemini"), Some("apiKey")).unwrap(),
    Some(Transcription::GeminiApi)
  );
  assert_eq!(
    parse_transcription(local, Some("deepgram"), Some("apiKey")).unwrap(),
    Some(Transcription::Deepgram)
  );
  assert_eq!(
    parse_transcription(local, Some("this-mac"), None).unwrap(),
    Some(Transcription::ThisMac)
  );
  assert_eq!(parse_transcription(generation, None, None).unwrap(), None);
  // 方式の食い違いは受け付けない（Deepgram のサブスクリプション・この Mac の方式・知らない方式・後続だけの方式）
  for (provider, connection) in [
    (Some("deepgram"), Some("subscription")),
    (Some("this-mac"), Some("apiKey")),
    (Some("gemini"), Some("other")),
  ] {
    assert!(parse_transcription(local, provider, connection).is_err());
  }
  assert!(parse_transcription(generation, None, Some("apiKey")).is_err());
  assert_eq!(Transcription::GeminiApi.model_json()["connection"], "apiKey");
  assert!(Transcription::Gemini.model_json().get("connection").is_none());
}

#[test]
fn rust_derivations_match_the_shared_typescript_fixture() {
  let fixture: Value =
    serde_json::from_str(include_str!("../../test/fixtures/personal-snapshot-derivation.json")).unwrap();
  for sample in fixture["canonicalSamples"].as_array().unwrap() {
    assert_eq!(
      canonical(&sample["value"]).unwrap(),
      sample["canonical"].as_str().unwrap()
    );
  }
  assert_eq!(
    fixture["transcriptionModels"]["this-mac"],
    Transcription::ThisMac.model_json()
  );
  assert_eq!(
    fixture["transcriptionModels"]["gemini"],
    Transcription::Gemini.model_json()
  );
  assert_eq!(
    fixture["transcriptionModels"]["gemini-api"],
    Transcription::GeminiApi.model_json()
  );
  let original = fixture["original"].as_object().unwrap().clone();
  assert_eq!(
    snapshot_hash(&original).unwrap(),
    original["snapshotSha256"].as_str().unwrap()
  );
  let generation = derive_generation(&original, &fixture["sourceVersion"]).unwrap();
  assert_eq!(Value::Object(generation.clone()), fixture["generation"]);
  let next = derive_next_step(
    &generation,
    fixture["stepId"].as_str().unwrap(),
    &fixture["stepVersion"],
  )
  .unwrap();
  assert_eq!(Value::Object(next.clone()), fixture["nextStep"]);

  // 受け入れるのは、その operation の版による 2 つの派生だけ
  let source = Receipt {
    step_id: "source".into(),
    kind: CandidateKind::Source,
    version: fixture["sourceVersion"].clone(),
  };
  let step = Receipt {
    step_id: "outline".into(),
    kind: CandidateKind::Artifact,
    version: fixture["stepVersion"].clone(),
  };
  assert_eq!(
    accept_derived(&original, std::slice::from_ref(&source), &fixture["generation"]),
    Some(generation.clone())
  );
  assert_eq!(
    accept_derived(&generation, std::slice::from_ref(&step), &fixture["nextStep"]),
    Some(next)
  );
  // モデルを差し替えて hash を付け直した派生・hash だけ合わない派生・ほかの operation の版は受け入れない
  assert_eq!(
    accept_derived(&original, std::slice::from_ref(&source), &fixture["tampered"]),
    None
  );
  let mut forged = fixture["generation"].clone();
  forged["snapshotSha256"] = json!("0".repeat(64));
  assert_eq!(accept_derived(&original, std::slice::from_ref(&source), &forged), None);
  let mut other_version = fixture["sourceVersion"].clone();
  other_version["originRunId"] = json!("run-other");
  let other = Receipt {
    version: other_version,
    ..source
  };
  assert_eq!(
    accept_derived(&original, std::slice::from_ref(&other), &fixture["generation"]),
    None
  );
  assert_eq!(accept_derived(&original, &[], &fixture["generation"]), None);
}

#[test]
fn js_number_formatting_follows_number_to_string() {
  for (value, expected) in [
    (0.0, "0"),
    (-0.0, "0"),
    (5.7, "5.7"),
    (1e21, "1e+21"),
    (1e20, "100000000000000000000"),
    (1.5e-7, "1.5e-7"),
    (0.000001, "0.000001"),
    (-2.5e-12, "-2.5e-12"),
    (123456789.123, "123456789.123"),
  ] {
    assert_eq!(js_float(value), expected);
  }
  assert_eq!(
    canonical(&json!(9007199254740992_u64)),
    None,
    "JS で正確に表せない整数は断る"
  );
}

#[test]
fn material_tells_the_page_from_the_recording_reads_the_captured_store_and_verify_catches_changes() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("material", LeaseMode::Grant);
    // 録音 id をページ id として渡しても開かない（ページと録音は別物）
    let mut by_recording = request("i0", "local_full", Some("gemini"));
    by_recording.recording_page_id = "rec1".into();
    assert_eq!(
      open(&h.state, &h.cloud, by_recording).await.err().unwrap().code,
      "store_no_page"
    );
    // 別の保存先にある同じ id の録音（違う音声）は読まない
    let other_root = temp_dir("material-other-root");
    write_docs(&other_root, b"another-root-audio");

    let opened = open(&h.state, &h.cloud, request("i1", "local_full", Some("gemini")))
      .await
      .unwrap();
    let material = read_material(&h.state, &opened.handle, vec!["minutes".into()])
      .await
      .unwrap();
    assert_eq!(material["audio"][0]["path"], json!("recordings/rec1/inputs/a1.m4a"));
    assert_eq!(material["audio"][0]["sha256"], json!(sha(AUDIO)));
    assert_eq!(material["audio"][0]["bytes"], json!(AUDIO.len()));
    assert_eq!(material["audio"][0]["verification"], json!("native_sha256"));
    assert_eq!(material["audio"][0]["durationSec"], json!(5.712562358276644));
    assert_eq!(
      material["transcriptionModel"],
      json!({ "provider": "gemini", "model": GEMINI_TRANSCRIPTION_MODEL, "effort": GEMINI_TRANSCRIPTION_EFFORT })
    );
    assert_eq!(material["flow"]["id"], json!("flow-1"));
    assert_eq!(
      material["recordingMetadata"],
      json!({
        "speakers": "2", "language": "ja", "background": "朝市の取材", "sourceName": "文字起こし",
        "terms": [{ "term": "朝市", "reading": "あさいち", "variants": [], "note": "" }],
      })
    );
    assert_eq!(material["referencePages"][0]["pageId"], json!("ref1"));
    assert_eq!(material["referencePages"][0]["path"], json!("pages/ref1.md"));
    assert_eq!(material["referencePages"][0]["content"], json!("参考の本文"));
    assert_eq!(
      material["expectedCurrentArtifactShaByStep"],
      json!({ "minutes": null, "source": null }),
      "文字起こしをする経路は原文の照合値も持つ"
    );
    assert_eq!(material["sourceVersion"], Value::Null);
    assert_eq!(
      material["promptMaterials"]["referenceTitles"]["value"],
      json!([{ "pageId": "ref1", "title": "参考の文書" }])
    );
    assert_eq!(
      material["promptMaterials"]["info"]["value"]["entities"][0]["name"],
      json!("高浜")
    );
    assert!(is_sha256(
      material["promptMaterials"]["info"]["sha256"].as_str().unwrap()
    ));

    let snapshot = snapshot_from(
      &opened,
      &material,
      json!({ "kind": "local_full" }),
      Some("proj1"),
      "pg1",
      "rec1",
    );
    let verified = verify_inputs(&h.state, &opened.handle, &snapshot).unwrap();
    assert!(verified.verified, "{:?}", verified.reason);
    // path traversal の前工程・別の録音の版は通さない
    let traversal = rehash(snapshot.clone(), |snapshot| {
      snapshot["input"]["priorSteps"] = json!([{
        "stepId": "outline", "versionId": "v_x", "path": "recordings/rec1/versions/outline/../../../pages/ref1.md",
        "sha256": sha("参考の本文".as_bytes()), "bytes": "参考の本文".len(),
      }]);
    });
    assert!(!verify_inputs(&h.state, &opened.handle, &traversal).unwrap().verified);
    let foreign = rehash(snapshot.clone(), |snapshot| {
      snapshot["input"]["sourceVersion"] = json!({
        "versionId": "v_x", "path": "recordings/rec2/versions/source/v_x.md", "sha256": sha(b"x"), "bytes": 1,
        "originRunId": "run-x", "origin": "this_pc",
      });
    });
    assert!(!verify_inputs(&h.state, &opened.handle, &foreign).unwrap().verified);
    // 音声の中身が変わった・同じ中身でも別の実体に置き換わった
    let audio = h.rec_dir().join("inputs/a1.m4a");
    let mut changed = AUDIO.to_vec();
    changed[0] ^= 1;
    fs::write(&audio, &changed).unwrap();
    assert!(!verify_inputs(&h.state, &opened.handle, &snapshot).unwrap().verified);
    let swapped = h.rec_dir().join("inputs/swap.tmp");
    fs::write(&swapped, AUDIO).unwrap();
    fs::rename(&swapped, &audio).unwrap();
    assert!(!verify_inputs(&h.state, &opened.handle, &snapshot).unwrap().verified);
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    // recording.json に記録した hash と違う音声・リンクの音声は読まない
    fs::write(&audio, b"tampered audio").unwrap();
    let reopened = open(&h.state, &h.cloud, request("i2", "local_full", Some("gemini")))
      .await
      .unwrap();
    assert_eq!(
      read_material(&h.state, &reopened.handle, vec![])
        .await
        .err()
        .unwrap()
        .code,
      "personal_audio_changed"
    );
    fs::remove_file(&audio).unwrap();
    std::os::unix::fs::symlink(other_root.join("projects/proj1/recordings/rec1/inputs/a1.m4a"), &audio).unwrap();
    assert_eq!(
      read_material(&h.state, &reopened.handle, vec![])
        .await
        .err()
        .unwrap()
        .code,
      "store_symlink"
    );
    close(&h.state, &h.cloud, &reopened.handle).await.unwrap();

    // recording.json の id がページの録音と違えば開かない
    let file = h.rec_dir().join("recording.json");
    let mut recording: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    recording["id"] = json!("rec9");
    write_json(&file, &recording);
    assert_eq!(
      open(&h.state, &h.cloud, request("i3", "local_full", Some("gemini")))
        .await
        .err()
        .unwrap()
        .code,
      "store_no_recording"
    );

    // フォルダ外の録音（ページ opg・録音 orec）
    let outside = open(&h.state, &h.cloud, outside_request("i4")).await.unwrap();
    let material = read_material(&h.state, &outside.handle, vec![]).await.unwrap();
    assert_eq!(material["audio"][0]["path"], json!("recordings/orec/inputs/o1.m4a"));
    assert_eq!(material["audio"][0]["sha256"], json!(sha(OUTSIDE_AUDIO)));
    assert_eq!(
      material["transcriptionModel"],
      json!({ "provider": "this-mac", "model": THIS_MAC_TRANSCRIPTION_MODEL })
    );
    assert_eq!(material["recordingMetadata"]["background"], json!(""));
    close(&h.state, &h.cloud, &outside.handle).await.unwrap();
    let _ = fs::remove_dir_all(other_root);
  });
}

#[test]
fn candidates_are_immutable_idempotent_and_keep_whether_the_model_was_reported() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("candidate", LeaseMode::Grant);
    let (opened, _) = reserved(&h, "intent-c").await;
    let stored = persist_candidate(
      &h.state,
      &opened.handle,
      source_candidate("v_src1AAAAAAAAAAAAAAAAAA", "原文の候補"),
    )
    .unwrap();
    assert_eq!(
      stored["path"],
      json!("recordings/rec1/versions/source/v_src1AAAAAAAAAAAAAAAAAA.md")
    );
    assert_eq!(stored["sha256"], json!(sha("原文の候補".as_bytes())));
    assert!(stored.get("reportedModel").is_none(), "報告が無ければ出力にも無い");
    assert_eq!(
      fs::read_to_string(h.rec_dir().join("versions/source/v_src1AAAAAAAAAAAAAAAAAA.md")).unwrap(),
      "原文の候補"
    );
    assert!(!h.rec_dir().join("transcript.md").exists(), "現在本文は触らない");
    assert!(runs(&h).is_empty(), "runs.jsonl は触らない");
    // 同じ中身は冪等、違う中身は衝突
    persist_candidate(
      &h.state,
      &opened.handle,
      source_candidate("v_src1AAAAAAAAAAAAAAAAAA", "原文の候補"),
    )
    .unwrap();
    assert_eq!(
      persist_candidate(
        &h.state,
        &opened.handle,
        source_candidate("v_src1AAAAAAAAAAAAAAAAAA", "別の原文")
      )
      .err()
      .unwrap()
      .code,
      "personal_candidate_collision"
    );
    let mut reported_null = source_candidate("v_src2AAAAAAAAAAAAAAAAAA", "原文2");
    reported_null.reported_model = Some(Value::Null);
    assert_eq!(
      persist_candidate(&h.state, &opened.handle, reported_null).unwrap()["reportedModel"],
      Value::Null
    );
    let mut reported = artifact_candidate("outline", "v_out1AAAAAAAAAAAAAAAAAA", "要点");
    reported.reported_model = Some(json!("claude-sonnet-5-20261001"));
    assert_eq!(
      persist_candidate(&h.state, &opened.handle, reported).unwrap()["reportedModel"],
      json!("claude-sonnet-5-20261001")
    );
    // 固定したモデル・内容の hash・置き場所が違えば断る
    let wrong_model = candidate(
      "outline",
      "artifact",
      "v_out2AAAAAAAAAAAAAAAAAA",
      "要点",
      "gpt",
      json!("gpt-5.6-terra"),
    );
    assert_eq!(
      persist_candidate(&h.state, &opened.handle, wrong_model)
        .err()
        .unwrap()
        .code,
      "personal_candidate_mismatch"
    );
    let mut wrong_sha = artifact_candidate("outline", "v_out3AAAAAAAAAAAAAAAAAA", "要点");
    wrong_sha.sha256 = sha(b"other");
    assert_eq!(
      persist_candidate(&h.state, &opened.handle, wrong_sha)
        .err()
        .unwrap()
        .code,
      "personal_candidate_mismatch"
    );
    let mut traversal = artifact_candidate("outline", "v_out4AAAAAAAAAAAAAAAAAA", "要点");
    traversal.path = "recordings/rec1/versions/outline/../../transcript.md".into();
    assert_eq!(
      persist_candidate(&h.state, &opened.handle, traversal)
        .err()
        .unwrap()
        .code,
      "personal_path_not_allowed"
    );
    let mut other_recording = artifact_candidate("outline", "v_out5AAAAAAAAAAAAAAAAAA", "要点");
    other_recording.path = "recordings/orec/versions/outline/v_out5AAAAAAAAAAAAAAAAAA.md".into();
    assert_eq!(
      persist_candidate(&h.state, &opened.handle, other_recording)
        .err()
        .unwrap()
        .code,
      "personal_path_not_allowed"
    );
    // 数字だけの名前（旧形式の連番）・保管庫の版 ID でない名前・versionId と違うファイル名は書かない
    let mut numbered = artifact_candidate("outline", "v_out6AAAAAAAAAAAAAAAAAA", "要点");
    numbered.version_id = "1".into();
    numbered.path = "recordings/rec1/versions/outline/1.md".into();
    assert_eq!(
      persist_candidate(&h.state, &opened.handle, numbered)
        .err()
        .unwrap()
        .code,
      "personal_path_not_allowed"
    );
    let mut short = artifact_candidate("outline", "v_out7AAAAAAAAAAAAAAAAAA", "要点");
    short.version_id = "v_short".into();
    short.path = "recordings/rec1/versions/outline/v_short.md".into();
    assert_eq!(
      persist_candidate(&h.state, &opened.handle, short).err().unwrap().code,
      "personal_path_not_allowed"
    );
    let mut renamed = artifact_candidate("outline", "v_out8AAAAAAAAAAAAAAAAAA", "要点");
    renamed.path = format!("recordings/rec1/versions/outline/{}.md", vid("other"));
    assert_eq!(
      persist_candidate(&h.state, &opened.handle, renamed).err().unwrap().code,
      "personal_path_not_allowed"
    );
    assert!(!h.rec_dir().join("versions/outline/1.md").exists());
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn publish_writes_one_group_with_a_display_number_and_preserves_changed_document() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("publish", LeaseMode::Grant);
    // 版になっていない人の書きかけが、受付の時点の要点の本文
    fs::create_dir_all(h.rec_dir().join("artifacts")).unwrap();
    fs::write(h.rec_dir().join("artifacts/outline.md"), "人の書きかけ").unwrap();
    let (opened, snapshot) = reserved(&h, "intent-p").await;
    assert_eq!(
      snapshot["input"]["expectedCurrentArtifactShaByStep"]["outline"],
      json!(sha("人の書きかけ".as_bytes()))
    );
    persist_candidate(
      &h.state,
      &opened.handle,
      source_candidate("v_src1AAAAAAAAAAAAAAAAAA", "確定した原文"),
    )
    .unwrap();
    let op = operation_for(&h.state, &opened.handle).unwrap();
    let before = op.captured.vault_state("proj1").unwrap();
    let candidate_generation = before.dirty["recordings/rec1/versions/source/v_src1AAAAAAAAAAAAAAAAAA.md"];

    let committed = publish(
      &h.state,
      &h.cloud,
      &opened.handle,
      publish_input("intent-p", "source", "source", "v_src1AAAAAAAAAAAAAAAAAA", None),
    )
    .await
    .unwrap();
    assert_eq!(committed["status"], json!("committed"));
    assert_eq!(committed["displayVersion"], json!(1));
    assert_eq!(committed["localSaved"], json!(true));
    assert_eq!(committed["cloudAcked"], json!(false));
    let version = committed["version"].clone();
    assert_eq!(
      version,
      json!({
        "versionId": "v_src1AAAAAAAAAAAAAAAAAA", "path": "recordings/rec1/versions/source/v_src1AAAAAAAAAAAAAAAAAA.md",
        "sha256": sha("確定した原文".as_bytes()), "bytes": "確定した原文".len(),
        "originRunId": "run-intent-p", "origin": "this_pc",
      })
    );
    assert_eq!(
      fs::read_to_string(h.rec_dir().join("transcript.md")).unwrap(),
      "確定した原文"
    );
    let rows = runs(&h);
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row["version"], json!(1));
    assert_eq!(row["stepId"], json!("source"));
    assert_eq!(
      row["versionPath"],
      json!("recordings/rec1/versions/source/v_src1AAAAAAAAAAAAAAAAAA.md")
    );
    assert_eq!(row["versionSha256"], json!(sha("確定した原文".as_bytes())));
    assert_eq!(row["originDeviceId"], json!("d_test"));
    assert_eq!(row["personalRunId"], json!("run-intent-p"));
    assert_eq!(row["id"], json!("r6-event"), "personal runId は event id と別に持つ");
    assert_eq!(row["origin"], json!("this_pc"));
    assert_eq!(row["provider"], json!("gemini"));
    assert_eq!(row["model"], json!(GEMINI_TRANSCRIPTION_MODEL));
    assert_eq!(row["effort"], json!(GEMINI_TRANSCRIPTION_EFFORT));
    assert_eq!(row["inputBasisSha256"], snapshot["snapshotSha256"]);
    assert_eq!(row["result"], json!("saved"));
    let aggregate_path = h.rec_dir().join("personal-runs/run-intent-p.json");
    assert_eq!(
      serde_json::from_slice::<Value>(&fs::read(&aggregate_path).unwrap()).unwrap()["intentId"],
      json!("intent-p")
    );
    // 現在本文・runs.jsonl・集約が 1 つの保存単位（同じ保存の世代）で journal に入った
    let after = op.captured.vault_state("proj1").unwrap();
    let generation = after.dirty["recordings/rec1/transcript.md"];
    assert!(generation > candidate_generation);
    assert_eq!(after.dirty["recordings/rec1/runs.jsonl"], generation);
    assert_eq!(
      after.dirty["recordings/rec1/personal-runs/run-intent-p.json"],
      generation
    );

    // guard: この operation の版による派生だけを受け入れて進める
    let head = snapshot.as_object().unwrap().clone();
    let derived = Value::Object(derive_generation(&head, &version).unwrap());
    let checked = guard(
      &h.state,
      &h.cloud,
      &opened.handle,
      "before_dispatch",
      Some(derived.clone()),
    )
    .await
    .unwrap();
    assert_eq!(checked.snapshot_sha256, derived["snapshotSha256"].as_str().unwrap());
    let swapped_model = rehash(derived.clone(), |snapshot| {
      snapshot["fixedModels"]["outline"]["model"] = json!("claude-opus-5")
    });
    let refused = guard(
      &h.state,
      &h.cloud,
      &opened.handle,
      "before_dispatch",
      Some(swapped_model),
    )
    .await
    .unwrap();
    assert_eq!(
      refused.snapshot_sha256, checked.snapshot_sha256,
      "差し替えは受け入れず head のまま"
    );

    // 受付の後に人が書いた本文は自動の版に残し、AI の結果を今の本文にする
    fs::write(h.rec_dir().join("artifacts/minutes.md"), "人が後から書いた議事録").unwrap();
    persist_candidate(
      &h.state,
      &opened.handle,
      artifact_candidate("minutes", "v_min2AAAAAAAAAAAAAAAAAA", "AI の議事録"),
    )
    .unwrap();
    let changed = publish(
      &h.state,
      &h.cloud,
      &opened.handle,
      publish_input("intent-p", "minutes", "artifact", "v_min2AAAAAAAAAAAAAAAAAA", None),
    )
    .await
    .unwrap();
    assert_eq!(changed["status"], json!("committed"));
    assert_eq!(
      fs::read_to_string(h.rec_dir().join("artifacts/minutes.md")).unwrap(),
      "AI の議事録"
    );
    assert!(
      h.rec_dir()
        .join("versions/minutes/v_min2AAAAAAAAAAAAAAAAAA.md")
        .is_file(),
      "AI の版は残る"
    );
    assert_eq!(runs(&h).len(), 3);
    assert!(runs(&h).iter().any(|row| row["kind"] == "save" && row["auto"] == true));

    // 照合値は受け付けた固定入力に記録した値だけ（画面が別の値を渡しても通さない）
    persist_candidate(
      &h.state,
      &opened.handle,
      artifact_candidate("outline", "v_out1AAAAAAAAAAAAAAAAAA", "AI の要点"),
    )
    .unwrap();
    let forged = publish(
      &h.state,
      &h.cloud,
      &opened.handle,
      publish_input("intent-p", "outline", "artifact", "v_out1AAAAAAAAAAAAAAAAAA", None),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(forged.code, "personal_expected_mismatch");
    assert_eq!(
      fs::read_to_string(h.rec_dir().join("artifacts/outline.md")).unwrap(),
      "人の書きかけ"
    );

    // 照合が合えば、書きかけを「保存」の版として先に残してから候補を公開する（両方残る）
    let committed = publish(
      &h.state,
      &h.cloud,
      &opened.handle,
      publish_input(
        "intent-p",
        "outline",
        "artifact",
        "v_out1AAAAAAAAAAAAAAAAAA",
        Some(sha("人の書きかけ".as_bytes())),
      ),
    )
    .await
    .unwrap();
    assert_eq!(committed["status"], json!("committed"));
    assert_eq!(committed["displayVersion"], json!(2));
    let rows = runs(&h);
    assert_eq!(rows.len(), 5);
    assert_eq!(rows[3]["auto"], json!(true));
    assert_eq!(rows[3]["version"], json!(1));
    let auto_path = rows[3]["versionPath"].as_str().unwrap();
    assert_eq!(
      fs::read_to_string(h.root.join("projects/proj1").join(auto_path)).unwrap(),
      "人の書きかけ"
    );
    assert_eq!(rows[4]["version"], json!(2));
    assert_eq!(rows[4]["provider"], json!("claude"));
    assert_eq!(rows[4]["effort"], json!("high"));
    assert_eq!(
      fs::read_to_string(h.rec_dir().join("artifacts/outline.md")).unwrap(),
      "AI の要点"
    );

    // CAS を伴わない記録（取消など）は数値の版を付けない
    record(
      &h.state,
      &opened.handle,
      RecordWire {
        aggregate: aggregate("intent-p"),
        record: Some(
          json!({ "id": "r6-cancel", "kind": "run", "stepName": "実行", "version": 9, "result": "stopped" }),
        ),
        checkpoint: Some(RecordCheckpointWire {
          run_id: "r6-cancel".into(),
          value: json!({ "runId": "r6-cancel", "state": "stopped", "output": "途中" }),
        }),
      },
    )
    .unwrap();
    let rows = runs(&h);
    assert_eq!(rows.len(), 6);
    assert_eq!(rows[5]["version"], Value::Null);
    assert_eq!(rows[5]["personalRunId"], json!("run-intent-p"));
    assert_eq!(
      serde_json::from_slice::<Value>(&fs::read(h.rec_dir().join("runs/r6-cancel.json")).unwrap()).unwrap()["output"],
      json!("途中")
    );

    // 取消の後は公開しない
    cancel(&h.state, &opened.handle).unwrap();
    persist_candidate(
      &h.state,
      &opened.handle,
      artifact_candidate("minutes", "v_min1AAAAAAAAAAAAAAAAAA", "議事録"),
    )
    .unwrap();
    assert_eq!(
      publish(
        &h.state,
        &h.cloud,
        &opened.handle,
        publish_input("intent-p", "minutes", "artifact", "v_min1AAAAAAAAAAAAAAAAAA", None),
      )
      .await
      .err()
      .unwrap()
      .code,
      "personal_guard_failed"
    );
    assert_eq!(
      fs::read_to_string(h.rec_dir().join("artifacts/minutes.md")).unwrap(),
      "AI の議事録"
    );
    let guarded = guard(&h.state, &h.cloud, &opened.handle, "before_cas", None)
      .await
      .unwrap();
    assert!(guarded.cancelled);
    drop(op);
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

/// 画面が作る runId（`run_<22字>`）は大文字を含む。保存側が小文字だけの id しか通さないと、開始直後の最初の記録が
/// 「id が正しくありません。」で落ちる（このMacで文字起こしが始まらなかった不具合）。
#[test]
fn a_mixed_case_run_id_records_and_publishes() {
  const RUN_ID: &str = "run_CIQ4YvBnzEx63eEoovemwF";
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("mixed-case-run-id", LeaseMode::Grant);
    let (opened, _) = reserved_as(&h, "intent-m", RUN_ID).await;
    let mixed = || {
      let mut value = aggregate("intent-m");
      value["runId"] = json!(RUN_ID);
      value
    };

    // 開始直後の最初の記録（集約だけ）
    record(
      &h.state,
      &opened.handle,
      RecordWire {
        aggregate: mixed(),
        record: None,
        checkpoint: None,
      },
    )
    .unwrap();
    assert!(h.rec_dir().join(format!("personal-runs/{RUN_ID}.json")).is_file());

    // チェックポイントの id も同じ文字を通す
    record(
      &h.state,
      &opened.handle,
      RecordWire {
        aggregate: mixed(),
        record: Some(
          json!({ "id": "r6-Cancel_Ab", "kind": "run", "stepName": "実行", "version": 9, "result": "stopped" }),
        ),
        checkpoint: Some(RecordCheckpointWire {
          run_id: "r6-Cancel_Ab".into(),
          value: json!({ "runId": "r6-Cancel_Ab", "state": "stopped", "output": "途中" }),
        }),
      },
    )
    .unwrap();
    assert!(h.rec_dir().join("runs/r6-Cancel_Ab.json").is_file());
    let checkpoint = crate::store::Store::new(h.root.clone())
      .read_checkpoint_at(Some("proj1"), "rec1", "r6-Cancel_Ab")
      .unwrap()
      .unwrap();
    assert_eq!(checkpoint["output"], json!("途中"));

    // 公開（現在本文・runs.jsonl の行・集約）
    persist_candidate(
      &h.state,
      &opened.handle,
      source_candidate("v_src1AAAAAAAAAAAAAAAAAA", "確定した原文"),
    )
    .unwrap();
    let committed = publish(
      &h.state,
      &h.cloud,
      &opened.handle,
      PublishWire {
        aggregate: mixed(),
        ..publish_input("intent-m", "source", "source", "v_src1AAAAAAAAAAAAAAAAAA", None)
      },
    )
    .await
    .unwrap();
    assert_eq!(committed["status"], json!("committed"));
    assert_eq!(committed["version"]["originRunId"], json!(RUN_ID));
    assert!(h.rec_dir().join(format!("personal-runs/{RUN_ID}.json")).is_file());
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn publish_does_not_restore_a_deleted_target_or_step() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("deleted-publish-target", LeaseMode::Grant);
    fs::create_dir_all(h.rec_dir().join("artifacts")).unwrap();
    fs::write(h.rec_dir().join("artifacts/outline.md"), "人の書きかけ").unwrap();
    let (opened, _) = reserved(&h, "intent-deleted").await;
    persist_candidate(
      &h.state,
      &opened.handle,
      artifact_candidate("outline", "v_del1AAAAAAAAAAAAAAAAAA", "AI の要点"),
    )
    .unwrap();
    let current = h.rec_dir().join("artifacts/outline.md");
    fs::remove_file(&current).unwrap();
    let expected = Some(sha("人の書きかけ".as_bytes()));
    let deleted = publish(
      &h.state,
      &h.cloud,
      &opened.handle,
      publish_input(
        "intent-deleted",
        "outline",
        "artifact",
        "v_del1AAAAAAAAAAAAAAAAAA",
        expected.clone(),
      ),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(deleted.code, "personal_target_deleted");
    assert!(!current.exists());
    assert!(runs(&h).is_empty());

    fs::write(&current, "人の書きかけ").unwrap();
    let recording_path = h.rec_dir().join("recording.json");
    let mut recording: Value = serde_json::from_slice(&fs::read(&recording_path).unwrap()).unwrap();
    recording["flowSnapshot"]["steps"]
      .as_array_mut()
      .unwrap()
      .retain(|step| step["id"] != "outline");
    write_json(&recording_path, &recording);
    let removed_step = publish(
      &h.state,
      &h.cloud,
      &opened.handle,
      publish_input(
        "intent-deleted",
        "outline",
        "artifact",
        "v_del1AAAAAAAAAAAAAAAAAA",
        expected,
      ),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(removed_step.code, "personal_step_deleted");
    assert_eq!(fs::read_to_string(&current).unwrap(), "人の書きかけ");
    assert!(runs(&h).is_empty());
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn a_lost_lease_is_reported_as_a_different_lease_id() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("lease-lost", LeaseMode::Grant);
    let (opened, _) = reserved(&h, "intent-l").await;
    h.cloud.test_forget_lease("proj1").await;
    let checked = guard(&h.state, &h.cloud, &opened.handle, "before_dispatch", None)
      .await
      .unwrap();
    assert_ne!(checked.lease_id, opened.lease_id, "controller が LEASE_LOST にする");
    assert_eq!(
      mark_dispatch(&h.state, &h.cloud, &opened.handle, "intent-l", "source")
        .await
        .err()
        .unwrap()
        .code,
      "personal_guard_failed"
    );
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn the_send_time_guard_runs_the_provider_only_after_a_dispatch_marker_and_never_after_cancel() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("send", LeaseMode::Grant);
    let (opened, _) = reserved(&h, "intent-t").await;
    let send = |turn: &str| {
      run_turn_with(
        &h.state,
        &h.cloud,
        turn.to_string(),
        turn_request(),
        Some(opened.handle.clone()),
        channel(),
      )
    };
    assert_eq!(send("turn-0").await.err().unwrap().code, "personal_guard_failed");
    assert_eq!(
      h.runner.calls.load(Ordering::SeqCst),
      0,
      "dispatch marker の前は送らない"
    );
    mark_dispatch(&h.state, &h.cloud, &opened.handle, "intent-t", "outline")
      .await
      .unwrap();
    send("turn-1").await.unwrap();
    assert_eq!(h.runner.calls.load(Ordering::SeqCst), 1);

    // operation に束縛した job は、operation なし・ほかの operation では使えない
    let op = operation_for(&h.state, &opened.handle).unwrap();
    bind_job(&h.state, &opened.handle, &op, "job-1").unwrap();
    let part = |operation: Option<String>, job: &str| {
      transcribe_audio_part_with(
        &h.state,
        &h.cloud,
        "turn-part".into(),
        AudioPartRef {
          job_id: job.to_string(),
          file: 0,
          part: 0,
        },
        AudioPartRequestWire {
          provider: Provider::GeminiCli,
          model: GEMINI_TRANSCRIPTION_MODEL.into(),
          effort: None,
          system_prompt: "s".into(),
          user_prompt: "u".into(),
        },
        operation,
        channel(),
      )
    };
    assert_eq!(part(None, "job-1").await.err().unwrap().code, "personal_guard_failed");
    assert_eq!(
      part(Some(opened.handle.clone()), "job-2").await.err().unwrap().code,
      "personal_guard_failed"
    );

    cancel(&h.state, &opened.handle).unwrap();
    assert_eq!(send("turn-2").await.err().unwrap().code, "personal_guard_failed");
    assert_eq!(
      part(Some(opened.handle.clone()), "job-1").await.err().unwrap().code,
      "personal_guard_failed"
    );
    assert_eq!(h.runner.calls.load(Ordering::SeqCst), 1, "取消の後は送らない");
    drop(op);
    // operation に束縛して準備した音声は close 時に登録ごと消え、operation なしでは使えない
    h.state.audio_jobs.lock().unwrap().insert(
      "job-1".into(),
      Arc::new(PreparedAudio {
        dir: h.app.join("speech-parts/job-1"),
        files: Vec::new(),
        owner: Some(opened.handle.clone()),
      }),
    );
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert!(
      job_owner(&h.state, "job-1").is_none(),
      "close の後は operation 側から持ち主を引けない"
    );
    assert_eq!(part(None, "job-1").await.err().unwrap().code, "audio_not_prepared");
    assert_eq!(h.runner.calls.load(Ordering::SeqCst), 1, "close の後も送らない");

    // この Mac の文字起こし: 取り消した operation では sidecar を起動しない（job も残さない）
    let local = open(
      &h.state,
      &h.cloud,
      request("intent-m", "local_transcription_only", Some("this-mac")),
    )
    .await
    .unwrap();
    read_material(&h.state, &local.handle, vec![]).await.unwrap();
    cancel(&h.state, &local.handle).unwrap();
    let transcribed = transcribe_with(
      &h.state,
      &h.cloud,
      TranscribeRequest {
        job_id: "job-local".into(),
        project_id: Some("proj1".into()),
        recording_id: "rec1".into(),
        language: "ja".into(),
        speaker_mode: "2".into(),
        hints: json!([]),
      },
      Some(local.handle.clone()),
      channel(),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(transcribed.code, "personal_guard_failed");
    assert!(lock(&h.state.speech_jobs).is_empty());
    close(&h.state, &h.cloud, &local.handle).await.unwrap();
  });
}

#[test]
fn an_on_device_transcription_outside_folders_publishes_into_the_docs_root_recording() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("outside-publish", LeaseMode::Grant);
    let opened = open(&h.state, &h.cloud, outside_request("intent-o")).await.unwrap();
    let material = read_material(&h.state, &opened.handle, vec![]).await.unwrap();
    let snapshot = snapshot_from(
      &opened,
      &material,
      json!({ "kind": "local_transcription_only" }),
      None,
      "opg",
      "orec",
    );
    assert_eq!(
      reserve_intent(&h.state, &opened.handle, "intent-o", &snapshot).unwrap(),
      ReserveResult::New
    );
    let text = "フォルダ外の原文";
    let input = CandidateWire {
      step_id: "source".into(),
      artifact_id: "source".into(),
      kind: "source".into(),
      version_id: "v_out_srcAAAAAAAAAAAAAAA".into(),
      path: "recordings/orec/versions/source/v_out_srcAAAAAAAAAAAAAAA.md".into(),
      text: text.into(),
      provider: "this-mac".into(),
      model: json!(THIS_MAC_TRANSCRIPTION_MODEL),
      reported_model: None,
      sha256: sha(text.as_bytes()),
      bytes: text.len() as u64,
    };
    persist_candidate(&h.state, &opened.handle, input).unwrap();
    let mut publish_wire = publish_input("intent-o", "source", "source", "v_out_srcAAAAAAAAAAAAAAA", None);
    publish_wire.aggregate["recordingPageId"] = json!("opg");
    publish_wire.aggregate["recordingId"] = json!("orec");
    let committed = publish(&h.state, &h.cloud, &opened.handle, publish_wire).await.unwrap();
    assert_eq!(committed["status"], json!("committed"));
    assert_eq!(committed["displayVersion"], json!(1));
    let dir = h.root.join("recordings/orec");
    assert_eq!(fs::read_to_string(dir.join("transcript.md")).unwrap(), text);
    assert!(dir.join("personal-runs/run-intent-o.json").is_file());
    let op = operation_for(&h.state, &opened.handle).unwrap();
    let state = op.captured.vault_state(DOCS_ROOT_PROJECT_ID).unwrap();
    let generation = state.dirty["recordings/orec/transcript.md"];
    assert_eq!(state.dirty["recordings/orec/runs.jsonl"], generation);
    assert_eq!(
      state.dirty["recordings/orec/personal-runs/run-intent-o.json"],
      generation
    );
    drop(op);
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn a_transcript_candidate_publishes_into_its_own_artifact_and_feeds_later_steps_only_when_selected() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("transcript-candidate", LeaseMode::Grant);
    let dir = h.rec_dir();
    fs::write(dir.join("transcript.md"), "最初の文字起こし").unwrap();
    let recording_path = dir.join("recording.json");
    let mut recording: Value = serde_json::from_str(&fs::read_to_string(&recording_path).unwrap()).unwrap();
    let ledger = json!({
      "stepId": "source",
      "order": ["tx1", "tx2"],
      "items": {
        "tx1": { "id": "tx1", "artifactId": "source", "name": "Gemini", "createdAt": "2026-10-19T01:00:00.000Z" },
        "tx2": { "id": "tx2", "artifactId": "artifact-tx2", "name": "この Mac", "createdAt": "2026-10-19T01:00:00.000Z" },
      },
    });
    recording["candidateSets"] = json!({ "source": ledger.clone() });
    write_json(&recording_path, &recording);

    let target = json!({ "stepId": "source", "candidateId": "tx2", "artifactId": "artifact-tx2", "inputVersions": {} });
    let mut open_request = request("intent-tx2", "local_transcription_only", Some("this-mac"));
    open_request.output_target = Some(target.clone());
    let opened = open(&h.state, &h.cloud, open_request).await.unwrap();
    let material = read_material(&h.state, &opened.handle, vec![]).await.unwrap();
    // 照合値は別案の今の本文（まだ無い）。最初の文字起こしの本文ではない
    assert_eq!(material["expectedCurrentArtifactShaByStep"]["source"], Value::Null);
    let snapshot = rehash(
      snapshot_from(
        &opened,
        &material,
        json!({ "kind": "local_transcription_only" }),
        Some("proj1"),
        "pg1",
        "rec1",
      ),
      |snapshot| snapshot["outputTarget"] = target.clone(),
    );
    assert_eq!(
      reserve_intent(&h.state, &opened.handle, "intent-tx2", &snapshot).unwrap(),
      ReserveResult::New
    );
    let version = vid("transcriptAlt");
    let text = "[00:00:00] 連売の朝";
    let primary = candidate(
      "source",
      "source",
      &version,
      text,
      "this-mac",
      json!(THIS_MAC_TRANSCRIPTION_MODEL),
    );
    // 受付で固定した案以外（最初の案）の置き場へは書けない
    assert_eq!(
      persist_candidate(&h.state, &opened.handle, primary).unwrap_err().code,
      candidate_mismatch().code
    );
    let mut wire = candidate(
      "source",
      "source",
      &version,
      text,
      "this-mac",
      json!(THIS_MAC_TRANSCRIPTION_MODEL),
    );
    wire.artifact_id = "artifact-tx2".into();
    wire.path = format!("recordings/rec1/versions/artifact-tx2/{version}.md");
    persist_candidate(&h.state, &opened.handle, wire).unwrap();
    let publish_wire = || {
      let mut wire = publish_input("intent-tx2", "source", "source", &version, None);
      wire.artifact_id = "artifact-tx2".into();
      wire
    };

    // 台帳から消えた案へは、遅れて届いた結果を書いて戻さない
    let mut removed = recording.clone();
    removed["candidateSets"]["source"]["order"] = json!(["tx1"]);
    removed["candidateSets"]["source"]["items"] = json!({ "tx1": ledger["items"]["tx1"].clone() });
    write_json(&recording_path, &removed);
    let refused = publish(&h.state, &h.cloud, &opened.handle, publish_wire())
      .await
      .unwrap_err();
    assert_eq!(refused.code, "personal_target_deleted");
    assert!(!dir.join("artifacts/artifact-tx2.md").exists());

    write_json(&recording_path, &recording);
    let published = publish(&h.state, &h.cloud, &opened.handle, publish_wire())
      .await
      .unwrap();
    assert_eq!(published["status"], json!("committed"));
    assert_eq!(fs::read_to_string(dir.join("artifacts/artifact-tx2.md")).unwrap(), text);
    assert_eq!(
      fs::read_to_string(dir.join("transcript.md")).unwrap(),
      "最初の文字起こし"
    );
    let rows = runs(&h);
    let row = rows
      .iter()
      .find(|row| row.get("artifactId").and_then(Value::as_str) == Some("artifact-tx2"))
      .unwrap();
    assert_eq!(row["stepId"], json!("source"));
    assert_eq!(row["candidateId"], json!("tx2"));
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    // 後工程の原文は「後工程に使う」に指定した案の確定版。指定が無ければ最初の案、台帳に無い指定は断る
    let mut selected = recording.clone();
    selected["sourceCandidateId"] = json!("tx2");
    write_json(&recording_path, &selected);
    let generation = open(&h.state, &h.cloud, request("intent-gen-tx2", "generation_only", None))
      .await
      .unwrap();
    let material = read_material(&h.state, &generation.handle, vec!["outline".into()])
      .await
      .unwrap();
    assert_eq!(material["sourceArtifactId"], json!("artifact-tx2"));
    assert!(material["sourceVersion"]["path"]
      .as_str()
      .is_some_and(|path| path.starts_with("recordings/rec1/versions/artifact-tx2/")));
    assert_eq!(material["sourceVersion"]["content"], json!(text));
    close(&h.state, &h.cloud, &generation.handle).await.unwrap();

    let mut broken = recording.clone();
    broken["sourceCandidateId"] = json!("gone");
    write_json(&recording_path, &broken);
    let generation = open(&h.state, &h.cloud, request("intent-gen-gone", "generation_only", None))
      .await
      .unwrap();
    let error = read_material(&h.state, &generation.handle, vec!["outline".into()])
      .await
      .unwrap_err();
    assert_eq!(error.code, "source_candidate_missing");
    close(&h.state, &h.cloud, &generation.handle).await.unwrap();
  });
}

#[test]
fn a_candidate_publish_keeps_the_logical_step_and_writes_only_its_artifact() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("candidate-publish", LeaseMode::Grant);
    let dir = h.rec_dir();
    fs::create_dir_all(dir.join("artifacts")).unwrap();
    fs::write(dir.join("artifacts/outline.md"), "元の本文").unwrap();
    fs::write(dir.join("artifacts/article_alt.md"), "別案の書きかけ").unwrap();
    let target = json!({
      "stepId": "outline",
      "candidateId": "candidate_alt",
      "artifactId": "article_alt",
      "instruction": "若い読者向けにする",
      "inputVersions": { "source": 1 },
    });
    let mut open_request = request("intent-candidate", "generation_only", None);
    open_request.output_target = Some(target.clone());
    let opened = open(&h.state, &h.cloud, open_request).await.unwrap();
    let material = read_material(&h.state, &opened.handle, vec!["outline".into()])
      .await
      .unwrap();
    assert_eq!(
      material["expectedCurrentArtifactShaByStep"]["outline"],
      json!(sha("別案の書きかけ".as_bytes()))
    );
    let snapshot = rehash(
      snapshot_from(
        &opened,
        &material,
        json!({ "kind": "generation_only", "executor": "this_pc" }),
        Some("proj1"),
        "pg1",
        "rec1",
      ),
      |snapshot| snapshot["outputTarget"] = target.clone(),
    );
    assert_eq!(
      reserve_intent(&h.state, &opened.handle, "intent-candidate", &snapshot).unwrap(),
      ReserveResult::New
    );
    let version = vid("candidateAlt");
    let text = "## 新しい別案\n";
    let mut wire = artifact_candidate("outline", &version, text);
    wire.artifact_id = "article_alt".into();
    wire.path = format!("recordings/rec1/versions/article_alt/{version}.md");
    persist_candidate(&h.state, &opened.handle, wire).unwrap();
    let mut publish_wire = publish_input(
      "intent-candidate",
      "outline",
      "artifact",
      &version,
      Some(sha("別案の書きかけ".as_bytes())),
    );
    publish_wire.artifact_id = "article_alt".into();
    publish_wire.record = Some(json!({
      "id": "candidate-event", "kind": "run", "stepName": "要点の別案", "at": "2026-10-17T01:00:00.000Z",
    }));
    let published = publish(&h.state, &h.cloud, &opened.handle, publish_wire).await.unwrap();
    assert_eq!(published["status"], json!("committed"));
    assert_eq!(published["displayVersion"], json!(2));
    assert_eq!(
      fs::read_to_string(dir.join("artifacts/outline.md")).unwrap(),
      "元の本文"
    );
    assert_eq!(fs::read_to_string(dir.join("artifacts/article_alt.md")).unwrap(), text);
    let rows = runs(&h);
    let candidate_rows: Vec<&Value> = rows
      .iter()
      .filter(|row| row.get("artifactId").and_then(Value::as_str) == Some("article_alt"))
      .collect();
    assert_eq!(candidate_rows.len(), 2);
    assert!(candidate_rows.iter().all(|row| row["stepId"] == json!("outline")));
    assert!(candidate_rows
      .iter()
      .all(|row| row["candidateId"] == json!("candidate_alt")));
    assert!(candidate_rows
      .iter()
      .all(|row| row["instruction"] == json!("若い読者向けにする")));
    assert!(candidate_rows.iter().all(|row| {
      row["versionPath"]
        .as_str()
        .is_some_and(|path| path.contains("/versions/article_alt/"))
    }));
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn numbers_read_from_json_text_come_back_in_the_javascript_notation() {
  // JSON の文字列から読んだ値（Tauri の引数・recording.json）が、JS の JSON.stringify と同じ表記に戻る（float_roundtrip）
  for (text, expected) in [
    ("9909.206306751727", "9909.206306751727"),
    ("0.30000000000000004", "0.30000000000000004"),
    ("1.7976931348623157e308", "1.7976931348623157e+308"),
    ("5e-324", "5e-324"),
    ("2.2250738585072014e-308", "2.2250738585072014e-308"),
    ("123456.78901234567", "123456.78901234567"),
  ] {
    let value: Value = serde_json::from_str(text).unwrap();
    assert_eq!(canonical(&value).unwrap(), expected, "{text}");
  }
}

#[test]
fn a_hand_edited_transcript_or_a_legacy_recording_is_not_input_changed_when_nothing_changed() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("hand-edit", LeaseMode::Grant);
    // 版の原文の後に、人が文字起こしを手直しした（版になっていない）
    add_version(&h.rec_dir(), "source", &vid("orig"), 1, "元の原文", json!({}));
    fs::write(h.rec_dir().join("transcript.md"), "手直しした原文").unwrap();
    let (opened, snapshot) = reserved(&h, "intent-h").await;
    assert_eq!(
      snapshot["input"]["expectedCurrentArtifactShaByStep"]["source"],
      json!(sha("手直しした原文".as_bytes()))
    );
    persist_candidate(&h.state, &opened.handle, source_candidate(&vid("new1"), "新しい原文")).unwrap();
    let committed = publish(
      &h.state,
      &h.cloud,
      &opened.handle,
      publish_input(
        "intent-h",
        "source",
        "source",
        &vid("new1"),
        Some(sha("手直しした原文".as_bytes())),
      ),
    )
    .await
    .unwrap();
    assert_eq!(committed["status"], json!("committed"));
    assert_eq!(
      committed["displayVersion"],
      json!(3),
      "手直しは「保存」の版 2 として残る"
    );
    let rows = runs(&h);
    assert_eq!(rows[1]["auto"], json!(true));
    assert_eq!(
      fs::read_to_string(
        h.root
          .join("projects/proj1")
          .join(rows[1]["versionPath"].as_str().unwrap())
      )
      .unwrap(),
      "手直しした原文"
    );
    assert_eq!(
      fs::read_to_string(h.rec_dir().join("transcript.md")).unwrap(),
      "新しい原文"
    );
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    // versionPath の無い旧形式の録音（連番の版と、その行だけ）
    let dir = h.root.join("recordings/orec");
    fs::create_dir_all(dir.join("versions/source")).unwrap();
    fs::write(dir.join("versions/source/1.md"), "旧原文").unwrap();
    fs::write(dir.join("transcript.md"), "旧原文").unwrap();
    fs::write(
      dir.join("runs.jsonl"),
      "{\"id\":\"old-1\",\"kind\":\"run\",\"at\":\"2026-01-01T00:00:00.000Z\",\"stepId\":\"source\",\"stepName\":\"文字起こし\",\"version\":1,\"result\":\"saved\"}\n",
    )
    .unwrap();
    let outside = open(&h.state, &h.cloud, outside_request("intent-l")).await.unwrap();
    let material = read_material(&h.state, &outside.handle, vec![]).await.unwrap();
    assert_eq!(material["sourceVersion"], Value::Null);
    assert_eq!(
      material["expectedCurrentArtifactShaByStep"]["source"],
      json!(sha("旧原文".as_bytes()))
    );
    let snapshot = snapshot_from(
      &outside,
      &material,
      json!({ "kind": "local_transcription_only" }),
      None,
      "opg",
      "orec",
    );
    assert_eq!(
      reserve_intent(&h.state, &outside.handle, "intent-l", &snapshot).unwrap(),
      ReserveResult::New
    );
    let text = "この Mac の原文";
    persist_candidate(
      &h.state,
      &outside.handle,
      CandidateWire {
        step_id: "source".into(),
        artifact_id: "source".into(),
        kind: "source".into(),
        version_id: vid("legacy1"),
        path: format!("recordings/orec/versions/source/{}.md", vid("legacy1")),
        text: text.into(),
        provider: "this-mac".into(),
        model: json!(THIS_MAC_TRANSCRIPTION_MODEL),
        reported_model: None,
        sha256: sha(text.as_bytes()),
        bytes: text.len() as u64,
      },
    )
    .unwrap();
    let mut wire = publish_input(
      "intent-l",
      "source",
      "source",
      &vid("legacy1"),
      Some(sha("旧原文".as_bytes())),
    );
    wire.aggregate["recordingPageId"] = json!("opg");
    wire.aggregate["recordingId"] = json!("orec");
    let committed = publish(&h.state, &h.cloud, &outside.handle, wire).await.unwrap();
    assert_eq!(committed["status"], json!("committed"));
    assert_eq!(committed["displayVersion"], json!(2));
    assert_eq!(fs::read_to_string(dir.join("transcript.md")).unwrap(), text);
    close(&h.state, &h.cloud, &outside.handle).await.unwrap();
  });
}

#[test]
fn material_is_read_once_before_reserving_and_the_reserved_audio_must_be_the_audio_read() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("audio-bound", LeaseMode::Grant);
    let first = open(&h.state, &h.cloud, request("intent-a", "local_full", Some("gemini")))
      .await
      .unwrap();
    let material = read_material(&h.state, &first.handle, vec!["outline".into()])
      .await
      .unwrap();
    let snapshot = snapshot_from(
      &first,
      &material,
      json!({ "kind": "local_full" }),
      Some("proj1"),
      "pg1",
      "rec1",
    );
    // 受け付けた hash に入っていない音声を送れないよう、material で読んだ音声と完全に同じものだけを受け付ける
    let other_audio = rehash(snapshot.clone(), |snapshot| {
      snapshot["input"]["audio"][0]["sha256"] = json!(sha(b"other audio"))
    });
    assert_eq!(
      reserve_intent(&h.state, &first.handle, "intent-a", &other_audio)
        .err()
        .unwrap()
        .code,
      "personal_snapshot_mismatch"
    );
    let no_audio = rehash(snapshot.clone(), |snapshot| snapshot["input"]["audio"] = json!([]));
    assert_eq!(
      reserve_intent(&h.state, &first.handle, "intent-a", &no_audio)
        .err()
        .unwrap()
        .code,
      "personal_snapshot_mismatch"
    );
    assert_eq!(
      reserve_intent(&h.state, &first.handle, "intent-a", &snapshot).unwrap(),
      ReserveResult::New
    );
    // 受け付けた後は素材を読み直さない
    assert_eq!(
      read_material(&h.state, &first.handle, vec![]).await.err().unwrap().code,
      "personal_material_locked"
    );
    close(&h.state, &h.cloud, &first.handle).await.unwrap();
    // 素材を読んでいない operation は、音声の入った固定入力を受け付けない
    let second = open(&h.state, &h.cloud, request("intent-b", "local_full", Some("gemini")))
      .await
      .unwrap();
    let unread = rehash(snapshot, |snapshot| snapshot["recordingPageId"] = json!("pg1"));
    assert_eq!(
      reserve_intent(&h.state, &second.handle, "intent-b", &unread)
        .err()
        .unwrap()
        .code,
      "personal_snapshot_mismatch"
    );
    close(&h.state, &h.cloud, &second.handle).await.unwrap();
  });
}

#[test]
fn the_existing_lease_acquire_does_not_overwrite_a_personal_lease_taken_while_it_waited() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("lease-race", LeaseMode::Grant);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    *lock(&h.provider.gate) = Some((started_tx, release_rx));
    let (plain, opened) = join2(h.cloud.acquire_lease("proj1"), async {
      started_rx.await.unwrap();
      let opened = open(&h.state, &h.cloud, request("intent-race", "local_full", Some("gemini")))
        .await
        .unwrap();
      release_tx.send(()).unwrap();
      opened
    })
    .await;
    assert!(
      !plain.unwrap(),
      "この呼び出しで持った lease は無い（返り値の意味は今までどおり）"
    );
    assert!(
      h.cloud.owned_lease_alive("proj1", &opened.lease_id).await,
      "本人実行の lease を上書きしない"
    );
    assert_eq!(
      h.provider.released.load(Ordering::SeqCst),
      1,
      "待っている間に取った分は返した"
    );
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn close_waits_for_an_in_flight_write_and_no_write_starts_after_it() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("close-write", LeaseMode::Grant);
    let (opened, _) = reserved(&h, "intent-c").await;
    let op = operation_for(&h.state, &opened.handle).unwrap();
    let writing = begin_write(&op).unwrap();
    let lock_file = h.root.join("projects/proj1/.run.lock");
    let (closed, ()) = join2(close(&h.state, &h.cloud, &opened.handle), async {
      tokio::time::sleep(std::time::Duration::from_millis(60)).await;
      assert!(lock_file.exists(), "書き込みの途中はロックを返さない");
      assert!(
        h.cloud.test_has_lease("proj1").await,
        "書き込みの途中は lease を返さない"
      );
      assert_eq!(
        begin_write(&op).err().unwrap().code,
        "personal_operation_missing",
        "閉じ始めた後の書き込みは始まらない"
      );
      drop(writing);
    })
    .await;
    assert!(closed.unwrap().released);
    assert!(!lock_file.exists());
    assert!(!h.cloud.test_has_lease("proj1").await);
    drop(op);
    assert_eq!(
      persist_candidate(
        &h.state,
        &opened.handle,
        artifact_candidate("outline", &vid("after"), "要点")
      )
      .err()
      .unwrap()
      .code,
      "personal_operation_missing"
    );
    assert!(!h
      .rec_dir()
      .join(format!("versions/outline/{}.md", vid("after")))
      .exists());
  });
}

#[test]
fn intents_stay_outside_the_vault_namespace_when_the_docs_root_changes() {
  tauri::async_runtime::block_on(async {
    // NIHO に届かない端末内の文字起こし（lease なし。閉じても同期を予約しないので、保存先をすぐ変えられる）
    let h = Harness::signed_in("root-change", LeaseMode::Offline);
    let opened = open(
      &h.state,
      &h.cloud,
      request("intent-r", "local_transcription_only", Some("this-mac")),
    )
    .await
    .unwrap();
    let material = read_material(&h.state, &opened.handle, vec![]).await.unwrap();
    let snapshot = snapshot_from(
      &opened,
      &material,
      json!({ "kind": "local_transcription_only" }),
      Some("proj1"),
      "pg1",
      "rec1",
    );
    reserve_intent(&h.state, &opened.handle, "intent-r", &snapshot).unwrap();
    mark_dispatch(&h.state, &h.cloud, &opened.handle, "intent-r", "source")
      .await
      .unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    let intent = h
      .app
      .join(format!("personal-runs/{}/{}/intents/intent-r.json", h.key, h.root_id()));
    assert!(intent.is_file());
    let namespace = h.app.join(format!("vault/{}", h.key));
    fs::create_dir_all(&namespace).unwrap();
    fs::write(namespace.join("probe"), "x").unwrap();
    let other = temp_dir("root-change-other");
    h.cloud.commit_root_change(&other, || Ok(())).await.unwrap();
    assert!(
      !namespace.join("probe").exists(),
      "保存先の変更で vault/<accountKey> は退避される"
    );
    let file: Value = serde_json::from_slice(&fs::read(&intent).unwrap()).unwrap();
    assert_eq!(file["dispatches"][0]["terminal"], json!(false), "結果不明の印は残る");
    let _ = fs::remove_dir_all(other);
  });
}

#[test]
fn version_origins_follow_the_api_values_and_unknown_origins_are_not_used() {
  for (row, origin) in [
    (json!({ "origin": "LOCAL" }), Some("this_pc")),
    (json!({ "origin": "this_pc" }), Some("this_pc")),
    (json!({ "origin": "shared_mac" }), Some("shared_mac")),
    (json!({ "origin": "niho_api" }), Some("niho_api")),
    (json!({ "origin": "NIHO_API_SNAPSHOT" }), Some("niho_api")),
    (json!({}), Some("this_pc")),
    (json!({ "remoteRunId": "remote-1" }), Some("shared_mac")),
    (json!({ "origin": "cloud_x" }), None),
    (json!({ "origin": 1 }), None),
  ] {
    assert_eq!(origin_of(&row), origin, "{row}");
  }
  assert_eq!(
    origin_run_id(&json!({ "personalRunId": "p", "runId": "r", "id": "i" })),
    "p"
  );
  assert_eq!(origin_run_id(&json!({ "runId": "r", "id": "i" })), "r");
  assert_eq!(origin_run_id(&json!({ "id": "i" })), "i");

  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("origin", LeaseMode::Grant);
    let api_path = add_version(
      &h.rec_dir(),
      "source",
      &vid("api1"),
      1,
      "NIHO の原文",
      json!({ "origin": "NIHO_API_SNAPSHOT", "runId": "remote-1" }),
    );
    let route = json!({ "kind": "generation_only", "executor": "this_pc" });
    let opened = open(&h.state, &h.cloud, request("intent-g", "generation_only", None))
      .await
      .unwrap();
    let material = read_material(&h.state, &opened.handle, vec!["outline".into()])
      .await
      .unwrap();
    assert_eq!(material["sourceVersion"]["origin"], json!("niho_api"));
    assert_eq!(material["sourceVersion"]["originRunId"], json!("remote-1"));
    let base = snapshot_from(&opened, &material, route.clone(), Some("proj1"), "pg1", "rec1");
    let source_ref = |origin: &str, run: &str, path: &str, text: &str| {
      json!({
        "versionId": path.rsplit('/').next().unwrap().trim_end_matches(".md"), "path": path,
        "sha256": sha(text.as_bytes()), "bytes": text.len(), "originRunId": run, "origin": origin,
      })
    };
    let fixed = rehash(base.clone(), |snapshot| {
      snapshot["input"]["sourceVersion"] = source_ref("niho_api", "remote-1", &api_path, "NIHO の原文")
    });
    assert!(verify_inputs(&h.state, &opened.handle, &fixed).unwrap().verified);
    // NIHO API の原文を本人 Mac の原文として固定した入力は通さない
    let relabeled = rehash(base.clone(), |snapshot| {
      snapshot["input"]["sourceVersion"] = source_ref("this_pc", "remote-1", &api_path, "NIHO の原文")
    });
    let refused = verify_inputs(&h.state, &opened.handle, &relabeled).unwrap();
    assert!(!refused.verified);
    assert!(refused.reason.unwrap().contains("出どころ"));
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    // 知らない origin の版は固定入力に使わず、指定されても理由を返して断る
    let odd_path = add_version(
      &h.rec_dir(),
      "source",
      &vid("odd1"),
      2,
      "出どころ不明の原文",
      json!({ "origin": "cloud_x" }),
    );
    let reopened = open(&h.state, &h.cloud, request("intent-u", "generation_only", None))
      .await
      .unwrap();
    let material = read_material(&h.state, &reopened.handle, vec!["outline".into()])
      .await
      .unwrap();
    assert_eq!(material["sourceVersion"], Value::Null);
    let base = snapshot_from(&reopened, &material, route, Some("proj1"), "pg1", "rec1");
    let odd = rehash(base, |snapshot| {
      snapshot["input"]["sourceVersion"] = source_ref("this_pc", "run-2", &odd_path, "出どころ不明の原文")
    });
    let refused = verify_inputs(&h.state, &reopened.handle, &odd).unwrap();
    assert!(!refused.verified);
    assert_eq!(
      refused.reason.as_deref(),
      Some("原文の版の出どころを確かめられません。")
    );
    close(&h.state, &h.cloud, &reopened.handle).await.unwrap();
  });
}

// ---------------------------------------------------------------------------
// golden fixture（#18741 への受け渡し）: 実際の store_personal / personal_publish が書いたファイル

/// golden fixture の保存先 id（固定して、固定入力の hash を実行ごとに変えない）。
const GOLDEN_ROOT_ID: &str = "r_GoldenRootAAAAAAAAAAAA";
const GOLDEN_AT: &str = "2026-10-17T01:00:00.000Z";
/// 画面（personal-native.ts）の集約の originDeviceId。Native が runs.jsonl の行に書く device id と同じ値を渡す想定。
const GOLDEN_DEVICE: &str = "d_test";
const GOLDEN_FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/fixtures/personal-run-c1.json");

/// TS の eventIdFor（personal-execution.ts）と同じ: `r6-` ＋ canonical({intentId, stepId, state, versionId, remoteRunId, at}) の SHA-256。
fn golden_event_id(step: &str, state: &str, version_id: &str) -> String {
  let key = json!({
    "intentId": "intent-g", "stepId": step, "state": state, "versionId": version_id, "remoteRunId": null, "at": GOLDEN_AT,
  });
  format!("r6-{}", sha(canonical(&key).unwrap().as_bytes()))
}

/// TS の makeEvent が作る成功の event。
fn golden_event(step: &str, step_name: &str, state: &str, basis: &str, source: &Value, version: &Value) -> Value {
  json!({
    "schemaVersion": 1,
    "eventId": golden_event_id(step, state, version["versionId"].as_str().unwrap()),
    "runId": "run-intent-g",
    "originDeviceId": GOLDEN_DEVICE,
    "stepId": step,
    "stepName": step_name,
    "state": state,
    "at": GOLDEN_AT,
    "continuationOfRunId": null,
    "inputBasisSha256": basis,
    "sourceVersion": source,
    "version": version,
    "remoteRunId": null,
  })
}

/// TS の projectPersonalRunEvent と同じ写し（成功の event。数値の版は null で渡し、Native が採番する）。
fn golden_record(event: &Value) -> Value {
  let mut record = json!({
    "id": event["eventId"], "eventId": event["eventId"], "kind": "run", "at": event["at"], "stepId": event["stepId"],
    "stepName": event["stepName"], "version": null, "result": "saved", "originDeviceId": event["originDeviceId"],
    "inputBasisSha256": event["inputBasisSha256"],
  });
  if event["sourceVersion"].is_object() {
    record["sourceVersionId"] = event["sourceVersion"]["versionId"].clone();
    record["sourceVersionSha256"] = event["sourceVersion"]["sha256"].clone();
    record["sourceVersionPath"] = event["sourceVersion"]["path"].clone();
  }
  record["versionPath"] = event["version"]["path"].clone();
  record["versionSha256"] = event["version"]["sha256"].clone();
  record
}

/// TS の PersonalRunHistory（端末内の文字起こしから始めた実行の集約）。
fn golden_aggregate(basis: &str, source: &Value, versions: Vec<Value>, state: &str) -> Value {
  json!({
    "schemaVersion": 1,
    "runId": "run-intent-g",
    "intentId": "intent-g",
    "originDeviceId": GOLDEN_DEVICE,
    "recordingPageId": "pg1",
    "recordingId": "rec1",
    "origin": "this_pc",
    "continuationOfRunId": null,
    "basisSnapshotSha256": basis,
    "sourceVersion": source,
    "versions": versions,
    "retainedCandidates": [],
    "state": state,
    "transcriptionExecutions": 1,
    "remoteRunId": null,
    "remoteState": null,
    "at": GOLDEN_AT,
  })
}

fn golden_version(step: &str, version_id: &str, text: &str) -> Value {
  json!({
    "versionId": version_id,
    "path": format!("recordings/rec1/versions/{step}/{version_id}.md"),
    "sha256": sha(text.as_bytes()),
    "bytes": text.len(),
    "originRunId": "run-intent-g",
    "origin": "this_pc",
  })
}

fn numbered(version: &Value, published: &Value) -> Value {
  let mut version = version.clone();
  version["displayVersion"] = published["displayVersion"].clone();
  version
}

/// golden の比較。Native の書き込みを意図して変えたときだけ、apps/docs で
/// `NIHO_DOCS_UPDATE_GOLDEN=1 cargo test --locked -p niho_docs the_native_writer_output_matches_the_c1_fixture`
/// を実行して fixture を書き直し、差分が意図どおりかを確かめ、TS 側（`npm -C apps/docs test`、test/personal-run-fixture.test.ts）も
/// 通ることを確かめる（環境変数なしの通常の実行は照合だけで、fixture を書かない）。
fn assert_golden(actual: &Value) {
  let path = Path::new(GOLDEN_FIXTURE);
  if std::env::var_os("NIHO_DOCS_UPDATE_GOLDEN").is_some() {
    let mut text = serde_json::to_string_pretty(actual).unwrap();
    text.push('\n');
    fs::write(path, text).unwrap();
    return;
  }
  let text = fs::read_to_string(path).expect("golden fixture が無い（NIHO_DOCS_UPDATE_GOLDEN=1 で作る）");
  let expected: Value = serde_json::from_str(&text).unwrap();
  assert_eq!(
    actual, &expected,
    "Native の書き込みが golden fixture と違う（意図した変更なら NIHO_DOCS_UPDATE_GOLDEN=1 で書き直す）"
  );
}

/// 既にある原文の版・人が手を入れた現在本文（golden の `withExisting`。公開の前に「保存」の版を自動で残す）。
const GOLDEN_OLD_SOURCE: &str = "[00:00:01] 前の原文\n";
const GOLDEN_HUMAN_TRANSCRIPT: &str = "[00:00:01] 前の原文に人が手を入れた\n";
const GOLDEN_HUMAN_OUTLINE: &str = "人が書いた要点\n";

/// golden の 1 つのケース。`existing` は、原文の版（1）・版になっていない人の手直しの文字起こし・版の無い人の要点を置いてから、受付時の
/// 照合値（expected の sha）を付けて公開する（自動の「保存」の行と 2 以上の採番を実 writer で固定する）。
async fn golden_case(name: &str, existing: bool) -> Value {
  let h = Harness::signed_in_with_root(name, LeaseMode::Grant, Some(GOLDEN_ROOT_ID));
  assert_eq!(h.root_id(), GOLDEN_ROOT_ID);
  if existing {
    add_version(
      &h.rec_dir(),
      "source",
      &vid("goldenOldSource"),
      1,
      GOLDEN_OLD_SOURCE,
      json!({ "origin": "LOCAL" }),
    );
    fs::write(h.rec_dir().join("transcript.md"), GOLDEN_HUMAN_TRANSCRIPT).unwrap();
    fs::create_dir_all(h.rec_dir().join("artifacts")).unwrap();
    fs::write(h.rec_dir().join("artifacts/outline.md"), GOLDEN_HUMAN_OUTLINE).unwrap();
  }
  let opened = open(&h.state, &h.cloud, request("intent-g", "local_full", Some("this-mac")))
    .await
    .unwrap();
  let material = read_material(&h.state, &opened.handle, vec!["outline".into()])
    .await
    .unwrap();
  let s0 = rehash(
    snapshot_from(
      &opened,
      &material,
      json!({ "kind": "local_full" }),
      Some("proj1"),
      "pg1",
      "rec1",
    ),
    |snapshot| snapshot["stepNames"] = json!({ "outline": "要点" }),
  );
  assert_eq!(
    reserve_intent(&h.state, &opened.handle, "intent-g", &s0).unwrap(),
    ReserveResult::New
  );
  let s0_sha = s0["snapshotSha256"].as_str().unwrap().to_string();
  // 受け付けた固定入力に記録した照合値（今の本文の sha。無ければ null）を付けて公開する
  let expected = |key: &str| {
    s0["input"]["expectedCurrentArtifactShaByStep"][key]
      .as_str()
      .map(str::to_string)
  };
  if existing {
    assert_eq!(expected("source"), Some(sha(GOLDEN_HUMAN_TRANSCRIPT.as_bytes())));
    assert_eq!(expected("outline"), Some(sha(GOLDEN_HUMAN_OUTLINE.as_bytes())));
  } else {
    assert_eq!((expected("source"), expected("outline")), (None, None));
  }
  let aggregate_file = h.rec_dir().join("personal-runs/run-intent-g.json");
  let read_aggregate = || serde_json::from_slice::<Value>(&fs::read(&aggregate_file).unwrap()).unwrap();

  // 工程 1: この Mac の文字起こし（実モデルの報告は無い＝null）
  let source_id = vid("goldenSource");
  let source_text = "[00:00:01] 朝市に出して三年目です\n";
  let mut source_wire = candidate(
    "source",
    "source",
    &source_id,
    source_text,
    "this-mac",
    json!(THIS_MAC_TRANSCRIPTION_MODEL),
  );
  source_wire.reported_model = Some(Value::Null);
  persist_candidate(&h.state, &opened.handle, source_wire).unwrap();
  let source_ref = golden_version("source", &source_id, source_text);
  let event_source = golden_event(
    "source",
    "文字起こし",
    "transcription_complete",
    &s0_sha,
    &source_ref,
    &source_ref,
  );
  let record_source = golden_record(&event_source);
  let aggregate_source = golden_aggregate(&s0_sha, &source_ref, vec![source_ref.clone()], "running");
  let published_source = publish(
    &h.state,
    &h.cloud,
    &opened.handle,
    PublishWire {
      intent_id: "intent-g".into(),
      step_id: "source".into(),
      artifact_id: "source".into(),
      kind: "source".into(),
      candidate_version_id: source_id.clone(),
      expected_current_sha: expected("source"),
      aggregate: aggregate_source.clone(),
      record: Some(record_source.clone()),
    },
  )
  .await
  .unwrap();
  assert_eq!(published_source["status"], json!("committed"));
  let aggregate_after_source = read_aggregate();

  // 原文の確定の後の派生（TS の generationSnapshot）を guard が受け入れる
  let s1 = Value::Object(derive_generation(s0.as_object().unwrap(), &published_source["version"]).unwrap());
  let checked = guard(&h.state, &h.cloud, &opened.handle, "before_dispatch", Some(s1.clone()))
    .await
    .unwrap();
  let s1_sha = s1["snapshotSha256"].as_str().unwrap().to_string();
  assert_eq!(checked.snapshot_sha256, s1_sha);

  // 工程 2: 要点（Claude。実モデルの報告あり）。runner の実行の詳細（personal-native.ts が足す欄）は行に残る
  let outline_id = vid("goldenOutline");
  let outline_text = "## 要点\n\n- 朝市に出して3年目\n";
  let mut outline_wire = artifact_candidate("outline", &outline_id, outline_text);
  outline_wire.reported_model = Some(json!("claude-sonnet-5"));
  persist_candidate(&h.state, &opened.handle, outline_wire).unwrap();
  let outline_ref = golden_version("outline", &outline_id, outline_text);
  let source_numbered = numbered(&source_ref, &published_source);
  let event_outline = golden_event("outline", "要点", "completed", &s1_sha, &source_numbered, &outline_ref);
  let mut record_outline = golden_record(&event_outline);
  for (key, value) in [
    ("connection", json!("subscription")),
    ("durationMs", json!(1234)),
    ("inputChars", json!(321)),
    ("outputChars", json!(17)),
    ("tokensKnown", json!(true)),
    ("inputTokens", json!(100)),
    ("outputTokens", json!(50)),
    ("continuations", json!(0)),
  ] {
    record_outline[key] = value;
  }
  let aggregate_outline = golden_aggregate(
    &s0_sha,
    &source_numbered,
    vec![source_numbered.clone(), outline_ref.clone()],
    "running",
  );
  let published_outline = publish(
    &h.state,
    &h.cloud,
    &opened.handle,
    PublishWire {
      intent_id: "intent-g".into(),
      step_id: "outline".into(),
      artifact_id: "outline".into(),
      kind: "artifact".into(),
      candidate_version_id: outline_id.clone(),
      expected_current_sha: expected("outline"),
      aggregate: aggregate_outline.clone(),
      record: Some(record_outline.clone()),
    },
  )
  .await
  .unwrap();
  assert_eq!(published_outline["status"], json!("committed"));
  let aggregate_after_outline = read_aggregate();

  // 最後に controller が書く完了の集約（personal_record。runs.jsonl の行は無し）
  let aggregate_final = golden_aggregate(
    &s0_sha,
    &source_numbered,
    vec![source_numbered.clone(), numbered(&outline_ref, &published_outline)],
    "completed",
  );
  record(
    &h.state,
    &opened.handle,
    RecordWire {
      aggregate: aggregate_final.clone(),
      record: None,
      checkpoint: None,
    },
  )
  .unwrap();
  mark_intent(&h.state, &opened.handle, "intent-g", "completed").unwrap();
  close(&h.state, &h.cloud, &opened.handle).await.unwrap();

  // runs.jsonl の行・集約・返り値の数値の版は同じ（Native の採番。画面だけの番号を作らない）
  let mut rows = runs(&h);
  for (published, step) in [(&published_source, "source"), (&published_outline, "outline")] {
    let path = published["version"]["path"].as_str().unwrap();
    let row = rows
      .iter()
      .find(|row| row["versionPath"].as_str() == Some(path))
      .unwrap();
    assert_eq!(row["version"], published["displayVersion"]);
    assert_eq!(row["stepId"], json!(step));
  }
  assert_eq!(
    aggregate_after_source["versions"][0]["displayVersion"],
    published_source["displayVersion"]
  );
  assert_eq!(
    aggregate_after_source["sourceVersion"]["displayVersion"],
    published_source["displayVersion"]
  );
  assert_eq!(
    aggregate_after_outline["versions"][1]["displayVersion"],
    published_outline["displayVersion"]
  );
  if existing {
    // 原文: 前の版 1 → 人の手直しの「保存」2 → 公開 3。要点: 人の本文の「保存」1 → 公開 2
    assert_eq!(published_source["displayVersion"], json!(3));
    assert_eq!(published_outline["displayVersion"], json!(2));
  }

  // 版のファイル（自動の「保存」の版は名前と行の id が乱数なので、中身と sha を確かめてから決まった名前に置き換える）
  let mut files = Map::new();
  for step in ["source", "outline"] {
    for entry in fs::read_dir(h.rec_dir().join("versions").join(step)).unwrap() {
      let entry = entry.unwrap();
      let file_name = entry.file_name().into_string().unwrap();
      files.insert(
        format!("recordings/rec1/versions/{step}/{file_name}"),
        Value::from(fs::read_to_string(entry.path()).unwrap()),
      );
    }
  }
  for row in rows.iter_mut().filter(|row| row["auto"] == json!(true)) {
    let step = row["stepId"].as_str().unwrap().to_string();
    let path = row["versionPath"].as_str().unwrap().to_string();
    assert!(row["id"].as_str().unwrap().starts_with("save-"));
    let content = files.remove(&path).expect("自動の「保存」の版のファイル");
    assert_eq!(
      sha(content.as_str().unwrap().as_bytes()),
      row["versionSha256"].as_str().unwrap()
    );
    let placeholder = format!("recordings/rec1/versions/{step}/<auto>.md");
    row["id"] = json!("save-<auto>");
    row["versionPath"] = json!(placeholder.clone());
    files.insert(placeholder, content);
  }
  for relative in ["transcript.md", "artifacts/outline.md"] {
    files.insert(
      format!("recordings/rec1/{relative}"),
      Value::from(fs::read_to_string(h.rec_dir().join(relative)).unwrap()),
    );
  }

  json!({
    "setup": if existing {
      json!({
        "previousSourceVersion": GOLDEN_OLD_SOURCE,
        "currentBodies": { "source": GOLDEN_HUMAN_TRANSCRIPT, "outline": GOLDEN_HUMAN_OUTLINE },
      })
    } else {
      json!({ "previousSourceVersion": null, "currentBodies": {} })
    },
    "identity": {
      "ownerAccountId": h.key,
      "rootId": GOLDEN_ROOT_ID,
      "projectId": "proj1",
      "recordingPageId": "pg1",
      "recordingId": "rec1",
      "intentId": "intent-g",
      "runId": "run-intent-g",
      "nativeDeviceId": "d_test",
    },
    "inputs": {
      "snapshotSha256": [s0_sha, s1_sha],
      "expectedCurrentSha": { "source": expected("source"), "outline": expected("outline") },
      "events": [event_source, event_outline],
      "records": [record_source, record_outline],
      "aggregates": [aggregate_source, aggregate_outline, aggregate_final],
    },
    "outputs": {
      "published": [published_source, published_outline],
      "files": files,
      "runs": rows,
      "aggregates": [aggregate_after_source, aggregate_after_outline, read_aggregate()],
    },
  })
}

#[test]
fn the_native_writer_output_matches_the_c1_fixture() {
  tauri::async_runtime::block_on(async {
    let actual = json!({
      "description": "本人 Mac 実行（R6 #18739）の Native writer（store_personal.rs / personal_run.rs の personal_publish・personal_record）が実際に書いたファイル。fresh は何も無い録音、withExisting は前の原文の版・人の手直しの現在本文がある録音（自動の「保存」の版と 2 以上の採番）。自動の「保存」の版の乱数の名前と行の id は <auto> に置き換えている。personal_run_tests.rs の golden test が生成・照合し、TS は test/personal-run-fixture.test.ts で読む。",
      "cases": {
        "fresh": golden_case("golden-fresh", false).await,
        "withExisting": golden_case("golden-existing", true).await,
      },
    });
    assert_golden(&actual);
  });
}

fn audio_part_request() -> AudioPartRequestWire {
  AudioPartRequestWire {
    provider: Provider::GeminiCli,
    model: GEMINI_TRANSCRIPTION_MODEL.into(),
    effort: None,
    system_prompt: "s".into(),
    user_prompt: "u".into(),
  }
}

/// prepare_audio が作るのと同じ形の準備（区切りの WAV の置き場所と区切り 1 つ）。
fn prepared_files(dir: &Path) -> Vec<crate::speech::PreparedFile> {
  fs::create_dir_all(dir).unwrap();
  fs::write(dir.join("f0.wav"), b"wav").unwrap();
  vec![crate::speech::PreparedFile {
    wav: dir.join("f0.wav"),
    duration_sec: 95.0,
    bounds: vec![(0.0, 48.0)],
    sound_sec: vec![48.0],
  }]
}

#[test]
fn audio_prepared_for_an_operation_is_never_sent_without_it_even_after_close() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("prepared-owner", LeaseMode::Grant);
    let (opened, _) = reserved(&h, "intent-pa").await;
    let op = operation_for(&h.state, &opened.handle).unwrap();
    bind_job(&h.state, &opened.handle, &op, "job-pa").unwrap();
    let dir = h.app.join("speech-parts/job-pa");
    register_prepared_audio(
      &h.state,
      "job-pa".into(),
      dir.clone(),
      prepared_files(&dir),
      Some((opened.handle.as_str(), op.as_ref())),
    )
    .unwrap();
    drop(op);
    let send_without = |job: &str| {
      transcribe_audio_part_with(
        &h.state,
        &h.cloud,
        "turn-pa".into(),
        AudioPartRef {
          job_id: job.to_string(),
          file: 0,
          part: 0,
        },
        audio_part_request(),
        None,
        channel(),
      )
    };
    assert_eq!(
      send_without("job-pa").await.err().unwrap().code,
      "personal_guard_failed"
    );

    // 閉じたら、その operation で準備した登録と WAV を消す
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert!(!lock(&h.state.audio_jobs).contains_key("job-pa"));
    assert!(!dir.exists());
    assert_eq!(
      send_without("job-pa").await.err().unwrap().code,
      "audio_not_prepared",
      "準備が消えたので送れない"
    );

    // 閉じた後に準備が終わった（取消・閉じるの後の登録）: 登録せず WAV を消す
    let late = h.app.join("speech-parts/job-late");
    let closed_op = {
      let reopened = open(&h.state, &h.cloud, request("intent-pb", "local_full", Some("gemini")))
        .await
        .unwrap();
      let op = operation_for(&h.state, &reopened.handle).unwrap();
      close(&h.state, &h.cloud, &reopened.handle).await.unwrap();
      (reopened.handle, op)
    };
    assert_eq!(
      register_prepared_audio(
        &h.state,
        "job-late".into(),
        late.clone(),
        prepared_files(&late),
        Some((closed_op.0.as_str(), closed_op.1.as_ref())),
      )
      .err()
      .unwrap()
      .code,
      "personal_guard_failed"
    );
    assert!(!late.exists());
    assert!(!lock(&h.state.audio_jobs).contains_key("job-late"));
    // 何かの経路で持ち主つきの登録が残っていても、operation なしでは送らない
    let stale = h.app.join("speech-parts/job-stale");
    lock(&h.state.audio_jobs).insert(
      "job-stale".into(),
      Arc::new(crate::PreparedAudio {
        dir: stale.clone(),
        files: prepared_files(&stale),
        owner: Some(closed_op.0.clone()),
      }),
    );
    assert_eq!(
      send_without("job-stale").await.err().unwrap().code,
      "personal_guard_failed"
    );
    assert_eq!(h.runner.calls.load(Ordering::SeqCst), 0);
  });
}

#[test]
fn an_intent_reserved_but_never_sent_resumes_after_a_restart_or_close_but_not_while_held() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("resume-reserved", LeaseMode::Grant);
    let (first, snapshot) = reserved(&h, "intent-q").await;
    // 受け付けたまま送らずに閉じた（アプリが終わった）
    close(&h.state, &h.cloud, &first.handle).await.unwrap();
    let second = open(&h.state, &h.cloud, request("intent-q", "local_full", Some("gemini")))
      .await
      .unwrap();
    read_material(&h.state, &second.handle, vec!["outline".into(), "minutes".into()])
      .await
      .unwrap();
    assert_eq!(
      reserve_intent(&h.state, &second.handle, "intent-q", &snapshot).unwrap(),
      ReserveResult::Resumed
    );
    // 開いている operation が受け付けている間は二重の受付
    assert_eq!(
      reserve_intent(&h.state, &second.handle, "intent-q", &snapshot).unwrap(),
      ReserveResult::Existing {
        state: "running".into()
      }
    );
    close(&h.state, &h.cloud, &second.handle).await.unwrap();

    // 再起動（新しい AppState）: 違う固定入力は再開しない、同じ固定入力は再開する
    let restarted = h.restart_state();
    let third = open(&restarted, &h.cloud, request("intent-q", "local_full", Some("gemini")))
      .await
      .unwrap();
    read_material(&restarted, &third.handle, vec!["outline".into(), "minutes".into()])
      .await
      .unwrap();
    let changed = rehash(snapshot.clone(), |snapshot| {
      snapshot["consentVersion"] = json!("consent-v2")
    });
    assert_eq!(
      reserve_intent(&restarted, &third.handle, "intent-q", &changed).unwrap(),
      ReserveResult::Existing {
        state: "running".into()
      }
    );
    assert_eq!(
      reserve_intent(&restarted, &third.handle, "intent-q", &snapshot).unwrap(),
      ReserveResult::Resumed
    );
    // marker を書いた後に終わったものは、今までどおり結果不明（送り直さない）
    mark_dispatch(&restarted, &h.cloud, &third.handle, "intent-q", "source")
      .await
      .unwrap();
    close(&restarted, &h.cloud, &third.handle).await.unwrap();
    let fourth = open(&restarted, &h.cloud, request("intent-q", "local_full", Some("gemini")))
      .await
      .unwrap();
    read_material(&restarted, &fourth.handle, vec!["outline".into(), "minutes".into()])
      .await
      .unwrap();
    assert_eq!(
      reserve_intent(&restarted, &fourth.handle, "intent-q", &snapshot).unwrap(),
      ReserveResult::Existing {
        state: "result_unknown".into()
      }
    );
    close(&restarted, &h.cloud, &fourth.handle).await.unwrap();
  });
}

#[test]
fn publish_rechecks_cancel_and_close_after_the_lease_await_and_writes_nothing() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("publish-race", LeaseMode::Grant);
    let (opened, _) = reserved(&h, "intent-x").await;
    persist_candidate(&h.state, &opened.handle, source_candidate(&vid("race1"), "原文")).unwrap();
    // lease の確認の await の途中で取り消す
    let hold = h.cloud.test_hold_leases().await;
    let (published, ()) = join2(
      publish(
        &h.state,
        &h.cloud,
        &opened.handle,
        publish_input("intent-x", "source", "source", &vid("race1"), None),
      ),
      async {
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        cancel(&h.state, &opened.handle).unwrap();
        drop(hold);
      },
    )
    .await;
    assert_eq!(published.err().unwrap().code, "personal_guard_failed");
    assert!(
      !h.rec_dir().join("transcript.md").exists(),
      "取消の後に現在本文へ反映しない"
    );
    assert!(runs(&h).is_empty());
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    // lease の確認の await の途中で閉じる（close は公開の終わりを待ち、公開は書かずに終わる）
    let (reopened, _) = reserved(&h, "intent-y").await;
    persist_candidate(&h.state, &reopened.handle, source_candidate(&vid("race2"), "原文")).unwrap();
    let hold = h.cloud.test_hold_leases().await;
    let (published, closed) = join2(
      publish(
        &h.state,
        &h.cloud,
        &reopened.handle,
        publish_input("intent-y", "source", "source", &vid("race2"), None),
      ),
      async {
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        let (closed, ()) = join2(close(&h.state, &h.cloud, &reopened.handle), async {
          tokio::time::sleep(std::time::Duration::from_millis(40)).await;
          drop(hold);
        })
        .await;
        closed
      },
    )
    .await;
    assert_eq!(published.err().unwrap().code, "personal_guard_failed");
    assert!(closed.unwrap().released);
    assert!(
      !h.rec_dir().join("transcript.md").exists(),
      "閉じた後に現在本文へ反映しない"
    );
    assert!(runs(&h).is_empty());
  });
}

#[test]
fn versions_written_before_a_root_recording_moved_are_read_as_this_recordings_versions() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("migrated-root", LeaseMode::Grant);
    // P6 の移行で recordings/rec1/ へ移った旧 root の録音: 版は移った先にあるが、行の versionPath は頭の無い移行前の形
    let dir = h.rec_dir();
    let source_id = vid("mig1");
    let outline_id = vid("mig2");
    for (step, id, text) in [
      ("source", &source_id, "移行前の原文"),
      ("outline", &outline_id, "移行前の要点"),
    ] {
      fs::create_dir_all(dir.join("versions").join(step)).unwrap();
      fs::write(dir.join(format!("versions/{step}/{id}.md")), text).unwrap();
    }
    let rows = [
      json!({ "id": "run-1", "kind": "run", "at": "2026-01-01T00:00:01.000Z", "stepId": "source", "stepName": "文字起こし",
        "version": 1, "result": "saved", "versionPath": format!("versions/source/{source_id}.md") }),
      json!({ "id": "run-2", "kind": "run", "at": "2026-01-01T00:00:02.000Z", "stepId": "outline", "stepName": "要点",
        "version": 1, "result": "saved", "versionPath": format!("versions/outline/{outline_id}.md") }),
    ];
    let text: String = rows.iter().map(|row| format!("{row}\n")).collect();
    fs::write(dir.join("runs.jsonl"), text).unwrap();

    let opened = open(&h.state, &h.cloud, request("intent-m", "generation_only", None))
      .await
      .unwrap();
    let material = read_material(&h.state, &opened.handle, vec!["minutes".into()])
      .await
      .unwrap();
    let source_path = format!("recordings/rec1/versions/source/{source_id}.md");
    let outline_path = format!("recordings/rec1/versions/outline/{outline_id}.md");
    assert_eq!(material["sourceVersion"]["path"], json!(source_path));
    assert_eq!(material["sourceVersion"]["content"], json!("移行前の原文"));
    assert_eq!(material["sourceVersion"]["originRunId"], json!("run-1"));
    assert_eq!(material["priorSteps"][0]["path"], json!(outline_path));
    let snapshot = rehash(
      snapshot_from(
        &opened,
        &material,
        json!({ "kind": "generation_only", "executor": "this_pc" }),
        Some("proj1"),
        "pg1",
        "rec1",
      ),
      |snapshot| {
        snapshot["input"]["sourceVersion"] = json!({
          "versionId": source_id, "path": source_path, "sha256": sha("移行前の原文".as_bytes()),
          "bytes": "移行前の原文".len(), "originRunId": "run-1", "origin": "this_pc",
        });
        snapshot["input"]["priorSteps"] = json!([{
          "stepId": "outline", "versionId": outline_id, "path": outline_path,
          "sha256": sha("移行前の要点".as_bytes()), "bytes": "移行前の要点".len(),
        }]);
      },
    );
    let verified = verify_inputs(&h.state, &opened.handle, &snapshot).unwrap();
    assert!(verified.verified, "{:?}", verified.reason);
    // path traversal は版として読まない
    let traversal = rehash(snapshot.clone(), |snapshot| {
      snapshot["input"]["priorSteps"][0]["path"] = json!("versions/outline/../../../pages/ref1.md")
    });
    assert!(!verify_inputs(&h.state, &opened.handle, &traversal).unwrap().verified);
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    // 別の録音の頭の版を指す行は、この録音の版として読まない
    let other_id = vid("other1");
    fs::create_dir_all(h.root.join("recordings/orec/versions/source")).unwrap();
    fs::write(
      h.root.join(format!("recordings/orec/versions/source/{other_id}.md")),
      "別の録音",
    )
    .unwrap();
    let mut runs_text = fs::read_to_string(dir.join("runs.jsonl")).unwrap();
    runs_text.push_str(&format!(
      "{}\n",
      json!({ "id": "run-3", "kind": "run", "at": "2026-01-01T00:00:03.000Z", "stepId": "source", "stepName": "文字起こし",
        "version": 2, "result": "saved", "versionPath": format!("recordings/orec/versions/source/{other_id}.md") })
    ));
    fs::write(dir.join("runs.jsonl"), runs_text).unwrap();
    let again = open(&h.state, &h.cloud, request("intent-n", "generation_only", None))
      .await
      .unwrap();
    let material = read_material(&h.state, &again.handle, vec!["minutes".into()])
      .await
      .unwrap();
    assert_eq!(material["sourceVersion"], Value::Null);
    close(&h.state, &h.cloud, &again.handle).await.unwrap();
  });
}

#[test]
fn a_migrated_recordings_old_headless_version_paths_are_still_read_and_verified() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("migrated-path", LeaseMode::Grant);
    // P6 の移行前に書いた行: versionPath に録音の頭が無い（`versions/<stepId>/<name>.md`）
    let name = vid("mig1");
    let old_path = format!("versions/source/{name}.md");
    add_version(
      &h.rec_dir(),
      "source",
      &name,
      1,
      "移行前の原文",
      json!({ "versionPath": old_path, "runId": "run-old" }),
    );
    let opened = open(&h.state, &h.cloud, request("intent-m", "generation_only", None))
      .await
      .unwrap();
    let material = read_material(&h.state, &opened.handle, vec!["outline".into()])
      .await
      .unwrap();
    let current = format!("recordings/rec1/versions/source/{name}.md");
    assert_eq!(material["sourceVersion"]["content"], json!("移行前の原文"));
    assert_eq!(material["sourceVersion"]["origin"], json!("this_pc"));
    assert_eq!(
      material["sourceVersion"]["path"],
      json!(current),
      "画面へは今の頭つきの path で返す（固定入力の path の検査が頭を要る）"
    );
    // 頭つきの path で固定した入力の検証が、移行前の行（版の中身・出どころ）を見つける
    let route = json!({ "kind": "generation_only", "executor": "this_pc" });
    let base = snapshot_from(&opened, &material, route, Some("proj1"), "pg1", "rec1");
    assert!(
      verify_inputs(&h.state, &opened.handle, &base).unwrap().verified,
      "{:?}",
      verify_inputs(&h.state, &opened.handle, &base).unwrap().reason
    );
    // 別の工程・別の録音の頭の path は、この録音の版として読まない
    let op = operation_for(&h.state, &opened.handle).unwrap();
    let store = op.captured.store();
    let rec = store.personal_recording(Some("proj1"), "pg1", "rec1").unwrap();
    assert!(store.personal_read_version(&rec, "source", &current).unwrap().is_some());
    assert!(store
      .personal_read_version(&rec, "source", &old_path)
      .unwrap()
      .is_some());
    assert!(store
      .personal_read_version(&rec, "source", &format!("recordings/other/versions/source/{name}.md"))
      .is_err());
    assert!(store.personal_read_version(&rec, "outline", &old_path).is_err());
    drop(op);
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}
