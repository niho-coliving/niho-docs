//! 1 回の依頼を別のスレッドで動かす（そのスレッドだけの tokio の runtime で HTTP の stream を読む）。
//!
//! - 最後のイベントは必ず `Done` か `Error` の 1 つ。止めたら `Done { stop_reason: Stopped }`（本文はそこまで）。
//! - 時間の上限は `TurnRequest.timeout`（音声の上げ下ろしを含む）。
//! - 会話の履歴（続き用）: 上限で止まった・終わった回の ユーザーの指示 と 返事 を `session_dir/api-session-<id>.json`（0600）に
//!   足し、`Done.session_id` で返す。続きは同じ id を `resume_session` で渡すと、履歴ごと同じ会話として送る（3 社とも
//!   サーバーに会話を残さない）。履歴が無ければ `SessionNotFound`（呼ぶ側が「ここまでの出力を添えて新しい実行」に切り替える）。
//!   音声を添えた回は履歴を残さない。
//! - 音声（Gemini）: Files API に上げ（resumable）、ACTIVE になるのを待って添え、終わったら（失敗・停止でも）消す。
//! - 修正の会話（`TurnRequest.tools`）: 応答が道具の呼び出しで終わったら、呼び出しごとに `ToolUse` → 実行 → `ToolResult` を
//!   流し、応答と結果を会話に足して次の依頼を送る。呼び出しの無い応答で `Done`（`text` は最後の往復の返答、使用量は全往復の
//!   和）。40 往復で止める（TransientFailure）。止める合図・時間の上限は往復の間も効く。履歴には道具の往復を各社のそのままの
//!   形で残し、続きはそれごと送る。

use crate::http::{self, classify_status, error, error_summary, transport_reason};
use crate::providers::{self, BuildInput, Collected, FileRef, Message, Role};
use crate::sse::SseParser;
use crate::tools::{self, Outcome};
use crate::types::{ApiError, ApiProvider, Config, Reason, StopReason, TurnEvent, TurnRequest, Usage};
use serde_json::json;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::task::Poll;
use std::time::{Duration, Instant};

static RUNNING: AtomicUsize = AtomicUsize::new(0);

/// 実行中の依頼の数（API キー方式。アプリはログインなどの前と終了時に見る）。
pub fn running_turns() -> usize {
  RUNNING.load(Ordering::SeqCst)
}

/// 止める合図（どのスレッドからでも）。
#[derive(Default)]
pub struct StopSignal {
  stopped: AtomicBool,
  notify: tokio::sync::Notify,
}

impl StopSignal {
  pub fn new() -> Arc<Self> {
    Arc::new(Self::default())
  }

  pub fn stop(&self) {
    self.stopped.store(true, Ordering::SeqCst);
    self.notify.notify_waiters();
  }

  pub fn is_stopped(&self) -> bool {
    self.stopped.load(Ordering::SeqCst)
  }

  pub(crate) async fn wait(&self) {
    loop {
      let notified = self.notify.notified();
      if self.is_stopped() {
        return;
      }
      notified.await;
    }
  }
}

pub(crate) enum Raced<T> {
  Done(T),
  Stopped,
}

/// `work` と止める合図のどちらか早いほう（止めたら `work` は捨てる＝接続を切る）。
pub(crate) async fn or_stop<F: Future>(work: F, stop: &StopSignal) -> Raced<F::Output> {
  let mut work = pin!(work);
  let mut stopped = pin!(stop.wait());
  std::future::poll_fn(move |cx| {
    if let Poll::Ready(()) = stopped.as_mut().poll(cx) {
      return Poll::Ready(Raced::Stopped);
    }
    if let Poll::Ready(value) = work.as_mut().poll(cx) {
      return Poll::Ready(Raced::Done(value));
    }
    Poll::Pending
  })
  .await
}

pub(crate) fn runtime() -> Result<tokio::runtime::Runtime, ApiError> {
  tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .map_err(|_| ApiError {
      reason: Reason::TransientFailure,
      message: "通信の準備ができませんでした。NIHO docs を開き直してから、もう一度お試しください。".into(),
    })
}

struct Shared {
  stop: Arc<StopSignal>,
  finished: Mutex<bool>,
  done: Condvar,
}

/// 実行中の 1 回。
#[derive(Clone)]
pub struct TurnHandle {
  shared: Arc<Shared>,
}

impl TurnHandle {
  pub fn stop(&self) {
    self.shared.stop.stop();
  }

