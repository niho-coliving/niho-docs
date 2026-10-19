"use client";

import { duplicateFlow, findTemplate, flowChoiceKey, flowUnusableReason, parseFlowChoiceKey, recordingWithCurrentFlow, sameFlowContent, type Flow, type FlowTemplate, type PromptRef } from "@niho/docs-core";
import { type FailureAction } from "../components/FailureBand";
import { type FlowChoice } from "../components/FlowPicker";
import { type Screen, type Selection } from "../components/Rail";
import type { ProjectEntry } from "../host/DocsHost";
import { errorMessage, type Bridge, type FlowList as FlowListData, type RecordingRef } from "../lib/bridge";
import { newId } from "../lib/format";
import { recordingRef, saveRecordingChange, type RecordingView } from "../lib/project-view";
import { type ActiveRun } from "../lib/run-state";
import { activeProfiles, activeProviders, type AppSettings } from "../lib/settings";
import { type ChatController } from "../lib/use-chat";
import { RUNNING_IN_PROJECT, designFlowOf, newFlowOf, type ToastAction } from "./workspace-model";

type Context = {
  flowsRef: React.MutableRefObject<Flow[]>;
  flowEditsRef: React.MutableRefObject<Record<string, Flow>>;
  bridge: Bridge;
  putFlows: (list: readonly Flow[], lastUsed: string | null) => void;
  lastUsedFlowRef: React.MutableRefObject<string | null>;
  putFlowEdit: (flowId: string, edit: Flow | null) => void;
  showToast: (text: string, action?: ToastAction) => void;
  settingsRef: React.MutableRefObject<AppSettings>;
  reloadView: (rec: RecordingRef, frozenRefs?: readonly PromptRef[], shouldApply?: () => boolean) => Promise<RecordingView>;
  selectionRef: React.MutableRefObject<Selection | null>;
  putSelection: (next: Selection | null) => void;
  refreshProjects: (shouldApply?: () => boolean) => Promise<ProjectEntry[]>;
  viewRef: React.MutableRefObject<RecordingView | null>;
  updatingFlow: boolean;
  runRef: React.MutableRefObject<ActiveRun | null>;
  setConfirmUpdate: React.Dispatch<React.SetStateAction<boolean>>;
  showFailure: (text: string, action?: FailureAction) => void;
  setUpdatingFlow: React.Dispatch<React.SetStateAction<boolean>>;
  flowChangingRef: React.MutableRefObject<boolean>;
  chat: ChatController;
  setFlowChange: React.Dispatch<React.SetStateAction<{ key: string; flow: Flow; } | null>>;
  setFlowChanging: React.Dispatch<React.SetStateAction<{ key: string; flowId: string; } | null>>;
  reloadFlows: () => Promise<FlowListData>;
  rememberFlow: (flowId: string) => Promise<boolean>;
  markNavigation: () => void;
  setDesignFlowId: React.Dispatch<React.SetStateAction<string | null>>;
  applyScreen: (next: Screen) => void;
  flowsBusyRef: React.MutableRefObject<boolean>;
  setFlowsBusy: React.Dispatch<React.SetStateAction<boolean>>;
  flowImportingRef: React.MutableRefObject<boolean>;
  setFlowImporting: React.Dispatch<React.SetStateAction<boolean>>;
  setFocusFlowName: React.Dispatch<React.SetStateAction<boolean>>;
  setDeletingFlow: React.Dispatch<React.SetStateAction<{ flow: Flow; usage: number; samples: boolean; } | null>>;
  deletingFlow: { flow: Flow; usage: number; samples: boolean; } | null;
  setDeleteBusy: React.Dispatch<React.SetStateAction<boolean>>;
  designFlowId: string | null;
};

