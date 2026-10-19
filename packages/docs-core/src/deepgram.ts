import { formatTimestamp } from "./transcript.js";
import type { GlossaryEntry, Language, SpeakerMode } from "./types.js";

/**
 * Deepgram の文字起こし（API キー方式だけ。spec §5.5）の、固有名詞の渡し方と返りの読み取り。NIHO 本体（apps/api の ops の
 * Deepgram の文字起こし）の写し: keyterm は表記（正しい表記）だけを 500 トークンまで（誤りやすい表記は誤りを教えるので渡さない）、
 * 返りは utterances を話者ごとのまとまりにし（行頭の句読点を直前へ戻す → 相づちを次の発話の後ろへ畳む → 同じ話者を 1 段落に）、
 * 日本語は語の間の空白を詰め、分かち書きされた英字を 1 語にして固有名詞の表記へ直す。
 *
 * NIHO 本体との違い: 段落の頭に時刻を付ける（`[hh:mm:ss] 話者N: 本文`。この Mac・Gemini と同じ形）。時刻はその段落の最初の発話の
 * 始まり（複数の音声は前の音声の長さだけずらす）。話者の番号は Deepgram の番号のまま（音声ごとに 0 から）。
 * リクエストの組み立て（nova-3・言語・話者分離・utterances・smart_format など）は Rust（apps/docs/crates/api-ai）が持つ。
 */

/** Deepgram の keyterm の合計の上限（トークン。NIHO と同じ 500）。 */
export const DEEPGRAM_KEYTERM_TOKEN_BUDGET = 500;

/** 1 語の見積もり（UTF-8 のバイト数。トークン数より多めに数え、上限を超えにくくする。NIHO と同じ）。 */
function keytermCost(term: string): number {
  let bytes = 0;
  for (const char of term) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Deepgram に渡す keyterm（固有名詞の表記だけ。重なりを除き、上限を超えたら打ち切る。並びは渡した順＝案件 → 共通）。 */
export function deepgramKeyterms(terms: readonly GlossaryEntry[]): string[] {
  const keyterms: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const entry of terms) {
    const term = entry.term.trim();
    if (!term || seen.has(term)) continue;
    const cost = keytermCost(term);
    if (used + cost > DEEPGRAM_KEYTERM_TOKEN_BUDGET) break;
    seen.add(term);
    used += cost;
    keyterms.push(term);
  }
  return keyterms;
}

/** Rust が返す Deepgram の結果（音声 1 つ）。 */
export type DeepgramUtterance = { start: number; end: number; speaker: number | null; transcript: string };
export type DeepgramFileResult = {
  /** Deepgram が返した音声の長さ（秒）。 */
  durationSec: number | null;
  utterances: DeepgramUtterance[];
  /** utterances が無いときの全文（channels[0].alternatives[0].transcript）。 */
  transcript: string;
};

type Utterance = { start: number; speaker: number | null; text: string };

const BACKCHANNEL_MAX_JA_CHARS = 6;
const BACKCHANNEL_MAX_EN_WORDS = 3;
const LEADING_PUNCTUATION = /^[、。！？」』）,.!?][\s、。！？」』）,.!?]*/u;
const LATIN_RUN = /(?<![A-Za-z0-9])[A-Za-z]+(?: [A-Za-z]+)+(?![A-Za-z0-9])/gu;
const LATIN_WORD = /(?<![A-Za-z0-9])[A-Za-z]+(?![A-Za-z0-9])/gu;
const LATIN_ONLY = /^[A-Za-z]+$/u;
const ENGLISH_SINGLE_LETTER_WORDS: ReadonlySet<string> = new Set(["i", "a"]);

function isShortBackchannel(text: string, language: Language): boolean {
  const plain = text.replace(/[\s\p{P}]+/gu, " ").trim();
  if (!plain) return false;
  if (language === "en") return plain.split(" ").length <= BACKCHANNEL_MAX_EN_WORDS;
  return Array.from(plain.replace(/ /gu, "")).length <= BACKCHANNEL_MAX_JA_CHARS;
}

/** 行頭の句読点を直前の発話の末尾へ移す（記号だけの発話は落とす）。 */
function moveLeadingPunctuation(utterances: Utterance[]): Utterance[] {
  const moved: Utterance[] = [];
  for (const utterance of utterances) {
    let text = utterance.text;
    const previous = moved[moved.length - 1];
    const match = previous ? LEADING_PUNCTUATION.exec(text) : null;
    if (previous && match) {
      previous.text = `${previous.text.trimEnd()}${match[0].replace(/\s+/gu, "")}`;
      text = text.slice(match[0].length).trimStart();
    }
    if (!text) continue;
    moved.push({ ...utterance, text });
  }
  return moved;
}

