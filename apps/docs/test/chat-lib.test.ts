import { describe, expect, it } from "vitest";
import {
  EDIT_FIXED_RULES,
  FLOW_TEMPLATES,
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  type About,
  type Project,
} from "@niho/docs-core";
import {
  CHAT_NO_MODEL_MESSAGE,
  TurnRecorder,
  chatModel,
  chatUnavailableReason,
  conversationEntries,
  draftKeyOf,
  newConversation,
  runChatTurn,
  saveProjectDrafts,
  type LiveChat,
} from "../src/lib/chat";
import { defaultSettings, type AppSettings } from "../src/lib/settings";
import { FakeBridge, apiKeySettings, done, recordingView, rootRef, settingsWithProviders } from "./fake-bridge";

/** 修正の会話の中核（runChatTurn）を、偽の Bridge で確かめる（画面なし）。 */

const flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-1");
const [FIX, POLICY, BODY] = flow.steps.map((step) => step.id) as [string, string, string];

async function setup() {
  const bridge = new FakeBridge();
  bridge.flow = flow;
  const project: Project = {
    version: 1,
    id: "",
    name: "案件",
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    info: { speakers: "2", language: "ja", terms: [], background: "" },
    source: { kind: "text" },
  };
  const created = await bridge.createProject(project, "本文の文字起こし\n", {
    id: "save-1",
    kind: "save",
    at: "2026-10-15T00:00:00.000Z",
    stepId: SOURCE_STEP_ID,
    stepName: "文章",
    version: null,
    result: "saved",
  }, []);
  const run = (stepId: string, markdown: string) =>
    bridge.saveArtifact(rootRef(created.id), stepId, false, markdown, {
      id: `run-${stepId}`,
      kind: "run",
      at: "2026-10-15T00:01:00.000Z",
      stepId,
      stepName: flow.steps.find((step) => step.id === stepId)!.name,
      version: null,
      result: "saved",
      basis: { source: "s", artifacts: {}, info: "i", guide: "g" },
    });
  await run(FIX, "# 修正した文字起こし\n");
  await run(POLICY, "# 方針\n");
  const stored = bridge.projects.get(created.id)!;
  const view = async () => recordingView(bridge, created.id);
  return { bridge, stored, id: created.id, view };
}

async function turn(
  bridge: FakeBridge,
  viewNow: Awaited<ReturnType<typeof setup>>["view"],
  settings: AppSettings = defaultSettings(),
  about?: About,
) {
  const lives: LiveChat[] = [];
  let count = 0;
  const outcome = await runChatTurn({
    bridge,
    view: await viewNow(),
    conversation: newConversation({ id: "conv-1", now: new Date("2026-10-15T02:00:00.000Z") }),
    instruction: "直して",
    settings,
    about,
    newId: (prefix) => `${prefix}-${++count}`,
    now: () => new Date("2026-10-15T02:00:00.000Z"),
    onLive: (live) => lives.push(live),
    isStopRequested: () => false,
  });
  return { outcome, lives };
}

