//! NIHO クラウドの保管庫との結び（C3 #18595。specs/initiatives/niho-docs-cloud.md §7・§8・§9・§11・§15）。
//!
//! - 保存の口（store.rs の `SaveSink`）: 案件・`flows`・本人共通 profile JSON の書き込みを、保存先 root の結び付き先
//!   （本人に結び付いていれば `vault/<accountKey>/`、無ければ `vault/local/<rootId>/`）の `LocalSaver` へ通し、保存の後に
//!   同期を予約する。削除・音声の写し・画像は書いた後に `note_changed` で知らせる。
//! - 同期 engine: 保存先が「NIHO クラウド」・ログイン中（オフラインを含む）・root の結び付き先が同じ本人、の 3 つがそろう
//!   間だけ 1 つ動かす。それ以外は通信しない読み取り用（`LocalProvider`）の engine で、案件の状態と競合を読むだけ。
//! - 起動: device.json と保存先の結び付きを読んで口を入れ、全部の対象の journal を回復してから案件の一覧を返す
//!   （`wait_recovered`）。ログイン状態の変化ごとに engine を合わせ直す。
//! - 画面への event: `cloud://state`・`cloud://project`（案件ごとに 150ms に 1 回まで。送るときの最新）・
//!   `cloud://applied`・`cloud://remote`。

use crate::docs_closing::{
  apply_committed_snapshot, cleanup_applied_close_stages, cleanup_close_stage, disk_free_bytes, mark_close_intent,
  pending_close_intent, receive_snapshot, required_free_bytes, snapshot_applied, verify_snapshot_placement,
  verify_staged_snapshot, ClosingError, HttpSnapshotTransport, SnapshotIdentity,
};
use crate::docs_reopening::{LocalInventory, ReopeningError, ReopeningPreview, FREE_QUOTA_BYTES};
use crate::docs_storage_api::{
  ClosingPreflight, DocsStorageApi, ReopeningAttempt, ReopeningPhase, StorageApiError, StorageMode, StorageState,
  StorageStatusClient,
};
use crate::store::{self, SaveSink, SinkKind, SinkWrite, Store, StoreError};
use crate::{AppState, CommandError, CommandResult};
use async_trait::async_trait;
use niho_desktop_account::{AccountError, AccountService, AccountSessionTicket, AccountState, EnvKind};
use niho_desktop_vault::{
  account_key, archive_account_root, atomic_write, bind_root, is_immutable_version_path, is_private_path,
  is_sync_ignored, load_or_create_device, load_or_default_state, lookup_root, namespace_has_pending, new_version_id,
  root_binding, scan_project_target, validate_project_id, validate_relative_path, version_path_for, ConflictEntry,
  ConflictKind, ConflictSide, Device, EditProtection, FileKind, FlightOptions, IdTokenProvider, LeaseHeldBy,
  LeaseSession, LocalProvider, LocalSaver, ManifestFile, Namespace, NihoEnvironment, NihoProvider, OpenedFileSource,
  ProjectSyncSnapshot, ProjectTarget, ProviderKind, RootBinding, SaveGroup, SaveKind, SaveWrite, ScanLimits,
  SyncEngine, SyncErrorKind, SyncEvent, SyncOptions, SyncReason, SyncStatus, TombstoneChoice, Usage, VaultError,
  VaultProvider, DOCS_ROOT_DIRS, DOCS_ROOT_FILES, DOCS_ROOT_PROJECT_ID, FLOWS_PROJECT_ID, PROFILE_PROJECT_ID,
  TEXT_MAX_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, Weak};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};
use tokio::sync::broadcast;

pub const STATE_EVENT: &str = "cloud://state";
pub const PROJECT_EVENT: &str = "cloud://project";
pub const APPLIED_EVENT: &str = "cloud://applied";
pub const REMOTE_EVENT: &str = "cloud://remote";
/// `cloud://project` を同じ案件で送る間隔の下限。
const PROJECT_EVENT_GAP: Duration = Duration::from_millis(150);
/// 実行の前に lease を待つ上限（通信が遅いときは lease なしで実行する。best effort）。
const LEASE_WAIT: Duration = Duration::from_secs(5);
/// 初回ログインの結び付けを、前に開いていた文書の解放（保存してから閉じる）まで待つ上限。過ぎたら開かずに断る。
const BINDING_WAIT: Duration = if cfg!(test) {
  Duration::from_millis(600)
} else {
  Duration::from_secs(3)
};
const BINDING_POLL: Duration = Duration::from_millis(25);
/// 案件の一覧が journal の回復を待つ上限（回復は続く。保存はそれぞれ先に自分の案件を回復する）。
const RECOVERY_WAIT: Duration = Duration::from_secs(30);
/// この Mac の名前の上限（desktop-account の DEVICE_NAME_MAX_CHARS と同じ）。
const DEVICE_NAME_MAX_CHARS: usize = 80;
const OFFLINE_MESSAGE: &str = "NIHO に接続できません";
const FLOWS_NAME: &str = "工程";
const PROFILE_NAME: &str = "プロフィールと実行先";
const LOCAL_REOPENING_MARKER: &str = "docs-storage-reopening.json";

/// sealed manifest を決めた後に再起動しても、同じ手元データのまま移行を完了させる印。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalReopeningMarker {
  reopening_id: String,
  source_epoch: String,
  target_epoch: String,
  fingerprint: String,
}

impl LocalReopeningMarker {
  fn valid(&self) -> bool {
    !self.reopening_id.is_empty()
      && self.reopening_id.len() <= 128
      && self
        .reopening_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
      && self
        .source_epoch
        .parse::<u64>()
        .is_ok_and(|source| self.target_epoch.parse::<u64>().is_ok_and(|target| target > source))
      && self.fingerprint.len() == 64
      && self
        .fingerprint
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
  }
}

fn read_local_reopening_marker(data_dir: &Path) -> Option<LocalReopeningMarker> {
  let marker: LocalReopeningMarker =
    serde_json::from_slice(&fs::read(data_dir.join(LOCAL_REOPENING_MARKER)).ok()?).ok()?;
  marker.valid().then_some(marker)
}

fn write_local_reopening_marker(data_dir: &Path, marker: &LocalReopeningMarker) -> std::io::Result<()> {
  if !marker.valid() {
    return Err(std::io::Error::new(
      std::io::ErrorKind::InvalidData,
      "invalid reopening marker",
    ));
  }
  let bytes = serde_json::to_vec(marker)
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "marker serialization failed"))?;
  atomic_write(data_dir, LOCAL_REOPENING_MARKER, &bytes)
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "marker write failed"))
}

fn clear_local_reopening_marker(data_dir: &Path) -> std::io::Result<()> {
  match fs::remove_file(data_dir.join(LOCAL_REOPENING_MARKER)) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(error),
  }
}

fn local_reopening_marker_exists(data_dir: &Path) -> bool {
  match fs::symlink_metadata(data_dir.join(LOCAL_REOPENING_MARKER)) {
    Ok(_) => true,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
    Err(_) => true,
  }
}

fn local_reopening_pending(data_dir: &Path, storage: Option<&StorageState>) -> bool {
  if !local_reopening_marker_exists(data_dir) {
    return false;
  }
  if let (Some(marker), Some(storage)) = (read_local_reopening_marker(data_dir), storage) {
    if storage.mode == StorageMode::Cloud && storage.epoch == marker.target_epoch {
      let _ = clear_local_reopening_marker(data_dir);
      return false;
    }
  }
  true
}

fn baseline_marker_requires_abort(
  attempt_created_now: bool,
  marker_exists: bool,
  marker_matches_attempt: bool,
  fingerprint_matches: bool,
) -> bool {
  !((attempt_created_now && !marker_exists)
    || (!attempt_created_now && marker_exists && marker_matches_attempt && fingerprint_matches))
}

