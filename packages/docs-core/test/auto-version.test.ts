import { describe, expect, it } from "vitest";
import {
  DOCS_AUTO_VERSION_IDLE_MS,
  DOCS_AUTO_VERSION_REASONS,
  autoVersionDelay,
  autoVersionDueAt,
  sameVersionContent,
  shouldCreateAutoVersion,
} from "../src/index.js";

describe("版を自動で残す時の判定（#18912・spec niho-docs-cloud §8.2）", () => {
  it("編集のまとまりの区切りは 10 分。理由は 4 つ", () => {
    expect(DOCS_AUTO_VERSION_IDLE_MS).toBe(600_000);
    expect(DOCS_AUTO_VERSION_REASONS).toEqual(["idle", "leave", "before_ai", "before_restore"]);
  });

  it("この端末で版の後に編集があり、空でなく、最新の版と違うときだけ作る", () => {
    expect(shouldCreateAutoVersion({ editedSinceVersion: true, current: "# 直した\n", latestVersion: "# 元\n" })).toBe(true);
    // 編集が無い（リモートの適用・AI の書き換え・開いた直後の整形だけ）
    expect(shouldCreateAutoVersion({ editedSinceVersion: false, current: "# 直した\n", latestVersion: "# 元\n" })).toBe(false);
    // 空の文書は版にしない
    expect(shouldCreateAutoVersion({ editedSinceVersion: true, current: "  \n\n", latestVersion: "# 元\n" })).toBe(false);
    expect(shouldCreateAutoVersion({ editedSinceVersion: true, current: "", latestVersion: null })).toBe(false);
    // 最新の版と同じ中身（直して元に戻した・自動保存しただけ）は作らない
    expect(shouldCreateAutoVersion({ editedSinceVersion: true, current: "# 元\n", latestVersion: "# 元\n" })).toBe(false);
  });

  it("版がまだ無い文書は、編集があり空でなければ作る", () => {
    expect(shouldCreateAutoVersion({ editedSinceVersion: true, current: "はじめての本文", latestVersion: null })).toBe(true);
  });

  it("中身は保存する形（末尾の空白・改行）にそろえて比べる。殻の正規化を渡せばそれで比べる", () => {
    expect(sameVersionContent("本文\n\n\n", "本文")).toBe(true);
    expect(sameVersionContent("本文\n", "本文を直した\n")).toBe(false);
    expect(shouldCreateAutoVersion({ editedSinceVersion: true, current: "本文  \n\n", latestVersion: "本文\n" })).toBe(false);
    // 見た目が同じ書き方の違い（「*」と「-」の箇条書き）を同じとみなす比べ方
    const isChanged = (current: string, latest: string) => current.replace(/^\* /gmu, "- ") !== latest.replace(/^\* /gmu, "- ");
    expect(shouldCreateAutoVersion({ editedSinceVersion: true, current: "* a\n* b\n", latestVersion: "- a\n- b\n", isChanged })).toBe(false);
    expect(shouldCreateAutoVersion({ editedSinceVersion: true, current: "* a\n* c\n", latestVersion: "- a\n- b\n", isChanged })).toBe(true);
    // 空の判定は比べ方より先
    expect(shouldCreateAutoVersion({ editedSinceVersion: true, current: "\n", latestVersion: "- a\n", isChanged: () => true })).toBe(false);
  });

  it("idle の時刻は最後の入力から 10 分。待ちは過ぎていれば 0", () => {
    const lastEditAt = Date.UTC(2026, 9, 18, 9, 0, 0);
    expect(autoVersionDueAt(lastEditAt)).toBe(lastEditAt + 600_000);
    expect(autoVersionDueAt(lastEditAt, 1_000)).toBe(lastEditAt + 1_000);
    expect(autoVersionDelay(lastEditAt, lastEditAt)).toBe(600_000);
    expect(autoVersionDelay(lastEditAt, lastEditAt + 599_000)).toBe(1_000);
    expect(autoVersionDelay(lastEditAt, lastEditAt + 700_000)).toBe(0);
  });
});
