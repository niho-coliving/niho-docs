//! 「AIと作る」の修正の会話（S5 #18386）が使う録音のフォルダの読み書き。store.rs の子 module（同じ守り: id だけでパスを作り、
//! root の中のリンクを断り、書き込みは一時ファイル → rename）。録音は root（案件フォルダ直下）か recordings/<recordingId>/。
//!
//! ```text
//! <録音>/conversations/<conversationId>.json   会話（kind: step | edit・turns。中身の形は docs-core の conversation.ts）
//! ```
//!
//! - 会話の作業フォルダは会話ごとの隔離 workspace。CLI はそこに複製した文書だけを編集し、正本への版保存は画面が行う。
//! - `artifact_states` は artifacts/*.md の状態（mtime・大きさ・SHA-256）と versions/<stepId>/ の最後の版を返す。工程 1 の
//!   文字起こし・文章（transcript.md・versions/source/）も `source` として先頭に返す（会話で直せる）。

use super::versions::{newest_version_row, read_plain_file, row_version, row_version_bytes, VersionPlan};
use super::{read_json, read_jsonl, read_text, validate_id, write_json, Result, Store, StoreError, WRITE_LOCK};
use crate::process::hex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

/// 一覧で返す会話の数（新しい順）。
const MAX_CONVERSATIONS: usize = 50;
/// 会話のファイルの大きさの上限（返答・作業の要約だけなので小さい）。
const MAX_CONVERSATION_BYTES: usize = 4 * 1024 * 1024;

/// artifacts/<stepId>.md の状態。`latest_version` は versions/<stepId>/ の最後の版（無ければ 0）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactState {
  pub step_id: String,
  pub exists: bool,
  pub sha256: Option<String>,
  pub size: u64,
  pub mtime_ms: u64,
  pub latest_version: u32,
}

impl Store {
  /// 修正会話の元文書を読む録音のフォルダ。artifacts/ が無ければ作る。CLI の cwd には使わない。
  pub fn chat_folder(&self, project_id: &str, recording_id: &str) -> Result<PathBuf> {
    self.chat_folder_at(Some(project_id), recording_id)
  }

  pub fn chat_folder_at(&self, project_id: Option<&str>, recording_id: &str) -> Result<PathBuf> {
    let base = self.recording_parts_at(project_id, recording_id)?;
    let artifacts = self.under(&base, &["artifacts"])?;
    fs::create_dir_all(&artifacts).map_err(StoreError::io)?;
    self.under(&base, &[])
  }

  /// 工程の文書の状態（工程 1 の source、artifacts/ にある文書と、versions/ に版のある工程）。source は transcript.md か
  /// 版があるときだけ。
  pub fn artifact_states(&self, project_id: &str, recording_id: &str) -> Result<Vec<ArtifactState>> {
    self.artifact_states_at(Some(project_id), recording_id)
  }

