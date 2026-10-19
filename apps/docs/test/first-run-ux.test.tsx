// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ACCOUNT_CHANGED_EVENT, ACCOUNT_COMMANDS, type AccountTransport } from "niho-desktop-account/account-bridge";
import type { AccountState } from "niho-desktop-account/account-state";
import { FLOW_TEMPLATES, createFlowFromTemplate } from "@niho/docs-core";
import { button, buttons, click, renderApp, type Screen } from "./dom";
import { FakeBridge, fakeStatus } from "./fake-bridge";
import { addPage, createProjectByName, exportFromMenu, openExportMenu, pageMenuButton, seedBlankRecording, seedText, until } from "./pages";

/**
 * 全体レビュー（#18380）で見つかった、初回の利用者がつまずく所: 工程が 0 本の録音の欄・「工程設計で作る」から戻る道・実行の前の
 * 準備の不足・サーバーが閉じている NIHO アカウントの欄。
 */

let screen: Screen | null = null;
afterEach(() => {
  screen?.unmount();
  screen = null;
});

const flowOptions = (container: HTMLElement) =>
  [...container.querySelector<HTMLSelectElement>("#rec-flow")!.options].map((option) => option.textContent);
/** 実行の帯の理由の文（続けて置く「設定を開く」は含めない）。 */
const runNote = (container: HTMLElement) => container.querySelector(".runbar .note")?.firstChild?.textContent ?? null;
const templateCard = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>(".tcard")].find((card) => card.querySelector("b")?.textContent === name)!;
const minutes = () => createFlowFromTemplate(FLOW_TEMPLATES.find((template) => template.name === "議事録")!, "flow-minutes");

describe("工程が 0 本の利用者の最初の録音", () => {
  it("工程の欄は「工程がまだありません」と出し、「工程設計で作る」からテンプレートを選ぶとその録音に付けて戻る", async () => {
    const bridge = new FakeBridge();
    await seedBlankRecording(bridge, "朝の会");
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => container.querySelector("#rec-flow") !== null);
    expect(flowOptions(container)).toEqual(["工程がまだありません", "記事制作", "議事録", "インサイト整理", "コーチング"]);
    expect(container.textContent).not.toContain("削除済み");

    await click(button(container, "工程設計で作る"));
    expect(container.querySelector("h1")?.textContent).toBe("工程を選ぶ");
    // フォルダの音声なので、戻り先は背景情報のページ（名前はフォルダ名。#18914）
    expect(container.querySelector(".page .help")?.textContent).toContain("「朝の会」の工程にして、背景情報のページへ戻ります");
    await click(templateCard(container, "議事録"));
    await click(button(container, "続ける"));
    await until(() => container.querySelector("#rec-flow") !== null);

    const stored = bridge.byName("朝の会");
    const page = stored.project.pages!.find((entry) => entry.kind === "rec")!;
    const snapshot = bridge.recording(stored.project.id, page.recordingId ?? page.id).recording.flowSnapshot;
    expect(snapshot.name).toBe("議事録");
    expect(snapshot.steps.length).toBeGreaterThan(0);
    expect(container.querySelector<HTMLSelectElement>("#rec-flow")!.value).toBe(bridge.flow!.id);
    expect(flowOptions(container)).toEqual(["議事録", "記事制作", "インサイト整理", "コーチング"]);
    expect(container.querySelector(".toast")?.textContent).toBe("この録音の工程を「議事録」にしました");
  });

  it("ほかの画面を経て工程設計から選んだときは、これまでどおり工程設計に留まり、録音は変えない", async () => {
    const bridge = new FakeBridge();
    await seedBlankRecording(bridge, "朝の会");
    screen = await renderApp(bridge);
    const { container } = screen;
    await until(() => container.querySelector("#rec-flow") !== null);
    await click(button(container, "工程設計で作る"));
    await click(button(container, "設定"));
    await click(button(container, "工程設計"));
    expect(container.querySelector(".page .help")?.textContent).not.toContain("録音のページへ戻ります");
    await click(templateCard(container, "議事録"));
    await click(button(container, "続ける"));
    expect(container.querySelector("h1")?.textContent).toBe("工程設計");
    const stored = bridge.byName("朝の会");
    const page = stored.project.pages!.find((entry) => entry.kind === "rec")!;
    expect(bridge.recording(stored.project.id, page.recordingId ?? page.id).recording.flowSnapshot.steps).toEqual([]);
  });
});

