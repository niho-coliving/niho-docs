#!/usr/bin/env node
// sidecar-lock.mjs — NIHO docs に同梱する文字起こし sidecar（niho-speech、S1-C #18403）の版と指紋の固定・照合（S4 #18385）。
// NIHO Desktop の apps/desktop/scripts/develop-sidecars-lock.mjs の写し（sidecar は 1 つ・校正なし・エンジンの公開とは別にしない）。
//
// sidecar はソースからビルドする（再現可能なバイト列ではない）ので、apps/docs/sidecar.lock.json には次を書く:
//   nihoSpeech.version            ソースの版（Sources/NihoSpeech/Tool.swift の `static let version`。`niho-speech version` が
//                                 {"name":"niho-speech","version":"X.Y.Z"} で答える）
//   nihoSpeech.swiftToolsVersion  Package.swift の `swift-tools-version`（ビルドに要る Swift）
//   nihoSpeech.signingIdentifier  .app の中の sidecar の署名 ID。SpeechAnalyzer の言語の予約は実行ファイルの署名 ID ごと
//                                 （sidecar/niho-speech/README.md「probe・download」）なので、版を上げても変えない
//   sources                       ソースの指紋（下の SOURCE_PATHS のファイルの `<sha256>  <path>` を並べた文字列の SHA-256）と数
// sidecar または共有 Apple 音声 package（Package.swift・Package.resolved・Sources/）を変えたら `update` で lock を書き直す
// （lock は出荷対象なので、その PR が main に入ると docs-release.yml が次の版を採番して公開する。PR では版を触らない）。
// docs-ci が `check` で lock と今のソースを照らす。配布のビルド（build-dmg.sh）は `check`・`check-binary`・`check-app` を通す。
//
// 使い方:
//   node apps/docs/scripts/sidecar-lock.mjs fingerprint [--verbose]   今のソースの指紋（--verbose はファイルごと）
//   node apps/docs/scripts/sidecar-lock.mjs check                     lock と今のソースが合うか
//   node apps/docs/scripts/sidecar-lock.mjs update                    lock を今のソースで書き直す
//   node apps/docs/scripts/sidecar-lock.mjs check-binary --binary src-tauri/binaries/niho-speech-aarch64-apple-darwin
//     ビルドした実行ファイルが NIHO docs と同じ環境（HOME と PATH だけ・cwd /）で lock の版を答え、arm64 で、macOS の外の
//     dylib を読まないか
//   node apps/docs/scripts/sidecar-lock.mjs check-app --app "…/NIHO docs.app"
//     .app の Contents/MacOS/niho-speech が check-binary を通り、署名 ID が lock どおりか
//   node apps/docs/scripts/sidecar-lock.mjs self-test
//
// 終了コード: 0 = 合っている / 1 = 合わない・壊れている / 2 = 使い方の誤り
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const LOCK_REL = "apps/docs/sidecar.lock.json";
const SIDECAR_NAME = "niho-speech";
const TOOL_REL = "apps/docs/sidecar/niho-speech";
const APPLE_SPEECH_REL = "packages/apple-speech";
const VERSION_SOURCE_REL = `${TOOL_REL}/Sources/NihoSpeech/Tool.swift`;
const PACKAGE_REL = `${TOOL_REL}/Package.swift`;
/** ソースの指紋に入れるもの（リポジトリの root からのパス。フォルダはその下の全部。無いパスは無視される）。テスト・README は入れない。 */
const SOURCE_PATHS = [
  PACKAGE_REL,
  `${TOOL_REL}/Package.resolved`,
  `${TOOL_REL}/Sources`,
  `${APPLE_SPEECH_REL}/Package.swift`,
  `${APPLE_SPEECH_REL}/Package.resolved`,
  `${APPLE_SPEECH_REL}/Sources`,
];
// 署名 ID はビルドしたときの実行ファイルの名前（swift build の linker の ad-hoc 署名。Tauri の externalBin は名前を変えずに入れる）
const SIGNING_IDENTIFIER = SIDECAR_NAME;
// sidecar に渡す環境変数（NIHO docs の src-tauri/src/process.rs と同じく、HOME と PATH だけで動くこと）
const SIDECAR_ENV = () => ({ HOME: os.homedir(), PATH: "/usr/bin:/bin" });
// Mach-O（thin / fat）の先頭 4 バイト
const MACHO_MAGICS = new Set(["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca"]);

