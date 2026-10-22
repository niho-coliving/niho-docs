//! 案件フォルダの読み書き（specs/initiatives/niho-docs.md §4.1）。中身は他のエディタで開いて読める Markdown と JSON。
//!
//! ```text
//! ~/Documents/NIHO docs/
//!   about.json                                     「あなたについて」（呼び名とパーソナライズ。v1。フローと同じ保存先に 1 つ）
//!   flows/<flowId>.json                            フロー 1 本（P4 #18567。複数持つ）
//!   flows/index.json                               { version: 1, order, lastUsed }（フローの並びと、最後に使ったフロー）
//!   flows/active.json                              P4 より前の 1 本（index が無いときだけ 1 本目として読む。最初の書き込みで移す）
//!   flows/samples/<flowId>/<sampleId>.txt          お手本の文書の本文（取り込み時に抽出。samples.rs）
//!   projects/<projectId>/project.json              表示名はここだけ（フォルダ名に使わない）。ページの一覧（pages）もここ
//!   projects/<projectId>/pages/<pageId>.md         文書のページの本文（タイトルは project.json の pages）
//!   projects/<projectId>/recordings/<recId>/       録音のページ（recording.json と、下の録音の中身）
//!   <録音>/inputs/<fileId>.<ext>                   音声の写し（recording.json に hash）・文章は text.md・VTT原本は source.vtt
//!   <録音>/transcript.md                           工程 1 の成果物（文字起こし／文章）
//!   <録音>/artifacts/<stepId>.md                   最新版
//!   <録音>/versions/<stepId>/v_<乱数>.md           実行・保存ごとに追記（工程 1 の stepId は source。旧形式は <連番>.md）
//!   <録音>/runs/<runId>.json                       実行の checkpoint
//!   <録音>/runs.jsonl                              実行と保存の記録（kind: run | save | agent）
//! ```
//!
//! 今の案件（pages の無い project.json）は、案件フォルダ直下を予約 id `root` の録音として読む（ファイルは動かさない。
//! root の録音の値は project.json の flowSnapshot・source・info.speakers・info.language・refs）。root は project.json に
//! flowSnapshot があるときだけある。録音の話者人数・言語・参考（P3）は画面（docs-core の recordingOf）が読み替える。
//!
//! パスは短い乱数の id だけで作る（改名・重複・予約文字・path traversal を避ける）。root の中のリンク（symlink）は拒否する。
//! 書き込みは一時ファイル → rename。同じ案件の実行は 1 つ（`.run.lock` は案件フォルダ直下。同じ案件の 2 つの録音も同時に実行しない）。

use crate::process::{hex, random_bytes};
use crate::samples;
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
// 保存の口（C3 #18595。store_sink.rs）と版（store_versions.rs）
use sink::{
  append_line_plain, appended_lines, json_bytes, notify_changed, save_sink, with_origin, write_atomic_as, write_json_as,
};
pub(crate) use sink::{now_iso, with_captured_save_sink, with_write_lock};
#[cfg(test)]
pub(crate) fn save_writes(writes: Vec<SinkWrite>, kind: SinkKind) -> Result<Option<u64>> {
  sink::save_writes(writes, kind)
}
pub use sink::{set_device_id, set_save_sink, SaveSink, SinkKind, SinkWrite};
use versions::{newest_version_bytes, VersionPlan, WrittenVersion};
pub(crate) use versions::{recording_prefix, resolution_run};

const MAX_ID_CHARS: usize = 64;
/// 1 工程で参照する独立文書の上限（docs-core の RECORDING_AUTO_REFERENCE_MAX と同じ）。
pub(crate) const MAX_REFERENCE_PAGES: usize = 64;
/// 「あなたについて」の本文（パーソナライズ）の字数の上限（docs-core の ABOUT_MAX_CHARS と同じ）。
const ABOUT_MAX_CHARS: usize = 2_000;
const ID_ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
/// 工程 1（文字起こし／文章）の stepId。版は versions/source/、最新版は transcript.md。
pub const SOURCE_STEP_ID: &str = "source";
/// 今の案件の録音（案件フォルダ直下）の予約 id。ID_ALPHABET に `o` が無いので new_id では作られない。
pub const ROOT_RECORDING_ID: &str = "root";
const LOCK_FILE: &str = ".run.lock";
const ROOT_PAGES_FILE: &str = "pages.json";
const RECENT_FILE: &str = "recent.json";
const PROJECTS_INDEX_FILE: &str = "index.json";
const RECENT_LIMIT: usize = 30;
/// root の録音（案件フォルダ直下）の中身。root の録音のページを消すときに消す（project.json・pages/・recordings/・
/// `.run.lock` は案件のものなので残す）。
const ROOT_RECORDING_FILES: [&str; 7] = [
  "transcript.md",
  "artifacts",
  "versions",
  "runs",
  "runs.jsonl",
  "conversations",
  "inputs",
];
pub const AUDIO_EXTENSIONS: [&str; 11] = [
  "m4a", "mp3", "wav", "aac", "aif", "aiff", "aifc", "caf", "mp4", "m4v", "mov",
];
/// 音声の上限（spec §6.2）: 1 ファイル 2 GiB・1 つの録音の合計 6 時間。niho-speech の convert も 1 ファイルを同じ上限で断る
/// （終了コード 3 の `input_too_large`）。
pub const AUDIO_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const AUDIO_TOTAL_MAX_SEC: f64 = 6.0 * 60.0 * 60.0;
/// 画面から受け取る音声表示名の上限。
const MAX_AUDIO_NAME_CHARS: usize = 200;
const IMAGE_MAX_BYTES: u64 = 10 * 1024 * 1024;
const TRANSCRIPT_FILE_MAX_BYTES: usize = 10 * 1024 * 1024;

fn image_type(name: &str) -> Result<&'static str> {
  let Some((id, extension)) = name.split_once('.') else {
    return Err(StoreError::new("store_bad_image", "画像の名前が正しくありません。"));
  };
  validate_id(id)?;
  match extension {
    "jpg" | "jpeg" => Ok("image/jpeg"),
    "png" => Ok("image/png"),
    "webp" => Ok("image/webp"),
    _ => Err(StoreError::new(
      "store_bad_image",
      "JPEG・PNG・WebP の画像を選んでください。",
    )),
  }
}

fn image_signature(bytes: &[u8], mime: &str) -> bool {
  match mime {
    "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
    "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
    "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
    _ => false,
  }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoreError {
  pub code: String,
  pub message: String,
}

impl StoreError {
  pub(crate) fn new(code: &str, message: &str) -> Self {
    Self {
      code: code.to_string(),
      message: message.to_string(),
    }
  }

  fn io(error: std::io::Error) -> Self {
    Self::new("store_io", &format!("保存先の読み書きに失敗しました（{error}）。"))
  }

  fn no_recording() -> Self {
    Self::new("store_no_recording", "録音のページが見つかりません。")
  }

  fn no_page() -> Self {
    Self::new("store_no_page", "ページが見つかりません。")
  }

  fn bad_page(message: &str) -> Self {
    Self::new("store_bad_page", message)
  }

  /// 1 フォルダに録音（音声）は 1 つ（owner 2026-10-18・#18914）。2 つ目を作る・移すのを断る。
  fn folder_has_recording(message: &str) -> Self {
    Self::new("store_folder_has_recording", message)
  }
}

type Result<T> = std::result::Result<T, StoreError>;

/// パスに使える id か（英小文字・数字・`-`・`_`。先頭は英数字）。
pub fn validate_id(id: &str) -> Result<()> {
  let valid = !id.is_empty()
    && id.len() <= MAX_ID_CHARS
    && id
      .chars()
      .next()
      .is_some_and(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
    && id
      .chars()
      .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '_');
  if valid {
    Ok(())
  } else {
    Err(StoreError::new("store_bad_id", "id が正しくありません。"))
  }
}

/// 本人 Mac 実行の runId・チェックポイントの id か。画面が `run_<22字>` と作る id で大文字を含み、`personal-runs/<runId>.json` と
/// `runs/<id>.json` のファイル名になる。文字は入口の `safe_id` と同じ（英数字・`-`・`_`。64 字まで）。小文字だけの `validate_id`
/// で受けると、大文字入りの runId で最初の保存が必ず落ちる。
pub fn validate_run_id(id: &str) -> Result<()> {
  let valid = !id.is_empty()
    && id.len() <= MAX_ID_CHARS
    && id
      .chars()
      .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
  if valid {
    Ok(())
  } else {
    Err(StoreError::new("store_bad_id", "id が正しくありません。"))
  }
}

/// 音声の写しのファイル名か（`<id>.<拡張子>`）。
fn validate_input_file(name: &str) -> Result<()> {
  let Some((stem, ext)) = name.split_once('.') else {
    return Err(StoreError::new("store_bad_id", "音声のファイル名が正しくありません。"));
  };
  validate_id(stem)?;
  if AUDIO_EXTENSIONS.contains(&ext) {
    Ok(())
  } else {
    Err(StoreError::new("store_bad_id", "音声のファイル名が正しくありません。"))
  }
}

/// 短い乱数の id（紛らわしい文字を除いた英小文字と数字）。
pub fn new_id(len: usize) -> String {
  let bytes = random_bytes::<32>().unwrap_or([7u8; 32]);
  bytes
    .iter()
    .take(len.min(32))
    .map(|byte| ID_ALPHABET[(*byte as usize) % ID_ALPHABET.len()] as char)
    .collect()
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<()> {
  write_atomic_as(path, contents, SinkKind::Edit).map(|_| ())
}

/// 一時ファイル → rename（保存の口を通さない）。
fn write_plain(path: &Path, contents: &[u8]) -> Result<()> {
  let parent = path
    .parent()
    .ok_or_else(|| StoreError::new("store_io", "保存先がありません。"))?;
  fs::create_dir_all(parent).map_err(StoreError::io)?;
  let file_name = path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_default();
  let temp = parent.join(format!(".{file_name}.tmp-{}-{}", std::process::id(), new_id(6)));
  {
    let mut file = fs::File::create(&temp).map_err(StoreError::io)?;
    file.write_all(contents).map_err(StoreError::io)?;
    file.sync_all().map_err(StoreError::io)?;
  }
  fs::rename(&temp, path).map_err(StoreError::io)
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
  write_atomic(path, &json_bytes(value)?)
}

/// runs.jsonl の追記前の状態（追記を取り消すとき、この長さへ切り詰める。元から無ければ消す）。
struct RunsSnapshot {
  len: Option<u64>,
  existed: bool,
}

impl RunsSnapshot {
  fn take(runs: &Path) -> Self {
    let metadata = fs::symlink_metadata(runs).ok();
    Self {
      len: metadata.as_ref().filter(|meta| meta.is_file()).map(|meta| meta.len()),
      existed: metadata.is_some(),
    }
  }

  fn restore(&self, runs: &Path) {
    if let Some(length) = self.len {
      if let Ok(file) = fs::OpenOptions::new().write(true).open(runs) {
        let _ = file.set_len(length);
      }
    } else if !self.existed {
      let _ = fs::remove_file(runs);
    }
  }
}

fn read_json(path: &Path) -> Result<Option<Value>> {
  match fs::read_to_string(path) {
    Ok(text) => serde_json::from_str(&text)
      .map(Some)
      .map_err(|_| StoreError::new("store_bad_json", "保存されたデータを読めませんでした。")),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(error) => Err(StoreError::io(error)),
  }
}

fn read_text(path: &Path) -> Result<Option<String>> {
  match fs::read_to_string(path) {
    Ok(text) => Ok(Some(text)),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(error) => Err(StoreError::io(error)),
  }
}

fn read_jsonl(path: &Path) -> Result<Vec<Value>> {
  Ok(
    read_text(path)?
      .unwrap_or_default()
      .lines()
      .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
      .collect(),
  )
}

fn modified_ms(path: &Path) -> u64 {
  fs::metadata(path)
    .and_then(|meta| meta.modified())
    .ok()
    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
    .map(|duration| duration.as_millis() as u64)
    .unwrap_or(0)
}

pub(crate) fn pid_alive(pid: u32) -> bool {
  #[cfg(unix)]
  unsafe {
    libc::kill(pid as libc::pid_t, 0) == 0
  }
  #[cfg(not(unix))]
  {
    let _ = pid;
    true
  }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
  pub id: String,
  pub project: Value,
  pub has_transcript: bool,
  /// `artifacts/` にある工程の id。
  pub artifacts: Vec<String>,
  pub updated_ms: u64,
}

/// 開いた案件（project.json と、ページの一覧の録音・文書の様子）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedProject {
  pub id: String,
  pub project: Value,
  /// 録音のページ（pages の並び。pages の無い今の案件は root だけ）。recording.json を読めない録音は一覧から外す。
  pub recordings: Vec<RecordingEntry>,
  /// 文書のページ（pages の並び）。
  pub docs: Vec<DocEntry>,
}

/// フォルダ内またはフォルダ外のページ一覧。フォルダ外は `project` が None、`project_id` が None。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedPages {
  pub project_id: Option<String>,
  pub project: Option<Value>,
  pub pages: Vec<Value>,
  pub recordings: Vec<RecordingEntry>,
  pub docs: Vec<DocEntry>,
}

/// 録音のページの様子（レールの子ページと済の数に使う）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingEntry {
  pub id: String,
  /// recording.json。root は project.json の flowSnapshot・source を画面が読み替えるので None。
  pub recording: Option<Value>,
  pub has_transcript: bool,
  /// `artifacts/` にある工程の id。
  pub artifacts: Vec<String>,
}

/// 文書のページ（`updated_ms` は pages/<id>.md の mtime。無ければ 0）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocEntry {
  pub id: String,
  pub updated_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentId {
  pub project_id: Option<String>,
  pub page_id: String,
  pub opened_at: String,
}

/// 録音 1 つの中身（工程の成果物・版の記録）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedRecording {
  pub project_id: Option<String>,
  pub id: String,
  /// recording.json（root は None）。
  pub recording: Option<Value>,
  pub transcript: Option<String>,
  /// 工程 id → 最新版。
  pub artifacts: BTreeMap<String, String>,
  pub runs: Vec<Value>,
  /// 今のファイルがいちばん新しい版と違う工程（`source` は文字起こし）。「版を保存」を出す。
  pub unversioned: Vec<String>,
  /// 写しがこの Mac に無い音声（source.audio の `file`。クラウドから取得中・期限切れ）。
  pub missing_inputs: Vec<String>,
}

/// 取り込んだお手本の文書（flow.json の samples の 1 行。docs-core の `FlowSample`）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSample {
  pub id: String,
  /// 元のファイル名（表示用）。
  pub name: String,
  /// 保存した本文の字数。
  pub chars: usize,
  /// 先頭だけを取り込んだときの元の字数。
  #[serde(skip_serializing_if = "Option::is_none")]
  pub truncated_from: Option<usize>,
  /// URL から取り込んだときだけ元の URL。本文は取得時点の写し。
  #[serde(skip_serializing_if = "Option::is_none")]
  pub source_url: Option<String>,
}

/// 書き込みを 1 本にする（版の連番と runs.jsonl の追記が混ざらないように）。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub struct Store {
  root: PathBuf,
}

impl Store {
  pub fn new(root: PathBuf) -> Self {
    Self { root }
  }

  /// root（それ自体はリンクでもよい。実体のパスにする）。
  fn root(&self) -> Result<PathBuf> {
    fs::create_dir_all(&self.root).map_err(StoreError::io)?;
    self.root.canonicalize().map_err(StoreError::io)
  }

