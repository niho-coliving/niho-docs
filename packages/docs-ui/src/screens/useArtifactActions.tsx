"use client";

import type { DocsAutoVersionReason } from "@niho/docs-core";
import { addCandidate, candidateFor, candidatesAllowed, candidatesFor, countChars, sourceCandidateName, TRANSCRIPTION_ENGINE_LABELS, type TranscriptionEngine, formatTranscriptSpeakerDefaultLabel, listTranscriptSpeakers, normalizeTranscriptSpeakerNames, renameTranscriptSpeakerLabel, resolveTranscriptSpeakerName, SOURCE_STEP_ID, stepSupportsCandidates, type PromptRef, type RunRecord, type RunStartAction, type TranscriptSpeakerEntry } from "@niho/docs-core";
import { useEffect, useState } from "react";
import { type Failure, type FailureAction } from "../components/FailureBand";
import { type Selection } from "../components/Rail";
import type { ProjectEntry } from "../host/DocsHost";
import type { ArtifactAutoVersion } from "../lib/artifact-auto-version";
import { type AutoVersionTarget } from "../lib/artifact-auto-version";
import type { ArtifactAutosave } from "../lib/artifact-autosave";
import { errorMessage, type Bridge, type ProjectId, type RecordingRef } from "../lib/bridge";
import { saveProjectDrafts, undoVersion, type ChatTarget } from "../lib/chat";
import type { CloudController } from "../lib/cloud";
import { cloudProjectId as toCloudProjectId } from "../lib/cloud";
import { newId } from "../lib/format";
import { finalizeMarkdown, isMarkdownChanged } from "../lib/markdown";
import { fileStem } from "../lib/names";
import { candidateLatestVersion, candidateMarkdown, candidateVersions, isTranscriptFile, latestVersionRecord, transcriptOriginProvider, loadRecordingView, openProjectOf, recordingKey, recordingRef, selectedCandidate, stepArtifactId, stepMarkdown, stepName, versionsOf, type OpenProject, type RecordingView } from "../lib/project-view";
import { type ActiveRun } from "../lib/run-state";
import { engineConnection, engineProvider, type TranscriptionEngineId } from "../lib/settings";
import { type ChatController } from "../lib/use-chat";
import { artifactSaveKey, draftKey, NO_RECORDING, versionKey, type CandidateDialogState, type Draft, type OpenedArtifactDocument, type RebuildRequest, type RebuildUndo, type ToastAction, type ViewingVersion } from "./workspace-model";

type Context = {
  selectedStepId: string | null;
  view: RecordingView | null;
  selection: Selection | null;
  drafts: Record<string, Draft>;
  viewingVersion: ViewingVersion | null;
  documentScopeId: string | null;
  setViewingVersion: React.Dispatch<React.SetStateAction<ViewingVersion | null>>;
  openedArtifactRef: React.MutableRefObject<OpenedArtifactDocument | null>;
  draftsRef: React.MutableRefObject<Record<string, Draft>>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, Draft>>>;
  autosave: ArtifactAutosave;
  selectedTarget: ChatTarget | null;
  autoVersion: ArtifactAutoVersion;
  savingRef: React.MutableRefObject<boolean>;
  speakerSavingRef: React.MutableRefObject<boolean>;
  runRef: React.MutableRefObject<ActiveRun | null>;
  chat: ChatController;
  showFailure: (text: string, action?: FailureAction) => void;
  setSaving: React.Dispatch<React.SetStateAction<boolean>>;
  bridge: Bridge;
  reloadView: (rec: RecordingRef, frozenRefs?: readonly PromptRef[], shouldApply?: () => boolean) => Promise<RecordingView>;
  refreshProjects: (shouldApply?: () => boolean) => Promise<ProjectEntry[]>;
  showToast: (text: string, action?: ToastAction) => void;
  cloud: CloudController;
  dropDraft: (key: string) => void;
  viewRef: React.MutableRefObject<RecordingView | null>;
  createAutoVersions: (reason: DocsAutoVersionReason, match?: (key: string, target: AutoVersionTarget) => boolean) => Promise<boolean>;
  startRun: (queue: string[], fixedTarget?: (ChatTarget & { instruction?: string; }) | null, trigger?: "selection" | "step", rebuild?: RebuildRequest | null, action?: RunStartAction | null) => boolean;
  undoRebuildRef: React.MutableRefObject<(undo: RebuildUndo) => Promise<void>>;
  outside: OpenProject | null;
  folders: OpenProject[];
  selectionRef: React.MutableRefObject<Selection | null>;
  openRef: React.MutableRefObject<OpenProject | null>;
  setFailure: React.Dispatch<React.SetStateAction<Failure | null>>;
  setCandidateDialog: React.Dispatch<React.SetStateAction<CandidateDialogState | null>>;
  candidateDialog: CandidateDialogState | null;
  candidateBusy: boolean;
  chatSendingProjectRef: React.MutableRefObject<ProjectId | undefined>;
  rootChangeRef: React.MutableRefObject<boolean>;
  setCandidateBusy: React.Dispatch<React.SetStateAction<boolean>>;
  selectLocationPage: (projectId: ProjectId, pageId: string, stepId: string | null, candidateId?: string | null, shouldApply?: () => boolean) => Promise<void>;
  setCandidateNameEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>;
};

