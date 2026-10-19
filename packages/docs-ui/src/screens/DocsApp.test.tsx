// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { DocsApp } from "./DocsApp";
import { createFakeHost } from "../testing/FakeHost";
import type { DocsAccount } from "../host/DocsAccount";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const account: DocsAccount = {
  state: { kind: "signedOut" }, avatarSrc: null, busy: null, notice: null,
  dismissNotice() {}, async beginLogin() {}, async cancelLogin() {}, async logout() { return true; }, async openMyPage() {},
};
afterEach(() => { document.body.innerHTML = ""; });

describe("共通画面の独立起動", () => {
  it("Tauri・HTTP・Mac 操作なしでホームを描く", async () => {
    const { host, calls } = createFakeHost({
      capabilities: { desktopWindow: false, localExecution: false, flowDesign: true, nativeRecording: false, fileReveal: false, updates: false },
      loadSettings: async () => ({}),
      listFlows: async () => ({ flows: [], order: [], lastUsed: null }),
      loadRecent: async () => [], loadAbout: async () => null,
      listProjects: async () => [],
      loadPages: async () => ({ projectId: null, project: null, pages: [], recordings: [], docs: [] }),
      accountAvailable: async () => true,
    });
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<DocsApp bridge={host} account={account} />); });
      expect(container.querySelector("[data-docs-app-root] .rail")).not.toBeNull();
      expect(container.textContent).toContain("最近");
      expect(container.textContent).not.toContain("前回の録音を確認できませんでした");
      expect(calls.some((call) => call.operation === "appPaths" || call.operation === "leftoverRecordings" || /^(cloud|onCloud)/.test(call.operation))).toBe(false);
    } finally { await act(async () => root.unmount()); }
  });

  it("Mac の同期状態が無くても前回の文書を開く", async () => {
    const page = { id: "page-1", kind: "doc" as const, title: "前回の文書", createdAt: "2026-10-18T00:00:00Z" };
    const { host, calls } = createFakeHost({
      capabilities: { desktopWindow: false, localExecution: false, flowDesign: true, nativeRecording: false, fileReveal: false, updates: false, cloudSync: false },
      loadSettings: async () => ({}),
      listFlows: async () => ({ flows: [], order: [], lastUsed: null }),
      loadRecent: async () => [{ projectId: null, pageId: page.id, openedAt: page.createdAt }],
      loadAbout: async () => null, listProjects: async () => [],
      loadPages: async () => ({ projectId: null, project: null, pages: [page], recordings: [], docs: [{ id: page.id, updatedMs: 0 }] }),
      readPage: async () => "前回の本文",
      openPageDocument: async () => ({ handle: "page-handle", contextGeneration: 1, scopeId: "browser", markdown: "前回の本文", sha256: null }),
      releaseOpenedDocument: async () => {},
      listConversations: async () => [],
      accountAvailable: async () => true,
    });
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(<DocsApp bridge={host} account={account} />); });
      expect(container.querySelector<HTMLTextAreaElement>('[aria-label="タイトル"]')?.value).toBe("前回の文書");
      expect(container.querySelector(".ProseMirror")?.textContent).toContain("前回の本文");
      expect(calls.some((call) => /^(cloud|onCloud)/.test(call.operation))).toBe(false);
    } finally { await act(async () => root.unmount()); }
  });

});
