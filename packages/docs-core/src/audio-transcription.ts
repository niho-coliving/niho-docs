import { formatTimestamp } from "./transcript.js";
import type { GlossaryEntry, Language, SpeakerMode } from "./types.js";

/**
 * 音声ファイルを AI に渡す文字起こし（Gemini。サブスクリプションは Antigravity CLI に区切りの WAV を `view_file` で読ませ、
 * API キー方式は Gemini API に渡す＝S2b）の、指示の組み立て・返事の読み取り・時刻のずらしと結合（spec §5.5）。
 *
 * 指示文と返事の読み取りは NIHO 本体（apps/api の ops の Gemini の文字起こし）の移植: 正確さ（省略・要約・言い換えをしない）・
 * 言語・形式（`[mm:ss] 話者N: 発言`）・文の整え方（相づちで発言を分断しない）・固有名詞（表記・よみ・誤りやすい表記）・
 * 区切りの位置・直前の区切りの末尾の参照行（話者番号をそろえる）。Antigravity CLI には「シェルを使わず view_file で読む」を
 * 足す（書かないとシェルで調べようとして拒否され、空になる。S0 #18381）。
 *
 * 時刻: 返る `[mm:ss]` は区切りの先頭からの目安なので、区切りの開始秒を足し、区切りの長さで丸める（S0 で区切りの長さを
 * 超える時刻が出た）。複数の音声は、前の音声の長さだけずらした区切りの開始秒を渡す。出力は この Mac の経路と同じ
 * `[hh:mm:ss] 本文` の段落（話者のラベルがあれば `[hh:mm:ss] 話者N: 本文`。番号は録音全体の初出順に 0 から振り直す）。
 * NIHO 本体が後で import できるよう、Tauri・案件の型に依存しない。
 */

export type AudioTranscriptionContext = {
  /** 案件の名前（場面の説明に使う。背景情報の全文は入れない）。 */
  title: string | null;
  language: Language;
  speakers: SpeakerMode;
  /** 固有名詞（案件情報と文書ガイドの共通の語を合わせたもの）。補足の列は修正の工程用なので渡さない。 */
  terms: readonly GlossaryEntry[];
};

export type AudioPartPromptInput = {
  /** 0 始まり（すべての音声を通した区切りの番号）。 */
  index: number;
  count: number;
  speakers: SpeakerMode;
  /** CLI の作業フォルダに置いた区切りのファイル名（Antigravity CLI）。ファイルを添付する API は null。 */
  fileName: string | null;
  /** 直前までの結果の最後の段落（`話者N: 本文`）。話者番号をそろえるための参考で、出力には含めさせない。 */
  referenceLines: readonly string[];
};

/** 参考行を囲む区切り。返答に再掲されたら水平線として捨てる。 */
const REFERENCE_DELIMITER = "---";
/** 次の区切りに渡す直前の段落の数。 */
export const TRANSCRIPTION_REFERENCE_PARAGRAPHS = 6;

function expectedSpeakers(speakers: SpeakerMode): number | null {
  switch (speakers) {
    case "2":
      return 2;
    case "3":
      return 3;
    case "4plus":
      return 4;
    default:
      return null;
  }
}

function speakerCountLine(speakers: SpeakerMode): string {
  const expected = expectedSpeakers(speakers);
  if (expected === null) return "- 話している人数は決まっていません。声の違いで聞き分けてください。";
  return speakers === "4plus" ? `- 話している人は${expected}人以上の想定です。` : `- 話している人は${expected}人の想定です。`;
}

function termLine(entry: GlossaryEntry): string | null {
  const term = entry.term.trim();
  if (!term) return null;
  const reading = entry.reading.trim();
  const variants = entry.variants.map((variant) => variant.trim()).filter(Boolean);
  return `- ${term}${reading ? `（よみ: ${reading}）` : ""}${variants.length > 0 ? `（誤りやすい表記: ${variants.join("・")}）` : ""}`;
}

