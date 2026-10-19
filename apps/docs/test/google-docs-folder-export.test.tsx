// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_CHANGED_EVENT,
  ACCOUNT_COMMANDS,
  type AccountTransport,
} from "niho-desktop-account/account-bridge";
import type { AccountState } from "niho-desktop-account/account-state";
import type { DocsDriveFolderExportPlan, DocsDriveFolderExportStatus } from "../src/lib/bridge";
import { defaultSettings } from "../src/lib/settings";
import { button, buttons, click, renderApp, settle, type Screen } from "./dom";
import { FakeBridge, activeCloud, folderExportBuilding, folderExportCompleted, syncSnapshot } from "./fake-bridge";

/** フォルダの書き出し（#18838）: レールのフォルダの ⋯ → ダイアログ → 受付・照会・続きから。文は Web のシートと同じ（design-guide-docs §5.1）。 */

const profile = {
  userId: "user-1",
  displayName: "文書 太郎",
  handle: "docs-taro",
  connectionId: "connection-1",
  avatarPath: null,
};
const otherProfile = { ...profile, userId: "user-2", connectionId: "connection-2", handle: "docs-jiro" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CREATED_AT = "2026-10-18T00:00:00.000Z";
const DEFAULT_INCLUDE = ["doc:memo", "rec:rec1", "step:rec1:fix", "cand:rec1:article:a"];

class FakeAccount {
  state: AccountState;
  listeners = new Map<string, (payload: unknown) => void>();
  transport: AccountTransport;

  constructor(state: AccountState = { kind: "signedIn", profile }) {
    this.state = state;
    this.transport = {
      invoke: async <T,>(command: string) => {
        if (command === ACCOUNT_COMMANDS.state) return this.state as T;
        if (command === ACCOUNT_COMMANDS.logout) this.change({ kind: "signedOut" });
        return undefined as T;
      },
      listen: async <T,>(name: string, handler: (event: { payload: T }) => void) => {
        this.listeners.set(name, (payload) => handler({ payload: payload as T }));
        return () => { this.listeners.delete(name); };
      },
    };
  }

  change(state: AccountState) {
    this.state = state;
    this.listeners.get(ACCOUNT_CHANGED_EVENT)?.(state);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makePlan(projectId: string, overrides: Partial<DocsDriveFolderExportPlan> = {}): DocsDriveFolderExportPlan {
  return {
    available: true,
    projectId,
    revision: 3,
    title: "鎌倉の朝市",
    nodes: [
      { key: "context", kind: "context", title: "背景情報", parentKey: null, chars: 120, defaultSelected: false },
      { key: "doc:memo", kind: "document", title: "取材メモ", parentKey: null, chars: 8_532, defaultSelected: true },
      { key: "rec:rec1", kind: "recording", title: "朝市の録音", parentKey: null, chars: 80, defaultSelected: true },
      { key: "step:rec1:fix", kind: "step", title: "修正版", parentKey: "rec:rec1", chars: 25_400, charsWithoutTimestamps: 21_000, defaultSelected: true },
      { key: "cand:rec1:article:a", kind: "candidate", title: "記事 / 別案 1", parentKey: "rec:rec1", chars: 3_000, defaultSelected: true },
    ],
    limits: { maxTabs: 100, maxChars: 1_000_000 },
    latest: null,
    ...overrides,
  };
}

const failed = (exportId: string, reason: "google_unavailable" | "folder_changed", resumable: boolean): DocsDriveFolderExportStatus => ({
  exportId, createdAt: CREATED_AT, status: "failed", reason, resumable, progress: { done: 2, total: 4 },
});

let screen: Screen | null = null;
afterEach(() => {
  vi.useRealTimers();
  screen?.unmount();
  screen = null;
});

async function setup(options: {
  account?: FakeAccount;
  cloud?: "active" | "local";
  showTimestamps?: boolean;
  plan?: Partial<DocsDriveFolderExportPlan>;
} = {}) {
  const bridge = new FakeBridge();
  bridge.docsDrive = { status: "CONNECTED", connectedEmail: "Taro@Example.com", reason: null };
  if (options.showTimestamps) bridge.settings = { ...defaultSettings(), transcription: { language: "ja", showTimestamps: true } };
  if ((options.cloud ?? "active") === "active") bridge.cloud = activeCloud();
  const folder = await bridge.createProject(
    { version: 1, id: "", name: "鎌倉の朝市", createdAt: "2026-10-16T00:00:00Z", info: { terms: [], background: "" }, pages: [] },
    null,
    null,
    [],
  );
  bridge.cloudSnapshots.set(folder.id, syncSnapshot(folder.id));
  bridge.folderExportPlans.set(folder.id, makePlan(folder.id, options.plan));
  const account = options.account ?? new FakeAccount();
  screen = await renderApp(bridge, account.transport);
  return { bridge, account, projectId: folder.id, container: screen.container };
}

function folderRow(container: HTMLElement, name = "鎌倉の朝市"): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>(".rail div.case")].find((item) => item.querySelector(".ti.case .t")?.textContent === name);
  if (!row) throw new Error(`folder not found: ${name}`);
  return row;
}

async function openMenu(container: HTMLElement): Promise<HTMLElement> {
  const row = folderRow(container);
  await click(row.querySelector('button[aria-label="フォルダのその他"]')!);
  return row.querySelector<HTMLElement>(".folder-menu .pop")!;
}

async function openExport(container: HTMLElement): Promise<HTMLElement> {
  await click(button(await openMenu(container), "Google ドキュメントへ書き出す"));
  return exportDialog(container);
}

function exportDialog(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>(".folder-export-dialog");
  if (!found) throw new Error("folder export dialog not found");
  return found;
}

function row(container: HTMLElement, title: string): HTMLLabelElement {
  const found = [...exportDialog(container).querySelectorAll<HTMLLabelElement>(".folder-export-row")].find((item) => item.querySelector(".t")?.textContent === title);
  if (!found) throw new Error(`row not found: ${title}`);
  return found;
}

function checked(container: HTMLElement, title: string): boolean {
  return row(container, title).querySelector<HTMLInputElement>("input")!.checked;
}

function alerts(container: HTMLElement): string {
  return [...exportDialog(container).querySelectorAll('[role="alert"]')].map((item) => item.textContent).join("");
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  return button(exportDialog(container), "書き出す");
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await settle();
}

describe("フォルダの ⋯ からの入口", () => {
  it("「上へ移動」の上（区切りの上）に項目があり、押すとダイアログが開いて木の既定の選び方・字数・目安を出す", async () => {
    const { bridge, projectId, container } = await setup();
    const menu = await openMenu(container);
    const items = [...menu.children].map((item) => item.className === "menu-separator" ? "---" : item.textContent);
    expect(items.slice(0, 3)).toEqual(["Google ドキュメントへ書き出す", "---", "上へ移動"]);
    await click(button(menu, "Google ドキュメントへ書き出す"));

    const dialog = exportDialog(container);
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.querySelector("h2")?.textContent).toBe("Google ドキュメントへ書き出す");
    expect(dialog.textContent).toContain("このフォルダのページを、タブに分けた 1 つの Google ドキュメントにします。元のページは変わりません。");
    expect(bridge.folderExportPlanCalls).toEqual([projectId]);
    expect(dialog.querySelector<HTMLInputElement>("input.inp")?.value).toBe("鎌倉の朝市");
    // 書き出し先のアカウントは出さない（設定だけ。owner 2026-10-18・#18920）
    expect(dialog.textContent).not.toContain("書き出し先");
    expect(dialog.textContent).not.toContain("Taro@Example.com");
    expect(dialog.querySelector("legend")?.textContent).toBe("入れるページ");
    expect(checked(container, "背景情報")).toBe(false);
    expect(checked(container, "取材メモ")).toBe(true);
    expect(checked(container, "修正版")).toBe(true);
    expect(row(container, "修正版").className).toContain("child");
    expect(row(container, "取材メモ").textContent).toBe("取材メモ8,532字");
    expect(row(container, "修正版").textContent).toBe("修正版2.1万字");
    expect(dialog.textContent).toContain("タブ 4/100 · 3.2万字/100万字");
    expect(submitButton(container).disabled).toBe(false);
    expect(dialog.textContent).not.toContain("受付");
  });

  it("NIHO にログインできないときは項目を出さない。ログインしていなければダイアログでログインを案内し、木を読まない", async () => {
    const closed = new FakeBridge();
    closed.accountOpen = false;
    await closed.createProject({ version: 1, id: "", name: "鎌倉の朝市", createdAt: "2026-10-16T00:00:00Z", info: { terms: [], background: "" }, pages: [] }, null, null, []);
    screen = await renderApp(closed, new FakeAccount({ kind: "signedOut" }).transport);
    const menu = await openMenu(screen.container);
    expect(buttons(menu).map((item) => item.textContent)).not.toContain("Google ドキュメントへ書き出す");
    screen.unmount();

    const { bridge, container } = await setup({ account: new FakeAccount({ kind: "signedOut" }), cloud: "local" });
    const dialog = await openExport(container);
    expect(dialog.textContent).toContain("NIHO にログインしてから書き出してください。");
    expect(button(dialog, "設定へ進む")).toBeTruthy();
    expect(bridge.folderExportPlanCalls).toEqual([]);
    await click(button(dialog, "閉じる"));
    expect(container.querySelector(".folder-export-dialog")).toBeNull();
  });

  it("開くと focus をダイアログに置き、Esc で閉じると focus はフォルダの ⋯ へ戻る", async () => {
    const { container } = await setup();
    const dialog = await openExport(container);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(container.querySelector(".folder-export-dialog")).toBeNull();
    expect(document.activeElement).toBe(folderRow(container).querySelector('button[aria-label="フォルダのその他"]'));
  });
});

