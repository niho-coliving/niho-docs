// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  FLOW_TEMPLATES,
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  type Flow,
  type Project,
  type Recording,
} from "@niho/docs-core";
import { button, click, renderApp, type Screen } from "./dom";
import { FakeBridge, done } from "./fake-bridge";
import { openAudio, outputRow, until } from "./pages";
import { defaultSettings } from "../src/lib/settings";
import type { PersonalOpenRequest } from "../src/lib/bridge";

let screen: Screen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
});

const SPEECH_READY = { found: true, fake: false, available: true, needsDownload: false, engine: "apple", error: null, notice: null, diarization: { state: "ready", detail: null } } as const;

function transcriptLines(text: string) {
  return [{ jsonl: `{"type":"segment","start":1,"end":3,"text":"${text}"}\n`, durationSec: 30 }];
}

function newRecording(flow: Flow): Recording {
  return {
    version: 1,
    id: "",
    createdAt: "2026-10-19T01:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    source: { kind: "audio", audio: [{ file: "a1.m4a", hash: "0".repeat(64), name: "朝市.m4a", durationSec: 30 }] },
    speakers: "auto",
    language: "ja",
    refs: [],
  };
}

/** 文字起こしと続きの工程まで作った録音（最初の文字起こしは この Mac）。 */
async function transcribedRecording() {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
  bridge.flow = flow;
  bridge.settings = { ...defaultSettings(), personalExecution: { continuation: "this_pc" } };
  const project: Project = { version: 1, id: "", name: "朝市の取材", createdAt: "2026-10-19T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] };
  const created = await bridge.createProject(project, null, null, []);
  const entry = await bridge.createPage(created.id, { kind: "rec", title: "朝市", createdAt: "2026-10-19T01:00:00.000Z", recording: newRecording(flow) });
  bridge.speechStatus = async () => SPEECH_READY;
  bridge.transcribeResult = transcriptLines("最初の聞き取り");
  bridge.turnScript = (request) => [done(`${request.model} の成果物`, "EndTurn", "s1", request.model)];
  const stored = bridge.recording(created.id, entry.id);
  const rendered = await renderApp(bridge);
  await openAudio(rendered.container, "朝市の取材");
  await click(button(rendered.container, "文書作成を開始"));
  await until(() => (stored.versions[flow.steps.at(-1)!.id]?.length ?? 0) === 1);
  await until(() => bridge.locks.size === 0);
  return { bridge, flow, stored, rendered };
}

function addButton(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('.rail button[aria-label="文字起こしを追加"]');
  if (!found) throw new Error("文字起こしの ＋ がありません");
  return found;
}

function engineItems(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".rail .pop .mi.source-engine")];
}

function candidateRows(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".rail .ti.candidate")].map((row) => row.textContent ?? "");
}

function openedRequests(bridge: FakeBridge): PersonalOpenRequest[] {
  return bridge.personalCalls.filter((call) => call.name === "personalOpen").map((call) => call.args[0] as PersonalOpenRequest);
}

