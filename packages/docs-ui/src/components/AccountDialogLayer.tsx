"use client";

import { useState, useSyncExternalStore } from "react";
import { getAppDialogSnapshot, subscribeAppDialogRequests, type AppDialogSnapshot } from "niho-ui/app-dialog";
import { AppDialogHost } from "niho-ui/components/app-dialog-host";
import { confirmAccountLogout } from "niho-ui/account-logout-confirm";
import type { DocsAccount as NihoAccount } from "../host/DocsAccount";

const NO_DIALOG: AppDialogSnapshot = { active: null, shown: null };

/**
 * 共通の確認（`niho-ui` の `appDialog`。ログアウトの確認など）を描く先（L6 #18558）。
 *
 * docs の Tailwind の utilities は `.docs-account` の中に閉じている（account.css・postcss.config.cjs）ので、共通の `ConfirmDialog` を
 * その中に描く。`.docs-account` は確認を一度でも出したあとだけ付ける（設定の「接続設定」の欄の有無を `.docs-account` で見ている画面を
 * 変えない）。起動中・ログイン画面でも出せるように、App の画面の分岐の外に置く。
 */
export function AccountDialogLayer() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const { shown } = useSyncExternalStore(subscribeAppDialogRequests, getAppDialogSnapshot, () => NO_DIALOG);
  return (
    <>
      <div ref={setContainer} className={shown ? "docs-account docs-dialog-layer" : "docs-dialog-layer"} />
      <AppDialogHost container={container} />
    </>
  );
}

/**
 * 「ログアウト」: 共通の確認（「ほかの端末でもログアウトする」はログイン済みのときだけ）→ `account.logout({ everywhere })`。
 * 成功・失敗のトーストは `useNihoAccount` の `notice`（失敗ならこの Mac はログイン済みのまま）。確認を描く先が無いとき（通常は
 * 起きない）は、従来どおりこの Mac だけログアウトする。
 */
export async function logoutWithConfirm(account: Pick<NihoAccount, "state" | "busy" | "logout">): Promise<void> {
  if (account.busy) return;
  let choice: { everywhere: boolean } | null;
  try {
    choice = await confirmAccountLogout({ lang: "ja", allowEverywhere: account.state?.kind === "signedIn" });
  } catch {
    choice = { everywhere: false };
  }
  if (!choice) return;
  await account.logout({ everywhere: choice.everywhere });
}
