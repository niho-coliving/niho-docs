// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import {
  FLOW_TEMPLATES,
  ROOT_RECORDING_ID,
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  renameTranscriptSpeakerLabel,
  reasonMessage,
  type Flow,
  type FlowTemplate,
  type Project,
  type Recording,
} from "@niho/docs-core";
import { button, click, renderApp, selectOption, typeInto, type Screen } from "./dom";
import { FakeBridge, done, rootRef } from "./fake-bridge";
import { addPage, createProjectByName, exportFromMenu, hasOutputRow, infoItem, openAudio, openPageMenu, outputRow, pageMenuItems, railChildren, railCurrent, railFolder, railItem, rebuild, seedBlankRecording, seedRun, shownVersion, titleInput, until, newFolder, newFromMenu, seedText } from "./pages";
import { activeProfiles, normalizeSettings } from "../src/lib/settings";
import { docToMarkdown, markdownToDoc } from "../src/lib/markdown";
import { THREE_STEP_TEMPLATE } from "./three-step-flow";

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

function textProject(flow: Flow, name = "朝市 インタビュー"): Project {
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

/** 工程名 → 工程 id（成果物・版は工程 id で持つ）。 */
function stepIdOf(flow: Flow, name: string): string {
  const step = flow.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`step not found: ${name}`);
  return step.id;
}

async function bridgeWithTextProject(template: FlowTemplate = THREE_STEP_TEMPLATE) {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(template, "flow-1");
  bridge.flow = flow;
  const project = await bridge.createProject(textProject(flow), "[00:00:08] 朝市に出して三年目です。\n", {
    id: "save-1",
    kind: "save",
    at: "2026-10-15T00:00:00.000Z",
    stepId: SOURCE_STEP_ID,
    stepName: "文章",
    version: null,
    result: "saved",
  }, []);
  const stored = bridge.projects.get(project.id)!;
  return { bridge, flow, project, stored, id: (name: string) => stepIdOf(flow, name) };
}

async function bridgeWithSpeakerProject(input: { provider?: "deepgram" | "gemini"; audioCount?: number; terms?: string[] } = {}) {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-speakers");
  bridge.flow = flow;
  const terms = (input.terms ?? ["田中"]).map((term) => ({ term, reading: "", variants: [], note: "" }));
  const source = [
    "[00:00:01] 話者1: 最初です。話者1: は本文です。",
    "",
    "[00:00:10] 話者10: 十番です。",
    "",
    "[00:00:20] 話者1: 二度目です。",
    "",
  ].join("\n");
  const audio = Array.from({ length: input.audioCount ?? 1 }, (_, index) => `/a/${index + 1}.m4a`);
  const project = await bridge.createProject(
    { ...textProject(flow, "話者テスト"), info: { speakers: "2", language: "ja", terms, background: "" }, source: { kind: "audio", audio: [] } },
    source,
    {
      id: "run-source-1",
      kind: "run",
      at: "2026-10-15T00:00:00.000Z",
      stepId: SOURCE_STEP_ID,
      stepName: "文字起こし",
      version: null,
      result: "saved",
      provider: input.provider ?? "deepgram",
    },
    audio,
  );
  return { bridge, project, stored: bridge.projects.get(project.id)!, source };
}

/** 同じ話者番号の録音を 2 つ（1 フォルダに録音は 1 つなので、フォルダを 2 つ。#18914）。 */
async function bridgeWithSpeakerPages() {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-speaker-pages");
  bridge.flow = flow;
  const source = "[00:00:01] 話者1: 最初です。\n";
  const folder = (name: string) => bridge.createProject(
    {
      version: 1,
      id: "",
      name,
      createdAt: "2026-10-15T00:00:00.000Z",
      info: {
        terms: ["田中", "佐藤"].map((term) => ({ term, reading: "", variants: [], note: "" })),
        background: "",
      },
      pages: [],
    },
    null,
    null,
    [],
  );
  const project = await folder("1回目の録音");
  const project2 = await folder("2回目の録音");
  const recording: Recording = {
    version: 1,
    id: "",
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    source: { kind: "text" },
    speakers: "2",
    language: "ja",
    refs: [],
  };
  const first = await bridge.createPage(project.id, { kind: "rec", title: "1回目", createdAt: recording.createdAt, recording });
  const second = await bridge.createPage(project2.id, { kind: "rec", title: "2回目", createdAt: recording.createdAt, recording });
  const seed = async (projectId: string, recordingId: string, markdown: string, id: string) =>
    bridge.saveArtifact({ projectId, recordingId }, SOURCE_STEP_ID, true, markdown, {
      id,
      kind: "run",
      at: "2026-10-15T00:00:00.000Z",
      stepId: SOURCE_STEP_ID,
      stepName: "文章",
      version: null,
      result: "saved",
      provider: "deepgram",
    });
  await seed(project.id, first.id, source, "run-first");
  await seed(project2.id, second.id, source, "run-second");
  await bridge.saveArtifact(
    { projectId: project2.id, recordingId: second.id },
    SOURCE_STEP_ID,
    true,
    source.replace("最初です", "2回目の最新版です"),
    {
      id: "save-second",
      kind: "save",
      at: "2026-10-15T00:01:00.000Z",
      stepId: SOURCE_STEP_ID,
      stepName: "文章",
      version: null,
      result: "saved",
    },
  );
  return { bridge, project, project2, first, second, source };
}

async function openSource(container: HTMLElement) {
  await click(outputRow(container, "文字起こし"));
}

async function flush() {
  for (let index = 0; index < 8; index++) await act(async () => Promise.resolve());
}

type BodyEditor = { commands: { insertContent: (text: string) => void }; getText: () => string; isEditable: boolean };

/** 成果物の子ページの本文のエディタ。 */
function artifactEditor(container: HTMLElement): BodyEditor {
  const body = container.querySelector(".pbody .ProseMirror") as (HTMLElement & { editor?: BodyEditor }) | null;
  if (!body?.editor) throw new Error("artifact editor not found");
  return body.editor;
}

/** 成果物の本文に打ち足す（利用者の入力）。 */
async function typeBody(container: HTMLElement, text: string) {
  await act(async () => artifactEditor(container).commands.insertContent(text));
}

/** 会話の欄の「途中まで」を開く（開くと checkpoint から読む）。 */
async function openPartial(details: HTMLDetailsElement) {
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  for (let index = 0; index < 4; index++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const PICK_NOTE = "録音の作り方を選びます。あとから「工程設計」で増やし、録音のページごとに選び直せます。";

/** 保存したフローの回数を数える（「工程を選ぶ」で選んだときに 1 回だけ保存する）。 */
function countFlowSaves(bridge: FakeBridge): { count: number } {
  const saves = { count: 0 };
  const original = bridge.saveFlow.bind(bridge);
  bridge.saveFlow = async (flow) => {
    saves.count++;
    await original(flow);
  };
  return saves;
}

function pickerCards(root: ParentNode): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>(".tcard")];
}

