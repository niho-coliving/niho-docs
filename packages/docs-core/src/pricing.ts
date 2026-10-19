import type { ProviderId, RunRecord } from "./types.js";

/**
 * API キー方式の見込み金額の単価表（spec §7「使用量」）。アプリ内の定数で、更新はアプリの版上げで行う（実行中に取りに行かない）。
 * 金額は「見込み」: 提供元は 1 回ごとの請求額を返さないので、返ったトークン数（Deepgram は音声の長さ）にこの単価を掛ける。
 * 請求の正は各社の管理画面。表に無いモデル・トークン数が返らなかった実行は推測せず「取得できません」にする。
 *
 * 出典（USD・Standard・プロンプトのキャッシュを使わない料金）:
 * - Anthropic: Claude API の料金（2026-10-06 時点の表）。入力 ／ 出力（思考を含む）。
 * - OpenAI: https://developers.openai.com/api/docs/pricing（2026-10-15 に確認）。272K トークン以下の入力の料金（それを超える
 *   長い入力は割増になるが、ここでは見込みとして短い入力の料金で数える）。出力は推論のトークンを含む。
 * - Google Gemini: https://ai.google.dev/gemini-api/docs/pricing（2026-10-15 に確認）。Paid tier。gemini-3.8-flash は
 *   2026-12-31 までの料金（2027-01-01 から入力 $1.50・出力 $7.50 に上がる。版上げで更新する）。3.1 Pro は 20 万トークン以下の
 *   プロンプトの料金。出力は思考を含む。音声の入力も同じ単価。
 * - Deepgram: https://deepgram.com/pricing（2026-10-15 に確認）。Nova-3 の録音（pre-recorded）の Pay As You Go、単一言語
 *   $0.0043／分。話者分離は追加料金なし、Keyterm Prompting は $0.0013／分を足す。
 */
export const PRICING_AS_OF = "2026-10-15";

/** 100 万トークンあたりの USD。 */
export type TokenPrice = { inputPerMTok: number; outputPerMTok: number };

export const TOKEN_PRICES: Readonly<Record<ProviderId, Readonly<Record<string, TokenPrice>>>> = {
  claude: {
    "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
    "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
    "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
    "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50 },
    "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20 },
    "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
    "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10 },
    "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 },
    "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  },
  gpt: {
    "gpt-5.6-terra": { inputPerMTok: 2, outputPerMTok: 12 },
    "gpt-5.6-luna": { inputPerMTok: 0.2, outputPerMTok: 1.2 },
    "gpt-5.6-sol": { inputPerMTok: 4, outputPerMTok: 20 },
    "gpt-6-astra": { inputPerMTok: 10, outputPerMTok: 50 },
    "gpt-6-sol": { inputPerMTok: 2, outputPerMTok: 10 },
    "gpt-6.1-sol": { inputPerMTok: 2, outputPerMTok: 10 },
    "gpt-6-luna": { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    "gpt-5.5": { inputPerMTok: 5, outputPerMTok: 30 },
    "gpt-5.4": { inputPerMTok: 2.5, outputPerMTok: 15 },
  },
  gemini: {
    "gemini-3.8-flash": { inputPerMTok: 0.75, outputPerMTok: 3.75 },
    "gemini-3.6-flash": { inputPerMTok: 0.75, outputPerMTok: 3.75 },
    "gemini-3.1-pro-preview": { inputPerMTok: 2, outputPerMTok: 12 },
  },
};

/** Deepgram Nova-3（録音・単一言語）の 1 分あたりの USD と、Keyterm Prompting の追加。 */
export const DEEPGRAM_PRICE_PER_MINUTE = 0.0043;
export const DEEPGRAM_KEYTERM_PRICE_PER_MINUTE = 0.0013;

/** 単価表のモデル（提供元が返した実際のモデル名に版の接尾辞 `-2026…` などが付いていても、表の名前で引く）。 */
export function tokenPrice(provider: ProviderId, model: string): TokenPrice | null {
  const table = TOKEN_PRICES[provider];
  const exact = table[model];
  if (exact) return exact;
  // 返ったモデル名が表の名前に日付などを足したもの（`gpt-5.6-terra-2026-09-01`・`models/gemini-3.8-flash`）
  const bare = model.replace(/^models\//u, "");
  if (table[bare]) return table[bare]!;
  const prefix = Object.keys(table)
    .filter((name) => bare.startsWith(`${name}-`) && /^\d/u.test(bare.slice(name.length + 1)))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? table[prefix]! : null;
}

/** トークン数からの見込み金額（USD）。単価表に無いモデルは null（推測しない）。 */
export function estimateTokenCostUsd(provider: ProviderId, model: string, inputTokens: number, outputTokens: number): number | null {
  const price = tokenPrice(provider, model);
  if (!price) return null;
  return (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;
}

/** Deepgram の見込み金額（USD）。音声の長さ（秒）が分からなければ null。 */
export function estimateDeepgramCostUsd(audioSec: number | undefined, keyterms: boolean): number | null {
  if (audioSec === undefined || !Number.isFinite(audioSec) || audioSec < 0) return null;
  const perMinute = DEEPGRAM_PRICE_PER_MINUTE + (keyterms ? DEEPGRAM_KEYTERM_PRICE_PER_MINUTE : 0);
  return (audioSec / 60) * perMinute;
}

/**
 * 実行の記録 1 行の見込み金額（USD）。API キー方式の記録だけ（サブスクリプションは金額を出さない＝null）。この Mac の文字起こしは 0、
 * Deepgram は音声の長さ、AI はトークン数 × 単価（実際に使ったモデル、無ければ依頼したモデル）。トークン数が返らなかった・
 * 単価表に無いモデルは null（推測しない。画面は「取得できません」）。
 */
export function estimateRunCostUsd(record: RunRecord): number | null {
  if (record.connection !== "apiKey") return null;
  if (record.provider === "this-mac") return 0;
  if (record.provider === "deepgram") return estimateDeepgramCostUsd(record.audioSec, (record.keyterms ?? 0) > 0);
  if (!record.provider) return null;
  if (record.tokensKnown === false || record.inputTokens === undefined) return null;
  const model = record.modelUsed ?? record.model;
  if (!model) return null;
  return estimateTokenCostUsd(record.provider, model, record.inputTokens, record.outputTokens ?? 0);
}

/** 見込み金額の表示（「$0.12」・1 セント未満は「$0.01 未満」）。 */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return "$0.01 未満";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