  pub fn is_finished(&self) -> bool {
    self.shared.finished.lock().map(|done| *done).unwrap_or(true)
  }

  /// 最後のイベントを渡し終えるまで待つ。
  pub fn wait(&self) {
    let Ok(mut done) = self.shared.finished.lock() else {
      return;
    };
    while !*done {
      match self.shared.done.wait(done) {
        Ok(next) => done = next,
        Err(_) => return,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 会話の履歴

const SESSION_PREFIX: &str = "api-session-";

#[derive(serde::Serialize, serde::Deserialize)]
struct SessionFile {
  provider: String,
  model: String,
  messages: Vec<Message>,
}

fn session_path(dir: &Path, id: &str) -> Option<PathBuf> {
  let ok = !id.is_empty()
    && id.len() <= 64
    && id
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
  ok.then(|| dir.join(format!("{SESSION_PREFIX}{id}.json")))
}

fn new_session_id() -> String {
  let mut bytes = [0u8; 12];
  let filled = std::fs::File::open("/dev/urandom")
    .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut bytes))
    .is_ok();
  if !filled {
    let now = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|elapsed| elapsed.as_nanos())
      .unwrap_or_default();
    bytes.copy_from_slice(&now.to_le_bytes()[..12]);
  }
  let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
  format!("api_{hex}")
}

fn load_session(dir: &Path, id: &str, provider: ApiProvider) -> Option<SessionFile> {
  let path = session_path(dir, id)?;
  let text = std::fs::read_to_string(path).ok()?;
  let session: SessionFile = serde_json::from_str(&text).ok()?;
  (session.provider == provider.as_str()).then_some(session)
}

fn save_session(dir: &Path, id: &str, session: &SessionFile) -> std::io::Result<()> {
  let path = session_path(dir, id).ok_or_else(|| std::io::Error::other("bad session id"))?;
  let temp = dir.join(format!(".{SESSION_PREFIX}{id}.tmp"));
  let text = serde_json::to_vec(session).map_err(std::io::Error::other)?;
  {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temp)?;
    file.write_all(&text)?;
    file.sync_all()?;
  }
  std::fs::rename(temp, path)
}

// ---------------------------------------------------------------------------
// 音声（Gemini の Files API）

const UPLOAD_STATE_WAIT: Duration = Duration::from_secs(120);

struct Uploaded {
  name: String,
  file: FileRef,
}

fn audio_mime(path: &Path) -> &'static str {
  match path
    .extension()
    .and_then(|ext| ext.to_str())
    .map(str::to_ascii_lowercase)
    .as_deref()
  {
    Some("wav") => "audio/wav",
    Some("mp3") => "audio/mp3",
    Some("m4a") | Some("mp4") | Some("aac") => "audio/aac",
    Some("flac") => "audio/flac",
    Some("ogg") | Some("oga") => "audio/ogg",
    _ => "audio/wav",
  }
}