  /// root の下のパス。途中にリンクがあれば拒否する（id は 1 階層の名前なので root の外へは出られない）。
  fn path(&self, parts: &[&str]) -> Result<PathBuf> {
    let mut path = self.root()?;
    for part in parts {
      path.push(part);
      if let Ok(meta) = fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() {
          return Err(StoreError::new(
            "store_symlink",
            "保存先の中にリンクがあるため読み書きできません。",
          ));
        }
      }
    }
    Ok(path)
  }

  fn project_dir(&self, project_id: &str) -> Result<PathBuf> {
    validate_id(project_id)?;
    let path = self.path(&["projects", project_id])?;
    if self.path(&["projects", project_id, "project.json"])?.is_file() {
      Ok(path)
    } else {
      Err(StoreError::new("store_no_project", "フォルダが見つかりません。"))
    }
  }

  fn project_file(&self, project_id: &str, parts: &[&str]) -> Result<PathBuf> {
    self.project_dir(project_id)?;
    let mut all = vec!["projects", project_id];
    all.extend_from_slice(parts);
    self.path(&all)
  }

  /// フォルダ内なら projects/<id>、フォルダ外なら保存先直下。画面から path は受け取らない。
  fn page_space(&self, project_id: Option<&str>) -> Result<PathBuf> {
    match project_id {
      Some(id) => self.project_dir(id),
      None => self.root(),
    }
  }

  fn page_space_parts<'a>(&self, project_id: Option<&'a str>) -> Result<Vec<&'a str>> {
    match project_id {
      Some(id) => {
        self.project_dir(id)?;
        Ok(vec!["projects", id])
      }
      None => {
        self.root()?;
        Ok(vec![])
      }
    }
  }

  /// 文書ページの会話がなくなった後、空の親だけを掃除する（内容やリンクがあれば残す）。
  fn remove_empty_page_chats_dir(&self, project_id: Option<&str>) {
    let Ok(mut parts) = self.page_space_parts(project_id) else {
      return;
    };
    parts.push("page-chats");
    let Ok(path) = self.path(&parts) else {
      return;
    };
    if fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink()) {
      let _ = fs::remove_dir(path);
    }
  }

  fn pages_file(&self, project_id: Option<&str>) -> Result<PathBuf> {
    match project_id {
      Some(id) => self.project_file(id, &["project.json"]),
      None => self.path(&[ROOT_PAGES_FILE]),
    }
  }

  fn read_root_pages(&self) -> Result<Value> {
    Ok(read_json(&self.path(&[ROOT_PAGES_FILE])?)?.unwrap_or_else(|| json!({ "version": 1, "order": [], "items": {} })))
  }

  fn read_page_owner(&self, project_id: Option<&str>) -> Result<Value> {
    match project_id {
      Some(id) => self.read_project(id),
      None => self.read_root_pages(),
    }
  }

  /// project.json（id がフォルダ名と同じものだけ）。
  fn read_project(&self, project_id: &str) -> Result<Value> {
    let dir = self.project_dir(project_id)?;
    read_json(&dir.join("project.json"))?
      .filter(|project| Self::id_matches(project, project_id))
      .ok_or_else(|| StoreError::new("store_bad_json", "フォルダの形式が違うため開けません。"))
  }

  /// root の録音があるか（project.json に flowSnapshot がある今の形の案件）。
  fn has_root(project: &Value) -> bool {
    project.get("flowSnapshot").is_some_and(Value::is_object)
  }

  /// 録音の場所: root は案件フォルダ、それ以外は recordings/<recordingId>（recording.json の id が同じものだけ）。
  pub fn recording_dir(&self, project_id: &str, recording_id: &str) -> Result<PathBuf> {
    self.recording_dir_at(Some(project_id), recording_id)
  }

  pub fn recording_dir_at(&self, project_id: Option<&str>, recording_id: &str) -> Result<PathBuf> {
    let recording_id = self.resolve_recording_id_at(project_id, recording_id)?;
    if recording_id == ROOT_RECORDING_ID {
      return self.project_dir(project_id.ok_or_else(StoreError::no_recording)?);
    }
    validate_id(&recording_id)?;
    let mut base = self.page_space_parts(project_id)?;
    base.extend(["recordings", recording_id.as_str()]);
    let dir = self.path(&base)?;
    let mut file_parts = base;
    file_parts.push("recording.json");
    let file = self.path(&file_parts)?;
    let matches = file.is_file()
      && read_json(&file)
        .ok()
        .flatten()
        .is_some_and(|recording| recording.get("id").and_then(Value::as_str) == Some(recording_id.as_str()));
    if matches {
      Ok(dir)
    } else {
      Err(StoreError::no_recording())
    }
  }

  /// 録音の場所のパスの部品（確かめてから返す。中のファイルは `under` で作る）。
  /// 版の path の頭（案件フォルダ・フォルダ外は保存先から見た録音のフォルダ。root は空）。ページ id でも録音 id でもよい（P6
  /// で録音のページ id と録音 id が分かれた）。
  pub(crate) fn recording_prefix_at(&self, project_id: Option<&str>, recording_id: &str) -> Result<String> {
    Ok(recording_prefix(
      &self.resolve_recording_id_at(project_id, recording_id)?,
    ))
  }

  fn resolve_recording_id_at(&self, project_id: Option<&str>, recording_id: &str) -> Result<String> {
    if recording_id != ROOT_RECORDING_ID {
      if let Ok(owner) = self.read_page_owner(project_id) {
        if let Some(page) = Self::page_list(&owner)
          .iter()
          .find(|page| Self::page_id(page) == Some(recording_id) && Self::page_field(page, "kind") == Some("rec"))
        {
          return Self::recording_id(page)
            .map(str::to_string)
            .ok_or_else(StoreError::no_recording);
        }
      }
      return Ok(recording_id.to_string());
    }
    let Some(project_id) = project_id else {
      return Err(StoreError::no_recording());
    };
    let project = self.read_project(project_id)?;
    if Self::has_root(&project) {
      return Ok(ROOT_RECORDING_ID.to_string());
    }
    for page in Self::page_list(&project) {
      if Self::page_field(&page, "kind") != Some("rec")
        || Self::page_field(&page, "title") != Some("")
        || Self::page_field(&page, "createdAt") != project.get("createdAt").and_then(Value::as_str)
      {
        continue;
      }
      let Some(candidate) = Self::recording_id(&page) else {
        continue;
      };
      if candidate == ROOT_RECORDING_ID {
        continue;
      }
      let Ok(dir) = self.recording_dir_at(Some(project_id), candidate) else {
        continue;
      };
      let Ok(Some(recording)) = read_json(&dir.join("recording.json")) else {
        continue;
      };
      if recording.get("pageId").and_then(Value::as_str) == Self::page_id(&page) {
        return Ok(candidate.to_string());
      }
    }
    Err(StoreError::no_recording())
  }

  fn recording_parts<'a>(&self, project_id: &'a str, recording_id: &'a str) -> Result<Vec<Cow<'a, str>>> {
    self.recording_parts_at(Some(project_id), recording_id)
  }

  fn recording_parts_at<'a>(&self, project_id: Option<&'a str>, recording_id: &str) -> Result<Vec<Cow<'a, str>>> {
    let resolved = self.resolve_recording_id_at(project_id, recording_id)?;
    self.recording_dir_at(project_id, &resolved)?;
    let mut parts: Vec<Cow<'a, str>> = self
      .page_space_parts(project_id)?
      .into_iter()
      .map(Cow::Borrowed)
      .collect();
    if resolved != ROOT_RECORDING_ID {
      parts.push(Cow::Borrowed("recordings"));
      parts.push(Cow::Owned(resolved));
    }
    Ok(parts)
  }

  /// `base`（recording_parts）の下のパス。途中のリンクを断る。
  fn under<S: AsRef<str>>(&self, base: &[S], parts: &[&str]) -> Result<PathBuf> {
    let mut all: Vec<&str> = base.iter().map(AsRef::as_ref).collect();
    all.extend_from_slice(parts);
    self.path(&all)
  }

  pub fn recording_file(&self, project_id: &str, recording_id: &str, parts: &[&str]) -> Result<PathBuf> {
    let base = self.recording_parts(project_id, recording_id)?;
    self.under(&base, parts)
  }

  pub fn recording_file_at(&self, project_id: Option<&str>, recording_id: &str, parts: &[&str]) -> Result<PathBuf> {
    let base = self.recording_parts_at(project_id, recording_id)?;
    self.under(&base, parts)
  }

  fn about_path(&self) -> Result<PathBuf> {
    self.path(&["about.json"])
  }

  fn execution_path(&self) -> Result<PathBuf> {
    self.path(&["execution.json"])
  }

  /// 「あなたについて」（保存先の about.json。無ければ None）。
  pub fn load_about(&self) -> Result<Option<Value>> {
    read_json(&self.about_path()?)
  }

  /// 「あなたについて」を保存する。形（version=1・name と text は文字列）と text の字数の上限を確かめ、違えば保存しない。
  pub fn save_about(&self, about: &Value) -> Result<()> {
    let valid = about.get("version") == Some(&json!(1))
      && about.get("name").is_some_and(Value::is_string)
      && about.get("text").is_some_and(Value::is_string);
    if !valid {
      return Err(StoreError::new(
        "store_bad_about",
        "「あなたについて」の形が正しくありません。",
      ));
    }
    let text = about.get("text").and_then(Value::as_str).unwrap_or_default();
    if text.chars().count() > ABOUT_MAX_CHARS {
      return Err(StoreError::new(
        "store_bad_about",
        "「パーソナライズ」は 2,000 字までにしてください。",
      ));
    }
    let _guard = WRITE_LOCK.lock();
    write_json(&self.about_path()?, about)
  }

  /// 本人共通の実行先（資格情報や AI の登録は含めない）。own_mac の宛先が無い値も「未選択」として保存できる。
  pub fn load_execution(&self) -> Result<Option<Value>> {
    read_json(&self.execution_path()?)
  }

  pub fn save_execution(&self, execution: &Value) -> Result<()> {
    let route = execution.get("route").and_then(Value::as_str);
    let target = execution.get("preferredMacRunnerId");
    let valid_target = target.is_some_and(|value| {
      value.is_null()
        || value.as_str().is_some_and(|id| {
          (1..=128).contains(&id.len())
            && id
              .bytes()
              .enumerate()
              .all(|(index, byte)| byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'-')))
        })
    });
    if execution.get("version") != Some(&json!(1))
      || !matches!(route, Some("cloud" | "own_mac"))
      || !valid_target
      || (route == Some("cloud") && !target.is_some_and(Value::is_null))
    {
      return Err(StoreError::new(
        "store_bad_execution",
        "実行先の設定の形が正しくありません。",
      ));
    }
    let _guard = WRITE_LOCK.lock();
    write_json(&self.execution_path()?, execution)
  }

  /// お手本の文書の本文のパス（flows/samples/<flowId>/<sampleId>.txt）。
  fn sample_path(&self, flow_id: &str, sample_id: &str) -> Result<PathBuf> {
    validate_id(flow_id)?;
    validate_id(sample_id)?;
    self.path(&["flows", "samples", flow_id, &format!("{sample_id}.txt")])
  }

  /// お手本の文書を取り込む（本文を抽出して flows/samples/<flowId>/<sampleId>.txt に保存する。flow.json は画面が保存する）。
  pub fn import_sample(&self, flow_id: &str, source: &Path) -> Result<FlowSample> {
    validate_id(flow_id)?;
    // 保存先の途中のリンクは、時間のかかる抽出より先に拒否する
    self.path(&["flows", "samples", flow_id])?;
    let extracted = samples::extract(source)?;
    self.save_sample_text(flow_id, samples::display_name(source), extracted, None)
  }

  /// WebView から届く抽出済み本文も信頼せず、保存直前に URL・題名・字数を検証する。
  pub fn save_url_sample(&self, flow_id: &str, url: &str, name: &str, text: &str) -> Result<FlowSample> {
    validate_id(flow_id)?;
    let url = crate::sample_url::parse_url(url)?;
    if text.len() > 200_000 || name.len() > 800 {
      return Err(StoreError::new(
        "sample_url_body_invalid",
        "取り込む記事が長すぎます。URL からもう一度取り込んでください。",
      ));
    }
    let text = samples::normalize(text);
    let name = samples::normalize(name);
    if name.is_empty()
      || name.chars().count() > 200
      || text.chars().count() < 300
      || text.encode_utf16().count() > 50_000
    {
      return Err(StoreError::new(
        "sample_url_body_invalid",
        "取り込む記事の題名か本文を確認できませんでした。URL からもう一度取り込んでください。",
      ));
    }
    self.save_sample_text(flow_id, name, samples::truncate(text), Some(url.to_string()))
  }

  /// ファイルと URL の本文を同じ保存・削除契約で扱う。
  pub fn save_sample_text(
    &self,
    flow_id: &str,
    name: String,
    extracted: samples::SampleText,
    source_url: Option<String>,
  ) -> Result<FlowSample> {
    validate_id(flow_id)?;
    let _guard = WRITE_LOCK.lock();
    let mut id = new_id(8);
    while self.sample_path(flow_id, &id)?.exists() {
      id = new_id(8);
    }
    write_atomic(&self.sample_path(flow_id, &id)?, extracted.text.as_bytes())?;
    Ok(FlowSample {
      id,
      name,
      chars: extracted.chars,
      truncated_from: extracted.truncated_from,
      source_url,
    })
  }

  pub fn read_sample(&self, flow_id: &str, sample_id: &str) -> Result<String> {
    read_text(&self.sample_path(flow_id, sample_id)?)?.ok_or_else(|| {
      StoreError::new(
        "store_no_sample",
        "お手本の文書の本文が見つかりません。⋯ から削除して、入れ直してください。",
      )
    })
  }

  /// 保存したフローに無いお手本の本文（`<id>.txt`）を消す。フォルダが無ければ何もしない。keep の不正な id は無視する。
  pub fn prune_samples(&self, flow_id: &str, keep: &[String]) -> Result<()> {
    validate_id(flow_id)?;
    let _guard = WRITE_LOCK.lock();
    let dir = self.path(&["flows", "samples", flow_id])?;
    let entries = match fs::read_dir(&dir) {
      Ok(entries) => entries,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
      Err(error) => return Err(StoreError::io(error)),
    };
    let mut removed = Vec::new();
    for entry in entries.filter_map(|entry| entry.ok()) {
      let name = entry.file_name().to_string_lossy().into_owned();
      let Some(id) = name.strip_suffix(".txt") else {
        continue;
      };
      if validate_id(id).is_err() || keep.iter().any(|kept| kept == id) {
        continue;
      }
      if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(true) {
        continue;
      }
      if fs::remove_file(entry.path()).is_ok() {
        removed.push(entry.path());
      }
    }
    notify_changed(&removed);
    Ok(())
  }

  fn artifact_ids(dir: &Path) -> Vec<String> {
    let mut ids: Vec<String> = fs::read_dir(dir.join("artifacts"))
      .map(|entries| {
        entries
          .filter_map(|entry| entry.ok())
          .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".md")?.to_string();
            validate_id(&id).ok().map(|_| id)
          })
          .collect()
      })
      .unwrap_or_default();
    ids.sort();
    ids
  }

  fn project_order(&self, projects: &[ProjectEntry]) -> Result<Vec<String>> {
    let valid: HashSet<&str> = projects.iter().map(|entry| entry.id.as_str()).collect();
    let mut order = Vec::new();
    if let Some(index) = read_json(&self.path(&["projects", PROJECTS_INDEX_FILE])?)? {
      if let Some(saved) = index.get("order").and_then(Value::as_array) {
        for id in saved.iter().filter_map(Value::as_str) {
          if valid.contains(id) && !order.iter().any(|kept| kept == id) {
            order.push(id.to_string());
          }
        }
      }
    }
    let mut missing: Vec<&ProjectEntry> = projects.iter().filter(|entry| !order.contains(&entry.id)).collect();
    missing.sort_by(|a, b| {
      a.project
        .get("createdAt")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .cmp(b.project.get("createdAt").and_then(Value::as_str).unwrap_or_default())
        .then_with(|| a.id.cmp(&b.id))
    });
    order.extend(missing.into_iter().map(|entry| entry.id.clone()));
    Ok(order)
  }

  fn write_project_order_locked(&self, order: &[String]) -> Result<()> {
    write_json(
      &self.path(&["projects", PROJECTS_INDEX_FILE])?,
      &json!({ "version": 1, "order": order }),
    )
  }

  /// フォルダの順を保存する。欠損・重複・stale id は除き、指定されなかった実在フォルダを現在順の末尾へ残す。
  pub fn save_project_order(&self, requested: &[String]) -> Result<Vec<String>> {
    let _guard = WRITE_LOCK.lock();
    for id in requested {
      validate_id(id)?;
    }
    let projects = self.list_projects_unlocked()?;
    let current = self.project_order(&projects)?;
    let valid: HashSet<&str> = projects.iter().map(|entry| entry.id.as_str()).collect();
    let mut order = Vec::new();
    for id in requested.iter().chain(current.iter()) {
      if valid.contains(id.as_str()) && !order.contains(id) {
        order.push(id.clone());
      }
    }
    self.write_project_order_locked(&order)?;
    Ok(order)
  }

  /// 1 つのフォルダを指定位置へ動かす。target が消えた場合は書く前に断る。
  pub fn reorder_project(&self, project_id: &str, before_project_id: Option<&str>) -> Result<Vec<String>> {
    validate_id(project_id)?;
    if let Some(id) = before_project_id {
      validate_id(id)?;
      if id == project_id {
        return Err(StoreError::bad_page("同じフォルダの位置には移動できません。"));
      }
    }
    let _guard = WRITE_LOCK.lock();
    let projects = self.list_projects_unlocked()?;
    let mut order = self.project_order(&projects)?;
    if !order.iter().any(|id| id == project_id) {
      return Err(StoreError::new("store_no_project", "フォルダが見つかりません。"));
    }
    if let Some(target) = before_project_id {
      if !order.iter().any(|id| id == target) {
        return Err(StoreError::new(
          "store_stale_target",
          "移動先が変わりました。もう一度お試しください。",
        ));
      }
    }
    order.retain(|id| id != project_id);
    let index = before_project_id
      .and_then(|target| order.iter().position(|id| id == target))
      .unwrap_or(order.len());
    order.insert(index, project_id.to_string());
    self.write_project_order_locked(&order)?;
    Ok(order)
  }

  /// ページ・共有情報・追加ファイルを持たないフォルダだけを削除する。
  pub fn delete_empty_folder(&self, project_id: &str) -> Result<()> {
    self.migrate_page_owner_at(Some(project_id))?;
    validate_id(project_id)?;
    let _guard = WRITE_LOCK.lock();
    let project = self.read_project(project_id)?;
    let pages = Self::page_list(&project);
    let info = project.get("info");
    let background_empty = info
      .and_then(|value| value.get("background"))
      .and_then(Value::as_str)
      .is_some_and(|value| value.trim().is_empty());
    let terms_empty = match info.and_then(|value| value.get("terms")) {
      None => true,
      Some(Value::Array(terms)) => terms.is_empty(),
      Some(_) => false,
    };
    let entities_empty = match info.and_then(|value| value.get("entities")) {
      None => true,
      Some(Value::Array(entities)) => entities.is_empty(),
      Some(_) => false,
    };
    if !pages.is_empty() || !background_empty || !terms_empty || !entities_empty {
      return Err(StoreError::new(
        "store_folder_not_empty",
        "ページまたは背景情報が残っているため削除できません。ページを移動するか、背景情報と固有名詞を消してください。",
      ));
    }
    if self.run_lock_holder_at(Some(project_id)).is_some() {
      return Err(StoreError::new("store_busy", "処理中のためフォルダを削除できません。"));
    }
    let dir = self.project_dir(project_id)?;
    for entry in Self::plain_entries(&dir) {
      let name = entry.file_name().to_string_lossy().into_owned();
      if name == "project.json" && entry.file_type().is_ok_and(|kind| kind.is_file()) {
        continue;
      }
      if ["inputs", "pages", "recordings", "page-chats"].contains(&name.as_str())
        && entry.file_type().is_ok_and(|kind| kind.is_dir())
        && Self::plain_entries(&entry.path()).is_empty()
      {
        continue;
      }
      return Err(StoreError::new(
        "store_folder_not_empty",
        "フォルダ内にページ以外のデータがあるため削除できません。中身を確認してください。",
      ));
    }
    let projects = self.list_projects_unlocked()?;
    let previous = self.project_order(&projects)?;
    let next: Vec<String> = previous
      .iter()
      .filter(|id| id.as_str() != project_id)
      .cloned()
      .collect();
    self.write_project_order_locked(&next)?;
    let removal = (|| -> Result<()> {
      fs::remove_file(dir.join("project.json")).map_err(StoreError::io)?;
      for name in ["inputs", "pages", "recordings", "page-chats"] {
        let path = dir.join(name);
        if path.exists() {
          fs::remove_dir(path).map_err(StoreError::io)?;
        }
      }
      fs::remove_dir(&dir).map_err(StoreError::io)
    })();
    if let Err(error) = removal {
      let _ = self.write_project_order_locked(&previous);
      return Err(error);
    }
    Ok(())
  }

  fn recent_file(&self) -> Result<PathBuf> {
    self.path(&[RECENT_FILE])
  }

  fn parse_recent(&self) -> Result<Vec<RecentId>> {
    let Some(value) = read_json(&self.recent_file()?)? else {
      return Ok(vec![]);
    };
    if value.get("version").and_then(Value::as_u64) != Some(1) {
      return Err(StoreError::new(
        "store_bad_json",
        "最近開いたページの形式が正しくありません。",
      ));
    }
    let ids = value
      .get("ids")
      .and_then(Value::as_array)
      .ok_or_else(|| StoreError::new("store_bad_json", "最近開いたページの形式が正しくありません。"))?;
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for item in ids {
      let project_id = match item.get("projectId") {
        Some(Value::String(id)) => {
          validate_id(id)
            .map_err(|_| StoreError::new("store_bad_json", "最近開いたページの形式が正しくありません。"))?;
          Some(id.clone())
        }
        Some(Value::Null) => None,
        _ => {
          return Err(StoreError::new(
            "store_bad_json",
            "最近開いたページの形式が正しくありません。",
          ))
        }
      };
      let page_id = item
        .get("pageId")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::new("store_bad_json", "最近開いたページの形式が正しくありません。"))?;
      validate_id(page_id)
        .map_err(|_| StoreError::new("store_bad_json", "最近開いたページの形式が正しくありません。"))?;
      let opened_at = item
        .get("openedAt")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| StoreError::new("store_bad_json", "最近開いたページの形式が正しくありません。"))?;
      let key = (project_id.clone(), page_id.to_string());
      if seen.insert(key) {
        result.push(RecentId {
          project_id,
          page_id: page_id.to_string(),
          opened_at: opened_at.to_string(),
        });
      }
      if result.len() == RECENT_LIMIT {
        break;
      }
    }
    Ok(result)
  }

  fn recent_exists(&self, item: &RecentId) -> bool {
    self
      .read_page_owner(item.project_id.as_deref())
      .ok()
      .is_some_and(|owner| {
        Self::page_list(&owner)
          .iter()
          .any(|page| Self::page_field(page, "id") == Some(item.page_id.as_str()))
      })
  }

  fn write_recent_locked(&self, ids: &[RecentId]) -> Result<()> {
    write_json(&self.recent_file()?, &json!({ "version": 1, "ids": ids }))
  }

  /// 壊れた形は断り、削除・移動済みの参照は返さない（読むだけでは並びも時刻も変えない）。
  pub fn load_recent(&self) -> Result<Vec<RecentId>> {
    Ok(
      self
        .parse_recent()?
        .into_iter()
        .filter(|item| self.recent_exists(item))
        .collect(),
    )
  }

  pub fn touch_recent(&self, project_id: Option<&str>, page_id: &str, opened_at: &str) -> Result<Vec<RecentId>> {
    if let Some(id) = project_id {
      validate_id(id)?;
    }
    validate_id(page_id)?;
    if opened_at.is_empty() {
      return Err(StoreError::new("store_bad_json", "開いた日時が正しくありません。"));
    }
    let _guard = WRITE_LOCK.lock();
    let item = RecentId {
      project_id: project_id.map(str::to_string),
      page_id: page_id.to_string(),
      opened_at: opened_at.to_string(),
    };
    if !self.recent_exists(&item) {
      return Err(StoreError::no_page());
    }
    // recent.json だけが壊れている場合は、本文やページ一覧へ触れず、このメタデータだけを次の有効な open で作り直す。
    let previous = match self.parse_recent() {
      Ok(ids) => ids,
      Err(error) if error.code == "store_bad_json" => vec![],
      Err(error) => return Err(error),
    };
    let mut ids: Vec<RecentId> = previous
      .into_iter()
      .filter(|old| self.recent_exists(old) && !(old.project_id == item.project_id && old.page_id == item.page_id))
      .collect();
    ids.insert(0, item);
    ids.truncate(RECENT_LIMIT);
    self.write_recent_locked(&ids)?;
    Ok(ids)
  }

  /// フォルダの一覧（projects/index.json の順。index が無ければ作成日時順＋id tie break）。
  pub fn list_projects(&self) -> Result<Vec<ProjectEntry>> {
    let mut projects = self.list_projects_unlocked()?;
    let order = self.project_order(&projects)?;
    let positions: BTreeMap<&str, usize> = order
      .iter()
      .enumerate()
      .map(|(index, id)| (id.as_str(), index))
      .collect();
    projects.sort_by_key(|entry| positions.get(entry.id.as_str()).copied().unwrap_or(usize::MAX));
    Ok(projects)
  }

  fn list_projects_unlocked(&self) -> Result<Vec<ProjectEntry>> {
    let dir = self.path(&["projects"])?;
    let entries = match fs::read_dir(&dir) {
      Ok(entries) => entries,
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
      Err(error) => return Err(StoreError::io(error)),
    };
    let mut projects = Vec::new();
    for entry in entries.filter_map(|entry| entry.ok()) {
      let id = entry.file_name().to_string_lossy().into_owned();
      if validate_id(&id).is_err() || entry.file_type().map(|kind| !kind.is_dir()).unwrap_or(true) {
        continue;
      }
      let path = entry.path();
      let Ok(Some(project)) = read_json(&path.join("project.json")) else {
        continue;
      };
      if !Self::id_matches(&project, &id) {
        continue;
      }
      let updated_ms = Self::project_updated_ms(&path);
      let mut has_transcript = false;
      let mut artifacts = HashSet::new();
      for page in Self::page_list(&project) {
        if Self::page_field(&page, "kind") != Some("rec") {
          continue;
        }
        let Some(recording_id) = Self::recording_id(&page) else {
          continue;
        };
        let Ok(recording_dir) = self.recording_dir_at(Some(&id), recording_id) else {
          continue;
        };
        has_transcript |= recording_dir.join("transcript.md").is_file();
        artifacts.extend(Self::artifact_ids(&recording_dir));
      }
      let mut artifacts: Vec<_> = artifacts.into_iter().collect();
      artifacts.sort();
      projects.push(ProjectEntry {
        has_transcript,
        artifacts,
        id,
        project,
        updated_ms,
      });
    }
    Ok(projects)
  }

  /// フォルダの中身（フォルダが無い・リンクなら空）。
  fn plain_entries(dir: &Path) -> Vec<fs::DirEntry> {
    if fs::symlink_metadata(dir)
      .map(|meta| meta.file_type().is_symlink())
      .unwrap_or(true)
    {
      return vec![];
    }
    fs::read_dir(dir)
      .map(|entries| entries.filter_map(|entry| entry.ok()).collect())
      .unwrap_or_default()
  }

  /// 案件で最後に触った時刻（project.json・runs.jsonl・各録音の recording.json と runs.jsonl・文書の本文の mtime の最大）。
  fn project_updated_ms(dir: &Path) -> u64 {
    let mut newest = [dir.join("project.json"), dir.join("runs.jsonl")]
      .iter()
      .map(|file| modified_ms(file))
      .max()
      .unwrap_or(0);
    for entry in Self::plain_entries(&dir.join("recordings")) {
      if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
        let recording = entry.path();
        newest = newest
          .max(modified_ms(&recording.join("recording.json")))
          .max(modified_ms(&recording.join("runs.jsonl")));
      }
    }
    for entry in Self::plain_entries(&dir.join("pages")) {
      if entry.file_name().to_string_lossy().ends_with(".md") && entry.file_type().is_ok_and(|kind| kind.is_file()) {
        newest = newest.max(modified_ms(&entry.path()));
      }
    }
    newest
  }

  /// recordings/ の下の録音のフォルダ名（id の形のものだけ。中身は recording_dir で確かめる）。
  fn recording_ids(&self, project_id: &str) -> Vec<String> {
    self.recording_ids_at(Some(project_id))
  }

  /// フォルダ内外の recordings/ にある id を返す。外側のページもフロー使用数などの対象に含める。
  fn recording_ids_at(&self, project_id: Option<&str>) -> Vec<String> {
    let Ok(mut parts) = self.page_space_parts(project_id) else {
      return vec![];
    };
    parts.push("recordings");
    let Ok(dir) = self.path(&parts) else { return vec![] };
    let mut ids: Vec<String> = Self::plain_entries(&dir)
      .into_iter()
      .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
      .map(|entry| entry.file_name().to_string_lossy().into_owned())
      .filter(|id| validate_id(id).is_ok())
      .collect();
    ids.sort();
    ids
  }

  /// 音声を `inputs`（録音の inputs/ のパスの部品）に写し（SHA-256 を取りながら）、source.audio に入れる形
  /// （file・hash・name・durationSec）を返す。1 ファイル 2 GiB・録音の合計 6 時間（`already_sec` は録音に残す音声の長さ）を
  /// 超えるなら、今回写した分を消して断る。長さが分からないファイルはここでは数えない（文字起こしの前に、sidecar の convert が
  /// 確かめた長さで 1 ファイルの上限と録音の合計を確かめる。speech.rs の `AudioTotal`）。
  fn copy_audio<S: AsRef<str>>(
    &self,
    inputs: &[S],
    sources: &[PathBuf],
    names: &[String],
    already_sec: f64,
  ) -> Result<Vec<Value>> {
    let parts: Vec<&str> = inputs.iter().map(AsRef::as_ref).collect();
    fs::create_dir_all(self.path(&parts)?).map_err(StoreError::io)?;
    let mut copied = Vec::new();
    let mut written: Vec<PathBuf> = Vec::new();
    let mut total_sec = already_sec;
    for (index, source) in sources.iter().enumerate() {
      let meta =
        fs::metadata(source).map_err(|_| StoreError::new("store_bad_audio", "音声ファイルを読めませんでした。"))?;
      let ext = source
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase())
        .filter(|ext| AUDIO_EXTENSIONS.contains(&ext.as_str()));
      let Some(ext) = ext.filter(|_| meta.is_file()) else {
        return Err(StoreError::new("store_bad_audio", "音声ファイルではありません。"));
      };
      if meta.len() > AUDIO_FILE_MAX_BYTES {
        for path in &written {
          let _ = fs::remove_file(path);
        }
        return Err(StoreError::new(
          "store_audio_too_large",
          "音声ファイルが大きすぎます。1 ファイル 2 GB までです。",
        ));
      }
      let file = format!("{}.{ext}", new_id(10));
      let temp_name = format!(".{file}.tmp");
      let dest = self.under(inputs, &[&file])?;
      let temp = self.under(inputs, &[&temp_name])?;
      let mut input =
        fs::File::open(source).map_err(|_| StoreError::new("store_bad_audio", "音声ファイルを読めませんでした。"))?;
      let mut output = fs::File::create(&temp).map_err(StoreError::io)?;
      let mut hasher = Sha256::new();
      let mut buffer = vec![0u8; 1024 * 1024];
      loop {
        let read = input.read(&mut buffer).map_err(StoreError::io)?;
        if read == 0 {
          break;
        }
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read]).map_err(StoreError::io)?;
      }
      output.sync_all().map_err(StoreError::io)?;
      drop(output);
      fs::rename(&temp, &dest).map_err(StoreError::io)?;
      written.push(dest.clone());
      let duration_sec = crate::speech::audio_duration_sec(&dest);
      total_sec += duration_sec.filter(|sec| sec.is_finite() && *sec > 0.0).unwrap_or(0.0);
      if total_sec > AUDIO_TOTAL_MAX_SEC {
        for path in &written {
          let _ = fs::remove_file(path);
        }
        return Err(StoreError::new(
          "store_audio_too_long",
          "音声が長すぎます。1 つの録音の合計 6 時間までです。",
        ));
      }
      let name = names
        .get(index)
        .map(|name| name.trim().chars().take(MAX_AUDIO_NAME_CHARS).collect::<String>())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| {
          source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
        });
      copied.push(json!({
        "file": file,
        "hash": hex(&hasher.finalize()),
        "name": name,
        "durationSec": duration_sec,
      }));
    }
    // 音声の写しは journal を通さず（大きい）、写し終えてから変更として知らせる
    notify_changed(&written);
    Ok(copied)
  }

  /// project.json〔root〕・recording.json に入っている音声のうち `keep`（`file`）の長さの合計（秒。durationSec が無いものは数えない）。
  fn audio_seconds(project: &Value, keep: &[String]) -> f64 {
    project
      .get("source")
      .and_then(|source| source.get("audio"))
      .and_then(Value::as_array)
      .map(|audio| {
        audio
          .iter()
          .filter(|item| {
            item
              .get("file")
              .and_then(Value::as_str)
              .is_some_and(|file| keep.iter().any(|kept| kept == file))
          })
          .filter_map(|item| item.get("durationSec").and_then(Value::as_f64))
          .filter(|sec| sec.is_finite() && *sec > 0.0)
          .sum()
      })
      .unwrap_or(0.0)
  }

  /// 案件を作る（id はここで決める）。音声は写し、文章は inputs/text.md と工程 1 の版 1。保存した project.json を返す。
  pub fn create_project(
    &self,
    project: &Value,
    text: Option<&str>,
    text_record: Option<&Value>,
    audio: &[PathBuf],
  ) -> Result<Value> {
    self.create_project_named(project, text, text_record, audio, &[])
  }

  pub fn create_project_named(
    &self,
    project: &Value,
    text: Option<&str>,
    text_record: Option<&Value>,
    audio: &[PathBuf],
    names: &[String],
  ) -> Result<Value> {
    let _guard = WRITE_LOCK.lock();
    let mut id = new_id(10);
    while self.path(&["projects", &id])?.exists() {
      id = new_id(10);
    }
    let dir = self.path(&["projects", &id])?;
    let mut project = project.clone();
    let initialize_pages = project.get("pages").is_none_or(Value::is_array);
    let legacy_root = Self::has_root(&project);
    let Value::Object(map) = &mut project else {
      return Err(StoreError::new("store_bad_json", "フォルダの形が正しくありません。"));
    };
    map.insert("id".into(), Value::from(id.clone()));
    if initialize_pages {
      map.insert("pages".into(), json!({ "version": 1, "order": [], "items": {} }));
    }
    if !legacy_root {
      if let Some(Value::Object(info)) = map.get_mut("info") {
        info.remove("speakers");
        info.remove("language");
      }
    }
    fs::create_dir_all(dir.join("inputs")).map_err(StoreError::io)?;
    // 音声を先に写す（断ったら案件の置き場ごと消す。project.json を書く前なので同期の記録も残らない）
    if !audio.is_empty() {
      let copied = match self.copy_audio(&["projects", &id, "inputs"], audio, names, 0.0) {
        Ok(copied) => copied,
        Err(error) => {
          let _ = fs::remove_dir_all(&dir);
          return Err(error);
        }
      };
      if let Value::Object(map) = &mut project {
        map.insert("source".into(), json!({ "kind": "audio", "audio": copied }));
      }
    }
    write_json(&dir.join("project.json"), &project)?;
    if let Some(text) = text {
      write_atomic(&dir.join("inputs").join("text.md"), text.as_bytes())?;
      if let Some(record) = text_record {
        Self::write_version_locked(&dir, "", SOURCE_STEP_ID, true, text, record)?;
      }
    }
    let projects = self.list_projects_unlocked()?;
    let order = self.project_order(&projects)?;
    if let Err(error) = self.write_project_order_locked(&order) {
      let _ = fs::remove_dir_all(&dir);
      return Err(error);
    }
    Ok(project)
  }

  /// 音声を録音に足す（写して source.audio に入れる形を返す。書くのは save_project〔root〕か save_recording）。`keep` は
  /// 同じ編集で残す録音の音声（source.audio の `file`）。合計 6 時間には、残す音声と今回足す音声だけを数える（同じ編集で外す
  /// 音声は数えない）。
  pub fn import_audio(
    &self,
    project_id: &str,
    recording_id: &str,
    audio: &[PathBuf],
    keep: &[String],
  ) -> Result<Vec<Value>> {
    self.import_audio_named(project_id, recording_id, audio, &[], keep)
  }

  pub fn import_audio_named(
    &self,
    project_id: &str,
    recording_id: &str,
    audio: &[PathBuf],
    names: &[String],
    keep: &[String],
  ) -> Result<Vec<Value>> {
    self.import_audio_at_named(Some(project_id), recording_id, audio, names, keep)
  }

  pub fn import_audio_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    audio: &[PathBuf],
    keep: &[String],
  ) -> Result<Vec<Value>> {
    self.import_audio_at_named(project_id, recording_id, audio, &[], keep)
  }

  pub fn import_audio_at_named(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    audio: &[PathBuf],
    names: &[String],
    keep: &[String],
  ) -> Result<Vec<Value>> {
    let _guard = WRITE_LOCK.lock();
    let resolved_id = self.resolve_recording_id_at(project_id, recording_id)?;
    let mut inputs = self.recording_parts_at(project_id, recording_id)?;
    let owner = if project_id.is_some() && resolved_id == ROOT_RECORDING_ID {
      Some(self.read_project(project_id.expect("root recording belongs to a folder"))?)
    } else {
      read_json(&self.under(&inputs, &["recording.json"])?)?
    };
    let already_sec = owner.map(|value| Self::audio_seconds(&value, keep)).unwrap_or(0.0);
    inputs.push(Cow::Borrowed("inputs"));
    self.copy_audio(&inputs, audio, names, already_sec)
  }

  /// project.json の id がフォルダ名と同じか（古い `projects/<案件名>/` の形式や、手で写したフォルダは読まない）。
  fn id_matches(project: &Value, project_id: &str) -> bool {
    project.get("id").and_then(Value::as_str) == Some(project_id)
  }

  fn page_field<'a>(page: &'a Value, key: &str) -> Option<&'a str> {
    page.get(key).and_then(Value::as_str)
  }

  fn page_id(page: &Value) -> Option<&str> {
    Self::page_field(page, "id")
  }

  /// 一覧に録音のページがあるか（1 フォルダ 1 音声。#18914）。
  fn has_recording_page(pages: &[Value]) -> bool {
    pages.iter().any(|page| Self::page_field(page, "kind") == Some("rec"))
  }

  fn recording_id(page: &Value) -> Option<&str> {
    Self::page_field(page, "recordingId").or_else(|| Self::page_id(page))
  }

  fn index_page(id: &str, entry: &Value) -> Option<Value> {
    let kind = match Self::page_field(entry, "kind")? {
      "document" | "doc" => "doc",
      "recording" | "rec" => "rec",
      _ => return None,
    };
    let mut page = json!({
      "id": id,
      "kind": kind,
      "title": entry.get("title").and_then(Value::as_str).unwrap_or_default(),
      "createdAt": entry.get("createdAt").and_then(Value::as_str).unwrap_or_default(),
    });
    if kind == "rec" {
      if let Some(recording_id) = entry.get("recordingId").and_then(Value::as_str) {
        page["recordingId"] = Value::from(recording_id);
      }
    } else {
      if let Some(receipt) = entry.get("derivation") {
        page["derivation"] = receipt.clone();
      }
      if let Some(generation) = entry.get("moveGeneration").and_then(Value::as_u64) {
        page["moveGeneration"] = json!(generation);
      }
    }
    Some(page)
  }

  fn page_index(pages: &[Value]) -> Value {
    let mut order = Vec::new();
    let mut items = serde_json::Map::new();
    for page in pages {
      let Some(id) = Self::page_id(page) else { continue };
      let Some(kind) = Self::page_field(page, "kind") else {
        continue;
      };
      let kind = match kind {
        "doc" | "document" => "document",
        "rec" | "recording" => "recording",
        _ => continue,
      };
      if items.contains_key(id) {
        continue;
      }
      let mut entry = json!({
        "kind": kind,
        "title": page.get("title").and_then(Value::as_str).unwrap_or_default(),
        "createdAt": page.get("createdAt").and_then(Value::as_str).unwrap_or_default(),
      });
      if kind == "recording" {
        entry["recordingId"] = Value::from(Self::recording_id(page).unwrap_or(id));
      } else {
        if let Some(receipt) = page.get("derivation") {
          entry["derivation"] = receipt.clone();
        }
        // 文書ページの移動世代。移動前の会話を閲覧だけにする（録音の recording.json の moveGeneration と同じ契約）
        if let Some(generation) = page.get("moveGeneration").and_then(Value::as_u64) {
          entry["moveGeneration"] = json!(generation);
        }
      }
      order.push(Value::from(id));
      items.insert(id.to_string(), entry);
    }
    json!({ "version": 1, "order": order, "items": items })
  }

  /// pages を初めて書くときの並び（root があれば先頭に。title は空）。
  fn initial_pages(project: &Value) -> Vec<Value> {
    if Self::has_root(project) {
      vec![json!({
        "id": ROOT_RECORDING_ID,
        "kind": "rec",
        "recordingId": ROOT_RECORDING_ID,
        "title": "",
        "createdAt": project.get("createdAt").cloned().unwrap_or_else(|| Value::from("")),
      })]
    } else {
      vec![]
    }
  }

  /// ページの一覧（pages が無い今の案件は、root があれば root の録音 1 枚。docs-core の projectPages と同じ）。
  fn page_list(project: &Value) -> Vec<Value> {
    let mut pages = match project.get("pages") {
      Some(Value::Array(pages)) => pages.clone(),
      Some(index) if index.get("order").is_some() && index.get("items").is_some() => {
        match (
          index.get("order").and_then(Value::as_array),
          index.get("items").and_then(Value::as_object),
        ) {
          (Some(order), Some(items)) => order
            .iter()
            .filter_map(Value::as_str)
            .filter_map(|id| items.get(id).and_then(|entry| Self::index_page(id, entry)))
            .collect(),
          _ => vec![],
        }
      }
      None if project.get("order").is_some() && project.get("items").is_some() => {
        match (
          project.get("order").and_then(Value::as_array),
          project.get("items").and_then(Value::as_object),
        ) {
          (Some(order), Some(items)) => order
            .iter()
            .filter_map(Value::as_str)
            .filter_map(|id| items.get(id).and_then(|entry| Self::index_page(id, entry)))
            .collect(),
          _ => vec![],
        }
      }
      _ => Self::initial_pages(project),
    };
    if Self::has_root(project) && !pages.iter().any(|page| Self::page_id(page) == Some(ROOT_RECORDING_ID)) {
      pages.insert(0, Self::initial_pages(project).remove(0));
    }
    pages
  }

  fn global_id_in_use(&self, id: &str) -> bool {
    if self.path(&["projects", id]).is_ok_and(|path| path.exists()) {
      return true;
    }
    let mut spaces = vec![self.root().ok()];
    if let Ok(projects) = self.path(&["projects"]) {
      for entry in Self::plain_entries(&projects) {
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
          let project_owner = read_json(&entry.path().join("project.json")).ok().flatten();
          if project_owner.as_ref().is_some_and(|owner| {
            Self::page_list(owner)
              .iter()
              .any(|page| Self::page_id(page) == Some(id) || Self::recording_id(page) == Some(id))
          }) {
            return true;
          }
          spaces.push(Some(entry.path()));
        }
      }
    }
    if let Some(root) = spaces.first().and_then(Option::as_ref) {
      if let Ok(Some(owner)) = read_json(&root.join(ROOT_PAGES_FILE)) {
        if Self::page_list(&owner)
          .iter()
          .any(|page| Self::page_id(page) == Some(id) || Self::recording_id(page) == Some(id))
        {
          return true;
        }
      }
    }
    spaces
      .into_iter()
      .flatten()
      .any(|space| space.join("pages").join(format!("{id}.md")).exists() || space.join("recordings").join(id).exists())
  }

  fn fresh_global_id(&self, used: &mut HashSet<String>) -> String {
    loop {
      let id = new_id(10);
      if used.insert(id.clone()) && !self.global_id_in_use(&id) {
        return id;
      }
    }
  }

  fn page_index_is_canonical(owner: &Value) -> bool {
    let index = owner.get("pages").unwrap_or(owner);
    if index.get("version").and_then(Value::as_u64) != Some(1) {
      return false;
    }
    let (Some(order), Some(items)) = (
      index.get("order").and_then(Value::as_array),
      index.get("items").and_then(Value::as_object),
    ) else {
      return false;
    };
    if order.len() != items.len() {
      return false;
    }
    let mut seen = HashSet::new();
    order.iter().all(|value| {
      let Some(id) = value.as_str() else { return false };
      if validate_id(id).is_err() || !seen.insert(id) {
        return false;
      }
      let Some(entry) = items.get(id) else { return false };
      match Self::page_field(entry, "kind") {
        Some("document") => entry.get("recordingId").is_none(),
        Some("recording") => entry
          .get("recordingId")
          .and_then(Value::as_str)
          .is_some_and(|recording_id| {
            validate_id(recording_id).is_ok() && recording_id != id && seen.insert(recording_id)
          }),
        _ => false,
      }
    })
  }

  fn canonical_recording(raw: &Value, recording_id: &str, page_id: &str, project: Option<&Value>) -> Value {
    let project_info = project.and_then(|value| value.get("info"));
    let old_info = raw.get("info");
    let speakers = raw
      .get("speakers")
      .or_else(|| old_info.and_then(|value| value.get("speakers")))
      .or_else(|| project_info.and_then(|value| value.get("speakers")))
      .cloned()
      .unwrap_or_else(|| json!("auto"));
    let language = raw
      .get("language")
      .or_else(|| old_info.and_then(|value| value.get("language")))
      .or_else(|| project_info.and_then(|value| value.get("language")))
      .cloned()
      .unwrap_or_else(|| json!("ja"));
    let mut recording = json!({
      "version": raw.get("version").cloned().unwrap_or_else(|| json!(1)),
      "id": recording_id,
      "pageId": page_id,
      "createdAt": raw.get("createdAt").cloned().unwrap_or_else(|| json!("")),
      "flowSnapshot": raw.get("flowSnapshot").cloned().unwrap_or(Value::Null),
      "info": { "speakers": speakers, "language": language },
      "source": raw.get("source").cloned().unwrap_or_else(|| json!({ "kind": "audio", "audio": [] })),
      "refs": raw.get("refs").cloned().unwrap_or_else(|| json!([])),
    });
    if let Some(generation) = raw.get("moveGeneration") {
      recording["moveGeneration"] = generation.clone();
    }
    if let Some(candidate_sets) = raw.get("candidateSets") {
      recording["candidateSets"] = candidate_sets.clone();
    }
    if let Some(selected) = raw.get("sourceCandidateId").filter(|value| value.is_string()) {
      recording["sourceCandidateId"] = selected.clone();
    }
    recording
  }

  fn runtime_recording(raw: &Value) -> Value {
    let mut recording = raw.clone();
    if let Value::Object(fields) = &mut recording {
      if let Some(info) = fields.remove("info").and_then(|value| value.as_object().cloned()) {
        if let Some(speakers) = info.get("speakers") {
          fields.insert("speakers".into(), speakers.clone());
        }
        if let Some(language) = info.get("language") {
          fields.insert("language".into(), language.clone());
        }
      }
    }
    recording
  }

  fn recording_page_id(owner: &Value, recording_id: &str) -> Option<String> {
    Self::page_list(owner)
      .iter()
      .find(|page| Self::recording_id(page) == Some(recording_id))
      .and_then(Self::page_id)
      .map(str::to_string)
  }

  /// 旧 API の `root` を、移行後も残る元 root 録音ページへ解決する。
  fn resolve_page_id_at(&self, project_id: Option<&str>, page_id: &str) -> Result<String> {
    if page_id != ROOT_RECORDING_ID {
      return Ok(page_id.to_string());
    }
    let Some(project_id) = project_id else {
      return Err(StoreError::no_page());
    };
    let owner = self.read_page_owner(Some(project_id))?;
    if Self::page_list(&owner)
      .iter()
      .any(|page| Self::page_id(page) == Some(page_id))
    {
      return Ok(page_id.to_string());
    }
    let created_at = owner.get("createdAt").and_then(Value::as_str);
    for page in Self::page_list(&owner) {
      if Self::page_field(&page, "kind") != Some("rec")
        || Self::page_field(&page, "title") != Some("")
        || Self::page_field(&page, "createdAt") != created_at
      {
        continue;
      }
      let Some(id) = Self::page_id(&page) else { continue };
      let Some(recording_id) = Self::recording_id(&page) else {
        continue;
      };
      let Ok(dir) = self.recording_dir_at(Some(project_id), recording_id) else {
        continue;
      };
      if read_json(&dir.join("recording.json"))
        .ok()
        .flatten()
        .is_some_and(|recording| recording.get("pageId").and_then(Value::as_str) == Some(id))
      {
        return Ok(id.to_string());
      }
    }
    Err(StoreError::no_page())
  }

  /// P1〜P5 の配列台帳と root 録音を、一度だけ PageIndex と独立した録音IDへ移す。
  fn migrate_page_owner_at(&self, project_id: Option<&str>) -> Result<()> {
    let _guard = WRITE_LOCK.lock();
    let mut owner = self.read_page_owner(project_id)?;
    let has_root = project_id.is_some() && Self::has_root(&owner);
    let raw_pages = owner.get("pages").cloned();
    if Self::page_index_is_canonical(&owner) && !has_root {
      return Ok(());
    }
    if project_id.is_none() && raw_pages.is_none() {
      return Ok(());
    }
    let mut old_pages = Self::page_list(&owner);
    if has_root
      && !old_pages
        .iter()
        .any(|page| Self::page_id(page) == Some(ROOT_RECORDING_ID))
    {
      old_pages.insert(0, Self::initial_pages(&owner).remove(0));
    }
    if raw_pages.is_none() && !has_root && project_id.is_some() {
      old_pages.clear();
    }

    let mut used = HashSet::new();
    let mut pages = Vec::new();
    let mut document_moves: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut recording_moves: Vec<(PathBuf, PathBuf, Value, bool)> = Vec::new();
    let mut id_map = HashMap::new();

    for old in old_pages {
      let Some(old_id) = Self::page_id(&old).map(str::to_string) else {
        continue;
      };
      validate_id(&old_id).map_err(|_| StoreError::new("store_bad_json", "既存ページの id が正しくありません。"))?;
      let Some(kind) = Self::page_field(&old, "kind") else {
        continue;
      };
      let page_id = self.fresh_global_id(&mut used);
      let mut page = json!({
        "id": page_id,
        "kind": if kind == "doc" || kind == "document" { "doc" } else { "rec" },
        "title": old.get("title").and_then(Value::as_str).unwrap_or_default(),
        "createdAt": old.get("createdAt").and_then(Value::as_str).unwrap_or_default(),
      });
      id_map.insert(old_id.clone(), page_id.clone());
      if kind == "doc" || kind == "document" {
        let old_file = format!("{old_id}.md");
        let new_file = format!("{page_id}.md");
        let mut from_parts = self.page_space_parts(project_id)?;
        from_parts.extend(["pages", old_file.as_str()]);
        let mut to_parts = self.page_space_parts(project_id)?;
        to_parts.extend(["pages", new_file.as_str()]);
        let from = self.path(&from_parts)?;
        let to = self.path(&to_parts)?;
        if from.exists() {
          if to.exists() {
            return Err(StoreError::new("store_conflict", "移行先に同じ文書ページがあります。"));
          }
          document_moves.push((from, to));
        }
      } else if kind == "rec" || kind == "recording" {
        let recording_id = self.fresh_global_id(&mut used);
        page["recordingId"] = Value::from(recording_id.clone());
        let old_recording_id = Self::recording_id(&old).unwrap_or(old_id.as_str()).to_string();
        validate_id(&old_recording_id)
          .map_err(|_| StoreError::new("store_bad_json", "既存録音の id が正しくありません。"))?;
        let is_root = project_id.is_some() && old_recording_id == ROOT_RECORDING_ID;
        if is_root {
          let project_id = project_id.expect("legacy root belongs to a folder");
          for name in ROOT_RECORDING_FILES {
            self.path(&["projects", project_id, name])?;
          }
        }
        let raw_recording = if is_root {
          let mut raw = json!({
            "version": 1,
            "createdAt": old.get("createdAt").cloned().unwrap_or_else(|| owner.get("createdAt").cloned().unwrap_or_else(|| json!(""))),
            "flowSnapshot": owner.get("flowSnapshot").cloned().unwrap_or(Value::Null),
            "source": owner.get("source").cloned().unwrap_or_else(|| json!({ "kind": "audio", "audio": [] })),
            "speakers": owner.get("info").and_then(|info| info.get("speakers")).cloned().unwrap_or_else(|| json!("auto")),
            "language": owner.get("info").and_then(|info| info.get("language")).cloned().unwrap_or_else(|| json!("ja")),
            "refs": owner.get("refs").cloned().unwrap_or_else(|| json!([])),
          });
          if let Some(candidate_sets) = owner.get("candidateSets") {
            raw["candidateSets"] = candidate_sets.clone();
          }
          if let Some(selected) = owner.get("sourceCandidateId").filter(|value| value.is_string()) {
            raw["sourceCandidateId"] = selected.clone();
          }
          raw
        } else {
          let mut parts = self.page_space_parts(project_id)?;
          parts.extend(["recordings", old_recording_id.as_str(), "recording.json"]);
          read_json(&self.path(&parts)?)?.ok_or_else(StoreError::no_recording)?
        };
        let canonical = Self::canonical_recording(&raw_recording, &recording_id, &page_id, Some(&owner));
        let mut from_parts = self.page_space_parts(project_id)?;
        if !is_root {
          from_parts.extend(["recordings", old_recording_id.as_str()]);
        }
        let mut to_parts = self.page_space_parts(project_id)?;
        to_parts.extend(["recordings", recording_id.as_str()]);
        recording_moves.push((self.path(&from_parts)?, self.path(&to_parts)?, canonical, is_root));
      } else {
        continue;
      }
      pages.push(page);
    }

    // 旧録音の参考は文書ページIDを指すため、文書IDを振り直した後に更新する。
    for (_, _, recording, _) in &mut recording_moves {
      if let Some(refs) = recording.get_mut("refs").and_then(Value::as_array_mut) {
        for reference in refs {
          if let Some(old_id) = reference.as_str() {
            if let Some(new_id) = id_map.get(old_id) {
              *reference = Value::from(new_id.clone());
            }
          }
        }
      }
    }

    let mut moved_docs = Vec::new();
    let mut moved_recordings: Vec<(PathBuf, PathBuf, Option<Value>, bool)> = Vec::new();
    let rollback = |moved_docs: &[(PathBuf, PathBuf)], moved_recordings: &[(PathBuf, PathBuf, Option<Value>, bool)]| {
      for (from, to) in moved_docs.iter().rev() {
        let _ = fs::rename(to, from);
      }
      for (from, to, original, is_root) in moved_recordings.iter().rev() {
        if *is_root {
          for name in ROOT_RECORDING_FILES {
            let old = from.join(name);
            let new = to.join(name);
            if new.exists() {
              let _ = fs::rename(new, old);
            }
          }
          let _ = fs::remove_file(to.join("recording.json"));
          let _ = fs::remove_dir(to);
        } else {
          if let Some(original) = original {
            let _ = write_json(&to.join("recording.json"), original);
          }
          let _ = fs::rename(to, from);
        }
      }
    };
    for (from, to) in &document_moves {
      if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(StoreError::io)?;
      }
      if let Err(error) = fs::rename(from, to) {
        rollback(&moved_docs, &moved_recordings);
        return Err(StoreError::io(error));
      }
      moved_docs.push((from.clone(), to.clone()));
    }
    for (from, to, canonical, is_root) in &recording_moves {
      let original = if *is_root {
        None
      } else {
        read_json(&from.join("recording.json"))?
      };
      if *is_root {
        fs::create_dir_all(to).map_err(StoreError::io)?;
        if let Err(error) = write_json(&to.join("recording.json"), canonical) {
          let _ = fs::remove_dir(to);
          rollback(&moved_docs, &moved_recordings);
          return Err(error);
        }
        for name in ROOT_RECORDING_FILES {
          let source = from.join(name);
          if !source.exists() {
            continue;
          }
          if let Err(error) = fs::rename(&source, to.join(name)) {
            let mut partial = moved_recordings.clone();
            partial.push((from.clone(), to.clone(), None, true));
            rollback(&moved_docs, &partial);
            return Err(StoreError::io(error));
          }
        }
      } else {
        if to.exists() {
          rollback(&moved_docs, &moved_recordings);
          return Err(StoreError::new("store_conflict", "移行先に同じ録音があります。"));
        }
        if let Some(parent) = to.parent() {
          fs::create_dir_all(parent).map_err(StoreError::io)?;
        }
        if let Err(error) = fs::rename(from, to) {
          rollback(&moved_docs, &moved_recordings);
          return Err(StoreError::io(error));
        }
        if let Err(error) = write_json(&to.join("recording.json"), canonical) {
          let _ = fs::rename(to, from);
          rollback(&moved_docs, &moved_recordings);
          return Err(error);
        }
      }
      moved_recordings.push((from.clone(), to.clone(), original, *is_root));
    }

    if let Value::Object(fields) = &mut owner {
      fields.insert("pages".into(), Self::page_index(&pages));
      if has_root {
        for key in ["flowSnapshot", "source", "refs", "candidateSets", "sourceCandidateId"] {
          fields.remove(key);
        }
        if let Some(Value::Object(info)) = fields.get_mut("info") {
          info.remove("speakers");
          info.remove("language");
        }
      }
    }
    if let Err(error) = write_json(&self.pages_file(project_id)?, &owner) {
      rollback(&moved_docs, &moved_recordings);
      return Err(error);
    }
    if !id_map.is_empty() {
      if let Ok(Some(mut recent)) = read_json(&self.recent_file()?) {
        if let Some(ids) = recent.get_mut("ids").and_then(Value::as_array_mut) {
          for item in ids {
            let matching_space = match (project_id, item.get("projectId")) {
              (Some(expected), Some(Value::String(actual))) => expected == actual,
              (None, Some(Value::Null)) => true,
              _ => false,
            };
            if !matching_space {
              continue;
            }
            if let Some(old_id) = item.get("pageId").and_then(Value::as_str).map(str::to_string) {
              if let Some(new_id) = id_map.get(&old_id) {
                item["pageId"] = Value::from(new_id.clone());
              }
            }
          }
          let _ = write_json(&self.recent_file()?, &recent);
        }
      }
    }
    Ok(())
  }

  /// 案件とページの一覧の様子（録音は recording.json と成果物の有無、文書は本文の mtime）。
  pub fn load_project(&self, project_id: &str) -> Result<LoadedProject> {
    self.migrate_page_owner_at(Some(project_id))?;
    let project = self.read_project(project_id)?;
    let mut recordings = Vec::new();
    let mut docs = Vec::new();
    for page in Self::page_list(&project) {
      let (Some(id), Some(kind)) = (Self::page_id(&page), Self::page_field(&page, "kind")) else {
        continue;
      };
      match kind {
        "rec" => {
          let Some(recording_id) = Self::recording_id(&page) else {
            continue;
          };
          // 読めない recording.json の録音は、案件ごと開けなくせずに一覧から外す
          if let Ok(entry) = self.recording_entry(project_id, recording_id) {
            recordings.push(entry);
          }
        }
        "doc" if validate_id(id).is_ok() => {
          let updated_ms = self
            .path(&["projects", project_id, "pages", &format!("{id}.md")])
            .map(|file| modified_ms(&file))
            .unwrap_or(0);
          docs.push(DocEntry {
            id: id.to_string(),
            updated_ms,
          });
        }
        _ => {}
      }
    }
    Ok(LoadedProject {
      id: project_id.to_string(),
      project,
      recordings,
      docs,
    })
  }

  /// フォルダ内外のページ一覧。外側は `pages.json` が無くても空として開き、読むだけでは作らない。
  pub fn load_pages(&self, project_id: Option<&str>) -> Result<LoadedPages> {
    self.migrate_page_owner_at(project_id)?;
    let owner = self.read_page_owner(project_id)?;
    let pages = Self::page_list(&owner);
    let mut recordings = Vec::new();
    let mut docs = Vec::new();
    for page in &pages {
      let (Some(id), Some(kind)) = (Self::page_id(page), Self::page_field(page, "kind")) else {
        continue;
      };
      match kind {
        "rec" => {
          let Some(recording_id) = Self::recording_id(page) else {
            continue;
          };
          if let Ok(entry) = self.recording_entry_at(project_id, recording_id) {
            recordings.push(entry);
          }
        }
        "doc" if validate_id(id).is_ok() => {
          let updated_ms = self
            .doc_file_at(project_id, id)
            .map(|file| modified_ms(&file))
            .unwrap_or(0);
          docs.push(DocEntry {
            id: id.to_string(),
            updated_ms,
          });
        }
        _ => {}
      }
    }
    Ok(LoadedPages {
      project_id: project_id.map(str::to_string),
      project: project_id.map(|_| owner),
      pages,
      recordings,
      docs,
    })
  }

  fn recording_entry(&self, project_id: &str, recording_id: &str) -> Result<RecordingEntry> {
    self.recording_entry_at(Some(project_id), recording_id)
  }

  fn recording_entry_at(&self, project_id: Option<&str>, recording_id: &str) -> Result<RecordingEntry> {
    let recording_id = self.resolve_recording_id_at(project_id, recording_id)?;
    let base = self.recording_parts_at(project_id, &recording_id)?;
    let dir = self.under(&base, &[])?;
    let recording = if project_id.is_some() && recording_id == ROOT_RECORDING_ID {
      None
    } else {
      Some(Self::runtime_recording(
        &read_json(&self.under(&base, &["recording.json"])?)?.ok_or_else(StoreError::no_recording)?,
      ))
    };
    Ok(RecordingEntry {
      id: recording_id,
      recording,
      has_transcript: self.under(&base, &["transcript.md"])?.is_file(),
      artifacts: Self::artifact_ids(&dir),
    })
  }

  /// 録音 1 つの中身（recording.json・工程 1 の成果物・最新版・記録）。
  pub fn load_recording(&self, project_id: &str, recording_id: &str) -> Result<LoadedRecording> {
    self.load_recording_at(Some(project_id), recording_id)
  }

  pub fn load_recording_at(&self, project_id: Option<&str>, recording_id: &str) -> Result<LoadedRecording> {
    self.migrate_page_owner_at(project_id)?;
    let recording_id = self.resolve_recording_id_at(project_id, recording_id)?;
    let base = self.recording_parts_at(project_id, &recording_id)?;
    let dir = self.under(&base, &[])?;
    let recording = if project_id.is_some() && recording_id == ROOT_RECORDING_ID {
      None
    } else {
      read_json(&self.under(&base, &["recording.json"])?)?.map(|recording| Self::runtime_recording(&recording))
    };
    let mut artifacts = BTreeMap::new();
    for id in Self::artifact_ids(&dir) {
      if let Some(text) = read_text(&self.under(&base, &["artifacts", &format!("{id}.md")])?)? {
        artifacts.insert(id, text);
      }
    }
    let transcript = read_text(&self.under(&base, &["transcript.md"])?)?;
    let runs = read_jsonl(&self.under(&base, &["runs.jsonl"])?)?;
    // 今のファイルがいちばん新しい版と違う工程（自動保存した書きかけ・版の無い文書）
    let prefix = recording_prefix(&recording_id);
    let unversioned = transcript
      .iter()
      .map(|text| (SOURCE_STEP_ID, text))
      .chain(artifacts.iter().map(|(id, text)| (id.as_str(), text)))
      .filter(|(step_id, text)| newest_version_bytes(&dir, &prefix, step_id, &runs).as_deref() != Some(text.as_bytes()))
      .map(|(step_id, _)| step_id.to_string())
      .collect();
    // 音声の写しが無いもの（別の Mac で足して、まだ取得していない・クラウドで期限が切れた）
    let owner = match project_id {
      // root の録音（フォルダ直下）は project.json が持ち主
      Some(project_id) if recording_id == ROOT_RECORDING_ID => Some(self.read_project(project_id)?),
      _ => recording.clone(),
    };
    let missing_inputs = owner
      .map(|owner| Self::audio_files(&owner))
      .unwrap_or_default()
      .into_iter()
      .filter(|file| validate_input_file(file).is_ok() && !dir.join("inputs").join(file).is_file())
      .collect();
    Ok(LoadedRecording {
      project_id: project_id.map(str::to_string),
      id: recording_id,
      recording,
      transcript,
      artifacts,
      runs,
      unversioned,
      missing_inputs,
    })
  }

  /// 音声の写しのファイル名（project.json〔root〕・recording.json の source.audio[].file）。
  pub fn audio_files(project: &Value) -> Vec<String> {
    project
      .get("source")
      .and_then(|source| source.get("audio"))
      .and_then(Value::as_array)
      .map(|audio| {
        audio
          .iter()
          .filter_map(|item| item.get("file").and_then(Value::as_str).map(str::to_string))
          .collect()
      })
      .unwrap_or_default()
  }

  /// 録音の音声の写しのパス（文字起こしに渡す）。
  pub fn audio_paths(&self, project_id: &str, recording_id: &str) -> Result<Vec<PathBuf>> {
    self.audio_paths_at(Some(project_id), recording_id)
  }

  pub fn audio_paths_at(&self, project_id: Option<&str>, recording_id: &str) -> Result<Vec<PathBuf>> {
    let resolved_id = self.resolve_recording_id_at(project_id, recording_id)?;
    let base = self.recording_parts_at(project_id, recording_id)?;
    let owner = if project_id.is_some() && resolved_id == ROOT_RECORDING_ID {
      self.read_project(project_id.expect("root recording belongs to a folder"))?
    } else {
      read_json(&self.under(&base, &["recording.json"])?)?.ok_or_else(StoreError::no_recording)?
    };
    Self::audio_files(&owner)
      .iter()
      .map(|file| {
        validate_input_file(file)?;
        self.under(&base, &["inputs", file])
      })
      .collect()
  }

  /// 音声の写しの持ち主（root は project.json、それ以外は recording.json）を書き、使わなくなった写しを消す。
  /// WRITE_LOCK の中で呼ぶ。写しの無いファイル名は書かない（既に載っている音声は、クラウドから取得中・期限切れで
  /// この Mac に写しが無くても、そのまま書ける）。
  fn write_with_audio(&self, project_id: &str, base: &[&str], file: &str, value: &Value, prune: bool) -> Result<()> {
    self.write_with_audio_at(Some(project_id), base, file, value, prune)
  }

  fn write_with_audio_at<S: AsRef<str>>(
    &self,
    project_id: Option<&str>,
    base: &[S],
    file: &str,
    value: &Value,
    prune: bool,
  ) -> Result<()> {
    let keep: HashSet<String> = Self::audio_files(value).into_iter().collect();
    let listed: HashSet<String> = read_json(&self.under(base, &[file])?)
      .ok()
      .flatten()
      .map(|disk| Self::audio_files(&disk).into_iter().collect())
      .unwrap_or_default();
    for name in &keep {
      validate_input_file(name)?;
      if !self.under(base, &["inputs", name])?.is_file() && !listed.contains(name) {
        return Err(StoreError::new("store_bad_audio", "音声の写しが見つかりません。"));
      }
    }
    write_json(&self.under(base, &[file])?, value)?;
    // 実行中（文字起こしが写しを読んでいるかもしれない）は消さない。次の保存で消す
    if !prune || self.run_lock_holder_at(project_id).is_some() {
      return Ok(());
    }
    let Ok(inputs) = self.under(base, &["inputs"]) else {
      return Ok(());
    };
    let mut removed = Vec::new();
    for entry in Self::plain_entries(&inputs) {
      let name = entry.file_name().to_string_lossy().into_owned();
      if validate_input_file(&name).is_ok() && !keep.contains(&name) && fs::remove_file(entry.path()).is_ok() {
        removed.push(entry.path());
      }
    }
    notify_changed(&removed);
    Ok(())
  }

  /// 案件情報を保存する（フォルダは id のまま）。ページの一覧（pages）はディスクのものを保つ（ページの command だけが
  /// 変える）。root の録音の使わなくなった音声の写しは消す。
  pub fn save_project(&self, project_id: &str, project: &Value) -> Result<()> {
    self.migrate_page_owner_at(Some(project_id))?;
    let _guard = WRITE_LOCK.lock();
    let dir = self.project_dir(project_id)?;
    if !Self::id_matches(project, project_id) {
      return Err(StoreError::new("store_bad_json", "フォルダの id が食い違っています。"));
    }
    let mut project = project.clone();
    let Value::Object(map) = &mut project else {
      return Err(StoreError::new("store_bad_json", "フォルダの形が正しくありません。"));
    };
    let disk_pages = read_json(&dir.join("project.json"))?
      .and_then(|disk| disk.get("pages").cloned())
      .unwrap_or_else(|| json!({ "version": 1, "order": [], "items": {} }));
    map.insert("pages".into(), disk_pages);
    if let Some(candidate_sets) =
      read_json(&dir.join("project.json"))?.and_then(|disk| disk.get("candidateSets").cloned())
    {
      map.insert("candidateSets".into(), candidate_sets);
    } else {
      map.remove("candidateSets");
    }
    for key in ["flowSnapshot", "source", "refs", "candidateSets", "sourceCandidateId"] {
      map.remove(key);
    }
    if let Some(Value::Object(info)) = map.get_mut("info") {
      info.remove("speakers");
      info.remove("language");
    }
    let prune = Self::has_root(&project);
    self.write_with_audio(project_id, &["projects", project_id], "project.json", &project, prune)
  }

  /// 録音ページの recording.json を保存する。使わなくなった音声の写しは消す。
  pub fn save_recording(&self, project_id: &str, recording_id: &str, recording: &Value) -> Result<()> {
    self.save_recording_at(Some(project_id), recording_id, recording)
  }

  pub fn save_recording_at(&self, project_id: Option<&str>, recording_id: &str, recording: &Value) -> Result<()> {
    self.migrate_page_owner_at(project_id)?;
    let recording_id = self.resolve_recording_id_at(project_id, recording_id)?;
    if project_id.is_some() && recording_id == ROOT_RECORDING_ID {
      return Err(StoreError::bad_page("この録音はフォルダといっしょに保存してください。"));
    }
    let _guard = WRITE_LOCK.lock();
    let base = self.recording_parts_at(project_id, &recording_id)?;
    if recording.get("id").and_then(Value::as_str) != Some(recording_id.as_str())
      && recording.get("id").and_then(Value::as_str) != Some(ROOT_RECORDING_ID)
    {
      return Err(StoreError::new("store_bad_json", "録音の id が食い違っています。"));
    }
    if !recording.is_object() {
      return Err(StoreError::new("store_bad_json", "録音の形が正しくありません。"));
    }
    let owner = self.read_page_owner(project_id)?;
    let page_id = Self::recording_page_id(&owner, &recording_id)
      .or_else(|| recording.get("pageId").and_then(Value::as_str).map(str::to_string))
      .ok_or_else(StoreError::no_page)?;
    let mut persisted = Self::canonical_recording(recording, &recording_id, &page_id, Some(&owner));
    // 案の台帳と後工程に使う文字起こしの指定は専用の command だけが変える（古い画面の写しで消したり戻したりしない）
    let disk = read_json(&self.under(&base, &["recording.json"])?)?;
    for key in ["candidateSets", "sourceCandidateId"] {
      if let Some(value) = disk.as_ref().and_then(|disk| disk.get(key)).cloned() {
        persisted[key] = value;
      } else if let Value::Object(fields) = &mut persisted {
        fields.remove(key);
      }
    }
    self.write_with_audio_at(project_id, &base, "recording.json", &persisted, true)
  }

  fn candidate_owner_at<'a>(
    &self,
    project_id: Option<&'a str>,
    recording_id: &str,
  ) -> Result<(PathBuf, Value, Vec<Cow<'a, str>>)> {
    let resolved = self.resolve_recording_id_at(project_id, recording_id)?;
    let base = self.recording_parts_at(project_id, &resolved)?;
    let file = if resolved == ROOT_RECORDING_ID {
      self.under(&base, &["project.json"])?
    } else {
      self.under(&base, &["recording.json"])?
    };
    let owner = read_json(&file)?.ok_or_else(StoreError::no_recording)?;
    Ok((file, owner, base))
  }

  fn validate_candidate_set(owner: &Value, step_id: &str, set: &Value, new_artifact_id: &str) -> Result<()> {
    validate_id(step_id)?;
    validate_id(new_artifact_id)?;
    let steps = owner
      .get("flowSnapshot")
      .and_then(|flow| flow.get("steps"))
      .and_then(Value::as_array)
      .ok_or_else(|| StoreError::new("store_bad_json", "録音の工程が正しくありません。"))?;
    if step_id == SOURCE_STEP_ID {
      // 文字起こし（工程 1）の案は音声のある録音だけ（#19108。文章から作った録音は文字起こしをしない）
      let has_audio = owner
        .get("source")
        .filter(|source| source.get("kind").and_then(Value::as_str) == Some("audio"))
        .and_then(|source| source.get("audio"))
        .and_then(Value::as_array)
        .is_some_and(|audio| !audio.is_empty());
      if !has_audio {
        return Err(StoreError::bad_page("音声のある録音だけ、文字起こしを追加できます。"));
      }
    } else {
      let Some(index) = steps
        .iter()
        .position(|step| step.get("id").and_then(Value::as_str) == Some(step_id))
      else {
        return Err(StoreError::bad_page("案の工程が録音にありません。"));
      };
      // 別案を作れるのは最後の工程だけ（どのフローでも常に作れる。工程ごとの出力設定は持たない）。
      if index + 1 != steps.len() {
        return Err(StoreError::bad_page("複数案は最後の工程にだけ追加できます。"));
      }
    }
    if set.get("stepId").and_then(Value::as_str) != Some(step_id) {
      return Err(StoreError::new("store_bad_json", "案の工程が食い違っています。"));
    }
    let order = set
      .get("order")
      .and_then(Value::as_array)
      .ok_or_else(|| StoreError::new("store_bad_json", "案の並びが正しくありません。"))?;
    let items = set
      .get("items")
      .and_then(Value::as_object)
      .ok_or_else(|| StoreError::new("store_bad_json", "案の台帳が正しくありません。"))?;
    if order.len() < 2
      || order.len() != items.len()
      || !items
        .values()
        .any(|item| item.get("artifactId").and_then(Value::as_str) == Some(new_artifact_id))
    {
      return Err(StoreError::new("store_bad_json", "追加する案が台帳にありません。"));
    }
    if new_artifact_id == step_id || new_artifact_id == SOURCE_STEP_ID {
      return Err(StoreError::new(
        "store_bad_json",
        "新しい案の保存先が既存本文と重なっています。",
      ));
    }
    let first_artifact = order
      .first()
      .and_then(Value::as_str)
      .and_then(|id| items.get(id))
      .and_then(|item| item.get("artifactId"))
      .and_then(Value::as_str);
    if first_artifact != Some(step_id) {
      return Err(StoreError::new(
        "store_bad_json",
        "最初の案は既存本文を保持してください。",
      ));
    }
    let flow_artifacts: HashSet<&str> = steps
      .iter()
      .filter_map(|step| step.get("id").and_then(Value::as_str))
      .collect();
    let mut ordered = HashSet::new();
    let mut artifacts = HashSet::new();
    for id in order {
      let id = id
        .as_str()
        .ok_or_else(|| StoreError::new("store_bad_json", "案の id が正しくありません。"))?;
      validate_id(id)?;
      if !ordered.insert(id) {
        return Err(StoreError::new("store_bad_json", "案の並びが重複しています。"));
      }
      let item = items
        .get(id)
        .ok_or_else(|| StoreError::new("store_bad_json", "案の台帳が正しくありません。"))?;
      if item.get("id").and_then(Value::as_str) != Some(id) {
        return Err(StoreError::new(
          "store_bad_json",
          "案の id と台帳のキーが食い違っています。",
        ));
      }
      let artifact_id = item
        .get("artifactId")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::new("store_bad_json", "案の保存先が正しくありません。"))?;
      validate_id(artifact_id)?;
      if !artifacts.insert(artifact_id) {
        return Err(StoreError::new("store_bad_json", "案の保存先が重複しています。"));
      }
      if artifact_id != step_id && (artifact_id == SOURCE_STEP_ID || flow_artifacts.contains(artifact_id)) {
        return Err(StoreError::new(
          "store_bad_json",
          "案の保存先が共有工程と重なっています。",
        ));
      }
    }
    for (candidate_id, _) in items {
      if !ordered.contains(candidate_id.as_str()) {
        return Err(StoreError::new(
          "store_bad_json",
          "案の台帳に並びの無い項目があります。",
        ));
      }
    }
    if let Some(all_sets) = owner.get("candidateSets").and_then(Value::as_object) {
      for (other_step_id, other_set) in all_sets {
        let Some(other_items) = other_set.get("items").and_then(Value::as_object) else {
          continue;
        };
        for (other_id, other) in other_items {
          let Some(other_artifact) = other.get("artifactId").and_then(Value::as_str) else {
            continue;
          };
          let same_existing = other_step_id == step_id
            && items
              .get(other_id)
              .and_then(|item| item.get("artifactId"))
              .and_then(Value::as_str)
              == Some(other_artifact);
          if !same_existing && artifacts.contains(other_artifact) {
            return Err(StoreError::new(
              "store_bad_json",
              "案の保存先が別の案と重なっています。",
            ));
          }
        }
      }
    }
    Ok(())
  }

  /// 最新の録音メタデータへ案台帳を足す。複製本文がある場合は本文・初版・記録と台帳を一括で確定する。
  pub fn create_candidate_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    step_id: &str,
    candidate_set: &Value,
    new_artifact_id: &str,
    duplicate_markdown: Option<&str>,
    record: Option<&Value>,
  ) -> Result<()> {
    self.create_candidate_with(
      project_id,
      recording_id,
      step_id,
      candidate_set,
      new_artifact_id,
      duplicate_markdown,
      record,
      write_json,
    )
  }

  fn create_candidate_with(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    step_id: &str,
    candidate_set: &Value,
    new_artifact_id: &str,
    duplicate_markdown: Option<&str>,
    record: Option<&Value>,
    commit: impl FnOnce(&Path, &Value) -> Result<()>,
  ) -> Result<()> {
    self.migrate_page_owner_at(project_id)?;
    let _guard = WRITE_LOCK.lock();
    let (owner_file, mut owner, base) = self.candidate_owner_at(project_id, recording_id)?;
    Self::validate_candidate_set(&owner, step_id, candidate_set, new_artifact_id)?;
    let mut committed_set = candidate_set.clone();
    if let Some(disk_set) = owner.get("candidateSets").and_then(|sets| sets.get(step_id)) {
      let new_item = candidate_set
        .get("items")
        .and_then(|items| items.as_object())
        .and_then(|items| {
          items
            .values()
            .find(|item| item.get("artifactId").and_then(Value::as_str) == Some(new_artifact_id))
        })
        .cloned()
        .ok_or_else(|| StoreError::new("store_bad_json", "追加する案が台帳にありません。"))?;
      let new_id = new_item
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| StoreError::new("store_bad_json", "案の id が正しくありません。"))?
        .to_string();
      let mut merged = disk_set.clone();
      {
        let items = merged
          .get_mut("items")
          .and_then(Value::as_object_mut)
          .ok_or_else(|| StoreError::new("store_bad_json", "案の台帳が正しくありません。"))?;
        if items.contains_key(&new_id)
          || items
            .values()
            .any(|item| item.get("artifactId").and_then(Value::as_str) == Some(new_artifact_id))
        {
          return Err(StoreError::bad_page("案の保存先がすでに使われています。"));
        }
        items.insert(new_id.clone(), new_item);
      }
      merged
        .get_mut("order")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| StoreError::new("store_bad_json", "案の並びが正しくありません。"))?
        .push(json!(new_id));
      committed_set = merged;
    }
    let dir = self.under(&base, &[])?;
    let latest = dir.join("artifacts").join(format!("{new_artifact_id}.md"));
    let versions = dir.join("versions").join(new_artifact_id);
    if latest.exists() || versions.exists() {
      return Err(StoreError::bad_page("案の保存先がすでに使われています。"));
    }
    let runs = dir.join("runs.jsonl");
    let runs_before = RunsSnapshot::take(&runs);
    if let Some(markdown) = duplicate_markdown {
      let record = record.ok_or_else(|| StoreError::new("store_bad_json", "複製の記録がありません。"))?;
      Self::write_version_locked(
        &dir,
        &self.recording_prefix_at(project_id, recording_id)?,
        new_artifact_id,
        false,
        markdown,
        record,
      )?;
    }
    let sets = owner
      .as_object_mut()
      .ok_or_else(|| StoreError::new("store_bad_json", "録音の形が正しくありません。"))?
      .entry("candidateSets")
      .or_insert_with(|| json!({}));
    let sets = sets
      .as_object_mut()
      .ok_or_else(|| StoreError::new("store_bad_json", "案の台帳が正しくありません。"))?;
    sets.insert(step_id.to_string(), committed_set);
    if let Err(error) = commit(&owner_file, &owner) {
      if duplicate_markdown.is_some() {
        let _ = fs::remove_file(&latest);
        let _ = fs::remove_dir_all(&versions);
        runs_before.restore(&runs);
      }
      return Err(error);
    }
    Ok(())
  }

  /// 最新の案台帳に対して名前だけを変更する。通常の録音保存からは台帳を変更しない。
  pub fn rename_candidate_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    step_id: &str,
    candidate_id: &str,
    name: &str,
  ) -> Result<()> {
    validate_id(step_id)?;
    validate_id(candidate_id)?;
    if name.trim().is_empty() {
      return Err(StoreError::bad_page("案名を入力してください。"));
    }
    let _guard = WRITE_LOCK.lock();
    let (file, mut owner, _) = self.candidate_owner_at(project_id, recording_id)?;
    let candidate = owner
      .get_mut("candidateSets")
      .and_then(|sets| sets.get_mut(step_id))
      .and_then(|set| set.get_mut("items"))
      .and_then(|items| items.get_mut(candidate_id))
      .and_then(Value::as_object_mut)
      .ok_or_else(|| StoreError::bad_page("案が見つかりません。"))?;
    candidate.insert("name".into(), json!(name.trim()));
    write_json(&file, &owner)
  }

  /// 後工程に使う文字起こしの案を変える（#19108）。`expected` は画面が知っている今の指定（無ければ最初の案）で、ディスクの指定と
  /// 違えば別の端末や画面が先に変えたので書かない。台帳に無い案は選べない。通常の録音保存からはこの指定を変えない。
  pub fn set_source_candidate_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    candidate_id: &str,
    expected: Option<&str>,
  ) -> Result<()> {
    validate_id(candidate_id)?;
    let _guard = WRITE_LOCK.lock();
    let (file, mut owner, _) = self.candidate_owner_at(project_id, recording_id)?;
    let current = owner.get("sourceCandidateId").and_then(Value::as_str);
    if current != expected {
      return Err(StoreError::new(
        "store_conflict",
        "後工程に使う文字起こしが、ほかの画面で変わりました。開き直してから選んでください。",
      ));
    }
    let exists = owner
      .get("candidateSets")
      .and_then(|sets| sets.get(SOURCE_STEP_ID))
      .and_then(|set| set.get("items"))
      .and_then(|items| items.get(candidate_id))
      .is_some();
    if !exists {
      return Err(StoreError::bad_page("後工程に使う文字起こしが見つかりません。"));
    }
    owner
      .as_object_mut()
      .ok_or_else(|| StoreError::new("store_bad_json", "録音の形が正しくありません。"))?
      .insert("sourceCandidateId".into(), json!(candidate_id));
    write_json(&file, &owner)
  }

  /// 素材の無い録音（音声 0 本・文字起こし無し）に文章を貼る: inputs/text.md・工程 1 の版 1・source を文章に。
  pub fn set_recording_text(&self, project_id: &str, recording_id: &str, text: &str, record: &Value) -> Result<()> {
    self.set_recording_text_at(Some(project_id), recording_id, text, record)
  }

  pub fn set_recording_text_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    text: &str,
    record: &Value,
  ) -> Result<()> {
    self.set_recording_text_with(project_id, recording_id, text, record, write_json)
  }

  /// 素材の無い録音へVTT原本・派生Markdown・工程1の版・source metadataを同じ操作で確定する。
  pub fn import_transcript_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    name: &str,
    original: &[u8],
    markdown: &str,
    record: &Value,
  ) -> Result<()> {
    self.import_transcript_with(project_id, recording_id, name, original, markdown, record, write_json)
  }

  /// 最後の recording.json commit を差し替えられる本体。失敗時の全ロールバックを対象テストで確かめる。
  fn import_transcript_with(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    name: &str,
    original: &[u8],
    markdown: &str,
    record: &Value,
    commit: impl FnOnce(&Path, &Value) -> Result<()>,
  ) -> Result<()> {
    const REFUSED: &str = "音声か原文が入った録音には、文字起こしファイルを取り込めません。";
    self.migrate_page_owner_at(project_id)?;
    if original.is_empty() || markdown.trim().is_empty() {
      return Err(StoreError::bad_page("VTTファイルに発言がありません。"));
    }
    if original.len() > TRANSCRIPT_FILE_MAX_BYTES {
      return Err(StoreError::bad_page(
        "VTTファイルが大きすぎます。分けてから取り込んでください。",
      ));
    }
    if markdown.len() as u64 > niho_desktop_vault::TEXT_MAX_BYTES {
      return Err(StoreError::bad_page(
        "変換後の文字起こしが大きすぎます。VTTファイルを分けてから取り込んでください。",
      ));
    }
    let valid_name = !name.is_empty()
      && name.chars().count() <= MAX_AUDIO_NAME_CHARS
      && !name.chars().any(char::is_control)
      && !name.contains('/')
      && !name.contains('\\')
      && name.to_ascii_lowercase().ends_with(".vtt");
    if !valid_name {
      return Err(StoreError::bad_page("VTTファイルの名前が正しくありません。"));
    }

    let _guard = WRITE_LOCK.lock();
    let base = self.recording_parts_at(project_id, recording_id)?;
    let file = self.under(&base, &["recording.json"])?;
    let mut recording = read_json(&file)?.ok_or_else(StoreError::no_recording)?;
    let empty_audio = recording
      .get("source")
      .and_then(|source| source.get("kind"))
      .and_then(Value::as_str)
      == Some("audio")
      && Self::audio_files(&recording).is_empty();
    let original_file = self.under(&base, &["inputs", "source.vtt"])?;
    let pasted_text = self.under(&base, &["inputs", "text.md"])?;
    let source_versions = self.under(&base, &["versions", SOURCE_STEP_ID])?;
    if !empty_audio
      || self.under(&base, &["transcript.md"])?.exists()
      || original_file.exists()
      || pasted_text.exists()
      || source_versions.exists()
    {
      return Err(StoreError::bad_page(REFUSED));
    }

    write_atomic(&original_file, original)?;
    let dir = self.under(&base, &[])?;
    let runs = dir.join("runs.jsonl");
    let runs_before = RunsSnapshot::take(&runs);
    let prefix = self.recording_prefix_at(project_id, recording_id)?;
    let written = match Self::write_version(&dir, &prefix, SOURCE_STEP_ID, true, markdown, record) {
      Ok(written) => written,
      Err(error) => {
        let _ = fs::remove_file(&original_file);
        notify_changed(&[original_file]);
        return Err(error);
      }
    };
    let hash = hex(&Sha256::digest(original));
    if let Value::Object(map) = &mut recording {
      map.insert(
        "source".into(),
        json!({
          "kind": "text",
          "transcriptImport": { "format": "vtt", "file": "source.vtt", "name": name, "hash": hash }
        }),
      );
    }
    if let Err(error) = commit(&file, &recording) {
      let versions = dir.join("versions").join(SOURCE_STEP_ID);
      for path in &written.files {
        let _ = fs::remove_file(path);
      }
      let _ = fs::remove_dir(&versions);
      let transcript = dir.join("transcript.md");
      let _ = fs::remove_file(&transcript);
      runs_before.restore(&runs);
      let _ = fs::remove_file(&original_file);
      let mut changed = written.files;
      changed.extend([transcript, runs, original_file]);
      notify_changed(&changed);
      return Err(error);
    }
    Ok(())
  }

  /// `set_recording_text` の本体。最後の recording.json の書き込み（`commit`）が失敗したら、足した文章・版・最新の文字起こし・
  /// 実行記録をすべて元へ戻す（戻さないと「文章が入った録音」と見なされ、失敗の後に貼り直せない）。
  fn set_recording_text_with(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    text: &str,
    record: &Value,
    commit: impl FnOnce(&Path, &Value) -> Result<()>,
  ) -> Result<()> {
    const REFUSED: &str = "音声か文章が入った録音には、文章を貼れません。";
    self.migrate_page_owner_at(project_id)?;
    if text.trim().is_empty() {
      return Err(StoreError::bad_page("文章を入れてください。"));
    }
    let _guard = WRITE_LOCK.lock();
    let base = self.recording_parts_at(project_id, recording_id)?;
    let file = self.under(&base, &["recording.json"])?;
    let mut recording = read_json(&file)?.ok_or_else(StoreError::no_recording)?;
    let empty_audio = recording
      .get("source")
      .and_then(|source| source.get("kind"))
      .and_then(Value::as_str)
      == Some("audio")
      && Self::audio_files(&recording).is_empty();
    let text_file = self.under(&base, &["inputs", "text.md"])?;
    if !empty_audio
      || self.under(&base, &["transcript.md"])?.exists()
      || text_file.exists()
      || self.under(&base, &["inputs", "source.vtt"])?.exists()
      || self.under(&base, &["versions", SOURCE_STEP_ID])?.exists()
    {
      return Err(StoreError::bad_page(REFUSED));
    }
    write_atomic(&text_file, text.as_bytes())?;
    let dir = self.under(&base, &[])?;
    let runs = dir.join("runs.jsonl");
    let runs_before = RunsSnapshot::take(&runs);
    let prefix = self.recording_prefix_at(project_id, recording_id)?;
    let written = match Self::write_version(&dir, &prefix, SOURCE_STEP_ID, true, text, record) {
      Ok(written) => written,
      Err(error) => {
        let _ = fs::remove_file(&text_file);
        notify_changed(&[text_file]);
        return Err(error);
      }
    };
    if let Value::Object(map) = &mut recording {
      map.insert("source".into(), json!({ "kind": "text" }));
    }
    if let Err(error) = commit(&file, &recording) {
      // 版のファイルはまだどこにも送っていないので、この Mac で消して戻す（保存の口には変更として知らせる）
      let versions = dir.join("versions").join(SOURCE_STEP_ID);
      for path in &written.files {
        let _ = fs::remove_file(path);
      }
      let _ = fs::remove_dir(&versions);
      let transcript = dir.join("transcript.md");
      let _ = fs::remove_file(&transcript);
      runs_before.restore(&runs);
      let _ = fs::remove_file(&text_file);
      let mut changed = written.files;
      changed.extend([transcript, runs, text_file]);
      notify_changed(&changed);
      return Err(error);
    }
    Ok(())
  }

  // ---- ページ（すべて WRITE_LOCK の中で project.json を読み・変え・書く） ----

  /// pages を書き換えて project.json を書く。
  fn write_pages(&self, project_id: &str, project: &mut Value, pages: Vec<Value>) -> Result<()> {
    self.write_pages_at(Some(project_id), project, pages)
  }

  fn write_pages_at(&self, project_id: Option<&str>, owner: &mut Value, pages: Vec<Value>) -> Result<()> {
    Self::set_page_index(project_id, owner, &pages)?;
    write_json(&self.pages_file(project_id)?, owner)
  }

  /// ページ一覧（フォルダは project.json の pages、フォルダ外は pages.json 全体）を書き換える（書き込みはしない）。
  fn set_page_index(project_id: Option<&str>, owner: &mut Value, pages: &[Value]) -> Result<()> {
    let index = Self::page_index(pages);
    if project_id.is_some() {
      let Value::Object(map) = owner else {
        return Err(StoreError::new("store_bad_json", "ページ一覧の形が正しくありません。"));
      };
      map.insert("pages".into(), index);
    } else {
      *owner = index;
    }
    Ok(())
  }

  /// 文書のページの本文のパス（pages に文書として載っているものだけ）。
  fn doc_file(&self, project_id: &str, page_id: &str) -> Result<PathBuf> {
    self.doc_file_at(Some(project_id), page_id)
  }

  fn doc_file_at(&self, project_id: Option<&str>, page_id: &str) -> Result<PathBuf> {
    validate_id(page_id)?;
    let owner = self.read_page_owner(project_id)?;
    let is_doc = Self::page_list(&owner)
      .iter()
      .any(|page| Self::page_field(page, "id") == Some(page_id) && Self::page_field(page, "kind") == Some("doc"));
    if !is_doc {
      return Err(StoreError::no_page());
    }
    let mut parts = self.page_space_parts(project_id)?;
    let file = format!("{page_id}.md");
    parts.extend(["pages", file.as_str()]);
    self.path(&parts)
  }

  /// 編集用 capture が開いてよい、台帳に載った文書本文の実 path。
  pub(crate) fn editable_page_file_at(&self, project_id: Option<&str>, page_id: &str) -> Result<PathBuf> {
    self.migrate_page_owner_at(project_id)?;
    self.current_editable_page_file_at(project_id, page_id)
  }

  /// migration 後の台帳を project gate 内で再照合する（書き込みはしない）。
  pub(crate) fn current_editable_page_file_at(&self, project_id: Option<&str>, page_id: &str) -> Result<PathBuf> {
    self.doc_file_at(project_id, page_id)
  }

  /// 編集用 capture が開いてよい、実在する録音に属する現在の文字起こし／成果物の実 path。
  pub(crate) fn editable_artifact_file_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    step_id: &str,
    source: bool,
  ) -> Result<PathBuf> {
    self.migrate_page_owner_at(project_id)?;
    self.current_editable_artifact_file_at(project_id, recording_id, step_id, source)
  }

  /// migration 後の録音台帳を project gate 内で再照合する（書き込みはしない）。
  pub(crate) fn current_editable_artifact_file_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    step_id: &str,
    source: bool,
  ) -> Result<PathBuf> {
    validate_id(step_id)?;
    if source != (step_id == SOURCE_STEP_ID) {
      return Err(StoreError::new("store_bad_id", "工程の場所が正しくありません。"));
    }
    let (_, owner, base) = self.candidate_owner_at(project_id, recording_id)?;
    if source {
      self.under(&base, &["transcript.md"])
    } else {
      let flow_step = owner
        .get("flowSnapshot")
        .and_then(|flow| flow.get("steps"))
        .and_then(Value::as_array)
        .is_some_and(|steps| {
          steps
            .iter()
            .any(|step| step.get("id").and_then(Value::as_str) == Some(step_id))
        });
      let candidate_artifact = owner
        .get("candidateSets")
        .and_then(Value::as_object)
        .is_some_and(|sets| {
          sets.values().any(|set| {
            set.get("items").and_then(Value::as_object).is_some_and(|items| {
              items
                .values()
                .any(|item| item.get("artifactId").and_then(Value::as_str) == Some(step_id))
            })
          })
        });
      if !flow_step && !candidate_artifact {
        return Err(StoreError::bad_page("録音にない工程の本文は開けません。"));
      }
      self.under(&base, &["artifacts", &format!("{step_id}.md")])
    }
  }

  /// ページを足す（id はここで決める）。文書は空の本文、録音は recording.json と inputs/。pages が無ければ初期化する
  /// （root があれば先頭に）。足した pages の 1 行を返す。
  pub fn create_page(
    &self,
    project_id: &str,
    kind: &str,
    title: &str,
    created_at: &str,
    recording: Option<&Value>,
  ) -> Result<Value> {
    self.create_page_at(Some(project_id), kind, title, created_at, recording)
  }

  pub fn create_page_at(
    &self,
    project_id: Option<&str>,
    kind: &str,
    title: &str,
    created_at: &str,
    recording: Option<&Value>,
  ) -> Result<Value> {
    self.migrate_page_owner_at(project_id)?;
    if kind != "doc" && kind != "rec" {
      return Err(StoreError::bad_page("ページの種類が正しくありません。"));
    }
    let _guard = WRITE_LOCK.lock();
    let mut project = self.read_page_owner(project_id)?;
    let mut pages = Self::page_list(&project);
    // フォルダの音声は 1 セット（#18914）。足すときは背景情報のページの音声へ。フォルダの外は今のまま
    if kind == "rec" && project_id.is_some() && Self::has_recording_page(&pages) {
      return Err(StoreError::folder_has_recording(
        "このフォルダにはもう音声があります。背景情報のページで音声を追加してください。",
      ));
    }
    let mut used = pages
      .iter()
      .filter_map(Self::page_id)
      .map(str::to_string)
      .collect::<HashSet<_>>();
    let id = self.fresh_global_id(&mut used);
    let recording_id = (kind == "rec").then(|| self.fresh_global_id(&mut used));
    let mut entry = json!({ "id": id, "kind": kind, "title": title, "createdAt": created_at });
    if let Some(recording_id) = &recording_id {
      entry["recordingId"] = Value::from(recording_id.clone());
    }
    if kind == "doc" {
      let mut parts = self.page_space_parts(project_id)?;
      let name = format!("{id}.md");
      parts.extend(["pages", name.as_str()]);
      let file = self.path(&parts)?;
      write_atomic(&file, b"")?;
      pages.push(entry.clone());
      if let Err(error) = self.write_pages_at(project_id, &mut project, pages) {
        let _ = fs::remove_file(&file);
        return Err(error);
      }
      return Ok(entry);
    }
    let Some(Value::Object(fields)) = recording else {
      return Err(StoreError::new("store_bad_json", "録音の形が正しくありません。"));
    };
    let recording = Value::Object(fields.clone());
    // 新しい録音の音声は、足してから save_recording で書く（まだ写しが無い）
    if !Self::audio_files(&recording).is_empty() {
      return Err(StoreError::new("store_bad_audio", "音声の写しが見つかりません。"));
    }
    let recording_id = recording_id.as_deref().expect("recording pages receive a recording id");
    let mut rec_parts = self.page_space_parts(project_id)?;
    rec_parts.extend(["recordings", recording_id]);
    let dir = self.path(&rec_parts)?;
    let mut inputs_parts = rec_parts.clone();
    inputs_parts.push("inputs");
    let mut file_parts = rec_parts;
    file_parts.push("recording.json");
    let written = self
      .path(&inputs_parts)
      .and_then(|inputs| fs::create_dir_all(inputs).map_err(StoreError::io))
      .and_then(|_| self.path(&file_parts))
      .and_then(|file| {
        write_json(
          &file,
          &Self::canonical_recording(&recording, recording_id, &id, Some(&project)),
        )
      });
    if let Err(error) = written {
      let _ = fs::remove_dir_all(&dir);
      return Err(error);
    }
    // フォルダの録音だけ先頭に入れ、背景情報 › 工程のページ › 自分のページの順にする（owner 2026-10-18・#18914）。
    // 文書とフォルダの外のページは作成順で末尾に加える。
    if kind == "rec" && project_id.is_some() {
      pages.insert(0, entry.clone());
    } else {
      pages.push(entry.clone());
    }
    if let Err(error) = self.write_pages_at(project_id, &mut project, pages) {
      let _ = fs::remove_dir_all(&dir);
      return Err(error);
    }
    Ok(entry)
  }

  /// ページの名前を変える（pages の無い今の案件の root は、pages を初期化してから）。
  pub fn rename_page(&self, project_id: &str, page_id: &str, title: &str) -> Result<()> {
    self.rename_page_at(Some(project_id), page_id, title)
  }

  pub fn rename_page_at(&self, project_id: Option<&str>, page_id: &str, title: &str) -> Result<()> {
    self.migrate_page_owner_at(project_id)?;
    let page_id = self.resolve_page_id_at(project_id, page_id)?;
    let _guard = WRITE_LOCK.lock();
    let mut project = self.read_page_owner(project_id)?;
    let mut pages = Self::page_list(&project);
    let page = pages
      .iter_mut()
      .find(|page| Self::page_field(page, "id") == Some(page_id.as_str()))
      .ok_or_else(StoreError::no_page)?;
    if Self::page_field(page, "title") == Some(title) && project.get("pages").is_some() {
      return Ok(());
    }
    if let Value::Object(map) = page {
      map.insert("title".into(), Value::from(title));
    }
    self.write_pages_at(project_id, &mut project, pages)
  }

  /// ページを消す。文書は本文と pages の 1 行。録音（P3 #18566）は pages の 1 行と録音の中身: root 以外は
  /// `recordings/<id>/` を丸ごと、root は案件フォルダ直下の録音の中身（ROOT_RECORDING_FILES）と project.json の
  /// flowSnapshot・source・refs（info は残す）。録音は案件の実行のロックを生きている process が持っていれば断る。どれも pages を
  /// 先に書き、ファイルは後で消す（途中で失敗しても一覧は壊れない。一覧から外した中身は、消せなくても残るだけ）。
  pub fn delete_page(&self, project_id: &str, page_id: &str) -> Result<()> {
    self.delete_page_at(Some(project_id), page_id)
  }

  pub fn delete_page_at(&self, project_id: Option<&str>, page_id: &str) -> Result<()> {
    self.migrate_page_owner_at(project_id)?;
    let page_id = self.resolve_page_id_at(project_id, page_id)?;
    let _guard = WRITE_LOCK.lock();
    let mut project = self.read_page_owner(project_id)?;
    let mut pages = Self::page_list(&project);
    let index = pages
      .iter()
      .position(|page| Self::page_field(page, "id") == Some(page_id.as_str()))
      .ok_or_else(StoreError::no_page)?;
    match Self::page_field(&pages[index], "kind") {
      Some("doc") => {
        validate_id(&page_id)?;
        let file = self.doc_file_at(project_id, &page_id)?;
        if self.run_lock_holder_at(project_id).is_some() {
          return Err(StoreError::new(
            "store_busy",
            "AIと作るの依頼が終わってから削除できます。",
          ));
        }
        let base = self.page_space_parts(project_id)?;
        let chat_dir = self.under(&base, &["page-chats", &page_id])?;
        pages.remove(index);
        // 保存の口があれば、一覧の書き換えと本文の削除を 1 つの保存単位にする（口はフォルダ外の path を受け取らない）
        let mut saved = false;
        if let Some(sink) = save_sink() {
          let mut listed = project.clone();
          Self::set_page_index(project_id, &mut listed, &pages)?;
          let writes = vec![
            SinkWrite::Put(self.pages_file(project_id)?, json_bytes(&listed)?),
            SinkWrite::Delete(file.clone()),
          ];
          if let Some(result) = sink.save(&writes, SinkKind::Edit) {
            result?;
            saved = true;
          }
        }
        if !saved {
          self.write_pages_at(project_id, &mut project, pages)?;
          // 一覧から外した後の本文は、消せなくても残るだけ（同じ id は使い直さない）
          let _ = fs::remove_file(&file);
          notify_changed(&[file]);
        }
        let _ = fs::remove_dir_all(chat_dir);
        self.remove_empty_page_chats_dir(project_id);
        Ok(())
      }
      Some("rec") => {
        let recording_id = Self::recording_id(&pages[index])
          .ok_or_else(StoreError::no_page)?
          .to_string();
        if self.run_lock_holder_at(project_id).is_some() {
          return Err(StoreError::new(
            "store_busy",
            "実行中の録音があります。終わってから、もう一度削除してください。",
          ));
        }
        // 消す場所（途中にリンクがあれば、何も書かずに断る）
        let targets = if project_id.is_some() && recording_id == ROOT_RECORDING_ID {
          let project_id = project_id.expect("root recording belongs to a folder");
          ROOT_RECORDING_FILES
            .iter()
            .map(|name| self.path(&["projects", project_id, name]))
            .collect::<Result<Vec<_>>>()?
        } else {
          validate_id(&recording_id)?;
          vec![self.recording_dir_at(project_id, &recording_id)?]
        };
        pages.remove(index);
        if project_id.is_some() && recording_id == ROOT_RECORDING_ID {
          if let Value::Object(map) = &mut project {
            for key in ["flowSnapshot", "source", "refs", "candidateSets", "sourceCandidateId"] {
              map.remove(key);
            }
          }
        }
        self.write_pages_at(project_id, &mut project, pages)?;
        for target in &targets {
          Self::remove_path(target);
        }
        notify_changed(&targets);
        Ok(())
      }
      _ => Err(StoreError::bad_page("ページの種類が正しくありません。")),
    }
  }

  fn page_data_path(&self, project_id: Option<&str>, page: &Value) -> Result<PathBuf> {
    let id = Self::page_field(page, "id").ok_or_else(StoreError::no_page)?;
    validate_id(id)?;
    let mut parts = self.page_space_parts(project_id)?;
    match Self::page_field(page, "kind") {
      Some("doc") => {
        let file = format!("{id}.md");
        parts.extend(["pages", file.as_str()]);
        self.path(&parts)
      }
      Some("rec") if !(project_id.is_some() && Self::recording_id(page) == Some(ROOT_RECORDING_ID)) => {
        let recording_id = Self::recording_id(page).ok_or_else(StoreError::no_page)?;
        self.recording_dir_at(project_id, recording_id)
      }
      Some("rec") => return self.page_space(project_id),
      _ => Err(StoreError::bad_page("ページの種類が正しくありません。")),
    }
  }

  fn move_recovery_error() -> StoreError {
    StoreError::new(
      "store_move_recovery",
      "移動を元に戻せませんでした。データは削除せず残しています。保存先の移動元と移動先を確認してください。",
    )
  }

  /// 戻せなかったファイルがある場合は移動先を消さない（復旧失敗で正本まで消すことを防ぐ）。
  fn rollback_root_move(target: &Path, moved: &[(PathBuf, PathBuf)]) -> Result<()> {
    let mut restored = true;
    for (old, new) in moved.iter().rev() {
      if fs::rename(new, old).is_err() {
        restored = false;
      }
    }
    if !restored {
      return Err(Self::move_recovery_error());
    }
    fs::remove_file(target.join("recording.json")).map_err(|_| Self::move_recovery_error())?;
    // 外部からファイルが足されていた場合も削除しない。
    fs::remove_dir(target).map_err(|_| Self::move_recovery_error())
  }

  /// ページをフォルダ内外へ移す。本文または録音フォルダを先に rename し、一覧の書き込みに失敗したら一覧と rename を戻す。
  /// 旧 root 録音だけは移動時に新しい録音 id と recording.json を作る（開くだけでは移行しない）。
  pub fn move_page(
    &self,
    source_project_id: Option<&str>,
    page_id: &str,
    target_project_id: Option<&str>,
  ) -> Result<Value> {
    self.move_page_before(source_project_id, page_id, target_project_id, None)
  }

  /// `before_page_id` があればそのページの直前、無ければ移動先の末尾へ入れる。
  pub fn move_page_before(
    &self,
    source_project_id: Option<&str>,
    page_id: &str,
    target_project_id: Option<&str>,
    before_page_id: Option<&str>,
  ) -> Result<Value> {
    self.migrate_page_owner_at(source_project_id)?;
    if source_project_id != target_project_id {
      self.migrate_page_owner_at(target_project_id)?;
    }
    let page_id = self.resolve_page_id_at(source_project_id, page_id)?;
    let before_page_id = before_page_id
      .map(|id| self.resolve_page_id_at(target_project_id, id))
      .transpose()?;
    validate_id(&page_id)?;
    if let Some(id) = before_page_id.as_deref() {
      validate_id(id)?;
    }
    let _guard = WRITE_LOCK.lock();
    let mut source_owner = self.read_page_owner(source_project_id)?;
    let initial_source_pages = Self::page_list(&source_owner);
    let initial_source_index = initial_source_pages
      .iter()
      .position(|page| Self::page_field(page, "id") == Some(page_id.as_str()))
      .ok_or_else(StoreError::no_page)?;
    let kind = Self::page_field(&initial_source_pages[initial_source_index], "kind")
      .ok_or_else(StoreError::no_page)?
      .to_string();
    if self.run_lock_holder_at(source_project_id).is_some() || self.run_lock_holder_at(target_project_id).is_some() {
      return Err(StoreError::new(
        "store_busy",
        if kind == "doc" {
          "AIと作るの依頼が終わってから移動できます。"
        } else {
          "この録音は実行中または会話の送信中です。終わってから移動してください。"
        },
      ));
    }
    if source_project_id == target_project_id {
      let mut pages = initial_source_pages;
      let source_index = initial_source_index;
      if before_page_id.as_deref() == Some(page_id.as_str()) {
        return Err(StoreError::bad_page("同じページの位置には移動できません。"));
      }
      let entry = pages.remove(source_index);
      let index = match before_page_id.as_deref() {
        Some(target) => pages
          .iter()
          .position(|page| Self::page_field(page, "id") == Some(target))
          .ok_or_else(|| StoreError::new("store_stale_target", "移動先が変わりました。もう一度お試しください。"))?,
        None => pages.len(),
      };
      pages.insert(index, entry.clone());
      self.write_pages_at(source_project_id, &mut source_owner, pages)?;
      return Ok(entry);
    }
    let mut target_owner = self.read_page_owner(target_project_id)?;
    // 実体を動かす前に復旧用の値とパスを確保する。rename 後の追加読込失敗で復旧を飛ばさない。
    let source_before = source_owner.clone();
    let source_pages_file = self.pages_file(source_project_id)?;
    let mut source_pages = Self::page_list(&source_owner);
    let mut target_pages = Self::page_list(&target_owner);
    if kind == "rec" && target_project_id.is_some() && Self::has_recording_page(&target_pages) {
      return Err(StoreError::folder_has_recording(
        "移動先のフォルダにはもう音声があります。",
      ));
    }
    if let Some(target) = before_page_id.as_deref() {
      if !target_pages
        .iter()
        .any(|page| Self::page_field(page, "id") == Some(target))
      {
        return Err(StoreError::new(
          "store_stale_target",
          "移動先が変わりました。もう一度お試しください。",
        ));
      }
    }
    let source_index = source_pages
      .iter()
      .position(|page| Self::page_field(page, "id") == Some(page_id.as_str()))
      .ok_or_else(StoreError::no_page)?;
    let original_entry = source_pages[source_index].clone();
    let recording_id = Self::recording_id(&original_entry).unwrap_or(&page_id);

    let legacy_root = kind == "rec" && source_project_id.is_some() && recording_id == ROOT_RECORDING_ID;
    let mut moved_entry = original_entry.clone();
    if kind == "doc" {
      let generation = original_entry
        .get("moveGeneration")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| StoreError::new("store_bad_json", "文書の移動履歴の形式が正しくありません。"))?;
      moved_entry["moveGeneration"] = json!(generation);
    }
    let moved_id = if legacy_root {
      let mut id = new_id(10);
      while target_pages
        .iter()
        .any(|page| Self::page_field(page, "id") == Some(id.as_str()))
        || {
          let mut parts = self.page_space_parts(target_project_id)?;
          parts.extend(["recordings", id.as_str()]);
          self.path(&parts)?.exists()
        }
      {
        id = new_id(10);
      }
      if let Value::Object(fields) = &mut moved_entry {
        fields.insert("id".into(), Value::from(id.clone()));
      }
      id
    } else {
      page_id.clone()
    };

    if target_pages
      .iter()
      .any(|page| Self::page_field(page, "id") == Some(moved_id.as_str()))
    {
      return Err(StoreError::new("store_conflict", "移動先に同じページがあります。"));
    }
    let mut target_parts = self.page_space_parts(target_project_id)?;
    let target_path = if kind == "doc" {
      let file = format!("{moved_id}.md");
      target_parts.extend(["pages", file.as_str()]);
      self.path(&target_parts)?
    } else {
      target_parts.extend(["recordings", recording_id]);
      self.path(&target_parts)?
    };
    if target_path.exists() {
      return Err(StoreError::new("store_conflict", "移動先に同じページがあります。"));
    }

    let source_path = self.page_data_path(source_project_id, &original_entry)?;
    let chat_move = if kind == "doc" {
      let source_base = self.page_space_parts(source_project_id)?;
      let target_base = self.page_space_parts(target_project_id)?;
      let from = self.under(&source_base, &["page-chats", &page_id])?;
      let to = self.under(&target_base, &["page-chats", &moved_id])?;
      if to.exists() {
        return Err(StoreError::new(
          "store_conflict",
          "移動先に同じページの会話があります。",
        ));
      }
      from.exists().then_some((from, to))
    } else {
      None
    };
    let root_files = if legacy_root {
      let project_id = source_project_id.expect("legacy recording belongs to a folder");
      ROOT_RECORDING_FILES
        .iter()
        .map(|name| {
          self
            .project_file(project_id, &[name])
            .map(|from| (from, target_path.join(name)))
        })
        .collect::<Result<Vec<_>>>()?
    } else {
      vec![]
    };
    let original_recording = if kind == "rec" && !legacy_root {
      Some(
        read_json(&self.recording_file_at(source_project_id, recording_id, &["recording.json"])?)?
          .ok_or_else(StoreError::no_recording)?,
      )
    } else {
      None
    };
    let updated_recording = original_recording
      .as_ref()
      .map(|original| -> Result<Value> {
        let generation = original
          .get("moveGeneration")
          .and_then(Value::as_u64)
          .unwrap_or(0)
          .checked_add(1)
          .ok_or_else(|| StoreError::new("store_bad_json", "録音の移動履歴の形式が正しくありません。"))?;
        let mut updated = original.clone();
        updated["moveGeneration"] = json!(generation);
        Ok(updated)
      })
      .transpose()?;
    let mut moved_root_files: Vec<(PathBuf, PathBuf)> = Vec::new();
    if legacy_root {
      fs::create_dir_all(&target_path).map_err(StoreError::io)?;
      let project = &source_owner;
      let mut recording = json!({
        "version": 1,
        "id": moved_id,
        "createdAt": original_entry.get("createdAt").cloned().unwrap_or_else(|| json!("")),
        "flowSnapshot": project.get("flowSnapshot").cloned().unwrap_or(Value::Null),
        "source": project.get("source").cloned().unwrap_or_else(|| json!({ "kind": "audio", "audio": [] })),
        "speakers": project.get("info").and_then(|info| info.get("speakers")).cloned().unwrap_or_else(|| json!("auto")),
        "language": project.get("info").and_then(|info| info.get("language")).cloned().unwrap_or_else(|| json!("ja")),
        "refs": project.get("refs").cloned().unwrap_or_else(|| json!([])),
        "moveGeneration": 1,
      });
      if let Some(candidate_sets) = project.get("candidateSets") {
        recording["candidateSets"] = candidate_sets.clone();
      }
      if let Some(selected) = project.get("sourceCandidateId").filter(|value| value.is_string()) {
        recording["sourceCandidateId"] = selected.clone();
      }
      if let Err(error) = write_json(&target_path.join("recording.json"), &recording) {
        let _ = fs::remove_dir(&target_path);
        return Err(error);
      }
      for (from, to) in root_files {
        if !from.exists() {
          continue;
        }
        if let Err(error) = fs::rename(&from, &to) {
          Self::rollback_root_move(&target_path, &moved_root_files)?;
          return Err(StoreError::io(error));
        }
        moved_root_files.push((from, to));
      }
    } else {
      fs::create_dir_all(
        target_path
          .parent()
          .ok_or_else(|| StoreError::new("store_io", "移動先がありません。"))?,
      )
      .map_err(StoreError::io)?;
      fs::rename(&source_path, &target_path).map_err(StoreError::io)?;
      if let Some(recording) = &updated_recording {
        if let Err(error) = write_json(&target_path.join("recording.json"), recording) {
          fs::rename(&target_path, &source_path).map_err(|_| Self::move_recovery_error())?;
          return Err(error);
        }
      }
    }
    if let Some((from, to)) = &chat_move {
      let move_chat = (|| -> Result<()> {
        fs::create_dir_all(
          to.parent()
            .ok_or_else(|| StoreError::new("store_io", "会話の移動先がありません。"))?,
        )
        .map_err(StoreError::io)?;
        fs::rename(from, to).map_err(StoreError::io)
      })();
      if let Err(error) = move_chat {
        if legacy_root {
          Self::rollback_root_move(&target_path, &moved_root_files)?;
        } else {
          fs::rename(&target_path, &source_path).map_err(|_| Self::move_recovery_error())?;
        }
        return Err(error);
      }
    }

    source_pages.remove(source_index);
    let target_index = before_page_id
      .as_deref()
      .and_then(|target| {
        target_pages
          .iter()
          .position(|page| Self::page_field(page, "id") == Some(target))
      })
      .unwrap_or(target_pages.len());
    target_pages.insert(target_index, moved_entry.clone());
    if legacy_root {
      if let Value::Object(fields) = &mut source_owner {
        for key in ["flowSnapshot", "source", "refs", "candidateSets", "sourceCandidateId"] {
          fields.remove(key);
        }
      }
    }
    let rollback_data = || -> Result<()> {
      if let Some((from, to)) = &chat_move {
        fs::rename(to, from).map_err(|_| Self::move_recovery_error())?;
      }
      if legacy_root {
        Self::rollback_root_move(&target_path, &moved_root_files)
      } else {
        let metadata = original_recording
          .as_ref()
          .map(|recording| write_json(&target_path.join("recording.json"), recording))
          .unwrap_or(Ok(()));
        let restored = fs::rename(&target_path, &source_path).map_err(StoreError::io);
        metadata.and(restored).map_err(|_| Self::move_recovery_error())
      }
    };
    if let Err(error) = self.write_pages_at(source_project_id, &mut source_owner, source_pages) {
      rollback_data()?;
      return Err(error);
    }
    if let Err(error) = self.write_pages_at(target_project_id, &mut target_owner, target_pages) {
      // target の atomic write は失敗時に元の一覧を変えない。source と実体は両方とも復旧を試みる。
      let metadata = write_json(&source_pages_file, &source_before);
      let restored = rollback_data();
      metadata.and(restored).map_err(|_| Self::move_recovery_error())?;
      return Err(error);
    }
    if kind == "doc" {
      self.remove_empty_page_chats_dir(source_project_id);
    }
    Ok(moved_entry)
  }

  /// ファイルかフォルダを消す（無ければ何もしない。リンクはリンクだけを消す。消せなくても残るだけ）。
  fn remove_path(path: &Path) {
    let Ok(meta) = fs::symlink_metadata(path) else {
      return;
    };
    let _ = if meta.is_dir() {
      fs::remove_dir_all(path)
    } else {
      fs::remove_file(path)
    };
  }

  /// 文書のページの本文（まだ書いていなければ空）。
  pub fn read_page(&self, project_id: &str, page_id: &str) -> Result<String> {
    self.read_page_at(Some(project_id), page_id)
  }

  pub fn read_page_at(&self, project_id: Option<&str>, page_id: &str) -> Result<String> {
    self.migrate_page_owner_at(project_id)?;
    Ok(read_text(&self.doc_file_at(project_id, page_id)?)?.unwrap_or_default())
  }

  /// 文書のページの本文を書く。保存の口を通れば、この Mac の保存の世代を返す（「クラウドに保存済み」の確かめに使う）。
  pub fn write_page(&self, project_id: &str, page_id: &str, markdown: &str) -> Result<Option<u64>> {
    self.write_page_at(Some(project_id), page_id, markdown)
  }

  /// フォルダ外のページ（project_id が None）は保存の口が受け取らないので、世代は返らない（同期しない。C3 §5.1）。
  pub fn write_page_at(&self, project_id: Option<&str>, page_id: &str, markdown: &str) -> Result<Option<u64>> {
    self.migrate_page_owner_at(project_id)?;
    let _guard = WRITE_LOCK.lock();
    write_atomic_as(
      &self.doc_file_at(project_id, page_id)?,
      markdown.as_bytes(),
      SinkKind::Edit,
    )
  }

  /// 案件に属する画像を安全な id で保存する。元画像のパスや名前は Markdown に残さない。
  pub fn import_image_asset(&self, project_id: &str, source: &Path) -> Result<String> {
    self.import_page_image_asset(Some(project_id), source)
  }

  /// フォルダ外ページでは保存先直下の assets/ に画像を置く。
  pub fn import_page_image_asset(&self, project_id: Option<&str>, source: &Path) -> Result<String> {
    let _guard = WRITE_LOCK.lock();
    self.page_space(project_id)?;
    if !source.is_absolute() {
      return Err(StoreError::new("store_bad_image", "画像ファイルを選んでください。"));
    }
    for part in source.ancestors() {
      if fs::symlink_metadata(part)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
      {
        return Err(StoreError::new("store_symlink", "リンクの画像は追加できません。"));
      }
    }
    let meta = fs::symlink_metadata(source).map_err(StoreError::io)?;
    if meta.file_type().is_symlink() {
      return Err(StoreError::new("store_symlink", "リンクの画像は追加できません。"));
    }
    if !meta.is_file() {
      return Err(StoreError::new("store_bad_image", "画像ファイルを選んでください。"));
    }
    if meta.len() > IMAGE_MAX_BYTES {
      return Err(StoreError::new(
        "store_image_too_large",
        "画像は 10 MB 以下を選んでください。",
      ));
    }
    let extension = source
      .extension()
      .and_then(|value| value.to_str())
      .unwrap_or("")
      .to_ascii_lowercase();
    let mime = image_type(&format!("image.{extension}"))?;
    let mut bytes = Vec::new();
    #[cfg(unix)]
    let file = {
      use std::os::unix::fs::OpenOptionsExt;
      fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(source)
        .map_err(StoreError::io)?
    };
    #[cfg(not(unix))]
    let file = fs::File::open(source).map_err(StoreError::io)?;
    file
      .take(IMAGE_MAX_BYTES + 1)
      .read_to_end(&mut bytes)
      .map_err(StoreError::io)?;
    if bytes.len() as u64 > IMAGE_MAX_BYTES {
      return Err(StoreError::new(
        "store_image_too_large",
        "画像は 10 MB 以下を選んでください。",
      ));
    }
    if !image_signature(&bytes, mime) {
      return Err(StoreError::new("store_bad_image", "画像の形式を確認してください。"));
    }
    for _ in 0..8 {
      let name = format!("{}.{}", new_id(16), extension);
      let mut parts = self.page_space_parts(project_id)?;
      parts.extend(["assets", &name]);
      let path = self.path(&parts)?;
      if path.exists() {
        continue;
      }
      // 画像は journal を通さず（写しが大きい）、書いてから変更として知らせる
      write_plain(&path, &bytes)?;
      notify_changed(&[path]);
      return Ok(name);
    }
    Err(StoreError::new("store_io", "画像の保存先を作れませんでした。"))
  }

  /// 保存済み画像だけを data URL として返す。相対パスを画面から受け取らない。
  pub fn read_image_asset(&self, project_id: &str, name: &str) -> Result<String> {
    self.read_page_image_asset(Some(project_id), name)
  }

  /// フォルダ外ページの画像は保存先直下の assets/ から読む。
  pub fn read_page_image_asset(&self, project_id: Option<&str>, name: &str) -> Result<String> {
    let mime = image_type(name)?;
    let mut parts = self.page_space_parts(project_id)?;
    parts.extend(["assets", name]);
    let path = self.path(&parts)?;
    let meta = fs::symlink_metadata(&path).map_err(StoreError::io)?;
    if !meta.is_file() || meta.len() > IMAGE_MAX_BYTES {
      return Err(StoreError::new("store_bad_image", "画像を読めませんでした。"));
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
      .map_err(StoreError::io)?
      .take(IMAGE_MAX_BYTES + 1)
      .read_to_end(&mut bytes)
      .map_err(StoreError::io)?;
    if bytes.len() as u64 > IMAGE_MAX_BYTES || !image_signature(&bytes, mime) {
      return Err(StoreError::new("store_bad_image", "画像を読めませんでした。"));
    }
    Ok(format!(
      "data:{mime};base64,{}",
      base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
  }

  fn next_version(versions: &Path) -> u32 {
    fs::read_dir(versions)
      .map(|entries| {
        entries
          .filter_map(|entry| entry.ok())
          .filter_map(|entry| {
            entry
              .file_name()
              .to_string_lossy()
              .strip_suffix(".md")?
              .parse::<u32>()
              .ok()
          })
          .max()
          .unwrap_or(0)
      })
      .unwrap_or(0)
      + 1
  }

  /// runs.jsonl に 1 行を足す。保存の口があれば、今の中身に足した全体を 1 つの保存として journal へ通す。
  fn append_jsonl(path: &Path, record: &Value) -> Result<()> {
    if save_sink().is_some() {
      let bytes = appended_lines(path, std::slice::from_ref(record))?;
      return write_atomic_as(path, &bytes, SinkKind::Run).map(|_| ());
    }
    append_line_plain(path, record)
  }

  /// 版を足す（WRITE_LOCK の中で）。足した版の表示の番号を返す。
  fn write_version_locked(
    dir: &Path,
    prefix: &str,
    step_id: &str,
    source: bool,
    markdown: &str,
    record: &Value,
  ) -> Result<u32> {
    Self::write_version(dir, prefix, step_id, source, markdown, record).map(|written| written.version)
  }

  /// 版を足す（versions/<stepId>/v_<乱数>.md）・最新版を置き換える・runs.jsonl に行（version・versionPath・versionSha256・
  /// originDeviceId）を足す。今の内容が版になっていなければ、先にそれを「保存」の版として同じ保存単位で残す。保存の口が
  /// あれば 1 つの group、無ければ順に書いて、途中で失敗したら書いた分を戻す。
  fn write_version(
    dir: &Path,
    prefix: &str,
    step_id: &str,
    source: bool,
    markdown: &str,
    record: &Value,
  ) -> Result<WrittenVersion> {
    validate_id(step_id)?;
    for part in ["versions", "artifacts"] {
      let path = dir.join(part);
      if fs::symlink_metadata(&path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
      {
        return Err(StoreError::new(
          "store_symlink",
          "保存先の中にリンクがあるため読み書きできません。",
        ));
      }
    }
    fs::create_dir_all(dir.join("versions").join(step_id)).map_err(StoreError::io)?;
    let plan = VersionPlan::new(dir, prefix, step_id, source, markdown, Some(record))?;
    plan.commit()?;
    Ok(WrittenVersion {
      version: plan.version,
      files: plan.files.into_iter().map(|(path, _)| path).collect(),
    })
  }

  /// 版を足す（versions/<stepId>/v_<乱数>.md）・最新版を置き換える・runs.jsonl に記録を足す。足した版の番号を返す。
  pub fn save_artifact(
    &self,
    project_id: &str,
    recording_id: &str,
    step_id: &str,
    source: bool,
    markdown: &str,
    record: &Value,
  ) -> Result<u32> {
    self.save_artifact_at(Some(project_id), recording_id, step_id, source, markdown, record)
  }

  pub fn save_artifact_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    step_id: &str,
    source: bool,
    markdown: &str,
    record: &Value,
  ) -> Result<u32> {
    let _guard = WRITE_LOCK.lock();
    let base = self.recording_parts_at(project_id, recording_id)?;
    validate_id(step_id)?;
    self.under(&base, &["versions", step_id])?;
    Self::write_version_locked(
      &self.under(&base, &[])?,
      &self.recording_prefix_at(project_id, recording_id)?,
      step_id,
      source,
      markdown,
      record,
    )
  }

  /// 版を足さない記録（失敗・停止）を録音の runs.jsonl に足す。
  pub fn append_run(&self, project_id: &str, recording_id: &str, record: &Value) -> Result<()> {
    self.append_run_at(Some(project_id), recording_id, record)
  }

  pub fn append_run_at(&self, project_id: Option<&str>, recording_id: &str, record: &Value) -> Result<()> {
    let _guard = WRITE_LOCK.lock();
    let mut record = record.clone();
    with_origin(&mut record);
    Self::append_jsonl(&self.chat_file_at(project_id, recording_id, &["runs.jsonl"])?, &record)
  }

  #[cfg(test)]
  pub fn read_version(&self, project_id: &str, recording_id: &str, step_id: &str, version: u32) -> Result<String> {
    self.read_version_at(Some(project_id), recording_id, step_id, version, None)
  }

  /// 実行の checkpoint（録音の runs/<runId>.json）を書く。
  pub fn save_checkpoint(&self, project_id: &str, recording_id: &str, run_id: &str, checkpoint: &Value) -> Result<()> {
    self.save_checkpoint_at(Some(project_id), recording_id, run_id, checkpoint)
  }

  pub fn save_checkpoint_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    run_id: &str,
    checkpoint: &Value,
  ) -> Result<()> {
    validate_id(run_id)?;
    let _guard = WRITE_LOCK.lock();
    write_json(
      &self.chat_file_at(project_id, recording_id, &["runs", &format!("{run_id}.json")])?,
      checkpoint,
    )
  }

  pub fn read_checkpoint(&self, project_id: &str, recording_id: &str, run_id: &str) -> Result<Option<Value>> {
    self.read_checkpoint_at(Some(project_id), recording_id, run_id)
  }

  pub fn read_checkpoint_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    run_id: &str,
  ) -> Result<Option<Value>> {
    validate_run_id(run_id)?;
    read_json(&self.chat_file_at(project_id, recording_id, &["runs", &format!("{run_id}.json")])?)
  }

  /// 同じ案件の実行を 1 つにする（`.run.lock` に pid を書く。持ち主の pid が居なければ取り直す）。
  pub fn acquire_run_lock(&self, project_id: &str) -> Result<()> {
    self.acquire_run_lock_at(Some(project_id))
  }

  pub fn acquire_run_lock_at(&self, project_id: Option<&str>) -> Result<()> {
    let path = match project_id {
      Some(id) => self.project_file(id, &[LOCK_FILE])?,
      None => self.path(&[LOCK_FILE])?,
    };
    for _ in 0..2 {
      match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
          file
            .write_all(std::process::id().to_string().as_bytes())
            .map_err(StoreError::io)?;
          return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
          let holder = fs::read_to_string(&path)
            .ok()
            .and_then(|text| text.trim().parse::<u32>().ok());
          match holder {
            Some(pid) if pid_alive(pid) => {
              return Err(StoreError::new(
                "store_busy",
                "実行中の録音があります。終わってから、もう一度実行してください。",
              ))
            }
            _ => {
              let _ = fs::remove_file(&path);
            }
          }
        }
        Err(error) => return Err(StoreError::io(error)),
      }
    }
    Err(StoreError::new(
      "store_busy",
      "実行中の録音があります。終わってから、もう一度実行してください。",
    ))
  }

  /// `.run.lock` の持ち主の pid（持ち主が生きているときだけ）。
  fn run_lock_holder(&self, project_id: &str) -> Option<u32> {
    self.run_lock_holder_at(Some(project_id))
  }

  fn run_lock_holder_at(&self, project_id: Option<&str>) -> Option<u32> {
    let path = match project_id {
      Some(id) => self.project_file(id, &[LOCK_FILE]),
      None => self.path(&[LOCK_FILE]),
    };
    path
      .ok()
      .and_then(|path| fs::read_to_string(path).ok())
      .and_then(|text| text.trim().parse::<u32>().ok())
      .filter(|pid| pid_alive(*pid))
  }

  /// 保存先を変える前に、別のアプリ instance が保持する案件ロックも確認する。
  pub fn has_active_run_lock(&self) -> Result<bool> {
    if self.run_lock_holder_at(None).is_some() {
      return Ok(true);
    }
    for project in self.list_projects()? {
      if self.run_lock_holder(&project.id).is_some() {
        return Ok(true);
      }
    }
    Ok(false)
  }

  /// 別のアプリ instance（この process 以外）が保持する案件ロックがあるか。この窓の再起動では止められない実行で、
  /// 自動更新はその間 `.app` を差し替えない（updater.rs）。
  pub fn has_run_lock_of_another_process(&self) -> Result<bool> {
    let current = std::process::id();
    if self.run_lock_holder_at(None).is_some_and(|pid| pid != current) {
      return Ok(true);
    }
    for project in self.list_projects()? {
      if self.run_lock_holder(&project.id).is_some_and(|pid| pid != current) {
        return Ok(true);
      }
    }
    Ok(false)
  }

  pub fn release_run_lock(&self, project_id: &str) -> Result<()> {
    self.release_run_lock_at(Some(project_id))
  }

  pub fn release_run_lock_at(&self, project_id: Option<&str>) -> Result<()> {
    let path = match project_id {
      Some(id) => self.project_file(id, &[LOCK_FILE])?,
      None => self.path(&[LOCK_FILE])?,
    };
    let holder = fs::read_to_string(&path)
      .ok()
      .and_then(|text| text.trim().parse::<u32>().ok());
    if holder == Some(std::process::id()) {
      fs::remove_file(&path).map_err(StoreError::io)?;
    }
    Ok(())
  }

  /// 最新版のファイル（Finder で表示する）。無ければ案件のフォルダ。
  pub fn artifact_path(&self, project_id: &str, recording_id: &str, step_id: &str, source: bool) -> Result<PathBuf> {
    self.artifact_path_at(Some(project_id), recording_id, step_id, source)
  }

  pub fn artifact_path_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    step_id: &str,
    source: bool,
  ) -> Result<PathBuf> {
    validate_id(step_id)?;
    let base = self.recording_parts_at(project_id, recording_id)?;
    let file = if source && step_id == SOURCE_STEP_ID {
      self.under(&base, &["transcript.md"])?
    } else {
      self.under(&base, &["artifacts", &format!("{step_id}.md")])?
    };
    if file.is_file() {
      Ok(file)
    } else {
      self.under(&base, &[])
    }
  }

  /// 文書のページの Markdown（pages/<id>.md。「書き出し › Finder で表示」）。無ければその置き場（フォルダか保存先の直下）。
  pub fn page_markdown_path_at(&self, project_id: Option<&str>, page_id: &str) -> Result<PathBuf> {
    validate_id(page_id)?;
    let base = self.page_space_parts(project_id)?;
    let file = self.under(&base, &["pages", &format!("{page_id}.md")])?;
    if file.is_file() {
      Ok(file)
    } else {
      self.under(&base, &[])
    }
  }

  /// すべての案件の runs.jsonl（root と各録音。設定 › 使用量）。各行に案件と録音の id を足す。
  pub fn list_all_runs(&self) -> Result<Vec<Value>> {
    let mut runs = Vec::new();
    for page in Self::page_list(&self.read_root_pages()?) {
      if Self::page_field(&page, "kind") == Some("doc") {
        if let Some(page_id) = Self::page_field(&page, "id") {
          let file = self.chat_file_at(None, page_id, &["runs.jsonl"])?;
          for mut run in read_jsonl(&file)? {
            if let Value::Object(map) = &mut run {
              map.insert("project".into(), Value::Null);
              map.insert("recording".into(), Value::from(page_id));
            }
            runs.push(run);
          }
        }
        continue;
      }
      if Self::page_field(&page, "kind") != Some("rec") {
        continue;
      }
      let Some(recording_id) = Self::recording_id(&page) else {
        continue;
      };
      if let Ok(file) = self.recording_file_at(None, recording_id, &["runs.jsonl"]) {
        for mut run in read_jsonl(&file)? {
          if let Value::Object(map) = &mut run {
            map.insert("project".into(), Value::Null);
            map.insert("recording".into(), Value::from(recording_id));
          }
          runs.push(run);
        }
      }
    }
    for entry in self.list_projects()? {
      let mut files = vec![(
        ROOT_RECORDING_ID.to_string(),
        self.project_file(&entry.id, &["runs.jsonl"])?,
      )];
      for recording_id in self.recording_ids(&entry.id) {
        if let Ok(file) = self.recording_file(&entry.id, &recording_id, &["runs.jsonl"]) {
          files.push((recording_id, file));
        }
      }
      for page in Self::page_list(&self.read_project(&entry.id)?) {
        if Self::page_field(&page, "kind") == Some("doc") {
          if let Some(page_id) = Self::page_field(&page, "id") {
            files.push((
              page_id.to_string(),
              self.chat_file_at(Some(&entry.id), page_id, &["runs.jsonl"])?,
            ));
          }
        }
      }
      for (recording_id, file) in files {
        for mut run in read_jsonl(&file)? {
          if let Value::Object(map) = &mut run {
            map.insert("project".into(), Value::from(entry.id.clone()));
            map.insert("recording".into(), Value::from(recording_id.clone()));
          }
          runs.push(run);
        }
      }
    }
    Ok(runs)
  }
}

