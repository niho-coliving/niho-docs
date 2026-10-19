import { describe, expect, it } from "vitest";
import {
  CONTINUATION_INSTRUCTION,
  DEFAULT_CAPABILITIES,
  SOURCE_STEP_ID,
  createFlowSnapshot,
  type Flow,
  type Project,
  type ResolvedStepModel,
  type RunRecord,
} from "@niho/docs-core";
import { recordingRef } from "../src/lib/project-view";
import { GEMINI_TRANSCRIPTION_EFFORT, GEMINI_TRANSCRIPTION_MODEL } from "../src/lib/runner";
import { PersonalAuthenticationRequiredError } from "../src/lib/personal-execution";
import { personalCandidateFromCapture, runPersonalGenerationStep, runPersonalTranscription } from "../src/lib/personal-runner-adapter";
import { activeProfiles, defaultSettings } from "../src/lib/settings";
import { FakeBridge, done, fakeStatus, recordingView, settingsWithProviders } from "./fake-bridge";

const entitlement = { planConfirmed: true, usage: "available" as const };
const location = { versionId: "candidate-v1", path: "recordings/recording-1/versions/minutes/candidate-v1.md" };

async function setup(audio = false) {
  const settings = settingsWithProviders(["gpt"], defaultSettings());
  const flow: Flow = {
    version: 1, id: "flow-1", name: "議事録", revision: 1, guide: "", terms: [], samples: [],
    steps: [{ id: "minutes", name: "議事録", instruction: "整理する", provider: "gpt", profile: "standard" }],
  };
  const snapshot = createFlowSnapshot(flow, activeProfiles(settings), ["gpt"], "subscription");
  const project: Project = {
    version: 1, id: "", name: "定例会", createdAt: "2026-10-16T00:00:00.000Z", flowSnapshot: snapshot,
    info: { speakers: "2", language: "ja", terms: [], background: "" }, source: audio ? { kind: "audio", audio: [] } : { kind: "text" },
  };
  const bridge = new FakeBridge();
  const created = await bridge.createProject(project, audio ? null : "確定原文", audio ? null : { id: "save-1", kind: "save", at: project.createdAt, stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" }, audio ? ["/tmp/a.wav"] : []);
  const view = await recordingView(bridge, created.id);
  return { bridge, settings, view, fixed: snapshot.models.minutes!, stored: bridge.projects.get(created.id)! };
}

function generationInput(fixture: Awaited<ReturnType<typeof setup>>) {
  let id = 0;
  return {
    bridge: fixture.bridge,
    rec: recordingRef(fixture.view),
    flow: fixture.view.flow,
    stepIndex: 0,
    materials: fixture.view.materials,
    settings: fixture.settings,
    capabilities: DEFAULT_CAPABILITIES,
    newId: (prefix: string) => `${prefix}-${++id}`,
    now: () => new Date("2026-10-16T01:00:00.000Z"),
    onProgress: () => undefined,
    isStopRequested: () => false,
  };
}

describe("R6 existing runner adapters", () => {
  it("P3の子録音ページをそのRecordingRefで実行し、root録音や現行版へ書き込まない", async () => {
    const s = await setup();
    // 以前のデータ（root の録音と子の録音が同じフォルダ）の書き分け。今の作成口は 2 つ目を断る（#18914）
    s.bridge.oneRecordingPerFolder = false;
    const page = await s.bridge.createPage(s.view.projectId, {
      kind: "rec", title: "別の録音", createdAt: "2026-10-16T01:00:00.000Z",
      recording: { ...s.view.recording, id: "", source: { kind: "audio", audio: [] } },
    });
    await s.bridge.setRecordingText({ projectId: s.view.projectId, recordingId: page.id }, "子ページの確定原文", {
      id: "child-source", kind: "save", at: "2026-10-16T01:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved",
    });
    const child = { ...s, view: await recordingView(s.bridge, s.view.projectId, page.id) };
    const beforeRoot = structuredClone(s.stored.runs);
    const beforeChild = structuredClone(s.stored.recordings[page.id]);
    s.bridge.turnScript = () => [done("子ページの整理結果", "EndTurn", "s1", child.fixed.model)];
    const captured = await runPersonalGenerationStep(generationInput(child), child.fixed, async () => entitlement, {
      versionId: "child-v1", path: `recordings/${page.id}/versions/minutes/child-v1.md`,
    });
    expect(captured.outcome.status).toBe("saved");
    expect(s.bridge.turnRequests[0]?.user_prompt).toContain("子ページの確定原文");
    expect(captured.candidate?.path).toContain(`recordings/${page.id}/`);
    expect(s.stored.runs).toEqual(beforeRoot);
    expect(s.stored.recordings[page.id]).toEqual(beforeChild);
  });

  it("接続状態の確認中に取り消した場合は生成を送信しない", async () => {
    const s = await setup();
    let stopped = false;
    s.bridge.providerStatus = async () => { stopped = true; return fakeStatus("CodexCli"); };
    const captured = await runPersonalGenerationStep({ ...generationInput(s), isStopRequested: () => stopped }, s.fixed, async () => entitlement, location);
    expect(captured.outcome.status).toBe("stopped");
    expect(captured.checkpoints.at(-1)?.state).toBe("stopped");
    expect(s.bridge.turnRequests).toHaveLength(0);
  });

  it("Gemini接続確認中の取消は音声の外部送信を止める", async () => {
    const s = await setup(true);
    let stopped = false;
    s.bridge.providerStatus = async () => { stopped = true; return fakeStatus("GeminiCli"); };
    const captured = await runPersonalTranscription({
      bridge: s.bridge, rec: recordingRef(s.view), project: s.view.project, recording: s.view.recording, flow: s.view.flow, jobId: "speech-1", engine: "gemini",
      connection: "subscription", newId: (prefix) => `${prefix}-1`, now: () => new Date("2026-10-16T01:00:00.000Z"),
      onProgress: () => undefined, isStopRequested: () => stopped,
    }, { provider: "gemini", model: GEMINI_TRANSCRIPTION_MODEL, effort: GEMINI_TRANSCRIPTION_EFFORT, profileId: "light", profileName: "軽量", connection: "subscription" }, async () => entitlement, location);
    expect(captured.outcome.status).toBe("stopped");
    expect(s.bridge.audioPartRequests).toHaveLength(0);
  });

  it("固定modelを再解決せず各送信直前にstatusを検査し、production Bridgeを書き換えず候補を返す", async () => {
    const s = await setup();
    s.bridge.turnScript = (_request, call) => [call === 0 ? done("前半", "MaxTokens", "s1", s.fixed.model) : done("後半", "EndTurn", "s1", s.fixed.model)];
    const captured = await runPersonalGenerationStep(generationInput(s), s.fixed, async () => entitlement, location);
    expect(captured.outcome.status).toBe("saved");
    expect(captured.candidate).toMatchObject({ stepId: "minutes", text: "前半後半\n", ...location });
    expect(s.stored.artifacts.minutes).toBeUndefined();
    expect(s.stored.runs).toHaveLength(1); // setup時のsourceだけ
    expect(s.stored.checkpoints).toEqual({});
    expect(captured.checkpoints.at(-1)?.state).toBe("completed");
    expect(s.bridge.statusCalls).toEqual(["CodexCli", "CodexCli"]);
    expect(s.bridge.turnRequests[1]).toMatchObject({ user_prompt: CONTINUATION_INSTRUCTION, resume_session: "s1" });
  });

  it("readiness拒否をfailed checkpoint/runへ閉じ、hook throwを外へ漏らさない", async () => {
    const s = await setup();
    s.bridge.statuses.CodexCli = fakeStatus("CodexCli", { authenticated: false, reason: "auth_required" });
    const captured = await runPersonalGenerationStep(generationInput(s), s.fixed, async () => entitlement, location);
    expect(captured.outcome).toMatchObject({ status: "failed", reasonCode: "not_authenticated" });
    expect(captured.checkpoints.at(-1)).toMatchObject({ state: "failed", endReason: "not_authenticated" });
    expect(captured.records.at(-1)).toMatchObject({ result: "failed", reasonCode: "not_authenticated" });
    expect(s.bridge.turnRequests).toHaveLength(0);
    expect(() => personalCandidateFromCapture(captured)).toThrow(PersonalAuthenticationRequiredError);
  });

  it("各continuation送信前に残量を取り直し、途中で枯渇したら次を送らない", async () => {
    const s = await setup();
    s.bridge.turnScript = () => [done("前半", "MaxTokens", "s1", s.fixed.model)];
    let reads = 0;
    const captured = await runPersonalGenerationStep(generationInput(s), s.fixed, async () => {
      reads++;
      return { planConfirmed: true, usage: reads === 1 ? "available" : "depleted" };
    }, location);
    expect(captured.outcome).toMatchObject({ status: "failed", reasonCode: "usage_depleted" });
    expect(reads).toBe(2);
    expect(s.bridge.turnRequests).toHaveLength(1);
  });

  it("dispatch後の通信失敗をResultUnknownへ写し、通常Bridgeへの再送をしない", async () => {
    const s = await setup();
    let calls = 0;
    s.bridge.runTurn = async () => { calls++; throw new Error("timeout"); };
    const captured = await runPersonalGenerationStep(generationInput(s), s.fixed, async () => entitlement, location);
    expect(captured.outcome).toMatchObject({ status: "failed", reasonCode: "ResultUnknown" });
    expect(captured.checkpoints.at(-1)).toMatchObject({ state: "failed", endReason: "ResultUnknown" });
    expect(calls).toBe(1);
    expect(() => personalCandidateFromCapture(captured)).toThrow(expect.objectContaining({ resultUnknown: true }));
  });

  it("最初のcheckpointを耐久保存できなければAIへ送信しない", async () => {
    const s = await setup();
    s.bridge.turnScript = () => [done("送られない", "EndTurn", "s1", s.fixed.model)];
    const captured = await runPersonalGenerationStep(
      generationInput(s),
      s.fixed,
      async () => entitlement,
      location,
      { saveCheckpoint: async () => { throw new Error("disk unavailable"); } },
    );
    expect(captured.outcome).toMatchObject({ status: "failed", reasonCode: "RetentionFailed" });
    expect(captured.checkpoints).toHaveLength(0);
    expect(s.bridge.turnRequests).toHaveLength(0);
  });

  it("stream中のcheckpoint耐久保存失敗後はpaid continuationを送らず、部分候補を残す", async () => {
    const s = await setup();
    let release!: () => void;
    let started!: () => void;
    const waitStarted = new Promise<void>((resolve) => { started = resolve; });
    s.bridge.turnGate = new Promise<void>((resolve) => { release = resolve; });
    s.bridge.onTurnStarted = () => started();
    s.bridge.turnScript = () => [
      { type: "TextDelta", text: "耐久保存する途中本文" },
      done("耐久保存する途中本文", "MaxTokens", "s1", s.fixed.model),
    ];
    let checkpointCalls = 0;
    const partials: string[] = [];
    const execution = runPersonalGenerationStep(
      generationInput(s),
      s.fixed,
      async () => entitlement,
      location,
      {
        saveCheckpoint: async () => {
          checkpointCalls++;
          if (checkpointCalls === 2) throw new Error("durable write failed");
        },
        savePartialCandidate: async ({ candidate }) => { partials.push(candidate.text); },
      },
    );
    await waitStarted;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    release();
    const captured = await execution;
    expect(captured.outcome).toMatchObject({ status: "failed", reasonCode: "RetentionFailed" });
    expect(s.bridge.turnRequests).toHaveLength(1);
    expect(partials.at(-1)).toContain("耐久保存する途中本文");
    expect(captured.partialCandidate?.text).toContain("耐久保存する途中本文");
    expect(captured.candidate).toBeNull();
    expect(captured.records.at(-1)).toMatchObject({ result: "failed", reasonCode: "RetentionFailed" });
  });

  it("provider status待機後にowner/root guardが拒否したら送信しない", async () => {
    const s = await setup();
    let changed = false;
    s.bridge.providerStatus = async () => { changed = true; return fakeStatus("CodexCli"); };
    const captured = await runPersonalGenerationStep(
      {
        ...generationInput(s),
        beforeDispatch: async () => {
          if (changed) throw { code: "ACCOUNT_CHANGED", message: "実行中にアカウントが切り替わりました。" };
        },
      },
      s.fixed,
      async () => entitlement,
      location,
    );
    expect(captured.outcome).toMatchObject({ status: "failed", reasonCode: "ACCOUNT_CHANGED" });
    expect(s.bridge.turnRequests).toHaveLength(0);
  });

  it("実モデル不一致は本文と履歴を部分候補として耐久保存し、現行候補を返さない", async () => {
    const s = await setup();
    s.bridge.turnScript = () => [done("別モデルが返した本文", "EndTurn", "s1", "gpt-5.6-luna")];
    const partials: Array<{ text: string; model: string | null; reportedModel: string | null | undefined }> = [];
    const records: RunRecord[] = [];
    const captured = await runPersonalGenerationStep(
      generationInput(s),
      s.fixed,
      async () => entitlement,
      location,
      {
        appendRun: async ({ record }) => { records.push(record); },
        savePartialCandidate: async ({ candidate }) => {
          partials.push({ text: candidate.text, model: candidate.model, reportedModel: candidate.reportedModel });
        },
      },
    );
    expect(captured.outcome).toMatchObject({ status: "failed", reasonCode: "ActualModelMismatch" });
    expect(captured.candidate).toBeNull();
    expect(captured.partialCandidate).toMatchObject({
      text: "別モデルが返した本文",
      model: s.fixed.model,
      reportedModel: "gpt-5.6-luna",
    });
    expect(partials).toEqual([{
      text: "別モデルが返した本文",
      model: s.fixed.model,
      reportedModel: "gpt-5.6-luna",
    }]);
    expect(records.at(-1)).toMatchObject({ result: "failed", reasonCode: "ActualModelMismatch", modelUsed: "gpt-5.6-luna" });
    expect(() => personalCandidateFromCapture(captured)).toThrow(expect.objectContaining({ resultUnknown: false }));
    expect(s.stored.artifacts.minutes).toBeUndefined();
  });

  it("model_used未報告でも固定した選択modelを候補同一性に保ち、actual provenanceはnullにする", async () => {
    const s = await setup();
    s.bridge.turnScript = () => [done("実モデル未報告の本文", "EndTurn", "s1", null)];
    const captured = await runPersonalGenerationStep(generationInput(s), s.fixed, async () => entitlement, location);
    expect(captured.outcome.status).toBe("saved");
    expect(personalCandidateFromCapture(captured)).toMatchObject({
      model: s.fixed.model,
      reportedModel: null,
      text: "実モデル未報告の本文\n",
    });
    expect(captured.records.at(-1)).toMatchObject({ model: s.fixed.model, modelUsed: null, result: "saved" });
  });

  it("Geminiのbase+effort別名は固定model候補として成功し、provider報告値をそのまま残す", async () => {
    const s = await setup(true);
    const gemini: ResolvedStepModel = {
      provider: "gemini", model: GEMINI_TRANSCRIPTION_MODEL, effort: GEMINI_TRANSCRIPTION_EFFORT,
      profileId: "light", profileName: "軽量", connection: "subscription",
    };
    s.bridge.preparedAudio = [{ durationSec: 5, parts: [{ startSec: 0, endSec: 5, soundSec: 4 }] }];
    s.bridge.audioPartScript = () => [{
      type: "Done",
      text: "[00:01] 話者A: 別名でも同じ固定モデルです。",
      stop_reason: "EndTurn",
      session_id: "g1",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cost_usd: null,
        model_used: `${GEMINI_TRANSCRIPTION_MODEL}-${GEMINI_TRANSCRIPTION_EFFORT}`,
        cost_known: false,
      },
      duration_ms: 10,
      continuations: 0,
    }];
    const captured = await runPersonalTranscription(
      {
        bridge: s.bridge, rec: recordingRef(s.view), project: s.view.project, recording: s.view.recording, flow: s.view.flow,
        jobId: "speech-alias", engine: "gemini", connection: "subscription", newId: (prefix) => `${prefix}-1`,
        now: () => new Date("2026-10-16T01:00:00.000Z"), onProgress: () => undefined,
      },
      gemini,
      async () => entitlement,
      { versionId: "source-alias", path: "recordings/recording-1/versions/source/source-alias.md" },
    );
    expect(captured.outcome.status).toBe("saved");
    expect(personalCandidateFromCapture(captured)).toMatchObject({
      model: GEMINI_TRANSCRIPTION_MODEL,
      reportedModel: `${GEMINI_TRANSCRIPTION_MODEL}-${GEMINI_TRANSCRIPTION_EFFORT}`,
    });
  });

  it("Gemini終端TransientFailureは再送せず、同区切りのstream部分をResultUnknown候補へ残す", async () => {
    const s = await setup(true);
    const gemini: ResolvedStepModel = {
      provider: "gemini", model: GEMINI_TRANSCRIPTION_MODEL, effort: GEMINI_TRANSCRIPTION_EFFORT,
      profileId: "light", profileName: "軽量", connection: "subscription",
    };
    s.bridge.audioPartScript = () => [
      { type: "TextDelta", text: "[00:02] 話者A: 送信後の途中本文です。" },
      { type: "Error", reason_code: "TransientFailure", message: "stream ended" },
    ];
    const partials: string[] = [];
    const captured = await runPersonalTranscription(
      {
        bridge: s.bridge, rec: recordingRef(s.view), project: s.view.project, recording: s.view.recording, flow: s.view.flow,
        jobId: "speech-unknown", engine: "gemini", connection: "subscription", newId: (prefix) => `${prefix}-1`,
        now: () => new Date("2026-10-16T01:00:00.000Z"), onProgress: () => undefined,
      },
      gemini,
      async () => entitlement,
      { versionId: "source-v1", path: "recordings/recording-1/versions/source/source-v1.md" },
      { savePartialCandidate: async ({ candidate }) => { partials.push(candidate.text); } },
    );
    expect(captured.outcome).toMatchObject({ status: "failed", reasonCode: "ResultUnknown" });
    expect(s.bridge.audioPartRequests).toHaveLength(1);
    expect(captured.partialCandidate?.text).toContain("送信後の途中本文です");
    expect(partials.at(-1)).toContain("送信後の途中本文です");
    expect(captured.records.at(-1)).toMatchObject({ result: "failed", reasonCode: "ResultUnknown" });
  });

  it("Geminiの既知の送信前command拒否はResultUnknownへ潰さず、その理由を保つ", async () => {
    const s = await setup(true);
    const gemini: ResolvedStepModel = {
      provider: "gemini", model: GEMINI_TRANSCRIPTION_MODEL, effort: GEMINI_TRANSCRIPTION_EFFORT,
      profileId: "light", profileName: "軽量", connection: "subscription",
    };
    let calls = 0;
    s.bridge.transcribeAudioPart = async () => {
      calls++;
      throw { code: "audio_part_missing", message: "準備した音声が見つかりません。" };
    };
    const captured = await runPersonalTranscription(
      {
        bridge: s.bridge, rec: recordingRef(s.view), project: s.view.project, recording: s.view.recording, flow: s.view.flow,
        jobId: "speech-predelivery", engine: "gemini", connection: "subscription", newId: (prefix) => `${prefix}-1`,
        now: () => new Date("2026-10-16T01:00:00.000Z"), onProgress: () => undefined,
      },
      gemini,
      async () => entitlement,
      { versionId: "source-v1", path: "recordings/recording-1/versions/source/source-v1.md" },
    );
    expect(captured.outcome).toMatchObject({ status: "failed", reasonCode: "audio_part_missing" });
    expect(calls).toBe(1);
  });

  it("flow snapshotと異なる固定modelはstatus/dispatch前に止める", async () => {
    const s = await setup();
    const captured = await runPersonalGenerationStep(generationInput(s), { ...s.fixed, model: "gpt-5.6-luna" }, async () => entitlement, location);
    expect(captured.outcome).toMatchObject({ status: "failed", reasonCode: "FixedSnapshotChanged" });
    expect(s.bridge.statusCalls).toHaveLength(0);
    expect(s.bridge.turnRequests).toHaveLength(0);
  });

  it("Gemini文字起こしは固定model/effortを守り、端末で明示したsubscription/APIキーのproviderを使う", async () => {
    const s = await setup(true);
    const gemini: ResolvedStepModel = {
      provider: "gemini", model: GEMINI_TRANSCRIPTION_MODEL, effort: GEMINI_TRANSCRIPTION_EFFORT,
      profileId: "light", profileName: "軽量", connection: "subscription",
    };
    const base = {
      bridge: s.bridge, rec: recordingRef(s.view), project: s.view.project, recording: s.view.recording, flow: s.view.flow, jobId: "speech-1", engine: "gemini" as const,
      connection: "subscription" as const, newId: (prefix: string) => `${prefix}-1`, now: () => new Date("2026-10-16T01:00:00.000Z"), onProgress: () => undefined,
    };
    for (const bad of [{ ...gemini, provider: "gpt" as const }, { ...gemini, model: "gemini-other" }, { ...gemini, effort: "high" as const }]) {
      const captured = await runPersonalTranscription(base, bad, async () => entitlement, { versionId: "source-v1", path: "recordings/recording-1/versions/source/source-v1.md" });
      expect(captured.outcome).toMatchObject({ status: "failed", reasonCode: "FixedTranscriptionModelMismatch" });
    }
    s.bridge.statuses.GeminiApi = { ...s.bridge.statuses.GeminiApi, models: [GEMINI_TRANSCRIPTION_MODEL] };
    s.bridge.audioPartScript = () => [done("[00:01] APIキーで文字起こし", "EndTurn", null, `${GEMINI_TRANSCRIPTION_MODEL}-low`)];
    const api = await runPersonalTranscription({ ...base, connection: "apiKey" }, gemini, async () => entitlement, { versionId: "source-v1", path: "recordings/recording-1/versions/source/source-v1.md" });
    expect(api.outcome.status, JSON.stringify(api.outcome)).toBe("saved");
    expect(s.bridge.statusCalls).toContain("GeminiApi");
    expect(s.bridge.audioPartRequests.length).toBeGreaterThan(0);
  });

  it("this-macはtranscribe直前のspeechStatusが未準備/fakeなら音声認識を呼ばない", async () => {
    const s = await setup(true);
    let transcribeCalls = 0;
    s.bridge.transcribe = async () => { transcribeCalls++; return []; };
    s.bridge.speechStatus = async () => ({ found: true, fake: true, available: true, needsDownload: false, engine: "fake", error: null, notice: null, diarization: { state: "ready", detail: null } });
    const captured = await runPersonalTranscription(
      { bridge: s.bridge, rec: recordingRef(s.view), project: s.view.project, recording: s.view.recording, flow: s.view.flow, jobId: "speech-1", engine: "this-mac", newId: (prefix) => `${prefix}-1`, now: () => new Date("2026-10-16T01:00:00.000Z"), onProgress: () => undefined },
      null,
      async () => entitlement,
      { versionId: "source-v1", path: "recordings/recording-1/versions/source/source-v1.md" },
    );
    expect(captured.outcome).toMatchObject({ status: "failed", reasonCode: "speech_unavailable" });
    expect(transcribeCalls).toBe(0);
    expect(captured.checkpoints.at(-1)?.state).toBe("failed");
  });

  it("Geminiとthis-macはstatus確認後のcaptured owner/root guardを実送信直前に通す", async () => {
    const geminiFixture = await setup(true);
    let geminiChanged = false;
    geminiFixture.bridge.providerStatus = async () => { geminiChanged = true; return fakeStatus("GeminiCli"); };
    const gemini: ResolvedStepModel = {
      provider: "gemini", model: GEMINI_TRANSCRIPTION_MODEL, effort: GEMINI_TRANSCRIPTION_EFFORT,
      profileId: "light", profileName: "軽量", connection: "subscription",
    };
    const geminiCapture = await runPersonalTranscription(
      {
        bridge: geminiFixture.bridge, rec: recordingRef(geminiFixture.view), project: geminiFixture.view.project,
        recording: geminiFixture.view.recording, flow: geminiFixture.view.flow, jobId: "speech-gemini-guard", engine: "gemini",
        connection: "subscription", newId: (prefix) => `${prefix}-1`, now: () => new Date("2026-10-16T01:00:00.000Z"),
        onProgress: () => undefined,
        beforeAiDispatch: async () => { if (geminiChanged) throw { code: "ROOT_CHANGED", message: "保存先が変わりました。" }; },
      },
      gemini,
      async () => entitlement,
      { versionId: "source-gemini", path: "recordings/recording-1/versions/source/source-gemini.md" },
    );
    expect(geminiCapture.outcome).toMatchObject({ status: "failed", reasonCode: "ROOT_CHANGED" });
    expect(geminiFixture.bridge.audioPartRequests).toHaveLength(0);

    const macFixture = await setup(true);
    let macChanged = false;
    let transcribeCalls = 0;
    macFixture.bridge.speechStatus = async () => {
      macChanged = true;
      return { found: true, fake: false, available: true, needsDownload: false, engine: "speech", error: null, notice: null, diarization: { state: "ready", detail: null } };
    };
    macFixture.bridge.transcribe = async () => { transcribeCalls++; return []; };
    const macCapture = await runPersonalTranscription(
      {
        bridge: macFixture.bridge, rec: recordingRef(macFixture.view), project: macFixture.view.project,
        recording: macFixture.view.recording, flow: macFixture.view.flow, jobId: "speech-mac-guard", engine: "this-mac",
        newId: (prefix) => `${prefix}-1`, now: () => new Date("2026-10-16T01:00:00.000Z"), onProgress: () => undefined,
        beforeAiDispatch: async () => { if (macChanged) throw { code: "ACCOUNT_CHANGED", message: "アカウントが変わりました。" }; },
      },
      null,
      async () => entitlement,
      { versionId: "source-mac", path: "recordings/recording-1/versions/source/source-mac.md" },
    );
    expect(macCapture.outcome).toMatchObject({ status: "failed", reasonCode: "ACCOUNT_CHANGED" });
    expect(transcribeCalls).toBe(0);
  });
});

describe("送っていないと確定している拒否の分類", () => {
  it("送信直前の guard・marker 無しの拒否は送信しなかった失敗、それ以外の runTurn の失敗は今までどおり結果不明", async () => {
    for (const [thrown, reasonCode, resultUnknown] of [
      [{ code: "personal_guard_failed", message: "実行を始めたときの状態から変わったため、送信しませんでした。" }, "DispatchRejected", false],
      [{ code: "personal_dispatch_unmarked", message: "送信の記録を残せなかったため、送信しませんでした。" }, "DispatchRejected", false],
      [{ code: "turn_too_large", message: "送る量が多すぎます。" }, "ResultUnknown", true],
      [new Error("応答が途切れました"), "ResultUnknown", true],
    ] as const) {
      const s = await setup();
      s.bridge.runTurn = async () => {
        throw thrown;
      };
      const captured = await runPersonalGenerationStep(generationInput(s), s.fixed, async () => entitlement, location);
      expect(captured.outcome).toMatchObject({ status: "failed", reasonCode });
      expect(() => personalCandidateFromCapture(captured)).toThrow(expect.objectContaining({ resultUnknown }));
    }
  });
});
