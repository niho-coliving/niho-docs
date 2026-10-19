#!/usr/bin/env node
// updater-key.mjs — NIHO docs の自動更新の署名の確かめ（S4 #18385）。
//
// 各 Mac の NIHO docs は、tauri.conf.json の `plugins.updater.pubkey`（.app に入る公開鍵）で更新の `.app.tar.gz.sig` を確かめ、
// 合わなければ更新しない（黙って古い版のまま）。署名する秘密鍵（Environment docs-release の secret TAURI_SIGNING_PRIVATE_KEY）と
// 公開鍵の組を取り違えた公開を、Release に上げる前に止める。検証は tauri-plugin-updater（minisign-verify）と同じ:
// minisign の Ed25519（`ED` は BLAKE2b-512 の prehash、`Ed` は旧形式）と、trusted comment の global signature。
//
// NIHO camera（apps/camera/scripts/updater-key.mjs。C5 #18393）も同じ検証を使う。アプリごとに違うのは、公開鍵を読む
// tauri.conf.json・プレースホルダー・案内の README だけ（`runUpdaterKeyCli` に渡す `UpdaterApp`）。
//
// 使い方:
//   node apps/docs/scripts/updater-key.mjs status
//     tauri.conf.json の pubkey が差し替え済みなら鍵 ID を出す。プレースホルダーのままなら終了コード 4（配布しない）
//   node apps/docs/scripts/updater-key.mjs verify --file X.app.tar.gz --sig X.app.tar.gz.sig [--pubkey <base64> | --pubkey-file <path>]
//     .sig（tauri build・tauri signer sign の出力）を公開鍵（既定は tauri.conf.json の pubkey）で確かめる
//   node apps/docs/scripts/updater-key.mjs self-test
//
// 終了コード: 0 = 合っている / 1 = 合わない・壊れている / 2 = 使い方の誤り / 4 = 公開鍵が未設定（プレースホルダー）
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {object} UpdaterApp 公開鍵の置き場（アプリごと）
 * @property {string} name 案内に出すアプリの名前
 * @property {string} tauriConf `plugins.updater.pubkey` を持つ tauri.conf.json
 * @property {string} placeholder 鍵を設定する前の pubkey（src-tauri/src/updater.rs の PUBKEY_PLACEHOLDER と同じ）
 * @property {string} readme 鍵の作り方を書いた README（リポジトリの root から）
 */

/** @type {UpdaterApp} */
const DOCS_APP = {
  name: "NIHO docs",
  tauriConf: path.resolve(SCRIPT_DIR, "../src-tauri/tauri.conf.json"),
  // apps/docs/src-tauri/src/updater.rs の PUBKEY_PLACEHOLDER と同じ
  placeholder: "REPLACE_WITH_DOCS_UPDATER_PUBKEY",
  readme: "apps/docs/README.md",
};
// Ed25519 の公開鍵 32 バイトを SPKI（DER）にする前置き
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const EXIT = { ok: 0, mismatch: 1, usage: 2, notConfigured: 4 };

class KeyError extends Error {
  constructor(message, exitCode = EXIT.mismatch) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) throw new KeyError(`unknown argument: ${arg}`, EXIT.usage);
    const value = rest[index + 1];
    if (value === undefined) throw new KeyError(`${arg} needs a value`, EXIT.usage);
    options[arg.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

/** Tauri は minisign の鍵・署名の文字列全体を、もう一度 base64 にして持つ（tauri.conf.json の pubkey・.sig ファイル）。 */
function unwrapBase64Text(value, label) {
  const text = Buffer.from(String(value ?? "").trim(), "base64").toString("utf8");
  if (!text.startsWith("untrusted comment:")) throw new KeyError(`${label} が minisign の形ではありません（Tauri の base64 の文字列を渡してください）`);
  return text.split(/\r?\n/);
}

/** minisign の公開鍵（`Ed` + 鍵 ID 8 バイト + Ed25519 の公開鍵 32 バイト）。 */
export function parsePublicKey(tauriPubkey) {
  const [, line] = unwrapBase64Text(tauriPubkey, "公開鍵");
  const bytes = Buffer.from(line ?? "", "base64");
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString("latin1") !== "Ed") throw new KeyError("公開鍵の中身が minisign の Ed25519 の鍵ではありません");
  return {
    keyId: bytes.subarray(2, 10),
    key: crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes.subarray(10, 42)]), format: "der", type: "spki" }),
  };
}

