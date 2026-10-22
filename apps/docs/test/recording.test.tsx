// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FLOW_TEMPLATES, createFlowFromTemplate, createFlowSnapshot, defaultProfiles, type Project } from "@niho/docs-core";
import { button, buttons, click, renderApp, typeInto, type Screen } from "./dom";
import { FakeBridge } from "./fake-bridge";
import { useRecording } from "../src/components/Recording";
import { RECORDING_JOURNAL_KEY } from "../src/lib/app-recording";
import { addPage, createProjectByName, newFromMenu, until } from "./pages";

/** 録音（#18590）: 録音ページの音声欄から録音・復旧し、追加した音声をその場で保存する。 */

let screen: Screen | null = null;
let hookRoot: Root | null = null;
let hookContainer: HTMLDivElement | null = null;
let hookControls: ReturnType<typeof useRecording> | null = null;

function RecordingHookProbe(props: { bridge: FakeBridge; onRecorded: (audio: ReturnType<FakeBridge["recordedAudio"]>) => void }) {
  hookControls = useRecording(props.bridge, props.onRecorded);
  return null;
}

async function renderRecordingHook(bridge: FakeBridge, onRecorded: (audio: ReturnType<FakeBridge["recordedAudio"]>) => void) {
  hookContainer = document.createElement("div");
  document.body.appendChild(hookContainer);
  hookRoot = createRoot(hookContainer);
  await act(async () => hookRoot!.render(<RecordingHookProbe bridge={bridge} onRecorded={onRecorded} />));
}

afterEach(() => {
  screen?.unmount();
  screen = null;
  if (hookRoot) act(() => hookRoot!.unmount());
  hookRoot = null;
  hookContainer?.remove();
  hookContainer = null;
  hookControls = null;
  localStorage.removeItem(RECORDING_JOURNAL_KEY);
});

function newBridge(): FakeBridge {
  const bridge = new FakeBridge();
  bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
  return bridge;
}

async function openNewProject(bridge: FakeBridge, name = "運営会議 10/16") {
  screen = await renderApp(bridge);
  const { container } = screen;
  await createProjectByName(container, name);
  await addPage(container, "音声");
  return container;
}

function audioNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".afile .nm")].map((node) => node.textContent ?? "");
}

function hasButton(container: HTMLElement, text: string): boolean {
  return buttons(container).some((candidate) => candidate.textContent?.trim() === text);
}

