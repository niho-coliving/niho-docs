import { describe, expect, it } from "vitest";
import {
  API_MODEL_OPTIONS,
  DEEPGRAM_KEYTERM_TOKEN_BUDGET,
  FLOW_TEMPLATES,
  STANDARD_PROFILE_ID,
  ADVANCED_PROFILE_ID,
  apiKeyAccount,
  apiServiceLabel,
  contractProvider,
  createFlowFromTemplate,
  createFlowSnapshot,
  deepgramKeyterms,
  deepgramTranscriptMarkdown,
  defaultProfiles,
  estimateDeepgramCostUsd,
  estimateRunCostUsd,
  estimateTokenCostUsd,
  formatUsd,
  isApiProvider,
  modelOptions,
  parseTurnEvent,
  reasonMessage,
  snapshotModelFor,
  tokenPrice,
  type GlossaryEntry,
  type RunRecord,
} from "../src/index.js";

const term = (value: string, reading = "", variants: string[] = []): GlossaryEntry => ({ term: value, reading, variants, note: "" });

describe("API キー方式の提供元", () => {
  it("AI × 方式 → 契約の提供元（サブスクリプションは CLI、API キー方式は各社の API）", () => {
    expect(contractProvider("claude")).toBe("ClaudeCode");
    expect(contractProvider("gemini", "subscription")).toBe("GeminiCli");
    expect(contractProvider("claude", "apiKey")).toBe("AnthropicApi");
    expect(contractProvider("gpt", "apiKey")).toBe("OpenAiApi");
    expect(contractProvider("gemini", "apiKey")).toBe("GeminiApi");
    expect(isApiProvider("GeminiApi")).toBe(true);
    expect(isApiProvider("GeminiCli")).toBe(false);
    expect(apiKeyAccount("gpt")).toBe("openai");
    expect(apiServiceLabel(apiKeyAccount("gemini"))).toBe("Google Gemini");
  });

  it("理由の文は方式で変わる（鍵が無効はログインの代わり・残高・鍵の保存）", () => {
    expect(reasonMessage("CliLoginRequired", "claude", "apiKey")).toBe("API キーが無効です。設定 › 接続設定で確かめてください。");
    expect(reasonMessage("NotConfigured", "gpt", "apiKey")).toContain("OpenAI の API キーが保存されていません");
    expect(reasonMessage("UsageLimitReached", "gemini", "apiKey")).toContain("Google Gemini の API の利用上限か残高");
    expect(reasonMessage("CliLoginRequired", "claude")).toContain("Claude Code にログインしていません");
    // 1 社だけの文に他社の名前が出ない
    expect(reasonMessage("Unreachable", "gpt", "apiKey")).not.toMatch(/Claude|Anthropic|Gemini|Google/);
  });

  it("イベントの schema は変えない（API の Done も同じ形）", () => {
    expect(
      parseTurnEvent({
        type: "Done",
        text: "本文",
        stop_reason: "MaxTokens",
        session_id: "api_0123456789abcdef01234567",
        usage: { input_tokens: 10, output_tokens: 20, cost_usd: null, model_used: "claude-sonnet-4-6", cost_known: false },
        duration_ms: 5,
        continuations: 0,
      })?.type,
    ).toBe("Done");
  });
});

