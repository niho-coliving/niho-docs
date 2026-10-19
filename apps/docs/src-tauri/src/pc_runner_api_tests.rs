//! pc_runner_api.rs のテスト（通信しない。偽の HTTP の口で、送る形と受け取りの確かめを見る）。

use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

const BASE: &str = "https://niho.life/api/me/docs-pc-runner";
const CANDIDATE_ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

fn signed_url() -> String {
  "https://storage.googleapis.com/niho-docs-runs/candidates/abc.md?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc%40niho.iam.gserviceaccount.com%2F20261017%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20261017T010203Z&X-Goog-Expires=900&X-Goog-SignedHeaders=content-type%3Bhost%3Bx-goog-content-length-range%3Bx-goog-if-generation-match&X-Goog-Signature=0a1b2c3d4e5f".to_string()
}

fn candidate_value(bytes: usize) -> Value {
  json!({
    "candidateId": CANDIDATE_ID,
    "url": signed_url(),
    "headers": {
      "content-type": "text/markdown",
      "x-goog-if-generation-match": "0",
      "x-goog-content-length-range": format!("{bytes},{bytes}"),
    },
    "expiresAt": "2026-10-17T01:17:03.000Z",
    "candidateExpiresAt": "2026-10-18T01:02:03.000Z",
    "bytes": bytes,
    "maxBytes": 8 * 1024 * 1024,
  })
}

fn leased_value() -> Value {
  json!({
    "status": "LEASED",
    "runId": "run_1",
    "attemptId": "att_1",
    "generation": 3,
    "leaseUntil": "2026-10-17T01:03:30.000Z",
    "containerRef": { "kind": "folder", "projectId": "p_kamakura" },
    "recordingPageId": "page_1",
    "step": {
      "stepKey": "revision",
      "kind": "REVISION",
      "label": "文字起こしの修正",
      "provider": "claude",
      "model": "claude-sonnet-4-6",
      "effort": "high",
    },
  })
}

fn job() -> LeasedJob {
  let Some(Claim::Leased(job)) = parse_claim(&leased_value()) else {
    panic!("leased");
  };
  *job
}

#[test]
fn signed_upload_url_accepts_only_v4_gcs_put_urls() {
  assert!(valid_signed_upload_url(&signed_url()));
  let bucket = signed_url().replace(
    "https://storage.googleapis.com/niho-docs-runs/",
    "https://niho-docs-runs.storage.googleapis.com/",
  );
  assert!(valid_signed_upload_url(&bucket));
  let rejected = [
    signed_url().replace("https://", "http://"),
    signed_url().replace("storage.googleapis.com", "storage.googleapis.com.evil.example"),
    signed_url().replace("storage.googleapis.com", "evil.example"),
    signed_url().replace("storage.googleapis.com", "storage.googleapis.com:8443"),
    signed_url().replace("https://", "https://user:pass@"),
    signed_url().replace(
      "https://storage.googleapis.com/",
      "https://a..b.storage.googleapis.com/",
    ),
    format!("{}#fragment", signed_url()),
    format!("{}&generation=1", signed_url()),
    format!("{}&X-Goog-Expires=900", signed_url()),
    signed_url().replace("GOOG4-RSA-SHA256", "GOOG4-HMAC-SHA256"),
    signed_url().replace("X-Goog-Expires=900", "X-Goog-Expires=901"),
    signed_url().replace("X-Goog-Expires=900", "X-Goog-Expires=0900"),
    signed_url().replace("20261017T010203Z", "2026-10-17T01:02:03Z"),
    signed_url().replace("%3Bx-goog-if-generation-match", ""),
    signed_url().replace("0a1b2c3d4e5f", "not-hex"),
    signed_url().replace(
      "&X-Goog-Credential=svc%40niho.iam.gserviceaccount.com%2F20261017%2Fauto%2Fstorage%2Fgoog4_request",
      "",
    ),
    "https://storage.googleapis.com/?X-Goog-Algorithm=GOOG4-RSA-SHA256".to_string(),
    "not a url".to_string(),
  ];
  for url in rejected {
    assert!(!valid_signed_upload_url(&url), "{url}");
  }
}

