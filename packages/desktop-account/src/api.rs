//! API の呼び出しの形（spec「API の契約」・contracts/openapi.yaml）と、返りの読み取り・失敗の分類。
//! 本文に token が入るので、ここで作った request / response をログに出さない。

use crate::client::{ClientId, Environment, DEVICE_NAME_MAX_CHARS};
use crate::http::{HttpError, HttpErrorKind, HttpMethod, HttpRequest, HttpResponse};
use crate::secret::Secret;
use serde_json::{json, Value};
use std::time::Duration;

/// `POST /api/auth/app-connect/exchange`
pub fn exchange_request(env: &Environment, code: &str, verifier: &Secret, device_name: &str) -> HttpRequest {
  let mut body = json!({
    "clientId": env.client.as_str(),
    "code": code,
    "codeVerifier": verifier.expose(),
  });
  if let Some(name) = normalize_device_name(device_name) {
    body["deviceName"] = Value::String(name);
  }
  HttpRequest::new(HttpMethod::Post, env.api_url("auth/app-connect/exchange")).json(&body)
}

/// `POST /api/auth/app-connect/refresh`
pub fn refresh_request(env: &Environment, refresh_token: &Secret) -> HttpRequest {
  HttpRequest::new(HttpMethod::Post, env.api_url("auth/app-connect/refresh")).json(&json!({
    "clientId": env.client.as_str(),
    "refreshToken": refresh_token.expose(),
  }))
}

/// Identity Toolkit `accounts:signInWithCustomToken`
pub fn sign_in_request(env: &Environment, custom_token: &Secret) -> HttpRequest {
  HttpRequest::new(HttpMethod::Post, env.sign_in_with_custom_token_url()).json(&json!({
    "token": custom_token.expose(),
    "returnSecureToken": true,
  }))
}

/// `GET /api/auth/me`
pub fn me_request(env: &Environment, id_token: &Secret) -> HttpRequest {
  HttpRequest::new(HttpMethod::Get, env.api_url("auth/me"))
    .header("accept", "application/json")
    .bearer(id_token.expose())
}

/// `POST /api/auth/sign-out-everywhere`（L6・D-17。「ほかの端末でもログアウトする」。本文は `{}`）
pub fn sign_out_everywhere_request(env: &Environment, id_token: &Secret) -> HttpRequest {
  HttpRequest::new(HttpMethod::Post, env.api_url("auth/sign-out-everywhere"))
    .json(&json!({}))
    .bearer(id_token.expose())
    .timeout(Duration::from_secs(15))
}

/// `DELETE /api/auth/app-connections/{id}?reason=logout`
pub fn delete_connection_request(env: &Environment, id_token: &Secret, connection_id: &str) -> HttpRequest {
  let mut url = env.api_url(&format!("auth/app-connections/{connection_id}"));
  url.query_pairs_mut().append_pair("reason", "logout");
  HttpRequest::new(HttpMethod::Delete, url)
    .bearer(id_token.expose())
    .timeout(Duration::from_secs(10))
}

/// 顔写真（署名 URL）。512 KB まで。
pub fn avatar_request(url: &str, max_bytes: usize) -> HttpRequest {
  HttpRequest::new(HttpMethod::Get, url)
    .header("accept", "image/*")
    .max_body(max_bytes)
}

/// `deviceName`（contracts の `normalizeAppConnectDeviceName` と同じ: 制御文字を除き、前後の空白を落とし、80 文字に切る）。
pub fn normalize_device_name(value: &str) -> Option<String> {
  let stripped: String = value
    .chars()
    .filter(|ch| !ch.is_control() && !('\u{7f}'..='\u{9f}').contains(ch))
    .collect();
  let trimmed = stripped.trim();
  if trimmed.is_empty() {
    return None;
  }
  Some(trimmed.chars().take(DEVICE_NAME_MAX_CHARS).collect())
}