describe("API キー方式のモデル", () => {
  it("控えは版つきの ID だけ（CLI の別名は API で使えないので出さない）", () => {
    const ids = modelOptions("claude", [], "apiKey").map((option) => option.id);
    expect(ids).toEqual(API_MODEL_OPTIONS.claude.map((option) => option.id));
    expect(ids).not.toContain("sonnet");
    expect(modelOptions("gemini", [], "apiKey").map((option) => option.id)).toEqual(["gemini-3.8-flash", "gemini-3.1-pro-preview"]);
  });

  it("鍵を確かめたときの一覧があればそれを使う（その AI の名前の付くものだけ）", () => {
    expect(modelOptions("claude", ["claude-opus-5-5", "gpt-x"], "apiKey").map((option) => option.id)).toEqual(["claude-opus-5-5"]);
    expect(modelOptions("gpt", ["gpt-5.6-sol", "o9"], "apiKey")).toEqual([{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }]);
  });

  it("既定のプロファイル（標準・高性能。Gemini の高性能は 3.1 Pro）", () => {
    const [standard, advanced] = defaultProfiles("apiKey");
    expect(standard?.id).toBe(STANDARD_PROFILE_ID);
    expect(standard?.models.claude).toEqual({ model: "claude-sonnet-4-6", effort: "high" });
    expect(advanced?.id).toBe(ADVANCED_PROFILE_ID);
    expect(advanced?.models.gemini).toEqual({ model: "gemini-3.1-pro-preview", effort: "high" });
    expect(advanced?.models.gpt).toEqual({ model: "gpt-5.6-terra", effort: "max" });
  });

  it("snapshot は解決した方式を持ち、方式が違えば同じプロファイル × 提供元を今の方式の表で解決し直す", () => {
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    const snapshot = createFlowSnapshot(flow, defaultProfiles(), ["gemini"], "subscription");
    const advancedStep = flow.steps.find((step) => step.profile === ADVANCED_PROFILE_ID)!;
    const model = snapshot.models[advancedStep.id]!;
    expect(model).toMatchObject({ provider: "gemini", model: "gemini-3.8-flash", effort: "high", connection: "subscription" });
    // 同じ方式ならそのまま
    expect(snapshotModelFor(model, "subscription", defaultProfiles("apiKey"))).toBe(model);
    // API キー方式で実行するときは API キー方式の表（3.1 Pro）
    expect(snapshotModelFor(model, "apiKey", defaultProfiles("apiKey"))).toEqual({
      provider: "gemini",
      model: "gemini-3.1-pro-preview",
      effort: "high",
      profileId: ADVANCED_PROFILE_ID,
      profileName: "高性能",
      connection: "apiKey",
    });
    // 方式の無い snapshot（S2a 以前）はサブスクリプション
    const { connection: _omit, ...legacy } = model;
    expect(snapshotModelFor(legacy, "apiKey", defaultProfiles("apiKey"))?.model).toBe("gemini-3.1-pro-preview");
    // 今の方式の表にプロファイルが無ければ解決しない（推測しない）
    expect(snapshotModelFor(model, "apiKey", defaultProfiles("apiKey").filter((profile) => profile.id !== ADVANCED_PROFILE_ID))).toBeNull();
    // 思考量はモデルに合わせる（API キー方式の表で Gemini に最大を入れても高へ）
    const odd = defaultProfiles("apiKey").map((profile) =>
      profile.id === ADVANCED_PROFILE_ID ? { ...profile, models: { ...profile.models, gemini: { model: "gemini-3.1-pro-preview", effort: "max" as const } } } : profile,
    );
    expect(snapshotModelFor(model, "apiKey", odd)?.effort).toBe("high");
  });
});

