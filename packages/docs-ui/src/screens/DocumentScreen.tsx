"use client";

import { folderName, pageTitle, type PageEntry } from "@niho/docs-core";
import { useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { ChatPanel } from "../components/ChatPanel";
import { DocsWorkLayout } from "../components/DocsComposerRail";
import { DocPage, type DocFlush } from "../components/DocPage";
import type { EditorToolControls } from "../components/EditorTools";
import { FailureBand, type FailureAction } from "../components/FailureBand";
import { PageMenu, PageTop, type EditorMenuActions, type ExportActions } from "../components/PageTop";
import type { ProjectEntry } from "../host/DocsHost";
import { errorMessage, type Bridge, type ProjectId } from "../lib/bridge";
import type { CloudController } from "../lib/cloud";
import { cloudProjectId as toCloudProjectId, cloudSettled } from "../lib/cloud";
import { finalizeMarkdown } from "../lib/markdown";
import { type OpenProject, type RecordingView } from "../lib/project-view";
import { type ActiveRun } from "../lib/run-state";
import { type ChatController } from "../lib/use-chat";
import type { GoogleDocsController } from "../lib/use-google-docs";
import { titleKey } from "./workspace-model";

import type { useAppRecording } from "../lib/app-recording";

type Props = {
  rawTitle: (page: PageEntry) => string;
  page: PageEntry;
  capture: ReturnType<typeof useAppRecording>;
  docMarkdown: (pageId: string) => string | null;
  copy: (markdown: string) => Promise<void>;
  exportDocFile: (markdown: string, docTitle: string) => Promise<void>;
  accountShown: boolean;
  googleDocs: GoogleDocsController;
  open: OpenProject;
  bridge: Bridge;
  revealDoc: (pageId: string) => Promise<void>;
  chatToggle: React.JSX.Element;
  editorMenu: EditorMenuActions | null;
  folderLocked: boolean;
  folders: OpenProject[];
  reorderPage: (delta: -1 | 1, pageIdOverride?: string) => void;
  movePage: (targetProjectId: ProjectId, pageIdOverride?: string) => Promise<void>;
  setDeleting: Dispatch<SetStateAction<{ projectId: ProjectId; pageId: string; title: string; kind: PageEntry["kind"]; audio?: boolean; } | null>>;
  chatOpen: boolean;
  docReload: Record<string, number>;
  focusTitle: string | null;
  chat: ChatController;
  titleEdits: Record<string, string>;
  editTitle: (pageId: string) => { onTitleInput: (title: string) => void; onTitleCommit: (title: string) => Promise<boolean>; onTitleFocused: () => void; };
  openRef: MutableRefObject<OpenProject | null>;
  putOpen: (next: OpenProject | null) => void;
  refreshProjects: (shouldApply?: () => boolean) => Promise<ProjectEntry[]>;
  showFailure: (text: string, action?: FailureAction) => void;
  latestMarkdownRef: MutableRefObject<{ key: string; markdown: string; } | null>;
  docFlushRef: MutableRefObject<DocFlush | null>;
  cloud: CloudController;
  reviewConflict: (projectId: string, path: string | null) => Promise<void>;
  cloudDocReload: number;
  setEditorTools: Dispatch<SetStateAction<EditorToolControls | null>>;
  documentChat: { view: RecordingView | null; };
  activeRun: ActiveRun | null;
  saving: boolean;
  reloadOpen: (projectId: ProjectId) => Promise<OpenProject>;
};

/** DocumentScreen の描画。保存・実行・遷移の操作は controller から受け取る。 */
export function DocumentScreen(props: Props) {
  const [sharePublished, setSharePublished] = useState<{ key: string; active: boolean } | null>(null);
  const [shareRequest, setShareRequest] = useState<{ key: string; count: number } | null>(null);
  const [docShareLocal, setDocShareLocal] = useState<{ key: string; saved: boolean } | null>(null);
  const {
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
  } = props;

      const title = rawTitle(page);
      const projectId = toCloudProjectId(open.id);
      const contextGeneration = cloud.state?.contextGeneration ?? null;
      const shareKey = `${contextGeneration ?? "none"}:${projectId}:${page.id}:`;
      const openSharing = () => setShareRequest((current) => ({ key: shareKey, count: current?.key === shareKey ? current.count + 1 : 1 }));
      const snapshot = cloud.snapshots[projectId] ?? null;
      const sharing = {
        bridge,
        locator: { pageId: page.id, projectId, textId: null },
        contextGeneration,
        loggedIn: cloud.active,
        saved: cloudSettled(snapshot) && Boolean(snapshot?.lastSyncedAt)
          && docShareLocal?.key === shareKey && docShareLocal.saved
          && titleEdits[titleKey(open.id, page.id)] === undefined,
        onActive: (active: boolean) => setSharePublished({ key: shareKey, active }),
      };
      const captureBlocked = capture.active || capture.saving;
      const captureBlockReason = captureBlocked ? "録音の保存が終わってからページを移動・削除できます。" : null;
      const docExport: ExportActions = {
        disabled: false,
        onCopy: () => {
          const markdown = docMarkdown(page.id);
          if (markdown !== null) void copy(markdown);
        },
        onExportFile: () => {
          const markdown = docMarkdown(page.id);
          if (markdown !== null) void exportDocFile(markdown, pageTitle({ ...page, title }));
        },
        onExportGoogle: accountShown ? () => {
          const markdown = docMarkdown(page.id);
          if (markdown !== null) googleDocs.openExport({ sourceKey: `${open.id}:${page.id}`, title: pageTitle({ ...page, title }), markdown: finalizeMarkdown(markdown) });
        } : undefined,
        onReveal: bridge.capabilities?.fileReveal === false ? undefined : () => void revealDoc(page.id),
        sharing,
        sharingRequest: shareRequest?.key === shareKey ? shareRequest.count : 0,
      };
      return (
        <>
          <PageTop>
            {chatToggle}
            <PageMenu
              editor={editorMenu}
              exportActions={docExport}
              deleteBlocked={captureBlockReason ?? (folderLocked ? "工程の実行か「AIと作る」の依頼が終わってから削除できます。" : null)}
              moveBlocked={captureBlockReason ?? (folderLocked ? "工程の実行か「AIと作る」の依頼が終わってから移動できます。" : null)}
              folders={folders.map((folder) => ({ id: folder.id as string, name: folderName(folder.project) }))}
              currentProjectId={open.id}
              first={open.pages[0]?.id === page.id}
              last={open.pages.at(-1)?.id === page.id}
              onReorder={reorderPage}
              onMove={(target) => void movePage(target)}
              onDelete={() => setDeleting({ projectId: open.id, pageId: page.id, title: pageTitle({ ...page, title }), kind: "doc" })}
            />
          </PageTop>
          <DocsWorkLayout chatOpen={chatOpen}>
            <DocPage
              key={`${open.id}:${page.id}:${docReload[page.id] ?? 0}`}
              bridge={bridge}
              projectId={open.id}
              pageId={page.id}
              title={title}
              updatedMs={open.docUpdatedMs[page.id] ?? 0}
              focusTitle={focusTitle === page.id}
              editable={chat.sendingProjectId !== open.id}
              {...editTitle(page.id)}
              onSaved={(ms) => {
                const current = openRef.current;
                if (current?.id === open.id) putOpen({ ...current, docUpdatedMs: { ...current.docUpdatedMs, [page.id]: ms } });
                // 案件の並びは文書の更新時刻で決まるので、レールの案件の一覧も読み直す（読めなくても保存は済んでいる）
                void refreshProjects().catch(() => undefined);
              }}
              onError={showFailure}
              sharingActive={sharePublished?.key === shareKey && sharePublished.active}
              onOpenSharing={openSharing}
              onLocalSaved={(saved) => setDocShareLocal((current) => current?.key === shareKey && current.saved === saved ? current : { key: shareKey, saved })}
              onSnapshot={(snapshot) => {
                if (snapshot) latestMarkdownRef.current = snapshot;
                else if (latestMarkdownRef.current?.key === `${open.id}:${page.id}`) latestMarkdownRef.current = null;
              }}
              flushRef={docFlushRef}
              cloud={cloud}
              onReviewConflict={(path) => {
                void reviewConflict(toCloudProjectId(open.id), path);
              }}
              reloadKey={cloudDocReload}
              onEditorTools={setEditorTools}
            />
            {chatOpen && <div className="col">
              {documentChat.view ? <ChatPanel view={documentChat.view} chat={chat} activeRun={null}
                projectRunning={activeRun?.projectId === open.id} documentOnly
                loadPartial={async () => null} runBlocked saving={saving} onRunStep={() => undefined} />
                : <div className="rcard chatcard"><div className="ch"><h3>AIと作る</h3></div>
                  {/* 会話はページの台帳から作るので、読み直して開き直す（#18788） */}
                  <FailureBand
                    className="chat-failure"
                    message="文書の会話を開けませんでした。"
                    action={{
                      label: "もう一度開く",
                      run: () => {
                        void reloadOpen(open.id).catch((error: unknown) => showFailure(errorMessage(error, "ページの一覧を読み直せませんでした。")));
                      },
                    }}
                  />
                </div>}
            </div>}
          </DocsWorkLayout>
        </>
      );

}
