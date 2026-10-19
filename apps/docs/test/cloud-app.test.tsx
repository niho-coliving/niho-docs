// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Editor } from "@tiptap/react";
import { ACCOUNT_COMMANDS, type AccountTransport } from "niho-desktop-account/account-bridge";
import type { AccountState } from "niho-desktop-account/account-state";
import {
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  type Flow,
  type Project,
} from "@niho/docs-core";
import { DOCS_ROOT_PROJECT_ID, type RemoteProject } from "../src/lib/cloud-types";
import { defaultSettings, normalizeSettings } from "../src/lib/settings";
import { button, click, renderApp, typeInto, type Screen } from "./dom";
import { FakeBridge, activeCloud, cloudStateOf, conflictEntryOf, done, syncSnapshot } from "./fake-bridge";
import { exportFromMenu, railCurrent, railItem, railPages, rebuild, rebuildItem, seedRun, until } from "./pages";
import { THREE_STEP_TEMPLATE } from "./three-step-flow";

/**
 * NIHO クラウドの画面（C3 #18595）: 設定の保存先のクラウド（ログイン・実行中・確かめ・移行の進み・別のアカウント）・レールの
 * クラウドにだけある案件と別の Mac の実行中・文書のページの保存の状態と「最新を表示」「変更を確認」・成果物の自動保存と自動の版（#18912）・
 * 閉じる前の書き残し・lease_held・音声の期限切れ。
 */

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

const profile = { userId: "user-1", displayName: "文書 太郎", handle: "docs-taro", connectionId: "connection-1", avatarPath: null };

/** NIHO アカウントの状態だけを返す transport（ログインの操作は呼んだ記録だけ）。 */
function account(state: AccountState): { transport: AccountTransport; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    transport: {
      invoke: async <T,>(command: string) => {
        calls.push(command);
        return (command === ACCOUNT_COMMANDS.state ? state : undefined) as T;
      },
      listen: async () => () => undefined,
    },
  };
}

const signedIn = (): AccountState => ({ kind: "signedIn", profile });

function pagedProject(name: string): Project {
  return { version: 1, id: "", name, createdAt: "2026-10-16T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] };
}

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

async function textProjectBridge() {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(THREE_STEP_TEMPLATE, "flow-1");
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
  return { bridge, flow, project, stored: bridge.projects.get(project.id)! };
}

/** 文書のページ 1 枚の案件（本文つき）。 */
async function docBridge(body: string) {
  const bridge = new FakeBridge();
  const project = await bridge.createProject(pagedProject("朝市"), null, null, []);
  const page = await bridge.createPage(project.id, { kind: "doc", title: "事前メモ", createdAt: "2026-10-16T00:00:00.000Z" });
  bridge.projects.get(project.id)!.docs[page.id] = body;
  return { bridge, projectId: project.id, pageId: page.id, path: `pages/${page.id}.md` };
}

function remote(fields: Partial<RemoteProject> & Pick<RemoteProject, "projectId" | "name">): RemoteProject {
  return { revision: 1, updatedAt: "2026-10-16T00:00:00.000Z", bytes: 0, local: false, lease: null, ...fields };
}

/** まだ有効な別の Mac の lease の期限（期限切れの lease は画面が無いものとして扱う）。 */
const LEASE_ALIVE = (afterMs = 3_600_000) => new Date(Date.now() + afterMs).toISOString();

function rowOf(container: HTMLElement, label: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(".prow")].find((row) => row.querySelector("b")?.textContent === label);
}

function dialog(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error("dialog not found");
  return found;
}

