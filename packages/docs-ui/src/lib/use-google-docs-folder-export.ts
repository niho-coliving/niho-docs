import { useEffect, useMemo, useRef, useState } from "react";
import type { DocsAccount as NihoAccount } from "../host/DocsAccount";
import {
  isCommandError,
  type Bridge,
  type CommandError,
  type DocsDriveConnection,
  type DocsDriveFolderExportPlan,
  type DocsDriveFolderExportRequest,
  type DocsDriveFolderExportStatus,
} from "./bridge";
import {
  FOLDER_EXPORT_TEXT,
  defaultFolderExportSelection,
  folderExportInclude,
  folderExportOverLimitTexts,
  hasFolderExportTimestamps,
  measureFolderExportSelection,
  reconcileFolderExportSelection,
  toggleFolderExportSelection,
  type FolderExportMeasure,
} from "./google-docs-folder-export";
import { googleDocsOwnerKey, type GoogleDocsController } from "./use-google-docs";
import { buildLocalFolderExportPlan, localFolderExportFiles, type LocalFolderExportPlan } from "./local-google-docs-folder-export";

/**
 * フォルダの書き出し（#18838）の状態。Web（apps/web/app/app/docs/_lib/use-docs-google-folder-export.ts）と同じ振る舞いにする:
 * 同じ ID での照会と再送・作成中の照会（ダイアログを開いている間だけ 3 秒ごと）・止まったときの続き・「新しく書き出す」の確認・`latest`
 * からの再開・409 での読み直し。Mac で違うのは、
 *
 * - Google の接続は `useGoogleDocs` の値を使い、接続は設定で行う（「設定へ進む」。接続して戻るとダイアログを開き直す）。
 * - 受付の写しはメモリだけ（1 ページの書き出しと同じ）。アプリを閉じて開き直したときは `latest` から進み具合か結果を出す。
 * - 保存が終わっているかは、そのフォルダの NIHO クラウドの同期の状態で見る（API がクラウドの本文を読むため）。
 * - 1 つのダイアログをフォルダごとに使い回す（開いたフォルダが変わったら、前のフォルダの表示は出さない。写しは残す）。
 */

export type FolderExportPhase = "editing" | "sending" | "pending" | "building" | "completed" | "failed" | "error";
export type FolderExportPlanStatus = "idle" | "loading" | "failed" | "loaded" | "reloading" | "reloadFailed";
/** フォルダの同期の状態（settled＝送り終えた・pending＝送っている途中か確かめ中・unavailable＝NIHO クラウドと同期していない）。 */
export type FolderExportSyncState = "settled" | "pending" | "unavailable";

/** 受け付けた（または受け付けたかもしれない）書き出し。`request` は写しがあるときだけ（同じ内容で再送できる）。 */
export type FolderExportTracked = {
  exportId: string;
  request: DocsDriveFolderExportRequest | null;
  receiptEmail: string | null;
};

export type FolderExportTarget = { projectId: string; folderName: string };

type TooLarge = FolderExportMeasure & { maxTabs: number; maxChars: number };

export type GoogleDocsFolderExportState = {
  /** 本人とフォルダ。変わったら前の状態を出さない。 */
  scope: string;
  target: FolderExportTarget | null;
  visible: boolean;
  /** 開いているフォルダの書きかけを、この Mac に書き残している間。 */
  preparing: boolean;
  /** 書きかけを書き残せなかった（開き直すまで書き出せない）。 */
  prepareFailed: boolean;
  planStatus: FolderExportPlanStatus;
  plan: DocsDriveFolderExportPlan | null;
  title: string;
  titleTouched: boolean;
  titleError: string | null;
  selected: ReadonlySet<string>;
  timestamps: boolean;
  timestampsTouched: boolean;
  phase: FolderExportPhase;
  tracked: FolderExportTracked | null;
  status: DocsDriveFolderExportStatus | null;
  busy: "post" | "lookup" | "resume" | null;
  retryable: boolean;
  notReceived: boolean;
  error: string | null;
  notice: string | null;
  /** API が上限を超えたと返した数（選び方を変えるまで「書き出す」を押せない）。 */
  tooLarge: TooLarge | null;
  awaitingReconnect: boolean;
  googleAccountChanged: boolean;
  recoverOnConnect: boolean;
  retryAfterMs: number | null;
  /** 照会のたびに増える。結果が同じでも次の照会を予約し直すため。 */
  attempt: number;
  /** 「新しく書き出す」の確認を出している。 */
  confirmRestart: boolean;
};

export type GoogleDocsFolderExportForm = {
  showTimestamps: boolean;
  measure: FolderExportMeasure | null;
  overLimit: string[];
  /** 「書き出す」を押せない理由（ボタンの近くに 1 行）。 */
  blockedReason: string | null;
  canSubmit: boolean;
};

