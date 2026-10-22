import { describe, expect, it, vi } from "vitest";
import { basisFor, createFlowSnapshot, type Flow, type FlowSnapshot, type ResolvedStepModel, type RunRecord, type TurnEvent } from "@niho/docs-core";
import { activeCloud, done, FakeBridge, settingsWithProviders, syncSnapshot } from "./fake-bridge";
import { versionsOf } from "../src/lib/project-view";
import { activeProfiles, defaultSettings } from "../src/lib/settings";
import {
  PersonalCancellationError,
  PersonalDispatchError,
  canonical,
  createPersonalExecutionController,
  sha256Text,
  type PersonalExecutionPorts,
  type PersonalExecutionRequest,
  type PersonalFixedSnapshot,
  type PersonalRunHistory,
} from "../src/lib/personal-execution";
import {
  createNativePersonalPorts,
  newPersonalId,
  newPersonalVersionId,
  runNativePersonalExecution,
  type NativePersonalDeps,
  type NativePersonalRequest,
} from "../src/lib/personal-native";

/**
 * 本人 Mac 実行の production の ports（personal-native.ts）を、実際の controller と FakeBridge（Native の personal_run.rs と同じ意味）で
 * 通す。外部への通信はしない（FakeBridge の turn・音声認識は台本）。
 */

const AT = "2026-10-17T00:00:00.000Z";
const OWNER_B = "c".repeat(64);
const TRANSCRIPT_TEXT = "朝市に出して三年目です";
const SPEECH_READY = {
  found: true,
  fake: false,
  available: true,
  needsDownload: false,
  engine: "apple",
  error: null,
  notice: null,
  diarization: { state: "ready", detail: null },
} as const;

const settings = settingsWithProviders(["gpt"], defaultSettings());
const baseFlow: Flow = {
  version: 1,
  id: "flow-1",
  name: "取材記事",
  revision: 2,
  guide: "固有名詞を守る",
  terms: [],
  samples: [],
  steps: [
    { id: "fix", name: "修正", instruction: "誤りを直す", provider: "gpt", profile: "standard" },
    { id: "insight", name: "インサイト", instruction: "気づきを3つ挙げる", provider: "gpt", profile: "standard" },
  ],
};
const flow: FlowSnapshot = createFlowSnapshot(baseFlow, activeProfiles(settings), ["gpt"], "subscription");

/** 工程の出力（台本）。修正は原文を、インサイトは修正の本文を受け取っているかを prompt で確かめる。 */
const OUTPUT: Record<string, string> = { fix: "修正した本文: 朝市に出して3年目です", insight: "インサイト: 続ける理由" };

/** 同期の依頼のたびに、Native が同期を 1 回終えたことにする（最後の同期の時刻が変わる）。 */
function finishSyncOnRequest(bridge: FakeBridge, also?: (projectId: string) => void) {
  const syncNow = bridge.cloudSyncNow.bind(bridge);
  let flights = 0;
  bridge.cloudSyncNow = async (projectId) => {
    await syncNow(projectId);
    const id = projectId ?? "docs-root";
    const snapshot = bridge.cloudSnapshots.get(id) ?? syncSnapshot(id);
    // Native の時刻は画面の時計（deps.now）と比べない。前より古い時刻でも「変わった」なら同期を終えた
    bridge.cloudSnapshots.set(id, { ...snapshot, lastSyncedAt: `2020-01-01T00:00:${String(++flights).padStart(2, "0")}.000Z` });
    also?.(id);
  };
}

