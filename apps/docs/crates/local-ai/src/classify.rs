//! 失敗の理由の判定（上限到達・未ログイン・会話なし・モデル名違い）と、画面に出す文。
//! 上限・未ログインの文字列の規則は Desktop の記事エージェント（＝ API の article-authoring-runtime-reason-code.ts）と同じ。

use crate::types::{Provider, ReasonCode, TurnEvent};

pub(crate) const MAX_BUDGET_MESSAGE: &str = "1 回の費用の上限に達しました。";
pub(crate) const REFUSAL_MESSAGE: &str = "AI が応答を断りました。指示や資料を見直してください。";
pub(crate) const CODEX_INCOMPLETE_MESSAGE: &str =
  "出力が長すぎて途中で止まりました。この AI は続きを書けないので、分けて実行するか別の AI を選んでください。";
pub(crate) const CODEX_OUTDATED_MESSAGE: &str =
  "このMacの Codex CLI が古いため実行できません。Codex CLI を最新版に更新してから、もう一度実行してください。";
pub(crate) const AGY_MODEL_MESSAGE: &str =
  "Antigravity CLI でこのモデルと思考量の組み合わせを使えません。設定のモデルを確かめてください。";

/// 理由ごとの画面に出す文（個別の文が無いとき）。
pub(crate) fn reason_message(provider: Provider, code: ReasonCode) -> String {
  let label = provider.label();
  match code {
    ReasonCode::CliLoginRequired => format!("このMacの {label} にログインしてください。"),
    ReasonCode::UsageLimitReached => format!("このMacの {label} の利用上限に達しました。"),
    ReasonCode::NotConfigured => format!("このMacで {label} を起動できませんでした。"),
    ReasonCode::Unreachable => format!("このMacの {label} に接続できませんでした。"),
    ReasonCode::SessionNotFound => "このMacに会話の続きが見つかりませんでした。".to_string(),
    ReasonCode::TransientFailure => format!("{label} の実行に失敗しました。"),
    ReasonCode::ModelNotFound => format!("{label} でこのモデルを使えません。設定のモデルを確かめてください。"),
    ReasonCode::TimedOut => format!("{label} が時間内に終わらなかったため止めました。"),
  }
}

/// Error のイベント。`message` が無ければ理由ごとの文にする。
pub(crate) fn error_event(provider: Provider, code: ReasonCode, message: Option<&str>) -> TurnEvent {
  TurnEvent::Error {
    reason_code: code,
    message: message
      .map(str::to_string)
      .unwrap_or_else(|| reason_message(provider, code)),
  }
}

// ---------------------------------------------------------------------------
// 文字列の規則（Desktop と同じ）

pub(crate) fn normalize_for_match(text: &str) -> String {
  text
    .replace('\u{2019}', "'")
    .replace('`', "")
    .to_lowercase()
    .split_whitespace()
    .collect::<Vec<_>>()
    .join(" ")
}

fn is_word_char(ch: char) -> bool {
  ch.is_alphanumeric() || ch == '_'
}

fn has_word_boundary_after(text: &str, prefix_len: usize) -> bool {
  text[prefix_len..].chars().next().is_none_or(|ch| !is_word_char(ch))
}

/// 単語として含むか（前後が英数字・`_` でない）。"401" が "14012 tokens" に当たらないように数字の判定にも使う。
pub(crate) fn contains_word(text: &str, word: &str) -> Option<usize> {
  let mut offset = 0;
  while let Some(found) = text[offset..].find(word) {
    let start = offset + found;
    let end = start + word.len();
    let before_ok = text[..start].chars().next_back().is_none_or(|ch| !is_word_char(ch));
    let after_ok = text[end..].chars().next().is_none_or(|ch| !is_word_char(ch));
    if before_ok && after_ok {
      return Some(start);
    }
    offset = end;
  }
  None
}

/// USAGE_LIMIT_MESSAGE_PATTERN（エラー文の部分一致）
pub(crate) fn is_usage_limit_message(text: &str) -> bool {
  let normalized = normalize_for_match(text);
  if let Some(index) = normalized.find("hit your ") {
    if contains_word(&normalized[index..], "limit").is_some() {
      return true;
    }
  }
  if let Some(index) = contains_word(&normalized, "limit") {
    let after = &normalized[index..];
    if ["reach", "reached"]
      .iter()
      .any(|word| contains_word(after, word).is_some())
    {
      return true;
    }
  }
  ["weekly", "session", "5-hour", "hourly", "daily", "monthly", "usage"]
    .iter()
    .any(|word| normalized.contains(&format!("{word} limit")))
}

