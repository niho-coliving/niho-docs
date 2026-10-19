//! 「この Mac で続きを受ける」（#18804 S2）の NIHO API の口（S1 #18803 の `/api/me/docs-pc-runner`）。
//!
//! - 認証は NIHO アカウントの ID token（`Authorization: Bearer`）。token は依頼ごとに、ループが始めた session の ticket で取る
//!   （ログアウト・別のアカウントで取り直さない。`SessionToken`）。画面へは返さず、ログにも出さない。
//! - 送る JSON は契約のキーだけ。受け取る JSON は形を確かめ、余計なキー・足りないキー・範囲外の値は通信の失敗として扱う
//!   （共有 runner の apps/docs/remote-runner/http-client.mjs の `exactKeys` と同じ考え）。
//! - 成果物の PUT 先（GCS の署名付き URL）と header は PUT の前に確かめる（http-client.mjs の `validateCandidate`・
//!   `candidateHeaders`・`validateGcsSignedUrl` の移植）。リダイレクトは追わない。署名付き URL・プロンプト・成果物はログに出さない。

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use niho_desktop_account::{AccountService, AccountSessionTicket};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::sync::Arc;
use std::time::Duration;

/// `env.api_url(API_PATH)` が契約の base（`<base>/api/me/docs-pc-runner`）。
pub(crate) const API_PATH: &str = "me/docs-pc-runner";
/// 成果物の上限（契約の 1..=8 MiB）。
pub(crate) const MAX_CANDIDATE_BYTES: usize = 8 * 1024 * 1024;
/// プロンプトの上限（実際に送る local-ai と同じ）。
pub(crate) const MAX_SYSTEM_PROMPT_BYTES: usize = niho_local_ai::MAX_SYSTEM_PROMPT_BYTES;
pub(crate) const MAX_USER_PROMPT_BYTES: usize = 8 * 1024 * 1024;
/// 応答の本文の上限（プロンプトは JSON の escape を見込んで広くとる）。
const MAX_JSON_BYTES: usize = 64 * 1024;
const MAX_PROMPT_JSON_BYTES: usize = 24 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const API_TIMEOUT: Duration = Duration::from_secs(30);
/// プロンプトは数 MB になり得るので、受け取りだけ長めにする。
const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const GCS_REQUIRED_QUERY: [&str; 6] = [
  "X-Goog-Algorithm",
  "X-Goog-Credential",
  "X-Goog-Date",
  "X-Goog-Expires",
  "X-Goog-SignedHeaders",
  "X-Goog-Signature",
];
const CANDIDATE_SIGNED_HEADERS: &str = "content-type;host;x-goog-content-length-range;x-goog-if-generation-match";

// ---------------------------------------------------------------------------
// 値の形

/// この Mac の接続方式（設定の `connection`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) enum Connection {
  #[serde(rename = "subscription")]
  Subscription,
  #[serde(rename = "apiKey")]
  ApiKey,
}

impl Connection {
  pub(crate) fn parse(value: &str) -> Option<Self> {
    match value {
      "subscription" => Some(Self::Subscription),
      "apiKey" => Some(Self::ApiKey),
      _ => None,
    }
  }
}

/// アプリの AI（docs-core の `ProviderId`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProviderId {
  Claude,
  Gpt,
  Gemini,
}

impl ProviderId {
  pub(crate) const ALL: [ProviderId; 3] = [ProviderId::Claude, ProviderId::Gpt, ProviderId::Gemini];

  pub(crate) fn parse(value: &str) -> Option<Self> {
    match value {
      "claude" => Some(Self::Claude),
      "gpt" => Some(Self::Gpt),
      "gemini" => Some(Self::Gemini),
      _ => None,
    }
  }

  pub(crate) fn as_str(self) -> &'static str {
    match self {
      Self::Claude => "claude",
      Self::Gpt => "gpt",
      Self::Gemini => "gemini",
    }
  }
}

/// 思考量（docs-core の `Effort`。契約の小文字）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum StepEffort {
  Low,
  Medium,
  High,
  Max,
}

