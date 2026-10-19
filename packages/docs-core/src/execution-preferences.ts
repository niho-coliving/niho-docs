/**
 * NIHO docs の本人共通の実行先（profile の execution.json）。
 * 資格情報・接続方式・AI の登録は含めず、続きの場所と自分の Mac の宛先だけを持つ。
 */
export const EXECUTION_PREFERENCES_VERSION = 1 as const;

export type ExecutionRoute = "cloud" | "own_mac";

export type ExecutionPreferences = {
  version: typeof EXECUTION_PREFERENCES_VERSION;
  route: ExecutionRoute;
  /** `own_mac` の宛先。無い値は宛先未選択として実行を止める。 */
  preferredMacRunnerId: string | null;
};

export const DEFAULT_EXECUTION_PREFERENCES: ExecutionPreferences = {
  version: EXECUTION_PREFERENCES_VERSION,
  route: "cloud",
  preferredMacRunnerId: null,
};

const RUNNER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** 壊れた・未知の版は安全な既定（クラウド）として読む。legacy の端末設定は移行しない。 */
export function parseExecutionPreferences(value: unknown): ExecutionPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...DEFAULT_EXECUTION_PREFERENCES };
  const record = value as Record<string, unknown>;
  if (record.version !== EXECUTION_PREFERENCES_VERSION || (record.route !== "cloud" && record.route !== "own_mac")) {
    return { ...DEFAULT_EXECUTION_PREFERENCES };
  }
  const preferredMacRunnerId = typeof record.preferredMacRunnerId === "string" && RUNNER_ID.test(record.preferredMacRunnerId)
    ? record.preferredMacRunnerId
    : null;
  return {
    version: EXECUTION_PREFERENCES_VERSION,
    route: record.route,
    preferredMacRunnerId: record.route === "own_mac" ? preferredMacRunnerId : null,
  };
}

export function executionPreferencesEqual(left: ExecutionPreferences, right: ExecutionPreferences): boolean {
  return left.route === right.route && left.preferredMacRunnerId === right.preferredMacRunnerId;
}
