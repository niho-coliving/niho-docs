//! 3 社の依頼の組み立てと、流れてくるイベントの読み取り。工程の実行・文字起こしは道具を渡さない（文を書くだけ）。修正の会話
//! （`TurnRequest.tools`）だけ、tools.rs の 4 つの道具を各社の形で渡し、応答の道具の呼び出しを [`ToolCall`] にそろえる。
//!
//! - Anthropic Messages API: `POST /v1/messages`（`x-api-key`・`anthropic-version: 2023-06-01`）。`stream: true`・`max_tokens`・
//!   `system`・`thinking: {type: "adaptive", display: "summarized"}`（4.6 以降。思考の要約を ThinkingDelta に流す）・
//!   `output_config: {effort}`。`stop_reason`: `max_tokens` → MaxTokens、`refusal` → 断られた。
//! - OpenAI Responses API: `POST /v1/responses`（`Authorization: Bearer`）。`instructions`・`input`（会話の履歴）・`stream: true`・
//!   `store: false`（OpenAI 側に会話を残さず、履歴はこちらが持って毎回送る）・`max_output_tokens`・`reasoning: {effort}`（最大は
//!   `xhigh`）。`response.incomplete` の `incomplete_details.reason == "max_output_tokens"` → MaxTokens。思考の要約は組織の確認が
//!   要るので頼まない（ThinkingDelta は流れない）。
//! - Gemini API: `POST /v1beta/models/{model}:streamGenerateContent?alt=sse`（`x-goog-api-key`。鍵を URL に入れない）。
//!   `systemInstruction`・`contents`・`generationConfig: {maxOutputTokens, thinkingConfig: {thinkingLevel, includeThoughts}}`
//!   （Gemini 3 系の規約: 思考量は thinkingLevel で、temperature などは付けない。NIHO の Gemini の文字起こしと同じ）。
//!   `finishReason == "MAX_TOKENS"` → MaxTokens。`thought: true` の部分は思考。
//!
//! 道具の往復（応答の発言は各社のそのままの形で履歴に足し、次の依頼で返す）:
//! - Anthropic: `tools: [{name, description, input_schema}]`。`content_block_start`（tool_use の id・name）と
//!   `input_json_delta` の partial_json から入力を組み立てる（`stop_reason: tool_use`）。思考の block（`signature_delta` の
//!   signature を含む。redacted_thinking も）は tool_use と一緒に assistant の content として変えずに返す（返さないと 400）。
//!   結果は user の content に `{type: "tool_result", tool_use_id, content, is_error}`。
//! - OpenAI: `tools: [{type: "function", name, description, parameters, strict}]`。`store: false` なので
//!   `include: ["reasoning.encrypted_content"]` を付け、`response.output_item.done` の item（reasoning〔encrypted_content〕・
//!   function_call・message）を出た順にそのまま次の `input` に入れ、続けて `{type: "function_call_output", call_id, output}`。
//! - Gemini: `tools: [{functionDeclarations}]`。モデルの parts（`functionCall`・`thoughtSignature` を含む）をそのまま
//!   履歴に残し、`{role: "user", parts: [{functionResponse: {name, id?, response}}]}` を返す。

use crate::http::safe_model;
use crate::sse::SseEvent;
use crate::tools::{self, Outcome, ToolCall};
use crate::types::{ApiProvider, Effort, Endpoints, FolderTools, Reason, Secret, StopReason, TurnEvent, Usage};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub(crate) const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Role {
  User,
  Assistant,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Message {
  pub role: Role,
  pub text: String,
  /// 道具の往復の発言（各社のそのままの形: Anthropic は content の block、OpenAI は input の item、Gemini は parts）。
  /// あれば `text` の代わりにこちらを送る（文字だけの古い履歴には無い）。
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub raw: Option<Vec<Value>>,
}

impl Message {
  pub fn text(role: Role, text: impl Into<String>) -> Self {
    Self {
      role,
      text: text.into(),
      raw: None,
    }
  }
}

/// 添える音声（Gemini の Files API に上げたもの）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FileRef {
  pub uri: String,
  pub mime_type: String,
}

/// 届いたイベントを足していったもの。
#[derive(Default, Debug)]
pub(crate) struct Collected {
  pub text: String,
  pub input_tokens: u64,
  pub output_tokens: u64,
  pub usage_seen: bool,
  pub model: Option<String>,
  pub stop: Option<StopReason>,
  pub error: Option<(Reason, String)>,
  /// 終わりの合図（Anthropic の message_stop・OpenAI の response.completed など）が届いた。
  pub finished: bool,
  /// この往復の応答（各社のそのままの形。道具の往復で履歴に足す）と、道具の呼び出し。[`finish_round`] がそろえる
  /// （Gemini の parts は届いた順に足していく）。
  pub output: Vec<Value>,
  pub calls: Vec<ToolCall>,
  /// Anthropic の流れている途中の block（添字ごと）と、tool_use の partial_json。
  blocks: BTreeMap<u64, (Value, String)>,
  /// OpenAI の終わった item（output_index ごと）。
  items: BTreeMap<u64, Value>,
}

