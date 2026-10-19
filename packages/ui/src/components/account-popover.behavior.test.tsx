// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountPopoverContent } from "./account-popover";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((el) => el.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

describe("AccountPopoverContent behavior", () => {
  it("calls the callback for each state's buttons", async () => {
    const onBeginLogin = vi.fn();
    const onCancelLogin = vi.fn();
    const onLogout = vi.fn();
    const onOpenMyPage = vi.fn();
    const callbacks = { onBeginLogin, onCancelLogin, onLogout, onOpenMyPage };

    await act(async () => {
      root.render(<AccountPopoverContent state={{ kind: "signedOut" }} {...callbacks} />);
    });
    await act(async () => {
      buttonByText("NIHO でログイン").click();
    });
    expect(onBeginLogin).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<AccountPopoverContent state={{ kind: "signingIn" }} {...callbacks} />);
    });
    await act(async () => {
      buttonByText("やめる").click();
    });
    expect(onCancelLogin).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <AccountPopoverContent state={{ kind: "signedIn", profile: { displayName: "たくや", handle: "t" } }} {...callbacks} />,
      );
    });
    await act(async () => {
      buttonByText("マイページを開く").click();
      buttonByText("ログアウト").click();
    });
    expect(onOpenMyPage).toHaveBeenCalledTimes(1);
    expect(onLogout).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <AccountPopoverContent state={{ kind: "expired", profile: { displayName: "たくや", handle: null } }} {...callbacks} />,
      );
    });
    await act(async () => {
      buttonByText("もう一度ログイン").click();
    });
    expect(onBeginLogin).toHaveBeenCalledTimes(2);

    // busy の間は押せない
    await act(async () => {
      root.render(
        <AccountPopoverContent
          state={{ kind: "signedIn", profile: { displayName: "たくや", handle: null } }}
          busy="openMyPage"
          {...callbacks}
        />,
      );
    });
    await act(async () => {
      buttonByText("ログアウト").click();
    });
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
