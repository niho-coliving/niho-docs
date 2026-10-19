import { describe, expect, it } from "vitest";
import type { FlowSnapshot, RunRecord } from "@niho/docs-core";
import { readFileSync } from "node:fs";
import { FakeBridge } from "./fake-bridge";
import type { PersonalOpenRequest, PersonalOperationInfo } from "../src/lib/bridge";
import {
  canonical,
  createPersonalExecutionController,
  generationSnapshot,
  nextStepSnapshot,
  sha256Text,
  type PersonalCandidate,
  type PersonalExecutionPorts,
  type PersonalExecutionRequest,
  type PersonalFixedSnapshot,
  type PersonalRunHistory,
  type PersonalVersionRef,
} from "../src/lib/personal-execution";
import { GEMINI_TRANSCRIPTION_EFFORT, GEMINI_TRANSCRIPTION_MODEL } from "../src/lib/runner";

/** 共有 fixture（Rust の personal_run_tests.rs も同じファイルを読む）。 */
const fixture = JSON.parse(readFileSync(new URL("./fixtures/personal-snapshot-derivation.json", import.meta.url), "utf8")) as {
  transcriptionModels: Record<string, unknown>;
  canonicalSamples: Array<{ value: unknown; canonical: string }>;
  original: PersonalFixedSnapshot;
  sourceVersion: PersonalVersionRef;
  generation: PersonalFixedSnapshot;
  stepId: string;
  stepVersion: PersonalVersionRef;
  nextStep: PersonalFixedSnapshot;
  tampered: PersonalFixedSnapshot;
};

/**
 * 本人 Mac 実行の Native の primitive（src-tauri/src/personal_run.rs）と、その代わりの FakeBridge が同じ意味であること・
 * 共有 fixture で TS と Rust の派生が一致することを確かめる（slice 1。production の ports は slice 2）。
 */

const OWNER = "a".repeat(64);
/** 保管庫の版 ID（v_ ＋ 22 字）。 */
const vid = (tag: string) => `v_${tag.padEnd(22, "A")}`;
const AT = "2026-10-17T00:00:00.000Z";

const flow: FlowSnapshot = {
  version: 1,
  id: "flow-1",
  name: "議事録",
  revision: 3,
  guide: "固有名詞を守る",
  terms: [],
  samples: [],
  steps: [
    { id: "outline", name: "要点", instruction: "要点", provider: "claude", profile: "standard" },
    { id: "minutes", name: "議事録", instruction: "整理", provider: "claude", profile: "standard" },
  ],
  models: Object.fromEntries(["outline", "minutes"].map((stepId) => [stepId, {
    provider: "claude" as const,
    model: "claude-sonnet-5",
    effort: "high" as const,
    profileId: "standard",
    profileName: "標準",
    connection: "subscription" as const,
  }])),
};

/** フォルダ `proj1` の録音（ページ `pg1`・録音 `rec1`。ページ id と録音 id は別）と参考ページ。 */
function bridgeWithRecording(): FakeBridge {
  const bridge = new FakeBridge();
  bridge.cloud = { ...bridge.cloud, provider: "niho", status: "active" };
  bridge.projects.set("proj1", {
    project: {
      version: 1,
      id: "proj1",
      name: "案件",
      createdAt: AT,
      info: { terms: [{ term: "朝市", reading: "あさいち", variants: [], note: "" }], background: "朝市の取材" },
      pages: [
        { id: "pg1", kind: "rec", title: "録音", createdAt: AT, recordingId: "rec1" },
        { id: "ref1", kind: "doc", title: "参考の文書", createdAt: AT },
      ],
    },
    transcript: null,
    artifacts: {},
    versions: {},
    runs: [],
    checkpoints: {},
    recordings: {
      rec1: {
        recording: {
          version: 1,
          id: "rec1",
          createdAt: AT,
          flowSnapshot: structuredClone(flow),
          source: { kind: "audio", audio: [{ file: "a1.m4a", hash: "b".repeat(64), name: "a.m4a", durationSec: 5.7 }] },
          speakers: "2",
          language: "ja",
          refs: ["ref1"],
        },
        transcript: null,
        artifacts: {},
        versions: {},
        runs: [],
        checkpoints: {},
      },
    },
    docs: { ref1: "参考の本文" },
  });
  return bridge;
}

