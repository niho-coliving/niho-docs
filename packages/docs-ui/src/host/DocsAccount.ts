/** アカウントの表示と操作。token・通信・OAuth はホストの中に閉じる。 */
export type DocsAccountProfile = {
  userId: string;
  displayName: string;
  handle: string | null;
  avatarPath: string | null;
  connectionId: string;
};
export type DocsAccountState =
  | { kind: "signedOut" }
  | { kind: "signingIn"; sinceMs: number }
  | { kind: "signedIn" | "offline"; profile: DocsAccountProfile }
  | { kind: "expired"; profile: DocsAccountProfile; reason: "connectionRevoked" | "sessionRevoked" };
export type DocsAccount = {
  state: DocsAccountState | null;
  avatarSrc: string | null;
  busy: "beginLogin" | "cancelLogin" | "logout" | "openMyPage" | null;
  notice: { kind: "signedIn" | "signedOut" | "error"; message: string; code?: string } | null;
  dismissNotice: () => void;
  beginLogin: () => Promise<void>;
  cancelLogin: () => Promise<void>;
  logout: (options?: { everywhere?: boolean }) => Promise<boolean>;
  openMyPage: () => Promise<void>;
};
export function accountProfileOf(state: DocsAccountState | null): DocsAccountProfile | null {
  return state && "profile" in state ? state.profile : null;
}
