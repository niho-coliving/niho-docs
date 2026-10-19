//! personal_niho.rs のテスト。通信はしない: 本物の AccountService を偽の HttpClient（ID token だけ返す）で動かし、同期する口は
//! 偽の provider（lease と manifest の版だけ答える）、NIHO API は偽のサーバー（要求を記録し、決めた応答を返す）。

use super::*;
use crate::contract::{
  ClaudeUpdate, EventSink, LlmRunner, MaintenanceError, Provider, ProviderStatus, ProviderUsage, TurnHandle,
  TurnRequest,
};
use niho_desktop_account::http::HttpFuture;
use niho_desktop_account::store::{AccountStore, StoredAccount};
use niho_desktop_account::test_support::{api_error, json_response, network_error, FakeHttp, MemorySecretStore};
use niho_desktop_account::{AccountService, ClientId, EnvKind, Environment, Secret, SecretKind, ServiceConfig};
use niho_desktop_vault::{
  account_key, bind_root, root_binding, save_state, CommitRequest, CommitResponse, FileKind, Lease, Manifest,
  ManifestFile, ProjectSummary, ProviderKind, ProviderSettings, Usage, VaultProvider,
};
use std::collections::VecDeque;
use std::sync::atomic::AtomicU64;

const CONSENT: &str = "2026-10-16-v1";
const SOURCE_TEXT: &str = "確定した原文です。\n朝市の取材。\n";
const REVISION: u64 = 7;

fn temp_dir(name: &str) -> PathBuf {
  let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
    "niho-docs-niho-{name}-{}-{}",
    std::process::id(),
    crate::process::hex(&crate::process::random_bytes::<4>().unwrap())
  ));
  fs::create_dir_all(&dir).unwrap();
  dir
}

fn sha(bytes: &[u8]) -> String {
  sha256_hex(bytes)
}

fn source_vid() -> String {
  format!("v_{:A<22}", "src")
}

fn source_path(rec: &str) -> String {
  format!("recordings/{rec}/versions/source/{}.md", source_vid())
}

// ---------------------------------------------------------------------------
// アカウント（ID token だけ返す）

/// 保存済みの接続から「ログイン済み」に戻す（`Send`。偽のサーバーの中からも切り替えられる）。
struct Login {
  account: Arc<AccountService>,
  secrets: Arc<MemorySecretStore>,
  dir: PathBuf,
}

impl Login {
  fn as_user(&self, user_id: &str) {
    AccountStore::new(self.dir.clone())
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
    self.secrets.put(SecretKind::RefreshToken, Secret::new("refresh-token"));
    self.account.restore();
  }
}

fn signed_account(app: &Path) -> (Arc<Login>, Arc<FakeHttp>) {
  let secrets = Arc::new(MemorySecretStore::new());
  let http = Arc::new(FakeHttp::new());
  http.respond(|request| {
    if request.url.contains("auth/app-connect/refresh") {
      Ok(json_response(200, &json!({ "customToken": "custom-token" })))
    } else if request.url.contains("signInWithCustomToken") {
      Ok(json_response(
        200,
        &json!({ "idToken": "secret-id-token", "refreshToken": "r", "expiresIn": "3600" }),
      ))
    } else {
      Err(network_error())
    }
  });
  let dir = app.join("account");
  let account = Arc::new(AccountService::new(ServiceConfig::new(
    Environment::new(ClientId::Docs, EnvKind::Prod, "test-api-key"),
    secrets.clone(),
    http.clone(),
    dir.clone(),
    "テストの Mac",
  )));
  (Arc::new(Login { account, secrets, dir }), http)
}

// ---------------------------------------------------------------------------
// 同期する口（lease と manifest の版だけ）

struct FakeVault {
  /// クラウドの manifest の版（None は通信できない）。
  revision: Mutex<Option<u64>>,
}

fn offline<T>() -> std::result::Result<T, VaultError> {
  Err(VaultError::Offline("test".into()))
}

#[async_trait::async_trait]
impl VaultProvider for FakeVault {
  /// 背景の同期を走らせない。`close` が lease を返すと `SyncReason::Now` の同期が背景で始まり、provider が local でなければ engine は
  /// 走査して dirty を保存してから通信で落ちる。テストが一時的に作って消すファイル（artifacts/）を拾うと、消した後も
  /// `partial_saved` の判定が残って、`steps_mismatch` を期待する検査が時々落ちる。local の provider は走査の前に返る。
  fn is_local(&self) -> bool {
    true
  }
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
  async fn get_project(&self, project_id: &str) -> std::result::Result<Manifest, VaultError> {
    let revision = (*lock(&self.revision)).ok_or_else(|| VaultError::Offline("test".into()))?;
    let mut manifest = Manifest::empty(project_id);
    manifest.revision = revision;
    Ok(manifest)
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
    _project_id: &str,
    _device_id: &str,
    _device_name: &str,
    _lease_id: Option<&str>,
  ) -> std::result::Result<Lease, VaultError> {
    Ok(Lease {
      lease_id: "cloud-lease-1".into(),
      expires_at: (chrono::Utc::now() + chrono::Duration::minutes(10)).to_rfc3339(),
    })
  }
  async fn renew_lease(&self, _project_id: &str, _lease_id: &str) -> std::result::Result<Lease, VaultError> {
    offline()
  }
  async fn release_lease(&self, _project_id: &str, _lease_id: &str) -> std::result::Result<(), VaultError> {
    Ok(())
  }
  async fn usage(&self) -> std::result::Result<Usage, VaultError> {
    offline()
  }
}

/// 呼ばれない runner（NIHO API への受付は工程の AI を動かさない）。
struct NoRunner;

