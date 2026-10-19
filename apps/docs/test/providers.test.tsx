// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import {
  FLOW_TEMPLATES,
  SOURCE_STEP_ID,
  UNREGISTERED_PROVIDER_MESSAGE,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  type Flow,
  type Project,
  type ProviderId,
  type TurnEvent,
} from "@niho/docs-core";
import { activeProfiles, activeProviders, normalizeSettings } from "../src/lib/settings";
import { button, buttons, click, renderApp, selectOption, typeInto, type Screen } from "./dom";
import { FakeBridge, done, fakeStatus, settingsWithProviders, type StoredProject } from "./fake-bridge";
import { addPage, createProjectByName, openChat, seedText, railItem } from "./pages";
import { THREE_STEP_TEMPLATE } from "./three-step-flow";

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

/** AI provider の名前（GPT だけを登録したときに出てはいけないもの）。 */
const NOT_GPT = /Claude|Anthropic|Sonnet|Opus|Fable|Haiku|Gemini|Antigravity|agy|Google(?! ドキュメント)/i;

function textProject(flow: Flow, providers: ProviderId[], name = "朝市 インタビュー"): Project {
  return {
    version: 1,
    id: "",
    name,
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), providers),
    info: { speakers: "2", language: "ja", terms: [], background: "" },
    source: { kind: "text" },
  };
}

async function bridgeWith(providers: ProviderId[], snapshotProviders: ProviderId[] = providers) {
  const bridge = new FakeBridge();
  bridge.settings = settingsWithProviders(providers);
  const flow = createFlowFromTemplate(THREE_STEP_TEMPLATE, "flow-1");
  bridge.flow = flow;
  const project = await bridge.createProject(
    textProject(flow, snapshotProviders),
    "[00:00:08] 朝市に出して三年目です。\n",
    { id: "save-1", kind: "save", at: "2026-10-15T00:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" },
    [],
  );
  return { bridge, flow, stored: bridge.projects.get(project.id)! };
}

function savedSettings(bridge: FakeBridge) {
  return normalizeSettings(bridge.settings);
}

function row(container: HTMLElement, name: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(".prow")].find((item) => item.querySelector("b")?.textContent === name);
}

async function openMenu(container: HTMLElement, label: string) {
  await click(container.querySelector(`button[aria-label="${label}のその他"]`)!);
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(condition()).toBe(true);
}

function gptDone(text: string): TurnEvent {
  return done(text, "EndTurn", "s1", "gpt-5.6-terra");
}

/** 案件の録音のページ（画面で足した 1 枚目）。 */
function firstRecording(bridge: FakeBridge, stored: StoredProject) {
  const page = stored.project.pages?.find((entry) => entry.kind === "rec");
  if (!page) throw new Error("recording page not found");
  return bridge.recording(stored.project.id, page.id);
}

/** 会話の欄で、工程の実行の会話を開く（実行の行は最後の実行の会話を出すので）。 */
async function openRunConversation(container: HTMLElement, stepName: string) {
  // 「AIと作る」は閉じて始まる（owner 2026-10-18・#18941）
  await openChat(container);
  await click(container.querySelector('[aria-label="会話の切り替え"]')!);
  const found = [...container.querySelectorAll<HTMLElement>(".chatmenu .crow")].find((item) => item.querySelector(".d")?.textContent === `▶ ${stepName}を実行`);
  if (!found) throw new Error(`conversation not found: ${stepName}`);
  await click(found);
}

