import { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { ENABLED_INPUT_RULES, buildBlockEditorExtensions } from "../src/lib/block-editor";
import { docToMarkdown, finalizeMarkdown, markdownToDoc } from "../src/lib/markdown";

/** jsdom でブロックのエディタを作り、1 文字ずつ打つ・キーを押すための小道具。 */

// jsdom の Range には座標が無い（ProseMirror の scrollIntoView・「/」のメニューの位置が読む）。0 の矩形を返す
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return new DOMRect(0, 0, 0, 0);
  };
}

export function createEditor(markdown = "", options: { timestamps?: boolean } = {}): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: buildBlockEditorExtensions(),
    enableInputRules: ENABLED_INPUT_RULES,
    content: markdownToDoc(markdown, options.timestamps === true).toJSON() as JSONContent,
  });
  cursorToEnd(editor);
  return editor;
}

export function destroyEditor(editor: Editor): void {
  const element = editor.view.dom.parentElement;
  editor.destroy();
  element?.remove();
}

export function cursorTo(editor: Editor, pos: number): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
}

export function cursorToEnd(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
}

/** 位置を文字で探す（その文字の直後。after=false なら直前）。 */
export function positionOf(editor: Editor, text: string, after = true): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return;
    const index = node.text!.indexOf(text);
    if (index >= 0) found = pos + index + (after ? text.length : 0);
  });
  if (found < 0) throw new Error(`text not found: ${text}`);
  return found;
}

/** 1 文字ずつ打つ（input rule は handleTextInput で走る。効かなければそのまま入れる）。 */
export function typeText(editor: Editor, text: string): void {
  const view = editor.view;
  for (const character of text) {
    const { from, to } = view.state.selection;
    const deflt = () => view.state.tr.insertText(character, from, to);
    const handled = view.someProp("handleTextInput", (handler) => handler(view, from, to, character, deflt));
    if (!handled) view.dispatch(deflt());
  }
}

/** キーを押す（エディタが受けたら true）。 */
export function press(editor: Editor, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  return Boolean(editor.view.someProp("handleKeyDown", (handler) => handler(editor.view, event)));
}

/** ⌘（Mac 以外の jsdom では Ctrl）。 */
export const MOD: KeyboardEventInit = /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

export function markdownOf(editor: Editor): string {
  return finalizeMarkdown(docToMarkdown(editor.state.doc));
}

export function topTypes(editor: Editor): string[] {
  const names: string[] = [];
  editor.state.doc.forEach((node) => names.push(node.type.name));
  return names;
}

/** suggestion の表示（items の取得が非同期）と setTimeout の処理を待つ。 */
export async function flush(): Promise<void> {
  for (let index = 0; index < 3; index++) await new Promise((resolve) => setTimeout(resolve, 0));
}
