import {
  DEFAULT_CAPABILITIES,
  ROOT_RECORDING_ID,
  SOURCE_STEP_ID,
  contractProvider,
  nihoApiProvider,
  type Connection,
  type FlowSnapshot,
  type Project,
  type ProjectEntity,
  type PromptMaterials,
  type ProviderCapabilities,
  type ProviderId,
  type Recording,
  type RecordingInfo,
  type ResolvedStepModel,
  type RunRecord,
} from "@niho/docs-core";
import type { Bridge, PersonalMaterial, PersonalOperationInfo, ProjectId, RecordingRef } from "./bridge";
import { cloudSettled } from "./cloud";
import { DOCS_ROOT_PROJECT_ID, type ProjectSyncSnapshot } from "./cloud-types";
import {
  PersonalCancellationError,
  PersonalDispatchError,
  PersonalExecutionError,
  PersonalRemoteRejectionError,
  canonical,
  createPersonalExecutionController,
  personalFixedFlow,
  personalPromptMaterialsDigest,
  sha256Text,
  type PersonalCandidate,
  type PersonalExecutionPorts,
  type PersonalExecutionRequest,
  type PersonalExecutionResult,
  type PersonalFixedSnapshot,
  type PersonalPromptMaterials,
  type PersonalSnapshotMaterial,
  type PersonalRoute,
  type PersonalRunHistory,
} from "./personal-execution";
import type { PersonalSubscriptionEntitlement } from "./personal-provider-readiness";
import {
  personalCandidateFromCapture,
  runPersonalGenerationStep,
  runPersonalTranscription,
  type PersonalAdapterCapture,
  type PersonalAdapterPersistence,
} from "./personal-runner-adapter";
import { createPersonalNihoPorts, personalNihoModelPlan } from "./personal-niho";
import { GEMINI_TRANSCRIPTION_EFFORT, GEMINI_TRANSCRIPTION_MODEL, type RunProgress } from "./runner";
import { defaultSettings, type AppSettings } from "./settings";

/**
 * 本人 Mac 実行（R6 #18739 slice 2）の production の ports。Native の operation（src-tauri/src/personal_run.rs）を開き、その handle に
 * 束縛した `PersonalExecutionPorts` で controller（personal-execution.ts）を動かし、最後に必ず閉じる。
 *
 * - 実行の段取り（prompt の組み立て・続きのループ・文字起こしの区切り）は今の runner を adapter（personal-runner-adapter.ts）で
 *   包んで使う（App と controller の 2 か所に持たない）。prompt の材料は受付時に固定した snapshot と Native の素材だけから作る
 *   （今の画面の materials・settings を読まない。端末の設定から読むのは接続方式と資格情報だけ）。
 * - 外部送信（`runTurn`・`transcribeAudioPart`）の直前に毎回 Native の guard と dispatch marker（`personalMarkDispatch`）を通す。
 *   marker を書けなければ送らない（Native も marker の無い送信を拒否する）。
 * - 途中記録（checkpoint・部分出力・送信直後の run record）は intent の private 領域（`personalSavePrivate`）へ。保存に失敗したら以後の
 *   送信をしない（adapter の RetentionFailed）。
 * - 公開は `personalPublish` 1 回（現在本文・版・runs.jsonl の行・集約を 1 つの保存単位で）。CAS を伴わない記録は `personalRecord`。
 * - NIHO API への後続（niho_api）も同じ controller から Native 内の専用受付へ接続し、本文・token は JS へ出さない。
 */

/** 同期の完了を待つ上限（超えたら「同期が終わっていない」として始めない）。 */
export const PERSONAL_SYNC_TIMEOUT_MS = 30_000;
/** 同期の状態を読み直す間隔。 */
export const PERSONAL_SYNC_POLL_MS = 500;

/** Native の id の制約（personal_run.rs の safe_id `[A-Za-z0-9_-]{1,64}`）と TS の ID 規則（英数字で始まる・`.` を含まない）の共通部分。 */
const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

function randomToken(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => ID_ALPHABET[byte & 63]).join("");
}

/** Native の id の制約に収まる id（`<prefix>_<22 字>`。prefix は英数字だけ）。runId・intentId・turn・job の id に使う。 */
export function newPersonalId(prefix: string): string {
  if (!/^[A-Za-z0-9]{1,32}$/.test(prefix)) throw new PersonalExecutionError("INVALID_ID", "id の頭が正しくありません。");
  return `${prefix}_${randomToken(22)}`;
}

/** 保管庫の版 ID（`v_` ＋ 22 字。niho_desktop_vault::is_version_id と同じ形）。候補の版ファイルの名前にもなる。 */
export function newPersonalVersionId(): string {
  return `v_${randomToken(22)}`;
}

/** 端末の設定から読む接続の状態（接続方式と、その方式で登録した AI＝資格情報の状態だけ。モデル・プロファイルは読まない）。 */
export type PersonalConnectionState = { connection: Connection; providers: readonly ProviderId[] };

