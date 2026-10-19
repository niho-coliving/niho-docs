import { MAC_DOCS_CAPABILITIES, NATIVE_DOCS_OPERATIONS, type Bridge, type DocsHost } from "./DocsHost";

/**
 * 既存 controller を移す間の互換 adapter。native の未対応操作は必ず拒否する。
 * Web に成功する no-op を要求せず、元の host の構造化エラー・戻り値・this をそのまま保つ。
 * native 操作の有無の UI 判断には元の host / capabilities を使う。
 */
export function controllerHost(host: DocsHost): Bridge {
  const capabilities = Object.freeze({ ...MAC_DOCS_CAPABILITIES, ...host.capabilities, cloudSync: host.capabilities?.cloudSync ?? typeof host.cloudState === "function" });
  const native = new Set<PropertyKey>(NATIVE_DOCS_OPERATIONS);
  const bound = new Map<PropertyKey, { source: unknown; method: unknown }>();
  return new Proxy(host, {
    get(target, key) {
      if (key === "capabilities") return capabilities;
      const value: unknown = Reflect.get(target, key, target);
      const cached = bound.get(key);
      if (cached && cached.source === value) return cached.method;
      if (typeof value === "function") {
        const method: unknown = value.bind(target);
        bound.set(key, { source: value, method });
        return method;
      }
      if (value === undefined && native.has(key) && !["onFileDrop", "onCloseRequested", "watchUpdate", "restartToUpdate"].includes(String(key))) {
        const unsupported = () => Promise.reject({ code: "docs_host_unsupported", message: "この操作は現在の画面では使えません。", operation: String(key) });
        bound.set(key, { source: value, method: unsupported });
        return unsupported;
      }
      return value;
    },
  }) as Bridge;
}
