import { flowHasTranscription } from "./inputs.js";
import type { Connection, Effort, Flow, FlowSnapshot, Profile, ProfileModel, ProviderId, ResolvedStepModel, Step } from "./types.js";

/** 設定の既定のプロファイル（標準・高性能）の id。工程はプロファイル名で選ぶので、フローは方式や AI に依存しない。 */
export const STANDARD_PROFILE_ID = "standard";
export const ADVANCED_PROFILE_ID = "advanced";
/**
 * 長い文書をほぼ同じ長さで書き直す工程（文字起こし修正）用の「軽量」。思考量を低くする。
 * Claude Sonnet 4.6 は思考量が中以上だと、98 分の文字起こし（約 3.9 万字）の修正版を思考の中で下書きし、1 回の出力の上限
 * （Claude Code の既定 32,000 トークン。64,000 に上げても同じ）を思考だけで使い切って本文を 1 字も書かない。Claude Code の
 * 自動の続きでも思考がやり直しになり、45 分の時間切れまで進まない。低なら同じ入力を 14 分で書き終える（#18382 の実機の確認）。
 */
export const LIGHT_PROFILE_ID = "light";
/** 削除できない既定のプロファイル（テンプレートの工程が指す）。 */
export const BUILT_IN_PROFILE_IDS: readonly string[] = [STANDARD_PROFILE_ID, ADVANCED_PROFILE_ID, LIGHT_PROFILE_ID];

/** 登録できる AI（設定の「＋ 追加」の並び）。 */
export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "gpt", "gemini"];

export type ModelOption = { id: string; label: string };

/**
 * AI ごとのモデルの控えの選択肢（CLI から一覧が取れないとき）。
 *
 * - Claude: Claude Code には一覧のコマンドが無いので、いつもこの表。先頭の 2 つが標準・高性能の初期値。NIHO の記事制作の
 *   モデルの決まり（apps/api の ops の Claude のモデルの policy）の既定 `claude-sonnet-4-6` と、同じ policy が要約付きの思考を
 *   確かめている上位の `claude-opus-4-8` に合わせる。S1 は別名（sonnet・opus）だったが、別名は CLI が新しい版に替えるので
 *   NIHO と同じ版に固定した（別名は「最新」として残す。S1 で保存した設定はそのまま読む）。
 * - GPT: Codex CLI はログイン後に `codex debug models` でアカウントの一覧が取れる（`ProviderStatus.models`）。取れないとき
 *   の控え。2026-10-15 に Studio のアカウントで一覧に出た 2 つ（terra＝balanced・luna＝fast）。
 * - Gemini: Antigravity CLI の `agy models` が一覧（ログイン後）。`gemini-3.8-flash` は思考量（low|medium|high）を受け、
 *   思考量入りの名前（`-high` など）は思考量を受けない（S1-B #18402）。3.1 Pro は agy に無い（S0 #18381）。
 */
export const MODEL_OPTIONS: Readonly<Record<ProviderId, readonly ModelOption[]>> = {
  claude: [
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "sonnet", label: "Claude Sonnet（最新）" },
    { id: "opus", label: "Claude Opus（最新）" },
    { id: "fable", label: "Claude Fable（最新）" },
    { id: "haiku", label: "Claude Haiku（最新）" },
  ],
  gpt: [
    { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
  ],
  gemini: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
  ],
};

/**
 * API キー方式のモデルの控え（鍵の確かめで一覧が返らないとき。返れば `modelOptions` がそれを使う）。CLI の別名（sonnet など）は
 * API では使えないので入れない。Claude は S2a の控えの版つきの ID（NIHO の policy の既定と上位）、GPT は Codex CLI と同じ
 * terra・luna、Gemini は NIHO の Gemini の文字起こしの Flash（`gemini-3.8-flash`）と Pro（`gemini-3.1-pro-preview`）。
 */
