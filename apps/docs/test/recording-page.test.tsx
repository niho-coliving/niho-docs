// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import type { Editor } from "@tiptap/react";
import {
  FLOW_CHOICE_LABEL,
  FLOW_TEMPLATES,
  LANGUAGES,
  NIHO_API_MODEL_SWAP_NOTE,
  RECORDING_FIELD_LABELS,
  SOURCE_STEP_ID,
  SPEAKER_MODES,
  countChars,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  languageLabel,
  speakerLabel,
  type Flow,
  type Project,
  type Recording,
  type RunRecord,
  remoteRunAcceptedLabel,
} from "@niho/docs-core";
import { cursorToEnd, flush, typeText } from "./block-editor-helpers";
import { button, click, renderApp, selectOption, typeInto, type Screen } from "./dom";
import { activeCloud, FakeBridge, done, recordingView } from "./fake-bridge";
import { defaultSettings, normalizeSettings, type AppSettings } from "../src/lib/settings";
import { transcriptImportFromFile } from "../src/components/RecordingPage";
import type { PersonalOpenRequest } from "../src/lib/bridge";
import { addPage, exportFromMenu, newFromMenu, openAudio, openPageMenu, pageMenuButton, pageMenuItems, railChildren, railCurrent, railItem, railPages, rebuild, rebuildItem, seedRun, shownVersion, titleInput, until, seedText } from "./pages";

/**
 * フォルダの音声（背景情報のページの「音声」。#18566 P3・#18914）と成果物の子ページ: props の表（話者人数・言語・工程）
 * 同じフォルダの独立文書を工程の入力に・成果物の子ページ（タイトル＋メタ行・上の帯の履歴・書き出し・自動の版）・音声の削除・文書のページの「/」。
 */

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

/** 事前メモの本文（Markdown のまま工程の入力に入る）。 */
const MEMO = "## 聞きたいこと\n\n- 今いちばん困っていること\n";

function minutesFlow(): Flow {
  return createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
}

/** 新しい形の案件（pages を持ち、root の録音は無い）。 */
function pagedProject(name: string, info: Project["info"] = { terms: [], background: "" }): Project {
  return { version: 1, id: "", name, createdAt: "2026-10-16T00:00:00.000Z", info, pages: [] };
}

/** 今の形の案件（pages の無い project.json。root の録音の話者人数・言語は info）。 */
function legacyProject(flow: Flow, name = "朝市 インタビュー"): Project {
  return {
    version: 1,
    id: "",
    name,
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    info: { speakers: "2", language: "ja", terms: [], background: "" },
    source: { kind: "text" },
  };
}

function newRecording(flow: Flow, fields: Partial<Recording> = {}): Recording {
  return {
    version: 1,
    id: "",
    createdAt: "2026-10-16T01:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    source: { kind: "audio", audio: [] },
    speakers: "auto",
    language: "ja",
    refs: [],
    ...fields,
  };
}

function saveRecord(id: string): RunRecord {
  return { id, kind: "save", at: "2026-10-16T01:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" };
}

/** 事前メモ（文書のページ）のある新しい形の案件。 */
async function coachingProject(bridge: FakeBridge) {
  const project = await bridge.createProject(pagedProject("佐藤さん コーチング", { terms: [], background: "月 1 回のコーチング" }), null, null, []);
  const memo = await bridge.createPage(project.id, { kind: "doc", title: "事前メモ", createdAt: "2026-10-16T00:00:00.000Z" });
  await bridge.writePage(project.id, memo.id, MEMO);
  return { project, memo, stored: bridge.projects.get(project.id)! };
}

/** 文章を貼った録音のページを足す（id を返す）。 */
async function textRecording(bridge: FakeBridge, projectId: string, flow: Flow, title: string, text: string): Promise<string> {
  const entry = await bridge.createPage(projectId, { kind: "rec", title, createdAt: "2026-10-16T01:00:00.000Z", recording: newRecording(flow) });
  await bridge.setRecordingText({ projectId, recordingId: entry.id }, text, saveRecord(`save-${entry.id}`));
  return entry.id;
}

/** 本文のエディタ（文書のページ・成果物の子ページ。TipTap は DOM の要素に editor を置く）。 */
function bodyEditor(container: HTMLElement): Editor {
  const element = container.querySelector(".pbody .ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  if (!element?.editor) throw new Error("editor not found");
  return element.editor;
}

/** エディタの末尾に打つ（「/」のメニューは打った文字で開く）。 */
async function typeAtEnd(editor: Editor, text: string) {
  await act(async () => {
    cursorToEnd(editor);
    typeText(editor, text);
    await flush();
  });
}

async function pressKey(editor: Editor, key: string) {
  await act(async () => {
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await flush();
  });
}

function slashOptions(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".be-slash [role='option'] .n")].map((option) => option.textContent ?? "");
}

function meta(container: HTMLElement): string {
  return container.querySelector(".pmeta")?.textContent ?? "";
}

/** タイトルバーの右端（開いているページの操作）。 */
function top(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".window-titlebar .acts")!;
}

function dialog(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="dialog"]');
}

const SPEECH_READY = { found: true, fake: false, available: true, needsDownload: false, engine: "apple", error: null, notice: null, diarization: { state: "ready", detail: null } } as const;

type Continuation = AppSettings["personalExecution"]["continuation"];

/**
 * 経路を確かめる録音（#18947）: audio は文字起こし前の音声、text は確定した原文（貼った文章）の録音。何をするかはページのボタン、
 * 続きをどこで作るかは設定（`continuation`）。
 */
async function routedRecording(
  kind: "audio" | "text",
  continuation: Continuation = "this_pc",
  beforeRender?: (bridge: FakeBridge, ids: { projectId: string; recordingId: string }) => void | Promise<void>,
) {
  const bridge = new FakeBridge();
  const flow = minutesFlow();
  bridge.flow = flow;
  bridge.settings = { ...defaultSettings(), personalExecution: { continuation } };
  const { project } = await coachingProject(bridge);
  let recordingId: string;
  if (kind === "audio") {
    const entry = await bridge.createPage(project.id, {
      kind: "rec",
      title: "経路テスト",
      createdAt: "2026-10-16T01:00:00.000Z",
      recording: newRecording(flow, { source: { kind: "audio", audio: [{ file: "a1.m4a", hash: "0".repeat(64), name: "音声.m4a", durationSec: 30 }] } }),
    });
    recordingId = entry.id;
    bridge.speechStatus = async () => SPEECH_READY;
    bridge.transcribeResult = [{ jsonl: '{"type":"segment","start":1,"end":3,"text":"経路の原文"}\n', durationSec: 30 }];
  } else {
    recordingId = await textRecording(bridge, project.id, flow, "経路テスト", "確定した原文");
  }
  const stored = bridge.recording(project.id, recordingId);
  bridge.turnScript = (request) => [done(`${request.model} の成果物`, "EndTurn", "s1", request.model)];
  if (continuation === "niho_api") {
    bridge.personalNihoAccessResult = { ...bridge.personalNihoAccessResult, consentVersion: "2026-10-16-v1" };
    const sourceRow = stored.runs.find((run) => run.stepId === SOURCE_STEP_ID);
    if (sourceRow) sourceRow.versionPath = `recordings/${recordingId}/versions/source/v_1234567890123456789012.md`;
    for (const step of flow.steps) {
      stored.recording.flowSnapshot.models[step.id] = {
        provider: "claude", model: "claude-sonnet-5", effort: "high", profileId: "standard", profileName: "標準", connection: "subscription",
      };
    }
  }
  await beforeRender?.(bridge, { projectId: project.id, recordingId });
  const rendered = await renderApp(bridge);
  await openAudio(rendered.container, "佐藤さん コーチング");
  expect(normalizeSettings(bridge.settings).personalExecution.continuation).toBe(continuation);
  return { bridge, stored, flow, rendered };
}

/** 始めた実行の経路（Native の operation を開いた順）。 */
function openedRoutes(bridge: FakeBridge): PersonalOpenRequest["route"][] {
  return bridge.personalCalls.filter((call) => call.name === "personalOpen").map((call) => (call.args[0] as PersonalOpenRequest).route);
}

