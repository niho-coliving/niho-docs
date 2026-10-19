// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  SOURCE_STEP_ID,
  buildFlowChoices,
  createBlankFlow,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  findTemplate,
  type Flow,
  type Project,
  type Recording,
  type RunRecord,
} from "@niho/docs-core";
import { button, click, renderApp, selectOption, typeInto, type Screen } from "./dom";
import { FakeBridge, done } from "./fake-bridge";
import { addFlow, addPage, flowRow, flowRowMenu, flowRows, flowSelect, newFromMenu, openAudio, railItem, until } from "./pages";

/**
 * 工程の複数化（#18567 P4）: 工程設計のフローの一覧（追加・複製・名前の変更・削除）、録音のページごとの「工程」の選択、新しい
 * 録音の既定（最後に使ったフロー）、P4 より前の flows/active.json の読み替えと移し替え。
 */

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

const minutes = (): Flow => createFlowFromTemplate(findTemplate("tpl-2")!, "flow-minutes");
const coaching = (): Flow => createFlowFromTemplate(findTemplate("tpl-4")!, "flow-coaching");

/** 保存済みのフロー（P4 の形: flows/<id>.json と index.json）を置く。 */
function putFlows(bridge: FakeBridge, flows: Flow[], lastUsed: string | null) {
  for (const flow of flows) bridge.flowFiles.set(flow.id, structuredClone(flow));
  bridge.flowIndex = { version: 1, order: flows.map((flow) => flow.id), lastUsed };
}

