export type VaultProviderKind = "local" | "niho";
export type VaultFileKind = "text" | "json" | "audio" | "other";
export type VaultProjectScope = "ROOT" | "FOLDER";

export const DOCS_ROOT_PROJECT_ID = "docs-root";
const PAGES_JSON_VERSION_NAMESPACE = "d82acfd083c8736e72b534852675307bc68bc98baf8e34c39ed57a2a191d551b";
const SAFE_ID = "[A-Za-z0-9_-]{1,64}";
const VERSION_ID = "v_[A-Za-z0-9_-]{22}";
const ROOT_PAGE = new RegExp(`^pages/${SAFE_ID}\\.md$`);
const ROOT_RECORDING = new RegExp(`^recordings/${SAFE_ID}/.+$`);
const ROOT_ASSET = new RegExp(`^assets/${SAFE_ID}\\.(?:jpg|jpeg|png|webp)$`);
// 文書ページの「AIと作る」のやり取り（会話・依頼の checkpoint・依頼の記録）
const ROOT_PAGE_CHAT = new RegExp(
  `^page-chats/${SAFE_ID}/(?:conversations/${SAFE_ID}\\.json|runs/${SAFE_ID}\\.json|runs\\.jsonl)$`,
);
const ROOT_ASSET_VERSION = new RegExp(
  `^versions/files/[a-f0-9]{64}/${VERSION_ID}\\.(?:jpg|jpeg|png|webp)$`,
);
const ROOT_MARKDOWN_VERSION = new RegExp(`^versions/files/([a-f0-9]{64})/${VERSION_ID}\\.md$`);
const ROOT_PAGES_VERSION = new RegExp(
  `^versions/files/${PAGES_JSON_VERSION_NAMESPACE}/${VERSION_ID}\\.json$`,
);

/** API の同名 helper と一致させる docs-root の narrow wire allowlist。 */
export function isDocsVaultRootPathAllowed(path: string): boolean {
  const markdownVersion = ROOT_MARKDOWN_VERSION.exec(path);
  return path === "pages.json"
    || ROOT_PAGE.test(path)
    || ROOT_RECORDING.test(path)
    || ROOT_PAGE_CHAT.test(path)
    || ROOT_ASSET.test(path)
    || ROOT_ASSET_VERSION.test(path)
    || Boolean(markdownVersion && markdownVersion[1] !== PAGES_JSON_VERSION_NAMESPACE)
    || ROOT_PAGES_VERSION.test(path);
}

/** 書いた端末の種類（Mac アプリ / PC のブラウザ / スマホ）。 */
export type VaultDeviceKind = "mac" | "browser" | "phone";

/** ローカル自動保存: 最後の入力から 250ms、最初の未保存入力から最大 1 秒で開始（C3）。 */
export const LOCAL_SAVE_IDLE_MS = 250;
export const LOCAL_SAVE_MAX_WAIT_MS = 1000;
/** 同期: 最後の保存から 1.5 秒、最初の未送信保存から最大 5 秒で開始（crate の scheduler と同じ）。 */
export const SYNC_IDLE_MS = 1500;
export const SYNC_MAX_WAIT_MS = 5000;

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

export type VaultActiveManifest = {
  schemaVersion: 1;
  projectId: string;
  name: string;
  revision: number;
  deleted: false;
  updatedAt: string;
  files: VaultFile[];
};

export type VaultTombstoneManifest = {
  deleted: true;
  revision: number;
  projectId?: string;
  schemaVersion?: 1;
};

export type VaultManifest = VaultActiveManifest | VaultTombstoneManifest;

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

/** app data `vault/<accountKey>/<projectId>/state.json`（未ログインは `vault/local/<rootId>/<projectId>/`）。 */
export type VaultState = {
  schemaVersion: 2;
  accountKey: string | null;
  rootId: string;
  projectId: string;
  baseRevision: number;
  base: VaultFile[];
  dirty: Record<string, number>;
  dirtyGeneration: number;
  localGeneration: number;
  acknowledgedGeneration: number;
  pendingMutations: string[];
  deferredRemote: Record<string, VaultFile>;
  deferredDeletes: string[];
  confirmedBlobs: string[];
  blocked: Record<string, BlockedReason>;
  quotaPaths: string[];
  expiredAudio: string[];
  conflicts: Record<string, string>;
  groups: Record<string, string[]>;
  lastSyncedAt: string | null;
  lastError: SyncErrorInfo | null;
  retryAfter: string | null;
  conflictFailures: number;
  tombstone: TombstoneInfo | null;
};

