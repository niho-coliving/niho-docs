//! 本物の API で確かめる（料金がかかる。CI では走らない）。鍵は標準入力から 1 行だけ読む（引数・環境変数・ファイルに置かない）。
//!
//! ```sh
//! cd apps/docs
//! read -rs KEY && printf '%s\n' "$KEY" | cargo run -p niho-api-ai --example smoke -- anthropic claude-sonnet-4-6 medium
//! read -rs KEY && printf '%s\n' "$KEY" | cargo run -p niho-api-ai --example smoke -- openai gpt-5.6-luna low
//! read -rs KEY && printf '%s\n' "$KEY" | cargo run -p niho-api-ai --example smoke -- gemini gemini-3.8-flash low [区切りの.wav]
//! read -rs KEY && printf '%s\n' "$KEY" | cargo run -p niho-api-ai --example smoke -- deepgram - - 録音.m4a
//! read -rs KEY && printf '%s\n' "$KEY" | cargo run -p niho-api-ai --example smoke -- anthropic claude-sonnet-4-6 medium chat
//! ```
//!
//! 工程: 鍵の確かめ（モデルの一覧）→ 出力の上限を小さくした 1 往復（上限で止まるか）→ 同じ会話で続き → 本文の先頭・終わり方・
//! 使用量を表示する。音声を渡すと Gemini は Files API に上げて書き起こし、Deepgram は録音を送って utterances の数を表示する。
//! 4 つめに `chat` を渡すと修正の会話（道具の往復）: 一時の workspace の `artifacts/doc.md` を直してもらい、道具の呼び出し・
//! 返答・ファイルの変化を表示し、続けて同じ会話（道具の往復を含む履歴。思考の署名などをそのまま返す）でもう 1 回頼む。

use niho_api_ai::{
  check_key, deepgram, run_turn, Account, ApiProvider, Config, DeepgramRequest, Effort, FolderTools, Secret,
  StopSignal, TurnEvent, TurnRequest,
};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn effort(value: &str) -> Option<Effort> {
  match value {
    "low" => Some(Effort::Low),
    "medium" => Some(Effort::Medium),
    "high" => Some(Effort::High),
    "max" => Some(Effort::Max),
    _ => None,
  }
}

fn turn(config: &Config, request: TurnRequest) -> TurnEvent {
  let last = Arc::new(Mutex::new(None));
  let sink = last.clone();
  let deltas = Arc::new(Mutex::new((0usize, 0usize)));
  let counts = deltas.clone();
  let handle = run_turn(config, request, move |event| {
    let mut counts = counts.lock().unwrap();
    match &event {
      TurnEvent::ThinkingDelta(_) => counts.0 += 1,
      TurnEvent::TextDelta(_) => counts.1 += 1,
      TurnEvent::ToolUse { name, summary, .. } => println!("  tool: {name} {summary}"),
      TurnEvent::ToolResult { name, ok, .. } => println!("  result: {name} ok={ok}"),
      _ => *sink.lock().unwrap() = Some(event),
    }
  });
  handle.wait();
  let (thinking, text) = *deltas.lock().unwrap();
  println!("  events: thinking {thinking} / text {text}");
  let event = last.lock().unwrap().clone().expect("terminal event");
  event
}

fn show(label: &str, event: &TurnEvent) -> Option<String> {
  match event {
    TurnEvent::Done {
      text,
      stop_reason,
      session_id,
      usage,
      duration_ms,
    } => {
      println!(
        "{label}: {stop_reason:?} · {duration_ms} ms · in {} / out {} · model {:?} · session {}",
        usage.input_tokens,
        usage.output_tokens,
        usage.model_used,
        session_id.is_some()
      );
      println!(
        "  text: {}",
        text.chars().take(200).collect::<String>().replace('\n', "⏎")
      );
      session_id.clone()
    }
    TurnEvent::Error { reason, message } => {
      println!("{label}: Error {reason:?} · {message}");
      None
    }
    other => {
      println!("{label}: {other:?}");
      None
    }
  }
}

const CHAT_SYSTEM: &str = concat!(
  "あなたは文書の修正を手伝う AI です。文書は artifacts/ の下の .md にあります。",
  "直すときは edit_file か write_file でファイルを書き換えてください。",
  "返答は日本語で数文にし、文書の本文を貼らないでください。"
);
const CHAT_PROMPT: &str = concat!(
  "artifacts/doc.md の「はじめに」の見出しを「概要」に変え、",
  "出店者の節に artifacts/source.md を踏まえた 1 文を足してください。"
);