async function pressEscape() {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  for (let index = 0; index < 4; index++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("ホームとフローがまだ無い録音", () => {
  it("起動はホームで、見出し・作成カードを置かず最近だけを出す。作成はタイトルバーの新規作成の ＋（レールに「ホーム」の行は無い）。設定と工程設計も開ける", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge, { autoOpen: false });
    const { container } = screen;
    expect(container.querySelector(".rail")).not.toBeNull();
    // 見出し「ホーム」・「文書を書く」「音声から作る」のカードは置かない（Web/PWA と同じ。#18867）
    expect(container.querySelector(".home-page h1")).toBeNull();
    expect(container.querySelector(".create-card")).toBeNull();
    expect(container.querySelector("#recent-title")?.textContent).toBe("最近");
    expect(container.querySelector(".home-page .help")?.textContent).toBe("ページはまだありません。");
    // レールの先頭は「ホーム」の行も「＋ 新しい」の箱も無く、タイトルバーのアプリ名がホームへのボタン（#18929）
    expect([...container.querySelectorAll(".rail button")].some((node) => node.textContent?.trim() === "ホーム")).toBe(false);
    expect(container.querySelector('.window-titlebar .lead button[aria-label="NIHO docs ホームへ"]')?.textContent).toBe("NIHO docs");
    const add = container.querySelector<HTMLButtonElement>(".window-titlebar .lead .tb-new")!;
    expect([add.getAttribute("aria-label"), add.getAttribute("title"), add.textContent]).toEqual(["新規作成", "新規作成", ""]);
    await click(add);
    expect([...container.querySelectorAll(".window-titlebar .new-menu .pop .mi span:first-of-type")].map((item) => item.textContent)).toEqual(["ページ", "音声", "フォルダ"]);
    await click(container.querySelector<HTMLButtonElement>(".window-titlebar .tb-new")!);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(pickerCards(container)).toHaveLength(0);
    expect(container.querySelector(".rail .case")).toBeNull();

    await click(button(container, "設定"));
    expect(container.querySelector("h1")?.textContent).toBe("設定");
    await click(button(container, "工程設計"));
    expect(container.querySelector("h1")?.textContent).toBe("工程を選ぶ");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(bridge.flow).toBeNull();
  });

  it("工程が 0 本で録音・音声を足すと「工程を選ぶ」を出し、テンプレートを選ぶとその工程でそのまま録音のページを作る（#18753）", async () => {
    const bridge = new FakeBridge();
    const saves = countFlowSaves(bridge);
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "運営会議 10/21");
    expect(bridge.flow).toBeNull();

    await addPage(container, "音声");
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector("h2")?.textContent).toBe("工程を選ぶ");
    expect(dialog.querySelector(".msg")?.textContent).toBe(PICK_NOTE);
    expect(pickerCards(dialog).map((card) => card.querySelector("b")?.textContent ?? card.textContent)).toEqual([
      "記事制作",
      "議事録",
      "インサイト整理",
      "コーチング",
      "白紙から",
    ]);
    expect(button(dialog, "続ける").disabled).toBe(true);
    // 選ぶまでは録音を作らない
    expect(bridge.byName("運営会議 10/21").project.pages?.map((page) => page.kind)).toEqual(["doc"]);

    await click(pickerCards(dialog)[0]!);
    await click(button(dialog, "続ける"));
    await until(() => container.querySelector("#rec-flow") !== null);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(saves.count).toBe(1);
    expect(bridge.flow?.name).toBe("記事制作");
    const stored = bridge.byName("運営会議 10/21");
    expect(stored.project.pages?.map((page) => page.kind)).toEqual(["rec", "doc"]);
    const page = stored.project.pages!.find((entry) => entry.kind === "rec")!;
    const snapshot = bridge.recording(stored.project.id, page.recordingId ?? page.id).recording.flowSnapshot;
    expect(snapshot.name).toBe("記事制作");
    expect(snapshot.steps.length).toBeGreaterThan(0);
    expect(container.querySelector<HTMLSelectElement>("#rec-flow")!.value).toBe(bridge.flow!.id);
    // 背景情報のページ（フォルダの音声の欄）のまま
    expect(railCurrent(container)).toBe("背景情報");
    expect(titleInput(container).value).toBe("運営会議 10/21");
  });

  it("「工程を選ぶ」は Esc で閉じて何も作らず、白紙を選ぶと工程設計を開いて録音は作らない", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge, { autoOpen: false });
    const { container } = screen;
    // ⇧⌘N も「＋ → 録音・音声」と同じ
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true, shiftKey: true, bubbles: true })));
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe("工程を選ぶ");
    await pressEscape();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(bridge.flow).toBeNull();
    expect(bridge.outside.project.pages ?? []).toEqual([]);

    await newFromMenu(container, "音声");
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await click(button(dialog, "白紙から"));
    await click(button(dialog, "続ける"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("工程設計");
    expect(bridge.flow?.steps).toEqual([]);
    expect(bridge.outside.project.pages ?? []).toEqual([]);
    expect(bridge.projects.size).toBe(0);
  });

  it("工程を保存できたあとに設定の保存や一覧の読み直しが失敗しても、ダイアログを残さず同じ工程で録音を作る（再試行で工程が重複しない。#18760）", async () => {
    const bridge = new FakeBridge();
    const saves = countFlowSaves(bridge);
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "運営会議 10/21");
    await addPage(container, "音声");
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    bridge.saveSettings = async () => {
      throw new Error("settings write failed");
    };
    const realList = bridge.listFlows.bind(bridge);
    let failList = true;
    bridge.listFlows = async () => {
      if (failList) {
        failList = false;
        throw new Error("list failed");
      }
      return realList();
    };

    await click(pickerCards(dialog)[0]!);
    await click(button(dialog, "続ける"));
    await until(() => container.querySelector("#rec-flow") !== null);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(failList).toBe(false);
    expect(saves.count).toBe(1);
    expect(bridge.flow?.name).toBe("記事制作");
    expect(bridge.byName("運営会議 10/21").project.pages?.map((page) => page.kind)).toEqual(["rec", "doc"]);
    expect(container.querySelector<HTMLSelectElement>("#rec-flow")!.value).toBe(bridge.flow!.id);
    expect(container.querySelector(".toast")).toBeNull();
    expect(container.querySelector(".failure-band")).toBeNull();
  });

  it("白紙を選んでも、書きかけの文書を保存できなければ工程も作らず移らない。保存できたら工程設計へ移る（#18760）", async () => {
    const bridge = new FakeBridge();
    const saves = countFlowSaves(bridge);
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "朝市");
    const body = container.querySelector(".pbody .ProseMirror") as (HTMLElement & { editor?: { commands: { insertContent: (text: string) => void }; getText: () => string } }) | null;
    await act(async () => body!.editor!.commands.insertContent("失ってはいけない書きかけ"));
    await addPage(container, "音声");
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    const realWrite = bridge.writePage.bind(bridge);
    bridge.writePage = async () => {
      throw { code: "store_io", message: "保存に失敗しました。" };
    };

    await click(button(dialog, "白紙から"));
    await click(button(dialog, "続ける"));
    await until(() => container.querySelector(".failure-band .fb-msg")?.textContent === "保存に失敗しました。");
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe("工程を選ぶ");
    expect(saves.count).toBe(0);
    expect(bridge.flow).toBeNull();
    expect(body!.editor!.getText()).toContain("失ってはいけない書きかけ");

    bridge.writePage = realWrite;
    await click(button(container.querySelector<HTMLElement>('[role="dialog"]')!, "続ける"));
    await until(() => container.querySelector("h1")?.textContent === "工程設計");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(saves.count).toBe(1);
    expect(bridge.flow?.steps).toEqual([]);
  });

  it("工程が 0 本の録音は、工程の欄から工程設計を開ける", async () => {
    const bridge = new FakeBridge();
    await seedBlankRecording(bridge, "朝の会");
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => container.querySelector("#rec-flow") !== null);
    const stored = bridge.byName("朝の会");
    const recording = stored.project.pages?.find((page) => page.kind === "rec");
    expect(bridge.recording(stored.project.id, recording!.recordingId ?? recording!.id).recording.flowSnapshot.steps).toEqual([]);
    const speakers = container.querySelector<HTMLSelectElement>("#rec-speakers")!;
    expect(speakers.disabled).toBe(false);
    await click(button(container, "工程設計で作る"));
    expect(container.querySelector("h1")?.textContent).toBe("工程を選ぶ");
    expect(bridge.byName("朝の会").project.pages?.map((page) => page.kind)).toEqual(["rec"]);
  });

  it("⌘Nは文書、⇧⌘Nは音声 1 セット入りの新しいフォルダを作り、repeatとIMEは無視する", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    screen = await renderApp(bridge, { autoOpen: false });
    const { container } = screen;
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true, bubbles: true })));
    await until(() => bridge.outside.project.pages?.length === 1);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true, shiftKey: true, bubbles: true })));
    await until(() => bridge.projects.size === 1);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true, repeat: true, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true, isComposing: true, bubbles: true }));
    });
    // ホームには録音を作らない（#18914）
    expect(bridge.outside.project.pages?.map((page) => page.kind)).toEqual(["doc"]);
    expect([...bridge.projects.values()][0]!.project.pages?.map((page) => page.kind)).toEqual(["rec"]);
    expect(railCurrent(container)).toBe("背景情報");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("工程設計ではその場で工程を選び、選ぶと工程設計のまま作った設計を出す", async () => {
    const bridge = new FakeBridge();
    const saves = countFlowSaves(bridge);
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "工程設計"));
    expect(container.querySelector("h1")?.textContent).toBe("工程を選ぶ");
    expect(container.querySelector(".page .help")?.textContent).toBe(PICK_NOTE);
    expect(pickerCards(container)).toHaveLength(5);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(button(container, "続ける").disabled).toBe(true);
    await click(pickerCards(container)[0]!);
    await click(button(container, "続ける"));
    expect(saves.count).toBe(1);
    expect(bridge.flow?.name).toBe("記事制作");
    expect(container.querySelector("h1")?.textContent).toBe("工程設計");
    expect(container.querySelector<HTMLInputElement>(".flowname .inp")?.value).toBe("記事制作");
    expect(container.querySelector(".toast")).toBeNull();
    expect(container.querySelector(".failure-band")).toBeNull();
    // 工程はもう選んだので、音声はそのままフォルダの音声を作って背景情報のページを開く
    await createProjectByName(container, "朝の会");
    await addPage(container, "音声");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(railCurrent(container)).toBe("背景情報");
    expect(container.querySelector("#rec-flow")).not.toBeNull();
  });
});

