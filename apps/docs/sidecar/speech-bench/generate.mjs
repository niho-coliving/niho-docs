#!/usr/bin/env node
// 合成の日本語会話（macOS `say`）と、その正解（話者ターン・本文・相づち）を作る。
// 文字の誤り・話者の誤り・相づちの脱落・実時間・メモリを同じ条件で繰り返し測るための固定データで、
// 実会議の精度の代わりにはならない（README.md）。
//
//   node apps/docs/sidecar/speech-bench/generate.mjs --out <dir> [--only d15m-2spk,...]
//
// 出力: <dir>/<name>.wav（16 kHz・mono・16-bit）・<name>.m4a（AAC 32 kbps）・<name>.truth.json
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export const SAMPLE_RATE = 16000;

/** 声は Eloquence 系と Kyoko を混ぜ、人数が増えるほど似た高さの声が入るように並べる。 */
export const VOICES = ["Kyoko", "Reed", "Flo", "Grandpa"];

export const DATASETS = [
  { name: "d1m-2spk", minutes: 1, speakers: 2, seed: 101 },
  { name: "d15m-2spk", minutes: 15, speakers: 2, seed: 1502 },
  { name: "d60m-2spk", minutes: 60, speakers: 2, seed: 6002 },
  { name: "d15m-3spk", minutes: 15, speakers: 3, seed: 1503 },
  { name: "d15m-4spk", minutes: 15, speakers: 4, seed: 1504 },
];

// 数字・英字は読み上げと認識の表記が揃わないので入れない。
const TOPICS = [
  "共用キッチンの使い方", "週末の持ち寄りごはん", "掃除当番の回し方", "庭の手入れ", "新しく入る人の歓迎会",
  "洗濯機の順番", "自転車置き場", "冬の暖房の使い方", "夜の静かな時間", "地域のお祭りへの参加",
  "朝の散歩の会", "本棚の整理", "ごみの分け方", "畑で採れた野菜", "来月の見学の受け入れ",
];
const OPENERS = ["そういえば", "ちょっと相談なんですが", "前から気になっていたんですけど", "この前話した", "みんなに聞きたいのは"];
const OPINIONS = [
  "もう少し決まりをゆるくしてもいいと思います",
  "最初に誰が担当するかを決めておくと楽になりそうです",
  "掲示板に書いておけば忘れずに済みますね",
  "一度みんなで集まって話した方が早いかもしれません",
  "去年は同じことでかなり困った覚えがあります",
  "近所の方にも声をかけてみるのはどうでしょうか",
  "無理のない範囲で続けられる形にしたいです",
  "道具をそろえるところから始めると良さそうです",
  "夕方なら私も手伝えると思います",
  "まずは試しにやってみて、合わなければ戻しましょう",
  "細かいことは担当の人に任せてもいいですよね",
  "前に住んでいた人が残した記録が役に立ちそうです",
];
const FOLLOWUPS = [
  "それなら私が下書きを作ってきます",
  "確かに、その方がわかりやすいですね",
  "ただ、平日の夜は少し難しいかもしれません",
  "去年の写真を探してみんなに見せますね",
  "次の集まりまでに案をいくつか考えておきます",
  "それはいい考えだと思います",
  "少し時間をもらって、まわりにも聞いてみます",
];
const BACKCHANNELS = ["はい", "ええ", "なるほど", "うんうん", "そうですね"];

/** 再現できる乱数（mulberry32）。 */
export function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length)];

function utterance(random) {
  const roll = random();
  if (roll < 0.45) return `${pick(random, OPENERS)}、${pick(random, TOPICS)}のことです。${pick(random, OPINIONS)}。`;
  if (roll < 0.8) return `${pick(random, TOPICS)}については、${pick(random, OPINIONS)}。`;
  return `${pick(random, FOLLOWUPS)}。`;
}

/** WAV（`say` は fmt と data の間に FLLR を入れる）から 16 kHz・mono・16-bit の PCM を取り出す。 */
export function readPcm16(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("WAV ではありません");
  let offset = 12;
  let format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = { tag: buffer.readUInt16LE(body), channels: buffer.readUInt16LE(body + 2), rate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!format || format.tag !== 1 || format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16) {
        throw new Error(`想定外の WAV 形式です: ${JSON.stringify(format)}`);
      }
      return new Int16Array(buffer.buffer.slice(buffer.byteOffset + body, buffer.byteOffset + body + (size & ~1)));
    }
    offset = body + size + (size & 1);
  }
  throw new Error("data がありません");
}

