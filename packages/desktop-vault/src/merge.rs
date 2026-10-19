use std::collections::{BTreeMap, BTreeSet};

use crate::types::{
    ConflictKind, ConflictPlan, FileKind, ManifestFile, MergePlan, Result, Transfer,
};

/// サーバーと同じ immutable version path の規則。
pub fn is_immutable_version_path(path: &str) -> bool {
    if path.starts_with("versions/") {
        return true;
    }
    let mut parts = path.splitn(4, '/');
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some("recordings"), Some(id), Some("versions"), Some(_)) if !id.is_empty()
    )
}

/// どの階層の runs.jsonl も行の和集合で併合する。
pub fn is_runs_jsonl(path: &str) -> bool {
    path == "runs.jsonl" || path.ends_with("/runs.jsonl")
}

/// `runs/**`・`conversations/**`（どの階層でも）。状態更新は通常の 3 方向、削除は伝播しない。
pub fn is_history_path(path: &str) -> bool {
    path.starts_with("runs/")
        || path.contains("/runs/")
        || path.starts_with("conversations/")
        || path.contains("/conversations/")
}

/// base／local／remote の 3 方向比較。sha256 だけを比べ、時刻・端末で勝者を決めない。
/// `protected` の path は remote の更新・削除を適用せず Defer にする。
pub fn plan_merge(
    base: &[ManifestFile],
    local: &[ManifestFile],
    remote: &[ManifestFile],
    protected: &BTreeSet<String>,
) -> MergePlan {
    let base = index(base);
    let local = index(local);
    let remote = index(remote);
    let paths: BTreeSet<&str> = base
        .keys()
        .chain(local.keys())
        .chain(remote.keys())
        .copied()
        .collect();
    let mut plan = MergePlan::default();
    for path in paths {
        let base_file = base.get(path).copied();
        let local_file = local.get(path).copied();
        let remote_file = remote.get(path).copied();
        let b = base_file.map(|file| file.sha256.as_str());
        let l = local_file.map(|file| file.sha256.as_str());
        let r = remote_file.map(|file| file.sha256.as_str());

        if is_runs_jsonl(path) && !is_immutable_version_path(path) {
            if l != r {
                plan.runs_union.push(path.to_owned());
            }
            continue;
        }

        let remote_unavailable =
            remote_file.is_some_and(|file| file.kind == FileKind::Audio && !file.available);
        if remote_unavailable {
            // 期限切れの音声は下ろさない。同じ中身が手元にあれば上げ直す。
            if l == r {
                if let Some(file) = local_file {
                    plan.transfers.push(Transfer::Upload(file.clone()));
                }
                continue;
            }
            if local_file.is_none() {
                continue;
            }
        }
        if l == r {
            continue;
        }
        let protect = protected.contains(path);
        let fetch = |plan: &mut MergePlan, file: &ManifestFile| {
            if remote_unavailable {
                return;
            }
            plan.transfers.push(if protect {
                Transfer::Defer(file.clone())
            } else {
                Transfer::Download(file.clone())
            });
        };
        let conflict = |plan: &mut MergePlan, kind: ConflictKind| {
            plan.conflicts.push(ConflictPlan {
                path: path.to_owned(),
                base: base_file.cloned(),
                local: local_file.cloned(),
                remote: remote_file.cloned(),
                kind,
            });
        };

        if is_immutable_version_path(path) {
            match (local_file, remote_file) {
                (Some(file), None) => plan.transfers.push(Transfer::Upload(file.clone())),
                (None, Some(file)) => fetch(&mut plan, file),
                (Some(_), Some(_)) => conflict(&mut plan, ConflictKind::Version),
                (None, None) => {}
            }
            continue;
        }

        let keep_deletions = is_history_path(path);
        if l != b && r == b {
            match (local_file, remote_file) {
                (Some(file), _) => plan.transfers.push(Transfer::Upload(file.clone())),
                // 履歴の削除は伝えず、remote の版で手元を戻す。
                (None, Some(file)) if keep_deletions => fetch(&mut plan, file),
                (None, _) => plan.transfers.push(Transfer::DeleteRemote(path.to_owned())),
            }
            continue;
        }
        if l == b && r != b {
            match (local_file, remote_file) {
                (_, Some(file)) => fetch(&mut plan, file),
                (Some(file), None) if keep_deletions => {
                    plan.transfers.push(Transfer::Upload(file.clone()))
                }
                (_, None) if protect => plan.transfers.push(Transfer::DeferDelete(path.to_owned())),
                (_, None) => plan.transfers.push(Transfer::DeleteLocal(path.to_owned())),
            }
            continue;
        }
        match (local_file, remote_file) {
            (Some(_), Some(_)) => conflict(
                &mut plan,
                if base_file.is_some() {
                    ConflictKind::Edit
                } else {
                    ConflictKind::AddAdd
                },
            ),
            (None, Some(file)) if keep_deletions => fetch(&mut plan, file),
            (None, Some(_)) => conflict(&mut plan, ConflictKind::LocalDeletedRemoteEdited),
            (Some(file), None) if keep_deletions => {
                plan.transfers.push(Transfer::Upload(file.clone()))
            }
            (Some(_), None) => conflict(&mut plan, ConflictKind::RemoteDeletedLocalEdited),
            (None, None) => {}
        }
    }
    plan
}

