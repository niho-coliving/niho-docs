// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PageSharingPanel, type PageSharingPanelProps } from "./page-sharing-panel";

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

function render(props: Partial<PageSharingPanelProps> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const handlers = {
    onClose: vi.fn(), onRefresh: vi.fn(), onToggle: vi.fn(), onRotate: vi.fn(),
    onCopy: vi.fn(async () => true), onOpen: vi.fn(),
  };
  act(() => root!.render(<PageSharingPanel state={{ status: "PRIVATE", publicId: null, url: null, updatedAt: null }} loading={false} busy={false} error={null} blockReason={null} {...handlers} {...props} />));
  return { host, handlers };
}

function click(container: HTMLElement, label: string) {
  const target = [...container.querySelectorAll("button")].find((button) => button.textContent === label);
  if (!target) throw new Error(`missing button: ${label}`);
  act(() => target.click());
}

describe("NIHO docs link sharing panel", () => {
  it("explains the login requirement when sharing state is unavailable to a signed-out owner", () => {
    const { host: container } = render({ state: null, blockReason: "NIHO にログインしてから共有できます。" });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("NIHO にログインしてから共有できます。");
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it("blocks starting publication while saving but still lets the owner stop publication immediately", () => {
    const privatePanel = render({ blockReason: "保存が終わってから共有できます。" });
    const toggle = privatePanel.host.querySelector<HTMLInputElement>('[role="switch"]');
    expect(toggle?.disabled).toBe(true);
    expect(privatePanel.host.textContent).toContain("保存が終わってから共有できます。");
    act(() => root?.unmount());
    privatePanel.host.remove();
    root = null; host = null;

    const publicPanel = render({
      state: { status: "PUBLIC", publicId: "a".repeat(22), url: "https://niho.life/docs/p#" + "a".repeat(22), updatedAt: null },
      blockReason: "保存が終わってから共有できます。",
    });
    const stop = publicPanel.host.querySelector<HTMLInputElement>('[role="switch"]');
    expect(stop?.disabled).toBe(false);
    act(() => { stop!.click(); });
    expect(publicPanel.handlers.onToggle).toHaveBeenCalledWith(false);
  });

  it("asks before replacing a link and passes the current id to the rotate operation", () => {
    const { host: container, handlers } = render({
      state: { status: "PUBLIC", publicId: "b".repeat(22), url: "https://niho.life/docs/p#" + "b".repeat(22), updatedAt: null },
    });
    click(container, "リンクを作り直す");
    expect(handlers.onRotate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("今のリンクでは見られなくなります。");
    click(container, "作り直す");
    expect(handlers.onRotate).toHaveBeenCalledWith("b".repeat(22));
  });
});
