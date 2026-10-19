import { Extension, InputRule, type Range } from "@tiptap/core";
import type { Attrs, MarkType, NodeType, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, TextSelection, type EditorState } from "@tiptap/pm/state";
import { canJoin, findWrapping } from "@tiptap/pm/transform";

/**
 * 行頭の Markdown（書き始め）と行の中の書式の input rule。
 * StarterKit の既定の規則は直前が空白であることを前提にしていて日本語の文中で効かないので、
 * エディタの enableInputRules をこの拡張だけにして、全角の記号も含めて自前で書く。
 * lookbehind（`(?<!…)`）は使わない（16.4 未満の WebKit では正規表現の構文エラーで画面ごと落ちる）。
 */

// 半角・全角の空白と、contenteditable が行頭の空白を置き換える U+00A0（改行は含めない＝Enter では効かせない）
const SPACE = "[ \\u00a0\\u3000]";

/** doc の直下の段落の行頭だけで書き始めを効かせる（リストの項目の中の `- ` で入れ子にしない）。 */
function atTopParagraphStart(state: EditorState, range: Range): boolean {
  const $from = state.doc.resolve(range.from);
  return $from.depth === 1 && $from.parent.type.name === "paragraph" && $from.parentOffset === 0;
}

function headingRule(): InputRule {
  return new InputRule({
    find: new RegExp(`^(#{1,3}|＃{1,3})${SPACE}$`),
    handler: ({ state, range, match }) => {
      if (!atTopParagraphStart(state, range)) return null;
      const level = (match[1] ?? "#").length;
      state.tr.delete(range.from, range.to).setBlockType(range.from, range.from, state.schema.nodes.heading!, { level });
    },
  });
}

/** 行を type で包む（リストは前の同じ種類のリストにつなぐ）。 */
function wrapLine(
  state: EditorState,
  range: Range,
  type: NodeType,
  attrs: Attrs | null,
  joinBefore: (before: ProseMirrorNode) => boolean,
): null | undefined {
  if (!atTopParagraphStart(state, range)) return null;
  const tr = state.tr.delete(range.from, range.to);
  const blockRange = tr.doc.resolve(range.from).blockRange();
  const wrapping = blockRange && findWrapping(blockRange, type, attrs);
  if (!blockRange || !wrapping) return null;
  tr.wrap(blockRange, wrapping);
  const before = tr.doc.resolve(range.from - 1).nodeBefore;
  const list = wrapping[0]!.type;
  if (before && before.type === list && canJoin(tr.doc, range.from - 1) && joinBefore(before)) tr.join(range.from - 1);
  return undefined;
}

function bulletRule(): InputRule {
  return new InputRule({
    find: new RegExp(`^[-*+・－＊]${SPACE}$`),
    handler: ({ state, range }) => wrapLine(state, range, state.schema.nodes.bulletList!, null, () => true),
  });
}

function orderedRule(): InputRule {
  return new InputRule({
    find: new RegExp(`^([0-9０-９]+)[.．]${SPACE}$`),
    handler: ({ state, range, match }) => {
      const start = Number((match[1] ?? "1").normalize("NFKC"));
      // 前の番号付きの続きの数のときだけつなぐ
      return wrapLine(
        state,
        range,
        state.schema.nodes.orderedList!,
        { start },
        (before) => (Number(before.attrs.start) || 1) + before.childCount === start,
      );
    },
  });
}

function taskRule(): InputRule {
  return new InputRule({
    find: new RegExp(`^(\\[\\]|\\[ \\]|\\[[xX]\\]|［］|［[ 　]］|［[xXｘＸ]］)${SPACE}?$`),
    handler: ({ state, range, match }) => {
      const checked = /[xXｘＸ]/.test(match[1] ?? "");
      return wrapLine(state, range, state.schema.nodes.taskItem!, { checked }, () => true);
    },
  });
}

function quoteRule(): InputRule {
  return new InputRule({
    find: new RegExp(`^[>＞]${SPACE}$`),
    handler: ({ state, range }) => wrapLine(state, range, state.schema.nodes.blockquote!, null, () => false),
  });
}

