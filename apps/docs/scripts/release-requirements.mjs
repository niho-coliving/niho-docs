#!/usr/bin/env node
// release-requirements.mjs — NIHO docs を公開する前に、そのコードが前提にするサーバーの設定を本番へ問い合わせて確かめる（#18744）。
//
// 2026-10-17、ログイン必須の 0.1.44（#18729）を、本番でログイン（APP_CONNECT_ENABLED）が閉じたまま配り、利用者がログイン画面から
// 先へ進めなかった。main に入ったコードが前提にするサーバーの設定を apps/docs/release-requirements.json に並べ、
// ci-docs-release.sh plan が「公開する」と決めたときだけ check で確かめる（main のコードは入ったまま、配るのだけ待つ）:
//   enforce: true   満たされない・確かめられないときは公開しない（exit 1。summary に足りないものと直し方（fix）を出す）
//   enforce: false  ::warning:: を出すだけで公開は止めない
// NIHO Desktop・NIHO photo も同じ形で使う（apps/<app>/release-requirements.json を ci-desktop-release.sh・ci-camera-release.sh の
// plan が check する。#18759）。設定の先頭の app（空でない文字列。無ければ "NIHO docs"）が ::error::・::warning:: の title に出る。
//
// probe の種類:
//   app-connect-open  NIHO アカウントの接続（app-connect）を受け付けているか。url へ認証なし・token なし・本文なしの GET を送り、
//                     404 かつ JSON の error.details.reason が app_connect_disabled なら「閉じている」（apps/docs/src-tauri/src/
//                     google_docs.rs の connect_disabled と同じ判定。開いていれば requireAuth の 401）。それ以外の応答は
//                     「開いている」。接続できない・15 秒で返らないときは「確かめられない」。
//
// 使い方:
//   node apps/docs/scripts/release-requirements.mjs check [--file <json>]      （既定 apps/docs/release-requirements.json）
//   node apps/docs/scripts/release-requirements.mjs validate [--file <json>]   形だけ確かめて項目数を出す（問い合わせない。CI 用）
//   node apps/docs/scripts/release-requirements.mjs self-test                   （fetch を差し替えた偽物で。ネットワークには出ない）
//
// GITHUB_STEP_SUMMARY があれば、各項目の結果を summary に足す。
//
// 終了コード: 0 = 公開してよい（validate は形が合っている） / 1 = 公開を止める / 2 = 使い方・設定の誤り
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const DEFAULT_FILE = path.resolve(SCRIPT_DIR, "../release-requirements.json");
// 置いてある設定（self-test が形を確かめる）。docs は項目がある・Desktop と photo は今は空でよい（#18759）
const SHIPPED_FILES = [
  { file: DEFAULT_FILE, app: "NIHO docs", allowEmpty: false },
  { file: path.join(REPO_ROOT, "apps/desktop/release-requirements.json"), app: "NIHO Desktop", allowEmpty: true },
  { file: path.join(REPO_ROOT, "apps/camera/release-requirements.json"), app: "NIHO photo", allowEmpty: true },
];
const DEFAULT_APP = "NIHO docs";
const PROBE_TIMEOUT_MS = 15_000;

const EXIT = { ok: 0, blocked: 1, usage: 2 };

class RequirementsError extends Error {
  constructor(message, exitCode = EXIT.usage) {
    super(message);
    this.exitCode = exitCode;
  }
}

// --- probe --------------------------------------------------------------------
// 結果の state: met = 満たしている / unmet = 満たしていない / unknown = 確かめられない

/** 応答の本文から error.details.reason（google_docs.rs の response_reason と同じ）。JSON でなければ null。 */
function reasonOf(text) {
  try {
    const reason = JSON.parse(text)?.error?.details?.reason;
    return typeof reason === "string" ? reason : null;
  } catch {
    return null;
  }
}

async function discardBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    // 捨てるだけなので失敗してよい
  }
}

