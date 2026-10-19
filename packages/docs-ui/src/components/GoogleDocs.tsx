"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { GoogleDocsController } from "../lib/use-google-docs";
import { ConfirmDialog } from "./ConfirmDialog";

export function GoogleDocsConnectionCard(props: { googleDocs: GoogleDocsController }) {
  const { googleDocs } = props;
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const connected = googleDocs.connection?.status === "CONNECTED";
  const needsReconnect = googleDocs.connection?.status === "ERROR";
  const actionBusy = googleDocs.connectionBusy !== null;
  return (
    <>
      <div className="card google-docs-card">
        <div className="ch"><h2>Google ドキュメント</h2></div>
        <div className="cb">
          <div className="google-docs-row">
            <div>
              <h3>書き出し先</h3>
              {!googleDocs.signedIn ? (
                <p className="help">利用するには、上の「NIHO アカウント」からログインしてください。文書の作成と保存はログインなしでも使えます。</p>
              ) : googleDocs.connectionLoading && !googleDocs.connection ? (
                <p className="help">接続を確認しています…</p>
              ) : connected ? (
                <p className="help"><b>{googleDocs.connection?.connectedEmail}</b> に新しい Google ドキュメントを作成します。</p>
              ) : needsReconnect ? (
                <p className="help">Google への接続が切れています。もう一度接続してください。</p>
              ) : (
                <p className="help">本人のGoogleアカウントへ接続すると、文書やページを書き出せます。</p>
              )}
            </div>
            {googleDocs.signedIn && (
              <div className="google-docs-actions">
                {connected ? (
                  <>
                    {googleDocs.connectionError && (
                      <button type="button" className="btn outline sm" disabled={actionBusy || googleDocs.connectionLoading} onClick={() => void googleDocs.refreshConnection()}>
                        再確認
                      </button>
                    )}
                    <button type="button" className="btn ghost sm" disabled={actionBusy} onClick={() => setConfirmDisconnect(true)}>
                      解除
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn primary sm" disabled={actionBusy} onClick={() => void googleDocs.connect()}>
                    {needsReconnect ? "再接続" : "接続"}
                  </button>
                )}
              </div>
            )}
          </div>
          {googleDocs.connectionError && <p className="err google-docs-error">{googleDocs.connectionError}</p>}
        </div>
      </div>
      {confirmDisconnect && (
        <ConfirmDialog
          title="Google ドキュメントの接続を解除しますか？"
          confirmLabel={googleDocs.connectionBusy === "disconnect" ? "解除中…" : "解除"}
          danger
          busy={googleDocs.connectionBusy === "disconnect"}
          onCancel={() => setConfirmDisconnect(false)}
          onConfirm={() => void googleDocs.disconnect().then(() => setConfirmDisconnect(false))}
        >
          <p>このMacからの書き出しができなくなります。作成済みのGoogle ドキュメントは削除されません。</p>
        </ConfirmDialog>
      )}
    </>
  );
}

export function GoogleDocsExportDialog({ googleDocs }: { googleDocs: GoogleDocsController }) {
  const state = googleDocs.exportDialog;
  const titleId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!state?.visible) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [state?.visible]);
  useEffect(() => {
    if (!state?.visible || state.confirmRestart) return;
    const target = !state.frozen ? titleRef.current : dialogRef.current?.querySelector<HTMLElement>("button:not([disabled])");
    (target ?? dialogRef.current)?.focus();
  }, [state?.visible, state?.frozen, state?.confirmRestart, state?.phase]);
  if (!state?.visible) return null;
  if (state.confirmRestart) {
    return (
      <ConfirmDialog
        title="新しいGoogle ドキュメントを作成しますか？"
        confirmLabel="新しく書き出す"
        cancelLabel="結果確認に戻る"
        onCancel={googleDocs.cancelRestartExport}
        onConfirm={googleDocs.confirmRestartExport}
      >
        <p>前の書き出しは、結果を確認できていなくてもGoogle側で作成済みの可能性があります。前の受付の確認をやめて、別の新しい文書を作成します。</p>
      </ConfirmDialog>
    );
  }
  const connected = googleDocs.connection?.status === "CONNECTED";
  const needsConnection = !connected || state.awaitingReconnect;
  const busy = state.phase === "sending" || state.phase === "checking";
  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      googleDocs.closeExport();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) { event.preventDefault(); return; }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const status =
    state.phase === "sending" ? "Google ドキュメントを作成しています…" :
    state.phase === "checking" ? "書き出しの結果を確認しています…" :
    state.phase === "pending" ? "書き出しの結果をまだ確認できていません。" : null;
  return (
    <div className="veil" role="presentation">
      <div ref={dialogRef} tabIndex={-1} className="dlg google-export-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onDialogKeyDown}>
        <h2 id={titleId}>Google ドキュメントへ書き出す</h2>
        <p className="help">現在画面に見えている本文の写しから、新しい文書を1つ作成します。元の文書は変わりません。</p>
        <div className="fld">
          <label htmlFor={`${titleId}-title`}>タイトル</label>
          <input
            ref={titleRef}
            id={`${titleId}-title`}
            className="inp"
            value={state.title}
            disabled={state.frozen !== null}
            onChange={(event) => googleDocs.setExportTitle(event.currentTarget.value)}
          />
        </div>
        {/* 接続先のアカウントはここに出さない。アカウントの操作は設定だけ（owner 2026-10-18・#18920） */}
        {!googleDocs.signedIn && <p className="err">NIHO にログインしてから書き出してください。</p>}
        {googleDocs.signedIn && needsConnection && <p className="err">設定でGoogleアカウントへ接続してください。入力したタイトルと受付情報はそのまま残ります。</p>}
        {status && <p className="google-export-status" role="status">{status}</p>}
        {state.phase === "success" && <p className="google-export-success" role="status">Google ドキュメントを作成しました。</p>}
        {state.error && <p className="err">{state.error}</p>}
        {state.phase === "pending" && state.notReceived && (
          <p className="help">受付が見つかりませんでした。同じ書き出しIDと内容で再試行できます。</p>
        )}
        <div className="acts google-export-actions">
          <button type="button" className="btn outline" disabled={busy} onClick={googleDocs.closeExport}>閉じる</button>
          {(!googleDocs.signedIn || needsConnection) && (
            <button type="button" className="btn primary" onClick={googleDocs.goToSettings}>設定へ進む</button>
          )}
          {googleDocs.signedIn && !needsConnection && !state.frozen && (
            <button type="button" className="btn primary" onClick={() => void googleDocs.submitExport()}>書き出す</button>
          )}
          {state.phase === "pending" && (
            <>
              <button type="button" className="btn outline" disabled={busy} onClick={() => void googleDocs.checkExport()}>結果を確認</button>
              {state.retryable && <button type="button" className="btn primary" disabled={busy} onClick={() => void googleDocs.retryExport()}>同じ内容で再試行</button>}
              <button type="button" className="btn ghost" disabled={busy} onClick={googleDocs.restartExport}>新しい書き出し</button>
            </>
          )}
          {state.phase === "error" && state.frozen && (
            <>
              {!state.googleAccountChanged && !state.awaitingReconnect && connected && (
                <button type="button" className="btn outline" onClick={() => void googleDocs.checkExport()}>結果を確認</button>
              )}
              <button type="button" className="btn ghost" onClick={googleDocs.restartExport}>新しい書き出し</button>
            </>
          )}
          {state.phase === "success" && (
            <button type="button" className="btn primary" onClick={() => void googleDocs.openResult()}>Google ドキュメントを開く</button>
          )}
        </div>
      </div>
    </div>
  );
}
