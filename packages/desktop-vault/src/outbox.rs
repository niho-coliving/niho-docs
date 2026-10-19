//! 永続 outbox（spec §7.4.6・§12.3）。送る前に mutationId と payload を固定し、結果が分かるまで同じものを再送する。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::state::ProjectPaths;
use crate::types::{CommitRequest, CommitUpsert, Result, VaultError};

const ENTRY_LIMIT: usize = 2_000;
const BODY_LIMIT: usize = 1024 * 1024;
const FROZEN_BODY_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OutboxStatus {
    Prepared,
    Sent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrozenCommitBody {
    /// Serializer/wire contract version. Unknown versions are never reserialized or sent.
    #[serde(default)]
    version: u8,
    /// SHA-256 of the exact UTF-8 bytes, checked before every dispatch.
    #[serde(default)]
    sha256: String,
    /// Exact HTTP body. A String makes valid UTF-8 part of the persisted contract.
    #[serde(default)]
    utf8: String,
}

impl FrozenCommitBody {
    fn new(request: &CommitRequest) -> Result<Self> {
        let bytes = serde_json::to_vec(request)?;
        let utf8 = String::from_utf8(bytes).map_err(|_| {
            VaultError::InvalidResponse("serialized commit body was not UTF-8".into())
        })?;
        Ok(Self {
            version: FROZEN_BODY_VERSION,
            sha256: format!("{:x}", Sha256::digest(utf8.as_bytes())),
            utf8,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutboxEntry {
    pub(crate) mutation_id: String,
    pub(crate) created_at: String,
    pub(crate) request: CommitRequest,
    /// New entries always have this. `None` is a legacy entry (written before the exact body was frozen);
    /// `load` upgrades it once from its typed request (`upgrade_legacy`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    frozen_body: Option<FrozenCommitBody>,
    /// path ごとの送った世代。ack で同じ世代の dirty だけを消す。
    pub(crate) generations: BTreeMap<String, u64>,
    /// 送る本文の snapshot（確定まで回収しない）。
    pub(crate) snapshot_refs: Vec<String>,
    pub(crate) status: OutboxStatus,
}

impl OutboxEntry {
    pub(crate) fn new(
        mutation_id: String,
        created_at: String,
        request: CommitRequest,
        generations: BTreeMap<String, u64>,
        snapshot_refs: Vec<String>,
    ) -> Result<Self> {
        if mutation_id != request.mutation_id {
            return Err(VaultError::InvalidResponse(
                "outbox mutationId does not match commit request".into(),
            ));
        }
        let frozen_body = Some(FrozenCommitBody::new(&request)?);
        Ok(Self {
            mutation_id,
            created_at,
            request,
            frozen_body,
            generations,
            snapshot_refs,
            status: OutboxStatus::Prepared,
        })
    }

    pub(crate) fn frozen_body(&self) -> Result<&[u8]> {
        let recovery = |reason: &str| VaultError::OutboxRecoveryRequired {
            mutation_id: self.mutation_id.clone(),
            reason: reason.to_owned(),
        };
        let frozen = self
            .frozen_body
            .as_ref()
            .ok_or_else(|| recovery("exact request body is missing"))?;
        if frozen.version != FROZEN_BODY_VERSION {
            return Err(recovery("unsupported frozen body version"));
        }
        if format!("{:x}", Sha256::digest(frozen.utf8.as_bytes())) != frozen.sha256 {
            return Err(recovery("frozen body checksum mismatch"));
        }
        let parsed: CommitRequest = serde_json::from_slice(frozen.utf8.as_bytes())
            .map_err(|_| recovery("frozen body is not a valid commit request"))?;
        if &parsed != &self.request
            || parsed.mutation_id != self.mutation_id
            || self.request.mutation_id != self.mutation_id
        {
            return Err(recovery("typed request and frozen body diverge"));
        }
        if self.request.base_revision.checked_add(1).is_none() {
            return Err(recovery("base revision cannot produce a receipt revision"));
        }
        Ok(frozen.utf8.as_bytes())
    }

    pub(crate) fn paths(&self) -> impl Iterator<Item = &str> {
        self.request
            .upserts
            .iter()
            .map(|upsert| upsert.path.as_str())
            .chain(self.request.deletes.iter().map(String::as_str))
    }
}

pub(crate) fn entry_child(mutation_id: &str) -> String {
    format!("outbox/{mutation_id}.json")
}

pub(crate) fn load(paths: &ProjectPaths, mutation_id: &str) -> Result<Option<OutboxEntry>> {
    paths
        .read_json::<OutboxEntry>(&entry_child(mutation_id))?
        .map(|entry| upgrade_legacy(paths, entry))
        .transpose()
}

/// 旧版（本文を固定する前）の outbox は `frozenBody` を持たない。旧版は再送のたびに同じ型付きの request を serialize して
/// 送っていたので、その request から本文を固定して書き直す（送り直しは旧版の再送と同じ。API は mutationId を本文の正規形の
/// hash で照合するので、同じ request なら受付済みの結果を返し、違えば MUTATION_MISMATCH で止まる）。固定しないと、更新の
/// 時点で送信待ちが残っていた案件の同期が二度と再開できない。request と mutationId が食い違う entry は直さない
/// （`frozen_body` が fail-closed で止める）。
fn upgrade_legacy(paths: &ProjectPaths, mut entry: OutboxEntry) -> Result<OutboxEntry> {
    if entry.frozen_body.is_some() || entry.request.mutation_id != entry.mutation_id {
        return Ok(entry);
    }
    entry.frozen_body = Some(FrozenCommitBody::new(&entry.request)?);
    store(paths, &entry)?;
    Ok(entry)
}

pub(crate) fn store(paths: &ProjectPaths, entry: &OutboxEntry) -> Result<()> {
    paths.write_json(&entry_child(&entry.mutation_id), entry)
}

pub(crate) fn remove(paths: &ProjectPaths, mutation_id: &str) -> Result<()> {
    paths.remove(&entry_child(mutation_id))
}

pub(crate) fn all_snapshot_refs(paths: &ProjectPaths) -> Result<BTreeSet<String>> {
    let mut refs = BTreeSet::new();
    // A pending request may be the only reference to an older body. Never collect
    // recovery snapshots if its record is missing or unreadable.
    let mut missing: BTreeSet<String> = paths.read_state()?.pending_mutations.into_iter().collect();
    for name in paths.list("outbox")? {
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        let recovery = || VaultError::OutboxRecoveryRequired {
            mutation_id: id.to_owned(),
            reason: "outbox cannot be read; recovery snapshots were retained".into(),
        };
        let entry = paths
            .read_json::<OutboxEntry>(&format!("outbox/{name}"))
            .map_err(|_| recovery())?
            .ok_or_else(recovery)?;
        if entry.mutation_id != id {
            return Err(recovery());
        }
        let entry = upgrade_legacy(paths, entry)?;
        entry.frozen_body()?;
        missing.remove(&entry.mutation_id);
        refs.extend(entry.snapshot_refs);
    }
    if let Some(id) = missing.into_iter().next() {
        return Err(VaultError::OutboxRecoveryRequired {
            mutation_id: id,
            reason: "referenced outbox file is missing; recovery snapshots were retained".into(),
        });
    }
    Ok(refs)
}

#[derive(Clone, Debug)]
pub(crate) enum CommitOp {
    Upsert(CommitUpsert),
    Delete,
}

/// commit に入れる 1 path と、その送った世代。
#[derive(Clone, Debug)]
pub(crate) struct CommitItem {
    pub(crate) path: String,
    pub(crate) generation: u64,
    pub(crate) op: CommitOp,
}

pub(crate) type Batches = Vec<Vec<CommitItem>>;

/// 依存 group を途中で切らずに、件数と serialize 後の bytes の上限で batch に詰める。
/// 単独で上限を超える group は返り値の 2 つ目に入れる（送らない）。
pub(crate) fn pack_batches(
    groups: Batches,
    template: &CommitRequest,
) -> Result<(Batches, Batches)> {
    let mut empty = template.clone();
    empty.upserts.clear();
    empty.deletes.clear();
    empty.base_revision = u64::MAX;
    if empty.mutation_id.len() < 22 {
        empty.mutation_id = "x".repeat(22);
    }
    let overhead = serde_json::to_vec(&empty)?.len();
    let mut sized = Vec::with_capacity(groups.len());
    for group in groups {
        let mut upsert_bytes = 0;
        let mut upserts = 0;
        let mut delete_bytes = 0;
        let mut deletes = 0;
        for item in &group {
            match &item.op {
                CommitOp::Upsert(upsert) => {
                    upsert_bytes += serde_json::to_vec(upsert)?.len();
                    upserts += 1;
                }
                CommitOp::Delete => {
                    delete_bytes += serde_json::to_vec(&item.path)?.len();
                    deletes += 1;
                }
            }
        }
        sized.push((group, upserts, upsert_bytes, deletes, delete_bytes));
    }
    let body = |upserts: usize, upsert_bytes: usize, deletes: usize, delete_bytes: usize| {
        overhead
            + upsert_bytes
            + upserts.saturating_sub(1)
            + delete_bytes
            + deletes.saturating_sub(1)
    };
    let mut batches = Vec::new();
    let mut oversized = Vec::new();
    let mut current: Vec<CommitItem> = Vec::new();
    let (mut upserts, mut upsert_bytes, mut deletes, mut delete_bytes) = (0, 0, 0, 0);
    for (group, group_upserts, group_upsert_bytes, group_deletes, group_delete_bytes) in sized {
        if group_upserts + group_deletes > ENTRY_LIMIT
            || body(
                group_upserts,
                group_upsert_bytes,
                group_deletes,
                group_delete_bytes,
            ) > BODY_LIMIT
        {
            oversized.push(group);
            continue;
        }
        let fits = upserts + deletes + group_upserts + group_deletes <= ENTRY_LIMIT
            && body(
                upserts + group_upserts,
                upsert_bytes + group_upsert_bytes,
                deletes + group_deletes,
                delete_bytes + group_delete_bytes,
            ) <= BODY_LIMIT;
        if !fits && !current.is_empty() {
            batches.push(std::mem::take(&mut current));
            upserts = 0;
            upsert_bytes = 0;
            deletes = 0;
            delete_bytes = 0;
        }
        upserts += group_upserts;
        upsert_bytes += group_upsert_bytes;
        deletes += group_deletes;
        delete_bytes += group_delete_bytes;
        current.extend(group);
    }
    if !current.is_empty() {
        batches.push(current);
    }
    Ok((batches, oversized))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn template() -> CommitRequest {
        CommitRequest {
            mutation_id: "m".repeat(22),
            device_id: "device".into(),
            device_kind: None,
            base_revision: 1,
            name: Some("案件".into()),
            upserts: vec![],
            deletes: vec![],
            lease_id: None,
        }
    }

    fn upsert(index: usize) -> CommitItem {
        CommitItem {
            path: format!("pages/{index}.md"),
            generation: 1,
            op: CommitOp::Upsert(CommitUpsert {
                path: format!("pages/{index}.md"),
                sha256: "a".repeat(64),
                bytes: 1,
                modified_at: "2026-10-16T00:00:00.000Z".into(),
            }),
        }
    }

    #[test]
    fn batches_respect_entry_and_body_limits_and_keep_groups_whole() {
        let mut groups: Vec<Vec<CommitItem>> =
            (0..2_001).map(|index| vec![upsert(index)]).collect();
        groups.push(vec![upsert(5_000), upsert(5_001), upsert(5_002)]);
        let (batches, oversized) = pack_batches(groups, &template()).unwrap();
        assert!(oversized.is_empty());
        assert_eq!(batches.len(), 2);
        for batch in &batches {
            assert!(batch.len() <= 2_000);
            let request = CommitRequest {
                base_revision: u64::MAX,
                upserts: batch
                    .iter()
                    .filter_map(|item| match &item.op {
                        CommitOp::Upsert(upsert) => Some(upsert.clone()),
                        CommitOp::Delete => None,
                    })
                    .collect(),
                ..template()
            };
            assert!(serde_json::to_vec(&request).unwrap().len() <= 1024 * 1024);
        }
        let last = batches.last().unwrap();
        assert!(last.iter().any(|item| item.path == "pages/5000.md"));
        assert!(last.iter().any(|item| item.path == "pages/5002.md"));
    }

    #[test]
    fn body_estimate_is_exact_for_mixed_batches() {
        let items = vec![
            upsert(1),
            upsert(2),
            CommitItem {
                path: "gone.md".into(),
                generation: 1,
                op: CommitOp::Delete,
            },
        ];
        let (batches, _) = pack_batches(vec![items], &template()).unwrap();
        assert_eq!(batches.len(), 1);
        let huge: Vec<CommitItem> = (0..2_001).map(upsert).collect();
        let (batches, oversized) = pack_batches(vec![huge], &template()).unwrap();
        assert!(batches.is_empty());
        assert_eq!(oversized.len(), 1);
    }

    #[test]
    fn entries_fixed_before_device_kind_resend_the_same_body() {
        // 端末の種類を足す前に固定した依頼は、種類を補わずに同じ本文で送り直す（補うとサーバーの受付控えと食い違う）。
        let legacy = r#"{"mutationId":"mmmmmmmmmmmmmmmmmmmmmm","createdAt":"2026-10-16T00:00:00.000Z","request":{"mutationId":"mmmmmmmmmmmmmmmmmmmmmm","deviceId":"d_mac","baseRevision":1,"upserts":[],"deletes":["a.md"]},"generations":{"a.md":1},"snapshotRefs":[],"status":"sent"}"#;
        let entry: OutboxEntry = serde_json::from_str(legacy).unwrap();
        assert_eq!(entry.request.device_kind, None);
        assert_eq!(serde_json::to_string(&entry).unwrap(), legacy);
        assert_eq!(
            serde_json::to_string(&entry.request).unwrap(),
            r#"{"mutationId":"mmmmmmmmmmmmmmmmmmmmmm","deviceId":"d_mac","baseRevision":1,"upserts":[],"deletes":["a.md"]}"#
        );

        let request = CommitRequest {
            device_kind: Some("mac".into()),
            ..template()
        };
        let body = serde_json::to_value(&request).unwrap();
        assert_eq!(body["deviceKind"], "mac");
        let restored: CommitRequest = serde_json::from_value(body).unwrap();
        assert_eq!(restored, request);
    }
}
