import { describe, expect, it } from "vitest";
import {
  addCandidate,
  artifactIdFor,
  canRunStep,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  findTemplate,
  planProject,
  recordingWithCurrentFlow,
  runMatchesCandidate,
  stepSupportsCandidates,
  type Recording,
} from "../src/index.js";

const ARTICLE_BODY_STEP_ID = "h2n6v5pe";
const flow = createFlowFromTemplate(findTemplate("tpl-1")!, "article-flow");
const recording: Recording = {
  version: 1,
  id: "rec1",
  createdAt: "2026-10-16T00:00:00.000Z",
  flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
  source: { kind: "text" },
  speakers: "auto",
  language: "ja",
  refs: [],
};

describe("記事本文の複数案", () => {
  it("記事制作の最後の本文工程だけを有効にし、既存本文を移さず最初の案として台帳化する", () => {
    expect(stepSupportsCandidates(flow, ARTICLE_BODY_STEP_ID)).toBe(true);
    expect(stepSupportsCandidates(flow, flow.steps[0]!.id)).toBe(false);
    const next = addCandidate(recording, {
      stepId: ARTICLE_BODY_STEP_ID,
      primaryId: "candidate1",
      primaryName: "最初の案",
      now: "2026-10-16T01:00:00.000Z",
      candidate: { id: "candidate2", artifactId: "artifact2", name: "別案", createdAt: "2026-10-16T01:00:00.000Z" },
    });
    expect(next.candidateSets?.[ARTICLE_BODY_STEP_ID]?.order).toEqual(["candidate1", "candidate2"]);
    expect(artifactIdFor(next, ARTICLE_BODY_STEP_ID, "candidate1")).toBe(ARTICLE_BODY_STEP_ID);
    expect(artifactIdFor(next, ARTICLE_BODY_STEP_ID, "candidate2")).toBe("artifact2");
    expect(() => artifactIdFor(next, ARTICLE_BODY_STEP_ID, "missing-candidate")).toThrow(/見つかりません/);
    expect(runMatchesCandidate({ id: "old", kind: "run", at: "", stepId: ARTICLE_BODY_STEP_ID, stepName: "本文", version: 1, result: "saved" }, ARTICLE_BODY_STEP_ID, next.candidateSets![ARTICLE_BODY_STEP_ID]!.items.candidate1!)).toBe(true);
  });

  it("どのフローでも最後の工程は常に別案を作れる（以前の「出力」チェックを外した保存が残っていても）", () => {
    const custom = { steps: [{ id: "minutes", name: "議事録", instruction: "x", profile: "standard" }] };
    expect(stepSupportsCandidates(custom, "minutes")).toBe(true);
    const unchecked = { ...flow.steps.at(-1)!, output: { mode: "single" } };
    expect(stepSupportsCandidates({ steps: [...flow.steps.slice(0, -1), unchecked] }, ARTICLE_BODY_STEP_ID)).toBe(true);
    expect(stepSupportsCandidates({ steps: [] }, ARTICLE_BODY_STEP_ID)).toBe(false);
  });

  it("候補がある工程の削除・途中への移動を拒否する", () => {
    const withCandidates = addCandidate(recording, {
      stepId: ARTICLE_BODY_STEP_ID,
      primaryId: "candidate1",
      now: "2026-10-16T01:00:00.000Z",
      candidate: { id: "candidate2", artifactId: "artifact2", name: "別案", createdAt: "2026-10-16T01:00:00.000Z" },
    });
    expect(() => recordingWithCurrentFlow(withCandidates, { ...flow, steps: flow.steps.slice(0, -1) }, defaultProfiles(), ["claude"])).toThrow(/複数案/);
    expect(() => recordingWithCurrentFlow(withCandidates, { ...flow, steps: [...flow.steps, { id: "after", name: "後続", instruction: "x", profile: "standard" }] }, defaultProfiles(), ["claude"])).toThrow(/複数案/);
  });

  it("以前に別案の設定を保存した工程が途中になっても、後続の工程は止めない", () => {
    const formerFinal = { ...flow.steps.at(-1)!, output: { mode: "candidates" } };
    const steps = [...flow.steps.slice(0, -1), formerFinal, { id: "after", name: "後続", instruction: "x", profile: "standard" }];
    const artifacts = Object.fromEntries(steps.slice(0, -1).map((step) => [step.id, "本文"]));
    const plan = planProject({ flow: { ...flow, steps }, sourceName: "文章", source: "原文", artifacts, info: { speakers: "auto", language: "ja", terms: [], background: "" }, latestBasis: {} });
    expect(plan.remaining).toEqual(["after"]);
    expect(canRunStep(plan, "after")).toBe(true);
    expect(stepSupportsCandidates({ steps }, ARTICLE_BODY_STEP_ID)).toBe(false);
    expect(stepSupportsCandidates({ steps }, "after")).toBe(true);
  });
});
