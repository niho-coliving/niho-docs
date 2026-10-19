import { MAX_CONTINUATIONS } from "./rules.js";
import type { Connection, Effort, ProviderId } from "./types.js";

/**
 * CLI 実行基盤の契約（specs/initiatives/niho-docs.md §6.1）のイベントの schema。正はこのファイル（schemaVersion 1）。
 * Rust の型（apps/docs/src-tauri/src/contract.rs）は同じ形で、Tauri 側の adapter（local_ai.rs）が crate `niho-local-ai` の
 * イベントをこの形に写す。Tauri の command `run_turn(req, channel)` は `{ turnId, seq, event }` を流す。名前（enum の値・
 * フィールド名）は Rust の契約のまま（`Done.stop_reason === "MaxTokens"`）。
 * 共有の fixture `apps/docs/fixtures/turn-events/` を Rust のテストと docs-core のテストの両方が読む。
 */

export const TURN_EVENT_SCHEMA_VERSION = 1;

/**
 * 提供元。サブスクリプション方式は CLI（`ClaudeCode`・`CodexCli`・`GeminiCli`＝Antigravity CLI）、API キー方式は各社の API
 * （`AnthropicApi`＝Messages API・`OpenAiApi`＝Responses API・`GeminiApi`＝generateContent）。Rust の `contract::Provider` と同じ名前。
 */
export type ContractProvider = "ClaudeCode" | "CodexCli" | "GeminiCli" | "AnthropicApi" | "OpenAiApi" | "GeminiApi";

export const API_CONTRACT_PROVIDERS: readonly ContractProvider[] = ["AnthropicApi", "OpenAiApi", "GeminiApi"];

export function isApiProvider(provider: ContractProvider): boolean {
  return API_CONTRACT_PROVIDERS.includes(provider);
}
export type ContractEffort = "Low" | "Medium" | "High" | "Max";
export type StopReason = "EndTurn" | "MaxTokens" | "Stopped";
export type ReasonCode =
  | "CliLoginRequired"
  | "UsageLimitReached"
  | "NotConfigured"
  | "Unreachable"
  | "SessionNotFound"
  | "Timeout"
  | "InvalidStream"
  | "CliVersionMismatch"
  | "TransientFailure"
  | "ModelNotFound";

export const REASON_CODES: readonly ReasonCode[] = [
  "CliLoginRequired",
  "UsageLimitReached",
  "NotConfigured",
  "Unreachable",
  "SessionNotFound",
  "Timeout",
  "InvalidStream",
  "CliVersionMismatch",
  "TransientFailure",
  "ModelNotFound",
];

const STOP_REASONS: readonly StopReason[] = ["EndTurn", "MaxTokens", "Stopped"];

/**
 * 使用量。`model_used` は実際に使ったモデル（CLI が返さなければ依頼したモデル名）、`cost_known` は費用が確かな値か
 * （`cost_usd` が無ければ false。サブスクリプションは固定費の保証ではないので費用を推測しない）。
 */
export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  model_used: string | null;
  cost_known: boolean;
};

/**
 * 1 回の依頼のイベント。`ToolUse`・`ToolResult` は修正の会話（S5 #18386。CLI に隔離 workspace の中だけの読み書きを許した
 * 依頼）だけに届く。`summary` は対象のファイル名だけ（フォルダのパス・本文は来ない）、`id` で組にする。修正の会話の
 * `Done.text` は返答（最後のツールの後の文）で、それより前の文（実況）は `TextDelta` にだけ流れる。
 */
export type TurnEvent =
  | { type: "ThinkingDelta"; text: string }
  | { type: "TextDelta"; text: string }
  | { type: "ToolUse"; id: string; name: string; summary: string }
  | { type: "ToolResult"; id: string; name: string; ok: boolean }
  | {
      type: "Done";
      text: string;
      stop_reason: StopReason;
      session_id: string | null;
      usage: Usage;
      duration_ms: number;
      /** CLI（Claude Code）が出力の上限で止まり、同じ実行の中で自分で頼んだ続きの回数。アプリの続きの回数に足す。 */
      continuations: number;
    }
  | { type: "Error"; reason_code: ReasonCode; message: string };

export type TurnEnvelope = { turnId: string; seq: number; event: TurnEvent };

