// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import type { Editor } from "@tiptap/react";
import { FLOW_TEMPLATES, SOURCE_STEP_ID, createBlankFlow, createFlowFromTemplate, createFlowSnapshot, defaultProfiles, type Flow, type Recording } from "@niho/docs-core";
import { RECORDING_JOURNAL_KEY, saveCapturedRecording, type CaptureTarget } from "../src/lib/app-recording";
import { button, click, renderApp, type Screen } from "./dom";
import { cursorToEnd, typeText } from "./block-editor-helpers";
import { FakeBridge, done } from "./fake-bridge";
import { addPage, openAudio, railCurrent, railItem, until } from "./pages";

let screen: Screen | null = null;
afterEach(() => { screen?.unmount(); screen = null; localStorage.removeItem(RECORDING_JOURNAL_KEY); });
function draftOf(flow: Flow): Recording {
  return { version: 1, id: "", createdAt: "2026-10-17T01:00:00.000Z", flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]), speakers: "auto", language: "ja", refs: [], source: { kind: "audio", audio: [] } };
}
/** 案件と文書「事前メモ」。`fresh` は新しいページに保存する保存先（復旧の fallback と同じ形）。 */
async function setup() {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1"); bridge.flow = flow;
  const project = await bridge.createProject({ version: 1, id: "", name: "録音の案件", createdAt: "2026-10-16T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] }, null, null, []);
  const doc = await bridge.createPage(project.id, { kind: "doc", title: "事前メモ", createdAt: "2026-10-16T01:00:00.000Z" });
  await bridge.writePage(project.id, doc.id, "会議で聞きたいこと\n");
  const draft = draftOf(flow);
  const fresh: CaptureTarget = { root: "/data", projectId: project.id, draft };
  return { bridge, project, doc, draft, fresh };
}
/** 素材の無い録音のページ（題は空＝レールでは「録音」）を足す。「この Mac で録音」の開始元。 */
async function withRecordingPage(flow?: Flow) {
  const base = await setup();
  const rec = await base.bridge.createPage(base.project.id, { kind: "rec", title: "", createdAt: "2026-10-16T02:00:00.000Z", recording: flow ? draftOf(flow) : base.draft });
  return { ...base, rec };
}
function recPages(bridge: FakeBridge, id: string) { return bridge.projects.get(id)!.project.pages!.filter((page) => page.kind === "rec"); }
function audioOf(bridge: FakeBridge, projectId: string, pageId: string) { const source = bridge.recording(projectId, pageId).recording.source; return source.kind === "audio" ? source.audio : []; }
function body(container: HTMLElement): Editor { return (container.querySelector(".pbody .ProseMirror") as HTMLElement & { editor: Editor }).editor; }
async function edit(container: HTMLElement, text: string) { await act(async () => { const editor = body(container); cursorToEnd(editor); typeText(editor, text); }); }
/** 背景情報のページ（フォルダの音声）を開いて「この Mac で録音」（文書のページに録音のボタンは置かない。#18881・#18914）。 */
async function begin(container: HTMLElement) { await openAudio(container); await click(button(container, "この Mac で録音")); }
/** 新しいフォルダ（録音の保存のときに作ったもの）。 */
function newFolders(bridge: FakeBridge, known: readonly string[]) { return [...bridge.projects.values()].filter((item) => !known.includes(item.project.id)); }

describe("App が所有する録音", () => {
  it("録音のページから開始し、文書を編集しても録音を続け、停止時に文書を保存して開始元のページへ音声を足す", async () => {
    const { bridge, project, doc, rec } = await withRecordingPage(); screen = await renderApp(bridge); const container = screen.container;
    await begin(container); expect(bridge.activeRecording).not.toBeNull();
    await click(railItem(container, "事前メモ")); await edit(container, " 録音中にも追記"); expect(bridge.activeRecording).not.toBeNull();
    await click(button(container, "止める"));
    await until(() => container.querySelector(".afile") !== null && !container.textContent?.includes("録音をページに保存しています…"));
    expect(bridge.projects.get(project.id)!.docs[doc.id]).toContain("会議で聞きたいこと 録音中にも追記");
    expect(recPages(bridge, project.id).map((page) => page.id)).toEqual([rec.id]);
    expect(recPages(bridge, project.id)[0]!.title).toBe("10/16 15:30 の録音");
    expect(audioOf(bridge, project.id, rec.id)).toHaveLength(1);
    // 開始元のフォルダの背景情報のページ（音声の欄）へ戻る
    expect(railCurrent(container)).toBe("背景情報");
    expect(railItem(container, "録音の案件").getAttribute("aria-current")).toBe("page");
    expect(container.querySelector(".afile .nm")?.textContent).toBe("録音 10/16 15:30");
  });

  it("ホームの音声で始めた録音は、再起動後も開始時の工程と保存先ページを保つ", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-at-capture"); bridge.flow = flow;
    const draft = draftOf(flow);
    const rec = await bridge.createPage(null, { kind: "rec", title: "", createdAt: "2026-10-16T02:00:00.000Z", recording: draft });
    screen = await renderApp(bridge);
    await click(railItem(screen.container, "録音"));
    await click(button(screen.container, "この Mac で録音"));
    const recordingId = bridge.activeRecording!.id;
    const original = (JSON.parse(localStorage.getItem(RECORDING_JOURNAL_KEY) ?? "{}") as Record<string, CaptureTarget>)[recordingId]!;
    // ホームの音声も開始時の保存先をジャーナルに残す。
    expect(original.projectId).toBeNull();
    expect(original.pageId).toBe(rec.id);
    expect(original.draft.flowSnapshot.id).toBe("flow-at-capture");

    screen.unmount(); screen = null;
    await until(() => bridge.leftovers.length === 1);
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-after-restart");
    screen = await renderApp(bridge);
    await until(() => screen!.container.querySelector(".rec-left") !== null);
    await click(button(screen.container, "録音のページに保存"));
    await until(() => screen!.container.querySelector(".afile") !== null);

    expect(bridge.projects.size).toBe(0);
    expect(bridge.outside.project.pages).toHaveLength(1);
    const saved = bridge.outside.recordings[rec.id]!.recording;
    expect(saved.flowSnapshot).toEqual(original.draft.flowSnapshot);
    expect(saved.source.kind === "audio" && saved.source.audio).toHaveLength(1);
    expect(railCurrent(screen.container)).toBe("10/16 15:30 の録音");
  });

  it("Error 行のあと開始が reject された場合も、不要な復旧情報を残さない", async () => {
    const { bridge } = await withRecordingPage();
    bridge.startRecording = async (_id, onEvent) => {
      onEvent({ type: "Error", code: "recording_failed", message: "録音を開始できません" });
      throw new Error("録音を開始できません");
    };
    screen = await renderApp(bridge); await begin(screen.container);
    expect(Object.keys(JSON.parse(localStorage.getItem(RECORDING_JOURNAL_KEY) ?? "{}"))).toHaveLength(0);
    expect(screen.container.querySelector(".rec")).toBeNull();
  });

  it("録音中の Error で回収音声が無いときは復旧 journal を残さない", async () => {
    const { bridge } = await withRecordingPage();
    screen = await renderApp(bridge);
    await begin(screen.container);
    const active = bridge.activeRecording!;
    bridge.activeRecording = null;
    await act(async () => active.onEvent({ type: "Error", code: "recording_failed", message: "録音を続けられませんでした。" }));
    expect(Object.keys(JSON.parse(localStorage.getItem(RECORDING_JOURNAL_KEY) ?? "{}"))).toHaveLength(0);
    expect(screen.container.textContent).toContain("録音を続けられませんでした。");
  });

  it("Done 行のあと開始応答が reject されても、開始元のページへの保存を保つ", async () => {
    const { bridge, project, rec } = await withRecordingPage();
    bridge.startRecording = async (id, onEvent) => {
      onEvent({ type: "Done", audio: bridge.recordedAudio(id) });
      throw new Error("開始の応答が切れました");
    };
    screen = await renderApp(bridge); await begin(screen.container); await until(() => bridge.discardedRecordings.length === 1);
    expect(audioOf(bridge, project.id, rec.id)).toHaveLength(1);
  });

  it("工程が未登録でも録音でき、音声を失わずページへ保存できる", async () => {
    const { bridge, project, rec } = await withRecordingPage(createBlankFlow("flow-blank")); bridge.flow = null;
    screen = await renderApp(bridge); await begin(screen.container); expect(bridge.activeRecording).not.toBeNull();
    await click(button(screen.container, "止める")); await until(() => bridge.discardedRecordings.length === 1);
    expect(bridge.recording(project.id, rec.id).recording.flowSnapshot.steps).toHaveLength(0); expect(audioOf(bridge, project.id, rec.id)).toHaveLength(1);
  });

  it("別の案件・設定・文書へ移っても録音を維持し、停止後は開始元のページへ戻る", async () => {
    const { bridge, project, rec } = await withRecordingPage();
    const other = await bridge.createProject({ version: 1, id: "", name: "別の案件", createdAt: "2026-10-15T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] }, null, null, []);
    screen = await renderApp(bridge); const container = screen.container; await begin(container);
    const id = bridge.activeRecording!.id; await click(button(container, "設定")); expect(container.querySelector(".rec-dot.on")).not.toBeNull();
    await click(railItem(container, "別の案件")); await addPage(container, "ページ"); expect(bridge.activeRecording?.id).toBe(id);
    await click(button(container, "止める")); await until(() => container.querySelector(".afile") !== null);
    expect(recPages(bridge, other.id)).toHaveLength(0); expect(audioOf(bridge, project.id, rec.id)).toHaveLength(1);
    expect(railItem(container, "録音の案件").getAttribute("aria-current")).toBe("page");
  });

  it("録音中にも別のフォルダの音声の工程を実行できる", async () => {
    const { bridge, draft } = await withRecordingPage();
    // 1 フォルダに録音は 1 つ（#18914）なので、別のフォルダの音声
    const past = await bridge.createProject({ version: 1, id: "", name: "以前の会議", createdAt: "2026-10-15T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] }, null, null, []);
    const other = await bridge.createPage(past.id, { kind: "rec", title: "", createdAt: "2026-10-16T00:00:00.000Z", recording: draft });
    await bridge.setRecordingText({ projectId: past.id, recordingId: other.id }, "既存の文章", { id: "source", kind: "save", at: "now", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" });
    bridge.turnScript = () => [done("以前の会議の議事録")]; screen = await renderApp(bridge); const container = screen.container; await begin(container); const id = bridge.activeRecording!.id;
    await click(railItem(container, "以前の会議")); await click(button(container, "続きを作成"));
    await until(() => bridge.recording(past.id, other.id).runs.some((run) => run.kind === "run" && run.result === "saved"));
    expect(bridge.activeRecording?.id).toBe(id); expect(container.querySelector(".rec-dot.on")).not.toBeNull();
  });

  it("終了・再起動後は文書上にも復旧導線が出て、開始元の録音のページへ音声を足せる", async () => {
    const { bridge, project, rec } = await withRecordingPage(); screen = await renderApp(bridge); await begin(screen.container); const id = bridge.activeRecording!.id;
    screen.unmount(); screen = null; await until(() => bridge.leftovers.length === 1); screen = await renderApp(bridge);
    expect(screen.container.querySelector(".rec-left")).not.toBeNull(); await click(button(screen.container, "録音のページに保存")); await until(() => screen!.container.querySelector(".afile") !== null);
    expect(recPages(bridge, project.id).map((page) => page.id)).toEqual([rec.id]); expect(audioOf(bridge, project.id, rec.id)).toHaveLength(1); expect(bridge.discardedRecordings).toEqual([id]);
  });

  it("保存失敗は元音声を残し、再起動後の再試行でもページと音声を重複させない", async () => {
    const { bridge, project, rec } = await withRecordingPage(); const save = bridge.saveRecording.bind(bridge); let fail = true;
    bridge.saveRecording = async (...args) => { if (fail) throw new Error("ディスクに書けません"); return save(...args); };
    screen = await renderApp(bridge); await begin(screen.container); await click(button(screen.container, "止める")); await until(() => screen!.container.querySelector(".rec-left") !== null);
    expect(bridge.discardedRecordings).toEqual([]); expect(recPages(bridge, project.id).map((page) => page.id)).toEqual([rec.id]); fail = false;
    screen.unmount(); screen = await renderApp(bridge); await click(button(screen.container, "録音のページに保存")); await until(() => bridge.discardedRecordings.length === 1);
    expect(recPages(bridge, project.id).map((page) => page.id)).toEqual([rec.id]); expect(audioOf(bridge, project.id, rec.id)).toHaveLength(1); expect(bridge.copiedAudio).toHaveLength(1);
  });

  it("直前の sidecar が後から書き出し終わった録音も、アプリへ戻ったときに復旧候補へ出す", async () => {
    const { bridge } = await setup(); screen = await renderApp(bridge);
    expect(screen.container.querySelector(".rec-left")).toBeNull();
    bridge.leftovers.push(bridge.recordedAudio("rec-late-export"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await until(() => screen!.container.querySelector(".rec-left") !== null);
  });

  it("復旧時に開始元の案件が消えても、開始時の日時と工程 snapshot を保って今の案件へ保存する", async () => {
    const { bridge, project } = await withRecordingPage(); screen = await renderApp(bridge); await begin(screen.container);
    const recordingId = bridge.activeRecording!.id;
    const original = (JSON.parse(localStorage.getItem(RECORDING_JOURNAL_KEY) ?? "{}") as Record<string, CaptureTarget>)[recordingId]!;
    screen.unmount(); screen = null; await until(() => bridge.leftovers.length === 1); bridge.projects.delete(project.id);
    bridge.flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "flow-later");
    const fallback = await bridge.createProject({ version: 1, id: "", name: "復旧先", createdAt: "2026-10-17T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] }, null, null, []);
    screen = await renderApp(bridge); await click(button(screen.container, "録音のページに保存")); await until(() => bridge.discardedRecordings.length === 1);
    const page = recPages(bridge, fallback.id)[0]!;
    const saved = bridge.recording(fallback.id, page.id).recording;
    expect(saved.refs).toEqual([]);
    expect(saved.createdAt).toBe(original.draft.createdAt);
    expect(saved.flowSnapshot).toEqual(original.draft.flowSnapshot);
  });

  it("文書の保存に失敗したら録音だけを保存して、編集中の文書を開いたまま保つ", async () => {
    const { bridge, project, rec } = await withRecordingPage(); screen = await renderApp(bridge); const container = screen.container; await begin(container);
    await click(railItem(container, "事前メモ"));
    bridge.writePage = async () => { throw new Error("文書を保存できません"); }; await edit(container, "失ってはいけない書きかけ"); await click(button(container, "止める")); await until(() => bridge.discardedRecordings.length === 1);
    expect(body(container).getText()).toContain("失ってはいけない書きかけ"); expect(audioOf(bridge, project.id, rec.id)).toHaveLength(1); expect(container.querySelector(".failure-band .fb-msg")?.textContent).toContain("書きかけを保存してから");
  });
});

describe("録音の保存の再開", () => {
  it("ホームの指定した音声に保存し、掃除の再試行でもほかの音声へ混ぜず二重に取り込まない", async () => {
    const { bridge, fresh, draft } = await setup();
    const first = await bridge.createPage(null, { kind: "rec", title: "先の音声", createdAt: draft.createdAt, recording: draft });
    const second = await bridge.createPage(null, { kind: "rec", title: "後の音声", createdAt: draft.createdAt, recording: draft });
    let checkpoint: CaptureTarget = { ...fresh, projectId: null, pageId: second.id, existing: true };
    const before = bridge.projects.size;
    const discard = bridge.discardRecording.bind(bridge);
    bridge.discardRecording = async () => { throw new Error("元音声を消せません"); };
    const audio = bridge.recordedAudio("rec-home-page");
    await expect(saveCapturedRecording(bridge, audio, checkpoint, (next) => { checkpoint = next; })).rejects.toThrow();
    bridge.discardRecording = discard;
    const saved = await saveCapturedRecording(bridge, audio, checkpoint, (next) => { checkpoint = next; });
    expect(saved).toEqual({ projectId: null, recordingId: second.recordingId ?? second.id });
    expect(bridge.projects.size).toBe(before);
    expect(bridge.copiedAudio).toHaveLength(1);
    expect(bridge.outside.project.pages).toHaveLength(2);
    expect(bridge.recording(null, first.id).recording.source).toEqual({ kind: "audio", audio: [] });
    const source = bridge.recording(null, second.id).recording.source;
    expect(source.kind === "audio" && source.audio).toHaveLength(1);
  });

  it("保存済みだが元音声の掃除に失敗した場合も再試行で音声を二重に足さない", async () => {
    const { bridge, fresh, project } = await setup(); let checkpoint = fresh; const discard = bridge.discardRecording.bind(bridge);
    bridge.discardRecording = async () => { throw new Error("元音声を消せません"); }; const audio = bridge.recordedAudio("rec-saved");
    await expect(saveCapturedRecording(bridge, audio, checkpoint, (next) => { checkpoint = next; })).rejects.toThrow(); bridge.discardRecording = discard;
    await saveCapturedRecording(bridge, audio, checkpoint, (next) => { checkpoint = next; }); expect(recPages(bridge, project.id)).toHaveLength(1); expect(bridge.copiedAudio).toHaveLength(1);
    const source = bridge.recording(project.id, checkpoint.pageId!).recording.source; expect(source.kind === "audio" && source.audio).toHaveLength(1);
  });
  it("ページ作成の応答直前に中断しても、開始時刻で保存途中のページを見つけて再利用する", async () => {
    const { bridge, fresh, project } = await setup(); const create = bridge.createPage.bind(bridge);
    bridge.createPage = async (...args) => { await create(...args); throw new Error("応答が切れました"); };
    const audio = bridge.recordedAudio("rec-interrupted");
    await expect(saveCapturedRecording(bridge, audio, fresh, () => undefined)).rejects.toThrow();
    bridge.createPage = create; const rec = await saveCapturedRecording(bridge, audio, fresh, () => undefined);
    expect(recPages(bridge, project.id)).toHaveLength(1); expect(rec.recordingId).toBe(recPages(bridge, project.id)[0]!.id);
  });
  it("旧版のジャーナル（文書ページから始めた録音の refPageId）を回収すると、残っている文書を参考に引き継ぐ", async () => {
    const { bridge, fresh, project, doc } = await setup();
    const rec = await saveCapturedRecording(bridge, bridge.recordedAudio("rec-legacy"), { ...fresh, refPageId: doc.id }, () => undefined);
    expect(bridge.recording(project.id, rec.recordingId).recording.refs).toEqual([doc.id]);
    // 開始元の文書が消えていれば足さない（音声の無い別のフォルダに保存する）
    const other = await bridge.createProject({ version: 1, id: "", name: "別のフォルダ", createdAt: "2026-10-16T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] }, null, null, []);
    const gone = await saveCapturedRecording(bridge, bridge.recordedAudio("rec-legacy-gone"), { ...fresh, projectId: other.id, draft: { ...fresh.draft, createdAt: "2026-10-17T02:00:00.000Z" }, refPageId: "deleted-doc" }, () => undefined);
    expect(bridge.recording(other.id, gone.recordingId).recording.refs).toEqual([]);
  });
  it("開始した空ページに途中で文章が入ったら、それを上書きせず新しいフォルダへ保存する（1 フォルダ 1 音声。#18914）", async () => {
    const { bridge, fresh, project } = await setup(); const page = await bridge.createPage(project.id, { kind: "rec", title: "手動の素材", createdAt: "2026-10-16T00:00:00.000Z", recording: fresh.draft });
    await bridge.setRecordingText({ projectId: project.id, recordingId: page.id }, "途中で追加した文章", { id: "save", kind: "save", at: "now", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" });
    const rec = await saveCapturedRecording(bridge, bridge.recordedAudio("rec-other"), { ...fresh, pageId: page.id, existing: true }, () => undefined);
    expect(rec.projectId).not.toBe(project.id); expect(bridge.recording(project.id, page.id).transcript).toBe("途中で追加した文章");
    expect(recPages(bridge, project.id)).toHaveLength(1);
    expect(audioOf(bridge, rec.projectId!, rec.recordingId)).toHaveLength(1);
  });

  it("フォルダに音声があれば、素材が入っていてもその音声 1 セットに足す（2 つ目の録音は作らない）", async () => {
    const { bridge, fresh, project } = await setup();
    const first = await saveCapturedRecording(bridge, bridge.recordedAudio("rec-first"), fresh, () => undefined);
    const second = await saveCapturedRecording(bridge, bridge.recordedAudio("rec-second"), { ...fresh, draft: { ...fresh.draft, createdAt: "2026-10-17T03:00:00.000Z" } }, () => undefined);
    expect(second).toEqual(first);
    expect(recPages(bridge, project.id)).toHaveLength(1);
    expect(audioOf(bridge, project.id, first.recordingId)).toHaveLength(2);
  });

  it("フォルダを開いていなかった録音（projectId が null）は、録音の日時の新しいフォルダを作って保存し、再試行は同じフォルダを使う", async () => {
    const { bridge, fresh } = await setup();
    const known = [...bridge.projects.keys()];
    let checkpoint: CaptureTarget = { ...fresh, projectId: null };
    const save = bridge.saveRecording.bind(bridge); let fail = true;
    bridge.saveRecording = async (...args) => { if (fail) throw new Error("ディスクに書けません"); return save(...args); };
    const audio = bridge.recordedAudio("rec-home");
    await expect(saveCapturedRecording(bridge, audio, checkpoint, (next) => { checkpoint = next; })).rejects.toThrow();
    fail = false;
    const rec = await saveCapturedRecording(bridge, audio, checkpoint, (next) => { checkpoint = next; });
    const created = newFolders(bridge, known);
    expect(created).toHaveLength(1);
    expect(created[0]!.project.name).toBe("10/16 15:30 の録音");
    expect(rec.projectId).toBe(created[0]!.project.id);
    expect(bridge.outside.project.pages ?? []).toHaveLength(0);
  });
});
