import { cleanGlossary } from "./glossary.js";
import { flowHasTranscription } from "./inputs.js";
import { STANDARD_PROFILE_ID } from "./profiles.js";
import type { Flow, Step } from "./types.js";

/**
 * 工程設計の編集（spec §7）: 工程カードの追加・複製・並び替え、フローの複製と名前（P4 #18567）と、今の設計との違い（録音の
 * 「この録音の工程を今の設計に更新」と、録音の「工程」を別のフローに変えるときの確認に出す。更新そのものは pages.ts の
 * recordingWithCurrentFlow）。
 * id は呼び出し側が作って渡す（docs-core は乱数の API を持たない）。工程の id は成果物のファイル名になるので、
 * 名前を変えても id は変えない（成果物は id で引くので、名前の変更にファイル名が追従する必要は無い）。
 */

/** 足した工程カードの名前（Google フォームの「無題の質問」と同じ考え）。 */
export const NEW_STEP_NAME = "無題の工程";

function nameKey(name: string): string {
  return name.normalize("NFKC").trim();
}

/** `others` と重ならない名前（重なれば「 2」「 3」…を付ける。NFKC・前後の空白を無視して比べる）。 */
function uniqueName(base: string, others: readonly { name: string }[]): string {
  const used = new Set(others.map((other) => nameKey(other.name)));
  if (!used.has(nameKey(base))) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base} ${suffix}`;
    if (!used.has(nameKey(candidate))) return candidate;
  }
}

/** 今の工程と重ならない名前（重なれば「 2」「 3」…を付ける）。 */
export function uniqueStepName(base: string, steps: readonly Pick<Step, "name">[]): string {
  return uniqueName(base, steps);
}

/**
 * ほかのフローと重ならないフローの名前（P4 #18567。録音のページの「工程」の選択肢で見分けられるように、追加・複製で
 * 「 2」「 3」…を付ける）。
 */
export function uniqueFlowName(base: string, flows: readonly Pick<Flow, "name">[]): string {
  return uniqueName(base, flows);
}

/**
 * フローの「複製」（P4 #18567）: 新しい id・「〈名前〉のコピー」（重ならない名前）・revision 1。文書ガイド・共通の固有名詞・
 * お手本の文書・工程は写す（工程の id もそのまま。成果物は録音ごとなので重ならず、元のフローと同じ工程は同じ工程として比べられる）。
 * お手本の本文（flows/samples/）は Rust の duplicate_flow が新しい id のフォルダへ写す。
 */
export function duplicateFlow(flow: Flow, id: string, flows: readonly Pick<Flow, "name">[]): Flow {
  return {
    ...flow,
    id,
    name: uniqueFlowName(`${flow.name.trim()}のコピー`, flows),
    revision: 1,
    transcription: flowHasTranscription(flow),
    terms: flow.terms.map((entry) => ({ ...entry, variants: [...entry.variants] })),
    samples: flow.samples.map((sample) => ({ ...sample })),
    steps: flow.steps.map((step) => ({ ...step })),
  };
}

/** 「＋ 工程を追加」の新しい工程（名前は重ならない「無題の工程」、指示文は空、モデルは標準）。 */
export function newStep(id: string, steps: readonly Step[]): Step {
  return { id, name: uniqueStepName(NEW_STEP_NAME, steps), instruction: "", profile: STANDARD_PROFILE_ID };
}

/** 「複製」: 名前に「のコピー」を付け、指示文とモデルを写す。 */
export function duplicateStep(step: Step, id: string, steps: readonly Step[]): Step {
  return { ...step, id, name: uniqueStepName(`${step.name.trim()}のコピー`, steps) };
}

/** 工程を `from` から `to` の位置へ動かす（範囲の外は端に寄せる）。 */
export function moveStep(steps: readonly Step[], from: number, to: number): Step[] {
  const next = [...steps];
  if (from < 0 || from >= next.length) return next;
  const [moved] = next.splice(from, 1);
  if (!moved) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  return next;
}

function stepsKey(steps: readonly Step[]) {
  return steps.map((step) => [step.id, step.name, step.instruction, step.provider ?? null, step.profile]);
}

function termsKey(flow: Flow) {
  return cleanGlossary(flow.terms).map((entry) => [entry.term, entry.reading, entry.variants, entry.note]);
}

/** 実行に効く設計（文書ガイド・共通の固有名詞・工程）が同じか。名前・revision・お手本の文書は比べない。 */
export function sameFlowDesign(a: Flow, b: Flow): boolean {
  return (
    JSON.stringify([flowHasTranscription(a), a.guide, termsKey(a), stepsKey(a.steps)]) ===
    JSON.stringify([flowHasTranscription(b), b.guide, termsKey(b), stepsKey(b.steps)])
  );
}

/** 工程設計の編集中の内容が保存済みと同じか（名前とお手本の文書も比べる。保存ボタンの有効・無効）。 */
export function sameFlowContent(a: Flow, b: Flow): boolean {
  const samples = (flow: Flow) => flow.samples.map((sample) => [sample.id, sample.name, sample.chars, sample.truncatedFrom ?? null, sample.sourceUrl ?? null]);
  return sameFlowDesign(a, b) && a.name === b.name && JSON.stringify(samples(a)) === JSON.stringify(samples(b));
}

/** 録音の工程（snapshot）と今の工程設計の違い。「この録音の工程を今の設計に更新」の確認に出す。 */
export type FlowDesignDiff = {
  /** 今の設計で増える工程の名前。 */
  added: string[];
  /** 今の設計に無い工程の名前（成果物のファイルは残るが、案件の工程の列から外れる）。 */
  removed: string[];
  renamed: { from: string; to: string }[];
  /** 指示文が変わる工程の名前（今の名前）。成果物があれば stale になる。 */
  instructions: string[];
  /** モデル（プロファイル・提供元）が変わる工程の名前。 */
  models: string[];
  /** 残る工程の順序が変わる。 */
  reordered: boolean;
  /** 文書ガイドか共通の固有名詞が変わる。 */
  guide: boolean;
  /** 先頭の文字起こし工程の有無が変わる。 */
  transcription: boolean;
};

export function diffFlowDesign(snapshot: Flow, flow: Flow): FlowDesignDiff {
  const before = new Map(snapshot.steps.map((step) => [step.id, step]));
  const after = new Map(flow.steps.map((step) => [step.id, step]));
  const diff: FlowDesignDiff = {
    added: flow.steps.filter((step) => !before.has(step.id)).map((step) => step.name),
    removed: snapshot.steps.filter((step) => !after.has(step.id)).map((step) => step.name),
    renamed: [],
    instructions: [],
    models: [],
    reordered: false,
    guide: JSON.stringify([snapshot.guide, termsKey(snapshot)]) !== JSON.stringify([flow.guide, termsKey(flow)]),
    transcription: flowHasTranscription(snapshot) !== flowHasTranscription(flow),
  };
  for (const step of flow.steps) {
    const old = before.get(step.id);
    if (!old) continue;
    if (old.name !== step.name) diff.renamed.push({ from: old.name, to: step.name });
    if (old.instruction.trim() !== step.instruction.trim()) diff.instructions.push(step.name);
    if (old.profile !== step.profile || (old.provider ?? null) !== (step.provider ?? null)) diff.models.push(step.name);
  }
  const kept = (steps: readonly Step[], other: Map<string, Step>) => steps.filter((step) => other.has(step.id)).map((step) => step.id);
  diff.reordered = JSON.stringify(kept(snapshot.steps, after)) !== JSON.stringify(kept(flow.steps, before));
  return diff;
}
