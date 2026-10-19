"use client";

import { sameFlowContent, type Flow } from "@niho/docs-core";
import { useCallback, useEffect } from "react";
import { type FailureAction } from "../components/FailureBand";
import { type Bridge } from "../lib/bridge";
import { CLOSE_FLUSH_MS } from "./workspace-model";

type Context = {
  flowEditsRef: React.MutableRefObject<Record<string, Flow>>;
  flowsRef: React.MutableRefObject<Flow[]>;
  infoDirtyRef: React.MutableRefObject<boolean>;
  bridge: Bridge;
  recordingStoppedForCloseRef: React.MutableRefObject<boolean>;
  recordingActiveRef: React.MutableRefObject<boolean>;
  discardOnCloseRef: React.MutableRefObject<boolean>;
  setCloseFailed: React.Dispatch<React.SetStateAction<boolean>>;
  setCloseConfirm: React.Dispatch<React.SetStateAction<{ flows: string[]; info: boolean; } | null>>;
  flushDocAndVersion: () => Promise<boolean>;
  flushAboutRef: React.MutableRefObject<() => Promise<boolean>>;
  showFailure: (text: string, action?: FailureAction) => void;
  closing: boolean;
  setClosing: React.Dispatch<React.SetStateAction<boolean>>;
};

/** 窓を閉じる前に書き残しを待ち、録音・未保存の編集を確認する。 */
export function useWorkspaceCloseGuard(context: Context) {
  const {
    flowEditsRef, flowsRef, infoDirtyRef, bridge,
    recordingStoppedForCloseRef, recordingActiveRef, discardOnCloseRef, setCloseFailed,
    setCloseConfirm, flushDocAndVersion, flushAboutRef, showFailure,
    closing, setClosing,
  } = context;

  /** 工程設計（保存済みと違うフローの名前）と背景情報のダイアログの、保存していない変更。無ければ null。 */
  const unsavedEdits = useCallback((): { flows: string[]; info: boolean } | null => {
    const flowNames = Object.entries(flowEditsRef.current).flatMap(([flowId, edit]) => {
      const saved = flowsRef.current.find((candidate) => candidate.id === flowId);
      return saved && sameFlowContent(edit, saved) ? [] : [saved?.name || edit.name || "無題の工程"];
    });
    const info = infoDirtyRef.current;
    return flowNames.length > 0 || info ? { flows: flowNames, info } : null;
  }, [flowEditsRef, flowsRef, infoDirtyRef]);

  // 窓を閉じる前に、文書の書きかけを書き終えるまで待つ。書き切れなかったときは一度だけ閉じるのを止めて知らせる（もう一度閉じれば閉じる）。
  // 工程設計・背景情報の保存していない変更は書き残せないので、先に確かめる（「破棄して閉じる」を選んだ次の要求では確かめない。#18788）
  useEffect(() => {
    let cancelled = false;
    let warned = false;
    let unlisten: (() => void) | null = null;
    bridge
      .onCloseRequested?.(async () => {
        // 録音中は閉じずに、録音を止めるかを先に確かめる（RecordingCloseGuard）。止めて閉じると窓の close を通り直すので、
        // 保存していない変更の確かめはその後に出す（2 つの確かめを重ねない）
        const stoppedForClose = recordingStoppedForCloseRef.current;
        recordingStoppedForCloseRef.current = false;
        if (recordingActiveRef.current && !stoppedForClose) return false;
        const discard = discardOnCloseRef.current;
        discardOnCloseRef.current = false;
        const unsaved = discard ? null : unsavedEdits();
        if (unsaved) {
          setCloseFailed(false);
          setCloseConfirm(unsaved);
          return false;
        }
        let timer: number | undefined;
        const timeout = new Promise<boolean>((resolve) => {
          timer = window.setTimeout(() => resolve(true), CLOSE_FLUSH_MS);
        });
        const saved = await Promise.race([
          // 版の後に直した文書は版にしてから閉じる（版を作れなくても閉じるのは止めない。本文は保存済み）
          Promise.all([flushDocAndVersion(), flushAboutRef.current()]).then(([docSaved, aboutSaved]) => docSaved && aboutSaved),
          timeout,
        ]);
        window.clearTimeout(timer);
        if (saved) {
          warned = false;
          return true;
        }
        if (warned) return true;
        warned = true;
        showFailure("文書か「あなたについて」を保存できませんでした。もう一度閉じると、書きかけは失われます。");
        return false;
      })
      .then(
        (stop) => {
          if (cancelled) stop();
          else unlisten = stop;
        },
        () => undefined,
      );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [bridge, discardOnCloseRef, flushAboutRef, flushDocAndVersion, recordingActiveRef, recordingStoppedForCloseRef, setCloseConfirm, setCloseFailed, showFailure, unsavedEdits]);

  /** 録音を止めるかの確かめの「止めて閉じる」: 録音を止めて窓を閉じ直す（画面の録音の表示が止まるのを待たずに、次の閉じる要求を通す）。 */
  const stopRecordingAndClose = async () => {
    recordingStoppedForCloseRef.current = true;
    try {
      await bridge.closeAfterRecording();
    } catch (error) {
      recordingStoppedForCloseRef.current = false;
      throw error;
    }
  };

  /** 窓を閉じる前の確かめの「破棄して閉じる」: もう一度窓を閉じる（今度は確かめない。文書の書きかけは閉じる前に書き残す）。 */
  const discardAndClose = async () => {
    if (closing) return;
    discardOnCloseRef.current = true;
    setClosing(true);
    setCloseFailed(false);
    try {
      // 録音していなければ止めずに窓を閉じる（Rust の close_after_recording は窓の close を通すので、上の閉じる要求を通り直す）
      await bridge.closeAfterRecording();
      setCloseConfirm(null);
    } catch {
      discardOnCloseRef.current = false;
      setCloseFailed(true);
    } finally {
      setClosing(false);
    }
  };
  return {
    stopRecordingAndClose, discardAndClose,
  };
}
