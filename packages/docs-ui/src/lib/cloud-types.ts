/**
 * NIHO クラウドの保管庫の型（C3 #18595）。
 *
 * - 同期の状態・競合・使用量は crate の TS 契約 `packages/desktop-vault/ts/index.ts` の写し（apps/docs は
 *   `@niho/desktop-vault` に依存しないので、使う型だけを写す。crate の型を変えたらここも写す）。
 * - 保存先の状態・クラウドの案件の一覧は Tauri の `src-tauri/src/cloud.rs` の DTO（serde camelCase）と同じ形。
 */

// ---------------------------------------------------------------------------
// packages/desktop-vault/ts/index.ts の写し

export type VaultProviderKind = "local" | "niho";
export type VaultFileKind = "text" | "json" | "audio" | "other";
export type VaultProjectScope = "ROOT" | "FOLDER";
export const DOCS_ROOT_PROJECT_ID = "docs-root";
/** 書いた端末の種類（Mac アプリ / PC のブラウザ / スマホ）。 */
export type VaultDeviceKind = "mac" | "browser" | "phone";

/** ローカル自動保存: 最後の入力から 250ms、最初の未保存入力から最大 1 秒で開始。 */
export const LOCAL_SAVE_IDLE_MS = 250;
export const LOCAL_SAVE_MAX_WAIT_MS = 1000;

export type VaultFile = {
  path: string;
  sha256: string;
  bytes: number;
  kind: VaultFileKind;
  modifiedAt: string;
  writerDeviceId: string;
  /** 種類を送らない旧 client・サーバーの書き込み・以前の版では省略。 */
  writerDeviceKind?: VaultDeviceKind;
  retainedUntil?: string | null;
  available?: boolean;
};

export type BlockedReason = "tooLarge" | "emptyAudio" | "privatePath" | "immutableVersion";

export type SyncErrorKind =
  | "offline"
  | "authRequired"
  | "quota"
  | "rateLimited"
  | "server"
  | "invalid"
  | "tombstone"
  | "purged"
  | "mutationMismatch";

/** UI にそのまま出せる日本語の文言（内部のコードを含まない）。 */
export type SyncErrorInfo = { kind: SyncErrorKind; message: string };

export type TombstoneInfo = { needsChoice: boolean };

export type VaultUsage = {
  usedBytes: number;
  reservedBytes: number;
  quotaBytes: number;
  audioBytes: number;
  projects: { projectId: string; bytes: number }[];
};

export type ConflictKind = "edit" | "addAdd" | "localDeletedRemoteEdited" | "remoteDeletedLocalEdited" | "version";
export type ConflictStatus = "open" | "resolving";
export type ConflictSide = "local" | "remote";
/** `sync` は remote との競合、`recovery` は再起動時の保存の食い違い。 */
export type ConflictOrigin = "sync" | "recovery";

/** `.conflicts/index.json` の 1 件。copy と version path は working copy からの相対 path。 */
export type ConflictEntry = {
  conflictId: string;
  path: string;
  kind: ConflictKind;
  origin: ConflictOrigin;
  status: ConflictStatus;
  baseSha256: string | null;
  localSha256: string | null;
  remoteSha256: string | null;
  remoteRevision: number;
  remoteDeviceId: string | null;
  remoteModifiedAt: string | null;
  localModifiedAt: string | null;
  localVersionId: string | null;
  remoteVersionId: string | null;
  localVersionPath: string | null;
  remoteVersionPath: string | null;
  localCopy: string | null;
  remoteCopy: string | null;
  remoteAvailable: boolean;
  resolutionGeneration: number | null;
  remoteFile: VaultFile | null;
  createdAt: string;
  updatedAt: string;
};

export type ConflictSummary = {
  conflictId: string;
  path: string;
  kind: ConflictKind;
  status: ConflictStatus;
  /** クラウド側を変えた端末。 */
  remoteDeviceId: string | null;
  remoteDeviceKind: VaultDeviceKind | null;
};

/** クラウドの版を書いた端末。 */
export type RemoteWriter = { deviceId: string; deviceKind: VaultDeviceKind | null };

export type BlockedPath = { path: string; reason: BlockedReason };

export type AudioTransferState = "queued" | "uploading" | "uploaded" | "downloading" | "downloaded" | "failed";

