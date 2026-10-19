// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { TextSelection } from "@tiptap/pm/state";
import { filterBlockTypes, setLineType } from "../src/lib/block-editor/blocks";
import { slashMenuStore } from "../src/lib/block-editor/slash";
import {
  MOD,
  createEditor,
  cursorTo,
  destroyEditor,
  flush,
  markdownOf,
  positionOf,
  press,
  topTypes,
  typeText,
} from "./block-editor-helpers";

let editors: Editor[] = [];
function editorWith(markdown = ""): Editor {
  const editor = createEditor(markdown);
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors) destroyEditor(editor);
  editors = [];
});

describe("行頭の Markdown（半角・全角）", () => {
  it.each([
    ["# ", "# 本文\n"],
    ["＃　", "# 本文\n"],
    ["## ", "## 本文\n"],
    ["＃＃ ", "## 本文\n"],
    ["### ", "### 本文\n"],
    ["＃＃＃ ", "### 本文\n"],
    ["- ", "- 本文\n"],
    ["* ", "- 本文\n"],
    ["+ ", "- 本文\n"],
    ["・ ", "- 本文\n"],
    ["－　", "- 本文\n"],
    ["＊ ", "- 本文\n"],
    ["1. ", "1. 本文\n"],
    ["３．　", "3. 本文\n"],
    ["12. ", "12. 本文\n"],
    ["[]", "- [ ] 本文\n"],
    ["[] ", "- [ ] 本文\n"],
    ["[ ]", "- [ ] 本文\n"],
    ["[x]", "- [x] 本文\n"],
    ["［］", "- [ ] 本文\n"],
    ["> ", "> 本文\n"],
    ["＞　", "> 本文\n"],
    ["```", "```\n本文\n```\n"],
    ["｀｀｀", "```\n本文\n```\n"],
  ])("「%s」", (start, expected) => {
    const editor = editorWith();
    typeText(editor, start);
    typeText(editor, "本文");
    expect(markdownOf(editor)).toBe(expected);
  });

  it.each(["---", "ーーー", "－－－"])("「%s」は区切り線にし、下の空の段落にカーソルを置く", (start) => {
    const editor = editorWith();
    typeText(editor, start);
    expect(topTypes(editor)).toEqual(["horizontalRule", "paragraph"]);
    typeText(editor, "続き");
    expect(markdownOf(editor)).toBe("---\n\n続き\n");
  });

  it("区切り線は行がそれだけのときだけ（後ろに文字のある行・4 つ目の # は文字のまま）", () => {
    const editor = editorWith("後ろ");
    cursorTo(editor, 1);
    typeText(editor, "---");
    expect(topTypes(editor)).toEqual(["paragraph"]);
    const heading = editorWith();
    typeText(heading, "#### 見出し");
    expect(markdownOf(heading)).toBe("\\#### 見出し\n");
  });

  it("リストの項目の中で `- ` を打っても入れ子にしない", () => {
    const editor = editorWith("- 項目");
    cursorTo(editor, positionOf(editor, "項目", false));
    typeText(editor, "- ");
    expect(markdownOf(editor)).toBe("- \\- 項目\n");
  });

  it("前が同じ種類のリストならつなぐ（番号付きは続きの数のときだけ）", () => {
    const bullet = editorWith("- 一つ目\n\n段落");
    bullet.commands.deleteRange({ from: positionOf(bullet, "段落", false), to: positionOf(bullet, "段落") });
    typeText(bullet, "- 二つ目");
    expect(markdownOf(bullet)).toBe("- 一つ目\n- 二つ目\n");

    const ordered = editorWith("1. 一\n2. 二\n\n段落");
    ordered.commands.deleteRange({ from: positionOf(ordered, "段落", false), to: positionOf(ordered, "段落") });
    typeText(ordered, "3. 三");
    expect(markdownOf(ordered)).toBe("1. 一\n2. 二\n3. 三\n");

    const restart = editorWith("1. 一\n\n段落");
    restart.commands.deleteRange({ from: positionOf(restart, "段落", false), to: positionOf(restart, "段落") });
    typeText(restart, "1. 別");
    expect(topTypes(restart)).toEqual(["orderedList", "orderedList", "paragraph"]);
  });

  it("日本語入力で確定した記号（compositionend）でも効く", async () => {
    const editor = editorWith();
    editor.view.dispatch(editor.state.tr.insertText("＃　"));
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "＃　", bubbles: true }));
    await flush();
    // 最後が段落でないときは、TrailingNode が空の段落を足す
    expect(topTypes(editor)).toEqual(["heading", "paragraph"]);
    expect(editor.state.doc.firstChild?.textContent).toBe("");

    const inline = editorWith("これは");
    inline.view.dispatch(inline.state.tr.insertText("＊＊太字＊＊"));
    inline.view.dom.dispatchEvent(new CompositionEvent("compositionend", { data: "＊＊太字＊＊", bubbles: true }));
    await flush();
    expect(markdownOf(inline)).toBe("これは**太字**\n");
  });
});

