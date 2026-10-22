import { describe, expect, it } from "vitest";
import {
  ROOT_RECORDING_ID,
  SOURCE_STEP_ID,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  findTemplate,
  folderName,
  folderRecordingPage,
  pageTitle,
  projectPages,
  recordingAutoReferencePages,
  projectWithRootRecording,
  recordingChildren,
  recordingInfo,
  recordingOf,
  rootRecording,
  type PageEntry,
  type Project,
  type Recording,
  type RecordingFile,
} from "../src/index.js";

/** 案件のページ（#18564 P1）: 今の案件は root の録音 1 枚、新しい案件は pages の並び。 */

const flow = createFlowFromTemplate(findTemplate("tpl-2")!, "flow-1");
const snapshot = createFlowSnapshot(flow, defaultProfiles(), ["claude"]);
const [minutes, summary] = flow.steps.map((step) => step.id) as [string, string];
const info = { speakers: "auto", language: "ja", terms: [], background: "" } as const;

/** 今の形の案件（pages が無く、flowSnapshot・source を持つ）。 */
const legacy: Project = {
  version: 1,
  id: "p1",
  name: "定例",
  createdAt: "2026-10-15T00:00:00.000Z",
  flowSnapshot: snapshot,
  info: { ...info, terms: [] },
  source: { kind: "audio", audio: [{ file: "a.m4a", hash: "0", name: "会議.m4a", durationSec: 60 }] },
};

/** 新しい形の案件（pages を持ち、root の録音は無い）。 */
const paged: Project = {
  version: 1,
  id: "p2",
  name: "佐藤さん コーチング",
  createdAt: "2026-10-16T00:00:00.000Z",
  info: { ...info, terms: [] },
  pages: [
    { id: "d1", kind: "doc", title: "事前メモ", createdAt: "2026-10-16T00:00:00.000Z" },
    { id: "r1", kind: "rec", title: "", createdAt: "2026-10-16T01:00:00.000Z" },
  ],
};

describe("projectPages", () => {
  it("空のフォルダ名は無題のフォルダとして表示する", () => {
    expect(folderName({ name: "" })).toBe("無題のフォルダ");
    expect(folderName({ name: "  " })).toBe("無題のフォルダ");
    expect(folderName({ name: "取材" })).toBe("取材");
  });

  it("pages の無い今の案件は root の録音 1 枚（title は空・作成日時は案件の作成日時）", () => {
    expect(projectPages(legacy)).toEqual([{ id: ROOT_RECORDING_ID, kind: "rec", recordingId: ROOT_RECORDING_ID, title: "", createdAt: "2026-10-15T00:00:00.000Z" }]);
  });

  it("pages があればその並び、root も flowSnapshot も無い案件は空", () => {
    expect(projectPages(paged).map((page) => page.id)).toEqual(["d1", "r1"]);
    expect(projectPages({ ...paged, pages: undefined })).toEqual([]);
    // pages を書いた今の案件は pages のまま（root を先頭に足し直さない）
    expect(projectPages({ ...legacy, pages: [] })).toEqual([]);
  });

  it("PageIndex から新規文書の汎用的な出典を言語情報なしで保つ", () => {
    const derivation = { operationId: "op1", sourceProjectId: "p2", sourceKind: "document" as const,
      sourcePageId: "d1", sourceHash: "source", instructionHash: "instruction", titleHash: "title", outputHash: "output" };
    const project: Project = { ...paged, pages: { version: 1, order: ["d1", "d2"], items: {
      d1: { kind: "document", title: "原文", createdAt: paged.createdAt },
      d2: { kind: "document", title: "新文書", createdAt: paged.createdAt, derivation },
    } } };
    expect(projectPages(project)[1]).toMatchObject({ id: "d2", title: "新文書", derivation });
    expect(projectPages(project)[1]?.derivation).not.toHaveProperty("language");
  });

  it("自動参考はフォルダの台帳順を保ち、録音と録音由来の文書を除く", () => {
    const derivation = { operationId: "op1", sourceProjectId: "p2", sourceKind: "artifact" as const,
      sourcePageId: "r1", sourceHash: "source", instructionHash: "instruction", titleHash: "title", outputHash: "output" };
    const project: Project = { ...paged, pages: { version: 1, order: ["d2", "r1", "d1"], items: {
      d1: { kind: "document", title: "独立メモ", createdAt: paged.createdAt },
      d2: { kind: "document", title: "録音の成果物", createdAt: paged.createdAt, derivation },
      r1: { kind: "recording", recordingId: "rec1", title: "取材", createdAt: paged.createdAt },
    } } };
    expect(recordingAutoReferencePages(project).map((page) => page.id)).toEqual(["d1"]);
  });
});

