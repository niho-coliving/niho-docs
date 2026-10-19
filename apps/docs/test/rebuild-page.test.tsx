// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/react";
import {
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  type Flow,
  type Project,
  type Recording,
} from "@niho/docs-core";
import { formatDateTime } from "../src/lib/format";
import { button, click, renderApp, type Screen } from "./dom";
import { FakeBridge, done, fakeStatus, rootRef, type StoredRecordingData } from "./fake-bridge";
import { outputRow, railItem, rebuild, rebuildItem, seedRun, until } from "./pages";
import { THREE_STEP_TEMPLATE } from "./three-step-flow";

/**
 * 録音から作ったページを文書のページと同じ見え方・操作にする（#18915）: メタ行・レールの行・タイトルバーの ⋯ の「作り直す」・
 * 元にした内容が変わった知らせの 1 行・作り直した後のトーストの「元に戻す」。
 */

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

const SOURCE_AT = "2026-10-15T00:00:00.000Z";
const STEP_AT = "2026-10-15T00:01:00.000Z";
const FIRST = "# 抽出 1\n";

function textProject(flow: Flow): Project {
  return {
    version: 1,
    id: "",
    name: "朝市 インタビュー",
    createdAt: SOURCE_AT,
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    info: { speakers: "2", language: "ja", terms: [], background: "" },
    source: { kind: "text" },
  };
}

/** 文章から作った案件。`seed` なら工程 2（発言の抽出）を版 1 にしておく。 */
async function textRecording(seed = true) {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(THREE_STEP_TEMPLATE, "flow-1");
  bridge.flow = flow;
  const created = await bridge.createProject(
    textProject(flow),
    "[00:00:08] 朝市に出して三年目です。\n",
    { id: "save-1", kind: "save", at: SOURCE_AT, stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" },
    [],
  );
  const stored = bridge.projects.get(created.id)!;
  const stepId = flow.steps[0]!.id;
  if (seed) await seedRun(bridge, created.id, flow.steps[0]!, FIRST, undefined, STEP_AT);
  return { bridge, flow, created, stored, stepId };
}

function metaInfo(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".pmeta .work-meta-info")!;
}

function toast(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".toast");
}

function failure(container: HTMLElement): string | null {
  return container.querySelector(".failure-band .fb-msg")?.textContent ?? null;
}

function artifactEditor(container: HTMLElement): Editor {
  const element = container.querySelector(".pbody .ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  if (!element?.editor) throw new Error("artifact editor not found");
  return element.editor;
}

/** 版の記録に、Mac ごとに違う versionPath を付ける（同じ番号の版が 2 台で別々に保存された状況を作る）。 */
function stampVersionPaths(stored: Pick<StoredRecordingData, "runs">, stepId: string, suffix: string) {
  for (const row of stored.runs) {
    if (row.stepId === stepId && typeof row.version === "number" && !row.versionPath) row.versionPath = `recordings/_/versions/${stepId}/v${row.version}-${suffix}.md`;
  }
}

/** レールの、録音から作ったページの行（フォルダの録音は行を出さず、フォルダの直下に文書と同じ深さで並ぶ。#18914）。 */
function railChildRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".rail .trow.out .ti")];
}

