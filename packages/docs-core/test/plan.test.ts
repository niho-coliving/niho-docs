import { describe, expect, it } from "vitest";
import {
  SOURCE_STEP_ID,
  basisFor,
  canRunStep,
  hashText,
  planProject,
  refsHash,
  staleNoticeText,
  staleReasons,
  type Basis,
  type Flow,
  type PromptMaterials,
  type RecordingInfo,
} from "../src/index.js";

const flow: Flow = {
  version: 1,
  id: "flow-1",
  name: "テスト",
  revision: 1,
  guide: "ガイド",
  terms: [],
  samples: [],
  steps: [
    { id: "a", name: "整える", instruction: "x", profile: "standard" },
    { id: "b", name: "方針", instruction: "y", profile: "standard" },
    { id: "c", name: "本文", instruction: "z", profile: "standard" },
  ],
};

const info: RecordingInfo = { speakers: "auto", language: "ja", terms: [], background: "背景" };

function basisAll(artifacts: Record<string, string>, source = "文字起こし", currentInfo = info, currentFlow = flow) {
  const latestBasis: Record<string, Basis> = {};
  currentFlow.steps.forEach((step, index) => {
    if (artifacts[step.id]) latestBasis[step.id] = basisFor(currentFlow, index, { source, artifacts, info: currentInfo });
  });
  return latestBasis;
}

