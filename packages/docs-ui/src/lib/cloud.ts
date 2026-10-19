import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ROOT_RECORDING_ID, SOURCE_STEP_ID } from "@niho/docs-core";
import type { Bridge, RecordingRef } from "./bridge";
import {
  LOCAL_SAVE_IDLE_MS,
  DOCS_ROOT_PROJECT_ID,
  type CloudAppliedEvent,
  type CloudState,
  type ProjectSyncSnapshot,
  type RemoteProject,
  type SyncErrorInfo,
} from "./cloud-types";

/** Store の null はローカルのまま保ち、cloud command/event だけ予約 ROOT id に写す。 */
export function cloudProjectId(projectId: string | null): string {
  return projectId ?? DOCS_ROOT_PROJECT_ID;
}

export function localProjectId(projectId: string): string | null {
  return projectId === DOCS_ROOT_PROJECT_ID ? null : projectId;
}

/**
 * NIHO クラウドの画面の決まり（C3 #18595。spec niho-docs-cloud §7.2・§7.3・§8.1・§9・§10・§15）。
 *
 * - `useCloud`: 保存先の状態・案件ごとの同期の状態・クラウドの案件の一覧を event で追う（最初に `cloudState()` を読む）。窓の前面化と
 *   表示中の 5 分ごとに `cloudFocus` を呼ぶ。
 * - `saveStatus`: 文書・成果物のメタ行の保存の状態（画面反映 → このMac → クラウドの三段階）。純粋な関数。
 * - `useCloudProtection`: 開いている文書の path を守る（その間に届いた別の Mac の変更は反映を延ばす）。
 */

// ---------------------------------------------------------------------------
// 同期の対象の id（フォルダ外のページは予約の docs-root。Rust の DOCS_ROOT_PROJECT_ID・#18721）

/** ページの持ち主（フォルダの id。フォルダの外は null）を、同期の状態・保護・競合の鍵にする。 */
export function cloudProjectIdOf(projectId: string | null): string {
  return cloudProjectId(projectId);
}

/** 同期の対象の id を、store（bridge）のページの持ち主へ戻す（docs-root はフォルダの外の null）。 */
export function pageOwnerOf(cloudProjectId: string): string | null {
  return localProjectId(cloudProjectId);
}

// ---------------------------------------------------------------------------
// 案件の中の path（Rust の store と同じ形。同期の状態の鍵）

/** 録音の中身の置き場（root は案件フォルダ直下）。 */
export function recordingPrefix(recordingId: string): string {
  return recordingId === ROOT_RECORDING_ID ? "" : `recordings/${recordingId}/`;
}

export function pagePath(pageId: string): string {
  return `pages/${pageId}.md`;
}

/** 工程の今の文書（工程 1 は文字起こし）。 */
export function artifactPath(rec: RecordingRef, stepId: string): string {
  const prefix = recordingPrefix(rec.recordingId);
  return stepId === SOURCE_STEP_ID ? `${prefix}transcript.md` : `${prefix}artifacts/${stepId}.md`;
}

export function audioPath(rec: RecordingRef, file: string): string {
  return `${recordingPrefix(rec.recordingId)}inputs/${file}`;
}

/** 両方を編集して保存できる文書（Markdown・テキスト。JSON や音声は片方を選ぶだけ）。 */
export function isTextPath(path: string): boolean {
  return /\.(md|txt)$/i.test(path);
}

/** その録音の工程の今の文書の path なら工程 id（文字起こしは source）。ほかは null。 */
export function stepOfPath(rec: RecordingRef, path: string): string | null {
  const prefix = recordingPrefix(rec.recordingId);
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  if (rest === "transcript.md") return SOURCE_STEP_ID;
  return /^artifacts\/([^/]+)\.md$/.exec(rest)?.[1] ?? null;
}

/**
 * 変更の確認の「この Mac」に出す今の本文（文書のページ・成果物・文字起こし）。ほかは null（重なったときの写しを出す）。
 * 「このMacの内容を使う」は今のファイルを残すので、写しより新しい編集があればそれを見せる。
 */
