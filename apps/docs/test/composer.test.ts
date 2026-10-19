import { describe, expect, it } from "vitest";
import {
  FLOW_TEMPLATES,
  ROOT_RECORDING_ID,
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  projectPages,
  type Project,
} from "@niho/docs-core";
import { newConversation } from "../src/lib/chat";
import {
  COMPOSER_PAGES_MAX,
  COMPOSER_REFERENCE_OMITTED,
  CONVERSATION_SNAPSHOT_BUDGET_BYTES,
  PAGE_SNAPSHOT_MAX_BYTES,
  applyComposerChanges,
  composerExtra,
  composerFileNames,
  composerPrompt,
  composerRequest,
  loadComposerPlace,
  fitPageSnapshots,
  newDocumentTitle,
  undoPageChange,
} from "../src/lib/composer";
import { FakeBridge } from "./fake-bridge";
import { seedRun } from "./pages";

/** composer（#18722）: 作業場所の中身（同じ場所の文書ページ・ほかの録音の文書）と、依頼の後の反映・元に戻す。 */

const MEMO = "# 事前メモ\n\n- 質問を3つ\n";
const now = () => new Date("2026-10-17T00:00:00.000Z");

async function place() {
  const bridge = new FakeBridge();
  const flow = createFlowFromTemplate(FLOW_TEMPLATES[2]!, "flow-1");
  bridge.flow = flow;
  const snapshot = createFlowSnapshot(flow, defaultProfiles(), ["claude"]);
  const project: Project = {
    version: 1,
    id: "",
    name: "朝市 インタビュー",
    createdAt: "2026-10-15T00:00:00.000Z",
    flowSnapshot: snapshot,
    info: { speakers: "2", language: "ja", terms: [], background: "" },
    source: { kind: "text" },
  };
  const created = await bridge.createProject(
    project,
    "[00:00:08] 朝市に出して三年目です。\n",
    { id: "save-1", kind: "save", at: project.createdAt, stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" },
    [],
  );
  const step = flow.steps[0]!;
  await seedRun(bridge, created.id, step, "# 発言\n\n- 三年目\n");
  const memo = await bridge.createPage(created.id, { kind: "doc", title: "事前メモ", createdAt: "2026-10-16T00:00:00.000Z" });
  await bridge.writePage(created.id, memo.id, MEMO);
  // 以前のデータ（1 フォルダに録音が 2 つ）の読み方。今の作成口は 2 つ目を断る（#18914）
  bridge.oneRecordingPerFolder = false;
  const second = await bridge.createPage(created.id, {
    kind: "rec",
    title: "第2回",
    createdAt: "2026-10-16T01:00:00.000Z",
    recording: { version: 1, id: "", createdAt: "2026-10-16T01:00:00.000Z", flowSnapshot: snapshot, source: { kind: "text" }, speakers: "auto", language: "ja", refs: [] },
  });
  const stored = bridge.projects.get(created.id)!;
  stored.recordings[second.id]!.transcript = "第2回の文章\n";
  stored.recordings[second.id]!.artifacts[step.id] = "# 第2回の発言\n";
  return { bridge, flow, step, projectId: created.id, memo, second };
}

describe("composer の作業場所", () => {
  it("同じ場所の文書ページ（直せる）と、ほかの録音の文書（読むだけ）を集める。開いている録音は写さない", async () => {
    const { bridge, step, projectId, memo, second } = await place();
    const fromRecording = await loadComposerPlace(bridge, projectId, { pageId: ROOT_RECORDING_ID, recording: true });
    expect(fromRecording.pages).toEqual([{ pageId: memo.id, name: "事前メモ", body: MEMO }]);
    expect(fromRecording.references.map((ref) => [ref.pageId, ref.artifactId, ref.name, ref.body])).toEqual([
      [second.id, SOURCE_STEP_ID, "第2回 / 文章", "第2回の文章\n"],
      [second.id, step.id, `第2回 / ${step.name}`, "# 第2回の発言\n"],
    ]);
    expect(composerRequest(fromRecording)).toEqual({
      recording: true,
      pages: [memo.id],
      references: [
        { page_id: second.id, artifact_id: SOURCE_STEP_ID },
        { page_id: second.id, artifact_id: step.id },
      ],
    });
    // 作業の行はパスの最後の部分だけなので、ほかの録音の文書は「録音の id.成果物の id.md」で名前を引く
    expect(composerFileNames(fromRecording)).toMatchObject({
      [`${memo.id}.md`]: "事前メモ",
      [`${second.id}.${step.id}.md`]: `第2回 / ${step.name}`,
      reference: "ほかの録音の文書",
    });

    // 文書ページの会話: 開いている文書ページも直せる文書に入り、録音はどれも読むだけ
    const fromDocument = await loadComposerPlace(bridge, projectId, { pageId: memo.id, recording: false });
    expect(fromDocument.currentName).toBe("事前メモ");
    expect(fromDocument.pages.map((page) => page.pageId)).toEqual([memo.id]);
    expect(new Set(fromDocument.references.map((ref) => ref.pageId))).toEqual(new Set([ROOT_RECORDING_ID, second.id]));
    expect(composerRequest(fromDocument).recording).toBe(false);
  });

  it("Codex の資料パック: 文書ページは全文、ほかの録音の文書は予算の分だけ成果物から載せ、残りは名前だけにする", async () => {
    const { bridge, step, projectId, memo, second } = await place();
    const loaded = await loadComposerPlace(bridge, projectId, { pageId: ROOT_RECORDING_ID, recording: true });
    // 予算は成果物（# 第2回の発言・9 字）だけが入る大きさ
    const extra = composerExtra(loaded, 10);
    expect(extra.map((entry) => [entry.file, entry.body])).toEqual([
      [`artifacts/pages/${memo.id}.md`, MEMO],
      [`reference/${second.id}.${step.id}.md`, "# 第2回の発言\n"],
      [`reference/${second.id}.${SOURCE_STEP_ID}.md`, COMPOSER_REFERENCE_OMITTED],
    ]);
    expect(composerExtra(loaded).every((entry) => entry.body !== COMPOSER_REFERENCE_OMITTED)).toBe(true);
  });

  it("複数案で案を開いていない録音ページは、録音の文書を読むだけにする（文書ページの会話には付けない）", async () => {
    const { bridge, projectId, memo } = await place();
    const reason = "記事本文を直すときは、左の案を開いてください。";
    const readOnly = await loadComposerPlace(bridge, projectId, { pageId: ROOT_RECORDING_ID, recording: true, readOnly: reason });
    expect(composerRequest(readOnly).recording_writable).toBe(false);
    expect(composerPrompt(readOnly).recordingReadOnly).toBe(reason);
    const writable = await loadComposerPlace(bridge, projectId, { pageId: ROOT_RECORDING_ID, recording: true });
    expect(composerRequest(writable)).not.toHaveProperty("recording_writable");
    const documentChat = await loadComposerPlace(bridge, projectId, { pageId: memo.id, recording: false, readOnly: reason });
    expect(documentChat.recordingReadOnly).toBeNull();
  });
});

describe("依頼の後の反映", () => {
  it("直した文書ページは前の本文を控えて保存し、依頼の途中で変わった・空になったものは反映しない", async () => {
    const { bridge, projectId, memo } = await place();
    const before = await loadComposerPlace(bridge, projectId, { pageId: ROOT_RECORDING_ID, recording: true });
    const edited = "# 事前メモ\n\n- 質問を4つ\n";
    const applied = await applyComposerChanges({ bridge, place: before, pages: [{ pageId: memo.id, markdown: edited }], created: [], now });
    expect(await bridge.readPage(projectId, memo.id)).toBe(edited);
    expect(applied.notes).toEqual([]);
    expect(applied.changes).toEqual([
      { pageId: memo.id, title: "事前メモ", change: "edited", chars: expect.any(Number), delta: 0, before: MEMO, after: edited },
    ]);

    const stale = await loadComposerPlace(bridge, projectId, { pageId: ROOT_RECORDING_ID, recording: true });
    await bridge.writePage(projectId, memo.id, "# 人が直した\n");
    const skipped = await applyComposerChanges({ bridge, place: stale, pages: [{ pageId: memo.id, markdown: "# AI\n" }], created: [], now });
    expect(skipped.changes).toEqual([]);
    expect(skipped.notes).toEqual(["事前メモは依頼の途中で変わったため、AI の変更を反映せず、今の内容を保ちました。"]);
    expect(await bridge.readPage(projectId, memo.id)).toBe("# 人が直した\n");

    const fresh = await loadComposerPlace(bridge, projectId, { pageId: ROOT_RECORDING_ID, recording: true });
    const emptied = await applyComposerChanges({ bridge, place: fresh, pages: [{ pageId: memo.id, markdown: "\n" }], created: [], now });
    expect(emptied.notes).toEqual(["事前メモが空になったため、AI の変更を反映しませんでした。"]);
    expect(await bridge.readPage(projectId, memo.id)).toBe("# 人が直した\n");
  });

  it("新しい文書は開いているページの直後に、作った順に足す（題は最初の見出し、無ければファイル名）", async () => {
    const { bridge, projectId, memo, second } = await place();
    // 依頼の完了処理は実行ロックを持ったまま（use-chat）。ページの移動はロック中に止まるので、並びは作るときに決める
    await bridge.acquireRunLock(projectId);
    const fromRecording = await loadComposerPlace(bridge, projectId, { pageId: ROOT_RECORDING_ID, recording: true });
    const created = await applyComposerChanges({
      bridge,
      place: fromRecording,
      pages: [],
      created: [
        { file: "english.md", markdown: "# English version\n\nThree years.\n" },
        { file: "short-version.md", markdown: "短い版の本文\n" },
        { file: "empty.md", markdown: "\n" },
      ],
      now,
    });
    expect(created.changes.map((change) => [change.title, change.change])).toEqual([
      ["English version", "created"],
      ["short-version", "created"],
    ]);
    const [english, short] = created.changes;
    expect(await bridge.readPage(projectId, english!.pageId)).toBe("# English version\n\nThree years.\n");
    const ids = () => projectPages(bridge.projects.get(projectId)!.project).map((page) => page.id);
    expect(ids()).toEqual([ROOT_RECORDING_ID, english!.pageId, short!.pageId, memo.id, second.id]);

    // 文書ページの会話: その文書ページの直後
    const fromDocument = await loadComposerPlace(bridge, projectId, { pageId: memo.id, recording: false });
    const next = await applyComposerChanges({ bridge, place: fromDocument, pages: [], created: [{ file: "summary.md", markdown: "# まとめ\n" }], now });
    expect(ids()).toEqual([ROOT_RECORDING_ID, english!.pageId, short!.pageId, memo.id, next.changes[0]!.pageId, second.id]);
    await bridge.releaseRunLock(projectId);
    expect(newDocumentTitle("notes.md", "  \n# 打合せの要点 #\n本文")).toBe("打合せの要点");
    expect(newDocumentTitle("notes.md", "## 小見出し\n本文")).toBe("notes");
  });

  it("元に戻す: 直す前の本文に戻す。その後に変わった文書・新しく作った文書は戻さない", async () => {
    const { bridge, projectId, memo } = await place();
    const before = await loadComposerPlace(bridge, projectId, { pageId: ROOT_RECORDING_ID, recording: true });
    const applied = await applyComposerChanges({
      bridge,
      place: before,
      pages: [{ pageId: memo.id, markdown: "# 直した\n" }],
      created: [{ file: "new.md", markdown: "# 新しい\n" }],
      now,
    });
    const [edited, created] = applied.changes;
    await bridge.writePage(projectId, memo.id, "# その後に人が直した\n");
    await expect(undoPageChange({ bridge, projectId, change: edited! })).rejects.toMatchObject({ code: "undo_changed" });
    await expect(undoPageChange({ bridge, projectId, change: created! })).rejects.toMatchObject({ code: "undo_new_document" });
    await bridge.writePage(projectId, memo.id, "# 直した\n");
    await undoPageChange({ bridge, projectId, change: edited! });
    expect(await bridge.readPage(projectId, memo.id)).toBe(MEMO);
  });
});

describe("会話に控える本文の大きさ", () => {
  it("長い文書は直しても直す前・後の本文を控えず、知らせる（会話の保存を失敗させない）", async () => {
    const { bridge, projectId, memo } = await place();
    const before = await loadComposerPlace(bridge, projectId, { pageId: ROOT_RECORDING_ID, recording: true });
    const long = `# 長い文書\n\n${"あ".repeat(PAGE_SNAPSHOT_MAX_BYTES / 3)}\n`;
    const applied = await applyComposerChanges({ bridge, place: before, pages: [{ pageId: memo.id, markdown: long }], created: [], now });
    expect(await bridge.readPage(projectId, memo.id)).toBe(long);
    expect(applied.changes).toEqual([
      { pageId: memo.id, title: "事前メモ", change: "edited", chars: expect.any(Number), delta: expect.any(Number) },
    ]);
    expect(applied.notes).toEqual(["事前メモは長いため、変更の表示と元に戻すは使えません（文書は直しました）。"]);
    await expect(undoPageChange({ bridge, projectId, change: applied.changes[0]! })).rejects.toMatchObject({ code: "undo_unavailable" });
  });

  it("会話の控えの合計が上限を超えたら、古い依頼の控えから外す（変更の記録は残す）", () => {
    const body = "a".repeat(400 * 1024);
    const conversation = newConversation({ id: "conv-1", now: now() });
    const turn = (id: string) => ({
      id,
      pages: [{ pageId: "doc1", title: "メモ", change: "edited" as const, chars: 1, delta: 0, before: body, after: body }],
    });
    const full = { ...conversation, turns: [turn("t1"), turn("t2"), turn("t3")] } as unknown as typeof conversation;
    const fitted = fitPageSnapshots(full);
    const pages = fitted.turns.map((item) => item.pages![0]!);
    expect(pages.map((change) => change.before !== undefined)).toEqual([false, true, true]);
    expect(pages[0]).toEqual({ pageId: "doc1", title: "メモ", change: "edited", chars: 1, delta: 0 });
    expect(pages.reduce((sum, change) => sum + (change.before?.length ?? 0) + (change.after?.length ?? 0), 0))
      .toBeLessThanOrEqual(CONVERSATION_SNAPSHOT_BUDGET_BYTES);
    const small = { ...conversation, turns: [turn("t1")] } as unknown as typeof conversation;
    expect(fitPageSnapshots(small)).toBe(small);
  });
});

describe("作業場所の文書ページの数", () => {
  it("上限を超えるフォルダでも、開いている文書ページは必ず作業場所に入れる", async () => {
    const { bridge, projectId } = await place();
    const ids: string[] = [];
    for (let index = 0; index < COMPOSER_PAGES_MAX + 2; index += 1) {
      const page = await bridge.createPage(projectId, { kind: "doc", title: `文書${index}`, createdAt: "2026-10-16T02:00:00.000Z" });
      ids.push(page.id);
    }
    const last = ids[ids.length - 1]!;
    const loaded = await loadComposerPlace(bridge, projectId, { pageId: last, recording: false });
    expect(loaded.pages).toHaveLength(COMPOSER_PAGES_MAX);
    expect(loaded.pages.some((page) => page.pageId === last)).toBe(true);
    expect(loaded.currentName).toBe(`文書${COMPOSER_PAGES_MAX + 1}`);
  });
});
