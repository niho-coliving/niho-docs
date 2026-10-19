import { aboutSection, type About } from "./about.js";
import { glossaryTable, mergeGlossaries } from "./glossary.js";
import { projectEntitiesMarkdown } from "./entities.js";
import { inputsFor, languageLabel, speakerLabel, usedRefs, type InputRef, type PromptRef } from "./inputs.js";
import { UNTITLED_DOC } from "./pages.js";
import { FIXED_RULES, LEGACY_INFO_ALIAS_RULE, needsLegacyInfoAlias } from "./rules.js";
import { countChars } from "./text.js";
import { sourceForPrompt } from "./transcript-speakers.js";
import type { Flow, RecordingInfo } from "./types.js";

/** 工程の実行に渡す資料。成果物は工程 id → 最新版の Markdown。 */
export type PromptMaterials = {
  /** 工程 1 の名前（「文字起こし」か「文章」）。 */
  sourceName: string;
  /** 工程 1 の成果物（文字起こし、または貼り付けた文章）。 */
  source: string;
  /** source の版に保存された話者名対応。AIへ渡す本文から対応済みラベルも外す。 */
  transcriptSpeakerNames?: Readonly<Record<string, string>>;
  artifacts: Readonly<Record<string, string | undefined>>;
  /** 参考ページ（録音のページで選んだ文書。付けた順。本文が空の文書は入力に入れない）。 */
  refs: readonly PromptRef[];
  /** 背景情報（録音の話者人数・言語 ＋ フォルダの登場人物・固有名詞・背景）。 */
  info: RecordingInfo;
  /** 「あなたについて」（アプリ全体の本人の説明。空なら節を入れない。無ければ付けない）。 */
  about?: About;
  /** 複数案を共通素材から生成するときの、その案だけの追加指示。 */
  candidateInstruction?: string;
};

export type BuiltPrompt = {
  systemPrompt: string;
  userPrompt: string;
  /** 送る量（システム側とユーザー側の字数の合計）。会話の「▶ 実行」の行に添える。 */
  chars: number;
  /** 規則の入力のうち中身の無いもの（まだ作っていない工程など）。空でなければ実行しない。 */
  missing: InputRef[];
};

function section(heading: string, body: string): string {
  return `${heading}\n\n${body.trim()}`;
}

/**
 * 背景情報の本文（録音の話者・言語、フォルダの登場人物・固有名詞の 4 列・背景）。固有名詞は背景情報と文書ガイドの共通の語を
 * 合わせる。空の項目は書かない。節の名前は画面の「背景情報」に合わせる（owner 2026-10-17・#18380。旧「## 案件情報」）。中の自由記述は
 * 節の名前と重ならないよう「### 背景・目的」にする（画面では背景情報のダイアログの「背景情報」の欄）。
 */
export function projectInfoMarkdown(info: RecordingInfo, flowTerms: Flow["terms"]): string {
  const parts = [`- 話者: ${speakerLabel(info.speakers)}\n- 言語: ${languageLabel(info.language)}`];
  const entities = projectEntitiesMarkdown(info.entities);
  if (entities) parts.push(section("### 登場人物", entities));
  const table = glossaryTable(mergeGlossaries(info.terms, flowTerms));
  if (table) parts.push(section("### 固有名詞", table));
  if (info.background.trim()) parts.push(section("### 背景・目的", info.background));
  return parts.join("\n\n");
}

/**
 * システム側: アプリの固定の決まり ＋（あれば）「## あなたについて」＋「## 文書ガイド」＋ ガイド ＋「## この工程」＋ 指示文（spec §5.2）。
 * 「あなたについて」は固定の決まりの直後・文書ガイドの前。両方空なら節ごと入れない。
 */
export function buildSystemPrompt(flow: Flow, stepIndex: number, about?: About, candidateInstruction?: string): string {
  const step = flow.steps[stepIndex];
  if (!step) throw new RangeError(`stepIndex out of range: ${stepIndex}`);
  const parts = [FIXED_RULES];
  if (needsLegacyInfoAlias(flow.guide, step.instruction, candidateInstruction ?? "")) parts.push(LEGACY_INFO_ALIAS_RULE);
  const aboutText = about ? aboutSection(about) : "";
  if (aboutText) parts.push(aboutText);
  if (flow.guide.trim()) parts.push(section("## 文書ガイド", flow.guide));
  parts.push(section("## この工程", step.instruction));
  if (candidateInstruction?.trim()) parts.push(section("## この案の追加指示", candidateInstruction));
  return parts.join("\n\n");
}

/** 参考ページの節（ページごとに「### 〈タイトル〉」＋ 本文。本文が空の文書は入れない。無ければ空文字）。 */
function refsSection(refs: readonly PromptRef[]): string {
  const used = usedRefs(refs);
  if (used.length === 0) return "";
  return section("## 参考ページ", used.map((ref) => section(`### ${ref.title.trim() || UNTITLED_DOC}`, ref.body)).join("\n\n"));
}

/**
 * 工程 N の指示を組み立てる（spec §5.2）。
 * ユーザー側: 「## 文字起こし」＋ 本文 ＋ 工程ごとに「## 〈工程名〉」＋ 本文 ＋（参考があれば）「## 参考ページ」＋ ページごとに
 * 「### 〈タイトル〉」＋ 本文 ＋「## 背景情報」。参考は missing に数えない。
 */
export function buildPrompt(flow: Flow, stepIndex: number, materials: PromptMaterials): BuiltPrompt {
  const inputs = inputsFor(flow, stepIndex, materials.sourceName);
  const source = sourceForPrompt(materials.sourceName, materials.source, materials.transcriptSpeakerNames);
  const missing: InputRef[] = [];
  const userParts: string[] = [];
  for (const input of inputs) {
    if (input.kind === "source") {
      if (!source.trim()) missing.push(input);
      userParts.push(section(`## ${input.name}`, source));
    } else if (input.kind === "artifact") {
      const body = materials.artifacts[input.stepId] ?? "";
      if (!body.trim()) missing.push(input);
      userParts.push(section(`## ${input.name}`, body));
    } else if (input.kind === "refs") {
      const refs = refsSection(materials.refs);
      if (refs) userParts.push(refs);
    } else if (input.kind === "info") {
      userParts.push(section("## 背景情報", projectInfoMarkdown(materials.info, flow.terms)));
    }
  }
  const systemPrompt = buildSystemPrompt(flow, stepIndex, materials.about, materials.candidateInstruction);
  const userPrompt = userParts.join("\n\n");
  return {
    systemPrompt,
    userPrompt,
    chars: countChars(systemPrompt) + countChars(userPrompt),
    missing,
  };
}