// 保存の口（C3 #18595。cloud.rs が案件・flows・about.json の下の書き込みを保管庫の journal へ通す）
#[path = "store_sink.rs"]
mod sink;

// 版（C3 #18595。versions/<stepId>/v_<乱数>.md・runs の行の表示の番号と出どころ・自動の版）
#[path = "store_versions.rs"]
mod versions;

// 「AIと作る」の修正の会話（S5 #18386）の読み書き（conversations/・文書の状態・最後の版に戻す）
#[path = "store_conversations.rs"]
mod conversations;
// 文書ページの会話の置き場（page-chats/）と、録音ページの直後に空の文書を作る保存
#[path = "store_page_chats.rs"]
mod page_chats;
pub use conversations::ArtifactState;

// 本人 Mac 実行（R6 #18739）の録音の照合・候補の不変の版・原子公開（personal_run.rs が捕捉した Store に対して呼ぶ）
#[path = "store_personal.rs"]
mod personal;
pub(crate) use personal::{selected_source_artifact, CandidateWrite, PersonalPublish, PublishOutcome};

// 工程（フロー）の保存（P4 #18567。flows/<id>.json・index.json・P4 より前の active.json の移し替え）
#[path = "store_flows.rs"]
mod flows;
pub use flows::FlowList;

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;

/// 保存の口と deviceId は process 全体に効くので、それを入れるテストを 1 つずつにする。
#[cfg(test)]
pub(crate) fn sink_test_lock() -> std::sync::MutexGuard<'static, ()> {
  static LOCK: Mutex<()> = Mutex::new(());
  LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// 保存の口（C3 #18595）を通る書き込みのテスト（記録する偽の口）
#[cfg(test)]
#[path = "store_sink_tests.rs"]
mod sink_tests;