function bodyEditor(container: HTMLElement): Editor {
  const element = container.querySelector(".pbody .ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  if (!element?.editor) throw new Error("editor not found");
  return element.editor;
}

function saveText(container: HTMLElement): string {
  return container.querySelector(".pmeta .savest")?.textContent?.replace("·", "") ?? "";
}

async function wait(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("設定の保存先のクラウド", () => {
  it("同期済み文書のリンクを公開し、作り直した旧リンクを無効にする操作へ進める", async () => {
    const { bridge, projectId, pageId } = await docBridge("共有する本文");
    bridge.cloud = activeCloud();
    bridge.cloudSnapshots.set(projectId, syncSnapshot(projectId, { lastSyncedAt: "2026-10-18T03:00:00.000Z" }));
    screen = await renderApp(bridge, account(signedIn()).transport);
    const { container } = screen;
    await exportFromMenu(container, "リンクで共有");
    await until(() => container.querySelector('.docs-share-panel [role="switch"]') !== null);
    const toggle = () => container.querySelector<HTMLInputElement>('.docs-share-panel [role="switch"]')!;
    expect(toggle().disabled).toBe(false);
    await act(async () => { toggle().click(); });
    await until(() => bridge.pageShareCalls.some((call) => call.action === "publish" && call.pageId === pageId));
    expect(container.querySelector('.docs-share-panel input[aria-label="共有リンク"]')).not.toBeNull();
    await click(button(container, "リンクを作り直す"));
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain("今のリンクでは見られなくなります");
    await click(button(container, "作り直す"));
    await until(() => bridge.pageShareCalls.some((call) => call.action === "rotate" && call.pageId === pageId));
    expect((container.querySelector('.docs-share-panel input[aria-label="共有リンク"]') as HTMLInputElement).value).toContain("/docs/p#" + "r".repeat(22));
  });

  it("起動時の profile 同期が終わるまで古い実行先で開始・変更させない", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = activeCloud();
    bridge.cloudSnapshots.set("profile", syncSnapshot("profile", { syncing: true }));
    bridge.execution = { version: 1, route: "own_mac", preferredMacRunnerId: "runner_mac_1" };
    bridge.pcRunner = { enabled: true, state: "idle", label: null, runnerId: "runner_mac_1" };
    screen = await renderApp(bridge, account(signedIn()).transport);
    await click(button(screen.container, "設定"));
    const row = rowOf(screen.container, "残りの工程")!;
    expect(button(row, "クラウド").disabled).toBe(true);
    expect(button(row, "この Mac").disabled).toBe(true);
    bridge.emitCloudProject("profile", syncSnapshot("profile", { lastSyncedAt: "2026-10-18T00:00:00.000Z" }));
    await until(() => rowOf(screen!.container, "残りの工程")?.querySelector('button[aria-pressed="true"]')?.textContent === "この Mac");
    expect(button(rowOf(screen.container, "残りの工程")!, "クラウド").disabled).toBe(false);
  });

  it("クラウド接続中は本人共通の実行先を読み、変更を execution.json に保存する", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = activeCloud();
    bridge.execution = { version: 1, route: "own_mac", preferredMacRunnerId: "runner_mac_1" };
    bridge.pcRunner = { enabled: true, state: "idle", label: null, runnerId: "runner_mac_1" };
    screen = await renderApp(bridge, account(signedIn()).transport);
    await click(button(screen.container, "設定"));
    await until(() => rowOf(screen!.container, "残りの工程")?.textContent?.includes("この Mac") ?? false);
    const row = rowOf(screen.container, "残りの工程")!;
    expect(row.closest(".card")?.querySelector("h2")?.textContent).toBe("残りの工程");
    expect(row.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.textContent).toBe("この Mac");
    expect(row.parentElement?.textContent).toContain("NIHO アカウントで共有し、iPhone・Web・Mac の新しい実行に使います");
    await click(button(row, "クラウド"));
    await until(() => bridge.executionSaves.length === 1);
    expect(bridge.executionSaves).toEqual([{ version: 1, route: "cloud", preferredMacRunnerId: null }]);
  });

  it("共有の実行先は通常設定の保存に混ぜず、この Mac の fallback を保つ", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = activeCloud();
    bridge.settings = { ...defaultSettings(), personalExecution: { continuation: "niho_api" } };
    bridge.execution = { version: 1, route: "own_mac", preferredMacRunnerId: "runner_mac_1" };
    bridge.pcRunner = { enabled: true, state: "idle", label: null, runnerId: "runner_mac_1" };
    screen = await renderApp(bridge, account(signedIn()).transport);
    await click(button(screen.container, "設定"));
    await until(() => rowOf(screen!.container, "残りの工程")?.textContent?.includes("この Mac") ?? false);
    await click(screen.container.querySelector<HTMLButtonElement>('[aria-label="接続の方式"] button:nth-child(2)')!);
    expect(normalizeSettings(bridge.settings).connection).toBe("apiKey");
    expect(normalizeSettings(bridge.settings).personalExecution).toEqual({ continuation: "niho_api" });
  });

  it("実行先の保存が終わる前に変えた他の設定を、保存完了後も保つ", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = activeCloud();
    bridge.execution = { version: 1, route: "cloud", preferredMacRunnerId: null };
    bridge.pcRunner = { enabled: true, state: "idle", label: null, runnerId: "runner_mac_1" };
    let resolveExecution!: () => void;
    const executionSave = new Promise<void>((resolve) => { resolveExecution = resolve; });
    bridge.saveExecution = async (value) => {
      await executionSave;
      bridge.execution = { ...value };
      bridge.executionSaves.push({ ...value });
    };
    screen = await renderApp(bridge, account(signedIn()).transport);
    await click(button(screen.container, "設定"));
    await until(() => rowOf(screen!.container, "残りの工程")?.querySelector("button") !== null);
    await click(button(rowOf(screen.container, "残りの工程")!, "この Mac"));
    await click(screen.container.querySelector<HTMLButtonElement>('[aria-label="接続の方式"] button:nth-child(2)')!);
    await until(() => normalizeSettings(bridge.settings).connection === "apiKey");
    resolveExecution();
    await until(() => bridge.executionSaves.length === 1);
    expect(normalizeSettings(bridge.settings).connection).toBe("apiKey");
    expect(bridge.executionSaves).toEqual([{ version: 1, route: "own_mac", preferredMacRunnerId: "runner_mac_1" }]);
  });

  it("別の Mac が保存されているときも、この Mac の明示選択で宛先を更新する", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = activeCloud();
    bridge.execution = { version: 1, route: "own_mac", preferredMacRunnerId: "runner_other" };
    bridge.pcRunner = { enabled: true, state: "idle", label: null, runnerId: "runner_this_mac" };
    screen = await renderApp(bridge, account(signedIn()).transport);
    await click(button(screen.container, "設定"));
    await until(() => screen!.container.textContent?.includes("選んだ Mac を利用できません") ?? false);
    const row = rowOf(screen.container, "残りの工程")!;
    expect(row.querySelector('button[aria-pressed="true"]')).toBeNull();
    await click(button(row, "この Mac"));
    await until(() => bridge.executionSaves.length === 1);
    expect(bridge.executionSaves).toEqual([{ version: 1, route: "own_mac", preferredMacRunnerId: "runner_this_mac" }]);
  });

  describe("残りの工程で「この Mac」を選べないとき（#19107）", () => {
    const executionRow = () => rowOf(screen!.container, "残りの工程")!;
    const pressedLabel = () => executionRow().querySelector('button[aria-pressed="true"]')?.textContent ?? null;
    /** 「残りの工程」の下に出る、選べない理由の 1 行（保存の失敗は出ない）。 */
    const notice = () => executionRow().parentElement?.querySelector<HTMLElement>('[role="alert"]') ?? null;

    /** クラウド接続中・実行先は「クラウド」で、設定を開いた状態。 */
    async function openSettingsOnCloud(pcRunner: FakeBridge["pcRunner"]) {
      const bridge = new FakeBridge();
      bridge.cloud = activeCloud();
      bridge.execution = { version: 1, route: "cloud", preferredMacRunnerId: null };
      bridge.pcRunner = pcRunner;
      screen = await renderApp(bridge, account(signedIn()).transport);
      await click(button(screen.container, "設定"));
      await until(() => pressedLabel() === "クラウド");
      return bridge;
    }

    it("受け入れが OFF なら、オンにする設定を案内し、保存せず今の実行先を保つ。オンにすると選べる", async () => {
      const bridge = await openSettingsOnCloud({ enabled: false, state: "off", label: null, runnerId: null });
      await click(button(executionRow(), "この Mac"));
      await until(() => notice() !== null);
      expect(notice()!.textContent).toBe("「この Mac」を選ぶには、先にこの画面の「この Mac で続きを受ける」をオンにしてください。");
      // 汎用の保存失敗には置き換わらず、保存は呼ばれず、選択は「クラウド」のまま（選択の表示を消さない）
      expect(executionRow().parentElement?.textContent).not.toContain("実行先を保存できませんでした");
      expect(bridge.executionSaves).toEqual([]);
      expect(pressedLabel()).toBe("クラウド");
      expect(button(executionRow(), "この Mac").disabled).toBe(false);

      // 受け入れをオンにする（Rust の状態通知）と案内は消え、この Mac を選べて、その ID が保存される
      bridge.emitPcRunner({ enabled: true, state: "idle", label: null, runnerId: "runner_mac_1" });
      await until(() => notice() === null);
      await click(button(executionRow(), "この Mac"));
      await until(() => bridge.executionSaves.length === 1);
      expect(bridge.executionSaves).toEqual([{ version: 1, route: "own_mac", preferredMacRunnerId: "runner_mac_1" }]);
      await until(() => pressedLabel() === "この Mac");
      expect(notice()).toBeNull();
    });

    it("受け入れは ON でも ID がまだ無い（登録中）なら、待つよう案内する。オンにしてくださいとは言わない", async () => {
      const bridge = await openSettingsOnCloud({ enabled: true, state: "starting", label: null, runnerId: null });
      await click(button(executionRow(), "この Mac"));
      await until(() => notice() !== null);
      expect(notice()!.textContent).toBe("この Mac を登録しています。少し待ってから、もう一度「この Mac」を選んでください。");
      expect(bridge.executionSaves).toEqual([]);
      expect(pressedLabel()).toBe("クラウド");
      // 登録が済むと案内は消え、そのまま選べる
      bridge.emitPcRunner({ enabled: true, state: "idle", label: null, runnerId: "runner_mac_1" });
      await until(() => notice() === null);
      await click(button(executionRow(), "この Mac"));
      await until(() => bridge.executionSaves.length === 1);
    });

    it.each([
      ["needs_login", "NIHO アカウントでのログインが必要です。ログインしてから、もう一度「この Mac」を選んでください。"],
      ["offline", "NIHO に接続できません。接続を確かめてから、もう一度「この Mac」を選んでください。"],
    ] as const)("ID が無く、状態が %s なら、その状態に合った案内にする", async (state, expected) => {
      const bridge = await openSettingsOnCloud({ enabled: true, state, label: null, runnerId: null });
      await click(button(executionRow(), "この Mac"));
      await until(() => notice() !== null);
      expect(notice()!.textContent).toBe(expected);
      expect(bridge.executionSaves).toEqual([]);
      expect(pressedLabel()).toBe("クラウド");
    });

    it("この Mac の状態を読めないときは、そのことを案内する（保存は試していない）", async () => {
      const bridge = await openSettingsOnCloud({ enabled: true, state: "idle", label: null, runnerId: "runner_mac_1" });
      bridge.pcRunnerStatus = async () => {
        throw new Error("status unavailable");
      };
      await click(button(executionRow(), "この Mac"));
      await until(() => notice() !== null);
      expect(notice()!.textContent).toBe("この Mac の状態を確認できませんでした。もう一度お試しください。");
      expect(bridge.executionSaves).toEqual([]);
      expect(pressedLabel()).toBe("クラウド");
    });

    it("実際の保存の失敗は、案内とは別に「保存できませんでした」と出す", async () => {
      const bridge = await openSettingsOnCloud({ enabled: true, state: "idle", label: null, runnerId: "runner_mac_1" });
      bridge.saveExecution = async () => {
        throw new Error("disk full");
      };
      await click(button(executionRow(), "この Mac"));
      await until(() => executionRow().parentElement?.textContent?.includes("アカウントの実行先を保存できませんでした。もう一度お試しください。") ?? false);
      expect(notice()).toBeNull();
      expect(bridge.executionSaves).toEqual([]);
    });
  });

  it("アカウント設定の競合もレールから確認できる", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = activeCloud();
    const entry = conflictEntryOf({ conflictId: "profile-conflict", path: "execution.json" });
    bridge.conflictEntries.set("profile", [entry]);
    bridge.conflictCopies.set("profile-conflict", { local: '{"route":"cloud"}', remote: '{"route":"own_mac"}' });
    bridge.cloudSnapshots.set("profile", syncSnapshot("profile", {
      conflicts: [{ conflictId: entry.conflictId, path: entry.path, kind: "edit", status: "open", remoteDeviceId: null, remoteDeviceKind: null }],
    }));
    screen = await renderApp(bridge, account(signedIn()).transport);
    const notice = screen.container.querySelector<HTMLElement>(".rail .cloud-notice")!;
    expect(notice.textContent).toContain("アカウント設定の確認が必要です");
    await click(button(notice, "変更を確認"));
    await until(() => screen!.container.querySelector('[role="dialog"] h2')?.textContent === "変更の確認");
    expect(screen.container.querySelector('[role="dialog"]')?.textContent).toContain("残りの工程");
  });

  it.each(["接続", "容量"])("レールの%sの知らせから設定の復帰先へ進める", async (kind) => {
    const { bridge, projectId } = await docBridge("本文");
    bridge.cloud = activeCloud(kind === "接続" ? { message: "通信を確かめてください。" } : {});
    if (kind === "容量") bridge.cloudSnapshots.set(projectId, syncSnapshot(projectId, { quotaPaths: ["project.json"] }));
    screen = await renderApp(bridge, account(signedIn()).transport);
    const { container } = screen;
    const label = kind === "接続" ? "設定を開く" : "使用量を見る";
    const notice = container.querySelector<HTMLElement>(".rail .cloud-notice")!;
    await click(button(notice, label));
    expect(rowOf(container, kind === "接続" ? "同期" : "使用量")).toBeDefined();
  });

  it("別のアカウントの保存先の知らせからログアウトしてログインし直せる", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = activeCloud({ status: "otherAccount" });
    const login = account(signedIn());
    screen = await renderApp(bridge, login.transport);
    await click(button(screen.container.querySelector<HTMLElement>(".rail .cloud-notice")!, "ログインし直す"));
    expect(login.calls).toContain(ACCOUNT_COMMANDS.logout);
    expect(bridge.cloudCallsOf("cloudSetProvider")).toEqual([]);
  });

  it("既存 CLOUD は切り替えを出さず、開発版は『この Mac だけ』と出す", async () => {
    const dev = new FakeBridge();
    screen = await renderApp(dev, account(signedIn()).transport);
    await click(button(screen.container, "設定"));
    let row = rowOf(screen.container, "保存先")!;
    expect(row.closest(".card")?.querySelector("h2")?.textContent).toBe("保存先");
    expect(row.querySelector(".st")?.textContent).toBe("この Mac だけ（開発版）");
    expect(row.textContent).toContain("NIHO_DOCS_CLOUD=1");
    expect(row.querySelectorAll("button")).toHaveLength(0);
    expect(rowOf(screen.container, "同期")).toBeUndefined();
    screen.unmount();

    const bridge = new FakeBridge();
    bridge.cloud = activeCloud();
    screen = await renderApp(bridge, account(signedIn()).transport);
    await click(button(screen.container, "設定"));
    row = rowOf(screen.container, "保存先")!;
    expect(row.querySelector(".st")?.textContent).toBe("NIHO クラウド");
    expect(row.textContent).toContain("別の Mac やスマホからも開けます");
    expect(row.textContent).toContain("クラウドでは 30 日で消え、この Mac には残ります");
    expect(row.querySelectorAll("button")).toHaveLength(0);
    expect(screen.container.textContent).not.toContain("この Mac だけ");
    expect(bridge.cloudCallsOf("cloudSetProvider")).toEqual([]);
  });

  it("再起動後は保存先の移行を完了するまで文書を開かない", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = cloudStateOf({ requiresAccount: true, reopeningPending: true,
      storage: { mode: "LOCAL", epoch: "1", changedAt: null, cleanupPending: false,
        quotaBytes: 5 * 1024 ** 3, closing: null } });
    screen = await renderApp(bridge, account(signedIn()).transport);
    const { container } = screen;
    expect(container.querySelector("h1")?.textContent).toBe("保存先の変更を再開します");
    expect(container.querySelector(".rail")).toBeNull();
    await click(button(container, "移行を完了する"));
    await until(() => container.querySelector(".rail") !== null);
    expect(bridge.cloudCallsOf("cloudStorageReopen")).toHaveLength(1);
  });

  it("移行中にログアウトしていても未完了の文書を開かず、再ログインを求める", async () => {
    const bridge = new FakeBridge();
    bridge.accountOpen = false;
    bridge.cloud = cloudStateOf({ requiresAccount: true, reopeningPending: true,
      storage: { mode: "LOCAL", epoch: "1", changedAt: null, cleanupPending: false,
        quotaBytes: 5 * 1024 ** 3, closing: null } });
    screen = await renderApp(bridge, account({ kind: "signedOut" }).transport);
    const { container } = screen;
    await until(() => container.querySelector(".login-required") !== null);
    expect(container.textContent).toContain("保存先の変更が途中です。");
    expect(container.textContent).toContain("移行が完了するまで、この Mac の文書は開けません。");
    expect(container.querySelector(".rail")).toBeNull();
  });

  it("LOCAL からクラウドへは量・枠・音声の期限を確かめてから始める", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = cloudStateOf({ accountName: "文書 太郎", requiresAccount: true,
      storage: { mode: "LOCAL", epoch: "1", changedAt: null, cleanupPending: false,
        quotaBytes: 5 * 1024 ** 3, closing: null } });
    screen = await renderApp(bridge, account(signedIn()).transport);
    const { container } = screen;
    await click(button(container, "設定"));
    const row = rowOf(container, "保存先")!;
    expect(row.querySelector(".st")?.textContent).toBe("この Mac だけ");
    await click(button(row, "変更"));
    await until(() => container.querySelector('[role="dialog"]') !== null);
    const confirm = dialog(container);
    expect(confirm.textContent).toContain("無料枠は 5 GB");
    expect(confirm.textContent).toContain("音声 0 件は、クラウドでは 30 日で消え");
    expect(bridge.cloudCallsOf("cloudStorageReopen")).toEqual([]);
    await click(button(confirm, "クラウドに移す"));
    await until(() => rowOf(container, "保存先")?.querySelector(".st")?.textContent === "NIHO クラウド");
    expect(bridge.cloudCallsOf("cloudStorageReopeningPreview")).toHaveLength(1);
    expect(bridge.cloudCallsOf("cloudStorageReopen")).toHaveLength(1);
  });

  it("移行は確かめずに始まり（Mac 側）、進み・中断・再開・上げられなかったページとフォルダを出す", async () => {
    const bridge = new FakeBridge();
    await bridge.createProject(pagedProject("朝市"), null, null, []);
    bridge.cloud = activeCloud({ migration: { running: true, cancelled: false, total: 1, done: 0, bytesTotal: 0, bytesDone: 0, failed: [] } });
    bridge.cloudUsageValue = { usedBytes: 1.2 * 1024 ** 3, reservedBytes: 0, quotaBytes: 5 * 1024 ** 3, audioBytes: 0, projects: [] };
    screen = await renderApp(bridge, account(signedIn()).transport);
    const { container } = screen;
    // レールにも小さく出す
    expect(container.querySelector(".rail .cloud-notice")?.textContent).toContain("クラウドに上げています 0/1");
    await click(button(container, "設定"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(rowOf(container, "同期")!.textContent).toContain("同期しています");
    expect(rowOf(container, "同期")!.querySelector(".st i")?.className).toBe("");
    expect((rowOf(container, "この Mac の名前")!.querySelector("input") as HTMLInputElement).value).toBe("テストの Mac");
    await until(() => rowOf(container, "使用量")?.textContent?.includes("1.2 GB / 5 GB") ?? false);
    expect(rowOf(container, "移行")!.textContent).toContain("この Mac のページとフォルダをクラウドに上げています（0 / 1）");

    await click(button(rowOf(container, "移行")!, "中断する"));
    expect(bridge.cloudCallsOf("cloudMigrationCancel")).toHaveLength(1);
    expect(rowOf(container, "移行")!.textContent).toContain("クラウドへの保存を中断しました（0 / 1）");
    await click(button(rowOf(container, "移行")!, "再開する"));
    expect(bridge.cloudCallsOf("cloudMigrationStart")).toHaveLength(1);

    // 移行の進みは event で届く（名前と理由。内部の id は出さない）
    await act(async () =>
      bridge.emitCloudState(
        activeCloud({
          contextGeneration: bridge.cloud.contextGeneration,
          migration: {
            running: false,
            cancelled: false,
            total: 3,
            done: 2,
            bytesTotal: 3 * 1024 ** 3,
            bytesDone: 1.2 * 1024 ** 3,
            failed: [{ projectId: "p-internal-9", name: "港の座談会", reason: "クラウドの容量が足りません" }],
          },
        }),
      ),
    );
    const migration = rowOf(container, "移行")!;
    expect(migration.textContent).toContain("クラウドに上げられなかったページかフォルダがあります（2 / 3）");
    expect(migration.textContent).toContain("1.2 GB / 3 GB");
    expect(migration.textContent).toContain("港の座談会 · クラウドの容量が足りません");
    expect(migration.textContent).not.toContain("p-internal-9");
    expect(bridge.cloudCallsOf("cloudSetProvider")).toEqual([]);
  });

  it("容量の上限・削除したフォルダ（元に戻す）・この Mac の名前（離れたときに保存）", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = activeCloud();
    bridge.cloudUsageValue = { usedBytes: 5 * 1024 ** 3, reservedBytes: 0, quotaBytes: 5 * 1024 ** 3, audioBytes: 0, projects: [] };
    bridge.deletedProjects = [{ projectId: "gone-1", name: "去年の朝市", deletedAt: "2026-10-10T03:04:00.000Z" }];
    screen = await renderApp(bridge, account(signedIn()).transport);
    const { container } = screen;
    await click(button(container, "設定"));
    await until(() => rowOf(container, "使用量")?.textContent?.includes("5 GB / 5 GB") ?? false);
    expect(rowOf(container, "使用量")!.textContent).toContain(
      "容量の上限に達したため、一部のファイルをクラウドに上げられません。手元には保存されています。",
    );
    const deleted = rowOf(container, "削除したフォルダ")!;
    expect(deleted.textContent).toContain("去年の朝市");
    expect(deleted.textContent).toMatch(/\d+\/\d+ \d\d:\d\d に削除/);
    await click(button(deleted, "元に戻す"));
    expect(bridge.cloudCallsOf("cloudRestoreProject")).toEqual([["gone-1"]]);
    expect(container.querySelector(".toast")?.textContent).toBe("元に戻しました");
    expect(rowOf(container, "削除したフォルダ")!.textContent).toContain("ありません");

    const input = rowOf(container, "この Mac の名前")!.querySelector("input") as HTMLInputElement;
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "事務所の Mac");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.blur();
    });
    expect(bridge.cloudCallsOf("cloudSetDeviceName")).toEqual([["事務所の Mac"]]);
  });

  it("Root 切替後に古い設定 command の state が後着しても新しい context を戻さない", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = activeCloud({ contextGeneration: 10, deviceName: "Root A の Mac" });
    let release: () => void = () => {};
    bridge.cloudSetDeviceNameGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    screen = await renderApp(bridge, account(signedIn()).transport);
    const { container } = screen;
    await click(button(container, "設定"));
    const input = rowOf(container, "この Mac の名前")!.querySelector("input") as HTMLInputElement;
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "遅い Root A");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.blur();
    });
    await until(() => bridge.cloudCallsOf("cloudSetDeviceName").length === 1);
    await act(async () => bridge.emitCloudState(activeCloud({ contextGeneration: 12, deviceName: "Root B の Mac" })));
    expect(input.value).toBe("Root B の Mac");
    await act(async () => {
      release();
      await Promise.resolve();
    });
    expect(input.value).toBe("Root B の Mac");
  });

  it("実行中は別アカウントの保存先を結び直せない", async () => {
    const { bridge } = await textProjectBridge();
    bridge.cloud = activeCloud();
    bridge.execution = { version: 1, route: "own_mac", preferredMacRunnerId: "runner_mac_1" };
    bridge.pcRunner = { enabled: true, state: "idle", label: null, runnerId: "runner_mac_1" };
    let release!: () => void;
    let started!: () => void;
    const waitStarted = new Promise<void>((resolve) => (started = resolve));
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.onTurnStarted = () => started();
    bridge.turnScript = () => [done("成果")];
    screen = await renderApp(bridge, account(signedIn()).transport);
    const { container } = screen;
    await click(button(container, "続きを作成"));
    await waitStarted;
    await act(async () =>
      bridge.emitCloudState(
        activeCloud({
          contextGeneration: bridge.cloud.contextGeneration,
          status: "otherAccount",
          canRebind: true,
        }),
      ),
    );
    await click(button(container, "設定"));
    const row = rowOf(container, "同期")!;
    expect(button(row, "このアカウントで使う").disabled).toBe(true);
    expect(bridge.cloudCallsOf("cloudSetProvider")).toEqual([]);
    release();
    await wait(0);
  });
  it("別のアカウントの保存先は知らせ、前の本人の未送信が無ければ確かめてから「このアカウントで使う」", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = activeCloud({ status: "otherAccount", canRebind: true });
    screen = await renderApp(bridge, account(signedIn()).transport);
    const { container } = screen;
    expect(container.querySelector(".rail .cloud-notice")?.textContent).toContain("別のアカウントの保存先です");
    await click(button(container, "設定"));
    const sync = rowOf(container, "同期")!;
    expect(sync.textContent).toContain("別のアカウントの保存先です");
    expect(sync.querySelector(".st i")?.className).toBe("off");
    await click(button(sync, "このアカウントで使う"));
    expect(dialog(container).querySelector("h2")?.textContent).toBe("この保存先をこのアカウントで使う");
    await click(button(dialog(container), "このアカウントで使う"));
    expect(bridge.cloudCallsOf("cloudSetProvider")).toEqual([["niho", true]]);
    expect(bridge.cloudCallsOf("cloudMigrationStart")).toHaveLength(1);
  });

  it("サーバーが NIHO アカウントの接続を閉じている間は、未ログインでもログイン画面で塞がず手元で続け、同期していないことを伝える", async () => {
    const bridge = new FakeBridge();
    bridge.accountOpen = false;
    await bridge.createProject(pagedProject("朝市"), null, null, []);
    bridge.cloud = activeCloud({ status: "signedOut" });
    screen = await renderApp(bridge, account({ kind: "signedOut" }).transport);
    const { container } = screen;
    await until(() => container.querySelector(".rail") !== null);
    expect(container.querySelector(".login-required")).toBeNull();
    expect(container.textContent).toContain("朝市");
    const notice = container.querySelector<HTMLElement>(".rail .cloud-notice")!;
    expect(notice.textContent).toContain("いまは NIHO にログインできないため、同期していません");
    expect([...notice.querySelectorAll("button")].some((item) => item.textContent === "ログイン")).toBe(false);
  });

  it("未ログインならログイン画面だけを出し、案件を開かない（開発版の この Mac だけ では出さない）", async () => {
    const bridge = new FakeBridge();
    await bridge.createProject(pagedProject("朝市"), null, null, []);
    bridge.cloud = activeCloud({ status: "signedOut" });
    const login = account({ kind: "signedOut" });
    screen = await renderApp(bridge, login.transport);
    const { container } = screen;
    expect(container.querySelector(".login-required h1")?.textContent).toBe("NIHO アカウントでログイン");
    expect(container.textContent).toContain("保存先をまだ選んでいない場合は、ログイン後に「NIHO クラウド」か「この Mac だけ」を選べます。");
    expect(container.querySelector(".rail")).toBeNull();
    expect(container.textContent).not.toContain("朝市");
    await click(button(container, "NIHO でログイン"));
    expect(login.calls).toContain(ACCOUNT_COMMANDS.beginLogin);
    screen.unmount();

    const dev = new FakeBridge();
    screen = await renderApp(dev, account({ kind: "signedOut" }).transport);
    expect(screen.container.querySelector(".login-required")).toBeNull();
    expect(screen.container.querySelector(".rail")).not.toBeNull();
  });

  it("ログイン画面にいる間に接続が閉じたら（障害対応など）、確かめ直して手元で続ける", async () => {
    const bridge = new FakeBridge();
    await bridge.createProject(pagedProject("朝市"), null, null, []);
    bridge.cloud = activeCloud({ status: "signedOut" });
    screen = await renderApp(bridge, account({ kind: "signedOut" }).transport);
    const { container } = screen;
    await until(() => container.querySelector(".login-required") !== null);
    bridge.accountOpen = false;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await until(() => container.querySelector(".rail") !== null);
    expect(container.querySelector(".login-required")).toBeNull();
    expect(container.textContent).toContain("朝市");
  });

  it("手元で続けている途中で接続が開いても、ログイン画面に切り替えず、レールに「ログイン」を出す", async () => {
    const bridge = new FakeBridge();
    bridge.accountOpen = false;
    await bridge.createProject(pagedProject("朝市"), null, null, []);
    bridge.cloud = activeCloud({ status: "signedOut" });
    screen = await renderApp(bridge, account({ kind: "signedOut" }).transport);
    const { container } = screen;
    await until(() => container.querySelector(".rail") !== null);
    bridge.accountOpen = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    const notice = () => container.querySelector<HTMLElement>(".rail .cloud-notice")!;
    await until(() => [...notice().querySelectorAll("button")].some((item) => item.textContent === "ログイン"));
    expect(container.querySelector(".login-required")).toBeNull();
    expect(container.textContent).toContain("朝市");
  });

  it("接続を受け付けるかを確かめ終わるまでは、未ログインでもログイン画面もページも出さずに待ち、確かめられなければログイン画面にする", async () => {
    const bridge = new FakeBridge();
    await bridge.createProject(pagedProject("朝市"), null, null, []);
    bridge.cloud = activeCloud({ status: "signedOut" });
    let fail: (error: unknown) => void = () => undefined;
    bridge.accountAvailable = () => new Promise<boolean>((_, reject) => { fail = reject; });
    screen = await renderApp(bridge, account({ kind: "signedOut" }).transport);
    const { container } = screen;
    expect(container.querySelector(".login-required")).toBeNull();
    expect(container.querySelector(".rail")).toBeNull();
    expect(container.textContent).not.toContain("朝市");
    expect(container.querySelector('.app[aria-busy="true"]')).not.toBeNull();
    // 確かめられない（オフライン）ときは、開いているとして扱う（＝ログイン画面）
    await act(async () => fail(new Error("offline")));
    await until(() => container.querySelector(".login-required") !== null);
    expect(container.textContent).not.toContain("朝市");
  });

  it("ログインの期限が切れたときは手元で続け、レールに「ログインが必要です」と「ログイン」を出す", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = activeCloud({ status: "expired" });
    const login = account({ kind: "expired", profile, reason: "sessionRevoked" });
    screen = await renderApp(bridge, login.transport);
    const { container } = screen;
    expect(container.querySelector(".login-required")).toBeNull();
    const notice = container.querySelector<HTMLElement>(".rail .cloud-notice")!;
    expect(notice.textContent).toContain("ログインが必要です");
    await click(button(notice, "ログイン"));
    expect(login.calls).toContain(ACCOUNT_COMMANDS.beginLogin);
  });

  it("サーバーが NIHO アカウントの接続を閉じている間は、期限切れでもレールに「ログイン」を出さず、同期していないことだけ伝える", async () => {
    const bridge = new FakeBridge();
    bridge.accountOpen = false;
    bridge.cloud = activeCloud({ status: "expired" });
    screen = await renderApp(bridge, account({ kind: "expired", profile, reason: "sessionRevoked" }).transport);
    const notice = screen.container.querySelector<HTMLElement>(".rail .cloud-notice")!;
    expect(notice.textContent).toContain("いまは NIHO にログインできないため、同期していません");
    expect([...notice.querySelectorAll("button")].some((item) => item.textContent === "ログイン")).toBe(false);
  });

  it("ウィンドウに戻るたびにサーバーが接続を受け付けるかを確かめ直し、レールの「ログイン」を合わせる", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = activeCloud({ status: "expired" });
    screen = await renderApp(bridge, account({ kind: "expired", profile, reason: "sessionRevoked" }).transport);
    const { container } = screen;
    const notice = () => container.querySelector<HTMLElement>(".rail .cloud-notice")!;
    await until(() => [...notice().querySelectorAll("button")].some((item) => item.textContent === "ログイン"));
    bridge.accountOpen = false;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await until(() => notice().textContent?.includes("いまは NIHO にログインできないため、同期していません") ?? false);
    expect([...notice().querySelectorAll("button")].some((item) => item.textContent === "ログイン")).toBe(false);
  });
});