describe("新しい案件", () => {
  it("案件名だけで作り、録音のページを文章の録音にすると工程 1 が「文章」の版 1 になる（工程のモデルは作ったときの設定）", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    bridge.settings = normalizeSettings({ transcription: { language: "en" } });
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "運営会議 10/21");
    const stored = bridge.byName("運営会議 10/21");
    expect(stored.project.id).not.toBe("");
    // 案件情報は固有名詞・背景情報だけ（話者人数・言語は録音ごと。#18566 P3）
    expect(stored.project.info).toEqual({ terms: [], background: "" });
    await addPage(container, "音声");
    await seedText(bridge, container, "今日の議題は三つです。");
    const page = stored.project.pages!.find((entry) => entry.kind === "rec")!;
    const recording = bridge.recording(stored.project.id, page.id);
    expect(recording.transcript).toBe("今日の議題は三つです。\n");
    expect(recording.versions[SOURCE_STEP_ID]).toHaveLength(1);
    expect(recording.runs[0]).toMatchObject({ kind: "save", stepId: SOURCE_STEP_ID, stepName: "文章", version: 1 });
    // 録音の言語は設定の文字起こしの言語、話者は自動、参考は無し
    expect(recording.recording).toMatchObject({ speakers: "auto", language: "en", refs: [] });
    // 作成時のフローと、工程ごとに解決したモデルを写して持つ
    const firstStep = bridge.flow!.steps[0]!.id;
    expect(recording.recording.flowSnapshot.revision).toBe(1);
    expect(recording.recording.flowSnapshot.models[firstStep]).toMatchObject({ provider: "claude", model: "claude-sonnet-4-6", effort: "low", profileName: "軽量" });
    // まだ無い工程の行は出さない（成果物はできている工程と実行中の工程だけ）
    expect(railChildren(container)).toEqual(["文章"]);
    expect(hasOutputRow(container, "文字起こし修正")).toBe(false);
    expect(button(container, "続きを作成").disabled).toBe(false);
  });

  it("名前が空でも無題のフォルダを作る", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge);
    const { container } = screen;
    await newFolder(container);
    expect(bridge.projects.size).toBe(1);
    expect([...bridge.projects.values()][0]!.project.name).toBe("");
    expect(railItem(container, "無題のフォルダ")).toBeTruthy();
  });
});

