"use client";

import { useState, useSyncExternalStore } from "react";
import type { ProjectInfo } from "@niho/docs-core";
import type { DocsValueSession, DocsValueState } from "../host/DocsWorkspaceHost";
import { FolderInfoFields } from "./FolderInfo";
import { PageTitle } from "./PageTitle";

function ValueStatus<T>({ session, state, label }: { session: DocsValueSession<T>; state: DocsValueState<T>; label: string }) {
  return <div className="folder-save" aria-label={`${label}の保存状態`}>
    <span className="help" role="status">{({ saved: "クラウドに保存済み", dirty: "未保存の変更", saving: "保存中", unconfirmed: "保存結果を確認できていません", conflict: "変更の確認が必要", failed: "保存できませんでした。入力は残しています。" })[state.phase]}</span>
    {state.error && <span className="err" role="alert">{state.error}</span>}
    {state.phase === "unconfirmed" && <button type="button" className="btn outline sm" onClick={() => void session.confirm()}>保存を確認</button>}
    {state.phase === "failed" && <button type="button" className="btn outline sm" onClick={() => void session.flush()}>もう一度</button>}
  </div>;
}
export function SessionTitle({ session, folder = false, locked = false, autoFocus = false }: { session: DocsValueSession<string>; folder?: boolean; locked?: boolean; autoFocus?: boolean }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  return <>
    <PageTitle value={state.value} autoFocus={autoFocus && !locked} placeholder={folder ? "無題のフォルダ" : "無題"} ariaLabel={folder ? "フォルダの名前" : "タイトル"}
      disabled={locked || state.phase === "saving" || state.phase === "unconfirmed" || Boolean(state.conflict)} saveOnIdle={false} commitOnUnmount={false}
      onInput={session.edit} onCommit={() => session.flush()} onCancel={session.cancel} />
    {(state.phase !== "saved" || state.error) && <ValueStatus session={session} state={state} label={folder ? "フォルダ名" : "文書名"} />}
  </>;
}
/** 比較では保存形式を見せず、利用者が書いた項目の見出しと本文を読む。 */
function InfoSummary({ info, label }: { info: ProjectInfo; label: string }) {
  return <section aria-label={`${label}の背景情報`}>
    <h3>{label}</h3><h4>背景情報</h4><p>{info.background || "なし"}</p>
    <h4>登場人物</h4>
    {info.entities?.length ? <dl>{info.entities.map((person) => <div key={person.id}><dt>{person.name || "名前なし"}</dt><dd>{person.reading && <p>よみ：{person.reading}</p>}{person.role && <p>役割：{person.role}</p>}{person.note && <p>補足：{person.note}</p>}</dd></div>)}</dl> : <p>なし</p>}
    <h4>固有名詞</h4>
    {info.terms.length ? <dl>{info.terms.map((term, index) => <div key={index}><dt>{term.term || "表記なし"}</dt><dd>{term.reading && <p>よみ：{term.reading}</p>}{term.variants.length > 0 && <p>誤りやすい表記：{term.variants.join("・")}</p>}{term.note && <p>補足：{term.note}</p>}</dd></div>)}</dl> : <p>なし</p>}
  </section>;
}
export function SessionFolderInfo({ session, locked = false }: { session: DocsValueSession<ProjectInfo>; locked?: boolean }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [compare, setCompare] = useState(false);
  const [revision, setRevision] = useState(0);
  const value = state.value;
  return <>
    <FolderInfoFields glossaryRevision={`${revision}:${JSON.stringify(state.savedValue.terms)}`} background={value.background} terms={value.terms} entities={value.entities ?? []}
      disabled={locked || state.phase === "unconfirmed" || Boolean(state.conflict)}
      onBackground={(background) => session.edit({ ...value, background })} onTerms={(terms) => session.edit({ ...value, terms })} onEntities={(entities) => session.edit({ ...value, entities })} />
    <ValueStatus session={session} state={state} label="背景情報" />
    {state.conflict && <div className="loaderr" role="region" aria-label="背景情報の変更の確認">
      <p>{state.conflict.label}でも変更されています。使う内容を選んでください。</p>
      <button type="button" className="btn primary sm" onClick={() => void session.resolve("local")}>この端末の内容を使う</button>
      <button type="button" className="btn outline sm" onClick={() => { setRevision((value) => value + 1); void session.resolve("remote"); }}>クラウドの内容を使う</button>
      <button type="button" className="btn outline sm" onClick={() => setCompare(!compare)}>比べてから直す</button>
      {compare && <><div className="compare-grid metadata-comparison"><InfoSummary info={state.value} label="この端末" /><InfoSummary info={state.conflict.value} label="クラウド" /></div><button type="button" className="btn outline sm" onClick={() => { setCompare(false); void session.resolve("compare"); }}>この端末の入力を直す</button></>}
    </div>}
    {state.phase === "dirty" && <button type="button" className="btn primary sm" onClick={() => void session.flush()}>保存</button>}
  </>;
}
