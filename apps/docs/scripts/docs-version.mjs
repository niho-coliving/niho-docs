#!/usr/bin/env node
// docs-version.mjs — NIHO docs の版の採番と、5 か所の版の書き換え（S4 #18385・#18744）。NIHO Desktop の
// apps/desktop/scripts/desktop-version.mjs（#16407）の写しから始まった。
//
// PR では版を触らない。出荷対象（配布する .app の中身を変えるファイル）を変えた PR が main に入ると、docs-release.yml
// （ci-docs-release.sh plan）が公開済みの tag（docs-v<版>-<sha12>）から次の版を採番し、publish が作業場の 5 か所をその版に
// 書き換えて（apply。main には commit しない。公開した版は tag の名前に残る）ビルドして公開する。並行の PR が同じ番号を
// 取り合って上げ直すことは無い（#18744・owner 2026-10-17）。
//
// 版は 5 か所にあり、自動更新（Tauri updater）は tauri.conf.json の版を見て、.app の Info.plist も tauri.conf.json の版になるので、
// ずれると更新が届かない。ここで 5 か所をまとめて扱う:
//   apps/docs/package.json・package-lock.json（先頭と packages[""]）・src-tauri/tauri.conf.json・
//   src-tauri/Cargo.toml（[package]）・Cargo.lock（apps/docs の workspace の lock の niho_docs）
// main の 5 か所の版は「床」: 次の版は max(床, 公開済みの最大の patch + 1)。普段は誰も触らない（minor・major を上げたいとき
// だけ、bump で床を上げる PR を出す）。
//
// 使い方:
//   node apps/docs/scripts/docs-version.mjs current
//   node apps/docs/scripts/docs-version.mjs check
//   git ls-remote --tags origin 'refs/tags/docs-v*' | node apps/docs/scripts/docs-version.mjs next     次の版（床と公開済みの tag から）
//   git ls-remote --tags origin 'refs/tags/docs-v*' | node apps/docs/scripts/docs-version.mjs latest   公開済みで semver が最大の tag
//   node apps/docs/scripts/docs-version.mjs apply X.Y.Z                       5 か所を X.Y.Z にする（公開の workflow が使う。下げない）
//   node apps/docs/scripts/docs-version.mjs bump [patch|minor|major|X.Y.Z]   床を上げる（既定 patch）
//   node apps/docs/scripts/docs-version.mjs shipped-changed --from REF [--to REF]
//   node apps/docs/scripts/docs-version.mjs self-test
//
// next・latest は標準入力の tag 名を読む（refs/tags/ 付き・^{} 付き・ls-remote の `<sha>\trefs/tags/...` の行でもよい。
// docs-v<X.Y.Z>-<sha> の形でない行は数えない）。latest は公開済みの tag が無ければ何も出さない（終了コード 0）。
//
// 終了コード: 0 = 問題なし / 1 = 版がずれている・下がる / 2 = 使い方の誤り
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tty from "node:tty";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const DOCS_REL = "apps/docs";
const DOCS_CORE_REL = "packages/docs-core";
// Mac と Web/PWA の画面の共通部品（#18876）。vite が画面に束ねる
const DOCS_UI_REL = "packages/docs-ui";
// NIHO クラウドの保管庫の crate（C3 #18595）。src-tauri が path でリンクする
const VAULT_REL = "packages/desktop-vault";
const CRATE_NAME = "niho_docs";
const TAURI_CONF_REL = `${DOCS_REL}/src-tauri/tauri.conf.json`;

const EXIT = { ok: 0, mismatch: 1, usage: 2 };

class VersionError extends Error {
  constructor(message, exitCode = EXIT.mismatch) {
    super(message);
    this.exitCode = exitCode;
  }
}

