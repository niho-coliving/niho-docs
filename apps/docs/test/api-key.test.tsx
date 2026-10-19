// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import {
  API_KEY_INVALID_MESSAGE,
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  type ApiKeyAccount,
  type Flow,
  type Project,
  type RunRecord,
  type TurnEvent,
} from "@niho/docs-core";
import { activeProfiles, activeProviders, normalizeSettings, type AppSettings } from "../src/lib/settings";
import { button, buttons, click, renderApp, typeInto, type Screen } from "./dom";
import { FakeBridge, LEGACY_KEY_REENTER_MESSAGE, apiKeySettings, settingsWithProviders } from "./fake-bridge";
import { addPage, createProjectByName, openAudio, openChat, railItem, rebuild, seedText } from "./pages";
import { THREE_STEP_TEMPLATE } from "./three-step-flow";

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

/** 偽の鍵（本物の鍵は使わない）。 */
const GOOD_ANTHROPIC = "sk-ant-fake-GOOD-0123456789abcdefWXYZ";
const GOOD_OPENAI = "sk-fake-openai-0123456789abcdefQRST";
const GOOD_GEMINI = "AIzaFAKE-gemini-0123456789abcdefLMNO";
const GOOD_DEEPGRAM = "dgfake0123456789abcdef0123456789HIJK";
const GOOD: Record<ApiKeyAccount, string> = { anthropic: GOOD_ANTHROPIC, openai: GOOD_OPENAI, gemini: GOOD_GEMINI, deepgram: GOOD_DEEPGRAM };

/** AI provider の名前（GPT だけを登録したときに出てはいけないもの）。 */
const NOT_GPT = /Claude|Anthropic|Sonnet|Opus|Fable|Haiku|Gemini|Antigravity|agy|Google(?! ドキュメント)|Deepgram/i;

function textProject(flow: Flow, settings: AppSettings, name: string): Project {
  return {
    version: 1,
    id: "",
    name,
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, activeProfiles(settings), activeProviders(settings), settings.connection),
    info: { speakers: "2", language: "ja", terms: [{ term: "NIHO鎌倉", reading: "", variants: [], note: "" }], background: "" },
    source: { kind: "text" },
  };
}

async function bridgeWith(settings: AppSettings) {
  const bridge = new FakeBridge();
  bridge.settings = settings;
  // 正しい鍵だけを通す偽の確かめ
  bridge.keyCheck = (account, key) =>
    key === GOOD[account]
      ? { ok: true, models: account === "anthropic" ? ["claude-sonnet-4-6", "claude-opus-4-8"] : [] }
      : { ok: false, code: "api_key_invalid", message: API_KEY_INVALID_MESSAGE };
  const flow = createFlowFromTemplate(THREE_STEP_TEMPLATE, "flow-1");
  bridge.flow = flow;
  const project = await bridge.createProject(
    textProject(flow, settings, "朝市 インタビュー"),
    "[00:00:08] 朝市に出して三年目です。\n",
    { id: "save-1", kind: "save", at: "2026-10-15T00:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" },
    [],
  );
  return { bridge, flow, stored: bridge.projects.get(project.id)! };
}

function row(container: HTMLElement, name: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>(".prow")].find((item) => item.querySelector("b")?.textContent === name);
}

function modeButton(container: HTMLElement, label: "サブスクリプション" | "API キー"): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>('[aria-label="接続の方式"] button')].find((item) => item.textContent === label)!;
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(condition()).toBe(true);
}

/** 会話の欄で、工程の実行の会話を開く（録音のページの会話の欄は最後の実行を出すので）。 */
async function openRunConversation(container: HTMLElement, stepName: string) {
  // 「AIと作る」は閉じて始まる（owner 2026-10-18・#18941）
  await openChat(container);
  await click(container.querySelector('[aria-label="会話の切り替え"]')!);
  const found = [...container.querySelectorAll<HTMLElement>(".chatmenu .crow")].find((item) => item.querySelector(".d")?.textContent === `▶ ${stepName}を実行`);
  if (!found) throw new Error(`conversation not found: ${stepName}`);
  await click(found);
}

async function saveKey(container: HTMLElement, label: string, key: string) {
  await typeInto(container.querySelector(`input[aria-label="${label}の API キー"]`)!, key);
  await click(row(container, label)!.querySelector<HTMLButtonElement>(".acts .btn")!);
}