describe("runChatTurn", () => {
  it("候補向けCodex資料は選択案と従来のflow外文書を含め、兄弟候補だけを除外する", async () => {
    const { bridge, stored, id, view } = await setup();
    await bridge.saveArtifact(rootRef(id), BODY, false, "# 最初の案\n", {
      id: "body1", kind: "run", at: "2026-10-15T00:02:00.000Z", stepId: BODY, stepName: "記事本文", version: null, result: "saved",
    });
    await bridge.saveArtifact(rootRef(id), "outside1", false, "# 旧フローの文書\n", {
      id: "outside1-run", kind: "run", at: "2026-10-15T00:03:00.000Z", stepId: "outside1", stepName: "旧工程", version: null, result: "saved",
    });
    await bridge.createCandidate(rootRef(id), BODY, {
      stepId: BODY,
      order: ["candidate1", "candidate2"],
      items: {
        candidate1: { id: "candidate1", artifactId: BODY, name: "最初の案", createdAt: "x" },
        candidate2: { id: "candidate2", artifactId: "artifact2", name: "別案", createdAt: "x" },
      },
    }, "artifact2", "# 選択した別案\n", {
      id: "duplicate2", kind: "save", at: "2026-10-15T00:04:00.000Z", stepId: BODY, stepName: "別案",
      candidateId: "candidate2", artifactId: "artifact2", version: null, result: "saved",
    });
    bridge.chatScript = () => [done("確認しました。")];
    const current = await view();
    const target = { stepId: BODY, candidateId: "candidate2", artifactId: "artifact2", name: "別案" };
    await runChatTurn({
      bridge,
      view: current,
      conversation: newConversation({ id: "candidate-conv", now: new Date("2026-10-15T02:00:00.000Z"), target }),
      target,
      writableArtifactId: "artifact2",
      instruction: "確認して",
      settings: settingsWithProviders(["gpt"]),
      newId: (prefix) => `${prefix}-candidate`,
      now: () => new Date("2026-10-15T02:00:00.000Z"),
      onLive: () => undefined,
      isStopRequested: () => false,
    });
    const prompt = bridge.chatRequests[0]!.request.user_prompt;
    expect(prompt).toContain("# 選択した別案");
    expect(prompt).toContain("# 旧フローの文書");
    expect(prompt).not.toContain("# 最初の案");
    expect(bridge.chatRequests[0]!.request.writable_artifact_id).toBe("artifact2");
    expect(stored.artifacts[BODY]).toBe("# 最初の案\n");
  });

  it("消された文書・空になった文書は最後の版に戻して知らせ、まだ無い工程の文書は版 1（前の版なし）にする", async () => {
    const { bridge, stored, view } = await setup();
    bridge.chatScript = (_request, _call, project) => {
      delete project.artifacts[FIX];
      project.artifacts[POLICY] = "  \n";
      project.artifacts[BODY] = "# 本文\n\nAI が書いた本文。\n";
      // 工程ではないファイルは版にしない
      project.artifacts.notes = "メモ";
      return [done("直しました。")];
    };
    const { outcome } = await turn(bridge, view);
    expect(stored.artifacts[FIX]).toBe("# 修正した文字起こし\n");
    expect(stored.artifacts[POLICY]).toBe("# 方針\n");
    expect(stored.versions[BODY]).toEqual(["# 本文\n\nAI が書いた本文。\n"]);
    expect(outcome.turn.versions).toEqual([
      { stepId: BODY, stepName: "記事本文", version: 1, previous: null, chars: countAll("# 本文\n\nAI が書いた本文。\n"), delta: countAll("# 本文\n\nAI が書いた本文。\n") },
    ]);
    expect(outcome.turn.notes).toEqual([
      "文字起こし修正のファイルが消されたため、最後の版（版 1）に戻しました。",
      "記事方針が空になったため、最後の版（版 1）に戻しました。",
    ]);
    expect(stored.versions.notes).toBeUndefined();
    // 書き換えた版は前の版の前提（basis）を引き継ぐ。新しい文書は前提なし
    expect(stored.runs.find((run) => run.kind === "agent" && run.stepId === BODY)?.basis).toBeUndefined();
  });

  it("書き換えた版は前の版の前提を引き継ぎ、書式だけの違いは版にしない", async () => {
    const { bridge, stored, view } = await setup();
    bridge.chatScript = (_request, _call, project) => {
      project.artifacts[FIX] = "# 修正した文字起こし\n\n";
      project.artifacts[POLICY] = "# 方針（直した）\n";
      return [done("直しました。")];
    };
    const { outcome } = await turn(bridge, view);
    expect(outcome.turn.versions.map((entry) => entry.stepId)).toEqual([POLICY]);
    expect(stored.artifacts[FIX]).toBe("# 修正した文字起こし\n");
    expect(stored.versions[FIX]).toHaveLength(1);
    const agent = stored.runs.find((run) => run.kind === "agent" && run.stepId === POLICY)!;
    expect(agent.basis).toEqual({ source: "s", artifacts: {}, info: "i", guide: "g" });
    expect(outcome.turn.versions[0]).toMatchObject({ version: 2, previous: 1 });
  });

  it("モデルが設定に無ければ送らずに失敗にする", async () => {
    const { bridge, view } = await setup();
    const settings = settingsWithProviders([]);
    const { outcome } = await turn(bridge, view, settings);
    expect(outcome.turn).toMatchObject({ result: "failed", message: CHAT_NO_MODEL_MESSAGE });
    expect(bridge.chatRequests).toHaveLength(0);
  });

  it("会話前の source draft 保存は直前の版の話者名 metadata を継承する", async () => {
    const { bridge, stored, view } = await setup();
    stored.runs[0]!.transcriptSpeakerNames = { "1": "田中" };
    const current = await view();
    await saveProjectDrafts({
      bridge,
      view: current,
      drafts: { [`${current.key}::${SOURCE_STEP_ID}`]: { markdown: "田中: 直した本文\n" } },
      newId: () => "save-draft",
      now: () => new Date("2026-10-15T01:00:00.000Z"),
    });
    expect(stored.runs.filter((run) => run.stepId === SOURCE_STEP_ID).at(-1)).toMatchObject({
      kind: "save",
      stepId: SOURCE_STEP_ID,
      auto: true,
      transcriptSpeakerNames: { "1": "田中" },
    });
  });

  it("直前に自動で版にした本文（versioned）は、送る前の保存で同じ版を重ねない（#18912）", async () => {
    const { bridge, stored, view } = await setup();
    const current = await view();
    const key = `${current.key}::${SOURCE_STEP_ID}`;
    const before = stored.runs.length;
    const saved = await saveProjectDrafts({
      bridge,
      view: current,
      drafts: { [key]: { markdown: "田中: 版にした本文\n" } },
      newId: () => "save-draft",
      now: () => new Date("2026-10-15T01:00:00.000Z"),
      versioned: (draftKey, markdown) => draftKey === key && markdown === "田中: 版にした本文\n",
    });
    expect(saved).toEqual([key]);
    expect(stored.runs).toHaveLength(before);
  });

  it("版を作れなくても、書きかけが直前の自動保存で本文に入っていれば送る前の保存で止めない。本文にも入っていなければ止める（#18912）", async () => {
    const { bridge, stored, view } = await setup();
    const current = await view();
    const key = `${current.key}::${FIX}`;
    const input = { bridge, view: current, newId: () => "save-draft", now: () => new Date("2026-10-15T01:00:00.000Z") };
    bridge.saveArtifact = async () => { throw new Error("保存先に書けませんでした"); };
    // 直前の自動保存で本文に入った書きかけ（版だけ作れなかった）
    stored.artifacts[FIX] = "# 自動保存した直し\n";
    await expect(saveProjectDrafts({ ...input, drafts: { [key]: { markdown: "# 自動保存した直し\n" } } })).resolves.toEqual([key]);
    // 本文にも入っていない書きかけは、AI が古い本文を読まないように止める
    await expect(saveProjectDrafts({ ...input, drafts: { [key]: { markdown: "# まだ書けていない直し\n" } } })).rejects.toThrow("保存先に書けませんでした");
    // 工程 1（transcript.md）は本文を確かめられないので止める
    const source = `${current.key}::${SOURCE_STEP_ID}`;
    await expect(saveProjectDrafts({ ...input, drafts: { [source]: { markdown: "本文の文字起こし（直した）\n" } } })).rejects.toThrow("保存先に書けませんでした");
  });
});

