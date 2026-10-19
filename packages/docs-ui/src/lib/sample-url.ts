import type { DocsHost } from "../host/DocsHost";

/** 取得先の検証と本文の抽出は host の安全境界で行う。 */
export function importSampleUrl(host: DocsHost, flowId: string, url: string) {
  if (!host.importSampleUrl) return Promise.reject(new Error("この画面では URL からのお手本を追加できません。"));
  return host.importSampleUrl(flowId, url);
}