/** `SyncEngine::project_snapshot`。通信しないで読む案件の同期状態。 */
export type ProjectSyncSnapshot = {
  projectId: string;
  revision: number;
  syncing: boolean;
  localGeneration: number;
  acknowledgedGeneration: number;
  dirty: Record<string, number>;
  pendingMutation: boolean;
  conflicts: ConflictSummary[];
  deferred: string[];
  /** deferred のうちクラウドの版を待っている path の書き手。 */
  remoteWriters: Record<string, RemoteWriter>;
  quotaPaths: string[];
  blocked: BlockedPath[];
  expiredAudio: string[];
  audio: Record<string, AudioTransferState>;
  lastSyncedAt: string | null;
  lastError: SyncErrorInfo | null;
  retryAfter: string | null;
  tombstone: TombstoneInfo | null;
};

// ---------------------------------------------------------------------------
// apps/docs/src-tauri/src/cloud.rs の DTO

/**
 * local = この Mac だけ・active = 同期している・signedOut／expired = ログインが要る・otherAccount = 保存先が別の NIHO アカウントに
 * 結び付いている・starting = 起動直後（journal の回復の前）。
 */
export type CloudStatus = "local" | "active" | "signedOut" | "expired" | "otherAccount" | "starting" | "unselected" | "closing" | "storageUnavailable";

export type DocsStorageState = {
  mode: "UNSET" | "CLOUD" | "CLOSING" | "LOCAL";
  epoch: string;
  changedAt: string | null;
  cleanupPending: boolean;
  quotaBytes: number;
  closing: { deviceName: string; expiresAt: string } | null;
};

export type ReopeningPreview = {
  projectCount: number;
  fileCount: number;
  audioCount: number;
  bytesTotal: number;
  quotaBytes: number;
};

export type ClosingPreview = {
  preflight: {
    epoch: string;
    transferBytes: string;
    folders: number;
    pages: number;
    unexpiredAudio: number;
    expiredAudio: number;
    deletedFolders: number;
    otherMacs: { name: string; lastUsedAt: string }[];
    active: { runs: number; composerTurns: number; folderExports: number };
  };
  requiredFreeBytes: number;
  availableFreeBytes: number;
};

export type PreparedClosing = {
  closingId: string;
  epoch: string;
  manifestDigest: string;
  fileCount: number;
  expiredAudioCount: number;
  deletedFolderCount: number;
};

export type ClosingProgress = { done: number; total: number };

export type CloudMigrationFailure = { projectId: string; name: string; reason: string };

/** この Mac の案件をクラウドに上げる移行の進み（bytes は案件ごとのファイルの大きさの和）。 */
export type CloudMigration = {
  running: boolean;
  cancelled: boolean;
  total: number;
  done: number;
  bytesTotal: number;
  bytesDone: number;
  failed: CloudMigrationFailure[];
};

export type CloudState = {
  /** 保存先・ログイン session・native engine をまとめた単調増加世代。古い event/reply の棄却にだけ使う。 */
  contextGeneration: number;
  /** 同じ物理 root と owner binding の間だけ安定する、本文 draft の scope。 */
  documentScopeId: string | null;
  provider: VaultProviderKind;
  status: CloudStatus;
  deviceName: string;
  /** ログイン中の表示名 */
  accountName: string | null;
  /** 別のアカウントの保存先で、前の本人の未送信が無い（「このアカウントで使う」を出せる） */
  canRebind: boolean;
  migration: CloudMigration | null;
  /** 全体の日本語の知らせ（NIHO に接続できません など） */
  message: string | null;
  storage: DocsStorageState | null;
  requiresAccount: boolean;
  reopeningPending: boolean;
};

export type RemoteLease = { deviceName: string; expiresAt: string; mine: boolean };

/** クラウドの案件（`local` はこの Mac の保存先にもある）。 */
export type RemoteProject = {
  projectId: string;
  name: string;
  revision: number;
  updatedAt: string;
  bytes: number;
  local: boolean;
  lease: RemoteLease | null;
};

/** クラウドで削除した案件（回収前）。 */
export type DeletedProject = { projectId: string; name: string; deletedAt: string | null };

/** 競合の解決の選び方（「このMacの内容を使う」「クラウドの内容を使う」「両方を編集して保存」「残す」「削除する」）。 */
export type ResolveChoice = "local" | "remote" | "merged" | "keep" | "delete";

/** 別の Mac で削除された案件の手元の変更をどうするか（クラウドに戻す／手元を退避する）。 */
export type TombstoneChoice = "restore" | "moveAside";

export type CloudProjectEvent = { contextGeneration: number; projectId: string; snapshot: ProjectSyncSnapshot };
export type CloudAppliedEvent = { contextGeneration: number; projectId: string; paths: string[] };
export type CloudRemoteEvent = { contextGeneration: number; projects: RemoteProject[] };
export type CloudProjectStatusReply = { contextGeneration: number; snapshot: ProjectSyncSnapshot | null };
export type CloudRemoteProjectsReply = { contextGeneration: number; projects: RemoteProject[] };
