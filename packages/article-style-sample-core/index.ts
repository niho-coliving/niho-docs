/**
 * NIHO アプリと NIHO docs が共用する記事お手本の抽出 core（#18664）。
 * Node・DOM・Tauri に依存しない。HTML は文字列としてのみ解析し、取得は必ず注入した fetchPage を通す。
 * Docs はこの TS source を bundle する。API 側の参照切り替えは統合 PR で行う。
 */
export const ARTICLE_STYLE_SAMPLE_IMPORT_MAX_URL_CHARS = 2048;
export const ARTICLE_STYLE_SAMPLE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const ARTICLE_STYLE_SAMPLE_IMPORT_TIMEOUT_MS = 10_000;
export const ARTICLE_STYLE_SAMPLE_IMPORT_MAX_REDIRECTS = 4;
export const ARTICLE_STYLE_SAMPLE_IMPORT_MAX_MARKDOWN_CHARS = 50_000;
export const ARTICLE_STYLE_SAMPLE_EXTRACTORS = [
  "wordpress-rest",
  "wordpress-html",
  "wix-blog",
  "wix-page",
  "studio-nuxt",
  "readability",
  "json-ld",
  "embedded-json",
  "rss",
  "amp",
] as const;

export type ArticleStyleSampleExtractor = (typeof ARTICLE_STYLE_SAMPLE_EXTRACTORS)[number];

export type ArticleStyleSampleImportStats = {
  chars: number;
  headings: number;
  images: number;
  quotes: number;
};

export type ArticleStyleSampleImportResult = {
  label: string;
  markdown: string;
  sourceUrl: string;
  extractor: ArticleStyleSampleExtractor;
  stats: ArticleStyleSampleImportStats;
  /** UIへそのまま表示できる日本語の注意書き。内部識別子は返さない。 */
  warnings: string[];
};

/**
 * URL取り込みの各抽出器が共有する入力。抽出器は副作用を持たず、必要な
 * alternate/REST取得だけを `extract` 内で `fetchPage` 経由に限定する。
 */
export type ArticleStyleSampleExtractorContext = {
  page: FetchedPage;
  rawHtml: string;
  title: string;
  deadlineAt: number;
  /** 追加取得も呼び出し元の安全な transport だけを通す。 */
  fetchPage: ArticleSampleFetchPage;
};

export type ArticleStyleSampleExtractorCandidate = {
  title?: string | null;
  markdown: string;
  sourceUrl?: string;
  warnings?: string[];
};

/** #15855 の抽出器契約。registry差し替えで品質ゲート/fallbackを単体検証できる。 */
export type ArticleStyleSampleExtractorDefinition = {
  id: ArticleStyleSampleExtractor;
  detect: (context: ArticleStyleSampleExtractorContext) => boolean;
  extract: (
    context: ArticleStyleSampleExtractorContext,
  ) => ArticleStyleSampleExtractorCandidate | null | Promise<ArticleStyleSampleExtractorCandidate | null>;
};

export class ArticleStyleSampleImportError extends Error {
  readonly code: string;
  readonly status: 400 | 408 | 409 | 413 | 415 | 429 | 502;
  readonly publicMessage: string;

  constructor(params: {
    code: string;
    status: 400 | 408 | 409 | 413 | 415 | 429 | 502;
    message: string;
    publicMessage?: string;
  }) {
    super(params.message);
    this.name = "ArticleStyleSampleImportError";
    this.code = params.code;
    this.status = params.status;
    this.publicMessage = params.publicMessage ?? params.message;
  }
}

function importDeadlineError(): ArticleStyleSampleImportError {
  return importError(
    "STYLE_SAMPLE_IMPORT_TIMEOUT",
    408,
    "style sample import exceeded its deadline",
    "記事の読み込みがタイムアウトしました。しばらく待ってから再試行してください",
  );
}

export function remainingImportTime(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw importDeadlineError();
  return remaining;
}

