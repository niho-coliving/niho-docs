/**
 * NIHO アカウントの、状態の変化とエラーの文言（ja / en。spec「画面」のアプリの表）。popover の中の文言は `niho-ui` の
 * `AccountPopover` が持つ（部品と一緒に置く）。ここはトーストと、Rust の `AccountError.code` → 利用者向けの文。
 * アプリ固有の文言は無い（決まりごと 7）。
 */

export type AccountLang = "ja" | "en";

export type AccountToastCopy = {
  signedIn: string;
  signedOut: string;
  /** 「ほかの端末でもログアウトする」を選んだときの成功（spec §画面「ログアウトの確認」。`niho-ui` の `ACCOUNT_LOGOUT_COPY` と同じ文） */
  signedOutEverywhere: string;
};

export const ACCOUNT_TOAST_COPY: Record<AccountLang, AccountToastCopy> = {
  ja: {
    signedIn: "ログインしました",
    signedOut: "ログアウトしました",
    signedOutEverywhere: "ほかの端末でもログアウトしました",
  },
  en: {
    signedIn: "Signed in",
    signedOut: "Signed out",
    signedOutEverywhere: "Signed out on all devices",
  },
};

/**
 * Rust の `AccountError.code`（`error::code`）→ 文。表に無い code は Rust の `message`（日本語）か汎用の文。
 * `callback_duplicate` / `callback_state_mismatch` は画面に出さない（spec「失敗の分岐」: ログだけ）。
 */
const ERROR_COPY: Record<AccountLang, Record<string, string>> = {
  ja: {
    code_expired: "時間切れです。もう一度「NIHO でログイン」を押してください。",
    code_invalid: "ログインを始めからやり直してください。",
    login_not_pending: "ログインを始めからやり直してください。",
    callback_invalid: "ログインを始めからやり直してください。",
    session_revoked: "ログインをやり直してください。",
    account_unavailable: "このアカウントは使えません。",
    connect_disabled: "いまは接続できません。",
    rate_limited: "しばらくしてからもう一度お試しください。",
    network: "ネットに接続できません。接続してから「NIHO でログイン」をやり直してください。",
    service_unavailable: "接続できません。しばらくしてからもう一度お試しください。",
    sign_in_failed: "接続できません。しばらくしてからもう一度お試しください。",
    keychain_write_failed: "この Mac に保存できませんでした。もう一度お試しください。",
    keychain_read_failed: "この Mac に保存したログインの情報を読めませんでした。もう一度お試しください。",
    keychain_delete_failed: "この Mac からログインの情報を消せませんでした。もう一度お試しください。",
    sign_out_everywhere_failed: "ほかの端末をログアウトできませんでした。通信を確かめて、もう一度お試しください。",
    storage_failed: "この Mac に保存できませんでした。もう一度お試しください。",
    expired: "ログインの期限が切れました。もう一度ログインしてください。",
    offline: "オフラインです。接続すると自動で続けます。",
    browser_failed: "ブラウザを開けませんでした。もう一度お試しください。",
    busy: "ほかの操作が終わるまでお待ちください。",
    signed_out: "ログインしていません。",
    profile_failed: "プロフィールを取り直せませんでした。",
    unknown: "予期しないエラーが起きました。もう一度お試しください。",
  },
  en: {
    code_expired: "That took too long. Press “Sign in with NIHO” again.",
    code_invalid: "Please start signing in again.",
    login_not_pending: "Please start signing in again.",
    callback_invalid: "Please start signing in again.",
    session_revoked: "Please sign in again.",
    account_unavailable: "This account can’t be used.",
    connect_disabled: "Signing in isn’t available right now.",
    rate_limited: "Please try again in a little while.",
    network: "No internet connection. Connect and press “Sign in with NIHO” again.",
    service_unavailable: "Couldn’t connect. Please try again in a little while.",
    sign_in_failed: "Couldn’t connect. Please try again in a little while.",
    keychain_write_failed: "Couldn’t save to this Mac. Please try again.",
    keychain_read_failed: "Couldn’t read the sign-in saved on this Mac. Please try again.",
    keychain_delete_failed: "Couldn’t remove the sign-in from this Mac. Please try again.",
    sign_out_everywhere_failed: "Couldn't sign out your other devices. Check your connection and try again.",
    storage_failed: "Couldn’t save to this Mac. Please try again.",
    expired: "Your sign-in has expired. Please sign in again.",
    offline: "You’re offline. We’ll continue once you’re connected.",
    browser_failed: "Couldn’t open the browser. Please try again.",
    busy: "Please wait for the current action to finish.",
    signed_out: "You’re not signed in.",
    profile_failed: "Couldn’t update the profile.",
    unknown: "Something went wrong. Please try again.",
  },
};

/** 画面に出さない code（spec: 何も表示しない。ログだけ）。 */
export const SILENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "callback_duplicate",
  "callback_state_mismatch",
  "callback_cancelled",
]);

export function accountErrorMessage(error: { code: string; message?: string }, lang: AccountLang): string | null {
  if (SILENT_ERROR_CODES.has(error.code)) return null;
  const known = ERROR_COPY[lang][error.code];
  if (known) return known;
  if (lang === "ja" && error.message && error.message.trim().length > 0) return error.message ?? null;
  return ERROR_COPY[lang].unknown ?? null;
}