impl Collected {
  pub fn usage(&self, requested_model: &str) -> Usage {
    Usage {
      input_tokens: self.input_tokens,
      output_tokens: self.output_tokens,
      model_used: Some(self.model.clone().unwrap_or_else(|| requested_model.to_string())),
      known: self.usage_seen,
    }
  }

  fn fail(&mut self, reason: Reason, detail: impl Into<String>) {
    if self.error.is_none() {
      self.error = Some((reason, detail.into()));
    }
    self.finished = true;
  }
}

fn u64_at(value: &Value, key: &str) -> Option<u64> {
  value.get(key).and_then(Value::as_u64)
}

// ---------------------------------------------------------------------------
// 依頼の組み立て

/// Claude の版が 4.6 以降か（adaptive の思考と effort を付けてよいか）。形の分からない ID は付ける（新しいモデル）。
fn claude_supports_adaptive(model: &str) -> bool {
  let rest = match model.strip_prefix("claude-") {
    Some(rest) => rest,
    None => return true,
  };
  let mut parts = rest.split('-');
  let family = parts.next().unwrap_or("");
  if family.chars().all(|ch| ch.is_ascii_digit()) {
    // claude-3-5-sonnet のような古い形
    return false;
  }
  let major: u32 = match parts.next().and_then(|value| value.parse().ok()) {
    Some(major) => major,
    None => return true,
  };
  let minor: u32 = parts
    .next()
    .filter(|value| value.len() <= 2)
    .and_then(|value| value.parse().ok())
    .unwrap_or(0);
  major > 4 || (major == 4 && minor >= 6)
}

fn anthropic_effort(effort: Effort) -> &'static str {
  match effort {
    Effort::Low => "low",
    Effort::Medium => "medium",
    Effort::High => "high",
    Effort::Max => "max",
  }
}

fn openai_effort(effort: Effort) -> &'static str {
  match effort {
    Effort::Low => "low",
    Effort::Medium => "medium",
    Effort::High => "high",
    Effort::Max => "xhigh",
  }
}

fn gemini_level(effort: Effort) -> &'static str {
  match effort {
    Effort::Low => "LOW",
    Effort::Medium => "MEDIUM",
    // Gemini に「最大」は無い（設定でも選べない）
    Effort::High | Effort::Max => "HIGH",
  }
}

pub(crate) struct Built {
  pub url: String,
  pub body: Value,
}

pub(crate) struct BuildInput<'a> {
  pub model: &'a str,
  pub effort: Option<Effort>,
  pub system_prompt: &'a str,
  pub messages: &'a [Message],
  pub max_output_tokens: u32,
  pub file: Option<&'a FileRef>,
  /// 修正の会話の道具（None なら道具を渡さない）。
  pub tools: Option<&'a FolderTools>,
}

