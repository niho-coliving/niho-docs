"use client";

import { candidatesFor, folderName, pageTitle, recordingChildren, stepSupportsCandidates, type PageEntry, type RecordingChild } from "@niho/docs-core";
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ProjectId } from "../lib/bridge";
import { encodeRailDrag, NIHO_DRAG_TYPE, railDropTarget, type RailDrag, type RailDrop, type RailDropZone } from "../lib/rail-dnd";
import { recordingProgress, type OpenProject } from "../lib/project-view";
import { runIsOn, type ActiveRun } from "../lib/run-state";
import { ChevronIcon, DocIcon, FlowIcon, FolderIcon, GearIcon, MicIcon, MoreIcon, PlusIcon } from "./icons";
import { usePopover } from "./usePopover";
import { ConfirmDialog } from "./ConfirmDialog";
import { useTitlebarHome, useTitlebarRailHost } from "./WindowTitlebar";

export type Screen = "work" | "flow" | "settings";
export type Selection = { pageId: string; stepId: string | null; candidateId?: string | null };

function Twisty(props: { open: boolean; label: string; onToggle: () => void }) {
  return <button type="button" className={`tw${props.open ? " open" : ""}`} aria-expanded={props.open} aria-label={`${props.label}を${props.open ? "閉じる" : "開く"}`} onClick={props.onToggle}><ChevronIcon /></button>;
}

/** フォルダの行の ＋（そのフォルダに ページ／音声。フォルダは入れ子にしないので出さない。Web/PWA と同じ。owner 2026-10-18・#18867）。 */
function AddPageMenu(props: { folderName: string; onAddDoc?: () => void; onAddRecording?: () => void; disabled?: boolean }) {
  const menu = usePopover();
  const pick = (action: () => void) => () => { menu.setOpen(false); action(); };
  const label = `${props.folderName}に追加`;
  return <div ref={menu.ref} className="addpage"><button type="button" className="ibtn sm" title={label} aria-label={label} aria-expanded={menu.open} disabled={props.disabled} onClick={menu.toggle}><PlusIcon /></button>
    {menu.open && <div className="pop" role="menu">{props.onAddDoc && <button type="button" className="mi" role="menuitem" disabled={props.disabled} onClick={pick(props.onAddDoc)}><DocIcon />ページ</button>}{props.onAddRecording && <button type="button" className="mi" role="menuitem" disabled={props.disabled} onClick={pick(props.onAddRecording)}><MicIcon />音声</button>}</div>}</div>;
}

/**
 * 新規作成の ＋（ページ ⌘N／音声 ⇧⌘N／フォルダ。言葉は Web/PWA の ＋ と同じ。owner 2026-10-18・#18867）。ページは開いている場所、音声は新しいフォルダに作る。
 * アイコンだけの緑の丸で、タイトルバーのアプリ名の行のレールの右端に置く（「＋ 新しい」の箱はやめた。owner 2026-10-18・#18929）。
 * 題はフォルダを開いているときだけ「〈フォルダ名〉に追加」（ホームは出さない。Web/PWA と同じ。owner 2026-10-18）。
 */
function NewMenu(props: { folderName: string | null; onDoc?: () => void; onRecording?: () => void; onFolder?: () => void; disabled?: boolean; browser?: boolean }) {
  const menu = usePopover();
  const pick = (action: () => void) => () => { menu.setOpen(false); action(); };
  return <div ref={menu.ref} className="new-menu"><button type="button" className="tb-new" title="新規作成" aria-label="新規作成" aria-expanded={menu.open} disabled={props.disabled} onClick={menu.toggle}><PlusIcon /></button>
    {menu.open && <div className="pop" role="menu">{props.folderName && <p className="mi-label">{props.folderName}に追加</p>}
      {props.onDoc && <button type="button" className="mi" role="menuitem" disabled={props.disabled} onClick={pick(props.onDoc)}><DocIcon /><span>ページ</span>{!props.browser && <kbd>⌘N</kbd>}</button>}
      {props.onRecording && <button type="button" className="mi" role="menuitem" disabled={props.disabled} onClick={pick(props.onRecording)}><MicIcon /><span>音声</span>{!props.browser && <kbd>⇧⌘N</kbd>}</button>}
      {props.onFolder && <button type="button" className="mi" role="menuitem" disabled={props.disabled} onClick={pick(props.onFolder)}><FolderIcon /><span>フォルダ</span></button>}
    </div>}</div>;
}