describe("録音", () => {
  it("録音して止めると音声の一覧に入り、その場で案件の音声になる（写した録音は recordings/ から消す）", async () => {
    const bridge = newBridge();
    const container = await openNewProject(bridge);
    await click(button(container, "この Mac で録音"));
    // 断られていないかだけを見る（未決定なら録音の始めに sidecar が聞く）
    expect(bridge.micStatusCalls).toEqual([false]);
    const id = bridge.activeRecording?.id ?? "";
    expect(id).toMatch(/^rec-/);
    const panel = container.querySelector(".rec")!;
    expect(panel.textContent).toContain("MacBook Pro のマイク");
    expect(panel.querySelector(".rec-time")?.textContent).toBe("00:00");
    expect(panel.querySelector(".rec-dot.on")).not.toBeNull();
    // 録音中は「この Mac で録音」を出さず、ドロップの面も畳む
    expect(hasButton(container, "この Mac で録音")).toBe(false);
    expect(container.querySelector(".drop")).toBeNull();

    await act(async () => bridge.emitRecording({ type: "Level", db: -20.4, durationSec: 83.4 }));
    expect(panel.querySelector(".rec-time")?.textContent).toBe("01:23");
    expect(panel.querySelector(".rec-meter")?.getAttribute("aria-valuenow")).toBe("-20");
    await act(async () => bridge.emitRecording({ type: "Level", db: -18, durationSec: 3725 }));
    expect(panel.querySelector(".rec-time")?.textContent).toBe("1:02:05");

    await click(button(container, "止める"));
    expect(bridge.activeRecording).toBeNull();
    expect(container.querySelector(".rec")).toBeNull();
    await until(() => audioNames(container).length === 1);
    expect(audioNames(container)).toEqual(["録音 10/16 15:30"]);
    expect(container.querySelector(".afile .d")?.textContent).toBe("23:45");

    expect(bridge.copiedAudio).toEqual([`/data/recordings/${id}.m4a`]);
    const stored = bridge.byName("運営会議 10/16");
    expect(stored.project.pages?.find((page) => page.kind === "rec")?.title).toBe("10/16 15:30 の録音");
    const savedSource = Object.values(stored.recordings)[0]?.recording.source;
    expect(savedSource?.kind === "audio" ? savedSource.audio.map((item) => item.name) : []).toEqual(["録音 10/16 15:30"]);
    expect(bridge.discardedRecordings).toEqual([id]);
    expect(container.querySelector(".dlg")).toBeNull();
  });

  it("ホームの2つ目の音声で録音を始め、別ページへ移っても開始した音声へ保存して開く", async () => {
    const bridge = newBridge();
    screen = await renderApp(bridge, { autoOpen: false });
    const { container } = screen;
    await newFromMenu(container, "音声");
    await newFromMenu(container, "音声");
    const [first, second] = bridge.outside.project.pages!;
    await click(button(container, "この Mac で録音"));
    const id = bridge.activeRecording!.id;
    const journal = JSON.parse(localStorage.getItem(RECORDING_JOURNAL_KEY) ?? "{}");
    expect(journal[id]).toMatchObject({ projectId: null, pageId: second!.id, existing: true });
    await newFromMenu(container, "ページ");
    await click(button(container, "止める"));
    await until(() => bridge.discardedRecordings.includes(id) && audioNames(container).length === 1);
    expect(bridge.projects.size).toBe(0);
    expect(bridge.outside.project.pages).toHaveLength(3);
    expect(bridge.recording(null, first!.id).recording.source).toEqual({ kind: "audio", audio: [] });
    const saved = bridge.recording(null, second!.id).recording.source;
    expect(saved.kind === "audio" && saved.audio.map((audio) => audio.name)).toEqual(["録音 10/16 15:30"]);
    expect(bridge.recent[0]).toMatchObject({ projectId: null, pageId: second!.id });
  });

  it("マイクの許可が無ければ案内とシステム設定を開くボタンを出し、録音は始めない", async () => {
    const bridge = newBridge();
    bridge.micState = "denied";
    const container = await openNewProject(bridge);
    await click(button(container, "この Mac で録音"));
    expect(bridge.activeRecording).toBeNull();
    expect(container.textContent).toContain("マイクの使用が許可されていません。システム設定で NIHO docs を許可してください。");
    await click(button(container, "システム設定を開く"));
    expect(bridge.openedMicSettings).toBe(1);

    // 未決定で聞いたら断られた（sidecar が recording_permission）も同じ案内
    expect(Object.keys(JSON.parse(localStorage.getItem(RECORDING_JOURNAL_KEY) ?? "{}"))).toHaveLength(0);
    bridge.micState = "notDetermined";
    bridge.recordingError = { code: "recording_permission", message: "マイクの使用が許可されていません。" };
    await click(button(container, "この Mac で録音"));
    expect(Object.keys(JSON.parse(localStorage.getItem(RECORDING_JOURNAL_KEY) ?? "{}"))).toHaveLength(0);
    expect(container.querySelectorAll(".rec-note")).toHaveLength(1);
    expect(hasButton(container, "システム設定を開く")).toBe(true);
    expect(container.querySelector(".rec")).toBeNull();
  });

  it("入力の装置が無ければ、マイクをつなぐ案内を出す", async () => {
    const bridge = newBridge();
    bridge.recordingError = { code: "recording_no_device", message: "マイクが見つかりません。" };
    const container = await openNewProject(bridge);
    await click(button(container, "この Mac で録音"));
    expect(container.textContent).toContain("マイクが見つかりません。マイクをつないでから、もう一度押してください。");
    expect(hasButton(container, "システム設定を開く")).toBe(false);
    // もう一度押せる
    expect(hasButton(container, "この Mac で録音")).toBe(true);
  });

  it("録音中に窓を閉じようとすると確かめ、止めるなら録音を保存してから閉じる", async () => {
    const bridge = newBridge();
    const container = await openNewProject(bridge);
    await click(button(container, "この Mac で録音"));
    await act(async () => bridge.requestWindowClose());
    expect(container.textContent).toContain("録音を止めて閉じますか？");
    await click(button(container, "録音を続ける"));
    expect(bridge.closedAfterRecording).toBe(0);
    expect(bridge.activeRecording).not.toBeNull();
    await act(async () => bridge.requestWindowClose());
    await click(button(container, "止めて閉じる"));
    expect(bridge.closedAfterRecording).toBe(1);
  });

  it("録音中に保存していない工程設計があれば、録音を止めるかを先に確かめ、止めた後に保存していない変更を確かめる（重ねない）", async () => {
    const bridge = newBridge();
    const container = await openNewProject(bridge);
    await click(button(container, "この Mac で録音"));
    await click(button(container, "工程設計"));
    await typeInto(container.querySelector('[aria-label="名前"]')!, "週次の議事録");
    // 窓を閉じる: Rust は録音中なので止めて知らせ、画面の閉じる要求も届く
    let closes = true;
    await act(async () => {
      bridge.requestWindowClose();
      closes = await bridge.requestClose();
    });
    expect(closes).toBe(false);
    const dialogs = () => [...container.querySelectorAll<HTMLElement>('[role="dialog"]')].map((dialog) => dialog.querySelector("h2")?.textContent);
    expect(dialogs()).toEqual(["録音を止めて閉じますか？"]);

    // 止めて閉じる: 録音を止めて窓を閉じ直す（Rust の close_after_recording）→ 今度は保存していない変更を確かめる
    bridge.closeAfterRecording = async () => {
      await FakeBridge.prototype.closeAfterRecording.call(bridge);
      closes = await bridge.requestClose();
    };
    await click(button(container, "止めて閉じる"));
    expect(bridge.activeRecording).toBeNull();
    expect(closes).toBe(false);
    expect(dialogs()).toEqual(["保存が終わっていない変更があります"]);
  });

  it("録音ページを離れても帯と録音を保ち、停止後に開始した空ページへ保存する", async () => {
    const bridge = newBridge();
    const container = await openNewProject(bridge);
    await click(button(container, "この Mac で録音"));
    const id = bridge.activeRecording!.id;
    await addPage(container, "ページ");
    expect(bridge.activeRecording?.id).toBe(id);
    expect(container.querySelector(".rec-dot.on")).not.toBeNull();
    await click(button(container, "止める"));
    await until(() => audioNames(container).length === 1);
    await until(() => audioNames(container).length === 1);
    expect(audioNames(container)).toEqual(["録音 10/16 15:30"]);
    expect(bridge.discardedRecordings).toEqual([id]);
    expect(container.querySelector(".rec-left")).toBeNull();
  });

  it("前回の録音が残っていれば、音声に足すか捨てるかを選べる（捨てるは確かめる）", async () => {
    const bridge = newBridge();
    bridge.leftovers = [
      { recordingId: "rec-old1", path: "/data/recordings/rec-old1.m4a", name: "録音 10/15 10:00", durationSec: 1380 },
      { recordingId: "rec-old2", path: "/data/recordings/rec-old2.recording.caf", name: "録音 10/15 18:00", durationSec: 40 },
    ];
    const container = await openNewProject(bridge);
    const rows = () => [...container.querySelectorAll(".rec-left .nm")].map((node) => node.textContent);
    expect(rows()).toEqual(["前回の録音が残っています · 録音 10/15 10:00（23 分）", "前回の録音が残っています · 録音 10/15 18:00（40 秒）"]);

    await click(container.querySelectorAll<HTMLButtonElement>(".rec-left .link")[0]!);
    expect(audioNames(container)).toEqual(["録音 10/15 10:00"]);
    expect(rows()).toEqual(["前回の録音が残っています · 録音 10/15 18:00（40 秒）"]);

    await click(button(container, "捨てる"));
    expect(container.textContent).toContain("前回の録音を捨てますか？");
    expect(container.textContent).toContain("録音 10/15 18:00（40 秒）を削除します。元に戻せません。");
    await click(button(container, "やめる"));
    expect(bridge.discardedRecordings).toEqual(["rec-old1"]);
    await click(button(container, "捨てる"));
    // 確かめのダイアログの「捨てる」（危ない操作なので最初のフォーカスは「やめる」）
    const confirmButtons = [...container.querySelectorAll<HTMLButtonElement>(".btn.stop")].filter(
      (candidate) => candidate.textContent === "捨てる",
    );
    await click(confirmButtons[0]!);
    expect(bridge.discardedRecordings).toEqual(["rec-old1", "rec-old2"]);
    expect(rows()).toEqual([]);

    expect(bridge.copiedAudio).toEqual(["/data/recordings/rec-old1.m4a"]);
  });

  it("マイクが外れて録音が自分で止まったら、ここまでを一覧に足して知らせる", async () => {
    const bridge = newBridge();
    const container = await openNewProject(bridge);
    await click(button(container, "この Mac で録音"));
    const id = bridge.activeRecording?.id ?? "";
    await act(async () => bridge.emitRecording({ type: "Done", audio: bridge.recordedAudio(id) }));
    expect(container.querySelector(".rec")).toBeNull();
    await until(() => audioNames(container).length === 1);
    expect(audioNames(container)).toEqual(["録音 10/16 15:30"]);
    expect(container.textContent).toContain("録音が止まりました");
    // 音声が入った後は「＋ 音声を追加」だけ（素材は ファイルを選択／この Mac で録音 の 2 択。owner 2026-10-18）
    expect(hasButton(container, "＋ 音声を追加")).toBe(true);
    expect(hasButton(container, "この Mac で録音")).toBe(false);
  });

  it("始めた応答より先に録音が終わっても（装置が外れた）、終了できない録音の面を残さない", async () => {
    const bridge = newBridge();
    bridge.duringStart = (recordingId, onEvent) => onEvent({ type: "Done", audio: bridge.recordedAudio(recordingId) });
    const container = await openNewProject(bridge);
    await click(button(container, "この Mac で録音"));
    expect(container.querySelector(".rec")).toBeNull();
    await until(() => audioNames(container).length === 1);
    expect(audioNames(container)).toEqual(["録音 10/16 15:30"]);
    expect(container.textContent).toContain("録音が止まりました");
    // 音声が入った後は「＋ 音声を追加」だけ（素材は ファイルを選択／この Mac で録音 の 2 択。owner 2026-10-18）
    expect(hasButton(container, "＋ 音声を追加")).toBe(true);
    expect(hasButton(container, "この Mac で録音")).toBe(false);
  });

  it("始めた応答より先にエラーで終わっても、録音の面を残さない", async () => {
    const bridge = newBridge();
    bridge.duringStart = (_recordingId, onEvent) =>
      onEvent({ type: "Error", code: "recording_failed", message: "録音が途中で止まりました。もう一度押してください。" });
    const container = await openNewProject(bridge);
    await click(button(container, "この Mac で録音"));
    expect(container.querySelector(".rec")).toBeNull();
    expect(container.textContent).toContain("録音が途中で止まりました");
    expect(Object.keys(JSON.parse(localStorage.getItem(RECORDING_JOURNAL_KEY) ?? "{}"))).toHaveLength(0);
    expect(hasButton(container, "この Mac で録音")).toBe(true);
  });

  it("開始中の二重要求と終了イベントの遅配で、別録音の表示・保存を壊さない", async () => {
    const bridge = newBridge();
    const recorded: ReturnType<FakeBridge["recordedAudio"]>[] = [];
    await renderRecordingHook(bridge, (audio) => recorded.push(audio));

    await act(async () => {
      const first = hookControls!.start();
      const duplicate = hookControls!.start();
      await Promise.all([first, duplicate]);
    });
    expect(bridge.micStatusCalls).toEqual([false]);
    expect(bridge.activeRecording).not.toBeNull();
    expect(hookControls!.state.phase).toBe("recording");

    const firstEvents = bridge.activeRecording!.onEvent;
    await act(async () => {
      await hookControls!.stop();
    });
    expect(recorded).toHaveLength(1);

    await act(async () => hookControls!.start());
    const secondId = bridge.activeRecording!.id;
    await act(async () => firstEvents({ type: "Done", audio: bridge.recordedAudio("rec-stale") }));
    expect(recorded).toHaveLength(1);
    expect(bridge.activeRecording?.id).toBe(secondId);
    expect(hookControls!.state).toMatchObject({ phase: "recording", id: secondId });
  });

  it("同じ録音への重複停止は sidecar を一度だけ呼び出す", async () => {
    const bridge = newBridge();
    const recorded: ReturnType<FakeBridge["recordedAudio"]>[] = [];
    let stopCalls = 0;
    const stopRecording = bridge.stopRecording.bind(bridge);
    bridge.stopRecording = async (id) => {
      stopCalls += 1;
      return stopRecording(id);
    };
    await renderRecordingHook(bridge, (audio) => recorded.push(audio));
    await act(async () => hookControls!.start());

    await act(async () => {
      const first = hookControls!.stop();
      const duplicate = hookControls!.stop();
      await Promise.all([first, duplicate]);
    });
    expect(stopCalls).toBe(1);
    expect(recorded).toHaveLength(1);
  });

  it("停止の応答と Done が重なっても、保存の通知は一度だけ", async () => {
    const bridge = newBridge();
    const recorded: ReturnType<FakeBridge["recordedAudio"]>[] = [];
    const stop = bridge.stopRecording.bind(bridge);
    bridge.stopRecording = async (id) => {
      const event = bridge.activeRecording!.onEvent;
      const audio = await stop(id);
      event({ type: "Done", audio });
      return audio;
    };
    await renderRecordingHook(bridge, (audio) => recorded.push(audio));
    await act(async () => hookControls!.start());
    await act(async () => hookControls!.stop());
    expect(recorded).toHaveLength(1);
  });

  it("音声の入った録音のページは「＋ 音声を追加」だけで、「この Mac で録音」を出さない（押すと別のページに保存されて紛らわしい）", async () => {
    const bridge = newBridge();
    const flow = bridge.flow!;
    const project: Project = {
      version: 1,
      id: "",
      name: "取材",
      createdAt: "2026-10-16T00:00:00.000Z",
      flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
      info: { speakers: "2", language: "ja", terms: [], background: "" },
      source: { kind: "audio", audio: [] },
    };
    await bridge.createProject(project, null, null, ["/a/1.m4a"]);
    screen = await renderApp(bridge);
    const { container } = screen;
    expect(audioNames(container)).toEqual(["1.m4a"]);
    expect(hasButton(container, "＋ 音声を追加")).toBe(true);
    expect(hasButton(container, "この Mac で録音")).toBe(false);
  });
});
