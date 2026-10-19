//! 保存の口（C3 #18595）。store.rs の子 module。cloud.rs が入れる口（`SaveSink`）に、案件・flows・about.json の下の書き込みを
//! 1 つの保存単位（group）として渡す。口が無い・受け取らない path は今までどおり一時ファイル → rename で書き、変更として知らせる。
//! runs の行の originDeviceId（この Mac の deviceId）もここで足す。

use super::{write_plain, Result, StoreError, WRITE_LOCK};
use serde_json::Value;
use std::cell::RefCell;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// 保存の口へ渡す書き込み（store の root からの絶対 path。root は canonical）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SinkWrite {
  Put(PathBuf, Vec<u8>),
  Delete(PathBuf),
}

impl SinkWrite {
  pub fn path(&self) -> &Path {
    match self {
      Self::Put(path, _) | Self::Delete(path) => path,
    }
  }
}

/// 保存の種類（journal に残す。本文の編集・版・実行の記録・アプリの移し替え）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkKind {
  Edit,
  Version,
  Run,
  System,
}

pub trait SaveSink: Send + Sync {
  /// どの path も同期の対象の下にあり journal を通して保存したら Some（`Ok(Some(世代))` はこの Mac の保存の世代）。
  /// None なら呼び出し側が今までどおり書く。
  fn save(&self, writes: &[SinkWrite], kind: SinkKind) -> Option<std::result::Result<Option<u64>, StoreError>>;
  /// 保存の口を通さずに変えた path（削除・音声の写し・画像）を知らせる。
  fn changed(&self, paths: &[PathBuf]);
}

static SAVE_SINK: RwLock<Option<Arc<dyn SaveSink>>> = RwLock::new(None);
static DEVICE_ID: RwLock<Option<String>> = RwLock::new(None);

thread_local! {
  /// 長い async 処理が開始時に捕捉した namespace の口。同期的な Store 操作の間だけ積み、終了・panic 時は必ず外す。
  static CAPTURED_SAVE_SINKS: RefCell<Vec<Arc<dyn SaveSink>>> = RefCell::new(Vec::new());
}

struct CapturedSinkGuard;

impl Drop for CapturedSinkGuard {
  fn drop(&mut self) {
    CAPTURED_SAVE_SINKS.with(|sinks| {
      sinks.borrow_mut().pop();
    });
  }
}

/// 保存の口を入れる・外す（cloud.rs が起動・保存先の切り替えで入れる。入っていなければ今までどおり書く）。
pub fn set_save_sink(sink: Option<Arc<dyn SaveSink>>) {
  *SAVE_SINK.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = sink;
}

/// runs の行に書く originDeviceId（この Mac の deviceId。無ければ書かない）。
pub fn set_device_id(id: Option<String>) {
  *DEVICE_ID.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = id;
}

pub(super) fn save_sink() -> Option<Arc<dyn SaveSink>> {
  if let Some(sink) = CAPTURED_SAVE_SINKS.with(|sinks| sinks.borrow().last().cloned()) {
    return Some(sink);
  }
  SAVE_SINK
    .read()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .clone()
}

/// 捕捉済みの Store/namespace を使う同期処理。thread-local は `.await` をまたがず、入れ子も stack で元へ戻す。
pub(crate) fn with_captured_save_sink<T>(sink: Arc<dyn SaveSink>, work: impl FnOnce() -> T) -> T {
  CAPTURED_SAVE_SINKS.with(|sinks| sinks.borrow_mut().push(sink));
  let _guard = CapturedSinkGuard;
  work()
}

pub(super) fn device_id() -> Option<String> {
  DEVICE_ID
    .read()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .clone()
}

/// 保存の口を通さずに変えた path を知らせる（口が無ければ何もしない）。
pub(super) fn notify_changed(paths: &[PathBuf]) {
  if paths.is_empty() {
    return;
  }
  if let Some(sink) = save_sink() {
    sink.changed(paths);
  }
}

/// 1 つの保存単位を書く。口が受け取れば 1 つの group として journal へ、受け取らなければ順に書いて知らせる。
pub(super) fn save_writes(writes: Vec<SinkWrite>, kind: SinkKind) -> Result<Option<u64>> {
  if writes.is_empty() {
    return Ok(None);
  }
  if let Some(sink) = save_sink() {
    if let Some(result) = sink.save(&writes, kind) {
      return result;
    }
  }
  for write in &writes {
    match write {
      SinkWrite::Put(path, bytes) => write_plain(path, bytes)?,
      SinkWrite::Delete(path) => remove_plain(path)?,
    }
  }
  let paths: Vec<PathBuf> = writes.iter().map(|write| write.path().to_path_buf()).collect();
  notify_changed(&paths);
  Ok(None)
}

/// 1 つのファイルの保存（口があれば journal を通し、保存の世代を返す）。
pub(super) fn write_atomic_as(path: &Path, contents: &[u8], kind: SinkKind) -> Result<Option<u64>> {
  save_writes(vec![SinkWrite::Put(path.to_path_buf(), contents.to_vec())], kind)
}

pub(super) fn remove_plain(path: &Path) -> Result<()> {
  match fs::remove_file(path) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(StoreError::io(error)),
  }
}

pub(super) fn json_bytes(value: &Value) -> Result<Vec<u8>> {
  let mut text =
    serde_json::to_string_pretty(value).map_err(|_| StoreError::new("store_io", "JSON にできませんでした。"))?;
  text.push('\n');
  Ok(text.into_bytes())
}

pub(super) fn write_json_as(path: &Path, value: &Value, kind: SinkKind) -> Result<()> {
  write_atomic_as(path, &json_bytes(value)?, kind).map(|_| ())
}

/// 書き込みを 1 本にする lock の中で走らせる（cloud.rs の競合の解決が runs.jsonl と版を書くとき）。
pub(crate) fn with_write_lock<T>(work: impl FnOnce() -> T) -> T {
  let _guard = WRITE_LOCK.lock();
  work()
}

/// 今の時刻（runs の行の `at` と同じ ISO 8601・ミリ秒・UTC）。
pub(crate) fn now_iso() -> String {
  chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// runs の行に originDeviceId が無ければ、この Mac の deviceId を足す。
pub(super) fn with_origin(record: &mut Value) {
  if let (Value::Object(map), Some(device)) = (record, device_id()) {
    map.entry("originDeviceId").or_insert(Value::from(device));
  }
}

/// runs.jsonl の今の中身に行を足した全体（末尾に改行が無ければ足してから）。
pub(super) fn appended_lines(path: &Path, lines: &[Value]) -> Result<Vec<u8>> {
  let mut bytes = match fs::read(path) {
    Ok(bytes) => bytes,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
    Err(error) => return Err(StoreError::io(error)),
  };
  if !bytes.is_empty() && !bytes.ends_with(b"\n") {
    bytes.push(b'\n');
  }
  for line in lines {
    let text = serde_json::to_string(line).map_err(|_| StoreError::new("store_io", "JSON にできませんでした。"))?;
    bytes.extend_from_slice(text.as_bytes());
    bytes.push(b'\n');
  }
  Ok(bytes)
}

/// runs.jsonl へ 1 行を追記する（保存の口を通さない）。
pub(super) fn append_line_plain(path: &Path, record: &Value) -> Result<()> {
  let mut line = serde_json::to_string(record).map_err(|_| StoreError::new("store_io", "JSON にできませんでした。"))?;
  line.push('\n');
  let mut file = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(path)
    .map_err(StoreError::io)?;
  file.write_all(line.as_bytes()).map_err(StoreError::io)
}
