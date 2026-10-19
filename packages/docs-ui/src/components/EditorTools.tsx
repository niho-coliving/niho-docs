"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEditorState, type Editor } from "@tiptap/react";
import { TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { findNext, findPrev, setSearchState } from "prosemirror-search";
import {
  Bold, Code, Heading1, Heading2, Heading3, ImagePlus, Italic, Link2, List,
  ListOrdered, Minus, Quote, Search, Strikethrough, X,
} from "lucide-react";
import { errorMessage, type Bridge, type ProjectId } from "../lib/bridge";
import { literalQuery, replaceMatch, SEARCH_COUNT_LIMIT, searchMatches } from "../lib/block-editor/search";
import { ConfirmDialog } from "./ConfirmDialog";

const REPLACE_META = "docReplace";

function ToolButton(props: { label: string; onClick: () => void; pressed?: boolean; disabled?: boolean; children: ReactNode }) {
  return <button type="button" className="et-icon" aria-label={props.label} title={props.label} aria-pressed={props.pressed} disabled={props.disabled}
    onMouseDown={(event) => event.preventDefault()} onClick={props.onClick}>{props.children}</button>;
}

/**
 * リンクの URL を聞くダイアログ（ブラウザの `window.prompt` は Tauri の窓で出ないので使わない。design-guide §6）。今のリンクがあれば
 * 入れて開き、空にして確定するとリンクを外す。
 */
function LinkDialog(props: { container?: Element; current: string | null; onConfirm: (href: string) => void; onCancel: () => void }) {
  const [href, setHref] = useState(props.current ?? "");
  const inputId = useId();
  const value = href.trim();
  const confirm = () => {
    if (value || props.current) props.onConfirm(value);
  };
  return createPortal(
    <ConfirmDialog
      title={props.current ? "リンクを編集" : "リンクを追加"}
      confirmLabel={!value && props.current ? "リンクを外す" : props.current ? "更新する" : "追加する"}
      confirmDisabled={!value && !props.current}
      focusField
      onConfirm={confirm}
      onCancel={props.onCancel}
    >
      <div className="fields">
        <div className="fld">
          <label htmlFor={inputId}>リンク先の URL</label>
          <input
            id={inputId}
            className="inp"
            type="url"
            value={href}
            placeholder="https://"
            onChange={(event) => setHref(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              confirm();
            }}
          />
        </div>
      </div>
    </ConfirmDialog>,
    props.container ?? document.body,
  );
}

function Toolbar(props: { editor: Editor; onImage: () => void; imageBusy: boolean }) {
  const { editor } = props;
  const active = useEditorState({ editor, selector: ({ editor: current }) => ({
    bold: current.isActive("bold"), italic: current.isActive("italic"), strike: current.isActive("strike"),
    code: current.isActive("code"), h1: current.isActive("heading", { level: 1 }),
    h2: current.isActive("heading", { level: 2 }), h3: current.isActive("heading", { level: 3 }),
    bullet: current.isActive("bulletList"), ordered: current.isActive("orderedList"),
    quote: current.isActive("blockquote"), link: current.isActive("link"),
  }) });
  const disabled = !editor.isEditable;
  /** 開いているリンクのダイアログ（今のリンク。無ければ null）。閉じているときは undefined。 */
  const [linkDialog, setLinkDialog] = useState<{ current: string | null } | undefined>(undefined);
  const link = () => setLinkDialog({ current: (editor.getAttributes("link").href as string | undefined) ?? null });
  const applyLink = (href: string) => {
    setLinkDialog(undefined);
    // ダイアログが閉じて元のフォーカスへ戻った後に、本文へ戻して当てる（選んでいた範囲はエディタが持っている）
    window.setTimeout(() => {
      if (editor.isDestroyed || !editor.isEditable) return;
      if (!href) editor.chain().focus().extendMarkRange("link").unsetLink().run();
      else editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }, 0);
  };
  return <div className="et-toolbar" role="toolbar" aria-label="文書の書式">
    {linkDialog && <LinkDialog container={editor.view.dom.closest("[data-docs-app-root]") ?? undefined} current={linkDialog.current} onConfirm={applyLink} onCancel={() => setLinkDialog(undefined)} />}
    <ToolButton label="太字" pressed={active.bold} disabled={disabled} onClick={() => editor.chain().focus().toggleBold().run()}><Bold /></ToolButton>
    <ToolButton label="斜体" pressed={active.italic} disabled={disabled} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic /></ToolButton>
    <ToolButton label="取り消し線" pressed={active.strike} disabled={disabled} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough /></ToolButton>
    <ToolButton label="インラインコード" pressed={active.code} disabled={disabled} onClick={() => editor.chain().focus().toggleCode().run()}><Code /></ToolButton>
    <span className="et-sep" aria-hidden="true" />
    <ToolButton label="見出し1" pressed={active.h1} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 /></ToolButton>
    <ToolButton label="見出し2" pressed={active.h2} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 /></ToolButton>
    <ToolButton label="見出し3" pressed={active.h3} disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 /></ToolButton>
    <ToolButton label="箇条書き" pressed={active.bullet} disabled={disabled} onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></ToolButton>
    <ToolButton label="番号付きリスト" pressed={active.ordered} disabled={disabled} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></ToolButton>
    <ToolButton label="引用" pressed={active.quote} disabled={disabled} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote /></ToolButton>
    <ToolButton label="リンク" pressed={active.link} disabled={disabled} onClick={link}><Link2 /></ToolButton>
    <ToolButton label="区切り線" disabled={disabled} onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus /></ToolButton>
    <span className="et-sep" aria-hidden="true" />
    <ToolButton label="画像を追加" disabled={disabled || props.imageBusy} onClick={props.onImage}><ImagePlus /></ToolButton>
  </div>;
}

/**
 * 検索・書式の入口（タイトルバーの ⋯ と ⌘F。App が持つ）。メタ行の右端の 🔍・Aa はやめて ⋯ へ寄せた（owner 2026-10-18・#18941）ので、
 * 開閉の状態は EditorTools が持ったまま、入口だけを外へ渡す。`available` はエディタができているか（できる前は押せない）。
 */
export type EditorToolControls = {
  available: boolean;
  toolbarOpen: boolean;
  openSearch: () => void;
  toggleToolbar: () => void;
};

export function EditorTools(props: {
  editor: Editor | null;
  bridge: Bridge;
  projectId: ProjectId;
  panelHost: HTMLElement | null;
  onError: (message: string) => void;
  /** 検索・書式の入口を渡す先（外れるときは null）。 */
  onControls?: (controls: EditorToolControls | null) => void;
}) {
  const { editor, onControls } = props;
  const [toolbarOpen, setToolbarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [replaceValue, setReplaceValue] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [replaced, setReplaced] = useState<{ count: number; doc: Editor["state"]["doc"] } | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);

  const recount = useCallback(() => {
    if (!editor || !searchValue) { setMatchCount(0); setCurrentIndex(0); return; }
    const matches = searchMatches(editor.state, literalQuery(searchValue), SEARCH_COUNT_LIMIT);
    setMatchCount(matches.length);
    setCurrentIndex(matches.findIndex((match) => match.from === editor.state.selection.from && match.to === editor.state.selection.to) + 1);
  }, [editor, searchValue]);
  const recountRef = useRef(recount);
  useEffect(() => { recountRef.current = recount; }, [recount]);

  useEffect(() => {
    if (!editor) return;
    const update = ({ transaction }: { transaction: { docChanged: boolean; getMeta: (key: string) => unknown } }) => {
      recountRef.current();
      if (transaction.docChanged && !transaction.getMeta(REPLACE_META)) setReplaced(null);
    };
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
      if (!editor.isDestroyed) editor.view.dispatch(setSearchState(editor.state.tr, literalQuery("")));
    };
  }, [editor]);

  const applySearch = (value: string) => {
    setSearchValue(value);
    setReplaced(null);
    if (!value) setReplaceOpen(false);
    if (!editor) return;
    const query = literalQuery(value);
    const transaction = setSearchState(editor.state.tr, query);
    const first = value && query.valid ? (query.findNext(editor.state, editor.state.selection.from) ?? query.findNext(editor.state, 0)) : null;
    if (first) transaction.setSelection(TextSelection.create(transaction.doc, first.from, first.to)).scrollIntoView();
    editor.view.dispatch(transaction);
    const matches = searchMatches(editor.state, query, SEARCH_COUNT_LIMIT);
    setMatchCount(matches.length);
    setCurrentIndex(first ? matches.findIndex((match) => match.from === first.from) + 1 : 0);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchValue("");
    setReplaceOpen(false);
    setReplaced(null);
    if (editor) editor.view.dispatch(setSearchState(editor.state.tr, literalQuery("")));
  };

  const navigate = (direction: "next" | "prev") => {
    if (!editor) return;
    (direction === "next" ? findNext : findPrev)(editor.state, editor.view.dispatch);
    recount();
  };

  const replaceOne = () => {
    if (!editor || !editor.isEditable || !searchValue) return;
    const { from, to } = editor.state.selection;
    const match = literalQuery(searchValue).findNext(editor.state, from);
    if (!match || match.from !== from || match.to !== to) { navigate("next"); return; }
    const transaction = replaceMatch(editor.state.tr, match, replaceValue).setMeta(REPLACE_META, true);
    editor.view.dispatch(transaction);
    setReplaced(null);
    findNext(editor.state, editor.view.dispatch);
    recount();
  };

  const replaceAll = () => {
    if (!editor || !editor.isEditable || !searchValue) return;
    const matches = searchMatches(editor.state, literalQuery(searchValue));
    if (!matches.length) return;
    let transaction = editor.state.tr;
    for (let index = matches.length - 1; index >= 0; index--) transaction = replaceMatch(transaction, matches[index]!, replaceValue);
    editor.view.dispatch(closeHistory(transaction.setMeta(REPLACE_META, true)));
    editor.view.dispatch(closeHistory(editor.state.tr));
    setReplaced({ count: matches.length, doc: editor.state.doc });
    recount();
  };

  const addImage = async () => {
    if (!editor || !editor.isEditable || imageBusy) return;
    setImageBusy(true);
    try {
      const name = await props.bridge.pickImageAsset(props.projectId);
      if (name && !editor.isDestroyed && editor.isEditable) editor.chain().focus().insertContent({ type: "docAssetImage", attrs: { name, alt: "写真" } }).run();
    } catch (error) {
      props.onError(errorMessage(error, "画像を追加できませんでした。"));
    } finally { setImageBusy(false); }
  };

  // 開いていれば検索語を選び直す（もう一度 ⌘F を押したとき、続けて打つと置き換わる）
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    window.setTimeout(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    }, 0);
  }, []);
  const toggleToolbar = useCallback(() => setToolbarOpen((value) => !value), []);
  const available = editor !== null;
  useEffect(() => {
    onControls?.({ available, toolbarOpen, openSearch, toggleToolbar });
  }, [onControls, available, toolbarOpen, openSearch, toggleToolbar]);
  useEffect(() => () => onControls?.(null), [onControls]);

  const panels = <>
    {toolbarOpen && editor && <Toolbar editor={editor} onImage={() => void addImage()} imageBusy={imageBusy} />}
    {searchOpen && <div className="et-search" role="search" aria-label="文書内を検索">
      <div className="et-search-row">
        <Search aria-hidden="true" />
        <input ref={searchInput} value={searchValue} onChange={(event) => applySearch(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); navigate(event.shiftKey ? "prev" : "next"); } else if (event.key === "Escape") closeSearch(); }}
          aria-label="検索語" placeholder="この文書を検索" />
        <span className="et-count" role="status">{searchValue ? `${currentIndex || 0}/${matchCount}${matchCount >= SEARCH_COUNT_LIMIT ? "以上" : ""}件` : "0件"}</span>
        <button type="button" aria-label="前の一致" title="前の一致" disabled={!matchCount} onClick={() => navigate("prev")}>↑</button>
        <button type="button" aria-label="次の一致" title="次の一致" disabled={!matchCount} onClick={() => navigate("next")}>↓</button>
        <button type="button" aria-label="検索を閉じる" title="検索を閉じる" onClick={closeSearch}><X /></button>
      </div>
      {searchValue && <div className="et-search-row et-search-actions">
        <button type="button" aria-expanded={replaceOpen} onClick={() => setReplaceOpen((value) => !value)}>置換…</button>
        {replaceOpen && <>
          <input value={replaceValue} onChange={(event) => setReplaceValue(event.target.value)} aria-label="置換後の文字" placeholder="置換後の文字" />
          {replaced && editor?.state.doc.eq(replaced.doc) ? <span role="status">{replaced.count}件を置換しました <button type="button" onClick={() => { editor?.commands.undo(); setReplaced(null); recount(); }}>元に戻す</button></span> : <>
            <button type="button" disabled={!matchCount || !editor?.isEditable} onClick={replaceOne}>置換</button>
            <button type="button" disabled={!matchCount || !editor?.isEditable} onClick={replaceAll}>すべて置換</button>
          </>}
        </>}
      </div>}
    </div>}
  </>;

  return props.panelHost ? createPortal(panels, props.panelHost) : null;
}
