//! 本人 Mac 実行（R6 #18739 slice 1）の Native の境界。画面の controller（apps/docs/src/lib/personal-execution.ts）が使う
//! 安全な primitive だけを持つ（ports の実装・App からの呼び出しは slice 2）。
//!
//! - operation: 開始時に Cloud の Store・namespace を捕捉し（`CapturedOperation`）、実行のロック（捕捉した Store の `.run.lock`）と
//!   NIHO クラウドの lease を取る。画面へは不透明な handle（`pop_<32hex>`）と本人・保存先の識別だけを返す。開いている間は保存先の
//!   変更・結び直し・退避が `store_busy` で止まる（OperationLease）。ログイン済み（Mode Active）が前提。NIHO に届かないときに
//!   始められるのは、端末内の文字起こし（this-mac）だけ。
//! - guard: 送信前・保存前・CAS 前に、本人・保存先・lease・取消と、受け入れている固定入力（snapshot）の hash を返す。
//! - intent: 同じ実行を二度受け付けないための記録と、外部実行の直前の dispatch marker（app data の本人 namespace の下。同期しない）。
//! - material: 捕捉した Store から固定入力の素材を読む（音声は Rust で SHA-256 を計算し、JS へは渡さない）。
//! - candidate / publish / record: 結果を不変の版として残し、現在本文の照合が通ったときだけ 1 つの保存単位で公開する。
//! - 送信直前の guard（`send_guard`）: `run_turn`・`transcribe`・`prepare_audio`・`transcribe_audio_part` に operation を渡したとき、
//!   実際の送信の直前に本人・保存先・取消・lease・音声を確かめ直す（lib.rs の差し込み位置のコメント）。
//!
//! 秘密・指示文・本文はログに出さない（このモジュールは何も書き出さない）。

use crate::cloud::{lease_held_error, CapturedOperation, Cloud, OperationIdentity, OwnedLease};
use crate::store::{self, CandidateWrite, PersonalPublish, PublishOutcome, StoreError};
use crate::{AppState, CommandError, CommandResult, OUTSIDE_LOCK_KEY};
use niho_desktop_vault::{atomic_write, is_version_id, validate_relative_path, DOCS_ROOT_PROJECT_ID};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::State;

/// Gemini の文字起こしのモデルと思考量（apps/docs/src/lib/runner.ts の GEMINI_TRANSCRIPTION_MODEL・EFFORT と同じ。共有 fixture
/// `test/fixtures/personal-snapshot-derivation.json` の `transcriptionModels` で両方を確かめる）。
pub(crate) const GEMINI_TRANSCRIPTION_MODEL: &str = "gemini-3.8-flash";
pub(crate) const GEMINI_TRANSCRIPTION_EFFORT: &str = "low";
/// この Mac の音声認識（niho-speech）。
pub(crate) const THIS_MAC_TRANSCRIPTION_MODEL: &str = "niho-speech";
/// 実行の記録（intent）の置き場（app data の直下の本人ごと。保存先の変更で `vault/<accountKey>/` ごと退避されても残す）。
const INTENTS_DIR: &str = "personal-runs";
const MAX_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
const MAX_CANDIDATE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PRIVATE_BYTES: usize = 8 * 1024 * 1024;
const MAX_AGGREGATE_BYTES: usize = 1024 * 1024;
const MAX_RECORD_BYTES: usize = 256 * 1024;
/// JS の Number で正確に表せる整数の上限（canonical の数値表記を JS と合わせるため、超える整数は断る）。
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const ID_ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
/// 実行の状態（personal-execution.ts の PersonalRunState）。
const RUN_STATES: [&str; 9] = [
  "running",
  "submitted",
  "waiting_auth",
  "completed",
  "transcription_complete",
  "input_changed",
  "canceled",
  "failed",
  "result_unknown",
];
/// 終端の状態（外部実行の結果が分かった。dispatch marker を閉じる）。`waiting_auth`・`result_unknown` は閉じない。
const TERMINAL_STATES: [&str; 6] = [
  "submitted",
  "completed",
  "transcription_complete",
  "input_changed",
  "canceled",
  "failed",
];
const PRIVATE_KINDS: [&str; 3] = ["checkpoint", "partial_output", "run_record"];

// ---------------------------------------------------------------------------
// 失敗（画面の文言は利用者の言葉。内部の状態や英語の識別子は見せない）

fn failure(code: &str, message: &str) -> CommandError {
  CommandError::new(code, message)
}

fn bad_request() -> CommandError {
  failure("personal_bad_request", "実行の依頼の形が正しくありません。")
}

fn not_signed_in() -> CommandError {
  failure(
    "personal_not_signed_in",
    "NIHO アカウントでログインしてから実行してください。",
  )
}

fn lease_unavailable() -> CommandError {
  failure(
    "personal_lease_unavailable",
    "NIHO に接続できないため、外部の AI を使う工程は始められません。端末内の文字起こしだけ始められます。",
  )
}

fn store_busy() -> CommandError {
  failure(
    "store_busy",
    "実行中の録音があります。終わってから、もう一度実行してください。",
  )
}

fn operation_missing() -> CommandError {
  failure(
    "personal_operation_missing",
    "実行の準備が見つかりません。もう一度実行してください。",
  )
}

pub(crate) fn guard_failed() -> CommandError {
  failure(
    "personal_guard_failed",
    "実行を始めたときの状態から変わったため、送信しませんでした。",
  )
}

fn snapshot_invalid() -> CommandError {
  failure(
    "personal_snapshot_invalid",
    "固定した入力の形が正しくありません。もう一度実行してください。",
  )
}

fn snapshot_mismatch() -> CommandError {
  failure(
    "personal_snapshot_mismatch",
    "固定した入力が、この実行の録音・アカウント・保存先と一致しません。",
  )
}

fn intent_mismatch() -> CommandError {
  failure("personal_intent_mismatch", "実行の記録が、この実行と一致しません。")
}

fn intent_not_reserved() -> CommandError {
  failure("personal_intent_not_reserved", "実行の受付が済んでいません。")
}

fn intent_closed() -> CommandError {
  failure("personal_intent_closed", "この実行の記録はすでに終わっています。")
}

fn intent_io() -> CommandError {
  failure("personal_intent_io", "実行の記録をこの Mac に保存できませんでした。")
}

fn audio_missing() -> CommandError {
  failure(
    "personal_audio_missing",
    "音声がまだこの Mac にありません。同期が終わってから実行してください。",
  )
}

fn audio_changed() -> CommandError {
  failure(
    "personal_audio_changed",
    "音声の内容が変わりました。もう一度実行してください。",
  )
}

fn root_changed() -> CommandError {
  failure("personal_root_changed", "保存先が変わったため、保存しませんでした。")
}

fn candidate_mismatch() -> CommandError {
  failure(
    "personal_candidate_mismatch",
    "AI の結果が、実行を始めたときの工程・内容と一致しません。",
  )
}

fn path_not_allowed() -> CommandError {
  failure("personal_path_not_allowed", "録音の版の場所が正しくありません。")
}

fn expected_mismatch() -> CommandError {
  failure(
    "personal_expected_mismatch",
    "本文の照合値が、受け付けた固定入力と一致しません。",
  )
}

fn candidate_missing() -> CommandError {
  failure("personal_candidate_missing", "保存した候補が見つかりません。")
}

// ---------------------------------------------------------------------------
// 経路・識別

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouteKind {
  LocalFull,
  LocalTranscriptionOnly,
  GenerationOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Executor {
  ThisPc,
  NihoApi,
}

/// 文字起こしのエンジン（方式を含む）。Gemini はサブスクリプション（Antigravity CLI）と API キー（Gemini API）を分ける
/// （owner 2026-10-19。文字起こしのエンジンはモデルの方式に依らない）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Transcription {
  ThisMac,
  /// サブスクリプションの Gemini（固定値に connection を持たない。以前と同じ）。
  Gemini,
  /// API キーの Gemini（固定値に `connection: "apiKey"` を持つ）。
  GeminiApi,
  Deepgram,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Route {
  kind: RouteKind,
  executor: Option<Executor>,
}

impl Route {
  fn local(&self) -> bool {
    self.kind != RouteKind::GenerationOnly
  }

  /// snapshot の `route`（personal-execution.ts の PersonalRoute と同じ形）。
  fn to_json(self) -> Value {
    match (self.kind, self.executor) {
      (RouteKind::LocalFull, _) => json!({ "kind": "local_full" }),
      (RouteKind::LocalTranscriptionOnly, _) => json!({ "kind": "local_transcription_only" }),
      (RouteKind::GenerationOnly, Some(Executor::NihoApi)) => {
        json!({ "kind": "generation_only", "executor": "niho_api" })
      }
      (RouteKind::GenerationOnly, _) => json!({ "kind": "generation_only", "executor": "this_pc" }),
    }
  }
}

impl Transcription {
  /// snapshot の `transcriptionModel`（provider・model は録音の flowSnapshot ではなく、方式ごとに決まった値）。
  fn model_json(self) -> Value {
    match self {
      Transcription::ThisMac => json!({ "provider": "this-mac", "model": THIS_MAC_TRANSCRIPTION_MODEL }),
      Transcription::Gemini => json!({
        "provider": "gemini",
        "model": GEMINI_TRANSCRIPTION_MODEL,
        "effort": GEMINI_TRANSCRIPTION_EFFORT,
      }),
      Transcription::GeminiApi => json!({
        "provider": "gemini",
        "model": GEMINI_TRANSCRIPTION_MODEL,
        "effort": GEMINI_TRANSCRIPTION_EFFORT,
        "connection": "apiKey",
      }),
      Transcription::Deepgram => json!({ "provider": "deepgram", "model": "nova-3", "connection": "apiKey" }),
    }
  }
}

/// 画面から受け取る開始の依頼。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequestWire {
  project_id: Option<String>,
  recording_page_id: String,
  recording_id: String,
  intent_id: String,
  run_id: String,
  route: RouteWire,
  transcription_provider: Option<String>,
  /// 文字起こしのエンジンの方式（Gemini の `subscription`／`apiKey`。Deepgram は `apiKey`、この Mac は無し）。
  #[serde(default)]
  transcription_connection: Option<String>,
  output_target: Option<Value>,
}

