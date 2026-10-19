//! HTTP の共通部分: client（rustls・暗号は ring）・失敗の分類・画面の文・鍵らしい文字列を伏せる。

use crate::types::{Account, ApiError, Reason};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// ログに残す提供元のエラーの本文の長さ。
const LOG_BODY_CHARS: usize = 300;

pub(crate) fn client() -> Result<reqwest::Client, ApiError> {
  // reqwest は rustls-no-provider（tauri-plugin-updater と同じ）。暗号の実装を 1 度だけ入れる
  if rustls::crypto::CryptoProvider::get_default().is_none() {
    let _ = rustls::crypto::ring::default_provider().install_default();
  }
  reqwest::Client::builder()
    .connect_timeout(CONNECT_TIMEOUT)
    .user_agent(concat!("niho-docs-api-ai/", env!("CARGO_PKG_VERSION")))
    .build()
    .map_err(|_| ApiError {
      reason: Reason::TransientFailure,
      message: "通信の準備ができませんでした。NIHO docs を開き直してから、もう一度お試しください。".into(),
    })
}

/// 画面の文（日本語。提供元の英語の文・鍵は入れない）。`ai` は AI の名前（Claude・GPT・Gemini。Deepgram は「Deepgram」）。
pub fn reason_message(reason: Reason, account: Account) -> String {
  let service = account.label();
  let ai = match account {
    Account::Anthropic => "Claude",
    Account::OpenAi => "GPT",
    Account::Gemini => "Gemini",
    Account::Deepgram => "Deepgram",
  };
  match reason {
    Reason::NotConfigured => {
      format!("{service} の API キーが保存されていません。設定 › 接続設定で API キーを保存してください。")
    }
    Reason::KeyInvalid => "API キーが無効です。設定 › 接続設定で確かめてください。".into(),
    Reason::UsageLimitReached => format!(
      "{service} の API の利用上限か残高に達しました。{service} の管理画面で上限と残高を確かめてから、もう一度実行してください。"
    ),
    Reason::ModelNotFound => "設定のモデルが使えません。設定でモデルを確かめてから、もう一度実行してください。".into(),
    Reason::BadRequest => format!(
      "{service} の API が依頼を受け付けませんでした。送る量が多すぎるか、設定のモデルと思考量の組み合わせが使えない可能性があります。設定を確かめてから、もう一度実行してください。"
    ),
    Reason::Refused => format!(
      "{ai} が安全上の理由で、この依頼への返答を止めました。資料か指示文を見直してから、もう一度実行してください。"
    ),
    Reason::SessionNotFound => "前の会話の記録が見つかりませんでした。もう一度実行してください。".into(),
    Reason::Unreachable => {
      format!("{service} の API に接続できませんでした。ネットワークを確かめてから、もう一度実行してください。")
    }
    Reason::Timeout => "時間の上限に達したため、途中で止めました。もう一度実行してください。".into(),
    Reason::TransientFailure => {
      format!("{service} の API が一時的に使えませんでした。しばらく待ってから、もう一度実行してください。")
    }
  }
}

pub(crate) fn error(reason: Reason, account: Account) -> ApiError {
  ApiError {
    reason,
    message: reason_message(reason, account),
  }
}

/// HTTP の状態と本文から理由を決める（3 社と Deepgram で共通）。
pub fn classify_status(status: u16, body: &str) -> Reason {
  let lower = body.to_ascii_lowercase();
  let key_invalid = [
    "api_key_invalid",
    "api key not valid",
    "invalid api key",
    "invalid x-api-key",
    "incorrect api key",
  ]
  .iter()
  .any(|needle| lower.contains(needle));
  let no_credit = [
    "credit balance",
    "insufficient_quota",
    "billing",
    "quota exceeded",
    "exceeded your current quota",
  ]
  .iter()
  .any(|needle| lower.contains(needle));
  let model_missing = lower.contains("model")
    && [
      "not found",
      "does not exist",
      "not supported",
      "unsupported",
      "invalid model",
      "not available",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
  match status {
    401 | 403 => Reason::KeyInvalid,
    402 => Reason::UsageLimitReached,
    404 => Reason::ModelNotFound,
    413 => Reason::BadRequest,
    429 => Reason::UsageLimitReached,
    400 | 422 if key_invalid => Reason::KeyInvalid,
    400 | 422 if no_credit => Reason::UsageLimitReached,
    400 | 422 if model_missing => Reason::ModelNotFound,
    400 | 422 => Reason::BadRequest,
    _ => Reason::TransientFailure,
  }
}

/// 通信の失敗（接続できない・時間切れ・途中で切れた）。
pub(crate) fn transport_reason(error: &reqwest::Error) -> Reason {
  if error.is_timeout() {
    Reason::Timeout
  } else if error.is_connect() {
    Reason::Unreachable
  } else {
    Reason::TransientFailure
  }
}

fn is_key_like(token: &str) -> bool {
  let prefixed = ["sk-", "sk_", "AIza", "Token", "Bearer"]
    .iter()
    .any(|prefix| token.starts_with(prefix) && token.len() > prefix.len() + 8);
  let long = token.chars().count() >= 24
    && token.chars().any(|ch| ch.is_ascii_digit())
    && token.chars().any(|ch| ch.is_ascii_alphabetic());
  prefixed || long
}

/// 渡した鍵だけを伏せる（道具の結果に使う。文書の中の ID・URL などの長い英数字は変えない）。
pub(crate) fn hide_secrets(text: &str, secrets: &[&str]) -> String {
  let mut out = text.to_string();
  for secret in secrets.iter().filter(|secret| secret.len() >= 4) {
    if out.contains(*secret) {
      out = out.replace(secret, "••••");
    }
  }
  out
}

/// 鍵（渡したもの）と、鍵らしい長い英数字の並びを伏せる。ログ・エラーの本文に使う。
pub fn redact(text: &str, secrets: &[&str]) -> String {
  let out = hide_secrets(text, secrets);
  let mut result = String::with_capacity(out.len());
  let mut token = String::new();
  let flush = |token: &mut String, result: &mut String| {
    if is_key_like(token) {
      result.push_str("••••");
    } else {
      result.push_str(token);
    }
    token.clear();
  };
  for ch in out.chars() {
    if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
      token.push(ch);
    } else {
      flush(&mut token, &mut result);
      result.push(ch);
    }
  }
  flush(&mut token, &mut result);
  result
}

