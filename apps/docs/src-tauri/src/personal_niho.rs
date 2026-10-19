//! 本人 Mac で確定した原文から、修正・インサイトだけを NIHO API へ渡す受付（#18740）。personal_run.rs の子 module
//! （operation・intent の部品をそのまま使う）。
//!
//! - 依頼の本文は、捕捉した Store と同期の状態（VaultState）だけから組む。画面からは intent と受け付けた固定入力の hash だけを
//!   受け取り、controller の `NihoContinuationSubmission` を本文にしない。文字起こしは 0 回（音声は送らない）。
//! - 本文は 1 回だけ bytes にし、その bytes と受付キー（Idempotency-Key）を最初の POST の前に app data へ永続化する
//!   （`<intents>/<intentId>.niho.json`。同期しない）。結果が分からなければ、同じ bytes・同じキーで照会し、明示されたときだけ
//!   再送する（自動では送り直さない）。404 だけでは新しい依頼にしない: クラウドの manifest の版が固定した版を越えた後の再照会で
//!   受け付けられていないことを確かめる（Web の docs-runs-http.ts と同じ手順）。
//! - NIHO の ID token は Native の中だけで使い、送る先はログインしている環境の `/api/me/docs-runs...` だけ（redirect は追わない）。
//!   捕捉した本人・保存先は token の取得の前後と送信の直前に確かめ、違えば送らない。送った後は、本人が切り替わっていても応答を
//!   捕捉した本人の記録に残し、その結果（受付・断られた・結果不明）をそのまま返す（送った依頼を「送っていない」にしない）。
//! - 同じ録音に結果を確かめていない依頼がある・NIHO で実行中の run があるときは、新しい依頼を送らない（二重の課金を防ぐ）。
//!   同じ依頼の送信と確認（照会・再送・証明）はこのアプリの中で 1 つずつ行い、記録の段階は進むだけで戻らない。
//! - 本文・token・指示文はログに出さない（このモジュールは何も書き出さない）。

use super::*;
use crate::cloud::target_for;
use niho_desktop_account::http::{HttpClient, HttpError, HttpMethod, HttpRequest, HttpResponse, ReqwestClient};
use niho_desktop_vault::{VaultError, VaultState};
use std::collections::BTreeSet;
use std::time::Duration;
use url::Url;

/// 受付の dispatch marker の工程（intent の記録の中だけの名前）。
const REMOTE_STEP: &str = "remote";
const RECORD_SUFFIX: &str = ".niho.json";
const MAX_REQUEST_BODY_BYTES: usize = 128 * 1024;
const MAX_NIHO_RECORD_BYTES: u64 = 256 * 1024;
/// 本文に入れる入力のファイル（原文・参考ページ）を読む上限。
const MAX_INPUT_FILE_BYTES: u64 = 16 * 1024 * 1024;
const RESPONSE_MAX_BYTES: usize = 1024 * 1024;
/// 録音の run の一覧（API は 100 件まで）の応答の上限。
const LIST_MAX_BYTES: usize = 4 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_STEPS: usize = 32;
/// 画面へ返す「結果を確かめていない依頼」の数。
const MAX_PENDING: usize = 50;
/// 一覧のために読む記録の数（新しい順）。
const MAX_PENDING_SCAN: usize = 500;
/// intent の置き場所で見る NIHO の記録（`.niho.json`）の数（超えたら一覧は打ち切りを知らせ、同じ録音の確認は送らない側に倒す。
/// ほかのファイルは数えない）。
const MAX_DIR_ENTRIES: usize = 10_000;
/// 実行中の run の状態（me-docs-runs.ts の view）。終わった状態（FINISHED_RUN_STATES）でも実行中でもない値も実行中とみなす。
const ACTIVE_RUN_STATES: [&str; 6] = [
  "queued",
  "running",
  "waiting_runner",
  "waiting_capacity",
  "needs_budget_action",
  "needs_storage_action",
];
const FINISHED_RUN_STATES: [&str; 9] = [
  "completed",
  "transcription_complete",
  "input_changed",
  "result_unknown",
  "failed",
  "canceled",
  "input_expired",
  "kept_current",
  "adopted",
];
/// 受付の応答の状態（apps/api の me-docs-runs.ts の view。Web の parseRun と同じ集合）。
const PUBLIC_STATES: [&str; 13] = [
  "queued",
  "waiting_runner",
  "waiting_capacity",
  "running",
  "transcription_complete",
  "completed",
  "needs_budget_action",
  "needs_storage_action",
  "input_changed",
  "result_unknown",
  "failed",
  "canceled",
  "input_expired",
];
const PHASES: [&str; 5] = ["prepared", "sent", "accepted", "rejected", "absent"];

// ---------------------------------------------------------------------------
// 失敗（送信前に止めたものと、送信後のもの〔rejected・result_unknown〕を code で分ける）

fn route_refused() -> CommandError {
  failure(
    "personal_niho_route",
    "この実行は NIHO API に任せる実行ではありません。",
  )
}

fn legacy_recording() -> CommandError {
  failure(
    "personal_niho_legacy_recording",
    "この録音は以前の形式のため、NIHO API には渡せません。この Mac で続けてください。",
  )
}

fn not_synced() -> CommandError {
  failure(
    "personal_niho_not_synced",
    "録音・原文・参考ページの同期が終わっていません。同期が終わってから、もう一度実行してください。",
  )
}

fn source_not_current() -> CommandError {
  failure(
    "personal_niho_source_not_current",
    "今の原文が確定した版と違います。原文を保存して版にしてから、もう一度実行してください。",
  )
}

/// 最初の文字起こし以外を後工程に使う録音（#19108）。クラウドの API は原文を `versions/source/` の版だけで受け付けるので、
/// 選んだ案と違う本文で作らないよう送る前に断る。
fn source_candidate_not_supported() -> CommandError {
  failure(
    "personal_niho_source_candidate",
    "最初の文字起こし以外を後工程に使う録音は、クラウドでは続きを作れません。設定の「残りの工程」を「この Mac」にすると作れます。",
  )
}

fn partial_saved() -> CommandError {
  failure(
    "personal_niho_partial_saved",
    "途中までの工程が保存済みのため、NIHO API には渡せません。この Mac で続けてください。",
  )
}

fn steps_mismatch() -> CommandError {
  failure(
    "personal_niho_steps_mismatch",
    "NIHO API に任せられるのは、この録音の工程を全部まとめて実行するときだけです。",
  )
}

fn input_changed() -> CommandError {
  failure(
    "personal_niho_input_changed",
    "実行を始めた後に録音・工程・参考ページが変わりました。もう一度実行してください。",
  )
}

fn too_large() -> CommandError {
  failure(
    "personal_niho_too_large",
    "工程か参考ページが多すぎるため、NIHO API には渡せません。この Mac で続けてください。",
  )
}

fn not_ready(message: &str) -> CommandError {
  failure("personal_niho_not_ready", message)
}

fn auth_required() -> CommandError {
  failure(
    "personal_niho_auth_required",
    "NIHO アカウントにもう一度ログインしてから実行してください。",
  )
}

/// 停止スイッチ（#18892・spec D-18）: `APP_CONNECT_ENABLED` が OFF の間、API の認証が接続つき token を 401（`details.reason` は
/// `app_connect_disabled`）にする。接続は失効していない一時停止なので、再ログインを求めず、開け直すと次の依頼から戻る。
fn paused() -> CommandError {
  failure(
    "personal_niho_unavailable",
    "NIHO への接続は今、一時停止しています。この Mac で続けられます。再開すると、ログインし直さずに使えます。",
  )
}

fn offline() -> CommandError {
  failure(
    "personal_niho_offline",
    "NIHO に接続できません。接続を確かめてから、もう一度実行してください。",
  )
}

fn unavailable() -> CommandError {
  failure(
    "personal_niho_unavailable",
    "NIHO API の利用条件を確認できませんでした。少し待ってから、もう一度実行してください。",
  )
}

fn niho_io() -> CommandError {
  failure(
    "personal_niho_io",
    "依頼の記録をこの Mac に保存できなかったため、送信しませんでした。",
  )
}

fn prepare_failed() -> CommandError {
  failure("personal_io", "実行を準備できませんでした。")
}

fn result_unknown() -> CommandError {
  failure(
    "personal_niho_result_unknown",
    "NIHO API へ送信しましたが、受付結果を確認できません。自動では送り直しません。",
  )
}

fn result_unknown_before() -> CommandError {
  failure(
    "personal_niho_result_unknown",
    "前回の依頼の受付結果を確認できていません。自動では送り直しません。受付結果を確認してください。",
  )
}

fn rejected(reason: &str) -> CommandError {
  failure("personal_niho_rejected", rejection_message(reason))
}

fn closed() -> CommandError {
  failure(
    "personal_niho_closed",
    "この依頼は受け付けられなかったことを確かめ済みです。新しく実行してください。",
  )
}

fn record_missing() -> CommandError {
  failure("personal_niho_record_missing", "この依頼の記録が見つかりません。")
}

fn pending_exists() -> CommandError {
  failure(
    "personal_niho_pending_exists",
    "前の依頼の受付結果をまだ確かめていません。受付結果を確かめてから、もう一度実行してください。",
  )
}

