/** 文字起こし本文の話者ラベル。Tauri・React に依存しない版単位の変換契約。 */

export const TRANSCRIPT_SPEAKER_NAME_MAX_CHARS = 60;

export function formatTranscriptSpeakerDefaultLabel(index: number): string {
  return `話者${index}`;
}

export function formatTranscriptSpeakerKey(partIndex: number | null, index: number): string {
  return partIndex === null ? String(index) : `${partIndex}:${index}`;
}

export function parseTranscriptSpeakerKey(key: string): { partIndex: number | null; index: number } | null {
  const match = /^(\d+)(?::(\d+))?$/u.exec(key);
  if (!match) return null;
  return match[2] === undefined
    ? { partIndex: null, index: Number(match[1]) }
    : { partIndex: Number(match[1]), index: Number(match[2]) };
}

export type TranscriptSpeakerEntry = {
  partIndex: number | null;
  index: number;
  key: string;
  name: string | null;
  label: string;
};

type LabelLine = {
  start: number;
  end: number;
  partIndex: number | null;
  timestamp: string;
  label: string;
};

const PART_HEADING = /^## Part (\d+):[^\r\n]*$/u;
const LABEL = /^(\[\d{2,}:\d{2}:\d{2}\] )?([^:\r\n]+):/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const MARKDOWN_PUNCTUATION = /[!"#$%&'()*+,\-./;<=>?@[\\\]^_`{|}~]/gu;

type FenceState = { marker: "`" | "~"; length: number };

function fenceStart(content: string): FenceState | null {
  const match = FENCE.exec(content);
  if (!match) return null;
  const run = match[1] ?? "";
  const marker = run[0] as "`" | "~";
  // CommonMark: backtick fence の info string に backtick は置けない。
  if (marker === "`" && (match[2] ?? "").includes("`")) return null;
  return { marker, length: run.length };
}

function closesFence(content: string, fence: FenceState): boolean {
  const match = FENCE.exec(content);
  if (!match) return false;
  const run = match[1] ?? "";
  return run[0] === fence.marker && run.length >= fence.length && /^[ \t]*$/u.test(match[2] ?? "");
}

function hasUnescapedBacktick(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "`") continue;
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) return true;
  }
  return false;
}

function decodeMarkdownLabel(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, "$1");
}

function encodeMarkdownLabel(value: string): string {
  return value.replace(MARKDOWN_PUNCTUATION, "\\$&");
}

/**
 * 空行で始まる段落の先頭だけを走査する。fenced code と、バッククォートで囲まれたラベルは対象にしない。
 * 改行を含む元本文の位置を返すため、置換しても時刻・空白・改行はそのまま残る。
 */
function scanTranscript(markdown: string): { labels: LabelLine[]; hasParts: boolean } {
  const found: LabelLine[] = [];
  let offset = 0;
  let paragraphStart = true;
  let fence: FenceState | null = null;
  let partIndex: number | null = null;
  let hasParts = false;
  for (const raw of markdown.match(/[^\n]*(?:\n|$)/gu) ?? []) {
    if (!raw) continue;
    const line = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const content = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (fence !== null) {
      if (closesFence(content, fence)) fence = null;
      paragraphStart = false;
      offset += raw.length;
      continue;
    }
    const openingFence = fenceStart(content);
    if (openingFence) {
      fence = openingFence;
      paragraphStart = false;
      offset += raw.length;
      continue;
    }
    if (/^\s*$/u.test(content)) {
      paragraphStart = true;
      offset += raw.length;
      continue;
    }
    const part = PART_HEADING.exec(content);
    if (part) {
      partIndex = Number(part[1]);
      hasParts = true;
      paragraphStart = true;
      offset += raw.length;
      continue;
    }
    if (paragraphStart) {
      const match = LABEL.exec(content);
      if (match) {
        const timestamp = match[1] ?? "";
        const sourceLabel = (match[2] ?? "").trim();
        const label = decodeMarkdownLabel(sourceLabel);
        // inline code の中の疑似ラベルは対象にしない。命名で入れた backtick は `\`` として区別する。
        if (label && sourceLabel === match[2] && !hasUnescapedBacktick(sourceLabel)) {
          found.push({ start: offset, end: offset + match[0].length, partIndex, timestamp, label });
        }
      }
    }
    paragraphStart = false;
    offset += raw.length;
  }
  return { labels: found, hasParts };
}

function labelLines(markdown: string): LabelLine[] {
  return scanTranscript(markdown).labels;
}

function isGeneratedSpeakerLabel(line: LabelLine): boolean {
  // 時刻は通常の発話にも付くため、話者の既定ラベルだけを生成ラベルとみなす。
  return /^話者(?:\d+|[?？])$/u.test(line.label);
}

function isNamedSpeakerLabel(line: LabelLine, names: Readonly<Record<string, string>>): boolean {
  return Object.entries(names).some(([key, name]) => {
    const speaker = parseTranscriptSpeakerKey(key);
    return speaker?.partIndex === line.partIndex && name.trim() === line.label;
  });
}

