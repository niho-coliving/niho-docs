// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import type { Editor } from "@tiptap/react";
import {
  EDIT_FIXED_RULES,
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  reasonMessage,
  type About,
  type Flow,
  type Project,
  type TurnEvent,
} from "@niho/docs-core";
import { button, click, renderApp, selectOption, typeInto, type Screen } from "./dom";
import { FakeBridge, conversationKey, done, rootRef } from "./fake-bridge";
import { addFlow, flowSelect, openAudio, outputRow, railItem, rebuild, rebuildItem, seedRun, shownVersion } from "./pages";
import { THREE_STEP_TEMPLATE } from "./three-step-flow";

/** 「AIと作る」の修正の会話（S5 #18386）: 入力欄 → CLI（偽物）→ 版 → 変更を見る／元に戻す・最近の会話・停止・失敗。 */

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

const LONG_HEADING = "# とても長い見出しで、読者に向けた丁寧な説明をすべて詰め込んだ見出しです";
const FIRST = `${LONG_HEADING}\n\n- 三年目\n`;
const SHORT = "# 短い見出し\n\n- 三年目\n";

function textProject(flow: Flow): Project {
  return {
    version: 1,
    id: "",
    name: "朝市 インタビュー",
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    info: { speakers: "2", language: "ja", terms: [], background: "" },
    source: { kind: "text" },
  };
}

/** 文章から作った今の案件で、工程 2（発言の抽出）を実行して版 1 にした状態の、その成果物の子ページ。 */
async function projectWithFirstStep(options: { about?: About; guide?: string; failConversations?: boolean } = {}) {
  const bridge = new FakeBridge();
  const flow = { ...createFlowFromTemplate(THREE_STEP_TEMPLATE, "flow-1"), guide: options.guide ?? "" };
  bridge.flow = flow;
  if (options.about) bridge.presetAbout(options.about);
  const project = await bridge.createProject(
    textProject(flow),
    "[00:00:08] 朝市に出して三年目です。\n",
    { id: "save-1", kind: "save", at: "2026-10-15T00:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" },
    [],
  );
  const stored = bridge.projects.get(project.id)!;
  const stepId = flow.steps[0]!.id;
  await seedRun(bridge, project.id, flow.steps[0]!, FIRST);
  bridge.turnScript = () => [done(FIRST)];
  if (options.failConversations) bridge.listConversations = async () => { throw new Error("一時的な読込失敗"); };
  screen = await renderApp(bridge);
  await click(railItem(screen.container, "発言の抽出"));
  return { bridge, flow, project, stored, stepId, container: screen.container };
}

function editEvents(stepId: string, reply = "見出しを短くしました。"): TurnEvent[] {
  return [
    { type: "TextDelta", text: "見出しを確かめます。" },
    { type: "ToolUse", id: "toolu_1", name: "Read", summary: `${stepId}.md` },
    { type: "ToolResult", id: "toolu_1", name: "Read", ok: true },
    { type: "ThinkingDelta", text: "短くする" },
    { type: "ToolUse", id: "toolu_2", name: "Edit", summary: `${stepId}.md` },
    { type: "ToolResult", id: "toolu_2", name: "Edit", ok: true },
    { type: "TextDelta", text: reply },
    done(reply),
  ];
}

/** 非同期の連鎖（と逐次表示の間引き）が終わるまで待つ（条件が満たされるまで、最大 2 秒）。 */
async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(condition()).toBe(true);
}

function composer(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('textarea[aria-label="直したいこと"]')!;
}

