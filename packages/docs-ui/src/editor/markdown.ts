import { getSchema, type Extensions } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import StarterKit from "@tiptap/starter-kit";
import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import MarkdownIt from "markdown-it";
import { MarkdownParser, MarkdownSerializer, type MarkdownSerializerState, type ParseSpec } from "prosemirror-markdown";
import { TIMESTAMP_PREFIX, finalizeMarkdown } from "@niho/docs-core";
import type { StateCore, Token } from "./markdown-it-types";
import { MarkdownRaw, MarkdownRawInline, addRawMarkdownRules } from "./markdown-raw";
import { DocAssetImage } from "./doc-assets";
import { TranscriptTimestamp, timestampPrefix } from "./timestamps";

/**
 * Markdown ↔ TipTap（ProseMirror）の往復。NIHO の記事制作の WYSIWYG（apps/web/lib/article-authoring/article-markdown-bridge.ts）を
 * NIHO 依存（niho-upload の画像・リンクの記法の差し替え）を外して写したもの。
 * schema は StarterKit ＋ チェックのリスト。エディタに道具の無いもの（表・画像）は消さずに文字のまま持つ（markdown-raw.ts）。
 * エディタの操作（書き始めの記号・「/」・案内の文字・キー）は schema に影響しないので各アプリのエディタの側に置く。
 *
 * Mac（apps/docs）と Web/PWA（apps/web/app/app/docs）は同じこの実装を使い、違いは createDocsMarkdown の引数で選ぶ（#18876）。
 */

export type DocsMarkdownOptions = {
  /**
   * 文字起こしの時刻（最上位の段落の先頭の `[hh:mm:ss] `）を専用 node にできる schema にするか。
   * true の場合も `markdownToDoc(markdown, true)` を渡したときだけ段落の先頭の有効な時刻を node にする。
   */
  transcriptTimestamps: boolean;
  /** 再生できない画面では時刻を読み取り専用の表示にする。Mac の既定は頭出しできる。 */
  timestampSeekEnabled?: boolean;
  /** schema に時刻 node があっても、Web の既存文書と同じく時刻風の接頭辞を広い形で直列化する。 */
  preserveLooseTimestampTextPrefix?: boolean;
};

export type DocsMarkdown = {
  /** schema を決める拡張だけ（往復の parser / serializer とエディタで共有する）。 */
  buildEditorExtensions: () => Extensions;
  markdownSchema: Schema;
  /** 第 2 引数は、時刻の node を持つ（transcriptTimestamps: true の）ときだけ効く。 */
  markdownToDoc: (markdown: string, transcriptTimestamps?: boolean) => ProseMirrorNode;
  docToMarkdown: (doc: ProseMirrorNode) => string;
  /** Markdown → doc → Markdown を一度通した保存の形（見た目の同じ書き方の違いで「変更あり」にしない）。 */
  canonicalMarkdown: (markdown: string) => string;
  isMarkdownChanged: (next: string, saved: string) => boolean;
};

function backticksFor(node: ProseMirrorNode, side: number): string {
  const ticks = /`+/g;
  let match: RegExpExecArray | null;
  let length = 0;
  if (node.isText && node.text) {
    while ((match = ticks.exec(node.text))) length = Math.max(length, match[0].length);
  }
  let result = length > 0 && side > 0 ? " `" : "`";
  for (let index = 0; index < length; index++) result += "`";
  if (length > 0 && side < 0) result += " ";
  return result;
}

/**
 * 同じ記号のリストが続くと Markdown では 1 つのリストに読まれる（チェックと箇条書きも同じ `-`）。
 * 直前に同じ書き方のリストが並んでいるときは、1 つおきに記号を変えて別のリストのまま往復させる。
 */
function alternateListMarker(parent: ProseMirrorNode, index: number, names: readonly string[]): boolean {
  let run = 0;
  for (let cursor = index - 1; cursor >= 0 && names.includes(parent.child(cursor).type.name); cursor--) run++;
  return run % 2 === 1;
}

const DASH_LISTS = ["bulletList", "taskList"] as const;

