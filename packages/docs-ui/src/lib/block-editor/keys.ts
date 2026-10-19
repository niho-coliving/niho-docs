import { Extension, type Editor } from "@tiptap/core";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { liftTarget } from "@tiptap/pm/transform";

/**
 * Enter と行頭の Backspace（Notion のような行の扱い）。既定（リストの splitListItem・hardBreak・コードの改行・
 * TipTap の core の undoInputRule）より先に効かせるため priority を高くする（「/」のメニューのキーはさらに先）。
 */

/** カーソルのある段落を、包んでいるもの（引用）の外へ出す。 */
function liftCursorBlock(tr: Transaction): boolean {
  const range = tr.selection.$from.blockRange();
  const target = range && liftTarget(range);
  if (!range || target === null || target === undefined) return false;
  tr.lift(range, target);
  return true;
}

function cursor(editor: Editor) {
  const { selection } = editor.state;
  return selection instanceof TextSelection && selection.empty ? selection.$from : null;
}

/** 引用の中の段落で Enter: 引用の外に新しい段落（空の行なら引用を抜けて段落）。 */
export function enterInQuote(editor: Editor): boolean {
  const $from = cursor(editor);
  if (!$from || $from.parent.type.name !== "paragraph" || $from.depth < 2) return false;
  if ($from.node(-1).type.name !== "blockquote") return false;
  if ($from.parent.content.size === 0) return editor.commands.command(({ tr }) => liftCursorBlock(tr));
  // 行頭の Enter は既定（上に空の行を作る）に任せる（中身ごと引用の外へ出さない）
  if ($from.parentOffset === 0) return false;
  return editor
    .chain()
    .splitBlock()
    .command(({ tr }) => liftCursorBlock(tr))
    .run();
}

/** 行頭の Backspace: 見出し→段落、リストの項目→持ち上げて段落、引用の中の段落→引用の外へ。 */
export function backspaceAtLineStart(editor: Editor): boolean {
  const $from = cursor(editor);
  if (!$from || $from.parentOffset !== 0 || !$from.parent.isTextblock) return false;
  const parent = $from.parent;
  if (parent.type.name === "heading") return editor.commands.setParagraph();
  if (parent.type.name !== "paragraph" || $from.depth < 2) return false;
  const container = $from.node(-1);
  if ((container.type.name === "listItem" || container.type.name === "taskItem") && $from.index(-1) === 0) {
    return editor.commands.liftListItem(container.type.name);
  }
  if (container.type.name === "blockquote") return editor.commands.command(({ tr }) => liftCursorBlock(tr));
  return false;
}

export const BlockKeys = Extension.create({
  name: "blockKeys",
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: () => enterInQuote(this.editor),
      Backspace: () => backspaceAtLineStart(this.editor),
    };
  },
});
