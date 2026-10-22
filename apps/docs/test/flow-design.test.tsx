// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import {
  FLOW_TEMPLATES,
  GUIDE_EXTRACTION_RULES,
  SOURCE_STEP_ID,
  countChars,
  createBlankFlow,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  type Flow,
  type Project,
} from "@niho/docs-core";
import { formatChars, formatNumber } from "../src/lib/format";
import { button, buttons, click, renderApp, typeInto, type Screen } from "./dom";
import { addFlow, addPage, createProjectByName, flowRow, flowRows, openAudio, railChildren, railItem, outputRow, seedText } from "./pages";
import { FakeBridge, done } from "./fake-bridge";
import { fakeClaude } from "./fake-claude";

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

function project(flow: Flow, name: string, source: Project["source"] = { kind: "text" }): Project {
  return {
    version: 1,
    id: "",
    name,
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    info: { speakers: "2", language: "ja", terms: [], background: "" },
    source,
  };
}

function stepIdOf(flow: Flow, name: string): string {
  const step = flow.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`step not found: ${name}`);
  return step.id;
}

/** 文章の案件が 1 つある状態（議事録のテンプレート）。 */
async function bridgeWithTextProject(templateIndex = 1) {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(FLOW_TEMPLATES[templateIndex]!, "flow-1");
  bridge.flow = flow;
  const created = await bridge.createProject(project(flow, "運営会議 10/07"), "今日の議題は三つです。\n", {
    id: "save-1",
    kind: "save",
    at: "2026-10-15T00:00:00.000Z",
    stepId: SOURCE_STEP_ID,
    stepName: "文章",
    version: null,
    result: "saved",
  }, []);
  return { bridge, flow, stored: bridge.projects.get(created.id)!, id: (name: string) => stepIdOf(flow, name) };
}

async function settle() {
  for (let index = 0; index < 8; index++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function keyDown(target: Element, key: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
  await settle();
}

async function openFlowDesign(container: HTMLElement) {
  await click(button(container, "工程設計"));
  expect(container.querySelector("h1")?.textContent).toBe("工程設計");
}

/** 工程 2 以降のカード。 */
function cards(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".scard:not(.fixed)")];
}

function stepNames(container: HTMLElement): string[] {
  return cards(container).map((card) => card.querySelector<HTMLInputElement>(".top .inp")!.value);
}

function field<T extends Element = HTMLInputElement>(container: HTMLElement, label: string): T {
  const found = container.querySelector<T>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`field not found: ${label}`);
  return found;
}

function sampleRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".gcard .afile .nm")].map((element) => element.textContent ?? "");
}

function importErrors(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".gcard .ferr .err")].map((element) => element.textContent ?? "");
}