describe("制作", () => {
  it("工程を実行すると残りの工程を順に実行して版が増え、成果物が子ページとしてレールに並ぶ（済の数・会話の欄・完了）", async () => {
    const { bridge, stored, flow, id } = await bridgeWithTextProject();
    bridge.turnScript = (_request, call) => [{ type: "TextDelta", text: "## 事実\n\n- 三年目" }, done(`## 成果物 ${call + 1}\n\n- 「三年目です」`)];
    screen = await renderApp(bridge);
    const { container } = screen;
    // 録音の行（済の数）は無く、成果物がフォルダの直下に並ぶ（#18914）
    expect(railCurrent(container)).toBe("背景情報");
    expect(railChildren(container)).toEqual(["文章"]);
    await click(button(container, "続きを作成"));
    expect(bridge.turnRequests).toHaveLength(3);
    expect(bridge.turnRequests[0]?.user_prompt).toContain("## 文章");
    expect(stored.artifacts[id("発言の抽出")]).toBe("## 成果物 1\n\n- 「三年目です」\n");
    expect(flow.steps.map((step) => stored.versions[step.id]?.length)).toEqual([1, 1, 1]);
    expect(bridge.locks.size).toBe(0);
    expect(railChildren(container)).toEqual(["文章", "発言の抽出", "インサイト", "次の打ち手"]);
    // 行頭は工程の番号でなく文書の印（#18915）
    expect(railFolder(container, "朝市 インタビュー").querySelectorAll(".trow.out .n")).toHaveLength(0);
    expect(railFolder(container, "朝市 インタビュー").querySelectorAll(".trow.out .ti .ic svg")).toHaveLength(4);
    expect(container.querySelector(".runbar .note")?.textContent).toMatch(/^\d+\/\d+ \d\d:\d\d に完了$/);
    expect(button(container, "すべて再実行")).toBeTruthy();
    // 会話の欄は最後の実行（▶ の行に モデル · 思考量 · 送る量）
    expect(container.querySelector(".step-msg")?.textContent).toContain("▶ 次の打ち手を実行");
    expect(container.querySelector(".step-msg small")?.textContent).toMatch(/ · 約 \d/);
    expect(container.textContent).toContain("次の打ち手 版 1 を保存しました");
    // 子ページ
    await click(railItem(container, "発言の抽出"));
    expect(container.querySelector(".sheet h1.ptitle")?.textContent).toBe("発言の抽出");
    expect(await shownVersion(container)).toBe("第 1 版");
  });

  it("続きを頼んだ回数と、未ログインの文言を会話の欄と実行の帯の下に出す", async () => {
    const { bridge, stored, id } = await bridgeWithTextProject();
    bridge.turnScript = (_request, call) =>
      call === 0
        ? [done("前半の段落です。", "MaxTokens", "sess-1")]
        : call === 1
          ? [done("後半の段落です。")]
          : [{ type: "Error", reason_code: "CliLoginRequired", message: "このMacの Claude Code にログインしていません。" }];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "続きを作成"));
    expect(stored.artifacts[id("発言の抽出")]).toBe("前半の段落です。後半の段落です。\n");
    expect(stored.artifacts[id("インサイト")]).toBeUndefined();
    expect(container.querySelector(".runnotice.err")?.textContent).toBe("このMacの Claude Code にログインしていません。");
    expect(container.querySelector(".op.fail")?.textContent).toBe("このMacの Claude Code にログインしていません。");
    // 続きの回数は、その工程の子ページの履歴に
    await click(railItem(container, "発言の抽出"));
    await click(container.querySelector('[aria-label="履歴"]')!);
    expect(container.querySelector(".pop.hist")?.textContent).toContain("続き 1 回");
  });

  it("止めると途中までを版にせず、会話の欄に「途中まで」として残す", async () => {
    const { bridge, stored, id } = await bridgeWithTextProject();
    bridge.turnScript = () => [{ type: "TextDelta", text: "## 事実\n\n- 書きかけ" }, done("## 事実\n\n- 書きかけ", "Stopped")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "続きを作成"));
    expect(bridge.turnRequests).toHaveLength(1);
    expect(stored.artifacts[id("発言の抽出")]).toBeUndefined();
    expect(container.querySelector(".op.stopped")?.textContent).toBe("止めました。途中までを残しています。");
    expect(container.querySelector(".runnotice.help")?.textContent).toBe("止めました。途中までを残しています。");
    const partial = container.querySelector<HTMLDetailsElement>("details.partial")!;
    expect(partial.querySelector("summary")?.textContent).toBe("途中まで（13 字）");
    await openPartial(partial);
    expect(partial.querySelector(".partial-doc li")?.textContent).toBe("書きかけ");
  });

  it("時間切れは理由を出し、途中までを残す", async () => {
    const { bridge, stored, id } = await bridgeWithTextProject();
    bridge.turnScript = () => [
      { type: "TextDelta", text: "書きかけの段落" },
      { type: "Error", reason_code: "Timeout", message: reasonMessage("Timeout") },
    ];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "続きを作成"));
    expect(container.querySelector(".op.fail")?.textContent).toBe(reasonMessage("Timeout"));
    expect(container.querySelector("details.partial summary")?.textContent).toBe("途中まで（7 字）");
    expect(stored.artifacts[id("発言の抽出")]).toBeUndefined();
    expect(Object.values(stored.checkpoints)[0]).toMatchObject({ state: "failed", endReason: "Timeout", output: "書きかけの段落" });
  });

  it("同じ案件が実行中（ロックが取れない）なら実行しない", async () => {
    const { bridge, project } = await bridgeWithTextProject();
    bridge.turnScript = () => [done("本文")];
    bridge.locks.add(project.id);
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "続きを作成"));
    expect(bridge.turnRequests).toHaveLength(0);
    expect(container.querySelector(".failure-band .fb-msg")?.textContent).toBe("実行中の録音があります。終わってから、もう一度実行してください。");
  });

  it("前の工程のページを作り直すと、後ろの工程のページの本文の上に「元にしたページが変わりました。」が出る", async () => {
    const { bridge, stored, flow } = await bridgeWithTextProject();
    let count = 0;
    bridge.turnScript = () => [done(`成果物 ${++count}`)];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "続きを作成"));
    expect(Object.keys(stored.artifacts).sort()).toEqual(flow.steps.map((step) => step.id).sort());
    // 元が変わった知らせは録音から作ったページの本文の上の 1 行と「作り直す」（背景情報のページには作ったページの列を置かない。#18914・#18915）
    const stalePages = async () => {
      const names: string[] = [];
      for (const name of ["発言の抽出", "インサイト", "次の打ち手"]) {
        await click(railItem(container, name));
        expect(container.querySelector(".pmeta .pill.warn")).toBeNull();
        if (container.querySelector(".cloud-banner")?.textContent === "元にしたページが変わりました。作り直す") names.push(name);
      }
      return names;
    };
    expect(await stalePages()).toEqual([]);
    // 最初の工程を作り直す
    await click(railItem(container, "発言の抽出"));
    await rebuild(container);
    expect(await stalePages()).toEqual(["インサイト", "次の打ち手"]);
  });

  it("履歴の古い版は読むだけで開き、「この版に戻す」で新しい版（版 N から）になる（#18912）", async () => {
    const { bridge, stored, flow, id } = await bridgeWithTextProject();
    await seedRun(bridge, stored.project.id, flow.steps[0]!, "抽出 1\n");
    bridge.turnScript = () => [done("抽出 2")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "発言の抽出"));
    await rebuild(container);
    expect(await shownVersion(container)).toBe("第 2 版");
    // 保存のボタンは置かない
    expect([...container.querySelectorAll("button")].some((element) => element.textContent?.includes("版を保存"))).toBe(false);
    await click(container.querySelector('[aria-label="履歴"]')!);
    const rows = [...container.querySelectorAll(".hrow")];
    expect(rows.map((row) => row.querySelector("b")?.textContent)).toEqual(["版 2現在版", "版 1"]);
    await click(rows[1]!);
    expect(await shownVersion(container)).toBe("第 1 版");
    // 読むだけ: 本文は編集できず、本文の上に 1 行
    expect(artifactEditor(container).isEditable).toBe(false);
    expect(artifactEditor(container).getText()).toContain("抽出 1");
    expect(container.querySelector(".version-view .note")?.textContent).toBe("版 1 を表示中");
    await click(button(container.querySelector<HTMLElement>(".version-view")!, "この版に戻す"));
    expect(stored.versions[id("発言の抽出")]).toEqual(["抽出 1\n", "抽出 2\n", "抽出 1\n"]);
    expect(stored.runs.at(-1)).toMatchObject({ kind: "save", version: 3, restoredFrom: 1 });
    expect(stored.runs.at(-1)?.auto).toBeUndefined();
    expect(await shownVersion(container)).toBe("第 3 版");
    expect(container.querySelector(".version-view")).toBeNull();
    await until(() => artifactEditor(container).isEditable);
    await click(container.querySelector('[aria-label="履歴"]')!);
    expect([...container.querySelectorAll(".hrow .d")].map((element) => element.textContent)).toEqual([
      "版 1 から",
      "発言の抽出を実行",
      "発言の抽出を実行",
    ]);
    screen.unmount();
    screen = null;
    await until(() => bridge.protectedPaths(stored.project.id).length === 0);
  });

  it("「この版に戻す」は戻す前に直した内容も版に残す（before_restore）", async () => {
    const { bridge, stored, flow, id } = await bridgeWithTextProject();
    await seedRun(bridge, stored.project.id, flow.steps[0]!, "抽出 1\n");
    bridge.turnScript = () => [done("抽出 2")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "発言の抽出"));
    await rebuild(container);
    await until(() => artifactEditor(container).getText().includes("抽出 2"));
    await typeBody(container, "・戻す前の直し");
    await click(container.querySelector('[aria-label="履歴"]')!);
    await click([...container.querySelectorAll(".hrow")][1]!);
    expect(artifactEditor(container).getText()).not.toContain("戻す前の直し");
    await click(button(container.querySelector<HTMLElement>(".version-view")!, "この版に戻す"));
    const versions = stored.versions[id("発言の抽出")]!;
    expect(versions).toHaveLength(4);
    expect(versions[2]).toContain("戻す前の直し");
    expect(versions[3]).toBe("抽出 1\n");
    expect(stored.runs.at(-2)).toMatchObject({ kind: "save", version: 3, auto: true });
    expect(stored.runs.at(-1)).toMatchObject({ kind: "save", version: 4, restoredFrom: 1 });
    // 戻した本文を出す（戻す前の書きかけで隠さない）
    await until(() => artifactEditor(container).isEditable);
    expect(artifactEditor(container).getText()).toContain("抽出 1");
    expect(artifactEditor(container).getText()).not.toContain("戻す前の直し");
    expect(stored.artifacts[id("発言の抽出")]).toBe("抽出 1\n");
  });

  it("古い版の表示中は書き出しだけを残し、「現在版に戻る」で現在版の本文へ戻る", async () => {
    const { bridge, stored, flow } = await bridgeWithTextProject();
    await seedRun(bridge, stored.project.id, flow.steps[0]!, "抽出 1\n");
    bridge.turnScript = () => [done("抽出 2")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "発言の抽出"));
    await rebuild(container);
    await click(container.querySelector('[aria-label="履歴"]')!);
    await click([...container.querySelectorAll(".hrow")][1]!);
    expect(await shownVersion(container)).toBe("第 1 版");

    expect(pageMenuItems(await openPageMenu(container))).toEqual(["書き出し"]);
    expect(container.querySelector(".version-view .note")?.textContent).toBe("版 1 を表示中");
    expect(stored.artifacts[stepIdOf(bridge.flow!, "発言の抽出")]).toBe("抽出 2\n");

    await click(button(container.querySelector<HTMLElement>(".version-view")!, "現在版に戻る"));
    expect(await shownVersion(container)).toBe("第 2 版");
    expect(container.querySelector(".version-view")).toBeNull();
    expect(artifactEditor(container).getText()).toContain("抽出 2");
    // 履歴の現在版の行を選んでも同じ（古い版を開き直してから）
    await click(container.querySelector('[aria-label="履歴"]')!);
    await click([...container.querySelectorAll(".hrow")][1]!);
    await click(container.querySelector('[aria-label="履歴"]')!);
    await click(container.querySelector('.hrow .pill')!.closest(".hrow")!);
    expect(await shownVersion(container)).toBe("第 2 版");
    // 戻さずに閉じたので版は増えない
    expect(stored.versions[stepIdOf(bridge.flow!, "発言の抽出")]).toHaveLength(2);
  });

  it("書き出しのコピー", async () => {
    const { bridge } = await bridgeWithTextProject();
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(outputRow(container, "文章"));
    // 書き出しはタイトルバーの ⋯ の「書き出し ›」（owner 2026-10-18・#18941）
    await exportFromMenu(container, "コピー");
    expect(bridge.copied).toEqual(["[00:00:08] 朝市に出して三年目です。\n"]);
  });
});

