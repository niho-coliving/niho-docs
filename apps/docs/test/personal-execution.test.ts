import { describe, expect, it } from "vitest";
import type { FlowSnapshot } from "@niho/docs-core";
import {
  PersonalCancellationError,
  PersonalDispatchError,
  PersonalAuthenticationRequiredError,
  PersonalRemoteRejectionError,
  buildPersonalFixedSnapshot,
  canonical,
  createPersonalExecutionController,
  projectPersonalRunEvent,
  sha256Text,
  type PersonalCandidate,
  type PersonalExecutionPorts,
  type PersonalExecutionRequest,
  type PersonalRunEvent,
  type PersonalRunHistory,
  type PersonalSnapshotMaterial,
  type PersonalStoredCandidate,
  type PersonalVersionRef,
} from "../src/lib/personal-execution";

const H = "a".repeat(64);
const flow: FlowSnapshot = {
  version: 1,
  id: "flow-1",
  name: "議事録",
  revision: 7,
  guide: "固有名詞を守る",
  terms: [],
  samples: [],
  steps: [
    { id: "outline", name: "要点", instruction: "要点", provider: "gpt", profile: "standard" },
    { id: "minutes", name: "議事録", instruction: "整理", provider: "gpt", profile: "standard" },
  ],
  models: Object.fromEntries(["outline", "minutes"].map((stepId) => [stepId, {
    provider: "gpt" as const,
    model: "gpt-5.6-terra",
    effort: "high" as const,
    profileId: "standard",
    profileName: "標準",
    connection: "subscription" as const,
  }])),
};

function request(route: PersonalExecutionRequest["route"] = { kind: "generation_only", executor: "this_pc" }): PersonalExecutionRequest {
  return {
    runId: "run-1",
    intentId: "intent-1",
    originDeviceId: "mac-1",
    ownerAccountId: "account-1",
    rootId: "root-1",
    containerRef: { kind: "folder", projectId: "folder-1" },
    recordingPageId: "page-1",
    recordingId: "recording-1",
    route,
    continuationOfRunId: route.kind === "generation_only" ? "run-source" : null,
    consentVersion: "consent-v1",
    stepIds: route.kind === "local_transcription_only" ? [] : ["outline", "minutes"],
  };
}

function source(synced = true): NonNullable<PersonalSnapshotMaterial["sourceVersion"]> {
  return {
    versionId: "source-v1",
    path: "recordings/recording-1/versions/source/shared/source-v1.md",
    content: "確定原文",
    originRunId: "run-source",
    origin: "shared_mac",
    synced,
  };
}

function material(route: PersonalExecutionRequest["route"]): PersonalSnapshotMaterial {
  const generation = route.kind === "generation_only";
  return {
    baseManifestRevision: 12,
    recordingMetadata: { speakers: "2", language: "ja", background: "朝市", terms: [] },
    flow: structuredClone(flow),
    audio: generation ? [] : [{ path: "recordings/recording-1/inputs/audio.wav", sha256: H, bytes: 187882, durationSec: 5.7, verification: "native_sha256" }],
    transcriptionModel: generation ? null : { provider: "gemini", model: "gemini-3.8-flash", effort: "low" },
    sourceVersion: generation ? { ...source(), ...(route.kind === "generation_only" && route.executor === "niho_api" ? { origin: "this_pc" as const } : {}) } : null,
    referencePages: [{ pageId: "ref-1", path: "pages/ref-1.md", versionId: "ref-v1", content: "参考" }],
    priorSteps: [],
    expectedCurrentArtifactShaByStep: { outline: null, minutes: null },
  };
}

function candidate(stepId: string, kind: "source" | "artifact" = "artifact"): PersonalCandidate {
  return {
    stepId,
    artifactId: kind === "source" ? "source" : stepId,
    kind,
    versionId: `${stepId}-candidate-v1`,
    path: `recordings/recording-1/versions/${stepId}/candidate-v1.md`,
    text: `${stepId} の結果`,
    provider: kind === "source" ? "gemini" : "gpt",
    model: kind === "source" ? "gemini-3.8-flash" : "gpt-5.6-terra",
  };
}

