import { describe, expect, it } from "vitest";
import {
  FIXED_RULES,
  buildPrompt,
  buildSystemPrompt,
  createFlowFromTemplate,
  FLOW_TEMPLATES,
  inputsFor,
  projectInfoMarkdown,
  type Flow,
  type RecordingInfo,
} from "../src/index.js";

function sampleFlow(): Flow {
  return {
    version: 1,
    id: "flow-1",
    name: "テスト",
    revision: 1,
    guide: "## 文書の目的と読者\n読む人に伝える。",
    terms: [{ term: "NIHO鎌倉", reading: "にほかまくら", variants: ["NIHO 鎌倉"], note: "" }],
    samples: [],
    steps: [
      { id: "a", name: "整える", instruction: "整える指示", profile: "standard" },
      { id: "b", name: "方針", instruction: "方針の指示", profile: "advanced" },
      { id: "c", name: "本文", instruction: "本文の指示", profile: "advanced" },
    ],
  };
}

function sampleInfo(): RecordingInfo {
  return {
    speakers: "3",
    language: "ja",
    terms: [
      { term: "由比ヶ浜", reading: "ゆいがはま", variants: ["由比が浜"], note: "" },
      { term: "niho鎌倉", reading: "", variants: [], note: "案件の表記" },
    ],
    background: "鎌倉の座談会。",
  };
}

describe("inputsFor", () => {
  it("文字起こし＋それまでの成果物すべて＋参考ページ＋案件情報＋文書ガイド", () => {
    const flow = sampleFlow();
    expect(inputsFor(flow, 0)).toEqual([{ kind: "source", name: "文字起こし" }, { kind: "refs" }, { kind: "info" }, { kind: "guide" }]);
    expect(inputsFor(flow, 2, "文章")).toEqual([
      { kind: "source", name: "文章" },
      { kind: "artifact", stepId: "a", name: "整える" },
      { kind: "artifact", stepId: "b", name: "方針" },
      { kind: "refs" },
      { kind: "info" },
      { kind: "guide" },
    ]);
  });

  it("範囲外の工程は投げる", () => {
    expect(() => inputsFor(sampleFlow(), 3)).toThrow(RangeError);
    expect(() => inputsFor(sampleFlow(), -1)).toThrow(RangeError);
  });
});

