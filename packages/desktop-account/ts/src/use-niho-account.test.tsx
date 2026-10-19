// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACCOUNT_CHANGED_EVENT, ACCOUNT_COMMANDS, ACCOUNT_LOGIN_FAILED_EVENT, type AccountTransport } from "./account-bridge";
import { useNihoAccount, type NihoAccount } from "./use-niho-account";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const profile = { userId: "u1", displayName: "たくや", handle: "takuya", avatarPath: "/data/account-avatar.jpg", connectionId: "c1" };

type Fake = {
  transport: AccountTransport;
  order: string[];
  /** invoke に渡った引数（command ごとの最後） */
  args: Record<string, Record<string, unknown> | undefined>;
  emit: (event: string, payload: unknown) => void;
  unlistened: number;
  answers: Record<string, () => Promise<unknown>>;
};

function fakeTransport(initialState: unknown): Fake {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const fake: Fake = {
    order: [],
    args: {},
    unlistened: 0,
    answers: {},
    emit: (event, payload) => handlers.get(event)?.({ payload }),
    transport: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        fake.order.push(`invoke ${command}`);
        fake.args[command] = args;
        const answer = fake.answers[command];
        if (answer) return (await answer()) as T;
        if (command === ACCOUNT_COMMANDS.state) return initialState as T;
        return undefined as T;
      },
      listen: async <T,>(event: string, handler: (event: { payload: T }) => void) => {
        fake.order.push(`listen ${event}`);
        handlers.set(event, handler as (event: { payload: unknown }) => void);
        return () => {
          handlers.delete(event);
          fake.unlistened += 1;
        };
      },
      convertFileSrc: (path) => `asset://localhost/${encodeURIComponent(path)}`,
    },
  };
  return fake;
}

let container: HTMLDivElement;
let root: Root;
let latest: NihoAccount | null = null;