#[derive(Deserialize)]
struct RouteWire {
  kind: String,
  executor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
  handle: String,
  owner_account_id: String,
  root_id: String,
  lease_id: String,
  cloud_lease: bool,
  context_generation: u64,
  device_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseResult {
  released: bool,
  lease_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardResult {
  owner_account_id: String,
  root_id: String,
  snapshot_sha256: String,
  lease_id: String,
  cancelled: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ReserveResult {
  New,
  Resumed,
  Existing { state: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
  verified: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  reason: Option<String>,
}

// ---------------------------------------------------------------------------
// operation

/// 音声の写しの識別（material で計算し、送信の直前と verify で照らす）。
#[derive(Debug, Clone)]
struct AudioIdentity {
  relative: String,
  path: PathBuf,
  sha256: String,
  bytes: u64,
  dev: u64,
  ino: u64,
  mtime: i64,
  mtime_nsec: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateKind {
  Source,
  Artifact,
}

/// この operation が保存した不変の候補。
#[derive(Debug, Clone)]
struct StoredCandidate {
  step_id: String,
  artifact_id: String,
  kind: CandidateKind,
  version_id: String,
  path: String,
  provider: String,
  model: Value,
  /// None は「報告なし（キーが無い）」、Some(Null) は「null と報告」。
  reported_model: Option<Value>,
  sha256: String,
  bytes: u64,
}

/// この operation が公開した版（2.4 の派生に使う。ほかの operation の版では派生できない）。
#[derive(Debug, Clone)]
struct Receipt {
  step_id: String,
  kind: CandidateKind,
  /// PersonalVersionRef（versionId・path・sha256・bytes・originRunId・origin）。
  version: Value,
}

#[derive(Default)]
struct OperationState {
  turns: HashSet<String>,
  jobs: HashSet<String>,
  audio: Vec<AudioIdentity>,
  /// 今受け入れている固定入力（snapshotSha256 つき）。
  head: Option<Map<String, Value>>,
  reserved: bool,
  receipts: Vec<Receipt>,
  candidates: HashMap<String, StoredCandidate>,
  /// 外部実行の直前の dispatch marker を書いて、まだ結果が分かっていない。
  dispatch_open: bool,
}

pub(crate) struct PersonalOperation {
  captured: CapturedOperation,
  identity: OperationIdentity,
  project_id: Option<String>,
  lock_key: String,
  lease_project: String,
  recording_page_id: String,
  recording_id: String,
  intent_id: String,
  run_id: String,
  route: Route,
  transcription: Option<Transcription>,
  output_target: Option<Value>,
  lease_id: String,
  cloud_lease: bool,
  cancelled: AtomicBool,
  closed: AtomicBool,
  /// 録音への書き込み（候補・公開・記録）の途中の数。close はこれが 0 になるのを待ってからロック・lease を返す。
  /// closed はこの lock の中で立てるので、立てた後に始まる書き込みは無い。
  writes: Mutex<usize>,
  state: Mutex<OperationState>,
}

/// 録音への書き込みの途中の印（drop で外す）。
struct WriteGuard<'a> {
  op: &'a PersonalOperation,
}

impl Drop for WriteGuard<'_> {
  fn drop(&mut self) {
    let mut writes = lock(&self.op.writes);
    *writes = writes.saturating_sub(1);
  }
}

/// 書き込みを始める（閉じた operation では断る）。
fn begin_write(op: &PersonalOperation) -> CommandResult<WriteGuard<'_>> {
  let mut writes = lock(&op.writes);
  if op.is_closed() {
    return Err(operation_missing());
  }
  *writes += 1;
  Ok(WriteGuard { op })
}

/// 閉じた印を書き込みの lock の中で立て、途中の書き込みが終わるまで待つ。
async fn close_writes(op: &PersonalOperation) {
  {
    let _writes = lock(&op.writes);
    op.closed.store(true, Ordering::SeqCst);
  }
  while *lock(&op.writes) > 0 {
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
  }
}

pub(crate) type Operations = Mutex<HashMap<String, Arc<PersonalOperation>>>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl PersonalOperation {
  fn st(&self) -> MutexGuard<'_, OperationState> {
    lock(&self.state)
  }

  fn is_cancelled(&self) -> bool {
    self.cancelled.load(Ordering::SeqCst)
  }

  fn is_closed(&self) -> bool {
    self.closed.load(Ordering::SeqCst)
  }

  /// 取り消された・閉じた（送信を始めたばかりのものも止める）。
  pub(crate) fn stop_requested(&self) -> bool {
    self.is_cancelled() || self.is_closed()
  }

  fn account_key(&self) -> &str {
    self.identity.account_key.as_deref().unwrap_or_default()
  }

  /// 送信の command に渡された録音（project・ページ id か録音 id）が、この operation の録音か。
  pub(crate) fn matches_recording(&self, project_id: Option<&str>, recording_id: &str) -> bool {
    project_id == self.project_id.as_deref()
      && (recording_id == self.recording_id || recording_id == self.recording_page_id)
  }

  /// material で照合した音声の写しの実体のパス（送信は画面のパスでも今の Root でもなく、ここから読む）。
  pub(crate) fn audio_paths(&self) -> CommandResult<Vec<PathBuf>> {
    let state = self.st();
    if state.audio.is_empty() {
      return Err(guard_failed());
    }
    Ok(state.audio.iter().map(|audio| audio.path.clone()).collect())
  }
}

fn random_token(len: usize) -> CommandResult<String> {
  let bytes =
    crate::process::random_bytes::<32>().map_err(|_| failure("personal_io", "実行を準備できませんでした。"))?;
  Ok(
    bytes
      .iter()
      .take(len.min(32))
      .map(|byte| ID_ALPHABET[(*byte as usize) % ID_ALPHABET.len()] as char)
      .collect(),
  )
}

fn new_handle() -> CommandResult<String> {
  let bytes =
    crate::process::random_bytes::<16>().map_err(|_| failure("personal_io", "実行を準備できませんでした。"))?;
  Ok(format!("pop_{}", crate::process::hex(&bytes)))
}

/// 開いている operation（閉じたもの・無いものは `personal_operation_missing`）。
pub(crate) fn operation_for(state: &AppState, handle: &str) -> CommandResult<Arc<PersonalOperation>> {
  let op = lock(&state.personal_ops)
    .get(handle)
    .cloned()
    .ok_or_else(operation_missing)?;
  if op.is_closed() {
    return Err(operation_missing());
  }
  Ok(op)
}

/// その job id を持つ operation（あれば handle）。operation に束縛した job は、ほかの operation・operation なしでは使えない。
pub(crate) fn job_owner(state: &AppState, job_id: &str) -> Option<String> {
  lock(&state.personal_ops)
    .iter()
    .find(|(_, op)| op.st().jobs.contains(job_id))
    .map(|(handle, _)| handle.clone())
}

/// turn・job をこの operation に束縛する（取消で止まる。別の operation に束縛済みなら断る）。
pub(crate) fn bind_turn(state: &AppState, handle: &str, op: &PersonalOperation, turn_id: &str) -> CommandResult<()> {
  let taken = lock(&state.personal_ops)
    .iter()
    .any(|(other, op)| other != handle && op.st().turns.contains(turn_id));
  if taken {
    return Err(guard_failed());
  }
  op.st().turns.insert(turn_id.to_string());
  Ok(())
}

pub(crate) fn bind_job(state: &AppState, handle: &str, op: &PersonalOperation, job_id: &str) -> CommandResult<()> {
  if job_owner(state, job_id).is_some_and(|owner| owner != handle) {
    return Err(guard_failed());
  }
  op.st().jobs.insert(job_id.to_string());
  Ok(())
}

pub(crate) fn unbind_job(op: &PersonalOperation, job_id: &str) {
  op.st().jobs.remove(job_id);
}

pub(crate) fn owns_job(op: &PersonalOperation, job_id: &str) -> bool {
  op.st().jobs.contains(job_id)
}

/// 送信の種類（送信直前の guard が確かめる内容が違う）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SendKind {
  /// `run_turn`（工程の外部 AI）
  Turn,
  /// `prepare_audio`（Gemini の文字起こしの準備。端末内の変換）
  AudioPrepare,
  /// `transcribe_audio_part`（Gemini の文字起こし。外部 AI）
  AudioPart,
  /// `transcribe`（この Mac の音声認識の sidecar）
  ThisMacTranscribe,
  /// `transcribe_deepgram`（API キー方式の文字起こし）
  Deepgram,
  /// `personal_niho_submit`（確定した原文から NIHO API への後続だけの受付。personal_niho.rs）
  NihoApi,
}

/// 送信直前の Native guard。operation が開いていて取消されておらず、本人・保存先が捕捉時のまま（`ensure_current`）、経路と
/// 文字起こしの方式がその送信を許し、lease を持つ operation はその lease がまだ Cloud にあり、音声の写しが material のときと同じ
/// 実体で、外部 AI への送信（Turn・AudioPart）は dispatch marker を書いた後であること。どれかが違えば `personal_guard_failed`
/// （送信ゼロ）。呼び出し側は、この関数から送信の開始までの間に `.await` を挟まない（lib.rs の差し込み位置）。
/// awaitを挟めない実送信の直前に再検査する部分。leaseの生存は直前の`send_guard`で確認し、ここではその後に変わり得る
/// owner/root・取消・音声・dispatch markerをもう一度照合する。
pub(crate) fn send_guard_now(op: &PersonalOperation, kind: SendKind) -> CommandResult<()> {
  if op.is_closed() || op.is_cancelled() || op.captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  let allowed = match kind {
    SendKind::Turn => {
      op.cloud_lease
        && (op.route.kind == RouteKind::LocalFull
          || (op.route.kind == RouteKind::GenerationOnly && op.route.executor == Some(Executor::ThisPc)))
    }
    SendKind::AudioPrepare | SendKind::AudioPart => {
      op.cloud_lease
        && op.route.local()
        && matches!(op.transcription, Some(Transcription::Gemini | Transcription::GeminiApi))
    }
    SendKind::Deepgram => op.cloud_lease && op.route.local() && op.transcription == Some(Transcription::Deepgram),
    SendKind::ThisMacTranscribe => op.route.local() && op.transcription == Some(Transcription::ThisMac),
    SendKind::NihoApi => {
      op.cloud_lease && op.route.kind == RouteKind::GenerationOnly && op.route.executor == Some(Executor::NihoApi)
    }
  };
  if !allowed {
    return Err(guard_failed());
  }
  if matches!(
    kind,
    SendKind::Turn | SendKind::AudioPart | SendKind::Deepgram | SendKind::NihoApi
  ) && !op.st().dispatch_open
  {
    return Err(guard_failed());
  }
  if matches!(
    kind,
    SendKind::AudioPrepare | SendKind::AudioPart | SendKind::ThisMacTranscribe | SendKind::Deepgram
  ) {
    let audio = op.st().audio.clone();
    if audio.is_empty() || audio.iter().any(|item| !audio_unchanged(item)) {
      return Err(guard_failed());
    }
  }
  Ok(())
}

pub(crate) async fn send_guard(cloud: &Cloud, op: &PersonalOperation, kind: SendKind) -> CommandResult<()> {
  send_guard_now(op, kind)?;
  if !lease_alive(cloud, op).await {
    return Err(guard_failed());
  }
  // lease の確認（await）の間に取り消し・切り替え・音声変更が入っても送らない。
  send_guard_now(op, kind)
}

/// 時間のかかる準備（区切りの書き出しなど）の前の早い確認（取消・閉じた・本人や保存先の変化）。送信の直前には `send_guard` を通す。
pub(crate) fn precheck(op: &PersonalOperation) -> CommandResult<()> {
  if op.stop_requested() || op.captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  Ok(())
}

async fn lease_alive(cloud: &Cloud, op: &PersonalOperation) -> bool {
  if !op.cloud_lease {
    return true;
  }
  cloud.owned_lease_alive(&op.lease_project, &op.lease_id).await
}

// ---------------------------------------------------------------------------
// open / cancel / close

fn parse_route(wire: &RouteWire) -> CommandResult<Route> {
  let kind = match wire.kind.as_str() {
    "local_full" => RouteKind::LocalFull,
    "local_transcription_only" => RouteKind::LocalTranscriptionOnly,
    "generation_only" => RouteKind::GenerationOnly,
    _ => return Err(bad_request()),
  };
  let executor = match (kind, wire.executor.as_deref()) {
    (RouteKind::GenerationOnly, Some("this_pc")) => Some(Executor::ThisPc),
    (RouteKind::GenerationOnly, Some("niho_api")) => Some(Executor::NihoApi),
    (RouteKind::GenerationOnly, _) => return Err(bad_request()),
    (_, None) => None,
    (_, Some(_)) => return Err(bad_request()),
  };
  Ok(Route { kind, executor })
}

/// 文字起こしのエンジンと方式。Gemini は方式が無ければサブスクリプション、Deepgram は API キーだけ、この Mac は方式を持たない。
fn parse_transcription(
  route: Route,
  value: Option<&str>,
  connection: Option<&str>,
) -> CommandResult<Option<Transcription>> {
  match (route.local(), value, connection) {
    (true, Some("this-mac"), None) => Ok(Some(Transcription::ThisMac)),
    (true, Some("gemini"), None | Some("subscription")) => Ok(Some(Transcription::Gemini)),
    (true, Some("gemini"), Some("apiKey")) => Ok(Some(Transcription::GeminiApi)),
    (true, Some("deepgram"), None | Some("apiKey")) => Ok(Some(Transcription::Deepgram)),
    (false, None, None) => Ok(None),
    _ => Err(bad_request()),
  }
}

/// Gemini の区切りの送信が、固定した文字起こしの方式と同じ提供元か（サブスクリプションは Antigravity CLI、API キーは Gemini API）。
pub(crate) fn gemini_transcription_matches(op: &PersonalOperation, api_key: bool) -> bool {
  op.transcription
    == Some(if api_key {
      Transcription::GeminiApi
    } else {
      Transcription::Gemini
    })
}

fn release_run_lock(state: &AppState, op_store: &store::Store, project_id: Option<&str>, key: &str) -> bool {
  let mut locks = lock(&state.run_locks);
  let released = op_store.release_run_lock_at(project_id).is_ok();
  locks.remove(key);
  released
}

