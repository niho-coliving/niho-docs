"use client";

import { candidateFor, candidatesFor, type About, type PromptRef } from "@niho/docs-core";
import { useEffect, useRef } from "react";
import { type FailureAction } from "../components/FailureBand";
import { type ChatToggleState } from "../components/PageTop";
import { type Selection } from "../components/Rail";
import type { PersonalNihoPending, ProjectEntry } from "../host/DocsHost";
import type { ArtifactAutoVersion } from "../lib/artifact-auto-version";
import { errorMessage, type Bridge, type ProjectId, type RecordingRef } from "../lib/bridge";
import { type ChatTarget } from "../lib/chat";
import { useCloud } from "../lib/cloud";
import { recordingKey, type OpenProject, type RecordingView } from "../lib/project-view";
import type { ActiveRun, RunNotice } from "../lib/run-state";
import type { AppSettings } from "../lib/settings";
import { useChat } from "../lib/use-chat";
import { useDocumentChat } from "../lib/use-document-chat";
import type { Draft, NihoRunConfirmation } from "./workspace-model";
import { artifactSaveKey, type ToastAction } from "./workspace-model";

import type { DocFlush } from "../components/DocPage";

type Context = {
  selection: Selection | null;
  view: RecordingView | null;
  candidateNameEdits: Record<string, string>;
  open: OpenProject | null;
  bridge: Bridge;
  runAbortRef: React.MutableRefObject<AbortController | null>;
  nihoRunConfirmationRef: React.MutableRefObject<NihoRunConfirmation | null>;
  setNihoRunConfirmation: React.Dispatch<React.SetStateAction<NihoRunConfirmation | null>>;
  setPersonalNihoPending: React.Dispatch<React.SetStateAction<PersonalNihoPending | null>>;
  setNotice: React.Dispatch<React.SetStateAction<RunNotice | null>>;
  runRef: React.MutableRefObject<ActiveRun | null>;
  draftScopeRef: React.MutableRefObject<string | null>;
  draftsState: Record<string, Draft>;
  draftsByScopeRef: React.MutableRefObject<Map<string, Record<string, Draft>>>;
  draftsStateRef: React.MutableRefObject<Record<string, Draft>>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, Draft>>>;
  settings: AppSettings;
  about: About;
  activeRun: ActiveRun | null;
  reloadView: (rec: RecordingRef, frozenRefs?: readonly PromptRef[], shouldApply?: () => boolean) => Promise<RecordingView>;
  refreshProjects: (shouldApply?: () => boolean) => Promise<ProjectEntry[]>;
  showToast: (text: string, action?: ToastAction) => void;
  docFlushRef: React.MutableRefObject<DocFlush | null>;
  openRef: React.MutableRefObject<OpenProject | null>;
  selectionRef: React.MutableRefObject<Selection | null>;
  setDocReload: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  reloadOpen: (projectId: ProjectId) => Promise<OpenProject>;
  showFailure: (text: string, action?: FailureAction) => void;
  selectPage: (pageId: string, stepId?: string | null, candidateId?: string | null, shouldApply?: () => boolean) => Promise<void>;
  savingRef: React.MutableRefObject<boolean>;
  autoVersion: ArtifactAutoVersion;
  copy: (markdown: string) => Promise<void>;
  chatSendingProjectRef: React.MutableRefObject<ProjectId | undefined>;
  chatOpen: boolean;
  setChatUnseen: React.Dispatch<React.SetStateAction<boolean>>;
  chatUnseen: boolean;
};

