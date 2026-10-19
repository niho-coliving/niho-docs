"use client";

import { NIHO_API_MODEL_SWAP_NOTE, SOURCE_STEP_ID, folderName, pageTitle, runPlaceLine, sameFlowDesign, type Flow, type PageEntry, type PromptRef, type RunStartAction, type TranscriptSpeakerEntry } from "@niho/docs-core";
import { type DocFlush } from "../components/DocPage";
import type { EditorToolControls } from "../components/EditorTools";
import { type FailureAction } from "../components/FailureBand";
import { ChatToggle, type ChatToggleState, type EditorMenuActions } from "../components/PageTop";
import { type Screen, type Selection } from "../components/Rail";
import { RecordingChatColumn, type RecordingControlsProps } from "../components/RecordingPage";
import type { ProjectEntry } from "../host/DocsHost";
import { type CaptureTarget } from "../lib/app-recording";
import type { ArtifactAutosave } from "../lib/artifact-autosave";
import { errorMessage, type Bridge, type PersonalNihoPending, type ProjectId, type RecordingRef } from "../lib/bridge";
import { type ChatTarget } from "../lib/chat";
import type { CloudController } from "../lib/cloud";
import { audioPath, audioStatusText, cloudProjectId as toCloudProjectId } from "../lib/cloud";
import { finalizeMarkdown } from "../lib/markdown";
import { fileStem } from "../lib/names";
import { personalNihoFixedModels } from "../lib/personal-niho";
import { latestVersionRecord, recordingRef, type OpenProject, type RecordingView } from "../lib/project-view";
import { type RunGate } from "../lib/run-gate";
import { type ActiveRun, type RunNotice } from "../lib/run-state";
import { type AppSettings } from "../lib/settings";
import { type ChatController } from "../lib/use-chat";
import type { GoogleDocsController } from "../lib/use-google-docs";
import { ArtifactScreen } from "./ArtifactScreen";
import { DocumentScreen } from "./DocumentScreen";
import { FolderScreen } from "./FolderScreen";
import { HomeScreen as Home, type RecentRow } from "./HomeScreen";
import { RecordingScreen } from "./RecordingScreen";
import { type Draft, type FlowOrigin, type OpenedArtifactDocument, type RebuildRequest, type RebuildUndo, type RecordingThen, type ToastAction, type ViewingVersion } from "./workspace-model";

import type { useAppRecording } from "../lib/app-recording";