fn is_usage_limit_notice_line(line: &str) -> bool {
  let lower = normalize_for_match(line);
  for prefix in ["you've hit your ", "you've reached your "] {
    if let Some(rest) = lower.strip_prefix(prefix) {
      for word in rest.split(' ') {
        if let Some(after) = word.strip_prefix("limit") {
          if after.chars().next().is_none_or(|ch| !is_word_char(ch)) {
            return true;
          }
        }
        if word.is_empty() || !word.chars().all(|ch| is_word_char(ch) || ch == '-') {
          break;
        }
      }
      return false;
    }
  }
  for prefix in ["you're out of usage", "you're out of extra usage"] {
    if lower.starts_with(prefix) && has_word_boundary_after(&lower, prefix.len()) {
      return true;
    }
  }
  let stripped = lower
    .strip_prefix("claude ai ")
    .or_else(|| lower.strip_prefix("claude "))
    .unwrap_or(lower.as_str());
  let phrase = "usage limit reached";
  if stripped.starts_with(phrase) && has_word_boundary_after(stripped, phrase.len()) {
    return true;
  }
  let periods = ["weekly", "session", "5-hour", "hourly", "daily", "monthly"];
  let candidates: Vec<&str> = match lower.split_once(' ') {
    Some((first, rest)) if first.chars().all(|ch| is_word_char(ch) || ch == '-') => vec![lower.as_str(), rest],
    _ => vec![lower.as_str()],
  };
  candidates.iter().any(|candidate| {
    periods.iter().any(|period| {
      let phrase = format!("{period} limit reached");
      candidate.starts_with(&phrase) && has_word_boundary_after(candidate, phrase.len())
    })
  })
}

/// 本文が上限到達の通知だけか（extractArticleAuthoringRuntimeUsageLimitNotice と同じ規則）。
pub(crate) fn is_usage_limit_notice_only(text: &str) -> bool {
  let lines: Vec<&str> = text.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
  !lines.is_empty()
    && lines
      .iter()
      .all(|line| line.chars().count() <= 300 && is_usage_limit_notice_line(line))
}

/// CLI_LOGIN_REQUIRED_MESSAGE_PATTERN
pub(crate) fn is_login_required_message(text: &str) -> bool {
  let normalized = normalize_for_match(text);
  [
    "please run /login",
    "please run/login",
    "not logged in",
    "run claude login",
    "invalid api key",
    "not authenticated",
    "authentication required",
    "log in again",
    "log in to claude",
    "log in to your account",
  ]
  .iter()
  .any(|needle| normalized.contains(needle))
}

pub(crate) fn is_session_not_found_message(text: &str) -> bool {
  normalize_for_match(text).contains("no conversation found")
}

// ---------------------------------------------------------------------------
// Claude Code

/// claude の result が失敗だったときの手がかり。
pub(crate) struct ClaudeErrorSignals<'a> {
  pub api_error_status: Option<u64>,
  /// `system/api_retry` の `error: authentication_failed` を見た
  pub auth_failed: bool,
  /// `rate_limit_event` の `status: rejected` を見た
  pub rate_limited: bool,
  /// assistant の行の `error`（"authentication_failed" | "model_not_found" | "rate_limit" …）
  pub assistant_errors: &'a [String],
  pub subtype: &'a str,
  /// result の本文・errors・error 付きの assistant の文をつないだもの
  pub text: &'a str,
}

/// claude の失敗した result の理由（上から順に見る）。2 つめは個別の文。
pub(crate) fn classify_claude_result(signals: &ClaudeErrorSignals) -> (ReasonCode, Option<&'static str>) {
  let has_error = |name: &str| signals.assistant_errors.iter().any(|error| error == name);
  if signals.api_error_status == Some(401) || signals.auth_failed || has_error("authentication_failed") {
    return (ReasonCode::CliLoginRequired, None);
  }
  if is_session_not_found_message(signals.text) {
    return (ReasonCode::SessionNotFound, None);
  }
  let normalized = normalize_for_match(signals.text);
  if has_error("model_not_found")
    || (signals.api_error_status == Some(404) && normalized.contains("model"))
    || normalized.contains("issue with the selected model")
  {
    return (ReasonCode::ModelNotFound, None);
  }
  if signals.rate_limited
    || signals.api_error_status == Some(429)
    || is_usage_limit_message(signals.text)
    || has_error("rate_limit")
  {
    return (ReasonCode::UsageLimitReached, None);
  }
  if is_login_required_message(signals.text) {
    return (ReasonCode::CliLoginRequired, None);
  }
  if signals.subtype == "error_max_budget_usd" {
    return (ReasonCode::TransientFailure, Some(MAX_BUDGET_MESSAGE));
  }
  (ReasonCode::TransientFailure, None)
}

