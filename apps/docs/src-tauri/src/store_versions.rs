//! 版（C3 #18595）。store.rs の子 module。新しい版は versions/<stepId>/v_<乱数>.md（保管庫の `new_version_id`）で、runs の行の
//! `version` は表示の番号（その工程の旧形式の連番のファイルと行の大きいほう + 1）。行には versionPath（案件フォルダから）・
//! versionSha256・originDeviceId を書く。旧形式の `<n>.md` は読み取りの互換のまま、名前を変えない。今の内容が版になって
//! いないまま置き換える保存の前には、今の内容を「保存」の版（`auto: true`）として同じ保存単位で残す。

use super::sink::{
  append_line_plain, appended_lines, notify_changed, now_iso, save_sink, with_origin, write_atomic_as, SinkKind,
  SinkWrite,
};
use super::{
  new_id, read_jsonl, read_text, validate_id, write_plain, Result, RunsSnapshot, Store, StoreError, MAX_ID_CHARS,
  ROOT_RECORDING_ID, SOURCE_STEP_ID, WRITE_LOCK,
};
use crate::process::hex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// 録音の中の path の頭（案件フォルダから。root は空、それ以外は `recordings/<recordingId>/`）。
pub(crate) fn recording_prefix(recording_id: &str) -> String {
  if recording_id == ROOT_RECORDING_ID {
    String::new()
  } else {
    format!("recordings/{recording_id}/")
  }
}

/// runs の行の表示の番号（版の無い行は None）。
pub(super) fn row_version(row: &Value) -> Option<u32> {
  row
    .get("version")
    .and_then(Value::as_u64)
    .filter(|number| *number > 0)
    .and_then(|number| u32::try_from(number).ok())
}

/// 行の版の置き場（`versions/<これ>/`）。記事本文の案（#18677）の行は stepId が工程で、置き場は artifactId。
pub(super) fn row_step(row: &Value) -> Option<&str> {
  row
    .get("artifactId")
    .and_then(Value::as_str)
    .or_else(|| row.get("stepId").and_then(Value::as_str))
}

/// 自動で足す行に、元の行の工程と案（stepId・candidateId・artifactId・instruction）を写す。元が無ければ置き場をそのまま工程にする。
pub(super) fn copy_identity(row: &mut Value, from: Option<&Value>, step_id: &str) {
  let Value::Object(map) = row else {
    return;
  };
  map.insert("stepId".into(), Value::from(step_id));
  let Some(Value::Object(from)) = from else {
    return;
  };
  for key in ["stepId", "candidateId", "artifactId", "instruction"] {
    if let Some(value) = from.get(key).filter(|value| value.is_string()) {
      map.insert(key.into(), value.clone());
    }
  }
}

/// 行の並び（`at` の古い順、同じなら番号の小さい順）。
pub(super) fn row_order(left: &Value, right: &Value) -> std::cmp::Ordering {
  let at = |row: &Value| row.get("at").and_then(Value::as_str).unwrap_or("").to_string();
  at(left)
    .cmp(&at(right))
    .then_with(|| row_version(left).cmp(&row_version(right)))
}

/// その工程のいちばん新しい版の行（`at` の新しい順、同じなら番号の大きい順）。
pub(super) fn newest_version_row<'a>(rows: &'a [Value], step_id: &str) -> Option<&'a Value> {
  rows
    .iter()
    .filter(|row| row_step(row) == Some(step_id) && row_version(row).is_some())
    .max_by(|left, right| row_order(left, right))
}

/// 版の path（案件フォルダから）が、その録音の versions/<stepId>/ の中の `.md` 1 つなら、その名前。旧形式の root の録音
/// （頭が空）をページとして移動すると録音の頭が `recordings/<id>/` に変わるので、頭の無い path（移動前に書いた行）も
/// 今の録音の版として受け付ける（P6 #18607。別の録音の頭の path は受け付けない）。
pub(super) fn version_file_name<'a>(version_path: &'a str, prefix: &str, step_id: &str) -> Option<&'a str> {
  let name = version_path
    .strip_prefix(prefix)
    .or_else(|| version_path.starts_with("versions/").then_some(version_path))?
    .strip_prefix("versions/")?
    .strip_prefix(step_id)?
    .strip_prefix('/')?;
  let stem = name.strip_suffix(".md")?;
  let safe = !stem.is_empty()
    && stem.len() <= MAX_ID_CHARS
    && stem
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
  safe.then_some(name)
}

/// リンクでないファイルの中身（無い・リンク・読めなければ None）。
pub(super) fn read_plain_file(path: &Path) -> Option<Vec<u8>> {
  fs::symlink_metadata(path).ok().filter(|meta| meta.is_file())?;
  fs::read(path).ok()
}