/** 話者 A の発話に挟まれた別の話者の短い発話（相づち）を、次の A の発話の後ろへ移す。 */
function foldBackchannels(utterances: Utterance[], language: Language): Utterance[] {
  const folded = [...utterances];
  for (let index = 1; index < folded.length - 1; index++) {
    const previous = folded[index - 1]!;
    const current = folded[index]!;
    const next = folded[index + 1]!;
    if (previous.speaker === null || current.speaker === null || next.speaker === null) continue;
    if (previous.speaker !== next.speaker || current.speaker === previous.speaker) continue;
    if (!isShortBackchannel(current.text, language)) continue;
    folded[index] = next;
    folded[index + 1] = current;
    index++;
  }
  return folded;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/\s*\n+\s*/gu, " ").replace(/[ \t]{2,}/gu, " ").trim();
}

function normalizeJapanese(value: string): string {
  const jp = "[\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Han}ー々〆ヵヶ]";
  const punct = "[、。！？「」『』（）［］【】｛｝〈〉《》・：；]";
  const between = new RegExp(`(${jp})\\s+(${jp})`, "gu");
  const before = new RegExp(`(${jp})\\s+(${punct})`, "gu");
  const after = new RegExp(`(${punct})\\s+(${jp})`, "gu");
  let normalized = normalizeWhitespace(value);
  let previous = "";
  while (previous !== normalized) {
    previous = normalized;
    normalized = normalized.replace(between, "$1$2").replace(before, "$1$2").replace(after, "$1$2");
  }
  return normalized;
}

/** 分かち書きされた英字（「h u h」）を 1 語にし、固有名詞の表記（英字だけの語）に大文字小文字を合わせる。 */
function joinSpelledOutLatin(text: string, canonicals: readonly string[]): string {
  const joined = text.replace(LATIN_RUN, (run) => {
    const tokens = run.split(" ");
    const singles = tokens.filter((token) => token.length === 1);
    const spelledOut = singles.length >= 2 || singles.some((token) => !ENGLISH_SINGLE_LETTER_WORDS.has(token.toLowerCase()));
    return spelledOut ? tokens.join("") : run;
  });
  const byLower = new Map<string, string>();
  for (const canonical of canonicals) {
    const term = canonical.trim();
    if (LATIN_ONLY.test(term) && !byLower.has(term.toLowerCase())) byLower.set(term.toLowerCase(), term);
  }
  if (byLower.size === 0) return joined;
  return joined.replace(LATIN_WORD, (word) => byLower.get(word.toLowerCase()) ?? word);
}

function normalizeText(value: string, language: Language, canonicals: readonly string[]): string {
  if (language !== "ja") return normalizeWhitespace(value);
  return joinSpelledOutLatin(normalizeJapanese(value), canonicals);
}

export type DeepgramTranscriptOptions = {
  language: Language;
  speakers: SpeakerMode;
  /** 固有名詞（表記を英字の語の直しに使う）。 */
  terms: readonly GlossaryEntry[];
};

/** 音声 1 つの段落（時刻は音声の先頭からの秒）。 */
function fileParagraphs(result: DeepgramFileResult, options: DeepgramTranscriptOptions): Array<{ start: number; speaker: number | null; text: string }> {
  const canonicals = options.terms.map((entry) => entry.term);
  const parsed: Utterance[] = result.utterances
    .map((utterance) => ({
      start: Number.isFinite(utterance.start) ? Math.max(0, utterance.start) : 0,
      speaker: options.speakers === "none" ? null : utterance.speaker,
      text: utterance.transcript.trim(),
    }))
    .filter((utterance) => utterance.text.length > 0);
  if (parsed.length === 0) {
    const text = normalizeText(result.transcript, options.language, canonicals);
    return text ? [{ start: 0, speaker: null, text }] : [];
  }
  const arranged = foldBackchannels(moveLeadingPunctuation(parsed), options.language);
  const blocks: Array<{ start: number; speaker: number | null; texts: string[] }> = [];
  for (const utterance of arranged) {
    const last = blocks[blocks.length - 1];
    if (last && last.speaker === utterance.speaker) last.texts.push(utterance.text);
    else blocks.push({ start: utterance.start, speaker: utterance.speaker, texts: [utterance.text] });
  }
  return blocks
    .map((block) => ({ start: block.start, speaker: block.speaker, text: normalizeText(block.texts.join(" "), options.language, canonicals) }))
    .filter((block) => block.text.length > 0);
}

/**
 * Deepgram の結果（音声ごと・前の音声の長さだけずらす秒）→ `[hh:mm:ss] 話者N: 本文` の段落を空行で分けた Markdown
 * （段落が無ければ空文字）。時刻は前の段落より戻さない。
 */
export function deepgramTranscriptMarkdown(
  files: ReadonlyArray<{ result: DeepgramFileResult; offsetSec: number }>,
  options: DeepgramTranscriptOptions,
): string {
  const lines: string[] = [];
  let last = 0;
  for (const file of files) {
    for (const paragraph of fileParagraphs(file.result, options)) {
      last = Math.max(last, file.offsetSec + paragraph.start);
      lines.push(`[${formatTimestamp(last)}] ${paragraph.speaker === null ? "" : `話者${paragraph.speaker}: `}${paragraph.text}`);
    }
  }
  return lines.length > 0 ? `${lines.join("\n\n")}\n` : "";
}
