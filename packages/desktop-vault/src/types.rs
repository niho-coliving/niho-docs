use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const FLOWS_PROJECT_ID: &str = "flows";
/// 保存先直下の共有文書・録音・画像だけを同期する予約 projectId。
pub const DOCS_ROOT_PROJECT_ID: &str = "docs-root";
/// 保存先ルートの本人共通 profile JSON を 1 ユーザーにつき 1 つ同期する予約 projectId。
pub const PROFILE_PROJECT_ID: &str = "profile";
const PAGES_JSON_VERSION_NAMESPACE: &str =
    "d82acfd083c8736e72b534852675307bc68bc98baf8e34c39ed57a2a191d551b";
const ABOUT_JSON_VERSION_NAMESPACE: &str =
    "646bd422594fa181f6e2fca4e1da7504a5fe35dbfbc8cb11c0b4b47813916086";
const EXECUTION_JSON_VERSION_NAMESPACE: &str =
    "899250d2ce590e1880b044c7da884b922c2092119d65582809b427c2e108d7af";
/// フォルダ外のページの対象が直接見るファイルと、歩くフォルダ（保存先ルートからの相対）。
pub const DOCS_ROOT_FILES: &[&str] = &["pages.json"];
pub const DOCS_ROOT_DIRS: &[&str] = &[
    "pages",
    "recordings",
    "page-chats",
    "assets",
    "versions/files",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
    pub device_name: String,
    /// commit に添える端末の種類（"mac" / "browser" / "phone"）。device.json には書かない（起動する app が決める）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_kind: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Local,
    Niho,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSettings {
    pub provider: ProviderKind,
    /// 行が無い端末では null。
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum VaultError {
    #[error("不正なパスです: {0}")]
    InvalidPath(String),
    #[error("symlink は同期できません: {0}")]
    Symlink(String),
    #[error("ファイル数の上限を超えました")]
    TooManyFiles,
    #[error("blob の上限を超えました: {0}")]
    BlobTooLarge(String),
    #[error("I/O error: {0}")]
    Io(#[from] Arc<std::io::Error>),
    #[error("JSON error: {0}")]
    Json(#[from] Arc<serde_json::Error>),
    #[error("HTTP error: {0}")]
    Http(#[from] Arc<reqwest::Error>),
    #[error("API {status} {code}: {message}")]
    Api {
        status: u16,
        code: String,
        message: String,
    },
    #[error("revision conflict")]
    RevisionConflict,
    #[error("quota exceeded: {path}")]
    QuotaExceeded { path: String },
    #[error("project was deleted")]
    ProjectDeleted,
    #[error("project is running on another device")]
    LeaseHeld { held_by: Option<LeaseHeldBy> },
    #[error("automatic sync is waiting for retry window")]
    Backoff,
    #[error("offline: {0}")]
    Offline(String),
    #[error("sync requires a tombstone choice")]
    TombstoneChoiceRequired,
    #[error("invalid response: {0}")]
    InvalidResponse(String),
    #[error("login is required")]
    AuthRequired,
    #[error("this app connection is not allowed")]
    Forbidden,
    #[error("rate limited")]
    RateLimited,
    #[error("mutationId was reused with a different payload")]
    MutationMismatch,
    #[error("outbox entry {mutation_id} requires manual recovery: {reason}")]
    OutboxRecoveryRequired { mutation_id: String, reason: String },
    #[error("immutable version path: {path}")]
    ImmutableVersion { path: String },
    #[error("blob is missing on the server")]
    BlobMissing,
    #[error("project is being cleaned up")]
    ProjectBusy,
    #[error("project was purged")]
    ProjectPurged,
    #[error("conflict changed before the resolution was saved")]
    ConflictChanged,
    #[error("namespace mismatch: {0}")]
    NamespaceMismatch(String),
    #[error("sync engine was shut down")]
    ShutDown,
}

impl From<std::io::Error> for VaultError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(Arc::new(error))
    }
}
impl From<serde_json::Error> for VaultError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(Arc::new(error))
    }
}
impl From<reqwest::Error> for VaultError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(Arc::new(error))
    }
}

