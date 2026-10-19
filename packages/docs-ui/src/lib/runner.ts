import {
  CONTINUATION_INSTRUCTION,
  CONTINUATION_LIMIT_MESSAGE,
  CONTINUATION_NOT_JOINABLE_MESSAGE,
  MAX_CONTINUATIONS,
  SOURCE_STEP_ID,
  UNREGISTERED_IN_CONNECTION_MESSAGE,
  UNREGISTERED_PROVIDER_MESSAGE,
  audioTranscriptMarkdown,
  basisFor,
  buildAudioTranscriptionPartPrompt,
  buildAudioTranscriptionSystemPrompt,
  buildFreshContinuationPrompt,
  buildPrompt,
  contractEffort,
  contractProvider,
  continuationOverlap,
  countChars,
  deepgramKeyterms,
  deepgramTranscriptMarkdown,
  executionPlanFor,
  hashText,
  joinContinuation,
  projectTranscriptionTerms,
  parseAudioTranscriptParagraphs,
  reasonMessage,
  recordingInfo,
  requestEffort,
  resolveStepModel,
  snapshotModelFor,
  speechHints,
  transcriptMarkdown,
  transcriptionReferenceLines,
  usedRefs,
  type AudioTranscriptionContext,
  type AudioTranscriptPart,
  type AudioTranscriptParagraph,
  type Connection,
  type Effort,
  type FlowSnapshot,
  type Project,
  type PromptMaterials,
  type ProviderCapabilities,
  type ReasonCode,
  type Recording,
  type ResolvedStepModel,
  type RunCheckpoint,
  type RunRecord,
  type TranscriptionEngine,
  type TurnEvent,
} from "@niho/docs-core";
import {
  audioPartFileName,
  errorMessage,
  isCommandError,
  terminalEvent,
  type Bridge,
  type FileTranscript,
  type PreparedAudioFile,
  type RecordingRef,
  type SpeechEvent,
} from "./bridge";
import { finalizeMarkdown } from "./markdown";
import { activeProfiles, activeProviders, type AppSettings } from "./settings";

/**
 * 工程の実行（spec §5）: docs-core で入力とプロンプトを組み立て → `run_turn` → 逐次表示 →
 * `Done.stop_reason === "MaxTokens"` なら同じ会話で「続き」（最大 8 回）→ 版を足す → runs.jsonl。
 * Claude Code は上限で止まると同じ実行の中で自分で続きを頼み（最大 3 回。`Done.continuations`）、それでも上限で止まったときだけ
 * `MaxTokens` が届く。記録する続きの回数は、アプリが頼んだ回数と CLI が頼んだ回数の和（同じ続きを 2 回数えない）。
 * 実行ごとに checkpoint（runs/<runId>.json）を書き、停止・時間切れ・続きの上限・繋げられない続きのときは
 * 途中までの出力を版にせず checkpoint に残す（会話の欄に「途中まで」として出す）。
 */

export type RunProgress =
  /** `continuation` はここまでに頼んだ続きの回数（アプリと CLI の和）。 */
  | { kind: "turn"; turnId: string; continuation: number }
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "speech"; event: SpeechEvent }
  | { kind: "speech-text"; text: string };

export type StepRunOutcome =
  | { status: "saved"; version: number; record: RunRecord; text: string }
  | { status: "failed"; record: RunRecord | null; message: string; reasonCode: string | null }
  | { status: "stopped"; record: RunRecord };

export type StepRunInput = {
  bridge: Bridge;
  /** 版・記録・checkpoint を書く録音。 */
  rec: RecordingRef;
  flow: FlowSnapshot;
  stepIndex: number;
  materials: PromptMaterials;
  /** snapshot にモデルが無い工程（古い案件）だけ、設定から解決する。 */
  settings: AppSettings;
  /** CLI が同じ会話を続けられるか（provider_status の capabilities.resume）。 */
  capabilities: ProviderCapabilities;
  /** R6: 受付時に固定したモデル。指定時は `snapshotModelFor` で今の接続へ解決し直さない。 */
  fixedModel?: ResolvedStepModel;
  /** R6: 各外部送信の直前に、同じ固定モデルのログイン・対応モデル・契約・残量を fail closed で再検査する。 */
  beforeDispatch?: (model: ResolvedStepModel) => Promise<void>;
  /** R6: command が応答せず送信成否不明のときだけ、通常runnerの例外挙動を変えず終端記録へ写す。 */
  dispatchError?: (error: unknown) => { message: string; reasonCode: string };
  /** R6: checkpoint の耐久保存を外部送信と候補確定の必須条件にする。通常実行は従来どおり best effort。 */
  strictCheckpointPersistence?: boolean;
  /** R6: provider が明示した実モデルを固定モデルと照合する。未報告なら判定しない。 */
  actualModelMatches?: (actualModel: string, requested: ResolvedStepModel) => boolean;
  newId: (prefix: string) => string;
  now: () => Date;
  onProgress: (progress: RunProgress) => void;
  /** 止める指示が出たか（続きの間に確かめる）。 */
  isStopRequested: () => boolean;
  /** 複数案の実行先。開始時に固定し、画面の選択変更では変えない。 */
  candidate?: {
    id: string;
    artifactId: string;
    instruction?: string;
    inputVersions: Record<string, number>;
  };
};

type Final = Extract<TurnEvent, { type: "Done" } | { type: "Error" }>;

/** CLI に渡す思考量（思考量がモデル名で決まる Gemini のモデルは渡さない）。 */
function effortForRequest(provider: ResolvedStepModel["provider"], model: string, effort: Effort) {
  const requested = requestEffort(provider, model, effort);
  return requested ? contractEffort(requested) : null;
}
type TurnResult = { final: Final | null; text: string };

const STOPPED_MESSAGE = "止めました。途中までを残しています。";

