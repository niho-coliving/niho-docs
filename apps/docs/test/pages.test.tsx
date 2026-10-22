// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Editor } from "@tiptap/react";
import { FLOW_TEMPLATES, ROOT_RECORDING_ID, SOURCE_STEP_ID, createFlowFromTemplate, createFlowSnapshot, defaultProfiles, projectPages } from "@niho/docs-core";
import { button, click, renderApp, typeInto, type Screen } from "./dom";
import { FakeBridge, done } from "./fake-bridge";
import {
  addPage,
  addPageInFolder,
  chatToggle,
  createProjectByName,
  homeButton,
  infoItem,
  openAudio,
  openChat,
  outputRow,
  seedText,
  railChildren,
  railCurrent,
  railFolder,
  railFolderRows,
  railItem,
  railPages,
  seedRun,
  shownVersion,
  titleInput,
  until,
  newFolder,
  newFromMenu,
} from "./pages";
import { THREE_STEP_TEMPLATE } from "./three-step-flow";

/** ページの器（#18564 P1・#18914）: 新しいフォルダの文書のページ・ページの追加・名前・削除・背景情報のページとフォルダの音声 1 セット。 */

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

/** 文書のページの本文のエディタ（TipTap は DOM の要素に editor を置く）。 */
function bodyEditor(container: HTMLElement): Editor {
  const element = container.querySelector(".pbody .ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  if (!element?.editor) throw new Error("editor not found");
  return element.editor;
}

async function typeBody(container: HTMLElement, text: string) {
  await act(async () => {
    bodyEditor(container).commands.insertContent(text);
  });
}

/** 自動保存（600ms）と名前の保存（500ms）を待つ。 */
async function waitSaves() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 700));
  });
}