#[test]
fn candidate_headers_must_be_exactly_the_three_lowercase_headers() {
  let ok = candidate_value(12);
  let headers = candidate_headers(ok["headers"].as_object().unwrap(), 12).unwrap();
  assert_eq!(
    headers,
    vec![
      ("content-type".to_string(), "text/markdown".to_string()),
      ("x-goog-if-generation-match".to_string(), "0".to_string()),
      ("x-goog-content-length-range".to_string(), "12,12".to_string()),
    ]
  );
  let cases = [
    json!({ "Content-Type": "text/markdown", "x-goog-if-generation-match": "0", "x-goog-content-length-range": "12,12" }),
    json!({ "content-type": "text/markdown", "x-goog-if-generation-match": "0", "x-goog-content-length-range": "12,13" }),
    json!({ "content-type": "text/plain", "x-goog-if-generation-match": "0", "x-goog-content-length-range": "12,12" }),
    json!({ "content-type": "text/markdown", "x-goog-if-generation-match": "0" }),
    json!({ "content-type": "text/markdown", "x-goog-if-generation-match": "0", "x-goog-content-length-range": "12,12", "x-extra": "1" }),
    json!({ "content-type": "text/markdown", "x-goog-if-generation-match": 0, "x-goog-content-length-range": "12,12" }),
  ];
  for headers in cases {
    assert!(
      candidate_headers(headers.as_object().unwrap(), 12).is_none(),
      "{headers}"
    );
  }
}

#[test]
fn candidate_is_checked_before_put() {
  let ok = validate_candidate(&candidate_value(12), 12, None).unwrap();
  assert_eq!(ok.candidate_id, CANDIDATE_ID);
  assert_eq!(ok.url, signed_url());
  assert!(validate_candidate(&candidate_value(12), 12, Some(CANDIDATE_ID)).is_some());
  // 同じ attempt の 2 回目で別の候補が返ったら使わない
  assert!(validate_candidate(&candidate_value(12), 12, Some("1f8fad5b-d9cb-469f-a165-70867728950e")).is_none());
  assert!(validate_candidate(&candidate_value(12), 13, None).is_none());
  let mut value = candidate_value(12);
  value["maxBytes"] = json!(8 * 1024 * 1024 + 1);
  assert!(validate_candidate(&value, 12, None).is_none());
  let mut value = candidate_value(12);
  value["maxBytes"] = json!(11);
  assert!(validate_candidate(&value, 12, None).is_none());
  let mut value = candidate_value(12);
  value["candidateExpiresAt"] = json!("2026-10-17T01:00:00.000Z");
  assert!(validate_candidate(&value, 12, None).is_none());
  let mut value = candidate_value(12);
  value["candidateId"] = json!("cand_1");
  assert!(validate_candidate(&value, 12, None).is_none());
  let mut value = candidate_value(12);
  value["url"] = json!("https://evil.example/put");
  assert!(validate_candidate(&value, 12, None).is_none());
  let mut value = candidate_value(12);
  // NIHO の応答に増えたキーは読み飛ばす（署名付きの header は別にちょうどの形を確かめる）
  value["extra"] = json!(true);
  assert!(validate_candidate(&value, 12, None).is_some());
}

