"use client";

import { DEFAULT_SPEAKER_MODE, createBlankFlow, createFlowSnapshot, defaultRecordingLanguage, folderRecordingPage, type Flow, type PageEntry, type Recording } from "@niho/docs-core";
import { useEffect, useState } from "react";
import type { EditorToolControls } from "../components/EditorTools";
import { type Failure, type FailureAction } from "../components/FailureBand";
import { type FlowChoice } from "../components/FlowPicker";
import { type Screen, type Selection } from "../components/Rail";
import { appendAudio } from "../components/RecordingPage";
import { errorMessage, isCommandError, type Bridge, type FlowList as FlowListData, type NewPage, type ProjectId, type RecentId, type RecordingRef } from "../lib/bridge";
import { newId } from "../lib/format";
import { openProjectOf, recordingKey, withPageTitle, type OpenProject, type RecordingView } from "../lib/project-view";
import type { RailDrop } from "../lib/rail-dnd";
import { type ActiveRun, type RunNotice } from "../lib/run-state";
import { activeProfiles, activeProviders, type AppSettings } from "../lib/settings";
import { type ChatController } from "../lib/use-chat";
import { DOC_FLUSH_FAILED, NO_RECORDING, audioTitle, defaultFlowOf, newFlowOf, titleKey, type Draft, type RecordingThen, type ToastAction } from "./workspace-model";

import type { ProjectEntry } from "../host/DocsHost";

import type { useAppRecording } from "../lib/app-recording";

type Context = {
  guardAboutLeave: (action: () => void) => boolean;
  markNavigation: () => void;
  openRef: React.MutableRefObject<OpenProject | null>;
  applyScreen: (next: Screen) => void;
  selectionRef: React.MutableRefObject<Selection | null>;
  flushDocForLeave: () => Promise<void>;
  showFailure: (text: string, action?: FailureAction) => void;
  showPage: (project: OpenProject, next: Selection | null, shouldApply?: () => boolean) => Promise<void>;
  openProject: (projectId: ProjectId, pageId?: string | null) => Promise<OpenProject>;
  titleEdits: Record<string, string>;
  open: OpenProject | null;
  setTitleEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  titleEditsRef: React.MutableRefObject<Record<string, string>>;
  bridge: Bridge;
  putOpen: (next: OpenProject | null) => void;
  setOutside: React.Dispatch<React.SetStateAction<OpenProject | null>>;
  setFolders: React.Dispatch<React.SetStateAction<OpenProject[]>>;
  refreshProjects: (shouldApply?: () => boolean) => Promise<ProjectEntry[]>;
  reloadOpen: (projectId: ProjectId) => Promise<OpenProject>;
  createBusyRef: React.MutableRefObject<boolean>;
  dropBusyRef: React.MutableRefObject<boolean>;
  moveBusyRef: React.MutableRefObject<boolean>;
  screenRef: React.MutableRefObject<Screen>;
  navigationRef: React.MutableRefObject<number>;
  setFailure: React.Dispatch<React.SetStateAction<Failure | null>>;
  touchRecent: (item: RecentId) => void;
  setFocusTitle: React.Dispatch<React.SetStateAction<string | null>>;
  modalOpenRef: React.MutableRefObject<boolean>;
  flowsRef: React.MutableRefObject<Flow[]>;
  lastUsedFlowRef: React.MutableRefObject<string | null>;
  settingsRef: React.MutableRefObject<AppSettings>;
  rememberFlow: (flowId: string) => Promise<boolean>;
  setFocusFolderTitle: React.Dispatch<React.SetStateAction<boolean>>;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  persistSettings: (next: AppSettings) => Promise<void>;
  reloadFlows: () => Promise<FlowListData>;
  putFlows: (list: readonly Flow[], lastUsed: string | null) => void;
  setDesignFlowId: React.Dispatch<React.SetStateAction<string | null>>;
  editorToolsRef: React.MutableRefObject<EditorToolControls | null>;
  screen: Screen;
  designFlowId: string | null;
  deletingFlow: { flow: Flow; usage: number; samples: boolean; } | null;
  recordingInteractionRef: React.MutableRefObject<boolean>;
  rootChangeRef: React.MutableRefObject<boolean>;
  setFileDropOver: React.Dispatch<React.SetStateAction<boolean>>;
  runRef: React.MutableRefObject<ActiveRun | null>;
  chatSendingProjectRef: React.MutableRefObject<ProjectId | undefined>;
  fileDropHandlerRef: React.MutableRefObject<(paths: string[]) => void>;
  capture: ReturnType<typeof useAppRecording>;
  outside: OpenProject | null;
  folders: OpenProject[];
  chat: ChatController;
  rekeyMovedRecordingDrafts: (sourceProjectId: ProjectId, sourceRecordingId: string, targetProjectId: ProjectId, targetRecordingId: string) => void;
  putSelection: (next: Selection | null) => void;
  putView: (next: RecordingView | null) => void;
  showToast: (text: string, action?: ToastAction) => void;
  deleting: { projectId: ProjectId; pageId: string; title: string; kind: PageEntry["kind"]; audio?: boolean; } | null;
  setDeleting: React.Dispatch<React.SetStateAction<{ projectId: ProjectId; pageId: string; title: string; kind: PageEntry["kind"]; audio?: boolean; } | null>>;
  setDeleteBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, Draft>>>;
  setNotice: React.Dispatch<React.SetStateAction<RunNotice | null>>;
  viewRef: React.MutableRefObject<RecordingView | null>;
};

