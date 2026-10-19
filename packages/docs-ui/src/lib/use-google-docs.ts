import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocsAccount as NihoAccount } from "../host/DocsAccount";
import {
  errorMessage,
  isCommandError,
  type Bridge,
  type DocsDriveConnection,
  type DocsDriveExportRequest,
  type DocsDriveExportResult,
} from "./bridge";

export type GoogleExportSnapshot = { sourceKey: string; title: string; markdown: string };
type ExportPhase = "editing" | "sending" | "checking" | "pending" | "success" | "error";

export type GoogleExportDialogState = GoogleExportSnapshot & {
  visible: boolean;
  phase: ExportPhase;
  frozen: DocsDriveExportRequest | null;
  result: Extract<DocsDriveExportResult, { status: "completed" }> | null;
  retryable: boolean;
  notReceived: boolean;
  error: string | null;
  receiptEmail: string | null;
  awaitingReconnect: boolean;
  recoverOnConnect: boolean;
  googleAccountChanged: boolean;
  replacement: GoogleExportSnapshot | null;
  confirmRestart: boolean;
};

export type GoogleDocsController = {
  signedIn: boolean;
  connection: DocsDriveConnection | null;
  connectionLoading: boolean;
  connectionBusy: "connect" | "disconnect" | null;
  connectionError: string | null;
  exportDialog: GoogleExportDialogState | null;
  refreshConnection: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  openExport: (snapshot: GoogleExportSnapshot) => void;
  closeExport: () => void;
  setExportTitle: (title: string) => void;
  submitExport: () => Promise<void>;
  checkExport: () => Promise<void>;
  retryExport: () => Promise<void>;
  restartExport: () => void;
  cancelRestartExport: () => void;
  confirmRestartExport: () => void;
  openResult: () => Promise<void>;
  goToSettings: () => void;
};

type OperationToken = { id: number; owner: string; generation: number };
type ExportOperationToken = OperationToken & { exportId: string; active: boolean };

/** NIHO の本人（ユーザーと接続）。変わったら前の本人の書き出しの状態を捨てる（フォルダの書き出しも同じ鍵を使う）。 */
export function googleDocsOwnerKey(account: NihoAccount): string | null {
  if (account.state?.kind !== "signedIn") return null;
  return `${account.state.profile.userId}:${account.state.profile.connectionId}`;
}

function normalizedEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function validationMessage(title: string, markdown: string): string | null {
  const trimmed = title.trim();
  if (!trimmed || trimmed.length > 200) return "タイトルは1〜200文字にしてください。";
  if (!markdown) return "空の文書は書き出せません。";
  if (markdown.length > 1_000_000 || new TextEncoder().encode(markdown).byteLength > 4 * 1024 * 1024) {
    return "本文が大きすぎます。短くしてから、もう一度お試しください。";
  }
  return null;
}

function freshId(): string {
  return crypto.randomUUID().toLowerCase();
}

function initialDialog(snapshot: GoogleExportSnapshot): GoogleExportDialogState {
  return {
    ...snapshot,
    visible: true,
    phase: "editing",
    frozen: null,
    result: null,
    retryable: false,
    notReceived: false,
    error: null,
    receiptEmail: null,
    awaitingReconnect: false,
    recoverOnConnect: false,
    googleAccountChanged: false,
    replacement: null,
    confirmRestart: false,
  };
}

const AMBIGUOUS_POST_ERRORS = new Set([
  "export_result_unknown",
  "temporarily_unavailable",
  "google_docs_invalid_response",
  "google_docs_failed",
  "network",
]);
const DRIVE_RECONNECT_ERRORS = new Set([
  "drive_not_connected",
  "drive_reconnect_required",
  "drive_connection_changed",
]);

