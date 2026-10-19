//! 公開の型。名前は crate `niho-local-ai` と同じ意味にそろえる（Tauri の adapter が契約の型へ写す）。

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// API キー方式で工程を実行する提供元。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ApiProvider {
  /// Anthropic の Messages API（`/v1/messages`）。
  Anthropic,
  /// OpenAI の Responses API（`/v1/responses`）。
  OpenAi,
  /// Google の Gemini API（`models/{model}:streamGenerateContent`）。
  Gemini,
}

impl ApiProvider {
  /// 画面の文に入れる名前（AI の名前）。
  pub fn ai_label(self) -> &'static str {
    match self {
      ApiProvider::Anthropic => "Claude",
      ApiProvider::OpenAi => "GPT",
      ApiProvider::Gemini => "Gemini",
    }
  }

  pub fn account(self) -> Account {
    match self {
      ApiProvider::Anthropic => Account::Anthropic,
      ApiProvider::OpenAi => Account::OpenAi,
      ApiProvider::Gemini => Account::Gemini,
    }
  }

  pub(crate) fn as_str(self) -> &'static str {
    match self {
      ApiProvider::Anthropic => "anthropic",
      ApiProvider::OpenAi => "openai",
      ApiProvider::Gemini => "gemini",
    }
  }
}

/// 鍵の持ち主（Keychain の account の名前と同じ）。Deepgram は文字起こしだけ。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Account {
  Anthropic,
  OpenAi,
  Gemini,
  Deepgram,
}

impl Account {
  /// Keychain の account（`anthropic` / `openai` / `gemini` / `deepgram`）。
  pub fn as_str(self) -> &'static str {
    match self {
      Account::Anthropic => "anthropic",
      Account::OpenAi => "openai",
      Account::Gemini => "gemini",
      Account::Deepgram => "deepgram",
    }
  }

  pub fn parse(value: &str) -> Option<Self> {
    match value {
      "anthropic" => Some(Account::Anthropic),
      "openai" => Some(Account::OpenAi),
      "gemini" => Some(Account::Gemini),
      "deepgram" => Some(Account::Deepgram),
      _ => None,
    }
  }

  /// 画面の文に入れる提供元の名前。
  pub fn label(self) -> &'static str {
    match self {
      Account::Anthropic => "Anthropic",
      Account::OpenAi => "OpenAI",
      Account::Gemini => "Google Gemini",
      Account::Deepgram => "Deepgram",
    }
  }
}

/// 考える量（Claude は `output_config.effort`、GPT は `reasoning.effort`〔最大は xhigh〕、Gemini は `thinkingLevel`）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effort {
  Low,
  Medium,
  High,
  Max,
}

/// API キー。`Debug`・`Display` は中身を出さない（ログ・エラー文に混ざらないように）。
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
  pub fn new(value: impl Into<String>) -> Self {
    Self(value.into())
  }

  pub fn expose(&self) -> &str {
    &self.0
  }

  /// 末尾 4 文字（画面の「保存済み」に出す。短い鍵は出さない）。
  pub fn last4(&self) -> Option<String> {
    let chars: Vec<char> = self.0.chars().collect();
    (chars.len() >= 12).then(|| chars[chars.len() - 4..].iter().collect())
  }
}

impl fmt::Debug for Secret {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    f.write_str("Secret(••••)")
  }
}

/// 呼び先（既定は各社の本番。テストはローカルの偽のサーバーを渡す）。末尾の `/` は付けない。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoints {
  pub anthropic: String,
  pub openai: String,
  pub gemini: String,
  pub deepgram: String,
}

impl Default for Endpoints {
  fn default() -> Self {
    Self {
      anthropic: "https://api.anthropic.com".into(),
      openai: "https://api.openai.com".into(),
      gemini: "https://generativelanguage.googleapis.com".into(),
      deepgram: "https://api.deepgram.com".into(),
    }
  }
}

/// 診断ログ（種類と JSON）。鍵・指示文・本文・音声は渡さない（提供元のエラーの本文は鍵らしい文字列を伏せて 300 字まで）。
pub type LogFn = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

#[derive(Clone, Default)]
pub struct Config {
  pub endpoints: Endpoints,
  pub log: Option<LogFn>,
}

impl Config {
  pub(crate) fn log(&self, kind: &str, payload: serde_json::Value) {
    if let Some(log) = &self.log {
      log(kind, payload);
    }
  }
}

