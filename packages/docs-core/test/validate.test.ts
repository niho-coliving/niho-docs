import { describe, expect, it } from "vitest";
import {
  FLOW_TEMPLATES,
  GUIDE_MAX_CHARS,
  createBlankFlow,
  createFlowFromTemplate,
  defaultProfiles,
  newStep,
  stepIssues,
  validateFlow,
  type Flow,
} from "../src/index.js";

function flowWith(overrides: Partial<Flow>): Flow {
  return {
    version: 1,
    id: "flow-1",
    name: "テスト",
    revision: 1,
    guide: "",
    terms: [],
    samples: [],
    steps: [{ id: "a", name: "整える", instruction: "指示", profile: "standard" }],
    ...overrides,
  };
}

describe("validateFlow", () => {
  it("テンプレートはどれも検証を通る", () => {
    for (const template of FLOW_TEMPLATES) {
      expect(validateFlow(createFlowFromTemplate(template, "f"), defaultProfiles())).toEqual([]);
    }
  });

  it("以前に別案の設定を保存した工程が途中にあっても、工程設計の問題にしない（直せる欄が無いため）", () => {
    const formerFinal = { id: "h2n6v5pe", name: "本文", instruction: "x", profile: "standard", output: { mode: "candidates" } };
    const middle = flowWith({ steps: [formerFinal, { id: "after", name: "後続", instruction: "y", profile: "standard" }] });
    expect(validateFlow(middle)).toEqual([]);
  });

  it("名前の重複（NFKC で同じ）と空の名前", () => {
    const issues = validateFlow(
      flowWith({
        steps: [
          { id: "a", name: "方針", instruction: "x", profile: "standard" },
          { id: "b", name: " 方針 ", instruction: "x", profile: "standard" },
          { id: "c", name: "", instruction: "x", profile: "standard" },
        ],
      }),
    );
    expect(issues.map((issue) => [issue.code, issue.stepId])).toEqual([
      ["duplicate-step-name", "b"],
      ["empty-step-name", "c"],
    ]);
  });

  it("工程 1 の名前は使えない", () => {
    const issues = validateFlow(flowWith({ steps: [{ id: "a", name: "文字起こし", instruction: "x", profile: "standard" }] }));
    expect(issues.map((issue) => issue.code)).toEqual(["reserved-step-name"]);
  });

  it("空の指示文", () => {
    const issues = validateFlow(flowWith({ steps: [{ id: "a", name: "整える", instruction: " \n ", profile: "standard" }] }));
    expect(issues.map((issue) => issue.code)).toEqual(["empty-instruction"]);
  });

  it("ガイドの上限は NIHO の記事ガイドと同じ 4,000 字", () => {
    expect(GUIDE_MAX_CHARS).toBe(4_000);
    expect(validateFlow(flowWith({ guide: "あ".repeat(GUIDE_MAX_CHARS) }))).toEqual([]);
    const issues = validateFlow(flowWith({ guide: "あ".repeat(GUIDE_MAX_CHARS + 1) }));
    expect(issues.map((issue) => issue.code)).toEqual(["guide-too-long"]);
    expect(issues[0]?.message).toContain("4,000 字");
    expect(issues[0]?.stepId).toBeUndefined();
  });

  it("工程設計の名前が空", () => {
    expect(validateFlow(flowWith({ name: "  " })).map((issue) => issue.code)).toEqual(["empty-flow-name"]);
  });

  it("工程カードには、その工程の結果だけを出す", () => {
    const issues = validateFlow(
      flowWith({
        guide: "あ".repeat(GUIDE_MAX_CHARS + 1),
        steps: [
          { id: "a", name: "方針", instruction: "", profile: "standard" },
          { id: "b", name: "方針", instruction: "x", profile: "standard" },
        ],
      }),
    );
    expect(stepIssues(issues, "a").map((issue) => issue.code)).toEqual(["empty-instruction"]);
    expect(stepIssues(issues, "b").map((issue) => issue.code)).toEqual(["duplicate-step-name"]);
    expect(issues.filter((issue) => !issue.stepId).map((issue) => issue.code)).toEqual(["guide-too-long"]);
  });

  it("白紙は工程が無いので保存できない（工程を足せば通る）", () => {
    const blank = createBlankFlow("f");
    expect(validateFlow(blank, defaultProfiles()).map((issue) => issue.code)).toEqual(["no-steps"]);
    const filled = { ...blank, steps: [{ ...newStep("s1", []), instruction: "要約する" }] };
    expect(validateFlow(filled, defaultProfiles())).toEqual([]);
  });

  it("設定に無いプロファイル・工程なし・id の重複", () => {
    expect(validateFlow(flowWith({ steps: [{ id: "a", name: "x", instruction: "y", profile: "none" }] }), defaultProfiles()).map((issue) => issue.code)).toEqual([
      "unknown-profile",
    ]);
    expect(validateFlow(flowWith({ steps: [] })).map((issue) => issue.code)).toEqual(["no-steps"]);
    expect(
      validateFlow(
        flowWith({
          steps: [
            { id: "a", name: "x", instruction: "y", profile: "standard" },
            { id: "a", name: "z", instruction: "y", profile: "standard" },
          ],
        }),
      ).map((issue) => issue.code),
    ).toEqual(["duplicate-step-id"]);
  });
});
