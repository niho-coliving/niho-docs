use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use base64::Engine as _;
use chrono::{DateTime, SecondsFormat, Utc};
use icu_casemap::CaseMapper;
use icu_normalizer::ComposingNormalizerBorrowed;
use sha2::{Digest, Sha256};

use crate::types::{
    BlockedReason, FileKind, ManifestFile, Result, ScannedCopy, SyncScope, VaultError, VaultState,
};

pub const BLOB_MAX_BYTES: u64 = 1024 * 1024 * 1024;
/// text / json は API の読み出し上限と同じ 8 MiB まで。
pub const TEXT_MAX_BYTES: u64 = 8 * 1024 * 1024;
pub const AUDIO_BLOB_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const FILE_MAX_COUNT: usize = 20_000;

#[derive(Clone, Copy, Debug)]
pub struct ScanLimits {
    pub max_blob_bytes: u64,
    pub max_text_bytes: u64,
    pub max_audio_blob_bytes: u64,
    pub max_files: usize,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_blob_bytes: BLOB_MAX_BYTES,
            max_text_bytes: TEXT_MAX_BYTES,
            max_audio_blob_bytes: AUDIO_BLOB_MAX_BYTES,
            max_files: FILE_MAX_COUNT,
        }
    }
}

pub fn validate_relative_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 1024
        || path.starts_with('/')
        || path.contains('\\')
        || path.bytes().any(|byte| byte < 0x20 || byte == 0x7f)
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(VaultError::InvalidPath(path.into()));
    }
    if !ComposingNormalizerBorrowed::new_nfc().is_normalized_utf8(path.as_bytes()) {
        return Err(VaultError::InvalidPath(format!(
            "NFC ではありません: {path}"
        )));
    }
    let parsed = Path::new(path);
    for component in parsed.components() {
        match component {
            Component::Normal(value) => {
                let value = value
                    .to_str()
                    .ok_or_else(|| VaultError::InvalidPath(path.into()))?;
                if value.is_empty() || value.len() > 255 || value == "." || value == ".." {
                    return Err(VaultError::InvalidPath(path.into()));
                }
            }
            _ => return Err(VaultError::InvalidPath(path.into())),
        }
    }
    Ok(())
}

fn server_ignored_component(part: &str) -> bool {
    matches!(part, ".run.lock" | ".DS_Store" | ".conflicts") || part.ends_with(".tmp")
}

/// アプリの保存が作る一時ファイル（`.page.md.tmp-123-ab` など）。
fn store_temp_component(part: &str) -> bool {
    part.starts_with('.') && part.contains(".tmp")
}

fn private_component(part: &str) -> bool {
    matches!(
        part,
        "settings.json" | "device.json" | "vault" | "codex-home"
    )
}

/// サーバーが ignored_path として拒否する path（どの階層の要素でも）。
pub(crate) fn is_server_ignored(path: &str) -> bool {
    path.split('/').any(server_ignored_component)
}

/// 同期しない path。サーバーの規則に、アプリの保存が作る一時ファイルを加える。
pub fn is_sync_ignored(path: &str) -> bool {
    path.split('/')
        .any(|part| server_ignored_component(part) || store_temp_component(part))
}

/// 秘密を含みうる path。サーバーは private_path として拒否する。
pub fn is_private_path(path: &str) -> bool {
    path.split('/').any(private_component)
}

pub(crate) fn find_case_folded_path_collision<'a>(
    paths: impl IntoIterator<Item = &'a str>,
) -> Option<(String, String)> {
    let mut prefixes: BTreeMap<String, (String, String, bool)> = BTreeMap::new();
    let case_mapper = CaseMapper::new();
    for path in paths {
        let parts: Vec<_> = path.split('/').collect();
        let mut prefix = String::new();
        for (index, part) in parts.iter().enumerate() {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let is_file = index + 1 == parts.len();
            let folded = case_mapper.fold_string(&prefix).into_owned();
            if let Some((existing, source_path, existing_is_file)) = prefixes.get(&folded) {
                if existing != &prefix || *existing_is_file != is_file {
                    return Some((source_path.clone(), path.to_owned()));
                }
            } else {
                prefixes.insert(folded, (prefix.clone(), path.to_owned(), is_file));
            }
        }
    }
    None
}

pub fn scan_working_copy(
    root: &Path,
    state: &VaultState,
    writer_device_id: &str,
    limits: ScanLimits,
) -> Result<ScannedCopy> {
    scan_target(root, &SyncScope::All, state, writer_device_id, None, limits)
}

/// `docs-root` / `profile` の narrow allowlist を含め、対象の全量を走査する。
/// 保存先の再開 baseline は通常同期と同じ対象範囲・安全検査を使う。
pub fn scan_project_target(
    target: &crate::types::ProjectTarget,
    state: &VaultState,
    writer_device_id: &str,
    limits: ScanLimits,
) -> Result<ScannedCopy> {
    scan_target(
        &target.working_copy,
        &target.scope,
        state,
        writer_device_id,
        None,
        limits,
    )
}

struct ScanContext<'a> {
    root: &'a Path,
    base: BTreeMap<&'a str, &'a ManifestFile>,
    dirty: &'a BTreeMap<String, u64>,
    writer_device_id: &'a str,
    writer_device_kind: Option<&'a str>,
    limits: ScanLimits,
    files: Vec<ManifestFile>,
    blocked: BTreeMap<String, BlockedReason>,
}

