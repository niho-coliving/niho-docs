#!/usr/bin/env node
// 合成会話の正解（generate.mjs）と認識結果を照らし、文字・話者・相づちの誤りを別々に数える。
//
//   node apps/docs/sidecar/speech-bench/score.mjs --truth <name>.truth.json --result <transcribe.jsonl | speech-result.json>
//     [--speaker-map speaker-map.json]
//
// result は `niho-speech transcribe --speaker-map` の JSONL か、iPhone の書き出し（niho.speech-result v1）。
// speaker-map を渡したときだけ、話者分離そのものの DER（collar 0.25 秒・重なりなし）も出す。
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const KATAKANA = /[ァ-ヶ]/gu;

/** NFKC・空白と句読点・記号の除去・カタカナをひらがなへ。表記ゆれのうち読み方の差だけを吸収する。 */
export function normalizeText(text) {
  return text
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}\p{Z}\s]/gu, "")
    .replace(KATAKANA, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
}

/** 編集距離（2 行の DP。60 分 ≈ 2 万字でも数秒）。 */
export function editDistance(reference, hypothesis) {
  const a = Array.from(reference);
  const b = Array.from(hypothesis);
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Int32Array(b.length + 1);
  let current = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    const char = a[i - 1];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (char === b[j - 1] ? 0 : 1);
      const deletion = previous[j] + 1;
      const insertion = current[j - 1] + 1;
      current[j] = substitution < deletion ? (substitution < insertion ? substitution : insertion) : deletion < insertion ? deletion : insertion;
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/** 認識結果を {start, end, text, speaker} の列へ。speaker は 1 以上・null（不明）。 */
export function readResult(raw) {
  let whole;
  try {
    whole = JSON.parse(raw);
  } catch {
    whole = undefined;
  }
  if (whole && typeof whole === "object" && "schema" in whole) return resultSegments(whole);
  const segments = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const value = JSON.parse(line);
    if (value.type === "segment") segments.push({ start: value.start, end: value.end, text: value.text, speaker: value.speaker ?? null });
  }
  return segments;
}