impl LlmRunner for NoRunner {
  fn run_turn(&self, _request: TurnRequest, _on_event: EventSink) -> Arc<dyn TurnHandle> {
    panic!("NIHO API への受付は工程の AI を動かさない")
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

// ---------------------------------------------------------------------------
// NIHO API（偽のサーバー）

#[derive(Clone)]
enum Post {
  /// 受け付けて run の view を返す（同じキーは同じ run）
  Accept,
  /// 受け付けたが応答が届かない
  AcceptLost,
  /// 受け付けて、応答の view を書き換えて返す
  AcceptWith(fn(&mut Value)),
  Respond(u16, Value),
  Network,
}

enum Look {
  /// 受け付けた run があれば 200、無ければ 404
  Normal,
  Respond(u16, Value),
}

type PostHook = Box<dyn Fn(&HttpRequest) + Send + Sync>;
type ListHook = Box<dyn Fn() + Send + Sync>;

struct FakeServer {
  requests: Mutex<Vec<HttpRequest>>,
  posts: Mutex<VecDeque<Post>>,
  looks: Mutex<VecDeque<Look>>,
  access: Mutex<(u16, Value)>,
  /// 録音の run の一覧（GET /api/me/docs-runs?…）の応答。
  listed: Mutex<(u16, Value)>,
  accepted: Mutex<HashMap<String, Value>>,
  on_post: Mutex<Option<PostHook>>,
  on_list: Mutex<Option<ListHook>>,
  /// 入れると、POST の応答を `add_permits` まで返さない（要求の記録はすぐ）。
  post_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
  next_run: AtomicU64,
}

fn access_api() -> Value {
  json!({
    "payer": "NIHO", "externalDestination": "Vertex AI", "provider": "GOOGLE", "model": "gemini-3.8-flash",
    "consentVersion": CONSENT, "available": true, "reasonCode": null, "maxRunCostMicrousd": "120000",
    "maxOutputTokensPerCall": 8192, "executorReasonCode": null,
  })
}

impl FakeServer {
  fn new() -> Arc<Self> {
    Arc::new(Self {
      requests: Mutex::new(Vec::new()),
      posts: Mutex::new(VecDeque::new()),
      looks: Mutex::new(VecDeque::new()),
      access: Mutex::new((200, access_api())),
      listed: Mutex::new((200, json!({ "runs": [] }))),
      accepted: Mutex::new(HashMap::new()),
      on_post: Mutex::new(None),
      on_list: Mutex::new(None),
      post_gate: Mutex::new(None),
      next_run: AtomicU64::new(1),
    })
  }

  fn lists(&self) -> usize {
    lock(&self.requests)
      .iter()
      .filter(|request| request.method == HttpMethod::Get && request.url.contains("/docs-runs?"))
      .count()
  }

  fn view(body: &Value, run_id: &str) -> Value {
    json!({
      "runId": run_id, "state": "queued", "containerRef": body["containerRef"], "recordingPageId": body["recordingPageId"],
      "recordingId": body["recordingId"], "currentProjectRevision": body["baseRevision"], "transcriptionExecutor": null,
      "generationExecutor": "niho_api", "baseRevision": body["baseRevision"], "steps": [], "artifactVersions": [],
    })
  }

  fn run_id(&self) -> String {
    format!("cmrun{:08}", self.next_run.fetch_add(1, Ordering::SeqCst))
  }

  fn post(&self, mode: Post) {
    lock(&self.posts).push_back(mode);
  }

  fn look(&self, mode: Look) {
    lock(&self.looks).push_back(mode);
  }

  fn set_access(&self, change: fn(&mut Value)) {
    let mut access = lock(&self.access);
    *access = (200, access_api());
    change(&mut access.1);
  }

  fn posted(&self) -> Vec<HttpRequest> {
    lock(&self.requests)
      .iter()
      .filter(|request| request.method == HttpMethod::Post)
      .cloned()
      .collect()
  }

  fn lookups(&self) -> usize {
    lock(&self.requests)
      .iter()
      .filter(|request| request.url.contains("/submissions/"))
      .count()
  }

  fn count(&self) -> usize {
    lock(&self.requests).len()
  }

  fn handle(&self, request: &HttpRequest) -> std::result::Result<HttpResponse, HttpError> {
    let url = Url::parse(&request.url).unwrap();
    assert_eq!(
      url.host_str(),
      Some("niho.life"),
      "ログインしている環境の API だけへ送る"
    );
    assert_eq!(request.header_value("authorization"), Some("Bearer secret-id-token"));
    let path = url.path().to_string();
    match (request.method, path.as_str()) {
      (HttpMethod::Get, "/api/me/docs-runs/api-access") => {
        let (status, api) = lock(&self.access).clone();
        // 失敗の応答は保存した本文をそのまま返す（`{ error: { code, details } }` を試せるように）
        let body = if status >= 400 {
          api
        } else {
          json!({ "api": api, "sharedSpeech": { "available": false } })
        };
        Ok(json_response(status, &body))
      }
      (HttpMethod::Get, "/api/me/docs-runs") => {
        if let Some(hook) = lock(&self.on_list).as_ref() {
          hook();
        }
        let (status, runs) = lock(&self.listed).clone();
        Ok(json_response(status, &runs))
      }
      (HttpMethod::Post, "/api/me/docs-runs") => {
        if let Some(hook) = lock(&self.on_post).as_ref() {
          hook(request);
        }
        let key = request.header_value("Idempotency-Key").unwrap().to_string();
        let body: Value = serde_json::from_slice(request.body.as_ref().unwrap()).unwrap();
        let mode = lock(&self.posts).pop_front().unwrap_or(Post::Accept);
        let accept = || {
          let mut accepted = lock(&self.accepted);
          if let Some(view) = accepted.get(&key) {
            return view.clone();
          }
          let view = Self::view(&body, &self.run_id());
          accepted.insert(key.clone(), view.clone());
          view
        };
        match mode {
          Post::Accept => Ok(json_response(200, &accept())),
          Post::AcceptLost => {
            accept();
            Err(network_error())
          }
          Post::AcceptWith(change) => {
            let mut view = accept();
            change(&mut view);
            Ok(json_response(200, &view))
          }
          Post::Respond(status, value) => Ok(json_response(status, &value)),
          Post::Network => Err(network_error()),
        }
      }
      (HttpMethod::Get, path) if path.starts_with("/api/me/docs-runs/submissions/") => {
        let key = path.rsplit('/').next().unwrap();
        match lock(&self.looks).pop_front().unwrap_or(Look::Normal) {
          Look::Normal => match lock(&self.accepted).get(key) {
            Some(view) => Ok(json_response(200, view)),
            None => Ok(api_error(404, "NOT_FOUND", Some("not_found"))),
          },
          Look::Respond(status, value) => Ok(json_response(status, &value)),
        }
      }
      _ => panic!("想定外の要求 {request:?}"),
    }
  }
}

impl HttpClient for FakeServer {
  fn send(&self, request: HttpRequest) -> HttpFuture<'_> {
    lock(&self.requests).push(request.clone());
    let gate = (request.method == HttpMethod::Post)
      .then(|| lock(&self.post_gate).clone())
      .flatten();
    let response = self.handle(&request);
    Box::pin(async move {
      if let Some(gate) = gate {
        if let Ok(permit) = gate.acquire().await {
          permit.forget();
        }
      }
      response
    })
  }
}

// ---------------------------------------------------------------------------
// 保存先と同期の状態

/// 録音の工程（Mac で作った録音を、押した時に NIHO の AI へ持ち替えた後の固定モデル。工程の provider は作った時のまま）。
fn flow_snapshot() -> Value {
  let model = json!({
    "provider": "gemini", "model": "gemini-3.8-flash", "effort": "low", "profileId": "standard", "profileName": "NIHO API",
    "connection": "apiKey",
  });
  json!({
    "version": 1, "id": "flow-1", "name": "議事録", "revision": 3, "guide": "固有名詞を守る", "terms": [], "samples": [],
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

/// 録音のフォルダに、本人 Mac で確定した原文の版・今の文字起こし・runs.jsonl の行を置く。
fn write_recording(dir: &Path, id: &str, page: &str, refs: Value) {
  let at = "2026-10-17T00:00:00.000Z";
  write_json(
    &dir.join("recording.json"),
    &json!({
      "version": 1, "id": id, "pageId": page, "createdAt": at, "flowSnapshot": flow_snapshot(),
      "info": { "speakers": "2", "language": "ja" },
      "source": { "kind": "audio", "audio": [{ "file": "a1.m4a", "hash": sha(b"audio"), "name": "a.m4a", "durationSec": 5 }] },
      "refs": refs,
    }),
  );
  fs::create_dir_all(dir.join("versions/source")).unwrap();
  fs::write(dir.join(format!("versions/source/{}.md", source_vid())), SOURCE_TEXT).unwrap();
  fs::write(dir.join("transcript.md"), SOURCE_TEXT).unwrap();
  let row = json!({
    "id": "run-src", "kind": "run", "at": at, "stepId": "source", "stepName": "文字起こし", "version": 1, "result": "saved",
    "versionPath": source_path(id), "versionSha256": sha(SOURCE_TEXT.as_bytes()), "origin": "LOCAL", "personalRunId": "run-src",
  });
  fs::write(
    dir.join("runs.jsonl"),
    format!("{}\n", serde_json::to_string(&row).unwrap()),
  )
  .unwrap();
}

/// 保存先: フォルダ `proj1` の録音（ページ `pg1`・録音 `rec1`・参考 `ref1`）と、フォルダ外の録音（ページ `opg`・録音 `orec`）。
fn write_docs(root: &Path) {
  let at = "2026-10-17T00:00:00.000Z";
  write_json(
    &root.join("projects/proj1/project.json"),
    &json!({
      "version": 1, "id": "proj1", "name": "案件", "createdAt": at,
      "info": { "terms": [], "background": "朝市の取材" },
      "pages": {
        "version": 1, "order": ["pg1", "ref1"],
        "items": {
          "pg1": { "kind": "recording", "title": "録音", "createdAt": at, "recordingId": "rec1" },
          "ref1": { "kind": "document", "title": "参考の文書", "createdAt": at },
        },
      },
    }),
  );
  fs::create_dir_all(root.join("projects/proj1/pages")).unwrap();
  fs::write(root.join("projects/proj1/pages/ref1.md"), "参考の本文").unwrap();
  write_recording(
    &root.join("projects/proj1/recordings/rec1"),
    "rec1",
    "pg1",
    json!(["ref1"]),
  );
  write_json(
    &root.join("pages.json"),
    &json!({
      "version": 1, "order": ["opg"],
      "items": { "opg": { "kind": "recording", "title": "", "createdAt": at, "recordingId": "orec" } },
    }),
  );
  write_recording(&root.join("recordings/orec"), "orec", "opg", json!([]));
}

fn manifest_file(path: &str, bytes: &[u8]) -> ManifestFile {
  ManifestFile {
    path: path.to_string(),
    sha256: sha(bytes),
    bytes: bytes.len() as u64,
    kind: FileKind::from_path(path),
    modified_at: "2026-10-17T00:00:00.000Z".into(),
    writer_device_id: "d_other".into(),
    writer_device_kind: None,
    retained_until: None,
    available: true,
  }
}

type VaultChange = Box<dyn FnOnce(&mut VaultState)>;

fn change(change: impl FnOnce(&mut VaultState) + 'static) -> VaultChange {
  Box::new(change)
}

struct Harness {
  app: PathBuf,
  root: PathBuf,
  login: Arc<Login>,
  account_http: Arc<FakeHttp>,
  cloud: Cloud,
  state: AppState,
  vault: Arc<FakeVault>,
  server: Arc<FakeServer>,
  key: String,
}

impl Harness {
  /// ログイン済み（u1）・保存先は u1 に結び付き・同期する口は偽の provider。フォルダと docs-root は版 7 まで同期済み。
  fn signed_in(name: &str) -> Self {
    let app = temp_dir(&format!("{name}-app"));
    let root = temp_dir(&format!("{name}-root"));
    write_docs(&root);
    let (login, account_http) = signed_account(&app);
    login.as_user("u1");
    let key = account_key("prod", "u1");
    let binding = root_binding(&app, &root).unwrap();
    bind_root(&app, &binding.root_id, Some(&key)).unwrap();
    let cloud = Cloud::for_tests(&app, Some(login.account.clone()));
    cloud.test_open_root(&root);
    let vault = Arc::new(FakeVault {
      revision: Mutex::new(Some(REVISION)),
    });
    cloud.test_install_active(vault.clone());
    let state = AppState::for_tests(Arc::new(NoRunner), app.clone());
    let h = Self {
      app,
      root,
      login,
      account_http,
      cloud,
      state,
      vault,
      server: FakeServer::new(),
      key,
    };
    h.seed(Some("proj1"), |_| {});
    h.seed(None, |_| {});
    h
  }

  fn root_id(&self) -> String {
    root_binding(&self.app, &self.root).unwrap().root_id
  }

  fn working_copy(&self, project: Option<&str>) -> PathBuf {
    match project {
      Some(id) => self.root.join("projects").join(id),
      None => self.root.clone(),
    }
  }

  /// その対象の同期の状態: 入力のファイルを全部、手元の中身のまま基準（版 7）に置く。`change` で崩す。
  fn seed(&self, project: Option<&str>, change: impl FnOnce(&mut VaultState)) {
    let (project_id, paths) = match project {
      Some(id) => (
        id.to_string(),
        vec![
          "project.json".to_string(),
          "pages/ref1.md".into(),
          "recordings/rec1/recording.json".into(),
          "recordings/rec1/transcript.md".into(),
          source_path("rec1"),
        ],
      ),
      None => (
        DOCS_ROOT_PROJECT_ID.to_string(),
        vec![
          "pages.json".to_string(),
          "recordings/orec/recording.json".into(),
          "recordings/orec/transcript.md".into(),
          source_path("orec"),
        ],
      ),
    };
    let working = self.working_copy(project);
    let binding = root_binding(&self.app, &self.root).unwrap();
    let mut state = VaultState::new(project_id, binding.root_id.clone(), Some(self.key.clone()));
    state.base_revision = REVISION;
    for path in paths {
      let bytes = fs::read(working.join(&path)).unwrap();
      state.base.push(manifest_file(&path, &bytes));
    }
    state.base.sort_by(|left, right| left.path.cmp(&right.path));
    change(&mut state);
    save_state(&self.app, &binding.namespace(), &state).unwrap();
  }

  fn intents(&self, key: &str) -> PathBuf {
    self.app.join(format!("personal-runs/{key}/{}/intents", self.root_id()))
  }

  fn record(&self, intent: &str) -> Value {
    serde_json::from_slice(&fs::read(self.intents(&self.key).join(format!("{intent}.niho.json"))).unwrap()).unwrap()
  }

  fn intent_file(&self, intent: &str) -> Value {
    serde_json::from_slice(&fs::read(self.intents(&self.key).join(format!("{intent}.json"))).unwrap()).unwrap()
  }
}

impl Drop for Harness {
  fn drop(&mut self) {
    self.cloud.test_stop();
    let _ = fs::remove_dir_all(&self.app);
    let _ = fs::remove_dir_all(&self.root);
  }
}

fn ids(project: Option<&str>) -> (&'static str, &'static str) {
  if project.is_some() {
    ("pg1", "rec1")
  } else {
    ("opg", "orec")
  }
}

fn open_request(intent: &str, project: Option<&str>, executor: &str) -> OpenRequestWire {
  let (page, rec) = ids(project);
  OpenRequestWire {
    project_id: project.map(str::to_string),
    recording_page_id: page.into(),
    recording_id: rec.into(),
    intent_id: intent.into(),
    run_id: format!("run-{intent}"),
    route: RouteWire {
      kind: "generation_only".into(),
      executor: Some(executor.into()),
    },
    transcription_provider: None,
    transcription_connection: None,
    output_target: None,
  }
}

/// material から、controller と同じ欄を持つ後続だけ（NIHO API）の固定入力を作る（hash は Native の canonical で付ける）。
fn niho_snapshot(open: &OpenResult, material: &Value, project: Option<&str>, selected: &[&str]) -> Value {
  let (page, rec) = ids(project);
  let fixed: Map<String, Value> = selected
    .iter()
    .map(|step| (step.to_string(), material["flow"]["models"][*step].clone()))
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
  let source = &material["sourceVersion"];
  let snapshot = json!({
    "schemaVersion": 1,
    "ownerAccountId": open.owner_account_id,
    "rootId": open.root_id,
    "containerRef": container_json(project),
    "recordingPageId": page,
    "recordingId": rec,
    "baseManifestRevision": material["baseManifestRevision"],
    "route": { "kind": "generation_only", "executor": "niho_api" },
    "continuationOfRunId": "run-src",
    "consentVersion": CONSENT,
    "transcriptionModel": null,
    "selectedStepIds": selected,
    "stepNames": { "outline": "要点", "minutes": "議事録" },
    "input": {
      "audio": [],
      "sourceVersion": {
        "versionId": source["versionId"], "path": source["path"], "sha256": source["expectedSha256"],
        "bytes": source["content"].as_str().unwrap().len(), "originRunId": source["originRunId"], "origin": source["origin"],
      },
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

/// 開いて素材を読み、後続だけ（NIHO API）の固定入力を受け付けるまで。
async fn reserved_with(h: &Harness, intent: &str, project: Option<&str>, selected: &[&str]) -> (OpenResult, String) {
  let opened = open(&h.state, &h.cloud, open_request(intent, project, "niho_api"))
    .await
    .unwrap();
  let material = read_material(
    &h.state,
    &opened.handle,
    selected.iter().map(|step| step.to_string()).collect(),
  )
  .await
  .unwrap();
  assert_eq!(material["sourceVersion"]["origin"], json!("this_pc"));
  let snapshot = niho_snapshot(&opened, &material, project, selected);
  assert_eq!(
    reserve_intent(&h.state, &opened.handle, intent, &snapshot).unwrap(),
    ReserveResult::New
  );
  let sha = snapshot["snapshotSha256"].as_str().unwrap().to_string();
  (opened, sha)
}

async fn reserved(h: &Harness, intent: &str, project: Option<&str>) -> (OpenResult, String) {
  reserved_with(h, intent, project, &["outline", "minutes"]).await
}

async fn submit_with(h: &Harness, opened: &OpenResult, intent: &str, sha: &str) -> CommandResult<NihoSubmitWire> {
  submit(&h.state, &h.cloud, h.server.as_ref(), &opened.handle, intent, sha).await
}

async fn confirm_with(h: &Harness, intent: &str, action: &str) -> CommandResult<NihoConfirmWire> {
  confirm(&h.state, &h.cloud, h.server.as_ref(), intent, action).await
}

fn file_ref(working: &Path, path: &str) -> String {
  let bytes = fs::read(working.join(path)).unwrap();
  format!(
    r#"{{"path":"{path}","sha256":"{}","bytes":{}}}"#,
    sha(&bytes),
    bytes.len()
  )
}

const STEPS: &str = r#"[{"stepKey":"outline","kind":"REVISION","provider":"gemini","model":"gemini-3.8-flash","effort":"low"},{"stepKey":"minutes","kind":"INSIGHT","provider":"gemini","model":"gemini-3.8-flash","effort":"low"}]"#;

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

// ---------------------------------------------------------------------------

#[test]
fn the_folder_request_is_fixed_once_in_exact_bytes_and_persisted_with_its_key_before_the_post() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("golden-folder");
    let (opened, snapshot_sha) = reserved(&h, "intent-g", Some("proj1")).await;
    // POST が届いた時点で、本文の bytes とキーは app data に「送信を始める」段階で残っている
    let checked = Arc::new(AtomicBool::new(false));
    {
      let record_path = h.intents(&h.key).join("intent-g.niho.json");
      let intent_path = h.intents(&h.key).join("intent-g.json");
      let checked = checked.clone();
      *lock(&h.server.on_post) = Some(Box::new(move |request: &HttpRequest| {
        let record: Value = serde_json::from_slice(&fs::read(&record_path).unwrap()).unwrap();
        assert_eq!(record["phase"], json!("sent"));
        assert_eq!(
          record["body"].as_str().unwrap().as_bytes(),
          request.body.as_deref().unwrap()
        );
        assert_eq!(
          record["submissionKey"].as_str(),
          request.header_value("Idempotency-Key")
        );
        let intent: Value = serde_json::from_slice(&fs::read(&intent_path).unwrap()).unwrap();
        assert_eq!(intent["dispatches"][0]["stepId"], json!("remote"));
        assert_eq!(intent["dispatches"][0]["terminal"], json!(false));
        checked.store(true, Ordering::SeqCst);
      }));
    }
    let accepted = submit_with(&h, &opened, "intent-g", &snapshot_sha).await.unwrap();
    assert!(checked.load(Ordering::SeqCst));
    assert_eq!(accepted.status, "accepted");
    assert_eq!(accepted.state, "queued");

    let mut requests = lock(&h.server.requests).clone();
    assert_eq!(requests.len(), 3);
    assert_eq!(
      requests[0].url,
      "https://niho.life/api/me/docs-runs/api-access?plannedCalls=2"
    );
    assert_eq!(
      requests[1].url,
      "https://niho.life/api/me/docs-runs?containerKind=folder&projectId=proj1&recordingPageId=pg1&recordingId=rec1",
      "その録音の run を確かめてから頼む"
    );
    assert_eq!(requests[1].max_body_bytes, Some(LIST_MAX_BYTES));
    requests.remove(1);
    assert_eq!(requests[1].url, "https://niho.life/api/me/docs-runs");
    let body = String::from_utf8(requests[1].body.clone().unwrap()).unwrap();
    let working = h.working_copy(Some("proj1"));
    let expected = format!(
      r#"{{"baseRevision":7,"recordingPageId":"pg1","recordingId":"rec1","projectFile":{},"recordingFile":{},"audio":[],"sourceVersion":{},"references":[{}],"basis":[],"transcriptionExecutor":null,"generationExecutor":"niho_api","consentVersion":"{CONSENT}","steps":{STEPS},"containerRef":{{"kind":"folder","projectId":"proj1"}}}}"#,
      file_ref(&working, "project.json"),
      file_ref(&working, "recordings/rec1/recording.json"),
      file_ref(&working, &source_path("rec1")),
      file_ref(&working, "pages/ref1.md"),
    );
    assert_eq!(body, expected, "Web と同じ欄・同じ順の 1 回だけの bytes");
    assert!(!body.contains("requestId") && !body.contains("priorArtifacts"));
    let key = requests[1].header_value("Idempotency-Key").unwrap();
    assert!(is_submission_key(key), "submit_ ＋ 32 桁の小文字 16 進");
    assert_eq!(requests[1].header_value("content-type"), Some("application/json"));
    let debug = format!("{:?}", requests[1]);
    assert!(!debug.contains("secret-id-token"));

    let record = h.record("intent-g");
    assert_eq!(record["phase"], json!("accepted"));
    assert_eq!(record["runId"], json!(accepted.run_id));
    assert_eq!(record["bodySha256"], json!(sha(body.as_bytes())));
    assert_eq!(record["baseRevision"], json!(7));

    // 同じ intent の 2 回目（二重クリック）は送らずに受付を返す
    let again = submit_with(&h, &opened, "intent-g", &snapshot_sha).await.unwrap();
    assert_eq!(again, accepted);
    assert_eq!(h.server.count(), 3);
    // 受付が分かった時点で Native が intent を submitted にして marker を閉じる。controller の markIntent(submitted) は
    // 同じ値で通り、後から result_unknown を書いても戻らない
    let intent = h.intent_file("intent-g");
    assert_eq!(intent["state"], json!("submitted"));
    assert_eq!(intent["dispatches"][0]["terminal"], json!(true));
    mark_intent(&h.state, &opened.handle, "intent-g", "submitted").unwrap();
    mark_intent(&h.state, &opened.handle, "intent-g", "result_unknown").unwrap();
    assert_eq!(h.intent_file("intent-g")["state"], json!("submitted"));
    assert_eq!(
      confirm_with(&h, "intent-g", "lookup").await.unwrap(),
      NihoConfirmWire::Accepted {
        run_id: accepted.run_id.clone(),
        state: "queued".into(),
        reason_code: None,
      }
    );
    assert_eq!(h.server.count(), 3, "受付が分かった依頼は照会しない");
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn the_docs_root_request_uses_pages_json_and_the_root_container_with_the_page_id_apart_from_the_recording_id() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("golden-root");
    let (opened, snapshot_sha) = reserved(&h, "intent-r", None).await;
    submit_with(&h, &opened, "intent-r", &snapshot_sha).await.unwrap();
    let posted = h.server.posted();
    let body = String::from_utf8(posted[0].body.clone().unwrap()).unwrap();
    let working = h.working_copy(None);
    let expected = format!(
      r#"{{"baseRevision":7,"recordingPageId":"opg","recordingId":"orec","projectFile":{},"recordingFile":{},"audio":[],"sourceVersion":{},"references":[],"basis":[],"transcriptionExecutor":null,"generationExecutor":"niho_api","consentVersion":"{CONSENT}","steps":{STEPS},"containerRef":{{"kind":"root"}}}}"#,
      file_ref(&working, "pages.json"),
      file_ref(&working, "recordings/orec/recording.json"),
      file_ref(&working, &source_path("orec")),
    );
    assert_eq!(body, expected);
    assert_eq!(h.record("intent-r")["projectId"], Value::Null);
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn an_unknown_outcome_is_never_sent_again_automatically() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("unknown");
    let cases: Vec<(&str, Post)> = vec![
      (
        "u-5xx",
        Post::Respond(503, json!({ "error": { "code": "SERVICE_UNAVAILABLE" } })),
      ),
      ("u-net", Post::Network),
      ("u-lost", Post::AcceptLost),
      ("u-3xx", Post::Respond(302, json!({}))),
      ("u-bad", Post::Respond(200, json!({ "runId": "cmrunbroken1" }))),
      (
        "u-r6",
        Post::AcceptWith(|view| view["runId"] = json!("r6-0123456789abcdef")),
      ),
      ("u-other", Post::AcceptWith(|view| view["recordingId"] = json!("rec2"))),
      (
        "u-root",
        Post::AcceptWith(|view| view["containerRef"] = json!({ "kind": "root" })),
      ),
      ("u-state", Post::AcceptWith(|view| view["state"] = json!("mystery"))),
      (
        "u-exec",
        Post::AcceptWith(|view| view["transcriptionExecutor"] = json!("shared_mac")),
      ),
      ("u-rev", Post::AcceptWith(|view| view["baseRevision"] = json!(8))),
      ("u-4xx-raw", Post::Respond(409, json!({ "message": "proxy" }))),
      (
        "u-422",
        Post::Respond(422, json!({ "error": { "code": "UNPROCESSABLE" } })),
      ),
      // その受付キーの run がある（別の本文）。断られたとは言えない
      (
        "u-mismatch",
        Post::Respond(
          409,
          json!({ "error": { "code": "CONFLICT", "details": { "reason": "request_payload_mismatch" } } }),
        ),
      ),
      // 理由（details.reason）の無い 4xx はハンドラに届いたか分からない
      (
        "u-noreason",
        Post::Respond(409, json!({ "error": { "code": "CONFLICT", "details": {} } })),
      ),
      (
        "u-route404",
        Post::Respond(404, json!({ "error": { "code": "NOT_FOUND" } })),
      ),
    ];
    // 次の intent へ進む前に、前の依頼の結果を確かめる（版が進んだ後の照会で受付か不在が分かる）
    *lock(&h.vault.revision) = Some(REVISION + 1);
    for (intent, mode) in cases {
      let (opened, snapshot_sha) = reserved(&h, intent, Some("proj1")).await;
      h.server.post(mode);
      let posts = h.server.posted().len();
      let error = submit_with(&h, &opened, intent, &snapshot_sha).await.err().unwrap();
      assert_eq!(error.code, "personal_niho_result_unknown", "{intent}");
      assert_eq!(h.server.posted().len(), posts + 1, "{intent}");
      assert_eq!(h.record(intent)["phase"], json!("sent"), "{intent}");
      // 同じ intent の 2 回目は送らない
      let again = submit_with(&h, &opened, intent, &snapshot_sha).await.err().unwrap();
      assert_eq!(again.code, "personal_niho_result_unknown", "{intent}");
      assert_eq!(h.server.posted().len(), posts + 1, "{intent}");
      mark_intent(&h.state, &opened.handle, intent, "result_unknown").unwrap();
      close(&h.state, &h.cloud, &opened.handle).await.unwrap();
      if intent == "u-5xx" {
        // 開き直しても、結果の分からない intent は受け付けない（marker が残る）
        let reopened = open(&h.state, &h.cloud, open_request(intent, Some("proj1"), "niho_api"))
          .await
          .unwrap();
        let material = read_material(&h.state, &reopened.handle, vec!["outline".into(), "minutes".into()])
          .await
          .unwrap();
        let snapshot = niho_snapshot(&reopened, &material, Some("proj1"), &["outline", "minutes"]);
        assert_eq!(
          reserve_intent(&h.state, &reopened.handle, intent, &snapshot).unwrap(),
          ReserveResult::Existing {
            state: "result_unknown".into()
          }
        );
        close(&h.state, &h.cloud, &reopened.handle).await.unwrap();
      }
      let released = confirm_with(&h, intent, "release").await.unwrap();
      assert!(
        matches!(released, NihoConfirmWire::Absent | NihoConfirmWire::Accepted { .. }),
        "{intent}: {released:?}"
      );
      assert_eq!(h.server.posted().len(), posts + 1, "{intent}: 確かめる間も送らない");
    }
  });
}

#[test]
fn a_definite_rejection_is_recorded_with_its_reason_and_not_sent_again() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("rejected");
    for (intent, status, reason) in [
      ("r-rev", 409, "input_revision_changed"),
      ("r-model", 409, "api_model_unavailable"),
      ("r-budget", 409, "api_budget_exhausted"),
      ("r-limit", 429, "rate_limited"),
      ("r-active", 409, "recording_run_active"),
      ("r-auth", 401, "not_authenticated"),
      // 停止スイッチ（#18892・D-18）の 401。ログインのやり直しではなく、一時停止の理由で断られたと記録する
      ("r-paused", 401, "app_connect_disabled"),
    ] {
      let (opened, snapshot_sha) = reserved(&h, intent, Some("proj1")).await;
      let response = match status {
        429 => json!({
          "error": { "code": "RATE_LIMITED", "message": "Too many requests", "details": { "retryAfterSeconds": 5 } }
        }),
        401 if reason == "app_connect_disabled" => {
          json!({ "error": { "code": "UNAUTHORIZED", "details": { "reason": reason } } })
        }
        401 => json!({ "error": { "code": "UNAUTHORIZED" } }),
        _ => json!({ "error": { "code": "CONFLICT", "message": "raw server text", "details": { "reason": reason } } }),
      };
      h.server.post(Post::Respond(status, response));
      let error = submit_with(&h, &opened, intent, &snapshot_sha).await.err().unwrap();
      assert_eq!(error.code, "personal_niho_rejected", "{intent}");
      assert!(!error.message.contains("raw server text") && !error.message.contains(reason));
      let record = h.record(intent);
      assert_eq!(record["phase"], json!("rejected"));
      assert_eq!(record["reasonCode"], json!(reason));
      let posts = h.server.posted().len();
      let again = submit_with(&h, &opened, intent, &snapshot_sha).await.err().unwrap();
      assert_eq!(again.code, "personal_niho_rejected");
      assert_eq!(h.server.posted().len(), posts);
      assert_eq!(
        confirm_with(&h, intent, "resend").await.unwrap(),
        NihoConfirmWire::Rejected {
          reason_code: Some(reason.into())
        },
        "断られた依頼は送り直さない"
      );
      assert_eq!(h.server.posted().len(), posts);
      close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    }
    assert!(rejected("input_revision_changed").message.contains("保存先が更新"));
    assert!(rejected("recording_run_active").message.contains("実行中"));
  });
}

#[test]
fn nothing_is_sent_when_the_owner_switches_while_waiting_for_the_token() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("token-switch");
    let (opened, snapshot_sha) = reserved(&h, "intent-t", Some("proj1")).await;
    h.account_http.clear();
    h.account_http.hold_path("auth/app-connect/refresh");
    let http = h.account_http.clone();
    let login = h.login.clone();
    let (result, ()) = join2(submit_with(&h, &opened, "intent-t", &snapshot_sha), async move {
      while !http
        .requests()
        .iter()
        .any(|request| request.url.contains("app-connect/refresh"))
      {
        tokio::task::yield_now().await;
      }
      // token を待っている間に別のアカウントへ切り替わる
      login.as_user("u2");
      http.release();
    })
    .await;
    assert_eq!(result.err().unwrap().code, "personal_guard_failed");
    assert_eq!(h.server.count(), 0, "利用条件の確認も依頼も送らない");
    assert!(!h.intents(&h.key).join("intent-t.niho.json").exists());
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn a_response_after_the_owner_switched_is_kept_under_the_original_owner() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("post-switch");
    let (opened, snapshot_sha) = reserved(&h, "intent-p", Some("proj1")).await;
    {
      let login = h.login.clone();
      *lock(&h.server.on_post) = Some(Box::new(move |_request: &HttpRequest| login.as_user("u2")));
    }
    let accepted = submit_with(&h, &opened, "intent-p", &snapshot_sha).await.unwrap();
    assert_eq!(h.record("intent-p")["phase"], json!("accepted"));
    assert_eq!(h.record("intent-p")["runId"], json!(accepted.run_id));
    let other = account_key("prod", "u2");
    assert!(
      !h.app.join(format!("personal-runs/{other}")).exists(),
      "新しい本人の記録には書かない"
    );
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn a_cancelled_or_unreserved_operation_sends_nothing() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("cancel");
    let (opened, snapshot_sha) = reserved(&h, "intent-c", Some("proj1")).await;
    assert!(cancel(&h.state, &opened.handle).unwrap());
    let error = submit_with(&h, &opened, "intent-c", &snapshot_sha).await.err().unwrap();
    assert_eq!(error.code, "personal_guard_failed");
    let error = access(&h.state, h.server.as_ref(), &opened.handle, 2)
      .await
      .err()
      .unwrap();
    assert_eq!(error.code, "personal_guard_failed");
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    // 受け付ける前・別の intent・別の固定入力では送らない
    let opened = open(&h.state, &h.cloud, open_request("intent-n", Some("proj1"), "niho_api"))
      .await
      .unwrap();
    assert_eq!(
      submit_with(&h, &opened, "intent-n", &"a".repeat(64))
        .await
        .err()
        .unwrap()
        .code,
      "personal_intent_not_reserved"
    );
    assert_eq!(
      submit_with(&h, &opened, "intent-x", &"a".repeat(64))
        .await
        .err()
        .unwrap()
        .code,
      "personal_intent_mismatch"
    );
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    let (opened, _) = reserved(&h, "intent-s", Some("proj1")).await;
    assert_eq!(
      submit_with(&h, &opened, "intent-s", &"b".repeat(64))
        .await
        .err()
        .unwrap()
        .code,
      "personal_snapshot_mismatch"
    );
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert_eq!(h.server.count(), 0);
  });
}