describe("レールのクラウドの案件", () => {
  it("クラウドにだけある案件は後ろに淡く「クラウド」と並び、押すと下ろして開く。別の Mac の実行中は行の下に出す", async () => {
    const bridge = new FakeBridge();
    const local = await bridge.createProject(pagedProject("朝市"), null, null, []);
    await bridge.createPage(local.id, { kind: "doc", title: "事前メモ", createdAt: "2026-10-16T00:00:00.000Z" });
    bridge.cloud = activeCloud();
    bridge.remoteProjects = [
      remote({ projectId: local.id, name: "朝市", local: true, lease: { deviceName: "Mac Studio", expiresAt: LEASE_ALIVE(), mine: false } }),
      remote({ projectId: "remote-1", name: "港の座談会" }),
    ];
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => container.querySelector(".rail .case.remote") !== null);
    const row = container.querySelector<HTMLElement>(".rail .case.remote")!;
    expect(row.querySelector(".t")?.textContent).toBe("港の座談会");
    expect(row.querySelector(".st")?.textContent).toBe("クラウド");
    expect(row.querySelector(".ti")?.className).toContain("dim");
    // この Mac の案件の後ろ
    expect([...container.querySelectorAll(".rail .ti.case .t")].map((item) => item.textContent)).toEqual(["朝市", "港の座談会"]);
    expect(container.querySelector(".rail .rlease")?.textContent).toBe("Mac Studio で実行中");

    let release!: () => void;
    bridge.openGate = new Promise<void>((resolve) => (release = resolve));
    await click(row.querySelector("button")!);
    expect(row.querySelector(".st")?.textContent).toBe("開いています");
    release();
    // 下ろしたフォルダは背景情報のページで開く（P6 #18607・#18914）
    await until(() => railCurrent(container) === "背景情報");
    expect(bridge.cloudCallsOf("cloudOpenProject")).toEqual([["remote-1"]]);
    expect(container.querySelector(".rail .case.remote")).toBeNull();
    expect([...container.querySelectorAll(".rail .ti.case .t")].map((item) => item.textContent)).toContain("港の座談会");
  });

  it("別の Mac の lease は期限が来たら画面から取り下げる（一覧の再取得を待たない）", async () => {
    const bridge = new FakeBridge();
    const local = await bridge.createProject(pagedProject("朝市"), null, null, []);
    await bridge.createPage(local.id, { kind: "doc", title: "事前メモ", createdAt: "2026-10-16T00:00:00.000Z" });
    bridge.cloud = activeCloud();
    bridge.remoteProjects = [
      remote({ projectId: local.id, name: "朝市", local: true, lease: { deviceName: "Mac Studio", expiresAt: LEASE_ALIVE(1500), mine: false } }),
    ];
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => container.querySelector(".rail .rlease")?.textContent === "Mac Studio で実行中");
    await until(() => container.querySelector(".rail .rlease") === null);
  });

  it("予約の docs-root はフォルダ外の実行の lease を知るために一覧へ載るだけで、クラウドの案件の行としては出さない", async () => {
    const bridge = new FakeBridge();
    const local = await bridge.createProject(pagedProject("朝市"), null, null, []);
    await bridge.createPage(local.id, { kind: "doc", title: "事前メモ", createdAt: "2026-10-16T00:00:00.000Z" });
    bridge.cloud = activeCloud();
    bridge.remoteProjects = [
      remote({ projectId: DOCS_ROOT_PROJECT_ID, name: "", lease: { deviceName: "Mac Studio", expiresAt: LEASE_ALIVE(), mine: false } }),
      remote({ projectId: local.id, name: "朝市", local: true }),
      remote({ projectId: "remote-1", name: "港の座談会" }),
    ];
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => container.querySelector(".rail .case.remote") !== null);
    expect([...container.querySelectorAll(".rail .case.remote .t")].map((item) => item.textContent)).toEqual(["港の座談会"]);
    // フォルダ外の lease は案件の行の下（フォルダの lease の表示）には出ない
    expect(container.querySelector(".rail .rlease")).toBeNull();
  });

  it("下ろせなかったら知らせる", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = activeCloud();
    bridge.remoteProjects = [remote({ projectId: "remote-1", name: "港の座談会" })];
    bridge.cloudOpenProject = async () => {
      throw { code: "cloud_open_failed", message: "クラウドから開けませんでした。" };
    };
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => container.querySelector(".rail .case.remote") !== null);
    await click(container.querySelector<HTMLElement>(".rail .case.remote button")!);
    expect(container.querySelector(".failure-band .fb-msg")?.textContent).toBe("クラウドから開けませんでした。");
  });
});

