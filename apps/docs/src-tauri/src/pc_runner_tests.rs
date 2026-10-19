//! pc_runner.rs のテスト（通信しない・AI へ送らない）。NIHO API は偽の HTTP の口、AI は偽の runner、Tauri は偽の Host。

use super::*;
use crate::contract::{
  ClaudeUpdate, EventSink, LlmRunner, MaintenanceError, ProviderCapabilities, ProviderUsage, ReasonCode, TurnHandle,
  Usage,
};
use crate::pc_runner_api::{RawResponse, TransportError};
use async_trait::async_trait;
use std::collections::VecDeque;
use std::sync::atomic::AtomicUsize;
use std::sync::Condvar;

const BASE: &str = "https://niho.life/api/me/docs-pc-runner";
const CANDIDATE_ID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

fn temp_dir(name: &str) -> PathBuf {
  let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
    "niho-docs-pc-runner-{name}-{}-{}",
    std::process::id(),
    crate::process::hex(&crate::process::random_bytes::<4>().unwrap())
  ));
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

fn run<F: std::future::Future>(future: F) -> F::Output {
  tauri::async_runtime::block_on(future)
}

fn timing() -> Timing {
  Timing {
    idle: Duration::from_millis(10),
    backoff_min: Duration::from_millis(10),
    backoff_max: Duration::from_millis(20),
    login_recheck: Duration::from_millis(10),
    heartbeat_max: Duration::from_millis(20),
    heartbeat_min: Duration::from_millis(5),
    retry_base: Duration::from_millis(1),
    retries: 3,
    stop_wait: Duration::from_secs(2),
  }
}

fn settings(connection: &str, providers: &[&str], profiles: Value) -> Value {
  let mut connections = json!({
    "subscription": { "providers": ["claude"], "profiles": [] },
    "apiKey": { "providers": [], "profiles": [] },
  });
  connections[connection] = json!({ "providers": providers, "profiles": profiles });
  json!({ "version": 3, "connection": connection, "connections": connections })
}

fn standard_profiles() -> Value {
  json!([
    { "id": "standard", "name": "標準", "models": {
      "claude": { "model": "claude-sonnet-4-6", "effort": "high" },
      "gpt": { "model": "gpt-5.6-terra", "effort": "high" },
      "gemini": { "model": "gemini-3.8-flash", "effort": "medium" },
    } },
    { "id": "custom", "name": "自分用", "models": {
      "claude": { "model": "claude-custom-x", "effort": "max" },
    } },
  ])
}

fn step(provider: ProviderId, model: &str, effort: StepEffort) -> JobStep {
  JobStep {
    step_key: "revision".into(),
    kind: StepKind::Revision,
    label: "文字起こしの修正".into(),
    provider,
    model: model.into(),
    effort,
  }
}

// ---------------------------------------------------------------------------
// モデルの決め方・送る前の確かめ・設定

#[test]
fn model_resolution_follows_this_macs_registration() {
  let sub = mac_ai(Some(&settings(
    "subscription",
    &["claude", "gemini"],
    standard_profiles(),
  )));
  // 登録した AI・使えるモデルはそのまま
  let resolved = resolve_model(&sub, &step(ProviderId::Claude, "claude-opus-4-8", StepEffort::High)).unwrap();
  assert_eq!(resolved.choice.model, "claude-opus-4-8");
  assert_eq!(resolved.choice.effort, StepEffort::High);
  assert_eq!(resolved.contract, Provider::ClaudeCode);
  assert_eq!(resolved.request_effort, Some(Effort::High));
  // 登録していない AI は使わない（別の AI に切り替えない）
  assert_eq!(
    resolve_model(&sub, &step(ProviderId::Gpt, "gpt-5.6-terra", StepEffort::High)),
    None
  );
  // 使えないモデルは標準のプロファイルのモデル
  let fallback = resolve_model(&sub, &step(ProviderId::Claude, "claude-unknown-9", StepEffort::Low)).unwrap();
  assert_eq!(fallback.choice.model, "claude-sonnet-4-6");
  assert_eq!(fallback.choice.effort, StepEffort::Low);
  // プロファイルにだけあるモデルも使える
  let custom = resolve_model(&sub, &step(ProviderId::Claude, "claude-custom-x", StepEffort::Max)).unwrap();
  assert_eq!(custom.choice.model, "claude-custom-x");
  // Gemini: 思考量入りの名前はその思考量で、思考量は CLI に渡さない
  let suffixed = resolve_model(
    &sub,
    &step(ProviderId::Gemini, "gemini-3.8-flash-high", StepEffort::Low),
  )
  .unwrap();
  assert_eq!(suffixed.choice.effort, StepEffort::High);
  assert_eq!(suffixed.request_effort, None);
  assert_eq!(suffixed.contract, Provider::GeminiCli);
  // Gemini の最大は無いので高へ寄せる
  let fitted = resolve_model(&sub, &step(ProviderId::Gemini, "gemini-3.8-flash", StepEffort::Max)).unwrap();
  assert_eq!(fitted.choice.effort, StepEffort::High);
  assert_eq!(fitted.request_effort, Some(Effort::High));

  let api = mac_ai(Some(&settings(
    "apiKey",
    &["claude", "gpt", "gemini"],
    standard_profiles(),
  )));
  assert_eq!(api.connection, Connection::ApiKey);
  assert_eq!(
    resolve_model(&api, &step(ProviderId::Claude, "claude-sonnet-4-6", StepEffort::Medium))
      .unwrap()
      .contract,
    Provider::AnthropicApi
  );
  assert_eq!(
    resolve_model(&api, &step(ProviderId::Gpt, "gpt-5.6-luna", StepEffort::Medium))
      .unwrap()
      .contract,
    Provider::OpenAiApi
  );
  let pro = resolve_model(
    &api,
    &step(ProviderId::Gemini, "gemini-3.1-pro-preview", StepEffort::High),
  )
  .unwrap();
  assert_eq!(
    (pro.contract, pro.choice.model.as_str()),
    (Provider::GeminiApi, "gemini-3.1-pro-preview")
  );
  // CLI の別名は API キー方式では使えない → 標準のモデル
  let alias = resolve_model(&api, &step(ProviderId::Claude, "sonnet", StepEffort::High)).unwrap();
  assert_eq!(alias.choice.model, "claude-sonnet-4-6");

  // 標準が無ければ先頭のプロファイル、プロファイルも無ければ使えない
  let first_only = mac_ai(Some(&settings(
    "subscription",
    &["claude"],
    json!([{ "id": "custom", "models": { "claude": { "model": "claude-custom-x", "effort": "high" } } }]),
  )));
  assert_eq!(
    resolve_model(&first_only, &step(ProviderId::Claude, "nope", StepEffort::High))
      .unwrap()
      .choice
      .model,
    "claude-custom-x"
  );
  let bare = mac_ai(Some(&settings("subscription", &["claude"], json!([]))));
  assert_eq!(
    resolve_model(&bare, &step(ProviderId::Claude, "nope", StepEffort::High)),
    None
  );
}