/// 修正の会話: 一時の workspace の artifacts/doc.md を直してもらい、続けて同じ会話でもう 1 回頼む。
fn chat(config: &Config, base: TurnRequest, dir: &Path) {
  let workspace = dir.join("workspace");
  std::fs::create_dir_all(workspace.join("artifacts")).unwrap();
  let doc = workspace.join("artifacts/doc.md");
  std::fs::write(
    &doc,
    "# 朝市の記録\n\n## はじめに\n\n鎌倉の朝市は毎週土曜にひらかれる。\n\n## 出店者\n\n農家が多い。\n",
  )
  .unwrap();
  std::fs::write(
    workspace.join("artifacts/source.md"),
    "話者0: 朝市には三年前から野菜を出しています。\n",
  )
  .unwrap();
  let tools = Some(FolderTools {
    dir: workspace,
    writable: vec!["artifacts".into()],
  });
  let base = TurnRequest {
    system_prompt: CHAT_SYSTEM.into(),
    max_output_tokens: 16_000,
    tools,
    ..base
  };
  let first = turn(
    config,
    TurnRequest {
      user_prompt: CHAT_PROMPT.into(),
      ..base.clone()
    },
  );
  let session = show("chat", &first);
  println!("  doc.md:\n{}", std::fs::read_to_string(&doc).unwrap_or_default());
  if let Some(session) = session {
    let next = turn(
      config,
      TurnRequest {
        user_prompt: "いま直した節をもう一度読み、直した内容を 1 文で教えてください。".into(),
        resume_session: Some(session),
        ..base
      },
    );
    show("chat-continued", &next);
  }
}

fn main() {
  let args: Vec<String> = std::env::args().skip(1).collect();
  let account = args
    .first()
    .and_then(|value| Account::parse(value))
    .expect("anthropic | openai | gemini | deepgram");
  let mut line = String::new();
  std::io::stdin().lock().read_line(&mut line).expect("key on stdin");
  let key = Secret::new(line.trim());
  let config = Config::default();
  match check_key(&config, account, &key) {
    Ok(check) => println!(
      "key: ok · {} models · {:?}",
      check.models.len(),
      check.models.iter().take(8).collect::<Vec<_>>()
    ),
    Err(error) => {
      println!("key: {:?} · {}", error.reason, error.message);
      return;
    }
  }
  let audio = args.get(3).map(PathBuf::from);
  if account == Account::Deepgram {
    let Some(audio) = audio else { return };
    let started = std::time::Instant::now();
    let result = deepgram::transcribe(
      &config,
      &key,
      &audio,
      &DeepgramRequest {
        language: "ja".into(),
        diarize: true,
        keyterms: vec![],
      },
      Duration::from_secs(30 * 60),
      &StopSignal::new(),
    );
    match result {
      Ok(Some(result)) => println!(
        "deepgram: {:?} s · {} utterances · {} ms · first: {:?}",
        result.duration_sec,
        result.utterances.len(),
        started.elapsed().as_millis(),
        result.utterances.first().map(|utterance| &utterance.transcript)
      ),
      Ok(None) => println!("deepgram: stopped"),
      Err(error) => println!("deepgram: {:?} · {}", error.reason, error.message),
    }
    return;
  }
  let provider = match account {
    Account::Anthropic => ApiProvider::Anthropic,
    Account::OpenAi => ApiProvider::OpenAi,
    _ => ApiProvider::Gemini,
  };
  let model = args.get(1).cloned().unwrap_or_else(|| "claude-sonnet-4-6".into());
  let effort = args.get(2).and_then(|value| effort(value));
  let dir = std::env::temp_dir().join(format!("niho-api-ai-smoke-{}", std::process::id()));
  std::fs::create_dir_all(&dir).unwrap();
  let base = TurnRequest {
    provider,
    api_key: key,
    model,
    effort,
    system_prompt: "あなたは数を数える係です。説明や前置きは書かず、数だけを書きます。".into(),
    user_prompt: "一から三十までを漢数字で、1 行に 1 つずつ書いてください。".into(),
    resume_session: None,
    session_dir: dir.clone(),
    timeout: Duration::from_secs(10 * 60),
    // 上限で止まるか（思考も数えるので小さくしすぎない）
    max_output_tokens: 2_000,
    audio: None,
    tools: None,
  };
  if audio.as_deref() == Some(Path::new("chat")) {
    chat(&config, base, &dir);
    let _ = std::fs::remove_dir_all(dir);
    return;
  }
  if let (ApiProvider::Gemini, Some(audio)) = (provider, audio) {
    let event = turn(
      &config,
      TurnRequest {
        system_prompt: "あなたは録音を正確に書き起こす担当者です。".into(),
        user_prompt: "添付の音声を書き起こしてください。各段落を「[mm:ss] 話者N: 発言」の形で書いてください。".into(),
        audio: Some(audio),
        max_output_tokens: 65_535,
        ..base
      },
    );
    show("audio", &event);
    let _ = std::fs::remove_dir_all(dir);
    return;
  }
  let first = turn(&config, base.clone());
  let session = show("first", &first);
  if let Some(session) = session {
    let next = turn(
      &config,
      TurnRequest {
        user_prompt: "続けて、三十一から四十までを同じ形で書いてください。".into(),
        resume_session: Some(session),
        max_output_tokens: 4_000,
        ..base
      },
    );
    show("continued", &next);
  }
  let _ = std::fs::remove_dir_all(dir);
}
