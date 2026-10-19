// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  type Flow,
  type Project,
} from "@niho/docs-core";
import { candidateChoiceReason, runGate } from "../src/lib/run-gate";
import { CHAT_BUSY_RUN_REASON } from "../src/lib/run-state";
import { button, click, renderApp, typeInto, type Screen } from "./dom";
import { FakeBridge, done, fakeStatus, settingsWithProviders } from "./fake-bridge";
import { openAudio, railItem, rebuild, rebuildItem, seedRun, until } from "./pages";
import { THREE_STEP_TEMPLATE } from "./three-step-flow";

/** 実行の整合（#18789）: 成果物のページから止める・押せない理由・依頼中の編集ロックの範囲。 */

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

function textProject(flow: Flow, name = "朝市 インタビュー"): Project {
  return {
    version: 1,
    id: "",
    name,
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    info: { speakers: "2", language: "ja", terms: [], background: "" },
    source: { kind: "text" },
  };
}

const SAVE = { id: "save-1", kind: "save", at: "2026-10-15T00:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" } as const;

/** 文章から作った案件で、工程 2（発言の抽出）を実行して版 1 にした状態。 */
async function projectWithFirstStep() {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(THREE_STEP_TEMPLATE, "flow-1");
  bridge.flow = flow;
  const created = await bridge.createProject(textProject(flow), "[00:00:08] 朝市に出して三年目です。\n", SAVE, []);
  await seedRun(bridge, created.id, flow.steps[0]!, "# 抽出 1\n");
  return { bridge, flow, created };
}

/** 実行を始めたところで止めておく（turnGate を放すまで終わらない）。 */
function holdTurn(bridge: FakeBridge) {
  let release!: () => void;
  let started!: () => void;
  const waitStarted = new Promise<void>((resolve) => (started = resolve));
  bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
  bridge.onTurnStarted = () => started();
  bridge.turnScript = () => [{ type: "TextDelta", text: "途中" }, done("# 抽出 2\n")];
  return { release: () => release(), waitStarted };
}

describe("成果物のページから実行を止める", () => {
  it("この工程が動いている間は、本文の上の進みの行に「止める」を出す", async () => {
    const { bridge, flow } = await projectWithFirstStep();
    const gate = holdTurn(bridge);
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, flow.steps[0]!.name));
    await rebuild(container);
    await gate.waitStarted;
    const line = container.querySelector<HTMLElement>(".progress-line")!;
    expect(line.textContent).toContain(`${flow.steps[0]!.name}を作成中`);
    await click(button(line, "止める"));
    // 停止は AbortController から Native operation を cancel する（旧 turn stop API へは並走しない）
    await until(() => bridge.personalCalls.some((call) => call.name === "personalCancel"));
    gate.release();
    await until(() => container.querySelector(".progress-line") === null);
  });

  it("同じ録音の別の工程が動いているときは、実行の帯に「〈工程〉を実行中」と「止める」を出し、作り直すは押せない", async () => {
    const { bridge, flow } = await projectWithFirstStep();
    const gate = holdTurn(bridge);
    screen = await renderApp(bridge);
    const { container } = screen;
    await openAudio(container);
    await click(button(container, "続きを作成"));
    await gate.waitStarted;
    // 実行しているのは次の工程（インサイト）。完了している工程のページへ移っても、録音のページへ戻らずに止められる
    await click(railItem(container, flow.steps[0]!.name));
    const band = container.querySelector<HTMLElement>(".runbar")!;
    expect(band.querySelector(".note")?.textContent).toBe(`${flow.steps[1]!.name}を実行中`);
    expect((await rebuildItem(container)).disabled).toBe(true);
    await click(button(band, "止める"));
    // 停止は AbortController から Native operation を cancel する（旧 turn stop API へは並走しない）
    await until(() => bridge.personalCalls.some((call) => call.name === "personalCancel"));
    gate.release();
    await until(() => container.querySelector(".runbar .note .spin") === null);
  });
});

