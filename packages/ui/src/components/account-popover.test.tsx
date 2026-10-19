import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccountButton } from "./account-button";
import { ACCOUNT_POPOVER_COPY, AccountPopoverContent } from "./account-popover";

const noop = () => {};
const callbacks = { onBeginLogin: noop, onCancelLogin: noop, onLogout: noop, onOpenMyPage: noop };
const profile = { displayName: "たくや", handle: "takuya" };

describe("AccountButton", () => {
  it("has the accessible name アカウント and a person icon when signed out", () => {
    const html = renderToStaticMarkup(<AccountButton state="signedOut" />);
    expect(html).toContain('aria-label="アカウント"');
    expect(html).toContain('type="button"');
    expect(html).toContain("<svg");
    expect(html).not.toContain("<img");
    expect(html).toContain("rounded-full");
    // 押せる範囲の最小 24px（design-guide §8）を満たす 32px
    expect(html).toContain("h-8 w-8");
    expect(renderToStaticMarkup(<AccountButton lang="en" />)).toContain('aria-label="Account"');
  });

  it("shows the avatar when signed in and a badge for offline / expired", () => {
    const signedIn = renderToStaticMarkup(<AccountButton state="signedIn" avatarSrc="asset://x" displayName="たくや" />);
    expect(signedIn).toContain('<img src="asset://x" alt=""');
    expect(signedIn).toContain('title="たくや"');
    expect(signedIn).toContain('aria-label="アカウント"');
    expect(signedIn).not.toContain("data-account-badge");
    const offline = renderToStaticMarkup(<AccountButton state="offline" avatarSrc="asset://x" />);
    expect(offline).toContain('data-account-badge="offline"');
    const expired = renderToStaticMarkup(<AccountButton state="expired" />);
    expect(expired).toContain('data-account-badge="expired"');
    // ログイン中は顔写真を出さない（前のアカウントの写真が残らない）
    const signingIn = renderToStaticMarkup(<AccountButton state="signingIn" avatarSrc="asset://x" />);
    expect(signingIn).not.toContain("<img");
  });
});

describe("AccountPopoverContent", () => {
  it("signed out: heading and the green primary sign-in button", () => {
    const html = renderToStaticMarkup(<AccountPopoverContent state={{ kind: "signedOut" }} {...callbacks} />);
    expect(html).toContain("NIHO アカウント");
    expect(html).toContain("NIHO でログイン");
    expect(html).toContain("niho-primary-surface");
    expect(html).not.toContain("ログアウト");
    expect(html).not.toMatch(/ようこそ|camera|docs/i);
  });

  it("signing in: continuing line and cancel", () => {
    const html = renderToStaticMarkup(<AccountPopoverContent state={{ kind: "signingIn" }} {...callbacks} />);
    expect(html).toContain("ブラウザで続けています…");
    expect(html).toContain("やめる");
    expect(html).toContain('role="status"');
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("niho-primary-surface");
  });

  it("signed in: avatar, name, @handle, my page and logout", () => {
    const html = renderToStaticMarkup(
      <AccountPopoverContent state={{ kind: "signedIn", profile }} avatarSrc="asset://a" {...callbacks} />,
    );
    expect(html).toContain('<img src="asset://a"');
    expect(html).toContain("たくや");
    expect(html).toContain("@takuya");
    expect(html).toContain("マイページを開く");
    expect(html).toContain('title="ブラウザで開く"');
    expect(html).toContain("ログアウト");
    expect(html).not.toContain("オフライン");
    // ログイン済みに主ボタンは無い
    expect(html).not.toContain("niho-primary-surface");
  });

  it("signed in without onOpenMyPage: no my page row (NIHO docs)", () => {
    const withoutMyPage = { onBeginLogin: noop, onCancelLogin: noop, onLogout: noop };
    const html = renderToStaticMarkup(<AccountPopoverContent state={{ kind: "signedIn", profile }} {...withoutMyPage} />);
    expect(html).toContain("たくや");
    expect(html).toContain("ログアウト");
    expect(html).not.toContain("マイページを開く");
    expect(html).not.toContain("ブラウザで開く");
  });

  it("places account details after the profile and before logout", () => {
    const html = renderToStaticMarkup(
      <AccountPopoverContent state={{ kind: "signedIn", profile }} beforeLogout={<span>通知先</span>} {...callbacks} />,
    );
    expect(html.indexOf("たくや")).toBeLessThan(html.indexOf("通知先"));
    expect(html.indexOf("通知先")).toBeLessThan(html.indexOf("ログアウト"));
  });

  it("offline: the same plus the offline line with an icon; expired: name plus sign in again", () => {
    const offline = renderToStaticMarkup(<AccountPopoverContent state={{ kind: "offline", profile }} {...callbacks} />);
    expect(offline).toContain("オフライン");
    expect(offline).toContain("マイページを開く");
    expect(offline).toContain("ログアウト");
    const expired = renderToStaticMarkup(
      <AccountPopoverContent state={{ kind: "expired", profile: { displayName: "", handle: null } }} {...callbacks} />,
    );
    expect(expired).toContain("もう一度ログイン");
    expect(expired).toContain("niho-primary-surface");
    expect(expired).toContain("ログアウト");
    // 名前が空なら補う
    expect(expired).toContain("NIHO アカウント");
    expect(expired).not.toContain("@");
    expect(expired).not.toContain("マイページを開く");
  });

  it("renders a spinner before the state is known and English copy on request", () => {
    expect(renderToStaticMarkup(<AccountPopoverContent state={null} {...callbacks} />)).toContain("animate-spin");
    const en = renderToStaticMarkup(<AccountPopoverContent state={{ kind: "signedOut" }} lang="en" {...callbacks} />);
    expect(en).toContain(ACCOUNT_POPOVER_COPY.en.signIn);
    expect(en).toContain(ACCOUNT_POPOVER_COPY.en.heading);
  });

  it("disables every button while an action is in flight", () => {
    const html = renderToStaticMarkup(
      <AccountPopoverContent state={{ kind: "signedIn", profile }} busy="logout" {...callbacks} />,
    );
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(2);
    for (const button of buttons) expect(button).toContain("disabled");
  });
});