describe("工程設計: 白紙から", () => {
  it("文字起こし工程を外した設計を保存し、工程数と再表示へ反映する", async () => {
    const { bridge, flow } = await bridgeWithTextProject();
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);

    const toggle = container.querySelector<HTMLInputElement>('.transcription-choice input[type="checkbox"]');
    expect(toggle?.checked).toBe(true);
    expect(container.querySelector(".scard.fixed")).not.toBeNull();
    await click(toggle!);

    expect(toggle?.checked).toBe(false);
    expect(container.querySelector(".scard.fixed")).toBeNull();
    expect(container.querySelector(".transcription-choice .help")?.textContent).toContain("VTTファイルの原文から始めます");
    expect(container.querySelector(".flowname .cnt")?.textContent).toBe(`${flow.steps.length} 工程`);
    expect(cards(container).map((card) => card.querySelector(".num")?.textContent)).toEqual(flow.steps.map((_, index) => String(index + 1)));

    await click(button(container, "保存"));
    expect(bridge.flow?.transcription).toBe(false);
    expect(flowRows(container)[0]?.steps).toBe(`${flow.steps.length} 工程`);
    screen.unmount();
    screen = await renderApp(bridge);
    await openFlowDesign(screen.container);
    expect(screen.container.querySelector<HTMLInputElement>('.transcription-choice input[type="checkbox"]')?.checked).toBe(false);
    expect(screen.container.querySelector(".scard.fixed")).toBeNull();
  });

  it("工程のカードに「出力」（別案を作れる）の欄を出さない（最後の工程はいつでも別案を作れる）", async () => {
    const { bridge, flow } = await bridgeWithTextProject(0);
    const unchecked = { ...flow.steps.at(-1)!, output: { mode: "single" } };
    bridge.flow = { ...flow, steps: [...flow.steps.slice(0, -1), unchecked] };
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);
    expect(cards(container).length).toBe(flow.steps.length);
    for (const card of cards(container)) {
      expect(card.querySelector('input[type="checkbox"]')).toBeNull();
      expect(card.textContent).not.toContain("別案を作れる");
    }
  });

  it("白紙フローがあってもホームで起動し、録音を即作ってページ内から工程設計へ進める", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createBlankFlow("flow-blank");
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(container.querySelector(".home-page")).not.toBeNull();
    await createProjectByName(container, "朝の会");
    expect(bridge.byName("朝の会").project.pages?.map((page) => page.kind)).toEqual(["doc"]);
    await addPage(container, "音声");
    expect(button(container, "工程設計で作る")).not.toBeNull();
    expect(bridge.byName("朝の会").project.pages?.map((page) => page.kind)).toEqual(["rec", "doc"]);
  });

  it("白紙から 3 工程のフローを作り、音声 → 最後の工程が通る", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge);
    const { container } = screen;
    // フローがまだ無いので、工程設計はその場で「工程を選ぶ」を出す
    await click(button(container, "工程設計"));
    expect(container.querySelector("h1")?.textContent).toBe("工程を選ぶ");
    const blank = button(container, "白紙から");
    expect(blank.getAttribute("aria-pressed")).toBe("false");
    await click(blank);
    expect(blank.getAttribute("aria-pressed")).toBe("true");
    await click(button(container, "続ける"));
    expect(bridge.flow).toMatchObject({ name: "無題", revision: 1, steps: [] });
    expect(container.querySelector("h1")?.textContent).toBe("工程設計");
    expect(container.querySelector(".steps-empty")?.textContent).toBe(
      "工程がありません。「＋ 工程を追加」で文字起こしの次の工程を作ります。",
    );
    expect(container.querySelector(".issues")).toBeNull();
    expect(button(container, "保存").disabled).toBe(true);

    // 足した工程は名前を選んだ状態でフォーカスする。指示文はその場で書ける空の欄で、空のままでは保存しない
    await click(button(container, "＋ 工程を追加"));
    expect(stepNames(container)).toEqual(["無題の工程"]);
    expect(document.activeElement).toBe(cards(container)[0]!.querySelector(".top .inp"));
    const blankInstruction = field<HTMLTextAreaElement>(cards(container)[0]!, "無題の工程の指示文");
    expect(blankInstruction.value).toBe("");
    expect(blankInstruction.placeholder).toBe("AI への指示を書きます。例: 文字起こしから要点を箇条書きにする");
    expect(container.querySelector(".flowname .cnt")?.textContent).toBe("2 工程");
    await click(button(container, "保存"));
    expect(container.querySelector(".save-err")?.textContent).toBe("保存できません。印の付いたところを直してください。");
    expect(document.activeElement).toBe(cards(container)[0]!.querySelector("textarea"));
    expect(bridge.flow?.revision).toBe(1);

    await typeInto(cards(container)[0]!.querySelector(".top .inp")!, "要点の整理");
    await typeInto(cards(container)[0]!.querySelector("textarea")!, "文字起こしから要点を箇条書きにする。");
    await click(button(container, "＋ 工程を追加"));
    await typeInto(cards(container)[1]!.querySelector(".top .inp")!, "まとめ");
    await typeInto(cards(container)[1]!.querySelector("textarea")!, "要点の整理から 400 字のまとめを書く。");
    expect(container.querySelector(".save-err")).toBeNull();
    await click(button(container, "保存"));
    expect(bridge.flow?.revision).toBe(2);
    expect(bridge.flow?.steps.map((step) => step.name)).toEqual(["要点の整理", "まとめ"]);
    expect(bridge.flow?.steps.every((step) => /^[a-km-np-z2-9]{8}$/.test(step.id))).toBe(true);
    expect(container.querySelector(".flowname .cnt")?.textContent).toBe("3 工程");
    expect(container.querySelector(".toast")?.textContent).toBe("保存しました");

    // 音声の案件を作り、工程を実行する
    const flow = bridge.flow!;
    bridge.audioDurationSec = 95;
    await bridge.createProject(project(flow, "朝の会", { kind: "audio", audio: [] }), null, null, ["/a/m.m4a"]);
    bridge.transcribeResult = [{ jsonl: '{"type":"segment","start":2,"end":6.5,"text":"今日は三つ話します。"}\n', durationSec: 95 }];
    let count = 0;
    bridge.turnScript = () => [done(`成果物 ${++count}`)];
    screen.unmount();
    screen = await renderApp(bridge);
    await click(button(screen.container, "文書作成を開始"));
    const stored = bridge.byName("朝の会");
    expect(stored.versions[SOURCE_STEP_ID]).toEqual(["[00:00:02] 今日は三つ話します。\n"]);
    expect(stored.versions[stepIdOf(flow, "要点の整理")]).toEqual(["成果物 1\n"]);
    expect(stored.versions[stepIdOf(flow, "まとめ")]).toEqual(["成果物 2\n"]);
    expect(railChildren(screen.container)).toEqual(["文字起こし", "要点の整理", "まとめ"]);
    expect(screen.container.querySelector(".runbar .note")?.textContent).toMatch(/に完了$/);
  });
});