const EXIT = { ok: 0, mismatch: 1, usage: 2 };

class LockError extends Error {
  constructor(message, exitCode = EXIT.mismatch) {
    super(message);
    this.exitCode = exitCode;
  }
}

const STALE_LOCK_HINT =
  "sidecar のソースを変えたら lock を更新してください（同梱する sidecar が変わるので、main に入ると次の版で公開される。版は触らない）: " +
  "node apps/docs/scripts/sidecar-lock.mjs update";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) throw new LockError(`unknown argument: ${arg}`, EXIT.usage);
    const key = arg.slice(2);
    if (key === "verbose") {
      options[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined) throw new LockError(`${arg} needs a value`, EXIT.usage);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new LockError(`${label} を読めません: ${file} (${error.message})`);
  }
}

/** バイト順の比較（localeCompare は環境で並びが変わりうるので使わない）。 */
function byteOrder(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// --- ソースの指紋 ---------------------------------------------------------------

/**
 * 指紋に入れるファイル（リポジトリの root からのパス）。git が追跡しているものと、まだ追加していないが無視されていない
 * もの（`git ls-files -co --exclude-standard`。`.build/` などの成果物は入らない）のうち、今あるふつうのファイル。
 */
function sourceFiles(repoRoot) {
  const run = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "-co", "--exclude-standard", "--", ...SOURCE_PATHS], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new LockError(`git ls-files に失敗しました（${run.stderr?.trim() || `status ${run.status}`}）`);
  }
  const files = new Set();
  for (const file of run.stdout.split("\0")) {
    if (!file || path.posix.basename(file) === ".DS_Store") continue;
    // 消したがまだコミットしていないファイルは、今のソースに無いので入れない
    if (!fs.lstatSync(path.join(repoRoot, file), { throwIfNoEntry: false })?.isFile()) continue;
    files.add(file);
  }
  if (files.size === 0) throw new LockError(`${TOOL_REL} のソースが見つかりません（--repo-root を確認してください）`);
  return [...files].sort(byteOrder);
}

/** `<sha256>  <path>` を 1 行ずつ並べた文字列の SHA-256（パスも入れるので、名前の変更も変わったとみなす）。 */
export function sourceFingerprint(repoRoot) {
  const entries = sourceFiles(repoRoot).map((file) => [file, sha256Bytes(fs.readFileSync(path.join(repoRoot, file)))]);
  const listing = entries.map(([file, digest]) => `${digest}  ${file}\n`).join("");
  return { fingerprint: sha256Bytes(listing), fileCount: entries.length, entries };
}

// --- 版 -----------------------------------------------------------------------

/** ソースに書かれた版と Swift の tools-version（ビルドしなくても読める）。 */
function sourceVersions(repoRoot) {
  const toolFile = path.join(repoRoot, VERSION_SOURCE_REL);
  const tool = fs.existsSync(toolFile) ? fs.readFileSync(toolFile, "utf8") : "";
  const version = /static let version = "(\d+\.\d+\.\d+)"/.exec(tool)?.[1];
  if (!version) throw new LockError(`${VERSION_SOURCE_REL} に static let version = "X.Y.Z" がありません`);
  const packageFile = path.join(repoRoot, PACKAGE_REL);
  const manifest = fs.existsSync(packageFile) ? fs.readFileSync(packageFile, "utf8") : "";
  const swiftToolsVersion = /^\/\/ swift-tools-version:\s*(\d+(?:\.\d+){0,2})/.exec(manifest)?.[1];
  if (!swiftToolsVersion) throw new LockError(`${PACKAGE_REL} の 1 行目に // swift-tools-version: がありません`);
  return { version, swiftToolsVersion };
}

/** `niho-speech version` の出力（JSON の 1 行）から版を読む。 */
export function parseVersionOutput(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? "").trim());
    return parsed?.name === SIDECAR_NAME && /^\d+\.\d+\.\d+$/.test(parsed?.version ?? "") ? parsed.version : null;
  } catch {
    return null;
  }
}