impl VaultError {
    pub fn is_revision_conflict(&self) -> bool {
        matches!(self, Self::RevisionConflict)
    }

    pub fn is_offline(&self) -> bool {
        matches!(self, Self::Offline(_) | Self::Http(_))
    }

    /// 時間を置けば通る失敗（通信断・5xx・429・回収中）。
    pub fn is_retryable_later(&self) -> bool {
        matches!(
            self,
            Self::Offline(_)
                | Self::Http(_)
                | Self::RateLimited
                | Self::ProjectBusy
                | Self::Backoff
        )
    }

    /// commit の結果が分からない失敗。同じ mutationId・payload で再送する。
    pub fn is_unknown_result(&self) -> bool {
        matches!(
            self,
            Self::Offline(_)
                | Self::Http(_)
                | Self::RateLimited
                | Self::ProjectBusy
                | Self::InvalidResponse(_)
        )
    }

    /// ログインし直すまで通らない失敗。
    pub fn is_auth_required(&self) -> bool {
        matches!(self, Self::AuthRequired | Self::Forbidden)
    }
}

pub type Result<T> = std::result::Result<T, VaultError>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LeaseHeldBy {
    pub device_name: String,
    pub since: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub kind: FileKind,
    pub modified_at: String,
    pub writer_device_id: String,
    /// 最後に書いた端末の種類。種類を送らない旧 client・サーバーの書き込み・以前の版は None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writer_device_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_until: Option<String>,
    #[serde(default = "default_true")]
    pub available: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Text,
    Json,
    Audio,
    Other,
}

impl FileKind {
    pub fn from_path(path: &str) -> Self {
        let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        match extension.as_str() {
            "md" | "txt" => Self::Text,
            "json" | "jsonl" => Self::Json,
            "m4a" | "mp3" | "wav" | "aac" | "aifc" | "caf" | "ogg" | "flac" => Self::Audio,
            _ => Self::Other,
        }
    }

    pub fn content_type(self, path: &str) -> &'static str {
        match (
            self,
            path.rsplit('.')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
        ) {
            (Self::Text, "md") => "text/markdown",
            (Self::Text, _) => "text/plain",
            (Self::Json, "jsonl") => "application/x-ndjson",
            (Self::Json, _) => "application/json",
            (Self::Audio, "m4a") => "audio/mp4",
            (Self::Audio, "mp3") => "audio/mpeg",
            (Self::Audio, "wav") => "audio/wav",
            (Self::Audio, "aac") => "audio/aac",
            (Self::Audio, "aifc") => "audio/aifc",
            (Self::Audio, "caf") => "audio/x-caf",
            (Self::Audio, "ogg") => "audio/ogg",
            (Self::Audio, "flac") => "audio/flac",
            _ => "application/octet-stream",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default = "schema_version")]
    pub schema_version: u8,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub files: Vec<ManifestFile>,
}

fn schema_version() -> u8 {
    1
}

impl Manifest {
    pub fn empty(project_id: impl Into<String>) -> Self {
        Self {
            schema_version: 1,
            project_id: project_id.into(),
            name: String::new(),
            revision: 0,
            deleted: false,
            updated_at: String::new(),
            files: Vec::new(),
        }
    }

    pub fn by_path(&self) -> BTreeMap<String, ManifestFile> {
        self.files
            .iter()
            .cloned()
            .map(|entry| (entry.path.clone(), entry))
            .collect()
    }
}

/// 同期の対象。working copy は案件フォルダ（`docs-root` / `profile` は保存先ルート）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectTarget {
    pub project_id: String,
    pub working_copy: PathBuf,
    pub scope: SyncScope,
}

impl ProjectTarget {
    pub fn new(project_id: impl Into<String>, working_copy: impl Into<PathBuf>) -> Self {
        Self {
            project_id: project_id.into(),
            working_copy: working_copy.into(),
            scope: SyncScope::All,
        }
    }

    /// 保存先ルートの本人共通 JSON を `profile` として同期する対象。
    pub fn profile(docs_root: impl Into<PathBuf>) -> Self {
        Self {
            project_id: PROFILE_PROJECT_ID.to_owned(),
            working_copy: docs_root.into(),
            scope: SyncScope::Profile,
        }
    }

