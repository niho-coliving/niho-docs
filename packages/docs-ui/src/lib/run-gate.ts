/**
 * 工程を実行できない理由（#18789）。録音のページと成果物のページの実行の帯、入力欄の「＋ → 工程を実行」が同じ判定・同じ文を使う。
 * 押してから失敗する経路（別の Mac の lease・別案から選んでいない）を作らず、押せない間は理由を 1 行で伝える。
 */

import { candidatesFor, type Recording } from "@niho/docs-core";
import type { ProjectId } from "./bridge";
import { CHAT_BUSY_RUN_REASON, runIsOn, type ActiveRun } from "./run-state";

/** 実行を押せない理由。setup は設定で直せる準備の不足で、「設定を開く」を添える。 */
export type RunGate = { reason: string; setup: boolean };

/**
 * 別案のある工程を含む実行は、案を開いて選んでから（どの案を作り直すか決まらないので、押す前に止める）。
 * `fixedStepId` は開いている案の工程（その工程は案が決まっている）。
 */
export function candidateChoiceReason(input: {
  recording: Pick<Recording, "candidateSets">;
  flow: { steps: ReadonlyArray<{ id: string; name: string }> };
  queue: readonly string[];
  fixedStepId?: string | null;
}): string | null {
  const stepId = input.queue.find((id) => id !== input.fixedStepId && candidatesFor(input.recording, id).length > 0);
  if (stepId === undefined) return null;
  const name = input.flow.steps.find((step) => step.id === stepId)?.name || "この工程";
  return `${name}の案を左から開いて選ぶと実行できます`;
}

/**
 * 実行を押せない理由を、優先する順に 1 つ返す（無ければ null）。この録音の実行中は null（呼び出し側が「止める」を出す）。
 * material は録音のページだけが渡す（成果物のページは素材がある録音の子ページ）。
 */
export function runGate(input: {
  material?: boolean;
  activeRun: Pick<ActiveRun, "projectId" | "recordingId"> | null;
  recording: { projectId: ProjectId; recordingId: string };
  /** ほかのフォルダの実行中の理由（run-state の runBlockedReason）。 */
  blockedReason: string | null;
  /** 同じ場所で「AIと作る」の依頼が動いている。 */
  chatBusy: boolean;
  /** 別の Mac が実行中の理由（cloud の leaseRunNote）。 */
  leaseNote: string | null;
  candidateReason: string | null;
  /** その始め方で押せない理由（続きの場所がクラウドで受けない続き・音声の無い文字起こし。録音のページだけが渡す。#18947）。 */
  executionReason?: RunGate | null;
  setupReason: string | null;
}): RunGate | null {
  if (input.material === false) return { reason: "音声を入れると実行できます", setup: false };
  const run = input.activeRun;
  if (run) {
    if (runIsOn(run, input.recording)) return null;
    if (run.projectId === input.recording.projectId) {
      return {
        reason: input.recording.projectId === null ? "ホームの別の録音を実行しています" : "同じフォルダの別の録音を実行しています",
        setup: false,
      };
    }
    return { reason: input.blockedReason ?? "ほかのフォルダの録音を実行しています", setup: false };
  }
  if (input.chatBusy) return { reason: CHAT_BUSY_RUN_REASON, setup: false };
  if (input.leaseNote) return { reason: input.leaseNote, setup: false };
  if (input.candidateReason) return { reason: input.candidateReason, setup: false };
  if (input.executionReason) return input.executionReason;
  if (input.setupReason) return { reason: input.setupReason, setup: true };
  return null;
}
