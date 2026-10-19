//! サーバーの commit 規則（receipt・revision・lease・immutable version・確定済み blob）を写した偽 provider。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use async_trait::async_trait;
use niho_desktop_vault::*;
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

pub fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 呼び出しを止める関所。arm 中は started を知らせて release を待つ。
#[derive(Default)]
pub struct Gate {
    armed: AtomicBool,
    started: Notify,
    release: Notify,
}

impl Gate {
    pub fn arm(&self) {
        self.armed.store(true, Ordering::SeqCst);
    }

    pub fn disarm(&self) {
        self.armed.store(false, Ordering::SeqCst);
    }

    /// 止まっている 1 件を通し、以後は止めない。
    pub fn open(&self) {
        self.disarm();
        self.release.notify_one();
    }

    /// 止まっている 1 件だけを通す（arm のまま）。
    pub fn release_one(&self) {
        self.release.notify_one();
    }

    pub async fn started(&self) {
        self.started.notified().await;
    }

    async fn pass(&self) {
        if self.armed.load(Ordering::SeqCst) {
            self.started.notify_one();
            self.release.notified().await;
        }
    }
}

pub struct MemoryProvider {
    pub projects: Mutex<BTreeMap<String, Manifest>>,
    pub blobs: Mutex<BTreeMap<String, Vec<u8>>>,
    pub uploads: Mutex<Vec<ManifestFile>>,
    pub commits: Mutex<Vec<(String, CommitRequest)>>,
    pub call_order: Mutex<Vec<&'static str>>,
    receipts: Mutex<BTreeMap<(String, String), (String, u64)>>,
    pub offline: AtomicBool,
    pub revision_conflicts: AtomicUsize,
    pub commit_calls: AtomicUsize,
    pub get_calls: AtomicUsize,
    pub reject_commit_lease: AtomicBool,
    pub quota_paths: Mutex<BTreeSet<String>>,
    pub lease: Mutex<Option<String>>,
    pub renew_failures: AtomicUsize,
    pub lease_expires_at: Mutex<String>,
    pub commit_lease_ids: Mutex<Vec<Option<String>>>,
    /// commit を適用した後、応答だけを落とす回数。
    pub drop_commit_responses: AtomicUsize,
    /// 次の commit の直前に manifest へ path を差し込む（project, file, bytes, revision を進めるか）。
    pub inject_before_commit: Mutex<Option<(String, ManifestFile, Vec<u8>, bool)>>,
    pub upload_gate: Gate,
    pub audio_gate: Gate,
    pub download_gate: Gate,
    pub get_gate: Gate,
    pub commit_gate: Gate,
}

impl Default for MemoryProvider {
    fn default() -> Self {
        Self {
            projects: Mutex::new(BTreeMap::new()),
            blobs: Mutex::new(BTreeMap::new()),
            uploads: Mutex::new(Vec::new()),
            commits: Mutex::new(Vec::new()),
            call_order: Mutex::new(Vec::new()),
            receipts: Mutex::new(BTreeMap::new()),
            offline: AtomicBool::new(false),
            revision_conflicts: AtomicUsize::new(0),
            commit_calls: AtomicUsize::new(0),
            get_calls: AtomicUsize::new(0),
            reject_commit_lease: AtomicBool::new(false),
            quota_paths: Mutex::new(BTreeSet::new()),
            lease: Mutex::new(None),
            renew_failures: AtomicUsize::new(0),
            lease_expires_at: Mutex::new("2099-01-01T00:00:00Z".into()),
            commit_lease_ids: Mutex::new(Vec::new()),
            drop_commit_responses: AtomicUsize::new(0),
            inject_before_commit: Mutex::new(None),
            upload_gate: Gate::default(),
            audio_gate: Gate::default(),
            download_gate: Gate::default(),
            get_gate: Gate::default(),
            commit_gate: Gate::default(),
        }
    }
}

fn immutable(path: &str) -> bool {
    is_immutable_version_path(path)
}