function resultSegments(value) {
  if (value.schema !== "niho.speech-result" || value.version !== 1) throw new Error("niho.speech-result v1 ではありません");
  return value.segments.map((segment) => ({ start: segment.start, end: segment.end, text: segment.text, speaker: segment.speaker }));
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** 仮説の話者 → 正解の話者の 1 対 1 対応で重みの和を最大にする（話者は高々数人なので全探索）。余る仮説の話者は対応なし。 */
export function bestMapping(weights) {
  const hypothesis = [...weights.keys()];
  const references = [...new Set(hypothesis.flatMap((key) => [...weights.get(key).keys()]))];
  let best = { total: -1, mapping: new Map() };
  const used = new Set();
  const current = new Map();
  function visit(index, total) {
    if (index === hypothesis.length) {
      if (total > best.total) best = { total, mapping: new Map(current) };
      return;
    }
    const key = hypothesis[index];
    for (const reference of references) {
      if (used.has(reference)) continue;
      used.add(reference);
      current.set(key, reference);
      visit(index + 1, total + (weights.get(key).get(reference) ?? 0));
      used.delete(reference);
      current.delete(key);
    }
    visit(index + 1, total);
  }
  if (hypothesis.length <= 8) visit(0, 0);
  else {
    // 話者が多すぎるときは重い順に貪欲に割り当てる。
    const pairs = hypothesis.flatMap((key) => [...weights.get(key)].map(([reference, weight]) => ({ key, reference, weight })));
    pairs.sort((a, b) => b.weight - a.weight);
    for (const pair of pairs) {
      if (best.mapping.has(pair.key) || used.has(pair.reference)) continue;
      best.mapping.set(pair.key, pair.reference);
      used.add(pair.reference);
    }
  }
  return best.mapping;
}

function referenceSpeakerAt(start, end, turns) {
  const bySpeaker = new Map();
  for (const turn of turns) {
    const value = overlap(start, end, turn.start, turn.end);
    if (value > 0) bySpeaker.set(turn.speaker, (bySpeaker.get(turn.speaker) ?? 0) + value);
  }
  return bySpeaker;
}

/** 文字単位の話者の帰属: 正しい・取り違え・不明（話者?）・時刻なし を、認識した文字数の割合で返す。 */
export function speakerAttribution(segments, truth) {
  const weights = new Map();
  const timed = [];
  for (const segment of segments) {
    const chars = Array.from(normalizeText(segment.text)).length;
    if (chars === 0) continue;
    const hasTime = Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start;
    const references = hasTime ? referenceSpeakerAt(segment.start, segment.end, truth.turns) : new Map();
    timed.push({ segment, chars, references, hasTime });
    if (segment.speaker === null || !hasTime) continue;
    const row = weights.get(segment.speaker) ?? new Map();
    const duration = segment.end - segment.start;
    for (const [reference, value] of references) row.set(reference, (row.get(reference) ?? 0) + (chars * value) / duration);
    weights.set(segment.speaker, row);
  }
  const mapping = bestMapping(weights);
  const totals = { chars: 0, correct: 0, confused: 0, unknown: 0, untimed: 0 };
  for (const { segment, chars, references, hasTime } of timed) {
    totals.chars += chars;
    if (!hasTime) totals.untimed += chars;
    else if (segment.speaker === null) totals.unknown += chars;
    else {
      const majority = [...references].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (majority !== undefined && mapping.get(segment.speaker) === majority) totals.correct += chars;
      else totals.confused += chars;
    }
  }
  const ratio = (value) => (totals.chars === 0 ? 0 : round(value / totals.chars));
  return {
    hypothesisSpeakers: new Set(segments.map((segment) => segment.speaker).filter((value) => value !== null)).size,
    mapping: Object.fromEntries([...mapping].map(([key, value]) => [String(key), value])),
    correctCharRatio: ratio(totals.correct),
    confusedCharRatio: ratio(totals.confused),
    unknownCharRatio: ratio(totals.unknown),
    untimedCharRatio: ratio(totals.untimed),
  };
}

/** 相づち（正解の backchannel）を前後 1 秒の認識結果の中で拾えたか、拾えたうち話者が合うか。 */
export function backchannelRecall(segments, truth, mapping) {
  const items = truth.turns.filter((turn) => turn.backchannel);
  let found = 0;
  let attributed = 0;
  for (const item of items) {
    const needle = normalizeText(item.text);
    const near = segments.filter((segment) =>
      Number.isFinite(segment.start) && Number.isFinite(segment.end) && overlap(segment.start, segment.end, item.start - 1, item.end + 1) > 0);
    const hit = near.find((segment) => normalizeText(segment.text).includes(needle));
    if (!hit) continue;
    found += 1;
    if (hit.speaker !== null && mapping[String(hit.speaker)] === item.speaker) attributed += 1;
  }
  return { backchannels: items.length, recall: items.length === 0 ? null : round(found / items.length), attributedAmongFound: found === 0 ? null : round(attributed / found) };
}

/** 10 ms の格子で DER（miss・false alarm・confusion）を数える。正解の境界の前後 collar 秒は数えない。 */
export function diarizationErrorRate(map, truth, collar = 0.25) {
  const step = 0.01;
  const frames = Math.ceil(Math.max(truth.durationSeconds, map.duration) / step);
  const reference = new Int16Array(frames);
  const excluded = new Uint8Array(frames);
  for (const turn of truth.turns) {
    const from = Math.floor(turn.start / step);
    const to = Math.min(frames, Math.ceil(turn.end / step));
    for (let index = from; index < to; index += 1) reference[index] = turn.speaker;
    for (const edge of [turn.start, turn.end]) {
      const lower = Math.max(0, Math.floor((edge - collar) / step));
      const upper = Math.min(frames, Math.ceil((edge + collar) / step));
      for (let index = lower; index < upper; index += 1) excluded[index] = 1;
    }
  }
  const hypothesis = Array.from({ length: frames }, () => []);
  const weights = new Map();
  for (const turn of map.turns) {
    const from = Math.floor(turn.start / step);
    const to = Math.min(frames, Math.ceil(turn.end / step));
    const row = weights.get(turn.id) ?? new Map();
    for (let index = from; index < to; index += 1) {
      if (!hypothesis[index].includes(turn.id)) hypothesis[index].push(turn.id);
      if (reference[index] > 0) row.set(reference[index], (row.get(reference[index]) ?? 0) + step);
    }
    weights.set(turn.id, row);
  }
  const mapping = bestMapping(weights);
  let speech = 0;
  let miss = 0;
  let falseAlarm = 0;
  let confusion = 0;
  for (let index = 0; index < frames; index += 1) {
    if (excluded[index]) continue;
    const truthSpeaker = reference[index];
    const mapped = hypothesis[index].map((id) => mapping.get(id) ?? -id);
    if (truthSpeaker > 0) {
      speech += 1;
      if (mapped.length === 0) miss += 1;
      else if (!mapped.includes(truthSpeaker)) confusion += 1;
      falseAlarm += Math.max(0, mapped.length - 1);
    } else {
      falseAlarm += mapped.length;
    }
  }
  return {
    collarSeconds: collar,
    der: speech === 0 ? null : round((miss + falseAlarm + confusion) / speech),
    miss: speech === 0 ? null : round(miss / speech),
    falseAlarm: speech === 0 ? null : round(falseAlarm / speech),
    confusion: speech === 0 ? null : round(confusion / speech),
    hypothesisSpeakers: weights.size,
    referenceSpeakers: truth.speakers.length,
  };
}

export function score(truth, segments, map) {
  const reference = truth.turns.map((turn) => normalizeText(turn.text)).join("");
  const hypothesis = segments.map((segment) => normalizeText(segment.text)).join("");
  const attribution = speakerAttribution(segments, truth);
  return {
    name: truth.name,
    audioSeconds: truth.durationSeconds,
    referenceSpeakers: truth.speakers.length,
    referenceChars: Array.from(reference).length,
    hypothesisChars: Array.from(hypothesis).length,
    cer: round(editDistance(reference, hypothesis) / Math.max(1, Array.from(reference).length)),
    segments: segments.length,
    unknownSegments: segments.filter((segment) => segment.speaker === null).length,
    attribution,
    backchannel: backchannelRecall(segments, truth, attribution.mapping),
    ...(map ? { diarization: diarizationErrorRate(map, truth) } : {}),
  };
}

const round = (value) => Math.round(value * 10000) / 10000;

function main() {
  const { values } = parseArgs({ options: { truth: { type: "string" }, result: { type: "string" }, "speaker-map": { type: "string" } } });
  if (!values.truth || !values.result) throw new Error("--truth と --result が必要です");
  const truth = JSON.parse(readFileSync(values.truth, "utf8"));
  const segments = readResult(readFileSync(values.result, "utf8"));
  const map = values["speaker-map"] ? JSON.parse(readFileSync(values["speaker-map"], "utf8")) : undefined;
  process.stdout.write(`${JSON.stringify(score(truth, segments, map), null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
