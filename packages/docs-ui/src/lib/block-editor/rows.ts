import { Fragment, type Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { Selection, TextSelection, type Transaction } from "@tiptap/pm/state";

/**
 * 「行」の一覧と行の操作（行の ＋ ⋮⋮ で使う）。DOM の座標に頼らない純粋な関数（Transaction を受けて書き換える）。
 * 行は doc の直下のノード。ただし doc の直下のリストは項目ごとが行（入れ子のリストは親の項目に含める）。
 */

const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList"]);

export function isListNode(node: ProseMirrorNode): boolean {
  return LIST_TYPES.has(node.type.name);
}

export type Row = {
  /** 行のノードの位置 */
  pos: number;
  node: ProseMirrorNode;
  /** リストの項目のとき、そのリストの位置と項目の番号 */
  list: { pos: number; node: ProseMirrorNode; index: number } | null;
};

export function listRows(doc: ProseMirrorNode): Row[] {
  const rows: Row[] = [];
  doc.forEach((node, offset) => {
    if (!isListNode(node)) {
      rows.push({ pos: offset, node, list: null });
      return;
    }
    node.forEach((item, itemOffset, index) => {
      rows.push({ pos: offset + 1 + itemOffset, node: item, list: { pos: offset, node, index } });
    });
  });
  return rows;
}

/** 位置 pos を含む行（行の中 → 行の先頭 → 行の末尾の順に探す）。 */
export function rowAt(doc: ProseMirrorNode, pos: number): Row | null {
  const rows = listRows(doc);
  const end = (row: Row) => row.pos + row.node.nodeSize;
  return (
    rows.find((row) => pos > row.pos && pos < end(row)) ??
    rows.find((row) => pos === row.pos) ??
    rows.find((row) => pos === end(row)) ??
    null
  );
}

function childrenOf(node: ProseMirrorNode): ProseMirrorNode[] {
  const children: ProseMirrorNode[] = [];
  node.forEach((child) => children.push(child));
  return children;
}

/** リストの from 番目からの項目を新しいリストにする（番号付きは start を続きの数にする）。 */
function restOfList(list: ProseMirrorNode, from: number): ProseMirrorNode {
  const items = childrenOf(list).slice(from);
  const attrs = list.type.name === "orderedList" ? { ...list.attrs, start: (Number(list.attrs.start) || 1) + from } : list.attrs;
  return list.type.create(attrs, items);
}

function headOfList(list: ProseMirrorNode, count: number): ProseMirrorNode {
  return list.copy(Fragment.fromArray(childrenOf(list).slice(0, count)));
}

/** コードや表の文字を段落にする（改行は行の中の改行にする）。 */
export function paragraphFromText(schema: Schema, text: string): ProseMirrorNode {
  const content = text.split("\n").flatMap((line, index) => {
    const parts = line ? [schema.text(line)] : [];
    return index === 0 ? parts : [schema.nodes.hardBreak!.create(), ...parts];
  });
  return schema.nodes.paragraph!.create(null, content);
}

/**
 * 隣り合う同じ種類のリストをつないでよいか。番号付きは、後ろの start が前の続きの数のときだけ
 * （`1. A`・`1. B` をつなぐと後ろの番号が消える。つながないリストは、serializer が区切りを変えて別のリストのまま往復させる）。
 */
function continuesList(before: ProseMirrorNode, after: ProseMirrorNode): boolean {
  if (before.type.name !== "orderedList") return true;
  const start = (node: ProseMirrorNode) => Number(node.attrs.start ?? 1);
  return start(after) === start(before) + before.childCount;
}

/**
 * from〜to の前後で、doc の直下に同じ種類のリストが隣り合っていればつなぐ
 * （空行を挟んだ同じリストは、Markdown の往復で 1 つのリストに読まれる。番号付きは続きの数のときだけ）。
 */
export function joinListsBetween(tr: Transaction, from: number, to: number): void {
  const doc = tr.doc;
  const clamp = (pos: number) => Math.max(0, Math.min(pos, doc.content.size));
  const first = Math.max(0, doc.resolve(clamp(from)).index(0) - 1);
  const last = Math.min(doc.childCount - 1, doc.resolve(clamp(to)).index(0) + 1);
  const boundaries: number[] = [];
  let pos = 0;
  for (let index = 0; index < doc.childCount; index++) {
    const node = doc.child(index);
    pos += node.nodeSize;
    const next = doc.maybeChild(index + 1);
    if (index >= first && index < last && next && isListNode(node) && next.type === node.type && continuesList(node, next)) {
      boundaries.push(pos);
    }
  }
  // 後ろからつなぐ（前の位置がずれない）
  for (const boundary of boundaries.reverse()) tr.join(boundary);
}

/**
 * 行の下に段落を足し、その段落の位置を返す。リストの項目の途中なら、そこでリストを分けて間に入れる
 * （番号付きは後ろのリストの start を続きの数にする）。
 */
export function insertParagraphAfterRow(tr: Transaction, row: Row, text = ""): number {
  const schema = tr.doc.type.schema;
  const paragraph = schema.nodes.paragraph!.create(null, text ? schema.text(text) : null);
  const list = row.list;
  if (!list || list.index === list.node.childCount - 1) {
    const at = list ? list.pos + list.node.nodeSize : row.pos + row.node.nodeSize;
    tr.insert(at, paragraph);
    return at;
  }
  const before = headOfList(list.node, list.index + 1);
  tr.replaceWith(list.pos, list.pos + list.node.nodeSize, [before, paragraph, restOfList(list.node, list.index + 1)]);
  return list.pos + before.nodeSize;
}

/** ＋: 行の下に「/」だけの段落を足し、カーソルを「/」の後ろに置く（「/」のメニューが開く）。 */
export function addSlashLineBelow(tr: Transaction, row: Row): void {
  const at = insertParagraphAfterRow(tr, row, "/");
  tr.setSelection(TextSelection.create(tr.doc, at + 2));
}

/** 削除（確認しない。⌘Z で戻せる）。最後の 1 行を消したら空の段落を 1 つ残す。 */
export function deleteRow(tr: Transaction, row: Row): void {
  const list = row.list;
  const whole = list && list.node.childCount === 1 ? list : row;
  const from = whole.pos;
  const to = whole.pos + whole.node.nodeSize;
  if (from === 0 && to === tr.doc.content.size) {
    tr.replaceWith(0, to, tr.doc.type.schema.nodes.paragraph!.create());
    tr.setSelection(TextSelection.create(tr.doc, 1));
    return;
  }
  tr.delete(from, to);
  const steps = tr.steps.length;
  joinListsBetween(tr, from, from);
  const at = tr.mapping.slice(steps).map(from, -1);
  tr.setSelection(Selection.near(tr.doc.resolve(at), -1));
}

/** 複製（すぐ下に同じもの）。 */
export function duplicateRow(tr: Transaction, row: Row): void {
  tr.insert(row.pos + row.node.nodeSize, row.node);
}

export function canTurnRowIntoText(row: Row): boolean {
  return row.node.type.name !== "horizontalRule";
}

/** テキストに戻す（段落に。リストの項目はリストの外へ出す・引用は外す）。 */
export function turnRowIntoText(tr: Transaction, row: Row): void {
  const schema = tr.doc.type.schema;
  const node = row.node;
  const list = row.list;
  if (list) {
    const parts: ProseMirrorNode[] = [];
    if (list.index > 0) parts.push(headOfList(list.node, list.index));
    node.forEach((child) => parts.push(child));
    if (list.index < list.node.childCount - 1) parts.push(restOfList(list.node, list.index + 1));
    const size = parts.reduce((sum, part) => sum + part.nodeSize, 0);
    tr.replaceWith(list.pos, list.pos + list.node.nodeSize, parts);
    joinListsBetween(tr, list.pos, list.pos + size);
    return;
  }
  const end = row.pos + node.nodeSize;
  switch (node.type.name) {
    case "heading":
      tr.setNodeMarkup(row.pos, schema.nodes.paragraph!);
      return;
    case "blockquote":
      tr.replaceWith(row.pos, end, node.content);
      joinListsBetween(tr, row.pos, row.pos + node.content.size);
      return;
    case "codeBlock":
    case "markdownRaw":
      tr.replaceWith(row.pos, end, paragraphFromText(schema, node.textContent));
      return;
    default:
      return;
  }
}