/// 写しを走査する。上限超過・空の音声・秘密の path は失敗にせず blocked に入れる。
pub(crate) fn scan_target(
    root: &Path,
    scope: &SyncScope,
    state: &VaultState,
    writer_device_id: &str,
    writer_device_kind: Option<&str>,
    limits: ScanLimits,
) -> Result<ScannedCopy> {
    let root_meta = fs::symlink_metadata(root)?;
    if root_meta.file_type().is_symlink() {
        return Err(VaultError::Symlink(root.display().to_string()));
    }
    if !root_meta.is_dir() {
        return Err(VaultError::InvalidPath(root.display().to_string()));
    }
    let mut context = ScanContext {
        root,
        base: state
            .base
            .iter()
            .map(|entry| (entry.path.as_str(), entry))
            .collect(),
        dirty: &state.dirty,
        writer_device_id,
        writer_device_kind,
        limits,
        files: Vec::new(),
        blocked: BTreeMap::new(),
    };
    match scope {
        SyncScope::All => scan_directory(&mut context, root)?,
        SyncScope::Root => {
            scan_single(&mut context, "pages.json")?;
            for directory in ["pages", "recordings", "page-chats", "assets", "versions"] {
                if let Some(directory) = scope_directory(root, directory)? {
                    scan_scoped_directory(&mut context, &directory, scope)?;
                }
            }
        }
        SyncScope::Profile => {
            scan_single(&mut context, "about.json")?;
            scan_single(&mut context, "execution.json")?;
            // 途中の versions・versions/files がリンクでも外へ出ない（scope_directory が親のリンクを断る）
            if let Some(directory) = scope_directory(
                root,
                "versions/files/646bd422594fa181f6e2fca4e1da7504a5fe35dbfbc8cb11c0b4b47813916086",
            )? {
                scan_scoped_directory(&mut context, &directory, scope)?;
            }
            if let Some(directory) = scope_directory(
                root,
                "versions/files/899250d2ce590e1880b044c7da884b922c2092119d65582809b427c2e108d7af",
            )? {
                scan_scoped_directory(&mut context, &directory, scope)?;
            }
        }
    }
    let ScanContext {
        mut files, blocked, ..
    } = context;
    if let Some((left, right)) =
        find_case_folded_path_collision(files.iter().map(|file| file.path.as_str()))
    {
        return Err(VaultError::InvalidPath(format!(
            "case-folded path collision: {left} / {right}"
        )));
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(ScannedCopy {
        files,
        dirty_generation: state.dirty_generation,
        blocked,
    })
}

/// narrow scope が明示した subtree だけを歩き、allowlist 外のファイルは無視する。
fn scan_scoped_directory(
    context: &mut ScanContext<'_>,
    directory: &Path,
    scope: &SyncScope,
) -> Result<()> {
    let metadata = match fs::symlink_metadata(directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
        Ok(metadata) => metadata,
    };
    if metadata.file_type().is_symlink() {
        return Err(VaultError::Symlink(directory.display().to_string()));
    }
    if !metadata.is_dir() {
        return Err(VaultError::InvalidPath(directory.display().to_string()));
    }
    let mut entries = fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let full_path = entry.path();
        let relative = full_path
            .strip_prefix(context.root)
            .map_err(|_| VaultError::InvalidPath(full_path.display().to_string()))?
            .to_str()
            .ok_or_else(|| VaultError::InvalidPath(full_path.display().to_string()))?
            .replace(std::path::MAIN_SEPARATOR, "/");
        if is_sync_ignored(&relative) {
            continue;
        }
        validate_relative_path(&relative)?;
        let metadata = fs::symlink_metadata(&full_path)?;
        if metadata.file_type().is_symlink() {
            return Err(VaultError::Symlink(relative));
        }
        if is_private_path(&relative) {
            context.blocked.insert(relative, BlockedReason::PrivatePath);
            continue;
        }
        if metadata.is_dir() {
            scan_scoped_directory(context, &full_path, scope)?;
        } else if metadata.is_file() && scope.contains(&relative) {
            scan_file(context, relative, &metadata)?;
        } else if !metadata.is_file() {
            return Err(VaultError::InvalidPath(relative));
        }
    }
    Ok(())
}

fn scan_directory(context: &mut ScanContext<'_>, directory: &Path) -> Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let full_path = entry.path();
        let relative = full_path
            .strip_prefix(context.root)
            .map_err(|_| VaultError::InvalidPath(full_path.display().to_string()))?;
        let relative = relative
            .to_str()
            .ok_or_else(|| VaultError::InvalidPath(full_path.display().to_string()))?
            .replace(std::path::MAIN_SEPARATOR, "/");
        if is_sync_ignored(&relative) {
            continue;
        }
        validate_relative_path(&relative)?;
        let metadata = fs::symlink_metadata(&full_path)?;
        if metadata.file_type().is_symlink() {
            return Err(VaultError::Symlink(relative));
        }
        if is_private_path(&relative) {
            context.blocked.insert(relative, BlockedReason::PrivatePath);
            continue;
        }
        if metadata.is_dir() {
            scan_directory(context, &full_path)?;
            continue;
        }
        if !metadata.is_file() {
            return Err(VaultError::InvalidPath(relative));
        }
        scan_file(context, relative, &metadata)?;
    }
    Ok(())
}

/// typed scope が列挙したフォルダ。無ければ None。途中や最後がリンク、またはファイルなら失敗にする。
fn scope_directory(root: &Path, relative: &str) -> Result<Option<PathBuf>> {
    validate_relative_path(relative)?;
    reject_symlink_parents(root, relative)?;
    let directory = root.join(relative);
    match fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(VaultError::Symlink(relative.to_owned()))
        }
        Ok(metadata) if !metadata.is_dir() => Err(VaultError::InvalidPath(relative.to_owned())),
        Ok(_) => Ok(Some(directory)),
    }
}

fn scan_single(context: &mut ScanContext<'_>, relative: &str) -> Result<()> {
    validate_relative_path(relative)?;
    if is_sync_ignored(relative) {
        return Ok(());
    }
    if is_private_path(relative) {
        context
            .blocked
            .insert(relative.to_owned(), BlockedReason::PrivatePath);
        return Ok(());
    }
    reject_symlink_parents(context.root, relative)?;
    match fs::symlink_metadata(context.root.join(relative)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(VaultError::Symlink(relative.to_owned()))
        }
        Ok(metadata) if !metadata.is_file() => Err(VaultError::InvalidPath(relative.to_owned())),
        Ok(metadata) => scan_file(context, relative.to_owned(), &metadata),
    }
}

