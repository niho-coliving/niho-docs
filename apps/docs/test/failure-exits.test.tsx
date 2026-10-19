// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DiffDialog } from "../src/components/DiffDialog";
import { PartialOutput } from "../src/components/PartialOutput";
import { button, click } from "./dom";

let root: Root | null = null;
let container: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
});

async function show(content: ReactNode) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => root!.render(content));
}

it("途中までの本文をコピーし、続きの依頼に同じ本文を渡す。実行中は理由を出して続けられない", async () => {
  const text = "# 途中まで\n\n取材の内容です。";
  const onCopy = vi.fn();
  const onContinue = vi.fn();
  const props = { chars: text.length, load: async () => text, onCopy, onContinue };
  await show(<PartialOutput {...props} />);
  await act(async () => {
    const details = container.querySelector("details")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  await click(button(container, "コピー"));
  await click(button(container, "続きを頼む"));
  expect(onCopy).toHaveBeenCalledWith(text);
  expect(onContinue).toHaveBeenCalledWith(text);

  await show(<PartialOutput {...props} continueBlocked="工程の実行が終わってから頼めます。" />);
  expect(button(container, "続きを頼む").disabled).toBe(true);
  expect(container.textContent).toContain("工程の実行が終わってから頼めます。");
  await click(button(container, "続きを頼む"));
  expect(onContinue).toHaveBeenCalledOnce();
});

it("後の版がある差分は確認してから戻す。禁止中は理由を出し、元に戻さない", async () => {
  const onUndo = vi.fn();
  const onClose = vi.fn();
  const props = { name: "議事録", caption: "版 1 → 版 2", load: async () => ({ before: "前", after: "後" }), onClose };
  const undo = { disabledReason: null, confirm: "版 3 が保存されています。戻しますか？", onUndo };
  await show(<DiffDialog {...props} undo={undo} />);
  await click(button(container, "元に戻す"));
  expect(onUndo).not.toHaveBeenCalled();
  await click(button(container.querySelector<HTMLElement>(".result-confirm")!, "やめる"));
  expect(onUndo).not.toHaveBeenCalled();

  await show(<DiffDialog {...props} undo={{ ...undo, disabledReason: "保存が終わってから元に戻せます。" }} />);
  expect(button(container, "元に戻す").disabled).toBe(true);
  expect(container.textContent).toContain("保存が終わってから元に戻せます。");
  await click(button(container, "元に戻す"));
  expect(onUndo).not.toHaveBeenCalled();

  await show(<DiffDialog {...props} undo={undo} />);
  await click(button(container, "元に戻す"));
  await click(button(container.querySelector<HTMLElement>(".result-confirm")!, "戻す"));
  expect(onUndo).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});