describe("設定: 登録した AI の行と追加・解除", () => {
  it("登録した AI の行だけを出し、「＋ 追加」で未登録の AI を選んで検査して行にする。最後の 1 つは解除できない", async () => {
    const { bridge } = await bridgeWith(["claude"]);
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    const cards = [...container.querySelectorAll<HTMLElement>(".card")];
    // 先頭は「あなたについて」、その次が接続設定
    expect(cards[0]!.querySelector("h2")?.textContent).toBe("あなたについて");
    expect(cards[1]!.querySelector("h2")?.textContent).toBe("接続設定");
    expect(cards[1]!.querySelectorAll(".prow b").length).toBe(2);
    expect(row(container, "Claude Code")).toBeTruthy();
    expect(row(container, "Codex CLI")).toBeUndefined();
    expect(container.textContent).not.toMatch(/GPT|Gemini|Codex|Antigravity/);

    // 追加のダイアログ: 未登録の AI だけ（Claude は出ない）。選ぶまで追加は押せない
    await click(button(container, "＋ 追加"));
    const dialog = container.querySelector<HTMLElement>(".add-ai")!;
    // 開くと最初の候補へフォーカスし、Tab はダイアログの中で回る（最後の操作から最初の候補へ戻る）
    expect(document.activeElement).toBe(dialog.querySelectorAll(".vcard")[0]);
    button(dialog, "キャンセル").focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(dialog.querySelectorAll(".vcard")[0]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(button(dialog, "キャンセル"));
    expect([...dialog.querySelectorAll(".vcard")].map((card) => card.textContent)).toEqual([
      "GPTCodex CLI でログイン",
      "GeminiAntigravity CLI でログイン",
    ]);
    expect(button(dialog, "追加").disabled).toBe(true);
    await click(dialog.querySelectorAll(".vcard")[0]!);
    await click(button(dialog, "追加"));
    expect(container.querySelector(".add-ai")).toBeNull();
    expect(bridge.statusCalls).toContain("CodexCli");
    expect(activeProviders(savedSettings(bridge))).toEqual(["claude", "gpt"]);
    expect(row(container, "Codex CLI")?.textContent).toContain("codex-cli 0.154.0 · ログイン済み（ChatGPT）");
    // モデルの表に列が増え、GPT の選択肢はログイン後の一覧
    expect([...container.querySelectorAll(".pr.hd span")].map((cell) => cell.textContent).filter(Boolean)).toEqual(["Claude", "GPT"]);
    const gptModel = container.querySelector<HTMLSelectElement>('[aria-label="標準・GPTのモデル"]')!;
    expect([...gptModel.options].map((option) => option.value)).toEqual(["gpt-5.6-terra", "gpt-5.6-luna"]);

    // 解除は確かめてから
    await openMenu(container, "Codex CLI");
    await click(button(row(container, "Codex CLI")!, "解除"));
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe("Codex CLI の登録を解除しますか");
    await click(button(container.querySelector<HTMLElement>('[role="dialog"]')!, "解除する"));
    expect(activeProviders(savedSettings(bridge))).toEqual(["claude"]);
    expect(row(container, "Codex CLI")).toBeUndefined();

    // 最後の 1 つは解除できない（理由を出す）
    await openMenu(container, "Claude Code");
    const remove = button(row(container, "Claude Code")!, "解除");
    expect(remove.disabled).toBe(true);
    expect(row(container, "Claude Code")?.textContent).toContain("最後の 1 つは解除できません");
  });

  it("Codex CLI は未ログインならアプリ用のログインを出し、Antigravity CLI はターミナルでの導入・ログインの案内と確認を出す", async () => {
    const { bridge } = await bridgeWith(["claude", "gpt", "gemini"]);
    bridge.statuses.CodexCli = fakeStatus("CodexCli", { authenticated: false, login_method: null, reason: "auth_required", models: [] });
    bridge.statuses.GeminiCli = fakeStatus("GeminiCli", { installed: false, authenticated: false, version: null, reason: "cli_not_found", models: [] });
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    const codex = () => row(container, "Codex CLI")!;
    expect(codex().textContent).toContain("codex-cli 0.154.0 · 未ログイン");
    expect(codex().textContent).toContain("ターミナルの codex でログイン済みでも、ここで一度ログインしてください。");
    // ログインできないうちは GPT のモデルは控えの一覧
    expect([...container.querySelector<HTMLSelectElement>('[aria-label="標準・GPTのモデル"]')!.options].map((option) => option.value)).toEqual([
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    await click(button(codex(), "ログイン"));
    expect(bridge.maintenance).toEqual(["auth:CodexCli"]);
    expect(codex().textContent).toContain("ログイン済み（ChatGPT）");
    expect(codex().textContent).toContain("Codex CLI にログインしました。");

    const agy = () => row(container, "Antigravity CLI")!;
    expect(agy().textContent).toContain("未導入");
    expect(agy().querySelector("code")?.textContent).toBe("brew install --cask antigravity-cli");
    await click(button(agy(), "コピー"));
    expect(bridge.copied).toEqual(["brew install --cask antigravity-cli"]);
    // 入れたが未ログイン → ターミナルで agy を起動してログインしてから確認
    bridge.statuses.GeminiCli = fakeStatus("GeminiCli", { authenticated: false, reason: "auth_required", models: [] });
    await click(button(agy(), "確認"));
    expect(agy().textContent).toContain("1.3.5 · 未ログイン");
    expect(agy().textContent).toContain("ターミナルで agy を起動して Google のアカウントでログインしてから、「確認」を押してください。");
    expect(buttons(agy()).some((item) => item.textContent === "ログイン")).toBe(false);
    const geminiUsage = () => [...container.querySelectorAll(".urow")].find((item) => item.querySelector("b")?.textContent === "Gemini");
    expect(geminiUsage()?.textContent).toContain("週の残り 取得できません");
    bridge.statuses.GeminiCli = fakeStatus("GeminiCli");
    bridge.usage.GeminiCli = {
      windows: [{ group: "Gemini Models", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.59, reset_time: null }],
    };
    await click(button(agy(), "確認"));
    expect(agy().textContent).toContain("1.3.5 · ログイン済み");
    // ログインした後の「確認」で、未ログインのときに取れなかった週の残りを取り直す
    expect(geminiUsage()?.textContent).toContain("週の残り 59%");
    // Gemini の列は agy の一覧の Gemini だけ（他社のモデルを出さない）
    const geminiModel = container.querySelector<HTMLSelectElement>('[aria-label="標準・Geminiのモデル"]')!;
    expect([...geminiModel.options].map((option) => option.textContent)).toEqual([
      "Gemini 3.8 Flash",
      "Gemini 3.8 Flash (High)",
      "Gemini 3.8 Flash (Medium)",
      "Gemini 3.8 Flash (Low)",
    ]);
  });
});

describe("設定: モデル（プロファイル × 登録した AI）", () => {
  it("無い組み合わせは選べない（思考量を disabled にして理由を出す）。モデルを変えると思考量を合わせる", async () => {
    const { bridge } = await bridgeWith(["claude", "gemini"]);
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    const effort = () => container.querySelector<HTMLSelectElement>('[aria-label="高性能・Geminiの思考量"]')!;
    const max = [...effort().options].find((option) => option.value === "max")!;
    expect(max.disabled).toBe(true);
    expect(max.textContent).toBe("最大（このモデルには「最大」がありません）");
    await selectOption(container.querySelector('[aria-label="高性能・Geminiのモデル"]')!, "gemini-3.8-flash-low");
    expect(activeProfiles(savedSettings(bridge))[1]?.models.gemini).toEqual({ model: "gemini-3.8-flash-low", effort: "low" });
    expect([...effort().options].filter((option) => !option.disabled).map((option) => option.value)).toEqual(["low"]);
    expect([...effort().options].find((option) => option.value === "high")?.textContent).toBe("高（思考量はモデル名で決まります）");
    // Claude は 4 段階どれも選べる
    expect([...container.querySelector<HTMLSelectElement>('[aria-label="標準・Claudeの思考量"]')!.options].every((option) => !option.disabled)).toBe(true);
  });

  it("プロファイルを足して名前を変え、削除できる（標準・高性能・軽量は削除できない）", async () => {
    const { bridge } = await bridgeWith(["claude"]);
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    const modelCard = [...container.querySelectorAll<HTMLElement>(".card")].find((card) => card.querySelector("h2")?.textContent === "モデル")!;
    await click(button(modelCard, "＋ 追加"));
    const input = modelCard.querySelector<HTMLInputElement>('input[aria-label="プロファイルの名前"]')!;
    expect(input.value).toBe("プロファイル 4");
    await typeInto(input, "高性能");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(modelCard.textContent).toContain("同じ名前のプロファイルがあります。");
    await typeInto(input, "下書き用");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(activeProfiles(savedSettings(bridge)).map((profile) => profile.name)).toEqual(["標準", "高性能", "軽量", "下書き用"]);
    expect(activeProfiles(savedSettings(bridge))[3]?.models.claude).toEqual({ model: "claude-sonnet-4-6", effort: "high" });

    await openMenu(modelCard, "標準");
    expect(button(modelCard, "削除").disabled).toBe(true);
    expect(modelCard.textContent).toContain("標準・高性能・軽量は削除できません");
    await openMenu(modelCard, "軽量");
    expect(button(modelCard, "削除").disabled).toBe(true);
    await openMenu(modelCard, "下書き用");
    await click(button(modelCard.querySelectorAll<HTMLElement>(".pr")[4]!, "削除"));
    await click(button(container.querySelector<HTMLElement>('[role="dialog"]')!, "削除する"));
    expect(activeProfiles(savedSettings(bridge)).map((profile) => profile.name)).toEqual(["標準", "高性能", "軽量"]);
  });
});

describe("文字起こしの既定のエンジン", () => {
  it("Gemini → この Mac の順で登録した分だけ。Gemini を登録すると既定が Gemini になり、外すと この Mac に戻る", async () => {
    const { bridge } = await bridgeWith(["claude"]);
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    const seg = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="既定のエンジン"] button')];
    expect(seg().map((item) => [item.textContent, item.getAttribute("aria-pressed")])).toEqual([["この Mac", "true"]]);
    await click(button(container, "＋ 追加"));
    await click([...container.querySelectorAll(".add-ai .vcard")].find((card) => card.textContent?.startsWith("Gemini"))!);
    await click(button(container.querySelector<HTMLElement>(".add-ai")!, "追加"));
    expect(seg().map((item) => [item.textContent, item.getAttribute("aria-pressed")])).toEqual([
      ["Gemini", "true"],
      ["この Mac", "false"],
    ]);
    await click(button(container, "工程設計"));
    expect(container.querySelector(".scard.fixed")?.textContent).toContain("Gemini · 日本語");
    await click(button(container, "設定"));
    await openMenu(container, "Antigravity CLI");
    await click(button(row(container, "Antigravity CLI")!, "解除"));
    await click(button(container.querySelector<HTMLElement>('[role="dialog"]')!, "解除する"));
    expect(seg().map((item) => [item.textContent, item.getAttribute("aria-pressed")])).toEqual([["この Mac", "true"]]);
  });

  it("使用量: AI の行は工程と会話だけ、文字起こしは（Gemini でも）文字起こしの行だけに数える。Antigravity CLI の週の残り（返らなければ「取得できません」）", async () => {
    const { bridge, stored } = await bridgeWith(["claude", "gemini"]);
    const at = new Date().toISOString();
    stored.runs.push(
      { id: "r1", kind: "run", at, stepId: "x", stepName: "x", version: 1, result: "saved", provider: "gemini", model: "gemini-3.8-flash", modelUsed: "gemini-3.8-flash", inputTokens: 1000, outputTokens: 100, tokensKnown: true, durationMs: 60_000 },
      { id: "r2", kind: "run", at, stepId: SOURCE_STEP_ID, stepName: "文字起こし", version: 1, result: "saved", provider: "gemini", model: "gemini-3.8-flash", inputTokens: 48_000, outputTokens: 4000, tokensKnown: true, durationMs: 90_000, audioSec: 900 },
    );
    bridge.usage.GeminiCli = {
      windows: [
        { group: "Claude and GPT Models", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.9, reset_time: null },
        { group: "Gemini Models", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.59, reset_time: "2026-10-21T19:12:26Z" },
      ],
    };
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    const usageRow = (name: string) => [...container.querySelectorAll(".urow")].find((item) => item.querySelector("b")?.textContent === name);
    // Gemini の工程 1 回＋Gemini の文字起こし 1 回 → Gemini の行は 1 回、文字起こしの行は 1 回（二重に数えない）
    expect(usageRow("Gemini")?.querySelectorAll(".num")[0]?.textContent).toBe("1 回");
    expect(usageRow("Gemini")?.querySelectorAll(".num")[1]?.textContent).toBe("1k / 100");
    expect(usageRow("Gemini")?.querySelectorAll(".num")[2]?.textContent).toBe("1 分 0 秒");
    expect(usageRow("Gemini")?.textContent).toContain("Gemini 3.8 Flash");
    expect(usageRow("Gemini")?.textContent).toContain("週の残り 59%");
    expect(usageRow("Claude")?.textContent).toContain("0 回");
    expect(usageRow("文字起こし")?.querySelectorAll(".num")[0]?.textContent).toBe("1 回");
    expect(usageRow("文字起こし")?.querySelectorAll(".num")[1]?.textContent).toBe("15 分 0 秒");
    expect(usageRow("文字起こし")?.textContent).toContain("Gemini 3.8 Flash");
    // agy の Claude・GPT の群は出さない
    expect(usageRow("Gemini")?.textContent).not.toContain("90%");
    screen.unmount();
    delete bridge.usage.GeminiCli;
    screen = await renderApp(bridge);
    await click(button(screen.container, "設定"));
    expect([...screen.container.querySelectorAll(".urow")].find((item) => item.querySelector("b")?.textContent === "Gemini")?.textContent).toContain(
      "週の残り 取得できません",
    );
  });
});

describe("AI を 1 つだけ登録した状態", () => {
  it("GPT だけなら、初回・レール・案件情報・工程設計・設定・AIと作る に他社の名前・行・選択肢が出ない（Codex の会話は動く）", async () => {
    const bridge = new FakeBridge();
    bridge.settings = settingsWithProviders(["gpt"]);
    screen = await renderApp(bridge);
    const { container } = screen;
    // 初回（普段の画面）と新しいフォルダ
    expect(container.textContent).not.toMatch(NOT_GPT);
    await createProjectByName(container, "朝市");
    // 工程設計で最初の工程を選んでから録音を作る
    await click(button(container, "工程設計"));
    expect(container.querySelector("h1")?.textContent).toBe("工程を選ぶ");
    expect(container.textContent).not.toMatch(NOT_GPT);
    await click([...container.querySelectorAll(".tcard")][2]!);
    await click(button(container, "続ける"));
    await click(railItem(container, "朝市"));
    await addPage(container, "音声");
    expect(container.textContent).not.toMatch(NOT_GPT);
    await seedText(bridge, container, "朝市に出して三年目です。");
    const stored = bridge.byName("朝市");
    expect(Object.values(firstRecording(bridge, stored).recording.flowSnapshot.models).every((model) => model.provider === "gpt")).toBe(true);
    // 工程の実行（▶ の行・履歴）
    bridge.turnScript = () => [gptDone("見えてきたこと")];
    await click(button(container, "続きを作成"));
    expect(bridge.turnRequests[0]).toMatchObject({ provider: "CodexCli", model: "gpt-5.6-terra", effort: "Max" });
    await openRunConversation(container, "インサイト");
    expect(container.querySelector(".step-msg small")?.textContent).toMatch(/^GPT-5\.6-Terra · 最大 · 約/);
    expect(container.textContent).not.toMatch(NOT_GPT);
    await click(railItem(container, "インサイト"));
    await click(container.querySelector('button[aria-label="履歴"]')!);
    expect(container.querySelector(".pop.hist")?.textContent).toContain("GPT 高性能 · gpt-5.6-terra · 最大");
    expect(container.textContent).not.toMatch(NOT_GPT);
    // AIと作る（Codex の会話は今のまま動く）
    bridge.chatScript = (_request, _call, project) => {
      const stepId = Object.keys(project.artifacts)[0]!;
      project.artifacts[stepId] = "短くした\n";
      return [{ type: "ToolUse", id: "t1", name: "Edit", summary: `${stepId}.md` }, { type: "ToolResult", id: "t1", name: "Edit", ok: true }, gptDone("直しました。")];
    };
    const composer = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="直したいこと"]')!;
    expect(composer.disabled).toBe(false);
    await typeInto(composer, "短くして");
    await click(container.querySelector('button[aria-label="送信"]')!);
    await until(() => container.querySelector(".bubble.ai") !== null);
    expect(bridge.chatRequests[0]?.request).toMatchObject({ provider: "CodexCli", model: "gpt-5.6-terra" });
    expect(container.textContent).not.toMatch(NOT_GPT);
    // 案件情報
    // 背景情報のページ（#18914。ダイアログではない）
    await click(button(container, "背景情報"));
    expect(container.textContent).not.toMatch(NOT_GPT);
    // 工程設計（提供元の選択肢は出さない）
    await click(button(container, "工程設計"));
    expect(container.querySelector('select[aria-label$="の提供元"]')).toBeNull();
    expect(container.textContent).not.toMatch(NOT_GPT);
    // 設定
    await click(button(container, "設定"));
    expect(row(container, "Codex CLI")).toBeTruthy();
    expect(container.textContent).not.toMatch(NOT_GPT);
  });
});

describe("工程設計の提供元", () => {
  it("登録した AI が 2 つ以上のときだけ選べ、選択肢は登録した AI だけ。選んでもモデルの欄はプロファイルの名前のまま", async () => {
    const { bridge } = await bridgeWith(["claude", "gemini"]);
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "工程設計"));
    const provider = container.querySelector<HTMLSelectElement>('select[aria-label="発言の抽出の提供元"]')!;
    expect([...provider.options].map((option) => option.textContent)).toEqual(["Claude", "Gemini"]);
    await selectOption(provider, "gemini");
    const profile = container.querySelector<HTMLSelectElement>('select[aria-label="発言の抽出のモデル"]')!;
    expect(profile.selectedOptions[0]?.textContent).toBe("軽量");
    await click(button(container, "保存"));
    expect(bridge.flow?.steps[0]?.provider).toBe("gemini");
  });
});

