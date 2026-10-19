//! 修正の会話（道具の往復）を偽の API サーバーで確かめる: 3 社それぞれ、1 往復目で read_file → edit_file、2 往復目で返答 →
//! workspace のファイルが変わる・イベントの順・Done.text・2 往復目の依頼に道具の結果と思考の署名（Anthropic の signature・
//! OpenAI の encrypted reasoning・Gemini の thoughtSignature）がそのまま入る・道具の往復を含む続き。パスの抜け道・40 往復・
//! 往復の間の停止・出力の上限・鍵の漏れも確かめる。本物の鍵は使わない。

mod support;

use niho_api_ai::{
  run_turn, ApiProvider, Config, Effort, Endpoints, FolderTools, LogFn, Reason, Secret, StopReason, TurnEvent,
  TurnRequest, Usage,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support::{sse, FakeServer, Reply};

const FAKE_KEY: &str = "sk-fake-TEST0123456789abcdefghijklmnopqrstuv";
const DOC: &str = "# 朝市\n\n## はじめに\n\n本文です。\n";
const PROMPT: &str = "「はじめに」を「概要」に直してください。";

struct Place {
  root: PathBuf,
  tools: FolderTools,
  history: PathBuf,
}

impl Place {
  fn new(name: &str) -> Self {
    let root = std::env::temp_dir().join(format!("niho-api-ai-tools-it-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let workspace = root.join("workspace");
    std::fs::create_dir_all(workspace.join("artifacts")).unwrap();
    std::fs::write(workspace.join("artifacts/doc.md"), DOC).unwrap();
    std::fs::write(workspace.join("artifacts/source.md"), "話者0: こんにちは").unwrap();
    let history = root.join("history");
    std::fs::create_dir_all(&history).unwrap();
    Self {
      root,
      tools: FolderTools {
        dir: workspace,
        writable: vec!["artifacts".into()],
      },
      history,
    }
  }

  fn doc(&self) -> String {
    std::fs::read_to_string(self.tools.dir.join("artifacts/doc.md")).unwrap()
  }

  fn request(&self, provider: ApiProvider) -> TurnRequest {
    TurnRequest {
      provider,
      api_key: Secret::new(FAKE_KEY),
      model: match provider {
        ApiProvider::Anthropic => "claude-sonnet-4-6".into(),
        ApiProvider::OpenAi => "gpt-5.6-terra".into(),
        ApiProvider::Gemini => "gemini-3.8-flash".into(),
      },
      effort: Some(Effort::High),
      system_prompt: "あなたは文書の修正を手伝う AI です。".into(),
      user_prompt: PROMPT.into(),
      resume_session: None,
      session_dir: self.history.clone(),
      timeout: Duration::from_secs(20),
      max_output_tokens: 64_000,
      audio: None,
      tools: Some(self.tools.clone()),
    }
  }

  /// 会話の履歴のファイル（1 つ）の中身。
  fn history_text(&self) -> String {
    std::fs::read_dir(&self.history)
      .unwrap()
      .flatten()
      .map(|entry| std::fs::read_to_string(entry.path()).unwrap_or_default())
      .collect()
  }
}

impl Drop for Place {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.root);
  }
}

fn config(server: &FakeServer) -> (Config, Arc<Mutex<Vec<String>>>) {
  let lines = Arc::new(Mutex::new(Vec::new()));
  let sink = lines.clone();
  let log: LogFn = Arc::new(move |kind: &str, payload: Value| {
    sink
      .lock()
      .unwrap()
      .push(json!({ "kind": kind, "data": payload }).to_string());
  });
  (
    Config {
      endpoints: Endpoints {
        anthropic: server.base.clone(),
        openai: server.base.clone(),
        gemini: server.base.clone(),
        deepgram: server.base.clone(),
      },
      log: Some(log),
    },
    lines,
  )
}

fn run(config: &Config, request: TurnRequest) -> Vec<TurnEvent> {
  let events = Arc::new(Mutex::new(Vec::new()));
  let sink = events.clone();
  let handle = run_turn(config, request, move |event| sink.lock().unwrap().push(event));
  handle.wait();
  let events = events.lock().unwrap().clone();
  assert_eq!(
    events.iter().filter(|event| event.is_terminal()).count(),
    1,
    "{events:?}"
  );
  events
}

fn done_of(events: &[TurnEvent]) -> (String, StopReason, Option<String>, Usage) {
  match events.last().unwrap() {
    TurnEvent::Done {
      text,
      stop_reason,
      session_id,
      usage,
      ..
    } => (text.clone(), *stop_reason, session_id.clone(), usage.clone()),
    other => panic!("not done: {other:?}"),
  }
}

/// イベントの順（Done は種類だけ）。
fn shape(events: &[TurnEvent]) -> Vec<String> {
  events
    .iter()
    .map(|event| match event {
      TurnEvent::ThinkingDelta(text) => format!("thinking {text}"),
      TurnEvent::TextDelta(text) => format!("text {text}"),
      TurnEvent::ToolUse { id, name, summary } => format!("use {id} {name} {summary}"),
      TurnEvent::ToolResult { id, name, ok } => format!("result {id} {name} {ok}"),
      TurnEvent::Done { .. } => "done".into(),
      TurnEvent::Error { reason, .. } => format!("error {reason:?}"),
    })
    .collect()
}

fn edit_input() -> Value {
  json!({ "path": "artifacts/doc.md", "old_text": "## はじめに", "new_text": "## 概要" })
}

const EDITED: &str = "artifacts/doc.md の 1 か所を置き換えました。";

// ---------------------------------------------------------------------------
// Anthropic

fn anthropic_event(kind: &str, index: u64, body: Value) -> Value {
  let mut event = json!({ "type": kind, "index": index });
  for (key, value) in body.as_object().unwrap() {
    event[key] = value.clone();
  }
  event
}

/// 道具の呼び出し（id・名前・入力）で終わる往復。思考の block（署名つき）・redacted_thinking・実況の文を前に置く。
fn anthropic_tool_round(signature: &str, calls: &[(&str, &str, Value)]) -> Reply {
  let mut events = vec![
    json!({"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":1000,"output_tokens":1}}}),
    anthropic_event(
      "content_block_start",
      0,
      json!({"content_block":{"type":"thinking","thinking":""}}),
    ),
    anthropic_event(
      "content_block_delta",
      0,
      json!({"delta":{"type":"thinking_delta","thinking":"読んでから直す"}}),
    ),
    anthropic_event(
      "content_block_delta",
      0,
      json!({"delta":{"type":"signature_delta","signature":signature}}),
    ),
    anthropic_event("content_block_stop", 0, json!({})),
    anthropic_event(
      "content_block_start",
      1,
      json!({"content_block":{"type":"redacted_thinking","data":"REDACTED-1"}}),
    ),
    anthropic_event("content_block_stop", 1, json!({})),
    anthropic_event(
      "content_block_start",
      2,
      json!({"content_block":{"type":"text","text":""}}),
    ),
    anthropic_event(
      "content_block_delta",
      2,
      json!({"delta":{"type":"text_delta","text":"確かめて直します。"}}),
    ),
    anthropic_event("content_block_stop", 2, json!({})),
  ];
  for (offset, (id, name, input)) in calls.iter().enumerate() {
    let index = 3 + offset as u64;
    events.push(anthropic_event(
      "content_block_start",
      index,
      json!({"content_block":{"type":"tool_use","id":id,"name":name,"input":{}}}),
    ));
    // 入力の JSON は途中で分かれて届く
    let text = input.to_string();
    let middle = text
      .char_indices()
      .nth(text.chars().count() / 2)
      .map(|(at, _)| at)
      .unwrap_or(0);
    for part in [&text[..middle], &text[middle..]] {
      events.push(anthropic_event(
        "content_block_delta",
        index,
        json!({"delta":{"type":"input_json_delta","partial_json":part}}),
      ));
    }
    events.push(anthropic_event("content_block_stop", index, json!({})));
  }
  events.push(json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":200}}));
  events.push(json!({"type":"message_stop"}));
  sse(&events)
}