async function runOneTurn(
  input: StepRunInput,
  request: Parameters<Bridge["runTurn"]>[1],
  continuation: number,
  shownBefore: string,
  onPartial: (partial: string) => void,
): Promise<TurnResult> {
  const turnId = input.newId("turn");
  input.onProgress({ kind: "turn", turnId, continuation });
  let final: Final | null = null;
  let partial = "";
  const completed = await input.bridge.runTurn(turnId, request, (envelope) => {
    const event = envelope.event;
    if (event.type === "ThinkingDelta") {
      input.onProgress({ kind: "thinking", text: event.text });
    } else if (event.type === "TextDelta") {
      partial += event.text;
      input.onProgress({ kind: "text", text: shownBefore + partial });
      onPartial(partial);
    } else if (event.type === "Done" || event.type === "Error") {
      // ToolUse・ToolResult は修正の会話だけに届く（工程の実行はツール無しで、crate がツールの気配を止める）
      final = event;
    }
  });
  return { final: terminalEvent(completed, final), text: partial };
}

function baseRecord(input: { newId: (prefix: string) => string; now: () => Date }, stepName: string, stepId: string): RunRecord {
  return {
    id: input.newId("run"),
    kind: "run",
    at: input.now().toISOString(),
    stepId,
    stepName,
    version: null,
    result: "failed",
  };
}

/**
 * 実行に使うモデル。snapshot の解決済みのモデルを今の方式で使う形にする（案件を作った方式と違えば、同じプロファイル × 提供元を
 * 今の方式の表で解決し直す＝docs-core `snapshotModelFor`。提供元が今の方式に登録されているかは runStep が確かめて止める）。
 * snapshot に無ければ（古い案件）今の設定から解決する（登録していない AI を指す工程は先頭へ寄せる）。
 */
export function stepModel(flow: FlowSnapshot, stepId: string, settings: AppSettings): ResolvedStepModel | null {
  const fromSnapshot = flow.models?.[stepId];
  if (fromSnapshot) return snapshotModelFor(fromSnapshot, settings.connection, activeProfiles(settings));
  const step = flow.steps.find((candidate) => candidate.id === stepId);
  const resolved = step ? resolveStepModel(step, activeProfiles(settings), activeProviders(settings)) : null;
  if (!resolved) return null;
  return {
    provider: resolved.provider,
    model: resolved.model.model,
    effort: resolved.model.effort,
    profileId: resolved.profile.id,
    profileName: resolved.profile.name,
    ...(resolved.redirected ? { redirected: true } : {}),
    connection: settings.connection,
  };
}