/** `run_turn` に渡す依頼。`workspace` は会話ごとの専用 workspace の id（起動フォルダは Rust 側が app data の下に作る）。 */
export type TurnRequest = {
  provider: ContractProvider;
  model: string;
  effort: ContractEffort | null;
  system_prompt: string;
  user_prompt: string;
  /** provider 固有の opaque な session ref（続きは同じ会話で）。 */
  resume_session: string | null;
  workspace: string;
  max_budget_usd: number | null;
};

/** provider_status の capabilities（spec §6.1。Rust の ProviderCapabilities と同じ形）。 */
export type ProviderCapabilities = {
  /** 同じ会話で続きを頼めるか。 */
  resume: boolean;
  /** 思考量を指定できるか。 */
  effort: boolean;
  /** ツールを切れることがテストで確かめられているか（Gemini CLI は S1-B が証明するまで出さない）。 */
  tools_off_proven: boolean;
  /** トークン数を返すか。 */
  usage: boolean;
  /** 費用を確かな値で返すか（サブスクリプションは false）。 */
  cost: boolean;
};

/** provider_status を読む前の仮の capabilities（Claude Code の S1 の値）。 */
export const DEFAULT_CAPABILITIES: ProviderCapabilities = { resume: true, effort: true, tools_off_proven: true, usage: true, cost: false };

/** このMacの CLI の状態（crate の ProviderStatus の写し。設定の行に出す）。 */
export type ProviderStatus = {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  cli_path: string | null;
  /** ログインの方法（例 "Claude Max account"）。 */
  login_method: string | null;
  /** 使えないとき: "cli_not_found" | "cli_version_failed" | "cli_flags_missing" | "auth_required" | "auth_probe_failed"。 */
  reason: string | null;
  /** `--help` に無かった必要なフラグ（古い CLI）。 */
  missing_cli_flags: string[];
  capabilities: ProviderCapabilities;
  /**
   * この CLI で使えるモデルの ID（codex はログイン後の `codex debug models`、agy は `agy models`。claude は空）。
   * 設定のモデルの選択肢に使う（空なら docs-core の控えの一覧）。
   */
  models: string[];
};

/** 提供元が返す使用量の残りの枠（agy の `/usage`。Rust の `UsageWindow` と同じ形）。 */
export type UsageWindow = {
  /** 群の名前（例 "Gemini Models"）。 */
  group: string;
  /** 枠の名前（例 "Weekly Limit Remaining"）。 */
  name: string;
  /** 期間（例 "weekly"）。 */
  window: string | null;
  /** 残りの割合（0〜1）。 */
  remaining_fraction: number | null;
  /** 次に満たされる時刻（ISO 8601）。 */
  reset_time: string | null;
};

/** 使用量の残り（provider が返せる分だけ。返せないときは command が失敗し、画面は「取得できません」）。 */
export type ProviderUsage = { windows: UsageWindow[] };

/** Claude Code の更新の結果（`status` は更新後に確かめ直した状態）。 */
export type ClaudeUpdateResult = {
  before_version: string | null;
  after_version: string | null;
  status: ProviderStatus;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseUsage(value: unknown): Usage | null {
  if (!isRecord(value)) return null;
  const { input_tokens, output_tokens, cost_usd, model_used, cost_known } = value;
  if (!isCount(input_tokens) || !isCount(output_tokens)) return null;
  if (cost_usd !== null && typeof cost_usd !== "number") return null;
  if (model_used !== null && typeof model_used !== "string") return null;
  if (typeof cost_known !== "boolean") return null;
  return { input_tokens, output_tokens, cost_usd, model_used, cost_known };
}

/** 流れてきたイベントを schema で確かめる（形が合わなければ null）。 */
export function parseTurnEvent(value: unknown): TurnEvent | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "ThinkingDelta":
    case "TextDelta":
      return typeof value.text === "string" ? { type: value.type, text: value.text } : null;
    case "ToolUse":
      return typeof value.id === "string" && typeof value.name === "string" && typeof value.summary === "string"
        ? { type: "ToolUse", id: value.id, name: value.name, summary: value.summary }
        : null;
    case "ToolResult":
      return typeof value.id === "string" && typeof value.name === "string" && typeof value.ok === "boolean"
        ? { type: "ToolResult", id: value.id, name: value.name, ok: value.ok }
        : null;
    case "Done": {
      const usage = parseUsage(value.usage);
      if (
        typeof value.text !== "string" ||
        !STOP_REASONS.includes(value.stop_reason as StopReason) ||
        (value.session_id !== null && typeof value.session_id !== "string") ||
        !usage ||
        !isCount(value.duration_ms) ||
        !isCount(value.continuations)
      ) {
        return null;
      }
      return {
        type: "Done",
        text: value.text,
        stop_reason: value.stop_reason as StopReason,
        session_id: value.session_id as string | null,
        usage,
        duration_ms: value.duration_ms,
        continuations: value.continuations,
      };
    }
    case "Error":
      if (!REASON_CODES.includes(value.reason_code as ReasonCode) || typeof value.message !== "string") return null;
      return { type: "Error", reason_code: value.reason_code as ReasonCode, message: value.message };
    default:
      return null;
  }
}

