//! 工程（フロー）の保存（P4 #18567。フローを複数持ち、録音のページごとに選ぶ）。store.rs の子 module（同じ守り: id だけで
//! パスを作り、root の中のリンクを断り、書き込みは WRITE_LOCK の中で一時ファイル → rename）。
//!
//! ```text
//! flows/<flowId>.json          フロー 1 本（docs-core の Flow）
//! flows/index.json             { version: 1, order: string[], lastUsed: string | null }（並びと、最後に使ったフロー）
//! flows/samples/<flowId>/…     お手本の文書の本文（フローごと。store.rs の import_sample）
//! flows/active.json            P4 より前の 1 本。index が無いときだけ 1 本目として読む
//! ```
//!
//! - 読む: index があればその並び（並びに無いファイルは後ろに id の順で足し、ファイルの無い id は外す）。index が無く
//!   active.json があれば、それを 1 本目（並びの先頭・最後に使ったフロー）として読む。読めないファイルは飛ばす（ほかの
//!   フローは読める）。読めない index は空の並びと読む（ファイルは id の順で並ぶ。次の書き込みで書き直す）。
//! - 移す: index が無く active.json がある状態で最初の書き込み（保存・複製・削除・最後に使ったフローの更新）が来たら、先に
//!   flows/<id>.json と index.json を書き、active.json を消してから、その書き込みをする（新しい形を書いてから古いものを
//!   消すので、途中で失敗してもどちらかの形で読める）。読めない active.json は移さず、消さない。
//! - フローの id は validate_id の形で、`active`・`index`（予約のファイル名）は使えない。録音の flowSnapshot.id が元のフロー。

use super::{
  notify_changed, read_json, validate_id, write_atomic, write_json, write_json_as, Result, SinkKind, Store, StoreError,
  WRITE_LOCK,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

/// flows/ の中の予約のファイル名（フローの id に使えない）。
const RESERVED_FLOW_IDS: [&str; 2] = ["active", "index"];
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// docs-core の Number.isSafeInteger と同じ 0 以上の整数範囲。
fn safe_count(value: &Value) -> bool {
  value.as_u64().is_some_and(|count| count <= JS_MAX_SAFE_INTEGER)
}

/// フローの一覧（画面の `FlowList`）。flows は order の並び。last_used は並びにあるものだけ（無ければ画面は並びの先頭）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowList {
  pub flows: Vec<Value>,
  pub order: Vec<String>,
  pub last_used: Option<String>,
}

/// 読んだフローの状態（書き込みは WRITE_LOCK の中でこれを読み、active.json を移してから書く）。
struct FlowState {
  flows: BTreeMap<String, Value>,
  order: Vec<String>,
  last_used: Option<String>,
  /// index が無く、active.json を 1 本目として読んでいる（その id。最初の書き込みで移す）。
  legacy: Option<String>,
}

fn no_flow() -> StoreError {
  StoreError::new("store_no_flow", "工程が見つかりません。")
}

/// フローの id（validate_id の形で、予約のファイル名でないもの）。
fn validate_flow_id(id: &str) -> Result<()> {
  validate_id(id)?;
  if RESERVED_FLOW_IDS.contains(&id) {
    Err(StoreError::new("store_bad_id", "id が正しくありません。"))
  } else {
    Ok(())
  }
}

fn glossary_entry_shape_ok(term: &Value) -> bool {
  term.get("term").is_some_and(Value::is_string)
    && term.get("reading").is_some_and(Value::is_string)
    && term
      .get("variants")
      .and_then(Value::as_array)
      .is_some_and(|variants| variants.iter().all(Value::is_string))
    && term.get("note").is_some_and(Value::is_string)
}

fn flow_sample_shape_ok(sample: &Value) -> bool {
  sample.get("id").is_some_and(Value::is_string)
    && sample.get("name").is_some_and(Value::is_string)
    && sample.get("chars").is_some_and(safe_count)
    && sample.get("truncatedFrom").map_or(true, safe_count)
}

fn flow_step_shape_ok(step: &Value) -> bool {
  step.get("id").is_some_and(Value::is_string)
    && step.get("name").is_some_and(Value::is_string)
    && step.get("instruction").is_some_and(Value::is_string)
    && step.get("profile").is_some_and(Value::is_string)
    && step.get("provider").map_or(true, |provider| {
      matches!(provider.as_str(), Some("claude" | "gpt" | "gemini"))
    })
}

