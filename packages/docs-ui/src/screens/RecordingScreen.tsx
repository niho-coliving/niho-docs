"use client";

import { folderName, folderRecordingPage, type PageEntry, type RunStartAction } from "@niho/docs-core";
import type { Dispatch, SetStateAction } from "react";
import { PageMenu, PageTop } from "../components/PageTop";
import { RecordingPage, type RecordingControlsProps } from "../components/RecordingPage";
import { type ProjectId } from "../lib/bridge";
import { type ChatTarget } from "../lib/chat";
import { type OpenProject, type RecordingView } from "../lib/project-view";
import { type ChatController } from "../lib/use-chat";
import { type RebuildRequest } from "./workspace-model";

import type { useAppRecording } from "../lib/app-recording";

type Props = {
  capture: ReturnType<typeof useAppRecording>;
  runningProject: boolean;
  chatBusyInProject: (rec: RecordingView) => boolean;
  view: RecordingView;
  recordingInteractionBusy: boolean;
  chatToggle: React.JSX.Element;
  folders: OpenProject[];
  open: OpenProject;
  page: PageEntry;
  reorderPage: (delta: -1 | 1, pageIdOverride?: string) => void;
  movePage: (targetProjectId: ProjectId, pageIdOverride?: string) => Promise<void>;
  addDocPage: (targetProjectId?: ProjectId, afterPageId?: string) => Promise<void>;
  setDeleting: Dispatch<SetStateAction<{ projectId: ProjectId; pageId: string; title: string; kind: PageEntry["kind"]; audio?: boolean; } | null>>;
  recordingTitle: string;
  controlsFor: (rv: RecordingView, recordingPage: PageEntry, originTitle: string) => RecordingControlsProps;
  rawTitle: (page: PageEntry) => string;
  focusTitle: string | null;
  editTitle: (pageId: string) => { onTitleInput: (title: string) => void; onTitleCommit: (title: string) => Promise<boolean>; onTitleFocused: () => void; };
  startRun: (queue: string[], fixedTarget?: (ChatTarget & { instruction?: string; }) | null, trigger?: "selection" | "step", rebuild?: RebuildRequest | null, action?: RunStartAction | null) => boolean;
  selectPage: (pageId: string, stepId?: string | null, candidateId?: string | null, shouldApply?: () => boolean) => Promise<void>;
  recordingChat: ChatController;
  chatOpen: boolean;
  loadPartial: (runId: string) => Promise<string | null>;
};

/** RecordingScreen の描画。保存・実行・遷移の操作は controller から受け取る。 */
export function RecordingScreen(props: Props) {
  const {
    capture, runningProject, chatBusyInProject, view,
    recordingInteractionBusy, chatToggle, folders, open,
    page, reorderPage, movePage, addDocPage,
    setDeleting, recordingTitle, controlsFor, rawTitle,
    focusTitle, editTitle, startRun, selectPage,
    recordingChat, chatOpen, loadPartial,
  } = props;

    // フォルダの外の録音のページ（以前のデータ）。同じ場所の実行中（会話の依頼も実行のロックを持つ）は消せない
    const deleteBlocked = capture.active || capture.saving
      ? "録音の保存が終わってから削除できます。"
      : runningProject
      ? "工程の実行が終わってから削除できます。"
      : chatBusyInProject(view)
        ? "AIと作るの依頼が終わってから削除できます。"
        : null;
    const moveBlocked = capture.active || capture.saving
      ? "録音の保存が終わってから移動できます。"
      : runningProject
      ? "実行中の録音は移動できません。"
      : chatBusyInProject(view)
        ? "AIと作るの依頼が終わってから移動できます。"
        : recordingInteractionBusy
          ? "録音の保存が終わってから移動できます。"
          : null;
    return (
      <>
        <PageTop>
          {chatToggle}
          <PageMenu
            deleteBlocked={deleteBlocked}
            moveBlocked={moveBlocked}
            folders={folders.filter((folder) => !folderRecordingPage(folder.pages)).map((folder) => ({ id: folder.id as string, name: folderName(folder.project) }))}
            currentProjectId={open.id}
            first={open.pages[0]?.id === page.id}
            last={open.pages.at(-1)?.id === page.id}
            onReorder={reorderPage}
            onMove={(target) => void movePage(target)}
            onAddDocument={() => void addDocPage(open.id, page.id)}
            onDelete={() => setDeleting({ projectId: open.id, pageId: page.id, title: recordingTitle, kind: "rec" })}
          />
        </PageTop>
        <RecordingPage
          key={view.key}
          {...controlsFor(view, page, recordingTitle)}
          title={rawTitle(page)}
          focusTitle={focusTitle === page.id}
          {...editTitle(page.id)}
          onRunStep={(id) => startRun([id])}
          onOpenStep={(id) => void selectPage(page.id, id)}
          chat={recordingChat}
          chatOpen={chatOpen}
          loadPartial={loadPartial}
        />
      </>
    );

}
