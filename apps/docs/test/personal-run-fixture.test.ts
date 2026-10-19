import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SOURCE_STEP_ID, type RunRecord } from "@niho/docs-core";
import { latestVersionRecord, versionsOf } from "../src/lib/project-view";
import {
  canonical,
  projectPersonalRunEvent,
  sha256Text,
  type PersonalRunEvent,
  type PersonalRunHistory,
  type PersonalRunRecord,
  type PersonalVersionRef,
} from "../src/lib/personal-execution";

/**
 * 実 Native writer の golden fixture（Rust の personal_run_tests.rs `the_native_writer_output_matches_the_c1_fixture` が生成・照合）を、
 * 画面・Web（#18741）が読む型と履歴の読み方に載せる。fixture を書き直すのは Rust 側だけ（NIHO_DOCS_UPDATE_GOLDEN=1）。
 */

type GoldenCase = {
  setup: { previousSourceVersion: string | null; currentBodies: Partial<Record<string, string>> };
  identity: { ownerAccountId: string; rootId: string; projectId: string; recordingPageId: string; recordingId: string; intentId: string; runId: string; nativeDeviceId: string };
  inputs: { snapshotSha256: string[]; expectedCurrentSha: Record<string, string | null>; events: unknown[]; records: unknown[]; aggregates: unknown[] };
  outputs: {
    published: Array<{ status: string; version: unknown; displayVersion: number; localSaved: boolean; cloudAcked: boolean }>;
    files: Record<string, string>;
    runs: unknown[];
    aggregates: unknown[];
  };
};

const fixture = JSON.parse(readFileSync(new URL("./fixtures/personal-run-c1.json", import.meta.url), "utf8")) as { cases: Record<"fresh" | "withExisting", GoldenCase> };
const SHA = /^[a-f0-9]{64}$/;
const VERSION_KEYS = ["bytes", "origin", "originRunId", "path", "sha256", "versionId"];
const HISTORY_KEYS = [
  "at", "basisSnapshotSha256", "continuationOfRunId", "intentId", "origin", "originDeviceId", "recordingId", "recordingPageId",
  "remoteRunId", "remoteState", "retainedCandidates", "runId", "schemaVersion", "sourceVersion", "state", "transcriptionExecutions", "versions",
];

function asVersionRef(value: unknown): PersonalVersionRef {
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => key !== "displayVersion").sort();
  expect(keys).toEqual(VERSION_KEYS);
  expect(record.sha256).toMatch(SHA);
  expect(Number.isSafeInteger(record.bytes)).toBe(true);
  expect(record.origin).toBe("this_pc");
  if ("displayVersion" in record) expect(Number.isSafeInteger(record.displayVersion) && (record.displayVersion as number) > 0).toBe(true);
  return record as unknown as PersonalVersionRef;
}

function asHistory(value: unknown): PersonalRunHistory {
  const record = value as Record<string, unknown>;
  expect(Object.keys(record).sort()).toEqual([...HISTORY_KEYS].sort());
  expect(record.schemaVersion).toBe(1);
  (record.versions as unknown[]).forEach(asVersionRef);
  if (record.sourceVersion !== null) asVersionRef(record.sourceVersion);
  return record as unknown as PersonalRunHistory;
}

/** runs.jsonl の行（自動の「保存」の行は Native が `auto: true` を付ける）。 */
type Row = RunRecord & { auto?: boolean };

/** runs.jsonl の行。本人 Mac 実行の公開の行は出どころの欄を必ず持つ（前からある行・自動の「保存」の行は持たない）。 */
function rowsOf(golden: GoldenCase): Row[] {
  return golden.outputs.runs.map((value) => {
    const record = value as Record<string, unknown>;
    if (record.personalRunId !== undefined) {
      expect(record).toMatchObject({ kind: "run", result: "saved", personalRunId: golden.identity.runId, origin: "this_pc", originDeviceId: golden.identity.nativeDeviceId });
      expect(record.versionSha256).toMatch(SHA);
      expect(record.inputBasisSha256).toMatch(SHA);
      expect(record.id).not.toBe(record.personalRunId);
    }
    expect(Number.isSafeInteger(record.version)).toBe(true);
    return record as unknown as Row;
  });
}

