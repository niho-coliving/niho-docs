//! 偽の API サーバーで、3 社の stream・上限で止まる → 同じ会話で続き・429・401・404・5xx・時間切れ・停止と、
//! Gemini の音声（Files API）・Deepgram・鍵の確かめを確かめる。本物の鍵は使わない（偽の鍵の文字列だけ）。

mod support;

use niho_api_ai::{
  check_key, deepgram, run_turn, Account, ApiProvider, Config, DeepgramRequest, Effort, Endpoints, LogFn, Reason,
  Secret, StopReason, StopSignal, TurnEvent, TurnRequest,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support::{json_reply, sse, FakeServer, Recorded, Reply};

const FAKE_KEY: &str = "sk-fake-TEST0123456789abcdefghijklmnopqrstuv";

fn temp_dir(name: &str) -> PathBuf {
  let dir = std::env::temp_dir().join(format!("niho-api-ai-{name}-{}", std::process::id()));
  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

/// 偽のサーバーへ向けた設定と、ログ（1 行ずつ JSON）。
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

fn request(provider: ApiProvider, dir: &Path) -> TurnRequest {
  TurnRequest {
    provider,
    api_key: Secret::new(FAKE_KEY),
    model: match provider {
      ApiProvider::Anthropic => "claude-sonnet-4-6".into(),
      ApiProvider::OpenAi => "gpt-5.6-terra".into(),
      ApiProvider::Gemini => "gemini-3.8-flash".into(),
    },
    effort: Some(Effort::High),
    system_prompt: "あなたは NIHO docs の工程を実行する AI です。".into(),
    user_prompt: "## 文字起こし\n本文".into(),
    resume_session: None,
    session_dir: dir.to_path_buf(),
    timeout: Duration::from_secs(20),
    max_output_tokens: 64_000,
    audio: None,
    tools: None,
  }
}

/// 1 回実行して、すべてのイベントを返す。
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
  assert!(events.last().unwrap().is_terminal());
  events
}

fn done_of(events: &[TurnEvent]) -> (String, StopReason, Option<String>, niho_api_ai::Usage) {
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

fn error_of(events: &[TurnEvent]) -> (Reason, String) {
  match events.last().unwrap() {
    TurnEvent::Error { reason, message } => (*reason, message.clone()),
    other => panic!("not an error: {other:?}"),
  }
}

fn texts(events: &[TurnEvent]) -> String {
  events
    .iter()
    .filter_map(|event| match event {
      TurnEvent::TextDelta(text) => Some(text.as_str()),
      _ => None,
    })
    .collect()
}

fn anthropic_stream(text: &str, stop: &str) -> Reply {
  sse(&[
    json!({"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-4-6","usage":{"input_tokens":1200,"output_tokens":1}}}),
    json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
    json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"構成を考える"}}),
    json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
    json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":text}}),
    json!({"type":"message_delta","delta":{"stop_reason":stop},"usage":{"output_tokens":300}}),
    json!({"type":"message_stop"}),
  ])
}

