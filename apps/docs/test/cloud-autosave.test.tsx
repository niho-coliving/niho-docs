// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import {
  DOCS_AUTO_VERSION_IDLE_MS,
  FLOW_TEMPLATES,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  type DocsAutoVersionReason,
  type Project,
} from "@niho/docs-core";
import { DocPage, type DocFlush } from "../src/components/DocPage";
import { useArtifactAutosave, type ArtifactAutosave } from "../src/lib/artifact-autosave";
import { useArtifactAutoVersion, type ArtifactAutoVersion, type AutoVersionTarget } from "../src/lib/artifact-auto-version";
import { latestVersionRecord } from "../src/lib/project-view";
import type { CloudController } from "../src/lib/cloud";
import type { ProjectId } from "../src/lib/bridge";
import { DOCS_ROOT_PROJECT_ID, type CloudAppliedEvent, type CloudState, type ProjectSyncSnapshot } from "../src/lib/cloud-types";
import { FakeBridge, activeCloud, syncSnapshot } from "./fake-bridge";

/**
 * 自動保存の期限（C3 #18595。spec niho-docs-cloud §7.2）: 最後の入力から 250ms・最初の未保存の入力から最大 1 秒の早い方で書き、
 * メタ行は 250ms までは何も出さず「保存中」→「このMacに保存済み」（NIHO クラウドなら「同期待ち」→「クラウドに保存済み」）。
 * 成果物の書きかけも同じ期限で今の文書に書く（実行中は待つ・消された書きかけは書かない）。版は自動保存のたびには作らず、
 * 編集のまとまりの終わり（最後の入力から 10 分）・離れるとき・AI の前に、版の後に直した文書だけを 1 つ版にする（#18912）。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function settle() {
  for (let index = 0; index < 6; index++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** 時計を進め、書き込み（Promise）の続きまで流す。 */
async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await settle();
}