// --- 出荷対象 -----------------------------------------------------------------
// 配布する .app の中身を変えるファイル。最後の公開からここが変わっていれば、公開の workflow が次の版で公開する。NIHO docs は
// 画面も同梱する（frontendDist が dist/）ので、画面のソース（src/・index.html・vite.config.ts）と、画面に束ねる packages/docs-core・
// packages/docs-ui の src/ も出荷対象（NIHO camera と同じ）。
// Rust は src-tauri と、path でリンクする crates/local-ai・packages/desktop-vault（src/ と Cargo.toml。crate の Cargo.lock は
// workspace のビルドでは使わない）、workspace の Cargo.toml（profile）と Cargo.lock。文字起こし sidecar（sidecar/niho-speech）は
// ソースの指紋を sidecar.lock.json に書くので、lock が出荷対象になる（ソースを変えたら sidecar-lock.mjs check が落とし、lock を
// 更新した PR が main に入ると公開される）。
// テスト・文書・通常のscripts・偽物は除外する。sidecarのresourceを同梱するstagingだけは出荷物を変えるため含める。
const SHIPPED_FILES = new Set([
  `${DOCS_REL}/scripts/stage-speech-sidecar.mjs`,
  `${DOCS_REL}/package.json`,
  `${DOCS_REL}/package-lock.json`,
  `${DOCS_REL}/index.html`,
  `${DOCS_REL}/vite.config.ts`,
  `${DOCS_REL}/tailwind.config.cjs`,
  `${DOCS_REL}/postcss.config.cjs`,
  `${DOCS_UI_REL}/package.json`,
  "packages/ui/package.json",
  "packages/ui/tailwind-theme.cjs",
  "packages/desktop-account/Cargo.toml",
  "packages/desktop-account/build.rs",
  "packages/desktop-account/ts/package.json",
  `${DOCS_REL}/Cargo.toml`,
  `${DOCS_REL}/Cargo.lock`,
  `${DOCS_REL}/sidecar.lock.json`,
  `${DOCS_REL}/crates/local-ai/Cargo.toml`,
  `${VAULT_REL}/Cargo.toml`,
]);
const UI_PREFIXES = [`${DOCS_REL}/src/`, `${DOCS_CORE_REL}/src/`, `${DOCS_UI_REL}/src/`, "packages/ui/src/", "packages/desktop-account/ts/src/"];
const TAURI_PREFIX = `${DOCS_REL}/src-tauri/`;
const CRATE_SRC_PREFIX = `${DOCS_REL}/crates/local-ai/src/`;
const VAULT_SRC_PREFIX = `${VAULT_REL}/src/`;

export function isShippedPath(file) {
  if (SHIPPED_FILES.has(file)) return true;
  for (const prefix of UI_PREFIXES) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    return !/\.test\.[cm]?[jt]sx?$/.test(rest) && !/\.md$/i.test(rest);
  }
  if (file.startsWith("packages/desktop-account/permissions/")) return true;
  const rustPrefixes = ["packages/desktop-account/src/", CRATE_SRC_PREFIX, VAULT_SRC_PREFIX];
  if (rustPrefixes.some((prefix) => file.startsWith(prefix))) {
    return file.endsWith(".rs") && !file.endsWith("_tests.rs");
  }
  if (!file.startsWith(TAURI_PREFIX)) return false;
  const rest = file.slice(TAURI_PREFIX.length);
  if (rest.startsWith("tests/") || rest.startsWith("target/") || rest.startsWith("gen/") || rest.startsWith("binaries/")) return false;
  if (rest.endsWith("_tests.rs") || /\.md$/i.test(rest)) return false;
  return true;
}

// --- 版 ---------------------------------------------------------------------
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(version) {
  const match = SEMVER_RE.exec(String(version ?? ""));
  if (!match) throw new VersionError(`版は X.Y.Z の形にしてください: ${version}`);
  return match.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function nextVersion(current, kind) {
  if (SEMVER_RE.test(kind)) {
    if (compareVersions(kind, current) <= 0) throw new VersionError(`${kind} は今の版 ${current} より大きくしてください`);
    return kind;
  }
  const [major, minor, patch] = parseVersion(current);
  switch (kind) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      throw new VersionError(`bump は patch|minor|major|X.Y.Z のどれかです: ${kind}`, EXIT.usage);
  }
}

// --- 公開済みの tag と採番 ---------------------------------------------------------
// publish-dmg.sh が作る tag は docs-v<版>-<HEAD の 12 桁>。版の各桁は先頭 0 なし（0.1.09 のような tag は数えない）。
const DOCS_TAG_RE =
  /^(?:[0-9a-f]+\s+)?(?:refs\/tags\/)?(docs-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-[0-9a-f]+)(?:\^\{\})?$/;

/** tag 名（refs/tags/ 接頭辞・^{} 接尾辞・ls-remote の行も可）を { tag, version } に。合わなければ null。 */
function parseDocsTag(text) {
  const match = DOCS_TAG_RE.exec(String(text ?? "").trim());
  return match ? { tag: match[1], version: match[2] } : null;
}

/** `docs-v<X.Y.Z>-<sha>` の版（X.Y.Z）。refs/tags/ 接頭辞・^{} 接尾辞・ls-remote の行も受ける。合わなければ null。 */
export function parseDocsTagVersion(text) {
  return parseDocsTag(text)?.version ?? null;
}

/** 標準入力などの複数行から、公開済みの tag を重複なしで（注釈付き tag の ^{} の行は同じ tag として 1 つに）。 */
export function publishedDocsTags(text) {
  const tags = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const parsed = parseDocsTag(line);
    if (parsed && !tags.has(parsed.tag)) tags.set(parsed.tag, parsed);
  }
  return [...tags.values()];
}