export async function runStep(input: StepRunInput): Promise<StepRunOutcome> {
  const step = input.flow.steps[input.stepIndex];
  if (!step) return { status: "failed", record: null, message: "工程が見つかりません。", reasonCode: null };
  const snapshotModel = input.flow.models?.[step.id];
  if (
    input.fixedModel &&
    (!snapshotModel ||
      input.fixedModel.provider !== snapshotModel.provider ||
      input.fixedModel.model !== snapshotModel.model ||
      input.fixedModel.effort !== snapshotModel.effort ||
      input.fixedModel.profileId !== snapshotModel.profileId)
  ) {
    return {
      status: "failed",
      record: null,
      message: "受付時に固定した AI モデルが変わりました。設定を確かめて、もう一度開始してください。",
      reasonCode: "FixedSnapshotChanged",
    };
  }
  const model = input.fixedModel ?? stepModel(input.flow, step.id, input.settings);
  if (!model) {
    return { status: "failed", record: null, message: "この工程のモデルが設定にありません。設定のモデルを確かめてください。", reasonCode: null };
  }
  // 案件の作成後に、その AI の登録を外した・方式を切り替えた先にその AI が無い（勝手に別の AI・別の方式で実行しない。
  // 「この案件の工程を今の設計に更新」か、今の方式でその AI を登録して直す）
  const connection = input.settings.connection;
  if (!activeProviders(input.settings).includes(model.provider)) {
    const crossed = (input.flow.models?.[step.id]?.connection ?? "subscription") !== connection;
    return {
      status: "failed",
      record: null,
      message: crossed ? UNREGISTERED_IN_CONNECTION_MESSAGE : UNREGISTERED_PROVIDER_MESSAGE,
      reasonCode: "ProviderNotRegistered",
    };
  }
  const materials = input.candidate?.instruction
    ? { ...input.materials, candidateInstruction: input.candidate.instruction }
    : input.materials;
  const built = buildPrompt(input.flow, input.stepIndex, materials);
  if (built.missing.length > 0) {
    const names = built.missing.map((item) => ("name" in item ? item.name : "")).filter(Boolean).join("・");
    return { status: "failed", record: null, message: `${names}がまだ無いので実行できません。`, reasonCode: null };
  }
  const basis = basisFor(input.flow, input.stepIndex, materials);
  const record = baseRecord(input, step.name, step.id);
  if (input.candidate) {
    record.candidateId = input.candidate.id;
    record.artifactId = input.candidate.artifactId;
    record.inputVersions = { ...input.candidate.inputVersions };
  }
  // 入力に入れた参考ページ（送った本文の字数。参考の無い実行は持たない）
  const refs = usedRefs(input.materials.refs).map((ref) => ({ pageId: ref.pageId, chars: countChars(ref.body.trim()) }));
  Object.assign(record, {
    provider: model.provider,
    connection,
    model: model.model,
    effort: model.effort,
    profile: model.profileName,
    inputChars: built.chars,
    ...(refs.length > 0 ? { refs } : {}),
    basis,
  });
  const runId = record.id;
  const checkpoint: RunCheckpoint = {
    schemaVersion: 1,
    runId,
    stepId: step.id,
    stepName: step.name,
    ...(input.candidate ? { candidateId: input.candidate.id, artifactId: input.candidate.artifactId } : {}),
    startedAt: record.at,
    updatedAt: record.at,
    plan: executionPlanFor(),
    fingerprint: { basis, prompt: hashText(`${built.systemPrompt}\n${built.userPrompt}`) },
    provider: model.provider,
    model: model.model,
    effort: model.effort,
    sessionRef: null,
    continuations: 0,
    output: "",
    pending: null,
    state: "running",
    endReason: null,
  };
  let checkpointFailure: unknown = null;
  let checkpointWrites: Promise<void> = Promise.resolve();
  let checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  const enqueueCheckpoint = (snapshot: RunCheckpoint) => {
    checkpointWrites = checkpointWrites.then(async () => {
      if (input.strictCheckpointPersistence && checkpointFailure) return;
      try {
        await input.bridge.saveCheckpoint(input.rec, runId, snapshot);
      } catch (error) {
        if (input.strictCheckpointPersistence) checkpointFailure ??= error;
      }
    });
    return checkpointWrites;
  };
  const assertCheckpointDurable = async () => {
    await checkpointWrites;
    if (input.strictCheckpointPersistence && checkpointFailure) throw checkpointFailure;
  };
  const writeCheckpoint = async (fields: Partial<RunCheckpoint>) => {
    if (checkpointTimer !== null) clearTimeout(checkpointTimer);
    checkpointTimer = null;
    Object.assign(checkpoint, fields, { updatedAt: input.now().toISOString() });
    const snapshot = { ...checkpoint };
    await enqueueCheckpoint(snapshot);
    await assertCheckpointDurable();
  };
  let scheduledCheckpoint: Pick<RunCheckpoint, "output" | "pending"> = { output: "", pending: null };
  const scheduleCheckpoint = (output: string, pending: string) => {
    scheduledCheckpoint = { output, pending: pending || null };
    if (checkpointTimer === null) {
      checkpointTimer = setTimeout(() => {
        checkpointTimer = null;
        const latest = scheduledCheckpoint;
        Object.assign(checkpoint, latest, { updatedAt: input.now().toISOString() });
        const snapshot = { ...checkpoint };
        void enqueueCheckpoint(snapshot);
      }, 1000);
    }
  };
  try {
    await writeCheckpoint({});
  } catch (error) {
    return {
      status: "failed",
      record: null,
      message: errorMessage(error, "途中結果の保存先を確認できないため、AIへ送信しませんでした。"),
      reasonCode: "RetentionFailed",
    };
  }

  const started = Date.now();
  let text = "";
  /** アプリが頼んだ続きの回数（上限 MAX_CONTINUATIONS はこれで数える）。 */
  let requests = 0;
  /** 記録する続きの回数（アプリが頼んだ回数 ＋ CLI が同じ実行の中で頼んだ回数）。 */
  let continuations = 0;
  let sessionId: string | null = null;
  let resume = input.capabilities.resume;
  let inputTokens = 0;
  let outputTokens = 0;
  let tokensKnown = true;
  let modelUsed: string | null = null;
  const finish = (fields: Partial<RunRecord>): RunRecord =>
    Object.assign(record, {
      durationMs: Date.now() - started,
      inputTokens,
      outputTokens,
      tokensKnown,
      costUsd: null,
      costKnown: false,
      continuations,
      modelUsed,
      ...fields,
    });
  const retentionFailed = async (partial: string, error: unknown, append = true): Promise<StepRunOutcome> => {
    const message = errorMessage(error, "途中結果を安全に保存できなかったため、実行を止めました。");
    const done = finish({ result: "failed", message, reasonCode: "RetentionFailed", outputChars: 0, partialChars: countChars(partial) });
    if (append) await input.bridge.appendRun(input.rec, done).catch(() => undefined);
    return { status: "failed", record: done, message, reasonCode: "RetentionFailed" };
  };
  /** 版にせずに終える（途中までの出力は checkpoint に残し、記録に字数を添える）。 */
  const endWithoutVersion = async (
    result: "failed" | "stopped",
    message: string,
    reasonCode: string | null,
    partial: string,
    pending: string | null = null,
  ): Promise<StepRunOutcome> => {
    try {
      await writeCheckpoint({
        output: partial,
        pending,
        state: result,
        endReason: reasonCode ?? "Stopped",
        continuations,
        sessionRef: sessionId,
      });
    } catch (error) {
      return await retentionFailed(partial + (pending ?? ""), error);
    }
    const done = finish({ result, message, outputChars: 0, partialChars: countChars(partial), ...(reasonCode ? { reasonCode } : {}) });
    try {
      await input.bridge.appendRun(input.rec, done);
    } catch (error) {
      return await retentionFailed(partial + (pending ?? ""), error, false);
    }
    return result === "stopped"
      ? { status: "stopped", record: done }
      : { status: "failed", record: done, message, reasonCode };
  };

  for (;;) {
    if (requests > 0 && input.isStopRequested()) {
      return endWithoutVersion("stopped", STOPPED_MESSAGE, null, text);
    }
    const userPrompt =
      requests === 0 ? built.userPrompt : resume ? CONTINUATION_INSTRUCTION : buildFreshContinuationPrompt(built.userPrompt, text);
    try {
      await assertCheckpointDurable();
    } catch (error) {
      return await retentionFailed(text, error);
    }
    if (input.beforeDispatch && input.isStopRequested()) return endWithoutVersion("stopped", STOPPED_MESSAGE, null, text);
    try {
      await input.beforeDispatch?.(model);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : errorMessage(error, "AIの接続状態を確認できませんでした。");
      const reasonCode = isCommandError(error) ? error.code : "DispatchGuardRejected";
      return endWithoutVersion("failed", message, reasonCode, text);
    }
    if (input.beforeDispatch && input.isStopRequested()) return endWithoutVersion("stopped", STOPPED_MESSAGE, null, text);
    let turn: TurnResult;
    try {
      turn = await runOneTurn(
        input,
        {
          provider: contractProvider(model.provider, connection),
          model: model.model,
          effort: effortForRequest(model.provider, model.model, model.effort),
          system_prompt: built.systemPrompt,
          user_prompt: userPrompt,
          resume_session: requests > 0 && resume ? sessionId : null,
          workspace: runId,
          max_budget_usd: null,
        },
        continuations,
        text,
        (pending) => scheduleCheckpoint(text, pending),
      );
    } catch (error) {
      if (!input.dispatchError) throw error;
      const classified = input.dispatchError(error);
      return endWithoutVersion("failed", classified.message, classified.reasonCode, text);
    }
    const final = turn.final as Final | null;
    // 途中までの出力（今の会話の差分は、まだ繋いでいないので後ろに足すだけ）
    const partialSoFar = text + turn.text;
    if (!final) {
      return endWithoutVersion("failed", reasonMessage("TransientFailure", model.provider, connection), "TransientFailure", partialSoFar);
    }
    if (final.type === "Error") {
      // 続きの会話が見つからないときは、ここまでの出力を添えて新しい実行で続ける（spec §5.4）
      if (requests > 0 && resume && final.reason_code === "SessionNotFound") {
        resume = false;
        continue;
      }
      tokensKnown = false;
      return endWithoutVersion(
        "failed",
        final.message || reasonMessage(final.reason_code as ReasonCode, model.provider, connection),
        final.reason_code,
        partialSoFar,
      );
    }
    // CLI が同じ実行の中で頼んだ続き（止めた実行の分も）。アプリが頼んだ続きとは別に数える
    continuations += final.continuations;
    inputTokens += final.usage.input_tokens;
    outputTokens += final.usage.output_tokens;
    if (final.usage.input_tokens === 0 && final.usage.output_tokens === 0) tokensKnown = false;
    modelUsed = final.usage.model_used ?? modelUsed;
    const piece = final.text || turn.text;
    if (final.usage.model_used && input.actualModelMatches && !input.actualModelMatches(final.usage.model_used, model)) {
      return endWithoutVersion(
        "failed",
        "実際に使われたAIモデルが受付時に固定したモデルと一致しません。出力は候補として残しました。",
        "ActualModelMismatch",
        text + piece,
      );
    }
    if (final.stop_reason === "Stopped") {
      tokensKnown = false;
      return endWithoutVersion("stopped", STOPPED_MESSAGE, null, text + piece);
    }
    if (requests === 0 && text === "") {
      text = piece;
    } else if (!resume && continuationOverlap(text, piece) === 0) {
      // 新しい実行で頼んだ続きが前の出力に重ならない（言い換えた）ときは自動で結合しない
      return endWithoutVersion("failed", CONTINUATION_NOT_JOINABLE_MESSAGE, "NotJoinable", text, piece);
    } else {
      text = joinContinuation(text, piece);
    }
    input.onProgress({ kind: "text", text });
    try {
      await writeCheckpoint({ output: text, pending: null, continuations, sessionRef: sessionId });
    } catch (error) {
      return await retentionFailed(text, error);
    }
    if (final.stop_reason === "MaxTokens") {
      if (requests >= MAX_CONTINUATIONS) {
        return endWithoutVersion("failed", CONTINUATION_LIMIT_MESSAGE, "ContinuationLimit", text);
      }
      requests++;
      continuations++;
      sessionId = final.session_id;
      if (!sessionId) resume = false;
      try {
        await writeCheckpoint({ output: text, continuations, sessionRef: sessionId });
      } catch (error) {
        return await retentionFailed(text, error);
      }
      continue;
    }
    break;
  }

  const markdown = finalizeMarkdown(text);
  if (!markdown) {
    return endWithoutVersion("failed", "AIの出力が空でした。もう一度実行してください。", "EmptyOutput", "");
  }
  const saved = finish({ result: "saved", outputChars: countChars(markdown) });
  try {
    await assertCheckpointDurable();
    await writeCheckpoint({ output: markdown, pending: null, state: "running", endReason: null, continuations, sessionRef: sessionId });
    const version = await input.bridge.saveArtifact(input.rec, input.candidate?.artifactId ?? step.id, false, markdown, saved);
    saved.version = version;
    await writeCheckpoint({ output: markdown, state: "completed", endReason: "EndTurn", continuations, sessionRef: sessionId });
    return { status: "saved", version, record: saved, text: markdown };
  } catch (error) {
    if (input.strictCheckpointPersistence && checkpointFailure) return await retentionFailed(markdown, error);
    try {
      await writeCheckpoint({ output: markdown, pending: null, state: "failed", endReason: "save_failed", continuations, sessionRef: sessionId });
    } catch (retentionError) {
      return await retentionFailed(markdown, retentionError);
    }
    return { status: "failed", record: null, message: errorMessage(error, "保存できませんでした。"), reasonCode: null };
  }
}

