"use client";

import { folderName, folderRecordingPage, type Flow, type PageEntry } from "@niho/docs-core";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { type DocFlush } from "../components/DocPage";
import { type FailureAction } from "../components/FailureBand";
import { FolderHome } from "../components/FolderHome";
import { PageMenu, PageTop } from "../components/PageTop";
import { type RecordingControlsProps } from "../components/RecordingPage";
import { type CaptureTarget } from "../lib/app-recording";
import { errorMessage, type Bridge, type ProjectId } from "../lib/bridge";
import { type OpenProject, type RecordingView } from "../lib/project-view";
import { type ChatController } from "../lib/use-chat";
import { titleKey, type RecordingThen } from "./workspace-model";

import type { useAppRecording } from "../lib/app-recording";

type Props = {
  open: OpenProject;
  titleEdits: Record<string, string>;
  view: RecordingView | null;
  capture: ReturnType<typeof useAppRecording>;
  folderLocked: boolean;
  saving: boolean;
  bridge: Bridge;
  processFileDrop: (paths: string[], ctx: { location: string | null; navigation: number; }, chosenFlow?: Flow | null) => Promise<void>;
  navigationRef: MutableRefObject<number>;
  showFailure: (text: string, action?: FailureAction) => void;
  addRecordingPage: (target: string | null, options?: { flow?: Flow | null; name?: string; then?: RecordingThen; }) => Promise<boolean>;
  captureTarget: (pageId?: string) => CaptureTarget;
  runningProject: boolean;
  chat: ChatController;
  moveBusyRef: MutableRefObject<boolean>;
  createBusyRef: MutableRefObject<boolean>;
  dropBusyRef: MutableRefObject<boolean>;
  recordingInteractionBusy: boolean;
  chatToggle: React.JSX.Element;
  folders: OpenProject[];
  movePage: (targetProjectId: ProjectId, pageIdOverride?: string) => Promise<void>;
  setDeleting: Dispatch<SetStateAction<{ projectId: ProjectId; pageId: string; title: string; kind: PageEntry["kind"]; audio?: boolean; } | null>>;
  focusFolderTitle: boolean;
  setFocusFolderTitle: Dispatch<SetStateAction<boolean>>;
  setTitleEdits: Dispatch<SetStateAction<Record<string, string>>>;
  titleEditsRef: MutableRefObject<Record<string, string>>;
  commitFolderTitle: (projectId: string, title: string) => Promise<boolean>;
  infoDirtyRef: MutableRefObject<boolean>;
  setInfoEditing: Dispatch<SetStateAction<boolean>>;
  onInfoSaved: (projectId: string) => Promise<void>;
  docFlushRef: MutableRefObject<DocFlush | null>;
  controlsFor: (rv: RecordingView, recordingPage: PageEntry, originTitle: string) => RecordingControlsProps;
  selectLocationPage: (projectId: ProjectId, pageId: string, stepId: string | null, candidateId?: string | null, shouldApply?: () => boolean) => Promise<void>;
  chatOpen: boolean;
  recordingChatColumn: (rv: RecordingView) => React.JSX.Element;
};

