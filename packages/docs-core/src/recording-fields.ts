import { isLanguage } from "./inputs.js";
import type { Language, SpeakerMode } from "./types.js";

/**
 * 録音の項目（話者人数・言語・参考。#18903・Epic #18882 S3）。Mac の録音のページと Web/PWA の新しい録音で同じ項目名・選択肢・
 * 既定・参考の選び方にするため、規則と文はここだけに置く（正は docs/design/design-guide-docs.md §1.1）。選択肢の並びと名前は
 * `SPEAKER_MODES`・`speakerLabel`・`LANGUAGES`・`languageLabel`（inputs.ts）。置き場所と描き方は各アプリ。
 */

/** 項目名（並びもこの順）。 */
export const RECORDING_FIELD_LABELS = { speakers: "話者人数", language: "言語", refs: "参考" } as const;

/** 新しい録音の話者人数の既定。 */
export const DEFAULT_SPEAKER_MODE: SpeakerMode = "auto";

/** 端末の言語が無い・分からないときの言語の既定。 */
export const DEFAULT_RECORDING_LANGUAGE: Language = "ja";

/**
 * 新しい録音の言語の既定は、その端末の文字起こしの言語（Mac は設定の文字起こしの言語、Web はこの端末で前回選んだ言語）。
 * 端末の設定は同期しない（specs/initiatives/niho-docs-cloud.md §2 の 8・owner 2026-10-17）ので、ほかの端末の値は読まない。無ければ日本語。
 */
export function defaultRecordingLanguage(deviceLanguage: unknown): Language {
  return isLanguage(deviceLanguage) ? deviceLanguage : DEFAULT_RECORDING_LANGUAGE;
}

/** 参考の欄の文。 */
export const RECORDING_REF_WORDS = {
  /** まだ付けていない文書を足す押し先の文。 */
  add: "ページ",
  /** その押し先のアクセシブル名。 */
  addLabel: "参考にするページを追加",
  /** 足せる文書の一覧の名前。 */
  menuLabel: "参考にする文書",
  /** 同じ場所に文書のページが 1 つも無いとき。 */
  empty: "文書のページを足すと、参考に選べます",
} as const;

export function recordingRefOpenLabel(title: string): string {
  return `${title}を開く`;
}

export function recordingRefRemoveLabel(title: string): string {
  return `${title}を外す`;
}

/**
 * 参考に選べる文書は、録音と同じ場所（同じフォルダ。フォルダの外の録音はフォルダの外）の文書のページ。`docPages` はその場所の
 * 文書のページを画面の並びで渡す。
 * - chips: 付けたもの（付けた順。もう無いページは出さない）
 * - choices: まだ付けていないもの（`docPages` の並び）
 * - empty: 文書のページが 1 つも無い（{@link RECORDING_REF_WORDS}.empty を出す）
 */
export function recordingRefView<P extends { id: string }>(
  docPages: readonly P[],
  refs: readonly string[],
): { chips: P[]; choices: P[]; empty: boolean } {
  const chips = refs.flatMap((id) => docPages.filter((page) => page.id === id).slice(0, 1));
  const choices = docPages.filter((page) => !refs.includes(page.id));
  return { chips, choices, empty: chips.length === 0 && docPages.length === 0 };
}

/** 参考を足す（付け済みなら変えない。末尾に足す）。 */
export function addRecordingRef(refs: readonly string[], pageId: string): string[] {
  return refs.includes(pageId) ? [...refs] : [...refs, pageId];
}

/** 参考を外す。 */
export function removeRecordingRef(refs: readonly string[], pageId: string): string[] {
  return refs.filter((ref) => ref !== pageId);
}
