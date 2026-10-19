// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { UPDATE_RESTART_STALL_MS, UpdateNotice } from "../src/components/UpdateNotice";
import type { UpdateStatus } from "../src/lib/bridge";
import { button, click } from "./dom";
import { FakeBridge } from "./fake-bridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);

afterEach(() => {
  act(() => root.render(null));
  vi.useRealTimers();
});

async function show(bridge: FakeBridge) {
  await act(async () => {
    root.render(<UpdateNotice bridge={bridge} />);
  });
}

it("自動更新を使っていない間（公開鍵が未設定・開発ビルド）は何も出さない", async () => {
  await show(new FakeBridge());
  expect(container.textContent).toBe("");
});

it("裏の確認が新しい版を取得したら「新しい版があります」と「更新して再起動」を出し、閉じられる", async () => {
  const bridge = new FakeBridge();
  bridge.update = { enabled: true, stagedVersion: null };
  await show(bridge);
  expect(container.textContent).toBe("");

  await act(async () => bridge.stageUpdate("0.1.1"));
  const notice = container.querySelector('[role="status"]');
  expect(notice?.textContent).toContain("新しい版 0.1.1 があります");
  expect(button(container, "更新して再起動").disabled).toBe(false);

  await click(button(container, "×"));
  expect(container.textContent).toBe("");
  expect(bridge.restartCalls).toEqual([]);
});

it("「更新して再起動」は動いている処理が無ければそのまま開き直し、押せないまま待つ", async () => {
  const bridge = new FakeBridge();
  bridge.update = { enabled: true, stagedVersion: "0.1.2" };
  await show(bridge);

  await click(button(container, "更新して再起動"));
  expect(bridge.restartCalls).toEqual([false]);
  expect(button(container, "更新して再起動").disabled).toBe(true);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("取得済みの版より先の最新版を待ち、取得中は二重に再起動を頼まない", async () => {
  const bridge = new FakeBridge();
  bridge.update = { enabled: true, stagedVersion: "0.1.2" };
  let finish: (() => void) | undefined;
  bridge.restartToUpdate = async (force) => {
    bridge.restartCalls.push(force);
    await new Promise<void>((resolve) => { finish = resolve; });
    bridge.stageUpdate("0.1.9");
    return "restarting";
  };
  await show(bridge);

  await click(button(container, "更新して再起動"));
  expect(container.textContent).toContain("最新版を確認・取得しています");
  expect(button(container, "更新して再起動").disabled).toBe(true);
  await click(button(container, "更新して再起動"));
  expect(bridge.restartCalls).toEqual([false]);
  await act(async () => finish?.());
  expect(container.textContent).toContain("新しい版 0.1.9 があります");
  expect(container.textContent).not.toContain("0.1.2");
  expect(button(container, "更新して再起動").disabled).toBe(true);
});

it("最新版の確認・取得が失敗したら再試行でき、古い取得済みの版への開き直しを促さない", async () => {
  const bridge = new FakeBridge();
  bridge.update = { enabled: true, stagedVersion: "0.1.2" };
  bridge.restartToUpdate = async () => "refreshFailed";
  await show(bridge);

  await click(button(container, "更新して再起動"));
  expect(container.textContent).toContain("最新版を取得できませんでした");
  expect(container.textContent).not.toContain("閉じて開き直す");
  expect(button(container, "更新して再起動").disabled).toBe(false);

  bridge.restartToUpdate = async () => {
    bridge.stageUpdate("0.1.9");
    return "restarting";
  };
  await click(button(container, "更新して再起動"));
  expect(container.textContent).toContain("0.1.9");
  expect(container.textContent).not.toContain("取得できませんでした");
});

it("停止確認後に最新版の取得が失敗しても確認を閉じて再試行できる", async () => {
  const bridge = new FakeBridge();
  bridge.update = { enabled: true, stagedVersion: "0.1.2" };
  bridge.updateBusy = true;
  await show(bridge);
  await click(button(container, "更新して再起動"));
  bridge.restartToUpdate = async () => "refreshFailed";
  await click(button(container, "止めて再起動"));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("最新版を取得できませんでした");
  expect(button(container, "更新して再起動").disabled).toBe(false);
});

it("工程・会話・文字起こしが動いている間は、止めてよいか確かめてから開き直す（あとで なら何もしない）", async () => {
  const bridge = new FakeBridge();
  bridge.update = { enabled: true, stagedVersion: "0.1.2" };
  bridge.updateBusy = true;
  await show(bridge);

  await click(button(container, "更新して再起動"));
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("動いている処理を止めて再起動しますか？");
  await click(button(container, "あとで"));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(bridge.restartCalls).toEqual([false]);

  await click(button(container, "更新して再起動"));
  await click(button(container, "止めて再起動"));
  expect(bridge.restartCalls).toEqual([false, false, true]);
});

it("再起動を頼めなかったときは、開き直せば切り替わることを出す", async () => {
  const bridge = new FakeBridge();
  bridge.update = { enabled: true, stagedVersion: "0.1.2" };
  bridge.restartToUpdate = async () => {
    throw new Error("ipc");
  };
  await show(bridge);

  await click(button(container, "更新して再起動"));
  expect(container.querySelector('[role="status"]')?.textContent).toContain("再起動できませんでした。閉じて開き直すと 0.1.2 になります。");
});

it("再起動を頼んでもアプリが閉じなければ、しばらくして開き直す案内に切り替える", async () => {
  vi.useFakeTimers();
  const bridge = new FakeBridge();
  bridge.update = { enabled: true, stagedVersion: "0.1.2" };
  await show(bridge);

  await click(button(container, "更新して再起動"));
  expect(button(container, "更新して再起動").disabled).toBe(true);
  await act(async () => {
    vi.advanceTimersByTime(UPDATE_RESTART_STALL_MS - 1);
  });
  expect(button(container, "更新して再起動").disabled).toBe(true);
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(container.querySelector('[role="status"]')?.textContent).toContain("再起動できませんでした。閉じて開き直すと 0.1.2 になります。");
});

it("別の NIHO docs が工程を実行している間は、確かめずに断り、止めて再起動も出さない", async () => {
  const bridge = new FakeBridge();
  bridge.update = { enabled: true, stagedVersion: "0.1.2" };
  bridge.updateBusy = true;
  bridge.updateOtherApp = true;
  await show(bridge);

  await click(button(container, "更新して再起動"));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toContain("別の NIHO docs で工程が動いています。");
  // 終われば、もう一度押して開き直せる
  bridge.updateOtherApp = false;
  bridge.updateBusy = false;
  expect(button(container, "更新して再起動").disabled).toBe(false);
  await click(button(container, "更新して再起動"));
  expect(bridge.restartCalls).toEqual([false, false]);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("新しい版 0.1.2 があります");
});

it("取得した後に届いた古い状態では消えない", async () => {
  const handlers: Array<(status: UpdateStatus) => void> = [];
  const bridge = {
    watchUpdate: async (handler: (status: UpdateStatus) => void) => {
      handlers.push(handler);
      return () => undefined;
    },
    restartToUpdate: async () => "restarting" as const,
  };
  await act(async () => {
    root.render(<UpdateNotice bridge={bridge} />);
  });
  await act(async () => handlers[0]?.({ enabled: true, stagedVersion: "0.1.1" }));
  await act(async () => handlers[0]?.({ enabled: true, stagedVersion: null }));
  expect(container.textContent).toContain("0.1.1");
});
