import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// docs と共有する TypeScript ソースを開発サーバーから読み込めるようにする。
// docs-ui は Web/PWA と同じ画面の部品（エディタ・token。#18876）。
const articleSampleCore = decodeURIComponent(new URL("../../packages/article-style-sample-core/", import.meta.url).pathname);
const sharedPackages = ["docs-core", "docs-ui", "ui", "desktop-account/ts"].map((name) =>
  decodeURIComponent(new URL(`../../packages/${name}/`, import.meta.url).pathname),
);

// npm ci はアプリだけで実行する。共通パッケージの peer もアプリの node_modules へ揃える。
const sharedPeers = [...new Set(sharedPackages.flatMap((dir) => {
  const manifest = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as { peerDependencies?: Record<string, string> };
  return Object.keys(manifest.peerDependencies ?? {});
}))];

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "localhost",
    port: 1420,
    strictPort: true,
    fs: { allow: [".", ...sharedPackages, articleSampleCore] },
  },
  resolve: { dedupe: sharedPeers },
  build: {
    target: "safari16",
    outDir: "dist",
    emptyOutDir: true,
    // 窓 1 枚のデスクトップアプリで、読み込みは手元のファイルから（分割の利点が無い）
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environment: "node",
  },
});