describe("成果物のページで実行を押せない理由", () => {
  it("工程の AI が未ログインなら、帯に理由と「設定を開く」を出して作り直すを押せなくする", async () => {
    const { bridge, flow } = await projectWithFirstStep();
    bridge.claude = fakeStatus("ClaudeCode", { authenticated: false, login_method: null, reason: "auth_required" });
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, flow.steps[0]!.name));
    await until(() => container.querySelector(".runbar .note.setup") !== null);
    expect(container.querySelector(".runbar .note")?.firstChild?.textContent).toBe("Claude Code にログインすると実行できます");
    expect((await rebuildItem(container)).disabled).toBe(true);
    await click(button(container.querySelector<HTMLElement>(".runbar")!, "設定を開く"));
    expect(container.querySelector("h1")?.textContent).toBe("設定");
  });

  it("完了済みの成果物だけ未ログインの AI で、残りの工程が使える AI でも、窓へ戻ったときに準備を確かめ直して作り直すを押せるようにする", async () => {
    const bridge = new FakeBridge();
    const base = createFlowFromTemplate(THREE_STEP_TEMPLATE, "flow-1");
    const flow: Flow = { ...base, steps: base.steps.map((step, index) => ({ ...step, provider: index === 0 ? "claude" : "gpt" })) };
    bridge.flow = flow;
    bridge.settings = settingsWithProviders(["claude", "gpt"]);
    const created = await bridge.createProject(
      { ...textProject(flow), flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude", "gpt"]) },
      "[00:00:08] 朝市に出して三年目です。\n",
      SAVE,
      [],
    );
    await seedRun(bridge, created.id, flow.steps[0]!, "# 抽出 1\n");
    // 完了済みの工程（Claude）だけ未ログイン。残りの工程（GPT）は使える
    bridge.claude = fakeStatus("ClaudeCode", { authenticated: false, login_method: null, reason: "auth_required" });
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, flow.steps[0]!.name));
    await until(() => container.querySelector(".runbar .note.setup") !== null);
    expect(container.querySelector(".runbar .note")?.firstChild?.textContent).toBe("Claude Code にログインすると実行できます");
    expect((await rebuildItem(container)).disabled).toBe(true);
    // 外部（ターミナル）でログインして窓へ戻る
    bridge.claude = fakeStatus("ClaudeCode");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await until(() => container.querySelector(".runbar .note.setup") === null);
    expect((await rebuildItem(container)).disabled).toBe(false);
  });

  it("「AIと作る」の依頼が動いている間は、録音のページと同じ文の理由を出す", async () => {
    const { bridge, flow } = await projectWithFirstStep();
    bridge.chatGate = new Promise<void>(() => undefined);
    bridge.chatScript = () => [done("確かめました。")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, flow.steps[0]!.name));
    await typeInto(container.querySelector('textarea[aria-label="直したいこと"]')!, "見出しを短くして");
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="送信"]')!);
    await until(() => container.querySelector(".runbar .note")?.textContent === CHAT_BUSY_RUN_REASON);
    expect((await rebuildItem(container)).disabled).toBe(true);
  });
});

describe("「AIと作る」の依頼中の文書ページの編集", () => {
  async function twoFolders() {
    const { bridge, flow, created } = await projectWithFirstStep();
    const memo = await bridge.createPage(created.id, { kind: "doc", title: "事前メモ", createdAt: "2026-10-16T00:00:00.000Z" });
    await bridge.writePage(created.id, memo.id, "# 事前メモ\n");
    const other = await bridge.createProject(
      { version: 1, id: "", name: "港の座談会", createdAt: "2026-10-16T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] },
      null,
      null,
      [],
    );
    const otherDoc = await bridge.createPage(other.id, { kind: "doc", title: "別のメモ", createdAt: "2026-10-16T00:00:00.000Z" });
    await bridge.writePage(other.id, otherDoc.id, "# 別のメモ\n");
    return { bridge, flow };
  }
  const editable = (container: HTMLElement) =>
    (container.querySelector(".pbody .ProseMirror") as HTMLElement | null)?.getAttribute("contenteditable");

  it("依頼が触るフォルダの文書ページだけ編集を止め、ほかのフォルダの文書ページは編集できる", async () => {
    const { bridge, flow } = await twoFolders();
    bridge.chatGate = new Promise<void>(() => undefined);
    bridge.chatScript = () => [done("確かめました。")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, flow.steps[0]!.name));
    await typeInto(container.querySelector('textarea[aria-label="直したいこと"]')!, "見出しを短くして");
    await click(container.querySelector<HTMLButtonElement>('button[aria-label="送信"]')!);
    await until(() => container.querySelector('button[aria-label="停止"].send') !== null);

    // 依頼を出したフォルダの文書ページ（依頼が読み書きする）は編集できない
    await click(railItem(container, "事前メモ"));
    await until(() => editable(container) !== undefined);
    expect(editable(container)).toBe("false");

    // ほかのフォルダの文書ページは、依頼が触らないので編集できる
    await click(railItem(container, "港の座談会"));
    await click(railItem(container, "別のメモ"));
    await until(() => editable(container) !== undefined);
    expect(editable(container)).toBe("true");
  });
});

