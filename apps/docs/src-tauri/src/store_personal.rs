//! 本人 Mac 実行（R6 #18739）の読み書き。store.rs の子 module。personal_run.rs が捕捉した Store に対してだけ呼ぶ。
//!
//! - 録音はページ（`recordingPageId`）と録音（`recording.json` の id）を別に照合する（フォルダ外とフォルダの両方）。今の案件の
//!   root の録音（案件フォルダ直下）は、版の path が `recordings/<id>/` で始まらないので扱わない。
//! - 候補は不変の版ファイル（`recordings/<id>/versions/<stepId>/<name>.md`）として書くだけで、現在本文・runs.jsonl・表示の番号には
//!   触らない。同じ中身なら何もしない、違えば断る。
//! - 公開は、現在本文の照合（呼び出し側が保存の口で journal の中でも照合する）・現在本文・runs.jsonl の行・実行の集約
//!   （`recordings/<id>/personal-runs/<runId>.json`）を 1 つの保存単位で書く。

use super::sink::{appended_lines, json_bytes, save_writes, SinkKind, SinkWrite};
use super::versions::{
  copy_identity, needs_auto_version, new_version_file, newest_version_bytes, newest_version_row, next_display_version,
  read_plain_file, row_order, row_step, sha256_hex, version_file_name,
};
use super::{
  new_id, read_json, read_jsonl, validate_id, validate_input_file, validate_run_id, Result, Store, StoreError,
  WRITE_LOCK,
};
use super::{ROOT_RECORDING_ID, SOURCE_STEP_ID};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

/// 本人 Mac 実行の集約を置く録音の中の場所（同期の対象。docs-root では `recordings/<id>/**` の許可の中）。
pub(crate) const PERSONAL_RUNS_DIR: &str = "personal-runs";

/// ページと録音を照合した録音の場所。
pub(crate) struct PersonalRecording {
  /// 録音のフォルダ（root の下の実体のパス）。
  pub(crate) dir: PathBuf,
  /// 案件フォルダ（フォルダ外は保存先）から見た録音の頭（`recordings/<id>/`）。
  pub(crate) prefix: String,
  /// recording.json（話者・言語は今の形に読み替えた値）。
  pub(crate) recording: Value,
  /// ページの持ち主（フォルダは project.json、フォルダ外は pages.json）。
  pub(crate) owner: Value,
  base: Vec<String>,
}

/// 録音の音声の写し 1 つ。
pub(crate) struct PersonalAudio {
  /// 案件フォルダ（フォルダ外は保存先）から見た path（`recordings/<id>/inputs/<file>`）。
  pub(crate) relative: String,
  pub(crate) path: PathBuf,
  /// recording.json に記録された SHA-256（無ければ None）。
  pub(crate) recorded_sha256: Option<String>,
  pub(crate) duration_sec: Value,
}

/// 版ファイル 1 つ（versionPath のある行が指す不変のファイル）。
pub(crate) struct PersonalVersion {
  /// ファイル名の拡張子を除いた部分（`v_<乱数>`）。
  pub(crate) version_id: String,
  pub(crate) path: String,
  pub(crate) bytes: Vec<u8>,
  pub(crate) row: Value,
}

/// 自動参考ページ 1 枚（同じフォルダの台帳順にある独立文書だけ）。
pub(crate) struct PersonalReference {
  pub(crate) page_id: String,
  pub(crate) title: String,
  pub(crate) path: String,
  pub(crate) body: String,
}

pub(crate) enum CandidateWrite {
  Created,
  Existing,
}

pub(crate) enum PublishOutcome {
  Committed { version: u32 },
}

