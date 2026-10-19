import { describe, expect, it } from "vitest";
import { collapseDiff, diffLines, diffSummary } from "../src/index.js";

describe("行の差分（変更を見る）", () => {
  it("同じ・足した・消した を並べる", () => {
    const before = "# とても長い見出し\n\n本文の段落です。\n\n二段落目。\n";
    const after = "# 短い見出し\n\n本文の段落です。\n";
    expect(diffLines(before, after)).toEqual([
      { kind: "removed", text: "# とても長い見出し" },
      { kind: "added", text: "# 短い見出し" },
      { kind: "same", text: "" },
      { kind: "same", text: "本文の段落です。" },
      { kind: "removed", text: "" },
      { kind: "removed", text: "二段落目。" },
    ]);
    expect(diffSummary(diffLines(before, after))).toEqual({ places: 2, added: 1, removed: 3 });
  });

  it("同じ文書は差分なし。空からは全部足した", () => {
    expect(diffLines("a\nb\n", "a\nb\n").every((line) => line.kind === "same")).toBe(true);
    expect(diffSummary(diffLines("a\nb\n", "a\nb\n")).places).toBe(0);
    expect(diffLines("", "a\nb")).toEqual([
      { kind: "added", text: "a" },
      { kind: "added", text: "b" },
    ]);
    // 改行の違い（CRLF）は同じ行とみなす
    expect(diffSummary(diffLines("a\r\nb\r\n", "a\nb\n")).places).toBe(0);
  });

  it("途中の 1 行だけの変更は 1 か所。大きな文書も最長共通部分列で揃う", () => {
    const lines = Array.from({ length: 400 }, (_, index) => `段落 ${index}`);
    const changed = [...lines];
    changed[200] = "段落 200（直した）";
    const diff = diffLines(lines.join("\n"), changed.join("\n"));
    expect(diffSummary(diff)).toEqual({ places: 1, added: 1, removed: 1 });
    expect(diff.filter((line) => line.kind === "same")).toHaveLength(399);
  });

  it("変わった行の前後だけを残し、間を畳む", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const after = ["a", "b", "c", "D", "e", "f", "g", "h"].join("\n");
    expect(collapseDiff(diffLines(before, after), 1)).toEqual([
      { kind: "skip", count: 2 },
      { kind: "same", text: "c" },
      { kind: "removed", text: "d" },
      { kind: "added", text: "D" },
      { kind: "same", text: "e" },
      { kind: "skip", count: 3 },
    ]);
  });
});
