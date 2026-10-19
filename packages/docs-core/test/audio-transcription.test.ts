import { describe, expect, it } from "vitest";
import {
  TIMESTAMP_PREFIX,
  audioTranscriptMarkdown,
  buildAudioTranscriptionPartPrompt,
  buildAudioTranscriptionPrompt,
  buildAudioTranscriptionSystemPrompt,
  parseAudioTranscriptParagraphs,
  timedTranscriptParagraphs,
  transcriptionReferenceLines,
  type AudioTranscriptionContext,
} from "../src/index.js";

const context: AudioTranscriptionContext = {
  title: "朝市の座談会",
  language: "ja",
  speakers: "3",
  terms: [
    { term: "材木座", reading: "ざいもくざ", variants: ["財木座", "材木ざ"], note: "鎌倉の地名" },
    { term: "NIHO鎌倉", reading: "", variants: [], note: "" },
    { term: "  ", reading: "x", variants: [], note: "" },
  ],
};

describe("指示の組み立て", () => {
  it("システム側: 正確さ・言語・形式（話者）・文の整え方（相づちで分断しない）・固有名詞（表記・よみ・誤りやすい表記）・出力", () => {
    const prompt = buildAudioTranscriptionSystemPrompt(context);
    expect(prompt.startsWith("あなたは録音を正確に書き起こす担当者です。この音声は「朝市の座談会」の録音です。")).toBe(true);
    expect(prompt).toContain("- 話された内容を省略・要約・言い換えしないでください。");
    expect(prompt).toContain("- 各段落を「[mm:ss] 話者N: 発言」の形で書いてください。");
    expect(prompt).toContain("- 話している人は3人の想定です。");
    expect(prompt).toContain("相手の話の途中の相づちで発言を分断しないでください。");
    expect(prompt).toContain("- 材木座（よみ: ざいもくざ）（誤りやすい表記: 財木座・材木ざ）");
    expect(prompt).toContain("- NIHO鎌倉\n");
    // 補足の列は修正の工程用（渡さない）。空の表記は出さない
    expect(prompt).not.toContain("鎌倉の地名");
    expect(prompt).not.toContain("（よみ: x）");
    expect(prompt).toContain("後半を縮めたり要約に切り替えたりしないでください");
    // 用途固有の語を入れない（記事制作だけの道具にしない）
    expect(prompt).not.toContain("記事");
  });

  it("話者を分けない・英語・固有名詞なし・題名なし", () => {
    const prompt = buildAudioTranscriptionSystemPrompt({ title: null, language: "en", speakers: "none", terms: [] });
    expect(prompt).toContain("話者のラベルは付けず、各段落を「[mm:ss] 発言」の形で書いてください。");
    expect(prompt).toContain("英語のまま");
    expect(prompt).not.toContain("## 固有名詞");
    expect(prompt).not.toContain("話者N");
    expect(buildAudioTranscriptionSystemPrompt({ ...context, speakers: "auto" })).toContain("話している人数は決まっていません");
    expect(buildAudioTranscriptionSystemPrompt({ ...context, speakers: "4plus" })).toContain("4人以上の想定です");
  });

  it("区切りごと: シェルを使わず view_file で読む・区切りの位置・直前の区切りの末尾（2 つ目から）", () => {
    const first = buildAudioTranscriptionPartPrompt({ index: 0, count: 3, speakers: "3", fileName: "f0-p0.wav", referenceLines: ["話者0: 前"] });
    expect(first).toContain("シェルやコマンドは使わず、view_file で「f0-p0.wav」を直接読み込んでください。");
    expect(first).toContain("録音全体を3個に区切ったうちの1番目です。");
    expect(first).not.toContain("直前の区切りの末尾");
    const second = buildAudioTranscriptionPartPrompt({
      index: 1,
      count: 3,
      speakers: "3",
      fileName: "f0-p1.wav",
      referenceLines: ["話者0: こんにちは", "話者1: よろしく"],
    });
    expect(second).toContain("## 直前の区切りの末尾（参考）\n- 話者番号をそろえるための参考です。");
    expect(second).toContain("---\n話者0: こんにちは\n話者1: よろしく\n---");
    const single = buildAudioTranscriptionPartPrompt({ index: 0, count: 1, speakers: "none", fileName: null, referenceLines: [] });
    expect(single).toBe("添付の音声を書き起こしてください。");
    expect(buildAudioTranscriptionPrompt(context, { index: 0, count: 1, speakers: "3", fileName: null, referenceLines: [] })).toContain(
      "## 出力",
    );
  });
});