/// 2.1 の開始。捕捉 → ログイン済みの確認 → 録音の照合 → 実行のロック（捕捉した Store）→ lease。途中で失敗したら取ったロックを
/// 捕捉した Store で戻す。
pub(crate) async fn open(state: &AppState, cloud: &Cloud, request: OpenRequestWire) -> CommandResult<OpenResult> {
  let route = parse_route(&request.route)?;
  let transcription = parse_transcription(
    route,
    request.transcription_provider.as_deref(),
    request.transcription_connection.as_deref(),
  )?;
  for id in [
    &request.recording_page_id,
    &request.recording_id,
    &request.intent_id,
    &request.run_id,
  ] {
    crate::safe_id(id)?;
  }
  if let Some(target) = request.output_target.as_ref() {
    let object = target.as_object().ok_or_else(bad_request)?;
    for key in ["stepId", "candidateId", "artifactId"] {
      crate::safe_id(object.get(key).and_then(Value::as_str).ok_or_else(bad_request)?)?;
    }
    if object.get("instruction").is_some_and(|value| !value.is_string())
      || object.get("inputVersions").is_none_or(|value| !value.is_object())
    {
      return Err(bad_request());
    }
  }
  if let Some(project_id) = &request.project_id {
    crate::safe_id(project_id)?;
  }
  let project_id = request.project_id.clone();
  let captured = cloud.capture_operation().await?;
  let identity = captured.identity();
  let owner = captured
    .active_owner()
    .filter(|owner| identity.account_key.as_deref() == Some(owner.as_str()))
    .ok_or_else(not_signed_in)?;
  captured
    .store()
    .personal_recording(project_id.as_deref(), &request.recording_page_id, &request.recording_id)?;
  let lock_key = project_id.clone().unwrap_or_else(|| OUTSIDE_LOCK_KEY.to_string());
  {
    let mut locks = lock(&state.run_locks);
    // スマホから受けた工程をこの Mac で実行している間は始めない（pc_runner.rs。同じ mutex の中で決める）
    crate::pc_runner::refuse_local_run(state)?;
    captured.store().acquire_run_lock_at(project_id.as_deref())?;
    locks.insert(lock_key.clone());
  }
  let lease_project = project_id.clone().unwrap_or_else(|| DOCS_ROOT_PROJECT_ID.to_string());
  let lease_id = match random_token(22) {
    Ok(token) => format!("ls_{token}"),
    Err(error) => {
      release_run_lock(state, captured.store(), project_id.as_deref(), &lock_key);
      return Err(error);
    }
  };
  let refused = |error: CommandError| {
    release_run_lock(state, captured.store(), project_id.as_deref(), &lock_key);
    Err(error)
  };
  let cloud_lease = match cloud.acquire_owned_lease(&captured, &lease_project, &lease_id).await {
    OwnedLease::Acquired => true,
    OwnedLease::HeldElsewhere(held_by) => return refused(lease_held_error(held_by.as_ref())),
    OwnedLease::AlreadyHeldHere => return refused(store_busy()),
    OwnedLease::Unavailable => {
      if route.kind == RouteKind::LocalTranscriptionOnly && transcription == Some(Transcription::ThisMac) {
        false
      } else {
        return refused(lease_unavailable());
      }
    }
  };
  let handle = match new_handle() {
    Ok(handle) => handle,
    Err(error) => {
      if cloud_lease {
        cloud
          .release_owned_lease(&captured, &lease_project, &lease_id, true)
          .await;
      }
      return refused(error);
    }
  };
  let result = OpenResult {
    handle: handle.clone(),
    owner_account_id: owner,
    root_id: identity.root_id.clone(),
    lease_id: lease_id.clone(),
    cloud_lease,
    context_generation: identity.context_generation,
    device_id: identity.device_id.clone(),
  };
  let op = Arc::new(PersonalOperation {
    captured,
    identity,
    project_id,
    lock_key,
    lease_project,
    recording_page_id: request.recording_page_id,
    recording_id: request.recording_id,
    intent_id: request.intent_id,
    run_id: request.run_id,
    route,
    transcription,
    output_target: request.output_target,
    lease_id,
    cloud_lease,
    cancelled: AtomicBool::new(false),
    closed: AtomicBool::new(false),
    writes: Mutex::new(0),
    state: Mutex::new(OperationState::default()),
  });
  lock(&state.personal_ops).insert(handle, op);
  Ok(result)
}

/// operation に束縛した turn・job を、既存の止め方（`stop_turn`・`stop_transcribe` と同じ）で止める。
fn stop_bound(state: &AppState, op: &PersonalOperation) {
  let (turns, jobs) = {
    let bound = op.st();
    (bound.turns.clone(), bound.jobs.clone())
  };
  for turn_id in turns {
    let handle = state.turns.lock().ok().and_then(|turns| turns.get(&turn_id).cloned());
    if let Some(handle) = handle {
      handle.stop();
    }
  }
  for job_id in jobs {
    let deepgram = state
      .deepgram_jobs
      .lock()
      .ok()
      .and_then(|jobs| jobs.get(&job_id).cloned());
    if let Some(stop) = deepgram {
      stop.stop();
    }
    let job = state
      .speech_jobs
      .lock()
      .ok()
      .and_then(|jobs| jobs.get(&job_id).cloned());
    if let Some(job) = job {
      tauri::async_runtime::spawn_blocking(move || job.stop());
    }
  }
}

pub(crate) fn cancel(state: &AppState, handle: &str) -> CommandResult<bool> {
  let Some(op) = lock(&state.personal_ops).get(handle).cloned() else {
    return Ok(false);
  };
  op.cancelled.store(true, Ordering::SeqCst);
  stop_bound(state, &op);
  Ok(true)
}

/// 2.1 の終わり。自分が取った実行のロックを捕捉した Store で放し（今の Root を引き直さない）、自分が取った lease だけ返す
/// （本人・保存先が変わっていれば通信せず手元の記録だけ捨てる）。二度目は `released: false`。
pub(crate) async fn close(state: &AppState, cloud: &Cloud, handle: &str) -> CommandResult<CloseResult> {
  let Some(op) = lock(&state.personal_ops).remove(handle) else {
    return Ok(CloseResult {
      released: false,
      lease_id: String::new(),
    });
  };
  op.cancelled.store(true, Ordering::SeqCst);
  stop_bound(state, &op);
  // 途中の書き込み（公開など）が終わってからロック・lease を返す（返した後に録音へ書かない）
  close_writes(&op).await;
  // この operation で準備した音声（区切りの WAV と登録）を消す。閉じた後に operation なしで送れないようにする
  // （準備の途中だったものは、prepare_audio が同じ lock の中で閉じたことを見て登録しない）
  forget_prepared_audio(state, handle);
  let current = op.captured.ensure_current().is_ok();
  let released = release_run_lock(state, op.captured.store(), op.project_id.as_deref(), &op.lock_key);
  if op.cloud_lease {
    cloud
      .release_owned_lease(&op.captured, &op.lease_project, &op.lease_id, current)
      .await;
  }
  Ok(CloseResult {
    released,
    lease_id: op.lease_id.clone(),
  })
}

/// operation で準備した音声の登録と WAV を消す。
fn forget_prepared_audio(state: &AppState, handle: &str) {
  let dirs: Vec<PathBuf> = {
    let mut jobs = lock(&state.audio_jobs);
    let owned: Vec<String> = jobs
      .iter()
      .filter(|(_, prepared)| prepared.owner.as_deref() == Some(handle))
      .map(|(job_id, _)| job_id.clone())
      .collect();
    owned
      .iter()
      .filter_map(|job_id| jobs.remove(job_id))
      .map(|prepared| prepared.dir.clone())
      .collect()
  };
  for dir in dirs {
    let _ = fs::remove_dir_all(dir);
  }
}

/// アプリの終了: 開いている operation の実行のロックを捕捉した Store で放す（通信はしない）。
pub(crate) fn release_on_exit(state: &AppState) {
  let ops: Vec<Arc<PersonalOperation>> = lock(&state.personal_ops).drain().map(|(_, op)| op).collect();
  for op in ops {
    op.closed.store(true, Ordering::SeqCst);
    op.cancelled.store(true, Ordering::SeqCst);
    release_run_lock(state, op.captured.store(), op.project_id.as_deref(), &op.lock_key);
  }
}

// ---------------------------------------------------------------------------
// guard

fn parse_phase(phase: &str) -> CommandResult<()> {
  matches!(phase, "before_dispatch" | "before_persist" | "before_cas")
    .then_some(())
    .ok_or_else(bad_request)
}

/// 2.2。本人・保存先が捕捉時から変わっていれば、その欄を空で返す（controller が ACCOUNT_CHANGED・ROOT_CHANGED にする）。lease を
/// 持つ operation は、その lease が Cloud にまだあるかも確かめ、無ければ空の leaseId を返す（LEASE_LOST）。`snapshot` を渡したら、
/// 受け入れている固定入力からの正当な派生（2.4）のときだけ進める。返す snapshotSha256 は受け入れている固定入力の hash。
pub(crate) async fn guard(
  state: &AppState,
  cloud: &Cloud,
  handle: &str,
  phase: &str,
  snapshot: Option<Value>,
) -> CommandResult<GuardResult> {
  parse_phase(phase)?;
  let op = operation_for(state, handle)?;
  let drift = op.captured.ensure_current().err();
  let lease = lease_alive(cloud, &op).await;
  let snapshot_sha256 = {
    let mut bound = op.st();
    if drift.is_none() {
      if let (Some(proposed), Some(head)) = (snapshot.as_ref(), bound.head.as_ref()) {
        if let Some(next) = accept_derived(head, &bound.receipts, proposed) {
          bound.head = Some(next);
        }
      }
    }
    bound
      .head
      .as_ref()
      .and_then(|head| head.get("snapshotSha256"))
      .and_then(Value::as_str)
      .unwrap_or_default()
      .to_string()
  };
  let drift = drift.unwrap_or_default();
  Ok(GuardResult {
    owner_account_id: if drift.account {
      String::new()
    } else {
      op.account_key().to_string()
    },
    root_id: if drift.root {
      String::new()
    } else {
      op.identity.root_id.clone()
    },
    snapshot_sha256,
    lease_id: if lease { op.lease_id.clone() } else { String::new() },
    cancelled: op.is_cancelled(),
  })
}

// ---------------------------------------------------------------------------
// canonical JSON と snapshot の派生（personal-execution.ts の canonical・generationSnapshot・nextStepSnapshot と同じ規則）

/// personal-execution.ts の `canonical()` と同じ文字列: キーを JS の sort（UTF-16 の順）で並べ、文字列と数値は JSON.stringify と
/// 同じ表記。JS で正確に表せない整数・有限でない数は None。
pub(crate) fn canonical(value: &Value) -> Option<String> {
  let mut out = String::new();
  canonical_into(value, &mut out)?;
  Some(out)
}

fn canonical_into(value: &Value, out: &mut String) -> Option<()> {
  match value {
    Value::Null => out.push_str("null"),
    Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
    Value::String(text) => out.push_str(&serde_json::to_string(text).ok()?),
    Value::Number(number) => out.push_str(&js_number(number)?),
    Value::Array(items) => {
      out.push('[');
      for (index, item) in items.iter().enumerate() {
        if index > 0 {
          out.push(',');
        }
        canonical_into(item, out)?;
      }
      out.push(']');
    }
    Value::Object(map) => {
      let mut keys: Vec<&String> = map.keys().collect();
      keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
      out.push('{');
      for (index, key) in keys.into_iter().enumerate() {
        if index > 0 {
          out.push(',');
        }
        out.push_str(&serde_json::to_string(key).ok()?);
        out.push(':');
        canonical_into(&map[key], out)?;
      }
      out.push('}');
    }
  }
  Some(())
}

/// JS の `JSON.stringify(number)`（Number::toString）と同じ表記。
fn js_number(number: &serde_json::Number) -> Option<String> {
  if let Some(value) = number.as_u64() {
    return (value <= MAX_SAFE_INTEGER).then(|| value.to_string());
  }
  if let Some(value) = number.as_i64() {
    return (value.unsigned_abs() <= MAX_SAFE_INTEGER).then(|| value.to_string());
  }
  let value = number.as_f64()?;
  if !value.is_finite() {
    return None;
  }
  Some(js_float(value))
}