describe("行の中の書式", () => {
  it.each([
    ["これは**太字**です", "これは**太字**です\n"],
    ["これは＊＊太字＊＊です", "これは**太字**です\n"],
    ["これは*斜体*です", "これは*斜体*です\n"],
    ["これは＊斜体＊です", "これは*斜体*です\n"],
    ["これは~~取り消し~~です", "これは~~取り消し~~です\n"],
    ["これは～～取り消し～～です", "これは~~取り消し~~です\n"],
    ["これは〜〜取り消し〜〜です", "これは~~取り消し~~です\n"],
    ["これは`code`です", "これは`code`です\n"],
    ["これは｀code｀です", "これは`code`です\n"],
  ])("「%s」", (typed, expected) => {
    const editor = editorWith();
    typeText(editor, typed);
    expect(markdownOf(editor)).toBe(expected);
  });

  it("`**` の途中で斜体にならず、閉じたら太字になる。書式の後に打った文字は書式に入らない", () => {
    const editor = editorWith();
    typeText(editor, "**太字*");
    expect(editor.state.doc.textContent).toBe("**太字*");
    expect(markdownOf(editor)).not.toContain("*太字*\n");
    typeText(editor, "*の後");
    expect(markdownOf(editor)).toBe("**太字**の後\n");
  });

  it("空白で始まる中身・コードブロックの中・コードの mark の上では効かない", () => {
    const spaced = editorWith();
    typeText(spaced, "2 * 3 * 4");
    expect(spaced.state.doc.textContent).toBe("2 * 3 * 4");
    const code = editorWith("```\nx\n```");
    typeText(code, "**太字**");
    expect(markdownOf(code)).toBe("```\nx**太字**\n```\n");
  });

  it("⌘B・⌘I・⌘⇧S・⌘E で書式を付ける", () => {
    const editor = editorWith("あいうえお");
    editor.commands.setTextSelection({ from: 1, to: 3 });
    expect(press(editor, "b", MOD)).toBe(true);
    expect(markdownOf(editor)).toBe("**あい**うえお\n");
    editor.commands.setTextSelection({ from: 3, to: 4 });
    press(editor, "i", MOD);
    editor.commands.setTextSelection({ from: 4, to: 5 });
    press(editor, "s", { ...MOD, shiftKey: true });
    editor.commands.setTextSelection({ from: 5, to: 6 });
    press(editor, "e", MOD);
    expect(markdownOf(editor)).toBe("**あい***う*~~え~~`お`\n");
  });
});