function runbar(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".runbar")!;
}

/** 実行の帯のボタンの並び（左から）。 */
function runbarButtons(container: HTMLElement): string[] {
  return [...runbar(container).querySelectorAll("button")].map((candidate) => candidate.textContent ?? "");
}

describe("録音のページの始め方（何をするかはボタン、どこでやるかは設定。#18947）", () => {
  it("VTT原本を取り込み、文字起こしなし工程ではASRを使わず後工程から始める", async () => {
    const bridge = new FakeBridge();
    const flow: Flow = { ...minutesFlow(), name: "VTTからインサイト", transcription: false };
    bridge.flow = flow;
    const { project } = await coachingProject(bridge);
    const entry = await bridge.createPage(project.id, {
      kind: "rec",
      title: "既存の文字起こし",
      createdAt: "2026-10-16T01:00:00.000Z",
      recording: newRecording(flow),
    });
    const stored = bridge.recording(project.id, entry.id);
    const storeTranscript = bridge.importTranscript.bind(bridge);
    let failImport = true;
    bridge.importTranscript = async (rec, transcript, record) => {
      if (failImport) throw { code: "store_io", message: "VTT原本を保存できませんでした。" };
      await storeTranscript(rec, transcript, record);
    };
    bridge.turnScript = (request) => [done(`${request.model} の成果物`, "EndTurn", "s1", request.model)];
    screen = await renderApp(bridge);
    const { container } = screen;
    await openAudio(container, "佐藤さん コーチング");

    expect(button(container, "VTTを取り込む")).not.toBeNull();
    expect(button(container, "文書作成を開始").disabled).toBe(true);
    expect(runbarButtons(container)).toEqual(["文書作成を開始"]);
    expect(container.textContent).toContain("VTTファイルを取り込んでください");

    const raw = "\uFEFFWEBVTT\r\n\r\ncue-a\r\n00:00:01.250 --> 00:00:02.500\r\n<v Recorder>そのままの話者です</v>\r\n";
    const file = new File([raw], "interview.vtt", { type: "text/vtt" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(raw).buffer });
    const parsed = await transcriptImportFromFile(file);
    const input = container.querySelector<HTMLInputElement>('[aria-label="VTTファイルを選択"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await until(() => container.textContent?.includes("VTT原本を保存できませんでした。") ?? false);
    expect(stored.recording.source).toEqual({ kind: "audio", audio: [] });
    expect(stored.transcript).toBeNull();
    expect(bridge.transcriptOriginals.size).toBe(0);

    failImport = false;
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await until(() => stored.recording.source.kind === "text");

    expect(bridge.transcriptOriginals.get(`${project.id}/${entry.id}`)).toBe(parsed.originalBase64);
    expect(stored.transcript).toBe(parsed.markdown);
    expect(stored.recording.source).toMatchObject({
      kind: "text",
      transcriptImport: { format: "vtt", file: "source.vtt", name: "interview.vtt" },
    });
    expect(container.querySelector(".afile .nm")?.textContent).toContain("文字起こし · interview.vtt");
    await until(() => runbarButtons(container).includes("続きを作成"));
    expect(runbarButtons(container)).toEqual(["設定で変更", "続きを作成"]);

    await click(button(container, "続きを作成"));
    await until(() => bridge.turnRequests.length === flow.steps.length);
    await until(() => bridge.locks.size === 0);
    expect(bridge.transcribeLanguages).toEqual([]);
    expect(stored.versions[SOURCE_STEP_ID]).toHaveLength(1);
  });

  it("原文がまだ無い録音は「文書作成を開始」と控えめな「文字起こしだけ実施する」を出し、実行方法のプルダウンと AI・実行場所の表は無い", async () => {
    const setup = await routedRecording("audio");
    screen = setup.rendered;
    const { container } = screen;
    expect(container.querySelector("#personal-execution-route")).toBeNull();
    expect(container.querySelector(".execution-facts")).toBeNull();
    expect(container.textContent).not.toContain("実行方法");
    expect(runbarButtons(container)).toEqual(["設定で変更", "文字起こしだけ実施する", "文書作成を開始"]);
    expect(button(runbar(container), "文書作成を開始").className).toContain("primary");
    expect(button(runbar(container), "文字起こしだけ実施する").className).toContain("link");
    // 場所はページでは選ばせず 1 行だけ（「続き」の語は原文ができた後だけ）
    expect(runbar(container).querySelector(".note")?.textContent).toBe("この Mac で作ります設定で変更");
    expect(runbar(container).textContent).not.toContain("続き");
    // 「設定で変更」は設定の「続き」へ
    await click(button(runbar(container), "設定で変更"));
    expect(container.querySelector('[aria-label="残りの工程"]')).not.toBeNull();
  });

  it("「文書作成を開始」は文字起こしから全工程をこの Mac で作る", async () => {
    const setup = await routedRecording("audio");
    screen = setup.rendered;
    await click(button(screen.container, "文書作成を開始"));
    await until(() => (setup.stored.versions[setup.flow.steps.at(-1)!.id]?.length ?? 0) === 1);
    expect(openedRoutes(setup.bridge)).toEqual([{ kind: "local_full" }]);
    expect(setup.bridge.transcribeLanguages).toEqual(["ja"]);
    expect(setup.bridge.turnRequests).toHaveLength(setup.flow.steps.length);
  });

  it("「文字起こしだけ実施する」は後続を呼ばず原文だけ作る。その後は「続きを作成」だけを出し、押すと文字起こしをやり直さずこの Mac で続ける", async () => {
    const setup = await routedRecording("audio");
    screen = setup.rendered;
    const { container } = screen;
    await click(button(container, "文字起こしだけ実施する"));
    await until(() => setup.stored.transcript?.includes("経路の原文") ?? false);
    await until(() => setup.bridge.locks.size === 0);
    expect(setup.bridge.turnRequests).toHaveLength(0);
    expect(openedRoutes(setup.bridge)).toEqual([{ kind: "local_transcription_only" }]);
    await until(() => runbarButtons(container).includes("続きを作成"));
    expect(runbarButtons(container)).toEqual(["設定で変更", "続きを作成"]);
    expect(runbar(container).querySelector(".note")?.textContent).toBe("続きはこの Mac で作ります設定で変更");
    await click(button(runbar(container), "続きを作成"));
    await until(() => setup.bridge.turnRequests.length === setup.flow.steps.length);
    await until(() => setup.bridge.locks.size === 0);
    expect(openedRoutes(setup.bridge)).toEqual([{ kind: "local_transcription_only" }, { kind: "generation_only", executor: "this_pc" }]);
    expect(setup.bridge.transcribeLanguages).toEqual(["ja"]);
    expect(setup.stored.versions[SOURCE_STEP_ID]).toHaveLength(1);
  });

  it("続きの AI の準備が無くても「文字起こしだけ実施する」は押せ、「文書作成を開始」は準備の理由で押せない", async () => {
    const setup = await routedRecording("audio", "this_pc", (bridge) => {
      bridge.statuses.ClaudeCode = { ...bridge.statuses.ClaudeCode, installed: false };
    });
    screen = setup.rendered;
    const { container } = screen;
    expect(button(container, "文書作成を開始").disabled).toBe(true);
    expect(button(container, "文字起こしだけ実施する").disabled).toBe(false);
    // 理由は場所の 1 行の位置に 1 つ（設定への導線つき）
    expect(runbar(container).querySelector(".note.setup")).not.toBeNull();
    expect(runbar(container).textContent).not.toContain("この Mac で作ります");
    await click(button(container, "文字起こしだけ実施する"));
    await until(() => setup.stored.transcript?.includes("経路の原文") ?? false);
    expect(setup.bridge.turnRequests).toHaveLength(0);
  });

  it("素材が無いうちは同じ 2 つのボタンを押せない形で出し、理由を 1 つ出す", async () => {
    const bridge = new FakeBridge();
    const flow = minutesFlow();
    bridge.flow = flow;
    const { project } = await coachingProject(bridge);
    await bridge.createPage(project.id, { kind: "rec", title: "", createdAt: "2026-10-16T01:00:00.000Z", recording: newRecording(flow) });
    screen = await renderApp(bridge);
    const { container } = screen;
    await openAudio(container, "佐藤さん コーチング");
    expect(runbarButtons(container)).toEqual(["文字起こしだけ実施する", "文書作成を開始"]);
    expect(button(container, "文書作成を開始").disabled).toBe(true);
    expect(button(container, "文字起こしだけ実施する").disabled).toBe(true);
    expect(runbar(container).querySelector(".note")?.textContent).toBe("音声を入れると実行できます");
  });

  it("続きがクラウドなら、原文がある録音の「続きを作成」は この Mac の AI の準備を見ずにクラウドへ任せる", async () => {
    const setup = await routedRecording("text", "niho_api", (bridge) => {
      bridge.statuses.ClaudeCode = { ...bridge.statuses.ClaudeCode, installed: false };
    });
    screen = setup.rendered;
    const { container } = screen;
    expect(runbar(container).querySelector(".note")?.textContent).toBe("続きはクラウドで作ります設定で変更");
    expect(button(container, "続きを作成").disabled).toBe(false);
    await click(button(container, "続きを作成"));
    await until(() => dialog(screen!.container)?.textContent?.includes("続きをクラウドで作りますか") ?? false);
    await click(button(dialog(container)!, "クラウドで作る"));
    await until(() => setup.bridge.personalNihoPosts.length === 1);
    expect(setup.bridge.turnRequests).toHaveLength(0);
  });

  it("続きがクラウドなら「文書作成を開始」はこの Mac で文字起こしだけ実施する作り、成功したら続けてクラウドの確認を出す", async () => {
    const setup = await routedRecording("audio", "niho_api");
    screen = setup.rendered;
    const { container } = screen;
    expect(runbar(container).querySelector(".note")?.textContent).toBe("文字起こしはこの Mac、続きはクラウドで作ります設定で変更");
    expect(button(container, "文書作成を開始").disabled).toBe(false);
    await click(button(container, "文書作成を開始"));
    await until(() => dialog(screen!.container)?.textContent?.includes("続きをクラウドで作りますか") ?? false);
    expect(setup.bridge.transcribeLanguages).toEqual(["ja"]);
    expect(openedRoutes(setup.bridge)).toEqual([{ kind: "local_transcription_only" }, { kind: "generation_only", executor: "niho_api" }]);
    expect(dialog(container)?.textContent).toContain("クラウドで続きを作ります");
    expect(dialog(container)?.textContent).not.toContain("費用");
    await click(button(dialog(container)!, "クラウドで作る"));
    await until(() => setup.bridge.personalNihoPosts.length === 1);
    await until(() => setup.bridge.locks.size === 0);
    expect(setup.bridge.turnRequests).toHaveLength(0);
    // 続きは 1 回だけ（受け付けた後に、もう一度始めない）
    expect(openedRoutes(setup.bridge)).toHaveLength(2);
  });

  it("続きがクラウドでも、文字起こしが失敗した・止めたときは続きへ進まない", async () => {
    const failed = await routedRecording("audio", "niho_api");
    screen = failed.rendered;
    failed.bridge.transcribeResult = { code: "speech_failed", message: "文字起こしできませんでした。" };
    await click(button(screen.container, "文書作成を開始"));
    await until(() => failed.bridge.locks.size === 0 && runbarButtons(screen!.container).includes("文書作成を開始"));
    expect(openedRoutes(failed.bridge)).toEqual([{ kind: "local_transcription_only" }]);
    expect(dialog(screen.container)).toBeNull();
    expect(failed.bridge.personalNihoPosts).toHaveLength(0);
    screen.unmount();

    const stopped = await routedRecording("audio", "niho_api");
    screen = stopped.rendered;
    let release!: () => void;
    stopped.bridge.transcribeGate = new Promise<void>((resolve) => { release = resolve; });
    await click(button(screen.container, "文書作成を開始"));
    await click(button(screen.container, "止める"));
    release();
    await until(() => stopped.bridge.locks.size === 0 && runbarButtons(screen!.container).includes("文書作成を開始"));
    expect(openedRoutes(stopped.bridge)).toEqual([{ kind: "local_transcription_only" }]);
    expect(dialog(screen.container)).toBeNull();
    expect(stopped.bridge.personalNihoPosts).toHaveLength(0);
  });

  it("続きがこの Mac なら、確定原文を使い文字起こし 0 回で後続だけ実行する", async () => {
    const setup = await routedRecording("text");
    screen = setup.rendered;
    expect(runbarButtons(screen.container)).toEqual(["設定で変更", "続きを作成"]);
    await click(button(screen.container, "続きを作成"));
    await until(() => setup.bridge.turnRequests.length === setup.flow.steps.length);
    expect(openedRoutes(setup.bridge)).toEqual([{ kind: "generation_only", executor: "this_pc" }]);
    expect(setup.bridge.transcribeLanguages).toEqual([]);
  });

  it("続きがクラウドなら最新条件の同意後に受付し、文字起こし・ローカル生成は0回", async () => {
    const setup = await routedRecording("text", "niho_api");
    screen = setup.rendered;
    expect(screen.container.textContent).toContain(NIHO_API_MODEL_SWAP_NOTE);
    await click(button(screen.container, "続きを作成"));
    await until(() => dialog(screen!.container)?.textContent?.includes("続きをクラウドで作りますか") ?? false);
    expect(dialog(screen.container)?.textContent).toContain("クラウドで続きを作ります");
    expect(dialog(screen.container)?.textContent).not.toContain("費用");
    expect(dialog(screen.container)?.textContent).toContain(NIHO_API_MODEL_SWAP_NOTE);
    expect(dialog(screen.container)?.textContent).toContain("AI: Gemini 3.8 Flash · 中");
    expect(dialog(screen.container)?.textContent).not.toContain("Claude Sonnet 5");
    await click(button(dialog(screen.container)!, "クラウドで作る"));
    await until(() => setup.bridge.personalNihoPosts.length === 1);
    // 残りの工程は NIHO の AI に持ち替えて書き、その工程で送る
    for (const step of setup.flow.steps) {
      expect(setup.stored.recording.flowSnapshot.models[step.id]).toMatchObject({ provider: "gemini", model: "gemini-3.8-flash", effort: "medium", profileName: "NIHO API", connection: "apiKey" });
    }
    expect(JSON.parse(setup.bridge.personalNihoPosts[0]!.body).steps.map((step: { provider: string }) => step.provider)).toEqual(setup.flow.steps.map(() => "gemini"));
    expect(setup.bridge.transcribeLanguages).toEqual([]);
    expect(setup.bridge.turnRequests).toHaveLength(0);
    // 受け付けた直後の知らせは docs-core の言葉（受付の状態 queued は「受付済み」だけで、別の言い方を続けない。#18902）
    expect(screen.container.textContent).toContain(remoteRunAcceptedLabel({ state: "queued" }));
    expect(screen.container.textContent).not.toContain("受付待ち");
  });

  it("途中まで作ったページがある録音は、続きがクラウドだと「続きを作成」を押せず、設定への導線つきの理由を出す", async () => {
    const setup = await routedRecording("text", "niho_api", (bridge, ids) =>
      seedRun(bridge, ids.projectId, minutesFlow().steps[0]!, "途中まで作ったページ", ids.recordingId).then(() => undefined),
    );
    screen = setup.rendered;
    expect(button(screen.container, "続きを作成").disabled).toBe(true);
    const note = runbar(screen.container).querySelector(".note.setup");
    expect(note?.textContent).toContain("クラウドでは作れません");
    expect(button(runbar(screen.container), "設定を開く")).toBeTruthy();
  });

  it("クラウドへの確認の表示中に同じ録音の別ページへ移ると、確認を取り消して送らずbusyを解放する", async () => {
    const setup = await routedRecording("text", "niho_api");
    screen = setup.rendered;
    await click(button(screen.container, "続きを作成"));
    await until(() => dialog(screen!.container)?.textContent?.includes("続きをクラウドで作りますか") ?? false);
    // 録音は同じまま（view.key が変わらない）で、原文の子ページ（レールのフォルダの直下）へ移る。
    await click(screen.container.querySelector<HTMLButtonElement>(".rail .trow.out .ti")!);
    await until(() => setup.bridge.locks.size === 0);
    // 確認の前に開いた Native の operation も閉じ、何も送らない。
    expect(setup.bridge.personalOps.size).toBe(0);
    expect(setup.bridge.personalNihoPosts).toHaveLength(0);
    expect(setup.bridge.turnRequests).toHaveLength(0);
  });

  it("クラウドの結果不明を完了にせず、照会・同一bytes/keyの明示再送・不在確認を別操作で出す", async () => {
    const setup = await routedRecording("text", "niho_api");
    screen = setup.rendered;
    setup.bridge.personalNihoPostResults.push("unknown");
    await click(button(screen.container, "続きを作成"));
    await until(() => dialog(screen!.container)?.textContent?.includes("続きをクラウドで作りますか") ?? false);
    await click(button(dialog(screen.container)!, "クラウドで作る"));
    await until(() => screen!.container.textContent?.includes("受付結果を確認できません") ?? false);
    expect(button(screen.container, "受付を照会")).toBeTruthy();
    expect(button(screen.container, "同じ内容で再送")).toBeTruthy();
    expect(button(screen.container, "未受付を確認")).toBeTruthy();
    const first = structuredClone(setup.bridge.personalNihoPosts[0]!);
    await click(button(screen.container, "同じ内容で再送"));
    await until(() => setup.bridge.personalNihoPosts.length === 2);
    expect(setup.bridge.personalNihoPosts[1]).toEqual(first);
    expect(screen.container.textContent).toContain("受付済み");
  });

  it("再送で見つかった run が実行前に入力変更で止まっていたら、その知らせを保ち、完了（今の本文を保った）と区別する", async () => {
    const setup = await routedRecording("text", "niho_api");
    screen = setup.rendered;
    setup.bridge.personalNihoPostResults.push("unknown");
    await click(button(screen.container, "続きを作成"));
    await until(() => dialog(screen!.container)?.textContent?.includes("続きをクラウドで作りますか") ?? false);
    await click(button(dialog(screen.container)!, "クラウドで作る"));
    await until(() => screen!.container.textContent?.includes("受付結果を確認できません") ?? false);
    setup.bridge.personalNihoNextRun = { state: "input_changed", reasonCode: "input_changed_before_execution" };
    await click(button(screen.container, "同じ内容で再送"));
    await until(() => setup.bridge.personalNihoPosts.length === 2);
    const expected = remoteRunAcceptedLabel({ state: "input_changed", reasonCode: "input_changed_before_execution" });
    expect(expected).toBe("受付済み · 入力が変わりました");
    expect(expected).not.toBe(remoteRunAcceptedLabel({ state: "completed", reasonCode: "input_revision_changed" }));
    await until(() => screen!.container.textContent?.includes(expected) ?? false);
  });

  it("最初のawait前にbusyを取り、二重クリックでもoperationと送信を1つにする", async () => {
    const setup = await routedRecording("text");
    screen = setup.rendered;
    let release!: () => void;
    setup.bridge.turnGate = new Promise<void>((resolve) => { release = resolve; });
    const run = button(screen.container, "続きを作成");
    await act(async () => { run.click(); run.click(); });
    await until(() => setup.bridge.turnRequests.length === 1);
    expect(setup.bridge.personalCalls.filter((call) => call.name === "personalOpen")).toHaveLength(1);
    release();
    await until(() => setup.bridge.locks.size === 0);
  });

  it("同期準備中の停止もAbortControllerからNative cancelへ届き、busyを必ず解放する", async () => {
    const setup = await routedRecording("text");
    screen = setup.rendered;
    let release!: () => void;
    setup.bridge.cloudProjectStatusGate = new Promise<void>((resolve) => { release = resolve; });
    await click(button(screen.container, "続きを作成"));
    await until(() => setup.bridge.personalCalls.some((call) => call.name === "personalOpen"));
    await click(button(screen.container, "止める"));
    release();
    await until(() => setup.bridge.locks.size === 0);
    expect(setup.bridge.personalCalls.some((call) => call.name === "personalCancel")).toBe(true);
    expect(setup.bridge.turnRequests).toHaveLength(0);
    expect(button(screen.container, "続きを作成").disabled).toBe(false);
  });

  it("単工程（作り直す）は、続きの場所がクラウドでもこの Mac で作り、文字起こしをやり直さない", async () => {
    const setup = await routedRecording("text");
    screen = setup.rendered;
    await click(button(screen.container, "続きを作成"));
    await until(() => setup.bridge.locks.size === 0);
    setup.bridge.turnRequests.length = 0;
    // 設定の「残りの工程」でクラウドを選ぶ
    await click(button(screen.container, "設定"));
    await click(button(screen.container.querySelector<HTMLElement>('[aria-label="残りの工程"]')!, "クラウド"));
    expect(normalizeSettings(setup.bridge.settings).personalExecution.continuation).toBe("niho_api");
    await openAudio(screen.container, "佐藤さん コーチング");
    await click(railItem(screen.container, setup.flow.steps[0]!.name));
    await rebuild(screen.container);
    await until(() => setup.bridge.locks.size === 0);
    expect(setup.bridge.turnRequests).toHaveLength(1);
    expect(setup.bridge.transcribeLanguages).toEqual([]);
    expect(openedRoutes(setup.bridge).at(-1)).toEqual({ kind: "generation_only", executor: "this_pc" });
    expect(setup.bridge.personalNihoPosts).toHaveLength(0);
  });

  it("編集した確定原文をflushしてから後続を固定し、古い原文を送らない", async () => {
    const setup = await routedRecording("text");
    screen = setup.rendered;
    await click(railItem(screen.container, "文章"));
    await until(() => bodyEditor(screen!.container).isEditable);
    await typeAtEnd(bodyEditor(screen.container), "\n\n編集して保存する確定原文");
    // 離れると書き残してから版にする（#18912 の leave）。背景情報のページ（フォルダの音声）へ移る
    await openAudio(screen.container, "佐藤さん コーチング");
    await until(() => (setup.stored.versions[SOURCE_STEP_ID]?.length ?? 0) === 2);
    await until(() => setup.stored.transcript?.includes("編集して保存する確定原文") ?? false);
    await click(button(screen.container, "続きを作成"));
    await until(() => setup.bridge.turnRequests.length > 0);
    expect(setup.bridge.turnRequests[0]!.user_prompt).toContain("編集して保存する確定原文");
  });

  it("書きかけのflushに失敗したら古い本文で続けずdispatch 0でbusyを解放する", async () => {
    const setup = await routedRecording("text");
    screen = setup.rendered;
    await click(button(screen.container, "続きを作成"));
    await until(() => setup.stored.artifacts[setup.flow.steps[0]!.id] !== undefined);
    setup.bridge.turnRequests.length = 0;
    await click(railItem(screen.container, setup.flow.steps[0]!.name));
    await until(() => bodyEditor(screen!.container).isEditable);
    await act(async () => {
      bodyEditor(screen!.container).commands.setContent("保存に失敗する成果物");
    });
    setup.bridge.saveArtifact = async () => { throw new Error("disk full"); };
    await rebuild(screen.container);
    await until(() => screen!.container.textContent?.includes("書きかけを保存できなかった") ?? false);
    expect(setup.bridge.turnRequests).toHaveLength(0);
    expect((await rebuildItem(screen.container)).disabled).toBe(false);
  });

  it("同じpage/ridでも本人・Root世代がA→B→Aと変わればoperationをcancelし、遅着結果を表示・適用しない", async () => {
    const setup = await routedRecording("text");
    screen = setup.rendered;
    let release!: () => void;
    setup.bridge.turnGate = new Promise<void>((resolve) => { release = resolve; });
    await click(button(screen.container, "続きを作成"));
    await until(() => setup.bridge.turnRequests.length === 1);
    await act(async () => {
      setup.bridge.switchPersonalAccount("c".repeat(64));
      setup.bridge.emitCloudState(activeCloud({ contextGeneration: 20, documentScopeId: "scope-b" }));
      setup.bridge.switchPersonalAccount("a".repeat(64));
      setup.bridge.emitCloudState(activeCloud({ contextGeneration: 21, documentScopeId: "scope-a" }));
    });
    release();
    await until(() => setup.bridge.locks.size === 0);
    expect(setup.bridge.personalCalls.some((call) => call.name === "personalCancel")).toBe(true);
    expect(setup.stored.artifacts[setup.flow.steps[0]!.id]).toBeUndefined();
    expect(screen.container.textContent).not.toContain("に完了");
  });

  it("クラウドの固定snapshot確認中に本人・Rootが変われば古い確認を破棄しdispatch 0で止める", async () => {
    const setup = await routedRecording("text", "niho_api");
    screen = setup.rendered;
    await click(button(screen.container, "続きを作成"));
    await until(() => dialog(screen!.container)?.textContent?.includes("続きをクラウドで作りますか") ?? false);
    await act(async () => {
      setup.bridge.switchPersonalAccount("c".repeat(64));
      setup.bridge.emitCloudState(activeCloud({ contextGeneration: 30, documentScopeId: "scope-other" }));
    });
    await until(() => dialog(screen!.container) === null);
    await until(() => setup.bridge.locks.size === 0);
    expect(setup.bridge.personalNihoPosts).toHaveLength(0);
    expect(setup.bridge.personalCalls.some((call) => call.name === "personalCancel")).toBe(true);
  });

  it("クラウドの確認後に録音の固定modelが変われば同意済みの入力として送らずdispatch 0で止める", async () => {
    const setup = await routedRecording("text", "niho_api");
    screen = setup.rendered;
    await click(button(screen.container, "続きを作成"));
    await until(() => dialog(screen!.container)?.textContent?.includes("続きをクラウドで作りますか") ?? false);
    const firstStep = setup.flow.steps[0]!.id;
    setup.stored.recording.flowSnapshot.models[firstStep] = {
      ...setup.stored.recording.flowSnapshot.models[firstStep]!,
      model: "claude-opus-5",
    };
    await click(button(dialog(screen.container)!, "クラウドで作る"));
    await until(() => setup.bridge.locks.size === 0);
    expect(setup.bridge.personalNihoPosts).toHaveLength(0);
    expect(screen.container.textContent).toContain("もう一度実行してください");
  });
});

describe("同じフォルダの独立文書を工程の入力に", () => {
  it("参考文書が上限を超えても録音を開けて、実行の理由を表示する", async () => {
    const bridge = new FakeBridge();
    const flow = minutesFlow();
    bridge.flow = flow;
    const project = await bridge.createProject(pagedProject("文書上限"), null, null, []);
    for (let index = 0; index < 65; index += 1) {
      const page = await bridge.createPage(project.id, { kind: "doc", title: `参考 ${index + 1}`, createdAt: "2026-10-16T00:00:00.000Z" });
      await bridge.writePage(project.id, page.id, `本文 ${index + 1}`);
    }
    await textRecording(bridge, project.id, flow, "第1回", "確定した本文");
    screen = await renderApp(bridge);
    await openAudio(screen.container, project.name);

    expect(railCurrent(screen.container)).toBe("背景情報");
    expect(runbar(screen.container).textContent).toContain("同じフォルダの文書が64件を超えているため");
    expect(button(runbar(screen.container), "続きを作成").disabled).toBe(true);
  });

  it("事前メモを自動で工程へ入れ、依頼と記録に残す。成果物は子ページとしてレールと面に並ぶ", async () => {
    const bridge = new FakeBridge();
    const flow = minutesFlow();
    bridge.flow = flow;
    let count = 0;
    bridge.turnScript = () => [done(`成果物 ${++count}`)];
    const { memo, stored } = await coachingProject(bridge);
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(railPages(container)).toEqual(["事前メモ"]);
    await addPage(container, "音声");
    const rec = stored.project.pages!.find((page) => page.kind === "rec")!;
    const recording = () => bridge.recording(stored.project.id, rec.id);
    expect((await recordingView(bridge, stored.project.id, rec.id)).materials.refs.map((ref) => ref.pageId)).toEqual([memo.id]);
    // 新しい録音: 話者人数は自動・言語は設定の文字起こしの言語・legacy refs は空・工程は最後に使ったフロー（今は 1 本）
    expect(recording().recording).toMatchObject({ speakers: "auto", language: "ja", refs: [] });
    expect(container.querySelector<HTMLSelectElement>("#rec-speakers")?.value).toBe("auto");
    expect(container.querySelector<HTMLSelectElement>("#rec-language")?.value).toBe("ja");
    const flowSelect = container.querySelector<HTMLSelectElement>('select[aria-label="工程"]')!;
    expect(flowSelect.value).toBe(flow.id);
    expect(flowSelect.selectedOptions[0]?.textContent).toBe("議事録");
    // 背景情報ページの音声欄に保存し、録音ページは作らない（#18914）。
    expect(container.querySelector(".folder-home .folder-audio .sec")?.textContent).toBe("音声");
    expect(railCurrent(container)).toBe("背景情報");
    await seedText(bridge, container, "[00:00:05] 最近、任せるのが苦手で。");

    expect(container.querySelector(".props .refs")).toBeNull();

    await click(button(container, "続きを作成"));
    await until(() => (recording().versions[flow.steps[1]!.id]?.length ?? 0) === 1);
    // 工程 2 の依頼: 文章 → 参考ページ（ページごとに ### タイトル）→ 案件情報
    const first = bridge.turnRequests[0]!;
    expect(first.user_prompt).toContain(
      "## 文章\n\n[00:00:05] 最近、任せるのが苦手で。\n\n## 参考ページ\n\n### 事前メモ\n\n## 聞きたいこと\n\n- 今いちばん困っていること\n\n## 背景情報",
    );
    expect(first.user_prompt).toContain("- 話者: 自動\n- 言語: 日本語");
    expect(first.user_prompt).toContain("### 背景・目的\n\n月 1 回のコーチング");
    expect(first.system_prompt).toContain("参考ページは事前の情報・問い");
    // 工程 3 は前の成果物の後に参考
    expect(bridge.turnRequests[1]!.user_prompt).toMatch(/## 議事録\n\n成果物 1\n\n## 参考ページ\n\n### 事前メモ/);
    // 記録: 参考のページの id と字数。送る量は参考を含む
    const runs = recording().runs.filter((run) => run.kind === "run");
    const memoChars = countChars(MEMO.trim());
    expect(runs.map((run) => run.refs)).toEqual([[{ pageId: memo.id, chars: memoChars }], [{ pageId: memo.id, chars: memoChars }]]);
    expect(runs[0]!.inputChars).toBe(countChars(first.system_prompt) + countChars(first.user_prompt));
    expect(runs[0]!.basis?.refs).toBeDefined();
    // 会話の欄の作業に参考ページ
    expect(container.textContent).toContain("参考ページを読みました");

    // 成果物はフォルダの直下に、文書のページと同じ深さで並ぶ（背景情報のページには「成果物」の列を置かない）
    expect(railChildren(container)).toEqual(["文章", "議事録", "共有用の要約"]);
    expect(container.querySelector(".orows")).toBeNull();
    await click(railItem(container, "議事録"));
    expect(railCurrent(container)).toBe("議事録");
    expect(container.querySelector(".sheet h1.ptitle")?.textContent).toBe("議事録");
    // メタ行は文書のページと同じ（〈元〉から · 日時 · 保存の状態。元はフォルダ。#18914）。工程の番号・書いた AI・字数・版の番号は出さない（#18915）
    expect(container.querySelector(".pmeta .pill")).toBeNull();
    expect(meta(container)).toMatch(/^佐藤さん コーチング から·\d+\/\d+ \d\d:\d\d/);
    expect(meta(container)).not.toContain("Claude 標準");
    expect(meta(container)).not.toMatch(/\d+ 字/);
    expect(await shownVersion(container)).toBe("第 1 版");
    expect(bodyEditor(container).getText()).toContain("成果物 1");
  });

  it("録音の後に足した独立文書も次の実行へ自動で入り、本文を直すと使ったページに前提変更が出る", async () => {
    const bridge = new FakeBridge();
    const flow = minutesFlow();
    bridge.flow = flow;
    let count = 0;
    bridge.turnScript = () => [done(`成果物 ${++count}`)];
    const { memo, stored, project } = await coachingProject(bridge);
    const other = await bridge.createPage(project.id, { kind: "doc", title: "前回のふりかえり", createdAt: "2026-10-16T00:00:00.000Z" });
    const recId = await textRecording(bridge, project.id, flow, "第1回", "本文");
    // 古い手動 refs は空でも、現在のフォルダ台帳から毎回選ぶ。
    bridge.recording(project.id, recId).recording.refs = [];
    screen = await renderApp(bridge);
    const { container } = screen;
    await openAudio(container);
    // 元が変わった知らせは録音から作ったページの本文の上の 1 行（背景情報のページには作ったページの列を置かない。#18914・#18915）
    const stalePages = async () => {
      const names: string[] = [];
      for (const name of ["議事録", "共有用の要約"]) {
        await click(railItem(container, name));
        expect(container.querySelector(".pmeta .pill.warn")).toBeNull();
        if (container.querySelector(".cloud-banner")?.textContent === "参考のページが変わりました。作り直す") names.push(name);
      }
      await openAudio(container);
      return names;
    };
    expect(container.querySelector(".props .refs")).toBeNull();
    // 本文が空の文書は工程の入力に入らない。
    await click(button(container, "続きを作成"));
    await until(() => container.querySelector(".runbar .note")?.textContent?.endsWith("に完了") === true);
    expect(bridge.turnRequests[0]!.user_prompt).toContain("### 事前メモ");
    expect(bridge.turnRequests[0]!.user_prompt).not.toContain("前回のふりかえり");
    expect(stored.recordings[recId]!.runs.find((run) => run.kind === "run")?.refs).toEqual([{ pageId: memo.id, chars: countChars(MEMO.trim()) }]);
    expect(await stalePages()).toEqual([]);

    // 文書ページを通常のレールから開いて直すと、使ったページに「参考のページが変わりました。」
    await click(railItem(container, "事前メモ"));
    expect(railCurrent(container)).toBe("事前メモ");
    await act(async () => {
      bodyEditor(container).commands.insertContent("追記");
    });
    await openAudio(container);
    expect(stored.docs[memo.id]).toContain("追記");
    expect(await stalePages()).toEqual(["議事録", "共有用の要約"]);
  });
});

describe("録音の項目は Web と同じ docs-core の言葉（#18903）", () => {
  it("項目名は 話者人数 → 言語 → 工程 の順で、手動の参考欄を出さない", async () => {
    const bridge = new FakeBridge();
    const flow = minutesFlow();
    bridge.flow = flow;
    const { project } = await coachingProject(bridge);
    await bridge.createPage(project.id, { kind: "doc", title: "前回のふりかえり", createdAt: "2026-10-16T00:00:00.000Z" });
    const recId = await textRecording(bridge, project.id, flow, "第1回", "本文");
    screen = await renderApp(bridge);
    const { container } = screen;
    // 録音の項目は背景情報のページの「音声」にある（録音のページは無い。#18914）
    await openAudio(container);
    const props = container.querySelector<HTMLElement>(".props")!;
    expect([...props.querySelectorAll(":scope > .k")].map((key) => key.textContent)).toEqual([
      RECORDING_FIELD_LABELS.speakers,
      RECORDING_FIELD_LABELS.language,
      FLOW_CHOICE_LABEL,
    ]);
    const optionsOf = (id: string) => [...container.querySelectorAll<HTMLOptionElement>(`#${id} option`)].map((option) => option.textContent);
    expect(optionsOf("rec-speakers")).toEqual(SPEAKER_MODES.map(speakerLabel));
    expect(optionsOf("rec-language")).toEqual(LANGUAGES.map(languageLabel));
    expect(props.querySelector(".refs")).toBeNull();
  });

  it("新しい録音の言語の既定は設定の文字起こしの言語", async () => {
    const bridge = new FakeBridge();
    const flow = minutesFlow();
    bridge.flow = flow;
    const settings = defaultSettings();
    bridge.settings = { ...settings, transcription: { ...settings.transcription, language: "en" } };
    const project = await bridge.createProject(pagedProject("朝市 インタビュー"), null, null, []);
    screen = await renderApp(bridge);
    const { container } = screen;
    await addPage(container, "音声");
    const stored = bridge.projects.get(project.id)!;
    const rec = stored.project.pages!.find((page) => page.kind === "rec")!;
    expect(bridge.recording(project.id, rec.id).recording).toMatchObject({ speakers: "auto", language: "en", refs: [] });
    expect(container.querySelector<HTMLSelectElement>("#rec-language")?.value).toBe("en");
    expect(container.querySelector(".props .refs")).toBeNull();
  });
});

describe("成果物の子ページ", () => {
  it("直してから作り直すと直した内容を先に版にし（before_ai）、⋯ の「作り直す」で次の版になる（版は履歴で見る）。履歴・AIと作る・書き出し・⋯ は上の帯", async () => {
    const bridge = new FakeBridge();
    const flow = minutesFlow();
    bridge.flow = flow;
    const { project, stored } = await coachingProject(bridge);
    const recId = await textRecording(bridge, project.id, flow, "第1回 セッション", "本文");
    const minutes = flow.steps[0]!;
    await seedRun(bridge, project.id, minutes, "# 議事録\n\n決めたこと\n", recId);
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "議事録"));
    const versions = () => stored.recordings[recId]!.versions[minutes.id] ?? [];
    expect(container.querySelector(".sheet h1.ptitle")?.textContent).toBe("議事録");
    expect(await shownVersion(container)).toBe("第 1 版");
    // メタ行はフォルダ名・日時・保存状態を文書ページと同じ形で出し、AI名・工程番号・版番号は重ねない（#18915）。
    expect(meta(container)).not.toContain("Claude 標準");
    expect(meta(container)).not.toContain("工程");
    expect(container.querySelector(".pmeta .work-meta-info button")).toBeNull();
    // 検索・書式・書き出し・作り直すは ⋯ の中。保存ボタンは置かない（#18912・#18941）。
    expect(container.querySelector(".doc-head, .tools")).toBeNull();
    expect(container.querySelector('button[aria-label="行の種類"]')).toBeNull();
    expect([...top(container).querySelectorAll(".acts > *")].map((element) => element.textContent?.trim() || element.querySelector("button")?.getAttribute("aria-label") || element.getAttribute("aria-label"))).toEqual([
      "履歴",
      "AIと作る",
      "その他",
    ]);
    expect(pageMenuItems(await openPageMenu(container))).toEqual(["検索", "書式を表示", "書き出し", "作り直す"]);
    await click(pageMenuButton(container)!);

    // 直す（自動保存だけ。版はまだ増えない）
    await act(async () => {
      bodyEditor(container).commands.insertContent("追記");
    });
    expect(await shownVersion(container)).toBe("第 1 版");
    await until(() => stored.recordings[recId]!.artifacts[minutes.id]?.includes("追記") ?? false);
    expect(versions()).toHaveLength(1);

    // ⋯ → 作り直す → 直した内容を先に版 2 にし（書いた人は「保存」）、結果は版 3（書いた人は AI とプロファイル）
    bridge.turnScript = () => [done("# 議事録\n\n作り直した")];
    await rebuild(container);
    await until(() => versions().length === 3);
    await until(() => bodyEditor(container).getText().includes("作り直した"));
    expect(await shownVersion(container)).toBe("第 3 版");
    expect(versions()[1]).toContain("追記");
    expect(bodyEditor(container).getText()).toContain("作り直した");

    // 履歴（上の帯）で古い版を開くと、その版の番号を出す（読むだけ）
    await click(top(container).querySelector('[aria-label="履歴"]')!);
    const rows = [...container.querySelectorAll(".pop.hist .hrow")];
    expect(rows.map((row) => row.querySelector("b")?.textContent)).toEqual(["版 3現在版", "版 2", "版 1"]);
    expect(rows.map((row) => row.querySelector(".d")?.textContent)).toEqual(["議事録を実行", "編集", "議事録を実行"]);
    await click(rows[1]!);
    expect(await shownVersion(container)).toBe("第 2 版");
    await click(top(container).querySelector('[aria-label="履歴"]')!);
    await click([...container.querySelectorAll(".pop.hist .hrow")][2]!);
    expect(await shownVersion(container)).toBe("第 1 版");
    expect(container.querySelector(".version-view .note")?.textContent).toBe("版 1 を表示中");

    // フォルダの中は録音のページが無いので、〈フォルダ名〉 〈工程名〉.md。古い版のメニューは書き出しだけ。
    expect(pageMenuItems(await openPageMenu(container))).toEqual(["書き出し"]);
    await exportFromMenu(container, ".md で保存");
    expect(bridge.exportedNames).toEqual(["佐藤さん コーチング 議事録.md"]);

    // 子ページの「/」には「録音のページ」が無い（現在版に戻ってから）
    await click(button(container.querySelector<HTMLElement>(".version-view")!, "現在版に戻る"));
    await until(() => bodyEditor(container).isEditable);
    await typeAtEnd(bodyEditor(container), "/");
    expect(slashOptions(container)).toContain("見出し1");
    expect(slashOptions(container)).not.toContain("録音のページ");
    expect([...container.querySelectorAll(".be-slash .h")].map((heading) => heading.textContent)).toEqual(["基本ブロック"]);
  });
});