#[test]
fn unsynced_inputs_are_refused_before_anything_is_sent() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("unsynced");
    let ref_file = manifest_file("pages/ref1.md", b"other");
    let cases: Vec<(&str, VaultChange)> = vec![
      (
        "s-dirty",
        change(|state| {
          state.dirty.insert("recordings/rec1/transcript.md".into(), 1);
        }),
      ),
      ("s-pending", change(|state| state.pending_mutations.push("m_1".into()))),
      (
        "s-deferred",
        change(move |state| {
          state.deferred_remote.insert("pages/ref1.md".into(), ref_file);
        }),
      ),
      (
        "s-conflict",
        change(|state| {
          state
            .conflicts
            .insert("recordings/rec1/recording.json".into(), "c_1".into());
        }),
      ),
      (
        "s-missing",
        change(|state| state.base.retain(|file| file.path != "project.json")),
      ),
      (
        "s-sha",
        change(|state| {
          let source = source_path("rec1");
          for file in state.base.iter_mut().filter(|file| file.path == source) {
            file.sha256 = "0".repeat(64);
          }
        }),
      ),
    ];
    for (intent, broken) in cases {
      h.seed(Some("proj1"), broken);
      let (opened, snapshot_sha) = reserved(&h, intent, Some("proj1")).await;
      let error = submit_with(&h, &opened, intent, &snapshot_sha).await.err().unwrap();
      assert_eq!(error.code, "personal_niho_not_synced", "{intent}");
      assert!(!h.intents(&h.key).join(format!("{intent}.niho.json")).exists());
      close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    }
    // 固定した後にクラウドの版が進んだ
    h.seed(Some("proj1"), |_| {});
    let (opened, snapshot_sha) = reserved(&h, "s-rev", Some("proj1")).await;
    h.seed(Some("proj1"), |state| state.base_revision = REVISION + 1);
    let error = submit_with(&h, &opened, "s-rev", &snapshot_sha).await.err().unwrap();
    assert_eq!(error.code, "personal_niho_input_changed");
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert_eq!(h.server.count(), 0);
  });
}

