import { describe, expect, it } from "vitest";
import {
  CONTINUATION_INSTRUCTION,
  CONTINUATION_LIMIT_MESSAGE,
  CONTINUATION_NOT_JOINABLE_MESSAGE,
  DEFAULT_CAPABILITIES,
  FLOW_TEMPLATES,
  MAX_CONTINUATIONS,
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  reasonMessage,
  rootRecording,
  type FlowSnapshot,
  type Profile,
  type Project,
  type TurnEvent,
} from "@niho/docs-core";
import { recordingRef } from "../src/lib/project-view";
import { runStep, runTranscription, type RunProgress } from "../src/lib/runner";
import { activeProfiles, defaultSettings, setActiveProfiles } from "../src/lib/settings";
import { FakeBridge, done, recordingView, rootRef } from "./fake-bridge";

const flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
const snapshot = createFlowSnapshot(flow, defaultProfiles(), ["claude"]);
/** 記事制作の工程 2〜4 の id。 */
const [FIX, POLICY, BODY] = flow.steps.map((step) => step.id) as [string, string, string];
const STOPPED = "止めました。途中までを残しています。";

function textProject(flowSnapshot: FlowSnapshot = snapshot): Project {
  return {
    version: 1,
    id: "",
    name: "座談会",
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot,
    info: { speakers: "3", language: "ja", terms: [{ term: "材木座", reading: "ざいもくざ", variants: [], note: "" }], background: "背景" },
    source: { kind: "text" },
  };
}

async function setup(text = "[00:00:01] こんにちは\n", flowSnapshot: FlowSnapshot = snapshot) {
  const bridge = new FakeBridge();
  bridge.flow = flow;
  const created = await bridge.createProject(textProject(flowSnapshot), text, {
    id: "save-1",
    kind: "save",
    at: "2026-10-15T00:00:00.000Z",
    stepId: SOURCE_STEP_ID,
    stepName: "文章",
    version: null,
    result: "saved",
  }, []);
  const view = await recordingView(bridge, created.id);
  return { bridge, view, stored: bridge.projects.get(created.id)! };
}

function input(bridge: FakeBridge, view: Awaited<ReturnType<typeof setup>>["view"], stepIndex = 0, extra: Partial<Parameters<typeof runStep>[0]> = {}) {
  const progress: RunProgress[] = [];
  let id = 0;
  return {
    progress,
    params: {
      bridge,
      rec: recordingRef(view),
      flow: view.flow,
      stepIndex,
      materials: view.materials,
      settings: defaultSettings(),
      capabilities: { ...DEFAULT_CAPABILITIES },
      newId: (prefix: string) => `${prefix}-${++id}`,
      now: () => new Date("2026-10-15T01:02:03.000Z"),
      onProgress: (item: RunProgress) => progress.push(item),
      isStopRequested: () => false,
      ...extra,
    },
  };
}

