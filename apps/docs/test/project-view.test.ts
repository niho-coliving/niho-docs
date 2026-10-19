import { describe, expect, it } from "vitest";
import {
  FLOW_TEMPLATES,
  ROOT_RECORDING_ID,
  SOURCE_STEP_ID,
  basisFor,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  projectPages,
  stepSupportsCandidates,
  type Project,
  type Recording,
} from "@niho/docs-core";
import { loadRecordingView, openProjectOf, saveRecordingChange, withPageTitle } from "../src/lib/project-view";
import { FakeBridge } from "./fake-bridge";
import { rootRef } from "./fake-bridge";
import { seedRun } from "./pages";

/** 録音の見え方を作る値（#18566 P3）: 参考にした文書の改名・実行キューの間は参考を固定する。 */

function recordingOf(flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1"), refs: string[] = []): Recording {
  return {
    version: 1,
    id: "",
    createdAt: "2026-10-16T01:00:00.000Z",
    flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
    source: { kind: "audio", audio: [] },
    speakers: "auto",
    language: "ja",
    refs,
  };
}

function pagedProject(name: string): Project {
  return { version: 1, id: "", name, createdAt: "2026-10-16T00:00:00.000Z", info: { terms: [], background: "" }, pages: [] };
}

describe("withPageTitle", () => {
  it("レールの一覧と、参考ページの見出しを作る案件の値の両方を新しい名前にする", async () => {
    const bridge = new FakeBridge();
    const project = await bridge.createProject(pagedProject("朝市"), null, null, []);
    const memo = await bridge.createPage(project.id, { kind: "doc", title: "無題", createdAt: "2026-10-16T00:00:00.000Z" });
    const open = openProjectOf(await bridge.loadProject(project.id));
    const renamed = withPageTitle(open, memo.id, "事前メモ");
    expect(renamed.pages.find((page) => page.id === memo.id)?.title).toBe("事前メモ");
    expect(projectPages(renamed.project).find((page) => page.id === memo.id)?.title).toBe("事前メモ");
    // 元の値は変えない
    expect(open.pages.find((page) => page.id === memo.id)?.title).toBe("無題");
  });

  it("参考にした文書を改名した後に作る録音の見え方の参考ページには、新しい名前が入る", async () => {
    const bridge = new FakeBridge();
    const project = await bridge.createProject(pagedProject("朝市"), null, null, []);
    const memo = await bridge.createPage(project.id, { kind: "doc", title: "無題", createdAt: "2026-10-16T00:00:00.000Z" });
    await bridge.writePage(project.id, memo.id, "## 聞きたいこと\n");
    const rec = await bridge.createPage(project.id, {
      kind: "rec",
      title: "第1回",
      createdAt: "2026-10-16T01:00:00.000Z",
      recording: recordingOf(undefined, [memo.id]),
    });
    const open = withPageTitle(openProjectOf(await bridge.loadProject(project.id)), memo.id, "事前メモ");
    const entry = open.pages.find((page) => page.id === rec.id)!;
    const view = await loadRecordingView(bridge, project.id, open.project, entry);
    expect(view.materials.refs.map((ref) => ref.title)).toEqual(["事前メモ"]);
  });

  it("pages の無い今の形の案件は、名前を変えると pages を初期化した形（root の録音の行）になる", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[1]!, "flow-1");
    const project = await bridge.createProject(
      {
        version: 1,
        id: "",
        name: "朝市 インタビュー",
        createdAt: "2026-10-15T00:00:00.000Z",
        flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
        info: { speakers: "2", language: "ja", terms: [], background: "" },
        source: { kind: "text" },
      },
      null,
      null,
      [],
    );
    const open = openProjectOf(await bridge.loadProject(project.id));
    expect(open.project.pages).toBeUndefined();
    const renamed = withPageTitle(open, ROOT_RECORDING_ID, "第1回");
    expect(projectPages(renamed.project).map((page) => [page.id, page.title])).toEqual([[ROOT_RECORDING_ID, "第1回"]]);
  });
});

describe("記事本文の別案", () => {
  it("出力設定の無い旧 snapshot も「出力」のチェックを外した snapshot も、最後の工程で別案を作れる", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "article-flow");
    const unchecked = { ...flow, steps: flow.steps.map((step) => step.id === "h2n6v5pe" ? { ...step, output: { mode: "single" } } : step) };
    // 1 フォルダに録音は 1 つ（#18914）なので、録音ごとにフォルダを作る
    const ids: Array<{ projectId: string; recordingId: string }> = [];
    for (const [title, snapshotOf] of [["旧", flow], ["解除済み", unchecked]] as const) {
      const project = await bridge.createProject(pagedProject(`記事 ${title}`), null, null, []);
      const entry = await bridge.createPage(project.id, {
        kind: "rec",
        title,
        createdAt: "2026-10-16T01:00:00.000Z",
        recording: recordingOf(snapshotOf),
      });
      ids.push({ projectId: project.id, recordingId: entry.id });
    }

    for (const rec of ids) {
      const open = openProjectOf(await bridge.loadProject(rec.projectId));
      expect(stepSupportsCandidates(open.recordings[rec.recordingId]!.recording.flowSnapshot, "h2n6v5pe")).toBe(true);
    }
    await saveRecordingChange(bridge, ids[1]!, (recording) => ({ ...recording, speakers: "2" }));
    const stored = await bridge.loadRecording(ids[1]!);
    expect(stepSupportsCandidates(stored.recording!.flowSnapshot, "h2n6v5pe")).toBe(true);
  });
});

