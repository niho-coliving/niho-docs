/**
 * 端末間で共通の文字起こし結果 `niho.speech-result` v1（#18641 D1）。iPhone の端末内処理が書き出し、
 * Web・Android・共有 Mac の runner が同じ形を読む。話者番号はその音声の中だけで有効で、名前は人が確かめたものだけを持つ。
 * fixture は `packages/docs-core/fixtures/speech-result-v1/`（Swift のテストも同じファイルを読む）。
 */

import type { Language, SpeakerMode } from "./types.js";
import { TRANSCRIPT_SPEAKER_NAME_MAX_CHARS } from "./transcript-speakers.js";
import { transcriptMarkdown } from "./transcript.js";

export const SPEECH_RESULT_SCHEMA = "niho.speech-result";
export const SPEECH_RESULT_VERSION = 1;

/** 話者の区間の終わりが音声の長さを丸めの分だけ越えるのは許す（SpeakerMap と同じ 0.02 秒）。 */
const DURATION_TOLERANCE_SECONDS = 0.02;

export type SpeechResultDiarizer = {
  name: string;
  version: string;
  modelRevision: string;
};

export type SpeechResultSegment = {
  /** 元の音声の絶対秒。時刻の無い文字は start・end とも null。 */
  start: number | null;
  end: number | null;
  /** 認識した本文（人の修正は入れない）。 */
  text: string;
  /** その音声での 1 始まりの話者番号。根拠が足りない・重なる・話者分離なしは null。 */
  speaker: number | null;
};

export type SpeechResultV1 = {
  schema: typeof SPEECH_RESULT_SCHEMA;
  version: typeof SPEECH_RESULT_VERSION;
  language: Language;
  /** 話者分離の指定。"none" は話者分離をしていない（speaker はすべて null）。 */
  speakerMode: SpeakerMode;
  input: { sha256: string; bytes: number; durationSeconds: number };
  engine: { recognizer: string; diarizer: SpeechResultDiarizer | null };
  segments: SpeechResultSegment[];
  /** 人が確かめた名前（キーは話者番号）。推定した名前は入れない。 */
  speakerNames?: Record<string, string>;
};

export type SpeechResultParse = { ok: true; value: SpeechResultV1 } | { ok: false; issues: string[] };

const SPEAKER_MODES: readonly SpeakerMode[] = ["auto", "2", "3", "4plus", "none"];
const LANGUAGES: readonly Language[] = ["ja", "en"];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 形と規則を確かめる。知らない項目は読み飛ばす（後の版で項目を足せるように）が、知っている項目の誤りは 1 つでも断る。
 * 返す value は知っている項目だけの複製。
 */
