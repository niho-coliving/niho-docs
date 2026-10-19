"use client";

import { DEFAULT_EXECUTION_PREFERENCES, DEFAULT_SPEAKER_MODE, createBlankFlow, createFlowSnapshot, defaultRecordingLanguage, folderName, folderRecordingPage, pageTitle, parseExecutionPreferences, sameFlowContent, unregisteredSnapshotSteps, type About, type ExecutionPreferences, type Flow, type PromptRef } from "@niho/docs-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountDialogLayer } from "../components/AccountDialogLayer";
import { CloudNotice } from "../components/CloudNotice";
import { DocsComposerRailProvider } from "../components/DocsComposerRail";
import { FailureBand, type FailureAction } from "../components/FailureBand";
import { type RecentRow } from "../components/Home";
import { LoginRequired } from "../components/LoginRequired";
import { Rail, type Screen, type Selection } from "../components/Rail";
import { RecordingPanel, RecordingProblemNote } from "../components/Recording";
import { RemoteProjectRows } from "../components/RemoteProjects";
import { StorageChoice } from "../components/StorageChoice";
import { StorageReopeningPending } from "../components/StorageReopeningPending";
import { UpdateNotice } from "../components/UpdateNotice";
import { controllerHost } from "../host/controller-host";
import type { DocsAccount as NihoAccount } from "../host/DocsAccount";
import type { DocsWorkspaceHost } from "../host/DocsWorkspaceHost";
import { VaultWorkspace } from "./VaultWorkspace";
import type { DocsHost } from "../host/DocsHost";
import { useAppRecording, type CaptureTarget } from "../lib/app-recording";
import { errorMessage, type Bridge, type FlowList as FlowListData, type ProjectId, type RecentId, type RecordingRef } from "../lib/bridge";
import { cloudSettled, leaseRunNote, remoteLeaseHolder, cloudProjectId as toCloudProjectId } from "../lib/cloud";
import { formatRecordingLength, newId } from "../lib/format";
import { THIS_MAC_STATUS_UNAVAILABLE, resolveThisMacSelection, type PcRunnerStatus } from "../lib/pc-runner";
import { loadRecordingView, openProjectOf, recordingKey, recordingProgress, type OpenProject, type RecordingView } from "../lib/project-view";
import { DELIVERY_ACK_PENDING_NOTICE, runBlockedReason } from "../lib/run-state";
import { activeProfiles, activeProviders, transcriptionEngineChoices } from "../lib/settings";
import { useGoogleDocs } from "../lib/use-google-docs";
import { useGoogleDocsFolderExport } from "../lib/use-google-docs-folder-export";
import { FlowDesignScreen } from "./FlowDesignScreen";
import { SettingsScreen } from "./SettingsScreen";
import { useAccountAvailability } from "./useAccountAvailability";
import { useArtifactActions } from "./useArtifactActions";
import { useCloudWorkspace } from "./useCloudWorkspace";
import { useDocsStartup } from "./useDocsStartup";
import { useExecutionActions } from "./useExecutionActions";
import { useFlowActions } from "./useFlowActions";
import { useFolderActions } from "./useFolderActions";
import { usePageNavigation } from "./usePageNavigation";
import { useRunReadiness } from "./useRunReadiness";
import { useSettingsActions } from "./useSettingsActions";
import { useWorkspaceChat } from "./useWorkspaceChat";
import { useWorkspaceCloseGuard } from "./useWorkspaceCloseGuard";
import { useWorkspacePersistence } from "./useWorkspacePersistence";
import { useWorkspaceState } from "./useWorkspaceState";
import { WorkScreen } from "./WorkScreen";
import { DOC_FLUSH_FAILED, NO_RECORDING, defaultFlowOf, designFlowOf, type FlowOrigin, type OpenedArtifactDocument, type ToastAction } from "./workspace-model";
import { WorkspaceDialogs } from "./WorkspaceDialogs";

export function DocsApp(props: { bridge: DocsHost; account: NihoAccount } | { bridge: DocsWorkspaceHost }) {
  if ("kind" in props.bridge && props.bridge.kind === "vault-workspace") return <VaultWorkspace host={props.bridge} />;
  if (!("account" in props)) throw new Error("DocsAccount is required for the legacy host");
  return <LegacyDocsApp bridge={props.bridge as DocsHost} account={props.account} />;
}

function LegacyDocsApp(props: { bridge: DocsHost; account: NihoAccount }) {
  const bridge = useMemo(() => controllerHost(props.bridge), [props.bridge]);
  return (
    <div data-docs-app-root data-docs-shared-ui className="docs-app-content">
      <DocsComposerRailProvider account={props.account}>
        <DocsWorkspace bridge={bridge} account={props.account} />
      </DocsComposerRailProvider>
      <AccountDialogLayer />
    </div>
  );
}

