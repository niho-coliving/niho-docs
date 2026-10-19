"use client";

import type { DocsAutoVersionReason } from "@niho/docs-core";
import { effortLabel, providerLabel, redirectedNote, remoteRunAcceptedLabel, shortModelLabel, snapshotModelLabel, SOURCE_STEP_ID, type PromptRef, type RunStartAction } from "@niho/docs-core";
import { useCallback, useEffect } from "react";
import { type Failure, type FailureAction } from "../components/FailureBand";
import type { ProjectEntry } from "../host/DocsHost";
import { type AutoVersionTarget } from "../lib/artifact-auto-version";
import { errorMessage, type Bridge, type PersonalNihoPending, type ProjectId, type RecordingRef } from "../lib/bridge";
import { type ChatTarget } from "../lib/chat";
import type { CloudController } from "../lib/cloud";
import { PersonalCancellationError, type PersonalRoute } from "../lib/personal-execution";
import { newPersonalId, runNativePersonalExecution, type NativePersonalDeps, type NativePersonalRequest } from "../lib/personal-native";
import { latestVersionRecord, recordingKey, recordingRef, stepName, versionsOf, type RecordingView } from "../lib/project-view";
import { candidateChoiceReason } from "../lib/run-gate";
import { startRouteOf } from "../lib/run-start";
import { type ActiveRun, type RunNotice } from "../lib/run-state";
import { type RunProgress } from "../lib/runner";
import { activeProviders, effectiveEngine, engineLabel, type AppSettings } from "../lib/settings";
import { draftKey, LIVE_FLUSH_MS, versionKey, type Draft, type NihoRunConfirmation, type RebuildRequest, type RebuildUndo, type ToastAction } from "./workspace-model";

type Context = {
  runRef: React.MutableRefObject<ActiveRun | null>;
  flushTimer: React.MutableRefObject<number | null>;
  setActiveRun: React.Dispatch<React.SetStateAction<ActiveRun | null>>;
  viewRef: React.MutableRefObject<RecordingView | null>;
  cloudContextRef: React.MutableRefObject<{ generation: number | null; scopeId: string | null; }>;
  settingsRef: React.MutableRefObject<AppSettings>;
  bridge: Bridge;
  flushArtifacts: () => Promise<boolean>;
  createAutoVersions: (reason: DocsAutoVersionReason, match?: (key: string, target: AutoVersionTarget) => boolean) => Promise<boolean>;
  runFlushRef: React.MutableRefObject<AbortController | null>;
  runAbortRef: React.MutableRefObject<AbortController | null>;
  setNihoRunConfirmation: React.Dispatch<React.SetStateAction<NihoRunConfirmation | null>>;
  reloadView: (rec: RecordingRef, frozenRefs?: readonly PromptRef[], shouldApply?: () => boolean) => Promise<RecordingView>;
  refreshProjects: (shouldApply?: () => boolean) => Promise<ProjectEntry[]>;
  selectLocationPage: (projectId: ProjectId, pageId: string, stepId: string | null, candidateId?: string | null, shouldApply?: () => boolean) => Promise<void>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, Draft>>>;
  setNotice: React.Dispatch<React.SetStateAction<RunNotice | null>>;
  showToast: (text: string, action?: ToastAction) => void;
  undoRebuildRef: React.MutableRefObject<(undo: RebuildUndo) => Promise<void>>;
  continuationChainRef: React.MutableRefObject<{ key: string; generation: number | null; scopeId: string | null; } | null>;
  personalNihoPending: PersonalNihoPending | null;
  showFailure: (text: string, action?: FailureAction) => void;
  savingRef: React.MutableRefObject<boolean>;
  rootChangeRef: React.MutableRefObject<boolean>;
  setFailure: React.Dispatch<React.SetStateAction<Failure | null>>;
  setPersonalNihoPending: React.Dispatch<React.SetStateAction<PersonalNihoPending | null>>;
  activeRun: ActiveRun | null;
  view: RecordingView | null;
  cloud: CloudController;
  documentScopeId: string | null;
  accountExecutionProblem: string | null;
};

