//! CLOUD→LOCAL の固定 snapshot の受信だけを担当する。本人の app data に隔離し、
//! 作業コピー・journal・outbox には触れない。close・切離し・ゴミ箱への移動は別の段階。
#![allow(dead_code)] // L3 の確認画面・close orchestration を接続するまで非公開。

use crate::docs_storage_api::{DocsStorageApi, StorageApiError};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use niho_desktop_vault::{
  validate_relative_path, version_path_for, Device, IdTokenProvider, LocalSaver, Namespace, OpenedFileSource,
  ProjectTarget, SaveKind, VaultError, DOCS_ROOT_PROJECT_ID, FLOWS_PROJECT_ID, PROFILE_PROJECT_ID,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CString;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const ROOT_LIMIT: usize = 8 * 1024 * 1024;
const CHUNK_LIMIT: usize = 5 * 1024 * 1024;
const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Debug)]
pub(crate) enum ClosingError {
  Api(StorageApiError),
  Io(std::io::Error),
  InvalidManifest,
  Mismatch,
  InsufficientSpace,
  Busy,
  Cancelled,
  Vault(VaultError),
}
impl From<StorageApiError> for ClosingError {
  fn from(value: StorageApiError) -> Self {
    Self::Api(value)
  }
}
impl From<std::io::Error> for ClosingError {
  fn from(value: std::io::Error) -> Self {
    Self::Io(value)
  }
}
impl From<VaultError> for ClosingError {
  fn from(value: VaultError) -> Self {
    Self::Vault(value)
  }
}
type Result<T> = std::result::Result<T, ClosingError>;