fn index(files: &[ManifestFile]) -> BTreeMap<&str, &ManifestFile> {
    files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect()
}

fn ordered_time(value: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|at| {
            at.with_timezone(&chrono::Utc)
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
        })
        .unwrap_or_else(|_| value.to_owned())
}

/// 行の文字列の和集合。`at` の日時順、同時刻は行の辞書順。
pub fn merge_runs_jsonl(local: &[u8], remote: &[u8]) -> Result<Vec<u8>> {
    let local = std::str::from_utf8(local)
        .map_err(|error| crate::types::VaultError::InvalidResponse(error.to_string()))?;
    let remote = std::str::from_utf8(remote)
        .map_err(|error| crate::types::VaultError::InvalidResponse(error.to_string()))?;
    let mut lines = BTreeSet::new();
    for line in local.lines().chain(remote.lines()) {
        if !line.is_empty() {
            lines.insert(line.to_owned());
        }
    }
    let mut lines: Vec<String> = lines.into_iter().collect();
    lines.sort_by(|left, right| {
        ordered_time(&run_at(left))
            .cmp(&ordered_time(&run_at(right)))
            .then_with(|| left.cmp(right))
    });
    if lines.is_empty() {
        return Ok(Vec::new());
    }
    Ok(format!("{}\n", lines.join("\n")).into_bytes())
}

