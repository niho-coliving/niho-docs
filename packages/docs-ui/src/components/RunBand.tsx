"use client";

import { RUN_ACTION_LABELS } from "@niho/docs-core";
import type { RunGate } from "../lib/run-gate";

/**
 * 実行の帯の部品（録音のページと成果物のページで共有。#18789）。
 * `.runbar`（app.css）の中に置く。
 */

/** 実行中: 「〈工程名〉を実行中」と右端の「止める」。 */
export function RunningBand(props: { stepName: string; stopRequested: boolean; onStop: () => void }) {
  return (
    <>
      <span className="note">
        <span className="spin" />
        {props.stepName}を実行中
      </span>
      <span className="sp" />
      <button type="button" className="btn stop sm" onClick={props.onStop} disabled={props.stopRequested}>
        {RUN_ACTION_LABELS.stop}
      </button>
    </>
  );
}

/** 押せない理由 1 行。準備の不足は直す場所（設定）へ移れるようにする。 */
export function RunGateNote(props: { gate: RunGate; onOpenSettings: () => void }) {
  return (
    <span className={`note${props.gate.setup ? " setup" : ""}`}>
      {props.gate.reason}
      {props.gate.setup && (
        <button type="button" className="link" onClick={props.onOpenSettings}>
          設定を開く
        </button>
      )}
    </span>
  );
}