export const API_MODEL_OPTIONS: Readonly<Record<ProviderId, readonly ModelOption[]>> = {
  claude: [
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
  ],
  gpt: [
    { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
  ],
  gemini: [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  ],
};

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "max"];

const EFFORT_LABELS: Record<Effort, string> = { low: "低", medium: "中", high: "高", max: "最大" };

export function effortLabel(effort: Effort): string {
  return EFFORT_LABELS[effort];
}

const PROVIDER_LABELS: Record<ProviderId, string> = { claude: "Claude", gpt: "GPT", gemini: "Gemini" };

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider];
}

/** サブスクリプション方式で AI を動かす CLI の名前（設定の行・案内）。 */
const CLI_LABELS: Record<ProviderId, string> = { claude: "Claude Code", gpt: "Codex CLI", gemini: "Antigravity CLI" };

export function cliLabel(provider: ProviderId): string {
  return CLI_LABELS[provider];
}

const THINKING_SUFFIX = /^(.+)-(low|medium|high)$/;

function capitalize(word: string): string {
  return word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word;
}

/** 控えに無いモデル ID の表示名（`gpt-5.6-sol` → 「GPT-5.6-Sol」、`gemini-3.1-pro-high` → 「Gemini 3.1 Pro (High)」）。 */
function prettyModelId(provider: ProviderId, model: string): string {
  if (provider === "gpt" && /^gpt-/i.test(model)) {
    return `GPT-${model.slice(4).split("-").map(capitalize).join("-")}`;
  }
  if (provider === "gemini" && /^gemini-/i.test(model)) {
    const suffix = THINKING_SUFFIX.exec(model);
    const base = suffix ? suffix[1]! : model;
    const name = base.split("-").map(capitalize).join(" ");
    return suffix ? `${name} (${capitalize(suffix[2]!)})` : name;
  }
  if (provider === "claude" && /^claude-[a-z]+-\d+(-\d+)?$/i.test(model)) {
    const [, family = "", ...version] = model.split("-");
    return `Claude ${capitalize(family)} ${version.join(".")}`;
  }
  return model;
}

/** モデルの表示名（「Claude Sonnet 4.6」）。控えに無い ID は ID から作る（形の分からない ID はそのまま）。 */
export function modelLabel(provider: ProviderId, model: string): string {
  return (
    MODEL_OPTIONS[provider].find((option) => option.id === model)?.label ??
    API_MODEL_OPTIONS[provider].find((option) => option.id === model)?.label ??
    prettyModelId(provider, model)
  );
}

