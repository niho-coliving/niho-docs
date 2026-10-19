import { describe, expect, it } from "vitest";
import {
  ABOUT_MAX_CHARS,
  EMPTY_ABOUT,
  FIXED_RULES,
  aboutError,
  aboutSection,
  hasAbout,
  parseAbout,
} from "../src/index.js";

describe("aboutSection", () => {
  it("「## あなたについて」＋「呼び名: 〈name〉」の行＋本文", () => {
    expect(aboutSection({ name: "佐藤", text: "ライフコーチをしています。" })).toBe(
      "## あなたについて\n\n呼び名: 佐藤\n\nライフコーチをしています。",
    );
  });

  it("空の項目は省く。両方空（空白だけ）なら空文字", () => {
    expect(aboutSection({ name: "佐藤", text: "" })).toBe("## あなたについて\n\n呼び名: 佐藤");
    expect(aboutSection({ name: "", text: "聞き手です。" })).toBe("## あなたについて\n\n聞き手です。");
    expect(aboutSection(EMPTY_ABOUT)).toBe("");
    expect(aboutSection({ name: " \n ", text: "\n\t " })).toBe("");
  });

  it("呼び名は 1 行にし、本文は前後の空白を除く（中の改行は残す）", () => {
    expect(aboutSection({ name: "  佐藤\n花子 ", text: "\n一行目\n二行目\n" })).toBe(
      "## あなたについて\n\n呼び名: 佐藤 花子\n\n一行目\n二行目",
    );
  });
});

describe("hasAbout", () => {
  it("呼び名か本文のどちらかに（空白以外の）字があれば true", () => {
    expect(hasAbout(EMPTY_ABOUT)).toBe(false);
    expect(hasAbout({ name: " ", text: "\n" })).toBe(false);
    expect(hasAbout({ name: "佐藤", text: "" })).toBe(true);
    expect(hasAbout({ name: "", text: "聞き手" })).toBe(true);
  });
});

describe("aboutError", () => {
  it("上限（2,000 字）までは通り、超えたら「今 N 字」を添えた理由を返す。字数はコードポイント", () => {
    expect(ABOUT_MAX_CHARS).toBe(2000);
    expect(aboutError({ name: "", text: "あ".repeat(2000) })).toBeNull();
    expect(aboutError({ name: "", text: "😀".repeat(2000) })).toBeNull();
    expect(aboutError({ name: "", text: "あ".repeat(2140) })).toBe("「パーソナライズ」は 2,000 字までにしてください（今 2,140 字）。");
    expect(aboutError({ name: "", text: "😀".repeat(2001) })).toBe("「パーソナライズ」は 2,000 字までにしてください（今 2,001 字）。");
    expect(aboutError({ name: "あ".repeat(5000), text: "" })).toBeNull();
  });
});

describe("parseAbout", () => {
  it("about.json の中身を読む。呼び名は改行を空白にして前後を除く", () => {
    expect(parseAbout({ version: 1, name: " 佐藤\n花子 ", text: "本文\n二行目" })).toEqual({
      name: "佐藤 花子",
      text: "本文\n二行目",
    });
  });

  it("壊れた・欠けた値は空にする", () => {
    for (const value of [null, undefined, 1, "about", [], true]) {
      expect(parseAbout(value)).toEqual(EMPTY_ABOUT);
    }
    expect(parseAbout({ version: 1 })).toEqual(EMPTY_ABOUT);
    expect(parseAbout({ version: 1, name: 3, text: { a: 1 } })).toEqual(EMPTY_ABOUT);
    expect(parseAbout({ name: "佐藤" })).toEqual({ name: "佐藤", text: "" });
    // 返すのは毎回新しい値（EMPTY_ABOUT を共有して書き換えない）
    expect(parseAbout(null)).not.toBe(EMPTY_ABOUT);
  });
});

describe("固定の決まりの「あなたについて」の行", () => {
  it("文書ガイドの行の直後にある", () => {
    const lines = FIXED_RULES.split("\n");
    const guideAt = lines.findIndex((line) => line.startsWith("- 文書ガイドは"));
    expect(guideAt).toBeGreaterThan(0);
    expect(lines[guideAt + 1]).toBe(
      "- 「あなたについて」は文書を作る本人の説明と書き方の希望として扱い、話者の判別・視点・言葉づかい・書き方に使う。工程の指示文・依頼・文書ガイドと食い違うときはそちらに従う。録音の事実の根拠にしない。",
    );
  });
});
