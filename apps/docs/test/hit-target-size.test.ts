import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 押せる範囲の最小は 24px（design-guide §8・WCAG 2.2 AA 2.5.8）。見た目の小さい部品（チップの ×・エディタの行の ＋ ⋮⋮）の
 * 押し先が 22px に戻らないよう、CSS の寸法を見る（jsdom は寸法を計算しないので、宣言を読む）。
 */
const MIN_HIT_PX = 24;

function rule(file: string, selector: string): string {
  const css = readFileSync(join(__dirname, "../../../packages/docs-ui/src/styles", file), "utf8").replaceAll(":where([data-docs-app-root]):where([data-docs-shared-ui]) ", "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`${file} に ${selector} の規則がありません`);
  return match[1]!;
}

function px(block: string, property: string): number {
  const match = new RegExp(`(?:^|[;\\s])${property}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(block);
  if (!match) throw new Error(`${property} が px で書かれていません`);
  return Number(match[1]);
}

describe("押し先の大きさ", () => {
  it.each([
    ["app.css", ".chip .x"],
    ["editor.css", ".be-hdl > button"],
    // 「AIと作る」の見出しの ⓘ（アイコンは 16px、押し先は 28px。owner 2026-10-18・#18941）
    ["chat.css", ".chat-info"],
  ])("%s の %s は幅・高さとも 24px 以上", (file, selector) => {
    const block = rule(file, selector);
    expect(px(block, "width")).toBeGreaterThanOrEqual(MIN_HIT_PX);
    expect(px(block, "height")).toBeGreaterThanOrEqual(MIN_HIT_PX);
  });

  it("話者の名前のボタンは、中の番号の丸（22px）ではなくボタン全体が押し先で、高さが 24px 以上", () => {
    expect(px(rule("app.css", ".speaker-pill"), "height")).toBeGreaterThanOrEqual(MIN_HIT_PX);
  });

  it("トーストの「元に戻す」（#18915）は高さが 24px 以上", () => {
    expect(px(rule("app.css", ".toast-action"), "min-height")).toBeGreaterThanOrEqual(MIN_HIT_PX);
  });
});
