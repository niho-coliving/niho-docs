// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FLOW_TEMPLATES, createBlankFlow, createFlowFromTemplate, projectPages } from "@niho/docs-core";
import { button, click, renderApp, typeInto, type Screen } from "./dom";
import { FakeBridge } from "./fake-bridge";
import { homeButton, infoItem, newFromMenu, railCurrent, railItem, seedText, titleInput, until } from "./pages";

let screen: Screen | null = null;
afterEach(() => { screen?.unmount(); screen = null; });

describe("ホーム・最近・窓全体の音声drop", () => {
  const folder = (bridge: FakeBridge, name: string) => bridge.createProject(
    { version: 1, id: "", name, createdAt: "2026-10-16T00:00:00Z", info: { terms: [], background: "" }, pages: [] },
    null,
    null,
    [],
  );
  /** 名前でフォルダを探す（無ければ undefined）。 */
  const folderNamed = (bridge: FakeBridge, name: string) => [...bridge.projects.values()].find((item) => item.project.name === name);
  /** フォルダの音声（録音）。 */
  const audioOf = (bridge: FakeBridge, name: string) => {
    const stored = folderNamed(bridge, name);
    const page = stored ? projectPages(stored.project).find((entry) => entry.kind === "rec") : undefined;
    return stored && page ? stored.recordings[page.recordingId ?? page.id] : undefined;
  };

  it("初めての起動はホームで、作成して開いたページが最近へ永続化される（一覧表示だけでは時刻を変えない）。次の起動はそのページを開く", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge, { autoOpen: false });
    await newFromMenu(screen.container, "ページ");
    await until(() => bridge.recent.length === 1);
    const openedAt = bridge.recent[0]!.openedAt;
    await click(homeButton(screen.container));
    expect(screen.container.querySelector(".recent-row strong")?.textContent).toBe("無題");
    expect(bridge.recent[0]!.openedAt).toBe(openedAt);
    screen.unmount();
    screen = await renderApp(bridge, { autoOpen: false });
    // 次の起動は前回のページ（最近の先頭）を開く（#18867）
    expect(railCurrent(screen.container)).toBe("無題");
    expect(screen.container.querySelector(".home-page")).toBeNull();
    await click(homeButton(screen.container));
    expect(screen.container.querySelector(".recent-row strong")?.textContent).toBe("無題");
    expect(screen.container.querySelector(".recent-row small")?.textContent).toContain("ホーム");
  });

  it("クラウドの状態を読み終えるまでは前回のページを開かない（ログイン画面に切り替わる前に裏で開かない）", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge, { autoOpen: false });
    await newFromMenu(screen.container, "ページ");
    await until(() => bridge.recent.length === 1);
    screen.unmount();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cloudState = bridge.cloudState.bind(bridge);
    bridge.cloudState = async () => { await gate; return cloudState(); };
    screen = await renderApp(bridge, { autoOpen: false });
    expect(railCurrent(screen.container)).not.toBe("無題");
    await act(async () => { release(); });
    await until(() => railCurrent(screen!.container) === "無題");
  });

  it("前回のページが消えていれば、最近の中でまだあるページを開く（最近は消えたページを除いて読む）", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge, { autoOpen: false });
    await newFromMenu(screen.container, "ページ");
    await click(homeButton(screen.container));
    await newFromMenu(screen.container, "ページ");
    await until(() => bridge.recent.length === 2);
    screen.unmount();
    const latest = bridge.recent[0]!.pageId;
    bridge.outside.project.pages = bridge.outside.project.pages!.filter((page) => page.id !== latest);
    screen = await renderApp(bridge, { autoOpen: false });
    // 残っているページは 1 つだけ（その行が開いている）
    expect(bridge.outside.project.pages).toHaveLength(1);
    expect(railCurrent(screen.container)).toBe("無題");
    expect(screen.container.querySelector(".home-page")).toBeNull();
    expect(bridge.recent[0]?.pageId).toBe(bridge.outside.project.pages![0]!.id);
  });

  it("遅い文書作成の間に設定へ移ったら、作成とrecent保存だけを完了して後の画面を戻さない", async () => {
    const bridge = new FakeBridge();
    const realCreate = bridge.createPage.bind(bridge);
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    bridge.createPage = async (...args) => {
      markStarted();
      await gate;
      return realCreate(...args);
    };
    screen = await renderApp(bridge, { autoOpen: false });
    await newFromMenu(screen.container, "ページ");
    await started;
    await click(button(screen.container, "設定"));
    release();
    await until(() => bridge.outside.project.pages?.length === 1 && bridge.recent.length === 1);
    expect(screen.container.querySelector("main h1")?.textContent).toBe("設定");
    expect(button(screen.container, "設定").classList.contains("on")).toBe(true);
    expect(bridge.recent[0]?.pageId).toBe(bridge.outside.project.pages?.[0]?.id);
  });

  it("購読はAppの1本で、hover枠を出し、無効ファイルでは作らず、ホームへの音声dropはファイル名の新しいフォルダに音声を入れる（#18914）", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    screen = await renderApp(bridge, { autoOpen: false });
    expect(bridge.fileDropListenerCount).toBe(1);
    await act(async () => bridge.hoverDrop(true));
    expect(screen.container.querySelector(".window-drop")?.textContent).toContain("音声をここにドロップ");
    await act(async () => bridge.drop(["/tmp/readme.txt"]));
    await until(() => screen!.container.querySelector(".failure-band .fb-msg") !== null);
    expect(bridge.projects.size).toBe(0);
    await act(async () => bridge.drop(["/tmp/interview.m4a"]));
    await until(() => audioOf(bridge, "interview") !== undefined);
    // ホームには録音を作らない
    expect(bridge.outside.project.pages ?? []).toHaveLength(0);
    expect(projectPages(folderNamed(bridge, "interview")!.project).map((page) => page.kind)).toEqual(["rec"]);
    await until(() => screen!.container.querySelector(".afile .nm")?.textContent === "interview.m4a");
    expect(railCurrent(screen.container)).toBe("背景情報");
    expect(titleInput(screen.container).value).toBe("interview");
    expect(bridge.fileDropListenerCount).toBe(1);
  });

  it("工程が 1 つも無いときの音声dropは、＋ → 録音・音声と同じ「工程を選ぶ」を出し、選んだ工程で取り込む（#18789）", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge, { autoOpen: false });
    const { container } = screen;
    await act(async () => bridge.drop(["/tmp/interview.m4a"]));
    await until(() => container.querySelector('[role="dialog"] h2')?.textContent === "工程を選ぶ");
    // 選ぶまでは白紙の工程で録音を作らない（フォルダも作らない）
    expect(bridge.outside.project.pages).toHaveLength(0);
    expect(bridge.projects.size).toBe(0);
    expect(bridge.importKeeps).toHaveLength(0);
    const card = [...container.querySelectorAll<HTMLButtonElement>(".tcard")].find((entry) => entry.querySelector("b")?.textContent === "議事録")!;
    await click(card);
    await click(button(container.querySelector<HTMLElement>('[role="dialog"]')!, "続ける"));
    await until(() => audioOf(bridge, "interview") !== undefined);
    expect(audioOf(bridge, "interview")!.recording.flowSnapshot.name).toBe("議事録");
    expect(bridge.outside.project.pages ?? []).toHaveLength(0);
    await until(() => container.querySelector(".afile .nm")?.textContent === "interview.m4a");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("白紙のまま保存した工程の無いフローしか無いときも、音声dropは「工程を選ぶ」を出し、工程の無い録音を黙って作らない", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createBlankFlow("blank-1");
    screen = await renderApp(bridge, { autoOpen: false });
    const { container } = screen;
    await act(async () => bridge.drop(["/tmp/interview.m4a"]));
    await until(() => container.querySelector('[role="dialog"] h2')?.textContent === "工程を選ぶ");
    expect(bridge.outside.project.pages).toHaveLength(0);
    expect(bridge.projects.size).toBe(0);
    expect(bridge.importKeeps).toHaveLength(0);
  });

  it("「工程を選ぶ」を閉じると、dropした音声は取り込まず、録音も作らない（#18789）", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge, { autoOpen: false });
    const { container } = screen;
    await act(async () => bridge.drop(["/tmp/interview.m4a"]));
    await until(() => container.querySelector('[role="dialog"] h2')?.textContent === "工程を選ぶ");
    await click(button(container.querySelector<HTMLElement>('[role="dialog"]')!, "キャンセル"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(bridge.outside.project.pages).toHaveLength(0);
    expect(bridge.projects.size).toBe(0);
    expect(bridge.importKeeps).toHaveLength(0);
  });

  it("開いているフォルダへのdropはそのフォルダの音声 1 セットに足し（無ければ作る）、フォルダを開いていなければ新しいフォルダを作る（#18914）", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    const plain = await folder(bridge, "音声の無いフォルダ");
    screen = await renderApp(bridge, { autoOpen: false });
    const { container } = screen;
    // 音声の無いフォルダを開いていれば、そのフォルダの音声を作って入れる（名前はフォルダのまま）
    await click(railItem(container, "音声の無いフォルダ"));
    await act(async () => bridge.drop(["/tmp/first.m4a"]));
    await until(() => audioOf(bridge, "音声の無いフォルダ")?.recording.source.kind === "audio");
    expect(audioOf(bridge, "音声の無いフォルダ")!.recording.source).toMatchObject({ kind: "audio", audio: [{ name: "first.m4a" }] });
    expect(bridge.projects.size).toBe(1);
    // 素材入りでも同じフォルダの音声に足す（2 つ目の録音は作らない。並べた順に 1 つとして文字起こしする）
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    await act(async () => bridge.drop(["/tmp/second.m4a"]));
    await until(() => bridge.importKeeps.length === 2);
    await until(() => audioOf(bridge, "音声の無いフォルダ")!.recording.source.kind === "audio" && (audioOf(bridge, "音声の無いフォルダ")!.recording.source as { audio: unknown[] }).audio.length === 2);
    expect(projectPages(bridge.projects.get(plain.id)!.project).filter((page) => page.kind === "rec")).toHaveLength(1);
    expect(audioOf(bridge, "音声の無いフォルダ")!.recording.source).toMatchObject({ kind: "audio", audio: [{ name: "first.m4a" }, { name: "second.m4a" }] });
    expect(bridge.projects.get(plain.id)!.project.name).toBe("音声の無いフォルダ");
    expect(railCurrent(container)).toBe("背景情報");
    // ホーム（フォルダを開いていない）へのdropは、ファイル名の新しいフォルダ
    await click(homeButton(container));
    await act(async () => bridge.drop(["/tmp/third.m4a"]));
    await until(() => audioOf(bridge, "third") !== undefined);
    expect(bridge.projects.size).toBe(2);
    expect(bridge.outside.project.pages ?? []).toHaveLength(0);
  });

  it("文章を貼ったフォルダの音声には、dropした音声を足さず理由を出す", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    screen = await renderApp(bridge, { autoOpen: false });
    const { container } = screen;
    await newFromMenu(container, "音声");
    await seedText(bridge, container, "貼った本文");
    await act(async () => bridge.drop(["/tmp/late.m4a"]));
    await until(() => container.querySelector(".failure-band .fb-msg")?.textContent === "文章を貼ったフォルダには音声を追加できません。");
    expect(bridge.importKeeps).toHaveLength(0);
    expect(bridge.projects.size).toBe(1);
  });

  it("失敗はトーストにせずページの帯に残す。時間がたっても消えず、「閉じる」・ページの移動で消える（#18788）", async () => {
    const bridge = new FakeBridge();
    await folder(bridge, "朝市");
    screen = await renderApp(bridge, { autoOpen: false });
    const { container } = screen;
    const band = () => container.querySelector<HTMLElement>(".failure-slot .failure-band");
    await act(async () => bridge.drop(["/tmp/readme.txt"]));
    expect(band()?.getAttribute("role")).toBe("alert");
    expect(band()?.querySelector(".fb-msg")?.textContent).toBe("音声ファイルではありません。ページは作りませんでした。");
    expect(container.querySelector(".toast")).toBeNull();
    // トースト（2.2 秒）より長くたっても残る
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2400));
    });
    expect(band()?.querySelector(".fb-msg")?.textContent).toBe("音声ファイルではありません。ページは作りませんでした。");
    await click(band()!.querySelector<HTMLButtonElement>('button[aria-label="閉じる"]')!);
    expect(band()).toBeNull();

    // ページを移ると消える
    await act(async () => bridge.drop(["/tmp/readme.txt"]));
    expect(band()).not.toBeNull();
    await click(railItem(container, "朝市"));
    expect(band()).toBeNull();
    expect(railCurrent(container)).toBe("背景情報");

  });

  it("壊れたrecentだけでは起動を止めず、次にページを開くとrecentだけを作り直す", async () => {
    const bridge = new FakeBridge();
    bridge.recentCorrupt = true;
    screen = await renderApp(bridge, { autoOpen: false });
    expect(screen.container.querySelector(".home-page")).not.toBeNull();
    expect(screen.container.querySelector(".failure-band .fb-msg")?.textContent).toContain("最近開いたページの形式");
    await newFromMenu(screen.container, "ページ");
    await until(() => bridge.recent.length === 1);
    expect(bridge.recentCorrupt).toBe(false);
  });

  it("recent保存の古い応答が遅れても、後から作ったページを先頭に保つ", async () => {
    const bridge = new FakeBridge();
    let release!: () => void;
    bridge.recentTouchGate = new Promise<void>((resolve) => { release = resolve; });
    screen = await renderApp(bridge, { autoOpen: false });
    await newFromMenu(screen.container, "ページ");
    const first = bridge.outside.project.pages![0]!.id;
    await click(homeButton(screen.container));
    await newFromMenu(screen.container, "ページ");
    const second = bridge.outside.project.pages![1]!.id;
    release();
    await until(() => bridge.recent.length === 2);
    expect(bridge.recent.map((item) => item.pageId)).toEqual([second, first]);
  });

  it("フォルダの音声は最近では「背景情報」と出し、起動は背景情報のページを開く（録音のページの名前は出さない。#18914）", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    screen = await renderApp(bridge, { autoOpen: false });
    await newFromMenu(screen.container, "音声");
    await seedText(bridge, screen.container, "貼った本文");
    screen.unmount();
    screen = await renderApp(bridge, { autoOpen: false });
    // 起動は前回のページ（このフォルダの背景情報のページ）を開く
    expect(railCurrent(screen.container)).toBe("背景情報");
    expect(screen.container.querySelector(".folder-audio .afile .nm")?.textContent).toMatch(/^文章 · /);
    await click(homeButton(screen.container));
    expect(screen.container.querySelector(".recent-row strong")?.textContent).toBe("背景情報");
    expect(screen.container.querySelector(".recent-row small")?.textContent).toContain("無題のフォルダ");
  });

  it("audioInfo待ちの間に移動してもdrop時点のフォルダへ作り、後の選択を上書きしない", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    const first = await folder(bridge, "先に開く");
    const second = await folder(bridge, "後で開く");
    screen = await renderApp(bridge, { autoOpen: false });
    await click(railItem(screen.container, "先に開く"));
    let release!: () => void;
    bridge.audioInfoGate = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => bridge.drop(["/tmp/waiting.m4a"]));
    await click(railItem(screen.container, "後で開く"));
    release();
    await until(() => bridge.projects.get(first.id)?.project.pages?.length === 1);
    expect(bridge.projects.get(second.id)?.project.pages).toEqual([]);
    expect(railItem(screen.container, "後で開く").getAttribute("aria-current")).toBe("page");
  });

  it("フォルダ読込の完了が、後から選んだ同じフォルダのページを戻さない", async () => {
    const bridge = new FakeBridge();
    const target = await folder(bridge, "読み込みを待つフォルダ");
    await bridge.createPage(target.id, { kind: "doc", title: "先の文書", createdAt: "2026-10-16T01:00:00Z" });
    await bridge.createPage(target.id, { kind: "doc", title: "後の文書", createdAt: "2026-10-16T01:01:00Z" });
    screen = await renderApp(bridge, { autoOpen: false });
    await click(railItem(screen.container, "先の文書"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const loadPages = bridge.loadPages.bind(bridge);
    vi.spyOn(bridge, "loadPages").mockImplementationOnce(async (projectId) => {
      await gate;
      return loadPages(projectId);
    });
    await click(railItem(screen.container, "読み込みを待つフォルダ"));
    await click(railItem(screen.container, "後の文書"));
    await act(async () => { release(); await gate; });
    expect(railItem(screen.container, "後の文書").getAttribute("aria-current")).toBe("page");
    expect(titleInput(screen.container).value).toBe("後の文書");
  });

  it("audioInfo待ちの間に入力したフォルダ名をファイル名で上書きしない", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    screen = await renderApp(bridge, { autoOpen: false });
    await newFromMenu(screen.container, "音声");
    const created = [...bridge.projects.values()][0]!;
    let release!: () => void;
    bridge.audioInfoGate = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => bridge.drop(["/tmp/delayed-name.m4a"]));
    await typeInto(titleInput(screen.container), "手入力の題");
    release();
    await until(() => bridge.importKeeps.length === 1);
    await until(() => created.project.name === "手入力の題");
    expect(bridge.projects.size).toBe(1);
    expect(created.project.name).toBe("手入力の題");
  });
});