export type TranscriptionInput = {
  bridge: Bridge;
  /** 版・記録・checkpoint を書く録音（音声もこの録音の inputs/）。 */
  rec: RecordingRef;
  /** 案件（固有名詞・案件名は案件のもの）。 */
  project: Project;
  /** 録音（素材・話者人数・言語は録音のもの）。 */
  recording: Recording;
  flow: FlowSnapshot;
  jobId: string;
  /** 文字起こしのエンジン（設定の `effectiveEngine`、別案はその案のエンジン。省くと この Mac）。 */
  engine?: TranscriptionEngine;
  /** 文字起こしの別案（#19108）。版・記録・checkpoint をこの案に書く（省くと最初の案＝transcript.md）。 */
  candidate?: { id: string; artifactId: string };
  /** 今の方式（Gemini はサブスクリプションなら Antigravity CLI、API キー方式なら Gemini API。省くとサブスクリプション）。 */
  connection?: Connection;
  newId: (prefix: string) => string;
  now: () => Date;
  onProgress: (progress: RunProgress) => void;
  /** 止める指示が出たか（Gemini の区切りの間に確かめる）。 */
  isStopRequested?: () => boolean;
  /** R6: Gemini の各音声区切りを送る直前に固定接続の readiness を再検査する。 */
  beforeAiDispatch?: () => Promise<void>;
  /** R6: checkpoint の耐久保存を外部送信と候補確定の必須条件にする。 */
  strictCheckpointPersistence?: boolean;
  /** R6: 送信済みの終端 TransientFailure を自動再送せず ResultUnknown にする。 */
  noRetryTerminalTransientFailure?: boolean;
  /** R6: provider が明示した実モデルを固定モデルと照合する。未報告なら判定しない。 */
  actualModelMatches?: (actualModel: string) => boolean;
};

