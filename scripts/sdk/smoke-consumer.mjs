#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyReleaseSet } from "./verify-release-set.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const THIRD_PARTY = [
  "react", "react-dom", "@types/react", "@types/react-dom", "@types/node", "@types/markdown-it",
  "@radix-ui/react-dialog", "@radix-ui/react-popover", "@tiptap/core", "@tiptap/extension-list",
  "@tiptap/extension-bubble-menu", "@tiptap/extension-floating-menu", "@tiptap/pm", "@tiptap/react",
  "@tiptap/starter-kit", "@tiptap/suggestion", "clsx", "lucide-react", "markdown-it",
  "prosemirror-markdown", "prosemirror-search", "tailwind-merge",
];

class SmokeError extends Error {}

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CI: "true", npm_config_cache: path.join(cwd, ".npm-cache"), npm_config_offline: "true", npm_config_update_notifier: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const detail = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    throw new SmokeError(`${path.basename(command)} consumer smokeに失敗しました${detail ? `\n${detail}` : ""}`);
  }
}

function linkThirdParty(consumer, name) {
  const source = path.join(repoRoot, "apps/docs/node_modules", ...name.split("/"));
  if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new SmokeError(`既存third-party dependencyがありません: ${name}`);
  const target = path.join(consumer, "node_modules", ...name.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  if (!existsSync(target)) symlinkSync(source, target, "dir");
}

function outputFiles(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? outputFiles(path.join(root, entry.name), relative) : [relative];
  });
}

export function smokeConsumer(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  const raw = JSON.parse(readFileSync(absoluteManifest, "utf8"));
  const allowPreview = raw?.source?.configOrigin === "worktree-preview";
  const manifest = verifyReleaseSet(absoluteManifest, { allowPreview });
  const releaseDirectory = path.dirname(absoluteManifest);
  const consumer = mkdtempSync(path.join(tmpdir(), "niho-docs-sdk-consumer-"));
  try {
    writeFileSync(path.join(consumer, "package.json"), `${JSON.stringify({ name: "niho-docs-sdk-consumer-smoke", private: true, version: "0.0.0", type: "module" }, null, 2)}\n`);
    const tarballs = manifest.packages.map(({ file }) => path.join(releaseDirectory, file));
    run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--legacy-peer-deps", ...tarballs], consumer);
    for (const dependency of THIRD_PARTY) linkThirdParty(consumer, dependency);

    for (const packageName of ["@niho/docs-core", "niho-docs-ui", "niho-docs-sdk-ui"]) {
      const installed = path.join(consumer, "node_modules", ...packageName.split("/"));
      if (lstatSync(installed).isSymbolicLink() || !realpathSync(installed).startsWith(`${realpathSync(consumer)}${path.sep}`)) throw new SmokeError(`SDK packageはtarballから通常directoryとしてinstallする必要があります: ${packageName}`);
    }

    mkdirSync(path.join(consumer, "src"));
    writeFileSync(path.join(consumer, "src/styles.d.ts"), 'declare module "*.css";\n');
    writeFileSync(path.join(consumer, "src/main.tsx"), `
import { DocsApp, type DocsHost, type DocsWorkspaceHost } from "niho-docs-ui";
import { DocsSdkDialogHost } from "niho-docs-ui/sdk-dialog-host";
import { DocsNextStepsEnd, type ContinueMenuAction, type DocsNextStepsView } from "niho-docs-ui/next-steps";
import { DocsStorageModeScreen, type DocsStorageModeScreenProps } from "niho-docs-ui/storage-mode";
import { pageTitle, type PageEntry } from "@niho/docs-core";
import "niho-docs-ui/styles/app.css";
import "niho-docs-sdk-ui/styles/tokens.css";

const continueAction: ContinueMenuAction = () => {};
const nextStepsView: DocsNextStepsView = {
  rows: [{ stepId: "source", label: "原文", status: "done", current: true, statusLabel: "このページ", openable: false }],
  remaining: [], running: false, summary: "すべて完了", startable: false, reason: null, macGuide: false,
  checking: false, placeLine: null, band: null, submitting: false, error: null, notice: null,
  start: continueAction, stop: () => {}, closeBand: () => {}, open: () => {},
};
const storageModeProps: DocsStorageModeScreenProps = { mode: "UNSET", onSelectCloud: () => {}, accountContent: null, recordingRescue: null };
const contracts = { DocsApp, DocsSdkDialogHost, DocsNextStepsEnd, DocsStorageModeScreen, pageTitle, nextStepsView, storageModeProps };
document.body.dataset.docsSdk = Object.keys(contracts).sort().join(",");
export type PublicHosts = DocsHost | DocsWorkspaceHost;
export type PublicPage = PageEntry;
`);
    writeFileSync(path.join(consumer, "index.html"), '<!doctype html><html><body><script type="module" src="/src/main.tsx"></script></body></html>\n');
    writeFileSync(path.join(consumer, "tsconfig.json"), `${JSON.stringify({
      compilerOptions: {
        target: "ES2022", lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext", moduleResolution: "Bundler",
        jsx: "react-jsx", strict: true, noEmit: true, skipLibCheck: true, types: ["node", "react", "react-dom"],
      },
      include: ["src"],
    }, null, 2)}\n`);
    writeFileSync(path.join(consumer, "vite.config.mjs"), 'export default { build: { outDir: "dist", emptyOutDir: true } };\n');
    writeFileSync(path.join(consumer, "server-smoke.mjs"), `
import assert from "node:assert/strict";
import * as core from "@niho/docs-core/server";
assert.equal(typeof core.pageTitle, "function");
assert.equal(globalThis.document, undefined);
`);

    run(process.execPath, [path.join(repoRoot, "apps/docs/node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], consumer);
    run(process.execPath, [path.join(repoRoot, "apps/docs/node_modules/vite/bin/vite.js"), "build", "--config", "vite.config.mjs"], consumer);
    run(process.execPath, [path.join(consumer, "server-smoke.mjs")], consumer);
    const files = outputFiles(path.join(consumer, "dist"));
    if (!files.some((file) => file.endsWith(".css")) || !files.some((file) => file.endsWith(".js"))) throw new SmokeError("Vite bundleにJavaScript/CSS closureがありません");
    const docsUiManifest = JSON.parse(readFileSync(path.join(consumer, "node_modules/niho-docs-ui/package.json"), "utf8"));
    if (docsUiManifest.peerDependencies?.react === undefined || docsUiManifest.peerDependencies?.["react-dom"] === undefined || docsUiManifest.peerDependencies?.["niho-docs-sdk-ui"] !== manifest.version || docsUiManifest.dependencies?.react) throw new SmokeError("React/UI peer singleton契約が不正です");
    return { files };
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv.length !== 2 || argv[0] !== "--manifest" || !argv[1]) throw new SmokeError("使い方: smoke-consumer.mjs --manifest PATH");
    const result = smokeConsumer(argv[1]);
    console.log(`repo外 consumer smokeが通りました（${result.files.length} bundle files）`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "consumer smokeに失敗しました");
    process.exitCode = 1;
  }
}