describe("runGate", () => {
  const recording = { projectId: "a", recordingId: "r1" };
  const base = {
    activeRun: null,
    recording,
    blockedReason: null,
    chatBusy: false,
    leaseNote: null,
    candidateReason: null,
    setupReason: null,
  };

  it("理由が無ければ null、この録音の実行中も null（呼び出し側が「止める」を出す）", () => {
    expect(runGate(base)).toBeNull();
    expect(runGate({ ...base, activeRun: { projectId: "a", recordingId: "r1" }, chatBusy: true })).toBeNull();
  });

  it("優先する順: 素材 → 実行中 → 依頼中 → 別の Mac → 別案 → 準備の不足", () => {
    const all = {
      ...base,
      activeRun: { projectId: "a", recordingId: "r2" },
      chatBusy: true,
      leaseNote: "別の Mac で実行中です。",
      candidateReason: "案を選んでください",
      setupReason: "Claude Code にログインすると実行できます",
    };
    expect(runGate({ ...all, material: false })).toEqual({ reason: "音声を入れると実行できます", setup: false });
    expect(runGate(all)).toEqual({ reason: "同じフォルダの別の録音を実行しています", setup: false });
    expect(runGate({ ...all, recording: { projectId: null, recordingId: "r1" }, activeRun: { projectId: null, recordingId: "r2" } })?.reason).toBe(
      "ホームの別の録音を実行しています",
    );
    expect(runGate({ ...all, activeRun: { projectId: "b", recordingId: "r9" }, blockedReason: "「港」の実行が終わると実行できます。" })?.reason).toBe(
      "「港」の実行が終わると実行できます。",
    );
    expect(runGate({ ...all, activeRun: null })?.reason).toBe(CHAT_BUSY_RUN_REASON);
    expect(runGate({ ...all, activeRun: null, chatBusy: false })?.reason).toBe("別の Mac で実行中です。");
    expect(runGate({ ...all, activeRun: null, chatBusy: false, leaseNote: null })?.reason).toBe("案を選んでください");
    expect(runGate({ ...all, activeRun: null, chatBusy: false, leaseNote: null, candidateReason: null })).toEqual({
      reason: "Claude Code にログインすると実行できます",
      setup: true,
    });
  });
});

describe("candidateChoiceReason", () => {
  const flow = { steps: [{ id: "body", name: "記事本文" }, { id: "memo", name: "メモ" }] };
  const recording = {
    candidateSets: {
      body: {
        stepId: "body",
        order: ["a", "b"],
        items: {
          a: { id: "a", artifactId: "body", name: "案A", createdAt: "" },
          b: { id: "b", artifactId: "artifact2", name: "案B", createdAt: "" },
        },
      },
    },
  };

  it("別案のある工程を含む実行は、案を選ぶまで押せない。開いている案の工程は決まっているので止めない", () => {
    expect(candidateChoiceReason({ recording, flow, queue: ["memo"] })).toBeNull();
    expect(candidateChoiceReason({ recording, flow, queue: ["memo", "body"] })).toBe("記事本文の案を左から開いて選ぶと実行できます");
    expect(candidateChoiceReason({ recording, flow, queue: ["body"], fixedStepId: "body" })).toBeNull();
    expect(candidateChoiceReason({ recording: { candidateSets: undefined }, flow, queue: ["body"] })).toBeNull();
  });
});
