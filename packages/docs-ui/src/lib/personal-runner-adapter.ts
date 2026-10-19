import type { ResolvedStepModel, RunCheckpoint, RunRecord } from "@niho/docs-core";
import { isCommandError, type Bridge, type RecordingRef, type SpeechStatus } from "./bridge";
import { PersonalAuthenticationRequiredError, PersonalCancellationError, PersonalDispatchError, type PersonalCandidate } from "./personal-execution";
import { assertPersonalProviderReady, personalReportedModelMatches, type PersonalSubscriptionEntitlement } from "./personal-provider-readiness";
import {
  GEMINI_TRANSCRIPTION_EFFORT,
  GEMINI_TRANSCRIPTION_MODEL,
  DEEPGRAM_MODEL,
  runStep,
  runTranscription,
  type StepRunInput,
  type StepRunOutcome,
  type TranscriptionInput,
} from "./runner";

export type PersonalAdapterCapture = {
  outcome: StepRunOutcome;
  candidate: PersonalCandidate | null;
  partialCandidate: PersonalCandidate | null;
  records: RunRecord[];
  checkpoints: RunCheckpoint[];
};

export type PersonalAdapterPersistence = {
  saveCheckpoint?: (input: { rec: RecordingRef; runId: string; checkpoint: RunCheckpoint }) => Promise<void>;
  appendRun?: (input: { rec: RecordingRef; record: RunRecord }) => Promise<void>;
  savePartialCandidate?: (input: {
    candidate: PersonalCandidate;
    outcome: Exclude<StepRunOutcome, { status: "saved" }>;
    checkpoint: RunCheckpoint | null;
    record: RunRecord | null;
  }) => Promise<void>;
};

/**
 * 送っていないと確定している拒否の code。Native の送信直前の guard（dispatch marker の無い送信の拒否も同じ code）と、画面の側で
 * marker を書けなかった送信を止めたとき（personal-native.ts）。
 */
export const PERSONAL_NOT_SENT_CODES: ReadonlySet<string> = new Set(["personal_guard_failed", "personal_dispatch_unmarked"]);

/** 送っていないと確定している拒否か（result_unknown にしない）。 */
export function isPersonalNotSentRejection(error: unknown): boolean {
  return isCommandError(error) && PERSONAL_NOT_SENT_CODES.has(error.code);
}

/** adapterの終端をcontroller portへ渡す際、送信済み不明だけをresult_unknownとして明示する。 */
export function personalCandidateFromCapture(capture: PersonalAdapterCapture): PersonalCandidate {
  if (capture.outcome.status === "saved" && capture.candidate) return capture.candidate;
  const checkpoint = capture.checkpoints.at(-1) ?? null;
  if (capture.outcome.status === "stopped") {
    throw new PersonalCancellationError(capture.outcome.record.message ?? undefined, capture.outcome.record, checkpoint);
  }
  if (capture.outcome.status === "failed") {
    if (capture.outcome.reasonCode === "not_authenticated") throw new PersonalAuthenticationRequiredError(capture.outcome.message, capture.outcome.record, checkpoint);
    throw new PersonalDispatchError(
      capture.outcome.reasonCode === "ResultUnknown",
      capture.outcome.message,
      capture.outcome.record,
      checkpoint,
    );
  }
  throw new PersonalDispatchError(false, "候補を保存できませんでした。");
}

type CandidateLocation = { versionId: string; path: string; artifactId?: string };