describe("話者人数・言語は録音ごと", () => {
  it("案件情報に話者人数・言語は無い。録音のページで変えるとその場で保存する（root は project.json の info、ほかは recording.json）", async () => {
    const bridge = new FakeBridge();
    const flow = minutesFlow();
    bridge.flow = flow;
    const created = await bridge.createProject(legacyProject(flow), "[00:00:08] 朝市に出して三年目です。\n", saveRecord("save-1"), []);
    const stored = bridge.projects.get(created.id)!;
    screen = await renderApp(bridge);
    const { container } = screen;
    // root の録音: info の値を出す
    const speakers = () => container.querySelector<HTMLSelectElement>("#rec-speakers")!;
    const language = () => container.querySelector<HTMLSelectElement>("#rec-language")!;
    expect([speakers().value, language().value]).toEqual(["2", "ja"]);
    expect([...speakers().options].map((option) => option.textContent)).toEqual(["自動", "1人", "2人", "3人", "4人以上"]);
    await selectOption(speakers(), "3");
    await until(() => stored.project.info.speakers === "3" && !speakers().disabled);
    await selectOption(language(), "en");
    await until(() => stored.project.info.language === "en" && !language().disabled);
    expect(stored.project.info).toMatchObject({ speakers: "3", language: "en" });
    expect([speakers().value, language().value]).toEqual(["3", "en"]);
    // ほかの値は変えない（pages も書かない）
    expect(stored.project.flowSnapshot).toBeDefined();
    expect(stored.project.pages).toBeUndefined();

    // 背景情報: 同じページの 背景情報・登場人物・固有名詞（ダイアログは無い。#18914）。保存しても root の話者人数・言語は残る
    const info = container.querySelector<HTMLElement>(".folder-home")!;
    expect(dialog(container)).toBeNull();
    expect(info.querySelector("#info-speakers")).toBeNull();
    expect(info.querySelector("#info-language")).toBeNull();
    expect([...info.querySelectorAll(".folder-fields .fld > label, .folder-fields .fld > .label")].map((label) => label.textContent)).toEqual(["背景情報", "登場人物", "固有名詞"]);
    await typeInto(info.querySelector("#info-bg")!, "朝市の出店者への取材");
    await click(button(info.querySelector<HTMLElement>(".folder-save")!, "保存"));
    expect(stored.project.info).toEqual({ speakers: "3", language: "en", terms: [], background: "朝市の出店者への取材" });

    // root 以外の録音は recording.json（1 フォルダ 1 音声なので、「＋ 新しい › 音声」で新しいフォルダに作る）
    await newFromMenu(container, "音声");
    const fresh = [...bridge.projects.values()].find((item) => item.project.id !== created.id)!;
    const rec = fresh.project.pages!.find((page) => page.kind === "rec")!;
    expect([speakers().value, language().value]).toEqual(["auto", "ja"]);
    await selectOption(speakers(), "none");
    await until(() => bridge.recording(fresh.project.id, rec.id).recording.speakers === "none" && !speakers().disabled);
    await selectOption(language(), "en");
    await until(() => bridge.recording(fresh.project.id, rec.id).recording.language === "en");
    expect(bridge.recording(fresh.project.id, rec.id).recording).toMatchObject({ speakers: "none", language: "en" });
    expect(stored.project.info).toMatchObject({ speakers: "3", language: "en" });
  });

  it("P1 で作った録音（recording.json に話者人数・言語・参考が無い）は案件の info で読み（ファイルは書き換えない）、文字起こしは録音の言語で行う", async () => {
    const bridge = new FakeBridge();
    const flow = minutesFlow();
    bridge.flow = flow;
    const project = await bridge.createProject(
      pagedProject("Weekly sync", { speakers: "4plus", language: "en", terms: [], background: "" }),
      null,
      null,
      [],
    );
    const entry = await bridge.createPage(project.id, { kind: "rec", title: "", createdAt: "2026-10-16T01:00:00.000Z", recording: newRecording(flow) });
    const stored = bridge.recording(project.id, entry.id);
    const { speakers: _speakers, language: _language, refs: _refs, ...p1 } = stored.recording as Recording;
    stored.recording = { ...p1, source: { kind: "audio", audio: [{ file: "a1.m4a", hash: "0".repeat(64), name: "sync.m4a", durationSec: 60 }] } };
    bridge.speechStatus = async () => ({ found: true, fake: false, available: true, needsDownload: false, engine: "apple", error: null, notice: null, diarization: { state: "ready", detail: null } });
    bridge.transcribeResult = [{ jsonl: '{"type":"segment","start":1,"end":3,"text":"Hello everyone."}\n', durationSec: 60 }];
    bridge.turnScript = () => [done("minutes")];
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(container.querySelector<HTMLSelectElement>("#rec-speakers")?.value).toBe("4plus");
    expect(container.querySelector<HTMLSelectElement>("#rec-language")?.value).toBe("en");
    expect(container.querySelector(".props .chip")).toBeNull();
    expect("speakers" in stored.recording).toBe(false);

    await click(button(container, "文書作成を開始"));
    await until(() => stored.transcript !== null && (stored.versions[flow.steps[1]!.id]?.length ?? 0) === 1);
    expect(bridge.transcribeLanguages).toEqual(["en"]);
    expect(bridge.turnRequests[0]!.user_prompt).toContain("- 話者: 4人以上\n- 言語: 英語");
    // 読み替えただけでは recording.json を書かない
    expect("speakers" in stored.recording).toBe(false);
    // 変えると読み替えた値で書く（ファイルが整う）
    await selectOption(container.querySelector("#rec-speakers")!, "2");
    await until(() => stored.recording.speakers === "2");
    expect(stored.recording).toMatchObject({ speakers: "2", language: "en", refs: [] });
  });

  it("実行中（同じ案件）は話者人数・言語を変えられない", async () => {
    const bridge = new FakeBridge();
    const flow = minutesFlow();
    bridge.flow = flow;
    let release!: () => void;
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.turnScript = () => [{ type: "TextDelta", text: "途中" }, done("成果")];
    const { project } = await coachingProject(bridge);
    await textRecording(bridge, project.id, flow, "第1回", "本文");
    screen = await renderApp(bridge);
    const { container } = screen;
    await openAudio(container);
    await click(button(container, "続きを作成"));
    await until(() => container.querySelector(".runbar .note")?.textContent === "議事録を実行中");
    expect(container.querySelector<HTMLSelectElement>("#rec-speakers")?.disabled).toBe(true);
    expect(container.querySelector<HTMLSelectElement>("#rec-language")?.disabled).toBe(true);
    release();
    await until(() => container.querySelector<HTMLSelectElement>("#rec-speakers")?.disabled === false);
  });
});