// --- lock ---------------------------------------------------------------------

function lockPathOf(repoRoot) {
  return path.join(repoRoot, LOCK_REL);
}

function readLock(lockPath) {
  const lock = readJson(lockPath, "lock");
  if (lock.schemaVersion !== 1) throw new LockError(`lock の schemaVersion が 1 ではありません: ${lockPath}`);
  for (const key of ["nihoSpeech", "sources"]) {
    if (!lock[key] || typeof lock[key] !== "object") throw new LockError(`lock に ${key} がありません: ${lockPath}`);
  }
  return lock;
}

function currentLock(repoRoot) {
  const { version, swiftToolsVersion } = sourceVersions(repoRoot);
  const { fingerprint, fileCount } = sourceFingerprint(repoRoot);
  return {
    schemaVersion: 1,
    $comment:
      "NIHO docs に同梱する文字起こし sidecar（niho-speech）の固定。ソースを変えたら sidecar-lock.mjs update（lock は出荷対象なので、main に入ると次の版で公開される。apps/docs/README.md「配布」）。",
    nihoSpeech: { version, swiftToolsVersion, signingIdentifier: SIGNING_IDENTIFIER },
    sources: { fingerprint, fileCount },
  };
}

/** lock と今のソースの違い（無ければ空）。 */
function lockProblems(lock, current) {
  const problems = [];
  for (const key of ["version", "swiftToolsVersion", "signingIdentifier"]) {
    if (lock.nihoSpeech[key] !== current.nihoSpeech[key]) {
      problems.push(`niho-speech の ${key}: lock ${lock.nihoSpeech[key] ?? "（無い）"} / ソース ${current.nihoSpeech[key]}`);
    }
  }
  if (lock.sources.fingerprint !== current.sources.fingerprint) {
    problems.push(
      `ソースの指紋: lock ${String(lock.sources.fingerprint).slice(0, 12)}…（${lock.sources.fileCount} ファイル）/ ` +
        `今 ${current.sources.fingerprint.slice(0, 12)}…（${current.sources.fileCount} ファイル）`,
    );
  }
  return problems;
}

function check(repoRoot, lockPath = lockPathOf(repoRoot)) {
  const lock = readLock(lockPath);
  const problems = lockProblems(lock, currentLock(repoRoot));
  if (problems.length > 0) {
    throw new LockError(
      [
        `${path.relative(repoRoot, lockPath) || lockPath} が今のソースと合いません:`,
        ...problems.map((line) => `  - ${line}`),
        STALE_LOCK_HINT,
      ].join("\n"),
    );
  }
  return lock;
}

function update(repoRoot, lockPath = lockPathOf(repoRoot)) {
  const previous = fs.existsSync(lockPath) ? readJson(lockPath, "lock") : null;
  const lock = currentLock(repoRoot);
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const changed = previous?.sources?.fingerprint !== lock.sources.fingerprint || previous?.nihoSpeech?.version !== lock.nihoSpeech.version;
  console.log(
    `lock を${changed ? "更新しました" : "書き直しました（ソースの指紋は同じ）"}: niho-speech ${lock.nihoSpeech.version}・` +
      `swift-tools-version ${lock.nihoSpeech.swiftToolsVersion}・ソース ${lock.sources.fileCount} ファイル（${lock.sources.fingerprint.slice(0, 12)}…）`,
  );
  if (changed) console.log("lock は出荷対象です。この変更が main に入ると、docs-release.yml が次の版を採番して公開します（版は触らない）。");
  return lock;
}

// --- ビルドした実行ファイルの照合 ---------------------------------------------------

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
}

function isMachO(executable) {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(executable, "r");
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  return MACHO_MAGICS.has(head.toString("hex"));
}

/**
 * Mach-O なら、arm64 だけで、読む dylib が macOS の中（/usr/lib・/System）だけか（Swift のツールチェーンの back-deploy の
 * dylib や Homebrew に依存すると、ビルドした Mac では動いても配った Mac で起動しない）。Mach-O でなければ見ない（self-test の偽物）。
 */
