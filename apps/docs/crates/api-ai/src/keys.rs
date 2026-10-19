//! 鍵を確かめる 1 回の軽い呼び出し（モデルの一覧。料金はかからない）。Deepgram はプロジェクトの一覧。
//! 返ったモデルの ID は、工程に使える種類（文章の生成）だけに絞って返す（設定のモデルの選択肢）。

use crate::http::{self, classify_status, error_summary, transport_reason};
use crate::providers::ANTHROPIC_VERSION;
use crate::turn::{api_error, read_limited, runtime};
use crate::types::{Account, ApiError, Config, KeyCheck, Reason, Secret};
use serde_json::{json, Value};
use std::time::Duration;

const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// 工程に使わないモデル（音声・画像・埋め込みなど）。
fn text_model(account: Account, id: &str) -> bool {
  let lower = id.to_ascii_lowercase();
  let excluded = [
    "embedding",
    "tts",
    "audio",
    "realtime",
    "transcribe",
    "image",
    "search",
    "moderation",
    "instruct",
    "live",
    "veo",
    "imagen",
    "aqa",
    "robotics",
    "computer-use",
    "native",
    "dall-e",
    "whisper",
    "codex",
  ]
  .iter()
  .any(|word| lower.contains(word));
  let family = match account {
    Account::Anthropic => lower.starts_with("claude-"),
    Account::OpenAi => lower.starts_with("gpt-"),
    Account::Gemini => lower.starts_with("gemini-"),
    Account::Deepgram => false,
  };
  family && !excluded
}

fn models_from(account: Account, body: &Value) -> Vec<String> {
  let mut models: Vec<String> = match account {
    Account::Anthropic | Account::OpenAi => body["data"]
      .as_array()
      .map(|items| {
        items
          .iter()
          .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_string))
          .collect()
      })
      .unwrap_or_default(),
    Account::Gemini => body["models"]
      .as_array()
      .map(|items| {
        items
          .iter()
          .filter(|item| {
            item["supportedGenerationMethods"]
              .as_array()
              .is_none_or(|methods| methods.iter().any(|method| method.as_str() == Some("generateContent")))
          })
          .filter_map(|item| item.get("name").and_then(Value::as_str))
          .map(|name| name.trim_start_matches("models/").to_string())
          .collect()
      })
      .unwrap_or_default(),
    Account::Deepgram => Vec::new(),
  };
  models.retain(|id| text_model(account, id));
  models.dedup();
  models
}

/// 鍵で 1 回だけ軽く呼ぶ（終わるまで戻らない）。鍵が無効なら `Reason::KeyInvalid`。
pub fn check_key(config: &Config, account: Account, key: &Secret) -> Result<KeyCheck, ApiError> {
  if key.expose().trim().is_empty() {
    return Err(api_error(Reason::NotConfigured, account));
  }
  let runtime = runtime()?;
  runtime.block_on(async {
    let client = http::client()?;
    let endpoints = &config.endpoints;
    let request = match account {
      Account::Anthropic => client
        .get(format!("{}/v1/models?limit=1000", endpoints.anthropic))
        .header("x-api-key", key.expose())
        .header("anthropic-version", ANTHROPIC_VERSION),
      Account::OpenAi => client
        .get(format!("{}/v1/models", endpoints.openai))
        .bearer_auth(key.expose()),
      Account::Gemini => client
        .get(format!("{}/v1beta/models?pageSize=1000", endpoints.gemini))
        .header("x-goog-api-key", key.expose()),
      Account::Deepgram => client
        .get(format!("{}/v1/projects", endpoints.deepgram))
        .header("Authorization", format!("Token {}", key.expose())),
    };
    let response = match tokio::time::timeout(CHECK_TIMEOUT, request.send()).await {
      Err(_) => return Err(api_error(Reason::Timeout, account)),
      Ok(Err(error)) => return Err(api_error(transport_reason(&error), account)),
      Ok(Ok(response)) => response,
    };
    let status = response.status().as_u16();
    let body = read_limited(response, 4 * 1024 * 1024).await;
    if !(200..300).contains(&status) {
      let reason = classify_status(status, &body);
      // 一覧の呼び出しに 404 は無いので、鍵か場所の誤り
      let reason = if reason == Reason::ModelNotFound { Reason::KeyInvalid } else { reason };
      config.log(
        "api_key_check_failed",
        json!({ "account": account.as_str(), "status": status, "reason": reason.as_str(), "error": error_summary(&body, &[key.expose()]) }),
      );
      return Err(api_error(reason, account));
    }
    let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let models = models_from(account, &value);
    config.log(
      "api_key_checked",
      json!({ "account": account.as_str(), "models": models.len() }),
    );
    Ok(KeyCheck { models })
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn only_text_generation_models_are_listed() {
    let openai = json!({ "data": [{ "id": "gpt-5.6-terra" }, { "id": "gpt-4o-mini-tts" }, { "id": "text-embedding-3-small" }, { "id": "gpt-5.6-luna" }, { "id": "dall-e-3" }] });
    assert_eq!(
      models_from(Account::OpenAi, &openai),
      vec!["gpt-5.6-terra", "gpt-5.6-luna"]
    );
    let gemini = json!({ "models": [
      { "name": "models/gemini-3.8-flash", "supportedGenerationMethods": ["generateContent", "countTokens"] },
      { "name": "models/gemini-embedding-001", "supportedGenerationMethods": ["embedContent"] },
      { "name": "models/gemini-3.1-pro-preview", "supportedGenerationMethods": ["generateContent"] },
      { "name": "models/gemini-2.5-flash-preview-tts", "supportedGenerationMethods": ["generateContent"] }
    ] });
    assert_eq!(
      models_from(Account::Gemini, &gemini),
      vec!["gemini-3.8-flash", "gemini-3.1-pro-preview"]
    );
    let anthropic = json!({ "data": [{ "id": "claude-opus-4-8", "type": "model" }, { "id": "claude-sonnet-4-6" }] });
    assert_eq!(
      models_from(Account::Anthropic, &anthropic),
      vec!["claude-opus-4-8", "claude-sonnet-4-6"]
    );
  }
}