/**
 * 段落先頭の生成話者ラベルだけを外す。時刻・本文・見出し・改行・code fence 内は元の bytes を保つ。
 * 任意の時刻付き段落や利用者が付けた名前は発話本文の一部として保持する。
 */
export function stripTranscriptSpeakerLabels(markdown: string, names: Readonly<Record<string, string>> = {}): string {
  const changes = labelLines(markdown).filter((line) => isGeneratedSpeakerLabel(line) || isNamedSpeakerLabel(line, names));
  if (changes.length === 0) return markdown;
  let next = markdown;
  for (const line of changes.reverse()) {
    // `ラベル: 本文` の区切りの空白を 1 つだけ一緒に外す。timestamp 自体の末尾空白は残る。
    const end = next[line.end] === " " ? line.end + 1 : line.end;
    next = `${next.slice(0, line.start)}${line.timestamp}${next.slice(end)}`;
  }
  return next;
}

/** 文字起こしだけを安全な後続入力へ変換する。文章などほかの source kind は一切変えない。 */
export function sourceForPrompt(sourceName: string, source: string, names: Readonly<Record<string, string>> = {}): string {
  return sourceName === "文字起こし" ? stripTranscriptSpeakerLabels(source, names) : source;
}

export function hasTranscriptParts(markdown: string): boolean {
  return scanTranscript(markdown).hasParts;
}

/** 保存済み対応のうち、現在の文字起こしに実際にある名前だけを残す。 */
export function retainTranscriptSpeakerNames(markdown: string, names: Readonly<Record<string, string>>): Record<string, string> {
  const labels = labelLines(markdown);
  return Object.fromEntries(Object.entries(names).filter(([key, name]) => {
    const speaker = parseTranscriptSpeakerKey(key);
    return speaker && labels.some((line) => line.partIndex === speaker.partIndex && line.label === name);
  }));
}

/** 本文に現れる番号ラベルと、この版に保存された名前対応の和集合。 */
export function listTranscriptSpeakers(
  markdown: string,
  names: Readonly<Record<string, string>> = {},
): TranscriptSpeakerEntry[] {
  const found = new Map<string, { partIndex: number | null; index: number }>();
  for (const line of labelLines(markdown)) {
    const match = /^話者(\d+)$/u.exec(line.label);
    if (!match) continue;
    const index = Number(match[1]);
    found.set(formatTranscriptSpeakerKey(line.partIndex, index), { partIndex: line.partIndex, index });
  }
  for (const [key, value] of Object.entries(names)) {
    const parsed = parseTranscriptSpeakerKey(key);
    if (parsed && value.trim()) found.set(formatTranscriptSpeakerKey(parsed.partIndex, parsed.index), parsed);
  }
  return [...found.values()]
    .sort((left, right) => (left.partIndex ?? -1) - (right.partIndex ?? -1) || left.index - right.index)
    .map(({ partIndex, index }) => {
      const key = formatTranscriptSpeakerKey(partIndex, index);
      const name = names[key]?.trim() || null;
      return { partIndex, index, key, name, label: name ?? formatTranscriptSpeakerDefaultLabel(index) };
    });
}

/** 同じ Part の、段落先頭にある完全一致のラベルだけを置き換える。 */
export function renameTranscriptSpeakerLabel(
  markdown: string,
  fromLabel: string,
  toLabel: string,
  partIndex: number | null = null,
): string {
  if (!fromLabel || fromLabel === toLabel) return markdown;
  const changes = labelLines(markdown).filter((line) => line.partIndex === partIndex && line.label === fromLabel);
  if (changes.length === 0) return markdown;
  let next = markdown;
  for (const line of changes.reverse()) {
    next = `${next.slice(0, line.start)}${line.timestamp}${encodeMarkdownLabel(toLabel)}:${next.slice(line.end)}`;
  }
  return next;
}

/** 候補と自由入力で共通の名前検証。 */
export function resolveTranscriptSpeakerName(input: {
  name: string;
  speaker: Pick<TranscriptSpeakerEntry, "partIndex" | "key">;
  speakers: ReadonlyArray<TranscriptSpeakerEntry>;
}): string | null {
  const name = input.name.trim();
  if (!name || Array.from(name).length > TRANSCRIPT_SPEAKER_NAME_MAX_CHARS) return null;
  if (/[\r\n:：]/u.test(name) || /^話者[\d?？]*$/u.test(name)) return null;
  const normalized = name.normalize("NFKC");
  const collision = input.speakers.some(
    (other) =>
      other.partIndex === input.speaker.partIndex &&
      other.key !== input.speaker.key &&
      other.label.normalize("NFKC") === normalized,
  );
  return collision ? null : name;
}

/** serde_json 由来を含む古い記録を、画面で安全に使える名前対応へ絞る。 */
export function normalizeTranscriptSpeakerNames(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const names: Record<string, string> = {};
  for (const [key, name] of Object.entries(value)) {
    if (parseTranscriptSpeakerKey(key) && typeof name === "string" && name.trim()) names[key] = name.trim();
  }
  return names;
}