describe("文書のページ（NIHO クラウド）", () => {
  it("保存の状態は「このMacに保存済み・同期待ち」→「クラウドに保存済み」。開いている間は本文を守る", async () => {
    const { bridge, projectId, path } = await docBridge("本文");
    bridge.cloud = activeCloud();
    bridge.cloudSnapshots.set(projectId, syncSnapshot(projectId));
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => saveText(container) === "クラウドに保存済み");
    await until(() => bridge.protectedPaths(projectId).includes(path));
    await act(async () => {
      bodyEditor(container).commands.insertContent("追記");
    });
    await until(() => saveText(container) === "このMacに保存済み・同期待ち");
    await act(async () => bridge.ackCloud(projectId));
    expect(saveText(container)).toBe("クラウドに保存済み");
    // 接続できない間は「オフライン」（この Mac には保存済み）
    await act(async () => bridge.emitCloudState(activeCloud({ message: "NIHO に接続できません" })));
    expect(saveText(container)).toBe("このMacに保存済み・オフライン");
    expect(container.querySelector(".rail .cloud-notice")?.textContent).toContain("NIHO に接続できません");
  });

  it("別の Mac の更新は守っている間は延ばし、「最新を表示」で守りを外して同期し、届いたら本文を読み直す", async () => {
    const { bridge, projectId, pageId, path } = await docBridge("前の本文");
    bridge.cloud = activeCloud();
    bridge.cloudSnapshots.set(projectId, syncSnapshot(projectId));
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => bridge.protectedPaths(projectId).includes(path));
    await act(async () =>
      bridge.emitCloudProject(
        projectId,
        syncSnapshot(projectId, { deferred: [path], remoteWriters: { [path]: { deviceId: "d_other_mac", deviceKind: "mac" } } }),
      ),
    );
    const banner = container.querySelector<HTMLElement>(".cloud-banner")!;
    expect(banner.textContent).toContain("別の Mac で更新されています。");
    // 別の Mac の本文（守りを外すと反映される）
    bridge.projects.get(projectId)!.docs[pageId] = "別の Mac で直した本文";
    await click(button(banner, "最新を表示"));
    expect(bridge.cloudCallsOf("cloudSyncNow")).toEqual([[projectId]]);
    await until(() => bridge.protectedPaths(projectId).length === 0);
    expect(bridge.cloudCallsOf("cloudRelease").length).toBeGreaterThan(0);
    // 待ちが外れても、読み直すまでは同じ端末の名前のまま
    await act(async () => bridge.emitCloudProject(projectId, syncSnapshot(projectId)));
    expect(container.querySelector(".cloud-banner")?.textContent).toContain("別の Mac で更新されています。");
    await act(async () => {
      bridge.emitCloudApplied(projectId, [path]);
    });
    await until(() => bodyEditor(container).getText().includes("別の Mac で直した本文"));
    // また守る（ほかの更新は延ばす）
    await until(() => bridge.protectedPaths(projectId).includes(path));
    expect(container.querySelector(".cloud-banner")).toBeNull();
  });

  it("更新した端末の種類で知らせる（スマホ・PC のブラウザ・種類の無いブラウザ・分からない端末）", async () => {
    const { bridge, projectId, path } = await docBridge("前の本文");
    bridge.cloud = activeCloud();
    bridge.cloudSnapshots.set(projectId, syncSnapshot(projectId));
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => bridge.protectedPaths(projectId).includes(path));
    const cases: Array<[Parameters<typeof syncSnapshot>[1], string]> = [
      [{ deferred: [path], remoteWriters: { [path]: { deviceId: "pwa_phone", deviceKind: "phone" } } }, "スマホで更新されています。"],
      [{ deferred: [path], remoteWriters: { [path]: { deviceId: "pwa_desktop", deviceKind: "browser" } } }, "PC のブラウザで更新されています。"],
      // 種類を送らない旧 Web の版は端末 ID で見分ける
      [{ deferred: [path], remoteWriters: { [path]: { deviceId: "pwa_legacy", deviceKind: null } } }, "ブラウザで更新されています。"],
      // 書き手の分からない待ち（クラウドで削除された版など）
      [{ deferred: [path] }, "別の端末で更新されています。"],
    ];
    for (const [fields, text] of cases) {
      await act(async () => bridge.emitCloudProject(projectId, syncSnapshot(projectId, fields)));
      expect(container.querySelector(".cloud-banner")?.textContent).toContain(text);
      expect(button(container.querySelector<HTMLElement>(".cloud-banner")!, "最新を表示")).toBeTruthy();
    }
  });

  it("atomic open の直前に別の Mac の変更が反映されても、その最新 snapshot を表示する", async () => {
    const { bridge, projectId, pageId } = await docBridge("前の本文");
    bridge.cloud = activeCloud();
    const originalOpen = bridge.openPageDocument.bind(bridge);
    bridge.openPageDocument = async (...args) => {
      bridge.projects.get(projectId)!.docs[pageId] = "届いた本文";
      return originalOpen(...args);
    };
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => bodyEditor(container).getText().includes("届いた本文"));
  });

  it("両方で変わったら「変更を確認」→ クラウドの内容を使うと保存して知らせ、本文を読み直す", async () => {
    const { bridge, projectId, pageId, path } = await docBridge("手元の本文");
    bridge.conflictEntries.set(projectId, [conflictEntryOf({ conflictId: "c1", path })]);
    bridge.conflictCopies.set("c1", { local: "重なったときの手元", remote: "クラウドの本文" });
    bridge.cloud = activeCloud();
    bridge.cloudSnapshots.set(
      projectId,
      syncSnapshot(projectId, {
        conflicts: [{ conflictId: "c1", path, kind: "edit", status: "open", remoteDeviceId: "d_other_mac", remoteDeviceKind: "mac" }],
      }),
    );
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => saveText(container) === "変更の確認が必要");
    expect(container.querySelector(".rail .cloud-notice")?.textContent).toContain("変更の確認が必要です");
    const banner = container.querySelector<HTMLElement>(".cloud-banner")!;
    expect(banner.textContent).toContain("別の Mac でも変更されています。");
    await click(button(banner, "変更を確認"));
    await until(() => (dialog(container).querySelectorAll(".cfside pre").length ?? 0) === 2);
    // 「この Mac」は今のファイル（重なった後の編集も含む）
    expect([...dialog(container).querySelectorAll(".cfside pre")].map((item) => item.textContent)).toEqual(["手元の本文", "クラウドの本文"]);
    expect(dialog(container).textContent).toContain("事前メモ");
    await click(button(dialog(container), "クラウドの内容を使う"));
    expect(bridge.cloudCallsOf("cloudResolveConflict")).toEqual([[projectId, "c1", "remote", null, "r".repeat(64)]]);
    expect(container.querySelector(".toast")?.textContent).toBe("変更を保存しました");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(bridge.projects.get(projectId)!.docs[pageId]).toBe("クラウドの本文");
    await until(() => bodyEditor(container).getText().includes("クラウドの本文"));
  });

  it("スマホでも変わっていたら、知らせと「変更を確認」でスマホを名指す", async () => {
    const { bridge, projectId, path } = await docBridge("手元の本文");
    const remoteFile = {
      path, sha256: "r".repeat(64), bytes: 12, kind: "text" as const, modifiedAt: "2026-10-16T01:00:00.000Z",
      writerDeviceId: "pwa_phone", writerDeviceKind: "phone" as const,
    };
    bridge.conflictEntries.set(projectId, [conflictEntryOf({ conflictId: "c1", path, remoteDeviceId: "pwa_phone", remoteFile })]);
    bridge.conflictCopies.set("c1", { local: "重なったときの手元", remote: "スマホの本文" });
    bridge.cloud = activeCloud();
    bridge.cloudSnapshots.set(
      projectId,
      syncSnapshot(projectId, {
        conflicts: [{ conflictId: "c1", path, kind: "edit", status: "open", remoteDeviceId: "pwa_phone", remoteDeviceKind: "phone" }],
      }),
    );
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => container.querySelector(".cloud-banner") !== null);
    const banner = container.querySelector<HTMLElement>(".cloud-banner")!;
    expect(banner.textContent).toContain("スマホでも変更されています。");
    await click(button(banner, "変更を確認"));
    await until(() => (dialog(container).querySelectorAll(".cfside pre").length ?? 0) === 2);
    expect(dialog(container).textContent).toContain("この Mac とスマホの両方で変更されました。使う内容を選んでください。");
    expect(dialog(container).querySelectorAll(".cfside h3")[1]?.textContent).toMatch(/^クラウド（スマホで変更）/);
    expect(button(dialog(container), "クラウドの内容を使う")).toBeTruthy();
  });
});

