import { describe, expect, it, vi } from "vitest";
import {
  FLOW_TEMPLATES,
  SOURCE_STEP_ID,
  countChars,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  rootRecording,
  type Project,
  type TurnEvent,
} from "@niho/docs-core";
import { GEMINI_TRANSCRIPTION_MODEL, runTranscription, type RunProgress } from "../src/lib/runner";
import { FakeBridge, rootRef } from "./fake-bridge";

const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
flow.terms = [{ term: "NIHO鎌倉", reading: "にほかまくら", variants: ["ニホ鎌倉"], note: "" }];
const snapshot = createFlowSnapshot(flow, defaultProfiles(), ["gemini"]);

function audioProject(): Project {
  return {
    version: 1,
    id: "",
    name: "運営会議",
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot: snapshot,
    info: { speakers: "2", language: "ja", terms: [{ term: "材木座", reading: "ざいもくざ", variants: [], note: "" }], background: "" },
    source: { kind: "audio", audio: [] },
  };
}

function partDone(text: string, input = 1000, output = 100): TurnEvent {
  return {
    type: "Done",
    text,
    stop_reason: "EndTurn",
    session_id: "c1",
    usage: { input_tokens: input, output_tokens: output, cost_usd: null, model_used: GEMINI_TRANSCRIPTION_MODEL, cost_known: false },
    duration_ms: 10,
    continuations: 0,
  };
}

async function setup() {
  const bridge = new FakeBridge();
  const created = await bridge.createProject(audioProject(), null, null, ["/a/m.m4a"]);
  return { bridge, project: created, stored: bridge.projects.get(created.id)! };
}

function run(bridge: FakeBridge, project: Project, progress: RunProgress[] = [], isStopRequested = () => false) {
  let id = 0;
  return runTranscription({
    bridge,
    rec: rootRef(project.id),
    project,
    recording: rootRecording(project)!,
    flow: snapshot,
    jobId: "speech-1",
    engine: "gemini",
    newId: (prefix) => `${prefix}-${++id}`,
    now: () => new Date("2026-10-15T00:00:00.000Z"),
    onProgress: (item) => progress.push(item),
    isStopRequested,
  });
}

