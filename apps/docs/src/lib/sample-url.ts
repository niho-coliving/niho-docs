/** NIHO アプリと同じ抽出 core を利用する、Mac の安全取得・保存 adapter。 */
import {
  ArticleStyleSampleImportError,
  decodeResponseBody,
  importArticleStyleSample,
  normalizeArticleStyleSampleImportUrl,
  remainingImportTime,
} from "../../../../packages/article-style-sample-core/index";
import { isCommandError, type Bridge } from "niho-docs-ui/host/DocsHost";

function fetchError(error: unknown): never {
  if (!isCommandError(error)) throw error;
  // 共有 core は安全境界・期限のエラーを HTML fallback で隠さない。
  const code = error.code === "sample_url_blocked" ? "STYLE_SAMPLE_URL_GLOBAL_DENY"
    : error.code === "sample_url_timeout" ? "STYLE_SAMPLE_IMPORT_TIMEOUT"
      : error.code === "sample_url_origin" ? "STYLE_SAMPLE_REST_CROSS_ORIGIN_REDIRECT" : error.code;
  throw new ArticleStyleSampleImportError({ code, status: error.code === "sample_url_timeout" ? 408 : 409, message: error.message, publicMessage: error.message });
}

export async function importSampleUrl(bridge: Bridge, flowId: string, raw: string) {
  try {
    const url = normalizeArticleStyleSampleImportUrl(raw);
    const result = await importArticleStyleSample({
      url,
      fetchPage: async ({ sourceUrl, sameOriginRedirectOnly, deadlineAt }) => {
        const page = await bridge.fetchSampleUrl(sourceUrl, sameOriginRedirectOnly ?? null, remainingImportTime(deadlineAt)).catch(fetchError);
        const response = new Response(null, { headers: { "content-type": page.contentType } });
        return { url: page.url, body: decodeResponseBody(response, new Uint8Array(page.body)), response, contentType: page.contentType.split(";")[0]!.trim().toLowerCase() };
      },
    });
    const sample = await bridge.saveSampleUrl(flowId, url, result.label, result.markdown);
    return { sample, warnings: result.warnings };
  } catch (error) {
    if (error instanceof ArticleStyleSampleImportError) throw { code: error.code, message: error.publicMessage.replace(/Markdownで本文を貼り付けてください/g, "本文を文書ファイルに保存して追加してください") };
    throw error;
  }
}
