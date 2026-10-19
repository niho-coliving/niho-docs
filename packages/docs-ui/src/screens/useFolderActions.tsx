"use client";

import { type PromptRef } from "@niho/docs-core";
import { type Failure, type FailureAction } from "../components/FailureBand";
import { type Screen, type Selection } from "../components/Rail";
import type { ProjectEntry } from "../host/DocsHost";
import { errorMessage, type Bridge, type ProjectId, type RecordingRef } from "../lib/bridge";
import { recordingRef, type OpenProject, type RecordingView } from "../lib/project-view";
import { DOC_FLUSH_FAILED } from "./workspace-model";

type Context = {
  guardAboutLeave: (action: () => void) => boolean;
  createBusyRef: React.MutableRefObject<boolean>;
  dropBusyRef: React.MutableRefObject<boolean>;
  moveBusyRef: React.MutableRefObject<boolean>;
  navigationRef: React.MutableRefObject<number>;
  setFailure: React.Dispatch<React.SetStateAction<Failure | null>>;
  flushDocForLeave: () => Promise<void>;
  bridge: Bridge;
  refreshProjects: (shouldApply?: () => boolean) => Promise<ProjectEntry[]>;
  applyScreen: (next: Screen) => void;
  openProject: (projectId: ProjectId, pageId?: string | null) => Promise<OpenProject>;
  setFocusFolderTitle: React.Dispatch<React.SetStateAction<boolean>>;
  showFailure: (text: string, action?: FailureAction) => void;
  markNavigation: () => void;
  putOpen: (next: OpenProject | null) => void;
  putSelection: (next: Selection | null) => void;
  putView: (next: RecordingView | null) => void;
  reloadOpen: (projectId: ProjectId) => Promise<OpenProject>;
  viewRef: React.MutableRefObject<RecordingView | null>;
  reloadView: (rec: RecordingRef, frozenRefs?: readonly PromptRef[], shouldApply?: () => boolean) => Promise<RecordingView>;
};

/** フォルダの作成と背景情報を更新した後の読み直し。 */
export function useFolderActions(context: Context) {
  const {
    guardAboutLeave, createBusyRef, dropBusyRef, moveBusyRef,
    navigationRef, setFailure, flushDocForLeave, bridge,
    refreshProjects, applyScreen, openProject, setFocusFolderTitle,
    showFailure, markNavigation, putOpen, putSelection,
    putView, reloadOpen, viewRef, reloadView,
  } = context;

  // ---- フォルダ ----

  /** 新しいフォルダはダイアログを出さずに作り、ホームの題へフォーカスする。 */
  const createFolder = async () => {
    if (!guardAboutLeave(() => void createFolder())) return;
    if (createBusyRef.current || dropBusyRef.current || moveBusyRef.current) return;
    const navigation = navigationRef.current;
    createBusyRef.current = true;
    // 新しいページ・フォルダを作って開く（ページの移動）ので、前の失敗の帯は消す
    setFailure(null);
    try {
      await flushDocForLeave();
      const created = await bridge.createProject(
        {
          version: 1,
          id: "",
          name: "",
          createdAt: new Date().toISOString(),
          info: { terms: [], background: "" },
          pages: [],
        },
        null,
        null,
        [],
      );
      await refreshProjects();
      if (navigation !== navigationRef.current) return;
      applyScreen("work");
      await openProject(created.id);
      setFocusFolderTitle(true);
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "フォルダを作れませんでした。"));
    } finally {
      createBusyRef.current = false;
    }
  };

  const goHome = async () => {
    if (!guardAboutLeave(() => void goHome())) return;
    markNavigation();
    try {
      await flushDocForLeave();
      putOpen(null);
      putSelection(null);
      putView(null);
      applyScreen("work");
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "文書を保存できないためホームへ移動しませんでした。"));
    }
  };

  /** 背景情報を保存した後（一覧・開いているフォルダ・フォルダの録音の見え方を読み直す）。 */
  const onInfoSaved = async (projectId: string) => {
    try {
      await refreshProjects();
      await reloadOpen(projectId);
      const current = viewRef.current;
      if (current?.projectId === projectId) await reloadView(recordingRef(current));
    } catch (error) {
      showFailure(errorMessage(error, "フォルダを読み直せませんでした。"));
    }
  };

  const openLocation = async (projectId: ProjectId) => {
    if (!guardAboutLeave(() => void openLocation(projectId))) return;
    markNavigation();
    try {
      applyScreen("work");
      await openProject(projectId);
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "場所を開けませんでした。"));
    }
  };

  /** レールの「背景情報」: フォルダの行と同じ背景情報のページ（#18914。以前はダイアログ）。 */
  const openInfo = async (projectId: string) => {
    if (!guardAboutLeave(() => void openInfo(projectId))) return;
    markNavigation();
    try {
      applyScreen("work");
      await openProject(projectId);
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "背景情報を開けませんでした。"));
    }
  };
  return {
    createFolder, goHome, onInfoSaved, openLocation,
    openInfo,
  };
}