/// 読めない形の依頼の記録がある。どの録音の依頼か分からないので、新しい依頼を止める（コードは `pending_exists` と同じ。画面は受付結果の確認を促す）。
fn record_unreadable() -> CommandError {
  failure(
    "personal_niho_pending_exists",
    "前の依頼の記録を読めないため、受付結果を確かめられません。記録を確かめるまで NIHO API には頼まず、この Mac で続けてください。",
  )
}

fn run_active() -> CommandError {
  failure(
    "personal_niho_run_active",
    "この録音は NIHO で実行中です。終わってから、もう一度実行してください。",
  )
}

fn recording_busy() -> CommandError {
  failure(
    "personal_niho_recording_busy",
    "この録音は実行中です。終わってから、もう一度確かめてください。",
  )
}

/// 同じ依頼をこのアプリの中で送信中（もう 1 つの呼び出しは結果を確かめられていない扱い。自動では送り直さない）。
fn in_flight() -> CommandError {
  failure(
    "personal_niho_result_unknown",
    "この依頼は送信中です。受付結果を確かめてから、もう一度実行してください。",
  )
}

/// 断られた理由（API の `details.reason`）の利用者向けの言い方（理由の名前そのものは記録にだけ残す）。
fn rejection_message(reason: &str) -> &'static str {
  match reason {
    "input_revision_changed" => {
      "保存先が更新されたため、NIHO API が受け付けませんでした。同期を確かめて、もう一度実行してください。"
    }
    "recording_run_active" => "この録音は NIHO で実行中です。終わってから、新しく実行してください。",
    "api_model_unavailable" => "この録音に固定された AI モデルは NIHO API では使えません。この Mac で続けてください。",
    "flow_snapshot_mismatch"
    | "reference_set_mismatch"
    | "confirmed_transcript_version_required"
    | "recording_page_mismatch"
    | "recording_metadata_mismatch"
    | "recording_path_invalid"
    | "blob_missing"
    | "metadata_hash_mismatch" => {
      "録音・工程・参考ページ・原文が NIHO の記録と一致しないため、受け付けられませんでした。同期を確かめて、もう一度実行してください。"
    }
    "api_budget_exhausted" | "api_budget_unavailable" | "api_price_changed" => {
      "NIHO API の上限に達しているため、受け付けられませんでした。この Mac で続けられます。"
    }
    "rate_limited" | "user_queue_full" | "global_queue_full" => {
      "混み合っているため、受け付けられませんでした。少し待ってから、新しく実行してください。"
    }
    "not_authenticated" => {
      "NIHO アカウントを確かめられなかったため、受け付けられませんでした。もう一度ログインしてから、新しく実行してください。"
    }
    "app_connect_disabled" => {
      "NIHO への接続が一時停止しているため、受け付けられませんでした。この Mac で続けられます。再開したあとに、新しく実行してください。"
    }
    reason if reason.starts_with("api_") || reason == "permission_revoked" => {
      "NIHO API を今は使えないため、受け付けられませんでした。この Mac で続けられます。"
    }
    _ => "NIHO API が依頼を受け付けませんでした。",
  }
}

// ---------------------------------------------------------------------------
// 画面へ返す形（token・本文・path は返さない）

/// 今の受付の条件（GET /api/me/docs-runs/api-access の api の一部。文字列は形を確かめたものだけ）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NihoAccessWire {
  pub(super) available: bool,
  reason_code: Option<String>,
  /// 開示された提供元の名前のまま（`GOOGLE` など。形を確かめた値だけ）。工程の provider への読み替えと、NIHO の AI で工程を
  /// 動かせるかは docs-core の nihoApiProvider（画面）と niho_api_step_provider（ここ）が同じ表で決める。形の違う値は null。
  pub(super) provider: Option<String>,
  pub(super) model: Option<String>,
  pub(super) consent_version: Option<String>,
  max_run_cost_microusd: Option<String>,
  executor_reason_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NihoSubmitWire {
  status: &'static str,
  run_id: String,
  state: String,
  /// run の `reasonCode`（`input_changed` が実行の前か中かを分ける。無ければ null）。
  reason_code: Option<String>,
}

impl NihoSubmitWire {
  fn accepted(run_id: &str, state: &str, reason_code: Option<&str>) -> Self {
    Self {
      status: "accepted",
      run_id: run_id.to_string(),
      state: state.to_string(),
      reason_code: reason_code.map(str::to_string),
    }
  }
}

/// 結果を確かめた結果。`absent_unproven` は「照会では見つからないが、受け付けられていないとはまだ言えない」、`in_flight` は
/// 「このアプリの中で同じ依頼を送信・確認している途中（何もしなかった）」。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum NihoConfirmWire {
  InFlight,
  Accepted {
    #[serde(rename = "runId")]
    run_id: String,
    state: String,
    #[serde(rename = "reasonCode")]
    reason_code: Option<String>,
  },
  Rejected {
    #[serde(rename = "reasonCode")]
    reason_code: Option<String>,
  },
  Absent,
  AbsentUnproven,
  CannotConfirmYet,
  Unknown,
}

/// 結果を確かめられていない依頼（再起動の後に画面が出す）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NihoPendingWire {
  intent_id: String,
  recording_page_id: String,
  recording_id: String,
  /// フォルダの id（フォルダ外は null）。
  project_id: Option<String>,
  phase: String,
  run_id: Option<String>,
  created_at: String,
}

/// 結果を確かめていない依頼の一覧（新しい順）。`truncated` は読む数・返す数の上限で打ち切ったとき true。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NihoPendingListWire {
  items: Vec<NihoPendingWire>,
  truncated: bool,
}