describe("文字起こしの話者名", () => {
  it("2つの録音で同じ版・話者番号の名前を分け、遅い保存完了が切替先のdraftを消さない", async () => {
    const { bridge, project, project2, first, second, source } = await bridgeWithSpeakerPages();
    const originalSave = bridge.saveArtifact.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    bridge.saveArtifact = async (...args) => {
      if (args[0].recordingId === first.id && args[1] === SOURCE_STEP_ID) await gate;
      return originalSave(...args);
    };
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(outputRow(container, "文章"));
    await click(container.querySelector('[aria-label="話者1の名前"]')!);
    await click(button(container.querySelector<HTMLElement>(".speaker-menu")!, "田中"));

    // 保存を待つ間に別の録音（別のフォルダの音声）へ移り、その録音を直す（書きかけ）。
    await openAudio(container, "2回目の録音");
    await click(outputRow(container, "文章"));
    expect(container.querySelector('[aria-label="話者1の名前"]')).not.toBeNull();
    expect(bridge.recording(project2.id, second.id).runs.at(-1)?.transcriptSpeakerNames).toBeUndefined();
    await typeBody(container, "切替先の書きかけ");
    expect(container.querySelector(".doc")?.textContent).toContain("切替先の書きかけ");

    await act(async () => release());
    await flush();
    expect(container.querySelector(".doc")?.textContent).toContain("切替先の書きかけ");
    expect(bridge.recording(project.id, first.id).runs.at(-1)).toMatchObject({
      version: 2,
      transcriptSpeakerNames: { "1": "田中" },
    });
    // 切替先の書きかけは自動保存で今の文書に書く（版は作らない）
    await until(() => bridge.recording(project2.id, second.id).transcript?.includes("切替先の書きかけ") ?? false);
    expect(bridge.recording(project2.id, second.id).versions[SOURCE_STEP_ID]).toHaveLength(2);
  });

  it("候補を選ぶと未保存本文を含む全段落のラベルだけを変えて新しい版にし、名前を外すと番号へ戻す", async () => {
    const { bridge, stored, source } = await bridgeWithSpeakerProject();
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSource(container);
    await click(container.querySelector('[aria-label="話者1の名前"]')!);
    await click(button(container.querySelector<HTMLElement>(".speaker-menu")!, "田中"));
    expect(stored.versions[SOURCE_STEP_ID]?.[0]).toBe(source);
    expect(stored.versions[SOURCE_STEP_ID]?.[1]).toContain("[00:00:01] 田中: 最初です。話者1: は本文です。");
    expect(stored.versions[SOURCE_STEP_ID]?.[1]).toContain("[00:00:20] 田中: 二度目です。");
    expect(stored.runs.at(-1)).toMatchObject({ version: 2, transcriptSpeakerNames: { "1": "田中" } });
    expect(stored.transcript).toContain("話者10: 十番です。");
    expect(stored.transcript).toContain("田中: 最初です。話者1: は本文です。");

    await click(container.querySelector('[aria-label="田中の名前"]')!);
    await click(button(container.querySelector<HTMLElement>(".speaker-menu")!, "名前を外す"));
    expect(stored.transcript).toBe(source.trimEnd());
    expect(stored.runs.at(-1)).toMatchObject({ version: 3, transcriptSpeakerNames: {} });
  });

  it("自由入力は IME 変換中の Enter では送らず、確定後の Enter で同じ検証を通して保存する", async () => {
    const { bridge, stored } = await bridgeWithSpeakerProject({ terms: [] });
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSource(container);
    await click(container.querySelector('[aria-label="話者1の名前"]')!);
    await click(button(container.querySelector<HTMLElement>(".speaker-menu")!, "入力…"));
    const input = container.querySelector<HTMLInputElement>('.speaker-menu input[aria-label="名前"]')!;
    await typeInto(input, "佐藤");
    const composing = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(composing, "isComposing", { value: true });
    await act(async () => input.dispatchEvent(composing));
    await flush();
    expect(stored.versions[SOURCE_STEP_ID]).toHaveLength(1);
    expect(container.querySelector(".speaker-menu")).not.toBeNull();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await flush();
    expect(stored.runs.at(-1)).toMatchObject({ transcriptSpeakerNames: { "1": "佐藤" } });
  });

  it("Markdown の特殊記号を含む名前も文字として表示し、解除できる", async () => {
    const special = "$1（司会）(A)*_`";
    const { bridge, stored, source } = await bridgeWithSpeakerProject({ terms: [special] });
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSource(container);
    await click(container.querySelector('[aria-label="話者1の名前"]')!);
    await click(button(container.querySelector<HTMLElement>(".speaker-menu")!, special));
    expect(stored.transcript).toContain("\\$1（司会）\\(A\\)\\*\\_\\`: 最初です。");
    const roundTripped = docToMarkdown(markdownToDoc(stored.transcript!));
    expect(renameTranscriptSpeakerLabel(roundTripped, special, "話者1")).toContain("話者1: 最初です。");
    expect(container.querySelector(`[aria-label="${special}の名前"]`)).not.toBeNull();
    await click(container.querySelector(`[aria-label="${special}の名前"]`)!);
    await click(button(container.querySelector<HTMLElement>(".speaker-menu")!, "名前を外す"));
    expect(stored.transcript).toBe(source.trimEnd());
  });

  it("保存失敗では変換前の未保存本文と元のピルを残し、同じ操作を再試行できる", async () => {
    const { bridge, project, stored, source } = await bridgeWithSpeakerProject();
    await bridge.saveArtifact(rootRef(project.id), SOURCE_STEP_ID, true, source.replace("最初です", "最新です"), {
      id: "save-latest",
      kind: "save",
      at: "2026-10-15T00:01:00.000Z",
      stepId: SOURCE_STEP_ID,
      stepName: "文字起こし",
      version: null,
      result: "saved",
    });
    const originalSave = bridge.saveArtifact.bind(bridge);
    let fail = true;
    bridge.saveArtifact = async (...args) => {
      if (fail && args[1] === SOURCE_STEP_ID) {
        fail = false;
        throw { code: "store_write_failed", message: "保存できませんでした。" };
      }
      return originalSave(...args);
    };
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSource(container);
    expect(container.querySelector(".doc")?.textContent).toContain("話者1: 最新です。");
    await typeBody(container, "未保存の直し");
    await click(container.querySelector('[aria-label="話者1の名前"]')!);
    await click(button(container.querySelector<HTMLElement>(".speaker-menu")!, "田中"));
    expect(stored.versions[SOURCE_STEP_ID]).toHaveLength(2);
    // 変換前の未保存本文と元のピルを残す
    expect(container.querySelector(".doc")?.textContent).toContain("話者1: 最新です。");
    expect(container.querySelector(".doc")?.textContent).toContain("未保存の直し");
    expect(container.querySelector('[aria-label="話者1の名前"]')).not.toBeNull();

    // 同じ操作を再試行できる（直していた本文ごと、名前の付いた新しい版にする）
    await click(container.querySelector('[aria-label="話者1の名前"]')!);
    await click(button(container.querySelector<HTMLElement>(".speaker-menu")!, "田中"));
    expect(stored.versions[SOURCE_STEP_ID]).toHaveLength(3);
    expect(stored.versions[SOURCE_STEP_ID]![2]).toContain("田中: 二度目です。");
    expect(stored.versions[SOURCE_STEP_ID]![2]).toContain("未保存の直し");
    expect(stored.runs.at(-1)).toMatchObject({ transcriptSpeakerNames: { "1": "田中" } });
    expect(stored.runs.at(-1)?.restoredFrom).toBeUndefined();
  });

  it("保存中に別案件へ移って完了しても、その案件に残る未保存本文を消さない", async () => {
    const { bridge, project: first, source } = await bridgeWithSpeakerProject();
    const flow = bridge.flow!;
    const second = await bridge.createProject(
      {
        ...textProject(flow, "別の話者テスト"),
        info: { speakers: "2", language: "ja", terms: [{ term: "田中", reading: "", variants: [], note: "" }], background: "" },
        source: { kind: "audio", audio: [] },
      },
      source,
      {
        id: "run-source-2",
        kind: "run",
        at: "2026-10-15T00:00:00.000Z",
        stepId: SOURCE_STEP_ID,
        stepName: "文字起こし",
        version: null,
        result: "saved",
        provider: "deepgram",
      },
      ["/a/second.m4a"],
    );
    await bridge.saveArtifact(rootRef(second.id), SOURCE_STEP_ID, true, source.replace("最初です", "別案件の最新版です"), {
      id: "save-second-latest",
      kind: "save",
      at: "2026-10-15T00:01:00.000Z",
      stepId: SOURCE_STEP_ID,
      stepName: "文字起こし",
      version: null,
      result: "saved",
    });
    const originalSave = bridge.saveArtifact.bind(bridge);
    screen = await renderApp(bridge);
    const { container } = screen;
    const projectButton = (name: string) =>
      [...container.querySelectorAll<HTMLButtonElement>(".ti.case")].find((item) => item.querySelector(".t")?.textContent === name)!;
    // フォルダの音声は背景情報のページ（録音の行は無い。#18914）
    const folderRecording = (name: string) => infoItem(container, name);

    await click(projectButton("別の話者テスト"));
    await click(folderRecording("別の話者テスト"));
    await openSource(container);
    await typeBody(container, "別案件の書きかけ");
    expect(container.querySelector(".doc")?.textContent).toContain("別案件の書きかけ");

    await click(projectButton("話者テスト"));
    await click(folderRecording("話者テスト"));
    await openSource(container);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    bridge.saveArtifact = async (...args) => {
      if (args[0].projectId === first.id && args[0].recordingId === "root" && args[1] === SOURCE_STEP_ID) await gate;
      return originalSave(...args);
    };
    await click(container.querySelector('[aria-label="話者1の名前"]')!);
    const candidate = button(container.querySelector<HTMLElement>(".speaker-menu")!, "田中");
    await act(async () => {
      candidate.click();
      candidate.click();
    });
    await flush();
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="直したいこと"]')?.disabled).toBe(true);
    await click(projectButton("別の話者テスト"));
    await click(folderRecording("別の話者テスト"));
    await openSource(container);
    await act(async () => release());
    await flush();
    expect(container.querySelector(".doc")?.textContent).toContain("別案件の書きかけ");
    expect(bridge.byName("話者テスト").versions[SOURCE_STEP_ID]).toHaveLength(2);
  });

  it("AIと作るの処理中は話者名を変更できない", async () => {
    const { bridge, stored } = await bridgeWithSpeakerProject();
    let release!: () => void;
    bridge.chatGate = new Promise<void>((resolve) => (release = resolve));
    bridge.chatScript = () => [{ type: "TextDelta", text: "確認中" }, done("確認しました")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSource(container);
    const composer = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="直したいこと"]')!;
    await typeInto(composer, "確認して");
    await click(container.querySelector('button[aria-label="送信"]')!);
    const pill = container.querySelector<HTMLButtonElement>('[aria-label="話者1の名前"]')!;
    expect(pill.disabled).toBe(true);
    await click(pill);
    expect(container.querySelector(".speaker-menu")).toBeNull();
    expect(stored.versions[SOURCE_STEP_ID]).toHaveLength(1);
    await act(async () => release());
    await flush();
  });

  it("古い版に戻すとその版の名前対応を継承し、新しい版にする", async () => {
    const { bridge, project, stored, source } = await bridgeWithSpeakerProject();
    await bridge.saveArtifact(rootRef(project.id), SOURCE_STEP_ID, true, source.replaceAll("話者1:", "田中:"), {
      id: "save-named",
      kind: "save",
      at: "2026-10-15T00:01:00.000Z",
      stepId: SOURCE_STEP_ID,
      stepName: "文字起こし",
      version: null,
      result: "saved",
      transcriptSpeakerNames: { "1": "田中" },
    });
    await bridge.saveArtifact(rootRef(project.id), SOURCE_STEP_ID, true, source.replaceAll("話者1:", "佐藤:"), {
      id: "save-newer-name",
      kind: "save",
      at: "2026-10-15T00:02:00.000Z",
      stepId: SOURCE_STEP_ID,
      stepName: "文字起こし",
      version: null,
      result: "saved",
      transcriptSpeakerNames: { "1": "佐藤" },
    });
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSource(container);
    await click(container.querySelector('[aria-label="履歴"]')!);
    await click([...container.querySelectorAll(".hrow")][1]!);
    // 古い版を表示中は話者名を変えない（読むだけ）
    expect(container.querySelector<HTMLButtonElement>('[aria-label="田中の名前"]')?.disabled).toBe(true);
    await click(button(container.querySelector<HTMLElement>(".version-view")!, "この版に戻す"));
    expect(stored.runs.at(-1)).toMatchObject({ version: 4, restoredFrom: 2, transcriptSpeakerNames: { "1": "田中" } });
  });

  it("Deepgram の複数音声で Part がない版は命名を出さず、Gemini の録音全体 ID は止めない", async () => {
    const deepgram = await bridgeWithSpeakerProject({ provider: "deepgram", audioCount: 2 });
    screen = await renderApp(deepgram.bridge);
    await openSource(screen.container);
    expect(screen.container.querySelector(".speaker-unavailable")?.textContent).toContain("音声ごとの区切りがないこの版では名前を付けられません");
    expect(screen.container.querySelector(".speaker-pill")).toBeNull();
    screen.unmount();
    screen = null;

    const gemini = await bridgeWithSpeakerProject({ provider: "gemini", audioCount: 2 });
    screen = await renderApp(gemini.bridge);
    await openSource(screen.container);
    expect(screen.container.querySelector(".speaker-unavailable")).toBeNull();
    expect(screen.container.querySelector('[aria-label="話者1の名前"]')).not.toBeNull();
  });
});

