import { describe, expect, it } from "vitest";
import {
  ADVANCED_PROFILE_ID,
  CONTINUATION_INSTRUCTION,
  DEFAULT_CAPABILITIES,
  SOURCE_STEP_ID,
  STANDARD_PROFILE_ID,
  UNREGISTERED_IN_CONNECTION_MESSAGE,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  rootRecording,
  type Flow,
  type FlowSnapshot,
  type Project,
  type TurnEvent,
} from "@niho/docs-core";
import { recordingRef, type RecordingView } from "../src/lib/project-view";
import { DEEPGRAM_MODEL, GEMINI_TRANSCRIPTION_MODEL, runStep, runTranscription, type RunProgress } from "../src/lib/runner";
import { activeProfiles, activeProviders, defaultSettings, type AppSettings } from "../src/lib/settings";
import { FakeBridge, apiKeySettings, done, recordingView, rootRef, settingsWithProviders } from "./fake-bridge";
import { THREE_STEP_TEMPLATE } from "./three-step-flow";

/** 工程 2 つ: Claude × 標準、Gemini × 高性能（サブスクリプションの表では 3.8 Flash、API キー方式の表では 3.1 Pro）。 */
function twoStepFlow(): Flow {
  const flow = createFlowFromTemplate(THREE_STEP_TEMPLATE, "flow-1");
  flow.steps = [
    { ...flow.steps[0]!, provider: "claude", profile: STANDARD_PROFILE_ID },
    { ...flow.steps[1]!, provider: "gemini", profile: ADVANCED_PROFILE_ID },
  ];
  return flow;
}

function project(snapshot: FlowSnapshot, source: Project["source"] = { kind: "text" }): Project {
  return {
    version: 1,
    id: "",
    name: "朝市",
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot: snapshot,
    info: { speakers: "2", language: "ja", terms: [{ term: "NIHO鎌倉", reading: "にほかまくら", variants: ["ニホ鎌倉"], note: "" }], background: "" },
    source,
  };
}

async function textSetup(snapshot: FlowSnapshot) {
  const bridge = new FakeBridge();
  const created = await bridge.createProject(
    project(snapshot),
    "[00:00:01] 朝市に出して三年目です。\n",
    { id: "save-1", kind: "save", at: "2026-10-15T00:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" },
    [],
  );
  const view = await recordingView(bridge, created.id);
  return { bridge, view, stored: bridge.projects.get(created.id)! };
}

function stepInput(bridge: FakeBridge, view: RecordingView, stepIndex: number, settings: AppSettings) {
  let id = 0;
  const progress: RunProgress[] = [];
  return {
    progress,
    params: {
      bridge,
      rec: recordingRef(view),
      flow: view.flow,
      stepIndex,
      materials: view.materials,
      settings,
      capabilities: { ...DEFAULT_CAPABILITIES },
      newId: (prefix: string) => `${prefix}-${++id}`,
      now: () => new Date("2026-10-15T01:00:00.000Z"),
      onProgress: (item: RunProgress) => progress.push(item),
      isStopRequested: () => false,
    },
  };
}

function apiDone(text: string, stop: "EndTurn" | "MaxTokens" = "EndTurn", model = "claude-sonnet-4-6", session = "api_0123456789abcdef01234567"): TurnEvent {
  return {
    type: "Done",
    text,
    stop_reason: stop,
    session_id: session,
    usage: { input_tokens: 2000, output_tokens: 300, cost_usd: null, model_used: model, cost_known: false },
    duration_ms: 10,
    continuations: 0,
  };
}

