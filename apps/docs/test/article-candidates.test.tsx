// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/react";
import {
  FLOW_TEMPLATES,
  SOURCE_STEP_ID,
  basisFor,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  type CandidateSet,
  type ConversationFile,
  type Flow,
  type Project,
  type RunRecord,
} from "@niho/docs-core";
import { button, click, renderApp, typeInto, type Screen } from "./dom";
import { FakeBridge, conversationKey, done, recordingView, rootRef } from "./fake-bridge";
import { openPageMenu, pageMenuItems, railItem, rebuild, seedRun, until } from "./pages";

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

function textProject(flow: Flow): Project {
  return {
    version: 1,
    id: "",
    name: "記事候補テスト",
    createdAt: "2026-10-16T00:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    info: { speakers: "auto", language: "ja", terms: [], background: "" },
    source: { kind: "text" },
  };
}

async function articleProject(options: { body?: boolean } = { body: true }) {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "article-flow");
  bridge.flow = flow;
  const created = await bridge.createProject(
    textProject(flow),
    "取材の文字起こし",
    { id: "source-save", kind: "save", at: "2026-10-16T00:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" },
    [],
  );
  const stored = bridge.projects.get(created.id)!;
  await seedRun(bridge, created.id, flow.steps[0]!, "# 修正版\n\n取材本文");
  await seedRun(bridge, created.id, flow.steps[1]!, "# 記事方針\n\n地域の人向け");
  if (options.body !== false) await seedRun(bridge, created.id, flow.steps[2]!, "# 最初の記事\n\n本文A");
  return { bridge, flow, created, stored, body: flow.steps[2]! };
}

function ledger(bodyStepId: string): CandidateSet {
  return {
    stepId: bodyStepId,
    order: ["candidate1", "candidate2"],
    items: {
      candidate1: { id: "candidate1", artifactId: bodyStepId, name: "最初の案", createdAt: "2026-10-16T01:00:00.000Z" },
      candidate2: { id: "candidate2", artifactId: "artifact2", name: "別案", createdAt: "2026-10-16T01:00:00.000Z" },
    },
  };
}

function editor(container: HTMLElement): Editor {
  const element = container.querySelector(".pbody .ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  if (!element?.editor) throw new Error("artifact editor not found");
  return element.editor;
}

async function replaceBody(container: HTMLElement, markdown: string) {
  await act(async () => {
    editor(container).commands.setContent(markdown);
  });
}

function composer(container: HTMLElement): HTMLTextAreaElement {
  const found = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="直したいこと"]');
  if (!found) throw new Error("chat composer not found");
  return found;
}

async function send(container: HTMLElement, text: string) {
  await typeInto(composer(container), text);
  await click(container.querySelector<HTMLButtonElement>('button[aria-label="送信"]')!);
}

function legacyConversation(body: Pick<RunRecord, "id" | "stepId" | "stepName">): ConversationFile {
  return {
    schemaVersion: 1,
    id: body.id,
    kind: "step",
    createdAt: "2026-10-16T01:00:00.000Z",
    updatedAt: "2026-10-16T01:01:00.000Z",
    runId: body.id,
    stepId: body.stepId,
    stepName: body.stepName,
    session: { provider: "claude", connection: "subscription", model: "claude-sonnet-4-6", effort: "high", profile: "標準", ref: "legacy-session" },
    turns: [{
      id: "legacy-turn",
      at: "2026-10-16T01:01:00.000Z",
      input: "見出しを直して",
      pack: null,
      record: 0,
      items: [],
      reply: "直しました。",
      versions: [{ stepId: body.stepId, stepName: body.stepName, version: 2, previous: 1, chars: 8, delta: 1 }],
      notes: [],
      result: "done",
      reasonCode: null,
      message: null,
      durationMs: 10,
      provider: "claude",
      model: "claude-sonnet-4-6",
      effort: "high",
      profile: "標準",
      tokensKnown: true,
      inputTokens: 10,
      outputTokens: 5,
    }],
  };
}