pub(crate) fn js_float(value: f64) -> String {
  if value == 0.0 {
    return "0".into();
  }
  let sign = if value < 0.0 { "-" } else { "" };
  // Rust の `{:e}` は往復できる最短の桁（JS の Number::toString と同じ桁）
  let formatted = format!("{:e}", value.abs());
  let (mantissa, exponent) = formatted.split_once('e').unwrap_or((formatted.as_str(), "0"));
  let exponent: i32 = exponent.parse().unwrap_or(0);
  let digits: String = mantissa.chars().filter(|ch| ch.is_ascii_digit()).collect();
  let k = digits.len() as i32;
  let n = exponent + 1;
  let body = if k <= n && n <= 21 {
    format!("{digits}{}", "0".repeat((n - k) as usize))
  } else if 0 < n && n <= 21 {
    format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
  } else if -6 < n && n <= 0 {
    format!("0.{}{digits}", "0".repeat((-n) as usize))
  } else {
    let exponent = n - 1;
    let rest = &digits[1..];
    format!(
      "{}{}{}e{}{}",
      &digits[..1],
      if rest.is_empty() { "" } else { "." },
      rest,
      if exponent >= 0 { "+" } else { "-" },
      exponent.abs()
    )
  };
  format!("{sign}{body}")
}

fn sha256_hex(bytes: &[u8]) -> String {
  crate::process::hex(&Sha256::digest(bytes))
}

fn is_sha256(value: &str) -> bool {
  value.len() == 64
    && value
      .bytes()
      .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// snapshotSha256 を除いた canonical の SHA-256（TS の `sha256Text(canonical(withoutHash(snapshot)))`）。
pub(crate) fn snapshot_hash(snapshot: &Map<String, Value>) -> Option<String> {
  let mut without = snapshot.clone();
  without.remove("snapshotSha256");
  Some(sha256_hex(canonical(&Value::Object(without))?.as_bytes()))
}

fn with_hash(mut snapshot: Map<String, Value>) -> Option<Map<String, Value>> {
  snapshot.insert("snapshotSha256".into(), Value::from(""));
  let hash = snapshot_hash(&snapshot)?;
  snapshot.insert("snapshotSha256".into(), Value::from(hash));
  Some(snapshot)
}

/// TS の `generationSnapshot(S, sourceVersion)`。
pub(crate) fn derive_generation(head: &Map<String, Value>, source_version: &Value) -> Option<Map<String, Value>> {
  let mut next = head.clone();
  next.insert(
    "route".into(),
    json!({ "kind": "generation_only", "executor": "this_pc" }),
  );
  let input = next.get_mut("input")?.as_object_mut()?;
  input.insert("audio".into(), json!([]));
  input.insert("sourceVersion".into(), source_version.clone());
  with_hash(next)
}

/// TS の `nextStepSnapshot(S, stepId, version)`。
pub(crate) fn derive_next_step(
  head: &Map<String, Value>,
  step_id: &str,
  version: &Value,
) -> Option<Map<String, Value>> {
  let mut next = head.clone();
  let input = next.get_mut("input")?.as_object_mut()?;
  let mut prior: Vec<Value> = input
    .get("priorSteps")?
    .as_array()?
    .iter()
    .filter(|item| item.get("stepId").and_then(Value::as_str) != Some(step_id))
    .cloned()
    .collect();
  prior.push(json!({
    "stepId": step_id,
    "versionId": version.get("versionId")?.clone(),
    "path": version.get("path")?.clone(),
    "sha256": version.get("sha256")?.clone(),
    "bytes": version.get("bytes")?.clone(),
  }));
  input.insert("priorSteps".into(), Value::Array(prior));
  with_hash(next)
}

/// 受け入れている固定入力（head）から、この operation が公開した版（receipt）による正当な派生なら、その派生を返す。head と同じ
/// ものは head のまま。hash の改ざん・ほかの差分（モデル・フロー・入力の差し替え）・ほかの operation の版は None。
fn accept_derived(head: &Map<String, Value>, receipts: &[Receipt], proposed: &Value) -> Option<Map<String, Value>> {
  let proposed = proposed.as_object()?;
  let proposed_sha = proposed.get("snapshotSha256")?.as_str()?;
  if snapshot_hash(proposed)? != proposed_sha {
    return None;
  }
  let head_sha = head.get("snapshotSha256").and_then(Value::as_str)?;
  if proposed_sha == head_sha {
    return Some(head.clone());
  }
  receipts.iter().find_map(|receipt| {
    let derived = match receipt.kind {
      CandidateKind::Source => derive_generation(head, &receipt.version)?,
      CandidateKind::Artifact => derive_next_step(head, &receipt.step_id, &receipt.version)?,
    };
    (derived.get("snapshotSha256")?.as_str()? == proposed_sha).then_some(derived)
  })
}

/// 画面から受け取った固定入力: object・大きさの上限・hash が中身と一致する。
fn verified_snapshot(snapshot: &Value) -> CommandResult<Map<String, Value>> {
  let map = snapshot.as_object().ok_or_else(snapshot_invalid)?;
  let size = serde_json::to_vec(snapshot)
    .map(|bytes| bytes.len())
    .unwrap_or(usize::MAX);
  if size > MAX_SNAPSHOT_BYTES {
    return Err(snapshot_invalid());
  }
  let given = map
    .get("snapshotSha256")
    .and_then(Value::as_str)
    .filter(|hash| is_sha256(hash))
    .ok_or_else(snapshot_invalid)?;
  if snapshot_hash(map).as_deref() != Some(given) {
    return Err(snapshot_invalid());
  }
  Ok(map.clone())
}

fn container_json(project_id: Option<&str>) -> Value {
  match project_id {
    Some(project_id) => json!({ "kind": "folder", "projectId": project_id }),
    None => json!({ "kind": "root" }),
  }
}

fn same_json(left: Option<&Value>, right: &Value) -> bool {
  left.and_then(canonical) == canonical(right)
}

/// 固定入力の本人・保存先・置き場所・録音・経路・文字起こしの方式が、この operation と一致する。
fn snapshot_matches(op: &PersonalOperation, snapshot: &Map<String, Value>) -> bool {
  let text = |key: &str| snapshot.get(key).and_then(Value::as_str);
  snapshot.get("schemaVersion").and_then(Value::as_u64) == Some(1)
    && text("ownerAccountId") == Some(op.account_key())
    && text("rootId") == Some(op.identity.root_id.as_str())
    && text("recordingPageId") == Some(op.recording_page_id.as_str())
    && text("recordingId") == Some(op.recording_id.as_str())
    && same_json(snapshot.get("containerRef"), &container_json(op.project_id.as_deref()))
    && same_json(snapshot.get("route"), &op.route.to_json())
    && same_json(
      snapshot.get("transcriptionModel"),
      &op.transcription.map(Transcription::model_json).unwrap_or(Value::Null),
    )
    && match &op.output_target {
      Some(target) => same_json(snapshot.get("outputTarget"), target),
      None => snapshot.get("outputTarget").is_none(),
    }
}

/// 固定入力の音声（path・sha256・bytes）が、この operation が material で照合した音声と順も含めて完全に一致する
/// （送る音声が受け付けた hash に入っていない状態を作らない）。
fn audio_matches(op: &PersonalOperation, snapshot: &Map<String, Value>) -> bool {
  let recorded = op.st().audio.clone();
  let Some(audio) = snapshot
    .get("input")
    .and_then(|input| input.get("audio"))
    .and_then(Value::as_array)
  else {
    return false;
  };
  audio.len() == recorded.len()
    && audio.iter().zip(&recorded).all(|(item, known)| {
      item.get("path").and_then(Value::as_str) == Some(known.relative.as_str())
        && item.get("sha256").and_then(Value::as_str) == Some(known.sha256.as_str())
        && item.get("bytes").and_then(Value::as_u64) == Some(known.bytes)
    })
}

/// 派生した後の固定入力でも変わらない識別（本人・保存先・置き場所・録音）だけを照らす（verify・persist 用）。
fn snapshot_identity_matches(op: &PersonalOperation, snapshot: &Map<String, Value>) -> bool {
  let text = |key: &str| snapshot.get(key).and_then(Value::as_str);
  text("ownerAccountId") == Some(op.account_key())
    && text("rootId") == Some(op.identity.root_id.as_str())
    && text("recordingPageId") == Some(op.recording_page_id.as_str())
    && text("recordingId") == Some(op.recording_id.as_str())
    && same_json(snapshot.get("containerRef"), &container_json(op.project_id.as_deref()))
}

// ---------------------------------------------------------------------------
// intent（app data の本人 namespace の下。同期しない）

/// 実行の記録の読み書きを、このアプリの中で 1 つずつにする（別のアプリとは実行のロックで重ならない）。
static INTENT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DispatchMarker {
  step_id: String,
  at: String,
  terminal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntentFile {
  schema_version: u8,
  intent_id: String,
  run_id: String,
  owner_account_id: String,
  root_id: String,
  project_id: Option<String>,
  recording_page_id: String,
  recording_id: String,
  /// `reserved`（受け付けた）か PersonalRunState。
  state: String,
  snapshot_sha256: String,
  snapshot: Value,
  #[serde(default)]
  receipts: Vec<Value>,
  #[serde(default)]
  dispatches: Vec<DispatchMarker>,
  created_at: String,
  updated_at: String,
}

fn intents_dir(identity: &OperationIdentity) -> CommandResult<String> {
  let key = identity.account_key.as_deref().ok_or_else(not_signed_in)?;
  let valid_key = key.len() == 64
    && key
      .bytes()
      .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
  if !valid_key || crate::safe_id(&identity.root_id).is_err() {
    return Err(intent_io());
  }
  Ok(format!("{INTENTS_DIR}/{key}/{}/intents", identity.root_id))
}

fn intent_relative(op: &PersonalOperation) -> CommandResult<String> {
  Ok(format!("{}/{}.json", intents_dir(&op.identity)?, op.intent_id))
}

/// 作りながらリンクを断る（app data の下だけ）。
fn create_dirs_without_symlinks(root: &Path, relative_dir: &str) -> std::io::Result<PathBuf> {
  let mut path = root.to_path_buf();
  for part in relative_dir.split('/') {
    path.push(part);
    match fs::symlink_metadata(&path) {
      Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
        return Err(std::io::Error::other("not a plain directory"));
      }
      Ok(_) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&path)?,
      Err(error) => return Err(error),
    }
  }
  Ok(path)
}

/// 新しい記録を排他で作る（一時ファイルに書いて fsync → hard link で原子的に置く。既にあれば false）。
fn create_exclusive(root: &Path, relative: &str, bytes: &[u8]) -> std::io::Result<bool> {
  validate_relative_path(relative).map_err(|_| std::io::Error::other("bad path"))?;
  let (dir, name) = relative
    .rsplit_once('/')
    .ok_or_else(|| std::io::Error::other("bad path"))?;
  let parent = create_dirs_without_symlinks(root, dir)?;
  let suffix = random_token(8).map_err(|_| std::io::Error::other("random"))?;
  let temporary = parent.join(format!(".{name}.tmp-{}-{suffix}", std::process::id()));
  {
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
  }
  let linked = fs::hard_link(&temporary, parent.join(name));
  let _ = fs::remove_file(&temporary);
  match linked {
    Ok(()) => {
      if let Ok(directory) = fs::File::open(&parent) {
        let _ = directory.sync_all();
      }
      Ok(true)
    }
    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
    Err(error) => Err(error),
  }
}

enum IntentRead {
  Missing,
  Corrupt,
  Found(Box<IntentFile>),
}

fn read_intent(root: &Path, relative: &str) -> IntentRead {
  let path = root.join(relative);
  match fs::symlink_metadata(&path) {
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return IntentRead::Missing,
    Ok(meta) if meta.is_file() => {}
    _ => return IntentRead::Corrupt,
  }
  match fs::read(&path)
    .ok()
    .and_then(|bytes| serde_json::from_slice::<IntentFile>(&bytes).ok())
  {
    Some(file) => IntentRead::Found(Box::new(file)),
    None => IntentRead::Corrupt,
  }
}

fn write_intent(root: &Path, relative: &str, file: &IntentFile) -> CommandResult<()> {
  let bytes = serde_json::to_vec_pretty(file).map_err(|_| intent_io())?;
  atomic_write(root, relative, &bytes).map_err(|_| intent_io())
}

/// 画面へ返す記録の状態（受け付けただけの `reserved` は実行中として返す。知らない値は結果不明として扱う）。
fn reported_state(state: &str) -> String {
  if state == "reserved" {
    return "running".into();
  }
  if RUN_STATES.contains(&state) {
    state.to_string()
  } else {
    "result_unknown".into()
  }
}