function codeRule(): InputRule {
  return new InputRule({
    find: /^(```|｀｀｀)$/,
    handler: ({ state, range }) => {
      if (!atTopParagraphStart(state, range)) return null;
      state.tr.delete(range.from, range.to).setBlockType(range.from, range.from, state.schema.nodes.codeBlock!);
    },
  });
}

function dividerRule(): InputRule {
  return new InputRule({
    find: /^(---|ーーー|－－－)$/,
    handler: ({ state, range }) => {
      if (!atTopParagraphStart(state, range)) return null;
      const $from = state.doc.resolve(range.from);
      // 行がそれだけのとき（後ろに文字が続く行は区切り線にしない）
      if (range.to !== $from.end()) return null;
      const start = $from.before();
      const { schema } = state;
      const tr = state.tr.replaceWith(start, $from.after(), [schema.nodes.horizontalRule!.create(), schema.nodes.paragraph!.create()]);
      tr.setSelection(TextSelection.create(tr.doc, start + 2));
    },
  });
}

/**
 * 行の中の書式。前置き（直前の 1 文字）を捕獲して、印の外の文字が何でも効くようにする。
 * TipTap の markInputRule は前置きを空白と仮定するので使わず、mark の範囲を自分で数える。
 */
function markRule(find: RegExp, markName: string): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      const type: MarkType | undefined = state.schema.marks[markName];
      const [, prefix = "", delimiter = "", content = ""] = match;
      if (!type || !content) return null;
      const start = range.from + prefix.length;
      const contentStart = start + delimiter.length;
      const contentEnd = contentStart + content.length;
      // 行の中の改行などの文字でない node をまたぐと位置が合わないので、そのときは効かせない
      if (contentEnd > range.to || state.doc.textBetween(contentStart, contentEnd) !== content) return null;
      let blocked = false;
      state.doc.nodesBetween(contentStart, contentEnd, (node) => {
        if (node.marks.some((mark) => mark.type !== type && mark.type.excludes(type))) blocked = true;
      });
      if (blocked) return null;
      // 閉じの印（最後の 1 文字は打った文字で、まだ doc に無い）→ 開きの印の順に消す
      state.tr.delete(contentEnd, range.to).delete(start, contentStart).addMark(start, start + content.length, type.create());
      state.tr.removeStoredMark(type);
    },
  });
}

// 中身は空白で始まらず空白で終わらない（`2 * 3 * 4` のような式で効かせない）
const inner = (excluded: string) => `([^${excluded}\\s](?:[^${excluded}]*[^${excluded}\\s])?)`;

export const BlockInputRules = Extension.create({
  name: "blockInputRules",

  addInputRules() {
    return [
      headingRule(),
      bulletRule(),
      orderedRule(),
      taskRule(),
      quoteRule(),
      codeRule(),
      dividerRule(),
      markRule(new RegExp(`(^|[^*＊])(\\*\\*|＊＊)${inner("*＊")}\\2$`), "bold"),
      // `**` の途中（直前が * ）では斜体にしない
      markRule(new RegExp(`(^|[^*＊])(\\*|＊)${inner("*＊")}\\2$`), "italic"),
      markRule(new RegExp(`(^|[^~～〜])(~~|～～|〜〜)${inner("~～〜")}\\2$`), "strike"),
      markRule(/(^|[^`｀])(`|｀)([^`｀]+)\2$/, "code"),
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          // `[]` は打った時点でチェックになるので、続けて打った空白を項目の頭に入れない（Markdown でも消える空白）
          handleTextInput(view, from, to, text) {
            if (from !== to || !/^\s$/.test(text)) return false;
            const $from = view.state.doc.resolve(from);
            return (
              $from.parent.type.name === "paragraph" &&
              $from.parent.content.size === 0 &&
              $from.depth >= 2 &&
              $from.node(-1).type.name === "taskItem" &&
              $from.index(-1) === 0
            );
          },
        },
      }),
    ];
  },
});