export function parseTurnEnvelope(value: unknown): TurnEnvelope | null {
  if (!isRecord(value) || typeof value.turnId !== "string" || !isCount(value.seq)) return null;
  const event = parseTurnEvent(value.event);
  return event ? { turnId: value.turnId, seq: value.seq, event } : null;
}

/** 1 回の依頼のイベントの並びの決まり: 最後の 1 つだけが Done か Error（Done は 1 回だけ）。食い違いを返す。 */
export function turnSequenceIssues(events: readonly TurnEvent[]): string[] {
  const issues: string[] = [];
  const terminal = events.filter((event) => event.type === "Done" || event.type === "Error").length;
  if (terminal !== 1) issues.push(`terminal events: ${terminal}`);
  const last = events[events.length - 1];
  if (!last || (last.type !== "Done" && last.type !== "Error")) issues.push("last event is not terminal");
  return issues;
}

const CONTRACT_PROVIDERS: Record<Connection, Record<ProviderId, ContractProvider>> = {
  subscription: { claude: "ClaudeCode", gpt: "CodexCli", gemini: "GeminiCli" },
  apiKey: { claude: "AnthropicApi", gpt: "OpenAiApi", gemini: "GeminiApi" },
};

const CONTRACT_EFFORTS: Record<Effort, ContractEffort> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  max: "Max",
};

/** アプリの AI × 方式 → 契約の提供元（省くとサブスクリプション）。 */
export function contractProvider(provider: ProviderId, connection: Connection = "subscription"): ContractProvider {
  return CONTRACT_PROVIDERS[connection][provider];
}

// ---------------------------------------------------------------------------
// API キー（API キー方式。鍵はこの Mac の app data の api-keys/ だけに置き、画面には返さない。#18769）

/** 鍵の名前（`api-keys/<account>`。以前の版の Keychain の account と同じ）。Deepgram は文字起こしだけ。 */
export type ApiKeyAccount = "anthropic" | "openai" | "gemini" | "deepgram";

export const API_KEY_ACCOUNTS: readonly ApiKeyAccount[] = ["anthropic", "openai", "gemini", "deepgram"];

const API_KEY_ACCOUNT_OF: Record<ProviderId, ApiKeyAccount> = { claude: "anthropic", gpt: "openai", gemini: "gemini" };

export function apiKeyAccount(provider: ProviderId): ApiKeyAccount {
  return API_KEY_ACCOUNT_OF[provider];
}

const API_SERVICE_LABELS: Record<ApiKeyAccount, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
  deepgram: "Deepgram",
};

/** API キーの行・案内に出す提供元の名前（「Anthropic」）。 */
export function apiServiceLabel(account: ApiKeyAccount): string {
  return API_SERVICE_LABELS[account];
}

/**
 * 鍵の状態（Tauri の `api_key_status`・`save_api_key`・`check_api_key` が返す）。鍵そのものは返らず、末尾 4 文字だけ。
 * `valid` は軽い呼び出しで確かめた結果（確かめていなければ null）、`models` はそのとき返ったモデルの ID（設定の選択肢）。
 * `reason` は確かめられなかった理由（"api_key_invalid" | "api_usage_limit" | "api_unreachable" | "api_failed"）、`message` は画面の文。
 */
export type ApiKeyStatus = {
  saved: boolean;
  last4: string | null;
  valid: boolean | null;
  models: string[];
  reason: string | null;
  message: string | null;
};

/** 鍵が無効（401・403 など）のときの文。 */
export const API_KEY_INVALID_MESSAGE = "API キーが無効です。設定 › 接続設定で確かめてください。";

export function contractEffort(effort: Effort): ContractEffort {
  return CONTRACT_EFFORTS[effort];
}