export function wavBuffer(samples) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples.length * 2, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]);
}

/** 先頭と末尾の無音（|s| < 64）を除いた範囲。`say` は前後に短い無音を付ける。 */
export function trimSilence(samples, threshold = 64) {
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]) < threshold) start += 1;
  while (end > start && Math.abs(samples[end - 1]) < threshold) end -= 1;
  return samples.subarray(start, end);
}

function speak(voice, text, work) {
  const file = join(work, "u.wav");
  execFileSync("say", ["-v", voice, "--file-format=WAVE", `--data-format=LEI16@${SAMPLE_RATE}`, "-o", file, text]);
  return trimSilence(readPcm16(readFileSync(file)));
}

/**
 * 話者を順に回し（同じ人が続くこともある）、ときどき別の人の相づちを挟む。
 * 発話の間は 0.3〜1.2 秒の無音。重なりは作らない（重なりは実録音の評価に残す）。
 */
export function script(dataset, random) {
  const targetSeconds = dataset.minutes * 60;
  const turns = [];
  let seconds = 0.5;
  let speaker = 1;
  while (seconds < targetSeconds) {
    const text = utterance(random);
    turns.push({ speaker, text, backchannel: false });
    seconds += text.length / 7 + 0.8;
    if (random() < 0.25) {
      const other = ((speaker + Math.floor(random() * (dataset.speakers - 1))) % dataset.speakers) + 1;
      turns.push({ speaker: other, text: pick(random, BACKCHANNELS), backchannel: true });
      seconds += 1.2;
    }
    if (random() < 0.8) speaker = (speaker % dataset.speakers) + 1;
  }
  return turns;
}

function render(dataset, work) {
  const random = rng(dataset.seed);
  const planned = script(dataset, random);
  const chunks = [];
  const turns = [];
  let cursor = Math.round(0.5 * SAMPLE_RATE);
  chunks.push(new Int16Array(cursor));
  for (const turn of planned) {
    if (cursor / SAMPLE_RATE >= dataset.minutes * 60) break;
    const pcm = speak(VOICES[turn.speaker - 1], turn.text, work);
    if (pcm.length === 0) continue;
    turns.push({
      start: round(cursor / SAMPLE_RATE),
      end: round((cursor + pcm.length) / SAMPLE_RATE),
      speaker: turn.speaker,
      text: turn.text,
      backchannel: turn.backchannel,
    });
    chunks.push(pcm);
    cursor += pcm.length;
    const gap = Math.round((0.3 + random() * 0.9) * SAMPLE_RATE);
    chunks.push(new Int16Array(gap));
    cursor += gap;
  }
  const samples = new Int16Array(cursor);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  return { samples, turns };
}

const round = (value) => Math.round(value * 1000) / 1000;

function main() {
  const { values } = parseArgs({ options: { out: { type: "string" }, only: { type: "string" } } });
  if (!values.out) throw new Error("--out <dir> が必要です");
  const only = values.only ? new Set(values.only.split(",")) : null;
  mkdirSync(values.out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "niho-speech-bench-"));
  try {
    for (const dataset of DATASETS.filter((item) => !only || only.has(item.name))) {
      const started = Date.now();
      const { samples, turns } = render(dataset, work);
      const wav = join(values.out, `${dataset.name}.wav`);
      writeFileSync(wav, wavBuffer(samples));
      execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "32000", wav, join(values.out, `${dataset.name}.m4a`)]);
      const truth = {
        schema: "niho.speech-bench-truth",
        version: 1,
        name: dataset.name,
        seed: dataset.seed,
        durationSeconds: round(samples.length / SAMPLE_RATE),
        speakers: VOICES.slice(0, dataset.speakers).map((voice, index) => ({ id: index + 1, voice })),
        turns,
      };
      writeFileSync(join(values.out, `${dataset.name}.truth.json`), `${JSON.stringify(truth, null, 2)}\n`);
      process.stderr.write(`${dataset.name}: ${truth.durationSeconds}s, ${turns.length} turns (${Math.round((Date.now() - started) / 1000)}s)\n`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