// ---------------------------------------------------------------------------
// 依頼の本文（apps/api の DocsRunRequestSchema。キーの順は Web の buildSourceContinuationRequest ＋ containerRef）

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct FileRef {
  path: String,
  sha256: String,
  bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepBody {
  step_key: String,
  kind: &'static str,
  provider: String,
  model: String,
  effort: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ContainerRef {
  Root,
  Folder {
    #[serde(rename = "projectId")]
    project_id: String,
  },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
  base_revision: u64,
  recording_page_id: String,
  recording_id: String,
  project_file: FileRef,
  recording_file: FileRef,
  audio: Vec<FileRef>,
  source_version: FileRef,
  references: Vec<FileRef>,
  basis: Vec<FileRef>,
  transcription_executor: Option<String>,
  generation_executor: &'static str,
  consent_version: String,
  steps: Vec<StepBody>,
  container_ref: ContainerRef,
}

// ---------------------------------------------------------------------------
// 依頼の記録（app data の本人 namespace の下。同期しない）

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NihoRecord {
  schema_version: u8,
  intent_id: String,
  submission_key: String,
  /// 送る本文（最初の POST の前に固定した bytes。再送もこの bytes だけ）。
  body: String,
  body_sha256: String,
  base_revision: u64,
  /// フォルダの id（フォルダ外は null）。
  project_id: Option<String>,
  container_ref: Value,
  recording_page_id: String,
  recording_id: String,
  /// `prepared`（固定した）→ `sent`（送信を始める）→ `accepted`・`rejected`、または `absent`（受け付けられていないと確かめた）。
  phase: String,
  run_id: Option<String>,
  state: Option<String>,
  reason_code: Option<String>,
  /// `accepted` の run の `reasonCode`（実行の前に入力が変わった `input_changed_before_execution` など。無ければ None。`reason_code` は
  /// 断られた理由で別物）。この項目が無い古い記録は None として読む。
  run_reason_code: Option<String>,
  created_at: String,
  updated_at: String,
}

enum RecordRead {
  Missing,
  Corrupt,
  Found(Box<NihoRecord>),
}

fn record_relative(identity: &OperationIdentity, intent_id: &str) -> CommandResult<String> {
  crate::safe_id(intent_id)?;
  Ok(format!("{}/{intent_id}{RECORD_SUFFIX}", intents_dir(identity)?))
}

fn is_submission_key(value: &str) -> bool {
  value.strip_prefix("submit_").is_some_and(|hex| {
    hex.len() == 32
      && hex
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
  })
}

fn new_submission_key() -> CommandResult<String> {
  let bytes = crate::process::random_bytes::<16>().map_err(|_| prepare_failed())?;
  Ok(format!("submit_{}", crate::process::hex(&bytes)))
}

fn read_record(root: &Path, relative: &str, intent_id: &str) -> RecordRead {
  let path = root.join(relative);
  match fs::symlink_metadata(&path) {
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return RecordRead::Missing,
    Ok(meta) if meta.is_file() && meta.len() <= MAX_NIHO_RECORD_BYTES => {}
    _ => return RecordRead::Corrupt,
  }
  let Some(record) = fs::read(&path)
    .ok()
    .and_then(|bytes| serde_json::from_slice::<NihoRecord>(&bytes).ok())
  else {
    return RecordRead::Corrupt;
  };
  let valid = record.schema_version == 1
    && record.intent_id == intent_id
    && is_submission_key(&record.submission_key)
    && PHASES.contains(&record.phase.as_str())
    && sha256_hex(record.body.as_bytes()) == record.body_sha256;
  if valid {
    RecordRead::Found(Box::new(record))
  } else {
    RecordRead::Corrupt
  }
}

fn record_bytes(record: &NihoRecord) -> CommandResult<Vec<u8>> {
  let bytes = serde_json::to_vec_pretty(record).map_err(|_| niho_io())?;
  if bytes.len() as u64 > MAX_NIHO_RECORD_BYTES {
    return Err(niho_io());
  }
  Ok(bytes)
}

/// 記録の段階は進むだけ: prepared →（sent・absent〔送っていない〕・accepted〔照会で受付が分かった〕）、sent →（accepted・
/// rejected・absent）。accepted・rejected・absent は最初に決まったまま変えない。
fn may_advance(from: &str, to: &str) -> bool {
  matches!(
    (from, to),
    ("prepared", "sent" | "absent" | "accepted") | ("sent", "accepted" | "rejected" | "absent")
  )
}

/// 記録を次の段階へ進める（INTENT_LOCK の中で読み直してから）。進められない（もう決まっている・戻る）ときは書かずに今の記録を返す。
fn update_record(
  state: &AppState,
  relative: &str,
  intent_id: &str,
  to: &str,
  change: impl FnOnce(&mut NihoRecord),
) -> CommandResult<NihoRecord> {
  let _guard = lock(&INTENT_LOCK);
  let RecordRead::Found(mut record) = read_record(&state.data_dir, relative, intent_id) else {
    return Err(niho_io());
  };
  if !may_advance(&record.phase, to) {
    return Ok(*record);
  }
  record.phase = to.to_string();
  change(&mut record);
  record.updated_at = store::now_iso();
  atomic_write(&state.data_dir, relative, &record_bytes(&record)?).map_err(|_| niho_io())?;
  Ok(*record)
}

/// このアプリの中で送信・確認している途中の依頼（`<accountKey>/<rootId>/<intentId>`）。同じ依頼の送信と確認を 1 つずつにする。
static IN_FLIGHT: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// 途中の印（drop で外す）。
struct InFlight(String);

impl Drop for InFlight {
  fn drop(&mut self) {
    lock(&IN_FLIGHT).remove(&self.0);
  }
}

/// 依頼の送信・確認を始める（同じ依頼が途中なら None）。
fn enter_flight(identity: &OperationIdentity, intent_id: &str) -> Option<InFlight> {
  let key = format!(
    "{}/{}/{intent_id}",
    identity.account_key.as_deref().unwrap_or_default(),
    identity.root_id
  );
  // 印は lock を放してから作る（作れなかった印の drop が同じ lock を取りにいかないように）
  if !lock(&IN_FLIGHT).insert(key.clone()) {
    return None;
  }
  Some(InFlight(key))
}

/// intent の置き場所にある依頼の記録の名前（`.niho.json` だけ・新しく書いた順）。見るファイルが上限を超えたら 2 つ目が true。
fn record_names(root: &Path, dir: &str) -> CommandResult<(Vec<String>, bool)> {
  let full = root.join(dir);
  match fs::symlink_metadata(&full) {
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), false)),
    Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
    _ => return Err(niho_io()),
  }
  let mut names = Vec::new();
  let mut overflow = false;
  for entry in fs::read_dir(&full).map_err(|_| niho_io())? {
    let Ok(entry) = entry else { continue };
    let name = entry.file_name();
    // 記録だけを数える（intent の記録・private の途中記録・一時ファイルは削除されない履歴でも数えない）
    let Some(intent_id) = name.to_str().and_then(|name| name.strip_suffix(RECORD_SUFFIX)) else {
      continue;
    };
    if crate::safe_id(intent_id).is_err() {
      continue;
    }
    if names.len() >= MAX_DIR_ENTRIES {
      overflow = true;
      break;
    }
    let modified = entry
      .metadata()
      .ok()
      .and_then(|meta| meta.modified().ok())
      .unwrap_or(std::time::UNIX_EPOCH);
    names.push((modified, intent_id.to_string()));
  }
  names.sort_by(|left, right| right.cmp(left));
  Ok((names.into_iter().map(|(_, name)| name).collect(), overflow))
}

/// 同じ録音（同じ置き場所のページか録音）の、結果を確かめていない依頼（prepared・sent）が今の本人・保存先の記録にあるか。
/// 見るファイルが多すぎて確かめきれないときも「ある」とみなす（送らない側に倒す）。
fn pending_on_recording(
  state: &AppState,
  identity: &OperationIdentity,
  project_id: Option<&str>,
  recording_page_id: &str,
  recording_id: &str,
  except: &str,
) -> CommandResult<bool> {
  let dir = intents_dir(identity)?;
  let (names, overflow) = record_names(&state.data_dir, &dir)?;
  if overflow {
    return Ok(true);
  }
  for intent_id in names.iter().filter(|name| name.as_str() != except) {
    let relative = format!("{dir}/{intent_id}{RECORD_SUFFIX}");
    match read_record(&state.data_dir, &relative, intent_id) {
      RecordRead::Found(record) => {
        if matches!(record.phase.as_str(), "prepared" | "sent")
          && record.project_id.as_deref() == project_id
          && (record.recording_page_id == recording_page_id || record.recording_id == recording_id)
        {
          return Ok(true);
        }
      }
      // 壊れた・読めない形の記録は、どの録音の未確定の依頼か分からない。無視して新しい依頼を作ると、元の受付がサーバーで
      // 成立していても二重に頼みうるので、新しい依頼を止める
      RecordRead::Corrupt => return Err(record_unreadable()),
      RecordRead::Missing => {}
    }
  }
  Ok(false)
}

/// 同じ置き場所の同じ録音（ページか録音）で、このアプリの本人 Mac 実行が開いている（再送すると二重に実行しうる）。
fn recording_busy_here(state: &AppState, identity: &OperationIdentity, record: &NihoRecord) -> bool {
  lock(&state.personal_ops).values().any(|op| {
    !op.is_closed()
      && op.identity.account_key == identity.account_key
      && op.identity.root_id == identity.root_id
      && op.project_id == record.project_id
      && (op.recording_page_id == record.recording_page_id || op.recording_id == record.recording_id)
  })
}

/// intent の記録（personal_run.rs の IntentFile）を、受付の結果を確かめた状態にする（marker を閉じる）。
fn settle_intent(state: &AppState, identity: &OperationIdentity, intent_id: &str, run_state: &str) {
  let Ok(dir) = intents_dir(identity) else {
    return;
  };
  let relative = format!("{dir}/{intent_id}.json");
  let _guard = lock(&INTENT_LOCK);
  if let IntentRead::Found(mut file) = read_intent(&state.data_dir, &relative) {
    file.state = run_state.to_string();
    for marker in &mut file.dispatches {
      marker.terminal = true;
    }
    file.updated_at = store::now_iso();
    let _ = write_intent(&state.data_dir, &relative, &file);
  }
}

/// 外部への受付の直前の dispatch marker（personal_run.rs の mark_dispatch と同じ意味。工程は `remote`）。
fn open_remote_dispatch(state: &AppState, op: &PersonalOperation) -> CommandResult<()> {
  update_intent(state, op, |file| {
    if file.state != "reserved" && file.state != "running" {
      return Err(intent_closed());
    }
    file.state = "running".into();
    file.dispatches.push(DispatchMarker {
      step_id: REMOTE_STEP.into(),
      at: store::now_iso(),
      terminal: false,
    });
    Ok(())
  })?;
  op.st().dispatch_open = true;
  Ok(())
}

/// 送る前に止めた: 記録を「受け付けられていない」にし、intent を失敗にして marker を閉じる（この intent ではもう送らない）。
fn abandon_unsent(state: &AppState, op: &PersonalOperation, relative: &str) {
  let _ = update_record(state, relative, &op.intent_id, "absent", |record| {
    record.reason_code = Some("not_sent".into());
  });
  settle_intent(state, &op.identity, &op.intent_id, "failed");
  op.st().dispatch_open = false;
}

/// 結果の分かった記録に、intent の記録を合わせる（何度呼んでも同じ。書けなくても結果は変えない）。
fn settle_intent_for(state: &AppState, identity: &OperationIdentity, record: &NihoRecord) {
  match record.phase.as_str() {
    "accepted" => settle_intent(state, identity, &record.intent_id, "submitted"),
    "rejected" | "absent" => settle_intent(state, identity, &record.intent_id, "failed"),
    _ => {}
  }
}

/// 既にある記録の結果（同じ intent の 2 回目は送らない）。
fn existing_outcome(record: &NihoRecord) -> CommandResult<NihoSubmitWire> {
  match record.phase.as_str() {
    "accepted" => match (&record.run_id, &record.state) {
      (Some(run_id), Some(state)) => Ok(NihoSubmitWire::accepted(
        run_id,
        state,
        record.run_reason_code.as_deref(),
      )),
      _ => Err(result_unknown_before()),
    },
    "rejected" => Err(rejected(record.reason_code.as_deref().unwrap_or_default())),
    "absent" => Err(closed()),
    _ => Err(result_unknown_before()),
  }
}

