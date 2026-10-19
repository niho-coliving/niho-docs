// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import {
  FLOW_TEMPLATES,
  FIXED_RULES,
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  type Flow,
  type Project,
} from "@niho/docs-core";
import { ABOUT_SAVE_DELAY_MS } from "../src/components/AboutCard";
import { button, click, renderApp, typeInto, type Screen } from "./dom";
import { FakeBridge, done } from "./fake-bridge";
import { openAudio, railItem, until, newFolder } from "./pages";

/** 「あなたについて」（spec §5.3c・#18587）: 設定の先頭のカード・自動保存・保存先ごとの about.json・工程の実行のシステム側。 */

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

const ABOUT = { name: "佐藤", text: "ライフコーチをしています。録音では私が聞き手です。" };
const NEW_ROOT = "/Users/test/Documents/NIHO docs 2";

function textProject(flow: Flow): Project {
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

/** 文章から作った今の案件（工程 1 は保存済み）。guide があれば文書ガイドを持つフロー。 */
async function bridgeWithTextProject(guide = "") {
  const bridge = new FakeBridge();
  const flow = { ...createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1"), guide };
  bridge.flow = flow;
  await bridge.createProject(textProject(flow), "[00:00:08] 朝市に出して三年目です。\n", {
    id: "save-1",
    kind: "save",
    at: "2026-10-15T00:00:00.000Z",
    stepId: SOURCE_STEP_ID,
    stepName: "文章",
    version: null,
    result: "saved",
  }, []);
  return bridge;
}

/** ラベルから入力欄を探す（label の htmlFor で結んである）。 */
function field(container: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const found = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`label not found: ${label}`);
  const control = container.ownerDocument.getElementById(found.htmlFor);
  if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) throw new Error(`control not found: ${label}`);
  return control;
}

function aboutCard(container: HTMLElement): HTMLElement {
  return [...container.querySelectorAll<HTMLElement>(".card")].find((card) => card.querySelector("h2")?.textContent === "あなたについて")!;
}