describe("見込み金額", () => {
  it("単価表の値（100 万トークンあたり）とモデル名の版の接尾辞", () => {
    expect(tokenPrice("claude", "claude-sonnet-4-6")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(tokenPrice("gpt", "gpt-5.6-terra-2026-09-01")).toEqual({ inputPerMTok: 2, outputPerMTok: 12 });
    expect(tokenPrice("gemini", "models/gemini-3.8-flash")).toEqual({ inputPerMTok: 0.75, outputPerMTok: 3.75 });
    expect(tokenPrice("gpt", "gpt-5.6-terra-mini")).toBeNull();
    expect(tokenPrice("claude", "sonnet")).toBeNull();
    expect(estimateTokenCostUsd("claude", "claude-opus-4-8", 1_000_000, 100_000)).toBeCloseTo(7.5);
    expect(estimateTokenCostUsd("gemini", "gemini-9", 1, 1)).toBeNull();
  });

  it("実行の記録 1 行（API キー方式だけ・推測しない）", () => {
    const base: RunRecord = {
      id: "r",
      kind: "run",
      at: "2026-10-15T00:00:00.000Z",
      stepId: "s",
      stepName: "工程",
      version: 1,
      result: "saved",
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelUsed: "claude-sonnet-4-6",
      inputTokens: 200_000,
      outputTokens: 20_000,
      tokensKnown: true,
      connection: "apiKey",
    };
    expect(estimateRunCostUsd(base)).toBeCloseTo(0.9);
    expect(estimateRunCostUsd({ ...base, connection: "subscription" })).toBeNull();
    expect(estimateRunCostUsd({ ...base, connection: undefined })).toBeNull();
    expect(estimateRunCostUsd({ ...base, tokensKnown: false })).toBeNull();
    expect(estimateRunCostUsd({ ...base, modelUsed: "claude-unknown-9" })).toBeNull();
    expect(estimateRunCostUsd({ ...base, provider: "this-mac" })).toBe(0);
    expect(estimateRunCostUsd({ ...base, provider: "deepgram", audioSec: 3600, keyterms: 0 })).toBeCloseTo(0.258);
    expect(estimateRunCostUsd({ ...base, provider: "deepgram", audioSec: 3600, keyterms: 4 })).toBeCloseTo(0.336);
    expect(estimateDeepgramCostUsd(undefined, false)).toBeNull();
    expect(formatUsd(1280.5)).toBe("$1,280.50");
    expect(formatUsd(0.004)).toBe("$0.01 未満");
    expect(formatUsd(0)).toBe("$0.00");
  });
});

describe("Deepgram", () => {
  it("keyterm は表記だけ（よみ・誤りやすい表記は渡さない）・重なりを除き・上限で打ち切る", () => {
    expect(deepgramKeyterms([term("NIHO鎌倉", "にほかまくら", ["NIHO 鎌倉"]), term("由比ガ浜"), term("NIHO鎌倉"), term("  ")])).toEqual([
      "NIHO鎌倉",
      "由比ガ浜",
    ]);
    const many = Array.from({ length: 100 }, (_, index) => term(`固有名詞${index}`));
    const picked = deepgramKeyterms(many);
    const bytes = picked.reduce((sum, value) => sum + new TextEncoder().encode(value).length, 0);
    expect(bytes).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_TOKEN_BUDGET);
    expect(picked.length).toBeLessThan(100);
  });

  it("utterances → `[hh:mm:ss] 話者N: 本文`（句読点を戻し・相づちを畳み・空白を詰め・英字の分かち書きを直す）", () => {
    const markdown = deepgramTranscriptMarkdown(
      [
        {
          offsetSec: 0,
          result: {
            durationSec: 600,
            transcript: "",
            utterances: [
              { start: 1, end: 3, speaker: 0, transcript: "朝市 に 出して" },
              { start: 3.1, end: 3.5, speaker: 1, transcript: "はい" },
              { start: 3.6, end: 6, speaker: 0, transcript: "三年目 です n i h o の" },
              { start: 70, end: 80, speaker: 1, transcript: "。 そう なんですね" },
            ],
          },
        },
        {
          offsetSec: 600,
          result: { durationSec: 30, transcript: "", utterances: [{ start: 5, end: 8, speaker: 0, transcript: "後半 です" }] },
        },
      ],
      { language: "ja", speakers: "2", terms: [term("NIHO")] },
    );
    expect(markdown).toBe(
      // 相づち（はい）は次の 話者0 の発話の後ろへ移り、続く 話者1 の発話と 1 段落になる（NIHO と同じ）
      "[00:00:01] 話者0: 朝市に出して三年目です NIHO の。\n\n[00:00:03] 話者1: はいそうなんですね\n\n[00:10:05] 話者0: 後半です\n",
    );
  });

  it("話者を分けない案件はラベルを付けず、utterances が無ければ全文を 1 段落にする", () => {
    expect(
      deepgramTranscriptMarkdown(
        [{ offsetSec: 0, result: { durationSec: 10, transcript: "", utterances: [{ start: 2, end: 3, speaker: 0, transcript: "講演 です" }] } }],
        { language: "ja", speakers: "none", terms: [] },
      ),
    ).toBe("[00:00:02] 講演です\n");
    expect(
      deepgramTranscriptMarkdown([{ offsetSec: 0, result: { durationSec: 10, transcript: "全文 です", utterances: [] } }], {
        language: "ja",
        speakers: "2",
        terms: [],
      }),
    ).toBe("[00:00:00] 全文です\n");
    expect(deepgramTranscriptMarkdown([], { language: "ja", speakers: "2", terms: [] })).toBe("");
  });
});