describe("文字起こし", () => {
  it("音声のある案件は工程 1 を この Mac で文字起こしし、時刻付きの版 1 にする", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    bridge.flow = flow;
    bridge.audioDurationSec = 95;
    await bridge.createProject({ ...textProject(flow, "運営会議"), source: { kind: "audio", audio: [] } }, null, null, ["/a/m.m4a"]);
    bridge.transcribeResult = [{ jsonl: '{"type":"segment","start":2,"end":6.5,"text":"今日は集まっていただきありがとうございます。"}\n', durationSec: 95 }];
    bridge.turnScript = () => [done("議事録")];
    screen = await renderApp(bridge);
    const { container } = screen;
    // 背景情報のページの「音声」: 音声の行（名前・長さ）
    expect(railCurrent(container)).toBe("背景情報");
    expect(container.querySelector(".afile .nm")?.textContent).toBe("m.m4a");
    expect(container.querySelector(".afile .d")?.textContent).toBe("1:35");
    await click(button(container, "文書作成を開始"));
    const stored = bridge.byName("運営会議");
    expect(stored.transcript).toBe("[00:00:02] 今日は集まっていただきありがとうございます。\n");
    // 今の案件（root の録音）の言語は project.json の info の値
    expect(bridge.transcribeLanguages).toEqual(["ja"]);
    expect(railChildren(container)).toEqual(["文字起こし", "議事録", "共有用の要約"]);
    await click(railItem(container, "文字起こし"));
    expect(await shownVersion(container)).toBe("第 1 版");
    // 会話の欄で文字起こしの実行を開く（エンジン · 長さ）
    await click(container.querySelector('[aria-label="会話の切り替え"]')!);
    const row = [...container.querySelectorAll<HTMLElement>(".chatmenu .crow")].find((item) => item.querySelector(".d")?.textContent === "▶ 文字起こしを実行")!;
    await click(row);
    expect(container.querySelector(".step-msg small")?.textContent).toBe("この Mac · 1:35");
    expect(container.textContent).toContain("文字起こし 版 1 を保存しました");
  });

  it("この Mac の diarize 段階を話者分離として表示する", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-diarize-ui");
    bridge.flow = flow;
    bridge.audioDurationSec = 95;
    await bridge.createProject({ ...textProject(flow, "話者分離中"), source: { kind: "audio", audio: [] } }, null, null, ["/a/m.m4a"]);
    bridge.speechEvents = [{ type: "Stage", stage: "diarize", file: 0, files: 1 }];
    let release!: () => void;
    let started!: () => void;
    bridge.transcribeGate = new Promise<void>((resolve) => (release = resolve));
    const waitStarted = new Promise<void>((resolve) => (started = resolve));
    bridge.onTranscribeStarted = started;
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "文書作成を開始"));
    await waitStarted;
    expect(container.textContent).toContain("音声を変換しました");
    expect(container.textContent).toContain("話者を分けています");
    expect(container.textContent).not.toContain("文字起こししています");
    release();
    await act(async () => Promise.resolve());
  });

  it("録音のページで音声を足す・並べ替える・外す（その場で保存し、実行中は変えられない）", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    bridge.flow = flow;
    bridge.audioDurationSec = 60;
    await bridge.createProject({ ...textProject(flow, "運営会議"), source: { kind: "audio", audio: [] } }, null, null, ["/a/1.m4a"]);
    const stored = bridge.byName("運営会議");
    screen = await renderApp(bridge);
    const { container } = screen;
    const names = () => [...container.querySelectorAll(".afile .nm")].map((item) => item.textContent);
    // Finder からのドロップ（音声だけを足す）
    await act(async () => bridge.drop(["/a/memo.txt"]));
    expect(container.querySelector(".failure-band .fb-msg")?.textContent).toBe("音声ファイルではありません。ページは作りませんでした。");
    bridge.pickedAudio = ["/a/2.m4a"];
    await click(button(container, "＋ 音声を追加"));
    expect(names()).toEqual(["1.m4a", "2.m4a"]);
    // 「＋ 音声を追加」で選ぶ
    bridge.pickedAudio = ["/a/3.m4a"];
    await click(button(container, "＋ 音声を追加"));
    expect(names()).toEqual(["1.m4a", "2.m4a", "3.m4a"]);
    await click(container.querySelector('button[aria-label="3.m4aのその他"]')!);
    await click(button(container.querySelector<HTMLElement>(".afile .pop")!, "解除"));
    // アプリに写したファイルも消えるので、外す前に確かめる（やめれば何も変わらない）
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe("「3.m4a」を外しますか");
    await act(async () => bridge.drop(["/a/blocked.m4a"]));
    expect(container.querySelector(".failure-band .fb-msg")?.textContent).toBe("開いている操作を終えてから音声をドロップしてください。");
    expect(stored.project.pages ?? [{ id: ROOT_RECORDING_ID }]).toHaveLength(1);
    await click(button(container.querySelector<HTMLElement>('[role="dialog"]')!, "やめる"));
    expect(names()).toEqual(["1.m4a", "2.m4a", "3.m4a"]);
    await click(container.querySelector('button[aria-label="3.m4aのその他"]')!);
    await click(button(container.querySelector<HTMLElement>(".afile .pop")!, "解除"));
    await click(button(container.querySelector<HTMLElement>('[role="dialog"]')!, "外す"));
    expect(stored.project.source?.kind === "audio" && stored.project.source.audio.map((item) => item.name)).toEqual(["1.m4a", "2.m4a"]);
    // 上へ移動
    await click(container.querySelector('button[aria-label="2.m4aのその他"]')!);
    await click(button(container.querySelector<HTMLElement>(".afile .pop")!, "上へ移動"));
    expect(names()).toEqual(["2.m4a", "1.m4a"]);
    expect(stored.project.source?.kind === "audio" && stored.project.source.audio.map((item) => item.name)).toEqual(["2.m4a", "1.m4a"]);
    // 解除
    await click(container.querySelector('button[aria-label="1.m4aのその他"]')!);
    await click(button(container.querySelector<HTMLElement>(".afile .pop")!, "解除"));
    await click(button(container.querySelector<HTMLElement>('[role="dialog"]')!, "外す"));
    expect(names()).toEqual(["2.m4a"]);
    // 実行中は変えられない
    let release!: () => void;
    bridge.transcribeGate = new Promise<void>((resolve) => (release = resolve));
    bridge.transcribeResult = [{ jsonl: '{"type":"segment","start":1,"end":2,"text":"本文"}\n', durationSec: 30 }];
    await click(button(container, "文書作成を開始"));
    expect(button(container, "＋ 音声を追加").disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="2.m4aのその他"]')?.disabled).toBe(true);
    release();
    await until(() => stored.transcript !== null);
  });
});