describe("rootRecording", () => {
  it("root の案台帳を project.json と録音の読み替えの往復で保つ", () => {
    const candidateSets = { h2n6v5pe: { stepId: "h2n6v5pe", order: ["c1"], items: { c1: { id: "c1", artifactId: "h2n6v5pe", name: "最初の案", createdAt: legacy.createdAt } } } };
    const project = { ...legacy, candidateSets };
    const recording = rootRecording(project)!;
    expect(recording.candidateSets).toEqual(candidateSets);
    expect(projectWithRootRecording(project, recording).candidateSets).toEqual(candidateSets);
  });
  it("今の案件の flowSnapshot・source・info の話者人数・言語・refs から root の録音を作り、書き戻すと project.json の値だけが変わる", () => {
    const recording = rootRecording(legacy)!;
    expect(recording).toEqual({
      version: 1,
      id: ROOT_RECORDING_ID,
      createdAt: legacy.createdAt,
      flowSnapshot: snapshot,
      source: legacy.source,
      speakers: "auto",
      language: "ja",
      refs: [],
    });
    const next: Recording = { ...recording, source: { kind: "audio", audio: [] } };
    const written = projectWithRootRecording(legacy, next);
    expect(written.source).toEqual({ kind: "audio", audio: [] });
    expect(written.flowSnapshot).toBe(snapshot);
    expect(written.refs).toEqual([]);
    expect(written.info).toEqual(legacy.info);
    expect({ ...written, source: undefined, refs: undefined }).toEqual({ ...legacy, source: undefined });
    // 元の案件は変えない
    expect(legacy.source?.kind).toBe("audio");
  });

  it("話者人数・言語・参考を書き戻すと project.json の info.speakers・info.language・refs に入る（固有名詞・背景情報・pages は残る）", () => {
    const withPages: Project = {
      ...legacy,
      info: { speakers: "2", language: "ja", terms: [{ term: "朝市", reading: "あさいち", variants: [], note: "" }], background: "背景" },
      pages: [
        { id: ROOT_RECORDING_ID, kind: "rec", title: "", createdAt: legacy.createdAt },
        { id: "d1", kind: "doc", title: "事前メモ", createdAt: legacy.createdAt },
      ],
    };
    const recording = rootRecording(withPages)!;
    expect([recording.speakers, recording.language, recording.refs]).toEqual(["2", "ja", []]);
    const written = projectWithRootRecording(withPages, { ...recording, speakers: "none", language: "en", refs: ["d1"] });
    expect(written.info).toEqual({ ...withPages.info, speakers: "none", language: "en" });
    expect(written.refs).toEqual(["d1"]);
    expect(written.pages).toBe(withPages.pages);
    expect(written.flowSnapshot).toBe(snapshot);
    // 読み直すと同じ値
    expect(rootRecording(written)).toMatchObject({ speakers: "none", language: "en", refs: ["d1"] });
  });

  it("flowSnapshot の無い案件には root が無く、source の無い今の案件は音声 0 本", () => {
    expect(rootRecording(paged)).toBeNull();
    expect(rootRecording({ ...legacy, source: undefined })?.source).toEqual({ kind: "audio", audio: [] });
  });
});

describe("recordingOf（録音の読み替え。#18566 P3）", () => {
  /** P1 で作った録音（recording.json に speakers・language・refs が無い）。 */
  const p1: RecordingFile = {
    version: 1,
    id: "r1",
    createdAt: "2026-10-16T01:00:00.000Z",
    flowSnapshot: snapshot,
    source: { kind: "audio", audio: [] },
  };

  it("P1 の録音は 話者人数・言語を案件の info、参考を空として読む（元の値は変えない）", () => {
    const project: Project = { ...paged, info: { speakers: "3", language: "en", terms: [], background: "" } };
    expect(recordingOf(project, p1)).toEqual({ ...p1, speakers: "3", language: "en", refs: [] });
    expect("speakers" in p1).toBe(false);
  });

  it("案件の info にも無ければ 自動・日本語。正しくない値も同じ", () => {
    const project: Project = { ...paged, info: { terms: [], background: "" } };
    expect(recordingOf(project, p1)).toMatchObject({ speakers: "auto", language: "ja", refs: [] });
    const broken = { ...p1, speakers: "9", language: "fr" } as unknown as RecordingFile;
    expect(recordingOf(project, broken)).toMatchObject({ speakers: "auto", language: "ja" });
  });

  it("録音の値があればそれ（案件の info より先）。参考は文書のページだけを付けた順に（消した文書・録音の id・重複は外す）", () => {
    const project: Project = { ...paged, info: { speakers: "3", language: "en", terms: [], background: "" } };
    const stored: RecordingFile = { ...p1, speakers: "none", language: "ja", refs: ["gone", "d1", "r1", "d1"] };
    expect(recordingOf(project, stored)).toMatchObject({ speakers: "none", language: "ja", refs: ["d1"] });
    expect(recordingOf(project, { ...p1, refs: "d1" as unknown as string[] }).refs).toEqual([]);
  });

  it("root の参考も文書のページだけ（pages の無い今の案件には文書が無い）", () => {
    expect(rootRecording({ ...legacy, refs: ["d1"] })?.refs).toEqual([]);
    const withDoc: Project = {
      ...legacy,
      refs: ["d1", "zz"],
      pages: [
        { id: ROOT_RECORDING_ID, kind: "rec", title: "", createdAt: legacy.createdAt },
        { id: "d1", kind: "doc", title: "", createdAt: legacy.createdAt },
      ],
    };
    expect(rootRecording(withDoc)?.refs).toEqual(["d1"]);
  });

  it("工程の入力の案件情報は 録音の話者人数・言語 ＋ 案件の固有名詞・背景情報", () => {
    const project: Project = {
      ...paged,
      info: { terms: [{ term: "佐藤", reading: "さとう", variants: [], note: "" }], background: "コーチング" },
    };
    const recording = recordingOf(project, { ...p1, speakers: "2", language: "ja" });
    expect(recordingInfo(project, recording)).toEqual({ ...project.info, speakers: "2", language: "ja" });
  });
});