/** 文書・録音の会話と、本人・保存先ごとの下書きの分離、未読表示。 */
export function useWorkspaceChat(context: Context) {
  const {
    selection, view, candidateNameEdits, open,
    bridge, runAbortRef, nihoRunConfirmationRef, setNihoRunConfirmation,
    setPersonalNihoPending, setNotice, runRef, draftScopeRef,
    draftsState, draftsByScopeRef, draftsStateRef, setDrafts,
    settings, about, activeRun, reloadView,
    refreshProjects, showToast, docFlushRef, openRef,
    selectionRef, setDocReload, reloadOpen, showFailure,
    savingRef, chatSendingProjectRef, chatOpen, setChatUnseen,
    chatUnseen,
  } = context;

  const selectedStepId = selection?.stepId ?? null;
  const selectedArtifactCandidate = view && selectedStepId
    ? candidateFor(view.recording, selectedStepId, selection?.candidateId)
    : null;
  const selectedTarget: ChatTarget | null = selectedArtifactCandidate && selectedStepId
    ? {
        stepId: selectedStepId,
        candidateId: selectedArtifactCandidate.id,
        artifactId: selectedArtifactCandidate.artifactId,
        name: candidateNameEdits[selectedArtifactCandidate.id] ?? selectedArtifactCandidate.name,
        instruction: selectedArtifactCandidate.instruction,
      }
    : null;
  const hasCandidates = Object.keys(view?.recording.candidateSets ?? {}).length > 0;
  // 複数案のある録音では、共有素材の会話も開いている工程だけを直す。台帳の無い録音は従来の会話範囲を保つ。
  const chatWritableArtifactId = selectedTarget?.artifactId ?? (hasCandidates ? selectedStepId : null);
  // 別案のある工程の名前（工程設計で付けた名前。「記事本文」に固定しない）
  const candidateStepName = view ? view.flow.steps.find((step) => candidatesFor(view.recording, step.id).length > 0)?.name : undefined;
  // 案を開いていなければ、会話では録音の文書を読むだけにする（文書ページを直す・新しい文書を作るのはできる。composer #18722）
  const sharedChatReadOnly = !selectedStepId && hasCandidates
    ? `${candidateStepName || "別案のある工程"}を直すときは、左の案を開いてください。`
    : null;

  // 「AIと作る」の修正の会話（S5）: 会話・実行中の依頼・送信・停止・元に戻す（録音ごと）
  const documentPage = open?.pages.find((page) => page.id === selection?.pageId && page.kind === "doc");
  const documentChat = useDocumentChat(open, documentPage?.id ?? null);
  // Root/owner の scope ごとに書きかけ一式を隔離する。同じ page/recording/artifact id を別 Root へ持ち込まない。
  const cloud = useCloud(bridge, open?.id ?? null);
  const documentScopeId = cloud.state?.documentScopeId ?? null;
  const cloudContextRef = useRef({ generation: cloud.state?.contextGeneration ?? null, scopeId: documentScopeId });
  cloudContextRef.current = { generation: cloud.state?.contextGeneration ?? null, scopeId: documentScopeId };
  const previousExecutionContextRef = useRef({ ...cloudContextRef.current });
  useEffect(() => {
    const previous = previousExecutionContextRef.current;
    const current = cloudContextRef.current;
    previousExecutionContextRef.current = { ...current };
    if (previous.generation === current.generation && previous.scopeId === current.scopeId) return;
    // owner/Rootの世代が変わった時点で旧operationと旧確認を止め、旧本人のpendingを持ち越さない。
    runAbortRef.current?.abort();
    nihoRunConfirmationRef.current?.cancel();
    setNihoRunConfirmation(null);
    setPersonalNihoPending(null);
    setNotice(null);
  }, [cloud.state?.contextGeneration, documentScopeId, nihoRunConfirmationRef, runAbortRef, setNihoRunConfirmation, setNotice, setPersonalNihoPending]);
  useEffect(() => {
    const run = runRef.current;
    if (!run) return;
    if (view?.key !== recordingKey({ projectId: run.projectId, recordingId: run.recordingId })) {
      runAbortRef.current?.abort();
      nihoRunConfirmationRef.current?.cancel();
    }
  }, [nihoRunConfirmationRef, runAbortRef, runRef, view?.key]);
  const drafts = documentScopeId !== null && draftScopeRef.current === documentScopeId ? draftsState : {};
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  useEffect(() => {
    if (documentScopeId === null || draftScopeRef.current === documentScopeId) return;
    const previous = draftScopeRef.current;
    if (previous !== null) draftsByScopeRef.current.set(previous, draftsStateRef.current);
    const next = draftsByScopeRef.current.get(documentScopeId) ?? {};
    draftScopeRef.current = documentScopeId;
    draftsStateRef.current = next;
    setDrafts(next);
  }, [documentScopeId, draftScopeRef, draftsByScopeRef, draftsStateRef, setDrafts]);
  const chat = useChat({
    bridge,
    view: documentPage ? documentChat.view : view,
    settings,
    about,
    activeRun,
    drafts,
    setDrafts,
    reloadView,
    refreshProjects,
    showToast,
    target: documentPage ? null : selectedTarget,
    writableArtifactId: documentPage ? null : chatWritableArtifactId,
    recordingReadOnly: documentPage ? null : sharedChatReadOnly,
    documentChat: documentPage ? {
      pageId: documentPage.id,
      flush: async () => (await docFlushRef.current?.()) ?? true,
    } : undefined,
    // composer（#18722）: AI が直した・作った文書ページ。一覧（並び・更新時刻）を読み直し、開いている文書ページを直したなら
    // 本文も読み直す（依頼の間は編集を止めているので書きかけは無い）。新しい文書は会話のカードの「開く」から開く
    onPagesChanged: async (projectId, changedPageIds, createdPageIds) => {
      if (openRef.current?.id !== projectId) return;
      const openPageId = selectionRef.current?.pageId ?? null;
      if (openPageId && changedPageIds.includes(openPageId)) {
        setDocReload((all) => ({ ...all, [openPageId]: (all[openPageId] ?? 0) + 1 }));
      }
      try {
        await reloadOpen(projectId);
      } catch (error) {
        const saved = createdPageIds.length > 0 ? "新しい文書は保存されています。" : "AI が直した文書は保存されています。";
        showFailure(`${saved}${errorMessage(error, "ページの一覧を読み込み直してください。")}`);
      }
    },
    onOpenPage: (projectId, pageId) => {
      if (openRef.current?.id === projectId) void context.selectPage(pageId);
    },
    writeBlocked: () => savingRef.current,
    // 直前に自動で版にした書きかけは、送る前の保存で同じ版を重ねない（#18912）
    versioned: (key, markdown) => context.autoVersion.isVersioned(artifactSaveKey(key, draftScopeRef.current ?? ""), markdown),
    // 途中までの出力の「コピー」（#18788）は、成果物の「コピー」と同じ処理と知らせ
    copy: (markdown) => void context.copy(markdown),
  });
  chatSendingProjectRef.current = chat.sendingProjectId;
  // 閉じている「AIと作る」の点（owner 2026-10-18・#18941）: 依頼か工程の実行が動いている間は作業中、閉じている間に依頼が終わったら
  // 開くまで新しい返事。ChatPanel は閉じるとアンマウントするが、会話・選んだ会話・打ちかけは useChat が持つので開き直しても残る
  const chatRequestBusy = chat.sending || chat.live !== null;
  const chatRequestBusyRef = useRef(chatRequestBusy);
  useEffect(() => {
    const was = chatRequestBusyRef.current;
    chatRequestBusyRef.current = chatRequestBusy;
    if (was && !chatRequestBusy && !chatOpen) setChatUnseen(true);
  }, [chatRequestBusy, chatOpen, setChatUnseen]);
  useEffect(() => {
    if (chatOpen) setChatUnseen(false);
  }, [chatOpen, setChatUnseen]);
  const chatToggleState: ChatToggleState = chatRequestBusy || activeRun !== null ? "busy" : chatUnseen ? "unread" : null;
  return {
    selectedStepId, selectedTarget, documentChat, cloud,
    documentScopeId, cloudContextRef, drafts, draftsRef,
    chat, chatToggleState,
  };
}
