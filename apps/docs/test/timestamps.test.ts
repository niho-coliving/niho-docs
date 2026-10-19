// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { Slice, Fragment } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import { setTimestampMode, TRANSCRIPT_TIMESTAMP_NODE } from "../src/lib/timestamps";
import {
  createEditor,
  cursorTo,
  destroyEditor,
  markdownOf,
  positionOf,
  press,
  typeText,
} from "./block-editor-helpers";

let editors: Editor[] = [];
function timestampEditor(markdown: string, shown = false): Editor {
  const editor = createEditor(markdown, { timestamps: true });
  editors.push(editor);
  setTimestampMode(editor, shown ? "shown" : "hidden");
  return editor;
}

afterEach(() => {
  for (const editor of editors) destroyEditor(editor);
  editors = [];
});

// 時刻の認識・往復・外し方・逐次表示（Markdown の側）は packages/docs-ui/src/editor/timestamps.test.ts。
// ここでは Mac のブロックのエディタと組んだときの編集・貼り付け・コピーを確かめる（#18876）。

describe("非破壊の編集と選択コピー", () => {
  it("通常文書は時刻風の行頭も専用 node にせず、従来どおり文字として編集する", () => {
    const editor = createEditor("[00:00:12] 普通のメモ\n");
    editors.push(editor);
    let timestamps = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === TRANSCRIPT_TIMESTAMP_NODE) timestamps++;
    });
    expect(timestamps).toBe(0);
    expect(markdownOf(editor)).toBe("[00:00:12] 普通のメモ\n");
  });

  it("OFF のまま本文を直しても正本の時刻を保ち、ON に戻せる", () => {
    const editor = timestampEditor("[00:00:12] 話者1: 本文\n");
    cursorTo(editor, positionOf(editor, "本文"));
    typeText(editor, "を修正");
    expect(markdownOf(editor)).toBe("[00:00:12] 話者1: 本文を修正\n");
    setTimestampMode(editor, "shown");
    expect(editor.view.dom.classList.contains("timestamps-on")).toBe(true);
    expect(editor.view.dom.querySelector(".transcript-timestamp")?.textContent).toContain("00:00:12");
  });

  it("React が editorProps や編集可否を更新しても表示選択を保つ", () => {
    const editor = timestampEditor("[00:00:12] 本文\n");
    editor.setOptions({ editorProps: { attributes: { class: "doc", "aria-label": "文書" } } });
    editor.setEditable(false);
    expect(editor.view.dom.classList.contains("timestamps-off")).toBe(true);
    setTimestampMode(editor, "shown");
    editor.setEditable(true);
    expect(editor.view.dom.classList.contains("timestamps-on")).toBe(true);
  });

  it("時刻付き HTML を通常文書へ貼ると、編集可能な文字に戻す", () => {
    const editor = createEditor();
    editors.push(editor);
    editor.view.pasteHTML('<p><span data-transcript-timestamp="true">[00:00:12] </span>貼り付け</p>', new Event("paste") as ClipboardEvent);
    expect(editor.state.doc.firstChild?.firstChild?.isText).toBe(true);
    expect(markdownOf(editor)).toBe("[00:00:12] 貼り付け\n");
  });

  it("ON/OFF のどちらでも貼り付けた段落先頭の時刻を専用 node にする", () => {
    for (const shown of [false, true]) {
      const editor = timestampEditor("", shown);
      editor.view.pasteText("[00:00:12] 貼り付け\n\n[00:00:24] 次の段落", new Event("paste") as ClipboardEvent);
      const timestamps: string[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === TRANSCRIPT_TIMESTAMP_NODE) timestamps.push(node.attrs.prefix as string);
      });
      expect(timestamps).toEqual(["[00:00:12] ", "[00:00:24] "]);
      expect(markdownOf(editor)).toBe("[00:00:12] 貼り付け\n\n[00:00:24] 次の段落\n");
    }
  });

  it("外部 HTML の任意の文字を時刻として隠さない", () => {
    const editor = timestampEditor("");
    editor.view.pasteHTML('<p><span data-transcript-timestamp="true" prefix="[00:00:12] ">残す本文</span></p>', new Event("paste") as ClipboardEvent);
    expect(markdownOf(editor)).toBe("残す本文\n");
    expect(editor.state.doc.firstChild?.firstChild?.isText).toBe(true);
  });

  it("本文先頭の Backspace と左側へのカーソル移動で時刻だけを壊さない", () => {
    const editor = timestampEditor("[00:00:12] 話者1: 本文\n");
    cursorTo(editor, positionOf(editor, "話者1", false));
    expect(press(editor, "Backspace")).toBe(true);
    expect(markdownOf(editor)).toBe("[00:00:12] 話者1: 本文\n");

    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)));
    expect(editor.state.selection.from).toBe(2);
    expect(markdownOf(editor)).toBe("[00:00:12] 話者1: 本文\n");
  });

  it("次の時刻付き段落の時刻が本文中へ移る Delete 結合を防ぐ", () => {
    const editor = timestampEditor("[00:00:01] 本文1\n\n[00:00:02] 本文2\n");
    cursorTo(editor, positionOf(editor, "本文1"));
    expect(press(editor, "Delete")).toBe(true);
    expect(markdownOf(editor)).toBe("[00:00:01] 本文1\n\n[00:00:02] 本文2\n");
  });

  it("行全体の削除と Undo は妨げない", () => {
    const editor = timestampEditor("[00:00:12] 一行目\n\n[00:00:24] 二行目\n");
    const from = positionOf(editor, "一行目", false) - 1;
    const to = positionOf(editor, "一行目");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)));
    editor.commands.deleteSelection();
    expect(markdownOf(editor)).toBe("\n[00:00:24] 二行目\n");
    editor.commands.undo();
    expect(markdownOf(editor)).toBe("[00:00:12] 一行目\n\n[00:00:24] 二行目\n");
  });

  it("OFF の選択コピーは hidden timestamp を Slice に混ぜない", () => {
    const editor = timestampEditor("[00:00:12] 話者1: 本文\n");
    let copied = new Slice(Fragment.empty, 0, 0);
    const source = editor.state.doc.slice(0, editor.state.doc.content.size);
    editor.view.someProp("transformCopied", (transform) => {
      copied = transform(source, editor.view);
      return copied;
    });
    expect(copied.content.textBetween(0, copied.content.size, "\n")).toBe("話者1: 本文");

    setTimestampMode(editor, "shown");
    let shown = source;
    editor.view.someProp("transformCopied", (transform) => {
      shown = transform(source, editor.view);
      return shown;
    });
    expect(shown.content.firstChild?.firstChild?.type.name).toBe(TRANSCRIPT_TIMESTAMP_NODE);
  });
});