fn valid_file_name(name: &str) -> bool {
  name
    .strip_prefix("files/")
    .is_some_and(|id| !id.is_empty() && id.len() <= 128 && id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-'))
}

async fn read_error(config: &Config, response: reqwest::Response, kind: &str, key: &str) -> Reason {
  let status = response.status().as_u16();
  let body = read_limited(response, 64 * 1024).await;
  let reason = classify_status(status, &body);
  config.log(
    kind,
    json!({ "status": status, "reason": reason.as_str(), "error": error_summary(&body, &[key]) }),
  );
  reason
}

pub(crate) async fn read_limited(mut response: reqwest::Response, limit: usize) -> String {
  let mut bytes = Vec::new();
  while let Ok(Some(chunk)) = response.chunk().await {
    bytes.extend_from_slice(&chunk);
    if bytes.len() >= limit {
      bytes.truncate(limit);
      break;
    }
  }
  String::from_utf8_lossy(&bytes).into_owned()
}

async fn upload_audio(config: &Config, client: &reqwest::Client, key: &str, path: &Path) -> Result<Uploaded, Reason> {
  let base = &config.endpoints.gemini;
  let bytes = tokio::fs::read(path).await.map_err(|_| Reason::TransientFailure)?;
  let mime = audio_mime(path);
  let start = client
    .post(format!("{base}/upload/v1beta/files"))
    .header("x-goog-api-key", key)
    .header("X-Goog-Upload-Protocol", "resumable")
    .header("X-Goog-Upload-Command", "start")
    .header("X-Goog-Upload-Header-Content-Length", bytes.len().to_string())
    .header("X-Goog-Upload-Header-Content-Type", mime)
    .header("Content-Type", "application/json")
    .body(json!({ "file": { "display_name": "niho-docs-audio-part" } }).to_string())
    .send()
    .await
    .map_err(|error| transport_reason(&error))?;
  if !start.status().is_success() {
    return Err(read_error(config, start, "gemini_upload_failed", key).await);
  }
  let upload_url = start
    .headers()
    .get("x-goog-upload-url")
    .and_then(|value| value.to_str().ok())
    .map(str::to_string)
    .filter(|url| url.starts_with(&format!("{base}/")))
    .ok_or(Reason::TransientFailure)?;
  // 上げ先の URL は upload_id で決まる（鍵は付けない）
  let uploaded = client
    .post(upload_url)
    .header("X-Goog-Upload-Offset", "0")
    .header("X-Goog-Upload-Command", "upload, finalize")
    .body(bytes)
    .send()
    .await
    .map_err(|error| transport_reason(&error))?;
  if !uploaded.status().is_success() {
    return Err(read_error(config, uploaded, "gemini_upload_failed", key).await);
  }
  let body: serde_json::Value =
    serde_json::from_str(&read_limited(uploaded, 64 * 1024).await).map_err(|_| Reason::TransientFailure)?;
  let mut file = body.get("file").cloned().unwrap_or(serde_json::Value::Null);
  let name = file
    .get("name")
    .and_then(|value| value.as_str())
    .filter(|name| valid_file_name(name))
    .map(str::to_string)
    .ok_or(Reason::TransientFailure)?;
  let waited = Instant::now();
  loop {
    match file.get("state").and_then(|value| value.as_str()).unwrap_or("ACTIVE") {
      "ACTIVE" => break,
      "FAILED" => {
        delete_audio(config, client, key, &name).await;
        return Err(Reason::TransientFailure);
      }
      _ => {}
    }
    if waited.elapsed() > UPLOAD_STATE_WAIT {
      delete_audio(config, client, key, &name).await;
      return Err(Reason::TransientFailure);
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    let response = client
      .get(format!("{base}/v1beta/{name}"))
      .header("x-goog-api-key", key)
      .send()
      .await
      .map_err(|error| transport_reason(&error))?;
    if !response.status().is_success() {
      let reason = read_error(config, response, "gemini_file_state_failed", key).await;
      delete_audio(config, client, key, &name).await;
      return Err(reason);
    }
    file = serde_json::from_str(&read_limited(response, 64 * 1024).await).unwrap_or(serde_json::Value::Null);
  }
  let uri = file
    .get("uri")
    .and_then(|value| value.as_str())
    .map(str::to_string)
    .ok_or(Reason::TransientFailure)?;
  Ok(Uploaded {
    name,
    file: FileRef {
      uri,
      mime_type: mime.to_string(),
    },
  })
}

async fn delete_audio(config: &Config, client: &reqwest::Client, key: &str, name: &str) {
  if !valid_file_name(name) {
    return;
  }
  let result = client
    .delete(format!("{}/v1beta/{name}", config.endpoints.gemini))
    .header("x-goog-api-key", key)
    .send()
    .await;
  let ok = matches!(&result, Ok(response) if response.status().is_success());
  config.log("gemini_file_deleted", json!({ "ok": ok }));
}

// ---------------------------------------------------------------------------

/// 道具の往復の上限（依頼の数）。
const MAX_TOOL_ROUNDS: u32 = 40;
const TOOL_ROUNDS_MESSAGE: &str =
  "AI がファイルの読み書きを 40 回くり返しても終わらなかったため止めました。頼む範囲を小さく分けて、もう一度お試しください。";

/// 終わった往復の使用量の和。
#[derive(Default)]
struct Spent {
  input_tokens: u64,
  output_tokens: u64,
  seen: bool,
  model: Option<String>,
}

struct Work<'a> {
  config: &'a Config,
  request: &'a TurnRequest,
  /// 送る会話（道具の往復を足していく）。
  messages: Vec<Message>,
  /// 今の往復で届いたもの。
  collected: Collected,
  spent: Spent,
  /// 送った依頼の数。
  rounds: u32,
  uploaded: Option<String>,
  /// 理由ごとの文の代わりに出す文（道具の往復の上限）。
  message: Option<String>,
}

impl Work<'_> {
  /// 全往復の使用量の和。
  fn usage(&self) -> Usage {
    let mut usage = self
      .collected
      .usage(self.spent.model.as_deref().unwrap_or(&self.request.model));
    usage.input_tokens += self.spent.input_tokens;
    usage.output_tokens += self.spent.output_tokens;
    usage.known |= self.spent.seen;
    usage
  }

  fn add_round_usage(&mut self) {
    let current = &self.collected;
    self.spent.input_tokens += current.input_tokens;
    self.spent.output_tokens += current.output_tokens;
    self.spent.seen |= current.usage_seen;
    if current.model.is_some() {
      self.spent.model = current.model.clone();
    }
  }
}