function openRequest(fields: Partial<PersonalOpenRequest> = {}): PersonalOpenRequest {
  return {
    projectId: "proj1",
    recordingPageId: "pg1",
    recordingId: "rec1",
    intentId: "intent-1",
    runId: "run-1",
    route: { kind: "local_full" },
    transcriptionProvider: "gemini",
    ...fields,
  };
}

function executionRequest(opened: PersonalOperationInfo): PersonalExecutionRequest {
  return {
    runId: "run-1",
    intentId: "intent-1",
    originDeviceId: "mac-1",
    ownerAccountId: opened.ownerAccountId,
    rootId: opened.rootId,
    containerRef: { kind: "folder", projectId: "proj1" },
    recordingPageId: "pg1",
    recordingId: "rec1",
    route: { kind: "local_full" },
    continuationOfRunId: null,
    consentVersion: "consent-v1",
    stepIds: ["outline", "minutes"],
  };
}

/** テストだけの ports: controller の各段を FakeBridge の personal API へつなぐ（production の ports factory は slice 2）。 */
function bridgePorts(bridge: FakeBridge, opened: PersonalOperationInfo, hooks: { duringGeneration?: (stepId: string) => void } = {}) {
  const handle = opened.handle;
  let fixed: PersonalFixedSnapshot | null = null;
  let aggregate: PersonalRunHistory | null = null;
  const output = (stepId: string, kind: PersonalCandidate["kind"]): PersonalCandidate => ({
    stepId,
    artifactId: kind === "source" ? "source" : stepId,
    kind,
    versionId: vid(stepId),
    path: `recordings/rec1/versions/${stepId}/${vid(stepId)}.md`,
    text: `${stepId} の結果`,
    provider: kind === "source" ? "gemini" : "claude",
    model: kind === "source" ? GEMINI_TRANSCRIPTION_MODEL : "claude-sonnet-5",
  });
  const ports: PersonalExecutionPorts = {
    async flushDirty() {},
    async pullAndSync() { return { complete: true }; },
    async inspectOwnerContext() { return { ownerAccountId: opened.ownerAccountId, rootId: opened.rootId }; },
    async readSnapshotMaterial() { return bridge.personalReadMaterial(handle, { stepIds: ["outline", "minutes"] }); },
    async verifyFixedInputs(snapshot) {
      fixed = snapshot;
      return bridge.personalVerifyInputs(handle, snapshot);
    },
    async reserveIntent(intentId, snapshotSha256) {
      if (fixed?.snapshotSha256 !== snapshotSha256) throw new Error("snapshot mismatch");
      return bridge.personalReserveIntent(handle, intentId, fixed);
    },
    async acquireLease() { return { leaseId: opened.leaseId }; },
    async guardExecution({ snapshot, phase }) { return bridge.personalGuard(handle, phase, snapshot); },
    async releaseLease() { return bridge.personalClose(handle); },
    async executeTranscription() {
      await bridge.personalMarkDispatch(handle, "intent-1", "source");
      return output("source", "source");
    },
    async executeGenerationStep({ stepId }) {
      await bridge.personalMarkDispatch(handle, "intent-1", stepId);
      hooks.duringGeneration?.(stepId);
      return output(stepId, "artifact");
    },
    async persistCandidate({ candidate, sha256, bytes }) { return bridge.personalPersistCandidate(handle, { ...candidate, sha256, bytes }); },
    async casCandidate({ candidate, expectedCurrentArtifactSha, aggregateAfterCommit }) {
      return bridge.personalPublish(handle, {
        intentId: "intent-1",
        stepId: candidate.stepId,
        artifactId: candidate.artifactId,
        kind: candidate.kind,
        candidateVersionId: candidate.versionId,
        expectedCurrentSha: expectedCurrentArtifactSha,
        aggregate: aggregateAfterCommit,
        record: null,
      });
    },
    async nihoApiReadiness() { throw new Error("unused"); },
    async submitNihoContinuation() { throw new Error("unused"); },
    async writeAggregate(history) { aggregate = structuredClone(history); },
    async appendSyncEvent() {},
    async syncOutputAndHistory() {},
    async markIntent(intentId, state) { await bridge.personalMarkIntent(handle, intentId, state); },
    now: () => new Date(AT),
  };
  return ports;
}

