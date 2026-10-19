// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  FLOW_TEMPLATES,
  ROOT_RECORDING_ID,
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  projectPages,
  type Flow,
  type Project,
  type TurnEvent,
} from "@niho/docs-core";
import { button, click, renderApp, typeInto, type Screen } from "./dom";
import { FakeBridge, done, rootRef } from "./fake-bridge";
import { openAudio, railCurrent, railItem, seedRun } from "./pages";

/** composer（#18722）: 「AIと作る」で同じ場所の文書ページを直し、新しい文書を作る（変更を見る・元に戻す・開く）。 */

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

const MEMO = "# 事前メモ\n\n- 質問を3つ\n";
const MEMO_EDITED = "# 事前メモ\n\n- 質問を4つ\n";

function project(flow: Flow): Project {
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

/** 文章から作った案件（工程 1 を実行済み）と、同じ場所の文書ページ「事前メモ」。`template` 0 は記事本文の案つき。 */
async function setup(options: { open: "step" | "memo" | "recording"; candidates?: boolean }) {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(FLOW_TEMPLATES[options.candidates ? 0 : 2]!, "flow-1");
  bridge.flow = flow;
  const created = await bridge.createProject(
    project(flow),
    "[00:00:08] 朝市に出して三年目です。\n",
    { id: "save-1", kind: "save", at: "2026-10-15T00:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" },
    [],
  );
  const step = flow.steps[options.candidates ? 2 : 0]!;
  await seedRun(bridge, created.id, step, "# 本文\n\n朝市に出して三年目。\n");
  if (options.candidates) {
    bridge.projects.get(created.id)!.project.candidateSets = {
      [step.id]: { stepId: step.id, order: ["candidateA"], items: { candidateA: { id: "candidateA", artifactId: step.id, name: "記事案A", createdAt: "" } } },
    };
  }
  const memo = await bridge.createPage(created.id, { kind: "doc", title: "事前メモ", createdAt: "2026-10-16T00:00:00.000Z" });
  await bridge.writePage(created.id, memo.id, MEMO);
  screen = await renderApp(bridge);
  const container = screen.container;
  if (options.open === "memo") await click(railItem(container, "事前メモ"));
  else if (options.open === "step") await click(railItem(container, step.name));
  // フォルダの音声は背景情報のページ（#18914）
  else await openAudio(container);
  return { bridge, flow, step, projectId: created.id, memoId: memo.id, container };
}

function tools(file: string, name: "Read" | "Edit" | "Write", index: number): TurnEvent[] {
  return [
    { type: "ToolUse", id: `toolu_${index}`, name, summary: file },
    { type: "ToolResult", id: `toolu_${index}`, name, ok: true },
  ];
}

async function send(container: HTMLElement, text: string) {
  await typeInto(container.querySelector('textarea[aria-label="直したいこと"]')!, text);
  await click(container.querySelector<HTMLButtonElement>('button[aria-label="送信"]')!);
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(condition()).toBe(true);
}

function chatText(container: HTMLElement): string {
  return container.querySelector(".chat")?.textContent ?? "";
}

/** 依頼の作業の行（畳んだ「作業 N 件」の中。工程の実行の記録の行は含めない）。 */
function workLines(container: HTMLElement): string {
  return [...container.querySelectorAll(".chat .turn .worklog-body")].map((item) => item.textContent ?? "").join("|");
}

/** 結果のカード（「〈名前〉を直しました」など）の中のボタン。 */
function cardButton(container: HTMLElement, card: string, label: string): HTMLButtonElement | null {
  const result = [...container.querySelectorAll<HTMLElement>(".chat .result")].find((item) => item.textContent?.includes(card));
  if (!result) throw new Error(`card not found: ${card}`);
  return [...result.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label) ?? null;
}

describe("AIと作る（composer）: 録音のページから", () => {
  it("同じ場所の文書を直し、新しい文書を作る。変更を見る・元に戻す・開くができる", async () => {
    const { bridge, step, projectId, memoId, container } = await setup({ open: "step" });
    bridge.chatScript = (_request, _call, staged) => {
      staged.pages[memoId] = MEMO_EDITED;
      staged.created["english.md"] = "# English version\n\nThree years at the morning market.\n";
      return [
        ...tools(`${memoId}.md`, "Read", 1),
        ...tools(`${memoId}.md`, "Edit", 2),
        ...tools("english.md", "Write", 3),
        done("事前メモを直し、英語版を作りました。"),
      ];
    };
    await send(container, "事前メモの質問を4つにして、英語版も作って");
    await until(() => chatText(container).includes("English versionを作りました"));

    // 作業場所: 同じ場所の文書ページを直せる形で写す（ほかの録音は無い）。システム側に文書の一覧
    const request = bridge.chatRequests[0]!.request;
    expect(request.composer).toEqual({ recording: true, pages: [memoId], references: [] });
    expect(request.system_prompt).toContain(`- 事前メモ: artifacts/pages/${memoId}.md`);
    expect(request.system_prompt).toContain("- 新しい文書: artifacts/new/");
    // 作業の行は文書の名前で読む（ファイル名を出さない）
    expect(workLines(container)).toContain("事前メモを読みました");
    expect(chatText(container)).toContain("事前メモを直しました");
    expect(await bridge.readPage(projectId, memoId)).toBe(MEMO_EDITED);
    // 成果物は書き換えていないので版は増えない
    expect(await bridge.readArtifact(rootRef(projectId), step.id)).toBe("# 本文\n\n朝市に出して三年目。\n");
    // 新しい文書は開いている録音のページの直後。画面は会話のまま（カードの「開く」で開く）
    const pages = projectPages(bridge.projects.get(projectId)!.project);
    expect(pages.map((page) => page.title || page.id)).toEqual([ROOT_RECORDING_ID, "English version", "事前メモ"]);
    expect(railCurrent(container)).toBe(step.name);

    await click(cardButton(container, "事前メモを直しました", "変更を見る")!);
    const dialog = container.querySelector(".diffdlg")!;
    expect(dialog.querySelector("h2")?.textContent).toContain("事前メモの変更");
    expect(dialog.querySelector("h2 small")?.textContent).toBe("直す前 → AI が直した後");
    expect(dialog.textContent).toContain("質問を4つ");
    await click(button(dialog as HTMLElement, "閉じる"));

    await click(cardButton(container, "事前メモを直しました", "元に戻す")!);
    await until(() => chatText(container).includes("事前メモを直す前の内容に戻しました"));
    expect(await bridge.readPage(projectId, memoId)).toBe(MEMO);
    expect(container.querySelector(".toast")?.textContent).toContain("事前メモを直す前の内容に戻しました");
    // 戻したことは会話に残る（開き直しても「元に戻す」を出さない）
    const saved = [...(await bridge.listConversations(rootRef(projectId)))][0]!;
    expect(saved.turns[0]!.pages?.find((change) => change.pageId === memoId)?.undone).toBe(true);
    expect(saved.turns[0]!.names).toEqual({ [`${memoId}.md`]: "事前メモ" });
    expect(cardButton(container, "事前メモを直す前の内容に戻しました", "元に戻す")).toBeNull();

    await click(cardButton(container, "English versionを作りました", "開く")!);
    await until(() => railCurrent(container) === "English version");
    await until(() => container.querySelector(".pbody .ProseMirror")?.textContent?.includes("Three years") ?? false);
  });

  it("止めた依頼では新しい文書を作らない（直した文書ページは反映し、元に戻せる）", async () => {
    const { bridge, projectId, memoId, container } = await setup({ open: "step" });
    let release!: () => void;
    bridge.chatGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bridge.chatScript = (_request, _call, staged) => {
      staged.pages[memoId] = MEMO_EDITED;
      staged.created["half.md"] = "# 途中\n";
      return [{ type: "TextDelta", text: "直しています" }, done("途中です。")];
    };
    await send(container, "事前メモを直して、別の版も作って");
    await until(() => container.querySelector('button[aria-label="停止"]') !== null);
    await click(container.querySelector('button[aria-label="停止"]')!);
    await act(async () => {
      release();
    });
    await until(() => !bridge.locks.has(projectId));
    await until(() => chatText(container).includes("最後まで終わらなかったため、新しい文書は作っていません。"));
    expect(chatText(container)).toContain("事前メモを直しました");
    expect(projectPages(bridge.projects.get(projectId)!.project)).toHaveLength(2);
    expect(await bridge.readPage(projectId, memoId)).toBe(MEMO_EDITED);
  });
});

describe("AIと作る（composer）: 文書ページから", () => {
  it("開いている文書を直すと本文を読み直す。送信中は移動・並べ替え・削除を止める", async () => {
    const { bridge, step, projectId, memoId, container } = await setup({ open: "memo" });
    let release!: () => void;
    bridge.chatGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bridge.chatScript = (_request, _call, staged) => {
      staged.pages[memoId] = MEMO_EDITED;
      return [...tools(`${ROOT_RECORDING_ID}.${step.id}.md`, "Read", 1), ...tools(`${memoId}.md`, "Edit", 2), done("質問を足しました。")];
    };
    await send(container, "発言の抽出を見て、このメモの質問を4つにして");
    await until(() => container.querySelector('button[aria-label="停止"]') !== null);
    // 文書ページの会話は録音の文書を写さず、録音はどれも読むだけ
    const request = bridge.chatRequests[0]!.request;
    expect(request.composer?.recording).toBe(false);
    expect(request.composer?.pages).toEqual([memoId]);
    expect(request.composer?.references).toEqual([
      { page_id: ROOT_RECORDING_ID, artifact_id: SOURCE_STEP_ID },
      { page_id: ROOT_RECORDING_ID, artifact_id: step.id },
    ]);
    expect(request.system_prompt).toContain("## 開いているページ\n\n事前メモ（");

    await click(container.querySelector('button[aria-label="その他"]')!);
    const menuItems = () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(menuItems().find((item) => item.textContent?.trim() === "削除")?.disabled).toBe(true);
    expect(menuItems().find((item) => item.textContent?.trim() === "上へ移動")?.disabled).toBe(true);
    await click(menuItems().find((item) => item.textContent?.includes("フォルダへ移す"))!);
    expect(menuItems().find((item) => item.textContent?.trim() === "ホーム")?.disabled).toBe(true);
    expect(container.textContent).toContain("工程の実行か「AIと作る」の依頼が終わってから移動できます。");

    await act(async () => {
      release();
    });
    await until(() => !bridge.locks.has(projectId));
    await until(() => container.querySelector(".pbody .ProseMirror")?.textContent?.includes("質問を4つ") ?? false);
    expect(await bridge.readPage(projectId, memoId)).toBe(MEMO_EDITED);
    // 開いているページのカードには「開く」を出さない。読んだ録音の文書は「〈録音〉 / 〈工程〉」の名前で出す
    expect(cardButton(container, "事前メモを直しました", "開く")).toBeNull();
    expect(workLines(container)).toContain(` / ${step.name}を読みました`);
  });
});

describe("AIと作る（composer）: 複数案で案を開いていない録音のページ", () => {
  it("録音の文書は読むだけにして、新しい文書は作れる（記事本文は書き換えない）", async () => {
    const { bridge, step, projectId, container } = await setup({ open: "recording", candidates: true });
    bridge.chatScript = (_request, _call, staged) => {
      staged.artifacts[step.id] = "# 書き換えてはいけない\n";
      staged.created["english.md"] = "# 記事案英訳ver\n\nThree years.\n";
      return [done("英訳を作りました。")];
    };
    await send(container, "記事案Aを英訳して、記事案英訳verとして作って");
    await until(() => chatText(container).includes("記事案英訳verを作りました"));
    const request = bridge.chatRequests[0]!.request;
    expect(request.composer?.recording_writable).toBe(false);
    expect(request.system_prompt).toContain("## 読むだけの録音");
    expect(request.system_prompt).toContain("「記事本文を直すときは、左の案を開いてください。」と伝える");
    expect(await bridge.readArtifact(rootRef(projectId), step.id)).toBe("# 本文\n\n朝市に出して三年目。\n");
    expect(projectPages(bridge.projects.get(projectId)!.project).map((page) => page.title)).toEqual(["", "記事案英訳ver", "事前メモ"]);
  });
});
