import { describe, expect, it } from "vitest";
import {
  BUILT_IN_PROFILE_IDS,
  FLOW_TEMPLATES,
  LIGHT_PROFILE_ID,
  MODEL_OPTIONS,
  NIHO_API_PROFILE_NAME,
  STANDARD_PROFILE_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  createNihoApiFlowSnapshot,
  defaultProfiles,
  disclosedProvider,
  effortRule,
  effortUnavailableReason,
  fitEffort,
  matchesNihoApi,
  modelLabel,
  modelOptions,
  nihoApiModelSwap,
  nihoApiProvider,
  nihoApiStepModel,
  nihoApiStepEffort,
  reasonMessage,
  redirectedNote,
  requestEffort,
  resolveFlowModels,
  resolveStepModel,
  shortModelLabel,
  toResolvedStepModel,
  unregisteredSnapshotSteps,
} from "../src/index.js";

describe("モデルの選択肢", () => {
  it("Claude は控えの表（NIHO の policy の既定と上位が先頭）。CLI の一覧は使わない", () => {
    expect(modelOptions("claude", ["x"]).map((option) => option.id).slice(0, 2)).toEqual(["claude-sonnet-4-6", "claude-opus-4-8"]);
    expect(modelOptions("claude").length).toBe(MODEL_OPTIONS.claude.length);
  });

  it("GPT はログイン後の一覧（codex debug models）を優先し、取れなければ控え", () => {
    expect(modelOptions("gpt", ["gpt-5.6-sol", "gpt-5.6-terra"])).toEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
      { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
    ]);
    expect(modelOptions("gpt", []).map((option) => option.id)).toEqual(["gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  it("Gemini は agy の一覧から Gemini だけを出し（他社の名前を出さない）、思考量を選べる元の名前を先に足す", () => {
    const options = modelOptions("gemini", [
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
    expect(options.map((option) => option.id)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
    ]);
    expect(options.map((option) => option.label).join(" ")).not.toMatch(/Claude|GPT/);
    expect(modelOptions("gemini", ["claude-sonnet-4-6"]).map((option) => option.id)).toEqual(
      MODEL_OPTIONS.gemini.map((option) => option.id),
    );
  });

  it("控えに無い ID の表示名を ID から作る", () => {
    expect(modelLabel("gemini", "gemini-3.1-pro-high")).toBe("Gemini 3.1 Pro (High)");
    expect(shortModelLabel("gemini", "gemini-3.8-flash")).toBe("3.8 Flash");
    expect(modelLabel("claude", "claude-opus-4-6")).toBe("Claude Opus 4.6");
    expect(shortModelLabel("claude", "sonnet")).toBe("Sonnet（最新）");
    expect(modelLabel("gpt", "o9")).toBe("o9");
  });
});

describe("思考量の可否", () => {
  it("Claude と GPT は 低・中・高・最大", () => {
    expect(effortRule("claude", "claude-sonnet-4-6")).toEqual({ efforts: ["low", "medium", "high", "max"], fixed: null });
    expect(effortUnavailableReason("gpt", "gpt-5.6-terra", "max")).toBeNull();
    expect(requestEffort("gpt", "gpt-5.6-terra", "max")).toBe("max");
  });

  it("gemini-3.8-flash は 低・中・高（最大は無い）。合わない思考量は低い方へ寄せる", () => {
    expect(effortRule("gemini", "gemini-3.8-flash").efforts).toEqual(["low", "medium", "high"]);
    expect(effortUnavailableReason("gemini", "gemini-3.8-flash", "max")).toBe("このモデルには「最大」がありません");
    expect(fitEffort("gemini", "gemini-3.8-flash", "max")).toBe("high");
    expect(requestEffort("gemini", "gemini-3.8-flash", "medium")).toBe("medium");
  });

  it("思考量入りの名前は思考量を渡さない（名前の思考量に固定）", () => {
    expect(effortRule("gemini", "gemini-3.8-flash-high")).toEqual({ efforts: ["high"], fixed: "high" });
    expect(effortUnavailableReason("gemini", "gemini-3.8-flash-high", "low")).toBe("思考量はモデル名で決まります");
    expect(fitEffort("gemini", "gemini-3.8-flash-low", "max")).toBe("low");
    expect(requestEffort("gemini", "gemini-3.8-flash-low", "low")).toBeNull();
  });
});

describe("既定のプロファイル", () => {
  it("標準・高性能・軽量はどの AI の値も持ち、組み合わせは選べるものだけ", () => {
    const profiles = defaultProfiles();
    expect(profiles.map((profile) => profile.name)).toEqual(["標準", "高性能", "軽量"]);
    expect(defaultProfiles("apiKey").map((profile) => profile.id)).toEqual([...BUILT_IN_PROFILE_IDS]);
    for (const profile of profiles) {
      for (const [provider, model] of Object.entries(profile.models)) {
        const id = provider as "claude" | "gpt" | "gemini";
        expect(effortUnavailableReason(id, model.model, model.effort), `${profile.name} ${provider}`).toBeNull();
      }
    }
    expect(profiles[0]?.models).toEqual({
      claude: { model: "claude-sonnet-4-6", effort: "high" },
      gpt: { model: "gpt-5.6-terra", effort: "high" },
      gemini: { model: "gemini-3.8-flash", effort: "medium" },
    });
    expect(profiles[1]?.models.gemini).toEqual({ model: "gemini-3.8-flash", effort: "high" });
    expect(profiles[2]?.models).toEqual({
      claude: { model: "claude-sonnet-4-6", effort: "low" },
      gpt: { model: "gpt-5.6-terra", effort: "medium" },
      gemini: { model: "gemini-3.8-flash", effort: "low" },
    });
  });

  it("長い文書をほぼ同じ長さで書き直す工程は軽量（Claude の思考が出力の上限を使い切らない）", () => {
    const light = FLOW_TEMPLATES.flatMap((template) => template.steps)
      .filter((step) => step.profile === LIGHT_PROFILE_ID)
      .map((step) => step.name);
    // 記事制作の文字起こし修正・コーチングの文字起こし修正（P4 #18567）
    expect(light).toEqual(["文字起こし修正", "文字起こし修正"]);
  });
});

describe("登録していない AI", () => {
  it("工程が登録していない AI を指すときは先頭へ寄せ、snapshot に寄せた印を残す", () => {
    const profiles = defaultProfiles();
    const resolved = resolveStepModel({ profile: STANDARD_PROFILE_ID, provider: "gemini" }, profiles, ["gpt"]);
    expect(resolved).toMatchObject({ provider: "gpt", redirected: true, model: { model: "gpt-5.6-terra", effort: "high" } });
    expect(resolveStepModel({ profile: STANDARD_PROFILE_ID, provider: "gpt" }, profiles, ["claude", "gpt"])?.redirected).toBe(false);
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    flow.steps[0]!.provider = "gemini";
    const snapshot = createFlowSnapshot(flow, profiles, ["claude"]);
    expect(snapshot.models[flow.steps[0]!.id]).toMatchObject({ provider: "claude", redirected: true });
    expect(snapshot.models[flow.steps[1]!.id]?.redirected).toBeUndefined();
    expect(redirectedNote("claude")).toBe("選んでいた AI が登録されていないため、Claude で実行します");
    expect(redirectedNote("claude")).not.toMatch(/Gemini|GPT/);
  });

  it("作成後に登録を外した AI の工程を拾う（勝手に別の AI で実行しない）", () => {
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    const snapshot = createFlowSnapshot(flow, defaultProfiles(), ["gpt", "claude"]);
    expect(unregisteredSnapshotSteps(snapshot, ["gpt", "claude"])).toEqual([]);
    expect(unregisteredSnapshotSteps(snapshot, ["claude"]).map((step) => step.name)).toEqual(["議事録", "共有用の要約"]);
  });

  it("失敗の文の名前はその工程の AI（省くと Claude）", () => {
    expect(reasonMessage("CliLoginRequired", "gpt")).toBe(
      "このMacの Codex CLI にログインしていません。Codex CLI にログインしてから、もう一度実行してください。",
    );
    expect(reasonMessage("UsageLimitReached", "gemini")).toContain("Gemini の利用上限");
    expect(reasonMessage("NotConfigured", "gemini")).not.toMatch(/Claude|GPT|Codex/);
    expect(reasonMessage("CliLoginRequired")).toContain("Claude Code");
  });
});

describe("工程のモデルの解決（Mac の案件の作成・Web の自分の Mac で動かす固定）", () => {
  it("解けない工程（設定に無いプロファイル）は unresolved に並べ、createFlowSnapshot は今どおり飛ばす", () => {
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    flow.steps[1]!.profile = "custom-missing";
    const { models, unresolved } = resolveFlowModels(flow, defaultProfiles(), ["claude"], "apiKey");
    expect(unresolved.map((step) => step.id)).toEqual([flow.steps[1]!.id]);
    expect(Object.keys(models)).toEqual([flow.steps[0]!.id]);
    expect(models[flow.steps[0]!.id]).toEqual({
      provider: "claude", model: "claude-sonnet-4-6", effort: "high", profileId: STANDARD_PROFILE_ID, profileName: "標準", connection: "apiKey",
    });
    const snapshot = createFlowSnapshot(flow, defaultProfiles(), ["claude"], "apiKey");
    expect(snapshot.models).toEqual(models);
    expect(resolveFlowModels(flow, defaultProfiles(), []).unresolved).toHaveLength(flow.steps.length);
  });

  it("toResolvedStepModel は寄せた印と方式を持つ（寄せていなければ redirected を持たない）", () => {
    const profiles = defaultProfiles();
    const redirected = resolveStepModel({ profile: STANDARD_PROFILE_ID, provider: "gemini" }, profiles, ["gpt"])!;
    expect(toResolvedStepModel(redirected, "subscription")).toEqual({
      provider: "gpt", model: "gpt-5.6-terra", effort: "high", profileId: STANDARD_PROFILE_ID, profileName: "標準", redirected: true, connection: "subscription",
    });
    const direct = resolveStepModel({ profile: STANDARD_PROFILE_ID, provider: "gpt" }, profiles, ["gpt"])!;
    expect(toResolvedStepModel(direct, "subscription")).not.toHaveProperty("redirected");
  });
});

describe("NIHO の AI（NIHO API）の工程のモデル", () => {
  const descriptor = { provider: "GOOGLE", model: "gemini-3.8-flash" };

  it("開示された提供元の表: 名前の表示は 3 社、工程を動かせるのは Gemini だけ（知らない名前は null）", () => {
    expect(disclosedProvider("ANTHROPIC")).toBe("claude");
    expect(disclosedProvider("openai")).toBe("gpt");
    expect(disclosedProvider("Google")).toBe("gemini");
    expect(disclosedProvider("MISTRAL")).toBeNull();
    expect(nihoApiProvider("GOOGLE")).toBe("gemini");
    expect(nihoApiProvider("google")).toBe("gemini");
    expect(nihoApiProvider("ANTHROPIC")).toBeNull();
    expect(nihoApiProvider("OPENAI")).toBeNull();
    expect(nihoApiProvider("")).toBeNull();
  });

  it("工程の固定モデルは Gemini のプロファイルの思考量・プロファイル名「NIHO API」・API キー方式を使う", () => {
    expect(NIHO_API_PROFILE_NAME).toBe("NIHO API");
    expect(nihoApiStepModel({ profile: "light" }, descriptor)).toEqual({
      provider: "gemini", model: "gemini-3.8-flash", effort: "low", profileId: "light", profileName: "NIHO API", connection: "apiKey",
    });
    expect(nihoApiStepEffort({ profile: "standard" })).toBe("medium");
    expect(nihoApiStepEffort({ profile: "advanced" })).toBe("high");
    expect(nihoApiStepEffort({ profile: "missing" })).toBe("medium");
    const customProfiles = [...defaultProfiles("apiKey"), { id: "custom", name: "独自", models: { gemini: { model: "gemini-3.8-flash", effort: "high" as const } } }];
    expect(nihoApiStepEffort({ profile: "custom" }, customProfiles)).toBe("high");
    expect(nihoApiStepModel({ profile: "custom" }, descriptor, customProfiles)?.effort).toBe("high");
    expect(nihoApiStepEffort({ profile: "custom" }, [{ id: "custom", name: "独自", models: {} }])).toBe("medium");
    expect(nihoApiStepModel({ profile: "light" }, { ...descriptor, provider: "OPENAI" })).toBeNull();
    expect(nihoApiStepModel({ profile: "light" }, { ...descriptor, model: "" })).toBeNull();
  });

  it("フローの写しは全工程を NIHO の AI に固定し、使えない提供元なら工程が無くても null", () => {
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    const snapshot = createNihoApiFlowSnapshot(flow, descriptor)!;
    expect(snapshot.id).toBe("flow-1");
    expect(snapshot.steps).toEqual(flow.steps);
    expect(Object.keys(snapshot.models)).toEqual(flow.steps.map((step) => step.id));
    for (const step of flow.steps) expect(snapshot.models[step.id]).toEqual(nihoApiStepModel(step, descriptor));
    expect(createNihoApiFlowSnapshot(flow, { ...descriptor, provider: "ANTHROPIC" })).toBeNull();
    expect(createNihoApiFlowSnapshot({ ...flow, steps: [] }, { ...descriptor, provider: "ANTHROPIC" })).toBeNull();
    expect(createNihoApiFlowSnapshot({ ...flow, steps: [] }, descriptor)?.models).toEqual({});
  });

  it("固定モデルの一致は提供元とモデルだけを見る（思考量は比べない）", () => {
    const fixed = nihoApiStepModel({ profile: STANDARD_PROFILE_ID }, descriptor)!;
    expect(matchesNihoApi(fixed, descriptor)).toBe(true);
    const highEffort = { ...fixed, effort: "high" as const };
    expect(matchesNihoApi(highEffort, descriptor)).toBe(true);
    expect(matchesNihoApi({ provider: "gemini", model: "gemini-3.8-flash" }, descriptor)).toBe(true);
    expect(matchesNihoApi({ ...fixed, model: "gemini-3.1-pro-preview" }, descriptor)).toBe(false);
    expect(matchesNihoApi({ ...fixed, provider: "claude" }, descriptor)).toBe(false);
    expect(matchesNihoApi(undefined, descriptor)).toBe(false);
    expect(matchesNihoApi({ provider: null, model: null }, descriptor)).toBe(false);
    // 開示が工程を動かせない提供元なら、同じ名前のモデルでも一致としない
    expect(matchesNihoApi({ provider: "gpt", model: "gpt-5.6-terra" }, { provider: "OPENAI", model: "gpt-5.6-terra" })).toBe(false);
    expect(matchesNihoApi({ provider: "gemini", model: "" }, { ...descriptor, model: "" })).toBe(false);
  });

  it("持ち替えは NIHO の AI と違う工程だけ（全部合っていれば {}・使えない提供元は null）", () => {
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    const ids = flow.steps.map((step) => step.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const claude = { provider: "claude" as const, model: "claude-sonnet-5", effort: "high" as const, profileId: STANDARD_PROFILE_ID, profileName: "標準", connection: "subscription" as const };
    const allClaude = { steps: flow.steps, models: Object.fromEntries(ids.map((id) => [id, claude])) };
    // 全部違う: 渡した工程すべてを、工程のプロファイルのまま NIHO の AI のモデルへ
    const all = nihoApiModelSwap(allClaude, ids, descriptor)!;
    expect(Object.keys(all)).toEqual(ids);
    for (const step of flow.steps) expect(all[step.id]).toEqual(nihoApiStepModel(step, descriptor));
    // 一部だけ違う: 合っている工程（思考量だけ違っても）は持ち替えない。渡していない工程・フローに無い工程も入れない
    const fixed = nihoApiStepModel(flow.steps[0]!, descriptor)!;
    const partial = { steps: flow.steps, models: { ...allClaude.models, [ids[0]!]: { ...fixed, effort: "high" as const } } };
    expect(Object.keys(nihoApiModelSwap(partial, ids, descriptor)!)).toEqual(ids.slice(1));
    expect(Object.keys(nihoApiModelSwap(partial, [ids[1]!, "missing"], descriptor)!)).toEqual([ids[1]]);
    // 固定の無い工程も持ち替える（matchesNihoApi でない）
    expect(Object.keys(nihoApiModelSwap({ steps: flow.steps, models: {} }, [ids[0]!], descriptor)!)).toEqual([ids[0]]);
    // 全部合っている: {}（2 回目に押したときは書かない）
    const swapped = { steps: flow.steps, models: { ...allClaude.models, ...all } };
    expect(nihoApiModelSwap(swapped, ids, descriptor)).toEqual({});
    expect(nihoApiModelSwap(allClaude, [], descriptor)).toEqual({});
    // NIHO の AI で動かせない提供元・モデルが無い: null（工程が無くても）
    expect(nihoApiModelSwap(allClaude, ids, { provider: "ANTHROPIC", model: "claude-sonnet-5" })).toBeNull();
    expect(nihoApiModelSwap(allClaude, [], { provider: "OPENAI", model: "gpt-5.6-terra" })).toBeNull();
    expect(nihoApiModelSwap(allClaude, ids, { ...descriptor, model: "" })).toBeNull();
  });
});