describe("入れるページ", () => {
  it("録音の行を外すと下の成果物も外れ、成果物を選ぶと録音の行も入る", async () => {
    const { container } = await setup();
    await openExport(container);
    await click(row(container, "朝市の録音").querySelector("input")!);
    expect(checked(container, "朝市の録音")).toBe(false);
    expect(checked(container, "修正版")).toBe(false);
    expect(checked(container, "記事 / 別案 1")).toBe(false);
    expect(exportDialog(container).textContent).toContain("タブ 1/100 · 8,532字/100万字");
    await click(row(container, "修正版").querySelector("input")!);
    expect(checked(container, "朝市の録音")).toBe(true);
    expect(checked(container, "修正版")).toBe(true);
    expect(checked(container, "記事 / 別案 1")).toBe(false);
  });

  it("上限を超えたら超えた量を alert で出して「書き出す」を押せない。何も選んでいなければ理由を出す", async () => {
    const { container } = await setup({ plan: { limits: { maxTabs: 3, maxChars: 30_000 } } });
    await openExport(container);
    expect(alerts(container)).toContain("タブが多すぎます。あと 1 個外してください。文字数が多すぎます。あと約 2,612 字分のページを外してください。");
    expect(submitButton(container).disabled).toBe(true);
    await click(row(container, "取材メモ").querySelector("input")!);
    await click(row(container, "朝市の録音").querySelector("input")!);
    expect(alerts(container)).toBe("");
    expect(exportDialog(container).textContent).toContain("入れるページを選んでください。");
    expect(submitButton(container).disabled).toBe(true);
  });

  it("タイムスタンプの既定は表示の設定に従い、切り替えると字数が変わる。ダイアログで変えても設定は書き換えない", async () => {
    const { bridge, container } = await setup({ showTimestamps: true });
    const saved = structuredClone(bridge.settings);
    await openExport(container);
    const toggle = exportDialog(container).querySelector<HTMLButtonElement>('button[aria-label="タイムスタンプ"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(row(container, "修正版").textContent).toBe("修正版2.5万字");
    expect(exportDialog(container).textContent).toContain("タブ 4/100 · 3.7万字/100万字");
    await click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(row(container, "修正版").textContent).toBe("修正版2.1万字");
    expect(bridge.settings).toEqual(saved);
    await click(submitButton(container));
    expect(bridge.folderExportRequests[0]?.timestamps).toBe(false);
  });

  it("時刻を外しても字数の変わらないフォルダではタイムスタンプを出さない", async () => {
    const { bridge, projectId, container } = await setup({ showTimestamps: true });
    bridge.folderExportPlans.set(projectId, makePlan(projectId, {
      nodes: makePlan(projectId).nodes.map(({ charsWithoutTimestamps: _drop, ...node }) => node),
    }));
    await openExport(container);
    expect(exportDialog(container).querySelector('button[aria-label="タイムスタンプ"]')).toBeNull();
    await click(submitButton(container));
    expect(bridge.folderExportRequests[0]?.timestamps).toBe(false);
  });
});

describe("保存と同期", () => {
  it("同期が終わっていない間は「保存が終わってから書き出せます。」で押せず、同期が済むと木を読み直して押せる", async () => {
    const { bridge, projectId, container } = await setup();
    bridge.cloudSnapshots.set(projectId, syncSnapshot(projectId, { localGeneration: 2, dirty: { "pages.json": 2 } }));
    await openExport(container);
    expect(exportDialog(container).textContent).toContain("保存が終わってから書き出せます。");
    expect(submitButton(container).disabled).toBe(true);
    const reads = bridge.folderExportPlanCalls.length;
    expect(bridge.cloudCallsOf("cloudProjectStatus")).toContainEqual([projectId]);

    bridge.folderExportPlans.set(projectId, makePlan(projectId, { revision: 4 }));
    await act(async () => bridge.ackCloud(projectId));
    await settle();
    expect(exportDialog(container).textContent).not.toContain("保存が終わってから書き出せます。");
    expect(bridge.folderExportPlanCalls.length).toBe(reads + 1);
    expect(submitButton(container).disabled).toBe(false);
    await click(submitButton(container));
    expect(bridge.folderExportRequests[0]?.revision).toBe(4);
  });

  it("開いているフォルダは、書き残したあとの同期の状態を読み直して反映するまで「保存が終わってから書き出せます。」のまま", async () => {
    const { bridge, projectId, container } = await setup();
    // そのフォルダを開く（開いているフォルダは、書きかけをこの Mac に書き残してから同期の状態を見る）
    await click(folderRow(container).querySelector<HTMLElement>(".ti.case")!);
    await settle();
    const gate = deferred<void>();
    bridge.cloudProjectStatusGate = gate.promise;
    await openExport(container);
    // 読み直しの応答が届くまでは、書き残す前の「済み」のままでも書き出せない
    expect(bridge.cloudCallsOf("cloudProjectStatus")).toContainEqual([projectId]);
    expect(exportDialog(container).textContent).toContain("保存が終わってから書き出せます。");
    expect(submitButton(container).disabled).toBe(true);

    bridge.cloudProjectStatusGate = null;
    await act(async () => gate.resolve());
    await settle();
    expect(exportDialog(container).textContent).not.toContain("保存が終わってから書き出せます。");
    expect(submitButton(container).disabled).toBe(false);
  });

  it("NIHO クラウドと同期していないフォルダは木を読まず、待っても書き出せないことを出す", async () => {
    const { bridge, container } = await setup({ cloud: "local" });
    const dialog = await openExport(container);
    expect(dialog.textContent).toContain("クラウドに保存しているフォルダだけ書き出せます。");
    expect(dialog.textContent).not.toContain("保存が終わってから書き出せます。");
    expect(bridge.folderExportPlanCalls).toEqual([]);
    expect(() => submitButton(container)).toThrow();
  });
});

describe("受付と作成中", () => {
  it("木の key・版・タイトル・タイムスタンプだけを送り、作成中は開いている間だけ 3 秒ごとに照会する。完了したら押したときだけ開く", async () => {
    const { bridge, projectId, container } = await setup();
    await openExport(container);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await click(submitButton(container));
    const request = bridge.folderExportRequests[0]!;
    expect(request).toEqual({ exportId: expect.stringMatching(UUID), projectId, revision: 3, title: "鎌倉の朝市", include: DEFAULT_INCLUDE, timestamps: false });
    const status = exportDialog(container).querySelector('[role="status"]');
    expect(status?.textContent).toBe("作成中（0 / 4 タブ）この画面を閉じても作成は続きます。");
    expect(bridge.folderExportStatusIds).toEqual([]);

    bridge.folderExportStatusResults.push(folderExportBuilding(request.exportId, 2, 4));
    await advance(3_000);
    expect(bridge.folderExportStatusIds).toEqual([request.exportId]);
    expect(exportDialog(container).textContent).toContain("作成中（2 / 4 タブ）");

    // 閉じている間は照会しない。開き直すとすぐに照会する
    await click(button(exportDialog(container), "閉じる"));
    await advance(30_000);
    expect(bridge.folderExportStatusIds).toHaveLength(1);
    bridge.folderExportStatusResults.push(folderExportCompleted(request.exportId, "folder_document_1", 2));
    await openExport(container);
    expect(bridge.folderExportStatusIds).toHaveLength(2);
    expect(exportDialog(container).textContent).toContain("Google ドキュメントを作成しました。");
    expect(exportDialog(container).textContent).toContain("写真 2 枚を入れられませんでした。");
    expect(bridge.docsDriveOpenedIds).toEqual([]);
    await click(button(exportDialog(container), "Google ドキュメントを開く"));
    expect(bridge.docsDriveOpenedIds).toEqual(["folder_document_1"]);
  });

  it("フォルダが更新されていたら（409）木を読み直して文を出し、選び方は保ったまま新しい版で送る", async () => {
    const { bridge, projectId, container } = await setup();
    await openExport(container);
    await click(row(container, "背景情報").querySelector("input")!);
    bridge.folderExportResults.push({ code: "folder_changed", message: "サーバーの文言" });
    bridge.folderExportPlans.set(projectId, makePlan(projectId, { revision: 4 }));
    await click(submitButton(container));
    expect(exportDialog(container).textContent).toContain("フォルダが更新されました。中身を読み直しました。");
    expect(exportDialog(container).textContent).not.toContain("サーバーの文言");
    expect(checked(container, "背景情報")).toBe(true);
    await click(submitButton(container));
    const [first, second] = bridge.folderExportRequests;
    expect(second?.revision).toBe(4);
    expect(second?.include).toEqual(["context", ...DEFAULT_INCLUDE]);
    expect(second?.exportId).not.toBe(first?.exportId);
  });

  it("上限を超えていたら（422）API の数で alert を出し、選び直すまで押せない", async () => {
    const { bridge, container } = await setup();
    await openExport(container);
    bridge.folderExportResults.push({ code: "export_too_large", message: "x", details: { tabs: 120, chars: 1_234_567, maxTabs: 100, maxChars: 1_000_000 } });
    await click(submitButton(container));
    expect(alerts(container)).toContain("タブが多すぎます。あと 20 個外してください。文字数が多すぎます。あと約 234,567 字分のページを外してください。");
    expect(submitButton(container).disabled).toBe(true);
    await click(row(container, "取材メモ").querySelector("input")!);
    expect(alerts(container)).toBe("");
    expect(submitButton(container).disabled).toBe(false);
  });

  it("書き出しの仕組みが止まっている（available=false・503）ときは理由を出して押せない", async () => {
    const { bridge, projectId, container } = await setup({ plan: { available: false } });
    await openExport(container);
    expect(exportDialog(container).textContent).toContain("今は書き出せません。時間をおいてもう一度お試しください。");
    expect(submitButton(container).disabled).toBe(true);
    await click(button(exportDialog(container), "閉じる"));
    bridge.folderExportPlans.set(projectId, makePlan(projectId));
    await openExport(container);
    bridge.folderExportResults.push({ code: "folder_export_unavailable", message: "x" });
    await click(submitButton(container));
    expect(exportDialog(container).textContent).toContain("今は書き出せません。時間をおいてもう一度お試しください。");
    expect(submitButton(container).disabled).toBe(true);
  });

  it("送った結果が分からなければ同じ ID で照会し、届いていなければ同じ内容で送り直す。閉じて開き直しても同じ受付を出す", async () => {
    const { bridge, container } = await setup();
    await openExport(container);
    bridge.folderExportResults.push({ code: "export_result_unknown", message: "x" });
    bridge.folderExportStatusResults.push({ code: "export_not_found", message: "この書き出しはまだ受け付けられていません。" });
    await click(submitButton(container));
    const first = bridge.folderExportRequests[0]!;
    expect(bridge.folderExportStatusIds).toEqual([first.exportId]);
    const dialog = exportDialog(container);
    expect(dialog.textContent).toContain("書き出しの結果をまだ確認できていません。");
    expect(dialog.textContent).toContain("書き出しの依頼が届いていませんでした。同じ内容で再試行できます。");
    expect(dialog.textContent).not.toContain("受付");

    // 開き直すと同じ ID をすぐに照会する（送り直さない）
    await click(button(dialog, "閉じる"));
    bridge.folderExportStatusResults.push({ code: "export_not_found", message: "x" });
    await openExport(container);
    expect(bridge.folderExportStatusIds).toEqual([first.exportId, first.exportId]);
    expect(bridge.folderExportRequests).toHaveLength(1);
    expect(exportDialog(container).textContent).toContain("書き出しの依頼が届いていませんでした。同じ内容で再試行できます。");
    await click(button(exportDialog(container), "同じ内容で再試行"));
    expect(bridge.folderExportRequests).toHaveLength(2);
    expect(bridge.folderExportRequests[1]).toEqual(first);
    expect(exportDialog(container).textContent).toContain("作成中（0 / 4 タブ）");
  });

  it("Google の接続が要る失敗は再接続を案内し、「設定へ進む」で設定を開いて、接続できたら同じ書き出しを照会する", async () => {
    const { bridge, container } = await setup();
    await openExport(container);
    bridge.folderExportResults.push({ code: "export_result_unknown", message: "x" });
    bridge.folderExportStatusResults.push({ code: "drive_reconnect_required", message: "x" });
    bridge.docsDrive = { status: "ERROR", connectedEmail: null, reason: "auth_revoked" };
    await click(submitButton(container));
    const exportId = bridge.folderExportRequests[0]!.exportId;
    expect(alerts(container)).toContain("Google へ再接続して、同じ書き出しの結果を確認してください。");
    await click(button(exportDialog(container), "設定へ進む"));
    expect(container.querySelector(".folder-export-dialog")).toBeNull();
    expect(container.querySelector(".google-docs-card")).not.toBeNull();

    bridge.folderExportStatusResults.push(folderExportBuilding(exportId, 1, 4));
    bridge.docsDrive = { status: "CONNECTED", connectedEmail: "taro@example.com", reason: null };
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(bridge.folderExportStatusIds.at(-1)).toBe(exportId);
    expect(exportDialog(container).textContent).toContain("作成中（1 / 4 タブ）");
  });
});

describe("止まった書き出しと開き直し", () => {
  it("24 時間以内の書き出し（latest）があれば、その表示から始める", async () => {
    const { bridge, container } = await setup({ plan: { latest: folderExportBuilding("0f8a5b2e-3c1d-4e5f-8a9b-0c1d2e3f4a5b", 1, 5) } });
    await openExport(container);
    expect(exportDialog(container).textContent).toContain("作成中（1 / 5 タブ）");
    expect(exportDialog(container).textContent).toContain("この画面を閉じても作成は続きます。");
    expect(bridge.folderExportRequests).toEqual([]);
  });

  it("開き直したとき、結果の分からない書き出し（latest）で Google の接続がすでに切れていれば、再接続を案内する", async () => {
    const id = "0f8a5b2e-3c1d-4e5f-8a9b-0c1d2e3f4a5b";
    const { bridge, container } = await setup({ plan: { latest: { exportId: id, createdAt: CREATED_AT, status: "pending", retryable: false } } });
    // 接続の取得は木の取得より先に済んでいる（開き直す前に切れていた）
    bridge.docsDrive = { status: "ERROR", connectedEmail: null, reason: "auth_revoked" };
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle();
    await openExport(container);
    expect(alerts(container)).toContain("Google へ再接続して、同じ書き出しの結果を確認してください。");
    expect(button(exportDialog(container), "設定へ進む")).toBeTruthy();
  });

  it("続けられるときだけ「続きから作る」を出して同じ書き出しの続きを作る", async () => {
    const id = "0f8a5b2e-3c1d-4e5f-8a9b-0c1d2e3f4a5b";
    const { bridge, container } = await setup({ plan: { latest: failed(id, "google_unavailable", true) } });
    await openExport(container);
    expect(alerts(container)).toContain("途中で止まりました。");
    bridge.folderExportResumeResults.push(folderExportBuilding(id, 2, 4));
    await click(button(exportDialog(container), "続きから作る"));
    expect(bridge.folderExportResumeIds).toEqual([id]);
    expect(exportDialog(container).textContent).toContain("作成中（2 / 4 タブ）");
  });

  it("続けられない止まり方は理由の文と「新しく書き出す」だけを出し、確認の後に入力へ戻る。開き直しても前の書き出しに戻らない", async () => {
    const id = "0f8a5b2e-3c1d-4e5f-8a9b-0c1d2e3f4a5b";
    const { bridge, container } = await setup({ plan: { latest: failed(id, "folder_changed", false) } });
    await openExport(container);
    expect(alerts(container)).toContain("フォルダが更新されたため、もう一度書き出してください。");
    expect(buttons(exportDialog(container)).map((item) => item.textContent)).not.toContain("続きから作る");
    await click(button(exportDialog(container), "新しく書き出す"));
    const confirmation = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(confirmation.textContent).toContain("新しい Google ドキュメントを作成しますか？");
    expect(confirmation.textContent).toContain("前の書き出しとは別に、新しい Google ドキュメントを 1 つ作成します。");
    await click(button(confirmation, "新しく書き出す"));
    expect(submitButton(container)).toBeTruthy();
    await click(button(exportDialog(container), "閉じる"));
    await openExport(container);
    expect(alerts(container)).not.toContain("フォルダが更新されたため");
    expect(submitButton(container).disabled).toBe(false);
    expect(bridge.folderExportResumeIds).toEqual([]);
  });

  it("完了の後の「新しく書き出す」は確かめずに入力へ戻る", async () => {
    const id = "0f8a5b2e-3c1d-4e5f-8a9b-0c1d2e3f4a5b";
    const { container } = await setup({ plan: { latest: folderExportCompleted(id) } });
    await openExport(container);
    expect(exportDialog(container).textContent).toContain("Google ドキュメントを作成しました。");
    await click(button(exportDialog(container), "新しく書き出す"));
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(exportDialog(container).textContent).not.toContain("Google ドキュメントを作成しました。");
    expect(submitButton(container).disabled).toBe(false);
  });

  it("木を読めなければ文と「読み直す」を出す", async () => {
    const { bridge, container } = await setup();
    bridge.folderExportPlanResults.push({ code: "temporarily_unavailable", message: "x" });
    await openExport(container);
    expect(alerts(container)).toContain("フォルダの中身を読めませんでした。時間をおいてもう一度お試しください。");
    await click(button(exportDialog(container), "読み直す"));
    expect(submitButton(container).disabled).toBe(false);
  });

  it("NIHO の本人が変わったら前の本人の書き出しも写しも出さず、前の本人の遅れた応答も反映しない", async () => {
    const { bridge, account, container } = await setup();
    const pending = deferred<DocsDriveFolderExportStatus>();
    bridge.docsDriveFolderExport = async (request) => {
      bridge.folderExportRequests.push(structuredClone(request));
      return pending.promise;
    };
    await openExport(container);
    await click(submitButton(container));
    expect(exportDialog(container).textContent).toContain("Google ドキュメントを作成しています");
    const oldRequest = bridge.folderExportRequests[0]!;

    await act(async () => {
      account.change({ kind: "signedOut" });
      account.change({ kind: "signedIn", profile: otherProfile });
    });
    await settle();
    expect(container.querySelector(".folder-export-dialog")).toBeNull();
    await act(async () => pending.resolve(folderExportCompleted(oldRequest.exportId)));
    await settle();
    await openExport(container);
    expect(exportDialog(container).textContent).not.toContain("Google ドキュメントを作成しました。");
    expect(exportDialog(container).textContent).not.toContain("Google ドキュメントを作成しています");
    expect(submitButton(container).disabled).toBe(false);
  });
});

describe("寸法", () => {
  function rule(selector: string): string {
    const css = readFileSync(join(__dirname, "../../../packages/docs-ui/src/styles/app.css"), "utf8").replaceAll(":where([data-docs-app-root]):where([data-docs-shared-ui]) ", "");
    const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    if (!match) throw new Error(`app.css に ${selector} の規則がありません`);
    return match[1]!;
  }

  it("木はダイアログの中で送り、目安とボタンの行は縮めずに下へ残す", () => {
    expect(rule(".folder-export-dialog")).toContain("overflow: hidden");
    expect(rule(".folder-export-form")).toContain("min-height: 0");
    expect(rule(".folder-export-scroll")).toContain("overflow-y: auto");
    expect(rule(".folder-export-scroll")).toContain("min-height: 0");
    expect(rule(".folder-export-foot")).toContain("flex: none");
    expect(rule(".folder-export-row")).toContain("min-height: 36px");
  });
});
