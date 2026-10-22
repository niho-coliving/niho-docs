import { describe, expect, it } from "vitest";
import {
  SOURCE_STEP_ID,
  basisFor,
  createFlowSnapshot,
  defaultProfiles,
  flowHasTranscription,
  flowSourceIssue,
  planProject,
  sourceStepName,
  type Flow,
  type RecordingInfo,
} from "../src/index.js";

const flow: Flow = {
  version: 1,
  id: "vtt-flow",
  name: "インサイト抽出",
  revision: 1,
  guide: "",
  terms: [],
  samples: [],
  transcription: false,
  steps: [{ id: "insight", name: "インサイト", instruction: "抽出する", profile: "standard" }],
};
const info: RecordingInfo = { speakers: "auto", language: "ja", terms: [], background: "" };
const imported = {
  kind: "text" as const,
  transcriptImport: { format: "vtt" as const, file: "source.vtt" as const, name: "meeting.vtt", hash: "a".repeat(64) },
};

describe("文字起こし工程の有無", () => {
  it("旧Flowはあり、新snapshotは有無を明示して保持する", () => {
    const legacy = { ...flow, transcription: undefined };
    expect(flowHasTranscription(legacy)).toBe(true);
    expect(createFlowSnapshot(legacy, defaultProfiles(), ["claude"]).transcription).toBe(true);
    expect(createFlowSnapshot(flow, defaultProfiles(), ["claude"]).transcription).toBe(false);
  });

  it("文字起こしなしではsourceをASRキューへ入れず、VTT原文から後工程だけを計画する", () => {
    const ready = planProject({ flow, sourceName: "文字起こし", source: "[00:00:00] 原文", artifacts: {}, info, latestBasis: {} });
    expect(ready.remaining).toEqual(["insight"]);
    expect(ready.steps.find((step) => step.stepId === SOURCE_STEP_ID)?.done).toBe(true);
    const missing = planProject({ flow, sourceName: "文字起こし", source: "", artifacts: {}, info, latestBasis: {} });
    expect(missing.remaining).toEqual(["insight"]);
    expect(missing.remaining).not.toContain(SOURCE_STEP_ID);
  });

  it("VTTと工程の不一致を開始前に説明し、plain text旧録音は互換のまま", () => {
    expect(sourceStepName(imported)).toBe("文字起こし");
    expect(flowSourceIssue(flow, imported, true)).toBeNull();
    expect(flowSourceIssue(flow, { kind: "audio", audio: [] }, false)).toMatch(/VTT/);
    expect(flowSourceIssue({ transcription: true }, imported, true)).toMatch(/文字起こしなし/);
    expect(flowSourceIssue({ transcription: true }, { kind: "text" }, true)).toBeNull();
  });

  it("文字起こし有無を後工程の前提hashに含め、旧trueのhashは変えない", () => {
    const materials = { source: "原文", artifacts: {}, info };
    const without = basisFor(flow, 0, materials);
    const legacy = basisFor({ ...flow, transcription: undefined }, 0, materials);
    const explicit = basisFor({ ...flow, transcription: true }, 0, materials);
    expect(without.source).not.toBe(legacy.source);
    expect(explicit.source).toBe(legacy.source);
  });
});