describe("フォルダの音声の削除", () => {
  it("背景情報のページの ⋯ → 音声を削除 で確かめてから消え（成果物・版・会話も）、背景情報のページに残る。同じ案件の実行中は押せない", async () => {
    const bridge = new FakeBridge();
    const flow = minutesFlow();
    bridge.flow = flow;
    const { project, stored } = await coachingProject(bridge);
    const first = await textRecording(bridge, project.id, flow, "第1回", "一回目の本文");
    await seedRun(bridge, project.id, flow.steps[0]!, "# 議事録\n", first);
    await bridge.saveConversation({ projectId: project.id, recordingId: first }, { id: "conv-1", updatedAt: "x" } as never);
    screen = await renderApp(bridge);
    const { container } = screen;
    // 録音の行は無く、成果物がフォルダの直下に並ぶ
    expect(railPages(container)).toEqual(["事前メモ"]);
    expect(railChildren(container)).toEqual(["文章", "議事録"]);
    await openAudio(container);
    const openMenu = async () => {
      await click(top(container).querySelector('button[aria-label="その他"]')!);
      return container.querySelector<HTMLElement>(".pagemenu .pop")!;
    };
    // やめるとそのまま
    await click(button(await openMenu(), "音声を削除"));
    expect(dialog(container)?.querySelector("h2")?.textContent).toBe("「佐藤さん コーチング」の音声を削除しますか");
    expect(dialog(container)?.textContent).toContain("このフォルダの音声と、この音声から作ったページ・版・会話を削除します。背景情報と文書のページは残ります。元に戻せません。");
    expect(button(dialog(container)!, "削除する").className).toBe("btn stop");
    await click(button(dialog(container)!, "やめる"));
    expect(stored.recordings[first]).toBeDefined();
    // 削除する
    await click(button(await openMenu(), "音声を削除"));
    await click(button(dialog(container)!, "削除する"));
    expect(stored.recordings[first]).toBeUndefined();
    expect(stored.project.pages?.map((page) => page.id)).not.toContain(first);
    expect(bridge.conversationFiles.get(`${project.id}/${first}`)).toBeUndefined();
    expect(railPages(container)).toEqual(["事前メモ"]);
    expect(railChildren(container)).toEqual([]);
    // 背景情報のページに残り、音声の欄は空に戻る
    expect(railCurrent(container)).toBe("背景情報");
    expect(container.querySelector(".folder-audio .drop")).not.toBeNull();
    expect(container.querySelector(".toast")?.textContent).toBe("削除しました");

    // 実行中（同じ案件）は押せない（理由を 1 行）
    let release!: () => void;
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.turnScript = () => [{ type: "TextDelta", text: "途中" }, done("成果")];
    await addPage(container, "音声");
    await seedText(bridge, container, "二回目の本文");
    const second = stored.project.pages!.find((page) => page.kind === "rec")!.id;
    await click(button(container, "続きを作成"));
    await until(() => container.querySelector(".runbar .note")?.textContent === "議事録を実行中");
    const menu = await openMenu();
    expect(button(menu, "音声を削除").disabled).toBe(true);
    expect([...menu.querySelectorAll(".menu-note")].map((note) => note.textContent)).toContain("工程の実行が終わってから削除できます。");
    await click(top(container).querySelector('button[aria-label="その他"]')!);
    release();
    await until(() => container.querySelector(".runbar .note")?.textContent?.endsWith("に完了") === true);
    expect(button(await openMenu(), "音声を削除").disabled).toBe(false);
    expect(stored.recordings[second]).toBeDefined();
  });

  it("今の案件の root の録音を消すと、project.json の flowSnapshot・source を外し（案件情報は残る）、ほかのページが残る", async () => {
    const bridge = new FakeBridge();
    const flow = minutesFlow();
    bridge.flow = flow;
    const created = await bridge.createProject(legacyProject(flow), "[00:00:08] 朝市に出して三年目です。\n", saveRecord("save-1"), []);
    const stored = bridge.projects.get(created.id)!;
    const doc = await bridge.createPage(created.id, { kind: "doc", title: "取材メモ", createdAt: "2026-10-16T00:00:00.000Z" });
    screen = await renderApp(bridge);
    const { container } = screen;
    // root の録音はフォルダの音声（背景情報のページ）。成果物（文章）はフォルダの直下
    expect(railCurrent(container)).toBe("背景情報");
    expect(railPages(container)).toEqual(["取材メモ"]);
    expect(railChildren(container)).toEqual(["文章"]);
    await click(top(container).querySelector('button[aria-label="その他"]')!);
    await click(button(container.querySelector<HTMLElement>(".pagemenu .pop")!, "音声を削除"));
    expect(dialog(container)?.querySelector("h2")?.textContent).toBe("「朝市 インタビュー」の音声を削除しますか");
    await click(button(dialog(container)!, "削除する"));
    expect(stored.project.flowSnapshot).toBeUndefined();
    expect(stored.project.source).toBeUndefined();
    expect(stored.project.info).toEqual({ speakers: "2", language: "ja", terms: [], background: "" });
    expect(stored.project.pages?.map((page) => page.id)).toEqual([doc.id]);
    expect(stored.transcript).toBeNull();
    expect(stored.runs).toEqual([]);
    expect(railPages(container)).toEqual(["取材メモ"]);
    expect(railChildren(container)).toEqual([]);
    expect(railCurrent(container)).toBe("背景情報");
  });
});