function artifactEditor(container: HTMLElement): Editor {
  const element = container.querySelector(".pbody .ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  if (!element?.editor) throw new Error("artifact editor not found");
  return element.editor;
}

async function send(container: HTMLElement, text: string) {
  await typeInto(composer(container), text);
  const sendButton = container.querySelector<HTMLButtonElement>('button[aria-label="送信"]')!;
  expect(sendButton.disabled).toBe(false);
  await click(sendButton);
}

describe("AIと作る: あなたについて", () => {
  it("会話を読めなかったらもう一度開け、送信を断られた理由を入力欄の下に残して再送できる", async () => {
    const { bridge, container } = await projectWithFirstStep({ failConversations: true });
    await until(() => container.querySelector(".composer-failure") !== null);
    expect(container.querySelector(".composer-failure")?.textContent).toContain("会話を開けませんでした。");
    bridge.listConversations = FakeBridge.prototype.listConversations.bind(bridge);
    await click(button(container.querySelector<HTMLElement>(".composer-failure")!, "もう一度開く"));
    await until(() => container.querySelector(".composer-failure") === null);

    bridge.leaseHeldBy = "Mac Studio";
    await send(container, "見出しを短くして");
    expect(container.querySelector(".composer-failure")?.textContent).toContain("Mac Studio");
    expect(container.querySelector(".toast")).toBeNull();
    expect(composer(container).value).toBe("見出しを短くして");
    bridge.leaseHeldBy = null;
    await click(container.querySelector('button[aria-label="送信"]')!);
    await until(() => bridge.chatRequests.length === 1);
    expect(container.querySelector(".composer-failure")).toBeNull();
  });

  it("設定の「あなたについて」を会話のシステム側に添え、「資料を読みました」に文書ガイドの前に並べる", async () => {
    const { bridge, stepId, container } = await projectWithFirstStep({
      about: { name: "佐藤", text: "ライフコーチをしています。" },
      guide: "# 文書の目的と読者\n\n来訪者に向けて書く。",
    });
    bridge.chatScript = (_request, _call, project) => {
      project.artifacts[stepId] = SHORT;
      return editEvents(stepId);
    };
    await send(container, "見出しを短くして");
    await until(() => bridge.chatRequests.length === 1 && container.querySelector(".bubble.ai") !== null);
    const system = bridge.chatRequests[0]!.request.system_prompt;
    expect(system.startsWith(EDIT_FIXED_RULES)).toBe(true);
    expect(system.indexOf("\n\n## あなたについて\n\n呼び名: 佐藤\n\nライフコーチをしています。")).toBe(EDIT_FIXED_RULES.length);
    expect(system.indexOf("## あなたについて")).toBeLessThan(system.indexOf("## 文書ガイド"));
    expect(bridge.chatRequests[0]!.request.user_prompt).not.toContain("ライフコーチ");
    const pack = container.querySelector(".chat .op.pack");
    expect(pack?.textContent).toBe("資料を読みました（4件）発言の抽出・背景情報・あなたについて・文書ガイド");
  });

  it("空なら添えず、「資料を読みました」にも出さない", async () => {
    const { bridge, stepId, container } = await projectWithFirstStep({ guide: "# 文書の目的と読者\n\n来訪者に向けて書く。" });
    bridge.chatScript = (_request, _call, project) => {
      project.artifacts[stepId] = SHORT;
      return editEvents(stepId);
    };
    await send(container, "見出しを短くして");
    await until(() => bridge.chatRequests.length === 1 && container.querySelector(".bubble.ai") !== null);
    expect(bridge.chatRequests[0]!.request.system_prompt).not.toContain("## あなたについて");
    const pack = container.querySelector(".chat .op.pack");
    expect(pack?.textContent).toBe("資料を読みました（3件）発言の抽出・背景情報・文書ガイド");
  });
});

describe("AIと作る: 修正の指示", () => {
  it("指示で文書が書き換わると版が増え、工程の実行と同じ会話に並ぶ。変更を見る・元に戻すが動く", async () => {
    const { bridge, stored, stepId, container } = await projectWithFirstStep();
    // 工程の実行が会話の始まり
    expect(container.querySelector(".dayline")?.textContent).toBe("新しい会話 · 発言の抽出");
    expect(container.querySelector(".step-msg")?.textContent).toContain("▶ 発言の抽出を実行");
    bridge.chatScript = (_request, _call, project) => {
      project.artifacts[stepId] = SHORT;
      return editEvents(stepId);
    };
    await send(container, "見出しを短くして");
    await until(() => (stored.versions[stepId]?.length ?? 0) === 2 && container.querySelector(".bubble.ai") !== null);

    // CLI への依頼: 修正の会話の決まり・資料パック（最初の依頼）・指示。新しい CLI の会話
    const request = bridge.chatRequests[0]!.request;
    expect(request.system_prompt.startsWith(EDIT_FIXED_RULES)).toBe(true);
    expect(request.system_prompt).toContain(`- 発言の抽出: artifacts/${stepId}.md`);
    expect(request.user_prompt.startsWith("<<資料パック 2件>>")).toBe(true);
    expect(request.user_prompt).toContain(LONG_HEADING);
    expect(request.user_prompt.endsWith("## 指示\n\n見出しを短くして")).toBe(true);
    expect(request.resume_session).toBeNull();
    expect(request.provider).toBe("ClaudeCode");

    // 版と記録（AI の版は kind agent、依頼 1 回の記録は turnRecord）
    expect(stored.versions[stepId]).toEqual([FIRST, SHORT]);
    expect(stored.artifacts[stepId]).toBe(SHORT);
    const agent = stored.runs.filter((run) => run.kind === "agent");
    expect(agent.map((run) => [run.version, run.turnRecord ?? false])).toEqual([
      [2, false],
      [null, true],
    ]);
    expect(agent[0]).toMatchObject({ stepId, instruction: "見出しを短くして", provider: "claude", model: "claude-sonnet-4-6" });
    expect(Object.values(stored.checkpoints).some((checkpoint) => checkpoint.stepName === "AIと作る" && checkpoint.state === "completed")).toBe(true);

    // 会話: 工程の実行の下に、吹き出し・作業（畳む）・返答・版のカード
    const chat = container.querySelector(".chat")!;
    expect(chat.querySelector(".step-msg")?.textContent).toContain("▶ 発言の抽出を実行");
    expect(chat.querySelector(".bubble.me")?.textContent).toBe("見出しを短くして");
    expect(chat.textContent).toContain("資料を読みました（2件）");
    const worklog = [...chat.querySelectorAll("details.worklog")].at(-1)!;
    expect(worklog.querySelector("summary")?.textContent).toMatch(/^作業 3 件/);
    const ops = [...worklog.querySelectorAll(".worklog-body > *")].map((element) => element.textContent);
    expect(ops).toEqual(["見出しを確かめます。", "発言の抽出を読みました", expect.stringMatching(/^\d+ 秒考えました$/), "発言の抽出を書き換えました"]);
    expect(chat.querySelector(".bubble.ai")?.textContent).toBe("見出しを短くしました。");
    expect(chat.querySelector(".result-wrap .result")?.textContent).toContain("発言の抽出 版 2 を保存しました");
    expect(await shownVersion(container)).toBe("第 2 版");

    // 会話のファイル（工程の会話。思考の全文は残さない）
    const files = [...(bridge.conversationFiles.get(stored.project.id)?.values() ?? [])];
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ kind: "step", stepName: "発言の抽出", runId: stored.runs.find((run) => run.kind === "run")!.id });
    expect(files[0]!.turns[0]).toMatchObject({ input: "見出しを短くして", reply: "見出しを短くしました。", result: "done", pack: ["発言の抽出", "背景情報"] });
    expect(JSON.stringify(files[0])).not.toContain("短くする");
    expect(files[0]!.session?.ref).toBe("s1");

    // 変更を見る
    await click(button(container, "変更を見る"));
    const dialog = container.querySelector(".diffdlg")!;
    await until(() => dialog.querySelector(".dl.removed") !== null);
    expect(dialog.querySelector("h2")?.textContent).toContain("版 1 → 版 2");
    expect(dialog.querySelector(".dl.removed .tx")?.textContent).toBe(LONG_HEADING);
    expect(dialog.querySelector(".dl.added .tx")?.textContent).toBe("# 短い見出し");
    // 差分から元に戻す（カードと同じ処理で前の版を新しい版として足す。履歴は消さない）
    await click(button(dialog as HTMLElement, "元に戻す"));
    expect(container.querySelector(".diffdlg")).toBeNull();
    await until(() => (stored.versions[stepId]?.length ?? 0) === 3);
    expect(stored.versions[stepId]).toEqual([FIRST, SHORT, FIRST]);
    expect(stored.runs.at(-1)).toMatchObject({ kind: "save", version: 3, restoredFrom: 1 });
    await until(() => container.querySelector(".result-wrap .result")?.textContent?.includes("版 3 で元に戻しました") ?? false);
    expect(await shownVersion(container)).toBe("第 3 版");
    expect([...(bridge.conversationFiles.get(stored.project.id)?.values() ?? [])][0]!.turns[0]!.versions[0]!.undoneAs).toBe(3);
    // 履歴: AI の版は「AIと作る「…」」、元に戻した版は「版 N から」（design-guide-docs §2）
    await click(container.querySelector('[aria-label="履歴"]')!);
    const rows = [...container.querySelectorAll(".hrow .d")].map((element) => element.textContent);
    expect(rows).toEqual(["版 1 から", "AIと作る「見出しを短くして」", "発言の抽出を実行"]);
  });

  it("2 回目の指示は同じ CLI の会話を続け、資料パックを付けない", async () => {
    const { bridge, stored, stepId, container } = await projectWithFirstStep();
    bridge.chatScript = (_request, call, project) => {
      project.artifacts[stepId] = call === 0 ? SHORT : "# 短い見出し\n";
      return editEvents(stepId, call === 0 ? "見出しを短くしました。" : "箇条書きを削りました。");
    };
    await send(container, "見出しを短くして");
    await until(() => (stored.versions[stepId]?.length ?? 0) === 2);
    await until(() => container.querySelector<HTMLButtonElement>('button[aria-label="送信"]') !== null);
    await send(container, "箇条書きを削って");
    await until(() => (stored.versions[stepId]?.length ?? 0) === 3);
    const second = bridge.chatRequests[1]!.request;
    expect(second.resume_session).toBe("s1");
    expect(second.user_prompt).toBe("箇条書きを削って");
    expect(container.querySelectorAll(".bubble.me")).toHaveLength(2);
    await until(() => container.querySelectorAll(".result-wrap").length === 2);
    expect(container.querySelectorAll(".result-wrap")[1]!.textContent).toContain("発言の抽出 版 3 を保存しました");
  });

  it("この Mac に CLI の会話が無ければ、資料パックと前の会話の記録を付けて新しい会話で送り直す", async () => {
    const { bridge, stored, stepId, container } = await projectWithFirstStep();
    bridge.chatScript = (request, call, project) => {
      if (call === 1 && request.resume_session) {
        return [{ type: "Error", reason_code: "SessionNotFound", message: "このMacに会話の続きが見つかりませんでした。" }];
      }
      project.artifacts[stepId] = call === 0 ? SHORT : "# 短い見出し\n";
      return editEvents(stepId);
    };
    await send(container, "見出しを短くして");
    await until(() => (stored.versions[stepId]?.length ?? 0) === 2);
    await until(() => container.querySelector<HTMLButtonElement>('button[aria-label="送信"]') !== null);
    await send(container, "箇条書きを削って");
    await until(() => (stored.versions[stepId]?.length ?? 0) === 3);
    expect(bridge.chatRequests).toHaveLength(3);
    const retried = bridge.chatRequests[2]!.request;
    expect(retried.resume_session).toBeNull();
    expect(retried.user_prompt).toContain("<<資料パック");
    expect(retried.user_prompt).toContain("<<前の会話の記録 1件>>");
    expect(retried.user_prompt).toContain("見出しを短くして");
    await until(() => container.textContent?.includes("前の会話の記録を引き継ぎました（1件）") ?? false);
  });
});