export function parseSpeechResult(raw: unknown): SpeechResultParse {
  const issues: string[] = [];
  if (!isRecord(raw)) return { ok: false, issues: ["結果が JSON の object ではありません。"] };
  if (raw.schema !== SPEECH_RESULT_SCHEMA) issues.push(`schema が ${SPEECH_RESULT_SCHEMA} ではありません。`);
  if (raw.version !== SPEECH_RESULT_VERSION) issues.push(`version ${String(raw.version)} には対応していません。`);
  const language = LANGUAGES.find((item) => item === raw.language);
  if (!language) issues.push("language が ja・en ではありません。");
  const speakerMode = SPEAKER_MODES.find((item) => item === raw.speakerMode);
  if (!speakerMode) issues.push("speakerMode が auto・2・3・4plus・none ではありません。");

  const input = isRecord(raw.input) ? raw.input : null;
  const sha256 = input?.sha256;
  const bytes = input?.bytes;
  const durationSeconds = input?.durationSeconds;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) issues.push("input.sha256 が小文字 16 進 64 桁ではありません。");
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1) issues.push("input.bytes が 1 以上の整数ではありません。");
  if (!finiteNumber(durationSeconds) || durationSeconds <= 0) issues.push("input.durationSeconds が正の数ではありません。");

  const engine = isRecord(raw.engine) ? raw.engine : null;
  if (!nonEmptyString(engine?.recognizer)) issues.push("engine.recognizer がありません。");
  let diarizer: SpeechResultDiarizer | null = null;
  if (engine?.diarizer !== null) {
    const value = isRecord(engine?.diarizer) ? engine.diarizer : null;
    if (!value || !nonEmptyString(value.name) || !nonEmptyString(value.version) || !nonEmptyString(value.modelRevision)) {
      issues.push("engine.diarizer は name・version・modelRevision を持つ object か null です。");
    } else {
      diarizer = { name: value.name, version: value.version, modelRevision: value.modelRevision };
    }
  }
  if (speakerMode === "none" && engine?.diarizer !== null) issues.push("speakerMode が none のとき engine.diarizer は null です。");
  if (speakerMode && speakerMode !== "none" && engine?.diarizer === null) issues.push("話者分離をした結果には engine.diarizer が要ります。");

  const segments: SpeechResultSegment[] = [];
  if (!Array.isArray(raw.segments)) {
    issues.push("segments が配列ではありません。");
  } else {
    let previousStart = -Infinity;
    raw.segments.forEach((item, index) => {
      const where = `segments[${index}]`;
      if (!isRecord(item)) {
        issues.push(`${where} が object ではありません。`);
        return;
      }
      const { start, end, text, speaker } = item;
      if (!nonEmptyString(text)) issues.push(`${where}.text が空です。`);
      if ((start === null) !== (end === null)) issues.push(`${where} の start と end は両方とも数か両方とも null です。`);
      else if (start !== null) {
        if (!finiteNumber(start) || !finiteNumber(end) || start < 0 || end < start) issues.push(`${where} の時刻の範囲が不正です。`);
        else {
          if (finiteNumber(durationSeconds) && end > durationSeconds + DURATION_TOLERANCE_SECONDS) issues.push(`${where} の終わりが音声の長さを越えています。`);
          if (start < previousStart) issues.push(`${where} が時刻順ではありません。`);
          previousStart = start;
        }
      }
      if (speaker !== null && (typeof speaker !== "number" || !Number.isInteger(speaker) || speaker < 1)) issues.push(`${where}.speaker が 1 以上の整数か null ではありません。`);
      if (speakerMode === "none" && speaker !== null) issues.push(`${where}.speaker: 話者分離をしていない結果に話者番号があります。`);
      segments.push({
        start: finiteNumber(start) ? start : null,
        end: finiteNumber(end) ? end : null,
        text: typeof text === "string" ? text : "",
        speaker: typeof speaker === "number" ? speaker : null,
      });
    });
  }

  let speakerNames: Record<string, string> | undefined;
  if (raw.speakerNames !== undefined) {
    if (!isRecord(raw.speakerNames)) issues.push("speakerNames が object ではありません。");
    else {
      const ids = new Set(segments.flatMap((segment) => (segment.speaker === null ? [] : [String(segment.speaker)])));
      speakerNames = {};
      for (const [key, name] of Object.entries(raw.speakerNames)) {
        if (!ids.has(key)) issues.push(`speakerNames.${key}: 結果に無い話者番号です。`);
        if (typeof name !== "string" || !name.trim() || name !== name.trim() || CONTROL_CHARACTERS.test(name)) issues.push(`speakerNames.${key}: 名前が空か、前後の空白・制御文字があります。`);
        else if (Array.from(name).length > TRANSCRIPT_SPEAKER_NAME_MAX_CHARS) issues.push(`speakerNames.${key}: 名前が ${TRANSCRIPT_SPEAKER_NAME_MAX_CHARS} 文字を越えています。`);
        else speakerNames[key] = name;
      }
    }
  }

  if (issues.length > 0 || !language || !speakerMode || !engine) return { ok: false, issues };
  return {
    ok: true,
    value: {
      schema: SPEECH_RESULT_SCHEMA,
      version: SPEECH_RESULT_VERSION,
      language,
      speakerMode,
      input: { sha256: sha256 as string, bytes: bytes as number, durationSeconds: durationSeconds as number },
      engine: { recognizer: engine.recognizer as string, diarizer },
      segments,
      ...(speakerNames ? { speakerNames } : {}),
    },
  };
}

/**
 * 録音ページの文字起こし（`[hh:mm:ss] 話者N: 本文`）へ。時刻の無い文字は直前の区間の終わりに置く。
 * 話者分離をしていない結果はラベルを付けない。名前は版ごとの話者名（transcript-speakers）で別に扱う。
 */
export function speechResultTranscriptMarkdown(result: SpeechResultV1, name?: string): string {
  let cursor = 0;
  const lines = result.segments.map((segment) => {
    const start = segment.start ?? cursor;
    const end = segment.end ?? start;
    cursor = Math.max(cursor, end);
    const line: Record<string, unknown> = { type: "segment", start, end, text: segment.text };
    if (result.speakerMode !== "none") line.speaker = segment.speaker;
    return JSON.stringify(line);
  });
  return transcriptMarkdown([{ jsonl: lines.join("\n"), offsetSec: 0, ...(name ? { name } : {}) }]);
}