export type GoogleDocsFolderExportController = {
  state: GoogleDocsFolderExportState;
  form: GoogleDocsFolderExportForm;
  signedIn: boolean;
  connection: DocsDriveConnection | null;
  connectionLoading: boolean;
  /** 接続を確かめられなかった（文は画面が持つ）。 */
  connectionFailed: boolean;
  /** 開いているフォルダの同期の状態（開いていなければ null）。 */
  sync: FolderExportSyncState | null;
  local: boolean;
  open: (target: FolderExportTarget & { prepare?: () => Promise<boolean> }) => void;
  close: () => void;
  reload: () => void;
  setTitle: (title: string) => void;
  toggle: (key: string, checked: boolean) => void;
  setTimestamps: (value: boolean) => void;
  submit: () => Promise<void>;
  check: () => Promise<void>;
  retry: () => Promise<void>;
  resume: () => Promise<void>;
  restart: () => void;
  cancelRestart: () => void;
  confirmRestart: () => void;
  openResult: () => Promise<void>;
  goToSettings: () => void;
  refreshConnection: () => Promise<void>;
};

type Operation = { exportId: string; generation: number; active: boolean };
type Receipt = { request: DocsDriveFolderExportRequest; receiptEmail: string | null; savedAt: number };

/** 作成中の照会の間隔（API の Retry-After と同じ 3 秒。429 の Retry-After があればそれ）。 */
export const FOLDER_EXPORT_POLL_MS = 3_000;
/** 結果の分からない受付（再送できない）を、開いている間だけ照会する間隔（Web と同じ）。 */
export const FOLDER_EXPORT_AUTO_CHECK_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 30_000] as const;
const EVENT_CHECK_DEBOUNCE_MS = 300;
/** 受付の写しを使う期間（API の `latest` と同じ 24 時間）。 */
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60_000;

/** 結果の分からない失敗（同じ ID で照会して確かめる）。 */
const AMBIGUOUS_CODES = new Set(["export_result_unknown", "network", "google_docs_invalid_response", "temporarily_unavailable"]);
const NETWORK_CODES = new Set(["export_result_unknown", "network"]);
/** 同じ Google アカウントへ接続し直せば確かめられる。 */
const RECONNECT_CODES = new Set(["drive_not_connected", "drive_reconnect_required", "drive_connection_changed"]);

const SETTLED = {
  retryable: false,
  notReceived: false,
  error: null,
  awaitingReconnect: false,
  googleAccountChanged: false,
  recoverOnConnect: false,
} as const;

function freshState(scope: string, target: FolderExportTarget | null, timestamps: boolean): GoogleDocsFolderExportState {
  return {
    scope, target, visible: false, preparing: false, prepareFailed: false, planStatus: "idle", plan: null, title: "", titleTouched: false,
    titleError: null, selected: new Set(), timestamps, timestampsTouched: false, phase: "editing", tracked: null, status: null, busy: null,
    ...SETTLED, notice: null, tooLarge: null, retryAfterMs: null, attempt: 0, confirmRestart: false,
  };
}

function scopeOf(owner: string | null, projectId: string | null): string {
  return `${owner ?? ""}\n${projectId ?? ""}`;
}

function normalizedEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function freshId(): string {
  return crypto.randomUUID().toLowerCase();
}