/** App（#18740）が渡すもの。今の画面の materials・設定の全体は受け取らない。 */
export type NativePersonalDeps = {
  bridge: Bridge;
  /** 開始の前に、その録音の書きかけを保存し終える（App の flushArtifacts 相当）。 */
  flushDirty(rec: RecordingRef): Promise<void>;
  /** 各工程の開始時に読む接続の状態。 */
  connection(): PersonalConnectionState;
  /** providerが返した残量（取得できなければunknown。判明した枠切れだけを止める）。 */
  readEntitlement?: () => Promise<PersonalSubscriptionEntitlement>;
  now(): Date;
  /** turn・job・記録の id（省くと newPersonalId）。Native の id の制約に収まるものを返す。 */
  newId?(prefix: string): string;
  /** 候補の版 ID（省くと newPersonalVersionId）。 */
  newVersionId?(): string;
  /** 取り消し（Native の personalCancel で実行中の turn・job も止める）。 */
  signal?: AbortSignal;
  onProgress?(stepId: string, progress: RunProgress): void;
  /**
   * 同じNative operationが同期後に固定した素材と最新accessを表示し、利用者の同意を待つ。`models` は NIHO で動かす工程のモデル
   * （持ち替えた後）。`swap` は、同意の後に録音に固定した AI を NIHO の AI へ持ち替えて書く（docs-core の nihoApiModelSwap）とき true。
   */
  confirmNihoExecution?(input: {
    access: import("./bridge").PersonalNihoAccess;
    models: readonly ResolvedStepModel[];
    swap: boolean;
    sourceVersion: PersonalMaterial["sourceVersion"];
  }): Promise<void>;
  /** 同期の完了を待つ上限と間隔（テスト用。既定は PERSONAL_SYNC_TIMEOUT_MS・PERSONAL_SYNC_POLL_MS）。 */
  syncWait?: { timeoutMs?: number; intervalMs?: number; sleep?(ms: number): Promise<void> };
};

/** 本人 Mac 実行の依頼（本人・保存先は Native が開いた operation から決める）。 */
export type NativePersonalRequest = {
  runId: string;
  intentId: string;
  /** フォルダの id（フォルダ外は null。lease は予約の docs-root）。 */
  projectId: ProjectId;
  recordingPageId: string;
  recordingId: string;
  route: PersonalRoute;
  /** 端末内の経路の文字起こしの方式（後続だけの実行は null）。 */
  transcriptionProvider: "this-mac" | "gemini" | "deepgram" | null;
  /**
   * 文字起こしのエンジンの方式（Gemini のサブスクリプション／API キー。Deepgram は API キー、この Mac と後続だけの実行は null）。
   * モデルの方式（deps.connection）とは別に開始時に固定する。
   */
  transcriptionConnection?: Connection | null;
  continuationOfRunId: string | null;
  consentVersion: string;
  stepIds: string[];
  outputTarget?: PersonalExecutionRequest["outputTarget"];
};

/** 実行の結果。「この Mac に保存済み」と「クラウドの受領を確かめた」は別に返す（未確定を確定と書かない）。 */
export type NativePersonalResult = PersonalExecutionResult & {
  /** 公開した版がこの Mac の保存先に保存された。 */
  localSaved: boolean;
  /** 同期の状態で、この録音の保存先に未送信・未確定・競合が無いことを確かめた（確かめられなければ false）。 */
  cloudAcked: boolean;
  /** LOCAL の結果は保存済みだが受領通知が未確認。 */
  deliveryAckPending: boolean;
};

/** runs.jsonl の行に、runner が測った実行の詳細（前提・字数・トークン・時間など）のうち公開してよい欄だけを足す。 */
const RUN_DETAIL_KEYS = [
  "connection",
  "profile",
  "durationMs",
  "tokensKnown",
  "inputTokens",
  "outputTokens",
  "costUsd",
  "costKnown",
  "continuations",
  "inputChars",
  "refs",
  "outputChars",
  "audioSec",
  "basis",
] as const satisfies ReadonlyArray<keyof RunRecord>;

/**
 * 送信していない拒否（Native の guard の拒否と同じ code・文言）。どちらの code も PERSONAL_NOT_SENT_CODES に入り、adapter は
 * result_unknown にせず「送信しなかった失敗」にする（Native の run_turn の personal_guard_failed も同じ）。
 */
const SEND_REFUSED = { code: "personal_guard_failed", message: "実行を始めたときの状態から変わったため、送信しませんでした。" };
const SEND_UNMARKED = { code: "personal_dispatch_unmarked", message: "送信の記録を残せなかったため、送信しませんでした。" };
const WRITE_REFUSED = { code: "personal_write_refused", message: "本人 Mac 実行の結果は、確かめてから保存します。" };

function validNativeId(value: string | null, field: string): void {
  if (value === null) return;
  if (typeof value !== "string" || !NATIVE_ID.test(value)) throw new PersonalExecutionError("INVALID_ID", `${field} が正しくありません。`);
}

function syncTarget(projectId: ProjectId): string {
  return projectId ?? DOCS_ROOT_PROJECT_ID;
}

type SyncVerdict = { complete: true } | { complete: false; final: boolean; reason: string };

/**
 * 同期の状態から、始めてよいか（未送信・未確定・競合・削除の知らせが無く、依頼の前に読んだ最後の同期の時刻から変わった＝依頼の後に
 * 同期を終えた）。時刻は Native の値どうしを比べるだけで、画面の時計とは比べない。競合・削除・再ログインは待っても直らないので final。
 */
function syncVerdict(snapshot: ProjectSyncSnapshot | null, syncedBefore: string | null): SyncVerdict {
  if (!snapshot) return { complete: false, final: false, reason: "同期の状態を確認できません。少し待ってから、もう一度実行してください。" };
  if (snapshot.conflicts.some((conflict) => conflict.status === "open")) {
    return { complete: false, final: true, reason: "確かめが要る競合があります。競合を解決してから実行してください。" };
  }
  if (snapshot.tombstone !== null) return { complete: false, final: true, reason: "別の Mac で削除されたフォルダです。どうするか選んでから実行してください。" };
  if (snapshot.lastError?.kind === "authRequired") return { complete: false, final: true, reason: "ログインし直してから実行してください。" };
  const pending =
    snapshot.syncing ||
    snapshot.pendingMutation ||
    Object.keys(snapshot.dirty).length > 0 ||
    snapshot.acknowledgedGeneration < snapshot.localGeneration;
  if (pending) return { complete: false, final: false, reason: "まだクラウドに送っていない変更があります。同期が終わってから実行してください。" };
  if (snapshot.lastError !== null || snapshot.lastSyncedAt === null || snapshot.lastSyncedAt === syncedBefore) {
    return { complete: false, final: false, reason: "クラウドとの同期が終わっていません。少し待ってから、もう一度実行してください。" };
  }
  return { complete: true };
}

