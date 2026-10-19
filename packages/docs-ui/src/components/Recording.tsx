"use client";

import { useEffect, useRef, useState } from "react";
import { errorMessage, isCommandError, type Bridge, type RecordedAudio, type RecordingEvent } from "../lib/bridge";
import { formatRecordingTime, newId } from "../lib/format";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * 録音（#18590）。App が所有し、文書ヘッダーと録音ページの音声欄からマイク録音する。録音は Rust（recording.rs）が
 * sidecar の `niho-speech record` で app data の recordings/ に録り、止めると AAC（.m4a）に書き出して返す。同時に 1 本まで。
 */

export type RecordingState =
  | { phase: "idle" }
  | { phase: "starting"; id: string }
  | { phase: "recording" | "stopping"; id: string; device: string | null; durationSec: number; db: number | null };

/** 録音を始められない理由（欄の中に出す）。permission はシステム設定へ、device はマイクをつなぐ案内。 */
export type RecordingProblem = { kind: "permission" } | { kind: "device" } | { kind: "message"; text: string };

export const MIC_PERMISSION_MESSAGE = "マイクの使用が許可されていません。システム設定で NIHO docs を許可してください。";
export const MIC_DEVICE_MESSAGE = "マイクが見つかりません。マイクをつないでから、もう一度押してください。";
const ENDED_BY_ITSELF_MESSAGE = "録音が止まりました（マイクが外れたか、保存先に書けなくなりました）。保存できなかった場合は「前回の録音」から録音のページに保存できます。";

/** 音量のメーターの下限（dBFS。これより小さい音は空のメーター）。 */
const METER_FLOOR_DB = -60;

export function useRecording(bridge: Bridge, onRecorded: (audio: RecordedAudio) => void, onFailed?: (recordingId: string) => void) {
  const [state, setState] = useState<RecordingState>({ phase: "idle" });
  const [problem, setProblem] = useState<RecordingProblem | null>(null);
  const stateRef = useRef(state);
  const completedIdRef = useRef<string | null>(null);
  stateRef.current = state;
  const mountedRef = useRef(true);
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;

  const updateState = (next: RecordingState) => {
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  };
  const currentState = () => stateRef.current;

  // App が外れたら録音を止め、次回の「前回の録音」に残す（ページ移動では外れない）
  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        const current = stateRef.current;
        if (current.phase === "recording") void bridge.stopRecording(current.id).catch(() => undefined);
      };
    },
    [bridge],
  );

  const onEvent = (id: string, event: RecordingEvent) => {
    if (!mountedRef.current) return;
    const mine = (current: RecordingState): current is Extract<RecordingState, { phase: "recording" | "stopping" }> =>
      (current.phase === "recording" || current.phase === "stopping") && current.id === id;
    // 終わりの行は、始めた応答より先に届くことがある（starting の間）。始めた録音の id なら、その段階でも受け取る
    const involved = (current: RecordingState) => current.phase !== "idle" && current.id === id;
    switch (event.type) {
      case "Started":
        {
          const current = currentState();
          if (mine(current)) updateState({ ...current, device: event.device });
        }
        break;
      case "Level":
        {
          const current = currentState();
          if (mine(current)) updateState({ ...current, durationSec: event.durationSec, db: event.db });
        }
        break;
      case "Done":
        // 画面が止めずに終わった（入力の装置が無くなった・書けなくなった）。ここまでを足す
        if (!involved(currentState())) return;
        completedIdRef.current = id;
        updateState({ phase: "idle" });
        onRecordedRef.current(event.audio);
        setProblem({ kind: "message", text: ENDED_BY_ITSELF_MESSAGE });
        break;
      case "Error":
        if (!involved(currentState())) return;
        updateState({ phase: "idle" });
        setProblem({ kind: "message", text: event.message });
        onFailedRef.current?.(id);
        break;
    }
  };

  const start = async (recordingId = newId("rec")) => {
    if (stateRef.current.phase !== "idle") return false;
    setProblem(null);
    const id = recordingId;
    updateState({ phase: "starting", id });
    try {
      // 断られているなら sidecar を起こさずに案内する（未決定は録音の始めに聞く）
      const status = await bridge.micStatus(false);
      const pendingStart = currentState();
      if (!mountedRef.current || pendingStart.phase !== "starting" || pendingStart.id !== id) return false;
      if (status === "denied" || status === "restricted") {
        setProblem({ kind: "permission" });
        updateState({ phase: "idle" });
        return false;
      }
      const started = await bridge.startRecording(id, (event) => onEvent(id, event));
      if (!mountedRef.current) {
        // App が開始中に外れた場合も、sidecar を止めて復旧用の元音声を残す。
        void bridge.stopRecording(id).catch(() => undefined);
        return true;
      }
      // 応答より先に終わっていたら（idle）、録音の面を戻さない
      const pendingResult = currentState();
      if (pendingResult.phase === "starting" && pendingResult.id === id) {
        updateState({ phase: "recording", id, device: started.device, durationSec: 0, db: null });
      }
      return (pendingResult.phase !== "idle" && pendingResult.id === id) || completedIdRef.current === id;
    } catch (startError) {
      const current = currentState();
      // Done が先なら保存を継続する。Error が先なら開始失敗として復旧情報も掃除できる。
      if (!mountedRef.current || current.phase !== "starting" || current.id !== id) return completedIdRef.current === id;
      updateState({ phase: "idle" });
      const code = isCommandError(startError) ? startError.code : "";
      if (code === "recording_permission") setProblem({ kind: "permission" });
      else if (code === "recording_no_device") setProblem({ kind: "device" });
      else setProblem({ kind: "message", text: errorMessage(startError, "録音を始められませんでした。もう一度押してください。") });
      return false;
    }
  };

  /** 止めて書き出しを待ち、音声の一覧に足す。足した音声を返す（録音していない・失敗なら null）。 */
  const stop = async (): Promise<RecordedAudio | null> => {
    const current = stateRef.current;
    if (current.phase !== "recording") return null;
    updateState({ ...current, phase: "stopping" });
    try {
      const audio = await bridge.stopRecording(current.id);
      const latest = stateRef.current;
      if (!mountedRef.current || latest.phase !== "stopping" || latest.id !== current.id) return audio;
      updateState({ phase: "idle" });
      onRecordedRef.current(audio);
      return audio;
    } catch (stopError) {
      const latest = stateRef.current;
      if (!mountedRef.current || latest.phase !== "stopping" || latest.id !== current.id) return null;
      updateState({ phase: "idle" });
      setProblem({ kind: "message", text: errorMessage(stopError, "録音を止められませんでした。") });
      return null;
    }
  };

  const active = state.phase !== "idle";
  return { state, problem, active, start, stop, clearProblem: () => setProblem(null) };
}