/** 区切りに依らない指示（システム側）。 */
export function buildAudioTranscriptionSystemPrompt(context: AudioTranscriptionContext): string {
  const title = context.title?.trim();
  const sections: string[] = [
    title
      ? `あなたは録音を正確に書き起こす担当者です。この音声は「${title}」の録音です。`
      : "あなたは録音を正確に書き起こす担当者です。この音声は取材・対話・会議などの録音です。",
  ];
  sections.push(
    [
      "## 正確さ",
      "- 話された内容を省略・要約・言い換えしないでください。",
      "- 話していないことを書き足さないでください。",
      "- 聞き取れない箇所や自信のない語は、推測で埋めずに「［聞き取れず］」と書いてください。",
    ].join("\n"),
  );
  const diarize = context.speakers !== "none";
  sections.push(
    (context.language === "en"
      ? [
          "## 言語",
          "- 英語の音声です。英語のまま、聞こえたとおりに書き起こしてください（日本語に訳さないでください）。",
          ...(diarize ? ["- 話者のラベルは英語の書き起こしでも「話者N」のまま書いてください。"] : []),
        ]
      : ["## 言語", "- 日本語で書き起こしてください。数字は算用数字で、英字の語は通常の綴りで書いてください。"]
    ).join("\n"),
  );
  sections.push(
    (diarize
      ? [
          "## 形式",
          "- 各段落を「[mm:ss] 話者N: 発言」の形で書いてください。",
          "- N は 0 から始まる番号です。同じ人には録音全体を通して同じ番号を使い、名前が分かっても番号で書いてください。",
          "- 時刻はこの音声の先頭を 00:00 とした、その段落の話し始めの時刻です。",
          speakerCountLine(context.speakers),
        ]
      : [
          "## 形式",
          "- 話者のラベルは付けず、各段落を「[mm:ss] 発言」の形で書いてください。",
          "- 時刻はこの音声の先頭を 00:00 とした、その段落の話し始めの時刻です。",
        ]
    ).join("\n"),
  );
  const backchannel = context.language === "en" ? "yeah・uh-huh・right 等" : "うん・はい・へえ・なるほど 等";
  const filler = context.language === "en" ? "「um」「uh」" : "「えー」「あのー」";
  sections.push(
    [
      "## 文の整え方",
      diarize
        ? "- 同じ話者が続けて話す間は1段落にまとめ、話者が替わるときだけ改行してください。"
        : "- 話のまとまりごとに段落を分け、1文ごとに改行しないでください。",
      `- 相づち（${backchannel}）だけの短い反応は独立した行にしないでください（省いてかまいません）。相手の話の途中の相づちで発言を分断しないでください。`,
      `- ${filler}などのフィラーや、意味の変わらない言い直しは省いてかまいません。`,
    ].join("\n"),
  );
  const terms = context.terms.map(termLine).filter((line): line is string => line !== null);
  if (terms.length > 0) {
    sections.push(
      [
        "## 固有名詞",
        "- 次の語は、その語がはっきり聞こえたときだけこの表記で書いてください。聞こえていない箇所に当てはめないでください。",
        "- 「誤りやすい表記」に聞こえたときも、この表記で書いてください。",
        ...terms,
      ].join("\n"),
    );
  }
  sections.push(
    [
      "## 出力",
      "- 最後まで省略せずに書き起こしてください。長い音声でも、後半を縮めたり要約に切り替えたりしないでください。",
      "- 出力は書き起こしの本文だけにしてください。前置き・説明・注釈・コードブロックは付けないでください。",
    ].join("\n"),
  );
  return sections.join("\n\n");
}

/** 区切りごとの指示（ユーザー側）: 読むファイル・区切りの位置・直前の区切りの末尾。 */
export function buildAudioTranscriptionPartPrompt(input: AudioPartPromptInput): string {
  const sections: string[] = [];
  if (input.fileName) {
    sections.push(
      `作業フォルダの音声ファイル「${input.fileName}」を書き起こしてください。シェルやコマンドは使わず、view_file で「${input.fileName}」を直接読み込んでください。`,
    );
  } else {
    sections.push("添付の音声を書き起こしてください。");
  }
  if (input.count > 1) {
    sections.push(
      [
        "## 区切り",
        `- この音声は、録音全体を${input.count}個に区切ったうちの${input.index + 1}番目です。`,
        "- 冒頭や末尾が文の途中で切れていても、そのまま書き起こしてください。",
      ].join("\n"),
    );
  }
  if (input.speakers !== "none" && input.index > 0 && input.referenceLines.length > 0) {
    sections.push(
      [
        "## 直前の区切りの末尾（参考）",
        "- 話者番号をそろえるための参考です。同じ人には同じ番号を使ってください。",
        `- 次の「${REFERENCE_DELIMITER}」で挟んだ部分は出力に含めないでください。`,
        REFERENCE_DELIMITER,
        ...input.referenceLines,
        REFERENCE_DELIMITER,
      ].join("\n"),
    );
  }
  return sections.join("\n\n");
}

