import { describe, expect, it } from "vitest";
import type { ProviderStatus, ResolvedStepModel } from "@niho/docs-core";
import {
  PersonalProviderReadinessError,
  assertPersonalProviderReady,
  personalProviderReadiness,
  personalReportedModelMatches,
  type PersonalSubscriptionEntitlement,
} from "../src/lib/personal-provider-readiness";
import { fakeStatus } from "./fake-bridge";

const model: ResolvedStepModel = {
  provider: "gpt",
  model: "gpt-5.6-terra",
  effort: "high",
  profileId: "standard",
  profileName: "標準",
  connection: "subscription",
};
const entitlement: PersonalSubscriptionEntitlement = { planConfirmed: true, usage: "available" };

function ready(status: ProviderStatus | null, overrides: Partial<PersonalSubscriptionEntitlement> = {}) {
  return personalProviderReadiness({ connection: "subscription", model, status, entitlement: { ...entitlement, ...overrides } });
}

describe("R6 provider readiness", () => {
  it("導入・認証・必要フラグ・固定モデル・契約・残量が揃った本人サブスクだけを許可する", () => {
    expect(ready(fakeStatus("CodexCli"))).toEqual({
      ready: true,
      provider: "gpt",
      connection: "subscription",
      model: "gpt-5.6-terra",
      effort: "high",
      usage: "available",
    });
  });

  it.each([
    ["未認証", fakeStatus("CodexCli", { authenticated: false, reason: "auth_required" }), entitlement, "not_authenticated"],
    ["未対応フラグ", fakeStatus("CodexCli", { missing_cli_flags: ["--sandbox"] }), entitlement, "cli_unsupported"],
    ["空モデル", fakeStatus("CodexCli", { models: [] }), entitlement, "model_unavailable"],
    ["別モデルだけ", fakeStatus("CodexCli", { models: ["gpt-5.6-luna"] }), entitlement, "model_unavailable"],
    ["利用枯渇", fakeStatus("CodexCli"), { planConfirmed: true, usage: "depleted" }, "usage_depleted"],
  ] as const)("%s を利用可能にしない", (_name, status, contract, code) => {
    expect(personalProviderReadiness({ connection: "subscription", model, status, entitlement: contract })).toMatchObject({ ready: false, code });
  });

  it("契約名・残量を取得できない本人サブスクは未確認表示のまま実行できる", () => {
    expect(ready(fakeStatus("CodexCli"), { planConfirmed: false, usage: "unknown" })).toMatchObject({ ready: true, usage: "unknown" });
  });

  it("APIキーを本人サブスクとして扱わず、API用providerの認証・固定モデルを検証する", () => {
    expect(ready(fakeStatus("CodexCli", { login_method: "API key" }))).toMatchObject({ ready: false, code: "connection_not_subscription" });
    // model.connectionは録音を作った端末の旧値でもよく、この端末で明示選択したconnectionのproviderを検査する。
    expect(personalProviderReadiness({ connection: "apiKey", model, status: fakeStatus("OpenAiApi", { models: [model.model] }), entitlement: { planConfirmed: false, usage: "unknown" } })).toMatchObject({
      ready: true,
      connection: "apiKey",
      usage: "unknown",
    });
    expect(personalProviderReadiness({ connection: "apiKey", model, status: fakeStatus("OpenAiApi", { authenticated: false }), entitlement })).toMatchObject({ ready: false, code: "not_authenticated" });
  });

  it("Antigravityのbase modelは固定effortに対応する列挙名だけで照合し、公式Gemini CLIや別モデルへ寄せない", () => {
    const gemini: ResolvedStepModel = {
      provider: "gemini",
      model: "gemini-3.8-flash",
      effort: "low",
      profileId: "light",
      profileName: "軽量",
      connection: "subscription",
    };
    expect(personalProviderReadiness({ connection: "subscription", model: { ...gemini, effort: "max" }, status: fakeStatus("GeminiCli", { models: [gemini.model] }), entitlement })).toMatchObject({ ready: false, code: "model_unavailable" });
    expect(personalProviderReadiness({ connection: "subscription", model: { ...gemini, model: `${gemini.model}-low`, effort: "high" }, status: fakeStatus("GeminiCli", { models: [`${gemini.model}-low`] }), entitlement })).toMatchObject({ ready: false, code: "model_unavailable" });
    expect(
      personalProviderReadiness({ connection: "subscription", model: gemini, status: fakeStatus("GeminiCli"), entitlement }),
    ).toMatchObject({ ready: true, model: "gemini-3.8-flash", effort: "low" });
    expect(
      personalProviderReadiness({
        connection: "subscription",
        model: { ...gemini, effort: "max" },
        status: fakeStatus("GeminiCli"),
        entitlement,
      }),
    ).toMatchObject({ ready: false, code: "model_unavailable" });
    expect(personalReportedModelMatches(gemini, "gemini-3.8-flash-low")).toBe(true);
    expect(personalReportedModelMatches(gemini, "gemini-3.8-flash-high")).toBe(false);
    expect(personalReportedModelMatches(gemini, "gemini-4.0-flash-low")).toBe(false);
  });

  it("Claude Codeの空モデル一覧は固定候補にあるモデルだけ許可する", () => {
    const claude: ResolvedStepModel = {
      provider: "claude",
      model: "claude-sonnet-4-6",
      effort: "high",
      profileId: "standard",
      profileName: "標準",
      connection: "subscription",
    };
    expect(personalProviderReadiness({ connection: "subscription", model: claude, status: fakeStatus("ClaudeCode"), entitlement })).toMatchObject({ ready: true, model: "claude-sonnet-4-6" });
    expect(personalProviderReadiness({ connection: "subscription", model: { ...claude, model: "claude-arbitrary-9" }, status: fakeStatus("ClaudeCode"), entitlement })).toMatchObject({ ready: false, code: "model_unavailable" });
  });

  it("送信直前にprovider_statusを取り直し、通信失敗や拒否を同じtyped errorで伝播する", async () => {
    let calls = 0;
    await expect(
      assertPersonalProviderReady({
        connection: "subscription",
        model,
        entitlement,
        providerStatus: async () => {
          calls++;
          throw new Error("offline");
        },
      }),
    ).rejects.toBeInstanceOf(PersonalProviderReadinessError);
    expect(calls).toBe(1);
  });
});