/// 結果を確かめた記録（accepted・rejected・absent）はそのまま返す。
fn settled_view(record: &NihoRecord) -> Option<NihoConfirmWire> {
  match record.phase.as_str() {
    "accepted" => match (&record.run_id, &record.state) {
      (Some(run_id), Some(state)) => Some(NihoConfirmWire::Accepted {
        run_id: run_id.clone(),
        state: state.clone(),
        reason_code: record.run_reason_code.clone(),
      }),
      _ => None,
    },
    "rejected" => Some(NihoConfirmWire::Rejected {
      reason_code: record.reason_code.clone(),
    }),
    "absent" => Some(NihoConfirmWire::Absent),
    _ => None,
  }
}

// ---------------------------------------------------------------------------
// 文字列の形

fn is_run_id(value: &str) -> bool {
  let bytes = value.as_bytes();
  (8..=128).contains(&bytes.len())
    && bytes[0].is_ascii_alphanumeric()
    && bytes
      .iter()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    // 本人 Mac の記録の id（`r6-…`）は NIHO の受付の id として受け取らない
    && !value.starts_with("r6-")
}

fn is_code(value: &str) -> bool {
  (1..=64).contains(&value.len())
    && value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn is_reason(value: &str) -> bool {
  (1..=64).contains(&value.len())
    && value
      .bytes()
      .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn is_model(value: &str) -> bool {
  (1..=100).contains(&value.len())
    && value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'/' | b'-'))
}

fn is_digits(value: &str) -> bool {
  (1..=20).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// API が原文の版として受け付ける path（`recordings/<id>/versions/source/<版>.md`。版は保管庫の版 ID か数字）。
fn is_source_version_path(path: &str, prefix: &str) -> bool {
  path
    .strip_prefix(prefix)
    .and_then(|rest| rest.strip_prefix("versions/source/"))
    .and_then(|name| name.strip_suffix(".md"))
    .is_some_and(|stem| is_version_id(stem) || is_digits(stem))
}

fn is_niho_route(op: &PersonalOperation) -> bool {
  op.route.kind == RouteKind::GenerationOnly && op.route.executor == Some(Executor::NihoApi)
}

// ---------------------------------------------------------------------------
// 同期済みの入力

/// working copy の下のファイル（途中にリンクがあれば読まない）。
fn read_plain_under(base: &Path, relative: &str) -> Option<Vec<u8>> {
  let parts: Vec<&str> = relative.split('/').collect();
  let mut path = base.to_path_buf();
  for (index, part) in parts.iter().enumerate() {
    path.push(part);
    let meta = fs::symlink_metadata(&path).ok()?;
    if meta.file_type().is_symlink() {
      return None;
    }
    let last = index + 1 == parts.len();
    if last && (!meta.is_file() || meta.len() > MAX_INPUT_FILE_BYTES) || !last && !meta.is_dir() {
      return None;
    }
  }
  fs::read(&path).ok()
}

/// 同期済みの入力のファイル: 基準（クラウドと一致した版）にあり、未送信・延ばした受信・競合・止めた path でなく、手元の中身が
/// 基準の SHA-256・大きさと同じ。参照（path・sha256・bytes）と中身を返す。
fn synced_file(vault: &VaultState, working_copy: &Path, path: &str) -> CommandResult<(FileRef, Vec<u8>)> {
  if validate_relative_path(path).is_err() {
    return Err(input_changed());
  }
  let pending = vault.dirty.contains_key(path)
    || vault.deferred_remote.contains_key(path)
    || vault.deferred_deletes.contains(path)
    || vault.conflicts.contains_key(path)
    || vault.blocked.contains_key(path);
  let base = vault
    .base_file(path)
    .filter(|file| file.available)
    .ok_or_else(not_synced)?;
  if pending {
    return Err(not_synced());
  }
  let bytes = read_plain_under(working_copy, path).ok_or_else(not_synced)?;
  if bytes.len() as u64 != base.bytes || sha256_hex(&bytes) != base.sha256 {
    return Err(not_synced());
  }
  Ok((
    FileRef {
      path: path.to_string(),
      sha256: base.sha256.clone(),
      bytes: base.bytes,
    },
    bytes,
  ))
}

fn text_field(value: &Value, key: &str) -> Option<String> {
  value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// 捕捉した Store・同期の状態と、受け付けた固定入力（head）から依頼の本文を組む（送る前の検査をすべてここで行う）。
fn prepare(op: &PersonalOperation, head: &Map<String, Value>) -> CommandResult<CreateBody> {
  let store = op.captured.store();
  let project_id = op.project_id.as_deref();
  let rec = store
    .personal_recording(project_id, &op.recording_page_id, &op.recording_id)
    .map_err(|_| input_changed())?;
  let target = target_for(&op.identity.root, &op.lease_project).ok_or_else(input_changed)?;
  let vault = op.captured.vault_state(&op.lease_project).ok_or_else(not_synced)?;
  if !vault.pending_mutations.is_empty() || vault.tombstone.is_some() {
    return Err(not_synced());
  }
  if head.get("baseManifestRevision").and_then(Value::as_u64) != Some(vault.base_revision) {
    return Err(input_changed());
  }
  let synced = |path: &str| synced_file(&vault, &target.working_copy, path);
  // 参考文書の本文は API 側がフォルダ台帳から導出する。送信前に同じ台帳の文書がすべて同期済みか確認し、
  // 手元に届いていない変更やまだ送っていない変更を API が古い本文で処理しないようにする。
  for reference in store
    .personal_references(project_id, &rec)
    .map_err(|_| input_changed())?
  {
    synced(&reference.path)?;
  }
  let prefix = rec.prefix.as_str();
  let (project_file, _) = synced(if project_id.is_some() {
    "project.json"
  } else {
    "pages.json"
  })?;
  let (recording_file, recording_bytes) = synced(&format!("{prefix}recording.json"))?;
  let recording: Value = serde_json::from_slice(&recording_bytes).map_err(|_| input_changed())?;
  if recording.get("id").and_then(Value::as_str) != Some(op.recording_id.as_str()) {
    return Err(input_changed());
  }
  match recording.get("pageId") {
    None | Some(Value::Null) => return Err(legacy_recording()),
    Some(Value::String(page)) if *page == op.recording_page_id => {}
    Some(_) => return Err(input_changed()),
  }
  if crate::store::selected_source_artifact(&recording).map_err(|_| input_changed())? != crate::store::SOURCE_STEP_ID {
    return Err(source_candidate_not_supported());
  }
  let flow = recording
    .get("flowSnapshot")
    .and_then(Value::as_object)
    .ok_or_else(input_changed)?;
  let flow_steps = flow
    .get("steps")
    .and_then(Value::as_array)
    .ok_or_else(input_changed)?
    .iter()
    .map(|step| {
      step
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| crate::safe_id(id).is_ok())
        .ok_or_else(input_changed)
    })
    .collect::<CommandResult<Vec<&str>>>()?;
  let models = flow
    .get("models")
    .and_then(Value::as_object)
    .ok_or_else(input_changed)?;
  let input = head
    .get("input")
    .and_then(Value::as_object)
    .ok_or_else(snapshot_invalid)?;

  // 原文: 固定入力の版（本人 Mac で確定）が同期済みで、今の文字起こし（transcript.md）と同じ中身
  let source = input
    .get("sourceVersion")
    .and_then(Value::as_object)
    .ok_or_else(source_not_current)?;
  let source_path = source
    .get("path")
    .and_then(Value::as_str)
    .ok_or_else(source_not_current)?;
  if !is_source_version_path(source_path, prefix) || source.get("origin").and_then(Value::as_str) != Some("this_pc") {
    return Err(source_not_current());
  }
  let (transcript, _) = synced(&format!("{prefix}transcript.md"))?;
  let (source_version, _) = synced(source_path)?;
  let fixed_same = source.get("sha256").and_then(Value::as_str) == Some(source_version.sha256.as_str())
    && source.get("bytes").and_then(Value::as_u64) == Some(source_version.bytes);
  if !fixed_same || transcript.sha256 != source_version.sha256 || transcript.bytes != source_version.bytes {
    return Err(source_not_current());
  }

  // 途中まで保存済みの工程があれば渡さない（API は前工程の本文〔priorArtifacts〕を受け付けない）
  for step in &flow_steps {
    let path = format!("{prefix}artifacts/{step}.md");
    let exists_here = fs::symlink_metadata(target.working_copy.join(&path)).is_ok();
    if exists_here || vault.base_file(&path).is_some() || vault.dirty.contains_key(&path) {
      return Err(partial_saved());
    }
  }

  // 工程: 録音のフローの全部の工程をその順で。固定したモデルが録音のフローのモデルと同じ
  let selected: Vec<&str> = head
    .get("selectedStepIds")
    .and_then(Value::as_array)
    .ok_or_else(snapshot_invalid)?
    .iter()
    .filter_map(Value::as_str)
    .collect();
  if flow_steps.is_empty() || selected != flow_steps {
    return Err(steps_mismatch());
  }
  if flow_steps.len() > MAX_STEPS {
    return Err(too_large());
  }
  let fixed = head
    .get("fixedModels")
    .and_then(Value::as_object)
    .ok_or_else(snapshot_invalid)?;
  let mut steps = Vec::with_capacity(flow_steps.len());
  for (index, step) in flow_steps.iter().enumerate() {
    let model = models.get(*step).ok_or_else(input_changed)?;
    let fixed_model = fixed.get(*step).ok_or_else(input_changed)?;
    let same = ["provider", "model", "effort"]
      .iter()
      .all(|key| text_field(model, key) == text_field(fixed_model, key));
    let (Some(provider), Some(name), Some(effort)) = (
      text_field(model, "provider"),
      text_field(model, "model"),
      text_field(model, "effort"),
    ) else {
      return Err(input_changed());
    };
    let known = ["claude", "gpt", "gemini"].contains(&provider.as_str())
      && is_model(&name)
      && ["low", "medium", "high", "max"].contains(&effort.as_str());
    if !same || !known {
      return Err(input_changed());
    }
    steps.push(StepBody {
      step_key: step.to_string(),
      // 工程の種類はフロー全体での位置で決める（Web の createRemoteRunSteps と同じ）
      kind: if index == 0 { "REVISION" } else { "INSIGHT" },
      provider,
      model: name,
      effort,
    });
  }

  // 参考は API が受付時のフォルダ台帳から導出して固定する。legacy recording.refs や捕捉済み client 値は送らない。
  let references = Vec::new();

  let consent_version = head
    .get("consentVersion")
    .and_then(Value::as_str)
    .filter(|value| is_code(value))
    .ok_or_else(snapshot_invalid)?
    .to_string();
  Ok(CreateBody {
    base_revision: vault.base_revision,
    recording_page_id: op.recording_page_id.clone(),
    recording_id: op.recording_id.clone(),
    project_file,
    recording_file,
    audio: Vec::new(),
    source_version,
    references,
    basis: Vec::new(),
    transcription_executor: None,
    generation_executor: "niho_api",
    consent_version,
    steps,
    container_ref: match project_id {
      Some(project_id) => ContainerRef::Folder {
        project_id: project_id.to_string(),
      },
      None => ContainerRef::Root,
    },
  })
}

// ---------------------------------------------------------------------------
// HTTP（ログインしている環境の /api/me/docs-runs だけ）

fn http_client() -> CommandResult<ReqwestClient> {
  ReqwestClient::new().map_err(|_| offline())
}

fn api_url(captured: &CapturedOperation, path: &str) -> CommandResult<Url> {
  captured.niho_api_url(path).ok_or_else(not_signed_in)
}

fn get_request(url: Url, token: &str) -> HttpRequest {
  HttpRequest::new(HttpMethod::Get, url.to_string())
    .bearer(token)
    .header("accept", "application/json")
    .max_body(RESPONSE_MAX_BYTES)
    .timeout(REQUEST_TIMEOUT)
}

fn post_request(url: Url, token: &str, key: &str, body: &str) -> HttpRequest {
  let mut request = HttpRequest::new(HttpMethod::Post, url.to_string())
    .bearer(token)
    .header("accept", "application/json")
    .header("content-type", "application/json")
    .header("Idempotency-Key", key)
    .max_body(RESPONSE_MAX_BYTES)
    .timeout(REQUEST_TIMEOUT);
  request.body = Some(body.as_bytes().to_vec());
  request
}

/// 捕捉した本人の ID token（取得の前後で本人・保存先を確かめる）。
async fn fenced_token(captured: &CapturedOperation) -> CommandResult<String> {
  if captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  let token = captured.niho_id_token().await;
  if captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  token.map_err(|error| match error {
    // ログインは続いているのに捕捉した口が入れ替わった（保存先・同期の口の作り直し）
    VaultError::AuthRequired if captured.active_owner().is_some() => guard_failed(),
    VaultError::AuthRequired => auth_required(),
    _ => offline(),
  })
}

/// NIHO の AI の提供元（API の開示。大文字・小文字は問わない）→ 工程の provider。NIHO の AI で工程を動かせない提供元は None。
/// docs-core の nihoApiProvider（NIHO_API_STEP_PROVIDERS。工程は Vertex AI の Gemini だけで動く・#18816）と同じ表で、
/// apps/docs/test/personal-niho.test.ts がこのソースと docs-core を照らす。
pub(super) fn niho_api_step_provider(disclosed: &str) -> Option<&'static str> {
  match disclosed.to_ascii_uppercase().as_str() {
    "GOOGLE" => Some("gemini"),
    _ => None,
  }
}