describe("候補の草稿保存", () => {
  it("選択した候補の直近版を保存の前提に使う", async () => {
    const { bridge, stored, id, view } = await setup();
    const basisA = { source: "source-a", artifacts: { [FIX]: "1" }, info: "info-a", guide: "guide-a" };
    const basisB = { source: "source-b", artifacts: { [FIX]: "2" }, info: "info-b", guide: "guide-b" };
    await bridge.saveArtifact(rootRef(id), BODY, false, "# 最初の案\n", {
      id: "candidate1-run", kind: "run", at: "2026-10-15T00:02:00.000Z", stepId: BODY, stepName: "記事本文",
      version: null, result: "saved", basis: basisA,
    });
    await bridge.createCandidate(rootRef(id), BODY, {
      stepId: BODY,
      order: ["candidate1", "candidate2"],
      items: {
        candidate1: { id: "candidate1", artifactId: BODY, name: "最初の案", createdAt: "x" },
        candidate2: { id: "candidate2", artifactId: "artifact2", name: "別案", createdAt: "x" },
      },
    }, "artifact2", "# 別案\n", {
      id: "candidate2-run", kind: "run", at: "2026-10-15T00:03:00.000Z", stepId: BODY, stepName: "別案",
      candidateId: "candidate2", artifactId: "artifact2", version: null, result: "saved", basis: basisB,
    });
    const current = await view();
    const key = draftKeyOf(current.key, "artifact2");
    await saveProjectDrafts({
      bridge,
      view: current,
      drafts: { [key]: { markdown: "# 編集した別案\n" } },
      newId: () => "candidate2-save",
      now: () => new Date("2026-10-15T00:04:00.000Z"),
      artifactId: "artifact2",
      target: { stepId: BODY, candidateId: "candidate2", artifactId: "artifact2", name: "別案" },
    });
    expect(stored.runs.find((run) => run.id === "candidate2-save")).toMatchObject({
      stepId: BODY,
      candidateId: "candidate2",
      artifactId: "artifact2",
      basis: basisB,
    });
  });
});

