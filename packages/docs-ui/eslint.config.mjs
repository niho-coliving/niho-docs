import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

import { noFragileTextPxRule } from "../ui/eslint-rules/no-fragile-text-px.mjs";

// NIHO docs の画面の共通部品（niho-docs-ui）の ESLint。apps/web の eslint.config.mjs のうち、どのアプリでも効く規則（フックの規則・
// 固定 px の文字の禁止）だけを持つ。Next.js・web の画面だけの規則は持たない（この package は Next にも Tauri にも依存しない。#18876）。
// packages/ui・packages/photo-editing の eslint.config.mjs と同じ形。
export default [
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**"],
  },
  {
    files: ["**/*.{js,mjs,jsx,ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      niho: { rules: { "no-fragile-text-px": noFragileTextPxRule } },
      "react-hooks": reactHooks,
    },
    rules: {
      "niho/no-fragile-text-px": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
