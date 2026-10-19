import { describe, expect, it } from "vitest";
import {
  FLOW_TEMPLATES,
  ROOT_RECORDING_ID,
  basisFor,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  recordingInfo,
  rootRecording,
  type PageEntry,
  type Project,
} from "@niho/docs-core";
import { runBlockedReason } from "../src/lib/run-state";
import { formatAudioLength, formatChars, formatDuration, formatElapsed, formatSendAmount, formatTokensShort } from "../src/lib/format";
import { fileStem } from "../src/lib/names";
import { buildRecordingView, hasMaterial, openProjectOf, recordingProgress, versionsOf } from "../src/lib/project-view";
import { activeProfiles, activeProviders, defaultSettings, normalizeSettings } from "../src/lib/settings";
import { summarizeUsage } from "../src/components/Settings";

// Markdown の往復・保存の形・逐次表示のテストは packages/docs-ui/src/editor/markdown.test.ts（Mac と Web の引数の両方で確かめる。#18876）

describe("names", () => {
  it("区切り文字を全角にし、Finder で読める名前のままにする", () => {
    expect(fileStem("運営会議 10/07")).toBe("運営会議 10／07");
    expect(fileStem("a:b\\c")).toBe("a：b＼c");
    expect(fileStem(" .隠し\n名前 ")).toBe("隠し 名前");
    expect(fileStem("   ")).toBe("無題");
    expect([...fileStem("あ".repeat(150))].length).toBe(100);
  });
});

describe("format", () => {
  it("字数・送る量・所要・音声の長さ・トークン", () => {
    expect(formatChars(31240)).toBe("31,240 字");
    expect(formatSendAmount(31240)).toBe("約 3.1 万字");
    expect(formatSendAmount(2480)).toBe("約 2,480 字");
    expect(formatDuration(134_000)).toBe("2 分 14 秒");
    expect(formatDuration(48_000)).toBe("48 秒");
    expect(formatDuration(3_720_000)).toBe("1 時間 2 分");
    expect(formatElapsed(41_500)).toBe("0:41");
    expect(formatAudioLength(4354.2)).toBe("1:12:34");
    expect(formatAudioLength(2892)).toBe("48:12");
    expect(formatTokensShort(422_000)).toBe("422k");
    expect(formatTokensShort(980)).toBe("980");
  });
});

describe("settings", () => {
  it("形の合わない設定は既定に戻し、既定のプロファイルを欠かさない", () => {
    expect(normalizeSettings(null)).toEqual(defaultSettings());
    const settings = normalizeSettings({
      profiles: [{ id: "standard", name: "標準", models: { claude: { model: "opus", effort: "max" } } }, { id: "x" }],
      transcription: { language: "en" },
      docsRoot: "relative/path",
    });
    expect(activeProfiles(settings).map((profile) => profile.id)).toEqual(["standard", "advanced", "light"]);
    expect(activeProfiles(settings)[0]?.models.claude).toEqual({ model: "opus", effort: "max" });
    expect(settings.transcription.language).toBe("en");
    expect(settings.docsRoot).toBeNull();
    expect(activeProviders(settings)).toEqual(["claude"]);
    expect(settings.cliPaths).toBeUndefined();
  });

  it("CLI の場所の上書き（cliPaths）は保存し直しても残す（絶対パスだけ）", () => {
    const settings = normalizeSettings({ cliPaths: { claude: "/opt/tools/claude", gpt: "codex", other: "/x" } });
    expect(settings.cliPaths).toEqual({ claude: "/opt/tools/claude" });
    expect(normalizeSettings({ cliPaths: { gpt: 3 } }).cliPaths).toBeUndefined();
  });
});