describe("共有 fixture（TS と Native の派生が一致する）", () => {
  it("canonical と generationSnapshot・nextStepSnapshot の結果が fixture と一致し、改ざんした派生は hash が違う", async () => {
    for (const sample of fixture.canonicalSamples) expect(canonical(sample.value)).toBe(sample.canonical);
    expect(fixture.transcriptionModels.gemini).toEqual({ provider: "gemini", model: GEMINI_TRANSCRIPTION_MODEL, effort: GEMINI_TRANSCRIPTION_EFFORT });
    // API キーの Gemini だけ固定値に connection を持つ（サブスクリプションは以前と同じ形のまま）
    expect(fixture.transcriptionModels["gemini-api"]).toEqual({
      provider: "gemini",
      model: GEMINI_TRANSCRIPTION_MODEL,
      effort: GEMINI_TRANSCRIPTION_EFFORT,
      connection: "apiKey",
    });
    const original = fixture.original;
    const { snapshotSha256, ...rest } = original;
    expect(await sha256Text(canonical(rest))).toBe(snapshotSha256);
    const generation = await generationSnapshot(original, fixture.sourceVersion);
    expect(generation).toEqual(fixture.generation);
    const next = await nextStepSnapshot(generation, fixture.stepId, fixture.stepVersion);
    expect(next).toEqual(fixture.nextStep);
    expect(fixture.tampered.snapshotSha256).not.toBe(generation.snapshotSha256);
  });

  it("JSON の文字列から読んだ小数は、Native（float_roundtrip）と同じ表記に戻る", () => {
    for (const text of ["9909.206306751727", "0.30000000000000004", "123456.78901234567", "5e-324"]) {
      expect(canonical(JSON.parse(text))).toBe(text);
    }
    expect(canonical(JSON.parse("1.7976931348623157e308"))).toBe("1.7976931348623157e+308");
  });
});