describe("API キー方式の工程の実行", () => {
  it("今の方式の提供元（API）で実行し、記録に方式と実際に使ったモデルを残す。上限で止まったら同じ会話で続きを頼む", async () => {
    const flow = twoStepFlow();
    const settings = apiKeySettings(["claude", "gemini"]);
    const { bridge, view, stored } = await textSetup(createFlowSnapshot(flow, activeProfiles(settings), activeProviders(settings), "apiKey"));
    bridge.turnScript = (_request, call) => [call === 0 ? apiDone("## 発言\n\n前半", "MaxTokens") : apiDone("後半。")];
    const outcome = await runStep(stepInput(bridge, view, 0, settings).params);
    expect(outcome.status).toBe("saved");
    expect(bridge.turnRequests.map((request) => request.provider)).toEqual(["AnthropicApi", "AnthropicApi"]);
    expect(bridge.turnRequests[1]).toMatchObject({ user_prompt: CONTINUATION_INSTRUCTION, resume_session: "api_0123456789abcdef01234567" });
    expect(stored.artifacts[flow.steps[0]!.id]).toBe("## 発言\n\n前半後半。\n");
    expect(stored.runs.at(-1)).toMatchObject({
      kind: "run",
      result: "saved",
      provider: "claude",
      connection: "apiKey",
      model: "claude-sonnet-4-6",
      modelUsed: "claude-sonnet-4-6",
      inputTokens: 4000,
      outputTokens: 600,
      tokensKnown: true,
      costUsd: null,
      costKnown: false,
      continuations: 1,
    });
  });

  it("サブスクリプションで作った案件を API キー方式で実行すると、同じプロファイル × 提供元を API キー方式の表で解決し直す", async () => {
    const flow = twoStepFlow();
    const subscription = settingsWithProviders(["claude", "gemini"]);
    const { bridge, view, stored } = await textSetup(
      createFlowSnapshot(flow, activeProfiles(subscription), activeProviders(subscription), "subscription"),
    );
    expect(view.flow.models[flow.steps[1]!.id]).toMatchObject({ model: "gemini-3.8-flash", connection: "subscription" });
    bridge.turnScript = () => [apiDone("インサイト", "EndTurn", "gemini-3.1-pro-preview")];
    stored.artifacts[flow.steps[0]!.id] = "発言\n";
    const loaded = await recordingView(bridge, view.projectId);
    const outcome = await runStep(stepInput(bridge, loaded, 1, apiKeySettings(["claude", "gemini"])).params);
    expect(outcome.status).toBe("saved");
    expect(bridge.turnRequests[0]).toMatchObject({ provider: "GeminiApi", model: "gemini-3.1-pro-preview", effort: "High" });
    expect(stored.runs.at(-1)).toMatchObject({ connection: "apiKey", model: "gemini-3.1-pro-preview", modelUsed: "gemini-3.1-pro-preview", profile: "高性能" });
    // 案件の snapshot はそのまま（方式を戻せば元のモデルで動く）
    expect(stored.project.flowSnapshot?.models[flow.steps[1]!.id]).toMatchObject({ model: "gemini-3.8-flash", connection: "subscription" });
  });

  it("工程の AI が今の方式に登録されていなければ、別の AI・別の方式に寄せずに止める", async () => {
    const flow = twoStepFlow();
    const subscription = settingsWithProviders(["claude", "gemini"]);
    const { bridge, view, stored } = await textSetup(createFlowSnapshot(flow, activeProfiles(subscription), activeProviders(subscription)));
    stored.artifacts[flow.steps[0]!.id] = "発言\n";
    const loaded = await recordingView(bridge, view.projectId);
    // API キー方式には Claude だけ
    const outcome = await runStep(stepInput(bridge, loaded, 1, apiKeySettings(["claude"])).params);
    expect(outcome).toMatchObject({ status: "failed", message: UNREGISTERED_IN_CONNECTION_MESSAGE, reasonCode: "ProviderNotRegistered" });
    expect(bridge.turnRequests).toHaveLength(0);
  });

  it("上限・鍵の無効・接続できないときは、その理由で止める（サブスクリプションや別の AI で実行し直さない）", async () => {
    const flow = twoStepFlow();
    const settings = apiKeySettings(["claude", "gemini"]);
    for (const [reason, message] of [
      ["UsageLimitReached", "Anthropic の API の利用上限か残高に達しました。Anthropic の管理画面で上限と残高を確かめてから、もう一度実行してください。"],
      ["CliLoginRequired", "API キーが無効です。設定 › 接続設定で確かめてください。"],
      ["Unreachable", "Anthropic の API に接続できませんでした。ネットワークを確かめてから、もう一度実行してください。"],
      ["NotConfigured", "Anthropic の API キーが保存されていません。設定 › 接続設定で API キーを保存してください。"],
    ] as const) {
      const { bridge, view, stored } = await textSetup(createFlowSnapshot(flow, activeProfiles(settings), activeProviders(settings), "apiKey"));
      bridge.turnScript = () => [{ type: "Error", reason_code: reason, message }];
      const outcome = await runStep(stepInput(bridge, view, 0, settings).params);
      expect(outcome).toMatchObject({ status: "failed", message, reasonCode: reason });
      expect(bridge.turnRequests.map((request) => request.provider)).toEqual(["AnthropicApi"]);
      expect(stored.runs.at(-1)).toMatchObject({ result: "failed", connection: "apiKey", reasonCode: reason });
      // 設定（方式）は変えない
      expect(settings.connection).toBe("apiKey");
    }
    // 空の message でも API キー方式の文で出す
    const { bridge, view } = await textSetup(createFlowSnapshot(flow, activeProfiles(settings), activeProviders(settings), "apiKey"));
    bridge.turnScript = () => [{ type: "Error", reason_code: "CliLoginRequired", message: "" }];
    expect(await runStep(stepInput(bridge, view, 0, settings).params)).toMatchObject({
      message: "API キーが無効です。設定 › 接続設定で確かめてください。",
    });
  });
});