/// docs-core の Flow の形か（画面がそのまま描く欄と配列要素まで検証する）。形の違うファイルは読まず、画面を止めない。
fn flow_shape_ok(flow: &Value) -> bool {
  flow.get("version").and_then(Value::as_u64) == Some(1)
    && flow.get("name").is_some_and(Value::is_string)
    && flow.get("guide").is_some_and(Value::is_string)
    && flow.get("revision").is_some_and(safe_count)
    && flow
      .get("terms")
      .and_then(Value::as_array)
      .is_some_and(|terms| terms.iter().all(glossary_entry_shape_ok))
    && flow
      .get("samples")
      .and_then(Value::as_array)
      .is_some_and(|samples| samples.iter().all(flow_sample_shape_ok))
    && flow.get("transcription").is_none_or(Value::is_boolean)
    && flow
      .get("steps")
      .and_then(Value::as_array)
      .is_some_and(|steps| steps.iter().all(flow_step_shape_ok))
}

/// フローの中身の id（形も確かめる）。
fn flow_id_of(flow: &Value) -> Result<String> {
  let id = flow
    .get("id")
    .and_then(Value::as_str)
    .filter(|_| flow_shape_ok(flow))
    .ok_or_else(|| StoreError::new("store_bad_json", "工程の形式が正しくありません。"))?;
  validate_flow_id(id)?;
  Ok(id.to_string())
}

/// index.json の並びと最後に使ったフロー（形の違う値は外す）。
fn index_fields(index: &Value) -> (Vec<String>, Option<String>) {
  let order = index
    .get("order")
    .and_then(Value::as_array)
    .map(|ids| {
      ids
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| validate_flow_id(id).is_ok())
        .map(str::to_string)
        .collect()
    })
    .unwrap_or_default();
  let last_used = index
    .get("lastUsed")
    .and_then(Value::as_str)
    .filter(|id| validate_flow_id(id).is_ok())
    .map(str::to_string);
  (order, last_used)
}

/// お手本の文書の id（フローの samples の並び。形の違う id は外す）。
fn sample_ids(flow: &Value) -> Vec<String> {
  flow
    .get("samples")
    .and_then(Value::as_array)
    .map(|samples| {
      samples
        .iter()
        .filter_map(|sample| sample.get("id").and_then(Value::as_str))
        .filter(|id| validate_id(id).is_ok())
        .map(str::to_string)
        .collect()
    })
    .unwrap_or_default()
}

impl Store {
  fn flow_file(&self, flow_id: &str) -> Result<PathBuf> {
    validate_flow_id(flow_id)?;
    self.path(&["flows", &format!("{flow_id}.json")])
  }

  fn flow_index_file(&self) -> Result<PathBuf> {
    self.path(&["flows", "index.json"])
  }

  fn legacy_flow_file(&self) -> Result<PathBuf> {
    self.path(&["flows", "active.json"])
  }

  /// flows/<id>.json（名前が id の形で、中身の id が同じ・Flow の形のファイルだけ。読めないファイル・リンクは飛ばす）。
  fn flow_files(&self) -> Result<BTreeMap<String, Value>> {
    let dir = self.path(&["flows"])?;
    let mut flows = BTreeMap::new();
    for entry in Self::plain_entries(&dir) {
      let name = entry.file_name().to_string_lossy().into_owned();
      let Some(id) = name.strip_suffix(".json") else {
        continue;
      };
      if validate_flow_id(id).is_err() || !entry.file_type().is_ok_and(|kind| kind.is_file()) {
        continue;
      }
      let Ok(Some(flow)) = read_json(&entry.path()) else {
        continue;
      };
      if flow.get("id").and_then(Value::as_str) == Some(id) && flow_shape_ok(&flow) {
        flows.insert(id.to_string(), flow);
      }
    }
    Ok(flows)
  }

  /// P4 より前の flows/active.json（読めない・id が正しくなければ None。ファイルはそのまま）。
  fn legacy_flow(&self) -> Result<Option<(String, Value)>> {
    match read_json(&self.legacy_flow_file()?) {
      Ok(Some(flow)) => Ok(flow_id_of(&flow).ok().map(|id| (id, flow))),
      Ok(None) => Ok(None),
      Err(error) if error.code == "store_bad_json" => Ok(None),
      Err(error) => Err(error),
    }
  }