export function createDocsMarkdown(options: DocsMarkdownOptions): DocsMarkdown {
  const timestamps = options.transcriptTimestamps;

  function buildEditorExtensions(): Extensions {
    return [
      StarterKit.configure({
        underline: false,
        link: { openOnClick: false, enableClickSelection: true, HTMLAttributes: { rel: "noopener noreferrer" } },
      }),
      TaskList,
      // nested でないと、入れ子の箇条書きを持つ項目が読むときに消える
      TaskItem.configure({ nested: true, a11y: { checkboxLabel: (node) => `やること: ${node.textContent}` } }),
      MarkdownRaw,
      MarkdownRawInline,
      DocAssetImage,
      ...(timestamps ? [TranscriptTimestamp.configure({ seekEnabled: options.timestampSeekEnabled ?? true })] : []),
    ];
  }

  const markdownSchema: Schema = getSchema(buildEditorExtensions());

  // CommonMark + 取り消し線 + 表（表は文字のまま持つために読む）。HTML は文字として扱う（実行しない）。
  const markdownIt = MarkdownIt("commonmark", { html: false }).enable(["strikethrough", "table"]);
  addRawMarkdownRules(markdownIt);
  if (timestamps) {
    markdownIt.core.ruler.push("niho_transcript_timestamps", (state) => {
      if (state.env?.transcriptTimestamps === true) decorateTimestampTokens(state);
    });
  }

  const parserTokens: Record<string, ParseSpec> = {
    blockquote: { block: "blockquote" },
    paragraph: { block: "paragraph" },
    ...(timestamps
      ? { transcript_timestamp: { node: "transcriptTimestamp", getAttrs: (token: Token) => timestampPrefix(token.content) ?? {} } }
      : {}),
    list_item: { block: "listItem" },
    bullet_list: { block: "bulletList" },
    task_list: { block: "taskList" },
    task_item: { block: "taskItem", getAttrs: (token) => ({ checked: token.attrGet("checked") === "true" }) },
    ordered_list: {
      block: "orderedList",
      getAttrs: (token) => ({ start: token.attrGet("start") ? Number(token.attrGet("start")) : 1 }),
    },
    heading: { block: "heading", getAttrs: (token) => ({ level: Number(token.tag.slice(1)) || 1 }) },
    code_block: { block: "codeBlock", noCloseToken: true },
    fence: {
      block: "codeBlock",
      getAttrs: (token) => ({ language: token.info ? (token.info.trim().split(/\s+/)[0] ?? null) : null }),
      noCloseToken: true,
    },
    hr: { node: "horizontalRule" },
    md_raw: { block: "markdownRaw", noCloseToken: true },
    md_raw_inline: { mark: "markdownRawInline" },
    image: {
      node: "docAssetImage",
      getAttrs: (token) => ({ name: (token.attrGet("src") ?? "").slice("niho-docs-asset:".length), alt: token.content, title: token.attrGet("title") }),
    },
    hardbreak: { node: "hardBreak" },
    em: { mark: "italic" },
    strong: { mark: "bold" },
    s: { mark: "strike" },
    link: {
      mark: "link",
      getAttrs: (token) => ({ href: token.attrGet("href"), title: token.attrGet("title") || null }),
    },
    code_inline: { mark: "code", noCloseToken: true },
  };

  const parser = new MarkdownParser(markdownSchema, markdownIt, parserTokens);

  // 段落の先頭の時刻（[hh:mm:ss] ）は逃がさずに書く（他のエディタで読める形のまま往復させる）。
  const paragraphTimestampPrefix: (text: string) => string | undefined = timestamps && !options.preserveLooseTimestampTextPrefix
    ? (text) => timestampPrefix(text)?.prefix
    : (text) => TIMESTAMP_PREFIX.exec(text)?.[0];

  const serializer = new MarkdownSerializer(
    {
      blockquote(state, node) {
        state.wrapBlock("> ", null, node, () => state.renderContent(node));
      },
      codeBlock(state, node) {
        const language = typeof node.attrs.language === "string" ? node.attrs.language : "";
        state.write("```" + language + "\n");
        state.text(node.textContent, false);
        state.ensureNewLine();
        state.write("```");
        state.closeBlock(node);
      },
      heading(state, node) {
        state.write(state.repeat("#", node.attrs.level as number) + " ");
        state.renderInline(node);
        state.closeBlock(node);
      },
      horizontalRule(state, node) {
        state.write("---");
        state.closeBlock(node);
      },
      bulletList(state, node, parent, index) {
        const marker = alternateListMarker(parent, index, DASH_LISTS) ? "* " : "- ";
        state.renderList(node, "  ", () => marker);
      },
      taskList(state, node, parent, index) {
        const marker = alternateListMarker(parent, index, DASH_LISTS) ? "* " : "- ";
        state.renderList(node, "  ", () => marker);
      },
      orderedList(state, node, parent, index) {
        const start = (node.attrs.start as number) || 1;
        const delimiter = alternateListMarker(parent, index, ["orderedList"]) ? ") " : ". ";
        const maxWidth = String(start + node.childCount - 1).length;
        const space = state.repeat(" ", maxWidth + 2);
        state.renderList(node, space, (itemIndex) => {
          const label = String(start + itemIndex);
          return state.repeat(" ", maxWidth - label.length) + label + delimiter;
        });
      },
      listItem(state, node) {
        state.renderContent(node);
      },
      taskItem(state, node) {
        state.write(node.attrs.checked ? "[x]" : "[ ]");
        if (node.firstChild && node.firstChild.content.size > 0) state.write(" ");
        state.renderContent(node);
      },
      markdownRaw(state, node) {
        // 引用やリストの中でも、行ごとに接頭辞（`> ` や字下げ）が付く
        state.text(node.textContent, false);
        state.closeBlock(node);
      },
      docAssetImage(state, node) {
        const name = String(node.attrs.name ?? "");
        const alt = String(node.attrs.alt ?? "").replace(/[\\\]]/g, "\\$&");
        const title = typeof node.attrs.title === "string" && node.attrs.title ? ` "${node.attrs.title.replace(/["\\]/g, "\\$&")}"` : "";
        state.write(`![${alt}](niho-docs-asset:${name}${title})`);
      },
      paragraph(state, node) {
        state.renderInline(node);
        state.closeBlock(node);
      },
      ...(timestamps
        ? {
            transcriptTimestamp(state: MarkdownSerializerState, node: ProseMirrorNode) {
              const prefix = typeof node.attrs.prefix === "string" ? node.attrs.prefix : "";
              state.write(prefix);
            },
          }
        : {}),
      hardBreak(state, node, parent, index) {
        for (let next = index + 1; next < parent.childCount; next++) {
          if (parent.child(next).type !== node.type) {
            state.write("\\\n");
            return;
          }
        }
      },
      text(state, node, parent, index) {
        const text = node.text ?? "";
        const prefix = index === 0 && parent.type.name === "paragraph" ? paragraphTimestampPrefix(text) : undefined;
        if (prefix && node.marks.length === 0) {
          state.text(prefix, false);
          state.text(text.slice(prefix.length));
          return;
        }
        state.text(text);
      },
    },
    {
      bold: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
      italic: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
      strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
      code: {
        open(_state, _mark, parent, index) {
          return backticksFor(parent.child(index), -1);
        },
        close(_state, _mark, parent, index) {
          return backticksFor(parent.child(index - 1), 1);
        },
        escape: false,
      },
      // 印を逃がさない（他のエディタで開くと画像のまま）
      markdownRawInline: { open: "", close: "", escape: false },
      link: {
        open: "[",
        close(_state: MarkdownSerializerState, mark) {
          const href = typeof mark.attrs.href === "string" ? mark.attrs.href : "";
          const title = typeof mark.attrs.title === "string" && mark.attrs.title ? mark.attrs.title : "";
          return "](" + href.replace(/[()"]/g, "\\$&") + (title ? ` "${title.replace(/"/g, '\\"')}"` : "") + ")";
        },
      },
    },
  );

  function markdownToDoc(markdown: string, transcriptTimestamps = false): ProseMirrorNode {
    // 時刻を node にする core rule は、時刻の node を持つ schema のときだけ足してある
    return parser.parse(markdown, { transcriptTimestamps: timestamps && transcriptTimestamps });
  }

  function docToMarkdown(doc: ProseMirrorNode): string {
    // StarterKit の listItem は段落を内包するので、既定だと項目の間に空行が入る。詰めた箇条書きを正にする
    return serializer.serialize(doc, { tightLists: true });
  }

  function canonicalMarkdown(markdown: string): string {
    return finalizeMarkdown(docToMarkdown(markdownToDoc(markdown)));
  }

  function isMarkdownChanged(next: string, saved: string): boolean {
    return canonicalMarkdown(next) !== canonicalMarkdown(saved);
  }

  return { buildEditorExtensions, markdownSchema, markdownToDoc, docToMarkdown, canonicalMarkdown, isMarkdownChanged };
}

/** 保存する形（末尾は改行 1 つ）。NIHO API の composer（#18748）と同じ形にするため @niho/docs-core に置いた。 */
export { finalizeMarkdown };

const renderIt = MarkdownIt("commonmark", { html: false }).enable("strikethrough");
const renderTranscriptIt = MarkdownIt("commonmark", { html: false }).enable("strikethrough");

// 時刻の範囲を探す読み方。往復の parser（createDocsMarkdown）と同じ token を作る（時刻を node にする core rule は持たない）。
const scanIt = MarkdownIt("commonmark", { html: false }).enable(["strikethrough", "table"]);
addRawMarkdownRules(scanIt);

/**
 * Markdown-it が最上位の段落と認識した行の接頭辞だけを、元の文字列から外す。
 * doc の再直列化はしないので、箇条書きの印・空行・escape など timestamp 以外の byte を変えない。
 */
function timestampTokens(markdown: string, tokens: Token[]) {
  const lineStarts = [0];
  for (let index = 0; index < markdown.length; index++) if (markdown[index] === "\n") lineStarts.push(index + 1);
  const ranges: Array<{ from: number; to: number; inline: Token; first: Token; prefix: string }> = [];
  for (let index = 1; index < tokens.length; index++) {
    const inline = tokens[index]!;
    const open = tokens[index - 1]!;
    const line = open.map?.[0];
    if (inline.type !== "inline" || open.type !== "paragraph_open" || open.level !== 0 || line === undefined) continue;
    const first = inline.children?.[0];
    const found = first?.type === "text" ? timestampPrefix(first.content) : null;
    const from = lineStarts[line];
    if (!first || !found || from === undefined || markdown.slice(from, from + found.prefix.length) !== found.prefix) continue;
    ranges.push({ from, to: from + found.prefix.length, inline, first, prefix: found.prefix });
  }
  return ranges;
}

function timestampRanges(markdown: string): Array<{ from: number; to: number }> {
  return timestampTokens(markdown, scanIt.parse(markdown, {}));
}

export function markdownHasTimestamps(markdown: string): boolean {
  return timestampRanges(markdown).length > 0;
}

export function markdownWithoutTimestamps(markdown: string): string {
  let result = markdown;
  const ranges = timestampRanges(markdown);
  for (const range of ranges.reverse()) result = result.slice(0, range.from) + result.slice(range.to);
  return result;
}

function decorateTimestampTokens(state: StateCore): void {
  for (const { inline, first, prefix } of timestampTokens(state.src, state.tokens)) {
    const timestamp = new state.Token("transcript_timestamp", "span", 0);
    timestamp.content = prefix;
    first.content = first.content.slice(prefix.length);
    inline.children!.unshift(timestamp);
  }
}
renderTranscriptIt.core.ruler.push("niho_transcript_timestamps", decorateTimestampTokens);
renderTranscriptIt.renderer.rules.transcript_timestamp = (tokens, index, _options, env: { hideTimestampText?: boolean } | undefined) => {
  const found = timestampPrefix(tokens[index]!.content);
  if (!found) return tokens[index]!.content;
  // 非表示（env.hideTimestampText）は時刻の文字を DOM に出さず、頭出しの押し先（空の span）だけを描く。コピーに時刻が混ざらない
  const text = env?.hideTimestampText ? "" : tokens[index]!.content;
  return `<span class="transcript-timestamp" data-transcript-timestamp="true" data-transcript-seek-seconds="${found.seconds}" role="button" tabindex="0" aria-label="${found.label}から頭出し">${text}</span>`;
};

/** 実行中の逐次表示（途中の Markdown をそのまま HTML にする。HTML は文字として扱う）。 */
export function renderMarkdown(markdown: string): string {
  return renderIt.render(markdown);
}

/**
 * 実行中の時刻付き Markdown。node と同じ認識の時刻を、ON は文字つきの span、OFF は文字なしの span（頭出しの押し先だけ）として描く。
 * 保存後の表示は ProseMirror の decoration が OFF でも頭出しの余白を出すので、実行中も同じく頭出しできるようにする。
 */
export function renderTranscriptMarkdown(markdown: string, showTimestamps: boolean): string {
  return renderTranscriptIt.render(markdown, { hideTimestampText: !showTimestamps });
}