/// 公開する候補と記録。
pub(crate) struct PersonalPublish<'a> {
  /// runs.jsonl の論理工程。別案でも工程IDのまま。
  pub(crate) step_id: &'a str,
  /// 現在本文・版の置き場。通常はstep_id、別案はcandidateのartifactId。
  pub(crate) artifact_id: &'a str,
  pub(crate) source: bool,
  /// 候補の版ファイルの path（案件フォルダから）。
  pub(crate) candidate_path: &'a str,
  pub(crate) candidate_sha256: &'a str,
  /// 受付時に固定した現在本文。公開は照合で止めず、差分の知らせにだけ使う。
  pub(crate) expected_current_sha256: Option<&'a str>,
  /// runs.jsonl の行（version・versionPath・versionSha256 はここで足す）。
  pub(crate) record: Value,
  pub(crate) run_id: &'a str,
  pub(crate) aggregate: &'a Value,
}

fn unsupported() -> StoreError {
  StoreError::new(
    "personal_recording_unsupported",
    "この録音は古い形式のため、この実行方法では使えません。",
  )
}

fn bad_path() -> StoreError {
  StoreError::new("personal_path_not_allowed", "録音の版の場所が正しくありません。")
}

/// 公開した版（`version_id`）に、runs.jsonl の行と同じ表示の番号（`displayVersion`）を付けた集約。付けるのは集約の `versions` と
/// `sourceVersion` のうち同じ版 ID のものだけ（ほかの欄・ほかの版は受け取ったまま）。
fn numbered_aggregate(aggregate: &Value, version_id: &str, number: u32) -> Value {
  let mut aggregate = aggregate.clone();
  let stamp = |item: &mut Value| {
    if item.get("versionId").and_then(Value::as_str) == Some(version_id) {
      if let Some(map) = item.as_object_mut() {
        map.insert("displayVersion".into(), Value::from(number));
      }
    }
  };
  if let Some(versions) = aggregate.get_mut("versions").and_then(Value::as_array_mut) {
    for item in versions.iter_mut() {
      stamp(item);
    }
  }
  if let Some(source) = aggregate.get_mut("sourceVersion") {
    stamp(source);
  }
  aggregate
}

/// 版ファイルの path が、その録音のその工程の `versions/<stepId>/<name>.md`（name は安全な id）か。名前を返す。候補の新規の
/// 書き込み・公開はこれだけ（今の録音の頭 `recordings/<id>/` で始まる path）。
pub(crate) fn personal_version_name<'a>(path: &'a str, prefix: &str, step_id: &str) -> Option<&'a str> {
  if prefix.is_empty() || !path.starts_with(prefix) {
    return None;
  }
  version_file_name(path, prefix, step_id)
}

/// 既に書かれた版を読むときの名前。`personal_version_name` に加えて、移行前（P6 #18607。旧形式の root の録音をページとして移動する前）
/// に書いた行の頭の無い path（`versions/<stepId>/<name>.md`）も、この録音の版として受け付ける。新しい候補の書き込みは今の頭だけ
/// （`personal_version_name`）。
fn personal_existing_version_name<'a>(path: &'a str, prefix: &str, step_id: &str) -> Option<&'a str> {
  if prefix.is_empty() {
    return None;
  }
  version_file_name(path, prefix, step_id)
}

/// 版の path を、この録音の頭つきの形（画面・固定入力が使う形）にそろえる。
fn personal_version_path(prefix: &str, step_id: &str, name: &str) -> String {
  format!("{prefix}versions/{step_id}/{name}")
}