describe("project-view", () => {
  const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
  const snapshot = createFlowSnapshot(flow, defaultProfiles(), ["claude"]);
  const [minutes, summary] = flow.steps.map((step) => step.id) as [string, string];
  const project: Project = {
    version: 1,
    id: "p8k2m4xq",
    name: "運営会議 10/07",
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot: snapshot,
    info: { speakers: "4plus", language: "ja", terms: [], background: "" },
    source: { kind: "text" },
  };

  const root: PageEntry = { id: ROOT_RECORDING_ID, kind: "rec", title: "", createdAt: project.createdAt };
  const loaded = (fields: { transcript: string | null; artifacts: Record<string, string>; runs: Parameters<typeof buildRecordingView>[2]["runs"] }) => ({
    projectId: project.id,
    id: ROOT_RECORDING_ID,
    recording: null,
    unversioned: [],
    missingInputs: [],
    ...fields,
  });

  it("成果物は工程 id で引き、前提の記録で stale を出す", () => {
    const artifacts = { [minutes]: "議事録の本文" };
    const basis = basisFor(snapshot, 1, { source: "本文", artifacts, info: recordingInfo(project, rootRecording(project)!) });
    const view = buildRecordingView(
      project,
      root,
      loaded({
        transcript: "本文",
        artifacts: { [minutes]: "議事録の本文（直した）", [summary]: "要約" },
        runs: [{ id: "r1", kind: "run", at: "2026-10-15T00:00:00.000Z", stepId: summary, stepName: "共有用の要約", version: 1, result: "saved", basis }],
      }),
    );
    expect(view.key).toBe("p8k2m4xq/root");
    expect([view.projectId, view.recordingId]).toEqual(["p8k2m4xq", "root"]);
    expect(view.sourceName).toBe("文章");
    expect(view.artifacts[minutes]).toBe("議事録の本文（直した）");
    expect(view.plan.plan).toBe("continuous");
    expect(view.plan.steps.map((step) => [step.done, step.stale])).toEqual([
      [true, false],
      [true, false],
      [true, true],
    ]);
    expect(versionsOf(view.runs, summary).map((run) => run.version)).toEqual([1]);
    expect(recordingProgress(rootRecording(project)!, true, [minutes])).toEqual({ done: 2, total: 3 });
  });

  it("録音は自分の snapshot（作成時のフロー＋解決済みのモデル）を使う", () => {
    const view = buildRecordingView(project, root, loaded({ transcript: null, artifacts: {}, runs: [] }));
    expect(view.flow).toBe(snapshot);
    expect(view.flow.revision).toBe(1);
    expect(view.flow.models[minutes]).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-6",
      effort: "high",
      profileId: "standard",
      profileName: "標準",
      connection: "subscription",
    });
    // 文章の録音は素材がある。音声 0 本で文字起こしも無い録音は素材が無い
    expect(hasMaterial(view)).toBe(false);
    expect(hasMaterial({ ...view, source: "本文" })).toBe(true);
  });

  it("開いた案件: 今の案件は root の録音 1 枚、ページの案件は読めたページだけを pages の順に", () => {
    const legacy = openProjectOf({
      id: project.id,
      project,
      recordings: [{ id: ROOT_RECORDING_ID, recording: null, hasTranscript: true, artifacts: [minutes] }],
      docs: [],
    });
    expect(legacy.pages).toEqual([{ ...root, recordingId: ROOT_RECORDING_ID }]);
    expect(legacy.recordings.root?.recording.flowSnapshot).toBe(snapshot);
    const paged: Project = {
      ...project,
      flowSnapshot: undefined,
      source: undefined,
      pages: [
        { id: "doc1", kind: "doc", title: "事前メモ", createdAt: "" },
        { id: "rec1", kind: "rec", title: "", createdAt: "" },
        { id: "rec2", kind: "rec", title: "読めない", createdAt: "" },
      ],
    };
    const recording = { ...rootRecording(project)!, id: "rec1" };
    const opened = openProjectOf({
      id: project.id,
      project: paged,
      recordings: [{ id: "rec1", recording, hasTranscript: false, artifacts: [] }],
      docs: [{ id: "doc1", updatedMs: 5 }],
    });
    expect(opened.pages.map((page) => page.id)).toEqual(["doc1", "rec1"]);
    expect(opened.docUpdatedMs).toEqual({ doc1: 5 });
    expect(opened.recordings.rec1?.recording.id).toBe("rec1");
  });
});

