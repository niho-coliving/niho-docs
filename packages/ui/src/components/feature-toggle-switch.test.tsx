// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeatureToggleSwitch } from "./feature-toggle-switch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("FeatureToggleSwitch", () => {
  it("既存 API と寸法 class を保ち、button の switch semantics で操作する", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };
    const onChange = vi.fn();
    act(() => {
      root.render(
        <FeatureToggleSwitch
          id="feature"
          checked={false}
          disabled={false}
          onChange={onChange}
          ariaLabel="機能を表示にする"
        />,
      );
    });
    const button = container.querySelector("button")!;
    expect(button.type).toBe("button");
    expect(button.getAttribute("role")).toBe("switch");
    expect(button.getAttribute("aria-checked")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("機能を表示にする");
    expect(button.tabIndex).toBe(0);
    expect(button.className).toContain("h-6 w-11");
    act(() => button.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("docs 用 class を足しても24pxの操作領域とsmの見た目を保つ", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };
    act(() => {
      root.render(
        <FeatureToggleSwitch
          checked
          disabled
          onChange={() => undefined}
          ariaLabel="機能を非表示にする"
          size="sm"
          className="docs-switch"
          thumbClassName="docs-thumb"
        />,
      );
    });
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.className).toContain("h-6 w-9");
    expect(button.querySelector(".niho-feature-toggle-switch__track")?.className).toContain("h-5 w-9");
    expect(button.className).toContain("docs-switch");
    expect(button.querySelector(".niho-feature-toggle-switch__thumb")?.className).toContain("docs-thumb");
  });
});