#[test]
fn the_source_must_be_the_current_transcript_and_no_step_may_be_saved_yet() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("source");
    let rec = h.root.join("projects/proj1/recordings/rec1");
    // 版にしていない手直し（同期は済んでいる）
    fs::write(rec.join("transcript.md"), "手直しした原文").unwrap();
    h.seed(Some("proj1"), |_| {});
    let (opened, snapshot_sha) = reserved(&h, "intent-s", Some("proj1")).await;
    let error = submit_with(&h, &opened, "intent-s", &snapshot_sha).await.err().unwrap();
    assert_eq!(error.code, "personal_niho_source_not_current");
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    fs::write(rec.join("transcript.md"), SOURCE_TEXT).unwrap();
    h.seed(Some("proj1"), |_| {});

    // 途中までの工程が保存済み（priorArtifacts は送れない）
    fs::create_dir_all(rec.join("artifacts")).unwrap();
    fs::write(rec.join("artifacts/outline.md"), "要点").unwrap();
    let (opened, snapshot_sha) = reserved_with(&h, "intent-p", Some("proj1"), &["minutes"]).await;
    let error = submit_with(&h, &opened, "intent-p", &snapshot_sha).await.err().unwrap();
    assert_eq!(error.code, "personal_niho_partial_saved");
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    fs::remove_dir_all(rec.join("artifacts")).unwrap();

    // 工程の一部だけ
    let (opened, snapshot_sha) = reserved_with(&h, "intent-o", Some("proj1"), &["outline"]).await;
    let error = submit_with(&h, &opened, "intent-o", &snapshot_sha).await.err().unwrap();
    assert_eq!(error.code, "personal_niho_steps_mismatch");
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    // 固定した後に参考ページが変わった（同期も済んだ）
    let (opened, snapshot_sha) = reserved(&h, "intent-ref", Some("proj1")).await;
    fs::write(h.root.join("projects/proj1/pages/ref1.md"), "書き換えた参考").unwrap();
    h.seed(Some("proj1"), |_| {});
    let error = submit_with(&h, &opened, "intent-ref", &snapshot_sha)
      .await
      .err()
      .unwrap();
    assert_eq!(error.code, "personal_niho_input_changed");
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert_eq!(h.server.count(), 0);
  });
}