function countAll(text: string): number {
  return Array.from(text).length;
}

describe("runChatTurn の「あなたについて」", () => {
  const about: About = { name: "佐藤", text: "ライフコーチをしています。録音では私が聞き手です。" };

  it("システム側の決まりの後・文書ガイドの前に節を入れ、「資料を読みました」には文書ガイドの前に並べる", async () => {
    const { bridge, view } = await setup();
    bridge.chatScript = () => [done("直しました。")];
    const { outcome } = await turn(bridge, view, defaultSettings(), about);
    const system = bridge.chatRequests[0]!.request.system_prompt;
    expect(system.startsWith(EDIT_FIXED_RULES)).toBe(true);
    const aboutAt = system.indexOf("## あなたについて\n\n呼び名: 佐藤\n\nライフコーチをしています。録音では私が聞き手です。");
    expect(aboutAt).toBe(EDIT_FIXED_RULES.length + 2);
    expect(system.indexOf("## 文書ガイド")).toBeGreaterThan(aboutAt);
    // 順は 資料（pack.items）→ あなたについて → 文書ガイド
    expect(outcome.turn.pack?.slice(-2)).toEqual(["あなたについて", "文書ガイド"]);
    expect(outcome.turn.pack?.filter((name) => name === "あなたについて")).toHaveLength(1);
    // 資料パック（ユーザー側）には入れない
    expect(bridge.chatRequests[0]!.request.user_prompt).not.toContain("ライフコーチ");
  });

  it("渡さない・空（空白だけ）なら、節も「資料を読みました」の名前も出さない", async () => {
    const { bridge, view } = await setup();
    bridge.chatScript = () => [done("直しました。")];
    const plain = await turn(bridge, view);
    const empty = await turn(bridge, view, defaultSettings(), { name: " ", text: "\n" });
    const [plainRequest, emptyRequest] = bridge.chatRequests.map((entry) => entry.request);
    expect(plainRequest!.system_prompt).not.toContain("## あなたについて");
    expect(emptyRequest!.system_prompt).toBe(plainRequest!.system_prompt);
    expect(plain.outcome.turn.pack).not.toContain("あなたについて");
    expect(empty.outcome.turn.pack).toEqual(plain.outcome.turn.pack);
    expect(plain.outcome.turn.pack?.at(-1)).toBe("文書ガイド");
  });

  it("呼び名だけ・本文だけでも「あなたについて」を並べる", async () => {
    const { bridge, view } = await setup();
    bridge.chatScript = () => [done("直しました。")];
    const nameOnly = await turn(bridge, view, defaultSettings(), { name: "佐藤", text: "" });
    const textOnly = await turn(bridge, view, defaultSettings(), { name: "", text: "聞き手です。" });
    expect(nameOnly.outcome.turn.pack).toContain("あなたについて");
    expect(textOnly.outcome.turn.pack).toContain("あなたについて");
    expect(bridge.chatRequests[0]!.request.system_prompt).toContain("## あなたについて\n\n呼び名: 佐藤\n\n## 文書ガイド");
    expect(bridge.chatRequests[1]!.request.system_prompt).toContain("## あなたについて\n\n聞き手です。\n\n## 文書ガイド");
  });
});