/** 録音の工程実行・停止と NIHO に任せた続きの受付確認。 */
export function useExecutionActions(context: Context) {
  const {
    runRef, flushTimer, setActiveRun, viewRef,
    cloudContextRef, settingsRef,
    bridge, flushArtifacts, createAutoVersions, runFlushRef,
    runAbortRef, setNihoRunConfirmation, reloadView, refreshProjects,
    selectLocationPage, setDrafts, setNotice, showToast,
    undoRebuildRef, continuationChainRef, personalNihoPending, showFailure,
    savingRef, rootChangeRef, setFailure, setPersonalNihoPending,
    activeRun, view, cloud, documentScopeId, accountExecutionProblem,
  } = context;

  // ---- 実行 ----

  const updateRun = useCallback((change: (run: ActiveRun) => Partial<ActiveRun>) => {
    const current = runRef.current;
    if (!current) return;
    runRef.current = { ...current, ...change(current) };
  }, [runRef]);

  /** runRef の今の値を画面へ（逐次表示は間引く）。 */
  const flushRun = useCallback((immediate: boolean) => {
    const publish = () => {
      flushTimer.current = null;
      setActiveRun(runRef.current);
    };
    if (immediate) {
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
      publish();
    } else if (flushTimer.current === null) {
      flushTimer.current = window.setTimeout(publish, LIVE_FLUSH_MS);
    }
  }, [flushTimer, runRef, setActiveRun]);

  const onProgress = useCallback(
    (progress: RunProgress) => {
      switch (progress.kind) {
        case "turn":
          updateRun(() => ({ turnId: progress.turnId, continuation: progress.continuation }));
          flushRun(true);
          return;
        case "thinking":
          updateRun((run) => ({ thinking: (run.thinking + progress.text).slice(-240).split("\n").filter(Boolean).pop() ?? "" }));
          flushRun(false);
          return;
        case "text":
        case "speech-text":
          updateRun(() => ({ text: progress.text }));
          flushRun(false);
          return;
        case "speech": {
          const event = progress.event;
          if (event.type === "Stage") {
            updateRun((run) => ({
              speech: {
                stage: event.stage,
                file: event.file,
                files: event.files,
                part: event.part ?? 0,
                parts: event.parts ?? 1,
                ratio: 0,
                diarized: event.stage === "diarize" || (run.speech?.file === event.file && run.speech.diarized),
              },
            }));
            flushRun(true);
          } else if (event.type === "Progress") {
            updateRun((run) => (run.speech ? { speech: { ...run.speech, part: event.part, parts: event.parts, ratio: event.ratio } } : {}));
            flushRun(false);
          }
          return;
        }
      }
    },
    [flushRun, updateRun],
  );

  const executeQueue = async (
    captured: RecordingView,
    capturedContext: { generation: number | null; scopeId: string | null },
    queue: string[],
    fixedTarget: (ChatTarget & { instruction?: string }) | null,
    route: PersonalRoute,
    consentVersion: string,
    controller: AbortController,
    rebuild: RebuildRequest | null,
  ): Promise<boolean> => {
    const sameCapturedScope = () =>
      viewRef.current?.key === captured.key && cloudContextRef.current.generation === capturedContext.generation &&
      cloudContextRef.current.scopeId === capturedContext.scopeId;
    const rec = recordingRef(captured);
    const stepIds = route.kind === "local_transcription_only" ? [] : queue.filter((stepIdToRun) => stepIdToRun !== SOURCE_STEP_ID);
    const engine = route.kind === "generation_only" ? null : effectiveEngine(settingsRef.current);
    const targetIndex = fixedTarget ? captured.flow.steps.findIndex((step) => step.id === fixedTarget.stepId) : -1;
    const request: NativePersonalRequest = {
      runId: newPersonalId("run"),
      intentId: newPersonalId("intent"),
      projectId: rec.projectId,
      recordingPageId: captured.page.id,
      recordingId: rec.recordingId,
      route,
      transcriptionProvider: engine,
      // controller がflush/pull後にNative素材の確定原文版から束縛する。画面の古いruns行を使わない。
      continuationOfRunId: null,
      consentVersion,
      stepIds,
      ...(fixedTarget
        ? {
            outputTarget: {
              stepId: fixedTarget.stepId,
              candidateId: fixedTarget.candidateId,
              artifactId: fixedTarget.artifactId,
              ...(fixedTarget.instruction ? { instruction: fixedTarget.instruction } : {}),
              inputVersions: Object.fromEntries([
                [SOURCE_STEP_ID, latestVersionRecord(captured.runs, SOURCE_STEP_ID)?.version ?? 0],
                ...captured.flow.steps.slice(0, Math.max(0, targetIndex)).map((step) => [step.id, latestVersionRecord(captured.runs, step.id)?.version ?? 0] as const),
              ]),
            },
          }
        : {}),
    };
    const result = await runNativePersonalExecution(
      {
        bridge,
        flushDirty: async () => {
          if (!sameCapturedScope()) throw new Error("実行する本人・保存先・録音が変わりました。もう一度実行してください。");
          try {
            if (!(await flushArtifacts())) throw new Error("書きかけを保存できなかったため、実行を開始しませんでした。");
            // AI が書き換える工程の文書は、版の後に直していれば先に版にする（#18912 の before_ai。版を作れなくても実行は止めない。
            // 置き換える保存は版になっていない今の内容を同じ保存単位で残す）
            await createAutoVersions(
              "before_ai",
              (_key, target) => recordingKey(target.rec) === captured.key && queue.includes(target.flowStepId),
            ).catch(() => false);
          } finally {
            if (runFlushRef.current === controller) runFlushRef.current = null;
          }
        },
        connection: () => ({ connection: settingsRef.current.connection, providers: activeProviders(settingsRef.current) }),
        readEntitlement: async () => ({ planConfirmed: false, usage: "unknown" }),
        now: () => new Date(),
        signal: controller.signal,
        onProgress: (progressStepId, progress) => {
          if (runAbortRef.current !== controller || !runRef.current || !sameCapturedScope()) return;
          const isSource = progressStepId === SOURCE_STEP_ID;
          const model = isSource ? null : captured.flow.models[progressStepId];
          runRef.current = {
            ...runRef.current,
            stepId: progressStepId,
            stepName: fixedTarget?.stepId === progressStepId ? fixedTarget.name : stepName(captured, progressStepId),
            modelLabel: isSource ? engineLabel(engine ?? "this-mac") : model ? `${providerLabel(model.provider)} ${snapshotModelLabel(model)}` : "",
            note: isSource
              ? engineLabel(engine ?? "this-mac")
              : model?.redirected
                ? redirectedNote(model.provider)
                : model
                  ? `${shortModelLabel(model.provider, model.model)} · ${effortLabel(model.effort)}`
                  : "",
          };
          setActiveRun(runRef.current);
          onProgress(progress);
        },
        ...(route.kind === "generation_only" && route.executor === "niho_api"
          ? {
              confirmNihoExecution: async ({ access, models, swap, sourceVersion }: Parameters<NonNullable<NativePersonalDeps["confirmNihoExecution"]>>[0]) => {
                if (controller.signal.aborted || !sameCapturedScope()) throw new PersonalCancellationError();
                const modelLabel = [...new Set(models.map((model) => `${providerLabel(model.provider)} ${shortModelLabel(model.provider, model.model)} · ${effortLabel(model.effort)}`))].join(" / ");
                const sourceRow = captured.runs.find((row) => row.versionPath === sourceVersion?.path && row.stepId === SOURCE_STEP_ID);
                const sourceVersionLabel = typeof sourceRow?.version === "number"
                  ? `第 ${sourceRow.version} 版`
                  : sourceVersion
                    ? "保存済みの確定原文"
                    : "確定原文なし";
                await new Promise<void>((resolve, reject) => {
                  let settled = false;
                  const finish = (accepted: boolean) => {
                    if (settled) return;
                    settled = true;
                    controller.signal.removeEventListener("abort", onAbort);
                    setNihoRunConfirmation((shown) => shown?.capturedKey === captured.key ? null : shown);
                    if (accepted && !controller.signal.aborted && sameCapturedScope()) resolve();
                    else reject(new PersonalCancellationError());
                  };
                  const onAbort = () => finish(false);
                  controller.signal.addEventListener("abort", onAbort, { once: true });
                  if (controller.signal.aborted) {
                    finish(false);
                    return;
                  }
                  setNihoRunConfirmation({
                    access,
                    capturedKey: captured.key,
                    context: capturedContext,
                    modelLabel,
                    swap,
                    sourceVersionLabel,
                    accept: () => finish(true),
                    cancel: () => finish(false),
                  });
                });
              },
            }
          : {}),
      },
      request,
    );
    if (runAbortRef.current !== controller) return false;
    if (sameCapturedScope()) {
      const reloaded = await reloadView(rec, undefined, sameCapturedScope).catch(() => undefined);
      if (!sameCapturedScope()) return false;
      await refreshProjects(sameCapturedScope).catch(() => undefined);
      if (!sameCapturedScope()) return false;
      if (fixedTarget) {
        await selectLocationPage(captured.projectId, captured.page.id, fixedTarget.stepId, fixedTarget.candidateId, sameCapturedScope);
        if (!sameCapturedScope()) return false;
      }
      setDrafts((all) => {
        const next = { ...all };
        for (const stepIdToRun of stepIds) delete next[draftKey(captured.key, fixedTarget?.stepId === stepIdToRun ? fixedTarget.artifactId : stepIdToRun)];
        return next;
      });
      if (result.state === "submitted") {
        setNotice({ projectId: rec.projectId, recordingId: rec.recordingId, stepId: "execution", kind: "submitted", message: remoteRunAcceptedLabel({ state: result.remoteState, reasonCode: result.remoteReasonCode }) });
      } else if (result.state === "input_changed") {
        setNotice({ projectId: rec.projectId, recordingId: rec.recordingId, stepId: "execution", kind: "failed", message: "元の内容が変わりました。内容を確かめてから作り直してください。" });
      } else if (result.state === "failed" || result.state === "result_unknown") {
        const message = result.state === "result_unknown"
          ? "実行結果を確認できません。自動ではやり直しません。"
          : "実行を完了できませんでした。履歴を確認してください。";
        setNotice({ projectId: rec.projectId, recordingId: rec.recordingId, stepId: "execution", kind: "failed", message });
      } else if (rebuild && (result.state === "completed" || result.state === "transcription_complete")) {
        // 「作り直す」で始めた実行だけ、短く知らせる。新しい版ができていて、その直前の版があれば「元に戻す」を添える。
        // 戻す先は、実行の前に取った版ではなく、できた版の 1 つ前にする（未確定の書きかけは実行の前に自動の版として残るので、そこまでが「作り直す直前」）
        const [created, previous] = reloaded ? versionsOf(reloaded.runs, rebuild.stepId) : [];
        if (created && previous && typeof created.version === "number" && typeof previous.version === "number" && versionKey(created) !== rebuild.latestBefore) {
          const undo: RebuildUndo = {
            rec,
            viewKey: captured.key,
            stepId: rebuild.stepId,
            stepName: stepName(captured, rebuild.stepId),
            previousVersion: previous.version,
            ...(previous.versionPath ? { previousPath: previous.versionPath } : {}),
            createdVersion: created.version,
            createdKey: versionKey(created),
          };
          showToast("作り直しました", { label: "元に戻す", run: () => void undoRebuildRef.current(undo) });
        } else {
          showToast("作り直しました");
        }
      }
    }
    // 結果を同じ録音・同じ保存先に出し、版を保存できた（続きをクラウドで作る予約はこのときだけ進める）
    return sameCapturedScope() && (result.state === "completed" || result.state === "transcription_complete");
  };

  const startRun = (
    queue: string[],
    fixedTarget: (ChatTarget & { instruction?: string }) | null = null,
    trigger: "selection" | "step" = "step",
    rebuild: RebuildRequest | null = null,
    action: RunStartAction | null = null,
  ): boolean => {
    const current = viewRef.current;
    if (!current || runRef.current || queue.length === 0) return false;
    // 新しく始める実行が、前の「文書作成を開始」の続きの予約を引き継がない（続きの予約は、この実行が成功したときだけ置き直す）
    continuationChainRef.current = null;
    if (personalNihoPending && personalNihoPending.projectId === current.projectId && personalNihoPending.recordingId === current.recordingId) {
      showFailure("前の依頼の受付結果を確認してから、新しく実行してください。");
      return false;
    }
    if (savingRef.current || rootChangeRef.current) {
      showFailure(savingRef.current ? "保存が終わってから実行してください。" : "保存先の変更が終わってから実行してください。");
      return false;
    }
    if (cloud.active && accountExecutionProblem && (trigger !== "selection" || action !== "transcribeOnly")) {
      showFailure(accountExecutionProblem);
      return false;
    }
    const captured = current;
    const capturedContext = { ...cloudContextRef.current };
    // 何をするかは押したボタン（action）、続きをどこで作るかは設定（#18947。決め方は run-start）。続きがクラウドで原文から作るときは、
    // この Mac で原文だけ作り、成功したら続きをクラウドで始める（continuationChainRef）
    const { route, chainToCloud } = startRouteOf({
      queue,
      step: trigger === "step",
      action,
      continuation: settingsRef.current.personalExecution.continuation,
    });
    const runQueue = route.kind === "local_transcription_only" ? [SOURCE_STEP_ID]
      : route.kind === "generation_only" ? queue.filter((id) => id !== SOURCE_STEP_ID) : queue;
    if (runQueue.length === 0) return false;
    if (fixedTarget && !runQueue.includes(fixedTarget.stepId)) fixedTarget = null;
    // 帯と入力欄のメニューが先に止めるので、ここに来るのは画面が古いときだけ（同じ文で知らせる）
    const candidateReason = candidateChoiceReason({ recording: current.recording, flow: current.flow, queue: runQueue, fixedStepId: fixedTarget?.stepId ?? null });
    if (candidateReason) {
      showFailure(candidateReason);
      return false;
    }
    if (route.kind === "generation_only" && route.executor === "niho_api") {
      const selectedSteps = runQueue;
      const fullFlow = selectedSteps.length === captured.flow.steps.length && captured.flow.steps.every((step, index) => selectedSteps[index] === step.id);
      if (!latestVersionRecord(captured.runs, SOURCE_STEP_ID)) {
        showFailure("クラウドで続きを作るには、このMacで確定した原文が必要です。先に文字起こしを完了してください。");
        return false;
      }
      if (!fullFlow || fixedTarget) {
        showFailure("クラウドには続きの工程をまとめて任せられます。単工程・途中から・別案は、このMacで実行してください。");
        return false;
      }
      if (captured.flow.steps.some((step) => captured.artifacts[step.id] !== undefined)) {
        showFailure("クラウドには、途中まで作ったページが無い録音の続きの工程だけを任せられます。設定で続きを「この Mac」にすると作れます。");
        return false;
      }
    }
    const first = runQueue[0]!;
    const controller = new AbortController();
    const claimed: ActiveRun = {
      projectId: captured.projectId,
      recordingId: captured.recordingId,
      stepId: first,
      stepName: fixedTarget?.stepId === first ? fixedTarget.name : first === SOURCE_STEP_ID ? "文字起こし" : stepName(captured, first),
      candidateId: fixedTarget?.candidateId ?? null,
      artifactId: fixedTarget?.artifactId ?? null,
      queue: runQueue.slice(1),
      turnId: null,
      jobId: null,
      startedAt: Date.now(),
      thinking: "",
      text: "",
      continuation: 0,
      speech: null,
      stopRequested: false,
      modelLabel: "準備中",
      note: "固定入力を準備しています",
    };
    // 最初の await より前に同期的に占有する。React state は表示用で、二重実行の正は runRef。
    runRef.current = claimed;
    runAbortRef.current = controller;
    runFlushRef.current = controller;
    setActiveRun(claimed);
    setNotice(null);
    setFailure(null);
    void (async () => {
      try {
        const saved = await executeQueue(
          captured,
          capturedContext,
          runQueue,
          fixedTarget,
          route,
          route.kind === "generation_only" && route.executor === "niho_api" ? "pending-v1" : "local-v1",
          controller,
          rebuild && runQueue.length === 1 && runQueue[0] === rebuild.stepId ? rebuild : null,
        );
        // 原文ができたら、続きをクラウドで作る予約を置く（止めた・失敗した・移った実行は置かない。画面には「続きを作成」が残る）
        if (chainToCloud && saved && !controller.signal.aborted && runAbortRef.current === controller) {
          continuationChainRef.current = { key: captured.key, generation: capturedContext.generation, scopeId: capturedContext.scopeId };
        }
      } catch (error) {
        const sameCapturedScope =
          viewRef.current?.key === captured.key && cloudContextRef.current.generation === capturedContext.generation &&
          cloudContextRef.current.scopeId === capturedContext.scopeId;
        if (!controller.signal.aborted && sameCapturedScope) {
          const message = error instanceof Error && error.message ? error.message : errorMessage(error, "実行できませんでした。");
          // Native が失敗・停止の行と途中checkpointを捕捉元へ公開した後、その同じscopeだけを読み直す。
          await reloadView(recordingRef(captured), undefined, () =>
            viewRef.current?.key === captured.key && cloudContextRef.current.generation === capturedContext.generation &&
            cloudContextRef.current.scopeId === capturedContext.scopeId,
          ).catch(() => undefined);
          await refreshProjects(() =>
            viewRef.current?.key === captured.key && cloudContextRef.current.generation === capturedContext.generation &&
            cloudContextRef.current.scopeId === capturedContext.scopeId,
          ).catch(() => undefined);
          if (
            viewRef.current?.key !== captured.key || cloudContextRef.current.generation !== capturedContext.generation ||
            cloudContextRef.current.scopeId !== capturedContext.scopeId
          ) return;
          showFailure(message);
          setNotice({
            projectId: captured.projectId,
            recordingId: captured.recordingId,
            stepId: first,
            kind: error instanceof PersonalCancellationError ? "stopped" : "failed",
            message,
          });
          if (route.kind === "generation_only" && route.executor === "niho_api") {
            const listed = await bridge.personalNihoPending().catch(() => null);
            if (
              listed && viewRef.current?.key === captured.key && cloudContextRef.current.generation === capturedContext.generation &&
              cloudContextRef.current.scopeId === capturedContext.scopeId
            ) {
              setPersonalNihoPending(
                listed.items.find((item) => item.projectId === captured.projectId && item.recordingPageId === captured.page.id && item.recordingId === captured.recordingId) ?? null,
              );
            }
          }
        }
      } finally {
        if (runAbortRef.current === controller) {
          setNihoRunConfirmation((shown) => shown?.capturedKey === captured.key ? null : shown);
          if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
          flushTimer.current = null;
          runAbortRef.current = null;
          if (runFlushRef.current === controller) runFlushRef.current = null;
          runRef.current = null;
          setActiveRun(null);
        }
      }
    })();
    return true;
  };

  const stop = async () => {
    const run = runRef.current;
    const controller = runAbortRef.current;
    if (!run || !controller) return;
    runRef.current = { ...run, stopRequested: true };
    setActiveRun(runRef.current);
    controller.abort();
  };

  // 「文書作成を開始」で続きがクラウドのとき: 原文を作った実行が終わり、同じ録音・同じ本人と保存先のまま読み直したら、続きを 1 回だけ
  // 始める（#18947）。録音が変わった・保存先が変わった・読み直した録音にまだ原文が無いときは予約を捨てる（「続きを作成」が残る）
  useEffect(() => {
    const chain = continuationChainRef.current;
    if (!chain || activeRun !== null || runRef.current !== null) return;
    continuationChainRef.current = null;
    const current = viewRef.current;
    const context = cloudContextRef.current;
    if (!current || current.key !== chain.key || context.generation !== chain.generation || context.scopeId !== chain.scopeId) return;
    const remaining = current.plan.remaining;
    if (remaining.length === 0 || remaining.includes(SOURCE_STEP_ID)) return;
    startRun(remaining, null, "selection", null, "continue");
  });

  useEffect(() => {
    const current = view;
    setPersonalNihoPending(null);
    if (!current) {
      return;
    }
    const capturedContext = { ...cloudContextRef.current };
    let disposed = false;
    void bridge.personalNihoPending().then(
      (listed) => {
        if (
          disposed || viewRef.current?.key !== current.key || cloudContextRef.current.generation !== capturedContext.generation ||
          cloudContextRef.current.scopeId !== capturedContext.scopeId
        ) return;
        setPersonalNihoPending(
          listed.items.find(
            (item) => item.projectId === current.projectId && item.recordingPageId === current.page.id && item.recordingId === current.recordingId,
          ) ?? null,
        );
      },
      () => {
        if (
          !disposed && viewRef.current?.key === current.key && cloudContextRef.current.generation === capturedContext.generation &&
          cloudContextRef.current.scopeId === capturedContext.scopeId
        ) setPersonalNihoPending(null);
      },
    );
    return () => { disposed = true; };
  }, [bridge, view?.key, cloud.state?.contextGeneration, documentScopeId, setPersonalNihoPending, cloudContextRef, viewRef]);

  const confirmPersonalNiho = async (action: "lookup" | "resend" | "release") => {
    const pending = personalNihoPending;
    const current = viewRef.current;
    if (!pending || !current || runRef.current) return;
    const capturedKey = current.key;
    const capturedContext = { ...cloudContextRef.current };
    try {
      const result = await bridge.personalNihoConfirm(pending.intentId, action);
      // Native は元本人の記録へ確定する。画面は本人・Root・録音が同じときだけ結果を反映する。
      if (
        viewRef.current?.key !== capturedKey || cloudContextRef.current.generation !== capturedContext.generation ||
        cloudContextRef.current.scopeId !== capturedContext.scopeId
      ) return;
      if (result.status === "accepted") {
        setNotice({ projectId: current.projectId, recordingId: current.recordingId, stepId: "execution", kind: "submitted", message: remoteRunAcceptedLabel({ state: result.state, reasonCode: result.reasonCode }) });
        setPersonalNihoPending(null);
      } else if (result.status === "rejected") {
        setPersonalNihoPending(null);
        showFailure("クラウドに受付を断られました。設定で続きを「この Mac」にすると作れます。");
      } else if (result.status === "absent") {
        setPersonalNihoPending(null);
        showToast("受け付けられていないことを確認しました。新しく実行できます。");
      } else if (result.status === "absent_unproven" || result.status === "cannot_confirm_yet") {
        showFailure("まだ受け付けられていないことを確認できません。同期後にもう一度照会してください。");
      } else if (result.status === "in_flight") {
        showFailure("同じ依頼を確認しています。終わってからもう一度お試しください。");
      } else {
        showFailure("受付結果を確認できませんでした。自動では送り直しません。");
      }
    } catch (error) {
      if (
        viewRef.current?.key === capturedKey && cloudContextRef.current.generation === capturedContext.generation &&
        cloudContextRef.current.scopeId === capturedContext.scopeId
      ) showFailure(errorMessage(error, "受付結果を確認できませんでした。"));
    }
  };
  return {
    startRun, stop, confirmPersonalNiho,
  };
}