impl Store {
  /// ページ（`page_id`）が録音のページで、その録音 id が `recording_id`、recording.json の id（と pageId があればそれ）が一致する
  /// ときだけ、その録音の場所を返す。別の保存先の同じ id・リンク・root の録音は断る。
  pub(crate) fn personal_recording(
    &self,
    project_id: Option<&str>,
    page_id: &str,
    recording_id: &str,
  ) -> Result<PersonalRecording> {
    validate_id(page_id)?;
    validate_id(recording_id)?;
    if page_id == ROOT_RECORDING_ID || recording_id == ROOT_RECORDING_ID {
      return Err(unsupported());
    }
    let owner = self.read_page_owner(project_id)?;
    let page = Self::page_list(&owner)
      .into_iter()
      .find(|page| Self::page_id(page) == Some(page_id))
      .ok_or_else(StoreError::no_page)?;
    if Self::page_field(&page, "kind") != Some("rec") || Self::recording_id(&page) != Some(recording_id) {
      return Err(StoreError::no_recording());
    }
    let mut base: Vec<String> = self
      .page_space_parts(project_id)?
      .into_iter()
      .map(str::to_string)
      .collect();
    base.extend(["recordings".to_string(), recording_id.to_string()]);
    let dir = self.under(&base, &[])?;
    let file = self.under(&base, &["recording.json"])?;
    let meta = fs::symlink_metadata(&file).map_err(|_| StoreError::no_recording())?;
    if !meta.is_file() {
      return Err(StoreError::no_recording());
    }
    let raw = read_json(&file)?.ok_or_else(StoreError::no_recording)?;
    if raw.get("id").and_then(Value::as_str) != Some(recording_id) {
      return Err(StoreError::no_recording());
    }
    if let Some(recorded_page) = raw.get("pageId") {
      if recorded_page.as_str() != Some(page_id) {
        return Err(StoreError::no_recording());
      }
    }
    Ok(PersonalRecording {
      dir,
      prefix: format!("recordings/{recording_id}/"),
      recording: Self::runtime_recording(&raw),
      owner,
      base,
    })
  }

  /// 同意後のモデル持ち替えを、期待した flowSnapshot のままの場合だけ一度に保存する。未知の recording.json の欄は保つ。
  pub(crate) fn personal_swap_models(
    &self,
    project_id: Option<&str>,
    page_id: &str,
    recording_id: &str,
    expected_flow: &Value,
    models_to_swap: &Value,
  ) -> Result<bool> {
    let Some(models_to_swap) = models_to_swap.as_object().filter(|models| !models.is_empty()) else {
      return Err(StoreError::new(
        "personal_bad_model_swap",
        "持ち替えるモデルが正しくありません。",
      ));
    };
    let expected_steps = expected_flow
      .get("steps")
      .and_then(Value::as_array)
      .ok_or_else(|| StoreError::new("personal_bad_model_swap", "確認した工程が正しくありません。"))?;
    let expected_models = expected_flow
      .get("models")
      .and_then(Value::as_object)
      .ok_or_else(|| StoreError::new("personal_bad_model_swap", "確認したモデルが正しくありません。"))?;
    for (step_id, model) in models_to_swap {
      validate_id(step_id)?;
      if !expected_steps
        .iter()
        .any(|step| step.get("id").and_then(Value::as_str) == Some(step_id.as_str()))
        || !expected_models.contains_key(step_id)
        || !model.is_object()
      {
        return Err(StoreError::new(
          "personal_bad_model_swap",
          "持ち替える工程かモデルが正しくありません。",
        ));
      }
    }

    // 読み直し・revision 照合・書き込みを同じ lock の中で行い、同時に保存された別端末の変更を上書きしない。
    let _guard = WRITE_LOCK.lock();
    let rec = self.personal_recording(project_id, page_id, recording_id)?;
    let file = self.under(&rec.base, &["recording.json"])?;
    let mut raw = read_json(&file)?.ok_or_else(StoreError::no_recording)?;
    if raw.get("flowSnapshot") != Some(expected_flow) {
      return Ok(false);
    }
    let Some(flow) = raw.get_mut("flowSnapshot") else {
      return Ok(false);
    };
    let Some(models) = flow.get_mut("models").and_then(Value::as_object_mut) else {
      return Err(StoreError::new("store_bad_json", "録音のモデルが正しくありません。"));
    };
    for (step_id, model) in models_to_swap {
      models.insert(step_id.clone(), model.clone());
    }
    super::write_json(&file, &raw)?;
    Ok(true)
  }