describe("登録していない AI を指す工程", () => {
  it("工程設計の工程が登録していない AI を指すときは、先頭の AI へ寄せて 1 行知らせ、実行の行にも出す", async () => {
    const { bridge, flow } = await bridgeWith(["claude"]);
    flow.steps[0]!.provider = "gpt";
    bridge.flow = { ...flow, steps: flow.steps.map((step) => ({ ...step })) };
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "工程設計"));
    const card = container.querySelectorAll<HTMLElement>(".scard:not(.fixed)")[0]!;
    expect(card.textContent).toContain("選んでいた AI が登録されていないため、Claude で実行します");
    expect(card.textContent).not.toMatch(/GPT|Codex/);
    // 新しい録音は先頭の AI で解決する（寄せた印を持つ）
    await createProjectByName(container, "寄せる案件");
    await addPage(container, "音声");
    await seedText(bridge, container, "本文");
    const stored = bridge.byName("寄せる案件");
    const recording = firstRecording(bridge, stored);
    expect(recording.recording.flowSnapshot.models[flow.steps[0]!.id]).toMatchObject({ provider: "claude", redirected: true });
    let release!: () => void;
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.turnScript = () => [{ type: "TextDelta", text: "抽" }, done("抽出")];
    await click(button(container, "続きを作成"));
    expect(container.querySelector(".step-msg small")?.textContent).toContain("選んでいた AI が登録されていないため、Claude で実行します");
    release();
    await until(() => (recording.versions[flow.steps[0]!.id]?.length ?? 0) === 1);
    expect(bridge.turnRequests[0]?.provider).toBe("ClaudeCode");
  });

  it("既存の録音が登録を外した AI に解決済みなら、別の AI で実行せず理由を出し、「この録音の工程を今の設計に更新」で直せる", async () => {
    const { bridge, flow, stored } = await bridgeWith(["claude"], ["gpt"]);
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(container.querySelector(".flownote")?.textContent).toContain("登録していない AI の工程があります");
    await click(button(container, "続きを作成"));
    expect(bridge.turnRequests).toHaveLength(0);
    expect(container.querySelector(".runnotice.err")?.textContent).toContain(UNREGISTERED_PROVIDER_MESSAGE);
    // 録音に固定した provider/model を保ち、登録済み Claude へ自動で切り替えて送らない。
    expect(stored.project.flowSnapshot!.models[flow.steps[0]!.id]).toMatchObject({ provider: "gpt" });
    await click(button(container, "この録音の工程を今の設計に更新"));
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector("h2")?.textContent).toBe("この録音の工程を今の設計に更新しますか");
    expect(dialog.textContent).toContain("登録した AI に切り替わる工程: 発言の抽出・インサイト・次の打ち手");
    await click(button(dialog, "更新する"));
    expect(Object.values(stored.project.flowSnapshot!.models).every((model) => model.provider === "claude")).toBe(true);
    expect(container.querySelector(".flownote")).toBeNull();
    expect(container.querySelector(".toast")?.textContent).toBe("この録音の工程を今の設計にしました");
    bridge.turnScript = () => [done("抽出")];
    await click(button(container, "続きを作成"));
    expect(bridge.turnRequests[0]?.provider).toBe("ClaudeCode");
    expect(stored.versions[flow.steps[0]!.id]).toHaveLength(1);
  });
});