/// ログに残す、提供元のエラーの要旨（JSON の message・type・code・status。鍵らしい文字列は伏せて 300 字まで）。
pub(crate) fn error_summary(body: &str, secrets: &[&str]) -> String {
  let value: Option<serde_json::Value> = serde_json::from_str(body).ok();
  let pick = |value: &serde_json::Value| -> Vec<String> {
    let error = value.get("error").unwrap_or(value);
    ["type", "code", "status", "message", "err_msg", "err_code"]
      .iter()
      .filter_map(|key| error.get(*key).and_then(|v| v.as_str().map(str::to_string)))
      .collect()
  };
  let summary = match value {
    Some(value) => pick(&value).join(" · "),
    None => body.to_string(),
  };
  redact(&summary, secrets).chars().take(LOG_BODY_CHARS).collect()
}

/// モデルの名前を URL の道に入れてよいか（Gemini の `models/{model}`。英数字と `.`・`-`・`_` だけ）。
pub(crate) fn safe_model(model: &str) -> bool {
  !model.is_empty()
    && model.len() <= 128
    && model
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_')
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn statuses_map_to_reasons() {
    assert_eq!(classify_status(401, ""), Reason::KeyInvalid);
    assert_eq!(classify_status(403, "{}"), Reason::KeyInvalid);
    assert_eq!(classify_status(429, ""), Reason::UsageLimitReached);
    assert_eq!(classify_status(402, ""), Reason::UsageLimitReached);
    assert_eq!(classify_status(404, ""), Reason::ModelNotFound);
    assert_eq!(classify_status(500, ""), Reason::TransientFailure);
    assert_eq!(classify_status(529, ""), Reason::TransientFailure);
    assert_eq!(
      classify_status(
        400,
        r#"{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}"#
      ),
      Reason::KeyInvalid
    );
    assert_eq!(
      classify_status(
        400,
        r#"{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}"#
      ),
      Reason::UsageLimitReached
    );
    assert_eq!(
      classify_status(400, r#"{"error":{"message":"The model `gpt-x` does not exist"}}"#),
      Reason::ModelNotFound
    );
    assert_eq!(
      classify_status(400, r#"{"error":{"message":"prompt is too long"}}"#),
      Reason::BadRequest
    );
  }

  #[test]
  fn keys_and_key_like_strings_are_hidden() {
    let key = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let text = format!("Invalid key {key} (x-api-key) AIzaSyA1234567890abcdefghijklmnop and short id req_1");
    let redacted = redact(&text, &[key]);
    assert!(!redacted.contains(key));
    assert!(!redacted.contains("AIzaSyA1234567890abcdefghijklmnop"));
    assert!(redacted.contains("x-api-key"));
    assert!(redacted.contains("req_1"));
    // 一部だけ伏せても残らない（鍵の後ろ半分だけが本文に出たとき）
    let tail = &key[20..];
    assert!(!redact(&format!("echo {tail}"), &[key]).contains(tail));
    let summary = error_summary(
      &format!(r#"{{"error":{{"type":"authentication_error","message":"invalid x-api-key {key}"}}}}"#),
      &[key],
    );
    assert!(summary.starts_with("authentication_error · invalid x-api-key"));
    assert!(!summary.contains("ABCDEFGHIJ"));
  }

  #[test]
  fn model_names_for_paths_are_limited() {
    assert!(safe_model("gemini-3.8-flash"));
    assert!(!safe_model("../files"));
    assert!(!safe_model("gemini?key=x"));
    assert!(!safe_model(""));
  }
}
