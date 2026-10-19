import { describe, expect, expectTypeOf, it } from "vitest";
import { remoteRunSteps, remoteStepKind, type RunCloudProvenance, type RunRecord } from "../src/index.js";

describe("runs cloud provenance", () => {
  it("既存行はそのまま、新しい行は端末と版の参照を持てる", () => {
    const legacy: RunRecord = {
      id: "run-1",
      kind: "save",
      at: "2026-10-16T00:00:00Z",
      stepId: "source",
      stepName: "文章",
      version: 1,
      result: "saved",
    };
    const cloud: RunRecord = {
      ...legacy,
      originDeviceId: "d_device",
      versionSha256: "a".repeat(64),
      versionPath: "versions/source/1.md",
    };
    expect(legacy.originDeviceId).toBeUndefined();
    expect(cloud.versionPath).toBe("versions/source/1.md");
    expectTypeOf<RunRecord>().toMatchTypeOf<RunCloudProvenance>();
  });
});

describe("NIHO の API へ渡す工程の種類", () => {
  const flow = {
    steps: [{ id: "revision" }, { id: "minutes" }, { id: "summary" }],
    models: {
      revision: { provider: "gemini" as const, model: "gemini-3.8-flash", effort: "low" as const, profileId: "light", profileName: "NIHO API" },
      minutes: { provider: "gemini" as const, model: "gemini-3.8-flash", effort: "low" as const },
      summary: { provider: "claude" as const, model: "claude-sonnet-4-6", effort: "high" as const },
    },
  };

  it("フロー全体での位置で決める（最初の工程だけ REVISION、後ろの工程は単独でも INSIGHT、無い工程は null）", () => {
    expect(remoteStepKind(flow, "revision")).toBe("REVISION");
    expect(remoteStepKind(flow, "minutes")).toBe("INSIGHT");
    expect(remoteStepKind(flow, "summary")).toBe("INSIGHT");
    expect(remoteStepKind({ steps: [{ id: "summary" }] }, "summary")).toBe("REVISION");
    expect(remoteStepKind(flow, "source")).toBeNull();
    expect(remoteStepKind({ steps: [] }, "revision")).toBeNull();
  });

  it("固定したモデルのまま全工程をフローの順に、stepIds を渡せばその工程だけを渡した順に", () => {
    expect(remoteRunSteps(flow)).toEqual([
      { stepKey: "revision", kind: "REVISION", provider: "gemini", model: "gemini-3.8-flash", effort: "low" },
      { stepKey: "minutes", kind: "INSIGHT", provider: "gemini", model: "gemini-3.8-flash", effort: "low" },
      { stepKey: "summary", kind: "INSIGHT", provider: "claude", model: "claude-sonnet-4-6", effort: "high" },
    ]);
    expect(remoteRunSteps(flow, ["summary", "minutes"]).map((step) => [step.stepKey, step.kind])).toEqual([["summary", "INSIGHT"], ["minutes", "INSIGHT"]]);
    expect(remoteRunSteps(flow, [])).toEqual([]);
  });

  it("フローに無い工程・モデルが固定されていない工程は投げる", () => {
    expect(() => remoteRunSteps(flow, ["missing"])).toThrow();
    expect(() => remoteRunSteps({ steps: flow.steps, models: { revision: flow.models.revision } })).toThrow();
  });
});