async function audioSetup(seconds = 95) {
  const flow = twoStepFlow();
  flow.terms = [{ term: "由比ガ浜", reading: "ゆいがはま", variants: [], note: "" }];
  const bridge = new FakeBridge();
  bridge.audioDurationSec = seconds;
  const snapshot = createFlowSnapshot(flow, defaultProfiles("apiKey"), ["gemini"], "apiKey");
  const created = await bridge.createProject(project(snapshot, { kind: "audio", audio: [] }), null, null, ["/a/m.m4a", "/a/n.m4a"]);
  return { bridge, created, snapshot, stored: bridge.projects.get(created.id)! };
}

function transcription(bridge: FakeBridge, created: Project, snapshot: FlowSnapshot, engine: "gemini" | "deepgram", progress: RunProgress[] = []) {
  let id = 0;
  return runTranscription({
    bridge,
    rec: rootRef(created.id),
    project: created,
    recording: rootRecording(created)!,
    flow: snapshot,
    jobId: "speech-1",
    engine,
    connection: "apiKey",
    newId: (prefix) => `${prefix}-${++id}`,
    now: () => new Date("2026-10-15T00:00:00.000Z"),
    onProgress: (item) => progress.push(item),
  });
}

describe("API キー方式の文字起こし", () => {
  it("Gemini API: 区切りごとに音声を添えて（view_file ではなく添付）頼み、時刻をずらして結合し、区切りごとに checkpoint を書く", async () => {
    const { bridge, created, snapshot, stored } = await audioSetup();
    bridge.preparedAudio = [{ durationSec: 95, parts: [{ startSec: 0, endSec: 48, soundSec: 42 }, { startSec: 48, endSec: 95, soundSec: 40 }] }];
    bridge.audioPartScript = (_request, call) => [
      { ...apiDone(call === 0 ? "[00:02] 話者0: 始めます。" : "[00:01] 話者1: はい。", "EndTurn", "gemini-3.8-flash"), session_id: null },
    ];
    const outcome = await transcription(bridge, created, snapshot, "gemini");
    expect(outcome.status).toBe("saved");
    expect(bridge.audioPartRequests.map((call) => call.request.provider)).toEqual(["GeminiApi", "GeminiApi"]);
    for (const call of bridge.audioPartRequests) {
      expect(call.request).toMatchObject({ model: GEMINI_TRANSCRIPTION_MODEL, effort: "Low" });
      expect(call.request.user_prompt).toContain("添付の音声を書き起こしてください。");
      expect(call.request.user_prompt).not.toContain("view_file");
      expect(call.request.system_prompt).toContain("由比ガ浜");
    }
    expect(bridge.audioPartRequests[1]?.request.user_prompt).toContain("話者0: 始めます。");
    expect(stored.transcript).toBe("[00:00:02] 話者0: 始めます。\n\n[00:00:49] 話者1: はい。\n");
    expect(stored.runs.at(-1)).toMatchObject({ provider: "gemini", connection: "apiKey", model: "gemini-3.8-flash", inputTokens: 4000, audioSec: 95 });
    expect(Object.values(stored.checkpoints)[0]).toMatchObject({ provider: "gemini", state: "completed" });
    expect(bridge.releasedAudio).toEqual(["speech-1"]);
  });

  it("Deepgram: 1 回の同期の呼び出し（keyterm は表記だけ）の utterances を `[hh:mm:ss] 話者N: 本文` にし、音声の長さを残す", async () => {
    const { bridge, created, snapshot, stored } = await audioSetup(60);
    bridge.keychain.set("deepgram", "dg-fake-0123456789abcdef");
    bridge.deepgramResult = [
      { durationSec: 60, transcript: "", utterances: [{ start: 1, end: 4, speaker: 0, transcript: "朝市 に 出して 三年目 です" }, { start: 30, end: 33, speaker: 1, transcript: "そう なんですね" }] },
      { durationSec: 40, transcript: "", utterances: [{ start: 2, end: 5, speaker: 0, transcript: "後半 です" }] },
    ];
    const progress: RunProgress[] = [];
    const outcome = await transcription(bridge, created, snapshot, "deepgram", progress);
    expect(outcome.status).toBe("saved");
    expect(bridge.deepgramRequests).toEqual([
      { jobId: "speech-1", projectId: created.id, request: { language: "ja", diarize: true, keyterms: ["NIHO鎌倉", "由比ガ浜"] } },
    ]);
    expect(stored.transcript).toBe("[00:00:01] 話者0: 朝市に出して三年目です\n\n[00:00:30] 話者1: そうなんですね\n\n[00:01:02] 話者0: 後半です\n");
    expect(stored.runs.at(-1)).toMatchObject({
      provider: "deepgram",
      connection: "apiKey",
      model: DEEPGRAM_MODEL,
      audioSec: 100,
      keyterms: 2,
      result: "saved",
    });
    expect(progress.some((item) => item.kind === "speech" && item.event.type === "Stage")).toBe(true);
    expect(Object.values(stored.checkpoints)[0]).toMatchObject({ provider: "deepgram", model: "nova-3", state: "completed" });
  });

  it("Deepgram の失敗・停止はそこで止め、ほかのエンジンに切り替えない", async () => {
    const { bridge, created, snapshot, stored } = await audioSetup();
    const outcome = await transcription(bridge, created, snapshot, "deepgram");
    expect(outcome).toMatchObject({
      status: "failed",
      message: "Deepgram の API キーが保存されていません。設定 › 接続設定で API キーを保存してください。",
    });
    expect(bridge.audioPartRequests).toHaveLength(0);
    expect(stored.transcript).toBeNull();
    bridge.deepgramResult = { code: "speech_stopped", message: "止めました。" };
    expect((await transcription(bridge, created, snapshot, "deepgram")).status).toBe("stopped");
    expect(stored.runs.map((run) => run.provider)).toEqual(["deepgram", "deepgram"]);
  });
});

describe("方式の既定", () => {
  it("API キー方式の設定は登録した AI が空から始まる（工程は鍵を登録するまで実行しない）", () => {
    const settings = { ...defaultSettings(), connection: "apiKey" as const };
    expect(activeProviders(settings)).toEqual([]);
  });
});