/** ホーム・フォルダ内のページの選択、作成、並べ替え、移動、削除と音声ドロップ。 */
export function usePageNavigation(context: Context) {
  const {
    guardAboutLeave, markNavigation, openRef, applyScreen,
    selectionRef, flushDocForLeave, showFailure, showPage,
    openProject, titleEdits, open, setTitleEdits,
    titleEditsRef, bridge, putOpen, setOutside,
    setFolders, refreshProjects, reloadOpen, createBusyRef,
    dropBusyRef, moveBusyRef, screenRef, navigationRef,
    setFailure, touchRecent, setFocusTitle, modalOpenRef,
    flowsRef, lastUsedFlowRef, settingsRef, rememberFlow,
    setFocusFolderTitle, setBusy, persistSettings, reloadFlows,
    putFlows, setDesignFlowId, editorToolsRef, screen,
    designFlowId, deletingFlow, recordingInteractionRef, rootChangeRef,
    setFileDropOver, runRef, chatSendingProjectRef, fileDropHandlerRef,
    capture, outside, folders, chat,
    rekeyMovedRecordingDrafts, putSelection, putView, showToast,
    deleting, setDeleting, setDeleteBusy, setDrafts,
    setNotice, viewRef,
  } = context;

  // ---- ページ ----

  /** ページを選ぶ（stepId があれば録音の成果物の子ページ）。 */
  const selectPage = async (
    pageId: string,
    stepId: string | null = null,
    candidateId: string | null = null,
    shouldApply: () => boolean = () => true,
  ) => {
    if (!guardAboutLeave(() => void selectPage(pageId, stepId, candidateId, shouldApply))) return;
    markNavigation();
    const current = openRef.current;
    if (!current) return;
    applyScreen("work");
    // 文書・成果物（案）の子ページを移る前に書きかけを書き残す（保存できなければ移らない）
    const shown = selectionRef.current;
    if (shown?.pageId !== pageId || shown?.stepId !== stepId || (shown?.candidateId ?? null) !== candidateId) {
      try {
        await flushDocForLeave();
        if (!shouldApply()) return;
      } catch (error) {
        if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "文書を保存できないため移動しませんでした。"));
        return;
      }
    }
    try {
      if (!shouldApply()) return;
      await showPage(current, { pageId, stepId, candidateId }, shouldApply);
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "ページを開けませんでした。"));
    }
  };

  const selectLocationPage = async (
    projectId: ProjectId,
    pageId: string,
    stepId: string | null,
    candidateId: string | null = null,
    shouldApply: () => boolean = () => true,
  ) => {
    if (!guardAboutLeave(() => void selectLocationPage(projectId, pageId, stepId, candidateId, shouldApply))) return;
    markNavigation();
    try {
      if (!shouldApply()) return;
      applyScreen("work");
      if (openRef.current?.id !== projectId) {
        const opened = await openProject(projectId, pageId);
        if (!shouldApply()) return;
        if (stepId !== null) await showPage(opened, { pageId, stepId, candidateId }, shouldApply);
      } else await selectPage(pageId, stepId, candidateId, shouldApply);
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "ページを開けませんでした。"));
    }
  };

  /** ページの名前（打ちかけを含む）。 */
  const rawTitleAt = (projectId: ProjectId, page: PageEntry): string => titleEdits[titleKey(projectId, page.id)] ?? page.title;
  const rawTitle = (page: PageEntry): string => (open ? rawTitleAt(open.id, page) : page.title);

  const inputTitle = (pageId: string, title: string) => {
    const current = openRef.current;
    if (!current) return;
    const key = titleKey(current.id, pageId);
    setTitleEdits((all) => {
      const next = { ...all, [key]: title };
      titleEditsRef.current = next;
      return next;
    });
  };

  /**
   * 名前を保存する（打ち終えて 500ms・離れたとき）。保存できたら打ちかけを外す（その後に打っていなければ）。
   * 保存できなかったら false を返す（PageTitle が名前を残し、次に打つ・離れる・閉じるときにもう一度書く）。
   */
  const commitTitle = (projectId: ProjectId, pageId: string, title: string): Promise<boolean> => {
    const key = titleKey(projectId, pageId);
    return bridge.renamePage(projectId, pageId, title).then(
      () => {
        const current = openRef.current;
        if (current?.id === projectId) putOpen(withPageTitle(current, pageId, title));
        if (projectId === null) {
          setOutside((space) => space && { ...space, pages: space.pages.map((page) => (page.id === pageId ? { ...page, title } : page)) });
        } else {
          setFolders((all) => all.map((folder) => folder.id === projectId
            ? { ...folder, pages: folder.pages.map((page) => (page.id === pageId ? { ...page, title } : page)) }
            : folder));
        }
        setTitleEdits((all) => {
          if (all[key] !== title) return all;
          const next = { ...all };
          delete next[key];
          titleEditsRef.current = next;
          return next;
        });
        return true;
      },
      (error: unknown) => {
        // 消したページの打ちかけの名前（閉じるときに書き残そうとした）は知らせない。書き直す先が無いので残さない
        if (isCommandError(error) && error.code === "store_no_page") return true;
        showFailure(errorMessage(error, "名前を変えられませんでした。"));
        return false;
      },
    );
  };

  const commitFolderTitle = async (projectId: string, title: string): Promise<boolean> => {
    const key = titleKey(projectId, "_folder");
    try {
      const fresh = (await bridge.loadProject(projectId)).project;
      await bridge.saveProject(projectId, { ...fresh, name: title });
    } catch (error) {
      showFailure(errorMessage(error, "フォルダ名を変えられませんでした。"));
      return false;
    }
    setTitleEdits((all) => {
      const next = { ...all };
      if (next[key] === title) delete next[key];
      titleEditsRef.current = next;
      return next;
    });
    try {
      await refreshProjects();
      await reloadOpen(projectId);
    } catch (error) {
      showFailure(errorMessage(error, "フォルダ名は保存しましたが、表示を更新できませんでした。"));
    }
    return true;
  };

  /** 「＋ → 文書」: 空の文書のページを足して開き、タイトルにフォーカスする。 */
  const addDocPage = async (targetProjectId?: ProjectId, afterPageId?: string) => {
    if (!guardAboutLeave(() => void addDocPage(targetProjectId, afterPageId))) return;
    if (createBusyRef.current || dropBusyRef.current || moveBusyRef.current) return;
    const current = openRef.current;
    const location = targetProjectId === undefined ? (screenRef.current === "work" ? current?.id ?? null : null) : targetProjectId;
    const navigation = navigationRef.current;
    createBusyRef.current = true;
    // 新しいページ・フォルダを作って開く（ページの移動）ので、前の失敗の帯は消す
    setFailure(null);
    try {
      await flushDocForLeave();
      const entry = await bridge.createPage(location, { kind: "doc", title: "", createdAt: new Date().toISOString(), afterPageId });
      touchRecent({ projectId: location, pageId: entry.id, openedAt: new Date().toISOString() });
      await refreshProjects();
      if (navigation !== navigationRef.current) return;
      setFocusTitle(entry.id);
      applyScreen("work");
      await openProject(location, entry.id);
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "ページを追加できませんでした。"));
    } finally {
      createBusyRef.current = false;
    }
  };

  /**
   * 工程が無いときの「＋ → 音声」で出す「工程を選ぶ」（作る場所と、作った後に続けること。spec §7・#18753）。開いている間は ⌘N と
   * 音声の drop を受けない。`target` はフォルダの id か、null（新しいフォルダごと作る。#18914）。
   */
  const [flowPick, setFlowPick] = useState<{ target: string | null; name?: string; then?: RecordingThen; drop?: { paths: string[]; location: string | null } } | null>(null);
  if (flowPick) modalOpenRef.current = true;

  /**
   * フォルダの音声（録音のページ）を作り、背景情報のページを開く（1 フォルダ 1 音声。owner 2026-10-18・#18914）。`target` が null なら
   * 音声 1 セット入りの新しいフォルダ（名前は `name`、無ければ「無題のフォルダ」で題にフォーカス）。音声のあるフォルダには 2 つ目を
   * 作らず、背景情報のページ（音声の欄）を開く。保存済みフローが無ければ「工程を選ぶ」を出し、選んだテンプレートの工程で作る（白紙は
   * 工程設計へ）。`then` は作った録音に続けること（文章を入れる・録音を始める）。作ったら true。
   */
  const addRecordingPage = async (
    target: string | null,
    options: { flow?: Flow | null; name?: string; then?: RecordingThen } = {},
  ): Promise<boolean> => {
    if (!guardAboutLeave(() => void addRecordingPage(target, options))) return false;
    if (createBusyRef.current || dropBusyRef.current || moveBusyRef.current) return false;
    const flowToUse = options.flow !== undefined ? options.flow : defaultFlowOf(flowsRef.current, lastUsedFlowRef.current);
    const navigation = navigationRef.current;
    // 音声があるかを確かめる間も作成中として扱う（続けて押しても 2 つ目を作りに行かない）
    createBusyRef.current = true;
    let done = false;
    try {
      const existing = target === null ? null : folderRecordingPage(openProjectOf(await bridge.loadPages(target)).pages);
      if (existing && target !== null) {
        done = true;
        // 続けること（文章を入れる・録音を始める）は、別の Mac で音声ができていたときなどに黙って捨てない
        if (options.then) showFailure("このフォルダにはもう音声があります。背景情報のページの音声を確かめてから、もう一度お試しください。");
        if (navigation === navigationRef.current) {
          markNavigation();
          applyScreen("work");
          await openProject(target);
        }
      }
    } catch (error) {
      done = true;
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "背景情報を開けませんでした。"));
    } finally {
      if (done) createBusyRef.current = false;
    }
    if (done) return false;
    if (!flowToUse && flowsRef.current.length === 0) {
      createBusyRef.current = false;
      setFlowPick({ target, name: options.name, then: options.then });
      return false;
    }
    // 新しいページ・フォルダを作って開く（ページの移動）ので、前の失敗の帯は消す
    setFailure(null);
    try {
      await flushDocForLeave();
      const now = new Date().toISOString();
      const settingsNow = settingsRef.current;
      const snapshotFlow = flowToUse ?? createBlankFlow(newId("blank"));
      const recording: Recording = {
        version: 1,
        id: "",
        createdAt: now,
        flowSnapshot: createFlowSnapshot(snapshotFlow, activeProfiles(settingsNow), activeProviders(settingsNow), settingsNow.connection),
        source: { kind: "audio", audio: [] },
        speakers: DEFAULT_SPEAKER_MODE,
        language: defaultRecordingLanguage(settingsNow.transcription.language),
        refs: [],
      };
      const folderId = target ?? (await createFolderNamed(options.name ?? "", now));
      const entry = await createRecordingIn(folderId, target === null, { kind: "rec", title: "", createdAt: now, recording });
      touchRecent({ projectId: folderId, pageId: entry.id, openedAt: now });
      if (flowToUse && !(await rememberFlow(flowToUse.id))) {
        showFailure("音声を追加しましたが、次の既定に保存できませんでした。");
      }
      if (options.then) await options.then({ projectId: folderId, recordingId: entry.recordingId ?? entry.id }, entry.id);
      await refreshProjects();
      if (navigation !== navigationRef.current) return true;
      if (target === null && !options.name) setFocusFolderTitle(true);
      applyScreen("work");
      await openProject(folderId);
      return true;
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "音声を追加できませんでした。"));
      await refreshProjects().catch(() => undefined);
      return false;
    } finally {
      createBusyRef.current = false;
    }
  };

  /**
   * フォルダに録音（音声）を作る。`createdFolder` はこの操作で作ったばかりのフォルダで、録音を作れなかったら空のまま残さず消す
   * （「＋ 新しい › 音声」・ドロップの再試行のたびに空のフォルダが増えないように。#18914）。
   */
  const createRecordingIn = async (folderId: string, createdFolder: boolean, page: NewPage): Promise<PageEntry> => {
    try {
      return await bridge.createPage(folderId, page);
    } catch (error) {
      if (createdFolder) await bridge.deleteEmptyFolder(folderId).catch(() => undefined);
      throw error;
    }
  };

  /** 新しいフォルダを作る（名前は空なら「無題のフォルダ」と出す）。 */
  const createFolderNamed = async (name: string, createdAt: string): Promise<string> => {
    const created = await bridge.createProject(
      { version: 1, id: "", name, createdAt, info: { terms: [], background: "", entities: [] }, pages: [] },
      null,
      null,
      [],
    );
    return created.id;
  };

  /** 「工程を選ぶ」で選んだ工程を保存し、テンプレートならそのまま音声を作る。白紙は工程設計で工程を足す。 */
  const chooseFlowForRecording = async (choice: FlowChoice) => {
    const pick = flowPick;
    if (!pick) return;
    setBusy(true);
    let created: Flow;
    try {
      // 白紙は工程設計へ移る。書きかけの文書を保存できなければ、工程も作らずここに留まる（テンプレートは addRecordingPage が保存する）
      if (choice === "blank") await flushDocForLeave();
      created = newFlowOf(choice, flowsRef.current);
      await bridge.saveFlow(created);
      // 工程を保存できたら、この先の失敗でダイアログを残さない（残すと「続ける」の再試行が同名の別の工程をもう一つ作る）。設定は
      // 変えていないので書けなくても進め、一覧を読み直せなければ今の一覧に作った工程を足す
      await persistSettings(settingsRef.current).catch(() => undefined);
      const list = await reloadFlows().catch(() => null);
      if (!list) putFlows([...flowsRef.current, created], lastUsedFlowRef.current);
      setDesignFlowId(created.id);
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "保存できませんでした。"));
      return;
    } finally {
      setBusy(false);
    }
    setFlowPick(null);
    if (choice === "blank") applyScreen("flow");
    // 窓へのドロップから来たときは、選んだ工程で音声を取り込む（＋ → 音声と同じ入口）
    else if (pick.drop) await processFileDrop(pick.drop.paths, { location: pick.drop.location, navigation: navigationRef.current }, created);
    else await addRecordingPage(pick.target, { flow: created, name: pick.name, then: pick.then });
  };

  // ⌘F: 開いているページの文書の検索を開く（⋯ の「検索」と同じ。エディタの無いページでは何もしない。owner 2026-10-18・#18941）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
      const tools = editorToolsRef.current;
      if (!tools?.available) return;
      if (modalOpenRef.current || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault();
      tools.openSearch();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editorToolsRef, modalOpenRef]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || !event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      if (modalOpenRef.current) return;
      // ⇧⌘N は「＋ 新しい › 音声」と同じ（音声 1 セット入りの新しいフォルダ。#18914）
      if (event.shiftKey) void addRecordingPage(null);
      else void addDocPage();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Finder の音声 drop は App の購読 1 本だけで受ける。内部レール DnD は DOM の text/x-niho なのでここには来ない。
  // 工程設計のサンプル文書ドロップだけは画面側が扱い、音声ドロップは App が一元処理する。
  const pageHandlesFileDrop = screen === "flow" && designFlowId !== null && deletingFlow === null;
  /**
   * ドロップした音声をフォルダの音声へ取り込む（1 フォルダ 1 音声。#18914）。フォルダを開いていれば（location）その音声に足し（無ければ
   * 作る。足すのは「＋ 音声を追加」と同じ: 実行中・会話中は断り、文章の録音には足さない）、フォルダを開いていなければ、ファイル名
   * （拡張子なし）の新しいフォルダを作って入れる。location・navigation はドロップした時点のもの（取り込みを待つ間に移っても、ドロップ
   * 時点の場所へ入れ、後の選択を上書きしない）。新しく録音を作るのに工程が 1 つも無いときは「＋ → 音声」と同じ「工程を選ぶ」から始め
   * （白紙の工程で黙って録音を作らない。#18789）、選んだ工程（chosenFlow）で改めて取り込む。
   */
  const processFileDrop = async (
    paths: string[],
    ctx: { location: string | null; navigation: number },
    chosenFlow: Flow | null = null,
  ) => {
    const { location, navigation } = ctx;
    if (dropBusyRef.current || createBusyRef.current || moveBusyRef.current) return;
    if ((!chosenFlow && modalOpenRef.current) || recordingInteractionRef.current || rootChangeRef.current) {
      showFailure("開いている操作を終えてから音声をドロップしてください。");
      return;
    }
    dropBusyRef.current = true;
    setFileDropOver(false);
    try {
      const infos = await bridge.audioInfo(paths);
      const invalid = Math.max(0, paths.length - infos.length);
      if (infos.length === 0) {
        showFailure("音声ファイルではありません。ページは作りませんでした。");
        return;
      }
      // 開いているフォルダの音声（あればそこへ足す）
      let reuse: { rec: RecordingRef; keep: string[] } | null = null;
      if (location !== null) {
        const opened = openProjectOf(await bridge.loadPages(location));
        const existing = folderRecordingPage(opened.pages);
        if (existing) {
          const recordingId = existing.recordingId ?? existing.id;
          const source = opened.recordings[recordingId]?.recording.source;
          if (runRef.current?.projectId === location || chatSendingProjectRef.current === location) {
            throw { code: "store_busy", message: "実行中または会話中の録音には音声を追加できません。" };
          }
          if (!source) throw NO_RECORDING;
          if (source.kind !== "audio") throw { code: "store_bad_page", message: "文章を貼ったフォルダには音声を追加できません。" };
          reuse = { rec: { projectId: location, recordingId }, keep: source.audio.map((item) => item.file) };
        }
      }
      // フローの件数ではなく、既定にできるフローに工程があるかで決める（「白紙から」で工程を足さずに保存した空のフローがあると、
      // 工程の無い録音が黙って作られてしまう）
      if (!reuse && !chosenFlow && (defaultFlowOf(flowsRef.current, lastUsedFlowRef.current)?.steps.length ?? 0) === 0) {
        setFlowPick({ target: location, drop: { paths, location } });
        return;
      }
      let rec: RecordingRef;
      let folderId: string;
      if (reuse) {
        rec = reuse.rec;
        folderId = location as string;
      } else {
        const flow = chosenFlow ?? defaultFlowOf(flowsRef.current, lastUsedFlowRef.current) ?? createBlankFlow(newId("blank"));
        const now = new Date().toISOString();
        const settingsNow = settingsRef.current;
        const recording: Recording = { version: 1, id: "", createdAt: now, flowSnapshot: createFlowSnapshot(flow, activeProfiles(settingsNow), activeProviders(settingsNow), settingsNow.connection), source: { kind: "audio", audio: [] }, speakers: DEFAULT_SPEAKER_MODE, language: defaultRecordingLanguage(settingsNow.transcription.language), refs: [] };
        await flushDocForLeave();
        const title = audioTitle(infos[0]!.name);
        folderId = location ?? (await createFolderNamed(title, now));
        const created = await createRecordingIn(folderId, location === null, { kind: "rec", title, createdAt: now, recording });
        rec = { projectId: folderId, recordingId: created.recordingId ?? created.id };
        touchRecent({ projectId: folderId, pageId: created.id, openedAt: now });
        if (flowsRef.current.some((candidate) => candidate.id === flow.id)) void rememberFlow(flow.id);
      }
      await appendAudio(bridge, rec, infos, reuse?.keep ?? []);
      await refreshProjects();
      if (navigation === navigationRef.current) {
        setFocusTitle(null);
        applyScreen("work");
        await openProject(folderId);
      }
      if (invalid > 0) showFailure(`${invalid}件は音声ファイルではないため取り込みませんでした。`);
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "音声を取り込めませんでした。"));
      await refreshProjects().catch(() => undefined);
    } finally {
      dropBusyRef.current = false;
    }
  };
  fileDropHandlerRef.current = (paths) => {
    const droppedOpen = openRef.current;
    const navigation = navigationRef.current;
    // フォルダ（背景情報のページ・中の文書・成果物）を開いていればそのフォルダの音声へ、それ以外は新しいフォルダへ
    const location = screenRef.current === "work" && droppedOpen && droppedOpen.id !== null ? droppedOpen.id : null;
    const action = () => void processFileDrop(paths, { location, navigation });
    if (guardAboutLeave(action)) action();
  };
  useEffect(() => {
    if (pageHandlesFileDrop) {
      setFileDropOver(false);
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void bridge.onFileDrop?.((paths) => fileDropHandlerRef.current(paths), (over) => setFileDropOver(over))
      .then((stop) => { if (disposed) stop(); else unlisten = stop; });
    return () => { disposed = true; unlisten?.(); };
  }, [bridge, fileDropHandlerRef, pageHandlesFileDrop, setFileDropOver]);

  const applyRailDrop = async (drop: RailDrop) => {
    if (moveBusyRef.current || createBusyRef.current || dropBusyRef.current) return;
    const navigation = navigationRef.current;
    moveBusyRef.current = true;
    try {
      await flushDocForLeave();
      if (drop.kind === "folder") {
        await bridge.reorderProject(drop.projectId, drop.beforeProjectId);
        await refreshProjects();
      } else {
        if (capture.active || capture.saving) {
          throw { code: "store_busy", message: "録音の保存が終わってからページを移動してください。" };
        }
        const source = drop.sourceProjectId === null ? outside : folders.find((folder) => folder.id === drop.sourceProjectId) ?? null;
        const page = source?.pages.find((item) => item.id === drop.pageId);
        if (!page) throw { code: "store_no_page", message: "ページが見つかりません。" };
        if (page.kind === "rec" && (runRef.current?.projectId === drop.sourceProjectId || chat.sendingProjectId === drop.sourceProjectId)) {
          throw { code: "store_busy", message: "実行中または会話の送信中の録音は移動できません。" };
        }
        if (page.kind === "rec" && recordingInteractionRef.current) {
          throw { code: "store_busy", message: "録音の保存が終わってから移動してください。" };
        }
        const sourceRecordingId = page.kind === "rec" ? page.recordingId ?? page.id : null;
        await bridge.renamePage(drop.sourceProjectId, page.id, rawTitleAt(drop.sourceProjectId, page));
        if (page.kind === "rec" && recordingInteractionRef.current) {
          throw { code: "store_busy", message: "録音の保存が終わってから移動してください。" };
        }
        const moved = await bridge.movePage(drop.sourceProjectId, page.id, drop.targetProjectId, drop.beforePageId);
        if (sourceRecordingId !== null && drop.sourceProjectId !== drop.targetProjectId) {
          rekeyMovedRecordingDrafts(drop.sourceProjectId, sourceRecordingId, drop.targetProjectId, moved.recordingId ?? moved.id);
        }
        await refreshProjects();
        if (navigation === navigationRef.current) {
          applyScreen("work");
          await openProject(drop.targetProjectId, moved.id);
        }
      }
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "並びを変えられませんでした。"));
      await refreshProjects().catch(() => undefined);
      const current = openRef.current;
      if (current) await reloadOpen(current.id).catch(() => undefined);
    } finally {
      moveBusyRef.current = false;
    }
  };

  const reorderPage = (delta: -1 | 1, pageIdOverride?: string) => {
    const current = openRef.current; const selected = selectionRef.current;
    const pageId = pageIdOverride ?? selected?.pageId;
    if (!current || !pageId) return;
    const index = current.pages.findIndex((item) => item.id === pageId);
    const before = delta < 0 ? current.pages[index - 1]?.id : (current.pages[index + 2]?.id ?? null);
    if (index < 0 || (delta < 0 && index === 0) || (delta > 0 && index === current.pages.length - 1)) return;
    void applyRailDrop({ kind: "page", sourceProjectId: current.id, pageId, targetProjectId: current.id, beforePageId: before ?? null, mark: delta < 0 ? "before" : "after" });
  };

  const reorderFolder = (projectId: string, delta: -1 | 1) => {
    const index = folders.findIndex((folder) => folder.id === projectId);
    if (index < 0 || (delta < 0 && index === 0) || (delta > 0 && index === folders.length - 1)) return;
    const beforeProjectId = delta < 0 ? folders[index - 1]!.id as string : (folders[index + 2]?.id as string | undefined) ?? null;
    void applyRailDrop({ kind: "folder", projectId, beforeProjectId, mark: delta < 0 ? "before" : "after" });
  };

  const deleteEmptyFolder = async (projectId: string): Promise<boolean> => {
    if (!guardAboutLeave(() => void deleteEmptyFolder(projectId))) return false;
    if (createBusyRef.current || dropBusyRef.current || moveBusyRef.current || runRef.current?.projectId === projectId || chat.sendingProjectId === projectId) {
      showFailure("処理が終わってからフォルダを削除してください。");
      return false;
    }
    try {
      await flushDocForLeave();
      await bridge.deleteEmptyFolder(projectId);
      if (openRef.current?.id === projectId) {
        putOpen(null);
        putSelection(null);
        putView(null);
      }
      await refreshProjects();
      showToast("空のフォルダを削除しました。");
      return true;
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "フォルダを削除できませんでした。"));
      return false;
    }
  };

  /**
   * ページを消す（確認の後）。録音のページは成果物・版・会話も消える（同じ案件の実行中は Rust が断る）。隣のページ（前、無ければ
   * 次）を開く。
   */
  const deletePage = async () => {
    const target = deleting;
    const current = openRef.current;
    if (!target || !current || current.id !== target.projectId) return;
    if (capture.active || capture.saving) {
      setDeleting(null);
      showFailure("録音の保存が終わってからページを削除してください。");
      return;
    }
    if (runRef.current?.projectId === current.id || chatSendingProjectRef.current === current.id) {
      setDeleting(null);
      showFailure("工程の実行か「AIと作る」の依頼が終わってから削除できます。");
      return;
    }
    setDeleteBusy(true);
    try {
      await flushDocForLeave();
      const index = current.pages.findIndex((page) => page.id === target.pageId);
      const neighbor = current.pages[index - 1] ?? current.pages[index + 1] ?? null;
      await bridge.deletePage(current.id, target.pageId);
      if (target.kind === "rec") {
        // 消した録音の書きかけ・知らせ・畳みの印を外す
        const deletedPage = current.pages.find((page) => page.id === target.pageId);
        const recordingId = deletedPage?.recordingId ?? target.pageId;
        const key = recordingKey({ projectId: current.id, recordingId });
        setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([draft]) => !draft.startsWith(`${key}::`))));
        setNotice((last) => (last && last.projectId === current.id && last.recordingId === recordingId ? null : last));
        if (viewRef.current?.key === key) putView(null);
      }
      const next = await reloadOpen(current.id);
      // フォルダの音声を消したときは背景情報のページに残る（#18914）。それ以外は隣のページ
      const nextPage = target.kind === "rec" && current.id !== null ? undefined : neighbor ? next.pages.find((page) => page.id === neighbor.id) : next.pages[0];
      await showPage(next, nextPage ? { pageId: nextPage.id, stepId: null } : null);
      await refreshProjects();
      showToast("削除しました");
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "削除できませんでした。"));
    } finally {
      setDeleteBusy(false);
      setDeleting(null);
    }
  };

  const movePage = async (targetProjectId: ProjectId, pageIdOverride?: string) => {
    if (!guardAboutLeave(() => void movePage(targetProjectId, pageIdOverride))) return;
    if (moveBusyRef.current || createBusyRef.current || dropBusyRef.current) return;
    if (capture.active || capture.saving) {
      showFailure("録音の保存が終わってからページを移動してください。");
      return;
    }
    const current = openRef.current;
    const selected = selectionRef.current;
    const pageId = pageIdOverride ?? selected?.pageId;
    if (!current || !pageId || current.id === targetProjectId) return;
    const page = current.pages.find((candidate) => candidate.id === pageId);
    if (!page) return;
    if (runRef.current?.projectId === current.id || chatSendingProjectRef.current === current.id) {
      showFailure("工程の実行か「AIと作る」の依頼が終わってから移動できます。");
      return;
    }
    if (page.kind === "rec" && recordingInteractionRef.current) {
      showFailure("録音の保存が終わってから移動してください。");
      return;
    }
    const recBusy = page.kind === "rec" && (runRef.current?.projectId === current.id || chat.sendingProjectId === current.id);
    if (recBusy) {
      showFailure("実行中または会話の送信中の録音は移動できません。");
      return;
    }
    const navigation = navigationRef.current;
    moveBusyRef.current = true;
    try {
      // 本文と題を移動元へ確実に保存してから rename する。どちらかが失敗したら move_page は呼ばない。
      await flushDocForLeave();
      if (page.kind === "rec" && recordingInteractionRef.current) {
        throw { code: "store_busy", message: "録音の保存が終わってから移動してください。" };
      }
      const sourceRecordingId = page.kind === "rec" ? page.recordingId ?? page.id : null;
      await bridge.renamePage(current.id, page.id, rawTitleAt(current.id, page));
      if (page.kind === "rec" && recordingInteractionRef.current) {
        throw { code: "store_busy", message: "録音の保存が終わってから移動してください。" };
      }
      const moved = await bridge.movePage(current.id, page.id, targetProjectId);
      if (sourceRecordingId !== null) rekeyMovedRecordingDrafts(current.id, sourceRecordingId, targetProjectId, moved.recordingId ?? moved.id);
      await refreshProjects();
      if (navigation === navigationRef.current) {
        setFocusTitle(null);
        await openProject(targetProjectId, moved.id);
      }
      if (page.kind === "rec") showToast("移動したので新しい会話で始めます。以前の会話は履歴から見られます。");
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "ページを移動できませんでした。"));
      await refreshProjects().catch(() => undefined);
      if (openRef.current) await reloadOpen(openRef.current.id).catch(() => undefined);
    } finally {
      moveBusyRef.current = false;
    }
  };
  return {
    selectPage, selectLocationPage, rawTitleAt, rawTitle,
    inputTitle, commitTitle, commitFolderTitle, addDocPage,
    flowPick, setFlowPick, addRecordingPage, chooseFlowForRecording,
    processFileDrop, applyRailDrop, reorderPage, reorderFolder,
    deleteEmptyFolder, deletePage, movePage,
  };
}
