"use client";

import { useEffect, useRef } from "react";
import type { DocsWorkspaceActions, DocsWorkspaceOperation } from "../host/DocsWorkspaceHost";

export function WorkspaceOperationNotice({ operation, actions }: { operation: DocsWorkspaceOperation; actions: DocsWorkspaceActions }) {
  return <div className="loaderr" role={operation.phase === "running" ? "status" : "alert"} aria-label={`${operation.label}の状態`}>
    <p>{operation.phase === "running" ? `${operation.label}中…` : operation.message}</p>
    {operation.phase === "unconfirmed" && <button type="button" className="btn outline sm" onClick={() => void actions.confirm()}>結果を確認</button>}
    {operation.phase === "refresh-failed" && <button type="button" className="btn outline sm" onClick={() => void actions.retry()}>読み込み直す</button>}
    {operation.phase === "partial" && <><button type="button" className="btn outline sm" onClick={() => void actions.retry()}>移動を続ける</button><button type="button" className="btn outline sm" onClick={actions.dismiss}>両方を残して終了</button></>}
    {operation.phase === "protected" && operation.canDismiss !== false && <button type="button" className="btn outline sm" onClick={actions.dismiss}>確認して終了</button>}
    {operation.phase === "protected" && operation.canDismiss === false && actions.recheckMove && <button type="button" className="btn outline sm" onClick={() => void actions.recheckMove!()}>状態を読み直す</button>}
    {(operation.phase === "protected" || operation.phase === "partial") && actions.inspectMove && <><button type="button" className="btn outline sm" onClick={() => void actions.inspectMove!("source")}>元の文書を見る</button><button type="button" className="btn outline sm" onClick={() => void actions.inspectMove!("destination")}>移動先を見る</button></>}
    {operation.phase === "failed" && <><button type="button" className="btn outline sm" onClick={() => void actions.retry()}>もう一度</button><button type="button" className="btn outline sm" onClick={actions.dismiss}>やめる</button></>}
  </div>;
}
/** フォルダ作成の名前行。IDと入力はhostが保持し、blur/Enterで作り、Escapeで取り消す。 */
export function FolderCreationRow({ value, locked, actions }: { value: string; locked: boolean; actions: DocsWorkspaceActions }) {
  const input = useRef<HTMLInputElement>(null);
  const skipBlur = useRef(false);
  useEffect(() => { input.current?.focus(); }, []);
  return <div className="folder-creation-row">
    <input ref={input} className="inp" aria-label="新しいフォルダの名前" placeholder="無題のフォルダ" value={value} disabled={locked}
      onChange={(event) => actions.editFolder?.(event.target.value.replace(/[\r\n]+/g, " "))}
      onBlur={() => { if (skipBlur.current) { skipBlur.current = false; return; } if (!locked) void actions.commitFolder?.(); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") { event.preventDefault(); input.current?.blur(); }
        if (event.key === "Escape") { event.preventDefault(); skipBlur.current = true; actions.cancelFolder?.(); }
      }} />
  </div>;
}