async function openSettings(container: HTMLElement) {
  await click(button(container, "設定"));
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** 入力が止まって保存されるまで待つ。 */
async function waitForAutoSave() {
  await wait(ABOUT_SAVE_DELAY_MS + 150);
}

async function leave(target: HTMLElement) {
  await act(async () => {
    target.focus();
    target.blur();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("設定の「あなたについて」のカード", () => {
  it("設定の先頭（接続設定より上）に、呼び名とパーソナライズの欄・例文・help を出す。保存ボタンは無い", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSettings(container);
    const cards = [...container.querySelectorAll<HTMLElement>(".card")];
    expect(cards[0]!.querySelector("h2")?.textContent).toBe("あなたについて");
    expect(cards[1]!.querySelector("h2")?.textContent).toBe("接続設定");
    const card = aboutCard(container);
    // 呼び名は 1 行（input）、パーソナライズは複数行（textarea 6 行）。label と htmlFor/id で結ぶ
    const name = field(container, "呼び名");
    expect(name.tagName).toBe("INPUT");
    expect(name.placeholder).toBe("例: 佐藤");
    expect(name.classList.contains("inp")).toBe(true);
    const text = field(container, "パーソナライズ") as HTMLTextAreaElement;
    expect(text.tagName).toBe("TEXTAREA");
    expect(text.rows).toBe(6);
    expect(text.placeholder).toBe(
      "例: ライフコーチをしています。クライアントとのセッションを録音し、本人の変化や繰り返し出てくるテーマに気づくために使います。録音では私が聞き手です。まとめは箇条書きで短くしてください。",
    );
    expect(card.querySelector(".help")?.textContent).toBe("すべての録音の工程と「AIと作る」に添えます。");
    expect(card.querySelectorAll("button")).toHaveLength(0);
    // 何も書いていなければ空で、保存もしていない
    expect(name.value).toBe("");
    expect(text.value).toBe("");
    expect(bridge.aboutSaves).toEqual([]);
  });

  it("保存してある内容を欄に出す", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
    bridge.presetAbout(ABOUT);
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSettings(container);
    expect(field(container, "呼び名").value).toBe("佐藤");
    expect(field(container, "パーソナライズ").value).toBe(ABOUT.text);
  });

  it("入力が止まって約 800ms 後に保存する（打っている間は保存しない）", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSettings(container);
    expect(ABOUT_SAVE_DELAY_MS).toBe(800);
    await typeInto(field(container, "呼び名"), "佐藤");
    await wait(300);
    await typeInto(field(container, "パーソナライズ"), ABOUT.text);
    await wait(ABOUT_SAVE_DELAY_MS - 300);
    // 最後の入力から 800ms 経つ前は保存していない（入力のたびに待ち直す）
    expect(bridge.aboutSaves).toEqual([]);
    await wait(400);
    expect(bridge.aboutSaves).toEqual([ABOUT]);
    expect(bridge.aboutFiles.get("/Users/test/Documents/NIHO docs")).toEqual(ABOUT);
    expect(aboutCard(screen.container).querySelector(".err")).toBeNull();
    expect(aboutCard(screen.container).querySelector('[role="status"]')?.textContent).toBe("保存しました");
  });

  it("欄から離れたら待たずに保存する。変えていなければ保存しない", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
    bridge.presetAbout(ABOUT);
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSettings(container);
    await leave(field(container, "呼び名"));
    expect(bridge.aboutSaves).toEqual([]);
    await typeInto(field(container, "呼び名"), "佐藤 花子");
    expect(bridge.aboutSaves).toEqual([]);
    await leave(field(container, "呼び名"));
    expect(bridge.aboutSaves).toEqual([{ name: "佐藤 花子", text: ABOUT.text }]);
    // 離れた後に入力の待ちが残っていても、二重には保存しない
    await waitForAutoSave();
    await leave(field(container, "パーソナライズ"));
    expect(bridge.aboutSaves).toHaveLength(1);
  });

  it("画面を離れるときは、書きかけを保存する。開き直すと保存した内容が出る", async () => {
    const { bridge, container } = await (async () => {
      const made = await bridgeWithTextProject();
      screen = await renderApp(made);
      return { bridge: made, container: screen.container };
    })();
    await openSettings(container);
    await typeInto(field(container, "パーソナライズ"), "退職後に農園を始めました。");
    expect(bridge.aboutSaves).toEqual([]);
    // 入力の待ちの途中で別のページへ移る
    await openAudio(container);
    expect(container.querySelector(".card h2")?.textContent).not.toBe("あなたについて");
    expect(bridge.aboutSaves).toEqual([{ name: "", text: "退職後に農園を始めました。" }]);
    await openSettings(container);
    expect(field(container, "パーソナライズ").value).toBe("退職後に農園を始めました。");
  });

  it("2,000 字を超えたら理由を出して保存しない。直したら保存する", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
    bridge.presetAbout(ABOUT);
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSettings(container);
    await typeInto(field(container, "パーソナライズ"), "あ".repeat(2000));
    await waitForAutoSave();
    expect(bridge.aboutSaves).toEqual([{ name: "佐藤", text: "あ".repeat(2000) }]);
    expect(aboutCard(container).querySelector(".err")).toBeNull();

    await typeInto(field(container, "パーソナライズ"), "あ".repeat(2140));
    const error = aboutCard(container).querySelector(".err");
    expect(error?.textContent).toBe("「パーソナライズ」は 2,000 字までにしてください（今 2,140 字）。");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(field(container, "パーソナライズ").getAttribute("aria-invalid")).toBe("true");
    // 待っても、欄から離れても、呼び名を直しても保存しない
    await waitForAutoSave();
    await leave(field(container, "パーソナライズ"));
    await typeInto(field(container, "呼び名"), "田中");
    await waitForAutoSave();
    await leave(field(container, "呼び名"));
    expect(bridge.aboutSaves).toHaveLength(1);
    expect(bridge.aboutFiles.get("/Users/test/Documents/NIHO docs")?.text).toBe("あ".repeat(2000));

    // 2,000 字以内に直すと理由が消えて保存する（呼び名の直しも一緒に）
    await typeInto(field(container, "パーソナライズ"), "あ".repeat(1999));
    expect(aboutCard(container).querySelector(".err")).toBeNull();
    expect(field(container, "パーソナライズ").getAttribute("aria-invalid")).toBeNull();
    await waitForAutoSave();
    expect(bridge.aboutSaves).toHaveLength(2);
    expect(bridge.aboutSaves[1]).toEqual({ name: "田中", text: "あ".repeat(1999) });
  });

  it("保存できなければ理由と再試行を出し、「もう一度」で保存し直す", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
    bridge.aboutSaveFailure = { code: "store_io", message: "保存先の読み書きに失敗しました（書き込めません）。" };
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSettings(container);
    await typeInto(field(container, "呼び名"), "佐藤");
    await leave(field(container, "呼び名"));
    const error = aboutCard(container).querySelector(".err");
    expect(error?.textContent).toBe("保存できませんでした。保存先の読み書きに失敗しました（書き込めません）。");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(button(aboutCard(container), "もう一度")).toBeTruthy();
    expect(bridge.aboutSaves).toEqual([]);
    // 直ったら、同じ内容でも再試行ボタンから保存できる
    bridge.aboutSaveFailure = null;
    await click(button(aboutCard(container), "もう一度"));
    expect(bridge.aboutSaves).toEqual([{ name: "佐藤", text: "" }]);
    expect(aboutCard(container).querySelector(".err")).toBeNull();
  });

  it("未保存の変更があると設定を離れる前に確認し、戻るか破棄を選べる", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
    bridge.aboutSaveFailure = { code: "store_io", message: "保存先の読み書きに失敗しました。" };
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSettings(container);
    const name = field(container, "呼び名");
    await typeInto(name, "佐藤");
    await leave(name);
    await click(button(container, "工程設計"));
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe("保存していない変更があります");
    expect(container.querySelector("h1")?.textContent).toBe("設定");

    await click(button(container, "戻る"));
    expect(field(container, "呼び名").value).toBe("佐藤");
    await click(button(container, "工程設計"));
    await click(button(container, "破棄して移動"));
    expect(container.querySelector("h1")?.textContent).toBe("工程設計");

    await openSettings(container);
    expect(field(container, "呼び名").value).toBe("");
    expect(bridge.aboutSaves).toEqual([]);
  });

  it("未保存の変更を⌘N・新しいフォルダ・音声dropでも黙って破棄しない", async () => {
    const bridge = new FakeBridge();
    bridge.aboutSaveFailure = { code: "store_io", message: "保存先の読み書きに失敗しました。" };
    screen = await renderApp(bridge, { autoOpen: false });
    const { container } = screen;
    await openSettings(container);
    await typeInto(field(container, "呼び名"), "佐藤");

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true, bubbles: true })));
    await until(() => container.querySelector('[role="dialog"]') !== null);
    expect(bridge.outside.project.pages).toEqual([]);
    await click(button(container, "戻る"));

    await newFolder(container);
    await until(() => container.querySelector('[role="dialog"]') !== null);
    expect(bridge.projects.size).toBe(0);
    await click(button(container, "戻る"));

    await act(async () => bridge.drop(["/tmp/guarded.m4a"]));
    await until(() => container.querySelector('[role="dialog"]') !== null);
    expect(bridge.outside.project.pages).toEqual([]);
  });
});