/// result が出ないまま claude が終わったときの判定（stderr から）。Desktop の classify_process_failure に
/// モデル名違い（"issue with the selected model"・"unrecognized_model"）を足したもの。
pub(crate) fn classify_claude_process_failure(stderr: &str) -> ReasonCode {
  let normalized = normalize_for_match(stderr);
  if is_session_not_found_message(stderr) {
    ReasonCode::SessionNotFound
  } else if normalized.contains("issue with the selected model") || normalized.contains("unrecognized_model") {
    ReasonCode::ModelNotFound
  } else if is_usage_limit_message(stderr) {
    ReasonCode::UsageLimitReached
  } else if is_login_required_message(stderr) {
    ReasonCode::CliLoginRequired
  } else {
    ReasonCode::TransientFailure
  }
}

// ---------------------------------------------------------------------------
// Codex CLI

/// codex の失敗の理由（turn.failed の message・最後の error・stderr を合わせた文で、上から順に見る）。
pub(crate) fn classify_codex_failure(text: &str) -> (ReasonCode, Option<&'static str>) {
  let normalized = normalize_for_match(text);
  let has = |needle: &str| normalized.contains(needle);
  if has("no rollout found") || has("thread/resume failed") {
    return (ReasonCode::SessionNotFound, None);
  }
  if contains_word(&normalized, "401").is_some()
    || has("unauthorized")
    || has("not logged in")
    || is_login_required_message(text)
  {
    return (ReasonCode::CliLoginRequired, None);
  }
  if has("model is not supported") || has("model_not_found") || (has("does not exist") && has("model")) {
    return (ReasonCode::ModelNotFound, None);
  }
  if is_usage_limit_message(text)
    || has("usage_limit_reached")
    || contains_word(&normalized, "429").is_some()
    || has("too many requests")
  {
    return (ReasonCode::UsageLimitReached, None);
  }
  if has("incomplete response returned") {
    return (ReasonCode::TransientFailure, Some(CODEX_INCOMPLETE_MESSAGE));
  }
  if has("not inside a trusted directory") {
    return (ReasonCode::NotConfigured, None);
  }
  // 古い codex は crate が切る機能の名前を知らずに起動しない（0.151.0 の「Unknown feature flag: sleep_tool」）
  if has("unknown feature flag") {
    return (ReasonCode::NotConfigured, Some(CODEX_OUTDATED_MESSAGE));
  }
  (ReasonCode::TransientFailure, None)
}

// ---------------------------------------------------------------------------
// Antigravity CLI（agy）

/// `warning: conversation "<id>" not found`。agy は見つからない会話を `--conversation` に渡してもエラーにせず、
/// 新しい会話で答えてしまうので、この警告が出たら続きは無かったことになる。
fn mentions_missing_conversation(normalized: &str) -> bool {
  const HEAD: &str = "conversation \"";
  normalized.match_indices(HEAD).any(|(index, _)| {
    let rest = &normalized[index + HEAD.len()..];
    rest
      .find('"')
      .is_some_and(|end| rest[end + 1..].starts_with(" not found"))
  })
}

/// agy の未ログイン（端末が無いと待たずに `authentication required` で終わる）。`agy models` の判定にも使う。
/// agy 1.3.5 の未ログインの `agy models` は「Error: Please sign in to view available models. Launch the CLI without
/// arguments to sign in.」で終了コード 1（2026-10-15 に Studio の未ログインの agy で確かめた。#18383）。
pub(crate) fn is_agy_login_required(text: &str) -> bool {
  let normalized = normalize_for_match(text);
  [
    "authentication required",
    "not authenticated",
    "unauthenticated",
    "please log in",
    "please sign in",
  ]
  .iter()
  .any(|needle| normalized.contains(needle))
    || is_login_required_message(text)
}

