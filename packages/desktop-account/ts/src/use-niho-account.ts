/**
 * `useNihoAccount()`: Tauri の plugin `niho-desktop-account` の commands と event を包む（Next・web に依存しない）。
 * 画面に渡るのは状態・プロフィール・顔写真の URL・操作の進行・通知だけ（token は Rust の中。spec 決まりごと 11）。
 *
 * - 先に `niho-account://changed` を購読してから `account_state` を読む（読むまでのあいだに変わっても取りこぼさない）。
 * - 操作（ログイン・やめる・ログアウト・マイページ）は二重実行しない（`busy`）。失敗は `notice`（文言は `account-copy.ts`）。
 * - 「ログインしました」はログイン中→ログイン済みの変化で、「ログアウトしました」はログアウトの成功で出す。
 * - `logout({ everywhere: true })` は「ほかの端末でもログアウトする」（Rust が `POST /api/auth/sign-out-everywhere` を呼び、通ったときだけ
 *   この Mac もログアウトする）。成功は「ほかの端末でもログアウトしました」、失敗はこの Mac がログイン済みのままの文言（spec §画面
 *   「ログアウトの確認」）。確認のダイアログは呼び出し側（`niho-ui` の `confirmAccountLogout`）。
 * - deep link の処理の失敗（コードの期限切れなど）は Rust が `niho-account://login-failed` で知らせる。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ACCOUNT_CHANGED_EVENT,
  ACCOUNT_COMMANDS,
  ACCOUNT_LOGIN_FAILED_EVENT,
  type AccountLogoutArgs,
  type AccountTransport,
} from "./account-bridge";
import { ACCOUNT_TOAST_COPY, accountErrorMessage, type AccountLang } from "./account-copy";
import { accountProfileOf, parseAccountError, parseAccountState, type AccountState } from "./account-state";
import { createTauriAccountTransport } from "./tauri-account-transport";

export type AccountNotice = {
  kind: "signedIn" | "signedOut" | "error";
  message: string;
  /** `error` のときの Rust の code */
  code?: string;
};

export type AccountAction = "beginLogin" | "cancelLogin" | "logout" | "openMyPage";

export type AccountLogoutOptions = {
  /** 「ほかの端末でもログアウトする」（既定 false） */
  everywhere?: boolean;
};

export type NihoAccount = {
  /** 読めるまでは null（画面は人型のボタンだけ出す） */
  state: AccountState | null;
  /** 顔写真の `<img src>`（この Mac のファイル。無ければ null） */
  avatarSrc: string | null;
  /** 進行中の操作 */
  busy: AccountAction | null;
  notice: AccountNotice | null;
  dismissNotice: () => void;
  beginLogin: () => Promise<void>;
  cancelLogin: () => Promise<void>;
  /** ログアウト。成功で true（失敗は `notice` に出し、この Mac の状態は変わらない） */
  logout: (options?: AccountLogoutOptions) => Promise<boolean>;
  openMyPage: () => Promise<void>;
};

export type UseNihoAccountOptions = {
  /** テスト・プレビュー用の差し替え。既定は Tauri */
  transport?: AccountTransport;
  lang?: AccountLang;
};

let defaultTransport: AccountTransport | null = null;

function resolveTransport(transport: AccountTransport | undefined): AccountTransport {
  if (transport) return transport;
  defaultTransport ??= createTauriAccountTransport();
  return defaultTransport;
}