export async function readCurrentText(bridge: Bridge, projectId: string, path: string): Promise<string | null> {
  if (projectId === "flows" || projectId === "profile") return null;
  const owner = pageOwnerOf(projectId);
  const page = /^pages\/([^/]+)\.md$/.exec(path)?.[1];
  if (page) return bridge.readPage(owner, page);
  const match = /^(?:recordings\/([^/]+)\/)?(?:transcript\.md|artifacts\/([^/]+)\.md)$/.exec(path);
  if (!match) return null;
  // フォルダの外には「今の案件の録音」（root の録音）は無い
  if (owner === null && !match[1]) return null;
  const rec = { projectId: owner, recordingId: match[1] ?? ROOT_RECORDING_ID };
  if (match[2]) return bridge.readArtifact(rec, match[2]);
  return (await bridge.loadRecording(rec)).transcript;
}

// ---------------------------------------------------------------------------
// 保存の状態（spec §7.2 の三段階）

/** この Mac への保存の段階（waiting は最初の未保存の入力から 250ms まで。この間は何も出さない）。 */
export type LocalPhase = "saved" | "waiting" | "saving" | "failed";

/** この Mac への保存の様子（generation はこのページで最後に保存した世代。保存していなければ null）。 */
export type LocalSaveState = { phase: LocalPhase; generation: number | null };

export const SAVED_LOCALLY: LocalSaveState = { phase: "saved", generation: null };

export type SaveTone = "muted" | "warn" | "error";
export type SaveStatus = { text: string; tone: SaveTone };

export const SAVE_TEXT = {
  saving: "保存中",
  failed: "このMacに保存できません",
  conflict: "変更の確認が必要",
  local: "このMacに保存済み",
  quota: "クラウド容量が足りません",
  login: "このMacに保存済み・ログインが必要",
  offline: "このMacに保存済み・オフライン",
  pending: "このMacに保存済み・同期待ち",
  cloud: "クラウドに保存済み",
} as const;

export type SaveStatusInput = {
  local: LocalPhase;
  /** このページで最後に保存した世代（このページで保存していなければ null）。 */
  savedGeneration: number | null;
  /** 案件の中の path（pages/<id>.md など）。 */
  path: string;
  cloud: CloudState | null;
  snapshot: ProjectSyncSnapshot | null;
};

/** 同期の失敗のうち「オフライン」と出すもの（容量・ログイン・削除は別に出す）。 */
const SYNC_ERRORS: ReadonlySet<SyncErrorInfo["kind"]> = new Set<SyncErrorInfo["kind"]>([
  "offline",
  "server",
  "rateLimited",
  "invalid",
  "mutationMismatch",
]);

/** その path に確かめが要る競合があるか（解決中のものは数えない）。 */
export function pathHasConflict(snapshot: ProjectSyncSnapshot | null | undefined, path: string): boolean {
  return snapshot?.conflicts.some((conflict) => conflict.status === "open" && conflict.path === path) ?? false;
}

/** 案件に確かめが要る競合があるか。 */
export function hasOpenConflicts(snapshot: ProjectSyncSnapshot | null | undefined): boolean {
  return snapshot?.conflicts.some((conflict) => conflict.status === "open") ?? false;
}

/**
 * フォルダの同期が終わっているか（未送信の変更・送信中・衝突・別の Mac での削除・誤りが無い）。本人 Mac 実行の送る前の確かめと、
 * フォルダの書き出し（API がクラウドの本文を読む）で使う。
 */
export function cloudSettled(snapshot: ProjectSyncSnapshot | null): boolean {
  return (
    snapshot !== null &&
    !snapshot.syncing &&
    !snapshot.pendingMutation &&
    Object.keys(snapshot.dirty).length === 0 &&
    snapshot.acknowledgedGeneration >= snapshot.localGeneration &&
    !snapshot.conflicts.some((conflict) => conflict.status === "open") &&
    snapshot.tombstone === null &&
    snapshot.lastError === null
  );
}

/**
 * メタ行の保存の状態。「クラウドに保存済み」は、このページの入力をこの Mac に保存し終え（`local` が saved）、同期の状態がその世代まで
 * 届いていて（`localGeneration >= savedGeneration`）、その path が未送信（dirty）でも競合でもないときだけ。null は何も出さない。
 */