fn scan_file(
    context: &mut ScanContext<'_>,
    relative: String,
    metadata: &fs::Metadata,
) -> Result<()> {
    let kind = FileKind::from_path(&relative);
    let length = metadata.len();
    if kind == FileKind::Audio && length == 0 {
        context.blocked.insert(relative, BlockedReason::EmptyAudio);
        return Ok(());
    }
    if length > kind_limit(kind, context.limits) {
        context.blocked.insert(relative, BlockedReason::TooLarge);
        return Ok(());
    }
    if context.files.len() >= context.limits.max_files {
        return Err(VaultError::TooManyFiles);
    }
    let modified_at = format_system_time(metadata.modified()?);
    let cached = (!context.dirty.contains_key(&relative))
        .then(|| context.base.get(relative.as_str()).copied())
        .flatten()
        .filter(|cached| cached.bytes == length && same_instant(&cached.modified_at, &modified_at));
    let sha256 = match cached {
        Some(cached) => cached.sha256.clone(),
        None => hash_file(&context.root.join(&relative))?,
    };
    context.files.push(ManifestFile {
        path: relative,
        sha256,
        bytes: length,
        kind,
        modified_at,
        writer_device_id: cached
            .map(|entry| entry.writer_device_id.clone())
            .unwrap_or_else(|| context.writer_device_id.to_owned()),
        writer_device_kind: match cached {
            Some(entry) => entry.writer_device_kind.clone(),
            None => context.writer_device_kind.map(str::to_owned),
        },
        retained_until: cached.and_then(|entry| entry.retained_until.clone()),
        available: cached.map(|entry| entry.available).unwrap_or(true),
    });
    Ok(())
}

pub(crate) fn kind_limit(kind: FileKind, limits: ScanLimits) -> u64 {
    match kind {
        FileKind::Text | FileKind::Json => limits.max_text_bytes.min(limits.max_blob_bytes),
        // 音声は 1 ファイル 2 GiB（含む）、そのほかは 1 GiB（含む）まで（#18653）。
        FileKind::Audio => limits.max_audio_blob_bytes,
        FileKind::Other => limits.max_blob_bytes,
    }
}

/// ミリ秒に揃える（サーバーの modifiedAt と同じ精度）。
pub(crate) fn format_system_time(value: SystemTime) -> String {
    let value: DateTime<Utc> = value.into();
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// 書式の違う ISO 8601 を同じ瞬間（ミリ秒）として比べる。
pub(crate) fn same_instant(left: &str, right: &str) -> bool {
    match (
        DateTime::parse_from_rfc3339(left),
        DateTime::parse_from_rfc3339(right),
    ) {
        (Ok(left), Ok(right)) => left.timestamp_millis() == right.timestamp_millis(),
        _ => left == right,
    }
}

pub(crate) fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let (_, sha256) = hash_open_file(&mut file)?;
    Ok(sha256)
}

pub(crate) fn hash_open_file(file: &mut File) -> Result<(u64, String)> {
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 256 * 1024];
    let mut bytes = 0_u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes = bytes
            .checked_add(count as u64)
            .ok_or_else(|| VaultError::InvalidResponse("blob byte count overflow".into()))?;
        hasher.update(&buffer[..count]);
    }
    Ok((bytes, format!("{:x}", hasher.finalize())))
}