describe("文字起こしの別案（#19108）", () => {
  it("＋ からエンジンを選ぶと、その案のページを開いて文字起こしだけを作り、最初の文字起こしと後工程に使う指定は変えない", async () => {
    const setup = await transcribedRecording();
    screen = setup.rendered;
    const { container } = screen;
    const { bridge, stored } = setup;

    await click(addButton(container));
    const items = engineItems(container);
    expect(items.map((item) => item.textContent)).toEqual([
      "Gemini（サブスクリプション）サブスクリプションで登録すると使えます",
      "Gemini（API キー）API キーで登録すると使えます",
      "この Mac",
      "DeepgramAPI キーで登録すると使えます",
    ]);
    expect(items.map((item) => item.disabled)).toEqual([true, true, false, true]);
    expect(container.querySelector(".rail .pop")?.textContent).toContain("今の文字起こしと、後工程に使う文字起こしは変わりません。");

    bridge.transcribeResult = transcriptLines("この Mac の二度目の聞き取り");
    await click(items[2]!);
    await until(() => Object.keys(stored.recording.candidateSets?.[SOURCE_STEP_ID]?.items ?? {}).length === 2);
    const set = stored.recording.candidateSets![SOURCE_STEP_ID]!;
    const [primaryId, addedId] = set.order;
    const added = set.items[addedId!]!;
    await until(() => (stored.artifacts[added.artifactId] ?? "").includes("この Mac の二度目の聞き取り"));
    await until(() => bridge.locks.size === 0);

    // 最初の案は今の transcript.md のまま。新しい案は工程 1 でも別の置き場に書く
    expect(set.items[primaryId!]).toMatchObject({ artifactId: SOURCE_STEP_ID, name: "この Mac", engine: "this-mac" });
    expect(added).toMatchObject({ name: "この Mac 2", engine: "this-mac" });
    expect(stored.transcript).toContain("最初の聞き取り");
    expect(stored.recording.sourceCandidateId).toBeUndefined();
    // 文字起こしだけを作る（後工程は始めない）。保存先は受付で案に固定する
    const request = openedRequests(bridge).at(-1)!;
    expect(request.route).toEqual({ kind: "local_transcription_only" });
    expect(request.transcriptionProvider).toBe("this-mac");
    expect(request.outputTarget).toMatchObject({ stepId: SOURCE_STEP_ID, candidateId: addedId, artifactId: added.artifactId, inputVersions: {} });

    // レールに兄弟のページとして並び、後工程に使う案に印。作った案のページが開いている
    expect(candidateRows(container)).toEqual(["この Mac後工程に使用", "この Mac 2"]);
    expect(container.querySelector('.rail .ti.candidate[aria-current="page"] .t')?.textContent).toBe("この Mac 2");
    expect(container.querySelector(".cloud-banner")?.textContent).toBe("後工程には「この Mac」を使っています。この文字起こしを後工程に使う");
  });

  it("「この文字起こしを後工程に使う」だけで後工程の入力が変わり、作成済みのページは消さずに「元の文字起こしが変わりました。」を出す。元に戻せる", async () => {
    const setup = await transcribedRecording();
    screen = setup.rendered;
    const { container } = screen;
    const { bridge, stored, flow } = setup;
    bridge.transcribeResult = transcriptLines("別のエンジンの聞き取り");
    await click(addButton(container));
    await click(engineItems(container)[2]!);
    await until(() => Object.keys(stored.recording.candidateSets?.[SOURCE_STEP_ID]?.items ?? {}).length === 2);
    const set = stored.recording.candidateSets![SOURCE_STEP_ID]!;
    const [primaryId, addedId] = set.order;
    await until(() => (stored.artifacts[set.items[addedId!]!.artifactId] ?? "").includes("別のエンジンの聞き取り"));
    await until(() => bridge.locks.size === 0);
    const firstStepBefore = stored.artifacts[flow.steps[0]!.id];

    await click(button(container, "この文字起こしを後工程に使う"));
    await until(() => stored.recording.sourceCandidateId === addedId);
    expect(bridge.sourceCandidateCalls.at(-1)).toMatchObject({ candidateId: addedId, expected: null });
    expect(container.querySelector(".cloud-banner")?.textContent).toBe(
      "後工程に使う文字起こしを「この Mac 2」にしました。作成済みのページは、作り直すまで今のままです。元に戻す",
    );
    await until(() => candidateRows(container).join(" / ") === "この Mac / この Mac 2後工程に使用");
    expect(container.querySelector(".pmeta .pill.used-later")?.textContent).toBe("後工程に使用");

    // 作成済みの後工程のページは残り、元にした文字起こしが変わった知らせだけを出す（自動では作り直さない）
    await click(outputRow(container, flow.steps[0]!.name));
    await until(() => (container.querySelector(".cloud-banner")?.textContent ?? "").includes("元の文字起こしが変わりました。"));
    expect(stored.artifacts[flow.steps[0]!.id]).toBe(firstStepBefore);

    // 案のページへ戻って元に戻すと、前の案（最初の文字起こし）へ戻る
    await click([...container.querySelectorAll<HTMLButtonElement>(".rail .ti.candidate")].find((row) => row.querySelector(".t")?.textContent === "この Mac 2")!);
    await click(button(container, "元に戻す"));
    await until(() => stored.recording.sourceCandidateId === primaryId);
    expect(bridge.sourceCandidateCalls.at(-1)).toMatchObject({ candidateId: primaryId, expected: addedId });
    await until(() => (container.querySelector(".cloud-banner")?.textContent ?? "").startsWith("後工程に使う文字起こしを「この Mac」に戻しました。"));
  });

  it("別の画面が先に後工程の指定を変えていたら、上書きせずに知らせる", async () => {
    const setup = await transcribedRecording();
    screen = setup.rendered;
    const { container } = screen;
    const { bridge, stored } = setup;
    await click(addButton(container));
    await click(engineItems(container)[2]!);
    await until(() => Object.keys(stored.recording.candidateSets?.[SOURCE_STEP_ID]?.items ?? {}).length === 2);
    const set = stored.recording.candidateSets![SOURCE_STEP_ID]!;
    await until(() => stored.artifacts[set.items[set.order[1]!]!.artifactId] !== undefined);
    await until(() => bridge.locks.size === 0);
    // ほかの画面が最初の案を明示的に選び直した（画面はまだ知らない）
    stored.recording.sourceCandidateId = set.order[0]!;

    await click(button(container, "この文字起こしを後工程に使う"));
    await until(() => (container.textContent ?? "").includes("後工程に使う文字起こしが、ほかの画面で変わりました。"));
    expect(stored.recording.sourceCandidateId).toBe(set.order[0]);
  });
});