/** Gemini（Antigravity CLI）の文字起こしのモデル。NIHO 本体の Gemini の文字起こしと同じ 3.8 Flash を思考量 低で（S0 #18381）。 */
export const GEMINI_TRANSCRIPTION_MODEL = "gemini-3.8-flash";
export const GEMINI_TRANSCRIPTION_EFFORT: Effort = "low";
/** 区切り 1 つのやり直しの上限。 */
const AUDIO_PART_ATTEMPTS = 3;
/** 無音以外の時間に対する最低限の本文量。NIHO 本体の Gemini の短文判定と同じ 60 秒・50 字。 */
const AUDIO_PART_SHORT_OUTPUT_SOUND_SEC = 60;
const AUDIO_PART_SHORT_OUTPUT_CHARS = 50;

function isAudioPartTooShort(
  text: string,
  soundSec: number,
  speakers: AudioTranscriptionContext["speakers"],
  language: AudioTranscriptionContext["language"],
  referenceLines: readonly string[],
): boolean {
  const chars = parseAudioTranscriptParagraphs({ text, speakers, language, referenceLines })
    .reduce((total, paragraph) => total + countChars(paragraph.text), 0);
  return (soundSec > 5 && chars === 0) || (soundSec > AUDIO_PART_SHORT_OUTPUT_SOUND_SEC && chars < AUDIO_PART_SHORT_OUTPUT_CHARS);
}

/** 文字起こしの checkpoint（runs/<runId>.json）。途中までの Markdown を 1 秒ごと・区切りごとに書く。 */
function transcriptionCheckpoint(input: TranscriptionInput, record: RunRecord, provider: RunCheckpoint["provider"], model: string, effort: Effort | null) {
  const checkpoint: RunCheckpoint = {
    schemaVersion: 1,
    runId: record.id,
    stepId: SOURCE_STEP_ID,
    stepName: "文字起こし",
    ...(input.candidate ? { candidateId: input.candidate.id, artifactId: input.candidate.artifactId } : {}),
    startedAt: record.at,
    updatedAt: record.at,
    plan: executionPlanFor(),
    fingerprint: null,
    provider,
    model,
    effort,
    sessionRef: null,
    continuations: 0,
    output: "",
    pending: null,
    state: "running",
    endReason: null,
  };
  let writes: Promise<void> = Promise.resolve();
  let failure: unknown = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduled = "";
  const queue = (output: string, state: RunCheckpoint["state"], endReason: string | null) => {
    Object.assign(checkpoint, { output, pending: null, state, endReason, updatedAt: input.now().toISOString() });
    const snapshot = { ...checkpoint };
    writes = writes.then(async () => {
      if (input.strictCheckpointPersistence && failure) return;
      try {
        await input.bridge.saveCheckpoint(input.rec, record.id, snapshot);
      } catch (error) {
        if (input.strictCheckpointPersistence) failure ??= error;
      }
    });
    return writes;
  };
  const assertDurable = async () => {
    await writes;
    if (input.strictCheckpointPersistence && failure) throw failure;
  };
  return {
    schedule(output: string) {
      scheduled = output;
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          void queue(scheduled, "running", null);
        }, 1000);
      }
    },
    write(output: string, state: RunCheckpoint["state"], endReason: string | null) {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      return queue(output, state, endReason).then(assertDurable);
    },
    assertDurable,
  };
}

async function transcriptionRetentionFailed(
  input: TranscriptionInput,
  record: RunRecord,
  started: number,
  partial: string,
  error: unknown,
  append = true,
): Promise<StepRunOutcome> {
  const message = errorMessage(error, "途中結果を安全に保存できなかったため、文字起こしを止めました。");
  const failed = Object.assign(record, {
    durationMs: Date.now() - started,
    result: "failed",
    reasonCode: "RetentionFailed",
    message,
    partialChars: countChars(partial),
  } satisfies Partial<RunRecord>);
  if (append) await input.bridge.appendRun(input.rec, failed).catch(() => undefined);
  return { status: "failed", record: failed, message, reasonCode: "RetentionFailed" };
}

/** 版にせずに終える（途中までの出力は checkpoint に残し、記録に字数を添える）。 */
async function endTranscription(
  input: TranscriptionInput,
  record: RunRecord,
  checkpoint: ReturnType<typeof transcriptionCheckpoint>,
  started: number,
  result: "failed" | "stopped",
  reasonCode: string,
  message: string,
  partial: string,
): Promise<StepRunOutcome> {
  try {
    await checkpoint.write(partial, result, reasonCode);
  } catch (error) {
    return await transcriptionRetentionFailed(input, record, started, partial, error);
  }
  const done = Object.assign(record, {
    durationMs: Date.now() - started,
    result,
    reasonCode,
    message,
    partialChars: countChars(partial),
  } satisfies Partial<RunRecord>);
  try {
    await input.bridge.appendRun(input.rec, done);
  } catch (error) {
    return await transcriptionRetentionFailed(input, record, started, partial, error, false);
  }
  return result === "stopped" ? { status: "stopped", record: done } : { status: "failed", record: done, message, reasonCode };
}

/** 文字起こしの Markdown を版にする（空なら失敗）。 */
async function saveTranscript(
  input: TranscriptionInput,
  record: RunRecord,
  checkpoint: ReturnType<typeof transcriptionCheckpoint>,
  started: number,
  markdown: string,
  partial: string,
): Promise<StepRunOutcome> {
  record.durationMs = Date.now() - started;
  if (!markdown.trim()) {
    const message = "文字起こしの結果が空でした。音声を確かめて、もう一度実行してください。";
    const failed = Object.assign(record, { result: "failed", reasonCode: "EmptyTranscript", message } satisfies Partial<RunRecord>);
    await checkpoint.write(partial, "failed", "EmptyTranscript");
    await input.bridge.appendRun(input.rec, failed);
    return { status: "failed", record: failed, message, reasonCode: "EmptyTranscript" };
  }
  const saved = Object.assign(record, { result: "saved", outputChars: countChars(markdown) } satisfies Partial<RunRecord>);
  try {
    await checkpoint.assertDurable();
    const version = await input.bridge.saveArtifact(input.rec, input.candidate?.artifactId ?? SOURCE_STEP_ID, true, markdown, saved);
    saved.version = version;
    await checkpoint.write(markdown, "completed", "EndTurn");
    return { status: "saved", version, record: saved, text: markdown };
  } catch (error) {
    try {
      await checkpoint.write(markdown, "failed", "save_failed");
    } catch (retentionError) {
      return await transcriptionRetentionFailed(input, record, started, partial || markdown, retentionError);
    }
    return { status: "failed", record: null, message: errorMessage(error, "保存できませんでした。"), reasonCode: null };
  }
}