export function saveStatus(input: SaveStatusInput): SaveStatus | null {
  switch (input.local) {
    case "waiting":
      return null;
    case "saving":
      return { text: SAVE_TEXT.saving, tone: "muted" };
    case "failed":
      return { text: SAVE_TEXT.failed, tone: "error" };
    case "saved":
      break;
  }
  const { cloud, snapshot, path } = input;
  if (pathHasConflict(snapshot, path)) return { text: SAVE_TEXT.conflict, tone: "warn" };
  if (!cloud || cloud.provider !== "niho") return { text: SAVE_TEXT.local, tone: "muted" };
  if (snapshot?.quotaPaths.includes(path)) return { text: SAVE_TEXT.quota, tone: "warn" };
  if (cloud.status === "signedOut" || cloud.status === "expired" || snapshot?.lastError?.kind === "authRequired") {
    return { text: SAVE_TEXT.login, tone: "warn" };
  }
  // 別のアカウントの保存先は同期しない（この Mac にだけ保存している）
  if (cloud.status === "otherAccount") return { text: SAVE_TEXT.local, tone: "muted" };
  if (cloud.status === "active" && (cloud.message !== null || (snapshot?.lastError && SYNC_ERRORS.has(snapshot.lastError.kind)))) {
    return { text: SAVE_TEXT.offline, tone: "warn" };
  }
  const stale = input.savedGeneration !== null && (snapshot?.localGeneration ?? 0) < input.savedGeneration;
  if (cloud.status !== "active" || !snapshot || snapshot.dirty[path] !== undefined || stale || snapshot.tombstone !== null) {
    return { text: SAVE_TEXT.pending, tone: "muted" };
  }
  return { text: SAVE_TEXT.cloud, tone: "muted" };
}

/** 最後の入力から 250ms・最初の未保存の入力から 1 秒の早い方（連続して打っても期限を後ろにずらさない）。 */
export function saveDue(now: number, since: number, idleMs: number, maxMs: number): number {
  return Math.max(0, Math.min(now + idleMs, since + maxMs) - now);
}

/** 未保存の入力があるときの段階（最初の入力から 250ms までは何も出さない）。 */
export function pendingPhase(since: number | null, now: number): LocalPhase {
  return since !== null && now - since >= LOCAL_SAVE_IDLE_MS ? "saving" : "waiting";
}

// ---------------------------------------------------------------------------
// 文言

const LATIN_END = /[A-Za-z0-9)）]$/u;

/** 名前のあとに続ける（英数字で終わる名前は半角の空白を挟む: 「Mac Studio で実行中」）。 */
export function joinName(name: string, rest: string): string {
  return LATIN_END.test(name) ? `${name} ${rest}` : `${name}${rest}`;
}

/** レールの案件の行の下（別の Mac が lease を持っている）。 */
export function leaseLabel(deviceName: string): string {
  return joinName(deviceName.trim() || "別の Mac", "で実行中");
}

/** 録音のページの実行の帯の上（別の Mac が lease を持っている）。 */
export function leaseRunNote(deviceName: string): string {
  const name = deviceName.trim();
  return name
    ? `別の Mac（${name}）で実行中です。終わると、この Mac でも実行できます。`
    : "別の Mac で実行中です。終わると、この Mac でも実行できます。";
}