fn parse_access(response: &HttpResponse) -> Option<NihoAccessWire> {
  let value: Value = serde_json::from_slice(&response.body).ok()?;
  let api = value.get("api")?.as_object()?;
  let available = api.get("available")?.as_bool()?;
  let text = |key: &str, check: fn(&str) -> bool| {
    api
      .get(key)
      .and_then(Value::as_str)
      .filter(|value| check(value))
      .map(str::to_string)
  };
  // 提供元は開示された名前のまま画面へ渡す（工程の provider への読み替えは docs-core）。受け付けるのは NIHO の AI で工程を
  // 動かせる提供元だけ
  let provider = text("provider", is_code);
  let model = text("model", is_model);
  let consent_version = text("consentVersion", is_code);
  let step_provider = provider.as_deref().and_then(niho_api_step_provider);
  Some(NihoAccessWire {
    available: available && step_provider.is_some() && model.is_some() && consent_version.is_some(),
    reason_code: text("reasonCode", is_code),
    provider,
    model,
    consent_version,
    max_run_cost_microusd: text("maxRunCostMicrousd", is_digits),
    executor_reason_code: text("executorReasonCode", is_code),
  })
}

async fn fetch_access(
  captured: &CapturedOperation,
  client: &dyn HttpClient,
  planned_calls: u32,
) -> CommandResult<NihoAccessWire> {
  let mut url = api_url(captured, "me/docs-runs/api-access")?;
  url
    .query_pairs_mut()
    .append_pair("plannedCalls", &planned_calls.to_string());
  let token = fenced_token(captured).await?;
  let outcome = client.send(get_request(url, &token)).await;
  if captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  let response = outcome.map_err(|_| offline())?;
  match response.status {
    200..=299 => parse_access(&response).ok_or_else(unavailable),
    401 if connect_paused(&response) => Err(paused()),
    401 => Err(auth_required()),
    _ => Err(unavailable()),
  }
}

/// 今の受付の条件が、この依頼（同意の版・工程のモデル）を受け付けるか。
fn check_access(access: &NihoAccessWire, body: &CreateBody) -> CommandResult<()> {
  if !access.available {
    return Err(not_ready(match access.reason_code.as_deref() {
      Some("BUDGET_EXHAUSTED") => "NIHO API の上限に達しています。この Mac で続けられます。",
      Some("PERMISSION_DENIED") => "NIHO API の利用が許可されていません。この Mac で続けられます。",
      _ => "NIHO API を今は使えません。この Mac で続けられます。",
    }));
  }
  if access.consent_version.as_deref() != Some(body.consent_version.as_str()) {
    return Err(not_ready(
      "NIHO API の利用条件が更新されました。内容を確かめてから、もう一度実行してください。",
    ));
  }
  let step_provider = access.provider.as_deref().and_then(niho_api_step_provider);
  let models_match = step_provider.is_some()
    && body.steps.iter().all(|step| {
      step_provider == Some(step.provider.as_str()) && access.model.as_deref() == Some(step.model.as_str())
    });
  if !models_match {
    return Err(not_ready(
      "この録音に固定された AI モデルが NIHO の AI と違うため、この Mac で続けてください。",
    ));
  }
  Ok(())
}

/// 受付の応答と照らす値（依頼の記録から）。
struct ExpectedRun {
  container_ref: Value,
  recording_page_id: String,
  recording_id: String,
  base_revision: u64,
}

impl ExpectedRun {
  fn of(record: &NihoRecord) -> Self {
    Self {
      container_ref: record.container_ref.clone(),
      recording_page_id: record.recording_page_id.clone(),
      recording_id: record.recording_id.clone(),
      base_revision: record.base_revision,
    }
  }
}

struct RunView {
  run_id: String,
  state: String,
  /// run の `reasonCode`（形が合わないものは捨てる）。
  reason_code: Option<String>,
}

/// 受付の応答（run の view）を厳密に確かめる: id の形（本人 Mac の `r6-` は断る）・公開の状態・保存先・ページ・録音・実行先・版。
fn parse_run(response: &HttpResponse, expected: &ExpectedRun) -> Option<RunView> {
  let value: Value = serde_json::from_slice(&response.body).ok()?;
  let run = value.as_object()?;
  let run_id = run.get("runId")?.as_str()?;
  let state = run.get("state")?.as_str()?;
  // `input_changed` を本人が解決した後（現行を残した・候補を採った）の API の状態。Web の transport と同じく `completed` にそろえる
  let state = match state {
    "kept_current" | "adopted" => "completed",
    other => other,
  };
  let valid = is_run_id(run_id)
    && PUBLIC_STATES.contains(&state)
    && same_json(run.get("containerRef"), &expected.container_ref)
    && run.get("recordingPageId").and_then(Value::as_str) == Some(expected.recording_page_id.as_str())
    && run.get("recordingId").and_then(Value::as_str) == Some(expected.recording_id.as_str())
    && run.get("generationExecutor").and_then(Value::as_str) == Some("niho_api")
    && run.get("transcriptionExecutor").is_some_and(Value::is_null)
    && run.get("baseRevision").and_then(Value::as_u64) == Some(expected.base_revision);
  // 実行の前に入力が変わった（`input_changed_before_execution`）かどうかを受付の通知まで運ぶ
  let reason_code = run
    .get("reasonCode")
    .and_then(Value::as_str)
    .filter(|reason| is_reason(reason))
    .map(str::to_string);
  valid.then(|| RunView {
    run_id: run_id.to_string(),
    state: state.to_string(),
    reason_code,
  })
}

