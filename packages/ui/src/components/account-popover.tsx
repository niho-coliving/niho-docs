"use client";

import { type ReactNode, useState } from "react";
import { ArrowUpRight, LogOut, UserRound, WifiOff } from "lucide-react";

import { AccountButton, type AccountButtonState } from "./account-button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Spinner } from "./spinner";
import { cn } from "../cn";

/**
 * NIHO アカウントの popover（spec「画面」のアプリの表。Epic #18551 L3 #18555）。
 *
 * | 状態 | 中身 |
 * |---|---|
 * | 未ログイン | 見出し「NIHO アカウント」／主ボタン「NIHO でログイン」 |
 * | ログイン中 | 「ブラウザで続けています…」／「やめる」 |
 * | ログイン済み | 顔写真・名前・@handle／「マイページを開く ↗」（`onOpenMyPage` を渡したときだけ）／「ログアウト」 |
 * | オフライン | 同上＋「オフライン」 |
 * | 期限切れ | 名前／「もう一度ログイン」（主）／「ログアウト」 |
 *
 * NIHO docs はアプリ単体で完結させるので `onOpenMyPage` を渡さない（owner 2026-10-17）。
 * props は状態と callback だけで、Tauri を呼ばない（`niho-desktop-account` の `useNihoAccount` が繋ぐ）。主ボタンは緑の
 * グラデーション（`niho-primary-surface`）、文言は中立でアプリ名を出さない（決まりごと 7）。トーストは呼び出し側。
 */
export type AccountPopoverProfile = { displayName: string; handle: string | null };

export type AccountPopoverState =
  | { kind: "signedOut" }
  | { kind: "signingIn" }
  | { kind: "signedIn"; profile: AccountPopoverProfile }
  | { kind: "offline"; profile: AccountPopoverProfile }
  | { kind: "expired"; profile: AccountPopoverProfile };

export type AccountPopoverLang = "ja" | "en";

export type AccountPopoverCopy = {
  heading: string;
  signIn: string;
  continuingInBrowser: string;
  cancel: string;
  openMyPage: string;
  openMyPageHint: string;
  logout: string;
  offline: string;
  signInAgain: string;
  fallbackName: string;
};

export const ACCOUNT_POPOVER_COPY: Record<AccountPopoverLang, AccountPopoverCopy> = {
  ja: {
    heading: "NIHO アカウント",
    signIn: "NIHO でログイン",
    continuingInBrowser: "ブラウザで続けています…",
    cancel: "やめる",
    openMyPage: "マイページを開く",
    openMyPageHint: "ブラウザで開く",
    logout: "ログアウト",
    offline: "オフライン",
    signInAgain: "もう一度ログイン",
    fallbackName: "NIHO アカウント",
  },
  en: {
    heading: "NIHO account",
    signIn: "Sign in with NIHO",
    continuingInBrowser: "Continuing in your browser…",
    cancel: "Cancel",
    openMyPage: "Open My Page",
    openMyPageHint: "Opens in your browser",
    logout: "Sign out",
    offline: "Offline",
    signInAgain: "Sign in again",
    fallbackName: "NIHO account",
  },
};

export type AccountPopoverAction = "beginLogin" | "cancelLogin" | "logout" | "openMyPage";

export type AccountPopoverContentProps = {
  state: AccountPopoverState | null;
  avatarSrc?: string | null;
  lang?: AccountPopoverLang;
  /** 進行中の操作（その間はボタンを押せない） */
  busy?: AccountPopoverAction | null;
  onBeginLogin: () => void;
  onCancelLogin: () => void;
  onLogout: () => void;
  /** 渡したときだけ「マイページを開く」を出す。 */
  onOpenMyPage?: () => void;
  /** アカウント固有の項目を、ログアウトの前に置く。 */
  beforeLogout?: ReactNode;
  className?: string;
};

const PRIMARY_BUTTON =
  "niho-primary-surface flex min-h-10 w-full items-center justify-center rounded-full px-4 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BCD499]/60 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const SECONDARY_BUTTON =
  "flex min-h-10 w-full items-center justify-center rounded-full border border-niho-border bg-white px-4 text-sm font-bold text-niho-dark transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BCD499]/60 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";
const ROW_BUTTON =
  "flex min-h-10 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-bold text-niho-text transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