const PROBES = {
  "app-connect-open": {
    label: { met: "受け付けている", unmet: "閉じている", unknown: "確かめられない" },
    async run(probe, { fetchImpl, timeoutMs }) {
      let response;
      try {
        // 認証なし・token なし・本文なし（requireAppConnectEnabled は requireAuth より前なので、これで開閉が分かる）
        response = await fetchImpl(probe.url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return { state: "unknown", detail: describeFetchError(error, timeoutMs) };
      }
      if (response.status !== 404) {
        await discardBody(response);
        return { state: "met", detail: `HTTP ${response.status}` };
      }
      let text;
      try {
        text = await response.text();
      } catch (error) {
        return { state: "unknown", detail: `HTTP 404 の本文を読めません（${describeFetchError(error, timeoutMs)}）` };
      }
      const reason = reasonOf(text);
      if (reason === "app_connect_disabled") return { state: "unmet", detail: "HTTP 404 app_connect_disabled" };
      return { state: "met", detail: `HTTP 404${reason ? ` ${reason}` : "（app_connect_disabled ではない）"}` };
    },
  },
};

function describeFetchError(error, timeoutMs) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return `${Math.round(timeoutMs / 1000)} 秒で返りません`;
  const cause = error?.cause?.code ?? error?.cause?.message;
  return `接続できません: ${error?.message ?? String(error)}${cause ? `（${cause}）` : ""}`;
}

// --- 設定 ---------------------------------------------------------------------
const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

