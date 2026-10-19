import { termKey } from "./text.js";
import type { GlossaryEntry } from "./types.js";

/** 誤りやすい表記を 1 つの欄で書くときの区切り（「・」「、」「,」）。 */
const VARIANT_SEPARATOR = /[・、,，]/;

export function emptyGlossaryEntry(): GlossaryEntry {
  return { term: "", reading: "", variants: [], note: "" };
}

/** 「NIHO 鎌倉・ニホ鎌倉」のような 1 欄の文字列を誤りやすい表記の並びにする。 */
export function parseVariants(text: string): string[] {
  return text
    .split(VARIANT_SEPARATOR)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function formatVariants(variants: readonly string[]): string {
  return variants.join("・");
}

/** 表記が空の行を除き、前後の空白を落とす。 */
export function cleanGlossary(entries: readonly GlossaryEntry[]): GlossaryEntry[] {
  return entries
    .map((entry) => ({
      term: entry.term.trim(),
      reading: entry.reading.trim(),
      variants: entry.variants.map((variant) => variant.trim()).filter((variant) => variant.length > 0),
      note: entry.note.trim(),
    }))
    .filter((entry) => entry.term.length > 0);
}

/**
 * 案件情報（案件ごと）と文書ガイド（共通）の固有名詞を合わせる。実行時は両方を渡す。
 * 同じ語（NFKC・小文字化・空白除去で一致）は案件情報の行を残す。並びは案件情報 → 共通。
 */
export function mergeGlossaries(
  projectTerms: readonly GlossaryEntry[],
  flowTerms: readonly GlossaryEntry[],
): GlossaryEntry[] {
  const seen = new Set<string>();
  const merged: GlossaryEntry[] = [];
  for (const entry of [...cleanGlossary(projectTerms), ...cleanGlossary(flowTerms)]) {
    const key = termKey(entry.term);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

function tableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/** 固有名詞の 4 列を Markdown の表にする（行が無ければ空文字）。 */
export function glossaryTable(entries: readonly GlossaryEntry[]): string {
  if (entries.length === 0) return "";
  const rows = entries.map(
    (entry) =>
      `| ${tableCell(entry.term)} | ${tableCell(entry.reading)} | ${tableCell(formatVariants(entry.variants))} | ${tableCell(entry.note)} |`,
  );
  return ["| 表記 | よみ | 誤りやすい表記 | 補足 |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

/**
 * 文字起こしの語彙ヒント（sidecar の hints.json の形。spec §6.2）。sidecar は reading・variants を認識に使わない
 * （誤りやすい表記へ寄せてしまう）ので `term` だけを渡す。固有名詞は文字起こし修正の工程で直す。
 */
export type SpeechHint = { term: string };

export function speechHints(entries: readonly GlossaryEntry[]): SpeechHint[] {
  return cleanGlossary(entries).map((entry) => ({ term: entry.term }));
}