describe("planProject", () => {
  it("案だけの追加指示を工程前提に含め、兄弟案とは別に stale を判定できる", () => {
    const materials = { source: "文字起こし", artifacts: { a: "整えた", b: "方針" }, info };
    const first = basisFor(flow, 2, { ...materials, candidateInstruction: "親しみやすく" });
    expect(staleReasons(first, basisFor(flow, 2, { ...materials, candidateInstruction: "親しみやすく" }))).toEqual([]);
    expect(staleReasons(first, basisFor(flow, 2, { ...materials, candidateInstruction: "専門家向けに" }))).toEqual(["step"]);
  });

  it("成果物の有無で済と残りの工程を出す", () => {
    const plan = planProject({
      flow,
      sourceName: "文字起こし",
      source: "文字起こし",
      artifacts: { a: "整えた" },
      info,
      latestBasis: basisAll({ a: "整えた" }),
    });
    expect(plan.steps.map((step) => [step.stepId, step.number, step.done])).toEqual([
      [SOURCE_STEP_ID, 1, true],
      ["a", 2, true],
      ["b", 3, false],
      ["c", 4, false],
    ]);
    expect(plan.remaining).toEqual(["b", "c"]);
    expect(plan.plan).toBe("continuous");
    expect(plan.doneCount).toBe(2);
    expect(plan.total).toBe(4);
    expect(plan.steps.every((step) => !step.stale)).toBe(true);
  });

  it("工程 1 が無ければ残りの先頭は工程 1", () => {
    const plan = planProject({ flow, sourceName: "文字起こし", source: "", artifacts: {}, info, latestBasis: {} });
    expect(plan.remaining).toEqual([SOURCE_STEP_ID, "a", "b", "c"]);
    expect(canRunStep(plan, SOURCE_STEP_ID)).toBe(true);
    expect(canRunStep(plan, "a")).toBe(false);
  });

  it("前の工程を作り直すと、後ろの工程すべてに stale が付く（自動では再実行しない）", () => {
    const artifacts = { a: "整えた", b: "方針", c: "本文" };
    const latestBasis = basisAll(artifacts);
    const plan = planProject({
      flow,
      sourceName: "文字起こし",
      source: "文字起こし",
      artifacts: { ...artifacts, a: "整え直した" },
      info,
      latestBasis,
    });
    expect(plan.steps.map((step) => step.stale)).toEqual([false, false, true, true]);
    expect(plan.steps[2]?.staleReasons).toEqual(["artifact"]);
    expect(plan.remaining).toEqual([]);
  });

  it("案件情報・文書ガイド・文字起こしの変更も前提の変更", () => {
    const artifacts = { a: "整えた", b: "方針", c: "本文" };
    const latestBasis = basisAll(artifacts);
    const changedInfo = planProject({
      flow,
      sourceName: "文字起こし",
      source: "文字起こし",
      artifacts,
      info: { ...info, terms: [{ term: "鎌倉", reading: "かまくら", variants: [], note: "" }] },
      latestBasis,
    });
    expect(changedInfo.steps.slice(1).every((step) => step.staleReasons.includes("info"))).toBe(true);

    const changedGuide = planProject({
      flow: { ...flow, guide: "新しいガイド" },
      sourceName: "文字起こし",
      source: "文字起こし",
      artifacts,
      info,
      latestBasis,
    });
    expect(changedGuide.steps[1]?.staleReasons).toEqual(["guide"]);

    const changedSource = planProject({ flow, sourceName: "文字起こし", source: "直した", artifacts, info, latestBasis });
    expect(changedSource.steps[1]?.staleReasons).toEqual(["source"]);
  });

  it("文字起こしの話者名だけの変更は実際のprompt同様にbasisを変えず、本文変更は変える", () => {
    const common = { sourceName: "文字起こし", artifacts: {}, info } as const;
    const numbered = basisFor(flow, 0, { ...common, source: "[00:00:01] 話者1: 本文\n" });
    const transcriptSpeakerNames = { "1": "田中" };
    const renamed = basisFor(flow, 0, { ...common, source: "[00:00:01] 田中: 本文\n", transcriptSpeakerNames });
    const changed = basisFor(flow, 0, { ...common, source: "[00:00:01] 田中: 修正文\n", transcriptSpeakerNames });
    expect(renamed.source).toBe(numbered.source);
    expect(changed.source).not.toBe(numbered.source);
    const prose = basisFor(flow, 0, { sourceName: "文章", source: "[00:00:01] 話者1: 本文\n", artifacts: {}, info });
    expect(prose.source).not.toBe(numbered.source);
  });

  it("工程設計の更新で指示文が変わった工程だけが stale（前後の空白だけの違いは同じ）", () => {
    const artifacts = { a: "整えた", b: "方針", c: "本文" };
    const latestBasis = basisAll(artifacts);
    const updated: Flow = {
      ...flow,
      steps: flow.steps.map((step) =>
        step.id === "b" ? { ...step, instruction: "新しい指示" } : step.id === "c" ? { ...step, instruction: " z \n" } : step,
      ),
    };
    const plan = planProject({ flow: updated, sourceName: "文字起こし", source: "文字起こし", artifacts, info, latestBasis });
    expect(plan.steps.map((step) => step.staleReasons)).toEqual([[], [], ["step"], []]);
    // 指示文の記録が無い（S3 より前の）版は比べない
    const { step: _ignored, ...legacy } = latestBasis.b as Basis;
    expect(staleReasons(legacy, basisFor(updated, 1, { source: "文字起こし", artifacts, info }))).toEqual([]);
  });

  it("参考ページ（#18566 P3）: 記録に refs が無い版は「参考なし」と同じ。参考を足す・本文を直すと stale、タイトルだけ・空の文書は前提を変えない", () => {
    const artifacts = { a: "整えた", b: "方針", c: "本文" };
    const memo = { pageId: "d1", title: "事前メモ", body: "- 問い: 何に困っているか\n" };
    // 参考なしで実行した記録（P3 より前の記録は refs を持たない）
    const recorded = basisFor(flow, 1, { source: "文字起こし", artifacts, info });
    expect(recorded.refs).toBe(hashText(""));
    expect(refsHash([])).toBe(hashText(""));
    const { refs: _refs, ...legacy } = recorded;
    expect(staleReasons(legacy, basisFor(flow, 1, { source: "文字起こし", artifacts, refs: [], info }))).toEqual([]);
    expect(staleReasons(legacy, basisFor(flow, 1, { source: "文字起こし", artifacts, refs: [{ ...memo, body: " " }], info }))).toEqual([]);
    // 参考を足した
    const withMemo = basisFor(flow, 1, { source: "文字起こし", artifacts, refs: [memo], info });
    expect(staleReasons(legacy, withMemo)).toEqual(["refs"]);
    expect(staleReasons(recorded, withMemo)).toEqual(["refs"]);
    // 本文を直した（前後の空白だけは同じ）・タイトルだけ変えた
    expect(staleReasons(withMemo, basisFor(flow, 1, { source: "文字起こし", artifacts, refs: [{ ...memo, body: "- 問い: 直した" }], info }))).toEqual([
      "refs",
    ]);
    expect(staleReasons(withMemo, basisFor(flow, 1, { source: "文字起こし", artifacts, refs: [{ ...memo, body: "\n- 問い: 何に困っているか" }], info }))).toEqual(
      [],
    );
    expect(staleReasons(withMemo, basisFor(flow, 1, { source: "文字起こし", artifacts, refs: [{ ...memo, title: "改名" }], info }))).toEqual([]);
    // 理由の並びは入力の並び（成果物 → 参考ページ → 案件情報）
    const changed = basisFor(flow, 1, {
      source: "文字起こし",
      artifacts: { ...artifacts, a: "整え直した" },
      refs: [],
      info: { ...info, background: "別の背景" },
    });
    expect(staleReasons(withMemo, changed)).toEqual(["artifact", "refs", "info"]);
  });

  it("planProject は参考の変わった工程に stale を付ける", () => {
    const artifacts = { a: "整えた", b: "方針", c: "本文" };
    const latestBasis = basisAll(artifacts);
    const plan = planProject({
      flow,
      sourceName: "文字起こし",
      source: "文字起こし",
      artifacts,
      refs: [{ pageId: "d1", title: "事前メモ", body: "問い" }],
      info,
      latestBasis,
    });
    expect(plan.steps.map((step) => step.staleReasons)).toEqual([[], ["refs"], ["refs"], ["refs"]]);
  });

  it("「あなたについて」は前提に入れない（書き換えても既存の成果物を stale にしない）", () => {
    const materials: PromptMaterials = { sourceName: "文字起こし", source: "文字起こし", artifacts: { a: "整えた" }, refs: [], info };
    const without = basisFor(flow, 1, materials);
    // 実行に渡す資料（PromptMaterials）には about が付くが、前提（basisFor）は読まない
    const withAbout: PromptMaterials = { ...materials, about: { name: "佐藤", text: "ライフコーチをしています。" } };
    const withOther: PromptMaterials = { ...materials, about: { name: "田中", text: "" } };
    const written = basisFor(flow, 1, withAbout);
    expect(written).toEqual(without);
    expect(staleReasons(without, written)).toEqual([]);
    expect(staleReasons(written, basisFor(flow, 1, withOther))).toEqual([]);
  });

  it("前提の記録が無い版は stale にしない", () => {
    expect(staleReasons(undefined, basisFor(flow, 0, { source: "x", artifacts: {}, info }))).toEqual([]);
  });

  it("canRunStep は前の工程がそろったときだけ", () => {
    const plan = planProject({
      flow,
      sourceName: "文章",
      source: "本文",
      artifacts: { a: "整えた" },
      info,
      latestBasis: {},
    });
    expect(canRunStep(plan, "a")).toBe(true);
    expect(canRunStep(plan, "b")).toBe(true);
    expect(canRunStep(plan, "c")).toBe(false);
    expect(canRunStep(plan, "zzz")).toBe(false);
  });
});

