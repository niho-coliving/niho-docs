"use client";

import { SOURCE_STEP_ID, runStartActions, type RunStartAction } from "@niho/docs-core";
import { useEffect } from "react";
import { type Screen } from "../components/Rail";
import { rerunQueueOf, type RecordingView } from "../lib/project-view";
import { runSetupReason, type RunReadinessStatuses } from "../lib/run-readiness";
import { setupQueueOf } from "../lib/run-start";
import { type AppSettings } from "../lib/settings";
import type { CloudController } from "../lib/cloud";
import { readinessKeyOf, type Phase } from "./workspace-model";

type Context = {
  settings: AppSettings;
  phase: Phase;
  screen: Screen;
  readinessKeyRef: React.MutableRefObject<string | null>;
  refreshReadiness: (settingsNow: AppSettings) => void;
  settingsRef: React.MutableRefObject<AppSettings>;
  view: RecordingView | null;
  readiness: RunReadinessStatuses;
  selectedStepId: string | null;
  cloud: CloudController;
  deviceDeliveryAvailable: boolean;
};

/** 現在の工程の準備不足を判定し、設定変更・前面化の後に確かめ直す。 */
export function useRunReadiness(context: Context) {
  const {
    settings, phase, screen, readinessKeyRef,
    refreshReadiness, settingsRef, view, readiness,
    selectedStepId, cloud, deviceDeliveryAvailable,
  } = context;

  // 実行の前の準備: 普段の画面へ戻ったとき（設定で AI にログインした・音声モデルを取得した後など）と、接続の方式・登録した AI・
  // 文字起こしを変えたときに確かめ直す。理由を出している間は、窓へ戻ったときにも確かめ直す（ターミナルで CLI を入れた後など）。
  const readinessKey = readinessKeyOf(settings);
  useEffect(() => {
    if (phase !== "ready") return;
    if (screen !== "work") {
      readinessKeyRef.current = null;
      return;
    }
    if (readinessKeyRef.current === readinessKey) return;
    readinessKeyRef.current = readinessKey;
    refreshReadiness(settingsRef.current);
  }, [phase, screen, readinessKey, refreshReadiness, readinessKeyRef, settingsRef]);
  // 残りの工程があればそれを、すべて完了していれば「すべて再実行」の工程を対象に準備を確かめる（録音のページの主ボタンと同じ始め方で）
  const selectedQueue = view ? view.plan.remaining.length > 0 ? view.plan.remaining : rerunQueueOf(view) : [];
  const selectedStart = view
    ? runStartActions({ sourceDone: !view.plan.remaining.includes(SOURCE_STEP_ID), remaining: view.plan.remaining.length }).primary
    : null;
  // 準備を確かめる工程は、実行の仕方（startRun と同じ決め方）で変わる（#18947）。単独の工程（explicit）はその工程を。録音のページの
  // 始め方は、文字起こしだけと、続きをクラウドで作る作成は原文の工程だけ、続きをこの Mac で作るなら原文を除いた残り、続きをクラウドに
  // 任せるときはこの Mac の準備を見ない
  const setupReasonFor = (queue: readonly string[], mode: boolean | RunStartAction = false): string | null => {
    if (!view) return null;
    const readinessQueue = setupQueueOf(queue, mode, settings.personalExecution.continuation,
      cloud.state?.storage?.mode === "LOCAL", deviceDeliveryAvailable);
    return readinessQueue === null ? null : runSetupReason({ queue: readinessQueue, flow: view.flow, settings, statuses: readiness });
  };
  const setupReason = selectedStart ? setupReasonFor(selectedQueue, selectedStart) : null;
  // 完了済みの成果物を個別に再実行するページは、その工程だけの準備不足（その工程の AI だけ未ログインなど）も理由に出す。
  // 残りの工程の準備ができていても、外部でログインして窓へ戻ったときに確かめ直す対象に含める
  const shownStepSetupReason = view && selectedStepId ? setupReasonFor([selectedStepId], true) : null;
  const watchReadiness = Boolean(setupReason || shownStepSetupReason);
  useEffect(() => {
    if (!watchReadiness) return;
    const onFocus = () => refreshReadiness(settingsRef.current);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [watchReadiness, refreshReadiness, settingsRef]);
  return {
    setupReasonFor,
  };
}
