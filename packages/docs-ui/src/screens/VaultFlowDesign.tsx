"use client";

import { useState, useSyncExternalStore } from "react";
import { flowHasTranscription } from "@niho/docs-core";
import type { DocsFlowDesignSession } from "../host/DocsWorkspaceHost";
import { FlowDesign } from "../components/FlowDesign";
import { FlowList } from "../components/FlowList";
import { FlowPickerPanel } from "../components/FlowPicker";
import { ConfirmDialog } from "../components/ConfirmDialog";

/** Macと同じ工程エディタと一覧。保存と受付の寿命はhostが持つ。 */
export function VaultFlowDesign({ session }: { session: DocsFlowDesignSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [focusName, setFocusName] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const current = state.flows.find((flow) => flow.id === state.currentId);
  const readOnlyReason = current ? state.readOnly[current.id] : undefined;
  const busy = importing || state.loading || ["saving", "unconfirmed", "conflict"].includes(state.phase);
  const run = (work: Promise<void>) => { void work.catch(() => undefined); };
  const list = <FlowList rows={state.flows.map((flow) => ({ id: flow.id, name: flow.name, steps: flow.steps.length + (flowHasTranscription(flow) ? 1 : 0), unsaved: flow.id in state.drafts, readOnlyReason: state.readOnly[flow.id] }))} currentId={state.currentId ?? ""} busy={busy}
    onOpen={(id) => session.open(id)} onAdd={(choice) => run(session.add(choice))} onDuplicate={(id) => run(session.duplicate(id))}
    onRename={(id) => { session.open(id); setFocusName(true); }} onDelete={setDeleting} onMove={(id, delta) => run(session.move(id, delta))} />;
  return <>
    {state.error && <div className="loaderr" role="alert"><p>{state.error}</p>
      {state.phase === "unconfirmed" ? <button type="button" className="btn outline sm" onClick={() => run(session.confirm())}>保存結果を確認</button>
        : <button type="button" className="btn outline sm" onClick={() => setDiscarding(true)}>最新の内容を読み直す</button>}
    </div>}
    {state.loading ? <p role="status">工程を読み込んでいます…</p> : current ? <>
      {readOnlyReason ? <p role="note" className="help">{readOnlyReason}</p> : null}
      <FlowDesign key={current.id} flow={current} draft={state.drafts[current.id] ?? current} samples={session.samples}
      disabled={busy || deleting !== null || discarding || Boolean(readOnlyReason)} dropEnabled={false} importingSamples={importing} onImportingChange={setImporting} list={list}
      focusName={focusName} onNameFocused={() => setFocusName(false)} onChange={(flow) => session.edit(flow)} onSave={(flow) => session.save(flow)} />
      </>
      : <><h1>工程設計</h1><FlowPickerPanel busy={busy} onChoose={(choice) => run(session.add(choice))} /></>}
    {deleting && <ConfirmDialog title={`「${state.flows.find((flow) => flow.id === deleting)?.name ?? "工程"}」を削除しますか？`} confirmLabel="工程を削除する" danger busy={state.phase === "saving"}
      onConfirm={() => run(session.remove(deleting).then(() => setDeleting(null)).catch((error: unknown) => { setDeleting(null); throw error; }))} onCancel={() => setDeleting(null)}>
      <p>この工程とお手本の文書を削除します。作成済みの録音とその工程は残ります。</p>
    </ConfirmDialog>}
    {discarding && <ConfirmDialog title="最新の内容を読み直しますか？" confirmLabel="手元の変更を破棄して読み直す" danger onConfirm={() => { setDiscarding(false); run(session.load(true)); }} onCancel={() => setDiscarding(false)}><p>保存していない工程の入力を破棄し、保管庫の最新の内容を表示します。</p></ConfirmDialog>}
  </>;
}
