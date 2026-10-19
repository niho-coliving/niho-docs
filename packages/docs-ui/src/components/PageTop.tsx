"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DOCS_PAGE_SHARING_TEXT } from "@niho/docs-core";
import { ChatIcon, MoreIcon } from "./icons";
import { usePopover } from "./usePopover";
import { useTitlebarActionsHost } from "./WindowTitlebar";
import { PageSharingPanel } from "../sharing/page-sharing-panel";
import { useDesktopPageSharing, type DesktopShareConnection } from "../sharing/use-desktop-page-sharing";
import type { ProjectId } from "../lib/bridge";

/**
 * 開いているページの操作（「AIと作る」の開閉・⋯）。タイトルバーの右端（`DesktopShell`）へ描く。パンくずは出さない
 * （場所はレールの選択行が示す。#18881）。枠の外で描かれたとき（置き場が無いとき）は何も出さない。
 * 書き出し・検索・書式は ⋯ の中に入れ、右端は［AIと作る］［⋯］だけにする（owner 2026-10-18・#18941。Web と同じ骨格・#18873）。
 */
export function PageTop(props: { children?: ReactNode }) {
  const host = useTitlebarActionsHost();
  return host ? createPortal(props.children, host) : null;
}

/** 閉じている「AIと作る」の様子（作業中・閉じている間に届いてまだ見ていない返事）。開いているときは null。 */
export type ChatToggleState = "busy" | "unread" | null;

/**
 * 「AIと作る」の開閉（文書・録音・成果物のページ）。既定は閉じているので、閉じている間に作業中か新しい返事があれば右上に小さな点を
 * 付け、読み上げにも添える（owner 2026-10-18・#18941）。
 */
export function ChatToggle(props: { open: boolean; onToggle: () => void; state?: ChatToggleState }) {
  const state = props.open ? null : (props.state ?? null);
  const label = state === "busy" ? "AIと作る（作業中）" : state === "unread" ? "AIと作る（新しい返事）" : "AIと作る";
  return (
    <button type="button" className="ibtn chat-toggle" title="AIと作る" aria-label={label} aria-pressed={props.open} onClick={props.onToggle}>
      <ChatIcon />
      {state && <i className="chat-dot" aria-hidden="true" />}
    </button>
  );
}

/** ⋯ の「書き出し ›」（文書のページ・成果物の子ページで同じ）: コピー／.md で保存／Google ドキュメント／Finder で表示。 */
export type ExportActions = {
  /** 押せない（その工程の実行中・本文が空）。 */
  disabled: boolean;
  onCopy: () => void;
  onExportFile: () => void;
  /** 無ければ「Google ドキュメント」を出さない（サーバーが NIHO アカウントの接続を閉じている間）。 */
  onExportGoogle?: () => void;
  onReveal?: () => void;
  sharing?: DesktopShareConnection;
  sharingRequest?: number;
};

/** ⋯ の「検索」「書式を表示」（エディタのあるページだけ。EditorTools の入口）。 */
export type EditorMenuActions = {
  disabled: boolean;
  toolbarOpen: boolean;
  onSearch: () => void;
  onToggleToolbar: () => void;
};

type Submenu = { kind: "move" | "export"; top: number };

/**
 * ページの「⋯」。並びは 検索 ⌘F／書式を表示／書き出し ›／（区切り）／下に文書を追加・作り直す・フォルダへ移す ›・上へ／下へ移動・削除
 * （owner 2026-10-18・#18941。エディタの無いページには検索・書式を出さない）。録音から作ったページには「作り直す」を出し、削除・移動は出さない（#18915）。
 * `deleteBlocked` があれば削除を押せず、その理由をメニューに 1 行出す（録音のページは同じ案件の実行中に消せない）。
 */
