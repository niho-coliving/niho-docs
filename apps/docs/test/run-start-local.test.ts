import { describe, expect, it } from "vitest";
import { setupQueueOf, startRouteOf } from "../src/lib/run-start";

describe("LOCAL の NIHO API 実行経路", () => {
  it("確定原文の後は単工程も本人 Mac の一時配送で実行する", () => {
    expect(startRouteOf({ queue: ["fix"], step: true, action: null, continuation: "niho_api", localStorage: true,
      deviceDeliveryAvailable: true }))
      .toEqual({ route: { kind: "generation_only", executor: "device_niho_api" }, chainToCloud: false });
    expect(setupQueueOf(["fix"], true, "niho_api", true, true)).toBeNull();
  });

  it("原文がまだない作成は先に Mac で文字起こしし、後続へつなぐ", () => {
    expect(startRouteOf({ queue: ["source", "fix"], step: false, action: "create", continuation: "niho_api", localStorage: true }))
      .toEqual({ route: { kind: "local_transcription_only" }, chainToCloud: true });
  });

  it("CLOUD の続きは既存の niho_api 経路を保つ", () => {
    expect(startRouteOf({ queue: ["fix"], step: false, action: "continue", continuation: "niho_api", localStorage: false }))
      .toEqual({ route: { kind: "generation_only", executor: "niho_api" }, chainToCloud: false });
    expect(startRouteOf({ queue: ["source"], step: true, action: null, continuation: "niho_api", localStorage: true }))
      .toEqual({ route: { kind: "local_transcription_only" }, chainToCloud: false });
  });

  it("非公開 API の配備前は LOCAL の端末配送へ切り替えない", () => {
    expect(startRouteOf({ queue: ["fix"], step: true, action: null, continuation: "niho_api", localStorage: true }))
      .toEqual({ route: { kind: "generation_only", executor: "this_pc" }, chainToCloud: false });
    expect(setupQueueOf(["fix"], true, "niho_api", true)).toEqual(["fix"]);
  });
});
