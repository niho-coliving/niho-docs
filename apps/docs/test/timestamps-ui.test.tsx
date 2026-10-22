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
  type Flow,
  type Project,
  type RunRecord,
} from "@niho/docs-core";
import { button, click, renderApp, typeInto, type Screen } from "./dom";
import { FakeBridge } from "./fake-bridge";
import { exportFromMenu, outputRow, pageMenuAction } from "./pages";
import { defaultSettings } from "../src/lib/settings";

let screen: Screen | null = null;
afterEach(() => {
  screen?.unmount();
  screen = null;
});

function projectWithSource(flow: Flow, kind: "audio" | "text"): Project {
  return {
    version: 1,
    id: "",
    name: "運営会議",
    createdAt: "2026-10-16T00:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    info: { speakers: "2", language: "ja", terms: [], background: "" },
    source: kind === "audio" ? { kind: "audio", audio: [] } : { kind: "text" },
  };
}

const sourceRun: RunRecord = {
  id: "source-1",
  kind: "save",
  at: "2026-10-16T00:10:00.000Z",
  stepId: SOURCE_STEP_ID,
  stepName: "文字起こし",
  version: null,
  result: "saved",
};

async function audioBridge(markdown = "[00:00:12] 話者1: 12:30 に開始。\n") {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
  bridge.flow = flow;
  const project = await bridge.createProject(projectWithSource(flow, "audio"), markdown, sourceRun, ["/a/meeting.m4a"]);
  return { bridge, project };
}

async function openTranscript(bridge: FakeBridge) {
  screen = await renderApp(bridge);
  await click(outputRow(screen.container, "文字起こし"));
  return screen.container;
}