/**
 * 工程 1（文字起こし）: 設定のエンジンで録音の音声の写しを順に文字起こしし、`[hh:mm:ss] 本文` の Markdown を版として保存する。
 * この Mac は niho-speech、Gemini は Antigravity CLI（区切りの WAV を読ませる）。どちらも途中までを checkpoint に書く。
 */
/** 文字起こしの実行の記録（別案はその案の id と置き場を添える）。 */
function transcriptionRecord(input: TranscriptionInput): RunRecord {
  const record = baseRecord(input, "文字起こし", SOURCE_STEP_ID);
  if (input.candidate) {
    record.candidateId = input.candidate.id;
    record.artifactId = input.candidate.artifactId;
  }
  return record;
}

export async function runTranscription(input: TranscriptionInput): Promise<StepRunOutcome> {
  if (input.recording.source.kind !== "audio" || input.recording.source.audio.length === 0) {
    return { status: "failed", record: null, message: "音声がありません。録音のページで音声を足してください。", reasonCode: null };
  }
  if (input.engine === "gemini") return runGeminiTranscription(input);
  if (input.engine === "deepgram") return runDeepgramTranscription(input);
  return runThisMacTranscription(input);
}

async function runThisMacTranscription(input: TranscriptionInput): Promise<StepRunOutcome> {
  const record = transcriptionRecord(input);
  record.provider = "this-mac";
  record.connection = input.connection ?? "subscription";
  const started = Date.now();
  const hints = speechHints(projectTranscriptionTerms(input.project.info, input.flow.terms));
  const audio = input.recording.source.kind === "audio" ? input.recording.source.audio : [];
  const observedEnds = audio.map(() => 0);
  const segments: Array<{ file: number; start: number; end: number; text: string; speaker?: number | null }> = [];
  const offsetForFile = (file: number) =>
    audio.slice(0, file).reduce((offset, item, index) => {
      const known = item.durationSec;
      return offset + (known !== null && Number.isFinite(known) && known > 0 ? known : (observedEnds[index] ?? 0));
    }, 0);
  const partial = () =>
    transcriptMarkdown(
      audio.map((item, file) => ({
        jsonl: segments
          .filter((segment) => segment.file === file)
          .map((segment) => JSON.stringify({ type: "segment", start: segment.start, end: segment.end, text: segment.text, speaker: segment.speaker }))
          .join("\n"),
        offsetSec: offsetForFile(file),
        name: item.name,
      })),
    ).trimEnd();
  const checkpoint = transcriptionCheckpoint(input, record, "this-mac", "niho-speech", null);
  try {
    await checkpoint.write("", "running", null);
  } catch (error) {
    return await transcriptionRetentionFailed(input, record, started, "", error);
  }
  let transcripts: FileTranscript[];
  try {
    transcripts = await input.bridge.transcribe(
      input.jobId,
      input.rec,
      input.recording.language,
      input.recording.speakers,
      hints,
      (event) => {
        input.onProgress({ kind: "speech", event });
        if (event.type === "Segment") {
          const text = event.text.replace(/\s+/g, " ").trim();
          if (event.file >= 0 && event.file < audio.length) {
            observedEnds[event.file] = Math.max(observedEnds[event.file] ?? 0, event.end);
            if (text) segments.push({ file: event.file, start: event.start, end: event.end, text, speaker: event.speaker });
          }
          const output = partial();
          input.onProgress({ kind: "speech-text", text: output });
          checkpoint.schedule(output);
        }
      },
    );
  } catch (error) {
    const stopped = isCommandError(error) && error.code === "speech_stopped";
    const message = stopped ? STOPPED_MESSAGE : errorMessage(error, "文字起こしが途中で止まりました。もう一度実行してください。");
    return endTranscription(
      input,
      record,
      checkpoint,
      started,
      stopped ? "stopped" : "failed",
      isCommandError(error) ? error.code : "speech_failed",
      message,
      partial(),
    );
  }
  let offset = 0;
  const parts = transcripts.map((transcript, index) => {
    const part = { jsonl: transcript.jsonl, offsetSec: offset, name: audio[index]?.name };
    offset += transcript.durationSec;
    return part;
  });
  record.audioSec = offset;
  return saveTranscript(input, record, checkpoint, started, transcriptMarkdown(parts), partial());
}

type AudioPartTurn = { final: Final | null; text: string };

/** 区切り 1 つを Gemini に読ませる（Antigravity CLI は view_file で、Gemini API は Files API に上げて添える。1 往復）。 */
async function runAudioPart(
  input: TranscriptionInput,
  file: number,
  part: number,
  systemPrompt: string,
  userPrompt: string,
): Promise<AudioPartTurn> {
  if (input.beforeAiDispatch && input.isStopRequested?.()) throw { code: "Stopped", message: STOPPED_MESSAGE };
  await input.beforeAiDispatch?.();
  if (input.beforeAiDispatch && input.isStopRequested?.()) throw { code: "Stopped", message: STOPPED_MESSAGE };
  const turnId = input.newId("turn");
  input.onProgress({ kind: "turn", turnId, continuation: 0 });
  let final: Final | null = null;
  let text = "";
  const completed = await input.bridge.transcribeAudioPart(
    turnId,
    input.jobId,
    file,
    part,
    {
      provider: contractProvider("gemini", input.connection ?? "subscription"),
      model: GEMINI_TRANSCRIPTION_MODEL,
      effort: effortForRequest("gemini", GEMINI_TRANSCRIPTION_MODEL, GEMINI_TRANSCRIPTION_EFFORT),
      system_prompt: systemPrompt,
      user_prompt: userPrompt,
    },
    (envelope) => {
      const event = envelope.event;
      if (event.type === "ThinkingDelta") input.onProgress({ kind: "thinking", text: event.text });
      else if (event.type === "TextDelta") text += event.text;
      else if (event.type === "Done" || event.type === "Error") final = event;
    },
  );
  return { final: terminalEvent(completed, final), text };
}

