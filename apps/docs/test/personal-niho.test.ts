import { describe, expect, it } from "vitest";
import { NIHO_API_STEP_PROVIDERS, nihoApiProvider, nihoApiStepModel, type FlowSnapshot, type RunRecord } from "@niho/docs-core";
import { readFileSync } from "node:fs";
import { FakeBridge } from "./fake-bridge";
import type { PersonalOpenRequest, PersonalOperationInfo } from "../src/lib/bridge";
import {
  buildPersonalFixedSnapshot,
  createPersonalExecutionController,
  PersonalDispatchError,
  PersonalExecutionError,
  PersonalRemoteRejectionError,
  type PersonalExecutionPorts,
  type PersonalExecutionRequest,
  type PersonalFixedSnapshot,
  type PersonalRunHistory,
} from "../src/lib/personal-execution";
import {
  createPersonalNihoPorts,
  PERSONAL_NIHO_NOT_SENT_CODES,
  personalNihoFixedModels,
  personalNihoModelPlan,
  personalNihoReadiness,
  personalNihoSubmitError,
} from "../src/lib/personal-niho";

/**
 * 本人 Mac で確定した原文から NIHO API へ後続だけを渡す（#18740）。controller・FakeBridge（src-tauri/src/personal_niho.rs の
 * 代わり）・production の ports（createPersonalNihoPorts）を組み合わせ、文字起こし 0 回・工程の AI 0 回・送信の非再試行を確かめる。
 */

const AT = "2026-10-17T00:00:00.000Z";
const CONSENT = "2026-10-16-v1";
const SOURCE = "確定した原文です。";
/** 保管庫の版 ID（v_ ＋ 22 字）。 */
const vid = (tag: string) => `v_${tag.padEnd(22, "A")}`;
const SOURCE_PATH = `recordings/rec1/versions/source/${vid("src")}.md`;

/** 録音の工程（Mac で作った録音を、押した時に NIHO の AI へ持ち替えた後。工程の provider は作った時のまま）。 */
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
    provider: "gemini" as const,
    model: "gemini-3.8-flash",
    effort: "low" as const,
    profileId: "standard",
    profileName: "NIHO API",
    connection: "apiKey" as const,
  }])),
};

/** フォルダ `proj1` の録音（ページ `pg1`・録音 `rec1`。ページ id と録音 id は別）。原文は本人 Mac で確定した版で、後続はまだ無い。 */
function bridgeWithConfirmedSource(): FakeBridge {
  const bridge = new FakeBridge();
  bridge.cloud = { ...bridge.cloud, provider: "niho", status: "active" };
  const sourceRow = {
    id: "run-src", kind: "run", at: AT, stepId: "source", stepName: "文字起こし", version: 1, result: "saved",
    versionPath: SOURCE_PATH, origin: "this_pc", personalRunId: "run-src",
  } as unknown as RunRecord;
  bridge.projects.set("proj1", {
    project: {
      version: 1,
      id: "proj1",
      name: "案件",
      createdAt: AT,
      info: { terms: [], background: "朝市の取材" },
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
        transcript: SOURCE,
        artifacts: {},
        versions: { source: [SOURCE] },
        runs: [sourceRow],
        checkpoints: {},
      },
    },
    docs: { ref1: "参考の本文" },
  });
  return bridge;
}

function openRequest(intentId = "intent-1"): PersonalOpenRequest {
  return {
    projectId: "proj1",
    recordingPageId: "pg1",
    recordingId: "rec1",
    intentId,
    runId: `run-${intentId}`,
    route: { kind: "generation_only", executor: "niho_api" },
    transcriptionProvider: null,
  };
}

function executionRequest(opened: PersonalOperationInfo, intentId = "intent-1"): PersonalExecutionRequest {
  return {
    runId: `run-${intentId}`,
    intentId,
    originDeviceId: "mac-1",
    ownerAccountId: opened.ownerAccountId,
    rootId: opened.rootId,
    containerRef: { kind: "folder", projectId: "proj1" },
    recordingPageId: "pg1",
    recordingId: "rec1",
    route: { kind: "generation_only", executor: "niho_api" },
    continuationOfRunId: "run-src",
    consentVersion: CONSENT,
    stepIds: ["outline", "minutes"],
  };
}

type Calls = { transcription: number; generation: number; history: PersonalRunHistory | null };

/** テストだけの ports（slice 2 の production factory の代わり）。NIHO API の 2 つの port だけ production の createPersonalNihoPorts。 */
function nihoPorts(bridge: FakeBridge, opened: PersonalOperationInfo, calls: Calls): PersonalExecutionPorts {
  const handle = opened.handle;
  let fixed: PersonalFixedSnapshot | null = null;
  return {
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
      calls.transcription += 1;
      throw new Error("文字起こしは呼ばない");
    },
    async executeGenerationStep() {
      calls.generation += 1;
      throw new Error("工程の AI は呼ばない");
    },
    async persistCandidate() { throw new Error("unused"); },
    async casCandidate() { throw new Error("unused"); },
    ...createPersonalNihoPorts(bridge, handle),
    async writeAggregate(history) { calls.history = structuredClone(history); },
    async appendSyncEvent() {},
    async syncOutputAndHistory() {},
    async markIntent(intentId, state) { await bridge.personalMarkIntent(handle, intentId, state); },
    now: () => new Date(AT),
  };
}

