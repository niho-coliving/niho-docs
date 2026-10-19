import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postcss, { type Node } from "postcss";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(__dirname);
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}

describe("共通画面の分離", () => {
  it("アプリ・Tauri・Mac アカウント transport を import しない", () => {
    for (const file of files(sourceRoot).filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
        const specifier = match[1]!;
        expect(specifier, path.relative(sourceRoot, file)).not.toMatch(/@tauri-apps|niho-desktop-account|apps\/(?:docs|web|api)/);
        if (specifier.startsWith(".")) expect(path.resolve(path.dirname(file), specifier).startsWith(sourceRoot + path.sep)).toBe(true);
      }
      expect(source, path.relative(sourceRoot, file)).not.toMatch(/\bfetch\s*\(|__TAURI_INTERNALS__/);
    }
  });

  it("すべての画面 CSS を docs の root 内に閉じる", () => {
    for (const file of files(path.join(sourceRoot, "styles")).filter((name) => name.endsWith(".css"))) {
      const css = postcss.parse(readFileSync(file, "utf8"));
      css.walkRules((rule) => {
        for (let parent: Node | undefined = rule.parent; parent; parent = parent.parent) {
          if (
            parent.type === "atrule" &&
            "name" in parent &&
            typeof parent.name === "string" &&
            parent.name.endsWith("keyframes")
          ) return;
        }
        for (const selector of rule.selectors) {
          expect(selector, path.basename(file)).toMatch(/^:where\(\[data-docs-app-root\]\)/);
          // 従来Web layoutのrootにも同じ属性がある。reset・画面のCSSは共有UIのrootだけに適用する。
          if (!file.endsWith("tokens.css")) expect(selector, path.basename(file)).toContain(":where([data-docs-shared-ui])");
        }
      });
    }
  });
});