describe("AIと作る: 人の編集との兼ね合い", () => {
  it("版の後に直した文書は送る前に 1 つだけ版にし（before_ai・#18912）、AI はその内容を読む", async () => {
    const { bridge, stored, stepId, container } = await projectWithFirstStep();
    bridge.turnScript = () => [done("# 二回目の抽出\n")];
    await rebuild(container);
    await until(() => (stored.versions[stepId]?.length ?? 0) === 2);
    await until(() => artifactEditor(container).getText().includes("二回目の抽出"));
    // 現在版を直す（自動保存で今の文書へ。版はまだ作らない）
    await act(async () => {
      artifactEditor(container).commands.insertContent("、送る前の直し");
    });
    bridge.chatScript = () => [done("確かめました。")];
    await send(container, "表記を確かめて");
    await until(() => bridge.chatRequests.length === 1);
    // 送る前に版にした（版 3 = 直した内容）。送る前の保存で同じ版を重ねない
    expect(stored.versions[stepId]).toHaveLength(3);
    expect(stored.versions[stepId]![2]).toContain("送る前の直し");
    expect(bridge.chatRequests[0]!.request.user_prompt).toContain("送る前の直し");
    const saves = stored.runs.filter((run) => run.kind === "save" && run.stepId === stepId);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ auto: true, version: 3 });
    const kinds = stored.runs.map((run) => run.kind);
    expect(kinds.lastIndexOf("save")).toBeLessThan(kinds.lastIndexOf("agent"));
  });

  it("依頼の最中に人が保存した文書は版に保ち、AI の結果を次の版にする", async () => {
    const { bridge, stored, stepId, container } = await projectWithFirstStep();
    bridge.chatScript = (_request, _call, project) => {
      project.artifacts[stepId] = SHORT;
      return editEvents(stepId);
    };
    const human = "# 人が直した見出し\n";
    bridge.onChatStarted = async () => {
      await bridge.saveArtifact(rootRef(stored.project.id), stepId, false, human, {
        id: "save-human",
        kind: "save",
        at: new Date().toISOString(),
        stepId,
        stepName: "発言の抽出",
        version: null,
        result: "saved",
      });
    };
    await send(container, "見出しを短くして");
    await until(() => container.querySelector(".op.note") !== null);
    expect(stored.versions[stepId]).toEqual([FIRST, human, "# 短い見出し\n\n- 三年目\n"]);
    expect(stored.artifacts[stepId]).toBe("# 短い見出し\n\n- 三年目\n");
    expect(stored.runs.filter((run) => run.kind === "agent" && run.version !== null)).toHaveLength(1);
    expect(container.querySelector(".op.note")?.textContent).toBe(
      "作っている間に直した内容は、版に残しました。",
    );
    expect(container.querySelector(".result-wrap")).not.toBeNull();
  });
});