function captureBridge(
  bridge: Bridge,
  location: CandidateLocation,
  stepId: string,
  provider: PersonalCandidate["provider"],
  selectedModel: string,
  source: boolean,
  beforeThisMacTranscribe?: (language: string) => Promise<void>,
  persistence: PersonalAdapterPersistence = {},
): { bridge: Bridge; result(outcome: StepRunOutcome): Promise<PersonalAdapterCapture> } {
  const records: RunRecord[] = [];
  const checkpoints: RunCheckpoint[] = [];
  let candidate: PersonalCandidate | null = null;
  let partialCandidate: PersonalCandidate | null = null;
  let attemptedCheckpoint: RunCheckpoint | null = null;
  let attemptedRecord: RunRecord | null = null;
  let attemptedRec: RecordingRef | null = null;
  const wrapped = new Proxy(bridge, {
    get(target, property) {
      if (property === "saveArtifact") {
        return async (_rec: Parameters<Bridge["saveArtifact"]>[0], _savedStepId: string, savedSource: boolean, markdown: string, record: RunRecord) => {
          if (savedSource !== source) throw new Error("R6 candidate kind mismatch");
          attemptedRec = _rec;
          attemptedRecord = structuredClone(record);
          candidate = {
            stepId,
            artifactId: location.artifactId ?? stepId,
            kind: source ? "source" : "artifact",
            versionId: location.versionId,
            path: location.path,
            text: markdown,
            provider,
            model: selectedModel,
            reportedModel: record.modelUsed ?? null,
          };
          return 1;
        };
      }
      if (property === "appendRun") return async (_rec: Parameters<Bridge["appendRun"]>[0], record: RunRecord) => {
        attemptedRec = _rec;
        attemptedRecord = structuredClone(record);
        await persistence.appendRun?.({ rec: _rec, record: structuredClone(record) });
        records.push(structuredClone(record));
      };
      if (property === "saveCheckpoint") return async (_rec: Parameters<Bridge["saveCheckpoint"]>[0], runId: string, checkpoint: RunCheckpoint) => {
        attemptedCheckpoint = structuredClone(checkpoint);
        await persistence.saveCheckpoint?.({ rec: _rec, runId, checkpoint: structuredClone(checkpoint) });
        checkpoints.push(structuredClone(checkpoint));
      };
      if (property === "transcribe" && beforeThisMacTranscribe) {
        return async (...args: Parameters<Bridge["transcribe"]>) => {
          await beforeThisMacTranscribe(args[2]);
          return target.transcribe(...args);
        };
      }
      if (property === "transcribeDeepgram" && beforeThisMacTranscribe) {
        return async (...args: Parameters<Bridge["transcribeDeepgram"]>) => {
          await beforeThisMacTranscribe(args[2].language);
          return target.transcribeDeepgram(...args);
        };
      }
      if (property === "transcribeAudioPart") {
        return async (...args: Parameters<Bridge["transcribeAudioPart"]>) => {
          try {
            return await target.transcribeAudioPart(...args);
          } catch (error) {
            if (isCommandError(error)) throw error;
            const message = error instanceof Error && error.message ? error.message : "送信後の結果を確認できません。";
            throw { code: "ResultUnknown", message };
          }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Bridge;
  return {
    bridge: wrapped,
    result: async (outcome) => {
      if (outcome.record) attemptedRecord = structuredClone(outcome.record);
      if (outcome.status === "saved" && attemptedRecord) {
        try {
          if (!attemptedRec) throw new Error("R6 recording ref missing");
          await persistence.appendRun?.({ rec: attemptedRec, record: structuredClone(attemptedRecord) });
          records.push(structuredClone(attemptedRecord));
        } catch (error) {
          const message = error instanceof Error && error.message ? error.message : "実行履歴を安全に保存できませんでした。";
          outcome = { status: "failed", record: attemptedRecord, message, reasonCode: "RetentionFailed" };
        }
      }
      if (outcome.status !== "saved") {
        const captured = candidate;
        candidate = null;
        const checkpoint = attemptedCheckpoint as RunCheckpoint | null;
        const text = captured?.text ?? (checkpoint ? `${checkpoint.output}${checkpoint.pending ?? ""}` : "");
        if (text) {
          const record = attemptedRecord as RunRecord | null;
          const partial: PersonalCandidate = captured ?? {
            stepId,
            artifactId: location.artifactId ?? stepId,
            kind: source ? "source" : "artifact",
            versionId: location.versionId,
            path: location.path,
            text,
            provider,
            model: selectedModel,
            reportedModel: record?.modelUsed ?? null,
          };
          try {
            await persistence.savePartialCandidate?.({ candidate: partial, outcome, checkpoint, record });
            partialCandidate = partial;
          } catch (error) {
            const message = error instanceof Error && error.message ? error.message : "途中結果を安全に保存できませんでした。";
            outcome = { status: "failed", record: outcome.record, message, reasonCode: "RetentionFailed" };
          }
        }
      }
      return { outcome, candidate, partialCandidate, records, checkpoints };
    },
  };
}

/**
 * 既存runStepを使うが、artifact/run/checkpointの書込みはR6候補として捕捉し、production Bridgeの現行版をCAS前に変更しない。
 */
export async function runPersonalGenerationStep(
  input: StepRunInput,
  fixedModel: ResolvedStepModel,
  readEntitlement: () => Promise<PersonalSubscriptionEntitlement>,
  location: CandidateLocation,
  persistence: PersonalAdapterPersistence = {},
): Promise<PersonalAdapterCapture> {
  const stepId = input.flow.steps[input.stepIndex]?.id ?? "unknown";
  const captured = captureBridge(input.bridge, location, stepId, fixedModel.provider, fixedModel.model, false, undefined, persistence);
  const capturedGuard = input.beforeDispatch;
  const outcome = await runStep({
    ...input,
    bridge: captured.bridge,
    fixedModel,
    beforeDispatch: async (model) => {
      await assertPersonalProviderReady({
        connection: input.settings.connection,
        model: fixedModel,
        entitlement: await readEntitlement(),
        providerStatus: (provider) => input.bridge.providerStatus(provider),
      });
      await capturedGuard?.(model);
    },
    strictCheckpointPersistence: true,
    actualModelMatches: (actualModel, requested) => personalReportedModelMatches(requested, actualModel),
    // 送っていないと確定している拒否（送信直前の guard・marker 無し）は、送信しなかった失敗にする（result_unknown にしない）
    dispatchError: (error) =>
      isPersonalNotSentRejection(error) && isCommandError(error)
        ? { reasonCode: "DispatchRejected", message: error.message }
        : {
            reasonCode: "ResultUnknown",
            message: "AIへ送信した後の結果を確認できません。自動では送り直さず、履歴を確認してください。",
          },
  });
  return await captured.result(outcome);
}

function unavailableSpeech(status: SpeechStatus): string | null {
  if (!status.found) return "このMacの音声認識が見つかりません。設定から準備してください。";
  if (status.fake) return "実機の音声認識を確認できません。実機の接続状態を確認してください。";
  if (!status.available || status.needsDownload) return status.notice ?? status.error ?? "このMacの音声認識をまだ利用できません。設定から取得してください。";
  if (status.error) return status.error;
  return null;
}

function failed(message: string, reasonCode: string): PersonalAdapterCapture {
  return { outcome: { status: "failed", record: null, message, reasonCode }, candidate: null, partialCandidate: null, records: [], checkpoints: [] };
}

/**
 * 既存runTranscriptionを使い、実際に送るGemini model/effort/connectionと同じ値だけをready判定する。
 * this-macもtranscribe直前にspeechStatusを取り直す。保存系は候補へ捕捉する。
 */
export async function runPersonalTranscription(
  input: TranscriptionInput,
  geminiModel: ResolvedStepModel | null,
  readEntitlement: () => Promise<PersonalSubscriptionEntitlement>,
  location: CandidateLocation,
  persistence: PersonalAdapterPersistence = {},
): Promise<PersonalAdapterCapture> {
  if (input.engine !== "gemini" && input.engine !== "this-mac" && input.engine !== "deepgram") {
    return failed("この文字起こし方式には対応していません。設定で対応する方式を選んでください。", "PersonalEngineUnsupported");
  }
  if (input.engine === "deepgram") {
    if (input.connection !== "apiKey" || geminiModel !== null) {
      return failed("固定したDeepgram文字起こしの接続方式が実際の送信内容と一致しません。", "FixedTranscriptionModelMismatch");
    }
    const captured = captureBridge(input.bridge, location, "source", "deepgram", DEEPGRAM_MODEL, true, async () => {
      if (input.isStopRequested?.()) throw { code: "speech_stopped", message: "文字起こしを取り消しました。" };
      await input.beforeAiDispatch?.();
      if (input.isStopRequested?.()) throw { code: "speech_stopped", message: "文字起こしを取り消しました。" };
    }, persistence);
    const outcome = await runTranscription({
      ...input,
      bridge: captured.bridge,
      strictCheckpointPersistence: true,
      actualModelMatches: (actualModel) => actualModel === DEEPGRAM_MODEL,
    });
    return await captured.result(outcome);
  }
  if (input.engine === "gemini") {
    if (
      !geminiModel ||
      geminiModel.provider !== "gemini" ||
      geminiModel.model !== GEMINI_TRANSCRIPTION_MODEL ||
      geminiModel.effort !== GEMINI_TRANSCRIPTION_EFFORT ||
      !["subscription", "apiKey"].includes(input.connection ?? "subscription")
    ) {
      return failed("固定したGemini文字起こしの接続・モデル・思考量が実際の送信内容と一致しません。", "FixedTranscriptionModelMismatch");
    }
    const captured = captureBridge(input.bridge, location, "source", "gemini", GEMINI_TRANSCRIPTION_MODEL, true, undefined, persistence);
    const capturedGuard = input.beforeAiDispatch;
    const outcome = await runTranscription({
      ...input,
      bridge: captured.bridge,
      beforeAiDispatch: async () => {
        await assertPersonalProviderReady({
          connection: input.connection ?? "subscription",
          model: geminiModel,
          entitlement: await readEntitlement(),
          providerStatus: (provider) => input.bridge.providerStatus(provider),
        });
        await capturedGuard?.();
      },
      strictCheckpointPersistence: true,
      noRetryTerminalTransientFailure: true,
      actualModelMatches: (actualModel) => personalReportedModelMatches(geminiModel, actualModel),
    });
    return await captured.result(outcome);
  }

  const captured = captureBridge(input.bridge, location, "source", "this-mac", "niho-speech", true, async (language) => {
    if (input.isStopRequested?.()) throw { code: "speech_stopped", message: "文字起こしを取り消しました。" };
    const status = await input.bridge.speechStatus(language);
    const reason = unavailableSpeech(status);
    if (reason) throw { code: "speech_unavailable", message: reason };
    if (input.isStopRequested?.()) throw { code: "speech_stopped", message: "文字起こしを取り消しました。" };
    await input.beforeAiDispatch?.();
    if (input.isStopRequested?.()) throw { code: "speech_stopped", message: "文字起こしを取り消しました。" };
  }, persistence);
  return await captured.result(await runTranscription({ ...input, bridge: captured.bridge, strictCheckpointPersistence: true }));
}