#[test]
fn claim_shapes_are_checked() {
  assert_eq!(parse_claim(&json!({ "status": "DISABLED" })), Some(Claim::Disabled));
  assert_eq!(parse_claim(&json!({ "status": "IDLE" })), Some(Claim::Idle));
  assert_eq!(
    parse_claim(&json!({ "status": "BUSY", "runId": "run_1", "attemptId": "att_1" })),
    Some(Claim::Busy)
  );
  let job = job();
  assert_eq!(job.run_id, "run_1");
  assert_eq!(job.attempt_id, "att_1");
  assert_eq!(job.generation, 3);
  assert_eq!(
    job.container,
    ContainerRef::Folder {
      project_id: "p_kamakura".into()
    }
  );
  assert_eq!(job.step.kind, StepKind::Revision);
  assert_eq!(job.step.provider, ProviderId::Claude);
  assert_eq!(job.step.effort, StepEffort::High);
  let mut root = leased_value();
  root["containerRef"] = json!({ "kind": "root" });
  assert!(matches!(parse_claim(&root), Some(Claim::Leased(job)) if job.container == ContainerRef::Root));

  let broken: Vec<Box<dyn Fn(&mut Value)>> = vec![
    Box::new(|value| value["generation"] = json!(0)),
    Box::new(|value| value["generation"] = json!("3")),
    Box::new(|value| value["leaseUntil"] = json!("tomorrow")),
    Box::new(|value| value["runId"] = json!("run/1")),
    Box::new(|value| value["containerRef"] = json!({ "kind": "folder" })),
    Box::new(|value| value["step"]["kind"] = json!("TRANSCRIPT")),
    Box::new(|value| value["step"]["provider"] = json!("llama")),
    Box::new(|value| value["step"]["effort"] = json!("extreme")),
    Box::new(|value| value["step"]["label"] = json!("")),
    Box::new(|value| value["step"]["label"] = json!("改行\nあり")),
    Box::new(|value| {
      value["step"].as_object_mut().unwrap().remove("model");
    }),
  ];
  for mutate in broken {
    let mut value = leased_value();
    mutate(&mut value);
    assert_eq!(parse_claim(&value), None, "{value}");
  }
  // 後から増えたキーでは受け取りを止めない
  assert_eq!(
    parse_claim(&json!({ "status": "IDLE", "runId": "x" })),
    Some(Claim::Idle)
  );
  let mut extra = leased_value();
  extra["extra"] = json!(1);
  assert!(matches!(parse_claim(&extra), Some(Claim::Leased(_))));
  assert_eq!(parse_claim(&json!({ "status": "WAITING" })), None);
}

// ---------------------------------------------------------------------------
// 呼び出し（偽の HTTP の口）

struct TestSession {
  current: AtomicBool,
}

#[async_trait]
impl SessionToken for TestSession {
  fn is_current(&self) -> bool {
    self.current.load(Ordering::SeqCst)
  }
  async fn bearer(&self) -> Result<String, TokenError> {
    Ok("test-token".into())
  }
}

fn session() -> TestSession {
  TestSession {
    current: AtomicBool::new(true),
  }
}

type Responder = Box<dyn Fn(&str, &Value) -> Result<RawResponse, TransportError> + Send + Sync>;

struct RecordingTransport {
  requests: Mutex<Vec<(Method, String, String, Value)>>,
  respond: Responder,
  upload: Mutex<Vec<(String, Vec<(String, String)>, Vec<u8>)>>,
  upload_status: u16,
}

impl RecordingTransport {
  fn new(respond: Responder) -> Arc<Self> {
    Arc::new(Self {
      requests: Mutex::new(Vec::new()),
      respond,
      upload: Mutex::new(Vec::new()),
      upload_status: 200,
    })
  }
}

#[async_trait]
impl PcRunnerTransport for RecordingTransport {
  async fn send_json(
    &self,
    method: Method,
    url: &str,
    bearer: &str,
    body: Vec<u8>,
    _max_body: usize,
    _timeout: Duration,
  ) -> Result<RawResponse, TransportError> {
    let body: Value = serde_json::from_slice(&body).unwrap();
    self
      .requests
      .lock()
      .unwrap()
      .push((method, url.to_string(), bearer.to_string(), body.clone()));
    (self.respond)(url, &body)
  }
  async fn upload(&self, url: &str, headers: &[(String, String)], body: Vec<u8>) -> Result<u16, TransportError> {
    self
      .upload
      .lock()
      .unwrap()
      .push((url.to_string(), headers.to_vec(), body));
    Ok(self.upload_status)
  }
}

fn ok(value: Value) -> Result<RawResponse, TransportError> {
  Ok(RawResponse {
    status: 200,
    body: serde_json::to_vec(&value).unwrap(),
  })
}