describe("AIと作る中の録音設定", () => {
  it("依頼中は録音の工程を切り替えない", async () => {
    const { bridge, flow, stored, container } = await projectWithFirstStep();
    await click(button(container, "工程設計"));
    await addFlow(container, "記事制作");
    const secondFlow = bridge.flowFiles.get(bridge.flowIndex!.order[1]!)!;
    await openAudio(container);

    let release!: () => void;
    bridge.chatGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bridge.chatScript = () => [{ type: "TextDelta", text: "依頼中" }, done("確認しました。")];
    await send(container, "工程を変えずに直してください。");
    await until(() => bridge.chatRequests.length === 1 && container.textContent?.includes("依頼中") === true);

    const select = flowSelect(container);
    expect(select.disabled).toBe(true);
    await selectOption(select, secondFlow.id);
    expect(stored.project.flowSnapshot?.id).toBe(flow.id);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    release();
    await until(() => container.querySelector<HTMLButtonElement>('button[aria-label="送信"]') !== null);
  });
});

describe("AIと作る: 失敗・停止・会話の切り替え", () => {
  it("移した録音は以前の履歴を残し、古い session を再開せず新しい会話で続ける", async () => {
    const { bridge, stored, stepId } = await projectWithFirstStep();
    let container = screen!.container;
    bridge.chatScript = (_request, call, project) => {
      project.artifacts[stepId] = call === 0 ? SHORT : "# 移動後\n";
      return editEvents(stepId, call === 0 ? "移動前です。" : "移動後です。");
    };
    await send(container, "移動前の修正");
    await until(() => bridge.chatRequests.length === 1);
    const oldFiles = bridge.conversationFiles.get(stored.project.id)!;
    expect([...oldFiles.values()][0]!.session?.ref).toBe("s1");

    // フォルダの音声は背景情報のページから移動できる。台帳先頭に固定するため並べ替えは出さない。ホームへ移し、再読込後の会話引継ぎを確かめる。
    await click(railItem(container, "背景情報"));
    await click(container.querySelector('.window-titlebar .acts button[aria-label="その他"]')!);
    const menu = container.querySelector<HTMLElement>(".pagemenu .pop")!;
    expect(button(menu, "フォルダへ移す")).toBeTruthy();
    expect(menu.textContent).not.toMatch(/上へ移動|下へ移動/);
    await click(button(menu, "フォルダへ移す"));
    await click(button(container.querySelector<HTMLElement>(".pagemenu .pop")!, "ホーム"));
    await until(() => bridge.outside.project.pages?.some((page) => page.kind === "rec") === true);
    screen!.unmount();
    screen = await renderApp(bridge);
    container = screen.container;
    const moved = bridge.outside.project.pages!.find((page) => page.kind === "rec")!;
    expect(moved.id).not.toBe("root");
    await click(outputRow(container, "発言の抽出"));
    await click(railItem(container, "文章"));

    await send(container, "移動後の修正");
    await until(() => bridge.chatRequests.length === 2);
    expect(bridge.chatRequests[1]!.projectId).toBeNull();
    expect(bridge.chatRequests[1]!.request.resume_session).toBeNull();
    const movedRecordingId = moved.recordingId ?? moved.id;
    const files = [...(bridge.conversationFiles.get(conversationKey({ projectId: null, recordingId: movedRecordingId }))?.values() ?? [])];
    expect(files).toHaveLength(2);
    const newest = files.find((file) => file.turns.some((turn) => turn.input === "移動後の修正"))!;
    expect(newest.locationGeneration).toBe(1);
    expect(newest.notice).toBe("移動したので新しい会話で始めます。");
    expect(container.querySelector(".chat-move-notice")?.textContent).toBe("移動したので新しい会話で始めます。");

    await click(container.querySelector('[aria-label="会話の切り替え"]')!);
    await until(() => container.querySelectorAll(".chatmenu .crow").length === 2);
    const oldConversation = [...container.querySelectorAll<HTMLElement>(".chatmenu .crow")]
      .find((row) => !row.classList.contains("on"));
    expect(oldConversation).toBeTruthy();
    await click(oldConversation!);
    expect(container.textContent).toContain("移動前の会話は履歴の閲覧だけです。");
    expect(button(container, "元に戻す").disabled).toBe(true);
  });

  it("未ログイン・時間切れは工程の実行と同じ文言で会話に出し、書き換えは無い", async () => {
    const { bridge, stored, stepId, container } = await projectWithFirstStep();
    bridge.chatScript = () => [{ type: "Error", reason_code: "CliLoginRequired", message: "このMacの Claude Code にログインしていません。" }];
    await send(container, "見出しを短くして");
    await until(() => container.querySelector(".chat .op.fail")?.textContent === "このMacの Claude Code にログインしていません。");
    expect(stored.versions[stepId]).toHaveLength(1);
    const turnRecord = stored.runs.find((run) => run.kind === "agent" && run.turnRecord);
    expect(turnRecord).toMatchObject({ result: "failed", reasonCode: "CliLoginRequired" });
    // 次の依頼にも資料パックを付ける（続けられる CLI の会話がまだ無い）
    bridge.chatScript = () => [{ type: "Error", reason_code: "Timeout", message: reasonMessage("Timeout") }];
    await until(() => container.querySelector<HTMLButtonElement>('button[aria-label="送信"]') !== null);
    await send(container, "もう一度");
    await until(() => [...container.querySelectorAll(".chat .op.fail")].some((element) => element.textContent === reasonMessage("Timeout")));
    expect(bridge.chatRequests[1]!.request.user_prompt.startsWith("<<資料パック")).toBe(true);
  });

  it("実行中は送信が停止になり、止めると途中までの書き換えを版にして止めたことを出す", async () => {
    const { bridge, stored, stepId, container } = await projectWithFirstStep();
    let release!: () => void;
    bridge.chatGate = new Promise<void>((resolve) => (release = resolve));
    bridge.chatScript = (_request, _call, project) => {
      project.artifacts[stepId] = SHORT;
      return [
        { type: "ToolUse", id: "toolu_1", name: "Edit", summary: `${stepId}.md` },
        { type: "ToolResult", id: "toolu_1", name: "Edit", ok: true },
        done("見出しを短くし", "Stopped"),
      ];
    };
    await send(container, "見出しを短くして");
    await until(() => container.querySelector('button[aria-label="停止"].send') !== null);
    // 実行中: 吹き出しと作業の行。工程は実行できない
    expect(container.querySelector(".chat .bubble.me")?.textContent).toBe("見出しを短くして");
    await until(() => container.querySelector(".chat .op.running")?.textContent === "発言の抽出を書き換えています");
    expect((await rebuildItem(container)).disabled).toBe(true);
    await click(container.querySelector('button[aria-label="停止"].send')!);
    await until(() => bridge.stoppedTurns.length === 1);
    release();
    await until(() => container.querySelector(".chat .op.stopped")?.textContent === "止めました。途中までを残しています。");
    // 止めた依頼でも、書き換えた分は版にする
    expect(stored.versions[stepId]).toEqual([FIRST, SHORT]);
    expect(stored.runs.find((run) => run.kind === "agent" && run.turnRecord)).toMatchObject({ result: "stopped" });
  });

  it("送れなかった理由は、別の会話を選んだら消す（別の会話の失敗に見せない）", async () => {
    const { bridge, container } = await projectWithFirstStep();
    bridge.leaseHeldBy = "Mac Studio";
    await send(container, "見出しを短くして");
    expect(container.querySelector(".composer-failure")?.textContent).toContain("Mac Studio");
    await click(container.querySelector('[aria-label="会話の切り替え"]')!);
    await click(button(container, "新しい会話"));
    expect(container.querySelector(".composer-failure")).toBeNull();
  });

  it("⋯ の最近の会話で会話を開き、新しい会話は修正の会話として始まる", async () => {
    const { bridge, stored, stepId, container } = await projectWithFirstStep();
    bridge.chatScript = (_request, _call, project) => {
      project.artifacts[stepId] = SHORT;
      return editEvents(stepId);
    };
    await send(container, "見出しを短くして");
    await until(() => (stored.versions[stepId]?.length ?? 0) === 2);
    await until(() => container.querySelector<HTMLButtonElement>('button[aria-label="送信"]') !== null);
    // 新しい会話
    await click(container.querySelector('[aria-label="会話の切り替え"]')!);
    await click(button(container, "新しい会話"));
    expect(container.querySelector(".chat .bubble")).toBeNull();
    // 空の会話の本文には説明を出さない（説明は見出しの ⓘ。owner 2026-10-18・#18941）
    expect(container.querySelector(".chat")?.textContent).toBe("");
    bridge.chatScript = () => [done("確かめました。表記は揃っています。")];
    await send(container, "表記を確かめて");
    await until(() => container.querySelector(".chat .bubble.ai")?.textContent === "確かめました。表記は揃っています。");
    expect(container.querySelector(".dayline")?.textContent).toMatch(/^新しい会話 · \d+\/\d+ \d\d:\d\d$/);
    expect(container.querySelector(".chat .step-msg")).toBeNull();
    // 新しい会話の最初の依頼にも資料パック（書き換えた後の最新版）
    expect(bridge.chatRequests[1]!.request.user_prompt).toContain("# 短い見出し");
    expect(bridge.chatRequests[1]!.request.resume_session).toBeNull();
    const files = [...(bridge.conversationFiles.get(stored.project.id)?.values() ?? [])];
    expect(files.map((file) => file.kind).sort()).toEqual(["edit", "step"]);
    // 最近の会話: 新しい順。前の会話を開く
    await click(container.querySelector('[aria-label="会話の切り替え"]')!);
    const titles = [...container.querySelectorAll(".chatmenu .crow .d")].map((element) => element.textContent);
    expect(titles).toEqual(["表記を確かめて", "▶ 発言の抽出を実行"]);
    await click(container.querySelectorAll(".chatmenu .crow")[1]!);
    expect(container.querySelector(".chat .step-msg")?.textContent).toContain("▶ 発言の抽出を実行");
    expect(container.querySelector(".chat .bubble.me")?.textContent).toBe("見出しを短くして");
  });

  it("工程の実行中は入力欄から送れず、理由を 1 行出す", async () => {
    const { bridge, container } = await projectWithFirstStep();
    let release!: () => void;
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.turnScript = () => [{ type: "TextDelta", text: "途中" }, done("二回目")];
    await rebuild(container);
    await typeInto(composer(container), "見出しを短くして");
    expect(composer(container).disabled).toBe(true);
    expect(container.querySelector(".composer-note")?.textContent).toBe("工程の実行が終わってから送れます。");
    release();
    await until(() => container.querySelector(".composer-note") === null);
    expect(bridge.chatRequests).toHaveLength(0);
  });
});

