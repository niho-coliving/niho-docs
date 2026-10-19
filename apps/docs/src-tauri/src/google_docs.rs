//! 本人の Google ドキュメント接続・書き出し専用の HTTP 境界。
//!
//! 任意 URL / method の proxy は公開しない。NIHO の ID token と書き出す本文は Rust の中だけで扱い、
//! Google の認可 URL・接続の公開状態・書き出し結果だけを WebView へ返す。

use crate::CommandError;
use niho_desktop_account::http::{HttpClient, HttpErrorKind, HttpMethod, HttpRequest, HttpResponse, ReqwestClient};
use niho_desktop_account::{service::Profile, tauri::AccountHandle, Environment};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;
use tauri::State;
use url::Url;

const RESPONSE_MAX_BYTES: usize = 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
/// NIHO アカウントの接続を受け付けるかの確かめ（設定の画面を開くたび。待たせない）。
const AVAILABILITY_TIMEOUT: Duration = Duration::from_secs(10);
const MARKDOWN_MAX_CHARS: usize = 1_000_000;
const MARKDOWN_MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Owner {
  user_id: String,
  connection_id: String,
}

impl From<Profile> for Owner {
  fn from(profile: Profile) -> Self {
    Self {
      user_id: profile.user_id,
      connection_id: profile.connection_id,
    }
  }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConnectionStatus {
  Connected,
  Disconnected,
  Error,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DriveConnection {
  status: ConnectionStatus,
  connected_email: Option<String>,
  reason: Option<String>,
}

#[derive(Deserialize)]
struct ConnectionEnvelope {
  connection: DriveConnection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectResponse {
  authorization_url: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ExportResult {
  Completed {
    #[serde(rename = "exportId")]
    export_id: String,
    #[serde(rename = "documentId")]
    document_id: String,
    url: String,
  },
  Pending {
    #[serde(rename = "exportId")]
    export_id: String,
    retryable: bool,
  },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
  export_id: String,
  title: String,
  markdown: String,
}

fn error(code: &str, message: &str) -> CommandError {
  CommandError::new(code, message)
}

fn owner(profile: Option<Profile>) -> Result<Owner, CommandError> {
  profile
    .map(Owner::from)
    .ok_or_else(|| error("signed_out", "NIHO にログインしてください。"))
}

fn owner_unchanged(before: &Owner, after: Option<Profile>) -> Result<(), CommandError> {
  if after.map(Owner::from).as_ref() == Some(before) {
    Ok(())
  } else {
    Err(error(
      "account_changed",
      "NIHO アカウントが変わりました。内容を確かめて、もう一度お試しください。",
    ))
  }
}

fn uuid_is_lowercase(value: &str) -> bool {
  let bytes = value.as_bytes();
  bytes.len() == 36
    && bytes.iter().enumerate().all(|(index, byte)| match index {
      8 | 13 | 18 | 23 => *byte == b'-',
      _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
    })
}

fn document_id_is_valid(value: &str) -> bool {
  (10..=256).contains(&value.len())
    && value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn utf16_len(value: &str) -> usize {
  value.encode_utf16().count()
}

fn validate_document_url(raw: &str, document_id: &str) -> bool {
  let Ok(url) = Url::parse(raw) else { return false };
  let canonical = format!("https://docs.google.com/document/d/{document_id}/edit");
  raw == canonical
    && url.scheme() == "https"
    && url.host_str() == Some("docs.google.com")
    && url.query().is_none()
    && url.fragment().is_none()
    && url.path() == format!("/document/d/{document_id}/edit")
}

fn validate_authorization_url(raw: &str) -> bool {
  let Ok(url) = Url::parse(raw) else { return false };
  url.scheme() == "https"
    && url.host_str() == Some("accounts.google.com")
    && url.port_or_known_default() == Some(443)
    && url.path().starts_with("/o/oauth2/")
    && url.username().is_empty()
    && url.password().is_none()
}

fn request(method: HttpMethod, url: Url, token: &str, body: Option<&Value>) -> HttpRequest {
  let request = HttpRequest::new(method, url.to_string())
    .bearer(token)
    .max_body(RESPONSE_MAX_BYTES)
    .timeout(REQUEST_TIMEOUT);
  match body {
    Some(value) => request.json(value),
    None => request,
  }
}

fn response_reason(response: &HttpResponse) -> Option<String> {
  let body = response.json()?;
  body
    .get("error")?
    .get("details")?
    .get("reason")?
    .as_str()
    .map(str::to_string)
}

fn api_error(response: &HttpResponse) -> CommandError {
  let reason = response_reason(response);
  match (response.status, reason.as_deref()) {
    // 停止スイッチ（#18892・D-18）: 接続は失効していない一時停止。ログインのやり直しではなく、再開を待つ
    (401, Some("app_connect_disabled")) => error(
      "temporarily_unavailable",
      "NIHO への接続は今、一時停止しています。再開すると、ログインし直さずにもう一度お試しいただけます。",
    ),
    (401, _) => error("signed_out", "NIHO へのログインをやり直してください。"),
    (403, Some("niho_docs_app_required")) => error("docs_app_required", "NIHO docs から、もう一度お試しください。"),
    (404, Some("export_not_found")) => error("export_not_found", "この書き出しはまだ受け付けられていません。"),
    (409, Some("drive_not_connected")) => error("drive_not_connected", "Google ドキュメントへ再接続してください。"),
    (409, Some("export_payload_conflict")) => error(
      "export_payload_conflict",
      "同じ書き出しの内容が変わっています。新しい書き出しとしてやり直してください。",
    ),
    (409, Some("google_account_changed" | "drive_connection_changed")) => error(
      "drive_connection_changed",
      "接続先の Google アカウントが変わりました。新しい書き出しとしてやり直してください。",
    ),
    (422, Some("credential_invalid" | "auth_revoked")) => {
      error("drive_reconnect_required", "Google ドキュメントへ再接続してください。")
    }
    (422, Some("drive_export_rejected")) => error(
      "drive_export_rejected",
      "Google ドキュメントを作成できませんでした。接続を確認して、同じ内容でもう一度お試しください。",
    ),
    (429, _) => error(
      "temporarily_unavailable",
      "ただいま混み合っています。少し待ってから、もう一度お試しください。",
    ),
    (503..=599, _) | (_, Some("export_temporarily_unavailable" | "access_token_failed" | "oauth_config_missing")) => {
      error(
        "temporarily_unavailable",
        "今は Google ドキュメントへ接続できません。少し待ってから、もう一度お試しください。",
      )
    }
    (400 | 413, _) => error("invalid_export", "タイトルか本文を短くして、もう一度お試しください。"),
    _ => error(
      "google_docs_failed",
      "Google ドキュメントとの通信に失敗しました。もう一度お試しください。",
    ),
  }
}

fn transport_error(kind: HttpErrorKind, uncertain_export: bool) -> CommandError {
  if uncertain_export {
    return error(
      "export_result_unknown",
      "書き出しを受け付けたか確認できません。同じ書き出しIDで結果を確認してください。",
    );
  }
  match kind {
    HttpErrorKind::Timeout | HttpErrorKind::Network => error(
      "network",
      "ネットに接続できません。接続を確認して、もう一度お試しください。",
    ),
    _ => error(
      "google_docs_failed",
      "Google ドキュメントとの通信に失敗しました。もう一度お試しください。",
    ),
  }
}

/// API の URL（path は区切りごとに、query は URL の encoder で組み立てる。文字列をつなげない）。
fn api_target(env: &Environment, path: &str, query: &[(&str, &str)]) -> Url {
  let mut url = env.api_url(path);
  if !query.is_empty() {
    url.query_pairs_mut().extend_pairs(query);
  }
  url
}

async fn call(
  handle: &AccountHandle,
  client: &dyn HttpClient,
  method: HttpMethod,
  path: &str,
  query: &[(&str, &str)],
  body: Option<&Value>,
  uncertain_export: bool,
) -> Result<HttpResponse, CommandError> {
  let service = handle.service();
  let before = owner(service.profile())?;
  let token = service
    .id_token()
    .await
    .map_err(|account| error(&account.code, &account.message))?;
  owner_unchanged(&before, service.profile())?;
  let response = client
    .send(request(
      method,
      api_target(service.env(), path, query),
      token.expose(),
      body,
    ))
    .await
    .map_err(|failure| transport_error(failure.kind, uncertain_export))?;
  owner_unchanged(&before, service.profile())?;
  Ok(response)
}

fn parse_connection(response: HttpResponse) -> Result<DriveConnection, CommandError> {
  if !(200..300).contains(&response.status) {
    return Err(api_error(&response));
  }
  let envelope: ConnectionEnvelope = serde_json::from_slice(&response.body).map_err(|_| {
    error(
      "google_docs_invalid_response",
      "Google ドキュメントの接続状態を確認できませんでした。",
    )
  })?;
  match envelope.connection.status {
    ConnectionStatus::Connected
      if envelope
        .connection
        .connected_email
        .as_deref()
        .is_none_or(|email| email.trim().is_empty()) =>
    {
      Err(error(
        "google_docs_invalid_response",
        "Google ドキュメントの接続状態を確認できませんでした。",
      ))
    }
    _ => Ok(envelope.connection),
  }
}

fn parse_export(response: HttpResponse, expected_id: &str) -> Result<ExportResult, CommandError> {
  if response.status != 200 && response.status != 202 {
    return Err(api_error(&response));
  }
  let result: ExportResult = serde_json::from_slice(&response.body)
    .map_err(|_| error("google_docs_invalid_response", "書き出しの結果を確認できませんでした。"))?;
  let returned_id = match &result {
    ExportResult::Completed { export_id, .. } | ExportResult::Pending { export_id, .. } => export_id,
  };
  if returned_id != expected_id {
    return Err(error(
      "google_docs_invalid_response",
      "書き出しの結果を確認できませんでした。",
    ));
  }
  match &result {
    ExportResult::Completed { document_id, url, .. }
      if !document_id_is_valid(document_id) || !validate_document_url(url, document_id) =>
    {
      Err(error(
        "google_docs_invalid_response",
        "Google ドキュメントのリンクを確認できませんでした。",
      ))
    }
    ExportResult::Completed { .. } if response.status != 200 => Err(error(
      "google_docs_invalid_response",
      "書き出しの結果を確認できませんでした。",
    )),
    ExportResult::Pending { .. } if response.status != 202 => Err(error(
      "google_docs_invalid_response",
      "書き出しの結果を確認できませんでした。",
    )),
    _ => Ok(result),
  }
}

fn client() -> Result<ReqwestClient, CommandError> {
  ReqwestClient::new().map_err(|_| {
    error(
      "google_docs_failed",
      "通信の準備ができませんでした。アプリを開き直してください。",
    )
  })
}

/// サーバーが NIHO アカウントの接続（app-connect）を閉じているか。`requireAppConnectEnabled` は `requireAuth` より前なので、token を
/// 付けない GET に、閉じていれば 404 `app_connect_disabled`、開いていれば 401 が返る（`apps/api/src/routes/auth-app-connect.ts`）。
fn connect_disabled(response: &HttpResponse) -> bool {
  response.status == 404 && response_reason(response).as_deref() == Some("app_connect_disabled")
}

async fn connect_available(client: &dyn HttpClient, env: &Environment) -> bool {
  let request = HttpRequest::new(HttpMethod::Get, env.api_url("auth/app-connections").to_string())
    .max_body(RESPONSE_MAX_BYTES)
    .timeout(AVAILABILITY_TIMEOUT);
  match client.send(request).await {
    Ok(response) => !connect_disabled(&response),
    // 確かめられないとき（オフラインなど）は隠さない。ログインの失敗とオフラインはアカウントの状態が伝える
    Err(_) => true,
  }
}

/// NIHO アカウントのログイン（と、それを使う Google ドキュメント）を今のサーバーで使えるか。false はサーバーが閉じていると
/// 返したときだけ。token も本文も送らない。
#[tauri::command]
pub async fn docs_account_available(handle: State<'_, AccountHandle>) -> Result<bool, CommandError> {
  let client = client()?;
  Ok(connect_available(&client, handle.service().env()).await)
}

#[tauri::command]
pub async fn docs_drive_connection(handle: State<'_, AccountHandle>) -> Result<DriveConnection, CommandError> {
  let client = client()?;
  parse_connection(
    call(
      &handle,
      &client,
      HttpMethod::Get,
      "me/docs-drive/connection",
      &[],
      None,
      false,
    )
    .await?,
  )
}

#[tauri::command]
pub async fn docs_drive_connect(handle: State<'_, AccountHandle>) -> Result<(), CommandError> {
  let client = client()?;
  let body = json!({ "returnTo": "niho-docs" });
  let response = call(
    &handle,
    &client,
    HttpMethod::Post,
    "me/docs-drive/connect",
    &[],
    Some(&body),
    false,
  )
  .await?;
  if !(200..300).contains(&response.status) {
    return Err(api_error(&response));
  }
  let response: ConnectResponse = serde_json::from_slice(&response.body)
    .map_err(|_| error("google_docs_invalid_response", "Google の接続画面を開けませんでした。"))?;
  if !validate_authorization_url(&response.authorization_url) {
    return Err(error(
      "google_docs_invalid_response",
      "Google の接続画面を開けませんでした。",
    ));
  }
  tauri_plugin_opener::open_url(&response.authorization_url, None::<&str>)
    .map_err(|_| error("browser_failed", "ブラウザを開けませんでした。もう一度お試しください。"))
}

#[tauri::command]
pub async fn docs_drive_disconnect(handle: State<'_, AccountHandle>) -> Result<DriveConnection, CommandError> {
  let client = client()?;
  parse_connection(
    call(
      &handle,
      &client,
      HttpMethod::Delete,
      "me/docs-drive/connection",
      &[],
      None,
      false,
    )
    .await?,
  )
}

#[tauri::command]
pub async fn docs_drive_export(
  handle: State<'_, AccountHandle>,
  request_data: ExportRequest,
) -> Result<ExportResult, CommandError> {
  if !uuid_is_lowercase(&request_data.export_id) {
    return Err(error("invalid_export", "書き出しを始めからやり直してください。"));
  }
  let title = request_data.title.trim();
  if title.is_empty() || utf16_len(title) > 200 {
    return Err(error("invalid_export", "タイトルは1〜200文字にしてください。"));
  }
  if request_data.markdown.is_empty()
    || utf16_len(&request_data.markdown) > MARKDOWN_MAX_CHARS
    || request_data.markdown.len() > MARKDOWN_MAX_BYTES
  {
    return Err(error("invalid_export", "本文を短くして、もう一度お試しください。"));
  }
  let body = json!({ "exportId": request_data.export_id, "title": title, "markdown": request_data.markdown });
  let client = client()?;
  let response = call(
    &handle,
    &client,
    HttpMethod::Post,
    "me/docs-drive/exports",
    &[],
    Some(&body),
    true,
  )
  .await?;
  parse_export(response, body["exportId"].as_str().unwrap_or_default())
}

#[tauri::command]
pub async fn docs_drive_export_status(
  handle: State<'_, AccountHandle>,
  export_id: String,
) -> Result<ExportResult, CommandError> {
  if !uuid_is_lowercase(&export_id) {
    return Err(error("invalid_export", "書き出しを始めからやり直してください。"));
  }
  let client = client()?;
  let path = format!("me/docs-drive/exports/{export_id}");
  parse_export(
    call(&handle, &client, HttpMethod::Get, &path, &[], None, false).await?,
    &export_id,
  )
}

#[tauri::command]
pub fn docs_drive_open_document(document_id: String) -> Result<(), CommandError> {
  if !document_id_is_valid(&document_id) {
    return Err(error(
      "google_docs_invalid_response",
      "Google ドキュメントのリンクを確認できませんでした。",
    ));
  }
  let url = format!("https://docs.google.com/document/d/{document_id}/edit");
  tauri_plugin_opener::open_url(url, None::<&str>)
    .map_err(|_| error("browser_failed", "ブラウザを開けませんでした。もう一度お試しください。"))
}

// ---- フォルダの書き出し（#18838）: フォルダのページを、タブ付きの Google ドキュメント 1 つへまとめる ----
//
// 本文は送らない（API が本人の NIHO クラウドから読む）。送るのはフォルダの id・書き出しの木の key・版・題名・タイムスタンプの有無だけ。
// 応答は型で確かめ、API の reason は決まった code にする（サーバーの本文は画面へ渡さない。文は画面が code から作る）。

/// 書き出しの木の key を一度に入れられる数（API の `include` の上限）。
const FOLDER_INCLUDE_MAX: usize = 1000;
/// 429 の Retry-After を受け取る上限（これより長い指示は画面の既定の間隔に任せる）。
const RETRY_AFTER_MAX_SECONDS: u64 = 600;
/// 受付の時刻の文字列の上限（ISO 8601 の日時。長すぎる値は受け取らない）。
const CREATED_AT_MAX_CHARS: usize = 64;
const FOLDER_NODE_KINDS: [&str; 5] = ["context", "document", "recording", "step", "candidate"];

/// NIHO クラウドのフォルダの id（保管庫の `validate_project_id` と同じ形）。
fn folder_project_id_is_valid(value: &str) -> bool {
  (4..=32).contains(&value.len())
    && value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// 書き出しの木の key（`context`・`doc:<pageId>`・`rec:<pageId>`・`step:<pageId>:<stepId>`・`cand:…`）。
fn folder_node_key_is_valid(value: &str) -> bool {
  (1..=200).contains(&value.len())
    && value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct FolderExportProgress {
  done: u64,
  total: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FolderExportFailureReason {
  GoogleUnavailable,
  FolderChanged,
  DocumentUnavailable,
  DriveConnectionChanged,
  GoogleAccountChanged,
  AuthRevoked,
  ConversionFailed,
}

impl FolderExportFailureReason {
  /// 知らない理由は None（画面は「途中で止まりました。」にする）。
  fn parse(value: &str) -> Option<Self> {
    match value {
      "google_unavailable" => Some(Self::GoogleUnavailable),
      "folder_changed" => Some(Self::FolderChanged),
      "document_unavailable" => Some(Self::DocumentUnavailable),
      "drive_connection_changed" => Some(Self::DriveConnectionChanged),
      "google_account_changed" => Some(Self::GoogleAccountChanged),
      "auth_revoked" => Some(Self::AuthRevoked),
      "conversion_failed" => Some(Self::ConversionFailed),
      _ => None,
    }
  }
}

/// フォルダの書き出しの状態（作成中・完了・止まった・結果の分からない受付）。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum FolderExportStatus {
  Pending {
    export_id: String,
    created_at: String,
    retryable: bool,
  },
  Building {
    export_id: String,
    created_at: String,
    progress: FolderExportProgress,
  },
  Completed {
    export_id: String,
    created_at: String,
    document_id: String,
    url: String,
    images_skipped: u64,
  },
  Failed {
    export_id: String,
    created_at: String,
    reason: Option<FolderExportFailureReason>,
    resumable: bool,
    progress: Option<FolderExportProgress>,
  },
}

impl FolderExportStatus {
  /// まだ NIHO 側で進んでいる（API は 202 で返す）。
  fn in_progress(&self) -> bool {
    matches!(self, Self::Pending { .. } | Self::Building { .. })
  }
}

/// 書き出しの木の 1 行。題名は利用者の文なので Debug を付けない。
#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderExportNode {
  key: String,
  kind: String,
  title: String,
  parent_key: Option<String>,
  chars: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  chars_without_timestamps: Option<u64>,
  default_selected: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderExportLimits {
  max_tabs: u64,
  max_chars: u64,
}

/// フォルダの書き出しの木（API が docs-core で作ったもの。画面はこれを出すだけ）。
#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderExportPlan {
  available: bool,
  project_id: String,
  revision: u64,
  title: String,
  nodes: Vec<FolderExportNode>,
  limits: FolderExportLimits,
  latest: Option<FolderExportStatus>,
}

/// 受付に送る内容。題名は利用者の文なので Debug を付けない。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderExportRequest {
  export_id: String,
  project_id: String,
  revision: i64,
  title: String,
  include: Vec<String>,
  timestamps: bool,
}

fn invalid_folder_response() -> CommandError {
  error("google_docs_invalid_response", "書き出しの結果を確認できませんでした。")
}

fn invalid_folder_plan() -> CommandError {
  error("google_docs_invalid_response", "フォルダの中身を読めませんでした。")
}

fn invalid_folder_request(message: &str) -> CommandError {
  error("invalid_export", message)
}

/// 送る前に確かめて、API へ送る本文を作る（題名は前後の空白を外す）。
fn folder_export_body(request: &FolderExportRequest) -> Result<Value, CommandError> {
  if !uuid_is_lowercase(&request.export_id) || request.revision < 0 {
    return Err(invalid_folder_request("書き出しを始めからやり直してください。"));
  }
  if !folder_project_id_is_valid(&request.project_id) {
    return Err(invalid_folder_request(
      "フォルダを開き直してから、もう一度お試しください。",
    ));
  }
  let title = request.title.trim();
  if title.is_empty() || utf16_len(title) > 200 {
    return Err(invalid_folder_request("タイトルは1〜200文字にしてください。"));
  }
  let mut seen = HashSet::new();
  if request.include.is_empty()
    || request.include.len() > FOLDER_INCLUDE_MAX
    || !request
      .include
      .iter()
      .all(|key| folder_node_key_is_valid(key) && seen.insert(key.as_str()))
  {
    return Err(invalid_folder_request("入れるページを選び直してください。"));
  }
  Ok(json!({
    "exportId": request.export_id,
    "projectId": request.project_id,
    "revision": request.revision,
    "title": title,
    "include": request.include,
    "timestamps": request.timestamps,
  }))
}

fn parse_folder_progress(value: Option<&Value>) -> Option<FolderExportProgress> {
  let value = value?.as_object()?;
  let done = value.get("done")?.as_u64()?;
  let total = value.get("total")?.as_u64()?;
  (done <= total).then_some(FolderExportProgress { done, total })
}

/// 受付の状態。`expected_id` を渡したときは、その受付の応答だけを受け取る。
fn parse_folder_status(value: &Value, expected_id: Option<&str>) -> Result<FolderExportStatus, CommandError> {
  let object = value.as_object().ok_or_else(invalid_folder_response)?;
  let export_id = object
    .get("exportId")
    .and_then(Value::as_str)
    .filter(|id| uuid_is_lowercase(id) && expected_id.is_none_or(|expected| expected == *id))
    .ok_or_else(invalid_folder_response)?
    .to_string();
  let created_at = object
    .get("createdAt")
    .and_then(Value::as_str)
    .filter(|value| !value.is_empty() && value.len() <= CREATED_AT_MAX_CHARS)
    .ok_or_else(invalid_folder_response)?
    .to_string();
  match object.get("status").and_then(Value::as_str) {
    Some("pending") => Ok(FolderExportStatus::Pending {
      export_id,
      created_at,
      retryable: object.get("retryable").and_then(Value::as_bool) == Some(true),
    }),
    Some("building") => Ok(FolderExportStatus::Building {
      export_id,
      created_at,
      progress: parse_folder_progress(object.get("progress")).ok_or_else(invalid_folder_response)?,
    }),
    Some("completed") => {
      let document_id = object
        .get("documentId")
        .and_then(Value::as_str)
        .filter(|id| document_id_is_valid(id))
        .ok_or_else(invalid_folder_response)?
        .to_string();
      let url = object
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| validate_document_url(url, &document_id))
        .ok_or_else(|| {
          error(
            "google_docs_invalid_response",
            "Google ドキュメントのリンクを確認できませんでした。",
          )
        })?
        .to_string();
      Ok(FolderExportStatus::Completed {
        export_id,
        created_at,
        document_id,
        url,
        images_skipped: object.get("imagesSkipped").and_then(Value::as_u64).unwrap_or(0),
      })
    }
    Some("failed") => Ok(FolderExportStatus::Failed {
      export_id,
      created_at,
      reason: object
        .get("reason")
        .and_then(Value::as_str)
        .and_then(FolderExportFailureReason::parse),
      resumable: object.get("resumable").and_then(Value::as_bool) == Some(true),
      progress: parse_folder_progress(object.get("progress")),
    }),
    _ => Err(invalid_folder_response()),
  }
}

/// 受付・照会・続きからの応答（作成中と結果の分からない受付は 202、完了と止まったは 200）。
fn parse_folder_status_response(response: HttpResponse, expected_id: &str) -> Result<FolderExportStatus, CommandError> {
  if response.status != 200 && response.status != 202 {
    return Err(folder_api_error(&response));
  }
  let value: Value = serde_json::from_slice(&response.body).map_err(|_| invalid_folder_response())?;
  let status = parse_folder_status(&value, Some(expected_id))?;
  if status.in_progress() != (response.status == 202) {
    return Err(invalid_folder_response());
  }
  Ok(status)
}

fn parse_folder_node(value: &Value, known: &HashSet<String>) -> Result<FolderExportNode, CommandError> {
  let object = value.as_object().ok_or_else(invalid_folder_plan)?;
  let key = object
    .get("key")
    .and_then(Value::as_str)
    .filter(|key| folder_node_key_is_valid(key) && !known.contains(*key))
    .ok_or_else(invalid_folder_plan)?;
  let kind = object
    .get("kind")
    .and_then(Value::as_str)
    .filter(|kind| FOLDER_NODE_KINDS.contains(kind))
    .ok_or_else(invalid_folder_plan)?;
  let title = object
    .get("title")
    .and_then(Value::as_str)
    .ok_or_else(invalid_folder_plan)?;
  // 親の行は子の行より前に来る（並びのまま字下げするため）
  let parent_key = match object.get("parentKey") {
    Some(Value::Null) => None,
    Some(Value::String(parent)) if known.contains(parent) => Some(parent.clone()),
    _ => return Err(invalid_folder_plan()),
  };
  let chars = object
    .get("chars")
    .and_then(Value::as_u64)
    .ok_or_else(invalid_folder_plan)?;
  let chars_without_timestamps = match object.get("charsWithoutTimestamps") {
    None => None,
    Some(value) => Some(value.as_u64().ok_or_else(invalid_folder_plan)?),
  };
  let default_selected = object
    .get("defaultSelected")
    .and_then(Value::as_bool)
    .ok_or_else(invalid_folder_plan)?;
  Ok(FolderExportNode {
    key: key.to_string(),
    kind: kind.to_string(),
    title: title.to_string(),
    parent_key,
    chars,
    chars_without_timestamps,
    default_selected,
  })
}

/// 書き出しの木（そのフォルダの応答だけ）。
fn parse_folder_plan(response: HttpResponse, project_id: &str) -> Result<FolderExportPlan, CommandError> {
  if response.status != 200 {
    return Err(folder_api_error(&response));
  }
  let value: Value = serde_json::from_slice(&response.body).map_err(|_| invalid_folder_plan())?;
  let object = value.as_object().ok_or_else(invalid_folder_plan)?;
  if object.get("projectId").and_then(Value::as_str) != Some(project_id) {
    return Err(invalid_folder_plan());
  }
  let available = object
    .get("available")
    .and_then(Value::as_bool)
    .ok_or_else(invalid_folder_plan)?;
  let revision = object
    .get("revision")
    .and_then(Value::as_u64)
    .ok_or_else(invalid_folder_plan)?;
  let title = object
    .get("title")
    .and_then(Value::as_str)
    .ok_or_else(invalid_folder_plan)?;
  let limits = object
    .get("limits")
    .and_then(Value::as_object)
    .ok_or_else(invalid_folder_plan)?;
  let limit = |name: &str| {
    limits
      .get(name)
      .and_then(Value::as_u64)
      .filter(|value| *value >= 1)
      .ok_or_else(invalid_folder_plan)
  };
  let limits = FolderExportLimits {
    max_tabs: limit("maxTabs")?,
    max_chars: limit("maxChars")?,
  };
  let raw_nodes = object
    .get("nodes")
    .and_then(Value::as_array)
    .ok_or_else(invalid_folder_plan)?;
  let mut known = HashSet::new();
  let mut nodes = Vec::with_capacity(raw_nodes.len());
  for raw in raw_nodes {
    let node = parse_folder_node(raw, &known)?;
    known.insert(node.key.clone());
    nodes.push(node);
  }
  let latest = match object.get("latest") {
    None | Some(Value::Null) => None,
    Some(latest) => Some(parse_folder_status(latest, None)?),
  };
  Ok(FolderExportPlan {
    available,
    project_id: project_id.to_string(),
    revision,
    title: title.to_string(),
    nodes,
    limits,
    latest,
  })
}

/// 上限を超えた（422 `export_too_large`）。画面が超えた量を出せるよう、数だけを details に移す。
fn folder_too_large(response: &HttpResponse) -> CommandError {
  let failure = error(
    "export_too_large",
    "入れるページが多すぎます。いくつか外してから、もう一度お試しください。",
  );
  let Some(details) = response
    .json()
    .and_then(|body| body.get("error")?.get("details").cloned())
  else {
    return failure;
  };
  let count = |name: &str| details.get(name).and_then(Value::as_u64);
  let (Some(tabs), Some(chars)) = (count("tabs"), count("chars")) else {
    return failure;
  };
  let mut out = serde_json::Map::new();
  out.insert("tabs".into(), tabs.into());
  out.insert("chars".into(), chars.into());
  for name in ["maxTabs", "maxChars"] {
    if let Some(value) = count(name).filter(|value| *value >= 1) {
      out.insert(name.into(), value.into());
    }
  }
  failure.with_details(Value::Object(out))
}

fn retry_after_ms(response: &HttpResponse) -> Option<u64> {
  let seconds: u64 = response.header_value("retry-after")?.trim().parse().ok()?;
  (1..=RETRY_AFTER_MAX_SECONDS)
    .contains(&seconds)
    .then_some(seconds * 1000)
}

/// フォルダの書き出しの API の失敗。フォルダの書き出しだけの reason を先に見て、残りは 1 ページの書き出しと同じにする。
fn folder_api_error(response: &HttpResponse) -> CommandError {
  let reason = response_reason(response);
  match (response.status, reason.as_deref()) {
    (404, Some("folder_not_found")) => error("folder_not_found", "フォルダが見つかりませんでした。"),
    (409, Some("folder_changed")) => error("folder_changed", "フォルダが更新されました。中身を読み直してください。"),
    (400, Some("invalid_selection")) => error("invalid_selection", "入れるページを選び直してください。"),
    (422, Some("export_too_large")) => folder_too_large(response),
    (409, Some("export_not_resumable")) => error("export_not_resumable", "この書き出しは続きから作れません。"),
    (503, Some("folder_export_unavailable")) => error(
      "folder_export_unavailable",
      "今は書き出せません。時間をおいてもう一度お試しください。",
    ),
    // 1 ページの書き出しは接続の変化とまとめるが、フォルダの書き出しは別の Google アカウントへの切り替えを分けて伝える
    (409, Some("google_account_changed")) => {
      error("google_account_changed", "接続先の Google アカウントが変わりました。")
    }
    (429, _) => {
      let failure = api_error(response);
      match retry_after_ms(response) {
        Some(ms) => failure.with_details(json!({ "retryAfterMs": ms })),
        None => failure,
      }
    }
    // 受け付けたかどうか分からない（前段の proxy の 502 なども）。画面は同じ ID で照会する
    (500..=599, _) => error(
      "temporarily_unavailable",
      "今は Google ドキュメントへ接続できません。少し待ってから、もう一度お試しください。",
    ),
    _ => api_error(response),
  }
}

fn folder_export_id(export_id: &str) -> Result<(), CommandError> {
  if uuid_is_lowercase(export_id) {
    Ok(())
  } else {
    Err(invalid_folder_request("書き出しを始めからやり直してください。"))
  }
}

#[tauri::command]
pub async fn docs_drive_folder_export_plan(
  handle: State<'_, AccountHandle>,
  project_id: String,
) -> Result<FolderExportPlan, CommandError> {
  if !folder_project_id_is_valid(&project_id) {
    return Err(invalid_folder_request(
      "フォルダを開き直してから、もう一度お試しください。",
    ));
  }
  let client = client()?;
  let response = call(
    &handle,
    &client,
    HttpMethod::Get,
    "me/docs-drive/folder-exports/plan",
    &[("projectId", &project_id)],
    None,
    false,
  )
  .await?;
  parse_folder_plan(response, &project_id)
}

#[tauri::command]
pub async fn docs_drive_folder_export(
  handle: State<'_, AccountHandle>,
  request_data: FolderExportRequest,
) -> Result<FolderExportStatus, CommandError> {
  let body = folder_export_body(&request_data)?;
  let client = client()?;
  // 送った後に通信が切れたら、作られたか分からない（同じ ID で照会する）
  let response = call(
    &handle,
    &client,
    HttpMethod::Post,
    "me/docs-drive/folder-exports",
    &[],
    Some(&body),
    true,
  )
  .await?;
  parse_folder_status_response(response, &request_data.export_id)
}

#[tauri::command]
pub async fn docs_drive_folder_export_status(
  handle: State<'_, AccountHandle>,
  export_id: String,
) -> Result<FolderExportStatus, CommandError> {
  folder_export_id(&export_id)?;
  let client = client()?;
  let path = format!("me/docs-drive/folder-exports/{export_id}");
  parse_folder_status_response(
    call(&handle, &client, HttpMethod::Get, &path, &[], None, false).await?,
    &export_id,
  )
}

#[tauri::command]
pub async fn docs_drive_folder_export_resume(
  handle: State<'_, AccountHandle>,
  export_id: String,
) -> Result<FolderExportStatus, CommandError> {
  folder_export_id(&export_id)?;
  let client = client()?;
  let path = format!("me/docs-drive/folder-exports/{export_id}/resume");
  parse_folder_status_response(
    call(&handle, &client, HttpMethod::Post, &path, &[], None, false).await?,
    &export_id,
  )
}

#[cfg(test)]
mod tests {
  use super::*;
  use niho_desktop_account::http::{HttpError, HttpFuture};
  use niho_desktop_account::{ClientId, EnvKind, Environment};
  use std::future::Future;
  use std::sync::{Arc, Mutex};
  use std::task::{Context, Poll, Wake, Waker};

  struct FakeHttp {
    requests: Mutex<Vec<HttpRequest>>,
    response: HttpResponse,
  }

  impl HttpClient for FakeHttp {
    fn send(&self, request: HttpRequest) -> HttpFuture<'_> {
      self.requests.lock().unwrap().push(request);
      let response = self.response.clone();
      Box::pin(async move { Ok(response) })
    }
  }

  struct NoopWake;
  impl Wake for NoopWake {
    fn wake(self: Arc<Self>) {}
  }

  fn ready_response(mut future: HttpFuture<'_>) -> Result<HttpResponse, HttpError> {
    let waker = Waker::from(Arc::new(NoopWake));
    let mut context = Context::from_waker(&waker);
    match Future::poll(future.as_mut(), &mut context) {
      Poll::Ready(value) => value,
      Poll::Pending => panic!("fake HTTP future must be ready"),
    }
  }

  fn response(status: u16, value: Value) -> HttpResponse {
    HttpResponse {
      status,
      headers: vec![],
      body: serde_json::to_vec(&value).unwrap(),
    }
  }

  #[test]
  fn authenticated_request_hides_token_and_body_from_debug() {
    let env = Environment::new(ClientId::Docs, EnvKind::Prod, "public-key");
    let built = request(
      HttpMethod::Post,
      env.api_url("me/docs-drive/exports"),
      "secret-id-token",
      Some(&json!({ "markdown": "private body" })),
    );
    let fake = FakeHttp {
      requests: Mutex::new(vec![]),
      response: response(
        202,
        json!({
          "exportId": "6d3d8f4e-61b4-45f4-9e47-f95223d677a1", "status": "pending", "retryable": false
        }),
      ),
    };
    assert_eq!(ready_response(fake.send(built.clone())).unwrap().status, 202);
    let requests = fake.requests.lock().unwrap();
    let built = requests.first().unwrap();
    assert_eq!(built.method, HttpMethod::Post);
    assert_eq!(built.url, "https://niho.life/api/me/docs-drive/exports");
    assert_eq!(built.header_value("authorization"), Some("Bearer secret-id-token"));
    assert_eq!(built.timeout, REQUEST_TIMEOUT);
    let debug = format!("{built:?}");
    assert!(!debug.contains("secret-id-token"));
    assert!(!debug.contains("private body"));
  }

  #[test]
  fn owner_change_and_invalid_ids_are_rejected() {
    let before = Owner {
      user_id: "u1".into(),
      connection_id: "c1".into(),
    };
    let after = Profile {
      user_id: "u2".into(),
      display_name: String::new(),
      handle: None,
      avatar_path: None,
      connection_id: "c2".into(),
    };
    assert!(owner_unchanged(&before, Some(after)).is_err());
    assert!(uuid_is_lowercase("6d3d8f4e-61b4-45f4-9e47-f95223d677a1"));
    assert!(!uuid_is_lowercase("6D3D8F4E-61B4-45F4-9E47-F95223D677A1"));
    assert!(!document_id_is_valid("../../secret"));
    assert_eq!(utf16_len("A😀"), 3);
  }

  #[test]
  fn export_response_requires_matching_id_and_canonical_google_url() {
    let id = "6d3d8f4e-61b4-45f4-9e47-f95223d677a1";
    let good = response(
      200,
      json!({
        "exportId": id, "status": "completed", "documentId": "abcDEF_123-456", "url": "https://docs.google.com/document/d/abcDEF_123-456/edit"
      }),
    );
    assert!(matches!(parse_export(good, id), Ok(ExportResult::Completed { .. })));
    let bad = response(
      200,
      json!({
        "exportId": id, "status": "completed", "documentId": "abcDEF_123-456", "url": "https://evil.example/document/d/abcDEF_123-456/edit"
      }),
    );
    assert!(parse_export(bad, id).is_err());
    assert!(!validate_document_url(
      "https://docs.google.com:443/document/d/abcDEF_123-456/edit",
      "abcDEF_123-456"
    ));
    assert!(validate_authorization_url(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=public"
    ));
    assert!(!validate_authorization_url(
      "https://accounts.google.com:8443/o/oauth2/v2/auth?client_id=public"
    ));
  }

  #[test]
  fn account_availability_is_false_only_when_the_server_closes_app_connect() {
    let env = Environment::new(ClientId::Docs, EnvKind::Prod, "public-key");
    let disabled = FakeHttp {
      requests: Mutex::new(vec![]),
      response: response(
        404,
        json!({ "error": { "code": "NOT_FOUND", "message": "raw", "details": { "reason": "app_connect_disabled" } } }),
      ),
    };
    let mut future = Box::pin(connect_available(&disabled, &env));
    let waker = Waker::from(Arc::new(NoopWake));
    let Poll::Ready(available) = Future::poll(future.as_mut(), &mut Context::from_waker(&waker)) else {
      panic!("fake HTTP future must be ready");
    };
    assert!(!available);
    let requests = disabled.requests.lock().unwrap();
    let sent = requests.first().unwrap();
    assert_eq!(sent.method, HttpMethod::Get);
    assert_eq!(sent.url, "https://niho.life/api/auth/app-connections");
    assert_eq!(sent.header_value("authorization"), None);
    assert_eq!(sent.timeout, AVAILABILITY_TIMEOUT);

    for open in [
      response(401, json!({ "error": { "code": "UNAUTHORIZED" } })),
      response(404, json!({ "error": { "code": "NOT_FOUND" } })),
      response(503, json!({})),
    ] {
      let fake = FakeHttp {
        requests: Mutex::new(vec![]),
        response: open,
      };
      let mut future = Box::pin(connect_available(&fake, &env));
      let Poll::Ready(available) = Future::poll(future.as_mut(), &mut Context::from_waker(&waker)) else {
        panic!("fake HTTP future must be ready");
      };
      assert!(available);
    }
  }

  #[test]
  fn api_reasons_are_mapped_without_exposing_server_body() {
    let response = response(
      409,
      json!({ "error": { "message": "raw", "details": { "reason": "google_account_changed" } } }),
    );
    let mapped = api_error(&response);
    assert_eq!(mapped.code, "drive_connection_changed");
    assert!(!mapped.message.contains("raw"));
  }

  #[test]
  fn an_unauthorized_response_asks_for_login_but_a_paused_connection_does_not() {
    let login = api_error(&response(401, json!({ "error": { "code": "UNAUTHORIZED" } })));
    assert_eq!(login.code, "signed_out");
    let paused = api_error(&response(
      401,
      json!({ "error": { "code": "UNAUTHORIZED", "details": { "reason": "app_connect_disabled" } } }),
    ));
    assert_eq!(paused.code, "temporarily_unavailable");
    let revoked = api_error(&response(
      401,
      json!({ "error": { "code": "UNAUTHORIZED", "details": { "reason": "app_connection_revoked" } } }),
    ));
    assert_eq!(revoked.code, "signed_out");
  }

  const FOLDER_EXPORT_ID: &str = "0f8a5b2e-3c1d-4e5f-8a9b-0c1d2e3f4a5b";
  const FOLDER_DOC_URL: &str = "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit";

  fn folder_request(fields: Value) -> FolderExportRequest {
    let mut base = json!({
      "exportId": FOLDER_EXPORT_ID,
      "projectId": "proj_0001",
      "revision": 3,
      "title": "  鎌倉の朝市  ",
      "include": ["doc:memo", "rec:rec1", "step:rec1:fix"],
      "timestamps": false,
    });
    for (key, value) in fields.as_object().unwrap() {
      base[key] = value.clone();
    }
    serde_json::from_value(base).unwrap()
  }

  fn folder_plan_value() -> Value {
    json!({
      "available": true,
      "projectId": "proj_0001",
      "revision": 3,
      "title": "鎌倉の朝市",
      "nodes": [
        { "key": "context", "kind": "context", "title": "背景情報", "parentKey": null, "chars": 120, "defaultSelected": false },
        { "key": "rec:rec1", "kind": "recording", "title": "朝市の録音", "parentKey": null, "chars": 80, "defaultSelected": true },
        { "key": "step:rec1:fix", "kind": "step", "title": "修正版", "parentKey": "rec:rec1", "chars": 25400, "charsWithoutTimestamps": 21000, "defaultSelected": true }
      ],
      "limits": { "maxTabs": 100, "maxChars": 1000000 },
      "latest": null,
    })
  }

  #[test]
  fn folder_request_is_checked_before_sending_and_only_sends_keys() {
    let body = folder_export_body(&folder_request(json!({}))).unwrap();
    assert_eq!(
      body,
      json!({
        "exportId": FOLDER_EXPORT_ID, "projectId": "proj_0001", "revision": 3, "title": "鎌倉の朝市",
        "include": ["doc:memo", "rec:rec1", "step:rec1:fix"], "timestamps": false,
      })
    );
    let rejected = [
      json!({ "exportId": FOLDER_EXPORT_ID.to_uppercase() }),
      json!({ "projectId": "p1" }),
      json!({ "projectId": "../proj" }),
      json!({ "revision": -1 }),
      json!({ "title": "   " }),
      json!({ "title": "😀".repeat(101) }),
      json!({ "include": [] }),
      json!({ "include": ["doc:memo", "doc:memo"] }),
      json!({ "include": ["doc/memo"] }),
      json!({ "include": (0..1001).map(|index| format!("doc:p{index}")).collect::<Vec<_>>() }),
    ];
    for fields in rejected {
      let failure = folder_export_body(&folder_request(fields.clone())).unwrap_err();
      assert_eq!(failure.code, "invalid_export", "{fields}");
    }
    assert!(folder_export_body(&folder_request(json!({ "title": "😀".repeat(100) }))).is_ok());
  }

  #[test]
  fn folder_plan_url_uses_the_encoder_and_request_debug_hides_token_and_title() {
    let env = Environment::new(ClientId::Docs, EnvKind::Prod, "public-key");
    let url = api_target(&env, "me/docs-drive/folder-exports/plan", &[("projectId", "proj_0001")]);
    assert_eq!(
      url.as_str(),
      "https://niho.life/api/me/docs-drive/folder-exports/plan?projectId=proj_0001"
    );
    let encoded = api_target(&env, "me/docs-drive/folder-exports/plan", &[("projectId", "a&b=c")]);
    assert_eq!(encoded.query(), Some("projectId=a%26b%3Dc"));
    let body = folder_export_body(&folder_request(json!({ "title": "社外秘の題名" }))).unwrap();
    let built = request(
      HttpMethod::Post,
      api_target(&env, "me/docs-drive/folder-exports", &[]),
      "secret-id-token",
      Some(&body),
    );
    assert_eq!(built.url, "https://niho.life/api/me/docs-drive/folder-exports");
    assert_eq!(built.timeout, REQUEST_TIMEOUT);
    let debug = format!("{built:?}");
    assert!(!debug.contains("secret-id-token"));
    assert!(!debug.contains("社外秘の題名"));
  }

  #[test]
  fn folder_plan_is_typed_and_rejects_broken_trees() {
    let Ok(plan) = parse_folder_plan(response(200, folder_plan_value()), "proj_0001") else {
      panic!("valid plan must parse");
    };
    assert_eq!(plan.revision, 3);
    assert_eq!(plan.nodes.len(), 3);
    assert_eq!(plan.nodes[2].parent_key.as_deref(), Some("rec:rec1"));
    assert_eq!(plan.nodes[2].chars_without_timestamps, Some(21000));
    assert_eq!(plan.nodes[0].chars_without_timestamps, None);
    assert_eq!(
      plan.limits,
      FolderExportLimits {
        max_tabs: 100,
        max_chars: 1_000_000
      }
    );
    assert!(plan.latest.is_none());
    let serialized = serde_json::to_value(&plan).unwrap();
    assert_eq!(serialized["nodes"][0]["parentKey"], Value::Null);
    assert!(serialized["nodes"][0].get("charsWithoutTimestamps").is_none());
    assert_eq!(serialized["nodes"][2]["defaultSelected"], json!(true));

    let broken: [fn(&mut Value); 8] = [
      |plan| plan["projectId"] = json!("proj_0002"),
      |plan| plan["nodes"][2]["parentKey"] = json!("rec:later"),
      |plan| plan["nodes"][1]["key"] = json!("context"),
      |plan| plan["nodes"][1]["key"] = json!("rec/rec1"),
      |plan| plan["nodes"][1]["kind"] = json!("folder"),
      |plan| plan["nodes"][1]["chars"] = json!(-1),
      |plan| plan["limits"]["maxTabs"] = json!(0),
      |plan| {
        plan["latest"] = json!({ "exportId": FOLDER_EXPORT_ID, "status": "completed", "createdAt": "2026-10-18T00:00:00.000Z",
        "documentId": "1AbCdEfGhIjKlMnOpQrStUv", "url": "https://evil.example/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit" })
      },
    ];
    for change in broken {
      let mut value = folder_plan_value();
      change(&mut value);
      assert!(parse_folder_plan(response(200, value), "proj_0001").is_err());
    }

    let mut with_latest = folder_plan_value();
    with_latest["latest"] = json!({
      "exportId": FOLDER_EXPORT_ID, "status": "building", "progress": { "done": 1, "total": 5 }, "createdAt": "2026-10-18T00:00:00.000Z"
    });
    let Ok(plan) = parse_folder_plan(response(200, with_latest), "proj_0001") else {
      panic!("plan with latest must parse");
    };
    assert!(matches!(
      plan.latest,
      Some(FolderExportStatus::Building {
        progress: FolderExportProgress { done: 1, total: 5 },
        ..
      })
    ));
  }

  #[test]
  fn folder_status_checks_the_id_progress_url_and_status_code() {
    let created = "2026-10-18T00:00:00.000Z";
    let building = json!({ "exportId": FOLDER_EXPORT_ID, "status": "building", "progress": { "done": 2, "total": 4 }, "createdAt": created });
    assert!(matches!(
      parse_folder_status_response(response(202, building.clone()), FOLDER_EXPORT_ID),
      Ok(FolderExportStatus::Building { .. })
    ));
    // 作成中は 202 だけ・別の受付の応答は受け取らない
    assert!(parse_folder_status_response(response(200, building.clone()), FOLDER_EXPORT_ID).is_err());
    assert!(parse_folder_status_response(response(202, building), "6d3d8f4e-61b4-45f4-9e47-f95223d677a1").is_err());
    let overrun = json!({ "exportId": FOLDER_EXPORT_ID, "status": "building", "progress": { "done": 5, "total": 4 }, "createdAt": created });
    assert!(parse_folder_status_response(response(202, overrun), FOLDER_EXPORT_ID).is_err());

    let completed = json!({ "exportId": FOLDER_EXPORT_ID, "status": "completed", "documentId": "1AbCdEfGhIjKlMnOpQrStUv", "url": FOLDER_DOC_URL,
      "imagesSkipped": 2, "createdAt": created });
    let Ok(FolderExportStatus::Completed {
      document_id,
      images_skipped,
      ..
    }) = parse_folder_status_response(response(200, completed.clone()), FOLDER_EXPORT_ID)
    else {
      panic!("completed must parse");
    };
    assert_eq!(document_id, "1AbCdEfGhIjKlMnOpQrStUv");
    assert_eq!(images_skipped, 2);
    let mut tampered = completed;
    tampered["url"] = json!("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit?usp=x");
    assert!(parse_folder_status_response(response(200, tampered), FOLDER_EXPORT_ID).is_err());

    let failed = json!({ "exportId": FOLDER_EXPORT_ID, "status": "failed", "reason": "something_new", "resumable": true, "createdAt": created });
    assert_eq!(
      parse_folder_status_response(response(200, failed), FOLDER_EXPORT_ID).unwrap(),
      FolderExportStatus::Failed {
        export_id: FOLDER_EXPORT_ID.into(),
        created_at: created.into(),
        reason: None,
        resumable: true,
        progress: None,
      }
    );
    let pending = json!({ "exportId": FOLDER_EXPORT_ID, "status": "pending", "retryable": true, "createdAt": created });
    let serialized =
      serde_json::to_value(parse_folder_status_response(response(202, pending), FOLDER_EXPORT_ID).unwrap()).unwrap();
    assert_eq!(
      serialized,
      json!({ "status": "pending", "exportId": FOLDER_EXPORT_ID, "createdAt": created, "retryable": true })
    );
  }

  #[test]
  fn folder_api_reasons_become_fixed_codes_without_the_server_body() {
    let failure = |status: u16, details: Value| {
      folder_api_error(&response(
        status,
        json!({ "error": { "code": "X", "message": "サーバーの生の文", "details": details } }),
      ))
    };
    for (status, reason, code) in [
      (404, "folder_not_found", "folder_not_found"),
      (409, "folder_changed", "folder_changed"),
      (400, "invalid_selection", "invalid_selection"),
      (409, "export_not_resumable", "export_not_resumable"),
      (503, "folder_export_unavailable", "folder_export_unavailable"),
      (409, "google_account_changed", "google_account_changed"),
      (409, "drive_connection_changed", "drive_connection_changed"),
      (409, "drive_not_connected", "drive_not_connected"),
      (422, "auth_revoked", "drive_reconnect_required"),
      (422, "drive_export_rejected", "drive_export_rejected"),
      (503, "export_temporarily_unavailable", "temporarily_unavailable"),
      (502, "", "temporarily_unavailable"),
      (404, "export_not_found", "export_not_found"),
    ] {
      let mapped = failure(status, json!({ "reason": reason, "revision": 9 }));
      assert_eq!(mapped.code, code, "{reason}");
      assert!(!mapped.message.contains("サーバーの生の文"));
      assert!(mapped.details.is_none(), "{reason}");
    }
    let too_large = failure(
      422,
      json!({ "reason": "export_too_large", "tabs": 120, "chars": 1234567, "maxTabs": 100, "maxChars": 1000000, "note": "raw" }),
    );
    assert_eq!(too_large.code, "export_too_large");
    assert_eq!(
      too_large.details,
      Some(json!({ "tabs": 120, "chars": 1234567, "maxTabs": 100, "maxChars": 1000000 }))
    );
    let without_counts = failure(422, json!({ "reason": "export_too_large" }));
    assert_eq!(without_counts.code, "export_too_large");
    assert!(without_counts.details.is_none());

    let mut limited = response(429, json!({ "error": { "message": "raw" } }));
    limited.headers = vec![("Retry-After".into(), "7".into())];
    let mapped = folder_api_error(&limited);
    assert_eq!(mapped.code, "temporarily_unavailable");
    assert_eq!(mapped.details, Some(json!({ "retryAfterMs": 7000 })));
    limited.headers = vec![("Retry-After".into(), "99999".into())];
    assert!(folder_api_error(&limited).details.is_none());
    assert_eq!(
      transport_error(HttpErrorKind::Network, true).code,
      "export_result_unknown"
    );
  }
}