export async function withImportDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  const timeoutMs = remainingImportTime(deadlineAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(importDeadlineError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function importError(
  code: string,
  status: ArticleStyleSampleImportError["status"],
  message: string,
  publicMessage = message,
): ArticleStyleSampleImportError {
  return new ArticleStyleSampleImportError({ code, status, message, publicMessage });
}

export function normalizeArticleStyleSampleImportUrl(value: string): string {
  if (typeof value !== "string") {
    throw importError("STYLE_SAMPLE_URL_INVALID", 400, "style sample URL is not a string", "記事URLを確認してください");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > ARTICLE_STYLE_SAMPLE_IMPORT_MAX_URL_CHARS) {
    throw importError(
      "STYLE_SAMPLE_URL_INVALID",
      400,
      "style sample URL is empty or too long",
      `記事URLは${ARTICLE_STYLE_SAMPLE_IMPORT_MAX_URL_CHARS}文字以内で入力してください`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw importError("STYLE_SAMPLE_URL_INVALID", 400, "style sample URL is invalid", "記事URLを確認してください");
  }
  if (parsed.protocol !== "https:") {
    throw importError("STYLE_SAMPLE_URL_SCHEME_NOT_ALLOWED", 400, "style sample URL is not https", "httpsのURLを入力してください");
  }
  if (parsed.username || parsed.password) {
    throw importError("STYLE_SAMPLE_URL_CREDENTIALS_NOT_ALLOWED", 400, "style sample URL contains credentials", "認証情報付きのURLは読み取れません");
  }
  parsed.hash = "";
  const normalized = parsed.toString();
  if (normalized.length > ARTICLE_STYLE_SAMPLE_IMPORT_MAX_URL_CHARS) {
    throw importError(
      "STYLE_SAMPLE_URL_INVALID",
      400,
      "normalized style sample URL is too long",
      `記事URLは${ARTICLE_STYLE_SAMPLE_IMPORT_MAX_URL_CHARS}文字以内で入力してください`,
    );
  }
  return normalized;
}

export type FetchedPage = {
  url: string;
  response: Response;
  body: string;
  contentType: string;
};

function declaredResponseCharset(response: Response, bytes: Uint8Array): string {
  const contentType = response.headers.get("content-type") ?? "";
  const fromHeader = /charset\s*=\s*["']?([^;\s"']+)/iu.exec(contentType)?.[1];
  if (fromHeader) return fromHeader;

  // HTML/XMLの宣言は最初の数KBだけをUTF-8として読めば十分に検出できる。
  const prefix = new TextDecoder("utf-8").decode(bytes.subarray(0, 16 * 1024));
  const fromMetaCharset = /<meta\b[^>]*charset\s*=\s*["']?([^\s"'/>]+)/iu.exec(prefix)?.[1];
  const fromMetaContent = /<meta\b[^>]*content\s*=\s*["'][^"']*?charset\s*=\s*([^;\s"']+)/iu.exec(prefix)?.[1];
  return (
    fromMetaCharset
    ?? fromMetaContent
    ?? /<\?xml\b[^>]*encoding\s*=\s*["']([^"']+)["']/iu.exec(prefix)?.[1]
    ?? "utf-8"
  );
}

export function decodeResponseBody(response: Response, bytes: Uint8Array): string {
  const charset = declaredResponseCharset(response, bytes).trim();
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // 宣言が未知でもUTF-8での抽出を試み、取得そのものは失敗扱いにしない。
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** 初回・WordPress REST・AMP・RSS が共有する環境別の安全取得 adapter。 */
export type ArticleSampleFetchPage = (params: {
  sourceUrl: string;
  sameOriginRedirectOnly?: string;
  deadlineAt: number;
}) => Promise<FetchedPage>;

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  };
  return value
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, token: string) => {
      if (token.toLowerCase().startsWith("#x")) {
        const code = Number.parseInt(token.slice(2), 16);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      if (token.startsWith("#")) {
        const code = Number.parseInt(token.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return named[token.toLowerCase()] ?? match;
    });
}

function htmlAttribute(attributes: string, name: string): string {
  const pattern = new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = pattern.exec(attributes);
  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalizeText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function imagePlaceholder(attributes: string): string {
  const alt = htmlAttribute(attributes, "alt").trim();
  const looksLikeFilename = /^(?:img[_-]?\d+|dsc[_-]?\d+|pxl[_-]?\d+|image[_-]?\d+|photo[_-]?\d+|[^\s/]+\.(?:jpe?g|png|gif|webp|svg))$/i.test(alt);
  return looksLikeFilename || !alt ? "[画像]" : `[画像: ${alt}]`;
}

type ParsedHtmlNode =
  | { kind: "text"; value: string }
  | { kind: "element"; tag: string; attributes: string; children: ParsedHtmlNode[] };

const VOID_HTML_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const IGNORED_HTML_TAGS = new Set(["script", "style", "nav", "footer", "header", "aside", "form", "noscript", "template", "head", "iframe", "svg", "canvas", "object", "embed"]);
const BLOCK_HTML_TAGS = new Set(["address", "article", "blockquote", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "li", "main", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"]);

function parseHtmlFragment(rawHtml: string): ParsedHtmlNode[] {
  const root: Extract<ParsedHtmlNode, { kind: "element" }> = { kind: "element", tag: "__root__", attributes: "", children: [] };
  const stack: Array<Extract<ParsedHtmlNode, { kind: "element" }>> = [root];
  const tokenPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>|[^<]+/g;
  for (const tokenMatch of rawHtml.matchAll(tokenPattern)) {
    const token = tokenMatch[0] ?? "";
    if (!token || /^<!--|^<!/u.test(token)) continue;
    if (/^<\//u.test(token)) {
      const closingTag = /^<\/\s*([A-Za-z][\w:-]*)/u.exec(token)?.[1]?.toLowerCase();
      if (!closingTag) continue;
      const matchingIndex = [...stack].reverse().findIndex((node) => node.tag === closingTag);
      if (matchingIndex >= 0) stack.splice(stack.length - 1 - matchingIndex);
      continue;
    }
    if (/^</u.test(token)) {
      const opening = /^<\s*([A-Za-z][\w:-]*)([\s\S]*?)>$/u.exec(token);
      if (!opening) continue;
      const tag = opening[1]!.toLowerCase();
      const attributes = opening[2] ?? "";
      // HTML では次の段落・block の開始が閉じ忘れた p を閉じる。古い記事の隠し p が本文全体を包まないようにする。
      if (BLOCK_HTML_TAGS.has(tag) && !stack.some((parent) => ["script", "style", "noscript", "template"].includes(parent.tag))) {
        const openParagraph = stack.map((parent) => parent.tag).lastIndexOf("p");
        if (openParagraph > 0) stack.splice(openParagraph);
      }
      const node: Extract<ParsedHtmlNode, { kind: "element" }> = { kind: "element", tag, attributes, children: [] };
      stack[stack.length - 1]!.children.push(node);
      if (!/\/\s*>$/u.test(token) && !VOID_HTML_TAGS.has(tag)) {
        if (stack.length >= 256) throw importError("STYLE_SAMPLE_BODY_NOT_FOUND", 409, "HTML nesting is too deep", "記事本文の構造を読み取れませんでした。文書ファイルに保存して追加してください");
        stack.push(node);
      }
      continue;
    }
    stack[stack.length - 1]!.children.push({ kind: "text", value: token });
  }
  return root.children;
}

function ignoredNode(node: Extract<ParsedHtmlNode, { kind: "element" }>): boolean {
  if (IGNORED_HTML_TAGS.has(node.tag)) return true;
  const style = htmlAttribute(node.attributes, "style").toLowerCase().replace(/\s/g, "");
  const classes = htmlAttribute(node.attributes, "class").split(/\s+/);
  return /(?:^|\s)hidden(?:\s|=|$)/i.test(node.attributes)
    || htmlAttribute(node.attributes, "aria-hidden").toLowerCase() === "true"
    || style.includes("display:none") || style.includes("visibility:hidden")
    || htmlAttribute(node.attributes, "id").toLowerCase() === "profile"
    || classes.some((name) => /^(?:pager|pagination|breadcrumbs?)$/i.test(name));
}

function renderInlineNode(node: ParsedHtmlNode): string {
  if (node.kind === "text") return decodeHtmlEntities(node.value).replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ");
  if (ignoredNode(node)) return "";
  if (node.tag === "img") return imagePlaceholder(node.attributes);
  if (node.tag === "br") return "\n";
  if (node.tag === "a") {
    const text = renderInlineNodes(node.children).replace(/\s+/g, " ").trim();
    const href = htmlAttribute(node.attributes, "href");
    if (!text) return "";
    return href && /^https:\/\//i.test(href) ? `[${text}](${href})` : text;
  }
  const inner = renderInlineNodes(node.children).trim();
  if (!inner) return "";
  if (node.tag === "strong" || node.tag === "b") return `**${inner}**`;
  if (node.tag === "em" || node.tag === "i") return `*${inner}*`;
  return inner;
}

function renderInlineNodes(nodes: ParsedHtmlNode[]): string {
  return nodes.map((node) => renderInlineNode(node)).join("");
}

function blockMarkdown(value: string): string {
  const normalized = value.trim();
  return normalized ? `\n\n${normalized}\n\n` : "";
}

function renderBlockChildren(nodes: ParsedHtmlNode[]): string {
  const blocks: string[] = [];
  let inlineRun: ParsedHtmlNode[] = [];
  const flushInline = () => {
    const inline = renderInlineNodes(inlineRun).trim();
    if (inline) blocks.push(inline);
    inlineRun = [];
  };
  for (const node of nodes) {
    if (node.kind === "element" && ignoredNode(node)) {
      flushInline();
      continue;
    }
    if (node.kind === "element" && BLOCK_HTML_TAGS.has(node.tag)) {
      flushInline();
      const rendered = renderBlockNode(node).trim();
      if (rendered) blocks.push(rendered);
    } else {
      inlineRun.push(node);
    }
  }
  flushInline();
  return blocks.join("\n\n");
}

function renderListNode(node: Extract<ParsedHtmlNode, { kind: "element" }>): string {
  const ordered = node.tag === "ol";
  const items = node.children.filter((child): child is Extract<ParsedHtmlNode, { kind: "element" }> => child.kind === "element" && child.tag === "li");
  const lines = items.map((item, index) => {
    const marker = ordered ? `${index + 1}.` : "-";
    const body = renderBlockChildren(item.children).replace(/\n{2,}/g, "\n").trim();
    return body ? `${marker} ${body}` : "";
  }).filter(Boolean);
  return blockMarkdown(lines.join("\n"));
}

function renderBlockNode(node: ParsedHtmlNode): string {
  if (node.kind === "text") return renderInlineNode(node);
  if (ignoredNode(node)) return "";
  if (/^h[1-6]$/u.test(node.tag)) {
    const level = Number(node.tag.slice(1));
    return blockMarkdown(`${"#".repeat(level)} ${renderInlineNodes(node.children).trim()}`);
  }
  if (node.tag === "blockquote") {
    const body = renderBlockChildren(node.children).trim();
    return body ? blockMarkdown(body.split(/\n+/u).map((line) => `> ${line.trim()}`).join("\n")) : "";
  }
  if (node.tag === "ul" || node.tag === "ol") return renderListNode(node);
  if (node.tag === "figcaption") {
    const caption = renderInlineNodes(node.children).trim();
    return caption ? blockMarkdown(`*${caption}*`) : "";
  }
  if (node.tag === "figure") return blockMarkdown(renderBlockChildren(node.children));
  if (BLOCK_HTML_TAGS.has(node.tag)) return renderBlockChildren(node.children);
  return renderInlineNodes(node.children);
}

function renderHtmlToMarkdown(rawHtml: string): string {
  const markdown = renderBlockChildren(parseHtmlFragment(rawHtml));
  return normalizeText(markdown)
    .split(/\n/u)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** テストとlive probeが抽出結果の構造を確認するための副作用なし変換。 */
export function renderArticleStyleSampleHtmlToMarkdownForTest(rawHtml: string): string {
  return renderHtmlToMarkdown(rawHtml);
}

function extractTitle(rawHtml: string, body?: string): string {
  const candidates = [
    /<meta\b[^>]*(?:property|name)=["'](?:og:title|twitter:title)["'][^>]*content=["']([^"']*)["'][^>]*>/i.exec(rawHtml)?.[1],
    /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(rawHtml)?.[1],
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(rawHtml)?.[1],
    body?.split(/\n+/).find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, ""),
  ];
  return normalizeText(candidates.find((candidate) => candidate?.trim()) ?? "記事").slice(0, 100) || "記事";
}

function extractHook(rawHtml: string, hook: string): string | null {
  return extractAttributeElement(rawHtml, "data-hook", hook);
}

function extractAttributeElement(rawHtml: string, attribute: string, value: string): string | null {
  const openingTags = /<([a-z][\w:-]*)\b([^>]*)>/gi;
  for (const match of rawHtml.matchAll(openingTags)) {
    const tagName = match[1] ?? "";
    const attributes = match[2] ?? "";
    if (htmlAttribute(attributes, attribute).toLowerCase() !== value.toLowerCase()) continue;

    const contentStart = (match.index ?? 0) + match[0].length;
    const tagPattern = new RegExp(`<\\/?${tagName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b[^>]*>`, "gi");
    tagPattern.lastIndex = contentStart;
    let depth = 1;
    let token: RegExpExecArray | null;
    while ((token = tagPattern.exec(rawHtml))) {
      const tokenText = token[0] ?? "";
      if (/^<\//u.test(tokenText)) {
        depth -= 1;
        if (depth === 0) return rawHtml.slice(contentStart, token.index);
      } else if (!/\/\s*>$/u.test(tokenText)) {
        depth += 1;
      }
    }
    return rawHtml.slice(contentStart);
  }
  return null;
}

function looksLikeWixPage(rawHtml: string): boolean {
  return /(?:wixstatic\.com|wix\.com|wixsite\.com|data-mesh-id|data-wix-)/i.test(rawHtml)
    || /<meta\b[^>]*(?:name|property)=["']generator["'][^>]*content=["'][^"']*wix[^"']*["']/i.test(rawHtml);
}

function extractJsonLdBodies(rawHtml: string): string[] {
  return [...rawHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => /application\/ld\+json/i.test(match[1] ?? ""))
    .map((match) => (match[2] ?? "").trim())
    .filter(Boolean);
}

function parseJsonSafely(value: string): unknown {
  try {
    return JSON.parse(value.replace(/^[\uFEFF\s]+/, ""));
  } catch {
    return null;
  }
}

function walkJsonStrings(value: unknown, depth = 0, output: string[] = []): string[] {
  if (depth > 12 || output.length >= 1000) return output;
  if (typeof value === "string") {
    const candidate = normalizeText(value);
    if (candidate.length >= 120 && /[。！？.!?]/.test(candidate)) output.push(candidate);
    return output;
  }
  if (Array.isArray(value)) {
    for (const child of value) walkJsonStrings(child, depth + 1, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) walkJsonStrings(child, depth + 1, output);
  }
  return output;
}

function findJsonField(value: unknown, keys: ReadonlySet<string>, depth = 0): string | null {
  if (depth > 10 || value == null) return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findJsonField(child, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key.toLowerCase()) && typeof child === "string" && normalizeText(child).length >= 80) return child;
    const found = findJsonField(child, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractJsonLd(rawHtml: string): { title: string | null; body: string | null } {
  for (const raw of extractJsonLdBodies(rawHtml)) {
    const parsed = parseJsonSafely(raw);
    const body = findJsonField(parsed, new Set(["articlebody", "text"]));
    if (body) return { title: findJsonField(parsed, new Set(["headline", "name"])), body };
  }
  return { title: null, body: null };
}

function extractEmbeddedJson(rawHtml: string): { title: string | null; body: string | null } {
  const scripts = [...rawHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const candidateScripts = scripts.filter((match) => /(?:__NEXT_DATA__|__NUXT_DATA__|application\/json|data-state|data-page)/i.test(match[1] ?? "") || /__(?:NEXT|NUXT)_DATA__/.test(match[0] ?? ""));
  let longest = "";
  let title: string | null = null;
  for (const script of candidateScripts) {
    const parsed = parseJsonSafely(script[2] ?? "");
    if (!parsed) continue;
    const body = findJsonField(parsed, new Set(["articlebody", "body", "content", "description", "html", "text"]));
    const strings = walkJsonStrings(parsed);
    const chosen = [body, ...strings].filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length)[0] ?? "";
    if (chosen.length > longest.length) {
      longest = chosen;
      title = findJsonField(parsed, new Set(["title", "headline", "name"]));
    }
  }
  return { title, body: longest || null };
}

type StudioNuxtCandidate = { value: string; priority: number };

function collectStudioNuxtCandidates(value: unknown, keyHint = "", depth = 0, output: StudioNuxtCandidate[] = []): StudioNuxtCandidate[] {
  if (depth > 14 || output.length >= 1000) return output;
  if (typeof value === "string") {
    const candidate = value.trim();
    if (candidate.length >= 80 && /[。！？.!?]/u.test(candidate)) {
      const articleField = /(?:article|body|content|post|rich|description|html)/iu.test(keyHint);
      const structuredHtml = /<(?:p|h2|h3)\b/i.test(candidate);
      output.push({ value: candidate, priority: (articleField ? 1_000_000 : 0) + (structuredHtml ? 100_000 : 0) + candidate.length });
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectStudioNuxtCandidates(child, keyHint, depth + 1, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectStudioNuxtCandidates(child, key, depth + 1, output);
    }
  }
  return output;
}

function looksLikeStudioNuxt(rawHtml: string): boolean {
  return /(?:studio-cms-assets|studiodesignapp)/i.test(rawHtml)
    && /<script\b[^>]*(?:id=["']__NUXT_DATA__["']|data-nuxt-data)[^>]*>/i.test(rawHtml);
}

function extractStudioNuxtCandidates(rawHtml: string): string[] {
  if (!looksLikeStudioNuxt(rawHtml)) return [];
  const nuxt = /<script\b[^>]*(?:id=["']__NUXT_DATA__["']|data-nuxt-data)[^>]*>([\s\S]*?)<\/script>/i.exec(rawHtml);
  if (!nuxt?.[1]) return [];
  const parsed = parseJsonSafely(nuxt[1]);
  return collectStudioNuxtCandidates(parsed)
    .sort((left, right) => right.priority - left.priority)
    .map((candidate) => candidate.value);
}

function extractRss(params: { rawHtml: string; targetUrl: string; feedUrl: string }): { title: string | null; body: string | null } {
  let normalizedTarget: string;
  try {
    normalizedTarget = normalizeArticleStyleSampleImportUrl(params.targetUrl);
  } catch {
    return { title: null, body: null };
  }
  const items = [...params.rawHtml.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)];
  for (const match of items) {
    const item = match[1] ?? "";
    const linkedValues = [
      ...[...item.matchAll(/<link\b([^>]*)>([\s\S]*?)<\/link>/gi)].map((link) => stripTags(link[2] ?? "")),
      ...[...item.matchAll(/<link\b([^>]*)\/?>/gi)].map((link) => htmlAttribute(link[1] ?? "", "href")),
      ...[...item.matchAll(/<(?:guid|id)\b[^>]*>([\s\S]*?)<\/(?:guid|id)>/gi)].map((link) => stripTags(link[1] ?? "")),
    ];
    const matchesTarget = linkedValues.some((value) => {
      try {
        return normalizeArticleStyleSampleImportUrl(new URL(value, params.feedUrl).toString()) === normalizedTarget;
      } catch {
        return false;
      }
    });
    if (!matchesTarget) continue;
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(item)?.[1] ?? null;
    const body = /<(?:content:encoded|content|description|summary)\b[^>]*>([\s\S]*?)<\/(?:content:encoded|content|description|summary)>/i.exec(item)?.[1]
      ?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1") ?? null;
    return { title: stripTags(title ?? "") || null, body };
  }
  return { title: null, body: null };
}

type AlternateKind = "rss" | "amp";

function linkAttributes(rawHtml: string): string[] {
  return [...rawHtml.matchAll(/<link\b([^>]*)>/gi)].map((match) => match[1] ?? "");
}

function hasRelToken(attributes: string, token: string): boolean {
  return htmlAttribute(attributes, "rel").split(/\s+/u).some((value) => value.toLowerCase() === token.toLowerCase());
}

function normalizeLinkedUrl(href: string, sourceUrl: string): string | null {
  if (!href) return null;
  try {
    return normalizeArticleStyleSampleImportUrl(new URL(href, sourceUrl).toString());
  } catch {
    return null;
  }
}

function extractSameOriginAlternateLink(rawHtml: string, sourceUrl: string, kind: AlternateKind): string | null {
  const sourceOrigin = new URL(sourceUrl).origin;
  for (const attributes of linkAttributes(rawHtml)) {
    const rel = htmlAttribute(attributes, "rel").toLowerCase().split(/\s+/u);
    const type = htmlAttribute(attributes, "type").toLowerCase().split(";", 1)[0]?.trim() ?? "";
    const isRss = kind === "rss" && (type === "application/rss+xml" || type === "application/atom+xml" || /(?:rss|atom)/u.test(type));
    const isAmp = kind === "amp" && (rel.includes("amphtml") || /amp(?:\+|-)?html/u.test(type));
    if (!isRss && !isAmp) continue;
    if (kind === "rss" && !rel.includes("alternate")) continue;
    if (kind === "amp" && !rel.includes("alternate") && !rel.includes("amphtml")) continue;
    const candidate = normalizeLinkedUrl(htmlAttribute(attributes, "href"), sourceUrl);
    if (!candidate || new URL(candidate).origin !== sourceOrigin) continue;
    return candidate;
  }
  return null;
}

function hasWordpressGeneratorMeta(rawHtml: string): boolean {
  return [...rawHtml.matchAll(/<meta\b([^>]*)>/gi)].some((match) => {
    const attributes = match[1] ?? "";
    const name = htmlAttribute(attributes, "name").toLowerCase();
    const property = htmlAttribute(attributes, "property").toLowerCase();
    return (name === "generator" || property === "generator") && /wordpress/i.test(htmlAttribute(attributes, "content"));
  });
}

function looksLikeWordpress(rawHtml: string, sourceUrl: string): boolean {
  return /\b(?:wp-content|wp-includes)\b/i.test(rawHtml)
    || /https:\/\/api\.w\.org\//i.test(rawHtml)
    || /\/wp-json\/wp\/v2\/(?:posts|pages)(?:\/|[?"'])/i.test(rawHtml)
    || hasWordpressGeneratorMeta(rawHtml)
    || /(?:^|\/)wp-(?:json|v2)(?:\/|$)/i.test(sourceUrl);
}

function extractWpRestLink(rawHtml: string, sourceUrl: string): string | null {
  // WordPressが出す direct post/pages REST URLを最優先する。
  for (const attrs of linkAttributes(rawHtml)) {
    const type = htmlAttribute(attrs, "type").toLowerCase().split(";", 1)[0]?.trim() ?? "";
    if (!hasRelToken(attrs, "alternate") || type !== "application/json") continue;
    const candidate = normalizeLinkedUrl(htmlAttribute(attrs, "href"), sourceUrl);
    if (candidate && /\/wp-json\/wp\/v2\/(?:posts|pages)(?:\/|$)/i.test(new URL(candidate).pathname)) return candidate;
  }

  for (const attrs of linkAttributes(rawHtml)) {
    if (!/https:\/\/api\.w\.org\//i.test(htmlAttribute(attrs, "rel"))) continue;
    const candidate = normalizeLinkedUrl(htmlAttribute(attrs, "href"), sourceUrl);
    if (!candidate) continue;
    const parsedCandidate = new URL(candidate);
    if (/\/wp-json\/?$/i.test(parsedCandidate.pathname)) {
      const article = new URL(sourceUrl);
      const slug = article.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.[a-z0-9]+$/i, "");
      if (slug) return `${parsedCandidate.origin}${parsedCandidate.pathname.replace(/\/$/, "")}/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=title,content,link`;
    }
    return candidate;
  }

  if (looksLikeWordpress(rawHtml, sourceUrl)) {
    const parsed = new URL(sourceUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const slug = segments.at(-1)?.replace(/\.[a-z0-9]+$/i, "");
    if (slug) return `${parsed.origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=title,content,link`;
  }
  return null;
}

export function extractArticleStyleSampleWordpressRestLinkForTest(rawHtml: string, sourceUrl: string): string | null {
  return extractWpRestLink(rawHtml, sourceUrl);
}

function renderPlainTextAsMarkdown(value: string): string {
  const text = normalizeText(value.replace(/<script\b[\s\S]*?<\/script>/gi, " "));
  if (!text) return "";
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join("\n\n");
}

function trimTail(markdown: string): string {
  const lines = markdown.split("\n");
  const meaningful = lines.map((line, index) => ({ line: line.trim(), index })).filter((entry) => entry.line);
  if (meaningful.length < 3) return markdown;
  const relatedHeading = [...meaningful].reverse().find((entry) =>
    /^#{2,6}\s+(?:関連記事|関連リンク|あわせて読みたい|他の記事を読む|おすすめの記事|related(?: articles| links)?)\s*$/iu.test(entry.line),
  );
  if (relatedHeading) {
    const relatedLevel = Number(/^#{2,6}/u.exec(relatedHeading.line)?.[0].length ?? 2);
    const nextSection = meaningful.find((entry) => entry.index > relatedHeading.index && new RegExp(`^#{1,${relatedLevel}}\\s+`).test(entry.line));
    const relatedTail = meaningful.filter((entry) => entry.index > relatedHeading.index && (!nextSection || entry.index < nextSection.index));
    const links = relatedTail.filter((entry) => /https:\/\//iu.test(entry.line)).length;
    const imageCards = relatedTail.filter((entry) => /^\[画像(?:設置場所)?(?::[^\]]+)?\]$/u.test(entry.line)).length;
    // 複数カード（画像やリンクが2件以上）の「関連記事」群だけを確実に落とす。
    // 単独CTA、見出し+単一リンク、キャプションは本文の一部として残す。
    if (links >= 2 && (imageCards >= 2 || relatedTail.length >= 2)) {
      const sectionEnd = nextSection?.index ?? lines.length;
      return [...lines.slice(0, relatedHeading.index), ...lines.slice(sectionEnd)].join("\n").trim();
    }
  }
  const lastHeading = [...meaningful].reverse().find((entry) => /^#{2,6}\s+/.test(entry.line));
  if (lastHeading && /^(?:関連記事|関連リンク|あわせて読みたい|他の記事を読む|おすすめの記事|related(?: articles| links)?)\s*$/iu.test(lastHeading.line.replace(/^#{2,6}\s+/, ""))) {
    const tail = meaningful.filter((entry) => entry.index > lastHeading.index);
    if (tail.length >= 2 && tail.every((entry) => /^(?:[-*]\s*)?\[[^\]]+\]\(https:\/\/[^)]+\)$/.test(entry.line))) {
      return lines.slice(0, lastHeading.index).join("\n").trim();
    }
  }
  const lastTwo = meaningful.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((entry) => /^(?:[-*]\s*)?\[[^\]]+\]\(https:\/\/[^)]+\)$/.test(entry.line))) {
    const prefix = meaningful[meaningful.length - 3]?.line ?? "";
    if (/^(?:関連記事|関連リンク|あわせて読みたい|related)/i.test(prefix)) {
      return lines.slice(0, meaningful[meaningful.length - 3]?.index ?? lines.length).join("\n").trim();
    }
  }
  return markdown;
}

function truncateMarkdown(markdown: string): { markdown: string; warnings: string[] } {
  if (markdown.length <= ARTICLE_STYLE_SAMPLE_IMPORT_MAX_MARKDOWN_CHARS) return { markdown, warnings: [] };
  const lines = markdown.split("\n");
  let end = ARTICLE_STYLE_SAMPLE_IMPORT_MAX_MARKDOWN_CHARS;
  const headingBoundary = [...markdown.matchAll(/\n#{1,6}\s+\S/gu)]
    .map((match) => match.index ?? -1)
    .filter((index) => index > 0 && index <= end)
    .at(-1);
  if (headingBoundary !== undefined) end = headingBoundary;
  else {
    const paragraphBoundary = markdown.lastIndexOf("\n\n", end);
    if (paragraphBoundary > 0) end = paragraphBoundary;
  }
  const truncated = markdown.slice(0, end).trim();
  return {
    markdown: truncated || lines.slice(0, 1).join(""),
    warnings: ["本文が長いため、見出しの区切りで50,000字以内に短縮しました。"],
  };
}

function countParagraphs(markdown: string): number {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block && !/^#{1,6}\s+/.test(block) && !/^>\s?/.test(block) && !/^[-*]\s+\[[^\]]+\]\(/.test(block) && !/^\[画像/.test(block)).length;
}

function passesQualityGate(markdown: string): boolean {
  if (markdown.length < 300) return false;
  if (countParagraphs(markdown) < 3) return false;
  const linkTextChars = [...markdown.matchAll(/\[([^\]]+)\]\(https:\/\/[^)]+\)/g)].reduce((sum, match) => sum + (match[1]?.length ?? 0), 0);
  const visibleChars = markdown.replace(/\[[^\]]+\]\(https:\/\/[^)]+\)/g, "").replace(/\[画像(?::[^\]]+)?\]/g, "").length;
  if (visibleChars > 0 && linkTextChars / visibleChars > 0.6) return false;
  return true;
}

function buildResult(params: {
  html: string;
  title?: string | null;
  markdown: string;
  sourceUrl: string;
  extractor: ArticleStyleSampleExtractor;
  warnings?: string[];
}): ArticleStyleSampleImportResult | null {
  let markdown = trimTail(params.markdown);
  const truncated = truncateMarkdown(markdown);
  markdown = truncated.markdown;
  const warnings = [...(params.warnings ?? []), ...truncated.warnings];
  if (!passesQualityGate(markdown)) return null;
  const headingCount = markdown.match(/^#{1,6}\s+\S/gm)?.length ?? 0;
  const imageCount = markdown.match(/\[画像(?:設置場所)?(?::[^\]]+)?\]/g)?.length ?? 0;
  const quoteCount = markdown.match(/^>\s?/gm)?.length ?? 0;
  const label = normalizeText(params.title ?? "") || extractTitle(params.html, markdown);
  return {
    label: label.slice(0, 100),
    markdown,
    sourceUrl: params.sourceUrl,
    extractor: params.extractor,
    stats: { chars: markdown.length, headings: headingCount, images: imageCount, quotes: quoteCount },
    warnings,
  };
}

function parseWpRestBody(rawBody: string): { title: string | null; body: string | null } {
  const parsed = parseJsonSafely(rawBody);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || typeof first !== "object") return { title: null, body: null };
  const record = first as Record<string, unknown>;
  const title = typeof record.title === "object" && record.title && typeof (record.title as Record<string, unknown>).rendered === "string"
    ? (record.title as Record<string, unknown>).rendered as string
    : typeof record.title === "string" ? record.title : null;
  const content = typeof record.content === "object" && record.content && typeof (record.content as Record<string, unknown>).rendered === "string"
    ? (record.content as Record<string, unknown>).rendered as string
    : typeof record.content === "string" ? record.content : null;
  return { title: title ? stripTags(title) : null, body: content };
}

function articleHtmlFragment(rawHtml: string): string {
  const mainArea = extractAttributeElement(rawHtml, "id", "mainArea");
  if (mainArea) return mainArea;
  return /<article\b[^>]*>[\s\S]*<\/article>/i.test(rawHtml)
    ? rawHtml.match(/<article\b[^>]*>[\s\S]*<\/article>/i)?.[0] ?? rawHtml
    : /<main\b[^>]*>[\s\S]*<\/main>/i.test(rawHtml)
      ? rawHtml.match(/<main\b[^>]*>[\s\S]*<\/main>/i)?.[0] ?? rawHtml
      : rawHtml.match(/<body\b[^>]*>[\s\S]*<\/body>/i)?.[0] ?? rawHtml;
}

function isRssContentType(contentType: string): boolean {
  return contentType === "application/rss+xml" || contentType === "application/atom+xml";
}

function looksLikeAmpDocument(rawHtml: string): boolean {
  return /<html\b[^>]*(?:\bamp\b|⚡)[^>]*>/i.test(rawHtml) || /<amp-[a-z-]+\b/i.test(rawHtml);
}

function isWordpressRestPayload(context: ArticleStyleSampleExtractorContext): boolean {
  return Boolean(parseWpRestBody(context.rawHtml).body)
    && ["application/json", "text/json"].includes(context.page.contentType);
}

async function fetchAlternatePage(context: ArticleStyleSampleExtractorContext, kind: AlternateKind): Promise<FetchedPage | null> {
  const alternateUrl = extractSameOriginAlternateLink(context.rawHtml, context.page.url, kind);
  if (!alternateUrl) return null;
  try {
    return await context.fetchPage({
      sourceUrl: alternateUrl,
      sameOriginRedirectOnly: new URL(context.page.url).origin,
      deadlineAt: context.deadlineAt,
    });
  } catch (error) {
    // private DNS/redirectは安全境界なのでfallbackで隠さない。公開cross-originは
    // fetchPageのsame-origin guardで到達せず、通常本文へ戻せる。
    if (error instanceof ArticleStyleSampleImportError && (/GLOBAL_DENY|IMPORT_TIMEOUT/u.test(error.code))) throw error;
    return null;
  }
}

async function extractWordpressRest(context: ArticleStyleSampleExtractorContext): Promise<ArticleStyleSampleExtractorCandidate | null> {
  const direct = parseWpRestBody(context.rawHtml);
  if (isWordpressRestPayload(context) && direct.body) {
    return { title: direct.title ?? context.title, markdown: renderHtmlToMarkdown(direct.body), sourceUrl: context.page.url };
  }
  const restLink = extractWpRestLink(context.rawHtml, context.page.url);
  if (!restLink) return null;
  try {
    const restPage = await context.fetchPage({
      sourceUrl: restLink,
      sameOriginRedirectOnly: new URL(context.page.url).origin,
      deadlineAt: context.deadlineAt,
    });
    const rest = parseWpRestBody(restPage.body);
    return rest.body
      ? { title: rest.title ?? context.title, markdown: renderHtmlToMarkdown(rest.body), sourceUrl: context.page.url }
      : null;
  } catch (error) {
    if (error instanceof ArticleStyleSampleImportError && (/GLOBAL_DENY|IMPORT_TIMEOUT/u.test(error.code))) throw error;
    return null;
  }
}

function extractWordpressHtml(context: ArticleStyleSampleExtractorContext): ArticleStyleSampleExtractorCandidate | null {
  if (!looksLikeWordpress(context.rawHtml, context.page.url)) return null;
  return { title: context.title, markdown: renderHtmlToMarkdown(articleHtmlFragment(context.rawHtml)), sourceUrl: context.page.url };
}

function extractWixBlog(context: ArticleStyleSampleExtractorContext): ArticleStyleSampleExtractorCandidate | null {
  const description = extractHook(context.rawHtml, "post-description");
  if (!description) return null;
  return {
    title: stripTags(extractHook(context.rawHtml, "post-title") ?? "") || context.title,
    markdown: renderHtmlToMarkdown(description),
    sourceUrl: context.page.url,
  };
}

function extractWixPage(context: ArticleStyleSampleExtractorContext): ArticleStyleSampleExtractorCandidate | null {
  if (!looksLikeWixPage(context.rawHtml) || !/<main\b/i.test(context.rawHtml)) return null;
  const main = /<main\b[^>]*>[\s\S]*<\/main>/i.exec(context.rawHtml)?.[0];
  return main ? { title: context.title, markdown: renderHtmlToMarkdown(main), sourceUrl: context.page.url } : null;
}

function extractStudioNuxt(context: ArticleStyleSampleExtractorContext): ArticleStyleSampleExtractorCandidate | null {
  for (const candidate of extractStudioNuxtCandidates(context.rawHtml)) {
    const markdown = renderHtmlToMarkdown(candidate);
    if (passesQualityGate(markdown)) return { title: context.title, markdown, sourceUrl: context.page.url };
  }
  return null;
}

function extractJsonLdCandidate(context: ArticleStyleSampleExtractorContext): ArticleStyleSampleExtractorCandidate | null {
  const directJson = context.page.contentType === "application/ld+json" ? parseJsonSafely(context.rawHtml) : null;
  const body = directJson ? findJsonField(directJson, new Set(["articlebody", "text"])) : extractJsonLd(context.rawHtml).body;
  if (!body) return null;
  const title = directJson ? findJsonField(directJson, new Set(["headline", "name"])) : extractJsonLd(context.rawHtml).title;
  return { title: title ?? context.title, markdown: renderPlainTextAsMarkdown(body), sourceUrl: context.page.url };
}

function extractEmbeddedJsonCandidate(context: ArticleStyleSampleExtractorContext): ArticleStyleSampleExtractorCandidate | null {
  const embedded = extractEmbeddedJson(context.rawHtml);
  return embedded.body
    ? { title: embedded.title ?? context.title, markdown: renderHtmlToMarkdown(embedded.body), sourceUrl: context.page.url }
    : null;
}

async function extractRssCandidate(context: ArticleStyleSampleExtractorContext): Promise<ArticleStyleSampleExtractorCandidate | null> {
  const direct = isRssContentType(context.page.contentType)
    ? extractRss({ rawHtml: context.rawHtml, targetUrl: context.page.url, feedUrl: context.page.url })
    : null;
  if (direct?.body) return { title: direct.title ?? context.title, markdown: renderHtmlToMarkdown(direct.body), sourceUrl: context.page.url };
  const alternate = await fetchAlternatePage(context, "rss");
  if (!alternate) return null;
  const rss = extractRss({ rawHtml: alternate.body, targetUrl: context.page.url, feedUrl: alternate.url });
  return rss.body
    ? { title: rss.title ?? context.title, markdown: renderHtmlToMarkdown(rss.body), sourceUrl: context.page.url }
    : null;
}

async function extractAmpCandidate(context: ArticleStyleSampleExtractorContext): Promise<ArticleStyleSampleExtractorCandidate | null> {
  let page = context.page;
  if (!looksLikeAmpDocument(context.rawHtml)) {
    const alternate = await fetchAlternatePage(context, "amp");
    if (!alternate) return null;
    page = alternate;
  }
  const html = page.body;
  return { title: context.title, markdown: renderHtmlToMarkdown(articleHtmlFragment(html)), sourceUrl: context.page.url };
}

function extractReadabilityCandidate(context: ArticleStyleSampleExtractorContext): ArticleStyleSampleExtractorCandidate {
  return { title: context.title, markdown: renderHtmlToMarkdown(articleHtmlFragment(context.rawHtml)), sourceUrl: context.page.url };
}

export const ARTICLE_STYLE_SAMPLE_EXTRACTOR_REGISTRY: readonly ArticleStyleSampleExtractorDefinition[] = [
  {
    id: "wordpress-rest",
    detect: (context) => isWordpressRestPayload(context) || Boolean(extractWpRestLink(context.rawHtml, context.page.url)),
    extract: extractWordpressRest,
  },
  {
    id: "wordpress-html",
    detect: (context) => looksLikeWordpress(context.rawHtml, context.page.url),
    extract: extractWordpressHtml,
  },
  {
    id: "wix-blog",
    detect: (context) => Boolean(extractHook(context.rawHtml, "post-description")),
    extract: extractWixBlog,
  },
  {
    id: "wix-page",
    detect: (context) => looksLikeWixPage(context.rawHtml) && /<main\b/i.test(context.rawHtml),
    extract: extractWixPage,
  },
  {
    id: "studio-nuxt",
    detect: (context) => looksLikeStudioNuxt(context.rawHtml),
    extract: extractStudioNuxt,
  },
  {
    id: "readability",
    detect: (context) => !["application/json", "text/json", "application/ld+json", "application/rss+xml", "application/atom+xml", "application/amphtml"].includes(context.page.contentType) && !looksLikeAmpDocument(context.rawHtml),
    extract: extractReadabilityCandidate,
  },
  {
    id: "json-ld",
    detect: (context) => context.page.contentType === "application/ld+json" || extractJsonLd(context.rawHtml).body !== null,
    extract: extractJsonLdCandidate,
  },
  {
    id: "embedded-json",
    detect: (context) => extractEmbeddedJson(context.rawHtml).body !== null,
    extract: extractEmbeddedJsonCandidate,
  },
  {
    id: "rss",
    detect: (context) => isRssContentType(context.page.contentType) || extractSameOriginAlternateLink(context.rawHtml, context.page.url, "rss") !== null,
    extract: extractRssCandidate,
  },
  {
    id: "amp",
    detect: (context) => looksLikeAmpDocument(context.rawHtml) || extractSameOriginAlternateLink(context.rawHtml, context.page.url, "amp") !== null,
    extract: extractAmpCandidate,
  },
];

async function runExtractorRegistry(
  context: ArticleStyleSampleExtractorContext,
  registry: readonly ArticleStyleSampleExtractorDefinition[],
): Promise<ArticleStyleSampleImportResult | null> {
  for (const extractor of registry) {
    remainingImportTime(context.deadlineAt);
    if (!extractor.detect(context)) continue;
    const candidate = await extractor.extract(context);
    remainingImportTime(context.deadlineAt);
    if (!candidate) continue;
    const result = buildResult({
      html: context.rawHtml,
      title: candidate.title ?? context.title,
      markdown: candidate.markdown,
      sourceUrl: candidate.sourceUrl ?? context.page.url,
      extractor: extractor.id,
      warnings: candidate.warnings,
    });
    remainingImportTime(context.deadlineAt);
    if (result) return result;
  }
  return null;
}

export async function importArticleStyleSample(params: { url: string; fetchPage: ArticleSampleFetchPage; extractorRegistry?: readonly ArticleStyleSampleExtractorDefinition[]; deadlineAt?: number }): Promise<ArticleStyleSampleImportResult> {
  const sourceUrl = normalizeArticleStyleSampleImportUrl(params.url);
  const deadlineAt = params.deadlineAt ?? Date.now() + ARTICLE_STYLE_SAMPLE_IMPORT_TIMEOUT_MS;
  const page = await withImportDeadline(params.fetchPage({ sourceUrl, deadlineAt }), deadlineAt);
  const rawHtml = page.body;
  const title = extractTitle(rawHtml);
  const result = await withImportDeadline(
    runExtractorRegistry(
      { page, rawHtml, title, deadlineAt, fetchPage: params.fetchPage },
      params.extractorRegistry ?? ARTICLE_STYLE_SAMPLE_EXTRACTOR_REGISTRY,
    ),
    deadlineAt,
  );
  if (result) return result;

  const fallbackBody = renderHtmlToMarkdown(articleHtmlFragment(rawHtml));
  if (fallbackBody.length > 0 && fallbackBody.length < 300) {
    throw importError("STYLE_SAMPLE_TOO_SHORT", 409, "no extractor passed the minimum body length", "記事本文が短すぎます。Markdownで本文を貼り付けてください");
  }
  throw importError("STYLE_SAMPLE_BODY_NOT_FOUND", 409, "no extractor passed the quality gate", "記事本文を十分に抽出できませんでした。Markdownで本文を貼り付けてください");
}