function ProfileRow({
  profile,
  avatarSrc,
  copy,
}: {
  profile: AccountPopoverProfile;
  avatarSrc?: string | null;
  copy: AccountPopoverCopy;
}) {
  const name = profile.displayName.trim().length > 0 ? profile.displayName : copy.fallbackName;
  return (
    <div className="flex min-w-0 items-center gap-3 px-3 py-2">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full border border-niho-border bg-niho-surface-warm text-niho-text-sub">
        {avatarSrc ? (
          /* Tauri の asset: URL（この Mac のファイル） */
          <img src={avatarSrc} alt="" aria-hidden className="h-full w-full object-cover" />
        ) : (
          <UserRound className="h-5 w-5" aria-hidden />
        )}
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-bold text-niho-text" data-account-name>
          {name}
        </p>
        {profile.handle ? (
          <p className="truncate text-sub text-niho-text-muted" data-account-handle>
            @{profile.handle}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AccountPopoverContent({
  state,
  avatarSrc,
  lang = "ja",
  busy = null,
  onBeginLogin,
  onCancelLogin,
  onLogout,
  onOpenMyPage,
  beforeLogout,
  className,
}: AccountPopoverContentProps) {
  const copy = ACCOUNT_POPOVER_COPY[lang];
  const disabled = busy !== null;
  let body: ReactNode;
  if (!state) {
    body = (
      <div className="flex items-center justify-center px-3 py-4" aria-busy>
        <Spinner size="sm" />
      </div>
    );
  } else if (state.kind === "signedOut") {
    body = (
      <div className="space-y-3 px-3 py-2">
        <h2 className="text-sm font-bold text-niho-text">{copy.heading}</h2>
        <button type="button" className={PRIMARY_BUTTON} disabled={disabled} onClick={onBeginLogin}>
          {copy.signIn}
        </button>
      </div>
    );
  } else if (state.kind === "signingIn") {
    body = (
      <div className="space-y-3 px-3 py-2">
        <p className="flex items-center gap-2 text-sm text-niho-text" role="status">
          <Spinner size="sm" />
          <span>{copy.continuingInBrowser}</span>
        </p>
        <button type="button" className={SECONDARY_BUTTON} disabled={disabled} onClick={onCancelLogin}>
          {copy.cancel}
        </button>
      </div>
    );
  } else if (state.kind === "expired") {
    body = (
      <div className="space-y-2">
        <ProfileRow profile={state.profile} avatarSrc={avatarSrc} copy={copy} />
        <div className="px-3">
          <button type="button" className={PRIMARY_BUTTON} disabled={disabled} onClick={onBeginLogin}>
            {copy.signInAgain}
          </button>
        </div>
        <button type="button" className={ROW_BUTTON} disabled={disabled} onClick={onLogout}>
          <LogOut className="h-4 w-4 text-niho-text-sub" aria-hidden />
          {copy.logout}
        </button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-1">
        <ProfileRow profile={state.profile} avatarSrc={avatarSrc} copy={copy} />
        {state.kind === "offline" ? (
          <p className="flex items-center gap-2 px-3 pb-1 text-sub text-niho-text-sub" role="status">
            <WifiOff className="h-3.5 w-3.5" aria-hidden />
            <span>{copy.offline}</span>
          </p>
        ) : null}
        {onOpenMyPage ? (
          <button
            type="button"
            className={ROW_BUTTON}
            disabled={disabled}
            onClick={onOpenMyPage}
            title={copy.openMyPageHint}
          >
            <span className="flex-1">{copy.openMyPage}</span>
            <ArrowUpRight className="h-4 w-4 text-niho-text-sub" aria-hidden />
          </button>
        ) : null}
        {beforeLogout ? <div className="px-3">{beforeLogout}</div> : null}
        <button type="button" className={ROW_BUTTON} disabled={disabled} onClick={onLogout}>
          <LogOut className="h-4 w-4 text-niho-text-sub" aria-hidden />
          {copy.logout}
        </button>
      </div>
    );
  }
  return (
    <div className={cn("w-full", className)} data-account-popover={state?.kind ?? "unknown"}>
      {body}
    </div>
  );
}

export type AccountPopoverProps = AccountPopoverContentProps & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Portal の描画先（テーマ変数を持つ親に閉じ込めるとき） */
  container?: HTMLElement | null;
  align?: "start" | "center" | "end";
  buttonClassName?: string;
};

/** ボタン（`AccountButton`）と中身（`AccountPopoverContent`）をそろえた popover。 */
export function AccountPopover({
  open: controlledOpen,
  onOpenChange,
  container,
  align = "end",
  buttonClassName,
  className,
  ...content
}: AccountPopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const handleOpenChange = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const state = content.state;
  const buttonState: AccountButtonState = state?.kind ?? "unknown";
  const profile = state && state.kind !== "signedOut" && state.kind !== "signingIn" ? state.profile : null;
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <AccountButton
          state={buttonState}
          avatarSrc={content.avatarSrc}
          displayName={profile?.displayName}
          lang={content.lang}
          className={buttonClassName}
        />
      </PopoverTrigger>
      <PopoverContent align={align} container={container} className={cn("w-72 p-2", className)}>
        <AccountPopoverContent {...content} />
      </PopoverContent>
    </Popover>
  );
}