describe("Gemini（Antigravity CLI）の文字起こし", () => {
  it("区切りごとに読ませ、開始秒を足した時刻で 1 本にして版にする。直前の区切りの末尾を次の指示に渡す", async () => {
    const { bridge, project, stored } = await setup();
    bridge.audioPartScript = (_request, call) =>
      call === 0
        ? [{ type: "TextDelta", text: "[00:02]" }, partDone("[00:02] 話者A: 今日は集まっていただきありがとうございます。\n\n[00:30] 話者B: よろしくお願いします。")]
        : [partDone("[00:01] 話者B: 続けます。\n\n[00:20] 話者A: 材木座の件です。", 2000, 200)];
    const progress: RunProgress[] = [];
    const outcome = await run(bridge, project, progress);
    expect(outcome.status).toBe("saved");
    expect(stored.transcript).toBe(
      "[00:00:02] 話者0: 今日は集まっていただきありがとうございます。\n\n[00:00:30] 話者1: よろしくお願いします。\n\n[00:00:49] 話者1: 続けます。\n\n[00:01:08] 話者0: 材木座の件です。\n",
    );
    // 区切りは prepare_audio の位置で指し、指示はファイル名・区切りの位置・固有名詞（案件情報と文書ガイド）を持つ
    expect(bridge.audioPartRequests.map((item) => [item.jobId, item.file, item.part])).toEqual([
      ["speech-1", 0, 0],
      ["speech-1", 0, 1],
    ]);
    const [first, second] = bridge.audioPartRequests.map((item) => item.request);
    expect(first).toMatchObject({ provider: "GeminiCli", model: "gemini-3.8-flash", effort: "Low" });
    expect(first?.system_prompt).toContain("- 材木座（よみ: ざいもくざ）");
    expect(first?.system_prompt).toContain("- NIHO鎌倉（よみ: にほかまくら）（誤りやすい表記: ニホ鎌倉）");
    expect(first?.user_prompt).toContain("view_file で「f0-p0.wav」を直接読み込んでください");
    expect(first?.user_prompt).not.toContain("直前の区切りの末尾");
    expect(second?.user_prompt).toContain("view_file で「f0-p1.wav」");
    expect(second?.user_prompt).toContain("2個に区切ったうちの2番目");
    expect(second?.user_prompt).toContain("話者A: 今日は集まっていただきありがとうございます。\n話者B: よろしくお願いします。");
    // 実行の記録: エンジン・実際のモデル・所要・トークン（区切りの和）・音声の長さ
    expect(stored.runs.at(-1)).toMatchObject({
      kind: "run",
      stepId: SOURCE_STEP_ID,
      provider: "gemini",
      model: "gemini-3.8-flash",
      modelUsed: "gemini-3.8-flash",
      effort: "low",
      result: "saved",
      version: 1,
      tokensKnown: true,
      inputTokens: 3000,
      outputTokens: 300,
      audioSec: 95,
    });
    expect(stored.checkpoints["run-1"]).toMatchObject({ provider: "gemini", state: "completed", output: stored.transcript });
    expect(bridge.releasedAudio).toEqual(["speech-1"]);
    // 進み具合: 変換・区切り（prepare）→ 区切りごとの番号
    const stages = progress.flatMap((item) => (item.kind === "speech" && item.event.type === "Stage" ? [[item.event.stage, item.event.part ?? null]] : []));
    expect(stages).toEqual([
      ["convert", null],
      ["silence", null],
      ["transcribe", 0],
      ["transcribe", 1],
    ]);
    expect(progress.filter((item) => item.kind === "turn")).toHaveLength(2);
  });

  it("区切りの終端イベントが command の戻りの後に届いても、戻り値の終端イベントで 1 本にする", async () => {
    // Tauri の Channel は 8,192 バイト以上のメッセージを後から取りに行く（15 分の区切りの文字起こしは超える）
    const { bridge, project, stored } = await setup();
    bridge.lateTerminal = true;
    bridge.audioPartScript = (_request, call) =>
      call === 0 ? [partDone("[00:02] 話者A: 一つ目の区切りです。")] : [partDone("[00:01] 話者B: 二つ目の区切りです。", 2000, 200)];
    const outcome = await run(bridge, project, []);
    expect(outcome.status).toBe("saved");
    expect(stored.transcript).toBe("[00:00:02] 話者0: 一つ目の区切りです。\n\n[00:00:49] 話者1: 二つ目の区切りです。\n");
  });

  it("2 つ目の区切りで失敗したら、終わった区切りまでを checkpoint に残して理由を出す（音声の準備は片付ける）", async () => {
    const { bridge, project, stored } = await setup();
    bridge.audioPartScript = (_request, call) =>
      call === 0 ? [partDone("[00:02] 話者A: 一つ目の区切り。")] : [{ type: "Error", reason_code: "UsageLimitReached", message: "Gemini の利用上限に達しました。" }];
    const outcome = await run(bridge, project);
    expect(outcome).toMatchObject({ status: "failed", message: "Gemini の利用上限に達しました。", reasonCode: "UsageLimitReached" });
    expect(stored.transcript).toBeNull();
    expect(stored.checkpoints["run-1"]).toMatchObject({ state: "failed", output: "[00:00:02] 話者0: 一つ目の区切り。\n", endReason: "UsageLimitReached" });
    expect(stored.runs.at(-1)).toMatchObject({
      result: "failed",
      reasonCode: "UsageLimitReached",
      partialChars: countChars("[00:00:02] 話者0: 一つ目の区切り。\n"),
      provider: "gemini",
    });
    expect(bridge.releasedAudio).toEqual(["speech-1"]);
  });

  it("区切りの command 自体が拒否されたら、終わった区切りまでを checkpoint に残して失敗として記録する（running のまま残さない）", async () => {
    const { bridge, project, stored } = await setup();
    bridge.audioPartScript = (_request, call) => {
      if (call === 1) throw { code: "audio_part_missing", message: "準備した音声が見つかりません。" };
      return [partDone("[00:02] 話者A: 一つ目の区切り。")];
    };
    const outcome = await run(bridge, project);
    expect(outcome).toMatchObject({ status: "failed", message: "準備した音声が見つかりません。", reasonCode: "audio_part_missing" });
    expect(bridge.audioPartRequests.map((item) => item.part)).toEqual([0, 1]);
    expect(stored.checkpoints["run-1"]).toMatchObject({ state: "failed", output: "[00:00:02] 話者0: 一つ目の区切り。\n", endReason: "audio_part_missing" });
    expect(stored.runs.at(-1)).toMatchObject({ result: "failed", reasonCode: "audio_part_missing", provider: "gemini" });
    expect(bridge.releasedAudio).toEqual(["speech-1"]);
  });

  it("音声を読めなかった区切り（TransientFailure）は頼み直す", async () => {
    const { bridge, project, stored } = await setup();
    bridge.audioPartScript = (_request, call) =>
      call === 0 ? [{ type: "Error", reason_code: "TransientFailure", message: "Antigravity CLI が音声を読めませんでした。" }] : [partDone(`[00:0${call}] 区切り ${call}`)];
    const outcome = await run(bridge, project);
    expect(outcome.status).toBe("saved");
    expect(bridge.audioPartRequests.map((item) => item.part)).toEqual([0, 0, 1]);
    expect(stored.transcript).toBe("[00:00:01] 区切り 1\n\n[00:00:50] 区切り 2\n");
  });

  it("有音の長い区切りで本文が短すぎれば再試行し、十分な本文だけ保存する", async () => {
    const { bridge, project, stored } = await setup();
    bridge.preparedAudio = [{ durationSec: 120, parts: [{ startSec: 0, endSec: 120, soundSec: 100 }] }];
    bridge.audioPartScript = (_request, call) => [
      partDone(call === 0
        ? "[00:02] 話者A: はい。"
        : "[00:02] 話者A: 今日は議題を順に確認します。最初に先週の取り組みと結果を振り返り、その後で次の予定と担当を決めます。"),
    ];
    const outcome = await run(bridge, project);
    expect(outcome.status).toBe("saved");
    expect(bridge.audioPartRequests).toHaveLength(2);
    expect(stored.transcript).toContain("今日は議題を順に確認します。");
    expect(stored.transcript).not.toContain("はい。");
  });

  it("短すぎる返答が続けば版にせず、前の区切りまでを checkpoint に残す", async () => {
    const { bridge, project, stored } = await setup();
    bridge.preparedAudio = [{ durationSec: 180, parts: [
      { startSec: 0, endSec: 60, soundSec: 50 },
      { startSec: 60, endSec: 180, soundSec: 100 },
    ] }];
    bridge.audioPartScript = (_request, call) => [partDone(call === 0 ? "[00:02] 話者A: 最初の区切りです。" : "[00:02] 話者A: はい。")];
    const outcome = await run(bridge, project);
    expect(outcome).toMatchObject({ status: "failed", reasonCode: "TranscriptTooShort" });
    expect(bridge.audioPartRequests.map((item) => item.part)).toEqual([0, 1, 1, 1]);
    expect(stored.transcript).toBeNull();
    expect(stored.checkpoints["run-1"]).toMatchObject({ state: "failed", output: "[00:00:02] 話者0: 最初の区切りです。\n", endReason: "TranscriptTooShort" });
    expect(bridge.releasedAudio).toEqual(["speech-1"]);
  });

  it("実際に無音の区切りは空の返答を許し、後続の発言を残す", async () => {
    const { bridge, project, stored } = await setup();
    bridge.preparedAudio = [{ durationSec: 120, parts: [
      { startSec: 0, endSec: 60, soundSec: 0 },
      { startSec: 60, endSec: 120, soundSec: 40 },
    ] }];
    bridge.audioPartScript = (_request, call) => [partDone(call === 0 ? "" : "[00:02] 話者A: 後半から会議を始めます。")];
    const outcome = await run(bridge, project);
    expect(outcome.status).toBe("saved");
    expect(bridge.audioPartRequests).toHaveLength(2);
    expect(stored.transcript).toBe("[00:01:02] 話者0: 後半から会議を始めます。\n");
  });

  it("出力上限で止まった区切りは本文が長くても再試行する", async () => {
    const { bridge, project, stored } = await setup();
    bridge.audioPartScript = (_request, call) => {
      const done = partDone("[00:02] 話者A: この区切りの文章は十分な長さですが、出力上限によって途中で止まっています。");
      return [{ ...done, stop_reason: call === 0 ? "MaxTokens" : "EndTurn" }];
    };
    const outcome = await run(bridge, project);
    expect(outcome.status).toBe("saved");
    expect(bridge.audioPartRequests.map((item) => item.part)).toEqual([0, 0, 1]);
    expect(stored.transcript).toContain("出力上限によって途中で止まっています");
  });

  it("区切りの途中で止めたら停止として記録し、続きの区切りは頼まない", async () => {
    const { bridge, project, stored } = await setup();
    let stop = false;
    bridge.audioPartScript = (_request, call) => {
      if (call === 0) stop = true;
      return [partDone("[00:02] 一つ目")];
    };
    const outcome = await run(bridge, project, [], () => stop);
    expect(outcome.status).toBe("stopped");
    expect(bridge.audioPartRequests).toHaveLength(1);
    expect(stored.runs.at(-1)).toMatchObject({ result: "stopped", provider: "gemini", partialChars: 15 });
    expect(stored.checkpoints["run-1"]).toMatchObject({ state: "stopped", output: "[00:00:02] 一つ目\n" });
  });

  it("音声の準備（変換・区切り）で止まったら、区切りを頼まずに理由を出す", async () => {
    const { bridge, project, stored } = await setup();
    bridge.preparedAudio = { code: "speech_not_found", message: "文字起こしの部品が見つかりません。" };
    const outcome = await run(bridge, project);
    expect(outcome).toMatchObject({ status: "failed", message: "文字起こしの部品が見つかりません。" });
    expect(bridge.audioPartRequests).toHaveLength(0);
    expect(stored.runs.at(-1)).toMatchObject({ result: "failed", reasonCode: "speech_not_found", provider: "gemini" });
    expect(bridge.releasedAudio).toEqual(["speech-1"]);
  });
});