  /// 録音の音声の写し（recording.json の source.audio の順）。
  pub(crate) fn personal_audio(&self, rec: &PersonalRecording) -> Result<Vec<PersonalAudio>> {
    let items = rec
      .recording
      .get("source")
      .filter(|source| source.get("kind").and_then(Value::as_str) == Some("audio"))
      .and_then(|source| source.get("audio"))
      .and_then(Value::as_array)
      .cloned()
      .unwrap_or_default();
    items
      .iter()
      .map(|item| {
        let file = item
          .get("file")
          .and_then(Value::as_str)
          .ok_or_else(|| StoreError::new("store_bad_id", "音声のファイル名が正しくありません。"))?;
        validate_input_file(file)?;
        Ok(PersonalAudio {
          relative: format!("{}inputs/{file}", rec.prefix),
          path: self.under(&rec.base, &["inputs", file])?,
          recorded_sha256: item.get("hash").and_then(Value::as_str).map(str::to_string),
          duration_sec: item.get("durationSec").cloned().unwrap_or(Value::Null),
        })
      })
      .collect()
  }

  /// 工程の現在本文のファイル（工程 1 の最初の案は transcript.md、ほかは artifacts/<artifactId>.md）。文字起こしの別案（#19108）は
  /// `source` のまま artifactId の置き場を使う（台帳に属するかは公開のときに確かめる）。
  pub(crate) fn personal_current_file(&self, rec: &PersonalRecording, step_id: &str, source: bool) -> Result<PathBuf> {
    validate_id(step_id)?;
    if step_id == SOURCE_STEP_ID {
      if !source {
        return Err(bad_path());
      }
      self.under(&rec.base, &["transcript.md"])
    } else {
      self.under(&rec.base, &["artifacts", &format!("{step_id}.md")])
    }
  }

  /// 後工程に使う文字起こしの置き場（`sourceCandidateId` が指す案の artifactId。台帳が無ければ SOURCE_STEP_ID）。指定が台帳に
  /// 無いときは別の案へ寄せずに断る（docs-core の selectedSourceCandidate と同じ）。
  pub(crate) fn personal_selected_source_artifact(&self, rec: &PersonalRecording) -> Result<String> {
    selected_source_artifact(&rec.recording)
  }

  /// 工程のいちばん新しい版（versionPath があり、その録音の版を指す行だけ。移行前の頭の無い path も含む。旧形式の連番の版は扱わない）。
  pub(crate) fn personal_latest_version(
    &self,
    rec: &PersonalRecording,
    step_id: &str,
  ) -> Result<Option<PersonalVersion>> {
    validate_id(step_id)?;
    let rows = read_jsonl(&self.under(&rec.base, &["runs.jsonl"])?)?;
    let Some(row) = newest_version_row(&rows, step_id) else {
      return Ok(None);
    };
    let Some(path) = row.get("versionPath").and_then(Value::as_str) else {
      return Ok(None);
    };
    let Some(name) = personal_existing_version_name(path, &rec.prefix, step_id) else {
      return Ok(None);
    };
    let file = self.under(&rec.base, &["versions", step_id, name])?;
    let Some(bytes) = read_plain_file(&file) else {
      return Ok(None);
    };
    // 移行前の頭の無い path も、今の録音の版の場所（`recordings/<id>/versions/...`）で返す
    Ok(Some(PersonalVersion {
      version_id: name.trim_end_matches(".md").to_string(),
      // 移行前の頭の無い path で書いた行でも、画面へは今の頭つきの path を返す（固定入力の path の検査が頭を要る）
      path: personal_version_path(&rec.prefix, step_id, name),
      bytes,
      row: row.clone(),
    }))
  }

  /// その工程の版の path を指す runs.jsonl の行（同じ版を指す行が複数あれば、いちばん新しいもの）。移行前の頭の無い path で書いた行も、
  /// 同じ版ファイルを指していれば同じ版の行として扱う。
  pub(crate) fn personal_version_row(
    &self,
    rec: &PersonalRecording,
    step_id: &str,
    path: &str,
  ) -> Result<Option<Value>> {
    validate_id(step_id)?;
    let Some(name) = personal_existing_version_name(path, &rec.prefix, step_id) else {
      return Ok(None);
    };
    let rows = read_jsonl(&self.under(&rec.base, &["runs.jsonl"])?)?;
    Ok(
      rows
        .into_iter()
        .filter(|row| {
          row_step(row) == Some(step_id)
            && row
              .get("versionPath")
              .and_then(Value::as_str)
              .and_then(|row_path| personal_existing_version_name(row_path, &rec.prefix, step_id))
              == Some(name)
        })
        .max_by(row_order),
    )
  }

