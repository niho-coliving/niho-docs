// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { PcRunnerSettings } from "../src/components/PcRunnerSettings";
import { errorMessage } from "../src/lib/bridge";
import {
  PC_RUNNER_BUSY_MESSAGE,
  pcRunnerErrorText,
  pcRunnerStatusLine,
  resolveThisMacSelection,
  type PcRunnerState,
} from "../src/lib/pc-runner";
import { FakeBridge } from "./fake-bridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);

afterEach(() => {
  act(() => root.render(null));
});

async function settle() {
  await act(async () => {
    for (let index = 0; index < 5; index++) await Promise.resolve();
  });
}

async function render(bridge: FakeBridge, signedIn: boolean) {
  act(() => root.render(<PcRunnerSettings bridge={bridge} signedIn={signedIn} />));
  await settle();
}

function toggle(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[role="switch"]')!;
}

const text = () => container.textContent ?? "";

describe("この Mac で続きを受ける（設定の行）", () => {
  it("ON にすると bridge を呼び、状態の 1 行を出す。OFF に戻せる", async () => {
    const bridge = new FakeBridge();
    await render(bridge, true);
    expect(text()).toContain("この Mac で続きを受ける");
    expect(text()).toContain("スマホで「自分の Mac で続ける」を選んだ録音の修正・整理を、この Mac の AI で実行します。");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().disabled).toBe(false);
    expect(container.querySelector('[role="status"]')).toBeNull();

    await act(async () => toggle().click());
    await settle();
    expect(bridge.pcRunnerCalls).toEqual([true]);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("待機中");

    // Rust の event で状態が変わる（実行中は工程名を出す）
    act(() => bridge.emitPcRunner({ enabled: true, state: "running", label: "文字起こしの修正", runnerId: "runner_mac_1" }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("処理中: 文字起こしの修正");
    act(() => bridge.emitPcRunner({ enabled: true, state: "needs_login", label: null, runnerId: "runner_mac_1" }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("NIHO アカウントでのログインが必要です");
    act(() => bridge.emitPcRunner({ enabled: true, state: "storage_unavailable", label: null, runnerId: "runner_mac_1" }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("保存先が NIHO クラウドであることを確認できません。設定の保存先を確認してください。");

    await act(async () => toggle().click());
    await settle();
    expect(bridge.pcRunnerCalls).toEqual([true, false]);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("ログインしていなければ ON にできず、その理由を出す（ON のままなら OFF にはできる）", async () => {
    const bridge = new FakeBridge();
    await render(bridge, false);
    expect(toggle().disabled).toBe(true);
    expect(text()).toContain("NIHO アカウントでログインすると使えます");

    const on = new FakeBridge();
    on.pcRunner = { enabled: true, state: "needs_login", label: null, runnerId: "runner_mac_1" };
    await render(on, false);
    expect(toggle().disabled).toBe(false);
    expect(text()).not.toContain("NIHO アカウントでログインすると使えます");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("NIHO アカウントでのログインが必要です");
  });

  it("失敗はスイッチの近くに 1 行で出し、Rust の文を素通ししない", async () => {
    const bridge = new FakeBridge();
    bridge.pcRunnerFailure = { code: "pc_runner_offline", message: "internal" };
    await render(bridge, true);
    await act(async () => toggle().click());
    await settle();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("NIHO に接続できません。接続を確かめてから、もう一度お試しください。");
    expect(toggle().getAttribute("aria-checked")).toBe("false");

    bridge.pcRunnerFailure = { code: "something_new", message: "lease generation 3" };
    await act(async () => toggle().click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("うまくいきませんでした。時間をおいてもう一度お試しください。");
    expect(text()).not.toContain("lease");

    // 次に成功したら消す
    await act(async () => toggle().click());
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });
});

describe("スマホからの依頼の実行中", () => {
  it("手元の実行は pc_runner_busy で断られ、画面の文で知らせる", async () => {
    const bridge = new FakeBridge();
    bridge.pcRunner = { enabled: true, state: "running", label: "整理", runnerId: "runner_mac_1" };
    const refused = await bridge.acquireRunLock("p1").then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({ code: "pc_runner_busy" });
    expect(errorMessage(refused, "失敗")).toBe(PC_RUNNER_BUSY_MESSAGE);
    expect(errorMessage({ code: "pc_runner_busy", message: "anything" }, "失敗")).toBe(
      "スマホから依頼された工程をこの Mac で実行しています。終わってからもう一度お試しください。",
    );
    expect(pcRunnerErrorText({ code: "pc_runner_busy", message: "x" })).toBe(PC_RUNNER_BUSY_MESSAGE);
    expect(pcRunnerErrorText({ code: "pc_runner_login_item_failed", message: "x" })).toBe("ログイン時に起動する設定を保存できませんでした。もう一度お試しください。");
    // 終われば手元で実行できる
    bridge.emitPcRunner({ enabled: true, state: "idle", label: null, runnerId: "runner_mac_1" });
    await expect(bridge.acquireRunLock("p1")).resolves.toBeUndefined();
  });

  it("状態の 1 行はメニューバーと同じ文", () => {
    expect(pcRunnerStatusLine({ enabled: true, state: "starting", label: null, runnerId: "runner_mac_1" })).toBe("準備中");
    expect(pcRunnerStatusLine({ enabled: true, state: "idle", label: null, runnerId: "runner_mac_1" })).toBe("待機中");
    expect(pcRunnerStatusLine({ enabled: true, state: "offline", label: null, runnerId: "runner_mac_1" })).toBe("NIHO に接続できません");
    expect(pcRunnerStatusLine({ enabled: true, state: "storage_unavailable", label: null, runnerId: "runner_mac_1" })).toBe("保存先が NIHO クラウドであることを確認できません。設定の保存先を確認してください。");
  });
});

describe("残りの工程でこの Mac を選べるか（#19107）", () => {
  it("ON で ID があれば、その ID で選べる（接続やログインの状態は問わない）", () => {
    expect(resolveThisMacSelection({ enabled: true, state: "idle", label: null, runnerId: "runner_mac_1" })).toEqual({ ok: true, runnerId: "runner_mac_1" });
    expect(resolveThisMacSelection({ enabled: true, state: "offline", label: null, runnerId: "runner_mac_1" })).toEqual({ ok: true, runnerId: "runner_mac_1" });
  });

  it("OFF なら、オンにする設定の名前と場所を案内する（ID が残っていても）", () => {
    const reason = "「この Mac」を選ぶには、先にこの画面の「この Mac で続きを受ける」をオンにしてください。";
    expect(resolveThisMacSelection({ enabled: false, state: "off", label: null, runnerId: null })).toEqual({ ok: false, reason });
    expect(resolveThisMacSelection({ enabled: false, state: "off", label: null, runnerId: "runner_mac_1" })).toEqual({ ok: false, reason });
  });

  it("ON でも ID がまだ無いときは、状態に合った案内にする（オンにしてくださいとは言わない）", () => {
    const of = (state: PcRunnerState) => resolveThisMacSelection({ enabled: true, state, label: null, runnerId: null });
    expect(of("starting")).toEqual({ ok: false, reason: "この Mac を登録しています。少し待ってから、もう一度「この Mac」を選んでください。" });
    expect(of("idle")).toMatchObject({ ok: false, reason: expect.stringContaining("登録しています") });
    expect(of("needs_login")).toEqual({
      ok: false,
      reason: "NIHO アカウントでのログインが必要です。ログインしてから、もう一度「この Mac」を選んでください。",
    });
    expect(of("offline")).toEqual({
      ok: false,
      reason: "NIHO に接続できません。接続を確かめてから、もう一度「この Mac」を選んでください。",
    });
    expect(of("storage_unavailable")).toEqual({
      ok: false,
      reason: "設定の保存先を NIHO クラウドに変更してから、もう一度「この Mac」を選んでください。",
    });
    for (const state of ["starting", "idle", "running", "needs_login", "offline"] as const) {
      expect(of(state)).toMatchObject({ ok: false, reason: expect.not.stringContaining("オンにしてください") });
    }
  });

  it("保存先が利用できない場合は、runner ID があっても設定変更を案内する", () => {
    expect(
      resolveThisMacSelection({
        enabled: true,
        state: "storage_unavailable",
        label: null,
        runnerId: "runner_mac_1",
      }),
    ).toEqual({
      ok: false,
      reason: "設定の保存先を NIHO クラウドに変更してから、もう一度「この Mac」を選んでください。",
    });
  });
});