describe("保存先ごとの about.json", () => {
  it("保存先を変えると、新しい保存先の about.json を読み直して欄に出す", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
    bridge.presetAbout(ABOUT);
    bridge.aboutFiles.set(NEW_ROOT, { name: "新しい人", text: "別の保存先の説明です。" });
    bridge.pickedDocsRoot = NEW_ROOT;
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSettings(container);
    expect(field(container, "呼び名").value).toBe("佐藤");
    await click(button(container, "変更"));
    expect(field(container, "呼び名").value).toBe("新しい人");
    expect(field(container, "パーソナライズ").value).toBe("別の保存先の説明です。");
    // 元の保存先の about.json は書き換えない
    expect(bridge.aboutFiles.get("/Users/test/Documents/NIHO docs")).toEqual(ABOUT);
    expect(bridge.aboutSaves).toEqual([]);
  });

  it("新しい保存先に about.json が無ければ、今の内容を写す（フローと同じ）", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
    bridge.presetAbout(ABOUT);
    bridge.pickedDocsRoot = NEW_ROOT;
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSettings(container);
    await click(button(container, "変更"));
    expect(bridge.aboutFiles.get(NEW_ROOT)).toEqual(ABOUT);
    expect(field(container, "呼び名").value).toBe("佐藤");
  });
  it("保存の途中の「あなたについて」が終わってから保存先を切り替え、新しい保存先へは保存した内容を写す", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
    bridge.presetAbout(ABOUT);
    bridge.pickedDocsRoot = NEW_ROOT;
    const save = bridge.saveAbout.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(bridge, "saveAbout").mockImplementation(async (about) => {
      await gate;
      return save(about);
    });
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSettings(container);
    await typeInto(field(container, "呼び名"), "鈴木");
    // 欄から離れて保存が始まり（まだ終わらない）、同じ操作で保存先の「変更」を押す
    await leave(field(container, "呼び名"));
    await click(button(container, "変更"));
    expect(bridge.docsRootOverride).toBeNull();
    release();
    await until(() => bridge.docsRootOverride === NEW_ROOT);
    await until(() => bridge.aboutFiles.get(NEW_ROOT)?.name === "鈴木");
    // 元の保存先にも、入力した内容が書かれている
    expect(bridge.aboutFiles.get("/Users/test/Documents/NIHO docs")?.name).toBe("鈴木");
  });

  it("新しい保存先へ写せなかったら知らせる（保存先の変更そのものは続ける）", async () => {
    const bridge = new FakeBridge();
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
    bridge.presetAbout(ABOUT);
    bridge.pickedDocsRoot = NEW_ROOT;
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSettings(container);
    bridge.aboutSaveFailure = { code: "store_io", message: "保存先の読み書きに失敗しました（書き込めません）。" };
    await click(button(container, "変更"));
    await until(() => bridge.docsRootOverride === NEW_ROOT);
    await until(() => container.querySelector(".failure-band .fb-msg") !== null);
    const toast = container.querySelector(".failure-band .fb-msg")?.textContent ?? "";
    expect(toast).toContain("「あなたについて」を新しい保存先へ写せませんでした");
    expect(toast).toContain("保存先の読み書きに失敗しました（書き込めません）。");
    expect(bridge.aboutFiles.has(NEW_ROOT)).toBe(false);
  });
});

