import { Mark, Node, mergeAttributes } from "@tiptap/core";
import type MarkdownIt from "markdown-it";
import { assetName } from "./doc-assets";
import type { StateCore, Token } from "./markdown-it-types";

/**
 * エディタに道具の無い Markdown（表・画像）を、消さずに文字のまま持つための node / mark と、
 * markdown-it の token の読み替え（表・画像を文字に、全部の項目が `[ ]`／`[x]` の箇条書きをチェックのリストに）。
 */

/** 表など、ブロックの Markdown を文字のまま持つ（書き戻すときも文字のまま）。 */
export const MarkdownRaw = Node.create({
  name: "markdownRaw",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  whitespace: "pre",
  parseHTML() {
    return [{ tag: "div.md-raw", preserveWhitespace: "full" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "md-raw" }), 0];
  },
});

/** 画像など、行の中の Markdown を文字のまま持つ（太字などは重ねない。リンクの中の画像は残す）。 */
export const MarkdownRawInline = Mark.create({
  name: "markdownRawInline",
  excludes: "bold italic strike code",
  inclusive: false,
  code: true,
  parseHTML() {
    return [{ tag: "span.md-raw-inline" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "md-raw-inline" }), 0];
  },
});

type TokenConstructor = StateCore["Token"];

const TASK_MARK = /^\[([ xX])\](?:\s+|$)/;

/** 読み替えの core rule を足す（inline の後＝セルや項目の中身が token になってから）。 */
export function addRawMarkdownRules(md: MarkdownIt): void {
  md.core.ruler.push("niho_raw_blocks", (state) => {
    state.tokens = collapseTables(state.tokens, state.Token);
    for (const token of state.tokens) {
      if (token.type === "inline" && token.children) token.children = rawImages(md, token.children, state.Token);
    }
    convertTaskLists(state.tokens);
  });
}

function alignDelimiter(style: string | null): string {
  const align = /text-align:\s*(left|right|center)/.exec(style ?? "")?.[1];
  if (align === "left") return ":---";
  if (align === "right") return "---:";
  if (align === "center") return ":---:";
  return "---";
}

/** table_open〜table_close を 1 つの token（md_raw）にまとめ、セルの生の中身から表の Markdown を組み直す。 */
function collapseTables(tokens: Token[], TokenClass: TokenConstructor): Token[] {
  if (!tokens.some((token) => token.type === "table_open")) return tokens;
  const result: Token[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const open = tokens[index]!;
    if (open.type !== "table_open") {
      result.push(open);
      continue;
    }
    const rows: string[][] = [];
    const delimiters: string[] = [];
    let inHead = false;
    let cursor = index + 1;
    for (; cursor < tokens.length && tokens[cursor]!.type !== "table_close"; cursor++) {
      const token = tokens[cursor]!;
      if (token.type === "thead_open") inHead = true;
      else if (token.type === "thead_close") inHead = false;
      else if (token.type === "tr_open") rows.push([]);
      else if (token.type === "th_open" && inHead) delimiters.push(alignDelimiter(token.attrGet("style")));
      // markdown-it はセルの `\|` を `|` にして渡すので、書き戻すときに逃がし直す
      else if (token.type === "inline") rows[rows.length - 1]?.push(token.content.replace(/\|/g, "\\|"));
    }
    const lines = rows.map((cells) => `| ${cells.join(" | ")} |`);
    lines.splice(1, 0, `| ${delimiters.join(" | ")} |`);
    const raw = new TokenClass("md_raw", "div", 0);
    raw.block = true;
    raw.content = lines.join("\n");
    raw.map = open.map;
    raw.level = open.level;
    result.push(raw);
    index = cursor;
  }
  return result;
}

function linkDestination(href: string): string {
  if (href && !/[\s<>()\\]/.test(href)) return href;
  return `<${href.replace(/[<>\\]/g, "\\$&")}>`;
}

/** 画像の token を `![alt](src "title")` の文字（mark: markdownRawInline）に組み直す。 */
function rawImages(md: MarkdownIt, children: Token[], TokenClass: TokenConstructor): Token[] {
  if (!children.some((child) => child.type === "image")) return children;
  return children.flatMap((child) => {
    if (child.type !== "image") return [child];
    if (assetName(md.normalizeLinkText(child.attrGet("src") ?? ""))) return [child];
    // src は markdown-it が URL の形に直している（%xx）ので、書いたときの形に戻す
    const source = md.normalizeLinkText(child.attrGet("src") ?? "");
    const title = child.attrGet("title");
    const text = new TokenClass("text", "", 0);
    text.content = `![${child.content}](${linkDestination(source)}${title ? ` "${title.replace(/["\\]/g, "\\$&")}"` : ""})`;
    return [new TokenClass("md_raw_inline_open", "", 1), text, new TokenClass("md_raw_inline_close", "", -1)];
  });
}

function taskMark(inline: Token | undefined): RegExpExecArray | null {
  const first = inline?.children?.[0];
  if (inline?.type !== "inline" || first?.type !== "text" || !TASK_MARK.test(first.content)) return null;
  // 生の中身でも確かめる（`\[ \]` と逃がした文字はチェックにしない）
  return TASK_MARK.exec(inline.content);
}

function stripTaskMark(inline: Token): void {
  inline.content = inline.content.replace(TASK_MARK, "");
  const children = inline.children ?? [];
  const first = children[0];
  if (!first) return;
  first.content = first.content.replace(TASK_MARK, "");
  if (!first.content && children[1]?.type === "softbreak") children.splice(1, 1);
}

/** 箇条書きの全部の項目の先頭が `[ ]`／`[x]` のときだけ、チェックのリストに読み替える（混ざったリストは文字のまま）。 */
function convertTaskLists(tokens: Token[]): void {
  for (let index = 0; index < tokens.length; index++) {
    const open = tokens[index]!;
    if (open.type !== "bullet_list_open") continue;
    const items: { open: Token; close: Token | null; inline: Token; checked: boolean }[] = [];
    let close: Token | null = null;
    let allTasks = true;
    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
      const token = tokens[cursor]!;
      if (token.level === open.level && token.type === "bullet_list_close") {
        close = token;
        break;
      }
      if (token.level !== open.level + 1) continue;
      if (token.type === "list_item_open") {
        const inline = tokens[cursor + 2];
        const match = tokens[cursor + 1]?.type === "paragraph_open" ? taskMark(inline) : null;
        if (!match || !inline) {
          allTasks = false;
          break;
        }
        items.push({ open: token, close: null, inline, checked: match[1] !== " " });
      } else if (token.type === "list_item_close") {
        const last = items[items.length - 1];
        if (last) last.close = token;
      }
    }
    if (!allTasks || !close || items.length === 0 || items.some((item) => !item.close)) continue;
    open.type = "task_list_open";
    close.type = "task_list_close";
    for (const item of items) {
      item.open.type = "task_item_open";
      item.open.attrSet("checked", item.checked ? "true" : "false");
      item.close!.type = "task_item_close";
      stripTaskMark(item.inline);
    }
  }
}
