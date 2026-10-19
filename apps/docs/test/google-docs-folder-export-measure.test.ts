import { describe, expect, it } from "vitest";

import type { DocsDriveFolderExportNode } from "../src/lib/bridge";
import { measureFolderExportSelection } from "../src/lib/google-docs-folder-export";

// 録音の表紙の字数は、plan では全部の成果物へのリンクを含む（API の表紙は「見出し + 日時 + 長さ + 選んだ子へのリンク」）。
// 外した成果物のリンク（題名 + 改行）の分は、画面の字数の目安からも引く（API の measureFolderExportSelection と合わせる）。
const nodes: DocsDriveFolderExportNode[] = [
  { key: "rec:rec1", kind: "recording", title: "朝市の録音", parentKey: null, chars: 100, defaultSelected: true },
  { key: "step:rec1:fix", kind: "step", title: "修正版", parentKey: "rec:rec1", chars: 1_000, charsWithoutTimestamps: 800, defaultSelected: true },
  { key: "cand:rec1:article:a", kind: "candidate", title: "記事 / 別案 1", parentKey: "rec:rec1", chars: 300, defaultSelected: true },
  { key: "doc:memo", kind: "document", title: "取材メモ", parentKey: null, chars: 50, defaultSelected: true },
];

describe("measureFolderExportSelection", () => {
  it("全部選べば plan の字数の合計のまま", () => {
    expect(measureFolderExportSelection(nodes, new Set(nodes.map((node) => node.key)), true)).toEqual({ tabs: 4, chars: 100 + 1_000 + 300 + 50 });
  });

  it("成果物を外すと、その成果物の字数と、録音の表紙のその成果物へのリンク（題名 + 改行）の分を引く", () => {
    const selected = new Set(["rec:rec1", "step:rec1:fix", "doc:memo"]);
    // 外した「記事 / 別案 1」(9 字): 本文 300 は入らず、表紙のリンクの行 9 + 1 = 10 字も減る
    expect(measureFolderExportSelection(nodes, selected, true)).toEqual({ tabs: 3, chars: 100 - 10 + 1_000 + 50 });
  });

  it("録音を外したときは、その表紙の字数は数えない（外した成果物の分を二重に引かない）", () => {
    const selected = new Set(["doc:memo"]);
    expect(measureFolderExportSelection(nodes, selected, true)).toEqual({ tabs: 1, chars: 50 });
  });

  it("タイムスタンプを外すと、時刻を外した字数を使う", () => {
    const selected = new Set(["rec:rec1", "step:rec1:fix", "cand:rec1:article:a"]);
    expect(measureFolderExportSelection(nodes, selected, false)).toEqual({ tabs: 3, chars: 100 + 800 + 300 });
  });
});
