// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FLOW_TEMPLATES, SOURCE_STEP_ID, createFlowFromTemplate, createFlowSnapshot, defaultProfiles, type Flow, type Project } from "@niho/docs-core";
import { click, renderApp, typeInto, type Screen } from "./dom";
import { FakeBridge, done } from "./fake-bridge";
import { chatToggle, exportFromMenu, openChat, openPageMenu, pageMenuAction, pageMenuButton, pageMenuItems, railItem, seedRun, until } from "./pages";

/**
 * ページの上端の操作と「AIと作る」（owner 2026-10-18・#18941・モック niho-docs-page-top-ai-composer-v2）: タイトルバーの右端は
 * ［AIと作る］［⋯］だけで、書き出し・検索・書式は ⋯ の中。「AIと作る」は閉じて始まり、閉じている間の作業中・新しい返事は点で
 * 知らせる。入力欄にプレースホルダーを置かず、説明は見出しの ⓘ。
 */

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

const MEMO = "# 事前メモ\n\n- 質問を3つ\n";

function project(flow: Flow): Project {
  return {
    version: 1,
    id: "",
    name: "朝市 インタビュー",
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    info: { speakers: "2", language: "ja", terms: [], background: "" },
    source: { kind: "text" },
  };
}

/** 文章から作った案件（工程 1 を実行済み）と、同じフォルダの文書ページ「事前メモ」。「AIと作る」は閉じたまま事前メモを開く。 */
async function setup() {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
  bridge.flow = flow;
  const created = await bridge.createProject(
    project(flow),
    "[00:00:08] 朝市に出して三年目です。\n",
    { id: "save-1", kind: "save", at: "2026-10-15T00:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" },
    [],
  );
  await seedRun(bridge, created.id, flow.steps[0]!, "# 本文\n\n朝市に出して三年目。\n");
  const memo = await bridge.createPage(created.id, { kind: "doc", title: "事前メモ", createdAt: "2026-10-16T00:00:00.000Z" });
  await bridge.writePage(created.id, memo.id, MEMO);
  screen = await renderApp(bridge, { openChat: false });
  const container = screen.container;
  await click(railItem(container, "事前メモ"));
  await until(() => container.querySelector(".pbody .ProseMirror")?.textContent?.includes("質問を3つ") ?? false);
  return { bridge, flow, projectId: created.id, container };
}

/** タイトルバーの右端に並ぶ操作の名前。 */
function titlebarActions(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>(".window-titlebar .acts > *")].map((element) =>
    element.getAttribute("aria-label") ?? element.querySelector("button")?.getAttribute("aria-label") ?? element.textContent?.trim() ?? "",
  );
}

function infoButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('.chatcard button[aria-label="AIと作る の説明"]')!;
}

async function pressKey(init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    document.dispatchEvent(event);
  });
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  return event;
}

