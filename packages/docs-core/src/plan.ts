import { cleanGlossary } from "./glossary.js";
import { cleanProjectEntities } from "./entities.js";
import { SOURCE_STEP_ID, flowHasTranscription, usedRefs, type PromptRef } from "./inputs.js";
import { hashText } from "./text.js";
import { sourceForPrompt } from "./transcript-speakers.js";
import type { Basis, ExecutionPlan, Flow, GlossaryEntry, RecordingInfo } from "./types.js";

/**
 * 前提のどれが変わったか（入力の並び: 文字起こし → 成果物 → 参考ページ → 案件情報 → 文書ガイド → 指示文。`step` は工程設計の
 * 更新で指示文が変わった）。
 */
export type StaleReason = "source" | "artifact" | "refs" | "info" | "guide" | "step";

export type BasisMaterials = {
  /** 工程 1 の名前。「文字起こし」のときだけ未確認の生成話者ラベルを source hash からも外す。 */
  sourceName?: string;
  source: string;
  /** source の版に保存された話者名対応。表示名変更だけでは入力本文の前提を変えない。 */
  transcriptSpeakerNames?: Readonly<Record<string, string>>;
  artifacts: Readonly<Record<string, string | undefined>>;
  /** 参考ページ（無ければ参考なし）。 */
  refs?: readonly PromptRef[];
  info: RecordingInfo;
  /** 複数案を共通素材から作るときの、この案だけの追加指示。 */
  candidateInstruction?: string;
};

function glossaryJson(entries: readonly GlossaryEntry[]): string {
  return JSON.stringify(cleanGlossary(entries).map((entry) => [entry.term, entry.reading, entry.variants, entry.note]));
}

export function infoHash(info: RecordingInfo): string {
  const fields: unknown[] = [info.speakers, info.language, glossaryJson(info.terms), info.background.trim()];
  const entities = cleanProjectEntities(info.entities);
  // 登場人物の無い既存案件は、保存済みの前提と同じ hash を保つ。
  if (entities.length > 0) fields.push(entities.map(({ name, reading, role, note }) => [name, reading, role, note]));
  return hashText(JSON.stringify(fields));
}

/** 文書ガイドの前提（ガイドの本文と共通の固有名詞）。 */
export function guideHash(flow: Flow): string {
  return hashText(JSON.stringify([flow.guide.trim(), glossaryJson(flow.terms)]));
}

/**
 * 参考ページの前提（入力に入れる文書の id と本文の並び。前後の空白だけの違いは同じ。参考が無いときは空文字のハッシュ）。
 * タイトルは比べない（名前を変えただけでは前提変更にしない。工程名と同じ扱い）。
 */
export function refsHash(refs: readonly PromptRef[] | undefined): string {
  const used = usedRefs(refs);
  if (used.length === 0) return hashText("");
  return hashText(JSON.stringify(used.map((ref) => [ref.pageId, ref.body.trim()])));
}

/** 工程の指示文の前提（前後の空白だけの違いは同じ）。 */
export function stepHash(instruction: string): string {
  return hashText(instruction.trim());
}

/** 工程（`flow.steps[stepIndex]`）を今実行したときの前提。実行の記録に残し、あとで今の前提と比べる。 */
export function basisFor(flow: Flow, stepIndex: number, materials: BasisMaterials): Basis {
  const step = flow.steps[stepIndex];
  if (!Number.isInteger(stepIndex) || !step) {
    throw new RangeError(`stepIndex out of range: ${stepIndex}`);
  }
  const artifacts: Record<string, string> = {};
  for (const step of flow.steps.slice(0, stepIndex)) {
    artifacts[step.id] = hashText(materials.artifacts[step.id] ?? "");
  }
  return {
    source: hashText(
      `${flowHasTranscription(flow) ? "" : "flow-without-transcription\u0000"}${sourceForPrompt(
        materials.sourceName ?? "文章",
        materials.source,
        materials.transcriptSpeakerNames,
      )}`,
    ),
    artifacts,
    info: infoHash(materials.info),
    guide: guideHash(flow),
    step: stepHash([step.instruction, materials.candidateInstruction ?? ""].join("\n\n")),
    refs: refsHash(materials.refs),
  };
}

/**
 * 記録した前提と今の前提の違い。記録が無い（前提を残す前の版）ときは判定しない。参考の記録が無い（P3 より前の）版は「参考なし」と
 * 同じに比べる（参考を足したときだけ stale）。
 */
export function staleReasons(recorded: Basis | undefined, current: Basis): StaleReason[] {
  if (!recorded) return [];
  const reasons: StaleReason[] = [];
  if (recorded.source !== current.source) reasons.push("source");
  const ids = new Set([...Object.keys(recorded.artifacts), ...Object.keys(current.artifacts)]);
  for (const id of ids) {
    if (recorded.artifacts[id] !== current.artifacts[id]) {
      reasons.push("artifact");
      break;
    }
  }
  if ((recorded.refs ?? refsHash([])) !== (current.refs ?? refsHash([]))) reasons.push("refs");
  if (recorded.info !== current.info) reasons.push("info");
  if (recorded.guide !== current.guide) reasons.push("guide");
  if (recorded.step !== undefined && current.step !== undefined && recorded.step !== current.step) reasons.push("step");
  return reasons;
}

