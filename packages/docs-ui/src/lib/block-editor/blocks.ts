import type { CommandProps, Editor, Range } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { liftTarget } from "@tiptap/pm/transform";
import { insertParagraphAfterRow, joinListsBetween, paragraphFromText, rowAt } from "./rows";

/**
 * ブロック（行）の種類の一覧。「/」のメニュー・書式のバーの「行の種類」で共有する（「/」のメニューのページの操作は slash.ts）。
 * 書き始め（hint）は行頭の Markdown の記号（input-rules.ts）と同じ。
 */

export type BlockTypeId = "paragraph" | "h1" | "h2" | "h3" | "bullet" | "ordered" | "task" | "quote" | "code" | "hr";

export type BlockType = {
  id: BlockTypeId;
  /** 画面の名前 */
  name: string;
  /** 枠の中の記号 */
  key: string;
  /** 書き始めの Markdown */
  hint: string;
  /** 絞り込みの別名（英語・ローマ字・かな） */
  aliases: readonly string[];
};

export const BLOCK_TYPES: readonly BlockType[] = [
  { id: "paragraph", name: "テキスト", key: "Aa", hint: "", aliases: ["text", "tekisuto", "てきすと"] },
  { id: "h1", name: "見出し1", key: "H1", hint: "#", aliases: ["h1", "heading", "midashi", "みだし"] },
  { id: "h2", name: "見出し2", key: "H2", hint: "##", aliases: ["h2", "heading", "midashi", "みだし"] },
  { id: "h3", name: "見出し3", key: "H3", hint: "###", aliases: ["h3", "heading", "midashi", "みだし"] },
  { id: "bullet", name: "箇条書き", key: "•", hint: "-", aliases: ["bullet", "list", "ul", "risuto", "りすと", "かじょうがき"] },
  { id: "ordered", name: "番号付きリスト", key: "1.", hint: "1.", aliases: ["number", "ordered", "list", "ol", "bangou", "ばんごう"] },
  { id: "task", name: "チェックボックス", key: "☐", hint: "[]", aliases: ["todo", "check", "task", "ちぇっく", "やること"] },
  { id: "quote", name: "引用", key: "❝", hint: ">", aliases: ["quote", "inyou", "いんよう"] },
  { id: "code", name: "コード", key: "</>", hint: "```", aliases: ["code", "ko-do", "こーど"] },
  { id: "hr", name: "区切り線", key: "—", hint: "---", aliases: ["divider", "hr", "line", "kugiri", "くぎり"] },
];

export function blockType(id: BlockTypeId): BlockType {
  return BLOCK_TYPES.find((type) => type.id === id) ?? BLOCK_TYPES[0]!;
}

/** 「/」の後ろの問い合わせに合うか（全角・大文字も同じに扱う。名前・別名に含む、または書き始めと一致。空なら合う）。 */
export function matchesSlashQuery(item: Pick<BlockType, "name" | "aliases" | "hint">, query: string): boolean {
  const normalized = query.normalize("NFKC").toLowerCase();
  if (!normalized) return true;
  return (
    item.name.toLowerCase().includes(normalized) ||
    item.aliases.some((alias) => alias.includes(normalized)) ||
    (item.hint !== "" && item.hint === normalized)
  );
}

/** 「/」の後ろの問い合わせで絞る（matchesSlashQuery）。 */
export function filterBlockTypes(query: string): BlockType[] {
  return BLOCK_TYPES.filter((type) => matchesSlashQuery(type, query));
}

const LIST_ITEMS: Record<string, BlockTypeId> = { bulletList: "bullet", orderedList: "ordered", taskList: "task" };

