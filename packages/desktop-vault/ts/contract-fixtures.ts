import raw from "./contract-fixtures.json" with { type: "json" };
import { isDocsVaultRootPathAllowed } from "./index.js";

import type {
  AudioTransferState,
  BlockedReason,
  ConflictKind,
  ConflictStatus,
  ProjectSyncSnapshot,
  SyncErrorInfo,
  SyncErrorKind,
  VaultDeviceKind,
  VaultSyncEvent,
  VaultSyncStatus,
} from "./index.js";

const conflictKinds: readonly ConflictKind[] = [
  "edit",
  "addAdd",
  "localDeletedRemoteEdited",
  "remoteDeletedLocalEdited",
  "version",
];
const conflictStatuses: readonly ConflictStatus[] = ["open", "resolving"];
const audioStates: readonly AudioTransferState[] = [
  "queued",
  "uploading",
  "uploaded",
  "downloading",
  "downloaded",
  "failed",
];
const deviceKinds: readonly VaultDeviceKind[] = ["mac", "browser", "phone"];
const blockedReasons: readonly BlockedReason[] = ["tooLarge", "emptyAudio", "privatePath", "immutableVersion"];
const errorKinds: readonly SyncErrorKind[] = [
  "offline",
  "authRequired",
  "quota",
  "rateLimited",
  "server",
  "invalid",
  "tombstone",
  "purged",
  "mutationMismatch",
];

function need<T>(value: T | null | undefined, field: string): T {
  if (value === undefined || value === null) {
    throw new Error(`fixture field missing: ${field}`);
  }
  return value;
}

function oneOf<T extends string>(values: readonly T[], value: string | null | undefined, field: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) {
    throw new Error(`fixture value invalid: ${field}`);
  }
  return found;
}

function errorInfo(value: { kind: string; message: string } | null | undefined, field: string): SyncErrorInfo {
  const info = need(value, field);
  return { kind: oneOf(errorKinds, info.kind, `${field}.kind`), message: info.message };
}

type RawStatus = (typeof raw.events)[number]["status"];

function status(value: RawStatus): VaultSyncStatus {
  const input = need(value, "status");
  switch (input.status) {
    case "synced":
      return { status: "synced", revision: need(input.revision, "revision") };
    case "pending":
      return { status: "pending", revision: need(input.revision, "revision"), paths: need(input.paths, "paths") };
    case "conflicted":
      return { status: "conflicted", revision: need(input.revision, "revision"), paths: need(input.paths, "paths") };
    case "failed":
      return { status: "failed", error: errorInfo(input.error, "error") };
    case "authRequired":
      return { status: "authRequired" };
    default:
      throw new Error(`unknown fixture status: ${input.status}`);
  }
}

export const contractEvents: VaultSyncEvent[] = raw.events.map((event): VaultSyncEvent => {
  const projectId = event.projectId;
  switch (event.type) {
    case "syncing":
      return { type: "syncing", projectId };
    case "localSaved":
      return {
        type: "localSaved",
        projectId,
        generation: need(event.generation, "generation"),
        paths: need(event.paths, "paths"),
      };
    case "committed":
      return {
        type: "committed",
        projectId,
        revision: need(event.revision, "revision"),
        paths: need(event.paths, "paths"),
      };
    case "conflict":
      return {
        type: "conflict",
        projectId,
        conflictId: need(event.conflictId, "conflictId"),
        path: need(event.path, "path"),
        kind: oneOf(conflictKinds, event.kind, "kind"),
      };
    case "deferred":
    case "quota":
    case "expired":
      return { type: event.type, projectId, path: need(event.path, "path") };
    case "applied":
      return { type: "applied", projectId, paths: need(event.paths, "paths") };
    case "audio": {
      const message = event.message;
      return {
        type: "audio",
        projectId,
        path: need(event.path, "path"),
        state: oneOf(audioStates, event.state, "state"),
        ...(message === undefined ? {} : { message }),
      };
    }
    case "offline":
      return { type: "offline", projectId, message: need(event.message, "message") };
    case "tombstone":
      return { type: "tombstone", projectId, needsChoice: need(event.needsChoice, "needsChoice") };
    case "done":
      return { type: "done", projectId, status: status(event.status) };
    default:
      throw new Error(`unknown fixture event: ${event.type}`);
  }
});

const snapshotInput = raw.snapshot;

export const contractSnapshot: ProjectSyncSnapshot = {
  projectId: snapshotInput.projectId,
  revision: snapshotInput.revision,
  syncing: snapshotInput.syncing,
  localGeneration: snapshotInput.localGeneration,
  acknowledgedGeneration: snapshotInput.acknowledgedGeneration,
  dirty: snapshotInput.dirty,
  pendingMutation: snapshotInput.pendingMutation,
  conflicts: snapshotInput.conflicts.map((conflict) => ({
    conflictId: conflict.conflictId,
    path: conflict.path,
    kind: oneOf(conflictKinds, conflict.kind, "conflicts.kind"),
    status: oneOf(conflictStatuses, conflict.status, "conflicts.status"),
    remoteDeviceId: conflict.remoteDeviceId,
    remoteDeviceKind: conflict.remoteDeviceKind === null ? null : oneOf(deviceKinds, conflict.remoteDeviceKind, "conflicts.remoteDeviceKind"),
  })),
  deferred: snapshotInput.deferred,
  remoteWriters: Object.fromEntries(
    Object.entries(snapshotInput.remoteWriters).map(([path, writer]) => [path, {
      deviceId: writer.deviceId,
      deviceKind: writer.deviceKind === null ? null : oneOf(deviceKinds, writer.deviceKind, "remoteWriters.deviceKind"),
    }]),
  ),
  quotaPaths: snapshotInput.quotaPaths,
  blocked: snapshotInput.blocked.map((blocked) => ({
    path: blocked.path,
    reason: oneOf(blockedReasons, blocked.reason, "blocked.reason"),
  })),
  expiredAudio: snapshotInput.expiredAudio,
  audio: Object.fromEntries(
    Object.entries(snapshotInput.audio).map(([path, state]) => [path, oneOf(audioStates, state, "audio")]),
  ),
  lastSyncedAt: snapshotInput.lastSyncedAt,
  lastError: errorInfo(snapshotInput.lastError, "lastError"),
  retryAfter: snapshotInput.retryAfter,
  tombstone: snapshotInput.tombstone,
};

export const contractRootPaths = {
  allowed: raw.rootPaths.allowed.filter(isDocsVaultRootPathAllowed),
  rejected: raw.rootPaths.rejected.filter((path) => !isDocsVaultRootPathAllowed(path)),
};

if (
  contractRootPaths.allowed.length !== raw.rootPaths.allowed.length
  || contractRootPaths.rejected.length !== raw.rootPaths.rejected.length
) {
  throw new Error("root path fixture disagrees with isDocsVaultRootPathAllowed");
}