pub(crate) fn verify_open_file(file: &mut File, expected: &ManifestFile) -> Result<()> {
    let (bytes, sha256) = hash_open_file(file)?;
    if bytes != expected.bytes {
        return Err(VaultError::InvalidResponse("blob bytes mismatch".into()));
    }
    if sha256 != expected.sha256 {
        return Err(VaultError::InvalidResponse("blob sha256 mismatch".into()));
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(())
}

/// 一度開いた source を、その同じ file handle からだけ journal/snapshot/working copy へ流す。
/// path の差し替え・symlink 化、内容・長さの変化は commit 前後に拒否する。
pub struct OpenedFileSource {
    file: File,
    path: PathBuf,
    bytes: u64,
    sha256: String,
    identity: FileIdentity,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed: (i64, i64),
    len: u64,
    modified: Option<SystemTime>,
}

fn file_identity(metadata: &fs::Metadata) -> FileIdentity {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt as _;
    FileIdentity {
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
        #[cfg(unix)]
        changed: (metadata.ctime(), metadata.ctime_nsec()),
        len: metadata.len(),
        modified: metadata.modified().ok(),
    }
}

impl OpenedFileSource {
    /// symlink を辿らず一度だけ開き、その時点の bytes・sha256・identity を固定する。
    pub(crate) fn capture(root: &Path, relative: &str) -> Result<Option<Self>> {
        let path = root.join(relative);
        let Some(mut file) = open_file_no_follow(root, relative)? else {
            return Ok(None);
        };
        let metadata = file.metadata()?;
        let identity = file_identity(&metadata);
        let (bytes, sha256) = hash_open_file(&mut file)?;
        let source = Self {
            file,
            path,
            bytes,
            sha256,
            identity,
        };
        source.verify_identity()?;
        Ok(Some(source))
    }

    /// symlink を辿らず source を一度だけ開き、期待する内容と file identity を固定する。
    pub fn open(
        root: &Path,
        relative: &str,
        expected_sha256: &str,
        expected_bytes: u64,
    ) -> Result<Self> {
        let path = root.join(relative);
        let file = open_file_no_follow(root, relative)?
            .ok_or_else(|| VaultError::InvalidPath(relative.to_owned()))?;
        Self::from_opened(file, path, expected_sha256, expected_bytes)
    }

    /// 呼び出し側が `create_new` で開いた一時ファイルを、その file handle と path に束縛する。
    pub fn from_opened(
        mut file: File,
        path: PathBuf,
        expected_sha256: &str,
        expected_bytes: u64,
    ) -> Result<Self> {
        let metadata = file.metadata()?;
        let identity = file_identity(&metadata);
        let (bytes, sha256) = hash_open_file(&mut file)?;
        if bytes != expected_bytes || sha256 != expected_sha256 {
            return Err(VaultError::InvalidResponse("stream source mismatch".into()));
        }
        let source = Self {
            file,
            path,
            bytes,
            sha256,
            identity,
        };
        source.verify_identity()?;
        Ok(source)
    }

    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    pub fn verify_identity(&self) -> Result<()> {
        let opened = file_identity(&self.file.metadata()?);
        let path = fs::symlink_metadata(&self.path)?;
        if path.file_type().is_symlink() || !path.is_file() {
            return Err(VaultError::Symlink(self.path.display().to_string()));
        }
        if opened != self.identity || file_identity(&path) != self.identity {
            return Err(VaultError::InvalidResponse("stream source changed".into()));
        }
        Ok(())
    }

    /// 検証済みの同じ file descriptor を署名 URL への streaming 転送へ渡す。
    pub fn file_mut(&mut self) -> Result<&mut File> {
        self.verify_identity()?;
        Ok(&mut self.file)
    }

    fn copy_verified(&mut self, output: &mut File) -> Result<()> {
        self.verify_identity()?;
        self.file.seek(SeekFrom::Start(0))?;
        output.set_len(0)?;
        output.seek(SeekFrom::Start(0))?;
        let mut hasher = Sha256::new();
        let mut bytes = 0_u64;
        let mut buffer = vec![0_u8; 256 * 1024];
        loop {
            let count = self.file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            bytes = bytes.checked_add(count as u64).ok_or_else(|| {
                VaultError::InvalidResponse("stream source byte count overflow".into())
            })?;
            if bytes > self.bytes {
                return Err(VaultError::InvalidResponse("stream source changed".into()));
            }
            hasher.update(&buffer[..count]);
            output.write_all(&buffer[..count])?;
        }
        if bytes != self.bytes || format!("{:x}", hasher.finalize()) != self.sha256 {
            return Err(VaultError::InvalidResponse("stream source changed".into()));
        }
        self.verify_identity()?;
        self.file.seek(SeekFrom::Start(0))?;
        Ok(())
    }

    pub(crate) fn write_atomic(&mut self, root: &Path, relative: &str) -> Result<()> {
        let mut output = AtomicFileWriter::new(root, relative)?;
        self.copy_verified(output.file_mut())?;
        let temporary = output.into_temporary()?;
        commit_temporary(root, relative, &temporary)
    }

    /// copy と file fsync だけを済ませる。rename は短い gate の中で行う。
    pub(crate) fn prepare_atomic(
        &mut self,
        root: &Path,
        relative: &str,
    ) -> Result<PreparedAtomicWrite> {
        let mut output = AtomicFileWriter::new(root, relative)?;
        self.copy_verified(output.file_mut())?;
        Ok(PreparedAtomicWrite {
            root: root.to_path_buf(),
            relative: relative.to_owned(),
            temporary: Some(output.into_temporary()?),
        })
    }
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 一時ファイル → fsync → rename → 親 directory の fsync。symlink の親は拒否する。
pub fn atomic_write(root: &Path, relative: &str, bytes: &[u8]) -> Result<()> {
    let temporary = prepare_temporary(root, relative, bytes)?;
    commit_temporary(root, relative, &temporary)
}

/// 対象と同じ directory に一時ファイルを書いて fsync する（gate の外で使える）。
pub(crate) fn prepare_temporary(root: &Path, relative: &str, bytes: &[u8]) -> Result<PathBuf> {
    let mut output = AtomicFileWriter::new(root, relative)?;
    output.file_mut().write_all(bytes)?;
    output.into_temporary()
}

/// gate 外で fsync 済みの一時ファイル。commit されずに落ちた場合は必ず消す。
pub(crate) struct PreparedAtomicWrite {
    root: PathBuf,
    relative: String,
    temporary: Option<PathBuf>,
}

impl PreparedAtomicWrite {
    pub(crate) fn commit(mut self) -> Result<()> {
        let temporary = self
            .temporary
            .take()
            .expect("prepared atomic write is pending");
        commit_temporary(&self.root, &self.relative, &temporary)
    }
}

impl Drop for PreparedAtomicWrite {
    fn drop(&mut self) {
        if let Some(temporary) = self.temporary.take() {
            discard_atomic_temporary(&temporary);
        }
    }
}

/// 大きなファイル（2 GiB の音声など）をメモリへ載せずに書くための一時ファイル（#18653）。
/// `into_temporary` で fsync 済みの一時ファイルを受け取り、gate の中で `commit_temporary` する。
/// 受け取らないまま落とすと一時ファイルを消す。
pub(crate) struct AtomicFileWriter {
    file: Option<File>,
    temporary: PathBuf,
    finished: bool,
}

static ACTIVE_ATOMIC_TEMPORARIES: OnceLock<Mutex<BTreeSet<PathBuf>>> = OnceLock::new();

fn atomic_temporaries() -> &'static Mutex<BTreeSet<PathBuf>> {
    ACTIVE_ATOMIC_TEMPORARIES.get_or_init(|| Mutex::new(BTreeSet::new()))
}

fn temporary_key(path: &Path) -> PathBuf {
    path.parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
        .zip(path.file_name())
        .map(|(parent, name)| parent.join(name))
        .unwrap_or_else(|| path.to_path_buf())
}

pub(crate) fn remove_inactive_atomic_temporary(path: &Path) {
    let active = atomic_temporaries()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !active.contains(&temporary_key(path)) {
        let _ = fs::remove_file(path);
    }
}

fn discard_atomic_temporary(path: &Path) {
    let mut active = atomic_temporaries()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let key = temporary_key(path);
    let _ = fs::remove_file(path);
    active.remove(&key);
}

impl AtomicFileWriter {
    pub(crate) fn new(root: &Path, relative: &str) -> Result<Self> {
        validate_relative_path(relative)?;
        reject_symlink_parents(root, relative)?;
        let target = root.join(relative);
        let parent = target
            .parent()
            .ok_or_else(|| VaultError::InvalidPath(relative.into()))?;
        create_directories_without_symlinks(root, parent)?;
        let random = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes());
        let temporary = parent.join(format!(".vault-{random}.tmp"));
        let file = {
            // Cleanup and creation share this short lock, so a new file cannot
            // be mistaken for a crash leftover before registration completes.
            let mut active = atomic_temporaries()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            active.retain(|path| fs::symlink_metadata(path).is_ok());
            let file = fs::OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .open(&temporary)?;
            active.insert(temporary_key(&temporary));
            file
        };
        Ok(Self {
            file: Some(file),
            temporary,
            finished: false,
        })
    }

    pub(crate) fn file_mut(&mut self) -> &mut File {
        self.file.as_mut().expect("atomic writer is open")
    }

    /// fsync して閉じ、一時ファイルの path を返す（rename は呼び出し側が `commit_temporary` で行う）。
    pub(crate) fn into_temporary(mut self) -> Result<PathBuf> {
        let file = self.file.take().expect("atomic writer is open");
        file.sync_all()?;
        drop(file);
        self.finished = true;
        Ok(self.temporary.clone())
    }
}