/// 行が指す版の中身（versionPath を先に、無ければ旧形式の連番の名前）。
pub(super) fn row_version_bytes(dir: &Path, prefix: &str, step_id: &str, row: &Value) -> Option<Vec<u8>> {
  let versions = dir.join("versions").join(step_id);
  let named = row
    .get("versionPath")
    .and_then(Value::as_str)
    .and_then(|path| version_file_name(path, prefix, step_id))
    .and_then(|name| read_plain_file(&versions.join(name)));
  named.or_else(|| read_plain_file(&versions.join(format!("{}.md", row_version(row)?))))
}

/// その工程のいちばん新しい版の中身（版の行が無い旧形式は連番の最大）。
pub(super) fn newest_version_bytes(dir: &Path, prefix: &str, step_id: &str, rows: &[Value]) -> Option<Vec<u8>> {
  match newest_version_row(rows, step_id) {
    Some(row) => row_version_bytes(dir, prefix, step_id, row),
    None => {
      let versions = dir.join("versions").join(step_id);
      let latest = Store::next_version(&versions) - 1;
      if latest == 0 {
        None
      } else {
        read_plain_file(&versions.join(format!("{latest}.md")))
      }
    }
  }
}

/// 次の版の表示の番号（旧形式の連番のファイルと runs の行の大きいほう + 1）。
pub(super) fn next_display_version(dir: &Path, step_id: &str, rows: &[Value]) -> u32 {
  let files = Store::next_version(&dir.join("versions").join(step_id)) - 1;
  let listed = rows
    .iter()
    .filter(|row| row_step(row) == Some(step_id))
    .filter_map(row_version)
    .max()
    .unwrap_or(0);
  files.max(listed) + 1
}

/// 置き換える前に今の内容を版にするか（空でなく、置き換える内容とも、いちばん新しい版とも違う）。
pub(super) fn needs_auto_version(current: Option<&[u8]>, next: &[u8], newest: Option<&[u8]>) -> bool {
  match current {
    Some(current) => !current.iter().all(u8::is_ascii_whitespace) && current != next && Some(current) != newest,
    None => false,
  }
}

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
  hex(&Sha256::digest(bytes))
}

/// 新しい版のファイル（録音のフォルダの中の絶対 path と、案件フォルダからの path）。
pub(super) fn new_version_file(dir: &Path, prefix: &str, step_id: &str) -> (PathBuf, String) {
  let id = niho_desktop_vault::new_version_id();
  (
    dir.join("versions").join(step_id).join(format!("{id}.md")),
    format!("{prefix}versions/{step_id}/{id}.md"),
  )
}

/// 競合の解決で作る版の runs の行（工程の文書・文字起こしだけ。cloud.rs が WRITE_LOCK の中で呼ぶ）。`path`・`version_path` は
/// 案件フォルダから。runs.jsonl の案件フォルダからの path と、行を足した全体を返す（工程の文書でなければ None）。
pub(crate) fn resolution_run(
  project_dir: &Path,
  path: &str,
  version_path: &str,
  bytes: &[u8],
) -> Result<Option<(String, Vec<u8>)>> {
  let (prefix, rest) = match path.strip_prefix("recordings/").and_then(|rest| rest.split_once('/')) {
    Some((id, rest)) if validate_id(id).is_ok() => (format!("recordings/{id}/"), rest),
    _ => (String::new(), path),
  };
  let step_id = if rest == "transcript.md" {
    SOURCE_STEP_ID.to_string()
  } else {
    match rest
      .strip_prefix("artifacts/")
      .and_then(|name| name.strip_suffix(".md"))
    {
      Some(step) if validate_id(step).is_ok() => step.to_string(),
      _ => return Ok(None),
    }
  };
  let dir = project_dir.join(&prefix);
  let runs = dir.join("runs.jsonl");
  let rows = read_jsonl(&runs)?;
  let newest = newest_version_row(&rows, &step_id);
  let step_name = newest
    .and_then(|row| row.get("stepName"))
    .and_then(Value::as_str)
    .unwrap_or("")
    .to_string();
  let mut row = json!({
    "id": format!("save-{}", new_id(16)),
    "kind": "save",
    "at": now_iso(),
    "stepName": step_name,
    "version": next_display_version(&dir, &step_id, &rows),
    "result": "saved",
    "resolution": true,
    "outputChars": String::from_utf8_lossy(bytes).chars().count(),
    "versionPath": version_path,
    "versionSha256": sha256_hex(bytes),
  });
  copy_identity(&mut row, newest, &step_id);
  with_origin(&mut row);
  Ok(Some((format!("{prefix}runs.jsonl"), appended_lines(&runs, &[row])?)))
}

/// 書いた版（表示の番号と、自動の版を含む版のファイル）。
pub(super) struct WrittenVersion {
  pub(super) version: u32,
  pub(super) files: Vec<PathBuf>,
}

