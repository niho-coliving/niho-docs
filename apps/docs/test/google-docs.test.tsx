// @vitest-environment jsdom
import { act } from "react";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_CHANGED_EVENT,
  ACCOUNT_COMMANDS,
  type AccountTransport,
} from "niho-desktop-account/account-bridge";
import type { AccountState } from "niho-desktop-account/account-state";
import { FLOW_TEMPLATES, ROOT_RECORDING_ID, SOURCE_STEP_ID, createFlowFromTemplate, createFlowSnapshot, defaultProfiles } from "@niho/docs-core";
import type { DocsDriveExportResult } from "../src/lib/bridge";
import { button, click, renderApp, typeInto, type Screen } from "./dom";
import { FakeBridge, cloudStateOf } from "./fake-bridge";
import { addPage, createProjectByName, exportFromMenu, outputRow, pageMenuButton } from "./pages";

const profile = {
  userId: "user-1",
  displayName: "文書 太郎",
  handle: "docs-taro",
  connectionId: "connection-1",
  avatarPath: null,
};

const otherProfile = { ...profile, userId: "user-2", connectionId: "connection-2", handle: "docs-jiro" };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

let screen: Screen | null = null;
afterEach(() => {
  screen?.unmount();
  screen = null;
});

function editor(container: HTMLElement): Editor {
  const element = container.querySelector(".pbody .ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  if (!element?.editor) throw new Error("editor not found");
  return element.editor;
}

async function insertBody(container: HTMLElement, text: string) {
  await act(async () => editor(container).commands.insertContent(text));
}

/** 文書のページのタイトルバーの ⋯ → 書き出し › から Google ドキュメントを選ぶ（owner 2026-10-18・#18941）。 */
async function openGoogleExport(container: HTMLElement) {
  await exportFromMenu(container, "Google ドキュメント");
}

async function connectedDoc() {
  const bridge = new FakeBridge();
  bridge.docsDrive = { status: "CONNECTED", connectedEmail: "taro@example.com", reason: null };
  const account = new FakeAccount();
  screen = await renderApp(bridge, account.transport);
  await createProjectByName(screen.container, "朝市");
  return { bridge, account, container: screen.container };
}

describe("Google ドキュメント接続", () => {
  it("未ログインではAPIを呼ばず、ログイン後は接続を読み、ブラウザから戻ったfocusで確認する", async () => {
    const bridge = new FakeBridge();
    const account = new FakeAccount({ kind: "signedOut" });
    screen = await renderApp(bridge, account.transport);
    await click(button(screen.container, "設定"));
    expect(screen.container.textContent).toContain("利用するには、上の「NIHO アカウント」からログインしてください");
    expect(bridge.docsDriveConnectionCalls).toBe(0);

    await act(async () => account.change({ kind: "signedIn", profile }));
    expect(bridge.docsDriveConnectionCalls).toBe(1);
    await click(button(screen.container.querySelector<HTMLElement>(".google-docs-card")!, "接続"));
    expect(bridge.docsDriveConnectCalls).toBe(1);
    bridge.docsDrive = { status: "CONNECTED", connectedEmail: "taro@example.com", reason: null };
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(bridge.docsDriveConnectionCalls).toBe(2);
    expect(screen.container.querySelector(".google-docs-card")?.textContent).toContain("taro@example.com");
    await click(button(screen.container.querySelector<HTMLElement>(".google-docs-card")!, "解除"));
    expect(screen.container.querySelector('[role="dialog"]')?.textContent).toContain("作成済みのGoogle ドキュメントは削除されません");
    await click(button(screen.container.querySelector<HTMLElement>('[role="dialog"]')!, "やめる"));
    expect(bridge.docsDriveDisconnectCalls).toBe(0);
    await click(button(screen.container.querySelector<HTMLElement>(".google-docs-card")!, "解除"));
    await click(button(screen.container.querySelector<HTMLElement>('[role="dialog"]')!, "解除"));
    expect(bridge.docsDriveDisconnectCalls).toBe(1);
    await act(async () => account.change({ kind: "expired", profile, reason: "connectionRevoked" }));
    expect(bridge.docsDriveConnectionCalls).toBe(2);
    expect(screen.container.querySelector(".google-docs-card")?.textContent).toContain("NIHO アカウント");
  });

  it("初回ログイン後も書き出しダイアログの入力と復帰先を保持する", async () => {
    const bridge = new FakeBridge();
    const account = new FakeAccount({ kind: "signedOut" });
    screen = await renderApp(bridge, account.transport);
    await createProjectByName(screen.container, "ログイン前の文書");
    await typeInto(screen.container.querySelector(".ptitle")!, "初回ログイン後の書き出し");
    await insertBody(screen.container, "ログイン前に入力した本文");
    await openGoogleExport(screen.container);

    const initialDialog = screen.container.querySelector<HTMLElement>(".google-export-dialog")!;
    await click(button(initialDialog, "設定へ進む"));
    expect(screen.container.querySelector(".google-export-dialog")).toBeNull();

    bridge.docsDrive = { status: "CONNECTED", connectedEmail: "taro@example.com", reason: null };
    await act(async () => account.change({ kind: "signedIn", profile }));

    const resumedDialog = screen.container.querySelector<HTMLElement>(".google-export-dialog");
    expect(resumedDialog).not.toBeNull();
    expect((resumedDialog!.querySelector("input") as HTMLInputElement).value).toBe("初回ログイン後の書き出し");
    await click(button(resumedDialog!, "書き出す"));
    expect(bridge.docsDriveExportRequests[0]).toMatchObject({
      title: "初回ログイン後の書き出し",
      markdown: expect.stringContaining("ログイン前に入力した本文"),
    });
  });

  it("旧ownerの遅延connect errorとdisconnect responseが新ownerのメール・busyを変更しない", async () => {
    const bridge = new FakeBridge();
    const account = new FakeAccount();
    bridge.docsDrive = { status: "DISCONNECTED", connectedEmail: null, reason: null };
    screen = await renderApp(bridge, account.transport);
    await click(button(screen.container, "設定"));

    const connecting = deferred<void>();
    bridge.docsDriveConnect = async () => {
      bridge.docsDriveConnectCalls += 1;
      await connecting.promise;
    };
    await click(button(screen.container.querySelector<HTMLElement>(".google-docs-card")!, "接続"));
    expect(button(screen.container.querySelector<HTMLElement>(".google-docs-card")!, "接続").disabled).toBe(true);
    bridge.docsDrive = { status: "CONNECTED", connectedEmail: "new@example.com", reason: null };
    await act(async () => {
      account.change({ kind: "signedOut" });
      account.change({ kind: "signedIn", profile: otherProfile });
    });
    await act(async () => connecting.reject({ code: "oauth_failed", message: "旧ownerのerror" }));
    const card = screen.container.querySelector<HTMLElement>(".google-docs-card")!;
    expect(card.textContent).toContain("new@example.com");
    expect(card.textContent).not.toContain("旧ownerのerror");

    const disconnecting = deferred<ReturnType<FakeBridge["docsDriveDisconnect"]> extends Promise<infer T> ? T : never>();
    bridge.docsDriveDisconnect = async () => {
      bridge.docsDriveDisconnectCalls += 1;
      return disconnecting.promise;
    };
    await click(button(card, "解除"));
    await click(button(screen.container.querySelector<HTMLElement>('[role="dialog"]')!, "解除"));
    await act(async () => {
      account.change({ kind: "signedOut" });
      account.change({ kind: "signedIn", profile });
    });
    bridge.docsDrive = { status: "CONNECTED", connectedEmail: "latest@example.com", reason: null };
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => disconnecting.resolve({ status: "DISCONNECTED", connectedEmail: null, reason: null }));
    expect(card.textContent).toContain("latest@example.com");
    expect(button(card, "解除").disabled).toBe(false);
  });
});

