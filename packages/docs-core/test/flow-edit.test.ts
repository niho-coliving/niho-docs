import { describe, expect, it } from "vitest";
import {
  BLANK_FLOW_NAME,
  NEW_STEP_NAME,
  STANDARD_PROFILE_ID,
  createBlankFlow,
  createFlowFromTemplate,
  defaultProfiles,
  diffFlowDesign,
  duplicateFlow,
  duplicateStep,
  findTemplate,
  moveStep,
  newStep,
  recordingWithCurrentFlow,
  sameFlowContent,
  sameFlowDesign,
  uniqueFlowName,
  uniqueStepName,
  type Flow,
  type Recording,
  type Step,
} from "../src/index.js";

const steps: Step[] = [
  { id: "a", name: "整える", instruction: "x", profile: "standard" },
  { id: "b", name: "方針", instruction: "y", profile: "advanced" },
  { id: "c", name: "本文", instruction: "z", profile: "advanced" },
];

const flow: Flow = { version: 1, id: "flow-1", name: "テスト", revision: 3, guide: "ガイド", terms: [], samples: [], steps };

describe("工程カードの編集", () => {
  it("足した工程は重ならない「無題の工程」で、指示文は空・モデルは標準", () => {
    const first = newStep("n1", steps);
    expect(first).toEqual({ id: "n1", name: NEW_STEP_NAME, instruction: "", profile: STANDARD_PROFILE_ID });
    expect(newStep("n2", [...steps, first]).name).toBe(`${NEW_STEP_NAME} 2`);
    expect(uniqueStepName("方針", steps)).toBe("方針 2");
    expect(uniqueStepName("ﾎｳｼﾝ", [{ name: "ホウシン" }])).toBe("ﾎｳｼﾝ 2");
  });

  it("複製は名前に「のコピー」を付け、指示文とモデルを写す（id は新しい）", () => {
    const copy = duplicateStep(steps[1] as Step, "d", steps);
    expect(copy).toEqual({ id: "d", name: "方針のコピー", instruction: "y", profile: "advanced" });
    expect(duplicateStep(steps[1] as Step, "e", [...steps, copy]).name).toBe("方針のコピー 2");
  });

  it("並び替えは範囲の外を端に寄せ、元の並びを変えない", () => {
    expect(moveStep(steps, 0, 2).map((step) => step.id)).toEqual(["b", "c", "a"]);
    expect(moveStep(steps, 2, -5).map((step) => step.id)).toEqual(["c", "a", "b"]);
    expect(moveStep(steps, 9, 0).map((step) => step.id)).toEqual(["a", "b", "c"]);
    expect(steps.map((step) => step.id)).toEqual(["a", "b", "c"]);
  });
});

describe("テンプレートと白紙", () => {
  it("白紙は工程 1 だけ（工程 2 以降は無い）", () => {
    expect(createBlankFlow("f")).toEqual({
      version: 1,
      id: "f",
      name: BLANK_FLOW_NAME,
      revision: 1,
      guide: "",
      terms: [],
      samples: [],
      transcription: true,
      steps: [],
    });
  });

  it("テンプレートは新しいフローとして作り、同じ名前のフローがあれば「 2」を付けられる（テンプレートの定数は変えない）", () => {
    const template = findTemplate("tpl-2");
    if (!template) throw new Error("議事録のテンプレートが無い");
    const created = createFlowFromTemplate(template, "flow-2");
    expect(uniqueFlowName(created.name, [flow])).toBe("議事録");
    expect(uniqueFlowName(created.name, [flow, { name: " 議事録 " }])).toBe("議事録 2");
    created.steps[0]!.name = "変えた";
    expect(template.steps[0]?.name).toBe("議事録");
  });
});

describe("フローの複製（P4 #18567）", () => {
  const source: Flow = {
    ...flow,
    terms: [{ term: "鎌倉", reading: "かまくら", variants: ["かまくら市"], note: "" }],
    samples: [{ id: "s1", name: "お手本.md", chars: 1200 }],
  };

  it("新しい id・「〈名前〉のコピー」・revision 1 で、ガイド・固有名詞・お手本・工程（id も）を写す", () => {
    const copy = duplicateFlow(source, "flow-9", [source]);
    expect(copy).toEqual({ ...source, id: "flow-9", name: "テストのコピー", revision: 1, transcription: true });
    expect(copy.steps.map((step) => step.id)).toEqual(["a", "b", "c"]);
    // 名前が重なれば「 2」
    expect(duplicateFlow(source, "flow-10", [source, copy]).name).toBe("テストのコピー 2");
  });

  it("写しを変えても元のフローは変わらない", () => {
    const copy = duplicateFlow(source, "flow-9", [source]);
    copy.steps[0]!.name = "変えた";
    copy.terms[0]!.variants.push("鎌倉市");
    copy.samples[0]!.name = "別.md";
    expect(source.steps[0]!.name).toBe("整える");
    expect(source.terms[0]!.variants).toEqual(["かまくら市"]);
    expect(source.samples[0]!.name).toBe("お手本.md");
  });
});