async function run(bridge: FakeBridge, intentId = "intent-1") {
  const opened = await bridge.personalOpen(openRequest(intentId));
  const calls: Calls = { transcription: 0, generation: 0, history: null };
  const execute = createPersonalExecutionController(nihoPorts(bridge, opened, calls));
  const outcome = await execute(executionRequest(opened, intentId)).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { opened, calls, outcome };
}

const intentOf = (bridge: FakeBridge, intentId = "intent-1") => bridge.personalIntents.get(`${bridge.personalOwner}/${bridge.personalRootId}/${intentId}`)!;
const recordOf = (bridge: FakeBridge, intentId = "intent-1") => bridge.personalNihoRecords.get(`${bridge.personalOwner}/${bridge.personalRootId}/${intentId}`)!;

describe("確定した原文から NIHO API へ後続だけ（controller と FakeBridge）", () => {
  it("受け付けたら submitted と NIHO の run を残し、文字起こしも工程の AI も 0 回", async () => {
    const bridge = bridgeWithConfirmedSource();
    const { calls, outcome } = await run(bridge);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({ state: "submitted", remoteRunId: "cmfakerun00000001", remoteState: "queued", transcriptionExecutions: 0, versions: [] });
    // run に reasonCode が無ければ結果にも載せない
    expect(outcome.value).not.toHaveProperty("remoteReasonCode");
    expect(calls).toMatchObject({ transcription: 0, generation: 0 });
    expect(calls.history).toMatchObject({ state: "submitted", remoteRunId: "cmfakerun00000001" });
    expect(bridge.turnRequests).toHaveLength(0);
    // 本文は Native が組む（controller の NihoContinuationSubmission ではない）。ports から渡すのは intent と hash だけ
    expect(bridge.personalNihoPosts).toHaveLength(1);
    const body = JSON.parse(bridge.personalNihoPosts[0]!.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      "baseRevision", "recordingPageId", "recordingId", "projectFile", "recordingFile", "audio", "sourceVersion", "references", "basis",
      "transcriptionExecutor", "generationExecutor", "consentVersion", "steps", "containerRef",
    ]);
    expect(body).toMatchObject({
      recordingPageId: "pg1", recordingId: "rec1", audio: [], basis: [], transcriptionExecutor: null, generationExecutor: "niho_api",
      consentVersion: CONSENT, containerRef: { kind: "folder", projectId: "proj1" },
      sourceVersion: { path: SOURCE_PATH }, references: [{ path: "pages/ref1.md" }],
      steps: [
        { stepKey: "outline", kind: "REVISION", provider: "gemini", model: "gemini-3.8-flash", effort: "low" },
        { stepKey: "minutes", kind: "INSIGHT", provider: "gemini", model: "gemini-3.8-flash", effort: "low" },
      ],
    });
    const submit = bridge.personalCalls.find((call) => call.name === "personalNihoSubmit")!;
    expect(submit.args).toHaveLength(3);
    expect(submit.args[1]).toBe("intent-1");
    expect(submit.args[2]).toMatch(/^[a-f0-9]{64}$/);
    expect(intentOf(bridge).state).toBe("submitted");
    expect(intentOf(bridge).dispatches).toEqual([{ stepId: "remote", terminal: true }]);
    expect(recordOf(bridge)).toMatchObject({ phase: "accepted", runId: "cmfakerun00000001" });
    expect(bridge.locks.size).toBe(0);
  });

  it("断られたら failed にし、同じ intent では送り直さない", async () => {
    const bridge = bridgeWithConfirmedSource();
    bridge.personalNihoPostResults.push({ reject: "input_revision_changed" });
    const { calls, outcome } = await run(bridge);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(PersonalRemoteRejectionError);
    expect((outcome.error as Error).message).toContain("保存先が更新");
    expect(calls.history?.state).toBe("failed");
    expect(intentOf(bridge).state).toBe("failed");
    expect(recordOf(bridge)).toMatchObject({ phase: "rejected", reasonCode: "input_revision_changed" });
    const again = await run(bridge);
    expect(again.outcome.ok).toBe(false);
    if (!again.outcome.ok) expect(again.outcome.error).toMatchObject({ code: "INTENT_ALREADY_EXISTS" });
    expect(bridge.personalNihoPosts).toHaveLength(1);
    await expect(bridge.personalNihoConfirm("intent-1", "resend")).resolves.toEqual({ status: "rejected", reasonCode: "input_revision_changed" });
    expect(bridge.personalNihoPosts).toHaveLength(1);
  });

  it("結果が分からなければ result_unknown にし、同じ intent の 2 回目は送らない", async () => {
    const bridge = bridgeWithConfirmedSource();
    bridge.personalNihoPostResults.push("unknown");
    const { outcome } = await run(bridge);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(PersonalDispatchError);
    expect((outcome.error as PersonalDispatchError).resultUnknown).toBe(true);
    expect(intentOf(bridge).state).toBe("result_unknown");
    expect(intentOf(bridge).dispatches).toEqual([{ stepId: "remote", terminal: false }]);
    expect(recordOf(bridge).phase).toBe("sent");
    // 二重クリック・再起動の後の実行: 受け付けない（送らない）
    const again = await run(bridge);
    expect(again.outcome.ok).toBe(false);
    if (!again.outcome.ok) expect(again.outcome.error).toMatchObject({ code: "RESULT_UNKNOWN_NO_RETRY" });
    expect(bridge.personalNihoPosts).toHaveLength(1);
    await expect(bridge.personalNihoPending()).resolves.toEqual({
      items: [{ intentId: "intent-1", recordingPageId: "pg1", recordingId: "rec1", projectId: "proj1", phase: "sent", runId: null, createdAt: recordOf(bridge).createdAt }],
      truncated: false,
    });
  });

  it("送る前に止めた（同期が終わっていない・利用条件が違う）ものは failed で、結果不明にしない", async () => {
    const unsynced = bridgeWithConfirmedSource();
    unsynced.personalNihoUnsynced = true;
    const first = await run(unsynced);
    expect(first.outcome.ok).toBe(false);
    if (!first.outcome.ok) {
      expect(first.outcome.error).toBeInstanceOf(PersonalDispatchError);
      expect((first.outcome.error as PersonalDispatchError).resultUnknown).toBe(false);
      expect((first.outcome.error as Error).message).toContain("同期が終わっていません");
    }
    expect(first.calls.history?.state).toBe("failed");
    expect(intentOf(unsynced).state).toBe("failed");
    expect(unsynced.personalNihoPosts).toHaveLength(0);
    expect(unsynced.personalNihoRecords.size).toBe(0);

    const consent = bridgeWithConfirmedSource();
    consent.personalNihoAccessResult = { ...(consent.personalNihoAccessResult as object), consentVersion: "2026-11-01-v2" } as typeof consent.personalNihoAccessResult;
    const second = await run(consent);
    expect(second.outcome.ok).toBe(false);
    if (!second.outcome.ok) {
      expect(second.outcome.error).toBeInstanceOf(PersonalExecutionError);
      expect(second.outcome.error).toMatchObject({ code: "NIHO_API_NOT_READY", message: expect.stringContaining("利用条件") });
    }
    expect(second.calls.history?.state).toBe("failed");
    expect(consent.personalCalls.some((call) => call.name === "personalNihoSubmit")).toBe(false);
    expect(consent.personalNihoPosts).toHaveLength(0);

    const partial = bridgeWithConfirmedSource();
    partial.recording("proj1", "rec1").artifacts.outline = "要点";
    const third = await run(partial);
    expect(third.outcome.ok).toBe(false);
    if (!third.outcome.ok) expect((third.outcome.error as Error).message).toContain("途中までの工程");
    expect(partial.personalNihoPosts).toHaveLength(0);
  });

  it("本人が切り替わったら送らず、新しい本人からは旧本人の依頼に届かない", async () => {
    const bridge = bridgeWithConfirmedSource();
    bridge.personalNihoPostResults.push("unknown");
    await run(bridge);
    const opened = await bridge.personalOpen(openRequest("intent-2"));
    bridge.switchPersonalAccount("c".repeat(64));
    await expect(bridge.personalNihoSubmit(opened.handle, "intent-2", "a".repeat(64))).rejects.toMatchObject({ code: "personal_guard_failed" });
    await expect(bridge.personalNihoAccess(opened.handle, 2)).rejects.toMatchObject({ code: "personal_guard_failed" });
    await expect(bridge.personalNihoPending()).resolves.toEqual({ items: [], truncated: false });
    await expect(bridge.personalNihoConfirm("intent-1", "lookup")).rejects.toMatchObject({ code: "personal_niho_record_missing" });
    expect(bridge.personalNihoPosts).toHaveLength(1);
    expect(bridge.personalNihoLookups).toHaveLength(0);
  });
});

