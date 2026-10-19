/**
 * 本番の transport（Tauri の `invoke` / `listen` / `convertFileSrc`）。Tauri の import はこのファイルだけ。
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { AccountTransport } from "./account-bridge";

export function createTauriAccountTransport(): AccountTransport {
  return {
    invoke: (command, args) => invoke(command, args),
    listen: (event, handler) => listen(event, handler),
    convertFileSrc: (path) => convertFileSrc(path),
  };
}