impl StepEffort {
  pub(crate) const ALL: [StepEffort; 4] = [StepEffort::Low, StepEffort::Medium, StepEffort::High, StepEffort::Max];

  pub(crate) fn parse(value: &str) -> Option<Self> {
    match value {
      "low" => Some(Self::Low),
      "medium" => Some(Self::Medium),
      "high" => Some(Self::High),
      "max" => Some(Self::Max),
      _ => None,
    }
  }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Registration {
  pub enabled: bool,
  pub connection: Connection,
  pub providers: Vec<ProviderId>,
}

/// 依頼の録音の置き場（クラウドの同期を起こす先）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ContainerRef {
  Root,
  Folder { project_id: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StepKind {
  Revision,
  Insight,
}

/// 依頼の工程（スマホで選んだ AI・モデル・思考量）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct JobStep {
  pub step_key: String,
  pub kind: StepKind,
  pub label: String,
  pub provider: ProviderId,
  pub model: String,
  pub effort: StepEffort,
}

/// 受け取った 1 件（`LEASED`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LeasedJob {
  pub run_id: String,
  pub attempt_id: String,
  pub generation: u64,
  pub lease_until: DateTime<Utc>,
  pub container: ContainerRef,
  pub recording_page_id: String,
  pub step: JobStep,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Claim {
  Disabled,
  /// 前の受け取りが残っている（サーバーが期限で外すので、待つ）。
  Busy,
  Idle,
  Leased(Box<LeasedJob>),
}

/// この Mac で決めたモデル（`/prompt` に送る）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct ModelChoice {
  pub provider: ProviderId,
  pub model: String,
  pub effort: StepEffort,
}

pub(crate) struct Prompt {
  pub system_prompt: String,
  pub user_prompt: String,
  pub max_output_bytes: usize,
}