describe("変更の確認と書きかけ", () => {
  it("書きかけを保存できないときは「変更を確認」を開かず、書きかけを残す", async () => {
    const { bridge, projectId, path } = await docBridge("手元の本文");
    bridge.conflictEntries.set(projectId, [conflictEntryOf({ conflictId: "c1", path })]);
    bridge.conflictCopies.set("c1", { local: "重なったときの手元", remote: "クラウドの本文" });
    bridge.cloud = activeCloud();
    bridge.cloudSnapshots.set(
      projectId,
      syncSnapshot(projectId, {
        conflicts: [{ conflictId: "c1", path, kind: "edit", status: "open", remoteDeviceId: "d_other_mac", remoteDeviceKind: "mac" }],
      }),
    );
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => container.querySelector(".cloud-banner") !== null);
    bridge.writePage = async () => {
      throw { code: "store_io", message: "このMacに保存できませんでした。" };
    };
    await act(async () => {
      bodyEditor(container).commands.insertContent("失ってはいけない書きかけ");
    });
    await click(button(container.querySelector<HTMLElement>(".cloud-banner")!, "変更を確認"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(bridge.cloudCallsOf("cloudResolveConflict")).toEqual([]);
    expect(bodyEditor(container).getText()).toContain("失ってはいけない書きかけ");
  });
});

describe("成果物の子ページの自動保存と自動の版（#18912）", () => {
  it("直すと 250ms 後に今の文書へ書き（何度書いても版は作らない）、離れると版を 1 つ残す。保存のボタンは置かない", async () => {
    const { bridge, flow, stored } = await textProjectBridge();
    const [step, next] = flow.steps;
    await seedRun(bridge, stored.project.id, step!, "抽出 1\n");
    await seedRun(bridge, stored.project.id, next!, "インサイト 1\n");
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, step!.name));
    const actions = container.querySelector<HTMLElement>(".window-titlebar .acts")!;
    expect([...actions.querySelectorAll("button")].map((element) => element.textContent)).not.toContain("版を保存");
    expect(actions.querySelector('[aria-label="履歴"]')).not.toBeNull();
    expect(saveText(container)).toBe("このMacに保存済み");
    await act(async () => {
      bodyEditor(container).commands.insertContent("追記");
    });
    await wait(320);
    expect(bridge.artifactDraftWrites.at(-1)?.markdown).toContain("追記");
    expect(stored.artifacts[step!.id]).toContain("追記");
    await act(async () => {
      bodyEditor(container).commands.insertContent("、さらに追記");
    });
    await wait(320);
    expect(bridge.artifactDraftWrites.length).toBeGreaterThanOrEqual(2);
    expect(stored.artifacts[step!.id]).toContain("さらに追記");
    // 自動保存のたびには版を作らない
    expect(stored.versions[step!.id]).toHaveLength(1);
    expect(saveText(container)).toBe("このMacに保存済み");
    // 離れると版を 1 つ残す（kind save・auto）
    await click(railItem(container, next!.name));
    expect(stored.versions[step!.id]).toHaveLength(2);
    expect(stored.versions[step!.id]![1]).toContain("さらに追記");
    expect(stored.runs.at(-1)).toMatchObject({ kind: "save", stepId: step!.id, version: 2, auto: true });
    // 直さずに開いて離れても版は増えない
    await click(railItem(container, step!.name));
    await click(railItem(container, next!.name));
    expect(stored.versions[step!.id]).toHaveLength(2);
    // 履歴の行の説明は「編集」
    await click(railItem(container, step!.name));
    await click(container.querySelector('[aria-label="履歴"]')!);
    expect(container.querySelector(".hrow .d")?.textContent).toBe("編集");
  });

  it("編集中に現在本文が変わってもCAS基準を自動更新せず、新しい本文を守る", async () => {
    const { bridge, flow, stored } = await textProjectBridge();
    const step = flow.steps[0]!;
    await seedRun(bridge, stored.project.id, step, "開いた本文\n");
    bridge.cloud = activeCloud();
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, step.name));
    await act(async () => {
      bodyEditor(container).commands.insertContent("・編集中の下書き");
    });
    stored.artifacts[step.id] = "別の書込みで保存された本文\n";
    await act(async () => bridge.emitCloudApplied(stored.project.id, ["project.json"]));
    await wait(350);
    expect(stored.artifacts[step.id]).toBe("別の書込みで保存された本文\n");
    expect(bodyEditor(container).getText()).toContain("編集中の下書き");
    await act(async () => {
      bodyEditor(container).commands.insertContent("・さらに追記");
    });
    await wait(350);
    expect(stored.artifacts[step.id]).toBe("別の書込みで保存された本文\n");
    expect(bodyEditor(container).getText()).toContain("さらに追記");
    expect(saveText(container)).toBe("このMacに保存できません");
  });

  it("同じIDの別RootへAのdraftを出さず、Aへ戻ると新captureで保存できる", async () => {
    const { bridge, flow, stored } = await textProjectBridge();
    const step = flow.steps[0]!;
    await seedRun(bridge, stored.project.id, step, "Root A の成果物\n");
    await seedRun(bridge, stored.project.id, flow.steps[1]!, "Root A のインサイト\n");
    bridge.cloud = activeCloud({ contextGeneration: 51, documentScopeId: "root-a-owner" });
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, step.name));
    await until(() => bridge.protectedPaths(stored.project.id).length > 0);
    await act(async () => {
      bodyEditor(container).commands.insertContent("・未保存の追記");
    });
    const rootAArtifacts = structuredClone(stored.artifacts);
    const rootAVersions = structuredClone(stored.versions);
    const rootARuns = structuredClone(stored.runs);
    stored.artifacts[step.id] = "Root B の成果物\n";
    stored.versions[step.id] = ["Root B の成果物\n"];
    await act(async () => bridge.emitCloudState(activeCloud({ contextGeneration: 52, documentScopeId: "root-b-owner" })));
    await wait(320);
    await until(() => bodyEditor(container).getText().includes("Root B の成果物"));
    expect(stored.artifacts[step.id]).toBe("Root B の成果物\n");
    expect(bodyEditor(container).getText()).not.toContain("未保存の追記");

    stored.artifacts = rootAArtifacts;
    stored.versions = rootAVersions;
    stored.runs = rootARuns;
    await act(async () => bridge.emitCloudState(activeCloud({ contextGeneration: 53, documentScopeId: "root-a-owner" })));
    await until(() => bodyEditor(container).getText().includes("未保存の追記"));
    // A の書きかけは新しい capture で今の文書に書き、離れると A に版を残す
    await act(async () => {
      bodyEditor(container).commands.insertContent("・戻ってからの追記");
    });
    await wait(320);
    expect(stored.artifacts[step.id]).toContain("未保存の追記");
    await click(railItem(container, flow.steps[1]!.name));
    expect(stored.versions[step.id]).toHaveLength(2);
    expect(stored.versions[step.id]![1]).toContain("戻ってからの追記");
  });

  it("同じ RootBinding の session refresh 後も artifact のdirty captureを保存できる", async () => {
    const { bridge, flow, stored } = await textProjectBridge();
    const step = flow.steps[0]!;
    await seedRun(bridge, stored.project.id, step, "再認証前\n");
    bridge.cloud = activeCloud({ contextGeneration: 71, documentScopeId: "same-root-owner" });
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, step.name));
    await act(async () => {
      bodyEditor(container).commands.insertContent("・再認証中の下書き");
    });
    await act(async () => bridge.emitCloudState(activeCloud({ contextGeneration: 72, documentScopeId: "same-root-owner" })));
    await wait(320);
    expect(stored.artifacts[step.id]).toContain("再認証中の下書き");
    expect(saveText(container)).not.toBe("このMacに保存できません");
  });

  it("版になっていない今の文書（前に自動保存した書きかけ）は、この Mac で直していなければ離れても版にしない。直せば版にする", async () => {
    const { bridge, flow, stored } = await textProjectBridge();
    const [step, next] = flow.steps;
    await seedRun(bridge, stored.project.id, step!, "抽出 1\n");
    await seedRun(bridge, stored.project.id, next!, "インサイト 1\n");
    await bridge.writeArtifactDraft({ projectId: stored.project.id, recordingId: "root" }, step!.id, false, "抽出 1 を直した\n");
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, step!.name));
    await click(railItem(container, next!.name));
    expect(stored.versions[step!.id]).toEqual(["抽出 1\n"]);
    await click(railItem(container, step!.name));
    await act(async () => {
      bodyEditor(container).commands.insertContent("もう一度");
    });
    await click(railItem(container, next!.name));
    expect(stored.versions[step!.id]).toHaveLength(2);
    expect(stored.versions[step!.id]![1]).toContain("抽出 1 を直した");
    expect(stored.versions[step!.id]![1]).toContain("もう一度");
  });

  it("古い版を開くと versionPath で読み、読むだけ（打っても書きかけにせず、自動で保存しない）", async () => {
    const { bridge, flow, stored } = await textProjectBridge();
    const step = flow.steps[0]!;
    await seedRun(bridge, stored.project.id, step, "抽出 1\n");
    stored.runs[stored.runs.length - 1] = { ...stored.runs.at(-1)!, versionPath: `versions/${step.id}/v_first.md` };
    bridge.turnScript = () => [done("抽出 2")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, step.name));
    await rebuild(container);
    await click(container.querySelector('[aria-label="履歴"]')!);
    await click([...container.querySelectorAll(".hrow")][1]!);
    expect(bridge.versionReads.at(-1)).toEqual({ stepId: step.id, version: 1, versionPath: `versions/${step.id}/v_first.md` });
    expect(bodyEditor(container).isEditable).toBe(false);
    await act(async () => {
      bodyEditor(container).commands.insertContent("古い版に足す");
    });
    await wait(320);
    expect(bridge.artifactDraftWrites).toHaveLength(0);
    // 現在版に戻ると、今の文書の本文（古い版に足したものは残らない）
    await click(button(container.querySelector<HTMLElement>(".version-view")!, "現在版に戻る"));
    expect(bodyEditor(container).getText()).toContain("抽出 2");
    expect(bodyEditor(container).getText()).not.toContain("古い版に足す");
    expect(stored.versions[step.id]).toHaveLength(2);
  });

  it("同じ番号の版が 2 つあっても（2 台の Mac が同期前に作った）、開いた行だけを選択中にし、その行の版のファイルを読む", async () => {
    const { bridge, flow, stored } = await textProjectBridge();
    const step = flow.steps[0]!;
    await seedRun(bridge, stored.project.id, step, "抽出 1\n");
    const first = stored.runs.at(-1)!;
    stored.runs[stored.runs.length - 1] = { ...first, versionPath: `versions/${step.id}/v_first.md` };
    stored.runs.push({ ...first, id: "run-other-mac", versionPath: `versions/${step.id}/v_other.md` });
    bridge.turnScript = () => [done("抽出 2")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, step.name));
    await rebuild(container);
    await click(container.querySelector('[aria-label="履歴"]')!);
    // 新しい順: 版 2（現在版）・版 1（ほかの Mac）・版 1（この Mac）
    await click([...container.querySelectorAll(".hrow")][2]!);
    expect(bridge.versionReads.at(-1)).toEqual({ stepId: step.id, version: 1, versionPath: `versions/${step.id}/v_first.md` });
    await click(container.querySelector('[aria-label="履歴"]')!);
    expect([...container.querySelectorAll(".hrow")].map((row) => row.classList.contains("on"))).toEqual([false, false, true]);
  });

  it("窓を閉じる前と、別の子ページへ移る前に、成果物の書きかけを書き残す", async () => {
    const { bridge, flow, stored } = await textProjectBridge();
    const [first, second] = flow.steps;
    await seedRun(bridge, stored.project.id, first!, "抽出 1\n");
    await seedRun(bridge, stored.project.id, second!, "まとめ 1\n");
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, first!.name));
    await act(async () => {
      bodyEditor(container).commands.insertContent("移る直前");
    });
    expect(bridge.artifactDraftWrites).toHaveLength(0);
    await click(railItem(container, second!.name));
    expect(bridge.artifactDraftWrites.map((write) => write.stepId)).toEqual([first!.id]);
    expect(stored.artifacts[first!.id]).toContain("移る直前");
    // 書き残した後に、離れる文書を版にする（#18912 の leave）
    expect(stored.versions[first!.id]).toHaveLength(2);
    expect(stored.versions[first!.id]![1]).toContain("移る直前");

    await act(async () => {
      bodyEditor(container).commands.insertContent("閉じる直前");
    });
    let closes = false;
    await act(async () => {
      closes = await bridge.requestClose();
    });
    expect(closes).toBe(true);
    expect(stored.artifacts[second!.id]).toContain("閉じる直前");
    expect(stored.versions[second!.id]).toHaveLength(2);
    expect(stored.versions[second!.id]![1]).toContain("閉じる直前");
  });

  it("窓を閉じるとき版を作れなくても、閉じるのは止めない（本文は保存済み）", async () => {
    const { bridge, flow, stored } = await textProjectBridge();
    const step = flow.steps[0]!;
    await seedRun(bridge, stored.project.id, step, "抽出 1\n");
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, step.name));
    await act(async () => {
      bodyEditor(container).commands.insertContent("閉じる直前");
    });
    bridge.saveOpenedArtifact = async () => {
      throw { code: "store_write_failed", message: "版を書けませんでした。" };
    };
    let closes = false;
    await act(async () => {
      closes = await bridge.requestClose();
    });
    expect(closes).toBe(true);
    expect(stored.artifacts[step.id]).toContain("閉じる直前");
    expect(stored.versions[step.id]).toHaveLength(1);
  });
});