pub(crate) fn build(provider: ApiProvider, endpoints: &Endpoints, input: &BuildInput<'_>) -> Result<Built, Reason> {
  match provider {
    ApiProvider::Anthropic => {
      let messages: Vec<Value> = input
        .messages
        .iter()
        .map(|message| match &message.raw {
          Some(raw) => json!({ "role": message.role, "content": raw }),
          None => json!({ "role": message.role, "content": message.text }),
        })
        .collect();
      let mut body = json!({
        "model": input.model,
        "max_tokens": input.max_output_tokens,
        "stream": true,
        "messages": messages,
      });
      if let Some(folder) = input.tools {
        let specs: Vec<Value> = tools::specs(&folder.writable)
          .iter()
          .map(|spec| json!({ "name": spec.name, "description": spec.description, "input_schema": spec.schema(true) }))
          .collect();
        body["tools"] = Value::Array(specs);
      }
      if !input.system_prompt.is_empty() {
        body["system"] = json!(input.system_prompt);
      }
      if claude_supports_adaptive(input.model) {
        body["thinking"] = json!({ "type": "adaptive", "display": "summarized" });
        if let Some(effort) = input.effort {
          body["output_config"] = json!({ "effort": anthropic_effort(effort) });
        }
      }
      Ok(Built {
        url: format!("{}/v1/messages", endpoints.anthropic),
        body,
      })
    }
    ApiProvider::OpenAi => {
      let mut items: Vec<Value> = Vec::new();
      for message in input.messages {
        match &message.raw {
          Some(raw) => items.extend(raw.iter().cloned()),
          None => items.push(json!({ "role": message.role, "content": message.text })),
        }
      }
      let mut body = json!({
        "model": input.model,
        "input": items,
        "stream": true,
        "store": false,
        "max_output_tokens": input.max_output_tokens,
      });
      if let Some(folder) = input.tools {
        let specs: Vec<Value> = tools::specs(&folder.writable)
          .iter()
          .map(|spec| {
            json!({ "type": "function", "name": spec.name, "description": spec.description, "parameters": spec.schema(true), "strict": true })
          })
          .collect();
        body["tools"] = Value::Array(specs);
        // store: false でも前の往復の思考を続けて使えるよう、暗号化した思考を返してもらい次の input に入れる
        body["include"] = json!(["reasoning.encrypted_content"]);
      }
      if !input.system_prompt.is_empty() {
        body["instructions"] = json!(input.system_prompt);
      }
      if let Some(effort) = input.effort {
        body["reasoning"] = json!({ "effort": openai_effort(effort) });
      }
      Ok(Built {
        url: format!("{}/v1/responses", endpoints.openai),
        body,
      })
    }
    ApiProvider::Gemini => {
      if !safe_model(input.model) {
        return Err(Reason::ModelNotFound);
      }
      let last_user = input.messages.iter().rposition(|message| message.role == Role::User);
      let contents: Vec<Value> = input
        .messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
          let role = match message.role {
            Role::User => "user",
            Role::Assistant => "model",
          };
          if let Some(raw) = &message.raw {
            return json!({ "role": role, "parts": raw });
          }
          let mut parts = Vec::new();
          if let (Some(file), true) = (input.file, Some(index) == last_user) {
            parts.push(json!({ "fileData": { "mimeType": file.mime_type, "fileUri": file.uri } }));
          }
          parts.push(json!({ "text": message.text }));
          json!({ "role": role, "parts": parts })
        })
        .collect();
      let mut thinking = json!({ "includeThoughts": true });
      if let Some(effort) = input.effort {
        thinking["thinkingLevel"] = json!(gemini_level(effort));
      }
      let mut body = json!({
        "contents": contents,
        "generationConfig": { "maxOutputTokens": input.max_output_tokens, "thinkingConfig": thinking },
      });
      if !input.system_prompt.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": input.system_prompt }] });
      }
      if let Some(folder) = input.tools {
        let declarations: Vec<Value> = tools::specs(&folder.writable)
          .iter()
          .map(|spec| {
            let mut declaration = json!({ "name": spec.name, "description": spec.description });
            // 引数の無い道具は parameters を付けない（空の properties の OBJECT は受け付けない）
            if !spec.params.is_empty() {
              declaration["parameters"] = spec.schema(false);
            }
            declaration
          })
          .collect();
        body["tools"] = json!([{ "functionDeclarations": declarations }]);
      }
      Ok(Built {
        url: format!(
          "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
          endpoints.gemini, input.model
        ),
        body,
      })
    }
  }
}

/// 鍵の付け方（ヘッダーだけ。URL には入れない）。
pub(crate) fn authorize(
  provider: ApiProvider,
  request: reqwest::RequestBuilder,
  key: &Secret,
) -> reqwest::RequestBuilder {
  match provider {
    ApiProvider::Anthropic => request
      .header("x-api-key", key.expose())
      .header("anthropic-version", ANTHROPIC_VERSION),
    ApiProvider::OpenAi => request.bearer_auth(key.expose()),
    ApiProvider::Gemini => request.header("x-goog-api-key", key.expose()),
  }
}

// ---------------------------------------------------------------------------
// イベントの読み取り

fn anthropic_error_reason(kind: &str) -> Reason {
  match kind {
    "authentication_error" | "permission_error" => Reason::KeyInvalid,
    "rate_limit_error" | "billing_error" => Reason::UsageLimitReached,
    "not_found_error" => Reason::ModelNotFound,
    "invalid_request_error" | "request_too_large" => Reason::BadRequest,
    _ => Reason::TransientFailure,
  }
}

fn openai_error_reason(code: &str) -> Reason {
  match code {
    "rate_limit_exceeded" | "insufficient_quota" => Reason::UsageLimitReached,
    "invalid_api_key" => Reason::KeyInvalid,
    "model_not_found" => Reason::ModelNotFound,
    "invalid_prompt" | "context_length_exceeded" | "invalid_request_error" => Reason::BadRequest,
    _ => Reason::TransientFailure,
  }
}

/// 1 つのイベントを足す。思考・本文の差分は `emit` へ。
pub(crate) fn apply(
  provider: ApiProvider,
  event: &SseEvent,
  collected: &mut Collected,
  emit: &mut dyn FnMut(TurnEvent),
) {
  let data = event.data.trim();
  if data.is_empty() || data == "[DONE]" {
    return;
  }
  let Ok(value) = serde_json::from_str::<Value>(data) else {
    collected.fail(Reason::TransientFailure, "invalid_json");
    return;
  };
  match provider {
    ApiProvider::Anthropic => apply_anthropic(&value, collected, emit),
    ApiProvider::OpenAi => apply_openai(&value, collected, emit),
    ApiProvider::Gemini => apply_gemini(&value, collected, emit),
  }
}