function apiDone(text: string, model = "claude-sonnet-4-6"): TurnEvent {
  return {
    type: "Done",
    text,
    stop_reason: "EndTurn",
    session_id: "api_0123456789abcdef01234567",
    usage: { input_tokens: 200_000, output_tokens: 20_000, cost_usd: null, model_used: model, cost_known: false },
    duration_ms: 10,
    continuations: 0,
  };
}

describe("接続方式の切り替え", () => {
  it("サブスクリプション／API キーの 1 択。切り替えても案件とフローはそのまま、方式ごとの行になる。実行中は切り替えられない", async () => {
    const { bridge, flow, stored } = await bridgeWith(settingsWithProviders(["claude"]));
    const snapshot = structuredClone(stored.project.flowSnapshot);
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    expect(modeButton(container, "サブスクリプション").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain(
      "この Mac でログイン済みの AI を使います。契約の範囲・利用上限・追加クレジットは各社の契約画面で確認してください。",
    );
    // 動かない「端末間引継ぎ（準備中）」は出さない
    expect(container.textContent).not.toContain("端末間引継ぎ");
    expect(container.textContent).not.toContain("同期機能との接続待ち");
    expect(row(container, "Claude Code")).toBeTruthy();
    await click(modeButton(container, "API キー"));
    expect(normalizeSettings(bridge.settings).connection).toBe("apiKey");
    expect(container.textContent).toContain("API キーで使います。使った分だけ各社から請求されます。");
    expect(row(container, "Claude Code")).toBeUndefined();
    expect(container.textContent).toContain("「＋ 追加」で AI を選び");
    // 案件とフローは変わらない
    expect(bridge.flow).toEqual(flow);
    expect(stored.project.flowSnapshot).toEqual(snapshot);
    await click(modeButton(container, "サブスクリプション"));
    expect(row(container, "Claude Code")).toBeTruthy();
    expect(normalizeSettings(bridge.settings).connection).toBe("subscription");

    // 実行中は切り替えない（画面）
    let release: () => void = () => undefined;
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.turnScript = () => [{ type: "TextDelta", text: "途中" }, apiDone("抽出")];
    await openAudio(container);
    await click(button(container, "続きを作成"));
    await click(button(container, "設定"));
    expect(modeButton(container, "API キー").disabled).toBe(true);
    expect(container.textContent).toContain("実行が終わってから方式を切り替えられます。");
    await act(async () => release());
    await until(() => !modeButton(container, "API キー").disabled);
    expect(normalizeSettings(bridge.settings).connection).toBe("subscription");
  });
});

describe("API キーの行", () => {
  it("未設定 → 無効な鍵は保存しない → 確かめて保存（末尾 4 文字だけ）→ 確認 → 無効 → 削除", async () => {
    const { bridge } = await bridgeWith(apiKeySettings(["claude"]));
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    const anthropic = () => row(container, "Anthropic")!;
    expect(anthropic().textContent).toContain("未設定");
    expect(anthropic().querySelector('input[type="password"]')).toBeTruthy();
    // 無効な鍵
    await saveKey(container, "Anthropic", "sk-ant-wrong-000000000000000000");
    expect(anthropic().querySelector('[role="alert"]')?.textContent).toBe(API_KEY_INVALID_MESSAGE);
    expect(bridge.keychain.size).toBe(0);
    expect(anthropic().textContent).toContain("未設定");
    // 正しい鍵（確かめてから保存。末尾 4 文字だけを出し、欄は空になる）
    await saveKey(container, "Anthropic", GOOD_ANTHROPIC);
    expect(bridge.keychain.get("anthropic")).toBe(GOOD_ANTHROPIC);
    expect(anthropic().textContent).toContain("保存済み · ••••WXYZ · 確認済み");
    expect(anthropic().querySelector("input")).toBeNull();
    expect(container.innerHTML).not.toContain(GOOD_ANTHROPIC);
    expect(JSON.stringify(bridge.settings)).not.toContain(GOOD_ANTHROPIC);
    // 確認（保存済みの鍵で 1 回）
    await click(button(anthropic(), "確認"));
    expect(bridge.keyCalls.filter((call) => call === "check:anthropic")).toHaveLength(1);
    expect(anthropic().textContent).toContain("API キーは使えます。");
    // 鍵が無効になった
    bridge.keyCheck = () => ({ ok: false, code: "api_key_invalid", message: API_KEY_INVALID_MESSAGE });
    await click(button(anthropic(), "確認"));
    expect(anthropic().textContent).toContain("無効 · ••••WXYZ");
    expect(anthropic().querySelector('[role="alert"]')?.textContent).toBe(API_KEY_INVALID_MESSAGE);
    expect(anthropic().querySelector('input[type="password"]')).toBeTruthy();
    // 削除（確かめてから）
    await click(container.querySelector('button[aria-label="Anthropicのその他"]')!);
    await click(button(container, "鍵を削除"));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Anthropic の API キーを削除しますか");
    await click(button(container, "削除する"));
    expect(bridge.keychain.size).toBe(0);
    expect(anthropic().textContent).toContain("未設定");
    // 登録は残る
    expect(activeProviders(normalizeSettings(bridge.settings))).toEqual(["claude"]);
  });

  it("以前の版の鍵を移せなかったときは、未設定の行に入れ直しの案内を出す → 入れ直すと消える（#18769）", async () => {
    const { bridge } = await bridgeWith(apiKeySettings(["claude"]));
    bridge.keyReenter.add("anthropic");
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    const anthropic = () => row(container, "Anthropic")!;
    await until(() => anthropic().querySelector('[role="alert"]') !== null);
    expect(anthropic().querySelector('[role="alert"]')?.textContent).toBe(LEGACY_KEY_REENTER_MESSAGE);
    expect(anthropic().textContent).toContain("未設定");
    expect(anthropic().querySelector('input[type="password"]')).toBeTruthy();
    await saveKey(container, "Anthropic", GOOD_ANTHROPIC);
    expect(anthropic().querySelector('[role="alert"]')).toBeNull();
    expect(anthropic().textContent).toContain("確かめてからこの Mac に保存しました。");
    expect(anthropic().textContent).toContain("保存済み · ••••WXYZ · 確認済み");
  });

  it("「＋ 追加」は API キーの選択肢で、Deepgram は API キー方式だけに出る（行・文字起こしのエンジンも）", async () => {
    const { bridge } = await bridgeWith(settingsWithProviders(["claude"]));
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    await click(container.querySelectorAll<HTMLButtonElement>(".addrow")[0]!);
    expect(container.querySelector(".vgrid")?.textContent).not.toContain("Deepgram");
    expect(container.querySelector(".vgrid")?.textContent).toContain("Codex CLI でログイン");
    await click(button(container, "キャンセル"));
    await click(modeButton(container, "API キー"));
    // API キー方式でまだ AI が無い間は、列の無いモデルの表の代わりに案内を出す
    expect(container.textContent).toContain("接続設定で AI を追加すると、ここでモデルと思考量を選べます。");
    expect(container.querySelector(".pr.hd")).toBeNull();
    await click(container.querySelectorAll<HTMLButtonElement>(".addrow")[0]!);
    const cards = [...container.querySelectorAll(".vgrid .vcard")].map((card) => card.textContent);
    expect(cards).toEqual(["ClaudeAnthropic の API キー", "GPTOpenAI の API キー", "GeminiGoogle Gemini の API キー", "Deepgram文字起こし · API キー"]);
    await click([...container.querySelectorAll<HTMLButtonElement>(".vgrid .vcard")].find((card) => card.textContent?.startsWith("Deepgram"))!);
    await click(button(container.querySelector(".dlg")!, "追加"));
    expect(row(container, "Deepgram")?.textContent).toContain("文字起こしだけに使います");
    const engines = () => [...container.querySelectorAll('[aria-label="既定のエンジン"] button')].map((item) => item.textContent);
    expect(engines()).toEqual(["この Mac", "Deepgram"]);
    // Gemini を足すと Gemini → この Mac → Deepgram の順
    await click(container.querySelectorAll<HTMLButtonElement>(".addrow")[0]!);
    await click([...container.querySelectorAll<HTMLButtonElement>(".vgrid .vcard")].find((card) => card.textContent?.startsWith("Gemini"))!);
    await click(button(container.querySelector(".dlg")!, "追加"));
    expect(engines()).toEqual(["Gemini", "この Mac", "Deepgram"]);
    expect(row(container, "Google Gemini")?.textContent).toContain("未設定");
    // サブスクリプションに戻すと Deepgram はどこにも出ない
    await click(modeButton(container, "サブスクリプション"));
    expect(container.textContent).not.toContain("Deepgram");
    expect(engines()).toEqual(["この Mac"]);
  });
});

describe("使用量（API キー方式は見込み金額）", () => {
  it("方式ごとに数え、API キー方式は単価表の見込み、返らない値は推測せず「取得できません」。サブスクリプションは所要", async () => {
    const { bridge, stored } = await bridgeWith(apiKeySettings(["claude", "gpt"], true));
    const at = new Date().toISOString();
    const run = (fields: Partial<RunRecord>): RunRecord => ({
      id: `r${stored.runs.length}`,
      kind: "run",
      at,
      stepId: "x",
      stepName: "工程",
      version: 1,
      result: "saved",
      durationMs: 60_000,
      ...fields,
    });
    stored.runs.push(
      run({ provider: "claude", connection: "apiKey", model: "claude-sonnet-4-6", inputTokens: 200_000, outputTokens: 20_000, tokensKnown: true }),
      run({ provider: "gpt", connection: "apiKey", model: "gpt-unknown", inputTokens: 1000, outputTokens: 10, tokensKnown: true }),
      run({ provider: "claude", inputTokens: 5, outputTokens: 5, tokensKnown: true, durationMs: 120_000 }),
      run({ stepId: SOURCE_STEP_ID, stepName: "文字起こし", provider: "deepgram", connection: "apiKey", model: "nova-3", audioSec: 3600 }),
    );
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "設定"));
    const usage = (name: string) =>
      [...container.querySelectorAll(".urow")].find((item) => item.querySelector("b")?.textContent === name)?.textContent ?? "";
    expect(container.querySelector(".urow.hd")?.textContent).toContain("見込み");
    expect(usage("Claude")).toContain("1 回");
    expect(usage("Claude")).toContain("$0.90");
    expect(usage("GPT")).toContain("取得できません");
    expect(usage("文字起こし")).toContain("$0.26");
    await click(modeButton(container, "サブスクリプション"));
    expect(container.querySelector(".urow.hd")?.textContent).toContain("所要");
    expect(container.querySelector(".urow.hd")?.textContent).not.toContain("見込み");
    expect(usage("Claude")).toContain("1 回");
    expect(usage("Claude")).toContain("2 分");
    expect(container.textContent).not.toContain("$");
  });
});