describe("会話の小道具", () => {
  it("会話のモデルは、同じ方式で続ける会話の提供元か、登録した AI の先頭 × 標準のプロファイル。モデルが無いときだけ止める", () => {
    const settings = defaultSettings();
    expect(chatUnavailableReason(settings)).toBeNull();
    expect(chatUnavailableReason(settingsWithProviders([]))).toBe(CHAT_NO_MODEL_MESSAGE);
    expect(chatModel(null, settings)).toEqual({
      provider: "claude",
      connection: "subscription",
      model: "claude-sonnet-4-6",
      effort: "high",
      profile: "標準",
    });
    const conversation = {
      ...newConversation({ id: "c", now: new Date() }),
      session: {
        provider: "claude" as const,
        connection: "subscription" as const,
        model: "opus",
        effort: "max" as const,
        profile: "高性能",
        ref: "r",
      },
    };
    expect(chatModel(conversation, settings)).toEqual({
      provider: "claude",
      connection: "subscription",
      model: "opus",
      effort: "max",
      profile: "高性能",
    });
    // 方式を変えたら、前の会話（サブスクリプションの CLI の会話）は続けず、API キー方式の標準で始める
    const apiKey = apiKeySettings(["claude"], false, settings);
    expect(chatUnavailableReason(apiKey)).toBeNull();
    // API キー方式で AI をまだ登録していなければモデルが無い
    expect(chatUnavailableReason(apiKeySettings([], false, settings))).toBe(CHAT_NO_MODEL_MESSAGE);
    expect(chatModel(conversation, apiKey)).toMatchObject({ provider: "claude", connection: "apiKey", profile: "標準" });
  });

  it("最近の会話は会話のファイルと工程の実行を新しい順に並べ、ファイルになった実行は 1 行にする", () => {
    const run = (id: string, at: string) => ({
      id,
      kind: "run" as const,
      at,
      stepId: FIX,
      stepName: "文字起こし修正",
      version: 1,
      result: "saved" as const,
    });
    const runs = [run("run-a", "2026-10-15T01:00:00.000Z"), run("run-b", "2026-10-15T03:00:00.000Z")];
    const fromRun = { ...newConversation({ id: "run-a", now: new Date("2026-10-15T04:00:00.000Z"), run: runs[0]! }) };
    const edit = { ...newConversation({ id: "conv-x", now: new Date("2026-10-15T02:00:00.000Z") }) };
    const entries = conversationEntries([fromRun, edit], [...runs, { ...run("save-1", "2026-10-15T05:00:00.000Z"), kind: "save" as const }]);
    expect(entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(["file:run-a", "run:run-b", "file:conv-x"]);
    expect(fromRun).toMatchObject({ kind: "step", runId: "run-a", stepName: "文字起こし修正", createdAt: "2026-10-15T01:00:00.000Z" });
    // 同じ時刻に続けて実行した工程は、後に記録した方を新しいとみなす
    const same = [run("run-1", "2026-10-15T06:00:00.000Z"), run("run-2", "2026-10-15T06:00:00.000Z"), run("run-3", "2026-10-15T06:00:00.000Z")];
    expect(conversationEntries([], same).map((entry) => entry.id)).toEqual(["run-3", "run-2", "run-1"]);
  });

  it("イベントを作業の要約にする（思考は秒数・ツールの前の文は実況・ツールはファイル名と成否）", () => {
    let clock = 1_000;
    const recorder = new TurnRecorder(() => clock);
    recorder.apply({ type: "ThinkingDelta", text: "考え中\n二行目" });
    expect(recorder.thinking).toBe("二行目");
    clock = 4_000;
    recorder.apply({ type: "TextDelta", text: "確かめます。" });
    recorder.apply({ type: "ToolUse", id: "t1", name: "Read", summary: "a.md" });
    recorder.apply({ type: "ToolResult", id: "t1", name: "Read", ok: false });
    recorder.apply({ type: "ToolResult", id: "t-unknown", name: "Read", ok: true });
    recorder.apply({ type: "TextDelta", text: "返答" });
    expect(recorder.items).toEqual([
      { kind: "thinking", ms: 3_000 },
      { kind: "narration", text: "確かめます。" },
      { kind: "tool", tool: "Read", file: "a.md", ok: false },
    ]);
    expect(recorder.narration).toBe("返答");
  });
});