impl Drop for AtomicFileWriter {
    fn drop(&mut self) {
        if !self.finished {
            discard_atomic_temporary(&self.temporary);
        }
    }
}

/// prepare_temporary の一時ファイルを対象へ rename する（gate の中で短く使う）。
pub(crate) fn commit_temporary(root: &Path, relative: &str, temporary: &Path) -> Result<()> {
    let mut active = atomic_temporaries()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let active_key = temporary_key(temporary);
    let result = (|| -> Result<()> {
        validate_relative_path(relative)?;
        reject_symlink_parents(root, relative)?;
        let target = root.join(relative);
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(VaultError::Symlink(relative.into()))
            }
            Ok(metadata) if metadata.is_dir() => {
                return Err(VaultError::InvalidPath(relative.into()))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        fs::rename(temporary, &target)?;
        if let Some(parent) = target.parent() {
            sync_directory(parent)?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    active.remove(&active_key);
    result
}

pub(crate) fn sync_directory(directory: &Path) -> Result<()> {
    #[cfg(test)]
    if FAIL_DIRECTORY_SYNC.with(|failure| {
        let mut failure = failure.borrow_mut();
        failure
            .as_ref()
            .is_some_and(|expected| expected == directory)
            .then(|| failure.take())
            .is_some()
    }) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            "injected directory fsync failure",
        )
        .into());
    }
    File::open(directory)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
thread_local! {
    static FAIL_DIRECTORY_SYNC: std::cell::RefCell<Option<PathBuf>> = std::cell::RefCell::new(None);
}

#[cfg(test)]
pub(crate) fn fail_next_directory_sync_at(directory: &Path) {
    FAIL_DIRECTORY_SYNC.with(|failure| *failure.borrow_mut() = Some(directory.to_path_buf()));
}

/// 写しの 1 ファイルを読む。無ければ None。symlink は拒否する。
pub(crate) fn read_file_no_follow(root: &Path, relative: &str) -> Result<Option<Vec<u8>>> {
    match open_file_no_follow(root, relative)? {
        Some(mut file) => {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            Ok(Some(bytes))
        }
        None => Ok(None),
    }
}

/// 写しの 1 ファイルを開く（大きいファイルをメモリへ載せずに送るため。#18653）。無ければ None。symlink は拒否する。
pub(crate) fn open_file_no_follow(root: &Path, relative: &str) -> Result<Option<File>> {
    validate_relative_path(relative)?;
    if fs::symlink_metadata(root).is_err() {
        return Ok(None);
    }
    reject_symlink_parents(root, relative)?;
    let target = root.join(relative);
    match fs::symlink_metadata(&target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(VaultError::Symlink(relative.to_owned()))
        }
        Ok(metadata) if !metadata.is_file() => Err(VaultError::InvalidPath(relative.to_owned())),
        Ok(_) => Ok(Some(File::open(target)?)),
    }
}

/// 写しの 1 ファイルの sha256。無ければ None。
pub(crate) fn file_sha(root: &Path, relative: &str) -> Result<Option<String>> {
    validate_relative_path(relative)?;
    reject_symlink_parents(root, relative)?;
    let target = root.join(relative);
    match fs::symlink_metadata(&target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(VaultError::Symlink(relative.to_owned()))
        }
        Ok(metadata) if !metadata.is_file() => Err(VaultError::InvalidPath(relative.to_owned())),
        Ok(_) => Ok(Some(hash_file(&target)?)),
    }
}