/** 新しい形の案件（pages を持ち、root の録音は無い）。 */
function pagedProject(name: string): Project {
  return { version: 1, id: "", name, createdAt: "2026-10-16T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] };
}

/** 今の形の案件（pages の無い project.json。案件フォルダ直下が root の録音で、文章が入っている）。 */
function legacyProject(flow: Flow, name: string): Project {
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

function newRecording(flow: Flow): Recording {
  return {
    version: 1,
    id: "",
    createdAt: "2026-10-16T01:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    source: { kind: "audio", audio: [] },
    speakers: "auto",
    language: "ja",
    refs: [],
  };
}

function saveRecord(id: string): RunRecord {
  return { id, kind: "save", at: "2026-10-16T01:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" };
}

/** 文章を貼った録音のページを足す（id を返す）。 */
async function textRecording(bridge: FakeBridge, projectId: string, flow: Flow, title: string, text: string): Promise<string> {
  const entry = await bridge.createPage(projectId, { kind: "rec", title, createdAt: "2026-10-16T01:00:00.000Z", recording: newRecording(flow) });
  await bridge.setRecordingText({ projectId, recordingId: entry.id }, text, saveRecord(`save-${entry.id}`));
  return entry.id;
}

/**
 * 開いているフォルダの成果物の行（工程の名前。できている工程と実行中の工程だけ）。フォルダの音声の成果物はレールのフォルダの直下に
 * 並ぶ（#18914）。
 */
function outputNames(container: HTMLElement): string[] {
  const folder = container.querySelector('.rail [aria-current="page"]')?.closest("div.case") ?? container;
  return [...folder.querySelectorAll(".trow.out .ti .t")].map((item) => item.textContent ?? "");
}

function dialog(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="dialog"]');
}

function nameField(container: HTMLElement): HTMLInputElement {
  return container.querySelector<HTMLInputElement>('.flowname input[aria-label="名前"]')!;
}

function optionLabels(select: HTMLSelectElement): string[] {
  return [...select.options].map((option) => option.textContent ?? "");
}

describe("P4 より前の flows/active.json", () => {
  it("1 本目として出て、今ある案件はそのまま実行できる。最初の保存で flows/<id>.json と index に移る", async () => {
    const bridge = new FakeBridge();
    const flow = minutes();
    bridge.flow = flow;
    const project = await bridge.createProject(legacyProject(flow, "朝市"), "今日の議題は三つです。\n", saveRecord("save-1"), []);
    bridge.turnScript = (_request, call) => [done(`成果物 ${call + 1}`)];
    screen = await renderApp(bridge);
    const { container } = screen;
    // 今の案件（root の録音）の工程は active.json のフロー
    expect(flowSelect(container).value).toBe("flow-minutes");
    // 手を加えていない写しを持っているテンプレート（議事録）は出さない
    expect(optionLabels(flowSelect(container))).toEqual(["議事録", "記事制作", "インサイト整理", "コーチング"]);
    await click(button(container, "続きを作成"));
    const stored = bridge.projects.get(project.id)!;
    expect(flow.steps.map((step) => stored.versions[step.id]?.length)).toEqual([1, 1]);
    // 読む・実行するだけでは移さない
    expect(bridge.flowWrites).toEqual([]);
    expect(bridge.activeFlow?.id).toBe("flow-minutes");
    expect(bridge.flowIndex).toBeNull();

    await click(button(container, "工程設計"));
    expect(flowRows(container)).toEqual([{ name: "議事録", steps: "3 工程", current: true, unsaved: false }]);
    await typeInto(container.querySelector(".gcard textarea")!, "## 文書の目的と読者\n直した");
    await click(button(container, "保存"));
    // 最初の保存で flows/<id>.json と index に移り、active.json は消える
    expect(bridge.activeFlow).toBeNull();
    expect(bridge.flowIndex).toEqual({ version: 1, order: ["flow-minutes"], lastUsed: "flow-minutes" });
    expect(bridge.flowFiles.get("flow-minutes")).toMatchObject({ revision: 2, guide: "## 文書の目的と読者\n直した" });
    // 録音は自分の snapshot のまま（同じ id のフローと比べて「今の設計に更新」を出す）
    await openAudio(container, "朝市");
    expect(stored.project.flowSnapshot?.revision).toBe(1);
    expect(container.querySelector(".flownote span")?.textContent).toBe("工程設計が変わりました");
  });
});

describe("工程設計のフローの一覧", () => {
  it("テンプレート・白紙・複製で 2 本以上作れ、名前を変え、削除できる（使っている録音の数とお手本を確かめに出す）", async () => {
    const bridge = new FakeBridge();
    const flow: Flow = { ...minutes(), samples: [{ id: "s1", name: "お知らせ.md", chars: 2 }] };
    putFlows(bridge, [flow], "flow-minutes");
    bridge.samples.set("flow-minutes/s1", "本文");
    // 議事録のフローから作った録音が 2 つ（今の案件の root と、別のフォルダの音声。1 フォルダ 1 音声。#18914）
    const legacy = await bridge.createProject(legacyProject(flow, "朝市"), "今日の議題は三つです。\n", saveRecord("save-1"), []);
    const secondFolder = await bridge.createProject(pagedProject("第2回の会"), null, null, []);
    await bridge.createPage(secondFolder.id, { kind: "rec", title: "第2回", createdAt: "2026-10-16T01:00:00.000Z", recording: newRecording(flow) });
    bridge.turnScript = (_request, call) => [done(`成果物 ${call + 1}`)];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "工程設計"));

    // テンプレートから・白紙から
    await addFlow(container, "コーチング");
    expect(flowRows(container).map((row) => [row.name, row.steps, row.current])).toEqual([
      ["議事録", "3 工程", false],
      ["コーチング", "3 工程", true],
    ]);
    expect(nameField(container).value).toBe("コーチング");
    await addFlow(container, "白紙から");
    expect(nameField(container).value).toBe("無題");

    // 複製: 「〈名前〉のコピー」を元の直後に足して開き、名前を選ぶ。お手本の本文も写す
    await flowRowMenu(container, "議事録", "複製");
    expect(flowRows(container).map((row) => [row.name, row.current])).toEqual([
      ["議事録", false],
      ["議事録のコピー", true],
      ["コーチング", false],
      ["無題", false],
    ]);
    expect(nameField(container).value).toBe("議事録のコピー");
    expect(document.activeElement).toBe(nameField(container));
    const copyId = bridge.flowIndex!.order[1]!;
    expect(bridge.flowFiles.get(copyId)).toMatchObject({ name: "議事録のコピー", revision: 1, samples: flow.samples, steps: flow.steps });
    expect(bridge.samples.get(`${copyId}/s1`)).toBe("本文");

    // 名前の変更: そのフローを開いて名前の欄にフォーカスし、保存で名前が変わる
    await flowRowMenu(container, "コーチング", "名前の変更");
    expect(flowRows(container).find((row) => row.current)?.name).toBe("コーチング");
    expect(document.activeElement).toBe(nameField(container));
    await typeInto(nameField(container), "佐藤さんのコーチング");
    expect(flowRows(container).find((row) => row.current)).toMatchObject({ name: "コーチング", unsaved: true });
    await click(button(container, "保存"));
    expect(flowRows(container).map((row) => row.name)).toEqual(["議事録", "議事録のコピー", "佐藤さんのコーチング", "無題"]);

    // 削除: 使っている録音の数とお手本を出して確かめる（やめれば何も変わらない）
    await flowRowMenu(container, "議事録", "削除");
    const confirm = dialog(container)!;
    expect(confirm.querySelector("h2")?.textContent).toBe("「議事録」を削除しますか");
    expect([...confirm.querySelectorAll(".msg")].map((item) => item.textContent)).toEqual([
      "この工程を使っている録音が 2 件あります。録音は作ったときの工程の写しで、これまでどおり実行できます。",
      "お手本の文書も削除します。",
      "元に戻せません。",
    ]);
    expect(button(confirm, "削除する").classList.contains("stop")).toBe(true);
    expect(document.activeElement?.textContent).toBe("やめる");
    await click(button(confirm, "やめる"));
    expect(bridge.flowFiles.has("flow-minutes")).toBe(true);
    await flowRowMenu(container, "議事録", "削除");
    await click(button(dialog(container)!, "削除する"));
    expect(bridge.flowFiles.has("flow-minutes")).toBe(false);
    expect(bridge.samples.has("flow-minutes/s1")).toBe(false);
    expect(bridge.samples.get(`${copyId}/s1`)).toBe("本文");
    // 開いていないフローを消しても、開いているフローはそのまま
    expect(flowRows(container).map((row) => [row.name, row.current])).toEqual([
      ["議事録のコピー", false],
      ["佐藤さんのコーチング", true],
      ["無題", false],
    ]);

    // 開いているフローを消すと隣（前）を開く。使っていない・お手本の無いフローは「元に戻せません。」だけ
    await click(flowRow(container, "無題"));
    await flowRowMenu(container, "無題", "削除");
    expect([...dialog(container)!.querySelectorAll(".msg")].map((item) => item.textContent)).toEqual(["元に戻せません。"]);
    await click(button(dialog(container)!, "削除する"));
    expect(flowRows(container).map((row) => [row.name, row.current])).toEqual([
      ["議事録のコピー", false],
      ["佐藤さんのコーチング", true],
    ]);
    expect(nameField(container).value).toBe("佐藤さんのコーチング");

    // 消したフローで作った録音は「（工程設計から削除済み）」と出し、これまでどおり実行できる（「今の設計に更新」は出さない）
    await openAudio(container, "朝市");
    expect(flowSelect(container).value).toBe("flow-minutes");
    // 「議事録のコピー」はお手本の文書を持つ（案件向けに調整した工程）ので、元の「議事録」のテンプレートは隠さない
    expect(optionLabels(flowSelect(container))).toEqual(["議事録（工程設計から削除済み）", "議事録のコピー", "佐藤さんのコーチング", "記事制作", "議事録", "インサイト整理"]);
    expect(container.querySelector(".flownote")).toBeNull();
    await click(button(container, "続きを作成"));
    const stored = bridge.projects.get(legacy.id)!;
    expect(flow.steps.map((step) => stored.versions[step.id]?.length)).toEqual([1, 1]);
  });

  it("最後のフローを消すと「工程を選ぶ」の面になる", async () => {
    const bridge = new FakeBridge();
    putFlows(bridge, [minutes()], "flow-minutes");
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "工程設計"));
    await flowRowMenu(container, "議事録", "削除");
    await click(button(dialog(container)!, "削除する"));
    expect(bridge.flowIndex).toEqual({ version: 1, order: [], lastUsed: null });
    expect(container.querySelector("h1")?.textContent).toBe("工程を選ぶ");
    expect([...container.querySelectorAll(".tcard")].map((card) => card.querySelector("b")?.textContent ?? card.textContent)).toEqual([
      "記事制作",
      "議事録",
      "インサイト整理",
      "コーチング",
      "白紙から",
    ]);
  });
});