fn sha(bytes: &[u8]) -> String {
  format!("{:x}", Sha256::digest(bytes))
}
fn valid_sha(value: &str) -> bool {
  value.len() == 64
    && value
      .bytes()
      .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn safe_id(value: &str) -> bool {
  !value.is_empty()
    && value.len() <= 128
    && value
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
fn decimal(value: &str) -> Option<u64> {
  let number = value.parse::<u64>().ok()?;
  (number.to_string() == value).then_some(number)
}
fn valid_generation(value: &str) -> bool {
  !value.is_empty() && !value.starts_with('0') && value.bytes().all(|byte| byte.is_ascii_digit())
}
fn timestamp(value: &str) -> bool {
  chrono::DateTime::parse_from_rfc3339(value).is_ok()
}
fn parse<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
  serde_json::from_slice(bytes).map_err(|_| ClosingError::InvalidManifest)
}

/// GET closing/current の SNAPSHOT_READY で固定した値。別 attempt / epoch を再利用しない。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SnapshotIdentity {
  pub user_id: String,
  pub closing_id: String,
  pub epoch: String,
  pub manifest_digest: String,
}
impl SnapshotIdentity {
  fn valid(&self) -> bool {
    safe_id(&self.user_id)
      && safe_id(&self.closing_id)
      && decimal(&self.epoch).is_some()
      && valid_sha(&self.manifest_digest)
  }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SnapshotProject {
  pub id: String,
  pub project_id: String,
  pub scope: String,
  pub name: String,
  pub revision: u64,
  pub deleted_at: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Counts {
  #[serde(rename = "BLOB")]
  blob: usize,
  #[serde(rename = "CANDIDATE")]
  candidate: usize,
  #[serde(rename = "COMPOSER")]
  composer: usize,
  #[serde(rename = "FILE")]
  file: usize,
  #[serde(rename = "RUN")]
  run: usize,
}
impl Counts {
  fn array(&self) -> [usize; 5] {
    [self.blob, self.candidate, self.composer, self.file, self.run]
  }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChunkRef {
  index: usize,
  object_key: String,
  generation: String,
  sha256: String,
  bytes: usize,
  entries: usize,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Root {
  version: u8,
  user_id: String,
  closing_id: String,
  epoch: String,
  created_at: String,
  projects: Vec<SnapshotProject>,
  counts: Counts,
  chunks: Vec<ChunkRef>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Chunk {
  version: u8,
  entries: Vec<Entry>,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Source {
  #[serde(rename = "INLINE")]
  Inline { base64: String },
  #[serde(rename = "OBJECT", rename_all = "camelCase")]
  Object { object_key: String, generation: String },
  #[serde(rename = "UNAVAILABLE")]
  Unavailable { reason: UnavailableReason },
}
#[derive(Debug, Deserialize, PartialEq, Eq)]
enum UnavailableReason {
  #[serde(rename = "EXPIRED_AUDIO")]
  ExpiredAudio,
  #[serde(rename = "UNUPLOADED")]
  Unuploaded,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase", deny_unknown_fields)]
enum Entry {
  #[serde(rename = "BLOB")]
  Blob {
    project_ref: String,
    id: String,
    sha256: String,
    bytes: String,
    content_type: String,
    retained_until: Option<String>,
    source: Source,
  },
  #[serde(rename = "CANDIDATE")]
  Candidate {
    project_ref: String,
    id: String,
    run_id: String,
    attempt_id: String,
    blob_id: String,
    recording_page_id: String,
    recording_id: String,
    step_key: String,
    step_label: String,
    status: String,
    created_at: String,
    object_key: String,
    object_generation: Option<String>,
    sha256: Option<String>,
    bytes: Option<u64>,
  },
  #[serde(rename = "COMPOSER")]
  Composer {
    project_ref: String,
    id: String,
    page_id: String,
    page_kind: String,
    recording_id: Option<String>,
    artifact_id: Option<String>,
    conversation_id: String,
    status: String,
    created_at: String,
    finished_at: Option<String>,
  },
  #[serde(rename = "FILE")]
  File {
    project_ref: String,
    id: String,
    path: String,
    sha256: String,
    bytes: String,
    kind: String,
    revision: u64,
    modified_at: String,
  },
  #[serde(rename = "RUN")]
  Run {
    project_ref: String,
    id: String,
    recording_page_id: String,
    recording_id: String,
    status: String,
    created_at: String,
    finished_at: Option<String>,
    steps: Vec<SnapshotRunStep>,
  },
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotRunStep {
  step_key: String,
  label: String,
  status: String,
}
impl Entry {
  fn key(&self) -> (usize, &str, &str) {
    match self {
      Self::Blob { project_ref, id, .. } => (0, project_ref, id),
      Self::Candidate { project_ref, id, .. } => (1, project_ref, id),
      Self::Composer { project_ref, id, .. } => (2, project_ref, id),
      Self::File { project_ref, id, .. } => (3, project_ref, id),
      Self::Run { project_ref, id, .. } => (4, project_ref, id),
    }
  }
}

#[derive(Clone, Debug)]
pub(crate) struct ObjectSpec {
  pub chunk: usize,
  pub entry: usize,
  pub object_key: String,
  pub generation: String,
  pub sha256: String,
  pub bytes: u64,
}
impl ObjectSpec {
  fn filename(&self) -> String {
    format!("object-{}-{}", self.chunk, self.entry)
  }
}

#[async_trait]
pub(crate) trait SnapshotTransport: Send + Sync {
  async fn heartbeat(&self, identity: &SnapshotIdentity) -> Result<()>;
  async fn part(&self, identity: &SnapshotIdentity, chunk: Option<usize>) -> Result<Vec<u8>>;
  /// 呼出し側の streaming hasher へ書く。URL/token を staging に保存しない。
  async fn object(&self, identity: &SnapshotIdentity, spec: &ObjectSpec, writer: &mut (dyn Write + Send))
    -> Result<()>;
  fn progress(&self, _done: usize, _total: usize) {}
}

pub(crate) struct HttpSnapshotTransport<'a> {
  pub api: &'a DocsStorageApi,
  pub token: &'a dyn IdTokenProvider,
  pub cancel: &'a AtomicBool,
  pub on_progress: &'a (dyn Fn(usize, usize) + Send + Sync),
  client: reqwest::Client,
}
impl<'a> HttpSnapshotTransport<'a> {
  pub fn new(
    api: &'a DocsStorageApi,
    token: &'a dyn IdTokenProvider,
    cancel: &'a AtomicBool,
    on_progress: &'a (dyn Fn(usize, usize) + Send + Sync),
  ) -> Result<Self> {
    let client = reqwest::Client::builder()
      .https_only(true)
      .redirect(reqwest::redirect::Policy::none())
      .connect_timeout(Duration::from_secs(10))
      .read_timeout(Duration::from_secs(45))
      .build()
      .map_err(|_| ClosingError::Api(StorageApiError::Unavailable))?;
    Ok(Self {
      api,
      token,
      cancel,
      on_progress,
      client,
    })
  }
  fn check_cancel(&self) -> Result<()> {
    if self.cancel.load(Ordering::SeqCst) {
      Err(ClosingError::Cancelled)
    } else {
      Ok(())
    }
  }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedObject {
  url: String,
  expires_at: String,
  generation: String,
  sha256: String,
  bytes: String,
}
impl SignedObject {
  fn validated_url(&self, spec: &ObjectSpec) -> Result<url::Url> {
    let url = url::Url::parse(&self.url).map_err(|_| ClosingError::Mismatch)?;
    let host = url.host_str().unwrap_or_default();
    let generations: Vec<_> = url
      .query_pairs()
      .filter(|(key, _)| key == "generation")
      .map(|(_, value)| value.into_owned())
      .collect();
    // GCS の immutable generation だけを取りに行く。API bearer はここへ渡さない。
    if url.scheme() != "https"
      || !url.username().is_empty()
      || url.password().is_some()
      || url.fragment().is_some()
      || url.port_or_known_default() != Some(443)
      || !(host == "storage.googleapis.com" || host.ends_with(".storage.googleapis.com"))
      || generations != [spec.generation.clone()]
      || self.generation != spec.generation
      || self.sha256 != spec.sha256
      || decimal(&self.bytes) != Some(spec.bytes)
      || chrono::DateTime::parse_from_rfc3339(&self.expires_at).map_or(true, |expires| expires <= chrono::Utc::now())
    {
      return Err(ClosingError::Mismatch);
    }
    Ok(url)
  }
}
#[async_trait]
impl SnapshotTransport for HttpSnapshotTransport<'_> {
  async fn heartbeat(&self, identity: &SnapshotIdentity) -> Result<()> {
    self.check_cancel()?;
    self.token.ensure_current().map_err(|_| StorageApiError::Auth)?;
    self
      .api
      .snapshot_heartbeat(self.token, &identity.closing_id, &identity.epoch)
      .await?;
    Ok(())
  }
  async fn part(&self, identity: &SnapshotIdentity, chunk: Option<usize>) -> Result<Vec<u8>> {
    self.check_cancel()?;
    Ok(self.api.snapshot_part(self.token, &identity.closing_id, chunk).await?)
  }
  async fn object(
    &self,
    identity: &SnapshotIdentity,
    spec: &ObjectSpec,
    writer: &mut (dyn Write + Send),
  ) -> Result<()> {
    self.check_cancel()?;
    let signed: SignedObject = self
      .api
      .snapshot_object_url(self.token, &identity.closing_id, spec.chunk, spec.entry)
      .await?;
    let url = signed.validated_url(spec)?;
    let mut response = self
      .client
      .get(url)
      .header("accept-encoding", "identity")
      .send()
      .await
      .map_err(|_| StorageApiError::Unavailable)?;
    if response.status().as_u16() != 200
      || response.content_length().is_some_and(|bytes| bytes != spec.bytes)
      || response
        .headers()
        .get("content-encoding")
        .is_some_and(|value| value != "identity")
      || response
        .headers()
        .get("x-goog-generation")
        .is_some_and(|value| value.to_str().ok() != Some(spec.generation.as_str()))
    {
      return Err(ClosingError::Mismatch);
    }
    let mut last_heartbeat = Instant::now();
    // サイズ・hash の判定は writer が chunk ごとに実施し、上限を越えた bytes を書かない。
    while let Some(chunk) = response.chunk().await.map_err(|_| StorageApiError::Unavailable)? {
      self.check_cancel()?;
      self.token.ensure_current().map_err(|_| StorageApiError::Auth)?;
      writer.write_all(&chunk)?;
      if last_heartbeat.elapsed() >= Duration::from_secs(30) {
        self.heartbeat(identity).await?;
        last_heartbeat = Instant::now();
      }
    }
    self.heartbeat(identity).await
  }
  fn progress(&self, done: usize, total: usize) {
    (self.on_progress)(done, total);
  }
}

/// 全中間 directory を openat(O_NOFOLLOW) で固定する。manifest の path はファイル名に使わず、
/// metadata として保持する。root の外や、別本人・別 attempt の staging へ書けない。
struct Stage {
  dir: File,
  path: PathBuf,
  _lock: File,
}
fn cstring(value: &std::ffi::OsStr) -> Result<CString> {
  use std::os::unix::ffi::OsStrExt;
  CString::new(value.as_bytes()).map_err(|_| ClosingError::InvalidManifest)
}
fn open_fd(parent: i32, name: &CString, flags: i32) -> Result<File> {
  let fd = unsafe { libc::openat(parent, name.as_ptr(), flags | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) };
  if fd < 0 {
    return Err(std::io::Error::last_os_error().into());
  }
  Ok(unsafe { File::from_raw_fd(fd) })
}
impl Stage {
  fn open(app_data: &Path, account_key: &str, identity: &SnapshotIdentity) -> Result<Self> {
    if !app_data.is_absolute() || !valid_sha(account_key) || !identity.valid() {
      return Err(ClosingError::InvalidManifest);
    }
    // macOS の /var は /private/var への symlink。app data 自体を固定してから子を no-follow で辿る。
    let path = app_data
      .canonicalize()?
      .join("docs-closing")
      .join(account_key)
      .join(format!(
        "{}-{}-{}",
        identity.closing_id, identity.epoch, identity.manifest_digest
      ));
    let mut dir = File::open("/")?;
    for component in path.components() {
      let name = match component {
        Component::RootDir => continue,
        Component::Normal(name) => cstring(name)?,
        _ => return Err(ClosingError::InvalidManifest),
      };
      let created = unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o700) };
      if created < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists {
        return Err(std::io::Error::last_os_error().into());
      }
      let child = open_fd(dir.as_raw_fd(), &name, libc::O_RDONLY | libc::O_DIRECTORY)?;
      if created == 0 {
        dir.sync_all()?;
      }
      dir = child;
    }
    // 同じ attempt の同時ダウンロードでは .part を上書きしない。クラッシュ時はOSが解放する。
    let lock = open_fd(
      dir.as_raw_fd(),
      &cstring(std::ffi::OsStr::new("lock"))?,
      libc::O_RDWR | libc::O_CREAT,
    )?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } < 0 {
      return Err(ClosingError::Busy);
    }
    // flock の所有FDを directory と一緒に保持する。
    let stage = Self { dir, path, _lock: lock };
    let bytes = serde_json::to_vec(identity).map_err(|_| ClosingError::InvalidManifest)?;
    match stage.read("identity.json", 1024)? {
      Some(existing) if existing != bytes => return Err(ClosingError::Mismatch),
      Some(_) => {}
      None => stage.write("identity.json", &bytes)?,
    }
    Ok(stage)
  }
  fn file(&self, name: &str, flags: i32) -> Result<File> {
    if name.contains('/')
      || !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.'))
    {
      return Err(ClosingError::InvalidManifest);
    }
    let file = open_fd(self.dir.as_raw_fd(), &cstring(std::ffi::OsStr::new(name))?, flags)?;
    if !file.metadata()?.is_file() {
      return Err(ClosingError::Mismatch);
    }
    Ok(file)
  }
  fn read(&self, name: &str, limit: usize) -> Result<Option<Vec<u8>>> {
    let file = match self.file(name, libc::O_RDONLY) {
      Ok(file) => file,
      Err(ClosingError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
      Err(error) => return Err(error),
    };
    if file.metadata()?.len() > limit as u64 {
      return Err(ClosingError::Mismatch);
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
      return Err(ClosingError::Mismatch);
    }
    Ok(Some(bytes))
  }
  fn promote(&self, part: &str, name: &str) -> Result<()> {
    let part = cstring(std::ffi::OsStr::new(part))?;
    let name = cstring(std::ffi::OsStr::new(name))?;
    if unsafe { libc::renameat(self.dir.as_raw_fd(), part.as_ptr(), self.dir.as_raw_fd(), name.as_ptr()) } < 0 {
      return Err(std::io::Error::last_os_error().into());
    }
    self.dir.sync_all()?;
    Ok(())
  }
  fn write(&self, name: &str, bytes: &[u8]) -> Result<()> {
    let part = format!("{name}.part");
    let mut file = self.file(&part, libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    self.promote(&part, name)
  }
  fn available(&self) -> Result<u64> {
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    if unsafe { libc::fstatvfs(self.dir.as_raw_fd(), stats.as_mut_ptr()) } < 0 {
      return Err(std::io::Error::last_os_error().into());
    }
    let stats = unsafe { stats.assume_init() };
    (stats.f_bavail as u64)
      .checked_mul(stats.f_frsize as u64)
      .ok_or(ClosingError::InsufficientSpace)
  }
  fn mkdir(&self, name: &str) -> Result<PathBuf> {
    if name.is_empty() || name.len() > 240 || name.contains('/') || name.contains('\0') || name == "." || name == ".." {
      return Err(ClosingError::InvalidManifest);
    }
    let name = cstring(std::ffi::OsStr::new(name))?;
    let made = unsafe { libc::mkdirat(self.dir.as_raw_fd(), name.as_ptr(), 0o700) };
    if made < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists {
      return Err(std::io::Error::last_os_error().into());
    }
    let _dir = open_fd(self.dir.as_raw_fd(), &name, libc::O_RDONLY | libc::O_DIRECTORY)?;
    if made == 0 {
      self.dir.sync_all()?;
    }
    Ok(
      self
        .path
        .join(name.to_str().map_err(|_| ClosingError::InvalidManifest)?),
    )
  }
  fn verified(&self, name: &str, expected_sha: &str, expected_bytes: u64) -> Result<bool> {
    let mut file = match self.file(name, libc::O_RDONLY) {
      Ok(file) => file,
      Err(ClosingError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
      Err(error) => return Err(error),
    };
    if file.metadata()?.len() != expected_bytes {
      return Ok(false);
    }
    let mut digest = Sha256::new();
    let mut buffer = [0; 256 * 1024];
    let mut count = 0_u64;
    loop {
      let read = file.read(&mut buffer)?;
      if read == 0 {
        break;
      }
      count = count.checked_add(read as u64).ok_or(ClosingError::Mismatch)?;
      if count > expected_bytes {
        return Ok(false);
      }
      digest.update(&buffer[..read]);
    }
    Ok(count == expected_bytes && format!("{:x}", digest.finalize()) == expected_sha)
  }
}

/// 表示用 preflight 時の空き容量。ここではファイルを作らない。
pub(crate) fn disk_free_bytes(path: &Path) -> Result<u64> {
  let path = cstring(path.as_os_str())?;
  let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
  if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } < 0 {
    return Err(std::io::Error::last_os_error().into());
  }
  let stats = unsafe { stats.assume_init() };
  (stats.f_bavail as u64)
    .checked_mul(stats.f_frsize as u64)
    .ok_or(ClosingError::InsufficientSpace)
}

/// ceil(転送量×1.1)+1GiB。浮動小数点の丸め・overflowで検査をすり抜けない。
pub(crate) fn required_free_bytes(transfer_bytes: u64) -> Result<u64> {
  transfer_bytes
    .checked_add(transfer_bytes / 10)
    .and_then(|n| n.checked_add(u64::from(transfer_bytes % 10 != 0)))
    .and_then(|n| n.checked_add(GIB))
    .ok_or(ClosingError::InsufficientSpace)
}
fn check_space(available: u64, incoming: u64) -> Result<()> {
  if available < required_free_bytes(incoming)? {
    return Err(ClosingError::InsufficientSpace);
  }
  Ok(())
}
struct VerifyingWriter<'a> {
  file: &'a mut File,
  digest: Sha256,
  bytes: u64,
  expected: u64,
}
impl Write for VerifyingWriter<'_> {
  fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
    if bytes.len() as u64 > self.expected.saturating_sub(self.bytes) {
      return Err(std::io::Error::other("snapshot_size_mismatch"));
    }
    let written = self.file.write(bytes)?;
    self.digest.update(&bytes[..written]);
    self.bytes += written as u64;
    Ok(written)
  }
  fn flush(&mut self) -> std::io::Result<()> {
    self.file.flush()
  }
}

struct BlobRef {
  filename: Option<String>,
  bytes: u64,
  expired: bool,
  generation: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifiedFile {
  pub project_ref: String,
  pub path: String,
  pub sha256: String,
  pub bytes: u64,
  pub kind: String,
  /// staging 直下の検証済み実体。期限切れ音声だけ None。作業コピーの同じ path は変更しない。
  pub staging_file: Option<String>,
  pub generation: Option<String>,
  pub expired_audio: bool,
}
struct Plan {
  objects: Vec<ObjectSpec>,
  inline: Vec<(String, String, u64)>,
  blobs: BTreeMap<(String, String), BlobRef>,
  paths: BTreeSet<(String, String)>,
  files: Vec<VerifiedFile>,
  previous: Option<(usize, String, String)>,
  counts: [usize; 5],
  expired_audio: usize,
  pending_candidates: usize,
}
impl Plan {
  fn new() -> Self {
    Self {
      objects: Vec::new(),
      inline: Vec::new(),
      blobs: BTreeMap::new(),
      paths: BTreeSet::new(),
      files: Vec::new(),
      previous: None,
      counts: [0; 5],
      expired_audio: 0,
      pending_candidates: 0,
    }
  }
  fn consume(
    &mut self,
    stage: &Stage,
    root: &Root,
    chunk_index: usize,
    chunk: Chunk,
    store_inline: bool,
  ) -> Result<()> {
    for (entry_index, entry) in chunk.entries.into_iter().enumerate() {
      let (kind, project, id) = entry.key();
      if !safe_id(project) || !safe_id(id) || !root.projects.iter().any(|p| p.id == project) {
        return Err(ClosingError::InvalidManifest);
      }
      let key = (kind, project.to_owned(), id.to_owned());
      if self.previous.as_ref().is_some_and(|previous| previous >= &key) {
        return Err(ClosingError::InvalidManifest);
      }
      self.previous = Some(key);
      self.counts[kind] += 1;
      match entry {
        Entry::Blob {
          project_ref,
          sha256,
          bytes,
          content_type,
          retained_until,
          source,
          ..
        } => {
          let bytes = decimal(&bytes).ok_or(ClosingError::InvalidManifest)?;
          if !valid_sha(&sha256) {
            return Err(ClosingError::InvalidManifest);
          }
          let mut blob = BlobRef {
            filename: None,
            bytes,
            expired: false,
            generation: None,
          };
          match source {
            Source::Inline { base64 } => {
              let body = STANDARD.decode(base64).map_err(|_| ClosingError::InvalidManifest)?;
              if body.len() as u64 != bytes || sha(&body) != sha256 {
                return Err(ClosingError::Mismatch);
              }
              let filename = format!("inline-{chunk_index}-{entry_index}");
              if store_inline {
                stage.write(&filename, &body)?;
              }
              self.inline.push((filename.clone(), sha256.clone(), bytes));
              blob.filename = Some(filename);
            }
            Source::Object { object_key, generation } => {
              if object_key.is_empty() || !valid_generation(&generation) {
                return Err(ClosingError::InvalidManifest);
              }
              blob.generation = Some(generation.clone());
              let spec = ObjectSpec {
                chunk: chunk_index,
                entry: entry_index,
                object_key,
                generation,
                sha256: sha256.clone(),
                bytes,
              };
              blob.filename = Some(spec.filename());
              self.objects.push(spec);
            }
            Source::Unavailable { reason } => {
              if reason == UnavailableReason::ExpiredAudio {
                if !content_type.starts_with("audio/")
                  || retained_until
                    .as_deref()
                    .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                    .is_none_or(|expiry| {
                      chrono::DateTime::parse_from_rfc3339(&root.created_at).map_or(true, |created| expiry > created)
                    })
                {
                  return Err(ClosingError::InvalidManifest);
                }
                blob.expired = true;
              }
            }
          }
          if self.blobs.insert((project_ref, sha256), blob).is_some() {
            return Err(ClosingError::InvalidManifest);
          }
        }
        Entry::Candidate {
          id,
          run_id,
          attempt_id,
          blob_id,
          recording_page_id,
          recording_id,
          step_key,
          step_label,
          status,
          created_at,
          object_key,
          object_generation,
          sha256,
          bytes,
          ..
        } => {
          if !safe_id(&id)
            || !safe_id(&run_id)
            || !safe_id(&attempt_id)
            || !safe_id(&blob_id)
            || !safe_id(&recording_page_id)
            || !safe_id(&recording_id)
            || !safe_id(&step_key)
            || step_label.len() > 512
            || status.len() > 32
            || !timestamp(&created_at)
          {
            return Err(ClosingError::InvalidManifest);
          }
          match (object_generation, sha256, bytes) {
            (Some(generation), Some(sha256), Some(bytes)) => {
              if object_key.is_empty() || !valid_generation(&generation) || !valid_sha(&sha256) {
                return Err(ClosingError::InvalidManifest);
              }
              self.objects.push(ObjectSpec {
                chunk: chunk_index,
                entry: entry_index,
                object_key,
                generation,
                sha256,
                bytes,
              });
            }
            _ => self.pending_candidates += 1, // 未確定の予約は bytes として取得できない。metadata は raw chunk に残す。
          }
        }
        Entry::File {
          project_ref,
          path,
          sha256,
          bytes,
          kind,
          modified_at,
          ..
        } => {
          validate_relative_path(&path).map_err(|_| ClosingError::InvalidManifest)?;
          if !valid_sha(&sha256) || !timestamp(&modified_at) || !self.paths.insert((project_ref.clone(), path.clone()))
          {
            return Err(ClosingError::InvalidManifest);
          }
          let bytes = decimal(&bytes).ok_or(ClosingError::InvalidManifest)?;
          let blob = self
            .blobs
            .get(&(project_ref.clone(), sha256.clone()))
            .ok_or(ClosingError::Mismatch)?;
          if blob.bytes != bytes || (blob.filename.is_none() && !(blob.expired && kind == "audio")) {
            return Err(ClosingError::Mismatch);
          }
          self.files.push(VerifiedFile {
            project_ref,
            path,
            sha256,
            bytes,
            kind,
            staging_file: blob.filename.clone(),
            generation: blob.generation.clone(),
            expired_audio: blob.expired,
          });
          if blob.expired {
            self.expired_audio += 1;
          }
        }
        Entry::Run {
          id,
          recording_page_id,
          recording_id,
          status,
          created_at,
          finished_at,
          steps,
          ..
        } => {
          if !safe_id(&id)
            || !safe_id(&recording_page_id)
            || !safe_id(&recording_id)
            || status.len() > 32
            || !timestamp(&created_at)
            || finished_at.as_deref().is_some_and(|value| !timestamp(value))
            || steps
              .iter()
              .any(|step| !safe_id(&step.step_key) || step.label.len() > 512 || step.status.len() > 32)
          {
            return Err(ClosingError::InvalidManifest);
          }
        }
        Entry::Composer {
          id,
          page_id,
          page_kind,
          recording_id,
          artifact_id,
          conversation_id,
          status,
          created_at,
          finished_at,
          ..
        } => {
          if !safe_id(&id)
            || !safe_id(&page_id)
            || !safe_id(&conversation_id)
            || !matches!(page_kind.as_str(), "DOCUMENT" | "RECORDING")
            || recording_id.as_deref().is_some_and(|id| !safe_id(id))
            || (page_kind == "RECORDING" && recording_id.is_none())
            || artifact_id.as_deref().is_some_and(|id| !safe_id(id))
            || status.len() > 32
            || !timestamp(&created_at)
            || finished_at.as_deref().is_some_and(|value| !timestamp(value))
          {
            return Err(ClosingError::InvalidManifest);
          }
        }
      }
    }
    Ok(())
  }
}

fn root_from(bytes: &[u8], identity: &SnapshotIdentity) -> Result<Root> {
  if bytes.len() > ROOT_LIMIT || sha(bytes) != identity.manifest_digest {
    return Err(ClosingError::Mismatch);
  }
  let root: Root = parse(bytes)?;
  if root.version != 1
    || root.user_id != identity.user_id
    || root.closing_id != identity.closing_id
    || root.epoch != identity.epoch
    || !timestamp(&root.created_at)
  {
    return Err(ClosingError::InvalidManifest);
  }
  let mut previous = None;
  let mut project_ids = BTreeSet::new();
  for project in &root.projects {
    if !safe_id(&project.id)
      || !safe_id(&project.project_id)
      || previous.is_some_and(|id: &str| id >= project.id.as_str())
      || !project_ids.insert(&project.project_id)
      || project.deleted_at.as_deref().is_some_and(|value| !timestamp(value))
    {
      return Err(ClosingError::InvalidManifest);
    }
    previous = Some(project.id.as_str());
  }
  for (index, chunk) in root.chunks.iter().enumerate() {
    if chunk.index != index
      || chunk.object_key
        != format!(
          "docs-close-snapshots/v1/users/{}/{}/chunks/{index:06}.json",
          identity.user_id, identity.closing_id
        )
      || !valid_generation(&chunk.generation)
      || !valid_sha(&chunk.sha256)
      || chunk.bytes == 0
      || chunk.bytes > CHUNK_LIMIT
      || chunk.entries == 0
    {
      return Err(ClosingError::InvalidManifest);
    }
  }
  Ok(root)
}
fn chunk_from(bytes: &[u8], reference: &ChunkRef) -> Result<Chunk> {
  if bytes.len() != reference.bytes || sha(bytes) != reference.sha256 {
    return Err(ClosingError::Mismatch);
  }
  let chunk: Chunk = parse(bytes)?;
  if chunk.version != 1 || chunk.entries.len() != reference.entries {
    return Err(ClosingError::InvalidManifest);
  }
  Ok(chunk)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifiedSnapshot {
  pub staging_path: PathBuf,
  pub identity: SnapshotIdentity,
  pub projects: Vec<SnapshotProject>,
  pub files: Vec<VerifiedFile>,
  pub file_count: usize,
  pub expired_audio_count: usize,
  pub pending_candidate_count: usize,
  pub object_count: usize,
}

/// 再開時にも holder/epoch をサーバーで確認し、完了済み bytes をすべて再照合する。
/// partial object は先頭から再取得するが、完了済み object/chunk は転送しない。
pub(crate) async fn receive_snapshot(
  transport: &dyn SnapshotTransport,
  app_data: &Path,
  account_key: &str,
  identity: &SnapshotIdentity,
  preflight_transfer_bytes: u64,
) -> Result<VerifiedSnapshot> {
  let stage = Stage::open(app_data, account_key, identity)?;
  transport.heartbeat(identity).await?;
  let cached_root = stage.read("manifest.json", ROOT_LIMIT)?;
  if cached_root.is_none() {
    check_space(stage.available()?, preflight_transfer_bytes)?;
  }
  let root_bytes = match cached_root {
    Some(bytes) => bytes,
    None => transport.part(identity, None).await?,
  };
  let root = root_from(&root_bytes, identity)?;
  stage.write("manifest.json", &root_bytes)?;
  let mut plan = Plan::new();
  for reference in &root.chunks {
    transport.heartbeat(identity).await?;
    let name = format!("chunk-{}.json", reference.index);
    let bytes = match stage.read(&name, CHUNK_LIMIT)? {
      Some(bytes) => bytes,
      None => transport.part(identity, Some(reference.index)).await?,
    };
    let chunk = chunk_from(&bytes, reference)?;
    stage.write(&name, &bytes)?;
    plan.consume(&stage, &root, reference.index, chunk, true)?;
  }
  if plan.counts != root.counts.array() {
    return Err(ClosingError::Mismatch);
  }
  let mut remaining = 0_u64;
  for spec in &plan.objects {
    if !stage.verified(&spec.filename(), &spec.sha256, spec.bytes)? {
      remaining = remaining
        .checked_add(spec.bytes)
        .ok_or(ClosingError::InsufficientSpace)?;
    }
  }
  check_space(stage.available()?, remaining)?;
  let total = plan.objects.len() + plan.inline.len();
  let mut done = plan.inline.len();
  transport.progress(done, total);
  for spec in &plan.objects {
    transport.heartbeat(identity).await?;
    let name = spec.filename();
    if stage.verified(&name, &spec.sha256, spec.bytes)? {
      done += 1;
      transport.progress(done, total);
      continue;
    }
    let part = format!("{name}.part");
    let mut file = stage.file(&part, libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC)?;
    let mut writer = VerifyingWriter {
      file: &mut file,
      digest: Sha256::new(),
      bytes: 0,
      expected: spec.bytes,
    };
    transport.object(identity, spec, &mut writer).await?;
    if writer.bytes != spec.bytes || format!("{:x}", writer.digest.finalize()) != spec.sha256 {
      return Err(ClosingError::Mismatch);
    }
    file.sync_all()?;
    stage.promote(&part, &name)?;
    done += 1;
    transport.progress(done, total);
  }
  // 完了 marker だけを信頼しない。root/chunk と全実体を再読してから返す。
  let verified = verify_stage(&stage, identity)?;
  transport.heartbeat(identity).await?;
  stage.write(
    "verified.json",
    &serde_json::to_vec(&verified).map_err(|_| ClosingError::InvalidManifest)?,
  )?;
  Ok(verified)
}

fn verify_stage(stage: &Stage, identity: &SnapshotIdentity) -> Result<VerifiedSnapshot> {
  let bytes = stage.read("manifest.json", ROOT_LIMIT)?.ok_or(ClosingError::Mismatch)?;
  let root = root_from(&bytes, identity)?;
  let mut plan = Plan::new();
  for reference in &root.chunks {
    let bytes = stage
      .read(&format!("chunk-{}.json", reference.index), CHUNK_LIMIT)?
      .ok_or(ClosingError::Mismatch)?;
    plan.consume(stage, &root, reference.index, chunk_from(&bytes, reference)?, false)?;
  }
  if plan.counts != root.counts.array() {
    return Err(ClosingError::Mismatch);
  }
  for spec in &plan.objects {
    if !stage.verified(&spec.filename(), &spec.sha256, spec.bytes)? {
      return Err(ClosingError::Mismatch);
    }
  }
  for (filename, digest, bytes) in &plan.inline {
    if !stage.verified(filename, digest, *bytes)? {
      return Err(ClosingError::Mismatch);
    }
  }
  Ok(VerifiedSnapshot {
    staging_path: stage.path.clone(),
    identity: identity.clone(),
    projects: root.projects,
    files: plan.files,
    file_count: plan.counts[3],
    expired_audio_count: plan.expired_audio,
    pending_candidate_count: plan.pending_candidates,
    object_count: plan.objects.len() + plan.inline.len(),
  })
}

/// close 応答消失後の切離し再開にも使う。verified.json の印だけを信じず全実体を照合する。
pub(crate) fn verify_staged_snapshot(
  app_data: &Path,
  account_key: &str,
  identity: &SnapshotIdentity,
) -> Result<VerifiedSnapshot> {
  verify_stage(&Stage::open(app_data, account_key, identity)?, identity)
}

pub(crate) fn verify_snapshot_placement(root: &Path, snapshot: &VerifiedSnapshot) -> Result<()> {
  let projects: BTreeMap<_, _> = snapshot
    .projects
    .iter()
    .map(|project| (project.id.as_str(), project))
    .collect();
  for project in &snapshot.projects {
    let _ = target(root, project)?;
    if project.deleted_at.is_some()
      && (project.scope != "FOLDER"
        || matches!(
          project.project_id.as_str(),
          DOCS_ROOT_PROJECT_ID | PROFILE_PROJECT_ID | FLOWS_PROJECT_ID
        ))
    {
      return Err(ClosingError::InvalidManifest);
    }
  }
  for file in &snapshot.files {
    let project = projects.get(file.project_ref.as_str()).ok_or(ClosingError::Mismatch)?;
    let target = target(root, project)?;
    if !target.scope.contains(&file.path) || (file.expired_audio && file.kind != "audio") {
      return Err(ClosingError::InvalidManifest);
    }
    if !file.expired_audio && file.staging_file.is_none() {
      return Err(ClosingError::Mismatch);
    }
  }
  Ok(())
}

/// 外部 close を確定する前に、stage を残したまま行う保存の追加容量を確認する。
/// LocalSaver は app data に新旧 snapshot、作業コピー側に新しい本文を一時保存する。
/// JSON と履歴の構造マージでは両側に追加の版を作るため、その最大分も予約する。
pub(crate) fn ensure_snapshot_apply_space(app_data: &Path, root: &Path, snapshot: &VerifiedSnapshot) -> Result<()> {
  let projects: BTreeMap<_, _> = snapshot
    .projects
    .iter()
    .map(|project| (project.id.as_str(), project))
    .collect();
  let mut app_bytes = 0_u64;
  let mut root_bytes = 0_u64;
  for file in snapshot.files.iter().filter(|file| !file.expired_audio) {
    let project = projects.get(file.project_ref.as_str()).ok_or(ClosingError::Mismatch)?;
    let local = target(root, project)?;
    let current = OpenedFileSource::capture(&local.working_copy, &file.path)?;
    if current
      .as_ref()
      .is_some_and(|existing| existing.sha256() == file.sha256)
    {
      continue;
    }
    let previous = current.as_ref().map_or(0, OpenedFileSource::bytes);
    app_bytes = app_bytes
      .checked_add(file.bytes)
      .and_then(|value| value.checked_add(previous))
      .ok_or(ClosingError::InsufficientSpace)?;
    root_bytes = root_bytes
      .checked_add(file.bytes)
      .ok_or(ClosingError::InsufficientSpace)?;
    if current.is_some()
      && (file.path.ends_with(".json") || file.path.ends_with("/runs.jsonl") || file.path == "runs.jsonl")
    {
      // remote 版と構造マージ版の両方。マージ後本文の上限を両入力の和で保守的に見積もる。
      let merged_bound = file
        .bytes
        .checked_add(previous)
        .ok_or(ClosingError::InsufficientSpace)?;
      app_bytes = app_bytes
        .checked_add(merged_bound)
        .ok_or(ClosingError::InsufficientSpace)?;
      root_bytes = root_bytes
        .checked_add(merged_bound)
        .ok_or(ClosingError::InsufficientSpace)?;
    }
  }
  let app_volume = fs::metadata(app_data)?.dev();
  let root_volume = fs::metadata(root)?.dev();
  if app_volume == root_volume {
    let needed = required_free_bytes(
      app_bytes
        .checked_add(root_bytes)
        .ok_or(ClosingError::InsufficientSpace)?,
    )?;
    if disk_free_bytes(app_data)? < needed {
      return Err(ClosingError::InsufficientSpace);
    }
  } else if disk_free_bytes(app_data)? < required_free_bytes(app_bytes)?
    || disk_free_bytes(root)? < required_free_bytes(root_bytes)?
  {
    return Err(ClosingError::InsufficientSpace);
  }
  Ok(())
}

/// close の POST より先に永続化する。再起動後は同じ snapshot を全件再照合してから切り離す。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CloseIntent {
  pub identity: SnapshotIdentity,
  pub root_id: String,
}

pub(crate) fn mark_close_intent(
  app_data: &Path,
  account_key: &str,
  root_id: &str,
  identity: &SnapshotIdentity,
) -> Result<()> {
  if !safe_id(root_id) {
    return Err(ClosingError::InvalidManifest);
  }
  let stage = Stage::open(app_data, account_key, identity)?;
  verify_stage(&stage, identity)?;
  let intent = CloseIntent {
    identity: identity.clone(),
    root_id: root_id.to_owned(),
  };
  stage.write(
    "intent.json",
    &serde_json::to_vec(&intent).map_err(|_| ClosingError::InvalidManifest)?,
  )
}

pub(crate) fn snapshot_applied(app_data: &Path, account_key: &str, identity: &SnapshotIdentity) -> Result<bool> {
  let stage = Stage::open(app_data, account_key, identity)?;
  match stage.read("applied.json", 32)? {
    None => Ok(false),
    Some(marker) if marker == br#"{"version":1}"# => Ok(true),
    Some(_) => Err(ClosingError::Mismatch),
  }
}

/// LOCAL binding の確定後にだけ呼ぶ。適用済み staging は再開に不要なので削除し、
/// binding 更新後にプロセスが落ちたケースも起動時に回収できるようにする。
pub(crate) fn cleanup_applied_close_stages(app_data: &Path) -> Result<()> {
  let parent = app_data.join("docs-closing");
  let accounts = match std::fs::read_dir(&parent) {
    Ok(entries) => entries,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
    Err(error) => return Err(error.into()),
  };
  for account in accounts {
    let account = account?;
    let account_type = account.file_type()?;
    if !account_type.is_dir() || account_type.is_symlink() {
      continue;
    }
    for entry in std::fs::read_dir(account.path())? {
      let entry = entry?;
      let entry_type = entry.file_type()?;
      if !entry_type.is_dir() || entry_type.is_symlink() {
        continue;
      }
      let marker = entry.path().join("applied.json");
      if std::fs::read(&marker).ok().as_deref() == Some(br#"{"version":1}"#) {
        std::fs::remove_dir_all(entry.path())?;
      }
    }
  }
  Ok(())
}

pub(crate) fn cleanup_close_stage(app_data: &Path, account_key: &str, identity: &SnapshotIdentity) -> Result<()> {
  if !snapshot_applied(app_data, account_key, identity)? {
    return Err(ClosingError::Mismatch);
  }
  let stage = Stage::open(app_data, account_key, identity)?;
  std::fs::remove_dir_all(stage.path)?;
  Ok(())
}

/// Mac の root binding がまだ account の時だけ呼ぶ。別端末の close なら None。
pub(crate) fn pending_close_intent(
  app_data: &Path,
  account_key: &str,
  user_id: &str,
  root_id: &str,
  epoch: &str,
) -> Result<Option<CloseIntent>> {
  if !valid_sha(account_key) || !safe_id(user_id) || !safe_id(root_id) || decimal(epoch).is_none() {
    return Err(ClosingError::InvalidManifest);
  }
  let parent = app_data.join("docs-closing").join(account_key);
  let entries = match std::fs::read_dir(&parent) {
    Ok(entries) => entries,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(error.into()),
  };
  let mut found = None;
  for entry in entries {
    let entry = entry?;
    let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
      continue;
    };
    let suffix = format!("-{epoch}-");
    let Some((closing_id, digest)) = name.rsplit_once(&suffix) else {
      continue;
    };
    let identity = SnapshotIdentity {
      user_id: user_id.to_owned(),
      closing_id: closing_id.to_owned(),
      epoch: epoch.to_owned(),
      manifest_digest: digest.to_owned(),
    };
    if !identity.valid() {
      continue;
    }
    let stage = Stage::open(app_data, account_key, &identity)?;
    let Some(bytes) = stage.read("intent.json", 1024)? else {
      continue;
    };
    let intent: CloseIntent = parse(&bytes)?;
    if intent.identity != identity || intent.root_id != root_id || found.is_some() {
      return Err(ClosingError::Mismatch);
    }
    found = Some(intent);
  }
  Ok(found)
}

fn target(root: &Path, project: &SnapshotProject) -> Result<ProjectTarget> {
  if project.project_id == DOCS_ROOT_PROJECT_ID && project.scope == "ROOT" {
    Ok(ProjectTarget::docs_root(root))
  } else if project.project_id == PROFILE_PROJECT_ID && project.scope == "FOLDER" {
    Ok(ProjectTarget::profile(root))
  } else if project.project_id == FLOWS_PROJECT_ID && project.scope == "FOLDER" {
    Ok(ProjectTarget::new(FLOWS_PROJECT_ID, root.join("flows")))
  } else if project.scope == "FOLDER" && safe_id(&project.project_id) && project.project_id.len() <= 32 {
    Ok(ProjectTarget::new(
      &project.project_id,
      root.join("projects").join(&project.project_id),
    ))
  } else {
    Err(ClosingError::InvalidManifest)
  }
}

fn ensure_local_directory(root: &Path, destination: &Path) -> Result<()> {
  let root_metadata = std::fs::symlink_metadata(root)?;
  if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
    return Err(ClosingError::InvalidManifest);
  }
  let relative = destination
    .strip_prefix(root)
    .map_err(|_| ClosingError::InvalidManifest)?;
  let mut current = root.to_path_buf();
  for component in relative.components() {
    let Component::Normal(component) = component else {
      return Err(ClosingError::InvalidManifest);
    };
    current.push(component);
    match std::fs::symlink_metadata(&current) {
      Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
        return Err(ClosingError::InvalidManifest);
      }
      Ok(_) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
        match std::fs::create_dir(&current) {
          Ok(()) => {}
          Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
          Err(error) => return Err(error.into()),
        }
        let metadata = std::fs::symlink_metadata(&current)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
          return Err(ClosingError::InvalidManifest);
        }
      }
      Err(error) => return Err(error.into()),
    }
  }
  Ok(())
}