function harness(route: PersonalExecutionRequest["route"] = { kind: "generation_only", executor: "this_pc" }) {
  const trace: string[] = [];
  const histories: PersonalRunHistory[] = [];
  const casAggregates: PersonalRunHistory[] = [];
  const persisted: PersonalStoredCandidate[] = [];
  const events: PersonalRunEvent[] = [];
  const states = new Map<string, PersonalRunHistory["state"]>();
  const reservedSnapshots = new Map<string, string>();
  const submissions: Parameters<PersonalExecutionPorts["submitNihoContinuation"]>[0][] = [];
  let fixedMaterial = material(route);
  let generationErrorAt = 0;
  let generationCalls = 0;
  let transcriptionCalls = 0;
  let casChangedAt = 0;
  let guardFailure: { phase: string; call: number; kind: "cancel" | "lease" | "input" | "account" } | null = null;
  let guardCalls = 0;
  let remoteError: unknown = null;
  let release = { released: true, leaseId: "lease-1" };
  let syncComplete = true;
  let identity = { ownerAccountId: "account-1", rootId: "root-1" };
  let verify = true;
  let casCalls = 0;
  const ports: PersonalExecutionPorts = {
    async flushDirty() { trace.push("flush"); },
    async pullAndSync() { trace.push("pull"); return { complete: syncComplete }; },
    async inspectOwnerContext() { trace.push("identity"); return identity; },
    async readSnapshotMaterial() { trace.push("read"); return fixedMaterial; },
    async verifyFixedInputs() { trace.push("verify"); return { verified: verify }; },
    async reserveIntent(intentId, snapshotSha256) {
      trace.push("reserve");
      const state = states.get(intentId);
      if (state === "waiting_auth" && reservedSnapshots.get(intentId) === snapshotSha256) {
        states.set(intentId, "running");
        return { status: "resumed" as const };
      }
      if (state) return { status: "existing" as const, state };
      reservedSnapshots.set(intentId, snapshotSha256);
      return { status: "new" as const };
    },
    async acquireLease() { trace.push("acquire"); return { leaseId: "lease-1" }; },
    async guardExecution({ snapshot, leaseId, phase }) {
      guardCalls++;
      trace.push(`guard:${phase}`);
      const hit = guardFailure?.phase === phase && guardFailure.call === guardCalls;
      return {
        ownerAccountId: hit && guardFailure?.kind === "account" ? "other" : snapshot.ownerAccountId,
        rootId: snapshot.rootId,
        snapshotSha256: hit && guardFailure?.kind === "input" ? H : snapshot.snapshotSha256,
        leaseId: hit && guardFailure?.kind === "lease" ? "lease-other" : leaseId,
        cancelled: Boolean(hit && guardFailure?.kind === "cancel"),
      };
    },
    async releaseLease(_request, leaseId) { trace.push(`release:${leaseId}`); return release; },
    async executeTranscription() { transcriptionCalls++; trace.push("transcribe"); return candidate("source", "source"); },
    async executeGenerationStep({ snapshot, stepId }) {
      generationCalls++;
      trace.push(`generate:${stepId}:${snapshot.input.priorSteps.map((item) => item.stepId).join("+")}`);
      if (generationErrorAt === generationCalls) throw new PersonalDispatchError(true, "結果不明");
      return candidate(stepId);
    },
    async persistCandidate({ candidate: raw, sha256, bytes }) {
      trace.push(`persist:${raw.stepId}`);
      const stored = { ...raw, text: undefined, sha256, bytes, immutable: true as const };
      delete (stored as { text?: string }).text;
      persisted.push(stored);
      return stored;
    },
    async casCandidate({ candidate: stored, expectedCurrentArtifactSha, aggregateAfterCommit }) {
      casCalls++;
      casAggregates.push(structuredClone(aggregateAfterCommit));
      trace.push(`cas:${stored.stepId}:${expectedCurrentArtifactSha ?? "empty"}`);
      if (casChangedAt === casCalls) return { status: "input_changed" as const, reason: "手修正" };
      return {
        status: "committed" as const,
        version: {
          versionId: stored.versionId,
          path: stored.path,
          sha256: stored.sha256,
          bytes: stored.bytes,
          originRunId: "run-1",
          origin: "this_pc" as const,
        },
      };
    },
    async nihoApiReadiness() { trace.push("remote-ready"); return { ready: true }; },
    async submitNihoContinuation(payload) {
      trace.push(`submit:${payload.audio.length}`);
      submissions.push(structuredClone(payload));
      if (remoteError) throw remoteError;
      return { runId: "remote-1", state: "queued" };
    },
    async writeAggregate(history) { histories.push(structuredClone(history)); },
    async appendSyncEvent({ event }) { events.push(structuredClone(event)); },
    async syncOutputAndHistory() { trace.push("sync-output"); },
    async markIntent(intentId, state) { states.set(intentId, state); trace.push(`intent:${state}`); },
    now: () => new Date("2026-10-16T00:00:00.000Z"),
  };
  return {
    execute: createPersonalExecutionController(ports), ports, trace, histories, casAggregates, persisted, events, states, submissions,
    get counts() { return { generationCalls, transcriptionCalls, casCalls }; },
    setGenerationErrorAt(value: number) { generationErrorAt = value; },
    setCasChangedAt(value: number) { casChangedAt = value; },
    setGuardFailure(value: typeof guardFailure) { guardFailure = value; },
    setRemoteError(value: unknown) { remoteError = value; },
    setMaterial(value: PersonalSnapshotMaterial) { fixedMaterial = value; },
    setRelease(value: typeof release) { release = value; },
    setSync(value: boolean) { syncComplete = value; },
    setIdentity(value: typeof identity) { identity = value; },
    setVerify(value: boolean) { verify = value; },
  };
}

