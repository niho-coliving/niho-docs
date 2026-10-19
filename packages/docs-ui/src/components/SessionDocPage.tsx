"use client";

import { useState, useSyncExternalStore } from "react";
import type { DocsDocumentSession, DocsDocumentActions } from "../host/DocsWorkspaceHost";
import { ConfirmDialog } from "./ConfirmDialog";
import { PageMenu, PageTop } from "./PageTop";
import { BlockEditor } from "./BlockEditor";
import { DocumentPaper, updatedLabel } from "./DocPage";
import { DocIcon } from "./icons";
import { SessionTitle } from "./SessionMetadata";
import { PageTitle } from "./PageTitle";
import { useDocEditor } from "./useDocEditor";

/** 文書 session の保存先に依存しない描画。保存・CAS・下書きの処理は host が持つ。 */
export function SessionDocPage({ session, actions, busy = false }: { session: DocsDocumentSession; actions?: DocsDocumentActions; busy?: boolean }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [compare, setCompare] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const editor = useDocEditor({
    documentKey: session.key, markdown: state.markdown,
    editable: !busy && !state.recovery && !state.conflict && state.phase !== "unconfirmed",
    onChange: session.edit, resolveAsset: session.resolveAsset,
  });
  const text = state.recovery ? "入力の復元を確認してください" : ({ saved: "クラウドに保存済み", dirty: "未保存の変更", saving: "保存中", unconfirmed: "保存結果を確認できていません", conflict: "変更の確認が必要", failed: "保存できませんでした。入力は残しています。" })[state.phase];
  return <DocumentPaper>
    {actions && <PageTop><PageMenu disabled={busy} first={actions.first} last={actions.last} folders={actions.folders} currentProjectId={actions.currentProjectId} onMove={actions.onMove ? (target) => void actions.onMove!(target) : undefined} onDelete={actions.onDelete ? () => setConfirming(true) : undefined} onReorder={actions.onReorder ? (delta) => void actions.onReorder!(delta) : undefined} /></PageTop>}
    {confirming && <ConfirmDialog title={`「${session.titleEditor?.getSnapshot().value || session.title || "無題"}」を削除しますか？`} confirmLabel="文書を削除する" danger busy={busy}
      onConfirm={() => { setConfirming(false); void actions?.onDelete?.(); }} onCancel={() => setConfirming(false)}><p>この文書のページを削除します。</p></ConfirmDialog>}
    {session.titleEditor ? <SessionTitle session={session.titleEditor} locked={busy} autoFocus={session.autoFocusTitle} /> : <PageTitle value={session.title} placeholder="無題" disabled />}
    <div className="pmeta"><DocIcon /><span>文書</span>{updatedLabel(session.updatedMs) && <><span className="dotsep">·</span><span>{updatedLabel(session.updatedMs)}</span></>}<span role="status" data-docs-save-status>{text}</span></div>
    {state.recovery && <div className="loaderr"><p>前回の入力が残っています。復元しますか？</p><button type="button" className="btn primary sm" disabled={busy} onClick={session.restoreDraft}>入力を復元</button><button type="button" className="btn outline sm" disabled={busy} onClick={session.discardDraft}>入力を破棄</button></div>}
    {state.conflict && <div className="loaderr" role="region" aria-label="変更の確認"><p>{state.conflict.label}でも変更されています。使う内容を選んでください。</p><button type="button" className="btn primary sm" disabled={busy || state.phase === "saving"} onClick={() => void session.resolve("local")}>この端末の内容を使う</button><button type="button" className="btn outline sm" disabled={busy || state.phase === "saving"} onClick={() => void session.resolve("remote")}>クラウドの内容を使う</button><button type="button" className="btn outline sm" onClick={() => setCompare(!compare)}>比べる</button>{compare && <div className="compare-grid"><section><h3>この端末</h3><pre>{state.markdown}</pre></section><section><h3>クラウド</h3><pre>{state.conflict.markdown}</pre></section></div>}</div>}
    {state.error && <p className="err" role="alert">{state.error}</p>}
    {!state.draftAvailable && <p className="err" role="alert">この端末に入力の控えを残せません。保存が終わるまでページを閉じないでください。</p>}
    {state.phase === "unconfirmed" && <button type="button" className="btn outline sm" disabled={busy} onClick={() => void session.confirm()}>保存を確認</button>}
    {state.phase === "failed" && <button type="button" className="btn outline sm" disabled={busy} onClick={() => void session.flush()}>もう一度</button>}
    <div className="pbody"><BlockEditor editor={editor} /></div>
  </DocumentPaper>;
}