describe("runStep", () => {
  it("この Mac で続ける prompt に未確認の話者ラベルを入れない", async () => {
    const { bridge, view } = await setup();
    bridge.turnScript = () => [done("整えた本文")];
    const { params } = input(bridge, view);
    params.materials = {
      ...params.materials,
      sourceName: "文字起こし",
      source: "[00:00:01] 話者1: 本文\n\n[00:00:03] 佐藤: 続き\n",
      transcriptSpeakerNames: { "1": "佐藤" },
    };
    await runStep(params);
    expect(bridge.turnRequests[0]!.user_prompt).toContain("[00:00:01] 本文");
    expect(bridge.turnRequests[0]!.user_prompt).toContain("[00:00:03] 続き");
    expect(bridge.turnRequests[0]!.user_prompt).not.toContain("話者1:");
    expect(bridge.turnRequests[0]!.user_prompt).not.toContain("佐藤:");
  });

  it("候補の生成先・版・checkpoint・追加指示を開始時の案へ固定し、兄弟本文を変えない", async () => {
    const { bridge, stored } = await setup();
    await bridge.saveArtifact(rootRef(stored.project.id), FIX, false, "修正版", {
      id: "fix-run", kind: "run", at: "2026-10-15T00:10:00.000Z", stepId: FIX, stepName: "文字起こし修正", version: null, result: "saved",
    });
    await bridge.saveArtifact(rootRef(stored.project.id), POLICY, false, "記事方針", {
      id: "policy-run", kind: "run", at: "2026-10-15T00:20:00.000Z", stepId: POLICY, stepName: "記事方針", version: null, result: "saved",
    });
    await bridge.saveArtifact(rootRef(stored.project.id), BODY, false, "# 兄弟の本文", {
      id: "body-run", kind: "run", at: "2026-10-15T00:30:00.000Z", stepId: BODY, stepName: "記事本文", version: null, result: "saved",
    });
    const view = await recordingView(bridge, stored.project.id);
    bridge.turnScript = () => [done("# 若い読者向けの別案")];
    const { params } = input(bridge, view, 2, {
      candidate: {
        id: "candidate2",
        artifactId: "artifact2",
        instruction: "若い読者に向けて書く",
        inputVersions: { [SOURCE_STEP_ID]: 1, [FIX]: 1, [POLICY]: 1 },
      },
    });
    const outcome = await runStep(params);
    expect(outcome.status).toBe("saved");
    expect(stored.artifacts[BODY]).toBe("# 兄弟の本文");
    expect(stored.artifacts.artifact2).toBe("# 若い読者向けの別案\n");
    expect(bridge.turnRequests[0]!.system_prompt + bridge.turnRequests[0]!.user_prompt).toContain("若い読者に向けて書く");
    expect(stored.runs.at(-1)).toMatchObject({
      stepId: BODY,
      candidateId: "candidate2",
      artifactId: "artifact2",
      inputVersions: { [SOURCE_STEP_ID]: 1, [FIX]: 1, [POLICY]: 1 },
      version: 1,
    });
    expect(stored.checkpoints["run-1"]).toMatchObject({ candidateId: "candidate2", artifactId: "artifact2", state: "completed" });
  });

  it("終端イベント（Done）が command の戻りの後に Channel へ届いても、戻り値の終端イベントで版を保存する", async () => {
    // Tauri の Channel は 8,192 バイト以上のメッセージ（本文の全文を載せた Done）を fetch で後から取りに行くので、invoke が先に
    // 終わる。以前は終端イベントを受け取れず「AIの作業が途中で止まりました」になっていた（#18382 の実機の記事方針）
    const { bridge, view, stored } = await setup();
    bridge.lateTerminal = true;
    const body = "長い記事方針。".repeat(1500);
    bridge.turnScript = () => [{ type: "TextDelta", text: body }, done(body)];
    const { params } = input(bridge, view);
    const outcome = await runStep(params);
    expect(outcome.status).toBe("saved");
    expect(stored.artifacts[FIX]).toBe(`${body}\n`);
    expect(stored.runs.at(-1)).toMatchObject({ result: "saved", version: 1 });
  });

  it("1 回で書き終えたら版を足し、実行の記録と checkpoint を残す", async () => {
    const { bridge, view, stored } = await setup();
    bridge.turnScript = () => [{ type: "ThinkingDelta", text: "考える" }, { type: "TextDelta", text: "整えた" }, done("整えた本文", "EndTurn", "s1", "claude-sonnet-test")];
    const { params, progress } = input(bridge, view);
    const outcome = await runStep(params);
    expect(outcome.status).toBe("saved");
    const request = bridge.turnRequests[0]!;
    expect(request).toMatchObject({ provider: "ClaudeCode", model: "claude-sonnet-4-6", effort: "Low", resume_session: null, max_budget_usd: null });
    // CLI の作業フォルダは実行ごと（Rust が app data の workspaces/<runId> にする）
    expect(request.workspace).toBe("run-1");
    expect(request.system_prompt).toContain("## この工程");
    expect(request.user_prompt).toContain("## 文章\n\n[00:00:01] こんにちは");
    expect(stored.artifacts[FIX]).toBe("整えた本文\n");
    const record = stored.runs.at(-1)!;
    expect(record).toMatchObject({
      id: "run-1",
      kind: "run",
      stepId: FIX,
      stepName: "文字起こし修正",
      result: "saved",
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelUsed: "claude-sonnet-test",
      effort: "low",
      profile: "軽量",
      version: 1,
      continuations: 0,
      inputTokens: 100,
      outputTokens: 50,
      tokensKnown: true,
      costUsd: null,
      costKnown: false,
    });
    expect(record.inputChars).toBeGreaterThan(100);
    expect(record.basis?.source).toMatch(/^[0-9a-f]{16}$/);
    expect(progress.map((item) => item.kind)).toEqual(["turn", "thinking", "text", "text"]);
    expect(stored.checkpoints["run-1"]).toMatchObject({
      schemaVersion: 1,
      runId: "run-1",
      stepId: FIX,
      plan: "continuous",
      provider: "claude",
      model: "claude-sonnet-4-6",
      effort: "low",
      state: "completed",
      endReason: "EndTurn",
      output: "整えた本文\n",
      pending: null,
    });
    expect(stored.checkpoints["run-1"]!.fingerprint?.prompt).toMatch(/^[0-9a-f]{16}$/);
    expect(stored.checkpoints["run-1"]!.fingerprint?.basis).toEqual(record.basis);
  });

  it("TextDelta が続いている間に部分出力を checkpoint へ保存する", async () => {
    const { bridge, view, stored } = await setup();
    let release!: () => void;
    let started!: () => void;
    const waitStarted = new Promise<void>((resolve) => (started = resolve));
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.onTurnStarted = () => started();
    bridge.turnScript = () => [{ type: "TextDelta", text: "途中の出力" }, done("途中の出力")];
    const execution = runStep(input(bridge, view).params);
    try {
      await waitStarted;
      await new Promise((resolve) => setTimeout(resolve, 1150));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stored.checkpoints["run-1"]).toMatchObject({ state: "running", output: "", pending: "途中の出力" });
    } finally {
      release();
    }
    expect((await execution).status).toBe("saved");
  });

  it("案件の snapshot のモデルで実行する（設定を後で変えても変わらない）", async () => {
    const pinned: FlowSnapshot = {
      ...snapshot,
      models: { ...snapshot.models, [FIX]: { provider: "claude", model: "opus", effort: "max", profileId: "advanced", profileName: "高性能" } },
    };
    const { bridge, view, stored } = await setup(undefined, pinned);
    bridge.turnScript = () => [done("本文")];
    const base = defaultSettings();
    const settings = setActiveProfiles(
      base,
      activeProfiles(base).map((profile): Profile => ({ ...profile, models: { claude: { model: "haiku", effort: "low" } } })),
    );
    await runStep(input(bridge, view, 0, { settings }).params);
    expect(bridge.turnRequests[0]).toMatchObject({ model: "opus", effort: "Max" });
    expect(stored.runs.at(-1)).toMatchObject({ model: "opus", effort: "max", profile: "高性能" });
  });

  it("上限で止まったら同じ会話で続きを頼み、重なりを除いて繋ぐ", async () => {
    const { bridge, view, stored } = await setup();
    bridge.turnScript = (_request, call) => (call === 0 ? [done("前半の文です。後半の文", "MaxTokens", "sess-1")] : [done("後半の文です。")]);
    const outcome = await runStep(input(bridge, view).params);
    expect(outcome.status).toBe("saved");
    expect(bridge.turnRequests[1]).toMatchObject({ user_prompt: CONTINUATION_INSTRUCTION, resume_session: "sess-1", workspace: "run-1" });
    expect(stored.artifacts[FIX]).toBe("前半の文です。後半の文です。\n");
    expect(stored.runs.at(-1)).toMatchObject({ continuations: 1, inputTokens: 200, outputTokens: 100 });
    expect(stored.checkpoints["run-1"]).toMatchObject({ continuations: 1, sessionRef: "sess-1", state: "completed" });
  });

  it("Claude Code が同じ実行の中で頼んだ続きは数に足し、書き終えていればアプリは続きを頼まない", async () => {
    const { bridge, view, stored } = await setup();
    bridge.turnScript = () => [done("自分で続けて書き終えた本文", "EndTurn", "sess-1", "claude-sonnet-test", 2)];
    const outcome = await runStep(input(bridge, view).params);
    expect(outcome.status).toBe("saved");
    expect(bridge.turnRequests).toHaveLength(1);
    expect(stored.runs.at(-1)).toMatchObject({ result: "saved", continuations: 2 });
    expect(stored.checkpoints["run-1"]).toMatchObject({ continuations: 2, state: "completed" });
  });

  it("CLI の続きのあとも上限で止まったときだけ、アプリが同じ会話で続きを頼み、回数は二重に数えない", async () => {
    const { bridge, view, stored } = await setup();
    bridge.turnScript = (_request, call) =>
      call === 0
        ? [done("前半の文です。後半の文", "MaxTokens", "sess-1", "claude-sonnet-test", 3)]
        : [done("後半の文です。", "EndTurn", "sess-1", "claude-sonnet-test", 1)];
    const { params, progress } = input(bridge, view);
    const outcome = await runStep(params);
    expect(outcome.status).toBe("saved");
    expect(bridge.turnRequests).toHaveLength(2);
    expect(bridge.turnRequests[1]).toMatchObject({ user_prompt: CONTINUATION_INSTRUCTION, resume_session: "sess-1" });
    expect(stored.artifacts[FIX]).toBe("前半の文です。後半の文です。\n");
    // CLI 3 回 ＋ アプリ 1 回 ＋ CLI 1 回
    expect(stored.runs.at(-1)).toMatchObject({ continuations: 5 });
    expect(stored.checkpoints["run-1"]).toMatchObject({ continuations: 5, sessionRef: "sess-1" });
    // 実行の行の「続きを N 回頼みました」は、その時点までの和
    expect(progress.flatMap((item) => (item.kind === "turn" ? [item.continuation] : []))).toEqual([0, 4]);
  });

  it(`アプリの続きの上限（${MAX_CONTINUATIONS} 回）は CLI の続きを含めずに数える`, async () => {
    const { bridge, view, stored } = await setup();
    bridge.turnScript = (_request, call) => [done(`部分${call}。`, "MaxTokens", "sess-1", "claude-sonnet-test", 3)];
    const outcome = await runStep(input(bridge, view).params);
    expect(outcome).toMatchObject({ status: "failed", reasonCode: "ContinuationLimit" });
    expect(bridge.turnRequests).toHaveLength(MAX_CONTINUATIONS + 1);
    expect(stored.runs.at(-1)).toMatchObject({ continuations: (MAX_CONTINUATIONS + 1) * 3 + MAX_CONTINUATIONS });
  });

  it("続けられない CLI では、ここまでの出力を添えて新しい実行で続け、重なりで繋ぐ", async () => {
    const { bridge, view, stored } = await setup();
    bridge.turnScript = (_request, call) => (call === 0 ? [done("前半の文です。後半の文", "MaxTokens", null)] : [done("後半の文です。")]);
    const outcome = await runStep(input(bridge, view, 0, { capabilities: { ...DEFAULT_CAPABILITIES, resume: false } }).params);
    expect(outcome.status).toBe("saved");
    const second = bridge.turnRequests[1]!;
    expect(second.resume_session).toBeNull();
    expect(second.user_prompt).toContain("## ここまでの出力\n\n前半の文です。後半の文");
    expect(second.user_prompt.endsWith(CONTINUATION_INSTRUCTION)).toBe(true);
    expect(stored.artifacts[FIX]).toBe("前半の文です。後半の文です。\n");
  });

  it("新しい実行の続きが前の出力に重ならなければ自動で繋がず、途中までと続き候補を残す", async () => {
    const { bridge, view, stored } = await setup();
    bridge.turnScript = (_request, call) => (call === 0 ? [done("前半の文です。", "MaxTokens", null)] : [done("言い換えた書き出し。")]);
    const outcome = await runStep(input(bridge, view, 0, { capabilities: { ...DEFAULT_CAPABILITIES, resume: false } }).params);
    expect(outcome).toMatchObject({ status: "failed", message: CONTINUATION_NOT_JOINABLE_MESSAGE, reasonCode: "NotJoinable" });
    expect(stored.artifacts[FIX]).toBeUndefined();
    expect(stored.runs.at(-1)).toMatchObject({ result: "failed", version: null, reasonCode: "NotJoinable", partialChars: 7, outputChars: 0 });
    expect(stored.checkpoints["run-1"]).toMatchObject({
      state: "failed",
      endReason: "NotJoinable",
      output: "前半の文です。",
      pending: "言い換えた書き出し。",
    });
  });

  it("続きの会話が見つからなければ、新しい実行に切り替える", async () => {
    const { bridge, view } = await setup();
    const script: TurnEvent[][] = [
      [done("前半の文です。後半の文", "MaxTokens", "sess-1")],
      [{ type: "Error", reason_code: "SessionNotFound", message: "見つからない" }],
      [done("後半の文です。")],
    ];
    bridge.turnScript = (_request, call) => script[call] ?? [];
    const outcome = await runStep(input(bridge, view).params);
    expect(outcome.status).toBe("saved");
    expect(bridge.turnRequests[2]!.resume_session).toBeNull();
    expect(bridge.turnRequests[2]!.user_prompt).toContain("## ここまでの出力");
  });

  it(`続きが ${MAX_CONTINUATIONS} 回を超えたら失敗にして版を足さず、途中までを checkpoint に残す`, async () => {
    const { bridge, view, stored } = await setup();
    bridge.turnScript = (_request, call) => [done(`部分${call}。`, "MaxTokens", "sess-1")];
    const outcome = await runStep(input(bridge, view).params);
    expect(outcome).toMatchObject({ status: "failed", message: CONTINUATION_LIMIT_MESSAGE, reasonCode: "ContinuationLimit" });
    expect(bridge.turnRequests).toHaveLength(MAX_CONTINUATIONS + 1);
    expect(stored.artifacts[FIX]).toBeUndefined();
    const record = stored.runs.at(-1)!;
    expect(record).toMatchObject({ result: "failed", version: null, continuations: MAX_CONTINUATIONS });
    expect(record.partialChars).toBeGreaterThan(0);
    expect(stored.checkpoints["run-1"]).toMatchObject({ state: "failed", endReason: "ContinuationLimit", continuations: MAX_CONTINUATIONS });
    expect(stored.checkpoints["run-1"]!.output).toContain(`部分${MAX_CONTINUATIONS}。`);
  });

  it("理由コードの失敗と停止を記録し、途中までは版にしない", async () => {
    const { bridge, view, stored } = await setup();
    bridge.turnScript = () => [{ type: "Error", reason_code: "CliLoginRequired", message: "ログインしてください" }];
    const failed = await runStep(input(bridge, view).params);
    expect(failed).toMatchObject({ status: "failed", message: "ログインしてください", reasonCode: "CliLoginRequired" });
    expect(stored.runs.at(-1)).toMatchObject({ result: "failed", reasonCode: "CliLoginRequired", message: "ログインしてください", tokensKnown: false });

    bridge.turnScript = () => [{ type: "TextDelta", text: "途中" }, done("途中", "Stopped")];
    const stopped = await runStep(input(bridge, view).params);
    expect(stopped.status).toBe("stopped");
    expect(stored.runs.at(-1)).toMatchObject({ result: "stopped", message: STOPPED, partialChars: 2, version: null });
    expect(stored.artifacts[FIX]).toBeUndefined();
    expect(stored.checkpoints["run-1"]).toMatchObject({ state: "stopped", endReason: "Stopped", output: "途中" });
  });

  it("時間切れは Timeout の失敗にして、途中までを残す", async () => {
    const { bridge, view, stored } = await setup();
    bridge.turnScript = () => [
      { type: "TextDelta", text: "書きかけ" },
      { type: "Error", reason_code: "Timeout", message: reasonMessage("Timeout") },
    ];
    const outcome = await runStep(input(bridge, view).params);
    expect(outcome).toMatchObject({ status: "failed", reasonCode: "Timeout", message: reasonMessage("Timeout") });
    expect(stored.runs.at(-1)).toMatchObject({ result: "failed", reasonCode: "Timeout", partialChars: 4 });
    expect(stored.checkpoints["run-1"]).toMatchObject({ state: "failed", endReason: "Timeout", output: "書きかけ" });
    expect(stored.artifacts[FIX]).toBeUndefined();
  });

  it("続きの間に止める指示が出たら、次を頼まない", async () => {
    const { bridge, view, stored } = await setup();
    bridge.turnScript = () => [done("前半", "MaxTokens", "sess-1")];
    const outcome = await runStep(input(bridge, view, 0, { isStopRequested: () => true }).params);
    expect(outcome.status).toBe("stopped");
    expect(bridge.turnRequests).toHaveLength(1);
    expect(stored.checkpoints["run-1"]).toMatchObject({ state: "stopped", output: "前半", sessionRef: "sess-1" });
  });

  it("前の工程が無ければ実行しない", async () => {
    const { bridge, view } = await setup();
    const outcome = await runStep(input(bridge, view, 2).params);
    expect(outcome).toMatchObject({ status: "failed" });
    expect(outcome.status === "failed" && outcome.message).toContain("文字起こし修正");
    expect(bridge.turnRequests).toHaveLength(0);
    expect(view.flow.steps.map((step) => step.id)).toEqual([FIX, POLICY, BODY]);
  });
});