/** 表示名から提供元の名前を外した短い名前（「Sonnet 4.6」）。 */
export function shortModelLabel(provider: ProviderId, model: string): string {
  const label = modelLabel(provider, model);
  const prefix = `${providerLabel(provider)} `;
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

/**
 * 設定のモデルの選択肢: CLI が返した一覧（`ProviderStatus.models`）があればそれ、無ければ控え（`MODEL_OPTIONS`）。
 * Antigravity CLI の一覧には Gemini 以外（Claude・GPT）も出るが、Gemini の列には Gemini だけを出す（他社の名前を出さない）。
 * 思考量入りの名前（`gemini-3.8-flash-high`）が並ぶときは、思考量を選べる元の名前（`gemini-3.8-flash`）を先に足す。
 */
export function modelOptions(
  provider: ProviderId,
  available: readonly string[] = [],
  connection: Connection = "subscription",
): ModelOption[] {
  const fallback = connection === "apiKey" ? API_MODEL_OPTIONS : MODEL_OPTIONS;
  // Claude Code には一覧のコマンドが無い（API キー方式は鍵の確かめで一覧が返る）
  if (provider === "claude" && connection === "subscription") return [...MODEL_OPTIONS.claude];
  const prefix = provider === "claude" ? /^claude-/i : provider === "gemini" ? /^gemini-/i : /^gpt-/i;
  const listed = provider === "gpt" && connection === "subscription" ? [...available] : available.filter((id) => prefix.test(id));
  if (listed.length === 0) return [...fallback[provider]];
  const ids: string[] = [];
  for (const id of listed) {
    const base = provider === "gemini" ? THINKING_SUFFIX.exec(id)?.[1] : undefined;
    if (base && !ids.includes(base)) ids.push(base);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => ({ id, label: modelLabel(provider, id) }));
}

/**
 * モデルと思考量の組み合わせの決まり。`efforts` は選べる思考量、`fixed` は思考量がモデル名で決まるとき（その値）。
 * - Claude: Claude Code の `--effort`（低・中・高・最大）。
 * - GPT: Codex CLI の `-c model_reasoning_effort`（低・中・高・最大）。
 * - Gemini: Antigravity CLI の `--effort`。`gemini-3.8-flash` などは低・中・高（最大は無い）、思考量入りの名前は思考量を
 *   渡さない（渡すと agy が断り `RUNTIME_MODEL_NOT_FOUND`）。
 */
export type EffortRule = { efforts: readonly Effort[]; fixed: Effort | null };

export function effortRule(provider: ProviderId, model: string): EffortRule {
  if (provider !== "gemini") return { efforts: EFFORTS, fixed: null };
  const suffix = THINKING_SUFFIX.exec(model);
  if (suffix) {
    const fixed = suffix[2] as Effort;
    return { efforts: [fixed], fixed };
  }
  return { efforts: ["low", "medium", "high"], fixed: null };
}

/** 選べない思考量の理由（選べるなら null）。設定の思考量の選択肢を disabled にして、この文を添える。 */
export function effortUnavailableReason(provider: ProviderId, model: string, effort: Effort): string | null {
  const rule = effortRule(provider, model);
  if (rule.efforts.includes(effort)) return null;
  if (rule.fixed) return "思考量はモデル名で決まります";
  return `このモデルには「${effortLabel(effort)}」がありません`;
}

/** モデルに合う思考量へ寄せる（合わなければ、それより低いうちで一番高いもの。無ければ選べる中の先頭）。 */
export function fitEffort(provider: ProviderId, model: string, effort: Effort): Effort {
  const rule = effortRule(provider, model);
  if (rule.fixed) return rule.fixed;
  if (rule.efforts.includes(effort)) return effort;
  const lower = EFFORTS.slice(0, EFFORTS.indexOf(effort)).filter((candidate) => rule.efforts.includes(candidate));
  return lower[lower.length - 1] ?? rule.efforts[0] ?? effort;
}

/** CLI に渡す思考量（思考量がモデル名で決まるモデルは渡さない）。 */
export function requestEffort(provider: ProviderId, model: string, effort: Effort): Effort | null {
  return effortRule(provider, model).fixed ? null : effort;
}

/**
 * 既定のプロファイル。どの AI の値も持つ（AI を後から登録しても、その列がすぐ埋まる）。
 * Claude は MODEL_OPTIONS の注記どおり NIHO の policy の既定と上位。思考量は標準が高・高性能も高
 * （最大は時間がかかりすぎるため高性能でも使わない。owner 判断）。
 * GPT は控えの balanced（terra）を標準は高・高性能は最大で。Gemini は標準 3.8 Flash × 中・高性能 同 × 高（agy に 3.1 Pro が
 * 無いため。S1-B #18402 の勧め）。軽量（LIGHT_PROFILE_ID の注記）は標準と同じモデルで思考量を下げる（Claude・Gemini は低、
 * GPT は S0 #18381 の 5 で長い修正を省略なく通した中）。
 */
export function defaultProfiles(connection: Connection = "subscription"): Profile[] {
  if (connection === "apiKey") return defaultApiProfiles();
  return [
    {
      id: STANDARD_PROFILE_ID,
      name: "標準",
      models: {
        claude: { model: "claude-sonnet-4-6", effort: "high" },
        gpt: { model: "gpt-5.6-terra", effort: "high" },
        gemini: { model: "gemini-3.8-flash", effort: "medium" },
      },
    },
    {
      id: ADVANCED_PROFILE_ID,
      name: "高性能",
      models: {
        claude: { model: "claude-opus-4-8", effort: "high" },
        gpt: { model: "gpt-5.6-terra", effort: "max" },
        gemini: { model: "gemini-3.8-flash", effort: "high" },
      },
    },
    {
      id: LIGHT_PROFILE_ID,
      name: "軽量",
      models: {
        claude: { model: "claude-sonnet-4-6", effort: "low" },
        gpt: { model: "gpt-5.6-terra", effort: "medium" },
        gemini: { model: "gemini-3.8-flash", effort: "low" },
      },
    },
  ];
}

/**
 * API キー方式の既定のプロファイル。Claude・GPT はサブスクリプションと同じモデル × 思考量（Claude の ID は API でも同じ）。
 * Gemini は NIHO の Gemini の既定（標準 3.8 Flash × 中・高性能 3.1 Pro × 高。API には Pro がある）。
 */
function defaultApiProfiles(): Profile[] {
  return [
    {
      id: STANDARD_PROFILE_ID,
      name: "標準",
      models: {
        claude: { model: "claude-sonnet-4-6", effort: "high" },
        gpt: { model: "gpt-5.6-terra", effort: "high" },
        gemini: { model: "gemini-3.8-flash", effort: "medium" },
      },
    },
    {
      id: ADVANCED_PROFILE_ID,
      name: "高性能",
      models: {
        claude: { model: "claude-opus-4-8", effort: "high" },
        gpt: { model: "gpt-5.6-terra", effort: "max" },
        gemini: { model: "gemini-3.1-pro-preview", effort: "high" },
      },
    },
    {
      id: LIGHT_PROFILE_ID,
      name: "軽量",
      models: {
        claude: { model: "claude-sonnet-4-6", effort: "low" },
        gpt: { model: "gpt-5.6-terra", effort: "medium" },
        gemini: { model: "gemini-3.8-flash", effort: "low" },
      },
    },
  ];
}

export type ResolvedModel = {
  provider: ProviderId;
  profile: Profile;
  model: ProfileModel;
  /** 工程が指していた AI が登録されていなかったので、登録した AI の先頭へ寄せた。 */
  redirected: boolean;
};

/**
 * 工程のモデルを決める: 工程のプロファイル × 提供元（工程に指定が無ければ登録した AI の先頭）。
 * 工程が登録していない AI を指すとき（テンプレートの初期値・解除した AI）は、登録した AI の先頭へ寄せて `redirected`。
 * 登録した AI が無い・プロファイルか、その AI のモデルが無ければ null（実行しない）。
 */
export function resolveStepModel(
  step: Pick<Step, "profile" | "provider">,
  profiles: readonly Profile[],
  providers: readonly ProviderId[],
): ResolvedModel | null {
  const first = providers[0];
  if (!first) return null;
  const registered = step.provider !== undefined && providers.includes(step.provider);
  const provider = registered && step.provider ? step.provider : first;
  const profile = profiles.find((candidate) => candidate.id === step.profile);
  const model = profile?.models[provider];
  if (!profile || !model) return null;
  return { provider, profile, model, redirected: step.provider !== undefined && !registered };
}

/** 解決した工程のモデルを snapshot に持つ形にする（Mac の案件の作成と、Web が工程を自分の Mac で動かす固定で同じ形）。 */
export function toResolvedStepModel(resolved: ResolvedModel, connection: Connection): ResolvedStepModel {
  return {
    provider: resolved.provider,
    model: resolved.model.model,
    effort: resolved.model.effort,
    profileId: resolved.profile.id,
    profileName: resolved.profile.name,
    ...(resolved.redirected ? { redirected: true } : {}),
    connection,
  };
}

/**
 * フローの工程ごとのモデルを解く（resolveStepModel を全工程に）。解けない工程は `models` に入れず `unresolved` に並べる
 * （止めるか飛ばすかは呼ぶ側が決める。Mac の案件の作成は飛ばし、Web の自分の Mac で動かす固定は止める）。
 */
export function resolveFlowModels(
  flow: Pick<Flow, "steps">,
  profiles: readonly Profile[],
  providers: readonly ProviderId[],
  connection: Connection = "subscription",
): { models: Record<string, ResolvedStepModel>; unresolved: Step[] } {
  const models: Record<string, ResolvedStepModel> = {};
  const unresolved: Step[] = [];
  for (const step of flow.steps) {
    const resolved = resolveStepModel(step, profiles, providers);
    if (resolved) models[step.id] = toResolvedStepModel(resolved, connection);
    else unresolved.push(step);
  }
  return { models, unresolved };
}

/**
 * 案件の作成時のフローの写し（spec §4.2）: 工程ごとにモデルを解決して持つ。設定のプロファイルを後で変えても、
 * 既存の案件はこの値で再実行する。解決できない工程は持たない（実行時に「モデルが設定にありません」）。
 */
export function createFlowSnapshot(
  flow: Flow,
  profiles: readonly Profile[],
  providers: readonly ProviderId[],
  connection: Connection = "subscription",
): FlowSnapshot {
  const { models } = resolveFlowModels(flow, profiles, providers, connection);
  return {
    ...flow,
    transcription: flowHasTranscription(flow),
    steps: flow.steps.map((step) => ({ ...step })),
    terms: flow.terms.map((entry) => ({ ...entry, variants: [...entry.variants] })),
    samples: flow.samples.map((sample) => ({ ...sample })),
    models,
  };
}

/**
 * snapshot の解決済みのモデルを、実行時の方式で使う形にする（spec §4.2）。解決した方式（無ければサブスクリプション）が今の方式と
 * 同じならそのまま。違えば、同じプロファイル × 提供元を今の方式の表で解決し直す（実際に使うモデルは今の方式の値）。プロファイルが
 * 今の方式の表に無ければ null（「モデルが設定にありません」）。提供元が今の方式に登録されているかは呼ぶ側が確かめる（別の AI に
 * 寄せない）。
 */
export function snapshotModelFor(
  model: ResolvedStepModel,
  connection: Connection,
  profiles: readonly Profile[],
): ResolvedStepModel | null {
  if ((model.connection ?? "subscription") === connection) return model;
  const profile = profiles.find((candidate) => candidate.id === model.profileId);
  const resolved = profile?.models[model.provider];
  if (!profile || !resolved) return null;
  return {
    provider: model.provider,
    model: resolved.model,
    effort: fitEffort(model.provider, resolved.model, resolved.effort),
    profileId: profile.id,
    profileName: profile.name,
    ...(model.redirected ? { redirected: true } : {}),
    connection,
  };
}

/**
 * NIHO の API が開示する AI の提供元（`/api/me/docs-runs/api-access` の provider。`GOOGLE` など）→ 工程の provider。
 * どの AI かを名前で出すとき（「AIと作る」の送り先）に使う。NIHO の AI で工程を動かせるかは、この表より狭い
 * nihoApiProvider が決める（この表に足しても、NIHO の AI が受け付けるモデルは広がらない）。
 */
const DISCLOSED_PROVIDERS: ReadonlyMap<string, ProviderId> = new Map<string, ProviderId>([
  ["ANTHROPIC", "claude"],
  ["OPENAI", "gpt"],
  ["GOOGLE", "gemini"],
]);

/** 開示された提供元の名前（大文字・小文字は問わない）→ 工程の provider。知らない名前は null。 */
export function disclosedProvider(disclosed: string): ProviderId | null {
  return DISCLOSED_PROVIDERS.get(disclosed.toUpperCase()) ?? null;
}

/**
 * NIHO の AI（NIHO API）で工程を動かせる提供元。工程は Vertex AI の Gemini だけで動く（#18816）。送り先を増やすときは、API の
 * 受付（apps/api の DOCS_API_STEP_PROVIDER）と同意の版を一緒に変える。
 */
export const NIHO_API_STEP_PROVIDERS: readonly ProviderId[] = ["gemini"];

/** NIHO の AI の提供元（API の開示）→ 工程の provider。NIHO の AI で工程を動かせない提供元は null。 */
export function nihoApiProvider(disclosed: string): ProviderId | null {
  const provider = disclosedProvider(disclosed);
  return provider && NIHO_API_STEP_PROVIDERS.includes(provider) ? provider : null;
}

/** NIHO の AI で動かす工程の固定モデルのプロファイル名（表示用）。 */
export const NIHO_API_PROFILE_NAME = "NIHO API";

/** NIHO の API が開示する工程の AI（Web は api-access の provider・model、API は自分の定数）。 */
export type NihoApiDescriptor = { readonly provider: string; readonly model: string };

function nihoApiTarget(descriptor: NihoApiDescriptor): { provider: ProviderId; model: string } | null {
  const provider = nihoApiProvider(descriptor.provider);
  return provider && descriptor.model ? { provider, model: descriptor.model } : null;
}

/** NIHO の AI はモデルを固定し、思考量だけ工程の Gemini プロファイルから採る。 */
export function nihoApiStepEffort(step: { readonly profile: string }, profiles: readonly Profile[] = defaultProfiles("apiKey")): Effort {
  const standard = defaultProfiles("apiKey").find((profile) => profile.id === STANDARD_PROFILE_ID)?.models.gemini?.effort ?? "medium";
  return profiles.find((profile) => profile.id === step.profile)?.models.gemini?.effort ?? standard;
}

function nihoApiModelFor(target: { provider: ProviderId; model: string }, step: { readonly profile: string }, profiles?: readonly Profile[]): ResolvedStepModel {
  return {
    provider: target.provider,
    model: target.model,
    effort: nihoApiStepEffort(step, profiles),
    profileId: step.profile,
    profileName: NIHO_API_PROFILE_NAME,
    connection: "apiKey",
  };
}

/**
 * NIHO の AI（NIHO API）で動かす工程の固定モデル（新しい録音の固定と、Mac で作った録音の持ち替えで同じ形）。プロファイルは工程の
 * ものを残す（Mac へ持ち替えるときに同じプロファイルで解き直す）。提供元を NIHO の AI で動かせない・モデルが無ければ null。
 */
export function nihoApiStepModel(step: { readonly profile: string }, descriptor: NihoApiDescriptor, profiles?: readonly Profile[]): ResolvedStepModel | null {
  const target = nihoApiTarget(descriptor);
  return target ? nihoApiModelFor(target, step, profiles) : null;
}

/**
 * 工程を NIHO の AI で動かす固定情報にする（#18749）。モデルは渡した時点の NIHO の AI に工程ごと固定する。`flow` は浅く写す
 * （定数や読んだファイルを変えたくなければ、呼ぶ側が写しを渡す）。提供元を NIHO の AI で動かせない・モデルが無ければ null
 * （利用者向けの文は呼ぶ側が出す）。
 */
export function createNihoApiFlowSnapshot<F extends { readonly steps: readonly { readonly id: string; readonly profile: string }[] }>(
  flow: F,
  descriptor: NihoApiDescriptor,
  profiles?: readonly Profile[],
): (F & { models: Record<string, ResolvedStepModel> }) | null {
  const target = nihoApiTarget(descriptor);
  if (!target) return null;
  const models: Record<string, ResolvedStepModel> = {};
  for (const step of flow.steps) models[step.id] = nihoApiModelFor(target, step, profiles);
  return { ...flow, models };
}

/**
 * 工程の固定モデルが NIHO の AI と同じか（提供元とモデル。思考量は比べない＝API の受付と同じ）。固定が無い・NIHO の AI で
 * 動かせない提供元なら false。
 */
export function matchesNihoApi(
  model: { readonly provider?: string | null; readonly model?: string | null } | null | undefined,
  descriptor: NihoApiDescriptor,
): boolean {
  const target = nihoApiTarget(descriptor);
  return Boolean(target && model && model.provider === target.provider && model.model === target.model);
}

/**
 * 録音に固定した工程のモデルを NIHO の AI のモデルへ持ち替える分（#18749・#18927。Web の Mac で作った録音の続きと、Mac の
 * 「続きを NIHO に任せる」で同じ規則）。`stepIds` の工程のうち、固定モデルが NIHO の AI と違う（matchesNihoApi でない）工程だけの
 * NIHO の AI のモデル（nihoApiStepModel と同じ形）。持ち替えが要らなければ `{}`。提供元を NIHO の AI で動かせない・モデルが無ければ
 * null（利用者向けの文は呼ぶ側が出す）。フローに無い工程は入れない（呼ぶ側が先に確かめる）。
 */
export function nihoApiModelSwap(
  flow: {
    readonly steps: readonly { readonly id: string; readonly profile: string }[];
    readonly models: Readonly<Record<string, { readonly provider?: string | null; readonly model?: string | null } | undefined>>;
  },
  stepIds: readonly string[],
  descriptor: NihoApiDescriptor,
): Record<string, ResolvedStepModel> | null {
  const target = nihoApiTarget(descriptor);
  if (!target) return null;
  const swap: Record<string, ResolvedStepModel> = {};
  for (const stepId of stepIds) {
    const step = flow.steps.find((item) => item.id === stepId);
    if (!step || matchesNihoApi(flow.models[stepId], descriptor)) continue;
    swap[stepId] = nihoApiModelFor(target, step);
  }
  return swap;
}

/** snapshot の工程のモデルの名前（「標準 · Sonnet 4.6 · 高」）。 */
export function snapshotModelLabel(model: ResolvedStepModel): string {
  return `${model.profileName} · ${shortModelLabel(model.provider, model.model)} · ${effortLabel(model.effort)}`;
}

/**
 * 案件の snapshot で、登録していない AI に解決済みの工程（作成後にその AI の登録を外した）。勝手に別の AI で実行せず、
 * 「この案件の工程を今の設計に更新」で解決し直すまで止める。
 */
export function unregisteredSnapshotSteps(snapshot: FlowSnapshot, providers: readonly ProviderId[]): Step[] {
  return snapshot.steps.filter((step) => {
    const model = snapshot.models?.[step.id];
    return model !== undefined && !providers.includes(model.provider);
  });
}

/** 工程の AI が登録されていないときの文（他社の名前は出さない）。 */
export const UNREGISTERED_PROVIDER_MESSAGE =
  "この工程の AI は登録されていません。録音の「この録音の工程を今の設計に更新」で、登録した AI に切り替えてから実行してください。";

/** 案件を作ったときと方式が違い、工程の AI が今の方式に登録されていないときの文（別の AI に寄せずに止める）。 */
export const UNREGISTERED_IN_CONNECTION_MESSAGE =
  "この工程の AI は今の接続方式に登録されていません。設定 › 接続設定で登録するか、録音の「この録音の工程を今の設計に更新」で登録した AI に切り替えてから実行してください。";

/** 工程が指す AI が登録されていないので先頭へ寄せたときの 1 行（工程設計の工程カード・実行の行）。 */
export function redirectedNote(provider: ProviderId): string {
  return `選んでいた AI が登録されていないため、${providerLabel(provider)} で実行します`;
}