describe("現在の本文の書き出し", () => {
  it("この Mac だけを選んでも、手元の1ページを Google ドキュメントへ書き出せる", async () => {
    const bridge = new FakeBridge();
    bridge.cloud = cloudStateOf({ requiresAccount: true,
      storage: { mode: "LOCAL", epoch: "1", changedAt: null, cleanupPending: false,
        quotaBytes: 5 * 1024 ** 3, closing: null } });
    bridge.docsDrive = { status: "CONNECTED", connectedEmail: "taro@example.com", reason: null };
    screen = await renderApp(bridge, new FakeAccount().transport);
    await createProjectByName(screen.container, "手元の文書");
    await insertBody(screen.container, "この Mac の本文");
    await openGoogleExport(screen.container);
    await click(button(screen.container.querySelector<HTMLElement>(".google-export-dialog")!, "書き出す"));
    expect(bridge.docsDriveExportRequests).toHaveLength(1);
    expect(bridge.docsDriveExportRequests[0]?.markdown).toContain("この Mac の本文");
    expect(bridge.cloudCallsOf("cloudSyncNow")).toHaveLength(0);
  });

  it("APIと同じUTF-16単位でタイトル上限を検査する", async () => {
    const { bridge, container } = await connectedDoc();
    await insertBody(container, "本文");
    await openGoogleExport(container);
    const dialog = container.querySelector<HTMLElement>(".google-export-dialog")!;
    await typeInto(dialog.querySelector("input")!, "😀".repeat(101));
    await click(button(dialog, "書き出す"));
    expect(bridge.docsDriveExportRequests).toHaveLength(0);
    expect(dialog.textContent).toContain("タイトルは1〜200文字");
  });

  it("未保存の文書本文をsnapshotにし、二重clickせず、成功リンクは本人のclickでだけ開く", async () => {
    const { bridge, container } = await connectedDoc();
    await typeInto(container.querySelector(".ptitle")!, "打合せメモ");
    await insertBody(container, "まだ保存待ちの本文");
    expect(bridge.pageWrites).toHaveLength(0);
    await openGoogleExport(container);
    const dialog = container.querySelector<HTMLElement>(".google-export-dialog")!;
    expect((dialog.querySelector("input") as HTMLInputElement).value).toBe("打合せメモ");
    const submit = button(dialog, "書き出す");
    await act(async () => {
      submit.click();
      submit.click();
    });
    expect(bridge.docsDriveExportRequests).toHaveLength(1);
    expect(bridge.docsDriveExportRequests[0]).toMatchObject({ title: "打合せメモ" });
    expect(bridge.docsDriveExportRequests[0]?.markdown).toContain("まだ保存待ちの本文");
    expect(bridge.docsDriveOpenedIds).toEqual([]);
    await click(button(dialog, "Google ドキュメントを開く"));
    expect(bridge.docsDriveOpenedIds).toEqual(["fake_document_123"]);
  });

  it("成果物の選択中draftも同じdialogへ渡す", async () => {
    const bridge = new FakeBridge();
    bridge.docsDrive = { status: "CONNECTED", connectedEmail: "taro@example.com", reason: null };
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
    bridge.flow = flow;
    const project = await bridge.createProject({
      version: 1,
      id: "",
      name: "インタビュー",
      createdAt: "2026-10-16T00:00:00.000Z",
      flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
      info: { speakers: "2", language: "ja", terms: [], background: "" },
      source: { kind: "text" },
    }, "素材\n", {
      id: "save-source", kind: "save", at: "2026-10-16T00:00:00.000Z", stepId: SOURCE_STEP_ID,
      stepName: "文章", version: null, result: "saved",
    }, []);
    const step = flow.steps[0]!;
    await bridge.saveArtifact({ projectId: project.id, recordingId: ROOT_RECORDING_ID }, step.id, false, "保存済み本文\n", {
      id: "save-step", kind: "save", at: "2026-10-16T00:01:00.000Z", stepId: step.id,
      stepName: step.name, version: null, result: "saved",
    });
    screen = await renderApp(bridge, new FakeAccount().transport);
    await click(outputRow(screen.container, step.name));
    await insertBody(screen.container, "下書きの続き");
    await exportFromMenu(screen.container, "Google ドキュメント");
    await click(button(screen.container.querySelector<HTMLElement>(".google-export-dialog")!, "書き出す"));
    expect(bridge.docsDriveExportRequests[0]?.markdown).toContain("下書きの続き");
  });

  it("旧ownerの遅延POST結果とfinallyは新ownerの処理結果・busyを変更しない", async () => {
    const { bridge, account, container } = await connectedDoc();
    const oldPost = deferred<DocsDriveExportResult>();
    const newPost = deferred<DocsDriveExportResult>();
    bridge.docsDriveExport = async (request) => {
      bridge.docsDriveExportRequests.push(structuredClone(request));
      return bridge.docsDriveExportRequests.length === 1 ? oldPost.promise : newPost.promise;
    };
    await insertBody(container, "旧ownerの本文");
    await openGoogleExport(container);
    await click(button(container.querySelector<HTMLElement>(".google-export-dialog")!, "書き出す"));
    const oldRequest = bridge.docsDriveExportRequests[0]!;

    await act(async () => {
      account.change({ kind: "signedOut" });
      account.change({ kind: "signedIn", profile: otherProfile });
    });
    await openGoogleExport(container);
    await click(button(container.querySelector<HTMLElement>(".google-export-dialog")!, "書き出す"));
    const newRequest = bridge.docsDriveExportRequests[1]!;
    await act(async () => oldPost.resolve({
      exportId: oldRequest.exportId,
      status: "completed",
      documentId: "old_owner_document",
      url: "https://docs.google.com/document/d/old_owner_document/edit",
    }));
    expect(container.textContent).toContain("Google ドキュメントを作成しています");
    expect(container.textContent).not.toContain("Google ドキュメントを作成しました");
    await act(async () => newPost.resolve({
      exportId: newRequest.exportId,
      status: "completed",
      documentId: "new_owner_document",
      url: "https://docs.google.com/document/d/new_owner_document/edit",
    }));
    expect(container.textContent).toContain("Google ドキュメントを作成しました");
  });
});