#[test]
fn the_current_access_must_be_available_with_the_same_consent_and_model() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("access");
    let (opened, _) = reserved(&h, "intent-a", Some("proj1")).await;
    let wire = access(&h.state, h.server.as_ref(), &opened.handle, 2).await.unwrap();
    assert_eq!(
      serde_json::to_value(&wire).unwrap(),
      json!({
        "available": true, "reasonCode": null, "provider": "GOOGLE", "model": "gemini-3.8-flash", "consentVersion": CONSENT,
        "maxRunCostMicrousd": "120000", "executorReasonCode": null,
      })
    );
    assert_eq!(
      access(&h.state, h.server.as_ref(), &opened.handle, 0)
        .await
        .err()
        .unwrap()
        .code,
      "personal_bad_request"
    );
    // 開示された提供元は名前のまま渡す（読み替えは docs-core）。NIHO の AI で工程を動かせない提供元（以前の Anthropic）は使えない
    h.server
      .set_access(|api: &mut Value| api["provider"] = json!("ANTHROPIC"));
    let old = serde_json::to_value(access(&h.state, h.server.as_ref(), &opened.handle, 2).await.unwrap()).unwrap();
    assert_eq!(
      (&old["available"], &old["provider"]),
      (&json!(false), &json!("ANTHROPIC"))
    );
    h.server.set_access(|_| {});
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    let cases: Vec<(&str, fn(&mut Value), &str)> = vec![
      (
        "a-consent",
        (|api: &mut Value| api["consentVersion"] = json!("2026-11-01-v2")) as fn(&mut Value),
        "利用条件",
      ),
      (
        "a-model",
        (|api: &mut Value| api["model"] = json!("gemini-3.1-pro-preview")) as fn(&mut Value),
        "AI モデル",
      ),
      (
        "a-provider",
        (|api: &mut Value| api["provider"] = json!("OPENAI")) as fn(&mut Value),
        "NIHO API を今は使えません",
      ),
      // 以前の NIHO の AI（Anthropic）は、工程を動かせない提供元（#18816 から Vertex AI の Gemini だけ）
      (
        "a-anthropic",
        (|api: &mut Value| {
          api["provider"] = json!("ANTHROPIC");
          api["model"] = json!("claude-sonnet-5");
        }) as fn(&mut Value),
        "NIHO API を今は使えません",
      ),
      (
        "a-budget",
        (|api: &mut Value| {
          api["available"] = json!(false);
          api["reasonCode"] = json!("BUDGET_EXHAUSTED");
        }) as fn(&mut Value),
        "上限",
      ),
    ];
    for (intent, broken, words) in cases {
      h.server.set_access(broken);
      let (opened, snapshot_sha) = reserved(&h, intent, Some("proj1")).await;
      let error = submit_with(&h, &opened, intent, &snapshot_sha).await.err().unwrap();
      assert_eq!(error.code, "personal_niho_not_ready", "{intent}");
      assert!(error.message.contains(words), "{intent}: {}", error.message);
      close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    }
    *lock(&h.server.access) = (503, json!({}));
    let (opened, snapshot_sha) = reserved(&h, "a-down", Some("proj1")).await;
    assert_eq!(
      submit_with(&h, &opened, "a-down", &snapshot_sha)
        .await
        .err()
        .unwrap()
        .code,
      "personal_niho_unavailable"
    );
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    // 停止スイッチ（#18892・D-18）の 401 は、ログインのやり直しではなく一時停止。ふつうの 401 は従来どおり再ログイン
    for (intent, body, code, words) in [
      (
        "a-paused",
        json!({ "error": { "code": "UNAUTHORIZED", "details": { "reason": "app_connect_disabled" } } }),
        "personal_niho_unavailable",
        "一時停止",
      ),
      (
        "a-login",
        json!({ "error": { "code": "UNAUTHORIZED" } }),
        "personal_niho_auth_required",
        "ログイン",
      ),
    ] {
      *lock(&h.server.access) = (401, body);
      let (opened, snapshot_sha) = reserved(&h, intent, Some("proj1")).await;
      let error = submit_with(&h, &opened, intent, &snapshot_sha).await.err().unwrap();
      assert_eq!(error.code, code, "{intent}");
      assert!(error.message.contains(words), "{intent}: {}", error.message);
      close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    }
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert!(h.server.posted().is_empty(), "利用条件を確かめられない依頼は送らない");
  });
}

#[test]
fn other_routes_cannot_use_the_niho_api_and_the_niho_route_cannot_run_a_turn() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("route");
    let opened = open(&h.state, &h.cloud, open_request("intent-pc", Some("proj1"), "this_pc"))
      .await
      .unwrap();
    assert_eq!(
      submit_with(&h, &opened, "intent-pc", &"a".repeat(64))
        .await
        .err()
        .unwrap()
        .code,
      "personal_niho_route"
    );
    assert_eq!(
      access(&h.state, h.server.as_ref(), &opened.handle, 2)
        .await
        .err()
        .unwrap()
        .code,
      "personal_niho_route"
    );
    let op = operation_for(&h.state, &opened.handle).unwrap();
    op.st().dispatch_open = true;
    assert_eq!(
      send_guard(&h.cloud, &op, SendKind::NihoApi).await.err().unwrap().code,
      "personal_guard_failed"
    );
    drop(op);
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    let (opened, _) = reserved(&h, "intent-api", Some("proj1")).await;
    let op = operation_for(&h.state, &opened.handle).unwrap();
    op.st().dispatch_open = true;
    assert_eq!(
      send_guard(&h.cloud, &op, SendKind::Turn).await.err().unwrap().code,
      "personal_guard_failed"
    );
    assert!(send_guard(&h.cloud, &op, SendKind::NihoApi).await.is_ok());
    op.st().dispatch_open = false;
    assert_eq!(
      send_guard(&h.cloud, &op, SendKind::NihoApi).await.err().unwrap().code,
      "personal_guard_failed",
      "marker を書く前は送らない"
    );
    drop(op);
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert_eq!(h.server.count(), 0);
  });
}