fn merge_index(local: &Value, remote: &Value) -> Option<Value> {
  let (Some(local_order), Some(local_items), Some(remote_order), Some(remote_items)) = (
    local.get("order").and_then(Value::as_array),
    local.get("items").and_then(Value::as_object),
    remote.get("order").and_then(Value::as_array),
    remote.get("items").and_then(Value::as_object),
  ) else {
    return None;
  };
  let mut order = Vec::new();
  let mut items = serde_json::Map::new();
  for (source_order, source_items) in [(local_order, local_items), (remote_order, remote_items)] {
    for id in source_order.iter().filter_map(Value::as_str) {
      if !items.contains_key(id) {
        if let Some(entry) = source_items.get(id) {
          order.push(Value::String(id.to_owned()));
          items.insert(id.to_owned(), entry.clone());
        }
      }
    }
    for (id, entry) in source_items {
      if !items.contains_key(id) {
        order.push(Value::String(id.clone()));
        items.insert(id.clone(), entry.clone());
      }
    }
  }
  let mut merged = local.as_object()?.clone();
  merged.insert(
    "version".to_owned(),
    local
      .get("version")
      .or_else(|| remote.get("version"))
      .cloned()
      .unwrap_or(Value::from(1)),
  );
  merged.insert("order".to_owned(), Value::Array(order));
  merged.insert("items".to_owned(), Value::Object(items));
  Some(Value::Object(merged))
}

