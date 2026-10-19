import { describe, expect, it } from "vitest";
import {
  ADVANCED_PROFILE_ID,
  LIGHT_PROFILE_ID,
  FLOW_TEMPLATES,
  STANDARD_PROFILE_ID,
  contractEffort,
  contractProvider,
  countChars,
  createFlowFromTemplate,
  createFlowSnapshot,
  snapshotModelLabel,
  defaultProfiles,
  findTemplate,
  hashText,
  mergeGlossaries,
  parseVariants,
  reasonMessage,
  resolveStepModel,
  sourceStepName,
  speechHints,
  termKey,
  validateFlow,
} from "../src/index.js";

describe("text", () => {
  it("字数はコードポイントで数える", () => {
    expect(countChars("あいう")).toBe(3);
    expect(countChars("𠮷野家")).toBe(3);
    expect(countChars("")).toBe(0);
  });

  it("ハッシュは同じ文で同じ・違う文で違う", () => {
    expect(hashText("鎌倉")).toBe(hashText("鎌倉"));
    expect(hashText("鎌倉")).not.toBe(hashText("鎌倉 "));
    expect(hashText("")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("語の鍵は NFKC・小文字化・空白除去", () => {
    expect(termKey("ＮＩＨＯ 鎌倉")).toBe("niho鎌倉");
  });
});

describe("glossary", () => {
  it("誤りやすい表記は「・」「、」「,」で分ける", () => {
    expect(parseVariants("NIHO 鎌倉・ニホ鎌倉、niho, ")).toEqual(["NIHO 鎌倉", "ニホ鎌倉", "niho"]);
  });

  it("空の行を除いて合わせ、hints は表記だけ（sidecar は よみ・誤りやすい表記 を認識に使わない）", () => {
    const merged = mergeGlossaries(
      [{ term: " 材木座 ", reading: "ざいもくざ", variants: [], note: "" }, { term: "", reading: "x", variants: [], note: "" }],
      [{ term: "材木座", reading: "別", variants: [], note: "" }, { term: "段葛", reading: "だんかずら", variants: ["段かずら"], note: "" }],
    );
    expect(merged.map((entry) => entry.term)).toEqual(["材木座", "段葛"]);
    expect(merged[0]?.reading).toBe("ざいもくざ");
    expect(speechHints(merged)).toEqual([{ term: "材木座" }, { term: "段葛" }]);
  });
});

describe("snapshot", () => {
  it("案件の作成時に工程ごとのモデルを解決して持つ（設定を後で変えても変わらない）", () => {
    const profiles = defaultProfiles();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
    const snapshot = createFlowSnapshot(flow, profiles, ["claude"]);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.models[flow.steps[0]!.id]).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-6",
      effort: "low",
      profileId: LIGHT_PROFILE_ID,
      profileName: "軽量",
      connection: "subscription",
    });
    expect(snapshotModelLabel(snapshot.models[flow.steps[1]!.id]!)).toBe("高性能 · Opus 4.8 · 高");
    profiles.find((profile) => profile.id === LIGHT_PROFILE_ID)!.models.claude = { model: "haiku", effort: "high" };
    expect(snapshot.models[flow.steps[0]!.id]?.model).toBe("claude-sonnet-4-6");
    flow.steps[0]!.name = "変えた";
    expect(snapshot.steps[0]!.name).toBe("文字起こし修正");
    expect(createFlowSnapshot(flow, profiles, []).models).toEqual({});
  });
});

describe("profiles", () => {
  it("工程のモデルはプロファイル × 登録した AI", () => {
    const profiles = defaultProfiles();
    const standard = resolveStepModel({ profile: STANDARD_PROFILE_ID }, profiles, ["claude"]);
    expect(standard?.model).toEqual({ model: "claude-sonnet-4-6", effort: "high" });
    const advanced = resolveStepModel({ profile: ADVANCED_PROFILE_ID }, profiles, ["claude"]);
    expect(advanced?.model).toEqual({ model: "claude-opus-4-8", effort: "high" });
    expect(resolveStepModel({ profile: "none" }, profiles, ["claude"])).toBeNull();
    // 登録していない AI を指す工程は、登録した AI の先頭へ寄せる（寄せたことを返す）
    expect(resolveStepModel({ profile: STANDARD_PROFILE_ID, provider: "gpt" }, profiles, ["claude"])).toMatchObject({
      provider: "claude",
      redirected: true,
    });
    expect(resolveStepModel({ profile: STANDARD_PROFILE_ID }, profiles, [])).toBeNull();
  });
});

describe("turn", () => {
  it("契約の名前に写す", () => {
    expect(contractProvider("claude")).toBe("ClaudeCode");
    expect(contractEffort("max")).toBe("Max");
    expect(reasonMessage("CliLoginRequired")).toContain("ログイン");
  });
});