export function useGoogleDocs(props: {
  bridge: Bridge;
  account: NihoAccount;
  onOpenSettings: () => void;
}): GoogleDocsController {
  const { bridge, account, onOpenSettings } = props;
  const signedIn = account.state?.kind === "signedIn";
  const currentOwner = googleDocsOwnerKey(account);
  const ownerRef = useRef(currentOwner);
  ownerRef.current = currentOwner;
  const generationRef = useRef(0);
  const operationSequence = useRef(0);
  const [connection, setConnection] = useState<DocsDriveConnection | null>(null);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState<"connect" | "disconnect" | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [exportDialog, setExportDialog] = useState<GoogleExportDialogState | null>(null);
  const exportDialogRef = useRef(exportDialog);
  exportDialogRef.current = exportDialog;
  const [resumeAfterConnect, setResumeAfterConnect] = useState(false);
  const exportOperation = useRef<ExportOperationToken | null>(null);
  const connectionOperation = useRef<OperationToken | null>(null);
  const connectionRequest = useRef(0);
  const previousOwner = useRef<string | null>(null);

  const operationIsCurrent = useCallback((token: OperationToken) => (
    ownerRef.current === token.owner && generationRef.current === token.generation
  ), []);

  const exportOperationIsCurrent = useCallback((token: ExportOperationToken, state?: GoogleExportDialogState | null) => (
    operationIsCurrent(token)
    && exportOperation.current === token
    && (state ?? exportDialogRef.current)?.frozen?.exportId === token.exportId
  ), [operationIsCurrent]);

  const updateExport = useCallback((token: ExportOperationToken, update: (state: GoogleExportDialogState) => GoogleExportDialogState) => {
    setExportDialog((current) => exportOperationIsCurrent(token, current) && current ? update(current) : current);
  }, [exportOperationIsCurrent]);

  const applyConnection = useCallback((next: DocsDriveConnection) => {
    const nextEmail = next.status === "CONNECTED" ? normalizedEmail(next.connectedEmail) : null;
    const receiptEmail = exportDialogRef.current?.receiptEmail;
    if (next.status !== "CONNECTED" || (receiptEmail && nextEmail !== receiptEmail)) {
      exportOperation.current = null;
    }
    connectionRef.current = next;
    setConnection(next);
    setExportDialog((current) => {
      if (!current?.frozen) return current;
      if (next.status !== "CONNECTED") {
        return {
          ...current,
          phase: "error",
          result: null,
          retryable: false,
          error: "Google ドキュメントへ再接続して、同じ受付の結果を確認してください。",
          awaitingReconnect: true,
          recoverOnConnect: false,
          googleAccountChanged: false,
          confirmRestart: false,
        };
      }
      if (current.receiptEmail && nextEmail !== current.receiptEmail) {
        return {
          ...current,
          phase: "error",
          result: null,
          retryable: false,
          error: "接続先のGoogleアカウントが変わりました。前の受付はこのアカウントでは確認できません。",
          awaitingReconnect: false,
          recoverOnConnect: false,
          googleAccountChanged: true,
          confirmRestart: false,
        };
      }
      if (current.awaitingReconnect || current.googleAccountChanged) {
        return {
          ...current,
          phase: "pending",
          result: null,
          error: null,
          awaitingReconnect: false,
          recoverOnConnect: true,
          googleAccountChanged: false,
        };
      }
      return current;
    });
  }, []);

  const refreshConnection = useCallback(async () => {
    const requestedOwner = ownerRef.current;
    const requestedGeneration = generationRef.current;
    if (!requestedOwner || connectionOperation.current) return;
    const request = ++connectionRequest.current;
    setConnectionLoading(true);
    setConnectionError(null);
    try {
      const next = await bridge.docsDriveConnection();
      if (ownerRef.current !== requestedOwner || generationRef.current !== requestedGeneration || connectionRequest.current !== request) return;
      applyConnection(next);
    } catch (error) {
      if (ownerRef.current !== requestedOwner || generationRef.current !== requestedGeneration || connectionRequest.current !== request) return;
      setConnectionError(errorMessage(error, "Google ドキュメントの接続を確認できませんでした。"));
    } finally {
      if (ownerRef.current === requestedOwner && generationRef.current === requestedGeneration && connectionRequest.current === request) {
        setConnectionLoading(false);
      }
    }
  }, [applyConnection, bridge]);

  useEffect(() => {
    if (previousOwner.current === currentOwner) return;
    const firstOwnerSignIn = previousOwner.current === null && currentOwner !== null;
    previousOwner.current = currentOwner;
    generationRef.current += 1;
    connectionRequest.current += 1;
    connectionOperation.current = null;
    exportOperation.current = null;
    setConnection(null);
    connectionRef.current = null;
    setConnectionError(null);
    setConnectionLoading(false);
    setConnectionBusy(null);
    if (!firstOwnerSignIn) {
      setExportDialog(null);
      setResumeAfterConnect(false);
    }
    if (currentOwner) void refreshConnection();
  }, [currentOwner, refreshConnection]);

  useEffect(() => {
    const onFocus = () => {
      if (ownerRef.current) void refreshConnection();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshConnection]);

  useEffect(() => {
    if (resumeAfterConnect && connection?.status === "CONNECTED" && exportDialog) {
      setResumeAfterConnect(false);
      setExportDialog((current) => (current ? { ...current, visible: true } : null));
    }
  }, [connection, exportDialog, resumeAfterConnect]);

  const beginConnectionOperation = useCallback((): OperationToken | null => {
    const owner = ownerRef.current;
    if (!owner || connectionOperation.current) return null;
    connectionRequest.current += 1;
    setConnectionLoading(false);
    const token = { id: ++operationSequence.current, owner, generation: generationRef.current };
    connectionOperation.current = token;
    return token;
  }, []);

  const connect = useCallback(async () => {
    const token = beginConnectionOperation();
    if (!token) return;
    setConnectionBusy("connect");
    setConnectionError(null);
    try {
      await bridge.docsDriveConnect();
    } catch (error) {
      if (operationIsCurrent(token) && connectionOperation.current === token) {
        setConnectionError(errorMessage(error, "Google の接続画面を開けませんでした。"));
      }
    } finally {
      if (operationIsCurrent(token) && connectionOperation.current === token) {
        connectionOperation.current = null;
        setConnectionBusy(null);
      }
    }
  }, [beginConnectionOperation, bridge, operationIsCurrent]);

  const disconnect = useCallback(async () => {
    const token = beginConnectionOperation();
    if (!token) return;
    setConnectionBusy("disconnect");
    setConnectionError(null);
    try {
      const next = await bridge.docsDriveDisconnect();
      if (operationIsCurrent(token) && connectionOperation.current === token) applyConnection(next);
    } catch (error) {
      if (operationIsCurrent(token) && connectionOperation.current === token) {
        setConnectionError(errorMessage(error, "Google ドキュメントの接続を解除できませんでした。"));
      }
    } finally {
      if (operationIsCurrent(token) && connectionOperation.current === token) {
        connectionOperation.current = null;
        setConnectionBusy(null);
      }
    }
  }, [applyConnection, beginConnectionOperation, bridge, operationIsCurrent]);

  const openExport = useCallback((snapshot: GoogleExportSnapshot) => {
    setResumeAfterConnect(false);
    setExportDialog((current) => current?.frozen && current.phase !== "success"
      ? { ...current, visible: true, replacement: snapshot, confirmRestart: false }
      : initialDialog(snapshot));
  }, []);

  const beginExportOperation = useCallback((frozen: DocsDriveExportRequest): ExportOperationToken | null => {
    const owner = ownerRef.current;
    if (!owner || exportOperation.current?.active || connectionRef.current?.status !== "CONNECTED") return null;
    const token = {
      id: ++operationSequence.current,
      owner,
      generation: generationRef.current,
      exportId: frozen.exportId,
      active: true,
    };
    exportOperation.current = token;
    return token;
  }, []);

  const finishExportOperation = useCallback((token: ExportOperationToken) => {
    if (exportOperationIsCurrent(token)) token.active = false;
  }, [exportOperationIsCurrent]);

  const applyExportResult = useCallback((result: DocsDriveExportResult, token: ExportOperationToken) => {
    updateExport(token, (current) => result.status === "completed"
      ? {
          ...current,
          phase: "success",
          result,
          retryable: false,
          notReceived: false,
          error: null,
          recoverOnConnect: false,
        }
      : {
          ...current,
          phase: "pending",
          result: null,
          retryable: result.retryable,
          notReceived: false,
          error: null,
          recoverOnConnect: false,
        });
  }, [updateExport]);

  const lookup = useCallback(async (frozen: DocsDriveExportRequest, token: ExportOperationToken, fromUnknown = false) => {
    if (!exportOperationIsCurrent(token) || connectionRef.current?.status !== "CONNECTED") return;
    updateExport(token, (current) => ({ ...current, phase: "checking", error: null, recoverOnConnect: false }));
    try {
      const result = await bridge.docsDriveExportStatus(frozen.exportId);
      if (exportOperationIsCurrent(token)) applyExportResult(result, token);
    } catch (error) {
      if (!exportOperationIsCurrent(token)) return;
      if (isCommandError(error) && error.code === "export_not_found") {
        updateExport(token, (current) => ({
          ...current,
          phase: "pending",
          retryable: true,
          notReceived: true,
          error: null,
        }));
        return;
      }
      if (isCommandError(error) && DRIVE_RECONNECT_ERRORS.has(error.code)) {
        updateExport(token, (current) => ({
          ...current,
          phase: "error",
          result: null,
          retryable: false,
          notReceived: false,
          awaitingReconnect: true,
          recoverOnConnect: false,
          error: errorMessage(error, "Google ドキュメントへ再接続してください。"),
        }));
        void refreshConnection();
        return;
      }
      updateExport(token, (current) => ({
        ...current,
        phase: fromUnknown ? "pending" : "error",
        retryable: fromUnknown ? false : current.retryable,
        error: errorMessage(error, "書き出しの結果を確認できませんでした。"),
      }));
    }
  }, [applyExportResult, bridge, exportOperationIsCurrent, refreshConnection, updateExport]);

  const post = useCallback(async (frozen: DocsDriveExportRequest, token: ExportOperationToken) => {
    if (!exportOperationIsCurrent(token) || connectionRef.current?.status !== "CONNECTED") return;
    updateExport(token, (current) => ({ ...current, phase: "sending", error: null }));
    try {
      const result = await bridge.docsDriveExport(frozen);
      if (exportOperationIsCurrent(token)) applyExportResult(result, token);
    } catch (error) {
      if (!exportOperationIsCurrent(token)) return;
      if (!isCommandError(error) || AMBIGUOUS_POST_ERRORS.has(error.code)) {
        await lookup(frozen, token, true);
        return;
      }
      if (DRIVE_RECONNECT_ERRORS.has(error.code)) {
        updateExport(token, (current) => ({
          ...current,
          phase: "error",
          result: null,
          retryable: false,
          awaitingReconnect: true,
          error: errorMessage(error, "Google ドキュメントへ再接続してください。"),
        }));
        void refreshConnection();
        return;
      }
      updateExport(token, (current) => ({
        ...current,
        phase: "error",
        error: errorMessage(error, "Google ドキュメントへ書き出せませんでした。"),
      }));
    }
  }, [applyExportResult, bridge, exportOperationIsCurrent, lookup, refreshConnection, updateExport]);

  const submitExport = useCallback(async () => {
    const current = exportDialogRef.current;
    if (!current || current.frozen || !ownerRef.current || connectionRef.current?.status !== "CONNECTED") return;
    const validation = validationMessage(current.title, current.markdown);
    if (validation) {
      setExportDialog({ ...current, phase: "error", error: validation });
      return;
    }
    const frozen = { exportId: freshId(), title: current.title.trim(), markdown: current.markdown };
    const receiptEmail = normalizedEmail(connectionRef.current.connectedEmail);
    const next = { ...current, frozen, title: frozen.title, receiptEmail, error: null };
    exportDialogRef.current = next;
    setExportDialog(next);
    const token = beginExportOperation(frozen);
    if (!token) return;
    try {
      await post(frozen, token);
    } finally {
      finishExportOperation(token);
    }
  }, [beginExportOperation, finishExportOperation, post]);

  const checkExport = useCallback(async () => {
    const current = exportDialogRef.current;
    if (!current?.frozen || current.googleAccountChanged || current.awaitingReconnect) return;
    const token = beginExportOperation(current.frozen);
    if (!token) return;
    try {
      await lookup(current.frozen, token);
    } finally {
      finishExportOperation(token);
    }
  }, [beginExportOperation, finishExportOperation, lookup]);

  const retryExport = useCallback(async () => {
    const current = exportDialogRef.current;
    if (!current?.frozen || !current.retryable || current.googleAccountChanged || current.awaitingReconnect) return;
    const token = beginExportOperation(current.frozen);
    if (!token) return;
    try {
      await post(current.frozen, token);
    } finally {
      finishExportOperation(token);
    }
  }, [beginExportOperation, finishExportOperation, post]);

  useEffect(() => {
    if (connection?.status !== "CONNECTED" || !exportDialog?.recoverOnConnect || !exportDialog.frozen) return;
    setExportDialog((current) => current ? { ...current, recoverOnConnect: false, visible: true } : current);
    void checkExport();
  }, [checkExport, connection?.status, exportDialog?.frozen, exportDialog?.recoverOnConnect]);

  const openResult = useCallback(async () => {
    const current = exportDialogRef.current;
    const requestedOwner = ownerRef.current;
    const requestedGeneration = generationRef.current;
    if (!current?.result || !requestedOwner || connectionRef.current?.status !== "CONNECTED") return;
    const documentId = current.result.documentId;
    try {
      await bridge.docsDriveOpenDocument(documentId);
    } catch (error) {
      if (ownerRef.current !== requestedOwner || generationRef.current !== requestedGeneration) return;
      setExportDialog((latest) => latest && latest.result?.documentId === documentId
        ? { ...latest, error: errorMessage(error, "Google ドキュメントを開けませんでした。") }
        : latest);
    }
  }, [bridge]);

  // Mask the previous owner's state during the render before the reset effect runs.
  const ownerMatches = previousOwner.current === currentOwner;
  return useMemo(() => ({
    signedIn,
    connection: ownerMatches ? connection : null,
    connectionLoading: ownerMatches && connectionLoading,
    connectionBusy: ownerMatches ? connectionBusy : null,
    connectionError: ownerMatches ? connectionError : null,
    exportDialog: ownerMatches ? exportDialog : null,
    refreshConnection,
    connect,
    disconnect,
    openExport,
    closeExport: () => setExportDialog((current) => current ? { ...current, visible: false, confirmRestart: false } : null),
    setExportTitle: (title: string) => setExportDialog((current) => current && !current.frozen
      ? { ...current, title, phase: "editing", error: null }
      : current),
    submitExport,
    checkExport,
    retryExport,
    restartExport: () => setExportDialog((current) => current?.frozen
      ? { ...current, confirmRestart: true }
      : current),
    cancelRestartExport: () => setExportDialog((current) => current
      ? { ...current, confirmRestart: false }
      : current),
    confirmRestartExport: () => setExportDialog((current) => {
      if (!current?.frozen) return current;
      return initialDialog(current.replacement ?? {
        sourceKey: current.sourceKey,
        title: current.title,
        markdown: current.markdown,
      });
    }),
    openResult,
    goToSettings: () => {
      setResumeAfterConnect(true);
      setExportDialog((current) => current ? { ...current, visible: false, confirmRestart: false } : null);
      onOpenSettings();
    },
  }), [
    currentOwner, ownerMatches, signedIn, connection, connectionLoading, connectionBusy, connectionError, exportDialog, refreshConnection, connect,
    disconnect, openExport, submitExport, checkExport, retryExport, openResult, onOpenSettings,
  ]);
}