describe("工程設計: 偽の claude で通す", () => {
  it("議事録のテンプレートで 音声 → 議事録 → 共有用の要約 が偽の claude で通る", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    bridge.flow = flow;
    bridge.audioDurationSec = 95;
    await bridge.createProject(project(flow, "運営会議", { kind: "audio", audio: [] }), null, null, ["/a/m.m4a"]);
    bridge.transcribeResult = [{ jsonl: '{"type":"segment","start":2,"end":6.5,"text":"今日の議題は三つです。"}\n', durationSec: 95 }];
    bridge.turnScript = fakeClaude();
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "文書作成を開始"));
    const stored = bridge.byName("運営会議");
    const minutes = stored.artifacts[stepIdOf(flow, "議事録")]!;
    const summary = stored.artifacts[stepIdOf(flow, "共有用の要約")]!;
    expect(stored.transcript).toBe("[00:00:02] 今日の議題は三つです。\n");
    expect(minutes).toContain("これは偽の claude の出力です。");
    expect(bridge.turnRequests).toHaveLength(2);
    const summaryPrompt = bridge.turnRequests[1]!.user_prompt;
    expect(summaryPrompt).toContain("## 議事録");
    expect(summaryPrompt).toContain(minutes.trim());
    for (const heading of ["- 文字起こし", "- 議事録", "- 背景情報"]) expect(summary).toContain(heading);
    expect(railChildren(container)).toEqual(["文字起こし", "議事録", "共有用の要約"]);
  });
});

describe("工程設計: 文書ガイド", () => {
  it("お手本 2 本からガイドを抽出し、直した内容が次の実行の入力に入る", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    const first = "## 9月のお知らせ\n\n由比ガ浜で朝市を開きます。由比ガ浜の海の家も手伝います。";
    const second = "## 10月のお知らせ\n\n**由比ガ浜**の清掃をします。";
    bridge.pickedSamples = ["/docs/お知らせ 9月.md", "/docs/お知らせ 10月.docx"];
    bridge.sampleSources = { "/docs/お知らせ 9月.md": first, "/docs/お知らせ 10月.docx": second };
    const guide = "## 文書の目的と読者\n地域の人に向けたお知らせ。\n\n## 構成\n- 冒頭で日時と場所を書く。";
    bridge.turnScript = (request) =>
      request.system_prompt === GUIDE_EXTRACTION_RULES
        ? [done(`前置き\n<guide>\n${guide}\n</guide>\n<terms>[{"term":"由比ガ浜","reading":"ユイガハマ"},{"term":"海の家","reading":"うみのいえ"}]</terms>`)]
        : [done("## 決まったこと\n\n- 清掃の日")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);
    expect(button(container, "お手本から抽出").disabled).toBe(true);
    expect(container.querySelector(".gcard .files .help")?.textContent).toBe(
      "お手本の文書を1本以上追加すると、文書ガイドを抽出できます。",
    );
    await click(button(container, "＋ 文書を追加"));
    expect(sampleRows(container)).toEqual(["お知らせ 9月.md", "お知らせ 10月.docx"]);
    expect(container.querySelector(".gcard .files .help")).toBeNull();
    expect(container.querySelector(".gcard .afile .d")?.textContent).toBe(formatChars(countChars(first)));

    await click(button(container, "お手本から抽出"));
    const request = bridge.turnRequests[0]!;
    expect(request.system_prompt).toBe(GUIDE_EXTRACTION_RULES);
    expect(request.user_prompt).toContain(first);
    expect(request.user_prompt).toContain(second);
    expect(request).toMatchObject({ provider: "ClaudeCode", model: "claude-opus-4-8", effort: "High", resume_session: null });
    const dialog = container.querySelector<HTMLElement>(".dlg")!;
    expect(dialog.querySelector("h2")?.textContent).toBe("お手本から抽出したガイド");
    // 海の家は 1 回しか出ないので候補から落ちる
    expect(dialog.textContent).toContain("固有名詞 +1 語（今の一覧にある語は足しません）");
    expect(dialog.querySelector('[aria-label="追加する固有名詞"]')?.textContent).toContain("由比ガ浜（ゆいがはま）");
    expect(dialog.textContent).toContain("今のガイドは置き換わります。保存するまでファイルは変わりません。");
    expect(dialog.querySelector(".guide-preview")?.textContent).toBe(guide);
    await click(button(dialog, "置き換える"));
    expect(container.querySelector(".dlg")).toBeNull();
    expect([...container.querySelectorAll<HTMLInputElement>('.gl input[aria-label="表記"]')].map((input) => input.value)).toEqual(["由比ガ浜"]);
    expect(bridge.flow?.guide).not.toBe(guide);

    const guideArea = field<HTMLTextAreaElement>(container, "ガイド");
    expect(guideArea.value).toBe(guide);
    await typeInto(guideArea, `${guide}\n- 日付は「10月21日（火）」の形で書く。`);
    await click(button(container, "保存"));
    expect(bridge.flow?.guide).toContain("- 日付は「10月21日（火）」の形で書く。");
    expect(bridge.flow?.terms).toEqual([{ term: "由比ガ浜", reading: "ゆいがはま", variants: [], note: "" }]);
    expect(bridge.flow?.samples.map((sample) => sample.name)).toEqual(["お知らせ 9月.md", "お知らせ 10月.docx"]);
    expect(bridge.prunedWith.at(-1)).toEqual(bridge.flow?.samples.map((sample) => sample.id));

    // 案件と文章の録音のページを作り、工程を実行する
    await createProjectByName(container, "清掃の打ち合わせ");
    await addPage(container, "音声");
    await seedText(bridge, container, "由比ガ浜の清掃の日を決めます。");
    await click(button(container, "続きを作成"));
    const run = bridge.turnRequests[1]!;
    expect(run.system_prompt).toContain("## 文書ガイド");
    expect(run.system_prompt).toContain("- 日付は「10月21日（火）」の形で書く。");
    const info = run.user_prompt.slice(run.user_prompt.indexOf("## 背景情報"));
    expect(info).toContain("### 固有名詞");
    expect(info).toContain("由比ガ浜");
  });

  it("取り込みの失敗はファイルごと・5 本まで・ドロップは文書だけ・抽出の参照切れは名前を出して止める", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    bridge.sampleSources = {
      "/d/a.md": "本文 a",
      "/d/古い.doc": { code: "sample_unsupported", message: "この形式は取り込めません。.md・.txt・.docx・.pdf の文書を選んでください。" },
    };
    for (const name of ["b", "c", "d", "e", "f", "g"]) bridge.sampleSources[`/d/${name}.md`] = `本文 ${name}`;
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);

    bridge.pickedSamples = ["/d/a.md", "/d/古い.doc", "/d/無い.txt"];
    await click(button(container, "＋ 文書を追加"));
    expect(sampleRows(container)).toEqual(["a.md"]);
    expect(importErrors(container)).toEqual([
      "古い.doc: この形式は取り込めません。.md・.txt・.docx・.pdf の文書を選んでください。",
      "無い.txt: ファイルが見つかりません。",
    ]);

    // 6 本目は取り込まない（前の取り込みの失敗は消える）
    bridge.pickedSamples = ["/d/b.md", "/d/c.md", "/d/d.md", "/d/e.md", "/d/f.md"];
    await click(button(container, "＋ 文書を追加"));
    expect(sampleRows(container)).toEqual(["a.md", "b.md", "c.md", "d.md", "e.md"]);
    expect(importErrors(container)).toEqual(["お手本の文書は 5 本までです。"]);

    // 行の ⋯ から削除すると、未保存のお手本の本文も消える
    const firstRow = container.querySelector<HTMLElement>(".gcard .afile")!;
    await click(field(firstRow, "「a.md」のその他"));
    await click(button(firstRow, "削除"));
    expect(sampleRows(container)).toEqual(["b.md", "c.md", "d.md", "e.md"]);
    expect([...bridge.samples.values()]).not.toContain("本文 a");
    await act(async () => {
      bridge.drop(["/d/写真.png", "/d/g.md"]);
    });
    await settle();
    expect(sampleRows(container)).toEqual(["b.md", "c.md", "d.md", "e.md", "g.md"]);
    expect(importErrors(container)).toEqual([]);

    // 本文のファイルが消えたお手本は、抽出のときに名前を出して止める
    const missing = [...bridge.samples].find(([, text]) => text === "本文 c")![0];
    bridge.samples.delete(missing);
    await click(button(container, "お手本から抽出"));
    expect(container.querySelector(".gcard .gerr")?.textContent).toBe(
      "お手本の文書「c.md」の本文が見つかりません。⋯ から削除して、入れ直してください。",
    );
    expect(bridge.turnRequests).toHaveLength(0);
    expect(button(container, "お手本から抽出").disabled).toBe(false);
  });

  it("お手本の取り込み中はフローの削除操作を止める", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    bridge.pickedSamples = ["/d/new.md"];
    bridge.sampleSources["/d/new.md"] = "取り込む本文";
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const importStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const importSamples = bridge.importSamples.bind(bridge);
    bridge.importSamples = async (flowId, paths) => {
      started();
      await gate;
      return importSamples(flowId, paths);
    };
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);

    await click(button(container, "＋ 文書を追加"));
    await act(async () => importStarted);
    const deleteMenu = container.querySelector<HTMLButtonElement>('button[aria-label="「議事録」のその他"]')!;
    expect(deleteMenu.disabled).toBe(true);

    release();
    await settle();
    expect(deleteMenu.disabled).toBe(false);
  });
});