fn canonical_body(request: &CommitRequest) -> String {
    let mut request = request.clone();
    request.mutation_id.clear();
    request
        .upserts
        .sort_by(|left, right| left.path.cmp(&right.path));
    request.deletes.sort();
    serde_json::to_string(&request).unwrap()
}

fn decrement(counter: &AtomicUsize) -> bool {
    counter
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
            value.checked_sub(1)
        })
        .is_ok()
}

impl MemoryProvider {
    pub fn new() -> Self {
        Self::default()
    }

    fn online(&self) -> Result<()> {
        if self.offline.load(Ordering::SeqCst) {
            Err(VaultError::Offline("test offline".into()))
        } else {
            Ok(())
        }
    }

    pub fn manifest(&self, project_id: &str) -> Manifest {
        self.projects
            .lock()
            .unwrap()
            .get(project_id)
            .cloned()
            .unwrap_or_else(|| Manifest::empty(project_id))
    }

    pub fn revision(&self, project_id: &str) -> u64 {
        self.manifest(project_id).revision
    }

    pub fn remote_file(&self, project_id: &str, path: &str) -> Option<ManifestFile> {
        self.manifest(project_id)
            .files
            .into_iter()
            .find(|file| file.path == path)
    }

    pub fn remote_bytes(&self, project_id: &str, path: &str) -> Option<Vec<u8>> {
        let file = self.remote_file(project_id, path)?;
        self.blobs.lock().unwrap().get(&file.sha256).cloned()
    }

    pub fn remote_paths(&self, project_id: &str) -> Vec<String> {
        self.manifest(project_id)
            .files
            .into_iter()
            .map(|file| file.path)
            .collect()
    }

    /// 別の端末が commit したことにする。
    pub fn put_remote(
        &self,
        project_id: &str,
        path: &str,
        bytes: &[u8],
        writer: &str,
    ) -> ManifestFile {
        let file = ManifestFile {
            path: path.into(),
            sha256: sha(bytes),
            bytes: bytes.len() as u64,
            kind: FileKind::from_path(path),
            modified_at: "2026-10-16T00:00:00.000Z".into(),
            writer_device_id: writer.into(),
            writer_device_kind: None,
            retained_until: None,
            available: true,
        };
        self.blobs
            .lock()
            .unwrap()
            .insert(file.sha256.clone(), bytes.to_vec());
        let mut projects = self.projects.lock().unwrap();
        let manifest = projects
            .entry(project_id.to_owned())
            .or_insert_with(|| Manifest::empty(project_id));
        manifest.files.retain(|existing| existing.path != path);
        manifest.files.push(file.clone());
        manifest
            .files
            .sort_by(|left, right| left.path.cmp(&right.path));
        manifest.revision += 1;
        file
    }

    pub fn delete_remote(&self, project_id: &str, path: &str) {
        let mut projects = self.projects.lock().unwrap();
        let manifest = projects.get_mut(project_id).unwrap();
        manifest.files.retain(|existing| existing.path != path);
        manifest.revision += 1;
    }

    pub fn committed_paths(&self) -> Vec<Vec<String>> {
        self.commits
            .lock()
            .unwrap()
            .iter()
            .map(|(_, request)| {
                request
                    .upserts
                    .iter()
                    .map(|upsert| upsert.path.clone())
                    .chain(request.deletes.iter().cloned())
                    .collect()
            })
            .collect()
    }
}

#[async_trait]
impl VaultProvider for MemoryProvider {
    async fn get_settings(&self, _device_id: &str) -> Result<ProviderSettings> {
        Ok(ProviderSettings {
            provider: ProviderKind::Niho,
            updated_at: None,
        })
    }

    async fn put_settings(
        &self,
        _device_id: &str,
        provider: ProviderKind,
    ) -> Result<ProviderSettings> {
        Ok(ProviderSettings {
            provider,
            updated_at: Some("2026-10-16T00:00:00.000Z".into()),
        })
    }

    async fn list_projects(&self, _reserved: bool, _deleted: bool) -> Result<Vec<ProjectSummary>> {
        Ok(Vec::new())
    }

