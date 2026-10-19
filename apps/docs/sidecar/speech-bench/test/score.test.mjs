import assert from "node:assert/strict";
import test from "node:test";
import { readPcm16, rng, script, DATASETS, trimSilence, wavBuffer } from "../generate.mjs";
import { bestMapping, diarizationErrorRate, editDistance, normalizeText, readResult, score } from "../score.mjs";

const truth = {
  name: "unit",
  durationSeconds: 10,
  speakers: [{ id: 1 }, { id: 2 }],
  turns: [
    { start: 0, end: 4, speaker: 1, text: "共用キッチンの話です。", backchannel: false },
    { start: 4.5, end: 5, speaker: 2, text: "はい", backchannel: true },
    { start: 5.5, end: 9.5, speaker: 2, text: "掃除当番を決めましょう。", backchannel: false },
  ],
};

test("normalizeText absorbs punctuation, width and katakana but keeps kanji", () => {
  assert.equal(normalizeText("ゴミ、 ＡＢ！ 当番。"), "ごみAB当番");
});

test("editDistance counts substitutions, insertions and deletions", () => {
  assert.equal(editDistance("かきくけこ", "かきくけこ"), 0);
  assert.equal(editDistance("かきくけこ", "かきけこ"), 1);
  assert.equal(editDistance("かきくけこ", "かさくけこさ"), 2);
  assert.equal(editDistance("", "あい"), 2);
});

test("bestMapping maximises the total weight one-to-one and leaves extra speakers unmapped", () => {
  const weights = new Map([
    [7, new Map([[1, 10], [2, 1]])],
    [3, new Map([[1, 9], [2, 8]])],
    [9, new Map([[2, 2]])],
  ]);
  const mapping = bestMapping(weights);
  assert.equal(mapping.get(7), 1);
  assert.equal(mapping.get(3), 2);
  assert.equal(mapping.has(9), false);
});

test("score separates character errors from speaker errors and unknown attribution", () => {
  const segments = [
    { start: 0, end: 4, text: "共用キッチンの話です。", speaker: 2 },
    { start: 4.5, end: 5, text: "はい。", speaker: null },
    { start: 5.5, end: 9.5, text: "掃除当番を決めましょう。", speaker: 1 },
  ];
  const result = score(truth, segments);
  assert.equal(result.cer, 0);
  // 番号は入れ替わっていても、一貫していれば正しい帰属として数える。
  assert.deepEqual(result.attribution.mapping, { 1: 2, 2: 1 });
  assert.equal(result.attribution.correctCharRatio, 1 - result.attribution.unknownCharRatio);
  assert.ok(result.attribution.unknownCharRatio > 0);
  assert.equal(result.backchannel.recall, 1);
  assert.equal(result.backchannel.attributedAmongFound, 0);
});

test("score counts a wrong speaker as confusion, not as a character error", () => {
  const segments = [
    { start: 0, end: 4, text: "共用キッチンの話です。", speaker: 1 },
    { start: 4.5, end: 9.5, text: "はい掃除当番を決めましょう。", speaker: 1 },
  ];
  const result = score(truth, segments);
  assert.equal(result.cer, 0);
  // 話者1 は文字の多い正解の話者2 に対応し、最初の発言（10 文字 / 全 23 文字）が取り違えになる。
  assert.deepEqual(result.attribution.mapping, { 1: 2 });
  assert.equal(result.attribution.confusedCharRatio, Math.round((10 / 23) * 10000) / 10000);
  assert.equal(result.attribution.unknownCharRatio, 0);
});

test("diarizationErrorRate is zero for a perfect relabelled map and counts misses", () => {
  const perfect = { duration: 10, turns: [{ start: 0, end: 4, id: 2 }, { start: 4.5, end: 5, id: 1 }, { start: 5.5, end: 9.5, id: 1 }] };
  assert.equal(diarizationErrorRate(perfect, truth).der, 0);
  const missing = { duration: 10, turns: [{ start: 0, end: 4, id: 1 }] };
  const result = diarizationErrorRate(missing, truth);
  assert.ok(result.miss > 0.4);
  assert.equal(result.confusion, 0);
});

test("readResult reads both sidecar JSONL and niho.speech-result v1", () => {
  const jsonl = [
    JSON.stringify({ type: "progress", ratio: 0.5 }),
    JSON.stringify({ type: "segment", start: 1, end: 2, text: "あ", speaker: null }),
    JSON.stringify({ type: "done", segments: 1, durationMs: 3 }),
  ].join("\n");
  assert.deepEqual(readResult(jsonl), [{ start: 1, end: 2, text: "あ", speaker: null }]);
  const v1 = { schema: "niho.speech-result", version: 1, segments: [{ start: null, end: null, text: "い", speaker: null }] };
  assert.deepEqual(readResult(JSON.stringify(v1)), [{ start: null, end: null, text: "い", speaker: null }]);
  assert.throws(() => readResult(JSON.stringify({ schema: "other", version: 1, segments: [] })));
});

test("generator scripts are reproducible and every dataset uses all of its speakers", () => {
  for (const dataset of DATASETS) {
    const first = script(dataset, rng(dataset.seed));
    const second = script(dataset, rng(dataset.seed));
    assert.deepEqual(first, second);
    assert.equal(new Set(first.map((turn) => turn.speaker)).size, dataset.speakers);
    assert.ok(first.some((turn) => turn.backchannel));
    assert.ok(first.every((turn) => !/[0-9A-Za-z０-９]/u.test(turn.text)));
  }
});

test("WAV helpers round-trip 16 kHz mono PCM and skip extra chunks", () => {
  const samples = Int16Array.from([0, 0, 500, -700, 3, 0]);
  const plain = wavBuffer(samples);
  assert.deepEqual(Array.from(readPcm16(plain)), Array.from(samples));
  // `say` は fmt と data の間に FLLR を入れる。
  const filler = Buffer.alloc(8 + 4);
  filler.write("FLLR", 0, "ascii");
  filler.writeUInt32LE(4, 4);
  const withFiller = Buffer.concat([plain.subarray(0, 36), filler, plain.subarray(36)]);
  withFiller.writeUInt32LE(withFiller.length - 8, 4);
  assert.deepEqual(Array.from(readPcm16(withFiller)), Array.from(samples));
  assert.deepEqual(Array.from(trimSilence(samples)), [500, -700]);
});
