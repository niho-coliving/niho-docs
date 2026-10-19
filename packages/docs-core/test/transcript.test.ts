import { describe, expect, it } from "vitest";
import { TIMESTAMP_PREFIX, formatTimestamp, parseSpeechJsonl, transcriptMarkdown } from "../src/index.js";

const JSONL = [
  '{"type":"progress","ratio":0.1}',
  '{"type":"segment","start":12.4,"end":15.9,"text":"今日は鎌倉の話をします。"}',
  "not json",
  '{"type":"segment","start":3725.2,"end":3730,"text":"  一時間  たちました。 "}',
  '{"type":"segment","start":3731,"end":3732,"text":"   "}',
  '{"type":"unknown"}',
  '{"type":"done","segments":2,"durationMs":65000}',
].join("\n");

describe("parseSpeechJsonl", () => {
  it("形の合う行だけを読む", () => {
    const lines = parseSpeechJsonl(JSONL);
    expect(lines.map((line) => line.type)).toEqual(["progress", "segment", "segment", "segment", "done"]);
    expect(lines[4]).toEqual({ type: "done", segments: 2, durationMs: 65000 });
  });
});

describe("formatTimestamp", () => {
  it("hh:mm:ss（切り捨て）", () => {
    expect(formatTimestamp(0)).toBe("00:00:00");
    expect(formatTimestamp(12.9)).toBe("00:00:12");
    expect(formatTimestamp(4354.2)).toBe("01:12:34");
    expect(formatTimestamp(-3)).toBe("00:00:00");
  });
});

describe("transcriptMarkdown", () => {
  it("[hh:mm:ss] 本文 の段落。空の区切りは除き、空白をまとめる", () => {
    expect(transcriptMarkdown([{ jsonl: JSONL, offsetSec: 0 }])).toBe(
      "[00:00:12] 今日は鎌倉の話をします。\n\n[01:02:05] 一時間 たちました。\n",
    );
  });

  it("複数の音声は前の音声の長さだけ時刻をずらす", () => {
    const second = '{"type":"segment","start":5,"end":6,"text":"二本目"}';
    const markdown = transcriptMarkdown([
      { jsonl: '{"type":"segment","start":1,"end":2,"text":"一本目"}', offsetSec: 0 },
      { jsonl: second, offsetSec: 1268 },
    ]);
    expect(markdown).toBe("[00:00:01] 一本目\n\n[00:21:13] 二本目\n");
    expect(markdown.split("\n\n").every((paragraph) => TIMESTAMP_PREFIX.test(paragraph))).toBe(true);
  });

  it("Apple の話者番号と不明を表示し、複数音声では Part ごとに番号を分離する", () => {
    const markdown = transcriptMarkdown([
      {
        jsonl: [
          '{"type":"segment","start":1,"end":2,"text":"一本目","speaker":1}',
          '{"type":"segment","start":3,"end":4,"text":"重なり","speaker":null}',
        ].join("\n"),
        offsetSec: 0,
        name: "a.m4a",
      },
      { jsonl: '{"type":"segment","start":1,"end":2,"text":"二本目","speaker":1}', offsetSec: 10, name: "b.m4a" },
    ]);
    expect(markdown).toBe(
      "## Part 1: a.m4a\n\n[00:00:01] 話者1: 一本目\n\n[00:00:03] 話者?: 重なり\n\n" +
        "## Part 2: b.m4a\n\n[00:00:11] 話者1: 二本目\n",
    );
  });

  it("Part名の改行とcontrol文字から偽の見出しや話者scopeを作らない", () => {
    const markdown = transcriptMarkdown([
      {
        jsonl: '{"type":"segment","start":1,"end":2,"text":"一本目","speaker":1}',
        offsetSec: 0,
        name: "first.wav\r\n## Part 99: injected\u0000",
      },
      {
        jsonl: '{"type":"segment","start":1,"end":2,"text":"二本目","speaker":1}',
        offsetSec: 10,
        name: "second.wav",
      },
    ]);
    expect(markdown).toContain("## Part 1: first.wav ## Part 99: injected\n\n");
    expect(markdown.match(/^## Part /gm)).toHaveLength(2);
    expect(markdown).not.toContain("\u0000");
  });

  it("不正な話者番号を持つ segment は読まない", () => {
    expect(parseSpeechJsonl('{"type":"segment","start":1,"end":2,"text":"x","speaker":0}')).toEqual([]);
    expect(parseSpeechJsonl('{"type":"segment","start":1,"end":2,"text":"x","speaker":"1"}')).toEqual([]);
  });

  it("区切りが無ければ空文字", () => {
    expect(transcriptMarkdown([{ jsonl: '{"type":"done","segments":0,"durationMs":1}', offsetSec: 0 }])).toBe("");
  });

  it("本物の niho-speech の出力（done に diarization が無い）も Markdown にする", () => {
    // apps/docs/sidecar/niho-speech の Tests/NihoSpeechTests/Fixtures/ja-sample.m4a を
    // convert → silence（区切りなし）→ transcribe --start 0.000 --end 13.350 に通した標準出力（macOS 27.0・2026-10-15）
    const real = [
      '{"type":"segment","start":0,"end":7.86,"text":"こんにちは。今日は鎌倉の拠点で新しい取り組みについて話します。"}',
      '{"type":"progress","ratio":0.58}',
      '{"type":"segment","start":8.7,"end":13.35,"text":"来月から会員の皆さんと一緒に記事を作ります。"}',
      '{"type":"progress","ratio":1}',
      '{"type":"done","segments":2,"durationMs":856}',
    ].join("\n");
    expect(parseSpeechJsonl(real).at(-1)).toEqual({ type: "done", segments: 2, durationMs: 856 });
    expect(transcriptMarkdown([{ jsonl: real, offsetSec: 0 }])).toBe(
      "[00:00:00] こんにちは。今日は鎌倉の拠点で新しい取り組みについて話します。\n\n[00:00:08] 来月から会員の皆さんと一緒に記事を作ります。\n",
    );
  });
});