describe("AIと作る: Gemini", () => {
  it("会話は登録した AI の先頭で送る。Gemini が先頭なら Antigravity CLI で、資料パックは最初の依頼にだけ付ける", async () => {
    const { bridge, flow, stored } = await bridgeWith(["gemini", "claude"], ["claude"]);
    const stepId = flow.steps[0]!.id;
    bridge.turnScript = () => [done("抽出した発言")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "続きを作成"));
    await click(railItem(container, "発言の抽出"));
    expect(container.querySelector(".composer-note")).toBeNull();
    bridge.chatScript = (_request, _call, project) => {
      project.artifacts[stepId] = "短くした\n";
      return [{ type: "ToolUse", id: "t1", name: "Edit", summary: `${stepId}.md` }, { type: "ToolResult", id: "t1", name: "Edit", ok: true }, done("直しました。", "EndTurn", "s-gem-1")];
    };
    const composer = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="直したいこと"]')!;
    expect(composer.disabled).toBe(false);
    await typeInto(composer, "短くして");
    await click(container.querySelector('button[aria-label="送信"]')!);
    await until(() => (stored.versions[stepId]?.length ?? 0) === 2);
    expect(bridge.chatRequests[0]?.request).toMatchObject({ provider: "GeminiCli", model: "gemini-3.8-flash", resume_session: null });
    expect(bridge.chatRequests[0]!.request.user_prompt.startsWith("<<資料パック")).toBe(true);
    expect(stored.runs.find((run) => run.kind === "agent" && run.turnRecord)).toMatchObject({ provider: "gemini", connection: "subscription" });
    // 2 回目は同じ会話を続け、資料パックを付けない
    bridge.chatScript = () => [done("確かめました。", "EndTurn", "s-gem-1")];
    await typeInto(composer, "表記を確かめて");
    await click(container.querySelector('button[aria-label="送信"]')!);
    await until(() => bridge.chatRequests.length === 2 && !container.querySelector('button[aria-label="停止"]'));
    expect(bridge.chatRequests[1]!.request).toMatchObject({ provider: "GeminiCli", resume_session: "s-gem-1" });
    expect(bridge.chatRequests[1]!.request.user_prompt).toBe("表記を確かめて");
  });

  it("Gemini だけを登録しているときも会話で直せ、他社の名前を出さない", async () => {
    const { bridge } = await bridgeWith(["gemini"]);
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(container.querySelector(".composer-note")).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="直したいこと"]')!.disabled).toBe(false);
    expect(container.textContent).not.toMatch(/Claude|GPT|Codex|Sonnet|Opus/);
  });
});

