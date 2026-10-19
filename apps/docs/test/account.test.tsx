// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import {
  ACCOUNT_CHANGED_EVENT,
  ACCOUNT_COMMANDS,
  ACCOUNT_LOGIN_FAILED_EVENT,
  type AccountTransport,
} from "niho-desktop-account/account-bridge";
import type { AccountState } from "niho-desktop-account/account-state";
import { ACCOUNT_TOAST_COPY, accountErrorMessage } from "niho-desktop-account/account-copy";
import { ACCOUNT_LOGOUT_COPY } from "niho-ui/account-logout-confirm";
import { button, click, renderApp, type Screen } from "./dom";
import { FakeBridge, activeCloud } from "./fake-bridge";

const profile = {
  userId: "user-1", displayName: "文書 太郎", handle: "docs-taro", connectionId: "connection-1",
  avatarPath: "/Users/test/Library/Application Support/life.niho.docs/account/account-avatar.png",
};

class FakeAccount {
  state: AccountState = { kind: "signedOut" };
  calls: string[] = [];
  logoutArgs: Array<Record<string, unknown> | undefined> = [];
  /** 「ほかの端末でもログアウトする」を失敗させる（Rust の sign_out_everywhere_failed） */
  failEverywhere = false;
  listeners = new Map<string, (payload: unknown) => void>();
  transport: AccountTransport = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      this.calls.push(command);
      if (command === ACCOUNT_COMMANDS.state) return this.state as T;
      if (command === ACCOUNT_COMMANDS.beginLogin) this.change({ kind: "signingIn", sinceMs: 1 });
      if (command === ACCOUNT_COMMANDS.logout) {
        this.logoutArgs.push(args);
        if (args?.everywhere === true && this.failEverywhere) {
          throw { code: "sign_out_everywhere_failed", message: "untrusted" };
        }
      }
      if (command === ACCOUNT_COMMANDS.cancelLogin || command === ACCOUNT_COMMANDS.logout) this.change({ kind: "signedOut" });
      return undefined as T;
    },
    listen: async <T,>(name: string, handler: (event: { payload: T }) => void) => {
      this.listeners.set(name, (payload) => handler({ payload: payload as T }));
      return () => { this.listeners.delete(name); };
    },
    convertFileSrc: (path) => `asset://localhost/${encodeURIComponent(path)}`,
  };
  change(state: AccountState) {
    this.state = state;
    this.listeners.get(ACCOUNT_CHANGED_EVENT)?.(state);
  }
}

let screen: Screen | null = null;
afterEach(() => { screen?.unmount(); screen = null; });

function accountButtonState(container: HTMLElement): string | null {
  return container.querySelector('button[aria-label="アカウント"]')?.getAttribute("data-account-state") ?? null;
}

it("ログイン画面でも更新を実行でき、ログイン失敗を消えない帯で知らせる", async () => {
  const account = new FakeAccount();
  const bridge = new FakeBridge();
  bridge.cloud = activeCloud({ status: "signedOut" });
  bridge.update = { enabled: true, stagedVersion: "0.1.99" };
  screen = await renderApp(bridge, account.transport);
  const { container } = screen;
  expect(container.querySelector(".login-required")).not.toBeNull();
  await click(button(container, "更新して再起動"));
  expect(bridge.restartCalls).toEqual([false]);
  await act(async () => account.listeners.get(ACCOUNT_LOGIN_FAILED_EVENT)?.({ code: "code_expired", message: "untrusted" }));
  expect(container.querySelector('.login-required [role="alert"]')?.textContent).toContain("もう一度");
  expect(container.querySelector(".toast")).toBeNull();
});

async function show(account: FakeAccount) {
  screen = await renderApp(new FakeBridge(), account.transport);
  await click(button(screen.container, "設定"));
  await click(screen.container.querySelector('button[aria-label="アカウント"]')!);
  return screen.container;
}

it("未ログインでも案件を作成でき、設定の接続設定から共通ログイン・中止を呼ぶ", async () => {
  const account = new FakeAccount();
  const container = await show(account);
  await click(container.querySelector<HTMLButtonElement>(".window-titlebar .tb-new")!);
  expect(button(container, "ページ").disabled).toBe(false);
  expect(container.querySelector(".docs-account")?.closest(".card")?.querySelector("h2")?.textContent).toBe("接続設定");
  expect(container.querySelector(".docs-account")?.textContent).toContain("NIHO docs はログインして使います");
  expect(container.querySelector('[data-account-popover="signedOut"]')).not.toBeNull();
  await click(button(container, "NIHO でログイン"));
  expect(container.textContent).toContain("ブラウザで続けています…");
  await click(button(container, "やめる"));
  expect(account.calls).toContain(ACCOUNT_COMMANDS.beginLogin);
  expect(account.calls).toContain(ACCOUNT_COMMANDS.cancelLogin);
  expect(container.querySelector('[data-account-popover="signedOut"]')).not.toBeNull();
});