describe("結果を確かめる（照会・明示の再送・不在の証明）", () => {
  it("404 だけでは受け付けられていないと言わず、明示の再送は同じ bytes・同じ受付キー", async () => {
    const bridge = bridgeWithConfirmedSource();
    bridge.personalNihoPostResults.push("unknown");
    await run(bridge);
    await expect(bridge.personalNihoConfirm("intent-1", "lookup")).resolves.toEqual({ status: "absent_unproven" });
    expect(recordOf(bridge).phase).toBe("sent");
    bridge.personalNihoLookupResults.push("unknown");
    await expect(bridge.personalNihoConfirm("intent-1", "resend")).resolves.toEqual({ status: "unknown" });
    expect(bridge.personalNihoPosts).toHaveLength(1);
    const resent = await bridge.personalNihoConfirm("intent-1", "resend");
    expect(resent).toMatchObject({ status: "accepted", state: "queued" });
    expect(bridge.personalNihoPosts).toHaveLength(2);
    expect(bridge.personalNihoPosts[1]).toEqual(bridge.personalNihoPosts[0]);
    expect(intentOf(bridge)).toMatchObject({ state: "submitted", dispatches: [{ stepId: "remote", terminal: true }] });
    // 受付の分かった依頼は通信しない
    const lookups = bridge.personalNihoLookups.length;
    await expect(bridge.personalNihoConfirm("intent-1", "lookup")).resolves.toEqual(resent);
    expect(bridge.personalNihoLookups).toHaveLength(lookups);
    await expect(bridge.personalNihoPending()).resolves.toEqual({ items: [], truncated: false });
  });

  it("受け付けたが応答が届かなかった依頼は照会で受付が分かる", async () => {
    const bridge = bridgeWithConfirmedSource();
    bridge.personalNihoPostResults.push("accept_lost");
    const { outcome } = await run(bridge);
    expect(outcome.ok).toBe(false);
    await expect(bridge.personalNihoConfirm("intent-1", "lookup")).resolves.toMatchObject({ status: "accepted", runId: "cmfakerun00000001" });
    expect(bridge.personalNihoPosts).toHaveLength(1);
  });

  it("実行の前に入力が変わった run の reasonCode は、受付の結果までそのまま渡す（保存する記録の形には載せない）", async () => {
    const bridge = bridgeWithConfirmedSource();
    bridge.personalNihoNextRun = { state: "input_changed", reasonCode: "input_changed_before_execution" };
    const { calls, outcome } = await run(bridge);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toMatchObject({ state: "submitted", remoteState: "input_changed", remoteReasonCode: "input_changed_before_execution" });
    expect(calls.history).toMatchObject({ remoteState: "input_changed" });
    expect(calls.history).not.toHaveProperty("remoteReasonCode");
  });

  it("応答が届かなかった後の照会で、実行の前に入力が変わった run が見つかったら reasonCode も返し、記録に残す", async () => {
    const bridge = bridgeWithConfirmedSource();
    bridge.personalNihoNextRun = { state: "input_changed", reasonCode: "input_changed_before_execution" };
    bridge.personalNihoPostResults.push("accept_lost");
    const { outcome } = await run(bridge);
    expect(outcome.ok).toBe(false);
    const found = { status: "accepted", runId: "cmfakerun00000001", state: "input_changed", reasonCode: "input_changed_before_execution" };
    await expect(bridge.personalNihoConfirm("intent-1", "lookup")).resolves.toEqual(found);
    // 受付の分かった依頼は通信しない。reasonCode も同じ
    const lookups = bridge.personalNihoLookups.length;
    await expect(bridge.personalNihoConfirm("intent-1", "lookup")).resolves.toEqual(found);
    expect(bridge.personalNihoLookups).toHaveLength(lookups);
  });

  it("release は manifest の版が固定した版を越えた後の再照会でだけ不在を証明する", async () => {
    const bridge = bridgeWithConfirmedSource();
    bridge.personalNihoPostResults.push("unknown");
    await run(bridge);
    await expect(bridge.personalNihoConfirm("intent-1", "release")).resolves.toEqual({ status: "cannot_confirm_yet" });
    expect(bridge.personalNihoLookups).toHaveLength(1);
    bridge.personalNihoRevision = 1;
    await expect(bridge.personalNihoConfirm("intent-1", "release")).resolves.toEqual({ status: "absent" });
    expect(bridge.personalNihoLookups).toHaveLength(3);
    expect(recordOf(bridge).phase).toBe("absent");
    expect(intentOf(bridge)).toMatchObject({ state: "failed", dispatches: [{ stepId: "remote", terminal: true }] });
    await expect(bridge.personalNihoConfirm("intent-1", "resend")).resolves.toEqual({ status: "absent" });
    expect(bridge.personalNihoPosts).toHaveLength(1);
    // 不在を証明した intent は使わない（新しい intent で実行する）
    const again = await run(bridge);
    expect(again.outcome.ok).toBe(false);
    if (!again.outcome.ok) expect(again.outcome.error).toMatchObject({ code: "INTENT_ALREADY_EXISTS" });
    // 受け付けなかった実行は lease を取っていない（operation は画面が閉じる）
    await bridge.personalClose(again.opened.handle);
    const fresh = await run(bridge, "intent-2");
    expect(fresh.outcome.ok).toBe(true);
    expect(bridge.personalNihoPosts).toHaveLength(2);
  });
});