fn status(code: u16, reason: Option<&str>) -> Result<RawResponse, TransportError> {
  let body =
    json!({ "error": { "code": "CONFLICT", "message": "m", "supportId": null, "details": { "reason": reason } } });
  Ok(RawResponse {
    status: code,
    body: serde_json::to_vec(&body).unwrap(),
  })
}

fn run<F: std::future::Future>(future: F) -> F::Output {
  tauri::async_runtime::block_on(future)
}

#[test]
fn requests_use_the_contract_paths_and_exact_bodies() {
  let transport = RecordingTransport::new(Box::new(|url, _| {
    let path = url.strip_prefix(BASE).unwrap();
    match path {
      "" => ok(json!({
        "runnerId": "r_1", "name": "Studio", "enabled": true, "connection": "subscription",
        "providers": ["claude"], "lastSeenAt": "2026-10-17T01:02:03.000Z",
      })),
      "/claim" => ok(leased_value()),
      "/prompt" => ok(json!({ "systemPrompt": "s", "userPrompt": "u", "maxOutputBytes": 1000 })),
      "/heartbeat" => ok(json!({ "leaseUntil": "2026-10-17T01:04:00.000Z" })),
      "/dispatch" => ok(json!({ "status": "SUBMITTED" })),
      "/candidate" => ok(candidate_value(6)),
      "/submit" => ok(
        json!({ "runId": "run_1", "state": "SUCCEEDED", "candidateId": CANDIDATE_ID, "generation": 3, "version": { "path": "a.md", "sha256": "a".repeat(64) } }),
      ),
      "/fail" => ok(json!({ "runId": "run_1", "state": "FAILED", "reasonCode": "provider_failed" })),
      other => panic!("{other}"),
    }
  }));
  let api = PcRunnerApi::new(transport.clone(), format!("{BASE}/"));
  let session = session();
  run(async {
    let runner_id = api
      .register(
        &session,
        &Registration {
          enabled: true,
          connection: Connection::Subscription,
          providers: vec![ProviderId::Claude, ProviderId::Gemini],
        },
      )
      .await
      .unwrap();
    assert_eq!(runner_id, "r_1");
    let Claim::Leased(job) = api.claim(&session).await.unwrap() else {
      panic!("leased");
    };
    let model = ModelChoice {
      provider: ProviderId::Claude,
      model: "claude-sonnet-4-6".into(),
      effort: StepEffort::High,
    };
    let prompt = api.prompt(&session, &job, &model).await.unwrap();
    assert_eq!(prompt.max_output_bytes, 1000);
    api.heartbeat(&session, &job).await.unwrap();
    api.dispatch(&session, &job).await.unwrap();
    let candidate = api.candidate(&session, &job, 6, None).await.unwrap();
    assert_eq!(api.upload(&candidate, b"abcdef").await.unwrap(), Uploaded::Now);
    api.submit(&session, &job, &candidate.candidate_id).await.unwrap();
    api.fail(&session, &job, FailReason::ProviderFailed).await.unwrap();
  });
  let requests = transport.requests.lock().unwrap().clone();
  let shapes: Vec<(Method, String, Value)> = requests
    .iter()
    .map(|(method, url, bearer, body)| {
      assert_eq!(bearer, "test-token");
      (*method, url.strip_prefix(BASE).unwrap().to_string(), body.clone())
    })
    .collect();
  assert_eq!(
    shapes,
    vec![
      (
        Method::Put,
        "".into(),
        json!({ "enabled": true, "connection": "subscription", "providers": ["claude", "gemini"] })
      ),
      (Method::Post, "/claim".into(), json!({})),
      (
        Method::Post,
        "/prompt".into(),
        json!({ "runId": "run_1", "attemptId": "att_1", "model": { "provider": "claude", "model": "claude-sonnet-4-6", "effort": "high" } })
      ),
      (
        Method::Post,
        "/heartbeat".into(),
        json!({ "runId": "run_1", "attemptId": "att_1" })
      ),
      (
        Method::Post,
        "/dispatch".into(),
        json!({ "runId": "run_1", "attemptId": "att_1" })
      ),
      (
        Method::Post,
        "/candidate".into(),
        json!({ "runId": "run_1", "attemptId": "att_1", "bytes": 6 })
      ),
      (
        Method::Post,
        "/submit".into(),
        json!({ "runId": "run_1", "attemptId": "att_1", "generation": 3, "candidateId": CANDIDATE_ID })
      ),
      (
        Method::Post,
        "/fail".into(),
        json!({ "runId": "run_1", "attemptId": "att_1", "reason": "provider_failed" })
      ),
    ]
  );
  let uploads = transport.upload.lock().unwrap().clone();
  assert_eq!(uploads.len(), 1);
  assert_eq!(uploads[0].0, signed_url());
  assert_eq!(uploads[0].2, b"abcdef".to_vec());
  assert_eq!(uploads[0].1.len(), 3);
}