/// 1 往復: 今の会話を送り、SSE を `work.collected` に足す。
async fn stream_round(
  work: &mut Work<'_>,
  client: &reqwest::Client,
  file: Option<&FileRef>,
  emit: &mut dyn FnMut(TurnEvent),
) -> Result<(), Reason> {
  let request = work.request;
  let key = request.api_key.expose();
  let built = providers::build(
    request.provider,
    &work.config.endpoints,
    &BuildInput {
      model: &request.model,
      effort: request.effort,
      system_prompt: &request.system_prompt,
      messages: &work.messages,
      max_output_tokens: request.max_output_tokens,
      file,
      tools: request.tools.as_ref(),
    },
  )?;
  let call = client
    .post(built.url)
    .header("Content-Type", "application/json")
    .header("Accept", "text/event-stream")
    .body(built.body.to_string());
  let mut response = providers::authorize(request.provider, call, &request.api_key)
    .send()
    .await
    .map_err(|error| transport_reason(&error))?;
  if !response.status().is_success() {
    return Err(read_error(work.config, response, "api_turn_failed", key).await);
  }
  let mut parser = SseParser::default();
  let provider = request.provider;
  loop {
    let chunk = match response.chunk().await {
      Ok(Some(chunk)) => chunk,
      Ok(None) => break,
      Err(error) => {
        let reason = transport_reason(&error);
        // 途中で切れた（返事は来ていた）
        return Err(if reason == Reason::Unreachable {
          Reason::TransientFailure
        } else {
          reason
        });
      }
    };
    for event in parser.push(&chunk) {
      providers::apply(provider, &event, &mut work.collected, emit);
      if work.collected.error.is_some() {
        return Ok(());
      }
    }
    if work.collected.finished {
      return Ok(());
    }
  }
  if let Some(event) = parser.finish() {
    providers::apply(provider, &event, &mut work.collected, emit);
  }
  Ok(())
}

/// 依頼を送る。道具を渡したときは、応答が道具の呼び出しで終わるたびに道具を動かして結果を返し、呼び出しの無い応答まで続ける。
async fn drive(work: &mut Work<'_>, client: &reqwest::Client, emit: &mut dyn FnMut(TurnEvent)) -> Result<(), Reason> {
  let request = work.request;
  let key = request.api_key.expose();
  let mut file = None;
  if let Some(audio) = &request.audio {
    if request.provider != ApiProvider::Gemini || request.tools.is_some() {
      return Err(Reason::BadRequest);
    }
    let uploaded = upload_audio(work.config, client, key, audio).await?;
    work.uploaded = Some(uploaded.name.clone());
    file = Some(uploaded.file);
  }
  loop {
    work.rounds += 1;
    work.collected = Collected::default();
    stream_round(work, client, file.as_ref(), emit).await?;
    let Some(tools) = &request.tools else {
      return Ok(());
    };
    providers::finish_round(request.provider, &mut work.collected, work.rounds);
    let collected = &work.collected;
    // 道具の呼び出しの無い応答・失敗・出力の上限で終わり（上限のときの呼び出しは動かさない）
    if collected.error.is_some() || collected.stop != Some(StopReason::EndTurn) || collected.calls.is_empty() {
      return Ok(());
    }
    if work.rounds >= MAX_TOOL_ROUNDS {
      work.message = Some(TOOL_ROUNDS_MESSAGE.into());
      return Err(Reason::TransientFailure);
    }
    let calls = std::mem::take(&mut work.collected.calls);
    work.messages.push(Message {
      role: Role::Assistant,
      text: work.collected.text.clone(),
      raw: Some(std::mem::take(&mut work.collected.output)),
    });
    let mut results = Vec::with_capacity(calls.len());
    for call in calls {
      let name = tools::display_name(&call.name);
      emit(TurnEvent::ToolUse {
        id: call.id.clone(),
        name: name.clone(),
        summary: tools::summary(&call.name, &call.input),
      });
      let outcome = tools::run(tools, &call);
      // 文書に鍵が書かれていても、モデル・履歴へ送らない
      let outcome = Outcome {
        ok: outcome.ok,
        text: http::hide_secrets(&outcome.text, &[key]),
      };
      work.config.log(
        "api_tool",
        json!({ "provider": request.provider.as_str(), "name": name, "ok": outcome.ok }),
      );
      emit(TurnEvent::ToolResult {
        id: call.id.clone(),
        name,
        ok: outcome.ok,
      });
      results.push((call, outcome));
      // 止める合図をここでも見る（止めたら残りの道具を動かさない）
      tokio::task::yield_now().await;
    }
    work.messages.push(providers::tool_results(request.provider, &results));
    work.add_round_usage();
  }
}