describe("Enter と Backspace", () => {
  it("リスト・チェックは次の項目、空の項目で押すとテキストに戻る", () => {
    const editor = editorWith("- 一つ目");
    press(editor, "Enter");
    typeText(editor, "二つ目");
    expect(markdownOf(editor)).toBe("- 一つ目\n- 二つ目\n");
    press(editor, "Enter");
    press(editor, "Enter");
    typeText(editor, "段落");
    expect(markdownOf(editor)).toBe("- 一つ目\n- 二つ目\n\n段落\n");

    const task = editorWith("- [x] 済み");
    press(task, "Enter");
    typeText(task, "次");
    expect(markdownOf(task)).toBe("- [x] 済み\n- [ ] 次\n");
  });

  it("引用の中の Enter は引用の外に新しい段落、空の引用の行なら引用を抜ける", () => {
    const editor = editorWith("> 引用の文");
    cursorTo(editor, positionOf(editor, "引用の"));
    press(editor, "Enter");
    typeText(editor, "外");
    expect(markdownOf(editor)).toBe("> 引用の\n\n外文\n");

    const empty = editorWith();
    typeText(empty, "> ");
    press(empty, "Enter");
    expect(topTypes(empty)).toEqual(["paragraph", "paragraph"]);
  });

  it("Shift+Enter は行の中の改行、コードの中の Enter は改行", () => {
    const editor = editorWith("一行目");
    press(editor, "Enter", { shiftKey: true });
    typeText(editor, "二行目");
    expect(markdownOf(editor)).toBe("一行目\\\n二行目\n");

    const code = editorWith("```\na\n```");
    press(code, "Enter");
    typeText(code, "b");
    expect(markdownOf(code)).toBe("```\na\nb\n```\n");
  });

  it("行頭の Backspace: 見出し→段落、項目→持ち上げて段落、引用→外へ、区切り線の後→区切り線を消す", () => {
    const heading = editorWith("## 見出し");
    cursorTo(heading, 1);
    press(heading, "Backspace");
    expect(markdownOf(heading)).toBe("見出し\n");

    const list = editorWith("- 一\n- 二\n- 三");
    cursorTo(list, positionOf(list, "二", false));
    press(list, "Backspace");
    expect(markdownOf(list)).toBe("- 一\n\n二\n\n- 三\n");

    const task = editorWith("- [ ] やること");
    cursorTo(task, positionOf(task, "やること", false));
    press(task, "Backspace");
    expect(markdownOf(task)).toBe("やること\n");

    const quote = editorWith("> 引用");
    cursorTo(quote, positionOf(quote, "引用", false));
    press(quote, "Backspace");
    expect(markdownOf(quote)).toBe("引用\n");

    const divider = editorWith("前\n\n---\n\n後");
    cursorTo(divider, positionOf(divider, "後", false));
    press(divider, "Backspace");
    expect(markdownOf(divider)).toBe("前\n\n後\n");
  });

  it("書き始めで作った見出しの Backspace は「# 」の文字を戻さずに段落に戻す", () => {
    const editor = editorWith();
    typeText(editor, "# ");
    press(editor, "Backspace");
    expect(topTypes(editor)).toEqual(["paragraph", "paragraph"]);
    expect(editor.state.doc.textContent).toBe("");
  });
});