/// API の失敗の本文（`{ error: { code, details: { reason } } }`）の `details.reason`。無い・形が違えば None（error.code では
/// 代えない: 経路の 404 などハンドラに届かなかった失敗と区別できないため）。
fn error_reason(response: &HttpResponse) -> Option<String> {
  let value: Value = serde_json::from_slice(&response.body).ok()?;
  let error = value.get("error")?.as_object()?;
  error.get("code")?.as_str()?;
  let reason = error.get("details")?.get("reason")?.as_str()?;
  Some(if is_reason(reason) {
    reason.to_string()
  } else {
    "unknown".into()
  })
}

/// 401 が停止スイッチ（`app_connect_disabled`）によるものか。ログインのやり直しとは別（接続は失効していない）。
fn connect_paused(response: &HttpResponse) -> bool {
  error_reason(response).as_deref() == Some("app_connect_disabled")
}

enum Settled {
  Accepted(RunView),
  Rejected(String),
  Unknown,
}

/// POST の結果。2xx は応答を確かめられたときだけ受付。401（認証の前で止まる）と 429（流量の制限。ハンドラの前で止まる）、
/// 理由（details.reason）つきの 400・403・404・409・410・413 は断られた。ただし 409 `request_payload_mismatch` はその受付キーの
/// run があるので結果不明。ほか（理由の無い 4xx・通信の失敗・時間切れ・3xx・5xx・壊れた 2xx）は結果不明。
fn settle(outcome: Result<HttpResponse, HttpError>, expected: &ExpectedRun) -> Settled {
  let Ok(response) = outcome else {
    return Settled::Unknown;
  };
  match response.status {
    200..=299 => parse_run(&response, expected)
      .map(Settled::Accepted)
      .unwrap_or(Settled::Unknown),
    401 if connect_paused(&response) => Settled::Rejected("app_connect_disabled".into()),
    401 => Settled::Rejected("not_authenticated".into()),
    429 => Settled::Rejected(error_reason(&response).unwrap_or_else(|| "rate_limited".into())),
    400 | 403 | 404 | 409 | 410 | 413 => match error_reason(&response) {
      Some(reason) if reason == "request_payload_mismatch" => Settled::Unknown,
      Some(reason) => Settled::Rejected(reason),
      None => Settled::Unknown,
    },
    _ => Settled::Unknown,
  }
}

enum Lookup {
  Found(RunView),
  NotFound,
  Unknown,
}

/// 同じ受付キーの照会（GET /api/me/docs-runs/submissions/:key）。
async fn lookup(captured: &CapturedOperation, client: &dyn HttpClient, record: &NihoRecord) -> CommandResult<Lookup> {
  let url = api_url(captured, &format!("me/docs-runs/submissions/{}", record.submission_key))?;
  let token = fenced_token(captured).await?;
  let outcome = client.send(get_request(url, &token)).await;
  if captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  let Ok(response) = outcome else {
    return Ok(Lookup::Unknown);
  };
  Ok(match response.status {
    200..=299 => parse_run(&response, &ExpectedRun::of(record))
      .map(Lookup::Found)
      .unwrap_or(Lookup::Unknown),
    // 受付キーの run が無い（getByRequestId の reject(404, "not_found")）ときだけ。経路の 404 は分からない
    404 if error_reason(&response).as_deref() == Some("not_found") => Lookup::NotFound,
    // 一時停止中は受付の結果を確かめられない（分かるまで結果不明のまま。再ログインは求めない）
    401 if connect_paused(&response) => Lookup::Unknown,
    401 => return Err(auth_required()),
    _ => Lookup::Unknown,
  })
}

/// その録音の NIHO の run を一覧し（GET /api/me/docs-runs?containerKind…）、実行中の run があれば `personal_niho_run_active`。
/// 一覧を確かめられなければ送らない（offline・unavailable）。
async fn ensure_no_active_run(
  captured: &CapturedOperation,
  client: &dyn HttpClient,
  body: &CreateBody,
) -> CommandResult<()> {
  let container = serde_json::to_value(&body.container_ref).map_err(|_| prepare_failed())?;
  ensure_no_active_run_on(
    captured,
    client,
    &container,
    &body.recording_page_id,
    &body.recording_id,
  )
  .await
}

/// `ensure_no_active_run` の本体（初回の受付と、明示の再送の前の両方が使う。container は受付の `containerRef` の形）。
async fn ensure_no_active_run_on(
  captured: &CapturedOperation,
  client: &dyn HttpClient,
  container: &Value,
  recording_page_id: &str,
  recording_id: &str,
) -> CommandResult<()> {
  let mut url = api_url(captured, "me/docs-runs")?;
  {
    let mut query = url.query_pairs_mut();
    match container.get("kind").and_then(Value::as_str) {
      Some("root") => {
        query.append_pair("containerKind", "root");
      }
      Some("folder") => {
        let project_id = container
          .get("projectId")
          .and_then(Value::as_str)
          .ok_or_else(prepare_failed)?;
        query.append_pair("containerKind", "folder");
        query.append_pair("projectId", project_id);
      }
      _ => return Err(prepare_failed()),
    }
    query.append_pair("recordingPageId", recording_page_id);
    query.append_pair("recordingId", recording_id);
  }
  let token = fenced_token(captured).await?;
  let outcome = client.send(get_request(url, &token).max_body(LIST_MAX_BYTES)).await;
  if captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  let response = outcome.map_err(|_| offline())?;
  match response.status {
    200..=299 => {}
    401 if connect_paused(&response) => return Err(paused()),
    401 => return Err(auth_required()),
    _ => return Err(unavailable()),
  }
  let value: Value = serde_json::from_slice(&response.body).map_err(|_| unavailable())?;
  let runs = value.get("runs").and_then(Value::as_array).ok_or_else(unavailable)?;
  let active = runs.iter().any(|run| {
    // サーバーの絞り込みが正。形の違う行・別の録音の行は数えない（Web の listRuns と同じ照合）
    let same = same_json(run.get("containerRef"), container)
      && run.get("recordingPageId").and_then(Value::as_str) == Some(recording_page_id)
      && run.get("recordingId").and_then(Value::as_str) == Some(recording_id);
    let state = run.get("state").and_then(Value::as_str).unwrap_or_default();
    same && (ACTIVE_RUN_STATES.contains(&state) || !FINISHED_RUN_STATES.contains(&state))
  });
  if active {
    return Err(run_active());
  }
  Ok(())
}

/// 本人 Mac 側のどの経路を始める前にも、同じ録音の未確定受付と NIHO 側の実行中 run が無いことを確かめる。
/// 画面へは可否だけを返し、token・URL・本文は返さない。
pub(crate) async fn ensure_idle(state: &AppState, client: &dyn HttpClient, handle: &str) -> CommandResult<()> {
  let op = operation_for(state, handle)?;
  if op.stop_requested() || op.captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  if pending_on_recording(
    state,
    &op.identity,
    op.project_id.as_deref(),
    &op.recording_page_id,
    &op.recording_id,
    "",
  )? {
    return Err(pending_exists());
  }
  let container_ref = match &op.project_id {
    Some(project_id) => ContainerRef::Folder {
      project_id: project_id.clone(),
    },
    None => ContainerRef::Root,
  };
  let container = serde_json::to_value(&container_ref).map_err(|_| prepare_failed())?;
  ensure_no_active_run_on(
    &op.captured,
    client,
    &container,
    &op.recording_page_id,
    &op.recording_id,
  )
  .await
}

// ---------------------------------------------------------------------------
// access・submit

pub(crate) async fn access(
  state: &AppState,
  client: &dyn HttpClient,
  handle: &str,
  planned_calls: u32,
) -> CommandResult<NihoAccessWire> {
  if !(1..=MAX_STEPS as u32).contains(&planned_calls) {
    return Err(bad_request());
  }
  let op = operation_for(state, handle)?;
  if !is_niho_route(&op)
    && !(op.route.kind == RouteKind::GenerationOnly
      && op.route.executor == Some(Executor::DeviceNihoApi)
      && op.captured.local_device_api_scope().is_some())
  {
    return Err(route_refused());
  }
  if op.stop_requested() || op.captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  fetch_access(&op.captured, client, planned_calls).await
}

