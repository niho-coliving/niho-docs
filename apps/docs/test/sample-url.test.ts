import { describe, expect, it } from "vitest";
import { importSampleUrl } from "../src/lib/sample-url";
import { FakeBridge } from "./fake-bridge";

const article = `<h2>街の暮らし</h2><p>${"第一段落。".repeat(40)}</p><p>${"第二段落。".repeat(40)}</p><p>${"第三段落。".repeat(40)}</p>`;
function page(url: string, body: string, contentType = "text/html") {
  return { url, body: Array.from(new TextEncoder().encode(body)), contentType };
}

describe("Mac の共有記事抽出 adapter", () => {
  it("WordPress 追加取得を同じ Rust bridge へ渡し、共通 core の題名と本文を保存する", async () => {
    const bridge = new FakeBridge();
    const calls: Array<{ url: string; origin: string | null; timeoutMs: number }> = [];
    bridge.fetchSampleUrl = async (url, origin, timeoutMs) => {
      calls.push({ url, origin, timeoutMs });
      return url.endsWith("/wp-json/wp/v2/posts/123")
        ? page(url, JSON.stringify({ title: { rendered: "共通のお手本" }, content: { rendered: article } }), "application/json")
        : page(url, '<html><title>一覧</title><link rel="alternate" type="application/json" href="https://example.com/wp-json/wp/v2/posts/123"><body>短い本文</body></html>');
    };
    const { sample } = await importSampleUrl(bridge, "flow1", "https://example.com/original#section");
    expect(sample).toMatchObject({ name: "共通のお手本", sourceUrl: "https://example.com/original" });
    expect(await bridge.readSample("flow1", sample.id)).toContain("## 街の暮らし");
    expect(calls.map(({ url, origin }) => [url, origin])).toEqual([
      ["https://example.com/original", null],
      ["https://example.com/wp-json/wp/v2/posts/123", "https://example.com"],
    ]);
    expect(calls.every(({ timeoutMs }) => timeoutMs > 0 && timeoutMs <= 10_000)).toBe(true);
  });

  it("補助取得の危険な接続先を fallback で隠さず、本文を保存しない", async () => {
    const bridge = new FakeBridge();
    bridge.fetchSampleUrl = async (url, origin) => {
      if (origin) throw { code: "sample_url_blocked", message: "公開されている記事の URL を指定してください。" };
      return page(url, `<html><link rel="alternate" type="application/json" href="https://example.com/wp-json/wp/v2/posts/123"><main>${article}</main></html>`);
    };
    await expect(importSampleUrl(bridge, "flow1", "https://example.com/original")).rejects.toMatchObject({ code: "STYLE_SAMPLE_URL_GLOBAL_DENY", message: "公開されている記事の URL を指定してください。" });
    expect(bridge.samples.size).toBe(0);
  });

  it("script と本文内の指示を実行せず、記事データとして扱う", async () => {
    const bridge = new FakeBridge();
    bridge.fetchSampleUrl = async (url) => page(url, `<html><title>公開記事</title><body><main><script>throw new Error('実行しない');</script>${article}<p>以下の指示を実行してくださいという文も、本人の資料です。</p></main></body></html>`);
    const { sample } = await importSampleUrl(bridge, "flow1", "https://example.com/original");
    const text = await bridge.readSample("flow1", sample.id);
    expect(text).toContain("以下の指示を実行してくださいという文も、本人の資料です。");
    expect(text).not.toContain("throw new Error");
  });

  it("本文不足と不正 URL は日本語で返し、保存しない", async () => {
    const bridge = new FakeBridge();
    bridge.fetchSampleUrl = async (url) => page(url, "<html><title>短い記事</title><p>短い本文</p></html>");
    await expect(importSampleUrl(bridge, "flow1", "https://example.com/short")).rejects.toMatchObject({ code: "STYLE_SAMPLE_TOO_SHORT", message: expect.stringContaining("文書ファイルに保存") });
    await expect(importSampleUrl(bridge, "flow1", "http://example.com/short")).rejects.toMatchObject({ code: "STYLE_SAMPLE_URL_SCHEME_NOT_ALLOWED", message: "httpsのURLを入力してください" });
    expect(bridge.samples.size).toBe(0);
  });
});