function FolderMenu(props: { name: string; first: boolean; last: boolean; deleteBlocked: string | null; onMove?: (delta: -1 | 1) => void; onDelete?: () => Promise<boolean>; onExport?: () => void; disabled?: boolean; externalDeleteNotice?: boolean }) {
  const menu = usePopover();
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** 書き出しのダイアログを閉じたときに ⋯ へ focus が戻るよう、先に ⋯ へ移してからメニューを閉じる。 */
  const exportFolder = () => { triggerRef.current?.focus(); menu.setOpen(false); props.onExport?.(); };
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirmDelete = async () => {
    setBusy(true);
    try {
      if ((await props.onDelete?.()) || props.externalDeleteNotice) {
        setConfirming(false);
        menu.setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  };
  return <div ref={menu.ref} className="folder-menu"><button ref={triggerRef} type="button" className="ibtn sm" aria-label="フォルダのその他" aria-expanded={menu.open} disabled={props.disabled} onClick={menu.toggle}><MoreIcon /></button>
    {menu.open && <div className="pop" role="menu">{props.onExport && <><button type="button" className="mi" role="menuitem" onClick={exportFolder}>Google ドキュメントへ書き出す</button><div className="menu-separator" /></>}{props.onMove && <><button type="button" className="mi" role="menuitem" disabled={props.disabled || props.first} onClick={() => { menu.setOpen(false); props.onMove?.(-1); }}>上へ移動</button><button type="button" className="mi" role="menuitem" disabled={props.disabled || props.last} onClick={() => { menu.setOpen(false); props.onMove?.(1); }}>下へ移動</button></>}{props.deleteBlocked && <p className="mi-label">{props.deleteBlocked}</p>}{props.onDelete && <button type="button" className="mi danger" role="menuitem" disabled={props.disabled || props.deleteBlocked !== null} onClick={() => { menu.setOpen(false); setConfirming(true); }}>削除</button>}</div>}
    {confirming && <ConfirmDialog title={`「${props.name}」を削除しますか？`} confirmLabel="フォルダごと削除する" danger busy={busy} onConfirm={() => void confirmDelete()} onCancel={() => setConfirming(false)}><p>このフォルダと、中のページ・録音・背景情報・登場人物・固有名詞などをまとめて一覧から削除します。実行中の AI への依頼は中止されます。30日以内は Macアプリの設定「削除したフォルダ」から復元できます。</p></ConfirmDialog>}</div>;
}

export function Rail(props: {
  outside: OpenProject; folders: OpenProject[]; open: OpenProject | null; selection: Selection | null; screen: Screen;
  activeRun: ActiveRun | null;
  titleOf: (location: ProjectId, page: PageEntry) => string;
  onHome: () => void; onNewFolder?: () => void; onOpenLocation: (projectId: ProjectId) => void;
  /** フォルダの「背景情報」（フォルダの行と同じ背景情報のページを開く。#18914）。 */
  onOpenInfo?: (projectId: string) => void; onAddDoc?: (projectId: ProjectId) => void;
  /** フォルダの行の ＋ の「音声」（そのフォルダの音声。あれば背景情報のページを開く）。 */
  onAddRecording?: (projectId: string) => void;
  /** 「＋ 新しい」の「音声」と ⇧⌘N（音声 1 セット入りの新しいフォルダ。#18914）。 */
  onNewAudio?: () => void;
  onSelectPage: (projectId: ProjectId, pageId: string, stepId: string | null, candidateId?: string | null) => void; onScreen?: (screen: Screen) => void;
  onAddCandidate?: (projectId: ProjectId, pageId: string, stepId: string) => void;
  newProjectId?: ProjectId; onDrop?: (drop: RailDrop) => void; onMoveFolder?: (projectId: string, delta: -1 | 1) => void;
  onDeleteFolder?: (projectId: string) => Promise<boolean>;
  /** フォルダの ⋯ の「Google ドキュメントへ書き出す」（NIHO にログインできないときは渡さず、項目を出さない）。 */
  onExportFolder?: (projectId: string) => void;
  updateNotice?: ReactNode;
  browser?: boolean;
  mutationsDisabled?: boolean;
  creationRow?: ReactNode;
  folderDeleteBlock?: (projectId: string) => string | null;
  externalDeleteNotice?: boolean;
  flowDesign?: boolean;
  /** 下端の NIHO クラウドの知らせ（気にかけることがあるときだけ）。 */
  cloudNotice?: ReactNode;
  /** この Mac の案件の後ろに並べる、クラウドにだけある案件。 */
  remoteRows?: ReactNode;
  /** 案件の行の下の添え書き（別の Mac が実行中なら「〈名前〉で実行中」）。 */
  leaseNote?: (projectId: string) => string | null;
}) {
  const [closedFolders, setClosedFolders] = useState<ReadonlySet<string>>(() => new Set());
  /** フォルダの外の録音（以前のデータ）の開閉。フォルダの録音は開閉せず、工程のページをフォルダの直下に並べる（#18914）。 */
  const [closedRecordings, setClosedRecordings] = useState<ReadonlySet<string>>(() => new Set());
  const [closedCandidateGroups, setClosedCandidateGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [drag, setDrag] = useState<RailDrag | null>(null);
  const [mark, setMark] = useState<{ key: string; drop: RailDrop } | null>(null);
  const onWork = props.screen === "work";
  const titlebarRail = useTitlebarRailHost();
  useTitlebarHome(props.onHome);
  const order = { projects: props.folders.map((folder) => folder.id as string), pages: (id: ProjectId) => (id === null ? props.outside : props.folders.find((folder) => folder.id === id))?.pages.map((page) => page.id) ?? [] };
  const clearDrag = () => { setDrag(null); setMark(null); };
  const dragStart = (event: DragEvent, value: RailDrag) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(NIHO_DRAG_TYPE, encodeRailDrag(value)); setDrag(value); };
  const zoneEvents = (key: string, zone: (event: DragEvent) => RailDropZone) => ({
    onDragOver: (event: DragEvent) => { if (!drag || !event.dataTransfer.types.includes(NIHO_DRAG_TYPE)) return; const drop = railDropTarget(drag, zone(event), order); if (!drop) { setMark(null); return; } event.preventDefault(); event.dataTransfer.dropEffect = "move"; setMark({ key, drop }); },
    onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMark((current) => current?.key === key ? null : current); },
    onDrop: (event: DragEvent) => { if (!drag || !event.dataTransfer.types.includes(NIHO_DRAG_TYPE)) return; const drop = railDropTarget(drag, zone(event), order); if (!drop) { clearDrag(); return; } event.preventDefault(); clearDrag(); props.onDrop?.(drop); },
  });
  const markClass = (key: string) => mark?.key === key ? ` drag-${mark.drop.mark}` : "";
  const half = (event: DragEvent): "before" | "after" => event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2 ? "before" : "after";

  /** 録音から作ったページ（できている工程と実行中の工程。工程の順）。 */
  const childrenOf = (space: OpenProject, page: PageEntry): RecordingChild[] | null => {
    const summary = space.recordings[page.recordingId ?? page.id]; if (!summary) return null;
    const running = runIsOn(props.activeRun, { projectId: space.id, recordingId: page.recordingId ?? page.id });
    const children: RecordingChild[] = recordingChildren(summary.recording, summary.hasTranscript, summary.artifacts);
    if (running && props.activeRun && !children.some((child) => child.stepId === props.activeRun?.stepId)) { const index = summary.recording.flowSnapshot.steps.findIndex((step) => step.id === props.activeRun?.stepId); children.push({ stepId: props.activeRun.stepId, number: props.activeRun.stepId === "source" ? 1 : index + 2, name: props.activeRun.stepName }); children.sort((a, b) => a.number - b.number); }
    return children;
  };

  /**
   * 録音から作ったページの行（別案が 2 つ以上なら工程の行の下に案の行）。`depth` は工程の行の深さ（フォルダの録音は文書の行と同じ d1。
   * フォルダの外の録音は録音の行の下の d1）。
   */
  const outputRows = (space: OpenProject, page: PageEntry, children: RecordingChild[]) => {
    const summary = space.recordings[page.recordingId ?? page.id]!;
    const rec = { projectId: space.id, recordingId: page.recordingId ?? page.id }; const running = runIsOn(props.activeRun, rec);
    const selected = onWork && props.open?.id === space.id && props.selection?.pageId === page.id;
    return children.map((child) => {
      const candidates = candidatesFor(summary.recording, child.stepId);
      const supportsCandidates = stepSupportsCandidates(summary.recording.flowSnapshot, child.stepId);
      const childSelected = candidates.length <= 1 && selected && props.selection?.stepId === child.stepId && !props.selection?.candidateId;
      const runningChild = running && props.activeRun?.stepId === child.stepId;
      const candidateGroupKey = `${space.id ?? "_outside"}/${page.id}/${child.stepId}`;
      const candidatesOpen = !closedCandidateGroups.has(candidateGroupKey);
      const toggleCandidates = () => setClosedCandidateGroups((all) => {
        const next = new Set(all);
        if (next.has(candidateGroupKey)) next.delete(candidateGroupKey); else next.add(candidateGroupKey);
        return next;
      });
      return <div key={child.stepId} className="candidate-group">
        <div className="trow d1 out">
          {candidates.length > 1 ? <Twisty open={candidatesOpen} label={`${child.name}の案`} onToggle={toggleCandidates} /> : <span className="tw none" />}
          <button type="button" className={`ti${childSelected ? " on" : ""}`} aria-current={childSelected ? "page" : undefined} aria-expanded={candidates.length > 1 ? candidatesOpen : undefined} onClick={candidates.length > 1 ? toggleCandidates : () => props.onSelectPage(space.id, page.id, child.stepId, null)}><span className="ic">{runningChild && !props.activeRun?.candidateId ? <span className="spin" /> : <DocIcon />}</span><span className="t">{child.name}</span></button>
          {supportsCandidates && props.onAddCandidate && <button type="button" className="ibtn sm candidate-add" aria-label={`${child.name}の別案を作成`} title="別案を作成" onClick={() => props.onAddCandidate?.(space.id, page.id, child.stepId)}><PlusIcon /></button>}
        </div>
        {candidates.length > 1 && candidatesOpen && candidates.map((candidate) => {
          const candidateSelected = selected && props.selection?.stepId === child.stepId && props.selection?.candidateId === candidate.id;
          return <div className="trow d2" key={candidate.id}><span className="tw none" /><button type="button" className={`ti candidate${candidateSelected ? " on" : ""}`} aria-current={candidateSelected ? "page" : undefined} onClick={() => props.onSelectPage(space.id, page.id, child.stepId, candidate.id)}><span className="n">{runningChild && props.activeRun?.candidateId === candidate.id ? <span className="spin" /> : <DocIcon />}</span><span className="t">{candidate.name}</span></button></div>;
        })}
      </div>;
    });
  };

  const pageRows = (space: OpenProject, depth: "root" | "folder") => space.pages.map((page) => {
    const raw = props.titleOf(space.id, page); const selected = onWork && props.open?.id === space.id && props.selection?.pageId === page.id;
    const rowDepth = depth === "folder" ? " d1" : ""; const key = `page:${space.id ?? "_outside"}:${page.id}`;
    const events = zoneEvents(key, (event) => ({ kind: "page", projectId: space.id, pageId: page.id, half: half(event) }));
    const row = (body: ReactNode, twisty: ReactNode = depth === "folder" ? <span className="tw none" /> : null) => <div className={`trow${rowDepth}${drag?.kind === "page" && drag.pageId === page.id && drag.projectId === space.id ? " dragging" : ""}${markClass(key)}`} draggable={Boolean(props.onDrop)} onDragStart={(event) => dragStart(event, { kind: "page", projectId: space.id, pageId: page.id })} onDragEnd={clearDrag} {...events}>{twisty}{body}</div>;
    if (page.kind === "doc") return <div key={page.id}>{row(<button type="button" className={`ti${selected ? " on" : ""}`} aria-current={selected ? "page" : undefined} onClick={() => props.onSelectPage(space.id, page.id, null)}><span className="ic"><DocIcon /></span><span className={`t${raw.trim() ? "" : " untitled"}`}>{pageTitle({ ...page, title: raw })}</span></button>)}</div>;
    const children = childrenOf(space, page); if (!children) return null;
    const summary = space.recordings[page.recordingId ?? page.id]!;
    if (depth === "folder") {
      // フォルダの録音は行を出さず、工程のページを文書の行と同じ深さに並べる（録音の位置に。#18914）。工程のページの並びの上半分・下半分へ落とすと、
      // 録音の前・後ろへ入る
      if (children.length === 0) return null;
      return <div key={page.id} className={`rec-outputs${markClass(key)}`} {...zoneEvents(key, (event) => ({ kind: "page", projectId: space.id, pageId: page.id, half: half(event) }))}>{outputRows(space, page, children)}</div>;
    }
    const rec = { projectId: space.id, recordingId: page.recordingId ?? page.id }; const running = runIsOn(props.activeRun, rec);
    const rowKey = `${space.id ?? "_outside"}/${page.id}`; const expanded = children.length > 0 && !closedRecordings.has(rowKey); const progress = recordingProgress(summary.recording, summary.hasTranscript, summary.artifacts); const title = pageTitle({ ...page, title: raw }, summary.recording);
    const toggleRecording = () => setClosedRecordings((all) => { const next = new Set(all); if (next.has(rowKey)) next.delete(rowKey); else next.add(rowKey); return next; });
    return <div key={page.id}>{row(<button type="button" className={`ti${selected && props.selection?.stepId === null ? " on" : ""}`} aria-current={selected && props.selection?.stepId === null ? "page" : undefined} onClick={() => props.onSelectPage(space.id, page.id, null)}><span className="ic"><MicIcon /></span><span className={`t${raw.trim() ? "" : " untitled"}`}>{title}</span><span className="st">{running ? <span className="spin" /> : `${progress.done}/${progress.total}`}</span></button>, children.length > 0 ? <Twisty open={expanded} label={title} onToggle={toggleRecording} /> : <span className="tw none" />)}
      {expanded && outputRows(space, page, children)}</div>;
  });

  const newFolder = props.newProjectId === null ? null : props.folders.find((folder) => folder.id === props.newProjectId) ?? null;
  // ホームへはタイトルバーのアプリ名から、新規作成の ＋ はタイトルバーのレールの右端（レールに「ホーム」の行は置かない。#18929）。
  // 窓の枠の外（タイトルバーが無いとき）は ＋ をレールの先頭に描く
  const newMenu = props.onNewFolder || props.onNewAudio || props.onAddDoc ? <NewMenu folderName={newFolder ? folderName(newFolder.project) : null} onDoc={props.onAddDoc ? () => props.onAddDoc!(props.newProjectId ?? null) : undefined} onRecording={props.onNewAudio} onFolder={props.onNewFolder} disabled={props.mutationsDisabled} browser={props.browser} /> : null;
  return <nav className="rail" aria-label="ページとフォルダ">{titlebarRail ? createPortal(newMenu, titlebarRail) : newMenu}<div className="rscroll">
    {props.creationRow}
    {props.folders.map((folder, folderIndex) => {
      const id = folder.id as string;
      const expanded = !closedFolders.has(id);
      const currentHome = onWork && props.open?.id === id && props.selection === null;
      const running = props.activeRun?.projectId === id;
      const key = `folder:${id}`;
      const folderEvents = zoneEvents(key, (event) => ({ kind: "folder", projectId: id, half: half(event) }));
      const deleteBlocked = props.folderDeleteBlock ? props.folderDeleteBlock(id) : folder.pages.some((page) => page.kind === "doc")
        ? "ページを移動してから削除できます。"
        : folder.pages.some((page) => page.kind === "rec")
          ? "音声を削除してから削除できます。"
          : folder.project.info.background.trim() || folder.project.info.terms.length > 0
            ? "背景情報と固有名詞を消してから削除できます。"
            : running
              ? "処理が終わってから削除できます。"
              : null;
      return <div className={`case${drag?.kind === "folder" && drag.projectId === id ? " dragging" : ""}${markClass(key)}`} key={id}><div className="trow" draggable={Boolean(props.onDrop)} onDragStart={(event) => dragStart(event, { kind: "folder", projectId: id })} onDragEnd={clearDrag} {...folderEvents}><Twisty open={expanded} label={folderName(folder.project)} onToggle={() => setClosedFolders((all) => { const next = new Set(all); if (next.has(id)) next.delete(id); else next.add(id); return next; })} /><button type="button" className={`ti case${currentHome ? " on" : ""}`} aria-current={currentHome ? "page" : undefined} onClick={() => props.onOpenLocation(id)}><span className={`t${folder.project.name.trim() ? "" : " untitled"}`}>{folderName(folder.project)}</span>{running && <span className="st"><span className="spin" /></span>}</button>{(props.onAddDoc || props.onAddRecording) && <AddPageMenu folderName={folderName(folder.project)} onAddDoc={props.onAddDoc ? () => props.onAddDoc!(id) : undefined} onAddRecording={props.onAddRecording ? () => props.onAddRecording!(id) : undefined} disabled={props.mutationsDisabled} />}{(props.onMoveFolder || props.onDeleteFolder || props.onExportFolder) && <FolderMenu name={folderName(folder.project)} first={folderIndex === 0} last={folderIndex === props.folders.length - 1} deleteBlocked={deleteBlocked} onMove={props.onMoveFolder ? (delta) => props.onMoveFolder!(id, delta) : undefined} onDelete={props.onDeleteFolder ? () => props.onDeleteFolder!(id) : undefined} onExport={props.onExportFolder ? () => props.onExportFolder!(id) : undefined} disabled={props.mutationsDisabled} externalDeleteNotice={props.externalDeleteNotice} />}</div>

        {(() => { const lease = props.leaseNote?.(id) ?? null; return lease && <p className="rlease">{lease}</p>; })()}
        {expanded && <>{props.onOpenInfo && <div className={`trow d1${markClass(`folder-end:${id}`)}`} {...zoneEvents(`folder-end:${id}`, () => ({ kind: "folder-end", projectId: id }))}><span className="tw none" /><button type="button" className="ti background-info" onClick={() => props.onOpenInfo?.(id)}><span className="t">背景情報</span></button></div>}{pageRows(folder, "folder")}</>}
      </div>; })}
    {props.remoteRows}
    {/* フォルダの後ろに区切り線を挟んでフォルダの外のページ（見出しは出さない。Web/PWA のツリーと同じ。owner 2026-10-18・#18867）。
        区切り線はフォルダの外の先頭への落とし先を兼ねる（以前の見出し「ページ」の役目） */}
    {props.outside.pages.length > 0 && <div className={`rail-divider${props.folders.length > 0 || props.remoteRows ? " line" : ""}${markClass("outside-start")}`} role="separator" {...zoneEvents("outside-start", () => ({ kind: "outside-start" }))} />}
    {pageRows(props.outside, "root")}
    <div className={`rail-tail${markClass("outside-tail")}`} {...zoneEvents("outside-tail", () => ({ kind: "outside-end" }))} />
  </div><div className="rfoot">{props.cloudNotice}{props.updateNotice}{props.onScreen && props.flowDesign !== false && <button type="button" className={`it${props.screen === "flow" ? " on" : ""}`} onClick={() => props.onScreen?.("flow")}><FlowIcon />工程設計</button>}{props.onScreen && <button type="button" className={`it${props.screen === "settings" ? " on" : ""}`} onClick={() => props.onScreen?.("settings")}><GearIcon />設定</button>}</div></nav>;
}