describe("ports の失敗の区別（Native・FakeBridge の code と同じ）", () => {
  it("断られた・結果不明・送っていないを分け、知らない失敗は結果不明にする", () => {
    expect(personalNihoSubmitError({ code: "personal_niho_rejected", message: "断られた" })).toBeInstanceOf(PersonalRemoteRejectionError);
    expect(personalNihoSubmitError({ code: "personal_niho_result_unknown", message: "不明" }).resultUnknown).toBe(true);
    expect(personalNihoSubmitError({ code: "personal_niho_not_synced", message: "同期" }).resultUnknown).toBe(false);
    expect(personalNihoSubmitError({ code: "personal_guard_failed", message: "変わった" }).resultUnknown).toBe(false);
    expect(personalNihoSubmitError({ code: "somewhere_else", message: "?" }).resultUnknown).toBe(true);
    expect(personalNihoSubmitError(new Error("boom")).resultUnknown).toBe(true);
    expect(PERSONAL_NIHO_NOT_SENT_CODES.has("personal_niho_rejected")).toBe(false);
    expect(PERSONAL_NIHO_NOT_SENT_CODES.has("personal_niho_result_unknown")).toBe(false);
  });

  it("FakeBridge が送る前に止めた code は、どれも「送っていない」の集合に入る", async () => {
    const codes = new Set<string>();
    const capture = async (bridge: FakeBridge, change: (bridge: FakeBridge) => void) => {
      const opened = await bridge.personalOpen(openRequest());
      const material = await bridge.personalReadMaterial(opened.handle, { stepIds: ["outline", "minutes"] });
      const snapshot = await buildPersonalFixedSnapshot(executionRequest(opened), material);
      await bridge.personalReserveIntent(opened.handle, "intent-1", snapshot);
      change(bridge);
      await bridge.personalNihoSubmit(opened.handle, "intent-1", snapshot.snapshotSha256).catch((error: { code: string }) => codes.add(error.code));
      return bridge;
    };
    await capture(bridgeWithConfirmedSource(), (bridge) => { bridge.personalNihoUnsynced = true; });
    await capture(bridgeWithConfirmedSource(), (bridge) => { bridge.recording("proj1", "rec1").transcript = "手直し"; });
    await capture(bridgeWithConfirmedSource(), (bridge) => { bridge.recording("proj1", "rec1").artifacts.minutes = "議事録"; });
    await capture(bridgeWithConfirmedSource(), (bridge) => { bridge.projects.get("proj1")!.docs.ref1 = "書き換えた参考"; });
    await capture(bridgeWithConfirmedSource(), (bridge) => {
      bridge.personalNihoAccessResult = { ...(bridge.personalNihoAccessResult as object), model: "gemini-3.1-pro-preview" } as typeof bridge.personalNihoAccessResult;
    });
    await capture(bridgeWithConfirmedSource(), (bridge) => { for (const op of bridge.personalOps.values()) op.cancelled = true; });
    await capture(bridgeWithConfirmedSource(), (bridge) => {
      bridge.personalNihoRecords.set(`${bridge.personalOwner}/${bridge.personalRootId}/intent-old`, {
        intentId: "intent-old", submissionKey: `submit_${"0".repeat(32)}`, body: "{}", baseRevision: 0, projectId: "proj1",
        recordingPageId: "pg1", recordingId: "rec1", phase: "sent", runId: null, state: null, reasonCode: null, createdAt: AT,
      });
    });
    await capture(bridgeWithConfirmedSource(), (bridge) => {
      bridge.personalNihoServerRuns = [{ projectId: "proj1", recordingPageId: "pg1", recordingId: "rec1", state: "running" }];
    });
    await capture(bridgeWithConfirmedSource(), (bridge) => {
      bridge.personalNihoServerRuns = { code: "personal_niho_unavailable", message: "NIHO API の利用条件を確認できませんでした。" };
    });
    expect([...codes].sort()).toEqual([
      "personal_guard_failed", "personal_niho_input_changed", "personal_niho_not_ready", "personal_niho_not_synced",
      "personal_niho_partial_saved", "personal_niho_pending_exists", "personal_niho_run_active", "personal_niho_source_not_current",
      "personal_niho_unavailable",
    ]);
    for (const code of codes) expect(PERSONAL_NIHO_NOT_SENT_CODES.has(code), code).toBe(true);
  });

  it("Native（personal_niho.rs）の code は、送っていない・送った後の結果・確認だけの code のどれかに分かれる", () => {
    const source = readFileSync(new URL("../src-tauri/src/personal_niho.rs", import.meta.url), "utf8");
    const native = new Set([...source.matchAll(/failure\(\s*"([a-z_]+)"/g)].map((match) => match[1]!));
    const afterSend = new Set(["personal_niho_rejected", "personal_niho_result_unknown"]);
    const confirmOnly = new Set(["personal_niho_record_missing"]);
    expect(native.size).toBeGreaterThan(20);
    for (const code of native) {
      expect(PERSONAL_NIHO_NOT_SENT_CODES.has(code) || afterSend.has(code) || confirmOnly.has(code), code).toBe(true);
    }
    for (const code of [...afterSend, ...confirmOnly]) expect(PERSONAL_NIHO_NOT_SENT_CODES.has(code), code).toBe(false);
    // personal_run.rs から返りうる送信前の code（operation・intent・snapshot の検査）
    for (const code of [
      "bad_id", "personal_bad_request", "personal_guard_failed", "personal_operation_missing", "personal_intent_mismatch",
      "personal_intent_not_reserved", "personal_intent_closed", "personal_intent_io", "personal_snapshot_invalid",
      "personal_snapshot_mismatch", "personal_not_signed_in", "personal_io",
    ]) {
      expect(PERSONAL_NIHO_NOT_SENT_CODES.has(code), code).toBe(true);
    }
  });

  it("FakeBridge が送った後に返す code は、断られた・結果不明だけ", async () => {
    const codes = new Set<string>();
    for (const result of ["unknown", "accept_lost", { reject: "input_revision_changed" }] as const) {
      const bridge = bridgeWithConfirmedSource();
      bridge.personalNihoPostResults.push(result);
      const opened = await bridge.personalOpen(openRequest());
      const material = await bridge.personalReadMaterial(opened.handle, { stepIds: ["outline", "minutes"] });
      const snapshot = await buildPersonalFixedSnapshot(executionRequest(opened), material);
      await bridge.personalReserveIntent(opened.handle, "intent-1", snapshot);
      await bridge.personalNihoSubmit(opened.handle, "intent-1", snapshot.snapshotSha256).catch((error: { code: string }) => codes.add(error.code));
      expect(bridge.personalNihoPosts).toHaveLength(1);
    }
    expect([...codes].sort()).toEqual(["personal_niho_rejected", "personal_niho_result_unknown"]);
  });

  it("readiness は利用可・同意の版・工程のモデルが今の受付と同じときだけ", () => {
    const access = { available: true, reasonCode: null, provider: "GOOGLE", model: "gemini-3.8-flash", consentVersion: CONSENT, maxRunCostMicrousd: "1", executorReasonCode: null };
    const snapshot = {
      consentVersion: CONSENT,
      selectedStepIds: ["outline"],
      fixedModels: { outline: flow.models.outline! },
    } as unknown as PersonalFixedSnapshot;
    expect(personalNihoReadiness(access, snapshot)).toEqual({ ready: true });
    // 開示の名前の大文字・小文字は問わない。思考量は比べない（docs-core の matchesNihoApi）
    expect(personalNihoReadiness({ ...access, provider: "google" }, snapshot)).toEqual({ ready: true });
    expect(personalNihoReadiness(access, { ...snapshot, fixedModels: { outline: { ...flow.models.outline!, effort: "high" } } })).toEqual({ ready: true });
    expect(personalNihoReadiness({ ...access, available: false, reasonCode: "BUDGET_EXHAUSTED" }, snapshot).reason).toContain("上限");
    expect(personalNihoReadiness({ ...access, consentVersion: "2026-11-01-v2" }, snapshot).reason).toContain("利用条件");
    expect(personalNihoReadiness({ ...access, model: "gemini-3.1-pro-preview" }, snapshot).reason).toContain("AI モデル");
    expect(personalNihoReadiness({ ...access, provider: null }, snapshot).ready).toBe(false);
    // 以前の NIHO の AI（Anthropic）は、工程を動かせない提供元（同じモデルを固定していても）
    const claude = { ...flow.models.outline!, provider: "claude" as const, model: "claude-sonnet-5" };
    expect(personalNihoReadiness({ ...access, provider: "ANTHROPIC", model: "claude-sonnet-5" }, { ...snapshot, fixedModels: { outline: claude } }).ready).toBe(false);
    expect(personalNihoReadiness({ ...access, provider: "OPENAI" }, snapshot).ready).toBe(false);
  });

  it("持ち替えの計画は NIHO の AI と違う工程だけを NIHO の AI のモデルにし、使えない受付では作らない", () => {
    const access = { available: true, reasonCode: null, provider: "GOOGLE", model: "gemini-3.8-flash", consentVersion: CONSENT, maxRunCostMicrousd: "1", executorReasonCode: null };
    const nihoModel = flow.models.outline!;
    const swappedModel = nihoApiStepModel(flow.steps[0]!, access)!;
    const claude = { provider: "claude" as const, model: "claude-sonnet-5", effort: "high" as const, profileId: "standard", profileName: "標準", connection: "subscription" as const };
    const claudeFlow = { steps: flow.steps, models: { outline: claude, minutes: claude } };
    expect(personalNihoModelPlan(access, claudeFlow, ["outline", "minutes"])).toEqual({
      ready: true, models: [swappedModel, swappedModel], swap: { outline: swappedModel, minutes: swappedModel },
    });
    expect(personalNihoModelPlan(access, { steps: flow.steps, models: { outline: nihoModel, minutes: claude } }, ["outline", "minutes"])).toEqual({
      ready: true, models: [nihoModel, swappedModel], swap: { minutes: swappedModel },
    });
    // 持ち替えた後（2 回目に押したとき）は書かない
    expect(personalNihoModelPlan(access, flow, ["outline", "minutes"])).toEqual({ ready: true, models: [nihoModel, nihoModel], swap: {} });
    expect(personalNihoModelPlan({ ...access, provider: "ANTHROPIC", model: "claude-sonnet-5" }, claudeFlow, ["outline", "minutes"])).toMatchObject({ ready: false, reason: expect.stringContaining("AI モデル") });
    expect(personalNihoModelPlan({ ...access, available: false, reasonCode: "BUDGET_EXHAUSTED" }, claudeFlow, ["outline"])).toMatchObject({ ready: false, reason: expect.stringContaining("上限") });
    expect(personalNihoModelPlan({ ...access, provider: null }, claudeFlow, ["outline"]).ready).toBe(false);
  });

  it("実行方法の欄は、全工程が NIHO の AI に固定されたときだけそのモデルを出す", () => {
    expect(personalNihoFixedModels(flow)).toEqual([flow.models.outline, flow.models.minutes]);
    const claude = { ...flow.models.outline!, provider: "claude" as const, model: "claude-sonnet-5", profileName: "標準" };
    expect(personalNihoFixedModels({ steps: flow.steps, models: { ...flow.models, minutes: claude } })).toBeNull();
    // 自分で選んだ Gemini（プロファイル名が NIHO API でない）は NIHO の AI の固定ではない
    expect(personalNihoFixedModels({ steps: flow.steps, models: { ...flow.models, minutes: { ...flow.models.minutes!, profileName: "標準" } } })).toBeNull();
    expect(personalNihoFixedModels({ steps: flow.steps, models: { outline: flow.models.outline! } })).toBeNull();
  });

  it("Native の NIHO の AI の提供元の表（niho_api_step_provider）は docs-core の nihoApiProvider と同じ", () => {
    const source = readFileSync(new URL("../src-tauri/src/personal_niho.rs", import.meta.url), "utf8");
    const start = source.indexOf("fn niho_api_step_provider(");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    const table = [...body.matchAll(/"([A-Z_]+)" => Some\("([a-z]+)"\)/g)].map((match) => [match[1]!, match[2]!] as const);
    expect(table.length).toBeGreaterThan(0);
    for (const [disclosed, provider] of table) expect(nihoApiProvider(disclosed), disclosed).toBe(provider);
    // docs-core が工程を動かせる提供元はすべて Native の表にあり、ほかの提供元は無い
    for (const disclosed of ["ANTHROPIC", "OPENAI", "GOOGLE"]) {
      expect(table.some(([name]) => name === disclosed), disclosed).toBe(nihoApiProvider(disclosed) !== null);
    }
    expect([...new Set(table.map(([, provider]) => provider))].sort()).toEqual([...NIHO_API_STEP_PROVIDERS].sort());
    // 受け付けるかは Native もこの表で決める（parse_access・check_access の両方）
    expect(source.match(/niho_api_step_provider\)/g)).toHaveLength(2);
  });
});

