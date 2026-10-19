//! resident.rs のテスト（LaunchAgent は一時フォルダに書く。本物の ~/Library/LaunchAgents には触れない）。

use super::*;

fn temp_dir(name: &str) -> PathBuf {
  let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
    "niho-docs-resident-{name}-{}-{}",
    std::process::id(),
    crate::process::hex(&crate::process::random_bytes::<4>().unwrap())
  ));
  std::fs::create_dir_all(&dir).unwrap();
  dir
}

#[test]
fn background_flag_is_read_from_the_arguments_after_the_executable() {
  let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
  assert!(is_background_launch(args(&[
    "/Applications/NIHO docs.app/Contents/MacOS/niho_docs",
    "--background"
  ])));
  assert!(!is_background_launch(args(&[
    "/Applications/NIHO docs.app/Contents/MacOS/niho_docs"
  ])));
  assert!(!is_background_launch(args(&["--background"])));
  assert!(!is_background_launch(args(&["niho_docs", "--background=1"])));
}

#[test]
fn plist_starts_this_executable_in_the_background_at_login() {
  let text = plist(Path::new("/Applications/NIHO & docs.app/Contents/MacOS/niho_docs"));
  for expected in [
    "<key>Label</key>\n  <string>life.niho.docs.pc-runner</string>",
    "<string>/Applications/NIHO &amp; docs.app/Contents/MacOS/niho_docs</string>\n    <string>--background</string>",
    "<key>RunAtLoad</key>\n  <true/>",
    "<key>KeepAlive</key>\n  <false/>",
    "<key>ProcessType</key>\n  <string>Interactive</string>",
    "<key>LimitLoadToSessionType</key>\n  <string>Aqua</string>",
  ] {
    assert!(text.contains(expected), "{expected}\n{text}");
  }
  assert!(text.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist"));
}

#[test]
fn launch_agent_is_written_rewritten_when_the_app_moves_and_removed() {
  let dir = temp_dir("agent");
  let agents = dir.join("Library").join("LaunchAgents");
  let agent = LaunchAgent::new(agents.clone());
  assert_eq!(agent.path(), agents.join("life.niho.docs.pc-runner.plist"));
  let first = Path::new("/Applications/NIHO docs.app/Contents/MacOS/niho_docs");
  assert!(agent.install(first).unwrap());
  assert_eq!(std::fs::read_to_string(agent.path()).unwrap(), plist(first));
  // 同じ場所なら書き直さない
  assert!(!agent.install(first).unwrap());
  // アプリを移したら書き直す
  let moved = Path::new("/Users/me/Applications/NIHO docs.app/Contents/MacOS/niho_docs");
  assert!(agent.install(moved).unwrap());
  assert_eq!(std::fs::read_to_string(agent.path()).unwrap(), plist(moved));
  let leftovers = std::fs::read_dir(&agents)
    .unwrap()
    .filter_map(|entry| entry.ok())
    .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
    .count();
  assert_eq!(leftovers, 0);
  assert!(agent.remove().unwrap());
  assert!(!agent.path().exists());
  assert!(!agent.remove().unwrap());
  let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn login_item_is_skipped_for_dev_and_translocated_launches() {
  let installed = Path::new("/Applications/NIHO docs.app/Contents/MacOS/niho_docs");
  assert_eq!(skip_reason(false, installed), None);
  assert_eq!(skip_reason(true, installed), Some("dev"));
  assert_eq!(
    skip_reason(
      false,
      Path::new("/private/var/folders/xy/T/AppTranslocation/0A1B/d/NIHO docs.app/Contents/MacOS/niho_docs")
    ),
    Some("translocated")
  );
  assert_eq!(skip_reason(false, Path::new("niho_docs")), Some("relative"));
}

#[test]
fn idle_restart_is_only_for_a_hidden_resident_app_with_a_staged_update() {
  assert!(idle_restart_wanted(true, true, false));
  // 窓が見えている・OFF・新しい版を取得していないときは確かめにいかない
  assert!(!idle_restart_wanted(true, true, true));
  assert!(!idle_restart_wanted(false, true, false));
  assert!(!idle_restart_wanted(true, false, false));
}

#[test]
fn background_relaunch_is_taken_once() {
  assert!(!take_background_relaunch());
  request_background_relaunch();
  assert!(take_background_relaunch());
  assert!(!take_background_relaunch());
}