/// ファイルだけを消す（directory・symlink は拒否）。消したら true。
pub(crate) fn remove_file_no_follow(root: &Path, relative: &str) -> Result<bool> {
    validate_relative_path(relative)?;
    reject_symlink_parents(root, relative)?;
    let target = root.join(relative);
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(VaultError::Symlink(relative.to_owned()))
        }
        Ok(metadata) if metadata.is_file() => {
            fs::remove_file(&target)?;
            if let Some(parent) = target.parent() {
                sync_directory(parent)?;
            }
            Ok(true)
        }
        Ok(_) => Err(VaultError::InvalidPath(relative.to_owned())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn reject_symlink_parents(root: &Path, relative: &str) -> Result<()> {
    let root_metadata = fs::symlink_metadata(root)?;
    if root_metadata.file_type().is_symlink() {
        return Err(VaultError::Symlink(root.display().to_string()));
    }
    let mut current = PathBuf::from(root);
    let mut components = Path::new(relative).components().peekable();
    while let Some(Component::Normal(component)) = components.next() {
        if components.peek().is_none() {
            break;
        }
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(VaultError::Symlink(current.display().to_string()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// root から relative までの既存の要素に symlink が無いことを確かめる（対象を含む）。
pub(crate) fn reject_symlinks_along(root: &Path, relative: &str) -> Result<()> {
    reject_symlink_parents(root, relative)?;
    match fs::symlink_metadata(root.join(relative)) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(VaultError::Symlink(relative.to_owned()))
        }
        _ => Ok(()),
    }
}

pub(crate) fn create_directories_without_symlinks(root: &Path, parent: &Path) -> Result<()> {
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| VaultError::InvalidPath(parent.display().to_string()))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(VaultError::InvalidPath(parent.display().to_string()));
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(VaultError::Symlink(current.display().to_string()));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(VaultError::InvalidPath(current.display().to_string()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                match fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

/// 一時ファイル名用（一意性だけが要る）。ID には namespace::random_* を使う。
fn random_bytes() -> [u8; 16] {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes();
    let time = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_le_bytes();
    let mut hasher = Sha256::new();
    hasher.update(sequence);
    hasher.update(time);
    hasher.update(std::process::id().to_le_bytes());
    let digest = hasher.finalize();
    let mut value = [0_u8; 16];
    value.copy_from_slice(&digest[..16]);
    value
}

pub(crate) fn fallback_random_bytes() -> [u8; 16] {
    random_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn path_contract_and_nfc_are_enforced() {
        assert!(validate_relative_path("pages/一.md").is_ok());
        assert!(validate_relative_path("pages/q\u{301}.md").is_ok());
        for invalid in [
            "",
            "/a",
            "a//b",
            "../a",
            "a/../b",
            "a/./b",
            "a\\b",
            "e\u{301}.md",
            "a\nb.md",
            "tab\t.md",
        ] {
            assert!(validate_relative_path(invalid).is_err(), "{invalid}");
        }
        // KELVIN SIGN と ANGSTROM SIGN は NFC で別の字になる。
        assert!(validate_relative_path("\u{212A}.md").is_err());
        assert!(validate_relative_path("\u{212B}.md").is_err());
    }

    #[test]
    fn ignored_and_private_components_match_the_server_at_any_depth() {
        for ignored in [
            ".run.lock",
            "a/.run.lock",
            ".conflicts/x.md",
            "a/.conflicts/x.md",
            "a/.DS_Store",
            "draft.tmp",
            "a/b.tmp/c.md",
            ".page.md.tmp-123-abcd12",
            "pages/.vault-x.tmp",
            "pages/.p1.md.tmp-1-ab",
        ] {
            assert!(is_sync_ignored(ignored), "{ignored}");
        }
        assert!(!is_sync_ignored("pages/tmp.md"));
        assert!(!is_server_ignored(".page.md.tmp-1-ab"));
        for private in [
            "settings.json",
            "a/settings.json",
            "vault/x.json",
            "a/codex-home/b",
            "device.json",
        ] {
            assert!(is_private_path(private), "{private}");
        }
        assert!(!is_private_path("pages/vaulted.md"));
    }

    #[test]
    fn scan_excludes_runtime_files_and_rejects_symlink() {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join("ok.md"), "ok").unwrap();
        fs::write(temp.path().join(".run.lock"), "lock").unwrap();
        fs::create_dir(temp.path().join(".conflicts")).unwrap();
        fs::write(temp.path().join(".conflicts/a.md"), "old").unwrap();
        fs::create_dir_all(temp.path().join("pages/.conflicts")).unwrap();
        fs::write(temp.path().join("pages/.conflicts/b.md"), "old").unwrap();
        fs::write(temp.path().join("pages/.p1.md.tmp-1-ab"), "temp").unwrap();
        let state = VaultState::empty("p123");
        let scan = scan_working_copy(temp.path(), &state, "device", ScanLimits::default()).unwrap();
        assert_eq!(
            scan.files
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["ok.md"]
        );

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temp.path().join("ok.md"), temp.path().join("link.md"))
                .unwrap();
            assert!(matches!(
                scan_working_copy(temp.path(), &state, "device", ScanLimits::default()),
                Err(VaultError::Symlink(_))
            ));
        }
    }

    #[test]
    fn oversized_empty_audio_and_private_paths_are_blocked_without_failing_the_scan() {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join("ok.md"), "ok").unwrap();
        fs::write(temp.path().join("empty.md"), "").unwrap();
        fs::write(temp.path().join("silence.m4a"), "").unwrap();
        fs::write(temp.path().join("big.bin"), vec![0_u8; 32]).unwrap();
        fs::write(temp.path().join("big.md"), vec![b'a'; 16]).unwrap();
        fs::create_dir(temp.path().join("codex-home")).unwrap();
        fs::write(temp.path().join("codex-home/auth.json"), "{}").unwrap();
        fs::write(temp.path().join("settings.json"), "{}").unwrap();
        let limits = ScanLimits {
            max_blob_bytes: 20,
            max_audio_blob_bytes: 20,
            max_text_bytes: 8,
            max_files: 100,
        };
        let scan = scan_working_copy(temp.path(), &VaultState::empty("p123"), "d", limits).unwrap();
        assert_eq!(
            scan.files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["empty.md", "ok.md"]
        );
        assert_eq!(
            scan.blocked.get("silence.m4a"),
            Some(&BlockedReason::EmptyAudio)
        );
        assert_eq!(scan.blocked.get("big.bin"), Some(&BlockedReason::TooLarge));
        assert_eq!(scan.blocked.get("big.md"), Some(&BlockedReason::TooLarge));
        assert_eq!(
            scan.blocked.get("codex-home"),
            Some(&BlockedReason::PrivatePath)
        );
        assert_eq!(
            scan.blocked.get("settings.json"),
            Some(&BlockedReason::PrivatePath)
        );
    }

    #[test]
    fn profile_scope_reads_only_profile_files_and_their_versions_without_walking() {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join("about.json"), "{}").unwrap();
        fs::write(temp.path().join("execution.json"), "{}").unwrap();
        fs::create_dir_all(temp.path().join("projects/p1")).unwrap();
        fs::write(temp.path().join("projects/p1/page.md"), "x").unwrap();
        let scan = scan_target(
            temp.path(),
            &SyncScope::Profile,
            &VaultState::empty("profile"),
            "d",
            None,
            ScanLimits::default(),
        )
        .unwrap();
        assert_eq!(scan.files.len(), 2);
        assert_eq!(
            scan.files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["about.json", "execution.json"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn profile_scope_rejects_a_linked_parent_of_its_versions() {
        let temp = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let hash = "646bd422594fa181f6e2fca4e1da7504a5fe35dbfbc8cb11c0b4b47813916086";
        fs::create_dir_all(outside.path().join("files").join(hash)).unwrap();
        fs::write(
            outside.path().join("files").join(hash).join("v1.json"),
            "{}",
        )
        .unwrap();
        fs::write(temp.path().join("about.json"), "{}").unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join("versions")).unwrap();
        let error = scan_target(
            temp.path(),
            &SyncScope::Profile,
            &VaultState::empty("profile"),
            "d",
            None,
            ScanLimits::default(),
        )
        .unwrap_err();
        assert!(matches!(error, VaultError::Symlink(_)), "{error:?}");
    }

    #[test]
    fn root_scope_walks_only_its_allowlisted_subtrees() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("pages.json"), "{}").unwrap();
        fs::write(root.join("about.json"), "{}").unwrap();
        fs::write(root.join("recent.json"), "[]").unwrap();
        for dir in [
            "pages",
            "recordings/rec1/artifacts",
            "page-chats/pg1/conversations",
            "page-chats/pg1/runs",
            "assets",
            "versions/files/abc",
            "projects/p1",
            "flows",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        fs::write(root.join("pages/pg1.md"), "# memo").unwrap();
        fs::write(root.join("recordings/rec1/artifacts/s1.md"), "x").unwrap();
        // 文書ページの「AIと作る」のやり取り（API と同じ 3 種類だけ。#18770）
        fs::write(root.join("page-chats/pg1/conversations/c1.json"), "{}").unwrap();
        fs::write(root.join("page-chats/pg1/runs/t1.json"), "{}").unwrap();
        fs::write(root.join("page-chats/pg1/runs.jsonl"), "").unwrap();
        fs::write(root.join("page-chats/pg1/notes.md"), "x").unwrap();
        fs::write(root.join("assets/img1.jpeg"), "jpeg").unwrap();
        fs::create_dir_all(root.join(
            "versions/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ))
        .unwrap();
        fs::write(
            root.join("versions/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/v_1234567890123456789012.jpeg"),
            "old",
        )
        .unwrap();
        fs::write(root.join("projects/p1/project.json"), "{}").unwrap();
        fs::write(root.join("flows/index.json"), "{}").unwrap();
        let target = crate::ProjectTarget::docs_root(root);
        let scan = scan_target(
            root,
            &target.scope,
            &VaultState::empty(crate::DOCS_ROOT_PROJECT_ID),
            "d",
            None,
            ScanLimits::default(),
        )
        .unwrap();
        let paths: Vec<&str> = scan.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "assets/img1.jpeg",
                "page-chats/pg1/conversations/c1.json",
                "page-chats/pg1/runs.jsonl",
                "page-chats/pg1/runs/t1.json",
                "pages.json",
                "pages/pg1.md",
                "recordings/rec1/artifacts/s1.md",
                "versions/files/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/v_1234567890123456789012.jpeg",
            ]
        );
        assert!(target.scope.contains("recordings/rec1/artifacts/s1.md"));
        assert!(target.scope.contains("pages.json"));
        assert!(!target.scope.contains("pages"));
        assert!(!target.scope.contains("pagesx/pg1.md"));
        assert!(!target.scope.contains("about.json"));
        assert!(!target.scope.contains("projects/p1/project.json"));
        assert!(!target.scope.contains("versions/source/1.md"));
        assert!(!target.scope.contains("page-chats/pg1/notes.md"));
        assert!(target.scope.allows_version_of("assets/img1.jpeg"));
        assert!(!crate::ProjectTarget::profile(root)
            .scope
            .allows_version_of("pages/pg1.md"));
    }

    #[cfg(unix)]
    #[test]
    fn root_scope_rejects_a_linked_page_folder() {
        let temp = tempdir().unwrap();
        let outside = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join("pages")).unwrap();
        let target = crate::ProjectTarget::docs_root(temp.path());
        assert!(matches!(
            scan_target(
                temp.path(),
                &target.scope,
                &VaultState::empty(crate::DOCS_ROOT_PROJECT_ID),
                "d",
                None,
                ScanLimits::default(),
            ),
            Err(VaultError::Symlink(_))
        ));
    }

    #[test]
    #[cfg(unix)]
    fn staged_identity_rejects_same_length_edits_with_restored_mtime() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("page.md");
        fs::write(&path, b"old").unwrap();
        let before = fs::metadata(&path).unwrap();
        let source = OpenedFileSource::capture(temp.path(), "page.md")
            .unwrap()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        fs::write(&path, b"new").unwrap();
        filetime::set_file_mtime(
            &path,
            filetime::FileTime::from_last_modification_time(&before),
        )
        .unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().modified().unwrap(),
            before.modified().unwrap()
        );
        assert!(source.verify_identity().is_err());
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn dirty_files_are_rehashed_even_when_size_and_mtime_match() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("page.md");
        fs::write(&path, "new").unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let mut state = VaultState::empty("p123");
        state.base.push(ManifestFile {
            path: "page.md".into(),
            sha256: format!("{:x}", Sha256::digest(b"old")),
            bytes: 3,
            kind: FileKind::Text,
            modified_at: format_system_time(metadata.modified().unwrap()),
            writer_device_id: "old-device".into(),
            writer_device_kind: Some("phone".into()),
            retained_until: None,
            available: true,
        });
        let scan = scan_target(
            temp.path(),
            &SyncScope::All,
            &state,
            "device",
            Some("mac"),
            ScanLimits::default(),
        )
        .unwrap();
        assert_eq!(
            scan.files[0].sha256,
            format!("{:x}", Sha256::digest(b"old"))
        );
        // 照合で済んだ版は base の書き手（端末と種類）をそのまま持つ。
        assert_eq!(scan.files[0].writer_device_id, "old-device");
        assert_eq!(scan.files[0].writer_device_kind.as_deref(), Some("phone"));
        state.mark_dirty("page.md");

        let scan = scan_target(
            temp.path(),
            &SyncScope::All,
            &state,
            "device",
            Some("mac"),
            ScanLimits::default(),
        )
        .unwrap();
        assert_eq!(
            scan.files[0].sha256,
            format!("{:x}", Sha256::digest(b"new"))
        );
        assert_eq!(scan.files[0].writer_device_id, "device");
        assert_eq!(scan.files[0].writer_device_kind.as_deref(), Some("mac"));
    }

    #[test]
    fn same_instant_compares_iso_formats_at_millisecond_precision() {
        assert!(same_instant(
            "2026-10-16T09:00:00.123+09:00",
            "2026-10-16T00:00:00.123Z"
        ));
        assert!(same_instant(
            "2026-10-16T00:00:00.123456789Z",
            "2026-10-16T00:00:00.123Z"
        ));
        assert!(!same_instant(
            "2026-10-16T00:00:00.124Z",
            "2026-10-16T00:00:00.123Z"
        ));
    }

    #[test]
    fn sparse_audio_accepts_two_gib_and_rejects_the_next_byte() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("recording.aifc");
        let file = File::create(&path).unwrap();
        file.set_len(AUDIO_BLOB_MAX_BYTES).unwrap();
        drop(file);
        let metadata = fs::metadata(&path).unwrap();
        let mut state = VaultState::empty("p123");
        state.base.push(ManifestFile {
            path: "recording.aifc".into(),
            sha256: "0".repeat(64),
            bytes: AUDIO_BLOB_MAX_BYTES,
            kind: FileKind::Audio,
            modified_at: format_system_time(metadata.modified().unwrap()),
            writer_device_id: "device".into(),
            writer_device_kind: None,
            retained_until: None,
            available: true,
        });

        let scan = scan_working_copy(temp.path(), &state, "device", ScanLimits::default()).unwrap();
        assert_eq!(scan.files[0].bytes, AUDIO_BLOB_MAX_BYTES);
        assert_eq!(scan.files[0].kind, FileKind::Audio);
        assert_eq!(scan.files[0].sha256, "0".repeat(64));
        assert_eq!(FileKind::Audio.content_type("recording.aifc"), "audio/aifc");

        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(AUDIO_BLOB_MAX_BYTES + 1).unwrap();
        let scan = scan_working_copy(temp.path(), &state, "device", ScanLimits::default()).unwrap();
        assert!(scan.files.is_empty());
        assert_eq!(
            scan.blocked.get("recording.aifc"),
            Some(&BlockedReason::TooLarge)
        );
    }

    #[test]
    fn sparse_non_audio_keeps_the_one_gib_limit() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("archive.bin");
        let file = File::create(&path).unwrap();
        file.set_len(BLOB_MAX_BYTES).unwrap();
        drop(file);
        let metadata = fs::metadata(&path).unwrap();
        let mut state = VaultState::empty("p123");
        state.base.push(ManifestFile {
            path: "archive.bin".into(),
            sha256: "0".repeat(64),
            bytes: BLOB_MAX_BYTES,
            kind: FileKind::Other,
            modified_at: format_system_time(metadata.modified().unwrap()),
            writer_device_id: "device".into(),
            writer_device_kind: None,
            retained_until: None,
            available: true,
        });
        assert_eq!(
            scan_working_copy(temp.path(), &state, "device", ScanLimits::default())
                .unwrap()
                .files[0]
                .bytes,
            BLOB_MAX_BYTES
        );

        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(BLOB_MAX_BYTES + 1).unwrap();
        let scan = scan_working_copy(temp.path(), &state, "device", ScanLimits::default()).unwrap();
        assert!(scan.files.is_empty());
        assert_eq!(
            scan.blocked.get("archive.bin"),
            Some(&BlockedReason::TooLarge)
        );
    }

    #[test]
    fn abandoned_atomic_stream_removes_its_partial_file() {
        let temp = tempdir().unwrap();
        {
            let mut output = AtomicFileWriter::new(temp.path(), "recording.aifc").unwrap();
            output.file_mut().write_all(b"partial").unwrap();
        }
        assert!(!temp.path().join("recording.aifc").exists());
        assert!(fs::read_dir(temp.path()).unwrap().next().is_none());
    }

    #[test]
    fn parent_directory_fsync_failures_are_returned_after_rename_and_remove() {
        let temp = tempdir().unwrap();
        fail_next_directory_sync_at(temp.path());
        assert!(atomic_write(temp.path(), "page.md", b"body").is_err());
        assert_eq!(fs::read(temp.path().join("page.md")).unwrap(), b"body");

        fail_next_directory_sync_at(temp.path());
        assert!(remove_file_no_follow(temp.path(), "page.md").is_err());
        assert!(!temp.path().join("page.md").exists());
    }

    #[test]
    fn case_folded_path_collisions_include_directories_and_file_prefixes() {
        for paths in [
            vec!["Page.md", "page.md"],
            vec!["Straße.md", "STRASSE.md"],
            vec!["Folder/a.md", "folder/b.md"],
            vec!["page.md", "page.md/child.md"],
        ] {
            assert!(find_case_folded_path_collision(paths).is_some());
        }
        assert!(find_case_folded_path_collision(["Folder/a.md", "Folder/b.md"]).is_none());
    }
}