/** 元にした内容のどれが変わったかを知らせる順（入力の並びと同じ。いちばん元に近いものを 1 つだけ出す）。 */
const STALE_NOTICE_ORDER: readonly StaleReason[] = ["source", "artifact", "refs", "info", "guide", "step"];

/**
 * 元にした内容が変わったページの、本文の上に出す 1 行（#18915。Mac と Web で同じ文）。理由が無ければ null。
 * 「成果物」「前提変更」の語は使わない。続ける操作（「作り直す」）は画面が添える。
 */
export function staleNoticeText(reasons: readonly StaleReason[], sourceKind: "audio" | "text" = "audio"): string | null {
  const reason = STALE_NOTICE_ORDER.find((candidate) => reasons.includes(candidate));
  switch (reason) {
    case "source":
      return sourceKind === "text" ? "元の文章が変わりました。" : "元の文字起こしが変わりました。";
    case "artifact":
      return "元にしたページが変わりました。";
    case "refs":
      return "参考のページが変わりました。";
    case "info":
      return "背景情報が変わりました。";
    case "guide":
      return "文書ガイドが変わりました。";
    case "step":
      return "工程の指示が変わりました。";
    default:
      return null;
  }
}

export type StepProgress = {
  /** 工程 id（工程 1 は SOURCE_STEP_ID）。 */
  stepId: string;
  name: string;
  /** 画面の番号（工程 1 が 1）。 */
  number: number;
  done: boolean;
  /** 前提が変わった（自動では再実行しない）。 */
  stale: boolean;
  staleReasons: StaleReason[];
};

export type ProjectPlanInput = {
  flow: Flow;
  sourceName: string;
  /** 工程 1 の成果物。まだ無ければ空文字。 */
  source: string;
  transcriptSpeakerNames?: Readonly<Record<string, string>>;
  artifacts: Readonly<Record<string, string | undefined>>;
  /** 参考ページ（無ければ参考なし）。 */
  refs?: readonly PromptRef[];
  info: RecordingInfo;
  /** 工程 id → 最新版の前提。 */
  latestBasis: Readonly<Record<string, Basis | undefined>>;
};

export type ProjectPlan = {
  /** 実行計画（v1 は continuous。internalChunked は S0 の 5 で落ちた提供元のため。画面には出さない）。 */
  plan: ExecutionPlan;
  steps: StepProgress[];
  /** 残りの工程（まだ成果物の無い工程の id を並んだ順に）。「残りの工程を実行」はこの順に実行する。 */
  remaining: string[];
  doneCount: number;
  total: number;
};

/** 実行計画: 工程ごとの済・stale と、残りの工程の列。 */
export function planProject(input: ProjectPlanInput): ProjectPlan {
  const steps: StepProgress[] = [
    {
      stepId: SOURCE_STEP_ID,
      name: input.sourceName,
      number: 1,
      done: input.source.trim().length > 0,
      stale: false,
      staleReasons: [],
    },
  ];
  const materials: BasisMaterials = {
    sourceName: input.sourceName,
    source: input.source,
    ...(input.transcriptSpeakerNames ? { transcriptSpeakerNames: input.transcriptSpeakerNames } : {}),
    artifacts: input.artifacts,
    refs: input.refs,
    info: input.info,
  };
  input.flow.steps.forEach((step, index) => {
    const done = (input.artifacts[step.id] ?? "").trim().length > 0;
    const reasons = done ? staleReasons(input.latestBasis[step.id], basisFor(input.flow, index, materials)) : [];
    steps.push({
      stepId: step.id,
      name: step.name,
      number: index + 2,
      done,
      stale: reasons.length > 0,
      staleReasons: reasons,
    });
  });
  const remaining = steps
    .filter((step) => !step.done && (step.stepId !== SOURCE_STEP_ID || flowHasTranscription(input.flow)))
    .map((step) => step.stepId);
  const doneCount = steps.filter((step) => step.done).length;
  return { plan: executionPlanFor(), steps, remaining, doneCount, total: steps.length };
}

/** 実行計画を決める（v1 はどの提供元も continuous）。 */
export function executionPlanFor(): ExecutionPlan {
  return "continuous";
}

/** 工程の入力がそろっているか（前の工程の成果物がすべてあるか）。 */
export function canRunStep(plan: ProjectPlan, stepId: string): boolean {
  const index = plan.steps.findIndex((step) => step.stepId === stepId);
  if (index < 0) return false;
  return plan.steps.slice(0, index).every((step) => step.done);
}