function pagedProject(name: string): Project {
  return { version: 1, id: "", name, createdAt: "2026-10-16T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] };
}

function controller(state: CloudState | null, snapshots: Record<string, ProjectSyncSnapshot> = {}): CloudController {
  const listeners = new Set<(event: CloudAppliedEvent) => void>();
  return {
    state,
    niho: state?.provider === "niho",
    active: state?.provider === "niho" && state.status === "active",
    snapshots,
    remote: [],
    putState: () => undefined,
    refreshSnapshot: async () => undefined,
    refreshRemote: () => undefined,
    subscribeApplied: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function DocHarness(props: { bridge: FakeBridge; projectId: ProjectId; pageId: string; cloud?: CloudController }) {
  const flushRef = useRef<DocFlush | null>(null);
  return (
    <DocPage
      bridge={props.bridge}
      projectId={props.projectId}
      pageId={props.pageId}
      title=""
      updatedMs={0}
      focusTitle={false}
      onTitleFocused={() => undefined}
      onTitleInput={() => undefined}
      onTitleCommit={async () => true}
      onSaved={() => undefined}
      onError={() => undefined}
      onSnapshot={() => undefined}
      flushRef={flushRef}
      cloud={props.cloud}
    />
  );
}

function editorOf(): Editor {
  const element = container.querySelector(".pbody .ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  if (!element?.editor) throw new Error("editor not found");
  return element.editor;
}

async function type(text: string) {
  await act(async () => {
    editorOf().commands.insertContent(text);
  });
}

function status(): { text: string; tone: string } {
  const element = container.querySelector(".pmeta .savest");
  return { text: element?.textContent?.replace("·", "") ?? "", tone: element?.className.replace("savest", "").trim() ?? "" };
}

async function docProject(bridge: FakeBridge) {
  const project = await bridge.createProject(pagedProject("朝市"), null, null, []);
  const page = await bridge.createPage(project.id, { kind: "doc", title: "", createdAt: "2026-10-16T00:00:00.000Z" });
  return { projectId: project.id, pageId: page.id };
}

describe("文書のページの自動保存（250ms・最大 1 秒）", () => {
  it("本文は保護と同時に捕捉した snapshot から開き、捕捉前に届いた更新を古い read で戻さない", async () => {
    const bridge = new FakeBridge();
    const { projectId, pageId } = await docProject(bridge);
    const originalOpen = bridge.openPageDocument.bind(bridge);
    bridge.openPageDocument = async (...args) => {
      bridge.projects.get(projectId)!.docs[pageId] = "capture の直前に届いた本文";
      return originalOpen(...args);
    };
    await act(async () => root.render(<DocHarness bridge={bridge} projectId={projectId} pageId={pageId} />));
    await settle();
    expect(editorOf().getText()).toContain("capture の直前に届いた本文");
    expect(bridge.protectedPaths(projectId)).toEqual([`pages/${pageId}.md`]);
  });

  it("開いた handle を受け取る前に別のページへ移ったら、その handle を解放する（保護を残さない）", async () => {
    const bridge = new FakeBridge();
    const { projectId, pageId } = await docProject(bridge);
    const other = await bridge.createPage(projectId, { kind: "doc", title: "", createdAt: "2026-10-16T00:00:00.000Z" });
    const originalOpen = bridge.openPageDocument.bind(bridge);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    bridge.openPageDocument = async (...args) => {
      if (first) {
        first = false;
        await gate;
      }
      return originalOpen(...args);
    };
    await act(async () => root.render(<DocHarness bridge={bridge} projectId={projectId} pageId={pageId} />));
    // 開き終わり（setBody）と移動を同じ描画にまとめる: 本文の DocBody は作られないまま、最初の handle の effect が片付く
    await act(async () => {
      release();
      for (let index = 0; index < 5; index += 1) await Promise.resolve();
      root.render(<DocHarness bridge={bridge} projectId={projectId} pageId={other.id} />);
    });
    await settle();
    expect(bridge.protectedPaths(projectId)).toEqual([`pages/${other.id}.md`]);
  });

  it("context 変更後に遅れて走った保存は旧 draft を残して失敗し、新しく開いた current handle だけが書ける", async () => {
    const bridge = new FakeBridge();
    const { projectId, pageId } = await docProject(bridge);
    const nextPage = await bridge.createPage(projectId, {
      kind: "doc",
      title: "Root B",
      createdAt: "2026-10-17T01:00:00.000Z",
    });
    bridge.projects.get(projectId)!.docs[pageId] = "Root A の保存済み本文";
    bridge.cloud = activeCloud({ contextGeneration: 41, documentScopeId: "root-a-owner" });
    const show = (generation: number, shownPage = pageId, documentScopeId = "root-a-owner") =>
      act(async () =>
        root.render(
          <DocHarness
            bridge={bridge}
            projectId={projectId}
            pageId={shownPage}
            cloud={controller(activeCloud({ contextGeneration: generation, documentScopeId }))}
          />,
        ),
      );
    await show(41);
    await settle();
    await type("・失ってはいけない下書き");
    bridge.cloud = activeCloud({ contextGeneration: 42, documentScopeId: "root-b-owner" });
    await show(42, pageId, "root-b-owner");
    await advance(250);
    expect(bridge.projects.get(projectId)!.docs[pageId]).toBe("Root A の保存済み本文");
    expect(editorOf().getText()).toContain("失ってはいけない下書き");
    expect(status()).toEqual({ text: "このMacに保存できません", tone: "error" });

    await show(42, nextPage.id, "root-b-owner");
    await settle();
    await type("Root B の current handle");
    await advance(250);
    expect(bridge.projects.get(projectId)!.docs[nextPage.id]).toContain("Root B の current handle");
    expect(bridge.saveGeneration).toBeGreaterThan(0);
  });

  it("同じ RootBinding の session refresh 後も dirty capture をこのMacへ保存できる", async () => {
    const bridge = new FakeBridge();
    const { projectId, pageId } = await docProject(bridge);
    bridge.projects.get(projectId)!.docs[pageId] = "再認証前";
    bridge.cloud = activeCloud({ contextGeneration: 61, documentScopeId: "same-root-owner" });
    const show = (generation: number) =>
      act(async () =>
        root.render(
          <DocHarness
            bridge={bridge}
            projectId={projectId}
            pageId={pageId}
            cloud={controller(activeCloud({ contextGeneration: generation, documentScopeId: "same-root-owner" }))}
          />,
        ),
      );
    await show(61);
    await settle();
    await type("・再認証中の下書き");
    bridge.cloud = activeCloud({ contextGeneration: 62, documentScopeId: "same-root-owner" });
    await show(62);
    await advance(250);
    expect(bridge.projects.get(projectId)!.docs[pageId]).toContain("再認証中の下書き");
    expect(status().text).not.toBe("このMacに保存できません");
  });

  it("フォルダ外は Store の null を保ったまま docs-root の同期状態・保護・今すぐ同期を使う", async () => {
    const bridge = new FakeBridge();
    const page = await bridge.createPage(null, {
      kind: "doc",
      title: "共有メモ",
      createdAt: "2026-10-17T00:00:00.000Z",
    });
    const path = `pages/${page.id}.md`;
    const snapshot = syncSnapshot(DOCS_ROOT_PROJECT_ID, { deferred: [path] });
    await act(async () =>
      root.render(
        <DocHarness
          bridge={bridge}
          projectId={null}
          pageId={page.id}
          cloud={controller(activeCloud(), { [DOCS_ROOT_PROJECT_ID]: snapshot })}
        />,
      ),
    );
    await settle();
    expect(bridge.protectedPaths(DOCS_ROOT_PROJECT_ID)).toEqual([path]);
    expect(status().text).toBe("クラウドに保存済み");

    await type("ルート本文");
    await advance(250);
    expect(bridge.pageWrites.at(-1)?.projectId).toBeNull();
    expect(status().text).toBe("このMacに保存済み・同期待ち");

    const latest = [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent === "最新を表示");
    expect(latest).toBeDefined();
    await act(async () => {
      latest?.click();
      await Promise.resolve();
    });
    expect(bridge.cloudCallsOf("cloudSyncNow")).toContainEqual([DOCS_ROOT_PROJECT_ID]);
  });

  it("最後の入力から 250ms で書き、それまでは状態を出さない（書いたら「このMacに保存済み」）", async () => {
    const bridge = new FakeBridge();
    const { projectId, pageId } = await docProject(bridge);
    await act(async () => root.render(<DocHarness bridge={bridge} projectId={projectId} pageId={pageId} />));
    await settle();
    // 開いただけなら書かない（読んだ本文はこの Mac に保存済み）
    expect(status().text).toBe("このMacに保存済み");
    await type("朝市の段取り");
    expect(status().text).toBe("");
    await advance(249);
    expect(bridge.pageWrites).toHaveLength(0);
    expect(status().text).toBe("");
    await advance(1);
    expect(bridge.pageWrites).toHaveLength(1);
    expect(bridge.pageWrites[0]!.markdown).toContain("朝市の段取り");
    expect(status()).toEqual({ text: "このMacに保存済み", tone: "" });
  });

  it("打ち続けても最初の未保存の入力から 1 秒より後には延ばさない（250ms を過ぎたら「保存中」）", async () => {
    const bridge = new FakeBridge();
    const { projectId, pageId } = await docProject(bridge);
    await act(async () => root.render(<DocHarness bridge={bridge} projectId={projectId} pageId={pageId} />));
    await settle();
    await type("一");
    for (const text of ["二", "三", "四", "五"]) {
      await advance(200);
      await type(text);
    }
    // 最初の入力から 800ms: まだ書かないが、250ms を過ぎたので「保存中」
    expect(bridge.pageWrites).toHaveLength(0);
    expect(status().text).toBe("保存中");
    await advance(199);
    expect(bridge.pageWrites).toHaveLength(0);
    await advance(1);
    expect(bridge.pageWrites).toHaveLength(1);
    expect(bridge.pageWrites[0]!.markdown).toContain("一二三四五");
    expect(status().text).toBe("このMacに保存済み");
  });

  it("書けなかったら「このMacに保存できません」（赤字）。次の入力で書き直す", async () => {
    const bridge = new FakeBridge();
    const { projectId, pageId } = await docProject(bridge);
    await act(async () => root.render(<DocHarness bridge={bridge} projectId={projectId} pageId={pageId} />));
    await settle();
    const write = vi.spyOn(bridge, "writePage").mockRejectedValueOnce({ code: "store_io", message: "このMacに保存できませんでした。" });
    await type("下書き");
    await advance(250);
    expect(status()).toEqual({ text: "このMacに保存できません", tone: "error" });
    await type("。続き");
    await advance(250);
    expect(write).toHaveBeenCalledTimes(2);
    expect(bridge.projects.get(projectId)!.docs[pageId]).toContain("下書き。続き");
    expect(status().text).toBe("このMacに保存済み");
  });

  it("NIHO クラウドでは、保存した世代まで同期の状態が届いて未送信が無くなったら「クラウドに保存済み」", async () => {
    const bridge = new FakeBridge();
    const { projectId, pageId } = await docProject(bridge);
    const path = `pages/${pageId}.md`;
    const show = (snapshot: ProjectSyncSnapshot) =>
      act(async () =>
        root.render(<DocHarness bridge={bridge} projectId={projectId} pageId={pageId} cloud={controller(activeCloud(), { [projectId]: snapshot })} />),
      );
    await show(syncSnapshot(projectId));
    await settle();
    expect(status().text).toBe("クラウドに保存済み");
    await type("同期する本文");
    await advance(250);
    const generation = bridge.saveGeneration;
    expect(generation).toBeGreaterThan(0);
    // 届いている状態が保存より古い（まだ LocalSaved が届いていない）
    expect(status().text).toBe("このMacに保存済み・同期待ち");
    await show(syncSnapshot(projectId, { localGeneration: generation, dirty: { [path]: generation } }));
    expect(status().text).toBe("このMacに保存済み・同期待ち");
    await show(syncSnapshot(projectId, { localGeneration: generation, acknowledgedGeneration: generation }));
    expect(status().text).toBe("クラウドに保存済み");
    // 開いている間は本文を守る
    expect(bridge.protectedPaths(projectId)).toEqual([path]);
  });
});

function AutosaveHarness(props: {
  bridge: FakeBridge;
  drafts: Record<string, string | null>;
  blocked: boolean;
  onReady: (api: ArtifactAutosave) => void;
  onError?: (message: string) => void;
  onRecovered?: () => void;
}) {
  const api = useArtifactAutosave({
    bridge: props.bridge,
    draftOf: (key) => props.drafts[key] ?? null,
    blocked: () => props.blocked,
    onError: props.onError ?? (() => undefined),
    onRecovered: props.onRecovered,
  });
  props.onReady(api);
  return <span className="phase">{api.states.k?.phase ?? ""}</span>;
}

describe("成果物の書きかけの自動保存", () => {
  async function setup(handlers: { onError?: (message: string) => void; onRecovered?: () => void } = {}) {
    const bridge = new FakeBridge();
    const project = await bridge.createProject(pagedProject("朝市"), null, null, []);
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    const entry = await bridge.createPage(project.id, {
      kind: "rec",
      title: "第1回",
      createdAt: "2026-10-16T00:00:00.000Z",
      recording: {
        version: 1,
        id: "",
        createdAt: "2026-10-16T00:00:00.000Z",
        flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
        source: { kind: "text" },
        speakers: "auto",
        language: "ja",
        refs: [],
      },
    });
    const rec = { projectId: project.id, recordingId: entry.id };
    let api: ArtifactAutosave | null = null;
    const drafts: Record<string, string | null> = {};
    const state = { blocked: false };
    const render = () =>
      act(async () =>
        root.render(<AutosaveHarness bridge={bridge} drafts={drafts} blocked={state.blocked} onReady={(value) => (api = value)} {...handlers} />),
      );
    await render();
    return { bridge, rec, drafts, state, render, api: () => api!, phase: () => container.querySelector(".phase")?.textContent ?? "" };
  }

  it("最後の入力から 250ms・最大 1 秒で今の文書に書く（版は作らない。末尾は改行 1 つ）", async () => {
    const { bridge, rec, drafts, api, phase } = await setup();
    const target = { rec, stepId: "a1", source: false };
    drafts.k = "議事録の書きかけ";
    act(() => api().change("k", target, "議事録の書きかけ"));
    await advance(100);
    expect(phase()).toBe("waiting");
    drafts.k = "議事録の書きかけ（続き）";
    act(() => api().change("k", target, "議事録の書きかけ（続き）"));
    await advance(249);
    expect(bridge.artifactDraftWrites).toHaveLength(0);
    expect(phase()).toBe("saving");
    await advance(1);
    expect(bridge.artifactDraftWrites).toEqual([
      { projectId: rec.projectId, recordingId: rec.recordingId, stepId: "a1", markdown: "議事録の書きかけ（続き）\n" },
    ]);
    expect(phase()).toBe("saved");
    // 版は作らない（「版を保存」まで）。今の文書は版になっていない
    expect(bridge.recording(rec.projectId, rec.recordingId).versions.a1).toBeUndefined();
    expect((await bridge.loadRecording(rec)).unversioned).toEqual(["a1"]);
  });

  it("実行中は書かずに待ち、終わったら書く。消された書きかけは書かない", async () => {
    const { bridge, rec, drafts, state, render, api, phase } = await setup();
    const target = { rec, stepId: "a1", source: false };
    state.blocked = true;
    await render();
    drafts.k = "実行中の書きかけ";
    act(() => api().change("k", target, "実行中の書きかけ"));
    await advance(250);
    expect(bridge.artifactDraftWrites).toHaveLength(0);
    expect(phase()).toBe("saving");
    // 窓を閉じる前の書き残しは、書けなかったことを返す
    let flushed = true;
    await act(async () => {
      flushed = await api().flushAll();
    });
    expect(flushed).toBe(false);
    state.blocked = false;
    await render();
    act(() => api().resume());
    await settle();
    expect(bridge.artifactDraftWrites.map((write) => write.markdown)).toEqual(["実行中の書きかけ\n"]);

    // 版にして書きかけを消した（AIと作るの送る前の保存など）: 待っていたものは書かない
    drafts.k = "消される書きかけ";
    act(() => api().change("k", target, "消される書きかけ"));
    drafts.k = null;
    await advance(250);
    expect(bridge.artifactDraftWrites).toHaveLength(1);
    expect(phase()).toBe("saved");
  });

  it("書けなかった書きかけを書き直せたら知らせる（ほかに書けていない書きかけが残るうちは知らせない）", async () => {
    const onError = vi.fn();
    const onRecovered = vi.fn();
    const { bridge, rec, drafts, api, phase } = await setup({ onError, onRecovered });
    const first = { rec, stepId: "a1", source: false };
    const second = { rec, stepId: "a2", source: false };
    // 別の窓の実行中などで書けない
    await bridge.acquireRunLock(rec.projectId);
    drafts.k = "一つ目";
    drafts.k2 = "二つ目";
    act(() => {
      api().change("k", first, "一つ目");
      api().change("k2", second, "二つ目");
    });
    await advance(250);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(phase()).toBe("failed");
    await bridge.releaseRunLock(rec.projectId);
    // 一つ目は書けたが、二つ目はまだ書けていない
    act(() => api().change("k", first, "一つ目"));
    await advance(250);
    expect(phase()).toBe("saved");
    expect(onRecovered).not.toHaveBeenCalled();
    act(() => api().change("k2", second, "二つ目"));
    await advance(250);
    expect(bridge.artifactDraftWrites.map((write) => write.markdown)).toEqual(["一つ目\n", "二つ目\n"]);
    expect(onRecovered).toHaveBeenCalledOnce();
  });
});

function AutoVersionHarness(props: {
  bridge: FakeBridge;
  drafts: Record<string, string>;
  state: { blocked: boolean };
  reasons: DocsAutoVersionReason[];
  onReady: (api: { autosave: ArtifactAutosave; autoVersion: ArtifactAutoVersion }) => void;
  onError: (message: string) => void;
}) {
  const autosave = useArtifactAutosave({
    bridge: props.bridge,
    draftOf: (key) => props.drafts[key] ?? null,
    blocked: () => props.state.blocked,
    onError: props.onError,
  });
  const autoVersion = useArtifactAutoVersion({
    blocked: () => props.state.blocked,
    flush: (key) => autosave.flush(key),
    currentOf: (key) => props.drafts[key] ?? null,
    latestOf: async (_key, target) => {
      const loaded = await props.bridge.loadRecording(target.rec);
      const record = latestVersionRecord(loaded.runs, target.flowStepId, target.candidate);
      if (!record || typeof record.version !== "number") return { markdown: null };
      return { markdown: await props.bridge.readVersion(target.rec, target.stepId, record.version), record };
    },
    save: async (_key, target, markdown, reason) => {
      await props.bridge.saveArtifact(target.rec, target.stepId, target.source, markdown, {
        id: `save-${props.reasons.length + 1}`,
        kind: "save",
        at: new Date().toISOString(),
        stepId: target.flowStepId,
        stepName: target.stepName,
        version: null,
        result: "saved",
        auto: true,
      });
      props.reasons.push(reason);
    },
    onError: props.onError,
  });
  props.onReady({ autosave, autoVersion });
  return null;
}

describe("版を自動で残す（#18912・spec niho-docs-cloud §8.2）", () => {
  async function setup() {
    const bridge = new FakeBridge();
    const project = await bridge.createProject(pagedProject("朝市"), null, null, []);
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    const entry = await bridge.createPage(project.id, {
      kind: "rec",
      title: "第1回",
      createdAt: "2026-10-16T00:00:00.000Z",
      recording: {
        version: 1,
        id: "",
        createdAt: "2026-10-16T00:00:00.000Z",
        flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
        source: { kind: "text" },
        speakers: "auto",
        language: "ja",
        refs: [],
      },
    });
    const rec = { projectId: project.id, recordingId: entry.id };
    for (const stepId of ["a1", "a2"]) {
      await bridge.saveArtifact(rec, stepId, false, `# ${stepId} の元\n`, {
        id: `run-${stepId}`,
        kind: "run",
        at: "2026-10-16T00:00:00.000Z",
        stepId,
        stepName: stepId,
        version: null,
        result: "saved",
      });
    }
    const drafts: Record<string, string> = {};
    const state = { blocked: false };
    const reasons: DocsAutoVersionReason[] = [];
    const errors: string[] = [];
    let api: { autosave: ArtifactAutosave; autoVersion: ArtifactAutoVersion } | null = null;
    const render = () =>
      act(async () =>
        root.render(
          <AutoVersionHarness
            bridge={bridge}
            drafts={drafts}
            state={state}
            reasons={reasons}
            onReady={(value) => (api = value)}
            onError={(message) => errors.push(message)}
          />,
        ),
      );
    await render();
    const target = (stepId: string): AutoVersionTarget => ({ rec, stepId, source: false, flowStepId: stepId, stepName: stepId, candidate: null });
    const keyOf = (stepId: string) => `k-${stepId}`;
    /** 利用者の入力（書きかけを変え、自動保存と「版の後に直した」に渡す）。 */
    const edit = (markdown: string, stepId = "a1") => {
      drafts[keyOf(stepId)] = markdown;
      act(() => {
        api!.autosave.change(keyOf(stepId), target(stepId), markdown);
        api!.autoVersion.edited(keyOf(stepId), target(stepId));
      });
    };
    const versions = (stepId = "a1") => bridge.recording(project.id, entry.id).versions[stepId] ?? [];
    const run = async (task: () => Promise<boolean>) => {
      let result = false;
      await act(async () => {
        result = await task();
      });
      await settle();
      return result;
    };
    return { bridge, rec, state, reasons, errors, render, edit, versions, run, keyOf, api: () => api! };
  }

  it("idle: 最後の入力から 10 分で版を 1 つ残す。自動保存を何回しても版は増えず、入力のたびに 10 分を数え直す", async () => {
    const { bridge, reasons, edit, versions } = await setup();
    edit("# 直す 1");
    await advance(250);
    edit("# 直す 2");
    await advance(250);
    edit("# 直す 3");
    await advance(250);
    expect(bridge.artifactDraftWrites.map((write) => write.markdown)).toEqual(["# 直す 1\n", "# 直す 2\n", "# 直す 3\n"]);
    expect(versions()).toHaveLength(1);
    // 5 分後にまた打つと、そこから 10 分
    await advance(5 * 60_000 - 250);
    edit("# 直す 4");
    await advance(DOCS_AUTO_VERSION_IDLE_MS - 1);
    expect(versions()).toHaveLength(1);
    await advance(1);
    expect(versions()).toEqual(["# a1 の元\n", "# 直す 4\n"]);
    expect(reasons).toEqual(["idle"]);
    // 直していなければ、もう作らない
    await advance(DOCS_AUTO_VERSION_IDLE_MS * 2);
    expect(versions()).toHaveLength(2);
  });

  it("中身が最新の版と同じ（直して元に戻した）・空の文書は版にしない", async () => {
    const { api, keyOf, edit, versions } = await setup();
    edit("# a1 の元 を直した");
    edit("# a1 の元");
    await advance(DOCS_AUTO_VERSION_IDLE_MS);
    expect(versions()).toHaveLength(1);
    expect(api().autoVersion.isEdited(keyOf("a1"))).toBe(false);
    edit("   ");
    await advance(DOCS_AUTO_VERSION_IDLE_MS);
    expect(versions()).toHaveLength(1);
  });

  it("leave: 離れるときに書き残してから版にし、直していなければ作らない", async () => {
    const { bridge, api, reasons, edit, versions, run } = await setup();
    edit("# 離れる直前");
    // 自動保存の期限の前でも、版の前に今の文書へ書く
    expect(await run(() => api().autoVersion.createWhere("leave"))).toBe(true);
    expect(bridge.artifactDraftWrites.map((write) => write.markdown)).toEqual(["# 離れる直前\n"]);
    expect(versions()).toEqual(["# a1 の元\n", "# 離れる直前\n"]);
    expect(reasons).toEqual(["leave"]);
    expect(await run(() => api().autoVersion.createWhere("leave"))).toBe(true);
    expect(versions()).toHaveLength(2);
    // 版にした後の idle も作らない
    await advance(DOCS_AUTO_VERSION_IDLE_MS);
    expect(versions()).toHaveLength(2);
  });

  it("before_ai: AI が書き換える文書だけを、その直前に版にする", async () => {
    const { api, reasons, edit, versions, run } = await setup();
    edit("# a1 を直した", "a1");
    edit("# a2 を直した", "a2");
    await run(() => api().autoVersion.createWhere("before_ai", (_key, target) => target.flowStepId === "a1"));
    expect(versions("a1")).toEqual(["# a1 の元\n", "# a1 を直した\n"]);
    expect(versions("a2")).toHaveLength(1);
    expect(reasons).toEqual(["before_ai"]);
  });

  it("実行中・依頼中は作らずに待ち、終わったら作る（取りこぼさない）", async () => {
    const { state, render, api, reasons, edit, versions, run } = await setup();
    state.blocked = true;
    await render();
    edit("# 実行中に直した");
    expect(await run(() => api().autoVersion.createWhere("leave"))).toBe(false);
    await advance(DOCS_AUTO_VERSION_IDLE_MS);
    expect(versions()).toHaveLength(1);
    state.blocked = false;
    await render();
    act(() => {
      api().autosave.resume();
      api().autoVersion.resume();
    });
    await settle();
    expect(versions()).toEqual(["# a1 の元\n", "# 実行中に直した\n"]);
    expect(reasons).toEqual(["leave"]);
  });

  it("版を作れなくても本文の保存とは切り離し（入力は今の文書に残る）、次の機会にまた作る", async () => {
    const { bridge, api, keyOf, errors, edit, versions, run, rec } = await setup();
    const original = bridge.saveArtifact.bind(bridge);
    bridge.saveArtifact = async () => {
      throw { code: "store_write_failed", message: "版を書けませんでした。" };
    };
    edit("# 失敗しても残る");
    expect(await run(() => api().autoVersion.createWhere("leave"))).toBe(false);
    expect(errors).toEqual(["版を書けませんでした。"]);
    expect(bridge.recording(rec.projectId!, rec.recordingId).artifacts.a1).toBe("# 失敗しても残る\n");
    expect(api().autoVersion.isEdited(keyOf("a1"))).toBe(true);
    bridge.saveArtifact = original;
    expect(await run(() => api().autoVersion.createWhere("leave"))).toBe(true);
    expect(versions()).toEqual(["# a1 の元\n", "# 失敗しても残る\n"]);
  });

  it("版を作る間に打った入力は、次の版の対象に残す。版にした本文は「AIと作る」の送る前の保存で重ねない", async () => {
    const { bridge, api, keyOf, edit, versions, run } = await setup();
    const original = bridge.saveArtifact.bind(bridge);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    bridge.saveArtifact = async (...args) => {
      await gate;
      return original(...args);
    };
    edit("# 一つ目");
    let pending: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      pending = api().autoVersion.create(keyOf("a1"), "leave");
    });
    await settle();
    edit("# 二つ目");
    await act(async () => {
      release();
      await pending;
    });
    await settle();
    expect(versions()).toEqual(["# a1 の元\n", "# 一つ目\n"]);
    expect(api().autoVersion.isEdited(keyOf("a1"))).toBe(true);
    expect(api().autoVersion.isVersioned(keyOf("a1"), "# 一つ目")).toBe(false);
    bridge.saveArtifact = original;
    await run(() => api().autoVersion.createWhere("leave"));
    expect(versions()).toEqual(["# a1 の元\n", "# 一つ目\n", "# 二つ目\n"]);
    expect(api().autoVersion.isVersioned(keyOf("a1"), "# 二つ目\n")).toBe(true);
    expect(api().autoVersion.isVersioned(keyOf("a1"), "# 三つ目\n")).toBe(false);
  });
});
