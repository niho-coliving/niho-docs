import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDocsMarkdown, finalizeMarkdown, renderMarkdown, type DocsMarkdown } from "./markdown";

// Mac（apps/docs/src/lib/markdown.ts）と Web/PWA（apps/web/app/app/docs/_lib/docs-editor/markdown.ts）の codec 設定。
// Web は時刻 node を schema に持つが、通常文書は第2引数なしで読み、広い接頭辞の直列化を保つ。
const mac = createDocsMarkdown({ transcriptTimestamps: true });
const web = createDocsMarkdown({
  transcriptTimestamps: true,
  timestampSeekEnabled: false,
  preserveLooseTimestampTextPrefix: true,
});
const CODECS: Array<[string, DocsMarkdown]> = [
  ["Mac の引数", mac],
  ["Web の引数", web],
];

describe.each(CODECS)("%s", (_name, codec) => {
  const { canonicalMarkdown, docToMarkdown, isMarkdownChanged, markdownToDoc } = codec;

  function roundTrip(markdown: string): string {
    return finalizeMarkdown(docToMarkdown(markdownToDoc(markdown)));
  }

  function types(markdown: string): string[] {
    const names: string[] = [];
    markdownToDoc(markdown).descendants((node) => {
      if (!node.isText) names.push(node.type.name);
    });
    return names;
  }

  describe("Markdown の往復（ブロック）", () => {
    it.each([
      ["段落", "一段落目です。\n\n二段落目です。\n"],
      ["見出し 1〜3", "# 題\n\n## 中見出し\n\n### 小見出し\n"],
      ["箇条書き", "- 一つ目\n- 二つ目\n"],
      ["入れ子の箇条書き", "- 親\n  - 子\n    - 孫\n- 次\n"],
      ["番号付き", "1. 一\n2. 二\n"],
      ["番号付き（start 付き）", "3. 三\n4. 四\n"],
      ["番号付き（桁が変わる）", " 9. 九\n10. 十\n"],
      ["チェック", "- [ ] やること\n- [x] 済んだこと\n"],
      ["空のチェック", "- [ ]\n- [x] 済み\n"],
      ["入れ子を持つチェック", "- [ ] 親\n  - 子の箇条書き\n- [x] 次\n"],
      ["チェックの中のチェック", "- [ ] 親\n  - [x] 子\n"],
      ["引用", "> 引用の一行目\n>\n> 二段落目\n"],
      ["引用の中のリスト", "> - 一\n> - 二\n"],
      ["コード（言語付き）", "```ts\nconst a = 1;\n\nconst b = 2;\n```\n"],
      ["コード（言語なし）", "```\nplain\n```\n"],
      ["区切り線", "前\n\n---\n\n後\n"],
      ["表", "| 項目 | 内容 |\n| --- | :---: |\n| 字数 | 2,500字 |\n"],
      ["揃えのある表", "| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| a | b | c |\n"],
      ["セルに縦線のある表", "| 式 | 意味 |\n| --- | --- |\n| a \\| b | または |\n"],
      ["引用の中の表", "> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n"],
      ["画像", "前 ![絵](x.png) 後\n"],
      ["案件の画像", "前 ![写真](niho-docs-asset:abc123.png) 後\n"],
      ["題付きの画像", "![外観](photos/house.jpg \"外観\")\n"],
      ["空白を含む画像", "![図](<my photo.png>)\n"],
      ["リンクの中の画像", "[![図](x.png)](https://niho.life)\n"],
      ["文字起こし", "[00:00:12] 話者1: 今日は鎌倉の話。\n\n[01:02:05] 話者2: 次の話です。\n"],
    ])("%s", (_case, markdown) => {
      expect(roundTrip(markdown)).toBe(markdown);
    });

    it("チェックと箇条書きが隣り合っても、別のリストのまま往復する", () => {
      const markdown = "- [ ] やること\n\n* 箇条書き\n";
      expect(types(markdown)).toEqual(["taskList", "taskItem", "paragraph", "bulletList", "listItem", "paragraph"]);
      expect(roundTrip(markdown)).toBe(markdown);
    });

    it("案件の画像だけを画像ノードにし、外部・不正な参照は文字のまま残す", () => {
      expect(types("![写真](niho-docs-asset:abc123.png)\n")).toContain("docAssetImage");
      expect(types("![写真](https://niho.life/p.png)\n")).not.toContain("docAssetImage");
      expect(types("![写真](niho-docs-asset:../p.png)\n")).not.toContain("docAssetImage");
    });

    it("案件内assetだけを画像nodeにし、外部・未対応画像の記法を保持する", () => {
      const source = "![写真](niho-docs-asset:abc_123.webp)\n\n![外部](https://example.com/a.png)\n\n![未対応](niho-docs-asset:../wrong.png)\n";
      const doc = markdownToDoc(source);
      const found: string[] = [];
      doc.descendants((node) => {
        found.push(node.type.name);
      });
      expect(found.filter((type) => type === "docAssetImage")).toHaveLength(1);
      const output = docToMarkdown(doc);
      expect(output).toContain("![写真](niho-docs-asset:abc_123.webp)");
      expect(output).toContain("![外部](https://example.com/a.png)");
      expect(output).toContain("![未対応](niho-docs-asset:../wrong.png)");
    });

    it("同じ種類のリストが隣り合っても、別のリストのまま往復する", () => {
      const markdown = "1. 一\n2. 二\n\n\n1) 別の一\n";
      expect(types(markdown).filter((name) => name === "orderedList")).toHaveLength(2);
      expect(roundTrip(markdown)).toBe(markdown);
    });
  });

  describe("Markdown の往復（書式）", () => {
    it.each([
      ["太字", "これは**太字**です。\n"],
      ["斜体", "これは*斜体*です。\n"],
      ["取り消し", "これは~~取り消し~~です。\n"],
      ["コード", "これは`code`です。\n"],
      ["リンク", "[NIHO](https://niho.life \"題\") を見る。\n"],
      ["重ねた書式", "**~~太字の取り消し~~** と***太字の斜体***。\n"],
      ["見出しの中の書式", "## **太字**の見出し\n"],
      ["リストの中の書式", "- **太字**と[リンク](https://niho.life)\n"],
    ])("%s", (_case, markdown) => {
      expect(roundTrip(markdown)).toBe(markdown);
    });
  });

  describe("Markdown の読み替え", () => {
    it("全部の項目が [ ]／[x] の箇条書きだけをチェックにする（混ざったリストは文字のまま）", () => {
      expect(types("- [ ] a\n- [X] b\n")).toEqual(["taskList", "taskItem", "paragraph", "taskItem", "paragraph"]);
      expect(markdownToDoc("- [X] b\n").firstChild?.firstChild?.attrs.checked).toBe(true);
      expect(types("- [ ] a\n- b\n")).toEqual(["bulletList", "listItem", "paragraph", "listItem", "paragraph"]);
      expect(canonicalMarkdown("- [ ] a\n- b\n")).toBe("- \\[ \\] a\n- b\n");
      // 逃がした印はチェックにしない（今の版で保存した形）
      expect(types("- \\[ \\] a\n")).toEqual(["bulletList", "listItem", "paragraph"]);
      // 番号付きはチェックにしない
      expect(types("1. [ ] a\n")).toEqual(["orderedList", "listItem", "paragraph"]);
    });

    it("チェックの印の後ろの空白を詰め、* の箇条書きも読む", () => {
      expect(canonicalMarkdown("* [x]   済み\n")).toBe("- [x] 済み\n");
      expect(canonicalMarkdown("- [ ]\n")).toBe("- [ ]\n");
    });

    it("表と画像は文字として持つ", () => {
      const doc = markdownToDoc("| a | b |\n| - | - |\n| 1 |\n\n前 ![絵](写真.png) 後\n");
      expect(doc.child(0).type.name).toBe("markdownRaw");
      // 足りないセルは空で埋めた形にそろえる
      expect(doc.child(0).textContent).toBe("| a | b |\n| --- | --- |\n| 1 |  |");
      const paragraph = doc.child(1);
      expect(paragraph.textContent).toBe("前 ![絵](写真.png) 後");
      expect(paragraph.child(1).marks.map((mark) => mark.type.name)).toEqual(["markdownRawInline"]);
    });
  });

  describe("保存の形", () => {
    it("見出し・段落・太字・箇条書きを往復させる", () => {
      const markdown = "# 題\n\n本文の**太字**です。\n\n- 一つ目\n- 二つ目\n\n## 見出し\n\n1. 番号\n2. 二番\n\n> 引用\n";
      expect(canonicalMarkdown(markdown)).toBe(markdown);
    });

    it("文字起こしの時刻 [hh:mm:ss] は逃がさない", () => {
      const transcript = "[00:00:12] 今日は *鎌倉* の話。\n\n[01:02:05] 次の話です。\n";
      expect(canonicalMarkdown(transcript)).toBe("[00:00:12] 今日は *鎌倉* の話。\n\n[01:02:05] 次の話です。\n");
      expect(canonicalMarkdown("文中の [00:00:12] は逃がす\n")).toBe("文中の \\[00:00:12\\] は逃がす\n");
    });

    it("書き方の違いだけでは変更にしない。画像は消さずに文字のまま残す", () => {
      expect(isMarkdownChanged("* a\n* b\n", "- a\n- b\n")).toBe(false);
      expect(isMarkdownChanged("本文\n", "本文を直した\n")).toBe(true);
      expect(canonicalMarkdown("前 ![絵](x.png) 後\n")).toBe("前 ![絵](x.png) 後\n");
    });
  });

  describe("今の版で保存した Markdown は変わらない（不動点）", () => {
    const directory = fileURLToPath(new URL("./fixtures/markdown/", import.meta.url));
    const names = readdirSync(directory).filter((name) => name.endsWith(".md"));

    it("fixture がある", () => {
      expect(names.length).toBeGreaterThanOrEqual(4);
    });

    it.each(names)("%s", (name) => {
      const saved = readFileSync(join(directory, name), "utf8");
      expect(canonicalMarkdown(saved)).toBe(saved);
    });
  });
});