describe("新しい案件と文書のページ", () => {
  it("フォルダを作らず外に文書を作り、再起動後も同じ本文を開ける", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge);
    await newFromMenu(screen.container, "ページ");
    await typeInto(titleInput(screen.container), "外の下書き");
    await typeBody(screen.container, "フォルダを決める前の本文");
    await waitSaves();
    expect(bridge.projects.size).toBe(0);
    expect(bridge.outside.project.pages).toHaveLength(1);

    screen.unmount();
    screen = await renderApp(bridge);
    expect(railCurrent(screen.container)).toBe("外の下書き");
    expect(bodyEditor(screen.container).getText()).toContain("フォルダを決める前の本文");
  });

  it("レールはフォルダ › 区切り線 › ホームのページの順で見出しを出さず、＋ の言葉は Web/PWA と同じ（#18867）", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge);
    const { container } = screen;
    // ホームの新規作成の ＋ は作成先を明示する。フォルダを開いても変わらない。
    await click(container.querySelector<HTMLButtonElement>(".window-titlebar .tb-new")!);
    expect(container.querySelector(".window-titlebar .new-menu .pop")).not.toBeNull();
    expect(container.querySelector(".window-titlebar .new-menu .pop")?.getAttribute("aria-label")).toBe("ホームに作成");
    expect(container.querySelector(".window-titlebar .new-menu .pop .mi-label")?.textContent).toBe("ホームに作成");
    await click(container.querySelector<HTMLButtonElement>(".window-titlebar .tb-new")!);
    await newFromMenu(container, "ページ");
    await typeInto(titleInput(container), "外のメモ");
    await createProjectByName(container, "取材");
    await typeInto(titleInput(container), "取材メモ");
    await waitSaves();
    const rail = container.querySelector<HTMLElement>(".rail .rscroll")!;
    // 見出し「ページ」「フォルダ ＋」は無い
    expect(rail.querySelector(".rhead, .rsec")).toBeNull();
    expect(rail.querySelector('button[aria-label="新しいフォルダ"]')).toBeNull();
    // フォルダの行 → 区切り線 → フォルダの外のページ
    const order = [...rail.children].map((child) => child.classList.contains("case")
      ? `folder:${child.querySelector(".ti.case .t")?.textContent}`
      : child.classList.contains("rail-divider") ? "divider" : child.querySelector(".ti .t")?.textContent ?? child.className);
    expect(order.filter((item) => item.startsWith("folder:") || item === "divider" || item === "外のメモ")).toEqual(["folder:取材", "divider", "外のメモ"]);
    expect(rail.querySelector(".rail-divider")?.classList.contains("line")).toBe(true);
    // フォルダの行の ＋ は「〈フォルダ名〉に追加」で ページ／音声 だけ（フォルダは入れ子にしない）
    const folder = railItem(container, "取材").closest<HTMLElement>("div.case")!;
    const add = folder.querySelector<HTMLButtonElement>(":scope > .trow .addpage > button")!;
    expect(add.getAttribute("aria-label")).toBe("取材に追加");
    await click(add);
    expect(folder.querySelector(":scope > .trow .addpage .pop .mi-label")?.textContent).toBe("取材に追加");
    expect(folder.querySelector(":scope > .trow .addpage .pop")?.getAttribute("aria-label")).toBe("取材に追加");
    expect([...folder.querySelectorAll(":scope > .trow .addpage .pop .mi")].map((item) => item.textContent)).toEqual(["ページ", "音声"]);
    await click(add);
    // フォルダ内でも緑の ＋ はホームへの新規作成。
    await click(container.querySelector<HTMLButtonElement>(".window-titlebar .tb-new")!);
    expect(container.querySelector(".window-titlebar .new-menu .pop .mi-label")?.textContent).toBe("ホームに作成");
  });

  it("緑の ＋ と ⌘N はフォルダ内のページを見ていてもホームへ作り、フォルダの ＋ は押したフォルダへ作る", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "取材");
    await typeInto(titleInput(container), "取材メモ");
    await newFromMenu(container, "ページ");
    expect(bridge.outside.project.pages?.map((page) => page.kind)).toEqual(["doc"]);
    expect(bridge.byName("取材").project.pages).toHaveLength(1);
    await typeInto(titleInput(container), "ホームのページ");
    await click(railItem(container, "取材メモ"));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true, bubbles: true })));
    await until(() => (bridge.outside.project.pages ?? []).length === 2);
    expect(bridge.byName("取材").project.pages).toHaveLength(1);
    expect(railCurrent(container)).toBe("無題");
    await newFolder(container);
    await typeInto(titleInput(container), "別のフォルダ");
    await addPageInFolder(railFolder(container, "取材"), "ページ");
    expect(bridge.byName("取材").project.pages).toHaveLength(2);
    expect(bridge.byName("別のフォルダ").project.pages).toHaveLength(0);
    expect(railFolder(container, "取材").querySelector('[aria-current="page"]')).not.toBeNull();
    expect(document.activeElement).toBe(titleInput(container));
  });

  it("新しいフォルダはダイアログ無しで背景情報のページを開き、題と背景情報をその場で編集できる（#18914）", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge);
    const { container } = screen;
    await newFolder(container);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(titleInput(container).placeholder).toBe("無題のフォルダ");
    expect(document.activeElement).toBe(titleInput(container));
    expect(container.querySelector(".folder-home .pmeta")?.textContent).toContain("フォルダ·0 ページ");
    expect(railCurrent(container)).toBe("背景情報");
    await typeInto(titleInput(container), "取材資料");
    await act(async () => titleInput(container).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    // 背景情報・登場人物・固有名詞はページの中（名前の欄は無い）。その下に「音声」
    const page = container.querySelector<HTMLElement>(".folder-home")!;
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(page.querySelector("#info-name")).toBeNull();
    expect(page.querySelector("#info-bg")).not.toBeNull();
    expect(page.textContent).toContain("固有名詞");
    expect(page.querySelector(".folder-audio .sec")?.textContent).toBe("音声");
    // 素材がまだ無いフォルダは音声選択・Mac録音・VTT取込の欄。ページの一覧は置かない
    expect([...page.querySelectorAll(".folder-audio .drop .row button")].map((item) => item.textContent)).toEqual(["ファイルを選択", "この Mac で録音", "VTTを取り込む"]);
    expect(page.querySelector(".folder-pages, .orows")).toBeNull();
    // 保存は「保存」で（変えるまで押せない）
    const save = () => button(page.querySelector<HTMLElement>(".folder-save")!, "保存");
    expect(save().disabled).toBe(true);
    await typeInto(page.querySelector("#info-bg")!, "取材の目的");
    await click(save());
    const stored = bridge.byName("取材資料");
    expect(stored.project.info.background).toBe("取材の目的");
    expect(save().disabled).toBe(true);
  });

  it("フォルダ名の保存失敗を保持し、次の確定操作で再試行する", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge);
    const { container } = screen;
    await newFolder(container);
    const projectId = [...bridge.projects.keys()][0]!;
    const saveProject = bridge.saveProject.bind(bridge);
    let attempts = 0;
    bridge.saveProject = async (...args) => {
      attempts++;
      if (attempts === 1) throw { code: "store_io", message: "フォルダ名の保存に失敗しました。" };
      return saveProject(...args);
    };
    await typeInto(titleInput(container), "移動先");
    await act(async () => titleInput(container).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await until(() => container.querySelector(".failure-band .fb-msg")?.textContent === "フォルダ名の保存に失敗しました。");
    expect(bridge.projects.get(projectId)?.project.name).not.toBe("移動先");

    await act(async () => {
      titleInput(container).focus();
      titleInput(container).blur();
    });
    await until(() => bridge.projects.get(projectId)?.project.name === "移動先");
    expect(attempts).toBe(2);
  });

  it("新しい案件を作ると空の文書ページが開いてタイトルにフォーカスし、本文は移っても開き直しても残る", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "佐藤さん コーチング");
    const stored = bridge.byName("佐藤さん コーチング");
    // 工程が無くても作れる（root の録音は無く、ページは文書 1 枚）
    expect(stored.project.flowSnapshot).toBeUndefined();
    expect(stored.project.pages).toHaveLength(1);
    expect(stored.project.pages?.[0]).toMatchObject({ kind: "doc", title: "" });
    // 案件情報は固有名詞・背景情報だけ（話者人数・言語は録音ごと。#18566 P3）
    expect(stored.project.info).toEqual({ terms: [], background: "" });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(titleInput(container));
    expect(titleInput(container).placeholder).toBe("無題");
    expect(railPages(container)).toEqual(["無題"]);
    expect(railCurrent(container)).toBe("無題");
    expect(container.querySelector(".pmeta")?.textContent).toContain("文書");
    // 開いて閉じただけなら書かない
    expect(bridge.pageWrites).toHaveLength(0);

    await typeBody(container, "事前に聞きたいこと");
    await waitSaves();
    const docId = stored.project.pages![0]!.id;
    expect(bridge.pageWrites.at(-1)).toMatchObject({ pageId: docId });
    expect(stored.docs[docId]).toContain("事前に聞きたいこと");
    expect(container.querySelector(".pmeta")?.textContent).toMatch(/\d+\/\d+ \d\d:\d\d に更新/);

    // 打ってすぐに別のページへ移っても書き残す
    await typeBody(container, "。二つ目");
    await addPage(container, "ページ");
    expect(stored.docs[docId]).toContain("二つ目");
    expect(railPages(container)).toEqual(["無題", "無題"]);
    await click(railItem(container, "無題"));
    expect(bodyEditor(container).getText()).toContain("事前に聞きたいこと。二つ目");
  });

  it("「＋」で文書を 2 つ足し、名前を変えるとレールとパンくずが追従し、確かめてから 1 つを削除する", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "朝市");
    await addPage(container, "ページ");
    expect(document.activeElement).toBe(titleInput(container));
    await typeInto(titleInput(container), "事前メモ");
    // Enter で本文の先頭へ（すぐに打った文字もタイトルに入らない）
    await act(async () => {
      titleInput(container).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(document.activeElement).toBe(container.querySelector(".pbody .ProseMirror"));
    // その場で名前が変わる（保存は 500ms 後）
    expect(railPages(container)).toEqual(["無題", "事前メモ"]);
    expect(railCurrent(container)).toBe("事前メモ");
    await waitSaves();
    const stored = bridge.byName("朝市");
    expect(stored.project.pages?.map((page) => page.title)).toEqual(["", "事前メモ"]);
    await addPage(container, "ページ");
    await typeInto(titleInput(container), "振り返り");
    // 移るときは待たずに保存する
    await click(railItem(container, "事前メモ"));
    expect(stored.project.pages?.map((page) => page.title)).toEqual(["", "事前メモ", "振り返り"]);
    expect(railCurrent(container)).toBe("事前メモ");
    // 削除: 確かめるダイアログ（やめるとそのまま）
    await click(container.querySelector('.window-titlebar .acts button[aria-label="その他"]')!);
    await click(button(container.querySelector<HTMLElement>(".pagemenu .pop")!, "削除"));
    const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog()?.querySelector("h2")?.textContent).toBe("「事前メモ」を削除しますか");
    expect(dialog()?.textContent).toContain("この文書のページを削除します。元に戻せません。");
    expect(document.activeElement?.textContent).toBe("やめる");
    await click(button(dialog()!, "やめる"));
    expect(stored.project.pages).toHaveLength(3);
    await click(container.querySelector('.window-titlebar .acts button[aria-label="その他"]')!);
    await click(button(container.querySelector<HTMLElement>(".pagemenu .pop")!, "削除"));
    await click(button(dialog()!, "削除する"));
    expect(stored.project.pages?.map((page) => page.title)).toEqual(["", "振り返り"]);
    // 隣のページ（前）を開く
    expect(railPages(container)).toEqual(["無題", "振り返り"]);
    expect(railCurrent(container)).toBe("無題");
    expect(container.querySelector(".toast")?.textContent).toBe("削除しました");
  });

  it("文書のページに新規文書用の「AIと作る」があり、ページが無い案件は空の面から足せる", async () => {
    const bridge = new FakeBridge();
    const created = await bridge.createProject(
      { version: 1, id: "", name: "空の案件", createdAt: "2026-10-16T00:00:00.000Z", info: { speakers: "auto", language: "ja", terms: [], background: "" }, pages: [] },
      null,
      null,
      [],
    );
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(container.querySelector(".folder-home .pmeta")?.textContent).toContain("0 ページ");
    await addPage(container, "ページ");
    expect(bridge.projects.get(created.id)?.project.pages).toHaveLength(1);
    // 「AIと作る」は閉じて始まり、開閉のボタンで右の列を出す（owner 2026-10-18・#18941）
    expect(chatToggle(container)?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".chatcard")).toBeNull();
    await click(chatToggle(container)!);
    expect(chatToggle(container)?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".chatcard")).not.toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="直したいこと"]')?.disabled).toBe(false);
    expect(container.querySelector('select[aria-label="英訳の原文"]')).toBeNull();
  });

  it("フォルダ外の文書は再読込でき、本文の保存に失敗したらフォルダへ移動しない", async () => {
    const bridge = new FakeBridge();
    const target = await bridge.createProject(
      { version: 1, id: "", name: "移動先", createdAt: "2026-10-16T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] },
      null,
      null,
      [],
    );
    const doc = await bridge.createPage(null, { kind: "doc", title: "外のメモ", createdAt: "2026-10-16T01:00:00.000Z" });
    await bridge.writePage(null, doc.id, "保存済み");
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(railCurrent(container)).toBe("外のメモ");
    expect(bodyEditor(container).getText()).toContain("保存済み");

    let moveCalls = 0;
    bridge.writePage = async () => {
      throw { code: "store_io", message: "保存に失敗しました。" };
    };
    const realMove = bridge.movePage.bind(bridge);
    bridge.movePage = async (...args) => {
      moveCalls++;
      return realMove(...args);
    };
    await typeBody(container, "書きかけ");
    await click(container.querySelector('.window-titlebar .acts button[aria-label="その他"]')!);
    await click(button(container.querySelector<HTMLElement>(".pagemenu .pop")!, "フォルダへ移す"));
    await click(button(container.querySelector<HTMLElement>(".pagemenu .pop")!, "移動先"));
    await until(() => container.querySelector(".failure-band .fb-msg")?.textContent === "保存に失敗しました。");
    expect(moveCalls).toBe(0);
    expect(bridge.outside.project.pages?.map((page) => page.id)).toContain(doc.id);
    expect(bridge.projects.get(target.id)?.project.pages).toEqual([]);
  });

  it("フォルダのパンくずは本文の保存失敗時に移動しない", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "朝市");
    await typeBody(container, "保存に失敗する書きかけ");
    let writes = 0;
    bridge.writePage = async () => {
      writes++;
      throw { code: "store_io", message: "保存に失敗しました。" };
    };

    await click(railItem(container, "朝市"));
    await until(() => container.querySelector(".failure-band .fb-msg")?.textContent === "保存に失敗しました。");
    expect(writes).toBeGreaterThan(0);
    expect(railCurrent(container)).toBe("無題");
    expect(bodyEditor(container).getText()).toContain("保存に失敗する書きかけ");

    // 書けるようになってから押すと移り、前のページの失敗の帯は消える
    bridge.writePage = FakeBridge.prototype.writePage.bind(bridge);
    await click(railItem(container, "朝市"));
    // フォルダの行は背景情報のページを開く（選択の印は「背景情報」の行。#18914）
    await until(() => railCurrent(container) === "背景情報");
    expect(container.querySelector(".failure-band")).toBeNull();
  });

  it("フォルダ音声の⋯からは移動でき、取り込み中は移動を止める", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "移動元");
    await addPage(container, "音声");
    const source = bridge.byName("移動元");
    const recording = source.project.pages!.find((page) => page.kind === "rec")!;
    expect(railCurrent(container)).toBe("背景情報");

    bridge.pickedAudio = ["/tmp/meeting.m4a"];
    let releaseImport!: () => void;
    let markImportStarted!: () => void;
    const importStarted = new Promise<void>((resolve) => { markImportStarted = resolve; });
    const importGate = new Promise<void>((resolve) => { releaseImport = resolve; });
    const importAudio = bridge.importAudio.bind(bridge);
    bridge.importAudio = async (...args) => {
      markImportStarted();
      await importGate;
      return importAudio(...args);
    };
    let moveCalls = 0;
    const movePage = bridge.movePage.bind(bridge);
    bridge.movePage = async (...args) => {
      moveCalls++;
      return movePage(...args);
    };
    await click(button(container, "ファイルを選択"));
    await importStarted;
    await until(() => button(container, "ファイルを選択").disabled);

    await click(container.querySelector('.window-titlebar .acts button[aria-label="その他"]')!);
    const menu = container.querySelector<HTMLElement>(".pagemenu .pop")!;
    expect(button(menu, "フォルダへ移す").disabled).toBe(false);
    await click(button(menu, "フォルダへ移す"));
    expect(button(menu, "ホーム").disabled).toBe(true);
    expect(moveCalls).toBe(0);
    expect(projectPages(source.project).some((page) => page.id === recording.id)).toBe(true);

    releaseImport();
    await until(() => {
      const movedSource = bridge.recording(source.project.id, recording.id).recording.source;
      return movedSource.kind === "audio" && movedSource.audio.length === 1;
    });
  });

  it("旧データの2つ目のフォルダ録音も選べ、移動先は空のフォルダだけで上下移動は出さない", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    bridge.flow = flow;
    const project = await bridge.createProject(
      { version: 1, id: "", name: "朝市", createdAt: "2026-10-16T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] },
      null,
      null,
      [],
    );
    const makeRecording = (createdAt: string, speakers: "2" | "3") => ({
      version: 1 as const,
      id: "",
      createdAt,
      flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
      source: { kind: "audio" as const, audio: [] },
      speakers,
      language: "ja" as const,
      refs: [],
    });
    const first = await bridge.createPage(project.id, {
      kind: "rec", title: "最初", createdAt: "2026-10-16T01:00:00.000Z", recording: makeRecording("2026-10-16T01:00:00.000Z", "2"),
    });
    const doc = await bridge.createPage(project.id, { kind: "doc", title: "メモ", createdAt: "2026-10-16T02:00:00.000Z" });
    const target = await bridge.createProject(
      { version: 1, id: "", name: "移動先", createdAt: "2026-10-16T03:00:00.000Z", info: { terms: [], background: "" }, pages: [] },
      null,
      null,
      [],
    );
    bridge.oneRecordingPerFolder = false;
    const occupied = await bridge.createProject(
      { version: 1, id: "", name: "音声あり", createdAt: "2026-10-16T03:30:00.000Z", info: { terms: [], background: "" }, pages: [] },
      null,
      null,
      [],
    );
    await bridge.createPage(occupied.id, {
      kind: "rec", title: "既存音声", createdAt: "2026-10-16T03:40:00.000Z", recording: makeRecording("2026-10-16T03:40:00.000Z", "2"),
    });
    const second = await bridge.createPage(project.id, {
      kind: "rec", title: "2つ目", createdAt: "2026-10-16T04:00:00.000Z", recording: makeRecording("2026-10-16T04:00:00.000Z", "3"),
    });

    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "朝市"));
    expect(container.querySelector<HTMLSelectElement>("#rec-speakers")!.value).toBe("2");
    await click(button(container, "2つ目 2"));
    expect(container.querySelector<HTMLSelectElement>("#rec-speakers")!.value).toBe("3");

    await click(container.querySelector('.window-titlebar .acts button[aria-label="その他"]')!);
    const menu = container.querySelector<HTMLElement>(".pagemenu .pop")!;
    await click(button(menu, "フォルダへ移す"));
    expect(button(menu, "移動先").disabled).toBe(false);
    expect(button(menu, "ホーム").disabled).toBe(false);
    expect([...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((item) => item.textContent?.trim())).not.toContain("音声あり");
    const topLevelItems = [...menu.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"]')].map((item) => item.firstChild?.textContent?.trim());
    expect(topLevelItems).not.toContain("上へ移動");
    expect(topLevelItems).not.toContain("下へ移動");
    await click(container.querySelector('.window-titlebar .acts button[aria-label="その他"]')!);

    await click(container.querySelector('.window-titlebar .acts button[aria-label="その他"]')!);
    await click(button(container.querySelector<HTMLElement>(".pagemenu .pop")!, "フォルダへ移す"));
    await click(button(container.querySelector<HTMLElement>(".pagemenu .pop")!, "移動先"));
    await until(() => bridge.projects.get(target.id)!.project.pages!.some((page) => page.id === second.id));
    expect(bridge.projects.get(project.id)!.project.pages!.some((page) => page.id === second.id)).toBe(false);

    await click(container.querySelector('.window-titlebar .acts button[aria-label="その他"]')!);
    await click(button(container.querySelector<HTMLElement>(".pagemenu .pop")!, "フォルダへ移す"));
    await click(button(container.querySelector<HTMLElement>(".pagemenu .pop")!, "ホーム"));
    await until(() => bridge.outside.project.pages!.some((page) => page.kind === "rec"));
    expect(bridge.projects.get(target.id)!.project.pages!.some((page) => page.id === second.id)).toBe(false);
  });

  it("遅い移動の間に別フォルダを開いたら、実データだけを移して後の選択を戻さない", async () => {
    const bridge = new FakeBridge();
    const source = await bridge.createProject(
      { version: 1, id: "", name: "移動元", createdAt: "2026-10-16T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] },
      null,
      null,
      [],
    );
    const target = await bridge.createProject(
      { version: 1, id: "", name: "移動先", createdAt: "2026-10-16T01:00:00.000Z", info: { terms: [], background: "" }, pages: [] },
      null,
      null,
      [],
    );
    const later = await bridge.createProject(
      { version: 1, id: "", name: "後で開く", createdAt: "2026-10-16T02:00:00.000Z", info: { terms: [], background: "" }, pages: [] },
      null,
      null,
      [],
    );
    const doc = await bridge.createPage(source.id, { kind: "doc", title: "移す文書", createdAt: "2026-10-16T03:00:00.000Z" });
    const realMove = bridge.movePage.bind(bridge);
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    bridge.movePage = async (...args) => {
      markStarted();
      await gate;
      return realMove(...args);
    };
    screen = await renderApp(bridge);
    await click(screen.container.querySelector('.window-titlebar .acts button[aria-label="その他"]')!);
    await click(button(screen.container.querySelector<HTMLElement>(".pagemenu .pop")!, "フォルダへ移す"));
    await click(button(screen.container.querySelector<HTMLElement>(".pagemenu .pop")!, "移動先"));
    await started;
    await click(railItem(screen.container, "後で開く"));
    release();
    await until(() => bridge.projects.get(target.id)?.project.pages?.some((page) => page.id === doc.id) === true);
    expect(bridge.projects.get(source.id)?.project.pages).toEqual([]);
    expect(railItem(screen.container, "後で開く").getAttribute("aria-current")).toBe("page");
    expect(titleInput(screen.container).value).toBe("後で開く");
    expect(bridge.projects.get(later.id)?.project.pages).toEqual([]);
  });

  it("別のフォルダを開いていても各フォルダのページをレールに表示する", async () => {
    const bridge = new FakeBridge();
    const first = await bridge.createProject(
      { version: 1, id: "", name: "一つ目", createdAt: "2026-10-16T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] },
      null,
      null,
      [],
    );
    const second = await bridge.createProject(
      { version: 1, id: "", name: "二つ目", createdAt: "2026-10-16T01:00:00.000Z", info: { terms: [], background: "" }, pages: [] },
      null,
      null,
      [],
    );
    await bridge.createPage(first.id, { kind: "doc", title: "一つ目の文書", createdAt: "2026-10-16T02:00:00.000Z" });
    await bridge.createPage(second.id, { kind: "doc", title: "二つ目の文書", createdAt: "2026-10-16T03:00:00.000Z" });
    screen = await renderApp(bridge);
    await click(railItem(screen.container, "二つ目"));
    expect(railItem(screen.container, "一つ目の文書")).toBeTruthy();
    expect(railItem(screen.container, "二つ目の文書")).toBeTruthy();
  });
});