describe("AIと作る: 文字起こし・文章と ＋（工程を実行）", () => {
  it("実行中に保存された文字起こしと AI の結果が同じなら、文章の版を重ねない", async () => {
    const { bridge, stored, container } = await projectWithFirstStep();
    const sameAsAi = "[00:00:08] 朝市に出店して三年目です。\n";
    bridge.onChatStarted = async (recording) => { recording.transcript = sameAsAi; };
    bridge.chatScript = (_request, _call, project) => {
      project.artifacts[SOURCE_STEP_ID] = sameAsAi;
      return [done("本文はすでに同じでした。")];
    };

    await send(container, "文章を直して");
    await until(() => container.querySelector(".bubble.ai") !== null);

    expect(stored.transcript).toBe(sameAsAi);
    expect(stored.versions[SOURCE_STEP_ID]).toHaveLength(1);
    expect(stored.runs.some((run) => run.kind === "agent" && run.stepId === SOURCE_STEP_ID)).toBe(false);
  });

  it("頼まれれば工程 1 の文字起こし・文章（artifacts/source.md）も直し、文章の版を足す。元に戻すも文章に効く", async () => {
    const { bridge, stored, container } = await projectWithFirstStep();
    const before = stored.transcript;
    stored.runs.find((run) => run.stepId === SOURCE_STEP_ID && run.version === 1)!.transcriptSpeakerNames = { "1": "田中" };
    bridge.chatScript = (request, _call, project) => {
      // 作業フォルダでは文字起こしも artifacts/ の下（source.md）にあり、頼まれたときだけ直す決まり
      expect(request.system_prompt).toContain("- 文章: artifacts/source.md（頼まれたときだけ直す）");
      project.artifacts[SOURCE_STEP_ID] = "[00:00:08] 朝市に出店して三年目です。\n";
      return [
        { type: "ToolUse", id: "toolu_1", name: "Edit", summary: "source.md" },
        { type: "ToolResult", id: "toolu_1", name: "Edit", ok: true },
        done("「出して」を「出店して」に直しました。"),
      ];
    };
    await send(container, "文章の「出して」を「出店して」に直して");
    await until(() => (stored.versions[SOURCE_STEP_ID]?.length ?? 0) === 2 && container.querySelector(".bubble.ai") !== null);
    expect(stored.transcript).toBe("[00:00:08] 朝市に出店して三年目です。\n");
    expect(stored.runs.find((run) => run.kind === "agent" && run.stepId === SOURCE_STEP_ID)).toMatchObject({
      stepName: "文章",
      version: 2,
      transcriptSpeakerNames: { "1": "田中" },
    });
    // 作業の行と版のカードは工程 1 の名前で出す
    expect(container.querySelector(".chat")?.textContent).toContain("文章を書き換えました");
    expect(container.querySelector(".chat")?.textContent).toContain("文章 版 2 を保存しました");
    await click(button(container, "元に戻す"));
    await until(() => (stored.versions[SOURCE_STEP_ID]?.length ?? 0) === 3);
    expect(stored.transcript).toBe(before);
    expect(stored.runs.at(-1)).toMatchObject({ restoredFrom: 1, transcriptSpeakerNames: { "1": "田中" } });
  });

  it("＋ から工程を実行でき、前の工程が済んでいない工程は押せない。実行中は押せない", async () => {
    const { bridge, flow, stored, container } = await projectWithFirstStep();
    const plus = container.querySelector<HTMLButtonElement>('button[aria-label="工程を実行"]')!;
    await click(plus);
    const items = [...container.querySelectorAll<HTMLButtonElement>(".pop.stepmenu .mi")];
    expect(items.map((item) => item.textContent)).toEqual(flow.steps.map((step) => `▶ ${step.name}を実行`));
    // 発言の抽出（済み）とインサイト（前が済み）は押せ、次の打ち手（インサイトがまだ）は押せない
    expect(items.map((item) => item.disabled)).toEqual([false, false, true]);
    let release!: () => void;
    bridge.turnGate = new Promise<void>((resolve) => (release = resolve));
    bridge.turnScript = () => [{ type: "TextDelta", text: "途中" }, done("見えてきたこと")];
    await click(items[1]!);
    expect(container.querySelector(".pop.stepmenu")).toBeNull();
    // 発言の抽出は記録を置いただけ（依頼していない）なので、これが最初の依頼
    await until(() => bridge.turnRequests.length === 1);
    expect(container.querySelector(".chat .step-msg")?.textContent).toContain(`▶ ${flow.steps[1]!.name}を実行`);
    // 実行中は ＋ の工程を押せない
    await click(plus);
    expect([...container.querySelectorAll<HTMLButtonElement>(".pop.stepmenu .mi")].every((item) => item.disabled)).toBe(true);
    await click(plus);
    release();
    await until(() => (stored.versions[flow.steps[1]!.id]?.length ?? 0) === 1);
    expect(stored.artifacts[flow.steps[1]!.id]?.trim()).toBe("見えてきたこと");
  });
});
