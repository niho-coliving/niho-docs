// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { button, click, renderApp, type Screen } from "./dom";
import { FakeBridge } from "./fake-bridge";
import { railItem, until } from "./pages";

let screen: Screen | null = null;
afterEach(() => { screen?.unmount(); screen = null; });

async function folder(bridge: FakeBridge, name: string) {
  return bridge.createProject({ version: 1, id: "", name, createdAt: "2026-10-16T00:00:00Z", info: { terms: [], background: "" }, pages: [] }, null, null, []);
}

describe("並べ替えメニュー", () => {
  it("ページの上/下を端でdisabledにし、下へ移動は同じ場所のpagesだけを並べ替える", async () => {
    const bridge = new FakeBridge();
    const place = await folder(bridge, "資料");
    for (const title of ["A", "B", "C"]) await bridge.createPage(place.id, { kind: "doc", title, createdAt: "2026-10-16T00:00:00Z" });
    screen = await renderApp(bridge);
    await click(railItem(screen.container, "B"));
    await click(screen.container.querySelector('.window-titlebar .acts button[aria-label="その他"]')!);
    const menu = screen.container.querySelector<HTMLElement>(".pagemenu .pop")!;
    expect(button(menu, "上へ移動").disabled).toBe(false);
    expect(button(menu, "下へ移動").disabled).toBe(false);
    await click(button(menu, "下へ移動"));
    await until(() => bridge.byName("資料").project.pages?.map((page) => page.title).join() === "A,C,B");
    expect(bridge.byName("資料").project.pages?.map((page) => page.title)).toEqual(["A", "C", "B"]);
  });

  it("フォルダへ移すはaria付きsubmenuとしてEnter/矢印で開き、Escで閉じる", async () => {
    const bridge = new FakeBridge();
    const source = await folder(bridge, "元");
    await folder(bridge, "先");
    await bridge.createPage(source.id, { kind: "doc", title: "メモ", createdAt: "2026-10-16T00:00:00Z" });
    screen = await renderApp(bridge);
    await click(screen.container.querySelector('.window-titlebar .acts button[aria-label="その他"]')!);
    const trigger = button(screen.container.querySelector<HTMLElement>(".pagemenu .pop")!, "フォルダへ移す");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const submenu = screen.container.querySelector<HTMLElement>('[role="menu"][aria-label="移動先"]')!;
    expect(submenu).not.toBeNull();
    expect(submenu.contains(document.activeElement)).toBe(true);
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(screen.container.querySelector(".pagemenu .pop")).toBeNull();
    await click(screen.container.querySelector('.window-titlebar .acts button[aria-label="その他"]')!);
    expect(button(screen.container.querySelector<HTMLElement>(".pagemenu .pop")!, "フォルダへ移す").getAttribute("aria-expanded")).toBe("false");
  });

  it("フォルダの⋯は常時buttonで、上へ移動するとindex順を保存する", async () => {
    const bridge = new FakeBridge();
    const first = await folder(bridge, "一");
    const second = await folder(bridge, "二");
    screen = await renderApp(bridge, { autoOpen: false });
    const cases = [...screen.container.querySelectorAll<HTMLElement>(".rail div.case")];
    await click(cases[1]!.querySelector('button[aria-label="フォルダのその他"]')!);
    await click(button(cases[1]!.querySelector<HTMLElement>(".folder-menu .pop")!, "上へ移動"));
    await until(() => bridge.projectOrder[0] === second.id);
    expect(bridge.projectOrder).toEqual([second.id, first.id]);
  });
});
