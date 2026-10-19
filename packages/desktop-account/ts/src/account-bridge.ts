/**
 * Tauri の plugin `niho-desktop-account`（Rust: `niho_desktop_account::tauri`）の commands と event の名前と、画面側から
 * 呼ぶための口（`AccountTransport`）。Tauri 本体の import は `tauri-account-transport.ts` だけに置き、ここと hook は
 * テストで偽の transport を渡せるようにする。
 */

export const ACCOUNT_PLUGIN = "niho-desktop-account";

/** 状態が変わったときの event（payload は `AccountState`）。Rust の `CHANGED_EVENT` と同じ。 */
export const ACCOUNT_CHANGED_EVENT = "niho-account://changed";
/** deep link の処理（コードの交換）に失敗したときの event（payload は `AccountError`）。Rust の `LOGIN_FAILED_EVENT` と同じ。 */
export const ACCOUNT_LOGIN_FAILED_EVENT = "niho-account://login-failed";

/** `account_logout` の引数（Rust の `everywhere: Option<bool>`。既定 false）。 */
export type AccountLogoutArgs = { everywhere: boolean };

export const ACCOUNT_COMMANDS = {
  state: `plugin:${ACCOUNT_PLUGIN}|account_state`,
  beginLogin: `plugin:${ACCOUNT_PLUGIN}|account_begin_login`,
  cancelLogin: `plugin:${ACCOUNT_PLUGIN}|account_cancel_login`,
  logout: `plugin:${ACCOUNT_PLUGIN}|account_logout`,
  openMyPage: `plugin:${ACCOUNT_PLUGIN}|account_open_my_page`,
} as const;

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
/** Tauri の event の購読（戻り値で購読をやめる）。 */
export type Listen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

export type AccountTransport = {
  invoke: Invoke;
  listen: Listen;
  /** この Mac のファイルのパスを `<img src>` に出せる URL にする（Tauri の `convertFileSrc`）。無ければ顔写真を出さない */
  convertFileSrc?: (path: string) => string;
};