describe("staleNoticeText（#18915）", () => {
  it("いちばん元に近い理由を 1 つだけ、「成果物」「前提変更」の語を使わずに 1 行で言う", () => {
    expect(staleNoticeText(["source"])).toBe("元の文字起こしが変わりました。");
    expect(staleNoticeText(["source"], "text")).toBe("元の文章が変わりました。");
    expect(staleNoticeText(["artifact"])).toBe("元にしたページが変わりました。");
    expect(staleNoticeText(["refs"])).toBe("参考のページが変わりました。");
    expect(staleNoticeText(["info"])).toBe("背景情報が変わりました。");
    expect(staleNoticeText(["guide"])).toBe("文書ガイドが変わりました。");
    expect(staleNoticeText(["step"])).toBe("工程の指示が変わりました。");
    // 並びは入力の順（文字起こし → 前の工程のページ → 参考 → 背景情報 → 文書ガイド → 指示）
    expect(staleNoticeText(["step", "info", "artifact"])).toBe("元にしたページが変わりました。");
    expect(staleNoticeText(["guide", "source"])).toBe("元の文字起こしが変わりました。");
    expect(staleNoticeText([])).toBeNull();
    for (const reason of ["source", "artifact", "refs", "info", "guide", "step"] as const) {
      expect(staleNoticeText([reason])).not.toMatch(/成果物|前提/);
    }
  });
});