/// 版を足す保存の中身: 版のファイル・最新・runs の行。今の内容が版になっていなければ、その「保存」の版（`auto: true`）を先に。
/// `record` が None（最後の版に戻す）は版を足さず、今の内容の自動の版と最新だけ。
pub(super) struct VersionPlan {
  /// 足した版の表示の番号（版を足さないときは 0）。
  pub(super) version: u32,
  pub(super) files: Vec<(PathBuf, Vec<u8>)>,
  latest: PathBuf,
  markdown: Vec<u8>,
  runs: PathBuf,
  lines: Vec<Value>,
}

impl VersionPlan {
  /// `dir` は録音のフォルダ、`prefix` は案件フォルダからの録音の頭。WRITE_LOCK の中で呼ぶ。
  pub(super) fn new(
    dir: &Path,
    prefix: &str,
    step_id: &str,
    source: bool,
    markdown: &str,
    record: Option<&Value>,
  ) -> Result<Self> {
    // 文字起こしの別案（#19108）は工程 1 でも置き場は artifacts/<artifactId>.md（transcript.md は最初の案だけ）
    let latest = if source && step_id == SOURCE_STEP_ID {
      dir.join("transcript.md")
    } else {
      dir.join("artifacts").join(format!("{step_id}.md"))
    };
    let runs = dir.join("runs.jsonl");
    let rows = read_jsonl(&runs)?;
    let current = match fs::read(&latest) {
      Ok(bytes) => Some(bytes),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
      Err(error) => return Err(StoreError::io(error)),
    };
    let mut number = next_display_version(dir, step_id, &rows) - 1;
    let mut files = Vec::new();
    let mut lines = Vec::new();
    let mut record = record.cloned();
    let newest = newest_version_bytes(dir, prefix, step_id, &rows);
    if let Some(current) =
      current.filter(|current| needs_auto_version(Some(current.as_slice()), markdown.as_bytes(), newest.as_deref()))
    {
      // 自動の版は、置き換える記録と同じ時刻にする（並びは番号で後ろの記録が新しい）
      let at = record
        .as_ref()
        .and_then(|record| record.get("at"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(now_iso);
      if let Some(Value::Object(map)) = record.as_mut() {
        map.entry("at").or_insert(Value::from(at.clone()));
      }
      let step_name = record
        .as_ref()
        .and_then(|record| record.get("stepName"))
        .or_else(|| newest_version_row(&rows, step_id).and_then(|row| row.get("stepName")))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
      number += 1;
      let (path, relative) = new_version_file(dir, prefix, step_id);
      let mut auto = json!({
        "id": format!("save-{}", new_id(16)),
        "kind": "save",
        "at": at,
        "stepName": step_name,
        "version": number,
        "result": "saved",
        "auto": true,
        "outputChars": String::from_utf8_lossy(&current).chars().count(),
        "versionPath": relative,
        "versionSha256": sha256_hex(&current),
      });
      let identity = record.clone().or_else(|| newest_version_row(&rows, step_id).cloned());
      copy_identity(&mut auto, identity.as_ref(), step_id);
      with_origin(&mut auto);
      files.push((path, current));
      lines.push(auto);
    }
    let mut version = 0;
    if let Some(mut record) = record {
      number += 1;
      version = number;
      let (path, relative) = new_version_file(dir, prefix, step_id);
      if let Value::Object(map) = &mut record {
        // 工程の無い記録でも、版は置き場（versions/<stepId>/）の工程の版として数える
        map.entry("stepId").or_insert_with(|| Value::from(step_id));
        map.insert("version".into(), Value::from(number));
        map.insert("versionPath".into(), Value::from(relative));
        map.insert("versionSha256".into(), Value::from(sha256_hex(markdown.as_bytes())));
      }
      with_origin(&mut record);
      files.push((path, markdown.as_bytes().to_vec()));
      lines.push(record);
    }
    Ok(Self {
      version,
      files,
      latest,
      markdown: markdown.as_bytes().to_vec(),
      runs,
      lines,
    })
  }

  fn paths(&self) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = self.files.iter().map(|(path, _)| path.clone()).collect();
    paths.push(self.latest.clone());
    if !self.lines.is_empty() {
      paths.push(self.runs.clone());
    }
    paths
  }

  /// 1 つの group の書き込み（版のファイル・最新・runs.jsonl の全体）。
  fn writes(&self) -> Result<Vec<SinkWrite>> {
    let mut writes: Vec<SinkWrite> = self
      .files
      .iter()
      .map(|(path, bytes)| SinkWrite::Put(path.clone(), bytes.clone()))
      .collect();
    writes.push(SinkWrite::Put(self.latest.clone(), self.markdown.clone()));
    if !self.lines.is_empty() {
      writes.push(SinkWrite::Put(
        self.runs.clone(),
        appended_lines(&self.runs, &self.lines)?,
      ));
    }
    Ok(writes)
  }

  /// 口が受け取れば 1 つの group として journal へ。受け取らなければ順に書き、途中で失敗したら書いた分を戻す。
  pub(super) fn commit(&self) -> Result<()> {
    if let Some(sink) = save_sink() {
      if let Some(result) = sink.save(&self.writes()?, SinkKind::Version) {
        return result.map(|_| ());
      }
    }
    let previous_latest = match fs::read(&self.latest) {
      Ok(contents) => Some(contents),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
      Err(error) => return Err(StoreError::io(error)),
    };
    let runs_before = RunsSnapshot::take(&self.runs);
    let mut created: Vec<&Path> = Vec::new();
    let undo = |created: &[&Path]| {
      for path in created {
        let _ = fs::remove_file(path);
      }
    };
    for (path, bytes) in &self.files {
      let mut file = match fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(error) => {
          undo(&created);
          return Err(StoreError::io(error));
        }
      };
      created.push(path);
      if let Err(error) = file.write_all(bytes) {
        undo(&created);
        return Err(StoreError::io(error));
      }
    }
    if let Err(error) = write_plain(&self.latest, &self.markdown) {
      undo(&created);
      return Err(error);
    }
    for line in &self.lines {
      if let Err(error) = append_line_plain(&self.runs, line) {
        if let Some(previous) = &previous_latest {
          let _ = write_plain(&self.latest, previous);
        } else {
          let _ = fs::remove_file(&self.latest);
        }
        runs_before.restore(&self.runs);
        undo(&created);
        return Err(error);
      }
    }
    notify_changed(&self.paths());
    Ok(())
  }
}