  /// 別案を含む公開済み版の行。版の置き場は artifactId、runs.jsonl の論理工程は stepId。
  pub(crate) fn personal_published_version_row(
    &self,
    rec: &PersonalRecording,
    step_id: &str,
    artifact_id: &str,
    path: &str,
  ) -> Result<Option<Value>> {
    validate_id(step_id)?;
    validate_id(artifact_id)?;
    let Some(name) = personal_existing_version_name(path, &rec.prefix, artifact_id) else {
      return Ok(None);
    };
    let rows = read_jsonl(&self.under(&rec.base, &["runs.jsonl"])?)?;
    Ok(
      rows
        .into_iter()
        .filter(|row| {
          row_step(row) == Some(step_id)
            && row.get("artifactId").and_then(Value::as_str).unwrap_or(step_id) == artifact_id
            && row
              .get("versionPath")
              .and_then(Value::as_str)
              .and_then(|row_path| personal_existing_version_name(row_path, &rec.prefix, artifact_id))
              == Some(name)
        })
        .max_by(row_order),
    )
  }

  /// 版ファイルの中身（path はその録音のその工程の版だけ。移行前の頭の無い path も読む。無い・リンクなら None）。
  pub(crate) fn personal_read_version(
    &self,
    rec: &PersonalRecording,
    step_id: &str,
    path: &str,
  ) -> Result<Option<Vec<u8>>> {
    validate_id(step_id)?;
    let name = personal_existing_version_name(path, &rec.prefix, step_id).ok_or_else(bad_path)?;
    Ok(read_plain_file(&self.under(&rec.base, &["versions", step_id, name])?))
  }

  /// 録音と同じフォルダの自動参考ページ（台帳順の独立文書。本文が空の文書も返す〔使うかは呼び出し側〕）。
  pub(crate) fn personal_references(
    &self,
    project_id: Option<&str>,
    rec: &PersonalRecording,
  ) -> Result<Vec<PersonalReference>> {
    // ホームには録音と同じフォルダという境界がないため、自動参考を入れない。
    if project_id.is_none() {
      return Ok(Vec::new());
    }
    let pages = Self::page_list(&rec.owner);
    let mut found = Vec::new();
    for page in pages {
      if Self::page_field(&page, "kind") != Some("doc") || page.get("derivation").is_some() {
        continue;
      }
      let Some(page_id) = Self::page_id(&page).map(str::to_string) else {
        continue;
      };
      let file = self.doc_file_at(project_id, &page_id)?;
      let body = match read_plain_file(&file) {
        Some(bytes) => {
          String::from_utf8(bytes).map_err(|_| StoreError::new("store_bad_page", "参考ページを読めませんでした。"))?
        }
        None => String::new(),
      };
      found.push(PersonalReference {
        title: Self::page_field(&page, "title").unwrap_or_default().to_string(),
        path: format!("pages/{page_id}.md"),
        page_id,
        body,
      });
    }
    Ok(found)
  }

  /// 参考ページの本文（`pages/<pageId>.md` の形の path だけ。台帳に文書として載っていなければ断る）。
  pub(crate) fn personal_read_page(
    &self,
    project_id: Option<&str>,
    page_id: &str,
    path: &str,
  ) -> Result<Option<Vec<u8>>> {
    validate_id(page_id)?;
    if path != format!("pages/{page_id}.md") {
      return Err(bad_path());
    }
    Ok(read_plain_file(&self.doc_file_at(project_id, page_id)?))
  }