describe("工程設計: 編集", () => {
  it("保存中に加えた編集を残し、保存済みのお手本は保存まで消さない", async () => {
    const bridge = new FakeBridge();
    bridge.flow = {
      ...createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1"),
      samples: [{ id: "saved", name: "saved.md", chars: 2 }],
    };
    bridge.samples.set("flow-1/saved", "本文");
    bridge.pickedSamples = ["/d/new.md"];
    bridge.sampleSources["/d/new.md"] = "新しい本文";
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);
    await click(button(container, "＋ 文書を追加"));
    expect(sampleRows(container)).toEqual(["saved.md", "new.md"]);
    const unsavedRow = [...container.querySelectorAll<HTMLElement>(".gcard .afile")][1]!;
    await click(field(unsavedRow, "「new.md」のその他"));
    await click(button(unsavedRow, "削除"));
    expect([...bridge.samples.values()]).toEqual(["本文"]);
    const savedRow = container.querySelector<HTMLElement>(".gcard .afile")!;
    await click(field(savedRow, "「saved.md」のその他"));
    await click(button(savedRow, "削除"));
    expect([...bridge.samples.values()]).toEqual(["本文"]);

    let releaseSave: (() => void) | undefined;
    const originalSave = bridge.saveFlow.bind(bridge);
    bridge.saveFlow = async (flow) => {
      await new Promise<void>((resolve) => { releaseSave = resolve; });
      await originalSave(flow);
    };
    await typeInto(field(container, "名前"), "保存時の名前");
    await click(button(container, "保存"));
    await typeInto(field(container, "名前"), "議事録");
    await click(button(container, "＋ 文書を追加"));
    releaseSave?.();
    await settle();
    expect(bridge.flow?.name).toBe("保存時の名前");
    expect(field<HTMLInputElement>(container, "名前").value).toBe("議事録");
    expect(button(container, "保存").disabled).toBe(false);
    expect([...bridge.samples.values()]).toEqual(["新しい本文"]);
  });

  it("ガイドと指示文は開かずにその場で書ける（開く・閉じる・書くのボタンは無い）", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    bridge.flow = flow;
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);
    const main = container.querySelector<HTMLElement>("main")!;
    expect(buttons(main).filter((candidate) => ["開く", "閉じる", "書く"].includes(candidate.textContent ?? ""))).toEqual([]);
    // 全文が初めから欄に入っていて、ガイドの字数も出ている
    expect(field<HTMLTextAreaElement>(container, "ガイド").value).toBe(flow.guide);
    expect(container.querySelector(".gcount")?.textContent).toBe(`${formatNumber(countChars(flow.guide))} / 4,000 字`);
    expect(cards(container).map((card) => card.querySelector("textarea")?.value)).toEqual(flow.steps.map((step) => step.instruction));

    const policy = field<HTMLTextAreaElement>(container, "記事方針の指示文");
    await typeInto(policy, `${policy.value}\n- 見出しは 3 つまで。`);
    await click(button(container, "保存"));
    expect(bridge.flow?.steps.find((step) => step.name === "記事方針")?.instruction).toBe(
      `${flow.steps[1]!.instruction}\n- 見出しは 3 つまで。`,
    );
  });

  it("名前の重複・空の指示文・ガイドの上限を出し、直すまで保存しない", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    const saved = structuredClone(bridge.flow);
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);

    await typeInto(cards(container)[1]!.querySelector(".top .inp")!, "議事録");
    expect(cards(container)[1]!.classList.contains("issue")).toBe(true);
    expect(cards(container)[1]!.querySelector(".issues")?.textContent).toBe("⚠工程の名前「議事録」が重なっています。");
    await typeInto(cards(container)[0]!.querySelector("textarea")!, "");
    expect(cards(container)[0]!.querySelector(".issues")?.textContent).toBe("⚠「議事録」の指示文が空です。");
    await typeInto(field<HTMLTextAreaElement>(container, "ガイド"), "あ".repeat(4_001));
    expect(container.querySelector(".gcount")?.textContent).toBe("4,001 / 4,000 字 · 上限を超えています");
    expect(container.querySelector(".gcard .issues")?.textContent).toBe("⚠文書ガイドは 4,000 字までです。");
    await typeInto(field(container, "名前"), " ");
    expect(container.querySelector(".flowname + .issues")?.textContent).toBe("⚠工程設計の名前が空です。");

    await click(button(container, "保存"));
    expect(container.querySelector('.save-err[role="alert"]')?.textContent).toBe("保存できません。印の付いたところを直してください。");
    expect(bridge.flow).toEqual(saved);
    // 画面の上から見て最初の問題（名前）へ移る
    expect(document.activeElement).toBe(field(container, "名前"));

    await typeInto(field(container, "名前"), "週次の議事録 ");
    await typeInto(field<HTMLTextAreaElement>(container, "ガイド"), "## 文書の目的と読者\n短いガイド");
    await typeInto(cards(container)[1]!.querySelector(".top .inp")!, "要約");
    await typeInto(cards(container)[0]!.querySelector("textarea")!, "議事録を作る。");
    expect(container.querySelector(".save-err")).toBeNull();
    expect(container.querySelector(".issues")).toBeNull();
    await click(button(container, "保存"));
    expect(bridge.flow).toMatchObject({ name: "週次の議事録", revision: 2, guide: "## 文書の目的と読者\n短いガイド" });
    expect(bridge.flow?.steps.map((step) => [step.name, step.instruction])).toEqual([
      ["議事録", "議事録を作る。"],
      ["要約", saved.steps[1]!.instruction],
    ]);
    expect(button(container, "保存").disabled).toBe(true);
  });

  it("「＋ 追加」はテンプレート 4 つ（同格）と白紙。選ぶと新しいフローを保存して開き、元のフローは置き換えず編集中の内容も残る", async () => {
    const bridge = new FakeBridge();
    const flow: Flow = {
      ...createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1"),
      samples: [{ id: "s1", name: "お知らせ.md", chars: 120 }],
      terms: [{ term: "由比ガ浜", reading: "ゆいがはま", variants: [], note: "" }],
    };
    bridge.flow = flow;
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);
    // 今のフローをテンプレートに置き換える「テンプレート ▾」は無い
    expect(container.querySelector(".tplmenu")).toBeNull();
    expect(flowRows(container)).toEqual([{ name: "議事録", steps: "3 工程", current: true, unsaved: false }]);
    await typeInto(field(container, "名前"), "週次の議事録");
    expect(flowRows(container)[0]).toMatchObject({ name: "議事録", unsaved: true });

    await click(button(container.querySelector<HTMLElement>(".flist")!, "＋ 追加"));
    const menu = container.querySelector<HTMLElement>('[role="menu"][aria-label="追加する工程"]')!;
    expect([...menu.querySelectorAll(".mi")].map((item) => item.textContent)).toEqual([
      ...FLOW_TEMPLATES.map((template) => `${template.name}${template.steps.length + 1} 工程`),
      "白紙から",
    ]);
    await click(button(menu, "インサイト整理"));
    // 足したフローは保存して開く（元のフローのファイルは変わらない）
    const order = bridge.flowIndex!.order;
    expect(order).toHaveLength(2);
    expect(order[0]).toBe("flow-1");
    const added = bridge.flowFiles.get(order[1]!)!;
    expect(added).toMatchObject({ name: "インサイト整理", revision: 1, samples: [], terms: [] });
    expect(bridge.flowFiles.get("flow-1")).toEqual(flow);
    expect(field(container, "名前").value).toBe("インサイト整理");
    expect(stepNames(container)).toEqual(FLOW_TEMPLATES[2]!.steps.map((step) => step.name));
    expect(button(container, "保存").disabled).toBe(true);
    expect(flowRows(container).map((row) => [row.name, row.steps, row.current, row.unsaved])).toEqual([
      ["議事録", "3 工程", false, true],
      ["インサイト整理", "2 工程", true, false],
    ]);

    // 元のフローへ戻ると、編集中の名前とお手本・固有名詞が残っている
    await click(flowRow(container, "議事録"));
    expect(field(container, "名前").value).toBe("週次の議事録");
    expect(sampleRows(container)).toEqual(["お知らせ.md"]);
    expect([...container.querySelectorAll<HTMLInputElement>('.gl input[aria-label="表記"]')].map((input) => input.value)).toEqual(["由比ガ浜"]);
    expect(button(container, "保存").disabled).toBe(false);

    // 白紙は工程 1 だけ（工程を足すまで保存は通さない）。同じ名前のフローがあれば「 2」を付ける
    await addFlow(container, "白紙から");
    expect(field(container, "名前").value).toBe("無題");
    expect(container.querySelector(".steps-empty")).not.toBeNull();
    await addFlow(container, "インサイト整理");
    expect(flowRows(container).map((row) => [row.name, row.steps])).toEqual([
      ["議事録", "3 工程"],
      ["インサイト整理", "2 工程"],
      ["無題", "1 工程"],
      ["インサイト整理 2", "2 工程"],
    ]);
    expect(bridge.flowIndex?.lastUsed).toBe("flow-1");
  });

  it("⋯ の移動・つまみの ↑・複製・確かめてからの削除", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);
    expect(stepNames(container)).toEqual(["文字起こし修正", "記事方針", "記事本文"]);

    const first = cards(container)[0]!;
    await click(field(first, "その他"));
    expect(button(first, "上へ移動").disabled).toBe(true);
    await click(button(first, "下へ移動"));
    expect(stepNames(container)).toEqual(["記事方針", "文字起こし修正", "記事本文"]);
    expect(cards(container).map((card) => card.querySelector(".num")?.textContent)).toEqual(["2", "3", "4"]);

    await keyDown(field(container, "記事本文を並び替え"), "ArrowUp");
    expect(stepNames(container)).toEqual(["記事方針", "記事本文", "文字起こし修正"]);
    expect(document.activeElement).toBe(field(container, "記事本文を並び替え"));

    const policy = cards(container)[0]!;
    await click(field(policy, "その他"));
    await click(button(policy, "複製"));
    expect(stepNames(container)).toEqual(["記事方針", "記事方針のコピー", "記事本文", "文字起こし修正"]);
    const copy = cards(container)[1]!;
    expect(copy.querySelector("textarea")?.value).toBe(policy.querySelector("textarea")?.value);

    await click(field(copy, "その他"));
    await click(button(copy, "削除"));
    const dialog = container.querySelector<HTMLElement>(".dlg")!;
    expect(dialog.querySelector("h2")?.textContent).toBe("「記事方針のコピー」を削除しますか");
    expect(dialog.textContent).toContain("作成済みの録音から作ったページは消えません。");
    expect(document.activeElement?.textContent).toBe("やめる");
    expect(button(dialog, "削除する").classList.contains("stop")).toBe(true);
    await click(button(dialog, "削除する"));
    expect(stepNames(container)).toEqual(["記事方針", "記事本文", "文字起こし修正"]);
    expect(bridge.flow?.steps.map((step) => step.name)).toEqual(["文字起こし修正", "記事方針", "記事本文"]);
  });

  it("編集中の名前は設定へ移って戻っても残る", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);
    await typeInto(field(container, "名前"), "週次の議事録");
    await click(button(container, "設定"));
    expect(container.querySelector("h1")?.textContent).toBe("設定");
    await openFlowDesign(container);
    expect(field(container, "名前").value).toBe("週次の議事録");
    expect(button(container, "保存").disabled).toBe(false);
    expect(bridge.flow?.name).toBe("議事録");
  });

  it("保存していない工程設計があると、窓を閉じる前に確かめる（編集に戻る・破棄して閉じる。#18788）", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    screen = await renderApp(bridge);
    const { container } = screen;
    let closes = false;
    // 変更が無ければ確かめずに閉じる
    await act(async () => {
      closes = await bridge.requestClose();
    });
    expect(closes).toBe(true);

    await openFlowDesign(container);
    await typeInto(field(container, "名前"), "週次の議事録");
    // 画面を移っても編集中の内容は残る（窓を閉じると消えるので、確かめる対象）
    await click(button(container, "設定"));
    await act(async () => {
      closes = await bridge.requestClose();
    });
    expect(closes).toBe(false);
    const asked = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(asked.querySelector("h2")?.textContent).toBe("保存が終わっていない変更があります");
    expect(asked.textContent).toContain("工程設計「議事録」");
    expect(document.activeElement?.textContent).toBe("編集に戻る");
    expect(button(asked, "破棄して閉じる").className).toContain("stop");
    await click(button(asked, "編集に戻る"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(bridge.closedAfterRecording).toBe(0);
    await openFlowDesign(container);
    expect(field(container, "名前").value).toBe("週次の議事録");

    // もう一度閉じようとしても黙って捨てず、「破棄して閉じる」で窓を閉じ直す（今度は確かめずに閉じる）
    await act(async () => {
      closes = await bridge.requestClose();
    });
    expect(closes).toBe(false);
    await click(button(container.querySelector<HTMLElement>('[role="dialog"]')!, "破棄して閉じる"));
    expect(bridge.closedAfterRecording).toBe(1);
    await act(async () => {
      closes = await bridge.requestClose();
    });
    expect(closes).toBe(true);
    expect(bridge.flow?.name).toBe("議事録");
  });
});