describe("R6 personal execution controller", () => {
  it("local fullは原文と各工程を1つずつ保存・CAS・同期し、確定版を次工程basisへ足す", async () => {
    const route = { kind: "local_full" } as const;
    const h = harness(route);
    const got = await h.execute(request(route));
    expect(got).toMatchObject({ state: "completed", transcriptionExecutions: 1 });
    expect(h.trace).toContain("generate:outline:");
    expect(h.trace).toContain("generate:minutes:outline");
    expect(h.persisted.map((item) => item.stepId)).toEqual(["source", "outline", "minutes"]);
    expect(h.events.map((item) => item.stepId)).toEqual(["source", "outline", "minutes"]);
  });

  it("transcription-onlyは後続を実行せず正常成功する", async () => {
    const route = { kind: "local_transcription_only" } as const;
    const h = harness(route);
    await expect(h.execute(request(route))).resolves.toMatchObject({ state: "transcription_complete", transcriptionExecutions: 1 });
    expect(h.counts).toEqual({ transcriptionCalls: 1, generationCalls: 0, casCalls: 1 });
  });

  it("共有Macの確定原文からlocal continuationを実行し、音声期限切れでも再文字起こししない", async () => {
    const h = harness();
    await expect(h.execute(request())).resolves.toMatchObject({ state: "completed", transcriptionExecutions: 0 });
    expect(h.counts.transcriptionCalls).toBe(0);
    expect(h.histories.at(-1)?.continuationOfRunId).toBe("run-source");
  });

  it("公開（CAS）へ渡す集約は確定後の形で、候補は retainedCandidates から versions へ移っている", async () => {
    const h = harness();
    await expect(h.execute(request())).resolves.toMatchObject({ state: "completed" });
    expect(h.casAggregates.length).toBeGreaterThan(0);
    for (const aggregate of h.casAggregates) {
      expect(aggregate.retainedCandidates).toEqual([]);
      expect(aggregate.versions.length).toBeGreaterThan(0);
    }
    expect(h.casAggregates[0]?.versions.at(-1)).toMatchObject({ versionId: "outline-candidate-v1", origin: "this_pc" });
    expect(h.casAggregates.at(-1)?.versions).toEqual(h.histories.at(-1)?.versions);
  });

  it("文字起こしの公開に渡す集約は確定原文を sourceVersion に持つ", async () => {
    const route = { kind: "local_transcription_only" } as const;
    const h = harness(route);
    await expect(h.execute(request(route))).resolves.toMatchObject({ state: "transcription_complete" });
    expect(h.casAggregates[0]?.sourceVersion).toMatchObject({ versionId: "source-candidate-v1" });
    expect(h.casAggregates[0]?.retainedCandidates).toEqual([]);
  });

  it("2工程目の結果不明でも1工程目の版・event・同期を残して自動再送しない", async () => {
    const h = harness();
    h.setGenerationErrorAt(2);
    await expect(h.execute(request())).rejects.toMatchObject({ resultUnknown: true });
    expect(h.persisted.map((item) => item.stepId)).toEqual(["outline"]);
    expect(h.events.map((item) => item.stepId)).toEqual(["outline", "execution"]);
    expect(h.events.at(-1)).toMatchObject({ state: "result_unknown", reasonCode: "ResultUnknown" });
    expect(h.histories.at(-1)).toMatchObject({ state: "result_unknown", versions: [{ versionId: "outline-candidate-v1" }] });
    await expect(h.execute(request())).rejects.toMatchObject({ code: "RESULT_UNKNOWN_NO_RETRY" });
    expect(h.counts.generationCalls).toBe(2);
  });

  it("NIHO APIはallowlistとaudio空を受付送信するだけでlocal生成/CASせずsubmittedを記録する", async () => {
    const route = { kind: "generation_only", executor: "niho_api" } as const;
    const h = harness(route);
    await expect(h.execute(request(route))).resolves.toMatchObject({ state: "submitted", remoteRunId: "remote-1", remoteState: "queued" });
    expect(h.trace).toContain("submit:0");
    expect(h.submissions[0]).toMatchObject({
      baseManifestRevision: 12,
      expectedCurrentArtifactShaByStep: { outline: null, minutes: null },
    });
    expect(h.counts).toEqual({ transcriptionCalls: 0, generationCalls: 0, casCalls: 0 });
    expect(h.trace.at(-1)).toBe("release:lease-1");
  });

  it("NIHO APIへmanifest revisionと工程別CAS hashを渡す", async () => {
    const route = { kind: "generation_only", executor: "niho_api" } as const;
    const h = harness(route);
    const m = material(route);
    m.expectedCurrentArtifactShaByStep = { outline: H, minutes: null };
    h.setMaterial(m);
    await h.execute(request(route));
    expect(h.submissions[0]).toMatchObject({
      baseManifestRevision: 12,
      expectedCurrentArtifactShaByStep: { outline: H, minutes: null },
    });
  });

  it("NIHO APIの確定拒否はfailed、受付応答消失はresult_unknownとして同intent再送を止める", async () => {
    const route = { kind: "generation_only", executor: "niho_api" } as const;
    const rejected = harness(route);
    rejected.setRemoteError(new PersonalRemoteRejectionError("拒否"));
    await expect(rejected.execute(request(route))).rejects.toBeInstanceOf(PersonalRemoteRejectionError);
    expect(rejected.states.get("intent-1")).toBe("failed");
    const unknown = harness(route);
    unknown.setRemoteError(new PersonalDispatchError(true, "応答消失"));
    await expect(unknown.execute(request(route))).rejects.toMatchObject({ resultUnknown: true });
    expect(unknown.states.get("intent-1")).toBe("result_unknown");
    await expect(unknown.execute(request(route))).rejects.toMatchObject({ code: "RESULT_UNKNOWN_NO_RETRY" });
    expect(unknown.trace.filter((value) => value === "submit:0")).toHaveLength(1);
    const malformed = harness(route);
    malformed.ports.submitNihoContinuation = async () => ({ runId: "remote-2", state: "unknown-state" as never });
    await expect(malformed.execute(request(route))).rejects.toMatchObject({ resultUnknown: true });
    expect(malformed.states.get("intent-1")).toBe("result_unknown");
  });

  it("NIHO APIは確定source版の同期完了前には受付へ送らない", async () => {
    const route = { kind: "generation_only", executor: "niho_api" } as const;
    const h = harness(route);
    const m = material(route);
    m.sourceVersion = { ...source(false), origin: "this_pc" };
    h.setMaterial(m);
    await expect(h.execute(request(route))).rejects.toMatchObject({ code: "SOURCE_NOT_SYNCED" });
    expect(h.trace.some((value) => value.startsWith("submit:"))).toBe(false);
  });

  it("候補本文の実SHA/bytesを耐久保存してからCASし、手修正競合では候補を残して上書きしない", async () => {
    const h = harness();
    h.setCasChangedAt(1);
    await expect(h.execute(request())).resolves.toMatchObject({ state: "input_changed" });
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]).toMatchObject({ sha256: await sha256Text("outline の結果"), bytes: new TextEncoder().encode("outline の結果").byteLength, immutable: true });
    expect(h.events).toMatchObject([{ state: "input_changed", version: { versionId: "outline-candidate-v1" } }]);
    expect(h.histories.at(-1)?.retainedCandidates).toMatchObject([{ versionId: "outline-candidate-v1" }]);
  });

  it("再文字起こしのCASは受付時の既存source SHAを照合する", async () => {
    const route = { kind: "local_full" } as const;
    const h = harness(route);
    const m = material(route);
    m.sourceVersion = source();
    h.setMaterial(m);
    const expected = await sha256Text("確定原文");
    await h.execute(request(route));
    expect(h.trace).toContain(`cas:source:${expected}`);
  });

  it("選択工程の入力順ではなく固定フロー順で実行する", async () => {
    const r = request();
    r.stepIds = ["minutes", "outline"];
    const snapshot = await buildPersonalFixedSnapshot(r, material(r.route));
    expect(snapshot.selectedStepIds).toEqual(["outline", "minutes"]);
  });

  it("残りの工程と別案を一緒に実行しても、別案の保存先は対象工程だけに使う", async () => {
    const h = harness();
    const r = request();
    r.outputTarget = { stepId: "minutes", candidateId: "candidate-b", artifactId: "artifact-b", inputVersions: {} };
    const execute = h.ports.executeGenerationStep;
    h.ports.executeGenerationStep = async (input) => {
      const output = await execute(input);
      return input.stepId === "minutes" ? { ...output, artifactId: "artifact-b", path: output.path.replace("/minutes/", "/artifact-b/") } : output;
    };
    await h.execute(r);
    expect(h.persisted.map((output) => [output.stepId, output.artifactId])).toEqual([["outline", "outline"], ["minutes", "artifact-b"]]);
    expect(h.events.map((event) => event.stepId)).toEqual(["outline", "minutes"]);
  });

  it("generation_onlyの原文は指定したcontinuation元Runの版に限る", async () => {
    const route = { kind: "generation_only", executor: "this_pc" } as const;
    const r = request(route);
    const m = material(route);
    m.sourceVersion = { ...m.sourceVersion!, originRunId: "another-run" };
    await expect(buildPersonalFixedSnapshot(r, m)).rejects.toMatchObject({ code: "SOURCE_RUN_MISMATCH" });
  });

  it.each([
    ["別provider", { ...candidate("outline"), provider: "claude" as const, model: "claude-sonnet-4-6" }],
    ["別model", { ...candidate("outline"), model: "gpt-5.6-luna" }],
    ["別reportedModel", { ...candidate("outline"), reportedModel: "gpt-5.6-luna" }],
  ] as const)("%sの候補は固定stepへ保存しない", async (_name, wrong) => {
    const h = harness();
    h.ports.executeGenerationStep = async () => wrong;
    await expect(h.execute(request())).rejects.toMatchObject({ code: "CANDIDATE_MODEL_MISMATCH" });
    expect(h.persisted).toHaveLength(0);
    expect(h.counts.casCalls).toBe(0);
  });

  it("Geminiの固定base modelと一致するreported effort別名を保持したままcontrollerでCASできる", async () => {
    const route = { kind: "local_full" } as const;
    const h = harness(route);
    h.ports.executeTranscription = async () => ({
      ...candidate("source", "source"),
      model: "gemini-3.8-flash",
      reportedModel: "gemini-3.8-flash-low",
    });
    await expect(h.execute(request(route))).resolves.toMatchObject({ state: "completed", transcriptionExecutions: 1 });
    expect(h.persisted[0]).toMatchObject({
      stepId: "source",
      model: "gemini-3.8-flash",
      reportedModel: "gemini-3.8-flash-low",
    });
    expect(h.counts.casCalls).toBe(3);
  });

  it("文字起こし候補も固定したエンジン・モデルと一致しなければ保存しない", async () => {
    const route = { kind: "local_full" } as const;
    const h = harness(route);
    const m = material(route);
    m.transcriptionModel = { provider: "this-mac", model: "niho-speech" };
    h.setMaterial(m);
    await expect(h.execute(request(route))).rejects.toMatchObject({ code: "CANDIDATE_MODEL_MISMATCH" });
    expect(h.persisted).toHaveLength(0);
  });

  it("認証待ちは同じintentで再開し、再ログイン後の全guardを再実行する", async () => {
    const h = harness();
    let calls = 0;
    h.ports.executeGenerationStep = async ({ stepId }) => {
      if (++calls === 1) throw new PersonalAuthenticationRequiredError();
      return candidate(stepId);
    };
    await expect(h.execute(request())).rejects.toBeInstanceOf(PersonalAuthenticationRequiredError);
    expect(h.states.get("intent-1")).toBe("waiting_auth");
    expect(h.events.at(-1)).toMatchObject({ state: "waiting_auth", reasonCode: "not_authenticated" });
    await expect(h.execute(request())).resolves.toMatchObject({ state: "completed" });
    expect(calls).toBe(3);
    expect(h.trace.filter((item) => item === "reserve")).toHaveLength(2);
    expect(h.trace.filter((item) => item === "verify")).toHaveLength(2);
    expect(h.trace.filter((item) => item === "guard:before_dispatch")).toHaveLength(3);
  });

  it.each([
    ["failed", new PersonalDispatchError(false, "事前確認に失敗")],
    ["canceled", new PersonalCancellationError()],
  ] as const)("候補作成前の%sを同期イベントへ記録する", async (state, error) => {
    const h = harness();
    h.ports.executeGenerationStep = async () => { throw error; };
    await expect(h.execute(request())).rejects.toBe(error);
    expect(h.events.at(-1)).toMatchObject({ state, stepId: "execution" });
  });

  it.each(["cancel", "lease", "input", "account"] as const)("dispatch後の%s guard拒否でも候補を保存しCASしない", async (kind) => {
    const h = harness();
    h.setGuardFailure({ phase: "before_persist", call: 2, kind });
    await expect(h.execute(request())).rejects.toBeTruthy();
    expect(h.persisted.map((item) => item.stepId)).toEqual(["outline"]);
    expect(h.histories.at(-1)?.retainedCandidates).toMatchObject([{ versionId: "outline-candidate-v1" }]);
    expect(h.events[0]?.version?.path).toBe(h.persisted[0]?.path);
    expect(h.counts.casCalls).toBe(0);
  });

  it("取消は次工程dispatchを止め、成功済み1工程目を残す", async () => {
    const h = harness();
    h.setGuardFailure({ phase: "before_dispatch", call: 4, kind: "cancel" });
    await expect(h.execute(request())).rejects.toBeInstanceOf(PersonalCancellationError);
    expect(h.counts.generationCalls).toBe(1);
    expect(h.events.map((event) => event.stepId)).toEqual(["outline", "execution"]);
    expect(h.events.at(-1)).toMatchObject({ state: "canceled", reasonCode: "Canceled" });
  });

  it("同期未完了・account切替・固定版未検証をlease前にfail closedする", async () => {
    const sync = harness(); sync.setSync(false);
    await expect(sync.execute(request())).rejects.toMatchObject({ code: "SYNC_INCOMPLETE" });
    const account = harness(); account.setIdentity({ ownerAccountId: "other", rootId: "root-1" });
    await expect(account.execute(request())).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    const verify = harness(); verify.setVerify(false);
    await expect(verify.execute(request())).rejects.toMatchObject({ code: "FIXED_INPUT_NOT_VERIFIED" });
  });

  it("別leaseIdの解放を成功扱いにしない", async () => {
    const h = harness();
    h.setRelease({ released: true, leaseId: "other" });
    await expect(h.execute(request())).rejects.toMatchObject({ code: "LEASE_RELEASE_MISMATCH" });
  });

  it("同じintentの二重クリックをin-flightで止め、外部送信を1回にする", async () => {
    const h = harness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    h.ports.executeGenerationStep = async ({ stepId }) => { calls++; await gate; return candidate(stepId); };
    const first = h.execute(request());
    await expect(h.execute(request())).rejects.toMatchObject({ code: "DUPLICATE_IN_PROGRESS" });
    release();
    await first;
    expect(calls).toBe(2); // 選択した2工程を各1回。二重クリック分は0回。
  });
});

