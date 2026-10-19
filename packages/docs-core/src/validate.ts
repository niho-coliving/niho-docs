import { RESERVED_STEP_NAMES } from "./inputs.js";
import { GUIDE_MAX_CHARS } from "./rules.js";
import { countChars } from "./text.js";
import type { Flow, Profile } from "./types.js";

export type FlowIssueCode =
  | "empty-flow-name"
  | "empty-step-name"
  | "duplicate-step-name"
  | "reserved-step-name"
  | "duplicate-step-id"
  | "empty-instruction"
  | "unknown-profile"
  | "guide-too-long"
  | "no-steps";

/** 検証の結果 1 件。`stepId` のあるものは工程カードに、無いものは名前・文書ガイドの欄に出す。 */
export type FlowIssue = {
  code: FlowIssueCode;
  stepId?: string;
  message: string;
};

function nameKey(name: string): string {
  return name.normalize("NFKC").trim();
}

/**
 * フローの検証: 名前の重複なし・空の指示文なし・ガイドの上限（GUIDE_MAX_CHARS）。工程設計はこれが空でなければ保存しない。
 * `profiles` を渡すと、工程のプロファイルが設定にあるかも確かめる。
 */
export function validateFlow(flow: Flow, profiles?: readonly Profile[]): FlowIssue[] {
  const issues: FlowIssue[] = [];
  if (!flow.name.trim()) {
    issues.push({ code: "empty-flow-name", message: "工程設計の名前が空です。" });
  }
  if (flow.steps.length === 0) {
    issues.push({ code: "no-steps", message: "工程がありません。" });
  }
  const names = new Map<string, number>();
  const ids = new Set<string>();
  for (const step of flow.steps) {
    const key = nameKey(step.name);
    if (!key) {
      issues.push({ code: "empty-step-name", stepId: step.id, message: "工程の名前が空です。" });
    } else if (RESERVED_STEP_NAMES.includes(key)) {
      issues.push({
        code: "reserved-step-name",
        stepId: step.id,
        message: `「${key}」は工程 1 の名前なので、工程 2 以降には使えません。`,
      });
    } else {
      names.set(key, (names.get(key) ?? 0) + 1);
      if (names.get(key) === 2) {
        issues.push({ code: "duplicate-step-name", stepId: step.id, message: `工程の名前「${key}」が重なっています。` });
      }
    }
    if (ids.has(step.id)) {
      issues.push({ code: "duplicate-step-id", stepId: step.id, message: "工程の id が重なっています。" });
    }
    ids.add(step.id);
    if (!step.instruction.trim()) {
      issues.push({
        code: "empty-instruction",
        stepId: step.id,
        message: `「${key || "名前の無い工程"}」の指示文が空です。`,
      });
    }
    if (profiles && !profiles.some((profile) => profile.id === step.profile)) {
      issues.push({
        code: "unknown-profile",
        stepId: step.id,
        message: `「${key || "名前の無い工程"}」のモデルが設定にありません。`,
      });
    }
  }
  if (countChars(flow.guide) > GUIDE_MAX_CHARS) {
    issues.push({
      code: "guide-too-long",
      message: `文書ガイドは ${GUIDE_MAX_CHARS.toLocaleString("ja-JP")} 字までです。`,
    });
  }
  return issues;
}

/** 工程カードに出す検証の結果（その工程のものだけ）。 */
export function stepIssues(issues: readonly FlowIssue[], stepId: string): FlowIssue[] {
  return issues.filter((issue) => issue.stepId === stepId);
}