describe("実行と音声（NIHO クラウド）", () => {
  it("別の Mac が実行中なら、実行の帯に理由を出して実行を押せなくする（押してから失敗させない。#18789）", async () => {
    const { bridge, project } = await textProjectBridge();
    bridge.cloud = activeCloud();
    bridge.remoteProjects = [
      remote({ projectId: project.id, name: "朝市 インタビュー", local: true, lease: { deviceName: "Mac Studio", expiresAt: LEASE_ALIVE(), mine: false } }),
    ];
    bridge.leaseHeldBy = "Mac Studio";
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => container.querySelector(".runbar .note")?.textContent === "別の Mac（Mac Studio）で実行中です。終わると、この Mac でも実行できます。");
    expect(button(container, "続きを作成").disabled).toBe(true);
    await click(button(container, "続きを作成"));
    expect(container.querySelector(".failure-band")).toBeNull();
    expect(bridge.turnRequests).toHaveLength(0);
  });

  it("同期の表示が古く、実行を始めてから別の Mac の実行が分かったときは、実行を断って知らせる（lease_held）", async () => {
    const { bridge } = await textProjectBridge();
    bridge.cloud = activeCloud();
    bridge.leaseHeldBy = "Mac Studio";
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(button(container, "続きを作成").disabled).toBe(false);
    await click(button(container, "続きを作成"));
    await until(() => container.querySelector(".failure-band .fb-msg") !== null);
    expect(container.querySelector(".failure-band .fb-msg")?.textContent).toBe("別の Mac（Mac Studio）で実行中です。終わってから実行してください。");
    expect(bridge.turnRequests).toHaveLength(0);
  });

  it("成果物のページでも、別の Mac が実行中なら作り直すを押せなくして理由を帯に出す（#18789）", async () => {
    const { bridge, flow, project, stored } = await textProjectBridge();
    const step = flow.steps[0]!;
    await seedRun(bridge, stored.project.id, step, "抽出 1\n");
    bridge.cloud = activeCloud();
    bridge.remoteProjects = [
      remote({ projectId: project.id, name: "朝市 インタビュー", local: true, lease: { deviceName: "Mac Studio", expiresAt: LEASE_ALIVE(), mine: false } }),
    ];
    bridge.leaseHeldBy = "Mac Studio";
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, step.name));
    await until(() => container.querySelector(".runbar .note")?.textContent === "別の Mac（Mac Studio）で実行中です。終わると、この Mac でも実行できます。");
    expect((await rebuildItem(container)).disabled).toBe(true);
    await click(container.querySelector<HTMLButtonElement>('.window-titlebar .pagemenu button[aria-label="その他"]')!);
    // 入力欄の「＋ → 工程を実行」も、別の Mac が実行している間は選べない
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="工程を実行"]')!);
    expect([...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].every((item) => item.disabled)).toBe(true);
    expect(bridge.turnRequests).toHaveLength(0);
  });

  it("写しの無い音声は、取得中・待っている・クラウドで期限が切れた を行に添える", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(THREE_STEP_TEMPLATE, "flow-1");
    bridge.flow = flow;
    const project = await bridge.createProject({ ...textProject(flow), source: undefined }, null, null, ["/Users/test/朝市.m4a", "/Users/test/港.m4a"]);
    const stored = bridge.projects.get(project.id)!;
    const files = stored.project.source?.kind === "audio" ? stored.project.source.audio.map((audio) => audio.file) : [];
    expect(files).toHaveLength(2);
    bridge.missingAudio = new Set(files);
    bridge.cloud = activeCloud();
    bridge.cloudSnapshots.set(project.id, syncSnapshot(project.id, { expiredAudio: [`inputs/${files[0]}`], audio: { [`inputs/${files[1]}`]: "downloading" } }));
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => container.querySelectorAll(".afile .anote").length === 2);
    expect([...container.querySelectorAll(".afile .anote")].map((note) => note.textContent)).toEqual([
      "クラウドの音声は 30 日を過ぎたため削除されました。写しのある Mac から上げ直せます。",
      "クラウドから取得しています…",
    ]);
    await act(async () => bridge.emitCloudProject(project.id, syncSnapshot(project.id, { expiredAudio: [`inputs/${files[0]}`] })));
    expect([...container.querySelectorAll(".afile .anote")].map((note) => note.textContent)).toEqual([
      "クラウドの音声は 30 日を過ぎたため削除されました。写しのある Mac から上げ直せます。",
      "同期を待っています",
    ]);
  });
});