fn anthropic_answer(signature: &str, text: &str) -> Reply {
  sse(&[
    json!({"type":"message_start","message":{"id":"msg_2","model":"claude-sonnet-4-6","usage":{"input_tokens":1500,"output_tokens":1}}}),
    anthropic_event(
      "content_block_start",
      0,
      json!({"content_block":{"type":"thinking","thinking":""}}),
    ),
    anthropic_event(
      "content_block_delta",
      0,
      json!({"delta":{"type":"thinking_delta","thinking":"確かめた"}}),
    ),
    anthropic_event(
      "content_block_delta",
      0,
      json!({"delta":{"type":"signature_delta","signature":signature}}),
    ),
    anthropic_event("content_block_stop", 0, json!({})),
    anthropic_event(
      "content_block_start",
      1,
      json!({"content_block":{"type":"text","text":""}}),
    ),
    anthropic_event(
      "content_block_delta",
      1,
      json!({"delta":{"type":"text_delta","text":text}}),
    ),
    anthropic_event("content_block_stop", 1, json!({})),
    json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}),
    json!({"type":"message_stop"}),
  ])
}

#[test]
fn anthropic_reads_edits_and_answers_with_the_thinking_signature_returned() {
  let server = FakeServer::start(|_request, call| match call {
    0 => anthropic_tool_round(
      "SIG-ROUND-1",
      &[
        ("toolu_read", "read_file", json!({ "path": "artifacts/doc.md" })),
        ("toolu_edit", "edit_file", edit_input()),
      ],
    ),
    1 => anthropic_answer("SIG-ROUND-2", "見出しを「概要」に直しました。"),
    _ => anthropic_answer("SIG-ROUND-3", "ほかは直していません。"),
  });
  let (config, logs) = config(&server);
  let place = Place::new("anthropic");
  let events = run(&config, place.request(ApiProvider::Anthropic));
  assert_eq!(
    shape(&events),
    vec![
      "thinking 読んでから直す",
      "text 確かめて直します。",
      "use toolu_read Read doc.md",
      "result toolu_read Read true",
      "use toolu_edit Edit doc.md",
      "result toolu_edit Edit true",
      "thinking 確かめた",
      "text 見出しを「概要」に直しました。",
      "done",
    ]
  );
  let (text, stop, session, usage) = done_of(&events);
  assert_eq!(
    (text.as_str(), stop),
    ("見出しを「概要」に直しました。", StopReason::EndTurn)
  );
  assert_eq!(
    (usage.input_tokens, usage.output_tokens, usage.known),
    (2500, 250, true)
  );
  assert_eq!(place.doc(), DOC.replace("## はじめに", "## 概要"));

  let requests = server.requests();
  let first = requests[0].json();
  let names: Vec<&str> = first["tools"]
    .as_array()
    .unwrap()
    .iter()
    .map(|tool| tool["name"].as_str().unwrap())
    .collect();
  assert_eq!(names, vec!["list_files", "read_file", "edit_file", "write_file"]);
  assert_eq!(
    first["tools"][2]["input_schema"]["required"],
    json!(["path", "old_text", "new_text"])
  );
  let second = requests[1].json();
  assert_eq!(second["tools"], first["tools"], "道具の定義は往復の間で変えない");
  assert_eq!(second["system"], first["system"]);
  assert_eq!(
    second["messages"],
    json!([
      { "role": "user", "content": PROMPT },
      { "role": "assistant", "content": [
        { "type": "thinking", "thinking": "読んでから直す", "signature": "SIG-ROUND-1" },
        { "type": "redacted_thinking", "data": "REDACTED-1" },
        { "type": "text", "text": "確かめて直します。" },
        { "type": "tool_use", "id": "toolu_read", "name": "read_file", "input": { "path": "artifacts/doc.md" } },
        { "type": "tool_use", "id": "toolu_edit", "name": "edit_file", "input": edit_input() },
      ] },
      { "role": "user", "content": [
        { "type": "tool_result", "tool_use_id": "toolu_read", "content": DOC, "is_error": false },
        { "type": "tool_result", "tool_use_id": "toolu_edit", "content": EDITED, "is_error": false },
      ] },
    ])
  );

  // 続き: 道具の往復と最後の返答（思考の署名つき）を含めた履歴ごと送る
  let mut next = place.request(ApiProvider::Anthropic);
  next.user_prompt = "ほかに直したところはありますか。".into();
  next.resume_session = session.clone();
  let again = run(&config, next);
  let (text, _, same, _) = done_of(&again);
  assert_eq!(text, "ほかは直していません。");
  assert_eq!(same, session);
  let third = server.requests()[2].json();
  let messages = third["messages"].as_array().unwrap();
  assert_eq!(messages.len(), 5);
  assert_eq!(&messages[..3], &second["messages"].as_array().unwrap()[..]);
  assert_eq!(
    messages[3],
    json!({ "role": "assistant", "content": [
      { "type": "thinking", "thinking": "確かめた", "signature": "SIG-ROUND-2" },
      { "type": "text", "text": "見出しを「概要」に直しました。" },
    ] })
  );
  assert_eq!(
    messages[4],
    json!({ "role": "user", "content": "ほかに直したところはありますか。" })
  );
  assert!(!logs.lock().unwrap().iter().any(|line| line.contains(FAKE_KEY)));
}