#[test]
fn anthropic_streams_and_continues_the_same_conversation_after_max_tokens() {
  let server = FakeServer::start(|_request, call| {
    if call == 0 {
      anthropic_stream("## 見出し\n\n前半", "max_tokens")
    } else {
      anthropic_stream("後半です。", "end_turn")
    }
  });
  let (config, logs) = config(&server);
  let dir = temp_dir("anthropic");
  let first = run(&config, request(ApiProvider::Anthropic, &dir));
  assert!(first.contains(&TurnEvent::ThinkingDelta("構成を考える".into())));
  let (text, stop, session, usage) = done_of(&first);
  assert_eq!(text, "## 見出し\n\n前半");
  assert_eq!(texts(&first), text);
  assert_eq!(stop, StopReason::MaxTokens);
  assert_eq!(
    (usage.input_tokens, usage.output_tokens, usage.known),
    (1200, 300, true)
  );
  assert_eq!(usage.model_used.as_deref(), Some("claude-sonnet-4-6"));
  let session = session.expect("続きに使う会話");
  let mut next = request(ApiProvider::Anthropic, &dir);
  next.user_prompt = "続きを書いてください。".into();
  next.resume_session = Some(session.clone());
  let second = run(&config, next);
  let (text, stop, again, _) = done_of(&second);
  assert_eq!((text.as_str(), stop), ("後半です。", StopReason::EndTurn));
  assert_eq!(again.as_deref(), Some(session.as_str()));

  let requests = server.requests();
  assert_eq!(requests.len(), 2);
  let call = &requests[0];
  assert_eq!((call.method.as_str(), call.path()), ("POST", "/v1/messages"));
  assert_eq!(call.header("x-api-key"), Some(FAKE_KEY));
  assert_eq!(call.header("anthropic-version"), Some("2023-06-01"));
  let body = call.json();
  assert_eq!(body["system"], json!("あなたは NIHO docs の工程を実行する AI です。"));
  assert_eq!(body["stream"], json!(true));
  assert_eq!(body["output_config"], json!({ "effort": "high" }));
  assert!(body.get("tools").is_none());
  // 続きは履歴ごと同じ会話として送る（システムプロンプトは system に、指示はユーザー側に）
  let continued = requests[1].json();
  assert_eq!(
    continued["messages"],
    json!([
      { "role": "user", "content": "## 文字起こし\n本文" },
      { "role": "assistant", "content": "## 見出し\n\n前半" },
      { "role": "user", "content": "続きを書いてください。" },
    ])
  );
  // 鍵はヘッダーだけ。ログにも会話の履歴にも出ない
  assert!(!call.target.contains(FAKE_KEY));
  assert!(!logs.lock().unwrap().iter().any(|line| line.contains(FAKE_KEY)));
  for entry in std::fs::read_dir(&dir).unwrap().flatten() {
    let content = std::fs::read_to_string(entry.path()).unwrap_or_default();
    assert!(!content.contains(FAKE_KEY), "{:?}", entry.path());
  }
  let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn openai_streams_and_reads_incomplete_as_max_tokens() {
  let server = FakeServer::start(|_request, call| {
    let completed = if call == 0 {
      json!({"type":"response.incomplete","response":{"status":"incomplete","model":"gpt-5.6-terra","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":800,"output_tokens":64000}}})
    } else {
      json!({"type":"response.completed","response":{"status":"completed","model":"gpt-5.6-terra","usage":{"input_tokens":900,"output_tokens":40}}})
    };
    sse(&[
      json!({"type":"response.created","response":{"id":"resp_1","model":"gpt-5.6-terra","status":"in_progress"}}),
      json!({"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":if call == 0 { "前半" } else { "後半" }}),
      completed,
    ])
  });
  let (config, _) = config(&server);
  let dir = temp_dir("openai");
  let mut first = request(ApiProvider::OpenAi, &dir);
  first.effort = Some(Effort::Max);
  let events = run(&config, first);
  let (text, stop, session, usage) = done_of(&events);
  assert_eq!((text.as_str(), stop), ("前半", StopReason::MaxTokens));
  assert_eq!((usage.input_tokens, usage.output_tokens), (800, 64000));
  let mut next = request(ApiProvider::OpenAi, &dir);
  next.user_prompt = "続きを書いてください。".into();
  next.resume_session = session;
  let (text, stop, _, _) = done_of(&run(&config, next));
  assert_eq!((text.as_str(), stop), ("後半", StopReason::EndTurn));
  let requests = server.requests();
  assert_eq!(requests[0].path(), "/v1/responses");
  assert_eq!(
    requests[0].header("authorization").map(str::to_string),
    Some(format!("Bearer {FAKE_KEY}"))
  );
  let body = requests[0].json();
  assert_eq!(
    body["instructions"],
    json!("あなたは NIHO docs の工程を実行する AI です。")
  );
  assert_eq!(body["reasoning"], json!({ "effort": "xhigh" }));
  assert_eq!(body["store"], json!(false));
  assert_eq!(
    requests[1].json()["input"][1],
    json!({ "role": "assistant", "content": "前半" })
  );
  let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn gemini_streams_with_the_key_in_a_header_and_reads_max_tokens() {
  let server = FakeServer::start(|_request, _call| {
    sse(&[
      json!({"candidates":[{"content":{"role":"model","parts":[{"text":"要点","thought":true}]}}],"modelVersion":"gemini-3.8-flash"}),
      json!({"candidates":[{"content":{"role":"model","parts":[{"text":"本文の前半"}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":700,"candidatesTokenCount":65000,"thoughtsTokenCount":535}}),
    ])
  });
  let (config, _) = config(&server);
  let dir = temp_dir("gemini");
  let events = run(&config, request(ApiProvider::Gemini, &dir));
  assert_eq!(events[0], TurnEvent::ThinkingDelta("要点".into()));
  let (text, stop, session, usage) = done_of(&events);
  assert_eq!((text.as_str(), stop), ("本文の前半", StopReason::MaxTokens));
  assert!(session.is_some());
  assert_eq!((usage.input_tokens, usage.output_tokens), (700, 65535));
  let call = &server.requests()[0];
  assert_eq!(
    call.target,
    "/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse"
  );
  assert_eq!(call.header("x-goog-api-key"), Some(FAKE_KEY));
  assert_eq!(
    call.json()["generationConfig"]["thinkingConfig"]["thinkingLevel"],
    json!("HIGH")
  );
  let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn http_failures_map_to_reasons_without_leaking_the_key() {
  let server = FakeServer::start(|request, _call| {
    let model = request.json()["model"].as_str().unwrap_or("").to_string();
    match model.as_str() {
      "unauthorized" => json_reply(
        401,
        json!({"type":"error","error":{"type":"authentication_error","message":format!("invalid x-api-key {FAKE_KEY}")}}),
      ),
      "limited" => json_reply(429, json!({"error":{"type":"rate_limit_error","message":"slow"}})),
      "missing" => json_reply(404, json!({"error":{"type":"not_found_error","message":"model: missing"}})),
      "broken" => json_reply(500, json!({"error":{"type":"api_error","message":"boom"}})),
      "overloaded" => json_reply(529, json!({"error":{"type":"overloaded_error","message":"Overloaded"}})),
      "credit" => json_reply(
        400,
        json!({"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}),
      ),
      "slow" => Reply::Hang(Duration::from_secs(5)),
      "cut" => Reply::Sse(vec![(
        Duration::ZERO,
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"cut\",\"usage\":{\"input_tokens\":3}}}\n\n"
          .into(),
      )]),
      _ => anthropic_stream("ok", "end_turn"),
    }
  });
  let (config, logs) = config(&server);
  let dir = temp_dir("errors");
  let with_model = |model: &str| {
    let mut call = request(ApiProvider::Anthropic, &dir);
    call.model = model.into();
    call
  };
  let (reason, message) = error_of(&run(&config, with_model("unauthorized")));
  assert_eq!(reason, Reason::KeyInvalid);
  assert_eq!(message, "API キーが無効です。設定 › 接続設定で確かめてください。");
  assert!(!message.contains(FAKE_KEY));
  assert_eq!(
    error_of(&run(&config, with_model("limited"))).0,
    Reason::UsageLimitReached
  );
  assert_eq!(
    error_of(&run(&config, with_model("credit"))).0,
    Reason::UsageLimitReached
  );
  assert_eq!(error_of(&run(&config, with_model("missing"))).0, Reason::ModelNotFound);
  assert_eq!(
    error_of(&run(&config, with_model("broken"))).0,
    Reason::TransientFailure
  );
  assert_eq!(
    error_of(&run(&config, with_model("overloaded"))).0,
    Reason::TransientFailure
  );
  // 終わりの合図が無いまま切れた
  assert_eq!(error_of(&run(&config, with_model("cut"))).0, Reason::TransientFailure);
  let mut slow = with_model("slow");
  slow.timeout = Duration::from_millis(300);
  assert_eq!(error_of(&run(&config, slow)).0, Reason::Timeout);
  // 鍵が無い・続ける会話が無い
  let mut empty = with_model("ok");
  empty.api_key = Secret::new("");
  let (reason, message) = error_of(&run(&config, empty));
  assert_eq!(reason, Reason::NotConfigured);
  assert!(message.contains("Anthropic の API キーが保存されていません"));
  let mut lost = with_model("ok");
  lost.resume_session = Some("api_000000000000000000000000".into());
  assert_eq!(error_of(&run(&config, lost)).0, Reason::SessionNotFound);
  // 401 の本文に鍵があってもログには出ない（要旨は残る）
  let logs = logs.lock().unwrap();
  assert!(logs.iter().any(|line| line.contains("authentication_error")));
  assert!(!logs.iter().any(|line| line.contains(FAKE_KEY)), "{logs:?}");
  let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn unreachable_servers_and_stopping_mid_stream() {
  // 誰も待っていない番号
  let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
  let address = format!("http://{}", closed.local_addr().unwrap());
  drop(closed);
  let config = Config {
    endpoints: Endpoints {
      anthropic: address.clone(),
      openai: address.clone(),
      gemini: address.clone(),
      deepgram: address,
    },
    log: None,
  };
  let dir = temp_dir("stop");
  assert_eq!(
    error_of(&run(&config, request(ApiProvider::OpenAi, &dir))).0,
    Reason::Unreachable
  );

  let server = FakeServer::start(|_request, _call| {
    Reply::Sse(vec![
      (
        Duration::ZERO,
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":5}}}\n\n".into(),
      ),
      (
        Duration::ZERO,
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"途中まで\"}}\n\n".into(),
      ),
      (Duration::from_secs(10), "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".into()),
    ])
  });
  let (config, _) = self::config(&server);
  let events = Arc::new(Mutex::new(Vec::new()));
  let sink = events.clone();
  let handle = run_turn(&config, request(ApiProvider::Anthropic, &dir), move |event| {
    sink.lock().unwrap().push(event)
  });
  for _ in 0..200 {
    if events
      .lock()
      .unwrap()
      .iter()
      .any(|event| matches!(event, TurnEvent::TextDelta(_)))
    {
      break;
    }
    std::thread::sleep(Duration::from_millis(10));
  }
  let started = std::time::Instant::now();
  handle.stop();
  handle.wait();
  assert!(started.elapsed() < Duration::from_secs(3));
  let events = events.lock().unwrap().clone();
  let (text, stop, session, _) = done_of(&events);
  assert_eq!((text.as_str(), stop, session), ("途中まで", StopReason::Stopped, None));
  let _ = std::fs::remove_dir_all(dir);
}

/// Gemini の文字起こしの区切り: 上げる → ACTIVE を待つ → 添えて生成 → 消す。
fn gemini_files_server(fail_generate_for: Option<usize>) -> FakeServer {
  let state = Arc::new(Mutex::new(0usize));
  FakeServer::start(move |request: &Recorded, _call| {
    let base = request
      .header("host")
      .map(|host| format!("http://{host}"))
      .unwrap_or_default();
    match (request.method.as_str(), request.path()) {
      ("POST", "/upload/v1beta/files") if request.header("x-goog-upload-command") == Some("start") => {
        let mut count = state.lock().unwrap();
        *count += 1;
        Reply::Full(
          200,
          vec![(
            "x-goog-upload-url".into(),
            format!("{base}/upload/v1beta/files?upload_id=u{}", *count),
          )],
          String::new(),
        )
      }
      ("POST", "/upload/v1beta/files") => {
        let id = request.target.rsplit('=').next().unwrap_or("u0").to_string();
        json_reply(
          200,
          json!({ "file": { "name": format!("files/{id}"), "uri": format!("{base}/v1beta/files/{id}"), "state": "PROCESSING", "mimeType": "audio/wav" } }),
        )
      }
      ("GET", path) if path.starts_with("/v1beta/files/") => {
        let id = path.trim_start_matches("/v1beta/files/");
        json_reply(
          200,
          json!({ "name": format!("files/{id}"), "uri": format!("{base}/v1beta/files/{id}"), "state": "ACTIVE" }),
        )
      }
      ("DELETE", _) => json_reply(200, json!({})),
      ("POST", path) if path.ends_with(":streamGenerateContent") => {
        let uri = request.json()["contents"][0]["parts"][0]["fileData"]["fileUri"]
          .as_str()
          .unwrap_or("")
          .to_string();
        let part: usize = uri.rsplit('u').next().and_then(|n| n.parse().ok()).unwrap_or(0);
        if fail_generate_for == Some(part) {
          return json_reply(
            503,
            json!({ "error": { "code": 503, "status": "UNAVAILABLE", "message": "busy" } }),
          );
        }
        sse(&[json!({
          "candidates": [{ "content": { "role": "model", "parts": [{ "text": format!("[00:0{part}] 話者0: 区切り{part}") }] }, "finishReason": "STOP" }],
          "usageMetadata": { "promptTokenCount": 3000, "candidatesTokenCount": 20 },
          "modelVersion": "gemini-3.8-flash"
        })])
      }
      _ => json_reply(404, json!({})),
    }
  })
}

#[test]
fn gemini_audio_parts_are_uploaded_attached_and_deleted() {
  let server = gemini_files_server(None);
  let (config, logs) = config(&server);
  let dir = temp_dir("gemini-audio");
  let mut texts = Vec::new();
  for part in 0..2 {
    let wav = dir.join(format!("f0-p{part}.wav"));
    std::fs::write(&wav, format!("RIFF-part-{part}")).unwrap();
    let mut call = request(ApiProvider::Gemini, &dir);
    call.effort = Some(Effort::Low);
    call.user_prompt = "添付の音声を書き起こしてください。".into();
    call.audio = Some(wav);
    let (text, stop, session, usage) = done_of(&run(&config, call));
    assert_eq!(stop, StopReason::EndTurn);
    assert_eq!(session, None, "音声を添えた回は会話を残さない");
    assert_eq!(usage.input_tokens, 3000);
    texts.push(text);
  }
  assert_eq!(texts, vec!["[00:01] 話者0: 区切り1", "[00:02] 話者0: 区切り2"]);
  let requests = server.requests();
  let uploads: Vec<&Recorded> = requests
    .iter()
    .filter(|request| {
      request.path() == "/upload/v1beta/files" && request.header("x-goog-upload-command") != Some("start")
    })
    .collect();
  assert_eq!(uploads.len(), 2);
  assert_eq!(uploads[0].body, b"RIFF-part-0");
  // 上げ先の URL には鍵を付けない
  assert_eq!(uploads[0].header("x-goog-api-key"), None);
  let start = requests
    .iter()
    .find(|request| request.header("x-goog-upload-command") == Some("start"))
    .unwrap();
  assert_eq!(start.header("x-goog-upload-header-content-type"), Some("audio/wav"));
  assert_eq!(start.header("x-goog-api-key"), Some(FAKE_KEY));
  let generate = requests
    .iter()
    .find(|request| request.path().ends_with(":streamGenerateContent"))
    .unwrap();
  assert_eq!(
    generate.json()["contents"][0]["parts"][1],
    json!({ "text": "添付の音声を書き起こしてください。" })
  );
  assert_eq!(
    requests
      .iter()
      .filter(|request| request.method == "DELETE")
      .map(|request| request.path().to_string())
      .collect::<Vec<_>>(),
    vec!["/v1beta/files/u1", "/v1beta/files/u2"]
  );
  assert!(!logs.lock().unwrap().iter().any(|line| line.contains(FAKE_KEY)));
  let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn gemini_audio_is_deleted_even_when_generation_fails() {
  let server = gemini_files_server(Some(1));
  let (config, _) = config(&server);
  let dir = temp_dir("gemini-audio-fail");
  let wav = dir.join("f0-p0.wav");
  std::fs::write(&wav, "RIFF").unwrap();
  let mut call = request(ApiProvider::Gemini, &dir);
  call.audio = Some(wav);
  assert_eq!(error_of(&run(&config, call)).0, Reason::TransientFailure);
  assert!(server.requests().iter().any(|request| request.method == "DELETE"));
  let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn deepgram_sends_the_file_with_the_niho_settings_and_reads_utterances() {
  let server = FakeServer::start(|request, _call| {
    if request.header("authorization") != Some(&format!("Token {FAKE_KEY}")) {
      return json_reply(
        401,
        json!({ "err_code": "INVALID_AUTH", "err_msg": "Invalid credentials." }),
      );
    }
    json_reply(
      200,
      json!({
        "metadata": { "duration": 3600.5 },
        "results": {
          "channels": [{ "alternatives": [{ "transcript": "全文" }] }],
          "utterances": [
            { "start": 1.0, "end": 4.0, "speaker": 0, "transcript": "朝市に 出して 三年目です" },
            { "start": 4.2, "end": 5.0, "speaker": 1, "transcript": "はい" }
          ]
        }
      }),
    )
  });
  let (config, logs) = config(&server);
  let dir = temp_dir("deepgram");
  let audio = dir.join("a1.m4a");
  std::fs::write(&audio, b"fake-m4a-bytes").unwrap();
  let request = DeepgramRequest {
    language: "ja".into(),
    diarize: true,
    keyterms: vec!["NIHO鎌倉".into()],
  };
  let stop = StopSignal::new();
  let result = deepgram::transcribe(
    &config,
    &Secret::new(FAKE_KEY),
    &audio,
    &request,
    Duration::from_secs(20),
    &stop,
  )
  .unwrap()
  .unwrap();
  assert_eq!(result.duration_sec, Some(3600.5));
  assert_eq!(result.utterances.len(), 2);
  let call = &server.requests()[0];
  assert_eq!(call.path(), "/v1/listen");
  assert!(call.target.contains("model=nova-3"));
  assert!(call.target.contains("diarize_model=latest"));
  assert!(call.target.contains("utterances=true"));
  assert!(!call.target.contains(FAKE_KEY));
  assert_eq!(call.header("content-type"), Some("audio/mp4"));
  assert_eq!(call.body, b"fake-m4a-bytes");
  let error = deepgram::transcribe(
    &config,
    &Secret::new("dg-wrong-key-0000000000000000000000000000"),
    &audio,
    &request,
    Duration::from_secs(20),
    &stop,
  )
  .unwrap_err();
  assert_eq!(error.reason, Reason::KeyInvalid);
  assert!(!logs.lock().unwrap().iter().any(|line| line.contains(FAKE_KEY)));
  let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn key_checks_make_one_light_call_and_list_text_models() {
  let server = FakeServer::start(|request, _call| {
    let authorized = request.header("x-api-key") == Some(FAKE_KEY)
      || request.header("x-goog-api-key") == Some(FAKE_KEY)
      || request.header("authorization") == Some(&format!("Bearer {FAKE_KEY}"))
      || request.header("authorization") == Some(&format!("Token {FAKE_KEY}"));
    if !authorized {
      return if request.path() == "/v1beta/models" {
        json_reply(
          400,
          json!({ "error": { "code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT", "details": [{ "reason": "API_KEY_INVALID" }] } }),
        )
      } else {
        json_reply(401, json!({ "error": { "message": "Incorrect API key provided" } }))
      };
    }
    match request.path() {
      "/v1/models" if request.header("x-api-key").is_some() => json_reply(
        200,
        json!({ "data": [{ "id": "claude-sonnet-4-6" }, { "id": "claude-opus-4-8" }] }),
      ),
      "/v1/models" => json_reply(
        200,
        json!({ "data": [{ "id": "gpt-5.6-terra" }, { "id": "whisper-1" }] }),
      ),
      "/v1beta/models" => json_reply(
        200,
        json!({ "models": [{ "name": "models/gemini-3.8-flash", "supportedGenerationMethods": ["generateContent"] }] }),
      ),
      "/v1/projects" => json_reply(200, json!({ "projects": [{ "project_id": "p" }] })),
      _ => json_reply(404, json!({})),
    }
  });
  let (config, logs) = config(&server);
  let key = Secret::new(FAKE_KEY);
  assert_eq!(
    check_key(&config, Account::Anthropic, &key).unwrap().models,
    vec!["claude-sonnet-4-6", "claude-opus-4-8"]
  );
  assert_eq!(
    check_key(&config, Account::OpenAi, &key).unwrap().models,
    vec!["gpt-5.6-terra"]
  );
  assert_eq!(
    check_key(&config, Account::Gemini, &key).unwrap().models,
    vec!["gemini-3.8-flash"]
  );
  assert!(check_key(&config, Account::Deepgram, &key).unwrap().models.is_empty());
  let wrong = Secret::new("sk-wrong-0000000000000000000000000000000000");
  for account in [Account::Anthropic, Account::OpenAi, Account::Gemini, Account::Deepgram] {
    let error = check_key(&config, account, &wrong).unwrap_err();
    assert_eq!(error.reason, Reason::KeyInvalid, "{account:?}");
    assert_eq!(error.message, "API キーが無効です。設定 › 接続設定で確かめてください。");
  }
  assert_eq!(server.requests().len(), 8, "鍵ごとに 1 回だけ");
  assert!(!logs.lock().unwrap().iter().any(|line| line.contains(FAKE_KEY)));
}