#[test]
fn an_unknown_request_is_looked_up_and_resent_only_explicitly_with_the_same_bytes_and_key() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("resend");
    let (opened, snapshot_sha) = reserved(&h, "intent-u", Some("proj1")).await;
    h.server.post(Post::Network);
    assert_eq!(
      submit_with(&h, &opened, "intent-u", &snapshot_sha)
        .await
        .err()
        .unwrap()
        .code,
      "personal_niho_result_unknown"
    );
    mark_intent(&h.state, &opened.handle, "intent-u", "result_unknown").unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    let first = h.server.posted()[0].clone();

    // 照会: 404 は「まだ見つからない」だけ（記録は変えない）、通信できなければ不明
    assert_eq!(
      confirm_with(&h, "intent-u", "lookup").await.unwrap(),
      NihoConfirmWire::AbsentUnproven
    );
    assert_eq!(h.record("intent-u")["phase"], json!("sent"));
    h.server.look(Look::Respond(503, json!({})));
    assert_eq!(
      confirm_with(&h, "intent-u", "lookup").await.unwrap(),
      NihoConfirmWire::Unknown
    );
    h.server.look(Look::Respond(404, json!({})));
    assert_eq!(
      confirm_with(&h, "intent-u", "resend").await.unwrap(),
      NihoConfirmWire::Unknown,
      "失敗の本文の無い 404 では送り直さない"
    );
    assert_eq!(h.server.posted().len(), 1);

    // 明示の再送: 同じ bytes・同じキー
    let resent = confirm_with(&h, "intent-u", "resend").await.unwrap();
    let NihoConfirmWire::Accepted { run_id, state, .. } = resent else {
      panic!("受け付けられる: {resent:?}");
    };
    assert_eq!(state, "queued");
    let posted = h.server.posted();
    assert_eq!(posted.len(), 2);
    assert_eq!(posted[1].body, first.body);
    assert_eq!(
      posted[1].header_value("Idempotency-Key"),
      first.header_value("Idempotency-Key")
    );
    let record = h.record("intent-u");
    assert_eq!(record["phase"], json!("accepted"));
    assert_eq!(record["runId"], json!(run_id));
    let intent = h.intent_file("intent-u");
    assert_eq!(intent["state"], json!("submitted"));
    assert_eq!(intent["dispatches"][0]["terminal"], json!(true));
    let count = h.server.count();
    assert!(matches!(
      confirm_with(&h, "intent-u", "resend").await.unwrap(),
      NihoConfirmWire::Accepted { .. }
    ));
    assert_eq!(h.server.count(), count, "受付の分かった依頼は通信しない");

    // 受け付けたが応答が届かなかった依頼は、照会で受付が分かる
    let (opened, snapshot_sha) = reserved(&h, "intent-l", Some("proj1")).await;
    h.server.post(Post::AcceptLost);
    submit_with(&h, &opened, "intent-l", &snapshot_sha).await.err().unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert!(matches!(
      confirm_with(&h, "intent-l", "lookup").await.unwrap(),
      NihoConfirmWire::Accepted { .. }
    ));
    assert_eq!(h.server.posted().len(), 3);
    assert_eq!(
      confirm_with(&h, "intent-z", "nonsense").await.err().unwrap().code,
      "personal_bad_request"
    );
    assert_eq!(
      confirm_with(&h, "intent-z", "lookup").await.err().unwrap().code,
      "personal_niho_record_missing"
    );
  });
}

#[test]
fn release_proves_absence_only_after_the_manifest_revision_moved_past_the_request() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("release");
    // 同じ録音には結果を確かめていない依頼を 2 つ作れないので、フォルダの録音と docs-root の録音で 1 つずつ
    for (intent, project) in [("intent-a", Some("proj1")), ("intent-b", None)] {
      let (opened, snapshot_sha) = reserved(&h, intent, project).await;
      h.server.post(Post::Network);
      submit_with(&h, &opened, intent, &snapshot_sha).await.err().unwrap();
      mark_intent(&h.state, &opened.handle, intent, "result_unknown").unwrap();
      close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    }
    // 版がまだ固定した版のまま: 証明できない（照会は 1 回だけ）
    let lookups = h.server.lookups();
    assert_eq!(
      confirm_with(&h, "intent-a", "release").await.unwrap(),
      NihoConfirmWire::CannotConfirmYet
    );
    assert_eq!(h.server.lookups(), lookups + 1);
    *lock(&h.vault.revision) = None;
    assert_eq!(
      confirm_with(&h, "intent-a", "release").await.unwrap(),
      NihoConfirmWire::Unknown
    );
    // 経路の 404（details.reason の無い 404）は「見つからない」ではない: 最初の照会でも fence の後の照会でも証明しない
    *lock(&h.vault.revision) = Some(REVISION + 1);
    h.server
      .look(Look::Respond(404, json!({ "error": { "code": "NOT_FOUND" } })));
    assert_eq!(
      confirm_with(&h, "intent-a", "release").await.unwrap(),
      NihoConfirmWire::Unknown
    );
    h.server.look(Look::Normal);
    h.server.look(Look::Respond(
      404,
      json!({ "error": { "code": "NOT_FOUND", "details": {} } }),
    ));
    assert_eq!(
      confirm_with(&h, "intent-a", "release").await.unwrap(),
      NihoConfirmWire::Unknown
    );
    h.server
      .look(Look::Respond(404, json!({ "error": { "code": "NOT_FOUND" } })));
    assert_eq!(
      confirm_with(&h, "intent-a", "lookup").await.unwrap(),
      NihoConfirmWire::Unknown
    );
    assert_eq!(h.record("intent-a")["phase"], json!("sent"));
    // 版が進んだ後の再照会でも見つからない（reason が not_found） → 受け付けられていない
    let lookups = h.server.lookups();
    assert_eq!(
      confirm_with(&h, "intent-a", "release").await.unwrap(),
      NihoConfirmWire::Absent
    );
    assert_eq!(h.server.lookups(), lookups + 2, "版の fence の後にもう一度照会する");
    assert_eq!(h.record("intent-a")["phase"], json!("absent"));
    let intent = h.intent_file("intent-a");
    assert_eq!(intent["state"], json!("failed"));
    assert_eq!(intent["dispatches"][0]["terminal"], json!(true));
    assert_eq!(
      confirm_with(&h, "intent-a", "resend").await.unwrap(),
      NihoConfirmWire::Absent
    );
    assert_eq!(h.server.posted().len(), 2, "証明の間も送り直さない");

    // 最初の照会と版の読み取りの間に受け付けられていた → 受付
    let record = h.record("intent-b");
    let body: Value = serde_json::from_str(record["body"].as_str().unwrap()).unwrap();
    h.server.look(Look::Normal);
    h.server
      .look(Look::Respond(200, FakeServer::view(&body, "cmrunlate0001")));
    assert_eq!(
      confirm_with(&h, "intent-b", "release").await.unwrap(),
      NihoConfirmWire::Accepted {
        run_id: "cmrunlate0001".into(),
        state: "queued".into(),
        reason_code: None
      }
    );
    assert_eq!(h.record("intent-b")["phase"], json!("accepted"));
  });
}

#[test]
fn the_reason_code_of_a_run_found_after_a_lost_response_reaches_the_accepted_result() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("reason-code");
    // 同じ録音には結果を確かめていない依頼を 2 つ作れないので、フォルダの録音と docs-root の録音で 1 つずつ
    for (intent, project) in [("intent-a", Some("proj1")), ("intent-b", None)] {
      let (opened, snapshot_sha) = reserved(&h, intent, project).await;
      h.server.post(Post::Network);
      submit_with(&h, &opened, intent, &snapshot_sha).await.err().unwrap();
      mark_intent(&h.state, &opened.handle, intent, "result_unknown").unwrap();
      close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    }
    // 実行の前に入力が変わった run が見つかった: reasonCode を受付の結果まで運び、記録にも残す
    let record = h.record("intent-a");
    let body: Value = serde_json::from_str(record["body"].as_str().unwrap()).unwrap();
    let mut changed = FakeServer::view(&body, "cmrunchanged1");
    changed["state"] = json!("input_changed");
    changed["reasonCode"] = json!("input_changed_before_execution");
    h.server.look(Look::Respond(200, changed));
    let accepted = NihoConfirmWire::Accepted {
      run_id: "cmrunchanged1".into(),
      state: "input_changed".into(),
      reason_code: Some("input_changed_before_execution".into()),
    };
    assert_eq!(confirm_with(&h, "intent-a", "lookup").await.unwrap(), accepted);
    assert_eq!(
      h.record("intent-a")["runReasonCode"],
      json!("input_changed_before_execution")
    );
    // 結果が分かった記録はそのまま返す（照会しない）。reasonCode も同じ
    let lookups = h.server.lookups();
    assert_eq!(confirm_with(&h, "intent-a", "lookup").await.unwrap(), accepted);
    assert_eq!(h.server.lookups(), lookups);

    // reasonCode の無い run・形の合わない reasonCode は null（受付の記録も null のまま）
    let record = h.record("intent-b");
    let body: Value = serde_json::from_str(record["body"].as_str().unwrap()).unwrap();
    let mut odd = FakeServer::view(&body, "cmrunplain001");
    odd["reasonCode"] = json!("Not A Reason!");
    h.server.look(Look::Respond(200, odd));
    assert_eq!(
      confirm_with(&h, "intent-b", "lookup").await.unwrap(),
      NihoConfirmWire::Accepted {
        run_id: "cmrunplain001".into(),
        state: "queued".into(),
        reason_code: None,
      }
    );
    assert_eq!(h.record("intent-b")["runReasonCode"], json!(null));
  });
}

#[test]
fn pending_requests_are_listed_for_the_current_owner_only_and_other_owners_cannot_reach_them() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("pending");
    let (opened, snapshot_sha) = reserved(&h, "intent-q", Some("proj1")).await;
    h.server.post(Post::Respond(503, json!({})));
    submit_with(&h, &opened, "intent-q", &snapshot_sha).await.err().unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    let (opened, snapshot_sha) = reserved(&h, "intent-ok", None).await;
    submit_with(&h, &opened, "intent-ok", &snapshot_sha).await.unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    let listed = pending(&h.state, &h.cloud).await.unwrap();
    assert_eq!(
      serde_json::to_value(&listed).unwrap(),
      json!({
        "items": [{
          "intentId": "intent-q", "recordingPageId": "pg1", "recordingId": "rec1", "projectId": "proj1", "phase": "sent",
          "runId": null, "createdAt": h.record("intent-q")["createdAt"],
        }],
        "truncated": false,
      })
    );

    // 別の本人に切り替わった: この Root は u1 に結び付いたまま → 読めない
    h.login.as_user("u2");
    h.cloud.test_reconcile().await;
    for code in [
      pending(&h.state, &h.cloud).await.err().unwrap().code,
      confirm_with(&h, "intent-q", "lookup").await.err().unwrap().code,
    ] {
      assert!(
        matches!(code.as_str(), "personal_not_signed_in" | "store_context_changed"),
        "{code}"
      );
    }
    // u2 の保存先へ移っても、u1 の依頼には届かない
    let other_root = temp_dir("pending-other");
    write_docs(&other_root);
    let binding = root_binding(&h.app, &other_root).unwrap();
    bind_root(&h.app, &binding.root_id, Some(&account_key("prod", "u2"))).unwrap();
    h.cloud.test_open_root(&other_root);
    h.cloud.test_install_active(h.vault.clone());
    assert!(pending(&h.state, &h.cloud).await.unwrap().items.is_empty());
    assert_eq!(
      confirm_with(&h, "intent-q", "resend").await.err().unwrap().code,
      "personal_niho_record_missing"
    );
    assert!(
      h.intents(&h.key).join("intent-q.niho.json").is_file(),
      "u1 の記録は残る"
    );
    assert_eq!(h.server.lookups(), 0);
    let _ = fs::remove_dir_all(other_root);
  });
}