describe("FakeBridge の本人 Mac 実行（Native と同じ意味）", () => {
  it("フォルダ外の録音も docs-root の lease を取る（acquireRunLock と personalOpen）", async () => {
    const bridge = bridgeWithRecording();
    bridge.leaseHeldBy = "Mac Studio";
    await expect(bridge.acquireRunLock(null)).rejects.toMatchObject({ code: "lease_held" });
    await expect(bridge.personalOpen(openRequest())).rejects.toMatchObject({ code: "lease_held", message: expect.stringContaining("Mac Studio") });
    expect(bridge.locks.size).toBe(0);
  });

  it("二重の開始は store_busy、NIHO に届かなければ端末内の文字起こしだけ、閉じるのは一度だけ", async () => {
    const bridge = bridgeWithRecording();
    const opened = await bridge.personalOpen(openRequest());
    expect(opened).toMatchObject({ ownerAccountId: OWNER, cloudLease: true });
    expect(opened.handle).toMatch(/^pop_[0-9]{32}$/);
    expect(opened.leaseId).toMatch(/^ls_[0-9]{22}$/);
    await expect(bridge.personalOpen(openRequest({ intentId: "intent-2" }))).rejects.toMatchObject({ code: "store_busy" });
    await expect(bridge.personalClose(opened.handle)).resolves.toEqual({ released: true, leaseId: opened.leaseId });
    await expect(bridge.personalClose(opened.handle)).resolves.toEqual({ released: false, leaseId: "" });

    bridge.personalLeaseUnavailable = true;
    await expect(bridge.personalOpen(openRequest())).rejects.toMatchObject({ code: "personal_lease_unavailable" });
    const local = await bridge.personalOpen(openRequest({ route: { kind: "local_transcription_only" }, transcriptionProvider: "this-mac" }));
    expect(local.cloudLease).toBe(false);
    await bridge.personalClose(local.handle);

    // ページ id の代わりに録音 id を渡しても開かない・ログインしていなければ開かない
    await expect(bridge.personalOpen(openRequest({ recordingPageId: "rec1" }))).rejects.toMatchObject({ code: "store_no_page" });
    bridge.personalOwner = null;
    await expect(bridge.personalOpen(openRequest({ route: { kind: "local_transcription_only" }, transcriptionProvider: "this-mac" }))).rejects.toMatchObject({ code: "personal_not_signed_in" });
  });

  it("operation を添えた送信は dispatch marker の後だけ・取消の後は送らない", async () => {
    const bridge = bridgeWithRecording();
    const opened = await bridge.personalOpen(openRequest());
    const request = { provider: "claude-code", model: "claude-sonnet-5", effort: null, system_prompt: "s", user_prompt: "u", resume_session: null, workspace: "w", max_budget_usd: null } as unknown as Parameters<FakeBridge["runTurn"]>[1];
    await expect(bridge.runTurn("t0", request, () => undefined, opened.handle)).rejects.toMatchObject({ code: "personal_guard_failed" });
    expect(bridge.turnRequests).toHaveLength(0);
    // operation なしの送信は今までどおり
    await bridge.runTurn("t1", request, () => undefined);
    expect(bridge.turnRequests).toHaveLength(1);
    await bridge.personalCancel(opened.handle);
    await expect(bridge.runTurn("t2", request, () => undefined, opened.handle)).rejects.toMatchObject({ code: "personal_guard_failed" });
    expect(bridge.turnRequests).toHaveLength(1);
    await bridge.personalClose(opened.handle);
  });
});