/// この operation が受け付けた記録を書き換える（受け付けていなければ断る）。
fn update_intent(
  state: &AppState,
  op: &PersonalOperation,
  change: impl FnOnce(&mut IntentFile) -> CommandResult<()>,
) -> CommandResult<()> {
  if !op.st().reserved {
    return Err(intent_not_reserved());
  }
  let relative = intent_relative(op)?;
  let _guard = lock(&INTENT_LOCK);
  let IntentRead::Found(mut file) = read_intent(&state.data_dir, &relative) else {
    return Err(intent_io());
  };
  change(&mut file)?;
  file.updated_at = store::now_iso();
  write_intent(&state.data_dir, &relative, &file)
}

/// 2.3 の受付。snapshot の hash と、本人・保存先・録音・経路が operation と一致するときだけ。
pub(crate) fn reserve_intent(
  state: &AppState,
  handle: &str,
  intent_id: &str,
  snapshot: &Value,
) -> CommandResult<ReserveResult> {
  let op = operation_for(state, handle)?;
  if intent_id != op.intent_id {
    return Err(intent_mismatch());
  }
  if op.is_cancelled() || op.captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  let snapshot = verified_snapshot(snapshot)?;
  if !snapshot_matches(&op, &snapshot) || !audio_matches(&op, &snapshot) {
    return Err(snapshot_mismatch());
  }
  let sha = snapshot
    .get("snapshotSha256")
    .and_then(Value::as_str)
    .unwrap_or_default()
    .to_string();
  let relative = intent_relative(&op)?;
  let outcome = {
    let _guard = lock(&INTENT_LOCK);
    let mut found = read_intent(&state.data_dir, &relative);
    if matches!(found, IntentRead::Missing) {
      let now = store::now_iso();
      let file = IntentFile {
        schema_version: 1,
        intent_id: op.intent_id.clone(),
        run_id: op.run_id.clone(),
        owner_account_id: op.account_key().to_string(),
        root_id: op.identity.root_id.clone(),
        project_id: op.project_id.clone(),
        recording_page_id: op.recording_page_id.clone(),
        recording_id: op.recording_id.clone(),
        state: "reserved".into(),
        snapshot_sha256: sha.clone(),
        snapshot: Value::Object(snapshot.clone()),
        receipts: Vec::new(),
        dispatches: Vec::new(),
        created_at: now.clone(),
        updated_at: now,
      };
      let bytes = serde_json::to_vec_pretty(&file).map_err(|_| intent_io())?;
      if create_exclusive(&state.data_dir, &relative, &bytes).map_err(|_| intent_io())? {
        ReserveResult::New
      } else {
        found = read_intent(&state.data_dir, &relative);
        existing_intent(state, &op, &relative, found, &sha)?
      }
    } else {
      existing_intent(state, &op, &relative, found, &sha)?
    }
  };
  if matches!(outcome, ReserveResult::New | ReserveResult::Resumed) {
    let mut bound = op.st();
    bound.head = Some(snapshot);
    bound.reserved = true;
    bound.dispatch_open = false;
  }
  Ok(outcome)
}

/// 既にある記録: 終わっていない dispatch marker があれば結果不明、同じ固定入力の `waiting_auth`・未送信の `reserved` は受付に戻して
/// 再開、それ以外は記録された状態。INTENT_LOCK の中で呼ぶ。
fn existing_intent(
  state: &AppState,
  op: &PersonalOperation,
  relative: &str,
  found: IntentRead,
  sha: &str,
) -> CommandResult<ReserveResult> {
  let mut file = match found {
    IntentRead::Found(file) => file,
    _ => {
      return Ok(ReserveResult::Existing {
        state: "result_unknown".into(),
      })
    }
  };
  let same_owner = file.owner_account_id == op.account_key()
    && file.root_id == op.identity.root_id
    && file.recording_id == op.recording_id
    && file.recording_page_id == op.recording_page_id
    && file.project_id == op.project_id;
  if !same_owner || file.dispatches.iter().any(|marker| !marker.terminal) {
    return Ok(ReserveResult::Existing {
      state: "result_unknown".into(),
    });
  }
  // 一度も送っていない reserved は、同じ intent を受け付けた operation が残っていないときだけ再開する。
  // 終了済み marker があっても送信済みなので、自動再送の対象にしない。
  let resumable = file.state == "waiting_auth"
    || (file.state == "reserved" && file.dispatches.is_empty() && !intent_held_by_open_operation(state, op));
  if resumable && file.snapshot_sha256 == sha {
    file.state = "reserved".into();
    file.run_id = op.run_id.clone();
    file.updated_at = store::now_iso();
    write_intent(&state.data_dir, relative, &file)?;
    return Ok(ReserveResult::Resumed);
  }
  Ok(ReserveResult::Existing {
    state: reported_state(&file.state),
  })
}

/// 今開いている operation（自分を含む）が、同じ本人・保存先の同じ intent を受け付けているか。
fn intent_held_by_open_operation(state: &AppState, op: &PersonalOperation) -> bool {
  lock(&state.personal_ops).values().any(|other| {
    !other.is_closed()
      && other.intent_id == op.intent_id
      && other.account_key() == op.account_key()
      && other.identity.root_id == op.identity.root_id
      && other.st().reserved
  })
}

fn step_selectable(op: &PersonalOperation, step_id: &str) -> bool {
  if step_id == store::SOURCE_STEP_ID {
    return op.route.local();
  }
  op.st()
    .head
    .as_ref()
    .and_then(|head| head.get("selectedStepIds"))
    .and_then(Value::as_array)
    .is_some_and(|steps| steps.iter().any(|step| step.as_str() == Some(step_id)))
}

/// 2.3 の dispatch marker。外部実行の直前に永続化（fsync）する。書けなければ Err（呼び出し側は送らない）。
pub(crate) async fn mark_dispatch(
  state: &AppState,
  cloud: &Cloud,
  handle: &str,
  intent_id: &str,
  step_id: &str,
) -> CommandResult<()> {
  let op = operation_for(state, handle)?;
  if intent_id != op.intent_id {
    return Err(intent_mismatch());
  }
  crate::safe_id(step_id)?;
  if !step_selectable(&op, step_id) {
    return Err(bad_request());
  }
  if op.is_cancelled() || op.captured.ensure_current().is_err() || !lease_alive(cloud, &op).await {
    return Err(guard_failed());
  }
  // lease の確認（await）の間に取り消し・閉じる・本人や保存先の変化が入ったら marker を書かない
  if op.stop_requested() || op.captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  update_intent(state, &op, |file| {
    if file.state != "reserved" && file.state != "running" {
      return Err(intent_closed());
    }
    file.state = "running".into();
    file.dispatches.push(DispatchMarker {
      step_id: step_id.to_string(),
      at: store::now_iso(),
      terminal: false,
    });
    Ok(())
  })?;
  op.st().dispatch_open = true;
  Ok(())
}

/// 2.3 の状態の永続化。終端の状態は dispatch marker を閉じる。`result_unknown` は一度書いたら変えない（自動で送り直さない）。
pub(crate) fn mark_intent(state: &AppState, handle: &str, intent_id: &str, run_state: &str) -> CommandResult<()> {
  let op = operation_for(state, handle)?;
  if intent_id != op.intent_id {
    return Err(intent_mismatch());
  }
  if !RUN_STATES.contains(&run_state) {
    return Err(bad_request());
  }
  let terminal = TERMINAL_STATES.contains(&run_state);
  let mut closed = false;
  update_intent(state, &op, |file| {
    if file.state == "result_unknown" {
      return Ok(());
    }
    // 結果の分かった intent（NIHO API の受付を Native が確かめた submitted など）を、後から結果不明に戻さない
    if run_state == "result_unknown" && TERMINAL_STATES.contains(&file.state.as_str()) {
      return Ok(());
    }
    file.state = run_state.to_string();
    if terminal {
      for marker in &mut file.dispatches {
        marker.terminal = true;
      }
      closed = true;
    }
    Ok(())
  })?;
  if closed {
    op.st().dispatch_open = false;
  }
  Ok(())
}

/// 2.3 の途中記録（checkpoint・部分出力・送信直後の RunRecord）。intent の private 領域（同期しない）へ。runs.jsonl・現在本文・版には
/// 書かない。
pub(crate) fn save_private(
  state: &AppState,
  handle: &str,
  intent_id: &str,
  kind: &str,
  payload: &Value,
) -> CommandResult<()> {
  let op = operation_for(state, handle)?;
  if intent_id != op.intent_id {
    return Err(intent_mismatch());
  }
  if !PRIVATE_KINDS.contains(&kind) {
    return Err(bad_request());
  }
  if !op.st().reserved {
    return Err(intent_not_reserved());
  }
  let bytes = serde_json::to_vec(payload).map_err(|_| bad_request())?;
  if bytes.len() > MAX_PRIVATE_BYTES {
    return Err(bad_request());
  }
  let relative = format!("{}/{}.private/{kind}.json", intents_dir(&op.identity)?, op.intent_id);
  let _guard = lock(&INTENT_LOCK);
  atomic_write(&state.data_dir, &relative, &bytes).map_err(|_| intent_io())
}

// ---------------------------------------------------------------------------
// material・verify

/// 音声をメモリに載せずに SHA-256 と大きさを計算し、計算の前後で実体が変わっていないことも確かめる。
fn hash_audio(relative: &str, path: &Path) -> CommandResult<AudioIdentity> {
  let before = fs::symlink_metadata(path).map_err(|_| audio_missing())?;
  if !before.is_file() {
    return Err(audio_missing());
  }
  let mut file = fs::File::open(path).map_err(|_| audio_missing())?;
  let mut hasher = Sha256::new();
  let mut buffer = vec![0_u8; 256 * 1024];
  let mut bytes: u64 = 0;
  loop {
    let count = file.read(&mut buffer).map_err(|_| audio_missing())?;
    if count == 0 {
      break;
    }
    hasher.update(&buffer[..count]);
    bytes += count as u64;
  }
  let after = fs::symlink_metadata(path).map_err(|_| audio_changed())?;
  let identity = AudioIdentity {
    relative: relative.to_string(),
    path: path.to_path_buf(),
    sha256: crate::process::hex(&hasher.finalize()),
    bytes,
    dev: before.dev(),
    ino: before.ino(),
    mtime: before.mtime(),
    mtime_nsec: before.mtime_nsec(),
  };
  let stable = after.dev() == before.dev()
    && after.ino() == before.ino()
    && after.len() == before.len()
    && after.mtime() == before.mtime()
    && after.mtime_nsec() == before.mtime_nsec()
    && bytes == before.len();
  if !stable || bytes == 0 {
    return Err(audio_changed());
  }
  Ok(identity)
}

/// 音声の写しが material のときと同じ実体か（リンクでない・同じ dev/ino・大きさ・更新時刻）。
fn audio_unchanged(audio: &AudioIdentity) -> bool {
  fs::symlink_metadata(&audio.path).is_ok_and(|meta| {
    meta.is_file()
      && meta.dev() == audio.dev
      && meta.ino() == audio.ino
      && meta.len() == audio.bytes
      && meta.mtime() == audio.mtime
      && meta.mtime_nsec() == audio.mtime_nsec
  })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialRequestWire {
  step_ids: Vec<String>,
}

fn text_of(bytes: Vec<u8>) -> CommandResult<String> {
  String::from_utf8(bytes).map_err(|_| failure("personal_bad_text", "文書を読めませんでした。"))
}

/// 版の出どころ（runs.jsonl の行の origin。apps/api/src/ops/docs-runs.ts が書く値に合わせる: 本人 Mac は `LOCAL`、NIHO API の
/// 原文の写しは `NIHO_API_SNAPSHOT`、共有 Mac・NIHO API の実行は route の名前）。origin の無い行は、NIHO の Run の id が
/// あれば共有 Mac、無ければこの Mac の版とみなす。知らない値は None（固定入力に使わない）。
pub(crate) fn origin_of(row: &Value) -> Option<&'static str> {
  match row.get("origin") {
    None | Some(Value::Null) => Some(if row.get("remoteRunId").and_then(Value::as_str).is_some() {
      "shared_mac"
    } else {
      "this_pc"
    }),
    Some(Value::String(origin)) => match origin.as_str() {
      "LOCAL" | "this_pc" => Some("this_pc"),
      "shared_mac" => Some("shared_mac"),
      "niho_api" | "NIHO_API_SNAPSHOT" => Some("niho_api"),
      _ => None,
    },
    Some(_) => None,
  }
}

/// 版を作った Run（本人 Mac 実行の runId → NIHO の Run の id → 行の id の順）。
fn origin_run_id(row: &Value) -> String {
  ["personalRunId", "runId", "id"]
    .iter()
    .find_map(|key| row.get(*key).and_then(Value::as_str))
    .unwrap_or_default()
    .to_string()
}

