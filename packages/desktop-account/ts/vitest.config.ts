import { defineConfig } from "vitest/config";

// package 単独のテスト（`npm -C packages/desktop-account/ts test`。CI は desktop-account-ci.yml）。
// jsdom で走るテストはファイルの先頭に `// @vitest-environment jsdom` を書く。
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
