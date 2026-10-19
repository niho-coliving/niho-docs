import { NATIVE_DOCS_OPERATIONS, type DocsHost } from "../host/DocsHost";

export type HostCall = { operation: string; args: readonly unknown[] };

/**
 * 通信・OS に触れない host。テストで使う操作だけを実装し、未定義の共有操作は必ず拒否する。
 * native の省略は本物の Web host と同じ。保存や実行が成功したふりをする既定値は持たない。
 */
export function createFakeHost(operations: Partial<DocsHost>) {
  const calls: HostCall[] = [];
  const native = new Set<PropertyKey>(NATIVE_DOCS_OPERATIONS);
  const metadata = new Set<PropertyKey>(["capabilities", "audioSourceUrl", "explicitMediaLoad", "importSampleUrl", "then"]);
  const methods = new Map<PropertyKey, { source: unknown; method: unknown }>();
  const host = new Proxy(operations, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      const cached = methods.get(key);
      if (cached && cached.source === value) return cached.method;
      if (typeof value !== "function" && (value !== undefined || native.has(key) || metadata.has(key))) return value;
      const method = (...args: unknown[]) => {
        calls.push({ operation: String(key), args });
        if (typeof value === "function") return Reflect.apply(value, target, args) as unknown;
        return Promise.reject(new Error(`FakeHost: ${String(key)} が未定義です`));
      };
      methods.set(key, { source: value, method });
      return method;
    },
  }) as DocsHost;
  return { host, calls };
}
