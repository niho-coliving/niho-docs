/** 画面の数字の書き方（字数・送る量・所要・時刻・トークン）。 */

const numberFormat = new Intl.NumberFormat("ja-JP");

export function formatNumber(value: number): string {
  return numberFormat.format(Math.round(value));
}

/** 「31,240 字」 */
export function formatChars(chars: number): string {
  return `${formatNumber(chars)} 字`;
}

/** 送る量（「約 3.1 万字」「約 2,480 字」）。 */
export function formatSendAmount(chars: number): string {
  if (chars >= 10_000) return `約 ${(chars / 10_000).toFixed(1)} 万字`;
  return `約 ${formatNumber(chars)} 字`;
}

/** 所要（「2 分 14 秒」「48 秒」「1 時間 2 分」）。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 時間 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/** 実行中の経過（「0:41」「12:05」）。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** 音声の長さ（「1:12:34」「48:12」）。 */
export function formatAudioLength(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0");
  const ss = String(secs).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 録音中の経過（「00:05」「23:45」「1:02:03」）。 */
export function formatRecordingTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 録音の長さのおおよそ（「45 秒」「23 分」「1 時間 2 分」）。 */
export function formatRecordingLength(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分`;
}

/** 使用量のトークン（「422k」「1.2M」「980」）。 */
export function formatTokensShort(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** 履歴の日時（「10/13 14:10」）。 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`;
}

/** 工程の id の文字（Rust の store.rs の ID_ALPHABET と同じ。紛らわしい l・o・0・1 を除く 32 字）。 */
const STEP_ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** 工程設計で足す工程の id（8 字。成果物のファイル名になるので Rust の validate_id を通る形）。 */
export function newStepId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  // 256 は 32 で割り切れるので、余りで選んでも偏らない
  return Array.from(bytes, (byte) => STEP_ID_ALPHABET.charAt(byte % STEP_ID_ALPHABET.length)).join("");
}

/** 依頼・記録の id（Rust の safe_id に合う英数字とハイフン）。 */
export function newId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}