fn merge_page_collection(local: &Value, remote: &Value) -> Option<Value> {
  if let Some(merged) = merge_index(local, remote) {
    return Some(merged);
  }
  let (Some(local), Some(remote)) = (local.as_array(), remote.as_array()) else {
    return None;
  };
  let mut merged = Vec::new();
  let mut ids = BTreeSet::new();
  for page in local.iter().chain(remote) {
    let Some(id) = page.get("id").or_else(|| page.get("pageId")).and_then(Value::as_str) else {
      if !merged.contains(page) {
        merged.push(page.clone());
      }
      continue;
    };
    if ids.insert(id.to_owned()) {
      merged.push(page.clone());
    }
  }
  Some(Value::Array(merged))
}

fn merge_candidate_sets(local: &Value, remote: &Value) -> Option<Value> {
  let (Some(local_sets), Some(remote_sets)) = (local.as_object(), remote.as_object()) else {
    return None;
  };
  let mut merged = remote_sets.clone();
  for (step_id, local_set) in local_sets {
    let Some(remote_set) = remote_sets.get(step_id) else {
      merged.insert(step_id.clone(), local_set.clone());
      continue;
    };
    merged.insert(
      step_id.clone(),
      merge_index(local_set, remote_set).unwrap_or_else(|| local_set.clone()),
    );
  }
  Some(Value::Object(merged))
}

