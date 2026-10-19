/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { createDocsMarkdown } from "./markdown";
import { literalQuery, replaceMatch, searchMatches } from "./search";

// 検索と置き換えは Mac（apps/docs/src/lib/block-editor/search.ts）と Web（apps/web/app/app/docs/_lib/docs-editor/search.ts）が
// 同じものを使う。それぞれの schema（Mac は時刻の node あり、Web はなし）の文書で確かめる。
describe.each([
  ["Mac の引数", createDocsMarkdown({ transcriptTimestamps: true })],
  ["Web の引数", createDocsMarkdown({ transcriptTimestamps: false })],
])("docs literal search and replace（%s）", (_name, { docToMarkdown, markdownToDoc }) => {
  it("正規表現の記号を文字として探し、$&を展開せず一つのtransactionで全件置換する", () => {
    const state = EditorState.create({ doc: markdownToDoc("a.b と a.b。ab は別。\n") });
    const matches = searchMatches(state, literalQuery("a.b"));
    expect(matches).toHaveLength(2);
    let transaction = state.tr;
    for (let index = matches.length - 1; index >= 0; index--) transaction = replaceMatch(transaction, matches[index]!, "$&");
    expect(docToMarkdown(transaction.doc)).toContain("$& と $&。ab は別。");
  });
});