  pub fn artifact_states_at(&self, project_id: Option<&str>, recording_id: &str) -> Result<Vec<ArtifactState>> {
    let base = self.recording_parts_at(project_id, recording_id)?;
    let mut ids = Self::artifact_ids(&self.under(&base, &[])?);
    if let Ok(entries) = fs::read_dir(self.under(&base, &["versions"])?) {
      for entry in entries.filter_map(|entry| entry.ok()) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name != super::SOURCE_STEP_ID && validate_id(&name).is_ok() && !ids.contains(&name) {
          ids.push(name);
        }
      }
    }
    ids.retain(|id| id != super::SOURCE_STEP_ID);
    ids.sort();
    let rows = read_jsonl(&self.under(&base, &["runs.jsonl"])?)?;
    let mut states = Vec::new();
    let source = self.artifact_state(
      super::SOURCE_STEP_ID,
      self.under(&base, &["transcript.md"])?,
      self.under(&base, &["versions", super::SOURCE_STEP_ID])?,
      &rows,
    )?;
    if source.exists || source.latest_version > 0 {
      states.push(source);
    }
    for step_id in ids {
      let file = self.under(&base, &["artifacts", &format!("{step_id}.md")])?;
      let versions = self.under(&base, &["versions", &step_id])?;
      states.push(self.artifact_state(&step_id, file, versions, &rows)?);
    }
    Ok(states)
  }

  /// `latest_version` は runs のいちばん新しい版の行の番号（版の行が無い旧形式は versions/<stepId>/ の連番の最大）。
  fn artifact_state(&self, step_id: &str, file: PathBuf, versions: PathBuf, rows: &[Value]) -> Result<ArtifactState> {
    let latest_version = newest_version_row(rows, step_id)
      .and_then(row_version)
      .unwrap_or_else(|| Self::next_version(&versions) - 1);
    match fs::read(&file) {
      Ok(bytes) => Ok(ArtifactState {
        step_id: step_id.to_string(),
        exists: true,
        sha256: Some(hex(&Sha256::digest(&bytes))),
        size: bytes.len() as u64,
        mtime_ms: fs::metadata(&file)
          .and_then(|meta| meta.modified())
          .ok()
          .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
          .map(|duration| duration.as_millis() as u64)
          .unwrap_or(0),
        latest_version,
      }),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ArtifactState {
        step_id: step_id.to_string(),
        exists: false,
        sha256: None,
        size: 0,
        mtime_ms: 0,
        latest_version,
      }),
      Err(error) => Err(StoreError::io(error)),
    }
  }

  /// 工程の文書（artifacts/<stepId>.md）の今の中身。無ければ None。
  pub fn read_artifact(&self, project_id: &str, recording_id: &str, step_id: &str) -> Result<Option<String>> {
    self.read_artifact_at(Some(project_id), recording_id, step_id)
  }

  pub fn read_artifact_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    step_id: &str,
  ) -> Result<Option<String>> {
    validate_id(step_id)?;
    read_text(&self.recording_file_at(project_id, recording_id, &["artifacts", &format!("{step_id}.md")])?)
  }

  /// 工程 1 の文字起こし／文章（transcript.md）。会話 workspace の artifacts/source.md へ複製する。
  pub fn read_transcript(&self, project_id: &str, recording_id: &str) -> Result<Option<String>> {
    read_text(&self.recording_file(project_id, recording_id, &["transcript.md"])?)
  }

  pub fn read_transcript_at(&self, project_id: Option<&str>, recording_id: &str) -> Result<Option<String>> {
    read_text(&self.recording_file_at(project_id, recording_id, &["transcript.md"])?)
  }

  /// artifacts/<stepId>.md を最後の版（runs のいちばん新しい版の行。行の無い旧形式は versions/<stepId>/<n>.md の最大）の
  /// 中身に戻す（版は足さない）。今の内容が版になっていなければ、先にそれを「保存」の版として残す。戻した版の番号を返す。
  pub fn revert_artifact(&self, project_id: &str, recording_id: &str, step_id: &str) -> Result<u32> {
    self.revert_artifact_at(Some(project_id), recording_id, step_id)
  }

  pub fn revert_artifact_at(&self, project_id: Option<&str>, recording_id: &str, step_id: &str) -> Result<u32> {
    validate_id(step_id)?;
    if step_id == super::SOURCE_STEP_ID {
      return Err(StoreError::new("store_bad_id", "id が正しくありません。"));
    }
    let _guard = WRITE_LOCK.lock();
    let base = self.recording_parts_at(project_id, recording_id)?;
    let dir = self.under(&base, &[])?;
    let versions = self.under(&base, &["versions", step_id])?;
    self.under(&base, &["artifacts"])?;
    let prefix = self.recording_prefix_at(project_id, recording_id)?;
    let rows = read_jsonl(&self.under(&base, &["runs.jsonl"])?)?;
    let no_version = || StoreError::new("store_no_version", "その版が見つかりません。");
    let (latest, bytes) = match newest_version_row(&rows, step_id) {
      Some(row) => (
        row_version(row).unwrap_or(0),
        row_version_bytes(&dir, &prefix, step_id, row),
      ),
      None => {
        let latest = Self::next_version(&versions) - 1;
        (latest, read_plain_file(&versions.join(format!("{latest}.md"))))
      }
    };
    if latest == 0 {
      return Err(no_version());
    }
    let markdown = String::from_utf8(bytes.ok_or_else(no_version)?).map_err(|_| no_version())?;
    VersionPlan::new(&dir, &prefix, step_id, false, &markdown, None)?.commit()?;
    Ok(latest)
  }

  /// 録音の会話（conversations/*.json。updatedAt の新しい順に 50 まで）。読めないファイルは飛ばす。
  pub fn list_conversations(&self, project_id: &str, recording_id: &str) -> Result<Vec<Value>> {
    self.list_conversations_at(Some(project_id), recording_id)
  }

  pub fn list_conversations_at(&self, project_id: Option<&str>, recording_id: &str) -> Result<Vec<Value>> {
    let base = self.chat_parts_at(project_id, recording_id)?;
    let dir = self.under(&base, &["conversations"])?;
    let entries = match fs::read_dir(&dir) {
      Ok(entries) => entries,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
      Err(error) => return Err(StoreError::io(error)),
    };
    let mut conversations = Vec::new();
    for entry in entries.filter_map(|entry| entry.ok()) {
      let name = entry.file_name().to_string_lossy().into_owned();
      let Some(id) = name.strip_suffix(".json") else {
        continue;
      };
      if validate_id(id).is_err() || entry.file_type().map(|kind| !kind.is_file()).unwrap_or(true) {
        continue;
      }
      let Ok(Some(conversation)) = read_json(&self.under(&base, &["conversations", &name])?) else {
        continue;
      };
      if conversation.get("id").and_then(Value::as_str) == Some(id) {
        conversations.push(conversation);
      }
    }
    let updated = |value: &Value| value.get("updatedAt").and_then(Value::as_str).unwrap_or("").to_string();
    conversations.sort_by(|a, b| updated(b).cmp(&updated(a)));
    conversations.truncate(MAX_CONVERSATIONS);
    Ok(conversations)
  }

  /// 録音の会話の id（conversations/*.json の名前。読めないファイルも含める）。録音を消す前に控え、app data に残る会話の履歴を消すのに使う。
  pub fn conversation_ids(&self, project_id: &str, recording_id: &str) -> Result<Vec<String>> {
    self.conversation_ids_at(Some(project_id), recording_id)
  }

  pub fn conversation_ids_at(&self, project_id: Option<&str>, recording_id: &str) -> Result<Vec<String>> {
    let base = self.chat_parts_at(project_id, recording_id)?;
    let dir = self.under(&base, &["conversations"])?;
    let entries = match fs::read_dir(&dir) {
      Ok(entries) => entries,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
      Err(error) => return Err(StoreError::io(error)),
    };
    Ok(
      entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
          let name = entry.file_name().to_string_lossy().into_owned();
          let id = name.strip_suffix(".json")?;
          (validate_id(id).is_ok() && entry.file_type().is_ok_and(|kind| kind.is_file())).then(|| id.to_string())
        })
        .collect(),
    )
  }

  /// 会話を保存する（録音の conversations/<conversationId>.json。中の id は名前と同じ）。
  pub fn save_conversation(
    &self,
    project_id: &str,
    recording_id: &str,
    conversation_id: &str,
    conversation: &Value,
  ) -> Result<()> {
    self.save_conversation_at(Some(project_id), recording_id, conversation_id, conversation)
  }

  pub fn save_conversation_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    conversation_id: &str,
    conversation: &Value,
  ) -> Result<()> {
    validate_id(conversation_id)?;
    if conversation.get("id").and_then(Value::as_str) != Some(conversation_id) {
      return Err(StoreError::new("store_bad_json", "会話の id が食い違っています。"));
    }
    if serde_json::to_vec(conversation)
      .map(|bytes| bytes.len())
      .unwrap_or(usize::MAX)
      > MAX_CONVERSATION_BYTES
    {
      return Err(StoreError::new(
        "store_too_large",
        "会話が長すぎるため保存できませんでした。",
      ));
    }
    let _guard = WRITE_LOCK.lock();
    write_json(
      &self.chat_file_at(
        project_id,
        recording_id,
        &["conversations", &format!("{conversation_id}.json")],
      )?,
      conversation,
    )
  }
}

