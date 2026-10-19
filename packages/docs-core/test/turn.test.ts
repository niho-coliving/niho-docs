import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REASON_CODES,
  TURN_EVENT_SCHEMA_VERSION,
  parseTurnEnvelope,
  parseTurnEvent,
  reasonMessage,
  turnSequenceIssues,
  type TurnEvent,
} from "../src/index.js";

/** 共有の fixture（apps/docs/fixtures/turn-events/）。Rust のテスト（local_ai_tests.rs。crate を偽の CLI で動かす）も同じものを読む。 */
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps", "docs", "fixtures", "turn-events");

type Fixture = { schemaVersion: number; scenario: string; events: unknown[] };

function fixtures(): Fixture[] {
  return readdirSync(fixtureDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(fixtureDir, file), "utf8")) as Fixture);
}

describe("turn-events の fixture", () => {
  it("正常・停止・時間切れ・壊れた JSONL・修正の会話のツールの 5 本がある", () => {
    expect(fixtures().map((fixture) => fixture.scenario)).toEqual(["invalid-stream", "normal", "stopped", "timeout", "tools"]);
  });

  for (const fixture of fixtures()) {
    it(`${fixture.scenario}: schemaVersion ${TURN_EVENT_SCHEMA_VERSION} の形で、最後の 1 つだけが Done か Error`, () => {
      expect(fixture.schemaVersion).toBe(TURN_EVENT_SCHEMA_VERSION);
      const events = fixture.events.map((value) => parseTurnEvent(value));
      expect(events.every((event) => event !== null), JSON.stringify(fixture.events)).toBe(true);
      const parsed = events as TurnEvent[];
      expect(turnSequenceIssues(parsed)).toEqual([]);
      const last = parsed[parsed.length - 1]!;
      // 失敗の文は crate が提供元の名前と理由を入れて作る（docs-core の文は空のときの控え）
      if (last.type === "Error") expect(last.message.length).toBeGreaterThan(0);
    });
  }

  it("停止は Stopped の Done、時間切れは Timeout、壊れた JSONL は result が無いので TransientFailure", () => {
    const last = (scenario: string) => {
      const fixture = fixtures().find((candidate) => candidate.scenario === scenario)!;
      return parseTurnEvent(fixture.events[fixture.events.length - 1]);
    };
    // Claude Code の total_cost_usd（API 換算の見込み）は持ち出さない。モデルは依頼したモデル名
    expect(last("normal")).toMatchObject({
      type: "Done",
      stop_reason: "EndTurn",
      continuations: 0,
      usage: { input_tokens: 120, output_tokens: 30, cost_usd: null, model_used: "claude-sonnet-fixture", cost_known: false },
    });
    expect(last("stopped")).toMatchObject({ type: "Done", stop_reason: "Stopped", text: "# 見出し\n" });
    expect(last("timeout")).toMatchObject({ type: "Error", reason_code: "Timeout" });
    expect(last("invalid-stream")).toMatchObject({ type: "Error", reason_code: "TransientFailure" });
  });

  it("修正の会話: ツールはファイル名と成否だけ、Done.text は返答（最後のツールの後の文）", () => {
    const fixture = fixtures().find((candidate) => candidate.scenario === "tools")!;
    const events = fixture.events.map((value) => parseTurnEvent(value)) as TurnEvent[];
    expect(events.filter((event) => event.type === "ToolUse")).toEqual([
      { type: "ToolUse", id: "toolu_read", name: "Read", summary: "k7m2q9xa.md" },
      { type: "ToolUse", id: "toolu_edit", name: "Edit", summary: "k7m2q9xa.md" },
    ]);
    expect(events.filter((event) => event.type === "ToolResult").map((event) => event.type === "ToolResult" && event.ok)).toEqual([true, true]);
    expect(events[events.length - 1]).toMatchObject({ type: "Done", text: "見出しを短くしました。" });
    // フォルダのパス・読んだ中身・書き換えの本文はイベントに出ない
    const shown = JSON.stringify(fixture.events);
    expect(shown).not.toContain("NIHO docs/projects");
    expect(shown).not.toContain("とても長い見出し");
  });
});

describe("parseTurnEvent", () => {
  it("形の合わないイベントは null", () => {
    expect(parseTurnEvent({ type: "TextDelta" })).toBeNull();
    expect(parseTurnEvent({ type: "ToolUse", id: "t", name: "Read" })).toBeNull();
    expect(parseTurnEvent({ type: "ToolResult", id: "t", name: "Read", ok: "yes" })).toBeNull();
    expect(parseTurnEvent({ type: "ToolResult", id: "t", name: "Edit", ok: false })).toEqual({
      type: "ToolResult",
      id: "t",
      name: "Edit",
      ok: false,
    });
    expect(parseTurnEvent({ type: "Error", reason_code: "Nope", message: "x" })).toBeNull();
    expect(
      parseTurnEvent({
        type: "Done",
        text: "x",
        stop_reason: "EndTurn",
        session_id: null,
        usage: { input_tokens: 1, output_tokens: 1, cost_usd: null, model_used: null },
        duration_ms: 1,
        continuations: 0,
      }),
    ).toBeNull();
    // 続きの回数（crate が同じ実行の中で頼んだ回数）が無い Done も形が合わない
    expect(
      parseTurnEvent({
        type: "Done",
        text: "x",
        stop_reason: "EndTurn",
        session_id: null,
        usage: { input_tokens: 1, output_tokens: 1, cost_usd: null, model_used: null, cost_known: false },
        duration_ms: 1,
      }),
    ).toBeNull();
    expect(parseTurnEnvelope({ turnId: "t", seq: 0, event: { type: "TextDelta", text: "a" } })).toEqual({
      turnId: "t",
      seq: 0,
      event: { type: "TextDelta", text: "a" },
    });
  });

  it("理由コードにはどれも文言がある。Done が 2 回の並びは食い違い", () => {
    expect(REASON_CODES.every((code) => reasonMessage(code).length > 0)).toBe(true);
    expect(reasonMessage("ModelNotFound")).toMatch(/^設定のモデルが使えません。/);
    const done: TurnEvent = {
      type: "Done",
      text: "",
      stop_reason: "EndTurn",
      session_id: null,
      usage: { input_tokens: 0, output_tokens: 0, cost_usd: null, model_used: null, cost_known: false },
      duration_ms: 0,
      continuations: 0,
    };
    expect(turnSequenceIssues([done, done])).toEqual(["terminal events: 2"]);
    expect(turnSequenceIssues([{ type: "TextDelta", text: "a" }])).toEqual(["terminal events: 0", "last event is not terminal"]);
  });
});