describe("controller と Native の guard（FakeBridge）", () => {
  it("原文・各工程を公開し、派生した固定入力を guard が受け入れて最後まで進む", async () => {
    const bridge = bridgeWithRecording();
    const opened = await bridge.personalOpen(openRequest());
    const execute = createPersonalExecutionController(bridgePorts(bridge, opened));
    await expect(execute(executionRequest(opened))).resolves.toMatchObject({ state: "completed", transcriptionExecutions: 1 });
    const stored = bridge.recording("proj1", "rec1");
    expect(stored.transcript).toBe("source の結果");
    expect(stored.artifacts).toEqual({ outline: "outline の結果", minutes: "minutes の結果" });
    const rows = stored.runs as Array<RunRecord & { personalRunId?: string; origin?: string }>;
    expect(rows.map((row) => [row.stepId, row.version, row.personalRunId, row.origin])).toEqual([
      ["source", 1, "run-1", "this_pc"],
      ["outline", 1, "run-1", "this_pc"],
      ["minutes", 1, "run-1", "this_pc"],
    ]);
    expect(bridge.personalLeaseReleases).toEqual([opened.leaseId]);
    expect(bridge.locks.size).toBe(0);
  });

  it("版になっていない手直しの文字起こしは、受付時のまま変わっていなければ input_changed にせず、手直しを版に残して公開する", async () => {
    const bridge = bridgeWithRecording();
    const stored = bridge.recording("proj1", "rec1");
    stored.versions.source = ["元の原文"];
    stored.runs.push({ id: "run-old", kind: "run", at: AT, stepId: "source", stepName: "文字起こし", version: 1, result: "saved" });
    stored.transcript = "手直しした原文";
    const opened = await bridge.personalOpen(openRequest());
    const execute = createPersonalExecutionController(bridgePorts(bridge, opened));
    await expect(execute(executionRequest(opened))).resolves.toMatchObject({ state: "completed" });
    expect(stored.transcript).toBe("source の結果");
    expect(stored.versions.source).toEqual(["元の原文", "手直しした原文", "source の結果"]);
  });

  it("AI を待っている間にアカウントが変わったら ACCOUNT_CHANGED で止め、候補は残し、旧本人の通信で lease を返さない", async () => {
    const bridge = bridgeWithRecording();
    const opened = await bridge.personalOpen(openRequest());
    const execute = createPersonalExecutionController(bridgePorts(bridge, opened, {
      duringGeneration: (stepId) => { if (stepId === "outline") bridge.switchPersonalAccount("c".repeat(64)); },
    }));
    await expect(execute(executionRequest(opened))).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    const stored = bridge.recording("proj1", "rec1");
    expect(stored.transcript).toBe("source の結果");
    expect(stored.artifacts.outline).toBeUndefined();
    expect(bridge.personalVersionFiles.get(`proj1/recordings/rec1/versions/outline/${vid("outline")}.md`)).toBe("outline の結果");
    expect(bridge.personalLeaseReleases).toEqual([]);
    expect(bridge.locks.size).toBe(0);
  });

  it("lease を失ったら LEASE_LOST で止める", async () => {
    const bridge = bridgeWithRecording();
    const opened = await bridge.personalOpen(openRequest());
    const execute = createPersonalExecutionController(bridgePorts(bridge, opened, {
      duringGeneration: () => bridge.losePersonalLease(opened.handle),
    }));
    await expect(execute(executionRequest(opened))).rejects.toMatchObject({ code: "LEASE_LOST" });
    expect(bridge.recording("proj1", "rec1").artifacts.outline).toBeUndefined();
  });

  it("受け付けた固定入力から改ざんした派生は受け入れず、INPUT_CHANGED になる hash を返す", async () => {
    const bridge = bridgeWithRecording();
    const opened = await bridge.personalOpen(openRequest());
    const ports = bridgePorts(bridge, opened);
    const material = await ports.readSnapshotMaterial(executionRequest(opened));
    const { buildPersonalFixedSnapshot } = await import("../src/lib/personal-execution");
    const snapshot = await buildPersonalFixedSnapshot(executionRequest(opened), material);
    // 素材で読んだ音声と違う固定入力（音声を外して hash を付け直した）は受け付けない
    const { snapshotSha256: _audioHash, ...withoutAudioHash } = { ...snapshot, input: { ...snapshot.input, audio: [] } };
    const noAudio = { ...withoutAudioHash, snapshotSha256: await sha256Text(canonical(withoutAudioHash)) } as PersonalFixedSnapshot;
    await expect(bridge.personalReserveIntent(opened.handle, "intent-1", noAudio)).rejects.toMatchObject({ code: "personal_snapshot_mismatch" });
    await expect(bridge.personalReserveIntent(opened.handle, "intent-1", snapshot)).resolves.toEqual({ status: "new" });
    await expect(bridge.personalReadMaterial(opened.handle, { stepIds: [] })).rejects.toMatchObject({ code: "personal_material_locked" });
    await expect(bridge.personalReserveIntent(opened.handle, "intent-1", snapshot)).resolves.toEqual({ status: "existing", state: "running" });
    const swapped = structuredClone(snapshot);
    swapped.fixedModels.outline = { ...swapped.fixedModels.outline!, model: "claude-opus-5" };
    const { snapshotSha256: _ignored, ...rest } = swapped;
    swapped.snapshotSha256 = await sha256Text(canonical(rest));
    const checked = await bridge.personalGuard(opened.handle, "before_dispatch", swapped);
    expect(checked.snapshotSha256).toBe(snapshot.snapshotSha256);
    await bridge.personalClose(opened.handle);
    // 受け付けたまま送らずに閉じた intent は、閉じた後（再起動と同じ）に同じ固定入力なら再開できる（Native と同じ）
    const reopened = await bridge.personalOpen(openRequest());
    await bridge.personalReadMaterial(reopened.handle, { stepIds: ["outline", "minutes"] });
    await expect(bridge.personalReserveIntent(reopened.handle, "intent-1", snapshot)).resolves.toEqual({ status: "resumed" });
    await expect(bridge.personalReserveIntent(reopened.handle, "intent-1", snapshot)).resolves.toEqual({ status: "existing", state: "running" });
    await bridge.personalClose(reopened.handle);
  });
});