/** release-requirements.json の中身を確かめる。誤りは RequirementsError（exit 2）にまとめて投げる。 */
export function validateConfig(config, source = "release-requirements.json") {
  const problems = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new RequirementsError(`${source}: 先頭は object にしてください`);
  }
  if (Object.hasOwn(config, "app") && !nonEmptyString(config.app)) {
    throw new RequirementsError(`${source}: app は空でない文字列にしてください（無ければ "${DEFAULT_APP}"）`);
  }
  if (!Array.isArray(config.requirements)) {
    throw new RequirementsError(`${source}: requirements は配列にしてください`);
  }
  const seen = new Set();
  config.requirements.forEach((item, index) => {
    const where = `requirements[${index}]${nonEmptyString(item?.id) ? `（${item.id}）` : ""}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      problems.push(`${where}: object にしてください`);
      return;
    }
    for (const key of ["id", "title", "why", "fix"]) {
      if (!nonEmptyString(item[key])) problems.push(`${where}: ${key} が要ります（空でない文字列）`);
    }
    if (typeof item.enforce !== "boolean") problems.push(`${where}: enforce は true か false にしてください`);
    if (nonEmptyString(item.id)) {
      if (seen.has(item.id)) problems.push(`${where}: id が重複しています`);
      seen.add(item.id);
    }
    const probe = item.probe;
    if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
      problems.push(`${where}: probe が要ります（{ "kind", "url" }）`);
      return;
    }
    if (!Object.hasOwn(PROBES, probe.kind)) {
      problems.push(`${where}: probe.kind ${JSON.stringify(probe.kind)} は知りません（${Object.keys(PROBES).join("・")}）`);
    }
    let url = null;
    try {
      url = new URL(probe.url);
    } catch {
      problems.push(`${where}: probe.url が URL ではありません: ${JSON.stringify(probe.url)}`);
    }
    if (url && url.protocol !== "https:") problems.push(`${where}: probe.url は https にしてください: ${probe.url}`);
  });
  if (problems.length > 0) {
    throw new RequirementsError([`${source} の形が誤っています:`, ...problems.map((line) => `  - ${line}`)].join("\n"));
  }
  return config;
}

/** 表示に使うアプリの名前（設定の app。無ければ NIHO docs）。 */
export function appLabel(config) {
  return nonEmptyString(config?.app) ? config.app.trim() : DEFAULT_APP;
}

/** 表示に使うファイルの場所（repo の root からの相対パス。repo の外ならファイル名だけ。絶対パスは出さない）。 */
function displayPath(file) {
  const relative = path.relative(REPO_ROOT, path.resolve(file));
  return relative.startsWith("..") || path.isAbsolute(relative) ? path.basename(file) : relative;
}

export function loadConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new RequirementsError(`公開前の前提のファイルを読めません: ${file}（${error.code ?? error.message}）`);
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new RequirementsError(`${file} が JSON ではありません: ${error.message}`);
  }
  return validateConfig(config, file);
}

// --- 確かめる -------------------------------------------------------------------

/** 各項目の probe を順に回す（全部を回してから判定する。1 つ目で止めると summary に残りが出ない）。 */
export async function evaluate(config, { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const results = [];
  for (const item of config.requirements) {
    const probe = PROBES[item.probe.kind];
    const outcome = await probe.run(item.probe, { fetchImpl, timeoutMs });
    results.push({ ...item, state: outcome.state, detail: outcome.detail, stateLabel: probe.label[outcome.state] });
  }
  const blocked = results.filter((result) => result.enforce && result.state !== "met");
  return { results, blocked, exitCode: blocked.length > 0 ? EXIT.blocked : EXIT.ok };
}

// GitHub Actions の workflow command の値（%・改行）と property（: と ,）を escape する
const escapeData = (text) => String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function summaryLines(results, blocked, file) {
  const where = displayPath(file);
  const lines = ["", `#### 公開前の前提（\`${where}\`）`, ""];
  if (results.length === 0) {
    lines.push("確かめる前提はありません（requirements が空）。", "");
    return lines;
  }
  lines.push("| 前提 | 結果 | 満たさないとき |", "| --- | --- | --- |");
  for (const result of results) {
    const mark = result.state === "met" ? "OK" : result.enforce ? "NG" : "警告";
    lines.push(
      `| ${cell(result.title)}（\`${result.id}\`） | ${mark}: ${cell(result.stateLabel)}（${cell(result.detail)}） | ${result.enforce ? "公開しない" : "警告だけ"} |`,
    );
  }
  lines.push("");
  const unmet = results.filter((result) => result.state !== "met");
  if (blocked.length > 0) {
    lines.push("**公開を止めました。** main のコードは入ったままです。次をそろえると公開されます:", "");
  } else if (unmet.length > 0) {
    lines.push("満たしていない前提があります（`enforce: false` なので公開は止めません）:", "");
  }
  for (const result of unmet) {
    lines.push(`- **${result.title}**（\`${result.id}\`・${result.stateLabel}）: ${result.why}`);
    lines.push(`  - どうすれば: ${result.fix}`);
  }
  if (unmet.length > 0) lines.push("");
  return lines;
}

/** check の本体。終了コードを返す（0 = 公開してよい / 1 = 止める）。 */
export async function runCheck({
  file = DEFAULT_FILE,
  fetchImpl = globalThis.fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
  out = (line) => console.log(line),
} = {}) {
  const config = loadConfig(file);
  const app = appLabel(config);
  const { results, blocked, exitCode } = await evaluate(config, { fetchImpl, timeoutMs });
  if (results.length === 0) out("公開前の前提はありません（requirements が空）。");
  for (const result of results) {
    const head = `${result.title}（${result.id}）`;
    if (result.state === "met") {
      out(`公開前の前提を満たしています: ${head} — ${result.stateLabel}（${result.detail}）`);
    } else if (result.enforce) {
      out(
        `::error title=${escapeProperty(`${app} を公開しません（公開前の前提）`)}::${escapeData(
          `${head} — ${result.stateLabel}（${result.detail}）。${result.fix}`,
        )}`,
      );
    } else {
      out(
        `::warning title=${escapeProperty(`${app} の公開前の前提（警告だけ）`)}::${escapeData(
          `${head} — ${result.stateLabel}（${result.detail}）。enforce: false なので公開は止めません。${result.fix}`,
        )}`,
      );
    }
  }
  if (summaryPath) fs.appendFileSync(summaryPath, `${summaryLines(results, blocked, file).join("\n")}\n`);
  return exitCode;
}

/** validate の本体: 形だけ確かめて項目数を出す（問い合わせない）。形が誤っていれば RequirementsError（exit 2）。 */
export function runValidate({ file = DEFAULT_FILE, out = (line) => console.log(line) } = {}) {
  const config = loadConfig(file);
  out(`${displayPath(file)} の形は合っています（${appLabel(config)}・前提 ${config.requirements.length} 件）`);
  return EXIT.ok;
}

// --- self-test ----------------------------------------------------------------
async function selfTest() {
  const assert = (condition, label) => {
    if (!condition) throw new Error(`self-test: ${label}`);
  };
  const expectUsage = (label, fn) => {
    try {
      fn();
    } catch (error) {
      if (error.exitCode === EXIT.usage) return;
      throw new Error(`${label}: expected exit ${EXIT.usage}, got ${error.exitCode}: ${error.message}`);
    }
    throw new Error(`${label}: expected a failure, but it passed`);
  };
  // 本物の fetch を呼んだら落とす（ネットワークに出ない）
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("self-test must not use the network");
  };
  const requests = [];
  const respond = (status, body = "") => async (url, init) => {
    requests.push({ url, init });
    return { status, text: async () => body, body: null };
  };
  const throwing = (error) => async (url, init) => {
    requests.push({ url, init });
    throw error;
  };
  const disabledBody = JSON.stringify({
    error: { code: "NOT_FOUND", message: "raw", details: { reason: "app_connect_disabled" } },
  });
  const requirement = (overrides = {}) => ({
    id: "prod-app-connect",
    title: "本番で NIHO アカウントのログインを受け付ける",
    why: "why",
    enforce: true,
    probe: { kind: "app-connect-open", url: "https://example.invalid/api/auth/app-connections" },
    fix: "fix it",
    ...overrides,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-requirements-test-"));
  try {
    const probe = (fetchImpl) =>
      PROBES["app-connect-open"].run(requirement().probe, { fetchImpl, timeoutMs: 50 }).then((outcome) => outcome.state);

    assert((await probe(respond(404, disabledBody))) === "unmet", "404 app_connect_disabled is closed");
    const sent = requests.at(-1);
    assert(sent.init.method === "GET" && sent.init.body === undefined, "a GET without a body");
    assert(!Object.keys(sent.init.headers ?? {}).some((key) => key.toLowerCase() === "authorization"), "no token");
    assert((await probe(respond(401, '{"error":{"code":"UNAUTHORIZED"}}'))) === "met", "401 is open");
    assert((await probe(respond(200, "{}"))) === "met", "200 is open");
    assert(
      (await probe(respond(404, JSON.stringify({ error: { details: { reason: "not_found" } } })))) === "met",
      "404 with another reason is open",
    );
    assert((await probe(respond(404, "<html>not json"))) === "met", "404 with a broken JSON body is open");
    assert((await probe(respond(404, ""))) === "met", "404 without a body is open");
    assert((await probe(throwing(new TypeError("fetch failed")))) === "unknown", "a network error cannot be checked");
    assert(
      (await probe(throwing(Object.assign(new Error("timed out"), { name: "TimeoutError" })))) === "unknown",
      "a timeout cannot be checked",
    );
    const brokenBody = async () => ({
      status: 404,
      text: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    assert((await probe(brokenBody)) === "unknown", "a 404 whose body times out cannot be checked");

    // enforce で終了コードが変わる・summary に足りないものと fix が出る
    const writeConfig = (name, requirements) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify({ $comment: "test", requirements }));
      return file;
    };
    let checks = 0;
    const check = async (requirements, fetchImpl) => {
      const lines = [];
      checks += 1;
      const summaryPath = path.join(dir, `summary-${checks}.md`);
      const exitCode = await runCheck({
        file: writeConfig("requirements.json", requirements),
        fetchImpl,
        timeoutMs: 50,
        summaryPath,
        out: (line) => lines.push(line),
      });
      return { exitCode, lines, summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf8") : "" };
    };
    const closedEnforced = await check([requirement({ enforce: true })], respond(404, disabledBody));
    assert(closedEnforced.exitCode === EXIT.blocked, "enforce: true and closed blocks the release");
    assert(closedEnforced.lines.some((line) => line.startsWith("::error title=")), "an ::error:: annotation");
    assert(closedEnforced.summary.includes("公開を止めました") && closedEnforced.summary.includes("fix it"), "the summary says what to fix");
    const unknownEnforced = await check([requirement({ enforce: true })], throwing(new TypeError("fetch failed")));
    assert(unknownEnforced.exitCode === EXIT.blocked, "enforce: true and unknown blocks the release");
    const closedWarn = await check([requirement({ enforce: false })], respond(404, disabledBody));
    assert(closedWarn.exitCode === EXIT.ok, "enforce: false and closed only warns");
    assert(closedWarn.lines.some((line) => line.startsWith("::warning title=")), "a ::warning:: annotation");
    assert(closedWarn.summary.includes("fix it") && !closedWarn.summary.includes("公開を止めました"), "the warning summary has the fix");
    const unknownWarn = await check([requirement({ enforce: false })], throwing(new TypeError("fetch failed")));
    assert(unknownWarn.exitCode === EXIT.ok, "enforce: false and unknown only warns");
    const open = await check([requirement({ enforce: true })], respond(401));
    assert(open.exitCode === EXIT.ok && open.lines.length === 1 && !open.lines[0].startsWith("::"), "open passes with one line");
    const mixed = await check(
      [requirement({ id: "a", enforce: false }), requirement({ id: "b", enforce: true })],
      respond(404, disabledBody),
    );
    assert(mixed.exitCode === EXIT.blocked && mixed.lines.length === 2, "every requirement is checked before deciding");
    const empty = await check([], respond(500));
    assert(empty.exitCode === EXIT.ok, "no requirements, nothing to block");
    // summary の場所は repo の root からの相対パス（repo の外はファイル名だけ）。絶対パスを出さない
    assert(closedEnforced.summary.includes("`requirements.json`") && !closedEnforced.summary.includes(dir), "the summary does not print an absolute path");
    // app のラベルが title に出る（無ければ NIHO docs）
    assert(closedEnforced.lines[0].startsWith("::error title=NIHO docs を公開しません"), "the default app label is NIHO docs");
    const labelled = async (app, enforce) => {
      const lines = [];
      const file = path.join(dir, `labelled-${enforce}.json`);
      fs.writeFileSync(file, JSON.stringify({ app, requirements: [requirement({ enforce })] }));
      await runCheck({ file, fetchImpl: respond(404, disabledBody), timeoutMs: 50, summaryPath: undefined, out: (line) => lines.push(line) });
      return lines;
    };
    assert((await labelled("NIHO Desktop", true))[0].startsWith("::error title=NIHO Desktop を公開しません"), "the app label in ::error::");
    assert((await labelled("NIHO photo", false))[0].startsWith("::warning title=NIHO photo の公開前の前提"), "the app label in ::warning::");
    assert(
      escapeProperty("a:b,c%") === "a%3Ab%2Cc%25" && escapeData("x\ny") === "x%0Ay",
      "workflow command values are escaped",
    );

    // 形の誤りは exit 2
    expectUsage("an unknown probe kind", () => validateConfig({ requirements: [requirement({ probe: { kind: "nope", url: "https://a.example" } })] }));
    expectUsage("a duplicated id", () => validateConfig({ requirements: [requirement(), requirement()] }));
    for (const key of ["id", "title", "why", "fix", "enforce", "probe"]) {
      const item = requirement();
      delete item[key];
      expectUsage(`a missing ${key}`, () => validateConfig({ requirements: [item] }));
    }
    expectUsage("enforce as a string", () => validateConfig({ requirements: [requirement({ enforce: "true" })] }));
    expectUsage("a missing url", () => validateConfig({ requirements: [requirement({ probe: { kind: "app-connect-open" } })] }));
    expectUsage("an http url", () =>
      validateConfig({ requirements: [requirement({ probe: { kind: "app-connect-open", url: "http://niho.life/x" } })] }),
    );
    expectUsage("requirements is not an array", () => validateConfig({ requirements: {} }));
    expectUsage("an empty app", () => validateConfig({ app: " ", requirements: [] }));
    expectUsage("app as a number", () => validateConfig({ app: 1, requirements: [] }));
    assert(appLabel(validateConfig({ requirements: [] })) === "NIHO docs", "no app is NIHO docs");
    assert(appLabel(validateConfig({ app: "NIHO photo", requirements: [] })) === "NIHO photo", "the app label");
    expectUsage("not an object", () => validateConfig([]));
    const brokenFile = path.join(dir, "broken.json");
    fs.writeFileSync(brokenFile, "{");
    expectUsage("a broken JSON file", () => loadConfig(brokenFile));
    expectUsage("a missing file", () => loadConfig(path.join(dir, "missing.json")));

    // 置いてある release-requirements.json（docs・Desktop・photo）は形が合っている（問い合わせはしない）
    for (const { file, app, allowEmpty } of SHIPPED_FILES) {
      const shipped = loadConfig(file);
      const where = displayPath(file);
      assert(appLabel(shipped) === app, `${where} is for ${app}`);
      assert(allowEmpty || shipped.requirements.length > 0, `${where} is not empty`);
      const lines = [];
      assert(runValidate({ file, out: (line) => lines.push(line) }) === EXIT.ok && lines[0].startsWith(`${where} の形は合っています`), `validate ${where}`);
    }
    console.log("self-test: ok");
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- CLI ------------------------------------------------------------------------
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) throw new RequirementsError(`知らない引数です: ${arg}`);
    const value = rest[index + 1];
    if (value === undefined) throw new RequirementsError(`${arg} には値が要ります`);
    options[arg.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "check": {
      const unknown = Object.keys(options).filter((key) => key !== "file");
      if (unknown.length > 0) throw new RequirementsError(`check が知らないオプションです: --${unknown.join(" --")}`);
      return runCheck({ file: options.file ? path.resolve(options.file) : DEFAULT_FILE });
    }
    case "validate": {
      const unknown = Object.keys(options).filter((key) => key !== "file");
      if (unknown.length > 0) throw new RequirementsError(`validate が知らないオプションです: --${unknown.join(" --")}`);
      return runValidate({ file: options.file ? path.resolve(options.file) : DEFAULT_FILE });
    }
    case "self-test":
      await selfTest();
      return EXIT.ok;
    default:
      throw new RequirementsError(
        `使い方: release-requirements.mjs <check [--file <json>]|validate [--file <json>]|self-test>（${command ?? "コマンドなし"}）`,
      );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode ?? EXIT.ok;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = error.exitCode ?? EXIT.blocked;
    },
  );
}