export function PageMenu(props: {
  disabled?: boolean;
  onDelete?: () => void;
  /** 削除の項目の名前（既定は「削除」。背景情報のページはフォルダの「音声を削除」。#18914）。 */
  deleteLabel?: string;
  /** 録音から作ったページの「作り直す」。押せない理由はページの実行の帯が出す。 */
  onRebuild?: () => void;
  rebuildDisabled?: boolean;
  deleteBlocked?: string | null;
  moveBlocked?: string | null;
  folders?: Array<{ id: string; name: string }>;
  currentProjectId?: ProjectId;
  onMove?: (projectId: ProjectId) => void;
  onReorder?: (delta: -1 | 1) => void;
  onAddDocument?: () => void;
  first?: boolean;
  last?: boolean;
  editor?: EditorMenuActions | null;
  exportActions?: ExportActions | null;
}) {
  const menu = usePopover();
  const [submenu, setSubmenu] = useState<Submenu | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const moveTriggerRef = useRef<HTMLButtonElement>(null);
  const exportTriggerRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const blocked = props.deleteBlocked ?? null;
  const editor = props.editor ?? null;
  const exportActions = props.exportActions ?? null;
  const sharing = useDesktopPageSharing(exportActions?.sharing);
  const refreshSharingRef = useRef(sharing.onRefresh);
  refreshSharingRef.current = sharing.onRefresh;
  useEffect(() => {
    if (!exportActions?.sharingRequest || !exportActions.sharing) return;
    setSubmenu(null);
    menu.setOpen(false);
    setShareOpen(true);
    refreshSharingRef.current();
  }, [exportActions?.sharingRequest]);
  const close = () => { setSubmenu(null); menu.setOpen(false); };
  // サブメニューはそれを開いた行の高さにそろえる（並びの下の方の行から開いても、上端に飛ばない）
  const openSubmenu = (kind: Submenu["kind"], trigger: HTMLButtonElement) => setSubmenu({ kind, top: trigger.offsetTop });
  const toggleSubmenu = (kind: Submenu["kind"]) => (event: { currentTarget: HTMLButtonElement }) => {
    if (submenu?.kind === kind) setSubmenu(null);
    else openSubmenu(kind, event.currentTarget);
  };
  const submenuKey = (kind: Submenu["kind"]) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") { event.preventDefault(); openSubmenu(kind, event.currentTarget); }
  };
  const submenuBack = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft") return;
    event.preventDefault();
    const kind = submenu?.kind;
    setSubmenu(null);
    (kind === "export" ? exportTriggerRef : moveTriggerRef).current?.focus();
  };
  /** 項目を選ぶとメニューを閉じ、フォーカスを ⋯ へ戻してから実行する（Google ドキュメントのダイアログを閉じたときの戻り先）。 */
  const pick = (action: () => void) => () => {
    close();
    triggerRef.current?.focus();
    action();
  };
  useEffect(() => { if (!menu.open) setSubmenu(null); }, [menu.open]);
  useEffect(() => {
    if (submenu) submenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [submenu]);
  const menuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
    items[next]?.focus();
  };
  const pageItems = Boolean(props.onAddDocument || props.onMove || props.onRebuild || props.onReorder || props.onDelete);
  const moveDisabled = props.moveBlocked !== null && props.moveBlocked !== undefined;
  const moveFolders = (props.folders ?? []).filter((folder) => folder.id !== props.currentProjectId);
  const canMove = moveFolders.length > 0 || (props.currentProjectId !== null && props.currentProjectId !== undefined);
  return (
    <div ref={menu.ref} className="pagemenu">
      <button ref={triggerRef} type="button" className="ibtn" title="その他" aria-label="その他" aria-expanded={menu.open || shareOpen} disabled={props.disabled} onClick={() => { if (shareOpen) setShareOpen(false); else menu.toggle(); }}>
        <MoreIcon />
      </button>
      {menu.open && (
        <div className="pop" role="menu" onKeyDown={menuKey}>
          {editor && (
            <>
              <button type="button" className="mi" role="menuitem" disabled={editor.disabled} onClick={() => { close(); editor.onSearch(); }}>
                検索 <span className="sub" aria-hidden="true">⌘F</span>
              </button>
              <button type="button" className="mi" role="menuitem" disabled={editor.disabled} onClick={() => {
                close();
                editor.onToggleToolbar();
                triggerRef.current?.focus();
              }}>
                {editor.toolbarOpen ? "書式を閉じる" : "書式を表示"}
              </button>
            </>
          )}
          {exportActions && (
            <>
              <button ref={exportTriggerRef} type="button" className="mi submenu-trigger" role="menuitem" aria-haspopup="menu" aria-expanded={submenu?.kind === "export"}
                disabled={exportActions.disabled} onClick={toggleSubmenu("export")} onKeyDown={submenuKey("export")}>書き出し <span>›</span></button>
              {submenu?.kind === "export" && (
                <div ref={submenuRef} className="submenu" role="menu" aria-label="書き出し" style={{ top: submenu.top }} onKeyDown={submenuBack}>
                  <button type="button" className="mi" role="menuitem" onClick={pick(exportActions.onCopy)}>コピー</button>
                  <button type="button" className="mi" role="menuitem" onClick={pick(exportActions.onExportFile)}>.md で保存</button>
                  {exportActions.onExportGoogle && (
                    <button type="button" className="mi" role="menuitem" onClick={pick(exportActions.onExportGoogle)}>Google ドキュメント</button>
                  )}
                  {exportActions.onReveal && <button type="button" className="mi" role="menuitem" onClick={pick(exportActions.onReveal)}>Finder で表示</button>}
                  {exportActions.sharing && <button type="button" className="mi" role="menuitem" onClick={() => { close(); setShareOpen(true); sharing.onRefresh(); }}>
                    {DOCS_PAGE_SHARING_TEXT.menu}{sharing.state?.status === "PUBLIC" ? "　共有中" : ""}
                  </button>}
                </div>
              )}
            </>
          )}
          {(editor || exportActions) && pageItems && <div className="menu-separator" />}
          {props.onAddDocument && <button type="button" className="mi" role="menuitem" disabled={blocked !== null}
            onClick={() => { close(); props.onAddDocument?.(); }}>下に文書を追加</button>}
          {props.onRebuild && <button type="button" className="mi" role="menuitem" disabled={props.rebuildDisabled ?? false}
            onClick={() => { close(); props.onRebuild?.(); }}>作り直す</button>}
          {props.onMove && canMove && (
            <>
              <button ref={moveTriggerRef} type="button" className="mi submenu-trigger" role="menuitem" aria-haspopup="menu" aria-expanded={submenu?.kind === "move"} onClick={toggleSubmenu("move")} onKeyDown={submenuKey("move")}>フォルダへ移す <span>›</span></button>
              {submenu?.kind === "move" && <div ref={submenuRef} className="submenu" role="menu" aria-label="移動先" style={{ top: submenu.top }} onKeyDown={submenuBack}>
              {moveFolders.map((folder) => (
                <button type="button" className="mi" role="menuitem" key={folder.id} disabled={moveDisabled} onClick={() => { close(); props.onMove?.(folder.id); }}>
                  {folder.name}
                </button>
              ))}
              {props.currentProjectId !== null && props.currentProjectId !== undefined && (
                <button type="button" className="mi" role="menuitem" disabled={moveDisabled} onClick={() => { close(); props.onMove?.(null); }}>
                  ホーム
                </button>
              )}
              </div>}
              <div className="menu-separator" />
            </>
          )}
          {props.onReorder && <><button type="button" className="mi" role="menuitem" disabled={props.first || props.moveBlocked != null} onClick={() => { close(); props.onReorder?.(-1); }}>上へ移動</button><button type="button" className="mi" role="menuitem" disabled={props.last || props.moveBlocked != null} onClick={() => { close(); props.onReorder?.(1); }}>下へ移動</button><div className="menu-separator" /></>}
          {props.moveBlocked && <p className="help menu-note">{props.moveBlocked}</p>}
          {props.onDelete && (
            <button
              type="button"
              className="mi danger"
              role="menuitem"
              disabled={blocked !== null}
              onClick={() => {
                menu.setOpen(false);
                props.onDelete?.();
              }}
            >
              {props.deleteLabel ?? "削除"}
            </button>
          )}
          {props.onDelete && blocked && <p className="help menu-note">{blocked}</p>}
        </div>
      )}
      {shareOpen && exportActions?.sharing && <div className="docs-share-anchor"><PageSharingPanel {...sharing} onClose={() => { setShareOpen(false); triggerRef.current?.focus(); }} /></div>}
    </div>
  );
}