describe("文書のページの「/」", () => {
  it("録音のページを作る操作は出さず、基本ブロックだけを出す", async () => {
    const bridge = new FakeBridge();
    bridge.flow = minutesFlow();
    const { stored } = await coachingProject(bridge);
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(railCurrent(container)).toBe("事前メモ");
    const editor = bodyEditor(container);
    await typeAtEnd(editor, "/");
    expect([...container.querySelectorAll(".be-slash .h")].map((heading) => heading.textContent)).toEqual(["基本ブロック"]);
    expect(slashOptions(container)).not.toContain("録音のページ");
    await typeAtEnd(editor, "rokuon");
    expect(slashOptions(container)).toEqual([]);
    expect(stored.project.pages?.filter((page) => page.kind === "rec")).toEqual([]);
  });

  it("工程がまだ無くても録音作成の候補は出さない", async () => {
    const bridge = new FakeBridge();
    const { stored } = await coachingProject(bridge);
    screen = await renderApp(bridge);
    const { container } = screen;
    const editor = bodyEditor(container);
    await typeAtEnd(editor, "/ろくおん");
    expect(slashOptions(container)).toEqual([]);
    expect(dialog(container)).toBeNull();
    expect(stored.project.pages?.filter((page) => page.kind === "rec")).toEqual([]);
  });
});