export function useNihoAccount(options: UseNihoAccountOptions = {}): NihoAccount {
  const lang = options.lang ?? "ja";
  const transportOption = options.transport;
  const transport = useMemo(() => resolveTransport(transportOption), [transportOption]);
  const [state, setState] = useState<AccountState | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<AccountAction | null>(null);
  const [notice, setNotice] = useState<AccountNotice | null>(null);
  const previousKind = useRef<AccountState["kind"] | null>(null);
  const busyRef = useRef<AccountAction | null>(null);

  const apply = useCallback(
    (next: AccountState) => {
      const previous = previousKind.current;
      previousKind.current = next.kind;
      setState(next);
      setVersion((current) => current + 1);
      if (previous === "signingIn" && next.kind === "signedIn") {
        setNotice({ kind: "signedIn", message: ACCOUNT_TOAST_COPY[lang].signedIn });
      }
    },
    [lang],
  );

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    // 購読のあと、最初の読み取り（account_state）が返る前に event が来たら、その event の方が新しい（読み取りの返りは捨てる）
    let sawEvent = false;
    void (async () => {
      let offChanged: (() => void) | null = null;
      let offFailed: (() => void) | null = null;
      try {
        offChanged = await transport.listen<unknown>(ACCOUNT_CHANGED_EVENT, (event) => {
          const parsed = parseAccountState(event.payload);
          if (parsed && active) {
            sawEvent = true;
            apply(parsed);
          }
        });
        offFailed = await transport.listen<unknown>(ACCOUNT_LOGIN_FAILED_EVENT, (event) => {
          const error = parseAccountError(event.payload);
          const message = accountErrorMessage(error, lang);
          if (message && active) setNotice({ kind: "error", code: error.code, message });
        });
      } catch {
        // Tauri の外（ブラウザでの開発）: 購読できない。状態は読めた分だけ出す
      }
      const off = () => {
        offChanged?.();
        offFailed?.();
      };
      if (!active) {
        off();
        return;
      }
      unlisten = off;
      try {
        const current = parseAccountState(await transport.invoke<unknown>(ACCOUNT_COMMANDS.state));
        if (current && active && !sawEvent) apply(current);
      } catch {
        // 読めなければ人型のボタンだけ（状態は null のまま）
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [transport, apply, lang]);

  /** 操作を 1 本ずつ実行する。成功で true（実行中で受け付けなかった・失敗は false） */
  const run = useCallback(
    async (action: AccountAction, command: string, args?: Record<string, unknown>, after?: () => void): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = action;
      setBusy(action);
      try {
        await (args ? transport.invoke<unknown>(command, args) : transport.invoke<unknown>(command));
        after?.();
        return true;
      } catch (raw) {
        const error = parseAccountError(raw);
        const message = accountErrorMessage(error, lang);
        if (message) setNotice({ kind: "error", code: error.code, message });
        return false;
      } finally {
        busyRef.current = null;
        setBusy(null);
      }
    },
    [transport, lang],
  );

  const beginLogin = useCallback(async () => {
    await run("beginLogin", ACCOUNT_COMMANDS.beginLogin);
  }, [run]);
  const cancelLogin = useCallback(async () => {
    await run("cancelLogin", ACCOUNT_COMMANDS.cancelLogin);
  }, [run]);
  const logout = useCallback(
    (options: AccountLogoutOptions = {}) => {
      const everywhere = options.everywhere === true;
      const args: AccountLogoutArgs | undefined = everywhere ? { everywhere: true } : undefined;
      return run("logout", ACCOUNT_COMMANDS.logout, args, () => {
        const copy = ACCOUNT_TOAST_COPY[lang];
        setNotice({ kind: "signedOut", message: everywhere ? copy.signedOutEverywhere : copy.signedOut });
      });
    },
    [run, lang],
  );
  const openMyPage = useCallback(async () => {
    await run("openMyPage", ACCOUNT_COMMANDS.openMyPage);
  }, [run]);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const avatarSrc = useMemo(() => {
    const profile = accountProfileOf(state);
    if (!profile?.avatarPath || !transport.convertFileSrc) return null;
    const src = transport.convertFileSrc(profile.avatarPath);
    // ファイル名は固定（account-avatar.jpg）なので、状態が変わるたびに版を付けて WebView のキャッシュを避ける
    return `${src}${src.includes("?") ? "&" : "?"}v=${version}`;
  }, [state, transport, version]);

  return { state, avatarSrc, busy, notice, dismissNotice, beginLogin, cancelLogin, logout, openMyPage };
}
