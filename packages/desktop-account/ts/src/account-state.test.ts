import { describe, expect, it } from "vitest";

import { accountProfileOf, parseAccountError, parseAccountState } from "./account-state";

const profile = { userId: "u1", displayName: "たくや", handle: "takuya", avatarPath: "/x/account-avatar.jpg", connectionId: "c1" };

describe("parseAccountState", () => {
  it("reads every state the Rust crate emits", () => {
    expect(parseAccountState({ kind: "signedOut" })).toEqual({ kind: "signedOut" });
    expect(parseAccountState({ kind: "signingIn", sinceMs: 1 })).toEqual({ kind: "signingIn", sinceMs: 1 });
    expect(parseAccountState({ kind: "signedIn", profile })).toEqual({ kind: "signedIn", profile });
    expect(parseAccountState({ kind: "offline", profile })).toEqual({ kind: "offline", profile });
    expect(parseAccountState({ kind: "expired", profile, reason: "sessionRevoked" })).toEqual({
      kind: "expired",
      profile,
      reason: "sessionRevoked",
    });
    expect(parseAccountState({ kind: "expired", profile, reason: "connectionRevoked" })?.kind).toBe("expired");
  });

  it("normalizes empty handle and avatar to null", () => {
    const parsed = parseAccountState({ kind: "signedIn", profile: { ...profile, handle: null, avatarPath: null } });
    expect(parsed).toEqual({ kind: "signedIn", profile: { ...profile, handle: null, avatarPath: null } });
    const empty = parseAccountState({ kind: "signedIn", profile: { ...profile, handle: "", avatarPath: "" } });
    expect(accountProfileOf(empty)?.handle).toBeNull();
    expect(accountProfileOf(empty)?.avatarPath).toBeNull();
  });

  it("rejects unknown kinds and broken profiles instead of throwing", () => {
    expect(parseAccountState(null)).toBeNull();
    expect(parseAccountState("signedIn")).toBeNull();
    expect(parseAccountState({ kind: "whatever" })).toBeNull();
    expect(parseAccountState({ kind: "signedIn" })).toBeNull();
    expect(parseAccountState({ kind: "signedIn", profile: { userId: 1 } })).toBeNull();
    expect(parseAccountState({ kind: "expired", profile: { ...profile, displayName: 3 }, reason: "x" })).toBeNull();
  });

  it("never carries a token", () => {
    const parsed = parseAccountState({ kind: "signedIn", profile: { ...profile, idToken: "secret" } });
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });
});

describe("parseAccountError", () => {
  it("reads the Rust error and falls back to unknown", () => {
    expect(parseAccountError({ code: "code_expired", message: "時間切れです。" })).toEqual({
      code: "code_expired",
      message: "時間切れです。",
    });
    expect(parseAccountError(new Error("boom"))).toEqual({ code: "unknown", message: "" });
    expect(parseAccountError("string")).toEqual({ code: "unknown", message: "" });
  });
});
