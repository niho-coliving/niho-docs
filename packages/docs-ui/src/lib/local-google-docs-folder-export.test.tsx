// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { DocsAccount } from "../host/DocsAccount";
import { controllerHost } from "../host/controller-host";
import type { DocsDriveFolderExportPlan, DocsDriveLocalFolderExportSnapshot } from "../host/DocsHost";
import { createFakeHost } from "../testing/FakeHost";
import { GoogleDocsFolderExportDialog } from "../components/GoogleDocsFolderExport";
import type { GoogleDocsController } from "./use-google-docs";
import { useGoogleDocsFolderExport, type GoogleDocsFolderExportController } from "./use-google-docs-folder-export";
import { buildLocalFolderExportPlan, localFolderExportFiles } from "./local-google-docs-folder-export";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projectId = "folder1";
const project = {
  version: 1, id: projectId, name: "取材", createdAt: "2026-10-19T00:00:00Z",
  info: { background: "", terms: [] },
  pages: [
    { id: "first", kind: "doc", title: "一枚目", createdAt: "2026-10-19T00:00:00Z" },
    { id: "second", kind: "doc", title: "二枚目", createdAt: "2026-10-19T00:00:00Z" },
  ],
};
const texts = { "project.json": JSON.stringify(project),
  "pages/first.md": "一枚目の本文\n![写真](niho-docs-asset:photo.png)",
  "pages/second.md": "二枚目の本文" };
const snapshot: DocsDriveLocalFolderExportSnapshot = {
  generation: 7,
  texts,
  files: [...Object.entries(texts).map(([path, value]) => ({ path, bytes: new TextEncoder().encode(value).length,
    sha256: "a".repeat(64) })), { path: "assets/photo.png", bytes: 3, sha256: "b".repeat(64) }],
};
const server: DocsDriveFolderExportPlan = { available: true, projectId, revision: 0, title: "", nodes: [],
  limits: { maxTabs: 100, maxChars: 1_000_000 }, latest: null };
const account: DocsAccount = {
  state: { kind: "signedIn", profile: { userId: "user1", displayName: "本人", handle: null,
    avatarPath: null, connectionId: "connection1" } },
  avatarSrc: null, busy: null, notice: null, dismissNotice() {}, async beginLogin() {},
  async cancelLogin() {}, async logout() { return true; }, async openMyPage() {},
};
const googleDocs = {
  connection: { status: "CONNECTED", connectedEmail: "person@example.com" },
  connectionLoading: false, connectionError: null, refreshConnection: async () => {},
} as GoogleDocsController;

afterEach(() => { document.body.innerHTML = ""; });

describe("この Mac だけのフォルダ書き出し", () => {
  it("選んだページの本文と写真だけを一時送信対象にし、欠けたファイルを拒否する", async () => {
    const prepared = await buildLocalFolderExportPlan(snapshot, server, async (file) => texts[file.path as keyof typeof texts]);
    expect(prepared.plan.nodes.map((node) => node.key)).toEqual(["doc:first", "doc:second"]);
    expect(localFolderExportFiles(prepared, ["doc:first"]).map((file) => file.path))
      .toEqual(["project.json", "pages/first.md", "assets/photo.png"]);
    expect(() => localFolderExportFiles({ ...prepared, snapshot: { ...snapshot,
      files: snapshot.files.filter((file) => file.path !== "pages/first.md") } }, ["doc:first"]))
      .toThrow("folder_changed");
  });

  it("未選択の本文が合計16MiBを超えても小さいページを選べる", async () => {
    const large = "あ".repeat(6 * 1024 * 1024); // UTF-8 で 18 MiB
    const largeSnapshot: DocsDriveLocalFolderExportSnapshot = {
      generation: 8,
      texts: { "project.json": JSON.stringify(project) },
      files: snapshot.files.map((file) => file.path === "pages/first.md"
        ? { ...file, bytes: new TextEncoder().encode(large).length } : file),
    };
    const prepared = await buildLocalFolderExportPlan(largeSnapshot, server,
      async (file) => file.path === "pages/first.md" ? large : texts[file.path as keyof typeof texts]);
    expect(prepared.snapshot.texts).toEqual({ "project.json": JSON.stringify(project) });
    expect(localFolderExportFiles(prepared, ["doc:second"]).map((file) => file.path))
      .toEqual(["project.json", "pages/second.md"]);
  });

  it("LOCAL の木と選択内容を Mac の送信経路へ渡し、説明を一度だけ表示する", async () => {
    const { host, calls } = createFakeHost({
      docsDriveFolderExportLocalSnapshot: async () => snapshot,
      docsDriveFolderExportLocalText: async (_projectId, _generation, file) => texts[file.path as keyof typeof texts],
      docsDriveFolderExportLocalPlan: async () => server,
      docsDriveFolderExportLocal: async (request) => ({ exportId: request.exportId,
        createdAt: "2026-10-19T00:00:00Z", status: "completed", documentId: "document1",
        url: "https://docs.google.com/document/d/document1/edit", imagesSkipped: 0 }),
    });
    const bridge = controllerHost(host);
    let controller: GoogleDocsFolderExportController | null = null;
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    function Harness() {
      controller = useGoogleDocsFolderExport({ bridge, account, googleDocs, local: true,
        onOpenSettings() {}, syncState: () => "settled", refreshSync() {}, defaultTimestamps: false });
      return <GoogleDocsFolderExportDialog controller={controller} />;
    }
    try {
      await act(async () => { root.render(<Harness />); });
      await act(async () => { controller!.open({ projectId, folderName: "取材" }); });
      expect(controller!.state.planStatus).toBe("loaded");
      expect(container.textContent?.split("書き出しの間、選んだページをクラウドに一時的に置きます")).toHaveLength(2);
      expect(container.textContent).not.toContain("クラウドに保存しているフォルダだけ");
      await act(async () => { controller!.toggle("doc:second", false); });
      await act(async () => { await controller!.submit(); });
      expect(calls.filter((call) => call.operation === "docsDriveFolderExportLocal").map((call) => call.args.slice(1)))
        .toEqual([[7, snapshot.files.filter((file) => file.path !== "pages/second.md")]]);
      expect(calls.some((call) => call.operation === "docsDriveFolderExport" || call.operation === "docsDriveFolderExportPlan"))
        .toBe(false);
    } finally { await act(async () => root.unmount()); }
  });
});