describe("録音から作ったページの見え方（#18915）", () => {
  it("メタ行は「〈元〉から · 日時 · 保存の状態」だけ（元はフォルダの中ならフォルダ）。工程の番号・字数・書いた AI・版・再実行は出さない", async () => {
    const { bridge } = await textRecording();
    screen = await renderApp(bridge);
    const { container } = screen;

    // 工程のページ
    await click(railItem(container, "発言の抽出"));
    const info = metaInfo(container);
    const saveState = info.querySelector(".savest");
    expect(saveState).not.toBeNull();
    // フォルダの中の工程のページの元はフォルダ（録音のページは無い。#18914）
    expect(info.textContent).toBe(`朝市 インタビュー から·${formatDateTime(STEP_AT)}${saveState!.textContent}`);
    expect(info.querySelector(".pill")).toBeNull();
    expect(info.querySelector("button")).toBeNull();
    expect(info.textContent).not.toMatch(/工程|字|版|Claude/);

    // 文章のページ（素材の版の日時）。文章は作り直せないので ⋯ の「作り直す」は押せない
    await click(railItem(container, "文章"));
    await click(outputRow(container, "文章"));
    const sourceInfo = metaInfo(container);
    expect(sourceInfo.textContent).toBe(`朝市 インタビュー から·${formatDateTime(SOURCE_AT)}${sourceInfo.querySelector(".savest")!.textContent}`);
    expect((await rebuildItem(container)).disabled).toBe(true);
  });

  it("ホームの録音（以前のデータ）から作ったページの元は、その録音（「〈録音〉 から」）", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(THREE_STEP_TEMPLATE, "flow-1");
    bridge.flow = flow;
    const recording: Recording = {
      version: 1,
      id: "",
      createdAt: SOURCE_AT,
      flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
      speakers: "auto",
      language: "ja",
      refs: [],
      source: { kind: "text" },
    };
    const page = await bridge.createPage(null, { kind: "rec", title: "外の録音", createdAt: SOURCE_AT, recording });
    const step = flow.steps[0]!;
    await bridge.saveArtifact({ projectId: null, recordingId: page.recordingId ?? page.id }, step.id, false, FIRST, {
      id: "run-outside",
      kind: "run",
      at: STEP_AT,
      stepId: step.id,
      stepName: step.name,
      version: null,
      result: "saved",
      provider: "claude",
      model: "claude-sonnet-4-6",
      effort: "high",
      profile: "標準",
    });
    screen = await renderApp(bridge);
    const { container } = screen;
    // 録音のページの列の見出しは「この録音から作ったページ」（「成果物」「前提変更」は出さない）
    await click(railItem(container, "外の録音"));
    expect([...container.querySelectorAll(".pg .sec")].map((item) => item.textContent)).toContain("この録音から作ったページ");
    expect(container.querySelector(".orow .pill")).toBeNull();
    expect(container.querySelector(".pg")?.textContent).not.toMatch(/成果物|前提変更/);
    await click(railItem(container, step.name));
    const info = metaInfo(container);
    expect(info.textContent).toBe(`外の録音 から·${formatDateTime(STEP_AT)}${info.querySelector(".savest")!.textContent}`);
  });

  it("レールの子ページの行は数字でなく文書の印。並びは工程の順のまま", async () => {
    const { bridge } = await textRecording();
    screen = await renderApp(bridge);
    const rows = railChildRows(screen.container);
    expect(rows.map((row) => row.textContent)).toEqual(["文章", "発言の抽出"]);
    for (const row of rows) {
      expect(row.querySelector(".n")).toBeNull();
      expect(row.querySelector(".ic svg")).not.toBeNull();
      expect(row.textContent).not.toMatch(/\d/);
    }
  });

  it("⋯ は「作り直す」だけで、押すとその工程を作り直す。AI にログインしていなければ押せない", async () => {
    const { bridge, stored, stepId } = await textRecording();
    bridge.turnScript = () => [done("# 抽出 2")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "発言の抽出"));
    await rebuildItem(container);
    expect([...container.querySelectorAll('.window-titlebar .pagemenu [role="menuitem"]')].map((item) => item.textContent)).toEqual([
      "検索 ⌘F",
      "書式を表示",
      "書き出し ›",
      "作り直す",
    ]);
    await rebuild(container);
    await until(() => stored.versions[stepId]?.length === 2);
    expect(bridge.turnRequests).toHaveLength(1);
    expect(stored.versions[stepId]).toEqual([FIRST, "# 抽出 2\n"]);

    screen.unmount();
    bridge.claude = fakeStatus("ClaudeCode", { authenticated: false, login_method: null, reason: "auth_required" });
    screen = await renderApp(bridge);
    await click(railItem(screen.container, "発言の抽出"));
    await until(() => screen!.container.querySelector(".runbar .note.setup") !== null);
    expect((await rebuildItem(screen.container)).disabled).toBe(true);
  });
});