describe.each(Object.entries(fixture.cases))("実 Native writer の fixture（personal-run-c1.json の %s）", (name, golden) => {
  const runs = rowsOf(golden);
  const finalAggregate = asHistory(golden.outputs.aggregates.at(-1));
  const [publishedSource, publishedOutline] = golden.outputs.published;
  const file = (path: string): string | undefined => golden.outputs.files[path];

  it("runs.jsonl の行が履歴の読み方（versionsOf・latestVersionRecord）に数値の版・versionPath・出どころつきで載る", () => {
    const [basisSource, basisOutline] = golden.inputs.snapshotSha256;
    const source = latestVersionRecord(runs, SOURCE_STEP_ID) as PersonalRunRecord;
    expect(source).toMatchObject({
      version: publishedSource!.displayVersion,
      versionPath: finalAggregate.versions[0]!.path,
      versionSha256: finalAggregate.versions[0]!.sha256,
      provider: "this-mac",
      model: "niho-speech",
      reportedModel: null,
      modelUsed: null,
      inputBasisSha256: basisSource,
    });
    expect(source.effort).toBeUndefined();
    const outline = latestVersionRecord(runs, "outline") as PersonalRunRecord;
    expect(outline).toMatchObject({
      version: publishedOutline!.displayVersion,
      versionPath: finalAggregate.versions[1]!.path,
      provider: "claude",
      model: "claude-sonnet-5",
      reportedModel: "claude-sonnet-5",
      modelUsed: "claude-sonnet-5",
      effort: "high",
      inputBasisSha256: basisOutline,
      sourceVersionId: finalAggregate.sourceVersion!.versionId,
      // runner の実行の詳細も行に残る
      connection: "subscription",
      inputChars: 321,
      tokensKnown: true,
    });
  });

  it("版の件数と並び（新しい順）。人の手直しは公開の前に自動の「保存」の版として残る", () => {
    const shape = (stepId: string) => (versionsOf(runs, stepId) as Row[]).map((run) => [run.version, run.kind, run.auto === true]);
    if (name === "fresh") {
      expect(shape(SOURCE_STEP_ID)).toEqual([[1, "run", false]]);
      expect(shape("outline")).toEqual([[1, "run", false]]);
      expect(golden.inputs.expectedCurrentSha).toEqual({ source: null, outline: null });
      return;
    }
    expect(shape(SOURCE_STEP_ID)).toEqual([[3, "run", false], [2, "save", true], [1, "run", false]]);
    expect(shape("outline")).toEqual([[2, "run", false], [1, "save", true]]);
    for (const stepId of [SOURCE_STEP_ID, "outline"]) {
      const saved = (versionsOf(runs, stepId) as Row[]).find((run) => run.auto)!;
      const body = file(saved.versionPath!);
      expect(body).toBe(golden.setup.currentBodies[stepId]);
      expect(saved).toMatchObject({ result: "saved", originDeviceId: golden.identity.nativeDeviceId, versionPath: `recordings/rec1/versions/${stepId}/<auto>.md` });
    }
    expect(versionsOf(runs, SOURCE_STEP_ID).at(-1)!.versionPath).toBeDefined();
    expect(file(versionsOf(runs, SOURCE_STEP_ID).at(-1)!.versionPath!)).toBe(golden.setup.previousSourceVersion);
  });

  it("受付時の照合値は公開の前の現在本文の sha（人の手直しを上書きせず、版に残してから公開した）", async () => {
    for (const stepId of [SOURCE_STEP_ID, "outline"]) {
      const body = golden.setup.currentBodies[stepId];
      expect(golden.inputs.expectedCurrentSha[stepId]).toBe(body === undefined ? null : await sha256Text(body));
    }
  });

  it("版のファイルの中身が行・集約の SHA-256 と大きさに一致し、現在本文は公開した版", async () => {
    for (const run of runs) {
      const text = file(run.versionPath!);
      expect(text).toBeDefined();
      expect(await sha256Text(text!)).toBe(run.versionSha256);
    }
    for (const version of finalAggregate.versions) {
      const text = file(version.path);
      expect(await sha256Text(text!)).toBe(version.sha256);
      expect(new TextEncoder().encode(text!).byteLength).toBe(version.bytes);
    }
    const prefix = `recordings/${golden.identity.recordingId}/`;
    expect(file(`${prefix}transcript.md`)).toBe(file(finalAggregate.versions[0]!.path));
    expect(file(`${prefix}artifacts/outline.md`)).toBe(file(finalAggregate.versions[1]!.path));
  });

  it("集約・runs.jsonl の行・公開の返り値の数値の版が同じ（Native が集約にも同じ番号を付ける）", () => {
    golden.outputs.published.forEach((published, index) => {
      const version = asVersionRef(published.version);
      expect(published).toMatchObject({ status: "committed", localSaved: true, cloudAcked: false });
      expect(Object.keys(published.version as object)).not.toContain("displayVersion");
      const row = runs.find((run) => run.versionPath === version.path)!;
      expect(row.version).toBe(published.displayVersion);
      const after = asHistory(golden.outputs.aggregates[index]);
      expect(after.versions.find((item) => item.versionId === version.versionId)?.displayVersion).toBe(published.displayVersion);
      // 渡した集約は番号なしで、Native が同じ版にだけ番号を付けた
      const sent = asHistory(golden.inputs.aggregates[index]);
      const stamp = (item: PersonalVersionRef) => (item.versionId === version.versionId ? { ...item, displayVersion: published.displayVersion } : item);
      expect(after).toEqual({ ...sent, versions: sent.versions.map(stamp), sourceVersion: sent.sourceVersion ? stamp(sent.sourceVersion) : null });
    });
    // 最後の集約（personal_record）は受け取ったまま
    expect(finalAggregate).toEqual(asHistory(golden.inputs.aggregates.at(-1)));
    expect(finalAggregate.state).toBe("completed");
    expect(finalAggregate.versions.map((version) => version.displayVersion)).toEqual(
      finalAggregate.versions.map((version) => runs.find((run) => run.versionPath === version.path)!.version),
    );
  });

  it("Native に渡した event と行は TS の controller の作り方と同じ（event id・projectPersonalRunEvent）", async () => {
    for (const [index, value] of golden.inputs.events.entries()) {
      const event = value as PersonalRunEvent;
      const expectedId = `r6-${await sha256Text(canonical({
        intentId: golden.identity.intentId, stepId: event.stepId, state: event.state, versionId: event.version?.versionId ?? null, remoteRunId: event.remoteRunId, at: event.at,
      }))}`;
      expect(event.eventId).toBe(expectedId);
      const projected = await projectPersonalRunEvent(event);
      expect(projected?.version).toBeNull();
      expect(golden.inputs.records[index]).toMatchObject(JSON.parse(JSON.stringify(projected)) as object);
      // 公開した後は Native の番号で埋まる（表示上だけの番号は作らない）
      const row = runs.find((run) => run.versionPath === event.version?.path)!;
      const numbered = await projectPersonalRunEvent({ ...event, version: { ...event.version!, displayVersion: row.version! } });
      expect(numbered?.version).toBe(row.version);
    }
    expect(golden.inputs.records[0]).toEqual(JSON.parse(JSON.stringify(await projectPersonalRunEvent(golden.inputs.events[0] as PersonalRunEvent))));
  });
});