    async fn get_or_create_project(
        &self,
        project_id: &str,
        _name: Option<&str>,
    ) -> Result<Manifest> {
        self.call_order.lock().unwrap().push("manifest");
        self.get_calls.fetch_add(1, Ordering::SeqCst);
        self.online()?;
        self.get_gate.pass().await;
        self.online()?;
        let mut projects = self.projects.lock().unwrap();
        Ok(projects
            .entry(project_id.to_owned())
            .or_insert_with(|| Manifest::empty(project_id))
            .clone())
    }

    async fn get_project(&self, project_id: &str) -> Result<Manifest> {
        self.online()?;
        Ok(self.manifest(project_id))
    }

    async fn upload_blob(
        &self,
        _project_id: &str,
        file: &ManifestFile,
        bytes: Vec<u8>,
    ) -> Result<()> {
        self.call_order.lock().unwrap().push("blob");
        self.online()?;
        self.uploads.lock().unwrap().push(file.clone());
        if file.kind == FileKind::Audio {
            self.audio_gate.pass().await;
        } else {
            self.upload_gate.pass().await;
        }
        self.online()?;
        if file.kind == FileKind::Audio && bytes.is_empty() {
            return Err(VaultError::Api {
                status: 400,
                code: "BAD_REQUEST".into(),
                message: "empty audio".into(),
            });
        }
        if self.quota_paths.lock().unwrap().contains(&file.path) {
            return Err(VaultError::QuotaExceeded {
                path: file.path.clone(),
            });
        }
        assert_eq!(
            sha(&bytes),
            file.sha256,
            "uploaded bytes match the declared sha"
        );
        self.blobs
            .lock()
            .unwrap()
            .insert(file.sha256.clone(), bytes);
        Ok(())
    }

    async fn download_blob(
        &self,
        _project_id: &str,
        file: &ManifestFile,
    ) -> Result<Option<Vec<u8>>> {
        self.online()?;
        self.download_gate.pass().await;
        if file.kind == FileKind::Audio && !file.available {
            return Ok(None);
        }
        Ok(self.blobs.lock().unwrap().get(&file.sha256).cloned())
    }

    async fn commit(&self, project_id: &str, request: &CommitRequest) -> Result<CommitResponse> {
        self.online()?;
        self.commit_calls.fetch_add(1, Ordering::SeqCst);
        self.commits
            .lock()
            .unwrap()
            .push((project_id.to_owned(), request.clone()));
        self.commit_lease_ids
            .lock()
            .unwrap()
            .push(request.lease_id.clone());
        self.commit_gate.pass().await;
        if let Some((project, file, bytes, bump)) = self.inject_before_commit.lock().unwrap().take()
        {
            self.blobs
                .lock()
                .unwrap()
                .insert(file.sha256.clone(), bytes);
            let mut projects = self.projects.lock().unwrap();
            let manifest = projects
                .entry(project.clone())
                .or_insert_with(|| Manifest::empty(&project));
            manifest.files.retain(|existing| existing.path != file.path);
            manifest.files.push(file);
            manifest
                .files
                .sort_by(|left, right| left.path.cmp(&right.path));
            if bump {
                manifest.revision += 1;
            }
        }
        let body = canonical_body(request);
        let key = (project_id.to_owned(), request.mutation_id.clone());
        if let Some((stored, revision)) = self.receipts.lock().unwrap().get(&key).cloned() {
            if stored != body {
                return Err(VaultError::MutationMismatch);
            }
            return Ok(CommitResponse {
                mutation_id: request.mutation_id.clone(),
                revision,
                replayed: true,
            });
        }
        if request.lease_id.is_some() && self.reject_commit_lease.swap(false, Ordering::SeqCst) {
            return Err(VaultError::LeaseHeld { held_by: None });
        }
        if decrement(&self.revision_conflicts) {
            return Err(VaultError::RevisionConflict);
        }
        let revision = {
            let mut projects = self.projects.lock().unwrap();
            let manifest = projects
                .entry(project_id.to_owned())
                .or_insert_with(|| Manifest::empty(project_id));
            if manifest.deleted {
                return Err(VaultError::ProjectDeleted);
            }
            if manifest.revision != request.base_revision {
                return Err(VaultError::RevisionConflict);
            }
            for path in &request.deletes {
                if immutable(path) && manifest.files.iter().any(|file| &file.path == path) {
                    return Err(VaultError::ImmutableVersion { path: path.clone() });
                }
            }
            let blobs = self.blobs.lock().unwrap();
            for upsert in &request.upserts {
                if let Some(existing) = manifest.files.iter().find(|file| file.path == upsert.path)
                {
                    if immutable(&upsert.path) && existing.sha256 != upsert.sha256 {
                        return Err(VaultError::ImmutableVersion {
                            path: upsert.path.clone(),
                        });
                    }
                }
                if blobs.get(&upsert.sha256).map(|bytes| bytes.len() as u64) != Some(upsert.bytes) {
                    return Err(VaultError::BlobMissing);
                }
            }
            drop(blobs);
            manifest
                .files
                .retain(|file| !request.deletes.contains(&file.path));
            for upsert in &request.upserts {
                manifest.files.retain(|file| file.path != upsert.path);
                let kind = FileKind::from_path(&upsert.path);
                manifest.files.push(ManifestFile {
                    path: upsert.path.clone(),
                    sha256: upsert.sha256.clone(),
                    bytes: upsert.bytes,
                    kind,
                    modified_at: upsert.modified_at.clone(),
                    writer_device_id: request.device_id.clone(),
                    writer_device_kind: request.device_kind.clone(),
                    retained_until: (kind == FileKind::Audio)
                        .then(|| "2099-01-01T00:00:00Z".into()),
                    available: true,
                });
            }
            manifest
                .files
                .sort_by(|left, right| left.path.cmp(&right.path));
            manifest.revision += 1;
            manifest.revision
        };
        self.receipts.lock().unwrap().insert(key, (body, revision));
        if decrement(&self.drop_commit_responses) {
            return Err(VaultError::Offline("response lost".into()));
        }
        Ok(CommitResponse {
            mutation_id: request.mutation_id.clone(),
            revision,
            replayed: false,
        })
    }

