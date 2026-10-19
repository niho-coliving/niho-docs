import { afterEach, describe, expect, it } from "vitest";
import { FLOW_TEMPLATES, createFlowFromTemplate, createFlowSnapshot, defaultProfiles } from "@niho/docs-core";
import {
  activeProfiles,
  activeProviders,
  addProvider,
  alignProviderModels,
  canRemoveProvider,
  defaultSettings,
  effectiveEngine,
  engineRunsHere,
  normalizeSettings,
  rememberSpeechSupport,
  removeProvider,
  setActiveProfiles,
  setConnection,
  setDeepgram,
  setEngine,
  transcriptionEngines,
} from "../src/lib/settings";

/** S1（版 1）の settings.json（アプリが保存していた形）。 */
const S1_SETTINGS = {
  version: 1,
  connection: "subscription",
  providers: ["claude"],
  profiles: [
    { id: "standard", name: "標準", models: { claude: { model: "sonnet", effort: "high" } } },
    { id: "advanced", name: "高性能", models: { claude: { model: "opus", effort: "max" } } },
  ],
  transcription: { engine: "this-mac", language: "en" },
  docsRoot: "/Users/test/Documents/My docs",
  cliPaths: { claude: "/opt/tools/claude" },
};

describe("設定の移行（S1 の形）", () => {
  it("S1 の settings.json はそのまま読めて、同じ AI・同じモデル・同じ文字起こしで動く", () => {
    const settings = normalizeSettings(S1_SETTINGS);
    expect(settings.version).toBe(4);
    // 保存先は「この Mac だけ」から始める（C3 #18595）
    expect(settings.vault).toEqual({ provider: "local", deviceName: null });
    expect(settings.connection).toBe("subscription");
    expect(activeProviders(settings)).toEqual(["claude"]);
    expect(activeProfiles(settings).map((profile) => [profile.id, profile.name, profile.models.claude])).toEqual([
      ["standard", "標準", { model: "sonnet", effort: "high" }],
      ["advanced", "高性能", { model: "opus", effort: "max" }],
      // 軽量は後から足した既定なので、前の版の設定には末尾に既定の値で足す
      ["light", "軽量", { model: "claude-sonnet-4-6", effort: "low" }],
    ]);
    // 後から登録する AI の列は既定で埋まる
    expect(activeProfiles(settings)[0]?.models.gemini).toEqual({ model: "gemini-3.8-flash", effort: "medium" });
    // S1 の engine は選べなかった値なので「使える中の先頭」にする（Claude だけなら この Mac）
    expect(settings.transcription).toEqual({ language: "en", showTimestamps: false });
    expect(settings.connections.subscription.engine).toBeNull();
    expect(effectiveEngine(settings)).toBe("this-mac");
    expect(settings.docsRoot).toBe("/Users/test/Documents/My docs");
    expect(settings.cliPaths).toEqual({ claude: "/opt/tools/claude" });
    // 工程の解決は S1 と同じ
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    const snapshot = createFlowSnapshot(flow, activeProfiles(settings), activeProviders(settings));
    expect(snapshot.models[flow.steps[1]!.id]).toEqual({
      provider: "claude",
      model: "opus",
      effort: "max",
      profileId: "advanced",
      profileName: "高性能",
      connection: "subscription",
    });
    // 保存し直しても同じ（版 4 として読む）
    expect(normalizeSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });

  it("形の合わない値は既定に戻す（知らない AI・思考量の合わない組み合わせ・相対パス）", () => {
    const settings = normalizeSettings({
      version: 2,
      connection: "subscription",
      connections: {
        subscription: {
          providers: ["gemini", "unknown", "gemini", "gpt"],
          profiles: [{ id: "standard", name: "標準", models: { gemini: { model: "gemini-3.8-flash", effort: "max" }, gpt: { model: "", effort: "high" } } }],
        },
      },
      transcription: { engine: "deepgram", language: "fr" },
      cliPaths: { gemini: "/opt/agy", gpt: "codex" },
    });
    expect(activeProviders(settings)).toEqual(["gemini", "gpt"]);
    // Gemini 3.8 Flash に「最大」は無い → 高へ寄せる。空のモデルは既定
    expect(activeProfiles(settings)[0]?.models.gemini).toEqual({ model: "gemini-3.8-flash", effort: "high" });
    expect(activeProfiles(settings)[0]?.models.gpt).toEqual({ model: "gpt-5.6-terra", effort: "high" });
    expect(activeProfiles(settings).map((profile) => profile.id)).toEqual(["standard", "advanced", "light"]);
    expect(settings.connections.apiKey.providers).toEqual([]);
    // Deepgram はサブスクリプションに無い（API キー方式だけ）
    expect(settings.connections.subscription.engine).toBeNull();
    expect(settings.transcription).toEqual({ language: "ja", showTimestamps: false });
    expect(settings.cliPaths).toEqual({ gemini: "/opt/agy" });
  });
});

describe("タイムスタンプ表示の端末設定", () => {
  it("未設定・旧版・不正値は OFF、true だけを今の版（4）で復元する", () => {
    expect(defaultSettings().transcription.showTimestamps).toBe(false);
    expect(normalizeSettings(S1_SETTINGS).transcription.showTimestamps).toBe(false);
    expect(normalizeSettings({ ...S1_SETTINGS, transcription: { language: "ja", showTimestamps: "true" } }).transcription.showTimestamps).toBe(false);

    const restored = normalizeSettings({
      ...defaultSettings(),
      transcription: { language: "en", showTimestamps: true },
    });
    expect(restored.version).toBe(4);
    expect(restored.transcription).toEqual({ language: "en", showTimestamps: true });
  });

  it("ほかの設定を変えても選択を保持する", () => {
    const shown = { ...defaultSettings(), transcription: { language: "ja" as const, showTimestamps: true } };
    expect(setConnection(shown, "apiKey").transcription.showTimestamps).toBe(true);
    expect(setEngine(shown, "this-mac").transcription.showTimestamps).toBe(true);
  });
});

describe("登録した AI", () => {
  it("追加は並びの最後。CLI の一覧にあるモデルへ合わせる（既定が無ければ一覧の先頭）", () => {
    let settings = defaultSettings();
    settings = addProvider(settings, "gpt", ["gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(activeProviders(settings)).toEqual(["claude", "gpt"]);
    expect(activeProfiles(settings).map((profile) => profile.models.gpt)).toEqual([
      { model: "gpt-5.6-terra", effort: "high" },
      { model: "gpt-5.6-terra", effort: "max" },
      { model: "gpt-5.6-terra", effort: "medium" },
    ]);
    settings = addProvider(settings, "gemini", ["gemini-3.8-flash-low"]);
    expect(activeProfiles(settings)[0]?.models.gemini).toEqual({ model: "gemini-3.8-flash", effort: "medium" });
    const other = addProvider(defaultSettings(), "gpt", ["gpt-6-astra"]);
    expect(activeProfiles(other)[1]?.models.gpt).toEqual({ model: "gpt-6-astra", effort: "max" });
    // 同じ AI は 2 回足さない
    expect(activeProviders(addProvider(settings, "gpt"))).toEqual(["claude", "gpt", "gemini"]);
  });

  it("ログイン後の一覧に今のモデルが無ければ合わせる（変える必要が無ければ同じ設定・未登録の AI は変えない）", () => {
    // 未ログインで追加（一覧が空）すると控えのモデルのまま
    const added = addProvider(defaultSettings(), "gpt", []);
    const before = activeProfiles(added).map((profile) => profile.models.gpt);
    const aligned = alignProviderModels(added, "gpt", ["gpt-6-astra"]);
    expect(activeProfiles(aligned).map((profile) => profile.models.gpt?.model)).toEqual(["gpt-6-astra", "gpt-6-astra", "gpt-6-astra"]);
    expect(alignProviderModels(aligned, "gpt", ["gpt-6-astra"])).toBe(aligned);
    expect(alignProviderModels(added, "gpt", [])).toBe(added);
    expect(activeProfiles(added).map((profile) => profile.models.gpt)).toEqual(before);
    expect(alignProviderModels(defaultSettings(), "gpt", ["gpt-6-astra"])).toEqual(defaultSettings());
  });

  it("解除は最後の 1 つだけできない。プロファイルの値は残す", () => {
    let settings = addProvider(defaultSettings(), "gpt");
    expect(canRemoveProvider(settings, "claude")).toBe(true);
    settings = removeProvider(settings, "claude");
    expect(activeProviders(settings)).toEqual(["gpt"]);
    expect(canRemoveProvider(settings, "gpt")).toBe(false);
    expect(removeProvider(settings, "gpt")).toBe(settings);
    expect(activeProfiles(settings)[0]?.models.claude).toEqual(defaultProfiles()[0]?.models.claude);
  });

  it("方式ごとに別の表（サブスクリプションの表を変えても API キー方式の表は変わらない）", () => {
    const base = defaultSettings();
    const changed = setActiveProfiles(base, [{ id: "standard", name: "標準", models: { claude: { model: "haiku", effort: "low" } } }]);
    expect(activeProfiles(changed)).toHaveLength(1);
    expect(changed.connections.apiKey).toEqual(base.connections.apiKey);
    const apiKey = { ...changed, connection: "apiKey" as const };
    expect(activeProviders(apiKey)).toEqual([]);
    // API キー方式の既定（Gemini の高性能は API にある 3.1 Pro）
    expect(activeProfiles(apiKey)).toEqual(defaultProfiles("apiKey"));
    expect(activeProfiles(apiKey)[1]?.models.gemini?.model).toBe("gemini-3.1-pro-preview");
  });
});

describe("文字起こしの既定のエンジン", () => {
  it("Gemini → この Mac の順で、登録した分だけ。既定は使える中の先頭で、登録を外すと追従する", () => {
    let settings = defaultSettings();
    expect(transcriptionEngines(settings)).toEqual(["this-mac"]);
    expect(effectiveEngine(settings)).toBe("this-mac");
    settings = addProvider(settings, "gemini");
    expect(transcriptionEngines(settings)).toEqual(["gemini", "this-mac"]);
    expect(effectiveEngine(settings)).toBe("gemini");
    // 人が選んだら、使える間はそれ
    const chosen = setEngine(settings, "this-mac");
    expect(effectiveEngine(chosen)).toBe("this-mac");
    // Gemini を選んでいても、登録を外せば この Mac
    const gemini = setEngine(settings, "gemini");
    expect(effectiveEngine(removeProvider(gemini, "gemini"))).toBe("this-mac");
  });
});

describe("この Mac で動かない文字起こし（#18753）", () => {
  afterEach(() => rememberSpeechSupport(null));

  it("音声認識を使えない Mac では「この Mac」を既定にせず、動く中の先頭にする（人が「この Mac」を選んでいても）", () => {
    let settings = setConnection(defaultSettings(), "apiKey");
    settings = addProvider(settings, "claude");
    settings = setDeepgram(settings, true);
    expect(effectiveEngine(settings)).toBe("this-mac");
    rememberSpeechSupport("engine");
    expect(effectiveEngine(settings)).toBe("deepgram");
    expect(effectiveEngine(setEngine(settings, "this-mac"))).toBe("deepgram");
    // Gemini は音声認識を使わないので、登録していれば Gemini
    expect(effectiveEngine(addProvider(settings, "gemini"))).toBe("gemini");
    // 確かめた結果を渡せば、覚えている結果より先
    expect(effectiveEngine(settings, null)).toBe("this-mac");
    // エンジンの並び（設定の選択肢）は変えない
    expect(transcriptionEngines(settings)).toEqual(["this-mac", "deepgram"]);
  });

  it("macOS 26 より前では Gemini も動かないので Deepgram にする。どれも動かなければ人が選んだもの（無ければ先頭）のまま", () => {
    rememberSpeechSupport("os");
    let settings = addProvider(defaultSettings(), "gemini");
    expect(effectiveEngine(settings)).toBe("gemini");
    expect(effectiveEngine(setEngine(settings, "this-mac"))).toBe("this-mac");
    settings = setConnection(settings, "apiKey");
    settings = addProvider(settings, "gemini");
    settings = setDeepgram(settings, true);
    expect(effectiveEngine(settings)).toBe("deepgram");
    expect(engineRunsHere("gemini")).toBe(false);
    expect(engineRunsHere("deepgram")).toBe(true);
    expect(engineRunsHere("gemini", "engine")).toBe(true);
    expect(engineRunsHere("this-mac", "engine")).toBe(false);
    expect(engineRunsHere("this-mac", null)).toBe(true);
  });
});

describe("方式（S2b）", () => {
  it("S2a の版 2 の transcription.engine はサブスクリプションのエンジンへ移す", () => {
    const settings = normalizeSettings({
      version: 2,
      connection: "subscription",
      connections: { subscription: { providers: ["claude", "gemini"], profiles: [] }, apiKey: { providers: [], profiles: [] } },
      transcription: { engine: "this-mac", language: "ja" },
    });
    expect(settings.connections.subscription.engine).toBe("this-mac");
    expect(settings.connections.apiKey.engine).toBeNull();
    expect(effectiveEngine(settings)).toBe("this-mac");
    expect(effectiveEngine(setConnection(settings, "apiKey"))).toBe("this-mac");
  });

  it("方式を切り替えても、それぞれの 登録した AI・プロファイル・エンジンはそのまま（鍵は設定に置かない）", () => {
    let settings = addProvider(defaultSettings(), "gemini");
    settings = setEngine(settings, "this-mac");
    settings = setConnection(settings, "apiKey");
    expect(activeProviders(settings)).toEqual([]);
    settings = addProvider(settings, "claude");
    settings = setDeepgram(settings, true);
    expect(transcriptionEngines(settings)).toEqual(["this-mac", "deepgram"]);
    settings = addProvider(settings, "gemini");
    // Gemini → この Mac → Deepgram の順。既定は使える中の先頭
    expect(transcriptionEngines(settings)).toEqual(["gemini", "this-mac", "deepgram"]);
    expect(effectiveEngine(settings)).toBe("gemini");
    settings = setEngine(settings, "deepgram");
    expect(effectiveEngine(settings)).toBe("deepgram");
    // サブスクリプションに戻すと、サブスクリプションの値（Deepgram は出ない）
    const back = setConnection(settings, "subscription");
    expect(activeProviders(back)).toEqual(["claude", "gemini"]);
    expect(transcriptionEngines(back)).toEqual(["gemini", "this-mac"]);
    expect(effectiveEngine(back)).toBe("this-mac");
    // Deepgram の登録を外すと、選んでいたエンジンは使える中の先頭へ
    expect(effectiveEngine(setDeepgram(settings, false))).toBe("gemini");
    // 保存し直しても同じ。鍵の欄は無い
    const saved = JSON.parse(JSON.stringify(settings));
    expect(normalizeSettings(saved)).toEqual(settings);
    expect(Object.keys(saved.connections.apiKey).sort()).toEqual(["deepgram", "engine", "profiles", "providers"]);
    expect(JSON.stringify(saved)).not.toMatch(/secret|"key"|sk-/i);
  });
});