/** 工程設計の保存、録音への反映と、工程一覧の追加・複製・削除。 */
export function useFlowActions(context: Context) {
  const {
    flowsRef, flowEditsRef, bridge, putFlows,
    lastUsedFlowRef, putFlowEdit, showToast, settingsRef,
    reloadView, selectionRef, putSelection, refreshProjects,
    viewRef, updatingFlow, runRef, setConfirmUpdate,
    showFailure, setUpdatingFlow, flowChangingRef, chat,
    setFlowChange, setFlowChanging, reloadFlows, rememberFlow,
    markNavigation, setDesignFlowId, applyScreen, flowsBusyRef,
    setFlowsBusy, flowImportingRef, setFlowImporting, setFocusFlowName,
    setDeletingFlow, deletingFlow, setDeleteBusy, designFlowId,
  } = context;

  /**
   * 工程設計の保存（開いているフロー。revision を 1 つ上げる）。既存の録音は自分の snapshot を使うので変わらない（新しい録音から
   * 効く）。保存中に加えた編集は残す。
   */
  const saveFlow = async (edited: Flow) => {
    const saved = flowsRef.current.find((candidate) => candidate.id === edited.id);
    const draftAtSave = flowEditsRef.current[edited.id] ?? saved ?? edited;
    const next: Flow = { ...edited, revision: (saved?.revision ?? edited.revision) + 1 };
    await bridge.saveFlow(next);
    // 一覧から外したお手本の本文を消す（消せなくても保存は済んでいる。次の保存で消す）
    const keepSamples = new Set([...next.samples, ...(flowEditsRef.current[edited.id]?.samples ?? [])].map((sample) => sample.id));
    await bridge.pruneSamples(next.id, [...keepSamples]).catch(() => undefined);
    const list = flowsRef.current.some((candidate) => candidate.id === next.id)
      ? flowsRef.current.map((candidate) => (candidate.id === next.id ? next : candidate))
      : [...flowsRef.current, next];
    putFlows(list, lastUsedFlowRef.current ?? next.id);
    const remaining = flowEditsRef.current[edited.id];
    putFlowEdit(edited.id, remaining && !sameFlowContent(remaining, draftAtSave) ? remaining : null);
    showToast("保存しました");
  };

  /**
   * 録音の snapshot を `target` から作り直す（モデルも今の設定で解決し直す。成果物・版・実行の記録はそのまま）。見ていた子ページの
   * 工程が外れたら、録音のページへ。
   */
  const rebuildRecordingFlow = async (rec: RecordingRef, target: Flow) => {
    const settingsNow = settingsRef.current;
    await saveRecordingChange(bridge, rec, (recording) =>
      recordingWithCurrentFlow(recording, target, activeProfiles(settingsNow), activeProviders(settingsNow), settingsNow.connection),
    );
    const next = await reloadView(rec);
    const selected = selectionRef.current;
    if (selected?.pageId === next.page.id && selected.stepId && !next.plan.steps.some((step) => step.stepId === selected.stepId)) {
      // 外れた工程の子ページから、フォルダの録音は背景情報のページへ、フォルダの外の録音は録音のページへ（#18914）
      putSelection(rec.projectId !== null ? null : { pageId: selected.pageId, stepId: null });
    }
    await refreshProjects();
  };

  /**
   * 「この録音の工程を今の設計に更新」: snapshot を同じ id のフロー（録音の元のフロー）から作り直す。成果物・版・実行の記録はそのまま。
   */
  const updateRecordingFlow = async () => {
    const current = viewRef.current;
    const currentFlow = current ? flowsRef.current.find((candidate) => candidate.id === current.flow.id) : undefined;
    if (!current || !currentFlow || updatingFlow) return;
    if (runRef.current?.projectId === current.projectId) {
      setConfirmUpdate(false);
      showFailure(RUNNING_IN_PROJECT);
      return;
    }
    setUpdatingFlow(true);
    try {
      await rebuildRecordingFlow(recordingRef(current), currentFlow);
      showToast("この録音の工程を今の設計にしました");
    } catch (error) {
      showFailure(errorMessage(error, "更新できませんでした。"));
    } finally {
      setUpdatingFlow(false);
      setConfirmUpdate(false);
    }
  };

  /**
   * 録音のページの「工程」で別のフローを選んだとき（P4 #18567）: 工程 2 以降の成果物が無ければすぐ、あれば確かめてから、snapshot を
   * 選んだフローで作り直し、そのフローを最後に使ったフローにする。同じ案件の実行中・使えないフロー（docs-core の flowUnusableReason）
   * は変えない。テンプレート（`template:<id>`）を選んだときは、先に新しいフローとして保存する（#18883。Web/PWA と同じ）。
   */
  const changeRecordingFlow = (value: string) => {
    const current = viewRef.current;
    if (!current || value === current.flow.id || flowChangingRef.current) return;
    const choice = parseFlowChoiceKey(value);
    const template = choice?.kind === "template" ? findTemplate(choice.id) : undefined;
    const target = template ? undefined : flowsRef.current.find((candidate) => candidate.id === value);
    if (!template && (!target || flowUnusableReason(target))) return;
    if (runRef.current?.projectId === current.projectId) {
      showFailure(RUNNING_IN_PROJECT);
      return;
    }
    if (chat.sending && (chat.live === null || chat.live.projectId === current.projectId)) {
      showFailure("AIと作るの依頼が終わってから、工程を変えてください。");
      return;
    }
    if (template) void chooseTemplateForRecording(current, template);
    else if (target) offerRecordingFlow(current, target);
  };

  /** 成果物が無ければすぐ、あれば確かめてから、録音の工程を `target` にする。 */
  const offerRecordingFlow = (current: RecordingView, target: Flow) => {
    if (Object.keys(current.artifacts).length === 0) void applyRecordingFlow(current, target, false);
    else setFlowChange({ key: current.key, flow: target });
  };

  /**
   * 録音のページの「工程」でテンプレートを選んだとき（#18883）: 工程設計の「＋ 追加」と同じく新しいフローを作って保存し（あなたの工程に
   * 足す）、そのフローを録音の工程にする（成果物があれば確かめる。やめても作ったフローは残る）。
   */
  const chooseTemplateForRecording = async (current: RecordingView, template: FlowTemplate) => {
    if (flowChangingRef.current) return;
    flowChangingRef.current = true;
    setFlowChanging({ key: current.key, flowId: flowChoiceKey("template", template.id) });
    let created: Flow;
    try {
      created = newFlowOf(template, flowsRef.current);
      await bridge.saveFlow(created);
      // 一覧を読み直せなければ、今の一覧に作ったフローを足す
      const list = await reloadFlows().catch(() => null);
      if (!list) putFlows([...flowsRef.current, created], lastUsedFlowRef.current);
    } catch (error) {
      showFailure(errorMessage(error, "工程を追加できませんでした。"));
      return;
    } finally {
      flowChangingRef.current = false;
      setFlowChanging(null);
    }
    offerRecordingFlow(current, created);
  };

  const applyRecordingFlow = async (current: RecordingView, target: Flow, confirmed: boolean) => {
    if (flowChangingRef.current) return;
    if (runRef.current?.projectId === current.projectId) {
      setFlowChange(null);
      showFailure(RUNNING_IN_PROJECT);
      return;
    }
    if (chat.sending && (chat.live === null || chat.live.projectId === current.projectId)) {
      setFlowChange(null);
      showFailure("AIと作るの依頼が終わってから、工程を変えてください。");
      return;
    }
    flowChangingRef.current = true;
    setFlowChanging({ key: current.key, flowId: target.id });
    try {
      await rebuildRecordingFlow(recordingRef(current), target);
      const remembered = await rememberFlow(target.id);
      if (confirmed && remembered) {
        showToast(`この録音の工程を「${target.name}」にしました`);
      } else if (confirmed) {
        showFailure(`この録音の工程を「${target.name}」にしましたが、次の既定に保存できませんでした。`);
      } else if (!remembered) {
        showFailure("録音の工程を変えましたが、次の既定に保存できませんでした。");
      }
    } catch (error) {
      showFailure(errorMessage(error, "工程を変えられませんでした。"));
    } finally {
      flowChangingRef.current = false;
      setFlowChanging(null);
      setFlowChange(null);
    }
  };

  // ---- 工程設計のフローの一覧（P4 #18567） ----

  /** 一覧の行を押す: そのフローを工程設計で開く（編集中の内容はフローごとに残る）。 */
  const openFlow = (flowId: string) => {
    markNavigation();
    setDesignFlowId(flowId);
    applyScreen("flow");
  };

  /** フローの一覧の操作（追加・複製・削除の確かめ）を 1 つずつにする（終わるまで ⋯ と「＋ 追加」を押せない）。 */
  const withFlowsBusy = async (work: () => Promise<void>, fallback: string) => {
    if (flowsBusyRef.current) return;
    flowsBusyRef.current = true;
    setFlowsBusy(true);
    try {
      await work();
    } catch (error) {
      showFailure(errorMessage(error, fallback));
    } finally {
      flowsBusyRef.current = false;
      setFlowsBusy(false);
    }
  };

  const onFlowImportingChange = (importing: boolean) => {
    flowImportingRef.current = importing;
    setFlowImporting(importing);
  };

  /** 「＋ 追加」: テンプレートか白紙から新しいフローを作って保存し、開く。 */
  const addFlow = (choice: FlowChoice) =>
    withFlowsBusy(async () => {
      const created = newFlowOf(choice, flowsRef.current);
      await bridge.saveFlow(created);
      await reloadFlows();
      setDesignFlowId(created.id);
      setFocusFlowName(false);
    }, "工程を追加できませんでした。");

  /** ⋯ の「複製」: 保存済みの内容を写したフロー（「〈名前〉のコピー」・お手本の本文も）を元の直後に足し、開いて名前を選ぶ。 */
  const duplicateFlowOf = (flowId: string) =>
    withFlowsBusy(async () => {
      const source = flowsRef.current.find((candidate) => candidate.id === flowId);
      if (!source) return;
      const copy = duplicateFlow(source, newId("flow"), flowsRef.current);
      await bridge.duplicateFlow(source.id, copy);
      await reloadFlows();
      setDesignFlowId(copy.id);
      setFocusFlowName(true);
    }, "複製できませんでした。");

  /** ⋯ の「名前の変更」: そのフローを開いて名前の欄にフォーカスする（保存で名前が変わる）。 */
  const renameFlow = (flowId: string) => {
    setDesignFlowId(flowId);
    setFocusFlowName(true);
  };

  /** ⋯ の「削除」: 使っている録音の数を数えてから確かめる（お手本があれば、お手本も消えると出す）。 */
  const askDeleteFlow = (flowId: string) => {
    if (flowImportingRef.current) {
      showFailure("お手本の取り込み中は工程を削除できません。");
      return;
    }
    return withFlowsBusy(async () => {
      const target = flowsRef.current.find((candidate) => candidate.id === flowId);
      if (!target) return;
      const usage = await bridge.flowUsage(flowId);
      const samples = target.samples.length > 0 || (flowEditsRef.current[flowId]?.samples.length ?? 0) > 0;
      setDeletingFlow({ flow: target, usage, samples });
    }, "削除できませんでした。");
  };

  /**
   * フローを消す（確かめた後）。ファイル・お手本の本文・編集中の内容が消え、使っている録音は自分の snapshot で実行できる。開いていた
   * フローなら一覧の隣（前、無ければ次）を開く（無くなれば「工程を選ぶ」の面）。
   */
  const deleteFlow = async () => {
    const target = deletingFlow;
    if (!target) return;
    if (flowImportingRef.current) {
      setDeletingFlow(null);
      showFailure("お手本の取り込み中は工程を削除できません。");
      return;
    }
    setDeleteBusy(true);
    try {
      const list = flowsRef.current;
      const index = list.findIndex((candidate) => candidate.id === target.flow.id);
      const neighbor = list[index - 1] ?? list[index + 1] ?? null;
      const wasOpen = designFlowOf(list, designFlowId, lastUsedFlowRef.current)?.id === target.flow.id;
      await bridge.deleteFlow(target.flow.id);
      putFlowEdit(target.flow.id, null);
      const next = await reloadFlows();
      if (wasOpen) setDesignFlowId(neighbor && next.flows.some((candidate) => candidate.id === neighbor.id) ? neighbor.id : (next.flows[0]?.id ?? null));
      showToast("削除しました");
    } catch (error) {
      showFailure(errorMessage(error, "削除できませんでした。"));
    } finally {
      setDeleteBusy(false);
      setDeletingFlow(null);
    }
  };
  return {
    saveFlow, rebuildRecordingFlow, updateRecordingFlow, changeRecordingFlow,
    applyRecordingFlow, openFlow, onFlowImportingChange, addFlow,
    duplicateFlowOf, renameFlow, askDeleteFlow, deleteFlow,
  };
}