describe("usage", () => {
  it("今月の実行だけを AI ごとに数える", () => {
    const month = new Date("2026-10-15T00:00:00");
    const usage = summarizeUsage(
      [
        { id: "1", kind: "run", at: "2026-10-02T00:00:00", stepId: "a", stepName: "a", version: 1, result: "saved", provider: "claude", inputTokens: 1000, outputTokens: 200, durationMs: 60_000 },
        { id: "2", kind: "run", at: "2026-10-03T00:00:00", stepId: "source", stepName: "文字起こし", version: 1, result: "saved", provider: "this-mac", durationMs: 30_000, audioSec: 3600 },
        { id: "3", kind: "save", at: "2026-10-03T00:00:00", stepId: "a", stepName: "a", version: 2, result: "saved" },
        { id: "4", kind: "run", at: "2026-09-30T00:00:00", stepId: "a", stepName: "a", version: null, result: "failed", provider: "claude" },
      ],
      month,
    );
    // サブスクリプションの見込み金額は出さない（null）
    expect(usage.providers.claude).toEqual({ runs: 1, tokenRuns: 1, input: 1000, output: 200, durationMs: 60_000, audioSec: 0, costUsd: null, meteredRuns: 0, models: [] });
    expect(usage.speech).toMatchObject({ runs: 1, audioSec: 3600, models: [], meteredRuns: 0 });
  });

  it("文字起こしはエンジンの方式に依らず数え、見込み金額は従量課金（API キー）の記録だけを足す（owner 2026-10-19）", () => {
    const month = new Date("2026-10-15T00:00:00");
    const usage = summarizeUsage(
      [
        // モデルの方式（サブスクリプション）と同じ記録と、違う方式の記録（Deepgram・API キーの Gemini）
        { id: "1", kind: "run", at: "2026-10-02T00:00:00", stepId: "source", stepName: "文字起こし", version: 1, result: "saved", provider: "gemini", connection: "subscription", audioSec: 600 },
        { id: "2", kind: "run", at: "2026-10-03T00:00:00", stepId: "source", stepName: "文字起こし", version: 2, result: "saved", provider: "deepgram", connection: "apiKey", model: "nova-3", audioSec: 3600, keyterms: 2 },
        { id: "3", kind: "run", at: "2026-10-04T00:00:00", stepId: "source", stepName: "文字起こし", version: 3, result: "saved", provider: "this-mac", connection: "subscription", audioSec: 60 },
        // AI の行はモデルの方式の記録だけ
        { id: "4", kind: "run", at: "2026-10-05T00:00:00", stepId: "a", stepName: "a", version: 1, result: "saved", provider: "claude", connection: "apiKey", inputTokens: 10, outputTokens: 1 },
      ],
      month,
      "subscription",
    );
    expect(usage.speech).toMatchObject({ runs: 3, audioSec: 4260, meteredRuns: 1 });
    // Deepgram（60 分・Keyterm あり）だけを足す: 60 × (0.0043 + 0.0013)
    expect(usage.speech.costUsd).toBeCloseTo(60 * 0.0056, 6);
    expect(usage.providers.claude.runs).toBe(0);
    // 従量課金の記録で金額が出せなければ「取得できません」（推測しない）
    const unknown = summarizeUsage(
      [{ id: "5", kind: "run", at: "2026-10-06T00:00:00", stepId: "source", stepName: "文字起こし", version: 1, result: "saved", provider: "gemini", connection: "apiKey" }],
      month,
      "subscription",
    );
    expect(unknown.speech).toMatchObject({ runs: 1, meteredRuns: 1, costUsd: null });
  });

  it("提供元がトークン数を返さなかった実行は数えない（推測しない）", () => {
    const usage = summarizeUsage(
      [{ id: "1", kind: "run", at: "2026-10-02T00:00:00", stepId: "a", stepName: "a", version: null, result: "stopped", provider: "claude", inputTokens: 0, outputTokens: 0, tokensKnown: false }],
      new Date("2026-10-15T00:00:00"),
    );
    expect(usage.providers.claude).toMatchObject({ runs: 1, tokenRuns: 0, input: 0, output: 0 });
  });
});

describe("runBlockedReason", () => {
  const projects = [
    { id: "a", project: { name: "朝市 インタビュー" } },
    { id: "b", project: { name: "港の座談会" } },
  ];
  it("ほかのフォルダの実行中だけ、そのフォルダの名前で理由を返す", () => {
    expect(runBlockedReason(null, "a", projects)).toBeNull();
    expect(runBlockedReason({ projectId: "a" }, "a", projects)).toBeNull();
    expect(runBlockedReason({ projectId: "a" }, "b", projects)).toBe("「朝市 インタビュー」の実行が終わると実行できます。");
    // 一覧に無い（読み込み前など）ときは名前を出さない
    expect(runBlockedReason({ projectId: "z" }, "b", projects)).toBe("ほかのフォルダの実行が終わると実行できます。");
  });
});
