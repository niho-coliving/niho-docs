/** @vitest-environment jsdom */

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DocsStorageModeScreen } from "./DocsStorageModeScreen";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(node); });
  return container;
}

const buttonOf = (container: ParentNode, text: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === text);

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
});

describe("DocsStorageModeScreen", () => {
  it("UNSETを表示し、mount時は選択せず、明示クリックでクラウド選択を呼ぶ", async () => {
    const onSelectCloud = vi.fn();
    const container = await render(
      <DocsStorageModeScreen
        mode="UNSET"
        onSelectCloud={onSelectCloud}
        accountContent={<div data-testid="account-slot">account</div>}
        recordingRescue={<div data-testid="rescue-slot">rescue</div>}
      />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("保存先を選んでください");
    expect(onSelectCloud).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="rescue-slot"]')?.textContent).toBe("rescue");
    await act(async () => { buttonOf(container, "NIHO クラウドを選ぶ")!.click(); });
    expect(onSelectCloud).toHaveBeenCalledOnce();
  });

  it("選択中はクラウド選択をdisabledにする", async () => {
    const onSelectCloud = vi.fn();
    const container = await render(
      <DocsStorageModeScreen mode="UNSET" selecting onSelectCloud={onSelectCloud} accountContent={null} recordingRescue={null} />,
    );
    const button = buttonOf(container, "保存先を確認中…")!;
    expect(button.disabled).toBe(true);
    await act(async () => { button.click(); });
    expect(onSelectCloud).not.toHaveBeenCalled();
  });

  it("UNSETはcallbackを必須とし、JavaScriptから欠落して渡された場合も無反応の主ボタンを有効にしない", async () => {
    // @ts-expect-error UNSETでは選択callbackが必須。型検査と実行時の両方を確認する。
    const node = <DocsStorageModeScreen mode="UNSET" accountContent={null} recordingRescue={null} />;
    const container = await render(node);
    expect(buttonOf(container, "NIHO クラウドを選ぶ")!.disabled).toBe(true);
  });

  it("LOCALでは案内を表示し、クラウド選択ボタンを表示しない", async () => {
    const container = await render(
      <DocsStorageModeScreen
        mode="LOCAL"
        accountContent={<span data-testid="account-slot">account</span>}
        recordingRescue={<span data-testid="rescue-slot">recording rescue</span>}
      />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("このアカウントは、ページを Mac の中だけに保存しています");
    expect(container.textContent).toContain("ページとフォルダは Mac アプリで開けます。");
    expect(buttonOf(container, "NIHO クラウドを選ぶ")).toBeUndefined();
    expect(container.querySelector('[data-testid="rescue-slot"]')?.textContent).toBe("recording rescue");
  });

  it("エラーと読み直すcallbackを表示する", async () => {
    const onRetry = vi.fn();
    const container = await render(
      <DocsStorageModeScreen mode="UNSET" onSelectCloud={vi.fn()} error="保存先を確認できませんでした。" onRetry={onRetry} accountContent={null} recordingRescue={null} />,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("保存先を確認できませんでした。");
    await act(async () => { buttonOf(container, "読み直す")!.click(); });
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("設定からaccount slotを開閉し、slotの内容をそのまま表示する", async () => {
    const container = await render(
      <DocsStorageModeScreen
        mode="UNSET"
        onSelectCloud={vi.fn()}
        accountContent={<div data-testid="account-slot">account content</div>}
        recordingRescue={<div data-testid="rescue-slot">recording rescue</div>}
      />,
    );
    const settings = buttonOf(container, "設定")!;
    expect(settings.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[aria-label="アカウント"]')).toBeNull();
    await act(async () => { settings.click(); });
    expect(settings.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[aria-label="アカウント"] [data-testid="account-slot"]')?.textContent).toBe("account content");
    await act(async () => { settings.click(); });
    expect(settings.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[aria-label="アカウント"]')).toBeNull();
  });
});