/// `exchange` の返り。
#[derive(Clone, Debug)]
pub struct ExchangeResponse {
  pub custom_token: Secret,
  pub refresh_token: Secret,
  pub connection_id: String,
  pub user: UserSummary,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserSummary {
  pub id: String,
  pub display_name: Option<String>,
  pub handle: Option<String>,
  /// 顔写真の署名 URL（`thumb` があればそれ）
  pub icon_url: Option<String>,
}

/// `refresh` の返り。
#[derive(Clone, Debug)]
pub struct RefreshResponse {
  pub custom_token: Secret,
  /// 取り替えた新しい接続 refresh token（L6・D-15）。以後はこれだけを使う。旧サーバー（取り替えない）は返さないので `None`
  pub refresh_token: Option<Secret>,
}

/// `signInWithCustomToken` の返り（`refreshToken` は読まない・持たない。D-6）。
#[derive(Clone, Debug)]
pub struct SignInResponse {
  pub id_token: Secret,
  pub expires_in: Duration,
}

/// API の失敗（status と、`{ error: { code, details: { reason } } }`）。本文は持たない。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiFailure {
  pub status: u16,
  pub code: Option<String>,
  pub reason: Option<String>,
}

impl ApiFailure {
  pub fn from_response(response: &HttpResponse) -> ApiFailure {
    let json = response.json();
    let error = json.as_ref().and_then(|value| value.get("error"));
    let code = error
      .and_then(|error| error.get("code"))
      .and_then(Value::as_str)
      .map(str::to_string);
    let reason = error
      .and_then(|error| error.get("details"))
      .and_then(|details| details.get("reason"))
      .and_then(Value::as_str)
      .map(str::to_string);
    ApiFailure {
      status: response.status,
      code,
      reason,
    }
  }

  pub fn reason_is(&self, reason: &str) -> bool {
    self.reason.as_deref() == Some(reason)
  }

  pub fn code_is(&self, code: &str) -> bool {
    self.code.as_deref() == Some(code)
  }

  /// ログに残す要約（秘密は入らない）。
  pub fn log_value(&self) -> Value {
    json!({ "status": self.status, "code": self.code, "reason": self.reason })
  }
}

/// 呼び出しの結果の分類（通信の失敗・API の失敗・形の違う返り）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CallFailure {
  /// 通信そのもの（ネットワーク・時間切れ）
  Transport(HttpErrorKind),
  /// 2xx 以外
  Api(ApiFailure),
  /// 2xx だが読めない
  Malformed,
}

impl From<HttpError> for CallFailure {
  fn from(error: HttpError) -> CallFailure {
    CallFailure::Transport(error.kind)
  }
}

impl CallFailure {
  pub fn log_value(&self) -> Value {
    match self {
      CallFailure::Transport(kind) => json!({ "transport": format!("{kind:?}") }),
      CallFailure::Api(failure) => failure.log_value(),
      CallFailure::Malformed => json!({ "malformed": true }),
    }
  }

  /// 一時的（状態を変えずに再試行する）か。ネットワーク・5xx・503・429・形の違う返り。
  pub fn is_temporary(&self) -> bool {
    match self {
      CallFailure::Transport(_) | CallFailure::Malformed => true,
      CallFailure::Api(failure) => failure.status >= 500 || failure.status == 429,
    }
  }
}

fn ok_json(response: &HttpResponse) -> Result<Value, CallFailure> {
  if !(200..300).contains(&response.status) {
    return Err(CallFailure::Api(ApiFailure::from_response(response)));
  }
  response.json().ok_or(CallFailure::Malformed)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
  value
    .get(key)
    .and_then(Value::as_str)
    .filter(|s| !s.is_empty())
    .map(str::to_string)
}

fn optional_string_field(value: &Value, key: &str) -> Option<String> {
  value
    .get(key)
    .and_then(Value::as_str)
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(str::to_string)
}