function Probe({ transport }: { transport: AccountTransport }) {
  latest = useNihoAccount({ transport });
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(fake: Fake) {
  await act(async () => {
    root.render(<Probe transport={fake.transport} />);
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("useNihoAccount", () => {
  it("subscribes before reading the state and exposes the parsed state and avatar", async () => {
    const fake = fakeTransport({ kind: "signedIn", profile });
    await mount(fake);
    expect(fake.order).toEqual([
      `listen ${ACCOUNT_CHANGED_EVENT}`,
      `listen ${ACCOUNT_LOGIN_FAILED_EVENT}`,
      `invoke ${ACCOUNT_COMMANDS.state}`,
    ]);
    expect(latest?.state).toEqual({ kind: "signedIn", profile });
    expect(latest?.avatarSrc).toMatch(/^asset:\/\/localhost\/%2Fdata%2Faccount-avatar\.jpg\?v=\d+$/);
    expect(latest?.busy).toBeNull();
    expect(latest?.notice).toBeNull();
  });

  it("follows the changed event, ignores broken payloads and toasts signed in after signing in", async () => {
    const fake = fakeTransport({ kind: "signedOut" });
    await mount(fake);
    expect(latest?.state).toEqual({ kind: "signedOut" });
    await act(async () => {
      fake.emit(ACCOUNT_CHANGED_EVENT, { kind: "signingIn", sinceMs: 5 });
    });
    expect(latest?.state?.kind).toBe("signingIn");
    expect(latest?.notice).toBeNull();
    await act(async () => {
      fake.emit(ACCOUNT_CHANGED_EVENT, { kind: "nonsense" });
    });
    expect(latest?.state?.kind).toBe("signingIn");
    await act(async () => {
      fake.emit(ACCOUNT_CHANGED_EVENT, { kind: "signedIn", profile });
    });
    expect(latest?.state?.kind).toBe("signedIn");
    expect(latest?.notice).toEqual({ kind: "signedIn", message: "ログインしました" });
    await act(async () => {
      latest?.dismissNotice();
    });
    expect(latest?.notice).toBeNull();
    // 更新（ログイン済み → ログイン済み）では出さない
    await act(async () => {
      fake.emit(ACCOUNT_CHANGED_EVENT, { kind: "signedIn", profile: { ...profile, displayName: "名前" } });
    });
    expect(latest?.notice).toBeNull();
    expect(latest?.state).toEqual({ kind: "signedIn", profile: { ...profile, displayName: "名前" } });
  });

  it("runs one action at a time and reports command failures with the Japanese copy", async () => {
    const fake = fakeTransport({ kind: "signedOut" });
    let resolveBegin: (() => void) | null = null;
    fake.answers[ACCOUNT_COMMANDS.beginLogin] = () =>
      new Promise<void>((resolve) => {
        resolveBegin = resolve;
      });
    await mount(fake);
    let first: Promise<void> | undefined;
    await act(async () => {
      first = latest?.beginLogin();
      void latest?.beginLogin();
    });
    expect(latest?.busy).toBe("beginLogin");
    expect(fake.order.filter((entry) => entry === `invoke ${ACCOUNT_COMMANDS.beginLogin}`)).toHaveLength(1);
    await act(async () => {
      resolveBegin?.();
      await first;
    });
    expect(latest?.busy).toBeNull();

    fake.answers[ACCOUNT_COMMANDS.beginLogin] = async () => {
      throw { code: "browser_failed", message: "ブラウザを開けませんでした。もう一度お試しください。" };
    };
    await act(async () => {
      await latest?.beginLogin();
    });
    expect(latest?.notice).toEqual({
      kind: "error",
      code: "browser_failed",
      message: "ブラウザを開けませんでした。もう一度お試しください。",
    });
  });

  it("toasts signed out after a successful logout and shows login failures from the Rust side", async () => {
    const fake = fakeTransport({ kind: "signedIn", profile });
    await mount(fake);
    let succeeded: boolean | undefined;
    await act(async () => {
      succeeded = await latest?.logout();
    });
    expect(succeeded).toBe(true);
    expect(fake.order).toContain(`invoke ${ACCOUNT_COMMANDS.logout}`);
    // この端末だけのログアウトは引数なし（Rust の既定 everywhere = false）
    expect(fake.args[ACCOUNT_COMMANDS.logout]).toBeUndefined();
    expect(latest?.notice).toEqual({ kind: "signedOut", message: "ログアウトしました" });

    await act(async () => {
      fake.emit(ACCOUNT_LOGIN_FAILED_EVENT, { code: "code_expired", message: "x" });
    });
    expect(latest?.notice).toEqual({
      kind: "error",
      code: "code_expired",
      message: "時間切れです。もう一度「NIHO でログイン」を押してください。",
    });
    // 画面に出さない code は無視
    await act(async () => {
      latest?.dismissNotice();
      fake.emit(ACCOUNT_LOGIN_FAILED_EVENT, { code: "callback_duplicate", message: "" });
    });
    expect(latest?.notice).toBeNull();
  });

  it("logout({ everywhere: true }) passes the argument and toasts the all-devices result", async () => {
    const fake = fakeTransport({ kind: "signedIn", profile });
    await mount(fake);
    let succeeded: boolean | undefined;
    await act(async () => {
      succeeded = await latest?.logout({ everywhere: true });
    });
    expect(succeeded).toBe(true);
    expect(fake.args[ACCOUNT_COMMANDS.logout]).toEqual({ everywhere: true });
    expect(latest?.notice).toEqual({ kind: "signedOut", message: "ほかの端末でもログアウトしました" });
  });

  it("logout({ everywhere: true }) failure keeps this Mac signed in and shows the spec failure line", async () => {
    const fake = fakeTransport({ kind: "signedIn", profile });
    fake.answers[ACCOUNT_COMMANDS.logout] = async () => {
      throw { code: "sign_out_everywhere_failed", message: "untrusted" };
    };
    await mount(fake);
    let succeeded: boolean | undefined;
    await act(async () => {
      succeeded = await latest?.logout({ everywhere: true });
    });
    expect(succeeded).toBe(false);
    expect(latest?.state?.kind).toBe("signedIn");
    expect(latest?.busy).toBeNull();
    expect(latest?.notice).toEqual({
      kind: "error",
      code: "sign_out_everywhere_failed",
      message: "ほかの端末をログアウトできませんでした。通信を確かめて、もう一度お試しください。",
    });
  });

  it("invokes the other commands and unsubscribes on unmount", async () => {
    const fake = fakeTransport({ kind: "signedOut" });
    await mount(fake);
    await act(async () => {
      await latest?.cancelLogin();
      await latest?.openMyPage();
    });
    expect(fake.order).toContain(`invoke ${ACCOUNT_COMMANDS.cancelLogin}`);
    expect(fake.order).toContain(`invoke ${ACCOUNT_COMMANDS.openMyPage}`);
    await act(async () => {
      root.unmount();
    });
    expect(fake.unlistened).toBe(2);
    root = createRoot(container);
  });

  it("keeps a newer changed event over a slower initial account_state answer", async () => {
    const fake = fakeTransport({ kind: "signedOut" });
    let answerState: (() => void) | null = null;
    fake.answers[ACCOUNT_COMMANDS.state] = () =>
      new Promise<unknown>((resolve) => {
        answerState = () => resolve({ kind: "signedOut" });
      });
    await mount(fake);
    expect(latest?.state).toBeNull();
    await act(async () => {
      fake.emit(ACCOUNT_CHANGED_EVENT, { kind: "signingIn", sinceMs: 1 });
    });
    expect(latest?.state?.kind).toBe("signingIn");
    await act(async () => {
      answerState?.();
      await flush();
    });
    expect(latest?.state?.kind).toBe("signingIn");
  });

  it("has no avatar without convertFileSrc or without a saved photo", async () => {
    const fake = fakeTransport({ kind: "signedIn", profile: { ...profile, avatarPath: null } });
    await mount(fake);
    expect(latest?.avatarSrc).toBeNull();
    const plain = fakeTransport({ kind: "offline", profile });
    delete plain.transport.convertFileSrc;
    await act(async () => {
      root.render(<Probe transport={plain.transport} />);
    });
    await flush();
    expect(latest?.state?.kind).toBe("offline");
    expect(latest?.avatarSrc).toBeNull();
  });
});
