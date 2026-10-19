"use client";

import { FeatureToggleSwitch } from "niho-ui/components/feature-toggle-switch";
import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  FOLDER_EXPORT_RESTART_CONFIRM,
  FOLDER_EXPORT_TEXT,
  folderExportBudgetText,
  folderExportBuildingText,
  folderExportFailureText,
  folderExportImagesSkippedText,
  folderExportNodeChars,
  folderExportRows,
  formatFolderExportChars,
} from "../lib/google-docs-folder-export";
import type { GoogleDocsFolderExportController } from "../lib/use-google-docs-folder-export";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * フォルダの書き出し（#18838）のダイアログ。外枠・focus の閉じ込め・Esc・ボタンの並びは 1 ページの書き出しのダイアログ
 * （GoogleDocs.tsx の GoogleDocsExportDialog）と同じ作りにし、木が長いときは中だけを送ってボタンの行を下に残す。
 * 文は design-guide-docs.md §5.1（Web のシートと同じ文）。状態はトーストにせず、ダイアログの中の 1 行で出す。
 */
export function GoogleDocsFolderExportDialog({ controller }: { controller: GoogleDocsFolderExportController }) {
  const { state, form, connection } = controller;
  const headingId = useId();
  const titleId = useId();
  const titleErrorId = useId();
  const timestampsId = useId();
  const reasonId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!state.visible) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [state.visible]);
  // 開いた直後は木をまだ読んでいる。入力欄ではなくダイアログ自体へ focus を置き、中身が替わっても focus を失わない
  useEffect(() => {
    if (!state.visible || state.confirmRestart) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
  });
  if (!state.visible) return null;
  if (state.confirmRestart) {
    return (
      <ConfirmDialog
        title={FOLDER_EXPORT_RESTART_CONFIRM.title}
        confirmLabel={FOLDER_EXPORT_RESTART_CONFIRM.confirmLabel}
        onCancel={controller.cancelRestart}
        onConfirm={controller.confirmRestart}
      >
        <p>{FOLDER_EXPORT_RESTART_CONFIRM.description}</p>
      </ConfirmDialog>
    );
  }

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      controller.close();
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

  const busy = state.busy !== null;
  const connected = connection?.status === "CONNECTED";
  const { plan, tracked } = state;
  const close = <button type="button" className="btn outline" onClick={controller.close}>閉じる</button>;
  const settings = <button type="button" className="btn primary" onClick={controller.goToSettings}>設定へ進む</button>;
  const restart = <button type="button" className="btn ghost" disabled={busy} onClick={controller.restart}>新しく書き出す</button>;
  const loadingLine = <p className="google-export-status" role="status">{FOLDER_EXPORT_TEXT.loading}</p>;
  const unsavedLine = <p className="folder-export-reason">{controller.local ? FOLDER_EXPORT_TEXT.localUnsaved : FOLDER_EXPORT_TEXT.unsaved}</p>;
  const actions = (children: ReactNode) => <div className="acts google-export-actions">{close}{children}</div>;

  let body: ReactNode;
  if (!controller.signedIn) {
    body = <>
      <p className="err">{FOLDER_EXPORT_TEXT.signedOut}</p>
      {actions(settings)}
    </>;
  } else if (tracked) {
    const { status } = state;
    body = <>
      {tracked.request && (
        <div className="google-export-account">
          <span>タイトル</span>
          <b>{tracked.request.title}</b>
        </div>
      )}
      {state.phase === "sending" && <p className="google-export-status" role="status">{FOLDER_EXPORT_TEXT.sending}</p>}
      {state.phase === "pending" && (
        <div className="google-export-status folder-export-lines" role="status">
          <p><b>{FOLDER_EXPORT_TEXT.pending}</b></p>
          {state.notReceived && <p>{FOLDER_EXPORT_TEXT.notReceived}</p>}
          {state.error && <p className="err">{state.error}</p>}
        </div>
      )}
      {state.phase === "building" && status?.status === "building" && (
        <div className="google-export-status folder-export-lines" role="status">
          <p><b>{folderExportBuildingText(status.progress)}</b></p>
          <p>{FOLDER_EXPORT_TEXT.buildingNote}</p>
          {state.error && <p className="err">{state.error}</p>}
        </div>
      )}
      {state.phase === "completed" && status?.status === "completed" && (
        <div className="folder-export-lines" role="status">
          <p className="google-export-success">{FOLDER_EXPORT_TEXT.completed}</p>
          {status.imagesSkipped > 0 && <p className="help">{folderExportImagesSkippedText(status.imagesSkipped)}</p>}
        </div>
      )}
      {state.phase === "completed" && state.error && <p className="err" role="alert">{state.error}</p>}
      {state.phase === "failed" && status?.status === "failed" && (
        <div className="folder-export-lines">
          <p className="err folder-export-failed" role="alert">{folderExportFailureText(status.reason)}</p>
          {state.error && <p className="err" role="alert">{state.error}</p>}
        </div>
      )}
      {state.phase === "error" && state.error && <p className="err" role="alert">{state.error}</p>}
      {actions(<>
        {state.phase === "pending" && <>
          <button type="button" className="btn outline" disabled={busy} onClick={() => void controller.check()}>結果を確認</button>
          {state.retryable && <button type="button" className="btn primary" disabled={busy} onClick={() => void controller.retry()}>同じ内容で再試行</button>}
          {restart}
        </>}
        {state.phase === "completed" && <>
          <button type="button" className="btn primary" onClick={() => void controller.openResult()}>Google ドキュメントを開く</button>
          {restart}
        </>}
        {state.phase === "failed" && <>
          {status?.status === "failed" && status.resumable && (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void controller.resume()}>続きから作る</button>
          )}
          {restart}
        </>}
        {state.phase === "error" && <>
          {state.awaitingReconnect && settings}
          {!state.awaitingReconnect && !state.googleAccountChanged && (
            <button type="button" className="btn outline" disabled={busy} onClick={() => void controller.check()}>結果を確認</button>
          )}
          {restart}
        </>}
      </>)}
    </>;
  } else if (controller.sync === "unavailable") {
    // 保存先と現在のアカウントが一致しない。
    body = <><p className="folder-export-reason">{FOLDER_EXPORT_TEXT.notInCloud}</p>{actions(null)}</>;
  } else if (state.planStatus === "idle" || state.planStatus === "loading") {
    body = <>{loadingLine}{actions(null)}</>;
  } else if (state.planStatus === "failed" || !plan) {
    // 同期の途中ならクラウドにまだ無いだけ（同期が済むと読み直す）
    body = form.blockedReason === (controller.local ? FOLDER_EXPORT_TEXT.localUnsaved : FOLDER_EXPORT_TEXT.unsaved) ? <>{unsavedLine}{actions(null)}</> : <>
      <p className="err" role="alert">{FOLDER_EXPORT_TEXT.loadFailed}</p>
      {actions(<button type="button" className="btn outline" onClick={controller.reload}>読み直す</button>)}
    </>;
  } else if (!connection && controller.connectionFailed) {
    body = <>
      <p className="err" role="alert">{FOLDER_EXPORT_TEXT.connectionCheckFailed}</p>
      {actions(<button type="button" className="btn outline" disabled={controller.connectionLoading} onClick={() => void controller.refreshConnection()}>接続を確認</button>)}
    </>;
  } else if (!connection) {
    // 木と接続を並行して確かめる。文を掛け替えないよう、どちらを待つ間も同じ 1 行にする
    body = <>{loadingLine}{actions(null)}</>;
  } else if (!connected) {
    body = <>
      <p className="help">{connection.status === "ERROR" ? FOLDER_EXPORT_TEXT.connectionLost : FOLDER_EXPORT_TEXT.notConnected}</p>
      {!plan.available && <p className="help">{FOLDER_EXPORT_TEXT.unavailable}</p>}
      {actions(settings)}
    </>;
  } else {
    const timestampsOn = form.showTimestamps && state.timestamps;
    body = (
      <form className="folder-export-form" onSubmit={(event) => { event.preventDefault(); void controller.submit(); }}>
        {/* 木が長いときはここだけを送る（目安とボタンの行は下に残す） */}
        <div className="folder-export-scroll">
          <div className="fld">
            <label htmlFor={titleId}>タイトル</label>
            <input
              id={titleId}
              className="inp"
              value={state.title}
              aria-invalid={state.titleError ? true : undefined}
              aria-describedby={state.titleError ? titleErrorId : undefined}
              onChange={(event) => controller.setTitle(event.currentTarget.value)}
            />
            {state.titleError && <p id={titleErrorId} className="err" role="alert">{state.titleError}</p>}
          </div>
          {/* 書き出し先のアカウントはここに出さない。アカウントの操作は設定だけ（owner 2026-10-18・#18920） */}
          <fieldset className="folder-export-tree">
            <legend>入れるページ</legend>
            <ul>
              {folderExportRows(plan.nodes).map(({ node, depth }) => (
                <li key={node.key}>
                  {/* 行全体を押せる。題名は折り返し、チェックと字数は欠けない */}
                  <label className={`folder-export-row${depth > 0 ? " child" : ""}`}>
                    <input type="checkbox" checked={state.selected.has(node.key)} onChange={(event) => controller.toggle(node.key, event.currentTarget.checked)} />
                    <span className="t">{node.title}</span>
                    <span className="n">{formatFolderExportChars(folderExportNodeChars(node, timestampsOn))}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          {form.showTimestamps && (
            <div className="folder-export-toggle">
              <label htmlFor={timestampsId}>タイムスタンプ</label>
              <FeatureToggleSwitch
                id={timestampsId}
                checked={state.timestamps}
                disabled={false}
                size="sm"
                onChange={controller.setTimestamps}
                ariaLabel="タイムスタンプ"
                className="docs-feature-toggle-switch"
                thumbClassName="docs-feature-toggle-switch__thumb"
              />
            </div>
          )}
        </div>
        <div className="folder-export-foot">
          {form.measure && <p className="folder-export-budget">{folderExportBudgetText(form.measure, plan.limits)}</p>}
          {form.overLimit.length > 0 && (
            <div className="err" role="alert">
              {form.overLimit.map((text) => <p key={text}>{text}</p>)}
            </div>
          )}
          {state.planStatus === "reloading" && loadingLine}
          {state.planStatus === "reloadFailed" && (
            <div className="folder-export-lines">
              <p className="err" role="alert">{FOLDER_EXPORT_TEXT.loadFailed}</p>
              <button type="button" className="btn ghost sm" onClick={controller.reload}>読み直す</button>
            </div>
          )}
          {state.notice && state.planStatus === "loaded" && <p className="folder-export-reason" role="status">{state.notice}</p>}
          {form.blockedReason && <p id={reasonId} className="folder-export-reason">{form.blockedReason}</p>}
          {state.error && <p className="err" role="alert">{state.error}</p>}
          {actions(
            <button type="submit" className="btn primary" disabled={!form.canSubmit} aria-describedby={form.blockedReason ? reasonId : undefined}>
              書き出す
            </button>,
          )}
        </div>
      </form>
    );
  }

  return (
    <div className="veil" role="presentation">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="dlg google-export-dialog folder-export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onKeyDown={onDialogKeyDown}
      >
        <h2 id={headingId}>{FOLDER_EXPORT_TEXT.title}</h2>
        <p className="help">{FOLDER_EXPORT_TEXT.description}</p>
        {controller.local && <p className="help">{FOLDER_EXPORT_TEXT.localTransitNotice}</p>}
        {body}
      </div>
    </div>
  );
}
