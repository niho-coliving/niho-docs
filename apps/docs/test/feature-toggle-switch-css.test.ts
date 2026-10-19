import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * FeatureToggleSwitch の形（absolute・丸み）は Tailwind の utilities で付くが、NIHO docs の Tailwind は .docs-account の
 * 中だけに閉じている（postcss.config.cjs）。設定の「この Mac で続きを受ける」・文字起こしの時刻の切り替えのスイッチは外の面に
 * あるので、track が幅も高さも持たない inline の span になり、ON でも OFF でも見えなかった。形を app.css で宣言しているかを見る
 * （jsdom は寸法を計算しないので、宣言を読む）。
 */
function rule(selector: string): string {
  const css = readFileSync(join(__dirname, "../../../packages/docs-ui/src/styles/app.css"), "utf8").replaceAll(":where([data-docs-app-root]):where([data-docs-shared-ui]) ", "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`app.css に ${selector} の規則がありません`);
  return match[1]!;
}

describe("docs のスイッチは Tailwind が無くても形を持つ", () => {
  it("track は absolute で丸く、幅と高さを持つ", () => {
    const track = rule(".docs-feature-toggle-switch .niho-feature-toggle-switch__track");
    expect(track).toMatch(/position:\s*absolute/);
    expect(track).toMatch(/display:\s*block/);
    expect(track).toMatch(/border-radius:/);
    expect(track).toMatch(/width:\s*\d+px/);
    expect(track).toMatch(/height:\s*\d+px/);
  });

  it("thumb は block で、押せないときはボタンごと薄くなる", () => {
    expect(rule(".docs-feature-toggle-switch__thumb")).toMatch(/display:\s*block/);
    expect(rule(".docs-feature-toggle-switch:disabled")).toMatch(/opacity:/);
  });
});