/**
 * Gemini（Antigravity CLI）の文字起こし（spec §5.5）: `prepare_audio`（変換 → 区切り）→ 区切りごとに `transcribe_audio_part`
 * （指示は docs-core の audio-transcription。直前の区切りの末尾を参照行に渡す）→ 区切りの開始秒を足して長さで丸めた時刻で
 * 1 本の Markdown → `release_audio`。終わった区切りまでの Markdown は区切りごとに checkpoint に書く（失敗・停止でも失わない）。
 * 音声を読めなかった区切り、または出力が途中で止まった／有音時間に比べ短すぎる区切りは 3 回まで頼み直す。
 * それでも疑わしいときは版にせず、完了済みの区切りだけ checkpoint に残す。
 */
async function runGeminiTranscription(input: TranscriptionInput): Promise<StepRunOutcome> {
  const connection = input.connection ?? "subscription";
  const record = transcriptionRecord(input);
  Object.assign(record, { provider: "gemini", connection, model: GEMINI_TRANSCRIPTION_MODEL, effort: GEMINI_TRANSCRIPTION_EFFORT });
  const started = Date.now();
  // 話者人数・言語は録音の値、固有名詞は案件の値
  const info = recordingInfo(input.project, input.recording);
  const checkpoint = transcriptionCheckpoint(input, record, "gemini", GEMINI_TRANSCRIPTION_MODEL, GEMINI_TRANSCRIPTION_EFFORT);
  try {
    await checkpoint.write("", "running", null);
  } catch (error) {
    return await transcriptionRetentionFailed(input, record, started, "", error);
  }
  const systemPrompt = buildAudioTranscriptionSystemPrompt({
    title: input.project.name,
    language: info.language,
    speakers: info.speakers,
    terms: projectTranscriptionTerms(info, input.flow.terms),
  });
  const done: AudioTranscriptPart[] = [];
  const paragraphs: AudioTranscriptParagraph[] = [];
  let output = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let tokensKnown = true;
  let modelUsed: string | null = null;
  const usageFields = () => ({ inputTokens, outputTokens, tokensKnown, modelUsed, costUsd: null, costKnown: false, continuations: 0 });
  let prepared: PreparedAudioFile[];
  try {
    prepared = await input.bridge.prepareAudio(input.jobId, input.rec, (event) => input.onProgress({ kind: "speech", event }));
  } catch (error) {
    await input.bridge.releaseAudio(input.jobId).catch(() => undefined);
    const stopped = isCommandError(error) && error.code === "speech_stopped";
    Object.assign(record, usageFields(), { tokensKnown: false });
    return endTranscription(
      input,
      record,
      checkpoint,
      started,
      stopped ? "stopped" : "failed",
      isCommandError(error) ? error.code : "speech_failed",
      stopped ? STOPPED_MESSAGE : errorMessage(error, "音声を準備できませんでした。もう一度実行してください。"),
      "",
    );
  }
  try {
    const parts: Array<{ file: number; part: number; startSec: number; endSec: number; soundSec: number }> = [];
    let offset = 0;
    prepared.forEach((file, fileIndex) => {
      file.parts.forEach((part, partIndex) => {
        parts.push({ file: fileIndex, part: partIndex, startSec: offset + part.startSec, endSec: offset + part.endSec, soundSec: part.soundSec });
      });
      offset += file.durationSec;
    });
    record.audioSec = offset;
    for (let index = 0; index < parts.length; index++) {
      const target = parts[index]!;
      const stop = () => {
        Object.assign(record, usageFields(), { tokensKnown: false });
        return endTranscription(input, record, checkpoint, started, "stopped", "Stopped", STOPPED_MESSAGE, output);
      };
      if (input.isStopRequested?.()) return await stop();
      input.onProgress({
        kind: "speech",
        event: {
          type: "Stage",
          stage: "transcribe",
          file: target.file,
          files: prepared.length,
          part: target.part,
          parts: prepared[target.file]?.parts.length ?? 1,
        },
      });
      const referenceLines = transcriptionReferenceLines(paragraphs);
      const userPrompt = buildAudioTranscriptionPartPrompt({
        index,
        count: parts.length,
        speakers: info.speakers,
        // Antigravity CLI は作業フォルダのファイルを読ませ、Gemini API は依頼に添える（「添付の音声を…」）
        fileName: connection === "apiKey" ? null : audioPartFileName(target.file, target.part),
        referenceLines,
      });
      let text: string | null = null;
      for (let attempt = 1; attempt <= AUDIO_PART_ATTEMPTS && text === null; attempt++) {
        let turn: AudioPartTurn;
        try {
          await checkpoint.assertDurable();
          turn = await runAudioPart(input, target.file, target.part, systemPrompt, userPrompt);
        } catch (error) {
          // 区切りを切れない・準備した音声が無いなどで command 自体が拒否された（TurnEvent::Error は来ない）。頼み直しても
          // 同じなので、ここで失敗として記録して終える（checkpoint を running のまま残さない）
          if (input.isStopRequested?.()) return await stop();
          if (input.strictCheckpointPersistence) {
            try {
              await checkpoint.assertDurable();
            } catch (retentionError) {
              return await transcriptionRetentionFailed(input, record, started, output, retentionError);
            }
          }
          Object.assign(record, usageFields(), { tokensKnown: false });
          return await endTranscription(
            input,
            record,
            checkpoint,
            started,
            "failed",
            isCommandError(error) ? error.code : "speech_failed",
            errorMessage(error, "音声の区切りを読めませんでした。もう一度実行してください。"),
            output,
          );
        }
        const final = turn.final as Final | null;
        const provisionalOutput = turn.text
          ? audioTranscriptMarkdown(
              [...done, { text: turn.text, startSec: target.startSec, endSec: target.endSec, referenceLines }],
              info.speakers,
              info.language,
            )
          : output;
        if (final?.type === "Done") {
          inputTokens += final.usage.input_tokens;
          outputTokens += final.usage.output_tokens;
          if (final.usage.input_tokens === 0 && final.usage.output_tokens === 0) tokensKnown = false;
          modelUsed = final.usage.model_used ?? modelUsed;
          if (final.stop_reason === "Stopped") return await stop();
          const candidate = final.text || turn.text;
          const candidateOutput = candidate
            ? audioTranscriptMarkdown(
                [...done, { text: candidate, startSec: target.startSec, endSec: target.endSec, referenceLines }],
                info.speakers,
                info.language,
              )
            : output;
          if (final.usage.model_used && input.actualModelMatches && !input.actualModelMatches(final.usage.model_used)) {
            Object.assign(record, usageFields());
            return await endTranscription(
              input,
              record,
              checkpoint,
              started,
              "failed",
              "ActualModelMismatch",
              "実際に使われたAIモデルが受付時に固定したモデルと一致しません。出力は候補として残しました。",
              candidateOutput,
            );
          }
          const incomplete = final.stop_reason === "MaxTokens";
          const tooShort = isAudioPartTooShort(candidate, target.soundSec, info.speakers, info.language, referenceLines);
          if (incomplete || tooShort) {
            if (input.isStopRequested?.()) return await stop();
            if (attempt < AUDIO_PART_ATTEMPTS) continue;
            Object.assign(record, usageFields());
            const code = incomplete ? "TranscriptIncomplete" : "TranscriptTooShort";
            const message = `音声の区切り ${index + 1}/${parts.length} の文字起こしが途中で止まったか、短すぎます。完了した区切りまでを残しました。音声を確認して、もう一度実行してください。`;
            return await endTranscription(input, record, checkpoint, started, "failed", code, message, output);
          }
          text = candidate;
          continue;
        }
        const code = final?.type === "Error" ? final.reason_code : "TransientFailure";
        if (
          code === "TransientFailure" &&
          !input.noRetryTerminalTransientFailure &&
          attempt < AUDIO_PART_ATTEMPTS &&
          !input.isStopRequested?.()
        ) continue;
        if (input.isStopRequested?.()) return await stop();
        tokensKnown = false;
        Object.assign(record, usageFields());
        const terminalCode = code === "TransientFailure" && input.noRetryTerminalTransientFailure ? "ResultUnknown" : code;
        const message = terminalCode === "ResultUnknown"
          ? "AIへ送信した後の結果を確認できません。自動では送り直さず、履歴を確認してください。"
          : (final?.type === "Error" && final.message) || reasonMessage(code as ReasonCode, "gemini", connection);
        return await endTranscription(input, record, checkpoint, started, "failed", terminalCode, message, provisionalOutput);
      }
      const partResult: AudioTranscriptPart = { text: text ?? "", startSec: target.startSec, endSec: target.endSec, referenceLines };
      done.push(partResult);
      paragraphs.push(
        ...parseAudioTranscriptParagraphs({ text: partResult.text, speakers: info.speakers, language: info.language, referenceLines }),
      );
      output = audioTranscriptMarkdown(done, info.speakers, info.language);
      input.onProgress({ kind: "speech-text", text: output });
      try {
        await checkpoint.write(output, "running", null);
      } catch (error) {
        return await transcriptionRetentionFailed(input, record, started, output, error);
      }
    }
    Object.assign(record, usageFields());
    return await saveTranscript(input, record, checkpoint, started, output, output);
  } finally {
    await input.bridge.releaseAudio(input.jobId).catch(() => undefined);
  }
}

