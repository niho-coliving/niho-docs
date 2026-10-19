import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSpeechResult, speechResultTranscriptMarkdown, type SpeechResultV1 } from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "speech-result-v1");
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

function parsed(name: string): SpeechResultV1 {
  const result = parseSpeechResult(fixture(name));
  if (!result.ok) throw new Error(result.issues.join("\n"));
  return result.value;
}

function issuesFor(mutate: (value: Record<string, any>) => void): string[] {
  const value = fixture("two-speakers.json") as Record<string, any>;
  mutate(value);
  const result = parseSpeechResult(value);
  return result.ok ? [] : result.issues;
}

describe("parseSpeechResult", () => {
  it("accepts the shared fixtures and keeps unknown speakers as null", () => {
    const two = parsed("two-speakers.json");
    expect(two.speakerMode).toBe("2");
    expect(new Set(two.segments.flatMap((segment) => (segment.speaker === null ? [] : [segment.speaker])))).toEqual(new Set([1, 2]));
    expect(two.segments.some((segment) => segment.speaker === null)).toBe(true);
    expect(parsed("no-diarization.json").engine.diarizer).toBeNull();
  });

  it("accepts what the iPhone writes (NihoLocalSpeechCoreTests compares its export with this file)", () => {
    const ios = parsed("ios-export.json");
    expect(ios.engine.diarizer).toEqual({ name: "fluidaudio-offline-diarizer", version: "0.15.6", modelRevision: "7eab74f3463c736418d0eb10296261ae581146c9" });
    expect(ios.speakerNames).toBeUndefined();
  });

  it("drops unknown fields but keeps human-confirmed names and untimed text", () => {
    const edge = parsed("edge-cases.json");
    expect(edge).not.toHaveProperty("futureField");
    expect(edge.speakerNames).toEqual({ 1: "山田" });
    expect(edge.segments[0]).toEqual({ start: null, end: null, text: "（注記）", speaker: null });
  });

  it.each<[string, (value: Record<string, any>) => void, RegExp]>([
    ["other schema", (value) => { value.schema = "niho.other"; }, /schema/u],
    ["future version", (value) => { value.version = 2; }, /version 2/u],
    ["unknown language", (value) => { value.language = "fr"; }, /language/u],
    ["unknown speaker mode", (value) => { value.speakerMode = "5"; }, /speakerMode/u],
    ["uppercase hash", (value) => { value.input.sha256 = value.input.sha256.toUpperCase(); }, /sha256/u],
    ["zero bytes", (value) => { value.input.bytes = 0; }, /bytes/u],
    ["missing diarizer", (value) => { value.engine.diarizer = null; }, /diarizer/u],
    ["half timed segment", (value) => { value.segments[1].end = null; }, /両方/u],
    ["end before start", (value) => { value.segments[1].end = value.segments[1].start - 1; }, /範囲/u],
    ["end beyond audio", (value) => { value.segments.at(-1).end = value.input.durationSeconds + 1; }, /長さ/u],
    ["out of order", (value) => { value.segments.reverse(); }, /時刻順/u],
    ["speaker zero", (value) => { value.segments[0].speaker = 0; }, /speaker/u],
    ["empty text", (value) => { value.segments[0].text = " "; }, /text/u],
    ["name for absent speaker", (value) => { value.speakerNames = { 9: "誰か" }; }, /無い話者/u],
    ["padded name", (value) => { value.speakerNames = { 1: " 山田" }; }, /空白/u],
    ["long name", (value) => { value.speakerNames = { 1: "あ".repeat(61) }; }, /60 文字/u],
  ])("rejects %s", (_label, mutate, pattern) => {
    expect(issuesFor(mutate).join("\n")).toMatch(pattern);
  });

  it("rejects speaker numbers on a result without diarization", () => {
    const value = fixture("no-diarization.json") as Record<string, any>;
    value.segments[0].speaker = 1;
    const result = parseSpeechResult(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join("\n")).toMatch(/話者分離をしていない/u);
  });
});

describe("speechResultTranscriptMarkdown", () => {
  it("writes the same recording-page transcript as the Mac sidecar path", () => {
    const markdown = speechResultTranscriptMarkdown(parsed("edge-cases.json"));
    expect(markdown).toBe(
      [
        "[00:00:00] 話者?: （注記）",
        "[00:00:00] 話者1: 今日は庭の手入れの話です。",
        "[00:00:03] 話者?: はい、",
        "[00:00:04] 話者2: 道具をそろえるところから始めましょう。",
        "[00:00:08] 話者1: それなら私が下書きを作ってきます。",
      ].join("\n\n") + "\n",
    );
  });

  it("does not label speakers when diarization was off", () => {
    expect(speechResultTranscriptMarkdown(parsed("no-diarization.json"))).toBe("[00:00:00] Hello there.\n");
  });
});