describe("buildPrompt", () => {
  it("システム側は 固定の決まり → 文書ガイド → この工程 の順", () => {
    const system = buildSystemPrompt(sampleFlow(), 1);
    expect(system.startsWith(FIXED_RULES)).toBe(true);
    const guideAt = system.indexOf("## 文書ガイド\n\n## 文書の目的と読者");
    const stepAt = system.indexOf("## この工程\n\n方針の指示");
    expect(guideAt).toBeGreaterThan(FIXED_RULES.length - 1);
    expect(stepAt).toBeGreaterThan(guideAt);
    expect(system).not.toContain("整える指示");
  });

  it("ガイドが空なら文書ガイドの節を出さない", () => {
    const flow = { ...sampleFlow(), guide: "  " };
    expect(buildSystemPrompt(flow, 0)).not.toContain("## 文書ガイド");
  });

  it("ユーザー側は 文字起こし → 工程の成果物（順） → 案件情報。送る量は字数", () => {
    const built = buildPrompt(sampleFlow(), 2, {
      sourceName: "文字起こし",
      source: "[00:00:01] こんにちは",
      artifacts: { a: "整えた本文", b: "方針の本文", c: "前の本文（入らない）" },
      refs: [],
      info: sampleInfo(),
    });
    const user = built.userPrompt;
    const order = ["## 文字起こし\n\n[00:00:01] こんにちは", "## 整える\n\n整えた本文", "## 方針\n\n方針の本文", "## 背景情報"].map(
      (part) => user.indexOf(part),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(user).not.toContain("前の本文");
    expect(built.missing).toEqual([]);
    expect(built.chars).toBe([...built.systemPrompt].length + [...built.userPrompt].length);
  });

  it("前の工程の成果物が無ければ missing に出す", () => {
    const built = buildPrompt(sampleFlow(), 2, {
      sourceName: "文字起こし",
      source: "本文",
      artifacts: { a: "整えた本文" },
      refs: [],
      info: sampleInfo(),
    });
    expect(built.missing).toEqual([{ kind: "artifact", stepId: "b", name: "方針" }]);
  });

  it("文字起こしの話者ラベルは常に除外し、文章 source の同じ文字列は変えない", () => {
    const source = "[00:00:01] 話者1: 本文\n\n[00:00:03] 田中: 続き\n\n[00:00:04] 質問: 通常発話\n";
    const transcript = buildPrompt(sampleFlow(), 0, {
      sourceName: "文字起こし", source, transcriptSpeakerNames: { "1": "田中" }, artifacts: {}, refs: [], info: sampleInfo(),
    });
    expect(transcript.userPrompt).toContain("[00:00:01] 本文\n\n[00:00:03] 続き");
    expect(transcript.userPrompt).not.toContain("話者1:");
    expect(transcript.userPrompt).not.toContain("田中:");
    expect(transcript.userPrompt).toContain("[00:00:04] 質問: 通常発話");
    const prose = buildPrompt(sampleFlow(), 0, { sourceName: "文章", source, artifacts: {}, refs: [], info: sampleInfo() });
    expect(prose.userPrompt).toContain(source.trim());
  });

  it("テンプレートのどの工程も組み立てられる", () => {
    for (const template of FLOW_TEMPLATES) {
      const flow = createFlowFromTemplate(template, `flow-${template.id}`);
      flow.steps.forEach((step, index) => {
        const built = buildPrompt(flow, index, {
          sourceName: "文字起こし",
          source: "本文",
          artifacts: Object.fromEntries(flow.steps.map((candidate) => [candidate.id, `${candidate.name}の本文`])),
          refs: [],
      info: sampleInfo(),
        });
        expect(built.systemPrompt).toContain(step.instruction);
        expect(built.missing).toEqual([]);
      });
    }
  });
});

describe("buildPrompt の参考ページ（#18566 P3）", () => {
  const base = {
    sourceName: "文字起こし",
    source: "[00:00:01] こんにちは",
    artifacts: { a: "整えた本文", b: "方針の本文" },
    info: sampleInfo(),
  };

  it("参考があれば 成果物の後・案件情報の前に「## 参考ページ」と ページごとの「### タイトル」＋本文（付けた順）", () => {
    const built = buildPrompt(sampleFlow(), 2, {
      ...base,
      refs: [
        { pageId: "d1", title: "事前メモ", body: "- 問い: 今の悩みは何か\n" },
        { pageId: "d2", title: "前回のふりかえり", body: "宿題は二つ。" },
      ],
    });
    const user = built.userPrompt;
    expect(user).toContain(
      "## 方針\n\n方針の本文\n\n## 参考ページ\n\n### 事前メモ\n\n- 問い: 今の悩みは何か\n\n### 前回のふりかえり\n\n宿題は二つ。\n\n## 背景情報",
    );
    expect(built.missing).toEqual([]);
    // 送る量は参考を含む
    const without = buildPrompt(sampleFlow(), 2, { ...base, refs: [] });
    expect(built.chars).toBe([...built.systemPrompt].length + [...user].length);
    expect(built.chars).toBeGreaterThan(without.chars);
    expect(built.chars - without.chars).toBe(
      [..."\n\n## 参考ページ\n\n### 事前メモ\n\n- 問い: 今の悩みは何か\n\n### 前回のふりかえり\n\n宿題は二つ。"].length,
    );
  });

  it("参考が無い・本文が空の文書だけなら見出しごと出さない。空の文書は入れず、タイトルが空なら「無題」", () => {
    const none = buildPrompt(sampleFlow(), 1, { ...base, refs: [] });
    expect(none.userPrompt).not.toContain("参考ページ");
    expect(none.userPrompt).toContain("## 整える\n\n整えた本文\n\n## 背景情報");
    const empty = buildPrompt(sampleFlow(), 1, { ...base, refs: [{ pageId: "d1", title: "空のメモ", body: " \n " }] });
    expect(empty.userPrompt).toBe(none.userPrompt);
    expect(empty.chars).toBe(none.chars);
    const mixed = buildPrompt(sampleFlow(), 0, {
      ...base,
      refs: [
        { pageId: "d1", title: "空のメモ", body: "" },
        { pageId: "d2", title: "  ", body: "本文だけ" },
      ],
    });
    expect(mixed.userPrompt).toContain("## 参考ページ\n\n### 無題\n\n本文だけ\n\n## 背景情報");
    expect(mixed.userPrompt).not.toContain("空のメモ");
    // 参考は missing に数えない（前の工程が無いときだけ）
    const missing = buildPrompt(sampleFlow(), 2, { ...base, artifacts: { a: "整えた本文" }, refs: [{ pageId: "d1", title: "メモ", body: "" }] });
    expect(missing.missing).toEqual([{ kind: "artifact", stepId: "b", name: "方針" }]);
  });

  it("システム側の固定の決まりは参考ページの扱いを含む", () => {
    expect(FIXED_RULES).toContain("参考ページは事前の情報・問い");
    expect(buildSystemPrompt(sampleFlow(), 0).startsWith(FIXED_RULES)).toBe(true);
  });
});

describe("buildPrompt の「あなたについて」", () => {
  const about = { name: "佐藤", text: "ライフコーチをしています。録音では私が聞き手です。" };
  const base = {
    sourceName: "文字起こし",
    source: "[00:00:01] こんにちは",
    artifacts: { a: "整えた本文", b: "方針の本文" },
    refs: [],
    info: sampleInfo(),
  };

  it("システム側は 固定の決まり → あなたについて → 文書ガイド → この工程 の順（ユーザー側には入れない）", () => {
    const built = buildPrompt(sampleFlow(), 1, { ...base, about });
    const system = built.systemPrompt;
    expect(system.startsWith(FIXED_RULES)).toBe(true);
    expect(system.indexOf("## あなたについて\n\n呼び名: 佐藤\n\nライフコーチをしています。録音では私が聞き手です。")).toBe(
      FIXED_RULES.length + 2,
    );
    const aboutAt = system.indexOf("## あなたについて");
    const guideAt = system.indexOf("## 文書ガイド");
    const stepAt = system.indexOf("## この工程");
    expect(aboutAt).toBeGreaterThan(FIXED_RULES.length - 1);
    expect(guideAt).toBeGreaterThan(aboutAt);
    expect(stepAt).toBeGreaterThan(guideAt);
    expect(built.userPrompt).not.toContain("あなたについて");
    expect(built.userPrompt).not.toContain("佐藤");
    // ガイドが空でも、決まりの後・この工程の前
    const noGuide = buildSystemPrompt({ ...sampleFlow(), guide: "" }, 1, about);
    expect(noGuide.indexOf("## あなたについて")).toBeLessThan(noGuide.indexOf("## この工程"));
    expect(noGuide).not.toContain("## 文書ガイド");
  });

  it("呼び名だけ・本文だけでも節を出し、足りない行は省く。両方空（空白だけ）なら節ごと入れない", () => {
    const nameOnly = buildSystemPrompt(sampleFlow(), 0, { name: " 佐藤\n", text: "  " });
    expect(nameOnly).toContain("## あなたについて\n\n呼び名: 佐藤\n\n## 文書ガイド");
    const textOnly = buildSystemPrompt(sampleFlow(), 0, { name: "", text: "\n聞き手です。\n" });
    expect(textOnly).toContain("## あなたについて\n\n聞き手です。\n\n## 文書ガイド");
    expect(textOnly).not.toContain("呼び名");
    const plain = buildSystemPrompt(sampleFlow(), 0);
    expect(plain).not.toContain("あなたについて\n");
    expect(buildSystemPrompt(sampleFlow(), 0, { name: "", text: "" })).toBe(plain);
    expect(buildSystemPrompt(sampleFlow(), 0, { name: " ", text: "\n \t" })).toBe(plain);
    expect(buildPrompt(sampleFlow(), 0, { ...base, about: { name: "", text: "" } }).systemPrompt).toBe(plain);
  });

  it("送る量は節を含み、missing は変わらない", () => {
    const without = buildPrompt(sampleFlow(), 2, base);
    const built = buildPrompt(sampleFlow(), 2, { ...base, about });
    expect(built.chars).toBe([...built.systemPrompt].length + [...built.userPrompt].length);
    expect(built.chars).toBeGreaterThan(without.chars);
    expect(built.missing).toEqual([]);
    expect(built.userPrompt).toBe(without.userPrompt);
  });
});

describe("projectInfoMarkdown", () => {
  it("話者・言語・固有名詞の 4 列・背景情報。共通の語は案件情報の行を残して合わせる", () => {
    const markdown = projectInfoMarkdown(sampleInfo(), sampleFlow().terms);
    expect(markdown).toContain("- 話者: 3人\n- 言語: 日本語");
    expect(markdown).toContain("| 表記 | よみ | 誤りやすい表記 | 補足 |");
    expect(markdown).toContain("| 由比ヶ浜 | ゆいがはま | 由比が浜 |  |");
    // 「niho鎌倉」と「NIHO鎌倉」は同じ語（NFKC・小文字化）。案件情報の行だけが残る
    expect(markdown).toContain("| niho鎌倉 |  |  | 案件の表記 |");
    expect(markdown).not.toContain("にほかまくら");
    expect(markdown).toContain("### 背景・目的\n\n鎌倉の座談会。");
  });

  it("空の固有名詞・背景情報は書かない。表の | は逃がす", () => {
    const info: RecordingInfo = {
      speakers: "auto",
      language: "en",
      terms: [{ term: "A|B", reading: "", variants: ["x", "y"], note: "改行\nあり" }],
      background: " ",
    };
    const markdown = projectInfoMarkdown(info, []);
    expect(markdown).toContain("- 話者: 自動\n- 言語: 英語");
    expect(markdown).toContain("| A\\|B |  | x・y | 改行 あり |");
    expect(markdown).not.toContain("背景情報");
    expect(projectInfoMarkdown({ ...info, terms: [] }, [])).not.toContain("固有名詞");
  });
});
