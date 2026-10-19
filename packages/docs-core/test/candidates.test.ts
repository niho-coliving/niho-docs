import { describe, expect, it } from "vitest";
import {
  SOURCE_STEP_ID,
  addCandidate,
  artifactIdFor,
  candidatesAllowed,
  canRunStep,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  findTemplate,
  planProject,
  recordingWithCurrentFlow,
  isSelectedSourceCandidate,
  projectWithRootRecording,
  rootRecording,
  runMatchesCandidate,
  selectedSourceArtifactId,
  selectedSourceCandidate,
  sourceCandidateName,
  stepSupportsCandidates,
  withSourceCandidate,
  type Project,
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

describe("文字起こしの別案（#19108）", () => {
  const audioRecording: Recording = {
    ...recording,
    source: { kind: "audio", audio: [{ file: "a.m4a", hash: "h", name: "朝市.m4a", durationSec: 190 }] },
  };
  const withMac = addCandidate(audioRecording, {
    stepId: SOURCE_STEP_ID,
    primaryId: "tx1",
    primaryName: "Gemini",
    primaryEngine: "gemini",
    now: "2026-10-19T01:00:00.000Z",
    candidate: { id: "tx2", artifactId: "artifact-tx2", name: "この Mac", engine: "this-mac", createdAt: "2026-10-19T01:00:00.000Z" },
  });

  it("音声のある録音だけ、文字起こしに案を足せる（最初の案は transcript.md のまま）", () => {
    expect(candidatesAllowed(audioRecording, SOURCE_STEP_ID)).toBe(true);
    expect(candidatesAllowed(recording, SOURCE_STEP_ID)).toBe(false);
    expect(candidatesAllowed({ ...audioRecording, source: { kind: "audio", audio: [] } }, SOURCE_STEP_ID)).toBe(false);
    expect(() => addCandidate(recording, {
      stepId: SOURCE_STEP_ID,
      primaryId: "tx1",
      now: "2026-10-19T01:00:00.000Z",
      candidate: { id: "tx2", artifactId: "artifact-tx2", name: "この Mac", createdAt: "2026-10-19T01:00:00.000Z" },
    })).toThrow(/追加できません/);
    const set = withMac.candidateSets?.[SOURCE_STEP_ID];
    expect(set?.order).toEqual(["tx1", "tx2"]);
    expect(set?.items.tx1).toMatchObject({ artifactId: SOURCE_STEP_ID, name: "Gemini", engine: "gemini" });
    expect(artifactIdFor(withMac, SOURCE_STEP_ID, "tx2")).toBe("artifact-tx2");
  });

  it("案の名前はエンジン名。同じエンジンは数を足し、名前の重なりを避ける", () => {
    expect(sourceCandidateName(audioRecording, "this-mac")).toBe("この Mac");
    // 2 つ目を足すとき（台帳はまだ無い）は、これから載せる最初の案も数える
    expect(sourceCandidateName(audioRecording, "this-mac", { name: "この Mac", engine: "this-mac" })).toBe("この Mac 2");
    expect(sourceCandidateName(audioRecording, "gemini", { name: "最初の文字起こし" })).toBe("Gemini");
    expect(sourceCandidateName(withMac, "this-mac")).toBe("この Mac 2");
    expect(sourceCandidateName(withMac, "gemini")).toBe("Gemini 2");
    expect(sourceCandidateName(withMac, "deepgram")).toBe("Deepgram");
  });

  it("後工程に使う案: 指定が無ければ最初の案、指定した案、台帳に無い指定は別の案へ寄せない", () => {
    expect(selectedSourceCandidate(audioRecording)).toBeNull();
    expect(selectedSourceArtifactId(audioRecording)).toBe(SOURCE_STEP_ID);
    expect(selectedSourceCandidate(withMac)?.id).toBe("tx1");
    expect(selectedSourceArtifactId(withMac)).toBe(SOURCE_STEP_ID);
    const switched = withSourceCandidate(withMac, "tx2");
    expect(selectedSourceArtifactId(switched)).toBe("artifact-tx2");
    expect(isSelectedSourceCandidate(switched, "tx2")).toBe(true);
    expect(isSelectedSourceCandidate(switched, "tx1")).toBe(false);
    expect(() => withSourceCandidate(withMac, "missing")).toThrow(/見つかりません/);
    expect(() => selectedSourceCandidate({ ...withMac, sourceCandidateId: "missing" })).toThrow(/見つかりません/);
    expect(() => selectedSourceCandidate({ ...audioRecording, sourceCandidateId: "tx2" })).toThrow(/見つかりません/);
    expect(isSelectedSourceCandidate({ ...withMac, sourceCandidateId: "missing" }, "tx1")).toBe(false);
  });

  it("工程設計を直しても文字起こしの案は残り、工程の更新を止めない", () => {
    const updated = recordingWithCurrentFlow(withMac, { ...flow, steps: flow.steps.slice(0, -1) }, defaultProfiles(), ["claude"]);
    expect(updated.candidateSets?.[SOURCE_STEP_ID]?.order).toEqual(["tx1", "tx2"]);
  });

  it("root の録音は project.json に後工程の指定を持つ", () => {
    const project: Project = {
      version: 1,
      id: "p1",
      name: "朝市",
      createdAt: "2026-10-19T00:00:00.000Z",
      info: { terms: [], background: "" },
      flowSnapshot: audioRecording.flowSnapshot,
      source: audioRecording.source,
    };
    const root = rootRecording(project)!;
    const written = projectWithRootRecording(project, withSourceCandidate({ ...root, candidateSets: withMac.candidateSets }, "tx2"));
    expect(written.sourceCandidateId).toBe("tx2");
    expect(rootRecording(written)?.sourceCandidateId).toBe("tx2");
  });
});