describe("一括実行と参考ページ", () => {
  it("実行の途中で参考の文書を直しても、後の工程は始めたときの本文を受け取る", async () => {
    const bridge = new FakeBridge();
    const flow = minutesFlow();
    bridge.flow = flow;
    let count = 0;
    bridge.turnScript = () => [done(`成果物 ${++count}`)];
    let release!: () => void;
    let started!: () => void;
    const waitStarted = new Promise<void>((resolve) => (started = resolve));
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.onTurnStarted = () => started();
    const { memo, stored } = await coachingProject(bridge);
    const entry = await bridge.createPage(stored.project.id, {
      kind: "rec",
      title: "第1回",
      createdAt: "2026-10-16T01:00:00.000Z",
      recording: newRecording(flow, { refs: [memo.id] }),
    });
    await bridge.setRecordingText({ projectId: stored.project.id, recordingId: entry.id }, "[00:00:05] 最近、任せるのが苦手で。", saveRecord("save-1"));
    screen = await renderApp(bridge);
    const { container } = screen;
    await openAudio(container);
    await click(button(container, "続きを作成"));
    await waitStarted;
    // 最初の工程の実行中に、参考の文書を直す
    await bridge.writePage(stored.project.id, memo.id, "## 変えた本文\n");
    release();
    await until(() => (bridge.recording(stored.project.id, entry.id).versions[flow.steps[1]!.id]?.length ?? 0) === 1);
    expect(bridge.turnRequests).toHaveLength(2);
    expect(bridge.turnRequests[0]!.user_prompt).toContain("今いちばん困っていること");
    expect(bridge.turnRequests[1]!.user_prompt).toContain("今いちばん困っていること");
    expect(bridge.turnRequests[1]!.user_prompt).not.toContain("変えた本文");
  });
});