describe("文字起こしの話者人数・言語は録音の値（#18566 P3）", () => {
  it("Gemini・Deepgram・この Mac は 録音の話者人数・言語を使い、固有名詞は案件の値のまま", async () => {
    const { bridge, project } = await setup();
    project.info.entities = [{ id: "person-1", name: "佐藤花子", reading: "さとうはなこ", role: "店主", note: "会長の紹介" }];
    // 案件の info は 2 人・日本語、録音は 1 人・英語
    const recording = { ...rootRecording(project)!, speakers: "none" as const, language: "en" as const };
    const input = (engine: "gemini" | "deepgram" | "this-mac") => {
      let id = 0;
      return {
        bridge,
        rec: rootRef(project.id),
        project,
        recording,
        flow: snapshot,
        jobId: `speech-${engine}`,
        engine,
        connection: engine === "deepgram" ? ("apiKey" as const) : ("subscription" as const),
        newId: (prefix: string) => `${prefix}-${engine}-${++id}`,
        now: () => new Date("2026-10-15T00:00:00.000Z"),
        onProgress: () => undefined,
      };
    };
    bridge.audioPartScript = () => [partDone("[00:02] Hello everyone.")];
    expect((await runTranscription(input("gemini"))).status).toBe("saved");
    const system = bridge.audioPartRequests[0]!.request.system_prompt;
    expect(system).toContain("英語の音声です");
    expect(system).toContain("材木座");
    expect(system).toContain("佐藤花子（よみ: さとうはなこ）");
    expect(system).not.toContain("会長の紹介");

    bridge.keychain.set("deepgram", "dg-test-key-0000");
    expect((await runTranscription(input("deepgram"))).status).toBe("saved");
    expect(bridge.deepgramRequests[0]!.request).toMatchObject({ language: "en", diarize: false });
    expect(bridge.deepgramRequests[0]!.request.keyterms).toContain("材木座");
    expect(bridge.deepgramRequests[0]!.request.keyterms).toContain("佐藤花子");

    bridge.transcribeResult = [{ jsonl: '{"type":"segment","start":1,"end":2,"text":"Hello."}\n', durationSec: 60 }];
    const transcribe = vi.spyOn(bridge, "transcribe");
    expect((await runTranscription(input("this-mac"))).status).toBe("saved");
    expect(bridge.transcribeLanguages).toEqual(["en"]);
    // transcribe(jobId, rec, language, speakerMode, hints, onEvent): 固有名詞は hints（5 番目）
    expect(transcribe.mock.calls[0]![4]).toContainEqual({ term: "佐藤花子" });
  });
});
