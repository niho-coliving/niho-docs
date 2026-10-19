"use client";

import { useSyncExternalStore } from "react";
import type { DocsWorkspaceHost } from "../host/DocsWorkspaceHost";
import { FolderCreationRow, WorkspaceOperationNotice } from "../components/WorkspaceOperation";
import { DocPage } from "../components/DocPage";
import { FolderHome } from "../components/FolderHome";
import { Rail } from "../components/Rail";
import { DesktopShell } from "../components/WindowTitlebar";
import { VaultFlowDesign } from "./VaultFlowDesign";
import { HomeScreen } from "./HomeScreen";

/** vault host の接続だけを担当する。各画面とCSSはMacと同じ部品を使う。 */
export function VaultWorkspace({ host }: { host: DocsWorkspaceHost }) {
  const state = useSyncExternalStore(host.subscribe, host.getSnapshot, host.getSnapshot);
  const actions = host.actions;
  const busy = !!state.operation;
  const editingLocked = busy && state.operation?.phase !== "failed";
  const pageAt = state.open?.pages.findIndex((page) => page.id === state.location.pageId) ?? -1;
  const documentActions = !busy && actions && state.location.pageId ? {
    folders: state.folders.map((folder) => ({ id: folder.id as string, name: folder.project.name || "無題のフォルダ" })),
    currentProjectId: state.location.projectId,
    onMove: actions.moveDocument ? (target: string | null) => actions.moveDocument!(state.location.projectId, state.location.pageId!, target) : undefined,
    first: pageAt <= 0, last: pageAt >= (state.open?.pages.length ?? 0) - 1,
    onDelete: actions.deleteDocument ? () => actions.deleteDocument!(state.location.projectId, state.location.pageId!) : undefined,
    onReorder: actions.reorderDocument ? (delta: -1 | 1) => actions.reorderDocument!(state.location.projectId, state.location.pageId!, delta === -1 ? "up" : "down") : undefined,
  } : undefined;
  return <DesktopShell browser>
    <div data-docs-app-root data-docs-shared-ui className="docs-app-content" data-docs-workspace>
      <div className={`app${state.open ? " workspace-page" : " workspace-home"}`}>
        <Rail outside={state.outside} folders={state.folders} open={state.open} selection={state.location.pageId ? { pageId: state.location.pageId, stepId: null } : null} screen={state.location.screen ?? "work"} activeRun={null}
          titleOf={(_location, page) => page.title} flowDesign={Boolean(host.flows)} newProjectId={state.location.projectId} browser mutationsDisabled={busy} externalDeleteNotice
          onScreen={(screen) => void host.navigate({ ...state.location, screen: screen === "flow" || screen === "settings" ? screen : undefined })}
          onNewFolder={actions?.beginFolder} onAddDoc={actions?.createDocument ? (projectId) => void actions.createDocument!(projectId) : undefined}
          onDeleteFolder={actions?.deleteFolder} folderDeleteBlock={actions?.folderDeleteBlock}
          creationRow={state.folderCreation && actions ? <><FolderCreationRow value={state.folderCreation.value} locked={editingLocked} actions={actions} />{state.operation?.kind === "create-folder" && <WorkspaceOperationNotice operation={state.operation} actions={actions} />}</> : undefined}
          onHome={() => void host.navigate({ projectId: null, pageId: null })}
          onOpenLocation={(projectId) => void host.navigate({ projectId, pageId: null })}
          onOpenInfo={(projectId) => void host.navigate({ projectId, pageId: null })}
          onSelectPage={(projectId, pageId) => void host.navigate({ projectId, pageId })} />
        <main className="main"><div className="page">
          {state.operation && actions && (!state.folderCreation || state.operation.kind !== "create-folder") && <WorkspaceOperationNotice operation={state.operation} actions={actions} />}
          {state.error && <div className="loaderr" role="alert"><p>{state.error}</p><button className="btn outline sm" onClick={() => void host.refresh()}>読み込み直す</button></div>}
          {state.loading ? <p role="status">ページとフォルダを読み込んでいます…</p>
            : state.location.screen === "flow" && host.flows ? <VaultFlowDesign session={host.flows} />
            : state.document ? <div className="work noai"><DocPage session={state.document} actions={documentActions} busy={editingLocked} /></div>
              : state.open ? <FolderHome folder={state.open} title={state.open.project.name} titleSession={state.folderTitle} infoSession={state.folderInfo} locked={editingLocked} readOnly />
                : <HomeScreen recent={state.recent} hasPages={state.outside.pages.length > 0 || state.folders.some((folder) => folder.pages.length > 0)} onOpen={(row) => void host.navigate({ projectId: row.projectId, pageId: row.page.id })} />}
        </div></main>
      </div>
    </div>
  </DesktopShell>;
}