type Props = {
  open: OpenProject | null;
  recentRows: RecentRow[];
  hasAnyPage: boolean;
  selectLocationPage: (projectId: ProjectId, pageId: string, stepId: string | null, candidateId?: string | null, shouldApply?: () => boolean) => Promise<void>;
  chatOpen: boolean;
  chatToggleState: ChatToggleState;
  setChatOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sourceFlow: Flow | null;
  unregistered: string[];
  runningProject: boolean;
  setConfirmUpdate: React.Dispatch<React.SetStateAction<boolean>>;
  rawTitle: (page: PageEntry) => string;
  settings: AppSettings;
  cloud: CloudController;
  accountExecutionProblem: string | null;
  bridge: Bridge;
  capture: ReturnType<typeof useAppRecording>;
  captureTarget: (pageId?: string) => CaptureTarget;
  selectPage: (pageId: string, stepId?: string | null, candidateId?: string | null, shouldApply?: () => boolean) => Promise<void>;
  activeRun: ActiveRun | null;
  notice: RunNotice | null;
  blockedReason: string | null;
  setupReasonFor: (queue: readonly string[], mode?: boolean | RunStartAction) => string | null;
  openSettingsFromRun: () => void;
  chatBusyInProject: (rec: RecordingView) => boolean;
  saving: boolean;
  flows: Flow[];
  flowChanging: { key: string; flowId: string; } | null;
  changeRecordingFlow: (value: string) => void;
  markNavigation: () => void;
  putFlowOrigin: (next: FlowOrigin | null) => void;
  navigationRef: React.MutableRefObject<number>;
  setDesignFlowId: React.Dispatch<React.SetStateAction<string | null>>;
  applyScreen: (next: Screen) => void;
  guardAboutLeave: (action: () => void) => boolean;
  updateRecordingInteraction: (blocked: boolean) => void;
  startRun: (queue: string[], fixedTarget?: (ChatTarget & { instruction?: string; }) | null, trigger?: "selection" | "step", rebuild?: RebuildRequest | null, action?: RunStartAction | null) => boolean;
  stop: () => Promise<void>;
  reloadView: (rec: RecordingRef, frozenRefs?: readonly PromptRef[], shouldApply?: () => boolean) => Promise<RecordingView>;
  refreshProjects: (shouldApply?: () => boolean) => Promise<ProjectEntry[]>;
  showFailure: (text: string, action?: FailureAction) => void;
  runLeaseNote: (rec: RecordingView) => string | null;
  personalNihoPending: PersonalNihoPending | null;
  confirmPersonalNiho: (action: "lookup" | "resend" | "release") => Promise<void>;
  recordingChat: ChatController;
  loadPartial: (runId: string) => Promise<string | null>;
  selection: Selection | null;
  titleEdits: Record<string, string>;
  view: RecordingView | null;
  folderLocked: boolean;
  processFileDrop: (paths: string[], ctx: { location: string | null; navigation: number; }, chosenFlow?: Flow | null) => Promise<void>;
  addRecordingPage: (target: string | null, options?: { flow?: Flow | null; name?: string; then?: RecordingThen; }) => Promise<boolean>;
  chat: ChatController;
  moveBusyRef: React.MutableRefObject<boolean>;
  createBusyRef: React.MutableRefObject<boolean>;
  dropBusyRef: React.MutableRefObject<boolean>;
  recordingInteractionBusy: boolean;
  folders: OpenProject[];
  movePage: (targetProjectId: ProjectId, pageIdOverride?: string) => Promise<void>;
  setDeleting: React.Dispatch<React.SetStateAction<{ projectId: ProjectId; pageId: string; title: string; kind: PageEntry["kind"]; audio?: boolean; } | null>>;
  focusFolderTitle: boolean;
  setFocusFolderTitle: React.Dispatch<React.SetStateAction<boolean>>;
  setTitleEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  titleEditsRef: React.MutableRefObject<Record<string, string>>;
  commitFolderTitle: (projectId: string, title: string) => Promise<boolean>;
  infoDirtyRef: React.MutableRefObject<boolean>;
  setInfoEditing: React.Dispatch<React.SetStateAction<boolean>>;
  onInfoSaved: (projectId: string) => Promise<void>;
  docFlushRef: React.MutableRefObject<DocFlush | null>;
  page: PageEntry | null;
  latestMarkdownRef: React.MutableRefObject<{ key: string; markdown: string; } | null>;
  showToast: (text: string, action?: ToastAction) => void;
  inputTitle: (pageId: string, title: string) => void;
  commitTitle: (projectId: ProjectId, pageId: string, title: string) => Promise<boolean>;
  setFocusTitle: React.Dispatch<React.SetStateAction<string | null>>;
  editorTools: EditorToolControls | null;
  copy: (markdown: string) => Promise<void>;
  accountShown: boolean;
  googleDocs: GoogleDocsController;
  reorderPage: (delta: -1 | 1, pageIdOverride?: string) => void;
  docReload: Record<string, number>;
  focusTitle: string | null;
  openRef: React.MutableRefObject<OpenProject | null>;
  putOpen: (next: OpenProject | null) => void;
  reviewConflict: (projectId: string, path: string | null) => Promise<void>;
  cloudDocReload: number;
  setEditorTools: React.Dispatch<React.SetStateAction<EditorToolControls | null>>;
  documentChat: { view: RecordingView | null; };
  reloadOpen: (projectId: ProjectId) => Promise<OpenProject>;
  stepId: string | null;
  currentArtifactId: string | null;
  openedArtifact: OpenedArtifactDocument | null;
  documentScopeId: string | null;
  autosave: ArtifactAutosave;
  currentDraft: Draft | undefined;
  viewingShown: ViewingVersion | null;
  selectedTarget: ChatTarget | null;
  exportFile: (markdown: string, recordingTitle: string) => Promise<void>;
  reveal: () => Promise<void>;
  artifactRefreshing: boolean;
  showLatestArtifact: () => Promise<void>;
  closeVersion: () => void;
  openVersion: (version: number, versionPath?: string) => Promise<void>;
  rebuildStep: (id: string) => void;
  restoreVersion: () => Promise<void>;
  changeDraft: (markdown: string) => void;
  undoRebuildRef: React.MutableRefObject<(undo: RebuildUndo) => Promise<void>>;
  renameSpeaker: (speaker: TranscriptSpeakerEntry, requestedName: string | null) => Promise<void>;
  setCandidateNameEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  commitCandidateName: (target: ChatTarget, name: string) => Promise<void>;
  setCompareOpen: React.Dispatch<React.SetStateAction<boolean>>;
  changeSettings: (next: AppSettings) => void;
  settingsRef: React.MutableRefObject<AppSettings>;
  addDocPage: (targetProjectId?: ProjectId, afterPageId?: string) => Promise<void>;
};

