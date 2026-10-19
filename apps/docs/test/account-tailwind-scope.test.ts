import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const postcssPlugins = require("../postcss.config.cjs").plugins as Parameters<typeof postcss>[0];
const stylesheetPath = fileURLToPath(new URL("../src/styles/account.css", import.meta.url));

describe("docs account Tailwind scope", () => {
  it("keeps generated theme and utilities inside the account root without preflight", async () => {
    const source = await readFile(stylesheetPath, "utf8");
    const result = await postcss(postcssPlugins).process(source, { from: stylesheetPath });
    expect(result.warnings()).toEqual([]);
    let flexUtility: postcss.Rule | undefined;
    let themeTokens: postcss.Rule | undefined;

    result.root.walkRules((rule) => {
      if (rule.selectors.includes(":where([data-docs-app-root]) .docs-account .flex")) flexUtility = rule;
      if (
        rule.selectors.includes(":where([data-docs-app-root]) .docs-account") &&
        rule.nodes?.some((node) => node.type === "decl" && node.prop === "--spacing")
      ) {
        themeTokens = rule;
      }
    });

    expect(flexUtility?.selectors).toContain(":where([data-docs-app-root]) .docs-account .flex");
    expect(
      flexUtility?.nodes?.some(
        (node) => node.type === "decl" && node.prop === "display" && node.value === "flex" && !node.important,
      ),
    ).toBe(true);
    expect(result.css).toContain(".docs-account .text-niho-text");
    expect(themeTokens).toBeDefined();
    expect(
      result.root.nodes?.some(
        (node) => node.type === "atrule" && node.name === "layer" && node.params.trim() === "base" && node.nodes,
      ),
    ).toBe(false);
  });
});