#[cfg(test)]
mod tests {
  use super::super::{Store, ROOT_RECORDING_ID as ROOT};
  use serde_json::json;
  use std::fs;
  use std::path::PathBuf;

  fn temp_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
      "niho-docs-conversations-{name}-{}-{}",
      std::process::id(),
      crate::process::hex(&crate::process::random_bytes::<4>().unwrap())
    ))
  }

  fn text_project(store: &Store) -> String {
    let created = store
      .create_project(
        &json!({ "version": 1, "id": "", "name": "会話", "createdAt": "2026-10-15T00:00:00.000Z", "flowSnapshot": { "steps": [] }, "source": { "kind": "text" } }),
        Some("本文"),
        Some(&json!({ "id": "s1", "kind": "save", "stepId": "source", "stepName": "文章", "result": "saved" })),
        &[],
      )
      .unwrap();
    created["id"].as_str().unwrap().to_string()
  }

  #[test]
  fn artifact_states_follow_files_and_versions() {
    let root = temp_root("states");
    let store = Store::new(root.clone());
    let id = text_project(&store);
    // 旧形式の root の録音は読み込みで recordings/<id>/ へ移る（P6 #18607）。移った後の場所を使う
    store.load_recording(&id, ROOT).unwrap();
    let folder = store.chat_folder(&id, ROOT).unwrap();
    assert!(folder.join("artifacts").is_dir());
    // 工程 1（文章）は transcript.md と versions/source/ の版で先頭に並ぶ
    let initial = store.artifact_states(&id, ROOT).unwrap();
    assert_eq!(initial.len(), 1);
    assert_eq!(
      (
        initial[0].step_id.as_str(),
        initial[0].exists,
        initial[0].latest_version
      ),
      ("source", true, 1)
    );
    assert_eq!(initial[0].size, "本文".len() as u64);
    let run = json!({ "id": "r1", "kind": "run", "stepId": "k7m2q9xa", "stepName": "記事方針", "result": "saved" });
    store
      .save_artifact(&id, ROOT, "k7m2q9xa", false, "# 方針", &run)
      .unwrap();
    let before = store.artifact_states(&id, ROOT).unwrap();
    assert_eq!(before.len(), 2);
    assert_eq!(before[0].step_id, "source");
    let before = &before[1..];
    assert_eq!(before[0].step_id, "k7m2q9xa");
    assert!(before[0].exists);
    assert_eq!(before[0].latest_version, 1);
    assert_eq!(before[0].size, "# 方針".len() as u64);
    // AI がファイルを書き換えると SHA-256 が変わる（版はまだ 1）
    fs::write(folder.join("artifacts").join("k7m2q9xa.md"), "# 方針（直した）").unwrap();
    let after = store.artifact_states(&id, ROOT).unwrap();
    assert_ne!(after[1].sha256, before[0].sha256);
    assert_eq!(after[1].latest_version, 1);
    // 文字起こしを人が直して保存すると source の版が増える
    let save = json!({ "id": "s2", "kind": "save", "stepId": "source", "stepName": "文章", "result": "saved" });
    store
      .save_artifact(&id, ROOT, "source", true, "本文（直した）", &save)
      .unwrap();
    let source = &store.artifact_states(&id, ROOT).unwrap()[0];
    assert_eq!((source.step_id.as_str(), source.latest_version), ("source", 2));
    assert_ne!(source.sha256, initial[0].sha256);
    assert_eq!(
      store.read_artifact(&id, ROOT, "k7m2q9xa").unwrap().as_deref(),
      Some("# 方針（直した）")
    );
    // 最後の版に戻す（戻す版は足さない。版になっていない今の内容は、先に「保存」の版 2 として残る）
    assert_eq!(store.revert_artifact(&id, ROOT, "k7m2q9xa").unwrap(), 1);
    assert_eq!(
      store.read_artifact(&id, ROOT, "k7m2q9xa").unwrap().as_deref(),
      Some("# 方針")
    );
    let reverted = store.artifact_states(&id, ROOT).unwrap();
    assert_eq!(reverted[1].sha256, before[0].sha256);
    assert_eq!(reverted[1].latest_version, 2);
    assert_eq!(
      store.read_version(&id, ROOT, "k7m2q9xa", 2).unwrap(),
      "# 方針（直した）"
    );
    let rows = store.load_recording(&id, ROOT).unwrap().runs;
    let auto = rows.last().unwrap();
    assert_eq!(
      (auto["kind"].as_str(), auto["auto"].as_bool()),
      (Some("save"), Some(true))
    );
    // 消えた文書も版があれば並ぶ（exists: false）
    fs::remove_file(folder.join("artifacts").join("k7m2q9xa.md")).unwrap();
    let gone = store.artifact_states(&id, ROOT).unwrap();
    assert_eq!((gone[1].exists, gone[1].latest_version), (false, 2));
    assert_eq!(store.read_artifact(&id, ROOT, "k7m2q9xa").unwrap(), None);
    // 版の無い文書・工程 1 は戻せない
    assert_eq!(
      store.revert_artifact(&id, ROOT, "zzzzzzzz").unwrap_err().code,
      "store_no_version"
    );
    assert_eq!(
      store.revert_artifact(&id, ROOT, "source").unwrap_err().code,
      "store_bad_id"
    );
    assert!(store.read_artifact(&id, ROOT, "../project").is_err());
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn conversations_round_trip_newest_first() {
    let root = temp_root("conversations");
    let store = Store::new(root.clone());
    let id = text_project(&store);
    assert!(store.list_conversations(&id, ROOT).unwrap().is_empty());
    let older = json!({ "schemaVersion": 1, "id": "conv-a", "kind": "edit", "updatedAt": "2026-10-15T01:00:00.000Z", "turns": [] });
    let newer = json!({ "schemaVersion": 1, "id": "run-b", "kind": "step", "updatedAt": "2026-10-15T02:00:00.000Z", "turns": [] });
    store.save_conversation(&id, ROOT, "conv-a", &older).unwrap();
    store.save_conversation(&id, ROOT, "run-b", &newer).unwrap();
    let ids: Vec<String> = store
      .list_conversations(&id, ROOT)
      .unwrap()
      .iter()
      .map(|conversation| conversation["id"].as_str().unwrap().to_string())
      .collect();
    assert_eq!(ids, vec!["run-b", "conv-a"]);
    assert!(root.join(format!("projects/{id}/conversations/conv-a.json")).is_file());
    // id の食い違い・正しくない id は保存しない。壊れたファイルは一覧から飛ばす
    assert_eq!(
      store.save_conversation(&id, ROOT, "conv-c", &older).unwrap_err().code,
      "store_bad_json"
    );
    assert!(store.save_conversation(&id, ROOT, "../x", &older).is_err());
    fs::write(root.join(format!("projects/{id}/conversations/broken.json")), "{").unwrap();
    assert_eq!(store.list_conversations(&id, ROOT).unwrap().len(), 2);
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn conversation_ids_include_every_json_name_even_unreadable_ones() {
    let root = temp_root("conversation-ids");
    let store = Store::new(root.clone());
    let id = text_project(&store);
    assert!(store.conversation_ids(&id, ROOT).unwrap().is_empty());
    let conversation = json!({ "schemaVersion": 1, "id": "conv-a", "kind": "edit", "updatedAt": "2026-10-15T01:00:00.000Z", "turns": [] });
    store.save_conversation(&id, ROOT, "conv-a", &conversation).unwrap();
    // 壊れたファイルの会話も、履歴を消す対象に含める。id でない名前・json でないファイルは含めない
    let folder = root.join(format!("projects/{id}/conversations"));
    fs::write(folder.join("broken.json"), "{").unwrap();
    fs::write(folder.join("notes.txt"), "x").unwrap();
    fs::write(folder.join("bad name.json"), "{}").unwrap();
    let mut ids = store.conversation_ids(&id, ROOT).unwrap();
    ids.sort();
    assert_eq!(ids, vec!["broken", "conv-a"]);
    let _ = fs::remove_dir_all(&root);
  }

  #[cfg(unix)]
  #[test]
  fn a_linked_conversations_folder_is_refused() {
    let root = temp_root("linked");
    let store = Store::new(root.clone());
    let id = text_project(&store);
    let outside = temp_root("outside");
    fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join(format!("projects/{id}/conversations"))).unwrap();
    let conversation = json!({ "id": "conv-a", "updatedAt": "x" });
    assert_eq!(
      store
        .save_conversation(&id, ROOT, "conv-a", &conversation)
        .unwrap_err()
        .code,
      "store_symlink"
    );
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&outside);
  }
}
