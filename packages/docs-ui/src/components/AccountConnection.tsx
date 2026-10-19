"use client";

import { useState } from "react";
import type { DocsAccount as NihoAccount } from "../host/DocsAccount";
import { AccountPopover } from "niho-ui/components/account-popover";
import { logoutWithConfirm } from "./AccountDialogLayer";

/** 認証は共通フックに任せ、設定にはアカウントの部品だけを置く。AI の接続・実行とは独立。NIHO docs は単体で完結させ、マイページへの導線は置かない。 */
export function AccountConnection({ account }: { account: NihoAccount }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <div className="cb docs-account" ref={setContainer}>
      <div className="docs-account-row">
        <div>
          <h3>NIHO アカウント</h3>
          <p className="help">NIHO docs はログインして使います。ページとフォルダはクラウドに保存し、別の Mac やスマホからも開けます。</p>
        </div>
        <AccountPopover
          state={account.state}
          avatarSrc={account.avatarSrc}
          busy={account.busy}
          lang="ja"
          onBeginLogin={account.beginLogin}
          onCancelLogin={account.cancelLogin}
          onLogout={() => void logoutWithConfirm(account)}
          container={container}
          className="docs-account-popover"
          align="end"
        />
      </div>
    </div>
  );
}