#[test]
fn errors_map_to_login_offline_rejected_and_protocol() {
  let api = |respond: Responder| PcRunnerApi::new(RecordingTransport::new(respond), BASE.into());
  let session = session();
  run(async {
    assert_eq!(
      api(Box::new(|_, _| status(401, None))).claim(&session).await,
      Err(ApiError::AuthRequired)
    );
    // 停止スイッチ（#18892・D-18）の 401 は、ログインのやり直しではなく再開待ち（通信できないのと同じ）
    assert_eq!(
      api(Box::new(|_, _| status(401, Some("app_connect_disabled"))))
        .claim(&session)
        .await,
      Err(ApiError::Offline)
    );
    assert_eq!(
      api(Box::new(|_, _| status(401, Some("app_connection_revoked"))))
        .claim(&session)
        .await,
      Err(ApiError::AuthRequired)
    );
    assert_eq!(
      api(Box::new(|_, _| status(409, Some("pc_provider_not_registered"))))
        .claim(&session)
        .await,
      Err(ApiError::Rejected {
        status: 409,
        reason: Some("pc_provider_not_registered".into())
      })
    );
    assert_eq!(
      api(Box::new(|_, _| status(503, None))).claim(&session).await,
      Err(ApiError::Offline)
    );
    assert_eq!(
      api(Box::new(|_, _| status(429, None))).claim(&session).await,
      Err(ApiError::Offline)
    );
    assert_eq!(
      api(Box::new(|_, _| Err(TransportError::Timeout))).claim(&session).await,
      Err(ApiError::Offline)
    );
    assert_eq!(
      api(Box::new(|_, _| status(302, None))).claim(&session).await,
      Err(ApiError::Protocol)
    );
    assert_eq!(
      api(Box::new(|_, _| ok(json!({ "status": "LEASED" }))))
        .claim(&session)
        .await,
      Err(ApiError::Protocol)
    );
    let job = job();
    // 提出の応答が別の候補・別の世代なら受け取ったことにしない
    let wrong = api(Box::new(|_, _| {
      ok(
        json!({ "runId": "run_1", "state": "SUCCEEDED", "candidateId": CANDIDATE_ID, "generation": 4, "version": null }),
      )
    }));
    assert_eq!(
      wrong.submit(&session, &job, CANDIDATE_ID).await,
      Err(ApiError::Protocol)
    );
  });
  // ログアウトした session では通信しない
  let transport = RecordingTransport::new(Box::new(|_, _| ok(json!({ "status": "IDLE" }))));
  let api = PcRunnerApi::new(transport.clone(), BASE.into());
  let ended = TestSession {
    current: AtomicBool::new(false),
  };
  assert_eq!(run(api.claim(&ended)), Err(ApiError::SessionChanged));
  assert!(transport.requests.lock().unwrap().is_empty());
}

#[test]
fn upload_412_means_already_uploaded() {
  let transport = Arc::new(RecordingTransport {
    requests: Mutex::new(Vec::new()),
    respond: Box::new(|_, _| ok(json!({}))),
    upload: Mutex::new(Vec::new()),
    upload_status: 412,
  });
  let api = PcRunnerApi::new(transport, BASE.into());
  let candidate = validate_candidate(&candidate_value(3), 3, None).unwrap();
  assert_eq!(run(api.upload(&candidate, b"abc")), Ok(Uploaded::Already));
}