describe("runTranscription", () => {
  async function audioSetup() {
    const bridge = new FakeBridge();
    const created = await bridge.createProject({ ...textProject(), source: { kind: "audio", audio: [] } }, null, null, ["/a/1.m4a", "/a/2.m4a"]);
    return { bridge, project: created, stored: bridge.projects.get(created.id)! };
  }

  it("音声ごとの JSONL を時刻をずらして 1 本の Markdown にし、工程 1 の版として保存する", async () => {
    const { bridge, project, stored } = await audioSetup();
    expect(project.source?.kind === "audio" && project.source.audio.map((item) => item.name)).toEqual(["1.m4a", "2.m4a"]);
    bridge.speechEvents = [
      { type: "Stage", stage: "convert", file: 0, files: 2 },
      { type: "Segment", file: 0, start: 1, end: 2, text: "一本目" },
      { type: "Segment", file: 1, start: 5, end: 6, text: "二本目" },
    ];
    bridge.transcribeResult = [
      { jsonl: '{"type":"segment","start":1,"end":2,"text":"一本目"}\n', durationSec: 61 },
      { jsonl: '{"type":"segment","start":5,"end":6,"text":"二本目"}\n', durationSec: 30 },
    ];
    const progress: RunProgress[] = [];
    const outcome = await runTranscription({
      bridge,
      rec: rootRef(project.id),
      project,
      recording: rootRecording(project)!,
      flow: snapshot,
      jobId: "speech-1",
      newId: (prefix) => `${prefix}-1`,
      now: () => new Date("2026-10-15T00:00:00.000Z"),
      onProgress: (item) => progress.push(item),
    });
    expect(outcome.status).toBe("saved");
    expect(stored.transcript).toBe("[00:00:01] 一本目\n\n[00:01:06] 二本目\n");
    expect(stored.runs.at(-1)).toMatchObject({ kind: "run", stepId: SOURCE_STEP_ID, provider: "this-mac", audioSec: 91, version: 1 });
    expect(bridge.transcribeSpeakerModes).toEqual(["3"]);
    expect(progress.some((item) => item.kind === "speech-text" && item.text === "[00:00:01] 一本目")).toBe(true);
    expect(progress.some((item) => item.kind === "speech-text" && item.text === "[00:00:01] 一本目\n\n[00:01:05] 二本目")).toBe(true);
    expect(stored.checkpoints["run-1"]).toMatchObject({ state: "completed", output: stored.transcript });
  });

  it("Apple 話者分離を既存 speakerMode で渡し、live・最終版・複数音声の Part scopeを揃える", async () => {
    const { bridge, project, stored } = await audioSetup();
    project.info.speakers = "2";
    if (project.source?.kind === "audio") {
      project.source.audio = project.source.audio.map((item) => ({ ...item, durationSec: 10 }));
    }
    bridge.speechEvents = [
      { type: "Segment", file: 0, start: 1, end: 2, text: "一本目", speaker: 1 },
      { type: "Segment", file: 1, start: 1, end: 2, text: "二本目", speaker: null },
    ];
    bridge.transcribeResult = [
      { jsonl: '{"type":"segment","start":1,"end":2,"text":"一本目","speaker":1}\n', durationSec: 10 },
      { jsonl: '{"type":"segment","start":1,"end":2,"text":"二本目","speaker":null}\n', durationSec: 10 },
    ];
    const live: string[] = [];
    const outcome = await runTranscription({
      bridge,
      rec: rootRef(project.id),
      project,
      recording: rootRecording(project)!,
      flow: snapshot,
      jobId: "speech-speakers",
      newId: () => "run-speakers",
      now: () => new Date("2026-10-15T00:00:00.000Z"),
      onProgress: (item) => {
        if (item.kind === "speech-text") live.push(item.text);
      },
    });
    expect(outcome.status).toBe("saved");
    expect(bridge.transcribeSpeakerModes).toEqual(["2"]);
    expect(stored.transcript).toBe(
      "## Part 1: 1.m4a\n\n[00:00:01] 話者1: 一本目\n\n## Part 2: 2.m4a\n\n[00:00:11] 話者?: 二本目\n",
    );
    expect(live.at(-1)).toBe(stored.transcript?.trimEnd());
    expect(stored.checkpoints["run-speakers"]?.output).toBe(stored.transcript);
  });

  it("Segment を受信中に checkpoint を更新する", async () => {
    const { bridge, project, stored } = await audioSetup();
    let release!: () => void;
    let started!: () => void;
    const waitStarted = new Promise<void>((resolve) => (started = resolve));
    bridge.speechEvents = [{ type: "Segment", file: 0, start: 1, end: 2, text: "途中の文字起こし" }];
    bridge.transcribeResult = [{ jsonl: '{"type":"segment","start":1,"end":2,"text":"途中の文字起こし"}\n', durationSec: 60 }];
    bridge.transcribeGate = new Promise<void>((resolve) => (release = resolve));
    bridge.onTranscribeStarted = () => started();
    const execution = runTranscription({
      bridge,
      rec: rootRef(project.id),
      project,
      recording: rootRecording(project)!,
      flow: snapshot,
      jobId: "speech-1",
      newId: (prefix) => `${prefix}-1`,
      now: () => new Date("2026-10-15T00:00:00.000Z"),
      onProgress: () => undefined,
    });
    try {
      await waitStarted;
      await new Promise((resolve) => setTimeout(resolve, 1150));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stored.checkpoints["run-1"]).toMatchObject({ state: "running", output: "[00:00:01] 途中の文字起こし" });
    } finally {
      release();
    }
    expect((await execution).status).toBe("saved");
  });

  it("再文字起こしは前の版の話者名 metadata を引き継がない", async () => {
    const { bridge, project, stored } = await audioSetup();
    await bridge.saveArtifact(rootRef(project.id), SOURCE_STEP_ID, true, "[00:00:01] 田中: 前の版\n", {
      id: "save-named",
      kind: "save",
      at: "2026-10-15T00:00:00.000Z",
      stepId: SOURCE_STEP_ID,
      stepName: "文字起こし",
      version: null,
      result: "saved",
      transcriptSpeakerNames: { "0": "田中" },
    });
    bridge.transcribeResult = [
      { jsonl: '{"type":"segment","start":1,"end":2,"text":"新しい一本目"}\n', durationSec: 10 },
      { jsonl: '{"type":"segment","start":1,"end":2,"text":"新しい二本目"}\n', durationSec: 10 },
    ];
    const outcome = await runTranscription({
      bridge,
      rec: rootRef(project.id),
      project,
      recording: rootRecording(project)!,
      flow: snapshot,
      jobId: "speech-reset",
      newId: () => "run-reset",
      now: () => new Date("2026-10-15T01:00:00.000Z"),
      onProgress: () => undefined,
    });
    expect(outcome.status).toBe("saved");
    expect(stored.runs.at(-1)).toMatchObject({ kind: "run", version: 2, provider: "this-mac" });
    expect(stored.runs.at(-1)?.transcriptSpeakerNames).toBeUndefined();
  });

  it("止めたら停止として記録し、途中までを checkpoint に残す", async () => {
    const { bridge, project, stored } = await audioSetup();
    bridge.speechEvents = [{ type: "Segment", file: 0, start: 1, end: 2, text: "一本目" }];
    bridge.transcribeResult = { code: "speech_stopped", message: "文字起こしを止めました。" };
    const outcome = await runTranscription({
      bridge,
      rec: rootRef(project.id),
      project,
      recording: rootRecording(project)!,
      flow: snapshot,
      jobId: "speech-1",
      newId: (prefix) => `${prefix}-1`,
      now: () => new Date(),
      onProgress: () => undefined,
    });
    expect(outcome.status).toBe("stopped");
    expect(stored.runs.at(-1)).toMatchObject({ result: "stopped", reasonCode: "speech_stopped", message: STOPPED, partialChars: 14 });
    expect(stored.transcript).toBeNull();
    expect(stored.checkpoints["run-1"]).toMatchObject({ state: "stopped", provider: "this-mac", fingerprint: null, output: "[00:00:01] 一本目" });
  });
});