describe("録音のページの「工程」", () => {
  it("録音のページごとに違うフローを選んで実行でき、別の録音の版・記録は増えない。成果物のある録音は確かめてから変え、やめると変わらない", async () => {
    const bridge = new FakeBridge();
    const minutesFlow = minutes();
    const coachingFlow = coaching();
    putFlows(bridge, [minutesFlow, coachingFlow], "flow-minutes");
    // 1 フォルダに録音は 1 つ（#18914）なので、フォルダ「第1回」「第2回」の音声
    const project = await bridge.createProject(pagedProject("第1回"), null, null, []);
    const project2 = await bridge.createProject(pagedProject("第2回"), null, null, []);
    const first = await textRecording(bridge, project.id, minutesFlow, "第1回", "[00:00:05] 一回目の話です。");
    const second = await textRecording(bridge, project2.id, minutesFlow, "第2回", "[00:00:05] 二回目の話です。");
    let count = 0;
    bridge.turnScript = () => [done(`成果物 ${++count}`)];
    screen = await renderApp(bridge);
    const { container } = screen;
    const firstRec = () => bridge.recording(project.id, first);
    const secondRec = () => bridge.recording(project2.id, second);

    // 第1回を議事録で実行する
    await click(railItem(container, "第1回"));
    await click(button(container, "続きを作成"));
    await until(() => (firstRec().versions[minutesFlow.steps[1]!.id]?.length ?? 0) === 1);
    const firstBefore = structuredClone({ versions: firstRec().versions, runs: firstRec().runs, artifacts: firstRec().artifacts });

    // 第2回（工程 2 以降の成果物が無い）は確かめずにすぐ変わり、最後に使ったフローもそれになる
    await click(railItem(container, "第2回"));
    expect(optionLabels(flowSelect(container))).toEqual(["議事録", "コーチング", "記事制作", "インサイト整理"]);
    await selectOption(flowSelect(container), "flow-coaching");
    expect(dialog(container)).toBeNull();
    expect(secondRec().recording.flowSnapshot).toMatchObject({ id: "flow-coaching", name: "コーチング" });
    expect(flowSelect(container).value).toBe("flow-coaching");
    // まだ実行していない工程の行は出さない
    expect(outputNames(container)).toEqual(["文章"]);
    expect(bridge.flowIndex?.lastUsed).toBe("flow-coaching");

    // コーチングの工程で実行する（依頼はコーチングの指示文）
    const before = bridge.turnRequests.length;
    await click(button(container, "続きを作成"));
    await until(() => (secondRec().versions[coachingFlow.steps[1]!.id]?.length ?? 0) === 1);
    const requests = bridge.turnRequests.slice(before);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.system_prompt).toContain(coachingFlow.steps[0]!.instruction);
    expect(requests[1]!.system_prompt).toContain(coachingFlow.steps[1]!.instruction);
    expect(outputNames(container)).toEqual(["文章", "文字起こし修正", "分析"]);
    // 第1回の版・記録・成果物は増えない
    expect({ versions: firstRec().versions, runs: firstRec().runs, artifacts: firstRec().artifacts }).toEqual(firstBefore);

    // 第1回（成果物がある）は違いを見せて確かめる。やめると変わらない
    await click(railItem(container, "第1回"));
    await selectOption(flowSelect(container), "flow-coaching");
    const confirm = dialog(container)!;
    expect(confirm.querySelector("h2")?.textContent).toBe("この録音の工程を「コーチング」にしますか");
    expect([...confirm.querySelectorAll(".difflist li")].map((item) => item.textContent)).toEqual([
      "増える工程: 文字起こし修正・分析",
      "外れる工程: 議事録・共有用の要約（作ったページは残ります）",
      "文書ガイドか固有名詞が変わります",
    ]);
    expect(confirm.querySelector(".msg")?.textContent).toBe(
      "作ったページは残ります。元にした内容が変わったページは、本文の上でお知らせします。作り直すまで中身は変わりません。",
    );
    expect(button(confirm, "工程を変える")).toBeTruthy();
    await click(button(confirm, "やめる"));
    expect(dialog(container)).toBeNull();
    expect(flowSelect(container).value).toBe("flow-minutes");
    expect(firstRec().recording.flowSnapshot.id).toBe("flow-minutes");
    expect(outputNames(container)).toEqual(["文章", "議事録", "共有用の要約"]);

    // 確かめると変わる（議事録の成果物はファイルに残り、レールの子ページから外れる。まだ無いコーチングの工程の行は出さない）
    await selectOption(flowSelect(container), "flow-coaching");
    await click(button(dialog(container)!, "工程を変える"));
    expect(firstRec().recording.flowSnapshot.id).toBe("flow-coaching");
    expect(outputNames(container)).toEqual(["文章"]);
    expect(firstRec().artifacts).toEqual(firstBefore.artifacts);
    expect(container.querySelector(".toast")?.textContent).toBe("この録音の工程を「コーチング」にしました");
  });

  it("実行中（同じ案件）は工程を変えられない", async () => {
    const bridge = new FakeBridge();
    const minutesFlow = minutes();
    putFlows(bridge, [minutesFlow, coaching()], "flow-minutes");
    const project = await bridge.createProject(pagedProject("週次の打ち合わせ"), null, null, []);
    await textRecording(bridge, project.id, minutesFlow, "第1回", "[00:00:05] 一回目の話です。");
    let release!: () => void;
    let started!: () => void;
    const waitStarted = new Promise<void>((resolve) => (started = resolve));
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.onTurnStarted = () => started();
    bridge.turnScript = () => [done("成果物")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await openAudio(container);
    expect(flowSelect(container).disabled).toBe(false);
    await click(button(container, "続きを作成"));
    await waitStarted;
    expect(flowSelect(container).disabled).toBe(true);
    release();
    await until(() => !flowSelect(container).disabled);
  });

  it("新しい録音のページの既定は最後に使ったフロー。工程の無いフローは選べない", async () => {
    const bridge = new FakeBridge();
    putFlows(bridge, [minutes(), coaching(), createBlankFlow("flow-blank")], "flow-coaching");
    const project = await bridge.createProject(pagedProject("佐藤さん"), null, null, []);
    screen = await renderApp(bridge);
    const { container } = screen;
    const stored = bridge.projects.get(project.id)!;
    const recordings = () => (stored.project.pages ?? []).filter((page) => page.kind === "rec");
    await addPage(container, "音声");
    expect(bridge.recording(project.id, recordings()[0]!.id).recording.flowSnapshot.id).toBe("flow-coaching");
    expect(flowSelect(container).value).toBe("flow-coaching");
    const blank = [...flowSelect(container).options].find((option) => option.value === "flow-blank")!;
    expect(blank.disabled).toBe(true);
    expect(blank.textContent).toBe("無題（工程がありません）");

    // この録音を議事録にすると、次の録音（新しいフォルダの音声。#18914）の既定も議事録
    await selectOption(flowSelect(container), "flow-minutes");
    expect(bridge.flowIndex?.lastUsed).toBe("flow-minutes");
    await newFromMenu(container, "音声");
    const next = [...bridge.projects.values()].find((item) => item.project.id !== project.id)!;
    const nextRec = next.project.pages!.find((page) => page.kind === "rec")!;
    expect(bridge.recording(next.project.id, nextRec.id).recording.flowSnapshot.id).toBe("flow-minutes");
    expect(flowSelect(container).value).toBe("flow-minutes");
    expect(recordings()).toHaveLength(1);
  });

  it("最後に使ったフローが無ければ、新しい録音は並びの先頭のフロー", async () => {
    const bridge = new FakeBridge();
    putFlows(bridge, [coaching(), minutes()], null);
    const project = await bridge.createProject(pagedProject("佐藤さん"), null, null, []);
    screen = await renderApp(bridge);
    const { container } = screen;
    await addPage(container, "音声");
    const rec = bridge.projects.get(project.id)!.project.pages!.find((page) => page.kind === "rec")!;
    expect(bridge.recording(project.id, rec.id).recording.flowSnapshot.id).toBe("flow-coaching");
    // 作ったら、そのフローが最後に使ったフローになる
    expect(bridge.flowIndex?.lastUsed).toBe("flow-coaching");
  });

  it("「この録音の工程を今の設計に更新」は録音の元のフロー（同じ id）と比べる", async () => {
    const bridge = new FakeBridge();
    const minutesFlow = minutes();
    putFlows(bridge, [minutesFlow, coaching()], "flow-minutes");
    const project = await bridge.createProject(pagedProject("週次の打ち合わせ"), null, null, []);
    await textRecording(bridge, project.id, minutesFlow, "第1回", "[00:00:05] 一回目の話です。");
    screen = await renderApp(bridge);
    const { container } = screen;
    const editGuide = async (flowName: string, guide: string) => {
      await click(button(container, "工程設計"));
      await click(flowRow(container, flowName));
      await typeInto(container.querySelector(".gcard textarea")!, guide);
      await click(button(container, "保存"));
      await openAudio(container, "週次の打ち合わせ");
    };
    // ほかのフロー（コーチング）を直しても出ない
    await editGuide("コーチング", "## 文書の目的と読者\n別のフローを直した");
    expect(container.querySelector(".flownote")).toBeNull();
    // 元のフロー（議事録）を直すと出る
    await editGuide("議事録", "## 文書の目的と読者\n議事録を直した");
    expect(container.querySelector(".flownote span")?.textContent).toBe("工程設計が変わりました");
    await click(button(container, "この録音の工程を今の設計に更新"));
    expect([...dialog(container)!.querySelectorAll(".difflist li")].map((item) => item.textContent)).toEqual(["文書ガイドか固有名詞が変わります"]);
    await click(button(dialog(container)!, "更新する"));
    const rec = bridge.projects.get(project.id)!.project.pages!.find((page) => page.kind === "rec")!;
    expect(bridge.recording(project.id, rec.id).recording.flowSnapshot).toMatchObject({ id: "flow-minutes", revision: 2 });
    expect(container.querySelector(".flownote")).toBeNull();
  });
});