/// 1 回実行する（すぐに戻る。イベントは別のスレッドから届く）。
pub fn run_turn(config: &Config, request: TurnRequest, on_event: impl FnMut(TurnEvent) + Send + 'static) -> TurnHandle {
  let shared = Arc::new(Shared {
    stop: StopSignal::new(),
    finished: Mutex::new(false),
    done: Condvar::new(),
  });
  let handle = TurnHandle { shared: shared.clone() };
  let config = config.clone();
  RUNNING.fetch_add(1, Ordering::SeqCst);
  std::thread::spawn(move || {
    let mut on_event = on_event;
    let event = execute(&config, &request, &shared.stop, &mut on_event);
    on_event(event);
    RUNNING.fetch_sub(1, Ordering::SeqCst);
    if let Ok(mut done) = shared.finished.lock() {
      *done = true;
    }
    shared.done.notify_all();
  });
  handle
}

fn execute(
  config: &Config,
  request: &TurnRequest,
  stop: &StopSignal,
  on_event: &mut (dyn FnMut(TurnEvent) + Send),
) -> TurnEvent {
  let started = Instant::now();
  let account = request.provider.account();
  let fail = |reason: Reason| TurnEvent::Error {
    reason,
    message: http::reason_message(reason, account),
  };
  if request.api_key.expose().trim().is_empty() {
    return fail(Reason::NotConfigured);
  }
  // 続き: 履歴（道具の往復を含む）を読んで同じ会話として送る
  let mut history = Vec::new();
  let mut session_id = None;
  if let Some(id) = &request.resume_session {
    match load_session(&request.session_dir, id, request.provider) {
      Some(session) => {
        history = session.messages;
        session_id = Some(id.clone());
      }
      None => return fail(Reason::SessionNotFound),
    }
  }
  let mut messages = history;
  messages.push(Message::text(Role::User, request.user_prompt.clone()));
  let runtime = match runtime() {
    Ok(runtime) => runtime,
    Err(error) => {
      return TurnEvent::Error {
        reason: error.reason,
        message: error.message,
      }
    }
  };
  let client = match runtime.block_on(async { http::client() }) {
    Ok(client) => client,
    Err(error) => {
      return TurnEvent::Error {
        reason: error.reason,
        message: error.message,
      }
    }
  };
  config.log(
    "api_turn_started",
    json!({ "provider": request.provider.as_str(), "model": request.model, "resume": request.resume_session.is_some(), "audio": request.audio.is_some(), "tools": request.tools.is_some() }),
  );
  let mut work = Work {
    config,
    request,
    messages,
    collected: Collected::default(),
    spent: Spent::default(),
    rounds: 0,
    uploaded: None,
    message: None,
  };
  let outcome = runtime.block_on(async {
    let mut emit = |event: TurnEvent| on_event(event);
    or_stop(
      tokio::time::timeout(request.timeout, drive(&mut work, &client, &mut emit)),
      stop,
    )
    .await
  });
  // 上げた音声は、結果に依らず消す
  if let Some(name) = work.uploaded.take() {
    let key = request.api_key.expose().to_string();
    runtime.block_on(async {
      let _ = tokio::time::timeout(Duration::from_secs(15), delete_audio(config, &client, &key, &name)).await;
    });
  }
  let duration_ms = started.elapsed().as_millis() as u64;
  let usage = work.usage();
  let collected = &work.collected;
  let result = match outcome {
    Raced::Stopped => {
      config.log(
        "api_turn_stopped",
        json!({ "provider": request.provider.as_str(), "rounds": work.rounds }),
      );
      return TurnEvent::Done {
        text: collected.text.clone(),
        stop_reason: StopReason::Stopped,
        session_id: None,
        usage,
        duration_ms,
      };
    }
    Raced::Done(Err(_elapsed)) => Err(Reason::Timeout),
    Raced::Done(Ok(Err(reason))) => Err(reason),
    Raced::Done(Ok(Ok(()))) => match (&collected.error, collected.stop) {
      (Some((reason, detail)), _) => {
        config.log(
          "api_turn_failed",
          json!({ "reason": reason.as_str(), "detail": http::redact(detail, &[request.api_key.expose()]) }),
        );
        Err(*reason)
      }
      (None, Some(stop)) => Ok(stop),
      // 終わりの合図が無いまま流れが切れた
      (None, None) => Err(Reason::TransientFailure),
    },
  };
  let stop_reason = match result {
    Ok(stop) => stop,
    Err(reason) => {
      config.log(
        "api_turn_ended",
        json!({ "provider": request.provider.as_str(), "reason": reason.as_str(), "durationMs": duration_ms, "rounds": work.rounds }),
      );
      return match work.message.take() {
        Some(message) => TurnEvent::Error { reason, message },
        None => fail(reason),
      };
    }
  };
  // 続きに使う履歴（音声を添えた回は残さない）
  if request.audio.is_none() {
    let id = session_id.unwrap_or_else(new_session_id);
    let mut messages = work.messages.clone();
    if request.tools.is_some() {
      // 道具の会話は応答をそのままの形で残す（思考の署名などを次の依頼で返す）。上限で止まった回の呼び出しは結果が無いので除く
      let mut output = collected.output.clone();
      if stop_reason == StopReason::MaxTokens {
        output = providers::without_calls(request.provider, output);
      }
      if !output.is_empty() {
        messages.push(Message {
          role: Role::Assistant,
          text: collected.text.clone(),
          raw: Some(output),
        });
      }
    } else if !collected.text.is_empty() {
      // 本文が空の返事は送れない（Anthropic）ので足さない（次の指示は続けてユーザーの発言になる）
      messages.push(Message::text(Role::Assistant, collected.text.clone()));
    }
    let saved = save_session(
      &request.session_dir,
      &id,
      &SessionFile {
        provider: request.provider.as_str().into(),
        model: request.model.clone(),
        messages,
      },
    )
    .is_ok();
    config.log(
      "api_turn_ended",
      json!({ "provider": request.provider.as_str(), "stop": format!("{stop_reason:?}"), "durationMs": duration_ms, "rounds": work.rounds, "sessionSaved": saved }),
    );
    return TurnEvent::Done {
      text: collected.text.clone(),
      stop_reason,
      session_id: saved.then_some(id),
      usage,
      duration_ms,
    };
  }
  config.log(
    "api_turn_ended",
    json!({ "provider": request.provider.as_str(), "stop": format!("{stop_reason:?}"), "durationMs": duration_ms }),
  );
  TurnEvent::Done {
    text: collected.text.clone(),
    stop_reason,
    session_id: None,
    usage,
    duration_ms,
  }
}