/// 受け付けた固定入力から依頼を固定し、最初の POST の前に bytes とキーを永続化してから 1 回だけ送る。送る前に止めたものは
/// 何も送っていない code（`personal_guard_failed`・`personal_niho_*`）、送った後は `accepted`・`personal_niho_rejected`・
/// `personal_niho_result_unknown` だけを返す。
pub(crate) async fn submit(
  state: &AppState,
  cloud: &Cloud,
  client: &dyn HttpClient,
  handle: &str,
  intent_id: &str,
  snapshot_sha256: &str,
) -> CommandResult<NihoSubmitWire> {
  let op = operation_for(state, handle)?;
  if intent_id != op.intent_id {
    return Err(intent_mismatch());
  }
  if !is_niho_route(&op)
    && !(op.route.kind == RouteKind::GenerationOnly
      && op.route.executor == Some(Executor::DeviceNihoApi)
      && op.captured.local_device_api_scope().is_some())
  {
    return Err(route_refused());
  }
  let relative = record_relative(&op.identity, &op.intent_id)?;
  // 同じ依頼の送信・確認がこのアプリの中で途中なら、何もしない
  let Some(_flight) = enter_flight(&op.identity, &op.intent_id) else {
    return Err(in_flight());
  };
  // 同じ intent の 2 回目（二重クリック・応答が届かなかった後）は送らない
  match read_record(&state.data_dir, &relative, &op.intent_id) {
    RecordRead::Missing => {}
    RecordRead::Corrupt => return Err(result_unknown_before()),
    RecordRead::Found(record) => {
      settle_intent_for(state, &op.identity, &record);
      return existing_outcome(&record);
    }
  }
  if op.stop_requested() || op.captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  // 同じ録音に結果を確かめていない依頼がある（新しい intent で二重に頼まない）
  let pending_here = |state: &AppState| {
    pending_on_recording(
      state,
      &op.identity,
      op.project_id.as_deref(),
      &op.recording_page_id,
      &op.recording_id,
      &op.intent_id,
    )
  };
  if pending_here(state)? {
    return Err(pending_exists());
  }
  let head = {
    let bound = op.st();
    match (bound.reserved, bound.head.clone()) {
      (true, Some(head)) => head,
      _ => return Err(intent_not_reserved()),
    }
  };
  if head.get("snapshotSha256").and_then(Value::as_str) != Some(snapshot_sha256) {
    return Err(snapshot_mismatch());
  }
  if op.recording_id == store::ROOT_RECORDING_ID || op.recording_page_id == store::ROOT_RECORDING_ID {
    return Err(legacy_recording());
  }
  let worker = op.clone();
  let body = tauri::async_runtime::spawn_blocking(move || prepare(&worker, &head))
    .await
    .map_err(|_| prepare_failed())??;
  // 今の受付（利用許可・運営予算・同意の版・モデル）と、その録音の NIHO の run（実行中があれば頼まない）
  let access = fetch_access(&op.captured, client, body.steps.len() as u32).await?;
  check_access(&access, &body)?;
  let text = serde_json::to_string(&body).map_err(|_| prepare_failed())?;
  if text.len() > MAX_REQUEST_BODY_BYTES {
    return Err(too_large());
  }
  ensure_no_active_run(&op.captured, client, &body).await?;
  let url = api_url(&op.captured, "me/docs-runs")?;
  let token = fenced_token(&op.captured).await?;

  // 本文の bytes と受付キーを、最初の POST の前に永続化する
  let now = store::now_iso();
  let record = NihoRecord {
    schema_version: 1,
    intent_id: op.intent_id.clone(),
    submission_key: new_submission_key()?,
    body_sha256: sha256_hex(text.as_bytes()),
    body: text,
    base_revision: body.base_revision,
    project_id: op.project_id.clone(),
    container_ref: serde_json::to_value(&body.container_ref).map_err(|_| prepare_failed())?,
    recording_page_id: op.recording_page_id.clone(),
    recording_id: op.recording_id.clone(),
    phase: "prepared".into(),
    run_id: None,
    state: None,
    reason_code: None,
    run_reason_code: None,
    created_at: now.clone(),
    updated_at: now,
  };
  let bytes = record_bytes(&record)?;
  let created = {
    let _guard = lock(&INTENT_LOCK);
    // 同じ録音の確認と記録の作成を同じ lock の中で（その間に別の intent の記録を作らせない）
    if pending_here(state)? {
      return Err(pending_exists());
    }
    create_exclusive(&state.data_dir, &relative, &bytes).map_err(|_| niho_io())?
  };
  if !created {
    return Err(result_unknown_before());
  }
  // 外部への受付の直前の印 → 送信を始める段階（どちらも書けなければ送らない）
  let marked = open_remote_dispatch(state, &op).and_then(|()| {
    let record = update_record(state, &relative, &op.intent_id, "sent", |_| {})?;
    if record.phase == "sent" {
      Ok(())
    } else {
      Err(niho_io())
    }
  });
  if let Err(error) = marked {
    abandon_unsent(state, &op, &relative);
    return Err(error);
  }
  let request = post_request(url, &token, &record.submission_key, &record.body);
  // 送信直前の guard（取消・本人・保存先・lease・marker）。ここから送信の開始まで await を挟まない
  if let Err(error) = send_guard(cloud, &op, SendKind::NihoApi).await {
    abandon_unsent(state, &op, &relative);
    return Err(error);
  }
  let outcome = client.send(request).await;
  // 送った後: 本人が切り替わっていても、応答は捕捉した本人の記録（op.identity の下）に残して結果をそのまま返す。記録・intent を
  // 書けなくても、送った依頼を「送っていない」の code にはしない
  match settle(outcome, &ExpectedRun::of(&record)) {
    Settled::Accepted(view) => {
      let _ = update_record(state, &relative, &op.intent_id, "accepted", |record| {
        record.run_id = Some(view.run_id.clone());
        record.state = Some(view.state.clone());
        record.run_reason_code = view.reason_code.clone();
      });
      settle_intent(state, &op.identity, &op.intent_id, "submitted");
      Ok(NihoSubmitWire::accepted(
        &view.run_id,
        &view.state,
        view.reason_code.as_deref(),
      ))
    }
    Settled::Rejected(reason) => {
      let _ = update_record(state, &relative, &op.intent_id, "rejected", |record| {
        record.reason_code = Some(reason.clone());
      });
      settle_intent(state, &op.identity, &op.intent_id, "failed");
      Err(rejected(&reason))
    }
    Settled::Unknown => Err(result_unknown()),
  }
}

// ---------------------------------------------------------------------------
// confirm・pending（operation なし。今ログインしている本人・保存先の記録だけを読む）

#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
  Lookup,
  Resend,
  Release,
}

/// 今の本人・保存先を捕捉する（ログイン済みで Root がその本人に結び付いているときだけ）。
async fn capture_current(cloud: &Cloud) -> CommandResult<(CapturedOperation, OperationIdentity)> {
  let captured = cloud.capture_operation().await?;
  let identity = captured.identity();
  let owner = captured.active_owner();
  if owner.is_none() || owner.as_deref() != identity.account_key.as_deref() {
    return Err(not_signed_in());
  }
  Ok((captured, identity))
}

fn accept_confirmed(
  state: &AppState,
  identity: &OperationIdentity,
  relative: &str,
  record: &NihoRecord,
  view: RunView,
) -> NihoConfirmWire {
  let stored = update_record(state, relative, &record.intent_id, "accepted", |record| {
    record.run_id = Some(view.run_id.clone());
    record.state = Some(view.state.clone());
    record.reason_code = None;
    record.run_reason_code = view.reason_code.clone();
  });
  // 先に決まっていた結果があれば、それを返す（段階は戻さない）
  if let Ok(stored) = &stored {
    if stored.phase != "accepted" {
      settle_intent_for(state, identity, stored);
      return settled_view(stored).unwrap_or(NihoConfirmWire::Unknown);
    }
  }
  settle_intent(state, identity, &record.intent_id, "submitted");
  NihoConfirmWire::Accepted {
    run_id: view.run_id,
    state: view.state,
    reason_code: view.reason_code,
  }
}

