import {
  contractProvider,
  effortRule,
  modelOptions,
  type Connection,
  type Effort,
  type ProviderId,
  type ProviderStatus,
  type ResolvedStepModel,
} from "@niho/docs-core";

export type PersonalSubscriptionEntitlement = {
  /** 旧保存値との互換用。本人サブスクの契約名は実行条件にせず、取得不能でも推測表示しない。 */
  planConfirmed: boolean;
  /** provider が返す残量。取得不能は unknown のまま実行でき、判明した枯渇だけを止める。 */
  usage: "available" | "depleted" | "unknown";
};

export type PersonalProviderReadiness =
  | { ready: true; provider: ProviderId; connection: Connection; model: string; effort: Effort; usage: "available" | "unknown" }
  | {
      ready: false;
      code:
        | "connection_not_subscription"
        | "status_unavailable"
        | "not_installed"
        | "not_authenticated"
        | "cli_unsupported"
        | "model_unavailable"
        | "usage_depleted";
      message: string;
    };

type PersonalModelIdentity = Pick<ResolvedStepModel, "provider" | "model" | "effort">;

function normalizedReportedModel(model: PersonalModelIdentity, reported: string): { model: string; effort: Effort } {
  if (model.provider !== "gemini") return { model: reported, effort: model.effort };
  const suffix = /^(.*)-(low|medium|high)$/.exec(reported);
  return suffix
    ? { model: suffix[1]!, effort: suffix[2] as Effort }
    : { model: reported, effort: model.effort };
}

/** Antigravity の base model + effort と末尾 effort 付き ID を同じ固定モデルとして照合する。 */
export function personalReportedModelMatches(model: PersonalModelIdentity, reported: string): boolean {
  const expected = normalizedReportedModel(model, model.model);
  const actual = normalizedReportedModel(model, reported);
  return expected.model === actual.model && expected.effort === actual.effort;
}

function listedModel(status: ProviderStatus, model: ResolvedStepModel, connection: Connection): boolean {
  // Claude Code に model 列挙 API はない。設定画面と同じ固定候補一覧で照合する。
  if (model.provider === "claude" && connection === "subscription") return modelOptions("claude", status.models, connection).some((option) => option.id === model.model);
  return status.models.some((reported) => personalReportedModelMatches(model, reported));
}

/**
 * R6 の本人接続で、画面表示と送信直前ガードが共有する fail-closed 判定。
 * 接続方式は端末の明示選択を使う。本人サブスクは provider が返せない契約名・残量を推測表示せず、unknown のまま
 * 実行できる。判明した枯渇だけを止める。API キーは契約確認を求めず、API 用 provider の認証・モデル・effortを検査する。
 */
export function personalProviderReadiness(input: {
  connection: Connection;
  model: ResolvedStepModel;
  status: ProviderStatus | null;
  entitlement: PersonalSubscriptionEntitlement;
}): PersonalProviderReadiness {
  const { connection, model, status, entitlement } = input;
  // 録音へ固定するのは provider/model/effort。接続方式はこの端末で本人が明示選択した値を使い、別端末で保存された
  // model.connection を実行条件にしない（自動切替はせず、下で選択中の方式に対応する provider status を検査する）。
  if (!status) {
    return { ready: false, code: "status_unavailable", message: "AI の接続状態を確認できません。ネットワークを確かめて、もう一度確認してください。" };
  }
  if (!status.installed) {
    return { ready: false, code: "not_installed", message: "この AI の CLI が見つかりません。設定の案内に沿って導入してください。" };
  }
  if (!status.authenticated) {
    return { ready: false, code: "not_authenticated", message: "この AI にログインしてから、もう一度確認してください。" };
  }
  if (connection === "subscription" && /api[\s_-]*key/i.test(status.login_method ?? "")) {
    return { ready: false, code: "connection_not_subscription", message: "この CLI は API キーで認証されています。本人のサブスクリプションでログインし直してください。" };
  }
  if (status.reason !== null || status.missing_cli_flags.length > 0 || !status.capabilities.tools_off_proven) {
    return {
      ready: false,
      code: "cli_unsupported",
      message: "この CLI は必要な実行方式に対応していません。最新版へ更新してから、もう一度確認してください。",
    };
  }
  if (!effortRule(model.provider, model.model).efforts.includes(model.effort) || !listedModel(status, model, connection)) {
    return {
      ready: false,
      code: "model_unavailable",
      message: "固定したモデルをこの接続で利用できることを確認できません。モデル一覧を更新してから、もう一度実行してください。",
    };
  }
  if (connection === "subscription" && entitlement.usage === "depleted") {
    return {
      ready: false,
      code: "usage_depleted",
      message: "この AI の利用上限に達しています。上限が戻ってから、もう一度実行してください。",
    };
  }
  return {
    ready: true,
    provider: model.provider,
    connection,
    model: model.model,
    effort: model.effort,
    usage: entitlement.usage === "available" ? "available" : "unknown",
  };
}

/** 実行直前に provider_status を取り直し、上の共通判定を通す。拒否理由はそのまま利用者向けに返す。 */
export async function assertPersonalProviderReady(input: {
  connection: Connection;
  model: ResolvedStepModel;
  entitlement: PersonalSubscriptionEntitlement;
  providerStatus: (provider: ReturnType<typeof contractProvider>) => Promise<ProviderStatus>;
}): Promise<ProviderStatus> {
  let status: ProviderStatus | null = null;
  try {
    status = await input.providerStatus(contractProvider(input.model.provider, input.connection));
  } catch {
    // 共通判定で、UI と同じ復旧文へまとめる。
  }
  const readiness = personalProviderReadiness({
    connection: input.connection,
    model: input.model,
    status,
    entitlement: input.entitlement,
  });
  if (!readiness.ready) throw new PersonalProviderReadinessError(readiness.code, readiness.message);
  return status!;
}

export class PersonalProviderReadinessError extends Error {
  constructor(
    readonly code: Exclude<PersonalProviderReadiness, { ready: true }>["code"],
    message: string,
  ) {
    super(message);
    this.name = "PersonalProviderReadinessError";
  }
}
