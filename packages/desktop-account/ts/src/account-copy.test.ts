import { describe, expect, it } from "vitest";

import { ACCOUNT_TOAST_COPY, accountErrorMessage, SILENT_ERROR_CODES } from "./account-copy";

describe("accountErrorMessage", () => {
  it("maps the spec failure table to Japanese and English", () => {
    expect(accountErrorMessage({ code: "code_expired" }, "ja")).toBe(
      "時間切れです。もう一度「NIHO でログイン」を押してください。",
    );
    expect(accountErrorMessage({ code: "network" }, "ja")).toBe(
      "ネットに接続できません。接続してから「NIHO でログイン」をやり直してください。",
    );
    expect(accountErrorMessage({ code: "keychain_write_failed" }, "ja")).toBe(
      "この Mac に保存できませんでした。もう一度お試しください。",
    );
    expect(accountErrorMessage({ code: "account_unavailable" }, "ja")).toBe("このアカウントは使えません。");
    expect(accountErrorMessage({ code: "connect_disabled" }, "ja")).toBe("いまは接続できません。");
    expect(accountErrorMessage({ code: "login_not_pending" }, "ja")).toBe("ログインを始めからやり直してください。");
    expect(accountErrorMessage({ code: "session_revoked" }, "ja")).toBe("ログインをやり直してください。");
    expect(accountErrorMessage({ code: "code_expired" }, "en")).toContain("Sign in with NIHO");
    // L6: 「ほかの端末でもログアウトする」の失敗（spec §画面「ログアウトの確認」）
    expect(accountErrorMessage({ code: "sign_out_everywhere_failed" }, "ja")).toBe(
      "ほかの端末をログアウトできませんでした。通信を確かめて、もう一度お試しください。",
    );
    expect(accountErrorMessage({ code: "sign_out_everywhere_failed" }, "en")).toBe(
      "Couldn't sign out your other devices. Check your connection and try again.",
    );
    // 保存先は app data のファイル（spec D-16 改）。Keychain の文言を出さない
    for (const lang of ["ja", "en"] as const) {
      for (const code of ["keychain_read_failed", "keychain_write_failed", "keychain_delete_failed"]) {
        expect(accountErrorMessage({ code }, lang)).not.toMatch(/キーチェーン|Keychain/);
      }
    }
  });

  it("stays silent for the codes the spec does not show", () => {
    expect([...SILENT_ERROR_CODES]).toEqual(["callback_duplicate", "callback_state_mismatch", "callback_cancelled"]);
    for (const code of SILENT_ERROR_CODES) {
      expect(accountErrorMessage({ code, message: "x" }, "ja")).toBeNull();
      expect(accountErrorMessage({ code, message: "x" }, "en")).toBeNull();
    }
  });

  it("falls back to the Rust message in Japanese and to a generic line otherwise", () => {
    expect(accountErrorMessage({ code: "new_code", message: "新しい文。" }, "ja")).toBe("新しい文。");
    expect(accountErrorMessage({ code: "new_code", message: "新しい文。" }, "en")).toBe(
      "Something went wrong. Please try again.",
    );
    expect(accountErrorMessage({ code: "new_code" }, "ja")).toBe("予期しないエラーが起きました。もう一度お試しください。");
  });

  it("has neutral toasts without app names", () => {
    expect(ACCOUNT_TOAST_COPY.ja).toEqual({
      signedIn: "ログインしました",
      signedOut: "ログアウトしました",
      signedOutEverywhere: "ほかの端末でもログアウトしました",
    });
    expect(ACCOUNT_TOAST_COPY.en.signedOutEverywhere).toBe("Signed out on all devices");
    for (const lang of ["ja", "en"] as const) {
      for (const text of Object.values(ACCOUNT_TOAST_COPY[lang])) {
        expect(text).not.toMatch(/camera|docs|ようこそ/i);
      }
    }
  });
});
