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
  engineBillingLabel,
  engineConnection,
  engineIdLabel,
  engineMetered,
  engineProvider,
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
    expect(settings.version).toBe(5);
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
    expect(settings.transcription).toEqual({ language: "en", showTimestamps: false, engine: null, deepgram: false });
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
    // 保存し直しても同じ（版 5 として読む）
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
    // 版 4 までの Deepgram はサブスクリプションのエンジンに無かった（API キー方式だけ）ので読み替えない
    expect(settings.transcription).toEqual({ language: "ja", showTimestamps: false, engine: null, deepgram: false });
    expect(settings.cliPaths).toEqual({ gemini: "/opt/agy" });
  });
});

describe("タイムスタンプ表示の端末設定", () => {
  it("未設定・旧版・不正値は OFF、true だけを今の版（5）で復元する", () => {
    expect(defaultSettings().transcription.showTimestamps).toBe(false);
    expect(normalizeSettings(S1_SETTINGS).transcription.showTimestamps).toBe(false);
    expect(normalizeSettings({ ...S1_SETTINGS, transcription: { language: "ja", showTimestamps: "true" } }).transcription.showTimestamps).toBe(false);

    const restored = normalizeSettings({
      ...defaultSettings(),
      transcription: { language: "en", showTimestamps: true },
    });
    expect(restored.version).toBe(5);
    expect(restored.transcription).toEqual({ language: "en", showTimestamps: true, engine: null, deepgram: false });
  });

  it("ほかの設定を変えても選択を保持する", () => {
    const shown = { ...defaultSettings(), transcription: { ...defaultSettings().transcription, showTimestamps: true } };
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

  it("登録は方式を指定できる。使っていない方式の AI は最後の 1 つでも解除できる", () => {
    let settings = addProvider(defaultSettings(), "gemini", [], "apiKey");
    expect(settings.connections.apiKey.providers).toEqual(["gemini"]);
    // モデルの方式（サブスクリプション）の AI は変わらない
    expect(activeProviders(settings)).toEqual(["claude"]);
    expect(canRemoveProvider(settings, "gemini", "apiKey")).toBe(true);
    expect(canRemoveProvider(settings, "claude", "subscription")).toBe(false);
    // 登録していない方式の AI は解除できない
    expect(canRemoveProvider(settings, "gpt", "apiKey")).toBe(false);
    settings = removeProvider(settings, "gemini", "apiKey");
    expect(settings.connections.apiKey.providers).toEqual([]);
    // 方式を指定したモデルの合わせ込みは、その方式の表だけを変える
    const apiGpt = addProvider(defaultSettings(), "gpt", [], "apiKey");
    expect(alignProviderModels(apiGpt, "gpt", ["gpt-6-astra"], "apiKey").connections.subscription).toEqual(apiGpt.connections.subscription);
    expect(alignProviderModels(apiGpt, "gpt", ["gpt-6-astra"], "subscription")).toBe(apiGpt);
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
    expect(transcriptionEngines(settings)).toEqual(["gemini-subscription", "this-mac"]);
    expect(effectiveEngine(settings)).toBe("gemini-subscription");
    // 人が選んだら、使える間はそれ
    const chosen = setEngine(settings, "this-mac");
    expect(effectiveEngine(chosen)).toBe("this-mac");
    // Gemini を選んでいても、登録を外せば この Mac
    const gemini = setEngine(settings, "gemini-subscription");
    expect(effectiveEngine(removeProvider(gemini, "gemini"))).toBe("this-mac");
  });

  it("モデルの方式がサブスクリプションのまま、Deepgram と API キーの Gemini も登録して選べる。従量課金は選んだときだけ使う（owner 2026-10-19）", () => {
    let settings = addProvider(defaultSettings(), "gemini");
    settings = setDeepgram(settings, true);
    settings = addProvider(settings, "gemini", [], "apiKey");
    expect(settings.connection).toBe("subscription");
    // モデルの方式の AI は変わらない（工程・工程設計・会話はサブスクリプションのまま）
    expect(activeProviders(settings)).toEqual(["claude", "gemini"]);
    expect(transcriptionEngines(settings)).toEqual(["gemini-subscription", "gemini-api", "this-mac", "deepgram"]);
    expect(effectiveEngine(settings)).toBe("gemini-subscription");
    expect(effectiveEngine(setEngine(settings, "deepgram"))).toBe("deepgram");
    expect(effectiveEngine(setEngine(settings, "gemini-api"))).toBe("gemini-api");
    // サブスクリプションの Gemini を外しても、従量課金（API キーの Gemini・Deepgram）へ自動では寄せない
    expect(effectiveEngine(removeProvider(settings, "gemini", "subscription"))).toBe("this-mac");
    // モデルの方式を切り替えても、エンジンの候補と選んだエンジンは変わらない
    const chosen = setEngine(settings, "deepgram");
    expect(transcriptionEngines(setConnection(chosen, "apiKey"))).toEqual(transcriptionEngines(chosen));
    expect(effectiveEngine(setConnection(chosen, "apiKey"))).toBe("deepgram");
    // 提供元・方式・料金の種類（サブスクリプションは料金なしではなく契約の範囲）
    expect(["gemini-subscription", "gemini-api", "this-mac", "deepgram"].map((id) => engineProvider(id as never))).toEqual([
      "gemini",
      "gemini",
      "this-mac",
      "deepgram",
    ]);
    expect(engineConnection("gemini-subscription")).toBe("subscription");
    expect(engineConnection("gemini-api")).toBe("apiKey");
    expect(engineConnection("deepgram")).toBe("apiKey");
    expect(engineConnection("this-mac")).toBeNull();
    expect(engineMetered("deepgram") && engineMetered("gemini-api")).toBe(true);
    expect(engineMetered("gemini-subscription") || engineMetered("this-mac")).toBe(false);
    expect(engineBillingLabel("this-mac")).toBe("料金なし");
    expect(engineBillingLabel("gemini-subscription")).toBe("契約の範囲");
    expect(engineBillingLabel("deepgram")).toBe("従量課金");
    // Gemini は両方の方式を登録しているときだけ方式を添える
    expect(engineIdLabel(settings, "gemini-api")).toBe("Gemini（API キー）");
    expect(engineIdLabel(settings, "gemini-subscription")).toBe("Gemini（サブスクリプション）");
    expect(engineIdLabel(removeProvider(settings, "gemini", "apiKey"), "gemini-subscription")).toBe("Gemini");
    expect(engineIdLabel(settings, "deepgram")).toBe("Deepgram");
  });
});

describe("この Mac で動かない文字起こし（#18753）", () => {
  afterEach(() => rememberSpeechSupport(null));

  it("音声認識を使えない Mac では「この Mac」を既定にせず、動く中の先頭にする（人が「この Mac」を選んでいても）。従量課金には自動で寄せない", () => {
    const settings = setDeepgram(defaultSettings(), true);
    expect(effectiveEngine(settings)).toBe("this-mac");
    rememberSpeechSupport("engine");
    // 動くのが従量課金の Deepgram だけなら自動では選ばず、この Mac のまま実行の前に理由を出す（run-readiness）
    expect(effectiveEngine(settings)).toBe("this-mac");
    // 人が Deepgram を選べば Deepgram
    expect(effectiveEngine(setEngine(settings, "deepgram"))).toBe("deepgram");
    // Gemini は音声認識を使わないので、登録していれば Gemini（人が「この Mac」を選んでいても）
    expect(effectiveEngine(addProvider(settings, "gemini"))).toBe("gemini-subscription");
    expect(effectiveEngine(setEngine(addProvider(settings, "gemini"), "this-mac"))).toBe("gemini-subscription");
    // 確かめた結果を渡せば、覚えている結果より先
    expect(effectiveEngine(settings, null)).toBe("this-mac");
    // エンジンの並び（設定の選択肢）は変えない
    expect(transcriptionEngines(settings)).toEqual(["this-mac", "deepgram"]);
  });

  it("macOS 26 より前では Gemini も動かない。Deepgram は選んだときだけ使い、どれも当てはまらなければ人が選んだもの（無ければ従量課金でない先頭）のまま", () => {
    rememberSpeechSupport("os");
    let settings = addProvider(defaultSettings(), "gemini");
    expect(effectiveEngine(settings)).toBe("gemini-subscription");
    expect(effectiveEngine(setEngine(settings, "this-mac"))).toBe("this-mac");
    settings = setDeepgram(settings, true);
    expect(effectiveEngine(settings)).toBe("gemini-subscription");
    expect(effectiveEngine(setEngine(settings, "deepgram"))).toBe("deepgram");
    expect(engineRunsHere("gemini-subscription")).toBe(false);
    expect(engineRunsHere("gemini-api")).toBe(false);
    expect(engineRunsHere("deepgram")).toBe(true);
    expect(engineRunsHere("gemini-api", "engine")).toBe(true);
    expect(engineRunsHere("this-mac", "engine")).toBe(false);
    expect(engineRunsHere("this-mac", null)).toBe(true);
  });
});

describe("方式（S2b）", () => {
  it("S2a の版 2 の transcription.engine はサブスクリプションのエンジンとして既定へ移す", () => {
    const settings = normalizeSettings({
      version: 2,
      connection: "subscription",
      connections: { subscription: { providers: ["claude", "gemini"], profiles: [] }, apiKey: { providers: [], profiles: [] } },
      transcription: { engine: "this-mac", language: "ja" },
    });
    expect(settings.transcription.engine).toBe("this-mac");
    expect(effectiveEngine(settings)).toBe("this-mac");
    expect(effectiveEngine(setConnection(settings, "apiKey"))).toBe("this-mac");
  });

  it("版 4 の方式ごとのエンジンは今の方式のエンジンを既定として引き継ぎ、Deepgram の登録は方式に依らない登録へ移す", () => {
    const v4 = {
      version: 4,
      connection: "apiKey",
      connections: {
        subscription: { providers: ["claude", "gemini"], profiles: [], engine: "this-mac" },
        apiKey: { providers: ["gemini"], profiles: [], engine: "gemini", deepgram: true },
      },
      transcription: { language: "ja", showTimestamps: true },
    };
    const settings = normalizeSettings(v4);
    expect(settings.version).toBe(5);
    expect(settings.transcription).toEqual({ language: "ja", showTimestamps: true, engine: "gemini-api", deepgram: true });
    expect(transcriptionEngines(settings)).toEqual(["gemini-subscription", "gemini-api", "this-mac", "deepgram"]);
    // 方式の表はエンジン・Deepgram の欄を持たない
    expect(Object.keys(settings.connections.apiKey).sort()).toEqual(["profiles", "providers"]);
    // サブスクリプションで保存していた版 4 は、サブスクリプションのエンジンを引き継ぐ（Gemini はその方式の Gemini）
    expect(normalizeSettings({ ...v4, connection: "subscription" }).transcription.engine).toBe("this-mac");
    const subscriptionGemini = { ...v4.connections.subscription, engine: "gemini" };
    expect(normalizeSettings({ ...v4, connection: "subscription", connections: { ...v4.connections, subscription: subscriptionGemini } }).transcription.engine).toBe(
      "gemini-subscription",
    );
    // サブスクリプションの表の "deepgram" は版 4 でも無効だった値なので読み替えない
    const subscriptionDeepgram = { ...v4.connections.subscription, engine: "deepgram" };
    expect(
      normalizeSettings({ ...v4, connection: "subscription", connections: { ...v4.connections, subscription: subscriptionDeepgram } }).transcription.engine,
    ).toBeNull();
    // 版 4 の API キー方式で選んでいなかった人は API キーの Gemini で文字起こししていたので、黙ってこの Mac に変えず引き継ぐ
    const unchosen = { ...v4, connections: { ...v4.connections, apiKey: { providers: ["gemini"], profiles: [], deepgram: true } } };
    expect(normalizeSettings(unchosen).transcription.engine).toBe("gemini-api");
    expect(effectiveEngine(normalizeSettings(unchosen))).toBe("gemini-api");
    // API キーの Gemini が無ければ引き継ぐものは無い（Deepgram は自動では選ばない）
    const withoutGemini = { ...v4, connections: { ...v4.connections, apiKey: { providers: ["claude"], profiles: [], deepgram: true } } };
    expect(normalizeSettings(withoutGemini).transcription.engine).toBeNull();
    expect(effectiveEngine(normalizeSettings(withoutGemini))).toBe("gemini-subscription");
  });

  it("方式を切り替えても、それぞれの 登録した AI・プロファイルと文字起こしのエンジンはそのまま（鍵は設定に置かない）", () => {
    let settings = addProvider(defaultSettings(), "gemini");
    settings = setEngine(settings, "this-mac");
    settings = setConnection(settings, "apiKey");
    expect(activeProviders(settings)).toEqual([]);
    settings = addProvider(settings, "claude");
    settings = setDeepgram(settings, true);
    // サブスクリプションの Gemini は、API キー方式のままでも文字起こしに使える
    expect(transcriptionEngines(settings)).toEqual(["gemini-subscription", "this-mac", "deepgram"]);
    settings = addProvider(settings, "gemini");
    // Gemini → この Mac → Deepgram の順（Gemini は方式ごとに別のエンジン）。人が選んだものを使う
    expect(transcriptionEngines(settings)).toEqual(["gemini-subscription", "gemini-api", "this-mac", "deepgram"]);
    expect(effectiveEngine(settings)).toBe("this-mac");
    settings = setEngine(settings, "deepgram");
    expect(effectiveEngine(settings)).toBe("deepgram");
    // サブスクリプションに戻しても、文字起こしのエンジンの候補と選んだエンジンは変わらない
    const back = setConnection(settings, "subscription");
    expect(activeProviders(back)).toEqual(["claude", "gemini"]);
    expect(transcriptionEngines(back)).toEqual(transcriptionEngines(settings));
    expect(effectiveEngine(back)).toBe("deepgram");
    // Deepgram の登録を外すと、選んでいたエンジンは従量課金でない先頭へ（API キーの Gemini には寄せない）
    expect(effectiveEngine(setDeepgram(settings, false))).toBe("gemini-subscription");
    // 保存し直しても同じ。鍵の欄は無い
    const saved = JSON.parse(JSON.stringify(settings));
    expect(normalizeSettings(saved)).toEqual(settings);
    expect(Object.keys(saved.connections.apiKey).sort()).toEqual(["profiles", "providers"]);
    expect(Object.keys(saved.transcription).sort()).toEqual(["deepgram", "engine", "language", "showTimestamps"]);
    expect(JSON.stringify(saved)).not.toMatch(/secret|"key"|sk-/i);
  });
});