describe("同期の契機と、別の Mac の変更の反映", () => {
  it("同じ project/status でも Root 切替前の event と command reply を表示・通知・自動保存へ適用しない", async () => {
    const { bridge, projectId, path } = await docBridge("Root B の本文");
    const oldGeneration = 31;
    const nextGeneration = 32;
    const oldSnapshot = syncSnapshot(projectId, {
      localGeneration: 2,
      acknowledgedGeneration: 1,
      dirty: { [path]: 2 },
    });
    bridge.cloud = activeCloud({ contextGeneration: oldGeneration });
    bridge.cloudSnapshots.set(projectId, oldSnapshot);
    bridge.remoteProjects = [remote({ projectId: "old-root-project", name: "旧 Root の案件" })];
    let releaseStatus: () => void = () => {};
    let releaseRemote: () => void = () => {};
    bridge.cloudProjectStatusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    bridge.cloudRemoteProjectsGate = new Promise<void>((resolve) => {
      releaseRemote = resolve;
    });
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => bridge.cloudCallsOf("cloudProjectStatus").some(([id]) => id === projectId));
    await until(() => bridge.cloudCallsOf("cloudRemoteProjects").length > 0);

    bridge.cloudSnapshots.set(projectId, syncSnapshot(projectId));
    bridge.remoteProjects = [remote({ projectId: "new-root-project", name: "新 Root の案件" })];
    bridge.cloudProjectStatusGate = null;
    bridge.cloudRemoteProjectsGate = null;
    await act(async () => bridge.emitCloudState(activeCloud({ contextGeneration: nextGeneration })));
    await until(() => bridge.cloudCallsOf("cloudProjectStatus").filter(([id]) => id === projectId).length >= 2);
    await until(() => saveText(container) === "クラウドに保存済み");
    await until(() => container.textContent?.includes("新 Root の案件") ?? false);

    const stored = bridge.projects.get(projectId)!;
    stored.project = {
      ...stored.project,
      pages: [
        ...(stored.project.pages ?? []),
        { id: "doc-old-root", kind: "doc", title: "旧 Root の通知", createdAt: "2026-10-17T01:00:00.000Z" },
      ],
    };
    stored.docs["doc-old-root"] = "旧 Root の本文";
    await act(async () => {
      bridge.emitCloudProject(projectId, oldSnapshot, oldGeneration);
      bridge.emitCloudRemote([remote({ projectId: "old-root-project", name: "旧 Root の案件" })], oldGeneration);
      bridge.emitCloudApplied(projectId, ["project.json", "pages/doc-old-root.md"], oldGeneration);
      releaseStatus();
      releaseRemote();
      await Promise.resolve();
    });

    expect(saveText(container)).toBe("クラウドに保存済み");
    expect(container.textContent).toContain("新 Root の案件");
    expect(container.textContent).not.toContain("旧 Root の案件");
    expect(railPages(container)).not.toContain("旧 Root の通知");
    expect(container.querySelector(".toast")).toBeNull();
    expect(container.querySelector(".failure-band")).toBeNull();
    expect(bridge.pageWrites).toHaveLength(0);
  });

  it("フォルダ外の文書を開くと docs-root の状態・focus・編集保護を使う", async () => {
    const bridge = new FakeBridge();
    const page = await bridge.createPage(null, {
      kind: "doc",
      title: "フォルダ外のメモ",
      createdAt: "2026-10-17T00:00:00.000Z",
    });
    const path = `pages/${page.id}.md`;
    bridge.cloud = activeCloud();
    bridge.cloudSnapshots.set(DOCS_ROOT_PROJECT_ID, syncSnapshot(DOCS_ROOT_PROJECT_ID));
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => saveText(container) === "クラウドに保存済み");
    await until(() => bridge.protectedPaths(DOCS_ROOT_PROJECT_ID).includes(path));
    expect(bridge.cloudCallsOf("cloudProjectStatus")).toContainEqual([DOCS_ROOT_PROJECT_ID]);
    expect(bridge.cloudCallsOf("cloudFocus")).toContainEqual([DOCS_ROOT_PROJECT_ID]);
    await act(async () => bodyEditor(container).commands.insertContent("共有する追記"));
    await wait(300);
    await until(() => bridge.pageWrites.length === 1);
    expect(bridge.pageWrites[0]?.projectId).toBeNull();
    expect(bridge.cloudSnapshots.get(DOCS_ROOT_PROJECT_ID)?.dirty[path]).toBeGreaterThan(0);
  });

  it("保存先の状態を案件を開いたときと窓が前面に戻ったときに確かめる", async () => {
    const { bridge, projectId } = await docBridge("本文");
    screen = await renderApp(bridge);
    await act(async () => window.dispatchEvent(new Event("focus")));
    // LOCAL でも保存先やログイン状態が変わっていないか確かめる
    expect(bridge.cloudCallsOf("cloudFocus").length).toBeGreaterThan(0);
    screen.unmount();

    bridge.cloud = activeCloud();
    screen = await renderApp(bridge);
    await until(() => bridge.cloudCallsOf("cloudFocus").length > 0);
    const before = bridge.cloudCallsOf("cloudFocus").length;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(bridge.cloudCallsOf("cloudFocus")).toHaveLength(before + 1);
    expect(bridge.cloudCallsOf("cloudFocus").at(-1)).toEqual([projectId]);
  });

  it("別の Mac の変更が反映されたら、開いている案件とレールを読み直す（開いている本文は読み直さない）", async () => {
    const { bridge, projectId } = await docBridge("本文");
    bridge.cloud = activeCloud();
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => railPages(container).includes("事前メモ"));
    await act(async () => {
      bodyEditor(container).commands.insertContent("打ちかけ");
    });
    const stored = bridge.projects.get(projectId)!;
    stored.project = {
      ...stored.project,
      pages: [...(stored.project.pages ?? []), { id: "doc-remote", kind: "doc", title: "別の Mac のメモ", createdAt: "2026-10-16T02:00:00.000Z" }],
    };
    stored.docs["doc-remote"] = "届いた本文";
    const reads = vi.spyOn(bridge, "readPage");
    await act(async () => bridge.emitCloudApplied(projectId, ["project.json", "pages/doc-remote.md"]));
    await until(() => railPages(container).includes("別の Mac のメモ"));
    expect(reads).not.toHaveBeenCalled();
    expect(bodyEditor(container).getText()).toContain("打ちかけ");
  });

  it("背景情報のページに保存していない変更がある間は project.json を守り、保存したら外す（#18914）", async () => {
    const { bridge, projectId } = await docBridge("本文");
    bridge.cloud = activeCloud();
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "背景情報"));
    expect(bridge.protectedPaths(projectId).includes("project.json")).toBe(false);
    await typeInto(container.querySelector("#info-bg")!, "別の Mac で上書きされたくない背景");
    await until(() => bridge.protectedPaths(projectId).includes("project.json"));
    await click(button(container.querySelector<HTMLElement>(".folder-save")!, "保存"));
    await until(() => !bridge.protectedPaths(projectId).includes("project.json"));
    expect(bridge.projects.get(projectId)!.project.info.background).toBe("別の Mac で上書きされたくない背景");
  });

  it("別の Mac で削除されたフォルダは、レールで「復元する」か、確かめてから「手元も消す」", async () => {
    const { bridge, projectId } = await docBridge("本文");
    bridge.cloud = activeCloud();
    bridge.cloudSnapshots.set(projectId, syncSnapshot(projectId, { tombstone: { needsChoice: true } }));
    screen = await renderApp(bridge);
    const { container } = screen;
    const notice = () => container.querySelector<HTMLElement>(".rail .cloud-notice");
    const name = bridge.projects.get(projectId)!.project.name;
    await until(() => notice()?.textContent?.includes(`「${name}」は別の Mac で削除されました`) ?? false);
    await click(button(notice()!, "手元も消す"));
    expect(dialog(container).querySelector("h2")?.textContent).toBe("手元のフォルダも消しますか");
    expect(button(dialog(container), "手元も消す").className).toContain("stop");
    await click(button(dialog(container), "やめる"));
    expect(bridge.cloudCallsOf("cloudTombstoneChoice")).toEqual([]);
    await click(button(notice()!, "復元する"));
    expect(bridge.cloudCallsOf("cloudTombstoneChoice")).toEqual([[projectId, "restore"]]);
    expect(container.querySelector(".toast")?.textContent).toBe("復元しました");
  });

  it("名前のないフォルダが別の Mac で削除されたときは「無題のフォルダ」と出す", async () => {
    const { bridge, projectId } = await docBridge("本文");
    const stored = bridge.projects.get(projectId)!;
    stored.project = { ...stored.project, name: "  " };
    bridge.cloud = activeCloud();
    bridge.cloudSnapshots.set(projectId, syncSnapshot(projectId, { tombstone: { needsChoice: true } }));
    screen = await renderApp(bridge);
    const { container } = screen;
    const notice = () => container.querySelector<HTMLElement>(".rail .cloud-notice");
    await until(() => notice()?.textContent?.includes("「無題のフォルダ」は別の Mac で削除されました") ?? false);
  });
});
