import type { Flow, Language, ProjectSource, SpeakerMode } from "./types.js";

/** 工程 1（文字起こし／文章）の id。工程 1 は固定で `Flow.steps` に含めない。 */
export const SOURCE_STEP_ID = "source";

/** 古い工程設計は先頭の文字起こしが固定だったため、欄の欠落を true として読む。 */
export function flowHasTranscription(flow: Pick<Flow, "transcription">): boolean {
  return flow.transcription !== false;
}

/**
 * 工程 1 の名前（音声のある案件は「文字起こし」、文章から作った案件は「文章」）。素材の種類が分からないとき（素材を持たない
 * 以前の行など）は「文字起こし」。
 */
export function sourceStepName(source: ProjectSource | Pick<ProjectSource, "kind"> | null | undefined): string {
  return source?.kind === "text" && !("transcriptImport" in source && source.transcriptImport) ? "文章" : "文字起こし";
}

/** 素材と工程設計が一致しない理由。画面と実行 host が同じ理由で開始前に止める。 */
export function flowSourceIssue(
  flow: Pick<Flow, "transcription">,
  source: ProjectSource,
  sourceReady: boolean,
): string | null {
  if (flowHasTranscription(flow)) {
    return source.kind === "text" && source.transcriptImport
      ? "この工程は音声から文字起こしを始めます。文字起こしファイルには、文字起こしなしの工程を選んでください。"
      : null;
  }
  if (source.kind !== "text" || !source.transcriptImport || !sourceReady) {
    return "この工程は文字起こしファイルから始めます。VTTファイルを取り込んでください。";
  }
  return null;
}

/** 工程 1 として使えない名前（工程 2 以降と成果物のファイル名がぶつかる）。 */
export const RESERVED_STEP_NAMES: readonly string[] = ["文字起こし", "文章"];

export type InputRef =
  | { kind: "source"; name: string }
  | { kind: "artifact"; stepId: string; name: string }
  | { kind: "refs" }
  | { kind: "info" }
  | { kind: "guide" };

/** 自動参考ページ 1 枚（同じフォルダの独立文書。`title` は画面の名前〔空なら「無題」〕・`body` は本文の Markdown）。 */
export type PromptRef = { pageId: string; title: string; body: string };

/** 入力に入れる参考ページ（付けた順。本文が空の文書は入れない）。 */
export function usedRefs(refs: readonly PromptRef[] | undefined): PromptRef[] {
  return (refs ?? []).filter((ref) => ref.body.trim().length > 0);
}

/**
 * 入力の規則（spec §5.1）: 工程 N（N ≥ 2）の入力 ＝ 文字起こし（または文章）＋ 工程 2〜N−1 の成果物（最新版）
 * ＋ 参考ページ（同じフォルダから自動で固定した独立文書。無ければ何も足さない）＋ 案件情報 ＋ 文書ガイド。
 * `stepIndex` は `flow.steps` の添字（工程 2 が 0）。
 */
export function inputsFor(flow: Flow, stepIndex: number, sourceName = "文字起こし"): InputRef[] {
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= flow.steps.length) {
    throw new RangeError(`stepIndex out of range: ${stepIndex}`);
  }
  return [
    { kind: "source", name: sourceName },
    ...flow.steps.slice(0, stepIndex).map((step) => ({ kind: "artifact" as const, stepId: step.id, name: step.name })),
    { kind: "refs" },
    { kind: "info" },
    { kind: "guide" },
  ];
}

const SPEAKER_LABELS: Record<SpeakerMode, string> = {
  auto: "自動",
  none: "1人",
  "2": "2人",
  "3": "3人",
  "4plus": "4人以上",
};

const LANGUAGE_LABELS: Record<Language, string> = {
  ja: "日本語",
  en: "英語",
};

/** 「話者人数」の選択肢の並び（none は 1 人＝話者のラベルを付けない）。 */
export const SPEAKER_MODES: readonly SpeakerMode[] = ["auto", "none", "2", "3", "4plus"];
export const LANGUAGES: readonly Language[] = ["ja", "en"];

export function isSpeakerMode(value: unknown): value is SpeakerMode {
  return typeof value === "string" && (SPEAKER_MODES as readonly string[]).includes(value);
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

export function speakerLabel(mode: SpeakerMode): string {
  return SPEAKER_LABELS[mode];
}

export function languageLabel(language: Language): string {
  return LANGUAGE_LABELS[language];
}
