use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;

/// 編集中の path の登録。アプリが持ち、engine を作り直しても残る。
/// 登録中の path には remote の更新・削除を適用しない（staging に取り置く）。
#[derive(Default)]
pub struct EditProtection {
    inner: Mutex<ProtectionInner>,
}

#[derive(Default)]
struct ProtectionInner {
    next_id: u64,
    counts: HashMap<String, BTreeMap<String, usize>>,
    handles: HashMap<u64, (String, Vec<String>)>,
}

impl EditProtection {
    pub fn new() -> Self {
        Self::default()
    }

    /// 編集を始めた path を登録し、解除用の id を返す。同じ path の重ね掛けは数える。
    pub fn protect(&self, project_id: &str, paths: Vec<String>) -> u64 {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.next_id = inner.next_id.saturating_add(1);
        let id = inner.next_id;
        let counts = inner.counts.entry(project_id.to_owned()).or_default();
        for path in &paths {
            *counts.entry(path.clone()).or_insert(0) += 1;
        }
        inner.handles.insert(id, (project_id.to_owned(), paths));
        id
    }

    /// 登録を外す。外した案件と path を返す（その後 `schedule(target, SyncReason::Now)` を呼ぶ）。
    pub fn release(&self, id: u64) -> Option<(String, Vec<String>)> {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (project_id, paths) = inner.handles.remove(&id)?;
        if let Some(counts) = inner.counts.get_mut(&project_id) {
            for path in &paths {
                if let Some(count) = counts.get_mut(path) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        counts.remove(path);
                    }
                }
            }
            if counts.is_empty() {
                inner.counts.remove(&project_id);
            }
        }
        Some((project_id, paths))
    }

    pub fn paths(&self, project_id: &str) -> BTreeSet<String> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .counts
            .get(project_id)
            .map(|counts| counts.keys().cloned().collect())
            .unwrap_or_default()
    }

    pub fn is_protected(&self, project_id: &str, path: &str) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .counts
            .get(project_id)
            .is_some_and(|counts| counts.contains_key(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlapping_protections_are_counted() {
        let protection = EditProtection::default();
        let first = protection.protect("p1", vec!["a.md".into(), "b.md".into()]);
        let second = protection.protect("p1", vec!["a.md".into()]);
        assert_eq!(protection.paths("p1").len(), 2);
        assert_eq!(
            protection.release(first),
            Some(("p1".to_owned(), vec!["a.md".to_owned(), "b.md".to_owned()]))
        );
        assert!(protection.is_protected("p1", "a.md"));
        assert!(!protection.is_protected("p1", "b.md"));
        protection.release(second);
        assert!(protection.paths("p1").is_empty());
        assert_eq!(protection.release(second), None);
    }
}