/// `/candidate` の PUT 先（確かめ済み）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Candidate {
  pub candidate_id: String,
  pub url: String,
  pub headers: Vec<(String, String)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Uploaded {
  Now,
  /// 412: 前の PUT で上がっていた（同じ候補）。
  Already,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FailReason {
  NotSent,
  ProviderNotReady,
  ProviderFailed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ApiError {
  /// 401・ログアウト・期限切れ（もう一度ログインが要る）。
  AuthRequired,
  /// ループを始めたときの session ではなくなった（ログアウト・別のアカウント）。
  SessionChanged,
  /// 通信できない・時間切れ・429・5xx。
  Offline,
  /// 4xx（401 以外）。`reason` は `errorResponse` の `details.reason`。
  Rejected { status: u16, reason: Option<String> },
  /// 応答の形が契約と違う・リダイレクト。
  Protocol,
}

impl ApiError {
  pub(crate) fn status(&self) -> Option<u16> {
    match self {
      Self::Rejected { status, .. } => Some(*status),
      _ => None,
    }
  }

  pub(crate) fn reason(&self) -> Option<&str> {
    match self {
      Self::Rejected { reason, .. } => reason.as_deref(),
      _ => None,
    }
  }

  /// ログに残す短い名前（値・URL は入れない）。
  pub(crate) fn kind(&self) -> &'static str {
    match self {
      Self::AuthRequired => "auth_required",
      Self::SessionChanged => "session_changed",
      Self::Offline => "offline",
      Self::Rejected { .. } => "rejected",
      Self::Protocol => "protocol",
    }
  }
}

// ---------------------------------------------------------------------------
// token

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TokenError {
  AuthRequired,
  Offline,
}

/// ループが始めた 1 つの session の token（logout・relogin で無効になる）。
#[async_trait]
pub(crate) trait SessionToken: Send + Sync {
  fn is_current(&self) -> bool;
  async fn bearer(&self) -> Result<String, TokenError>;
}

/// 本番: AccountService の ticket（cloud.rs の `ExpectedSessionToken` と同じ考え）。
pub(crate) struct AccountSession {
  pub service: Arc<AccountService>,
  pub ticket: AccountSessionTicket,
}

#[async_trait]
impl SessionToken for AccountSession {
  fn is_current(&self) -> bool {
    self.service.is_session_current(&self.ticket)
  }

  async fn bearer(&self) -> Result<String, TokenError> {
    use niho_desktop_account::error::code;
    let token = self.service.id_token_for(&self.ticket).await.map_err(|error| {
      if error.is(code::SIGNED_OUT) || error.is(code::EXPIRED) {
        TokenError::AuthRequired
      } else {
        TokenError::Offline
      }
    })?;
    Ok(token.expose().to_string())
  }
}

// ---------------------------------------------------------------------------
// 通信の口

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Method {
  Put,
  Post,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TransportError {
  Network,
  Timeout,
  TooLarge,
}

pub(crate) struct RawResponse {
  pub status: u16,
  pub body: Vec<u8>,
}

/// HTTP だけの口（本番は reqwest、テストは偽物）。形の確かめは `PcRunnerApi` が持つ。
#[async_trait]
pub(crate) trait PcRunnerTransport: Send + Sync {
  async fn send_json(
    &self,
    method: Method,
    url: &str,
    bearer: &str,
    body: Vec<u8>,
    max_body: usize,
    timeout: Duration,
  ) -> Result<RawResponse, TransportError>;
  /// 署名付き URL へ PUT する（確かめ済みの URL と header だけ）。返すのは HTTP の status。
  async fn upload(&self, url: &str, headers: &[(String, String)], body: Vec<u8>) -> Result<u16, TransportError>;
}

/// 本番の HTTP（reqwest・rustls〔ring〕）。リダイレクトは追わず、https だけ。
pub(crate) struct ReqwestTransport {
  client: reqwest::Client,
}

impl ReqwestTransport {
  pub(crate) fn new() -> Option<Self> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
      let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::Client::builder()
      .redirect(reqwest::redirect::Policy::none())
      .https_only(true)
      .connect_timeout(CONNECT_TIMEOUT)
      .user_agent(concat!("niho-docs-pc-runner/", env!("CARGO_PKG_VERSION")))
      .build()
      .ok()?;
    Some(Self { client })
  }
}

fn transport_error(error: &reqwest::Error) -> TransportError {
  if error.is_timeout() {
    TransportError::Timeout
  } else {
    TransportError::Network
  }
}

#[async_trait]
impl PcRunnerTransport for ReqwestTransport {
  async fn send_json(
    &self,
    method: Method,
    url: &str,
    bearer: &str,
    body: Vec<u8>,
    max_body: usize,
    timeout: Duration,
  ) -> Result<RawResponse, TransportError> {
    let method = match method {
      Method::Put => reqwest::Method::PUT,
      Method::Post => reqwest::Method::POST,
    };
    let mut response = self
      .client
      .request(method, url)
      .timeout(timeout)
      .header("authorization", format!("Bearer {bearer}"))
      .header("accept", "application/json")
      .header("content-type", "application/json")
      .body(body)
      .send()
      .await
      .map_err(|error| transport_error(&error))?;
    let status = response.status().as_u16();
    if response.content_length().is_some_and(|length| length > max_body as u64) {
      return Err(TransportError::TooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| transport_error(&error))? {
      bytes.extend_from_slice(&chunk);
      if bytes.len() > max_body {
        return Err(TransportError::TooLarge);
      }
    }
    Ok(RawResponse { status, body: bytes })
  }

  async fn upload(&self, url: &str, headers: &[(String, String)], body: Vec<u8>) -> Result<u16, TransportError> {
    let mut request = self.client.put(url).timeout(UPLOAD_TIMEOUT);
    for (name, value) in headers {
      request = request.header(name.as_str(), value.as_str());
    }
    let response = request
      .body(body)
      .send()
      .await
      .map_err(|error| transport_error(&error))?;
    Ok(response.status().as_u16())
  }
}

/// HTTP の口を作れなかったとき（通信できない扱い）。
pub(crate) struct NoTransport;

#[async_trait]
impl PcRunnerTransport for NoTransport {
  async fn send_json(
    &self,
    _method: Method,
    _url: &str,
    _bearer: &str,
    _body: Vec<u8>,
    _max_body: usize,
    _timeout: Duration,
  ) -> Result<RawResponse, TransportError> {
    Err(TransportError::Network)
  }

  async fn upload(&self, _url: &str, _headers: &[(String, String)], _body: Vec<u8>) -> Result<u16, TransportError> {
    Err(TransportError::Network)
  }
}

// ---------------------------------------------------------------------------
// 契約の呼び出し

pub(crate) struct PcRunnerApi {
  transport: Arc<dyn PcRunnerTransport>,
  /// `https://niho.life/api/me/docs-pc-runner`
  base: String,
}

impl PcRunnerApi {
  pub(crate) fn new(transport: Arc<dyn PcRunnerTransport>, base: String) -> Self {
    Self {
      transport,
      base: base.trim_end_matches('/').to_string(),
    }
  }

  async fn call(
    &self,
    session: &dyn SessionToken,
    method: Method,
    path: &str,
    body: Value,
    max_body: usize,
    timeout: Duration,
  ) -> Result<Value, ApiError> {
    if !session.is_current() {
      return Err(ApiError::SessionChanged);
    }
    let bearer = session.bearer().await.map_err(|error| match error {
      TokenError::AuthRequired => ApiError::AuthRequired,
      TokenError::Offline => ApiError::Offline,
    })?;
    if !session.is_current() {
      return Err(ApiError::SessionChanged);
    }
    let url = if path.is_empty() {
      self.base.clone()
    } else {
      format!("{}/{path}", self.base)
    };
    let body = serde_json::to_vec(&body).map_err(|_| ApiError::Protocol)?;
    let response = self
      .transport
      .send_json(method, &url, &bearer, body, max_body, timeout)
      .await
      .map_err(|error| match error {
        TransportError::TooLarge => ApiError::Protocol,
        TransportError::Network | TransportError::Timeout => ApiError::Offline,
      })?;
    match response.status {
      200..=299 => serde_json::from_slice(&response.body).map_err(|_| ApiError::Protocol),
      // 停止スイッチ（#18892・D-18）: 接続は失効していない一時停止。ログインのやり直しではなく、再開まで通信できないのと同じ
      401 if error_reason(&response.body).as_deref() == Some("app_connect_disabled") => Err(ApiError::Offline),
      401 => Err(ApiError::AuthRequired),
      429 | 500..=599 => Err(ApiError::Offline),
      status @ 400..=499 => Err(ApiError::Rejected {
        status,
        reason: error_reason(&response.body),
      }),
      _ => Err(ApiError::Protocol),
    }
  }

  /// `PUT /`（登録・在席）。
  pub(crate) async fn register(
    &self,
    session: &dyn SessionToken,
    registration: &Registration,
  ) -> Result<String, ApiError> {
    let body = json!({
      "enabled": registration.enabled,
      "connection": registration.connection,
      "providers": registration.providers,
    });
    let value = self
      .call(session, Method::Put, "", body, MAX_JSON_BYTES, API_TIMEOUT)
      .await?;
    valid_registration(&value)
      .then(|| value["runnerId"].as_str().map(str::to_owned))
      .flatten()
      .ok_or(ApiError::Protocol)
  }

  pub(crate) async fn claim(&self, session: &dyn SessionToken) -> Result<Claim, ApiError> {
    let value = self
      .call(session, Method::Post, "claim", json!({}), MAX_JSON_BYTES, API_TIMEOUT)
      .await?;
    parse_claim(&value).ok_or(ApiError::Protocol)
  }

  pub(crate) async fn prompt(
    &self,
    session: &dyn SessionToken,
    job: &LeasedJob,
    model: &ModelChoice,
  ) -> Result<Prompt, ApiError> {
    let body = json!({ "runId": job.run_id, "attemptId": job.attempt_id, "model": model });
    let value = self
      .call(
        session,
        Method::Post,
        "prompt",
        body,
        MAX_PROMPT_JSON_BYTES,
        PROMPT_TIMEOUT,
      )
      .await?;
    parse_prompt(value).ok_or(ApiError::Protocol)
  }

  /// 返すのは新しい lease の期限。
  pub(crate) async fn heartbeat(&self, session: &dyn SessionToken, job: &LeasedJob) -> Result<DateTime<Utc>, ApiError> {
    let value = self
      .call(
        session,
        Method::Post,
        "heartbeat",
        attempt_body(job),
        MAX_JSON_BYTES,
        API_TIMEOUT,
      )
      .await?;
    if !has_keys(&value, &["leaseUntil"]) {
      return Err(ApiError::Protocol);
    }
    date(&value["leaseUntil"]).ok_or(ApiError::Protocol)
  }

  pub(crate) async fn dispatch(&self, session: &dyn SessionToken, job: &LeasedJob) -> Result<(), ApiError> {
    let value = self
      .call(
        session,
        Method::Post,
        "dispatch",
        attempt_body(job),
        MAX_JSON_BYTES,
        API_TIMEOUT,
      )
      .await?;
    (has_keys(&value, &["status"]) && value["status"] == "SUBMITTED")
      .then_some(())
      .ok_or(ApiError::Protocol)
  }

  /// `expected` は同じ attempt で前に受け取った候補の id（同じ候補が新しい URL で返る）。
  pub(crate) async fn candidate(
    &self,
    session: &dyn SessionToken,
    job: &LeasedJob,
    bytes: usize,
    expected: Option<&str>,
  ) -> Result<Candidate, ApiError> {
    let body = json!({ "runId": job.run_id, "attemptId": job.attempt_id, "bytes": bytes });
    let value = self
      .call(session, Method::Post, "candidate", body, MAX_JSON_BYTES, API_TIMEOUT)
      .await?;
    validate_candidate(&value, bytes, expected).ok_or(ApiError::Protocol)
  }

  /// 確かめ済みの候補へ、成果物のバイト列をそのまま PUT する。412 は前の PUT で上がっていた。
  pub(crate) async fn upload(&self, candidate: &Candidate, body: &[u8]) -> Result<Uploaded, ApiError> {
    let status = self
      .transport
      .upload(&candidate.url, &candidate.headers, body.to_vec())
      .await
      .map_err(|_| ApiError::Offline)?;
    match status {
      200..=299 => Ok(Uploaded::Now),
      412 => Ok(Uploaded::Already),
      429 | 500..=599 => Err(ApiError::Offline),
      400..=499 => Err(ApiError::Rejected { status, reason: None }),
      _ => Err(ApiError::Protocol),
    }
  }

  pub(crate) async fn submit(
    &self,
    session: &dyn SessionToken,
    job: &LeasedJob,
    candidate_id: &str,
  ) -> Result<(), ApiError> {
    let body = json!({
      "runId": job.run_id,
      "attemptId": job.attempt_id,
      "generation": job.generation,
      "candidateId": candidate_id,
    });
    let value = self
      .call(session, Method::Post, "submit", body, MAX_JSON_BYTES, API_TIMEOUT)
      .await?;
    valid_submit(&value, job, candidate_id)
      .then_some(())
      .ok_or(ApiError::Protocol)
  }

  pub(crate) async fn fail(
    &self,
    session: &dyn SessionToken,
    job: &LeasedJob,
    reason: FailReason,
  ) -> Result<(), ApiError> {
    let body = json!({ "runId": job.run_id, "attemptId": job.attempt_id, "reason": reason });
    let value = self
      .call(session, Method::Post, "fail", body, MAX_JSON_BYTES, API_TIMEOUT)
      .await?;
    (has_keys(&value, &["runId", "state", "reasonCode"])
      && value["runId"] == job.run_id.as_str()
      && short_text(&value["state"], 64)
      && short_text(&value["reasonCode"], 64))
    .then_some(())
    .ok_or(ApiError::Protocol)
  }
}

fn attempt_body(job: &LeasedJob) -> Value {
  json!({ "runId": job.run_id, "attemptId": job.attempt_id })
}

/// `errorResponse(code, message, { reason })`（apps/api/src/errors.ts）の `error.details.reason`。
fn error_reason(body: &[u8]) -> Option<String> {
  let value: Value = serde_json::from_slice(body).ok()?;
  let reason = value.get("error")?.get("details")?.get("reason")?.as_str()?;
  (reason.len() <= 64
    && !reason.is_empty()
    && reason
      .chars()
      .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_'))
  .then(|| reason.to_string())
}

// ---------------------------------------------------------------------------
// 形の確かめ

/// 要るキーが揃っているか（NIHO の応答に後からキーが増えても、配った Mac の受け取りを止めない）。
fn has_keys(value: &Value, keys: &[&str]) -> bool {
  value
    .as_object()
    .is_some_and(|object| keys.iter().all(|key| object.contains_key(*key)))
}

/// 共有 runner と同じ id の形（`^[A-Za-z0-9_-]{1,64}$`）。
pub(crate) fn is_id(value: &str) -> bool {
  !value.is_empty()
    && value.len() <= 64
    && value
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn id(value: &Value) -> Option<String> {
  value.as_str().filter(|text| is_id(text)).map(str::to_string)
}

/// 制御文字の無い、空でない短い文字列。
fn text(value: &Value, max_chars: usize) -> Option<String> {
  value
    .as_str()
    .filter(|text| !text.trim().is_empty() && text.chars().count() <= max_chars && !text.chars().any(char::is_control))
    .map(str::to_string)
}

fn short_text(value: &Value, max_chars: usize) -> bool {
  text(value, max_chars).is_some()
}

fn date(value: &Value) -> Option<DateTime<Utc>> {
  DateTime::parse_from_rfc3339(value.as_str()?)
    .ok()
    .map(|date| date.with_timezone(&Utc))
}

fn is_uuid(value: &str) -> bool {
  let bytes = value.as_bytes();
  bytes.len() == 36
    && bytes.iter().enumerate().all(|(index, byte)| match index {
      8 | 13 | 18 | 23 => *byte == b'-',
      14 => (b'1'..=b'8').contains(byte),
      19 => matches!(byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
      _ => byte.is_ascii_hexdigit(),
    })
}

fn providers(value: &Value) -> Option<Vec<ProviderId>> {
  let mut list = Vec::new();
  for item in value.as_array()? {
    let provider = ProviderId::parse(item.as_str()?)?;
    if list.contains(&provider) {
      return None;
    }
    list.push(provider);
  }
  Some(list)
}

fn valid_registration(value: &Value) -> bool {
  has_keys(
    value,
    &["runnerId", "name", "enabled", "connection", "providers", "lastSeenAt"],
  ) && short_text(&value["runnerId"], 128)
    && value["name"].is_string()
    && value["enabled"].is_boolean()
    && value["connection"].as_str().and_then(Connection::parse).is_some()
    && providers(&value["providers"]).is_some()
    && (value["lastSeenAt"].is_null() || date(&value["lastSeenAt"]).is_some())
}

pub(crate) fn parse_claim(value: &Value) -> Option<Claim> {
  match value.get("status")?.as_str()? {
    "DISABLED" => has_keys(value, &["status"]).then_some(Claim::Disabled),
    "IDLE" => has_keys(value, &["status"]).then_some(Claim::Idle),
    "BUSY" => (has_keys(value, &["status", "runId", "attemptId"])
      && id(&value["runId"]).is_some()
      && id(&value["attemptId"]).is_some())
    .then_some(Claim::Busy),
    "LEASED" => parse_leased(value).map(|job| Claim::Leased(Box::new(job))),
    _ => None,
  }
}

fn parse_leased(value: &Value) -> Option<LeasedJob> {
  if !has_keys(
    value,
    &[
      "status",
      "runId",
      "attemptId",
      "generation",
      "leaseUntil",
      "containerRef",
      "recordingPageId",
      "step",
    ],
  ) {
    return None;
  }
  let generation = value["generation"]
    .as_u64()
    .filter(|value| *value > 0 && *value <= (1 << 53))?;
  let container = &value["containerRef"];
  let container = match container.get("kind")?.as_str()? {
    "root" if has_keys(container, &["kind"]) => ContainerRef::Root,
    "folder" if has_keys(container, &["kind", "projectId"]) => ContainerRef::Folder {
      project_id: id(&container["projectId"])?,
    },
    _ => return None,
  };
  let step = &value["step"];
  if !has_keys(step, &["stepKey", "kind", "label", "provider", "model", "effort"]) {
    return None;
  }
  let kind = match step["kind"].as_str()? {
    "REVISION" => StepKind::Revision,
    "INSIGHT" => StepKind::Insight,
    _ => return None,
  };
  Some(LeasedJob {
    run_id: id(&value["runId"])?,
    attempt_id: id(&value["attemptId"])?,
    generation,
    lease_until: date(&value["leaseUntil"])?,
    container,
    recording_page_id: id(&value["recordingPageId"])?,
    step: JobStep {
      step_key: text(&step["stepKey"], 128)?,
      kind,
      label: text(&step["label"], 200)?,
      provider: ProviderId::parse(step["provider"].as_str()?)?,
      model: text(&step["model"], 200)?,
      effort: StepEffort::parse(step["effort"].as_str()?)?,
    },
  })
}

fn parse_prompt(mut value: Value) -> Option<Prompt> {
  if !has_keys(&value, &["systemPrompt", "userPrompt", "maxOutputBytes"]) {
    return None;
  }
  let max_output_bytes = value["maxOutputBytes"]
    .as_u64()
    .filter(|bytes| (1..=MAX_CANDIDATE_BYTES as u64).contains(bytes))? as usize;
  let object = value.as_object_mut()?;
  let Value::String(system_prompt) = object.remove("systemPrompt")? else {
    return None;
  };
  let Value::String(user_prompt) = object.remove("userPrompt")? else {
    return None;
  };
  Some(Prompt {
    system_prompt,
    user_prompt,
    max_output_bytes,
  })
}

/// http-client.mjs の `validateCandidate`（同じ attempt の 2 回目は同じ候補の id）。
pub(crate) fn validate_candidate(value: &Value, bytes: usize, expected: Option<&str>) -> Option<Candidate> {
  if !has_keys(
    value,
    &[
      "candidateId",
      "url",
      "headers",
      "expiresAt",
      "candidateExpiresAt",
      "bytes",
      "maxBytes",
    ],
  ) {
    return None;
  }
  let candidate_id = value["candidateId"].as_str().filter(|id| is_uuid(id))?;
  if expected.is_some_and(|expected| expected != candidate_id) {
    return None;
  }
  let expires_at = date(&value["expiresAt"])?;
  let candidate_expires_at = date(&value["candidateExpiresAt"])?;
  let max_bytes = value["maxBytes"].as_u64()?;
  let ok = candidate_expires_at >= expires_at
    && value["bytes"].as_u64() == Some(bytes as u64)
    && max_bytes >= bytes as u64
    && max_bytes <= MAX_CANDIDATE_BYTES as u64;
  if !ok {
    return None;
  }
  let url = value["url"].as_str()?;
  if !valid_signed_upload_url(url) {
    return None;
  }
  let headers = candidate_headers(value["headers"].as_object()?, bytes)?;
  Some(Candidate {
    candidate_id: candidate_id.to_string(),
    url: url.to_string(),
    headers,
  })
}

/// http-client.mjs の `candidateHeaders`: 小文字のキーで、ちょうど 3 つ・決まった値だけ。
pub(crate) fn candidate_headers(headers: &Map<String, Value>, bytes: usize) -> Option<Vec<(String, String)>> {
  let range = format!("{bytes},{bytes}");
  let expected: [(&str, &str); 3] = [
    ("content-type", "text/markdown"),
    ("x-goog-if-generation-match", "0"),
    ("x-goog-content-length-range", range.as_str()),
  ];
  if headers.len() != expected.len() {
    return None;
  }
  for (name, value) in headers {
    if *name != name.to_ascii_lowercase() || !value.is_string() {
      return None;
    }
  }
  expected
    .iter()
    .map(|(name, value)| (headers.get(*name)?.as_str()? == *value).then(|| ((*name).to_string(), (*value).to_string())))
    .collect()
}

fn gcs_host(host: &str) -> bool {
  if host == "storage.googleapis.com" {
    return true;
  }
  let Some(bucket) = host.strip_suffix(".storage.googleapis.com") else {
    return false;
  };
  let edge = |ch: char| ch.is_ascii_lowercase() || ch.is_ascii_digit();
  (2..=223).contains(&bucket.len())
    && bucket.starts_with(edge)
    && bucket.ends_with(edge)
    && bucket
      .chars()
      .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '.' || ch == '-')
    && !bucket.contains("..")
}

/// http-client.mjs の `validateGcsSignedUrl`（成果物の PUT 先。`generation` なし・署名の header は固定）。
pub(crate) fn valid_signed_upload_url(raw: &str) -> bool {
  let Ok(url) = url::Url::parse(raw) else {
    return false;
  };
  let host = url.host_str().unwrap_or("").to_ascii_lowercase();
  if url.scheme() != "https"
    || url.port().is_some()
    || !url.username().is_empty()
    || url.password().is_some()
    || url.fragment().is_some()
    || !gcs_host(&host)
    || !url.path().starts_with('/')
    || url.path().len() <= 1
  {
    return false;
  }
  let pairs: Vec<(String, String)> = url
    .query_pairs()
    .map(|(key, value)| (key.into_owned(), value.into_owned()))
    .collect();
  if pairs.iter().any(|(key, _)| !GCS_REQUIRED_QUERY.contains(&key.as_str())) {
    return false;
  }
  let single = |key: &str| -> Option<&str> {
    let mut found = pairs.iter().filter(|(name, _)| name == key);
    let first = found.next()?;
    found.next().is_none().then_some(first.1.as_str())
  };
  if GCS_REQUIRED_QUERY.iter().any(|key| single(key).is_none()) {
    return false;
  }
  let date = single("X-Goog-Date").unwrap_or("").as_bytes();
  let date_ok = date.len() == 16
    && date.iter().enumerate().all(|(index, byte)| match index {
      8 => *byte == b'T',
      15 => *byte == b'Z',
      _ => byte.is_ascii_digit(),
    });
  let expires = single("X-Goog-Expires").unwrap_or("");
  let expires_ok = (1..=3).contains(&expires.len())
    && !expires.starts_with('0')
    && expires.chars().all(|ch| ch.is_ascii_digit())
    && expires.parse::<u32>().is_ok_and(|seconds| seconds <= 900);
  let signature = single("X-Goog-Signature").unwrap_or("");
  single("X-Goog-Algorithm") == Some("GOOG4-RSA-SHA256")
    && date_ok
    && expires_ok
    && single("X-Goog-SignedHeaders") == Some(CANDIDATE_SIGNED_HEADERS)
    && !signature.is_empty()
    && signature.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn valid_submit(value: &Value, job: &LeasedJob, candidate_id: &str) -> bool {
  let version_ok = match &value["version"] {
    Value::Null => true,
    version => {
      has_keys(version, &["path", "sha256"])
        && short_text(&version["path"], 1024)
        && version["sha256"]
          .as_str()
          .is_some_and(|sha| sha.len() == 64 && sha.chars().all(|ch| ch.is_ascii_hexdigit()))
    }
  };
  has_keys(value, &["runId", "state", "candidateId", "generation", "version"])
    && value["runId"] == job.run_id.as_str()
    && short_text(&value["state"], 64)
    && value["candidateId"] == candidate_id
    && value["generation"].as_u64() == Some(job.generation)
    && version_ok
}

#[cfg(test)]
#[path = "pc_runner_api_tests.rs"]
mod tests;