#[test]
fn settings_are_read_leniently() {
  // settings.json は人が設定を変えるまで書かれない。無いときは画面の既定（サブスクリプション・Claude）で登録する
  let missing = mac_ai(None);
  assert_eq!(missing.connection, Connection::Subscription);
  assert_eq!(missing.providers, vec![ProviderId::Claude]);
  assert_eq!(mac_ai(Some(&json!("broken"))).providers, vec![ProviderId::Claude]);
  // providers の欄が無ければ、サブスクリプションは Claude、API キーは無し（settings.ts の normalizeConnection）
  let no_field =
    json!({ "version": 4, "connection": "subscription", "connections": { "subscription": { "profiles": [] } } });
  assert_eq!(mac_ai(Some(&no_field)).providers, vec![ProviderId::Claude]);
  let api_no_field =
    json!({ "version": 4, "connection": "apiKey", "connections": { "subscription": { "providers": ["gpt"] } } });
  let api = mac_ai(Some(&api_no_field));
  assert_eq!(api.connection, Connection::ApiKey);
  assert!(api.providers.is_empty());
  // 登録をすべて外した（空の配列）は既定に戻さない
  let emptied =
    json!({ "version": 4, "connection": "subscription", "connections": { "subscription": { "providers": [] } } });
  assert!(mac_ai(Some(&emptied)).providers.is_empty());
  // 版 1（S1）: サブスクリプションの providers・profiles を直に持つ
  let v1 = mac_ai(Some(&json!({ "providers": ["gpt"], "profiles": [] })));
  assert_eq!(v1.connection, Connection::Subscription);
  assert_eq!(v1.providers, vec![ProviderId::Gpt]);
  let messy = mac_ai(Some(&json!({
    "connection": "carrier-pigeon",
    "connections": { "subscription": { "providers": ["gemini", "llama", "gemini", 3, "claude"], "profiles": [{ "id": 1 }, { "id": "p", "models": { "gpt": { "model": " " } } }] } },
  })));
  assert_eq!(messy.connection, Connection::Subscription);
  assert_eq!(messy.providers, vec![ProviderId::Gemini, ProviderId::Claude]);
  assert_eq!(
    messy.profiles,
    vec![ProfileModels {
      id: "p".into(),
      models: vec![]
    }]
  );
}

#[test]
fn effort_fitting_matches_docs_core() {
  assert_eq!(
    fit_effort(ProviderId::Claude, "claude-sonnet-4-6", StepEffort::Max),
    StepEffort::Max
  );
  assert_eq!(
    fit_effort(ProviderId::Gemini, "gemini-3.8-flash", StepEffort::Max),
    StepEffort::High
  );
  assert_eq!(
    fit_effort(ProviderId::Gemini, "gemini-3.8-flash-low", StepEffort::Max),
    StepEffort::Low
  );
  assert_eq!(
    fit_effort(ProviderId::Gemini, "gemini-3.8-flash-medium", StepEffort::Low),
    StepEffort::Medium
  );
  assert_eq!(
    fit_effort(ProviderId::Gemini, "-high", StepEffort::Max),
    StepEffort::High
  );
}

fn ready_status() -> ProviderStatus {
  ProviderStatus {
    installed: true,
    authenticated: true,
    login_method: Some("Claude Max account".into()),
    capabilities: ProviderCapabilities {
      tools_off_proven: true,
      ..ProviderCapabilities::default()
    },
    ..ProviderStatus::default()
  }
}

#[test]
fn readiness_requires_a_tools_off_subscription_login() {
  assert!(provider_ready(Connection::Subscription, &ready_status()));
  let not_ready: Vec<Box<dyn Fn(&mut ProviderStatus)>> = vec![
    Box::new(|status| status.installed = false),
    Box::new(|status| status.authenticated = false),
    Box::new(|status| status.login_method = Some("API key".into())),
    Box::new(|status| status.login_method = Some("ANTHROPIC_API-KEY".into())),
    Box::new(|status| status.reason = Some("auth_probe_failed".into())),
    Box::new(|status| status.missing_cli_flags = vec!["--effort".into()]),
    Box::new(|status| status.capabilities.tools_off_proven = false),
  ];
  for mutate in not_ready {
    let mut status = ready_status();
    mutate(&mut status);
    assert!(!provider_ready(Connection::Subscription, &status), "{status:?}");
  }
  // API キー方式は鍵があること（ProviderRouter の状態の authenticated）
  let saved = ProviderStatus {
    installed: true,
    authenticated: true,
    login_method: Some("API キー".into()),
    ..ProviderStatus::default()
  };
  assert!(provider_ready(Connection::ApiKey, &saved));
  assert!(!provider_ready(
    Connection::ApiKey,
    &ProviderStatus {
      authenticated: false,
      ..saved
    }
  ));
}