fn run_at(line: &str) -> String {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .and_then(|value| {
            value
                .get("at")
                .and_then(|at| at.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, sha: &str, at: &str, device: &str) -> ManifestFile {
        ManifestFile {
            path: path.into(),
            sha256: sha.into(),
            bytes: 1,
            kind: FileKind::from_path(path),
            modified_at: at.into(),
            writer_device_id: device.into(),
            writer_device_kind: None,
            retained_until: None,
            available: true,
        }
    }

    fn names(plan: &MergePlan) -> Vec<&'static str> {
        plan.transfers
            .iter()
            .map(|transfer| match transfer {
                Transfer::Upload(_) => "upload",
                Transfer::Download(_) => "download",
                Transfer::DeleteRemote(_) => "delete-remote",
                Transfer::DeleteLocal(_) => "delete-local",
                Transfer::Defer(_) => "defer",
                Transfer::DeferDelete(_) => "defer-delete",
            })
            .collect()
    }

    fn kinds(plan: &MergePlan) -> Vec<ConflictKind> {
        plan.conflicts
            .iter()
            .map(|conflict| conflict.kind)
            .collect()
    }

    fn none() -> BTreeSet<String> {
        BTreeSet::new()
    }

    #[test]
    fn three_way_table_never_picks_a_winner() {
        let b = file("a.md", "b", "1", "d1");
        let l = file("a.md", "l", "2", "d1");
        let r = file("a.md", "r", "3", "d2");
        let p = none();
        assert!(plan_merge(&[b.clone()], &[b.clone()], &[b.clone()], &p)
            .transfers
            .is_empty());
        assert_eq!(
            names(&plan_merge(&[b.clone()], &[l.clone()], &[b.clone()], &p)),
            ["upload"]
        );
        assert_eq!(
            names(&plan_merge(&[b.clone()], &[b.clone()], &[r.clone()], &p)),
            ["download"]
        );
        let both = plan_merge(&[b.clone()], &[l.clone()], &[r.clone()], &p);
        assert!(both.transfers.is_empty());
        assert_eq!(kinds(&both), [ConflictKind::Edit]);
        assert_eq!(
            names(&plan_merge(&[b.clone()], &[], &[b.clone()], &p)),
            ["delete-remote"]
        );
        assert_eq!(
            names(&plan_merge(&[b.clone()], &[b.clone()], &[], &p)),
            ["delete-local"]
        );
        assert_eq!(
            kinds(&plan_merge(&[b.clone()], &[], &[r.clone()], &p)),
            [ConflictKind::LocalDeletedRemoteEdited]
        );
        assert_eq!(
            kinds(&plan_merge(&[b.clone()], &[l.clone()], &[], &p)),
            [ConflictKind::RemoteDeletedLocalEdited]
        );
        assert_eq!(
            kinds(&plan_merge(&[], &[l.clone()], &[r.clone()], &p)),
            [ConflictKind::AddAdd]
        );
        // 同じ modifiedAt・時計の逆転でも勝者を作らない。
        let same_time_local = file("a.md", "l", "same", "device-z");
        let same_time_remote = file("a.md", "r", "same", "device-a");
        let plan = plan_merge(&[b.clone()], &[same_time_local], &[same_time_remote], &p);
        assert!(plan.transfers.is_empty());
        assert_eq!(plan.conflicts.len(), 1);
    }

    #[test]
    fn protected_paths_defer_remote_updates_and_deletions() {
        let b = file("a.md", "b", "1", "d1");
        let r = file("a.md", "r", "3", "d2");
        let protected = BTreeSet::from(["a.md".to_owned()]);
        assert_eq!(
            names(&plan_merge(&[b.clone()], &[b.clone()], &[r], &protected)),
            ["defer"]
        );
        assert_eq!(
            names(&plan_merge(&[b.clone()], &[b.clone()], &[], &protected)),
            ["defer-delete"]
        );
        // 保護は push を止めない。
        let l = file("a.md", "l", "2", "d1");
        assert_eq!(
            names(&plan_merge(&[b.clone()], &[l], &[b], &protected)),
            ["upload"]
        );
    }

    #[test]
    fn versions_are_copied_across_and_same_name_differences_are_version_conflicts() {
        let p = none();
        for path in ["versions/s/1.md", "recordings/r1/versions/s/1.md"] {
            let base = file(path, "base", "same", "device-a");
            assert_eq!(
                names(&plan_merge(&[base.clone()], &[], &[base.clone()], &p)),
                ["download"]
            );
            assert_eq!(
                names(&plan_merge(&[base.clone()], &[base.clone()], &[], &p)),
                ["upload"]
            );
            let local = file(path, "aaa", "same", "device-a");
            let remote = file(path, "zzz", "same", "device-b");
            let plan = plan_merge(&[], &[local], &[remote], &p);
            assert!(plan.transfers.is_empty());
            assert_eq!(kinds(&plan), [ConflictKind::Version]);
        }
        assert!(!is_immutable_version_path("recordings/versions/x.md"));
        assert!(!is_immutable_version_path("pages/versions/x.md"));
    }

    #[test]
    fn history_deletions_are_not_propagated_in_either_direction() {
        let p = none();
        for path in ["runs/r1.json", "recordings/x/conversations/c.json"] {
            let base = file(path, "b", "1", "d1");
            assert_eq!(
                names(&plan_merge(&[base.clone()], &[], &[base.clone()], &p)),
                ["download"]
            );
            assert_eq!(
                names(&plan_merge(&[base.clone()], &[base.clone()], &[], &p)),
                ["upload"]
            );
            let changed = file(path, "c", "2", "d2");
            assert_eq!(
                names(&plan_merge(
                    &[base.clone()],
                    &[base.clone()],
                    &[changed.clone()],
                    &p
                )),
                ["download"]
            );
            assert_eq!(
                kinds(&plan_merge(
                    &[base.clone()],
                    &[changed.clone()],
                    &[file(path, "d", "3", "d3")],
                    &p
                )),
                [ConflictKind::Edit]
            );
        }
    }

    #[test]
    fn nested_runs_jsonl_is_a_union_not_a_conflict() {
        let p = none();
        for path in ["runs.jsonl", "recordings/r1/runs.jsonl"] {
            let plan = plan_merge(
                &[file(path, "b", "1", "d")],
                &[file(path, "l", "2", "d")],
                &[file(path, "r", "3", "d")],
                &p,
            );
            assert!(plan.conflicts.is_empty());
            assert!(plan.transfers.is_empty());
            assert_eq!(plan.runs_union, [path]);
        }
    }

    #[test]
    fn expired_audio_is_reuploaded_but_never_downloaded() {
        let p = none();
        let mut remote = file("in.m4a", "s", "1", "d");
        remote.available = false;
        assert_eq!(
            names(&plan_merge(
                &[remote.clone()],
                &[file("in.m4a", "s", "1", "d")],
                &[remote.clone()],
                &p
            )),
            ["upload"]
        );
        assert!(plan_merge(&[remote.clone()], &[], &[remote.clone()], &p)
            .transfers
            .is_empty());
        assert!(plan_merge(&[], &[], &[remote.clone()], &p)
            .transfers
            .is_empty());
    }

    #[test]
    fn runs_are_exact_line_union_sorted_by_at() {
        let local = br#"{"at":"2026-02-02","id":"b"}
{"at":"2026-01-01","id":"a"}
"#;
        let remote = br#"{"at":"2026-02-02","id":"b"}
{"at":"2026-03-03","id":"c"}
"#;
        assert_eq!(
            String::from_utf8(merge_runs_jsonl(local, remote).unwrap()).unwrap(),
            "{\"at\":\"2026-01-01\",\"id\":\"a\"}\n{\"at\":\"2026-02-02\",\"id\":\"b\"}\n{\"at\":\"2026-03-03\",\"id\":\"c\"}\n"
        );
    }
}
