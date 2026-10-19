import { describe, expect, it } from "vitest";
import {
  hasTranscriptParts,
  listTranscriptSpeakers,
  normalizeTranscriptSpeakerNames,
  renameTranscriptSpeakerLabel,
  resolveTranscriptSpeakerName,
  sourceForPrompt,
  stripTranscriptSpeakerLabels,
} from "../src/index.js";

describe("文字起こしの話者", () => {
  it("時刻を残し、番号1だけを段落先頭で一括変更する", () => {
    const source = [
      "[00:00:01] 話者1: 最初です。話者1: は本文です。",
      "",
      "[00:00:10] 話者10: 十番です。",
      "",
      "話者1: 時刻なしです。",
      "途中の行",
      "話者1: 同じ段落の途中です。",
      "",
    ].join("\n");
    expect(renameTranscriptSpeakerLabel(source, "話者1", "田中")).toBe(
      [
        "[00:00:01] 田中: 最初です。話者1: は本文です。",
        "",
        "[00:00:10] 話者10: 十番です。",
        "",
        "田中: 時刻なしです。",
        "途中の行",
        "話者1: 同じ段落の途中です。",
        "",
      ].join("\n"),
    );
  });

  it("fenced code と inline code のラベルを変えない", () => {
    const source = ["```text", "話者1: code", "```", "", "`話者1:` inline", "", "話者1: 本文", ""].join("\n");
    expect(renameTranscriptSpeakerLabel(source, "話者1", "田中")).toBe(
      ["```text", "話者1: code", "```", "", "`話者1:` inline", "", "田中: 本文", ""].join("\n"),
    );
  });

  it("4 backticks の中の3 backticksやinfo付き行では閉じず、十分な長さの空白だけのclosingで閉じる", () => {
    const source = [
      "````md",
      "話者1: code 1",
      "```",
      "",
      "話者1: code 2",
      "```` still-code",
      "",
      "## Part 9: code-only",
      "````   ",
      "",
      "話者1: 本文",
      "",
    ].join("\n");
    const renamed = renameTranscriptSpeakerLabel(source, "話者1", "田中");
    expect(renamed).toContain("話者1: code 1");
    expect(renamed).toContain("話者1: code 2");
    expect(renamed).toContain("田中: 本文");
    expect(hasTranscriptParts(source)).toBe(false);
  });

  it("Part ごとに同じ番号を分離し、対象 Part だけ変更する", () => {
    const source = [
      "## Part 1: a.m4a",
      "",
      "[00:00:01] 話者0: A",
      "",
      "## Part 2: b.m4a",
      "",
      "[00:10:01] 話者0: B",
      "",
    ].join("\n");
    expect(listTranscriptSpeakers(source)).toMatchObject([
      { key: "1:0", partIndex: 1, index: 0 },
      { key: "2:0", partIndex: 2, index: 0 },
    ]);
    expect(renameTranscriptSpeakerLabel(source, "話者0", "佐藤", 2)).toContain("[00:00:01] 話者0: A");
    expect(renameTranscriptSpeakerLabel(source, "話者0", "佐藤", 2)).toContain("[00:10:01] 佐藤: B");
  });

  it("同じ Part の名前衝突を拒否し、別 Part では許可する", () => {
    const speakers = listTranscriptSpeakers("話者0: A\n\n話者1: B\n", { "0": "田中" });
    expect(resolveTranscriptSpeakerName({ name: "田中", speaker: speakers[1]!, speakers })).toBeNull();
    const parts = listTranscriptSpeakers("## Part 1: a\n話者0: A\n\n## Part 2: b\n話者0: B\n", { "1:0": "田中" });
    expect(resolveTranscriptSpeakerName({ name: "田中", speaker: parts[1]!, speakers: parts })).toBe("田中");
    expect(resolveTranscriptSpeakerName({ name: "", speaker: speakers[1]!, speakers })).toBeNull();
    expect(resolveTranscriptSpeakerName({ name: "あ".repeat(61), speaker: speakers[1]!, speakers })).toBeNull();
    expect(resolveTranscriptSpeakerName({ name: "田中\n太郎", speaker: speakers[1]!, speakers })).toBeNull();
    expect(resolveTranscriptSpeakerName({ name: "田中:太郎", speaker: speakers[1]!, speakers })).toBeNull();
    expect(resolveTranscriptSpeakerName({ name: "話者2", speaker: speakers[1]!, speakers })).toBeNull();
  });

  it("Markdown の特殊記号を文字として保存し、同じ生の名前で解除できる", () => {
    const name = "$1（司会）(A)*_`";
    const named = renameTranscriptSpeakerLabel("[00:00:01] 話者1: 本文\n", "話者1", name);
    expect(named).toBe("[00:00:01] \\$1（司会）\\(A\\)\\*\\_\\`: 本文\n");
    expect(renameTranscriptSpeakerLabel(named, name, "話者1")).toBe("[00:00:01] 話者1: 本文\n");
  });

  it("名前を外すと番号へ戻し、metadata の無い旧版は空として読む", () => {
    expect(renameTranscriptSpeakerLabel("[00:00:01] 田中: 本文\n", "田中", "話者2")).toBe("[00:00:01] 話者2: 本文\n");
    expect(normalizeTranscriptSpeakerNames(undefined)).toEqual({});
    expect(normalizeTranscriptSpeakerNames({ "0": " 田中 ", bad: "佐藤", "1": 3 })).toEqual({ "0": "田中" });
    // metadata が無い名前付き本文から番号対応を推測しない。
    expect(listTranscriptSpeakers("田中: 本文\n", {})).toEqual([]);
  });

  it("後続AI向けには生成話者だけを外し、時刻・本文・Part・fence・通常文をbytesのまま保つ", () => {
    const source = [
      "## Part 1: 音声1",
      "",
      "[00:00:01] 話者2: 最初です。",
      "",
      "[00:00:03] 話者?: 不明です。",
      "",
      "[00:00:04] 質問: 時刻付きの通常発話です。",
      "",
      "[00:00:05] 田中（司会）: 名前変更後です。",
      "",
      "話者3: 時刻なしの生成ラベルです。",
      "",
      "注意: これは普通の文章です。",
      "",
      "```text",
      "[00:00:07] 話者4: code",
      "```",
      "",
    ].join("\n");
    const speakerNames = { "1:1": "田中（司会）" };
    const safe = stripTranscriptSpeakerLabels(source, speakerNames);
    expect(safe).toBe([
      "## Part 1: 音声1",
      "",
      "[00:00:01] 最初です。",
      "",
      "[00:00:03] 不明です。",
      "",
      "[00:00:04] 質問: 時刻付きの通常発話です。",
      "",
      "[00:00:05] 名前変更後です。",
      "",
      "時刻なしの生成ラベルです。",
      "",
      "注意: これは普通の文章です。",
      "",
      "```text",
      "[00:00:07] 話者4: code",
      "```",
      "",
    ].join("\n"));
    expect(sourceForPrompt("文字起こし", source, speakerNames)).toBe(safe);
    expect(sourceForPrompt("文章", source)).toBe(source);
  });

  it("保存済みの名前対応に一致するラベルだけを外し、時刻付きの通常発話を残す", () => {
    const source = [
      "## Part 1: 音声1",
      "",
      "[00:00:01] 田中: 話者1です。",
      "",
      "[00:00:02] 質問: これは通常の発話です。",
      "",
      "## Part 2: 音声2",
      "",
      "[00:00:03] 田中: こちらは別の話者名です。",
      "",
    ].join("\n");
    expect(stripTranscriptSpeakerLabels(source, { "1:1": "田中" })).toBe([
      "## Part 1: 音声1",
      "",
      "[00:00:01] 話者1です。",
      "",
      "[00:00:02] 質問: これは通常の発話です。",
      "",
      "## Part 2: 音声2",
      "",
      "[00:00:03] 田中: こちらは別の話者名です。",
      "",
    ].join("\n"));
  });
});
