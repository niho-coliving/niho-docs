"use client";

import { countChars, normalizeTranscriptSpeakerNames, type PromptRef, type RunRecord } from "@niho/docs-core";
import { useCallback, useEffect, useRef } from "react";
import type { Failure } from "../components/FailureBand";
import { type FailureAction } from "../components/FailureBand";
import { useArtifactAutoVersion } from "../lib/artifact-auto-version";
import { useArtifactAutosave } from "../lib/artifact-autosave";
import { type Bridge, type ProjectId, type RecordingRef } from "../lib/bridge";
import { newId } from "../lib/format";
import { latestVersionRecord, recordingKey, type RecordingView } from "../lib/project-view";
import type { ActiveRun } from "../lib/run-state";
import type { ChatController } from "../lib/use-chat";
import type { Draft } from "./workspace-model";
import { DOC_FLUSH_FAILED, type OpenedArtifactDocument } from "./workspace-model";

import type { DocFlush } from "../components/DocPage";

type Context = {
  chat: ChatController;
  runRef: React.MutableRefObject<ActiveRun | null>;
  runFlushRef: React.MutableRefObject<AbortController | null>;
  runAbortRef: React.MutableRefObject<AbortController | null>;
  bridge: Bridge;
  draftScopeRef: React.MutableRefObject<string | null>;
  draftsByScopeRef: React.MutableRefObject<Map<string, Record<string, Draft>>>;
  draftsRef: React.MutableRefObject<Record<string, Draft>>;
  autosaveFailureRef: React.MutableRefObject<string | null>;
  showFailure: (text: string, action?: FailureAction) => void;
  setFailure: React.Dispatch<React.SetStateAction<Failure | null>>;
  speakerSavingRef: React.MutableRefObject<boolean>;
  viewRef: React.MutableRefObject<RecordingView | null>;
  openedArtifactRef: React.MutableRefObject<OpenedArtifactDocument | null>;
  reloadView: (rec: RecordingRef, frozenRefs?: readonly PromptRef[], shouldApply?: () => boolean) => Promise<RecordingView>;
  activeRun: ActiveRun | null;
  docFlushRef: React.MutableRefObject<DocFlush | null>;
};