/// 1 回の依頼。
#[derive(Clone, Debug)]
pub struct TurnRequest {
  pub provider: ApiProvider,
  pub api_key: Secret,
  pub model: String,
  pub effort: Option<Effort>,
  /// 各 API の system（Claude の `system`・GPT の `instructions`・Gemini の `systemInstruction`）。
  pub system_prompt: String,
  /// ユーザー側の指示（続きは「続きを書いてください…」）。
  pub user_prompt: String,
  /// 続ける会話（前の `Done.session_id`）。会話の履歴は `session_dir` の下にあり、同じ会話として履歴ごと送る。
  pub resume_session: Option<String>,
  /// 会話の履歴の置き場（Tauri は app data の下の、実行ごとの workspace）。
  pub session_dir: PathBuf,
  pub timeout: Duration,
  /// 出力の上限（トークン。思考を含む）。上限で止まったら `StopReason::MaxTokens`。
  pub max_output_tokens: u32,
  /// 添える音声（Gemini だけ。Files API に上げて添え、終わったら消す。会話は残さない）。
  pub audio: Option<PathBuf>,
  /// 修正の会話の道具（ファイルを読む・直す）。None なら道具を渡さない（工程の実行・文字起こし）。
  pub tools: Option<FolderTools>,
}

/// 修正の会話で AI が触れるフォルダ（隔離 workspace）。`dir` の下だけを読み、`writable`（`dir` からの相対のフォルダ。例
/// `artifacts`）の下の `.md` だけを書ける。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderTools {
  pub dir: PathBuf,
  pub writable: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
  EndTurn,
  MaxTokens,
  Stopped,
}

/// 使用量（提供元が返した値。返らなければ 0 で `known` が false）。`model_used` は返った実際のモデル（無ければ依頼したモデル）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Usage {
  pub input_tokens: u64,
  pub output_tokens: u64,
  pub model_used: Option<String>,
  pub known: bool,
}

/// 失敗の理由（Tauri の adapter が契約の `ReasonCode` に写す）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
  /// 鍵が保存されていない。
  NotConfigured,
  /// 鍵が無効（401・403・Gemini の API_KEY_INVALID）。
  KeyInvalid,
  /// 利用上限・残高不足（429・402・insufficient_quota・credit balance）。
  UsageLimitReached,
  /// モデルが無い・使えない（404・モデルの指定の誤り）。
  ModelNotFound,
  /// 依頼を受け付けなかった（400 のうち鍵・モデル以外。送る量が多すぎるなど）。
  BadRequest,
  /// 断られた（安全上の理由）。
  Refused,
  /// 続ける会話の履歴が無い。
  SessionNotFound,
  /// 接続できない。
  Unreachable,
  /// 時間の上限。
  Timeout,
  /// 一時的な失敗（5xx・529・途中で切れた・壊れた返事）。
  TransientFailure,
}

impl Reason {
  pub fn as_str(self) -> &'static str {
    match self {
      Reason::NotConfigured => "not_configured",
      Reason::KeyInvalid => "key_invalid",
      Reason::UsageLimitReached => "usage_limit",
      Reason::ModelNotFound => "model_not_found",
      Reason::BadRequest => "bad_request",
      Reason::Refused => "refused",
      Reason::SessionNotFound => "session_not_found",
      Reason::Unreachable => "unreachable",
      Reason::Timeout => "timeout",
      Reason::TransientFailure => "transient",
    }
  }
}

/// 失敗（`message` は画面に出せる日本語。提供元の英語の文や鍵は入れない）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApiError {
  pub reason: Reason,
  pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TurnEvent {
  ThinkingDelta(String),
  TextDelta(String),
  /// 道具を呼んだ（修正の会話だけ）。`name` は画面の名前（Read・Edit・Write・Glob）、`summary` はファイル名だけ。
  ToolUse {
    id: String,
    name: String,
    summary: String,
  },
  /// 道具が終わった（成否だけ）。`id` で ToolUse と組にする。
  ToolResult {
    id: String,
    name: String,
    ok: bool,
  },
  /// 最後に 1 回だけ。止めたときも `StopReason::Stopped` の Done（`text` はそこまで）。道具を使った会話の `text` は
  /// 最後の往復の返答（それより前の文は TextDelta にだけ流れる）。使用量は全往復の和。
  Done {
    text: String,
    stop_reason: StopReason,
    session_id: Option<String>,
    usage: Usage,
    duration_ms: u64,
  },
  Error {
    reason: Reason,
    message: String,
  },
}

impl TurnEvent {
  pub fn is_terminal(&self) -> bool {
    matches!(self, TurnEvent::Done { .. } | TurnEvent::Error { .. })
  }
}

/// 鍵を確かめた結果（`models` は返ったモデルの ID。工程に使える種類だけ）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyCheck {
  pub models: Vec<String>,
}

/// Deepgram の依頼（リクエストの組み立ては NIHO 本体の写し: nova-3・smart_format=false・punctuate・diarize_model=latest・
/// utterances・paragraphs=false・keyterm の繰り返し）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeepgramRequest {
  /// "ja" | "en"
  pub language: String,
  pub diarize: bool,
  pub keyterms: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DeepgramUtterance {
  pub start: f64,
  pub end: f64,
  pub speaker: Option<u32>,
  pub transcript: String,
}

/// Deepgram の結果（音声 1 つ）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DeepgramResult {
  pub duration_sec: Option<f64>,
  pub utterances: Vec<DeepgramUtterance>,
  /// utterances が無いときの全文。
  pub transcript: String,
}
