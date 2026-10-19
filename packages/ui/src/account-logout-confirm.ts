import { appDialog } from "./app-dialog";

/**
 * NIHO アカウントのログアウトの確認（specs/initiatives/niho-account-desktop-login.md §画面「ログアウトの確認」・D-3 改・D-17）。
 *
 * Mac 版の NIHO docs（`niho-desktop-account` の `useNihoAccount`）と NIHO docs の Web/PWA が同じ部品・同じ文言を使う。
 * - 見出し「ログアウトしますか？」・確定「ログアウトする」（破壊的な操作ではないので danger にしない）・取り消し「キャンセル」。
 * - API を呼べる状態（ログイン済み）のときだけ、チェックの欄「ほかの端末でもログアウトする」（既定はオフ）と補足を出す。
 *   オフライン・期限切れでは見出しと確定だけ（手元のログアウト）。
 * - Web 版で保存していない変更があるときは、同じ確認の本文（`extraDescription`）にその注意を足し、確認を 2 回に分けない。
 * - 押したあとの二重実行は呼び出し側の busy で防ぐ。失敗・成功の文言も同じ表（`ACCOUNT_LOGOUT_COPY`）に置く。
 */

export type AccountLogoutLang = "ja" | "en";

export type AccountLogoutCopy = {
  title: string;
  everywhereLabel: string;
  everywhereDescription: string;
  confirm: string;
  cancel: string;
  /** 「ほかの端末でもログアウトする」に失敗した（この端末はログアウトしない） */
  everywhereFailed: string;
  /** 「ほかの端末でもログアウトする」の成功のトースト */
  everywhereSucceeded: string;
  /** 選ばなかったときの成功のトースト（従来の文） */
  signedOut: string;
};

export const ACCOUNT_LOGOUT_COPY: Record<AccountLogoutLang, AccountLogoutCopy> = {
  ja: {
    title: "ログアウトしますか？",
    everywhereLabel: "ほかの端末でもログアウトする",
    everywhereDescription: "NIHO のサイトとアプリも、ほかの端末ではログインし直しになります。",
    confirm: "ログアウトする",
    cancel: "キャンセル",
    everywhereFailed: "ほかの端末をログアウトできませんでした。通信を確かめて、もう一度お試しください。",
    everywhereSucceeded: "ほかの端末でもログアウトしました",
    signedOut: "ログアウトしました",
  },
  en: {
    title: "Sign out?",
    everywhereLabel: "Also sign out on other devices",
    everywhereDescription: "You'll need to sign in again to NIHO's website and apps on your other devices.",
    confirm: "Sign out",
    cancel: "Cancel",
    everywhereFailed: "Couldn't sign out your other devices. Check your connection and try again.",
    everywhereSucceeded: "Signed out on all devices",
    signedOut: "Signed out",
  },
};

export type ConfirmAccountLogoutOptions = {
  lang?: AccountLogoutLang;
  /** API を呼べる状態（ログイン済み）なら true。false（オフライン・期限切れ）ならチェックの欄を出さない */
  allowEverywhere: boolean;
  /** 本文に足す注意（Web 版の保存していない変更など） */
  extraDescription?: string;
};

/** 確定で `{ everywhere }`（チェックの欄を出さなかったときは false）、キャンセル・閉じるで null。 */
export type AccountLogoutChoice = { everywhere: boolean } | null;

export async function confirmAccountLogout(options: ConfirmAccountLogoutOptions): Promise<AccountLogoutChoice> {
  const copy = ACCOUNT_LOGOUT_COPY[options.lang ?? "ja"];
  const description = options.extraDescription?.trim() ? options.extraDescription : undefined;
  if (!options.allowEverywhere) {
    const confirmed = await appDialog.confirm({
      title: copy.title,
      description,
      confirmLabel: copy.confirm,
      cancelLabel: copy.cancel,
    });
    return confirmed ? { everywhere: false } : null;
  }
  const result = await appDialog.confirmWithCheckbox({
    title: copy.title,
    description,
    confirmLabel: copy.confirm,
    cancelLabel: copy.cancel,
    checkbox: { label: copy.everywhereLabel, description: copy.everywhereDescription },
  });
  return result ? { everywhere: result.checked } : null;
}
