import { describe, expect, it } from "vitest";

import { buildFolderExportTree, orderFolderExportSelection } from "../src/folder-export-tree.js";
import type { Project, RecordingFile } from "../src/types.js";

describe("保存先共通のフォルダ書き出し", () => {
  it("Mac のファイル一覧からも独自ページの順序と選択を決められる", async () => {
    const project = {
      id: "folder1",
      name: "取材",
      createdAt: "2026-10-18T00:00:00.000Z",
      info: { background: "", terms: [] },
      pages: {
        version: 1,
        order: ["doc2", "doc1"],
        items: {
          doc1: { kind: "document", title: "先に作った文書", createdAt: "" },
          doc2: { kind: "document", title: "後に作った文書", createdAt: "" },
        },
      },
    } as unknown as Project;
    const files = new Set(["pages/doc1.md", "pages/doc2.md"]);
    const tree = await buildFolderExportTree({
      project,
      files: { has: (path) => files.has(path) },
      loadRecording: async () => null,
    });
    expect(tree.nodes.map((node) => [node.key, node.title])).toEqual([
      ["doc:doc2", "後に作った文書"],
      ["doc:doc1", "先に作った文書"],
    ]);
    expect(orderFolderExportSelection(tree, ["doc:doc1", "doc:doc2"])).toEqual({
      ok: true,
      keys: ["doc:doc2", "doc:doc1"],
    });
    expect(orderFolderExportSelection(tree, ["doc:missing"])).toMatchObject({
      ok: false,
      error: { reason: "invalid_selection" },
    });
  });

  it("背景情報・工程ページ・独自ページを同じ深さに並べ、工程の別案を行として増やさない", async () => {
    const project = {
      id: "folder1",
      name: "取材",
      createdAt: "2026-10-18T00:00:00.000Z",
      info: { background: "朝市の取材", terms: [] },
      pages: {
        version: 1,
        order: ["doc2", "rec1", "doc1"],
        items: {
          doc1: { kind: "document", title: "質問メモ", createdAt: "" },
          doc2: { kind: "document", title: "事前メモ", createdAt: "" },
          rec1: { kind: "recording", title: "録音", createdAt: "", recordingId: "rec1" },
        },
      },
    } as unknown as Project;
    const recording = {
      version: 1,
      id: "rec1",
      createdAt: "2026-10-18T00:00:00.000Z",
      source: { kind: "text" },
      refs: [],
      flowSnapshot: { version: 1, id: "flow", name: "取材", revision: 1, guide: "", terms: [], samples: [],
        steps: [{ id: "s1", name: "文字起こし修正", instruction: "" }, { id: "s2", name: "記事本文", instruction: "" }], models: {} },
      candidateSets: { s2: {
        stepId: "s2", order: ["first", "second"],
        items: {
          first: { id: "first", artifactId: "s2", name: "最初の案", createdAt: "" },
          second: { id: "second", artifactId: "s2_b", name: "別案", createdAt: "" },
        },
      } },
    } as const;
    const files = new Set([
      "recordings/rec1/recording.json", "recordings/rec1/transcript.md",
      "recordings/rec1/artifacts/s1.md", "recordings/rec1/artifacts/s2.md", "recordings/rec1/artifacts/s2_b.md",
      "pages/doc1.md", "pages/doc2.md",
    ]);
    const tree = await buildFolderExportTree({
      project,
      files: { has: (path) => files.has(path) },
      loadRecording: async () => recording as unknown as RecordingFile,
    });
    expect(tree.nodes.map((node) => [node.key, node.kind, node.title, node.parentKey])).toEqual([
      ["context", "context", "背景情報", null],
      ["step:rec1:source", "step", "文章", null],
      ["step:rec1:s1", "step", "文字起こし修正", null],
      ["step:rec1:s2", "step", "記事本文", null],
      ["doc:doc2", "document", "事前メモ", null],
      ["doc:doc1", "document", "質問メモ", null],
    ]);
    expect(tree.nodes.find((node) => node.key === "step:rec1:s2")?.bodyPath).toBe("recordings/rec1/artifacts/s2.md");
    expect(tree.nodes.every((node) => node.parentKey === null)).toBe(true);
  });

  it("後工程に使う文字起こしの案を本文に選び、案が欠けたら最初の本文に戻さない", async () => {
    const project = {
      id: "folder1", name: "取材", createdAt: "2026-10-18T00:00:00.000Z",
      info: { background: "", terms: [] },
      pages: { version: 1, order: ["rec1"], items: { rec1: { kind: "recording", title: "録音", createdAt: "", recordingId: "rec1" } } },
    } as unknown as Project;
    const recording = {
      version: 1, id: "rec1", createdAt: "2026-10-18T00:00:00.000Z", refs: [],
      source: { kind: "audio", audio: [{ file: "a1.m4a", hash: "0".repeat(64), name: "録音", durationSec: 10 }] },
      flowSnapshot: { version: 1, id: "flow", name: "取材", revision: 1, guide: "", terms: [], samples: [], steps: [], models: {} },
      candidateSets: { source: { stepId: "source", order: ["first", "second"], items: {
        first: { id: "first", artifactId: "source", name: "最初", createdAt: "" },
        second: { id: "second", artifactId: "tx2", name: "別案", createdAt: "" },
      } } },
      sourceCandidateId: "second",
    };
    const files = new Set(["recordings/rec1/recording.json", "recordings/rec1/transcript.md", "recordings/rec1/artifacts/tx2.md"]);
    const tree = await buildFolderExportTree({ project, files: { has: (path) => files.has(path) }, loadRecording: async () => recording as unknown as RecordingFile });
    expect(tree.nodes[0]?.bodyPath).toBe("recordings/rec1/artifacts/tx2.md");
    expect(tree.nodes[0]?.timestamps).toBe("artifact");
    const broken = await buildFolderExportTree({ project, files: { has: (path) => files.has(path) }, loadRecording: async () => ({ ...recording, sourceCandidateId: "missing" }) as unknown as RecordingFile });
    expect(broken.nodes).toEqual([]);
  });
});
