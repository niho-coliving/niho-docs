// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACCOUNT_LOGOUT_COPY, confirmAccountLogout } from "../account-logout-confirm";
import { appDialog } from "../app-dialog";
import { AppDialogHost } from "./app-dialog-host";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Radix Dialog の portal と focus trap は jsdom で不安定なので、開閉だけを写す passthrough にする（web の app-dialog-host.test.tsx と同じ）。
// ここで確かめるのは、チェックつきの確認の待ち行列・既定のオフ・label と説明の結び付き・結果の形。
vi.mock("./dialog", () => ({
  Dialog: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) =>
    open ? (
      <div data-testid="dialog">
        <button type="button" data-testid="dialog-close-request" onClick={() => onOpenChange(false)}>
          close request
        </button>
        {children}
      </div>
    ) : null,
  DialogContent: ({ children, container }: { children: ReactNode; container?: HTMLElement | null }) => (
    <div data-testid="dialog-content" data-container={container ? container.id : ""}>
      {children}
    </div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => <div data-testid="dialog-description">{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div data-testid="dialog-title">{children}</div>,
}));

describe("appDialog.confirmWithCheckbox と confirmAccountLogout", () => {
  let container: HTMLDivElement;
  let root: Root;

  function mountHost(props: { container?: HTMLElement | null } = {}) {
    act(() => {
      root.render(<AppDialogHost {...props} />);
    });
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find((element) => element.textContent === label);
    if (!found) throw new Error(`button not found: ${label}`);
    return found;
  }

  function checkbox(): HTMLInputElement | null {
    return container.querySelector<HTMLInputElement>("input[type='checkbox']");
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.click();
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("チェックは既定でオフ。確定で { checked: false }、チェックしてから確定で { checked: true }", async () => {
    mountHost();
    let first: Promise<{ checked: boolean } | null> | null = null;
    await act(async () => {
      first = appDialog.confirmWithCheckbox({
        title: "確認",
        confirmLabel: "進める",
        checkbox: { label: "あわせて行う", description: "補足の文" },
      });
    });
    const box = checkbox();
    expect(box).not.toBeNull();
    expect(box?.checked).toBe(false);
    await click(button("進める"));
    await expect(first!).resolves.toEqual({ checked: false });

    let second: Promise<{ checked: boolean } | null> | null = null;
    await act(async () => {
      second = appDialog.confirmWithCheckbox({ title: "確認", confirmLabel: "進める", checkbox: { label: "あわせて行う" } });
    });
    expect(checkbox()?.checked).toBe(false);
    // label の文字を押してもチェックが入る（押せる範囲を広く）
    const label = Array.from(container.querySelectorAll("label")).find((element) => element.textContent === "あわせて行う");
    expect(label).toBeDefined();
    await click(label!);
    expect(checkbox()?.checked).toBe(true);
    await click(button("進める"));
    await expect(second!).resolves.toEqual({ checked: true });
  });

  it("説明は aria-describedby で欄に結び、キャンセル・閉じるは null", async () => {
    mountHost();
    let pending: Promise<{ checked: boolean } | null> | null = null;
    await act(async () => {
      pending = appDialog.confirmWithCheckbox({
        title: "確認",
        confirmLabel: "進める",
        cancelLabel: "やめる",
        checkbox: { label: "あわせて行う", description: "補足の文" },
      });
    });
    const box = checkbox()!;
    const describedBy = box.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(container.querySelector(`[id="${describedBy}"]`)?.textContent).toBe("補足の文");
    // label で包み、accessible name はラベルの文
    expect(box.closest("label")?.textContent).toBe("あわせて行う");
    await click(box);
    await click(button("やめる"));
    await expect(pending!).resolves.toBeNull();

    let closed: Promise<{ checked: boolean } | null> | null = null;
    await act(async () => {
      closed = appDialog.confirmWithCheckbox({ title: "確認", confirmLabel: "進める", checkbox: { label: "x" } });
    });
    expect(checkbox()?.getAttribute("aria-describedby")).toBeNull();
    await click(container.querySelector<HTMLButtonElement>("[data-testid='dialog-close-request']")!);
    await expect(closed!).resolves.toBeNull();
  });

  it("host が外れたら待っているチェックつきの確認は null で返る", async () => {
    mountHost();
    let pending: Promise<{ checked: boolean } | null> | null = null;
    await act(async () => {
      pending = appDialog.confirmWithCheckbox({ title: "確認", confirmLabel: "進める", checkbox: { label: "x" } });
    });
    act(() => {
      root.render(<></>);
    });
    await expect(pending!).resolves.toBeNull();
  });

  it("host の container はダイアログの描き先として渡る", async () => {
    const layer = document.createElement("div");
    layer.id = "dialog-layer";
    document.body.appendChild(layer);
    mountHost({ container: layer });
    let pending: Promise<{ checked: boolean } | null> | null = null;
    await act(async () => {
      pending = appDialog.confirmWithCheckbox({ title: "確認", confirmLabel: "進める", checkbox: { label: "x" } });
    });
    expect(container.querySelector("[data-testid='dialog-content']")?.getAttribute("data-container")).toBe("dialog-layer");
    await click(button("進める"));
    await pending;
    layer.remove();
  });

  it("confirmAccountLogout: ログイン済みはチェックの欄つき（spec の文言・default の確定）", async () => {
    mountHost();
    let pending: Promise<{ everywhere: boolean } | null> | null = null;
    await act(async () => {
      pending = confirmAccountLogout({ lang: "ja", allowEverywhere: true });
    });
    expect(container.querySelector("[data-testid='dialog-title']")?.textContent).toBe("ログアウトしますか？");
    expect(container.textContent).toContain("ほかの端末でもログアウトする");
    expect(container.textContent).toContain("NIHO のサイトとアプリも、ほかの端末ではログインし直しになります。");
    expect(button("キャンセル")).toBeDefined();
    // 破壊的な操作ではないので danger の色にしない
    expect(button("ログアウトする").className).toContain("niho-primary-surface");
    await click(checkbox()!);
    await click(button("ログアウトする"));
    await expect(pending!).resolves.toEqual({ everywhere: true });
  });

  it("confirmAccountLogout: オフライン・期限切れは見出しと確定だけ。注意は本文に足す。キャンセルは null", async () => {
    mountHost();
    let pending: Promise<{ everywhere: boolean } | null> | null = null;
    await act(async () => {
      pending = confirmAccountLogout({ lang: "en", allowEverywhere: false, extraDescription: "Unsaved changes will be lost." });
    });
    expect(container.querySelector("[data-testid='dialog-title']")?.textContent).toBe("Sign out?");
    expect(checkbox()).toBeNull();
    expect(container.querySelector("[data-testid='dialog-description']")?.textContent).toBe("Unsaved changes will be lost.");
    await click(button("Sign out"));
    await expect(pending!).resolves.toEqual({ everywhere: false });

    let cancelled: Promise<{ everywhere: boolean } | null> | null = null;
    await act(async () => {
      cancelled = confirmAccountLogout({ allowEverywhere: true });
    });
    await click(button("キャンセル"));
    await expect(cancelled!).resolves.toBeNull();
  });

  it("文言の表は spec §画面「ログアウトの確認」のとおり（ja / en）", () => {
    expect(ACCOUNT_LOGOUT_COPY.ja).toEqual({
      title: "ログアウトしますか？",
      everywhereLabel: "ほかの端末でもログアウトする",
      everywhereDescription: "NIHO のサイトとアプリも、ほかの端末ではログインし直しになります。",
      confirm: "ログアウトする",
      cancel: "キャンセル",
      everywhereFailed: "ほかの端末をログアウトできませんでした。通信を確かめて、もう一度お試しください。",
      everywhereSucceeded: "ほかの端末でもログアウトしました",
      signedOut: "ログアウトしました",
    });
    expect(ACCOUNT_LOGOUT_COPY.en).toMatchObject({
      title: "Sign out?",
      everywhereLabel: "Also sign out on other devices",
      everywhereDescription: "You'll need to sign in again to NIHO's website and apps on your other devices.",
      confirm: "Sign out",
      cancel: "Cancel",
      everywhereFailed: "Couldn't sign out your other devices. Check your connection and try again.",
      everywhereSucceeded: "Signed out on all devices",
    });
  });
});