describe("録音ページの初期フロー", () => {
  it("最後に使ったフローが無ければ先頭を使い、録音の追加で既定にも保存する", async () => {
    const bridge = new FakeBridge();
    const flow = coaching();
    putFlows(bridge, [flow], null);
    const project = await bridge.createProject(pagedProject("佐藤さん コーチング"), null, null, []);
    screen = await renderApp(bridge);
    const { container } = screen;
    await addPage(container, "音声");
    const rec = bridge.projects.get(project.id)!.project.pages!.find((page) => page.kind === "rec")!;
    const snapshot = bridge.recording(project.id, rec.id).recording.flowSnapshot;
    expect(snapshot.name).toBe("コーチング");
    expect(snapshot.steps.map((step) => [step.id, step.name])).toEqual([
      ["c5v8n3qd", "文字起こし修正"],
      ["a3m9t6kw", "分析"],
    ]);
    // 背景情報のページの「工程」はコーチング（成果物の行はまだ無い）
    expect(flowSelect(container).selectedOptions[0]?.textContent).toBe("コーチング");
    expect(outputNames(container)).toEqual([]);
    expect(bridge.flowIndex).toEqual({ version: 1, order: [snapshot.id], lastUsed: snapshot.id });
    expect(bridge.flowFiles.get(snapshot.id)?.name).toBe("コーチング");
  });
});