describe("工程設計: 作成済みの案件", () => {
  it("古い録音はフローの変更で黙って変わらず、「今の設計に更新」で snapshot を作り直す", async () => {
    const { bridge, stored, id } = await bridgeWithTextProject();
    bridge.turnScript = () => [done("## 決まったこと\n\n- 清掃の日")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "続きを作成"));
    const minutes = stored.artifacts[id("議事録")];
    expect(minutes).toBe("## 決まったこと\n\n- 清掃の日\n");
    const snapshot = structuredClone(stored.project.flowSnapshot);
    expect(container.querySelector(".flownote")).toBeNull();

    await openFlowDesign(container);
    const instruction = cards(container)[0]!.querySelector("textarea")!;
    await typeInto(instruction, `${instruction.value}\n- 決まったことは太字にする。`);
    await typeInto(cards(container)[1]!.querySelector(".top .inp")!, "要約");
    await click(button(container, "保存"));
    expect(bridge.flow?.revision).toBe(2);
    expect(stored.project.flowSnapshot).toEqual(snapshot);
    await openAudio(container);
    expect(container.querySelector(".flownote span")?.textContent).toBe("工程設計が変わりました");

    await click(button(container, "この録音の工程を今の設計に更新"));
    const dialog = container.querySelector<HTMLElement>(".dlg")!;
    expect(dialog.querySelector("h2")?.textContent).toBe("この録音の工程を今の設計に更新しますか");
    expect([...dialog.querySelectorAll(".difflist li")].map((item) => item.textContent)).toEqual([
      "名前が変わる工程: 共有用の要約 → 要約",
      "指示文が変わる工程: 議事録",
    ]);
    await click(button(dialog, "更新する"));
    expect(container.querySelector(".dlg")).toBeNull();
    expect(stored.project.flowSnapshot!.revision).toBe(bridge.flow?.revision);
    expect(stored.project.flowSnapshot!.steps.map((step) => step.name)).toEqual(["議事録", "要約"]);
    expect(stored.artifacts[id("議事録")]).toBe(minutes);
    expect(container.querySelector(".flownote")).toBeNull();
    expect(container.querySelector(".toast")?.textContent).toBe("この録音の工程を今の設計にしました");
    // 工程のページはフォルダの直下（名前が変わった工程の行も新しい名前）。元が変わった知らせはそのページの本文の上の 1 行（#18915）
    expect(railChildren(container)).toEqual(["文章", "議事録", "要約"]);
    await click(railItem(container, "議事録"));
    expect(container.querySelector(".pmeta .pill.warn")).toBeNull();
    expect(container.querySelector(".cloud-banner")?.textContent).toBe("工程の指示が変わりました。作り直す");
    await click(railItem(container, "要約"));
    expect(container.querySelector(".cloud-banner")).toBeNull();
  });
});