describe("録音のページの音声と合計 6 時間", () => {
  it("音声を外してから足すと、取り込みには残す音声だけを渡す（外した音声は合計 6 時間に数えない）", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    bridge.flow = flow;
    bridge.audioDurationSec = 95;
    await bridge.createProject({ ...textProject(flow, "運営会議"), source: { kind: "audio", audio: [] } }, null, null, ["/a/1.m4a", "/a/2.m4a"]);
    const stored = bridge.byName("運営会議");
    const source = stored.project.source;
    const [first, second] = source?.kind === "audio" ? source.audio : [];
    screen = await renderApp(bridge);
    const { container } = screen;
    // 1 本目を外し（確かめてから）、ファイル選択で新しい音声を足す。録音のページはその場で保存する
    await click(container.querySelector(`button[aria-label="${first!.name}のその他"]`)!);
    await click(button(container.querySelector<HTMLElement>(".afile .pop")!, "解除"));
    await click(button(container.querySelector<HTMLElement>('[role="dialog"]')!, "外す"));
    bridge.pickedAudio = ["/a/3.m4a"];
    await click(button(container, "＋ 音声を追加"));
    await until(() => container.querySelectorAll(".afile .nm").length === 2 && bridge.importKeeps.length === 1);
    expect(bridge.importKeeps).toEqual([[second!.file]]);
    const saved = bridge.byName("運営会議").project.source;
    expect(saved?.kind === "audio" ? saved.audio.map((item) => item.name) : []).toEqual(["2.m4a", "3.m4a"]);
  });
});

describe("工程設計と設定", () => {
  it("最後に使った工程の保存に失敗したら既定値を進めない", async () => {
    const bridge = new FakeBridge();
    const firstFlow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    const secondFlow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-2");
    bridge.flow = firstFlow;
    await bridge.saveFlow(secondFlow);
    const created = await bridge.createProject(textProject(firstFlow, "週次の記録"), "本文\n", null, []);
    const stored = bridge.projects.get(created.id)!;
    bridge.setLastUsedFlow = async () => {
      throw new Error("保存先を書き込めません");
    };

    screen = await renderApp(bridge);
    const { container } = screen;
    await selectOption(container.querySelector<HTMLSelectElement>('#rec-flow')!, secondFlow.id);
    await until(() => stored.project.flowSnapshot?.id === secondFlow.id);
    expect(bridge.flowIndex?.lastUsed).toBe(firstFlow.id);
    expect(container.querySelector(".failure-band .fb-msg")?.textContent).toBe("録音の工程を変えましたが、次の既定に保存できませんでした。");

    // 新しい音声（新しいフォルダ）の既定は、保存できた最後に使った工程のまま
    await newFromMenu(container, "音声");
    const fresh = [...bridge.projects.values()].find((item) => item.project.id !== created.id)!;
    const added = fresh.project.pages?.find((page) => page.kind === "rec");
    expect(added).toBeTruthy();
    expect(fresh.recordings[added!.id]!.recording.flowSnapshot.id).toBe(firstFlow.id);
  });

  it("文書ガイドを直して保存する（revision が上がる。既存の案件の snapshot は変わらない）", async () => {
    const { bridge, stored } = await bridgeWithTextProject(FLOW_TEMPLATES[0]!);
    const guideBefore = stored.project.flowSnapshot!.guide;
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "工程設計"));
    expect(container.querySelector("h1")?.textContent).toBe("工程設計");
    expect([...container.querySelectorAll(".scard .top .inp")].map((input) => (input as HTMLInputElement).value)).toEqual([
      "文字起こし",
      "文字起こし修正",
      "記事方針",
      "記事本文",
    ]);
    expect(
      [...container.querySelectorAll<HTMLSelectElement>('.scard select[aria-label$="のモデル"]')].map(
        (select) => select.selectedOptions[0]?.textContent,
      ),
    ).toEqual(["軽量", "高性能", "高性能"]);
    const save = button(container, "保存");
    expect(save.disabled).toBe(true);
    await typeInto(container.querySelector(".gcard textarea")!, "## 文書の目的と読者\n直した");
    await click(button(container, "保存"));
    expect(bridge.flow?.guide).toBe("## 文書の目的と読者\n直した");
    expect(bridge.flow?.revision).toBe(2);
    expect(stored.project.flowSnapshot!.guide).toBe(guideBefore);
    expect(stored.project.flowSnapshot!.revision).toBe(1);
  });

  it("設定: Claude Code の行は crate の状態を出し、状態に合わせて 導入 → ログイン → 更新 を出す", async () => {
    const { bridge } = await bridgeWithTextProject();
    bridge.claude = {
      ...bridge.claude,
      installed: false,
      authenticated: false,
      version: null,
      cli_path: null,
      login_method: null,
      reason: "cli_not_found",
    };
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    const row = () => [...container.querySelectorAll(".prow")].find((item) => item.querySelector("b")?.textContent === "Claude Code")!;
    expect(row().textContent).toContain("未導入");
    await click(button(row() as HTMLElement, "導入"));
    expect(bridge.maintenance).toEqual(["install"]);
    expect(row().textContent).toContain("2.1.267 (Claude Code) · 未ログイン");
    expect(row().textContent).toContain("Claude Code を入れました。");
    await click(button(row() as HTMLElement, "ログイン"));
    expect(row().textContent).toContain("2.1.267 (Claude Code) · ログイン済み（Claude Max account）");
    expect(row().textContent).toContain("対応: 同じ会話での続き・思考量の指定・ツールを切った実行");
    await click(button(row() as HTMLElement, "更新"));
    expect(bridge.maintenance).toEqual(["install", "auth", "update"]);
    expect(row().textContent).toContain("Claude Code を更新しました（2.1.267 (Claude Code) → 2.1.300 (Claude Code)）。");

    bridge.maintenanceError = { code: "update_failed", message: "Claude Code を更新できませんでした。通信を確認して、もう一度お試しください。" };
    await click(button(row() as HTMLElement, "更新"));
    expect(row().querySelector(".err")?.textContent).toBe("Claude Code を更新できませんでした。通信を確認して、もう一度お試しください。");
  });

  it("設定: 古い Claude Code は更新を促し、偽物の文字起こしは案内を出す", async () => {
    const { bridge } = await bridgeWithTextProject();
    bridge.claude = { ...bridge.claude, missing_cli_flags: ["--restricted"], reason: "cli_flags_missing" };
    bridge.speechStatus = async () => ({
      found: true,
      fake: true,
      available: true,
      needsDownload: false,
      engine: "fake",
      error: null,
      notice: "文字起こしの部品が見つかりません。`npm run sidecar:build` で作ってください（今は偽物の固定の文で動いています）。",
      diarization: { state: "ready", detail: null },
    });
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    expect(container.textContent).toContain("ログイン済み（Claude Max account） · 古い版です。更新してください");
    expect(container.textContent).toContain("日本語 · 準備済み（偽物）");
    expect(container.textContent).toContain("`npm run sidecar:build` で作ってください");
  });

  it("設定: 話者分離モデルが壊れていれば再取得を案内する", async () => {
    const { bridge } = await bridgeWithTextProject();
    bridge.speechStatus = async () => ({
      found: true,
      fake: false,
      available: true,
      needsDownload: false,
      engine: "SpeechAnalyzer",
      error: "speaker diarization model checksum mismatch",
      notice: null,
      diarization: { state: "corrupt", detail: "checksum mismatch" },
    });
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    const row = [...container.querySelectorAll(".prow")].find(
      (item) => item.querySelector("b")?.textContent === "この Mac の音声認識",
    );
    expect(row?.textContent).toContain("日本語 · 要再取得");
    expect(row?.textContent).toContain("speaker diarization model checksum mismatch");
    expect(button(row as HTMLElement, "取得")).toBeTruthy();
  });

  it("設定: Claude だけの行・プロファイルのモデルと思考量・アプリの決まり・取得できない使用量", async () => {
    const { bridge, stored, id } = await bridgeWithTextProject();
    stored.runs.push({
      id: "run-x",
      kind: "run",
      at: new Date().toISOString(),
      stepId: id("発言の抽出"),
      stepName: "発言の抽出",
      version: null,
      result: "stopped",
      provider: "claude",
      inputTokens: 0,
      outputTokens: 0,
      tokensKnown: false,
      durationMs: 1000,
    });
    stored.runs.push({
      id: "run-y",
      kind: "run",
      at: new Date().toISOString(),
      stepId: id("発言の抽出"),
      stepName: "発言の抽出",
      version: null,
      result: "saved",
      provider: "claude",
      inputTokens: 400,
      outputTokens: 200,
      tokensKnown: true,
      durationMs: 1000,
    });
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    expect(container.textContent).toContain("2.1.267 (Claude Code) · ログイン済み");
    const claudeUsage = [...container.querySelectorAll(".urow")].find((row) => row.querySelector("b")?.textContent === "Claude");
    expect(claudeUsage?.textContent).toContain("2 回");
    expect(claudeUsage?.textContent).toContain("取得できません");
    expect(container.textContent).not.toContain("固定の決まり");
    expect(container.querySelector(".rules")).toBeNull();
    // 方式の 1 択（今はサブスクリプション。API キーの行・Deepgram は出ない）
    expect(container.querySelector('[aria-label="接続の方式"] button[aria-pressed="true"]')?.textContent).toBe("サブスクリプション");
    expect(container.textContent).not.toContain("API キーで使います");
    expect(container.textContent).not.toContain("Deepgram");
    await selectOption(container.querySelector('[aria-label="標準・Claudeのモデル"]')!, "opus");
    expect(activeProfiles(normalizeSettings(bridge.settings))[0]?.models.claude?.model).toBe("opus");
  });
});