/** 背景情報の登場人物（Native は保存されたままの値を渡す。文字列の欄だけを読む）。 */
function entitiesOf(value: readonly unknown[]): ProjectEntity[] {
  const text = (record: Record<string, unknown>, key: string) => (typeof record[key] === "string" ? (record[key] as string) : "");
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return [{ id: text(record, "id"), name: text(record, "name"), reading: text(record, "reading"), role: text(record, "role"), note: text(record, "note") }];
  });
}

function infoOf(prompt: PersonalPromptMaterials): RecordingInfo {
  const value = prompt.info.value;
  return {
    speakers: value.speakers,
    language: value.language,
    terms: value.terms.map((term) => ({ term: term.term, reading: term.reading, variants: [...term.variants], note: term.note })),
    background: value.background,
    entities: entitiesOf(value.entities),
  };
}

function settingsFor(state: PersonalConnectionState): AppSettings {
  const base = defaultSettings();
  return {
    ...base,
    connection: state.connection,
    connections: {
      ...base.connections,
      [state.connection]: { ...base.connections[state.connection], providers: [...state.providers] },
    },
  };
}

/**
 * Native の operation を開き、controller を動かし、必ず閉じる。開けなければ Native の失敗（lease_held・store_busy・
 * personal_lease_unavailable・personal_not_signed_in など）をそのまま投げる。
 */
export async function runNativePersonalExecution(deps: NativePersonalDeps, request: NativePersonalRequest): Promise<NativePersonalResult> {
  validNativeId(request.runId, "runId");
  validNativeId(request.intentId, "intentId");
  validNativeId(request.recordingPageId, "recordingPageId");
  validNativeId(request.recordingId, "recordingId");
  validNativeId(request.projectId, "projectId");
  validNativeId(request.continuationOfRunId, "continuationOfRunId");
  if (deps.signal?.aborted) throw new PersonalCancellationError();
  const { bridge } = deps;
  const opened = await bridge.personalOpen({
    projectId: request.projectId,
    recordingPageId: request.recordingPageId,
    recordingId: request.recordingId,
    intentId: request.intentId,
    runId: request.runId,
    route: request.route,
    transcriptionProvider: request.transcriptionProvider,
    transcriptionConnection: request.transcriptionConnection ?? null,
    ...(request.outputTarget ? { outputTarget: structuredClone(request.outputTarget) } : {}),
  });
  const native = createNativePersonalPorts(deps, opened, request);
  const onAbort = () => native.cancel();
  deps.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (deps.signal?.aborted) native.cancel();
    const execution: PersonalExecutionRequest = {
      runId: request.runId,
      intentId: request.intentId,
      originDeviceId: opened.deviceId,
      ownerAccountId: opened.ownerAccountId,
      rootId: opened.rootId,
      containerRef: request.projectId === null ? { kind: "root" } : { kind: "folder", projectId: request.projectId },
      recordingPageId: request.recordingPageId,
      recordingId: request.recordingId,
      route: request.route,
      continuationOfRunId: request.continuationOfRunId,
      consentVersion: request.consentVersion,
      stepIds: [...request.stepIds],
      ...(request.outputTarget ? { outputTarget: structuredClone(request.outputTarget) } : {}),
    };
    let result: PersonalExecutionResult;
    try {
      result = await createPersonalExecutionController(native.ports)(execution);
    } finally {
      // 後続工程が失敗しても、先に公開できた版の受領通知は再試行する。
      await native.retryDeliveryAcks();
    }
    return { ...result, localSaved: native.localSaved(), cloudAcked: await native.cloudAcked(),
      deliveryAckPending: native.deliveryAckPending() };
  } finally {
    deps.signal?.removeEventListener("abort", onAbort);
    // controller が lease を返していれば二度目は released:false で無害。開いたまま失敗したときもここで閉じる
    await bridge.personalClose(opened.handle).catch(() => undefined);
  }
}

/**
 * operation の handle に束縛した ports（テストからも使う）。`cancel` は Native の取消（実行中の turn・job も止める）、`localSaved`・
 * `cloudAcked` は結果の保存の段階。
 */
