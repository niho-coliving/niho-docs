//! PKCE（RFC 7636・S256）の verifier / challenge と `state` の生成、接続 URL の組み立て、戻りの deep link の解釈。
//! 文字種と長さの規則は contracts（`APP_CONNECT_*_RE`）と同じ。

use crate::client::{ClientId, Environment, CALLBACK_PATH, PROTOCOL_VERSION};
use crate::error::AccountError;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use url::Url;

/// 32 byte の乱数の base64url（43 文字）。verifier・state の基本形。
pub fn random_base64url_32() -> Result<String, AccountError> {
  let mut bytes = [0u8; 32];
  getrandom::fill(&mut bytes).map_err(|_| AccountError::service_unavailable())?;
  Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// `code_challenge = base64url(SHA-256(verifier))`（RFC 7636 §4.2）。
pub fn code_challenge(verifier: &str) -> String {
  URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn is_base64url_char(byte: u8) -> bool {
  byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'
}

fn is_unreserved_char(byte: u8) -> bool {
  byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}

/// コード・接続 refresh token・challenge の形（`^[A-Za-z0-9_-]{43}$`）。
pub fn is_secret_43(value: &str) -> bool {
  value.len() == 43 && value.bytes().all(is_base64url_char)
}

/// RFC 7636 §4.1 の verifier（`^[A-Za-z0-9._~-]{43,128}$`）。
pub fn is_valid_verifier(value: &str) -> bool {
  (43..=128).contains(&value.len()) && value.bytes().all(is_unreserved_char)
}

/// アプリが作る `state`（`^[A-Za-z0-9._~-]{22,128}$`）。
pub fn is_valid_state(value: &str) -> bool {
  (22..=128).contains(&value.len()) && value.bytes().all(is_unreserved_char)
}

/// 接続 URL: `https://<connect_base>/connect/<clientId>?v=1&challenge=<challenge>&state=<state>`。
pub fn connect_url(env: &Environment, challenge: &str, state: &str) -> Url {
  let mut url = env.connect_base.clone();
  {
    let mut segments = url.path_segments_mut().expect("connect base is not cannot-be-a-base");
    segments.pop_if_empty();
    segments.push("connect");
    segments.push(env.client.as_str());
  }
  url
    .query_pairs_mut()
    .append_pair("v", &PROTOCOL_VERSION.to_string())
    .append_pair("challenge", challenge)
    .append_pair("state", state);
  url
}

/// 戻りの deep link の中身。
#[derive(Clone, PartialEq, Eq)]
pub struct Callback {
  pub code: String,
  pub state: String,
}

/// code は出さない。
impl std::fmt::Debug for Callback {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("Callback")
      .field("code", &"[REDACTED]")
      .field("state", &self.state)
      .finish()
  }
}

/// `niho-<app>://auth?code=…&state=…` を読む。スキーム・path・文字種が合わなければ `callback_invalid`。
pub fn parse_callback(client: ClientId, raw: &str) -> Result<Callback, AccountError> {
  let url = Url::parse(raw).map_err(|_| AccountError::callback_invalid())?;
  if url.scheme() != client.scheme() {
    return Err(AccountError::callback_invalid());
  }
  // `scheme://auth?…` は url crate では host が `auth`。`scheme:auth?…`・`scheme:///auth` の書き方も受ける。
  let host_is_auth = url.host_str() == Some(CALLBACK_PATH) && matches!(url.path(), "" | "/");
  let path_is_auth = url.host_str().is_none_or(str::is_empty) && url.path().trim_matches('/') == CALLBACK_PATH;
  if !(host_is_auth || path_is_auth) {
    return Err(AccountError::callback_invalid());
  }
  let mut code = None;
  let mut state = None;
  for (key, value) in url.query_pairs() {
    match key.as_ref() {
      "code" if code.is_none() => code = Some(value.into_owned()),
      "state" if state.is_none() => state = Some(value.into_owned()),
      _ => {}
    }
  }
  let (Some(code), Some(state)) = (code, state) else {
    return Err(AccountError::callback_invalid());
  };
  if !is_secret_43(&code) || !is_valid_state(&state) {
    return Err(AccountError::callback_invalid());
  }
  Ok(Callback { code, state })
}

#[cfg(test)]
#[path = "pkce_tests.rs"]
mod pkce_tests;
