import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FLOW_TEMPLATES,
  PROVIDER_IDS,
  SAFE_ID_PATTERN,
  createBlankFlow,
  createFlowFromTemplate,
  createFlowSnapshot,
  defaultProfiles,
  isFlowSampleShape,
  isFlowShape,
  isFlowSnapshotShape,
  isFlowStepShape,
  isGlossaryEntryShape,
  isSafeId,
  isSnapshotModelShape,
  isStoredRecordingInfoShape,
  isStoredRecordingShape,
  isStoredRecordingSourceShape,
  type Flow,
} from "../src/index.js";

/** 共有の fixture（apps/docs/fixtures/flow-shape/）。Rust のテスト（store_flows.rs の flow_shape_ok）も同じものを読む。 */
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "docs", "fixtures", "flow-shape", "cases.json");

type FlowCase = { name: string; valid: boolean; flow: unknown };

const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as FlowCase[];

const HASH = "a".repeat(64);

function flowWith(overrides: Partial<Flow> = {}): Flow {
  return {
    version: 1,
    id: "flow-1",
    name: "テスト",
    revision: 1,
    guide: "",
    terms: [],
    samples: [],
    steps: [{ id: "a", name: "整える", instruction: "指示", profile: "standard" }],
    ...overrides,
  };
}

/** 録音に固定した工程の写し（モデルは 1 つ目の工程だけ）を JSON に書いて読み直した形。 */
function snapshot(): Record<string, unknown> {
  const flow = flowWith({
    steps: [
      { id: "a", name: "整える", instruction: "指示", profile: "standard" },
      { id: "b", name: "要約", instruction: "指示", profile: "advanced" },
    ],
  });
  const full = createFlowSnapshot(flow, defaultProfiles(), PROVIDER_IDS);
  return JSON.parse(JSON.stringify(full)) as Record<string, unknown>;
}

function recording(): Record<string, unknown> {
  return {
    version: 1,
    id: "rec_one",
    pageId: "page_one",
    createdAt: "2026-10-18T00:00:00.000Z",
    flowSnapshot: snapshot(),
    info: { speakers: "auto", language: "ja" },
    source: { kind: "audio", audio: [{ file: "one.m4a", hash: HASH, name: "録音", durationSec: null }] },
    refs: [],
  };
}

/** 入れ子の欄を書き換えた写しを返す（元は変えない）。 */
function mutated<T extends Record<string, unknown>>(base: T, change: (draft: any) => void): T {
  const draft = structuredClone(base);
  change(draft);
  return draft;
}

describe("isSafeId", () => {
  it("英数字・_・- の 1〜64 文字だけを通す", () => {
    for (const id of ["a", "A", "abc_DEF-123", "x".repeat(64), "page_0123456789abcdef"]) {
      expect(isSafeId(id), id).toBe(true);
    }
    for (const id of ["", "x".repeat(65), "a.b", "a/b", "a b", " a", "あ", 1, null, undefined, {}]) {
      expect(isSafeId(id), String(id)).toBe(false);
    }
  });

  it("g フラグを持たない（test を続けて呼んでも結果が変わらない）", () => {
    expect(SAFE_ID_PATTERN.global).toBe(false);
    expect([isSafeId("abc"), isSafeId("abc"), isSafeId("abc")]).toEqual([true, true, true]);
  });
});

describe("isFlowShape（Rust と共有の fixture）", () => {
  it("fixture には通る形と通らない形の両方があり、名前が重ならない", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.some((item) => item.valid)).toBe(true);
    expect(cases.some((item) => !item.valid)).toBe(true);
    expect(new Set(cases.map((item) => item.name)).size).toBe(cases.length);
  });

  for (const item of cases) {
    it(`${item.valid ? "通す" : "断る"}: ${item.name}`, () => {
      expect(isFlowShape(item.flow)).toBe(item.valid);
    });
  }

  it("テンプレートと白紙の工程設計は、どれも形が合う", () => {
    expect(isFlowShape(createBlankFlow("blank"))).toBe(true);
    for (const template of FLOW_TEMPLATES) {
      expect(isFlowShape(createFlowFromTemplate(template, "f")), template.id).toBe(true);
    }
  });
});