  /// 今のフローの状態（index があればその並び、無ければ active.json を 1 本目として）。
  fn flow_state(&self) -> Result<FlowState> {
    let mut flows = self.flow_files()?;
    let index = match read_json(&self.flow_index_file()?) {
      Ok(index) => index,
      // 読めない index は空の並びと読む（ファイルは後ろに id の順で足す。次の書き込みで書き直す）
      Err(error) if error.code == "store_bad_json" => Some(json!({})),
      Err(error) => return Err(error),
    };
    let (listed, last_used, legacy) = match index {
      Some(index) => {
        let (order, last_used) = index_fields(&index);
        (order, last_used, None)
      }
      None => match self.legacy_flow()? {
        Some((id, flow)) => {
          flows.insert(id.clone(), flow);
          (vec![id.clone()], Some(id.clone()), Some(id))
        }
        None => (vec![], None, None),
      },
    };
    let mut order: Vec<String> = Vec::new();
    for id in listed.into_iter().chain(flows.keys().cloned()) {
      if flows.contains_key(&id) && !order.contains(&id) {
        order.push(id);
      }
    }
    let last_used = last_used.filter(|id| order.contains(id));
    Ok(FlowState {
      flows,
      order,
      last_used,
      legacy,
    })
  }

  fn write_flow_index(&self, state: &FlowState) -> Result<()> {
    write_json(
      &self.flow_index_file()?,
      &json!({ "version": 1, "order": state.order, "lastUsed": state.last_used }),
    )
  }

  /// 書き込みの前に active.json を移す（WRITE_LOCK の中で）。flows/<id>.json と index.json を書いてから active.json を消す。
  fn migrate_legacy_flow(&self, state: &mut FlowState) -> Result<()> {
    let Some(id) = state.legacy.take() else {
      return Ok(());
    };
    let flow = state.flows.get(&id).ok_or_else(no_flow)?;
    write_json_as(&self.flow_file(&id)?, flow, SinkKind::System)?;
    self.write_flow_index(state)?;
    // 消せなくても index があるので、もう読まれない（残るだけ）
    let legacy = self.legacy_flow_file()?;
    let _ = fs::remove_file(&legacy);
    notify_changed(&[legacy]);
    Ok(())
  }

  /// フローの一覧（並び・最後に使ったフロー）。
  pub fn list_flows(&self) -> Result<FlowList> {
    let state = self.flow_state()?;
    let flows = state
      .order
      .iter()
      .filter_map(|id| state.flows.get(id).cloned())
      .collect();
    Ok(FlowList {
      flows,
      order: state.order,
      last_used: state.last_used,
    })
  }

  /// フローを保存する（flows/<id>.json）。並びに無ければ末尾に足す（最後に使ったフローがまだ無ければ、これにする）。
  pub fn save_flow(&self, flow: &Value) -> Result<()> {
    let id = flow_id_of(flow)?;
    let _guard = WRITE_LOCK.lock();
    let mut state = self.flow_state()?;
    let file = self.flow_file(&id)?;
    self.migrate_legacy_flow(&mut state)?;
    write_json(&file, flow)?;
    if !state.order.contains(&id) {
      if state.last_used.is_none() {
        state.last_used = Some(id.clone());
      }
      state.order.push(id);
    }
    self.write_flow_index(&state)
  }

  /// フローを複製する（画面が作った写し〔新しい id・名前・revision 1〕を書き、お手本の本文を新しい id のフォルダへ写し、
  /// 並びの元の直後に入れる）。同じ id のフロー・ファイルがあれば上書きせずに断る。
  pub fn duplicate_flow(&self, source_id: &str, flow: &Value) -> Result<()> {
    validate_flow_id(source_id)?;
    let id = flow_id_of(flow)?;
    let _guard = WRITE_LOCK.lock();
    let mut state = self.flow_state()?;
    if !state.flows.contains_key(source_id) {
      return Err(no_flow());
    }
    let file = self.flow_file(&id)?;
    if state.flows.contains_key(&id) || fs::symlink_metadata(&file).is_ok() {
      return Err(StoreError::new(
        "store_bad_id",
        "工程を複製できませんでした。もう一度お試しください。",
      ));
    }
    self.migrate_legacy_flow(&mut state)?;
    self.copy_samples(source_id, &id, flow)?;
    if let Err(error) = write_json(&file, flow) {
      if let Ok(samples) = self.path(&["flows", "samples", &id]) {
        Self::remove_path(&samples);
        notify_changed(&[samples]);
      }
      return Err(error);
    }
    let at = state
      .order
      .iter()
      .position(|other| other == source_id)
      .map_or(state.order.len(), |index| index + 1);
    state.order.insert(at, id);
    self.write_flow_index(&state)
  }

