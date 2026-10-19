// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  reasonMessage,
  type Flow,
  type Project,
  type TurnEvent,
} from "@niho/docs-core";
import { button, click, renderApp, type Screen } from "./dom";
import { FakeBridge, done } from "./fake-bridge";
import { hasOutputRow, railChildren } from "./pages";
import { THREE_STEP_TEMPLATE } from "./three-step-flow";

/**
 * S1-A の DoD「上限到達・未ログイン・未導入・停止・時間切れが画面に出る」: 工程の実行がそれぞれの理由で終わったとき、会話の欄の
 * 実行の行と録音のページの実行の帯の下に理由の文が出て、版は増えず、成果物は子ページにならない（偽の CLI の代わりに fake-bridge の台本）。
 */

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

const STOPPED = "止めました。途中までを残しています。";

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

async function bridgeWithTextProject() {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(THREE_STEP_TEMPLATE, "flow-1");
  bridge.flow = flow;
  const project = await bridge.createProject(textProject(flow), "[00:00:08] 朝市に出して三年目です。\n", {
    id: "save-1",
    kind: "save",
    at: "2026-10-15T00:00:00.000Z",
    stepId: SOURCE_STEP_ID,
    stepName: "文章",
    version: null,
    result: "saved",
  }, []);
  return { bridge, flow, stored: bridge.projects.get(project.id)! };
}

type Case = {
  name: string;
  events: TurnEvent[];
  /** 会話の欄の実行の行（失敗は .op.fail、停止は .op.stopped）。 */
  op: ".op.fail" | ".op.stopped";
  /** 録音のページの実行の帯の下（失敗は .err、停止は .help）。 */
  center: ".runnotice.err" | ".runnotice.help";
  message: string;
  result: "failed" | "stopped";
  reasonCode?: string;
};

const error = (code: "UsageLimitReached" | "CliLoginRequired" | "NotConfigured" | "Timeout"): TurnEvent => ({
  type: "Error",
  reason_code: code,
  message: reasonMessage(code),
});

const CASES: Case[] = [
  {
    name: "上限到達（UsageLimitReached）",
    events: [error("UsageLimitReached")],
    op: ".op.fail",
    center: ".runnotice.err",
    message: reasonMessage("UsageLimitReached"),
    result: "failed",
    reasonCode: "UsageLimitReached",
  },
  {
    name: "未ログイン（CliLoginRequired）",
    events: [error("CliLoginRequired")],
    op: ".op.fail",
    center: ".runnotice.err",
    message: reasonMessage("CliLoginRequired"),
    result: "failed",
    reasonCode: "CliLoginRequired",
  },
  {
    name: "未導入（NotConfigured）",
    events: [error("NotConfigured")],
    op: ".op.fail",
    center: ".runnotice.err",
    message: reasonMessage("NotConfigured"),
    result: "failed",
    reasonCode: "NotConfigured",
  },
  {
    name: "停止（Stopped）",
    events: [{ type: "TextDelta", text: "書きかけ" }, done("書きかけ", "Stopped")],
    op: ".op.stopped",
    center: ".runnotice.help",
    message: STOPPED,
    result: "stopped",
  },
  {
    name: "時間切れ（Timeout）",
    events: [{ type: "TextDelta", text: "書きかけ" }, error("Timeout")],
    op: ".op.fail",
    center: ".runnotice.err",
    message: reasonMessage("Timeout"),
    result: "failed",
    reasonCode: "Timeout",
  },
];

describe("工程の実行が終わった理由を画面に出す", () => {
  it.each(CASES)("$name: 会話の実行の行と実行の帯の下に理由を出し、版を足さず、成果物を子ページにしない", async (item) => {
    const { bridge, flow, stored } = await bridgeWithTextProject();
    const stepId = flow.steps[0]!.id;
    bridge.turnScript = () => item.events;
    screen = await renderApp(bridge);
    const { container } = screen;
    await click(button(container, "続きを作成"));

    // 会話の欄の実行の行（最初の工程で止まり、後ろの工程は実行しない）
    expect(bridge.turnRequests).toHaveLength(1);
    expect(container.querySelector(".step-msg")?.textContent).toContain("▶ 発言の抽出を実行");
    expect(container.querySelector(item.op)?.textContent).toBe(item.message);
    // 録音のページの実行の帯の下
    expect(container.querySelector(item.center)?.textContent).toBe(item.message);
    // 版は増えず、記録には理由が残る
    expect(stored.artifacts[stepId]).toBeUndefined();
    expect(stored.versions[stepId]).toBeUndefined();
    const record = stored.runs.at(-1)!;
    expect(record).toMatchObject({ kind: "run", stepId, result: item.result, message: item.message, version: null });
    if (item.reasonCode) expect(record.reasonCode).toBe(item.reasonCode);
    // 成果物の行: 実行中でも済でもないので出さない（子ページにもならない）。実行が終わったので「止める」は出ない
    expect(hasOutputRow(container, "発言の抽出")).toBe(false);
    expect(railChildren(container)).toEqual(["文章"]);
    expect(container.querySelector(".runbar .btn.stop")).toBeNull();
    expect(button(container, "続きを作成").disabled).toBe(false);
  });
});