describe("templates", () => {
  it("記事制作・議事録・インサイト整理・コーチングの 4 つが同格に並ぶ（既定の印は無い）", () => {
    expect(FLOW_TEMPLATES.map((template) => [template.name, template.steps.map((step) => step.name)])).toEqual([
      ["記事制作", ["文字起こし修正", "記事方針", "記事本文"]],
      ["議事録", ["議事録", "共有用の要約"]],
      ["インサイト整理", ["インサイト"]],
      ["コーチング", ["文字起こし修正", "分析"]],
    ]);
    expect(FLOW_TEMPLATES.map((template) => template.id)).toEqual(["tpl-1", "tpl-2", "tpl-3", "tpl-4"]);
    // 同格: どれも同じ形（id・名前・ガイド・工程）だけを持ち、既定を表す値を持たない
    for (const template of FLOW_TEMPLATES) expect(Object.keys(template).sort()).toEqual(["guide", "id", "name", "steps"]);
    expect(FLOW_TEMPLATES[2]?.guide).toBe("");
    expect(FLOW_TEMPLATES[0]?.guide.startsWith("## 記事の目的と読者")).toBe(true);
    expect(FLOW_TEMPLATES[1]?.guide.startsWith("## 文書の目的と読者")).toBe(true);
    expect(FLOW_TEMPLATES[3]?.guide.startsWith("## 文書の目的と読者")).toBe(true);
  });

  it("コーチング: 文字起こし修正（標準）→ 分析（高性能）。ガイドは 6 見出しで拠点名が無い", () => {
    const coaching = findTemplate("tpl-4")!;
    expect(coaching.name).toBe("コーチング");
    expect(coaching.steps.map((step) => [step.id, step.name, step.profile])).toEqual([
      ["c5v8n3qd", "文字起こし修正", LIGHT_PROFILE_ID],
      ["a3m9t6kw", "分析", ADVANCED_PROFILE_ID],
    ]);
    const headings = coaching.guide.split("\n").filter((line) => line.startsWith("## ")).map((line) => line.slice(3));
    expect(headings).toEqual(["文書の目的と読者", "構成", "書き方・文体・口調", "表記", "してはいけないこと", "見直しのチェックリスト"]);
    expect(coaching.guide).not.toMatch(/NIHO|鎌倉|拠点/);
    expect(coaching.steps[1]!.instruction.startsWith("修正済みの文字起こしと参考ページ（事前メモ）をもとに")).toBe(true);
  });

  it("コーチングの文字起こし修正は、記事制作の文字起こし修正の段落の行の直後に 1 行足したもの（ほかの行は同じ）", () => {
    const base = findTemplate("tpl-1")!.steps[0]!.instruction.split("\n");
    const coaching = findTemplate("tpl-4")!.steps[0]!.instruction.split("\n");
    const at = base.indexOf("- 句読点・段落・改行を整える。段落の整理で内容を圧縮しない。");
    expect(at).toBeGreaterThan(0);
    expect(coaching).toEqual([...base.slice(0, at + 1), "- コーチの問いと本人の答えの対応が分かるように段落を分ける。", ...base.slice(at + 1)]);
  });

  it("コーチングのテンプレートからフローを作れ、検証を通る", () => {
    const flow = createFlowFromTemplate(findTemplate("tpl-4")!, "flow-coaching");
    expect(flow).toMatchObject({ version: 1, id: "flow-coaching", name: "コーチング", revision: 1, terms: [], samples: [] });
    expect(flow.guide).toBe(findTemplate("tpl-4")!.guide);
    expect(flow.steps.map((step) => step.id)).toEqual(["c5v8n3qd", "a3m9t6kw"]);
    expect(validateFlow(flow, defaultProfiles())).toEqual([]);
  });

  it("記事制作の最初のガイドは拠点名の無い一般的な文（6 見出し・800 字前後）", () => {
    const guide = FLOW_TEMPLATES[0]!.guide;
    const headings = guide.split("\n").filter((line) => line.startsWith("## ")).map((line) => line.slice(3));
    expect(headings).toEqual(["記事の目的と読者", "構成", "書き方・文体・口調", "表記", "してはいけないこと", "見直しのチェックリスト"]);
    expect(countChars(guide)).toBeGreaterThan(650);
    expect(countChars(guide)).toBeLessThan(950);
    expect(guide).not.toMatch(/NIHO|鎌倉|拠点/);
  });

  it("工程の id は意味を持たない固定の文字列で、テンプレートをまたいで重ならない", () => {
    const ids = FLOW_TEMPLATES.flatMap((template) => template.steps.map((step) => step.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[a-z0-9]{8}$/.test(id))).toBe(true);
  });

  it("フローはテンプレートの写しで、テンプレートを変えない", () => {
    const template = findTemplate("tpl-2");
    expect(template).toBeDefined();
    const flow = createFlowFromTemplate(template!, "flow-x");
    flow.steps[0]!.name = "変えた";
    expect(template!.steps[0]!.name).toBe("議事録");
    expect(flow).toMatchObject({ version: 1, id: "flow-x", name: "議事録", revision: 1, terms: [], samples: [] });
  });

  it("工程 1 の名前は素材で決まる", () => {
    expect(sourceStepName({ kind: "audio", audio: [] })).toBe("文字起こし");
    expect(sourceStepName({ kind: "text" })).toBe("文章");
    // 素材の種類が分からない（素材を持たない以前の行）ときは「文字起こし」
    expect(sourceStepName(null)).toBe("文字起こし");
    expect(sourceStepName(undefined)).toBe("文字起こし");
  });
});