  /// 写しの samples にあるお手本の本文（flows/samples/<from>/<sampleId>.txt）を flows/samples/<to>/ へ写す。元に無い本文は
  /// 飛ばす（元と同じく、読むときに「本文が見つかりません」と出る）。途中で失敗したら、写した分を消して断る。
  fn copy_samples(&self, from: &str, to: &str, flow: &Value) -> Result<()> {
    let target = self.path(&["flows", "samples", to])?;
    let result = sample_ids(flow)
      .iter()
      .try_for_each(|sample_id| match fs::read(self.sample_path(from, sample_id)?) {
        Ok(text) => write_atomic(&self.sample_path(to, sample_id)?, &text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(StoreError::io(error)),
      });
    if result.is_err() {
      Self::remove_path(&target);
      notify_changed(&[target]);
    }
    result
  }

  /// フローを消す（flows/<id>.json を消してから並びから外し、お手本の本文のフォルダを消す）。最後に使ったフローなら並びの
  /// 先頭へ（無ければ null）。一覧はファイルから読むので、ファイルを消せなければ何も変えずに断る。使っている録音は自分の
  /// snapshot で実行できる（録音には触れない）。
  pub fn delete_flow(&self, flow_id: &str) -> Result<()> {
    validate_flow_id(flow_id)?;
    let _guard = WRITE_LOCK.lock();
    let mut state = self.flow_state()?;
    if !state.flows.contains_key(flow_id) {
      return Err(no_flow());
    }
    // 消す場所（途中にリンクがあれば、何も変えずに断る）
    let file = self.flow_file(flow_id)?;
    let samples = self.path(&["flows", "samples", flow_id])?;
    self.migrate_legacy_flow(&mut state)?;
    match fs::remove_file(&file) {
      Ok(()) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => return Err(StoreError::io(error)),
    }
    notify_changed(&[file]);
    state.order.retain(|id| id != flow_id);
    if state.last_used.as_deref() == Some(flow_id) {
      state.last_used = state.order.first().cloned();
    }
    self.write_flow_index(&state)?;
    // お手本の本文は、消せなくても残るだけ（同じ id は使い直さない）
    Self::remove_path(&samples);
    notify_changed(&[samples]);
    Ok(())
  }

  /// 最後に使ったフロー（新しい録音のページの既定）を変える。
  pub fn set_last_used_flow(&self, flow_id: &str) -> Result<()> {
    validate_flow_id(flow_id)?;
    let _guard = WRITE_LOCK.lock();
    let mut state = self.flow_state()?;
    if !state.flows.contains_key(flow_id) {
      return Err(no_flow());
    }
    self.migrate_legacy_flow(&mut state)?;
    state.last_used = Some(flow_id.to_string());
    self.write_flow_index(&state)
  }

  /// そのフローから作った録音の数（すべての案件の root と recordings/* のうち、flowSnapshot.id が同じもの）。削除の確かめに出す。
  pub fn flow_usage(&self, flow_id: &str) -> Result<usize> {
    validate_flow_id(flow_id)?;
    let made_from = |value: &Value| value.pointer("/flowSnapshot/id").and_then(Value::as_str) == Some(flow_id);
    let mut count = 0;
    for entry in self.list_projects()? {
      if made_from(&entry.project) {
        count += 1;
      }
      for recording_id in self.recording_ids(&entry.id) {
        let Ok(file) = self.recording_file(&entry.id, &recording_id, &["recording.json"]) else {
          continue;
        };
        if read_json(&file)
          .ok()
          .flatten()
          .is_some_and(|recording| made_from(&recording))
        {
          count += 1;
        }
      }
    }
    for recording_id in self.recording_ids_at(None) {
      let Ok(file) = self.recording_file_at(None, &recording_id, &["recording.json"]) else {
        continue;
      };
      if read_json(&file)
        .ok()
        .flatten()
        .is_some_and(|recording| made_from(&recording))
      {
        count += 1;
      }
    }
    Ok(count)
  }
}

#[cfg(test)]
#[path = "store_flows_tests.rs"]
mod tests;