describe("今の案件（ページの無い project.json）", () => {
  async function legacy() {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(THREE_STEP_TEMPLATE, "flow-1");
    bridge.flow = flow;
    const { createFlowSnapshot, defaultProfiles } = await import("@niho/docs-core");
    const project = await bridge.createProject(
      {
        version: 1,
        id: "",
        name: "朝市 インタビュー",
        createdAt: "2026-10-15T00:00:00.000Z",
        flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
        info: { speakers: "2", language: "ja", terms: [], background: "" },
        source: { kind: "text" },
      },
      "[00:00:08] 朝市に出して三年目です。\n",
      { id: "save-1", kind: "save", at: "2026-10-15T00:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" },
      [],
    );
    const stored = bridge.projects.get(project.id)!;
    return { bridge, flow, project, stored };
  }

  it("背景情報のページが開き、音声（root の録音）と、フォルダの直下に済の工程が並ぶ。子ページは文書・版・会話が見え、ファイルは変わらない。最初に文書を足すと root を先頭に pages を書く", async () => {
    const { bridge, flow, stored } = await legacy();
    const extract = flow.steps[0]!;
    await bridge.saveArtifact({ projectId: stored.project.id, recordingId: ROOT_RECORDING_ID }, extract.id, false, "## 事実\n\n- 三年目\n", {
      id: "run-1",
      kind: "run",
      at: "2026-10-15T00:01:00.000Z",
      stepId: extract.id,
      stepName: extract.name,
      version: null,
      result: "saved",
    });
    const before = JSON.stringify({ transcript: stored.transcript, artifacts: stored.artifacts, versions: stored.versions, runs: stored.runs });
    screen = await renderApp(bridge);
    const { container } = screen;
    // 録音の行も開閉も無い。背景情報のページ（題はフォルダ名）に音声の欄
    expect(railCurrent(container)).toBe("背景情報");
    expect(titleInput(container).value).toBe("朝市 インタビュー");
    expect(container.querySelector(".rail .tw:not(.none)[aria-label*='文章']")).toBeNull();
    expect(railFolderRows(railFolder(container, "朝市 インタビュー"))).toEqual(["文章", "発言の抽出"]);
    expect(railPages(container)).toEqual([]);
    expect(railChildren(container)).toEqual(["文章", "発言の抽出"]);
    // まだ無い工程（インサイト）の行は出さない
    expect(railChildren(container)).not.toContain("インサイト");
    expect(container.querySelector(".folder-audio .afile .nm")?.textContent).toMatch(/^文章 · \d+ 字$/);
    expect(button(container, "続きを作成").disabled).toBe(false);
    expect(chatToggle(container)?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".chatcard")).not.toBeNull();

    // 子ページ: 今までどおり文書・版・会話
    await click(railItem(container, "発言の抽出"));
    expect(railCurrent(container)).toBe("発言の抽出");
    expect(container.querySelector(".sheet h1.ptitle")?.textContent).toBe("発言の抽出");
    expect(await shownVersion(container)).toBe("第 1 版");
    // 題の下は「〈フォルダ名〉 から」（録音のページは無いので元はフォルダ。#18914・#18915）
    expect(container.querySelector(".pmeta")?.textContent).toContain("朝市 インタビュー から");
    expect(container.querySelector(".chat .step-msg")?.textContent).toContain("▶ 発言の抽出を実行");
    // 「AIと作る」を閉じる・開く
    await click(chatToggle(container)!);
    expect(chatToggle(container)?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".chatcard")).toBeNull();
    await click(chatToggle(container)!);
    expect(container.querySelector(".chatcard")).not.toBeNull();
    // レールの「背景情報」で背景情報のページへ戻る（パンくずは無い。#18881）
    await openAudio(container);
    expect(container.querySelector(".folder-audio .runbar")).not.toBeNull();
    expect(stored.project.pages).toBeUndefined();

    // 最初に文書を足すと pages を書く（root を先頭に・名前は空）。root のファイルは動かない
    await addPage(container, "ページ");
    expect(stored.project.pages?.map((page) => [page.id, page.kind, page.title])).toEqual([
      [ROOT_RECORDING_ID, "rec", ""],
      [stored.project.pages![1]!.id, "doc", ""],
    ]);
    expect(railFolderRows(railFolder(container, "朝市 インタビュー"))).toEqual(["文章", "発言の抽出", "無題"]);
    expect(JSON.stringify({ transcript: stored.transcript, artifacts: stored.artifacts, versions: stored.versions, runs: stored.runs })).toBe(before);
    expect(stored.project.flowSnapshot).toBeDefined();
    expect(stored.project.source).toEqual({ kind: "text" });
  });

  it("背景情報のページの題はフォルダ名（録音の名前は変えず、pages も書かない）", async () => {
    const { bridge, stored } = await legacy();
    screen = await renderApp(bridge);
    const { container } = screen;
    await typeInto(titleInput(container), "第1回 インタビュー");
    await act(async () => titleInput(container).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await until(() => stored.project.name === "第1回 インタビュー");
    expect(railItem(container, "第1回 インタビュー").classList.contains("case")).toBe(true);
    expect(stored.project.pages).toBeUndefined();
  });
});