// ---------------------------------------------------------------------------
// 画面へ渡す形（camelCase。apps/docs/src/lib/bridge.ts の CloudState ほか）

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloudStatus {
  /// この Mac だけ
  Local,
  /// 同期している
  Active,
  /// ログインが要る
  SignedOut,
  Expired,
  /// 保存先が別の NIHO アカウントに結び付いている
  OtherAccount,
  /// 起動直後（journal の回復の前）
  Starting,
  /// 本人の保存先がまだ選ばれていない
  Unselected,
  /// クラウドを閉じる途中。未送信分を残して同期を止める
  Closing,
  /// 保存先の正を確かめられず、送信を止めている
  StorageUnavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudState {
  /// 保存先・ログイン session・engine をまとめた非秘密の世代。画面は古い event/reply をこの値で捨てる。
  pub context_generation: u64,
  /// 同じ物理 root と owner binding の間だけ安定する、本文 draft の非秘密な scope。
  pub document_scope_id: Option<String>,
  pub provider: ProviderKind,
  pub status: CloudStatus,
  pub device_name: String,
  pub account_name: Option<String>,
  /// 別のアカウントの保存先で、前の本人の未送信が無い（「このアカウントで使う」を出せる）
  pub can_rebind: bool,
  pub migration: Option<CloudMigration>,
  pub message: Option<String>,
  pub storage: Option<StorageState>,
  /// 開発版の明示 local 以外は、LOCAL でもアカウントのログイン規則を保つ。
  pub requires_account: bool,
  /// 途中で再起動した LOCAL→CLOUD の再開処理が残っており、本文を開けない。
  pub reopening_pending: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudMigration {
  pub running: bool,
  pub cancelled: bool,
  pub total: usize,
  pub done: usize,
  pub bytes_total: u64,
  pub bytes_done: u64,
  pub failed: Vec<MigrationFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationFailure {
  pub project_id: String,
  #[serde(default)]
  pub name: String,
  pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProject {
  pub project_id: String,
  pub name: String,
  pub revision: u64,
  pub updated_at: String,
  pub bytes: u64,
  /// この Mac の保存先にもある
  pub local: bool,
  pub lease: Option<RemoteLease>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLease {
  pub device_name: String,
  pub expires_at: String,
  /// この Mac の実行
  pub mine: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedProject {
  pub project_id: String,
  pub name: String,
  pub deleted_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectEvent {
  context_generation: u64,
  project_id: String,
  snapshot: ProjectSyncSnapshot,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppliedEvent {
  context_generation: u64,
  project_id: String,
  paths: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteEvent {
  context_generation: u64,
  projects: Vec<RemoteProject>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatusReply {
  context_generation: u64,
  snapshot: Option<ProjectSyncSnapshot>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProjectsReply {
  context_generation: u64,
  projects: Vec<RemoteProject>,
}

/// 競合の解決の選び方（「このMacの内容を使う」「クラウドの内容を使う」「両方を編集して保存」「残す」「削除する」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResolveChoice {
  Local,
  Remote,
  Merged,
  Keep,
  Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TombstoneChoiceWire {
  Restore,
  MoveAside,
}

// ---------------------------------------------------------------------------
// 決まり（純粋な関数。cloud_tests.rs が確かめる）

/// 保存先・ログイン状態・root の結び付きから決まる同期の形。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Mode {
  Local,
  SignedOut,
  Expired,
  /// root が別の本人（accountKey）に結び付いている
  OtherAccount {
    bound: String,
  },
  /// 「NIHO クラウド」なのに root がまだ結び付いていない（今の本人に結び付ける）
  Unbound {
    account_key: String,
  },
  Active {
    account_key: String,
  },
}

/// engine を動かすのは、保存先が niho・ログイン中かオフライン・root の結び付き先が同じ本人のときだけ（§1.1・§1.2）。
pub(crate) fn decide_mode(provider: ProviderKind, account: &AccountState, binding: &RootBinding, env: &str) -> Mode {
  if provider == ProviderKind::Local {
    return Mode::Local;
  }
  let profile = match account {
    AccountState::SignedIn { profile } | AccountState::Offline { profile } => profile,
    AccountState::Expired { .. } => return Mode::Expired,
    AccountState::SignedOut | AccountState::SigningIn { .. } => return Mode::SignedOut,
  };
  let key = account_key(env, &profile.user_id);
  match &binding.account_key {
    Some(bound) if *bound == key => Mode::Active { account_key: key },
    Some(bound) => Mode::OtherAccount { bound: bound.clone() },
    None => Mode::Unbound { account_key: key },
  }
}

/// ID token の失敗を保管庫の失敗にする（ログアウト・期限切れはログインが要る、ほかは通信できない扱い）。
pub(crate) fn token_error(error: &AccountError) -> VaultError {
  use niho_desktop_account::error::code;
  if error.is(code::SIGNED_OUT) || error.is(code::EXPIRED) {
    VaultError::AuthRequired
  } else {
    VaultError::Offline(error.code.clone())
  }
}

struct ExpectedSessionToken {
  account: Arc<AccountService>,
  ticket: AccountSessionTicket,
  /// settings の best-effort 保存には付けず、保管庫の provider だけを選択中の root/context に束縛する。
  context: Option<ContextFence>,
}

#[derive(Clone)]
struct ContextFence {
  inner: Weak<CloudInner>,
  generation: u64,
  binding: RootBinding,
}

impl ContextFence {
  fn ensure_current(&self) -> Result<(), VaultError> {
    let inner = self.inner.upgrade().ok_or(VaultError::AuthRequired)?;
    let selected = inner.context_generation.load(Ordering::SeqCst) == self.generation;
    let installed = inner
      .context()
      .is_some_and(|context| context.generation == self.generation && context.binding == self.binding);
    let persisted =
      lookup_root(&inner.data_dir, &self.binding.root_id).is_ok_and(|binding| binding.as_ref() == Some(&self.binding));
    (selected && installed && persisted)
      .then_some(())
      .ok_or(VaultError::AuthRequired)
  }
}

#[async_trait]
impl IdTokenProvider for ExpectedSessionToken {
  fn ensure_current(&self) -> Result<(), VaultError> {
    self
      .account
      .is_session_current(&self.ticket)
      .then_some(())
      .ok_or(VaultError::AuthRequired)?;
    if let Some(context) = &self.context {
      context.ensure_current()?;
    }
    Ok(())
  }

  async fn id_token(&self) -> Result<String, VaultError> {
    self.ensure_current()?;
    let token = self
      .account
      .id_token_for(&self.ticket)
      .await
      .map_err(|error| token_error(&error))?;
    self.ensure_current()?;
    Ok(token.expose().to_string())
  }
}

/// 別の Mac が実行中（lease の 409）。
pub(crate) fn lease_held_error(held_by: Option<&LeaseHeldBy>) -> CommandError {
  match held_by
    .map(|held| held.device_name.trim())
    .filter(|name| !name.is_empty())
  {
    Some(name) => CommandError::new(
      "lease_held",
      &format!("別の Mac（{name}）で実行中です。終わってから実行してください。"),
    ),
    None => CommandError::new("lease_held", "別の Mac で実行中です。終わってから実行してください。"),
  }
}

fn env_name(kind: EnvKind) -> &'static str {
  match kind {
    EnvKind::Prod => "prod",
    EnvKind::Stg => "stg",
  }
}

/// 予約の対象（docs-root・工程・あなたについて）か。案件の一覧には出さず、案件の id にも使わない。
pub(crate) fn is_reserved_project(project_id: &str) -> bool {
  matches!(project_id, DOCS_ROOT_PROJECT_ID | FLOWS_PROJECT_ID | PROFILE_PROJECT_ID)
}

/// 取得したクラウドの一覧（`RemoteProject`）に載せる対象か。予約の工程・あなたについては載せない。予約の docs-root だけは、
/// フォルダ外のページの実行の lease を別の Mac が持っているかを画面とロックの取得が知るために載せる（画面は案件の行には出さない）。
fn listed_in_remote(project_id: &str) -> bool {
  !is_reserved_project(project_id) || project_id == DOCS_ROOT_PROJECT_ID
}

/// 案件の対象（`projects/<id>`）。予約の id と、store・保管庫のどちらかで使えない id は None。
fn project_target(root: &Path, project_id: &str) -> Option<ProjectTarget> {
  (!is_reserved_project(project_id)
    && store::validate_id(project_id).is_ok()
    && validate_project_id(project_id).is_ok())
  .then(|| ProjectTarget::new(project_id, root.join("projects").join(project_id)))
}

/// projectId の同期の対象（`docs-root` は narrow なルート、`flows` は `<root>/flows`、`profile` は本人共通 JSON とその版、ほかは案件フォルダ）。
pub(crate) fn target_for(root: &Path, project_id: &str) -> Option<ProjectTarget> {
  match project_id {
    DOCS_ROOT_PROJECT_ID => Some(ProjectTarget::docs_root(root)),
    FLOWS_PROJECT_ID => Some(ProjectTarget::new(FLOWS_PROJECT_ID, root.join("flows"))),
    PROFILE_PROJECT_ID => Some(ProjectTarget::profile(root)),
    _ => project_target(root, project_id),
  }
}

/// store が書く絶対 path（canonical な root の下）の、同期の対象と対象の中の path。対象の外・同期しない path は None。
pub(crate) fn locate(root: &Path, path: &Path) -> Option<(ProjectTarget, String)> {
  let relative = path.strip_prefix(root).ok()?;
  let mut parts = Vec::new();
  for component in relative.components() {
    match component {
      Component::Normal(part) => parts.push(part.to_str()?),
      _ => return None,
    }
  }
  let root_inner = parts.join("/");
  let root_target = ProjectTarget::docs_root(root);
  if validate_relative_path(&root_inner).is_ok()
    && !is_sync_ignored(&root_inner)
    && !is_private_path(&root_inner)
    && root_target.scope.contains(&root_inner)
  {
    return Some((root_target, root_inner));
  }
  let profile_target = ProjectTarget::profile(root);
  if validate_relative_path(&root_inner).is_ok()
    && !is_sync_ignored(&root_inner)
    && !is_private_path(&root_inner)
    && profile_target.scope.contains(&root_inner)
  {
    return Some((profile_target, root_inner));
  }
  let (target, inner) = match parts.as_slice() {
    ["flows", rest @ ..] if !rest.is_empty() => (target_for(root, FLOWS_PROJECT_ID)?, rest.join("/")),
    ["projects", id, rest @ ..] if !rest.is_empty() => (project_target(root, id)?, rest.join("/")),
    _ => return None,
  };
  let syncable = validate_relative_path(&inner).is_ok()
    && !is_sync_ignored(&inner)
    && !is_private_path(&inner)
    && target.scope.contains(&inner);
  syncable.then_some((target, inner))
}

enum ManagedWrite {
  Managed(ProjectTarget, String),
  Unmanaged,
  InvalidManaged,
}

/// store root 内でも settings など private な端末設定は unmanaged のままにする。一方、同期対象の構造に入った
/// path は malformed/out-of-scope でも managed として fail closed にし、平文保存へ落とさない。
fn classify_managed_write(root: &Path, path: &Path) -> ManagedWrite {
  if let Some((target, inner)) = locate(root, path) {
    return ManagedWrite::Managed(target, inner);
  }
  let Ok(relative) = path.strip_prefix(root) else {
    return ManagedWrite::Unmanaged;
  };
  let text = relative.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
  // Folder ordering is a device-local index, separate from each folder's manifest.
  if text.is_empty() || text == "projects/index.json" || is_private_path(&text) {
    return ManagedWrite::Unmanaged;
  }
  let first = text.split('/').next().unwrap_or("");
  if matches!(
    first,
    "projects" | "flows" | "pages" | "recordings" | "assets" | "versions"
  ) || text == "pages.json"
    || text == "about.json"
    || text == "execution.json"
  {
    ManagedWrite::InvalidManaged
  } else {
    ManagedWrite::Unmanaged
  }
}

/// 保存先 root の同期の対象（起動・保存先の切り替えの journal の回復に使う）。案件は project.json が読めなくても回復する。
pub(crate) fn targets_of_root(root: &Path) -> Vec<ProjectTarget> {
  let mut targets = vec![ProjectTarget::docs_root(root)];
  if let Ok(entries) = fs::read_dir(root.join("projects")) {
    let mut ids: Vec<String> = entries
      .filter_map(|entry| entry.ok())
      .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
      .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
      .collect();
    ids.sort();
    targets.extend(ids.iter().filter_map(|id| project_target(root, id)));
  }
  if fs::symlink_metadata(root.join("flows")).is_ok_and(|meta| meta.is_dir()) {
    targets.extend(target_for(root, FLOWS_PROJECT_ID));
  }
  targets.extend(target_for(root, PROFILE_PROJECT_ID));
  targets
}

/// 通信より前に、途中で終わった保存（journal）を全部の対象で片付ける。片付けた対象の数を返す。
pub(crate) fn recover_root(saver: &LocalSaver, root: &Path) -> usize {
  targets_of_root(root)
    .iter()
    .filter(|target| saver.recover(target).is_ok())
    .count()
}

fn save_kind(kind: SinkKind) -> SaveKind {
  match kind {
    SinkKind::Edit => SaveKind::Edit,
    SinkKind::Version => SaveKind::Version,
    SinkKind::Run => SaveKind::Run,
    SinkKind::System => SaveKind::System,
  }
}

fn local_save_failed() -> StoreError {
  StoreError::new("store_io", "このMacに保存できませんでした。")
}

/// 移行の失敗の理由（容量・接続・ログイン・それ以外）。成功なら None。
pub(crate) fn migration_failure(result: &Result<SyncStatus, VaultError>) -> Option<&'static str> {
  const QUOTA: &str = "クラウドの容量が足りません";
  const OFFLINE: &str = "NIHO に接続できません";
  const AUTH: &str = "ログインが必要です";
  const OTHER: &str = "同期できませんでした";
  match result {
    Ok(SyncStatus::Synced { .. })
    | Ok(SyncStatus::Pending { .. })
    | Ok(SyncStatus::Conflicted { .. })
    | Ok(SyncStatus::MovedDeletedProject { .. }) => None,
    Ok(SyncStatus::Partial { quota_paths, .. }) => (!quota_paths.is_empty()).then_some(QUOTA),
    Ok(SyncStatus::Offline) => Some(OFFLINE),
    Ok(SyncStatus::AuthRequired) => Some(AUTH),
    Ok(SyncStatus::Failed { error }) => Some(match error.kind {
      SyncErrorKind::Quota => QUOTA,
      SyncErrorKind::Offline => OFFLINE,
      SyncErrorKind::AuthRequired => AUTH,
      _ => OTHER,
    }),
    Ok(_) => Some(OTHER),
    Err(VaultError::QuotaExceeded { .. }) => Some(QUOTA),
    Err(error) if error.is_offline() => Some(OFFLINE),
    Err(error) if error.is_auth_required() => Some(AUTH),
    Err(_) => Some(OTHER),
  }
}

/// UTF-8 の文書だけを文字列で返す（バイナリ・NUL を含むものは None）。
fn text_of(bytes: Vec<u8>) -> Option<String> {
  String::from_utf8(bytes).ok().filter(|text| !text.contains('\0'))
}

/// この Mac の名前の上書き（制御文字を除き前後の空白を落として 80 字まで。空は None＝Mac の名前に戻す）。
pub(crate) fn device_name_override(value: &str) -> Option<String> {
  let cleaned: String = value.chars().filter(|ch| !ch.is_control()).collect();
  let name: String = cleaned.trim().chars().take(DEVICE_NAME_MAX_CHARS).collect();
  let name = name.trim().to_string();
  (!name.is_empty()).then_some(name)
}

/// project.json の名前（同期の `PUT /projects/:id` の name）。
pub(crate) fn project_name(working_copy: &Path) -> Option<String> {
  let text = fs::read_to_string(working_copy.join("project.json")).ok()?;
  let value: Value = serde_json::from_str(&text).ok()?;
  value
    .get("name")
    .and_then(Value::as_str)
    .map(str::to_string)
    .filter(|name| !name.trim().is_empty())
}

/// フォルダの中のファイルの大きさの合計（リンクは数えない）。移行の bytes に使う。
fn dir_bytes(path: &Path) -> u64 {
  let Ok(meta) = fs::symlink_metadata(path) else {
    return 0;
  };
  if meta.is_file() {
    return meta.len();
  }
  if !meta.is_dir() {
    return 0;
  }
  fs::read_dir(path)
    .map(|entries| {
      entries
        .filter_map(|entry| entry.ok())
        .map(|entry| dir_bytes(&entry.path()))
        .sum()
    })
    .unwrap_or(0)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn bad_id() -> CommandError {
  CommandError::new("bad_id", "依頼の id が正しくありません。")
}

/// 通信の失敗をその操作の失敗にする（接続・ログインはその文言）。
fn vault_command_error(code: &str, fallback: &str, error: &VaultError) -> CommandError {
  if error.is_offline() {
    CommandError::new(code, "NIHO に接続できません。")
  } else if error.is_auth_required() {
    CommandError::new(code, "ログインが必要です。")
  } else {
    CommandError::new(code, fallback)
  }
}

// ---------------------------------------------------------------------------
// 設定（settings.json の `vault` は保存先の command だけが書く）

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn read_settings(data_dir: &Path) -> Option<Value> {
  fs::read_to_string(data_dir.join("settings.json"))
    .ok()
    .and_then(|text| serde_json::from_str(&text).ok())
}

/// 保存先（provider）とこの Mac の名前の上書き。
fn read_vault_settings(data_dir: &Path) -> (ProviderKind, Option<String>) {
  let vault = read_settings(data_dir).and_then(|settings| settings.get("vault").cloned());
  let provider = match vault
    .as_ref()
    .and_then(|vault| vault.get("provider"))
    .and_then(Value::as_str)
  {
    Some("niho") => ProviderKind::Niho,
    _ => ProviderKind::Local,
  };
  let name = vault
    .as_ref()
    .and_then(|vault| vault.get("deviceName"))
    .and_then(Value::as_str)
    .and_then(device_name_override);
  (provider, name)
}

/// settings.json を書く（一時ファイル → fsync → rename）。
fn write_settings_file(data_dir: &Path, settings: &Value) -> CommandResult<()> {
  let failed = || CommandError::new("settings_io", "設定を保存できませんでした。");
  fs::create_dir_all(data_dir).map_err(|_| failed())?;
  let mut text = serde_json::to_string_pretty(settings).map_err(|_| failed())?;
  text.push('\n');
  atomic_write(data_dir, "settings.json", text.as_bytes()).map_err(|_| failed())
}

/// 画面の設定を保存する。`vault`（保存先・この Mac の名前）はディスクのものを保つ（画面からは変えない）。
pub(crate) fn save_window_settings(data_dir: &Path, mut settings: Value) -> CommandResult<()> {
  let _guard = lock(&SETTINGS_LOCK);
  let disk_vault = read_settings(data_dir).and_then(|disk| disk.get("vault").cloned());
  if let Value::Object(map) = &mut settings {
    match disk_vault {
      Some(vault) => {
        map.insert("vault".into(), vault);
      }
      None => {
        map.remove("vault");
      }
    }
  }
  write_settings_file(data_dir, &settings)
}

/// 保存先の command が `vault` を書き換える（ほかの設定は保つ）。
fn update_vault_settings(data_dir: &Path, update: impl FnOnce(&mut Map<String, Value>)) -> CommandResult<()> {
  let _guard = lock(&SETTINGS_LOCK);
  let mut settings = read_settings(data_dir)
    .filter(Value::is_object)
    .unwrap_or_else(|| json!({}));
  if let Value::Object(map) = &mut settings {
    let vault = map.entry("vault").or_insert_with(|| json!({}));
    if !vault.is_object() {
      *vault = json!({});
    }
    if let Value::Object(vault) = vault {
      update(vault);
    }
  }
  write_settings_file(data_dir, &settings)
}

// ---------------------------------------------------------------------------
// 移行（「NIHO クラウド」を選んだ後、手元の案件・flows・about.json を順に同期する）

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationFile {
  root_id: String,
  #[serde(default)]
  done: Vec<String>,
  #[serde(default)]
  failed: Vec<MigrationFailure>,
  #[serde(default)]
  started_at: String,
  #[serde(default)]
  cancelled: bool,
  #[serde(default)]
  total: usize,
  #[serde(default)]
  bytes_total: u64,
  #[serde(default)]
  bytes_done: u64,
}

impl MigrationFile {
  fn unfinished(&self) -> bool {
    !self.cancelled && self.done.len() + self.failed.len() < self.total
  }
}

/// 移行を始めるか: 記録が無い（まだ一度も上げていない）か、途中で終わっている（中断はしていない）とき。
fn migration_should_start(file: Option<&MigrationFile>) -> bool {
  file.map_or(true, MigrationFile::unfinished)
}

fn migration_relative(account_key: &str) -> String {
  format!("vault/{account_key}/migration.json")
}

fn read_migration(data_dir: &Path, account_key: &str) -> Option<MigrationFile> {
  let bytes = fs::read(data_dir.join(migration_relative(account_key))).ok()?;
  serde_json::from_slice(&bytes).ok()
}

fn write_migration(data_dir: &Path, account_key: &str, file: &MigrationFile) {
  if let Ok(bytes) = serde_json::to_vec_pretty(file) {
    let _ = atomic_write(data_dir, &migration_relative(account_key), &bytes);
  }
}

/// 移行の対象（narrow な docs-root、案件は新しく触った順、次に flows、本人共通 profile があれば profile）と名前・bytes。
fn migration_targets(root: &Path) -> Vec<(ProjectTarget, String, u64)> {
  let root_bytes = DOCS_ROOT_FILES
    .iter()
    .chain(DOCS_ROOT_DIRS.iter())
    .map(|path| dir_bytes(&root.join(path)))
    .sum();
  let mut targets = vec![(ProjectTarget::docs_root(root), "文書".to_string(), root_bytes)];
  for entry in Store::new(root.to_path_buf()).list_projects().unwrap_or_default() {
    if let Some(target) = project_target(root, &entry.id) {
      let name = entry
        .project
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
      let bytes = dir_bytes(&target.working_copy);
      targets.push((target, name, bytes));
    }
  }
  if fs::symlink_metadata(root.join("flows")).is_ok_and(|meta| meta.is_dir()) {
    if let Some(target) = target_for(root, FLOWS_PROJECT_ID) {
      let bytes = dir_bytes(&target.working_copy);
      targets.push((target, FLOWS_NAME.to_string(), bytes));
    }
  }
  if root.join("about.json").is_file() || root.join("execution.json").is_file() {
    if let Some(target) = target_for(root, PROFILE_PROJECT_ID) {
      let bytes = dir_bytes(&root.join("about.json")) + dir_bytes(&root.join("execution.json"));
      targets.push((target, PROFILE_NAME.to_string(), bytes));
    }
  }
  targets
}

#[derive(Default)]
struct MigrationRun {
  running: bool,
  cancel: Arc<AtomicBool>,
}

// ---------------------------------------------------------------------------
// 保存先 root の口（保存・読み取り・同期の予約）

/// 今の保存先 root の結び付きと、保存・読み取りの口。結び付き・engine・この Mac の名前が変わるたびに作り直す。
pub(crate) struct Context {
  /// `CloudInner` が発行する単調増加世代。root/account/session/engine の入れ替えを UI と送信境界で識別する。
  generation: u64,
  /// store の root（canonical）。`binding.path` と同じ。
  root: PathBuf,
  binding: RootBinding,
  device: Device,
  /// 同期する engine（`active`）か、通信しない読み取り用（LocalProvider）の engine。
  engine: Arc<SyncEngine>,
  active: bool,
  /// 同期する engine の provider（一覧・使用量・復元・設定）。
  provider: Option<Arc<dyn VaultProvider>>,
  saver: LocalSaver,
  session: Option<AccountSessionTicket>,
}

impl Context {
  /// 通信しない口（この Mac だけ・ログアウト中・別のアカウント）。案件の状態と競合を読める。
  pub(crate) fn reader(
    data_dir: &Path,
    binding: RootBinding,
    device: Device,
    protection: Arc<EditProtection>,
    generation: u64,
  ) -> Self {
    let engine = SyncEngine::new(
      Arc::new(LocalProvider),
      data_dir,
      binding.namespace(),
      binding.root_id.clone(),
      device.clone(),
      protection,
    );
    Self {
      generation,
      root: binding.path.clone(),
      saver: engine.saver(),
      engine,
      active: false,
      provider: None,
      binding,
      device,
      session: None,
    }
  }

  fn schedule(&self, target: &ProjectTarget, reason: SyncReason) {
    if self.active {
      self.engine.schedule(target.clone(), reason);
    }
  }

  fn target(&self, project_id: &str) -> Option<ProjectTarget> {
    target_for(&self.root, project_id)
  }
}

fn document_scope_id(binding: &RootBinding) -> String {
  let identity = format!(
    "{}\n{}\n{}",
    binding.root_id,
    binding.path.display(),
    binding.account_key.as_deref().unwrap_or("local"),
  );
  format!("{:x}", Sha256::digest(identity.as_bytes()))
}

impl SaveSink for Context {
  fn save(&self, writes: &[SinkWrite], kind: SinkKind) -> Option<Result<Option<u64>, StoreError>> {
    let mut target: Option<ProjectTarget> = None;
    let mut group = Vec::with_capacity(writes.len());
    let mut saw_unmanaged = false;
    for write in writes {
      match classify_managed_write(&self.root, write.path()) {
        ManagedWrite::Managed(found, inner) => {
          match &target {
            Some(existing) if existing.project_id != found.project_id => {
              return Some(Err(local_save_failed()));
            }
            Some(_) => {}
            None => target = Some(found),
          }
          group.push(match write {
            SinkWrite::Put(_, bytes) => SaveWrite::Put {
              path: inner,
              bytes: bytes.clone(),
            },
            SinkWrite::Delete(_) => SaveWrite::Delete { path: inner },
          });
        }
        ManagedWrite::InvalidManaged => return Some(Err(local_save_failed())),
        ManagedWrite::Unmanaged => saw_unmanaged = true,
      }
    }
    let target = target?;
    if saw_unmanaged || group.len() != writes.len() {
      return Some(Err(local_save_failed()));
    }
    // journal は対象のフォルダがあることを前提にする（最初の工程の保存の flows/ など）
    if fs::create_dir_all(&target.working_copy).is_err() {
      return Some(Err(local_save_failed()));
    }
    match self.saver.save(
      &target,
      SaveGroup {
        writes: group,
        kind: save_kind(kind),
      },
    ) {
      Ok(receipt) => {
        self.schedule(&target, SyncReason::LocalSave);
        Some(Ok(Some(receipt.generation)))
      }
      Err(_) => Some(Err(local_save_failed())),
    }
  }

  fn changed(&self, paths: &[PathBuf]) {
    let mut by_target: BTreeMap<String, (ProjectTarget, Vec<String>)> = BTreeMap::new();
    for path in paths {
      if let Some((target, inner)) = locate(&self.root, path) {
        by_target
          .entry(target.project_id.clone())
          .or_insert_with(|| (target, Vec::new()))
          .1
          .push(inner);
      }
    }
    for (target, inner) in by_target.into_values() {
      if self.saver.note_changed(&target, &inner).is_ok() {
        self.schedule(&target, SyncReason::LocalSave);
      }
    }
  }
}

impl Context {
  /// capture が固定した現在値と一致するときだけ、固定 namespace の journal へ保存する。
  fn save_expected(
    &self,
    writes: &[SinkWrite],
    kind: SinkKind,
    expected_path: &str,
    expected_sha256: Option<&str>,
  ) -> Result<Option<u64>, StoreError> {
    let mut target: Option<ProjectTarget> = None;
    let mut group = Vec::with_capacity(writes.len());
    for write in writes {
      let ManagedWrite::Managed(found, inner) = classify_managed_write(&self.root, write.path()) else {
        return Err(local_save_failed());
      };
      match &target {
        Some(existing) if existing.project_id != found.project_id => return Err(local_save_failed()),
        Some(_) => {}
        None => target = Some(found),
      }
      group.push(match write {
        SinkWrite::Put(_, bytes) => SaveWrite::Put {
          path: inner,
          bytes: bytes.clone(),
        },
        SinkWrite::Delete(_) => SaveWrite::Delete { path: inner },
      });
    }
    let target = target.ok_or_else(local_save_failed)?;
    if fs::create_dir_all(&target.working_copy).is_err() {
      return Err(local_save_failed());
    }
    match self.saver.save_if_current(
      &target,
      SaveGroup {
        writes: group,
        kind: save_kind(kind),
      },
      expected_path,
      expected_sha256,
    ) {
      Ok(receipt) => Ok(Some(receipt.generation)),
      Err(VaultError::ConflictChanged) => Err(StoreError::new(
        "store_stale_document",
        "開いた後に本文が変わりました。書きかけは残しています。",
      )),
      Err(_) => Err(local_save_failed()),
    }
  }
}

/// store に入れる口。今の Context へ渡し、Context の入れ替え中でも既知の managed path は fail closed にする。
struct CloudSink {
  inner: Weak<CloudInner>,
  managed_roots: Arc<RwLock<Vec<PathBuf>>>,
}

impl SaveSink for CloudSink {
  fn save(&self, writes: &[SinkWrite], kind: SinkKind) -> Option<Result<Option<u64>, StoreError>> {
    if let Some(context) = self.inner.upgrade().and_then(|inner| inner.context()) {
      if let Some(result) = context.save(writes, kind) {
        return Some(result);
      }
    }
    let roots = self
      .managed_roots
      .read()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .clone();
    let managed = roots.iter().any(|root| {
      writes
        .iter()
        .any(|write| !matches!(classify_managed_write(root, write.path()), ManagedWrite::Unmanaged))
    });
    managed.then(|| Err(local_save_failed()))
  }

  fn changed(&self, paths: &[PathBuf]) {
    if let Some(context) = self.inner.upgrade().and_then(|inner| inner.context()) {
      context.changed(paths);
    }
  }
}

#[derive(Default)]
struct OperationState {
  active: usize,
  root_transitioning: bool,
  reconcile_pending: bool,
}

struct OperationLease {
  state: Arc<Mutex<OperationState>>,
  inner: Weak<CloudInner>,
}

/// この Mac が持つ案件の lease。`owner` は本人 Mac 実行（personal_run.rs）が取ったときだけ、その実行の lease ID。
/// 本人 Mac 実行は自分が取ったものだけを返す（ほかの実行・既存の `acquire_run_lock` の lease は返さない）。
struct HeldLease {
  session: LeaseSession,
  owner: Option<String>,
}

struct RootTransitionLease {
  state: Arc<Mutex<OperationState>>,
}

impl Drop for RootTransitionLease {
  fn drop(&mut self) {
    lock(&self.state).root_transitioning = false;
  }
}

impl Drop for OperationLease {
  fn drop(&mut self) {
    let mut state = lock(&self.state);
    state.active = state.active.saturating_sub(1);
    let reconcile = state.active == 0 && state.reconcile_pending;
    if reconcile {
      state.reconcile_pending = false;
    }
    drop(state);
    if reconcile {
      if let Some(inner) = self.inner.upgrade() {
        tauri::async_runtime::spawn(async move {
          inner.reconcile().await;
        });
      }
    }
  }
}

struct ProtectionLease {
  protection: Arc<EditProtection>,
  inner: Weak<CloudInner>,
  binding: RootBinding,
  id: u64,
}

impl Drop for ProtectionLease {
  fn drop(&mut self) {
    if let Some((project_id, _)) = self.protection.release(self.id) {
      if let Some(context) = self
        .inner
        .upgrade()
        .and_then(|inner| inner.current_document_context(&self.binding))
      {
        if let Some(target) = context.target(&project_id) {
          context.schedule(&target, SyncReason::Now);
        }
      }
    }
  }
}

#[derive(Clone)]
enum OpenedDocumentKind {
  Page {
    project_id: Option<String>,
    page_id: String,
  },
  Artifact {
    project_id: Option<String>,
    recording_id: String,
    step_id: String,
    source: bool,
  },
}

struct CapturedDocument {
  context: Arc<Context>,
  target: ProjectTarget,
  path: String,
  expected_sha256: Option<String>,
  kind: OpenedDocumentKind,
  _operation: OperationLease,
  _protection: ProtectionLease,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
  handle: String,
  context_generation: u64,
  scope_id: String,
  markdown: String,
  sha256: Option<String>,
}

/// AI などの長い await の前に固定した Store と namespace。書く瞬間だけ同期 scope を入れる。
pub(crate) struct CapturedOperation {
  store: Store,
  context: Arc<Context>,
  _operation: OperationLease,
}

impl CapturedOperation {
  pub(crate) fn run<T>(
    &self,
    work: impl FnOnce(&Store) -> std::result::Result<T, StoreError>,
  ) -> std::result::Result<T, StoreError> {
    let sink: Arc<dyn SaveSink> = self.context.clone();
    store::with_captured_save_sink(sink, || work(&self.store))
  }

  /// `guarded`（捕捉した Store の root の下の絶対 path）の今の内容の SHA-256 が `expected_sha256`（None は「無い」）のときだけ、
  /// `work` の保存を捕捉した namespace の journal へ 1 つの group で通す。違えば何も書かず `store_stale_document`。
  /// 照合は保管庫の project gate の中で保存と一緒に行う（本人 Mac 実行の原子公開。personal_run.rs）。
  pub(crate) fn run_expected<T>(
    &self,
    guarded: &Path,
    expected_sha256: Option<&str>,
    work: impl FnOnce(&Store) -> std::result::Result<T, StoreError>,
  ) -> std::result::Result<T, StoreError> {
    let (target, path) = locate(&self.context.root, guarded).ok_or_else(local_save_failed)?;
    let sink: Arc<dyn SaveSink> = Arc::new(CapturedDocumentSink {
      context: self.context.clone(),
      path,
      expected_sha256: expected_sha256.map(str::to_string),
    });
    let result = store::with_captured_save_sink(sink, || work(&self.store));
    // 保存の後の同期は、同じ結び付きの今の Context にだけ予約する（save_captured_artifact_version と同じ）
    if result.is_ok() {
      if let Some(current) = self
        .cloud_inner()
        .and_then(|inner| inner.current_document_context(&self.context.binding))
      {
        current.schedule(&target, SyncReason::LocalSave);
      }
    }
    result
  }

  /// 捕捉した Store（保存先 root の実体）。読み取りと、`run`・`run_expected` の中の書き込みに使う。
  pub(crate) fn store(&self) -> &Store {
    &self.store
  }

  /// 捕捉した本人・保存先の識別（画面へ返す・後で照合する値だけ。Context の中身は渡さない）。
  pub(crate) fn identity(&self) -> OperationIdentity {
    let binding = &self.context.binding;
    OperationIdentity {
      account_key: binding.account_key.clone(),
      root_id: binding.root_id.clone(),
      root: self.context.root.clone(),
      context_generation: self.context.generation,
      scope_id: document_scope_id(binding),
      device_id: self.context.device.device_id.clone(),
    }
  }

  fn cloud_inner(&self) -> Option<Arc<CloudInner>> {
    self._operation.inner.upgrade()
  }

  /// 保存先 root の結び付き（root id・本人・path）が、今の Context と永続の結び付きの両方で捕捉時のまま。
  pub(crate) fn binding_is_current(&self) -> bool {
    let Some(inner) = self.cloud_inner() else {
      return false;
    };
    let captured = &self.context.binding;
    let same = |binding: &RootBinding| {
      binding.root_id == captured.root_id
        && binding.account_key == captured.account_key
        && binding.path == captured.path
    };
    let installed = inner.context().is_some_and(|current| same(&current.binding));
    let persisted =
      lookup_root(&inner.data_dir, &captured.root_id).is_ok_and(|binding| binding.as_ref().is_some_and(same));
    installed && persisted
  }

  /// 捕捉時の本人・保存先のままか。結び付き（root id・本人・path）が今の Context と永続の結び付きで同じで、捕捉した Context に
  /// ログインの session があればそれが今も有効で、今ログインしている本人が結び付きの本人と同じ。違えば何が変わったかを返す。
  pub(crate) fn ensure_current(&self) -> std::result::Result<(), OperationDrift> {
    let Some(inner) = self.cloud_inner() else {
      return Err(OperationDrift {
        account: true,
        root: true,
      });
    };
    let mut drift = OperationDrift::default();
    if !self.binding_is_current() {
      drift.root = true;
    }
    let session_current = self.context.session.as_ref().is_none_or(|ticket| {
      inner
        .account
        .as_ref()
        .is_some_and(|account| account.is_session_current(ticket))
    });
    let owner_current = match &self.context.binding.account_key {
      Some(key) => inner.current_account_key().as_deref() == Some(key.as_str()),
      None => true,
    };
    if !session_current || !owner_current {
      drift.account = true;
    }
    if drift == OperationDrift::default() {
      Ok(())
    } else {
      Err(drift)
    }
  }

  /// ログイン済み（オフラインを含む）で、捕捉した Root がその本人に結び付いている（Mode Active）ときの本人の accountKey。
  pub(crate) fn active_owner(&self) -> Option<String> {
    let inner = self.cloud_inner()?;
    match decide_mode(
      inner.provider_kind(),
      &inner.account_state(),
      &self.context.binding,
      &inner.env,
    ) {
      Mode::Active { account_key } if self.context.binding.account_key.as_deref() == Some(account_key.as_str()) => {
        Some(account_key)
      }
      _ => None,
    }
  }

  /// 本人の接続と、API で確認済みの LOCAL 保存先が捕捉した operation に一致するか。
  pub(crate) fn local_device_api_scope(&self) -> Option<String> {
    if self.ensure_current().is_err() || self.cloud_inner()?.observed_storage()?.mode != StorageMode::Local {
      return None;
    }
    self.context.session.as_ref().map(|ticket| ticket.connection_id.clone())
  }

  /// 捕捉した namespace の、その対象（案件・docs-root）の同期の状態（基準の版・未送信の path）。読めなければ None。
  pub(crate) fn vault_state(&self, project_id: &str) -> Option<niho_desktop_vault::VaultState> {
    let inner = self.cloud_inner()?;
    load_or_default_state(
      &inner.data_dir,
      &self.context.binding.namespace(),
      &self.context.binding.root_id,
      project_id,
    )
    .ok()
  }

  /// 捕捉した本人の NIHO の ID token（確定した原文から NIHO API への受付。personal_niho.rs）。保管庫の provider と同じ照合
  /// （ログインの session・context の世代・保存先の結び付き）を取得の前後で行い、違えば Err。token は画面へ渡さない。
  pub(crate) async fn niho_id_token(&self) -> std::result::Result<String, VaultError> {
    let inner = self.cloud_inner().ok_or(VaultError::AuthRequired)?;
    let account = inner.account.clone().ok_or(VaultError::AuthRequired)?;
    let ticket = self.context.session.clone().ok_or(VaultError::AuthRequired)?;
    let token = ExpectedSessionToken {
      account,
      ticket,
      context: Some(ContextFence {
        inner: Arc::downgrade(&inner),
        generation: self.context.generation,
        binding: self.context.binding.clone(),
      }),
    };
    token.id_token().await
  }

  /// ログインしている環境の NIHO の API の URL（`path` は `/api/` の後。任意の host は作らない）。
  pub(crate) fn niho_api_url(&self, path: &str) -> Option<url::Url> {
    let inner = self.cloud_inner()?;
    let account = inner.account.as_ref()?;
    Some(account.env().api_url(path))
  }

  /// 捕捉した同期の口で読む、その対象（案件・docs-root）のクラウドの manifest の版。
  pub(crate) async fn remote_revision(&self, project_id: &str) -> std::result::Result<u64, VaultError> {
    let provider = self.context.provider.clone().ok_or(VaultError::AuthRequired)?;
    let manifest = if project_id == DOCS_ROOT_PROJECT_ID {
      provider.get_root().await?
    } else {
      provider.get_project(project_id).await?
    };
    Ok(manifest.revision)
  }
}

/// 捕捉した Store・namespace の識別（本人 Mac 実行の operation が画面へ返し、後で照合する値）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OperationIdentity {
  pub(crate) account_key: Option<String>,
  pub(crate) root_id: String,
  pub(crate) root: PathBuf,
  pub(crate) context_generation: u64,
  pub(crate) scope_id: String,
  pub(crate) device_id: String,
}

/// 捕捉時から変わったもの（`account` は本人・ログインの session、`root` は保存先 root の結び付き）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct OperationDrift {
  pub(crate) account: bool,
  pub(crate) root: bool,
}

/// 本人 Mac 実行の lease の取り方の結果（personal_run.rs）。既存の `Cloud::acquire_lease` は「別の Mac が持つ」以外を lease なしで
/// 続ける（fail open）が、こちらは区別して返す。
pub(crate) enum OwnedLease {
  /// この呼び出しで取った（`HeldLease::owner` に実行の lease ID を付けた）
  Acquired,
  /// 別の Mac が持つ（クラウドの 409、または最後に読んだ一覧の期限内の lease）
  HeldElsewhere(Option<LeaseHeldBy>),
  /// このアプリのほかの実行が持つ
  AlreadyHeldHere,
  /// engine が無い・通信できない・時間切れ
  Unavailable,
}

struct CapturedDocumentSink {
  context: Arc<Context>,
  path: String,
  expected_sha256: Option<String>,
}

impl SaveSink for CapturedDocumentSink {
  fn save(&self, writes: &[SinkWrite], kind: SinkKind) -> Option<Result<Option<u64>, StoreError>> {
    Some(
      self
        .context
        .save_expected(writes, kind, &self.path, self.expected_sha256.as_deref()),
    )
  }

  fn changed(&self, paths: &[PathBuf]) {
    // capture 用の save は常に `save` で完結する。旧 Context の engine へ schedule しない。
    let _ = paths;
  }
}

/// schedule の flight の直前に、案件名・lease・実行中を渡す。
struct AppFlightOptions {
  inner: Weak<CloudInner>,
}

#[async_trait]
impl FlightOptions for AppFlightOptions {
  async fn options(&self, target: &ProjectTarget) -> SyncOptions {
    match self.inner.upgrade() {
      Some(inner) => inner.flight_options(target).await,
      None => SyncOptions::default(),
    }
  }
}

// ---------------------------------------------------------------------------
// 状態（managed state `Cloud`）

#[derive(Default)]
struct EmitSlot {
  last: Option<Instant>,
  scheduled: bool,
}

struct CloudInner {
  app: Option<tauri::AppHandle>,
  data_dir: PathBuf,
  account: Option<Arc<AccountService>>,
  env: String,
  niho_environment: NihoEnvironment,
  /// 編集中の path（engine を作り直しても残す）。
  protection: Arc<EditProtection>,
  /// device.json の端末（名前は設定の上書きの前）。
  base_device: Device,
  device_name: Mutex<String>,
  /// 現在選択中の context 世代。provider の token adapter は request の直前にも照合する。
  context_generation: AtomicU64,
  next_context_generation: AtomicU64,
  context: RwLock<Option<Arc<Context>>>,
  /// Context の入れ替え中や CloudInner drop 後も、managed path を平文保存へ落とさないための現在 root。
  managed_roots: Arc<RwLock<Vec<PathBuf>>>,
  forwarder: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
  recovered: tokio::sync::watch::Sender<bool>,
  /// engine の作り直し・保存先の切り替えを 1 つずつにする（`.await` をまたぐので tokio の Mutex）。
  reconcile_lock: Arc<tokio::sync::Mutex<()>>,
  /// root の物理 rebind/archive と、捕捉済み Store/編集 handle を排他する。
  operations: Arc<Mutex<OperationState>>,
  opened_documents: Mutex<HashMap<String, Arc<Mutex<CapturedDocument>>>>,
  leases: tokio::sync::Mutex<HashMap<String, HeldLease>>,
  offline: AtomicBool,
  last_account: Mutex<Option<&'static str>>,
  migration: Mutex<MigrationRun>,
  remote: Mutex<Vec<RemoteProject>>,
  emits: Mutex<HashMap<(u64, String), EmitSlot>>,
  /// NIHO クラウドを使ってよい起動か（開発・試験の起動は `NIHO_DOCS_CLOUD=1` のときだけ。本番の保管庫に試験の案件を上げない）。
  cloud_allowed: AtomicBool,
  /// 直近の本人 session で API から確かめたユーザー単位の保存先。未確認なら通信しない。
  storage: Mutex<Option<(AccountSessionTicket, StorageState)>>,
  storage_api: Option<Arc<dyn StorageStatusClient>>,
  reopening_api: Option<DocsStorageApi>,
  /// 既存の通信しない unit fixture は偽 API を使わず、旧 engine 契約を直接検証する。
  storage_gate_enabled: AtomicBool,
  storage_refresh_scheduled: AtomicBool,
  closing_cancel_requested: AtomicBool,
}

/// 開発・試験の起動（`is_dev_launch`）は本番のアカウントを共有するので、明示したときだけ NIHO クラウドと同期する。
pub(crate) fn cloud_allowed(dev: bool, opt_in: Option<&str>) -> bool {
  !dev || opt_in.map(str::trim) == Some("1")
}

/// 開発・試験の起動で NIHO クラウドを選んだとき。
fn dev_cloud_disabled() -> CommandError {
  CommandError::new(
    "vault_dev_disabled",
    "開発版ではクラウドに保存しません。NIHO_DOCS_CLOUD=1 を付けて起動したときだけ使えます。",
  )
}

fn reopening_command_error(error: ReopeningError) -> CommandError {
  match error {
    ReopeningError::Api(StorageApiError::Auth) => CommandError::new("cloud_login_required", "ログインが必要です。"),
    ReopeningError::Api(StorageApiError::Changed | StorageApiError::NotFound) => CommandError::new(
      "docs_storage_changed",
      "保存先の状態が変わりました。もう一度確認してください。",
    ),
    ReopeningError::Api(StorageApiError::Quota) | ReopeningError::Quota => {
      CommandError::new("cloud_quota", "クラウドの容量が足りません。")
    }
    ReopeningError::Api(StorageApiError::Unavailable | StorageApiError::InvalidResponse) => CommandError::new(
      "cloud_unavailable",
      "NIHO に接続できません。移行は途中から再開できます。",
    ),
    ReopeningError::Vault(_) => CommandError::new("store_io", "この Mac の内容を確認できませんでした。"),
    ReopeningError::MissingName => CommandError::new("store_io", "名前を確認できないフォルダがあります。"),
    ReopeningError::Incomplete => CommandError::new("store_io", "移せないファイルがあります。内容を確認してください。"),
    ReopeningError::Changed => {
      CommandError::new("store_changed", "移行中に内容が変わりました。もう一度お試しください。")
    }
  }
}

fn closing_command_error(error: ClosingError) -> CommandError {
  match error {
    ClosingError::Api(StorageApiError::Auth) => CommandError::new("cloud_login_required", "ログインが必要です。"),
    ClosingError::Api(StorageApiError::Changed | StorageApiError::NotFound) => CommandError::new(
      "docs_storage_changed",
      "保存先の状態が変わりました。もう一度確認してください。",
    ),
    ClosingError::InsufficientSpace => CommandError::new("store_full", "この Mac の空き容量が足りません。"),
    ClosingError::Api(StorageApiError::Unavailable | StorageApiError::InvalidResponse) => {
      CommandError::new("cloud_unavailable", "NIHO に接続できません。途中から再開できます。")
    }
    ClosingError::Busy => CommandError::new("store_busy", "別の受信が進んでいます。"),
    ClosingError::Cancelled => CommandError::new("store_cancelled", "受信を中断しました。途中から再開できます。"),
    _ => CommandError::new(
      "store_io",
      "クラウドの全データを照合できません。クラウドは削除していません。",
    ),
  }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosingPreview {
  pub preflight: ClosingPreflight,
  pub required_free_bytes: u64,
  pub available_free_bytes: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedClosing {
  pub closing_id: String,
  pub epoch: String,
  pub manifest_digest: String,
  pub file_count: usize,
  pub expired_audio_count: usize,
  pub deleted_folder_count: usize,
}

#[derive(Clone)]
pub struct Cloud {
  inner: Arc<CloudInner>,
}

impl CloudInner {
  fn new(
    app: Option<tauri::AppHandle>,
    data_dir: &Path,
    account: Option<Arc<AccountService>>,
    env: &str,
    niho_environment: NihoEnvironment,
    device: Device,
  ) -> Self {
    // 保存先は NIHO クラウドだけ（#18728）。settings.json に残る旧い `local` は読まない（名前の上書きだけ使う）。
    let (_, name) = read_vault_settings(data_dir);
    Self {
      app,
      data_dir: data_dir.to_path_buf(),
      account,
      env: env.to_string(),
      niho_environment,
      protection: Arc::new(EditProtection::new()),
      device_name: Mutex::new(name.unwrap_or_else(|| device.device_name.clone())),
      base_device: device,
      context_generation: AtomicU64::new(0),
      next_context_generation: AtomicU64::new(0),
      context: RwLock::new(None),
      managed_roots: Arc::new(RwLock::new(Vec::new())),
      forwarder: Mutex::new(None),
      recovered: tokio::sync::watch::channel(false).0,
      reconcile_lock: Arc::new(tokio::sync::Mutex::new(())),
      operations: Arc::new(Mutex::new(OperationState::default())),
      opened_documents: Mutex::new(HashMap::new()),
      leases: tokio::sync::Mutex::new(HashMap::new()),
      offline: AtomicBool::new(false),
      last_account: Mutex::new(None),
      migration: Mutex::new(MigrationRun::default()),
      remote: Mutex::new(Vec::new()),
      emits: Mutex::new(HashMap::new()),
      cloud_allowed: AtomicBool::new(true),
      storage: Mutex::new(None),
      storage_api: DocsStorageApi::new(niho_environment)
        .ok()
        .map(|api| Arc::new(api) as Arc<dyn StorageStatusClient>),
      reopening_api: DocsStorageApi::new(niho_environment).ok(),
      storage_gate_enabled: AtomicBool::new(!cfg!(test)),
      storage_refresh_scheduled: AtomicBool::new(false),
      closing_cancel_requested: AtomicBool::new(false),
    }
  }

  fn context(&self) -> Option<Arc<Context>> {
    self
      .context
      .read()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .clone()
  }

  fn acquire_operation(self: &Arc<Self>) -> CommandResult<OperationLease> {
    let mut state = lock(&self.operations);
    if state.root_transitioning {
      return Err(CommandError::new(
        "store_context_changed",
        "保存先を切り替えています。終わってから、もう一度お試しください。",
      ));
    }
    state.active = state.active.saturating_add(1);
    Ok(OperationLease {
      state: self.operations.clone(),
      inner: Arc::downgrade(self),
    })
  }

  fn retain_opened_documents_for(&self, binding: &RootBinding) {
    lock(&self.opened_documents).retain(|_, document| lock(document).context.binding == *binding);
  }

  /// 同期している口（engine が動いているときだけ）。
  fn active(&self) -> Option<Arc<Context>> {
    self.context().filter(|context| context.active)
  }

  fn context_is_current(&self, expected: &Arc<Context>) -> bool {
    self.context_generation.load(Ordering::SeqCst) == expected.generation
      && self.context().is_some_and(|current| Arc::ptr_eq(&current, expected))
      && expected.session.as_ref().is_none_or(|ticket| {
        self
          .account
          .as_ref()
          .is_some_and(|account| account.is_session_current(ticket))
      })
      && expected
        .provider
        .as_ref()
        .is_none_or(|provider| provider.check_context().is_ok())
      && lookup_root(&self.data_dir, &expected.binding.root_id)
        .is_ok_and(|binding| binding.as_ref() == Some(&expected.binding))
  }

  /// 本文のローカル保存だけは、session/engine が作り直されても同じ永続 RootBinding なら捕捉済み namespace を使える。
  /// 通信の fence には使わず、保存後の schedule は返した現在 Context にだけ行う。
  fn current_document_context(&self, binding: &RootBinding) -> Option<Arc<Context>> {
    let current = self.context()?;
    if current.binding != *binding
      || lookup_root(&self.data_dir, &binding.root_id).ok().flatten().as_ref() != Some(binding)
    {
      return None;
    }
    Some(current)
  }

  fn next_context_generation(&self) -> u64 {
    self.next_context_generation.fetch_add(1, Ordering::SeqCst) + 1
  }

  /// 長い root 切替処理より先に旧 provider を無効化する。まだ新しい Context は選ばない。
  fn invalidate_context(&self) -> u64 {
    let generation = self.next_context_generation();
    self.context_generation.store(generation, Ordering::SeqCst);
    generation
  }

  fn device(&self) -> Device {
    Device {
      device_id: self.base_device.device_id.clone(),
      device_name: lock(&self.device_name).clone(),
      device_kind: self.base_device.device_kind.clone(),
    }
  }

  /// 本番は本人単位の保存先 status を正とする。開発・試験の起動では保管庫に試験の案件を上げず、
  /// `NIHO_DOCS_CLOUD=1` を付けたときだけクラウドを使う。
  fn provider_kind(&self) -> ProviderKind {
    if !self.cloud_allowed.load(Ordering::SeqCst) {
      return ProviderKind::Local;
    }
    if self
      .observed_storage()
      .is_some_and(|state| state.mode == StorageMode::Local)
    {
      return ProviderKind::Local;
    }
    ProviderKind::Niho
  }

  fn observed_storage(&self) -> Option<StorageState> {
    if !self.storage_gate_enabled.load(Ordering::SeqCst) {
      return Some(StorageState {
        mode: StorageMode::Cloud,
        epoch: "0".into(),
        changed_at: None,
        cleanup_pending: false,
        quota_bytes: FREE_QUOTA_BYTES,
        closing: None,
      });
    }
    let account = self.account.as_ref()?;
    let ticket = account.session_ticket().ok()?;
    lock(&self.storage)
      .as_ref()
      .filter(|(verified, _)| *verified == ticket)
      .map(|(_, state)| state.clone())
  }

  async fn refresh_storage_status(&self) {
    if !self.cloud_allowed.load(Ordering::SeqCst) || !self.storage_gate_enabled.load(Ordering::SeqCst) {
      return;
    }
    let Some(account) = self.account.as_ref() else { return };
    let Ok(ticket) = account.session_ticket() else {
      *lock(&self.storage) = None;
      return;
    };
    let Some(api) = self.storage_api.as_ref() else {
      *lock(&self.storage) = None;
      return;
    };
    let token = ExpectedSessionToken {
      account: account.clone(),
      ticket: ticket.clone(),
      context: None,
    };
    let result = api.get(&token).await.ok();
    if account.is_session_current(&ticket) {
      let mut observation = lock(&self.storage);
      match result {
        Some(state) => {
          let older = observation.as_ref().is_some_and(|(previous_ticket, previous)| {
            *previous_ticket == ticket
              && state.epoch.parse::<u64>().unwrap_or(0) < previous.epoch.parse::<u64>().unwrap_or(0)
          });
          if !older {
            *observation = Some((ticket, state));
          }
        }
        None => *observation = None,
      }
    }
  }

  fn schedule_storage_refresh(self: &Arc<Self>) {
    if self.storage_refresh_scheduled.swap(true, Ordering::SeqCst) {
      return;
    }
    let inner = self.clone();
    tauri::async_runtime::spawn(async move {
      inner.reconcile().await;
      inner.storage_refresh_scheduled.store(false, Ordering::SeqCst);
    });
  }

  async fn select_initial_storage(self: &Arc<Self>, mode: StorageMode) -> CommandResult<CloudState> {
    if !matches!(mode, StorageMode::Cloud | StorageMode::Local) {
      return Err(CommandError::new("bad_storage_mode", "保存先を選び直してください。"));
    }
    if !self.cloud_allowed.load(Ordering::SeqCst) {
      return Err(dev_cloud_disabled());
    }
    let _guard = self.reconcile_lock.lock().await;
    let transition = {
      let mut operations = lock(&self.operations);
      if operations.active > 0 || operations.root_transitioning {
        return Err(CommandError::new(
          "store_busy",
          "開いている文書の保存が終わってから選んでください。",
        ));
      }
      operations.root_transitioning = true;
      RootTransitionLease {
        state: self.operations.clone(),
      }
    };
    let account = self
      .account
      .as_ref()
      .ok_or_else(|| CommandError::new("cloud_login_required", "ログインが必要です。"))?;
    let ticket = account
      .session_ticket()
      .map_err(|_| CommandError::new("cloud_login_required", "ログインが必要です。"))?;
    let current = self
      .observed_storage()
      .filter(|state| state.mode == StorageMode::Unset)
      .ok_or_else(|| CommandError::new("docs_storage_changed", "保存先が変わりました。"))?;
    let api = self
      .storage_api
      .as_ref()
      .ok_or_else(|| CommandError::new("cloud_unavailable", "NIHO に接続できません。"))?;
    let token = ExpectedSessionToken {
      account: account.clone(),
      ticket: ticket.clone(),
      context: None,
    };
    let selected = match api.select_initial(&token, mode, &current.epoch).await {
      Ok(selected) => selected,
      Err(_) => api
        .get(&token)
        .await
        .map_err(|_| CommandError::new("cloud_unavailable", "保存先を確認できません。もう一度お試しください。"))?,
    };
    if !account.is_session_current(&ticket) {
      return Err(CommandError::new("cloud_login_required", "ログインが必要です。"));
    }
    *lock(&self.storage) = Some((ticket, selected.clone()));
    self.emit_state();
    if selected.mode != mode {
      self.reconcile_locked(true);
      return Err(CommandError::new("docs_storage_changed", "保存先が変わりました。"));
    }
    if mode == StorageMode::Local {
      // 未選択からのローカル選択でも、古い account namespace を退避して root の口を分ける。
      // 既存 CLOUD からの移行は専用 closing 手続きで全量照合した後に行う。
      if let Some(context) = self.context() {
        if context.binding.account_key.is_some() {
          self.invalidate_context();
          context.engine.shutdown();
          let saver = context.saver.clone();
          let root = context.root.clone();
          let recovered = tauri::async_runtime::spawn_blocking(move || {
            targets_of_root(&root)
              .iter()
              .all(|target| saver.recover(target).is_ok())
          })
          .await
          .unwrap_or(false);
          if !recovered {
            return Err(CommandError::new(
              "store_io",
              "このMacの保存を確認できませんでした。もう一度お試しください。",
            ));
          }
          let key = context.binding.account_key.as_deref().expect("checked account binding");
          let epoch = selected
            .epoch
            .parse::<u64>()
            .map_err(|_| CommandError::new("store_io", "保存先を確認できませんでした。"))?;
          archive_account_root(&self.data_dir, key, &context.binding.root_id, epoch)
            .map_err(|_| CommandError::new("store_io", "未送信の変更を保護できませんでした。"))?;
          bind_root(&self.data_dir, &context.binding.root_id, None)
            .map_err(|_| CommandError::new("store_io", "このMacの保存先を準備できませんでした。"))?;
        }
      }
    }
    self.reconcile_locked(true);
    drop(transition);
    Ok(self.state())
  }

  async fn local_reopening_inventory(&self, context: Arc<Context>, quota_bytes: u64) -> CommandResult<LocalInventory> {
    let root = context.root.clone();
    let app_data = self.data_dir.clone();
    let namespace = context.binding.namespace();
    let root_id = context.binding.root_id.clone();
    let device_id = self.device().device_id;
    tauri::async_runtime::spawn_blocking(move || {
      LocalInventory::collect_with_quota(&root, &app_data, &namespace, &root_id, &device_id, quota_bytes)
    })
    .await
    .map_err(|_| CommandError::new("store_io", "この Mac の内容を確認できませんでした。"))?
    .map_err(reopening_command_error)
  }

  fn persist_local_reopening(&self, attempt: &ReopeningAttempt, inventory: &LocalInventory) -> CommandResult<()> {
    let marker = LocalReopeningMarker {
      reopening_id: attempt.reopening_id.clone(),
      source_epoch: attempt.source_epoch.clone(),
      target_epoch: attempt.target_epoch.clone(),
      fingerprint: inventory.fingerprint().to_string(),
    };
    write_local_reopening_marker(&self.data_dir, &marker)
      .map_err(|_| CommandError::new("store_io", "移行の状態を保存できませんでした。"))?;
    self.emit_state();
    Ok(())
  }

  fn clear_local_reopening(&self) -> CommandResult<()> {
    clear_local_reopening_marker(&self.data_dir)
      .map_err(|_| CommandError::new("store_io", "移行の状態を更新できませんでした。"))?;
    self.emit_state();
    Ok(())
  }

  async fn abort_local_reopening(
    &self,
    api: &DocsStorageApi,
    token: &dyn IdTokenProvider,
    attempt: &ReopeningAttempt,
  ) -> CommandResult<()> {
    api
      .abort_reopening(token, attempt)
      .await
      .map_err(|error| reopening_command_error(ReopeningError::Api(error)))?;
    self.clear_local_reopening()
  }

  async fn local_reopening_preview(self: &Arc<Self>) -> CommandResult<ReopeningPreview> {
    let _guard = self.reconcile_lock.lock().await;
    if !self.cloud_allowed.load(Ordering::SeqCst) {
      return Err(dev_cloud_disabled());
    }
    let cached = self
      .observed_storage()
      .filter(|state| state.mode == StorageMode::Local)
      .ok_or_else(|| CommandError::new("docs_storage_changed", "保存先が変わりました。"))?;
    let context = self
      .context()
      .filter(|context| context.binding.account_key.is_none())
      .ok_or_else(|| CommandError::new("store_busy", "この Mac の保存先を準備しています。"))?;
    let account = self
      .account
      .as_ref()
      .ok_or_else(|| CommandError::new("cloud_login_required", "ログインが必要です。"))?;
    let ticket = account
      .session_ticket()
      .map_err(|_| CommandError::new("cloud_login_required", "ログインが必要です。"))?;
    let api = self
      .storage_api
      .as_ref()
      .ok_or_else(|| CommandError::new("cloud_unavailable", "NIHO に接続できません。"))?;
    let token = ExpectedSessionToken {
      account: account.clone(),
      ticket: ticket.clone(),
      context: None,
    };
    let current = api
      .get(&token)
      .await
      .map_err(|error| reopening_command_error(ReopeningError::Api(error)))?;
    if current.mode != StorageMode::Local || current.epoch != cached.epoch || !account.is_session_current(&ticket) {
      return Err(CommandError::new("docs_storage_changed", "保存先が変わりました。"));
    }
    Ok(
      self
        .local_reopening_inventory(context, current.quota_bytes)
        .await?
        .preview,
    )
  }

  async fn closing_preview(self: &Arc<Self>) -> CommandResult<ClosingPreview> {
    if !self.cloud_allowed.load(Ordering::SeqCst) {
      return Err(dev_cloud_disabled());
    }
    let storage = self
      .observed_storage()
      .ok_or_else(|| CommandError::new("cloud_unavailable", "保存先を確認できません。"))?;
    if storage.mode != StorageMode::Cloud {
      return Err(CommandError::new("docs_storage_changed", "保存先が変わりました。"));
    }
    let account = self
      .account
      .as_ref()
      .ok_or_else(|| CommandError::new("cloud_login_required", "ログインが必要です。"))?;
    let ticket = account
      .session_ticket()
      .map_err(|_| CommandError::new("cloud_login_required", "ログインが必要です。"))?;
    let token = ExpectedSessionToken {
      account: account.clone(),
      ticket,
      context: None,
    };
    let api = self
      .reopening_api
      .as_ref()
      .ok_or_else(|| CommandError::new("cloud_unavailable", "NIHO に接続できません。"))?;
    let preflight = api
      .closing_preflight(&token)
      .await
      .map_err(|error| closing_command_error(ClosingError::Api(error)))?;
    if preflight.epoch != storage.epoch {
      return Err(CommandError::new("docs_storage_changed", "保存先が変わりました。"));
    }
    let bytes = preflight
      .transfer_bytes
      .parse::<u64>()
      .map_err(|_| CommandError::new("cloud_unavailable", "受信量を確認できません。"))?;
    let required = required_free_bytes(bytes).map_err(closing_command_error)?;
    let available = disk_free_bytes(&self.data_dir).map_err(closing_command_error)?;
    Ok(ClosingPreview {
      preflight,
      required_free_bytes: required,
      available_free_bytes: available,
    })
  }

  async fn prepare_closing(self: &Arc<Self>) -> CommandResult<PreparedClosing> {
    let _guard = self.reconcile_lock.lock().await;
    self.closing_cancel_requested.store(false, Ordering::SeqCst);
    if !self.cloud_allowed.load(Ordering::SeqCst) {
      return Err(dev_cloud_disabled());
    }
    let storage = self
      .observed_storage()
      .filter(|state| matches!(state.mode, StorageMode::Cloud | StorageMode::Closing))
      .ok_or_else(|| CommandError::new("docs_storage_changed", "保存先が変わりました。"))?;
    let context = self
      .context()
      .filter(|context| context.binding.account_key.is_some())
      .ok_or_else(|| CommandError::new("store_busy", "この Mac の保存先を準備しています。"))?;
    let transition = {
      let mut operations = lock(&self.operations);
      if operations.active > 0 || operations.root_transitioning {
        return Err(CommandError::new(
          "store_busy",
          "開いている文書の保存が終わってから、もう一度お試しください。",
        ));
      }
      operations.root_transitioning = true;
      RootTransitionLease {
        state: self.operations.clone(),
      }
    };
    let account = self
      .account
      .as_ref()
      .ok_or_else(|| CommandError::new("cloud_login_required", "ログインが必要です。"))?;
    let ticket = account
      .session_ticket()
      .map_err(|_| CommandError::new("cloud_login_required", "ログインが必要です。"))?;
    let account_key = account_key(&self.env, &ticket.user_id);
    if context.binding.account_key.as_deref() != Some(account_key.as_str()) {
      return Err(CommandError::new(
        "docs_storage_changed",
        "この Mac のアカウントが変わりました。",
      ));
    }
    let token = ExpectedSessionToken {
      account: account.clone(),
      ticket: ticket.clone(),
      context: None,
    };
    let api = self
      .reopening_api
      .as_ref()
      .ok_or_else(|| CommandError::new("cloud_unavailable", "NIHO に接続できません。"))?;
    let mut transfer_bytes = 0;
    let mut attempt = match api
      .closing_current(&token)
      .await
      .map_err(|error| closing_command_error(ClosingError::Api(error)))?
    {
      Some(attempt) => attempt,
      None if storage.mode == StorageMode::Cloud => {
        let preflight = api
          .closing_preflight(&token)
          .await
          .map_err(|error| closing_command_error(ClosingError::Api(error)))?;
        if preflight.epoch != storage.epoch {
          return Err(CommandError::new("docs_storage_changed", "保存先が変わりました。"));
        }
        transfer_bytes = preflight
          .transfer_bytes
          .parse::<u64>()
          .map_err(|_| CommandError::new("cloud_unavailable", "受信量を確認できません。"))?;
        let needed = required_free_bytes(transfer_bytes).map_err(closing_command_error)?;
        if disk_free_bytes(&self.data_dir).map_err(closing_command_error)? < needed {
          return Err(closing_command_error(ClosingError::InsufficientSpace));
        }
        match api.begin_closing(&token, &storage.epoch).await {
          Ok(attempt) => attempt,
          Err(error) => api
            .closing_current(&token)
            .await
            .ok()
            .flatten()
            .ok_or_else(|| closing_command_error(ClosingError::Api(error)))?,
        }
      }
      None => {
        return Err(CommandError::new(
          "docs_storage_changed",
          "切り替えの担当 Mac が違います。",
        ))
      }
    };
    if attempt.epoch.parse::<u64>().is_err() || attempt.closing_id.is_empty() {
      return Err(CommandError::new("docs_storage_changed", "保存先を確認できません。"));
    }
    // Closing attempt の再開も、snapshot を読む前に最新の必要容量を再評価する。
    if matches!(attempt.phase.as_str(), "DRAINING" | "SNAPSHOT_READY") {
      let preflight = api
        .closing_preflight(&token)
        .await
        .map_err(|error| closing_command_error(ClosingError::Api(error)))?;
      if preflight.epoch != attempt.epoch {
        return Err(CommandError::new("docs_storage_changed", "保存先が変わりました。"));
      }
      transfer_bytes = preflight
        .transfer_bytes
        .parse::<u64>()
        .map_err(|_| CommandError::new("cloud_unavailable", "受信量を確認できません。"))?;
      if attempt.phase == "DRAINING" {
        let required = required_free_bytes(transfer_bytes).map_err(closing_command_error)?;
        if disk_free_bytes(&self.data_dir).map_err(closing_command_error)? < required {
          return Err(closing_command_error(ClosingError::InsufficientSpace));
        }
      }
    }
    if matches!(attempt.phase.as_str(), "DRAINING" | "SNAPSHOT_READY")
      && chrono::DateTime::parse_from_rfc3339(&attempt.expires_at).is_ok_and(|expires| expires <= chrono::Utc::now())
    {
      return Err(CommandError::new(
        "docs_storage_changed",
        "切り替えの期限が切れました。もう一度始めてください。",
      ));
    }
    self.refresh_storage_status().await;
    self.reconcile_locked(true);
    if !self
      .observed_storage()
      .is_some_and(|state| state.mode == StorageMode::Closing && state.epoch == attempt.epoch)
    {
      return Err(CommandError::new("docs_storage_changed", "保存先が変わりました。"));
    }
    for _ in 0..120 {
      if self.closing_cancel_requested.load(Ordering::SeqCst) {
        return Err(closing_command_error(ClosingError::Cancelled));
      }
      if attempt.phase != "DRAINING" {
        break;
      }
      let drain = api
        .closing_drain(&token, &attempt.closing_id)
        .await
        .map_err(|error| closing_command_error(ClosingError::Api(error)))?;
      if drain.expired {
        return Err(CommandError::new(
          "docs_storage_changed",
          "切り替えの期限が切れました。もう一度始めてください。",
        ));
      }
      if drain.ready {
        let ready = match api
          .closing_snapshot_ready(&token, &attempt.closing_id, &attempt.epoch)
          .await
        {
          Ok(ready) => ready,
          Err(error) => {
            let current = api.closing_current(&token).await.ok().flatten();
            if current
              .as_ref()
              .is_some_and(|current| current.phase == "SNAPSHOT_READY")
            {
              attempt = current.expect("checked");
              break;
            }
            return Err(closing_command_error(ClosingError::Api(error)));
          }
        };
        if ready.phase != "SNAPSHOT_READY" || ready.closing_id != attempt.closing_id || ready.epoch != attempt.epoch {
          return Err(CommandError::new("docs_storage_changed", "snapshot を確認できません。"));
        }
        attempt.phase = ready.phase;
        attempt.manifest_digest = Some(ready.manifest_digest);
        break;
      }
      api
        .snapshot_heartbeat(&token, &attempt.closing_id, &attempt.epoch)
        .await
        .map_err(|error| closing_command_error(ClosingError::Api(error)))?;
      tokio::time::sleep(Duration::from_secs(5)).await;
      attempt = api
        .closing_current(&token)
        .await
        .map_err(|error| closing_command_error(ClosingError::Api(error)))?
        .ok_or_else(|| CommandError::new("docs_storage_changed", "切り替えの状態が変わりました。"))?;
    }
    if !matches!(
      attempt.phase.as_str(),
      "SNAPSHOT_READY" | "DECISION_PENDING" | "DECIDED_LOCAL"
    ) {
      return Err(CommandError::new(
        "store_busy",
        "実行中の処理を待っています。後で再開してください。",
      ));
    }
    if attempt.phase == "SNAPSHOT_READY" {
      // Drain 完了後にもう一度確認し、最初の表示や再開開始後に増えた転送量も含める。
      let preflight = api
        .closing_preflight(&token)
        .await
        .map_err(|error| closing_command_error(ClosingError::Api(error)))?;
      if preflight.epoch != attempt.epoch {
        return Err(CommandError::new("docs_storage_changed", "保存先が変わりました。"));
      }
      transfer_bytes = preflight
        .transfer_bytes
        .parse::<u64>()
        .map_err(|_| CommandError::new("cloud_unavailable", "受信量を確認できません。"))?;
    }
    let digest = attempt
      .manifest_digest
      .clone()
      .ok_or_else(|| CommandError::new("docs_storage_changed", "snapshot がありません。"))?;
    let identity = SnapshotIdentity {
      user_id: ticket.user_id.clone(),
      closing_id: attempt.closing_id.clone(),
      epoch: attempt.epoch.clone(),
      manifest_digest: digest.clone(),
    };
    let verified = if attempt.phase == "SNAPSHOT_READY" {
      let progress =
        |done: usize, total: usize| self.emit("cloud://closing-progress", json!({ "done": done, "total": total }));
      let transport = HttpSnapshotTransport::new(api, &token, &self.closing_cancel_requested, &progress)
        .map_err(closing_command_error)?;
      receive_snapshot(&transport, &self.data_dir, &account_key, &identity, transfer_bytes)
        .await
        .map_err(closing_command_error)?
    } else {
      verify_staged_snapshot(&self.data_dir, &account_key, &identity).map_err(closing_command_error)?
    };
    verify_snapshot_placement(&context.root, &verified).map_err(closing_command_error)?;
    drop(transition);
    Ok(PreparedClosing {
      closing_id: identity.closing_id,
      epoch: identity.epoch,
      manifest_digest: identity.manifest_digest,
      file_count: verified.file_count,
      expired_audio_count: verified.expired_audio_count,
      deleted_folder_count: verified
        .projects
        .iter()
        .filter(|project| project.deleted_at.is_some())
        .count(),
    })
  }

  async fn confirm_closing(self: &Arc<Self>, prepared: PreparedClosing) -> CommandResult<CloudState> {
    let guard = self.reconcile_lock.lock().await;
    let context = self
      .context()
      .filter(|context| context.binding.account_key.is_some())
      .ok_or_else(|| CommandError::new("docs_storage_changed", "この Mac の保存先が変わりました。"))?;
    let transition = {
      let mut operations = lock(&self.operations);
      if operations.active > 0 || operations.root_transitioning {
        return Err(CommandError::new(
          "store_busy",
          "開いている文書の保存が終わってから、もう一度お試しください。",
        ));
      }
      operations.root_transitioning = true;
      RootTransitionLease {
        state: self.operations.clone(),
      }
    };
    let account = self
      .account
      .as_ref()
      .ok_or_else(|| CommandError::new("cloud_login_required", "ログインが必要です。"))?;
    let ticket = account
      .session_ticket()
      .map_err(|_| CommandError::new("cloud_login_required", "ログインが必要です。"))?;
    let account_key = account_key(&self.env, &ticket.user_id);
    if context.binding.account_key.as_deref() != Some(account_key.as_str()) {
      return Err(CommandError::new(
        "docs_storage_changed",
        "この Mac のアカウントが変わりました。",
      ));
    }
    let token = ExpectedSessionToken {
      account: account.clone(),
      ticket: ticket.clone(),
      context: None,
    };
    let api = self
      .reopening_api
      .as_ref()
      .ok_or_else(|| CommandError::new("cloud_unavailable", "NIHO に接続できません。"))?;
    let detail = api
      .closing_attempt(&token, &prepared.closing_id)
      .await
      .map_err(|error| closing_command_error(ClosingError::Api(error)))?;
    if detail.epoch != prepared.epoch
      || detail.manifest_digest.as_deref() != Some(&prepared.manifest_digest)
      || !matches!(
        detail.phase.as_str(),
        "SNAPSHOT_READY" | "DECISION_PENDING" | "DECIDED_LOCAL" | "COMMITTED"
      )
    {
      return Err(CommandError::new(
        "docs_storage_changed",
        "受信済み snapshot が変わりました。",
      ));
    }
    let identity = SnapshotIdentity {
      user_id: ticket.user_id,
      closing_id: prepared.closing_id.clone(),
      epoch: prepared.epoch.clone(),
      manifest_digest: prepared.manifest_digest.clone(),
    };
    let verified = verify_staged_snapshot(&self.data_dir, &account_key, &identity).map_err(closing_command_error)?;
    verify_snapshot_placement(&context.root, &verified).map_err(closing_command_error)?;
    if verified.file_count != prepared.file_count
      || verified.expired_audio_count != prepared.expired_audio_count
      || verified
        .projects
        .iter()
        .filter(|project| project.deleted_at.is_some())
        .count()
        != prepared.deleted_folder_count
    {
      return Err(CommandError::new(
        "docs_storage_changed",
        "受信済み snapshot を照合できません。",
      ));
    }
    mark_close_intent(&self.data_dir, &account_key, &context.binding.root_id, &identity)
      .map_err(closing_command_error)?;
    if detail.phase != "COMMITTED" {
      match api
        .close_storage(&token, &identity.closing_id, &identity.epoch, &identity.manifest_digest)
        .await
      {
        Ok(committed)
          if committed.mode == StorageMode::Local
            && committed.closing_id == identity.closing_id
            && committed.epoch == identity.epoch => {}
        Ok(_) => {
          return Err(CommandError::new(
            "docs_storage_changed",
            "切り替えの結果を確認できません。",
          ))
        }
        Err(error) => {
          let after = api.closing_attempt(&token, &identity.closing_id).await.ok();
          if !after.is_some_and(|after| {
            after.phase == "COMMITTED"
              && after.epoch == identity.epoch
              && after.manifest_digest.as_deref() == Some(&identity.manifest_digest)
          }) {
            return Err(closing_command_error(ClosingError::Api(error)));
          }
        }
      }
    }
    drop(transition);
    drop(guard);
    self.reconcile().await;
    if !self
      .observed_storage()
      .is_some_and(|state| state.mode == StorageMode::Local && state.epoch == identity.epoch)
      || self
        .context()
        .is_some_and(|context| context.binding.account_key.is_some())
    {
      return Err(CommandError::new(
        "store_io",
        "この Mac への切り替えを再開してください。受信済みデータは残っています。",
      ));
    }
    Ok(self.state())
  }

  async fn reopen_local_storage(self: &Arc<Self>) -> CommandResult<CloudState> {
    let _guard = self.reconcile_lock.lock().await;
    if !self.cloud_allowed.load(Ordering::SeqCst) {
      return Err(dev_cloud_disabled());
    }
    let storage = self
      .observed_storage()
      .filter(|state| state.mode == StorageMode::Local)
      .ok_or_else(|| CommandError::new("docs_storage_changed", "保存先が変わりました。"))?;
    let context = self
      .context()
      .filter(|context| context.binding.account_key.is_none())
      .ok_or_else(|| CommandError::new("store_busy", "この Mac の保存先を準備しています。"))?;
    let transition = {
      let mut operations = lock(&self.operations);
      if operations.active > 0 || operations.root_transitioning {
        return Err(CommandError::new(
          "store_busy",
          "開いている文書の保存が終わってから、もう一度お試しください。",
        ));
      }
      operations.root_transitioning = true;
      RootTransitionLease {
        state: self.operations.clone(),
      }
    };
    let result: CommandResult<String> = async {
      let account = self
        .account
        .as_ref()
        .ok_or_else(|| CommandError::new("cloud_login_required", "ログインが必要です。"))?;
      let ticket = account
        .session_ticket()
        .map_err(|_| CommandError::new("cloud_login_required", "ログインが必要です。"))?;
      let api = self
        .reopening_api
        .as_ref()
        .ok_or_else(|| CommandError::new("cloud_unavailable", "NIHO に接続できません。"))?;
      let token: Arc<dyn IdTokenProvider> = Arc::new(ExpectedSessionToken {
        account: account.clone(),
        ticket: ticket.clone(),
        context: Some(ContextFence {
          inner: Arc::downgrade(self),
          generation: context.generation,
          binding: context.binding.clone(),
        }),
      });
      let saver = context.saver.clone();
      let root = context.root.clone();
      let recovered = tauri::async_runtime::spawn_blocking(move || {
        targets_of_root(&root)
          .iter()
          .all(|target| saver.recover(target).is_ok())
      })
      .await
      .unwrap_or(false);
      if !recovered {
        return Err(CommandError::new("store_io", "この Mac の保存を確認できませんでした。"));
      }
      let current_storage = api
        .get(token.as_ref())
        .await
        .map_err(|error| reopening_command_error(ReopeningError::Api(error)))?;
      if current_storage.mode != StorageMode::Local || current_storage.epoch != storage.epoch {
        return Err(CommandError::new("docs_storage_changed", "保存先が変わりました。"));
      }
      let inventory = self
        .local_reopening_inventory(context.clone(), current_storage.quota_bytes)
        .await?;
      let mut attempt_created_now = false;
      let mut attempt = match api.current_reopening(token.as_ref()).await {
        Ok(Some(attempt)) => attempt,
        Ok(None) => match api.begin_reopening(token.as_ref(), &storage.epoch).await {
          Ok(attempt) => {
            attempt_created_now = true;
            attempt
          }
          Err(error) => api
            .current_reopening(token.as_ref())
            .await
            .map_err(|_| reopening_command_error(ReopeningError::Api(error)))?
            .ok_or_else(|| reopening_command_error(ReopeningError::Api(error)))?,
        },
        Err(error) => return Err(reopening_command_error(ReopeningError::Api(error))),
      };
      let expected_prefix = format!("docs-vault-reopened/v1/users/{}/", ticket.user_id);
      if attempt.source_epoch != storage.epoch || !attempt.namespace.starts_with(&expected_prefix) {
        return Err(CommandError::new("docs_storage_changed", "保存先が変わりました。"));
      }
      let marker_path_exists = local_reopening_marker_exists(&self.data_dir);
      let prior_marker = read_local_reopening_marker(&self.data_dir);
      let same_attempt_marker = prior_marker.as_ref().is_some_and(|marker| {
        marker.reopening_id == attempt.reopening_id
          && marker.source_epoch == attempt.source_epoch
          && marker.target_epoch == attempt.target_epoch
      });
      let fingerprint_matches = same_attempt_marker
        && prior_marker
          .as_ref()
          .is_some_and(|marker| marker.fingerprint == inventory.fingerprint());

      // 今回作った attempt 以外は、marker の紛失・破損も含めて混在を避けるため捨てる。
      if attempt.phase == ReopeningPhase::Baseline
        && baseline_marker_requires_abort(
          attempt_created_now,
          marker_path_exists,
          same_attempt_marker,
          fingerprint_matches,
        )
      {
        self.abort_local_reopening(api, token.as_ref(), &attempt).await?;
        return Err(reopening_command_error(ReopeningError::Changed));
      }
      if !same_attempt_marker {
        self.persist_local_reopening(&attempt, &inventory)?;
      }

      // seal 後でも decisionId が未作成なら、変わった手元内容での再開を安全に破棄できる。
      // decisionId が作成済みなら append が進行中かもしれないため同じ digest の決定を収束させる。
      if attempt.phase == ReopeningPhase::DecisionPending && !fingerprint_matches && !attempt.decision_prepared {
        match api.abort_reopening(token.as_ref(), &attempt).await {
          Ok(()) => {
            self.clear_local_reopening()?;
            return Err(reopening_command_error(ReopeningError::Changed));
          }
          Err(abort_error) => match api.current_reopening(token.as_ref()).await {
            Ok(Some(current))
              if current.phase == ReopeningPhase::DecisionPending
                && current.decision_prepared
                && current.manifest_digest == attempt.manifest_digest =>
            {
              attempt = current
            }
            Ok(None) => {
              self.clear_local_reopening()?;
              return Err(reopening_command_error(ReopeningError::Changed));
            }
            _ => return Err(reopening_command_error(ReopeningError::Api(abort_error))),
          },
        }
      }

      let digest = if attempt.phase == ReopeningPhase::Baseline {
        let transfer = NihoProvider::new(self.niho_environment, token.clone())
          .map_err(|_| CommandError::new("cloud_unavailable", "NIHO に接続できません。"))?;
        let digest = inventory
          .stage(api, &transfer, token.as_ref(), &attempt)
          .await
          .map_err(reopening_command_error)?;
        let after = self
          .local_reopening_inventory(context.clone(), current_storage.quota_bytes)
          .await?;
        if !inventory.same_contents_as(&after) {
          self.abort_local_reopening(api, token.as_ref(), &attempt).await?;
          return Err(reopening_command_error(ReopeningError::Changed));
        }
        if let Err(error) = api.seal_reopening(token.as_ref(), &attempt, &digest).await {
          let current = api.current_reopening(token.as_ref()).await.ok().flatten();
          if !current.as_ref().is_some_and(|current| {
            current.phase == ReopeningPhase::DecisionPending && current.manifest_digest.as_deref() == Some(&digest)
          }) {
            return Err(reopening_command_error(ReopeningError::Api(error)));
          }
          attempt.decision_prepared = current.is_some_and(|current| current.decision_prepared);
        }
        attempt.phase = ReopeningPhase::DecisionPending;
        attempt.manifest_digest = Some(digest.clone());
        digest
      } else {
        attempt
          .manifest_digest
          .clone()
          .ok_or_else(|| CommandError::new("docs_storage_changed", "移行の照合結果を確認できません。"))?
      };
      if attempt.phase == ReopeningPhase::DecisionPending {
        if let Err(error) = api.decide_reopening(token.as_ref(), &attempt, &digest).await {
          let current = api.current_reopening(token.as_ref()).await.ok().flatten();
          if !current.as_ref().is_some_and(|current| {
            current.phase == ReopeningPhase::DecidedCloud && current.manifest_digest.as_deref() == Some(&digest)
          }) {
            return Err(reopening_command_error(ReopeningError::Api(error)));
          }
        }
      }
      if let Err(error) = api.commit_reopening(token.as_ref(), &attempt, &digest).await {
        let current = api.get(token.as_ref()).await.ok();
        if !current.is_some_and(|current| current.mode == StorageMode::Cloud && current.epoch == attempt.target_epoch) {
          return Err(reopening_command_error(ReopeningError::Api(error)));
        }
      }
      Ok(attempt.target_epoch.clone())
    }
    .await;
    self.refresh_storage_status().await;
    self.reconcile_locked(true);
    drop(transition);
    let target_epoch = result?;
    if !self
      .observed_storage()
      .is_some_and(|state| state.mode == StorageMode::Cloud && state.epoch == target_epoch)
    {
      return Err(CommandError::new(
        "cloud_unavailable",
        "保存先の確定を確認できませんでした。",
      ));
    }
    self.clear_local_reopening()?;
    Ok(self.state())
  }

  fn account_state(&self) -> AccountState {
    self
      .account
      .as_ref()
      .map(|account| account.state())
      .unwrap_or(AccountState::SignedOut)
  }

  /// 今ログインしている（オフラインを含む）本人の accountKey。
  fn current_account_key(&self) -> Option<String> {
    match self.account_state() {
      AccountState::SignedIn { profile } | AccountState::Offline { profile } => {
        Some(account_key(&self.env, &profile.user_id))
      }
      _ => None,
    }
  }

  fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
    if let Some(app) = &self.app {
      let _ = app.emit(event, payload);
    }
  }

  fn emit_state(&self) {
    self.emit(STATE_EVENT, self.state());
  }

  fn set_offline(&self, offline: bool) {
    if self.offline.swap(offline, Ordering::SeqCst) != offline {
      self.emit_state();
    }
  }

  /// 保存先 root を開く（結び付きを読み、通信しない口を入れる）。root を作れない・結び付きを読めなければ口は外れる。
  fn open_root(self: &Arc<Self>, root: &Path) {
    self.remember_managed_root(root);
    let _ = fs::create_dir_all(root);
    match root_binding(&self.data_dir, root) {
      Ok(binding) => {
        self.remember_managed_root(&binding.path);
        let context = Context::reader(
          &self.data_dir,
          binding,
          self.device(),
          self.protection.clone(),
          self.next_context_generation(),
        );
        self.install(Arc::new(context));
      }
      Err(_) => {
        self.invalidate_context();
        let previous = self
          .context
          .write()
          .unwrap_or_else(|poisoned| poisoned.into_inner())
          .take();
        if let Some(previous) = previous {
          previous.engine.shutdown();
        }
      }
    }
  }

  fn remember_managed_root(&self, root: &Path) {
    let mut roots = self
      .managed_roots
      .write()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = root.to_path_buf();
    if !roots.contains(&root) {
      roots.push(root);
    }
  }

  /// 口を入れ替える（前の engine は止める。event の受け口も付け替える）。
  fn install(self: &Arc<Self>, next: Arc<Context>) {
    // provider を作ってから install する順序は保つ。先に世代を進めて旧 provider を止め、新 provider は
    // Context 自体が入るまで ContextFence の binding 照合を通らない。
    self.context_generation.store(next.generation, Ordering::SeqCst);
    let previous = self
      .context
      .write()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .replace(next.clone());
    // token/session/engine だけの更新では、同じ namespace の dirty editor handle と protection を残す。
    // root/owner/epoch の変更時は、先に current を次へ替えてから破棄し、旧 provider へ release schedule を送らない。
    self.retain_opened_documents_for(&next.binding);
    *lock(&self.remote) = Vec::new();
    lock(&self.emits).clear();
    if let Some(previous) = previous {
      if !Arc::ptr_eq(&previous.engine, &next.engine) {
        previous.engine.shutdown();
      }
    }
    let receiver = next.engine.subscribe();
    let task = tauri::async_runtime::spawn(forward_events(Arc::downgrade(self), Arc::downgrade(&next), receiver));
    if let Some(old) = lock(&self.forwarder).replace(task) {
      old.abort();
    }
  }

  /// 起動の続き: journal の回復 → 状態を合わせる → ログイン状態の購読。
  async fn boot(self: Arc<Self>) {
    self.recover_all().await;
    self.reconcile().await;
    let Some(account) = self.account.clone() else {
      return;
    };
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<()>();
    // 登録した時点の状態も 1 回届く
    account.subscribe(move |_| {
      let _ = sender.send(());
    });
    let weak = Arc::downgrade(&self);
    drop(self);
    while receiver.recv().await.is_some() {
      while receiver.try_recv().is_ok() {}
      let Some(inner) = weak.upgrade() else {
        return;
      };
      inner.reconcile().await;
    }
  }

  /// 今の root の全部の対象の journal を回復する（その間 `list_projects` は待つ）。
  async fn recover_all(&self) {
    self.recovered.send_replace(false);
    if let Some(context) = self.context() {
      let saver = context.saver.clone();
      let root = context.root.clone();
      let _ = tauri::async_runtime::spawn_blocking(move || recover_root(&saver, &root)).await;
    }
    self.recovered.send_replace(true);
    self.emit_state();
  }

  /// 保存先・ログイン状態・root の結び付きに engine を合わせる（§1.2）。
  async fn reconcile(self: &Arc<Self>) {
    self.refresh_storage_status().await;
    self.ensure_local_detached().await;
    self.reconcile_with_transition(false).await;
  }

  /// 別の Mac が LOCAL を確定した場合も、旧 account の未送信記録を消さずに作業コピーの口を分ける。
  /// 開いている文書があれば旧 namespace での保存を終えるまで待ち、最後の lease から再実行する。
  async fn ensure_local_detached(self: &Arc<Self>) {
    let Some(storage) = self.observed_storage().filter(|state| state.mode == StorageMode::Local) else {
      return;
    };
    let _guard = self.reconcile_lock.lock().await;
    let Some(context) = self.context() else { return };
    if context.binding.account_key.is_none() {
      let _ = cleanup_applied_close_stages(&self.data_dir);
      return;
    }
    self.invalidate_context();
    context.engine.shutdown();
    let transition = {
      let mut operations = lock(&self.operations);
      if operations.active > 0 || operations.root_transitioning {
        operations.reconcile_pending = true;
        return;
      }
      operations.root_transitioning = true;
      RootTransitionLease {
        state: self.operations.clone(),
      }
    };
    let pending = match (
      context.binding.account_key.as_deref(),
      self.account.as_ref().and_then(|account| account.session_ticket().ok()),
    ) {
      (Some(key), Some(ticket)) if account_key(&self.env, &ticket.user_id) == key => pending_close_intent(
        &self.data_dir,
        key,
        &ticket.user_id,
        &context.binding.root_id,
        &storage.epoch,
      ),
      _ => Err(ClosingError::Mismatch),
    };
    // applied marker の後に archive 中で落ちた場合、移動済み project の旧 namespace を
    // recover で作り直すと archive の宛先と衝突する。作業コピーはすでに確定済みなので再回復しない。
    let already_applied = pending
      .as_ref()
      .ok()
      .and_then(|intent| intent.as_ref())
      .and_then(|intent| {
        context
          .binding
          .account_key
          .as_deref()
          .and_then(|key| snapshot_applied(&self.data_dir, key, &intent.identity).ok())
      })
      .unwrap_or(false);
    let recovered = if already_applied {
      true
    } else {
      let saver = context.saver.clone();
      let root = context.root.clone();
      tauri::async_runtime::spawn_blocking(move || {
        targets_of_root(&root)
          .iter()
          .all(|target| saver.recover(target).is_ok())
      })
      .await
      .unwrap_or(false)
    };
    if recovered {
      if let (Some(key), Ok(epoch)) = (context.binding.account_key.as_deref(), storage.epoch.parse::<u64>()) {
        let applied = match pending.as_ref() {
          Ok(Some(intent)) => apply_committed_snapshot(
            &self.data_dir,
            key,
            &context.binding.root_id,
            &context.root,
            self.device(),
            &intent,
          )
          .is_ok(),
          Ok(None) => true, // 別の Mac が確定した場合。旧 outbox は archive に残す。
          Err(_) => false,
        };
        if applied {
          if archive_account_root(&self.data_dir, key, &context.binding.root_id, epoch).is_ok()
            && bind_root(&self.data_dir, &context.binding.root_id, None).is_ok()
          {
            if let Ok(Some(intent)) = pending.as_ref() {
              let _ = cleanup_close_stage(&self.data_dir, key, &intent.identity);
            }
          }
        } else {
          // staging の1件でも欠ければ root を切り離さない。次の status 更新で同じ attempt から再開する。
          *lock(&self.storage) = None;
        }
      }
    }
    self.reconcile_locked(true);
    drop(transition);
  }

  /// provider/root transition 自身だけは、新規 capture を塞いだまま binding と Context の確定まで進める。
  async fn reconcile_with_transition(self: &Arc<Self>, allow_transition: bool) {
    let _guard = self.reconcile_lock.lock().await;
    self.reconcile_locked(allow_transition);
  }

  /// capture の入口: `reconcile_lock` を取り、今の本人にまだ結び付いていない Root なら lease を取る前に結び付ける。
  /// 初回ログインの直後に文書を開くと、account の通知による reconcile より capture が先に lock を取ることがある。結び付く前の
  /// Root で lease を取ると reconcile が保留になり、文書を開いている間ずっと自動移行が始まらない。ほかの捕捉（手元で続けて
  /// いた間に開いた文書・始めた処理）が残っていれば、その解放を `BINDING_WAIT` まで待ってから結び付ける。待っても残るときは
  /// 開かない（開くと保留を延ばす）。保存先の切り替え中は `acquire_operation` が断る。
  async fn lock_for_capture(self: &Arc<Self>) -> CommandResult<tokio::sync::MutexGuard<'_, ()>> {
    let deadline = Instant::now() + BINDING_WAIT;
    loop {
      let guard = self.reconcile_lock.lock().await;
      match self.bind_before_capture() {
        Ok(()) => return Ok(guard),
        Err(error) if Instant::now() >= deadline => return Err(error),
        Err(_) => {
          drop(guard);
          tokio::time::sleep(BINDING_POLL).await;
        }
      }
    }
  }

  /// `reconcile_lock` を持っている間だけ呼ぶ。結び付けを、ほかの捕捉が残っているため保留したら Err。
  fn bind_before_capture(self: &Arc<Self>) -> CommandResult<()> {
    if !self
      .observed_storage()
      .is_some_and(|state| state.mode == StorageMode::Cloud)
    {
      return Ok(());
    }
    let Some(context) = self.context() else {
      return Ok(());
    };
    let binding = root_binding(&self.data_dir, &context.root).unwrap_or_else(|_| context.binding.clone());
    if !matches!(
      decide_mode(self.provider_kind(), &self.account_state(), &binding, &self.env),
      Mode::Unbound { .. }
    ) {
      return Ok(());
    }
    {
      let mut operations = lock(&self.operations);
      if operations.root_transitioning {
        return Ok(());
      }
      if operations.active > 0 {
        // 最後の捕捉が外れたときに結び付ける（OperationLease の drop が reconcile を予約する）
        operations.reconcile_pending = true;
        return Err(binding_pending_error());
      }
    }
    if self.reconcile_locked(false) {
      return Err(binding_pending_error());
    }
    // 結び付けに失敗した（roots.json を書けない など）まま開くと、結び付く前の Root で lease を取ってしまう
    let still_unbound = self.context().is_none_or(|context| {
      let binding = root_binding(&self.data_dir, &context.root).unwrap_or_else(|_| context.binding.clone());
      matches!(
        decide_mode(self.provider_kind(), &self.account_state(), &binding, &self.env),
        Mode::Unbound { .. }
      )
    });
    if still_unbound {
      return Err(binding_pending_error());
    }
    Ok(())
  }

  /// `reconcile_lock` を持っている間だけ呼ぶ（中で await しない）。今の本人への結び付けを、捕捉中の処理があるため保留したら true。
  fn reconcile_locked(self: &Arc<Self>, allow_transition: bool) -> bool {
    if allow_transition {
      lock(&self.operations).reconcile_pending = false;
    }
    let Some(context) = self.context() else {
      self.emit_state();
      return false;
    };
    let account = self.account_state();
    let mut binding = root_binding(&self.data_dir, &context.root).unwrap_or_else(|_| context.binding.clone());
    let mut mode = decide_mode(self.provider_kind(), &account, &binding, &self.env);
    if self
      .observed_storage()
      .is_some_and(|state| state.mode == StorageMode::Cloud)
    {
      if let Mode::Unbound { account_key } = &mode {
        let mut operations = lock(&self.operations);
        if operations.active > 0 || (operations.root_transitioning && !allow_transition) {
          operations.reconcile_pending = true;
          drop(operations);
          self.emit_state();
          return true;
        }
        drop(operations);
        // 「NIHO クラウド」を選んだ保存先がまだ結び付いていない（保存先を変えた直後など）: 今の本人に結び付ける
        if let Ok(bound) = bind_root(&self.data_dir, &binding.root_id, Some(account_key)) {
          binding = bound;
          mode = Mode::Active {
            account_key: account_key.clone(),
          };
        }
      }
    }
    let want_active = matches!(mode, Mode::Active { .. })
      && self
        .observed_storage()
        .is_some_and(|state| state.mode == StorageMode::Cloud);
    let device = self.device();
    let reconnected = {
      let mut last = lock(&self.last_account);
      let reconnected = *last == Some("offline") && account.kind() == "signedIn";
      *last = Some(account.kind());
      reconnected
    };
    if context.binding == binding
      && context.active == want_active
      && context.device == device
      && self.context_is_current(&context)
    {
      if reconnected {
        // 再接続: 送っていない案件と flows・profile をすぐ同期する
        self.schedule_startup(&context);
      }
      self.emit_state();
      return false;
    }
    let generation = self.next_context_generation();
    let next = if want_active {
      match self.active_context(binding.clone(), device.clone(), generation) {
        Ok(next) => next,
        Err(_) => Context::reader(&self.data_dir, binding, device, self.protection.clone(), generation),
      }
    } else {
      Context::reader(&self.data_dir, binding, device, self.protection.clone(), generation)
    };
    let next = Arc::new(next);
    self.install(next.clone());
    if next.active {
      self.on_engine_start(&next);
    }
    self.emit_state();
    false
  }

  /// 同期する口（NihoProvider の engine）を作る。tokio の runtime の中で呼ぶ。
  fn active_context(
    self: &Arc<Self>,
    binding: RootBinding,
    device: Device,
    generation: u64,
  ) -> Result<Context, VaultError> {
    let account = self.account.clone().ok_or(VaultError::AuthRequired)?;
    let ticket = account.session_ticket().map_err(|error| token_error(&error))?;
    if account_key(&self.env, &ticket.user_id) != binding.account_key.clone().unwrap_or_default() {
      return Err(VaultError::NamespaceMismatch(
        "the docs root is bound to another account".into(),
      ));
    }
    let token: Arc<dyn IdTokenProvider> = Arc::new(ExpectedSessionToken {
      account,
      ticket: ticket.clone(),
      context: Some(ContextFence {
        inner: Arc::downgrade(self),
        generation,
        binding: binding.clone(),
      }),
    });
    let weak = Arc::downgrade(self);
    let provider: Arc<dyn VaultProvider> = Arc::new(
      NihoProvider::new(self.niho_environment, token)?.with_storage_change_hook(Arc::new(move || {
        if let Some(inner) = weak.upgrade() {
          inner.schedule_storage_refresh();
        }
      })),
    );
    let engine = SyncEngine::new(
      provider.clone(),
      &self.data_dir,
      binding.namespace(),
      binding.root_id.clone(),
      device.clone(),
      self.protection.clone(),
    );
    engine.set_flight_options(Arc::new(AppFlightOptions {
      inner: Arc::downgrade(self),
    }));
    Ok(Context {
      generation,
      root: binding.path.clone(),
      saver: engine.saver(),
      engine,
      active: true,
      provider: Some(provider),
      binding,
      device,
      session: Some(ticket),
    })
  }

  /// engine を始めたとき: 送っていない案件・flows・profile をすぐ同期し、移行を始めるか続け、クラウドの一覧を読む。
  fn on_engine_start(self: &Arc<Self>, context: &Arc<Context>) {
    self.schedule_startup(context);
    self.ensure_migration(context);
    let inner = self.clone();
    let context = context.clone();
    tauri::async_runtime::spawn(async move {
      inner.refresh_remote_for(context, SyncReason::Periodic).await;
    });
  }

  fn schedule_startup(&self, context: &Context) {
    if !context.active {
      return;
    }
    if let Ok(pending) = context.engine.projects_with_pending() {
      for project_id in pending {
        if let Some(target) = context.target(&project_id) {
          context.schedule(&target, SyncReason::Now);
        }
      }
    }
    // 空の docs-root も作成・取得し、続けて工程・プロフィールを受け取る。
    let _ = fs::create_dir_all(context.root.join("flows"));
    for project_id in [DOCS_ROOT_PROJECT_ID, FLOWS_PROJECT_ID, PROFILE_PROJECT_ID] {
      if let Some(target) = context.target(project_id) {
        context.schedule(&target, SyncReason::Now);
      }
    }
  }

  async fn flight_options(&self, target: &ProjectTarget) -> SyncOptions {
    let mut options = SyncOptions::default();
    if !is_reserved_project(&target.project_id) {
      options.project_name = project_name(&target.working_copy);
    }
    options.running = self.holds_run_lock(&target.project_id);
    let leases = self.leases.lock().await;
    if let Some(held) = leases.get(&target.project_id) {
      options.lease_id = held.session.commit_lease_id().await;
    }
    options
  }

  /// この窓がその案件の実行のロックを持っているか。
  fn holds_run_lock(&self, project_id: &str) -> bool {
    let Some(app) = &self.app else {
      return false;
    };
    let Some(state) = app.try_state::<AppState>() else {
      return false;
    };
    // フォルダ外の録音の実行は store のロック鍵 `_outside` で持つ（同期の ID は docs-root）
    let key = if project_id == DOCS_ROOT_PROJECT_ID {
      crate::OUTSIDE_LOCK_KEY
    } else {
      project_id
    };
    let held = state.run_locks.lock().map(|locks| locks.contains(key)).unwrap_or(false);
    held
  }

  fn on_event(self: &Arc<Self>, context: Arc<Context>, event: SyncEvent) {
    let project_id = match &event {
      SyncEvent::Syncing { project_id }
      | SyncEvent::LocalSaved { project_id, .. }
      | SyncEvent::Committed { project_id, .. }
      | SyncEvent::Conflict { project_id, .. }
      | SyncEvent::Deferred { project_id, .. }
      | SyncEvent::Applied { project_id, .. }
      | SyncEvent::Audio { project_id, .. }
      | SyncEvent::Quota { project_id, .. }
      | SyncEvent::Offline { project_id, .. }
      | SyncEvent::Expired { project_id, .. }
      | SyncEvent::Tombstone { project_id, .. }
      | SyncEvent::Done { project_id, .. } => project_id.clone(),
    };
    match &event {
      SyncEvent::Applied { paths, .. } => self.emit(
        APPLIED_EVENT,
        AppliedEvent {
          context_generation: context.generation,
          project_id: project_id.clone(),
          paths: paths.clone(),
        },
      ),
      SyncEvent::Offline { .. } => self.set_offline(true),
      SyncEvent::Done { status, .. } => match status {
        SyncStatus::Offline => self.set_offline(true),
        SyncStatus::Synced { .. }
        | SyncStatus::Pending { .. }
        | SyncStatus::Partial { .. }
        | SyncStatus::Conflicted { .. } => self.set_offline(false),
        // 別の Mac で削除された案件を手元から退避した: 一覧を読み直す
        SyncStatus::MovedDeletedProject { .. } => self.emit(
          APPLIED_EVENT,
          AppliedEvent {
            context_generation: context.generation,
            project_id: project_id.clone(),
            paths: Vec::new(),
          },
        ),
        _ => {}
      },
      _ => {}
    }
    self.queue_snapshot(context, project_id);
  }

  /// `cloud://project` を案件ごとに 150ms に 1 回までにまとめる（送るときに今の状態を読む）。
  fn queue_snapshot(self: &Arc<Self>, context: Arc<Context>, project_id: String) {
    let now = Instant::now();
    let key = (context.generation, project_id.clone());
    let delay = {
      let mut emits = lock(&self.emits);
      let slot = emits.entry(key.clone()).or_default();
      if slot.scheduled {
        return;
      }
      slot.scheduled = true;
      match slot.last {
        Some(last) if now.duration_since(last) < PROJECT_EVENT_GAP => PROJECT_EVENT_GAP - now.duration_since(last),
        _ => Duration::ZERO,
      }
    };
    let weak = Arc::downgrade(self);
    let context = Arc::downgrade(&context);
    tauri::async_runtime::spawn(async move {
      if !delay.is_zero() {
        tokio::time::sleep(delay).await;
      }
      let Some(inner) = weak.upgrade() else {
        return;
      };
      let Some(context) = context.upgrade() else {
        return;
      };
      {
        let mut emits = lock(&inner.emits);
        let slot = emits.entry(key).or_default();
        slot.scheduled = false;
        slot.last = Some(Instant::now());
      }
      inner.emit_snapshot(&context, &project_id);
    });
  }

  fn emit_snapshot(&self, context: &Arc<Context>, project_id: &str) {
    if !self.context_is_current(context) {
      return;
    }
    let Some(target) = context.target(project_id) else {
      return;
    };
    if let Ok(snapshot) = context.engine.project_snapshot(&target) {
      self.emit(
        PROJECT_EVENT,
        ProjectEvent {
          context_generation: context.generation,
          project_id: project_id.to_string(),
          snapshot,
        },
      );
    }
  }

  /// クラウドの案件の一覧を読み直す（予約の flows・profile も読み、手元の base と revision が違う対象の同期を予約する）。
  async fn refresh_remote(self: &Arc<Self>, reason: SyncReason) -> Option<RemoteProjectsReply> {
    let context = self.active()?;
    self.refresh_remote_for(context, reason).await
  }

  async fn refresh_remote_for(
    self: &Arc<Self>,
    context: Arc<Context>,
    reason: SyncReason,
  ) -> Option<RemoteProjectsReply> {
    if !context.active || !self.context_is_current(&context) {
      return None;
    }
    let provider = context.provider.clone()?;
    let projects = match provider.list_projects(true, false).await {
      Ok(projects) => projects,
      Err(error) => {
        if self.context_is_current(&context) && error.is_offline() {
          self.set_offline(true);
        }
        return None;
      }
    };
    if !self.context_is_current(&context) {
      return None;
    }
    self.set_offline(false);
    let leases: HashSet<String> = self.leases.lock().await.keys().cloned().collect();
    let namespace = context.binding.namespace();
    let mut remote = Vec::new();
    for project in projects {
      let reserved = is_reserved_project(&project.project_id);
      let local = context
        .root
        .join("projects")
        .join(&project.project_id)
        .join("project.json")
        .is_file();
      if reserved || local {
        if let Some(target) = context.target(&project.project_id) {
          let base = load_or_default_state(
            &self.data_dir,
            &namespace,
            &context.binding.root_id,
            &project.project_id,
          )
          .map(|state| state.base_revision)
          .unwrap_or(0);
          if base != project.revision {
            context.schedule(&target, reason);
          }
        }
      }
      if !listed_in_remote(&project.project_id) {
        continue;
      }
      let mine = leases.contains(&project.project_id);
      remote.push(RemoteProject {
        // 自分の lease は、この Mac が持っているセッションだけ（端末名は 2 台で同じことがあるので見ない）
        lease: project.lease.map(|lease| RemoteLease {
          mine,
          device_name: lease.device_name,
          expires_at: lease.expires_at,
        }),
        project_id: project.project_id,
        name: project.name,
        revision: project.revision,
        updated_at: project.updated_at,
        bytes: project.bytes,
        local,
      });
    }
    if !self.context_is_current(&context) {
      return None;
    }
    *lock(&self.remote) = remote.clone();
    let reply = RemoteProjectsReply {
      context_generation: context.generation,
      projects: remote,
    };
    self.emit(
      REMOTE_EVENT,
      RemoteEvent {
        context_generation: reply.context_generation,
        projects: reply.projects.clone(),
      },
    );
    Some(reply)
  }

  /// 「NIHO クラウド」/「この Mac だけ」の設定をクラウドにも残す（best effort。待たない）。
  fn put_remote_settings(&self, provider: ProviderKind) {
    let Some(account) = self.account.clone() else {
      return;
    };
    let Ok(ticket) = account.session_ticket() else {
      return;
    };
    let niho_environment = self.niho_environment;
    let device_id = self.base_device.device_id.clone();
    tauri::async_runtime::spawn(async move {
      let token: Arc<dyn IdTokenProvider> = Arc::new(ExpectedSessionToken {
        account,
        ticket,
        context: None,
      });
      if let Ok(niho) = NihoProvider::new(niho_environment, token) {
        let _ = niho.put_settings(&device_id, provider).await;
      }
    });
  }

  fn state(&self) -> CloudState {
    let provider = self.provider_kind();
    let storage = self.observed_storage();
    let context = self.context();
    let account = self.account_state();
    let recovered = *self.recovered.borrow();
    let mut can_rebind = false;
    let status = match (&context, provider) {
      (_, ProviderKind::Local) => CloudStatus::Local,
      (_, _) if storage.as_ref().is_some_and(|state| state.mode == StorageMode::Unset) => CloudStatus::Unselected,
      (_, _) if storage.as_ref().is_some_and(|state| state.mode == StorageMode::Closing) => CloudStatus::Closing,
      (_, _)
        if storage.is_none() && matches!(account, AccountState::SignedIn { .. } | AccountState::Offline { .. }) =>
      {
        CloudStatus::StorageUnavailable
      }
      (None, _) => CloudStatus::Starting,
      (Some(_), _) if !recovered => CloudStatus::Starting,
      (Some(context), _) => match decide_mode(provider, &account, &context.binding, &self.env) {
        Mode::Local => CloudStatus::Local,
        Mode::SignedOut => CloudStatus::SignedOut,
        Mode::Expired => CloudStatus::Expired,
        Mode::OtherAccount { bound } => {
          can_rebind = !namespace_has_pending(
            &self.data_dir,
            &Namespace::Account { account_key: bound },
            &context.binding.root_id,
          )
          .unwrap_or(true);
          CloudStatus::OtherAccount
        }
        Mode::Unbound { .. } => CloudStatus::Starting,
        Mode::Active { .. } if context.active && self.context_is_current(context) => CloudStatus::Active,
        Mode::Active { .. } => CloudStatus::Starting,
      },
    };
    let account_name = account.profile().and_then(|profile| {
      let name = profile.display_name.trim();
      if name.is_empty() {
        profile.handle.clone().filter(|handle| !handle.trim().is_empty())
      } else {
        Some(name.to_string())
      }
    });
    let offline = self.offline.load(Ordering::SeqCst) || matches!(account, AccountState::Offline { .. });
    let reopening_pending = local_reopening_pending(&self.data_dir, storage.as_ref());
    CloudState {
      context_generation: self.context_generation.load(Ordering::SeqCst),
      document_scope_id: context.as_ref().map(|context| document_scope_id(&context.binding)),
      provider,
      status,
      device_name: self.device().device_name,
      account_name,
      can_rebind,
      migration: context
        .as_ref()
        .filter(|context| self.context_is_current(context))
        .and_then(|context| self.migration_view(context)),
      message: if status == CloudStatus::Local
        && context
          .as_ref()
          .is_some_and(|context| context.binding.account_key.is_some())
      {
        Some("このMacの保存先を切り替えています。開いている文書の保存を終えてください。".into())
      } else if status == CloudStatus::Active && offline {
        Some(OFFLINE_MESSAGE.to_string())
      } else {
        None
      },
      storage,
      requires_account: self.cloud_allowed.load(Ordering::SeqCst),
      reopening_pending,
    }
  }

  fn migration_view(&self, context: &Context) -> Option<CloudMigration> {
    let key = context.binding.account_key.as_deref()?;
    let running = lock(&self.migration).running;
    let file = match read_migration(&self.data_dir, key).filter(|file| file.root_id == context.binding.root_id) {
      Some(file) => file,
      // 始めた直後（対象を数えている間）は、まだ進みの記録が無い
      None if running => MigrationFile::default(),
      None => return None,
    };
    let show = running || file.cancelled || !file.failed.is_empty() || file.unfinished();
    show.then(|| CloudMigration {
      running,
      cancelled: file.cancelled,
      total: file.total,
      done: file.done.len(),
      bytes_total: file.bytes_total,
      bytes_done: file.bytes_done,
      failed: file.failed,
    })
  }

  /// この Mac の案件をクラウドへ上げる（保存先は NIHO クラウドだけ。#18728）。まだ一度も上げていない保存先（アップデート後の
  /// 初回ログイン）は確認なしで始め、途中で終わった移行は続ける。本人が中断した移行は「再開する」まで待つ。
  fn ensure_migration(self: &Arc<Self>, context: &Arc<Context>) {
    let Some(key) = context.binding.account_key.as_deref() else {
      return;
    };
    let file = read_migration(&self.data_dir, key).filter(|file| file.root_id == context.binding.root_id);
    if migration_should_start(file.as_ref()) {
      self.start_migration(context.clone());
    }
  }

  fn start_migration(self: &Arc<Self>, context: Arc<Context>) {
    let cancel = {
      let mut run = lock(&self.migration);
      if run.running {
        return;
      }
      run.running = true;
      run.cancel = Arc::new(AtomicBool::new(false));
      run.cancel.clone()
    };
    let inner = self.clone();
    tauri::async_runtime::spawn(async move {
      inner.run_migration(context, cancel).await;
      lock(&inner.migration).running = false;
      inner.emit_state();
    });
  }

  /// 案件を 1 つずつ同期する（間で中断を確かめ、1 つごとに進みを残して画面へ知らせる）。
  async fn run_migration(self: &Arc<Self>, context: Arc<Context>, cancel: Arc<AtomicBool>) {
    let Some(key) = context.binding.account_key.clone() else {
      return;
    };
    let root = context.root.clone();
    let targets = tauri::async_runtime::spawn_blocking(move || migration_targets(&root))
      .await
      .unwrap_or_default();
    let root_id = context.binding.root_id.clone();
    let mut file = read_migration(&self.data_dir, &key)
      .filter(|file| file.root_id == root_id)
      .unwrap_or_else(|| MigrationFile {
        root_id: root_id.clone(),
        started_at: store::now_iso(),
        ..MigrationFile::default()
      });
    let ids: HashSet<&str> = targets
      .iter()
      .map(|(target, _, _)| target.project_id.as_str())
      .collect();
    file.done.retain(|id| ids.contains(id.as_str()));
    file.failed.clear();
    file.cancelled = false;
    file.total = targets.len();
    file.bytes_total = targets.iter().map(|(_, _, bytes)| bytes).sum();
    file.bytes_done = targets
      .iter()
      .filter(|(target, _, _)| file.done.contains(&target.project_id))
      .map(|(_, _, bytes)| bytes)
      .sum();
    write_migration(&self.data_dir, &key, &file);
    self.emit_state();
    for (target, name, bytes) in targets {
      if file.done.contains(&target.project_id) {
        continue;
      }
      if cancel.load(Ordering::SeqCst) {
        file.cancelled = true;
        break;
      }
      if context.engine.is_shut_down() {
        break;
      }
      let mut options = self.flight_options(&target).await;
      options.force = true;
      let result = context.engine.sync(&target, options).await;
      if matches!(result, Err(VaultError::ShutDown)) {
        // ログアウト・切り替え: 次に engine を始めたときに続ける
        break;
      }
      match migration_failure(&result) {
        None => {
          file.done.push(target.project_id.clone());
          file.bytes_done += bytes;
        }
        Some(reason) => file.failed.push(MigrationFailure {
          project_id: target.project_id.clone(),
          name,
          reason: reason.to_string(),
        }),
      }
      write_migration(&self.data_dir, &key, &file);
      self.emit_state();
    }
    write_migration(&self.data_dir, &key, &file);
  }

  /// 状態に合わせた、同期できないときの失敗。
  fn inactive_error(&self) -> CommandError {
    match self.state().status {
      CloudStatus::SignedOut | CloudStatus::Expired => {
        CommandError::new("cloud_login_required", "ログインが必要です。")
      }
      CloudStatus::OtherAccount => CommandError::new(
        "vault_other_account",
        "この保存先は別の NIHO アカウントと同期しています。",
      ),
      _ => CommandError::new("cloud_unavailable", "クラウドにつながっていません。"),
    }
  }

  async fn set_provider(self: &Arc<Self>, provider: ProviderKind, rebind: bool) -> CommandResult<()> {
    if provider == ProviderKind::Local && self.cloud_allowed.load(Ordering::SeqCst) {
      return Err(CommandError::new("vault_cloud_only", "保存先はクラウドだけです。"));
    }
    let reconcile_guard = self.reconcile_lock.lock().await;
    let transition = {
      let mut state = lock(&self.operations);
      if state.active > 0 || state.root_transitioning {
        return Err(CommandError::new(
          "store_busy",
          "開いている文書の保存が終わってから保存先を切り替えてください。",
        ));
      }
      state.root_transitioning = true;
      RootTransitionLease {
        state: self.operations.clone(),
      }
    };
    let context = self
      .context()
      .ok_or_else(|| CommandError::new("vault_unavailable", "保存先を確かめられませんでした。"))?;
    let previous_provider = self.provider_kind();
    if provider == ProviderKind::Niho && !self.cloud_allowed.load(Ordering::SeqCst) {
      return Err(dev_cloud_disabled());
    }
    if provider == ProviderKind::Niho {
      let account = self.account_state();
      let binding = root_binding(&self.data_dir, &context.root).unwrap_or_else(|_| context.binding.clone());
      let bind_failed = || CommandError::new("vault_unavailable", "保存先を確かめられませんでした。");
      match decide_mode(ProviderKind::Niho, &account, &binding, &self.env) {
        Mode::SignedOut | Mode::Expired => {
          return Err(CommandError::new(
            "vault_signed_out",
            "NIHO アカウントでログインすると選べます。",
          ))
        }
        Mode::OtherAccount { bound } => {
          let pending = namespace_has_pending(
            &self.data_dir,
            &Namespace::Account { account_key: bound },
            &binding.root_id,
          )
          .unwrap_or(true);
          let key = account
            .profile()
            .map(|profile| account_key(&self.env, &profile.user_id));
          match key {
            Some(key) if rebind && !pending => {
              bind_root(&self.data_dir, &binding.root_id, Some(&key)).map_err(|_| bind_failed())?;
            }
            _ => {
              return Err(CommandError::new(
                "vault_other_account",
                "この保存先は別の NIHO アカウントと同期しています。",
              ))
            }
          }
        }
        Mode::Unbound { account_key } => {
          bind_root(&self.data_dir, &binding.root_id, Some(&account_key)).map_err(|_| bind_failed())?;
        }
        Mode::Active { .. } | Mode::Local => {}
      }
    }
    let value = serde_json::to_value(provider).unwrap_or(Value::Null);
    update_vault_settings(&self.data_dir, |vault| {
      vault.insert("provider".into(), value);
    })?;
    let binding_changed = root_binding(&self.data_dir, &context.root).is_ok_and(|binding| binding != context.binding);
    if previous_provider != provider || binding_changed {
      // reconcile の構築や settings の送信を待つ前に、旧 root/context の保管庫通信を止める。
      self.invalidate_context();
    }
    self.put_remote_settings(provider);
    drop(reconcile_guard);
    self.reconcile_with_transition(true).await;
    drop(transition);
    Ok(())
  }
}

async fn forward_events(inner: Weak<CloudInner>, context: Weak<Context>, mut events: broadcast::Receiver<SyncEvent>) {
  loop {
    match events.recv().await {
      Ok(event) => {
        let Some(inner) = inner.upgrade() else {
          return;
        };
        let Some(context) = context.upgrade() else {
          return;
        };
        if !inner.context_is_current(&context) {
          return;
        }
        inner.on_event(context, event);
      }
      Err(broadcast::error::RecvError::Lagged(_)) => continue,
      Err(broadcast::error::RecvError::Closed) => return,
    }
  }
}

/// UI に返すのは検証済みのテキストだけ。写真・音声の bytes は WebView に渡さない。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalFolderExportSnapshot {
  pub generation: u64,
  pub files: Vec<ManifestFile>,
  pub texts: BTreeMap<String, String>,
}

fn local_export_path(path: &str) -> bool {
  let segments: Vec<&str> = path.split('/').collect();
  let safe = |segment: &str| {
    !segment.is_empty()
      && segment.len() <= 200
      && segment
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
  };
  if path == "project.json" || path == "transcript.md" {
    return true;
  }
  if segments.len() == 2 && segments[0] == "pages" && segments[1].ends_with(".md") {
    return safe(segments[1]);
  }
  if segments.len() == 2 && segments[0] == "artifacts" && segments[1].ends_with(".md") {
    return safe(segments[1]);
  }
  if segments.len() == 2 && segments[0] == "assets" && safe(segments[1]) {
    return [".png", ".jpg", ".jpeg", ".gif", ".webp"]
      .iter()
      .any(|suffix| segments[1].to_ascii_lowercase().ends_with(suffix));
  }
  segments.len() >= 3
    && segments[0] == "recordings"
    && safe(segments[1])
    && ((segments.len() == 3 && matches!(segments[2], "recording.json" | "transcript.md"))
      || (segments.len() == 4 && segments[2] == "artifacts" && safe(segments[3]) && segments[3].ends_with(".md")))
}

#[cfg(test)]
mod local_export_path_tests {
  use super::local_export_path;

  #[test]
  fn only_document_text_and_supported_assets_can_leave_the_local_vault() {
    for path in [
      "project.json",
      "transcript.md",
      "pages/page_1.md",
      "artifacts/article_A.md",
      "recordings/rec_1/recording.json",
      "recordings/rec_1/transcript.md",
      "recordings/rec_1/artifacts/article_A.md",
      "assets/photo_1.webp",
    ] {
      assert!(local_export_path(path), "{path}");
    }
    for path in [
      "../secret.md",
      "pages/../secret.md",
      "assets/audio.mp3",
      "recordings/rec_1/audio.wav",
      "recordings/rec_1/artifacts/../../secret.md",
      "private/tokens.json",
    ] {
      assert!(!local_export_path(path), "{path}");
    }
  }
}

impl Cloud {
  fn local_folder_export_target(
    &self,
    project_id: &str,
    generation: Option<u64>,
  ) -> CommandResult<(Arc<Context>, ProjectTarget)> {
    let context = self
      .inner
      .context()
      .ok_or_else(|| CommandError::new("folder_changed", "フォルダを開き直してください。"))?;
    if !self.inner.context_is_current(&context)
      || generation.is_some_and(|expected| expected != context.generation)
      || self
        .inner
        .observed_storage()
        .is_none_or(|storage| storage.mode != StorageMode::Local)
      || context.binding.account_key.as_ref() != self.inner.current_account_key().as_ref()
    {
      return Err(CommandError::new(
        "folder_changed",
        "保存先が変わりました。フォルダを開き直してください。",
      ));
    }
    let target = project_target(&context.root, project_id)
      .ok_or_else(|| CommandError::new("folder_not_found", "フォルダを開き直してください。"))?;
    Ok((context, target))
  }

  pub(crate) fn local_folder_export_snapshot(&self, project_id: &str) -> CommandResult<LocalFolderExportSnapshot> {
    let (context, target) = self.local_folder_export_target(project_id, None)?;
    let state = load_or_default_state(
      &self.inner.data_dir,
      &context.binding.namespace(),
      &context.binding.root_id,
      project_id,
    )
    .map_err(|_| CommandError::new("folder_unreadable", "フォルダの中身を読めませんでした。"))?;
    let scanned = scan_project_target(&target, &state, &context.device.device_id, ScanLimits::default())
      .map_err(|_| CommandError::new("folder_unreadable", "フォルダの中身を読めませんでした。"))?;
    let files: Vec<ManifestFile> = scanned
      .files
      .into_iter()
      .filter(|file| local_export_path(&file.path))
      .collect();
    if files.len() > 1000 || !files.iter().any(|file| file.path == "project.json") {
      return Err(CommandError::new(
        "folder_unreadable",
        "フォルダの中身を読めませんでした。",
      ));
    }
    let mut texts = BTreeMap::new();
    let mut total = 0_u64;
    for file in &files {
      if file.path.starts_with("assets/") {
        continue;
      }
      total = total.saturating_add(file.bytes);
      if file.bytes > 8 * 1024 * 1024 || total > 16 * 1024 * 1024 {
        return Err(CommandError::new("export_too_large", "書き出す内容が大きすぎます。"));
      }
      let mut source = OpenedFileSource::open(&target.working_copy, &file.path, &file.sha256, file.bytes)
        .map_err(|_| CommandError::new("folder_changed", "フォルダが更新されました。"))?;
      let mut bytes = Vec::with_capacity(file.bytes as usize);
      source
        .file_mut()
        .and_then(|opened| opened.read_to_end(&mut bytes).map_err(VaultError::from))
        .map_err(|_| CommandError::new("folder_changed", "フォルダが更新されました。"))?;
      source
        .verify_identity()
        .map_err(|_| CommandError::new("folder_changed", "フォルダが更新されました。"))?;
      let text = String::from_utf8(bytes)
        .map_err(|_| CommandError::new("folder_unreadable", "フォルダの中身を読めませんでした。"))?;
      texts.insert(file.path.clone(), text);
    }
    if !self.inner.context_is_current(&context) {
      return Err(CommandError::new("folder_changed", "保存先が変わりました。"));
    }
    Ok(LocalFolderExportSnapshot {
      generation: context.generation,
      files,
      texts,
    })
  }

  pub(crate) fn local_folder_export_file(
    &self,
    project_id: &str,
    generation: u64,
    path: &str,
    sha256: &str,
    bytes: u64,
  ) -> CommandResult<Vec<u8>> {
    let (context, target) = self.local_folder_export_target(project_id, Some(generation))?;
    if !local_export_path(path) || bytes > 50 * 1024 * 1024 {
      return Err(CommandError::new(
        "invalid_export",
        "書き出すファイルを選び直してください。",
      ));
    }
    let mut source = OpenedFileSource::open(&target.working_copy, path, sha256, bytes)
      .map_err(|_| CommandError::new("folder_changed", "フォルダが更新されました。"))?;
    let mut output = Vec::with_capacity(bytes as usize);
    source
      .file_mut()
      .and_then(|opened| opened.read_to_end(&mut output).map_err(VaultError::from))
      .map_err(|_| CommandError::new("folder_changed", "フォルダが更新されました。"))?;
    source
      .verify_identity()
      .map_err(|_| CommandError::new("folder_changed", "フォルダが更新されました。"))?;
    if output.len() != bytes as usize || !self.inner.context_is_current(&context) {
      return Err(CommandError::new("folder_changed", "フォルダが更新されました。"));
    }
    Ok(output)
  }
  pub(crate) fn allows_cloud_jobs(&self) -> bool {
    self
      .inner
      .observed_storage()
      .is_some_and(|state| state.mode == StorageMode::Cloud)
  }
  /// 起動時（`.setup`）。device.json と保存先の結び付きを読み、保存の口を入れ（画面の最初の書き込みより前）、journal の回復と
  /// ログイン状態の購読を始める。
  pub fn start(app: &tauri::AppHandle, data_dir: &Path, docs_root: &Path, dev: bool) -> Cloud {
    let account = app
      .try_state::<niho_desktop_account::tauri::AccountHandle>()
      .map(|handle| handle.service().clone());
    let (env, niho_environment) = account
      .as_ref()
      .map(|account| {
        let kind = account.env().kind();
        (
          env_name(kind),
          match kind {
            EnvKind::Prod => NihoEnvironment::Production,
            EnvKind::Stg => NihoEnvironment::Staging,
          },
        )
      })
      .unwrap_or(("prod", NihoEnvironment::Production));
    let mut device =
      load_or_create_device(data_dir, &niho_desktop_account::tauri::device_name()).unwrap_or_else(|_| Device {
        device_id: format!("d_{}", store::new_id(22)),
        device_name: niho_desktop_account::tauri::device_name(),
        device_kind: None,
      });
    // commit に添える端末の種類（#18750）。ほかの端末の画面が「Mac で更新されています」と名指す。device.json には書かない。
    // 種類を受け取る API が本番に出た後に送り始めた（それより前の API は `.strict()` で 400 にするため）。
    device.device_kind = Some("mac".into());
    let inner = Arc::new(CloudInner::new(
      Some(app.clone()),
      data_dir,
      account,
      env,
      niho_environment,
      device,
    ));
    inner.cloud_allowed.store(
      cloud_allowed(dev, std::env::var("NIHO_DOCS_CLOUD").ok().as_deref()),
      Ordering::SeqCst,
    );
    store::set_device_id(Some(inner.base_device.device_id.clone()));
    inner.remember_managed_root(docs_root);
    store::set_save_sink(Some(Arc::new(CloudSink {
      inner: Arc::downgrade(&inner),
      managed_roots: inner.managed_roots.clone(),
    })));
    inner.open_root(docs_root);
    tauri::async_runtime::spawn(inner.clone().boot());
    Cloud { inner }
  }

  /// 起動直後の journal の回復が終わるまで待つ（案件の一覧の前。画面を止め続けないよう上限を置く）。
  pub async fn wait_recovered(&self) {
    let mut receiver = self.inner.recovered.subscribe();
    let _ = tokio::time::timeout(RECOVERY_WAIT, receiver.wait_for(|recovered| *recovered)).await;
  }

  /// 「この Mac で続きを受ける」（pc_runner.rs・#18804）が提出して、クラウドに版ができた案件をすぐ同期する
  /// （`cloud_sync_now` と同じ。手元に無い案件はクラウドの一覧を読み直す）。同期していなければ何もしない。
  pub(crate) fn sync_project_now(&self, project_id: &str) {
    let inner = self.inner.clone();
    let Some(context) = inner.active() else {
      return;
    };
    match context.target(project_id) {
      Some(target) => context.schedule(&target, SyncReason::Now),
      None => {
        tauri::async_runtime::spawn(async move {
          inner.refresh_remote(SyncReason::Now).await;
        });
      }
    }
  }

  /// 終了時: engine を止める（通信は待たない）。
  pub fn shutdown(&self) {
    if let Some(context) = self.inner.context() {
      context.engine.shutdown();
    }
  }

  /// 長い処理が始まる時点の Store と namespace を固定する。処理後の同期 Store 書き込みだけに使う。
  pub(crate) async fn capture_operation(&self) -> CommandResult<CapturedOperation> {
    let _reconcile = self.inner.lock_for_capture().await?;
    let context = self
      .inner
      .context()
      .filter(|context| self.inner.context_is_current(context))
      .ok_or_else(|| {
        CommandError::new(
          "store_context_changed",
          "保存先が変わりました。もう一度お試しください。",
        )
      })?;
    let operation = self.inner.acquire_operation()?;
    Ok(CapturedOperation {
      store: Store::new(context.root.clone()),
      context,
      _operation: operation,
    })
  }

  /// 実行の前の lease（engine が動いているときだけ）。別の Mac が持っていれば `lease_held`。通信・ログインの失敗は lease なしで
  /// 続ける。この呼び出しで新しく取ったら true（実行のロックを取れなかったときに返すのは、その lease だけ）。
  pub async fn acquire_lease(&self, project_id: &str) -> CommandResult<bool> {
    let Some(context) = self.inner.active() else {
      return Ok(false);
    };
    // 案件と、フォルダ外のページ（予約の docs-root）だけが lease を持つ（工程・あなたについては実行しない）
    let leasable = project_id == DOCS_ROOT_PROJECT_ID || project_target(&context.root, project_id).is_some();
    if !leasable || self.inner.leases.lock().await.contains_key(project_id) {
      return Ok(false);
    }
    match tokio::time::timeout(LEASE_WAIT, context.engine.acquire_lease(project_id, None)).await {
      Ok(Ok(session)) => {
        let mut leases = self.inner.leases.lock().await;
        if leases.contains_key(project_id) {
          // 通信を待つ間にほかの実行（本人 Mac 実行を含む）が同じ案件の lease を持った: 既存を上書きせず、取った分は返す。
          // この呼び出しで新しく持ったものは無いので false（返り値の意味は変えない）
          drop(leases);
          let _ = tokio::time::timeout(LEASE_WAIT, session.finish()).await;
          return Ok(false);
        }
        leases.insert(project_id.to_string(), HeldLease { session, owner: None });
        Ok(true)
      }
      Ok(Err(VaultError::LeaseHeld { held_by })) => Err(lease_held_error(held_by.as_ref())),
      _ => Ok(false),
    }
  }

  /// 実行が終わった: lease を返して、すぐ同期する。
  pub async fn release_lease(&self, project_id: &str) {
    self.abandon_lease(project_id).await;
    if let Some(context) = self.inner.active() {
      if let Some(target) = context.target(project_id) {
        context.schedule(&target, SyncReason::Now);
      }
    }
  }

  /// 実行のロックを取れなかった: lease だけ返す。
  pub async fn abandon_lease(&self, project_id: &str) {
    let held = self.inner.leases.lock().await.remove(project_id);
    if let Some(held) = held {
      let _ = tokio::time::timeout(LEASE_WAIT, held.session.finish()).await;
    }
  }

  /// 本人 Mac 実行の lease（personal_run.rs）。捕捉した Context の engine で取り、`owner`（実行の lease ID）を付けて持つ。
  /// 既存の `acquire_lease` と違い、通信できない・engine が無いことを `Unavailable` として区別して返す（続けるかは呼び出し側が決める）。
  /// 通信できなくても、最後に読んだクラウドの一覧で別の Mac が期限内の lease を持っていれば `HeldElsewhere`。
  pub(crate) async fn acquire_owned_lease(
    &self,
    operation: &CapturedOperation,
    project_id: &str,
    owner: &str,
  ) -> OwnedLease {
    let context = operation.context.clone();
    let leasable = project_id == DOCS_ROOT_PROJECT_ID || project_target(&context.root, project_id).is_some();
    if !leasable {
      return OwnedLease::Unavailable;
    }
    if self.inner.leases.lock().await.contains_key(project_id) {
      return OwnedLease::AlreadyHeldHere;
    }
    if !context.active || !self.inner.context_is_current(&context) {
      return self.known_remote_lease(project_id).unwrap_or(OwnedLease::Unavailable);
    }
    match tokio::time::timeout(LEASE_WAIT, context.engine.acquire_lease(project_id, None)).await {
      Ok(Ok(session)) => {
        let mut leases = self.inner.leases.lock().await;
        if leases.contains_key(project_id) {
          drop(leases);
          let _ = tokio::time::timeout(LEASE_WAIT, session.finish()).await;
          return OwnedLease::AlreadyHeldHere;
        }
        leases.insert(
          project_id.to_string(),
          HeldLease {
            session,
            owner: Some(owner.to_string()),
          },
        );
        OwnedLease::Acquired
      }
      Ok(Err(VaultError::LeaseHeld { held_by })) => OwnedLease::HeldElsewhere(held_by),
      _ => self.known_remote_lease(project_id).unwrap_or(OwnedLease::Unavailable),
    }
  }

  /// 最後に読んだクラウドの一覧で、別の Mac が持つ期限内の lease。
  fn known_remote_lease(&self, project_id: &str) -> Option<OwnedLease> {
    let remote = lock(&self.inner.remote);
    let lease = remote
      .iter()
      .find(|project| project.project_id == project_id)?
      .lease
      .as_ref()?;
    if lease.mine {
      return None;
    }
    let alive =
      chrono::DateTime::parse_from_rfc3339(&lease.expires_at).is_ok_and(|expires| expires > chrono::Utc::now());
    alive.then(|| {
      OwnedLease::HeldElsewhere(Some(LeaseHeldBy {
        device_name: lease.device_name.clone(),
        since: String::new(),
        expires_at: lease.expires_at.clone(),
      }))
    })
  }

  /// その実行が取った lease が、まだ期限内のままこの Mac にあるか（心拍の失敗・期限切れ・ほかの経路で返された後は false）。
  pub(crate) async fn owned_lease_alive(&self, project_id: &str, owner: &str) -> bool {
    let leases = self.inner.leases.lock().await;
    match leases.get(project_id) {
      Some(held) if held.owner.as_deref() == Some(owner) => held.session.commit_lease_id().await.is_some(),
      _ => false,
    }
  }

  /// その実行が取った lease だけを返す（ほかの lease には触らない）。`network` が false（本人・保存先が捕捉時から変わった）なら
  /// 旧本人の通信をせず、手元の記録だけ捨てる（クラウドの lease は期限で切れる）。返したら true。
  pub(crate) async fn release_owned_lease(
    &self,
    operation: &CapturedOperation,
    project_id: &str,
    owner: &str,
    network: bool,
  ) -> bool {
    let held = {
      let mut leases = self.inner.leases.lock().await;
      match leases.get(project_id) {
        Some(held) if held.owner.as_deref() == Some(owner) => leases.remove(project_id),
        _ => None,
      }
    };
    let Some(held) = held else {
      return false;
    };
    if network {
      let _ = tokio::time::timeout(LEASE_WAIT, held.session.finish()).await;
      let context = &operation.context;
      if context.active && self.inner.context_is_current(context) {
        if let Some(target) = context.target(project_id) {
          context.schedule(&target, SyncReason::Now);
        }
      }
    } else {
      drop(held);
    }
    true
  }

  /// 保存先を変える前に: NIHO クラウドに送っていない変更があれば断る。
  pub fn check_root_change(&self) -> CommandResult<()> {
    if lock(&self.inner.operations).active > 0 {
      return Err(CommandError::new(
        "store_busy",
        "開いている文書の保存が終わってから保存先を変更してください。",
      ));
    }
    if self.inner.provider_kind() != ProviderKind::Niho {
      return Ok(());
    }
    let Some(context) = self.inner.context() else {
      return Ok(());
    };
    let Some(key) = context.binding.account_key.clone() else {
      return Ok(());
    };
    let pending = namespace_has_pending(
      &self.inner.data_dir,
      &Namespace::Account { account_key: key },
      &context.binding.root_id,
    )
    .unwrap_or(true);
    if pending {
      Err(CommandError::new(
        "vault_pending",
        "クラウドに送っていない変更があるため、保存先を変えられません。同期が終わってから変更してください。",
      ))
    } else {
      Ok(())
    }
  }

  /// 新 root を managed として先に閉じ、settings の確定と同じ transition 内で context を付け替える。
  /// 捕捉済み operation/document がある間は archive/rebind を始めない。
  pub async fn commit_root_change(
    &self,
    root: &Path,
    persist: impl FnOnce() -> CommandResult<()>,
  ) -> CommandResult<()> {
    let inner = &self.inner;
    let transition;
    {
      let _guard = inner.reconcile_lock.lock().await;
      self.check_root_change()?;
      {
        let mut state = lock(&inner.operations);
        if state.active > 0 || state.root_transitioning {
          return Err(CommandError::new(
            "store_busy",
            "開いている文書の保存が終わってから保存先を変更してください。",
          ));
        }
        state.root_transitioning = true;
      }
      transition = RootTransitionLease {
        state: inner.operations.clone(),
      };
      // settings が新 root を返す瞬間より前に fail-closed 対象へ入れる。
      inner.remember_managed_root(root);
      persist()?;
      // archive・root の作成より先に旧 provider を無効化する。token 待ちから戻った要求もここで止まる。
      inner.invalidate_context();
      let previous = inner.context();
      if let Some(previous) = &previous {
        previous.engine.shutdown();
      }
      let key = previous
        .as_ref()
        .filter(|_| inner.provider_kind() == ProviderKind::Niho)
        .and_then(|previous| {
          previous
            .binding
            .account_key
            .clone()
            .map(|key| (key, previous.binding.root_id.clone()))
        });
      if let Some((key, old_root_id)) = &key {
        let vault = inner.data_dir.join("vault");
        let source = vault.join(key);
        if source.is_dir() {
          let archive = vault.join("archive");
          let stamp = chrono::Utc::now().timestamp_millis();
          if fs::create_dir_all(&archive).is_ok() {
            let _ = fs::rename(&source, archive.join(format!("{key}-{old_root_id}-{stamp}")));
          }
        }
        let _ = fs::create_dir_all(root);
        if let Ok(binding) = root_binding(&inner.data_dir, root) {
          // 別の本人に結び付いた保存先は、そのまま（「このアカウントで使う」で本人が決める）
          if binding.account_key.is_none() {
            let _ = bind_root(&inner.data_dir, &binding.root_id, Some(key));
          }
        }
      }
      inner.open_root(root);
    }
    inner.recover_all().await;
    inner.reconcile_with_transition(true).await;
    drop(transition);
    Ok(())
  }
}

fn binding_pending_error() -> CommandError {
  CommandError::new(
    "store_binding_pending",
    "クラウドへの移行を準備しています。開いている文書の保存や実行中の処理が終わってから、もう一度お試しください。",
  )
}

fn opened_document_error(error: VaultError) -> CommandError {
  match error {
    VaultError::ConflictChanged => CommandError::new(
      "store_stale_document",
      "開いた後に本文が変わりました。書きかけは残しています。",
    ),
    _ => CommandError::new("store_io", "このMacに保存できませんでした。"),
  }
}

async fn capture_document(inner: Arc<CloudInner>, kind: OpenedDocumentKind) -> CommandResult<OpenedDocument> {
  let _reconcile = inner.lock_for_capture().await?;
  let context = inner
    .context()
    .filter(|context| inner.context_is_current(context))
    .ok_or_else(|| {
      CommandError::new(
        "store_context_changed",
        "保存先が変わりました。もう一度お試しください。",
      )
    })?;
  let operation = inner.acquire_operation()?;
  let store = Store::new(context.root.clone());
  let absolute = match &kind {
    OpenedDocumentKind::Page { project_id, page_id } => store.editable_page_file_at(project_id.as_deref(), page_id)?,
    OpenedDocumentKind::Artifact {
      project_id,
      recording_id,
      step_id,
      source,
    } => store.editable_artifact_file_at(project_id.as_deref(), recording_id, step_id, *source)?,
  };
  let expected_project_id = match &kind {
    OpenedDocumentKind::Page { project_id, .. } | OpenedDocumentKind::Artifact { project_id, .. } => {
      project_id.as_deref().unwrap_or(DOCS_ROOT_PROJECT_ID)
    }
  };
  let (target, path) = locate(&context.root, &absolute)
    .filter(|(target, _)| target.project_id == expected_project_id)
    .ok_or_else(|| CommandError::new("bad_path", "文書の場所が正しくありません。"))?;
  let saver = context.saver.clone();
  let protection = inner.protection.clone();
  let capture_target = target.clone();
  let capture_path = path.clone();
  let capture_root = context.root.clone();
  let capture_absolute = absolute.clone();
  let capture_kind = kind.clone();
  let snapshot = tauri::async_runtime::spawn_blocking(move || {
    saver.capture_text(&capture_target, &capture_path, &protection, || {
      let store = Store::new(capture_root);
      let current = match &capture_kind {
        OpenedDocumentKind::Page { project_id, page_id } => {
          store.current_editable_page_file_at(project_id.as_deref(), page_id)
        }
        OpenedDocumentKind::Artifact {
          project_id,
          recording_id,
          step_id,
          source,
        } => store.current_editable_artifact_file_at(project_id.as_deref(), recording_id, step_id, *source),
      }
      .map_err(|_| VaultError::InvalidPath(capture_path.clone()))?;
      if current == capture_absolute {
        Ok(())
      } else {
        Err(VaultError::InvalidPath(capture_path.clone()))
      }
    })
  })
  .await
  .map_err(|_| CommandError::new("store_io", "本文を読めませんでした。"))?
  .map_err(opened_document_error)?;
  if !inner.context_is_current(&context) {
    inner.protection.release(snapshot.protection_id);
    return Err(CommandError::new(
      "store_context_changed",
      "保存先が変わりました。もう一度お試しください。",
    ));
  }
  let handle = store::new_id(32);
  let markdown = snapshot.text;
  let sha256 = snapshot.sha256.clone();
  let document = CapturedDocument {
    context: context.clone(),
    target,
    path,
    expected_sha256: snapshot.sha256,
    kind,
    _operation: operation,
    _protection: ProtectionLease {
      protection: inner.protection.clone(),
      inner: Arc::downgrade(&inner),
      binding: context.binding.clone(),
      id: snapshot.protection_id,
    },
  };
  lock(&inner.opened_documents).insert(handle.clone(), Arc::new(Mutex::new(document)));
  Ok(OpenedDocument {
    handle,
    context_generation: context.generation,
    scope_id: document_scope_id(&context.binding),
    markdown,
    sha256,
  })
}

async fn save_captured_document(
  inner: Arc<CloudInner>,
  handle: String,
  markdown: String,
) -> CommandResult<Option<u64>> {
  let _reconcile = inner.reconcile_lock.lock().await;
  let document = lock(&inner.opened_documents).get(&handle).cloned().ok_or_else(|| {
    CommandError::new(
      "store_context_changed",
      "保存先が変わりました。書きかけは残しています。",
    )
  })?;
  let save_inner = inner.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let mut document = lock(&document);
    let current = save_inner
      .current_document_context(&document.context.binding)
      .ok_or_else(|| {
        CommandError::new(
          "store_context_changed",
          "保存先が変わりました。書きかけは残しています。",
        )
      })?;
    let receipt = document
      .context
      .saver
      .save_if_current(
        &document.target,
        SaveGroup {
          writes: vec![SaveWrite::Put {
            path: document.path.clone(),
            bytes: markdown.as_bytes().to_vec(),
          }],
          kind: SaveKind::Edit,
        },
        &document.path,
        document.expected_sha256.as_deref(),
      )
      .map_err(opened_document_error)?;
    document.expected_sha256 = Some(format!("{:x}", Sha256::digest(markdown.as_bytes())));
    current.schedule(&document.target, SyncReason::LocalSave);
    Ok(Some(receipt.generation))
  })
  .await
  .map_err(|_| CommandError::new("store_io", "このMacに保存できませんでした。"))?
}

async fn save_captured_artifact_version(
  inner: Arc<CloudInner>,
  handle: String,
  markdown: String,
  record: Value,
) -> CommandResult<u32> {
  let _reconcile = inner.reconcile_lock.lock().await;
  let document = lock(&inner.opened_documents).get(&handle).cloned().ok_or_else(|| {
    CommandError::new(
      "store_context_changed",
      "保存先が変わりました。書きかけは残しています。",
    )
  })?;
  let save_inner = inner.clone();
  tauri::async_runtime::spawn_blocking(move || {
    let mut document = lock(&document);
    let current = save_inner
      .current_document_context(&document.context.binding)
      .ok_or_else(|| {
        CommandError::new(
          "store_context_changed",
          "保存先が変わりました。書きかけは残しています。",
        )
      })?;
    let OpenedDocumentKind::Artifact {
      project_id,
      recording_id,
      step_id,
      source,
    } = &document.kind
    else {
      return Err(CommandError::new("bad_path", "文書の場所が正しくありません。"));
    };
    let sink: Arc<dyn SaveSink> = Arc::new(CapturedDocumentSink {
      context: document.context.clone(),
      path: document.path.clone(),
      expected_sha256: document.expected_sha256.clone(),
    });
    let store = Store::new(document.context.root.clone());
    let version = store::with_captured_save_sink(sink, || {
      store.save_artifact_at(
        project_id.as_deref(),
        recording_id,
        step_id,
        *source,
        &markdown,
        &record,
      )
    })?;
    document.expected_sha256 = Some(format!("{:x}", Sha256::digest(markdown.as_bytes())));
    current.schedule(&document.target, SyncReason::LocalSave);
    Ok(version)
  })
  .await
  .map_err(|_| CommandError::new("store_io", "このMacに保存できませんでした。"))?
}

// ---------------------------------------------------------------------------
// 競合の解決（§8.1）

/// 競合を解決する: 通常の path（と、版を書ける対象なら新しい版・工程の文書なら runs の行）を 1 つの group で保存する。
/// `expected_remote` は画面が見たクラウド側の sha256（None は「クラウドで削除」を見た）。違えばクラウドでまた変わったので
/// 断る（削除を見て「削除する」を選んだ後に、別の Mac が作り直した内容まで消さない）。この Mac の保存の世代を返す。
/// `fetched_remote` は写しを作らない競合（音声・8 MiB を超えるファイル）で、先に provider から取ったクラウド側の内容
/// （`fetch_remote_side`）。写しがあれば写しを使う。
pub(crate) fn resolve_conflict(
  context: &Context,
  target: &ProjectTarget,
  conflict_id: &str,
  choice: ResolveChoice,
  text: Option<String>,
  expected_remote: Option<&str>,
  fetched_remote: Option<Vec<u8>>,
) -> CommandResult<u64> {
  resolve_conflict_guarded(
    context,
    target,
    conflict_id,
    choice,
    text,
    expected_remote,
    fetched_remote.map(FetchedRemote::buffered),
    &|| true,
  )
}

fn resolve_conflict_guarded(
  context: &Context,
  target: &ProjectTarget,
  conflict_id: &str,
  choice: ResolveChoice,
  text: Option<String>,
  expected_remote: Option<&str>,
  fetched_remote: Option<FetchedRemote>,
  is_current: &dyn Fn() -> bool,
) -> CommandResult<u64> {
  let changed = || {
    CommandError::new(
      "conflict_changed",
      "クラウドの内容がまた変わりました。もう一度確かめてください。",
    )
  };
  let failed = || CommandError::new("cloud_conflict_failed", "変更を保存できませんでした。");
  let entries = context.engine.list_conflicts(target).map_err(|_| failed())?;
  let mut entry: ConflictEntry = entries
    .into_iter()
    .find(|entry| entry.conflict_id == conflict_id)
    .ok_or_else(changed)?;
  if entry.remote_sha256.as_deref() != expected_remote {
    return Err(changed());
  }
  // 「この Mac」「両方を残す（手元側）」は、競合検出後に続いた編集を明示的な最新候補として採用する。
  // 大きいファイルだけでなく小さい本文も同じ index 基準へ進め、続く publication の CAS は現在値に対して行う。
  let fresh_local = choice == ResolveChoice::Local
    || (choice == ResolveChoice::Keep && entry.kind != ConflictKind::LocalDeletedRemoteEdited);
  if fresh_local {
    context
      .saver
      .refresh_streamed_conflict_reference(target, conflict_id, expected_remote)
      .map_err(|error| match error {
        VaultError::ConflictChanged => changed(),
        _ => failed(),
      })?;
    entry = context
      .engine
      .list_conflicts(target)
      .map_err(|_| failed())?
      .into_iter()
      .find(|candidate| candidate.conflict_id == conflict_id)
      .ok_or_else(changed)?;
  }
  // この Mac の内容。無いときだけ削除として扱い、読めない（権限・一時的な I/O・ファイルでない）ときは解決をやめる
  let current = || -> CommandResult<(Option<ResolutionContent>, Option<String>)> {
    let path = target.working_copy.join(&entry.path);
    match fs::symlink_metadata(&path) {
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((None, None)),
      Err(_) => Err(failed()),
      Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => Err(failed()),
      Ok(meta) if entry.local_copy.is_none() || meta.len() > TEXT_MAX_BYTES => {
        let expected = entry.local_sha256.as_deref().ok_or_else(changed)?;
        OpenedFileSource::open(&target.working_copy, &entry.path, expected, meta.len())
          .map(ResolutionContent::Streamed)
          .map(|content| (Some(content), Some(expected.to_owned())))
          .map_err(|_| changed())
      }
      Ok(_) => {
        let bytes = fs::read(path).map_err(|_| failed())?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        if entry.local_sha256.as_deref() != Some(sha256.as_str()) {
          return Err(changed());
        }
        Ok((Some(ResolutionContent::Buffered(bytes)), Some(sha256)))
      }
    }
  };
  let mut fetched_remote = fetched_remote;
  let mut remote = || -> CommandResult<ResolutionContent> {
    if let Some(copy) = context
      .engine
      .read_conflict_copy(target, conflict_id, ConflictSide::Remote)
      .map_err(|_| failed())?
    {
      return Ok(ResolutionContent::Buffered(copy));
    }
    // 写しが無い競合は、取ってきた内容がこの競合のクラウド側と同じときだけ使う（取った後で変わっていれば確かめ直す）
    let content = fetched_remote
      .as_mut()
      .and_then(FetchedRemote::take)
      .ok_or_else(failed)?;
    if entry.remote_sha256.as_deref() != Some(content.sha256().as_str()) {
      return Err(changed());
    }
    Ok(content)
  };
  let (content, expected_current): (Option<ResolutionContent>, Option<String>) = match choice {
    ResolveChoice::Local => current()?,
    ResolveChoice::Remote if entry.remote_sha256.is_none() => (None, entry.local_sha256.clone()),
    ResolveChoice::Remote => (Some(remote()?), entry.local_sha256.clone()),
    ResolveChoice::Merged => {
      if FileKind::from_path(&entry.path) != FileKind::Text {
        return Err(failed());
      }
      (
        Some(ResolutionContent::Buffered(text.ok_or_else(failed)?.into_bytes())),
        entry.local_sha256.clone(),
      )
    }
    ResolveChoice::Keep => match entry.kind {
      ConflictKind::LocalDeletedRemoteEdited => (Some(remote()?), entry.local_sha256.clone()),
      _ => current()?,
    },
    ResolveChoice::Delete => (None, entry.local_sha256.clone()),
  };
  let kind = SaveKind::Resolution {
    conflict_id: conflict_id.to_string(),
    remote_sha256: entry.remote_sha256.clone(),
  };
  if !is_current() {
    return Err(failed());
  }
  match content {
    Some(ResolutionContent::Buffered(bytes)) => store::with_write_lock(|| {
      let mut writes = Vec::new();
      writes.push(SaveWrite::Put {
        path: entry.path.clone(),
        bytes: bytes.clone(),
      });
      // 版・runs を同じ group にするのは小さい文書だけ。audio/blob の版を解決時に発明しない。
      let file_kind = FileKind::from_path(&entry.path);
      if matches!(file_kind, FileKind::Text | FileKind::Json)
        && bytes.len() as u64 <= TEXT_MAX_BYTES
        && target.scope.allows_version_of(&entry.path)
        && !is_immutable_version_path(&entry.path)
      {
        let version_path = version_path_for(&entry.path, &new_version_id());
        if let Some((runs_path, runs)) =
          store::resolution_run(&target.working_copy, &entry.path, &version_path, &bytes).map_err(|_| failed())?
        {
          writes.push(SaveWrite::Put {
            path: runs_path,
            bytes: runs,
          });
        }
        writes.push(SaveWrite::Put {
          path: version_path,
          bytes,
        });
      }
      match context.saver.save_if_current(
        target,
        SaveGroup { writes, kind },
        &entry.path,
        expected_current.as_deref(),
      ) {
        Ok(receipt) => Ok(receipt.generation),
        Err(VaultError::ConflictChanged) => Err(changed()),
        Err(_) => Err(failed()),
      }
    }),
    Some(ResolutionContent::Streamed(source)) => {
      let prepared = context
        .saver
        .prepare_streamed(target, entry.path.clone(), source, kind)
        .map_err(|error| match error {
          VaultError::ConflictChanged | VaultError::InvalidResponse(_) | VaultError::Symlink(_) => changed(),
          _ => failed(),
        })?;
      if !is_current() {
        return Err(failed());
      }
      store::with_write_lock(|| {
        if !is_current() {
          return Err(failed());
        }
        match context.saver.commit_streamed(target, prepared) {
          Ok(receipt) => Ok(receipt.generation),
          Err(VaultError::ConflictChanged) => Err(changed()),
          Err(VaultError::InvalidResponse(_) | VaultError::Symlink(_)) => Err(changed()),
          Err(_) => Err(failed()),
        }
      })
    }
    None => store::with_write_lock(|| {
      match context.saver.save_if_current(
        target,
        SaveGroup {
          writes: vec![SaveWrite::Delete {
            path: entry.path.clone(),
          }],
          kind,
        },
        &entry.path,
        expected_current.as_deref(),
      ) {
        Ok(receipt) => Ok(receipt.generation),
        Err(VaultError::ConflictChanged) => Err(changed()),
        Err(_) => Err(failed()),
      }
    }),
  }
}

enum ResolutionContent {
  Buffered(Vec<u8>),
  Streamed(OpenedFileSource),
}

impl ResolutionContent {
  fn sha256(&self) -> String {
    match self {
      Self::Buffered(bytes) => format!("{:x}", Sha256::digest(bytes)),
      Self::Streamed(source) => source.sha256().to_owned(),
    }
  }
}

pub(crate) struct FetchedRemote {
  content: Option<ResolutionContent>,
  temporary: Option<PathBuf>,
}

impl FetchedRemote {
  fn buffered(bytes: Vec<u8>) -> Self {
    Self {
      content: Some(ResolutionContent::Buffered(bytes)),
      temporary: None,
    }
  }

  fn streamed(source: OpenedFileSource, temporary: PathBuf) -> Self {
    Self {
      content: Some(ResolutionContent::Streamed(source)),
      temporary: Some(temporary),
    }
  }

  fn take(&mut self) -> Option<ResolutionContent> {
    self.content.take()
  }
}

impl Drop for FetchedRemote {
  fn drop(&mut self) {
    self.content.take();
    if let Some(path) = self.temporary.take() {
      let _ = fs::remove_file(path);
    }
  }
}

/// 写しを作らない競合（音声・8 MiB を超えるファイル。engine の protect_conflicts）で「クラウドの内容を使う」「残す」を選んだ
/// ときに、解決の前に provider からクラウド側の内容を取る。写しがある・クラウド側が要らないときは None（§8.1）。
pub(crate) async fn fetch_remote_side(
  context: &Context,
  target: &ProjectTarget,
  conflict_id: &str,
  choice: &ResolveChoice,
) -> CommandResult<Option<FetchedRemote>> {
  let failed = || CommandError::new("cloud_conflict_failed", "変更を保存できませんでした。");
  let changed = || {
    CommandError::new(
      "conflict_changed",
      "クラウドの内容がまた変わりました。もう一度確かめてください。",
    )
  };
  let entries = context.engine.list_conflicts(target).map_err(|_| failed())?;
  let Some(entry) = entries.into_iter().find(|entry| entry.conflict_id == conflict_id) else {
    return Ok(None);
  };
  let needs_remote = match choice {
    ResolveChoice::Remote => entry.remote_sha256.is_some(),
    ResolveChoice::Keep => entry.kind == ConflictKind::LocalDeletedRemoteEdited,
    _ => false,
  };
  if !needs_remote || entry.remote_copy.is_some() {
    return Ok(None);
  }
  // 前回の取得中にローカル候補が変わった場合、前回 commit は CAS で拒否される。
  // 利用者が明示的に再試行したこの境界でだけ、現在の opened file を次の CAS 基準へ更新する。
  context
    .saver
    .refresh_streamed_conflict_reference(target, conflict_id, entry.remote_sha256.as_deref())
    .map_err(|error| match error {
      VaultError::ConflictChanged => changed(),
      _ => failed(),
    })?;
  let file = entry.remote_file.clone().ok_or_else(failed)?;
  if !entry.remote_available || !file.available {
    return Err(CommandError::new(
      "cloud_conflict_failed",
      "クラウドの音声は保存期限が過ぎているため、使えません。",
    ));
  }
  let provider = context.provider.clone().ok_or_else(|| {
    CommandError::new(
      "cloud_conflict_failed",
      "NIHO に接続できないため、クラウドの内容を取得できません。",
    )
  })?;
  // 大きいファイルは一時ファイルへ逐次で下ろす（provider が byte 数と sha256 を照合する）
  let name = crate::process::hex(&crate::process::random_bytes::<8>().map_err(|_| failed())?);
  let path = std::env::temp_dir().join(format!("niho-docs-conflict-{name}.tmp"));
  let result = async {
    let mut temporary = fs::OpenOptions::new()
      .create_new(true)
      .read(true)
      .write(true)
      .open(&path)
      .map_err(|_| failed())?;
    match provider
      .download_blob_file(&target.project_id, &file, &mut temporary)
      .await
    {
      Ok(true) => {
        temporary.sync_all().map_err(|_| failed())?;
        // Small documents still need the existing version + runs publication group.
        // Only this bounded text path may become a Vec; audio/blob stays streamed.
        if matches!(file.kind, FileKind::Text | FileKind::Json) && file.bytes <= TEXT_MAX_BYTES {
          use std::io::{Read, Seek, SeekFrom};
          temporary.seek(SeekFrom::Start(0)).map_err(|_| failed())?;
          let mut bytes = Vec::with_capacity(file.bytes as usize);
          temporary
            .by_ref()
            .take(file.bytes.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| failed())?;
          if bytes.len() as u64 != file.bytes || format!("{:x}", Sha256::digest(&bytes)) != file.sha256 {
            return Err(changed());
          }
          return Ok(FetchedRemote {
            content: Some(ResolutionContent::Buffered(bytes)),
            temporary: Some(path.clone()),
          });
        }
        OpenedFileSource::from_opened(temporary, path.clone(), &file.sha256, file.bytes)
          .map(|source| FetchedRemote::streamed(source, path.clone()))
          .map_err(|_| changed())
      }
      Ok(false) => Err(CommandError::new(
        "cloud_conflict_failed",
        "クラウドの内容が見つかりません。",
      )),
      Err(error) => Err(vault_command_error(
        "cloud_conflict_failed",
        "クラウドの内容を取得できませんでした。",
        &error,
      )),
    }
  }
  .await;
  if result.is_err() {
    let _ = fs::remove_file(&path);
  }
  result.map(Some)
}

// ---------------------------------------------------------------------------
// commands（apps/docs/src/lib/bridge.ts の cloud… と writeArtifactDraft）

/// 文書ページを、remote apply と同じ gate 上で保護してから読む。
#[tauri::command]
pub async fn open_page_document(
  cloud: State<'_, Cloud>,
  project_id: Option<String>,
  page_id: String,
) -> CommandResult<OpenedDocument> {
  capture_document(cloud.inner.clone(), OpenedDocumentKind::Page { project_id, page_id }).await
}

/// 現在の文字起こし／成果物を、remote apply と同じ gate 上で保護してから読む。
#[tauri::command]
pub async fn open_artifact_document(
  cloud: State<'_, Cloud>,
  project_id: Option<String>,
  recording_id: String,
  step_id: String,
  source: bool,
) -> CommandResult<OpenedDocument> {
  capture_document(
    cloud.inner.clone(),
    OpenedDocumentKind::Artifact {
      project_id,
      recording_id,
      step_id,
      source,
    },
  )
  .await
}

/// capture が見た本文と同じときだけ、その capture の namespace へ書く。
#[tauri::command]
pub async fn save_opened_document(
  cloud: State<'_, Cloud>,
  handle: String,
  markdown: String,
) -> CommandResult<Option<u64>> {
  save_captured_document(cloud.inner.clone(), handle, markdown).await
}

/// capture に結び付いた成果物を、現在本文・版・runs の 1 group として保存する。
#[tauri::command]
pub async fn save_opened_artifact(
  cloud: State<'_, Cloud>,
  handle: String,
  markdown: String,
  record: Value,
) -> CommandResult<u32> {
  save_captured_artifact_version(cloud.inner.clone(), handle, markdown, record).await
}

/// 編集保護を外し、延期中の remote apply を予約する。既に context 変更で破棄済みなら何もしない。
#[tauri::command]
pub async fn release_opened_document(cloud: State<'_, Cloud>, handle: String) -> CommandResult<()> {
  lock(&cloud.inner.opened_documents).remove(&handle);
  Ok(())
}

#[tauri::command]
pub async fn cloud_state(cloud: State<'_, Cloud>) -> CommandResult<CloudState> {
  Ok(cloud.inner.state())
}

/// 初回のユーザー単位の保存先選択。応答消失時は GET で正を読み直す。
#[tauri::command]
pub async fn cloud_storage_select(cloud: State<'_, Cloud>, mode: StorageMode) -> CommandResult<CloudState> {
  cloud.inner.select_initial_storage(mode).await
}

/// この Mac の全量と無料枠を確認し、LOCAL→CLOUD の確認画面へ渡す。
#[tauri::command]
pub async fn cloud_storage_reopening_preview(cloud: State<'_, Cloud>) -> CommandResult<ReopeningPreview> {
  cloud.inner.local_reopening_preview().await
}

/// 未公開 baseline の送信・全量照合・外部決定・公開を順に行う。途中で落ちても同じ試行から再開する。
#[tauri::command]
pub async fn cloud_storage_reopen(state: State<'_, AppState>, cloud: State<'_, Cloud>) -> CommandResult<CloudState> {
  let busy = {
    let run_locks = state
      .run_locks
      .lock()
      .map_err(|_| CommandError::new("run_lock", "実行状態を確認できませんでした。"))?;
    crate::busy_running(&state, &run_locks)?
  };
  if busy {
    return Err(CommandError::new(
      "vault_busy",
      "実行が終わってから保存先を切り替えてください。",
    ));
  }
  cloud.inner.reopen_local_storage().await
}

#[tauri::command]
pub async fn cloud_storage_closing_preview(cloud: State<'_, Cloud>) -> CommandResult<ClosingPreview> {
  cloud.inner.closing_preview().await
}

#[tauri::command]
pub async fn cloud_storage_closing_prepare(
  state: State<'_, AppState>,
  cloud: State<'_, Cloud>,
) -> CommandResult<PreparedClosing> {
  let busy = {
    let run_locks = state
      .run_locks
      .lock()
      .map_err(|_| CommandError::new("run_lock", "実行状態を確認できませんでした。"))?;
    crate::busy_running(&state, &run_locks)?
  };
  if busy {
    return Err(CommandError::new(
      "vault_busy",
      "実行が終わってから保存先を切り替えてください。",
    ));
  }
  cloud.inner.prepare_closing().await
}

#[tauri::command]
pub async fn cloud_storage_closing_confirm(
  cloud: State<'_, Cloud>,
  prepared: PreparedClosing,
) -> CommandResult<CloudState> {
  cloud.inner.confirm_closing(prepared).await
}

#[tauri::command]
pub async fn cloud_storage_closing_cancel(cloud: State<'_, Cloud>) -> CommandResult<()> {
  cloud.inner.closing_cancel_requested.store(true, Ordering::SeqCst);
  Ok(())
}

/// 保存先を NIHO クラウドにする（別のアカウントの保存先をこのアカウントで使う `rebind` のとき。保存先は NIHO クラウドだけで、
/// 「この Mac だけ」は開発・試験の起動の外では断る。#18728。実行中は切り替えない）。
#[tauri::command]
pub async fn cloud_set_provider(
  state: State<'_, AppState>,
  cloud: State<'_, Cloud>,
  provider: ProviderKind,
  rebind: Option<bool>,
) -> CommandResult<CloudState> {
  let busy = {
    let run_locks = state
      .run_locks
      .lock()
      .map_err(|_| CommandError::new("run_lock", "実行状態を確認できませんでした。"))?;
    crate::busy_running(&state, &run_locks)?
  };
  if busy {
    return Err(CommandError::new(
      "vault_busy",
      "実行が終わってから保存先を切り替えてください。",
    ));
  }
  let inner = cloud.inner.clone();
  inner.set_provider(provider, rebind.unwrap_or(false)).await?;
  Ok(inner.state())
}

/// この Mac の名前（空に戻すと Mac の名前）。lease と競合の表示に使う。
#[tauri::command]
pub async fn cloud_set_device_name(cloud: State<'_, Cloud>, name: String) -> CommandResult<CloudState> {
  let inner = cloud.inner.clone();
  let name = device_name_override(&name);
  let value = name.clone().map(Value::from).unwrap_or(Value::Null);
  update_vault_settings(&inner.data_dir, |vault| {
    vault.insert("deviceName".into(), value);
  })?;
  *lock(&inner.device_name) = name.unwrap_or_else(|| inner.base_device.device_name.clone());
  inner.reconcile().await;
  Ok(inner.state())
}

#[tauri::command]
pub async fn cloud_project_status(cloud: State<'_, Cloud>, project_id: String) -> CommandResult<ProjectStatusReply> {
  let Some(context) = cloud.inner.context() else {
    return Ok(ProjectStatusReply {
      context_generation: cloud.inner.context_generation.load(Ordering::SeqCst),
      snapshot: None,
    });
  };
  let context_generation = context.generation;
  if !cloud.inner.context_is_current(&context) {
    return Ok(ProjectStatusReply {
      context_generation,
      snapshot: None,
    });
  }
  let snapshot = context
    .target(&project_id)
    .and_then(|target| context.engine.project_snapshot(&target).ok());
  Ok(ProjectStatusReply {
    context_generation,
    snapshot,
  })
}

fn page_sharing_client(inner: &Arc<CloudInner>, context: &Arc<Context>) -> CommandResult<NihoProvider> {
  if !context.active || !inner.context_is_current(context) {
    return Err(CommandError::new(
      "share_login_required",
      "NIHO にログインしてから共有できます。",
    ));
  }
  let account = inner
    .account
    .clone()
    .ok_or_else(|| CommandError::new("share_login_required", "NIHO にログインしてから共有できます。"))?;
  let ticket = context
    .session
    .clone()
    .ok_or_else(|| CommandError::new("share_login_required", "NIHO にログインしてから共有できます。"))?;
  let token: Arc<dyn IdTokenProvider> = Arc::new(ExpectedSessionToken {
    account,
    ticket,
    context: Some(ContextFence {
      inner: Arc::downgrade(inner),
      generation: context.generation,
      binding: context.binding.clone(),
    }),
  });
  NihoProvider::new(inner.niho_environment, token)
    .map_err(|error| vault_command_error("share_unavailable", "共有を確認できませんでした。", &error))
}

fn page_sharing_synced(context: &Context, project_id: &str) -> bool {
  let Some(target) = context.target(project_id) else {
    return false;
  };
  let Ok(snapshot) = context.engine.project_snapshot(&target) else {
    return false;
  };
  snapshot.revision > 0
    && snapshot.last_synced_at.is_some()
    && snapshot.last_error.is_none()
    && snapshot.tombstone.is_none()
    && snapshot.local_generation == snapshot.acknowledged_generation
    && !snapshot.syncing
    && !snapshot.pending_mutation
    && snapshot.dirty.is_empty()
    && snapshot.conflicts.is_empty()
    && snapshot.deferred.is_empty()
    && snapshot.quota_paths.is_empty()
    && snapshot.blocked.is_empty()
}

#[tauri::command]
pub async fn cloud_page_share_get(
  cloud: State<'_, Cloud>,
  page_id: String,
  project_id: String,
  text_id: Option<String>,
) -> CommandResult<Value> {
  let inner = cloud.inner.clone();
  let context = inner
    .active()
    .ok_or_else(|| CommandError::new("share_login_required", "NIHO にログインしてから共有できます。"))?;
  let client = page_sharing_client(&inner, &context)?;
  client
    .get_docs_page_sharing(&page_id, &project_id, text_id.as_deref())
    .await
    .map_err(|error| vault_command_error("share_unavailable", "共有を確認できませんでした。", &error))
}

#[tauri::command]
pub async fn cloud_page_share_set(
  cloud: State<'_, Cloud>,
  page_id: String,
  project_id: String,
  text_id: Option<String>,
  published: bool,
) -> CommandResult<Value> {
  let inner = cloud.inner.clone();
  let context = inner
    .active()
    .ok_or_else(|| CommandError::new("share_login_required", "NIHO にログインしてから共有できます。"))?;
  if published && !page_sharing_synced(&context, &project_id) {
    return Err(CommandError::new(
      "share_not_synced",
      "保存が終わってから共有できます。",
    ));
  }
  let client = page_sharing_client(&inner, &context)?;
  client
    .set_docs_page_sharing(&page_id, &project_id, text_id.as_deref(), published)
    .await
    .map_err(|error| vault_command_error("share_unavailable", "共有を変更できませんでした。", &error))
}

#[tauri::command]
pub async fn cloud_page_share_rotate(
  cloud: State<'_, Cloud>,
  page_id: String,
  project_id: String,
  text_id: Option<String>,
  expected_public_id: String,
) -> CommandResult<Value> {
  let inner = cloud.inner.clone();
  let context = inner
    .active()
    .ok_or_else(|| CommandError::new("share_login_required", "NIHO にログインしてから共有できます。"))?;
  let client = page_sharing_client(&inner, &context)?;
  client
    .rotate_docs_page_sharing(&page_id, &project_id, text_id.as_deref(), &expected_public_id)
    .await
    .map_err(|error| vault_command_error("share_unavailable", "リンクを作り直せませんでした。", &error))
}

#[tauri::command]
pub fn cloud_page_share_open(cloud: State<'_, Cloud>, url: String) -> CommandResult<()> {
  let host = match cloud.inner.niho_environment {
    NihoEnvironment::Production => "niho.life",
    NihoEnvironment::Staging => "app-stg.niho.life",
  };
  validate_public_docs_share_url(&url, host)?;
  tauri_plugin_opener::open_url(url, None::<&str>)
    .map_err(|_| CommandError::new("share_open_failed", "共有ページを開けませんでした。"))
}

fn validate_public_docs_share_url(url: &str, host: &str) -> CommandResult<()> {
  let parsed = reqwest::Url::parse(url).map_err(|_| bad_id())?;
  let public_id = parsed.fragment().ok_or_else(bad_id)?;
  if parsed.scheme() != "https"
    || parsed.host_str() != Some(host)
    || parsed.port().is_some()
    || !parsed.username().is_empty()
    || parsed.password().is_some()
    || parsed.path() != "/docs/p"
    || parsed.query().is_some()
    || public_id.len() != 22
    || !public_id
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
  {
    return Err(bad_id());
  }
  Ok(())
}

/// クラウドの案件の一覧（同期していなければ空。通信できなければ空を返し、状態の文言で知らせる）。
#[tauri::command]
pub async fn cloud_remote_projects(cloud: State<'_, Cloud>) -> CommandResult<RemoteProjectsReply> {
  let inner = cloud.inner.clone();
  let context = inner.context();
  let context_generation = context
    .as_ref()
    .map(|context| context.generation)
    .unwrap_or_else(|| inner.context_generation.load(Ordering::SeqCst));
  let reply = match context.filter(|context| context.active) {
    Some(context) => inner.refresh_remote_for(context, SyncReason::Periodic).await,
    None => None,
  };
  Ok(reply.unwrap_or(RemoteProjectsReply {
    context_generation,
    projects: Vec::new(),
  }))
}

/// クラウドで削除した案件（回収前のもの）。
#[tauri::command]
pub async fn cloud_deleted_projects(cloud: State<'_, Cloud>) -> CommandResult<Vec<DeletedProject>> {
  let inner = cloud.inner.clone();
  let Some(context) = inner.active() else {
    return Ok(Vec::new());
  };
  let Some(provider) = context.provider.clone() else {
    return Ok(Vec::new());
  };
  match provider.list_projects(false, true).await {
    Ok(projects) if inner.context_is_current(&context) => Ok(
      projects
        .into_iter()
        .map(|project| DeletedProject {
          project_id: project.project_id,
          name: project.name,
          deleted_at: project.deleted_at,
        })
        .collect(),
    ),
    Ok(_) => Ok(Vec::new()),
    Err(error) => {
      if inner.context_is_current(&context) && error.is_offline() {
        inner.set_offline(true);
      }
      Ok(Vec::new())
    }
  }
}

/// クラウドにだけある案件を開く: 案件のフォルダを作って文書から下ろす（音声は後ろで）。project.json が届けば成功。
#[tauri::command]
pub async fn cloud_open_project(cloud: State<'_, Cloud>, project_id: String) -> CommandResult<()> {
  let inner = cloud.inner.clone();
  let open_failed = || CommandError::new("cloud_open_failed", "クラウドから開けませんでした。");
  let context = inner.active().ok_or_else(|| inner.inactive_error())?;
  let target = project_target(&context.root, &project_id).ok_or_else(bad_id)?;
  fs::create_dir_all(&target.working_copy).map_err(|_| open_failed())?;
  let mut name = lock(&inner.remote)
    .iter()
    .find(|remote| remote.project_id == project_id)
    .map(|remote| remote.name.clone());
  if name.is_none() {
    name = inner
      .refresh_remote_for(context.clone(), SyncReason::Periodic)
      .await
      .and_then(|remote| {
        remote
          .projects
          .into_iter()
          .find(|project| project.project_id == project_id)
      })
      .map(|project| project.name);
  }
  let options = SyncOptions {
    project_name: name,
    force: true,
    ..SyncOptions::default()
  };
  let _ = context.engine.sync(&target, options).await;
  if target.working_copy.join("project.json").is_file() {
    inner.emit_snapshot(&context, &project_id);
    // 一覧の「この Mac にもある」を新しくする
    tauri::async_runtime::spawn(async move {
      inner.refresh_remote(SyncReason::Periodic).await;
    });
    return Ok(());
  }
  // 何も届かなかった空のフォルダは残さない
  let empty = fs::read_dir(&target.working_copy).is_ok_and(|mut entries| entries.next().is_none());
  if empty {
    let _ = fs::remove_dir(&target.working_copy);
  }
  Err(open_failed())
}

/// クラウドで削除した案件を元に戻す。
#[tauri::command]
pub async fn cloud_restore_project(cloud: State<'_, Cloud>, project_id: String) -> CommandResult<()> {
  let inner = cloud.inner.clone();
  let context = inner.active().ok_or_else(|| inner.inactive_error())?;
  let target = project_target(&context.root, &project_id).ok_or_else(bad_id)?;
  let provider = context.provider.clone().ok_or_else(|| inner.inactive_error())?;
  provider
    .restore_project(&project_id)
    .await
    .map_err(|error| vault_command_error("cloud_restore_failed", "元に戻せませんでした。", &error))?;
  if !inner.context_is_current(&context) {
    return Err(inner.inactive_error());
  }
  if target.working_copy.join("project.json").is_file() {
    context.schedule(&target, SyncReason::Now);
  }
  let refresh = inner.clone();
  tauri::async_runtime::spawn(async move {
    refresh.refresh_remote(SyncReason::Periodic).await;
  });
  Ok(())
}

/// 別の Mac で削除された案件の手元の変更をどうするか（クラウドに戻す／手元を退避する）。
#[tauri::command]
pub async fn cloud_tombstone_choice(
  cloud: State<'_, Cloud>,
  project_id: String,
  choice: TombstoneChoiceWire,
) -> CommandResult<()> {
  let inner = cloud.inner.clone();
  let context = inner.active().ok_or_else(|| inner.inactive_error())?;
  let target = project_target(&context.root, &project_id).ok_or_else(bad_id)?;
  let mut options = inner.flight_options(&target).await;
  options.force = true;
  let restore = matches!(choice, TombstoneChoiceWire::Restore);
  options.tombstone_choice = Some(if restore {
    TombstoneChoice::Restore
  } else {
    TombstoneChoice::MoveLocalAside
  });
  match context.engine.sync(&target, options).await {
    Ok(status) => tombstone_choice_result(restore, &status),
    Err(error) => Err(vault_command_error(
      "cloud_sync_failed",
      "同期できませんでした。",
      &error,
    )),
  }
}

/// 削除された案件の選択（復元・手元から消す）が実際に済んだか。通信できない・ログインが要る・待ち・選択待ちのままは、
/// 済んだことにしない（画面が「復元しました」「手元から消しました」と知らせて閉じないように）。
pub(crate) fn tombstone_choice_result(restore: bool, status: &SyncStatus) -> CommandResult<()> {
  let not_done = |message: &str| Err(CommandError::new("cloud_tombstone_incomplete", message));
  match status {
    SyncStatus::Offline => {
      not_done("NIHO に接続できないため、まだ済んでいません。接続してから、もう一度選んでください。")
    }
    SyncStatus::AuthRequired => {
      not_done("ログインが必要なため、まだ済んでいません。ログインしてから、もう一度選んでください。")
    }
    SyncStatus::Backoff { .. } => {
      not_done("同期を少し待っているため、まだ済んでいません。しばらくしてから、もう一度選んでください。")
    }
    SyncStatus::TombstoneChoiceRequired | SyncStatus::LocalOnly | SyncStatus::Failed { .. } => {
      not_done("まだ済んでいません。もう一度選んでください。")
    }
    // 手元から消すのは、写しを退避できたときだけ済んだことにする
    SyncStatus::MovedDeletedProject { .. } => Ok(()),
    _ if restore => Ok(()),
    _ => not_done("まだ済んでいません。もう一度選んでください。"),
  }
}

/// 今すぐ同期（backoff を越える）。null は送っていない案件・flows・profile と、クラウドで変わった案件。
#[tauri::command]
pub async fn cloud_sync_now(cloud: State<'_, Cloud>, project_id: Option<String>) -> CommandResult<()> {
  let inner = cloud.inner.clone();
  let Some(context) = inner.active() else {
    return Ok(());
  };
  match project_id {
    Some(project_id) => {
      let target = context.target(&project_id).ok_or_else(bad_id)?;
      context.schedule(&target, SyncReason::Now);
    }
    None => {
      inner.schedule_startup(&context);
      tauri::async_runtime::spawn(async move {
        inner.refresh_remote(SyncReason::Now).await;
      });
    }
  }
  Ok(())
}

/// 窓の前面化・表示中の 5 分ごと: 開いている案件を確かめ（backoff は守る）、クラウドの一覧を読み直す（`cloud://remote`）。
#[tauri::command]
pub async fn cloud_focus(cloud: State<'_, Cloud>, project_id: Option<String>) -> CommandResult<()> {
  let inner = cloud.inner.clone();
  inner.reconcile().await;
  let Some(context) = inner.active() else {
    return Ok(());
  };
  if let Some(target) = project_id.as_deref().and_then(|project_id| context.target(project_id)) {
    context.schedule(&target, SyncReason::Periodic);
  }
  tauri::async_runtime::spawn(async move {
    inner.refresh_remote(SyncReason::Periodic).await;
  });
  Ok(())
}

/// 開いている文書の path を守る（その間に届いた別の Mac の変更は反映を延ばす）。解除用の id を返す。
#[tauri::command]
pub async fn cloud_protect(cloud: State<'_, Cloud>, project_id: String, paths: Vec<String>) -> CommandResult<u64> {
  let target = target_for(Path::new("/"), &project_id).ok_or_else(bad_id)?;
  let paths = paths
    .iter()
    .map(|path| {
      // flows の対象の中の path は `<flowId>.json`（保存先からの `flows/<flowId>.json` も受け取る）
      let path = if project_id == FLOWS_PROJECT_ID {
        path.strip_prefix("flows/").unwrap_or(path)
      } else {
        path.as_str()
      };
      (validate_relative_path(path).is_ok()
        && !is_sync_ignored(path)
        && !is_private_path(path)
        && target.scope.contains(path))
      .then(|| path.to_string())
    })
    .collect::<Option<Vec<String>>>()
    .ok_or_else(|| CommandError::new("bad_path", "文書の場所が正しくありません。"))?;
  Ok(cloud.inner.protection.protect(&project_id, paths))
}

/// 守りを外し、延ばしていた変更をすぐ反映する。
#[tauri::command]
pub async fn cloud_release(cloud: State<'_, Cloud>, id: u64) -> CommandResult<()> {
  let inner = cloud.inner.clone();
  if let Some((project_id, _)) = inner.protection.release(id) {
    if let Some(context) = inner.active() {
      if let Some(target) = context.target(&project_id) {
        context.schedule(&target, SyncReason::Now);
      }
    }
  }
  Ok(())
}

#[tauri::command]
pub async fn cloud_conflicts(cloud: State<'_, Cloud>, project_id: String) -> CommandResult<Vec<ConflictEntry>> {
  let Some(context) = cloud.inner.context() else {
    return Ok(Vec::new());
  };
  if !cloud.inner.context_is_current(&context) {
    return Ok(Vec::new());
  }
  let target = context.target(&project_id).ok_or_else(bad_id)?;
  Ok(context.engine.list_conflicts(&target).unwrap_or_default())
}

/// 競合の片側の本文（UTF-8 の文書だけ。無い・バイナリは null）。
#[tauri::command]
pub async fn cloud_conflict_copy(
  cloud: State<'_, Cloud>,
  project_id: String,
  conflict_id: String,
  side: ConflictSide,
) -> CommandResult<Option<String>> {
  let Some(context) = cloud.inner.context() else {
    return Ok(None);
  };
  if !cloud.inner.context_is_current(&context) {
    return Ok(None);
  }
  let target = context.target(&project_id).ok_or_else(bad_id)?;
  Ok(
    context
      .engine
      .read_conflict_copy(&target, &conflict_id, side)
      .ok()
      .flatten()
      .and_then(text_of),
  )
}

/// 競合を解決する（`merged` は文書だけ。確かめている間にクラウドでまた変わったら `conflict_changed`）。
#[tauri::command]
pub async fn cloud_resolve_conflict(
  cloud: State<'_, Cloud>,
  project_id: String,
  conflict_id: String,
  choice: ResolveChoice,
  text: Option<String>,
  remote_sha256: Option<String>,
) -> CommandResult<()> {
  let inner = cloud.inner.clone();
  let context = inner
    .context()
    .ok_or_else(|| CommandError::new("cloud_conflict_failed", "変更を保存できませんでした。"))?;
  let target = context.target(&project_id).ok_or_else(bad_id)?;
  let fetched_remote = fetch_remote_side(&context, &target, &conflict_id, &choice).await?;
  let _reconcile_guard = inner.reconcile_lock.lock().await;
  if !inner.context_is_current(&context) {
    return Err(CommandError::new(
      "cloud_conflict_failed",
      "変更を保存できませんでした。",
    ));
  }
  let resolved_context = context.clone();
  let resolved_target = target.clone();
  let resolved_inner = inner.clone();
  tauri::async_runtime::spawn_blocking(move || {
    resolve_conflict_guarded(
      &resolved_context,
      &resolved_target,
      &conflict_id,
      choice,
      text,
      remote_sha256.as_deref(),
      fetched_remote,
      &|| resolved_inner.context_is_current(&resolved_context),
    )
  })
  .await
  .map_err(|_| CommandError::new("cloud_conflict_failed", "変更を保存できませんでした。"))??;
  if !inner.context_is_current(&context) {
    return Err(CommandError::new(
      "cloud_conflict_failed",
      "変更を保存できませんでした。",
    ));
  }
  context.schedule(&target, SyncReason::Now);
  inner.emit_snapshot(&context, &project_id);
  Ok(())
}

/// クラウドの使用量（同期していない・通信できなければ null）。
#[tauri::command]
pub async fn cloud_usage(cloud: State<'_, Cloud>) -> CommandResult<Option<Usage>> {
  let inner = cloud.inner.clone();
  let Some(context) = inner.active() else {
    return Ok(None);
  };
  let Some(provider) = context.provider.clone() else {
    return Ok(None);
  };
  match provider.usage().await {
    Ok(usage) if inner.context_is_current(&context) => {
      inner.set_offline(false);
      Ok(Some(usage))
    }
    Ok(_) => Ok(None),
    Err(error) => {
      if inner.context_is_current(&context) && error.is_offline() {
        inner.set_offline(true);
      }
      Ok(None)
    }
  }
}

/// この Mac の案件をクラウドに上げる（途中からなら続き。失敗した案件はもう一度）。
#[tauri::command]
pub async fn cloud_migration_start(cloud: State<'_, Cloud>) -> CommandResult<CloudState> {
  let inner = cloud.inner.clone();
  let context = inner.active().ok_or_else(|| inner.inactive_error())?;
  inner.start_migration(context);
  Ok(inner.state())
}

/// 移行を中断する（今の案件が終わったところで止まる。「再開する」まで続けない）。
#[tauri::command]
pub async fn cloud_migration_cancel(cloud: State<'_, Cloud>) -> CommandResult<CloudState> {
  let inner = cloud.inner.clone();
  let running = {
    let run = lock(&inner.migration);
    run.cancel.store(true, Ordering::SeqCst);
    run.running
  };
  if !running {
    if let Some(context) = inner.context() {
      if let Some(key) = context.binding.account_key.as_deref() {
        // 途中で止まっている移行（アプリを閉じた・ログアウトした）は、次に始めたときに続けない
        if let Some(mut file) = read_migration(&inner.data_dir, key)
          .filter(|file| file.root_id == context.binding.root_id && file.unfinished())
        {
          file.cancelled = true;
          write_migration(&inner.data_dir, key, &file);
        }
      }
    }
  }
  Ok(inner.state())
}

/// 最新の成果物・文字起こしの書きかけを今の path に自動保存する（版は作らない）。保存の世代（無ければ null）を返す。
#[tauri::command]
pub async fn write_artifact_draft(
  state: State<'_, AppState>,
  project_id: Option<String>,
  recording_id: String,
  step_id: String,
  source: bool,
  markdown: String,
) -> CommandResult<Option<u64>> {
  let store = state.store();
  tauri::async_runtime::spawn_blocking(move || {
    store.write_artifact_draft(project_id.as_deref(), &recording_id, &step_id, source, &markdown)
  })
  .await
  .map_err(|_| CommandError::new("store_io", "このMacに保存できませんでした。"))?
  .map_err(CommandError::from)
}

/// 本人 Mac 実行のテスト（personal_run_tests.rs）が、通信しない Cloud を組み立てるための口。
#[cfg(test)]
impl Cloud {
  pub(crate) fn for_tests(data_dir: &Path, account: Option<Arc<AccountService>>) -> Cloud {
    let cloud = Cloud {
      inner: Arc::new(CloudInner::new(
        None,
        data_dir,
        account,
        "prod",
        NihoEnvironment::Production,
        Device {
          device_id: "d_test".into(),
          device_name: "Studio".into(),
          device_kind: None,
        },
      )),
    };
    cloud.inner.storage_gate_enabled.store(false, Ordering::SeqCst);
    cloud
  }

  pub(crate) fn test_open_root(&self, root: &Path) {
    self.inner.open_root(root);
  }

  pub(crate) async fn test_reconcile(&self) {
    self.inner.reconcile().await;
  }

  /// 今の結び付きと本人の session のまま、同期する口を偽の provider で入れる（通信しない）。
  pub(crate) fn test_install_active(&self, provider: Arc<dyn VaultProvider>) {
    let inner = &self.inner;
    let current = inner.context().expect("context");
    let ticket = inner
      .account
      .as_ref()
      .expect("account")
      .session_ticket()
      .expect("session");
    let device = inner.device();
    let engine = SyncEngine::new(
      provider.clone(),
      &inner.data_dir,
      current.binding.namespace(),
      current.binding.root_id.clone(),
      device.clone(),
      inner.protection.clone(),
    );
    let context = Context {
      generation: inner.next_context_generation(),
      root: current.root.clone(),
      saver: engine.saver(),
      engine,
      active: true,
      provider: Some(provider),
      binding: current.binding.clone(),
      device,
      session: Some(ticket),
    };
    inner.install(Arc::new(context));
  }

  pub(crate) fn test_set_remote(&self, remote: Vec<RemoteProject>) {
    *lock(&self.inner.remote) = remote;
  }

  pub(crate) async fn test_rebind(&self) -> CommandResult<()> {
    self.inner.set_provider(ProviderKind::Niho, true).await
  }

  /// 心拍の失敗・ほかの経路での返却の代わりに、手元の lease の記録だけを消す。
  pub(crate) async fn test_forget_lease(&self, project_id: &str) {
    self.inner.leases.lock().await.remove(project_id);
  }

  /// lease の記録の lock を持ったままにする（本人 Mac 実行の lease の確認を await の途中で止める）。
  pub(crate) async fn test_hold_leases(&self) -> impl Sized + '_ {
    self.inner.leases.lock().await
  }

  pub(crate) async fn test_has_lease(&self, project_id: &str) -> bool {
    self.inner.leases.lock().await.contains_key(project_id)
  }

  pub(crate) fn test_stop(&self) {
    lock(&self.inner.migration).cancel.store(true, Ordering::SeqCst);
    if let Some(context) = self.inner.context() {
      context.engine.shutdown();
    }
  }
}

#[cfg(test)]
#[path = "cloud_tests.rs"]
mod tests;

#[cfg(test)]
mod reopening_marker_tests {
  use super::*;

  fn temp_dir() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
      "niho-docs-reopening-marker-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
    ));
    fs::create_dir_all(&path).unwrap();
    path
  }

  #[test]
  fn baseline_attempt_requires_a_durable_matching_marker_before_resume() {
    assert!(!baseline_marker_requires_abort(true, false, false, false));
    assert!(!baseline_marker_requires_abort(false, true, true, true));
    assert!(baseline_marker_requires_abort(false, false, false, false));
    assert!(baseline_marker_requires_abort(false, true, false, false));
    assert!(baseline_marker_requires_abort(false, true, true, false));
    assert!(baseline_marker_requires_abort(true, true, false, false));
  }

  fn storage(mode: StorageMode, epoch: &str) -> StorageState {
    StorageState {
      mode,
      epoch: epoch.to_string(),
      changed_at: None,
      cleanup_pending: false,
      quota_bytes: FREE_QUOTA_BYTES,
      closing: None,
    }
  }

  #[test]
  fn marker_keeps_local_content_blocked_until_the_target_epoch_is_confirmed() {
    let data_dir = temp_dir();
    let marker = LocalReopeningMarker {
      reopening_id: "reopening_1".into(),
      source_epoch: "1".into(),
      target_epoch: "2".into(),
      fingerprint: "a".repeat(64),
    };
    write_local_reopening_marker(&data_dir, &marker).unwrap();

    assert!(local_reopening_pending(
      &data_dir,
      Some(&storage(StorageMode::Local, "1"))
    ));
    assert!(local_reopening_pending(
      &data_dir,
      Some(&storage(StorageMode::Cloud, "3"))
    ));
    assert!(!local_reopening_pending(
      &data_dir,
      Some(&storage(StorageMode::Cloud, "2"))
    ));
    assert!(!local_reopening_marker_exists(&data_dir));

    fs::remove_dir_all(data_dir).unwrap();
  }
}