function machOProblems(executable) {
  if (!isMachO(executable)) return [];
  const problems = [];
  const archs = run("lipo", ["-archs", executable]);
  if (archs.status !== 0) problems.push(`lipo -archs ${path.basename(executable)} に失敗しました`);
  else if (archs.stdout.trim() !== "arm64") problems.push(`${path.basename(executable)} が arm64 だけではありません: ${archs.stdout.trim()}`);
  const libs = run("otool", ["-L", executable]);
  if (libs.status !== 0) return [...problems, `otool -L ${path.basename(executable)} に失敗しました`];
  return [
    ...problems,
    ...libs.stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" (")[0])
      .filter((dylib) => dylib && !dylib.startsWith("/usr/lib/") && !dylib.startsWith("/System/"))
      .map((dylib) => `${path.basename(executable)} が macOS の外の dylib を読みます: ${dylib}`),
  ];
}

/** 実行ファイルが NIHO docs と同じ環境で lock の版を答え、arm64 で macOS の外の dylib を読まないか。問題を返す（無ければ空）。 */
function binaryProblems(executable, lock) {
  if (!fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) return [`実行ファイルがありません: ${executable}`];
  if ((fs.statSync(executable).mode & 0o111) === 0) return [`実行できません: ${executable}`];
  const result = run(executable, ["version"], { env: SIDECAR_ENV(), cwd: "/", timeout: 30_000 });
  const version = result.status === 0 ? parseVersionOutput(result.stdout) : null;
  if (!version) {
    return [
      `${SIDECAR_NAME} version に答えません（status ${result.status}, signal ${result.signal ?? "-"}）: ` +
        `${String(result.stdout ?? "").trim()} ${String(result.stderr ?? "").trim()}`,
    ];
  }
  const problems = [];
  if (version !== lock.nihoSpeech.version) {
    problems.push(`${SIDECAR_NAME} の版: 実行ファイル ${version} / lock ${lock.nihoSpeech.version}（ビルドし直すか、lock を更新してください）`);
  }
  return [...problems, ...machOProblems(executable)];
}

function checkBinary(executable, lockPath) {
  const lock = readLock(lockPath);
  const problems = binaryProblems(executable, lock);
  if (problems.length > 0) {
    throw new LockError(["ビルドした niho-speech が lock と合いません:", ...problems.map((line) => `  - ${line}`)].join("\n"));
  }
  console.log(`niho-speech ${lock.nihoSpeech.version} を確かめました（arm64・macOS の dylib だけ）: ${executable}`);
}