describe("フォルダの音声と成果物の子ページ（#18914）", () => {
  it("空の録音は音声ファイル選択／Mac録音／VTT取込を選べる。文章素材を保存し、成果物をフォルダ直下へ並べる", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    bridge.flow = flow;
    let count = 0;
    bridge.turnScript = () => [done(`成果物 ${++count}`)];
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "運営会議");
    await addPage(container, "音声");
    const stored = bridge.byName("運営会議");
    const entry = stored.project.pages?.find((page) => page.kind === "rec");
    expect(entry).toBeDefined();
    const recording = bridge.recording(stored.project.id, entry!.id);
    // 今のフローの snapshot を持つ（音声は 0 本）
    expect(recording.recording.flowSnapshot.steps.map((step) => step.name)).toEqual(["議事録", "共有用の要約"]);
    expect(recording.recording.source).toEqual({ kind: "audio", audio: [] });
    // 背景情報のページのまま（録音のページは無い）。レールには録音の行が無い
    expect(railCurrent(container)).toBe("背景情報");
    expect(titleInput(container).value).toBe("運営会議");
    expect(railFolderRows(railFolder(container, "運営会議"))).toEqual(["無題"]);
    // 素材が無いうちは実行できない
    expect(container.querySelector(".folder-audio .drop")?.textContent).toContain("音声ファイルをここにドロップ");
    // 素材は音声ファイル・Mac録音・VTT取込から選ぶ（「文章を貼る」は出さない）。
    expect([...container.querySelectorAll(".folder-audio .drop button")].map((item) => item.textContent)).toEqual(["ファイルを選択", "この Mac で録音", "VTTを取り込む"]);
    expect(button(container, "文書作成を開始").disabled).toBe(true);
    expect(container.querySelector(".runbar .note")?.textContent).toBe("音声を入れると実行できます");

    await seedText(bridge, container, "今日の議題は三つです。");
    expect(recording.transcript).toBe("今日の議題は三つです。\n");
    expect(recording.versions[SOURCE_STEP_ID]).toHaveLength(1);
    expect(recording.recording.source).toEqual({ kind: "text" });
    expect(container.querySelector(".afile .nm")?.textContent).toMatch(/^文章 · \d+ 字$/);
    // 成果物は録音の位置（文書の後ろ）に、文書と同じ深さで並ぶ
    expect(railFolderRows(railFolder(container, "運営会議"))).toEqual(["文章", "無題"]);

    await click(button(container, "続きを作成"));
    await until(() => (recording.versions[flow.steps[1]!.id]?.length ?? 0) === 1);
    expect(recording.artifacts[flow.steps[0]!.id]).toBe("成果物 1\n");
    expect(recording.runs.filter((run) => run.kind === "run").map((run) => run.stepName)).toEqual(["議事録", "共有用の要約"]);
    expect(railChildren(container)).toEqual(["文章", "議事録", "共有用の要約"]);
    expect(railFolderRows(railFolder(container, "運営会議"))).toEqual(["文章", "議事録", "共有用の要約", "無題"]);
    expect(container.querySelector(".runbar .note")?.textContent).toMatch(/に完了$/);
    expect(button(container, "すべて再実行")).toBeTruthy();
    // root（この案件には無い）と混ざらない: 案件フォルダ直下には何も書かない
    expect(stored.runs).toEqual([]);
    expect(stored.artifacts).toEqual({});
    expect(Object.keys(stored.checkpoints)).toEqual([]);
    // 本人 Mac の実行は途中記録を intent の private 領域に置き、成功した工程は版と runs.jsonl の行にだけ残す
    expect(Object.keys(recording.checkpoints)).toEqual([]);
    expect([...bridge.personalPrivate.keys()].some((key) => key.endsWith("/checkpoint"))).toBe(true);
    // 子ページを開く
    await click(railItem(container, "議事録"));
    expect(container.querySelector(".sheet h1.ptitle")?.textContent).toBe("議事録");
    expect(railCurrent(container)).toBe("議事録");
  });

  it("フォルダの録音は文書より後に足しても先頭に入り、工程のページが自分のページより前に並ぶ（録音の行も開閉のつまみも無い）", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    bridge.flow = flow;
    const project = await bridge.createProject(
      { version: 1, id: "", name: "朝市", createdAt: "2026-10-16T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] },
      null,
      null,
      [],
    );
    await bridge.createPage(project.id, { kind: "doc", title: "事前メモ", createdAt: "2026-10-16T00:00:00.000Z" });
    const rec = await bridge.createPage(project.id, {
      kind: "rec",
      title: "取材",
      createdAt: "2026-10-16T01:00:00.000Z",
      recording: { version: 1, id: "", createdAt: "2026-10-16T01:00:00.000Z", flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]), source: { kind: "audio", audio: [] }, speakers: "auto", language: "ja", refs: [] },
    });
    await bridge.createPage(project.id, { kind: "doc", title: "ふりかえり", createdAt: "2026-10-16T02:00:00.000Z" });
    await bridge.setRecordingText({ projectId: project.id, recordingId: rec.id }, "本文", { id: "save-1", kind: "save", at: "2026-10-16T01:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" });
    await seedRun(bridge, project.id, flow.steps[0]!, "# 議事録\n", rec.id);
    screen = await renderApp(bridge);
    const { container } = screen;
    const folder = railFolder(container, "朝市");
    expect(railFolderRows(folder)).toEqual(["文章", "議事録", "事前メモ", "ふりかえり"]);
    // 録音の名前の行・録音の開閉は無い。成果物は文書と同じ深さ（d1）
    expect(railItem.bind(null, container, "取材")).toThrow();
    expect([...folder.querySelectorAll(".trow.out")].every((row) => row.classList.contains("d1"))).toBe(true);
    expect(folder.querySelectorAll("button.tw").length).toBe(1);
  });

  it("フォルダの行とレールの「背景情報」は同じ背景情報のページを開き、音声の操作がある", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    bridge.flow = flow;
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "取材");
    await addPage(container, "音声");
    await seedText(bridge, container, "取材の文章");
    await click(railItem(container, "無題"));
    expect(railCurrent(container)).toBe("無題");
    for (const open of [() => click(railItem(container, "取材")), () => openAudio(container, "取材")]) {
      await click(railItem(container, "無題"));
      await open();
      expect(railCurrent(container)).toBe("背景情報");
      expect(titleInput(container).value).toBe("取材");
      expect(container.querySelector("#info-bg")).not.toBeNull();
      expect(container.querySelector(".folder-audio .afile .nm")?.textContent).toMatch(/^文章 · /);
      expect(container.querySelector("#rec-speakers")).not.toBeNull();
      expect(container.querySelector('select[aria-label="工程"]')).not.toBeNull();
      expect(container.querySelector("#personal-execution-route")).toBeNull();
      expect(button(container, "続きを作成")).toBeTruthy();
      // 録音の題・「成果物」の列は無い
      expect(container.querySelector(".orows")).toBeNull();
      expect([...container.querySelectorAll(".pg .sec")].map((item) => item.textContent)).toEqual(["音声"]);
    }
  });

  it("フォルダの録音を選ぶ（最近・起動）と背景情報のページを開く", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    bridge.flow = flow;
    const project = await bridge.createProject(
      { version: 1, id: "", name: "朝市", createdAt: "2026-10-16T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] },
      null,
      null,
      [],
    );
    await bridge.createPage(project.id, { kind: "doc", title: "事前メモ", createdAt: "2026-10-16T00:00:00.000Z" });
    const rec = await bridge.createPage(project.id, {
      kind: "rec",
      title: "取材",
      createdAt: "2026-10-16T01:00:00.000Z",
      recording: { version: 1, id: "", createdAt: "2026-10-16T01:00:00.000Z", flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]), source: { kind: "audio", audio: [] }, speakers: "auto", language: "ja", refs: [] },
    });
    await bridge.touchRecent({ projectId: project.id, pageId: rec.id, openedAt: "2026-10-16T02:00:00.000Z" });
    // 起動は前回のページ（最近の先頭）: フォルダの録音は背景情報のページで開く
    screen = await renderApp(bridge, { autoOpen: false });
    const { container } = screen;
    await until(() => railCurrent(container) === "背景情報");
    expect(titleInput(container).value).toBe("朝市");
    expect(container.querySelector(".folder-audio .drop")).not.toBeNull();
    // ホームの「最近」の行も背景情報（録音のページの名前は出さない）
    await click(homeButton(container));
    const row = [...container.querySelectorAll<HTMLButtonElement>(".recent-row")].find((item) => item.textContent?.includes("朝市"))!;
    expect(row.querySelector("strong")?.textContent).toBe("背景情報");
    await click(row);
    expect(railCurrent(container)).toBe("背景情報");
  });

  it("緑の ＋ と ⇧⌘N は、開いているフォルダによらずホームに独立した音声を作る", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "取材");
    await newFromMenu(container, "音声");
    expect(bridge.projects.size).toBe(1);
    expect(bridge.outside.project.pages?.map((page) => page.kind)).toEqual(["rec"]);
    expect(bridge.byName("取材").project.pages?.some((page) => page.kind === "rec")).toBe(false);
    expect(railCurrent(container)).toBe("録音");
    expect(container.querySelector(".folder-home")).toBeNull();
    expect(document.activeElement).toBe(titleInput(container));
    expect(container.querySelector(".drop")).not.toBeNull();
    await typeInto(titleInput(container), "ホームの音声");
    await waitSaves();
    await click(railItem(container, "取材"));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "N", metaKey: true, shiftKey: true, bubbles: true })));
    await until(() => (bridge.outside.project.pages ?? []).length === 2);
    expect(bridge.projects.size).toBe(1);
    expect(bridge.outside.project.pages?.map((page) => page.kind)).toEqual(["rec", "rec"]);
    await click(railItem(container, "ホームの音声"));
    expect(titleInput(container).value).toBe("ホームの音声");
  });

  it("ホームの音声作成が失敗したらフォルダもページも増やさず、同じ入口から再試行できる", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    screen = await renderApp(bridge);
    const { container } = screen;
    vi.spyOn(bridge, "createPage").mockRejectedValueOnce({ code: "store_io", message: "書き込めませんでした。" });
    await newFromMenu(container, "音声");
    await until(() => container.querySelector(".failure, .band.error, [role=alert]")?.textContent?.includes("書き込めませんでした") === true);
    expect(bridge.projects.size).toBe(0);
    expect(bridge.outside.project.pages ?? []).toHaveLength(0);
    await newFromMenu(container, "音声");
    expect(bridge.outside.project.pages).toHaveLength(1);
    expect(railCurrent(container)).toBe("録音");
  });

  it("フォルダの ＋ › 音声 は、音声のあるフォルダには 2 つ目を作らず背景情報のページを開く", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "取材");
    await addPage(container, "音声");
    const stored = bridge.byName("取材");
    expect(stored.project.pages?.filter((page) => page.kind === "rec")).toHaveLength(1);
    await click(railItem(container, "無題"));
    const create = vi.spyOn(bridge, "createPage");
    await addPageInFolder(railFolder(container, "取材"), "音声");
    expect(create).not.toHaveBeenCalled();
    expect(stored.project.pages?.filter((page) => page.kind === "rec")).toHaveLength(1);
    expect(railCurrent(container)).toBe("背景情報");
    expect(container.querySelector(".folder-audio .drop")).not.toBeNull();
    expect(container.querySelector(".failure-band")).toBeNull();
  });

  it("実行中は別のフォルダの「続きを作成」が押せない", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    bridge.flow = flow;
    let release!: () => void;
    let started!: () => void;
    const waitStarted = new Promise<void>((resolve) => (started = resolve));
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.onTurnStarted = () => started();
    bridge.turnScript = () => [{ type: "TextDelta", text: "途中" }, done("成果")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "一回目");
    await addPage(container, "音声");
    await seedText(bridge, container, "一回目の文章");
    await createProjectByName(container, "二回目");
    await addPage(container, "音声");
    await seedText(bridge, container, "二回目の文章");
    await openAudio(container, "一回目");
    await click(button(container, "続きを作成"));
    await waitStarted;
    expect(container.querySelector(".runbar .note")?.textContent).toBe("議事録を実行中");
    expect(button(container, "止める")).toBeTruthy();
    // 実行中の工程は、まだ版が無くてもフォルダの直下に並ぶ
    expect(railChildren(container)).toContain("議事録");
    await openAudio(container, "二回目");
    expect(button(container, "続きを作成").disabled).toBe(true);
    expect(container.querySelector(".runbar .note")?.textContent).toBe("「一回目」の実行が終わると実行できます。");
    // 実行中のフォルダの背景情報は変えられない（ページは開ける）
    await openAudio(container, "一回目");
    expect(container.querySelector<HTMLFieldSetElement>(".folder-fields")?.disabled).toBe(true);
    release();
    await until(() => container.querySelector<HTMLFieldSetElement>(".folder-fields")?.disabled === false);
  });
});