/** 1 つの指示にまとめる（指示とファイルを 1 回で送る API 用）。 */
export function buildAudioTranscriptionPrompt(context: AudioTranscriptionContext, part: AudioPartPromptInput): string {
  return `${buildAudioTranscriptionSystemPrompt(context)}\n\n${buildAudioTranscriptionPartPrompt(part)}`;
}

// ---------------------------------------------------------------------------
// 返事の読み取り

/**
 * 返事の 1 段落。`offsetSec` は区切りの先頭からの時刻（書かれていなければ null）、`rawLabel` は返事に書かれた話者の
 * ラベル（`話者A` なら "A"。番号は全角・先頭の 0 を正規化）。
 */
export type AudioTranscriptParagraph = { offsetSec: number | null; rawLabel: string | null; text: string };

const LEADING_BULLET = /^[-*・]\s+/u;
// 行頭の時刻（[mm:ss] / [h:mm:ss] / 範囲 / 全角の括弧。太字の ** も許す）。1 つ目の時刻を取る
const LEADING_TIMESTAMP =
  /^(?:\*\*)?\s*[[［(（]\s*(\d{1,2}(?::\d{1,2}){1,2})(?:[.,]\d+)?(?:\s*[-–~〜]\s*\d{1,2}(?::\d{1,2}){1,2}(?:[.,]\d+)?)?\s*[\]］)）]\s*(?:\*\*)?\s*/u;