/** 公開済みの tag のうち semver が最大のもの（同じ版が複数あれば名前の順で先のもの）。無ければ null。 */
export function latestDocsTag(tags) {
  let latest = null;
  for (const entry of tags) {
    if (!latest) {
      latest = entry;
      continue;
    }
    const order = compareVersions(entry.version, latest.version);
    if (order > 0 || (order === 0 && entry.tag < latest.tag)) latest = entry;
  }
  return latest;
}

/** 次に公開する版: 公開済みが無ければ床。あれば max(床, 公開済みの最大の patch + 1)。 */
export function nextReleaseVersion(floor, publishedVersions) {
  parseVersion(floor);
  const versions = [...(publishedVersions ?? [])];
  if (versions.length === 0) return floor;
  const highest = versions.reduce((max, version) => (compareVersions(version, max) > 0 ? version : max));
  const [major, minor, patch] = parseVersion(highest);
  const candidate = `${major}.${minor}.${patch + 1}`;
  return compareVersions(floor, candidate) >= 0 ? floor : candidate;
}

// --- 5 か所の読み書き ----------------------------------------------------------
function paths(repoRoot) {
  const docs = path.join(repoRoot, DOCS_REL);
  return {
    packageJson: path.join(docs, "package.json"),
    packageLock: path.join(docs, "package-lock.json"),
    tauriConf: path.join(repoRoot, TAURI_CONF_REL),
    cargoToml: path.join(docs, "src-tauri/Cargo.toml"),
    cargoLock: path.join(docs, "Cargo.lock"),
  };
}

const read = (file) => fs.readFileSync(file, "utf8");
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function cargoTomlPackageVersion(text) {
  const section = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text);
  return section ? /^version\s*=\s*"([^"]+)"/m.exec(section[1])?.[1] ?? null : null;
}

function cargoLockCrateVersion(text) {
  const pattern = new RegExp(`\\[\\[package\\]\\]\\r?\\nname = "${CRATE_NAME}"\\r?\\nversion = "([^"]+)"`);
  return pattern.exec(text)?.[1] ?? null;
}

export function readVersions(repoRoot) {
  const file = paths(repoRoot);
  const lock = JSON.parse(read(file.packageLock));
  return {
    "package.json": JSON.parse(read(file.packageJson)).version ?? null,
    "package-lock.json": lock.version ?? null,
    'package-lock.json packages[""]': lock.packages?.[""]?.version ?? null,
    "src-tauri/tauri.conf.json": JSON.parse(read(file.tauriConf)).version ?? null,
    "src-tauri/Cargo.toml": cargoTomlPackageVersion(read(file.cargoToml)),
    "Cargo.lock": cargoLockCrateVersion(read(file.cargoLock)),
  };
}

export function check(repoRoot) {
  const versions = readVersions(repoRoot);
  const expected = versions["package.json"];
  const mismatched = Object.entries(versions).filter(([, version]) => version !== expected);
  if (mismatched.length > 0 || !SEMVER_RE.test(expected ?? "")) {
    const lines = Object.entries(versions).map(([where, version]) => `  ${where}: ${version ?? "（見つからない）"}`);
    throw new VersionError(
      [
        "NIHO docs の版が 5 か所でそろっていません:",
        ...lines,
        "5 か所を同じ版に直してください（apply・bump は 5 か所がそろっているときだけ書き換えます）。",
      ].join("\n"),
    );
  }
  return expected;
}

// 書き換えは該当行だけ（ファイル全体を書き直さないので、整形や他の版を変えない）。書いたあと読み直して確かめる。
function replaceFirst(text, pattern, replacement, count, label) {
  let replaced = 0;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const next = text.replace(new RegExp(pattern.source, flags), (match, ...groups) => {
    if (replaced >= count) return match;
    replaced += 1;
    return typeof replacement === "function" ? replacement(match, ...groups) : replacement;
  });
  if (replaced !== count) throw new VersionError(`${label} の版を書き換えられません（${replaced}/${count} か所）`);
  return next;
}