describe("保存と読み込みの取りこぼし（#18580 のレビュー指摘）", () => {
  it("新規作成前の本文flushが失敗しても作成せず、次の試行で保存して作れる", async () => {
    const bridge = new FakeBridge();
    await bridge.createPage(null, { kind: "doc", title: "元の文書", createdAt: "2026-10-16T00:00:00Z" });
    screen = await renderApp(bridge);
    await typeBody(screen.container, "保存前の本文");
    vi.spyOn(bridge, "writePage").mockRejectedValueOnce({ code: "store_io", message: "ディスクがいっぱいです。" });
    const create = vi.spyOn(bridge, "createPage");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true, bubbles: true })));
    await until(() => screen!.container.querySelector(".failure-band .fb-msg") !== null);
    expect(create).not.toHaveBeenCalled();
    expect(bridge.outside.project.pages).toHaveLength(1);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true, bubbles: true })));
    await until(() => bridge.outside.project.pages?.length === 2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("窓を閉じる要求は本文の書きかけを書き終えてから通し、書けなかったときは一度だけ止める", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "朝市");
    const stored = bridge.byName("朝市");
    const docId = stored.project.pages![0]!.id;
    // 600ms の自動保存より前に閉じる
    await typeBody(container, "閉じる直前の文章");
    expect(bridge.pageWrites).toHaveLength(0);
    let closes = false;
    await act(async () => {
      closes = await bridge.requestClose();
    });
    expect(closes).toBe(true);
    expect(stored.docs[docId]).toContain("閉じる直前の文章");

    // 書けなかったら閉じるのを止めて知らせ、書きかけは残す。もう一度閉じれば閉じる
    const write = vi.spyOn(bridge, "writePage").mockRejectedValue({ code: "store_io", message: "ディスクがいっぱいです。" });
    await typeBody(container, "。保存できない続き");
    await act(async () => {
      closes = await bridge.requestClose();
    });
    expect(closes).toBe(false);
    expect(container.querySelector(".failure-band .fb-msg")?.textContent).toContain("もう一度閉じると");
    await act(async () => {
      closes = await bridge.requestClose();
    });
    expect(closes).toBe(true);
    write.mockRestore();
  });

  it("名前を保存できなかったら名前を残し、離れるときにもう一度書く", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "朝市");
    const stored = bridge.byName("朝市");
    const rename = vi.spyOn(bridge, "renamePage").mockRejectedValueOnce({ code: "store_io", message: "ディスクがいっぱいです。" });
    await typeInto(titleInput(container), "朝市の打合せ");
    await waitSaves();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(stored.project.pages?.[0]?.title).toBe("");
    expect(container.querySelector(".failure-band .fb-msg")).not.toBeNull();
    // 別のページへ移るとき（離れるとき）に、残していた名前をもう一度書く
    await addPage(container, "ページ");
    await until(() => stored.project.pages?.[0]?.title === "朝市の打合せ");
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it("文書を保存すると案件の一覧も読み直す（並びは文書の更新時刻で決まる）", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "朝市");
    const list = vi.spyOn(bridge, "listProjects");
    await typeBody(container, "本文");
    await waitSaves();
    expect(bridge.pageWrites).toHaveLength(1);
    expect(list).toHaveBeenCalled();
  });

  it("録音の読み込み中に別のページを選んだら、遅れて終わった読み込みで選びを戻さない", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "朝市");
    await addPage(container, "音声");
    await click(railItem(container, "無題"));
    expect(railCurrent(container)).toBe("無題");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = bridge.loadRecording.bind(bridge);
    vi.spyOn(bridge, "loadRecording").mockImplementation(async (rec) => {
      await gate;
      return original(rec);
    });
    // 背景情報のページ（フォルダの音声）を選んで読み込みが終わらないうちに、文書のページへ戻る
    await click(infoItem(container, "朝市"));
    await click(railItem(container, "無題"));
    expect(railCurrent(container)).toBe("無題");
    release();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(railCurrent(container)).toBe("無題");
    expect(titleInput(container).placeholder).toBe("無題");
  });
});