/// `UploadedImage` → 署名 URL（`thumb.signedUrl` があればそれ、無ければ `signedUrl`）。https だけ。
pub fn icon_url(image: Option<&Value>) -> Option<String> {
  let image = image?.as_object()?;
  let thumb = image.get("thumb").and_then(|thumb| string_field(thumb, "signedUrl"));
  let url = thumb.or_else(|| image.get("signedUrl").and_then(Value::as_str).map(str::to_string))?;
  url.starts_with("https://").then_some(url)
}

pub fn parse_user_summary(user: &Value) -> Option<UserSummary> {
  Some(UserSummary {
    id: string_field(user, "id")?,
    display_name: optional_string_field(user, "displayName"),
    handle: optional_string_field(user, "handle"),
    icon_url: icon_url(user.get("iconImage")),
  })
}

pub fn parse_exchange(response: &HttpResponse) -> Result<ExchangeResponse, CallFailure> {
  let json = ok_json(response)?;
  let custom_token = string_field(&json, "customToken").ok_or(CallFailure::Malformed)?;
  let refresh_token = string_field(&json, "refreshToken").ok_or(CallFailure::Malformed)?;
  let connection_id = string_field(&json, "connectionId").ok_or(CallFailure::Malformed)?;
  let user = json
    .get("user")
    .and_then(parse_user_summary)
    .ok_or(CallFailure::Malformed)?;
  Ok(ExchangeResponse {
    custom_token: Secret::new(custom_token),
    refresh_token: Secret::new(refresh_token),
    connection_id,
    user,
  })
}

pub fn parse_refresh(response: &HttpResponse) -> Result<RefreshResponse, CallFailure> {
  let json = ok_json(response)?;
  let custom_token = string_field(&json, "customToken").ok_or(CallFailure::Malformed)?;
  // 取り替えた token（L6）。無い・空なら旧サーバーとして今の token を使い続ける
  let refresh_token = string_field(&json, "refreshToken").map(Secret::new);
  Ok(RefreshResponse {
    custom_token: Secret::new(custom_token),
    refresh_token,
  })
}

pub fn parse_sign_in(response: &HttpResponse) -> Result<SignInResponse, CallFailure> {
  let json = ok_json(response)?;
  let id_token = string_field(&json, "idToken").ok_or(CallFailure::Malformed)?;
  let expires_in = json
    .get("expiresIn")
    .and_then(|value| {
      value
        .as_str()
        .and_then(|s| s.parse::<u64>().ok())
        .or_else(|| value.as_u64())
    })
    .unwrap_or(3600);
  Ok(SignInResponse {
    id_token: Secret::new(id_token),
    expires_in: Duration::from_secs(expires_in),
  })
}

/// `/api/auth/me` → 名前・handle・顔写真の URL。
pub fn parse_me(response: &HttpResponse) -> Result<UserSummary, CallFailure> {
  let json = ok_json(response)?;
  let user = json.get("user").ok_or(CallFailure::Malformed)?;
  Ok(UserSummary {
    id: string_field(user, "id").ok_or(CallFailure::Malformed)?,
    display_name: optional_string_field(user, "displayName"),
    handle: optional_string_field(user, "handle"),
    icon_url: icon_url(json.get("userIconImage")),
  })
}

/// Identity Toolkit の 400 の `error.message`（`INVALID_CUSTOM_TOKEN` / `CREDENTIAL_MISMATCH` など。ログ用）。
pub fn identity_toolkit_reason(response: &HttpResponse) -> Option<String> {
  response
    .json()?
    .get("error")?
    .get("message")?
    .as_str()
    .map(|message| message.split(':').next().unwrap_or(message).trim().to_string())
}

/// `clientId` を文字列から（ログ・pending の照合用）。
pub fn client_from_str(value: &str) -> Option<ClientId> {
  ClientId::parse(value)
}

#[cfg(test)]
#[path = "api_tests.rs"]
mod api_tests;