// ---------------------------------------------------------------------------
// OpenAI

fn openai_tool_round(encrypted: &str, calls: &[(&str, &str, Value)]) -> Reply {
  let mut events = vec![
    json!({"type":"response.created","response":{"id":"resp_1","model":"gpt-5.6-terra","status":"in_progress"}}),
    json!({"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}),
    json!({"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":encrypted}}),
    json!({"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[]}}),
    json!({"type":"response.output_text.delta","item_id":"msg_1","output_index":1,"content_index":0,"delta":"確かめて直します。"}),
    json!({"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"確かめて直します。","annotations":[]}]}}),
  ];
  for (offset, (call_id, name, input)) in calls.iter().enumerate() {
    let index = 2 + offset;
    let item_id = format!("fc_{index}");
    events.push(json!({"type":"response.output_item.added","output_index":index,"item":{"type":"function_call","id":item_id,"call_id":call_id,"name":name,"arguments":"","status":"in_progress"}}));
    events.push(json!({"type":"response.function_call_arguments.delta","item_id":item_id,"output_index":index,"delta":input.to_string()}));
    events.push(json!({"type":"response.output_item.done","output_index":index,"item":{"type":"function_call","id":item_id,"call_id":call_id,"name":name,"arguments":input.to_string(),"status":"completed"}}));
  }
  events.push(json!({"type":"response.completed","response":{"id":"resp_1","status":"completed","model":"gpt-5.6-terra","usage":{"input_tokens":800,"output_tokens":120}}}));
  sse(&events)
}

fn openai_answer(encrypted: &str, text: &str) -> Reply {
  sse(&[
    json!({"type":"response.created","response":{"id":"resp_2","model":"gpt-5.6-terra","status":"in_progress"}}),
    json!({"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_2","summary":[],"encrypted_content":encrypted}}),
    json!({"type":"response.output_text.delta","item_id":"msg_2","output_index":1,"content_index":0,"delta":text}),
    json!({"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"msg_2","role":"assistant","status":"completed","content":[{"type":"output_text","text":text,"annotations":[]}]}}),
    json!({"type":"response.completed","response":{"id":"resp_2","status":"completed","model":"gpt-5.6-terra","usage":{"input_tokens":900,"output_tokens":40}}}),
  ])
}

#[test]
fn openai_reads_edits_and_answers_with_the_encrypted_reasoning_returned() {
  let server = FakeServer::start(|_request, call| match call {
    0 => openai_tool_round(
      "ENC-ROUND-1",
      &[
        ("call_read", "read_file", json!({ "path": "artifacts/doc.md" })),
        ("call_edit", "edit_file", edit_input()),
      ],
    ),
    1 => openai_answer("ENC-ROUND-2", "見出しを「概要」に直しました。"),
    _ => openai_answer("ENC-ROUND-3", "ほかは直していません。"),
  });
  let (config, _) = config(&server);
  let place = Place::new("openai");
  let events = run(&config, place.request(ApiProvider::OpenAi));
  assert_eq!(
    shape(&events),
    vec![
      "text 確かめて直します。",
      "use call_read Read doc.md",
      "result call_read Read true",
      "use call_edit Edit doc.md",
      "result call_edit Edit true",
      "text 見出しを「概要」に直しました。",
      "done",
    ]
  );
  let (text, stop, session, usage) = done_of(&events);
  assert_eq!(
    (text.as_str(), stop),
    ("見出しを「概要」に直しました。", StopReason::EndTurn)
  );
  assert_eq!((usage.input_tokens, usage.output_tokens), (1700, 160));
  assert_eq!(place.doc(), DOC.replace("## はじめに", "## 概要"));

  let requests = server.requests();
  let first = requests[0].json();
  assert_eq!(first["store"], json!(false));
  assert_eq!(first["include"], json!(["reasoning.encrypted_content"]));
  assert_eq!(first["tools"][0]["type"], json!("function"));
  assert_eq!(first["tools"][0]["name"], json!("list_files"));
  assert_eq!(first["tools"][0]["strict"], json!(true));
  assert_eq!(
    first["tools"][3]["parameters"],
    json!({
      "type": "object",
      "properties": {
        "path": { "type": "string", "description": "作業フォルダからの相対パス（例 artifacts/abc12345.md）" },
        "content": { "type": "string", "description": "ファイルの本文の全体（UTF-8）" },
      },
      "required": ["path", "content"],
      "additionalProperties": false,
    })
  );
  let second = requests[1].json();
  assert_eq!(
    second["input"],
    json!([
      { "role": "user", "content": PROMPT },
      { "type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "ENC-ROUND-1" },
      { "type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "content": [{ "type": "output_text", "text": "確かめて直します。", "annotations": [] }] },
      { "type": "function_call", "id": "fc_2", "call_id": "call_read", "name": "read_file", "arguments": json!({ "path": "artifacts/doc.md" }).to_string(), "status": "completed" },
      { "type": "function_call", "id": "fc_3", "call_id": "call_edit", "name": "edit_file", "arguments": edit_input().to_string(), "status": "completed" },
      { "type": "function_call_output", "call_id": "call_read", "output": DOC },
      { "type": "function_call_output", "call_id": "call_edit", "output": EDITED },
    ])
  );

  let mut next = place.request(ApiProvider::OpenAi);
  next.user_prompt = "ほかに直したところはありますか。".into();
  next.resume_session = session;
  assert_eq!(done_of(&run(&config, next)).0, "ほかは直していません。");
  let third = server.requests()[2].json();
  let input = third["input"].as_array().unwrap();
  assert_eq!(&input[..7], &second["input"].as_array().unwrap()[..]);
  assert_eq!(
    input[7],
    json!({ "type": "reasoning", "id": "rs_2", "summary": [], "encrypted_content": "ENC-ROUND-2" })
  );
  assert_eq!(input[8]["type"], json!("message"));
  assert_eq!(
    input[9],
    json!({ "role": "user", "content": "ほかに直したところはありますか。" })
  );
}

// ---------------------------------------------------------------------------
// Gemini

fn gemini_chunk(parts: Value, finish: Option<&str>, usage: Option<Value>) -> Value {
  let mut candidate = json!({ "content": { "role": "model", "parts": parts } });
  if let Some(reason) = finish {
    candidate["finishReason"] = json!(reason);
  }
  let mut chunk = json!({ "candidates": [candidate], "modelVersion": "gemini-3.8-flash" });
  if let Some(usage) = usage {
    chunk["usageMetadata"] = usage;
  }
  chunk
}

#[test]
fn gemini_reads_edits_and_answers_with_the_thought_signature_returned() {
  let server = FakeServer::start(|_request, call| match call {
    0 => sse(&[
      gemini_chunk(json!([{ "text": "読んでから直す", "thought": true }]), None, None),
      gemini_chunk(json!([{ "text": "確かめて" }]), None, None),
      gemini_chunk(json!([{ "text": "直します。" }]), None, None),
      gemini_chunk(
        json!([
          { "functionCall": { "name": "read_file", "args": { "path": "artifacts/doc.md" } }, "thoughtSignature": "TSIG-1" },
          { "functionCall": { "name": "edit_file", "args": edit_input(), "id": "gem-edit" } },
        ]),
        Some("STOP"),
        Some(json!({ "promptTokenCount": 700, "candidatesTokenCount": 30, "thoughtsTokenCount": 20 })),
      ),
    ]),
    1 => sse(&[gemini_chunk(
      json!([{ "text": "見出しを「概要」に直しました。", "thoughtSignature": "TSIG-2" }]),
      Some("STOP"),
      Some(json!({ "promptTokenCount": 900, "candidatesTokenCount": 20 })),
    )]),
    _ => sse(&[gemini_chunk(
      json!([{ "text": "ほかは直していません。" }]),
      Some("STOP"),
      Some(json!({ "promptTokenCount": 1000, "candidatesTokenCount": 10 })),
    )]),
  });
  let (config, _) = config(&server);
  let place = Place::new("gemini");
  let events = run(&config, place.request(ApiProvider::Gemini));
  assert_eq!(
    shape(&events),
    vec![
      "thinking 読んでから直す",
      "text 確かめて",
      "text 直します。",
      "use call_1_0 Read doc.md",
      "result call_1_0 Read true",
      "use gem-edit Edit doc.md",
      "result gem-edit Edit true",
      "text 見出しを「概要」に直しました。",
      "done",
    ]
  );
  let (text, stop, session, usage) = done_of(&events);
  assert_eq!(
    (text.as_str(), stop),
    ("見出しを「概要」に直しました。", StopReason::EndTurn)
  );
  assert_eq!((usage.input_tokens, usage.output_tokens), (1600, 70));
  assert_eq!(place.doc(), DOC.replace("## はじめに", "## 概要"));

  let requests = server.requests();
  let first = requests[0].json();
  let declarations = &first["tools"][0]["functionDeclarations"];
  assert_eq!(declarations[0]["name"], json!("list_files"));
  assert!(
    declarations[0].get("parameters").is_none(),
    "引数の無い道具は parameters を付けない"
  );
  assert!(declarations[1]["parameters"].get("additionalProperties").is_none());
  assert_eq!(declarations[1]["parameters"]["required"], json!(["path"]));
  let second = requests[1].json();
  assert_eq!(
    second["contents"],
    json!([
      { "role": "user", "parts": [{ "text": PROMPT }] },
      { "role": "model", "parts": [
        { "text": "読んでから直す", "thought": true },
        { "text": "確かめて直します。" },
        { "functionCall": { "name": "read_file", "args": { "path": "artifacts/doc.md" } }, "thoughtSignature": "TSIG-1" },
        { "functionCall": { "name": "edit_file", "args": edit_input(), "id": "gem-edit" } },
      ] },
      { "role": "user", "parts": [
        { "functionResponse": { "name": "read_file", "response": { "result": DOC } } },
        { "functionResponse": { "name": "edit_file", "id": "gem-edit", "response": { "result": EDITED } } },
      ] },
    ])
  );

  let mut next = place.request(ApiProvider::Gemini);
  next.user_prompt = "ほかに直したところはありますか。".into();
  next.resume_session = session;
  assert_eq!(done_of(&run(&config, next)).0, "ほかは直していません。");
  let third = server.requests()[2].json();
  let contents = third["contents"].as_array().unwrap();
  assert_eq!(&contents[..3], &second["contents"].as_array().unwrap()[..]);
  assert_eq!(
    contents[3],
    json!({ "role": "model", "parts": [{ "text": "見出しを「概要」に直しました。", "thoughtSignature": "TSIG-2" }] })
  );
  assert_eq!(
    contents[4],
    json!({ "role": "user", "parts": [{ "text": "ほかに直したところはありますか。" }] })
  );
}

// ---------------------------------------------------------------------------
// 抜け道・上限・停止・鍵

#[test]
fn escaping_paths_are_tool_errors_and_change_nothing_and_the_key_stays_out() {
  let place = Place::new("escape");
  let outside = place.root.join("outside");
  std::fs::create_dir_all(&outside).unwrap();
  std::fs::write(outside.join("secret.md"), "外の秘密").unwrap();
  std::fs::write(place.tools.dir.join("notes.md"), "上の文書").unwrap();
  // 文書に鍵が貼られていても、モデル・履歴・ログへ送らない
  std::fs::write(place.tools.dir.join("artifacts/source.md"), format!("メモ: {FAKE_KEY}")).unwrap();
  #[cfg(unix)]
  {
    std::os::unix::fs::symlink(&outside, place.tools.dir.join("artifacts/linked")).unwrap();
    std::os::unix::fs::symlink(outside.join("secret.md"), place.tools.dir.join("artifacts/alias.md")).unwrap();
  }
  let absolute = outside.join("secret.md").to_string_lossy().to_string();
  let bad: Vec<(String, &str, Value)> = vec![
    ("t_up".into(), "read_file", json!({ "path": "../outside/secret.md" })),
    ("t_abs".into(), "read_file", json!({ "path": absolute })),
    (
      "t_link".into(),
      "read_file",
      json!({ "path": "artifacts/linked/secret.md" }),
    ),
    (
      "t_alias".into(),
      "write_file",
      json!({ "path": "artifacts/alias.md", "content": "上書き" }),
    ),
    (
      "t_out".into(),
      "write_file",
      json!({ "path": "notes.md", "content": "上書き" }),
    ),
    (
      "t_edit_out".into(),
      "edit_file",
      json!({ "path": "notes.md", "old_text": "上の文書", "new_text": "上書き" }),
    ),
    (
      "t_txt".into(),
      "write_file",
      json!({ "path": "artifacts/x.txt", "content": "上書き" }),
    ),
    (
      "t_none".into(),
      "edit_file",
      json!({ "path": "artifacts/doc.md", "old_text": "無い文", "new_text": "x" }),
    ),
  ];
  let script: Vec<(String, &str, Value)> = bad.clone();
  let server = FakeServer::start(move |_request, call| {
    if call == 0 {
      let mut calls: Vec<(&str, &str, Value)> = script
        .iter()
        .map(|(id, name, input)| (id.as_str(), *name, input.clone()))
        .collect();
      calls.push(("t_source", "read_file", json!({ "path": "artifacts/source.md" })));
      anthropic_tool_round("SIG", &calls)
    } else {
      anthropic_answer("SIG-2", "直せませんでした。")
    }
  });
  let (config, logs) = config(&server);
  let events = run(&config, place.request(ApiProvider::Anthropic));
  let results: Vec<(String, bool)> = events
    .iter()
    .filter_map(|event| match event {
      TurnEvent::ToolResult { id, ok, .. } => Some((id.clone(), *ok)),
      _ => None,
    })
    .collect();
  let mut expected: Vec<(String, bool)> = bad.iter().map(|(id, _, _)| (id.clone(), false)).collect();
  expected.push(("t_source".into(), true));
  assert_eq!(results, expected);
  assert_eq!(done_of(&events).0, "直せませんでした。");
  // ファイルは変わらない・外に書かれない
  assert_eq!(place.doc(), DOC);
  assert_eq!(std::fs::read_to_string(outside.join("secret.md")).unwrap(), "外の秘密");
  assert_eq!(
    std::fs::read_to_string(place.tools.dir.join("notes.md")).unwrap(),
    "上の文書"
  );
  assert!(!place.tools.dir.join("artifacts/x.txt").exists());
  // 結果はエラーとしてモデルに返り、フォルダの絶対パス・外の本文・鍵は入らない
  let second = server.requests()[1].json();
  let returned = second["messages"][2]["content"].as_array().unwrap().clone();
  assert_eq!(returned.len(), 9);
  for result in &returned[..8] {
    assert_eq!(result["is_error"], json!(true), "{result}");
  }
  assert_eq!(returned[8]["content"], json!("メモ: ••••"));
  let results_text = Value::Array(returned).to_string();
  assert!(
    !results_text.contains(&place.root.to_string_lossy().to_string()),
    "{results_text}"
  );
  let body = String::from_utf8(server.requests()[1].body.clone()).unwrap();
  assert!(!body.contains("外の秘密"));
  assert!(!body.contains(FAKE_KEY));
  assert!(!place.history_text().contains(FAKE_KEY));
  assert!(!place.history_text().is_empty());
  assert!(!logs.lock().unwrap().iter().any(|line| line.contains(FAKE_KEY)));
  assert!(!format!("{events:?}").contains(FAKE_KEY));
  let _ = std::fs::remove_dir_all(outside);
}

#[test]
fn the_tool_loop_stops_after_forty_requests() {
  let server = FakeServer::start(|_request, call| {
    let id = format!("toolu_{call}");
    anthropic_tool_round("SIG", &[(id.as_str(), "list_files", json!({}))])
  });
  let (config, _) = config(&server);
  let place = Place::new("forty");
  let events = run(&config, place.request(ApiProvider::Anthropic));
  match events.last().unwrap() {
    TurnEvent::Error { reason, message } => {
      assert_eq!(*reason, Reason::TransientFailure);
      assert!(message.contains("40 回"), "{message}");
    }
    other => panic!("{other:?}"),
  }
  assert_eq!(server.requests().len(), 40);
  let uses = events
    .iter()
    .filter(|event| matches!(event, TurnEvent::ToolUse { .. }))
    .count();
  assert_eq!(uses, 39);
}

#[test]
fn stopping_between_rounds_ends_quickly_without_more_tools() {
  let server = FakeServer::start(|_request, call| {
    if call == 0 {
      anthropic_tool_round("SIG", &[("toolu_list", "list_files", json!({}))])
    } else {
      Reply::Hang(Duration::from_secs(10))
    }
  });
  let (config, _) = config(&server);
  let place = Place::new("stop");
  let events = Arc::new(Mutex::new(Vec::new()));
  let sink = events.clone();
  let handle = run_turn(&config, place.request(ApiProvider::Anthropic), move |event| {
    sink.lock().unwrap().push(event)
  });
  for _ in 0..300 {
    if server.requests().len() >= 2 {
      break;
    }
    std::thread::sleep(Duration::from_millis(10));
  }
  assert_eq!(server.requests().len(), 2);
  let started = std::time::Instant::now();
  handle.stop();
  handle.wait();
  assert!(started.elapsed() < Duration::from_secs(3));
  let events = events.lock().unwrap().clone();
  assert!(events.contains(&TurnEvent::ToolResult {
    id: "toolu_list".into(),
    name: "Glob".into(),
    ok: true
  }));
  let (text, stop, session, usage) = done_of(&events);
  assert_eq!((text.as_str(), stop, session), ("", StopReason::Stopped, None));
  assert_eq!(usage.input_tokens, 1000, "終わった往復の使用量は数える");
}

#[test]
fn a_round_cut_by_max_tokens_runs_no_tools_and_keeps_a_valid_history() {
  let server = FakeServer::start(|_request, call| {
    if call == 0 {
      sse(&[
        json!({"type":"message_start","message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10}}}),
        anthropic_event(
          "content_block_start",
          0,
          json!({"content_block":{"type":"text","text":""}}),
        ),
        anthropic_event(
          "content_block_delta",
          0,
          json!({"delta":{"type":"text_delta","text":"書き直します。"}}),
        ),
        anthropic_event(
          "content_block_start",
          1,
          json!({"content_block":{"type":"tool_use","id":"toolu_w","name":"write_file","input":{}}}),
        ),
        anthropic_event(
          "content_block_delta",
          1,
          json!({"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"artifacts/doc.md\",\"content\":\"途"}}),
        ),
        json!({"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":64000}}),
        json!({"type":"message_stop"}),
      ])
    } else {
      anthropic_answer("SIG", "続けました。")
    }
  });
  let (config, _) = config(&server);
  let place = Place::new("max");
  let events = run(&config, place.request(ApiProvider::Anthropic));
  assert!(!events.iter().any(|event| matches!(event, TurnEvent::ToolUse { .. })));
  let (text, stop, session, _) = done_of(&events);
  assert_eq!((text.as_str(), stop), ("書き直します。", StopReason::MaxTokens));
  assert_eq!(place.doc(), DOC);
  let mut next = place.request(ApiProvider::Anthropic);
  next.user_prompt = "続けてください。".into();
  next.resume_session = session;
  assert_eq!(done_of(&run(&config, next)).0, "続けました。");
  assert_eq!(
    server.requests()[1].json()["messages"],
    json!([
      { "role": "user", "content": PROMPT },
      { "role": "assistant", "content": [{ "type": "text", "text": "書き直します。" }] },
      { "role": "user", "content": "続けてください。" },
    ])
  );
}

#[test]
fn text_only_histories_still_resume_with_tools() {
  // 文字だけの古い履歴（raw の無い発言）も読める
  let place = Place::new("old-history");
  std::fs::write(
    place.history.join("api-session-api_old.json"),
    json!({ "provider": "anthropic", "model": "claude-sonnet-4-6", "messages": [
      { "role": "user", "text": "## 文字起こし" },
      { "role": "assistant", "text": "前の返事" },
    ] })
    .to_string(),
  )
  .unwrap();
  let server = FakeServer::start(|_request, _call| anthropic_answer("SIG", "はい。"));
  let (config, _) = config(&server);
  let mut request = place.request(ApiProvider::Anthropic);
  request.resume_session = Some("api_old".into());
  assert_eq!(done_of(&run(&config, request)).0, "はい。");
  assert_eq!(
    server.requests()[0].json()["messages"],
    json!([
      { "role": "user", "content": "## 文字起こし" },
      { "role": "assistant", "content": "前の返事" },
      { "role": "user", "content": PROMPT },
    ])
  );
}