/// 明示の再送: 照会で見つからなかった依頼を、同じ bytes・同じ受付キーでだけ送り直す。
async fn resend(
  state: &AppState,
  captured: &CapturedOperation,
  client: &dyn HttpClient,
  identity: &OperationIdentity,
  relative: &str,
  record: &NihoRecord,
) -> CommandResult<NihoConfirmWire> {
  if sha256_hex(record.body.as_bytes()) != record.body_sha256 {
    return Ok(NihoConfirmWire::Unknown);
  }
  // 照会で見つからなかった間に、別の端末・別の依頼が同じ録音の run を始めていないか（初回の受付と同じ確認。見つかったら送らず、
  // 記録も動かさない）
  ensure_no_active_run_on(
    captured,
    client,
    &record.container_ref,
    &record.recording_page_id,
    &record.recording_id,
  )
  .await?;
  let url = api_url(captured, "me/docs-runs")?;
  let token = fenced_token(captured).await?;
  // 送る直前に記録を lock の中で読み直す: まだ結果の決まっていない（prepared・sent）ときだけ、同じ bytes・同じキーで送る
  let current = {
    let _guard = lock(&INTENT_LOCK);
    let current = match read_record(&state.data_dir, relative, &record.intent_id) {
      RecordRead::Found(current) => *current,
      _ => return Ok(NihoConfirmWire::Unknown),
    };
    if let Some(settled) = settled_view(&current) {
      return Ok(settled);
    }
    if current.phase != "sent" && current.phase != "prepared" {
      return Ok(NihoConfirmWire::Unknown);
    }
    if current.submission_key != record.submission_key || current.body_sha256 != record.body_sha256 {
      return Ok(NihoConfirmWire::Unknown);
    }
    if current.phase == "prepared" {
      let mut sent = current.clone();
      sent.phase = "sent".into();
      sent.updated_at = store::now_iso();
      atomic_write(&state.data_dir, relative, &record_bytes(&sent)?).map_err(|_| niho_io())?;
    }
    current
  };
  // このアプリで同じ録音の本人 Mac 実行が開いている間は送り直さない（ここから送信の開始まで await を挟まない）
  if recording_busy_here(state, identity, &current) {
    return Err(recording_busy());
  }
  if captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  let request = post_request(url, &token, &current.submission_key, &current.body);
  let outcome = client.send(request).await;
  let drifted = captured.ensure_current().is_err();
  let wire = match settle(outcome, &ExpectedRun::of(&current)) {
    Settled::Accepted(view) => accept_confirmed(state, identity, relative, &current, view),
    Settled::Rejected(reason) => {
      let stored = update_record(state, relative, &current.intent_id, "rejected", |record| {
        record.reason_code = Some(reason.clone());
      });
      match stored {
        Ok(stored) if stored.phase != "rejected" => {
          settle_intent_for(state, identity, &stored);
          settled_view(&stored).unwrap_or(NihoConfirmWire::Unknown)
        }
        _ => {
          settle_intent(state, identity, &current.intent_id, "failed");
          NihoConfirmWire::Rejected {
            reason_code: Some(reason),
          }
        }
      }
    }
    Settled::Unknown => NihoConfirmWire::Unknown,
  };
  // 送った後に本人・保存先が変わった: 応答は捕捉した本人の記録に残し、今の画面へは返さない
  if drifted {
    return Err(guard_failed());
  }
  Ok(wire)
}

/// 受け付けられていないことの証明: 照会で見つからず、クラウドの manifest の版が固定した版を越えた（同じ依頼はもう
/// `input_revision_changed` で断られる）後の再照会でも見つからないときだけ `absent`（新しい依頼にしてよい）。
async fn release(
  state: &AppState,
  captured: &CapturedOperation,
  client: &dyn HttpClient,
  identity: &OperationIdentity,
  relative: &str,
  record: &NihoRecord,
) -> CommandResult<NihoConfirmWire> {
  let project = record
    .project_id
    .clone()
    .unwrap_or_else(|| DOCS_ROOT_PROJECT_ID.to_string());
  if captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  let revision = captured.remote_revision(&project).await;
  if captured.ensure_current().is_err() {
    return Err(guard_failed());
  }
  match revision {
    Err(_) => return Ok(NihoConfirmWire::Unknown),
    Ok(revision) if revision <= record.base_revision => return Ok(NihoConfirmWire::CannotConfirmYet),
    Ok(_) => {}
  }
  // 最初の照会と版の読み取りの間に受け付けられたかもしれない。版の fence の後の照会だけが不在を証明する
  match lookup(captured, client, record).await? {
    Lookup::Found(view) => Ok(accept_confirmed(state, identity, relative, record, view)),
    Lookup::Unknown => Ok(NihoConfirmWire::Unknown),
    Lookup::NotFound => {
      let stored = update_record(state, relative, &record.intent_id, "absent", |record| {
        record.reason_code = Some("absent_after_revision".into());
      })?;
      settle_intent_for(state, identity, &stored);
      Ok(settled_view(&stored).unwrap_or(NihoConfirmWire::Unknown))
    }
  }
}

pub(crate) async fn confirm(
  state: &AppState,
  cloud: &Cloud,
  client: &dyn HttpClient,
  intent_id: &str,
  action: &str,
) -> CommandResult<NihoConfirmWire> {
  crate::safe_id(intent_id)?;
  let action = match action {
    "lookup" => Action::Lookup,
    "resend" => Action::Resend,
    "release" => Action::Release,
    _ => return Err(bad_request()),
  };
  let (captured, identity) = capture_current(cloud).await?;
  // 記録は今の本人・保存先の下だけから読む（別の本人の依頼には届かない）
  let relative = record_relative(&identity, intent_id)?;
  // 同じ依頼の送信・確認がこのアプリの中で途中なら、何もしない（段階を戻さない・二重に送らない）
  let Some(_flight) = enter_flight(&identity, intent_id) else {
    return Ok(NihoConfirmWire::InFlight);
  };
  let record = match read_record(&state.data_dir, &relative, intent_id) {
    RecordRead::Missing => return Err(record_missing()),
    RecordRead::Corrupt => return Ok(NihoConfirmWire::Unknown),
    RecordRead::Found(record) => *record,
  };
  if let Some(settled) = settled_view(&record) {
    // 結果の分かった記録に intent の記録を合わせ直す（前の版で result_unknown のまま残った intent も直る）
    settle_intent_for(state, &identity, &record);
    return Ok(settled);
  }
  if action == Action::Resend && recording_busy_here(state, &identity, &record) {
    return Err(recording_busy());
  }
  let found = lookup(&captured, client, &record).await?;
  match (action, found) {
    (_, Lookup::Found(view)) => Ok(accept_confirmed(state, &identity, &relative, &record, view)),
    (_, Lookup::Unknown) => Ok(NihoConfirmWire::Unknown),
    (Action::Lookup, Lookup::NotFound) => Ok(NihoConfirmWire::AbsentUnproven),
    (Action::Resend, Lookup::NotFound) => resend(state, &captured, client, &identity, &relative, &record).await,
    (Action::Release, Lookup::NotFound) => release(state, &captured, client, &identity, &relative, &record).await,
  }
}

/// 結果を確かめていない依頼（prepared・sent）を新しい順に。記録（`.niho.json`）だけを数えてから、新しく書いた順に
/// MAX_PENDING_SCAN 件まで読み、MAX_PENDING 件まで返す。どちらかで打ち切ったら `truncated`。
pub(crate) async fn pending(state: &AppState, cloud: &Cloud) -> CommandResult<NihoPendingListWire> {
  let (_captured, identity) = capture_current(cloud).await?;
  let dir = intents_dir(&identity)?;
  let (names, overflow) = record_names(&state.data_dir, &dir)?;
  let mut truncated = overflow || names.len() > MAX_PENDING_SCAN;
  let mut items = Vec::new();
  for intent_id in names.iter().take(MAX_PENDING_SCAN) {
    let relative = format!("{dir}/{intent_id}{RECORD_SUFFIX}");
    if let RecordRead::Found(record) = read_record(&state.data_dir, &relative, intent_id) {
      if matches!(record.phase.as_str(), "prepared" | "sent") {
        items.push(NihoPendingWire {
          intent_id: record.intent_id,
          recording_page_id: record.recording_page_id,
          recording_id: record.recording_id,
          project_id: record.project_id,
          phase: record.phase,
          run_id: record.run_id,
          created_at: record.created_at,
        });
      }
    }
  }
  items.sort_by(|left, right| {
    right
      .created_at
      .cmp(&left.created_at)
      .then_with(|| right.intent_id.cmp(&left.intent_id))
  });
  if items.len() > MAX_PENDING {
    truncated = true;
    items.truncate(MAX_PENDING);
  }
  Ok(NihoPendingListWire { items, truncated })
}

// ---------------------------------------------------------------------------
// commands（画面は handle・intent・hash だけを渡す。本文・token・path は返さない）

#[tauri::command]
pub async fn personal_niho_ensure_idle(state: State<'_, AppState>, handle: String) -> CommandResult<()> {
  let client = http_client()?;
  ensure_idle(&state, &client, &handle).await
}

#[tauri::command]
pub async fn personal_niho_access(
  state: State<'_, AppState>,
  handle: String,
  planned_calls: u32,
) -> CommandResult<NihoAccessWire> {
  let client = http_client()?;
  access(&state, &client, &handle, planned_calls).await
}

#[tauri::command]
pub async fn personal_niho_submit(
  state: State<'_, AppState>,
  cloud: State<'_, Cloud>,
  handle: String,
  intent_id: String,
  snapshot_sha256: String,
) -> CommandResult<NihoSubmitWire> {
  let client = http_client()?;
  submit(&state, &cloud, &client, &handle, &intent_id, &snapshot_sha256).await
}

#[tauri::command]
pub async fn personal_niho_confirm(
  state: State<'_, AppState>,
  cloud: State<'_, Cloud>,
  intent_id: String,
  action: String,
) -> CommandResult<NihoConfirmWire> {
  let client = http_client()?;
  confirm(&state, &cloud, &client, &intent_id, &action).await
}

#[tauri::command]
pub async fn personal_niho_pending(
  state: State<'_, AppState>,
  cloud: State<'_, Cloud>,
) -> CommandResult<NihoPendingListWire> {
  pending(&state, &cloud).await
}

#[cfg(test)]
#[path = "personal_niho_tests.rs"]
mod tests;