/** bridge の失敗の code（CommandError でないもの＝invoke の失敗は通信の失敗として扱う。Web の NETWORK_ERROR と同じ）。 */
function failureOf(error: unknown): CommandError {
  return isCommandError(error) ? error : { code: "network", message: "" };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function retryAfterOf(error: CommandError): number | null {
  const value = error.details?.retryAfterMs;
  return isCount(value) && value > 0 ? value : null;
}

function tooLargeFrom(details: Record<string, unknown> | undefined, limits: DocsDriveFolderExportPlan["limits"] | undefined): TooLarge | null {
  const value: Record<string, unknown> = details ?? {};
  const maxTabs = isCount(value.maxTabs) ? value.maxTabs : limits?.maxTabs;
  const maxChars = isCount(value.maxChars) ? value.maxChars : limits?.maxChars;
  const { tabs, chars } = value;
  if (!isCount(tabs) || !isCount(chars) || maxTabs === undefined || maxChars === undefined) return null;
  return { tabs, chars, maxTabs, maxChars };
}

function statusFields(status: DocsDriveFolderExportStatus, tracked: FolderExportTracked): Partial<GoogleDocsFolderExportState> {
  if (status.status === "pending") return { phase: "pending", status, retryable: status.retryable && tracked.request !== null };
  return { phase: status.status, status };
}

/**
 * 書き出せない理由（保存の側）。NIHO クラウドに保存していないフォルダ（この Mac だけ・別のアカウント・ログアウト）は待っても
 * 書き出せないので、同期待ちとは別の文にする（design-guide-docs.md §5.1）。
 */
function folderExportUnsavedReason(
  state: Pick<GoogleDocsFolderExportState, "target" | "preparing" | "prepareFailed">,
  sync: FolderExportSyncState | null,
  local = false,
): string | null {
  if (state.target && sync === "unavailable") return FOLDER_EXPORT_TEXT.notInCloud;
  if (!state.target || state.preparing || state.prepareFailed || sync !== "settled") {
    return local ? FOLDER_EXPORT_TEXT.localUnsaved : FOLDER_EXPORT_TEXT.unsaved;
  }
  return null;
}

function formOf(state: GoogleDocsFolderExportState, unsaved: string | null, connected: boolean): GoogleDocsFolderExportForm {
  const { plan } = state;
  const showTimestamps = plan ? hasFolderExportTimestamps(plan.nodes) : false;
  const measure = plan ? measureFolderExportSelection(plan.nodes, state.selected, showTimestamps && state.timestamps) : null;
  const overLimit = state.tooLarge
    ? folderExportOverLimitTexts(state.tooLarge, state.tooLarge)
    : plan && measure ? folderExportOverLimitTexts(measure, plan.limits) : [];
  let blockedReason: string | null = null;
  if (plan && !plan.available) blockedReason = FOLDER_EXPORT_TEXT.unavailable;
  else if (unsaved) blockedReason = unsaved;
  else if (plan && state.selected.size === 0) blockedReason = FOLDER_EXPORT_TEXT.noSelection;
  const ready = state.phase === "editing" && !state.tracked && state.planStatus === "loaded" && plan !== null && connected && state.busy === null;
  return {
    showTimestamps,
    measure,
    overLimit,
    blockedReason,
    canSubmit: ready && blockedReason === null && overLimit.length === 0 && state.title.trim().length > 0,
  };
}

export function useGoogleDocsFolderExport(props: {
  bridge: Bridge;
  account: NihoAccount;
  googleDocs: GoogleDocsController;
  /** 設定の画面へ移る（Google の接続は設定で行う）。 */
  onOpenSettings: () => void;
  /** そのフォルダの同期の状態（描くたびに読む）。 */
  syncState: (projectId: string) => FolderExportSyncState;
  /** そのフォルダの同期の状態を読み直す（反映したあとで解決する）。 */
  refreshSync: (projectId: string) => void | Promise<void>;
  /** 「この Mac だけ」は Mac の固定 snapshot を使う。 */
  local: boolean;
  /** タイムスタンプの既定（表示の設定。ダイアログの中で変えても設定は書き換えない）。 */
  defaultTimestamps: boolean;
}): GoogleDocsFolderExportController {
  const { bridge, account, googleDocs } = props;
  const owner = googleDocsOwnerKey(account);
  const signedIn = account.state?.kind === "signedIn";
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const generationRef = useRef(0);
  const previousOwnerRef = useRef<string | null>(null);
  const [state, setState] = useState<GoogleDocsFolderExportState>(() => freshState(scopeOf(null, null), null, props.defaultTimestamps));
  const stateRef = useRef(state);
  const connectionRef = useRef<DocsDriveConnection | null>(googleDocs.connection);
  const operationRef = useRef<Operation | null>(null);
  const planSeq = useRef(0);
  const autoChecks = useRef<{ exportId: string; count: number } | null>(null);
  /** 受付の写し（フォルダごとに 1 つ。本人が変わったら捨てる）。 */
  const receiptsRef = useRef(new Map<string, Receipt>());
  const localPreparedRef = useRef<LocalFolderExportPlan | null>(null);
  /** 「新しく書き出す」でやめた書き出し。開き直しても `latest` から戻さない。 */
  const dismissedRef = useRef(new Set<string>());
  const [resumeAfterConnect, setResumeAfterConnect] = useState(false);
  const mountedRef = useRef(false);
  /** 開いているフォルダの同期の状態（描くたびに読む。変わったら木を読み直す）。 */
  const lastSync = useRef<FolderExportSyncState | null>(null);
  const latest = useRef(props);
  latest.current = props;

  const actions = useMemo(() => {
    const commit = (next: GoogleDocsFolderExportState) => {
      if (!mountedRef.current) return;
      stateRef.current = next;
      setState(next);
    };
    const patch = (fields: Partial<GoogleDocsFolderExportState>) => commit({ ...stateRef.current, ...fields });
    const isCurrent = (operation: Operation) => mountedRef.current && operationRef.current === operation &&
      generationRef.current === operation.generation && stateRef.current.tracked?.exportId === operation.exportId;
    const projectIdNow = () => stateRef.current.target?.projectId ?? null;
    const forgetReceipt = () => {
      const projectId = projectIdNow();
      if (projectId !== null) receiptsRef.current.delete(projectId);
      autoChecks.current = null;
    };
    const connected = () => connectionRef.current?.status === "CONNECTED";
    const unsavedNow = () => {
      const current = stateRef.current;
      return folderExportUnsavedReason(current, current.target ? latest.current.syncState(current.target.projectId) : null,
        latest.current.local);
    };
    const refreshConnection = () => latest.current.googleDocs.refreshConnection();

    /** 接続が変わった。作成中・完了・止まったは NIHO 側の状態が正（接続が変われば API が止めて failed を返す）。接続で決まるのは結果の分からない受付だけ。 */
    const applyConnection = (next: DocsDriveConnection | null, previous: DocsDriveConnection | null) => {
      connectionRef.current = next;
      const current = stateRef.current;
      if (!next || !current.tracked ||
        (current.phase !== "pending" && !(current.phase === "error" && (current.awaitingReconnect || current.googleAccountChanged)))) return;
      if (next.status !== "CONNECTED") {
        patch({ ...SETTLED, phase: "error", awaitingReconnect: true, error: FOLDER_EXPORT_TEXT.reconnect });
        return;
      }
      const email = normalizedEmail(next.connectedEmail);
      if (current.tracked.receiptEmail && email !== current.tracked.receiptEmail) {
        patch({ ...SETTLED, phase: "error", googleAccountChanged: true, error: FOLDER_EXPORT_TEXT.accountChanged });
        return;
      }
      const changed = previous?.status !== "CONNECTED" || normalizedEmail(previous.connectedEmail) !== email;
      if (current.recoverOnConnect || ((current.awaitingReconnect || current.googleAccountChanged) && changed)) {
        patch({ phase: "pending", error: null, awaitingReconnect: false, googleAccountChanged: false, recoverOnConnect: true });
      } else if (current.awaitingReconnect) {
        patch({ awaitingReconnect: false });
      }
    };

    const readReceipt = (projectId: string): Receipt | null => {
      const receipt = receiptsRef.current.get(projectId) ?? null;
      if (receipt && Date.now() - receipt.savedAt > RECEIPT_MAX_AGE_MS) {
        receiptsRef.current.delete(projectId);
        return null;
      }
      return receipt;
    };

    /** 開いたときに、写しか `latest` から続きを出す（写しが `latest` に無ければ同じ ID で照会する）。 */
    const restored = (plan: DocsDriveFolderExportPlan): Partial<GoogleDocsFolderExportState> => {
      const dismissed = dismissedRef.current;
      const receipt = readReceipt(plan.projectId);
      const shownLatest = plan.latest && !dismissed.has(plan.latest.exportId) ? plan.latest : null;
      if (receipt && !dismissed.has(receipt.request.exportId)) {
        const tracked = { exportId: receipt.request.exportId, request: receipt.request, receiptEmail: receipt.receiptEmail };
        if (shownLatest && shownLatest.exportId === tracked.exportId) {
          if (shownLatest.status !== "pending") forgetReceipt();
          return { ...SETTLED, tracked, ...statusFields(shownLatest, tracked) };
        }
        return { ...SETTLED, tracked, phase: "pending", status: null, recoverOnConnect: true };
      }
      if (!shownLatest) return {};
      const tracked = { exportId: shownLatest.exportId, request: null, receiptEmail: null };
      return { ...SETTLED, tracked, ...statusFields(shownLatest, tracked) };
    };

    async function loadPlan({ initial, notice = null }: { initial: boolean; notice?: string | null }) {
      const projectId = projectIdNow();
      if (!mountedRef.current || projectId === null || !ownerRef.current) return;
      const seq = ++planSeq.current;
      const scope = stateRef.current.scope;
      const before = stateRef.current;
      patch({ planStatus: initial || !before.plan ? "loading" : "reloading", notice: null });
      try {
        const prepared = latest.current.local
          ? await Promise.all([bridge.docsDriveFolderExportLocalSnapshot(projectId), bridge.docsDriveFolderExportLocalPlan(projectId)])
            .then(([snapshot, server]) => buildLocalFolderExportPlan(snapshot, server))
          : null;
        const plan = prepared?.plan ?? await bridge.docsDriveFolderExportPlan(projectId);
        if (!mountedRef.current || seq !== planSeq.current || stateRef.current.scope !== scope) return;
        localPreparedRef.current = prepared;
        const current = stateRef.current;
        const selected = current.plan
          ? reconcileFolderExportSelection(current.plan.nodes, plan.nodes, current.selected)
          : defaultFolderExportSelection(plan.nodes);
        const title = current.titleTouched ? current.title : plan.title.trim() || current.target?.folderName || "";
        const next: GoogleDocsFolderExportState = { ...current, plan, planStatus: "loaded", selected, title, notice };
        const restoredFields = initial && !current.tracked ? restored(plan) : null;
        commit(restoredFields ? { ...next, ...restoredFields } : next);
        // 開き直したあとなどで、Google の接続がすでに切れている（か別のアカウント）と分かっていれば、復元した受付にも適用する
        // （接続の取得が先に済んでいると、接続が変わらないので applyConnection が再び呼ばれない）
        if (restoredFields) applyConnection(connectionRef.current, null);
      } catch (raw) {
        if (!mountedRef.current || seq !== planSeq.current || stateRef.current.scope !== scope || failureOf(raw).code === "account_changed") return;
        patch({ planStatus: stateRef.current.planStatus === "reloading" ? "reloadFailed" : "failed" });
      }
    }

    /** 受け付けられなかった（送った内容は NIHO にも Google にも残っていない）。写しを消して入力へ戻す。 */
    const backToInput = (fields: Partial<GoogleDocsFolderExportState>) => {
      forgetReceipt();
      operationRef.current = null;
      patch({ ...SETTLED, phase: "editing", tracked: null, status: null, busy: null, retryAfterMs: null, ...fields });
    };

    const applyStatus = (operation: Operation, status: DocsDriveFolderExportStatus) => {
      if (!isCurrent(operation)) return;
      const tracked = stateRef.current.tracked!;
      // 作成中・完了・止まったは NIHO 側に受付があり、開き直すと `latest` から戻せる
      if (status.status !== "pending") forgetReceipt();
      patch({ ...SETTLED, ...statusFields(status, tracked), busy: null, retryAfterMs: null });
    };

    /** 結果の分かる接続の失敗。true なら処理済み。 */
    const applyKnownFailure = (error: CommandError): boolean => {
      if (RECONNECT_CODES.has(error.code)) {
        patch({ ...SETTLED, phase: "error", busy: null, awaitingReconnect: true, error: FOLDER_EXPORT_TEXT.reconnect });
        void refreshConnection();
        return true;
      }
      if (error.code === "google_account_changed") {
        patch({ ...SETTLED, phase: "error", busy: null, googleAccountChanged: true, error: FOLDER_EXPORT_TEXT.accountChanged });
        return true;
      }
      return false;
    };

    const lookup = async (operation: Operation, tracked: FolderExportTracked, fromUnknown: boolean) => {
      patch({ busy: "lookup", recoverOnConnect: false, attempt: stateRef.current.attempt + 1 });
      try {
        applyStatus(operation, await bridge.docsDriveFolderExportStatus(tracked.exportId));
      } catch (raw) {
        if (!isCurrent(operation)) return;
        const error = failureOf(raw);
        if (error.code === "account_changed" || applyKnownFailure(error)) return;
        const phase = stateRef.current.phase;
        if (error.code === "export_not_found") {
          patch({ ...SETTLED, phase: "pending", status: null, busy: null, retryable: tracked.request !== null, notReceived: true });
        } else if (fromUnknown || AMBIGUOUS_CODES.has(error.code)) {
          // 結果はまだ分からない。表示はそのまま、次の照会・通信の復帰で確かめる（作成中は通信断のときだけ一言添える）
          const network = NETWORK_CODES.has(error.code);
          const message = phase === "building" ? (network ? FOLDER_EXPORT_TEXT.network : null)
            : network ? FOLDER_EXPORT_TEXT.network : FOLDER_EXPORT_TEXT.unknownFailure;
          patch({
            phase: phase === "sending" ? "pending" : phase,
            busy: null,
            error: message,
            retryAfterMs: retryAfterOf(error),
            ...(fromUnknown ? { retryable: false, notReceived: false } : {}),
          });
        } else {
          patch({ ...SETTLED, phase: "error", busy: null, error: FOLDER_EXPORT_TEXT.unknownFailure });
        }
      }
    };

    const post = async (operation: Operation, tracked: FolderExportTracked, request: DocsDriveFolderExportRequest) => {
      patch({ phase: "sending", busy: "post", error: null, notReceived: false, attempt: stateRef.current.attempt + 1 });
      try {
        const prepared = localPreparedRef.current;
        if (latest.current.local && !prepared) throw { code: "folder_changed", message: "" };
        const result = latest.current.local && prepared
          ? await bridge.docsDriveFolderExportLocal(request, prepared.snapshot.generation,
            localFolderExportFiles(prepared, request.include))
          : await bridge.docsDriveFolderExport(request);
        applyStatus(operation, result);
      } catch (raw) {
        if (!isCurrent(operation)) return;
        const error = failureOf(raw);
        if (error.code === "account_changed" || applyKnownFailure(error)) return;
        if (error.code === "folder_changed" || error.code === "invalid_selection") {
          // 読んだ後にフォルダが変わった。木を読み直し、選び方は要るときだけ変える
          backToInput({});
          void loadPlan({ initial: false, notice: FOLDER_EXPORT_TEXT.folderChanged });
        } else if (error.code === "folder_not_found") {
          backToInput({});
          void loadPlan({ initial: false });
        } else if (error.code === "export_too_large") {
          const tooLarge = tooLargeFrom(error.details, stateRef.current.plan?.limits);
          backToInput(tooLarge ? { tooLarge } : { error: FOLDER_EXPORT_TEXT.unknownFailure });
        } else if (error.code === "folder_export_unavailable") {
          const plan = stateRef.current.plan;
          backToInput(plan ? { plan: { ...plan, available: false } } : {});
        } else if (error.code === "drive_export_rejected") {
          patch({ phase: "pending", busy: null, retryable: true, error: FOLDER_EXPORT_TEXT.rejected });
        } else if (AMBIGUOUS_CODES.has(error.code)) {
          // 作成されたか分からない。新しい受付は作らず、同じ ID の結果を見に行く
          await lookup(operation, tracked, true);
        } else {
          backToInput({ error: FOLDER_EXPORT_TEXT.unknownFailure });
        }
      }
    };

    const resumeBuild = async (operation: Operation, tracked: FolderExportTracked) => {
      patch({ busy: "resume", error: null, attempt: stateRef.current.attempt + 1 });
      try {
        applyStatus(operation, await bridge.docsDriveFolderExportResume(tracked.exportId));
      } catch (raw) {
        if (!isCurrent(operation)) return;
        const error = failureOf(raw);
        if (error.code === "account_changed") return;
        if (error.code === "export_not_resumable") {
          // もう続きを作り始めている・止まり方が変わった。今の状態を見に行く
          await lookup(operation, tracked, false);
        } else {
          const message = error.code === "folder_export_unavailable" ? FOLDER_EXPORT_TEXT.unavailable
            : NETWORK_CODES.has(error.code) ? FOLDER_EXPORT_TEXT.network : FOLDER_EXPORT_TEXT.unknownFailure;
          patch({ busy: null, error: message });
        }
      }
    };

    /** 1 つの受付に対して POST/GET は同時に 1 本だけ。 */
    const run = async (tracked: FolderExportTracked, kind: "post" | "lookup" | "resume") => {
      if (!mountedRef.current || operationRef.current?.active || !ownerRef.current) return;
      const operation: Operation = { exportId: tracked.exportId, generation: generationRef.current, active: true };
      operationRef.current = operation;
      try {
        if (kind === "post" && tracked.request) await post(operation, tracked, tracked.request);
        else if (kind === "resume") await resumeBuild(operation, tracked);
        else await lookup(operation, tracked, false);
      } finally {
        operation.active = false;
        if (isCurrent(operation) && stateRef.current.busy !== null) patch({ busy: null });
      }
    };

    const check = async () => {
      const current = stateRef.current;
      if (!current.tracked || current.phase === "editing" || current.phase === "sending" || current.phase === "completed" ||
        current.googleAccountChanged || current.awaitingReconnect) return;
      // 結果の分からない受付を確かめるには Google の接続が要る（作成中・止まったは要らない）
      if (current.phase === "pending" && !connected()) {
        patch({ recoverOnConnect: true });
        void refreshConnection();
        return;
      }
      await run(current.tracked, "lookup");
    };

    /** 開いているフォルダの書きかけを確定してから、同期状態または LOCAL snapshot を読み直す。 */
    const prepare = (projectId: string, flush: (() => Promise<boolean>) | undefined) => {
      const scope = stateRef.current.scope;
      if (!flush) {
        latest.current.refreshSync(projectId);
        return;
      }
      patch({ preparing: true, prepareFailed: false });
      void flush().catch(() => false).then(async (ok) => {
        if (!mountedRef.current || stateRef.current.scope !== scope) return;
        // 書き残した直後は、同期の状態が書き残す前のまま「済み」に見える。読み直した状態を反映してから書き出せるようにする
        // （先に解除すると、古い状態のまま「書き出す」が有効になり、未同期の編集を含まない旧版を受け付けてしまう）
        await Promise.resolve(latest.current.refreshSync(projectId)).catch(() => undefined);
        if (!mountedRef.current || stateRef.current.scope !== scope) return;
        // LOCAL は同期状態が変わらない。flush 前の snapshot を送らないよう、確定後の木を必ず取り直す。
        if (ok && latest.current.local) await loadPlan({ initial: false });
        if (!mountedRef.current || stateRef.current.scope !== scope) return;
        patch({ preparing: false, prepareFailed: !ok });
      });
    };

    const open = (target: FolderExportTarget & { prepare?: () => Promise<boolean> }) => {
      if (!mountedRef.current) return;
      const { projectId, folderName } = target;
      const scope = scopeOf(ownerRef.current, projectId);
      let current = stateRef.current;
      if (current.scope !== scope) {
        // 別のフォルダ（か本人）。前の表示と進んでいる操作の結果は出さない（写しは残すので、戻れば続きから出す）
        operationRef.current = null;
        planSeq.current += 1;
        autoChecks.current = null;
        localPreparedRef.current = null;
        current = freshState(scope, null, latest.current.defaultTimestamps);
      }
      current = { ...current, target: { projectId, folderName }, confirmRestart: false };
      lastSync.current = latest.current.syncState(projectId);
      if (!ownerRef.current) {
        commit({ ...current, visible: true });
        return;
      }
      const cloudReady = lastSync.current !== "unavailable";
      if (current.tracked) {
        commit({ ...current, visible: true, notice: null });
        // 「新しく書き出す」のときの入力のために木を新しくしておく（表示は今の受付のまま）
        if (cloudReady) void loadPlan({ initial: false });
        if (current.phase === "pending" || current.phase === "building") void check();
      } else {
        const timestamps = current.timestampsTouched ? current.timestamps : latest.current.defaultTimestamps;
        commit({ ...current, visible: true, phase: "editing", error: null, notice: null, titleError: null, tooLarge: null, timestamps });
        if (cloudReady) void loadPlan({ initial: true });
      }
      prepare(projectId, target.prepare);
      void refreshConnection();
    };

    const restartNow = () => {
      const current = stateRef.current;
      if (!current.tracked) return;
      dismissedRef.current.add(current.tracked.exportId);
      forgetReceipt();
      operationRef.current = null;
      commit({
        ...current, ...SETTLED, phase: "editing", tracked: null, status: null, busy: null, notice: null, tooLarge: null, retryAfterMs: null,
        confirmRestart: false,
      });
      if (current.target && latest.current.syncState(current.target.projectId) !== "unavailable") void loadPlan({ initial: false });
    };

    const api = {
      refreshConnection,
      open,
      check,
      close() {
        patch({ visible: false, confirmRestart: false });
      },
      reload() {
        void loadPlan({ initial: !stateRef.current.tracked && stateRef.current.planStatus === "failed" });
      },
      setTitle(title: string) {
        if (!stateRef.current.tracked) patch({ title, titleTouched: true, titleError: null });
      },
      toggle(key: string, checked: boolean) {
        const current = stateRef.current;
        if (current.tracked || !current.plan) return;
        patch({ selected: toggleFolderExportSelection(current.plan.nodes, current.selected, key, checked), tooLarge: null, error: null });
      },
      setTimestamps(value: boolean) {
        if (!stateRef.current.tracked) patch({ timestamps: value, timestampsTouched: true, tooLarge: null, error: null });
      },
      async submit() {
        const current = stateRef.current;
        const projectId = current.target?.projectId;
        if (!projectId || current.tracked || operationRef.current?.active) return;
        const form = formOf(current, unsavedNow(), connected());
        if (!form.canSubmit || !current.plan) return;
        const title = current.title.trim();
        if (title.length > 200) {
          patch({ titleError: FOLDER_EXPORT_TEXT.titleInvalid });
          return;
        }
        const request: DocsDriveFolderExportRequest = {
          exportId: freshId(),
          projectId,
          revision: current.plan.revision,
          title,
          include: folderExportInclude(current.plan.nodes, current.selected),
          timestamps: form.showTimestamps && current.timestamps,
        };
        const receiptEmail = normalizedEmail(connectionRef.current?.connectedEmail);
        // 応答が失われても、同じ ID で照会・再送できるように写しを先に置く（メモリだけ。1 ページの書き出しと同じ）
        receiptsRef.current.set(projectId, { request, receiptEmail, savedAt: Date.now() });
        const tracked = { exportId: request.exportId, request, receiptEmail };
        autoChecks.current = { exportId: request.exportId, count: 0 };
        patch({ ...SETTLED, phase: "sending", tracked, status: null, title, titleError: null, notice: null, tooLarge: null });
        await run(tracked, "post");
      },
      async retry() {
        const current = stateRef.current;
        if (!current.tracked?.request || !current.retryable || current.phase !== "pending" || current.googleAccountChanged ||
          current.awaitingReconnect || !connected()) return;
        await run(current.tracked, "post");
      },
      async resume() {
        const current = stateRef.current;
        if (!current.tracked || current.phase !== "failed" || current.status?.status !== "failed" || !current.status.resumable) return;
        await run(current.tracked, "resume");
      },
      restart() {
        const current = stateRef.current;
        if (!current.tracked) return;
        // 完了の後は確認なしで入力に戻る。完了していない書き出しがあるときだけ確かめる（design-guide-docs.md §5.1）
        if (current.phase === "completed") restartNow();
        else patch({ confirmRestart: true });
      },
      cancelRestart() {
        patch({ confirmRestart: false });
      },
      confirmRestart() {
        if (stateRef.current.confirmRestart) restartNow();
      },
      async openResult() {
        const current = stateRef.current;
        if (current.status?.status !== "completed") return;
        const { documentId } = current.status;
        const scope = current.scope;
        try {
          await bridge.docsDriveOpenDocument(documentId);
        } catch {
          const now = stateRef.current;
          if (now.scope === scope && now.status?.status === "completed" && now.status.documentId === documentId) {
            patch({ error: FOLDER_EXPORT_TEXT.openFailed });
          }
        }
      },
      goToSettings() {
        setResumeAfterConnect(true);
        patch({ visible: false, confirmRestart: false });
        latest.current.onOpenSettings();
      },
    };
    return { api, applyConnection, loadPlan };
  }, [bridge]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      planSeq.current += 1;
      operationRef.current = null;
    };
  }, []);

  // NIHO の本人が変わったら、前の本人の状態・写し・やめた書き出しを捨てる（useGoogleDocs の owner・generation の守りと同じ作り）
  useEffect(() => {
    if (previousOwnerRef.current === owner) return;
    const firstSignIn = previousOwnerRef.current === null && owner !== null;
    previousOwnerRef.current = owner;
    generationRef.current += 1;
    operationRef.current = null;
    planSeq.current += 1;
    autoChecks.current = null;
    receiptsRef.current = new Map();
    localPreparedRef.current = null;
    dismissedRef.current = new Set();
    const before = stateRef.current;
    // 初めてのログインでは、開こうとしていたフォルダと「設定へ進む」から戻る印を残す（ログインの前は何も受け付けていない）
    const keep = firstSignIn ? before.target : null;
    const next = freshState(scopeOf(owner, keep?.projectId ?? null), keep, latest.current.defaultTimestamps);
    stateRef.current = next;
    setState(next);
    if (!firstSignIn) setResumeAfterConnect(false);
    else if (keep && before.visible) actions.api.open(keep);
  }, [actions, owner]);

  // 本人が変わった直後の描画でも、前の本人の状態は出さない
  const ownerMatches = previousOwnerRef.current === owner;
  const shown = ownerMatches ? state : freshState(scopeOf(owner, null), null, props.defaultTimestamps);
  const connection = ownerMatches ? googleDocs.connection : null;
  const connectedNow = connection?.status === "CONNECTED";
  const exportId = shown.tracked?.exportId ?? null;
  const sync = shown.target ? props.syncState(shown.target.projectId) : null;
  const unsaved = folderExportUnsavedReason(shown, sync, props.local);

  // 接続の変化（useGoogleDocs が確かめ直すたび）を、結果の分からない受付へ当てる
  const previousConnection = useRef<DocsDriveConnection | null>(connection);
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = connection;
    if (previous === connection) return;
    actions.applyConnection(connection, previous);
  }, [actions, connection]);

  // 同期が済んだら木を読み直す（版が進んでいるかもしれない）。同期を始めたら、まだ読んでいない木を読む
  useEffect(() => {
    const before = lastSync.current;
    lastSync.current = sync;
    if (!shown.visible || sync === null || before === null || sync === before || !ownerRef.current) return;
    const current = stateRef.current;
    if (sync === "settled") void actions.loadPlan({ initial: !current.tracked && !current.plan });
    else if (sync === "pending" && before === "unavailable" && !current.plan) void actions.loadPlan({ initial: !current.tracked });
  }, [actions, shown.visible, sync]);

  // 「設定へ進む」から戻った: 接続できたら同じフォルダのダイアログを開き直す
  useEffect(() => {
    if (!resumeAfterConnect || !connectedNow || !shown.target) return;
    setResumeAfterConnect(false);
    actions.api.open(shown.target);
  }, [actions, connectedNow, resumeAfterConnect, shown.target]);

  useEffect(() => {
    if (!shown.visible || !shown.recoverOnConnect || !exportId || !connectedNow) return;
    void actions.api.check();
  }, [actions, connectedNow, exportId, shown.recoverOnConnect, shown.visible]);

  // 作成中は、ダイアログを開いている間だけ 3 秒ごと（Retry-After があればそれ）に照会する
  const polling = shown.visible && shown.phase === "building" && shown.busy === null;
  useEffect(() => {
    if (!polling || !exportId) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== "visible" || navigator.onLine === false) return;
      void actions.api.check();
    }, shown.retryAfterMs ?? FOLDER_EXPORT_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [actions, exportId, polling, shown.attempt, shown.retryAfterMs]);

  // 結果の分からない受付（再送できない）は、開いている間だけ間隔を空けて最大 5 回照会する
  const waiting = shown.visible && shown.phase === "pending" && !shown.retryable && !shown.awaitingReconnect && !shown.googleAccountChanged &&
    connectedNow && shown.busy === null;
  useEffect(() => {
    if (!waiting || !exportId) return;
    if (autoChecks.current?.exportId !== exportId) autoChecks.current = { exportId, count: 0 };
    const counter = autoChecks.current;
    const delay = FOLDER_EXPORT_AUTO_CHECK_DELAYS_MS[counter.count];
    if (delay === undefined) return;
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== "visible" || navigator.onLine === false) return;
      counter.count += 1;
      void actions.api.check();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [actions, exportId, waiting, shown.attempt]);

  // 通信の復帰・窓への復帰でも確かめる（まとめて 1 回）
  const listening = shown.visible && (shown.phase === "building" ||
    (shown.phase === "pending" && !shown.retryable && !shown.awaitingReconnect && !shown.googleAccountChanged));
  useEffect(() => {
    if (!listening) return;
    let timer: number | undefined;
    const trigger = () => {
      if (document.visibilityState !== "visible" || navigator.onLine === false) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void actions.api.check(); }, EVENT_CHECK_DEBOUNCE_MS);
    };
    window.addEventListener("online", trigger);
    window.addEventListener("focus", trigger);
    document.addEventListener("visibilitychange", trigger);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", trigger);
      window.removeEventListener("focus", trigger);
      document.removeEventListener("visibilitychange", trigger);
    };
  }, [actions, listening]);

  return {
    ...actions.api,
    state: shown,
    form: formOf(shown, unsaved, connectedNow),
    signedIn,
    connection,
    connectionLoading: ownerMatches && googleDocs.connectionLoading,
    connectionFailed: ownerMatches && googleDocs.connectionError !== null,
    sync,
    local: props.local,
  };
}