/** minisign の署名（`ED`/`Ed` + 鍵 ID 8 バイト + 署名 64 バイト、trusted comment、global signature）。 */
export function parseSignature(tauriSignature) {
  const [, line, trustedLine, globalLine] = unwrapBase64Text(tauriSignature, "署名");
  const bytes = Buffer.from(line ?? "", "base64");
  const algorithm = bytes.subarray(0, 2).toString("latin1");
  if (bytes.length !== 74 || (algorithm !== "ED" && algorithm !== "Ed")) throw new KeyError("署名の中身が minisign の Ed25519 の署名ではありません");
  if (!trustedLine?.startsWith("trusted comment: ")) throw new KeyError("署名に trusted comment がありません");
  const globalSignature = Buffer.from(globalLine ?? "", "base64");
  if (globalSignature.length !== 64) throw new KeyError("署名に global signature がありません");
  return {
    prehashed: algorithm === "ED",
    keyId: bytes.subarray(2, 10),
    signature: bytes.subarray(10, 74),
    trustedComment: trustedLine.slice("trusted comment: ".length),
    globalSignature,
  };
}

/** data の署名を公開鍵で確かめる（各 Mac の updater と同じ）。合わなければ投げる。 */
export function verifySignature(data, tauriSignature, tauriPubkey) {
  const publicKey = parsePublicKey(tauriPubkey);
  const signed = parseSignature(tauriSignature);
  if (!publicKey.keyId.equals(signed.keyId)) {
    throw new KeyError(
      `署名した鍵（鍵 ID ${keyIdText(signed.keyId)}）と公開鍵（鍵 ID ${keyIdText(publicKey.keyId)}）が違います。` +
        "TAURI_SIGNING_PRIVATE_KEY と tauri.conf.json の pubkey は、同じ tauri signer generate の組にしてください。",
    );
  }
  const message = signed.prehashed ? crypto.createHash("blake2b512").update(data).digest() : data;
  if (!crypto.verify(null, message, publicKey.key, signed.signature)) throw new KeyError("ファイルが署名と合いません（署名のあとに中身が変わった）");
  const global = Buffer.concat([signed.signature, Buffer.from(signed.trustedComment, "utf8")]);
  if (!crypto.verify(null, global, publicKey.key, signed.globalSignature)) throw new KeyError("署名の trusted comment が壊れています");
  return { keyId: keyIdText(publicKey.keyId), trustedComment: signed.trustedComment };
}

function keyIdText(bytes) {
  // minisign が表示する鍵 ID（8 バイトを little endian の 16 進数で）
  return Buffer.from(bytes).reverse().toString("hex").toUpperCase();
}

function configuredPubkey(app, tauriConfPath = app.tauriConf) {
  let conf;
  try {
    conf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
  } catch (error) {
    throw new KeyError(`tauri.conf.json を読めません: ${tauriConfPath} (${error.message})`);
  }
  const pubkey = conf?.plugins?.updater?.pubkey;
  if (typeof pubkey !== "string" || pubkey.trim() === "" || pubkey.trim() === app.placeholder) {
    throw new KeyError(
      "tauri.conf.json の plugins.updater.pubkey がプレースホルダーのままです（自動更新の公開鍵が未設定）。" +
        `${app.readme}「配布」の手順で鍵を作り、pubkey を差し替える PR を出してください。`,
      EXIT.notConfigured,
    );
  }
  return pubkey.trim();
}

// --- self-test ------------------------------------------------------------------

/** Tauri（tauri signer）と同じ形の鍵・署名を作る（self-test 用）。 */
function fakeMinisign({ prehashed = true, file = "NIHO docs.app.tar.gz" } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = crypto.randomBytes(8);
  const pubkey = Buffer.from(
    `untrusted comment: minisign public key: ${keyIdText(keyId)}\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`,
  ).toString("base64");
  const sign = (data, trustedComment = `timestamp:1792030358\tfile:${file}`) => {
    const message = prehashed ? crypto.createHash("blake2b512").update(data).digest() : data;
    const signature = crypto.sign(null, message, privateKey);
    const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), privateKey);
    const algorithm = Buffer.from(prehashed ? "ED" : "Ed");
    return Buffer.from(
      [
        "untrusted comment: signature from tauri secret key",
        Buffer.concat([algorithm, keyId, signature]).toString("base64"),
        `trusted comment: ${trustedComment}`,
        global.toString("base64"),
        "",
      ].join("\n"),
    ).toString("base64");
  };
  return { pubkey, sign };
}