describe("返事の読み取り", () => {
  it("前置き・囲み（コードフェンス）・見出し・注釈を捨て、時刻と話者を読む（mm:ss・h:mm:ss・範囲・全角）", () => {
    const text = [
      "view_file で読み込みました。以下が書き起こしです。",
      "```",
      "## 書き起こし",
      "[00:05] 話者0: こんにちは。",
      "今日は朝市の話です。",
      "",
      "- [1:02:03] 話者１：二人目です。",
      "**[03:10 - 03:20]** **話者A:** 三人目。",
      "（笑）",
      "［04:00］ラベルの無い段落。",
      "```",
      "※ 注: 一部聞き取れず",
    ].join("\n");
    const paragraphs = parseAudioTranscriptParagraphs({ text, speakers: "3", language: "ja" });
    expect(paragraphs).toEqual([
      { offsetSec: 5, rawLabel: "0", text: "こんにちは。今日は朝市の話です。" },
      { offsetSec: 3723, rawLabel: "1", text: "二人目です。" },
      { offsetSec: 190, rawLabel: "A", text: "三人目。" },
      { offsetSec: 240, rawLabel: null, text: "ラベルの無い段落。" },
    ]);
  });

  it("時刻の無い行: 直前の行に続けば同じ段落、空行の後なら時刻の無い段落。話者を分けない案件はラベルを外す", () => {
    const text = "[00:01] 話者0: 一行目\n続き\n\n離れた行";
    expect(parseAudioTranscriptParagraphs({ text, speakers: "3", language: "ja" })).toEqual([
      { offsetSec: 1, rawLabel: "0", text: "一行目続き" },
      { offsetSec: null, rawLabel: null, text: "離れた行" },
    ]);
    expect(parseAudioTranscriptParagraphs({ text, speakers: "none", language: "en" })).toEqual([
      { offsetSec: 1, rawLabel: null, text: "一行目 続き" },
      { offsetSec: null, rawLabel: null, text: "離れた行" },
    ]);
  });

  it("先頭に再掲された参考行を外す（新しい区切りの本文は消さない）", () => {
    const referenceLines = ["話者0: 前の区切りの終わり", "話者1: はい"];
    const text = "[00:00] 話者0: 前の区切りの終わり\n[00:01] 話者1: はい\n[00:03] 話者1: 新しい話";
    expect(parseAudioTranscriptParagraphs({ text, speakers: "2", language: "ja", referenceLines }).map((paragraph) => paragraph.text)).toEqual([
      "新しい話",
    ]);
    // 時刻の無い 1 行の再掲は外す
    expect(
      parseAudioTranscriptParagraphs({ text: "話者1: はい\n[00:02] 話者0: 続き", speakers: "2", language: "ja", referenceLines }).map(
        (paragraph) => paragraph.text,
      ),
    ).toEqual(["続き"]);
    // 区切りの冒頭で直前と同じ「はい」を実際に話した時刻付きの 1 行は、書き起こしとして残す
    expect(
      parseAudioTranscriptParagraphs({ text: "[00:00] 話者1: はい\n[00:02] 話者0: 続き", speakers: "2", language: "ja", referenceLines }).map(
        (paragraph) => paragraph.text,
      ),
    ).toEqual(["はい", "続き"]);
    expect(transcriptionReferenceLines([{ offsetSec: 0, rawLabel: "0", text: "a" }, { offsetSec: 1, rawLabel: null, text: "b" }], 1)).toEqual([
      "b",
    ]);
  });
});

describe("時刻のずらしと結合", () => {
  it("区切りの開始秒を足し、区切りの長さで丸め、前の段落より戻さない。話者は録音全体の初出順に振り直す", () => {
    const parts = [
      { text: "[00:02] 話者B: 一つ目\n\n[00:40] 話者A: 二つ目\n\n[15:19] 話者B: 長さを超えた", startSec: 0, endSec: 901 },
      { text: "時刻の無い先頭\n\n[00:10] 話者A: 三つ目\n\n[00:05] 話者C: 戻った時刻", startSec: 901, endSec: 1500 },
    ];
    expect(timedTranscriptParagraphs(parts, "auto", "ja")).toEqual([
      { startSec: 2, speaker: 0, text: "一つ目" },
      { startSec: 40, speaker: 1, text: "二つ目" },
      { startSec: 901, speaker: 0, text: "長さを超えた" },
      { startSec: 901, speaker: null, text: "時刻の無い先頭" },
      { startSec: 911, speaker: 1, text: "三つ目" },
      { startSec: 911, speaker: 2, text: "戻った時刻" },
    ]);
    const markdown = audioTranscriptMarkdown(parts, "auto", "ja");
    expect(markdown.split("\n\n")[0]).toBe("[00:00:02] 話者0: 一つ目");
    expect(markdown).toContain("[00:15:01] 話者0: 長さを超えた");
    expect(markdown).toContain("[00:15:11] 話者1: 三つ目");
    expect(markdown.endsWith("\n")).toBe(true);
    // この Mac の経路と同じ段落の先頭（エディタが時刻を書いたままにする）
    for (const paragraph of markdown.trim().split("\n\n")) expect(paragraph).toMatch(TIMESTAMP_PREFIX);
  });

  it("複数の音声は前の音声の長さだけずらした開始秒で繋がる。段落が無ければ空", () => {
    const markdown = audioTranscriptMarkdown(
      [
        { text: "[00:30] 一本目", startSec: 0, endSec: 95 },
        { text: "[00:30] 二本目", startSec: 95, endSec: 190 },
      ],
      "none",
      "ja",
    );
    expect(markdown).toBe("[00:00:30] 一本目\n\n[00:02:05] 二本目\n");
    expect(audioTranscriptMarkdown([{ text: "```\n```", startSec: 0, endSec: 10 }], "none", "ja")).toBe("");
  });
});