describe("保存の形と逐次表示（引数に依らない）", () => {
  it("保存の形は末尾が改行 1 つ。HTML は文字として表示する", () => {
    expect(finalizeMarkdown("本文\n\n\n")).toBe("本文\n");
    expect(finalizeMarkdown("  \n")).toBe("");
    expect(renderMarkdown("<script>x</script>\n\n**太字**")).toContain("&lt;script&gt;");
    expect(renderMarkdown("**太字**")).toContain("<strong>太字</strong>");
  });
});

describe("Mac と Web の引数の違い", () => {
  it("両方の schema に時刻 node があり、ほかの拡張の並びも同じ", () => {
    expect(mac.markdownSchema.nodes.transcriptTimestamp).toBeDefined();
    expect(web.markdownSchema.nodes.transcriptTimestamp).toBeDefined();
    expect(mac.buildEditorExtensions().map((extension) => extension.name)).toEqual(web.buildEditorExtensions().map((extension) => extension.name));
  });

  it("Web は通常文書を text のまま読み、時刻付き成果物だけ node にする", () => {
    const source = "[00:00:12] 話者1: 本文\n";
    const plainNames: string[] = [];
    web.markdownToDoc(source).descendants((node) => {
      plainNames.push(node.type.name);
    });
    expect(plainNames).toEqual(["paragraph", "text"]);
    const transcriptNames: string[] = [];
    web.markdownToDoc(source, true).descendants((node) => {
      transcriptNames.push(node.type.name);
    });
    expect(transcriptNames).toEqual(["paragraph", "transcriptTimestamp", "text"]);
  });

  it("分・秒が 59 を超える時刻風の接頭辞は、Mac は逃がし、Web は形だけを見て逃がさない（それぞれ今の保存の形）", () => {
    const markdown = "[00:60:00] 話者1: 本文\n";
    expect(mac.canonicalMarkdown(markdown)).toBe("\\[00:60:00\\] 話者1: 本文\n");
    expect(web.canonicalMarkdown(markdown)).toBe(markdown);
    expect(web.docToMarkdown(web.markdownToDoc(markdown, false))).toBe(markdown.trimEnd());
  });
});
