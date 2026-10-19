#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(SCRIPT_DIR, "..");
const PACKAGE_DIR = path.join(DOCS_DIR, "sidecar/niho-speech");
const STAGE_DIR = path.join(DOCS_DIR, "src-tauri/binaries");
const TARGET_TRIPLE = "aarch64-apple-darwin";
export const RESOURCE_BUNDLES = ["NihoOnDeviceSpeech_NihoOnDeviceSpeech.bundle", "FluidAudio_FluidAudio.bundle"];

function normalizeResourceCopyPermissions(resourcePath) {
  const stat = fs.lstatSync(resourcePath);
  if (stat.isDirectory()) {
    fs.chmodSync(resourcePath, 0o755);
    for (const name of fs.readdirSync(resourcePath)) {
      normalizeResourceCopyPermissions(path.join(resourcePath, name));
    }
  } else if (stat.isFile()) {
    // SwiftPM can preserve read-only SDK resources. Tauri's xattr cleanup and
    // signing need owner-writable copies; never chmod the upstream products.
    fs.chmodSync(resourcePath, 0o644);
  } else {
    throw new Error(`unsupported SwiftPM resource entry: ${resourcePath}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? "signal"}): ${result.stderr?.trim() ?? ""}`);
  }
  return result;
}

export function stageBuiltArtifacts({ productsDirectory, stageDirectory = STAGE_DIR }) {
  const executable = path.join(productsDirectory, "niho-speech");
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`niho-speech executable is missing: ${executable}`);
  }
  for (const name of RESOURCE_BUNDLES) {
    if (!fs.statSync(path.join(productsDirectory, name), { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`SwiftPM resource bundle is missing: ${name}`);
    }
  }

  fs.mkdirSync(stageDirectory, { recursive: true, mode: 0o700 });
  const stagedExecutable = path.join(stageDirectory, `niho-speech-${TARGET_TRIPLE}`);
  fs.copyFileSync(executable, stagedExecutable);
  fs.chmodSync(stagedExecutable, 0o755);

  const stagedResources = path.join(stageDirectory, "resources");
  fs.rmSync(stagedResources, { recursive: true, force: true });
  fs.mkdirSync(stagedResources, { recursive: true, mode: 0o700 });
  for (const name of RESOURCE_BUNDLES) {
    fs.cpSync(path.join(productsDirectory, name), path.join(stagedResources, name), {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
    normalizeResourceCopyPermissions(path.join(stagedResources, name));
  }
  return { executable: stagedExecutable, resources: RESOURCE_BUNDLES.map((name) => path.join(stagedResources, name)) };
}

export function buildAndStage() {
  const buildArguments = ["build", "-c", "release", "--package-path", PACKAGE_DIR];
  run("swift", buildArguments, { stdio: "inherit" });
  const productsDirectory = run("swift", [...buildArguments, "--show-bin-path"]).stdout.trim();
  if (!path.isAbsolute(productsDirectory)) throw new Error(`SwiftPM returned a non-absolute products path: ${productsDirectory}`);
  return stageBuiltArtifacts({ productsDirectory });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const staged = buildAndStage();
    console.log(`staged ${staged.executable} and ${staged.resources.length} resource bundles`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
