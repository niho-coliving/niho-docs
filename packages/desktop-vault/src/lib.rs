//! NIHO docs の working copy とクラウド保管庫を同期する、Tauri 非依存の中核。

mod audio;
mod conflicts;
mod engine;
mod gate;
mod journal;
mod lease;
mod merge;
mod namespace;
mod outbox;
mod protect;
mod provider;
mod scanner;
mod scheduler;
mod state;
mod types;

pub use conflicts::{new_version_id, version_path_for};
pub use engine::{FlightOptions, SyncEngine};
pub use journal::{
    CapturedTextSnapshot, LocalSaveReceipt, LocalSaver, PreparedStreamSave, RecoveryReport,
    SaveGroup, SaveKind, SaveWrite,
};
pub use lease::LeaseSession;
pub use merge::{
    is_history_path, is_immutable_version_path, is_runs_jsonl, merge_runs_jsonl, plan_merge,
};
pub use namespace::{
    account_key, archive_account_root, bind_root, lookup_root, namespace_has_pending, root_binding,
    Namespace, RootBinding,
};
pub use protect::EditProtection;
pub use provider::{IdTokenProvider, LocalProvider, NihoEnvironment, NihoProvider, VaultProvider};
pub use scanner::{
    atomic_write, is_private_path, is_sync_ignored, scan_project_target, scan_working_copy,
    validate_relative_path, OpenedFileSource, ScanLimits, BLOB_MAX_BYTES, FILE_MAX_COUNT,
    TEXT_MAX_BYTES,
};
pub use scheduler::{SyncReason, SYNC_IDLE, SYNC_MAX_WAIT};
pub use state::{load_or_create_device, load_or_default_state, save_state, validate_project_id};
pub use types::*;