fn speaker_mode(value: Option<&Value>) -> Option<&str> {
  value
    .and_then(Value::as_str)
    .filter(|mode| matches!(*mode, "auto" | "2" | "3" | "4plus" | "none"))
}

fn language(value: Option<&Value>) -> Option<&str> {
  value
    .and_then(Value::as_str)
    .filter(|lang| matches!(*lang, "ja" | "en"))
}

fn terms_of(info: Option<&Value>) -> Value {
  let terms = info
    .and_then(|info| info.get("terms"))
    .and_then(Value::as_array)
    .map(|terms| {
      terms
        .iter()
        .filter_map(|term| {
          Some(json!({
            "term": term.get("term")?.as_str()?,
            "reading": term.get("reading").and_then(Value::as_str).unwrap_or_default(),
            "variants": term.get("variants").and_then(Value::as_array).map(|variants| {
              variants.iter().filter_map(Value::as_str).map(Value::from).collect::<Vec<_>>()
            }).unwrap_or_default(),
            "note": term.get("note").and_then(Value::as_str).unwrap_or_default(),
          }))
        })
        .collect::<Vec<_>>()
    })
    .unwrap_or_default();
  Value::Array(terms)
}

fn hashed(value: Value) -> Value {
  let sha256 = canonical(&value).map(|text| sha256_hex(text.as_bytes()));
  json!({ "value": value, "sha256": sha256 })
}

/// 2.5。捕捉した Store から固定入力の素材を読む（PersonalSnapshotMaterial ＋ promptMaterials）。音声は Rust で SHA-256 を計算し、
/// その実体（dev/ino/大きさ/更新時刻）を operation に記録する（後の verify・送信で使う）。
pub(crate) async fn read_material(state: &AppState, handle: &str, step_ids: Vec<String>) -> CommandResult<Value> {
  let op = operation_for(state, handle)?;
  if op.captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  // 受け付けた後に音声を読み直すと、送る音声と受け付けた固定入力の hash がずれる
  if op.st().reserved {
    return Err(failure(
      "personal_material_locked",
      "実行を受け付けた後は、素材を読み直せません。もう一度実行してください。",
    ));
  }
  for step_id in &step_ids {
    crate::safe_id(step_id)?;
  }
  let worker = op.clone();
  let (material, audio) = tauri::async_runtime::spawn_blocking(move || build_material(&worker, &step_ids))
    .await
    .map_err(|_| failure("personal_io", "素材を読めませんでした。"))??;
  op.st().audio = audio;
  Ok(material)
}

fn build_material(op: &PersonalOperation, step_ids: &[String]) -> CommandResult<(Value, Vec<AudioIdentity>)> {
  let store = op.captured.store();
  let project_id = op.project_id.as_deref();
  let rec = store.personal_recording(project_id, &op.recording_page_id, &op.recording_id)?;
  let flow = rec
    .recording
    .get("flowSnapshot")
    .filter(|flow| flow.is_object())
    .cloned()
    .ok_or_else(|| StoreError::new("store_bad_json", "録音の工程を読めませんでした。"))?;
  let flow_steps: Vec<String> = flow
    .get("steps")
    .and_then(Value::as_array)
    .map(|steps| {
      steps
        .iter()
        .filter_map(|step| step.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
    })
    .unwrap_or_default();
  if step_ids.iter().any(|step| !flow_steps.contains(step)) {
    return Err(bad_request());
  }
  let selected: Vec<&String> = flow_steps.iter().filter(|step| step_ids.contains(step)).collect();
  // 話者・言語は録音（無ければフォルダ）、背景情報・用語はフォルダ（フォルダ外は空。画面の EMPTY_PROJECT_INFO と同じ）
  let info = if project_id.is_some() {
    rec.owner.get("info")
  } else {
    None
  };
  let speakers = speaker_mode(rec.recording.get("speakers"))
    .or_else(|| speaker_mode(info.and_then(|info| info.get("speakers"))))
    .unwrap_or("auto");
  let lang = language(rec.recording.get("language"))
    .or_else(|| language(info.and_then(|info| info.get("language"))))
    .unwrap_or("ja");
  let source_name = if rec
    .recording
    .get("source")
    .and_then(|source| source.get("kind"))
    .and_then(Value::as_str)
    == Some("text")
  {
    "文章"
  } else {
    "文字起こし"
  };
  let background = info
    .and_then(|info| info.get("background"))
    .and_then(Value::as_str)
    .unwrap_or_default();
  let terms = terms_of(info);
  let entities = info
    .and_then(|info| info.get("entities"))
    .filter(|entities| entities.is_array())
    .cloned()
    .unwrap_or_else(|| json!([]));
  // 音声（端末内の経路だけ。後続だけの実行は音声を送らない）
  let mut audio_refs = Vec::new();
  let mut identities = Vec::new();
  if op.route.local() {
    for item in store.personal_audio(&rec)? {
      let identity = hash_audio(&item.relative, &item.path)?;
      if item
        .recorded_sha256
        .as_deref()
        .is_some_and(|recorded| recorded != identity.sha256)
      {
        return Err(audio_changed());
      }
      audio_refs.push(json!({
        "path": identity.relative,
        "sha256": identity.sha256,
        "bytes": identity.bytes,
        "durationSec": item.duration_sec,
        "verification": "native_sha256",
      }));
      identities.push(identity);
    }
  }
  let vault = op.captured.vault_state(&op.lease_project);
  let synced = |path: &str, sha: &str| {
    vault.as_ref().is_some_and(|state| {
      !state.dirty.contains_key(path) && state.base_file(path).is_some_and(|file| file.sha256 == sha)
    })
  };
  // 出どころの分からない版は固定入力に使わない（fail closed）。原文は後工程に使う文字起こしの案（#19108。指定が台帳に無ければ断る）
  let source_artifact = store.personal_selected_source_artifact(&rec)?;
  let latest_source = store
    .personal_latest_version(&rec, &source_artifact)?
    .filter(|version| origin_of(&version.row).is_some());
  let source_version = match latest_source {
    Some(version) => {
      let sha = sha256_hex(&version.bytes);
      json!({
        "versionId": version.version_id,
        "path": version.path,
        "originRunId": origin_run_id(&version.row),
        "origin": origin_of(&version.row),
        "content": text_of(version.bytes)?,
        "expectedSha256": sha,
        "synced": synced(&version.path, &sha),
      })
    }
    None => Value::Null,
  };
  // 前工程: 選んだ最後の工程より前で、選んでいない工程の最新の確定版（選んだ工程の版は実行の中で足す）
  let last = selected
    .last()
    .and_then(|last| flow_steps.iter().position(|step| step == *last));
  let mut prior_steps = Vec::new();
  if let Some(last) = last {
    for step_id in flow_steps[..last].iter().filter(|step| !step_ids.contains(step)) {
      if let Some(version) = store.personal_latest_version(&rec, step_id)? {
        let sha = sha256_hex(&version.bytes);
        prior_steps.push(json!({
          "stepId": step_id,
          "versionId": version.version_id,
          "path": version.path,
          "content": text_of(version.bytes)?,
          "expectedSha256": sha,
        }));
      }
    }
  }
  // 参考ページ（本文が空の文書は入力に入れない。runner の usedRefs と同じ）
  let references = store.personal_references(project_id, &rec)?;
  let mut reference_pages = Vec::new();
  let mut reference_titles = Vec::new();
  for reference in references
    .into_iter()
    .filter(|reference| !reference.body.trim().is_empty())
  {
    let sha = sha256_hex(reference.body.as_bytes());
    reference_titles.push(json!({ "pageId": reference.page_id, "title": reference.title }));
    reference_pages.push(json!({
      "pageId": reference.page_id,
      "path": reference.path,
      "versionId": format!("p_{}", &sha[..32]),
      "content": reference.body,
      "expectedSha256": sha,
    }));
  }
  let mut expected = Map::new();
  for step_id in &selected {
    let artifact_id = op
      .output_target
      .as_ref()
      .and_then(Value::as_object)
      .filter(|target| target.get("stepId").and_then(Value::as_str) == Some(step_id.as_str()))
      .and_then(|target| target.get("artifactId"))
      .and_then(Value::as_str)
      .unwrap_or(step_id);
    let file = store.personal_current_file(&rec, artifact_id, false)?;
    let sha = fs::symlink_metadata(&file)
      .ok()
      .filter(|meta| meta.is_file())
      .and_then(|_| fs::read(&file).ok())
      .map(|bytes| Value::from(sha256_hex(&bytes)))
      .unwrap_or(Value::Null);
    expected.insert((*step_id).clone(), sha);
  }
  // 文字起こしをする経路は、今の文字起こし（transcript.md。版になっていない手直しも含む。無ければ null）を原文の公開の照合値にする
  if op.route.local() {
    // 文字起こしの別案を作る実行は、その案の今の本文を照合値にする
    let source_target = op
      .output_target
      .as_ref()
      .and_then(Value::as_object)
      .filter(|target| target.get("stepId").and_then(Value::as_str) == Some(store::SOURCE_STEP_ID))
      .and_then(|target| target.get("artifactId"))
      .and_then(Value::as_str)
      .unwrap_or(store::SOURCE_STEP_ID);
    let file = store.personal_current_file(&rec, source_target, true)?;
    let sha = fs::symlink_metadata(&file)
      .ok()
      .filter(|meta| meta.is_file())
      .and_then(|_| fs::read(&file).ok())
      .map(|bytes| Value::from(sha256_hex(&bytes)))
      .unwrap_or(Value::Null);
    expected.insert(store::SOURCE_STEP_ID.to_string(), sha);
  }
  let about = store
    .load_about()?
    .map(|about| {
      json!({
        "name": about.get("name").and_then(Value::as_str).unwrap_or_default(),
        "text": about.get("text").and_then(Value::as_str).unwrap_or_default(),
      })
    })
    .unwrap_or(Value::Null);
  let material = json!({
    "baseManifestRevision": vault.as_ref().map(|state| state.base_revision).unwrap_or(0),
    "recordingMetadata": {
      "speakers": speakers,
      "language": lang,
      "background": background,
      "terms": terms,
      "sourceName": source_name,
    },
    "flow": flow,
    "audio": audio_refs,
    "transcriptionModel": op.transcription.map(Transcription::model_json).unwrap_or(Value::Null),
    "sourceVersion": source_version,
    "sourceArtifactId": source_artifact,
    "referencePages": reference_pages,
    "priorSteps": prior_steps,
    "expectedCurrentArtifactShaByStep": expected,
    "promptMaterials": {
      "about": hashed(about),
      "referenceTitles": hashed(Value::Array(reference_titles)),
      "info": hashed(json!({
        "speakers": speakers,
        "language": lang,
        "terms": terms,
        "background": background,
        "entities": entities,
      })),
    },
  });
  Ok((material, identities))
}

/// 同意後の NIHO API 向けモデル持ち替え。画面の現在 Store ではなく、実行を開始した本人・保存先・録音へ束縛する。
fn swap_models(state: &AppState, handle: &str, expected_flow: Value, models: Value) -> CommandResult<bool> {
  let op = operation_for(state, handle)?;
  if op.route.kind != RouteKind::GenerationOnly || op.route.executor != Some(Executor::NihoApi) {
    return Err(bad_request());
  }
  let _write = begin_write(&op)?;
  if op.stop_requested() || op.captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  op.captured
    .run(|store| {
      store.personal_swap_models(
        op.project_id.as_deref(),
        &op.recording_page_id,
        &op.recording_id,
        &expected_flow,
        &models,
      )
    })
    .map_err(Into::into)
}

fn unverified(reason: &str) -> VerifyResult {
  VerifyResult {
    verified: false,
    reason: Some(reason.to_string()),
  }
}

fn entry_matches(bytes: Option<Vec<u8>>, entry: &Value) -> bool {
  let Some(bytes) = bytes else { return false };
  entry.get("sha256").and_then(Value::as_str) == Some(sha256_hex(&bytes).as_str())
    && entry.get("bytes").and_then(Value::as_u64) == Some(bytes.len() as u64)
}

/// 2.5 の再検査: 音声の実体が material のときのままで SHA/大きさが固定入力と一致し、版・参考・前工程のファイルの実 SHA/大きさも一致する。
pub(crate) fn verify_inputs(state: &AppState, handle: &str, snapshot: &Value) -> CommandResult<VerifyResult> {
  let op = operation_for(state, handle)?;
  let Ok(snapshot) = verified_snapshot(snapshot) else {
    return Ok(unverified("固定した入力の形が正しくありません。"));
  };
  if !snapshot_identity_matches(&op, &snapshot) {
    return Ok(unverified("固定した入力が、この実行の録音と一致しません。"));
  }
  let Some(input) = snapshot.get("input").and_then(Value::as_object) else {
    return Ok(unverified("固定した入力の形が正しくありません。"));
  };
  let recorded = op.st().audio.clone();
  for audio in input
    .get("audio")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default()
  {
    let path = audio.get("path").and_then(Value::as_str).unwrap_or_default();
    let Some(known) = recorded.iter().find(|known| known.relative == path) else {
      return Ok(unverified("音声を確かめられませんでした。"));
    };
    let same = audio.get("sha256").and_then(Value::as_str) == Some(known.sha256.as_str())
      && audio.get("bytes").and_then(Value::as_u64) == Some(known.bytes);
    if !same || !audio_unchanged(known) {
      return Ok(unverified("音声の内容が変わりました。"));
    }
  }
  let store = op.captured.store();
  let project_id = op.project_id.as_deref();
  let rec = store.personal_recording(project_id, &op.recording_page_id, &op.recording_id)?;
  let read_version = |step_id: &str, entry: &Value| -> Option<Vec<u8>> {
    let path = entry.get("path").and_then(Value::as_str)?;
    store.personal_read_version(&rec, step_id, path).ok().flatten()
  };
  if let Some(source) = input.get("sourceVersion").filter(|source| !source.is_null()) {
    if !entry_matches(read_version(store::SOURCE_STEP_ID, source), source) {
      return Ok(unverified("原文の版が変わりました。"));
    }
    // 版の出どころ（runs.jsonl の行の origin）が分からない・固定入力と違う版は使わない
    let path = source.get("path").and_then(Value::as_str).unwrap_or_default();
    let row = store
      .personal_version_row(&rec, store::SOURCE_STEP_ID, path)
      .ok()
      .flatten();
    let Some(origin) = row.as_ref().and_then(origin_of) else {
      return Ok(unverified("原文の版の出どころを確かめられません。"));
    };
    let same = source.get("origin").and_then(Value::as_str) == Some(origin)
      && source.get("originRunId").and_then(Value::as_str) == row.as_ref().map(origin_run_id).as_deref();
    if !same {
      return Ok(unverified("原文の版の出どころが固定した入力と違います。"));
    }
  }
  for prior in input
    .get("priorSteps")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default()
  {
    let step_id = prior.get("stepId").and_then(Value::as_str).unwrap_or_default();
    if crate::safe_id(step_id).is_err() || !entry_matches(read_version(step_id, &prior), &prior) {
      return Ok(unverified("前の工程の版が変わりました。"));
    }
  }
  for reference in input
    .get("referencePages")
    .and_then(Value::as_array)
    .cloned()
    .unwrap_or_default()
  {
    let page_id = reference.get("pageId").and_then(Value::as_str).unwrap_or_default();
    let path = reference.get("path").and_then(Value::as_str).unwrap_or_default();
    let bytes = store.personal_read_page(project_id, page_id, path).ok().flatten();
    if !entry_matches(bytes, &reference) {
      return Ok(unverified("参考ページが変わりました。"));
    }
  }
  Ok(VerifyResult {
    verified: true,
    reason: None,
  })
}

// ---------------------------------------------------------------------------
// candidate・publish・record

fn present<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
  Value::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateWire {
  step_id: String,
  artifact_id: String,
  kind: String,
  version_id: String,
  path: String,
  text: String,
  provider: String,
  model: Value,
  #[serde(default, deserialize_with = "present")]
  reported_model: Option<Value>,
  sha256: String,
  bytes: u64,
}

fn candidate_kind(kind: &str) -> CommandResult<CandidateKind> {
  match kind {
    "source" => Ok(CandidateKind::Source),
    "artifact" => Ok(CandidateKind::Artifact),
    _ => Err(bad_request()),
  }
}

fn kind_name(kind: CandidateKind) -> &'static str {
  match kind {
    CandidateKind::Source => "source",
    CandidateKind::Artifact => "artifact",
  }
}