describe("部品の検査", () => {
  it("用語は 4 欄がそろい、variants が文字列の配列であること", () => {
    expect(isGlossaryEntryShape({ term: "鎌倉", reading: "かまくら", variants: [], note: "" })).toBe(true);
    expect(isGlossaryEntryShape({ term: "鎌倉", reading: "かまくら", variants: ["a"], note: "", extra: 1 })).toBe(true);
    expect(isGlossaryEntryShape({ term: "鎌倉", reading: "かまくら", variants: [1], note: "" })).toBe(false);
    expect(isGlossaryEntryShape({ term: "鎌倉", reading: "かまくら", note: "" })).toBe(false);
    expect(isGlossaryEntryShape(null)).toBe(false);
  });

  it("お手本は chars と truncatedFrom が 0 以上の整数であること（sourceUrl は見ない）", () => {
    expect(isFlowSampleShape({ id: "s", name: "n", chars: 0 })).toBe(true);
    expect(isFlowSampleShape({ id: "s", name: "n", chars: 3, truncatedFrom: 9, sourceUrl: 1 })).toBe(true);
    expect(isFlowSampleShape({ id: "s", name: "n", chars: 3.5 })).toBe(false);
    expect(isFlowSampleShape({ id: "s", name: "n", chars: 3, truncatedFrom: -1 })).toBe(false);
    expect(isFlowSampleShape({ id: "s", name: "n", chars: Number.NaN })).toBe(false);
    expect(isFlowSampleShape({ id: "s", name: "n", chars: Number.POSITIVE_INFINITY })).toBe(false);
  });

  it("工程は 4 欄がそろい、provider は無いか 3 つのどれか。id の文字の規則はここでは見ない", () => {
    expect(isFlowStepShape({ id: "a", name: "n", instruction: "i", profile: "p" })).toBe(true);
    expect(isFlowStepShape({ id: "a b", name: "n", instruction: "i", profile: "p", provider: "gpt", output: { mode: "single" } })).toBe(true);
    expect(isFlowStepShape({ id: "a", name: "n", instruction: "i", profile: "p", provider: "other" })).toBe(false);
    expect(isFlowStepShape({ id: "a", name: "n", profile: "p" })).toBe(false);
  });

  it("固定したモデルは provider・model・effort の 3 欄を見る（表示用の欄は見ない）", () => {
    expect(isSnapshotModelShape({ provider: "gemini", model: "m", effort: "high" })).toBe(true);
    expect(isSnapshotModelShape({ provider: "gemini", model: "m", effort: "high", profileId: 1, redirected: "yes" })).toBe(true);
    expect(isSnapshotModelShape({ provider: "gemini", model: "", effort: "high" })).toBe(false);
    expect(isSnapshotModelShape({ provider: "gemini", model: "m", effort: "extreme" })).toBe(false);
    expect(isSnapshotModelShape({ provider: "other", model: "m", effort: "low" })).toBe(false);
    expect(isSnapshotModelShape({ provider: "gemini", effort: "low" })).toBe(false);
  });

  it("info は話者人数と言語の 2 欄だけ（案件の固有名詞・背景など知らない欄は断る）、source は音声の写し（file・hash）か文章", () => {
    expect(isStoredRecordingInfoShape({ speakers: "4plus", language: "en" })).toBe(true);
    expect(isStoredRecordingInfoShape({ speakers: "4plus", language: "en", extra: 1 })).toBe(false);
    expect(isStoredRecordingInfoShape({ speakers: "auto", language: "ja", background: "上書きしたい背景", terms: [] })).toBe(false);
    expect(isStoredRecordingInfoShape({ speakers: "5", language: "en" })).toBe(false);
    expect(isStoredRecordingInfoShape({ speakers: "auto" })).toBe(false);
    expect(isStoredRecordingSourceShape({ kind: "text" })).toBe(true);
    expect(isStoredRecordingSourceShape({ kind: "audio", audio: [] })).toBe(true);
    expect(isStoredRecordingSourceShape({ kind: "audio", audio: [{ file: "a.m4a", hash: HASH }] })).toBe(true);
    expect(isStoredRecordingSourceShape({ kind: "audio", audio: [{ file: "a.m4a", hash: "abc" }] })).toBe(false);
    expect(isStoredRecordingSourceShape({ kind: "audio", audio: [{ file: "", hash: HASH }] })).toBe(false);
    expect(isStoredRecordingSourceShape({ kind: "audio" })).toBe(false);
    expect(isStoredRecordingSourceShape({ kind: "video" })).toBe(false);
  });
});

describe("isFlowSnapshotShape（録音に固定する Flow の写し）", () => {
  it("createFlowSnapshot の出力は、どのテンプレートでも・どの方式でも通る（JSON に書いて読み直しても）", () => {
    for (const template of FLOW_TEMPLATES) {
      const flow = createFlowFromTemplate(template, "f");
      const subscription = createFlowSnapshot(flow, defaultProfiles(), PROVIDER_IDS);
      const apiKey = createFlowSnapshot(flow, defaultProfiles("apiKey"), PROVIDER_IDS, "apiKey");
      for (const made of [subscription, apiKey]) {
        expect(isFlowSnapshotShape(made), template.id).toBe(true);
        expect(isFlowSnapshotShape(JSON.parse(JSON.stringify(made))), template.id).toBe(true);
      }
    }
  });

  it("登録した AI が無くて models に無い工程があっても通る（工程を動かすときに止める）", () => {
    const flow = createFlowFromTemplate(FLOW_TEMPLATES[0]!, "f");
    const made = createFlowSnapshot(flow, defaultProfiles(), []);
    expect(Object.keys(made.models)).toEqual([]);
    expect(isFlowSnapshotShape(made)).toBe(true);
  });

  it("Flow の欄が足りない写しは通さない（既定値で補わない）", () => {
    for (const key of ["version", "id", "name", "revision", "guide", "terms", "samples", "steps", "models"]) {
      const broken = mutated(snapshot(), (draft) => delete draft[key]);
      expect(isFlowSnapshotShape(broken), key).toBe(false);
    }
  });

  it("工程 id が安全な id でない写し・models が表でない写しは通さない", () => {
    expect(isFlowSnapshotShape(mutated(snapshot(), (draft) => { draft.steps[0].id = "../a"; }))).toBe(false);
    expect(isFlowSnapshotShape(mutated(snapshot(), (draft) => { draft.steps[0].id = ""; }))).toBe(false);
    expect(isFlowSnapshotShape(mutated(snapshot(), (draft) => { draft.models = []; }))).toBe(false);
    expect(isFlowSnapshotShape(mutated(snapshot(), (draft) => { draft.models = null; }))).toBe(false);
    expect(isFlowSnapshotShape(mutated(snapshot(), (draft) => { draft.models.a.effort = "extreme"; }))).toBe(false);
    expect(isFlowSnapshotShape(mutated(snapshot(), (draft) => { draft.models.a.provider = "other"; }))).toBe(false);
    expect(isFlowSnapshotShape(mutated(snapshot(), (draft) => { draft.models.a.model = ""; }))).toBe(false);
    expect(isFlowSnapshotShape(mutated(snapshot(), (draft) => { draft.models.a = null; }))).toBe(false);
  });

  it("知らない欄・工程が持たない models の欄があっても通る", () => {
    expect(isFlowSnapshotShape(mutated(snapshot(), (draft) => { draft.futureField = 1; draft.models.zzz = { provider: "gpt", model: "m", effort: "low" }; }))).toBe(true);
  });
});