describe("工程設計: URL のお手本", () => {
  it("URL の本文の写しを追加して出典と本文を確認し、抽出と保存に使える", async () => {
    const { bridge } = await bridgeWithTextProject();
    const url = "https://example.com/article";
    const text = `${"街に暮らす人を訪ねました。".repeat(15)}\n\n${"暮らしについて話を伺います。".repeat(15)}\n\n${"これからの街について考えます。".repeat(15)}`;
    bridge.sampleUrlSources[url] = { title: "街を訪ねる", text };
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);
    await typeInto(field(container, "記事 URL"), url);
    await act(async () => { field(container, "記事 URL").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await settle();
    expect(sampleRows(container)).toEqual(["街を訪ねる"]);
    expect(container.querySelector(".sample-source")?.textContent).toContain(url);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("取り込みました");
    expect(field<HTMLInputElement>(container, "記事 URL").value).toBe("");
    expect(button(container, "お手本から抽出").disabled).toBe(false);
    await click(field<HTMLButtonElement>(container, "「街を訪ねる」のその他"));
    await click(button(container, "本文を確認"));
    expect(container.querySelector('[aria-label="「街を訪ねる」の本文"]')?.textContent).toBe(text);
    await click(button(container, "本文を閉じる"));
    expect(container.querySelector(".sample-preview")).toBeNull();
    await click(button(container, "お手本から抽出"));
    expect(bridge.turnRequests.at(-1)?.user_prompt).toContain(text);
    // 抽出結果の確定にかかわらず、取り込み済みのお手本は工程設計の保存に含む。
    const dialog = container.querySelector<HTMLElement>(".dlg");
    if (dialog) await click(button(dialog, "やめる"));
    await click(button(container, "保存"));
    expect(bridge.flow?.samples[0]).toMatchObject({ name: "街を訪ねる", sourceUrl: url });
    expect(bridge.sampleUrlRequests).toEqual([url]);
  });

  it("失敗時は URL を残して日本語の理由を表示し、上限到達時は取得しない", async () => {
    const { bridge, flow } = await bridgeWithTextProject();
    const url = "https://example.com/article";
    bridge.sampleUrlSources[url] = { code: "sample_url_not_html", message: "記事の HTML を取得できませんでした。公開記事のページを指定してください。" };
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);
    await typeInto(field(container, "記事 URL"), url);
    const submit = async () => {
      await act(async () => { field(container, "記事 URL").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      await settle();
    };
    await submit();
    expect(importErrors(container)).toEqual(["記事の HTML を取得できませんでした。公開記事のページを指定してください。"]);
    expect(field<HTMLInputElement>(container, "記事 URL").value).toBe(url);
    expect(sampleRows(container)).toEqual([]);
    expect(button(container, "お手本から抽出").disabled).toBe(true);
    screen.unmount(); screen = null;
    bridge.flow = { ...flow, samples: Array.from({ length: 5 }, (_, i) => ({ id: `sample-${i}`, name: `${i}.md`, chars: 1 })) };
    bridge.sampleUrlRequests = [];
    screen = await renderApp(bridge);
    await openFlowDesign(screen.container);
    await typeInto(field(screen.container, "記事 URL"), url);
    await act(async () => { field(screen!.container, "記事 URL").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await settle();
    expect(importErrors(screen.container)).toEqual(["お手本の文書は 5 本までです。"]);
    expect(bridge.sampleUrlRequests).toEqual([]);
  });

  it("取り込み中の二重操作を防ぎ、未保存の URL お手本の削除で本文も消す", async () => {
    const { bridge } = await bridgeWithTextProject();
    const url = "https://example.com/article";
    bridge.sampleUrlSources[url] = { title: "街の記事", text: `${"本文の写し。".repeat(30)}\n\n${"第二段落。".repeat(30)}\n\n${"第三段落。".repeat(30)}` };
    const original = bridge.fetchSampleUrl.bind(bridge);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    bridge.fetchSampleUrl = async (...args) => { await wait; return original(...args); };
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);
    await typeInto(field(container, "記事 URL"), url);
    await act(async () => { field(container, "記事 URL").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(button(container, "URL から取り込む").disabled).toBe(true);
    expect(button(container, "＋ 文書を追加").disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain("取り込んでいます");
    await act(async () => release());
    await settle();
    expect(bridge.samples.size).toBe(1);
    await click(field<HTMLButtonElement>(container, "「街の記事」のその他"));
    await click(button(container, "削除"));
    expect(sampleRows(container)).toEqual([]);
    expect(bridge.samples.size).toBe(0);
  });

  it("画面を離れた後に完了した URL 取り込みの未保存本文を削除する", async () => {
    const { bridge, flow } = await bridgeWithTextProject();
    const url = "https://example.com/article";
    bridge.sampleUrlSources[url] = { title: "離脱後の記事", text: `${"本文の写し。".repeat(30)}\n\n${"第二段落。".repeat(30)}\n\n${"第三段落。".repeat(30)}` };
    const originalFetch = bridge.fetchSampleUrl.bind(bridge);
    let releaseFetch!: () => void;
    let markStarted!: () => void;
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    bridge.fetchSampleUrl = async (...args) => {
      markStarted();
      await fetchGate;
      return originalFetch(...args);
    };
    const originalSave = bridge.saveSampleUrl.bind(bridge);
    let importedSampleId: string | undefined;
    bridge.saveSampleUrl = async (...args) => {
      const sample = await originalSave(...args);
      importedSampleId = sample.id;
      return sample;
    };
    screen = await renderApp(bridge);
    const { container } = screen;
    await openFlowDesign(container);
    await typeInto(field(container, "記事 URL"), url);
    await act(async () => {
      field(container, "記事 URL").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await started;
    const mountedScreen = screen;
    mountedScreen.unmount();
    screen = null;

    await act(async () => { releaseFetch(); });
    await settle();

    expect(importedSampleId).toBeDefined();
    expect(bridge.samples.has(`${flow.id}/${importedSampleId}`)).toBe(false);
    expect(bridge.prunedWith.at(-1)).not.toContain(importedSampleId);
  });
});
