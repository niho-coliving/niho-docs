/**
 * 文字起こしの整形: sidecar `niho-speech transcribe` の JSONL（spec §6.2）→ `[hh:mm:ss] 本文` の Markdown。
 * speaker は省略＝話者分離なし、null＝不明、1 以上＝その音声内の話者番号。
 */

export type SpeechSegment = { type: "segment"; start: number; end: number; text: string; speaker?: number | null };
export type SpeechProgress = { type: "progress"; ratio: number };
export type SpeechDone = { type: "done"; segments: number; durationMs: number };
export type SpeechLine = SpeechSegment | SpeechProgress | SpeechDone;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** JSONL の 1 行を読む。形の合わない行は null（読み飛ばす）。 */
export function parseSpeechLine(line: string): SpeechLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "segment": {
      const start = finiteNumber(record.start);
      const end = finiteNumber(record.end);
      if (start === null || typeof record.text !== "string") return null;
      if (!("speaker" in record)) return { type: "segment", start, end: end ?? start, text: record.text };
      const speaker = record.speaker;
      if (speaker !== null && (typeof speaker !== "number" || !Number.isInteger(speaker) || speaker < 1)) return null;
      return { type: "segment", start, end: end ?? start, text: record.text, speaker };
    }
    case "progress": {
      const ratio = finiteNumber(record.ratio);
      return ratio === null ? null : { type: "progress", ratio: Math.min(1, Math.max(0, ratio)) };
    }
    case "done": {
      return {
        type: "done",
        segments: finiteNumber(record.segments) ?? 0,
        durationMs: finiteNumber(record.durationMs) ?? 0,
      };
    }
    default:
      return null;
  }
}

export function parseSpeechJsonl(jsonl: string): SpeechLine[] {
  return jsonl
    .split(/\r?\n/)
    .map(parseSpeechLine)
    .filter((line): line is SpeechLine => line !== null);
}

/** 秒 → `hh:mm:ss`（切り捨て）。 */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":");
}

/** 区切りごとの文字起こし（複数の音声は前の音声の長さだけ時刻をずらして 1 本に繋ぐ）。 */
export type TranscriptPart = {
  jsonl: string;
  /** この音声の先頭の時刻（前の音声の長さの合計・秒）。 */
  offsetSec: number;
  /** 複数音声の話者番号を別 scope にする表示名。話者付きのときだけ Part 見出しへ使う。 */
  name?: string;
};

function safePartName(name: string | undefined, fallback: string): string {
  const sanitized = (name ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || fallback;
}

/** 区切りの段落（`[hh:mm:ss] 本文`）を 1 行ずつ、空行で分けて並べる。本文の空白だけの区切りは除く。 */
export function transcriptMarkdown(parts: readonly TranscriptPart[]): string {
  const parsed = parts.map((part) => ({ part, segments: parseSpeechJsonl(part.jsonl).filter((line): line is SpeechSegment => line.type === "segment") }));
  const scoped = parts.length > 1 && parsed.some(({ segments }) => segments.some((line) => line.speaker !== undefined));
  const sections: string[] = [];
  parsed.forEach(({ part, segments }, index) => {
    const paragraphs: string[] = [];
    for (const line of segments) {
      const text = line.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const label = line.speaker === undefined ? "" : line.speaker === null ? "話者?: " : `話者${line.speaker}: `;
      paragraphs.push(`[${formatTimestamp(line.start + part.offsetSec)}] ${label}${text}`);
    }
    if (paragraphs.length === 0) return;
    const heading = scoped ? `## Part ${index + 1}: ${safePartName(part.name, `音声${index + 1}`)}\n\n` : "";
    sections.push(`${heading}${paragraphs.join("\n\n")}`);
  });
  return sections.length > 0 ? `${sections.join("\n\n")}\n` : "";
}

/** 段落の先頭の時刻（`[hh:mm:ss] `）。Markdown へ戻すときにこの部分を書いたままにする。 */
export const TIMESTAMP_PREFIX = /^\[\d{2,}:\d{2}:\d{2}\] /;