/** `codesign -dv` の Identifier（署名が無ければ null）。 */
function signingIdentifier(executable, { codesign = "codesign" } = {}) {
  const result = run(codesign, ["-dv", executable]);
  const match = /^Identifier=(.+)$/m.exec(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return result.status === 0 && match ? match[1].trim() : null;
}

/** できた .app の Contents/MacOS/niho-speech が lock どおりで、NIHO docs と同じ環境で版に答え、署名 ID が変わっていないか。 */
function checkApp(appPath, lockPath, options = {}) {
  const lock = readLock(lockPath);
  const executable = path.join(appPath, "Contents", "MacOS", SIDECAR_NAME);
  const problems = binaryProblems(executable, lock);
  if (problems.length === 0 && isMachO(executable)) {
    const identifier = signingIdentifier(executable, options);
    if (identifier !== lock.nihoSpeech.signingIdentifier) {
      problems.push(
        `Contents/MacOS/${SIDECAR_NAME} の署名 ID: .app ${identifier ?? "（署名なし）"} / lock ${lock.nihoSpeech.signingIdentifier}` +
          "（言語の予約は署名 ID ごと。変えると予約が引き継がれない）",
      );
    }
  }
  if (problems.length > 0) {
    throw new LockError([".app の niho-speech が lock と合いません:", ...problems.map((line) => `  - ${line}`)].join("\n"));
  }
  console.log(`.app の niho-speech を確かめました: ${lock.nihoSpeech.version}・署名 ID ${lock.nihoSpeech.signingIdentifier}`);
}

// --- self-test ------------------------------------------------------------------

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-sidecar-lock-test-"));
  const write = (file, content, mode) => {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    if (mode) fs.chmodSync(full, mode);
  };
  const expectExit = (label, code, fn) => {
    try {
      fn();
    } catch (error) {
      if (error.exitCode === code) return;
      throw new Error(`${label}: expected exit ${code}, got ${error.exitCode}: ${error.message}`);
    }
    throw new Error(`${label}: expected exit ${code}, but it passed`);
  };
  const assert = (condition, label) => {
    if (!condition) throw new Error(`self-test: ${label}`);
  };
  const quiet = (fn) => {
    const log = console.log;
    console.log = () => {};
    try {
      return fn();
    } finally {
      console.log = log;
    }
  };
  try {
    if (spawnSync("git", ["init", "-q", root]).status !== 0) throw new Error("self-test: git init failed");
    write(".gitignore", `${TOOL_REL}/.build/\n`);
    write(PACKAGE_REL, "// swift-tools-version: 6.2\nimport PackageDescription\n");
    write(VERSION_SOURCE_REL, 'enum Tool {\n    static let name = "niho-speech"\n    static let version = "0.1.0"\n}\n');
    write(`${TOOL_REL}/Sources/NihoSpeech/CLI.swift`, "// cli\n");
    write(`${TOOL_REL}/Sources/niho-speech/main.swift`, "// main\n");
    write(`${APPLE_SPEECH_REL}/Package.swift`, "// swift-tools-version: 6.2\nimport PackageDescription\n");
    write(`${APPLE_SPEECH_REL}/Sources/NihoOnDeviceSpeech/Diarizer.swift`, "// shared diarizer\n");
    write(`${TOOL_REL}/Tests/NihoSpeechTests/CLITests.swift`, "// tests\n");
    write(`${TOOL_REL}/README.md`, "# niho-speech\n");
    write(`${TOOL_REL}/.build/release/niho-speech`, "binary");
    const lockPath = lockPathOf(root);

    expectExit("missing lock", EXIT.mismatch, () => check(root));
    const lock = quiet(() => update(root));
    check(root, lockPath);
    assert(lock.nihoSpeech.version === "0.1.0" && lock.nihoSpeech.swiftToolsVersion === "6.2", "versions from the source");
    assert(lock.nihoSpeech.signingIdentifier === "niho-speech", "the signing identifier");
    const listed = sourceFingerprint(root).entries.map(([file]) => file);
    assert(
      listed.includes(PACKAGE_REL) &&
        listed.includes(VERSION_SOURCE_REL) &&
        listed.includes(`${APPLE_SPEECH_REL}/Package.swift`) &&
        listed.includes(`${APPLE_SPEECH_REL}/Sources/NihoOnDeviceSpeech/Diarizer.swift`),
      "sidecar and shared package sources are fingerprinted",
    );
    assert(!listed.some((file) => file.includes("/Tests/") || file.endsWith("README.md") || file.includes(".build")), "tests, docs and build outputs are not");

    // テスト・文書・ビルドの出力を変えても合ったまま
    write(`${TOOL_REL}/Tests/NihoSpeechTests/CLITests.swift`, "// tests 2\n");
    write(`${TOOL_REL}/README.md`, "# niho-speech\nmore\n");
    write(`${TOOL_REL}/.build/release/niho-speech`, "binary 2");
    check(root, lockPath);
    // ソース・版・tools-version を変えたら合わない（まだ追加していないファイルも入る）
    write(`${TOOL_REL}/Sources/NihoSpeech/CLI.swift`, "// cli 2\n");
    expectExit("changed source", EXIT.mismatch, () => check(root, lockPath));
    quiet(() => update(root));
    write(`${TOOL_REL}/Sources/NihoSpeech/New.swift`, "// new\n");
    expectExit("new untracked source", EXIT.mismatch, () => check(root, lockPath));
    quiet(() => update(root));
    write(`${APPLE_SPEECH_REL}/Sources/NihoOnDeviceSpeech/Diarizer.swift`, "// shared diarizer 2\n");
    expectExit("changed shared package source", EXIT.mismatch, () => check(root, lockPath));
    quiet(() => update(root));
    write(VERSION_SOURCE_REL, 'enum Tool {\n    static let name = "niho-speech"\n    static let version = "0.1.1"\n}\n');
    expectExit("changed version", EXIT.mismatch, () => check(root, lockPath));
    quiet(() => update(root));
    write(PACKAGE_REL, "// swift-tools-version: 6.3\nimport PackageDescription\n");
    expectExit("changed swift-tools-version", EXIT.mismatch, () => check(root, lockPath));
    quiet(() => update(root));
    check(root, lockPath);

    assert(parseVersionOutput('{"name":"niho-speech","version":"0.1.1"}\n') === "0.1.1", "version output");
    assert(parseVersionOutput('{"name":"other","version":"0.1.1"}') === null, "another tool");
    assert(parseVersionOutput("niho-speech 0.1.1") === null, "not JSON");

    // 偽の sidecar（sh）で check-binary と check-app
    const fakeTool = (file, version) => {
      write(file, `#!/bin/sh\n[ "$1" = "version" ] && { echo '{"name":"niho-speech","version":"${version}"}'; exit 0; }\nexit 1\n`, 0o755);
      return path.join(root, file);
    };
    const staged = fakeTool("apps/docs/src-tauri/binaries/niho-speech-aarch64-apple-darwin", "0.1.1");
    quiet(() => checkBinary(staged, lockPath));
    expectExit("built version differs from the lock", EXIT.mismatch, () =>
      checkBinary(fakeTool("old/niho-speech", "0.1.0"), lockPath),
    );
    expectExit("missing binary", EXIT.mismatch, () => checkBinary(path.join(root, "nope/niho-speech"), lockPath));
    write("not-executable/niho-speech", "x", 0o644);
    expectExit("not executable", EXIT.mismatch, () => checkBinary(path.join(root, "not-executable/niho-speech"), lockPath));
    const app = path.join(root, "NIHO docs.app");
    fakeTool("NIHO docs.app/Contents/MacOS/niho-speech", "0.1.1");
    quiet(() => checkApp(app, lockPath));
    fakeTool("NIHO docs.app/Contents/MacOS/niho-speech", "0.1.0");
    expectExit("app with an old sidecar", EXIT.mismatch, () => checkApp(app, lockPath));
    fs.rmSync(path.join(app, "Contents/MacOS/niho-speech"));
    expectExit("app without the sidecar", EXIT.mismatch, () => checkApp(app, lockPath));
    console.log("self-test: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options["repo-root"] ?? DEFAULT_REPO_ROOT);
  const lockPath = path.resolve(options.lock ?? lockPathOf(repoRoot));
  switch (command) {
    case "fingerprint": {
      const { fingerprint, fileCount, entries } = sourceFingerprint(repoRoot);
      if (options.verbose) for (const [file, digest] of entries) console.log(`${digest}  ${file}`);
      console.log(`${fingerprint}（${fileCount} ファイル）`);
      return;
    }
    case "check": {
      const lock = check(repoRoot, lockPath);
      console.log(
        `sidecar.lock.json は今のソースと合っています: niho-speech ${lock.nihoSpeech.version}・` +
          `swift-tools-version ${lock.nihoSpeech.swiftToolsVersion}・ソース ${lock.sources.fileCount} ファイル`,
      );
      return;
    }
    case "update":
      update(repoRoot, lockPath);
      return;
    case "check-binary":
      if (!options.binary) throw new LockError("check-binary には --binary が要ります", EXIT.usage);
      checkBinary(path.resolve(options.binary), lockPath);
      return;
    case "check-app":
      if (!options.app) throw new LockError("check-app には --app が要ります", EXIT.usage);
      checkApp(path.resolve(options.app), lockPath);
      return;
    case "self-test":
      selfTest();
      return;
    default:
      throw new LockError(
        `使い方: sidecar-lock.mjs <fingerprint|check|update|check-binary|check-app|self-test> [options]（${command ?? "コマンドなし"}）`,
        EXIT.usage,
      );
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(error.exitCode ?? EXIT.mismatch);
}
