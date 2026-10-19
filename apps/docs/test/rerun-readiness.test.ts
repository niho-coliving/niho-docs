import { afterEach, describe, expect, it } from "vitest";
import { SOURCE_STEP_ID, type FlowSnapshot } from "@niho/docs-core";
import { rerunQueueOf, type RecordingView } from "../src/lib/project-view";
import { runSetupReason } from "../src/lib/run-readiness";
import { addProvider, defaultSettings, effectiveEngine, rememberSpeechSupport, setConnection, setDeepgram, setEngine } from "../src/lib/settings";

// 完了した録音（残りの工程なし）の「すべて再実行」も、工程の実行と同じ準備の不足で止める（#18724 の review）。
function completedView(source: RecordingView["recording"]["source"]): RecordingView {
  return {
    recording: { source },
    plan: { steps: [{ stepId: SOURCE_STEP_ID }, { stepId: "minutes" }], remaining: [] },
  } as unknown as RecordingView;
}

const flow = { steps: [], models: {} } as unknown as FlowSnapshot;
const speech = { found: true, fake: false, available: true, needsDownload: true, engine: "SpeechAnalyzer", error: null, notice: null, diarization: { state: "ready" as const, detail: null } };

describe("すべて再実行の準備", () => {
  it("音声のある録音は文字起こしから再実行するので、音声モデルが未取得なら理由を返す", () => {
    const view = completedView({ kind: "audio", audio: [{ name: "a.m4a", file: "a.m4a" }] } as never);
    const queue = rerunQueueOf(view);
    expect(queue).toEqual([SOURCE_STEP_ID, "minutes"]);
    const settings = setEngine(defaultSettings(), "this-mac");
    expect(effectiveEngine(settings)).toBe("this-mac");
    expect(runSetupReason({ queue, flow, settings, statuses: { providers: {}, speech } })).toBe("この Mac の音声モデルを取得すると実行できます");
  });

  it("文章の録音は工程 2 から再実行し、文字起こしの準備では止めない", () => {
    const view = completedView({ kind: "text" } as never);
    const queue = rerunQueueOf(view);
    expect(queue).toEqual(["minutes"]);
    expect(runSetupReason({ queue, flow, settings: defaultSettings(), statuses: { providers: {}, speech } })).toBeNull();
  });
});

describe("この Mac で動かない文字起こし（#18753）", () => {
  const queue = [SOURCE_STEP_ID, "minutes"];
  const reason = (settings: ReturnType<typeof defaultSettings>, unsupported: "os" | "engine") =>
    runSetupReason({ queue, flow, settings, statuses: { providers: {}, speech: { ...speech, available: false, unsupported } } });

  it("音声認識を使えない Mac で「この Mac」なら、音声モデルより先に理由と代わりの手段を返す", () => {
    expect(reason(defaultSettings(), "engine")).toBe("この Mac では音声認識を使えません。Gemini を登録するか、Deepgram を既定のエンジンに選ぶと実行できます");
  });

  afterEach(() => rememberSpeechSupport(null));

  it("再確認が失敗しても（確かめられなかった）、覚えている「動かない」結果の理由を消さない。まだ確かめていないときは止めない", () => {
    const settings = defaultSettings();
    const statusWith = (value: null | undefined) => ({ queue, flow, settings, statuses: { providers: {}, speech: value } });
    expect(runSetupReason(statusWith(null))).toBeNull();
    expect(runSetupReason(statusWith(undefined))).toBeNull();
    rememberSpeechSupport("engine");
    const expected = "この Mac では音声認識を使えません。Gemini を登録するか、Deepgram を既定のエンジンに選ぶと実行できます";
    expect(runSetupReason(statusWith(null))).toBe(expected);
    expect(runSetupReason(statusWith(undefined))).toBe(expected);
    // 確かめた結果が「動く」なら、前に覚えていた結果ではなく今の結果に従う
    expect(runSetupReason({ queue, flow, settings, statuses: { providers: {}, speech: { ...speech, available: true } } })).not.toBe(expected);
    // 代わりの手段（Gemini の登録）があれば、覚えている結果でも止めない
    expect(runSetupReason({ ...statusWith(null), settings: addProvider(settings, "gemini") })).toBeNull();
  });

  it("Gemini を登録していれば音声認識が無くても止めない。macOS 26 より前なら Gemini も音声を準備できないので止める", () => {
    const settings = addProvider(defaultSettings(), "gemini");
    expect(reason(settings, "engine")).toBeNull();
    expect(reason(settings, "os")).toBe("この macOS では音声を処理できません。Deepgram を登録して既定のエンジンに選ぶと実行できます");
  });

  it("Deepgram は文字起こしの部品を使わないので、macOS 26 より前でも止めない（従量課金なので選んだときだけ）。文章の録音も止めない", () => {
    // モデルの方式はサブスクリプションのまま Deepgram を登録できる。登録しただけでは自動で使わず、理由を出す
    const registered = setDeepgram(defaultSettings(), true);
    expect(reason(registered, "os")).toBe("この macOS では音声を処理できません。Deepgram を登録して既定のエンジンに選ぶと実行できます");
    expect(reason(setEngine(registered, "deepgram"), "os")).toBeNull();
    // API キー方式でも同じ（方式はエンジンに効かない）
    const apiKey = setEngine(setDeepgram(addProvider(setConnection(defaultSettings(), "apiKey"), "claude"), true), "deepgram");
    expect(reason(apiKey, "os")).toBeNull();
    const textQueue = rerunQueueOf(completedView({ kind: "text" } as never));
    expect(runSetupReason({ queue: textQueue, flow, settings: defaultSettings(), statuses: { providers: {}, speech: { ...speech, available: false, unsupported: "engine" } } })).toBeNull();
  });
});

describe("サブスクリプションの Gemini の文字起こし（モデルの方式に依らない。owner 2026-10-19）", () => {
  const cli = {
    installed: true,
    authenticated: false,
    version: "1.4.0",
    login_method: null,
    reason: "auth_required",
    missing_cli_flags: [],
    models: [],
    capabilities: { resume: true, effort: true, tools_off_proven: true },
  };

  it("モデルの方式が API キーでも、Antigravity CLI が未ログインなら文字起こしの前に理由を出す", () => {
    const settings = setConnection(addProvider(defaultSettings(), "gemini"), "apiKey");
    expect(effectiveEngine(settings)).toBe("gemini-subscription");
    const statuses = { providers: { GeminiCli: cli }, speech: { ...speech, needsDownload: false } } as never;
    expect(runSetupReason({ queue: [SOURCE_STEP_ID], flow, settings, statuses })).toBe("Antigravity CLI にログインすると実行できます");
    // ログイン済みなら止めない
    const ready = { providers: { GeminiCli: { ...cli, authenticated: true, reason: null } }, speech: { ...speech, needsDownload: false } } as never;
    expect(runSetupReason({ queue: [SOURCE_STEP_ID], flow, settings, statuses: ready })).toBeNull();
  });
});
