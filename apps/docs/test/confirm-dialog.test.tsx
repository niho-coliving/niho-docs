// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmDialog } from "../src/components/ConfirmDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);

afterEach(() => {
  act(() => root.render(null));
});

it("処理中の Escape では閉じず、処理が終われば閉じる", () => {
  const onCancel = vi.fn();
  act(() => root.render(<ConfirmDialog title="更新" confirmLabel="更新する" busy onConfirm={() => undefined} onCancel={onCancel} />));
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onCancel).not.toHaveBeenCalled();
  const busyDialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(document.activeElement).toBe(busyDialog);
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  act(() => busyDialog.dispatchEvent(tab));
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(busyDialog);
  act(() => root.render(<ConfirmDialog title="更新" confirmLabel="更新する" onConfirm={() => undefined} onCancel={onCancel} />));
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onCancel).toHaveBeenCalledOnce();
});

it("閉じると元の操作へfocusを戻し、dialog内のkeyboard操作を背後へ流さない", () => {
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  const behind = vi.fn();
  document.addEventListener("keydown", behind);
  act(() => root.render(<ConfirmDialog title="確認" confirmLabel="続ける" onConfirm={() => undefined} onCancel={() => undefined} />));
  const confirm = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === "続ける")!;
  act(() => confirm.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true })));
  expect(behind).not.toHaveBeenCalled();
  act(() => root.render(null));
  expect(document.activeElement).toBe(opener);
  document.removeEventListener("keydown", behind);
  opener.remove();
});