function selfTest(app) {
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
  const data = crypto.randomBytes(4096);
  const keys = fakeMinisign({ file: `${app.name}.app.tar.gz` });
  const signature = keys.sign(data);
  assert(verifySignature(data, signature, keys.pubkey).trustedComment.startsWith("timestamp:"), "a matching pair verifies");
  expectExit("tampered file", EXIT.mismatch, () => verifySignature(Buffer.concat([data, Buffer.from("x")]), signature, keys.pubkey));
  expectExit("another key pair", EXIT.mismatch, () => verifySignature(data, signature, fakeMinisign().pubkey));
  const lines = Buffer.from(signature, "base64").toString("utf8").split("\n");
  lines[2] = "trusted comment: timestamp:0\tfile:other";
  expectExit("tampered trusted comment", EXIT.mismatch, () => verifySignature(data, Buffer.from(lines.join("\n")).toString("base64"), keys.pubkey));
  const legacy = fakeMinisign({ prehashed: false });
  verifySignature(data, legacy.sign(data), legacy.pubkey);
  expectExit("not a minisign key", EXIT.mismatch, () => verifySignature(data, signature, Buffer.from("hello").toString("base64")));
  expectExit("the placeholder", EXIT.mismatch, () => parsePublicKey(app.placeholder));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "updater-key-test-"));
  try {
    const conf = path.join(dir, "tauri.conf.json");
    fs.writeFileSync(conf, JSON.stringify({ plugins: { updater: { pubkey: app.placeholder } } }));
    expectExit("placeholder pubkey", EXIT.notConfigured, () => configuredPubkey(app, conf));
    fs.writeFileSync(conf, JSON.stringify({ plugins: {} }));
    expectExit("missing pubkey", EXIT.notConfigured, () => configuredPubkey(app, conf));
    fs.writeFileSync(conf, JSON.stringify({ plugins: { updater: { pubkey: keys.pubkey } } }));
    assert(configuredPubkey(app, conf) === keys.pubkey, "a configured pubkey");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("self-test: ok");
}

function main(app, argv) {
  const { command, options } = parseArgs(argv);
  switch (command) {
    case "status": {
      const { keyId } = parsePublicKey(configuredPubkey(app));
      console.log(`${app.name} の自動更新の公開鍵は設定済みです（鍵 ID ${keyIdText(keyId)}）`);
      return;
    }
    case "verify": {
      if (!options.file || !options.sig) throw new KeyError("verify には --file と --sig が要ります", EXIT.usage);
      const pubkey = options.pubkey ?? (options["pubkey-file"] ? fs.readFileSync(options["pubkey-file"], "utf8") : configuredPubkey(app));
      const result = verifySignature(fs.readFileSync(options.file), fs.readFileSync(options.sig, "utf8"), pubkey);
      console.log(`更新の署名を確かめました（鍵 ID ${result.keyId}）: ${path.basename(options.file)}`);
      return;
    }
    case "self-test":
      selfTest(app);
      return;
    default:
      throw new KeyError(`使い方: updater-key.mjs <status|verify|self-test>（${command ?? "コマンドなし"}）`, EXIT.usage);
  }
}

/** CLI（status・verify・self-test）を app の公開鍵の置き場で動かす。終了コードは上の「終了コード」。 */
export function runUpdaterKeyCli(app, argv = process.argv.slice(2)) {
  try {
    main(app, argv);
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode ?? EXIT.mismatch);
  }
}

/** このファイルを node で直接動かしたか（symlink の先でも同じ。外れると status が何もせず 0 で終わるので実体で比べる）。 */
function invokedDirectly() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// NIHO camera の updater-key.mjs が import するときは動かさない（そちらが自分の UpdaterApp で runUpdaterKeyCli を呼ぶ）
if (invokedDirectly()) {
  runUpdaterKeyCli(DOCS_APP);
}
