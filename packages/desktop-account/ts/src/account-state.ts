/**
 * NIHO アカウントの状態（Rust の `niho_desktop_account::AccountState` の JSON と同じ形）。画面は token を受け取らない
 * （spec 決まりごと 11）。受け取るのは状態とプロフィールだけ。
 */

export type AccountProfile = {
  userId: string;
  /** 空なら画面が「NIHO アカウント」などで補う */
  displayName: string;
  handle: string | null;
  /** この Mac に保存した顔写真のパス（`convertFileSrc` で出す）。無ければ null */
  avatarPath: string | null;
  connectionId: string;
};

export type AccountExpiredReason = "connectionRevoked" | "sessionRevoked";

export type AccountState =
  | { kind: "signedOut" }
  | { kind: "signingIn"; sinceMs: number }
  | { kind: "signedIn"; profile: AccountProfile }
  | { kind: "offline"; profile: AccountProfile }
  | { kind: "expired"; profile: AccountProfile; reason: AccountExpiredReason };

export type AccountStateKind = AccountState["kind"];

/** Rust の `AccountError`（`{ code, message }`）。`message` は利用者向けの日本語。 */
export type AccountError = { code: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseProfile(value: unknown): AccountProfile | null {
  if (!isRecord(value)) return null;
  const { userId, displayName, handle, avatarPath, connectionId } = value;
  if (typeof userId !== "string" || typeof connectionId !== "string") return null;
  if (typeof displayName !== "string") return null;
  if (handle !== null && handle !== undefined && typeof handle !== "string") return null;
  if (avatarPath !== null && avatarPath !== undefined && typeof avatarPath !== "string") return null;
  return {
    userId,
    displayName,
    handle: typeof handle === "string" && handle.length > 0 ? handle : null,
    avatarPath: typeof avatarPath === "string" && avatarPath.length > 0 ? avatarPath : null,
    connectionId,
  };
}

/** event / command の payload を確かめて読む。形が違えば null（画面は前の状態のまま）。 */
export function parseAccountState(value: unknown): AccountState | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "signedOut":
      return { kind: "signedOut" };
    case "signingIn": {
      const sinceMs = typeof value.sinceMs === "number" && Number.isFinite(value.sinceMs) ? value.sinceMs : 0;
      return { kind: "signingIn", sinceMs };
    }
    case "signedIn":
    case "offline": {
      const profile = parseProfile(value.profile);
      return profile ? { kind: value.kind, profile } : null;
    }
    case "expired": {
      const profile = parseProfile(value.profile);
      if (!profile) return null;
      const reason: AccountExpiredReason = value.reason === "sessionRevoked" ? "sessionRevoked" : "connectionRevoked";
      return { kind: "expired", profile, reason };
    }
    default:
      return null;
  }
}

/** command の失敗（Tauri は Rust の `Err` をそのまま投げる）を読む。形が違えば `unknown`。 */
export function parseAccountError(value: unknown): AccountError {
  if (isRecord(value) && typeof value.code === "string" && typeof value.message === "string") {
    return { code: value.code, message: value.message };
  }
  return { code: "unknown", message: "" };
}

/** プロフィールを持つ状態か。 */
export function accountProfileOf(state: AccountState | null): AccountProfile | null {
  if (!state) return null;
  return state.kind === "signedIn" || state.kind === "offline" || state.kind === "expired" ? state.profile : null;
}