impl Store {
  /// 最新の成果物・文字起こしの書きかけを今の path に保存する（版は足さない。spec §7.4.4）。保存の口を通れば、この Mac の
  /// 保存の世代を返す（フォルダ外の録音は同期しないので None）。この process が実行している場所は、実行の結果と重ならないよう断る。
  pub fn write_artifact_draft(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    step_id: &str,
    source: bool,
    markdown: &str,
  ) -> Result<Option<u64>> {
    validate_id(step_id)?;
    self.migrate_page_owner_at(project_id)?;
    let _guard = WRITE_LOCK.lock();
    let base = self.recording_parts_at(project_id, recording_id)?;
    if self.run_lock_holder_at(project_id) == Some(std::process::id()) {
      return Err(StoreError::new("store_busy", "実行中は書き換えられません。"));
    }
    let file = if source && step_id == SOURCE_STEP_ID {
      self.under(&base, &["transcript.md"])?
    } else {
      self.under(&base, &["artifacts", &format!("{step_id}.md")])?
    };
    write_atomic_as(&file, markdown.as_bytes(), SinkKind::Edit)
  }

  /// 版の本文。`version_path`（案件フォルダから。その録音の versions/<stepId>/ の `.md` だけ）を先に、無ければ旧形式の
  /// `<n>.md`、それも無ければ表示の番号が同じ runs の行の版。
  /// 版を読む。フォルダ外の録音（project_id が None）も同じ形で読む（P6）。
  pub fn read_version_at(
    &self,
    project_id: Option<&str>,
    recording_id: &str,
    step_id: &str,
    version: u32,
    version_path: Option<&str>,
  ) -> Result<String> {
    validate_id(step_id)?;
    let prefix = self.recording_prefix_at(project_id, recording_id)?;
    let read_named =
      |name: &str| read_text(&self.recording_file_at(project_id, recording_id, &["versions", step_id, name])?);
    if let Some(path) = version_path {
      let name = version_file_name(path, &prefix, step_id)
        .ok_or_else(|| StoreError::new("store_bad_id", "版の場所が正しくありません。"))?;
      if let Some(text) = read_named(name)? {
        return Ok(text);
      }
    }
    if let Some(text) = read_named(&format!("{version}.md"))? {
      return Ok(text);
    }
    let rows = read_jsonl(&self.recording_file_at(project_id, recording_id, &["runs.jsonl"])?)?;
    let row = rows
      .iter()
      .filter(|row| row_step(row) == Some(step_id) && row_version(row) == Some(version))
      .max_by(|left, right| row_order(left, right));
    if let Some(name) = row
      .and_then(|row| row.get("versionPath"))
      .and_then(Value::as_str)
      .and_then(|path| version_file_name(path, &prefix, step_id))
    {
      if let Some(text) = read_named(name)? {
        return Ok(text);
      }
    }
    Err(StoreError::new("store_no_version", "その版が見つかりません。"))
  }
}