describe("作り直した後の「元に戻す」（#18915）", () => {
  it("作り直すと「作り直しました」と「元に戻す」を出し、押すと前の版の中身を新しい版にして「元に戻しました」と出す", async () => {
    const { bridge, stored, stepId } = await textRecording();
    bridge.turnScript = () => [done("# 抽出 2")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "発言の抽出"));
    await rebuild(container);
    await until(() => toast(container)?.textContent === "作り直しました元に戻す");
    expect(stored.versions[stepId]).toEqual([FIRST, "# 抽出 2\n"]);
    await until(() => artifactEditor(container).getText().includes("抽出 2"));

    await click(button(toast(container)!, "元に戻す"));
    await until(() => stored.versions[stepId]?.length === 3);
    expect(stored.versions[stepId]).toEqual([FIRST, "# 抽出 2\n", FIRST]);
    expect(stored.artifacts[stepId]).toBe(FIRST);
    expect(stored.runs.at(-1)).toMatchObject({ kind: "save", stepId, version: 3, restoredFrom: 1, result: "saved" });
    await until(() => toast(container)?.textContent === "元に戻しました");
    expect(toast(container)?.querySelector("button")).toBeNull();
    await until(() => artifactEditor(container).getText().includes("抽出 1"));
    expect(failure(container)).toBeNull();
    expect(bridge.locks.size).toBe(0);
  });

  it("作り直しの後に版が増えていたら元に戻さず、理由を帯に出す（トーストには出さない）", async () => {
    const { bridge, created, stored, stepId } = await textRecording();
    bridge.turnScript = () => [done("# 抽出 2")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "発言の抽出"));
    await rebuild(container);
    await until(() => toast(container)?.textContent === "作り直しました元に戻す");
    // 別の Mac・AIと作る などで、その後に版が増えた
    await bridge.saveArtifact(rootRef(created.id), stepId, false, "# 後から直した本文\n", {
      id: "save-later", kind: "save", at: "2026-10-15T00:05:00.000Z", stepId, stepName: "発言の抽出", version: null, result: "saved",
    });
    await click(button(toast(container)!, "元に戻す"));
    await until(() => failure(container) === "発言の抽出はその後に変わっているため、元に戻せません。");
    expect(stored.versions[stepId]).toEqual([FIRST, "# 抽出 2\n", "# 後から直した本文\n"]);
    expect(toast(container)).toBeNull();
    expect(bridge.locks.size).toBe(0);
  });

  it("作り直す直前まで編集していた内容（自動の版）へ戻す。それより古い確定版へは戻さない", async () => {
    const { bridge, stored, stepId } = await textRecording();
    bridge.turnScript = () => [done("# 抽出 2")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "発言の抽出"));
    await until(() => artifactEditor(container).isEditable && artifactEditor(container).getText().includes("抽出 1"));
    await act(async () => {
      artifactEditor(container).commands.insertContent("直前の編集");
    });
    await until(() => bridge.artifactDraftWrites.some((write) => write.markdown.includes("直前の編集")));
    await rebuild(container);
    await until(() => toast(container)?.textContent === "作り直しました元に戻す");
    // 版 1 = 確定版、版 2 = 作り直す直前の書きかけ（自動の版）、版 3 = 作り直した結果
    const [first, edited, rebuilt] = stored.versions[stepId]!;
    expect(first).toBe(FIRST);
    expect(edited).toContain("直前の編集");
    expect(rebuilt).toBe("# 抽出 2\n");

    await click(button(toast(container)!, "元に戻す"));
    await until(() => stored.versions[stepId]?.length === 4);
    expect(stored.versions[stepId]![3]).toBe(edited);
    expect(stored.artifacts[stepId]).toBe(edited);
    expect(stored.runs.at(-1)).toMatchObject({ kind: "save", stepId, version: 4, restoredFrom: 2 });
    await until(() => toast(container)?.textContent === "元に戻しました");
    expect(failure(container)).toBeNull();
  });

  it("別の Mac の同じ番号の版が最新になっていたら、番号が同じでも元に戻さない（版は versionPath で見分ける）", async () => {
    const { bridge, stored, stepId } = await textRecording();
    stampVersionPaths(stored, stepId, "mac-a");
    const save = bridge.saveArtifact.bind(bridge);
    bridge.saveArtifact = async (...args) => {
      const version = await save(...args);
      stampVersionPaths(stored, stepId, "mac-a");
      return version;
    };
    bridge.turnScript = () => [done("# 抽出 2")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "発言の抽出"));
    await rebuild(container);
    await until(() => toast(container)?.textContent === "作り直しました元に戻す");
    // 別の Mac が同じ番号（版 2）を別の版として保存し、同期でそちらが最新の行になった
    const latest = [...stored.runs].reverse().find((row) => row.stepId === stepId && row.version === 2)!;
    latest.versionPath = `recordings/_/versions/${stepId}/v2-mac-b.md`;

    await click(button(toast(container)!, "元に戻す"));
    await until(() => failure(container) === "発言の抽出はその後に変わっているため、元に戻せません。");
    expect(stored.versions[stepId]).toEqual([FIRST, "# 抽出 2\n"]);
    expect(toast(container)).toBeNull();
    expect(bridge.locks.size).toBe(0);
  });

  it("戻す先の版は番号でなく versionPath で開く", async () => {
    const { bridge, stored, stepId } = await textRecording();
    stampVersionPaths(stored, stepId, "mac-a");
    const save = bridge.saveArtifact.bind(bridge);
    bridge.saveArtifact = async (...args) => {
      const version = await save(...args);
      stampVersionPaths(stored, stepId, "mac-a");
      return version;
    };
    bridge.turnScript = () => [done("# 抽出 2")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "発言の抽出"));
    await rebuild(container);
    await until(() => toast(container)?.textContent === "作り直しました元に戻す");

    await click(button(toast(container)!, "元に戻す"));
    await until(() => stored.versions[stepId]?.length === 3);
    expect(bridge.versionReads).toContainEqual({ stepId, version: 1, versionPath: `recordings/_/versions/${stepId}/v1-mac-a.md` });
    expect(stored.versions[stepId]![2]).toBe(FIRST);
  });

  it("作り直した後に直していれば元に戻さず、理由を帯に出す", async () => {
    const { bridge, stored, stepId } = await textRecording();
    bridge.turnScript = () => [done("# 抽出 2")];
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(railItem(container, "発言の抽出"));
    await rebuild(container);
    await until(() => toast(container)?.textContent === "作り直しました元に戻す");
    await until(() => artifactEditor(container).isEditable && artifactEditor(container).getText().includes("抽出 2"));
    await act(async () => {
      artifactEditor(container).commands.insertContent("書きかけ");
    });
    await click(button(toast(container)!, "元に戻す"));
    expect(failure(container)).toBe("発言の抽出は作り直した後に編集されているため、元に戻せません。");
    expect(stored.versions[stepId]).toEqual([FIRST, "# 抽出 2\n"]);
  });
});