describe("pageTitle", () => {
  const entry = (kind: PageEntry["kind"], title: string): PageEntry => ({ id: "x", kind, title, createdAt: "" });
  const recording = rootRecording(legacy)!;

  it("名前があればそのまま（前後の空白は除く）", () => {
    expect(pageTitle(entry("doc", " 事前メモ "))).toBe("事前メモ");
    expect(pageTitle(entry("rec", "第1回 セッション"), recording)).toBe("第1回 セッション");
  });

  it("空なら文書は「無題」、録音は素材が文章なら「文章」・それ以外は「録音」", () => {
    expect(pageTitle(entry("doc", ""))).toBe("無題");
    expect(pageTitle(entry("rec", "  "), recording)).toBe("録音");
    expect(pageTitle(entry("rec", ""), { ...recording, source: { kind: "text" } })).toBe("文章");
    expect(pageTitle(entry("rec", ""), { ...recording, source: { kind: "text", transcriptImport: { format: "vtt", file: "source.vtt", name: "会議.vtt", hash: "a".repeat(64) } } })).toBe("文字起こし");
    expect(pageTitle(entry("rec", ""))).toBe("録音");
  });

  it("Web・API の行（kind と title だけ・素材の種類だけ）でも同じ名前", () => {
    expect(pageTitle({ kind: "rec", title: "" }, { source: { kind: "text" } })).toBe("文章");
    expect(pageTitle({ kind: "rec", title: "" }, { source: { kind: "audio" } })).toBe("録音");
    expect(pageTitle({ kind: "rec", title: "" }, {})).toBe("録音");
    expect(pageTitle({ kind: "doc", title: " " }, null)).toBe("無題");
  });
});

describe("recordingChildren", () => {
  const recording = rootRecording(legacy)!;

  it("工程 1 は文字起こしがあれば、工程 2〜 は成果物のある工程を flowSnapshot の順に（番号は工程の番号）", () => {
    expect(recordingChildren(recording, true, [summary, minutes])).toEqual([
      { stepId: SOURCE_STEP_ID, number: 1, name: "文字起こし" },
      { stepId: minutes, number: 2, name: "議事録" },
      { stepId: summary, number: 3, name: "共有用の要約" },
    ]);
    expect(recordingChildren(recording, false, [summary])).toEqual([{ stepId: summary, number: 3, name: "共有用の要約" }]);
  });

  it("文章の録音の工程 1 は「文章」。今の工程に無い成果物は出さない", () => {
    expect(recordingChildren({ ...recording, source: { kind: "text" } }, true, ["gone1234"])).toEqual([
      { stepId: SOURCE_STEP_ID, number: 1, name: "文章" },
    ]);
    expect(recordingChildren(recording, false, [])).toEqual([]);
  });
});

describe("folderRecordingPage（1 フォルダ 1 音声。#18914）", () => {
  it("フォルダの録音のページ（無ければ null）。文書の並びの中のどこにあっても見つける", () => {
    expect(folderRecordingPage(projectPages(paged))).toMatchObject({ id: "r1", kind: "rec" });
    expect(folderRecordingPage([{ id: "d1", kind: "doc", title: "", createdAt: "" }])).toBeNull();
    expect(folderRecordingPage([])).toBeNull();
    // 今の案件（pages の無い project.json）は root の録音
    expect(folderRecordingPage(projectPages(legacy))?.id).toBe(ROOT_RECORDING_ID);
  });
});
