import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export const PARAGRAPH_HINT = "入力するか「/」でコマンド";

/**
 * 空の行の案内。段落はカーソルのある行か doc が 1 行だけのときだけ出し、ほかの種類は空なら常に出す。
 * 表示は CSS の ::before（class is-empty ＋ data-placeholder。@tiptap/extensions の Placeholder と同じ形）。
 */
export function placeholderFor(doc: ProseMirrorNode, node: ProseMirrorNode, pos: number, hasAnchor: boolean): string {
  if (node.type.name === "heading") return `見出し${String(node.attrs.level)}`;
  if (node.type.name === "codeBlock") return "コード";
  if (node.type.name !== "paragraph") return "";
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const name = $pos.node(depth).type.name;
    if (name === "taskItem") return "やること";
    if (name === "listItem") return "リスト";
    if (name === "blockquote") return "引用";
  }
  return hasAnchor || doc.childCount === 1 ? PARAGRAPH_HINT : "";
}

/**
 * @tiptap/extensions の Placeholder（3.32）は、関数に渡る editor の state が描いている doc より古く、
 * 段落がリストや引用の中かを引けない。描いている state から計算する plugin を自前で持つ。
 */
export const BlockPlaceholder = Extension.create({
  name: "blockPlaceholder",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey("blockPlaceholder"),
        props: {
          decorations: (state) => {
            // 読み取り専用（実行中）では出さない
            if (!editor.isEditable) return null;
            const { anchor } = state.selection;
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isTextblock) return true;
              if (node.content.size === 0) {
                const text = placeholderFor(state.doc, node, pos, anchor >= pos && anchor <= pos + node.nodeSize);
                if (text) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "is-empty", "data-placeholder": text }));
              }
              return false;
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
