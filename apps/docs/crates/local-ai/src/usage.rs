//! 提供元が返す使用量の残り（Antigravity CLI の `/usage`。S2a #18383）。
//!
//! サブスクリプションの上限は提供元ごとに形が違い、推測で出さない（spec §5.6「取得できません」）。agy だけが非対話の
//! `agy -p "/usage" --output-format json` で、群（Gemini の群・Claude と GPT の群）ごとの週の残りを返す（S0 #18381）。
//! Claude Code・Codex CLI は返す手段が無いので `usage_unsupported` にする。

use crate::classify::is_agy_login_required;
use crate::process::{run_capture, CaptureError, PrivateDir, TURN_DIR_PREFIX};
use crate::runtime::{provider_command, resolve_cli, Runtime};
use crate::types::{LocalAiError, Provider};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

/// `/usage` の上限（ネットワーク越しに取りに行く。止まっても設定の画面を待たせ続けない）。
const USAGE_TIME_LIMIT: Duration = Duration::from_secs(30);
const USAGE_KILL_GRACE: Duration = Duration::from_millis(500);
const USAGE_OUTPUT_MAX_BYTES: usize = 256 * 1024;

/// 残りの枠 1 つ（agy の `command.data.groups[].buckets[]`）。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
  /// 群の名前（例 "Gemini Models"・"Claude and GPT models"。モデルの群ごとに上限を分け合う）
  pub group: String,
  /// 枠の名前（例 "Weekly Limit Remaining"）
  pub name: String,
  /// 期間（例 "weekly"）
  pub window: Option<String>,
  /// 残りの割合（0〜1）
  pub remaining_fraction: Option<f64>,
  /// 次に満たされる時刻（ISO 8601）
  pub reset_time: Option<String>,
}

/// 提供元の使用量の残り。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
  pub provider: Provider,
  pub windows: Vec<UsageWindow>,
}

/// `agy -p "/usage" --output-format json` の出力を読む。`status` が SUCCESS で、枠が 1 つ以上あるときだけ。
pub(crate) fn parse_agy_usage(text: &str) -> Option<Vec<UsageWindow>> {
  let value: Value = serde_json::from_str(text.trim()).ok()?;
  if value.get("status").and_then(Value::as_str) != Some("SUCCESS") {
    return None;
  }
  let groups = value.get("command")?.get("data")?.get("groups")?.as_array()?;
  let text_of = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
  let mut windows = Vec::new();
  for group in groups {
    let group_name = text_of(group, "name").unwrap_or_default();
    for bucket in group.get("buckets").and_then(Value::as_array).into_iter().flatten() {
      windows.push(UsageWindow {
        group: group_name.clone(),
        name: text_of(bucket, "name").unwrap_or_default(),
        window: text_of(bucket, "window"),
        remaining_fraction: bucket
          .get("remaining_fraction")
          .and_then(Value::as_f64)
          .filter(|fraction| fraction.is_finite())
          .map(|fraction| fraction.clamp(0.0, 1.0)),
        reset_time: text_of(bucket, "reset_time"),
      });
    }
  }
  (!windows.is_empty()).then_some(windows)
}

/// 既定の実行環境で使用量の残りを取る。[`provider_usage_with`] を見る。
pub fn provider_usage(provider: Provider) -> Result<ProviderUsage, LocalAiError> {
  provider_usage_with(&Runtime::default(), provider)
}

