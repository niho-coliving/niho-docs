import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RESOURCE_BUNDLES, stageBuiltArtifacts } from "./stage-speech-sidecar.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niho-stage-speech-"));
  const productsDirectory = path.join(root, "products");
  const stageDirectory = path.join(root, "stage");
  fs.mkdirSync(productsDirectory);
  fs.writeFileSync(path.join(productsDirectory, "niho-speech"), "binary", { mode: 0o755 });
  for (const name of RESOURCE_BUNDLES) {
    const bundle = path.join(productsDirectory, name);
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, name.startsWith("Niho") ? "diarization-model-manifest.json" : "lexicon"), name);
  }
  return { root, productsDirectory, stageDirectory };
}

test("stages the binary and both resource bundles without build paths", () => {
  const value = fixture();
  try {
    const staged = stageBuiltArtifacts(value);
    assert.equal(fs.readFileSync(staged.executable, "utf8"), "binary");
    assert.equal(staged.resources.length, 2);
    for (const bundle of staged.resources) assert.equal(fs.statSync(bundle).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(staged.resources[0], "diarization-model-manifest.json"), "utf8"), RESOURCE_BUNDLES[0]);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("fails closed when a required SwiftPM resource bundle is absent", () => {
  const value = fixture();
  try {
    fs.rmSync(path.join(value.productsDirectory, RESOURCE_BUNDLES[1]), { recursive: true });
    assert.throws(() => stageBuiltArtifacts(value), /resource bundle is missing/);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("makes only staged read-only SDK resources writable for packaging", () => {
  const value = fixture();
  const upstream = path.join(value.productsDirectory, RESOURCE_BUNDLES[1], "lexicon");
  try {
    fs.chmodSync(upstream, 0o444);
    const staged = stageBuiltArtifacts(value);
    assert.equal(fs.statSync(upstream).mode & 0o777, 0o444);
    assert.equal(fs.statSync(path.join(staged.resources[1], "lexicon")).mode & 0o777, 0o644);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});
