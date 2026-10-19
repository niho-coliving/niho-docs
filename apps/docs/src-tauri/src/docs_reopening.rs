//! LOCAL→CLOUD の未公開 baseline。通常 vault の base/outbox を使わず、手元の全量から
//! 独立に manifest digest を計算し、server の seal が一致した後だけ公開を決める。

use crate::cloud::{project_name, targets_of_root};
use crate::docs_storage_api::{DocsStorageApi, ReopeningAttempt, ReopeningReservation, StorageApiError};
use niho_desktop_vault::{
  load_or_default_state, scan_project_target, FileKind, IdTokenProvider, ManifestFile, Namespace, NihoProvider,
  OpenedFileSource, ProjectTarget, ScanLimits, UploadMethod, VaultError, DOCS_ROOT_PROJECT_ID, FLOWS_PROJECT_ID,
  PROFILE_PROJECT_ID,
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

pub(crate) const FREE_QUOTA_BYTES: u64 = 5 * 1024 * 1024 * 1024;

#[derive(Debug)]
pub(crate) enum ReopeningError {
  Api(StorageApiError),
  Vault(VaultError),
  MissingName,
  Incomplete,
  Quota,
  Changed,
}

impl From<StorageApiError> for ReopeningError {
  fn from(error: StorageApiError) -> Self {
    Self::Api(error)
  }
}

impl From<VaultError> for ReopeningError {
  fn from(error: VaultError) -> Self {
    Self::Vault(error)
  }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReopeningPreview {
  pub project_count: usize,
  pub file_count: usize,
  pub audio_count: usize,
  pub bytes_total: u64,
  pub quota_bytes: u64,
}

struct InventoryProject {
  target: ProjectTarget,
  name: String,
  files: Vec<ManifestFile>,
}

pub(crate) struct LocalInventory {
  projects: Vec<InventoryProject>,
  pub preview: ReopeningPreview,
  fingerprint: String,
}

fn jsonl_line(hash: &mut Sha256, fields: Value) -> Result<(), ReopeningError> {
  let bytes = serde_json::to_vec(&fields).map_err(|_| ReopeningError::Incomplete)?;
  hash.update(bytes);
  hash.update(b"\n");
  Ok(())
}

fn file_kind(file: &ManifestFile) -> &'static str {
  match file.kind {
    FileKind::Text => "text",
    FileKind::Json => "json",
    FileKind::Audio => "audio",
    FileKind::Other => "other",
  }
}

impl LocalInventory {
  pub(crate) fn collect(
    root: &Path,
    app_data: &Path,
    namespace: &Namespace,
    root_id: &str,
    device_id: &str,
  ) -> Result<Self, ReopeningError> {
    Self::collect_with_quota(root, app_data, namespace, root_id, device_id, FREE_QUOTA_BYTES)
  }

  pub(crate) fn collect_with_quota(
    root: &Path,
    app_data: &Path,
    namespace: &Namespace,
    root_id: &str,
    device_id: &str,
    quota_bytes: u64,
  ) -> Result<Self, ReopeningError> {
    let mut projects = Vec::new();
    let mut unique_bytes = 0_u64;
    let mut file_count = 0;
    let mut audio_count = 0;
    let mut fingerprint = Sha256::new();
    fingerprint.update(b"niho-docs-local-inventory-v1\n");
    let mut targets = targets_of_root(root);
    targets.sort_by(|left, right| left.project_id.cmp(&right.project_id));
    for target in targets {
      let name = match target.project_id.as_str() {
        DOCS_ROOT_PROJECT_ID => "文書".to_string(),
        FLOWS_PROJECT_ID => "工程".to_string(),
        PROFILE_PROJECT_ID => "あなたについて".to_string(),
        _ => project_name(&target.working_copy).ok_or(ReopeningError::MissingName)?,
      };
      if name.trim().is_empty() || name.chars().count() > 200 {
        return Err(ReopeningError::MissingName);
      }
      let state = load_or_default_state(app_data, namespace, root_id, &target.project_id)?;
      let scanned = scan_project_target(&target, &state, device_id, ScanLimits::default())?;
      if !scanned.blocked.is_empty() {
        return Err(ReopeningError::Incomplete);
      }
      if target.project_id == PROFILE_PROJECT_ID && scanned.files.is_empty() {
        continue;
      }
      let mut seen = HashSet::new();
      for file in &scanned.files {
        file_count += 1;
        audio_count += usize::from(file.kind == FileKind::Audio);
        if seen.insert(file.sha256.clone()) {
          unique_bytes = unique_bytes.checked_add(file.bytes).ok_or(ReopeningError::Quota)?;
        }
      }
      jsonl_line(&mut fingerprint, json!(["P", target.project_id, name]))?;
      for file in &scanned.files {
        jsonl_line(
          &mut fingerprint,
          json!([
            "F",
            target.project_id,
            file.path,
            file.sha256,
            file.bytes.to_string(),
            file_kind(file),
            file.modified_at
          ]),
        )?;
      }
      projects.push(InventoryProject {
        target,
        name,
        files: scanned.files,
      });
    }
    if unique_bytes > quota_bytes {
      return Err(ReopeningError::Quota);
    }
    Ok(Self {
      preview: ReopeningPreview {
        project_count: projects.len(),
        file_count,
        audio_count,
        bytes_total: unique_bytes,
        quota_bytes,
      },
      projects,
      fingerprint: format!("{:x}", fingerprint.finalize()),
    })
  }

  pub(crate) fn same_contents_as(&self, other: &Self) -> bool {
    self.fingerprint == other.fingerprint
  }

  pub(crate) fn fingerprint(&self) -> &str {
    &self.fingerprint
  }

  pub(crate) async fn stage(
    &self,
    api: &DocsStorageApi,
    transfer: &NihoProvider,
    token: &dyn IdTokenProvider,
    attempt: &ReopeningAttempt,
  ) -> Result<String, ReopeningError> {
    let mut manifest = Sha256::new();
    manifest.update(b"niho-docs-reopening-baseline-v1\n");
    for project in &self.projects {
      let project_id = &project.target.project_id;
      api
        .stage_reopening_project(token, attempt, project_id, &project.name)
        .await?;
      let scope = if project_id == DOCS_ROOT_PROJECT_ID {
        "ROOT"
      } else {
        "FOLDER"
      };
      jsonl_line(&mut manifest, json!(["P", project_id, scope, project.name, 0, null]))?;
      for chunk in project.files.chunks(500) {
        let rows: Vec<Value> = chunk
          .iter()
          .map(|file| {
            json!({ "path": file.path, "sha256": file.sha256, "bytes": file.bytes,
              "modifiedAt": file.modified_at, "revision": 1 })
          })
          .collect();
        api.stage_reopening_files(token, attempt, project_id, &rows).await?;
      }
      for file in &project.files {
        jsonl_line(
          &mut manifest,
          json!([
            "F",
            project_id,
            file.path,
            file.sha256,
            file.bytes.to_string(),
            file_kind(file),
            file.modified_at,
            1
          ]),
        )?;
      }
      let mut blobs = BTreeMap::<String, &ManifestFile>::new();
      for file in &project.files {
        if let Some(existing) = blobs.get(&file.sha256) {
          if existing.bytes != file.bytes
            || existing.kind.content_type(&existing.path) != file.kind.content_type(&file.path)
          {
            return Err(ReopeningError::Incomplete);
          }
        } else {
          blobs.insert(file.sha256.clone(), file);
        }
      }
      for (sha256, file) in blobs {
        let reserved = api
          .reserve_reopening_blob(
            token,
            attempt,
            project_id,
            &sha256,
            file.bytes,
            file.kind.content_type(&file.path),
          )
          .await?;
        let receipt = if reserved.status == "verified" {
          receipt_from_verified_reservation(reserved)?
        } else {
          let method = match reserved.method.as_deref() {
            Some("put") => UploadMethod::Put,
            Some("resumable") => UploadMethod::Resumable,
            _ => return Err(ReopeningError::Incomplete),
          };
          let mut source = OpenedFileSource::open(&project.target.working_copy, &file.path, &file.sha256, file.bytes)?;
          let upload = transfer
            .upload_staged_blob_file(
              method,
              reserved.url.as_deref().ok_or(ReopeningError::Incomplete)?,
              &reserved.headers,
              source.file_mut()?,
              file.bytes,
            )
            .await;
          source.verify_identity()?;
          // PUT の応答が失われた場合も complete は実体の hash/generation を検証する。
          let completed = api
            .complete_reopening_blob(token, attempt, project_id, &sha256, &reserved.upload_id)
            .await;
          match (upload, completed) {
            (_, Ok(receipt)) => BlobReceipt {
              object_key: receipt.object_key,
              generation: receipt.generation,
              retained_until: receipt.retained_until,
            },
            (Err(error), Err(_)) => return Err(ReopeningError::Vault(error)),
            (Ok(()), Err(error)) => return Err(ReopeningError::Api(error)),
          }
        };
        if !receipt.object_key.starts_with(&attempt.namespace)
          || (file.kind == FileKind::Audio && receipt.retained_until.is_none())
        {
          return Err(ReopeningError::Incomplete);
        }
        jsonl_line(
          &mut manifest,
          json!([
            "B",
            project_id,
            sha256,
            file.bytes.to_string(),
            file.kind.content_type(&file.path),
            receipt.object_key,
            receipt.generation,
            receipt.retained_until
          ]),
        )?;
      }
    }
    Ok(format!("{:x}", manifest.finalize()))
  }
}

struct BlobReceipt {
  object_key: String,
  generation: String,
  retained_until: Option<String>,
}

fn receipt_from_verified_reservation(reserved: ReopeningReservation) -> Result<BlobReceipt, ReopeningError> {
  let generation = reserved.generation.ok_or(ReopeningError::Incomplete)?;
  Ok(BlobReceipt {
    object_key: reserved.object_key,
    generation,
    retained_until: reserved.retained_until,
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  #[test]
  fn manifest_jsonl_matches_api_javascript_canonical_bytes() {
    let sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    let mut hash = Sha256::new();
    hash.update(b"niho-docs-reopening-baseline-v1\n");
    jsonl_line(&mut hash, json!(["P", "docs-root", "ROOT", "文書", 0, null])).unwrap();
    jsonl_line(
      &mut hash,
      json!([
        "F",
        "docs-root",
        "pages/p.md",
        sha,
        "3",
        "text",
        "2026-10-19T00:00:00.000Z",
        1
      ]),
    )
    .unwrap();
    jsonl_line(
      &mut hash,
      json!([
        "B",
        "docs-root",
        sha,
        "3",
        "text/markdown",
        "docs-vault-reopened/v1/users/u/2/r/blobs/docs-root/sha/upload",
        "42",
        null
      ]),
    )
    .unwrap();
    assert_eq!(
      format!("{:x}", hash.finalize()),
      "b5eaa7455d1d33401bcc8aef80e27753c45eb4a944c5e76171eca41d7b6643e0"
    );
  }

  #[test]
  fn inventory_detects_local_change_before_seal() {
    let base = std::env::temp_dir().join(format!(
      "niho-reopening-inventory-{}-{}",
      std::process::id(),
      crate::process::hex(&crate::process::random_bytes::<8>().unwrap())
    ));
    let app = base.join("app");
    let root = base.join("docs");
    fs::create_dir_all(root.join("pages")).unwrap();
    fs::create_dir_all(&app).unwrap();
    fs::write(root.join("pages/page23.md"), "初めの本文").unwrap();
    let root_id = "r_AAAAAAAAAAAAAAAAAAAAAA";
    let namespace = Namespace::Local {
      root_id: root_id.into(),
    };
    let first = LocalInventory::collect(&root, &app, &namespace, root_id, "d_test").unwrap();
    assert_eq!(first.preview.project_count, 1);
    assert_eq!(first.preview.file_count, 1);
    assert_eq!(first.preview.bytes_total, "初めの本文".len() as u64);
    fs::write(root.join("pages/page23.md"), "直した本文").unwrap();
    let changed = LocalInventory::collect(&root, &app, &namespace, root_id, "d_test").unwrap();
    assert!(!first.same_contents_as(&changed));
    fs::remove_dir_all(base).unwrap();
  }
}