describe("工程の実行のシステム側", () => {
  it("固定の決まりの後・「## 文書ガイド」の前に「## あなたについて」を入れる（ユーザー側には入れない）", async () => {
    const bridge = await bridgeWithTextProject("## 文書の目的と読者\n来訪者に向けて書く。");
    bridge.presetAbout(ABOUT);
    bridge.turnScript = () => [done("成果")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "続きを作成"));
    const request = bridge.turnRequests[0]!;
    const system = request.system_prompt;
    expect(system.startsWith(FIXED_RULES)).toBe(true);
    const aboutAt = system.indexOf("## あなたについて\n\n呼び名: 佐藤\n\nライフコーチをしています。録音では私が聞き手です。");
    expect(aboutAt).toBe(FIXED_RULES.length + 2);
    expect(system.indexOf("## 文書ガイド")).toBeGreaterThan(aboutAt);
    expect(system.indexOf("## この工程")).toBeGreaterThan(system.indexOf("## 文書ガイド"));
    expect(request.user_prompt).not.toContain("あなたについて");
    expect(request.user_prompt).not.toContain("佐藤");
  });

  it("空なら節を入れない（呼び名もパーソナライズも空白だけのときも）", async () => {
    for (const about of [null, { name: " ", text: "\n " }]) {
      const bridge = await bridgeWithTextProject();
      if (about) bridge.presetAbout(about);
      bridge.turnScript = () => [done("成果")];
      screen = await renderApp(bridge);
      await click(button(screen.container, "続きを作成"));
      expect(bridge.turnRequests.length).toBeGreaterThan(0);
      for (const request of bridge.turnRequests) expect(request.system_prompt).not.toContain("## あなたについて");
      screen.unmount();
      screen = null;
    }
  });

  it("設定で書いて保存した内容が、次の実行から効く", async () => {
    const bridge = await bridgeWithTextProject();
    bridge.turnScript = () => [done("成果")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await openSettings(container);
    await typeInto(field(container, "呼び名"), "佐藤");
    await leave(field(container, "呼び名"));
    await openAudio(container);
    await click(button(container, "続きを作成"));
    expect(bridge.turnRequests.length).toBeGreaterThan(0);
    for (const request of bridge.turnRequests) {
      expect(request.system_prompt).toContain("## あなたについて\n\n呼び名: 佐藤\n\n## この工程");
    }
  });

  it("実行中も設定の「あなたについて」は編集できる（ロックしない）", async () => {
    const bridge = await bridgeWithTextProject();
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
    await openSettings(container);
    expect(field(container, "呼び名").disabled).toBe(false);
    expect(field(container, "パーソナライズ").disabled).toBe(false);
    await typeInto(field(container, "パーソナライズ"), "実行中に書きました。");
    await leave(field(container, "パーソナライズ"));
    expect(bridge.aboutSaves).toEqual([{ name: "", text: "実行中に書きました。" }]);
    // 実行中の工程は、始めたときの内容のまま
    expect(bridge.turnRequests[0]!.system_prompt).not.toContain("実行中に書きました。");
    release();
    await wait(0);
  });
});