describe("設計の比較", () => {
  it("実行に効く設計だけを比べる（名前・revision・お手本は sameFlowDesign では見ない）", () => {
    expect(sameFlowDesign(flow, { ...flow, name: "別名", revision: 9, samples: [{ id: "s", name: "x", chars: 1 }] })).toBe(true);
    expect(sameFlowDesign(flow, { ...flow, guide: "別のガイド" })).toBe(false);
    expect(sameFlowDesign(flow, { ...flow, steps: moveStep(steps, 0, 1) })).toBe(false);
    expect(sameFlowDesign(flow, { ...flow, transcription: false })).toBe(false);
    expect(sameFlowContent(flow, { ...flow, revision: 9 })).toBe(true);
    expect(sameFlowContent(flow, { ...flow, name: "別名" })).toBe(false);
    expect(sameFlowContent(flow, { ...flow, samples: [{ id: "s", name: "x", chars: 1 }] })).toBe(false);
  });

  it("文字起こし工程の有無を複製と差分へ残す", () => {
    const without = { ...flow, transcription: false };
    expect(duplicateFlow(without, "flow-vtt-copy", [without]).transcription).toBe(false);
    expect(diffFlowDesign(flow, without).transcription).toBe(true);
  });

  it("お手本の元 URL は保存対象として比較し、旧フローの省略とも互換にする", () => {
    const sample = { id: "s", name: "記事", chars: 10 };
    const base = { ...flow, samples: [sample] };
    expect(sameFlowContent(base, { ...base, samples: [{ ...sample, sourceUrl: undefined }] })).toBe(true);
    expect(sameFlowContent(base, { ...base, samples: [{ ...sample, sourceUrl: "https://example.com/article" }] })).toBe(false);
  });

  it("案件の工程と今の設計の違い（増える・外れる・名前・指示文・モデル・順序・ガイド）", () => {
    const next: Flow = {
      ...flow,
      guide: "新しいガイド",
      steps: [
        { ...(steps[1] as Step), name: "記事の方針", instruction: "y2" },
        { ...(steps[0] as Step), profile: "advanced" },
        { id: "d", name: "要約", instruction: "w", profile: "standard" },
      ],
    };
    expect(diffFlowDesign(flow, next)).toEqual({
      added: ["要約"],
      removed: ["本文"],
      renamed: [{ from: "方針", to: "記事の方針" }],
      instructions: ["記事の方針"],
      models: ["整える"],
      reordered: true,
      guide: true,
      transcription: false,
    });
    expect(diffFlowDesign(flow, { ...flow, revision: 4 })).toEqual({
      added: [],
      removed: [],
      renamed: [],
      instructions: [],
      models: [],
      reordered: false,
      guide: false,
      transcription: false,
    });
  });

  it("「この録音の工程を今の設計に更新」は snapshot だけを作り直す（モデルも今の設定で解決する）", () => {
    const old = createFlowFromTemplate(findTemplate("tpl-2")!, "flow-1");
    const recording: Recording = {
      version: 1,
      id: "r1",
      createdAt: "2026-10-15T00:00:00.000Z",
      flowSnapshot: { ...old, models: {} },
      source: { kind: "text" },
      speakers: "2",
      language: "ja",
      refs: [],
    };
    const current: Flow = { ...old, revision: 2, steps: [...old.steps, { id: "t9", name: "宿題の一覧", instruction: "宿題だけ", profile: "advanced" }] };
    const updated = recordingWithCurrentFlow(recording, current, defaultProfiles(), ["claude"]);
    expect(updated.flowSnapshot.revision).toBe(2);
    expect(updated.flowSnapshot.steps.map((step) => step.name)).toEqual(["議事録", "共有用の要約", "宿題の一覧"]);
    expect(updated.flowSnapshot.models.t9).toMatchObject({ provider: "claude", model: "claude-opus-4-8", effort: "high", profileName: "高性能" });
    expect({ ...updated, flowSnapshot: undefined }).toEqual({ ...recording, flowSnapshot: undefined });
    // 元の録音は変えない
    expect(recording.flowSnapshot.revision).toBe(1);
  });
});