fn merge_structural_json(path: &str, local: &[u8], remote: &[u8]) -> Option<Vec<u8>> {
  let mut local: Value = serde_json::from_slice(local).ok()?;
  let remote: Value = serde_json::from_slice(remote).ok()?;
  let structural = path == "pages.json" || path == "project.json" || path.ends_with("/recording.json");
  if !structural {
    return None;
  }
  if path == "pages.json" {
    return merge_page_collection(&local, &remote).and_then(|value| serde_json::to_vec(&value).ok());
  }
  let (Some(local_fields), Some(remote_fields)) = (local.as_object_mut(), remote.as_object()) else {
    return None;
  };
  for (key, remote_value) in remote_fields {
    match key.as_str() {
      "pages" => {
        if let Some(local_value) = local_fields.get(key) {
          if let Some(merged) = merge_page_collection(local_value, remote_value) {
            local_fields.insert(key.clone(), merged);
          }
        } else {
          local_fields.insert(key.clone(), remote_value.clone());
        }
      }
      "candidateSets" => {
        if let Some(local_value) = local_fields.get(key) {
          if let Some(merged) = merge_candidate_sets(local_value, remote_value) {
            local_fields.insert(key.clone(), merged);
          }
        } else {
          local_fields.insert(key.clone(), remote_value.clone());
        }
      }
      _ => {
        local_fields.entry(key.clone()).or_insert_with(|| remote_value.clone());
      }
    }
  }
  serde_json::to_vec(&local).ok()
}