/** フォルダ `proj1` の録音（ページ `pg1`・録音 `rec1`）と参考ページ。NIHO クラウドと同期していて、同期の依頼で同期を終える。 */
function setupBridge(): FakeBridge {
  const bridge = new FakeBridge();
  bridge.cloud = activeCloud();
  bridge.cloudSnapshots.set("proj1", syncSnapshot("proj1", { lastSyncedAt: "2026-10-16T23:00:00.000Z" }));
  finishSyncOnRequest(bridge);
  bridge.presetAbout({ name: "高浜", text: "鎌倉で朝市の記事を書いている" });
  bridge.speechStatus = async () => ({ ...SPEECH_READY, diarization: { ...SPEECH_READY.diarization } });
  bridge.transcribeResult = [{ jsonl: `{"type":"segment","start":1,"end":3,"text":"${TRANSCRIPT_TEXT}"}\n`, durationSec: 5 }];
  bridge.turnScript = (request) => {
    const step = request.system_prompt.includes("誤りを直す") ? "fix" : "insight";
    return [{ type: "TextDelta", text: OUTPUT[step]! } as TurnEvent, done(OUTPUT[step]!, "EndTurn", "s1", request.model)];
  };
  bridge.projects.set("proj1", {
    project: {
      version: 1,
      id: "proj1",
      name: "朝市の取材",
      createdAt: AT,
      info: { terms: [{ term: "朝市", reading: "あさいち", variants: [], note: "" }], background: "鎌倉の朝市の取材" },
      pages: [
        { id: "pg1", kind: "rec", title: "録音", createdAt: AT, recordingId: "rec1" },
        { id: "ref1", kind: "doc", title: "前回のメモ", createdAt: AT },
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
          speakers: "none",
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
    docs: { ref1: "前回は野菜の話をした" },
  });
  return bridge;
}

/** 同じ保存先・同じ app data（intent）で開き直したアプリ。 */
function restarted(previous: FakeBridge): FakeBridge {
  const bridge = setupBridge();
  bridge.projects = previous.projects;
  bridge.personalIntents = previous.personalIntents;
  bridge.personalVersionFiles = previous.personalVersionFiles;
  bridge.personalAggregates = previous.personalAggregates;
  return bridge;
}

function deps(bridge: FakeBridge, fields: Partial<NativePersonalDeps> = {}): NativePersonalDeps {
  let id = 0;
  return {
    bridge,
    flushDirty: async () => undefined,
    connection: () => ({ connection: "subscription", providers: ["gpt"] }),
    readEntitlement: async () => ({ planConfirmed: true, usage: "available" }),
    now: () => new Date(AT),
    newId: (prefix) => `${prefix}_${++id}`,
    syncWait: { timeoutMs: 20, intervalMs: 5, sleep: async () => undefined },
    ...fields,
  };
}

function request(fields: Partial<NativePersonalRequest> = {}): NativePersonalRequest {
  return {
    runId: "run_1",
    intentId: "intent_1",
    projectId: "proj1",
    recordingPageId: "pg1",
    recordingId: "rec1",
    route: { kind: "local_full" },
    transcriptionProvider: "this-mac",
    continuationOfRunId: null,
    consentVersion: "consent-v1",
    stepIds: ["fix", "insight"],
    ...fields,
  };
}

function rec(bridge: FakeBridge) {
  return bridge.recording("proj1", "rec1");
}

function aggregateOf(bridge: FakeBridge, runId = "run_1"): PersonalRunHistory {
  const aggregate = bridge.personalAggregates.get(runId);
  if (!aggregate) throw new Error("aggregate missing");
  return aggregate;
}

describe("本人 Mac 実行の ports（Native 経由・FakeBridge と実 controller）", () => {
  it("LOCAL の後続を NIHO API から受け取り、版と runs.jsonl の公開後に ACK する", async () => {
    const bridge = setupBridge();
    const source = await runNativePersonalExecution(deps(bridge), request({
      route: { kind: "local_transcription_only" }, stepIds: [],
    }));
    expect(source.state).toBe("transcription_complete");
    const fixed = rec(bridge).recording.flowSnapshot;
    for (const step of fixed.steps) {
      fixed.models[step.id] = { ...fixed.models[step.id]!, provider: "gemini", model: "gemini-3.8-flash" };
    }
    bridge.personalNihoAccessResult = {
      available: true, reasonCode: null, provider: "GOOGLE", model: "gemini-3.8-flash",
      consentVersion: "2026-10-17-v2", maxRunCostMicrousd: "120000", executorReasonCode: null,
    };
    const publish = vi.spyOn(bridge, "personalPublish");
    const ack = vi.spyOn(bridge, "personalDeviceAck");
    const result = await runNativePersonalExecution(deps(bridge, {
      confirmNihoExecution: async () => undefined,
    }), request({
      runId: "run_device", intentId: "intent_device",
      route: { kind: "generation_only", executor: "device_niho_api" },
      transcriptionProvider: null, continuationOfRunId: source.runId,
      stepIds: ["fix", "insight"], consentVersion: "pending-v1",
    }));
    expect(result).toMatchObject({ state: "completed", localSaved: true, cloudAcked: false });
    expect(rec(bridge).artifacts).toEqual({ fix: bridge.personalDeviceText, insight: bridge.personalDeviceText });
    expect(bridge.turnRequests).toHaveLength(0);
    expect(bridge.personalCalls.some((call) => call.name === "personalSwapModels")).toBe(false);
    expect(ack).toHaveBeenCalledTimes(2);
    expect(bridge.personalDeviceAcked).toHaveLength(2);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(ack.mock.invocationCallOrder[0]!);
  });

  it("LOCAL の ACK 応答が失われても公開済みの版を残し、未確認を画面へ返す", async () => {
    const bridge = setupBridge();
    const source = await runNativePersonalExecution(deps(bridge), request({
      route: { kind: "local_transcription_only" }, stepIds: [],
    }));
    const fixed = rec(bridge).recording.flowSnapshot;
    fixed.models.fix = { ...fixed.models.fix!, provider: "gemini", model: "gemini-3.8-flash" };
    bridge.personalNihoAccessResult = {
      available: true, reasonCode: null, provider: "GOOGLE", model: "gemini-3.8-flash",
      consentVersion: "2026-10-17-v2", maxRunCostMicrousd: "120000", executorReasonCode: null,
    };
    const ack = vi.spyOn(bridge, "personalDeviceAck").mockRejectedValue(new Error("ack response lost"));
    const result = await runNativePersonalExecution(deps(bridge, {
      confirmNihoExecution: async () => undefined,
    }), request({
      runId: "run_device_lost_ack", intentId: "intent_device_lost_ack",
      route: { kind: "generation_only", executor: "device_niho_api" },
      transcriptionProvider: null, continuationOfRunId: source.runId,
      stepIds: ["fix"], consentVersion: "pending-v1",
    }));
    expect(result).toMatchObject({ state: "completed", localSaved: true, deliveryAckPending: true });
    expect(rec(bridge).artifacts.fix).toBe(bridge.personalDeviceText);
    expect(ack).toHaveBeenCalledTimes(2);
  });

  it("端末内の文字起こし → 修正 → インサイトが全部進み、各工程の prompt に直前の確定本文と固定した素材だけが入る", async () => {
    const bridge = setupBridge();
    const publish = vi.spyOn(bridge, "personalPublish");
    const marks = vi.spyOn(bridge, "personalMarkDispatch");
    // 実行中に画面の側で参考ページ・あなたについてを書き換えても、受付時に固定した素材で作る
    bridge.onTurnStarted = () => {
      bridge.projects.get("proj1")!.docs.ref1 = "書き換えた参考";
      bridge.presetAbout({ name: "別の人", text: "別の説明" });
    };
    const result = await runNativePersonalExecution(deps(bridge), request());
    expect(result).toMatchObject({ state: "completed", transcriptionExecutions: 1, localSaved: true });
    const stored = rec(bridge);
    expect(stored.transcript).toBe(`[00:00:01] ${TRANSCRIPT_TEXT}\n`);
    expect(stored.artifacts).toEqual({ fix: `${OUTPUT.fix}\n`, insight: `${OUTPUT.insight}\n` });

    // 修正は原文を、インサイトは修正の確定本文を受け取る。参考・背景情報・あなたについては固定した値
    expect(bridge.turnRequests).toHaveLength(2);
    const [fix, insight] = bridge.turnRequests;
    expect(fix!.user_prompt).toContain(`## 文字起こし\n\n[00:00:01] ${TRANSCRIPT_TEXT}`);
    expect(fix!.user_prompt).toContain("### 前回のメモ\n\n前回は野菜の話をした");
    expect(fix!.user_prompt).toContain("鎌倉の朝市の取材");
    expect(fix!.system_prompt).toContain("呼び名: 高浜");
    expect(insight!.user_prompt).toContain(`## 修正\n\n${OUTPUT.fix}`);
    expect(insight!.user_prompt).toContain("前回は野菜の話をした");
    expect(insight!.user_prompt).not.toContain("書き換えた参考");
    expect(insight!.system_prompt).not.toContain("別の人");

    // 外部送信（修正・インサイト）の直前にだけ dispatch marker。端末内の文字起こしには付けない
    expect(marks.mock.calls.map((call) => call[2])).toEqual(["fix", "insight"]);

    // 公開は工程ごとに personal_publish 1 回。数値の版は Native の採番で、runs.jsonl・集約・返り値が一致する
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls.map((call) => call[1].stepId)).toEqual(["source", "fix", "insight"]);
    expect(publish.mock.calls.every((call) => call[1].record?.version === null)).toBe(true);
    const runs = stored.runs as Array<RunRecord & { personalRunId?: string; origin?: string }>;
    const numbered = (stepId: string) => versionsOf(runs, stepId)[0]!;
    for (const [index, stepId] of ["source", "fix", "insight"].entries()) {
      const version = result.versions[index]!;
      expect(numbered(stepId)).toMatchObject({ version: 1, versionPath: version.path, personalRunId: "run_1", origin: "this_pc" });
      expect(version.displayVersion).toBe(numbered(stepId).version);
    }
    expect(aggregateOf(bridge).versions.map((version) => version.displayVersion)).toEqual([1, 1, 1]);
    expect(aggregateOf(bridge).state).toBe("completed");
    // runner の実行の詳細（前提・字数）も公開の行に残る（今の App の履歴・前提の比較と同じ材料）
    expect(numbered("fix")).toMatchObject({ provider: "gpt", connection: "subscription", inputChars: expect.any(Number) });
    expect(numbered("fix").basis?.source).toBeDefined();
    // 途中記録は intent の private 領域へ（runs.jsonl には成功の行だけ）
    expect(bridge.personalPrivate.get("intent_1/checkpoint")).toMatchObject({ stepId: "insight" });
    expect(runs).toHaveLength(3);
    expect(bridge.personalLeaseReleases).toHaveLength(1);
    expect(bridge.locks.size).toBe(0);
  });

  it("VTTの確定原文から修正・インサイトだけを実行し、保存した前提を再読込時にも保つ", async () => {
    const bridge = setupBridge();
    const stored = rec(bridge);
    stored.recording.flowSnapshot.transcription = false;
    stored.recording.source = { kind: "text", transcriptImport: { format: "vtt", file: "source.vtt", name: "meeting.vtt", hash: "a".repeat(64) } };
    stored.transcript = "[00:00:01] Recorder: 確定した原文\n";
    stored.versions.source = [stored.transcript];
    stored.runs.push({ id: "save-vtt", kind: "save", at: AT, stepId: "source", stepName: "文字起こし", version: 1,
      versionPath: "recordings/rec1/versions/source/v_1234567890123456789012.md", result: "saved" });
    const transcribe = vi.spyOn(bridge, "transcribe");
    const result = await runNativePersonalExecution(deps(bridge), request({
      route: { kind: "generation_only", executor: "this_pc" }, transcriptionProvider: null, continuationOfRunId: "save-vtt",
    }));
    expect(result).toMatchObject({ state: "completed", transcriptionExecutions: 0 });
    expect(transcribe).not.toHaveBeenCalled();
    expect(bridge.turnRequests).toHaveLength(2);
    expect(bridge.turnRequests[0]!.user_prompt).toContain("## 文字起こし\n");
    const expected = basisFor(stored.recording.flowSnapshot, 0, {
      sourceName: "文字起こし", source: stored.transcript!, artifacts: {}, info: { speakers: "none", language: "ja", terms: [], background: "" },
    });
    expect(versionsOf(stored.runs, "fix")[0]!.basis?.source).toBe(expected.source);
    expect(stored.transcript).toBe("[00:00:01] Recorder: 確定した原文\n");
  });

  it("前に版がある原文は Native が次の番号を採番し、返り値・集約・runs.jsonl の番号がそろう", async () => {
    const bridge = setupBridge();
    const stored = rec(bridge);
    stored.versions.source = ["前の原文"];
    stored.transcript = "前の原文";
    stored.runs.push({ id: "run-old", kind: "run", at: AT, stepId: "source", stepName: "文字起こし", version: 1, result: "saved" });
    const result = await runNativePersonalExecution(deps(bridge), request({ route: { kind: "local_transcription_only" }, stepIds: [] }));
    expect(result.state).toBe("transcription_complete");
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0]!.displayVersion).toBe(2);
    expect(result.sourceVersion?.displayVersion).toBe(2);
    expect(versionsOf(stored.runs, "source")[0]).toMatchObject({ version: 2, versionPath: result.versions[0]!.path });
    expect(aggregateOf(bridge).versions[0]!.displayVersion).toBe(2);
    expect(aggregateOf(bridge).sourceVersion?.displayVersion).toBe(2);
  });

  it("受け付けた固定入力から改ざんした派生は Native が受け入れず、送信しない（INPUT_CHANGED）", async () => {
    const bridge = setupBridge();
    const req = request();
    const opened = await bridge.personalOpen({
      projectId: req.projectId, recordingPageId: req.recordingPageId, recordingId: req.recordingId, intentId: req.intentId, runId: req.runId,
      route: req.route, transcriptionProvider: req.transcriptionProvider,
    });
    const native = createNativePersonalPorts(deps(bridge), opened, req);
    const ports: PersonalExecutionPorts = {
      ...native.ports,
      async guardExecution(input) {
        if (input.phase !== "before_dispatch" || input.snapshot.route.kind !== "generation_only") return native.ports.guardExecution(input);
        // 原文の確定の後の派生で、固定モデルを差し替えて hash を付け直した
        const tampered: PersonalFixedSnapshot = structuredClone(input.snapshot);
        tampered.fixedModels.fix = { ...tampered.fixedModels.fix!, model: "gpt-5.6-luna" };
        const { snapshotSha256: _ignored, ...rest } = tampered;
        tampered.snapshotSha256 = await sha256Text(canonical(rest));
        return bridge.personalGuard(opened.handle, input.phase, tampered);
      },
    };
    const execution: PersonalExecutionRequest = {
      runId: req.runId, intentId: req.intentId, originDeviceId: "mac-1", ownerAccountId: opened.ownerAccountId, rootId: opened.rootId,
      containerRef: { kind: "folder", projectId: "proj1" }, recordingPageId: "pg1", recordingId: "rec1", route: req.route,
      continuationOfRunId: null, consentVersion: req.consentVersion, stepIds: req.stepIds,
    };
    await expect(createPersonalExecutionController(ports)(execution)).rejects.toMatchObject({ code: "INPUT_CHANGED" });
    expect(bridge.turnRequests).toHaveLength(0);
    expect(rec(bridge).artifacts).toEqual({});
    await bridge.personalClose(opened.handle);
  });

  it("AI の応答待ちにアカウントが A→B に変わったら、A の候補だけを残し、B の現在本文は変えず、B へは送らない", async () => {
    const bridge = setupBridge();
    bridge.onTurnStarted = () => bridge.switchPersonalAccount(OWNER_B);
    await expect(runNativePersonalExecution(deps(bridge), request())).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    const stored = rec(bridge);
    // 切替の前に確定した原文はそのまま、修正は現在本文にも番号つきの版にもならない
    expect(stored.transcript).toBe(`[00:00:01] ${TRANSCRIPT_TEXT}\n`);
    expect(stored.artifacts.fix).toBeUndefined();
    expect(versionsOf(stored.runs, "fix")).toHaveLength(0);
    // 送信は切替の前の 1 回だけ（B の本人での送信ゼロ）
    expect(bridge.turnRequests).toHaveLength(1);
    // 結果は捕捉した元の本人の不変の候補として残る
    const retained = aggregateOf(bridge).retainedCandidates;
    expect(retained).toHaveLength(1);
    expect(retained[0]!.path).toMatch(/^recordings\/rec1\/versions\/fix\/v_[A-Za-z0-9_-]{22}\.md$/);
    expect(bridge.personalVersionFiles.get(`proj1/${retained[0]!.path}`)).toBe(`${OUTPUT.fix}\n`);
    // 旧本人の通信で lease を返さない・ロックは捕捉した保存先で返す
    expect(bridge.personalLeaseReleases).toEqual([]);
    expect(bridge.locks.size).toBe(0);
  });

  it("人の編集と競合したら現在本文は人の編集のまま、候補は残して input_changed で止める", async () => {
    const bridge = setupBridge();
    bridge.onTurnStarted = () => {
      if (bridge.turnRequests.length === 1) rec(bridge).artifacts.fix = "人が直した本文";
    };
    const result = await runNativePersonalExecution(deps(bridge), request());
    expect(result.state).toBe("input_changed");
    expect(rec(bridge).artifacts.fix).toBe("人が直した本文");
    expect(result.retainedCandidates).toHaveLength(1);
    expect(bridge.personalVersionFiles.get(`proj1/${result.retainedCandidates[0]!.path}`)).toBe(`${OUTPUT.fix}\n`);
    expect(bridge.turnRequests).toHaveLength(1);
    expect(versionsOf(rec(bridge).runs, "fix")).toHaveLength(0);
  });

  it("checkpoint を private に保存できなければ、その工程から先は送信しない", async () => {
    const bridge = setupBridge();
    const save = bridge.personalSavePrivate.bind(bridge);
    bridge.personalSavePrivate = async (handle, intentId, kind, payload) => {
      if (kind === "checkpoint" && (payload as { stepId: string }).stepId === "fix") throw { code: "personal_intent_io", message: "実行の記録を保存できませんでした。" };
      return save(handle, intentId, kind, payload);
    };
    const marks = vi.spyOn(bridge, "personalMarkDispatch");
    await expect(runNativePersonalExecution(deps(bridge), request())).rejects.toBeInstanceOf(PersonalDispatchError);
    expect(bridge.turnRequests).toHaveLength(0);
    expect(marks).not.toHaveBeenCalled();
    expect(rec(bridge).artifacts).toEqual({});
  });

  it("dispatch marker を書けなければ送らない", async () => {
    const bridge = setupBridge();
    bridge.personalMarkDispatch = async () => {
      throw { code: "personal_intent_io", message: "実行の記録を保存できませんでした。" };
    };
    await expect(runNativePersonalExecution(deps(bridge), request())).rejects.toBeInstanceOf(PersonalDispatchError);
    expect(bridge.turnRequests).toHaveLength(0);
    // 端末内の文字起こしは外部送信ではないので marker なしで確定している
    expect(rec(bridge).transcript).toBe(`[00:00:01] ${TRANSCRIPT_TEXT}\n`);
  });

  it("送信の後に結果を確かめられなければ result_unknown で、同じ intent を開き直しても再起動しても送り直さない", async () => {
    const bridge = setupBridge();
    const runTurn = bridge.runTurn.bind(bridge);
    bridge.runTurn = async (...args) => {
      await runTurn(...args);
      throw new Error("応答が途切れました");
    };
    await expect(runNativePersonalExecution(deps(bridge), request())).rejects.toMatchObject({ resultUnknown: true });
    expect(bridge.turnRequests).toHaveLength(1);
    await expect(runNativePersonalExecution(deps(bridge), request({ runId: "run_2" }))).rejects.toMatchObject({ code: "RESULT_UNKNOWN_NO_RETRY" });
    expect(bridge.turnRequests).toHaveLength(1);
    const after = restarted(bridge);
    await expect(runNativePersonalExecution(deps(after), request({ runId: "run_3" }))).rejects.toMatchObject({ code: "RESULT_UNKNOWN_NO_RETRY" });
    expect(after.turnRequests).toHaveLength(0);
    expect(bridge.locks.size + after.locks.size).toBe(0);
  });

  it("同じ intent の二重の開始・終わった後の開き直し・再起動でも送信は工程ごとに 1 回", async () => {
    const bridge = setupBridge();
    const [first, second] = await Promise.allSettled([
      runNativePersonalExecution(deps(bridge), request()),
      runNativePersonalExecution(deps(bridge), request()),
    ]);
    expect(first).toMatchObject({ status: "fulfilled", value: { state: "completed" } });
    expect(second).toMatchObject({ status: "rejected", reason: { code: "store_busy" } });
    expect(bridge.turnRequests).toHaveLength(2);
    await expect(runNativePersonalExecution(deps(bridge), request({ runId: "run_2" }))).rejects.toMatchObject({ code: "INTENT_ALREADY_EXISTS" });
    const after = restarted(bridge);
    await expect(runNativePersonalExecution(deps(after), request({ runId: "run_3" }))).rejects.toMatchObject({ code: "INTENT_ALREADY_EXISTS" });
    expect(bridge.turnRequests).toHaveLength(2);
    expect(after.turnRequests).toHaveLength(0);
  });

  it("別の Mac が実行中なら開始しない", async () => {
    const bridge = setupBridge();
    bridge.leaseHeldBy = "Mac Studio";
    const read = vi.spyOn(bridge, "personalReadMaterial");
    await expect(runNativePersonalExecution(deps(bridge), request())).rejects.toMatchObject({ code: "lease_held", message: expect.stringContaining("Mac Studio") });
    expect(read).not.toHaveBeenCalled();
    expect(bridge.turnRequests).toHaveLength(0);
    expect(bridge.locks.size).toBe(0);
  });

  it("同じ録音のNIHO実行が進行中ならローカル全経路も開始しない", async () => {
    const bridge = setupBridge();
    bridge.personalNihoServerRuns = [{ projectId: "proj1", recordingPageId: "pg1", recordingId: "rec1", state: "running" }];
    await expect(runNativePersonalExecution(deps(bridge), request())).rejects.toMatchObject({ code: "personal_niho_run_active" });
    expect(bridge.transcribeLanguages).toHaveLength(0);
    expect(bridge.turnRequests).toHaveLength(0);
    expect(bridge.personalNihoListCalls).toBe(1);
  });

  it("NIHO に届かないときは端末内の文字起こしだけ始められ、この Mac に保存済みでもクラウドの受領は確定にしない", async () => {
    const bridge = setupBridge();
    bridge.personalLeaseUnavailable = true;
    await expect(runNativePersonalExecution(deps(bridge), request())).rejects.toMatchObject({ code: "personal_lease_unavailable" });
    await expect(
      runNativePersonalExecution(deps(bridge), request({ route: { kind: "local_transcription_only" }, stepIds: [], transcriptionProvider: "gemini" })),
    ).rejects.toMatchObject({ code: "personal_lease_unavailable" });
    const result = await runNativePersonalExecution(deps(bridge), request({ route: { kind: "local_transcription_only" }, stepIds: [] }));
    expect(result).toMatchObject({ state: "transcription_complete", localSaved: true, cloudAcked: false });
    expect(rec(bridge).transcript).toBe(`[00:00:01] ${TRANSCRIPT_TEXT}\n`);
    expect(bridge.turnRequests).toHaveLength(0);
    // NIHO に届かないので、開始の前の同期の確認はしない（Native が検証した手元の写しを使う）
    expect(bridge.cloudCallsOf("cloudProjectStatus")).toHaveLength(0);
  });

  it("同期が終わっていなければ始めず、クラウドの受領は同期の状態で判定する", async () => {
    const bridge = setupBridge();
    bridge.personalAutoSync = false;
    bridge.cloudSnapshots.set("proj1", syncSnapshot("proj1", { dirty: { "recordings/rec1/transcript.md": 3 }, localGeneration: 3, lastSyncedAt: "2026-10-16T23:00:00.000Z" }));
    await expect(runNativePersonalExecution(deps(bridge), request())).rejects.toMatchObject({ code: "SYNC_INCOMPLETE" });
    expect(bridge.cloudCallsOf("cloudSyncNow")).toEqual([["proj1"]]);
    expect(bridge.turnRequests).toHaveLength(0);

    // 依頼の後に同期を終えていない（依頼の前に読んだ最後の同期の時刻のまま）は、画面の時計より新しい時刻でも始めない
    const stale = setupBridge();
    stale.personalAutoSync = false;
    stale.cloudSyncNow = FakeBridge.prototype.cloudSyncNow.bind(stale);
    stale.cloudSnapshots.set("proj1", syncSnapshot("proj1", { lastSyncedAt: "2026-10-18T00:00:00.000Z" }));
    await expect(runNativePersonalExecution(deps(stale), request())).rejects.toMatchObject({ code: "SYNC_INCOMPLETE" });
    expect(stale.cloudCallsOf("cloudSyncNow")).toEqual([["proj1"]]);
    expect(stale.turnRequests).toHaveLength(0);

    // 公開の後に未送信が残れば cloudAcked は false、送り終えれば true
    const pending = setupBridge();
    pending.personalAutoSync = false;
    const publish = pending.personalPublish.bind(pending);
    pending.personalPublish = async (handle, input) => {
      const result = await publish(handle, input);
      pending.cloudSnapshots.set("proj1", { ...pending.cloudSnapshots.get("proj1")!, dirty: { "recordings/rec1/transcript.md": 1 }, localGeneration: 1 });
      return result;
    };
    await expect(runNativePersonalExecution(deps(pending), request({ route: { kind: "local_transcription_only" }, stepIds: [] }))).resolves.toMatchObject({ localSaved: true, cloudAcked: false });
    const acked = setupBridge();
    finishSyncOnRequest(acked, (projectId) => acked.ackCloud(projectId));
    await expect(runNativePersonalExecution(deps(acked), request({ route: { kind: "local_transcription_only" }, stepIds: [] }))).resolves.toMatchObject({ localSaved: true, cloudAcked: true });
  });

  it("Gemini の文字起こしは区切りごとの送信の直前に dispatch marker を書く", async () => {
    const bridge = setupBridge();
    bridge.audioPartScript = (_request, call) => [done(call === 0 ? `[00:02] ${TRANSCRIPT_TEXT}。` : "[00:01] 鎌倉の朝市です。", "EndTurn", null, "gemini-3.8-flash-low")];
    const marks = vi.spyOn(bridge, "personalMarkDispatch");
    const result = await runNativePersonalExecution(deps(bridge), request({ route: { kind: "local_transcription_only" }, stepIds: [], transcriptionProvider: "gemini" }));
    expect(result.state).toBe("transcription_complete");
    expect(bridge.audioPartRequests).toHaveLength(2);
    expect(marks.mock.calls.map((call) => call[2])).toEqual(["source", "source"]);
    expect(rec(bridge).transcript).toContain(TRANSCRIPT_TEXT);
  });

  it("Deepgram APIキー経路をNative operation・dispatch marker・固定モデルで文字起こしする", async () => {
    const bridge = setupBridge();
    bridge.keychain.set("deepgram", "dg_test_1234567890");
    const marks = vi.spyOn(bridge, "personalMarkDispatch");
    const result = await runNativePersonalExecution(
      deps(bridge, { connection: () => ({ connection: "apiKey", providers: ["gpt"] }) }),
      request({ route: { kind: "local_transcription_only" }, stepIds: [], transcriptionProvider: "deepgram" }),
    );
    expect(result).toMatchObject({ state: "transcription_complete", transcriptionExecutions: 1 });
    expect(bridge.deepgramRequests).toHaveLength(1);
    expect(marks.mock.calls.map((call) => call[2])).toEqual(["source"]);
    expect(rec(bridge).runs.at(-1)).toMatchObject({ provider: "deepgram", model: "nova-3", modelUsed: "nova-3" });
  });

  it("文字起こしのエンジンの方式はモデルの方式と別に固定する（サブスクリプションのまま Deepgram・API キーの Gemini を使える）", async () => {
    // モデルの方式はサブスクリプションのまま、Deepgram（API キー）で文字起こしする
    const deepgram = setupBridge();
    deepgram.keychain.set("deepgram", "dg_test_1234567890");
    const viaDeepgram = await runNativePersonalExecution(
      deps(deepgram),
      request({ route: { kind: "local_transcription_only" }, stepIds: [], transcriptionProvider: "deepgram", transcriptionConnection: "apiKey" }),
    );
    expect(viaDeepgram.state).toBe("transcription_complete");
    expect(rec(deepgram).runs.at(-1)).toMatchObject({ provider: "deepgram", connection: "apiKey" });

    // API キーの Gemini は Gemini API で区切りを送り、固定値に方式を持つ（モデルの方式はサブスクリプションのまま）
    const geminiApi = setupBridge();
    geminiApi.audioPartScript = (_request, call) => [done(call === 0 ? `[00:02] ${TRANSCRIPT_TEXT}。` : "[00:01] 鎌倉の朝市です。", "EndTurn", null, "gemini-3.8-flash")];
    const reserve = vi.spyOn(geminiApi, "personalReserveIntent");
    const viaApi = await runNativePersonalExecution(
      deps(geminiApi, { readEntitlement: async () => ({ planConfirmed: false, usage: "unknown" }) }),
      request({ route: { kind: "local_transcription_only" }, stepIds: [], transcriptionProvider: "gemini", transcriptionConnection: "apiKey" }),
    );
    expect(viaApi.state).toBe("transcription_complete");
    expect(geminiApi.audioPartRequests.map((part) => part.request.provider)).toEqual(["GeminiApi", "GeminiApi"]);
    expect(reserve.mock.calls[0]![2].transcriptionModel).toEqual({ provider: "gemini", model: "gemini-3.8-flash", effort: "low", connection: "apiKey" });
    expect(rec(geminiApi).runs.at(-1)).toMatchObject({ provider: "gemini", connection: "apiKey" });

    // サブスクリプションの Gemini は、モデルの方式が API キーでも Antigravity CLI で送り、固定値は以前と同じ形
    const geminiSub = setupBridge();
    geminiSub.audioPartScript = geminiApi.audioPartScript;
    const reserveSub = vi.spyOn(geminiSub, "personalReserveIntent");
    const viaSub = await runNativePersonalExecution(
      deps(geminiSub, { connection: () => ({ connection: "apiKey", providers: ["gpt"] }) }),
      request({ route: { kind: "local_transcription_only" }, stepIds: [], transcriptionProvider: "gemini", transcriptionConnection: "subscription" }),
    );
    expect(viaSub.state).toBe("transcription_complete");
    expect(geminiSub.audioPartRequests.map((part) => part.request.provider)).toEqual(["GeminiCli", "GeminiCli"]);
    expect(reserveSub.mock.calls[0]![2].transcriptionModel).toEqual({ provider: "gemini", model: "gemini-3.8-flash", effort: "low" });
    expect(rec(geminiSub).runs.at(-1)).toMatchObject({ provider: "gemini", connection: "subscription" });
  });

  it("文字起こしのエンジンと方式の食い違った依頼は Native が受け付けない", async () => {
    const bridge = setupBridge();
    for (const fields of [
      { transcriptionProvider: "deepgram", transcriptionConnection: "subscription" },
      { transcriptionProvider: "this-mac", transcriptionConnection: "apiKey" },
    ] as const) {
      await expect(
        runNativePersonalExecution(deps(bridge), request({ route: { kind: "local_transcription_only" }, stepIds: [], ...fields })),
      ).rejects.toMatchObject({ code: "personal_bad_request" });
    }
    expect(bridge.audioPartRequests).toHaveLength(0);
    expect(bridge.deepgramRequests).toHaveLength(0);
  });

  it("APIキーの資格情報・固定モデルを検証してローカル生成を続ける", async () => {
    const bridge = setupBridge();
    // 録音は別端末でsubscriptionとして作られたまま。この端末で本人が明示したAPIキーを同じprovider/model/effortへ使う。
    bridge.statuses.OpenAiApi = { ...bridge.statuses.OpenAiApi, models: ["gpt-5.6-terra"] };
    const result = await runNativePersonalExecution(
      deps(bridge, {
        connection: () => ({ connection: "apiKey", providers: ["gpt"] }),
        readEntitlement: async () => ({ planConfirmed: false, usage: "unknown" }),
      }),
      request(),
    );
    expect(result.state).toBe("completed");
    expect(bridge.statusCalls.filter((provider) => provider === "OpenAiApi")).toHaveLength(4);
    expect(bridge.turnRequests).toHaveLength(2);
  });

  /** 確定原文があり、工程の AI を Mac の Claude に固定した録音（NIHO の AI は Gemini）。 */
  function nihoBridge(): FakeBridge {
    const bridge = setupBridge();
    bridge.personalNihoAccessResult = { ...bridge.personalNihoAccessResult, consentVersion: "consent-v1" };
    const stored = rec(bridge);
    stored.versions.source = ["確定した原文"];
    stored.transcript = "確定した原文";
    stored.runs.push({
      id: "run-src",
      kind: "run",
      at: AT,
      stepId: "source",
      stepName: "文字起こし",
      version: 1,
      versionPath: "recordings/rec1/versions/source/v_1234567890123456789012.md",
      result: "saved",
    });
    for (const stepId of ["fix", "insight"]) {
      stored.recording.flowSnapshot.models[stepId] = {
        provider: "claude",
        model: "claude-sonnet-5",
        effort: "high",
        profileId: "standard",
        profileName: "標準",
        connection: "subscription",
      };
    }
    return bridge;
  }
  const nihoRequest = (fields: Partial<NativePersonalRequest> = {}) =>
    request({ route: { kind: "generation_only", executor: "niho_api" }, transcriptionProvider: null, continuationOfRunId: "run-src", ...fields });
  /** NIHO の AI（docs-core の nihoApiStepModel）の固定モデル。 */
  const NIHO_MODEL: ResolvedStepModel = {
    provider: "gemini", model: "gemini-3.8-flash", effort: "medium", profileId: "standard", profileName: "NIHO API", connection: "apiKey",
  };

  it("確定原文からNIHO APIへ後続だけをNative本文で受付し、文字起こしやローカル生成をしない", async () => {
    const bridge = nihoBridge();
    const stored = rec(bridge);
    const runsBefore = structuredClone(stored.runs);
    const order: string[] = [];
    const swapModels = bridge.personalSwapModels.bind(bridge);
    bridge.personalSwapModels = async (...args) => { order.push("personalSwapModels"); return swapModels(...args); };
    const sync = bridge.cloudSyncNow.bind(bridge);
    bridge.cloudSyncNow = async (projectId) => { order.push("cloudSyncNow"); return sync(projectId); };
    const read = bridge.personalReadMaterial.bind(bridge);
    bridge.personalReadMaterial = async (...args) => { order.push("personalReadMaterial"); return read(...args); };
    const submit = bridge.personalNihoSubmit.bind(bridge);
    bridge.personalNihoSubmit = async (...args) => { order.push("personalNihoSubmit"); return submit(...args); };
    const confirms: Array<{ models: readonly ResolvedStepModel[]; swap: boolean }> = [];
    await expect(
      runNativePersonalExecution(deps(bridge, { confirmNihoExecution: async ({ models, swap }) => { confirms.push({ models: structuredClone(models), swap }); } }), nihoRequest()),
    ).resolves.toMatchObject({ state: "submitted", remoteState: "queued", transcriptionExecutions: 0 });
    // 確認には録音の Claude ではなく NIHO の AI を出し、同意の後に残りの工程だけを NIHO の AI へ持ち替えて 1 回書く。
    // 書いた録音を NIHO へ届けてから素材を読み直し、Gemini の工程で送る
    expect(confirms).toEqual([{ models: [NIHO_MODEL, NIHO_MODEL], swap: true }]);
    expect(order).toEqual([
      "cloudSyncNow", "personalReadMaterial", "personalReadMaterial", "personalSwapModels", "cloudSyncNow", "personalReadMaterial", "personalNihoSubmit",
    ]);
    expect(stored.recording.flowSnapshot.models).toEqual({ fix: NIHO_MODEL, insight: NIHO_MODEL });
    expect(bridge.locks.size).toBe(0);
    expect(bridge.personalOps.size).toBe(0);
    expect(bridge.personalNihoPosts).toHaveLength(1);
    expect(JSON.parse(bridge.personalNihoPosts[0]!.body)).toMatchObject({
      recordingId: "rec1",
      steps: [
        { stepKey: "fix", kind: "REVISION", provider: "gemini", model: "gemini-3.8-flash", effort: "medium" },
        { stepKey: "insight", kind: "INSIGHT", provider: "gemini", model: "gemini-3.8-flash", effort: "medium" },
      ],
    });
    expect(stored.runs).toEqual(runsBefore);
    expect(bridge.turnRequests).toHaveLength(0);
  });

  it("NIHO に任せる確認を取り消したら録音を書かず、送らない", async () => {
    const bridge = nihoBridge();
    const swaps = vi.spyOn(bridge, "personalSwapModels");
    await expect(
      runNativePersonalExecution(deps(bridge, { confirmNihoExecution: async () => { throw new PersonalCancellationError(); } }), nihoRequest()),
    ).rejects.toBeInstanceOf(PersonalCancellationError);
    expect(swaps).not.toHaveBeenCalled();
    expect(rec(bridge).recording.flowSnapshot.models.fix).toMatchObject({ provider: "claude", model: "claude-sonnet-5" });
    expect(bridge.cloudCallsOf("cloudSyncNow")).toHaveLength(1);
    expect(bridge.personalNihoPosts).toHaveLength(0);
    expect(bridge.personalOps.size).toBe(0);
  });

  it("持ち替えの後の同期が終わらなければ送らず、もう一度押したときは書き直さずに送る", async () => {
    const bridge = nihoBridge();
    const swaps = vi.spyOn(bridge, "personalSwapModels");
    // 持ち替えた録音の送信が終わらない（未送信のまま）
    const sync = bridge.cloudSyncNow.bind(bridge);
    let stuck = false;
    bridge.cloudSyncNow = async (projectId) => {
      await sync(projectId);
      if (!stuck) return;
      const snapshot = bridge.cloudSnapshots.get("proj1")!;
      bridge.cloudSnapshots.set("proj1", { ...snapshot, dirty: { "recordings/rec1/recording.json": 1 }, localGeneration: snapshot.localGeneration + 1 });
    };
    const confirms: boolean[] = [];
    const confirmNihoExecution: NativePersonalDeps["confirmNihoExecution"] = async ({ swap }) => {
      confirms.push(swap);
      stuck = swap;
    };
    await expect(runNativePersonalExecution(deps(bridge, { confirmNihoExecution }), nihoRequest())).rejects.toMatchObject({ code: "SYNC_INCOMPLETE" });
    expect(swaps).toHaveBeenCalledTimes(1);
    expect(rec(bridge).recording.flowSnapshot.models).toEqual({ fix: NIHO_MODEL, insight: NIHO_MODEL });
    expect(bridge.personalNihoPosts).toHaveLength(0);
    // 2 回目（同期は終わる）: 録音はもう NIHO の AI なので書かない（確認にも持ち替えを出さない）
    stuck = false;
    await expect(
      runNativePersonalExecution(deps(bridge, { confirmNihoExecution }), nihoRequest({ runId: "run_2", intentId: "intent_2" })),
    ).resolves.toMatchObject({ state: "submitted" });
    expect(confirms).toEqual([true, false]);
    expect(swaps).toHaveBeenCalledTimes(1);
    expect(bridge.personalNihoPosts).toHaveLength(1);
  });

  it("NIHO に任せる確認中に工程・参考・背景が変わったら書き込みと送信をしない", async () => {
    const bridge = nihoBridge();
    const swaps = vi.spyOn(bridge, "personalSwapModels");
    const confirms: boolean[] = [];
    await expect(
      runNativePersonalExecution(
        deps(bridge, {
          confirmNihoExecution: async ({ swap }) => {
            confirms.push(swap);
            rec(bridge).recording.flowSnapshot.steps[0]!.instruction = "確認後に変わった指示";
            bridge.projects.get("proj1")!.docs.ref1 = "確認後に変わった参考";
            bridge.projects.get("proj1")!.project.info.background = "確認後に変わった背景";
          },
        }),
        nihoRequest(),
      ),
    ).rejects.toMatchObject({ code: "INPUT_CHANGED" });
    expect(confirms).toEqual([true]);
    expect(swaps).not.toHaveBeenCalled();
    expect(rec(bridge).recording.flowSnapshot.models.fix).toMatchObject({ provider: "claude", model: "claude-sonnet-5" });
    expect(bridge.personalNihoPosts).toHaveLength(0);
    expect(bridge.personalOps.size).toBe(0);
  });

  it("公開が確定した後の確かめで失敗しても、Native が書いた集約（版・番号つき）を候補保持の古い内容で上書きしない", async () => {
    const bridge = setupBridge();
    const publish = bridge.personalPublish.bind(bridge);
    bridge.personalPublish = async (handle, input) => {
      const result = await publish(handle, input);
      // 修正の公開は確定したが、返り値の版が保存済み候補と食い違った
      return input.stepId === "fix" && result.status === "committed" ? { ...result, version: { ...result.version, originRunId: "run_other" } } : result;
    };
    await expect(runNativePersonalExecution(deps(bridge), request())).rejects.toMatchObject({ code: "COMMITTED_VERSION_MISMATCH" });
    const stored = rec(bridge);
    const fixRow = versionsOf(stored.runs, "fix")[0]!;
    expect(stored.artifacts.fix).toBe(`${OUTPUT.fix}\n`);
    const aggregate = aggregateOf(bridge);
    // 失敗の印だけが足され、公開した版（runs.jsonl と同じ番号）は集約に残る
    expect(aggregate.state).toBe("failed");
    expect(aggregate.versions.map((version) => [version.path, version.displayVersion])).toEqual([
      [versionsOf(stored.runs, "source")[0]!.versionPath, 1],
      [fixRow.versionPath, fixRow.version],
    ]);
    expect(aggregate.retainedCandidates).toEqual([]);
    expect(bridge.turnRequests).toHaveLength(1);
  });

  it("送信直前に Native が拒否した（送っていない）ときは result_unknown にせず失敗にする", async () => {
    const bridge = setupBridge();
    // marker は書けたが、送信の直前に Native の guard が拒否した（marker の無い送信の拒否と同じ code）
    const mark = bridge.personalMarkDispatch.bind(bridge);
    bridge.personalMarkDispatch = async (handle, intentId, stepId) => {
      await mark(handle, intentId, stepId);
      bridge.personalOps.get(handle)!.dispatchOpen = false;
    };
    await expect(runNativePersonalExecution(deps(bridge), request())).rejects.toMatchObject({ resultUnknown: false });
    expect(bridge.turnRequests).toHaveLength(0);
    expect(aggregateOf(bridge).state).toBe("failed");
    expect(rec(bridge).runs.at(-1)).toMatchObject({ stepId: "fix", result: "failed", reasonCode: "DispatchRejected" });
    // 送っていないと分かっているので「結果不明」の扱い（自動では送り直さない）にはしない
    await expect(runNativePersonalExecution(deps(restarted(bridge)), request({ runId: "run_2" }))).rejects.toMatchObject({ code: "INTENT_ALREADY_EXISTS" });
  });

  it("取り消すと Native の取消を通し、送信しない", async () => {
    const bridge = setupBridge();
    const controller = new AbortController();
    const cancel = vi.spyOn(bridge, "personalCancel");
    bridge.onTranscribeStarted = () => controller.abort();
    await expect(runNativePersonalExecution(deps(bridge, { signal: controller.signal }), request())).rejects.toMatchObject({ name: "PersonalCancellationError" });
    expect(cancel).toHaveBeenCalled();
    expect(bridge.turnRequests).toHaveLength(0);
    expect(bridge.locks.size).toBe(0);
  });

  it("契約名・残量をproviderが返せなくても未確認のまま本人サブスクを実行する", async () => {
    const bridge = setupBridge();
    const { readEntitlement: _omitted, ...withoutEntitlement } = deps(bridge);
    await expect(runNativePersonalExecution(withoutEntitlement, request())).resolves.toMatchObject({ state: "completed" });
    expect(bridge.turnRequests).toHaveLength(2);
    expect(rec(bridge).transcript).toBe(`[00:00:01] ${TRANSCRIPT_TEXT}\n`);
    expect(rec(bridge).artifacts).toMatchObject({ fix: `${OUTPUT.fix}\n`, insight: `${OUTPUT.insight}\n` });
  });

  it("id は Native の制約に収まる形で作り、収まらない id では開かない", async () => {
    expect(newPersonalId("run")).toMatch(/^run_[A-Za-z0-9_-]{22}$/);
    expect(newPersonalVersionId()).toMatch(/^v_[A-Za-z0-9_-]{22}$/);
    const bridge = setupBridge();
    const open = vi.spyOn(bridge, "personalOpen");
    await expect(runNativePersonalExecution(deps(bridge), request({ intentId: "intent.1" }))).rejects.toMatchObject({ code: "INVALID_ID" });
    await expect(runNativePersonalExecution(deps(bridge), request({ runId: "r".repeat(65) }))).rejects.toMatchObject({ code: "INVALID_ID" });
    expect(open).not.toHaveBeenCalled();
  });
});
