import { describe, expect, it } from "vitest";
import { changedOnDeviceText, otherDeviceLabel, updatedOnDeviceText, withDeviceLabel } from "../src/lib/cloud-device";

/** クラウドの版を書いた他の端末の呼び名（#18750）。 */
describe("otherDeviceLabel", () => {
  it("種類があれば種類で呼ぶ（端末 ID より優先）", () => {
    expect(otherDeviceLabel({ deviceId: "d_mac", deviceKind: "mac" })).toBe("別の Mac");
    expect(otherDeviceLabel({ deviceId: "pwa_x", deviceKind: "browser" })).toBe("PC のブラウザ");
    expect(otherDeviceLabel({ deviceId: "pwa_x", deviceKind: "phone" })).toBe("スマホ");
    expect(otherDeviceLabel({ deviceId: "d_mac", deviceKind: "phone" })).toBe("スマホ");
  });

  it("種類の無い旧 client の版は端末 ID の形で見分け、どれでもなければ「別の端末」", () => {
    expect(otherDeviceLabel({ deviceId: "pwa_0123", deviceKind: null })).toBe("ブラウザ");
    expect(otherDeviceLabel({ deviceId: "d_AAAA" })).toBe("別の Mac");
    expect(otherDeviceLabel({ deviceId: "docs-run", deviceKind: null })).toBe("別の端末");
    expect(otherDeviceLabel({ deviceId: null, deviceKind: null })).toBe("別の端末");
    expect(otherDeviceLabel(null)).toBe("別の端末");
    expect(otherDeviceLabel(undefined)).toBe("別の端末");
  });
});

describe("端末を名指す知らせ", () => {
  it("英字で終わる呼び名の後ろだけ半角の空白を入れる", () => {
    expect(withDeviceLabel("別の Mac", "で変更")).toBe("別の Mac で変更");
    expect(withDeviceLabel("スマホ", "で変更")).toBe("スマホで変更");
  });

  it("更新された・両方で変更された", () => {
    expect(updatedOnDeviceText({ deviceId: "d_mac", deviceKind: "mac" })).toBe("別の Mac で更新されています。");
    expect(updatedOnDeviceText({ deviceId: "pwa_x", deviceKind: "phone" })).toBe("スマホで更新されています。");
    expect(updatedOnDeviceText({ deviceId: "pwa_x", deviceKind: "browser" })).toBe("PC のブラウザで更新されています。");
    expect(updatedOnDeviceText(null)).toBe("別の端末で更新されています。");
    expect(changedOnDeviceText({ deviceId: "d_mac", deviceKind: "mac" })).toBe("別の Mac でも変更されています。");
    expect(changedOnDeviceText({ deviceId: "pwa_x", deviceKind: "phone" })).toBe("スマホでも変更されています。");
    expect(changedOnDeviceText({ deviceId: "pwa_x" })).toBe("ブラウザでも変更されています。");
    expect(changedOnDeviceText(null)).toBe("別の端末でも変更されています。");
  });
});