/** WorkScreen の描画。保存・実行・遷移の操作は controller から受け取る。 */
export function WorkScreen(props: Props) {
  const {
    open, recentRows, hasAnyPage, selectLocationPage,
    chatOpen, chatToggleState, setChatOpen, sourceFlow,
    unregistered, runningProject, setConfirmUpdate, rawTitle,
    settings, cloud, accountExecutionProblem, bridge, capture,
    captureTarget, selectPage, activeRun, notice,
    blockedReason, setupReasonFor, openSettingsFromRun, chatBusyInProject,
    saving, flows, flowChanging, changeRecordingFlow,
    markNavigation, putFlowOrigin, navigationRef, setDesignFlowId,
    applyScreen, guardAboutLeave, updateRecordingInteraction, startRun,
    stop, reloadView, refreshProjects, showFailure,
    runLeaseNote, personalNihoPending, confirmPersonalNiho, recordingChat,
    loadPartial, selection, titleEdits, view,
    folderLocked, processFileDrop, addRecordingPage, chat,
    moveBusyRef, createBusyRef, dropBusyRef, recordingInteractionBusy,
    folders, movePage, setDeleting, focusFolderTitle,
    setFocusFolderTitle, setTitleEdits, titleEditsRef, commitFolderTitle,
    infoDirtyRef, setInfoEditing, onInfoSaved, docFlushRef,
    page, latestMarkdownRef, showToast, inputTitle,
    commitTitle, setFocusTitle, editorTools, copy,
    accountShown, googleDocs, reorderPage, docReload,
    focusTitle, openRef, putOpen, reviewConflict,
    cloudDocReload, setEditorTools, documentChat, reloadOpen,
    stepId, currentArtifactId, openedArtifact, documentScopeId,
    autosave, currentDraft, viewingShown, selectedTarget,
    exportFile, reveal, artifactRefreshing, showLatestArtifact,
    closeVersion, openVersion, rebuildStep, restoreVersion,
    changeDraft, undoRebuildRef, renameSpeaker, setCandidateNameEdits,
    commitCandidateName, setCompareOpen, changeSettings, settingsRef,
    addDocPage,
  } = props;

    if (!open) {
      return <Home recent={recentRows} hasPages={hasAnyPage} onOpen={(row) => void selectLocationPage(row.projectId, row.page.id, null)} />;
    }
    const chatToggle = <ChatToggle open={chatOpen} state={chatToggleState} onToggle={() => setChatOpen((value) => !value)} />;
    /** 録音の操作（フォルダの背景情報のページの「音声」と、フォルダの外の録音のページで同じ）。`originTitle` は工程設計から戻るときの名前。 */
    const controlsFor = (rv: RecordingView, recordingPage: PageEntry, originTitle: string): RecordingControlsProps => {
      const flowUpdate =
        sourceFlow && (!sameFlowDesign(rv.flow, sourceFlow) || unregistered.length > 0)
          ? { disabled: runningProject, unregistered: unregistered.length > 0, onUpdate: () => setConfirmUpdate(true) }
          : null;
      const docPages = open.pages
        .filter((candidate) => candidate.kind === "doc")
        .map((candidate) => ({ id: candidate.id, title: pageTitle({ ...candidate, title: rawTitle(candidate) }) }));
      // 何をするかはページのボタン、続きをどこで作るかは設定（#18947）。ページには場所の 1 行と、ボタンごとの押せない理由だけを渡す
      const continuation = settings.personalExecution.continuation;
      const sourceVersion = latestVersionRecord(rv.runs, SOURCE_STEP_ID)?.version;
      const sourceDone = !rv.plan.remaining.includes(SOURCE_STEP_ID);
      const hasAudio = rv.recording.source.kind === "audio" && rv.recording.source.audio.length > 0;
      // クラウドが受けない続き（startRun の確かめと同じ。押してから断らない）。「文書作成を開始」は原文をこの Mac で作ってから続きを
      // 任せるので、原文が無いことは理由にしない
      // （設定で続きを この Mac にすると作れる理由は、設定への導線を添える）
      const partialReason: RunGate | null = rv.flow.steps.some((step) => rv.artifacts[step.id] !== undefined)
        ? { reason: "途中まで作ったページがある録音の続きは、クラウドでは作れません。設定で続きを「この Mac」にすると作れます", setup: true }
        : null;
      const start: RecordingControlsProps["start"] = {
        placeLine: runPlaceLine({ transcription: "this_device", continuation: continuation === "niho_api" ? "cloud" : "this_device", sourceDone }),
        note: continuation === "niho_api" && !personalNihoFixedModels(rv.flow) ? NIHO_API_MODEL_SWAP_NOTE : null,
        reasonFor: (action) => {
          if (action === "transcribeOnly") return hasAudio ? null : { reason: "文字起こしには音声が必要です", setup: false };
          if (cloud.active && accountExecutionProblem) return { reason: accountExecutionProblem, setup: true };
          if (continuation !== "niho_api") return null;
          if (action === "create") return partialReason;
          if (!sourceVersion) return { reason: "クラウドで続きを作るには、この Mac で確定した原文が必要です", setup: false };
          return partialReason ?? (rv.plan.remaining.length > 0 && rv.plan.remaining.length !== rv.flow.steps.length
            ? { reason: "途中の工程からの続きは、クラウドでは作れません。設定で続きを「この Mac」にすると作れます", setup: true }
            : null);
        },
      };
      const snapshot = cloud.snapshots[toCloudProjectId(rv.projectId)] ?? null;
      return {
        bridge,
        recording: { active: capture.active, saving: capture.saving, start: () => void capture.start(captureTarget(recordingPage.id)) },
        view: rv,
        docPages,
        onOpenPage: (pageId) => void selectPage(pageId),
        activeRun,
        notice,
        blockedReason,
        setupReasonFor,
        onOpenSettings: openSettingsFromRun,
        chatBusy: chatBusyInProject(rv),
        dropEnabled: false,
        saving,
        flowUpdate,
        flowChoice: {
          flows,
          pending: flowChanging && flowChanging.key === rv.key ? flowChanging.flowId : null,
          onChange: changeRecordingFlow,
        },
        onOpenFlowDesign: () => {
          const action = () => {
            markNavigation();
            putFlowOrigin({ rec: recordingRef(rv), pageId: recordingPage.id, title: originTitle, navigation: navigationRef.current });
            setDesignFlowId(null);
            applyScreen("flow");
          };
          if (guardAboutLeave(action)) action();
        },
        onDropBlockedChange: updateRecordingInteraction,
        onRun: (queue, action) => startRun(queue, null, "selection", null, action),
        onStop: () => void stop(),
        onChanged: async () => {
          await reloadView(recordingRef(rv));
          await refreshProjects();
        },
        onError: showFailure,
        audioNote: (file) =>
          audioStatusText({ niho: cloud.niho, path: audioPath(recordingRef(rv), file), file, snapshot, missingInputs: rv.missingInputs }),
        leaseNote: runLeaseNote(rv),
        start,
        pendingNiho: personalNihoPending,
        onConfirmPendingNiho: (action) => void confirmPersonalNiho(action),
      };
    };
    /** 「AIと作る」の列（録音の会話）。 */
    const recordingChatColumn = (rv: RecordingView) => (
      <RecordingChatColumn
        view={rv}
        activeRun={activeRun}
        chat={recordingChat}
        loadPartial={loadPartial}
        chatBusy={chatBusyInProject(rv)}
        saving={saving}
        leaseNote={runLeaseNote(rv)}
        setupReasonFor={setupReasonFor}
        onRunStep={(id) => startRun([id])}
      />
    );
    if (open.id !== null && selection === null) {
      return <FolderScreen {...{
          open, titleEdits, view, capture,
          folderLocked, saving, bridge, processFileDrop,
          navigationRef, showFailure, addRecordingPage, captureTarget,
          runningProject, chat, moveBusyRef, createBusyRef,
          dropBusyRef, recordingInteractionBusy, chatToggle, folders,
          movePage, setDeleting, focusFolderTitle, setFocusFolderTitle,
          setTitleEdits, titleEditsRef, commitFolderTitle, infoDirtyRef,
          setInfoEditing, onInfoSaved, docFlushRef, controlsFor,
          selectLocationPage, chatOpen, recordingChatColumn,
        }} />;
    }
    if (open.pages.length === 0) {
      return <Home recent={recentRows} hasPages={hasAnyPage} onOpen={(row) => void selectLocationPage(row.projectId, row.page.id, null)} />;
    }
    if (!page) return null;
    /** 文書のページの、未保存分を含む今の本文（DocPage の snapshot）。まだ読み終えていなければ断る。 */
    const docMarkdown = (pageId: string): string | null => {
      const snapshot = latestMarkdownRef.current;
      if (!snapshot || snapshot.key !== `${open.id}:${pageId}`) {
        showFailure("本文を読み終えてから書き出してください。");
        return null;
      }
      return snapshot.markdown;
    };
    /** 文書のページの .md の書き出し。ファイル名は「〈フォルダ名〉 〈タイトル〉.md」（フォルダの外は「〈タイトル〉.md」）。 */
    const exportDocFile = async (markdown: string, docTitle: string) => {
      const stem = open.id === null ? fileStem(docTitle) : `${fileStem(folderName(open.project))} ${fileStem(docTitle)}`;
      try {
        const path = await bridge.saveMarkdownAs(`${stem}.md`, finalizeMarkdown(markdown));
        if (path) showToast("書き出しました");
      } catch (error) {
        showFailure(errorMessage(error, "書き出せませんでした。"));
      }
    };
    const revealDoc = async (pageId: string) => {
      try {
        await bridge.revealPage(open.id, pageId);
      } catch (error) {
        showFailure(errorMessage(error, "Finder で表示できませんでした。"));
      }
    };
    const editTitle = (pageId: string) => ({
      onTitleInput: (title: string) => inputTitle(pageId, title),
      onTitleCommit: (title: string) => commitTitle(open.id, pageId, title),
      onTitleFocused: () => setFocusTitle(null),
    });
    // タイトルバーの右端は［AIと作る］［⋯］（書き出し・検索・書式は ⋯ の中。owner 2026-10-18・#18941）
    const editorMenu: EditorMenuActions | null = editorTools && {
      disabled: !editorTools.available,
      toolbarOpen: editorTools.toolbarOpen,
      onSearch: editorTools.openSearch,
      onToggleToolbar: editorTools.toggleToolbar,
    };
    if (page.kind === "doc") {
      return <DocumentScreen {...{
          rawTitle, page, capture, docMarkdown,
          copy, exportDocFile, accountShown, googleDocs,
          open, bridge, revealDoc, chatToggle,
          editorMenu, folderLocked, folders, reorderPage,
          movePage, setDeleting, chatOpen, docReload,
          focusTitle, chat, titleEdits, editTitle, openRef,
          putOpen, refreshProjects, showFailure, latestMarkdownRef,
          docFlushRef, cloud, reviewConflict, cloudDocReload,
          setEditorTools, documentChat, activeRun, saving,
          reloadOpen,
        }} />;
    }
    // 録音のページと成果物の子ページ（見え方を読み終えるまでは何も出さない）
    if (!view || view.recordingId !== (page.recordingId ?? page.id) || view.projectId !== open.id) return null;
    // 成果物の子ページの「〈元〉から」は、フォルダの録音ならフォルダ（録音のページは出さない。#18914）
    const recordingTitle = open.id !== null ? folderName(open.project) : pageTitle({ ...page, title: rawTitle(page) }, view.recording);
    const flowUpdate =
      sourceFlow && (!sameFlowDesign(view.flow, sourceFlow) || unregistered.length > 0)
        ? { disabled: runningProject, unregistered: unregistered.length > 0, onUpdate: () => setConfirmUpdate(true) }
        : null;
    const cloudProjectId = toCloudProjectId(view.projectId);
    const snapshot = cloud.snapshots[cloudProjectId] ?? null;
    if (stepId) {
      return <ArtifactScreen {...{
          pageId: page.id, titleEdits,
          currentArtifactId, stepId, view, openedArtifact,
          documentScopeId, autosave, currentDraft, viewingShown,
          cloud, snapshot, activeRun, selectedTarget,
          settings, copy, exportFile, recordingTitle,
          accountShown, googleDocs, bridge, reveal,
          reviewConflict, cloudProjectId, artifactRefreshing, showLatestArtifact,
          blockedReason, runLeaseNote, setupReasonFor, saving,
          chat, closeVersion, openVersion, chatToggle,
          editorMenu, rebuildStep, showFailure, openSettingsFromRun,
          stop, notice, restoreVersion, changeDraft,
          startRun, undoRebuildRef, renameSpeaker, loadPartial,
          recordingChat, chatOpen, setCandidateNameEdits, commitCandidateName,
          setCompareOpen, changeSettings, settingsRef, setEditorTools,
        }} />;
    }
    return <RecordingScreen {...{
          capture, runningProject, chatBusyInProject, view,
          recordingInteractionBusy, chatToggle, folders, open,
          page, reorderPage, movePage, addDocPage,
          setDeleting, recordingTitle, controlsFor, rawTitle,
          focusTitle, editTitle, startRun, selectPage,
          recordingChat, chatOpen, loadPartial,
        }} />;
  }
