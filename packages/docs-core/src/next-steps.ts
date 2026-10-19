/**
 * 録音から作ったページの「次の工程」の入口の言葉と並び（Epic #18937 S4・#19050）。右レール上段の「工程」・「AIと作る」の ＋／「/」の一覧・
 * スマホの本文の末尾の「次の工程」・本文の上の帯が、同じ列と同じ言葉を使うために、画面を持たない規則だけをここに置く
 * （正は docs/design/design-guide-docs.md §1・§3。表を直してからここを直す。言葉は {@link ./run-words.ts} を正に増やさない）。
 */

import { NEXT_STEPS_WORDS, RUN_START_LABELS, type NextStepStatus } from "./run-words.js";

export type NextStepInput = { stepId: string; label: string; done: boolean };
export type NextStepRow = {
  stepId: string;
  label: string;
  status: NextStepStatus;
  /** 開いているページの行（右は「このページ」）。 */
  current: boolean;
  /** 行の右の言葉。 */
  statusLabel: string;
};

/**
 * 工程の列（原文の工程を先頭に、保存済みの録音の工程の順）。実行中は `active` の工程の状態（running/waiting/done）を優先し、
 * 無い工程は保存済みなら 完了、そうでなければ 未作成。止めた・失敗した実行は `active` を渡さない（行は 未作成 に戻る）。
 */
export function nextStepRows(input: {
  steps: readonly NextStepInput[];
  currentStepId: string | null;
  active?: Readonly<Record<string, Exclude<NextStepStatus, "todo">>> | null;
}): NextStepRow[] {
  return input.steps.map((step) => {
    const activeStatus = input.active?.[step.stepId];
    const status: NextStepStatus = activeStatus ?? (step.done ? "done" : "todo");
    const current = step.stepId === input.currentStepId;
    return {
      stepId: step.stepId,
      label: step.label,
      status,
      current,
      statusLabel: current ? NEXT_STEPS_WORDS.thisPage : NEXT_STEPS_WORDS.statusLabels[status],
    };
  });
}

/** まだ作っていない工程（原文を除く保存前の工程）。 */
export function remainingNextSteps(steps: readonly NextStepInput[], sourceStepId: string): NextStepInput[] {
  return steps.filter((step) => step.stepId !== sourceStepId && !step.done);
}

/** 見出しの右の 1 語（処理中／残り N／すべて完了）。畳んでも見出しと一緒に残す。 */
export function nextStepsSummary(input: { running: boolean; remaining: number }): string {
  if (input.running) return NEXT_STEPS_WORDS.running;
  return input.remaining > 0 ? `残り ${input.remaining}` : NEXT_STEPS_WORDS.allDone;
}

/** 主ボタンの文（残りがあれば「続きを作成」。全部できていれば「すべて再実行」で、Web では押せる経路が無いので出さない）。 */
export function nextStepsPrimaryLabel(remaining: number): string {
  return remaining > 0 ? RUN_START_LABELS.continue : RUN_START_LABELS.rerunAll;
}

/** ＋ の一覧の「続きを作成」の添え書き（残りの工程名を「 › 」でつなぐ。残りが 2 つ以上のときだけ）。 */
export function continueMenuCaption(remainingLabels: readonly string[]): string | null {
  return remainingLabels.length >= 2 ? remainingLabels.join(" › ") : null;
}

/** 本文の上の帯（処理中）。`place` は「クラウドで作っています」など。 */
export function runningBandLine(input: { stepName: string; place: string }): { lead: string; place: string } {
  return { lead: `処理中: ${input.stepName}`, place: `· ${input.place}` };
}

/** 全部終わった帯。 */
export function doneBandLine(stepNames: readonly string[]): string {
  return `${stepNames.join("・")} を作りました。`;
}

/** 会話に残す実行の行（「続きを作成」は工程の数を添える）。 */
export function runRowLabel(input: { kind: "continue"; steps: number } | { kind: "step"; stepName: string }): string {
  return input.kind === "continue" ? `▶ ${RUN_START_LABELS.continue}（${input.steps} 工程）` : `▶ ${input.stepName}を実行`;
}

/** 入力枠のチップ（「続きを作成」は動詞なのでそのまま、工程は「〈工程名〉を実行」）。 */
export function runChipLabel(input: { kind: "continue" } | { kind: "step"; stepName: string }): string {
  return input.kind === "continue" ? `▶ ${RUN_START_LABELS.continue}` : `▶ ${input.stepName}を実行`;
}

/** 会話に残す返答（工程ごとに 1 行）。 */
export function runDoneReply(stepName: string): string {
  return `「${stepName}」を作りました。`;
}