fn merge_run_history(local: &[u8], remote: &[u8]) -> Option<Vec<u8>> {
  let mut seen = BTreeSet::new();
  let mut lines = Vec::new();
  for bytes in [local, remote] {
    let text = std::str::from_utf8(bytes).ok()?;
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
      let value: Value = serde_json::from_str(line).ok()?;
      let id = value.get("id")?.as_str()?.to_owned();
      if seen.insert(id) {
        lines.push(value);
      }
    }
  }
  let mut output = Vec::new();
  for value in lines {
    serde_json::to_writer(&mut output, &value).ok()?;
    output.push(b'\n');
  }
  Some(output)
}

#[cfg(target_os = "macos")]
fn move_to_trash(path: &Path) -> Result<()> {
  use objc2_foundation::{NSFileManager, NSString, NSURL};
  let value = path.to_str().ok_or(ClosingError::InvalidManifest)?;
  let path = NSString::from_str(value);
  let url = NSURL::fileURLWithPath_isDirectory(&path, true);
  NSFileManager::defaultManager()
    .trashItemAtURL_resultingItemURL_error(&url, None)
    .map_err(|_| ClosingError::Mismatch)
}

#[cfg(not(target_os = "macos"))]
fn move_to_trash(_: &Path) -> Result<()> {
  Err(ClosingError::Mismatch)
}

fn finish_pending_trash(stage: &Stage, project_id: &str, path: &Path) -> Result<()> {
  if stage.read(&format!("trashed-{project_id}"), 4)?.is_some() {
    return Ok(());
  }
  if stage.read(&format!("trash-pending-{project_id}"), 4)?.is_none() {
    return Err(ClosingError::Mismatch);
  }
  match std::fs::symlink_metadata(path) {
    Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => move_to_trash(path)?,
    Ok(_) => return Err(ClosingError::Mismatch),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => return Err(error.into()),
  }
  stage.write(&format!("trashed-{project_id}"), b"ok")
}

fn read_source(source: &mut OpenedFileSource, limit: usize) -> Result<Vec<u8>> {
  let file = source.file_mut()?;
  file.seek(SeekFrom::Start(0))?;
  let mut bytes = Vec::new();
  file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
  if bytes.len() > limit {
    return Err(ClosingError::Mismatch);
  }
  source.file_mut()?.seek(SeekFrom::Start(0))?;
  Ok(bytes)
}

fn run_history_path(recording_id: &str) -> String {
  if recording_id == "root" {
    "runs.jsonl".to_owned()
  } else {
    format!("recordings/{recording_id}/runs.jsonl")
  }
}

fn local_result(status: &str) -> &'static str {
  match status {
    "SUCCEEDED" | "FINALIZED" => "saved",
    "FAILED" => "failed",
    _ => "stopped",
  }
}

fn metadata_event_id(kind: &str, id: &str) -> String {
  format!("remote_{}", &sha(format!("{kind}:{id}").as_bytes())[..32])
}

fn append_metadata_event(
  additions: &mut BTreeMap<(String, String), Vec<Value>>,
  project_ref: &str,
  path: String,
  event: Value,
) {
  additions.entry((project_ref.to_owned(), path)).or_default().push(event);
}

fn apply_operation_metadata(
  stage: &Stage,
  projects: &BTreeMap<&str, &SnapshotProject>,
  root: &Path,
  saver: &LocalSaver,
  identity: &SnapshotIdentity,
) -> Result<()> {
  let mut additions = BTreeMap::<(String, String), Vec<Value>>::new();
  let manifest = stage.read("manifest.json", ROOT_LIMIT)?.ok_or(ClosingError::Mismatch)?;
  let root_manifest: Root = parse(&manifest)?;
  for reference in &root_manifest.chunks {
    let bytes = stage
      .read(&format!("chunk-{}.json", reference.index), CHUNK_LIMIT)?
      .ok_or(ClosingError::Mismatch)?;
    for entry in chunk_from(&bytes, reference)?.entries {
      match entry {
        Entry::Run {
          project_ref,
          id,
          recording_id,
          status,
          created_at,
          finished_at,
          steps,
          ..
        } => {
          let at = finished_at.unwrap_or(created_at);
          let steps = if steps.is_empty() {
            vec![SnapshotRunStep {
              step_key: "source".to_owned(),
              label: "NIHO クラウド実行".to_owned(),
              status: status.clone(),
            }]
          } else {
            steps
          };
          for step in steps {
            let mut event = json!({
              "id": metadata_event_id("run", &format!("{id}:{}", step.step_key)),
              "kind": "run",
              "at": at.clone(),
              "stepId": step.step_key,
              "stepName": if step.label.trim().is_empty() { "NIHO クラウド実行" } else { &step.label },
              "version": null,
              "result": local_result(&step.status),
              "remoteRunId": id,
            });
            if step.status == "SUCCEEDED" {
              event["result"] = Value::String("saved".to_owned());
            }
            append_metadata_event(&mut additions, &project_ref, run_history_path(&recording_id), event);
          }
        }
        Entry::Candidate {
          project_ref,
          id,
          run_id,
          recording_id,
          step_key,
          step_label,
          status,
          created_at,
          ..
        } => {
          append_metadata_event(
            &mut additions,
            &project_ref,
            run_history_path(&recording_id),
            json!({
              "id": metadata_event_id("candidate", &id),
              "kind": "run",
              "at": created_at,
              "stepId": step_key,
              "stepName": if step_label.trim().is_empty() { &step_key } else { &step_label },
              "candidateId": id,
              "version": null,
              "result": local_result(&status),
              "remoteRunId": run_id,
            }),
          );
        }
        Entry::Composer {
          project_ref,
          id,
          page_id,
          page_kind,
          recording_id,
          artifact_id,
          conversation_id,
          status,
          created_at,
          finished_at,
          ..
        } => {
          let path = if page_kind == "DOCUMENT" {
            format!("page-chats/{page_id}/runs.jsonl")
          } else {
            run_history_path(recording_id.as_deref().unwrap_or("root"))
          };
          let at = finished_at.unwrap_or(created_at);
          let step_id = artifact_id.unwrap_or_else(|| "source".to_owned());
          append_metadata_event(
            &mut additions,
            &project_ref,
            path,
            json!({
              "id": metadata_event_id("composer", &id),
              "kind": "agent",
              "at": at,
              "stepId": step_id,
              "stepName": "AIと作る",
              "turnId": id,
              "conversationId": conversation_id,
              "version": null,
              "result": local_result(&status),
              "turnRecord": true,
            }),
          );
        }
        Entry::Blob { .. } | Entry::File { .. } => {}
      }
    }
  }
  for ((project_ref, path), events) in additions {
    let project = projects.get(project_ref.as_str()).ok_or(ClosingError::Mismatch)?;
    if project.deleted_at.is_some() && stage.read(&format!("trashed-{}", project.id), 4)?.is_some() {
      continue;
    }
    let target = target(root, project)?;
    if !target.scope.contains(&path) {
      return Err(ClosingError::InvalidManifest);
    }
    let mut current = OpenedFileSource::capture(&target.working_copy, &path)?;
    let mut content = current
      .as_mut()
      .map(|source| read_source(source, 8 * 1024 * 1024))
      .transpose()?
      .unwrap_or_default();
    let additions = events
      .into_iter()
      .filter(|event| !history_has_event(&content, event))
      .collect::<Vec<_>>();
    if additions.is_empty() {
      continue;
    }
    for event in additions {
      serde_json::to_writer(&mut content, &event).map_err(|_| ClosingError::InvalidManifest)?;
      content.push(b'\n');
    }
    let stage_name = format!("history-{}-{}", identity.closing_id, &sha(path.as_bytes())[..16]);
    stage.write(&stage_name, &content)?;
    let source = OpenedFileSource::open(&stage.path, &stage_name, &sha(&content), content.len() as u64)?;
    saver.save_streamed(&target, path, source, SaveKind::System)?;
  }
  Ok(())
}

fn history_has_event(history: &[u8], candidate: &Value) -> bool {
  let Ok(text) = std::str::from_utf8(history) else {
    return false;
  };
  let candidate_id = candidate.get("candidateId").and_then(Value::as_str);
  let turn_id = candidate.get("turnId").and_then(Value::as_str);
  let remote_run_id = candidate.get("remoteRunId").and_then(Value::as_str);
  let step_id = candidate.get("stepId").and_then(Value::as_str);
  text
    .lines()
    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
    .any(|row| {
      if let Some(candidate_id) = candidate_id {
        return row.get("candidateId").and_then(Value::as_str) == Some(candidate_id);
      }
      if let Some(turn_id) = turn_id {
        return row.get("turnId").and_then(Value::as_str) == Some(turn_id);
      }
      let row_run_id = row
        .get("remoteRunId")
        .or_else(|| row.get("runId"))
        .and_then(Value::as_str);
      remote_run_id.is_some() && row_run_id == remote_run_id && row.get("stepId").and_then(Value::as_str) == step_id
    })
}