describe("文字起こしのタイムスタンプ表示", () => {
  it("メタ行の右端は切替だけで、非表示のまま ⋯ の検索・全件置換・取り消しを使っても時刻を保つ", async () => {
    const { bridge } = await audioBridge("[00:00:12] 話者1: 開始。\n\n[00:00:24] 話者2: 開始。\n");
    const container = await openTranscript(bridge);
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    // 検索・書式の入口はタイトルバーの ⋯（メタ行に 🔍・Aa を置かない。owner 2026-10-18・#18941）
    expect(container.querySelector(".pmeta .et-icon, .pmeta button[aria-label=\"検索を開く\"]")).toBeNull();
    expect(toggle.closest(".work-meta-actions")).not.toBeNull();
    await pageMenuAction(container, "検索");
    await typeInto(container.querySelector('input[aria-label="検索語"]')!, "開始");
    expect(container.querySelector(".et-count")?.textContent).toContain("2件");
    await click(button(container, "置換…"));
    await typeInto(container.querySelector('input[aria-label="置換後の文字"]')!, "出発");
    await click(button(container, "すべて置換"));
    expect(container.querySelector(".doc")?.textContent).toContain("出発");
    await click(button(container, "元に戻す"));
    expect(container.querySelector(".doc")?.textContent).toContain("開始");
    await click(button(container, "すべて置換"));
    await click(toggle);
    await exportFromMenu(container, "コピー");
    expect(bridge.copied.at(-1)).toBe("[00:00:12] 話者1: 出発。\n\n[00:00:24] 話者2: 出発。\n");
  });

  it("先頭が0秒でもページを開いた直後はどの段落も選択しない", async () => {
    const { bridge } = await audioBridge("[00:00:00] 先頭\n\n[00:00:12] 続き\n");
    const container = await openTranscript(bridge);
    expect(container.querySelectorAll(".transcript-timed-paragraph")).toHaveLength(2);
    expect(container.querySelector(".transcript-playback-current")).toBeNull();
  });

  it("既定 OFF は表示・コピー・.md から接頭辞を外し、toggle だけで draft/版を増やさない", async () => {
    const { bridge, project } = await audioBridge();
    const stored = bridge.projects.get(project.id)!;
    const beforeVersions = stored.versions[SOURCE_STEP_ID]!.length;
    const container = await openTranscript(bridge);
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("タイムスタンプを表示にする");
    expect(container.querySelector(".doc")?.classList.contains("timestamps-off")).toBe(true);
    // 保存のボタンは置かない（#18912）
    expect([...container.querySelectorAll("button")].some((element) => element.textContent?.includes("版を保存"))).toBe(false);

    await exportFromMenu(container, "コピー");
    expect(bridge.copied.at(-1)).toBe("話者1: 12:30 に開始。\n");
    await exportFromMenu(container, ".md で保存");
    expect(bridge.exportedMarkdowns.at(-1)).toBe("話者1: 12:30 に開始。\n");

    await click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(bridge.settings).toMatchObject({ transcription: { language: "ja", showTimestamps: true } });
    expect(bridge.artifactDraftWrites).toHaveLength(0);
    expect(stored.versions[SOURCE_STEP_ID]).toHaveLength(beforeVersions);
    await exportFromMenu(container, "コピー");
    expect(bridge.copied.at(-1)).toBe("[00:00:12] 話者1: 12:30 に開始。\n");
    await exportFromMenu(container, ".md で保存");
    expect(bridge.exportedMarkdowns.at(-1)).toBe("[00:00:12] 話者1: 12:30 に開始。\n");
    // 切り替えは利用者の編集ではない（閉じても版にしない）
    await act(async () => {
      await bridge.requestClose();
    });
    expect(bridge.artifactDraftWrites).toHaveLength(0);
    expect(stored.versions[SOURCE_STEP_ID]).toHaveLength(beforeVersions);
  });

  it("true を復元し、古い版にも同じ表示選択を適用する", async () => {
    const { bridge, project } = await audioBridge("[00:00:12] 版1\n");
    bridge.settings = { ...defaultSettings(), transcription: { language: "ja", showTimestamps: true } };
    await bridge.saveArtifact(
      { projectId: project.id, recordingId: ROOT_RECORDING_ID },
      SOURCE_STEP_ID,
      true,
      "[00:00:24] 版2\n",
      { ...sourceRun, id: "source-2", at: "2026-10-16T00:20:00.000Z" },
    );
    const container = await openTranscript(bridge);
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    await click(container.querySelector('[aria-label="履歴"]')!);
    await click([...container.querySelectorAll(".hrow")][1]!);
    expect(container.querySelector(".doc")?.textContent).toContain("[00:00:12]");
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("文章から作った source は見かけが時刻でも対象外", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    bridge.flow = flow;
    await bridge.createProject(projectWithSource(flow, "text"), "[00:00:12] メモ\n", { ...sourceRun, stepName: "文章" }, []);
    screen = await renderApp(bridge);
    await click(outputRow(screen.container, "文章"));
    expect(screen.container.querySelector('[role="switch"]')).toBeNull();
  });

  it("設定保存に失敗したら通知して OFF に戻し、ほかの設定を保つ", async () => {
    const { bridge } = await audioBridge();
    const before = { ...defaultSettings(), docsRoot: "/Users/test/Documents/Other", transcription: { language: "en" as const, showTimestamps: false } };
    bridge.settings = before;
    bridge.saveSettings = async () => {
      throw { code: "write_failed", message: "設定を書けませんでした。" };
    };
    const container = await openTranscript(bridge);
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector(".failure-band .fb-msg")?.textContent).toBe("設定を書けませんでした。");
    expect(bridge.settings).toEqual(before);
  });

  it("連続した切替の保存が両方失敗したら最後に保存できた OFF へ戻す", async () => {
    const { bridge } = await audioBridge();
    const before = defaultSettings();
    bridge.settings = before;
    const pending: Array<{ reject: (error: unknown) => void }> = [];
    const saves: unknown[] = [];
    bridge.saveSettings = async (next) => {
      saves.push(next);
      await new Promise<void>((_resolve, reject) => pending.push({ reject }));
    };
    const container = await openTranscript(bridge);
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;

    await click(toggle);
    await click(toggle);
    expect(saves).toHaveLength(1);
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      pending[0]!.reject({ code: "write_failed", message: "設定を書けませんでした。" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(saves).toHaveLength(2);
    await act(async () => {
      pending[1]!.reject({ code: "write_failed", message: "設定を書けませんでした。" });
      await Promise.resolve();
    });

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(bridge.settings).toEqual(before);
  });
});