/** FolderScreen の描画。保存・実行・遷移の操作は controller から受け取る。 */
export function FolderScreen(props: Props) {
  const {
    open, titleEdits, view, capture,
    folderLocked, saving, bridge, processFileDrop,
    navigationRef, showFailure, addRecordingPage, captureTarget,
    runningProject, chat, moveBusyRef, createBusyRef,
    dropBusyRef, recordingInteractionBusy, chatToggle, folders,
    movePage, setDeleting, focusFolderTitle, setFocusFolderTitle,
    setTitleEdits, titleEditsRef, commitFolderTitle, infoDirtyRef,
    setInfoEditing, onInfoSaved, docFlushRef, controlsFor,
    selectLocationPage, chatOpen, recordingChatColumn,
  } = props;

      // フォルダのページ＝背景情報のページ（#18914）: 背景情報・登場人物・固有名詞と、フォルダの音声 1 セット
      if (open.id === null) return null;
      const folderId = open.id;
      const folderTitle = titleEdits[titleKey(folderId, "_folder")] ?? open.project.name;
      const recordingPages = open.pages.filter((item) => item.kind === "rec");
      const recordingPage = (view?.projectId === folderId
        ? recordingPages.find((item) => (item.recordingId ?? item.id) === view.recordingId)
        : undefined) ?? folderRecordingPage(open.pages);
      const folderView = recordingPage && view && view.projectId === folderId && view.recordingId === (recordingPage.recordingId ?? recordingPage.id) ? view : null;
      const captureBusy = capture.active || capture.saving;
      // 音声が無いうちの欄: 押すとフォルダの音声を作り（工程が無ければ「工程を選ぶ」）、背景情報のページのまま続ける
      const start = {
        disabled: folderLocked || saving,
        recordDisabled: bridge.capabilities?.nativeRecording === false || folderLocked || saving || captureBusy,
        onPick: () => {
          void bridge.pickAudioFiles().then(
            (picked) => {
              if (picked.length > 0) void processFileDrop(picked.map((item) => item.path), { location: folderId, navigation: navigationRef.current });
            },
            (error: unknown) => showFailure(errorMessage(error, "音声を選べませんでした。")),
          );
        },
        onRecord: () => {
          void addRecordingPage(folderId, { then: async (_rec, pageId) => void capture.start(captureTarget(pageId)) });
        },
      };
      const deleteAudioBlocked = captureBusy
        ? "録音の保存が終わってから削除できます。"
        : runningProject
          ? "工程の実行が終わってから削除できます。"
          : chat.sendingProjectId === folderId
            ? "AIと作るの依頼が終わってから削除できます。"
            : null;
      const moveAudioBlocked = moveBusyRef.current || createBusyRef.current || dropBusyRef.current
        ? "音声の追加や保存が終わってから移動できます。"
        : captureBusy
        ? "録音の保存が終わってから移動できます。"
        : runningProject
          ? "実行中の録音は移動できません。"
          : chat.sendingProjectId === folderId
            ? "AIと作るの依頼が終わってから移動できます。"
            : recordingInteractionBusy
              ? "録音の保存が終わってから移動できます。"
              : null;
      return (
        <>
          {recordingPage && (
            <PageTop>
              {folderView && chatToggle}
              <PageMenu
                deleteLabel="音声を削除"
                deleteBlocked={deleteAudioBlocked}
                moveBlocked={moveAudioBlocked}
                folders={folders.filter((folder) => !folderRecordingPage(folder.pages)).map((folder) => ({ id: folder.id as string, name: folderName(folder.project) }))}
                currentProjectId={folderId}
                onMove={(target) => void movePage(target, recordingPage.id)}
                onDelete={() => setDeleting({ projectId: folderId, pageId: recordingPage.id, title: folderName(open.project), kind: "rec", audio: true })}
              />
            </PageTop>
          )}
          <FolderHome
            bridge={bridge}
            folder={open}
            title={folderTitle}
            autoFocus={focusFolderTitle}
            locked={folderLocked}
            onTitleFocused={() => setFocusFolderTitle(false)}
            onTitleInput={(title) => setTitleEdits((all) => {
              const next = { ...all, [titleKey(folderId, "_folder")]: title };
              titleEditsRef.current = next;
              return next;
            })}
            onTitleCommit={(title) => commitFolderTitle(folderId, title)}
            info={{
              onDirtyChange: (dirty) => {
                infoDirtyRef.current = dirty;
                setInfoEditing(dirty);
              },
              onSaved: () => onInfoSaved(folderId),
              flushRef: docFlushRef,
            }}
            controls={folderView && recordingPage ? controlsFor(folderView, recordingPage, folderName(open.project)) : recordingPage ? "loading" : null}
            recordingPages={recordingPages}
            activeRecordingPageId={recordingPage?.id ?? null}
            onSelectRecording={(pageId) => void selectLocationPage(folderId, pageId, null)}
            start={start}
            chat={folderView && chatOpen ? recordingChatColumn(folderView) : undefined}
          />
        </>
      );

}