/** 選択のある行の種類（表などの文字のままのブロックは null）。 */
export function lineTypeId(state: EditorState): BlockTypeId | null {
  const { selection } = state;
  if (selection instanceof NodeSelection) return selection.node.type.name === "horizontalRule" ? "hr" : null;
  const $from = selection.$from;
  const parent = $from.parent;
  if (parent.type.name === "markdownRaw") return null;
  if (parent.type.name === "codeBlock") return "code";
  if (parent.type.name === "heading") {
    const level = Number(parent.attrs.level);
    return level === 1 ? "h1" : level === 2 ? "h2" : "h3";
  }
  for (let depth = $from.depth - 1; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "blockquote") return "quote";
    if (node.type.name === "listItem" || node.type.name === "taskItem") {
      return LIST_ITEMS[$from.node(depth - 1).type.name] ?? "bullet";
    }
  }
  return "paragraph";
}

type BlockCommand = (props: CommandProps) => boolean;

/** コード（改行を含む文字）を段落にするとき、改行を行の中の改行（hardBreak）にする。 */
function codeLineToParagraph(tr: Transaction): void {
  const { $from, from, to } = tr.selection;
  if (!$from.parent.type.spec.code || !$from.sameParent(tr.selection.$to)) return;
  tr.replaceWith($from.before(), $from.after(), paragraphFromText(tr.doc.type.schema, $from.parent.textContent));
  // 改行 1 文字が hardBreak 1 つになるだけなので、位置はそのまま使える
  tr.setSelection(TextSelection.create(tr.doc, from, to));
}

/** 1 段持ち上げる（持ち上げられなければ false）。リストの項目の先頭の段落は、項目の中身ごと持ち上げる（入れ子のリストを残さない）。 */
function liftOnce(tr: Transaction, pos: number): number | null {
  const $inside = tr.doc.resolve(pos + 1);
  if ($inside.depth <= 1) return null;
  const container = $inside.node(-1);
  const isItemHead = (container.type.name === "listItem" || container.type.name === "taskItem") && $inside.index(-1) === 0;
  const range = isItemHead
    ? tr.doc.resolve($inside.start(-1)).blockRange(tr.doc.resolve($inside.end(-1)))
    : $inside.blockRange();
  const target = range && liftTarget(range);
  if (!range || target === null || target === undefined) return null;
  const steps = tr.steps.length;
  try {
    tr.lift(range, target);
  } catch {
    return null;
  }
  return tr.mapping.slice(steps).map(pos + 1) - 1;
}

/**
 * 選択の中の行を段落にし、包み（リスト・引用）の外へ出す。
 * TipTap の clearNodes は同じ取引の前の手順があると位置がずれる（取引の頭からの mapping を当てる）ので使わない。
 */
function clearLines(tr: Transaction): void {
  const paragraph = tr.doc.type.schema.nodes.paragraph!;
  const { from, to } = tr.selection;
  const starts: number[] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.name !== "markdownRaw") starts.push(pos);
    return false;
  });
  // 後ろの行から（前の行の位置はずれない）
  for (const start of starts.reverse()) {
    const node = tr.doc.nodeAt(start);
    if (node?.type.spec.code) {
      // コードの改行は行の中の改行（hardBreak）にする。setNodeMarkup だと改行が段落の中の文字に残り、空白に潰れる
      // （改行 1 文字が hardBreak 1 つになるだけなので、大きさは変わらない）
      tr.replaceWith(start, start + node.nodeSize, paragraphFromText(tr.doc.type.schema, node.textContent));
    } else if (node?.type !== paragraph) tr.setNodeMarkup(start, paragraph);
    let pos: number | null = start;
    while (pos !== null) pos = liftOnce(tr, pos);
  }
}

/** 区切り線: 空の行は区切り線に置き換え、空でなければ行の下に足す。どちらも下に空の段落を足してカーソルを置く。 */
function divider(props: CommandProps): boolean {
  const { tr } = props;
  const schema = tr.doc.type.schema;
  const nodes = [schema.nodes.horizontalRule!.create(), schema.nodes.paragraph!.create()];
  const $from = tr.selection.$from;
  if ($from.parent.isTextblock && $from.parent.content.size === 0) {
    clearLines(tr);
    const $line = tr.selection.$from;
    const start = $line.before();
    tr.replaceWith(start, $line.after(), nodes);
    tr.setSelection(TextSelection.create(tr.doc, start + 2));
    return true;
  }
  const row = rowAt(tr.doc, $from.pos);
  if (!row) return false;
  const at = insertParagraphAfterRow(tr, row);
  tr.replaceWith(at, at + 2, nodes);
  tr.setSelection(TextSelection.create(tr.doc, at + 2));
  return true;
}