/**
 * Deepgram の文字起こし（API キー方式だけ。spec §5.5）: `transcribe_deepgram`（音声ごとに 1 回の同期の呼び出し。固有名詞の
 * 表記を keyterm に）→ docs-core の `deepgramTranscriptMarkdown` で `[hh:mm:ss] 話者N: 本文` にする（複数の音声は前の音声の
 * 長さだけずらす）。runs.jsonl には エンジン（provider `deepgram`）・モデル（nova-3）・音声の長さ・keyterm の数を残す
 * （見込み金額は音声の長さから。トークンは無い）。
 */
export const DEEPGRAM_MODEL = "nova-3";

async function runDeepgramTranscription(input: TranscriptionInput): Promise<StepRunOutcome> {
  const record = transcriptionRecord(input);
  // 話者人数・言語は録音の値、固有名詞は案件の値
  const info = recordingInfo(input.project, input.recording);
  const terms = projectTranscriptionTerms(info, input.flow.terms);
  const keyterms = deepgramKeyterms(terms);
  Object.assign(record, { provider: "deepgram", connection: "apiKey", model: DEEPGRAM_MODEL, modelUsed: DEEPGRAM_MODEL, keyterms: keyterms.length });
  const started = Date.now();
  const checkpoint = transcriptionCheckpoint(input, record, "deepgram", DEEPGRAM_MODEL, null);
  try {
    await checkpoint.write("", "running", null);
  } catch (error) {
    return await transcriptionRetentionFailed(input, record, started, "", error);
  }
  const audio = input.recording.source.kind === "audio" ? input.recording.source.audio : [];
  let results;
  try {
    results = await input.bridge.transcribeDeepgram(
      input.jobId,
      input.rec,
      { language: info.language, diarize: info.speakers !== "none", keyterms },
      (event) => input.onProgress({ kind: "speech", event }),
    );
  } catch (error) {
    const stopped = isCommandError(error) && error.code === "speech_stopped";
    return endTranscription(
      input,
      record,
      checkpoint,
      started,
      stopped ? "stopped" : "failed",
      isCommandError(error) ? error.code : "speech_failed",
      stopped ? STOPPED_MESSAGE : errorMessage(error, "Deepgram で文字起こしできませんでした。もう一度実行してください。"),
      "",
    );
  }
  let offset = 0;
  const files = results.map((result, index) => {
    const file = { result, offsetSec: offset };
    const known = audio[index]?.durationSec;
    offset += result.durationSec ?? (known !== null && known !== undefined && Number.isFinite(known) ? known : 0);
    return file;
  });
  record.audioSec = offset;
  const markdown = deepgramTranscriptMarkdown(files, { language: info.language, speakers: info.speakers, terms });
  input.onProgress({ kind: "speech-text", text: markdown });
  return saveTranscript(input, record, checkpoint, started, markdown, markdown);
}