describe("「/」のメニュー", () => {
  it("複数行の選択の途中のコードブロックも、改行を行の中の改行にして段落にする", () => {
    const editor = editorWith("前\n\n```\na\nb\n```\n\n後\n");
    const from = positionOf(editor, "前", false);
    const to = positionOf(editor, "後");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
    editor.chain().command(setLineType("paragraph")).run();
    expect(topTypes(editor)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(markdownOf(editor)).toBe("前\n\na\\\nb\n\n後\n");
  });

  it("絞り込み（名前・別名・書き始め・全角）", () => {
    expect(filterBlockTypes("")).toHaveLength(10);
    expect(filterBlockTypes("見出し").map((type) => type.id)).toEqual(["h1", "h2", "h3"]);
    expect(filterBlockTypes("h2").map((type) => type.id)).toEqual(["h2"]);
    expect(filterBlockTypes("ｈ２").map((type) => type.id)).toEqual(["h2"]);
    expect(filterBlockTypes("##").map((type) => type.id)).toEqual(["h2"]);
    expect(filterBlockTypes("みだし").map((type) => type.id)).toEqual(["h1", "h2", "h3"]);
    expect(filterBlockTypes("Todo").map((type) => type.id)).toEqual(["task"]);
    expect(filterBlockTypes("くぎり").map((type) => type.id)).toEqual(["hr"]);
    expect(filterBlockTypes("zzz")).toEqual([]);
  });

  it("空の行では行の種類を変える（↓・Enter で決める）", async () => {
    const editor = editorWith();
    const store = slashMenuStore(editor);
    typeText(editor, "/");
    await flush();
    expect(store.getSnapshot()?.items).toHaveLength(10);
    expect(press(editor, "ArrowDown")).toBe(true);
    expect(store.getSnapshot()?.index).toBe(1);
    expect(press(editor, "Enter")).toBe(true);
    await flush();
    expect(store.getSnapshot()).toBeNull();
    expect(topTypes(editor)).toEqual(["heading", "paragraph"]);
    expect(editor.state.doc.textContent).toBe("");
  });

  it("空でない行では下に新しい行をその種類で足し、カーソルを移す", async () => {
    const editor = editorWith("前の行");
    typeText(editor, "/箇条");
    await flush();
    expect(slashMenuStore(editor).getSnapshot()?.items.map((type) => type.id)).toEqual(["bullet"]);
    press(editor, "Enter");
    typeText(editor, "新しい項目");
    expect(markdownOf(editor)).toBe("前の行\n\n- 新しい項目\n");
  });

  it("新しく足したリストは前の同じ種類のリストにつなぐ", async () => {
    const editor = editorWith("- 一つ目");
    typeText(editor, "/");
    await flush();
    slashMenuStore(editor).choose(filterBlockTypes("").findIndex((type) => type.id === "bullet"));
    await flush();
    typeText(editor, "二つ目");
    expect(markdownOf(editor)).toBe("- 一つ目\n- 二つ目\n");
  });

  it("区切り線: 空の行は置き換えて下に空の段落、空でない行は下に足す", async () => {
    const empty = editorWith();
    typeText(empty, "/くぎり");
    await flush();
    press(empty, "Enter");
    typeText(empty, "続き");
    expect(markdownOf(empty)).toBe("---\n\n続き\n");

    const filled = editorWith("本文");
    typeText(filled, "/hr");
    await flush();
    press(filled, "Tab");
    typeText(filled, "続き");
    expect(markdownOf(filled)).toBe("本文\n\n---\n\n続き\n");
  });

  it("「／」でも開き、Esc で閉じる。0 件ならキーを横取りしない", async () => {
    const editor = editorWith();
    const store = slashMenuStore(editor);
    typeText(editor, "／");
    await flush();
    expect(store.getSnapshot()?.items).toHaveLength(10);
    expect(press(editor, "Escape")).toBe(true);
    await flush();
    expect(store.getSnapshot()).toBeNull();
    // 閉じた後に続けて打っても開き直さない
    typeText(editor, "h");
    await flush();
    expect(store.getSnapshot()).toBeNull();

    const none = editorWith();
    typeText(none, "/zzz");
    await flush();
    expect(slashMenuStore(none).getSnapshot()?.items ?? []).toHaveLength(0);
    expect(press(none, "ArrowDown")).toBe(false);
  });

  it("空白で閉じ、日本語入力の変換中のキーは横取りしない", async () => {
    const editor = editorWith();
    const store = slashMenuStore(editor);
    typeText(editor, "/");
    await flush();
    expect(store.keyDown(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }))).toBe(false);
    expect(store.keyDown(new KeyboardEvent("keydown", { key: "ArrowDown", keyCode: 229 }))).toBe(false);
    expect(store.getSnapshot()?.index).toBe(0);
    typeText(editor, " ");
    await flush();
    expect(store.getSnapshot()).toBeNull();
  });

  it("コードブロック・表の中では開かない", async () => {
    const code = editorWith("```\nx\n```");
    typeText(code, "/");
    await flush();
    expect(slashMenuStore(code).getSnapshot()).toBeNull();

    const table = editorWith("| a | b |\n| --- | --- |\n| 1 | 2 |");
    typeText(table, "/");
    await flush();
    expect(slashMenuStore(table).getSnapshot()).toBeNull();
  });
});
