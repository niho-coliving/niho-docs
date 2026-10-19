/** @vitest-environment jsdom */

import { Editor } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { createDocsMarkdown, markdownHasTimestamps, markdownWithoutTimestamps, renderTranscriptMarkdown } from "./markdown";
import { normalizeTranscriptTimestamps, TRANSCRIPT_TIMESTAMP_NODE } from "./timestamps";

// Mac と Web が同じ時刻 node を使う。エディタの編集・貼り付け・コピーは Mac の apps/docs/test/timestamps.test.ts にある。
const { canonicalMarkdown, docToMarkdown, markdownToDoc } = createDocsMarkdown({ transcriptTimestamps: true });

describe("時刻の共通認識", () => {
  const markdown = [
    "[00:00:12] 話者1: 本文の 12:30 と [00:09:09] は残す。",
    "",
    "[123:45:56] [リンク](https://example.com/12:30) と `12:30`。",
    "",
    "`[00:00:01] inline code`",
    "",
    "```text",
    "[00:00:02] code fence",
    "```",
    "",
    "| 時刻 | 内容 |",
    "| --- | --- |",
    "| [00:00:03] | 表 |",
    "",
  ].join("\n");

  it("最上位の段落先頭だけを node にし、往復では正本を保つ", () => {
    const doc = markdownToDoc(markdown, true);
    let timestamps = 0;
    doc.descendants((node) => {
      if (node.type.name === TRANSCRIPT_TIMESTAMP_NODE) timestamps++;
    });
    expect(timestamps).toBe(2);
    expect(docToMarkdown(doc)).toBe(canonicalMarkdown(markdown).trimEnd());
    expect(markdownHasTimestamps(markdown)).toBe(true);
  });

  it("Web の時刻は頭出し用の押し先にせず、正本の時刻を保つ", () => {
    const web = createDocsMarkdown({ transcriptTimestamps: true, timestampSeekEnabled: false });
    const source = "[00:00:12] 本文。\n";
    const doc = web.markdownToDoc(source, true);
    const container = document.createElement("div");
    container.appendChild(DOMSerializer.fromSchema(web.markdownSchema).serializeFragment(doc.content));
    const time = container.querySelector("[data-transcript-timestamp]");
    expect(time?.textContent).toBe("[00:00:12] ");
    expect(time?.hasAttribute("role")).toBe(false);
    expect(time?.hasAttribute("tabindex")).toBe(false);
    expect(web.docToMarkdown(doc)).toBe(source.trimEnd());
  });

  it("時刻付き成果物へ変わったとき、既存の本文をnode化して選択位置を保つ", () => {
    const web = createDocsMarkdown({ transcriptTimestamps: true, timestampSeekEnabled: false });
    const source = "[00:00:12] 本文。\n";
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: web.buildEditorExtensions(),
      content: web.markdownToDoc(source, false).toJSON(),
    });
    try {
      const oldPosition = 1 + "[00:00:12] ".length + 1;
      editor.commands.setTextSelection(oldPosition);
      const selectionBefore = editor.state.selection.from;
      const documentSizeBefore = editor.state.doc.nodeSize;
      normalizeTranscriptTimestamps(editor);
      expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe(TRANSCRIPT_TIMESTAMP_NODE);
      expect(editor.state.doc.nodeSize).toBe(documentSizeBefore - "[00:00:12] ".length + 1);
      expect(editor.state.selection.from).toBe(selectionBefore - "[00:00:12] ".length + 1);
      expect(web.docToMarkdown(editor.state.doc)).toBe(source.trimEnd());
    } finally {
      editor.destroy();
    }
  });

  it("OFF は正しい接頭辞だけを外し、話者・本文中の時刻・リンク・コード・表を保つ", () => {
    const hidden = markdownWithoutTimestamps(markdown);
    expect(hidden).toBe(markdown.replace("[00:00:12] ", "").replace("[123:45:56] ", ""));
    expect(hidden).toContain("話者1: 本文の 12:30 と [00:09:09] は残す。");
    expect(hidden).toContain("[リンク](https://example.com/12:30)");
    expect(hidden).toContain("`[00:00:01] inline code`");
    expect(hidden).toContain("[00:00:02] code fence");
    expect(hidden).toContain("| [00:00:03] | 表 |");
  });

  it("逐次表示も ON は時刻の文字つきの span、OFF は文字なしの span（頭出しの押し先だけ）にする", () => {
    const line = "[00:00:12] 話者1: 12:30 に開始。\n";
    const visibleText = (html: string) => html.replace(/<[^>]*>/g, "");
    expect(renderTranscriptMarkdown(line, true)).toContain('class="transcript-timestamp"');
    expect(renderTranscriptMarkdown(line, true)).toContain("話者1: 12:30 に開始。");
    expect(visibleText(renderTranscriptMarkdown(line, true))).toContain("[00:00:12]");
    const hidden = renderTranscriptMarkdown(line, false);
    // 見える文字には時刻を出さない（コピーにも混ざらない）が、頭出しの押し先は残す（実行中も段落から頭出しできる）
    expect(visibleText(hidden)).not.toContain("00:00:12");
    expect(visibleText(hidden)).toContain("話者1: 12:30 に開始。");
    expect(hidden).toContain('data-transcript-seek-seconds="12"');
    expect(hidden).toContain('role="button"');
    expect(hidden).toContain('aria-label="[00:00:12]から頭出し"');
  });

  it("エスケープされた時刻風の文字は、表示と書き出しのどちらでも隠さない", () => {
    const literal = "\\[00:00:12] これは普通の文字。\n";
    const doc = markdownToDoc(literal, true);
    expect(doc.firstChild?.firstChild?.isText).toBe(true);
    expect(markdownHasTimestamps(literal)).toBe(false);
    expect(markdownWithoutTimestamps(literal)).toBe(literal);
    expect(renderTranscriptMarkdown(literal, true)).not.toContain("transcript-timestamp");
    expect(renderTranscriptMarkdown(literal, false)).toContain("[00:00:12]");
  });
});