describe("API キー方式の AIと作る と工程の実行", () => {
  it("工程の実行は API で行い、実行の行に送る量と見込み金額を添える。AIと作る も API で文書を直し、使用量に見込み金額で数える", async () => {
    const { bridge, stored } = await bridgeWith(apiKeySettings(["claude"]));
    bridge.keychain.set("anthropic", GOOD_ANTHROPIC);
    bridge.turnScript = (request) => [apiDone("抽出した発言", request.model)];
    screen = await renderApp(bridge);
    const { container } = screen;
    // 入力欄は録音のページと子ページで描き直すので、使うたびに取り直す
    const composer = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="直したいこと"]')!;
    expect(composer().disabled).toBe(false);
    expect(container.querySelector(".composer-note")).toBeNull();
    // 工程を 1 つだけ実行する（入力欄の ＋ から。録音のページの「工程を実行」は残りの工程をすべて実行する）
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="工程を実行"]')!);
    await click(button(container.querySelector<HTMLElement>(".pop.stepmenu")!, "▶ 発言の抽出を実行"));
    await until(() => stored.runs.some((run) => run.kind === "run" && run.result === "saved"));
    expect(bridge.turnRequests[0]).toMatchObject({ provider: "AnthropicApi", model: "claude-sonnet-4-6", effort: "Low" });
    expect(stored.runs.at(-1)).toMatchObject({ connection: "apiKey", result: "saved" });
    await openRunConversation(container, "発言の抽出");
    const note = container.querySelector(".step-msg small")?.textContent ?? "";
    expect(note).toMatch(/^Sonnet 4\.6 · 低 · 約/);
    expect(note).toContain("見込み $0.90");
    await click(railItem(container, "発言の抽出"));
    await click(container.querySelector('button[aria-label="履歴"]')!);
    expect(container.querySelector(".pop.hist")?.textContent).toContain("見込み $0.90");
    await click(container.querySelector('button[aria-label="履歴"]')!);

    // AIと作る: API（アプリの道具で読み書き）。資料パックは最初の依頼にだけ（完全な資料パックは Codex だけ）
    const stepId = Object.keys(stored.artifacts)[0]!;
    bridge.chatScript = (_request, _call, project) => {
      project.artifacts[stepId] = "抽出した発言（短く）\n";
      return [
        { type: "ToolUse", id: "toolu_1", name: "Read", summary: `${stepId}.md` },
        { type: "ToolResult", id: "toolu_1", name: "Read", ok: true },
        { type: "ToolUse", id: "toolu_2", name: "Edit", summary: `${stepId}.md` },
        { type: "ToolResult", id: "toolu_2", name: "Edit", ok: true },
        apiDone("短くしました。"),
      ];
    };
    await typeInto(composer(), "短くして");
    await click(container.querySelector('button[aria-label="送信"]')!);
    await until(() => (stored.versions[stepId]?.length ?? 0) === 2 && container.querySelector(".bubble.ai") !== null);
    const request = bridge.chatRequests[0]!.request;
    expect(request).toMatchObject({ provider: "AnthropicApi", model: "claude-sonnet-4-6", resume_session: null });
    expect(request.user_prompt.startsWith("<<資料パック")).toBe(true);
    expect(request.system_prompt).not.toContain("Codex");
    const agent = stored.runs.filter((run) => run.kind === "agent");
    expect(agent.every((run) => run.connection === "apiKey")).toBe(true);
    // 2 回目は同じ API の会話（履歴の id）を続ける
    bridge.chatScript = () => [apiDone("確かめました。")];
    await typeInto(composer(), "表記を確かめて");
    await click(container.querySelector('button[aria-label="送信"]')!);
    await until(() => bridge.chatRequests.length === 2 && !container.querySelector('button[aria-label="停止"]'));
    expect(bridge.chatRequests[1]!.request).toMatchObject({
      provider: "AnthropicApi",
      resume_session: "api_0123456789abcdef01234567",
      user_prompt: "表記を確かめて",
    });
    // 使用量: 工程 1 回＋会話 2 回を API キー方式の Claude に数え、見込み金額を出す
    await click(button(container, "設定"));
    const claude = [...container.querySelectorAll(".urow")].find((item) => item.querySelector("b")?.textContent === "Claude");
    expect(claude?.textContent).toContain("3 回");
    expect(claude?.textContent).toContain("$2.70");
  });

  it("GPT だけ（API キー方式）なら、初回・レール・案件情報・工程設計・設定・AIと作る に他社の名前・行・選択肢が出ない", async () => {
    const bridge = new FakeBridge();
    bridge.settings = apiKeySettings(["gpt"]);
    bridge.keychain.set("openai", GOOD_OPENAI);
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(container.textContent).not.toMatch(NOT_GPT);
    // 新しいフォルダと、工程設計で選んだ最初の工程
    await createProjectByName(container, "朝市");
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
    const page = stored.project.pages!.find((entry) => entry.kind === "rec")!;
    const recording = bridge.recording(stored.project.id, page.id);
    expect(Object.values(recording.recording.flowSnapshot.models).every((model) => model.provider === "gpt" && model.connection === "apiKey")).toBe(true);
    bridge.turnScript = () => [apiDone("見えてきたこと", "gpt-5.6-terra")];
    await click(button(container, "続きを作成"));
    expect(bridge.turnRequests[0]).toMatchObject({ provider: "OpenAiApi", model: "gpt-5.6-terra" });
    await openRunConversation(container, "インサイト");
    expect(container.querySelector(".step-msg small")?.textContent).toContain("見込み $0.64");
    expect(container.textContent).not.toMatch(NOT_GPT);
    // API キー方式の GPT も会話で直せる（入力欄を止めない）
    expect(container.querySelector(".composer-note")).toBeNull();
    // 背景情報のページ（#18914。ダイアログではない）
    await click(button(container, "背景情報"));
    expect(container.textContent).not.toMatch(NOT_GPT);
    await click(button(container, "工程設計"));
    expect(container.querySelector('select[aria-label$="の提供元"]')).toBeNull();
    expect(container.textContent).not.toMatch(NOT_GPT);
    await click(button(container, "設定"));
    expect(row(container, "OpenAI")?.textContent).toContain("保存済み");
    expect(container.textContent).not.toMatch(NOT_GPT);
    // モデルの選択肢も GPT だけ（API の控え）
    const options = [...container.querySelectorAll<HTMLOptionElement>('[aria-label="標準・GPTのモデル"] option')].map((option) => option.value);
    expect(options).toEqual(["gpt-5.6-terra", "gpt-5.6-luna"]);
  });
});