/// 依頼の記録を app data に直接置く（一覧の上限のテスト）。
fn write_record_file(h: &Harness, intent: &str, phase: &str, created_at: &str, serial: u64) {
  let body = "{}";
  let record = json!({
    "schemaVersion": 1, "intentId": intent, "submissionKey": format!("submit_{serial:032x}"), "body": body,
    "bodySha256": sha(body.as_bytes()), "baseRevision": REVISION, "projectId": "proj1",
    "containerRef": { "kind": "folder", "projectId": "proj1" }, "recordingPageId": "pg1", "recordingId": "rec1",
    "phase": phase, "runId": null, "state": null, "reasonCode": null, "createdAt": created_at, "updatedAt": created_at,
  });
  let dir = h.intents(&h.key);
  fs::create_dir_all(&dir).unwrap();
  fs::write(
    dir.join(format!("{intent}.niho.json")),
    serde_json::to_vec(&record).unwrap(),
  )
  .unwrap();
}

#[test]
fn nothing_is_sent_when_the_owner_switches_at_the_token_just_before_the_post() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("token-post");
    let (opened, snapshot_sha) = reserved(&h, "intent-t2", Some("proj1")).await;
    // 期限の短い token（更新の前倒しの時間より短い）にして、呼ぶたびに取り直させる
    h.account_http.respond(|request| {
      if request.url.contains("auth/app-connect/refresh") {
        Ok(json_response(200, &json!({ "customToken": "custom-token" })))
      } else if request.url.contains("signInWithCustomToken") {
        Ok(json_response(
          200,
          &json!({ "idToken": "secret-id-token", "refreshToken": "r", "expiresIn": "120" }),
        ))
      } else {
        Err(network_error())
      }
    });
    h.account_http.clear();
    {
      // run の一覧（POST の前の最後の通信）を返した後の token の取得（POST 用）で待たせる
      let http = h.account_http.clone();
      *lock(&h.server.on_list) = Some(Box::new(move || http.hold_path("auth/app-connect/refresh")));
    }
    let http = h.account_http.clone();
    let login = h.login.clone();
    let refreshes = |http: &FakeHttp| {
      http
        .requests()
        .iter()
        .filter(|request| request.url.contains("app-connect/refresh"))
        .count()
    };
    let (result, ()) = join2(submit_with(&h, &opened, "intent-t2", &snapshot_sha), async move {
      while refreshes(&http) < 3 {
        tokio::task::yield_now().await;
      }
      // 利用条件・run の一覧の後、POST の token を待っている間に別のアカウントへ切り替わる
      login.as_user("u2");
      http.release();
    })
    .await;
    assert_eq!(result.err().unwrap().code, "personal_guard_failed");
    assert_eq!(h.server.lists(), 1);
    assert_eq!(h.server.count(), 2, "利用条件と run の一覧だけ");
    assert!(h.server.posted().is_empty());
    assert!(!h.intents(&h.key).join("intent-t2.niho.json").exists());
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn an_in_flight_submit_and_concurrent_confirms_post_once_and_never_roll_the_phase_back() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("flight");
    let (opened, snapshot_sha) = reserved(&h, "intent-f", Some("proj1")).await;
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *lock(&h.server.post_gate) = Some(gate.clone());
    let (submitted, (during, again, phase)) = join2(submit_with(&h, &opened, "intent-f", &snapshot_sha), async {
      while h.server.posted().is_empty() {
        tokio::task::yield_now().await;
      }
      // POST の応答を待っている間の確認・二重の送信は何もしない
      let during = [
        confirm_with(&h, "intent-f", "resend").await,
        confirm_with(&h, "intent-f", "release").await,
        confirm_with(&h, "intent-f", "lookup").await,
      ];
      let again = submit_with(&h, &opened, "intent-f", &snapshot_sha).await;
      let phase = h.record("intent-f")["phase"].clone();
      gate.add_permits(1);
      (during, again, phase)
    })
    .await;
    for result in during {
      assert_eq!(result.unwrap(), NihoConfirmWire::InFlight);
    }
    assert_eq!(again.err().unwrap().code, "personal_niho_result_unknown");
    assert_eq!(phase, json!("sent"));
    let accepted = submitted.unwrap();
    assert_eq!(h.server.posted().len(), 1, "1 回だけ送る");
    assert_eq!(h.server.lookups(), 0);
    assert_eq!(h.record("intent-f")["phase"], json!("accepted"));

    // 段階は進むだけ: 決まった記録は戻らない・別の結果で上書きしない
    let relative = format!("personal-runs/{}/{}/intents/intent-f.niho.json", h.key, h.root_id());
    for to in ["prepared", "sent", "rejected", "absent", "accepted"] {
      let stored = update_record(&h.state, &relative, "intent-f", to, |record| {
        record.run_id = Some("cmrunother001".into());
      })
      .unwrap();
      assert_eq!(stored.phase, "accepted", "{to}");
      assert_eq!(stored.run_id.as_deref(), Some(accepted.run_id.as_str()), "{to}");
    }
    assert!(may_advance("prepared", "sent") && may_advance("prepared", "absent"));
    assert!(may_advance("sent", "accepted") && may_advance("sent", "rejected") && may_advance("sent", "absent"));
    assert!(!may_advance("sent", "prepared") && !may_advance("sent", "sent") && !may_advance("prepared", "rejected"));
    for settled in ["accepted", "rejected", "absent"] {
      for to in PHASES {
        assert!(!may_advance(settled, to), "{settled} → {to}");
      }
    }
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn a_new_intent_is_not_sent_while_the_recording_has_an_unconfirmed_request_or_an_active_run() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("duplicate");
    let (opened, snapshot_sha) = reserved(&h, "intent-1", Some("proj1")).await;
    h.server.post(Post::Network);
    submit_with(&h, &opened, "intent-1", &snapshot_sha).await.err().unwrap();
    mark_intent(&h.state, &opened.handle, "intent-1", "result_unknown").unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    // 前の依頼の結果を確かめていない: 新しい intent は何も送らない（利用条件の確認も）
    let (opened, snapshot_sha) = reserved(&h, "intent-2", Some("proj1")).await;
    let count = h.server.count();
    let error = submit_with(&h, &opened, "intent-2", &snapshot_sha).await.err().unwrap();
    assert_eq!(error.code, "personal_niho_pending_exists");
    assert!(error.message.contains("前の依頼"));
    assert_eq!(h.server.count(), count);
    assert!(!h.intents(&h.key).join("intent-2.niho.json").exists());
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    // 別の録音（docs-root）は止めない
    let (opened, snapshot_sha) = reserved(&h, "intent-root", None).await;
    submit_with(&h, &opened, "intent-root", &snapshot_sha).await.unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    // 前の依頼が受け付けられていないと分かった後でも、NIHO で実行中の run があれば頼まない
    *lock(&h.vault.revision) = Some(REVISION + 1);
    assert_eq!(
      confirm_with(&h, "intent-1", "release").await.unwrap(),
      NihoConfirmWire::Absent
    );
    let body: Value = serde_json::from_str(h.record("intent-1")["body"].as_str().unwrap()).unwrap();
    let mut running = FakeServer::view(&body, "cmrunactive01");
    running["state"] = json!("waiting_runner");
    let mut finished = FakeServer::view(&body, "cmrundone0001");
    finished["state"] = json!("completed");
    let mut elsewhere = FakeServer::view(&body, "cmrunother001");
    elsewhere["recordingId"] = json!("rec2");
    let mut odd = finished.clone();
    odd["state"] = json!("mystery");
    let posts = h.server.posted().len();
    // 実行中の run・知らない状態の run（送らない側に倒す）があれば頼まない
    for (intent, runs) in [
      ("intent-3", json!([finished.clone(), running.clone()])),
      ("intent-4", json!([odd])),
    ] {
      *lock(&h.server.listed) = (200, json!({ "runs": runs }));
      let (opened, snapshot_sha) = reserved(&h, intent, Some("proj1")).await;
      let error = submit_with(&h, &opened, intent, &snapshot_sha).await.err().unwrap();
      assert_eq!(error.code, "personal_niho_run_active", "{intent}");
      assert!(!h.intents(&h.key).join(format!("{intent}.niho.json")).exists());
      close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    }
    assert_eq!(h.server.posted().len(), posts);
    // 一覧を確かめられなければ頼まない
    *lock(&h.server.listed) = (503, json!({}));
    let (opened, snapshot_sha) = reserved(&h, "intent-5", Some("proj1")).await;
    assert_eq!(
      submit_with(&h, &opened, "intent-5", &snapshot_sha)
        .await
        .err()
        .unwrap()
        .code,
      "personal_niho_unavailable"
    );
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    *lock(&h.server.listed) = (200, json!({ "nothing": [] }));
    let (opened, snapshot_sha) = reserved(&h, "intent-6", Some("proj1")).await;
    assert_eq!(
      submit_with(&h, &opened, "intent-6", &snapshot_sha)
        .await
        .err()
        .unwrap()
        .code,
      "personal_niho_unavailable"
    );
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert_eq!(h.server.posted().len(), posts);
    // 終わった run・別の録音の run は止めない
    *lock(&h.server.listed) = (200, json!({ "runs": [finished, elsewhere] }));
    let (opened, snapshot_sha) = reserved(&h, "intent-7", Some("proj1")).await;
    submit_with(&h, &opened, "intent-7", &snapshot_sha).await.unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert_eq!(h.server.posted().len(), posts + 1);
  });
}

#[test]
fn a_settled_record_repairs_an_intent_left_unknown() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("repair");
    let (opened, snapshot_sha) = reserved(&h, "intent-d", Some("proj1")).await;
    submit_with(&h, &opened, "intent-d", &snapshot_sha).await.unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    // 前の版で、受付が分かったのに intent が result_unknown・marker が開いたまま残った
    let path = h.intents(&h.key).join("intent-d.json");
    let mut file: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    file["state"] = json!("result_unknown");
    file["dispatches"][0]["terminal"] = json!(false);
    fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
    let count = h.server.count();
    assert!(matches!(
      confirm_with(&h, "intent-d", "lookup").await.unwrap(),
      NihoConfirmWire::Accepted { .. }
    ));
    assert_eq!(h.server.count(), count, "記録だけで直す（通信しない）");
    let repaired = h.intent_file("intent-d");
    assert_eq!(repaired["state"], json!("submitted"));
    assert_eq!(repaired["dispatches"][0]["terminal"], json!(true));
  });
}

