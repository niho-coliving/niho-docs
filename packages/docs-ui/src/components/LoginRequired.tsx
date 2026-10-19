"use client";

import type { ReactNode } from "react";
import type { DocsAccount as NihoAccount } from "../host/DocsAccount";
import { AccountPopoverContent } from "niho-ui/components/account-popover";
import { logoutWithConfirm } from "./AccountDialogLayer";
import { FailureBand, type Failure } from "./FailureBand";

/**
 * ログインするまでページを開かない画面。保存先の選択はログイン後に確認する。
 * `updateNotice` は自動更新の案内（UpdateNotice。起動の失敗の画面と同じく、更新しないとログインできない版でも上げられる。#18788）。
 */
export function LoginRequired({ account, updateNotice, failure, onDismissFailure, reopeningPending = false }: {
  account: NihoAccount;
  updateNotice?: ReactNode;
  failure?: Failure | null;
  onDismissFailure?: () => void;
  reopeningPending?: boolean;
}) {
  return (
    <div className="app solo">
      <div className="empty login-required">
        <h1>NIHO アカウントでログイン</h1>
        <p className="msg">
          {reopeningPending
            ? "保存先の変更が途中です。ログインしてこの Mac の内容を照合し、移行を完了してください。"
            : "NIHO docs のページと音声を使うには、NIHO アカウントでログインしてください。"}
        </p>
        <p className="help">
          {reopeningPending
            ? "移行が完了するまで、この Mac の文書は開けません。"
            : "保存先をまだ選んでいない場合は、ログイン後に「NIHO クラウド」か「この Mac だけ」を選べます。"}
        </p>
        <div className="docs-account login-required-account">
          <AccountPopoverContent
            state={account.state}
            avatarSrc={account.avatarSrc}
            busy={account.busy}
            lang="ja"
            onBeginLogin={() => void account.beginLogin()}
            onCancelLogin={() => void account.cancelLogin()}
            onLogout={() => void logoutWithConfirm(account)}
          />
        </div>
        {failure && <FailureBand message={failure.text} action={failure.action} onDismiss={onDismissFailure} />}
        {updateNotice}
      </div>
    </div>
  );
}