it("名前・顔写真・オフラインを表示し、期限切れの再ログインとログアウトを共通処理へ渡す", async () => {
  const account = new FakeAccount();
  account.state = { kind: "offline", profile };
  const container = await show(account);
  expect(container.textContent).toContain("文書 太郎");
  expect(container.textContent).toContain("@docs-taro");
  expect(container.textContent).toContain("オフライン");
  expect(container.querySelector('[data-account-popover] img')?.getAttribute("src")).toContain("asset://localhost/");
  // NIHO docs は単体で完結させ、マイページへの導線は置かない
  expect(container.querySelector("[data-account-popover]")?.textContent).not.toContain("マイページを開く");
  await act(async () => account.change({ kind: "expired", profile, reason: "connectionRevoked" }));
  expect(container.querySelector('[data-account-popover="expired"]')).not.toBeNull();
  await click(button(container, "もう一度ログイン"));
  expect(account.calls).toContain(ACCOUNT_COMMANDS.beginLogin);
  await act(async () => account.change({ kind: "signedIn", profile }));
  expect(container.querySelector(".toast")?.textContent).toBe("ログインしました");
  // 「ログアウト」→ 共通の確認（チェックは既定でオフ）→「ログアウトする」でこの Mac だけ
  await click(button(container, "ログアウト"));
  expect(account.calls).not.toContain(ACCOUNT_COMMANDS.logout);
  expect(container.querySelector('.docs-dialog-layer [role="dialog"]')?.textContent).toContain("ログアウトしますか？");
  const everywhere = container.querySelector<HTMLInputElement>('.docs-dialog-layer [role="dialog"] input[type="checkbox"]');
  expect(everywhere?.checked).toBe(false);
  await click(button(container, "ログアウトする"));
  expect(account.calls).toContain(ACCOUNT_COMMANDS.logout);
  expect(account.logoutArgs).toEqual([undefined]);
  expect(container.querySelector(".toast")?.textContent).toBe("ログアウトしました");
  expect(container.querySelector('[data-account-popover]')?.textContent).not.toContain("文書 太郎");
});

it("ログアウトの確認で「ほかの端末でもログアウトする」を選ぶと everywhere で呼び、成功と失敗を知らせる", async () => {
  const account = new FakeAccount();
  account.state = { kind: "signedIn", profile };
  const container = await show(account);
  // 確認の描く先は Tailwind の効く .docs-account の中（App の画面の外）
  await click(button(container, "ログアウト"));
  const dialog = container.querySelector('.docs-dialog-layer [role="dialog"]');
  expect(dialog?.closest(".docs-account.docs-dialog-layer")).not.toBeNull();
  const checkbox = dialog?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox?.closest("label")?.textContent).toBe("ほかの端末でもログアウトする");
  expect(dialog?.textContent).toContain("NIHO のサイトとアプリも、ほかの端末ではログインし直しになります。");
  // 失敗: この Mac はログイン済みのまま、失敗の文言
  account.failEverywhere = true;
  await click(checkbox!);
  await click(button(container, "ログアウトする"));
  expect(account.logoutArgs).toEqual([{ everywhere: true }]);
  // 失敗は消えない帯に残す（トーストは成功の確認だけ。#18788）
  expect(container.querySelector(".failure-band .fb-msg")?.textContent).toBe(ACCOUNT_LOGOUT_COPY.ja.everywhereFailed);
  expect(container.querySelector(".toast")).toBeNull();
  expect(accountButtonState(container)).toBe("signedIn");
  // 成功
  account.failEverywhere = false;
  // 確認で popover は閉じている。開き直してもう一度
  await click(container.querySelector('button[aria-label="アカウント"]')!);
  await click(button(container, "ログアウト"));
  await click(container.querySelector<HTMLInputElement>('.docs-dialog-layer [role="dialog"] input[type="checkbox"]')!);
  await click(button(container, "ログアウトする"));
  expect(account.logoutArgs).toEqual([{ everywhere: true }, { everywhere: true }]);
  expect(container.querySelector(".toast")?.textContent).toBe(ACCOUNT_LOGOUT_COPY.ja.everywhereSucceeded);
  expect(accountButtonState(container)).toBe("signedOut");
});

it("オフライン・期限切れのログアウトの確認にはチェックの欄を出さない。キャンセルなら何もしない", async () => {
  const account = new FakeAccount();
  account.state = { kind: "offline", profile };
  const container = await show(account);
  await click(button(container, "ログアウト"));
  expect(container.querySelector('.docs-dialog-layer [role="dialog"]')?.textContent).toContain("ログアウトしますか？");
  expect(container.querySelector('.docs-dialog-layer [role="dialog"] input[type="checkbox"]')).toBeNull();
  await click(button(container, "キャンセル"));
  expect(account.calls).not.toContain(ACCOUNT_COMMANDS.logout);
  expect(accountButtonState(container)).toBe("offline");
});

it("Mac 版のトーストと失敗の文は Web 版と同じ（niho-ui の ACCOUNT_LOGOUT_COPY）", () => {
  for (const lang of ["ja", "en"] as const) {
    expect(ACCOUNT_TOAST_COPY[lang].signedOutEverywhere).toBe(ACCOUNT_LOGOUT_COPY[lang].everywhereSucceeded);
    expect(ACCOUNT_TOAST_COPY[lang].signedOut).toBe(ACCOUNT_LOGOUT_COPY[lang].signedOut);
    expect(accountErrorMessage({ code: "sign_out_everywhere_failed" }, lang)).toBe(ACCOUNT_LOGOUT_COPY[lang].everywhereFailed);
  }
});

it("設定を閉じていてもログイン完了・コールバック失敗を知らせ、画面の往復で購読を増やさない", async () => {
  const account = new FakeAccount();
  const container = await show(account);
  await click(button(container, "NIHO でログイン"));
  await click(button(container, "工程設計"));
  await act(async () => account.change({ kind: "signedIn", profile }));
  expect(container.querySelector(".toast")?.textContent).toBe("ログインしました");
  await act(async () => account.listeners.get(ACCOUNT_LOGIN_FAILED_EVENT)?.({ code: "code_expired", message: "untrusted" }));
  expect(container.querySelector(".failure-band .fb-msg")?.textContent).toContain("もう一度");
  expect(container.querySelector(".failure-band .fb-msg")?.textContent).not.toContain("untrusted");
  await click(button(container, "設定"));
  expect(account.calls.filter((command) => command === ACCOUNT_COMMANDS.state)).toHaveLength(1);
  expect(account.listeners.size).toBe(2);
});