/// 添字の block（content_block_start が無ければ、差分の種類から作る）。
fn anthropic_block<'a>(collected: &'a mut Collected, index: u64, kind: &str) -> &'a mut (Value, String) {
  collected.blocks.entry(index).or_insert_with(|| {
    let block = match kind {
      "thinking" => json!({ "type": "thinking", "thinking": "" }),
      "tool_use" => json!({ "type": "tool_use", "id": "", "name": "", "input": {} }),
      _ => json!({ "type": "text", "text": "" }),
    };
    (block, String::new())
  })
}

/// 文字列の欄に足す（無ければ作る）。
fn push_field(block: &mut Value, key: &str, text: &str) {
  let Some(map) = block.as_object_mut() else {
    return;
  };
  match map.get_mut(key) {
    Some(Value::String(current)) => current.push_str(text),
    _ => {
      map.insert(key.to_string(), json!(text));
    }
  }
}

fn apply_anthropic(value: &Value, collected: &mut Collected, emit: &mut dyn FnMut(TurnEvent)) {
  let index = u64_at(value, "index").unwrap_or(0);
  match value.get("type").and_then(Value::as_str).unwrap_or("") {
    "message_start" => {
      let message = &value["message"];
      if let Some(model) = message.get("model").and_then(Value::as_str) {
        collected.model = Some(model.to_string());
      }
      let usage = &message["usage"];
      if let Some(input) = u64_at(usage, "input_tokens") {
        collected.input_tokens = input
          + u64_at(usage, "cache_creation_input_tokens").unwrap_or(0)
          + u64_at(usage, "cache_read_input_tokens").unwrap_or(0);
        collected.usage_seen = true;
      }
      if let Some(output) = u64_at(usage, "output_tokens") {
        collected.output_tokens = output;
      }
    }
    "content_block_start" => {
      if let Some(block) = value.get("content_block").filter(|block| block.is_object()) {
        collected.blocks.insert(index, (block.clone(), String::new()));
      }
    }
    "content_block_delta" => {
      let delta = &value["delta"];
      match delta.get("type").and_then(Value::as_str).unwrap_or("") {
        "text_delta" => {
          if let Some(text) = delta.get("text").and_then(Value::as_str) {
            collected.text.push_str(text);
            push_field(&mut anthropic_block(collected, index, "text").0, "text", text);
            emit(TurnEvent::TextDelta(text.to_string()));
          }
        }
        "thinking_delta" => {
          if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
            push_field(&mut anthropic_block(collected, index, "thinking").0, "thinking", text);
            if !text.is_empty() {
              emit(TurnEvent::ThinkingDelta(text.to_string()));
            }
          }
        }
        // 思考の block の署名（道具の往復で、思考の block を変えずに返すのに要る）
        "signature_delta" => {
          if let Some(signature) = delta.get("signature").and_then(Value::as_str) {
            push_field(
              &mut anthropic_block(collected, index, "thinking").0,
              "signature",
              signature,
            );
          }
        }
        "input_json_delta" => {
          if let Some(json) = delta.get("partial_json").and_then(Value::as_str) {
            anthropic_block(collected, index, "tool_use").1.push_str(json);
          }
        }
        _ => {}
      }
    }
    "message_delta" => {
      let usage = &value["usage"];
      if let Some(output) = u64_at(usage, "output_tokens") {
        collected.output_tokens = output;
        collected.usage_seen = true;
      }
      if let Some(input) = u64_at(usage, "input_tokens") {
        let total = input
          + u64_at(usage, "cache_creation_input_tokens").unwrap_or(0)
          + u64_at(usage, "cache_read_input_tokens").unwrap_or(0);
        collected.input_tokens = collected.input_tokens.max(total);
      }
      match value["delta"].get("stop_reason").and_then(Value::as_str) {
        Some("max_tokens") => collected.stop = Some(StopReason::MaxTokens),
        Some("refusal") => collected.fail(Reason::Refused, "refusal"),
        Some("model_context_window_exceeded") => collected.fail(Reason::BadRequest, "model_context_window_exceeded"),
        Some(_) => collected.stop = Some(StopReason::EndTurn),
        None => {}
      }
    }
    "message_stop" => collected.finished = true,
    "error" => {
      let kind = value["error"].get("type").and_then(Value::as_str).unwrap_or("");
      collected.fail(anthropic_error_reason(kind), kind.to_string());
    }
    _ => {}
  }
}

/// 終わりの response の output（`response.output_item.done` が届かなかったときだけ使う）。
fn openai_output(response: &Value, collected: &mut Collected) {
  if !collected.items.is_empty() {
    return;
  }
  if let Some(output) = response.get("output").and_then(Value::as_array) {
    for (index, item) in output.iter().enumerate().filter(|(_, item)| item.is_object()) {
      collected.items.insert(index as u64, item.clone());
    }
  }
}