describe("ページの上端の操作", () => {
  it("タイトルバーは［AIと作る］［⋯］だけで、AIと作る は閉じて始まり、開くとページを移っても開いたまま。開き直すと閉じている", async () => {
    const { bridge, container } = await setup();
    expect(titlebarActions(container)).toEqual(["AIと作る", "その他"]);
    expect([...container.querySelectorAll(".window-titlebar button")].some((element) => element.textContent?.includes("書き出し"))).toBe(false);
    expect(chatToggle(container)?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".chatcard")).toBeNull();
    expect(container.querySelector(".work")?.classList.contains("noai")).toBe(true);

    await click(chatToggle(container)!);
    expect(chatToggle(container)?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".chatcard")).not.toBeNull();
    // 録音のページへ移っても開いたまま
    await click(railItem(container, "文章"));
    expect(chatToggle(container)?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".chatcard")).not.toBeNull();

    // 開閉は保存しない（アプリを開き直すと閉じている）
    screen!.unmount();
    screen = await renderApp(bridge, { openChat: false });
    await click(railItem(screen.container, "事前メモ"));
    expect(chatToggle(screen.container)?.getAttribute("aria-pressed")).toBe("false");
    expect(screen.container.querySelector(".chatcard")).toBeNull();
  });

  it("メタ行に 🔍・Aa を置かず、⋯ の 検索 ⌘F・書式を表示・書き出し › から開く。⌘F でも検索が開く", async () => {
    const { container } = await setup();
    expect(container.querySelector(".pmeta button, .pmeta .et-icon")).toBeNull();
    expect(container.querySelector('button[aria-label="検索を開く"], button[aria-label="書式を表示"]')).toBeNull();

    const menu = await openPageMenu(container);
    expect(pageMenuItems(menu)).toEqual(["検索", "書式を表示", "書き出し", "フォルダへ移す", "上へ移動", "下へ移動", "削除"]);
    // 検索・書式・書き出しの後に区切り、その後に今までの項目
    expect(menu.children[3]?.classList.contains("menu-separator")).toBe(true);
    expect(menu.querySelector('[role="menuitem"]')?.textContent).toContain("⌘F");

    // 書式を表示 → 書式の行（⋯ の項目は「書式を閉じる」になる）
    await pageMenuAction(container, "書式を表示");
    expect(container.querySelector('[role="toolbar"][aria-label="文書の書式"]')).not.toBeNull();
    expect(document.activeElement).toBe(pageMenuButton(container));
    expect(pageMenuItems(await openPageMenu(container))).toContain("書式を閉じる");
    await pageMenuAction(container, "書式を閉じる");
    expect(container.querySelector('[role="toolbar"][aria-label="文書の書式"]')).toBeNull();
    expect(document.activeElement).toBe(pageMenuButton(container));

    // 検索 → 検索の箱（語の欄へフォーカス）
    await pageMenuAction(container, "検索");
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    expect(container.querySelector('[role="search"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("検索語");
    await click(container.querySelector('button[aria-label="検索を閉じる"]')!);
    expect(container.querySelector('[role="search"]')).toBeNull();

    // ⌘F でも開く
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    const modalShortcut = await pressKey({ key: "f", metaKey: true });
    expect(modalShortcut.defaultPrevented).toBe(false);
    expect(container.querySelector('[role="search"]')).toBeNull();
    dialog.remove();

    const event = await pressKey({ key: "f", metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector('[role="search"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("検索語");
  });

  it("⋯ の 書き出し › からコピー・.md で保存が動き、録音のページの ⋯ には検索・書式・書き出しを出さない", async () => {
    const { bridge, container } = await setup();
    await exportFromMenu(container, "コピー");
    expect(bridge.copied.at(-1)).toContain("質問を3つ");
    // 選んだらメニューを閉じ、フォーカスは ⋯ へ戻す
    expect(container.querySelector(".window-titlebar .pagemenu .pop")).toBeNull();
    expect(document.activeElement).toBe(pageMenuButton(container));
    await exportFromMenu(container, ".md で保存");
    expect(bridge.exportedNames.at(-1)).toBe("朝市 インタビュー 事前メモ.md");

    await click(railItem(container, "朝市 インタビュー"));
    const items = pageMenuItems(await openPageMenu(container));
    expect(items).toContain("フォルダへ移す");
    expect(items).not.toContain("検索");
    expect(items).not.toContain("書式を表示");
    expect(items).not.toContain("書き出し");
  });
});

describe("AIと作る", () => {
  it("閉じている間の作業中と新しい返事に点を付け、開くと消す。閉じても打ちかけは残る", async () => {
    const { bridge, projectId, container } = await setup();
    await openChat(container);
    // 閉じて開いても打ちかけは残る（会話・打ちかけは App の useChat が持つ）
    await typeInto(container.querySelector('textarea[aria-label="直したいこと"]')!, "打ちかけ");
    await click(chatToggle(container)!);
    expect(container.querySelector(".chatcard")).toBeNull();
    expect(container.querySelector(".chat-toggle .chat-dot")).toBeNull();
    await click(chatToggle(container)!);
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="直したいこと"]')?.value).toBe("打ちかけ");

    let release!: () => void;
    bridge.chatGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bridge.chatScript = () => [done("確かめました。")];
    await typeInto(container.querySelector('textarea[aria-label="直したいこと"]')!, "表記を確かめて");
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="送信"]')!);
    await until(() => container.querySelector('button[aria-label="停止"]') !== null);
    // 開いている間は点を付けない
    expect(container.querySelector(".chat-toggle .chat-dot")).toBeNull();
    await click(chatToggle(container)!);
    expect(chatToggle(container)?.getAttribute("aria-label")).toBe("AIと作る（作業中）");
    expect(container.querySelector(".chat-toggle .chat-dot")).not.toBeNull();

    await act(async () => {
      release();
    });
    await until(() => !bridge.locks.has(projectId));
    await until(() => chatToggle(container)?.getAttribute("aria-label") === "AIと作る（新しい返事）");
    expect(container.querySelector(".chat-toggle .chat-dot")).not.toBeNull();

    // 開くと未読は消える（閉じ直しても点は付かない）
    await click(chatToggle(container)!);
    expect(chatToggle(container)?.getAttribute("aria-label")).toBe("AIと作る");
    expect(container.querySelector(".chat .bubble.ai")?.textContent).toBe("確かめました。");
    await click(chatToggle(container)!);
    expect(chatToggle(container)?.getAttribute("aria-label")).toBe("AIと作る");
    expect(container.querySelector(".chat-toggle .chat-dot")).toBeNull();
  });

  it("入力欄にプレースホルダーを置かず、送信は ⏎、説明は見出しの ⓘ（押すと出て、外を押す・Esc で閉じる）", async () => {
    const { container } = await setup();
    await openChat(container);
    const area = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="直したいこと"]')!;
    expect(area.hasAttribute("placeholder")).toBe(false);
    expect(container.querySelector('button[aria-label="送信"] polyline')?.getAttribute("points")).toBe("9 10 4 15 9 20");
    // 空の会話の本文に説明の文を出さない
    expect(container.querySelector(".chat-empty")).toBeNull();
    expect(container.querySelector(".chat")?.textContent).not.toContain("直したいこと");

    const info = infoButton(container);
    expect(info.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('.chatcard [role="note"]')).toBeNull();
    await click(info);
    expect(infoButton(container).getAttribute("aria-expanded")).toBe("true");
    const note = container.querySelector<HTMLElement>('.chatcard [role="note"]')!;
    expect(note.textContent).toBe("直したいこと・作りたい文書を書くと、AI がこのページや同じフォルダの文書を直したり、新しい文書を作ったりします。");
    expect(infoButton(container).getAttribute("aria-controls")).toBe(note.id);
    await pressKey({ key: "Escape" });
    expect(container.querySelector('.chatcard [role="note"]')).toBeNull();
    // 外を押しても閉じる
    await click(infoButton(container));
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(container.querySelector('.chatcard [role="note"]')).toBeNull();
    expect(infoButton(container).getAttribute("aria-expanded")).toBe("false");

    // 録音のページの説明
    await click(railItem(container, "文章"));
    await click(infoButton(container));
    expect(container.querySelector('.chatcard [role="note"]')?.textContent).toBe(
      "直したいことを書くと、AI がこの録音の文書を書き換えて版を足します。同じフォルダの文書を直したり、新しい文書を作ったりもできます。",
    );
  });
});
