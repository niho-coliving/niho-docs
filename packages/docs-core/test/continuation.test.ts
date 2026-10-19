import { describe, expect, it } from "vitest";
import {
  CONTINUATION_INSTRUCTION,
  CONTINUATION_MAX_OVERLAP,
  CONTINUATION_MIN_OVERLAP,
  buildFreshContinuationPrompt,
  continuationOverlap,
  joinContinuation,
} from "../src/index.js";

describe("joinContinuation", () => {
  it("重なりが無ければそのまま繋ぐ", () => {
    expect(joinContinuation("前の文。", "次の文。")).toBe("前の文。次の文。");
  });

  it("末尾と先頭の重なり（最長一致）を除く", () => {
    expect(joinContinuation("段落の最後の文です。\n\n## 見出", "## 見出し\n\n本文")).toBe("段落の最後の文です。\n\n## 見出し\n\n本文");
    // 最長の一致を選ぶ（「です。」だけでなく、前の文ごと重なっている）
    expect(joinContinuation("一文目です。二文目です。", "二文目です。三文目です。")).toBe("一文目です。二文目です。三文目です。");
    // 続きが前の出力の末尾をまるごと繰り返したときは何も足さない
    expect(joinContinuation("見出し\n本文の続き", "本文の続き")).toBe("見出し\n本文の続き");
  });

  it("S0 #18381 の 5 で実測した重なり（5 字）を除く", () => {
    expect(joinContinuation("43: 四十三\n44: 四十四\n45: 四十", "5: 四十五\n46: 四十六")).toBe(
      "43: 四十三\n44: 四十四\n45: 四十五\n46: 四十六",
    );
  });

  it(`${CONTINUATION_MIN_OVERLAP - 1} 字以下の一致は偶然とみなして除かない（本文を黙って欠かさない）`, () => {
    expect(CONTINUATION_MIN_OVERLAP).toBe(4);
    // 「そうそう」の途中で止まり、続きが重なり無しで始まった
    expect(joinContinuation("いい天気です。そう", "そうですね。")).toBe("いい天気です。そうそうですね。");
    expect(joinContinuation("ささ", "さやか")).toBe("さささやか");
    // 本当に 3 字以下を言い直したときは重なりが見えたまま残る（欠けはしない）
    expect(joinContinuation("結論とし", "として、まとめます。")).toBe("結論としとして、まとめます。");
  });

  it("空白だけの一致は段落の区切りなので除かない", () => {
    expect(joinContinuation("段落。\n\n\n\n", "\n\n\n\n次の段落。")).toBe("段落。\n\n\n\n\n\n\n\n次の段落。");
    // 空白を含んでも、文字のある重なりは除く
    expect(joinContinuation("段落。\n\n## 見出", "\n\n## 見出し")).toBe("段落。\n\n## 見出し");
  });

  it("重なりは最大 400 字まで", () => {
    const repeated = "あ".repeat(CONTINUATION_MAX_OVERLAP + 50);
    const joined = joinContinuation(`前${repeated}`, `${repeated}後`);
    // 400 字を超える重なりは 400 字だけ除く
    expect(joined.length).toBe(1 + repeated.length + (repeated.length - CONTINUATION_MAX_OVERLAP) + 1);
    // 上限より長い重なりは見ない
    expect(joinContinuation("xabcd", "abcde", 3)).toBe("xabcdabcde");
    expect(joinContinuation("xabcd", "abcde")).toBe("xabcde");
  });

  it("字数はコードポイントで数える（絵文字も 1 字。crate の char と同じ）", () => {
    // 3 字の重なり（A😀B）は偶然とみなして除かない
    expect(joinContinuation("xA😀B", "A😀B続き")).toBe("xA😀BA😀B続き");
    expect(continuationOverlap("xA😀BC", "A😀BC続き")).toBe(4);
    // 上限の 400 字は絵文字でも 400 個
    const emoji = "😀".repeat(CONTINUATION_MAX_OVERLAP + 10);
    const joined = joinContinuation(`前${emoji}`, `${emoji}後`);
    expect(Array.from(joined).length).toBe(1 + (CONTINUATION_MAX_OVERLAP + 10) + 10 + 1);
  });

  it("どちらかが空でも壊れない", () => {
    expect(joinContinuation("", "次")).toBe("次");
    expect(joinContinuation("前", "")).toBe("前");
  });
});

describe("continuationOverlap", () => {
  it("重なりの字数（無ければ 0。新しい実行の続きはこれが 0 なら結合しない）", () => {
    expect(continuationOverlap("45: 四十", "5: 四十五")).toBe(5);
    expect(continuationOverlap("結論とし", "として、")).toBe(0);
    expect(continuationOverlap("前の文。", "次の文。")).toBe(0);
    expect(continuationOverlap("ささ", "さやか")).toBe(0);
    expect(continuationOverlap("段落。\n\n\n\n", "\n\n\n\n次")).toBe(0);
  });
});

describe("buildFreshContinuationPrompt", () => {
  it("元の指示 ＋ ここまでの出力 ＋ 続きの指示", () => {
    const prompt = buildFreshContinuationPrompt("## 文字起こし\n\n本文", "ここまで");
    expect(prompt).toBe(`## 文字起こし\n\n本文\n\n## ここまでの出力\n\nここまで\n\n${CONTINUATION_INSTRUCTION}`);
  });
});
