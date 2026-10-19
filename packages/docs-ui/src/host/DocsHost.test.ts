import { describe, expect, it } from "vitest";
import { createFakeHost } from "../testing/FakeHost";
import { controllerHost } from "./controller-host";

// Mac Bridge の完全実装を Web 側へ要求せず、省略・構造化エラー・受信先を保持する。
describe("DocsHost の境界", () => {
  it("native 操作を省略でき、未対応操作を成功扱いにしない", async () => {
    const { host, calls } = createFakeHost({ readPage: async () => "本文" });
    expect(host.revealPage).toBeUndefined();
    const bridge = controllerHost(host);
    expect(await bridge.readPage(null, "page")).toBe("本文");
    await expect(bridge.revealPage(null, "page")).rejects.toMatchObject({ code: "docs_host_unsupported", operation: "revealPage" });
    expect(calls.map((call) => call.operation)).toEqual(["readPage"]);
  });

  it.each(["vault_conflict", "export_result_unknown", "store_document_changed"])("%s を置き換えず呼び手へ返す", async (code) => {
    const error = { code, message: "確認が必要です", details: { expectedSha256: "before", currentSha256: "after" } };
    const { host } = createFakeHost({ saveOpenedDocument: async () => { throw error; } });
    await expect(controllerHost(host).saveOpenedDocument("handle", "本文")).rejects.toBe(error);
  });

  it("class の host の this とメソッドの同一性を保つ", async () => {
    class PageStore {
      markdown = "本文";
      reads = 0;
      async readPage() { this.reads++; return this.markdown; }
    }
    const store = new PageStore();
    const { host } = createFakeHost(store);
    const bridge = controllerHost(host);
    expect(bridge.readPage).toBe(bridge.readPage);
    expect(await bridge.readPage(null, "page")).toBe("本文");
    expect(store.reads).toBe(1);
    store.readPage = async () => "変更後";
    expect(await bridge.readPage(null, "page")).toBe("変更後");
  });
});
