"use client";

import { EMPTY_ABOUT, type About, type ContractProvider, type Flow, type PageEntry, type ProviderCapabilities } from "@niho/docs-core";
import { useRef, useState } from "react";
import { type DocFlush } from "../components/DocPage";
import type { EditorToolControls } from "../components/EditorTools";
import { type Failure } from "../components/FailureBand";
import { type Screen, type Selection } from "../components/Rail";
import { type Bridge, type PersonalNihoPending, type ProjectId, type RecentId, type RecordedAudio } from "../lib/bridge";
import { type OpenProject, type RecordingView } from "../lib/project-view";
import { type RunReadinessStatuses } from "../lib/run-readiness";
import { type ActiveRun, type RunNotice } from "../lib/run-state";
import { defaultSettings, type AppSettings } from "../lib/settings";
import { type CandidateDialogState, type Draft, type FlowOrigin, type NihoRunConfirmation, type OpenedArtifactDocument, type Phase, type RebuildUndo, type ToastAction, type ViewingVersion } from "./workspace-model";

type Context = {
  bridge: Bridge;
};

/** 画面をまたいで使う状態と参照。画面単位の処理は各 hook が担当する。 */
export function useWorkspaceState(context: Context) {
  const {
    bridge,
  } = context;

  const [phase, setPhase] = useState<Phase>("loading");
  const [fatal, setFatal] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings>(() => defaultSettings());
  /** 工程（フロー）の並び（P4 #18567。flows/index.json）。 */
  const [flows, setFlows] = useState<Flow[]>([]);
  /** 最後に使ったフロー（新しい録音のページの既定）。 */
  const [lastUsedFlowId, setLastUsedFlowId] = useState<string | null>(null);
  /** 工程設計の編集中の内容（フローごと。保存するまでファイルは変えない。ほかのフローや画面へ移っても残る）。 */
  const [flowDrafts, setFlowDrafts] = useState<Record<string, Flow>>({});
  /** 工程設計で開いているフロー（無ければ既定のフロー）。 */
  const [designFlowId, setDesignFlowId] = useState<string | null>(null);
  /** 工程設計の名前の欄にフォーカスする（一覧の「名前の変更」・複製の後）。 */
  const [focusFlowName, setFocusFlowName] = useState(false);
  /** フローの追加・複製・削除の途中。 */
  const [flowsBusy, setFlowsBusy] = useState(false);
  /** お手本本文を取り込み中は、フロー削除を止める。 */
  const [flowImporting, setFlowImporting] = useState(false);
  /** 消す前に確かめるフロー（使っている録音の数つき）。 */
  const [deletingFlow, setDeletingFlow] = useState<{ flow: Flow; usage: number; samples: boolean } | null>(null);
  /** 「あなたについて」（保存先の about.json。保存に成功した内容。工程の実行と「AIと作る」に添える）。 */
  const [about, setAbout] = useState<About>(EMPTY_ABOUT);
  /** about.json を読み直した回数（設定のカードを開き直す印。保存では変えない）。 */
  const [aboutLoad, setAboutLoad] = useState(0);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [updatingFlow, setUpdatingFlow] = useState(false);
  /** 録音の「工程」を別のフローに変える前の確かめ（成果物がある録音だけ）。 */
  const [flowChange, setFlowChange] = useState<{ key: string; flow: Flow } | null>(null);
  /** 録音の「工程」を変えている途中（読み直すまで select に選んだ値を出す）。 */
  const [flowChanging, setFlowChanging] = useState<{ key: string; flowId: string } | null>(null);
  /**
   * 工程が 0 本の録音のページの「工程設計で作る」から工程設計へ来たときの、開始元の録音（spec §7「テンプレートを選ぶと工程を保存して、
   * そのまま録音のページを作る」）。テンプレートを選んだらこの録音に付けて戻る。ほかの画面へ移ったら（markNavigation）忘れる。
   */
  const [flowOrigin, setFlowOrigin] = useState<FlowOrigin | null>(null);
  const flowOriginRef = useRef<FlowOrigin | null>(null);
  /** 実行の前に確かめる準備（工程の AI の CLI・この Mac の音声モデル）。録音のページの実行の帯に理由を出す。 */
  const [readiness, setReadiness] = useState<RunReadinessStatuses>({ providers: {}, speech: undefined });
  /** 最後に準備を確かめた設定（同じなら取り直さない。普段の画面を離れたら null にして、戻ったときに取り直す）。 */
  const readinessKeyRef = useRef<string | null>(null);
  /** サーバーが NIHO アカウントの接続を受け付けるか（本番の APP_CONNECT_ENABLED。閉じている間はログインと Google ドキュメントを出さない）。 */
  // null は確かめている途中（ログイン画面を出すかを決めるまで待つ）。確かめられないときは開いているとして扱う
  const [accountOpen, setAccountOpen] = useState<boolean | null>(null);
  const [folders, setFolders] = useState<OpenProject[]>([]);
  const [outside, setOutside] = useState<OpenProject | null>(null);
  /** 開いている案件（ページの一覧と録音の様子）。 */
  const [open, setOpen] = useState<OpenProject | null>(null);
  /** 選んでいるページ（stepId があれば録音の成果物の子ページ）。 */
  const [selection, setSelection] = useState<Selection | null>(null);
  /** 選んでいる録音（録音のページか、その子ページ）の見え方。文書のページでは null。 */
  const [view, setView] = useState<RecordingView | null>(null);
  /** 打ちかけのページの名前（保存が済むまで、読み直した古い名前で戻さない）。 */
  const [titleEdits, setTitleEdits] = useState<Record<string, string>>({});
  /** 作ったばかりのページ（開いたらタイトルにフォーカス）。 */
  const [focusTitle, setFocusTitle] = useState<string | null>(null);
  const [focusFolderTitle, setFocusFolderTitle] = useState(false);
  // 「AIと作る」は閉じて始める（保存しない。ページを移っても同じ起動中は保つ。owner 2026-10-18・#18941）
  const [chatOpen, setChatOpen] = useState(false);
  /** 閉じている間に「AIと作る」の依頼が終わり、まだ開いていない（ChatToggle の点）。 */
  const [chatUnseen, setChatUnseen] = useState(false);
  /** 開いているページの検索・書式の入口（EditorTools が渡す。⋯ と ⌘F が使う。owner 2026-10-18・#18941）。 */
  const [editorTools, setEditorTools] = useState<EditorToolControls | null>(null);
  const editorToolsRef = useRef<EditorToolControls | null>(null);
  editorToolsRef.current = editorTools;
  const [docReload, setDocReload] = useState<Record<string, number>>({});
  /** 消す前に確かめるページ（`audio` はフォルダの音声。背景情報のページの ⋯ の「音声を削除」。#18914）。 */
  const [deleting, setDeleting] = useState<{ projectId: ProjectId; pageId: string; title: string; kind: PageEntry["kind"]; audio?: boolean } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [discardingCapture, setDiscardingCapture] = useState<RecordedAudio | null>(null);
  const [screen, setScreen] = useState<Screen>("work");
  const [aboutLeaveOpen, setAboutLeaveOpen] = useState(false);
  const [aboutSaving, setAboutSaving] = useState(false);
  /** 背景情報のページの 背景情報・登場人物・固有名詞 に保存していない変更がある（NIHO クラウドの反映を延ばす）。 */
  const [infoEditing, setInfoEditing] = useState(false);
  const [candidateDialog, setCandidateDialog] = useState<CandidateDialogState | null>(null);
  const [candidateBusy, setCandidateBusy] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [candidateNameEdits, setCandidateNameEdits] = useState<Record<string, string>>({});
  const [docsRoot, setDocsRoot] = useState("");
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [notice, setNotice] = useState<RunNotice | null>(null);
  const [personalNihoPending, setPersonalNihoPending] = useState<PersonalNihoPending | null>(null);
  const [nihoRunConfirmation, setNihoRunConfirmation] = useState<NihoRunConfirmation | null>(null);
  const [draftsState, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);
  const [recordingInteractionBusy, setRecordingInteractionBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; action?: ToastAction } | null>(null);
  /** 失敗と理由（#18788）。トーストは成功の確認だけにし、失敗はページの帯に残す（次の成功・ページの移動・「閉じる」で消す）。 */
  const [failure, setFailure] = useState<Failure | null>(null);
  /** 窓を閉じる前の確かめ（工程設計・背景情報の保存していない変更。#18788）。 */
  const [closeConfirm, setCloseConfirm] = useState<{ flows: string[]; info: boolean } | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeFailed, setCloseFailed] = useState(false);
  const [recent, setRecent] = useState<RecentId[]>([]);
  const [fileDropOver, setFileDropOver] = useState(false);
  const fileDropHandlerRef = useRef<(paths: string[]) => void>(() => undefined);
  /**
   * 提供元ができること（起動時に今の方式の登録した AI を provider_status で確かめる。続きの頼み方に使う）。方式を切り替えた後に
   * 初めて使う提供元は、実行の前に確かめる。
   */
  const capabilitiesRef = useRef<Partial<Record<ContractProvider, ProviderCapabilities>>>({});
  const [startupRetry, setStartupRetry] = useState(0);
  const [changingRoot, setChangingRoot] = useState(false);
  // NIHO クラウド（C3 #18595）: 変更の確認・クラウドから開いている案件・「あなたについて」の編集中・本文の読み直し
  const [conflictReview, setConflictReview] = useState<{ projectId: string; path: string | null } | null>(null);
  const [openingRemote, setOpeningRemote] = useState<string | null>(null);
  const [aboutEditing, setAboutEditing] = useState(false);
  // クラウドから届いた本文の読み直し（DocPage の reloadKey。ページごとの作り直しの docReload とは別）
  const [cloudDocReload, setCloudDocReload] = useState(0);
  const [artifactRefreshing, setArtifactRefreshing] = useState(false);
  const [openedArtifact, setOpenedArtifact] = useState<OpenedArtifactDocument | null>(null);
  const [artifactCaptureReload, setArtifactCaptureReload] = useState(0);
  const [viewingVersion, setViewingVersion] = useState<ViewingVersion | null>(null);

  const runRef = useRef<ActiveRun | null>(null);
  const runAbortRef = useRef<AbortController | null>(null);
  /** busyを先に取ったoperation自身が、送信前に書きかけをflushしている間だけautosaveのrun blockを外す。 */
  const runFlushRef = useRef<AbortController | null>(null);
  const nihoRunConfirmationRef = useRef<NihoRunConfirmation | null>(null);
  nihoRunConfirmationRef.current = nihoRunConfirmation;
  /**
   * 続きをクラウドで作る「文書作成を開始」の予約（#18947）: この Mac で原文を作り終えた録音（key）と、そのときの本人・保存先。
   * 実行が終わって同じ録音・同じ保存先のまま読み直したら、続きを 1 回だけ始める（失敗・止める・移動・保存先の変更では捨てる）。
   */
  const continuationChainRef = useRef<{ key: string; generation: number | null; scopeId: string | null } | null>(null);
  /** saveArtifact の人操作を state 反映前から直列化する。 */
  const savingRef = useRef(false);
  const speakerSavingRef = useRef(false);
  const flowsRef = useRef<Flow[]>([]);
  const lastUsedFlowRef = useRef<string | null>(null);
  /**
   * フローごとの最後の編集（保存済みと同じ内容でも持つ。保存中に加えた編集を残すために、保存の前後で比べる）。画面の
   * flowDrafts は保存済みと違うものだけ。
   */
  const flowEditsRef = useRef<Record<string, Flow>>({});
  const flowChangingRef = useRef(false);
  const flowsBusyRef = useRef(false);
  const flowImportingRef = useRef(false);
  /** 背景情報のページに保存していない変更がある（窓を閉じる前の確かめ）。 */
  const infoDirtyRef = useRef(false);
  /** 窓を閉じる前の確かめで「破棄して閉じる」を選んだ（次の閉じる要求では確かめない）。 */
  const discardOnCloseRef = useRef(false);
  /** この Mac で録音している（窓を閉じる前は、録音を止めるかの確かめを先にする）。 */
  const recordingActiveRef = useRef(false);
  /** 録音を止めるかの確かめで「止めて閉じる」を押した（録音を止めた後の、次の 1 回の閉じる要求を通す）。 */
  const recordingStoppedForCloseRef = useRef(false);
  /** 成果物・文字起こしの自動保存の失敗として帯に出した理由（書き直せたら、その帯だけ消す）。 */
  const autosaveFailureRef = useRef<string | null>(null);
  const aboutRef = useRef<About>(EMPTY_ABOUT);
  /** 「あなたについて」の保存を 1 本にする（続けて保存しても、最後に頼んだ内容が最後に書かれる）。 */
  const aboutSaveRef = useRef<Promise<unknown>>(Promise.resolve());
  const screenRef = useRef<Screen>("work");
  const aboutDirtyRef = useRef(false);
  const aboutSavingRef = useRef(false);
  const pendingAboutActionRef = useRef<(() => void) | null>(null);
  const discardAboutRef = useRef<() => void>(() => undefined);
  const flushAboutRef = useRef<() => Promise<boolean>>(async () => true);
  const settingsRef = useRef<AppSettings>(settings);
  const persistedSettingsRef = useRef<AppSettings>(settings);
  const cloudActiveRef = useRef(false);
  const settingsSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const persistSettings = (next: AppSettings): Promise<void> => {
    // 本人共通の execution.json を、端末内 settings.json の控えへコピーしない。
    const persisted = cloudActiveRef.current
      ? { ...next, personalExecution: persistedSettingsRef.current.personalExecution }
      : next;
    const task = settingsSaveQueueRef.current.catch(() => undefined).then(async () => {
      await bridge.saveSettings(persisted);
      persistedSettingsRef.current = persisted;
    });
    settingsSaveQueueRef.current = task.catch(() => undefined);
    return task;
  };
  const viewRef = useRef<RecordingView | null>(null);
  const draftsStateRef = useRef(draftsState);
  draftsStateRef.current = draftsState;
  const draftScopeRef = useRef<string | null>(null);
  const draftsByScopeRef = useRef(new Map<string, Record<string, Draft>>());
  const openedArtifactRef = useRef<OpenedArtifactDocument | null>(null);
  const artifactGenerationReloadRef = useRef<string | null>(null);
  const openRef = useRef<OpenProject | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  /** 録音の読み込みが前後しても、最後に選んだページだけを表示する。 */
  const showPageRequestRef = useRef(0);
  const openProjectRequestRef = useRef(0);
  /** ユーザーが後から選んだ画面を、遅いdropや読込の完了で上書きしない。 */
  const navigationRef = useRef(0);
  /** 文書のページの書きかけを書き残す口（DocPage が置く）。 */
  const docFlushRef = useRef<DocFlush | null>(null);
  /** 表示中の文書ページの本文。DocBody の onChange で、保存中も pending と独立して最新に保つ。 */
  const latestMarkdownRef = useRef<{ key: string; markdown: string } | null>(null);
  const toastTimer = useRef<number | null>(null);
  /** トーストの「元に戻す」から呼ぶ、その時点の描画の undoRebuild（実行の後で作ったトーストに古い描画の値を持たせない）。 */
  const undoRebuildRef = useRef<(undo: RebuildUndo) => Promise<void>>(async () => undefined);
  const flushTimer = useRef<number | null>(null);
  const rootChangeRef = useRef(false);
  const createBusyRef = useRef(false);
  const dropBusyRef = useRef(false);
  const moveBusyRef = useRef(false);
  const recordingInteractionRef = useRef(false);
  const chatSendingProjectRef = useRef<ProjectId | undefined>(undefined);
  const modalOpenRef = useRef(false);
  const titleEditsRef = useRef<Record<string, string>>({});
  /** 最近の保存と画面反映を開いた順に直列化し、遅い古い応答で新しい順を戻さない。 */
  const recentTouchRef = useRef<Promise<void>>(Promise.resolve());
  return {
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
  };
}