describe("実行の前に分かる準備の不足", () => {
  it("工程の AI が未ログインなら、実行の前に帯へ理由と設定への導線を出し、窓へ戻ると確かめ直す", async () => {
    const bridge = new FakeBridge();
    bridge.flow = minutes();
    bridge.claude = fakeStatus("ClaudeCode", { authenticated: false, login_method: null, reason: "auth_required" });
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "朝の会");
    await addPage(container, "音声");
    expect(runNote(container)).toBe("音声を入れると実行できます");
    await seedText(bridge, container, "今日の議題は朝市です。");
    expect(runNote(container)).toBe("Claude Code にログインすると実行できます");
    expect(button(container, "続きを作成").disabled).toBe(true);
    expect(container.querySelector(".runbar .note.setup button")?.textContent).toBe("設定を開く");

    // ターミナルでログインして窓へ戻る
    bridge.claude = fakeStatus("ClaudeCode");
    await act(async () => window.dispatchEvent(new Event("focus")));
    await until(() => button(container, "続きを作成").disabled === false);
    expect(runNote(container)).toBe("続きはこの Mac で作ります");
    expect(button(container, "続きを作成").disabled).toBe(false);
  });

  it("「設定を開く」で設定へ移り、音声モデルが未取得なら音声を入れた録音の帯に理由を出す", async () => {
    const bridge = new FakeBridge();
    bridge.flow = minutes();
    const ready = await bridge.speechStatus();
    bridge.speechStatus = async () => ({ ...ready, needsDownload: true });
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "朝の会");
    await addPage(container, "音声");
    bridge.pickedAudio = ["/Users/me/朝の会.m4a"];
    await click(button(container, "ファイルを選択"));
    await until(() => container.querySelector(".afile") !== null);
    expect(runNote(container)).toBe("この Mac の音声モデルを取得すると実行できます");
    expect(button(container, "文書作成を開始").disabled).toBe(true);
    await click(button(container, "設定を開く"));
    expect(container.querySelector("h1")?.textContent).toBe("設定");
  });

  it("この Mac で音声認識を使えないと、実行の前に理由と代わりの手段を出して押せず、設定では「この Mac」を選べない（#18753）", async () => {
    const bridge = new FakeBridge();
    bridge.flow = minutes();
    const ready = await bridge.speechStatus();
    // 音声モデルも未取得（話者分離のモデルが無い）だが、使えない理由を先に出し、取得は出さない
    bridge.speechStatus = async () => ({ ...ready, fake: false, available: false, needsDownload: true, unsupported: "engine" });
    screen = await renderApp(bridge);
    const { container } = screen;
    await createProjectByName(container, "朝の会");
    await addPage(container, "音声");
    bridge.pickedAudio = ["/Users/me/朝の会.m4a"];
    await click(button(container, "ファイルを選択"));
    await until(() => container.querySelector(".afile") !== null);
    expect(runNote(container)).toBe("この Mac では音声認識を使えません。Gemini か Deepgram（API キー方式）を登録すると実行できます");
    expect(button(container, "文書作成を開始").disabled).toBe(true);

    await click(button(container, "設定を開く"));
    expect(container.querySelector("h1")?.textContent).toBe("設定");
    await until(() => container.textContent?.includes("「この Mac」では文字起こしできません") ?? false);
    expect(container.textContent).toContain("日本語 · 使えません");
    expect(buttons(container).some((candidate) => candidate.textContent === "取得")).toBe(false);
    const engines = container.querySelector<HTMLElement>('[aria-label="既定のエンジン"]')!;
    expect(button(engines, "この Mac").disabled).toBe(true);
  });
});

class FakeAccount {
  state: AccountState;
  listeners = new Map<string, (payload: unknown) => void>();
  transport: AccountTransport;
  constructor(state: AccountState) {
    this.state = state;
    this.transport = {
      invoke: async <T,>(command: string) => (command === ACCOUNT_COMMANDS.state ? (this.state as T) : (undefined as T)),
      listen: async <T,>(name: string, handler: (event: { payload: T }) => void) => {
        this.listeners.set(name, (payload) => handler({ payload: payload as T }));
        return () => {
          this.listeners.delete(name);
        };
      },
    };
  }
  change(state: AccountState) {
    this.state = state;
    this.listeners.get(ACCOUNT_CHANGED_EVENT)?.(state);
  }
}

describe("サーバーが NIHO アカウントの接続を閉じている間", () => {
  it("ログインしていない人には、ログインと Google ドキュメントの欄・書き出しを出さない", async () => {
    const bridge = new FakeBridge();
    bridge.accountOpen = false;
    screen = await renderApp(bridge, new FakeAccount({ kind: "signedOut" }).transport);
    const { container } = screen;
    await createProjectByName(container, "朝の会");
    const exportMenu = await openExportMenu(container);
    expect(buttons(exportMenu).map((item) => item.textContent?.trim())).toEqual(["コピー", ".md で保存", "Finder で表示", "リンクで共有"]);
    await exportFromMenu(container, "リンクで共有");
    const sharePanel = container.querySelector<HTMLElement>(".docs-share-panel");
    expect(sharePanel?.textContent).toContain("NIHO にログインしてから共有できます。");
    expect(sharePanel?.querySelector('[role="switch"]')).toBeNull();
    sharePanel?.querySelector<HTMLButtonElement>('button[aria-label="閉じる"]')?.click();
    await click(pageMenuButton(container)!);
    await click(button(container, "設定"));
    expect(container.querySelector(".docs-account")).toBeNull();
    expect(container.querySelector(".google-docs-card")).toBeNull();
  });

  it("ログイン済みの人には、ログアウトできるように欄を残す", async () => {
    const bridge = new FakeBridge();
    bridge.accountOpen = false;
    const profile = { userId: "user-1", displayName: "文書 太郎", handle: null, connectionId: "connection-1", avatarPath: null };
    screen = await renderApp(bridge, new FakeAccount({ kind: "signedIn", profile }).transport);
    const { container } = screen;
    await click(button(container, "設定"));
    expect(container.querySelector(".docs-account")?.textContent).toContain("NIHO アカウント");
    expect(container.querySelector(".google-docs-card")).not.toBeNull();
  });

  it("開いていれば、ログインしていなくても欄を出す", async () => {
    const bridge = new FakeBridge();
    screen = await renderApp(bridge, new FakeAccount({ kind: "signedOut" }).transport);
    const { container } = screen;
    await click(button(container, "設定"));
    expect(container.querySelector(".docs-account")?.textContent).toContain("NIHO アカウント");
    expect(container.querySelector(".google-docs-card")).not.toBeNull();
  });
});
