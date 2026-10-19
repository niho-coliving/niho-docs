import { sourceStepName } from "./inputs.js";
import { BLANK_FLOW_NAME, FLOW_TEMPLATES, type FlowTemplate } from "./templates.js";
import type { Flow, Step } from "./types.js";

/**
 * 録音の「工程」の選択肢（#18883）。Mac の録音のページと Web/PWA の新しい録音で同じ体験にするため、選択肢の並び・テンプレートの
 * 出し分け・既定・工程の列の 1 行・選べない理由の規則はここだけに置く（描き方の select・optgroup は各アプリ）。
 * - あなたの工程: 呼び出し側が渡した並び（Mac の flows/index.json の並び、残りは id の順）のまま。
 * - テンプレート: FLOW_TEMPLATES の並びで、手を加えていない写しをすでに持っているテンプレートは出さない。選ぶと新しい工程として
 *   保存して「あなたの工程」に足し、その工程を使う（作るのは各アプリ。名前は uniqueFlowName で重ならないようにする）。
 * - 既定: 候補のうち選べる最初のもの → あなたの工程の選べる先頭 → 無し。テンプレートは既定にしない（記事制作を標準にしない）。
 */

/** 欄の名前。 */
export const FLOW_CHOICE_LABEL = "工程";

/** 選択肢のまとまりの名前（あなたの工程を先に、テンプレートを後に）。 */
export const FLOW_CHOICE_GROUP_LABELS = { flows: "あなたの工程", templates: "テンプレート" } as const;

/** 1 本の工程が持てる工程（工程 2 以降）の数の上限（Web/PWA の依頼が 1〜32 工程だけを受け付ける）。 */
export const FLOW_MAX_STEPS = 32;

/** 工程の列の区切り（「文字起こし › 記事方針 › 記事本文」）。 */
export const FLOW_STEP_SEPARATOR = " › ";

/** 選んだもの。あなたの工程は `flow:<flowId>`、テンプレートは `template:<テンプレートの id>`。 */
export type FlowChoiceKey = `flow:${string}` | `template:${string}`;

/** 選択肢に出す工程の形（Mac の Flow も、Web/PWA が保管庫から読んだ工程のファイルも満たす）。 */
export type FlowChoiceSource = {
  id: string;
  name: string;
  guide: string;
  steps: readonly Pick<Step, "id" | "name" | "instruction">[];
  /** 共通の固有名詞・お手本の文書（数だけ見る。テンプレートの写しは空で始まる）。無ければ空とみなす。 */
  terms?: readonly unknown[];
  samples?: readonly unknown[];
};

export type FlowChoiceFlowOption<F> = {
  kind: "flow";
  key: `flow:${string}`;
  id: string;
  name: string;
  stepNames: string[];
  /** 選べない理由（null は選べる）。 */
  problem: string | null;
  flow: F;
};

export type FlowChoiceTemplateOption = {
  kind: "template";
  key: `template:${string}`;
  id: string;
  name: string;
  stepNames: string[];
  problem: null;
  template: FlowTemplate;
};

export type FlowChoiceOption<F = Flow> = FlowChoiceFlowOption<F> | FlowChoiceTemplateOption;

export type FlowChoiceGroup<F = Flow> = {
  kind: "flows" | "templates";
  label: string;
  options: FlowChoiceOption<F>[];
};

export type FlowChoices<F = Flow> = {
  /** あなたの工程・テンプレートの順の 2 つ（中身が空のまとまりは描かない）。 */
  groups: [FlowChoiceGroup<F>, FlowChoiceGroup<F>];
  /** groups を並びのまま 1 列にしたもの。 */
  options: FlowChoiceOption<F>[];
};

export function flowChoiceKey(kind: "flow", id: string): `flow:${string}`;
export function flowChoiceKey(kind: "template", id: string): `template:${string}`;
export function flowChoiceKey(kind: "flow" | "template", id: string): FlowChoiceKey {
  return kind === "flow" ? (`flow:${id}` as const) : (`template:${id}` as const);
}

/** 選んだものの文字列を分ける（形の違う値は null）。 */
export function parseFlowChoiceKey(value: string): { kind: "flow" | "template"; id: string } | null {
  const match = /^(flow|template):(.+)$/.exec(value);
  if (!match) return null;
  return { kind: match[1] === "flow" ? "flow" : "template", id: match[2]! };
}