#[test]
fn resend_waits_while_a_run_on_the_same_recording_is_open_here() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("busy");
    let (opened, snapshot_sha) = reserved(&h, "intent-b", Some("proj1")).await;
    h.server.post(Post::Network);
    submit_with(&h, &opened, "intent-b", &snapshot_sha).await.err().unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    let local = open(
      &h.state,
      &h.cloud,
      open_request("intent-local", Some("proj1"), "this_pc"),
    )
    .await
    .unwrap();
    assert_eq!(
      confirm_with(&h, "intent-b", "resend").await.err().unwrap().code,
      "personal_niho_recording_busy"
    );
    assert_eq!(h.server.posted().len(), 1);
    assert_eq!(h.server.lookups(), 0);
    // 照会だけならできる
    assert_eq!(
      confirm_with(&h, "intent-b", "lookup").await.unwrap(),
      NihoConfirmWire::AbsentUnproven
    );
    close(&h.state, &h.cloud, &local.handle).await.unwrap();
    assert!(matches!(
      confirm_with(&h, "intent-b", "resend").await.unwrap(),
      NihoConfirmWire::Accepted { .. }
    ));
    assert_eq!(h.server.posted().len(), 2);
  });
}

#[test]
fn pending_counts_only_records_reads_a_bounded_number_and_keeps_the_newest() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("pending-cap");
    let dir = h.intents(&h.key);
    fs::create_dir_all(&dir).unwrap();
    // 記録でないファイル（intent の記録など）は上限に数えない
    for index in 0..(MAX_PENDING_SCAN + 100) {
      fs::write(dir.join(format!("other-{index}.json")), "{}").unwrap();
    }
    for (index, phase) in ["sent", "prepared", "accepted"].iter().enumerate() {
      write_record_file(
        &h,
        &format!("few-{index}"),
        phase,
        &format!("2026-10-17T00:00:0{index}.000Z"),
        index as u64,
      );
    }
    let listed = pending(&h.state, &h.cloud).await.unwrap();
    assert!(!listed.truncated);
    assert_eq!(
      listed
        .items
        .iter()
        .map(|item| item.intent_id.as_str())
        .collect::<Vec<_>>(),
      ["few-1", "few-0"],
      "新しい順・結果の分かったものは出さない"
    );

    // 返す数の上限を超えた: 新しいものから MAX_PENDING 件
    for index in 0..(MAX_PENDING + 5) {
      write_record_file(
        &h,
        &format!("many-{index:03}"),
        "sent",
        &format!("2026-10-18T00:{:02}:{:02}.000Z", index / 60, index % 60),
        1000 + index as u64,
      );
    }
    let listed = pending(&h.state, &h.cloud).await.unwrap();
    assert!(listed.truncated);
    assert_eq!(listed.items.len(), MAX_PENDING);
    assert_eq!(listed.items[0].intent_id, format!("many-{:03}", MAX_PENDING + 4));
    assert!(listed.items.iter().all(|item| item.intent_id.starts_with("many-")));

    // 読む数の上限を超えた: 打ち切りを知らせる（新しく書いたものは読む）
    for index in 0..MAX_PENDING_SCAN {
      write_record_file(
        &h,
        &format!("done-{index:03}"),
        "accepted",
        "2026-10-16T00:00:00.000Z",
        5000 + index as u64,
      );
    }
    write_record_file(&h, "latest", "sent", "2026-10-19T00:00:00.000Z", 9999);
    let listed = pending(&h.state, &h.cloud).await.unwrap();
    assert!(listed.truncated);
    assert_eq!(listed.items[0].intent_id, "latest");
  });
}

#[test]
fn an_explicit_resend_checks_for_another_active_run_on_the_recording_first() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("resend-active");
    let (opened, snapshot_sha) = reserved(&h, "intent-u", Some("proj1")).await;
    h.server.post(Post::Network);
    submit_with(&h, &opened, "intent-u", &snapshot_sha).await.err().unwrap();
    mark_intent(&h.state, &opened.handle, "intent-u", "result_unknown").unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    assert_eq!(h.server.posted().len(), 1);

    // 照会で見つからない間に、別の端末・別の依頼が同じ録音の run を始めていた: 送り直さず、記録も動かさない
    let body: Value = serde_json::from_str(h.record("intent-u")["body"].as_str().unwrap()).unwrap();
    let mut running = FakeServer::view(&body, "cmrunactive02");
    running["state"] = json!("running");
    *lock(&h.server.listed) = (200, json!({ "runs": [running] }));
    let error = confirm_with(&h, "intent-u", "resend").await.err().unwrap();
    assert_eq!(error.code, "personal_niho_run_active");
    assert_eq!(h.server.posted().len(), 1, "実行中の run があるときは送り直さない");
    assert_eq!(h.record("intent-u")["phase"], json!("sent"));

    // 一覧を確かめられなければ送り直さない
    *lock(&h.server.listed) = (503, json!({}));
    assert_eq!(
      confirm_with(&h, "intent-u", "resend").await.err().unwrap().code,
      "personal_niho_unavailable"
    );
    assert_eq!(h.server.posted().len(), 1);

    // 実行中の run が無くなれば、これまでどおり同じ bytes・同じキーで送り直せる
    let mut finished = FakeServer::view(&body, "cmrundone0002");
    finished["state"] = json!("completed");
    *lock(&h.server.listed) = (200, json!({ "runs": [finished] }));
    assert!(matches!(
      confirm_with(&h, "intent-u", "resend").await.unwrap(),
      NihoConfirmWire::Accepted { .. }
    ));
    assert_eq!(h.server.posted().len(), 2);
  });
}

#[test]
fn a_run_resolved_after_an_input_change_is_accepted_as_completed() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("resolved-state");
    for (intent, resolved) in [("intent-k", "kept_current"), ("intent-a", "adopted")] {
      let (opened, snapshot_sha) = reserved(&h, intent, Some("proj1")).await;
      h.server.post(Post::AcceptLost);
      submit_with(&h, &opened, intent, &snapshot_sha).await.err().unwrap();
      mark_intent(&h.state, &opened.handle, intent, "result_unknown").unwrap();
      close(&h.state, &h.cloud, &opened.handle).await.unwrap();
      // 応答を失った run が、あとで別の画面で解決された（API は kept_current・adopted を返す）。照会は正しい run を返す
      let body: Value = serde_json::from_str(h.record(intent)["body"].as_str().unwrap()).unwrap();
      let mut view = FakeServer::view(&body, "cmrunresolve1");
      view["state"] = json!(resolved);
      h.server.look(Look::Respond(200, view));
      let NihoConfirmWire::Accepted { state, .. } = confirm_with(&h, intent, "lookup").await.unwrap() else {
        panic!("{intent}: 受付が分かる");
      };
      assert_eq!(state, "completed", "{intent}");
      assert_eq!(h.record(intent)["phase"], json!("accepted"), "{intent}");
      assert_eq!(h.record(intent)["state"], json!("completed"), "{intent}");
    }
    // 結果の分かった依頼なので、同じ録音の次の依頼を止めない
    let (opened, snapshot_sha) = reserved(&h, "intent-next", Some("proj1")).await;
    submit_with(&h, &opened, "intent-next", &snapshot_sha).await.unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn only_niho_records_count_toward_the_directory_cap() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("record-cap");
    let dir = h.intents(&h.key);
    fs::create_dir_all(&dir).unwrap();
    // 記録でないファイル（intent の記録・一時ファイルなど。削除されない履歴）が上限を超えて溜まっていても、記録は数え間違えない
    for index in 0..(MAX_DIR_ENTRIES + 20) {
      fs::write(dir.join(format!("history-{index}.json")), "{}").unwrap();
    }
    write_record_file(&h, "old-done", "accepted", "2026-10-17T00:00:00.000Z", 1);
    write_record_file(&h, "old-sent", "sent", "2026-10-17T00:00:01.000Z", 2);
    let listed = pending(&h.state, &h.cloud).await.unwrap();
    assert!(!listed.truncated);
    assert_eq!(listed.items.len(), 1);

    // 新しい依頼は、未確定の依頼がある録音だけを止める（上限の超過で全部を止めない）
    let (opened, snapshot_sha) = reserved(&h, "intent-root", None).await;
    submit_with(&h, &opened, "intent-root", &snapshot_sha).await.unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
    let (opened, snapshot_sha) = reserved(&h, "intent-blocked", Some("proj1")).await;
    assert_eq!(
      submit_with(&h, &opened, "intent-blocked", &snapshot_sha)
        .await
        .err()
        .unwrap()
        .code,
      "personal_niho_pending_exists"
    );
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}

#[test]
fn an_unreadable_record_stops_new_requests_instead_of_being_ignored() {
  tauri::async_runtime::block_on(async {
    let h = Harness::signed_in("unreadable");
    let dir = h.intents(&h.key);
    fs::create_dir_all(&dir).unwrap();
    // 壊れた・切り詰められた記録は、どの録音の未確定の依頼か分からない。無視して新しく頼むと二重に頼みうる
    fs::write(dir.join("broken.niho.json"), "{\"schemaVersion\":1,\"intentId\":\"brok").unwrap();
    let (opened, snapshot_sha) = reserved(&h, "intent-1", Some("proj1")).await;
    let count = h.server.count();
    let error = submit_with(&h, &opened, "intent-1", &snapshot_sha).await.err().unwrap();
    assert_eq!(error.code, "personal_niho_pending_exists");
    assert!(error.message.contains("記録を読めない"));
    assert_eq!(h.server.count(), count, "何も送らない");
    assert!(!dir.join("intent-1.niho.json").exists());
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();

    // 読めない記録を片づけたら、これまでどおり頼める
    fs::remove_file(dir.join("broken.niho.json")).unwrap();
    let (opened, snapshot_sha) = reserved(&h, "intent-2", Some("proj1")).await;
    submit_with(&h, &opened, "intent-2", &snapshot_sha).await.unwrap();
    close(&h.state, &h.cloud, &opened.handle).await.unwrap();
  });
}