function DocsWorkspace(props: { bridge: Bridge; account: NihoAccount }) {
  const { bridge, account } = props;
  const {
    phase, setPhase, fatal, setFatal,
    settings, setSettings, flows, setFlows,
    lastUsedFlowId, setLastUsedFlowId, flowDrafts, setFlowDrafts,
    designFlowId, setDesignFlowId, focusFlowName, setFocusFlowName,
    flowsBusy, setFlowsBusy, flowImporting, setFlowImporting,
    deletingFlow, setDeletingFlow, about, setAbout,
    aboutLoad, setAboutLoad, confirmUpdate, setConfirmUpdate,
    updatingFlow, setUpdatingFlow, flowChange, setFlowChange,
    flowChanging, setFlowChanging, flowOrigin, setFlowOrigin,
    flowOriginRef, readiness, setReadiness, readinessKeyRef,
    accountOpen, setAccountOpen, folders, setFolders,
    outside, setOutside, open, setOpen,
    selection, setSelection, view, setView,
    titleEdits, setTitleEdits, focusTitle, setFocusTitle,
    focusFolderTitle, setFocusFolderTitle, chatOpen, setChatOpen,
    chatUnseen, setChatUnseen, editorTools, setEditorTools,
    editorToolsRef, docReload, setDocReload, deleting,
    setDeleting, deleteBusy, setDeleteBusy, discardingCapture,
    setDiscardingCapture, screen, setScreen, aboutLeaveOpen,
    setAboutLeaveOpen, aboutSaving, setAboutSaving, infoEditing,
    setInfoEditing, candidateDialog, setCandidateDialog, candidateBusy,
    setCandidateBusy, compareOpen, setCompareOpen, candidateNameEdits,
    setCandidateNameEdits, docsRoot, setDocsRoot, activeRun,
    setActiveRun, notice, setNotice, personalNihoPending,
    setPersonalNihoPending, nihoRunConfirmation, setNihoRunConfirmation, draftsState,
    setDrafts, saving, setSaving, recordingInteractionBusy,
    setRecordingInteractionBusy, busy, setBusy, toast,
    setToast, failure, setFailure, closeConfirm,
    setCloseConfirm, closing, setClosing, closeFailed,
    setCloseFailed, recent, setRecent, fileDropOver,
    setFileDropOver, fileDropHandlerRef, capabilitiesRef, startupRetry,
    setStartupRetry, changingRoot, setChangingRoot, conflictReview,
    setConflictReview, openingRemote, setOpeningRemote, aboutEditing,
    setAboutEditing, cloudDocReload, setCloudDocReload, artifactRefreshing,
    setArtifactRefreshing, openedArtifact, setOpenedArtifact, artifactCaptureReload,
    setArtifactCaptureReload, viewingVersion, setViewingVersion, runRef,
    runAbortRef, runFlushRef, nihoRunConfirmationRef, continuationChainRef,
    savingRef, speakerSavingRef, flowsRef, lastUsedFlowRef,
    flowEditsRef, flowChangingRef, flowsBusyRef, flowImportingRef,
    infoDirtyRef, discardOnCloseRef, recordingActiveRef, recordingStoppedForCloseRef,
    autosaveFailureRef, aboutRef, aboutSaveRef, screenRef,
    aboutDirtyRef, aboutSavingRef, pendingAboutActionRef, discardAboutRef,
    flushAboutRef, settingsRef, persistedSettingsRef, cloudActiveRef, persistSettings,
    viewRef, draftsStateRef, draftScopeRef, draftsByScopeRef,
    openedArtifactRef, artifactGenerationReloadRef, openRef, selectionRef,
    showPageRequestRef, openProjectRequestRef, navigationRef, docFlushRef,
    latestMarkdownRef, toastTimer, undoRebuildRef, flushTimer,
    rootChangeRef, createBusyRef, dropBusyRef, moveBusyRef,
    recordingInteractionRef, chatSendingProjectRef, modalOpenRef, titleEditsRef,
    recentTouchRef,
  } = useWorkspaceState({
    bridge,
  });

  const updateRecordingInteraction = useCallback((blocked: boolean) => {
    recordingInteractionRef.current = blocked;
    setRecordingInteractionBusy(blocked);
  }, [recordingInteractionRef, setRecordingInteractionBusy]);

  const applyScreen = (next: Screen) => {
    screenRef.current = next;
    setScreen(next);
  };

  /** 後から選んだ画面で、進行中の場所・ページ読込もまとめて失効させる。 */
  const markNavigation = () => {
    navigationRef.current++;
    openProjectRequestRef.current++;
    showPageRequestRef.current++;
    putFlowOrigin(null);
    // 表示を消すだけだと、確認を待つ実行が残って operation と run lock が解放されない（同じ録音の別ページへ移ると view.key が変わらず、abort の effect も走らない）。
    nihoRunConfirmationRef.current?.cancel();
    setNihoRunConfirmation(null);
    setFailure(null);
  };
  const putFlowOrigin = (next: FlowOrigin | null) => {
    flowOriginRef.current = next;
    setFlowOrigin(next);
  };
  const googleDocs = useGoogleDocs({ bridge, account, onOpenSettings: () => applyScreen("settings") });

  /** 未保存の「あなたについて」があるときは、画面遷移や保存先変更を確認する。 */
  const guardAboutLeave = (action: () => void): boolean => {
    if (screenRef.current === "settings" && (aboutDirtyRef.current || aboutSavingRef.current)) {
      pendingAboutActionRef.current = action;
      void flushAboutRef.current().then(
        (saved) => {
          if (pendingAboutActionRef.current !== action) return;
          if (saved && !aboutDirtyRef.current && !aboutSavingRef.current) {
            pendingAboutActionRef.current = null;
            action();
          } else {
            setAboutLeaveOpen(true);
          }
        },
        () => {
          if (pendingAboutActionRef.current === action) setAboutLeaveOpen(true);
        },
      );
      return false;
    }
    return true;
  };

  const reportAboutState = (state: { dirty: boolean; saving: boolean }) => {
    aboutDirtyRef.current = state.dirty;
    aboutSavingRef.current = state.saving;
    setAboutSaving(state.saving);
    setAboutEditing(state.dirty || state.saving);
  };

  const discardAboutAndContinue = () => {
    if (aboutSavingRef.current) return;
    const action = pendingAboutActionRef.current;
    pendingAboutActionRef.current = null;
    setAboutLeaveOpen(false);
    discardAboutRef.current();
    aboutDirtyRef.current = false;
    action?.();
  };

  const returnToAbout = () => {
    pendingAboutActionRef.current = null;
    setAboutLeaveOpen(false);
  };

  /**
   * 成功の確認（「保存しました」など）。2.2 秒で消える。失敗・断った理由は showFailure（#18788）。操作（「作り直しました」の
   * 「元に戻す」。#18915）を添えたときは、押せるよう 6 秒出す。
   */
  const showToast = useCallback((text: string, action?: ToastAction) => {
    setFailure(null);
    setToast(action ? { text, action } : { text });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), action ? 6000 : 2200);
  }, [setFailure, setToast, toastTimer]);
  const clearToast = useCallback(() => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = null;
    setToast(null);
  }, [setToast, toastTimer]);

  /** 失敗と理由をページの帯に残す（消えない。次の成功・ページの移動・「閉じる」で消す）。行動があれば帯に出す。 */
  const showFailure = useCallback((text: string, action?: FailureAction) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = null;
    setToast(null);
    setFailure(action ? { text, action } : { text });
  }, [setFailure, setToast, toastTimer]);

  // ブラウザから戻ったログイン結果を、画面を移動していても通知する（失敗は帯に残す）。
  const { notice: accountNotice, dismissNotice: dismissAccountNotice } = account;
  useEffect(() => {
    if (!accountNotice) return;
    if (accountNotice.kind === "error") showFailure(accountNotice.message);
    else showToast(accountNotice.message);
    dismissAccountNotice();
  }, [accountNotice, dismissAccountNotice, showFailure, showToast]);

  const putOpen = useCallback((next: OpenProject | null) => {
    openRef.current = next;
    setOpen(next);
  }, [openRef, setOpen]);
  const putView = useCallback((next: RecordingView | null) => {
    viewRef.current = next;
    setView(next);
  }, [setView, viewRef]);
  const putOpenedArtifact = useCallback((next: OpenedArtifactDocument | null) => {
    openedArtifactRef.current = next;
    setOpenedArtifact(next);
  }, [openedArtifactRef, setOpenedArtifact]);
  const putSelection = useCallback((next: Selection | null) => {
    selectionRef.current = next;
    setSelection(next);
  }, [selectionRef, setSelection]);

  screenRef.current = screen;
  modalOpenRef.current = candidateDialog !== null || compareOpen || aboutLeaveOpen || deleting !== null || deletingFlow !== null || confirmUpdate || flowChange !== null || closeConfirm !== null;
  titleEditsRef.current = titleEdits;

  /** フローの並びと最後に使ったフローを画面へ（読み直した一覧か、保存した後の値）。 */
  const putFlows = useCallback((list: readonly Flow[], lastUsed: string | null) => {
    // 読み込んだ並び（readonly）を、画面の状態と ref が持つ変更できる配列にして渡す
    const next = [...list];
    flowsRef.current = next;
    setFlows(next);
    lastUsedFlowRef.current = lastUsed;
    setLastUsedFlowId(lastUsed);
  }, [flowsRef, lastUsedFlowRef, setFlows, setLastUsedFlowId]);

  const reloadFlows = useCallback(async (): Promise<FlowListData> => {
    const list = await bridge.listFlows();
    putFlows(list.flows, list.lastUsed);
    return list;
  }, [bridge, putFlows]);

  /** フローの編集中の内容（flowEditsRef）を変え、保存済みと違うものだけを画面の flowDrafts に出す。null は捨てる。 */
  const putFlowEdit = useCallback((flowId: string, edit: Flow | null) => {
    const edits = { ...flowEditsRef.current };
    if (edit) edits[flowId] = edit;
    else delete edits[flowId];
    flowEditsRef.current = edits;
    const saved = flowsRef.current.find((candidate) => candidate.id === flowId);
    setFlowDrafts((all) => {
      const next = { ...all };
      if (edit && !(saved && sameFlowContent(edit, saved))) next[flowId] = edit;
      else delete next[flowId];
      return next;
    });
  }, [flowEditsRef, flowsRef, setFlowDrafts]);

  /** 最後に使ったフローを変える（録音を作ったとき・録音の工程を変えたとき）。書けなくても次の既定が変わらないだけ。 */
  const rememberFlow = useCallback(
    async (flowId: string): Promise<boolean> => {
      if (lastUsedFlowRef.current === flowId) return true;
      try {
        await bridge.setLastUsedFlow(flowId);
      } catch {
        return false;
      }
      lastUsedFlowRef.current = flowId;
      setLastUsedFlowId(flowId);
      return true;
    },
    [bridge, lastUsedFlowRef, setLastUsedFlowId],
  );

  /** 読み込んだ「あなたについて」を画面と実行に反映する（設定のカードも開き直す）。 */
  const showAbout = useCallback((next: About) => {
    aboutRef.current = next;
    setAbout(next);
    setAboutLoad((count) => count + 1);
  }, [aboutRef, setAbout, setAboutLoad]);

  const refreshProjects = useCallback(async (shouldApply: () => boolean = () => true) => {
    const list = await bridge.listProjects();
    const [loaded, root] = await Promise.all([
      Promise.all(list.map((entry) => bridge.loadPages(entry.id))),
      bridge.loadPages(null),
    ]);
    if (shouldApply()) {
      setFolders(loaded.map(openProjectOf));
      setOutside(openProjectOf(root));
    }
    return list;
  }, [bridge, setFolders, setOutside]);

  /** 開いている場所を読み直す（ページの一覧・録音の子ページ・文書の更新時刻）。 */
  const reloadOpen = useCallback(
    async (projectId: ProjectId): Promise<OpenProject> => {
      const next = openProjectOf(await bridge.loadPages(projectId));
      if (openRef.current?.id === projectId) putOpen(next);
      if (projectId !== null) {
        setFolders((all) => all.map((folder) => (folder.id === projectId ? next : folder)));
      } else setOutside(next);
      return next;
    },
    [bridge, openRef, putOpen, setFolders, setOutside],
  );

  /** 録音を読み直す（実行・保存の後）。開いている案件の一覧（レールの子ページ）も読み直し、その録音を見ていれば差し替える。 */
  const reloadView = useCallback(
    async (rec: RecordingRef, frozenRefs?: readonly PromptRef[], shouldApply: () => boolean = () => true): Promise<RecordingView> => {
      const loaded = await bridge.loadPages(rec.projectId);
      const opened = openProjectOf(loaded);
      const entry = opened.pages.find((page) => (page.recordingId ?? page.id) === rec.recordingId && page.kind === "rec");
      if (!entry) throw NO_RECORDING;
      const next = await loadRecordingView(bridge, rec.projectId, opened.project, entry, frozenRefs);
      if (shouldApply() && openRef.current?.id === rec.projectId) {
        putOpen(opened);
        // 録音のページ・成果物の子ページか、フォルダの背景情報のページ（フォルダの録音を出している。#18914）
        const selected = selectionRef.current;
        if (selected ? selected.pageId === entry.id : rec.projectId !== null && viewRef.current?.recordingId === rec.recordingId) putView(next);
      }
      return next;
    },
    [bridge, openRef, putOpen, putView, selectionRef, viewRef],
  );
  const {
    selectedStepId, selectedTarget, documentChat, cloud,
    documentScopeId, cloudContextRef, drafts, draftsRef,
    chat, chatToggleState,
  } = useWorkspaceChat({
    selection,
    view,
    candidateNameEdits,
    open,
    bridge,
    runAbortRef,
    nihoRunConfirmationRef,
    setNihoRunConfirmation,
    setPersonalNihoPending,
    setNotice,
    runRef,
    draftScopeRef,
    draftsState,
    draftsByScopeRef,
    draftsStateRef,
    setDrafts,
    settings,
    about,
    activeRun,
    reloadView,
    refreshProjects,
    showToast,
    docFlushRef,
    openRef,
    selectionRef,
    setDocReload,
    reloadOpen,
    showFailure,
    get selectPage() { return selectPage; },
    savingRef,
    get autoVersion() { return autoVersion; },
    get copy() { return copy; },
    chatSendingProjectRef,
    chatOpen,
    setChatUnseen,
    chatUnseen,
  });
  cloudActiveRef.current = cloud.active;
  useEffect(() => {
    if (cloud.state?.storage?.mode !== "LOCAL" || bridge.capabilities?.personalDeviceDelivery !== true) return;
    let cancelled = false;
    let running = false;
    const pendingMessage = "結果はこの Mac に保存済みですが、NIHO への受領通知を確認できません。接続を確認してから、この画面に戻ってください。";
    const recover = () => {
      if (running) return;
      running = true;
      void bridge.personalDeviceRecoverAcks().then(({ pending }) => {
        if (cancelled) return;
        if (pending > 0) showFailure(pendingMessage);
        else {
          setFailure((current) => current?.text === pendingMessage ? null : current);
          setNotice((current) => current?.message === DELIVERY_ACK_PENDING_NOTICE ? null : current);
        }
      }).catch(() => undefined).finally(() => { running = false; });
    };
    recover();
    window.addEventListener("focus", recover);
    return () => { cancelled = true; window.removeEventListener("focus", recover); };
  }, [bridge, cloud.state?.storage?.mode, cloud.state?.contextGeneration, setFailure, setNotice, showFailure]);
  const [accountExecution, setAccountExecution] = useState<{
    phase: "local" | "loading" | "ready" | "error";
    preferences: ExecutionPreferences | null;
    problem: string | null;
    /**
     * 選んだ実行先を保存する前に、前提を満たさず受け付けなかった理由（#19107。この Mac の受け入れが OFF など）。実行先は変えて
     * いないので、`problem` と違って実行の開始は止めない。実行先を読み直す（受け入れの状態が変わる）と消える。
     */
    notice?: string | null;
  }>({ phase: "local", preferences: null, problem: null });
  const accountExecutionSavingRef = useRef(false);
  const executionLoadRef = useRef(0);
  const profileSnapshot = cloud.snapshots.profile ?? null;
  const profileRevision = profileSnapshot
    ? `${profileSnapshot.lastSyncedAt ?? ""}:${profileSnapshot.localGeneration}:${profileSnapshot.acknowledgedGeneration}:${profileSnapshot.conflicts.filter((entry) => entry.status === "open").length}`
    : "";
  const accountExecutionSynced = !cloud.active || (
    profileSnapshot !== null && profileSnapshot.lastSyncedAt !== null && cloudSettled(profileSnapshot)
  );
  const loadAccountExecution = useCallback(async () => {
    if (accountExecutionSavingRef.current) return;
    const request = ++executionLoadRef.current;
    setAccountExecution({ phase: "loading", preferences: null, problem: "アカウントの実行先を確認しています。" });
    if (!accountExecutionSynced) return;
    try {
      const [stored, runner] = await Promise.all([bridge.loadExecution(), bridge.pcRunnerStatus().catch(() => null)]);
      if (request !== executionLoadRef.current) return;
      const preferences = parseExecutionPreferences(stored ?? DEFAULT_EXECUTION_PREFERENCES);
      let problem: string | null = null;
      const continuation = preferences.route === "cloud" ? "niho_api" : "this_pc";
      if (preferences.route === "own_mac") {
        if (!preferences.preferredMacRunnerId) {
          problem = "実行先の Mac が選ばれていません。iPhone または Web の設定で使う Mac を選んでください。";
        } else if (!runner?.enabled || runner.runnerId !== preferences.preferredMacRunnerId) {
          problem = "選んだ Mac を利用できません。選んだ Mac で「この Mac で続きを受ける」をオンにするか、設定で実行先を選び直してください。";
        }
      }
      const next = { ...settingsRef.current, personalExecution: { continuation } } as typeof settings;
      settingsRef.current = next;
      setSettings(next);
      setAccountExecution({ phase: "ready", preferences, problem });
    } catch {
      if (request !== executionLoadRef.current) return;
      setAccountExecution({
        phase: "error", preferences: null,
        problem: "アカウントの実行先を読み込めません。接続を確かめてから、設定を開き直してください。",
      });
    }
  }, [accountExecutionSynced, bridge, setSettings, settingsRef]);
  useEffect(() => {
    if (phase !== "ready") return;
    if (!cloud.active) {
      executionLoadRef.current += 1;
      const local = persistedSettingsRef.current;
      settingsRef.current = local;
      setSettings(local);
      setAccountExecution({ phase: "local", preferences: null, problem: null });
      return;
    }
    if (!accountExecutionSynced) void cloud.refreshSnapshot("profile");
    void loadAccountExecution();
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void bridge.onPcRunnerState(() => void loadAccountExecution()).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [accountExecutionSynced, bridge, cloud.active, cloud.refreshSnapshot, loadAccountExecution, phase, profileRevision]);

  const changeAccountExecution = (continuation: typeof settings.personalExecution.continuation) => {
    if (!cloud.active || accountExecutionSavingRef.current || accountExecution.phase === "loading") return;
    const previous = settingsRef.current.personalExecution;
    const before = accountExecution;
    accountExecutionSavingRef.current = true;
    setAccountExecution((current) => ({ ...current, phase: "loading", problem: "アカウントの実行先を保存しています。", notice: null }));
    // 保存の前に、選べない理由がわかったとき（#19107）。保存は呼ばず、今の実行先のまま理由を 1 行で出す。保存の失敗（下の catch）とは分ける。
    const declineSelection = (notice: string) => setAccountExecution({ ...before, notice });
    void (async () => {
      try {
        let preferences: ExecutionPreferences;
        if (continuation === "niho_api") {
          preferences = DEFAULT_EXECUTION_PREFERENCES;
        } else {
          let runner: PcRunnerStatus;
          try {
            runner = await bridge.pcRunnerStatus();
          } catch (error) {
            declineSelection(errorMessage(error, THIS_MAC_STATUS_UNAVAILABLE));
            return;
          }
          const selection = resolveThisMacSelection(runner);
          if (!selection.ok) {
            declineSelection(selection.reason);
            return;
          }
          preferences = { version: 1, route: "own_mac", preferredMacRunnerId: selection.runnerId };
        }
        await bridge.saveExecution(preferences);
        const saved = { ...settingsRef.current, personalExecution: { continuation } };
        settingsRef.current = saved;
        setSettings(saved);
        setAccountExecution({ phase: "ready", preferences, problem: null });
      } catch (error) {
        const restored = { ...settingsRef.current, personalExecution: previous };
        settingsRef.current = restored;
        setSettings(restored);
        setAccountExecution({ phase: "error", preferences: accountExecution.preferences,
          problem: errorMessage(error, "アカウントの実行先を保存できませんでした。もう一度お試しください。") });
      } finally {
        accountExecutionSavingRef.current = false;
      }
    })();
  };
  const {
    autosave, flushArtifacts, autoVersion, createAutoVersions,
    flushDoc, flushDocAndVersion, flushDocForLeave,
  } = useWorkspacePersistence({
    chat,
    runRef,
    runFlushRef,
    runAbortRef,
    bridge,
    draftScopeRef,
    draftsByScopeRef,
    draftsRef,
    autosaveFailureRef,
    showFailure,
    setFailure,
    speakerSavingRef,
    viewRef,
    openedArtifactRef,
    reloadView,
    activeRun,
    docFlushRef,
  });

  // フォルダの書き出し: CLOUD は同期後の本文、LOCAL はこの Mac の確定済み snapshot を使う。
  const folderExport = useGoogleDocsFolderExport({
    bridge,
    account,
    googleDocs,
    onOpenSettings: () => applyScreen("settings"),
    local: cloud.state?.storage?.mode === "LOCAL" && bridge.capabilities?.localFolderExport === true,
    syncState: (projectId) => {
      if (cloud.state?.storage?.mode === "LOCAL") return bridge.capabilities?.localFolderExport ? "settled" : "unavailable";
      if (!cloud.active) return "unavailable";
      return cloudSettled(cloud.snapshots[toCloudProjectId(projectId)] ?? null) ? "settled" : "pending";
    },
    refreshSync: (projectId) => cloud.refreshSnapshot(toCloudProjectId(projectId)),
    defaultTimestamps: settings.transcription.showTimestamps,
  });
  const openFolderExport = (projectId: string) => {
    const folder = folders.find((item) => item.id === projectId);
    if (!folder) return;
    folderExport.open({
      projectId,
      folderName: folderName(folder.project),
      // そのフォルダを開いているなら、書きかけをこの Mac に書き残してから同期の状態を見る
      prepare: openRef.current?.id === projectId
        ? () => flushDocForLeave().then(() => true, () => false)
        : undefined,
    });
  };

  const rekeyMovedRecordingDrafts = (
    sourceProjectId: ProjectId,
    sourceRecordingId: string,
    targetProjectId: ProjectId,
    targetRecordingId: string,
  ) => {
    const sourcePrefix = `${recordingKey({ projectId: sourceProjectId, recordingId: sourceRecordingId })}::`;
    const targetPrefix = `${recordingKey({ projectId: targetProjectId, recordingId: targetRecordingId })}::`;
    if (sourcePrefix === targetPrefix) return;
    setDrafts((all) => {
      const next = { ...all };
      for (const [key, draft] of Object.entries(all)) {
        if (!key.startsWith(sourcePrefix)) continue;
        next[`${targetPrefix}${key.slice(sourcePrefix.length)}`] = draft;
        delete next[key];
      }
      return next;
    });
  };

  const touchRecent = useCallback((item: RecentId) => {
    recentTouchRef.current = recentTouchRef.current
      .catch(() => undefined)
      .then(async () => {
        const next = await bridge.touchRecent(item);
        setRecent(next);
      })
      .catch((error: unknown) => {
        showFailure(errorMessage(error, "最近に保存できませんでした。ページの内容は保存されています。"));
      });
  }, [bridge, recentTouchRef, setRecent, showFailure]);
  const {
    stopRecordingAndClose, discardAndClose,
  } = useWorkspaceCloseGuard({
    flowEditsRef,
    flowsRef,
    infoDirtyRef,
    bridge,
    recordingStoppedForCloseRef,
    recordingActiveRef,
    discardOnCloseRef,
    setCloseFailed,
    setCloseConfirm,
    flushDocAndVersion,
    flushAboutRef,
    showFailure,
    closing,
    setClosing,
  });

  /**
   * ページを出す（録音なら見え方を読んでから出す）。フォルダは背景情報のページ（selection は null）で、フォルダの録音があればその見え方を
   * 読んで「音声」に出す。フォルダの録音そのもの（stepId の無い選択。最近・起動・参考のチップなど）も背景情報のページを開く（録音の
   * ページは出さない。#18914）。成果物の子ページ（stepId）とフォルダの外の録音は今のまま。
   */
  const showPage = useCallback(
    async (project: OpenProject, next: Selection | null, shouldApply: () => boolean = () => true) => {
      const request = ++showPageRequestRef.current;
      const page = next ? project.pages.find((candidate) => candidate.id === next.pageId) : undefined;
      if (project.id !== null && (!next || !page || (page.kind === "rec" && next.stepId === null))) {
        const recordingPage = page?.kind === "rec" ? page : folderRecordingPage(project.pages);
        let loaded: RecordingView | null = null;
        if (recordingPage) {
          try {
            loaded = await loadRecordingView(bridge, project.id, project.project, recordingPage);
          } catch (error) {
            if (!shouldApply() || request !== showPageRequestRef.current || openRef.current?.id !== project.id) return;
            putSelection(null);
            putView(null);
            throw error;
          }
        }
        if (!shouldApply() || request !== showPageRequestRef.current || openRef.current?.id !== project.id) return;
        putSelection(null);
        putView(loaded);
        // 背景情報のページは、音声があれば最近にフォルダの録音として残す（起動のときに前回のページとして開き直す）
        if (recordingPage) touchRecent({ projectId: project.id, pageId: recordingPage.id, openedAt: new Date().toISOString() });
        return;
      }
      if (!next || !page) {
        if (!shouldApply()) return;
        putSelection(null);
        putView(null);
        return;
      }
      if (page.kind === "doc") {
        if (!shouldApply()) return;
        putSelection({ pageId: page.id, stepId: null });
        putView(null);
      } else {
        const loaded = await loadRecordingView(bridge, project.id, project.project, page);
        if (!shouldApply() || request !== showPageRequestRef.current || openRef.current?.id !== project.id) return;
        putSelection(next);
        putView(loaded);
      }
      const item = { projectId: project.id, pageId: page.id, openedAt: new Date().toISOString() };
      touchRecent(item);
    },
    [bridge, openRef, putSelection, putView, showPageRequestRef, touchRecent],
  );

  /** フォルダまたはフォルダ外を開く。フォルダはホーム、外側は既定で最初のページ。 */
  const openProject = useCallback(
    async (projectId: ProjectId, pageId: string | null = null): Promise<OpenProject> => {
      const request = ++openProjectRequestRef.current;
      await flushDocForLeave();
      const next = openProjectOf(await bridge.loadPages(projectId));
      if (request !== openProjectRequestRef.current) return next;
      putOpen(next);
      const page = (pageId ? next.pages.find((candidate) => candidate.id === pageId) : undefined) ?? (projectId === null ? next.pages[0] : undefined);
      await showPage(next, page ? { pageId: page.id, stepId: null } : null);
      return next;
    },
    [bridge, flushDocForLeave, openProjectRequestRef, putOpen, showPage],
  );

  /**
   * マイク録音の保存先（#18914）: 開いているフォルダの音声（「この Mac で録音」はその録音のページ）。フォルダを開いていなければ
   * （ホーム・フォルダの外・工程設計・設定）、保存のときに新しいフォルダを作る（projectId は null）。
   */
  const captureTarget = (pageId?: string): CaptureTarget => {
    const current = openRef.current;
    const folderId = screenRef.current === "work" && current && current.id !== null ? current.id : null;
    const flow = defaultFlowOf(flowsRef.current, lastUsedFlowRef.current) ?? createBlankFlow(newId("flow"));
    const settingsNow = settingsRef.current;
    return {
      root: docsRoot, projectId: folderId, pageId: folderId === null ? undefined : pageId, existing: folderId !== null && !!pageId,
      draft: {
        version: 1, id: "", createdAt: new Date().toISOString(),
        flowSnapshot: createFlowSnapshot(flow, activeProfiles(settingsNow), activeProviders(settingsNow), settingsNow.connection),
        source: { kind: "audio", audio: [] }, speakers: DEFAULT_SPEAKER_MODE, language: defaultRecordingLanguage(settingsNow.transcription.language), refs: [],
      },
    };
  };
  const capture = useAppRecording({
    bridge, root: docsRoot, fallback: () => captureTarget(), onError: showFailure,
    onSaved: async (rec) => {
      await reloadView(rec);
      await refreshProjects();
      if (!(await flushDocAndVersion())) {
        showFailure("録音を保存しました。文書の書きかけを保存してから、レールの背景情報を開いてください。");
        if (openRef.current?.id === rec.projectId) await reloadOpen(rec.projectId);
        return;
      }
      // フォルダの音声に入れたので、そのフォルダの背景情報のページを開く（#18914）
      if (!guardAboutLeave(() => { applyScreen("work"); void openProject(rec.projectId); })) return;
      applyScreen("work");
      await openProject(rec.projectId);
    },
  });
  recordingActiveRef.current = capture.active;
  const {
    refreshReadiness,
  } = useDocsStartup({
    bridge,
    capabilitiesRef,
    setReadiness,
    setPhase,
    setFatal,
    settingsRef,
    persistedSettingsRef,
    setSettings,
    setDocsRoot,
    showAbout,
    readinessKeyRef,
    putFlows,
    setFolders,
    setOutside,
    setRecent,
    putOpen,
    putSelection,
    putView,
    showFailure,
    startupRetry,
  });
  const {
    selectPage, selectLocationPage, rawTitleAt, rawTitle,
    inputTitle, commitTitle, commitFolderTitle, addDocPage,
    flowPick, setFlowPick, addRecordingPage, chooseFlowForRecording,
    processFileDrop, applyRailDrop, reorderPage, reorderFolder,
    deleteEmptyFolder, deletePage, movePage,
  } = usePageNavigation({
    guardAboutLeave,
    markNavigation,
    openRef,
    applyScreen,
    selectionRef,
    flushDocForLeave,
    showFailure,
    showPage,
    openProject,
    titleEdits,
    open,
    setTitleEdits,
    titleEditsRef,
    bridge,
    putOpen,
    setOutside,
    setFolders,
    refreshProjects,
    reloadOpen,
    createBusyRef,
    dropBusyRef,
    moveBusyRef,
    screenRef,
    navigationRef,
    setFailure,
    touchRecent,
    setFocusTitle,
    modalOpenRef,
    flowsRef,
    lastUsedFlowRef,
    settingsRef,
    rememberFlow,
    setFocusFolderTitle,
    setBusy,
    persistSettings,
    reloadFlows,
    putFlows,
    setDesignFlowId,
    editorToolsRef,
    screen,
    designFlowId,
    deletingFlow,
    recordingInteractionRef,
    rootChangeRef,
    setFileDropOver,
    runRef,
    chatSendingProjectRef,
    fileDropHandlerRef,
    capture,
    outside,
    folders,
    chat,
    rekeyMovedRecordingDrafts,
    putSelection,
    putView,
    showToast,
    deleting,
    setDeleting,
    setDeleteBusy,
    setDrafts,
    setNotice,
    viewRef,
  });
  const {
    chooseFlow, changeSettings: changeLocalSettings, saveAbout, changeRoot,
    chooseStartupRoot,
  } = useSettingsActions({
    guardAboutLeave,
    flowOriginRef,
    setBusy,
    flowsRef,
    bridge,
    persistSettings,
    settingsRef,
    reloadFlows,
    setDesignFlowId,
    showFailure,
    navigationRef,
    putFlowOrigin,
    runRef,
    chatSendingProjectRef,
    get rebuildRecordingFlow() { return rebuildRecordingFlow; },
    rememberFlow,
    selectLocationPage,
    showToast,
    chat,
    setSettings,
    persistedSettingsRef,
    capabilitiesRef,
    aboutSaveRef,
    aboutRef,
    setAbout,
    capture,
    rootChangeRef,
    setChangingRoot,
    flushDocForLeave,
    setDocsRoot,
    flowEditsRef,
    setFlowDrafts,
    lastUsedFlowRef,
    putFlows,
    showAbout,
    putOpen,
    putSelection,
    putView,
    refreshProjects,
    setRecent,
    setStartupRetry,
    setFatal,
  });
  const changeSettings = (next: typeof settings) => {
    if (cloud.active && next.personalExecution.continuation !== settingsRef.current.personalExecution.continuation) {
      changeAccountExecution(next.personalExecution.continuation);
      return;
    }
    changeLocalSettings(next);
  };
  const changeExecution = (continuation: typeof settings.personalExecution.continuation) => {
    if (cloud.active) changeAccountExecution(continuation);
    else changeLocalSettings({ ...settingsRef.current, personalExecution: { continuation } });
  };
  const {
    saveFlow, rebuildRecordingFlow, updateRecordingFlow, changeRecordingFlow,
    applyRecordingFlow, openFlow, onFlowImportingChange, addFlow,
    duplicateFlowOf, renameFlow, askDeleteFlow, deleteFlow,
  } = useFlowActions({
    flowsRef,
    flowEditsRef,
    bridge,
    putFlows,
    lastUsedFlowRef,
    putFlowEdit,
    showToast,
    settingsRef,
    reloadView,
    selectionRef,
    putSelection,
    refreshProjects,
    viewRef,
    updatingFlow,
    runRef,
    setConfirmUpdate,
    showFailure,
    setUpdatingFlow,
    flowChangingRef,
    chat,
    setFlowChange,
    setFlowChanging,
    reloadFlows,
    rememberFlow,
    markNavigation,
    setDesignFlowId,
    applyScreen,
    flowsBusyRef,
    setFlowsBusy,
    flowImportingRef,
    setFlowImporting,
    setFocusFlowName,
    setDeletingFlow,
    deletingFlow,
    setDeleteBusy,
    designFlowId,
  });
  const {
    startRun, stop, confirmPersonalNiho,
  } = useExecutionActions({
    runRef,
    flushTimer,
    setActiveRun,
    viewRef,
    cloudContextRef,
    settingsRef,
    bridge,
    flushArtifacts,
    createAutoVersions,
    runFlushRef,
    runAbortRef,
    setNihoRunConfirmation,
    reloadView,
    refreshProjects,
    selectLocationPage,
    setDrafts,
    setNotice,
    showToast,
    undoRebuildRef,
    continuationChainRef,
    personalNihoPending,
    showFailure,
    savingRef,
    rootChangeRef,
    setFailure,
    setPersonalNihoPending,
    activeRun,
    view,
    cloud,
    documentScopeId,
    accountExecutionProblem: accountExecution.problem,
  });
  const {
    stepId, currentArtifactId, currentDraft, viewingShown,
    changeDraft, renameSpeaker, openVersion, closeVersion,
    restoreVersion, recordingChat, rebuildStep, openCandidateDialog,
    createCandidate, commitCandidateName, copy, exportFile,
    reveal, loadPartial, createSourceCandidate, chooseSourceCandidate,
    sourceSwitch,
  } = useArtifactActions({
    selectedStepId,
    view,
    selection,
    drafts,
    viewingVersion,
    documentScopeId,
    setViewingVersion,
    openedArtifactRef,
    draftsRef,
    setDrafts,
    autosave,
    selectedTarget,
    autoVersion,
    savingRef,
    speakerSavingRef,
    runRef,
    chat,
    showFailure,
    setSaving,
    bridge,
    reloadView,
    refreshProjects,
    showToast,
    cloud,
    get dropDraft() { return dropDraft; },
    viewRef,
    createAutoVersions,
    startRun,
    undoRebuildRef,
    outside,
    folders,
    selectionRef,
    openRef,
    setFailure,
    setCandidateDialog,
    candidateDialog,
    candidateBusy,
    chatSendingProjectRef,
    rootChangeRef,
    setCandidateBusy,
    selectLocationPage,
    setCandidateNameEdits,
  });
  const {
    createFolder, goHome, onInfoSaved, openLocation,
    openInfo,
  } = useFolderActions({
    guardAboutLeave,
    createBusyRef,
    dropBusyRef,
    moveBusyRef,
    navigationRef,
    setFailure,
    flushDocForLeave,
    bridge,
    refreshProjects,
    applyScreen,
    openProject,
    setFocusFolderTitle,
    showFailure,
    markNavigation,
    putOpen,
    putSelection,
    putView,
    reloadOpen,
    viewRef,
    reloadView,
  });
  const {
    openRemote, dropDraft, reviewConflict, onConflictResolved,
    conflictNames, showLatestArtifact, remoteOnly, leaseNote,
  } = useCloudWorkspace({
    openingRemote,
    guardAboutLeave,
    setOpeningRemote,
    bridge,
    refreshProjects,
    applyScreen,
    openProject,
    showFailure,
    draftsRef,
    setDrafts,
    flushDoc,
    setFailure,
    setConflictReview,
    showToast,
    cloud,
    flowEditsRef,
    reloadFlows,
    aboutDirtyRef,
    aboutSavingRef,
    showAbout,
    openRef,
    selectionRef,
    setCloudDocReload,
    reloadOpen,
    viewRef,
    openedArtifactRef,
    autosave,
    autoVersion,
    setArtifactCaptureReload,
    reloadView,
    rawTitle,
    putOpen,
    putSelection,
    putView,
    showPage,
    artifactRefreshing,
    setArtifactRefreshing,
    putOpenedArtifact,
    screen,
    view,
    selection,
    artifactCaptureReload,
    drafts,
    openedArtifact,
    documentScopeId,
    artifactGenerationReloadRef,
    infoEditing,
    open,
    aboutEditing,
    flowDrafts,
    folders,
  });

  /** 選んだ録音で、登録を外した AI に解決済みの工程（実行しない。「この録音の工程を今の設計に更新」で直す）。 */
  const unregisteredSteps = view ? unregisteredSnapshotSteps(view.flow, activeProviders(settings)) : [];
  const unregistered = unregisteredSteps.map((step) => step.name);
  /** 選んだ録音の元のフロー（snapshot と同じ id。工程設計から消えていれば null）。 */
  const sourceFlow = view ? (flows.find((candidate) => candidate.id === view.flow.id) ?? null) : null;
  /** 工程設計で開いているフロー。 */
  const designFlow = designFlowOf(flows, designFlowId, lastUsedFlowId);
  const {
    setupReasonFor,
  } = useRunReadiness({
    settings,
    phase,
    screen,
    readinessKeyRef,
    refreshReadiness,
    settingsRef,
    view,
    readiness,
    selectedStepId,
    cloud,
    deviceDeliveryAvailable: bridge.capabilities?.personalDeviceDelivery === true,
  });
  const {
    signedOutNow, accountShown, localFallback,
  } = useAccountAvailability({
    screen,
    account,
    bridge,
    setAccountOpen,
    accountOpen,
    cloud,
    phase,
    outside,
    recent,
    openRef,
    selectionRef,
    folders,
    selectLocationPage,
  });

  if (phase === "loading") return <div className="app solo" aria-busy="true" />;
  if (phase === "error") {
    return (
      <div className="app solo">
        <div className="empty">
          <p className="err">{fatal}</p>
          <div className="row">
            <button type="button" className="btn outline" onClick={() => setStartupRetry((attempt) => attempt + 1)}>
              再試行
            </button>
            <button type="button" className="btn primary" onClick={() => void chooseStartupRoot()}>
              保存先を選ぶ
            </button>
          </div>
          {/* 起動できなくても、直した版を取得していれば「更新して再起動」で入れられる */}
          <UpdateNotice bridge={props.bridge} />
        </div>
      </div>
    );
  }
  // 起動時の保存先・再開マーカーを読み終えるまで本文を操作させない。
  if (bridge.capabilities?.cloudSync !== false && cloud.state === null) return <div className="app solo" aria-busy="true" />;
  if (!outside) return <div className="app solo" aria-busy="true" />;
  // 本人が選ぶまで本文を開かない。期限切れ・オフラインは手元で続ける（戻ったら送る）。
  // 開発・試験の起動は「この Mac だけ」なので出さない。サーバーが NIHO アカウントの接続を閉じている間（本番の
  // APP_CONNECT_ENABLED=false・障害）はログインできないので塞がず、手元で続ける（レールの知らせで同期していないことを伝え、
  // 接続が開いてからログインすると移行が始まる）。塞ぐと、更新した人が手元の文書も開けなくなる。確かめ終わるまでは、ログイン画面も
  // ページも出さずに待つ（ログイン画面が一瞬出てから消える・ページが一瞬見えてからログイン画面になる、を避ける）
  if (cloud.state?.requiresAccount && signedOutNow && accountOpen === null) return <div className="app solo" aria-busy="true" />;
  if (cloud.state?.reopeningPending && account.state === null) return <div className="app solo" aria-busy="true" />;
  if (cloud.state?.requiresAccount && signedOutNow && accountOpen && !localFallback) {
    // 更新しないとログインできない版が出ても詰まないように、ログインの画面にも「更新して再起動」を出す（#18788）
    return <LoginRequired account={account} failure={failure} onDismissFailure={() => setFailure(null)}
      reopeningPending={cloud.state.reopeningPending} updateNotice={<UpdateNotice bridge={props.bridge} />} />;
  }
  if (cloud.state?.reopeningPending && signedOutNow) {
    return <LoginRequired account={account} failure={failure} onDismissFailure={() => setFailure(null)}
      reopeningPending updateNotice={<UpdateNotice bridge={props.bridge} />} />;
  }
  if (cloud.state?.reopeningPending) {
    return <StorageReopeningPending bridge={bridge} cloud={cloud} />;
  }
  if (cloud.state?.storage?.mode === "UNSET") {
    return <StorageChoice bridge={bridge} cloud={cloud} />;
  }

  const page = open && selection ? (open.pages.find((candidate) => candidate.id === selection.pageId) ?? null) : null;
  const runningProject = activeRun !== null && open !== null && activeRun.projectId === open.id;
  const folderLocked = open !== null && (runningProject || chat.sendingProjectId === open.id);
  const chatBusyInProject = (rec: RecordingView) => chat.sendingProjectId === rec.projectId;
  const recentRows: RecentRow[] = recent.flatMap((item) => {
    const space = item.projectId === null ? outside : folders.find((folder) => folder.id === item.projectId);
    const itemPage = space?.pages.find((candidate) => candidate.id === item.pageId);
    if (!space || !itemPage) return [];
    const summary = itemPage.kind === "rec" ? space.recordings[itemPage.recordingId ?? itemPage.id] : null;
    const progress = summary ? recordingProgress(summary.recording, summary.hasTranscript, summary.artifacts) : null;
    const titledPage = { ...itemPage, title: rawTitleAt(item.projectId, itemPage) };
    // フォルダの音声は背景情報のページで開く（録音のページは出さない。#18914）
    const title = itemPage.kind === "rec" && item.projectId !== null ? "背景情報" : pageTitle(titledPage, summary?.recording);
    return [{ projectId: item.projectId, page: titledPage, title, folder: item.projectId === null ? "ホーム" : folderName(space.project), openedAt: item.openedAt, progress: progress ? `${progress.done}/${progress.total}` : null }];
  });

  /** 別の Mac が実行中の理由（フォルダの外は予約の docs-root の lease）。実行の帯に出し、実行を押せなくする。 */
  const runLeaseNote = (rec: RecordingView): string | null => {
    const holder = remoteLeaseHolder(cloud.remote, toCloudProjectId(rec.projectId));
    return holder === null ? null : leaseRunNote(holder);
  };
  /** 実行の帯の「設定を開く」: 書きかけを書き残してから設定へ移る。 */
  const openSettingsFromRun = () => {
    markNavigation();
    void flushDocForLeave().then(
      () => applyScreen("settings"),
      (error: unknown) => {
        if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "文書を保存できないため移動しませんでした。"));
      },
    );
  };

  const hasAnyPage = (outside?.pages.length ?? 0) > 0 || folders.some((folder) => folder.pages.length > 0);

  const blockedReason = view ? runBlockedReason(activeRun, view.projectId, folders) : null;

  /** レールの「工程設計」「設定」と、知らせの「設定を開く」: 書きかけを書き残してから画面を移る。 */
  const goScreen = (next: Screen) => {
    const action = () => {
      markNavigation();
      void (async () => {
        try {
          if (next !== "work") await flushDocForLeave();
          applyScreen(next);
        } catch (error) {
          if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "文書を保存できないため移動しませんでした。"));
        }
      })();
    };
    if (guardAboutLeave(action)) action();
  };

  /**
   * 別のアカウントの保存先: ログアウトする。ログインの画面（LoginRequired）が出て、保存先のアカウントでログインし直せる
   * （ログイン中はログインを始められないので、ログアウトの成否を待たずに続けて始めない）。
   */
  const relogin = () => {
    void account.logout();
  };

  return (
    <div className="app">
      <Rail
        outside={outside}
        folders={folders}
        open={open}
        selection={selection}
        screen={screen}
        activeRun={activeRun}
        flowDesign={bridge.capabilities?.flowDesign}
        titleOf={rawTitleAt}
        onHome={() => void goHome()}
        onNewFolder={() => void createFolder()}
        onOpenLocation={(projectId) => void openLocation(projectId)}
        onOpenInfo={(projectId) => void openInfo(projectId)}
        onAddDoc={(projectId) => void addDocPage(projectId)}
        onAddRecording={(projectId) => void addRecordingPage(projectId)}
        onNewAudio={() => void addRecordingPage(null)}
        onSelectPage={(projectId, pageId, id, candidateId) => void selectLocationPage(projectId, pageId, id, candidateId ?? null)}
        onAddCandidate={openCandidateDialog}
        sourceEngineChoices={bridge.capabilities?.localExecution === false ? undefined : transcriptionEngineChoices(settings)}
        onAddSourceCandidate={(projectId, pageId, engine) => void createSourceCandidate(projectId, pageId, engine)}
        newProjectId={screen === "work" && open?.id !== null ? open?.id ?? null : null}
        onDrop={(drop) => void applyRailDrop(drop)}
        onMoveFolder={reorderFolder}
        onDeleteFolder={deleteEmptyFolder}
        onExportFolder={accountShown && (cloud.state?.storage?.mode !== "LOCAL" || bridge.capabilities?.localFolderExport)
          ? openFolderExport : undefined}
        onScreen={goScreen}
        updateNotice={<UpdateNotice bridge={props.bridge} />}
        cloudNotice={
          <CloudNotice
            bridge={bridge}
            cloud={cloud}
            openProject={open ? { id: toCloudProjectId(open.id), name: open.id === null ? "ホームのページ" : folderName(open.project) } : null}
            canLogin={accountOpen !== false}
            onLogin={() => void account.beginLogin()}
            onRelogin={relogin}
            onOpenSettings={() => goScreen("settings")}
            onReviewConflicts={(projectId) => void reviewConflict(projectId, null)}
            onNotice={showToast}
            onFailure={showFailure}
          />
        }
        remoteRows={
          remoteOnly.length > 0 ? <RemoteProjectRows projects={remoteOnly} opening={openingRemote} onOpen={(projectId) => void openRemote(projectId)} /> : null
        }
        leaseNote={leaseNote}
      />
      <main className="main">
        <div className="recording-global" aria-label="この Mac の録音">
          <RecordingPanel state={capture.state} onStop={() => void capture.stop()} />
          {capture.saving && <p role="status" className="help">録音をページに保存しています…</p>}
          {capture.problem && <RecordingProblemNote problem={capture.problem} onOpenSettings={() => void bridge.openMicrophoneSettings().catch((error) => showFailure(errorMessage(error, "システム設定を開けませんでした。")))} />}
          {capture.leftovers.map((audio) => (
            <div className="rec-left" key={audio.recordingId}>
              <span className="nm">前回の録音が残っています · {audio.name}（{formatRecordingLength(audio.durationSec ?? 0)}）</span>
              <button type="button" className="link" disabled={capture.active || capture.saving} onClick={() => void capture.recover(audio)}>録音のページに保存</button>
              <button type="button" className="link danger" disabled={capture.active || capture.saving} onClick={() => setDiscardingCapture(audio)}>捨てる</button>
            </div>
          ))}
        </div>
        {failure && !candidateDialog && (
          <div className="failure-slot">
            <FailureBand message={failure.text} action={failure.action} onDismiss={() => setFailure(null)} />
          </div>
        )}
        {screen === "work" && <WorkScreen {...{
          open, recentRows, hasAnyPage, selectLocationPage,
          chatOpen, chatToggleState, setChatOpen, sourceFlow,
          unregistered, runningProject, setConfirmUpdate, rawTitle,
          settings, cloud, bridge, capture,
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
          accountExecutionProblem: accountExecution.problem,
          addDocPage, chooseSourceCandidate, sourceSwitch,
        }} />}
        <FlowDesignScreen {...{
          screen, designFlow, busy, flowOrigin,
          chooseFlow, flowDrafts, settings, bridge,
          deletingFlow, flowImporting, onFlowImportingChange, flows,
          flowsBusy, openFlow, addFlow, duplicateFlowOf,
          renameFlow, askDeleteFlow, focusFlowName, setFocusFlowName,
          putFlowEdit, saveFlow, markNavigation, applyScreen,
        }} />
        <SettingsScreen {...{
          screen, bridge, account, accountShown,
          googleDocs, settings, docsRoot, activeRun,
          chat, changingRoot, about, aboutLoad,
          saveAbout, reportAboutState, discardAboutRef, flushAboutRef,
          changeSettings, changeExecution, changeRoot, cloud, folders,
          accountExecution,
          refreshProjects, showToast,
        }} />
      </main>
      <WorkspaceDialogs {...{
          googleDocs, folderExport, fileDropOver, flowPick,
          busy, chooseFlowForRecording, setFlowPick, confirmUpdate,
          view, sourceFlow, updatingFlow, updateRecordingFlow,
          setConfirmUpdate, unregistered, flowChange, flowChanging,
          applyRecordingFlow, setFlowChange, unregisteredSteps, deletingFlow,
          deleteBusy, deleteFlow, setDeletingFlow, aboutLeaveOpen,
          aboutSaving, discardAboutAndContinue, returnToAbout, closeConfirm,
          closing, discardAndClose, setCloseConfirm, closeFailed,
          deleting, deletePage, setDeleting, conflictReview,
          bridge, conflictNames, onConflictResolved, setConflictReview,
          nihoRunConfirmation, viewRef, cloudContextRef, showFailure,
          candidateDialog, candidateBusy, createCandidate, setCandidateDialog,
          failure, setFailure, compareOpen, selectedTarget,
          drafts, setCompareOpen, selectPage, toast,
          clearToast, discardingCapture, capture, setDiscardingCapture,
          stopRecordingAndClose,
        }} />
    </div>
  );
}