describe("R6 fixed snapshot validation and history projection", () => {
  it("secretらしい追加fieldをspreadせずallowlistだけを固定する", async () => {
    const r = request();
    const m = material(r.route) as PersonalSnapshotMaterial & { token: string; settings: object; workspace: string };
    m.token = "secret"; m.settings = { apiKey: "secret" }; m.workspace = "/Users/me";
    const json = JSON.stringify(await buildPersonalFixedSnapshot(r, m));
    expect(json).not.toContain("secret");
    expect(json).not.toContain("workspace");
  });

  it.each(["settings.json", ".agents/secret.md", "local-ai/workspace/a.md", "../escape.md", "recordings\\recording-1\\versions\\source\\a.md", "https://example.test/a.md", "recordings/other/versions/source/a.md"])("許可外source path %s を拒否する", async (path) => {
    const r = request(); const m = material(r.route); m.sourceVersion!.path = path;
    await expect(buildPersonalFixedSnapshot(r, m)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("slash ID、別step path、unknown executor/provider/originをruntimeで拒否する", async () => {
    const badId = request(); badId.recordingId = "bad/id";
    await expect(buildPersonalFixedSnapshot(badId, material(badId.route))).rejects.toMatchObject({ code: "INVALID_ID" });
    const badPrior = request(); const prior = material(badPrior.route);
    prior.priorSteps = [{ stepId: "outline", versionId: "v1", path: "recordings/recording-1/versions/minutes/v1.md", content: "x" }];
    await expect(buildPersonalFixedSnapshot(badPrior, prior)).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    const badRoute = request(); badRoute.route = { kind: "generation_only", executor: "other" } as never;
    await expect(buildPersonalFixedSnapshot(badRoute, material({ kind: "generation_only", executor: "this_pc" }))).rejects.toMatchObject({ code: "UNKNOWN_EXECUTOR" });
    const badOrigin = request(); const origin = material(badOrigin.route); origin.sourceVersion!.origin = "cloud" as never;
    await expect(buildPersonalFixedSnapshot(badOrigin, origin)).rejects.toMatchObject({ code: "UNKNOWN_ORIGIN" });
    const h = harness(); h.ports.executeGenerationStep = async () => ({ ...candidate("outline"), provider: "mystery" as never });
    await expect(h.execute(request())).rejects.toMatchObject({ code: "UNKNOWN_PROVIDER" });
  });

  it("工程ごとのexpected SHAを要求し、1つの共通値へ潰さない", async () => {
    const r = request(); const m = material(r.route);
    m.expectedCurrentArtifactShaByStep = { outline: H, minutes: "b".repeat(64) };
    const snapshot = await buildPersonalFixedSnapshot(r, m);
    expect(snapshot.input.expectedCurrentArtifactShaByStep).toEqual({ outline: H, minutes: "b".repeat(64) });
    const h = harness(); h.setMaterial(m);
    await h.execute(r);
    expect(h.trace).toContain(`cas:outline:${H}`);
    expect(h.trace).toContain(`cas:minutes:${"b".repeat(64)}`);
    delete m.expectedCurrentArtifactShaByStep.minutes;
    await expect(buildPersonalFixedSnapshot(r, m)).rejects.toMatchObject({ code: "EXPECTED_SHA_MISSING" });
  });

  it("source/参考の固定hash不一致と、source・参考・flowいずれかの実行中変更を拒否する", async () => {
    const sourceRequest = request(); const changedSource = material(sourceRequest.route);
    changedSource.sourceVersion!.expectedSha256 = H;
    await expect(buildPersonalFixedSnapshot(sourceRequest, changedSource)).rejects.toMatchObject({ code: "INPUT_HASH_MISMATCH" });
    const changedReference = material(sourceRequest.route);
    changedReference.referencePages[0]!.expectedSha256 = H;
    await expect(buildPersonalFixedSnapshot(sourceRequest, changedReference)).rejects.toMatchObject({ code: "INPUT_HASH_MISMATCH" });
    for (const _changed of ["source", "reference", "flow"] as const) {
      const h = harness();
      h.setGuardFailure({ phase: "before_dispatch", call: 1, kind: "input" });
      await expect(h.execute(request())).rejects.toMatchObject({ code: "INPUT_CHANGED" });
      expect(h.counts.generationCalls).toBe(0);
    }
  });

  it("immutable eventをstable IDの既存RunRecordへprojectionしprovenanceを保持する", async () => {
    const version: PersonalVersionRef = { versionId: "v1", path: "recordings/recording-1/versions/outline/v1.md", sha256: H, bytes: 10, originRunId: "run-1", origin: "this_pc" };
    const event: PersonalRunEvent = {
      schemaVersion: 1, eventId: "event-1", runId: "run-1", originDeviceId: "mac-1", stepId: "outline", stepName: "要点", state: "completed",
      at: "2026-10-16T00:00:00.000Z", continuationOfRunId: "run-source", inputBasisSha256: H, sourceVersion: { ...version, versionId: "source-v1", path: "recordings/recording-1/versions/source/v1.md" }, version, remoteRunId: null,
    };
    const first = await projectPersonalRunEvent(event);
    expect(await projectPersonalRunEvent(event)).toEqual(first);
    expect(first).toMatchObject({ id: "event-1", eventId: "event-1", continuationOfRunId: "run-source", inputBasisSha256: H, sourceVersionId: "source-v1", sourceVersionPath: "recordings/recording-1/versions/source/v1.md", sourceVersionSha256: H, versionPath: version.path, versionSha256: H });
    expect(await projectPersonalRunEvent({ ...event, state: "submitted", version: null })).toBeNull();
    expect(await projectPersonalRunEvent({ ...event, state: "running", version: null })).toBeNull();
    expect(await projectPersonalRunEvent({ ...event, state: "waiting_auth", version: null })).toBeNull();
  });

  it("通常の通信例外や受付後の記録失敗も結果不明として保持する", async () => {
    const route = { kind: "generation_only", executor: "niho_api" } as const;
    const disconnected = harness(route);
    disconnected.setRemoteError(new Error("connection reset"));
    await expect(disconnected.execute(request(route))).rejects.toMatchObject({ resultUnknown: true });
    expect(disconnected.states.get("intent-1")).toBe("result_unknown");
    const acknowledged = harness(route);
    let writes = 0;
    acknowledged.ports.writeAggregate = async () => { if (++writes === 2) throw new Error("disk unavailable"); };
    await expect(acknowledged.execute(request(route))).rejects.toThrow("disk unavailable");
    expect(acknowledged.states.get("intent-1")).toBe("result_unknown");
  });

  it.each(["waiting_runner", "waiting_capacity", "waiting_auth", "needs_budget_action", "needs_storage_action"] as const)("R0の%sを置換せず受付状態として保持する", async (state) => {
    const route = { kind: "generation_only", executor: "niho_api" } as const;
    const h = harness(route);
    h.ports.submitNihoContinuation = async () => ({ runId: "remote-1", state });
    await expect(h.execute(request(route))).resolves.toMatchObject({ state: "submitted", remoteState: state });
    expect(h.counts.generationCalls).toBe(0);
  });
});

describe("原子公開の port（publishCandidate）", () => {
  type PublishInput = Parameters<NonNullable<PersonalExecutionPorts["publishCandidate"]>>[0];
  function withPublish(h: ReturnType<typeof harness>, answer: (input: PublishInput) => Awaited<ReturnType<NonNullable<PersonalExecutionPorts["publishCandidate"]>>>) {
    const calls: PublishInput[] = [];
    h.ports.publishCandidate = async (input) => {
      calls.push(structuredClone(input));
      return answer(input);
    };
    return calls;
  }
  const committedFor = (input: PublishInput, displayVersion: number) => ({
    status: "committed" as const,
    version: {
      versionId: input.candidate.versionId, path: input.candidate.path, sha256: input.candidate.sha256, bytes: input.candidate.bytes,
      originRunId: "run-1", origin: "this_pc" as const,
    },
    displayVersion,
  });

  it("ある場合は CAS・集約・行を別々に書かず 1 回で公開し、Native の番号を履歴と返り値にそろえる", async () => {
    const h = harness();
    let number = 4;
    const calls = withPublish(h, (input) => committedFor(input, ++number));
    const got = await h.execute(request());
    expect(got.state).toBe("completed");
    expect(h.counts.casCalls).toBe(0);
    expect(calls.map((input) => input.candidate.stepId)).toEqual(["outline", "minutes"]);
    // 渡すのは確定後の集約（この版を足し、保持中の候補から外したもの）と、数値の版を null にした確定 event の行
    expect(calls[0]!.aggregate.versions.map((version) => version.versionId)).toEqual(["outline-candidate-v1"]);
    expect(calls[0]!.aggregate.retainedCandidates).toEqual([]);
    expect(calls[0]!.record).toMatchObject({ stepId: "outline", result: "saved", version: null, versionPath: calls[0]!.candidate.path });
    expect(calls[0]!.event).toMatchObject({ stepId: "outline", state: "completed", version: { versionId: "outline-candidate-v1" } });
    expect(calls[0]!.expectedCurrentArtifactSha).toBeNull();
    // 2 回目の集約には 1 回目の版が Native の番号つきで入る
    expect(calls[1]!.aggregate.versions.map((version) => version.displayVersion)).toEqual([5, undefined]);
    expect(got.versions.map((version) => version.displayVersion)).toEqual([5, 6]);
    expect(h.histories.at(-1)?.versions.map((version) => version.displayVersion)).toEqual([5, 6]);
    // 成功の event は別の追記にしない・派生の固定入力には番号を入れない
    expect(h.events.filter((event) => event.state === "completed")).toHaveLength(0);
    expect(h.trace).toContain("generate:minutes:outline");
    expect(Object.keys(calls[1]!.snapshot.input.priorSteps[0]!).sort()).toEqual(["bytes", "path", "sha256", "stepId", "versionId"]);
  });

  it("番号を確かめられなければ成功にしない・照合が違えば候補を残して input_changed", async () => {
    const invalid = harness();
    withPublish(invalid, (input) => committedFor(input, 0));
    await expect(invalid.execute(request())).rejects.toMatchObject({ code: "INVALID_DISPLAY_VERSION" });
    expect(invalid.states.get("intent-1")).toBe("failed");
    // 公開は確定しているので、失敗の集約も公開した版を持つ（Native が書いた集約を候補保持の古い内容で上書きしない）
    expect(invalid.histories.at(-1)).toMatchObject({ state: "failed", versions: [{ versionId: "outline-candidate-v1", displayVersion: 0 }], retainedCandidates: [] });

    const mismatch = harness();
    withPublish(mismatch, (input) => {
      const committed = committedFor(input, 7);
      return { ...committed, version: { ...committed.version, originRunId: "run-other" } };
    });
    await expect(mismatch.execute(request())).rejects.toMatchObject({ code: "COMMITTED_VERSION_MISMATCH" });
    expect(mismatch.histories.at(-1)).toMatchObject({
      state: "failed",
      versions: [{ versionId: "outline-candidate-v1", originRunId: "run-1", displayVersion: 7 }],
      retainedCandidates: [],
    });
    expect(mismatch.histories.every((history) => history.versions.length === 0 || history.versions[0]!.displayVersion === 7)).toBe(true);

    const changed = harness();
    withPublish(changed, () => ({ status: "input_changed", reason: "手修正" }));
    const got = await changed.execute(request());
    expect(got.state).toBe("input_changed");
    expect(got.retainedCandidates.map((version) => version.versionId)).toEqual(["outline-candidate-v1"]);
    expect(got.versions).toEqual([]);
    expect(changed.events.map((event) => event.state)).toEqual(["input_changed"]);
    expect(changed.counts.generationCalls).toBe(1);
  });

  it("公開の行は Native の番号があるときだけ数値の版を持つ", async () => {
    const event: PersonalRunEvent = {
      schemaVersion: 1, eventId: "r6-x", runId: "run-1", originDeviceId: "mac-1", stepId: "outline", stepName: "要点", state: "completed",
      at: "2026-10-16T00:00:00.000Z", continuationOfRunId: null, inputBasisSha256: H, sourceVersion: null,
      version: { versionId: "v1", path: "recordings/recording-1/versions/outline/v1.md", sha256: H, bytes: 1, originRunId: "run-1", origin: "this_pc" },
      remoteRunId: null,
    };
    expect((await projectPersonalRunEvent(event))?.version).toBeNull();
    expect((await projectPersonalRunEvent({ ...event, version: { ...event.version!, displayVersion: 3 } }))?.version).toBe(3);
    expect((await projectPersonalRunEvent({ ...event, state: "input_changed", version: { ...event.version!, displayVersion: 3 } }))?.version).toBeNull();
  });
});

describe("prompt の材料の固定（promptMaterials）", () => {
  async function hashed<T>(value: T) {
    return { value, sha256: await sha256Text(canonical(value)) };
  }
  async function withPrompt(base: PersonalSnapshotMaterial): Promise<PersonalSnapshotMaterial> {
    return {
      ...base,
      promptMaterials: {
        about: await hashed({ name: "高浜", text: "記事を書いている" }),
        referenceTitles: await hashed(base.referencePages.map((page) => ({ pageId: page.pageId, title: "参考の文書" }))),
        info: await hashed({ ...base.recordingMetadata, entities: [{ id: "e1", name: "高浜", reading: "", role: "", note: "" }] }),
      },
    };
  }

  it("素材に無ければ今までどおりの固定入力（欄ごと無い）、あれば hash に含めて変更を検出する", async () => {
    const r = request();
    const plain = await buildPersonalFixedSnapshot(r, material(r.route));
    expect(plain.input).not.toHaveProperty("promptMaterials");
    const fixed = await buildPersonalFixedSnapshot(r, await withPrompt(material(r.route)));
    expect(fixed.input.promptMaterials).toEqual({
      aboutSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      referenceTitlesSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      infoSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fixed.snapshotSha256).not.toBe(plain.snapshotSha256);
    // あなたについての値だけ変えた素材は別の hash
    const other = await withPrompt(material(r.route));
    other.promptMaterials!.about = await hashed({ name: "別の人", text: "記事を書いている" });
    expect((await buildPersonalFixedSnapshot(r, other)).snapshotSha256).not.toBe(fixed.snapshotSha256);
  });

  it("Native の hash と違う値・参考と並びの違うタイトル・録音と違う背景情報は受け付けない", async () => {
    const r = request();
    const tampered = await withPrompt(material(r.route));
    tampered.promptMaterials!.about = { value: { name: "別の人", text: "" }, sha256: tampered.promptMaterials!.about.sha256 };
    await expect(buildPersonalFixedSnapshot(r, tampered)).rejects.toMatchObject({ code: "INPUT_HASH_MISMATCH" });
    const titles = await withPrompt(material(r.route));
    titles.promptMaterials!.referenceTitles = await hashed([]);
    await expect(buildPersonalFixedSnapshot(r, titles)).rejects.toMatchObject({ code: "INVALID_PROMPT_MATERIALS" });
    const info = await withPrompt(material(r.route));
    info.promptMaterials!.info = await hashed({ ...info.recordingMetadata, background: "別の背景", entities: [] });
    await expect(buildPersonalFixedSnapshot(r, info)).rejects.toMatchObject({ code: "INVALID_PROMPT_MATERIALS" });
  });
});