describe("loadRecordingView の frozenRefs", () => {
  it("参考が上限を超えても録音を開けて、AI工程だけを止める理由を返す", async () => {
    const bridge = new FakeBridge();
    const project = await bridge.createProject(pagedProject("朝市"), null, null, []);
    const refs = [];
    for (let index = 0; index < 65; index += 1) {
      const page = await bridge.createPage(project.id, { kind: "doc", title: `参考 ${index + 1}`, createdAt: "2026-10-16T00:00:00.000Z" });
      await bridge.writePage(project.id, page.id, `本文 ${index + 1}`);
      refs.push(page.id);
    }
    const rec = await bridge.createPage(project.id, {
      kind: "rec",
      title: "第1回",
      createdAt: "2026-10-16T01:00:00.000Z",
      recording: recordingOf(),
    });
    const open = openProjectOf(await bridge.loadProject(project.id));
    const entry = open.pages.find((page) => page.id === rec.id)!;
    const view = await loadRecordingView(bridge, project.id, open.project, entry);

    expect(view.recording.id).toBe(rec.id);
    expect(view.materials.refs.map((ref) => ref.pageId)).toEqual(refs);
    expect(view.executionBlockReason).toContain("64件を超えている");
  });

  it("渡した参考をそのまま使い、渡さなければ文書を読み直す", async () => {
    const bridge = new FakeBridge();
    const project = await bridge.createProject(pagedProject("朝市"), null, null, []);
    const memo = await bridge.createPage(project.id, { kind: "doc", title: "事前メモ", createdAt: "2026-10-16T00:00:00.000Z" });
    await bridge.writePage(project.id, memo.id, "最初の本文");
    const rec = await bridge.createPage(project.id, {
      kind: "rec",
      title: "第1回",
      createdAt: "2026-10-16T01:00:00.000Z",
      recording: recordingOf(undefined, [memo.id]),
    });
    const open = openProjectOf(await bridge.loadProject(project.id));
    const entry = open.pages.find((page) => page.id === rec.id)!;
    const started = await loadRecordingView(bridge, project.id, open.project, entry);
    expect(started.materials.refs.map((ref) => ref.body)).toEqual(["最初の本文"]);

    await bridge.writePage(project.id, memo.id, "直した本文");
    await bridge.deletePage(project.id, memo.id);
    const frozen = await loadRecordingView(bridge, project.id, open.project, entry, started.materials.refs);
    expect(frozen.materials.refs.map((ref) => ref.body)).toEqual(["最初の本文"]);
    // 固定しなければ、文書は消えているので参考は無い
    const fresh = await loadRecordingView(bridge, project.id, (await bridge.loadProject(project.id)).project, entry);
    expect(fresh.materials.refs).toEqual([]);
  });
});

describe("loadRecordingView の候補前提", () => {
  it("最初の案でもcandidateId付きの最新実行を使い、古い録音全体runを前提の正本にしない", async () => {
    const bridge = new FakeBridge();
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "article-flow");
    bridge.flow = flow;
    const project = await bridge.createProject(
      {
        version: 1,
        id: "",
        name: "記事",
        createdAt: "2026-10-16T00:00:00.000Z",
        flowSnapshot: createFlowSnapshot(flow, defaultProfiles(), ["claude"]),
        info: { speakers: "auto", language: "ja", terms: [], background: "" },
        source: { kind: "text" },
      },
      "素材",
      { id: "source1", kind: "save", at: "2026-10-16T00:00:00.000Z", stepId: SOURCE_STEP_ID, stepName: "文章", version: null, result: "saved" },
      [],
    );
    await seedRun(bridge, project.id, flow.steps[0]!, "修正版");
    await seedRun(bridge, project.id, flow.steps[1]!, "記事方針");
    const opened = openProjectOf(await bridge.loadProject(project.id));
    const entry = opened.pages[0]!;
    const before = await loadRecordingView(bridge, project.id, opened.project, entry);
    const oldBasis = basisFor(before.flow, 2, { ...before.materials, source: "古い素材" });
    await bridge.saveArtifact(rootRef(project.id), flow.steps[2]!.id, false, "旧本文", {
      id: "legacy-body", kind: "run", at: "2026-10-16T01:00:00.000Z", stepId: flow.steps[2]!.id,
      stepName: flow.steps[2]!.name, version: null, result: "saved", basis: oldBasis,
    });
    await bridge.createCandidate(rootRef(project.id), flow.steps[2]!.id, {
      stepId: flow.steps[2]!.id,
      order: ["candidate1", "candidate2"],
      items: {
        candidate1: { id: "candidate1", artifactId: flow.steps[2]!.id, name: "最初の案", createdAt: "x" },
        candidate2: { id: "candidate2", artifactId: "artifact2", name: "別案", createdAt: "x" },
      },
    }, "artifact2", null, null);
    await bridge.saveArtifact(rootRef(project.id), flow.steps[2]!.id, false, "候補化後の本文", {
      id: "candidate-body", kind: "run", at: "2026-10-16T02:00:00.000Z", stepId: flow.steps[2]!.id,
      stepName: flow.steps[2]!.name, candidateId: "candidate1", artifactId: flow.steps[2]!.id,
      version: null, result: "saved", basis: basisFor(before.flow, 2, before.materials),
    });
    const current = await loadRecordingView(bridge, project.id, (await bridge.loadProject(project.id)).project, entry);
    expect(current.plan.steps.find((step) => step.stepId === flow.steps[2]!.id)?.staleReasons).toEqual([]);
  });
});