/** 別の Mac が実行中の案件（lease を持っているのがこの Mac でなければ、その名前。期限が切れた lease は無いものとして扱う）。 */
export function remoteLeaseHolder(remote: readonly RemoteProject[], projectId: string, now: number = Date.now()): string | null {
  const lease = remote.find((project) => project.projectId === projectId)?.lease;
  if (!lease || lease.mine) return null;
  // 一覧の再取得はフォーカス時か 5 分間隔なので、期限が切れた後も古い lease が残る。実行を止め続けないよう、期限で判定する
  // （期限を読めないときは、別の Mac が持っているものとして止める）
  const expiresAt = Date.parse(lease.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now ? null : lease.deviceName;
}

/** 別の Mac の lease のうち、次に期限が切れる時刻（画面を期限に合わせて更新する）。無ければ null。 */
export function nextRemoteLeaseExpiry(remote: readonly RemoteProject[], now: number = Date.now()): number | null {
  const times = remote.flatMap((project) => {
    const lease = project.lease;
    if (!lease || lease.mine) return [];
    const at = Date.parse(lease.expiresAt);
    return Number.isFinite(at) && at > now ? [at] : [];
  });
  return times.length === 0 ? null : Math.min(...times);
}

/** 使用量・移行の大きさ（「320 MB」「1.2 GB」「5 GB」。GB は 1024³ バイト）。 */
export function formatBytes(bytes: number): string {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  if (bytes >= gib) return `${trimDecimal(bytes / gib)} GB`;
  if (bytes >= mib) return `${Math.round(bytes / mib)} MB`;
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return "0 MB";
}

function trimDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export const AUDIO_TEXT = {
  downloading: "クラウドから取得しています…",
  uploading: "クラウドに上げています…",
  waiting: "同期を待っています",
  expired: "クラウドの音声は 30 日を過ぎたため削除されました。写しのある Mac から上げ直せます。",
} as const;

/** 録音のページの音声の行の添え書き（NIHO クラウドのときだけ。何も無ければ null）。 */
export function audioStatusText(input: {
  niho: boolean;
  path: string;
  file: string;
  snapshot: ProjectSyncSnapshot | null;
  missingInputs: readonly string[];
}): string | null {
  if (!input.niho) return null;
  const state = input.snapshot?.audio[input.path];
  const missing = input.missingInputs.includes(input.file);
  if (state === "downloading") return AUDIO_TEXT.downloading;
  if (state === "uploading") return AUDIO_TEXT.uploading;
  if (missing && input.snapshot?.expiredAudio.includes(input.path)) return AUDIO_TEXT.expired;
  if (state === "queued" || state === "failed" || missing) return AUDIO_TEXT.waiting;
  return null;
}

// ---------------------------------------------------------------------------
// 画面の状態（event）

export type CloudController = {
  state: CloudState | null;
  /** 保存先が NIHO クラウド。 */
  niho: boolean;
  /** NIHO クラウドと同期している（engine が動いている）。 */
  active: boolean;
  /** 案件ごとの同期の状態（`flows`・`profile` も同じ鍵で入る）。 */
  snapshots: Readonly<Record<string, ProjectSyncSnapshot>>;
  /** クラウドの案件の一覧（同期していなければ空）。 */
  remote: readonly RemoteProject[];
  /** command が返した状態を出す（保存先の切り替え・移行の開始など）。 */
  putState: (state: CloudState) => void;
  /** 同期の状態を読み直す。反映したあとで解決する（失敗しても解決する）。 */
  refreshSnapshot: (projectId: string) => Promise<void>;
  refreshRemote: () => void;
  /** `cloud://applied`（別の Mac の変更をこの Mac に反映した）を受ける。戻り値でやめる。 */
  subscribeApplied: (listener: (event: CloudAppliedEvent) => void) => () => void;
};

/** 表示中の確かめの間隔（spec §7.2.2 の 5 分ごと）。 */
export const CLOUD_FOCUS_INTERVAL_MS = 5 * 60_000;

export function useCloud(bridge: Bridge, openProjectId: string | null): CloudController {
  const enabled = bridge.capabilities?.cloudSync !== false;
  const [state, setState] = useState<CloudState | null>(null);
  const [snapshots, setSnapshots] = useState<Record<string, ProjectSyncSnapshot>>({});
  const [remote, setRemote] = useState<RemoteProject[]>([]);
  const appliedRef = useRef(new Set<(event: CloudAppliedEvent) => void>());
  /** native が選択した root/account/session context。受信時の現在値を古い payload へ付け直さない。 */
  const contextGenerationRef = useRef(-1);
  /** 案件ごとに届いた event の数（command の読み取りが届く前の event を古い値で上書きしない）。 */
  const projectEvents = useRef(new Map<string, number>());
  const focusedProjectId = cloudProjectId(openProjectId);
  const openRef = useRef(focusedProjectId);
  openRef.current = focusedProjectId;

  const acceptState = useCallback((next: CloudState): boolean => {
    const current = contextGenerationRef.current;
    if (next.contextGeneration < current) return false;
    if (next.contextGeneration > current) {
      contextGenerationRef.current = next.contextGeneration;
      projectEvents.current.clear();
      setSnapshots({});
      setRemote([]);
    }
    setState(next);
    return true;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let sawState = false;
    const stops: Array<() => void> = [];
    const keep = (stop: () => void) => {
      if (cancelled) stop();
      else stops.push(stop);
    };
    void (async () => {
      // 先に購読してから今の状態を読む（読むまでのあいだに変わっても取りこぼさない）
      await Promise.all([
        bridge
          .onCloudState((next) => {
            if (!cancelled && acceptState(next)) sawState = true;
          })
          .then(keep, () => undefined),
        bridge
          .onCloudProject((event) => {
            if (cancelled || event.contextGeneration !== contextGenerationRef.current) return;
            projectEvents.current.set(event.projectId, (projectEvents.current.get(event.projectId) ?? 0) + 1);
            setSnapshots((all) => ({ ...all, [event.projectId]: event.snapshot }));
          })
          .then(keep, () => undefined),
        bridge
          .onCloudApplied((event) => {
            if (cancelled || event.contextGeneration !== contextGenerationRef.current) return;
            for (const listener of [...appliedRef.current]) listener(event);
          })
          .then(keep, () => undefined),
        bridge
          .onCloudRemote((event) => {
            if (!cancelled && event.contextGeneration === contextGenerationRef.current) setRemote(event.projects);
          })
          .then(keep, () => undefined),
      ]);
      if (cancelled) return;
      try {
        const current = await bridge.cloudState();
        if (!cancelled && !sawState) acceptState(current);
      } catch {
        // 読めなければ「この Mac だけ」として出す（保存はこれまでどおり）
      }
    })();
    return () => {
      cancelled = true;
      for (const stop of stops) stop();
    };
  }, [acceptState, bridge, enabled]);

  const refreshSnapshot = useCallback(
    (projectId: string) => {
      if (!enabled) return Promise.resolve();
      const contextGeneration = contextGenerationRef.current;
      const seen = projectEvents.current.get(projectId) ?? 0;
      return bridge.cloudProjectStatus(projectId).then(
        (reply) => {
          if (reply.contextGeneration !== contextGeneration || contextGenerationRef.current !== contextGeneration) return;
          if ((projectEvents.current.get(projectId) ?? 0) !== seen) return;
          setSnapshots((all) => {
            const snapshot = reply.snapshot;
            if (snapshot) return { ...all, [projectId]: snapshot };
            if (!(projectId in all)) return all;
            const next = { ...all };
            delete next[projectId];
            return next;
          });
        },
        () => undefined,
      );
    },
    [bridge, enabled],
  );

  const refreshRemote = useCallback(() => {
    if (!enabled) return;
    const contextGeneration = contextGenerationRef.current;
    bridge.cloudRemoteProjects().then((reply) => {
      if (reply.contextGeneration !== contextGeneration || contextGenerationRef.current !== contextGeneration) return;
      setRemote(reply.projects);
    }, () => undefined);
  }, [bridge, enabled]);

  const niho = state?.provider === "niho";
  const active = niho && state?.status === "active";
  const contextGeneration = state?.contextGeneration ?? -1;

  // 同期を始めたらクラウドの一覧を読む。この Mac だけに戻したら一覧は出さない
  useEffect(() => {
    if (active) refreshRemote();
    else if (!niho) setRemote([]);
  }, [active, contextGeneration, niho, refreshRemote]);

  // 案件を開いたとき・保存先が変わったときに、その案件の状態を読む（NIHO クラウドなら確かめも頼む）
  const status = state?.status ?? null;
  useEffect(() => {
    if (status === null) return;
    void refreshSnapshot(focusedProjectId);
    void bridge.cloudFocus(focusedProjectId).catch(() => undefined);
  }, [bridge, contextGeneration, focusedProjectId, status, refreshSnapshot]);

  // 窓が前面に戻ったとき・表示中の 5 分ごと（spec §7.2.2）
  useEffect(() => {
    const focus = () => void bridge.cloudFocus(openRef.current).catch(() => undefined);
    const tick = () => {
      if (document.visibilityState === "visible") focus();
    };
    window.addEventListener("focus", focus);
    const timer = window.setInterval(tick, CLOUD_FOCUS_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", focus);
      window.clearInterval(timer);
    };
  }, [bridge]);

  const subscribeApplied = useCallback((listener: (event: CloudAppliedEvent) => void) => {
    appliedRef.current.add(listener);
    return () => {
      appliedRef.current.delete(listener);
    };
  }, []);

  const putState = useCallback((next: CloudState) => {
    acceptState(next);
  }, [acceptState]);

  return useMemo(
    () => ({ state, niho, active, snapshots, remote, putState, refreshSnapshot, refreshRemote, subscribeApplied }),
    [state, niho, active, snapshots, remote, putState, refreshSnapshot, refreshRemote, subscribeApplied],
  );
}

/**
 * 開いている文書の path を守る（`enabled` の間だけ。別の Mac の変更は反映を延ばし、外したときに反映する）。spec §7.3。
 * paths の中身が同じなら登録し直さない。
 */
export function useCloudProtection(bridge: Bridge, enabled: boolean, projectId: string | null, paths: readonly string[]): void {
  const key = enabled && bridge.capabilities?.cloudSync !== false && projectId && paths.length > 0 ? [projectId, ...paths].join("\n") : null;
  useEffect(() => {
    if (!key) return;
    const [target, ...list] = key.split("\n");
    if (!target) return;
    let released = false;
    let id: number | null = null;
    bridge.cloudProtect(target, list).then(
      (got) => {
        if (released) void bridge.cloudRelease(got).catch(() => undefined);
        else id = got;
      },
      () => undefined,
    );
    return () => {
      released = true;
      if (id !== null) void bridge.cloudRelease(id).catch(() => undefined);
    };
  }, [bridge, key]);
}

/** 「最新を表示」で、別の Mac の変更が反映されるのを待つ上限。届かなくても読み直す。 */
export const APPLY_WAIT_MS = 15_000;

/**
 * その path の `cloud://applied` を待つ（届けば true、上限を過ぎたら false）。保護を外す前に呼ぶ（取りこぼさない）。
 */
export function waitForApplied(
  subscribe: CloudController["subscribeApplied"],
  projectId: string,
  path: string,
  timeoutMs = APPLY_WAIT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: number | undefined;
    const stop = subscribe((event) => {
      if (event.projectId !== projectId || !event.paths.includes(path)) return;
      window.clearTimeout(timer);
      stop();
      resolve(true);
    });
    timer = window.setTimeout(() => {
      stop();
      resolve(false);
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// 競合の名前（内部の id は出さない）

export type ConflictNames = {
  /** 文書のページの名前（無ければ null） */
  page: (pageId: string) => string | null;
  /** 工程の名前（無ければ null） */
  step: (recordingId: string, stepId: string) => string | null;
  /** 録音のページの名前（無ければ null） */
  recording: (recordingId: string) => string | null;
};

/** 競合の行の名前（フォルダの情報・文書・工程・録音の設定・あなたについて・工程設計）。 */
export function conflictLabel(projectId: string, path: string, names: ConflictNames): string {
  if (projectId === "profile") {
    if (path === "execution.json") return "残りの工程";
    return path === "about.json" ? "あなたについて" : "アカウント設定";
  }
  if (projectId === "flows") return "工程設計";
  // project.json はフォルダの名前・背景情報・登場人物・固有名詞・ページの並び（画面の言葉は「フォルダ」。spec niho-docs §7.1）
  if (path === "project.json") return "フォルダの情報";
  const page = /^pages\/([^/]+)\.md$/.exec(path);
  if (page?.[1]) return names.page(page[1]) ?? "文書";
  const recording = /^recordings\/([^/]+)\/(.+)$/.exec(path);
  const recordingId = recording?.[1] ?? ROOT_RECORDING_ID;
  const rest = recording?.[2] ?? path;
  if (rest === "transcript.md") return names.step(recordingId, SOURCE_STEP_ID) ?? "文字起こし";
  const artifact = /^artifacts\/([^/]+)\.md$/.exec(rest);
  if (artifact?.[1]) return names.step(recordingId, artifact[1]) ?? "ページ";
  if (rest === "recording.json") return `${names.recording(recordingId) ?? "録音"}の設定`;
  if (rest === "runs.jsonl") return "実行の記録";
  if (rest.startsWith("conversations/")) return "AIと作るの会話";
  if (rest.startsWith("versions/")) return "版";
  return "ファイル";
}