  /// 候補を不変の版ファイルとして書く（現在本文・runs.jsonl は触らない）。同じ中身が既にあれば何もしない。違えば断る。
  /// 書き込みは保存の口（捕捉した namespace の journal）を通す。
  pub(crate) fn personal_write_candidate(
    &self,
    rec: &PersonalRecording,
    step_id: &str,
    path: &str,
    bytes: &[u8],
  ) -> Result<CandidateWrite> {
    validate_id(step_id)?;
    let name = personal_version_name(path, &rec.prefix, step_id).ok_or_else(bad_path)?;
    let _guard = WRITE_LOCK.lock();
    let file = self.under(&rec.base, &["versions", step_id, name])?;
    match fs::symlink_metadata(&file) {
      Ok(meta) if meta.is_file() => {
        let existing = fs::read(&file).map_err(StoreError::io)?;
        return if existing == bytes {
          Ok(CandidateWrite::Existing)
        } else {
          Err(StoreError::new(
            "personal_candidate_collision",
            "同じ場所に別の内容の版があります。もう一度実行してください。",
          ))
        };
      }
      Ok(_) => return Err(bad_path()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => return Err(StoreError::io(error)),
    }
    fs::create_dir_all(self.under(&rec.base, &["versions", step_id])?).map_err(StoreError::io)?;
    save_writes(vec![SinkWrite::Put(file, bytes.to_vec())], SinkKind::Version)?;
    Ok(CandidateWrite::Created)
  }

  /// 候補を現在本文として公開する。直前の現在本文が版になっていなければ、同じ保存単位で自動の版に残す。
  pub(crate) fn personal_publish(&self, rec: &PersonalRecording, input: PersonalPublish<'_>) -> Result<PublishOutcome> {
    validate_id(input.step_id)?;
    validate_id(input.artifact_id)?;
    validate_run_id(input.run_id)?;
    let name = personal_version_name(input.candidate_path, &rec.prefix, input.artifact_id).ok_or_else(bad_path)?;
    let _guard = WRITE_LOCK.lock();
    let latest = self.personal_current_file(rec, input.artifact_id, input.source)?;
    let current = match fs::symlink_metadata(&latest) {
      Ok(meta) if meta.is_file() => Some(fs::read(&latest).map_err(StoreError::io)?),
      Ok(_) => return Err(bad_path()),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
      Err(error) => return Err(StoreError::io(error)),
    };
    if input.expected_current_sha256.is_some() && current.is_none() {
      return Err(StoreError::new(
        "personal_target_deleted",
        "このページは削除されたため、結果を反映できません。",
      ));
    }
    if input.source && input.artifact_id != SOURCE_STEP_ID {
      // 文字起こしの別案: 台帳から消えた案へ遅い結果を書いて戻さない
      let recording = read_json(&self.under(&rec.base, &["recording.json"])?)?.ok_or_else(StoreError::no_recording)?;
      let candidate_exists = recording
        .get("candidateSets")
        .and_then(|sets| sets.get(SOURCE_STEP_ID))
        .and_then(|set| set.get("items"))
        .and_then(Value::as_object)
        .is_some_and(|items| {
          items
            .values()
            .any(|item| item.get("artifactId").and_then(Value::as_str) == Some(input.artifact_id))
        });
      if !candidate_exists {
        return Err(StoreError::new(
          "personal_target_deleted",
          "この文字起こしは削除されたため、結果を反映できません。",
        ));
      }
    }
    if !input.source {
      let recording = read_json(&self.under(&rec.base, &["recording.json"])?)?.ok_or_else(StoreError::no_recording)?;
      let step_exists = recording
        .get("flowSnapshot")
        .and_then(|flow| flow.get("steps"))
        .and_then(Value::as_array)
        .is_some_and(|steps| {
          steps
            .iter()
            .any(|step| step.get("id").and_then(Value::as_str) == Some(input.step_id))
        });
      if !step_exists {
        return Err(StoreError::new(
          "personal_step_deleted",
          "この工程は削除されたため、結果を反映できません。",
        ));
      }
    }
    let target_changed = current.as_deref().map(sha256_hex).as_deref() != input.expected_current_sha256;
    let candidate =
      read_plain_file(&self.under(&rec.base, &["versions", input.artifact_id, name])?).ok_or_else(|| {
        StoreError::new(
          "personal_candidate_changed",
          "保存した候補が見つかりません。もう一度実行してください。",
        )
      })?;
    if sha256_hex(&candidate) != input.candidate_sha256 {
      return Err(StoreError::new(
        "personal_candidate_changed",
        "保存した候補の内容が変わりました。もう一度実行してください。",
      ));
    }
    let runs = self.under(&rec.base, &["runs.jsonl"])?;
    let rows = read_jsonl(&runs)?;
    let newest = newest_version_bytes(&rec.dir, &rec.prefix, input.artifact_id, &rows);
    let mut number = next_display_version(&rec.dir, input.artifact_id, &rows) - 1;
    let mut writes = Vec::new();
    let mut lines = Vec::new();
    let mut record = input.record;
    let record_identity = record.clone();
    let at = record
      .get("at")
      .and_then(Value::as_str)
      .map(str::to_string)
      .unwrap_or_else(super::now_iso);
    if let Some(current) = current
      .as_deref()
      .filter(|current| needs_auto_version(Some(current), &candidate, newest.as_deref()))
    {
      // 公開の前に、版になっていない今の内容（人の書きかけ）を「保存」の版として同じ保存単位で残す（VersionPlan と同じ）
      number += 1;
      fs::create_dir_all(self.under(&rec.base, &["versions", input.artifact_id])?).map_err(StoreError::io)?;
      let (path, relative) = new_version_file(&rec.dir, &rec.prefix, input.artifact_id);
      let step_name = record
        .get("stepName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
      let mut auto = json!({
        "id": format!("save-{}", new_id(16)),
        "kind": "save",
        "at": at,
        "stepName": step_name,
        "version": number,
        "result": "saved",
        "auto": true,
        "reasonCode": "overwritten_by_ai",
        "outputChars": String::from_utf8_lossy(current).chars().count(),
        "versionPath": relative,
        "versionSha256": sha256_hex(current),
      });
      copy_identity(
        &mut auto,
        newest_version_row(&rows, input.artifact_id).or(Some(&record_identity)),
        input.step_id,
      );
      if let Some(device) = record.get("originDeviceId").cloned() {
        auto["originDeviceId"] = device;
      }
      writes.push(SinkWrite::Put(path, current.to_vec()));
      lines.push(auto);
    }
    number += 1;
    if let Value::Object(map) = &mut record {
      if target_changed
        && current
          .as_deref()
          .is_some_and(|body| sha256_hex(body) != input.candidate_sha256)
      {
        map.insert("reasonCode".into(), Value::from("target_changed_during_execution"));
      }
      map.entry("at").or_insert(Value::from(at));
      map.insert("stepId".into(), Value::from(input.step_id));
      map.insert("version".into(), Value::from(number));
      map.insert("versionPath".into(), Value::from(input.candidate_path));
      map.insert("versionSha256".into(), Value::from(input.candidate_sha256));
    } else {
      return Err(StoreError::new("store_bad_json", "実行の記録の形が正しくありません。"));
    }
    lines.push(record);
    if !input.source {
      fs::create_dir_all(self.under(&rec.base, &["artifacts"])?).map_err(StoreError::io)?;
    }
    writes.push(SinkWrite::Put(latest, candidate));
    writes.push(SinkWrite::Put(runs.clone(), appended_lines(&runs, &lines)?));
    // 集約の同じ版にも、runs.jsonl の行と同じ表示の番号を同じ保存単位で付ける（画面の手元の履歴・返り値と一致させる）
    let aggregate = numbered_aggregate(input.aggregate, name.trim_end_matches(".md"), number);
    writes.push(self.personal_aggregate_write(rec, input.run_id, &aggregate)?);
    save_writes(writes, SinkKind::Version)?;
    Ok(PublishOutcome::Committed { version: number })
  }

  /// CAS を伴わない記録（候補の保持・取消・失敗）: 実行の集約と、あれば runs.jsonl の行（数値の版を付けない）を 1 つの保存単位で。
  pub(crate) fn personal_record(
    &self,
    rec: &PersonalRecording,
    run_id: &str,
    aggregate: &Value,
    record: Option<Value>,
    checkpoint: Option<(&str, &Value)>,
  ) -> Result<()> {
    validate_run_id(run_id)?;
    let _guard = WRITE_LOCK.lock();
    let mut writes = vec![self.personal_aggregate_write(rec, run_id, aggregate)?];
    if let Some(mut record) = record {
      let Value::Object(map) = &mut record else {
        return Err(StoreError::new("store_bad_json", "実行の記録の形が正しくありません。"));
      };
      map.insert("version".into(), Value::Null);
      let runs = self.under(&rec.base, &["runs.jsonl"])?;
      writes.push(SinkWrite::Put(runs.clone(), appended_lines(&runs, &[record])?));
    }
    if let Some((checkpoint_id, checkpoint)) = checkpoint {
      validate_run_id(checkpoint_id)?;
      fs::create_dir_all(self.under(&rec.base, &["runs"])?).map_err(StoreError::io)?;
      let file = self.under(&rec.base, &["runs", &format!("{checkpoint_id}.json")])?;
      writes.push(SinkWrite::Put(file, json_bytes(checkpoint)?));
    }
    save_writes(writes, SinkKind::Run).map(|_| ())
  }

  /// 実行の集約（`recordings/<id>/personal-runs/<runId>.json`）の書き込み。
  fn personal_aggregate_write(&self, rec: &PersonalRecording, run_id: &str, aggregate: &Value) -> Result<SinkWrite> {
    let dir = self.under(&rec.base, &[PERSONAL_RUNS_DIR])?;
    fs::create_dir_all(&dir).map_err(StoreError::io)?;
    let file = self.under(&rec.base, &[PERSONAL_RUNS_DIR, &format!("{run_id}.json")])?;
    Ok(SinkWrite::Put(file, json_bytes(aggregate)?))
  }
}

/// 録音の `sourceCandidateId` が指す文字起こしの案の artifactId（台帳が無ければ SOURCE_STEP_ID）。
pub(crate) fn selected_source_artifact(recording: &Value) -> Result<String> {
  let not_found = || {
    StoreError::new(
      "source_candidate_missing",
      "後工程に使う文字起こしが見つかりません。録音のページで選び直してください。",
    )
  };
  let selected = recording.get("sourceCandidateId").and_then(Value::as_str);
  let Some(set) = recording.get("candidateSets").and_then(|sets| sets.get(SOURCE_STEP_ID)) else {
    return match selected {
      Some(_) => Err(not_found()),
      None => Ok(SOURCE_STEP_ID.to_string()),
    };
  };
  let id = match selected {
    Some(id) => id.to_string(),
    None => set
      .get("order")
      .and_then(Value::as_array)
      .and_then(|order| order.first())
      .and_then(Value::as_str)
      .ok_or_else(not_found)?
      .to_string(),
  };
  let artifact = set
    .get("items")
    .and_then(|items| items.get(&id))
    .and_then(|item| item.get("artifactId"))
    .and_then(Value::as_str)
    .ok_or_else(not_found)?;
  validate_id(artifact)?;
  Ok(artifact.to_string())
}

#[cfg(test)]
mod selected_source_tests {
  use super::selected_source_artifact;
  use serde_json::json;

  #[test]
  fn the_selected_transcript_never_falls_back_to_another_candidate() {
    assert_eq!(selected_source_artifact(&json!({})).unwrap(), "source");
    let set = json!({
      "source": {
        "stepId": "source",
        "order": ["tx1", "tx2"],
        "items": {
          "tx1": { "id": "tx1", "artifactId": "source" },
          "tx2": { "id": "tx2", "artifactId": "artifact-tx2" }
        }
      }
    });
    assert_eq!(
      selected_source_artifact(&json!({ "candidateSets": set })).unwrap(),
      "source"
    );
    assert_eq!(
      selected_source_artifact(&json!({ "candidateSets": set, "sourceCandidateId": "tx2" })).unwrap(),
      "artifact-tx2"
    );
    let missing = selected_source_artifact(&json!({ "candidateSets": set, "sourceCandidateId": "gone" })).unwrap_err();
    assert_eq!(missing.code, "source_candidate_missing");
    assert!(selected_source_artifact(&json!({ "sourceCandidateId": "tx2" })).is_err());
  }
}
