import { describe, expect, it } from "vitest";
import {
  NEXT_STEPS_WORDS,
  RUN_START_LABELS,
  continueMenuCaption,
  doneBandLine,
  nextStepRows,
  nextStepsPrimaryLabel,
  nextStepsSummary,
  remainingNextSteps,
  runChipLabel,
  runDoneReply,
  runRowLabel,
  runningBandLine,
} from "../src/index.js";

const steps = [
  { stepId: "source", label: "文字起こし", done: true },
  { stepId: "s1", label: "文字起こし修正", done: false },
  { stepId: "s2", label: "記事方針", done: false },
  { stepId: "s3", label: "記事本文", done: false },
];

describe("次の工程の列（#19050）", () => {
  it("保存済みは 完了、無いものは 未作成、開いているページの行は「このページ」", () => {
    const rows = nextStepRows({ steps, currentStepId: "source" });
    expect(rows.map((row) => [row.label, row.status, row.statusLabel])).toEqual([
      ["文字起こし", "done", "このページ"],
      ["文字起こし修正", "todo", "未作成"],
      ["記事方針", "todo", "未作成"],
      ["記事本文", "todo", "未作成"],
    ]);
    expect(rows[0]!.current).toBe(true);
  });

  it("実行中は実行の状態（処理中／待機中／完了）を優先し、止めたら（active を渡さない）未作成へ戻る", () => {
    const running = nextStepRows({ steps, currentStepId: "source", active: { source: "done", s1: "done", s2: "running", s3: "waiting" } });
    expect(running.map((row) => row.statusLabel)).toEqual(["このページ", "完了", "処理中", "待機中"]);
    const stopped = nextStepRows({ steps: steps.map((step) => (step.stepId === "s1" ? { ...step, done: true } : step)), currentStepId: "source", active: null });
    expect(stopped.map((row) => row.statusLabel)).toEqual(["このページ", "完了", "未作成", "未作成"]);
  });

  it("残りは原文を除く未保存の工程だけ", () => {
    expect(remainingNextSteps(steps, "source").map((step) => step.stepId)).toEqual(["s1", "s2", "s3"]);
    expect(remainingNextSteps(steps.map((step) => ({ ...step, done: true })), "source")).toEqual([]);
  });

  it("見出しの右の 1 語は 処理中／残り N／すべて完了", () => {
    expect(nextStepsSummary({ running: true, remaining: 3 })).toBe("処理中");
    expect(nextStepsSummary({ running: false, remaining: 3 })).toBe("残り 3");
    expect(nextStepsSummary({ running: false, remaining: 0 })).toBe("すべて完了");
  });

  it("主ボタンと一覧の言葉は run-words（RUN_START_LABELS）のまま", () => {
    expect(nextStepsPrimaryLabel(2)).toBe(RUN_START_LABELS.continue);
    expect(nextStepsPrimaryLabel(0)).toBe(RUN_START_LABELS.rerunAll);
    expect(runChipLabel({ kind: "continue" })).toBe("▶ 続きを作成");
    expect(runChipLabel({ kind: "step", stepName: "記事方針" })).toBe("▶ 記事方針を実行");
    expect(runRowLabel({ kind: "continue", steps: 3 })).toBe("▶ 続きを作成（3 工程）");
    expect(runRowLabel({ kind: "step", stepName: "記事方針" })).toBe("▶ 記事方針を実行");
    expect(runDoneReply("記事方針")).toBe("「記事方針」を作りました。");
  });

  it("「続きを作成」の添え書きは残りが 2 つ以上のときだけ「 › 」でつなぐ", () => {
    expect(continueMenuCaption(["文字起こし修正", "記事方針", "記事本文"])).toBe("文字起こし修正 › 記事方針 › 記事本文");
    expect(continueMenuCaption(["記事本文"])).toBeNull();
  });

  it("帯の文", () => {
    expect(runningBandLine({ stepName: "記事方針", place: "クラウドで作っています" })).toEqual({ lead: "処理中: 記事方針", place: "· クラウドで作っています" });
    expect(doneBandLine(["記事方針", "記事本文"])).toBe("記事方針・記事本文 を作りました。");
  });

  it("＋ と一覧の言葉", () => {
    expect(NEXT_STEPS_WORDS.plusLabel).toBe("工程やスキルを選ぶ");
    expect(NEXT_STEPS_WORDS.menuHeading).toBe("工程を実行");
    expect(NEXT_STEPS_WORDS.menuHint).toBe("/ でも開けます");
    expect(NEXT_STEPS_WORDS.execute).toBe("実行");
  });
});