/** 5 か所の版を current → next に書き換える（bump と apply が共有する）。 */
function writeVersions(repoRoot, current, next) {
  const file = paths(repoRoot);
  const jsonVersion = new RegExp(`"version": "${escapeRegExp(current)}"`);
  const writes = [
    [file.packageJson, (text) => replaceFirst(text, jsonVersion, `"version": "${next}"`, 1, "package.json")],
    // package-lock.json は先頭の version と packages[""] の version がファイルの最初の 2 つ
    [file.packageLock, (text) => replaceFirst(text, jsonVersion, `"version": "${next}"`, 2, "package-lock.json")],
    [file.tauriConf, (text) => replaceFirst(text, jsonVersion, `"version": "${next}"`, 1, "tauri.conf.json")],
    [
      file.cargoToml,
      (text) =>
        replaceFirst(
          text,
          /(^\[package\]\s*$[\s\S]*?^version\s*=\s*")[^"]+(")/m,
          (_match, head, tail) => `${head}${next}${tail}`,
          1,
          "Cargo.toml",
        ),
    ],
    [
      file.cargoLock,
      (text) =>
        replaceFirst(
          text,
          new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${CRATE_NAME}"\\r?\\nversion = ")[^"]+(")`),
          (_match, head, tail) => `${head}${next}${tail}`,
          1,
          "Cargo.lock",
        ),
    ],
  ];
  const updated = writes.map(([target, rewrite]) => [target, rewrite(read(target))]);
  for (const [target, text] of updated) fs.writeFileSync(target, text);
  if (check(repoRoot) !== next) throw new VersionError(`書き換えたあとの版が ${next} になっていません`);
}

/** 床を上げる（minor・major を上げたいとき。PR で出す）。 */
export function bump(repoRoot, kind = "patch") {
  const current = check(repoRoot);
  const next = nextVersion(current, kind);
  writeVersions(repoRoot, current, next);
  return { from: current, to: next };
}

/** 5 か所を version にする（公開の workflow が採番した版で。commit しない）。今と同じなら何もしない。下げない。 */
export function apply(repoRoot, version) {
  if (!SEMVER_RE.test(String(version ?? ""))) throw new VersionError(`apply には X.Y.Z の版を渡してください: ${version ?? "（なし）"}`, EXIT.usage);
  const current = check(repoRoot);
  const order = compareVersions(version, current);
  if (order === 0) return { from: current, to: version, changed: false };
  if (order < 0) {
    throw new VersionError(`${version} は今の版（床）${current} より小さいので書き換えません（版は下げない）`);
  }
  writeVersions(repoRoot, current, version);
  return { from: current, to: version, changed: true };
}

// --- git ----------------------------------------------------------------------
function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** from から to（省略時は作業ツリー）までに変わった出荷対象のファイル。 */
export function shippedChanged(repoRoot, from, to) {
  const range = to ? [from, to] : [from];
  const changed = git(repoRoot, [
    "diff",
    "--name-only",
    ...range,
    "--",
    DOCS_REL,
    DOCS_CORE_REL,
    DOCS_UI_REL,
    VAULT_REL,
    "packages/ui",
    "packages/desktop-account",
  ]);
  return changed.split("\n").filter(Boolean).filter(isShippedPath);
}

// --- self-test ----------------------------------------------------------------
function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-version-test-"));
  const put = (file, text) => {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  const run = (...args) => git(root, args);
  const commit = (message) => {
    run("-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
    run("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", message);
    return run("rev-parse", "HEAD");
  };
  const expectFail = (label, fn, code = EXIT.mismatch) => {
    try {
      fn();
    } catch (error) {
      if (error.exitCode === code) return;
      throw new Error(`${label}: expected exit ${code}, got ${error.exitCode}: ${error.message}`);
    }
    throw new Error(`${label}: expected a failure, but it passed`);
  };
  const assert = (condition, label) => {
    if (!condition) throw new Error(`self-test: ${label}`);
  };
  const versionFiles = () => Object.values(paths(root)).map((file) => read(file));
  const cli = (args, input = "") =>
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...args, "--repo-root", root], {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const tauriConf = (version) =>
    `{\n  "productName": "NIHO docs",\n  "version": "${version}",\n  "plugins": { "updater": { "pubkey": "k" }, "x": { "version": "${version}" } }\n}\n`;
  try {
    // --- tag の読み取り ---
    assert(parseDocsTagVersion("docs-v0.1.46-fc26489e4b9a") === "0.1.46", "a bare tag");
    assert(parseDocsTagVersion("refs/tags/docs-v0.1.46-fc26489e4b9a") === "0.1.46", "refs/tags/ prefix");
    assert(parseDocsTagVersion("refs/tags/docs-v0.1.46-fc26489e4b9a^{}") === "0.1.46", "peeled ^{} suffix");
    assert(
      parseDocsTagVersion("fc26489e4b9a0123456789abcdef0123456789ab\trefs/tags/docs-v0.1.46-fc26489e4b9a") === "0.1.46",
      "an ls-remote line",
    );
    assert(parseDocsTagVersion("  docs-v1.20.300-abc1234  ") === "1.20.300", "surrounding spaces");
    assert(parseDocsTagVersion("desktop-v0.1.46-fc26489e4b9a") === null, "another app's tag");
    assert(parseDocsTagVersion("refs/tags/camera-v0.1.46-fc26489e4b9a") === null, "another prefix");
    assert(parseDocsTagVersion("refs/tags/xdocs-v0.1.46-fc26489e4b9a") === null, "a prefix that only ends with docs-v");
    assert(parseDocsTagVersion("docs-v0.1-fc26489e4b9a") === null, "two-part version");
    assert(parseDocsTagVersion("docs-v0.1.09-fc26489e4b9a") === null, "leading zero");
    assert(parseDocsTagVersion("docs-v0.1.x-fc26489e4b9a") === null, "non-numeric version");
    assert(parseDocsTagVersion("docs-v0.1.46") === null, "no sha");
    assert(parseDocsTagVersion("docs-v0.1.46-") === null, "empty sha");
    assert(parseDocsTagVersion("docs-v0.1.46-XYZ") === null, "non-hex sha");
    assert(parseDocsTagVersion("") === null && parseDocsTagVersion(undefined) === null, "empty input");

    const lsRemote = [
      "1111111111111111111111111111111111111111\trefs/tags/docs-v0.1.9-aaaaaaaaaaaa",
      "2222222222222222222222222222222222222222\trefs/tags/docs-v0.1.10-bbbbbbbbbbbb",
      "3333333333333333333333333333333333333333\trefs/tags/docs-v0.1.10-bbbbbbbbbbbb^{}",
      "4444444444444444444444444444444444444444\trefs/tags/desktop-v9.9.9-cccccccccccc",
      "5555555555555555555555555555555555555555\trefs/tags/docs-v0.1.8-dddddddddddd",
      "",
    ].join("\n");
    const tags = publishedDocsTags(lsRemote);
    assert(tags.length === 3, "the peeled line and other apps' tags are not counted twice");
    assert(latestDocsTag(tags)?.tag === "docs-v0.1.10-bbbbbbbbbbbb", "0.1.10 is newer than 0.1.9 (numeric, not text)");
    assert(latestDocsTag([]) === null, "no tags, no latest");

    // --- 採番 ---
    assert(nextReleaseVersion("0.1.46", []) === "0.1.46", "nothing published: the floor");
    assert(nextReleaseVersion("0.1.46", ["0.1.46"]) === "0.1.47", "floor equals the latest: latest + 1");
    assert(nextReleaseVersion("0.1.40", ["0.1.46", "0.1.45"]) === "0.1.47", "floor below the latest: latest + 1");
    assert(nextReleaseVersion("0.2.0", ["0.1.46"]) === "0.2.0", "floor above the latest: the floor");
    assert(nextReleaseVersion("0.1.47", ["0.1.46"]) === "0.1.47", "floor is exactly latest + 1");
    assert(nextReleaseVersion("0.1.0", ["0.1.9", "0.1.10"]) === "0.1.11", "0.1.10 > 0.1.9");
    assert(nextReleaseVersion("0.1.0", ["0.1.10", "0.1.9"]) === "0.1.11", "order of the input does not matter");
    expectFail("a broken floor", () => nextReleaseVersion("0.1", ["0.1.9"]));

    // --- 5 か所 ---
    put(`${DOCS_REL}/package.json`, `{\n  "name": "@niho/docs",\n  "version": "0.1.0",\n  "private": true\n}\n`);
    put(
      `${DOCS_REL}/package-lock.json`,
      `{\n  "name": "@niho/docs",\n  "version": "0.1.0",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "@niho/docs",\n      "version": "0.1.0"\n    },\n    "node_modules/dep": {\n      "version": "0.1.0"\n    }\n  }\n}\n`,
    );
    put(TAURI_CONF_REL, tauriConf("0.1.0"));
    put(
      `${DOCS_REL}/src-tauri/Cargo.toml`,
      `[package]\nname = "niho_docs"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n`,
    );
    put(
      `${DOCS_REL}/Cargo.lock`,
      `[[package]]\nname = "dep"\nversion = "0.1.0"\n\n[[package]]\nname = "niho_docs"\nversion = "0.1.0"\n`,
    );
    put(`${DOCS_REL}/src-tauri/src/lib.rs`, "fn main() {}\n");
    put(`${DOCS_REL}/src-tauri/src/lib_tests.rs`, "#[test] fn t() {}\n");
    put(`${DOCS_REL}/src/App.tsx`, "export const a = 1;\n");
    put(`${DOCS_REL}/test/app.test.tsx`, "// test\n");
    put(`${DOCS_REL}/scripts/build-dmg.sh`, "#!/bin/bash\n");
    put(`${DOCS_CORE_REL}/src/prompt.ts`, "export const p = 1;\n");
    put(`${DOCS_CORE_REL}/test/prompt.test.ts`, "// test\n");
    put(`${DOCS_REL}/README.md`, "# docs\n");
    put(`${VAULT_REL}/src/engine.rs`, "pub fn sync() {}\n");
    put(`${VAULT_REL}/tests/provider_http.rs`, "#[test] fn t() {}\n");
    put("packages/ui/src/styles/tokens.css", "/* baseline */\n");
    put("packages/ui/src/fonts/nunito-latin-variable.woff2", "font-v1\n");
    put("packages/desktop-account/ts/src/use-niho-account.ts", "export const account = 1;\n");
    run("init", "-q", "-b", "main");
    const base = commit("base");
    assert(check(root) === "0.1.0", "check reads 0.1.0");

    // apply: 同じ版は何もしない・小さい版は失敗・大きい版は 5 か所だけ書き換える
    const before = versionFiles();
    const same = apply(root, "0.1.0");
    assert(same.changed === false, "apply to the same version is a no-op");
    assert(versionFiles().every((text, index) => text === before[index]), "the no-op apply wrote nothing");
    put(`${DOCS_REL}/package.json`, `{\n  "name": "@niho/docs",\n  "version": "0.1.5",\n  "private": true\n}\n`);
    expectFail("apply on five places that disagree", () => apply(root, "0.1.6"));
    put(`${DOCS_REL}/package.json`, `{\n  "name": "@niho/docs",\n  "version": "0.1.0",\n  "private": true\n}\n`);
    expectFail("apply a version below the floor", () => apply(root, "0.0.9"));
    expectFail("apply without X.Y.Z", () => apply(root, "0.1"), EXIT.usage);
    assert(versionFiles().every((text, index) => text === before[index]), "the failed applies wrote nothing");

    const applied = apply(root, "0.1.12");
    assert(applied.changed === true && applied.from === "0.1.0" && applied.to === "0.1.12", "apply 0.1.12");
    assert(Object.values(readVersions(root)).every((version) => version === "0.1.12"), "all five places applied");
    const lock = JSON.parse(read(path.join(root, DOCS_REL, "package-lock.json")));
    assert(lock.packages["node_modules/dep"].version === "0.1.0", "dependency version kept");
    assert(read(path.join(root, DOCS_REL, "Cargo.lock")).includes(`name = "dep"\nversion = "0.1.0"`), "other crate kept");
    assert(JSON.parse(read(path.join(root, TAURI_CONF_REL))).plugins.x.version === "0.1.0", "nested version kept");
    assert(read(path.join(root, DOCS_REL, "src-tauri/Cargo.toml")).includes(`serde = { version = "1" }`), "dependency spec kept");
    // 版の行だけが変わる（publish-dmg.sh は版の行だけの差分を clean と見なす）
    const diffLines = run("diff", "-U0", "--no-color")
      .split("\n")
      .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line));
    // package-lock.json は 2 行（先頭と packages[""]）なので、5 ファイルで 6 行
    assert(diffLines.length === 12, `apply changes exactly 6 version lines in 5 files (+/- ${diffLines.length} lines)`);
    assert(
      diffLines.every((line) => /^[+-]\s*("version": "\d+\.\d+\.\d+",?|version = "\d+\.\d+\.\d+")$/.test(line)),
      "apply changes only version lines",
    );
    assert(shippedChanged(root, base).length === 5, "the five version files are shipped");
    run("checkout", "-q", "--", ".");

    // CLI: next・latest は標準入力の tag を読む
    assert(cli(["next"], "") === "0.1.0", "next with nothing published is the floor");
    assert(cli(["next"], lsRemote) === "0.1.11", "next after 0.1.10");
    assert(cli(["latest"], lsRemote) === "docs-v0.1.10-bbbbbbbbbbbb", "latest tag");
    assert(cli(["latest"], "refs/tags/desktop-v1.0.0-abc1234\n") === "", "latest prints nothing without docs tags");
    assert(cli(["apply", "0.1.0"]).includes("0.1.0"), "CLI apply of the same version");
    assert(versionFiles().every((text, index) => text === before[index]), "CLI no-op apply wrote nothing");

    // bump（床を上げる）は残す
    const bumped = bump(root);
    assert(bumped.from === "0.1.0" && bumped.to === "0.1.1", "bump patch");
    assert(Object.values(readVersions(root)).every((version) => version === "0.1.1"), "all five places bumped");
    assert(nextVersion("0.1.1", "minor") === "0.2.0", "minor");
    assert(nextVersion("0.1.1", "1.0.0") === "1.0.0", "explicit");
    expectFail("explicit downgrade", () => nextVersion("0.1.1", "0.1.1"));
    run("checkout", "-q", "--", ".");

    put(`${DOCS_REL}/src-tauri/Cargo.toml`, `[package]\nname = "niho_docs"\nversion = "0.1.2"\n`);
    expectFail("five places disagree", () => check(root));
    run("checkout", "-q", "--", ".");

    // --- shipped-changed: 出荷対象だけを数える ---
    assert(shippedChanged(root, base).length === 0, "nothing changed");
    put(`${DOCS_REL}/README.md`, "# docs\nmore\n");
    put(`${DOCS_REL}/src-tauri/src/lib_tests.rs`, "#[test] fn t2() {}\n");
    put(`${DOCS_REL}/test/app.test.tsx`, "// test 2\n");
    put(`${DOCS_REL}/scripts/build-dmg.sh`, "#!/bin/bash\n# 2\n");
    put(`${DOCS_CORE_REL}/test/prompt.test.ts`, "// test 2\n");
    put(`${VAULT_REL}/tests/provider_http.rs`, "#[test] fn t2() {}\n");
    assert(shippedChanged(root, base).length === 0, "docs, tests and scripts are not shipped");
    const docsOnly = commit("docs only");
    assert(shippedChanged(root, base, docsOnly).length === 0, "a commit range with docs only ships nothing");

    put("packages/ui/src/styles/tokens.css", "/* bundled tokens changed */\n");
    put("packages/ui/src/fonts/nunito-latin-variable.woff2", "font-v2\n");
    put("packages/desktop-account/ts/src/use-niho-account.ts", "export const account = 2;\n");
    const sharedUi = shippedChanged(root, docsOnly);
    assert(
      sharedUi.length === 3 &&
        sharedUi.includes("packages/ui/src/styles/tokens.css") &&
        sharedUi.includes("packages/ui/src/fonts/nunito-latin-variable.woff2") &&
        sharedUi.includes("packages/desktop-account/ts/src/use-niho-account.ts"),
      `shipped-changed lists shared UI/font and desktop account changes: ${sharedUi.join(", ")}`,
    );
    put("packages/ui/src/styles/tokens.css", "/* baseline */\n");
    put("packages/ui/src/fonts/nunito-latin-variable.woff2", "font-v1\n");
    put("packages/desktop-account/ts/src/use-niho-account.ts", "export const account = 1;\n");

    put(`${VAULT_REL}/src/engine.rs`, "pub fn sync() { let _ = 1; }\n");
    put(`${DOCS_CORE_REL}/src/prompt.ts`, "export const p = 2;\n");
    put(`${DOCS_REL}/src-tauri/src/lib.rs`, "fn main() { let _ = 1; }\n");
    const shipped = commit("shipped");
    const changed = shippedChanged(root, base, shipped);
    assert(
      changed.length === 3 &&
        changed.includes(`${VAULT_REL}/src/engine.rs`) &&
        changed.includes(`${DOCS_CORE_REL}/src/prompt.ts`) &&
        changed.includes(`${DOCS_REL}/src-tauri/src/lib.rs`),
      `shipped-changed lists the vault, docs-core and src-tauri changes: ${changed.join(", ")}`,
    );
    assert(shippedChanged(root, shipped, shipped).length === 0, "the same commit ships nothing");
    assert(cli(["shipped-changed", "--from", docsOnly, "--to", shipped]).split("\n").length === 3, "CLI shipped-changed");

    assert(isShippedPath(`${DOCS_REL}/sidecar.lock.json`), "the sidecar lock is shipped");
    assert(!isShippedPath(`${DOCS_REL}/sidecar/niho-speech/Sources/NihoSpeech/Tool.swift`), "sidecar sources ship through the lock");
    assert(!isShippedPath(`${DOCS_REL}/sidecar/fake/claude`), "the fakes are not shipped");
    assert(!isShippedPath(`${DOCS_REL}/scripts/build-dmg.sh`), "scripts are not shipped");
    assert(!isShippedPath(`${DOCS_REL}/release-requirements.json`), "the release requirements are not shipped");
    assert(isShippedPath(`${DOCS_REL}/scripts/stage-speech-sidecar.mjs`), "sidecar resource staging changes require a new app release");
    assert(isShippedPath(`${DOCS_REL}/src/components/Rail.tsx`), "the UI is shipped");
    assert(!isShippedPath(`${DOCS_REL}/src/lib/x.test.ts`), "UI tests are not shipped");
    assert(isShippedPath("packages/desktop-account/src/tauri.rs"), "account Rust is shipped");
    assert(isShippedPath("packages/desktop-account/ts/src/use-niho-account.ts"), "account hook is shipped");
    assert(isShippedPath("packages/ui/src/components/account-popover.tsx"), "account UI is shipped");
    assert(isShippedPath("packages/ui/src/styles/tokens.css"), "shared UI tokens are shipped");
    assert(isShippedPath("packages/ui/src/fonts/nunito-latin-variable.woff2"), "shared UI fonts are shipped");
    assert(!isShippedPath("packages/desktop-account/src/service_tests.rs"), "account tests are not shipped");
    assert(!isShippedPath("packages/ui/src/components/account-popover.test.tsx"), "UI tests are not shipped");
    assert(isShippedPath(`${DOCS_CORE_REL}/src/templates.ts`), "docs-core is bundled into the UI");
    assert(!isShippedPath(`${DOCS_CORE_REL}/test/templates.test.ts`), "docs-core tests are not shipped");
    assert(isShippedPath(`${DOCS_UI_REL}/src/editor/markdown.ts`), "docs-ui is bundled into the UI");
    assert(isShippedPath(`${DOCS_UI_REL}/src/styles/tokens.css`), "docs-ui tokens are bundled into the UI");
    assert(isShippedPath(`${DOCS_UI_REL}/package.json`), "the docs-ui manifest is shipped");
    assert(!isShippedPath(`${DOCS_UI_REL}/src/editor/markdown.test.ts`), "docs-ui tests are not shipped");
    assert(!isShippedPath(`${DOCS_UI_REL}/src/editor/fixtures/markdown/article.md`), "docs-ui test fixtures are not shipped");
    assert(!isShippedPath(`${DOCS_UI_REL}/README.md`), "the docs-ui README is not shipped");
    assert(isShippedPath(`${DOCS_REL}/src-tauri/capabilities/default.json`), "capabilities are shipped");
    assert(!isShippedPath(`${DOCS_REL}/src-tauri/src/acl_tests.rs`), "Rust tests are not shipped");
    assert(!isShippedPath(`${DOCS_REL}/src-tauri/binaries/niho-speech-aarch64-apple-darwin`), "the staged sidecar is a build output");
    assert(isShippedPath(`${DOCS_REL}/crates/local-ai/src/claude.rs`), "the CLI crate is linked into the app");
    assert(!isShippedPath(`${DOCS_REL}/crates/local-ai/tests/fake_cli.rs`), "crate tests are not shipped");
    assert(!isShippedPath(`${DOCS_REL}/crates/local-ai/Cargo.lock`), "the crate lock is not used by the app build");
    assert(isShippedPath(`${DOCS_REL}/Cargo.lock`), "the workspace lock is shipped");
    assert(!isShippedPath(`${DOCS_REL}/fixtures/turn-events/a.jsonl`), "fixtures are not shipped");
    assert(isShippedPath(`${VAULT_REL}/src/engine.rs`), "the vault crate is linked into the app");
    assert(isShippedPath(`${VAULT_REL}/Cargo.toml`), "the vault manifest is shipped");
    assert(!isShippedPath(`${VAULT_REL}/src/engine_tests.rs`), "vault tests are not shipped");
    assert(!isShippedPath(`${VAULT_REL}/tests/provider_http.rs`), "vault integration tests are not shipped");
    assert(!isShippedPath(`${VAULT_REL}/Cargo.lock`), "the vault lock is not used by the app build");
    assert(!isShippedPath(`${VAULT_REL}/README.md`), "the vault README is not shipped");
    console.log("self-test: ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- CLI ------------------------------------------------------------------------
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined) throw new VersionError(`${arg} needs a value`, EXIT.usage);
    options[arg.slice(2)] = value;
    index += 1;
  }
  return { command, positional, options };
}

/** 標準入力の全部（端末から直接起動して入力が無いときは空）。 */
function readStdin() {
  if (tty.isatty(0)) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch (error) {
    if (error.code === "EAGAIN" || error.code === "EOF") return "";
    throw error;
  }
}

function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options["repo-root"] ?? DEFAULT_REPO_ROOT);
  switch (command) {
    case "current":
      console.log(JSON.parse(read(paths(repoRoot).packageJson)).version);
      return;
    case "check":
      console.log(`NIHO docs の版は 5 か所とも ${check(repoRoot)} です`);
      return;
    case "next": {
      const floor = check(repoRoot);
      const published = publishedDocsTags(readStdin()).map((entry) => entry.version);
      console.log(nextReleaseVersion(floor, published));
      return;
    }
    case "latest": {
      const latest = latestDocsTag(publishedDocsTags(readStdin()));
      if (latest) console.log(latest.tag);
      return;
    }
    case "apply": {
      if (positional.length !== 1) throw new VersionError("apply には版（X.Y.Z）を 1 つ渡してください", EXIT.usage);
      const { from, to, changed } = apply(repoRoot, positional[0]);
      console.log(
        changed ? `NIHO docs の版を ${from} → ${to} にしました（5 か所）` : `NIHO docs の版はもう ${to} です（書き換えません）`,
      );
      return;
    }
    case "bump": {
      const { from, to } = bump(repoRoot, positional[0] ?? "patch");
      console.log(`NIHO docs の版を ${from} → ${to} にしました（5 か所）`);
      return;
    }
    case "shipped-changed": {
      if (!options.from) throw new VersionError("shipped-changed には --from が要ります", EXIT.usage);
      for (const file of shippedChanged(repoRoot, options.from, options.to)) console.log(file);
      return;
    }
    case "self-test":
      selfTest();
      return;
    default:
      throw new VersionError(
        `使い方: docs-version.mjs <current|check|next|latest|apply|bump|shipped-changed|self-test>（${command ?? "コマンドなし"}）`,
        EXIT.usage,
      );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode ?? EXIT.mismatch);
  }
}
