/**
 * @niho/docs-core — NIHO docs の純粋な中核（specs/initiatives/niho-docs.md）。
 * 型・検証・入力の規則・プロンプトの組み立て・続きの結合・文字起こしの整形・実行計画・テンプレート・API キー方式の単価表・
 * 案件のページ（文書・録音）・「あなたについて」。
 * Tauri・Node・DOM の API に依存しない（tsconfig.json の lib と types で守る）。
 */

export * from "./types.js";
export * from "./runs.js";
export * from "./rules.js";
export * from "./text.js";
export * from "./about.js";
export * from "./execution-preferences.js";
export * from "./glossary.js";
export * from "./entities.js";
export * from "./inputs.js";
export * from "./prompt.js";
export * from "./continuation.js";
export * from "./plan.js";
export * from "./validate.js";
export * from "./shape.js";
export * from "./transcript.js";
export * from "./transcript-speakers.js";
export * from "./audio-transcription.js";
export * from "./deepgram.js";
export * from "./pricing.js";
export * from "./turn.js";
export * from "./conversation.js";
export * from "./composer.js";
export * from "./diff.js";
export * from "./profiles.js";
export * from "./templates.js";
export * from "./flow-edit.js";
export * from "./flow-choices.js";
export * from "./run-words.js";
export * from "./next-steps.js";
export * from "./recording-fields.js";
export * from "./guide-extraction.js";
export * from "./pages.js";
export * from "./candidates.js";
export * from "./speech-result.js";
export * from "./auto-version.js";
export * from "./page-sharing.js";