describe("録音のページの「工程」のテンプレート（#18883）", () => {
  /** optgroup ごとの [見出し, 値]。 */
  const groups = (select: HTMLSelectElement) =>
    [...select.querySelectorAll("optgroup")].map((group) => [group.label, [...group.querySelectorAll("option")].map((option) => option.value)]);

  it("あなたの工程とテンプレートを docs-core と同じ並びで分けて出し、テンプレートを選ぶと新しいフローとして保存してその録音に付ける", async () => {
    const bridge = new FakeBridge();
    const minutesFlow = minutes();
    putFlows(bridge, [minutesFlow, coaching()], "flow-minutes");
    const project = await bridge.createProject(pagedProject("週次の打ち合わせ"), null, null, []);
    const recordingId = await textRecording(bridge, project.id, minutesFlow, "第1回", "[00:00:05] 一回目の話です。");
    screen = await renderApp(bridge);
    const { container } = screen;
    await openAudio(container);
    const select = flowSelect(container);
    expect([...select.querySelectorAll("optgroup")].map((group) => [group.label, [...group.querySelectorAll("option")].map((option) => option.textContent)])).toEqual([
      ["あなたの工程", ["議事録", "コーチング"]],
      ["テンプレート", ["記事制作", "インサイト整理"]],
    ]);
    // Web/PWA と同じ docs-core の選択肢（フローは id、テンプレートは template:<id> の値）
    const core = buildFlowChoices([minutesFlow, coaching()]);
    expect(groups(select)).toEqual(core.groups.map((group) => [group.label, group.options.map((option) => (option.kind === "flow" ? option.id : option.key))]));

    await selectOption(flowSelect(container), "template:tpl-3");
    const created = [...bridge.flowFiles.values()].find((flow) => flow.name === "インサイト整理")!;
    expect(created).toEqual(createFlowFromTemplate(findTemplate("tpl-3")!, created.id));
    expect(created.id).toMatch(/^flow-/);
    expect(bridge.flowWrites).toContain(`save:${created.id}`);
    expect(bridge.recording(project.id, recordingId).recording.flowSnapshot).toMatchObject({ id: created.id, name: "インサイト整理" });
    expect(flowSelect(container).value).toBe(created.id);
    expect(bridge.flowIndex?.lastUsed).toBe(created.id);
    // 作ったフローはあなたの工程の後ろに足し、そのテンプレートはもう出さない
    expect(groups(flowSelect(container))).toEqual([
      ["あなたの工程", ["flow-minutes", "flow-coaching", created.id]],
      ["テンプレート", ["template:tpl-1"]],
    ]);
  });

  it("成果物のある録音でテンプレートを選ぶと、フローを作ってから確かめ、やめても作ったフローは残る", async () => {
    const bridge = new FakeBridge();
    const minutesFlow = minutes();
    putFlows(bridge, [minutesFlow], "flow-minutes");
    const project = await bridge.createProject(pagedProject("週次の打ち合わせ"), null, null, []);
    const recordingId = await textRecording(bridge, project.id, minutesFlow, "第1回", "[00:00:05] 一回目の話です。");
    bridge.turnScript = () => [done("成果物")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await openAudio(container);
    await click(button(container, "続きを作成"));
    await until(() => (bridge.recording(project.id, recordingId).versions[minutesFlow.steps[1]!.id]?.length ?? 0) === 1);
    await selectOption(flowSelect(container), "template:tpl-1");
    const confirm = dialog(container)!;
    expect(confirm.querySelector("h2")?.textContent).toBe("この録音の工程を「記事制作」にしますか");
    await click(button(confirm, "やめる"));
    expect(bridge.recording(project.id, recordingId).recording.flowSnapshot.id).toBe("flow-minutes");
    expect([...bridge.flowFiles.values()].map((flow) => flow.name)).toEqual(["議事録", "記事制作"]);
  });

  it("以前の Web/PWA がテンプレートから作った録音（remote_）は「この録音だけの工程」と出す", async () => {
    const bridge = new FakeBridge();
    putFlows(bridge, [minutes()], "flow-minutes");
    const project = await bridge.createProject(pagedProject("週次の打ち合わせ"), null, null, []);
    await textRecording(bridge, project.id, createFlowFromTemplate(findTemplate("tpl-1")!, "remote_rec-web"), "Web の録音", "[00:00:05] 話です。");
    screen = await renderApp(bridge);
    const { container } = screen;
    await openAudio(container);
    expect(flowSelect(container).value).toBe("remote_rec-web");
    expect(optionLabels(flowSelect(container))[0]).toBe("記事制作（この録音だけの工程）");
    expect(container.textContent).not.toContain("工程設計から削除済み");
  });
});
