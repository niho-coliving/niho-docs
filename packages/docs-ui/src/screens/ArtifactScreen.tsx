"use client";

import { candidatesFor, type RunStartAction, type TranscriptSpeakerEntry } from "@niho/docs-core";
import { useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { EditorToolControls } from "../components/EditorTools";
import { type FailureAction } from "../components/FailureBand";
import { PageMenu, PageTop, type EditorMenuActions, type ExportActions } from "../components/PageTop";
import { CloudPageNotice } from "../components/SaveStatus";
import { StepActions, WorkView, stepExport, stepRunState } from "../components/WorkView";
import type { ArtifactAutosave } from "../lib/artifact-autosave";
import { type Bridge } from "../lib/bridge";
import { type ChatTarget } from "../lib/chat";
import type { CloudController } from "../lib/cloud";
import { artifactPath, cloudSettled, pathHasConflict, saveStatus } from "../lib/cloud";
import { finalizeMarkdown, isMarkdownChanged } from "../lib/markdown";
import { recordingRef, stepMarkdown, stepName, type RecordingView } from "../lib/project-view";
import { type ActiveRun, type RunNotice } from "../lib/run-state";
import { type AppSettings } from "../lib/settings";
import { type ChatController } from "../lib/use-chat";
import type { GoogleDocsController } from "../lib/use-google-docs";
import { artifactSaveKey, draftKey, titleKey, versionKey, type Draft, type OpenedArtifactDocument, type RebuildRequest, type RebuildUndo, type ViewingVersion } from "./workspace-model";

import type { ProjectSyncSnapshot } from "../lib/cloud-types";

type Props = {
  pageId: string;
  titleEdits: Record<string, string>;
  currentArtifactId: string | null;
  stepId: string;
  view: RecordingView;
  openedArtifact: OpenedArtifactDocument | null;
  documentScopeId: string | null;
  autosave: ArtifactAutosave;
  currentDraft: Draft | undefined;
  viewingShown: ViewingVersion | null;
  cloud: CloudController;
  snapshot: ProjectSyncSnapshot | null;
  activeRun: ActiveRun | null;
  selectedTarget: ChatTarget | null;
  settings: AppSettings;
  copy: (markdown: string) => Promise<void>;
  exportFile: (markdown: string, recordingTitle: string) => Promise<void>;
  recordingTitle: string;
  accountShown: boolean;
  googleDocs: GoogleDocsController;
  bridge: Bridge;
  reveal: () => Promise<void>;
  reviewConflict: (projectId: string, path: string | null) => Promise<void>;
  cloudProjectId: string;
  artifactRefreshing: boolean;
  showLatestArtifact: () => Promise<void>;
  blockedReason: string | null;
  runLeaseNote: (rec: RecordingView) => string | null;
  setupReasonFor: (queue: readonly string[], mode?: boolean | RunStartAction) => string | null;
  saving: boolean;
  chat: ChatController;
  closeVersion: () => void;
  openVersion: (version: number, versionPath?: string) => Promise<void>;
  chatToggle: React.JSX.Element;
  editorMenu: EditorMenuActions | null;
  rebuildStep: (id: string) => void;
  showFailure: (text: string, action?: FailureAction) => void;
  openSettingsFromRun: () => void;
  stop: () => Promise<void>;
  notice: RunNotice | null;
  restoreVersion: () => Promise<void>;
  changeDraft: (markdown: string) => void;
  startRun: (queue: string[], fixedTarget?: (ChatTarget & { instruction?: string; }) | null, trigger?: "selection" | "step", rebuild?: RebuildRequest | null, action?: RunStartAction | null) => boolean;
  undoRebuildRef: MutableRefObject<(undo: RebuildUndo) => Promise<void>>;
  renameSpeaker: (speaker: TranscriptSpeakerEntry, requestedName: string | null) => Promise<void>;
  loadPartial: (runId: string) => Promise<string | null>;
  recordingChat: ChatController;
  chatOpen: boolean;
  setCandidateNameEdits: Dispatch<SetStateAction<Record<string, string>>>;
  commitCandidateName: (target: ChatTarget, name: string) => Promise<void>;
  setCompareOpen: Dispatch<SetStateAction<boolean>>;
  changeSettings: (next: AppSettings) => void;
  settingsRef: MutableRefObject<AppSettings>;
  setEditorTools: Dispatch<SetStateAction<EditorToolControls | null>>;
};

/** ArtifactScreen の描画。保存・実行・遷移の操作は controller から受け取る。 */
export function ArtifactScreen(props: Props) {
  const [sharePublished, setSharePublished] = useState<{ key: string; active: boolean } | null>(null);
  const [shareRequest, setShareRequest] = useState<{ key: string; count: number } | null>(null);
  const {
    pageId, titleEdits,
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
  } = props;

      // 保存の状態と、別の Mac の更新・両方の変更の知らせ（古い版を開いている間は出さない）
      const artifactId = currentArtifactId ?? stepId;
      const file = artifactPath(recordingRef(view), artifactId);
      const key = draftKey(view.key, artifactId);
      const local = openedArtifact?.key === key && openedArtifact.scopeId === documentScopeId
        ? autosave.states[artifactSaveKey(key, openedArtifact.scopeId)]
        : undefined;
      const captureReady = openedArtifact?.key === key && openedArtifact.scopeId === documentScopeId;
      const savedText = stepMarkdown(view, stepId);
      const unsaved =
        (local !== undefined && local.phase !== "saved") ||
        (currentDraft !== undefined && (savedText === undefined || isMarkdownChanged(currentDraft.markdown, savedText)));
      const contextGeneration = cloud.state?.contextGeneration ?? null;
      const shareKey = `${contextGeneration ?? "none"}:${cloudProjectId}:${pageId}:${stepId}`;
      const openSharing = () => setShareRequest((current) => ({ key: shareKey, count: current?.key === shareKey ? current.count + 1 : 1 }));
      const sharing = selectedTarget || viewingShown ? undefined : {
        bridge,
        locator: { pageId, projectId: cloudProjectId, textId: stepId },
        contextGeneration,
        loggedIn: cloud.active,
        saved: savedText !== undefined && !unsaved && !saving && activeRun === null
          && cloudSettled(snapshot) && Boolean(snapshot?.lastSyncedAt)
          && titleEdits[titleKey(view.projectId, pageId)] === undefined,
        onActive: (active: boolean) => setSharePublished({ key: shareKey, active }),
      };
      const status = viewingShown
        ? null
        : saveStatus({ local: local?.phase ?? "saved", savedGeneration: local?.generation ?? null, path: file, cloud: cloud.state, snapshot });
      const exported = stepExport({
        view,
        stepId,
        activeRun,
        draft: currentDraft?.markdown,
        viewing: viewingShown,
        target: selectedTarget,
        showTimestamps: settings.transcription.showTimestamps,
      });
      const stepExportActions: ExportActions | null = exported && {
        disabled: exported.disabled,
        onCopy: () => void copy(exported.markdown),
        onExportFile: () => void exportFile(exported.markdown, recordingTitle),
        onExportGoogle: accountShown ? () => googleDocs.openExport({
          sourceKey: `${view.key}:${stepId}:${viewingShown?.version ?? "latest"}`,
          title: stepName(view, stepId),
          markdown: finalizeMarkdown(exported.markdown),
        }) : undefined,
        onReveal: bridge.capabilities?.fileReveal === false ? undefined : () => void reveal(),
        sharing,
        sharingRequest: shareRequest?.key === shareKey ? shareRequest.count : 0,
      };
      const banner = pathHasConflict(snapshot, file) ? (
        <CloudPageNotice text="別の Mac でも変更されています。" action="変更を確認" onAction={() => void reviewConflict(cloudProjectId, file)} />
      ) : (cloud.active && snapshot?.deferred.includes(file)) || artifactRefreshing ? (
        <CloudPageNotice
          text="別の Mac で更新されています。"
          action="最新を表示"
          busy={artifactRefreshing}
          disabled={unsaved}
          onAction={() => void showLatestArtifact()}
        />
      ) : null;
      // 録音から作ったページ（案でないもの）の ⋯ の「作り直す」。押せるかは本文の上の実行の帯と同じ判定（理由は帯が出す。#18915）
      const rebuildState = selectedTarget
        ? null
        : stepRunState({ view, stepId, activeRun, blockedReason, leaseNote: runLeaseNote(view), setupReasonFor, saving, target: null, chat });
      const rebuildDisabled = !rebuildState || !rebuildState.rerunnable || rebuildState.runBlocked;
      return (
        <>
          <PageTop>
            <StepActions
              view={view}
              stepId={stepId}
              activeRun={activeRun}
              viewing={viewingShown}
              onOpenVersion={(version, versionPath) => (version === null ? closeVersion() : void openVersion(version, versionPath))}
              target={selectedTarget}
            />
            {chatToggle}
            {/* 成果物の子ページは削除・移動しない。操作メニューには「作り直す」も含める。 */}
            {(stepExportActions || editorMenu || (!selectedTarget && !viewingShown)) && (
              <PageMenu
                editor={editorMenu}
                exportActions={stepExportActions}
                onRebuild={selectedTarget || viewingShown ? undefined : () => rebuildStep(stepId)}
                rebuildDisabled={rebuildDisabled}
              />
            )}
          </PageTop>
          <WorkView
            bridge={bridge}
            onError={showFailure}
            view={view}
            stepId={stepId}
            recordingTitle={recordingTitle}
            activeRun={activeRun}
            anyRunActive={activeRun !== null}
            blockedReason={blockedReason}
            leaseNote={runLeaseNote(view)}
            setupReasonFor={setupReasonFor}
            onOpenSettings={openSettingsFromRun}
            onStop={() => void stop()}
            notice={notice}
            sharingActive={Boolean(sharing && sharePublished?.key === shareKey && sharePublished.active)}
            onOpenSharing={openSharing}
            draft={currentDraft?.markdown}
            viewing={viewingShown}
            onRestoreVersion={() => void restoreVersion()}
            onCloseVersion={closeVersion}
            onDraftChange={changeDraft}
            onRunStep={(id) => startRun([id], selectedTarget)}
            onRebuild={selectedTarget ? undefined : () => rebuildStep(stepId)}
            onUndoOverwritten={selectedTarget ? undefined : (created, previous) => {
              if (typeof created.version !== "number" || typeof previous.version !== "number") return;
              void undoRebuildRef.current({
                rec: recordingRef(view), viewKey: view.key, stepId, stepName: stepName(view, stepId),
                previousVersion: previous.version,
                ...(previous.versionPath ? { previousPath: previous.versionPath } : {}),
                createdVersion: created.version, createdKey: versionKey(created),
              });
            }}
            onRunRemaining={() => startRun(view.plan.remaining, selectedTarget)}
            onRenameSpeaker={(speaker, name) => void renameSpeaker(speaker, name)}
            saving={saving}
            documentRevision={captureReady ? openedArtifact.handle : "opening"}
            documentReady={captureReady}
            loadPartial={loadPartial}
            chat={recordingChat}
            chatOpen={chatOpen}
            saveStatus={status}
            banner={banner}
            target={selectedTarget}
            onCandidateNameChange={selectedTarget ? (name) => setCandidateNameEdits((all) => ({ ...all, [selectedTarget.candidateId]: name })) : undefined}
            onCandidateNameCommit={selectedTarget ? (name) => void commitCandidateName(selectedTarget, name) : undefined}
            onCompare={selectedTarget && candidatesFor(view.recording, stepId).length > 1 ? () => setCompareOpen(true) : undefined}
            showTimestamps={settings.transcription.showTimestamps}
            onShowTimestampsChange={(showTimestamps) =>
              changeSettings({
                ...settingsRef.current,
                transcription: { ...settingsRef.current.transcription, showTimestamps },
              })
            }
            onEditorTools={setEditorTools}
          />
        </>
      );

}