// 括弧の無い時刻は、直後に話者のラベルが続くときだけ時刻として外す
const BARE_TIMESTAMP_BEFORE_LABEL = /^(\d{1,2}(?::\d{2}){1,2})(?:[.,]\d+)?\s+(?=(?:\*\*)?\s*話者)/u;
const SPEAKER_LABEL = /^(?:\*\*|__)?\s*話者\s*([0-9０-９]{1,3}|[A-Za-zＡ-Ｚａ-ｚ]{1,2})\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*/u;
const CODE_FENCE = /^(?:```|~~~)/u;
const HEADING = /^#{1,6}\s/u;
const HORIZONTAL_RULE = /^(?:-{3,}|\*{3,}|_{3,})$/u;
const ANNOTATIONS: readonly RegExp[] = [
  /^[※＊]/u,
  /^(?:注|注記|備考|補足|note|notes)\s*[:：]/iu,
  // 行全体が括弧書き（（笑）・（無音）・(Note: …) など）
  /^[（(][^（）()]*[）)]$/u,
  /^(?:以上|上記)(?:が|で|は).{0,30}(?:文字起こし|書き起こし)/u,
  /^(?:文字起こし|書き起こし)(?:は)?以上/u,
  /^end\s+of\s+(?:the\s+)?transcript/iu,
];
// 最初の段落より前にだけ見る前置き（参考の再掲の見出し・説明を含む）
const PREAMBLES: readonly RegExp[] = [
  /^(?:以下|下記|これ|こちら)(?:は|が|に).{0,40}(?:文字起こし|書き起こし|トランスクリプト)/u,
  /^(?:here\s+is|here's|below\s+is|the\s+following\s+is)\b.{0,60}\b(?:transcript|transcription)\b/iu,
  /^(?:文字起こし|書き起こし|transcript|transcription)(?:結果)?\s*[:：]?\s*$/iu,
  /^(?:[-・]\s*)?(?:直前の区切り|話者番号をそろえる)/u,
  /出力に含めないで/u,
  /view_file/u,
];
// 話者を分けるときの前置き（「〜の文字起こし：」のようにコロンで終わる短い行）
const SPEAKER_MODE_PREAMBLE = /^.{1,40}[:：]$/u;

function clockSeconds(clock: string): number {
  const parts = clock.split(":").map((part) => Number(part));
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
}

function normalizeLabel(value: string): string {
  const halfWidth = value.replace(/[０-９Ａ-Ｚａ-ｚ]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  return /^\d+$/u.test(halfWidth) ? String(Number(halfWidth)) : halfWidth.toUpperCase();
}

function joinText(left: string, right: string, language: Language): string {
  if (!left) return right;
  if (!right) return left;
  if (language === "en") return `${left} ${right}`;
  // 日本語は詰めて結合する（英数字どうしが接するときだけ空白を挟む）
  return /[A-Za-z0-9]$/u.test(left) && /^[A-Za-z0-9]/u.test(right) ? `${left} ${right}` : `${left}${right}`;
}

function isDiscarded(line: string): boolean {
  return CODE_FENCE.test(line) || HEADING.test(line) || HORIZONTAL_RULE.test(line) || ANNOTATIONS.some((pattern) => pattern.test(line));
}

function isPreamble(line: string, speakers: SpeakerMode): boolean {
  if (PREAMBLES.some((pattern) => pattern.test(line))) return true;
  return speakers !== "none" && SPEAKER_MODE_PREAMBLE.test(line);
}

/** 参考行・再掲の比較に使う 1 行の形（`話者A: 本文` / `本文`）。 */
export function referenceLine(paragraph: Pick<AudioTranscriptParagraph, "rawLabel" | "text">): string {
  return paragraph.rawLabel === null ? paragraph.text : `話者${paragraph.rawLabel}: ${paragraph.text}`;
}

function echoKey(value: string): string {
  return value.replace(/[:：]/gu, ":").replace(/\s+/gu, "");
}

/**
 * 返事の先頭に参考行がそのまま再掲されていたら取り除く（参考行の末尾側と一致するときだけ）。参考行は時刻を持たないので、時刻の無い
 * 段落の一致は再掲。時刻の付いた段落は、2 行以上続けて一致したときだけ再掲とみなす（区切りの冒頭で直前と同じ話者・本文を実際に
 * 話した 1 行〔続けて「はい」など〕は書き起こしとして残す）。
 */
function stripEchoedReference(paragraphs: AudioTranscriptParagraph[], referenceLines: readonly string[]): AudioTranscriptParagraph[] {
  if (referenceLines.length === 0 || paragraphs.length === 0) return paragraphs;
  const reference = referenceLines.map(echoKey);
  for (let start = 0; start < reference.length; start++) {
    const length = reference.length - start;
    if (length > paragraphs.length) continue;
    let matched = true;
    for (let offset = 0; offset < length; offset++) {
      if (echoKey(referenceLine(paragraphs[offset]!)) !== reference[start + offset]) {
        matched = false;
        break;
      }
    }
    const timed = paragraphs.slice(0, length).some((paragraph) => paragraph.offsetSec !== null);
    if (matched && (!timed || length >= 2)) return paragraphs.slice(length);
  }
  return paragraphs;
}

/**
 * 1 つの区切りの返事を段落に分ける。行頭の時刻を読み（`[mm:ss]`・`[h:mm:ss]`・範囲は始まり）、`話者X:`（全角コロン可）を読む。
 * コードフェンス（囲み）・見出し・水平線・注釈の行と、最初の段落より前の前置きは捨てる。時刻もラベルも無い行は、直前の行に
 * 続く（空行を挟まない）なら同じ段落の続き、そうでなければ時刻の無い段落にする。`話者` 以外のラベル（名前など）は本文のまま
 * 残す。話者を分けない案件（none）ではラベルを外す。最後に、先頭に再掲された参考行を取り除く。
 */
export function parseAudioTranscriptParagraphs(params: {
  text: string;
  speakers: SpeakerMode;
  language: Language;
  referenceLines?: readonly string[];
}): AudioTranscriptParagraph[] {
  const paragraphs: AudioTranscriptParagraph[] = [];
  let current: AudioTranscriptParagraph | null = null;
  let previousBlank = true;
  for (const rawLine of params.text.replace(/\r\n?/gu, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || isDiscarded(trimmed)) {
      previousBlank = true;
      continue;
    }
    const line = trimmed.replace(LEADING_BULLET, "");
    const timestamp = LEADING_TIMESTAMP.exec(line) ?? BARE_TIMESTAMP_BEFORE_LABEL.exec(line);
    const afterTimestamp = timestamp ? line.slice(timestamp[0].length).trim() : line;
    const label = SPEAKER_LABEL.exec(afterTimestamp);
    const offsetSec = timestamp ? clockSeconds(timestamp[1]!) : null;
    if (label) {
      current = {
        offsetSec,
        rawLabel: params.speakers === "none" ? null : normalizeLabel(label[1]!),
        text: afterTimestamp.slice(label[0].length).trim(),
      };
      paragraphs.push(current);
    } else if (timestamp) {
      current = { offsetSec, rawLabel: null, text: afterTimestamp };
      paragraphs.push(current);
    } else if (current && !previousBlank) {
      current.text = joinText(current.text, afterTimestamp, params.language);
    } else if (!current && isPreamble(afterTimestamp, params.speakers)) {
      previousBlank = true;
      continue;
    } else {
      current = { offsetSec: null, rawLabel: null, text: afterTimestamp };
      paragraphs.push(current);
    }
    previousBlank = false;
  }
  const normalized = paragraphs
    .map((paragraph) => ({ ...paragraph, text: paragraph.text.replace(/\s+/gu, " ").trim() }))
    .filter((paragraph) => paragraph.text.length > 0);
  return stripEchoedReference(normalized, params.referenceLines ?? []);
}

/** 次の区切りに渡す参考行（ここまでの段落の末尾）。 */
export function transcriptionReferenceLines(
  paragraphs: readonly AudioTranscriptParagraph[],
  count: number = TRANSCRIPTION_REFERENCE_PARAGRAPHS,
): string[] {
  return paragraphs.slice(-count).map(referenceLine);
}

/** 区切り 1 つの返事（区切りの絶対の範囲・秒）。 */
export type AudioTranscriptPart = {
  text: string;
  startSec: number;
  endSec: number;
  /** その区切りに渡した参考行（返事の先頭の再掲を外す）。 */
  referenceLines?: readonly string[];
};

/** 区切りの段落に、録音全体の時刻（秒）と振り直した話者の番号を付けたもの。 */
export type TimedTranscriptParagraph = { startSec: number; speaker: number | null; text: string };

/**
 * 区切りごとの返事を 1 本の段落の並びにする。時刻は 区切りの開始秒 ＋ 返事の時刻（区切りの長さで丸める）。時刻の無い段落は
 * 直前の段落の時刻（先頭なら区切りの開始秒）。時刻は前の段落より戻さない。話者のラベルは録音全体の初出順に 0 から振り直す
 * （同じラベルは同じ番号。区切りをまたいでも同じ）。
 */
export function timedTranscriptParagraphs(
  parts: readonly AudioTranscriptPart[],
  speakers: SpeakerMode,
  language: Language,
): TimedTranscriptParagraph[] {
  const numbers = new Map<string, number>();
  const timed: TimedTranscriptParagraph[] = [];
  let last = 0;
  for (const part of parts) {
    const length = Math.max(0, part.endSec - part.startSec);
    last = Math.max(last, part.startSec);
    for (const paragraph of parseAudioTranscriptParagraphs({
      text: part.text,
      speakers,
      language,
      ...(part.referenceLines ? { referenceLines: part.referenceLines } : {}),
    })) {
      const at =
        paragraph.offsetSec === null ? last : part.startSec + Math.min(length, Math.max(0, paragraph.offsetSec));
      last = Math.max(last, at);
      let speaker: number | null = null;
      if (paragraph.rawLabel !== null) {
        speaker = numbers.get(paragraph.rawLabel) ?? numbers.size;
        numbers.set(paragraph.rawLabel, speaker);
      }
      timed.push({ startSec: last, speaker, text: paragraph.text });
    }
  }
  return timed;
}

/** 区切りごとの返事 → `[hh:mm:ss] 話者N: 本文` の段落を空行で分けた Markdown（段落が無ければ空文字）。 */
export function audioTranscriptMarkdown(parts: readonly AudioTranscriptPart[], speakers: SpeakerMode, language: Language): string {
  const paragraphs = timedTranscriptParagraphs(parts, speakers, language).map(
    (paragraph) =>
      `[${formatTimestamp(paragraph.startSec)}] ${paragraph.speaker === null ? "" : `話者${paragraph.speaker}: `}${paragraph.text}`,
  );
  return paragraphs.length > 0 ? `${paragraphs.join("\n\n")}\n` : "";
}
