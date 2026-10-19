import type { ReactNode } from "react";
import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { exitSuggestion, type SuggestionOptions, type SuggestionProps } from "@tiptap/suggestion";
import { chooseBlockType, filterBlockTypes, matchesSlashQuery, type BlockType } from "./blocks";

/**
 * 「/」と「／」のメニュー（@tiptap/suggestion を 2 つ。plugin key を分ける）。
 * 表示は React（BlockEditor の SlashMenu）が、エディタごとの store を購読して描く。
 * 行の種類（BlockType）の後ろに、ページの操作（PageAction。文書のページの「録音のページ」など）を足せる。ページの操作は
 * 行の種類の一覧（書式のバー・⋮⋮）には出さない。
 */

/** 「/」のメニューのページの操作（行の種類とは別。選ぶと「/…」を消して `run`）。 */
export type PageAction = {
  id: string;
  /** 画面の名前 */
  name: string;
  /** 枠の中の記号（`icon` があればそちらを出す） */
  key: string;
  icon?: ReactNode;
  /** 右に小さく出す書き始め（無ければ空） */
  hint: string;
  /** 絞り込みの別名（英語・ローマ字・かな） */
  aliases: readonly string[];
  run: () => void;
};

export type SlashItem = BlockType | PageAction;

export function isPageAction(item: SlashItem): item is PageAction {
  return "run" in item;
}

/** ページの操作を「/」の後ろの問い合わせで絞る（行の種類と同じ規則）。 */
export function filterPageActions(query: string, actions: readonly PageAction[]): PageAction[] {
  return actions.filter((action) => matchesSlashQuery(action, query));
}

export type SlashMenuSnapshot = {
  items: readonly SlashItem[];
  index: number;
  rect: DOMRect | null;
};

type Props = SuggestionProps<SlashItem, SlashItem>;

export class SlashMenuStore {
  private snapshot: SlashMenuSnapshot | null = null;
  private owner: PluginKey | null = null;
  private props: Props | null = null;
  private readonly listeners = new Set<() => void>();
  /** このエディタのページの操作（BlockEditor が置く。文書のページだけ）。 */
  pageActions: readonly PageAction[] = [];

  constructor(private readonly editor: Editor) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SlashMenuSnapshot | null => this.snapshot;

  private set(snapshot: SlashMenuSnapshot | null): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  show(owner: PluginKey, props: Props): void {
    const sameQuery = this.owner === owner && this.props?.query === props.query;
    this.owner = owner;
    this.props = props;
    const index = sameQuery && this.snapshot ? Math.min(this.snapshot.index, Math.max(0, props.items.length - 1)) : 0;
    this.set({ items: props.items, index, rect: props.clientRect?.() ?? null });
  }

  /** 開いた側の plugin が閉じたときだけ閉じる（「/」と「／」が同じ取引で入れ替わっても消えない）。 */
  hide(owner: PluginKey): void {
    if (this.owner !== owner) return;
    this.owner = null;
    this.props = null;
    this.set(null);
  }

  /** スクロールなどで位置を取り直す。 */
  reposition(): void {
    if (!this.snapshot || !this.props) return;
    this.set({ ...this.snapshot, rect: this.props.clientRect?.() ?? null });
  }

  select(index: number): void {
    if (!this.snapshot || index === this.snapshot.index) return;
    this.set({ ...this.snapshot, index });
  }

  move(delta: number): void {
    if (!this.snapshot) return;
    const count = this.snapshot.items.length;
    if (count === 0) return;
    this.set({ ...this.snapshot, index: (this.snapshot.index + delta + count) % count });
  }

  choose(index?: number): void {
    const item = this.snapshot?.items[index ?? this.snapshot.index];
    if (item && this.props) this.props.command(item);
  }

  close(): void {
    if (this.owner) exitSuggestion(this.editor.view, this.owner);
    if (this.owner) this.hide(this.owner);
  }

  /** メニューが出ている間のキー。項目が 0 件・日本語入力の変換中は横取りしない。 */
  keyDown(event: KeyboardEvent): boolean {
    if (!this.snapshot || this.snapshot.items.length === 0) return false;
    if (event.isComposing || event.keyCode === 229) return false;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    switch (event.key) {
      case "ArrowDown":
        this.move(1);
        return true;
      case "ArrowUp":
        this.move(-1);
        return true;
      case "Enter":
      case "Tab":
        if (event.shiftKey) return false;
        this.choose();
        return true;
      case "Escape":
        this.close();
        return true;
      default:
        return false;
    }
  }
}

const stores = new WeakMap<Editor, SlashMenuStore>();

export function slashMenuStore(editor: Editor): SlashMenuStore {
  let store = stores.get(editor);
  if (!store) {
    store = new SlashMenuStore(editor);
    stores.set(editor, store);
  }
  return store;
}

export const SLASH_KEYS = { half: new PluginKey("slashMenu"), full: new PluginKey("slashMenuFull") } as const;

/**
 * 「/」のメニューでページの操作を決めたとき: 「/問い合わせ」を消し（それで空になった本文の直下の行は、ほかに行があれば消す。
 * 「/」を打つために足した行を残さない）、操作を実行する。
 */
export function choosePageAction(editor: Editor, range: Range, action: PageAction): void {
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .command(({ tr }) => {
      const $from = tr.selection.$from;
      if ($from.depth === 1 && $from.parent.isTextblock && $from.parent.content.size === 0 && tr.doc.childCount > 1) {
        tr.delete($from.before(), $from.after());
      }
      return true;
    })
    .run();
  action.run();
}

function suggestion(editor: Editor, char: string, pluginKey: PluginKey): SuggestionOptions<SlashItem, SlashItem> {
  const store = slashMenuStore(editor);
  return {
    editor,
    char,
    pluginKey,
    // 文中でも開く（Notion と同じ）。空白で閉じる
    allowedPrefixes: null,
    allowSpaces: false,
    allow: ({ state, range }) => {
      const $from = state.doc.resolve(range.from);
      // コードブロック・文字のままのブロック（表）・コードの mark の中では開かない
      if ($from.parent.type.spec.code) return false;
      return !$from.marks().some((mark) => mark.type.spec.code);
    },
    items: ({ query }) => [...filterBlockTypes(query), ...filterPageActions(query, store.pageActions)],
    command: ({ editor: current, range, props }) => {
      if (!isPageAction(props)) {
        chooseBlockType(current, range, props.id);
        return;
      }
      // 操作は今の値で（メニューを出した後に置き直されていても古い操作を呼ばない）
      const action = store.pageActions.find((candidate) => candidate.id === props.id);
      if (action) choosePageAction(current, range, action);
    },
    render: () => ({
      onStart: (props) => store.show(pluginKey, props),
      onUpdate: (props) => store.show(pluginKey, props),
      onExit: () => store.hide(pluginKey),
      onKeyDown: ({ event }) => store.keyDown(event),
    }),
  };
}

export const SlashCommand = Extension.create({
  name: "slashCommand",
  // Enter・↑↓ を、行のキー（BlockKeys）やリストの Enter より先に受ける
  priority: 1100,

  addProseMirrorPlugins() {
    return [
      Suggestion(suggestion(this.editor, "/", SLASH_KEYS.half)),
      Suggestion(suggestion(this.editor, "／", SLASH_KEYS.full)),
    ];
  },
});