describe("記事本文の複数案", () => {
  it("別の Mac が実行中で別案を作れないときは、開いたダイアログ内に理由を残す", async () => {
    const { bridge, body } = await articleProject();
    screen = await renderApp(bridge);
    const { container } = screen;
    bridge.leaseHeldBy = "Mac Studio";
    await click(container.querySelector(`button[aria-label="${body.name}の別案を作成"]`)!);
    const dialog = container.querySelector<HTMLElement>('.dlg[role="dialog"]')!;
    await click(button(dialog, "生成する"));
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("Mac Studio");
    expect(button(dialog, "生成する").disabled).toBe(false);
    expect(container.querySelector(".toast")).toBeNull();
    expect(bridge.turnRequests).toHaveLength(0);
  });

  it("左レールだけから2案目を生成し、案ごとのドラフトを保ち、保存して現在案を複製する", async () => {
    const { bridge, created, stored, body } = await articleProject();
    bridge.turnScript = () => [done("# 生成した別案\n\n本文B")];
    const createCandidate = bridge.createCandidate.bind(bridge);
    bridge.createCandidate = async (...args) => {
      expect(bridge.locks.has(created.id)).toBe(true);
      return createCandidate(...args);
    };
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(container.querySelectorAll(".candidate-add")).toHaveLength(1);
    expect(container.querySelector("main")?.textContent).not.toContain("別案を作成");

    await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${body.name}の別案を作成"]`)!);
    await typeInto(container.querySelector<HTMLInputElement>("#candidate-name")!, "切り口B");
    await typeInto(container.querySelector<HTMLTextAreaElement>("#candidate-instruction")!, "若い読者向けに、結論を先に書く");
    await click(button(container.querySelector<HTMLElement>('.dlg[role="dialog"]')!, "生成する"));
    await until(() => stored.project.candidateSets?.[body.id]?.order.length === 2 && bridge.turnRequests.length === 1);
    const set = stored.project.candidateSets![body.id]!;
    const second = set.items[set.order[1]!]!;
    await until(() => stored.artifacts[second.artifactId]?.includes("生成した別案") ?? false);
    await until(() => !bridge.locks.has(created.id));
    expect(second.name).toBe("切り口B");
    expect(bridge.turnRequests[0]!.system_prompt).toContain("若い読者向けに、結論を先に書く");
    expect(stored.runs.find((run) => run.artifactId === second.artifactId)).toMatchObject({
      stepId: body.id,
      candidateId: second.id,
      artifactId: second.artifactId,
      instruction: "若い読者向けに、結論を先に書く",
    });
    expect(stored.artifacts[body.id]).toContain("最初の記事");
    expect(railItem(container, body.name).getAttribute("aria-current")).toBeNull();
    expect(railItem(container, "切り口B").getAttribute("aria-current")).toBe("page");

    await replaceBody(container, "# Bの未保存草稿\n\n本文");
    await click(railItem(container, "最初の案"));
    await replaceBody(container, "# Aの未保存草稿\n\n本文");
    await click(railItem(container, "切り口B"));
    expect(container.querySelector(".pbody .ProseMirror")?.textContent).toContain("Bの未保存草稿");
    await click(railItem(container, "最初の案"));
    expect(container.querySelector(".pbody .ProseMirror")?.textContent).toContain("Aの未保存草稿");

    const compare = button(container, "比較");
    compare.focus();
    await click(compare);
    expect(document.activeElement?.textContent).toBe("閉じる");
    expect(container.querySelector('.candidate-compare [contenteditable="true"]')).toBeNull();
    const compared = [...container.querySelectorAll<HTMLElement>(".candidate-compare .compare-document")];
    expect(compared[0]?.textContent).toContain("Aの未保存草稿");
    expect(compared[1]?.textContent).toContain("Bの未保存草稿");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await until(() => container.querySelector(".candidate-compare") === null);
    expect(document.activeElement).toBe(compare);

    await click(compare);
    await click(button(container.querySelector<HTMLElement>(".candidate-compare")!, "この別案を開く"));
    expect(container.querySelector(".candidate-compare")).toBeNull();
    expect(railItem(container, "切り口B").getAttribute("aria-current")).toBe("page");
    expect(container.querySelector(".pbody .ProseMirror")?.textContent).toContain("Bの未保存草稿");
    await replaceBody(container, "# 複製前に保存する本文\n\n本文B");
    await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${body.name}の別案を作成"]`)!);
    await click(container.querySelectorAll<HTMLInputElement>('input[name="candidate-mode"]')[1]!);
    expect(container.querySelector(".dlg .hint")?.textContent).toBe("複製元: 切り口B");
    await typeInto(container.querySelector<HTMLInputElement>("#candidate-name")!, "切り口C");
    // ダイアログを開いた後に表示対象が変わっても、複製元Bの草稿を保存する。
    await click(railItem(container, "最初の案"));
    await click(button(container.querySelector<HTMLElement>('.dlg[role="dialog"]')!, "複製する"));
    await until(() => stored.project.candidateSets?.[body.id]?.order.length === 3);
    const thirdSet = stored.project.candidateSets![body.id]!;
    const third = Object.values(thirdSet.items).find((candidate) => candidate.name === "切り口C")!;
    expect(stored.artifacts[second.artifactId]).toContain("複製前に保存する本文");
    expect(stored.artifacts[third.artifactId]).toContain("複製前に保存する本文");
    expect(stored.runs.find((run) => run.artifactId === third.artifactId)).toMatchObject({ candidateId: third.id, kind: "save" });
    expect(conversationKey(rootRef(created.id))).toBe(created.id);
    await until(() => !bridge.locks.has(created.id));
  });

  it("候補台帳がある本文を録音全体から暗黙実行せず、案を開くまで実行を押せなくして理由を帯に出す（#18789）", async () => {
    const { bridge, created, stored, body } = await articleProject({ body: false });
    await bridge.createCandidate(rootRef(created.id), body.id, ledger(body.id), "artifact2", null, null);
    screen = await renderApp(bridge);
    // 押してからトーストで断られるのではなく、押す前に理由を出して押せなくする
    expect(button(screen.container, "続きを作成").disabled).toBe(true);
    expect(screen.container.querySelector(".runbar .note")?.textContent).toBe(`${body.name}の案を左から開いて選ぶと実行できます`);
    await click(button(screen.container, "続きを作成"));
    expect(bridge.turnRequests).toHaveLength(0);
    expect(screen.container.querySelector(".failure-band")).toBeNull();
    expect(stored.artifacts[body.id]).toBeUndefined();
    // 入力欄の「＋ → 工程を実行」も、案が決まらない工程は選べない
    await click(screen.container.querySelector<HTMLButtonElement>('button[aria-label="工程を実行"]')!);
    const item = [...screen.container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes(body.name))!;
    expect(item.disabled).toBe(true);
    expect(item.title).toBe(`${body.name}の案を左から開いて選ぶと実行できます`);
  });

  it("複製前の未保存本文を保存できなければ、新しい案台帳や本文を作らない", async () => {
    const { bridge, created, stored, body } = await articleProject();
    await bridge.createCandidate(rootRef(created.id), body.id, ledger(body.id), "artifact2", "# 別案", {
      id: "duplicate2", kind: "save", at: "2026-10-16T01:10:00.000Z", stepId: body.id, stepName: "別案",
      candidateId: "candidate2", artifactId: "artifact2", version: null, result: "saved",
    });
    screen = await renderApp(bridge);
    await click(railItem(screen.container, "別案"));
    await replaceBody(screen.container, "# 保存に失敗する草稿");
    const artifactsBefore = Object.keys(stored.artifacts).sort();
    const saveArtifact = bridge.saveArtifact.bind(bridge);
    bridge.saveArtifact = async (rec, stepId, source, markdown, record) => {
      if (stepId === "artifact2") throw { code: "store_io", message: "保存できません" };
      return saveArtifact(rec, stepId, source, markdown, record);
    };
    await click(screen.container.querySelector<HTMLButtonElement>(`button[aria-label="${body.name}の別案を作成"]`)!);
    await click(screen.container.querySelectorAll<HTMLInputElement>('input[name="candidate-mode"]')[1]!);
    await typeInto(screen.container.querySelector<HTMLInputElement>("#candidate-name")!, "作られない案");
    await click(button(screen.container.querySelector<HTMLElement>('.dlg[role="dialog"]')!, "複製する"));
    await until(() => screen!.container.querySelector(".failure-band .fb-msg")?.textContent?.includes("保存できません") ?? false);
    expect(stored.project.candidateSets![body.id]!.order).toHaveLength(2);
    expect(Object.values(stored.project.candidateSets![body.id]!.items).some((candidate) => candidate.name === "作られない案")).toBe(false);
    expect(Object.keys(stored.artifacts).sort()).toEqual(artifactsBefore);
  });

  it("選択案自身の生成前提と追加指示で前提変更を判定する", async () => {
    const { bridge, created, stored, body } = await articleProject();
    const view = await recordingView(bridge, created.id);
    const set = ledger(body.id);
    set.items.candidate2!.instruction = "若い読者向け";
    await bridge.createCandidate(rootRef(created.id), body.id, set, "artifact2", "# 若い読者向けの記事", {
      id: "candidate2-run", kind: "run", at: "2026-10-16T01:10:00.000Z", stepId: body.id, stepName: "別案",
      candidateId: "candidate2", artifactId: "artifact2", version: null, result: "saved",
      basis: basisFor(view.flow, 2, { ...view.materials, candidateInstruction: "若い読者向け" }),
    });
    stored.project.candidateSets![body.id]!.items.candidate2!.instruction = "専門家向け";
    screen = await renderApp(bridge);
    await click(railItem(screen.container, "別案"));
    expect([...screen.container.querySelectorAll(".pmeta .pill.warn")].map((item) => item.textContent)).toContain("前提変更");
    // 案のページは工程の番号・版・再実行をメタ行に残し、通常の検索・書式・書き出しメニューに作り直しを混ぜない（#18915・#18941）
    const meta = screen.container.querySelector<HTMLElement>(".pmeta")!;
    expect(meta.querySelector(".pill.mute")?.textContent).toMatch(/^工程 \d+$/);
    expect(meta.querySelector(".ver")?.textContent).toMatch(/^第 \d+ 版$/);
    expect(button(meta, "再実行")).toBeTruthy();
    const pageMenu = await openPageMenu(screen.container);
    expect(pageMenuItems(pageMenu)).not.toContain("作り直す");
    expect(pageMenu.textContent).not.toContain("フォルダへ移す");
    expect(screen.container.querySelector(".cloud-banner")).toBeNull();
    // レールの案の行は文書の印のまま
    expect(railItem(screen.container, "別案").querySelector(".n svg")).not.toBeNull();
  });

  it("候補会話は旧録音全体のrun ID・sessionを上書きせず、新しいIDで対象案だけを直す", async () => {
    const { bridge, created, stored, body } = await articleProject();
    const secondRun = await seedRun(bridge, created.id, body, "# 旧会話で直した本文\n\n本文A", undefined, "2026-10-16T01:00:00.000Z");
    const set = ledger(body.id);
    await bridge.createCandidate(rootRef(created.id), body.id, set, "artifact2", "# 別案\n\n本文B", {
      id: "duplicate2", kind: "save", at: "2026-10-16T01:10:00.000Z", stepId: body.id, stepName: "別案",
      candidateId: "candidate2", artifactId: "artifact2", version: null, result: "saved",
    });
    const legacy = legacyConversation(secondRun);
    await bridge.saveConversation(rootRef(created.id), legacy);
    const legacyBefore = structuredClone(legacy);
    bridge.chatScript = (request, _call, staged) => {
      expect(request.writable_artifact_id).toBe(body.id);
      staged.artifacts[body.id] = "# 候補1だけの修正\n\n本文A";
      staged.artifacts.artifact2 = "# workspace内だけの兄弟変更";
      return [done("候補1を直しました。", "EndTurn", "new-session")];
    };
    screen = await renderApp(bridge);
    await click(railItem(screen.container, "最初の案"));
    await click(screen.container.querySelector<HTMLButtonElement>('button[aria-label="会話の切り替え"]')!);
    await click(button(screen.container.querySelector<HTMLElement>('[role="menu"]')!, "新しい会話"));
    await send(screen.container, "候補1の見出しを直して");
    await until(() => bridge.chatRequests.length === 1 && stored.artifacts[body.id]?.includes("候補1だけ") === true);
    expect(bridge.chatRequests[0]!.request.resume_session).toBeNull();
    expect(stored.artifacts.artifact2).toContain("別案");
    const files = bridge.conversationFiles.get(created.id)!;
    expect(files.get(secondRun.id)).toEqual(legacyBefore);
    const candidateFile = [...files.values()].find((file) => file.candidateId === "candidate1")!;
    expect(candidateFile.id).not.toBe(secondRun.id);
    expect(candidateFile).toMatchObject({ artifactId: body.id, session: { ref: "new-session" } });
  });

  it("旧録音全体の会話にある候補本文の版カードは共有画面では閲覧専用にする", async () => {
    const { bridge, created, stored, body } = await articleProject();
    const secondRun = await seedRun(bridge, created.id, body, "# 旧会話で直した本文\n\n本文A", undefined, "2026-10-16T01:00:00.000Z");
    await bridge.createCandidate(rootRef(created.id), body.id, ledger(body.id), "artifact2", "# 別案", {
      id: "duplicate2", kind: "save", at: "2026-10-16T01:10:00.000Z", stepId: body.id, stepName: "別案",
      candidateId: "candidate2", artifactId: "artifact2", version: null, result: "saved",
    });
    await bridge.saveConversation(rootRef(created.id), legacyConversation(secondRun));
    screen = await renderApp(bridge);
    await until(() => screen!.container.querySelector(".candidate-undo-note") !== null);
    const undo = button(screen.container, "元に戻す");
    expect(undo.disabled).toBe(true);
    expect(screen.container.querySelector(".candidate-undo-note")?.textContent).toContain("左から対象の案を開いて");
    // 共有画面でも名前を指定した新しい文書の依頼は受け付ける（通常の編集は送るときに「左の案を開いて」と止める。#18681）
    expect(composer(screen.container).disabled).toBe(false);
    expect(stored.versions[body.id]).toHaveLength(2);
  });

  it("最初の案では旧会話を閲覧・undoでき、編集は新会話に分けて実行後は最新のrunを表示する", async () => {
    const { bridge, created, stored, body } = await articleProject();
    const oldRun = await seedRun(bridge, created.id, body, "# 旧会話で直した本文\n\n本文A", undefined, "2026-10-16T01:00:00.000Z");
    await bridge.createCandidate(rootRef(created.id), body.id, ledger(body.id), "artifact2", "# 別案", {
      id: "duplicate2", kind: "save", at: "2026-10-16T01:10:00.000Z", stepId: body.id, stepName: "別案",
      candidateId: "candidate2", artifactId: "artifact2", version: null, result: "saved",
    });
    await bridge.saveConversation(rootRef(created.id), legacyConversation(oldRun));
    bridge.turnScript = () => [done("# 新しい本文")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "最初の案"));
    await until(() => composer(container).disabled);
    expect(container.querySelector(".composer-note")?.textContent).toContain("元の会話は閲覧と元に戻すだけです");
    expect(button(container, "元に戻す").disabled).toBe(false);

    await click(button(container, "元に戻す"));
    const undoConfirm = container.querySelector<HTMLElement>(".result-confirm");
    if (undoConfirm) await click(button(undoConfirm, "戻す"));
    await until(() => stored.versions[body.id]?.length === 3);
    expect(stored.artifacts[body.id]).toContain("最初の記事");

    await click(button(container, "再実行"));
    await until(() => bridge.turnRequests.length === 1);
    await until(() => stored.artifacts[body.id]?.includes("新しい本文") === true);
    await until(() => !bridge.locks.has(created.id));
    await until(() => container.querySelector(".dayline")?.textContent?.includes(body.name) === true);
    expect(container.querySelector(".composer-note")?.textContent ?? "").not.toContain("閲覧と元に戻す");
  });

  it("共通素材からの会話も対象工程だけを直し、記事の兄弟案を変更しない", async () => {
    const { bridge, flow, created, stored, body } = await articleProject();
    await bridge.createCandidate(rootRef(created.id), body.id, ledger(body.id), "artifact2", "# 別案の本文", {
      id: "duplicate2", kind: "save", at: "2026-10-16T01:10:00.000Z", stepId: body.id, stepName: "別案",
      candidateId: "candidate2", artifactId: "artifact2", version: null, result: "saved",
    });
    const shared = flow.steps[0]!;
    const original = stored.artifacts[body.id];
    const source = stored.transcript;
    bridge.chatScript = (request, _call, staged) => {
      expect(request.writable_artifact_id).toBe(shared.id);
      staged.artifacts[shared.id] = "# 共通素材だけの修正";
      staged.artifacts[body.id] = "最初の案への意図しない編集";
      staged.artifacts.artifact2 = "別案への意図しない編集";
      staged.artifacts[SOURCE_STEP_ID] = "原文への意図しない編集";
      return [done("共通素材を修正しました。")];
    };
    screen = await renderApp(bridge);
    await click(railItem(screen.container, shared.name));
    await send(screen.container, "表記を直して");
    await until(() => stored.artifacts[shared.id]?.includes("共通素材だけ") === true);
    expect(stored.artifacts[body.id]).toBe(original);
    expect(stored.artifacts.artifact2).toBe("# 別案の本文");
    expect(stored.transcript).toBe(source);
    expect(stored.versions[body.id]).toHaveLength(1);
    expect(stored.versions.artifact2).toHaveLength(1);
  });

  it("実行中の別案生成では空の案を作らず、処理の完了を案内する", async () => {
    const { bridge, stored, body } = await articleProject();
    let release!: () => void;
    bridge.turnGate = new Promise<void>((resolve) => { release = resolve; });
    bridge.turnScript = () => [{ type: "TextDelta", text: "作成中" }, done("# 再実行した本文")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, body.name));
    await rebuild(container);
    await until(() => bridge.turnRequests.length === 1);
    try {
      await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${body.name}の別案を作成"]`)!);
      await click(button(container.querySelector<HTMLElement>('.dlg[role="dialog"]')!, "生成する"));
      expect(container.querySelector(".failure-band .fb-msg")?.textContent).toContain("処理が終わってから別案");
      expect(stored.project.candidateSets).toBeUndefined();
      expect(bridge.turnRequests).toHaveLength(1);
    } finally {
      await act(async () => release());
    }
    await until(() => stored.versions[body.id]?.length === 2);
  });

  it("案件ロックが取れないときは生成候補を保存しない", async () => {
    const { bridge, created, stored, body } = await articleProject();
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(container.querySelector<HTMLButtonElement>(`button[aria-label="${body.name}の別案を作成"]`)!);
    await typeInto(container.querySelector<HTMLInputElement>("#candidate-name")!, "ロック中の案");
    await bridge.acquireRunLock(created.id);
    try {
      await click(button(container.querySelector<HTMLElement>('.dlg[role="dialog"]')!, "生成する"));
      await until(() => container.querySelector(".failure-band .fb-msg")?.textContent?.includes("実行中") ?? false);
      expect(stored.project.candidateSets).toBeUndefined();
      expect(bridge.turnRequests).toHaveLength(0);
    } finally {
      await bridge.releaseRunLock(created.id);
    }
  });

  it("複数案非対応の工程には追加入口を出さない", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "minutes-flow");
    bridge.flow = flow;
    const created = await bridge.createProject(textProject(flow), "会議本文", {
      id: "source-save", kind: "save", at: "2026-10-16T00:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved",
    }, []);
    await seedRun(bridge, created.id, flow.steps[0]!, "# 議事録");
    screen = await renderApp(bridge);
    expect(screen.container.querySelector(".candidate-add")).toBeNull();
  });
});