/** 成果物の自動保存と版の作成、画面を離れる前の書き残し。 */
export function useWorkspacePersistence(context: Context) {
  const {
    chat, runRef, runFlushRef, runAbortRef,
    bridge, draftScopeRef, draftsByScopeRef, draftsRef,
    autosaveFailureRef, showFailure, setFailure, speakerSavingRef,
    viewRef, openedArtifactRef, reloadView, activeRun,
    docFlushRef,
  } = context;

  // NIHO クラウド（C3 #18595）: 保存先の状態・案件ごとの同期の状態・クラウドの案件の一覧
  const chatLockRef = useRef<{ sending: boolean; projectId: string | null }>({ sending: false, projectId: null });
  chatLockRef.current = { sending: chat.sending, projectId: chat.live?.projectId ?? null };
  /** その案件の実行のロックをこの窓が持っている（工程の実行・AIと作るの依頼）。実行が送る前に書き残す間は外す。 */
  const artifactWriteBlocked = (projectId: ProjectId) =>
    (runRef.current?.projectId === projectId && runFlushRef.current !== runAbortRef.current) ||
    (chatLockRef.current.sending && (chatLockRef.current.projectId === null || chatLockRef.current.projectId === projectId));
  // 成果物・文字起こしの書きかけの自動保存（本文だけを今の文書へ。版は下の自動の版で残す）
  const autosave = useArtifactAutosave({
    bridge,
    draftOf: (key, target) => {
      const source = target.scopeId && target.scopeId !== draftScopeRef.current
        ? (draftsByScopeRef.current.get(target.scopeId) ?? {})
        : draftsRef.current;
      return source[target.draftKey ?? key]?.markdown ?? null;
    },
    blocked: artifactWriteBlocked,
    onError: (message) => {
      autosaveFailureRef.current = message;
      showFailure(message);
    },
    onRecovered: () => {
      const text = autosaveFailureRef.current;
      autosaveFailureRef.current = null;
      setFailure((current) => (current && current.text === text ? null : current));
    },
  });
  const { flushAll: flushArtifacts, resume: resumeArtifacts } = autosave;

  // 版を自動で残す（owner 2026-10-18・#18912。spec niho-docs-cloud §8.2「版を残す時」。判定は docs-core の auto-version）。
  // 版を作るボタンは置かない。この端末で版の後に直した文書を、入力が 10 分止まったとき・離れるとき・AI が書き換える直前・
  // 古い版に戻す直前に 1 つ版にする（最新の版と同じ中身・空の文書は作らない）。記録は kind "save"・auto: true
  const autoVersion = useArtifactAutoVersion({
    // 話者名の保存（同じ本文を版にする）の間も待つ。終わった版がその本文を含むので、待っていた版は要らなくなる
    blocked: (projectId) => artifactWriteBlocked(projectId) || speakerSavingRef.current,
    flush: (key) => autosave.flush(key),
    currentOf: (_key, target) => {
      // 保存先が変わった後は、前の保存先の書きかけを版にしない（戻ってきたら版にする）
      if (target.scopeId && target.scopeId !== draftScopeRef.current) return null;
      const draft = draftsRef.current[target.draftKey ?? ""];
      if (draft) return draft.markdown;
      const shown = viewRef.current;
      if (!shown || shown.key !== recordingKey(target.rec)) return null;
      return target.source ? shown.source : (shown.artifacts[target.stepId] ?? null);
    },
    latestOf: async (_key, target) => {
      const shown = viewRef.current;
      const runs = shown && shown.key === recordingKey(target.rec) ? shown.runs : (await bridge.loadRecording(target.rec)).runs;
      const record = latestVersionRecord(runs, target.flowStepId, target.candidate);
      if (!record || typeof record.version !== "number") return { markdown: null };
      return { markdown: await bridge.readVersion(target.rec, target.stepId, record.version, record.versionPath), record };
    },
    save: async (_key, target, markdown, _reason, latest) => {
      const base = latest.record;
      const record: RunRecord = {
        id: newId("save"),
        kind: "save",
        at: new Date().toISOString(),
        stepId: target.flowStepId,
        stepName: target.stepName,
        ...(target.candidate ? { candidateId: target.candidate.id, artifactId: target.candidate.artifactId } : {}),
        version: null,
        result: "saved",
        outputChars: countChars(markdown),
        auto: true,
        ...(base?.basis ? { basis: base.basis } : {}),
        ...(target.source && base?.transcriptSpeakerNames !== undefined
          ? { transcriptSpeakerNames: normalizeTranscriptSpeakerNames(base.transcriptSpeakerNames) }
          : {}),
      };
      // 開いている文書は、その編集保護の handle で版にする（今の文書は自動保存で書いた内容のまま）
      const opened = openedArtifactRef.current;
      if (opened && opened.key === target.draftKey && opened.scopeId === target.scopeId) {
        await bridge.saveOpenedArtifact(opened.handle, markdown, record);
      } else {
        await bridge.saveArtifact(target.rec, target.stepId, target.source, markdown, record);
      }
      // 履歴に出す（書きかけは外さない。入力を続けていても本文を差し替えない）
      await reloadView(target.rec).catch(() => undefined);
    },
    onError: showFailure,
  });
  const { createWhere: createAutoVersions, resume: resumeAutoVersions } = autoVersion;
  // 実行・依頼が終わったら、待っていた書きかけを書き、待っていた版を作る
  const lockKey = `${activeRun?.projectId ?? ""}|${chat.sending ? (chat.live?.projectId ?? "*") : ""}`;
  useEffect(() => {
    resumeArtifacts();
    resumeAutoVersions();
  }, [lockKey, resumeArtifacts, resumeAutoVersions]);

  /** 文書のページと成果物の書きかけを書き残す（ページ・案件を移る前と窓を閉じる前）。書きかけが残らなければ true。 */
  const flushDoc = useCallback(async (): Promise<boolean> => {
    const [doc, artifacts] = await Promise.all([docFlushRef.current?.() ?? Promise.resolve(true), flushArtifacts()]);
    return doc && artifacts;
  }, [docFlushRef, flushArtifacts]);

  /**
   * 文書を離れる前（ページ・工程・別案・案件の切替、窓を閉じる）: 書きかけを書き残してから、版の後に直した文書を版にする（#18912 の
   * leave）。版を作れなくても離れるのは止めない（本文は保存済み。失敗は帯で知らせる）。書きかけが残らなければ true。
   */
  const flushDocAndVersion = useCallback(async (): Promise<boolean> => {
    if (!(await flushDoc())) return false;
    await createAutoVersions("leave").catch(() => false);
    return true;
  }, [createAutoVersions, flushDoc]);

  /** 移動を伴う操作では保存失敗を成功扱いにせず、その場に留まる。窓closeだけは生のbooleanを使う。 */
  const flushDocForLeave = useCallback(async (): Promise<void> => {
    if (!(await flushDocAndVersion())) throw DOC_FLUSH_FAILED;
  }, [flushDocAndVersion]);
  return {
    autosave, flushArtifacts, autoVersion, createAutoVersions,
    flushDoc, flushDocAndVersion, flushDocForLeave,
  };
}