/// agy の失敗の理由（result の error と stderr を合わせた文で、上から順に見る）。
pub(crate) fn classify_agy_failure(text: &str) -> (ReasonCode, Option<&'static str>) {
  let normalized = normalize_for_match(text);
  let has = |needle: &str| normalized.contains(needle);
  if mentions_missing_conversation(&normalized) {
    return (ReasonCode::SessionNotFound, None);
  }
  if is_agy_login_required(text) {
    return (ReasonCode::CliLoginRequired, None);
  }
  // モデル名違い・思考量の違い（モデルごとに受ける値が違い、合わなければ起動時に断られる）
  if has("invalid model selection")
    || has("not recognized as a known model")
    || (has("effort") && (has("has no") || has("is not supported") || has("conflicts with")))
  {
    return (ReasonCode::ModelNotFound, Some(AGY_MODEL_MESSAGE));
  }
  if is_usage_limit_message(text)
    || has("quota")
    || has("resource_exhausted")
    || contains_word(&normalized, "429").is_some()
    || has("rate limit")
  {
    return (ReasonCode::UsageLimitReached, None);
  }
  (ReasonCode::TransientFailure, None)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn claude(text: &str) -> ReasonCode {
    classify_claude_result(&ClaudeErrorSignals {
      api_error_status: None,
      auth_failed: false,
      rate_limited: false,
      assistant_errors: &[],
      subtype: "error_during_execution",
      text,
    })
    .0
  }

  #[test]
  fn usage_limit_detection() {
    assert!(is_usage_limit_message(
      "You've hit your weekly limit · resets Sep 18 at 10pm (Asia/Tokyo)"
    ));
    assert!(is_usage_limit_message("Error: 5-hour limit reached"));
    assert!(is_usage_limit_message("Claude usage limit reached"));
    assert!(!is_usage_limit_message("timed out"));
    // rate_limit_event が rejected のあとのエラー・429・その他
    let rejected = classify_claude_result(&ClaudeErrorSignals {
      api_error_status: None,
      auth_failed: false,
      rate_limited: true,
      assistant_errors: &[],
      subtype: "error_during_execution",
      text: "",
    });
    assert_eq!(rejected.0, ReasonCode::UsageLimitReached);
    let too_many = classify_claude_result(&ClaudeErrorSignals {
      api_error_status: Some(429),
      auth_failed: false,
      rate_limited: false,
      assistant_errors: &[],
      subtype: "success",
      text: "API Error",
    });
    assert_eq!(too_many.0, ReasonCode::UsageLimitReached);
    assert_eq!(claude("boom"), ReasonCode::TransientFailure);
  }

  #[test]
  fn notice_only_rule_matches_server() {
    assert!(is_usage_limit_notice_only(
      "You've hit your weekly limit · resets Sep 18 at 10pm"
    ));
    assert!(is_usage_limit_notice_only(
      "You’ve reached your 5-hour limit\n\nYou've hit your limit"
    ));
    assert!(is_usage_limit_notice_only("Claude AI usage limit reached|1758200000"));
    assert!(is_usage_limit_notice_only("Opus weekly limit reached ∙ resets 10pm"));
    assert!(is_usage_limit_notice_only("You're out of extra usage · resets 3am"));
    assert!(!is_usage_limit_notice_only(
      "記事を直しました。\nYou've hit your weekly limit"
    ));
    assert!(!is_usage_limit_notice_only("You've hit your limits"));
    assert!(!is_usage_limit_notice_only(""));
    assert!(is_usage_limit_message("Error: 5-hour limit reached"));
    assert!(is_usage_limit_message("Claude usage limit reached"));
    assert!(!is_usage_limit_message("timed out"));
    assert!(is_login_required_message("Invalid API key · Please run /login"));
    assert!(is_login_required_message("Please run `/login`"));
    assert!(!is_login_required_message("connection reset"));
  }

  #[test]
  fn process_failure_classification() {
    assert_eq!(
      classify_claude_process_failure("No conversation found with session ID: 1111"),
      ReasonCode::SessionNotFound
    );
    assert_eq!(
      classify_claude_process_failure("Invalid API key · Please run /login"),
      ReasonCode::CliLoginRequired
    );
    assert_eq!(
      classify_claude_process_failure("You've hit your weekly limit"),
      ReasonCode::UsageLimitReached
    );
    assert_eq!(
      classify_claude_process_failure("segfault"),
      ReasonCode::TransientFailure
    );
    assert_eq!(
      classify_claude_process_failure(
        "There's an issue with the selected model (x). It may not exist or you may not have access to it."
      ),
      ReasonCode::ModelNotFound
    );
    assert_eq!(
      classify_claude_process_failure("API Error: unrecognized_model"),
      ReasonCode::ModelNotFound
    );
    assert_eq!(
      claude("No conversation found with session ID: x"),
      ReasonCode::SessionNotFound
    );
  }

  fn signals(status: Option<u64>, errors: &[&str], subtype: &str, text: &str) -> (ReasonCode, Option<&'static str>) {
    let errors: Vec<String> = errors.iter().map(|error| error.to_string()).collect();
    classify_claude_result(&ClaudeErrorSignals {
      api_error_status: status,
      auth_failed: false,
      rate_limited: false,
      assistant_errors: &errors,
      subtype,
      text,
    })
  }

  #[test]
  fn claude_result_rules_apply_in_order() {
    // 未ログイン（実機: assistant の error・result の本文）
    assert_eq!(
      signals(
        None,
        &["authentication_failed"],
        "success",
        "Not logged in · Please run /login"
      )
      .0,
      ReasonCode::CliLoginRequired
    );
    assert_eq!(signals(Some(401), &[], "success", "").0, ReasonCode::CliLoginRequired);
    assert_eq!(
      signals(None, &[], "success", "Not logged in · Please run /login").0,
      ReasonCode::CliLoginRequired
    );
    // モデル名違い（実機: 404 と本文）
    let model = "There's an issue with the selected model (x). It may not exist or you may not have access to it.";
    assert_eq!(signals(Some(404), &[], "success", model).0, ReasonCode::ModelNotFound);
    assert_eq!(
      signals(None, &["model_not_found"], "success", "").0,
      ReasonCode::ModelNotFound
    );
    assert_eq!(
      signals(Some(404), &[], "success", "not found").0,
      ReasonCode::TransientFailure
    );
    assert_eq!(
      signals(None, &["rate_limit"], "success", "").0,
      ReasonCode::UsageLimitReached
    );
    assert_eq!(
      signals(None, &[], "error_max_budget_usd", ""),
      (ReasonCode::TransientFailure, Some(MAX_BUDGET_MESSAGE))
    );
    // 会話なしはモデル名違いより先
    assert_eq!(
      signals(
        Some(404),
        &[],
        "error_during_execution",
        "No conversation found with session ID: x (model)"
      )
      .0,
      ReasonCode::SessionNotFound
    );
  }

  #[test]
  fn codex_failures_follow_the_listed_examples() {
    assert_eq!(
      classify_codex_failure(
        "Error: thread/resume: thread/resume failed: no rollout found for thread id 01a13b6e-21d7-7093-8fc2-637efb0dd571"
      )
      .0,
      ReasonCode::SessionNotFound
    );
    assert_eq!(
      classify_codex_failure("unexpected status 401 Unauthorized: Missing bearer or basic authentication in header").0,
      ReasonCode::CliLoginRequired
    );
    assert_eq!(classify_codex_failure("Not logged in").0, ReasonCode::CliLoginRequired);
    // 0.151.0 は crate が切る機能の名前を知らずに起動しない（更新を案内する）
    assert_eq!(
      classify_codex_failure("Error: Unknown feature flag: sleep_tool"),
      (ReasonCode::NotConfigured, Some(CODEX_OUTDATED_MESSAGE))
    );
    assert_eq!(
      classify_codex_failure("The 'gpt-6-luna' model is not supported when using Codex with a ChatGPT account.").0,
      ReasonCode::ModelNotFound
    );
    assert_eq!(classify_codex_failure("model_not_found").0, ReasonCode::ModelNotFound);
    assert_eq!(
      classify_codex_failure("The model `gpt-x` does not exist").0,
      ReasonCode::ModelNotFound
    );
    assert_eq!(
      classify_codex_failure("usage_limit_reached").0,
      ReasonCode::UsageLimitReached
    );
    assert_eq!(
      classify_codex_failure("You've hit your usage limit.").0,
      ReasonCode::UsageLimitReached
    );
    assert_eq!(
      classify_codex_failure("unexpected status 429 Too Many Requests").0,
      ReasonCode::UsageLimitReached
    );
    assert_eq!(
      classify_codex_failure("stream error: Incomplete response returned, reason: max_output_tokens"),
      (ReasonCode::TransientFailure, Some(CODEX_INCOMPLETE_MESSAGE))
    );
    assert_eq!(
      classify_codex_failure("Not inside a trusted directory and --skip-git-repo-check was not specified.").0,
      ReasonCode::NotConfigured
    );
    assert_eq!(
      classify_codex_failure("Reconnecting... 5/5 (stream disconnected)"),
      (ReasonCode::TransientFailure, None)
    );
    // 数字は単語としてだけ見る
    assert_eq!(
      classify_codex_failure("used 14012 tokens").0,
      ReasonCode::TransientFailure
    );
  }

  #[test]
  fn agy_failures_follow_the_listed_examples() {
    // 見つからない会話（エラーにならず、警告だけ出して新しい会話で答える）
    assert_eq!(
      classify_agy_failure("warning: conversation \"11111111-2222-4333-8444-555555555555\" not found"),
      (ReasonCode::SessionNotFound, None)
    );
    assert_eq!(
      classify_agy_failure("conversation \"x\" was saved\nmodel not found").0,
      ReasonCode::TransientFailure,
      "the quoted id must be followed by not found"
    );
    // 未ログイン
    for text in [
      "error: authentication required",
      "Not authenticated. Run agy to log in.",
      "rpc error: code = Unauthenticated desc = token expired",
      "Please log in with your Google account",
      "Not logged in",
    ] {
      assert_eq!(
        classify_agy_failure(text),
        (ReasonCode::CliLoginRequired, None),
        "{text}"
      );
    }
    // モデル名違い・思考量の違い（実機の 4 例）
    for text in [
      "invalid model selection (--model \"gemini-nonexistent-9\" --effort \"\"): model gemini-nonexistent-9 is not recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 3.8 Flash (High)",
      "error: invalid model selection (--model \"gemini-3.8-flash\" --effort \"max\"): gemini-3.8-flash has no \"max\" effort (available: low, medium, high)",
      "--model gemini-3.8-flash-medium conflicts with --effort=low",
      "--effort is not supported for model \"claude-sonnet-4-6\"",
    ] {
      assert_eq!(
        classify_agy_failure(text),
        (ReasonCode::ModelNotFound, Some(AGY_MODEL_MESSAGE)),
        "{text}"
      );
    }
    // 会話なしは未ログイン・モデル名違いより先
    assert_eq!(
      classify_agy_failure("warning: conversation \"abc\" not found\nerror: authentication required").0,
      ReasonCode::SessionNotFound
    );
    // 上限
    for text in [
      "You've hit your usage limit",
      "Quota exceeded for quota metric",
      "[API Error: 429 RESOURCE_EXHAUSTED]",
      "error 429",
      "rate limit exceeded",
    ] {
      assert_eq!(classify_agy_failure(text).0, ReasonCode::UsageLimitReached, "{text}");
    }
    // 数字は単語としてだけ見る・それ以外は一時的な失敗
    assert_eq!(
      classify_agy_failure("used 14290 tokens").0,
      ReasonCode::TransientFailure
    );
    assert_eq!(
      classify_agy_failure("fetch failed"),
      (ReasonCode::TransientFailure, None)
    );
    assert_eq!(classify_agy_failure(""), (ReasonCode::TransientFailure, None));
    assert!(!is_agy_login_required("connection reset"));
    // agy 1.3.5 の未ログインの `agy models`（実機の文）
    let signed_out = "Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.";
    assert!(is_agy_login_required(signed_out));
    assert_eq!(classify_agy_failure(signed_out).0, ReasonCode::CliLoginRequired);
  }

  #[test]
  fn reason_messages_name_the_cli() {
    assert_eq!(
      reason_message(Provider::CodexCli, ReasonCode::CliLoginRequired),
      "このMacの Codex CLI にログインしてください。"
    );
    assert_eq!(
      reason_message(Provider::GeminiCli, ReasonCode::UsageLimitReached),
      "このMacの Antigravity CLI の利用上限に達しました。"
    );
    assert_eq!(
      reason_message(Provider::ClaudeCode, ReasonCode::ModelNotFound),
      "Claude Code でこのモデルを使えません。設定のモデルを確かめてください。"
    );
    assert_eq!(
      reason_message(Provider::ClaudeCode, ReasonCode::TransientFailure),
      "Claude Code の実行に失敗しました。"
    );
    assert_eq!(
      reason_message(Provider::CodexCli, ReasonCode::SessionNotFound),
      "このMacに会話の続きが見つかりませんでした。"
    );
  }
}