/// close の外部決定を確認した後にだけ呼ぶ。全ファイルを stage から再ハッシュし、
/// この Mac の異なる版は残してクラウド版を versions に追加する。途中落下は同じ path に再適用できる。
pub(crate) fn apply_committed_snapshot(
  app_data: &Path,
  account_key: &str,
  root_id: &str,
  root: &Path,
  device: Device,
  intent: &CloseIntent,
) -> Result<()> {
  if intent.root_id != root_id {
    return Err(ClosingError::Mismatch);
  }
  let stage = Stage::open(app_data, account_key, &intent.identity)?;
  let verified = verify_stage(&stage, &intent.identity)?;
  if let Some(marker) = stage.read("applied.json", 32)? {
    return if marker == br#"{"version":1}"# {
      Ok(())
    } else {
      Err(ClosingError::Mismatch)
    };
  }
  let saver = LocalSaver::new(
    app_data,
    Namespace::Account {
      account_key: account_key.to_owned(),
    },
    root_id.to_owned(),
    device,
  );
  let projects: BTreeMap<_, _> = verified
    .projects
    .iter()
    .map(|project| (project.id.as_str(), project))
    .collect();
  for project in verified
    .projects
    .iter()
    .filter(|project| project.scope == "FOLDER" && project.project_id != PROFILE_PROJECT_ID)
  {
    let local = target(root, project)?;
    ensure_local_directory(root, &local.working_copy)?;
  }
  for project in verified.projects.iter().filter(|project| project.deleted_at.is_some()) {
    if project.scope != "FOLDER"
      || matches!(
        project.project_id.as_str(),
        DOCS_ROOT_PROJECT_ID | PROFILE_PROJECT_ID | FLOWS_PROJECT_ID
      )
    {
      return Err(ClosingError::InvalidManifest);
    }
    let local = target(root, project)?;
    if stage.read(&format!("trash-pending-{}", project.id), 4)?.is_some() {
      finish_pending_trash(&stage, &project.id, &local.working_copy)?;
    }
  }
  for file in &verified.files {
    if file.expired_audio {
      continue;
    }
    let project = projects.get(file.project_ref.as_str()).ok_or(ClosingError::Mismatch)?;
    let filename = file.staging_file.as_deref().ok_or(ClosingError::Mismatch)?;
    let mut source = OpenedFileSource::open(&stage.path, filename, &file.sha256, file.bytes)?;
    if project.deleted_at.is_some() && stage.read(&format!("trashed-{}", project.id), 4)?.is_some() {
      continue;
    }
    let target = target(root, project)?;
    if !target.scope.contains(&file.path) {
      return Err(ClosingError::InvalidManifest);
    }
    let mut current = OpenedFileSource::capture(&target.working_copy, &file.path)?;
    if current
      .as_ref()
      .is_some_and(|existing| existing.sha256() == file.sha256)
    {
      continue;
    }
    let merged = if current.is_some() && (file.path.ends_with(".json")) {
      let local_bytes = read_source(current.as_mut().expect("checked"), 8 * 1024 * 1024)?;
      let remote_bytes = read_source(&mut source, 8 * 1024 * 1024)?;
      merge_structural_json(&file.path, &local_bytes, &remote_bytes)
    } else if current.is_some() && (file.path.ends_with("/runs.jsonl") || file.path == "runs.jsonl") {
      let local_bytes = read_source(current.as_mut().expect("checked"), 8 * 1024 * 1024)?;
      let remote_bytes = read_source(&mut source, 8 * 1024 * 1024)?;
      merge_run_history(&local_bytes, &remote_bytes)
    } else {
      None
    };
    let destination = match current.as_ref() {
      Some(_) => {
        let mut key = Sha256::new();
        key.update(intent.identity.closing_id.as_bytes());
        key.update(project.id.as_bytes());
        key.update(file.path.as_bytes());
        let digest = key.finalize();
        let version_id = format!(
          "v_{}",
          base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&digest[..16])
        );
        version_path_for(&file.path, &version_id)
      }
      None => file.path.clone(),
    };
    if let Some(bytes) = merged {
      match OpenedFileSource::capture(&target.working_copy, &destination)? {
        Some(existing) if existing.sha256() == file.sha256 => {}
        Some(_) => return Err(ClosingError::Mismatch),
        None => {
          let version_source = OpenedFileSource::open(&stage.path, filename, &file.sha256, file.bytes)?;
          saver.save_streamed(&target, destination, version_source, SaveKind::System)?;
        }
      }
      if OpenedFileSource::capture(&target.working_copy, &file.path)?
        .is_some_and(|existing| existing.sha256() == sha(&bytes))
      {
        continue;
      }
      let merged_name = format!("merged-{}-{}", project.id, &sha(file.path.as_bytes())[..16]);
      stage.write(&merged_name, &bytes)?;
      let merged_source = OpenedFileSource::open(&stage.path, &merged_name, &sha(&bytes), bytes.len() as u64)?;
      saver.save_streamed(&target, file.path.clone(), merged_source, SaveKind::System)?;
    } else {
      if OpenedFileSource::capture(&target.working_copy, &destination)?
        .is_some_and(|existing| existing.sha256() == file.sha256)
      {
        continue;
      }
      saver.save_streamed(&target, destination, source, SaveKind::System)?;
    }
  }
  apply_operation_metadata(&stage, &projects, root, &saver, &intent.identity)?;
  // 削除済みフォルダもローカル作業コピーへ反映後にゴミ箱へ移す。pending marker は
  // move の前に fsync し、move 成功直後のクラッシュは次回 path absence で完了と判定する。
  for project in verified.projects.iter().filter(|project| project.deleted_at.is_some()) {
    if stage.read(&format!("trashed-{}", project.id), 4)?.is_some() {
      continue;
    }
    let local = target(root, project)?;
    stage.write(&format!("trash-pending-{}", project.id), b"ok")?;
    finish_pending_trash(&stage, &project.id, &local.working_copy)?;
  }
  stage.write("applied.json", b"{\"version\":1}")?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  struct FakeTransport {
    root: Vec<u8>,
    chunk: Vec<u8>,
    object: Vec<u8>,
  }
  #[async_trait]
  impl SnapshotTransport for FakeTransport {
    async fn heartbeat(&self, _: &SnapshotIdentity) -> Result<()> {
      Ok(())
    }
    async fn part(&self, _: &SnapshotIdentity, chunk: Option<usize>) -> Result<Vec<u8>> {
      match chunk {
        None => Ok(self.root.clone()),
        Some(0) => Ok(self.chunk.clone()),
        _ => Err(ClosingError::Mismatch),
      }
    }
    async fn object(&self, _: &SnapshotIdentity, _: &ObjectSpec, writer: &mut (dyn Write + Send)) -> Result<()> {
      writer.write_all(&self.object)?;
      Ok(())
    }
  }

  fn fixture_with_path(path: &str) -> (FakeTransport, SnapshotIdentity) {
    let object = b"cloud contents".to_vec();
    let digest = sha(&object);
    let chunk = serde_json::to_vec(&serde_json::json!({
      "version": 1, "entries": [
        { "type": "BLOB", "projectRef": "project-1", "id": "blob-1", "sha256": digest,
          "bytes": object.len().to_string(), "contentType": "text/plain", "retainedUntil": null,
          "source": { "kind": "OBJECT", "objectKey": "docs-vault/user-1/blob-1", "generation": "22" } },
        { "type": "FILE", "projectRef": "project-1", "id": "file-1", "path": path,
          "sha256": digest, "bytes": object.len().to_string(), "kind": "text", "revision": 1,
          "modifiedAt": "2026-10-18T00:00:00.000Z" }
      ]
    }))
    .unwrap();
    let root = serde_json::to_vec(&serde_json::json!({
      "version": 1, "userId": "user-1", "closingId": "close-1", "epoch": "5",
      "createdAt": "2026-10-18T00:00:00.000Z",
      "projects": [{ "id": "project-1", "projectId": "folder-1", "scope": "FOLDER", "name": "フォルダ",
        "revision": 1, "deletedAt": null }],
      "counts": { "BLOB": 1, "CANDIDATE": 0, "COMPOSER": 0, "FILE": 1, "RUN": 0 },
      "chunks": [{ "index": 0, "objectKey": "docs-close-snapshots/v1/users/user-1/close-1/chunks/000000.json",
        "generation": "33", "sha256": sha(&chunk), "bytes": chunk.len(), "entries": 2 }]
    }))
    .unwrap();
    let identity = SnapshotIdentity {
      user_id: "user-1".into(),
      closing_id: "close-1".into(),
      epoch: "5".into(),
      manifest_digest: sha(&root),
    };
    (FakeTransport { root, chunk, object }, identity)
  }

  fn fixture() -> (FakeTransport, SnapshotIdentity) {
    fixture_with_path("page.md")
  }

  #[test]
  fn structural_indexes_merge_local_first_and_keep_remote_only_ids() {
    let local = serde_json::json!({
      "version": 1,
      "order": ["local", "shared"],
      "items": { "local": { "title": "local" }, "shared": { "title": "local copy" } }
    });
    let remote = serde_json::json!({
      "version": 1,
      "order": ["shared", "remote"],
      "items": { "shared": { "title": "cloud copy" }, "remote": { "title": "cloud only" } }
    });
    let merged = merge_structural_json(
      "pages.json",
      &serde_json::to_vec(&local).unwrap(),
      &serde_json::to_vec(&remote).unwrap(),
    )
    .map(|bytes| serde_json::from_slice::<Value>(&bytes).unwrap())
    .unwrap();
    assert_eq!(merged["order"], serde_json::json!(["local", "shared", "remote"]));
    assert_eq!(merged["items"]["shared"]["title"], "local copy");
    assert_eq!(merged["items"]["remote"]["title"], "cloud only");

    let local_project = serde_json::json!({
      "name": "local name",
      "candidateSets": { "step": { "stepId": "step", "order": ["a"], "items": { "a": { "name": "A" } } } }
    });
    let remote_project = serde_json::json!({
      "name": "cloud name",
      "remoteOnly": true,
      "candidateSets": { "step": { "stepId": "step", "order": ["b"], "items": { "b": { "name": "B" } } } }
    });
    let merged = merge_structural_json(
      "project.json",
      &serde_json::to_vec(&local_project).unwrap(),
      &serde_json::to_vec(&remote_project).unwrap(),
    )
    .map(|bytes| serde_json::from_slice::<Value>(&bytes).unwrap())
    .unwrap();
    assert_eq!(merged["name"], "local name");
    assert_eq!(merged["remoteOnly"], true);
    assert_eq!(merged["candidateSets"]["step"]["order"], serde_json::json!(["a", "b"]));
  }

  #[test]
  fn pending_trash_marker_finishes_after_the_folder_was_already_moved() {
    let unique = format!(
      "niho-docs-closing-trash-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
    );
    let app_data = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&app_data).unwrap();
    let key = "a".repeat(64);
    let (_, identity) = fixture();
    let stage = Stage::open(&app_data, &key, &identity).unwrap();
    stage.write("trash-pending-project-1", b"ok").unwrap();
    let folder = app_data.join("root/projects/folder-1");
    finish_pending_trash(&stage, "project-1", &folder).unwrap();
    assert_eq!(
      stage.read("trashed-project-1", 4).unwrap().as_deref(),
      Some(b"ok".as_slice())
    );
    std::fs::remove_dir_all(&app_data).unwrap();
  }

  #[test]
  fn cleanup_removes_only_applied_close_stages() {
    let unique = format!(
      "niho-docs-closing-cleanup-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
    );
    let app_data = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&app_data).unwrap();
    let key = "a".repeat(64);
    let (_, identity) = fixture();
    let applied = Stage::open(&app_data, &key, &identity).unwrap();
    applied.write("applied.json", b"{\"version\":1}").unwrap();
    let applied_path = applied.path.clone();
    let mut incomplete_identity = identity;
    incomplete_identity.closing_id = "close-2".to_owned();
    let incomplete = Stage::open(&app_data, &key, &incomplete_identity).unwrap();
    let incomplete_path = incomplete.path.clone();
    drop(applied);
    drop(incomplete);

    cleanup_applied_close_stages(&app_data).unwrap();

    assert!(!applied_path.exists());
    assert!(incomplete_path.is_dir());
    std::fs::remove_dir_all(&app_data).unwrap();
  }

  #[test]
  fn committed_snapshot_materializes_candidate_run_and_composer_history() {
    let unique = format!(
      "niho-docs-closing-metadata-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
    );
    let app_data = std::env::temp_dir().join(&unique);
    let root_dir = app_data.join("root");
    std::fs::create_dir_all(&root_dir).unwrap();
    let key = "a".repeat(64);
    let chunk = serde_json::to_vec(&serde_json::json!({
      "version": 1,
      "entries": [
        { "type": "CANDIDATE", "projectRef": "project-1", "id": "candidate-1", "runId": "run-1",
          "attemptId": "attempt-1", "blobId": "blob-1", "recordingPageId": "page-1", "recordingId": "root",
          "stepKey": "revise", "stepLabel": "推敲", "status": "FINALIZED", "createdAt": "2026-10-18T00:00:00.000Z",
          "objectKey": "docs-vault/user-1/candidate", "objectGeneration": null, "sha256": null, "bytes": null },
        { "type": "COMPOSER", "projectRef": "project-1", "id": "turn-1", "pageId": "page-1",
          "pageKind": "RECORDING", "recordingId": "root", "artifactId": "revise", "conversationId": "conversation-1",
          "status": "SUCCEEDED", "createdAt": "2026-10-18T00:00:00.000Z", "finishedAt": "2026-10-18T00:01:00.000Z" },
        { "type": "RUN", "projectRef": "project-1", "id": "run-1", "recordingPageId": "page-1",
          "recordingId": "root", "status": "SUCCEEDED", "createdAt": "2026-10-18T00:00:00.000Z",
          "finishedAt": "2026-10-18T00:01:00.000Z",
          "steps": [{ "stepKey": "revise", "label": "推敲", "status": "SUCCEEDED" }] }
      ]
    }))
    .unwrap();
    let root_manifest = serde_json::to_vec(&serde_json::json!({
      "version": 1, "userId": "user-1", "closingId": "close-1", "epoch": "5",
      "createdAt": "2026-10-18T00:00:00.000Z",
      "projects": [{ "id": "project-1", "projectId": "folder-1", "scope": "FOLDER", "name": "フォルダ",
        "revision": 1, "deletedAt": null }],
      "counts": { "BLOB": 0, "CANDIDATE": 1, "COMPOSER": 1, "FILE": 0, "RUN": 1 },
      "chunks": [{ "index": 0, "objectKey": "docs-close-snapshots/v1/users/user-1/close-1/chunks/000000.json",
        "generation": "33", "sha256": sha(&chunk), "bytes": chunk.len(), "entries": 3 }]
    }))
    .unwrap();
    let identity = SnapshotIdentity {
      user_id: "user-1".into(),
      closing_id: "close-1".into(),
      epoch: "5".into(),
      manifest_digest: sha(&root_manifest),
    };
    let stage = Stage::open(&app_data, &key, &identity).unwrap();
    stage.write("manifest.json", &root_manifest).unwrap();
    stage.write("chunk-0.json", &chunk).unwrap();
    drop(stage);
    let root_id = "r_aaaaaaaaaaaaaaaaaaaaaa";
    let intent = mark_close_intent(&app_data, &key, root_id, &identity)
      .and_then(|_| pending_close_intent(&app_data, &key, "user-1", root_id, "5"))
      .unwrap()
      .unwrap();
    let device = Device {
      device_id: "d_test".into(),
      device_name: "Test Mac".into(),
      device_kind: Some("mac".into()),
    };
    apply_committed_snapshot(&app_data, &key, root_id, &root_dir, device, &intent).unwrap();
    assert!(root_dir.join("projects/folder-1").is_dir());
    let history = std::fs::read_to_string(root_dir.join("projects/folder-1/runs.jsonl")).unwrap();
    assert!(history.contains("\"candidateId\":\"candidate-1\""));
    assert!(history.contains("\"remoteRunId\":\"run-1\""));
    assert!(history.contains("\"turnId\":\"turn-1\""));
    assert!(history.contains("\"conversationId\":\"conversation-1\""));
    std::fs::remove_dir_all(&app_data).unwrap();
  }

  #[test]
  fn run_history_union_keeps_local_order_and_deduplicates_ids() {
    let local = b"{\"id\":\"a\"}\n{\"id\":\"b\"}\n";
    let remote = b"{\"id\":\"b\",\"remote\":true}\n{\"id\":\"c\"}\n";
    let merged = merge_run_history(local, remote).unwrap();
    let rows = std::str::from_utf8(&merged).unwrap().lines().collect::<Vec<_>>();
    assert_eq!(rows, vec!["{\"id\":\"a\"}", "{\"id\":\"b\"}", "{\"id\":\"c\"}"]);
  }

  #[test]
  fn interrupted_snapshot_rechecks_every_file_before_close() {
    tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .unwrap()
      .block_on(async {
        let unique = format!(
          "niho-docs-closing-{}-{}",
          std::process::id(),
          std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
        );
        let app_data = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&app_data).unwrap();
        let key = "a".repeat(64);
        let (transport, identity) = fixture();
        let first = receive_snapshot(&transport, &app_data, &key, &identity, 0)
          .await
          .unwrap();
        assert_eq!(first.file_count, 1);
        verify_snapshot_placement(&app_data, &first).unwrap();
        std::fs::write(first.staging_path.join("object-0-0"), b"wrong").unwrap();
        assert!(matches!(
          verify_staged_snapshot(&app_data, &key, &identity),
          Err(ClosingError::Mismatch)
        ));
        let resumed = receive_snapshot(&transport, &app_data, &key, &identity, 0)
          .await
          .unwrap();
        assert_eq!(resumed.file_count, 1);
        assert_eq!(resumed.files[0].sha256, sha(&transport.object));
        std::fs::remove_dir_all(&app_data).unwrap();
      });
  }

  #[test]
  fn committed_snapshot_preserves_a_different_local_immutable_version_on_replay() {
    tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .unwrap()
      .block_on(async {
        let unique = format!(
          "niho-docs-closing-version-{}-{}",
          std::process::id(),
          std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
        );
        let app_data = std::env::temp_dir().join(&unique);
        let root = app_data.join("root");
        let path = "versions/files/existing/v_original.md";
        let local = root.join("projects/folder-1").join(path);
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        std::fs::write(&local, b"local contents").unwrap();
        let key = "a".repeat(64);
        let root_id = "r_aaaaaaaaaaaaaaaaaaaaaa";
        let (transport, identity) = fixture_with_path(path);
        receive_snapshot(&transport, &app_data, &key, &identity, 0)
          .await
          .unwrap();
        mark_close_intent(&app_data, &key, root_id, &identity).unwrap();
        let intent = pending_close_intent(&app_data, &key, "user-1", root_id, "5")
          .unwrap()
          .unwrap();
        let device = Device {
          device_id: "d_test".into(),
          device_name: "Test Mac".into(),
          device_kind: Some("mac".into()),
        };
        apply_committed_snapshot(&app_data, &key, root_id, &root, device.clone(), &intent).unwrap();
        apply_committed_snapshot(&app_data, &key, root_id, &root, device, &intent).unwrap();
        assert_eq!(std::fs::read(&local).unwrap(), b"local contents");
        let mut version_id = Sha256::new();
        version_id.update(identity.closing_id.as_bytes());
        version_id.update(b"project-1");
        version_id.update(path.as_bytes());
        let version_id = format!(
          "v_{}",
          base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&version_id.finalize()[..16])
        );
        let imported = root.join("projects/folder-1").join(version_path_for(path, &version_id));
        assert_eq!(std::fs::read(imported).unwrap(), transport.object);
        assert!(snapshot_applied(&app_data, &key, &identity).unwrap());
        std::fs::remove_dir_all(&app_data).unwrap();
      });
  }
}