/// `error()` を外から使う（keys・deepgram）。
pub(crate) fn api_error(reason: Reason, account: crate::types::Account) -> ApiError {
  error(reason, account)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sessions_round_trip_and_reject_odd_ids() {
    let dir = std::env::temp_dir().join(format!("niho-api-ai-session-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let id = new_session_id();
    assert!(id.starts_with("api_") && id.len() == 28, "{id}");
    let session = SessionFile {
      provider: "anthropic".into(),
      model: "claude-sonnet-4-6".into(),
      messages: vec![Message::text(Role::User, "a")],
    };
    save_session(&dir, &id, &session).unwrap();
    assert_eq!(
      load_session(&dir, &id, ApiProvider::Anthropic).unwrap().messages,
      session.messages
    );
    assert!(load_session(&dir, &id, ApiProvider::OpenAi).is_none());
    assert!(session_path(&dir, "../x").is_none());
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      let mode = std::fs::metadata(session_path(&dir, &id).unwrap())
        .unwrap()
        .permissions()
        .mode();
      assert_eq!(mode & 0o777, 0o600);
    }
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn file_names_and_audio_types() {
    assert!(valid_file_name("files/abc-123"));
    assert!(!valid_file_name("files/../x"));
    assert!(!valid_file_name("models/x"));
    assert_eq!(audio_mime(Path::new("/tmp/f0-p1.wav")), "audio/wav");
  }
}