#[test]
fn local_setting_file_round_trips() {
  let dir = temp_dir("setting");
  assert!(!read_enabled(&dir));
  write_enabled(&dir, true).unwrap();
  assert!(read_enabled(&dir));
  assert_eq!(
    serde_json::from_slice::<Value>(&std::fs::read(dir.join("pc-runner.json")).unwrap()).unwrap(),
    json!({ "enabled": true })
  );
  write_enabled(&dir, false).unwrap();
  assert!(!read_enabled(&dir));
  std::fs::write(dir.join("pc-runner.json"), b"{broken").unwrap();
  assert!(!read_enabled(&dir));
  // 一時ファイルは残さない
  let leftovers: Vec<_> = std::fs::read_dir(&dir)
    .unwrap()
    .filter_map(|entry| entry.ok())
    .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
    .collect();
  assert!(leftovers.is_empty());
  let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn status_lines_match_the_design_guide() {
  let line = |state, label: Option<&str>| {
    status_line(&PcRunnerStatus {
      enabled: true,
      state,
      label: label.map(str::to_string),
      runner_id: Some("runner-test".into()),
    })
  };
  assert_eq!(line(RunnerState::Idle, None), "待機中");
  assert_eq!(
    line(RunnerState::Running, Some("文字起こしの修正")),
    "処理中: 文字起こしの修正"
  );
  assert_eq!(
    line(RunnerState::NeedsLogin, None),
    "NIHO アカウントでのログインが必要です"
  );
  assert_eq!(line(RunnerState::Offline, None), "NIHO に接続できません");
  assert_eq!(line(RunnerState::Starting, None), "準備中");
  assert_eq!(
    serde_json::to_value(PcRunnerStatus {
      enabled: true,
      state: RunnerState::NeedsLogin,
      label: None,
      runner_id: Some("runner-test".into())
    })
    .unwrap(),
    json!({ "enabled": true, "state": "needs_login", "label": null, "runnerId": "runner-test" })
  );
}

#[test]
fn gate_refuses_local_runs_while_claiming_or_running() {
  let dir = temp_dir("gate");
  let state = AppState::for_tests(Arc::new(FakeLlm::new(Arc::default())), dir.clone());
  for (phase, blocked) in [
    (Phase::Off, false),
    (Phase::Idle, false),
    (Phase::Claiming, true),
    (Phase::Running, true),
  ] {
    state.pc_gate.set(phase);
    let refused = refuse_local_run(&state);
    assert_eq!(refused.is_err(), blocked, "{phase:?}");
    if let Err(error) = refused {
      assert_eq!(error.code, "pc_runner_busy");
      assert_eq!(error.message, BUSY_MESSAGE);
    }
  }
  let _ = std::fs::remove_dir_all(dir);
}

// ---------------------------------------------------------------------------
// 偽物

type Log = Arc<Mutex<Vec<String>>>;

fn entries(log: &Log) -> Vec<String> {
  lock(log).clone()
}

/// heartbeat を除いた呼び出しの順。
fn calls(log: &Log) -> Vec<String> {
  entries(log).into_iter().filter(|entry| entry != "heartbeat").collect()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Script {
  Output(&'static str),
  /// 出力の上限で止まった（途中までの本文）。
  Truncated(&'static str),
  Error,
  WaitForStop,
}

struct StopSignal(Mutex<bool>, Condvar);

struct FakeHandle(Arc<StopSignal>);

impl TurnHandle for FakeHandle {
  fn stop(&self) {
    *self.0 .0.lock().unwrap() = true;
    self.0 .1.notify_all();
  }
}

struct FakeLlm {
  log: Log,
  status: Mutex<ProviderStatus>,
  script: Mutex<Script>,
  requests: Mutex<Vec<TurnRequest>>,
  busy: AtomicBool,
}

impl FakeLlm {
  fn new(log: Log) -> Self {
    Self {
      log,
      status: Mutex::new(ready_status()),
      script: Mutex::new(Script::Output("# 修正版\n本文")),
      requests: Mutex::new(Vec::new()),
      busy: AtomicBool::new(false),
    }
  }
}

fn done(text: &str, stop_reason: StopReason) -> TurnEvent {
  TurnEvent::Done {
    text: text.into(),
    stop_reason,
    session_id: None,
    usage: Usage::default(),
    duration_ms: 1,
    continuations: 0,
  }
}

impl LlmRunner for FakeLlm {
  fn run_turn(&self, request: TurnRequest, mut on_event: EventSink) -> Arc<dyn TurnHandle> {
    lock(&self.log).push("turn".into());
    assert!(request.workdir.is_dir(), "作業フォルダは送る前に作る");
    lock(&self.requests).push(request);
    let signal = Arc::new(StopSignal(Mutex::new(false), Condvar::new()));
    let script = *lock(&self.script);
    let waiting = signal.clone();
    std::thread::spawn(move || match script {
      Script::Output(text) => on_event(done(text, StopReason::EndTurn)),
      Script::Truncated(text) => on_event(done(text, StopReason::MaxTokens)),
      Script::Error => on_event(TurnEvent::Error {
        reason_code: ReasonCode::TransientFailure,
        message: "fake".into(),
      }),
      Script::WaitForStop => {
        let mut stopped = waiting.0.lock().unwrap();
        while !*stopped {
          stopped = waiting.1.wait(stopped).unwrap();
        }
        on_event(done("", StopReason::Stopped));
      }
    });
    Arc::new(FakeHandle(signal))
  }
  fn provider_status(&self, _provider: Provider) -> ProviderStatus {
    lock(&self.status).clone()
  }
  fn start_auth(&self, _provider: Provider) -> Result<ProviderStatus, MaintenanceError> {
    unimplemented!()
  }
  fn install_claude(&self) -> Result<ProviderStatus, MaintenanceError> {
    unimplemented!()
  }
  fn update_claude(&self) -> Result<ClaudeUpdate, MaintenanceError> {
    unimplemented!()
  }
  fn has_running_turns(&self) -> bool {
    self.busy.load(Ordering::SeqCst)
  }
  fn provider_usage(&self, _provider: Provider) -> Result<ProviderUsage, MaintenanceError> {
    unimplemented!()
  }
  fn shutdown(&self) {}
}

/// 偽の NIHO API。呼び出しの順を log に、本文を bodies に残す。
struct FakeServer {
  log: Log,
  bodies: Mutex<Vec<(String, Value)>>,
  claims: Mutex<VecDeque<Value>>,
  register_error: Mutex<Option<Result<RawResponse, TransportError>>>,
  prompt_error: Mutex<Option<(u16, &'static str)>>,
  heartbeat_conflict: AtomicBool,
  heartbeat_unauthorized: AtomicBool,
  submit_network_errors: AtomicUsize,
  uploads: Mutex<VecDeque<Result<u16, TransportError>>>,
  max_output_bytes: AtomicUsize,
  /// claim・dispatch の応答を返す前に一度だけ呼ぶ（応答を待つ間の操作を起こす）。
  claim_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
  dispatch_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl FakeServer {
  fn new(log: Log) -> Arc<Self> {
    Arc::new(Self {
      log,
      bodies: Mutex::new(Vec::new()),
      claims: Mutex::new(VecDeque::new()),
      register_error: Mutex::new(None),
      prompt_error: Mutex::new(None),
      heartbeat_conflict: AtomicBool::new(false),
      heartbeat_unauthorized: AtomicBool::new(false),
      submit_network_errors: AtomicUsize::new(0),
      uploads: Mutex::new(VecDeque::new()),
      max_output_bytes: AtomicUsize::new(1024 * 1024),
      claim_hook: Mutex::new(None),
      dispatch_hook: Mutex::new(None),
    })
  }

  fn bodies_of(&self, name: &str) -> Vec<Value> {
    lock(&self.bodies)
      .iter()
      .filter(|(call, _)| call == name)
      .map(|(_, body)| body.clone())
      .collect()
  }
}

fn reply(status: u16, value: Value) -> Result<RawResponse, TransportError> {
  Ok(RawResponse {
    status,
    body: serde_json::to_vec(&value).unwrap(),
  })
}

fn error_reply(status: u16, reason: &str) -> Result<RawResponse, TransportError> {
  reply(
    status,
    json!({ "error": { "code": "CONFLICT", "message": "m", "supportId": null, "details": { "reason": reason } } }),
  )
}

fn lease_until() -> String {
  (Utc::now() + chrono::Duration::seconds(90)).to_rfc3339()
}

fn leased(provider: &str, model: &str) -> Value {
  json!({
    "status": "LEASED",
    "runId": "run_1",
    "attemptId": "att_1",
    "generation": 2,
    "leaseUntil": lease_until(),
    "containerRef": { "kind": "folder", "projectId": "p_kamakura" },
    "recordingPageId": "page_1",
    "step": { "stepKey": "revision", "kind": "REVISION", "label": "文字起こしの修正", "provider": provider, "model": model, "effort": "high" },
  })
}

fn candidate(bytes: u64) -> Value {
  json!({
    "candidateId": CANDIDATE_ID,
    "url": "https://storage.googleapis.com/niho-docs-runs/c.md?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc&X-Goog-Date=20261017T010203Z&X-Goog-Expires=900&X-Goog-SignedHeaders=content-type%3Bhost%3Bx-goog-content-length-range%3Bx-goog-if-generation-match&X-Goog-Signature=abc123",
    "headers": {
      "content-type": "text/markdown",
      "x-goog-if-generation-match": "0",
      "x-goog-content-length-range": format!("{bytes},{bytes}"),
    },
    "expiresAt": (Utc::now() + chrono::Duration::seconds(900)).to_rfc3339(),
    "candidateExpiresAt": (Utc::now() + chrono::Duration::seconds(3600)).to_rfc3339(),
    "bytes": bytes,
    "maxBytes": 8 * 1024 * 1024,
  })
}

#[async_trait]
impl PcRunnerTransport for FakeServer {
  async fn send_json(
    &self,
    method: crate::pc_runner_api::Method,
    url: &str,
    bearer: &str,
    body: Vec<u8>,
    _max_body: usize,
    _timeout: Duration,
  ) -> Result<RawResponse, TransportError> {
    assert_eq!(bearer, "test-token");
    let body: Value = serde_json::from_slice(&body).unwrap();
    let name = match url.strip_prefix(BASE).unwrap() {
      "" => {
        assert_eq!(method, crate::pc_runner_api::Method::Put);
        "register"
      }
      path => path.trim_start_matches('/'),
    }
    .to_string();
    lock(&self.log).push(name.clone());
    lock(&self.bodies).push((name.clone(), body.clone()));
    match name.as_str() {
      "register" => {
        if let Some(error) = lock(&self.register_error).take() {
          return error;
        }
        reply(
          200,
          json!({ "runnerId": "r_1", "name": "Studio", "enabled": body["enabled"], "connection": body["connection"], "providers": body["providers"], "lastSeenAt": null }),
        )
      }
      "claim" => {
        if let Some(hook) = lock(&self.claim_hook).take() {
          hook();
        }
        reply(
          200,
          lock(&self.claims).pop_front().unwrap_or(json!({ "status": "IDLE" })),
        )
      }
      "prompt" => match *lock(&self.prompt_error) {
        Some((status, reason)) => error_reply(status, reason),
        None => reply(
          200,
          json!({ "systemPrompt": "決まり", "userPrompt": "文字起こし", "maxOutputBytes": self.max_output_bytes.load(Ordering::SeqCst) }),
        ),
      },
      "heartbeat" => {
        if self.heartbeat_unauthorized.load(Ordering::SeqCst) {
          error_reply(401, "unauthorized")
        } else if self.heartbeat_conflict.load(Ordering::SeqCst) {
          error_reply(409, "stale_attempt")
        } else {
          reply(200, json!({ "leaseUntil": lease_until() }))
        }
      }
      "dispatch" => {
        if let Some(hook) = lock(&self.dispatch_hook).take() {
          hook();
        }
        reply(200, json!({ "status": "SUBMITTED" }))
      }
      "candidate" => reply(200, candidate(body["bytes"].as_u64().unwrap())),
      "submit" => {
        if self.submit_network_errors.load(Ordering::SeqCst) > 0 {
          self.submit_network_errors.fetch_sub(1, Ordering::SeqCst);
          return Err(TransportError::Network);
        }
        reply(
          200,
          json!({ "runId": "run_1", "state": "SUCCEEDED", "candidateId": body["candidateId"], "generation": 2, "version": null }),
        )
      }
      "fail" => reply(
        200,
        json!({ "runId": "run_1", "state": "FAILED", "reasonCode": body["reason"] }),
      ),
      other => panic!("unexpected {other}"),
    }
  }

  async fn upload(&self, url: &str, headers: &[(String, String)], body: Vec<u8>) -> Result<u16, TransportError> {
    assert!(url.starts_with("https://storage.googleapis.com/"));
    assert_eq!(headers.len(), 3);
    assert!(!body.is_empty());
    lock(&self.log).push("upload".into());
    lock(&self.uploads).pop_front().unwrap_or(Ok(200))
  }
}

struct TestSession {
  current: AtomicBool,
}

#[async_trait]
impl SessionToken for TestSession {
  fn is_current(&self) -> bool {
    self.current.load(Ordering::SeqCst)
  }
  async fn bearer(&self) -> Result<String, crate::pc_runner_api::TokenError> {
    Ok("test-token".into())
  }
}

struct TestAccount {
  signed_in: AtomicBool,
  session: Arc<TestSession>,
}

impl AccountGate for TestAccount {
  fn begin(&self) -> Option<Arc<dyn SessionToken>> {
    self
      .signed_in
      .load(Ordering::SeqCst)
      .then(|| self.session.clone() as Arc<dyn SessionToken>)
  }
}

struct TestHost {
  app: AppState,
  submitted: Mutex<Vec<ContainerRef>>,
  statuses: Mutex<Vec<PcRunnerStatus>>,
  resident: Mutex<Vec<&'static str>>,
  login_item_fails: AtomicBool,
  other_process: AtomicBool,
  container_busy: AtomicBool,
}

impl Host for TestHost {
  fn app(&self) -> &AppState {
    &self.app
  }
  fn after_submit(&self, container: &ContainerRef) {
    lock(&self.submitted).push(container.clone());
  }
  fn status_changed(&self, status: &PcRunnerStatus) {
    lock(&self.statuses).push(status.clone());
  }
  fn resident_on(&self, _status: &PcRunnerStatus) -> std::io::Result<()> {
    lock(&self.resident).push("on");
    if self.login_item_fails.load(Ordering::SeqCst) {
      Err(std::io::Error::other("LaunchAgents is read-only"))
    } else {
      Ok(())
    }
  }
  fn resident_off(&self) {
    lock(&self.resident).push("off");
  }
  fn other_process_running(&self) -> bool {
    self.other_process.load(Ordering::SeqCst)
  }
  fn lock_container(&self, _container: &ContainerRef) -> Result<Option<RunLockGuard>, ContainerBusy> {
    if self.container_busy.load(Ordering::SeqCst) {
      Err(ContainerBusy)
    } else {
      Ok(None)
    }
  }
}

struct Rig {
  dir: PathBuf,
  log: Log,
  llm: Arc<FakeLlm>,
  server: Arc<FakeServer>,
  host: Arc<TestHost>,
  account: Arc<TestAccount>,
  runner: PcRunner,
}

impl Rig {
  fn new(name: &str, settings_value: Option<Value>, enabled: bool) -> Self {
    let dir = temp_dir(name);
    if let Some(value) = settings_value {
      std::fs::write(dir.join("settings.json"), serde_json::to_vec(&value).unwrap()).unwrap();
    }
    let log: Log = Arc::default();
    let llm = Arc::new(FakeLlm::new(log.clone()));
    let server = FakeServer::new(log.clone());
    let host = Arc::new(TestHost {
      app: AppState::for_tests(llm.clone(), dir.clone()),
      submitted: Mutex::new(Vec::new()),
      statuses: Mutex::new(Vec::new()),
      resident: Mutex::new(Vec::new()),
      login_item_fails: AtomicBool::new(false),
      other_process: AtomicBool::new(false),
      container_busy: AtomicBool::new(false),
    });
    let account = Arc::new(TestAccount {
      signed_in: AtomicBool::new(true),
      session: Arc::new(TestSession {
        current: AtomicBool::new(true),
      }),
    });
    let runner = PcRunner::new(
      host.clone(),
      account.clone(),
      PcRunnerApi::new(server.clone(), BASE.into()),
      timing(),
      Arc::new(|_, _| {}),
      enabled,
    );
    Self {
      dir,
      log,
      llm,
      server,
      host,
      account,
      runner,
    }
  }

  fn default_subscription(name: &str) -> Self {
    Self::new(
      name,
      Some(settings("subscription", &["claude", "gemini"], standard_profiles())),
      true,
    )
  }

  fn tick(&self) -> Tick {
    run(self.runner.tick_for_tests(self.account.session.as_ref()))
  }
}

impl Drop for Rig {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.dir);
  }
}

#[test]
fn account_session_changes_clear_the_previous_runner_id() {
  for end in [SessionEnd::AuthRequired, SessionEnd::SessionChanged] {
    let rig = Rig::default_subscription("session-change-runner-id");
    *lock(&rig.runner.inner.runner_id) = Some("runner-old-account".into());
    rig.runner.inner.clear_runner_for_session_end(end);
    assert_eq!(rig.runner.status().runner_id, None);
  }
}

#[test]
fn disabling_keeps_the_runner_id_until_the_disable_registration_finishes() {
  let rig = Rig::default_subscription("disabled-runner-id");
  *lock(&rig.runner.inner.runner_id) = Some("runner-current-account".into());
  rig.runner.inner.clear_runner_for_session_end(SessionEnd::Disabled);
  assert_eq!(rig.runner.status().runner_id.as_deref(), Some("runner-current-account"));
}

// ---------------------------------------------------------------------------
// 受け取りと実行

#[test]
fn idle_claim_waits_and_resets_the_gate() {
  let rig = Rig::default_subscription("idle");
  assert_eq!(rig.tick(), Tick::Idle);
  assert_eq!(calls(&rig.log), vec!["claim"]);
  assert_eq!(rig.server.bodies_of("claim"), vec![json!({})]);
  assert_eq!(rig.host.app.pc_gate.phase(), Phase::Idle);
  lock(&rig.server.claims).push_back(json!({ "status": "BUSY", "runId": "run_0", "attemptId": "att_0" }));
  assert_eq!(rig.tick(), Tick::Idle);
  lock(&rig.server.claims).push_back(json!({ "status": "DISABLED" }));
  assert_eq!(rig.tick(), Tick::Disabled);
}

#[test]
fn leased_job_runs_prompt_dispatch_turn_candidate_upload_submit_in_order() {
  let rig = Rig::default_subscription("happy");
  lock(&rig.server.claims).push_back(leased("claude", "claude-opus-4-8"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(
    calls(&rig.log),
    vec!["claim", "prompt", "dispatch", "turn", "candidate", "upload", "submit"]
  );
  assert_eq!(
    rig.server.bodies_of("prompt"),
    vec![
      json!({ "runId": "run_1", "attemptId": "att_1", "model": { "provider": "claude", "model": "claude-opus-4-8", "effort": "high" } })
    ]
  );
  let output = "# 修正版\n本文".as_bytes().len();
  assert_eq!(
    rig.server.bodies_of("candidate"),
    vec![json!({ "runId": "run_1", "attemptId": "att_1", "bytes": output })]
  );
  assert_eq!(
    rig.server.bodies_of("submit"),
    vec![json!({ "runId": "run_1", "attemptId": "att_1", "generation": 2, "candidateId": CANDIDATE_ID })]
  );
  let requests = lock(&rig.llm.requests);
  assert_eq!(requests.len(), 1);
  let request = &requests[0];
  assert_eq!(request.provider, Provider::ClaudeCode);
  assert_eq!(request.model, "claude-opus-4-8");
  assert_eq!(request.effort, Some(Effort::High));
  assert_eq!(request.system_prompt, "決まり");
  assert_eq!(request.user_prompt, "文字起こし");
  assert_eq!(request.resume_session, None);
  assert_eq!(request.tool_policy, ToolPolicy::None);
  assert_eq!(request.max_budget_usd, None);
  assert_eq!(request.workdir, rig.dir.join("workspaces").join("pc-att_1"));
  // 作業フォルダは終わったら消す
  assert!(!request.workdir.exists());
  assert_eq!(
    *lock(&rig.host.submitted),
    vec![ContainerRef::Folder {
      project_id: "p_kamakura".into()
    }]
  );
  assert_eq!(rig.host.app.pc_gate.phase(), Phase::Idle);
  // 実行中は工程名を出していた
  assert!(lock(&rig.host.statuses)
    .iter()
    .any(|status| status.state == RunnerState::Running && status.label.as_deref() == Some("文字起こしの修正")));
}

#[test]
fn heartbeat_conflict_stops_the_turn_and_submits_nothing() {
  let rig = Rig::default_subscription("heartbeat");
  *lock(&rig.llm.script) = Script::WaitForStop;
  rig.server.heartbeat_conflict.store(true, Ordering::SeqCst);
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  let log = entries(&rig.log);
  assert_eq!(log[..4], ["claim", "prompt", "dispatch", "turn"]);
  assert!(log.contains(&"heartbeat".to_string()));
  for unexpected in ["candidate", "upload", "submit", "fail"] {
    assert!(!log.contains(&unexpected.to_string()), "{log:?}");
  }
  assert!(lock(&rig.host.submitted).is_empty());
}

#[test]
fn unregistered_or_unready_provider_fails_before_prompt() {
  let rig = Rig::default_subscription("not-ready");
  lock(&rig.server.claims).push_back(leased("gpt", "gpt-5.6-terra"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(calls(&rig.log), vec!["claim", "fail"]);
  assert_eq!(
    rig.server.bodies_of("fail"),
    vec![json!({ "runId": "run_1", "attemptId": "att_1", "reason": "provider_not_ready" })]
  );

  let rig = Rig::default_subscription("not-logged-in");
  lock(&rig.llm.status).authenticated = false;
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(calls(&rig.log), vec!["claim", "fail"]);
  assert_eq!(rig.server.bodies_of("fail")[0]["reason"], "provider_not_ready");
  assert!(lock(&rig.llm.requests).is_empty());

  // 設定が無い Mac（人が設定を変えていない）は画面の既定（サブスクリプション・Claude）で動く。Claude 以外の工程は止める
  let rig = Rig::new("no-settings", None, true);
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(
    calls(&rig.log),
    vec!["claim", "prompt", "dispatch", "turn", "candidate", "upload", "submit"]
  );
  let rig = Rig::new("no-settings-gpt", None, true);
  lock(&rig.server.claims).push_back(leased("gpt", "gpt-5.6-terra"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(calls(&rig.log), vec!["claim", "fail"]);
  assert_eq!(rig.server.bodies_of("fail")[0]["reason"], "provider_not_ready");
}

#[test]
fn ai_failure_after_dispatch_is_provider_failed() {
  let rig = Rig::default_subscription("ai-error");
  *lock(&rig.llm.script) = Script::Error;
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(calls(&rig.log), vec!["claim", "prompt", "dispatch", "turn", "fail"]);
  assert_eq!(rig.server.bodies_of("fail")[0]["reason"], "provider_failed");

  // 空の出力・上限を超える出力も provider_failed（候補は作らない）
  let rig = Rig::default_subscription("ai-empty");
  *lock(&rig.llm.script) = Script::Output("");
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(calls(&rig.log), vec!["claim", "prompt", "dispatch", "turn", "fail"]);
  assert_eq!(rig.server.bodies_of("fail")[0]["reason"], "provider_failed");

  let rig = Rig::default_subscription("ai-large");
  rig.server.max_output_bytes.store(4, Ordering::SeqCst);
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(calls(&rig.log), vec!["claim", "prompt", "dispatch", "turn", "fail"]);
}

#[test]
fn submit_transport_errors_retry_with_the_same_candidate() {
  let rig = Rig::default_subscription("submit-retry");
  rig.server.submit_network_errors.store(2, Ordering::SeqCst);
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(
    calls(&rig.log),
    vec![
      "claim",
      "prompt",
      "dispatch",
      "turn",
      "candidate",
      "upload",
      "submit",
      "submit",
      "submit"
    ]
  );
  let submits = rig.server.bodies_of("submit");
  assert!(submits.iter().all(|body| body["candidateId"] == CANDIDATE_ID));
  assert_eq!(lock(&rig.host.submitted).len(), 1);
}

#[test]
fn upload_412_counts_as_uploaded_and_upload_errors_get_a_fresh_url() {
  let rig = Rig::default_subscription("upload-412");
  lock(&rig.server.uploads).push_back(Ok(412));
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(
    calls(&rig.log),
    vec!["claim", "prompt", "dispatch", "turn", "candidate", "upload", "submit"]
  );

  let rig = Rig::default_subscription("upload-retry");
  lock(&rig.server.uploads).push_back(Err(TransportError::Network));
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(
    calls(&rig.log),
    vec![
      "claim",
      "prompt",
      "dispatch",
      "turn",
      "candidate",
      "upload",
      "candidate",
      "upload",
      "submit"
    ]
  );
}

#[test]
fn prompt_rejections_mean_the_server_already_failed_the_attempt() {
  let rig = Rig::default_subscription("prompt-409");
  *lock(&rig.server.prompt_error) = Some((409, "pc_provider_not_registered"));
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(calls(&rig.log), vec!["claim", "prompt"]);
  assert!(rig.runner.needs_reregister());

  let rig = Rig::default_subscription("prompt-413");
  *lock(&rig.server.prompt_error) = Some((413, "prompt_too_large"));
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(calls(&rig.log), vec!["claim", "prompt"]);

  // ほかの失敗は「送っていない」を届ける
  let rig = Rig::default_subscription("prompt-400");
  *lock(&rig.server.prompt_error) = Some((400, "bad_request"));
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(calls(&rig.log), vec!["claim", "prompt", "fail"]);
  assert_eq!(rig.server.bodies_of("fail")[0]["reason"], "not_sent");
}

#[test]
fn logged_out_session_aborts_without_submitting() {
  let rig = Rig::default_subscription("logout");
  *lock(&rig.llm.script) = Script::WaitForStop;
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  let session = rig.account.session.clone();
  let log = rig.log.clone();
  let flip = std::thread::spawn(move || {
    // AI に渡った後でログアウトする
    wait_until("turn", || entries(&log).contains(&"turn".to_string()));
    session.current.store(false, Ordering::SeqCst);
  });
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::SessionChanged));
  flip.join().unwrap();
  let log = entries(&rig.log);
  for unexpected in ["candidate", "submit", "fail"] {
    assert!(!log.contains(&unexpected.to_string()), "{log:?}");
  }
}

#[test]
fn locally_busy_mac_does_not_claim() {
  let rig = Rig::default_subscription("busy-turn");
  rig.llm.busy.store(true, Ordering::SeqCst);
  assert_eq!(rig.tick(), Tick::LocallyBusy);
  assert!(entries(&rig.log).is_empty());
  assert_eq!(rig.host.app.pc_gate.phase(), Phase::Off);

  let rig = Rig::default_subscription("busy-lock");
  rig.host.app.run_locks.lock().unwrap().insert("p_kamakura".into());
  assert_eq!(rig.tick(), Tick::LocallyBusy);
  assert!(entries(&rig.log).is_empty());
}

#[test]
fn paused_gate_does_not_claim_until_resumed() {
  // 常駐中の自動更新（#18823）が再起動を確かめている間は受け取りに行かない
  let rig = Rig::default_subscription("paused");
  rig.host.app.pc_gate.pause();
  assert_eq!(rig.tick(), Tick::LocallyBusy);
  assert!(entries(&rig.log).is_empty());
  assert!(!rig.host.app.pc_gate.blocks_local_runs());

  rig.host.app.pc_gate.resume();
  assert!(begin_claim(&rig.host.app));
  assert_eq!(rig.host.app.pc_gate.phase(), Phase::Claiming);
}

#[test]
fn another_process_running_on_the_same_store_blocks_claims() {
  // 同じ保存先を開いた別の NIHO docs（別の process）が工程を実行している
  let rig = Rig::default_subscription("busy-other-process");
  rig.host.other_process.store(true, Ordering::SeqCst);
  assert_eq!(rig.tick(), Tick::LocallyBusy);
  assert!(entries(&rig.log).is_empty());

  // 受け取った後に置き場の `.run.lock` を取れなければ、AI へ送らずに返す
  let rig = Rig::default_subscription("busy-container");
  rig.host.container_busy.store(true, Ordering::SeqCst);
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(calls(&rig.log), vec!["claim", "fail"]);
  assert_eq!(rig.server.bodies_of("fail")[0]["reason"], "not_sent");
  assert!(lock(&rig.llm.requests).is_empty());
}

#[test]
fn turning_off_while_claiming_returns_the_job_unsent() {
  let rig = Rig::default_subscription("off-while-claiming");
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  let inner = rig.runner.inner.clone();
  *lock(&rig.server.claim_hook) = Some(Box::new(move || inner.enabled.store(false, Ordering::SeqCst)));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(calls(&rig.log), vec!["claim", "fail"]);
  assert_eq!(rig.server.bodies_of("fail")[0]["reason"], "not_sent");
  assert!(lock(&rig.llm.requests).is_empty());
}

#[test]
fn output_cut_at_the_token_limit_is_provider_failed() {
  let rig = Rig::default_subscription("max-tokens");
  *lock(&rig.llm.script) = Script::Truncated("# 修正版\n途中まで");
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::Done));
  assert_eq!(calls(&rig.log), vec!["claim", "prompt", "dispatch", "turn", "fail"]);
  assert_eq!(rig.server.bodies_of("fail")[0]["reason"], "provider_failed");
  assert!(lock(&rig.host.submitted).is_empty());
}

#[test]
fn session_change_while_dispatching_sends_nothing_to_the_ai() {
  let rig = Rig::default_subscription("dispatch-logout");
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  let session = rig.account.session.clone();
  *lock(&rig.server.dispatch_hook) = Some(Box::new(move || session.current.store(false, Ordering::SeqCst)));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::SessionChanged));
  assert_eq!(calls(&rig.log), vec!["claim", "prompt", "dispatch"]);
  assert!(lock(&rig.llm.requests).is_empty());
}

#[test]
fn heartbeat_unauthorized_stops_the_turn_and_needs_login() {
  let rig = Rig::default_subscription("heartbeat-401");
  *lock(&rig.llm.script) = Script::WaitForStop;
  rig.server.heartbeat_unauthorized.store(true, Ordering::SeqCst);
  lock(&rig.server.claims).push_back(leased("claude", "claude-sonnet-4-6"));
  assert_eq!(rig.tick(), Tick::Ran(JobEnd::AuthRequired));
  let log = entries(&rig.log);
  assert_eq!(log[..4], ["claim", "prompt", "dispatch", "turn"]);
  assert_eq!(log.iter().filter(|entry| *entry == "heartbeat").count(), 1, "{log:?}");
  for unexpected in ["candidate", "upload", "submit", "fail"] {
    assert!(!log.contains(&unexpected.to_string()), "{log:?}");
  }
}

// ---------------------------------------------------------------------------
// ON・OFF とループ

#[test]
fn turning_on_requires_login_and_registration() {
  let rig = Rig::new(
    "on-signed-out",
    Some(settings("subscription", &["claude"], standard_profiles())),
    false,
  );
  rig.account.signed_in.store(false, Ordering::SeqCst);
  let error = run(rig.runner.set_enabled(true)).unwrap_err();
  assert_eq!(error.code, "pc_runner_not_signed_in");
  assert!(!rig.runner.enabled());
  assert!(!rig.dir.join("pc-runner.json").exists());
  assert!(lock(&rig.host.resident).is_empty());

  let rig = Rig::new(
    "on-offline",
    Some(settings("subscription", &["claude"], standard_profiles())),
    false,
  );
  *lock(&rig.server.register_error) = Some(Err(TransportError::Network));
  let error = run(rig.runner.set_enabled(true)).unwrap_err();
  assert_eq!(error.code, "pc_runner_offline");
  assert!(!rig.runner.enabled());
  assert!(!read_enabled(&rig.dir));
  assert!(lock(&rig.host.resident).is_empty());

  let rig = Rig::new(
    "on",
    Some(settings("subscription", &["claude"], standard_profiles())),
    false,
  );
  let status = run(rig.runner.set_enabled(true)).unwrap();
  assert!(status.enabled);
  assert!(rig.runner.enabled());
  assert!(read_enabled(&rig.dir));
  assert_eq!(*lock(&rig.host.resident), vec!["on"]);
  assert_eq!(
    rig.server.bodies_of("register"),
    vec![json!({ "enabled": true, "connection": "subscription", "providers": ["claude"] })]
  );

  let status = run(rig.runner.set_enabled(false)).unwrap();
  assert!(!status.enabled);
  assert_eq!(status.state, RunnerState::Off);
  assert!(!read_enabled(&rig.dir));
  assert_eq!(*lock(&rig.host.resident), vec!["on", "off"]);
}

#[test]
fn login_item_or_setting_write_failures_do_not_change_on_or_off() {
  // ログイン時の起動を書けなければ ON にしない（NIHO にも OFF を送り直す）
  let rig = Rig::new(
    "on-login-item-fails",
    Some(settings("subscription", &["claude"], standard_profiles())),
    false,
  );
  rig.host.login_item_fails.store(true, Ordering::SeqCst);
  let error = run(rig.runner.set_enabled(true)).unwrap_err();
  assert_eq!(error.code, "pc_runner_login_item_failed");
  assert!(!rig.runner.enabled());
  assert!(!read_enabled(&rig.dir));
  assert_eq!(*lock(&rig.host.resident), vec!["on", "off"]);
  let registered: Vec<Value> = rig
    .server
    .bodies_of("register")
    .iter()
    .map(|body| body["enabled"].clone())
    .collect();
  assert_eq!(registered, vec![json!(true), json!(false)]);

  // OFF の設定を保存できなければ OFF にしない（次の起動で古い ON を読まないように）
  let rig = Rig::new(
    "off-save-fails",
    Some(settings("subscription", &["claude"], standard_profiles())),
    true,
  );
  std::fs::create_dir_all(rig.dir.join("pc-runner.json")).unwrap();
  let error = run(rig.runner.set_enabled(false)).unwrap_err();
  assert_eq!(error.code, "pc_runner_save_failed");
  assert!(rig.runner.enabled());
  assert!(lock(&rig.host.resident).is_empty());
}

fn wait_until(what: &str, condition: impl Fn() -> bool) {
  for _ in 0..500 {
    if condition() {
      return;
    }
    std::thread::sleep(Duration::from_millis(10));
  }
  panic!("timed out: {what}");
}

#[test]
fn loop_registers_claims_and_sends_off_after_disabling() {
  let rig = Rig::new(
    "loop",
    Some(settings("subscription", &["claude"], standard_profiles())),
    true,
  );
  rig.runner.spawn_loop();
  wait_until("claims", || {
    entries(&rig.log).iter().filter(|call| *call == "claim").count() >= 2
  });
  assert_eq!(entries(&rig.log)[0], "register");
  assert_eq!(rig.runner.status().state, RunnerState::Idle);
  // 設定を保存したら登録し直す
  rig.runner.settings_changed();
  wait_until("re-register", || {
    entries(&rig.log).iter().filter(|call| *call == "register").count() >= 2
  });
  run(rig.runner.set_enabled(false)).unwrap();
  wait_until("off sent", || {
    rig
      .server
      .bodies_of("register")
      .last()
      .is_some_and(|body| body["enabled"] == false)
  });
  wait_until("phase off", || rig.host.app.pc_gate.phase() == Phase::Off);
  // ログインが要るときは受け取りに行かない
  let rig = Rig::new(
    "loop-login",
    Some(settings("subscription", &["claude"], standard_profiles())),
    true,
  );
  rig.account.signed_in.store(false, Ordering::SeqCst);
  rig.runner.spawn_loop();
  wait_until("needs login", || rig.runner.status().state == RunnerState::NeedsLogin);
  assert!(entries(&rig.log).is_empty());
  rig.account.signed_in.store(true, Ordering::SeqCst);
  wait_until("claims after login", || {
    entries(&rig.log).contains(&"claim".to_string())
  });
  run(rig.runner.set_enabled(false)).unwrap();
  wait_until("phase off", || rig.host.app.pc_gate.phase() == Phase::Off);
}