fn openai_usage(response: &Value, collected: &mut Collected) {
  if let Some(model) = response.get("model").and_then(Value::as_str) {
    collected.model = Some(model.to_string());
  }
  let usage = &response["usage"];
  if let (Some(input), Some(output)) = (u64_at(usage, "input_tokens"), u64_at(usage, "output_tokens")) {
    collected.input_tokens = input;
    collected.output_tokens = output;
    collected.usage_seen = true;
  }
}

fn apply_openai(value: &Value, collected: &mut Collected, emit: &mut dyn FnMut(TurnEvent)) {
  match value.get("type").and_then(Value::as_str).unwrap_or("") {
    "response.created" | "response.in_progress" => {
      if let Some(model) = value["response"].get("model").and_then(Value::as_str) {
        collected.model = Some(model.to_string());
      }
    }
    "response.output_text.delta" => {
      if let Some(text) = value.get("delta").and_then(Value::as_str) {
        collected.text.push_str(text);
        emit(TurnEvent::TextDelta(text.to_string()));
      }
    }
    // 道具の往復で次の input にそのまま入れる（reasoning・function_call・message）
    "response.output_item.done" => {
      if let Some(item) = value.get("item").filter(|item| item.is_object()) {
        let index = u64_at(value, "output_index").unwrap_or(collected.items.len() as u64);
        collected.items.insert(index, item.clone());
      }
    }
    "response.reasoning_summary_text.delta" => {
      if let Some(text) = value.get("delta").and_then(Value::as_str) {
        if !text.is_empty() {
          emit(TurnEvent::ThinkingDelta(text.to_string()));
        }
      }
    }
    "response.completed" => {
      openai_usage(&value["response"], collected);
      openai_output(&value["response"], collected);
      collected.stop = Some(StopReason::EndTurn);
      collected.finished = true;
    }
    "response.incomplete" => {
      let response = &value["response"];
      openai_usage(response, collected);
      openai_output(response, collected);
      match response["incomplete_details"].get("reason").and_then(Value::as_str) {
        Some("max_output_tokens") => {
          collected.stop = Some(StopReason::MaxTokens);
          collected.finished = true;
        }
        Some("content_filter") => collected.fail(Reason::Refused, "content_filter"),
        other => collected.fail(Reason::TransientFailure, other.unwrap_or("incomplete").to_string()),
      }
    }
    "response.failed" => {
      let response = &value["response"];
      openai_usage(response, collected);
      let code = response["error"].get("code").and_then(Value::as_str).unwrap_or("");
      collected.fail(openai_error_reason(code), code.to_string());
    }
    "error" => {
      let code = value
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| value["error"].get("code").and_then(Value::as_str))
        .unwrap_or("");
      collected.fail(openai_error_reason(code), code.to_string());
    }
    _ => {}
  }
}

fn apply_gemini(value: &Value, collected: &mut Collected, emit: &mut dyn FnMut(TurnEvent)) {
  if let Some(error) = value.get("error") {
    let status = error.get("code").and_then(Value::as_u64).unwrap_or(500) as u16;
    let reason = crate::http::classify_status(status, &error.to_string());
    collected.fail(
      reason,
      error.get("status").and_then(Value::as_str).unwrap_or("").to_string(),
    );
    return;
  }
  if let Some(model) = value.get("modelVersion").and_then(Value::as_str) {
    collected.model = Some(model.to_string());
  }
  let usage = &value["usageMetadata"];
  if let Some(input) = u64_at(usage, "promptTokenCount") {
    collected.input_tokens = input;
    collected.output_tokens =
      u64_at(usage, "candidatesTokenCount").unwrap_or(0) + u64_at(usage, "thoughtsTokenCount").unwrap_or(0);
    collected.usage_seen = true;
  }
  if let Some(reason) = value["promptFeedback"].get("blockReason").and_then(Value::as_str) {
    collected.fail(Reason::Refused, reason.to_string());
    return;
  }
  let candidate = &value["candidates"][0];
  if let Some(parts) = candidate["content"].get("parts").and_then(Value::as_array) {
    for part in parts {
      push_gemini_part(&mut collected.output, part);
      let Some(text) = part.get("text").and_then(Value::as_str) else {
        continue;
      };
      if part.get("thought").and_then(Value::as_bool) == Some(true) {
        if !text.is_empty() {
          emit(TurnEvent::ThinkingDelta(text.to_string()));
        }
      } else if !text.is_empty() {
        collected.text.push_str(text);
        emit(TurnEvent::TextDelta(text.to_string()));
      }
    }
  }
  match candidate.get("finishReason").and_then(Value::as_str) {
    None | Some("FINISH_REASON_UNSPECIFIED") => {}
    Some("STOP") => collected.stop = Some(StopReason::EndTurn),
    Some("MAX_TOKENS") => collected.stop = Some(StopReason::MaxTokens),
    Some(
      reason @ ("SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" | "IMAGE_SAFETY" | "LANGUAGE"),
    ) => collected.fail(Reason::Refused, reason.to_string()),
    Some(reason) => collected.fail(Reason::TransientFailure, reason.to_string()),
  }
}

