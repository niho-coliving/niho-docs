#!/usr/bin/env node
// generate.mjs の合成会話を、NIHO docs と同じ sidecar の手順（convert → diarize → transcribe --speaker-map）で処理し、
// 段階ごとの実時間・最大メモリと score.mjs の結果を 1 つの JSON にまとめる。
//
//   node apps/docs/sidecar/speech-bench/run-mac.mjs --bin <niho-speech> --bench <dir> --out <dir>
//     [--only d15m-2spk,...] [--modes exact,auto]
//
// モデルは呼ぶ側が `niho-speech download --language ja` で用意しておく（このスクリプトは取得しない）。
// HOME を検証用の空の home にすると、話者分離モデルの置き場も実アプリと分かれる。
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { score } from "./score.mjs";

/** `/usr/bin/time -l` の出力（macOS）から実時間・最大 RSS・peak memory footprint を読む。 */
export function parseTimeOutput(stderr) {
  const number = (pattern) => {
    const match = pattern.exec(stderr);
    return match ? Number(match[1]) : null;
  };
  return {
    wallSeconds: number(/([\d.]+) real/u),
    userSeconds: number(/([\d.]+) user/u),
    maxResidentBytes: number(/(\d+)\s+maximum resident set size/u),
    peakFootprintBytes: number(/(\d+)\s+peak memory footprint/u),
  };
}

function measure(bin, args, stdoutFile) {
  const result = spawnSync("/usr/bin/time", ["-l", bin, ...args], { encoding: "utf8", maxBuffer: 1 << 30 });
  if (stdoutFile) writeFileSync(stdoutFile, result.stdout);
  const last = result.stdout.trim().split("\n").at(-1) ?? "";
  if (result.status !== 0) throw new Error(`${args[0]} が失敗しました (${result.status}): ${last}\n${result.stderr.slice(-2000)}`);
  return { ...parseTimeOutput(result.stderr), stdoutLast: last };
}

function main() {
  const { values } = parseArgs({
    options: { bin: { type: "string" }, bench: { type: "string" }, out: { type: "string" }, only: { type: "string" }, modes: { type: "string" } },
  });
  if (!values.bin || !values.bench || !values.out) throw new Error("--bin・--bench・--out が必要です");
  mkdirSync(values.out, { recursive: true });
  const only = values.only ? new Set(values.only.split(",")) : null;
  const modes = (values.modes ?? "exact,auto").split(",");
  const names = readdirSync(values.bench)
    .filter((file) => file.endsWith(".truth.json"))
    .map((file) => file.replace(/\.truth\.json$/u, ""))
    .filter((name) => !only || only.has(name))
    .sort();
  const version = spawnSync(values.bin, ["version"], { encoding: "utf8" }).stdout.trim();
  const summary = { tool: JSON.parse(version), host: hostInfo(), datasets: [] };
  for (const name of names) {
    const truth = JSON.parse(readFileSync(join(values.bench, `${name}.truth.json`), "utf8"));
    const wav = join(values.out, `${name}.16k.wav`);
    const entry = { name, audioSeconds: truth.durationSeconds, speakers: truth.speakers.length, convert: null, modes: {} };
    // 同じ --out で音声を作り直した後も古い WAV を採点しないよう、毎回変換し直す（変換の実時間・メモリもいつも測れる）
    rmSync(wav, { force: true });
    entry.convert = measure(values.bin, ["convert", "--input", join(values.bench, `${name}.m4a`), "--output", wav]);
    for (const mode of modes) {
      const map = join(values.out, `${name}.${mode}.speaker-map.json`);
      const jsonl = join(values.out, `${name}.${mode}.jsonl`);
      const speakers = mode === "exact" ? (truth.speakers.length >= 4 ? ["--minimum-speakers", "4"] : ["--speakers", String(truth.speakers.length)]) : [];
      const diarize = measure(values.bin, ["diarize", "--input", wav, "--output", map, ...speakers]);
      const transcribe = measure(values.bin, ["transcribe", "--input", wav, "--language", "ja", "--speaker-map", map], jsonl);
      const segments = readFileSync(jsonl, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.type === "segment")
        .map((line) => ({ start: line.start, end: line.end, text: line.text, speaker: line.speaker ?? null }));
      const scored = score(truth, segments, JSON.parse(readFileSync(map, "utf8")));
      entry.modes[mode] = { speakerArgs: speakers, diarize, transcribe, score: scored };
      process.stderr.write(`${name} ${mode}: CER ${scored.cer}, DER ${scored.diarization?.der}, 正しい帰属 ${scored.attribution.correctCharRatio}, 不明 ${scored.attribution.unknownCharRatio}, ` +
        `diarize ${diarize.wallSeconds}s, transcribe ${transcribe.wallSeconds}s\n`);
    }
    summary.datasets.push(entry);
    writeFileSync(join(values.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  }
}

function hostInfo() {
  const read = (command, args) => spawnSync(command, args, { encoding: "utf8" }).stdout.trim();
  return {
    model: read("sysctl", ["-n", "hw.model"]),
    chip: read("sysctl", ["-n", "machdep.cpu.brand_string"]),
    memoryBytes: Number(read("sysctl", ["-n", "hw.memsize"])),
    os: read("sw_vers", ["-productVersion"]),
    build: read("sw_vers", ["-buildVersion"]),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) main();
