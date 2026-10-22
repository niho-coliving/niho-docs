/** WebVTT 原本を検証し、編集可能な文字起こし Markdown へ変換する。原本そのものは host が別ファイルで保持する。 */

export const VTT_MAX_BYTES = 10 * 1024 * 1024;

export type VttCue = {
  id: string | null;
  start: string;
  end: string;
  text: string;
};

export type ParsedVtt = { cues: VttCue[]; markdown: string };

export class VttParseError extends Error {
  readonly code: "empty" | "too_large" | "invalid";

  constructor(code: VttParseError["code"], message: string) {
    super(message);
    this.name = "VttParseError";
    this.code = code;
  }
}

function byteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function timestampSeconds(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if (!match) return null;
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (!Number.isSafeInteger(hours) || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function timestampPrefix(value: string): string {
  const seconds = timestampSeconds(value);
  if (seconds === null) throw new VttParseError("invalid", "VTTの時刻が正しくありません。");
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return [hours, minutes, rest].map((part) => String(part).padStart(2, "0")).join(":");
}

function decodeVttEntities(text: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&lrm;": "\u200e",
    "&rlm;": "\u200f",
    "&nbsp;": "\u00a0",
  };
  return text.replace(/&(amp|lt|gt|lrm|rlm|nbsp);/g, (entity) => entities[entity] ?? entity);
}

/** HTML として解釈させず、VTT の文字として画面に出す。 */
function safeCueText(text: string): string {
  return decodeVttEntities(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 一般的な voice tag の注釈だけを話者表記へ写す。名前の推定・補正・置換はしない。 */
function cueTextMarkdown(text: string): string {
  const withVoices = text.replace(/<v(?:\.[^\s>]*)?(?:[ \t]+([^>]*))?>/gi, (_tag, annotation: string | undefined) => {
    const speaker = annotation?.trim();
    return speaker ? `${decodeVttEntities(speaker)}: ` : "";
  });
  return safeCueText(withVoices.replace(/<\/v>/gi, ""));
}

function invalidBlock(line: number): never {
  throw new VttParseError("invalid", `VTTの${line}行目付近を読み取れませんでした。ファイルを確かめてください。`);
}

/**
 * BOM/CRLF、cue id、複数行 cue、NOTE/STYLE/REGION、voice tag を扱う。壊れた block・空 cue・空ファイル・上限超過は断る。
 */
export function parseVtt(input: string): ParsedVtt {
  if (byteLength(input) > VTT_MAX_BYTES) {
    throw new VttParseError("too_large", "VTTファイルが大きすぎます。分けてから取り込んでください。");
  }
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) throw new VttParseError("empty", "VTTファイルが空です。");
  const lines = normalized.split("\n");
  if (!/^WEBVTT(?:[ \t].*)?$/.test(lines[0] ?? "")) {
    throw new VttParseError("invalid", "WebVTTファイルではありません。先頭のWEBVTTを確かめてください。");
  }

  const cues: VttCue[] = [];
  let index = 1;
  while (index < lines.length) {
    while (index < lines.length && !(lines[index] ?? "").trim()) index++;
    if (index >= lines.length) break;
    const blockLine = index + 1;
    const first = lines[index] ?? "";
    if (/^(?:NOTE(?:[ \t].*)?|STYLE[ \t]*|REGION[ \t]*)$/.test(first)) {
      index++;
      while (index < lines.length && (lines[index] ?? "").trim()) index++;
      continue;
    }

    let id: string | null = null;
    let timing = first;
    if (!timing.includes("-->")) {
      id = timing;
      index++;
      timing = lines[index] ?? "";
    }
    const match = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+.*)?$/.exec(timing);
    if (!match) invalidBlock(blockLine);
    const start = match[1] ?? "";
    const end = match[2] ?? "";
    const startSeconds = timestampSeconds(start);
    const endSeconds = timestampSeconds(end);
    if (startSeconds === null || endSeconds === null || endSeconds < startSeconds) invalidBlock(blockLine);
    index++;
    const payload: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim()) {
      // 区切りの空行が欠けた次のcueを、発言本文に混ぜて成功させない。
      if ((lines[index] ?? "").includes("-->")) invalidBlock(index + 1);
      payload.push(lines[index] ?? "");
      index++;
    }
    const text = payload.join("\n");
    if (!text.trim()) invalidBlock(blockLine);
    cues.push({ id, start, end, text });
  }

  if (cues.length === 0) throw new VttParseError("empty", "VTTファイルに発言がありません。");
  const markdown = cues
    .map((cue) => `[${timestampPrefix(cue.start)}] ${cueTextMarkdown(cue.text)}`)
    .join("\n\n");
  if (!markdown.trim()) throw new VttParseError("empty", "VTTファイルに発言がありません。");
  return { cues, markdown: `${markdown}\n` };
}
