import type { PageEntry, ProjectInfo } from "@niho/docs-core";
import type { OpenProject } from "../lib/project-view";

export type DocsRecentPage = { projectId: string | null; page: PageEntry; title: string; folder: string; openedAt: string; progress: string | null };

/** 保存先と本人の scope。Mac 同期の有無とは独立している。 */
export type DocsLocation = { projectId: string | null; pageId: string | null; screen?: "flow" | "settings" };
/** 名前・背景情報の編集。保存基準と結果不明の受付は host が所有する。 */
export type DocsValueState<T> = {
  value: T; savedValue: T;
  phase: "saved" | "dirty" | "saving" | "unconfirmed" | "conflict" | "failed";
  error: string | null;
  conflict: { value: T; label: string } | null;
};
export type DocsValueSession<T> = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): DocsValueState<T>;
  edit(value: T): void;
  flush(): Promise<boolean>;
  confirm(): Promise<boolean>;
  cancel(): void;
  resolve(choice: "local" | "remote" | "compare"): Promise<boolean>;
};
export type DocsDocumentState = {
  markdown: string;
  savedMarkdown: string;
  phase: "saved" | "dirty" | "saving" | "unconfirmed" | "conflict" | "failed";
  recovery: boolean;
  conflict: { markdown: string; label: string } | null;
  error: string | null;
  draftAvailable: boolean;
};
/** Host が CAS・受付ID・下書きを保持し、画面は状態を表示する。 */
export type DocsDocumentSession = {
  key: string;
  title: string;
  updatedMs: number;
  titleEditor?: DocsValueSession<string>;
  autoFocusTitle?: boolean;
  subscribe(listener: () => void): () => void;
  getSnapshot(): DocsDocumentState;
  edit(markdown: string): void;
  flush(): Promise<boolean>;
  confirm(): Promise<boolean>;
  restoreDraft(): void;
  discardDraft(): void;
  resolve(choice: "local" | "remote"): Promise<boolean>;
  resolveAsset?(name: string): Promise<string>;
};
export type DocsWorkspaceOperation = {
  kind: "create-document" | "create-folder" | "delete-document" | "delete-folder" | "reorder-document" | "move-document";
  phase: "running" | "unconfirmed" | "failed" | "refresh-failed" | "partial" | "protected";
  label: string;
  message: string | null;
  canDismiss?: boolean;
};
export type DocsWorkspaceActions = {
  createDocument?(projectId: string | null): Promise<boolean>;
  beginFolder?(): void;
  editFolder?(value: string): void;
  cancelFolder?(): void;
  commitFolder?(): Promise<boolean>;
  deleteDocument?(projectId: string | null, pageId: string): Promise<boolean>;
  deleteFolder?(projectId: string): Promise<boolean>;
  reorderDocument?(projectId: string | null, pageId: string, direction: "up" | "down"): Promise<boolean>;
  moveDocument?(projectId: string | null, pageId: string, targetProjectId: string | null): Promise<boolean>;
  inspectMove?(side: "source" | "destination"): Promise<void>;
  recheckMove?(): Promise<void>;
  folderDeleteBlock?(projectId: string): string | null;
  confirm(): Promise<boolean>;
  retry(): Promise<boolean>;
  dismiss(): void;
};
export type DocsDocumentActions = { onMove?: (projectId: string | null) => Promise<boolean>; folders?: Array<{ id: string; name: string }>; currentProjectId?: string | null; onDelete?: () => Promise<boolean>; onReorder?: (delta: -1 | 1) => Promise<boolean>; first: boolean; last: boolean };
export type DocsWorkspaceState = {
  loading: boolean;
  error: string | null;
  outside: OpenProject;
  folders: OpenProject[];
  open: OpenProject | null;
  location: DocsLocation;
  document: DocsDocumentSession | null;
  recent: DocsRecentPage[];
  folderTitle?: DocsValueSession<string>;
  folderInfo?: DocsValueSession<ProjectInfo>;
  operation?: DocsWorkspaceOperation | null;
  folderCreation?: { projectId: string; value: string } | null;
};
/** Web vault の接続。未接続の機能に legacy Bridge の空実装を要求しない。 */
export type DocsWorkspaceHost = {
  kind: "vault-workspace";
  readonly scopeId: string;
  flows?: DocsFlowDesignSession;
  readonly actions?: DocsWorkspaceActions;
  subscribe(listener: () => void): () => void;
  getSnapshot(): DocsWorkspaceState;
  navigate(location: DocsLocation): Promise<void>;
  refresh(): Promise<void>;
};

export type DocsFlowDesignState = {
  loading: boolean;
  flows: import("@niho/docs-core").Flow[];
  drafts: Record<string, import("@niho/docs-core").Flow>;
  readOnly: Record<string, string>;
  currentId: string | null;
  phase: "ready" | "saving" | "unconfirmed" | "conflict" | "failed";
  error: string | null;
};
/** 工程だけの接続。Mac固有の設定・AI実行を含めない。 */
export type DocsFlowDesignSession = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): DocsFlowDesignState;
  load(discard?: boolean): Promise<void>;
  open(id: string): void;
  edit(flow: import("@niho/docs-core").Flow): void;
  save(flow: import("@niho/docs-core").Flow): Promise<void>;
  add(choice: import("../components/FlowPicker").FlowChoice): Promise<void>;
  duplicate(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  move(id: string, delta: -1 | 1): Promise<void>;
  confirm(): Promise<void>;
  samples: import("../components/FlowDesign").FlowSampleAccess;
};