export function createNativePersonalPorts(deps: NativePersonalDeps, opened: PersonalOperationInfo, request: NativePersonalRequest) {
  const { bridge } = deps;
  const handle = opened.handle;
  const intentId = request.intentId;
  const target = syncTarget(request.projectId);
  const rec: RecordingRef = { projectId: request.projectId, recordingId: request.recordingId };
  const newId = (prefix: string) => (deps.newId ?? newPersonalId)(prefix);
  const newVersionId = () => (deps.newVersionId ?? newPersonalVersionId)();
  const sleep = deps.syncWait?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let material: PersonalMaterial | null = null;
  let fixed: PersonalFixedSnapshot | null = null;
  let lastAggregate: PersonalRunHistory | null = null;
  let stopRequested = false;
  let saved = false;
  /** 固定した版の本文（版 ID → 本文）。素材の原文・前工程と、この実行で保存した候補。使う前に SHA-256 を照らす。 */
  const texts = new Map<string, string>();
  /** 固定した参考ページの本文（ページ id → 本文）。 */
  const referenceTexts = new Map<string, string>();
  /** runner が測った実行の詳細（候補の版 ID → 記録）。公開の行に足す。 */
  const runDetails = new Map<string, RunRecord>();
  const deviceVersions = new Set<string>();
  const pendingDeliveryAcks = new Map<string, string>();

  const cancel = () => {
    stopRequested = true;
    void bridge.personalCancel(handle).catch(() => undefined);
  };

  const requireMaterial = (): PersonalMaterial => {
    if (!material) throw new PersonalExecutionError("MATERIAL_MISSING", "固定した素材がありません。もう一度実行してください。");
    return material;
  };

  /** 固定した snapshot の hash に入っているフローと prompt の材料だけを返す（素材が受付の後に変わっていれば止める）。 */
  const fixedPromptBasis = async (snapshot: PersonalFixedSnapshot): Promise<{ flow: FlowSnapshot; prompt: PersonalPromptMaterials }> => {
    const source = requireMaterial();
    const flow = personalFixedFlow(source.flow, snapshot.fixedModels);
    if ((await sha256Text(canonical(flow))) !== snapshot.flowSnapshotSha256) {
      throw new PersonalExecutionError("INPUT_CHANGED", "固定した工程が変わりました。候補は上書きせず残しました。");
    }
    if (!source.promptMaterials || !snapshot.input.promptMaterials) {
      throw new PersonalExecutionError("PROMPT_MATERIALS_MISSING", "prompt に入れる素材を固定できませんでした。もう一度実行してください。");
    }
    const digest = await personalPromptMaterialsDigest(
      source.promptMaterials,
      snapshot.input.referencePages.map((page) => page.pageId),
      source.recordingMetadata,
    );
    if (canonical(digest) !== canonical(snapshot.input.promptMaterials)) {
      throw new PersonalExecutionError("INPUT_CHANGED", "固定した背景情報・参考ページが変わりました。候補は上書きせず残しました。");
    }
    return { flow, prompt: source.promptMaterials };
  };

  const fixedText = async (ref: { versionId: string; path: string; sha256: string }, field: string): Promise<string> => {
    const text = texts.get(`${ref.path}:${ref.versionId}`);
    if (text === undefined || (await sha256Text(text)) !== ref.sha256) {
      throw new PersonalExecutionError("FIXED_TEXT_MISSING", `${field}の確定した本文を確かめられません。もう一度実行してください。`);
    }
    return text;
  };

  /**
   * 外部送信の直前: Native の guard（本人・保存先・lease・取消・受け付けた固定入力）を確かめ、dispatch marker を永続化する。
   * どちらかが通らなければ投げる（runner は送信せずに失敗として終える）。marker を書いた直後の 1 回の送信だけを通す。
   */
  let armed = false;
  const beforeSend = async (snapshot: PersonalFixedSnapshot, stepId: string, mark: boolean) => {
    armed = false;
    if (stopRequested) throw SEND_REFUSED;
    const checked = await bridge.personalGuard(handle, "before_dispatch", null);
    if (
      checked.cancelled ||
      checked.ownerAccountId !== opened.ownerAccountId ||
      checked.rootId !== opened.rootId ||
      checked.leaseId !== opened.leaseId ||
      checked.snapshotSha256 !== snapshot.snapshotSha256
    ) {
      throw SEND_REFUSED;
    }
    if (!mark) return;
    await bridge.personalMarkDispatch(handle, intentId, stepId);
    armed = true;
  };

  /** operation を添えて送る bridge。外部送信は marker の直後だけ、現在本文・runs.jsonl・checkpoint へは書かない。 */
  const operationBridge = (): Bridge =>
    new Proxy(bridge, {
      get(targetBridge, property) {
        if (property === "runTurn") {
          // marker の無い送信はここで止める（送っていない拒否）。Native の送信直前の guard の拒否（personal_guard_failed）もそのまま
          // 投げ、adapter の dispatchError が「送信しなかった失敗」に分ける。それ以外の失敗は今までどおり結果不明
          return async (...args: Parameters<Bridge["runTurn"]>) => {
            if (!armed) throw SEND_UNMARKED;
            armed = false;
            return targetBridge.runTurn(args[0], args[1], args[2], handle);
          };
        }
        if (property === "transcribeAudioPart") {
          return async (...args: Parameters<Bridge["transcribeAudioPart"]>) => {
            if (!armed) throw SEND_UNMARKED;
            armed = false;
            return targetBridge.transcribeAudioPart(args[0], args[1], args[2], args[3], args[4], args[5], handle);
          };
        }
        if (property === "transcribeDeepgram") {
          return async (...args: Parameters<Bridge["transcribeDeepgram"]>) => {
            if (!armed) throw SEND_UNMARKED;
            armed = false;
            return targetBridge.transcribeDeepgram(args[0], args[1], args[2], args[3], handle);
          };
        }
        if (property === "transcribe") {
          return async (...args: Parameters<Bridge["transcribe"]>) => targetBridge.transcribe(args[0], args[1], args[2], args[3], args[4], args[5], handle);
        }
        if (property === "prepareAudio") {
          return async (...args: Parameters<Bridge["prepareAudio"]>) => targetBridge.prepareAudio(args[0], args[1], args[2], handle);
        }
        if (property === "saveArtifact" || property === "appendRun" || property === "saveCheckpoint" || property === "writeArtifactDraft") {
          return async () => {
            throw WRITE_REFUSED;
          };
        }
        const value = Reflect.get(targetBridge, property, targetBridge);
        return typeof value === "function" ? value.bind(targetBridge) : value;
      },
    }) as Bridge;

  /** B0 の途中記録は intent の private 領域へ（同期しない。runs.jsonl・現在本文・版には書かない）。 */
  const persistence = (stepId: string): PersonalAdapterPersistence => ({
    saveCheckpoint: ({ runId, checkpoint }) => bridge.personalSavePrivate(handle, intentId, "checkpoint", { stepId, runId, checkpoint }),
    appendRun: ({ record }) => bridge.personalSavePrivate(handle, intentId, "run_record", { stepId, record }),
    savePartialCandidate: ({ candidate, outcome, checkpoint, record }) =>
      bridge.personalSavePrivate(handle, intentId, "partial_output", {
        stepId,
        candidate,
        status: outcome.status,
        reasonCode: outcome.status === "failed" ? outcome.reasonCode : null,
        checkpoint,
        record,
      }),
  });

  const readEntitlement = async (): Promise<PersonalSubscriptionEntitlement> =>
    deps.readEntitlement ? deps.readEntitlement() : { planConfirmed: false, usage: "unknown" };

  const capabilitiesFor = async (model: ResolvedStepModel, connection: Connection): Promise<ProviderCapabilities> => {
    try {
      const status = await bridge.providerStatus(contractProvider(model.provider, connection));
      if (status.installed) return status.capabilities;
    } catch {
      // 確かめられなければ既定（App の capabilitiesFor と同じ）。ログイン・モデルの確認は送信の直前に adapter が取り直す
    }
    return DEFAULT_CAPABILITIES;
  };

  const candidateFrom = (capture: PersonalAdapterCapture): PersonalCandidate => {
    const candidate = personalCandidateFromCapture(capture);
    if (capture.outcome.record) runDetails.set(candidate.versionId, structuredClone(capture.outcome.record));
    return candidate;
  };

  /**
   * 保存先の同期を依頼し、依頼の後に同期を終えるまで待つ（開始の前と、NIHO の AI へ持ち替えて録音を書いた後で同じ規則）。終わらなければ
   * complete: false と理由（競合・削除・再ログインは待たずに返す）。
   */
  const syncNow = async (): Promise<{ complete: boolean; reason?: string }> => {
    const contextChanged = { complete: false, reason: "保存先かログインの状態が変わりました。もう一度実行してください。" };
    // 依頼の前の最後の同期の時刻（これから変わったら、依頼の後に同期を終えた）
    const before = await bridge.cloudProjectStatus(target);
    if (before.contextGeneration !== opened.contextGeneration) return contextChanged;
    const syncedBefore = before.snapshot?.lastSyncedAt ?? null;
    await bridge.cloudSyncNow(target);
    const timeoutMs = deps.syncWait?.timeoutMs ?? PERSONAL_SYNC_TIMEOUT_MS;
    const intervalMs = Math.max(1, deps.syncWait?.intervalMs ?? PERSONAL_SYNC_POLL_MS);
    const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
    let reason = "クラウドとの同期が終わっていません。少し待ってから、もう一度実行してください。";
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (stopRequested) throw new PersonalCancellationError();
      if (attempt > 0) await sleep(intervalMs);
      const reply = await bridge.cloudProjectStatus(target);
      if (reply.contextGeneration !== opened.contextGeneration) return contextChanged;
      const verdict = syncVerdict(reply.snapshot, syncedBefore);
      if (verdict.complete) return { complete: true };
      reason = verdict.reason;
      if (verdict.final) break;
    }
    return { complete: false, reason };
  };

  const nihoRoute = request.route.kind === "generation_only" &&
    (request.route.executor === "niho_api" || request.route.executor === "device_niho_api");

  const readMaterial = async (): Promise<PersonalMaterial> => {
    const read = await bridge.personalReadMaterial(handle, { stepIds: [...request.stepIds] });
    // connection は端末設定の所有物。録音に保存された旧端末の方式ではなく、このoperationで本人が選んだ方式を固定する。
    // NIHO に任せるときは録音に固定したまま（NIHO の AI のモデルは API キー方式。この Mac の方式で上書きしない）
    const connection = deps.connection().connection;
    const fixedRead: PersonalMaterial = nihoRoute
      ? read
      : {
          ...read,
          flow: {
            ...read.flow,
            models: Object.fromEntries(Object.entries(read.flow.models).map(([stepId, model]) => [stepId, { ...model, connection }])),
          },
        };
    material = fixedRead;
    texts.clear();
    referenceTexts.clear();
    if (fixedRead.sourceVersion) texts.set(`${fixedRead.sourceVersion.path}:${fixedRead.sourceVersion.versionId}`, fixedRead.sourceVersion.content);
    for (const prior of fixedRead.priorSteps) texts.set(`${prior.path}:${prior.versionId}`, prior.content);
    for (const page of fixedRead.referencePages) referenceTexts.set(page.pageId, page.content);
    return fixedRead;
  };

  const ports: PersonalExecutionPorts = {
    async flushDirty() {
      await deps.flushDirty(rec);
    },

    async pullAndSync() {
      const ensureNihoIdle = async () => {
        try {
          await bridge.personalNihoEnsureIdle(handle);
        } catch (error) {
          const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
          const transcriptionOnlyOffline =
            request.route.kind === "local_transcription_only" && request.transcriptionProvider === "this-mac" &&
            ["personal_niho_offline", "personal_niho_unavailable", "personal_niho_auth_required"].includes(code);
          if (!transcriptionOnlyOffline) throw error;
        }
      };
      // 端末内の文字起こしだけを NIHO に届かないまま開いた: Native が検証した手元の写しを使う
      if (!opened.cloudLease) {
        if (!(request.route.kind === "generation_only" && request.route.executor === "device_niho_api")) await ensureNihoIdle();
        return { complete: true };
      }
      const synced = await syncNow();
      if (synced.complete && !(request.route.kind === "generation_only" && request.route.executor === "device_niho_api")) await ensureNihoIdle();
      return synced;
    },

    async inspectOwnerContext() {
      // 本人・保存先が開いた時から変わっていれば、Native はその欄を空で返す（controller が ACCOUNT_CHANGED・ROOT_CHANGED にする）
      const checked = await bridge.personalGuard(handle, "before_dispatch", null);
      return { ownerAccountId: checked.ownerAccountId, rootId: checked.rootId };
    },

    async readSnapshotMaterial() {
      return readMaterial();
    },

    async prepareRequest({ request: prepared, material: fixedMaterial }) {
      if (!(prepared.route.kind === "generation_only" &&
        (prepared.route.executor === "niho_api" || prepared.route.executor === "device_niho_api"))) return { request: prepared };
      const access = await bridge.personalNihoAccess(handle, prepared.stepIds.length);
      const materialIdentity = (material: PersonalSnapshotMaterial) => {
        const { baseManifestRevision: _manifestRevision, sourceVersion, ...inputs } = material;
        void _manifestRevision;
        const stableSourceVersion = sourceVersion
          ? (({ synced, ...version }) => {
              void synced;
              return version;
            })(sourceVersion)
          : null;
        return canonical({ ...inputs, sourceVersion: stableSourceVersion });
      };
      if (prepared.route.executor === "device_niho_api") {
        const models = prepared.stepIds.map((stepId) => fixedMaterial.flow.models[stepId]);
        // 新規実行の予算は Native で判定する。予算切れの再開は Native が既存受付・同じモデル・同意版を照合した場合だけ許す。
        const provider = access.provider ? nihoApiProvider(access.provider) : null;
        const matching = !!provider && !!access.model && models.every((model) =>
          model?.provider === provider && model.model === access.model);
        if (!matching || !access.consentVersion || (!access.available && access.reasonCode !== "BUDGET_EXHAUSTED")) {
          throw new PersonalExecutionError("NIHO_API_NOT_READY", "この録音に固定した AI・同意を確認できません。工程の設定を確かめてください。");
        }
        if (deps.signal?.aborted) throw new PersonalCancellationError();
        await deps.confirmNihoExecution?.({ access, models: models.filter((model): model is ResolvedStepModel => !!model), swap: false,
          sourceVersion: fixedMaterial.sourceVersion });
        if (deps.signal?.aborted || stopRequested) throw new PersonalCancellationError();
        const confirmed = await readMaterial();
        if (materialIdentity(confirmed) !== materialIdentity(fixedMaterial)) {
          throw new PersonalExecutionError("INPUT_CHANGED", "確認の間に録音の入力が変わりました。もう一度実行してください。");
        }
        return { request: { ...prepared, consentVersion: access.consentVersion }, material: confirmed };
      }
      // 録音に固定した AI が NIHO の AI と違う工程は、同意の後に NIHO の AI へ持ち替える（docs-core の nihoApiModelSwap。Web と同じ規則）
      const plan = personalNihoModelPlan(access, fixedMaterial.flow, prepared.stepIds);
      if (!plan.ready || !access.consentVersion) {
        throw new PersonalExecutionError("NIHO_API_NOT_READY", plan.ready ? "クラウドの利用条件を確認できませんでした。" : plan.reason);
      }
      const consentVersion = access.consentVersion;
      const swap = Object.keys(plan.swap).length > 0;
      // 以前の形式の録音（root）は NIHO API へ渡せない（Native も送る前に断る）。持ち替えて書く前に、書かずに止める
      if (swap && (rec.recordingId === ROOT_RECORDING_ID || request.recordingPageId === ROOT_RECORDING_ID)) {
        throw new PersonalExecutionError("NIHO_API_NOT_READY", "この録音は古い形式のため、クラウドでは実行できません。この Mac で続けてください。");
      }
      if (deps.signal?.aborted) throw new PersonalCancellationError();
      await deps.confirmNihoExecution?.({ access, models: plan.models, swap, sourceVersion: fixedMaterial.sourceVersion });
      if (deps.signal?.aborted || stopRequested) throw new PersonalCancellationError();
      const inputChanged = () =>
        new PersonalExecutionError("INPUT_CHANGED", "確認の間に録音の工程・原文・参考などが変わったため、送信しませんでした。もう一度実行してください。");
      const confirmedMaterial = await readMaterial();
      if (deps.signal?.aborted || stopRequested) throw new PersonalCancellationError();
      if (materialIdentity(confirmedMaterial) !== materialIdentity(fixedMaterial)) throw inputChanged();
      if (!swap) return { request: { ...prepared, consentVersion }, material: confirmedMaterial };
      // 確認した工程のまま、開始時に捕捉した Store に持ち替えを依頼する。flowSnapshot がずれていれば Native は何も書かず false を返す。
      try {
        const swapped = await bridge.personalSwapModels(handle, confirmedMaterial.flow, plan.swap);
        if (!swapped) throw inputChanged();
      } catch (error) {
        if (error instanceof PersonalExecutionError) throw error;
        throw new PersonalExecutionError("NIHO_API_MODEL_SWAP_FAILED", "録音の AI をクラウドの AI に切り替えられませんでした。もう一度実行するか、この Mac で続けてください。");
      }
      // 書いた録音を NIHO へ届けてから、同じ operation で素材を読み直す（API は NIHO に届いた録音の固定モデルと照らす）
      const synced = await syncNow();
      if (!synced.complete) throw new PersonalExecutionError("SYNC_INCOMPLETE", synced.reason ?? "同期が終わっていません。同期を完了してから実行してください。");
      const refreshed = await readMaterial();
      const swappedMaterial: PersonalSnapshotMaterial = {
        ...fixedMaterial,
        flow: { ...fixedMaterial.flow, models: { ...fixedMaterial.flow.models, ...structuredClone(plan.swap) } },
      };
      if (materialIdentity(refreshed) !== materialIdentity(swappedMaterial)) throw inputChanged();
      return { request: { ...prepared, consentVersion }, material: refreshed };
    },

    async verifyFixedInputs(snapshot) {
      fixed = snapshot;
      return bridge.personalVerifyInputs(handle, snapshot);
    },

    async reserveIntent(requestedIntentId, snapshotSha256) {
      if (!fixed || fixed.snapshotSha256 !== snapshotSha256) {
        throw new PersonalExecutionError("INPUT_CHANGED", "確かめた固定入力と受け付ける固定入力が違います。もう一度実行してください。");
      }
      return bridge.personalReserveIntent(handle, requestedIntentId, fixed);
    },

    async acquireLease() {
      // Native は personal_open で実行のロックと lease を取得済み
      return { leaseId: opened.leaseId };
    },

    async guardExecution({ snapshot, phase }) {
      return bridge.personalGuard(handle, phase, snapshot);
    },

    async releaseLease() {
      return bridge.personalClose(handle);
    },

    async executeTranscription({ snapshot }) {
      const model = snapshot.transcriptionModel;
      if (!model) throw new PersonalExecutionError("TRANSCRIPTION_MODEL_MISSING", "文字起こし方式を固定できません。");
      const { flow, prompt } = await fixedPromptBasis(snapshot);
      const info = infoOf(prompt);
      const gemini = model.provider === "gemini";
      const deepgram = model.provider === "deepgram";
      // 方式は開始時に固定したエンジンの方式（Gemini の API キーは固定値に connection を持ち、無ければサブスクリプション。Deepgram は
      // API キー）。モデルの方式は文字起こしに効かない。この Mac は方式を持たないので、記録には今のモデルの方式を残す（以前と同じ）
      const connection: Connection = gemini ? (model.connection ?? "subscription") : deepgram ? "apiKey" : deps.connection().connection;
      // 版・記録は adapter が候補として捕捉する。案件名は固定入力に無いので入れない（Gemini の指示は「取材・対話・会議などの録音」）
      const project: Project = {
        version: 1,
        id: request.projectId ?? "",
        name: "",
        createdAt: "",
        info: { speakers: info.speakers, language: info.language, terms: info.terms, background: info.background, entities: info.entities },
      };
      const recording: Recording = {
        version: 1,
        id: snapshot.recordingId,
        createdAt: "",
        flowSnapshot: flow,
        source: {
          kind: "audio",
          audio: snapshot.input.audio.map((item) => ({ file: item.path.split("/").at(-1)!, hash: item.sha256, name: "", durationSec: item.durationSec })),
        },
        speakers: info.speakers,
        language: info.language,
        refs: [],
      };
      const versionId = newVersionId();
      const target = snapshot.outputTarget?.stepId === SOURCE_STEP_ID ? snapshot.outputTarget : null;
      const artifactId = target?.artifactId ?? SOURCE_STEP_ID;
      const location = { versionId, artifactId, path: `recordings/${snapshot.recordingId}/versions/${artifactId}/${versionId}.md` };
      const geminiModel: ResolvedStepModel | null = gemini
        ? { provider: "gemini", model: GEMINI_TRANSCRIPTION_MODEL, effort: GEMINI_TRANSCRIPTION_EFFORT, profileId: "transcription", profileName: "文字起こし", connection }
        : null;
      const capture = await runPersonalTranscription(
        {
          bridge: operationBridge(),
          rec,
          project,
          recording,
          flow,
          jobId: newId("speech"),
          engine: model.provider,
          connection,
          ...(target ? { candidate: { id: target.candidateId, artifactId: target.artifactId } } : {}),
          newId,
          now: () => deps.now(),
          onProgress: (progress) => deps.onProgress?.(SOURCE_STEP_ID, progress),
          isStopRequested: () => stopRequested,
          // Gemini は区切りごとの外部送信の直前に marker を書く。この Mac の音声認識は外部送信ではないので guard だけ
          beforeAiDispatch: () => beforeSend(snapshot, SOURCE_STEP_ID, gemini || deepgram),
        },
        geminiModel,
        readEntitlement,
        location,
        persistence(SOURCE_STEP_ID),
      );
      return candidateFrom(capture);
    },

    async executeGenerationStep({ snapshot, stepId, sourceVersion }) {
      const fixedModel = snapshot.fixedModels[stepId];
      if (!fixedModel) throw new PersonalExecutionError("FIXED_MODEL_MISSING", `工程 ${stepId} の固定モデルがありません。`);
      const fixedSource = snapshot.input.sourceVersion;
      if (!fixedSource || fixedSource.versionId !== sourceVersion.versionId || fixedSource.sha256 !== sourceVersion.sha256) {
        throw new PersonalExecutionError("SOURCE_VERSION_REQUIRED", "固定した確定原文と実行する原文が違います。");
      }
      const { flow, prompt } = await fixedPromptBasis(snapshot);
      const stepIndex = flow.steps.findIndex((step) => step.id === stepId);
      if (stepIndex < 0) throw new PersonalExecutionError("UNKNOWN_STEP", "フローに無い工程は実行できません。");
      // prompt の材料は固定入力だけから: 原文は確定した原文の版、前工程は確定した各工程の版、参考・あなたについて・背景情報は固定した素材
      const artifacts: Record<string, string> = {};
      for (const prior of snapshot.input.priorSteps) artifacts[prior.stepId] = await fixedText(prior, "前の工程");
      const refs = await Promise.all(snapshot.input.referencePages.map(async (page, index) => {
        const body = referenceTexts.get(page.pageId);
        if (body === undefined || (await sha256Text(body)) !== page.sha256) {
          throw new PersonalExecutionError("FIXED_TEXT_MISSING", "参考ページの固定した本文を確かめられません。もう一度実行してください。");
        }
        return { pageId: page.pageId, title: prompt.referenceTitles.value[index]?.title ?? "", body };
      }));
      const materials: PromptMaterials = {
        sourceName: requireMaterial().recordingMetadata.sourceName ?? "文字起こし",
        source: await fixedText(sourceVersion, "原文"),
        artifacts,
        refs,
        info: infoOf(prompt),
        ...(prompt.about.value ? { about: { name: prompt.about.value.name, text: prompt.about.value.text } } : {}),
      };
      const state = deps.connection();
      const versionId = newVersionId();
      const target = snapshot.outputTarget?.stepId === stepId ? snapshot.outputTarget : null;
      const artifactId = target?.artifactId ?? stepId;
      const location = { versionId, artifactId, path: `recordings/${snapshot.recordingId}/versions/${artifactId}/${versionId}.md` };
      if (snapshot.route.kind === "generation_only" && snapshot.route.executor === "device_niho_api") {
        await beforeSend(snapshot, stepId, true);
        armed = false;
        let received: { text: string; runId: string };
        try {
          received = await bridge.personalDeviceGenerate(handle, snapshot.snapshotSha256, stepId, versionId);
        } catch (error) {
          const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
          if (code === "personal_device_result_unknown" || code === "personal_device_result_missing") {
            throw new PersonalDispatchError(true, error instanceof Error ? error.message : "結果を受け取れませんでした。依頼の状態を確認してください。");
          }
          throw error;
        }
        deviceVersions.add(versionId);
        return { stepId, artifactId, kind: "artifact", versionId, path: location.path,
          text: received.text, provider: fixedModel.provider, model: fixedModel.model, reportedModel: null };
      }
      const capture = await runPersonalGenerationStep(
        {
          bridge: operationBridge(),
          rec,
          flow,
          stepIndex,
          materials,
          settings: settingsFor(state),
          capabilities: await capabilitiesFor(fixedModel, state.connection),
          newId,
          now: () => deps.now(),
          onProgress: (progress) => deps.onProgress?.(stepId, progress),
          isStopRequested: () => stopRequested,
          beforeDispatch: () => beforeSend(snapshot, stepId, true),
          ...(target
            ? {
                candidate: {
                  id: target.candidateId,
                  artifactId: target.artifactId,
                  instruction: target.instruction,
                  inputVersions: { ...target.inputVersions },
                },
              }
            : {}),
        },
        fixedModel,
        readEntitlement,
        location,
        persistence(stepId),
      );
      return candidateFrom(capture);
    },

    async persistCandidate({ candidate, sha256, bytes }) {
      const stored = await bridge.personalPersistCandidate(handle, { ...candidate, sha256, bytes });
      // この実行で確定する版の本文（次の工程の prompt に使う。使う前に SHA-256 を照らす）
      texts.set(`${candidate.path}:${candidate.versionId}`, candidate.text);
      return stored;
    },

    async casCandidate() {
      // publishCandidate があるので controller は呼ばない（別々の更新で公開しない）
      throw new PersonalExecutionError("PUBLISH_REQUIRED", "結果は 1 つの保存単位で公開します。");
    },

    async publishCandidate({ candidate, expectedCurrentArtifactSha, aggregate, record }) {
      const details = runDetails.get(candidate.versionId);
      const merged: RunRecord | null = record ? { ...record } : null;
      if (merged && details) {
        for (const key of RUN_DETAIL_KEYS) {
          if (details[key] !== undefined) (merged as Record<string, unknown>)[key] = structuredClone(details[key]);
        }
      }
      const published = await bridge.personalPublish(handle, {
        intentId,
        stepId: candidate.stepId,
        kind: candidate.kind,
        candidateVersionId: candidate.versionId,
        artifactId: candidate.artifactId,
        expectedCurrentSha: expectedCurrentArtifactSha,
        aggregate,
        record: merged,
      });
      if (published.status !== "committed") return { status: "input_changed", reason: published.reason };
      saved = published.localSaved || saved;
      lastAggregate = structuredClone(aggregate);
      if (deviceVersions.has(candidate.versionId)) {
        try { await bridge.personalDeviceAck(handle, candidate.stepId, candidate.versionId); }
        catch { pendingDeliveryAcks.set(candidate.versionId, candidate.stepId); }
      }
      return { status: "committed", version: published.version, displayVersion: published.displayVersion };
    },

    ...createPersonalNihoPorts(bridge, handle),

    async writeAggregate(history) {
      lastAggregate = structuredClone(history);
      await bridge.personalRecord(handle, { aggregate: history, record: null });
    },

    async appendSyncEvent({ record, checkpoint }) {
      // controller は直前に writeAggregate で同じ集約を書いている。行のある記録（候補の保持・取消・失敗）だけを集約と 1 つの保存単位で書く
      if (record === null) return;
      if (!lastAggregate) throw new PersonalExecutionError("AGGREGATE_MISSING", "実行の記録を保存できませんでした。");
      await bridge.personalRecord(handle, {
        aggregate: lastAggregate,
        record,
        checkpoint: checkpoint ? { runId: checkpoint.runId, value: checkpoint } : null,
      });
    },

    async syncOutputAndHistory() {
      // best effort（受領の確認は同期の状態で別に判定する）
      await bridge.cloudSyncNow(target).catch(() => undefined);
    },

    async markIntent(requestedIntentId, state) {
      await bridge.personalMarkIntent(handle, requestedIntentId, state);
    },

    now: () => deps.now(),
  };

  return {
    ports,
    cancel,
    localSaved: () => saved,
    async retryDeliveryAcks() {
      for (const [versionId, stepId] of pendingDeliveryAcks) {
        try {
          await bridge.personalDeviceAck(handle, stepId, versionId);
          pendingDeliveryAcks.delete(versionId);
        } catch { /* 保存済みの結果は維持して、未確認を表示する。 */ }
      }
    },
    deliveryAckPending: () => pendingDeliveryAcks.size > 0,
    /** 公開した後の同期の状態で、クラウドの受領を確かめる（待たない。確かめられなければ false）。 */
    async cloudAcked(): Promise<boolean> {
      if (!opened.cloudLease || !saved) return false;
      try {
        const reply = await bridge.cloudProjectStatus(target);
        return reply.contextGeneration === opened.contextGeneration && cloudSettled(reply.snapshot);
      } catch {
        return false;
      }
    },
  };
}