    async fn delete_project(&self, project_id: &str) -> Result<()> {
        let mut projects = self.projects.lock().unwrap();
        let manifest = projects
            .entry(project_id.to_owned())
            .or_insert_with(|| Manifest::empty(project_id));
        manifest.deleted = true;
        manifest.revision += 1;
        Ok(())
    }

    async fn restore_project(&self, project_id: &str) -> Result<()> {
        let mut projects = self.projects.lock().unwrap();
        let manifest = projects.get_mut(project_id).unwrap();
        manifest.deleted = false;
        manifest.revision += 1;
        Ok(())
    }

    async fn acquire_lease(
        &self,
        _project_id: &str,
        _device_id: &str,
        _device_name: &str,
        lease_id: Option<&str>,
    ) -> Result<Lease> {
        let mut held = self.lease.lock().unwrap();
        if held.is_some() && held.as_deref() != lease_id {
            return Err(VaultError::LeaseHeld { held_by: None });
        }
        let id = lease_id.unwrap_or("lease-1").to_owned();
        *held = Some(id.clone());
        Ok(Lease {
            lease_id: id,
            expires_at: self.lease_expires_at.lock().unwrap().clone(),
        })
    }

    async fn renew_lease(&self, _project_id: &str, lease_id: &str) -> Result<Lease> {
        if decrement(&self.renew_failures) {
            return Err(VaultError::Offline("heartbeat".into()));
        }
        Ok(Lease {
            lease_id: lease_id.into(),
            expires_at: self.lease_expires_at.lock().unwrap().clone(),
        })
    }

    async fn release_lease(&self, _project_id: &str, lease_id: &str) -> Result<()> {
        let mut held = self.lease.lock().unwrap();
        if held.as_deref() == Some(lease_id) {
            *held = None;
        }
        Ok(())
    }

    async fn usage(&self) -> Result<Usage> {
        Ok(Usage {
            used_bytes: 0,
            reserved_bytes: 0,
            quota_bytes: 5 << 30,
            audio_bytes: 0,
            projects: vec![],
        })
    }
}
