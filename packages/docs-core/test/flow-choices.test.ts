import { describe, expect, it } from "vitest";

import {
  FLOW_CHOICE_GROUP_LABELS,
  FLOW_CHOICE_LABEL,
  FLOW_MAX_STEPS,
  FLOW_TEMPLATES,
  buildFlowChoices,
  createBlankFlow,
  createFlowFromTemplate,
  defaultFlowChoice,
  flowChoiceKey,
  flowStepLine,
  flowStepLineParts,
  flowUnusableReason,
  isUnmodifiedTemplateCopy,
  parseFlowChoiceKey,
  uniqueFlowName,
  type Flow,
} from "../src/index.js";

const template = (id: string) => FLOW_TEMPLATES.find((candidate) => candidate.id === id)!;

function flow(id: string, name: string, steps: Flow["steps"] = [{ id: `${id}-1`, name: "要約", instruction: "要約する", profile: "standard" }]): Flow {
  return { version: 1, id, name, revision: 1, guide: "", terms: [], samples: [], steps };
}

describe("工程の選択肢（#18883）", () => {
  it("欄とまとまりの名前は 1 か所で持つ", () => {
    expect(FLOW_CHOICE_LABEL).toBe("工程");
    expect(FLOW_CHOICE_GROUP_LABELS).toEqual({ flows: "あなたの工程", templates: "テンプレート" });
  });

  it("あなたの工程を渡した並びのまま先に、テンプレート 4 つを後に並べる", () => {
    const choices = buildFlowChoices([flow("b", "定例"), flow("a", "取材")]);
    expect(choices.groups.map((group) => [group.kind, group.label])).toEqual([
      ["flows", "あなたの工程"],
      ["templates", "テンプレート"],
    ]);
    expect(choices.options.map((option) => [option.key, option.name])).toEqual([
      ["flow:b", "定例"],
      ["flow:a", "取材"],
      ["template:tpl-1", "記事制作"],
      ["template:tpl-2", "議事録"],
      ["template:tpl-3", "インサイト整理"],
      ["template:tpl-4", "コーチング"],
    ]);
    expect(choices.options).toEqual([...choices.groups[0].options, ...choices.groups[1].options]);
    // 工程が無いときはテンプレートだけ
    expect(buildFlowChoices([]).options.map((option) => option.kind)).toEqual(["template", "template", "template", "template"]);
  });

  it("手を加えていない写しを持っているテンプレートは出さず、手を加えた写しなら出す", () => {
    const minutes = { ...createFlowFromTemplate(template("tpl-2"), "flow-m"), name: "議事録 2" };
    expect(isUnmodifiedTemplateCopy(minutes, template("tpl-2"))).toBe(true);
    expect(buildFlowChoices([minutes]).options.map((option) => option.key)).toEqual([
      "flow:flow-m",
      "template:tpl-1",
      "template:tpl-3",
      "template:tpl-4",
    ]);

    // モデルの指定・名前は比べない
    const otherModel = { ...minutes, name: "別名", steps: minutes.steps.map((step) => ({ ...step, profile: "advanced", provider: "gpt" as const })) };
    expect(isUnmodifiedTemplateCopy(otherModel, template("tpl-2"))).toBe(true);

    const changed: Array<[string, Flow]> = [
      ["文書ガイド", { ...minutes, guide: `${minutes.guide}\n追記` }],
      ["指示文", { ...minutes, steps: minutes.steps.map((step, index) => (index === 0 ? { ...step, instruction: `${step.instruction}。` } : step)) }],
      ["工程の名前", { ...minutes, steps: minutes.steps.map((step, index) => (index === 0 ? { ...step, name: "別の名前" } : step)) }],
      ["工程の id", { ...minutes, steps: minutes.steps.map((step, index) => (index === 0 ? { ...step, id: "zzzzzzzz" } : step)) }],
      ["工程の数", { ...minutes, steps: minutes.steps.slice(1) }],
      // 案件向けに固有名詞・お手本の文書を足した工程は、元のテンプレートの写しではない（元のテンプレートを隠さない）
      ["共通の固有名詞", { ...minutes, terms: [{ term: "鎌倉ひとはこ", reading: "かまくらひとはこ", variants: [], note: "" }] }],
      ["お手本の文書", { ...minutes, samples: [{ id: "sample-1", name: "過去の議事録", chars: 1200 }] }],
    ];
    for (const [label, edited] of changed) {
      expect(isUnmodifiedTemplateCopy(edited, template("tpl-2")), label).toBe(false);
      expect(buildFlowChoices([edited]).options.some((option) => option.key === "template:tpl-2"), label).toBe(true);
    }
  });

  it("選べない理由は共通の文で、アプリだけの検査は共通の理由が無いときに使う", () => {
    expect(FLOW_MAX_STEPS).toBe(32);
    expect(flowUnusableReason({ steps: [] })).toBe("工程がありません");
    expect(flowUnusableReason({ steps: Array.from({ length: 33 }, () => ({ instruction: "指示" })) })).toBe("工程が 32 個を超えています");
    expect(flowUnusableReason({ steps: Array.from({ length: 32 }, () => ({ instruction: "指示" })) })).toBeNull();
    expect(flowUnusableReason({ steps: [{ instruction: "指示" }, { instruction: "  " }] })).toBe("指示文のない工程があります");

    const choices = buildFlowChoices([createBlankFlow("blank"), flow("ok", "定例"), flow("big", "大きい")], {
      problem: (candidate) => (candidate.id === "big" || candidate.id === "blank" ? "大きいため Macアプリで使ってください" : null),
    });
    expect(choices.options.filter((option) => option.kind === "flow").map((option) => [option.id, option.name, option.problem])).toEqual([
      ["blank", "無題", "工程がありません"],
      ["ok", "定例", null],
      ["big", "大きい", "大きいため Macアプリで使ってください"],
    ]);
    expect(choices.options.filter((option) => option.kind === "template").every((option) => option.problem === null)).toBe(true);
  });

  it("既定は候補のうち選べる最初のもの → あなたの工程の選べる先頭 → 無し。テンプレートを既定の行き先にしない", () => {
    const { options } = buildFlowChoices([createBlankFlow("blank"), flow("first", "定例"), flow("second", "取材")]);
    expect(defaultFlowChoice(options, ["flow:second"])?.key).toBe("flow:second");
    // 選べない・無い候補は飛ばす
    expect(defaultFlowChoice(options, ["flow:blank", "flow:gone", null, undefined, "flow:second"])?.key).toBe("flow:second");
    expect(defaultFlowChoice(options, [])?.key).toBe("flow:first");
    // 明示された候補ならテンプレートも選ぶ（前に選んだもの）
    expect(defaultFlowChoice(options, ["template:tpl-3"])?.key).toBe("template:tpl-3");
    // 選べる工程が無ければテンプレートがあっても無し（記事制作を標準にしない）
    expect(defaultFlowChoice(buildFlowChoices([]).options, [])).toBeNull();
    expect(defaultFlowChoice(buildFlowChoices([createBlankFlow("blank")]).options, ["flow:blank"])).toBeNull();
  });

  it("工程の列は工程 1 の名前を先頭に › でつなぐ", () => {
    const article = template("tpl-1");
    expect(flowStepLine(article.steps)).toBe(["文字起こし", ...article.steps.map((step) => step.name)].join(" › "));
    expect(flowStepLine([{ name: "発言の抽出" }, { name: "インサイト" }])).toBe("文字起こし › 発言の抽出 › インサイト");
    expect(flowStepLineParts([{ name: "発言の抽出" }, { name: "インサイト" }])).toEqual(["文字起こし", "発言の抽出", "インサイト"]);
    expect(flowStepLine([], "文章")).toBe("文章");
  });

  it("選んだものの文字列を作って分ける", () => {
    expect(flowChoiceKey("flow", "flow-1")).toBe("flow:flow-1");
    expect(flowChoiceKey("template", "tpl-2")).toBe("template:tpl-2");
    expect(parseFlowChoiceKey("template:tpl-2")).toEqual({ kind: "template", id: "tpl-2" });
    expect(parseFlowChoiceKey("flow:a:b")).toEqual({ kind: "flow", id: "a:b" });
    expect(parseFlowChoiceKey("flow-1")).toBeNull();
    expect(parseFlowChoiceKey("template:")).toBeNull();
  });

  it("テンプレートから作る工程の名前は、あなたの工程と重ならない", () => {
    const flows = [flow("a", "議事録"), flow("b", "議事録 2")];
    expect(uniqueFlowName(template("tpl-2").name, flows)).toBe("議事録 3");
    expect(uniqueFlowName(template("tpl-1").name, flows)).toBe("記事制作");
  });
});
