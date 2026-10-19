//! 本人の保存先の正を読む小さな API client。本文や token は記録しない。

use async_trait::async_trait;
use niho_desktop_vault::{IdTokenProvider, NihoEnvironment};
use reqwest::{Client, Method};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const MAX_RESPONSE_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum StorageMode {
  Unset,
  Cloud,
  Closing,
  Local,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClosingState {
  pub device_name: String,
  pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StorageState {
  pub mode: StorageMode,
  pub epoch: String,
  pub changed_at: Option<String>,
  pub cleanup_pending: bool,
  pub quota_bytes: u64,
  pub closing: Option<ClosingState>,
}

impl StorageState {
  fn valid(&self) -> bool {
    self.epoch.parse::<u64>().is_ok()
      && self.quota_bytes > 0
      && self.closing.is_some() == (self.mode == StorageMode::Closing)
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StorageApiError {
  Auth,
  Changed,
  NotFound,
  Quota,
  Unavailable,
  InvalidResponse,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum ReopeningPhase {
  Baseline,
  DecisionPending,
  DecidedCloud,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReopeningAttempt {
  pub reopening_id: String,
  pub source_epoch: String,
  pub target_epoch: String,
  pub namespace: String,
  pub phase: ReopeningPhase,
  #[serde(default)]
  pub manifest_digest: Option<String>,
  #[serde(default)]
  pub decision_prepared: bool,
  pub expires_at: String,
}

impl ReopeningAttempt {
  fn valid(&self) -> bool {
    safe_segment(&self.reopening_id)
      && self.source_epoch.parse::<u64>().is_ok()
      && self
        .target_epoch
        .parse::<u64>()
        .is_ok_and(|target| self.source_epoch.parse::<u64>().is_ok_and(|source| target > source))
      && self.namespace.starts_with("docs-vault-reopened/v1/users/")
      && self
        .namespace
        .ends_with(&format!("/{}/{}/", self.target_epoch, self.reopening_id))
      && chrono::DateTime::parse_from_rfc3339(&self.expires_at).is_ok()
      && self.manifest_digest.as_ref().is_none_or(|digest| valid_sha256(digest))
      && (self.phase == ReopeningPhase::Baseline || self.manifest_digest.is_some())
      && (self.phase != ReopeningPhase::DecidedCloud || self.decision_prepared)
  }
}

fn safe_segment(value: &str) -> bool {
  !value.is_empty()
    && value.len() <= 128
    && value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_sha256(value: &str) -> bool {
  value.len() == 64
    && value
      .bytes()
      .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReopeningReservation {
  pub status: String,
  pub upload_id: String,
  pub object_key: String,
  pub generation: Option<String>,
  pub retained_until: Option<String>,
  pub method: Option<String>,
  pub url: Option<String>,
  #[serde(default)]
  pub headers: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifiedReopeningBlob {
  pub status: String,
  pub generation: String,
  pub object_key: String,
  pub retained_until: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClosingPreflight {
  pub epoch: String,
  pub transfer_bytes: String,
  pub folders: usize,
  pub pages: usize,
  pub unexpired_audio: usize,
  pub expired_audio: usize,
  pub deleted_folders: usize,
  pub other_macs: Vec<ClosingMac>,
  pub active: ClosingActive,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClosingMac {
  pub name: String,
  pub last_used_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClosingActive {
  pub runs: usize,
  pub composer_turns: usize,
  pub folder_exports: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClosingAttempt {
  pub closing_id: String,
  pub epoch: String,
  pub phase: String,
  pub expires_at: String,
  pub manifest_digest: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClosingDetail {
  pub phase: String,
  pub epoch: String,
  pub manifest_digest: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClosingSnapshotReady {
  pub closing_id: String,
  pub epoch: String,
  pub phase: String,
  pub manifest_digest: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClosingDrain {
  pub ready: bool,
  pub expired: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClosingCommitted {
  pub closing_id: String,
  pub mode: StorageMode,
  pub epoch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReopeningStep {
  phase: ReopeningPhase,
  manifest_digest: String,
}

#[derive(Deserialize)]
struct ReopeningCommit {
  mode: StorageMode,
  epoch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReopeningAbort {
  reopening_id: String,
  phase: String,
}

pub(crate) struct DocsStorageApi {
  client: Client,
  endpoint: &'static str,
}

/// 保存先の状態だけを扱う境界。端末側の状態遷移を通信なしで検証するため差し替え可能にする。
#[async_trait]
pub(crate) trait StorageStatusClient: Send + Sync {
  async fn get(&self, token: &dyn IdTokenProvider) -> Result<StorageState, StorageApiError>;
  async fn select_initial(
    &self,
    token: &dyn IdTokenProvider,
    mode: StorageMode,
    expected_epoch: &str,
  ) -> Result<StorageState, StorageApiError>;
}

impl DocsStorageApi {
  pub(crate) fn new(environment: NihoEnvironment) -> Result<Self, StorageApiError> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
      let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = Client::builder()
      .https_only(true)
      .redirect(reqwest::redirect::Policy::none())
      .connect_timeout(Duration::from_secs(10))
      .timeout(Duration::from_secs(20))
      .build()
      .map_err(|_| StorageApiError::Unavailable)?;
    let endpoint = match environment {
      NihoEnvironment::Production => "https://niho.life/api/me/docs-storage",
      NihoEnvironment::Staging => "https://app-stg.niho.life/api/me/docs-storage",
    };
    Ok(Self { client, endpoint })
  }

  async fn request(
    &self,
    method: Method,
    token: &dyn IdTokenProvider,
    body: Option<serde_json::Value>,
  ) -> Result<StorageState, StorageApiError> {
    token.ensure_current().map_err(|_| StorageApiError::Auth)?;
    let bearer = token.id_token().await.map_err(|_| StorageApiError::Auth)?;
    token.ensure_current().map_err(|_| StorageApiError::Auth)?;
    let mut request = self.client.request(method, self.endpoint).bearer_auth(bearer);
    if let Some(body) = body {
      request = request
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&body).map_err(|_| StorageApiError::InvalidResponse)?);
    }
    let mut response = request.send().await.map_err(|_| StorageApiError::Unavailable)?;
    token.ensure_current().map_err(|_| StorageApiError::Auth)?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
      return Err(StorageApiError::Auth);
    }
    if status.as_u16() == 409 {
      return Err(StorageApiError::Changed);
    }
    if !status.is_success() {
      return Err(StorageApiError::Unavailable);
    }
    if response
      .content_length()
      .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
      return Err(StorageApiError::InvalidResponse);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| StorageApiError::Unavailable)? {
      if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
        return Err(StorageApiError::InvalidResponse);
      }
      bytes.extend_from_slice(&chunk);
    }
    token.ensure_current().map_err(|_| StorageApiError::Auth)?;
    let state: StorageState = serde_json::from_slice(&bytes).map_err(|_| StorageApiError::InvalidResponse)?;
    state.valid().then_some(state).ok_or(StorageApiError::InvalidResponse)
  }

  async fn reopening_request<T: DeserializeOwned>(
    &self,
    method: Method,
    suffix: &str,
    token: &dyn IdTokenProvider,
    body: Option<serde_json::Value>,
  ) -> Result<T, StorageApiError> {
    token.ensure_current().map_err(|_| StorageApiError::Auth)?;
    let bearer = token.id_token().await.map_err(|_| StorageApiError::Auth)?;
    token.ensure_current().map_err(|_| StorageApiError::Auth)?;
    let mut request = self
      .client
      .request(method, format!("{}{}", self.endpoint, suffix))
      .bearer_auth(bearer);
    // complete は最大 2 GiB の object を server 側で hash/generation 確認する。
    // 通常 API の短い timeout は保ち、この検証だけ長時間許可する。
    if suffix.ends_with("/complete") {
      request = request.timeout(Duration::from_secs(15 * 60));
    }
    if let Some(body) = body {
      request = request
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&body).map_err(|_| StorageApiError::InvalidResponse)?);
    }
    let mut response = request.send().await.map_err(|_| StorageApiError::Unavailable)?;
    token.ensure_current().map_err(|_| StorageApiError::Auth)?;
    match response.status().as_u16() {
      401 | 403 => return Err(StorageApiError::Auth),
      404 => return Err(StorageApiError::NotFound),
      409 => return Err(StorageApiError::Changed),
      413 => return Err(StorageApiError::Quota),
      code if !(200..=299).contains(&code) => return Err(StorageApiError::Unavailable),
      _ => {}
    }
    if response
      .content_length()
      .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
      return Err(StorageApiError::InvalidResponse);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| StorageApiError::Unavailable)? {
      if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
        return Err(StorageApiError::InvalidResponse);
      }
      bytes.extend_from_slice(&chunk);
    }
    token.ensure_current().map_err(|_| StorageApiError::Auth)?;
    serde_json::from_slice(&bytes).map_err(|_| StorageApiError::InvalidResponse)
  }

  pub(crate) async fn closing_preflight(
    &self,
    token: &dyn IdTokenProvider,
  ) -> Result<ClosingPreflight, StorageApiError> {
    self
      .reopening_request(Method::POST, "/closing/preflight", token, Some(serde_json::json!({})))
      .await
  }

  pub(crate) async fn closing_current(
    &self,
    token: &dyn IdTokenProvider,
  ) -> Result<Option<ClosingAttempt>, StorageApiError> {
    match self
      .reopening_request(Method::GET, "/closing/current", token, None)
      .await
    {
      Ok(attempt) => Ok(Some(attempt)),
      Err(StorageApiError::NotFound) => Ok(None),
      Err(error) => Err(error),
    }
  }

  pub(crate) async fn closing_attempt(
    &self,
    token: &dyn IdTokenProvider,
    closing_id: &str,
  ) -> Result<ClosingDetail, StorageApiError> {
    if !safe_segment(closing_id) {
      return Err(StorageApiError::InvalidResponse);
    }
    self
      .reopening_request(Method::GET, &format!("/closing/{closing_id}"), token, None)
      .await
  }

  pub(crate) async fn begin_closing(
    &self,
    token: &dyn IdTokenProvider,
    epoch: &str,
  ) -> Result<ClosingAttempt, StorageApiError> {
    if epoch.parse::<u64>().is_err() {
      return Err(StorageApiError::InvalidResponse);
    }
    self
      .reopening_request(
        Method::POST,
        "/closing",
        token,
        Some(serde_json::json!({ "expectedEpoch": epoch })),
      )
      .await
  }

  pub(crate) async fn closing_drain(
    &self,
    token: &dyn IdTokenProvider,
    closing_id: &str,
  ) -> Result<ClosingDrain, StorageApiError> {
    if !safe_segment(closing_id) {
      return Err(StorageApiError::InvalidResponse);
    }
    self
      .reopening_request(Method::GET, &format!("/closing/{closing_id}/drain"), token, None)
      .await
  }

  pub(crate) async fn closing_snapshot_ready(
    &self,
    token: &dyn IdTokenProvider,
    closing_id: &str,
    epoch: &str,
  ) -> Result<ClosingSnapshotReady, StorageApiError> {
    if !safe_segment(closing_id) || epoch.parse::<u64>().is_err() {
      return Err(StorageApiError::InvalidResponse);
    }
    self
      .reopening_request(
        Method::POST,
        &format!("/closing/{closing_id}/snapshot-ready"),
        token,
        Some(serde_json::json!({ "storageEpoch": epoch })),
      )
      .await
  }

  pub(crate) async fn close_storage(
    &self,
    token: &dyn IdTokenProvider,
    closing_id: &str,
    epoch: &str,
    digest: &str,
  ) -> Result<ClosingCommitted, StorageApiError> {
    if !safe_segment(closing_id) || epoch.parse::<u64>().is_err() || !valid_sha256(digest) {
      return Err(StorageApiError::InvalidResponse);
    }
    self
      .reopening_request(
        Method::POST,
        "/closing/close",
        token,
        Some(serde_json::json!({ "closingId": closing_id, "storageEpoch": epoch, "manifestDigest": digest })),
      )
      .await
  }

  /// holder 専用口。一般の vault API で削除済み案件の認可を広げない。
  pub(crate) async fn snapshot_part(
    &self,
    token: &dyn IdTokenProvider,
    closing_id: &str,
    chunk: Option<usize>,
  ) -> Result<Vec<u8>, StorageApiError> {
    if !safe_segment(closing_id) {
      return Err(StorageApiError::InvalidResponse);
    }
    let part = chunk.map_or_else(|| "manifest".to_owned(), |index| format!("chunks/{index}"));
    token.ensure_current().map_err(|_| StorageApiError::Auth)?;
    let bearer = token.id_token().await.map_err(|_| StorageApiError::Auth)?;
    token.ensure_current().map_err(|_| StorageApiError::Auth)?;
    let mut response = self
      .client
      .get(format!("{}/closing/{closing_id}/snapshot/{part}", self.endpoint))
      .bearer_auth(bearer)
      .send()
      .await
      .map_err(|_| StorageApiError::Unavailable)?;
    token.ensure_current().map_err(|_| StorageApiError::Auth)?;
    match response.status().as_u16() {
      401 | 403 => return Err(StorageApiError::Auth),
      404 => return Err(StorageApiError::NotFound),
      409 => return Err(StorageApiError::Changed),
      code if code != 200 => return Err(StorageApiError::Unavailable),
      _ => {}
    }
    let limit = if chunk.is_some() {
      5 * 1024 * 1024
    } else {
      8 * 1024 * 1024
    };
    if response.content_length().is_some_and(|length| length > limit as u64) {
      return Err(StorageApiError::InvalidResponse);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| StorageApiError::Unavailable)? {
      if bytes.len().saturating_add(chunk.len()) > limit {
        return Err(StorageApiError::InvalidResponse);
      }
      bytes.extend_from_slice(&chunk);
    }
    token.ensure_current().map_err(|_| StorageApiError::Auth)?;
    Ok(bytes)
  }

  pub(crate) async fn snapshot_object_url<T: DeserializeOwned>(
    &self,
    token: &dyn IdTokenProvider,
    closing_id: &str,
    chunk: usize,
    entry: usize,
  ) -> Result<T, StorageApiError> {
    if !safe_segment(closing_id) {
      return Err(StorageApiError::InvalidResponse);
    }
    self
      .reopening_request(
        Method::POST,
        &format!("/closing/{closing_id}/snapshot/objects/{chunk}/{entry}"),
        token,
        None,
      )
      .await
  }

  pub(crate) async fn snapshot_heartbeat(
    &self,
    token: &dyn IdTokenProvider,
    closing_id: &str,
    epoch: &str,
  ) -> Result<(), StorageApiError> {
    if !safe_segment(closing_id) || epoch.parse::<u64>().is_err() {
      return Err(StorageApiError::InvalidResponse);
    }
    let _: serde_json::Value = self
      .reopening_request(
        Method::POST,
        &format!("/closing/{closing_id}/heartbeat"),
        token,
        Some(serde_json::json!({ "storageEpoch": epoch })),
      )
      .await?;
    Ok(())
  }

  pub(crate) async fn current_reopening(
    &self,
    token: &dyn IdTokenProvider,
  ) -> Result<Option<ReopeningAttempt>, StorageApiError> {
    match self
      .reopening_request::<ReopeningAttempt>(Method::GET, "/reopening/current", token, None)
      .await
    {
      Ok(attempt) if attempt.valid() => Ok(Some(attempt)),
      Ok(_) => Err(StorageApiError::InvalidResponse),
      Err(StorageApiError::NotFound) => Ok(None),
      Err(error) => Err(error),
    }
  }

  pub(crate) async fn abort_reopening(
    &self,
    token: &dyn IdTokenProvider,
    attempt: &ReopeningAttempt,
  ) -> Result<(), StorageApiError> {
    let result: ReopeningAbort = self
      .reopening_request(
        Method::POST,
        &format!("/reopening/{}/abort", attempt.reopening_id),
        token,
        Some(serde_json::json!({ "storageEpoch": attempt.source_epoch })),
      )
      .await?;
    if result.reopening_id != attempt.reopening_id || result.phase != "ABORTED" {
      return Err(StorageApiError::InvalidResponse);
    }
    Ok(())
  }

  pub(crate) async fn begin_reopening(
    &self,
    token: &dyn IdTokenProvider,
    source_epoch: &str,
  ) -> Result<ReopeningAttempt, StorageApiError> {
    if source_epoch.parse::<u64>().is_err() {
      return Err(StorageApiError::InvalidResponse);
    }
    let result = self
      .reopening_request(
        Method::PUT,
        "",
        token,
        Some(serde_json::json!({ "mode": "CLOUD", "expectedEpoch": source_epoch })),
      )
      .await?;
    let result: ReopeningAttempt = result;
    result.valid().then_some(result).ok_or(StorageApiError::InvalidResponse)
  }

  pub(crate) async fn stage_reopening_project(
    &self,
    token: &dyn IdTokenProvider,
    attempt: &ReopeningAttempt,
    project_id: &str,
    name: &str,
  ) -> Result<(), StorageApiError> {
    if !safe_segment(project_id) || project_id.len() > 32 || name.trim().is_empty() {
      return Err(StorageApiError::InvalidResponse);
    }
    let _: serde_json::Value = self
      .reopening_request(
        Method::PUT,
        &format!("/reopening/{}/projects/{project_id}", attempt.reopening_id),
        token,
        Some(serde_json::json!({ "storageEpoch": attempt.source_epoch, "name": name,
          "revision": 0, "deletedAt": null })),
      )
      .await?;
    Ok(())
  }

  pub(crate) async fn stage_reopening_files(
    &self,
    token: &dyn IdTokenProvider,
    attempt: &ReopeningAttempt,
    project_id: &str,
    files: &[serde_json::Value],
  ) -> Result<(), StorageApiError> {
    if !safe_segment(project_id) || files.is_empty() || files.len() > 500 {
      return Err(StorageApiError::InvalidResponse);
    }
    let _: serde_json::Value = self
      .reopening_request(
        Method::POST,
        &format!("/reopening/{}/projects/{project_id}/files", attempt.reopening_id),
        token,
        Some(serde_json::json!({ "storageEpoch": attempt.source_epoch, "files": files })),
      )
      .await?;
    Ok(())
  }

  pub(crate) async fn reserve_reopening_blob(
    &self,
    token: &dyn IdTokenProvider,
    attempt: &ReopeningAttempt,
    project_id: &str,
    sha256: &str,
    bytes: u64,
    content_type: &str,
  ) -> Result<ReopeningReservation, StorageApiError> {
    if !safe_segment(project_id) || !valid_sha256(sha256) {
      return Err(StorageApiError::InvalidResponse);
    }
    let reserved: ReopeningReservation = self
      .reopening_request(
        Method::POST,
        &format!("/reopening/{}/projects/{project_id}/blobs", attempt.reopening_id),
        token,
        Some(
          serde_json::json!({ "storageEpoch": attempt.source_epoch, "sha256": sha256,
          "bytes": bytes, "contentType": content_type }),
        ),
      )
      .await?;
    if !safe_segment(&reserved.upload_id)
      || !reserved.object_key.starts_with(&attempt.namespace)
      || !matches!(reserved.status.as_str(), "upload" | "verified")
      || (reserved.status == "upload"
        && (reserved
          .method
          .as_deref()
          .is_none_or(|method| !matches!(method, "put" | "resumable"))
          || reserved.url.is_none()))
      || (reserved.status == "verified"
        && reserved
          .generation
          .as_deref()
          .is_none_or(|generation| generation.is_empty() || !generation.bytes().all(|byte| byte.is_ascii_digit())))
    {
      return Err(StorageApiError::InvalidResponse);
    }
    Ok(reserved)
  }

  pub(crate) async fn complete_reopening_blob(
    &self,
    token: &dyn IdTokenProvider,
    attempt: &ReopeningAttempt,
    project_id: &str,
    sha256: &str,
    upload_id: &str,
  ) -> Result<VerifiedReopeningBlob, StorageApiError> {
    if !safe_segment(project_id) || !valid_sha256(sha256) || !safe_segment(upload_id) {
      return Err(StorageApiError::InvalidResponse);
    }
    let verified: VerifiedReopeningBlob = self
      .reopening_request(
        Method::POST,
        &format!(
          "/reopening/{}/projects/{project_id}/blobs/{sha256}/complete",
          attempt.reopening_id
        ),
        token,
        Some(serde_json::json!({ "storageEpoch": attempt.source_epoch, "uploadId": upload_id })),
      )
      .await?;
    if verified.status != "verified"
      || !verified.object_key.starts_with(&attempt.namespace)
      || verified.generation.is_empty()
      || !verified.generation.bytes().all(|byte| byte.is_ascii_digit())
    {
      return Err(StorageApiError::InvalidResponse);
    }
    Ok(verified)
  }

  async fn reopening_step(
    &self,
    token: &dyn IdTokenProvider,
    attempt: &ReopeningAttempt,
    action: &str,
    digest: &str,
    expected_phase: ReopeningPhase,
  ) -> Result<(), StorageApiError> {
    if !matches!(action, "seal" | "decide") || !valid_sha256(digest) {
      return Err(StorageApiError::InvalidResponse);
    }
    let result: ReopeningStep = self
      .reopening_request(
        Method::POST,
        &format!("/reopening/{}/{action}", attempt.reopening_id),
        token,
        Some(serde_json::json!({ "storageEpoch": attempt.source_epoch, "manifestDigest": digest })),
      )
      .await?;
    if result.phase != expected_phase || result.manifest_digest != digest {
      return Err(StorageApiError::InvalidResponse);
    }
    Ok(())
  }

  pub(crate) async fn seal_reopening(
    &self,
    token: &dyn IdTokenProvider,
    attempt: &ReopeningAttempt,
    digest: &str,
  ) -> Result<(), StorageApiError> {
    self
      .reopening_step(token, attempt, "seal", digest, ReopeningPhase::DecisionPending)
      .await
  }

  pub(crate) async fn decide_reopening(
    &self,
    token: &dyn IdTokenProvider,
    attempt: &ReopeningAttempt,
    digest: &str,
  ) -> Result<(), StorageApiError> {
    self
      .reopening_step(token, attempt, "decide", digest, ReopeningPhase::DecidedCloud)
      .await
  }

  pub(crate) async fn commit_reopening(
    &self,
    token: &dyn IdTokenProvider,
    attempt: &ReopeningAttempt,
    digest: &str,
  ) -> Result<(), StorageApiError> {
    if !valid_sha256(digest) {
      return Err(StorageApiError::InvalidResponse);
    }
    let result: ReopeningCommit = self
      .reopening_request(
        Method::POST,
        &format!("/reopening/{}/commit", attempt.reopening_id),
        token,
        Some(serde_json::json!({ "storageEpoch": attempt.source_epoch, "manifestDigest": digest })),
      )
      .await?;
    if result.mode != StorageMode::Cloud || result.epoch != attempt.target_epoch {
      return Err(StorageApiError::InvalidResponse);
    }
    Ok(())
  }
}

#[async_trait]
impl StorageStatusClient for DocsStorageApi {
  async fn get(&self, token: &dyn IdTokenProvider) -> Result<StorageState, StorageApiError> {
    self.request(Method::GET, token, None).await
  }

  async fn select_initial(
    &self,
    token: &dyn IdTokenProvider,
    mode: StorageMode,
    expected_epoch: &str,
  ) -> Result<StorageState, StorageApiError> {
    if !matches!(mode, StorageMode::Cloud | StorageMode::Local) || expected_epoch.parse::<u64>().is_err() {
      return Err(StorageApiError::InvalidResponse);
    }
    self
      .request(
        Method::PUT,
        token,
        Some(serde_json::json!({
          "mode": mode,
          "expectedEpoch": expected_epoch,
        })),
      )
      .await
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn rejects_incomplete_or_unknown_storage_state() {
    let cloud: StorageState = serde_json::from_str(
      r#"{"mode":"CLOUD","epoch":"2","changedAt":null,"cleanupPending":false,"quotaBytes":5368709120,"closing":null}"#,
    )
    .unwrap();
    assert!(cloud.valid());
    let closing: StorageState =
      serde_json::from_str(r#"{"mode":"CLOSING","epoch":"3","changedAt":null,"cleanupPending":false,"quotaBytes":5368709120,"closing":null}"#)
        .unwrap();
    assert!(!closing.valid());
    let invalid: StorageState = serde_json::from_str(
      r#"{"mode":"LOCAL","epoch":"-1","changedAt":null,"cleanupPending":false,"quotaBytes":5368709120,"closing":null}"#,
    )
    .unwrap();
    assert!(!invalid.valid());
    assert!(serde_json::from_str::<StorageState>(
      r#"{"mode":"OTHER","epoch":"1","changedAt":null,"cleanupPending":false,"quotaBytes":5368709120,"closing":null}"#
    )
    .is_err());
  }
}