describe("isStoredRecordingShape（recording.json）", () => {
  it("そろった録音は通る。文章の録音・参考ページ・知らない欄・音声の補足の欄があっても通る", () => {
    expect(isStoredRecordingShape(recording())).toBe(true);
    expect(isStoredRecordingShape(mutated(recording(), (draft) => { draft.source = { kind: "text" }; }))).toBe(true);
    expect(isStoredRecordingShape(mutated(recording(), (draft) => { draft.refs = ["doc_1", "Doc-2"]; }))).toBe(true);
    expect(isStoredRecordingShape(mutated(recording(), (draft) => { draft.moveGeneration = 2; draft.candidateSets = {}; }))).toBe(true);
  });

  it("欄が足りない録音は通さない（refs・info・source・flowSnapshot の中身も既定値で補わない）", () => {
    const missing: Array<[string, (draft: any) => void]> = [
      ["version", (draft) => delete draft.version],
      ["id", (draft) => delete draft.id],
      ["pageId", (draft) => delete draft.pageId],
      ["flowSnapshot", (draft) => delete draft.flowSnapshot],
      ["flowSnapshot.version", (draft) => delete draft.flowSnapshot.version],
      ["flowSnapshot.id", (draft) => delete draft.flowSnapshot.id],
      ["flowSnapshot.name", (draft) => delete draft.flowSnapshot.name],
      ["flowSnapshot.guide", (draft) => delete draft.flowSnapshot.guide],
      ["flowSnapshot.terms", (draft) => delete draft.flowSnapshot.terms],
      ["flowSnapshot.samples", (draft) => delete draft.flowSnapshot.samples],
      ["flowSnapshot.models", (draft) => delete draft.flowSnapshot.models],
      ["info", (draft) => delete draft.info],
      ["info.speakers", (draft) => delete draft.info.speakers],
      ["info.language", (draft) => delete draft.info.language],
      ["source", (draft) => delete draft.source],
      ["refs", (draft) => delete draft.refs],
    ];
    for (const [name, change] of missing) {
      expect(isStoredRecordingShape(mutated(recording(), change)), name).toBe(false);
    }
  });

  it("値が合わない録音は通さない", () => {
    const wrong: Array<[string, (draft: any) => void]> = [
      ["version が 2", (draft) => { draft.version = 2; }],
      ["id に空白", (draft) => { draft.id = "rec one"; }],
      ["pageId にスラッシュ", (draft) => { draft.pageId = "a/b"; }],
      ["info.speakers が範囲外", (draft) => { draft.info.speakers = "5"; }],
      ["info.language が範囲外", (draft) => { draft.info.language = "fr"; }],
      ["info に知らない欄（案件の背景で上書きできてしまう）", (draft) => { draft.info.background = "上書き"; }],
      ["source.kind が範囲外", (draft) => { draft.source = { kind: "video" }; }],
      ["音声の hash が短い", (draft) => { draft.source.audio[0].hash = "abc"; }],
      ["音声の file が空", (draft) => { draft.source.audio[0].file = ""; }],
      ["音声の一覧が配列でない", (draft) => { draft.source.audio = {}; }],
      ["refs が配列でない", (draft) => { draft.refs = "doc_1"; }],
      ["refs に安全でない id", (draft) => { draft.refs = ["../doc"]; }],
      ["flowSnapshot が null", (draft) => { draft.flowSnapshot = null; }],
    ];
    for (const [name, change] of wrong) {
      expect(isStoredRecordingShape(mutated(recording(), change)), name).toBe(false);
    }
    for (const value of [null, [], "recording", 1]) {
      expect(isStoredRecordingShape(value)).toBe(false);
    }
  });
});