/**
 * 選択のある行を種類 id にする（リストや引用の中なら、外へ出してから変える）。
 * 表などの文字のままのブロックは変えない。
 * 種類を当てる手順は props.chain() でつなぐ（chainable state の doc・選択は手順ごとに取り直さないと古いまま）。
 */
export function setLineType(id: BlockTypeId): BlockCommand {
  return (props) => {
    const { tr } = props;
    if (tr.selection.$from.parent.type.name === "markdownRaw") return false;
    if (id === "hr") return divider(props);
    if (id !== "code") codeLineToParagraph(tr);
    clearLines(tr);
    let chain = props.chain();
    switch (id) {
      case "h1":
      case "h2":
      case "h3":
        chain = chain.setNode("heading", { level: Number(id.slice(1)) });
        break;
      case "bullet":
        chain = chain.toggleBulletList();
        break;
      case "ordered":
        chain = chain.toggleOrderedList();
        break;
      case "task":
        chain = chain.toggleTaskList();
        break;
      case "quote":
        chain = chain.setBlockquote();
        break;
      case "code":
        chain = chain.setCodeBlock();
        break;
      case "paragraph":
        break;
    }
    return chain
      .command(({ tr: current }) => {
        // 同じ種類のリストが隣り合うと、Markdown の往復で 1 つのリストに読まれる（つないでおく）
        joinListsBetween(current, current.selection.from, current.selection.to);
        return true;
      })
      .run();
  };
}

/** 選択のある行の下に、種類 id の新しい行を足してカーソルを移す。 */
export function addBlockBelow(id: BlockTypeId): BlockCommand {
  return (props) => {
    const { tr } = props;
    const row = rowAt(tr.doc, tr.selection.from);
    if (!row) return false;
    const at = insertParagraphAfterRow(tr, row);
    tr.setSelection(TextSelection.create(tr.doc, at + 1));
    return setLineType(id)(props);
  };
}

/** 「/」のメニューで決めたとき: 「/問い合わせ」を消し、空の行なら種類を変え、空でなければ下に足す。 */
export function chooseBlockType(editor: Editor, range: Range, id: BlockTypeId): boolean {
  return editor
    .chain()
    .focus()
    .deleteRange(range)
    .command((props) => {
      const $from = props.tr.selection.$from;
      const empty = $from.parent.isTextblock && $from.parent.content.size === 0;
      return empty ? setLineType(id)(props) : addBlockBelow(id)(props);
    })
    .run();
}

/** 書式のバーを出すか（文字を選んだときだけ。コード・区切り線の選択・空の選択では出さない）。 */
export function shouldShowFormatBar(state: EditorState, editable: boolean): boolean {
  const { selection } = state;
  if (!editable || !(selection instanceof TextSelection) || selection.empty) return false;
  if (selection.$from.parent.type.spec.code || selection.$to.parent.type.spec.code) return false;
  return state.doc.textBetween(selection.from, selection.to, " ").trim().length > 0;
}

/** 本文の 1 行目の先頭へフォーカスを移す（1 行目が区切り線なら、その前に空の段落を作る）。 */
export function focusBodyStart(editor: Editor): void {
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      const first = tr.doc.firstChild;
      if (!first || first.isAtom) tr.insert(0, tr.doc.type.schema.nodes.paragraph!.create());
      tr.setSelection(TextSelection.near(tr.doc.resolve(1)));
      return true;
    })
    .scrollIntoView()
    .run();
}