/// 受け入れている固定入力の、その工程の固定モデル（工程 1 は文字起こしの方式）。
fn fixed_model(op: &PersonalOperation, kind: CandidateKind, step_id: &str) -> Option<Value> {
  let state = op.st();
  let head = state.head.as_ref()?;
  match kind {
    CandidateKind::Source => head
      .get("transcriptionModel")
      .filter(|model| model.is_object())
      .cloned(),
    CandidateKind::Artifact => head
      .get("fixedModels")
      .and_then(|models| models.get(step_id))
      .filter(|model| model.is_object())
      .cloned(),
  }
}

fn fixed_artifact_id(op: &PersonalOperation, kind: CandidateKind, step_id: &str) -> Option<String> {
  let state = op.st();
  let head = state.head.as_ref();
  let target = head
    .and_then(|head| head.get("outputTarget"))
    .and_then(Value::as_object);
  if kind == CandidateKind::Source {
    // 文字起こしの別案（#19108）は受付で固定した案の置き場。無ければ最初の案（transcript.md）
    if target.and_then(|value| value.get("stepId")).and_then(Value::as_str) == Some(store::SOURCE_STEP_ID) {
      return target
        .and_then(|value| value.get("artifactId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    }
    return Some(store::SOURCE_STEP_ID.to_string());
  }
  head?;
  if target.and_then(|value| value.get("stepId")).and_then(Value::as_str) == Some(step_id) {
    return target
      .and_then(|value| value.get("artifactId"))
      .and_then(Value::as_str)
      .map(str::to_string);
  }
  Some(step_id.to_string())
}

fn short_text(value: &Value) -> bool {
  value
    .as_str()
    .is_some_and(|text| !text.is_empty() && text.len() <= 200 && !text.chars().any(char::is_control))
}

fn stored_json(candidate: &StoredCandidate) -> Value {
  let mut value = json!({
    "stepId": candidate.step_id,
    "artifactId": candidate.artifact_id,
    "kind": kind_name(candidate.kind),
    "versionId": candidate.version_id,
    "path": candidate.path,
    "provider": candidate.provider,
    "model": candidate.model,
    "sha256": candidate.sha256,
    "bytes": candidate.bytes,
    "immutable": true,
  });
  if let Some(reported) = &candidate.reported_model {
    value["reportedModel"] = reported.clone();
  }
  value
}

/// 2.6 の不変候補。その録音のその工程の版の path にだけ、Native が計算し直した SHA/大きさが一致するときに書く。取消・アカウント
/// 切替の後でも、捕捉した元の本人の namespace・Root へ書く（保存先 root の結び付きが変わっていれば書かない）。
pub(crate) fn persist_candidate(state: &AppState, handle: &str, input: CandidateWire) -> CommandResult<Value> {
  let op = operation_for(state, handle)?;
  let _writing = begin_write(&op)?;
  if !op.captured.binding_is_current() {
    return Err(root_changed());
  }
  let kind = candidate_kind(&input.kind)?;
  crate::safe_id(&input.step_id)?;
  crate::safe_id(&input.artifact_id)?;
  if fixed_artifact_id(&op, kind, &input.step_id).as_deref() != Some(input.artifact_id.as_str()) {
    return Err(candidate_mismatch());
  }
  crate::safe_id(&input.version_id)?;
  // 版のファイル名は保管庫の版 ID（`v_` ＋ 22 字）で versionId と同じ（数字だけの旧形式の連番の名前は書かない）
  let canonical_path = format!(
    "recordings/{}/versions/{}/{}.md",
    op.recording_id, input.artifact_id, input.version_id
  );
  if !is_version_id(&input.version_id) || input.path != canonical_path {
    return Err(path_not_allowed());
  }
  if (kind == CandidateKind::Source) != (input.step_id == store::SOURCE_STEP_ID)
    || !step_selectable(&op, &input.step_id)
  {
    return Err(candidate_mismatch());
  }
  if input.text.len() > MAX_CANDIDATE_BYTES {
    return Err(bad_request());
  }
  let sha256 = sha256_hex(input.text.as_bytes());
  if sha256 != input.sha256 || input.text.len() as u64 != input.bytes {
    return Err(candidate_mismatch());
  }
  let fixed = fixed_model(&op, kind, &input.step_id).ok_or_else(intent_not_reserved)?;
  let model_ok = input.model.is_null() || short_text(&input.model);
  let reported_ok = input
    .reported_model
    .as_ref()
    .is_none_or(|reported| reported.is_null() || short_text(reported));
  if fixed.get("provider").and_then(Value::as_str) != Some(input.provider.as_str())
    || fixed.get("model") != Some(&input.model)
    || !model_ok
    || !reported_ok
  {
    return Err(candidate_mismatch());
  }
  let project_id = op.project_id.as_deref();
  let rec = op
    .captured
    .store()
    .personal_recording(project_id, &op.recording_page_id, &op.recording_id)?;
  let _written: CandidateWrite = op
    .captured
    .run(|store| store.personal_write_candidate(&rec, &input.artifact_id, &input.path, input.text.as_bytes()))?;
  let stored = StoredCandidate {
    step_id: input.step_id.clone(),
    artifact_id: input.artifact_id.clone(),
    kind,
    version_id: input.version_id.clone(),
    path: input.path.clone(),
    provider: input.provider,
    model: input.model,
    reported_model: input.reported_model,
    sha256,
    bytes: input.bytes,
  };
  op.st().candidates.insert(stored.version_id.clone(), stored.clone());
  // 結果が返ったので、その工程の dispatch marker を閉じる（書けなければ結果不明のまま残るだけ）
  let step_id = input.step_id;
  let mut still_open = None;
  let _ = update_intent(state, &op, |file| {
    for marker in file.dispatches.iter_mut().filter(|marker| marker.step_id == step_id) {
      marker.terminal = true;
    }
    still_open = Some(file.dispatches.iter().any(|marker| !marker.terminal));
    Ok(())
  });
  if let Some(open) = still_open {
    op.st().dispatch_open = open;
  }
  Ok(stored_json(&stored))
}

/// 集約（PersonalRunHistory）がこの実行のものか。
fn checked_aggregate(op: &PersonalOperation, aggregate: &Value) -> CommandResult<()> {
  let map = aggregate.as_object().ok_or_else(bad_request)?;
  let text = |key: &str| map.get(key).and_then(Value::as_str);
  let size = serde_json::to_vec(aggregate)
    .map(|bytes| bytes.len())
    .unwrap_or(usize::MAX);
  let ok = map.get("schemaVersion").and_then(Value::as_u64) == Some(1)
    && text("runId") == Some(op.run_id.as_str())
    && text("intentId") == Some(op.intent_id.as_str())
    && text("recordingId") == Some(op.recording_id.as_str())
    && text("recordingPageId") == Some(op.recording_page_id.as_str())
    && size <= MAX_AGGREGATE_BYTES;
  ok.then_some(()).ok_or_else(bad_request)
}

/// runs.jsonl の行の、Native が決める欄を消してから付け直す。
const OWNED_RECORD_KEYS: [&str; 14] = [
  "version",
  "versionPath",
  "versionSha256",
  "originDeviceId",
  "personalRunId",
  "origin",
  "provider",
  "model",
  "modelUsed",
  "reportedModel",
  "effort",
  "inputBasisSha256",
  "stepId",
  "result",
];

fn base_record(op: &PersonalOperation, record: Option<Value>) -> CommandResult<Map<String, Value>> {
  let mut map = match record {
    Some(Value::Object(map)) => map,
    Some(Value::Null) | None => Map::new(),
    Some(_) => return Err(bad_request()),
  };
  if serde_json::to_vec(&map).map(|bytes| bytes.len()).unwrap_or(usize::MAX) > MAX_RECORD_BYTES {
    return Err(bad_request());
  }
  let id_ok = map.get("id").is_some_and(short_text);
  if !id_ok {
    map.insert("id".into(), Value::from(format!("run-{}", random_token(16)?)));
  }
  if !map.get("kind").is_some_and(Value::is_string) {
    map.insert("kind".into(), Value::from("run"));
  }
  if !map.get("at").is_some_and(Value::is_string) {
    map.insert("at".into(), Value::from(store::now_iso()));
  }
  if !map.get("stepName").is_some_and(Value::is_string) {
    map.insert("stepName".into(), Value::from(""));
  }
  map.insert("personalRunId".into(), Value::from(op.run_id.clone()));
  map.insert("origin".into(), Value::from("this_pc"));
  map.insert("originDeviceId".into(), Value::from(op.identity.device_id.clone()));
  Ok(map)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishWire {
  intent_id: String,
  step_id: String,
  kind: String,
  candidate_version_id: String,
  artifact_id: String,
  expected_current_sha: Option<String>,
  aggregate: Value,
  record: Option<Value>,
}

/// 2.6 の原子公開。本人・保存先・lease・取消を確かめ、実行中の手編集を版に残してから
/// 現在本文＝AI の結果・runs.jsonl の行・集約を 1 つの保存単位で書く。
pub(crate) async fn publish(state: &AppState, cloud: &Cloud, handle: &str, input: PublishWire) -> CommandResult<Value> {
  let op = operation_for(state, handle)?;
  let _writing = begin_write(&op)?;
  if input.intent_id != op.intent_id {
    return Err(intent_mismatch());
  }
  if op.is_cancelled() || op.captured.ensure_current().is_err() || !lease_alive(cloud, &op).await {
    return Err(guard_failed());
  }
  let kind = candidate_kind(&input.kind)?;
  crate::safe_id(&input.artifact_id)?;
  let candidate = op
    .st()
    .candidates
    .get(&input.candidate_version_id)
    .cloned()
    .filter(|candidate| {
      candidate.step_id == input.step_id && candidate.artifact_id == input.artifact_id && candidate.kind == kind
    })
    .ok_or_else(candidate_missing)?;
  if let Some(expected) = &input.expected_current_sha {
    if !is_sha256(expected) {
      return Err(bad_request());
    }
  }
  checked_aggregate(&op, &input.aggregate)?;
  let (basis, effort) = {
    let bound = op.st();
    let head = bound.head.as_ref().ok_or_else(intent_not_reserved)?;
    let basis = head.get("snapshotSha256").cloned().unwrap_or(Value::Null);
    // 照合値は画面任せにせず、受け付けた固定入力に記録した値（原文は source、工程はその stepId）と同じことを確かめる
    let key = match kind {
      CandidateKind::Source => store::SOURCE_STEP_ID,
      CandidateKind::Artifact => input.step_id.as_str(),
    };
    let recorded = head
      .get("input")
      .and_then(|input| input.get("expectedCurrentArtifactShaByStep"))
      .and_then(|expected| expected.get(key));
    let same = match recorded {
      Some(Value::Null) => input.expected_current_sha.is_none(),
      Some(Value::String(sha)) => input.expected_current_sha.as_deref() == Some(sha.as_str()),
      _ => false,
    };
    if !same {
      return Err(expected_mismatch());
    }
    let model = match kind {
      CandidateKind::Source => head.get("transcriptionModel"),
      CandidateKind::Artifact => head.get("fixedModels").and_then(|models| models.get(&input.step_id)),
    };
    (basis, model.and_then(|model| model.get("effort")).cloned())
  };
  let mut record = base_record(&op, input.record)?;
  for key in OWNED_RECORD_KEYS {
    if !matches!(key, "personalRunId" | "origin" | "originDeviceId") {
      record.remove(key);
    }
  }
  record.insert("result".into(), Value::from("saved"));
  record.insert("provider".into(), Value::from(candidate.provider.clone()));
  record.insert("model".into(), candidate.model.clone());
  if let Some(reported) = &candidate.reported_model {
    record.insert("reportedModel".into(), reported.clone());
    record.insert("modelUsed".into(), reported.clone());
  }
  if let Some(effort) = effort {
    record.insert("effort".into(), effort);
  }
  record.insert("inputBasisSha256".into(), basis);
  if let Some(target) = op
    .st()
    .head
    .as_ref()
    .and_then(|head| head.get("outputTarget"))
    .and_then(Value::as_object)
  {
    if target.get("stepId").and_then(Value::as_str) == Some(input.step_id.as_str()) {
      for key in ["candidateId", "artifactId", "instruction"] {
        if let Some(value) = target.get(key) {
          record.insert(key.into(), value.clone());
        }
      }
    }
  }
  let source = kind == CandidateKind::Source;
  let store_ref = op.captured.store();
  let rec = store_ref.personal_recording(op.project_id.as_deref(), &op.recording_page_id, &op.recording_id)?;
  let current = store_ref.personal_current_file(&rec, &candidate.artifact_id, source)?;
  // 保存を始める直前（lease の確認の await の後）に、取り消し・閉じる・本人や保存先の変化を確かめ直す。ここから保存の終わりまで
  // `.await` を挟まない（send_guard と同じ）
  if op.stop_requested() || op.captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  // 保存口の CAS は保存を始める直前の現在本文に対して行う。実行開始時の SHA との
  // 不一致は拒否せず、personal_publish がその本文を自動の版として同時に残す。
  let mut outcome = None;
  for _ in 0..5 {
    let current_sha = match fs::read(&current) {
      Ok(bytes) => Some(format!("{:x}", Sha256::digest(&bytes))),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
      Err(_) => return Err(StoreError::new("store_io", "本文を読めませんでした。").into()),
    };
    match op.captured.run_expected(&current, current_sha.as_deref(), |store| {
      store.personal_publish(
        &rec,
        PersonalPublish {
          step_id: &candidate.step_id,
          artifact_id: &candidate.artifact_id,
          source,
          candidate_path: &candidate.path,
          candidate_sha256: &candidate.sha256,
          expected_current_sha256: input.expected_current_sha.as_deref(),
          record: Value::Object(record.clone()),
          run_id: &op.run_id,
          aggregate: &input.aggregate,
        },
      )
    }) {
      Err(error) if error.code == "store_stale_document" => continue,
      result => {
        outcome = Some(result?);
        break;
      }
    }
  }
  let outcome = outcome.ok_or_else(|| {
    store::StoreError::new(
      "store_stale_document",
      "本文の保存が続いています。もう一度お試しください。",
    )
  })?;
  match outcome {
    PublishOutcome::Committed { version } => {
      let reference = json!({
        "versionId": candidate.version_id,
        "path": candidate.path,
        "sha256": candidate.sha256,
        "bytes": candidate.bytes,
        "originRunId": op.run_id,
        "origin": "this_pc",
      });
      op.st().receipts.push(Receipt {
        step_id: candidate.step_id.clone(),
        kind,
        version: reference.clone(),
      });
      let receipt = json!({ "stepId": candidate.step_id, "kind": kind_name(kind), "version": reference });
      let _ = update_intent(state, &op, |file| {
        file.receipts.push(receipt);
        Ok(())
      });
      Ok(json!({
        "status": "committed",
        "version": reference,
        "displayVersion": version,
        "localSaved": true,
        "cloudAcked": false,
      }))
    }
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordWire {
  aggregate: Value,
  record: Option<Value>,
  checkpoint: Option<RecordCheckpointWire>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordCheckpointWire {
  run_id: String,
  value: Value,
}

/// 2.6 の CAS を伴わない記録（候補の保持・取消・失敗）。集約と、あれば runs.jsonl の行（数値の版を付けない＝履歴の版に出ない）を
/// 1 つの保存単位で、捕捉した namespace へ書く。
pub(crate) fn record(state: &AppState, handle: &str, input: RecordWire) -> CommandResult<()> {
  let op = operation_for(state, handle)?;
  let _writing = begin_write(&op)?;
  if !op.captured.binding_is_current() {
    return Err(root_changed());
  }
  checked_aggregate(&op, &input.aggregate)?;
  let record = match input.record {
    Some(Value::Null) | None => None,
    Some(record) => {
      let mut map = base_record(&op, Some(record))?;
      map.remove("version");
      Some(Value::Object(map))
    }
  };
  let checkpoint = match input.checkpoint {
    None => None,
    Some(checkpoint) => {
      crate::safe_id(&checkpoint.run_id)?;
      let record_id = record
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|record| record.get("id"))
        .and_then(Value::as_str);
      if record_id != Some(checkpoint.run_id.as_str())
        || checkpoint.value.get("runId").and_then(Value::as_str) != Some(checkpoint.run_id.as_str())
      {
        return Err(bad_request());
      }
      Some((checkpoint.run_id, checkpoint.value))
    }
  };
  let rec =
    op.captured
      .store()
      .personal_recording(op.project_id.as_deref(), &op.recording_page_id, &op.recording_id)?;
  op.captured.run(|store| {
    store.personal_record(
      &rec,
      &op.run_id,
      &input.aggregate,
      record,
      checkpoint.as_ref().map(|(run_id, value)| (run_id.as_str(), value)),
    )
  })?;
  Ok(())
}

// ---------------------------------------------------------------------------
// commands（画面は handle と id だけを渡す。Store・path・token は返さない）

#[tauri::command]
pub async fn personal_open(
  state: State<'_, AppState>,
  cloud: State<'_, Cloud>,
  request: OpenRequestWire,
) -> CommandResult<OpenResult> {
  open(&state, &cloud, request).await
}

#[tauri::command]
pub async fn personal_cancel(state: State<'_, AppState>, handle: String) -> CommandResult<bool> {
  cancel(&state, &handle)
}

#[tauri::command]
pub async fn personal_close(
  state: State<'_, AppState>,
  cloud: State<'_, Cloud>,
  handle: String,
) -> CommandResult<CloseResult> {
  close(&state, &cloud, &handle).await
}

#[tauri::command]
pub async fn personal_guard(
  state: State<'_, AppState>,
  cloud: State<'_, Cloud>,
  handle: String,
  phase: String,
  snapshot: Option<Value>,
) -> CommandResult<GuardResult> {
  guard(&state, &cloud, &handle, &phase, snapshot).await
}

#[tauri::command]
pub async fn personal_reserve_intent(
  state: State<'_, AppState>,
  handle: String,
  intent_id: String,
  snapshot: Value,
) -> CommandResult<ReserveResult> {
  reserve_intent(&state, &handle, &intent_id, &snapshot)
}

#[tauri::command]
pub async fn personal_mark_dispatch(
  state: State<'_, AppState>,
  cloud: State<'_, Cloud>,
  handle: String,
  intent_id: String,
  step_id: String,
) -> CommandResult<()> {
  mark_dispatch(&state, &cloud, &handle, &intent_id, &step_id).await
}

#[tauri::command]
pub async fn personal_mark_intent(
  state: State<'_, AppState>,
  handle: String,
  intent_id: String,
  run_state: String,
) -> CommandResult<()> {
  mark_intent(&state, &handle, &intent_id, &run_state)
}

#[tauri::command]
pub async fn personal_save_private(
  state: State<'_, AppState>,
  handle: String,
  intent_id: String,
  kind: String,
  payload: Value,
) -> CommandResult<()> {
  save_private(&state, &handle, &intent_id, &kind, &payload)
}

#[tauri::command]
pub async fn personal_read_material(
  state: State<'_, AppState>,
  handle: String,
  request: MaterialRequestWire,
) -> CommandResult<Value> {
  read_material(&state, &handle, request.step_ids).await
}

#[tauri::command]
pub async fn personal_swap_models(
  state: State<'_, AppState>,
  handle: String,
  expected_flow: Value,
  models: Value,
) -> CommandResult<bool> {
  swap_models(&state, &handle, expected_flow, models)
}

#[tauri::command]
pub async fn personal_verify_inputs(
  state: State<'_, AppState>,
  handle: String,
  snapshot: Value,
) -> CommandResult<VerifyResult> {
  verify_inputs(&state, &handle, &snapshot)
}

#[tauri::command]
pub async fn personal_persist_candidate(
  state: State<'_, AppState>,
  handle: String,
  candidate: CandidateWire,
) -> CommandResult<Value> {
  persist_candidate(&state, &handle, candidate)
}

#[tauri::command]
pub async fn personal_publish(
  state: State<'_, AppState>,
  cloud: State<'_, Cloud>,
  handle: String,
  input: PublishWire,
) -> CommandResult<Value> {
  publish(&state, &cloud, &handle, input).await
}

#[tauri::command]
pub async fn personal_record(state: State<'_, AppState>, handle: String, input: RecordWire) -> CommandResult<()> {
  record(&state, &handle, input)
}

// 確定した原文から NIHO API への受付（#18740）。intent・operation の部品をそのまま使う子 module。
#[path = "personal_niho.rs"]
pub(crate) mod niho;

#[cfg(test)]
#[path = "personal_run_tests.rs"]
mod tests;