    /// 保存先直下の narrow allowlist だけを `docs-root` として同期する対象。
    pub fn docs_root(docs_root: impl Into<PathBuf>) -> Self {
        Self {
            project_id: DOCS_ROOT_PROJECT_ID.to_owned(),
            working_copy: docs_root.into(),
            scope: SyncScope::Root,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncScope {
    /// 通常案件フォルダ。wire scope は FOLDER。
    All,
    /// 保存先直下の docs-root allowlist。wire scope は ROOT。
    Root,
    /// `about.json`・`execution.json` とその immutable JSON version だけ。wire scope は FOLDER。
    Profile,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProjectWireScope {
    Root,
    Folder,
}

impl SyncScope {
    pub fn contains(&self, path: &str) -> bool {
        match self {
            Self::All => true,
            Self::Root => is_docs_vault_root_path_allowed(path),
            Self::Profile => {
                path == "about.json"
                    || path == "execution.json"
                    || is_version_path(path, ABOUT_JSON_VERSION_NAMESPACE, "json")
                    || is_version_path(path, EXECUTION_JSON_VERSION_NAMESPACE, "json")
            }
        }
    }

    pub fn is_all(&self) -> bool {
        matches!(self, Self::All)
    }

    pub fn wire_scope(&self) -> ProjectWireScope {
        match self {
            Self::Root => ProjectWireScope::Root,
            Self::All | Self::Profile => ProjectWireScope::Folder,
        }
    }

    /// 元 path の immutable version がこの scope に属するか。
    pub fn allows_version_of(&self, path: &str) -> bool {
        match self {
            Self::All => true,
            Self::Profile => path == "about.json" || path == "execution.json",
            Self::Root => {
                path == "pages.json"
                    || path.ends_with(".md")
                    || path
                        .strip_prefix("assets/")
                        .is_some_and(is_supported_root_image)
            }
        }
    }
}

fn is_safe_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// 保管庫の不変の版の ID（`v_` ＋ base64url 22 字。`new_version_id` の形）。
pub fn is_version_id(value: &str) -> bool {
    value.strip_prefix("v_").is_some_and(|rest| {
        rest.len() == 22
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    })
}

fn is_version_path(path: &str, namespace: &str, extension: &str) -> bool {
    let Some(rest) = path.strip_prefix("versions/files/") else {
        return false;
    };
    let Some((sha256, filename)) = rest.split_once('/') else {
        return false;
    };
    let Some(version_id) = filename.strip_suffix(&format!(".{extension}")) else {
        return false;
    };
    sha256 == namespace && is_version_id(version_id)
}

/// API の `isDocsVaultRootPathAllowed` と同じ docs-root wire allowlist。
pub fn is_docs_vault_root_path_allowed(path: &str) -> bool {
    if path == "pages.json" {
        return true;
    }
    if let Some(id) = path
        .strip_prefix("pages/")
        .and_then(|rest| rest.strip_suffix(".md"))
    {
        return is_safe_id(id);
    }
    if let Some(rest) = path.strip_prefix("recordings/") {
        if let Some((id, child)) = rest.split_once('/') {
            return is_safe_id(id) && !child.is_empty();
        }
    }
    if let Some(rest) = path.strip_prefix("page-chats/") {
        return is_root_page_chat_path(rest);
    }
    if let Some(rest) = path.strip_prefix("assets/") {
        return is_supported_root_image(rest);
    }
    let Some(rest) = path.strip_prefix("versions/files/") else {
        return false;
    };
    let Some((namespace, filename)) = rest.split_once('/') else {
        return false;
    };
    if !is_sha256(namespace) {
        return false;
    }
    if let Some(version_id) = filename.strip_suffix(".md") {
        return namespace != PAGES_JSON_VERSION_NAMESPACE && is_version_id(version_id);
    }
    if namespace == PAGES_JSON_VERSION_NAMESPACE
        && filename.strip_suffix(".json").is_some_and(is_version_id)
    {
        return true;
    }
    ["jpg", "jpeg", "png", "webp"].iter().any(|extension| {
        filename
            .strip_suffix(&format!(".{extension}"))
            .is_some_and(is_version_id)
    })
}

/// 文書ページの「AIと作る」のやり取り（`<pageId>/conversations/<id>.json`・`<pageId>/runs/<id>.json`・`<pageId>/runs.jsonl`）。
fn is_root_page_chat_path(path: &str) -> bool {
    let Some((page_id, child)) = path.split_once('/') else {
        return false;
    };
    if !is_safe_id(page_id) {
        return false;
    }
    if child == "runs.jsonl" {
        return true;
    }
    ["conversations/", "runs/"].iter().any(|prefix| {
        child
            .strip_prefix(prefix)
            .and_then(|name| name.strip_suffix(".json"))
            .is_some_and(is_safe_id)
    })
}

fn is_supported_root_image(path: &str) -> bool {
    ["jpg", "jpeg", "png", "webp"].iter().any(|extension| {
        path.strip_suffix(&format!(".{extension}"))
            .is_some_and(is_safe_id)
    })
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BlockedReason {
    TooLarge,
    EmptyAudio,
    PrivatePath,
    ImmutableVersion,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncErrorKind {
    Offline,
    AuthRequired,
    Quota,
    RateLimited,
    Server,
    Invalid,
    Tombstone,
    Purged,
    MutationMismatch,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncErrorInfo {
    pub kind: SyncErrorKind,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TombstoneInfo {
    pub needs_choice: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultState {
    #[serde(default = "state_schema_version")]
    pub schema_version: u8,
    #[serde(default)]
    pub account_key: Option<String>,
    #[serde(default)]
    pub root_id: String,
    pub project_id: String,
    #[serde(default)]
    pub base_revision: u64,
    /// 実際に適用／確定した path だけを進める。
    #[serde(default)]
    pub base: Vec<ManifestFile>,
    #[serde(default)]
    pub dirty: BTreeMap<String, u64>,
    #[serde(default)]
    pub dirty_generation: u64,
    #[serde(default)]
    pub local_generation: u64,
    /// この世代までのローカル変更はクラウドと一致している。
    #[serde(default)]
    pub acknowledged_generation: u64,
    /// outbox の mutationId。古い順。
    #[serde(default)]
    pub pending_mutations: Vec<String>,
    #[serde(default)]
    pub deferred_remote: BTreeMap<String, ManifestFile>,
    #[serde(default)]
    pub deferred_deletes: BTreeSet<String>,
    /// complete まで済んだ音声 blob。
    #[serde(default)]
    pub confirmed_blobs: BTreeSet<String>,
    #[serde(default)]
    pub blocked: BTreeMap<String, BlockedReason>,
    #[serde(default)]
    pub quota_paths: BTreeSet<String>,
    #[serde(default)]
    pub expired_audio: BTreeSet<String>,
    /// `.conflicts/index.json` の未解決 path → conflictId（app data だけで未解決を数えるための写し）。
    #[serde(default)]
    pub conflicts: BTreeMap<String, String>,
    /// 同じ保存で書いた依存 group（世代 → path）。
    #[serde(default)]
    pub groups: BTreeMap<u64, Vec<String>>,
    #[serde(default)]
    pub last_synced_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<SyncErrorInfo>,
    #[serde(default)]
    pub retry_after: Option<String>,
    #[serde(default)]
    pub conflict_failures: u8,
    #[serde(default)]
    pub tombstone: Option<TombstoneInfo>,
}

fn state_schema_version() -> u8 {
    2
}

impl VaultState {
    pub fn empty(project_id: impl Into<String>) -> Self {
        Self::new(project_id, String::new(), None)
    }

    pub fn new(
        project_id: impl Into<String>,
        root_id: impl Into<String>,
        account_key: Option<String>,
    ) -> Self {
        Self {
            schema_version: 2,
            account_key,
            root_id: root_id.into(),
            project_id: project_id.into(),
            base_revision: 0,
            base: Vec::new(),
            dirty: BTreeMap::new(),
            dirty_generation: 0,
            local_generation: 0,
            acknowledged_generation: 0,
            pending_mutations: Vec::new(),
            deferred_remote: BTreeMap::new(),
            deferred_deletes: BTreeSet::new(),
            confirmed_blobs: BTreeSet::new(),
            blocked: BTreeMap::new(),
            quota_paths: BTreeSet::new(),
            expired_audio: BTreeSet::new(),
            conflicts: BTreeMap::new(),
            groups: BTreeMap::new(),
            last_synced_at: None,
            last_error: None,
            retry_after: None,
            conflict_failures: 0,
            tombstone: None,
        }
    }

    pub fn mark_dirty(&mut self, path: impl Into<String>) -> u64 {
        self.mark_dirty_paths([path.into()])
    }

    /// 複数 path を同じ新しい世代で dirty にする。
    pub fn mark_dirty_paths(&mut self, paths: impl IntoIterator<Item = String>) -> u64 {
        self.dirty_generation = self.dirty_generation.saturating_add(1);
        self.local_generation = self.dirty_generation;
        for path in paths {
            self.dirty.insert(path, self.dirty_generation);
        }
        self.dirty_generation
    }

    pub fn base_file(&self, path: &str) -> Option<&ManifestFile> {
        self.base.iter().find(|file| file.path == path)
    }

    pub(crate) fn set_base(&mut self, file: ManifestFile) {
        match self
            .base
            .binary_search_by(|candidate| candidate.path.as_str().cmp(&file.path))
        {
            Ok(index) => self.base[index] = file,
            Err(index) => self.base.insert(index, file),
        }
    }

    pub(crate) fn remove_base(&mut self, path: &str) {
        if let Ok(index) = self
            .base
            .binary_search_by(|candidate| candidate.path.as_str().cmp(path))
        {
            self.base.remove(index);
        }
    }

    pub(crate) fn sort_base(&mut self) {
        self.base.sort_by(|left, right| left.path.cmp(&right.path));
        self.base.dedup_by(|left, right| left.path == right.path);
    }

    /// dirty・未確定 mutation・未解決競合・延期中の remote のどれかがある。
    pub fn has_pending_work(&self) -> bool {
        !self.dirty.is_empty()
            || !self.pending_mutations.is_empty()
            || !self.conflicts.is_empty()
            || !self.deferred_remote.is_empty()
            || !self.deferred_deletes.is_empty()
    }

    /// 確定済みの世代の水位線を dirty から計算し直す（単調）。
    pub(crate) fn refresh_acknowledged(&mut self) {
        let watermark = match self.dirty.values().min() {
            Some(oldest) => oldest.saturating_sub(1),
            None => self.dirty_generation,
        };
        self.acknowledged_generation = self.acknowledged_generation.max(watermark);
        self.local_generation = self.local_generation.max(self.dirty_generation);
        let dirty = &self.dirty;
        self.groups.retain(|generation, paths| {
            paths
                .iter()
                .any(|path| dirty.get(path).is_some_and(|value| value == generation))
        });
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScannedCopy {
    pub files: Vec<ManifestFile>,
    pub dirty_generation: u64,
    /// 走査では送れないと分かった path（上限超過・空の音声・秘密）。
    pub blocked: BTreeMap<String, BlockedReason>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Transfer {
    Upload(ManifestFile),
    Download(ManifestFile),
    DeleteRemote(String),
    DeleteLocal(String),
    /// 保護中の path の remote 更新。staging に取り置き、base は進めない。
    Defer(ManifestFile),
    /// 保護中の path の remote 削除。
    DeferDelete(String),
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    Edit,
    AddAdd,
    LocalDeletedRemoteEdited,
    RemoteDeletedLocalEdited,
    Version,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConflictPlan {
    pub path: String,
    pub base: Option<ManifestFile>,
    pub local: Option<ManifestFile>,
    pub remote: Option<ManifestFile>,
    pub kind: ConflictKind,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MergePlan {
    pub transfers: Vec<Transfer>,
    pub conflicts: Vec<ConflictPlan>,
    /// 行の和集合が要る runs.jsonl（どの階層でも）。
    pub runs_union: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictStatus {
    Open,
    Resolving,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSide {
    Local,
    Remote,
}

/// `sync` は remote との競合、`recovery` は再起動時の journal と現在のファイルの食い違い。
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictOrigin {
    Sync,
    Recovery,
}

/// `.conflicts/index.json` の 1 件。copy と version path は working copy からの相対 path。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictEntry {
    pub conflict_id: String,
    pub path: String,
    pub kind: ConflictKind,
    pub origin: ConflictOrigin,
    pub status: ConflictStatus,
    pub base_sha256: Option<String>,
    pub local_sha256: Option<String>,
    pub remote_sha256: Option<String>,
    pub remote_revision: u64,
    pub remote_device_id: Option<String>,
    pub remote_modified_at: Option<String>,
    pub local_modified_at: Option<String>,
    pub local_version_id: Option<String>,
    pub remote_version_id: Option<String>,
    pub local_version_path: Option<String>,
    pub remote_version_path: Option<String>,
    pub local_copy: Option<String>,
    pub remote_copy: Option<String>,
    pub remote_available: bool,
    pub resolution_generation: Option<u64>,
    /// 解決で base に置く remote の版（remote 側が削除なら null）。
    pub remote_file: Option<ManifestFile>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSummary {
    pub conflict_id: String,
    pub path: String,
    pub kind: ConflictKind,
    pub status: ConflictStatus,
    /// クラウド側を変えた端末（画面が「スマホでも変更されています」のように名指す）。
    pub remote_device_id: Option<String>,
    pub remote_device_kind: Option<String>,
}

/// クラウドの版を書いた端末（取り込みを待っている path ごと）。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWriter {
    pub device_id: String,
    pub device_kind: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlockedPath {
    pub path: String,
    pub reason: BlockedReason,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AudioTransferState {
    Queued,
    Uploading,
    Uploaded,
    Downloading,
    Downloaded,
    Failed,
}

/// UI 向けの案件の同期状態。通信しないで読む。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSyncSnapshot {
    pub project_id: String,
    pub revision: u64,
    pub syncing: bool,
    pub local_generation: u64,
    pub acknowledged_generation: u64,
    pub dirty: BTreeMap<String, u64>,
    pub pending_mutation: bool,
    pub conflicts: Vec<ConflictSummary>,
    pub deferred: Vec<String>,
    /// deferred のうちクラウドの版を待っている path の書き手（画面が「スマホで更新されています」のように名指す）。
    pub remote_writers: BTreeMap<String, RemoteWriter>,
    pub quota_paths: Vec<String>,
    pub blocked: Vec<BlockedPath>,
    pub expired_audio: Vec<String>,
    pub audio: BTreeMap<String, AudioTransferState>,
    pub last_synced_at: Option<String>,
    pub last_error: Option<SyncErrorInfo>,
    pub retry_after: Option<String>,
    pub tombstone: Option<TombstoneInfo>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitUpsert {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub modified_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    /// 16 バイト乱数の base64url（22 字）。送信前に outbox へ固定する。
    pub mutation_id: String,
    pub device_id: String,
    /// 書いた端末の種類。種類を足す前に outbox へ固定した依頼は None のまま、同じ本文で送り直す。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_kind: Option<String>,
    pub base_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub upserts: Vec<CommitUpsert>,
    pub deletes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitResponse {
    pub mutation_id: String,
    pub revision: u64,
    pub replayed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum BlobReservation {
    #[serde(rename = "exists")]
    Exists,
    #[serde(rename = "stored")]
    Stored,
    #[serde(rename = "upload")]
    Upload {
        upload_id: String,
        method: UploadMethod,
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        expires_at: String,
    },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UploadMethod {
    Put,
    Resumable,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub lease_id: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub project_id: String,
    pub name: String,
    pub revision: u64,
    pub updated_at: String,
    pub bytes: u64,
    #[serde(default)]
    pub lease: Option<LeaseSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseSummary {
    pub device_name: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub used_bytes: u64,
    pub reserved_bytes: u64,
    pub quota_bytes: u64,
    pub audio_bytes: u64,
    pub projects: Vec<ProjectUsage>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    pub project_id: String,
    pub bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TombstoneChoice {
    Restore,
    MoveLocalAside,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SyncStatus {
    Synced {
        revision: u64,
    },
    Pending {
        revision: u64,
        paths: Vec<String>,
    },
    Offline,
    TombstoneChoiceRequired,
    MovedDeletedProject {
        path: PathBuf,
    },
    Partial {
        revision: u64,
        quota_paths: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        blocked_paths: Vec<String>,
    },
    Backoff {
        retry_after: String,
    },
    LocalOnly,
    AuthRequired,
    Purged,
    /// 利用者の確認を待つ競合が残っている。
    Conflicted {
        revision: u64,
        paths: Vec<String>,
    },
    /// 上のどれにも当たらない失敗。
    Failed {
        error: SyncErrorInfo,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SyncEvent {
    Syncing {
        project_id: String,
    },
    LocalSaved {
        project_id: String,
        generation: u64,
        paths: Vec<String>,
    },
    Committed {
        project_id: String,
        revision: u64,
        paths: Vec<String>,
    },
    Conflict {
        project_id: String,
        conflict_id: String,
        path: String,
        kind: ConflictKind,
    },
    Deferred {
        project_id: String,
        path: String,
    },
    Applied {
        project_id: String,
        paths: Vec<String>,
    },
    Audio {
        project_id: String,
        path: String,
        state: AudioTransferState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Quota {
        project_id: String,
        path: String,
    },
    Offline {
        project_id: String,
        message: String,
    },
    Expired {
        project_id: String,
        path: String,
    },
    Tombstone {
        project_id: String,
        needs_choice: bool,
    },
    Done {
        project_id: String,
        status: SyncStatus,
    },
}

#[derive(Clone, Debug)]
pub struct SyncOptions {
    pub project_name: Option<String>,
    pub running: bool,
    pub lease_id: Option<String>,
    pub tombstone_choice: Option<TombstoneChoice>,
    pub max_revision_retries: usize,
    pub conflict_backoff: [Duration; 3],
    /// true は利用者の「今すぐ同期」。保存済み backoff を無視する。
    pub force: bool,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            project_name: None,
            running: false,
            lease_id: None,
            tombstone_choice: None,
            max_revision_retries: 3,
            conflict_backoff: [
                Duration::from_secs(60),
                Duration::from_secs(120),
                Duration::from_secs(240),
            ],
            force: false,
        }
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;

    #[test]
    fn rust_events_match_the_typescript_json_fixture() {
        assert_eq!(
            serde_json::to_value(SyncScope::Root.wire_scope()).unwrap(),
            serde_json::json!("ROOT")
        );
        assert_eq!(
            serde_json::to_value(SyncScope::Profile.wire_scope()).unwrap(),
            serde_json::json!("FOLDER")
        );
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../ts/contract-fixtures.json")).unwrap();
        for path in expected["rootPaths"]["allowed"].as_array().unwrap() {
            assert!(
                is_docs_vault_root_path_allowed(path.as_str().unwrap()),
                "allowed root path fixture was rejected: {path}"
            );
        }
        for path in expected["rootPaths"]["rejected"].as_array().unwrap() {
            assert!(
                !is_docs_vault_root_path_allowed(path.as_str().unwrap()),
                "rejected root path fixture was accepted: {path}"
            );
        }
        let events = vec![
            SyncEvent::Syncing {
                project_id: "p123".into(),
            },
            SyncEvent::LocalSaved {
                project_id: "p123".into(),
                generation: 7,
                paths: vec!["pages/p1.md".into()],
            },
            SyncEvent::Committed {
                project_id: "p123".into(),
                revision: 4,
                paths: vec!["pages/p1.md".into()],
            },
            SyncEvent::Conflict {
                project_id: "p123".into(),
                conflict_id: "c_AAAAAAAAAAAAAAAAAAAAAA".into(),
                path: "page.md".into(),
                kind: ConflictKind::Edit,
            },
            SyncEvent::Deferred {
                project_id: "p123".into(),
                path: "page.md".into(),
            },
            SyncEvent::Applied {
                project_id: "p123".into(),
                paths: vec!["page.md".into()],
            },
            SyncEvent::Audio {
                project_id: "p123".into(),
                path: "inputs/a.m4a".into(),
                state: AudioTransferState::Queued,
                message: None,
            },
            SyncEvent::Audio {
                project_id: "p123".into(),
                path: "inputs/a.m4a".into(),
                state: AudioTransferState::Failed,
                message: Some("NIHO に接続できません".into()),
            },
            SyncEvent::Quota {
                project_id: "p123".into(),
                path: "audio.m4a".into(),
            },
            SyncEvent::Offline {
                project_id: "p123".into(),
                message: "offline".into(),
            },
            SyncEvent::Expired {
                project_id: "p123".into(),
                path: "old.m4a".into(),
            },
            SyncEvent::Tombstone {
                project_id: "p123".into(),
                needs_choice: true,
            },
            SyncEvent::Done {
                project_id: "p123".into(),
                status: SyncStatus::Synced { revision: 3 },
            },
            SyncEvent::Done {
                project_id: "p123".into(),
                status: SyncStatus::Pending {
                    revision: 4,
                    paths: vec!["page.md".into()],
                },
            },
            SyncEvent::Done {
                project_id: "p123".into(),
                status: SyncStatus::Conflicted {
                    revision: 5,
                    paths: vec!["page.md".into()],
                },
            },
            SyncEvent::Done {
                project_id: "p123".into(),
                status: SyncStatus::Failed {
                    error: SyncErrorInfo {
                        kind: SyncErrorKind::MutationMismatch,
                        message: "送信済みの変更を確認できません".into(),
                    },
                },
            },
            SyncEvent::Done {
                project_id: "p123".into(),
                status: SyncStatus::AuthRequired,
            },
        ];
        assert_eq!(serde_json::to_value(events).unwrap(), expected["events"]);

        let snapshot = ProjectSyncSnapshot {
            project_id: "p123".into(),
            revision: 5,
            syncing: false,
            local_generation: 9,
            acknowledged_generation: 7,
            dirty: BTreeMap::from([("page.md".to_owned(), 8), ("inputs/a.m4a".to_owned(), 9)]),
            pending_mutation: true,
            conflicts: vec![ConflictSummary {
                conflict_id: "c_AAAAAAAAAAAAAAAAAAAAAA".into(),
                path: "page.md".into(),
                kind: ConflictKind::LocalDeletedRemoteEdited,
                status: ConflictStatus::Open,
                remote_device_id: Some("pwa_0123456789abcdef0123456789abcdef".into()),
                remote_device_kind: Some("phone".into()),
            }],
            deferred: vec!["pages/p2.md".into(), "pages/p3.md".into()],
            remote_writers: BTreeMap::from([
                (
                    "pages/p2.md".to_owned(),
                    RemoteWriter {
                        device_id: "d_AAAAAAAAAAAAAAAAAAAAAA".into(),
                        device_kind: Some("mac".into()),
                    },
                ),
                (
                    "pages/p3.md".to_owned(),
                    RemoteWriter {
                        device_id: "d_BBBBBBBBBBBBBBBBBBBBBB".into(),
                        device_kind: None,
                    },
                ),
            ]),
            quota_paths: vec![],
            blocked: vec![BlockedPath {
                path: "big.bin".into(),
                reason: BlockedReason::TooLarge,
            }],
            expired_audio: vec!["old.m4a".into()],
            audio: BTreeMap::from([("inputs/a.m4a".to_owned(), AudioTransferState::Uploading)]),
            last_synced_at: Some("2026-10-16T00:00:00.000Z".into()),
            last_error: Some(SyncErrorInfo {
                kind: SyncErrorKind::Offline,
                message: "NIHO に接続できません".into(),
            }),
            retry_after: None,
            tombstone: None,
        };
        assert_eq!(
            serde_json::to_value(snapshot).unwrap(),
            expected["snapshot"]
        );
    }
}