/// 使用量の残りを取る（agy だけ）。その回だけの空の作業フォルダで、標準入力を閉じて `agy -p "/usage"` を呼ぶ。
/// 取れなければ Err（画面は「取得できません」と出す）。
pub fn provider_usage_with(runtime: &Runtime, provider: Provider) -> Result<ProviderUsage, LocalAiError> {
  if provider != Provider::GeminiCli {
    return Err(LocalAiError::new(
      "usage_unsupported",
      format!("{} は使用量の残りを返しません。", provider.label()),
    ));
  }
  let Some(cli) = resolve_cli(runtime, provider) else {
    return Err(LocalAiError::new(
      "cli_not_found",
      format!("このMacに {} が見つかりません。", provider.label()),
    ));
  };
  let unavailable = |details: Option<String>| {
    LocalAiError::new("usage_unavailable", "使用量を取得できませんでした。").with_details(details)
  };
  let dir =
    PrivateDir::create(&runtime.scratch_dir, TURN_DIR_PREFIX).map_err(|err| unavailable(Some(err.to_string())))?;
  let workspace = dir.create_dir("ws").map_err(|err| unavailable(Some(err.to_string())))?;
  let args: Vec<String> = ["-p", "/usage", "--output-format", "json"]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
  let mut command = provider_command(runtime, provider, &cli, &args, &[]);
  command.current_dir(&workspace);
  let output =
    run_capture(command, USAGE_TIME_LIMIT, USAGE_KILL_GRACE, USAGE_OUTPUT_MAX_BYTES).map_err(|err| match err {
      CaptureError::TimedOut => unavailable(Some("timed out".to_string())),
      CaptureError::Spawn(err) | CaptureError::Wait(err) => unavailable(Some(err.to_string())),
    })?;
  let stdout = String::from_utf8_lossy(&output.stdout);
  let stderr = String::from_utf8_lossy(&output.stderr);
  if let Some(windows) = output.status.success().then(|| parse_agy_usage(&stdout)).flatten() {
    return Ok(ProviderUsage { provider, windows });
  }
  if is_agy_login_required(&format!("{stdout}\n{stderr}")) {
    return Err(LocalAiError::new(
      "auth_required",
      "Antigravity CLI にログインしてから、もう一度確かめてください。",
    ));
  }
  runtime.log(
    "usage_unavailable",
    serde_json::json!({ "provider": provider.wire_name(), "exitCode": output.status.code() }),
  );
  Err(unavailable(None))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn agy_usage_lists_every_bucket_of_every_group() {
    let text = r#"{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\tWeekly Limit Remaining\t59%\n","usage":{},
      "command":{"name":"usage","data":{"description":"…","groups":[
        {"name":"Gemini Models","description":"Gemini Flash, Gemini Pro","buckets":[
          {"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.589309573173523,"reset_time":"2026-10-21T19:12:26Z"}]},
        {"name":"Claude and GPT models","buckets":[
          {"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":1,"reset_time":"2026-10-22T03:21:42Z"},
          {"name":"Broken","remaining_fraction":7}]}]}}}"#;
    let windows = parse_agy_usage(text).unwrap();
    assert_eq!(windows.len(), 3);
    assert_eq!(
      windows[0],
      UsageWindow {
        group: "Gemini Models".into(),
        name: "Weekly Limit Remaining".into(),
        window: Some("weekly".into()),
        remaining_fraction: Some(0.589309573173523),
        reset_time: Some("2026-10-21T19:12:26Z".into()),
      }
    );
    assert_eq!(windows[1].remaining_fraction, Some(1.0));
    // 0〜1 の外は丸める
    assert_eq!(windows[2].remaining_fraction, Some(1.0));
    assert_eq!(windows[2].window, None);
    assert_eq!(
      serde_json::to_value(&windows[0]).unwrap(),
      serde_json::json!({"group":"Gemini Models","name":"Weekly Limit Remaining","window":"weekly","remainingFraction":0.589309573173523,"resetTime":"2026-10-21T19:12:26Z"})
    );
  }

  #[test]
  fn agy_usage_needs_success_and_a_bucket() {
    assert_eq!(
      parse_agy_usage(r#"{"status":"ERROR","command":{"data":{"groups":[]}}}"#),
      None
    );
    assert_eq!(
      parse_agy_usage(r#"{"status":"SUCCESS","command":{"data":{"groups":[]}}}"#),
      None
    );
    assert_eq!(parse_agy_usage(r#"{"status":"SUCCESS"}"#), None);
    assert_eq!(parse_agy_usage("Usage: …"), None);
  }

  #[test]
  fn other_providers_do_not_return_usage() {
    for provider in [Provider::ClaudeCode, Provider::CodexCli] {
      let error = provider_usage_with(&Runtime::default(), provider).unwrap_err();
      assert_eq!(error.code, "usage_unsupported");
      assert!(error.message.contains(provider.label()));
    }
  }
}
