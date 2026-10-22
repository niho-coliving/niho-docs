#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { packReleaseSet, SdkReleaseError } from "./release-set-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArguments(argv) {
  const values = {};
  let toolingWorktree = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--tooling-worktree") {
      if (toolingWorktree) throw new SdkReleaseError("--tooling-worktree が重複しています");
      toolingWorktree = true;
      continue;
    }
    if (key !== "--source-sha" && key !== "--output") throw new SdkReleaseError("使い方: pack-release-set.mjs --source-sha FULLSHA --output DIR [--tooling-worktree]");
    const value = argv[++index];
    if (!value || value.startsWith("--") || values[key]) throw new SdkReleaseError("pack引数が不正です");
    values[key] = value;
  }
  if (!values["--source-sha"] || !values["--output"]) throw new SdkReleaseError("--source-sha と --output が必要です");
  return { sourceSha: values["--source-sha"], outputDirectory: path.resolve(values["--output"]), toolingWorktree };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = packReleaseSet({ repoRoot, ...options });
  console.log(`Docs SDK release setを生成しました: ${path.join(options.outputDirectory, result.manifestFile)}`);
  if (options.toolingWorktree) console.warn("注意: worktree-preview manifestはreleaseできません");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Docs SDK release setの生成に失敗しました");
  process.exitCode = 1;
}
