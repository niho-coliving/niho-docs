import { describe, expect, it } from "vitest";
import { VTT_MAX_BYTES, VttParseError, parseVtt } from "../src/index.js";

describe("parseVtt", () => {
  it("BOM/CRLF、字幕ID、複数行、voice tagを保ち、非発言blockを除く", () => {
    const source = [
      "\uFEFFWEBVTT",
      "",
      "NOTE 作成者向け",
      "画面には出さない",
      "",
      "STYLE \t",
      "::cue { color: lime; }",
      "",
      "REGION",
      "id:fred",
      "width:40%",
      "",
      "cue-1",
      "00:00:01.250 --> 00:00:03.900 align:start",
      "<v Recorder>最初の行</v>",
      "次の行 <b>強調</b>",
      "",
      "00:04.000 --> 00:05.000",
      "<v 山田 太郎>了解 &amp; 確認</v>",
      "",
    ].join("\r\n");
    const parsed = parseVtt(source);
    expect(parsed.cues).toEqual([
      { id: "cue-1", start: "00:00:01.250", end: "00:00:03.900", text: "<v Recorder>最初の行</v>\n次の行 <b>強調</b>" },
      { id: null, start: "00:04.000", end: "00:05.000", text: "<v 山田 太郎>了解 &amp; 確認</v>" },
    ]);
    expect(parsed.markdown).toContain("[00:00:01] Recorder: 最初の行\n次の行 &lt;b&gt;強調&lt;/b&gt;");
    expect(parsed.markdown).not.toContain("-->");
    expect(parsed.markdown).toContain("山田 太郎: 了解 &amp; 確認");
    expect(parsed.markdown).not.toContain("NOTE");
    expect(parsed.markdown).not.toContain("::cue");
    expect(parsed.markdown).not.toMatch(/<v|<b>/);
  });

  it("空・壊れた時刻・逆転した時刻・発言の無いファイルを黙って成功させない", () => {
    for (const source of [
      "",
      "WEBVTT\n\nNOTE only\ntext\n",
      "WEBVTT\n\nnot a cue\nbody\n",
      "WEBVTT\n\n00:00.000 --> 00:01.000\n先頭は正常\n\nbroken\nblock\n",
      "WEBVTT\n\n00:61.000 --> 00:62.000\n本文\n",
      "WEBVTT\n\n00:05.000 --> 00:04.000\n本文\n",
      "WEBVTT\n\n00:01.000 --> 00:02.000\n\n",
      "WEBVTT\n\n00:01.000 --> 00:02.000\n前の発言\n00:02.000 --> 00:03.000\n次の発言\n",
    ]) {
      expect(() => parseVtt(source), source).toThrow(VttParseError);
    }
  });

  it("上限を超えた原本を先頭だけ取り込まない", () => {
    const source = `WEBVTT\n\n00:00.000 --> 00:01.000\n${"a".repeat(VTT_MAX_BYTES)}\n`;
    expect(() => parseVtt(source)).toThrow(/大きすぎ/);
  });
});