/// Gemini の parts を足す（流れの途中で分かれた文は、印〔thoughtSignature など〕の無い文どうしだけつなぐ。印のある part は
/// 届いた形のまま残す）。
fn push_gemini_part(parts: &mut Vec<Value>, part: &Value) {
  let plain = |part: &Value| {
    part.as_object().is_some_and(|map| {
      matches!(map.get("text"), Some(Value::String(_))) && map.keys().all(|key| key == "text" || key == "thought")
    })
  };
  if plain(part) {
    if let Some(last) = parts.last_mut() {
      if plain(last) && last.get("thought") == part.get("thought") {
        if let (Some(Value::String(text)), Some(more)) =
          (last.get_mut("text"), part.get("text").and_then(Value::as_str))
        {
          text.push_str(more);
          return;
        }
      }
    }
  }
  parts.push(part.clone());
}

fn str_at(value: &Value, key: &str) -> String {
  value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

/// 往復の終わりに、応答（各社のそのままの形）と道具の呼び出しをそろえる。`round` は Gemini の呼び出しに id を振るのに使う
/// （id が返らないとき）。
pub(crate) fn finish_round(provider: ApiProvider, collected: &mut Collected, round: u32) {
  match provider {
    ApiProvider::Anthropic => {
      for (_, (mut block, json)) in std::mem::take(&mut collected.blocks) {
        match block.get("type").and_then(Value::as_str).unwrap_or("") {
          // 空の文の block は送れない
          "text" if block.get("text").and_then(Value::as_str).unwrap_or("").is_empty() => continue,
          "tool_use" => {
            let input = if json.trim().is_empty() {
              Some(block.get("input").cloned().unwrap_or_else(|| json!({})))
            } else {
              serde_json::from_str::<Value>(&json).ok()
            };
            collected.calls.push(ToolCall {
              id: str_at(&block, "id"),
              name: str_at(&block, "name"),
              input: input.clone().unwrap_or(Value::Null),
              native_id: None,
            });
            block["input"] = input.filter(Value::is_object).unwrap_or_else(|| json!({}));
          }
          _ => {}
        }
        collected.output.push(block);
      }
    }
    ApiProvider::OpenAi => {
      for (_, item) in std::mem::take(&mut collected.items) {
        if item.get("type").and_then(Value::as_str) == Some("function_call") {
          let arguments = item.get("arguments").and_then(Value::as_str).unwrap_or("");
          let input = if arguments.trim().is_empty() {
            json!({})
          } else {
            serde_json::from_str(arguments).unwrap_or(Value::Null)
          };
          collected.calls.push(ToolCall {
            id: str_at(&item, "call_id"),
            name: str_at(&item, "name"),
            input,
            native_id: None,
          });
        }
        collected.output.push(item);
      }
    }
    ApiProvider::Gemini => {
      let mut count = 0;
      for part in &collected.output {
        let Some(call) = part.get("functionCall") else {
          continue;
        };
        let native_id = call
          .get("id")
          .and_then(Value::as_str)
          .filter(|id| !id.is_empty())
          .map(str::to_string);
        collected.calls.push(ToolCall {
          id: native_id.clone().unwrap_or_else(|| format!("call_{round}_{count}")),
          name: str_at(call, "name"),
          input: call.get("args").cloned().unwrap_or_else(|| json!({})),
          native_id,
        });
        count += 1;
      }
    }
  }
}

/// 道具の呼び出しを除いた応答（出力の上限で止まった往復。結果の無い呼び出しを残すと次の依頼が通らない）。
pub(crate) fn without_calls(provider: ApiProvider, output: Vec<Value>) -> Vec<Value> {
  output
    .into_iter()
    .filter(|item| match provider {
      ApiProvider::Anthropic => item.get("type").and_then(Value::as_str) != Some("tool_use"),
      ApiProvider::OpenAi => item.get("type").and_then(Value::as_str) != Some("function_call"),
      ApiProvider::Gemini => item.get("functionCall").is_none(),
    })
    .collect()
}

/// 道具の結果をモデルへ返す発言（呼び出しと同じ順に、1 つの発言にまとめる）。
pub(crate) fn tool_results(provider: ApiProvider, results: &[(ToolCall, Outcome)]) -> Message {
  let raw = results
    .iter()
    .map(|(call, outcome)| match provider {
      ApiProvider::Anthropic => json!({
        "type": "tool_result",
        "tool_use_id": call.id,
        "content": outcome.text,
        "is_error": !outcome.ok,
      }),
      ApiProvider::OpenAi => json!({
        "type": "function_call_output",
        "call_id": call.id,
        "output": if outcome.ok { outcome.text.clone() } else { format!("エラー: {}", outcome.text) },
      }),
      ApiProvider::Gemini => {
        let response = if outcome.ok {
          json!({ "result": outcome.text })
        } else {
          json!({ "error": outcome.text })
        };
        let mut reply = json!({ "name": call.name, "response": response });
        if let Some(id) = &call.native_id {
          reply["id"] = json!(id);
        }
        json!({ "functionResponse": reply })
      }
    })
    .collect();
  Message {
    role: Role::User,
    text: String::new(),
    raw: Some(raw),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn event(data: Value) -> SseEvent {
    SseEvent {
      event: String::new(),
      data: data.to_string(),
    }
  }

  fn messages() -> Vec<Message> {
    vec![
      Message::text(Role::User, "## 文字起こし"),
      Message::text(Role::Assistant, "前半"),
      Message::text(Role::User, "続きを書いてください。"),
    ]
  }

  #[test]
  fn requests_put_the_system_prompt_in_each_apis_system_field() {
    let endpoints = Endpoints::default();
    let history = messages();
    let input = BuildInput {
      model: "claude-sonnet-4-6",
      effort: Some(Effort::Max),
      system_prompt: "決まり",
      messages: &history,
      max_output_tokens: 64_000,
      file: None,
      tools: None,
    };
    let built = build(ApiProvider::Anthropic, &endpoints, &input).unwrap();
    assert_eq!(built.url, "https://api.anthropic.com/v1/messages");
    assert_eq!(built.body["system"], json!("決まり"));
    assert_eq!(built.body["max_tokens"], json!(64_000));
    assert_eq!(built.body["stream"], json!(true));
    assert_eq!(
      built.body["thinking"],
      json!({ "type": "adaptive", "display": "summarized" })
    );
    assert_eq!(built.body["output_config"], json!({ "effort": "max" }));
    assert_eq!(
      built.body["messages"][1],
      json!({ "role": "assistant", "content": "前半" })
    );
    assert!(built.body.get("tools").is_none());

    let built = build(
      ApiProvider::OpenAi,
      &endpoints,
      &BuildInput {
        model: "gpt-5.6-terra",
        ..input
      },
    )
    .unwrap();
    assert_eq!(built.url, "https://api.openai.com/v1/responses");
    assert_eq!(built.body["instructions"], json!("決まり"));
    assert_eq!(built.body["store"], json!(false));
    assert_eq!(built.body["reasoning"], json!({ "effort": "xhigh" }));
    assert_eq!(built.body["max_output_tokens"], json!(64_000));
    assert_eq!(
      built.body["input"][2],
      json!({ "role": "user", "content": "続きを書いてください。" })
    );
    // 道具を渡さない依頼は道具の定義も暗号化した思考も頼まない（工程の実行・文字起こし）
    assert!(built.body.get("tools").is_none() && built.body.get("include").is_none());

    let file = FileRef {
      uri: "https://generativelanguage.googleapis.com/v1beta/files/abc".into(),
      mime_type: "audio/wav".into(),
    };
    let built = build(
      ApiProvider::Gemini,
      &endpoints,
      &BuildInput {
        model: "gemini-3.8-flash",
        effort: Some(Effort::Low),
        file: Some(&file),
        ..input
      },
    )
    .unwrap();
    assert_eq!(
      built.url,
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse"
    );
    assert_eq!(
      built.body["systemInstruction"],
      json!({ "parts": [{ "text": "決まり" }] })
    );
    assert_eq!(built.body["contents"][1]["role"], json!("model"));
    assert_eq!(
      built.body["contents"][2]["parts"][0],
      json!({ "fileData": { "mimeType": "audio/wav", "fileUri": file.uri } })
    );
    assert_eq!(
      built.body["generationConfig"]["thinkingConfig"],
      json!({ "includeThoughts": true, "thinkingLevel": "LOW" })
    );
    assert!(built.body.get("tools").is_none());
    assert!(build(
      ApiProvider::Gemini,
      &endpoints,
      &BuildInput {
        model: "../files",
        ..input
      }
    )
    .is_err());
  }

  #[test]
  fn older_claude_models_do_not_get_adaptive_thinking() {
    assert!(claude_supports_adaptive("claude-sonnet-4-6"));
    assert!(claude_supports_adaptive("claude-opus-4-8"));
    assert!(claude_supports_adaptive("claude-fable-5"));
    assert!(claude_supports_adaptive("claude-opus-5-5"));
    assert!(!claude_supports_adaptive("claude-haiku-4-5"));
    assert!(!claude_supports_adaptive("claude-haiku-4-5-20251001"));
    assert!(!claude_supports_adaptive("claude-3-5-sonnet-latest"));
  }

  #[test]
  fn anthropic_events_give_text_thinking_usage_and_max_tokens() {
    let mut collected = Collected::default();
    let mut events = Vec::new();
    let mut emit = |event: TurnEvent| events.push(event);
    for data in [
      json!({"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":120,"output_tokens":1}}}),
      json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"考え中"}}),
      json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"本文"}}),
      json!({"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":64000}}),
      json!({"type":"message_stop"}),
    ] {
      apply(ApiProvider::Anthropic, &event(data), &mut collected, &mut emit);
    }
    assert_eq!(
      events,
      vec![
        TurnEvent::ThinkingDelta("考え中".into()),
        TurnEvent::TextDelta("本文".into())
      ]
    );
    assert_eq!(collected.stop, Some(StopReason::MaxTokens));
    assert!(collected.finished);
    assert_eq!(
      collected.usage("x"),
      Usage {
        input_tokens: 120,
        output_tokens: 64000,
        model_used: Some("claude-sonnet-4-6".into()),
        known: true
      }
    );
    let mut failed = Collected::default();
    apply(
      ApiProvider::Anthropic,
      &event(json!({"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}})),
      &mut failed,
      &mut |_| {},
    );
    assert_eq!(failed.error.map(|e| e.0), Some(Reason::TransientFailure));
    let mut refused = Collected::default();
    apply(
      ApiProvider::Anthropic,
      &event(json!({"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":3}})),
      &mut refused,
      &mut |_| {},
    );
    assert_eq!(refused.error.map(|e| e.0), Some(Reason::Refused));
  }

  #[test]
  fn openai_events_give_text_usage_and_max_tokens() {
    let mut collected = Collected::default();
    let mut text = String::new();
    let mut emit = |event: TurnEvent| {
      if let TurnEvent::TextDelta(delta) = event {
        text.push_str(&delta);
      }
    };
    for data in [
      json!({"type":"response.created","response":{"id":"resp_1","model":"gpt-5.6-terra-2026-09-01"}}),
      json!({"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"前"}),
      json!({"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"半"}),
      json!({"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"model":"gpt-5.6-terra-2026-09-01","usage":{"input_tokens":50,"output_tokens":64000}}}),
    ] {
      apply(ApiProvider::OpenAi, &event(data), &mut collected, &mut emit);
    }
    assert_eq!(text, "前半");
    assert_eq!(collected.stop, Some(StopReason::MaxTokens));
    assert_eq!(
      collected.usage("gpt-5.6-terra").model_used.as_deref(),
      Some("gpt-5.6-terra-2026-09-01")
    );
    assert_eq!(collected.output_tokens, 64000);
    let mut failed = Collected::default();
    apply(
      ApiProvider::OpenAi,
      &event(
        json!({"type":"response.failed","response":{"status":"failed","error":{"code":"rate_limit_exceeded","message":"slow down"}}}),
      ),
      &mut failed,
      &mut |_| {},
    );
    assert_eq!(failed.error.map(|e| e.0), Some(Reason::UsageLimitReached));
    let mut done = Collected::default();
    apply(
      ApiProvider::OpenAi,
      &event(
        json!({"type":"response.completed","response":{"status":"completed","model":"gpt-5.6-terra","usage":{"input_tokens":5,"output_tokens":7}}}),
      ),
      &mut done,
      &mut |_| {},
    );
    assert_eq!(done.stop, Some(StopReason::EndTurn));
    assert!(done.finished && done.usage_seen);
  }

  #[test]
  fn gemini_chunks_split_thoughts_from_text_and_read_the_finish_reason() {
    let mut collected = Collected::default();
    let mut events = Vec::new();
    let mut emit = |event: TurnEvent| events.push(event);
    for data in [
      json!({"candidates":[{"content":{"role":"model","parts":[{"text":"見出しを考える","thought":true}]}}],"modelVersion":"gemini-3.8-flash"}),
      json!({"candidates":[{"content":{"role":"model","parts":[{"text":"[00:00] 話者0: こんにちは"}]}}],"usageMetadata":{"promptTokenCount":900}}),
      json!({"candidates":[{"content":{"role":"model","parts":[{"text":"。"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":900,"candidatesTokenCount":60,"thoughtsTokenCount":40}}),
    ] {
      apply(ApiProvider::Gemini, &event(data), &mut collected, &mut emit);
    }
    assert_eq!(events[0], TurnEvent::ThinkingDelta("見出しを考える".into()));
    assert_eq!(collected.text, "[00:00] 話者0: こんにちは。");
    assert_eq!(collected.stop, Some(StopReason::MaxTokens));
    assert_eq!((collected.input_tokens, collected.output_tokens), (900, 100));
    let mut blocked = Collected::default();
    apply(
      ApiProvider::Gemini,
      &event(json!({"promptFeedback":{"blockReason":"SAFETY"}})),
      &mut blocked,
      &mut |_| {},
    );
    assert_eq!(blocked.error.map(|e| e.0), Some(Reason::Refused));
  }
}