describe("鍵はこの Mac の保存先にだけ（画面が書くファイルに出ない）", () => {
  it("画面で鍵を保存し、工程・Gemini API と Deepgram の文字起こしを通しても、settings.json・project.json・runs.jsonl・checkpoint・会話・依頼に鍵が無い", async () => {
    const settings = apiKeySettings(["claude", "gemini"], true);
    const { bridge, flow } = await bridgeWith(settings);
    bridge.audioDurationSec = 95;
    await bridge.createProject(
      { ...textProject(flow, settings, "運営会議"), source: { kind: "audio", audio: [] } },
      null,
      null,
      ["/a/m.m4a"],
    );
    bridge.turnScript = (request) => [apiDone("抽出した発言", request.model)];
    bridge.audioPartScript = (_request, call) => [{ ...apiDone(call === 0 ? "[00:02] 話者0: 始めます。" : "[00:01] 話者1: はい。", "gemini-3.8-flash"), session_id: null }];
    screen = await renderApp(bridge);
    const { container } = screen;
    // 鍵を 3 つ画面から保存する
    await click(button(container, "設定"));
    await saveKey(container, "Anthropic", GOOD_ANTHROPIC);
    await saveKey(container, "Google Gemini", GOOD_GEMINI);
    await saveKey(container, "Deepgram", GOOD_DEEPGRAM);
    expect([...bridge.keychain.keys()].sort()).toEqual(["anthropic", "deepgram", "gemini"]);
    // 音声の案件: 既定のエンジンは Gemini（API）
    await openAudio(container, "運営会議");
    await click(button(container, "文書作成を開始"));
    const meeting = bridge.byName("運営会議");
    expect(meeting.transcript).toBe("[00:00:02] 話者0: 始めます。\n\n[00:00:49] 話者1: はい。\n");
    expect(bridge.audioPartRequests.every((call) => call.request.provider === "GeminiApi")).toBe(true);
    // Deepgram に切り替えてもう一度（文字起こしの子ページの ⋯ →「作り直す」）
    await click(button(container, "設定"));
    await click([...container.querySelectorAll<HTMLButtonElement>('[aria-label="既定のエンジン"] button')].find((item) => item.textContent === "Deepgram")!);
    await click(railItem(container, "文字起こし"));
    await rebuild(container);
    await until(() => meeting.runs.some((run) => run.provider === "deepgram"));
    expect(meeting.runs.at(-1)).toMatchObject({ provider: "deepgram", connection: "apiKey", result: "saved" });
    // 文章の案件: 工程（Anthropic API）
    await openAudio(container, "朝市 インタビュー");
    await click(button(container, "続きを作成"));
    expect(bridge.turnRequests.at(-1)?.provider).toBe("AnthropicApi");
    // 画面が書いたもの・Rust へ渡した依頼のどこにも鍵が無い
    const written = JSON.stringify({
      settings: bridge.settings,
      projects: [...bridge.projects.values()],
      conversations: [...bridge.conversationFiles.values()].map((files) => [...files.values()]),
      turns: bridge.turnRequests,
      parts: bridge.audioPartRequests,
      deepgram: bridge.deepgramRequests,
      dom: container.innerHTML,
    });
    for (const key of [GOOD_ANTHROPIC, GOOD_GEMINI, GOOD_DEEPGRAM]) {
      expect(written).not.toContain(key);
      expect(written).not.toContain(key.slice(4, -4));
    }
    expect(buttons(container).length).toBeGreaterThan(0);
  });
});