describe("元にした内容が変わった知らせ（#18915）", () => {
  it("前の工程を作り直すと、後ろのページの本文の上に 1 行と「作り直す」を出し、押すとその工程を作り直して消える", async () => {
    const { bridge, flow, stored } = await textRecording(false);
    let count = 0;
    bridge.turnScript = () => [done(`成果物 ${++count}`)];
    screen = await renderApp(bridge);
    const { container } = screen;
    // 録音のページの「工程を実行」は今までどおり（作り直しのトーストは出さない）
    await click(button(container, "続きを作成"));
    await until(() => flow.steps.every((step) => stored.versions[step.id]?.length === 1));
    expect(toast(container)?.textContent ?? "").not.toContain("作り直しました");

    const [extract, insight] = flow.steps;
    await click(railItem(container, extract!.name));
    expect(container.querySelector(".cloud-banner")).toBeNull();
    await rebuild(container);
    await until(() => stored.versions[extract!.id]?.length === 2);

    await click(railItem(container, insight!.name));
    const line = container.querySelector<HTMLElement>(".cloud-banner")!;
    expect(line.getAttribute("role")).toBe("status");
    expect(line.textContent).toBe("元にしたページが変わりました。作り直す");
    // 「前提変更」の印は出さない
    expect(container.querySelector(".pmeta .pill")).toBeNull();
    await click(button(line, "作り直す"));
    await until(() => stored.versions[insight!.id]?.length === 2);
    await until(() => container.querySelector(".cloud-banner") === null);
    await until(() => toast(container)?.textContent === "作り直しました元に戻す");
    // 作り直した版も、元にした内容（basis）を持つ。元に戻すと前の版の basis を写す
    const before = stored.runs.find((run) => run.stepId === insight!.id && run.version === 1)!;
    await click(button(toast(container)!, "元に戻す"));
    await until(() => stored.versions[insight!.id]?.length === 3);
    expect(stored.runs.at(-1)).toMatchObject({ kind: "save", stepId: insight!.id, restoredFrom: 1, basis: before.basis });
    // 前の版に戻したので、また知らせる
    await until(() => container.querySelector(".cloud-banner")?.textContent === "元にしたページが変わりました。作り直す");
  });
});