describe("起動エラーからの復旧", () => {
  it("再試行と保存先選択から初期化をやり直せる", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    bridge.appPathsFailures = 1;
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(container.querySelector(".err")?.textContent).toContain("保存先を読めませんでした。");
    await click(button(container, "再試行"));
    expect(container.querySelector(".window-titlebar .tb-new")).not.toBeNull();
  });

  it("保存先を選ぶと設定を保存して再試行する", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    bridge.appPathsFailures = 1;
    bridge.pickedDocsRoot = "/Users/test/Documents/NIHO docs 2";
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "保存先を選ぶ"));
    expect((bridge.settings as { docsRoot: string }).docsRoot).toBe(bridge.pickedDocsRoot);
    expect(container.querySelector(".window-titlebar .tb-new")).not.toBeNull();
  });

  it("起動できない画面でも、取得した新しい版の「更新して再起動」を出す", async () => {
    const bridge = new FakeBridge();
    bridge.appPathsFailures = 1;
    bridge.update = { enabled: true, stagedVersion: "0.1.7" };
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(container.querySelector(".err")?.textContent).toContain("保存先を読めませんでした。");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("新しい版 0.1.7 があります");
    await click(button(container, "更新して再起動"));
    expect(bridge.restartCalls).toEqual([false]);
  });
});

describe("実行中の編集保護と停止", () => {
  it("同じ案件の情報・保存先変更を止める", async () => {
    const { bridge } = await bridgeWithTextProject();
    let release!: () => void;
    let started!: () => void;
    const waitStarted = new Promise<void>((resolve) => (started = resolve));
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.onTurnStarted = () => started();
    bridge.turnScript = () => [done("成果")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "続きを作成"));
    await waitStarted;
    // 背景情報のページは開ける（同じページ）が、題・背景情報・登場人物・固有名詞は変えられない
    expect(railItem(container, "背景情報").disabled).toBe(false);
    await click(container.querySelector(".rail .case .ti.case")!);
    expect(railCurrent(container)).toBe("背景情報");
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="タイトル"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLFieldSetElement>(".folder-fields")?.disabled).toBe(true);
    expect(container.querySelector(".folder-save .help")?.textContent).toBe("このフォルダの工程の実行か「AIと作る」の依頼が終わってから変えられます。");
    await click(button(container, "設定"));
    expect(button(container, "変更").disabled).toBe(true);
    release();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("ほかの案件の実行中は、録音ページの実行ボタンの近くに押せない理由を出す", async () => {
    const { bridge, flow } = await bridgeWithTextProject();
    await bridge.createProject(textProject(flow, "港の座談会"), "[00:00:03] 港の話です。\n", {
      id: "save-2",
      kind: "save",
      at: "2026-10-15T00:00:00.000Z",
      stepId: SOURCE_STEP_ID,
      stepName: "文章",
      version: null,
      result: "saved",
    }, []);
    let release!: () => void;
    let started!: () => void;
    const waitStarted = new Promise<void>((resolve) => (started = resolve));
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.onTurnStarted = () => started();
    bridge.turnScript = () => [done("成果")];
    screen = await renderApp(bridge);
    const { container } = screen;
    const openName = container.querySelector("button.ti.case")?.textContent ?? "";
    const otherName = openName === "港の座談会" ? "朝市 インタビュー" : "港の座談会";
    // 何も実行していないときは理由を出さない
    expect(container.textContent).not.toContain("の実行が終わると実行できます。");
    await click(button(container, "続きを作成"));
    await waitStarted;
    const otherFolder = [...container.querySelectorAll<HTMLElement>(".rail .case")]
      .find((entry) => entry.querySelector("button.ti.case")?.textContent?.includes(otherName))!;
    // ほかのフォルダの背景情報のページ（フォルダの行で開く）
    await click(otherFolder.querySelector("button.ti.case")!);
    const reason = `「${openName}」の実行が終わると実行できます。`;
    expect(button(container, "続きを作成").disabled).toBe(true);
    expect(container.querySelector(".runbar .note")?.textContent).toBe(reason);
    expect(container.querySelector(".main")?.textContent).toContain(reason);
    release();
    await until(() => bridge.locks.size === 0);
    expect(container.textContent).not.toContain("の実行が終わると実行できます。");
  });

  it("停止はAbortControllerからNative operationをcancelし、旧turn stop APIへ並走しない", async () => {
    const { bridge, stored, id } = await bridgeWithTextProject();
    let release!: () => void;
    let started!: () => void;
    const waitStarted = new Promise<void>((resolve) => (started = resolve));
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.onTurnStarted = () => started();
    bridge.turnScript = () => [{ type: "TextDelta", text: "途中" }, done("途中")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "続きを作成"));
    await waitStarted;
    await click(button(container, "止める"));
    expect(bridge.personalCalls.some((call) => call.name === "personalCancel")).toBe(true);
    expect(bridge.stoppedTurns).toHaveLength(0);
    release();
    await until(() => bridge.locks.size === 0);
    expect(stored.artifacts[id("発言の抽出")]).toBeUndefined();
    expect(button(container, "続きを作成").disabled).toBe(false);
  });
});