/** 開いて素材を読み、固定入力を受け付けるまで（FakeBridge だけ。controller を通さない）。 */
async function reservedOn(bridge: FakeBridge, intentId = "intent-1") {
  const opened = await bridge.personalOpen(openRequest(intentId));
  const material = await bridge.personalReadMaterial(opened.handle, { stepIds: ["outline", "minutes"] });
  const snapshot = await buildPersonalFixedSnapshot(executionRequest(opened, intentId), material);
  await bridge.personalReserveIntent(opened.handle, intentId, snapshot);
  return { opened, sha: snapshot.snapshotSha256 };
}

describe("二重の依頼・途中の確認・記録の修復（Native と同じ規則）", () => {
  it("送信の途中の確認・二重の送信は何もせず、1 回だけ送る。受付の後に結果不明を書いても戻らない", async () => {
    const bridge = bridgeWithConfirmedSource();
    const { opened, sha } = await reservedOn(bridge);
    const submitting = bridge.personalNihoSubmit(opened.handle, "intent-1", sha);
    await expect(bridge.personalNihoConfirm("intent-1", "resend")).resolves.toEqual({ status: "in_flight" });
    await expect(bridge.personalNihoConfirm("intent-1", "release")).resolves.toEqual({ status: "in_flight" });
    await expect(bridge.personalNihoSubmit(opened.handle, "intent-1", sha)).rejects.toMatchObject({ code: "personal_niho_result_unknown" });
    await expect(submitting).resolves.toMatchObject({ status: "accepted" });
    expect(bridge.personalNihoPosts).toHaveLength(1);
    expect(bridge.personalNihoLookups).toHaveLength(0);
    expect(intentOf(bridge)).toMatchObject({ state: "submitted", dispatches: [{ stepId: "remote", terminal: true }] });
    await bridge.personalMarkIntent(opened.handle, "intent-1", "submitted");
    await bridge.personalMarkIntent(opened.handle, "intent-1", "result_unknown");
    expect(intentOf(bridge).state).toBe("submitted");
  });

  it("同じ録音に結果を確かめていない依頼があれば、新しい intent は送らない（failed）", async () => {
    const bridge = bridgeWithConfirmedSource();
    bridge.personalNihoPostResults.push("unknown");
    await run(bridge);
    const second = await run(bridge, "intent-2");
    expect(second.outcome.ok).toBe(false);
    if (!second.outcome.ok) {
      expect(second.outcome.error).toBeInstanceOf(PersonalDispatchError);
      expect((second.outcome.error as PersonalDispatchError).resultUnknown).toBe(false);
      expect((second.outcome.error as Error).message).toContain("前の依頼");
    }
    expect(second.calls.history?.state).toBe("failed");
    expect(bridge.personalNihoPosts).toHaveLength(1);
    expect(bridge.personalNihoRecords.has(`${bridge.personalOwner}/${bridge.personalRootId}/intent-2`)).toBe(false);
  });

  it("NIHO で実行中の run があれば送らず、終わった run・別の録音の run では止めない", async () => {
    const bridge = bridgeWithConfirmedSource();
    bridge.personalNihoServerRuns = [
      { projectId: "proj1", recordingPageId: "pg1", recordingId: "rec1", state: "completed" },
      { projectId: "proj1", recordingPageId: "pg1", recordingId: "rec1", state: "waiting_runner" },
    ];
    const blocked = await run(bridge);
    expect(blocked.outcome.ok).toBe(false);
    if (!blocked.outcome.ok) expect((blocked.outcome.error as Error).message).toContain("NIHO で実行中");
    expect(bridge.personalNihoPosts).toHaveLength(0);
    bridge.personalNihoServerRuns = [
      { projectId: "proj1", recordingPageId: "pg1", recordingId: "rec1", state: "completed" },
      { projectId: "proj1", recordingPageId: "pg2", recordingId: "rec2", state: "running" },
    ];
    const fresh = await run(bridge, "intent-2");
    expect(fresh.outcome.ok).toBe(true);
    expect(bridge.personalNihoPosts).toHaveLength(1);
    expect(bridge.personalNihoListCalls).toBe(2);
  });

  it("結果の分かった記録は、前の版で result_unknown のまま残った intent を直す", async () => {
    const bridge = bridgeWithConfirmedSource();
    const { outcome } = await run(bridge);
    expect(outcome.ok).toBe(true);
    const intent = intentOf(bridge);
    intent.state = "result_unknown";
    intent.dispatches.forEach((marker) => { marker.terminal = false; });
    await expect(bridge.personalNihoConfirm("intent-1", "lookup")).resolves.toMatchObject({ status: "accepted" });
    expect(bridge.personalNihoLookups).toHaveLength(0);
    expect(intentOf(bridge)).toMatchObject({ state: "submitted", dispatches: [{ stepId: "remote", terminal: true }] });
  });

  it("同じ録音の本人 Mac 実行が開いている間は再送しない（照会はできる）", async () => {
    const bridge = bridgeWithConfirmedSource();
    bridge.personalNihoPostResults.push("unknown");
    await run(bridge);
    const local = await bridge.personalOpen({ ...openRequest("intent-local"), route: { kind: "generation_only", executor: "this_pc" } });
    await expect(bridge.personalNihoConfirm("intent-1", "resend")).rejects.toMatchObject({ code: "personal_niho_recording_busy" });
    await expect(bridge.personalNihoConfirm("intent-1", "lookup")).resolves.toEqual({ status: "absent_unproven" });
    expect(bridge.personalNihoPosts).toHaveLength(1);
    await bridge.personalClose(local.handle);
    await expect(bridge.personalNihoConfirm("intent-1", "resend")).resolves.toMatchObject({ status: "accepted" });
    expect(bridge.personalNihoPosts).toHaveLength(2);
  });

  it("一覧は新しい順で上限まで、打ち切ったら truncated", async () => {
    const bridge = bridgeWithConfirmedSource();
    const prefix = `${bridge.personalOwner}/${bridge.personalRootId}/`;
    const add = (index: number, phase: "sent" | "accepted") => bridge.personalNihoRecords.set(`${prefix}intent-${index}`, {
      intentId: `intent-${index}`, submissionKey: `submit_${index.toString(16).padStart(32, "0")}`, body: "{}", baseRevision: 0,
      projectId: "proj1", recordingPageId: "pg1", recordingId: "rec1", phase, runId: null, state: null, reasonCode: null,
      createdAt: new Date(Date.UTC(2026, 9, 17, 0, 0, index)).toISOString(),
    });
    for (let index = 0; index < 55; index += 1) add(index, "sent");
    const listed = await bridge.personalNihoPending();
    expect(listed.truncated).toBe(true);
    expect(listed.items).toHaveLength(50);
    expect(listed.items[0]!.intentId).toBe("intent-54");
    // 読む数の上限: 新しいものから読み、打ち切りを知らせる
    bridge.personalNihoRecords.clear();
    for (let index = 0; index < 5; index += 1) add(index, "sent");
    for (let index = 5; index < 20; index += 1) add(index, "accepted");
    bridge.personalNihoPendingScanCap = 10;
    await expect(bridge.personalNihoPending()).resolves.toEqual({ items: [], truncated: true });
    bridge.personalNihoPendingScanCap = 500;
    await expect(bridge.personalNihoPending()).resolves.toMatchObject({ truncated: false, items: [{ intentId: "intent-4" }, {}, {}, {}, {}] });
  });
});