describe("文字起こし: Gemini（Antigravity CLI）", () => {
  it("Gemini を登録した音声の案件は、工程 1 を Gemini で区切りごとに文字起こしし、実行の行に Gemini と出す", async () => {
    const bridge = new FakeBridge();
    bridge.settings = settingsWithProviders(["claude", "gemini"]);
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    bridge.flow = flow;
    bridge.audioDurationSec = 95;
    await bridge.createProject(
      { ...textProject(flow, ["claude", "gemini"], "運営会議"), source: { kind: "audio", audio: [] } },
      null,
      null,
      ["/a/m.m4a"],
    );
    bridge.audioPartScript = (_request, call) => [done(call === 0 ? "[00:02] 話者0: 始めます。" : "[00:01] 話者1: はい。", "EndTurn", "c", "gemini-3.8-flash")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "文書作成を開始"));
    const stored = bridge.byName("運営会議");
    expect(stored.transcript).toBe("[00:00:02] 話者0: 始めます。\n\n[00:00:49] 話者1: はい。\n");
    expect(stored.runs.find((run) => run.stepId === SOURCE_STEP_ID && run.kind === "run")).toMatchObject({
      provider: "gemini",
      model: "gemini-3.8-flash",
      result: "saved",
    });
    await openRunConversation(container, "文字起こし");
    expect(container.querySelector(".step-msg small")?.textContent).toBe("Gemini · 1:35");
  });
});
