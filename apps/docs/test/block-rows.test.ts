import { EditorState, type Transaction } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import {
  addSlashLineBelow,
  canTurnRowIntoText,
  deleteRow,
  duplicateRow,
  listRows,
  rowAt,
  turnRowIntoText,
  type Row,
} from "../src/lib/block-editor/rows";
import { docToMarkdown, finalizeMarkdown, markdownToDoc } from "../src/lib/markdown";

function apply(markdown: string, index: number, operation: (tr: Transaction, row: Row) => void): { markdown: string; tr: Transaction } {
  const state = EditorState.create({ doc: markdownToDoc(markdown) });
  const tr = state.tr;
  const row = listRows(tr.doc)[index];
  if (!row) throw new Error(`row not found: ${index}`);
  operation(tr, row);
  return { markdown: finalizeMarkdown(docToMarkdown(tr.doc)), tr };
}

const SAMPLE = "# 題\n\n本文\n\n- 一\n- 二\n  - 子\n\n1. 一\n2. 二\n3. 三\n\n> 引用\n\n---\n";

describe("行の一覧", () => {
  it("doc の直下のノードが行。doc の直下のリストは項目ごとが行（入れ子は親の項目に含める）", () => {
    const rows = listRows(markdownToDoc(SAMPLE));
    expect(rows.map((row) => row.node.type.name)).toEqual([
      "heading",
      "paragraph",
      "listItem",
      "listItem",
      "listItem",
      "listItem",
      "listItem",
      "blockquote",
      "horizontalRule",
    ]);
    expect(rows.map((row) => row.node.textContent)).toEqual(["題", "本文", "一", "二子", "一", "二", "三", "引用", ""]);
    expect(rows[3]?.list?.index).toBe(1);
  });

  it("位置から行を引く", () => {
    const doc = markdownToDoc(SAMPLE);
    expect(rowAt(doc, 2)?.node.textContent).toBe("題");
    const rows = listRows(doc);
    const hr = rows[rows.length - 1]!;
    expect(rowAt(doc, hr.pos)?.node.type.name).toBe("horizontalRule");
  });
});

describe("行の操作", () => {
  it("削除（リストの項目・最後の項目ならリストごと・前後の同じリストはつなぐ）", () => {
    expect(apply(SAMPLE, 1, deleteRow).markdown).toBe("# 題\n\n- 一\n- 二\n  - 子\n\n1. 一\n2. 二\n3. 三\n\n> 引用\n\n---\n");
    expect(apply(SAMPLE, 3, deleteRow).markdown).toContain("- 一\n\n1. 一");
    expect(apply("- 一\n\n段落\n\n* 二\n", 1, deleteRow).markdown).toBe("- 一\n- 二\n");
    expect(apply("- 一つだけ\n\n後\n", 0, deleteRow).markdown).toBe("後\n");
  });

  it("削除で隣り合った番号付きリストは、続きの数のときだけつなぐ（後ろの番号を消さない）", () => {
    expect(apply("1. A\n\n段落\n\n2. B\n", 1, deleteRow).markdown).toBe("1. A\n2. B\n");
    const separate = apply("1. A\n\n段落\n\n1. B\n", 1, deleteRow);
    const lists = (doc: typeof separate.tr.doc) =>
      Array.from({ length: doc.childCount }, (_, index) => doc.child(index)).map((node) => [node.type.name, node.attrs.start, node.textContent]);
    expect(lists(separate.tr.doc)).toEqual([
      ["orderedList", 1, "A"],
      ["orderedList", 1, "B"],
    ]);
    // 後ろのリストは区切りを変えて書き、読み直しても別のリスト（後ろは 1 から）のまま
    expect(separate.markdown).toContain("1) B");
    expect(lists(markdownToDoc(separate.markdown))).toEqual(lists(separate.tr.doc));
  });

  it("最後の 1 行を消したら空の段落を 1 つ残す", () => {
    const { tr } = apply("ひとつ\n", 0, deleteRow);
    expect(tr.doc.childCount).toBe(1);
    expect(tr.doc.firstChild?.type.name).toBe("paragraph");
    expect(tr.doc.textContent).toBe("");
  });

  it("複製（すぐ下に同じもの）", () => {
    expect(apply(SAMPLE, 0, duplicateRow).markdown.startsWith("# 題\n\n# 題\n\n本文")).toBe(true);
    expect(apply(SAMPLE, 3, duplicateRow).markdown).toContain("- 一\n- 二\n  - 子\n- 二\n  - 子\n");
  });

  it("テキストに戻す（見出し・項目・引用・コード・表。区切り線は対象外）", () => {
    expect(apply(SAMPLE, 0, turnRowIntoText).markdown.startsWith("題\n\n本文")).toBe(true);
    expect(apply("1. 一\n2. 二\n3. 三\n", 1, turnRowIntoText).markdown).toBe("1. 一\n\n二\n\n3. 三\n");
    expect(apply("- [ ] やること\n", 0, turnRowIntoText).markdown).toBe("やること\n");
    expect(apply("> 引用\n", 0, turnRowIntoText).markdown).toBe("引用\n");
    expect(apply("```\na\nb\n```\n", 0, turnRowIntoText).markdown).toBe("a\\\nb\n");
    const rows = listRows(markdownToDoc(SAMPLE));
    expect(canTurnRowIntoText(rows[rows.length - 1]!)).toBe(false);
    expect(canTurnRowIntoText(rows[0]!)).toBe(true);
  });

  it("＋: 行の下に「/」だけの段落を足し、カーソルを「/」の後ろに置く", () => {
    const top = apply("前\n\n後\n", 0, addSlashLineBelow);
    expect(top.markdown).toBe("前\n\n/\n\n後\n");
    expect(top.tr.selection.$from.parent.textContent).toBe("/");
    expect(top.tr.selection.$from.parentOffset).toBe(1);
  });

  it("＋: 項目の途中ならリストを分けて間に段落を入れる（番号付きは後ろの start を続きの数にする）", () => {
    expect(apply("1. 一\n2. 二\n3. 三\n", 0, addSlashLineBelow).markdown).toBe("1. 一\n\n/\n\n2. 二\n3. 三\n");
    expect(apply("- 一\n- 二\n", 1, addSlashLineBelow).markdown).toBe("- 一\n- 二\n\n/\n");
  });
});