const AI_LABELS: Record<ProviderId, string> = { claude: "Claude", gpt: "GPT", gemini: "Gemini" };
const CLI_NAMES: Record<ProviderId, string> = { claude: "Claude Code", gpt: "Codex CLI", gemini: "Antigravity CLI" };

/**
 * 失敗の理由の文言（Rust の `message` が空のときの控え。NIHO Desktop の警告に倣う）。ふだんは crate の文（提供元の名前と
 * 個別の理由が入る）が届き、`ModelNotFound` だけは Rust の adapter もこの文を使う。文の中の名前はその工程の AI（`provider`。
 * 省くと Claude。登録した AI だけを出し、他社の名前を出さない）。
 */
function reasonMessages(ai: string, cli: string): Record<ReasonCode, string> {
  return {
    CliLoginRequired: `このMacの ${cli} にログインしていません。${cli} にログインしてから、もう一度実行してください。`,
    UsageLimitReached: `${ai} の利用上限に達しました。しばらく待ってから、もう一度実行してください。`,
    NotConfigured: `この Mac に ${cli} が見つかりません。${cli} を入れてから、もう一度実行してください。`,
    Unreachable: `このMacの ${ai} を起動できませんでした。NIHO docs を開き直してから、もう一度実行してください。`,
    SessionNotFound: "このMacに前の会話の記録が見つかりませんでした。もう一度実行してください。",
    Timeout: "時間の上限に達したため、途中で止めました。もう一度実行してください。",
    InvalidStream: `AIの返事を読み取れませんでした。もう一度実行してください。繰り返す場合は ${cli} を最新版に更新してください。`,
    CliVersionMismatch: `この Mac の ${cli} が古いため実行できません。${cli} を最新版に更新してから、もう一度実行してください。`,
    TransientFailure: "AIの作業が途中で止まりました。もう一度実行してください。",
    ModelNotFound: "設定のモデルが使えません。設定でモデルを確かめてから、もう一度実行してください。",
  };
}

/** API キー方式の文（Rust の `message` が空のときの控え。Rust の api_ai.rs と同じ文）。 */
function apiReasonMessages(ai: string, service: string): Record<ReasonCode, string> {
  return {
    CliLoginRequired: API_KEY_INVALID_MESSAGE,
    UsageLimitReached: `${service} の API の利用上限か残高に達しました。${service} の管理画面で上限と残高を確かめてから、もう一度実行してください。`,
    NotConfigured: `${service} の API キーが保存されていません。設定 › 接続設定で API キーを保存してください。`,
    Unreachable: `${service} の API に接続できませんでした。ネットワークを確かめてから、もう一度実行してください。`,
    SessionNotFound: "前の会話の記録が見つかりませんでした。もう一度実行してください。",
    Timeout: "時間の上限に達したため、途中で止めました。もう一度実行してください。",
    InvalidStream: `${ai} の返事を読み取れませんでした。もう一度実行してください。`,
    CliVersionMismatch: `${ai} の API が依頼を受け付けませんでした。設定のモデルを確かめてから、もう一度実行してください。`,
    TransientFailure: `${ai} の API が一時的に使えませんでした。しばらく待ってから、もう一度実行してください。`,
    ModelNotFound: "設定のモデルが使えません。設定でモデルを確かめてから、もう一度実行してください。",
  };
}

/** 失敗の理由の文。`connection` が `apiKey` なら API キー方式の文（鍵・残高・接続）。 */
export function reasonMessage(code: ReasonCode, provider: ProviderId = "claude", connection: Connection = "subscription"): string {
  if (connection === "apiKey") return apiReasonMessages(AI_LABELS[provider], API_SERVICE_LABELS[API_KEY_ACCOUNT_OF[provider]])[code];
  return reasonMessages(AI_LABELS[provider], CLI_NAMES[provider])[code];
}

/** 続きの上限を超えたときの文言。 */
export const CONTINUATION_LIMIT_MESSAGE = `続きを ${MAX_CONTINUATIONS} 回頼んでも書き終わらなかったため、止めました。途中までを残しています。`;

/** 続けられない CLI で頼んだ続きが、前の出力に重ならず繋げられなかったときの文言。 */
export const CONTINUATION_NOT_JOINABLE_MESSAGE = "続きを前の出力に繋げられなかったため、止めました。途中までを残しています。";
