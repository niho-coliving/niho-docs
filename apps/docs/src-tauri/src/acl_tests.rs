//! `generate_handler!` に登録したコマンドと ACL（`permissions/`・`capabilities/`）の突き合わせ。
//! アプリが自前の permission を持つと、Tauri 2 は app コマンドも ACL で判定し、許可の無いコマンドは実行前に拒否する。
//! 登録だけして permission・capability へ足し忘れると、画面から呼べない（NIHO Desktop の command_acl_tests.rs と同じ考え）。

use std::collections::BTreeSet;

fn registered_commands() -> BTreeSet<String> {
  const HANDLER: &str = "tauri::generate_handler![";
  let source = include_str!("lib.rs");
  let start = source.find(HANDLER).expect("generate_handler! が無い") + HANDLER.len();
  let end = start + source[start..].find(']').expect("generate_handler! の閉じ括弧が無い");
  source[start..end]
    .split(',')
    .map(|entry| entry.trim().rsplit("::").next().unwrap_or("").to_string())
    .filter(|name| !name.is_empty())
    .collect()
}

/// permissions/docs.toml の identifier → commands.allow。
fn permissions() -> Vec<(String, BTreeSet<String>)> {
  let source = include_str!("../permissions/docs.toml");
  let mut result = Vec::new();
  let mut identifier: Option<String> = None;
  for line in source.lines() {
    let line = line.trim();
    if let Some(value) = line.strip_prefix("identifier = ") {
      identifier = Some(value.trim_matches('"').to_string());
    }
    if let Some(value) = line.strip_prefix("commands.allow = ") {
      let commands = value
        .trim_matches(|ch| ch == '[' || ch == ']')
        .split(',')
        .map(|name| name.trim().trim_matches('"').to_string())
        .filter(|name| !name.is_empty())
        .collect();
      result.push((
        identifier.take().expect("identifier の後に commands.allow を書く"),
        commands,
      ));
    }
  }
  result
}

#[test]
fn every_registered_command_is_allowed_by_the_main_window_capability() {
  let capability: serde_json::Value =
    serde_json::from_str(include_str!("../capabilities/default.json")).expect("capabilities/default.json");
  assert_eq!(capability["windows"], serde_json::json!(["main"]));
  let granted: BTreeSet<String> = capability["permissions"]
    .as_array()
    .expect("permissions")
    .iter()
    .filter_map(|value| value.as_str().map(str::to_string))
    .collect();
  let mut allowed = BTreeSet::new();
  for (identifier, commands) in permissions() {
    assert!(
      granted.contains(&identifier),
      "{identifier} が capabilities/default.json に無い"
    );
    allowed.extend(commands);
  }
  let registered = registered_commands();
  assert!(
    registered.contains("run_turn") && registered.contains("transcribe"),
    "{registered:?}"
  );
  assert_eq!(registered, allowed, "登録したコマンドと permission の許可が食い違う");
}