export type VaultCommitRequest = {
  /** 16 バイト乱数の base64url（22 字）。送信前に固定し、結果不明の再送でも変えない。 */
  mutationId: string;
  deviceId: string;
  /** 書いた端末の種類。省略可（種類を足す前に固定した依頼は付けずに送り直す）。 */
  deviceKind?: VaultDeviceKind;
  baseRevision: number;
  name?: string;
  upserts: { path: string; sha256: string; bytes: number; modifiedAt: string }[];
  deletes: string[];
  leaseId?: string;
};

export type VaultCommitResponse = { mutationId: string; revision: number; replayed: boolean };

export type VaultSettings = { provider: VaultProviderKind; updatedAt: string | null };

export type VaultBlobReservation =
  | { status: "exists" }
  | { status: "stored" }
  | {
      status: "upload";
      uploadId: string;
      method: "put" | "resumable";
      url: string;
      headers: Record<string, string>;
      expiresAt: string;
    };

export type VaultProjectSummary = {
  projectId: string;
  name: string;
  revision: number;
  updatedAt: string;
  bytes: number;
  lease: { deviceName: string; expiresAt: string } | null;
  deletedAt?: string | null;
};

export type VaultUsage = {
  usedBytes: number;
  reservedBytes: number;
  quotaBytes: number;
  audioBytes: number;
  projects: { projectId: string; bytes: number }[];
};

export type VaultLease = { leaseId: string; expiresAt: string };
export type VaultLeaseHeldBy = { deviceName: string; since: string; expiresAt: string };

export type ConflictKind =
  | "edit"
  | "addAdd"
  | "localDeletedRemoteEdited"
  | "remoteDeletedLocalEdited"
  | "version";
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

export type AudioTransferState =
  | "queued"
  | "uploading"
  | "uploaded"
  | "downloading"
  | "downloaded"
  | "failed";

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

export type VaultSyncStatus =
  | { status: "synced"; revision: number }
  | { status: "pending"; revision: number; paths: string[] }
  | { status: "offline" }
  | { status: "tombstoneChoiceRequired" }
  | { status: "movedDeletedProject"; path: string }
  | { status: "partial"; revision: number; quotaPaths: string[]; blockedPaths?: string[] }
  | { status: "backoff"; retryAfter: string }
  | { status: "localOnly" }
  | { status: "authRequired" }
  | { status: "purged" }
  | { status: "conflicted"; revision: number; paths: string[] }
  | { status: "failed"; error: SyncErrorInfo };

export type VaultSyncEvent =
  | { type: "syncing"; projectId: string }
  | { type: "localSaved"; projectId: string; generation: number; paths: string[] }
  | { type: "committed"; projectId: string; revision: number; paths: string[] }
  | { type: "conflict"; projectId: string; conflictId: string; path: string; kind: ConflictKind }
  | { type: "deferred"; projectId: string; path: string }
  | { type: "applied"; projectId: string; paths: string[] }
  | {
      type: "audio";
      projectId: string;
      path: string;
      state: AudioTransferState;
      message?: string;
    }
  | { type: "quota"; projectId: string; path: string }
  | { type: "offline"; projectId: string; message: string }
  | { type: "expired"; projectId: string; path: string }
  | { type: "tombstone"; projectId: string; needsChoice: boolean }
  | { type: "done"; projectId: string; status: VaultSyncStatus };

/** C3 が desktop-account.id_token() をリクエストごとに渡す境界。token を保持してはならない。 */
export type IdTokenCallback = () => Promise<string>;

export type VaultApiContract = {
  getSettings(deviceId: string): Promise<VaultSettings>;
  putSettings(deviceId: string, provider: VaultProviderKind): Promise<VaultSettings>;
  /** 省略・false の条件は query に付けない（サーバーは literal の "1" だけを受け付ける）。 */
  listProjects(options?: { reserved?: boolean; deleted?: boolean }): Promise<VaultProjectSummary[]>;
  getOrCreateProject(projectId: string, name?: string): Promise<VaultManifest>;
  getProject(projectId: string): Promise<VaultManifest>;
  reserveBlob(
    projectId: string,
    input: { sha256: string; bytes: number; contentType: string; inline?: string },
  ): Promise<VaultBlobReservation>;
  completeBlob(projectId: string, sha256: string, uploadId: string): Promise<void>;
  getBlobContent(projectId: string, sha256: string): Promise<Uint8Array>;
  getBlobUrl(projectId: string, sha256: string): Promise<{ method: "get"; url: string; expiresAt: string }>;
  commit(projectId: string, input: VaultCommitRequest): Promise<VaultCommitResponse>;
  deleteProject(projectId: string): Promise<void>;
  restoreProject(projectId: string): Promise<void>;
  acquireLease(projectId: string, input: { deviceId: string; deviceName: string; leaseId?: string }): Promise<VaultLease>;
  renewLease(projectId: string, leaseId: string): Promise<VaultLease>;
  releaseLease(projectId: string, leaseId: string): Promise<void>;
  usage(): Promise<VaultUsage>;
};