/** 後工程に使う文字起こしを変えた直後の記録（押したページ・選んだ案・前の案・元に戻した後か）。 */
export type SourceSwitch = { key: string; shownOn: string; candidateId: string; previousId: string; undone: boolean };

/** 文字起こしのエンジンの表示名（docs-core の TRANSCRIPTION_ENGINE_LABELS）。 */
function engineName(engine: TranscriptionEngine): string {
  return TRANSCRIPTION_ENGINE_LABELS[engine];
}

/** 録音から作ったページの編集・版の復元・話者名・別案と書き出し。 */
export function useArtifactActions(context: Context) {
  const {
    selectedStepId, view, selection, drafts,
    viewingVersion, documentScopeId, setViewingVersion, openedArtifactRef,
    draftsRef, setDrafts, autosave, selectedTarget,
    autoVersion, savingRef, speakerSavingRef, runRef,
    chat, showFailure, setSaving, bridge,
    reloadView, refreshProjects, showToast, cloud,
    viewRef, createAutoVersions, startRun, undoRebuildRef,
    outside, folders, selectionRef, openRef,
    setFailure, setCandidateDialog, candidateDialog, candidateBusy,
    chatSendingProjectRef, rootChangeRef, setCandidateBusy, selectLocationPage,
    setCandidateNameEdits,
  } = context;

  // ---- 成果物の子ページ（自動の版・履歴・書き出し） ----

  const stepId = selectedStepId;
  const currentArtifactId = view && stepId ? stepArtifactId(view, stepId, selection?.candidateId) : null;
  const currentKey = view && currentArtifactId ? draftKey(view.key, currentArtifactId) : null;
  const currentDraft = currentKey ? drafts[currentKey] : undefined;
  // 履歴で開いた古い版（読むだけ）。別の文書・保存先へ移ったら出さない
  const viewingShown =
    viewingVersion && viewingVersion.key === currentKey && viewingVersion.scopeId === documentScopeId ? viewingVersion : null;
  useEffect(() => {
    setViewingVersion((shown) => (shown && shown.key !== currentKey ? null : shown));
  }, [currentKey, setViewingVersion]);

  const changeDraft = (markdown: string) => {
    if (!view || !stepId) return;
    // 記事本文の複数案（#18677）では案ごとの成果物（artifacts/<artifactId>.md）を書きかけの単位にする
    const artifactId = currentArtifactId ?? stepId;
    const key = draftKey(view.key, artifactId);
    const opened = openedArtifactRef.current;
    if (!opened || opened.key !== key || opened.scopeId !== documentScopeId) return;
    // 古い版は読むだけ（書きかけにしない）
    if (viewingShown) return;
    draftsRef.current = { ...draftsRef.current, [key]: { markdown } };
    setDrafts((all) => ({ ...all, [key]: { markdown } }));
    // 書きかけは今の文書に自動で保存する（開いた直後の整え直しのように今の文書と同じなら書かない）
    const savedText = candidateMarkdown(view, stepId, selection?.candidateId);
    const changed = savedText === undefined || isMarkdownChanged(markdown, savedText);
    const saveKey = artifactSaveKey(key, opened.scopeId);
    if (!changed && !autosave.touched(saveKey)) return;
    const target: AutoVersionTarget = {
      rec: recordingRef(view),
      stepId: artifactId,
      // 置き場が transcript.md か（文字起こしの別案は工程 1 でも artifacts/。#19108）
      source: isTranscriptFile(artifactId),
      handle: opened.handle,
      draftKey: key,
      scopeId: opened.scopeId,
      flowStepId: stepId,
      stepName: selectedTarget?.name ?? stepName(view, stepId),
      candidate: selectedCandidate(view, stepId, selection?.candidateId),
    };
    autosave.change(saveKey, target, markdown);
    // 利用者の入力だけで「版の後に直した」を立てる（#18912。リモートの適用・AI の書き換えは本文を差し替えるだけで、ここを通らない）
    if (changed || autoVersion.isEdited(saveKey)) autoVersion.edited(saveKey, target);
  };

  /** 話者名は今の未保存本文から保存用 snapshot だけを変換し、成功したときだけ元 draft を片付ける。 */
  const renameSpeaker = async (speaker: TranscriptSpeakerEntry, requestedName: string | null) => {
    if (
      !view ||
      stepId !== SOURCE_STEP_ID ||
      viewingShown ||
      savingRef.current ||
      speakerSavingRef.current ||
      runRef.current !== null ||
      chat.sending ||
      chat.live !== null
    ) return;
    const targetView = view;
    const targetStepId = stepId;
    const rec = recordingRef(targetView);
    // 文字起こしの案ごとに話者名を持つ（#19108。エンジンが違えば同じ番号でも別の人として扱う）
    const targetCandidate = selectedCandidate(targetView, targetStepId, selection?.candidateId);
    const key = draftKey(targetView.key, currentArtifactId ?? targetStepId);
    const opened = openedArtifactRef.current;
    if (!opened || opened.key !== key) {
      showFailure("本文を開き直してから、もう一度お試しください。");
      return;
    }
    const targetDraft = drafts[key];
    const base = latestVersionRecord(targetView.runs, targetStepId, targetCandidate);
    const names = normalizeTranscriptSpeakerNames(base?.transcriptSpeakerNames);
    const markdown = targetDraft?.markdown ?? candidateMarkdown(targetView, targetStepId, selection?.candidateId) ?? "";
    const speakers = listTranscriptSpeakers(markdown, names);
    const currentSpeaker = speakers.find((candidate) => candidate.key === speaker.key);
    if (!currentSpeaker) return;
    const name =
      requestedName === null
        ? null
        : resolveTranscriptSpeakerName({ name: requestedName, speaker: currentSpeaker, speakers });
    if (requestedName !== null && name === null) {
      showFailure("その名前は付けられません。別の名前を入力してください。");
      return;
    }
    const defaultLabel = formatTranscriptSpeakerDefaultLabel(currentSpeaker.index);
    const nextMarkdown = renameTranscriptSpeakerLabel(
      markdown,
      names[currentSpeaker.key] ?? defaultLabel,
      name ?? defaultLabel,
      currentSpeaker.partIndex,
    ).trimEnd();
    const nextNames = { ...names };
    if (name) nextNames[currentSpeaker.key] = name;
    else delete nextNames[currentSpeaker.key];
    const record: RunRecord = {
      id: newId("save"),
      kind: "save",
      at: new Date().toISOString(),
      stepId: targetStepId,
      stepName: selectedTarget?.name ?? stepName(targetView, targetStepId),
      ...(targetCandidate ? { candidateId: targetCandidate.id, artifactId: targetCandidate.artifactId } : {}),
      version: null,
      result: "saved",
      outputChars: countChars(nextMarkdown),
      transcriptSpeakerNames: nextNames,
      ...(base?.basis ? { basis: base.basis } : {}),
    };
    // React state の反映より先に同期的に塞ぎ、保存・話者変更の二重実行を防ぐ。
    savingRef.current = true;
    speakerSavingRef.current = true;
    setSaving(true);
    let locked = false;
    try {
      await bridge.acquireRunLock(rec.projectId);
      locked = true;
      await bridge.saveOpenedArtifact(opened.handle, nextMarkdown, record);
      // 直していた本文ごと版にした（自動の版を重ねない）
      autoVersion.versioned(artifactSaveKey(key, opened.scopeId), nextMarkdown);
      await reloadView(rec);
      setDrafts((all) => {
        const current = all[key];
        if (targetDraft === undefined) {
          if (current !== undefined) return all;
        } else if (!current || current.markdown !== targetDraft.markdown) return all;
        const next = { ...all };
        delete next[key];
        return next;
      });
      await refreshProjects();
      showToast(name ? `${defaultLabel}を「${name}」にしました` : `${defaultLabel}の名前を外しました`);
    } catch (error) {
      showFailure(errorMessage(error, "話者の名前を保存できませんでした。もう一度お試しください。"));
    } finally {
      if (locked) await bridge.releaseRunLock(rec.projectId).catch(() => undefined);
      savingRef.current = false;
      speakerSavingRef.current = false;
      setSaving(false);
    }
  };

  /** 表示している成果物の版の記録（新しい順。別案は案の版）。 */
  const currentVersions = (shown: RecordingView, step: string): RunRecord[] =>
    selectedTarget ? candidateVersions(shown, step, selectedTarget.candidateId) : versionsOf(shown.runs, step);

  /**
   * 履歴の古い版を読むだけで開く（#18912）。同じ番号の版が 2 台の Mac で別々に保存されることがあるので、選んだ行の versionPath で
   * 開く。直していた書きかけは、開く前に今の文書へ書き残す。
   */
  const openVersion = async (version: number, versionPath?: string) => {
    if (!view || !stepId) return;
    const artifactId = currentArtifactId ?? stepId;
    const key = draftKey(view.key, artifactId);
    try {
      const opened = openedArtifactRef.current;
      if (opened?.key === key) await autosave.flush(artifactSaveKey(key, opened.scopeId));
      const path = versionPath ?? currentVersions(view, stepId).find((record) => record.version === version)?.versionPath;
      const markdown = await bridge.readVersion(recordingRef(view), artifactId, version, path);
      setViewingVersion({ key, scopeId: documentScopeId, version, ...(path ? { versionPath: path } : {}), markdown });
    } catch (error) {
      showFailure(errorMessage(error, "その版を開けませんでした。"));
    }
  };

  /** 「現在版に戻る」: 古い版の表示をやめる（今の文書・書きかけはそのまま）。 */
  const closeVersion = () => setViewingVersion(null);

  /**
   * 「この版に戻す」（#18912）: (a) 戻す前の内容を版に残し（版の後に直していれば。before_restore）、(b) 選んだ版の本文を新しい版
   * （restoredFrom）にして現在版にする。(a) を作れなければ戻さない。
   */
  const restoreVersion = async () => {
    const shown = viewingShown;
    if (!view || !stepId || !currentArtifactId || !shown) return;
    if (savingRef.current) {
      showFailure("保存が終わってから、もう一度お試しください。");
      return;
    }
    if (runRef.current !== null) {
      showFailure("工程の実行が終わってから戻してください。");
      return;
    }
    if (chat.sending || chat.live !== null) {
      showFailure("「AIと作る」の依頼が終わってから戻してください。");
      return;
    }
    const key = draftKey(view.key, currentArtifactId);
    const opened = openedArtifactRef.current;
    if (!opened || opened.key !== key || opened.scopeId !== documentScopeId) {
      showFailure("本文を開き直してから、もう一度お試しください。");
      return;
    }
    const markdown = finalizeMarkdown(shown.markdown);
    if (!markdown) {
      showFailure("空の版には戻せません。");
      return;
    }
    const versions = currentVersions(view, stepId);
    const base =
      versions.find((record) => record.version === shown.version && (!shown.versionPath || record.versionPath === shown.versionPath)) ??
      versions.find((record) => record.version === shown.version);
    const record: RunRecord = {
      id: newId("save"),
      kind: "save",
      at: new Date().toISOString(),
      stepId,
      stepName: selectedTarget?.name ?? stepName(view, stepId),
      ...(selectedTarget ? { candidateId: selectedTarget.candidateId, artifactId: selectedTarget.artifactId } : {}),
      version: null,
      result: "saved",
      outputChars: countChars(markdown),
      ...(base?.basis ? { basis: base.basis } : {}),
      ...(stepId === SOURCE_STEP_ID && base?.transcriptSpeakerNames !== undefined
        ? { transcriptSpeakerNames: normalizeTranscriptSpeakerNames(base.transcriptSpeakerNames) }
        : {}),
      restoredFrom: shown.version,
    };
    const rec = recordingRef(view);
    const saveKey = artifactSaveKey(key, opened.scopeId);
    savingRef.current = true;
    setSaving(true);
    try {
      // (a) 戻す前の内容を版に残す
      if (!(await autoVersion.create(saveKey, "before_restore"))) {
        showFailure("戻す前の内容を版に残せなかったため、戻していません。もう一度お試しください。");
        return;
      }
      // (b) 選んだ版の本文を新しい版にして現在版にする（(a) で handle は変わらない。念のため今の handle で保存する）
      const handle = openedArtifactRef.current?.key === key ? openedArtifactRef.current.handle : opened.handle;
      await bridge.saveOpenedArtifact(handle, markdown, record);
      // 世代は返らないので、届いている同期の状態より新しい保存とみなす（古い状態で「クラウドに保存済み」にしない）。
      autosave.markSaved(
        saveKey,
        { rec, stepId: currentArtifactId, source: isTranscriptFile(currentArtifactId), handle, draftKey: key, scopeId: opened.scopeId },
        (cloud.snapshots[toCloudProjectId(rec.projectId)]?.localGeneration ?? 0) + 1,
      );
      autoVersion.versioned(saveKey, markdown);
      // 戻す前の書きかけは (a) で版にしたので外す（戻した本文を古い書きかけで隠さない）
      context.dropDraft(key);
      setViewingVersion(null);
      await reloadView(rec);
      await refreshProjects();
      showToast(`版 ${shown.version} に戻しました`);
    } catch (error) {
      showFailure(errorMessage(error, "この版に戻せませんでした。"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  /**
   * 録音の「AIと作る」: 依頼を送る・AI の変更を元に戻す前に、その録音の版の後に直した文書を版にする（#18912 の before_ai。
   * 依頼の間は版を作らないので、依頼を始める前に作る。版を作れなくても送るのは止めない）。
   */
  const beforeRecordingAi = async () => {
    const shown = viewRef.current;
    if (!shown || chat.sending || chat.live !== null) return;
    await createAutoVersions("before_ai", (_key, target) => recordingKey(target.rec) === shown.key).catch(() => false);
  };
  const recordingChat: ChatController = {
    ...chat,
    send: async (text) => {
      await beforeRecordingAi();
      return chat.send(text);
    },
    undo: async (conversationId, turnId, version) => {
      await beforeRecordingAi();
      return chat.undo(conversationId, turnId, version);
    },
  };

  /**
   * 録音から作ったページの「作り直す」（タイトルバーの ⋯・本文の上の知らせ。#18915）。工程の実行と同じ（文字起こしのページは
   * 文字起こしし直す）。作り直す前の最新の版を覚え、終わったらトーストの「元に戻す」でその版へ戻せるようにする。
   */
  const rebuildStep = (id: string) => {
    const current = viewRef.current;
    if (!current) return;
    const latest = latestVersionRecord(current.runs, id);
    startRun([id], null, "step", { stepId: id, latestBefore: latest ? versionKey(latest) : null });
  };

  /**
   * 「作り直しました」の「元に戻す」: 作り直す前の版の中身で新しい版を足す（履歴は消さない。会話の「元に戻す」と同じ undoVersion）。
   * 書きかけがある・その後に版が増えた（書きかけを保存した）ときは戻さず、理由を帯に出す。
   */
  const undoRebuild = async (undo: RebuildUndo) => {
    const { rec, stepId: undoStepId, stepName: name } = undo;
    if (savingRef.current) {
      showFailure("保存が終わってから元に戻してください。");
      return;
    }
    if (runRef.current !== null) {
      showFailure("工程の実行が終わってから元に戻してください。");
      return;
    }
    const key = draftKey(undo.viewKey, undoStepId);
    const draft = draftsRef.current[key];
    const shown = viewRef.current?.key === undo.viewKey ? viewRef.current : null;
    const savedText = shown ? stepMarkdown(shown, undoStepId) : undefined;
    // 書きかけ（まだ今の文書へ書けていない）か、版の後に直した内容（自動保存で今の文書にある）があれば、戻して消さない（#18912）
    const opened = openedArtifactRef.current;
    const editedAfterVersion = opened !== null && opened.key === key && autoVersion.isEdited(artifactSaveKey(key, opened.scopeId));
    if ((draft && (savedText === undefined || isMarkdownChanged(draft.markdown, savedText))) || editedAfterVersion) {
      showFailure(`${name}は作り直した後に編集されているため、元に戻せません。`);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    let locked = false;
    try {
      await bridge.acquireRunLock(rec.projectId);
      locked = true;
      const fresh = await reloadView(rec);
      const latest = latestVersionRecord(fresh.runs, undoStepId);
      if (!latest || versionKey(latest) !== undo.createdKey || fresh.unversioned.includes(undoStepId)) {
        showFailure(`${name}はその後に変わっているため、元に戻せません。`);
        return;
      }
      await undoVersion({
        bridge,
        view: fresh,
        version: { stepId: undoStepId, stepName: name, version: undo.createdVersion, previous: undo.previousVersion, chars: 0, delta: 0 },
        ...(undo.previousPath ? { previousPath: undo.previousPath } : {}),
        newId,
        now: () => new Date(),
      });
      // 保存済みと同じ書きかけ（開いた直後の整え直し）は外し、戻した本文で開き直す
      context.dropDraft(key);
      await reloadView(rec);
      await refreshProjects().catch(() => undefined);
      showToast("元に戻しました");
    } catch (error) {
      showFailure(errorMessage(error, "元に戻せませんでした。"));
    } finally {
      if (locked) await bridge.releaseRunLock(rec.projectId).catch(() => undefined);
      savingRef.current = false;
      setSaving(false);
    }
  };
  undoRebuildRef.current = undoRebuild;

  const openCandidateDialog = (projectId: ProjectId, pageId: string, candidateStepId: string) => {
    const space = projectId === null ? outside : folders.find((folder) => folder.id === projectId) ?? null;
    const page = space?.pages.find((entry) => entry.id === pageId && entry.kind === "rec");
    const recordingId = page?.recordingId ?? pageId;
    const summary = space?.recordings[recordingId];
    if (!summary || !stepSupportsCandidates(summary.recording.flowSnapshot, candidateStepId)) return;
    const candidates = candidatesFor(summary.recording, candidateStepId);
    const count = Math.max(1, candidates.length);
    const selected = selectionRef.current;
    const selectedId = openRef.current?.id === projectId
      && selected?.pageId === pageId
      && selected.stepId === candidateStepId
      ? selected.candidateId
      : null;
    const source = candidateFor(summary.recording, candidateStepId, selectedId);
    setFailure(null);
    setCandidateDialog({
      projectId,
      pageId,
      recordingId,
      stepId: candidateStepId,
      stepName: summary.recording.flowSnapshot.steps.find((step) => step.id === candidateStepId)?.name ?? "",
      mode: "generate",
      name: `別案 ${count + 1}`,
      instruction: "",
      sourceCandidateId: source?.id ?? null,
      sourceArtifactId: source?.artifactId ?? candidateStepId,
      sourceName: source?.name ?? "現在の本文",
    });
  };

  const createCandidate = async () => {
    const dialogState = candidateDialog;
    if (!dialogState || candidateBusy || !dialogState.name.trim()) return;
    if (runRef.current || chatSendingProjectRef.current === dialogState.projectId) {
      showFailure("処理が終わってから別案を作成してください。");
      return;
    }
    if (rootChangeRef.current) {
      showFailure("保存先の変更が終わってから別案を作成してください。");
      return;
    }
    setCandidateBusy(true);
    let runLockHeld = false;
    const rec = { projectId: dialogState.projectId, recordingId: dialogState.recordingId };
    try {
      await bridge.acquireRunLock(dialogState.projectId);
      runLockHeld = true;
      const loadedSpace = openProjectOf(await bridge.loadPages(dialogState.projectId));
      const page = loadedSpace.pages.find((entry) => entry.id === dialogState.pageId && entry.kind === "rec");
      if (!page) throw NO_RECORDING;
      let fresh = await loadRecordingView(bridge, dialogState.projectId, loadedSpace.project, page);
      const sourceCandidate = dialogState.sourceCandidateId
        ? candidateFor(fresh.recording, dialogState.stepId, dialogState.sourceCandidateId)
        : null;
      if (dialogState.sourceCandidateId && !sourceCandidate) throw new Error("複製元の案が見つかりません。");
      const sourceArtifactId = sourceCandidate?.artifactId ?? dialogState.sourceArtifactId;
      if (dialogState.mode === "duplicate") {
        const sourceDraftKey = draftKey(fresh.key, sourceArtifactId);
        const sourceDraft = drafts[sourceDraftKey];
        if (sourceDraft) {
          if (!finalizeMarkdown(sourceDraft.markdown)) throw new Error("空の文書は保存できません。");
          const sourceTarget: ChatTarget | null = sourceCandidate
            ? { stepId: dialogState.stepId, candidateId: sourceCandidate.id, artifactId: sourceCandidate.artifactId, name: sourceCandidate.name }
            : null;
          const saved = await saveProjectDrafts({
            bridge,
            view: fresh,
            drafts: { [sourceDraftKey]: sourceDraft },
            newId,
            now: () => new Date(),
            artifactId: sourceArtifactId,
            target: sourceTarget,
          });
          if (!saved.includes(sourceDraftKey)) throw new Error("複製元の本文を保存できませんでした。");
          setDrafts((all) => {
            const next = { ...all };
            delete next[sourceDraftKey];
            return next;
          });
        }
        fresh = await loadRecordingView(bridge, dialogState.projectId, loadedSpace.project, page);
      }
      const now = new Date().toISOString();
      const candidate = {
        id: newId("candidate"),
        artifactId: newId("artifact"),
        name: dialogState.name.trim(),
        createdAt: now,
        ...(dialogState.mode === "generate" && dialogState.instruction.trim() ? { instruction: dialogState.instruction.trim() } : {}),
      };
      const updated = addCandidate(fresh.recording, {
        stepId: dialogState.stepId,
        candidate,
        primaryId: newId("candidate"),
        primaryName: "最初の案",
        now,
      });

      let duplicateMarkdown: string | null = null;
      let duplicateRecord: RunRecord | null = null;
      if (dialogState.mode === "duplicate") {
        const markdown = fresh.artifacts[sourceArtifactId];
        if (!markdown?.trim()) throw new Error("複製する本文がありません。");
        const sourceVersion = sourceCandidate
          ? candidateLatestVersion(fresh, dialogState.stepId, sourceCandidate.id)
          : latestVersionRecord(fresh.runs, dialogState.stepId);
        duplicateMarkdown = markdown;
        duplicateRecord = {
          id: newId("save"),
          kind: "save",
          at: now,
          stepId: dialogState.stepId,
          stepName: candidate.name,
          candidateId: candidate.id,
          artifactId: candidate.artifactId,
          version: null,
          result: "saved",
          outputChars: countChars(markdown),
          ...(sourceVersion?.basis ? { basis: sourceVersion.basis } : {}),
          inputVersions: { [sourceArtifactId]: sourceVersion?.version ?? 0 },
        };
      }
      const candidateSet = updated.candidateSets?.[dialogState.stepId];
      if (!candidateSet) throw new Error("案の台帳を作れませんでした。");
      if (dialogState.mode === "generate") {
        const current = viewRef.current;
        if (
          !current ||
          current.projectId !== dialogState.projectId ||
          current.recordingId !== dialogState.recordingId ||
          runRef.current ||
          rootChangeRef.current
        ) {
          throw new Error("別案を生成できる状態ではありません。もう一度お試しください。");
        }
      }
      await bridge.createCandidate(rec, dialogState.stepId, candidateSet, candidate.artifactId, duplicateMarkdown, duplicateRecord);
      setCandidateDialog(null);
      if (dialogState.mode === "generate") {
        // 別案の台帳作成だけを旧store lockで閉じ、生成はNative controller自身のoperation/leaseへ渡す。
        await bridge.releaseRunLock(dialogState.projectId);
        runLockHeld = false;
        const started = startRun([dialogState.stepId], {
          stepId: dialogState.stepId,
          candidateId: candidate.id,
          artifactId: candidate.artifactId,
          name: candidate.name,
          instruction: candidate.instruction,
        });
        if (!started) throw new Error("別案は作成されましたが、生成を開始できませんでした。");
      } else {
        await reloadView(rec);
        await refreshProjects();
        await selectLocationPage(dialogState.projectId, dialogState.pageId, dialogState.stepId, candidate.id);
        showToast("本文を複製しました");
      }
    } catch (error) {
      showFailure(errorMessage(error, "別案を作成できませんでした。"));
    } finally {
      if (runLockHeld) await bridge.releaseRunLock(dialogState.projectId).catch(() => undefined);
      setCandidateBusy(false);
    }
  };

  const commitCandidateName = async (target: ChatTarget, name: string) => {
    const current = viewRef.current;
    if (!current || !name.trim()) return;
    try {
      await bridge.renameCandidate(recordingRef(current), target.stepId, target.candidateId, name);
      setCandidateNameEdits((all) => {
        const next = { ...all };
        delete next[target.candidateId];
        return next;
      });
      await reloadView(recordingRef(current));
      await refreshProjects();
    } catch (error) {
      showFailure(errorMessage(error, "案の名前を保存できませんでした。"));
    }
  };

  const copy = async (markdown: string) => {
    try {
      await bridge.copyText(finalizeMarkdown(markdown));
      showToast("コピーしました");
    } catch (error) {
      showFailure(errorMessage(error, "コピーできませんでした。"));
    }
  };

  /**
   * 書き出しのファイル名はフォルダ内なら「〈フォルダ名〉 〈工程名〉.md」、フォルダ外なら「〈案件名〉 〈録音のタイトル〉 〈工程名〉.md」。
   * フォルダの録音は録音のページを出さないので録音名を重ねない（#18914）。
   */
  const exportFile = async (markdown: string, recordingTitle: string) => {
    if (!view || !stepId) return;
    try {
      const stepPart = fileStem(selectedTarget?.name ?? stepName(view, stepId));
      const path = await bridge.saveMarkdownAs(
        view.projectId !== null
          ? `${fileStem(recordingTitle)} ${stepPart}.md`
          : `${fileStem(view.project.name)} ${fileStem(recordingTitle)} ${stepPart}.md`,
        finalizeMarkdown(markdown),
      );
      if (path) showToast("書き出しました");
    } catch (error) {
      showFailure(errorMessage(error, "書き出せませんでした。"));
    }
  };

  const reveal = async () => {
    if (!view || !stepId) return;
    try {
      await bridge.revealArtifact(recordingRef(view), currentArtifactId ?? stepId, isTranscriptFile(currentArtifactId ?? stepId));
    } catch (error) {
      showFailure(errorMessage(error, "Finder で表示できませんでした。"));
    }
  };

  // ---- 文字起こしの別案（#19108） ----

  /** 後工程に使う文字起こしを変えた直後の 1 行（変えた録音の文字起こしのページにだけ出す。「元に戻す」で前の案へ）。 */
  const [sourceSwitch, setSourceSwitch] = useState<SourceSwitch | null>(null);

  /**
   * 文字起こしを別のエンジンでもう 1 つ作る。名前・設定の入力は無く、録音の話者人数・言語・固有名詞をそのまま使う。最初の 1 つ目を足すと
   * きは今の文字起こし（transcript.md）を最初の案として台帳に載せる（本文・版・話者名は動かさない）。作った案のページを開き、文字起こし
   * だけを始める（後工程は始めない。後工程に使う指定も変えない）。
   */
  const createSourceCandidate = async (projectId: ProjectId, pageId: string, engineId: TranscriptionEngineId) => {
    if (candidateBusy) return;
    if (runRef.current || chatSendingProjectRef.current === projectId) {
      showFailure("処理が終わってから文字起こしを追加してください。");
      return;
    }
    if (rootChangeRef.current) {
      showFailure("保存先の変更が終わってから文字起こしを追加してください。");
      return;
    }
    setCandidateBusy(true);
    let runLockHeld = false;
    try {
      await bridge.acquireRunLock(projectId);
      runLockHeld = true;
      const loadedSpace = openProjectOf(await bridge.loadPages(projectId));
      const page = loadedSpace.pages.find((entry) => entry.id === pageId && entry.kind === "rec");
      if (!page) throw NO_RECORDING;
      const fresh = await loadRecordingView(bridge, projectId, loadedSpace.project, page);
      if (!candidatesAllowed(fresh.recording, SOURCE_STEP_ID)) throw new Error("音声のある録音だけ、文字起こしを追加できます。");
      const now = new Date().toISOString();
      const primaryRecord = latestVersionRecord(fresh.runs, SOURCE_STEP_ID, candidateFor(fresh.recording, SOURCE_STEP_ID, null));
      const origin = transcriptOriginProvider(fresh.runs, primaryRecord?.version ?? null);
      const primaryEngine: TranscriptionEngine | undefined = origin === "gemini" || origin === "this-mac" || origin === "deepgram" ? origin : undefined;
      const primaryConnection = primaryEngine === "gemini" ? primaryRecord?.connection ?? "subscription" : undefined;
      const primaryName = primaryEngine ? engineName(primaryEngine) : "最初の文字起こし";
      const engine = engineProvider(engineId);
      const connection = engineConnection(engineId);
      const existingNames = new Set([
        primaryName,
        ...Object.values(fresh.recording.candidateSets?.[SOURCE_STEP_ID]?.items ?? {}).map((item) => item.name),
      ]);
      const name = engine === "gemini"
        ? (() => {
            const base = engineId === "gemini-api" ? "Gemini（API キー）" : "Gemini（サブスクリプション）";
            if (!existingNames.has(base)) return base;
            for (let number = 2; ; number += 1) if (!existingNames.has(`${base} ${number}`)) return `${base} ${number}`;
          })()
        : sourceCandidateName(fresh.recording, engine, { name: primaryName, ...(primaryEngine ? { engine: primaryEngine } : {}) });
      const candidate = {
        id: newId("candidate"),
        artifactId: newId("artifact"),
        name,
        engine,
        ...(connection ? { engineConnection: connection } : {}),
        createdAt: now,
      };
      const updated = addCandidate(fresh.recording, {
        stepId: SOURCE_STEP_ID,
        candidate,
        primaryId: newId("candidate"),
        primaryName,
        ...(primaryEngine ? { primaryEngine } : {}),
        ...(primaryConnection ? { primaryConnection } : {}),
        now,
      });
      const candidateSet = updated.candidateSets?.[SOURCE_STEP_ID];
      if (!candidateSet) throw new Error("文字起こしの台帳を作れませんでした。");
      const rec = { projectId, recordingId: page.recordingId ?? page.id };
      await bridge.createCandidate(rec, SOURCE_STEP_ID, candidateSet, candidate.artifactId, null, null);
      // 台帳の作成だけを旧 store lock で閉じ、文字起こしは Native controller 自身の operation/lease へ渡す（記事本文の別案と同じ）
      await bridge.releaseRunLock(projectId);
      runLockHeld = false;
      await refreshProjects();
      await selectLocationPage(projectId, pageId, SOURCE_STEP_ID, candidate.id);
      const current = viewRef.current;
      if (!current || current.projectId !== projectId || current.recordingId !== rec.recordingId) {
        throw new Error("文字起こしの案は作成しましたが、開始できませんでした。案のページで作り直してください。");
      }
      const started = startRun(
        [SOURCE_STEP_ID],
        { stepId: SOURCE_STEP_ID, candidateId: candidate.id, artifactId: candidate.artifactId, name: candidate.name },
        "step",
        null,
        "transcribeOnly",
      );
      if (!started) throw new Error("文字起こしの案は作成しましたが、開始できませんでした。案のページで作り直してください。");
    } catch (error) {
      showFailure(errorMessage(error, "文字起こしを追加できませんでした。"));
    } finally {
      if (runLockHeld) await bridge.releaseRunLock(projectId).catch(() => undefined);
      setCandidateBusy(false);
    }
  };

  /**
   * 後工程（文字起こし修正・記事方針・記事本文など）に使う文字起こしを、開いている案に変える。開く・作るだけでは変えず、この操作だけで
   * 変える。作成済みのページは消さず、入力が変わったページには「元の文字起こしが変わりました。」が出る（自動では作り直さない）。
   * 別の画面・端末が先に変えていたら書かずに知らせる。
   */
  const chooseSourceCandidate = async (candidateId: string, undo = false) => {
    const current = viewRef.current;
    if (!current) return;
    if (runRef.current && runRef.current.projectId === current.projectId) {
      showFailure("実行が終わってから、後工程に使う文字起こしを選べます。");
      return;
    }
    if (chatSendingProjectRef.current === current.projectId) {
      showFailure("「AIと作る」の依頼が終わってから、後工程に使う文字起こしを選べます。");
      return;
    }
    const rec = recordingRef(current);
    const candidates = candidatesFor(current.recording, SOURCE_STEP_ID);
    const previousId = current.recording.sourceCandidateId ?? candidates[0]?.id ?? null;
    if (!previousId || previousId === candidateId) return;
    let runLockHeld = false;
    try {
      await bridge.acquireRunLock(current.projectId);
      runLockHeld = true;
      await bridge.setSourceCandidate(rec, candidateId, current.recording.sourceCandidateId ?? null);
      await bridge.releaseRunLock(current.projectId);
      runLockHeld = false;
      // 結果の 1 行は押したページに出す（元に戻したときも同じページ）
      const shownOn = selectionRef.current?.stepId === SOURCE_STEP_ID ? selectionRef.current.candidateId ?? candidateId : candidateId;
      setSourceSwitch({ key: current.key, shownOn, candidateId, previousId, undone: undo });
      await reloadView(rec);
      await refreshProjects();
    } catch (error) {
      showFailure(errorMessage(error, "後工程に使う文字起こしを変えられませんでした。"));
      await reloadView(rec).catch(() => undefined);
    } finally {
      if (runLockHeld) await bridge.releaseRunLock(current.projectId).catch(() => undefined);
    }
  };

  /** 版にしなかった途中までの出力（checkpoint）。 */
  const loadPartial = async (runId: string): Promise<string | null> => {
    const current = viewRef.current;
    if (!current) return null;
    const checkpoint = await bridge.readCheckpoint(recordingRef(current), runId);
    if (!checkpoint) return null;
    return checkpoint.pending ? `${checkpoint.output}\n\n${checkpoint.pending}` : checkpoint.output;
  };
  return {
    stepId, currentArtifactId, currentDraft, viewingShown,
    changeDraft, renameSpeaker, openVersion, closeVersion,
    restoreVersion, recordingChat, rebuildStep, openCandidateDialog,
    createCandidate, commitCandidateName, copy, exportFile,
    reveal, loadPartial, createSourceCandidate, chooseSourceCandidate,
    sourceSwitch: sourceSwitch && view && sourceSwitch.key === view.key ? sourceSwitch : null,
  };
}