describe("結果が未確定の書き出し", () => {
  it.each(["drive_not_connected", "drive_reconnect_required", "drive_connection_changed"])(
    "%s の結果照会失敗では再接続を案内し、同じ受付IDを再照会する",
    async (code) => {
      const { bridge, container } = await connectedDoc();
      bridge.docsDriveExportResults.push({ exportId: "ignored", status: "pending", retryable: false });
      await insertBody(container, "再接続後に同じ受付を確認する本文");
      await openGoogleExport(container);
      const dialog = container.querySelector<HTMLElement>(".google-export-dialog")!;
      await click(button(dialog, "書き出す"));
      const exportId = bridge.docsDriveExportRequests[0]!.exportId;

      bridge.docsDrive = { status: "ERROR", connectedEmail: null, reason: "auth_revoked" };
      bridge.docsDriveStatusResults.push({ code, message: "Google の接続を確認してください。" });
      await click(button(dialog, "結果を確認"));
      expect(bridge.docsDriveStatusIds).toEqual([exportId]);
      expect(dialog.textContent).toContain("設定へ進む");

      bridge.docsDriveStatusResults.push({
        exportId,
        status: "completed",
        documentId: "reconnected_document",
        url: "https://docs.google.com/document/d/reconnected_document/edit",
      });
      await click(button(dialog, "設定へ進む"));
      bridge.docsDrive = { status: "CONNECTED", connectedEmail: "taro@example.com", reason: null };
      await act(async () => window.dispatchEvent(new Event("focus")));

      expect(bridge.docsDriveStatusIds).toEqual([exportId, exportId]);
      expect(container.textContent).toContain("Google ドキュメントを作成しました");
    },
  );

  it("通信不明は同じIDをGETし、404後の再試行でも同じID・title・本文を使う", async () => {
    const { bridge, container } = await connectedDoc();
    bridge.docsDriveExportResults.push({ code: "export_result_unknown", message: "不明" });
    bridge.docsDriveStatusResults.push({ code: "export_not_found", message: "未受付" });
    await insertBody(container, "同じ内容で再試行する本文");
    await openGoogleExport(container);
    const dialog = container.querySelector<HTMLElement>(".google-export-dialog")!;
    await click(button(dialog, "書き出す"));
    const first = bridge.docsDriveExportRequests[0]!;
    expect(bridge.docsDriveStatusIds).toEqual([first.exportId]);
    await click(button(dialog, "閉じる"));
    await openGoogleExport(container);
    const resumed = container.querySelector<HTMLElement>(".google-export-dialog")!;
    expect((resumed.querySelector("input") as HTMLInputElement).disabled).toBe(true);
    expect(bridge.docsDriveExportRequests).toHaveLength(1);
    bridge.docsDriveExportResults.push({
      exportId: first.exportId,
      status: "completed",
      documentId: "fake_document_456",
      url: "https://docs.google.com/document/d/fake_document_456/edit",
    });
    await click(button(resumed, "同じ内容で再試行"));
    expect(bridge.docsDriveExportRequests).toHaveLength(2);
    expect(bridge.docsDriveExportRequests[1]).toEqual(first);
  });

  it("pendingを閉じても同じ/別ページから元IDを再開し、確認後だけ別snapshotを新IDにする", async () => {
    const { bridge, container } = await connectedDoc();
    bridge.docsDriveExportResults.push({ exportId: "ignored", status: "pending", retryable: false });
    await typeInto(container.querySelector(".ptitle")!, "元の文書");
    await insertBody(container, "元の本文");
    // 閉じたらタイトルバーの ⋯ へ戻る（書き出しは ⋯ の中。owner 2026-10-18・#18941）
    const opener = pageMenuButton(container)!;
    opener.focus();
    await openGoogleExport(container);
    await click(button(container.querySelector<HTMLElement>(".google-export-dialog")!, "書き出す"));
    const first = bridge.docsDriveExportRequests[0]!;
    await click(button(container.querySelector<HTMLElement>(".google-export-dialog")!, "閉じる"));
    expect(document.activeElement).toBe(opener);
    await openGoogleExport(container);
    expect((container.querySelector(".google-export-dialog input") as HTMLInputElement).disabled).toBe(true);
    expect(bridge.docsDriveExportRequests).toHaveLength(1);

    await click(button(container.querySelector<HTMLElement>(".google-export-dialog")!, "閉じる"));
    await addPage(container, "ページ");
    await typeInto(container.querySelector(".ptitle")!, "別の文書");
    await insertBody(container, "別の本文");
    await openGoogleExport(container);
    const resumed = container.querySelector<HTMLElement>(".google-export-dialog")!;
    expect((resumed.querySelector("input") as HTMLInputElement).value).toBe(first.title);
    await click(button(resumed, "新しい書き出し"));
    const confirmation = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(confirmation.textContent).toContain("作成済みの可能性があります");
    await click(button(confirmation, "結果確認に戻る"));
    expect(bridge.docsDriveExportRequests).toHaveLength(1);
    await click(button(container.querySelector<HTMLElement>(".google-export-dialog")!, "新しい書き出し"));
    await click(button(container.querySelector<HTMLElement>('[role="dialog"]')!, "新しく書き出す"));
    const fresh = container.querySelector<HTMLElement>(".google-export-dialog")!;
    expect((fresh.querySelector("input") as HTMLInputElement).value).toBe("別の文書");
    await click(button(fresh, "書き出す"));
    expect(bridge.docsDriveExportRequests[1]!.exportId).not.toBe(first.exportId);
    expect(bridge.docsDriveExportRequests[1]!.markdown).toContain("別の本文");
  });

  it("同じGoogleの失効と再接続では同じ受付を照会し、別Googleへの切替では旧結果を隠す", async () => {
    const { bridge, container } = await connectedDoc();
    bridge.docsDriveExportResults.push({ exportId: "ignored", status: "pending", retryable: false });
    await insertBody(container, "再接続する本文");
    await openGoogleExport(container);
    await click(button(container.querySelector<HTMLElement>(".google-export-dialog")!, "書き出す"));
    const exportId = bridge.docsDriveExportRequests[0]!.exportId;

    bridge.docsDrive = { status: "ERROR", connectedEmail: null, reason: "auth_revoked" };
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.textContent).not.toContain("Google ドキュメントを作成しました");
    bridge.docsDriveStatusResults.push({
      exportId,
      status: "completed",
      documentId: "reconnected_document",
      url: "https://docs.google.com/document/d/reconnected_document/edit",
    });
    bridge.docsDrive = { status: "CONNECTED", connectedEmail: "  TARO@EXAMPLE.COM ", reason: null };
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(bridge.docsDriveStatusIds.at(-1)).toBe(exportId);
    expect(container.textContent).toContain("Google ドキュメントを作成しました");

    const statusCalls = bridge.docsDriveStatusIds.length;
    bridge.docsDrive = { status: "ERROR", connectedEmail: null, reason: "auth_revoked" };
    await act(async () => window.dispatchEvent(new Event("focus")));
    bridge.docsDrive = { status: "CONNECTED", connectedEmail: "other@example.com", reason: null };
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(bridge.docsDriveStatusIds).toHaveLength(statusCalls);
    expect(container.textContent).not.toContain("Google ドキュメントを作成しました");
    expect(container.textContent).toContain("接続先のGoogleアカウントが変わりました");
    bridge.docsDrive = { status: "CONNECTED", connectedEmail: "taro@example.com", reason: null };
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(bridge.docsDriveStatusIds).toHaveLength(statusCalls + 1);
    expect(bridge.docsDriveStatusIds.at(-1)).toBe(exportId);
    expect(container.textContent).not.toContain("接続先のGoogleアカウントが変わりました");
  });

  it.each(["temporarily_unavailable", "google_docs_invalid_response"])("POSTの%s後も同じIDを先に照会する", async (code) => {
    const { bridge, container } = await connectedDoc();
    bridge.docsDriveExportResults.push({ code, message: "成立不明" });
    bridge.docsDriveStatusResults.push({ code: "export_not_found", message: "未受付" });
    await insertBody(container, "成立不明の本文");
    await openGoogleExport(container);
    await click(button(container.querySelector<HTMLElement>(".google-export-dialog")!, "書き出す"));
    expect(bridge.docsDriveStatusIds).toEqual([bridge.docsDriveExportRequests[0]!.exportId]);
  });

  it("最初の送信後はtitleを凍結し、明示的な新規書き出しだけ新しいIDにする。logoutで旧結果を消す", async () => {
    const { bridge, account, container } = await connectedDoc();
    bridge.docsDriveExportResults.push({ code: "drive_export_rejected", message: "作成できません" });
    await insertBody(container, "本文");
    await openGoogleExport(container);
    const dialog = container.querySelector<HTMLElement>(".google-export-dialog")!;
    await click(button(dialog, "書き出す"));
    const firstId = bridge.docsDriveExportRequests[0]!.exportId;
    expect((dialog.querySelector("input") as HTMLInputElement).disabled).toBe(true);
    await click(button(dialog, "新しい書き出し"));
    const confirmation = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(confirmation.textContent).toContain("作成済みの可能性があります");
    await click(button(confirmation, "新しく書き出す"));
    const restarted = container.querySelector<HTMLElement>(".google-export-dialog")!;
    await typeInto(restarted.querySelector("input")!, "別タイトル");
    await click(button(restarted, "書き出す"));
    expect(bridge.docsDriveExportRequests[1]!.exportId).not.toBe(firstId);
    expect(bridge.docsDriveExportRequests[1]!.title).toBe("別タイトル");
    bridge.docsDrive = { status: "CONNECTED", connectedEmail: "other@example.com", reason: null };
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(container.querySelector(".google-export-dialog")).not.toBeNull();
    expect(container.textContent).not.toContain("Google ドキュメントを作成しました");
    expect(container.textContent).toContain("接続先のGoogleアカウントが変わりました");
    await act(async () => account.change({ kind: "signedOut" }));
    expect(container.querySelector(".google-export-dialog")).toBeNull();
    expect(container.textContent).not.toContain("Google ドキュメントを作成しました");
  });
});
