"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { UserRound, WifiOff, CircleAlert } from "lucide-react";

import { cn } from "../cn";

/**
 * NIHO アカウントの丸いボタン（窓の右上。人型か顔写真）。押すと `AccountPopover` が開く。
 * アイコンだけなので accessible name は「アカウント」（spec「共通モジュール」・design-guide §6）。状態はこの部品の色でなく、
 * 小さな印（オフライン＝電波なし・期限切れ＝！）と popover の文で伝える（design-guide §3「色だけで状態を伝えない」）。
 * Tauri を呼ばない。NIHO camera・NIHO docs が同じ部品を置く（Epic #18551 L3 #18555）。
 */
export type AccountButtonState = "unknown" | "signedOut" | "signingIn" | "signedIn" | "offline" | "expired";

export type AccountButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  state?: AccountButtonState;
  /** 顔写真（この Mac のファイルを `convertFileSrc` した URL）。無ければ人型 */
  avatarSrc?: string | null;
  /** title に出す名前（読み上げ名は「アカウント」のまま） */
  displayName?: string | null;
  lang?: "ja" | "en";
};

export const ACCOUNT_BUTTON_LABEL = { ja: "アカウント", en: "Account" } as const;

export const AccountButton = forwardRef<HTMLButtonElement, AccountButtonProps>(function AccountButton(
  { state = "unknown", avatarSrc, displayName, lang = "ja", className, type = "button", ...props },
  ref,
) {
  const showAvatar = Boolean(avatarSrc) && state !== "signedOut" && state !== "signingIn";
  const badge = state === "offline" ? "offline" : state === "expired" ? "expired" : null;
  return (
    <button
      ref={ref}
      type={type}
      aria-label={ACCOUNT_BUTTON_LABEL[lang]}
      title={displayName && displayName.length > 0 && showAvatar ? displayName : undefined}
      data-account-state={state}
      className={cn(
        "relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-niho-border bg-white/80 text-niho-text-sub transition",
        "hover:bg-niho-pale/60 hover:text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink active:scale-[0.97] motion-reduce:transition-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {showAvatar ? (
        // Tauri の asset: URL（この Mac のファイル）。Next の Image は使わない
        <img src={avatarSrc ?? undefined} alt="" aria-hidden className="h-full w-full rounded-full object-cover" />
      ) : (
        <UserRound className="h-4 w-4" aria-hidden />
      )}
      {badge ? (
        <span
          aria-hidden
          data-account-badge={badge}
          className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-white bg-niho-surface-warm text-niho-text-sub"
        >
          {badge === "offline" ? <WifiOff className="h-2.5 w-2.5" /> : <CircleAlert className="h-2.5 w-2.5" />}
        </span>
      ) : null}
    </button>
  );
});