/** 録音中の面: 赤い点・経過・音量のメーター・入力の装置・「止める」。 */
export function RecordingPanel(props: { state: RecordingState; onStop: () => void }) {
  const { state } = props;
  if (state.phase === "idle") return null;
  const recording = state.phase === "recording" || state.phase === "stopping";
  const durationSec = recording ? state.durationSec : 0;
  const db = recording ? state.db : null;
  const level = db === null ? 0 : Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
  return (
    <div className="rec" role="group" aria-label="録音">
      <span className={`rec-dot${state.phase === "recording" ? " on" : ""}`} aria-hidden="true" />
      <span className="rec-time" aria-label="経過">
        {formatRecordingTime(durationSec)}
      </span>
      <span
        className="rec-meter"
        role="meter"
        aria-label="音量"
        aria-valuemin={METER_FLOOR_DB}
        aria-valuemax={0}
        aria-valuenow={db === null ? METER_FLOOR_DB : Math.max(METER_FLOOR_DB, Math.round(db))}
      >
        <span style={{ width: `${Math.round(level * 100)}%` }} />
      </span>
      <span className="rec-dev">{state.phase === "starting" ? "準備しています…" : (state.device ?? "入力の装置")}</span>
      <button type="button" className="btn stop sm" onClick={props.onStop} disabled={state.phase !== "recording"}>
        {state.phase === "stopping" ? "保存しています…" : "止める"}
      </button>
    </div>
  );
}

/** 録音を始められない理由（許可はシステム設定を開くボタンつき）。 */
export function RecordingProblemNote(props: { problem: RecordingProblem; onOpenSettings: () => void }) {
  const { problem } = props;
  if (problem.kind === "permission") {
    return (
      <div className="rec-note">
        <p className="err">{MIC_PERMISSION_MESSAGE}</p>
        <button type="button" className="link" onClick={props.onOpenSettings}>
          システム設定を開く
        </button>
      </div>
    );
  }
  return <p className="err">{problem.kind === "device" ? MIC_DEVICE_MESSAGE : problem.text}</p>;
}

/**
 * 録音中に窓を閉じようとしたときの確かめ（Rust が閉じずに `recording-close-requested` を送る）。止めるなら録音を書き出して
 * から閉じる（録音は次に録音ページを開いたとき「前回の録音」として足せる）。⌘Q で終えたときは確かめずに同じく保存する。
 */
export function RecordingCloseGuard(props: { bridge: Bridge; close?: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [closing, setClosing] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (props.bridge.capabilities?.desktopWindow === false) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void props.bridge
      .onRecordingCloseRequested(() => {
        setFailed(false);
        setAsking(true);
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [props.bridge]);
  if (!asking) return null;
  const close = async () => {
    setClosing(true);
    try {
      await (props.close ? props.close() : props.bridge.closeAfterRecording());
      // 窓が閉じずに残った（保存していない変更の確かめが続いて出た）ときも、録音は止まったのでこの確かめは閉じる
      setAsking(false);
    } catch {
      setFailed(true);
    } finally {
      setClosing(false);
    }
  };
  return (
    <ConfirmDialog
      title="録音を止めて閉じますか？"
      confirmLabel="止めて閉じる"
      cancelLabel="録音を続ける"
      busy={closing}
      onConfirm={() => void close()}
      onCancel={() => setAsking(false)}
    >
      <p className="msg">ここまでの録音は保存します。次にアプリを開くと「前回の録音」から録音のページに保存できます。</p>
      {failed && <p className="err">閉じられませんでした。もう一度押してください。</p>}
    </ConfirmDialog>
  );
}