/** 工程の列（工程 1 の名前を先頭に、工程 2 以降の名前）。Mac は区切りを描き分けるので、1 行にする前の並びも出す。 */
export function flowStepLineParts(
  steps: readonly Pick<Step, "name">[],
  sourceName: string = sourceStepName({ kind: "audio", audio: [] }),
): string[] {
  return [sourceName, ...steps.map((step) => step.name)];
}

/** 工程の列の 1 行（「文字起こし › 文字起こし修正 › 記事方針 › 記事本文」）。 */
export function flowStepLine(steps: readonly Pick<Step, "name">[], sourceName?: string): string {
  return flowStepLineParts(steps, sourceName).join(FLOW_STEP_SEPARATOR);
}

/** 録音に使えない工程の理由（Mac と Web/PWA で同じ文。null は使える）。 */
export function flowUnusableReason(flow: { steps: readonly Pick<Step, "instruction">[] }): string | null {
  if (flow.steps.length === 0) return "工程がありません";
  if (flow.steps.length > FLOW_MAX_STEPS) return `工程が ${FLOW_MAX_STEPS} 個を超えています`;
  if (flow.steps.some((step) => typeof step.instruction !== "string" || !step.instruction.trim())) return "指示文のない工程があります";
  return null;
}

/**
 * テンプレートに手を加えていない写しか（createFlowFromTemplate はテンプレートの固定の工程 id を写す）。文書ガイドと、工程の数・
 * 各工程の id・名前・指示文が同じで、共通の固有名詞とお手本の文書がテンプレートの写しの空のままなら写しとみなす（固有名詞を
 * 足した工程は案件向けに調整した別の工程で、元のテンプレートを隠さない）。フローの名前（重ならないように番号が付く）・モデルの
 * 指定は比べない。
 */
export function isUnmodifiedTemplateCopy(flow: Pick<FlowChoiceSource, "guide" | "steps" | "terms" | "samples">, template: FlowTemplate): boolean {
  return (
    (flow.terms?.length ?? 0) === 0 &&
    (flow.samples?.length ?? 0) === 0 &&
    flow.guide === template.guide &&
    flow.steps.length === template.steps.length &&
    template.steps.every((step, index) => {
      const copied = flow.steps[index];
      return copied !== undefined && copied.id === step.id && copied.name === step.name && copied.instruction === step.instruction;
    })
  );
}

/**
 * 「工程」の選択肢。`flows` はあなたの工程（表示の並び）。`problem` はアプリだけの検査（Web/PWA の録音の大きさなど）で、共通の
 * 理由（flowUnusableReason）が無いときだけ使う。
 */
export function buildFlowChoices<F extends FlowChoiceSource>(
  flows: readonly F[],
  options: { problem?: (flow: F) => string | null } = {},
): FlowChoices<F> {
  const own = flows.map(
    (flow): FlowChoiceFlowOption<F> => ({
      kind: "flow",
      key: flowChoiceKey("flow", flow.id),
      id: flow.id,
      name: flow.name || BLANK_FLOW_NAME,
      stepNames: flow.steps.map((step) => step.name),
      problem: flowUnusableReason(flow) ?? options.problem?.(flow) ?? null,
      flow,
    }),
  );
  const templates = FLOW_TEMPLATES.filter((template) => !flows.some((flow) => isUnmodifiedTemplateCopy(flow, template))).map(
    (template): FlowChoiceTemplateOption => ({
      kind: "template",
      key: flowChoiceKey("template", template.id),
      id: template.id,
      name: template.name,
      stepNames: template.steps.map((step) => step.name),
      problem: null,
      template,
    }),
  );
  return {
    groups: [
      { kind: "flows", label: FLOW_CHOICE_GROUP_LABELS.flows, options: own },
      { kind: "templates", label: FLOW_CHOICE_GROUP_LABELS.templates, options: templates },
    ],
    options: [...own, ...templates],
  };
}

/**
 * 既定の選択。`candidates`（選んだものの文字列。Web/PWA はこの画面で選んだもの → この端末で最後に選んだもの → Mac で最後に使った
 * 工程、Mac は最後に使った工程）のうち選べる最初のもの → あなたの工程の選べる先頭 → 無し（null）。テンプレートは候補として
 * 明示されたときだけ選び、既定の行き先にはしない。
 */
export function defaultFlowChoice<O extends { key: string; kind: "flow" | "template"; problem: string | null }>(
  options: readonly O[],
  candidates: readonly (string | null | undefined)[],
): O | null {
  for (const candidate of candidates) {
    const found = candidate ? options.find((option) => option.key === candidate && !option.problem) : undefined;
    if (found) return found;
  }
  return options.find((option) => option.kind === "flow" && !option.problem) ?? null;
}
