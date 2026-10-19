import { readFileSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "vitest/config";

// package 単独のテスト（`npm -C packages/docs-ui test`。#18876）。@niho/docs-core（devDependencies の file:../docs-core）の
// ソースを読むので、その dir も読めるようにする。peer（TipTap・markdown-it・React など）は、この package の node_modules の
// 実体を 1 つだけ読む。Mac は apps/docs/vite.config.ts、web は apps/web/vitest.config.ts が、同じことをそれぞれのアプリの
// node_modules の実体で行う（web の CI は web-test がこの package のテストも web の依存で回す）。
const peerDependencies = (dir: string): string[] =>
  Object.keys(
    (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { peerDependencies?: Record<string, string> })
      .peerDependencies ?? {},
  );

const uiDir = path.resolve(__dirname, "../ui");
const docsCoreDir = path.resolve(__dirname, "../docs-core");

export default defineConfig({
  resolve: {
    dedupe: [...new Set([...peerDependencies(__dirname), ...peerDependencies(uiDir)])],
  },
  server: {
    fs: { allow: [__dirname, docsCoreDir, uiDir] },
  },
});
