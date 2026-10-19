import { describe, expect, it } from "vitest";
import {
  CONVERSATION_SNAPSHOT_BUDGET_BYTES,
  COMPOSER_PAGES_MAX,
  composerChangedNote,
  composerFileNames,
  composerPageIds,
  finalizeMarkdown,
  fitPageSnapshots,
  markPageUndone,
  newDocumentTitle,
  pageSnapshotBytes,
  utf8ByteLength,
  type ConversationFile,
  type TurnPageChange,
} from "../src/index.js";

function conversation(pages: TurnPageChange[][]): ConversationFile {
  return {
    schemaVersion: 1,
    id: "conv-1",
    kind: "edit",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    runId: null,
    stepId: null,
    stepName: null,
    session: null,
    turns: pages.map((changes, index) => ({
      id: `turn-${index}`,
      at: "2026-10-17T00:00:00.000Z",
      input: "直して",
      pack: null,
      record: 0,
      items: [],
      reply: "",
      versions: [],
      pages: changes,
      notes: [],
      result: "done",
      reasonCode: null,
      message: null,
      durationMs: 0,
      provider: "claude",
      model: "m",
      effort: "medium",
      profile: "p",
      tokensKnown: true,
      inputTokens: 0,
      outputTokens: 0,
    })),
  };
}

describe("composer の共有の決まり（Mac と NIHO API が同じ値で動く）", () => {
  it("UTF-8 のバイト数は TextEncoder と同じ", () => {
    for (const text of ["", "abc", "日本語", "😀絵文字", "\ud800孤立", "é"]) {
      expect(utf8ByteLength(text), text).toBe(new TextEncoder().encode(text).length);
    }
  });

  it("保存の形は末尾の空白を除いて改行 1 つ（空なら空）", () => {
    expect(finalizeMarkdown("# 題\n\n本文  \n\n\n")).toBe("# 題\n\n本文\n");
    expect(finalizeMarkdown(" \n\t")).toBe("");
  });

  it("新しい文書の題は最初の行の「# 題名」、無ければファイル名", () => {
    expect(newDocumentTitle("summary.md", "\n# 夏のまとめ #\n本文")).toBe("夏のまとめ");
    expect(newDocumentTitle("summary-2.md", "本文だけ")).toBe("summary-2");
    expect(newDocumentTitle(".md", "")).toBe("新しい文書");
  });

  it("作業場所の文書ページは上限を超えたら開いているページを残す", () => {
    const ids = Array.from({ length: COMPOSER_PAGES_MAX + 5 }, (_, index) => `p${index}`);
    const kept = composerPageIds(ids, "p304");
    expect(kept.size).toBe(COMPOSER_PAGES_MAX);
    expect(kept.has("p304")).toBe(true);
    expect(kept.has("p299")).toBe(false);
    expect(composerPageIds(["a", "b"], "z")).toEqual(new Set(["a", "b"]));
  });

  it("作業の行のファイル名から画面の名前を引く", () => {
    expect(composerFileNames({ pages: [{ pageId: "doc1", name: "メモ" }], references: [{ pageId: "rec1", artifactId: "source", name: "取材 / 文字起こし" }] })).toEqual({
      pages: "文書ページのフォルダ",
      new: "新しい文書のフォルダ",
      reference: "ほかの録音の文書",
      "doc1.md": "メモ",
      "rec1.source.md": "取材 / 文字起こし",
    });
    expect(composerChangedNote("メモ")).toBe("メモは依頼の途中で変わったため、AI の変更を反映せず、今の内容を保ちました。");
  });

  it("控えの合計が上限を超えたら古い依頼の控えから外す", () => {
    const big = "あ".repeat(Math.ceil(CONVERSATION_SNAPSHOT_BUDGET_BYTES / 3 / 2) + 10);
    const fitted = fitPageSnapshots(conversation([
      [{ pageId: "a", title: "A", change: "edited", chars: 1, delta: 0, before: big, after: big }],
      [{ pageId: "b", title: "B", change: "edited", chars: 1, delta: 0, before: "前", after: "後" }],
    ]));
    expect(fitted.turns[0]!.pages![0]).toEqual({ pageId: "a", title: "A", change: "edited", chars: 1, delta: 0 });
    expect(fitted.turns[1]!.pages![0]!.before).toBe("前");
    expect(pageSnapshotBytes({ before: "前", after: "後" })).toBe(6);
  });

  it("元に戻した文書ページの変更に印を付ける", () => {
    const marked = markPageUndone(conversation([[{ pageId: "a", title: "A", change: "edited", chars: 1, delta: 0 }]]), "turn-0", "a", new Date("2026-10-17T01:00:00.000Z"));
    expect(marked.turns[0]!.pages![0]!.undone).toBe(true);
    expect(marked.updatedAt).toBe("2026-10-17T01:00:00.000Z");
  });
});
