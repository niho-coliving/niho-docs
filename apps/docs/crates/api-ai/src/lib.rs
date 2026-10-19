//! NIHO docs の API キー方式の実行基盤（Issue #18383 の S2b・spec §6.1）。Tauri に依存しない。
//!
//! - 工程の実行: Anthropic Messages API・OpenAI Responses API・Gemini API（streamGenerateContent）を SSE の stream で呼び、
//!   [`TurnEvent`]（ThinkingDelta・TextDelta・Done・Error。crate `niho-local-ai` と同じ意味）に直す。工程の実行・文字起こしは
//!   道具を渡さない。出力の上限で止まったら `StopReason::MaxTokens`。続きは会話の履歴（`session_dir` の下）ごと同じ会話として
//!   送る。
//! - 修正の会話（S5 #18386。[`TurnRequest::tools`]）: 隔離 workspace の中だけを読み、`writable` の下の `.md` だけを書ける
//!   4 つの道具（list_files・read_file・edit_file・write_file。アプリが実行する）を渡し、道具の呼び出しの無い応答まで往復する
//!   （`ToolUse`・`ToolResult` を流す。最大 40 往復）。
//! - 文字起こし: Gemini は区切りの WAV を Files API に上げて添える（[`TurnRequest::audio`]）、Deepgram は録音を同期で送る
//!   （[`deepgram::transcribe`]）。
//! - 鍵: 呼ぶ側（Tauri の adapter）が macOS Keychain から読んで [`Secret`] で渡す。この crate は鍵を保存しない。鍵はヘッダーだけに
//!   付け（URL に入れない）、ログ・エラー文・会話の履歴に入れない（提供元のエラーの本文に鍵らしい文字列があれば伏せる）。
//! - 失敗の理由（[`Reason`]）は Tauri の adapter が契約の `ReasonCode` に写す（鍵が無効 → ログインの代わりの文）。
//!
//! 依存は apps/docs の Cargo.lock に既にある reqwest（rustls・ring）・tokio だけ。

pub mod deepgram;
mod http;
mod keys;
mod providers;
mod sse;
mod tools;
mod turn;
mod types;

pub use http::{classify_status, reason_message, redact};
pub use keys::check_key;
pub use turn::{run_turn, running_turns, StopSignal, TurnHandle};
pub use types::{
  Account, ApiError, ApiProvider, Config, DeepgramRequest, DeepgramResult, DeepgramUtterance, Effort, Endpoints,
  FolderTools, KeyCheck, LogFn, Reason, Secret, StopReason, TurnEvent, TurnRequest, Usage,
};

/// 出力の上限（トークン。思考を含む）。上限で止まったらアプリが同じ会話で続きを頼む（spec §5.4）。
pub fn default_max_output_tokens(provider: ApiProvider) -> u32 {
  match provider {
    ApiProvider::Anthropic => 64_000,
    ApiProvider::OpenAi => 64_000,
    // NIHO の Gemini の文字起こしと同じ（思考のトークンも数える）
    ApiProvider::Gemini => 65_535,
  }
}
