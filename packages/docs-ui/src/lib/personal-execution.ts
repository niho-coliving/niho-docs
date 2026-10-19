import type { Effort, FlowSnapshot, GlossaryEntry, ResolvedStepModel, RunCheckpoint, RunRecord, SpeakerMode } from "@niho/docs-core";
import { personalReportedModelMatches } from "./personal-provider-readiness";
import { DEEPGRAM_MODEL, GEMINI_TRANSCRIPTION_EFFORT, GEMINI_TRANSCRIPTION_MODEL } from "./runner";

export type PersonalContainerRef = { kind: "root" } | { kind: "folder"; projectId: string };
export type PersonalExecutor = "this_pc" | "niho_api";
export type PersonalTranscriptionModel =
  | { provider: "this-mac"; model: "niho-speech" }
  | { provider: "gemini"; model: string; effort: Effort; connection?: "subscription" | "apiKey" }
  | { provider: "deepgram"; model: string; connection: "apiKey" };
export type PersonalRoute =
  | { kind: "local_full" }
  | { kind: "local_transcription_only" }
  | { kind: "generation_only"; executor: PersonalExecutor };
export type PersonalOutputTarget = {
  stepId: string;
  candidateId: string;
  artifactId: string;
  instruction?: string;
  inputVersions: Record<string, number>;
};
export type PersonalRunState =
  | "running"
  | "submitted"
  | "waiting_auth"
  | "completed"
  | "transcription_complete"
  | "input_changed"
  | "canceled"
  | "failed"
  | "result_unknown";

export type PersonalVersionRef = {
  versionId: string;
  path: string;
  sha256: string;
  bytes: number;
  originRunId: string;
  origin: "this_pc" | "shared_mac" | "niho_api";
  /**
   * Native の原子公開（personal_publish）が runs.jsonl の行に採番した表示の版の番号。公開の後の履歴（集約）と返り値の版にだけ付く
   * （固定入力・派生の snapshot には入れない。未公開・候補には無い）。
   */
  displayVersion?: number;
};

/** 音声の実体をJSへ読まず、native/C3が実SHA-256を照合済みの参照だけを受ける。 */
export type VerifiedAudioRef = {
  path: string;
  sha256: string;
  bytes: number;
  durationSec: number | null;
  verification: "native_sha256" | "c3_object_sha256";
};

/** 値と、その canonical JSON の SHA-256（Native の personal_read_material が付ける）。 */
export type PersonalHashed<T> = { value: T; sha256: string };

/**
 * prompt に実際に入る「あなたについて」・参考ページのタイトル・背景情報（Native が捕捉した Store から読んだ値）。固定入力の hash に
 * 含め（`input.promptMaterials`）、実行の prompt はこの値だけから組み立てる（今の画面の値・設定は読まない）。
 */
export type PersonalPromptMaterials = {
  about: PersonalHashed<{ name: string; text: string } | null>;
  referenceTitles: PersonalHashed<Array<{ pageId: string; title: string }>>;
  info: PersonalHashed<{ speakers: SpeakerMode; language: "ja" | "en"; terms: GlossaryEntry[]; background: string; entities: unknown[] }>;
};

/** 固定入力に入れる prompt の材料の hash（値の canonical JSON の SHA-256。Native の hashed と同じ）。 */
export type PersonalPromptMaterialsDigest = { aboutSha256: string; referenceTitlesSha256: string; infoSha256: string };

export type PersonalSnapshotMaterial = {
  baseManifestRevision: number;
  recordingMetadata: { speakers: SpeakerMode; language: "ja" | "en"; background: string; terms: GlossaryEntry[]; sourceName?: string };
  flow: FlowSnapshot;
  audio: VerifiedAudioRef[];
  transcriptionModel: PersonalTranscriptionModel | null;
  sourceVersion: (Omit<PersonalVersionRef, "sha256" | "bytes"> & { content: string; expectedSha256?: string; synced: boolean }) | null;
  referencePages: Array<{ pageId: string; path: string; versionId: string; content: string; expectedSha256?: string }>;
  priorSteps: Array<{ stepId: string; versionId: string; path: string; content: string; expectedSha256?: string }>;
  expectedCurrentArtifactShaByStep: Record<string, string | null>;
  /** あれば固定入力の hash に含める（無い旧素材は今までどおりの hash）。 */
  promptMaterials?: PersonalPromptMaterials;
};

export type PersonalFixedSnapshot = {
  schemaVersion: 1;
  ownerAccountId: string;
  rootId: string;
  containerRef: PersonalContainerRef;
  recordingPageId: string;
  recordingId: string;
  baseManifestRevision: number;
  route: PersonalRoute;
  continuationOfRunId: string | null;
  consentVersion: string;
  transcriptionModel: PersonalTranscriptionModel | null;
  selectedStepIds: string[];
  stepNames: Record<string, string>;
  input: {
    audio: VerifiedAudioRef[];
    sourceVersion: PersonalVersionRef | null;
    referencePages: Array<{ pageId: string; path: string; versionId: string; sha256: string; bytes: number }>;
    priorSteps: Array<{ stepId: string; versionId: string; path: string; sha256: string; bytes: number }>;
    expectedCurrentArtifactShaByStep: Record<string, string | null>;
    recordingMetadataSha256: string;
    /** 素材に prompt の材料があるときだけ（無い旧素材の固定入力には欄ごと無い）。 */
    promptMaterials?: PersonalPromptMaterialsDigest;
  };
  flowSnapshotSha256: string;
  fixedModels: Record<string, ResolvedStepModel>;
  /** 別案・追加指示の出力先。受付時に固定し、Native のCASまで同じ値に束縛する。 */
  outputTarget?: PersonalOutputTarget;
  snapshotSha256: string;
};

export type PersonalCandidate = {
  stepId: string;
  /** 保存先。通常工程は stepId、別案は固定した artifactId。 */
  artifactId: string;
  kind: "source" | "artifact";
  versionId: string;
  path: string;
  text: string;
  provider: "this-mac" | "gemini" | "gpt" | "claude" | "deepgram";
  /** 受付時に固定した選択モデル。現行版CASはこの同一性で判定する。 */
  model: string | null;
  /** providerがusageで明示した実モデル。未報告はnull、旧fixtureは省略可。 */
  reportedModel?: string | null;
};

export type PersonalStoredCandidate = Omit<PersonalCandidate, "text"> & {
  sha256: string;
  bytes: number;
  immutable: true;
};

export type PersonalRunHistory = {
  schemaVersion: 1;
  runId: string;
  intentId: string;
  originDeviceId: string;
  recordingPageId: string;
  recordingId: string;
  origin: "this_pc";
  continuationOfRunId: string | null;
  basisSnapshotSha256: string;
  sourceVersion: PersonalVersionRef | null;
  versions: PersonalVersionRef[];
  /** 現行版へ反映できなかった不変候補。原文・確定済み成果物とは分けて保持する。 */
  retainedCandidates: PersonalVersionRef[];
  state: PersonalRunState;
  transcriptionExecutions: number;
  remoteRunId: string | null;
  remoteState: PersonalRemoteState | null;
  at: string;
};

/**
 * Native（personal_publish）が runs.jsonl に書く本人 Mac 実行の公開の行。RunRecord（version・versionPath・versionSha256・
 * inputBasisSha256 など）に、本人 Mac 実行の出どころの欄を足したもの。provider・model（受付時に固定した選択値）・effort・modelUsed は
 * Native が固定入力と保存した候補から書く。golden fixture は test/fixtures/personal-run-c1.json。
 */
export type PersonalRunRecord = RunRecord & {
  /** 本人 Mac 実行の runId（`r6-` で始まる event id とは別）。 */
  personalRunId: string;
  origin: "this_pc";
  /** provider が報告した実モデル（未報告は null）。modelUsed と同じ値。 */
  reportedModel?: string | null;
};

export type PersonalRunEvent = {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  originDeviceId: string;
  stepId: string;
  stepName: string;
  state: PersonalRunState;
  at: string;
  continuationOfRunId: string | null;
  inputBasisSha256: string;
  sourceVersion: PersonalVersionRef | null;
  version: PersonalVersionRef | null;
  remoteRunId: string | null;
  reasonCode?: string;
};

export type PersonalExecutionRequest = {
  runId: string;
  intentId: string;
  originDeviceId: string;
  ownerAccountId: string;
  rootId: string;
  containerRef: PersonalContainerRef;
  recordingPageId: string;
  recordingId: string;
  route: PersonalRoute;
  continuationOfRunId: string | null;
  consentVersion: string;
  stepIds: string[];
  outputTarget?: PersonalOutputTarget;
};

export type PersonalExecutionResult = Pick<
  PersonalRunHistory,
  "runId" | "state" | "sourceVersion" | "versions" | "retainedCandidates" | "transcriptionExecutions" | "remoteRunId" | "remoteState"
> & {
  /**
   * NIHO の run の reasonCode（受付の通知で `input_changed` が実行の前か中かを分ける）。保存する記録の形（HISTORY_KEYS）には載せず、
   * 受付を返した呼び出しの結果でだけ渡す。無ければ null。
   */
  remoteReasonCode?: string | null;
};

export type PersonalGuardPhase = "before_dispatch" | "before_persist" | "before_cas";
/** R0 §4 の状態名。Mac側の表示用語へ置換して保存しない。 */
export type PersonalRemoteState =
  | "queued" | "running" | "completed" | "transcription_complete" | "canceled" | "failed"
  | "input_expired" | "result_unknown" | "input_changed" | "needs_budget_action"
  | "needs_storage_action" | "waiting_runner" | "waiting_capacity" | "waiting_auth";

export type NihoContinuationSubmission = {
  schemaVersion: 1;
  intentId: string;
  originDeviceId: string;
  containerRef: PersonalContainerRef;
  recordingPageId: string;
  recordingId: string;
  continuationOfRunId: string;
  consentVersion: string;
  baseManifestRevision: number;
  selectedStepIds: string[];
  audio: [];
  sourceVersion: PersonalVersionRef;
  referencePages: PersonalFixedSnapshot["input"]["referencePages"];
  priorSteps: PersonalFixedSnapshot["input"]["priorSteps"];
  expectedCurrentArtifactShaByStep: Record<string, string | null>;
  recordingMetadataSha256: string;
  flowSnapshotSha256: string;
  fixedModels: Record<string, ResolvedStepModel>;
  snapshotSha256: string;
};

export type PersonalExecutionPorts = {
  flushDirty(request: PersonalExecutionRequest): Promise<void>;
  pullAndSync(request: PersonalExecutionRequest): Promise<{ complete: boolean; reason?: string }>;
  inspectOwnerContext(): Promise<{ ownerAccountId: string; rootId: string }>;
  readSnapshotMaterial(request: PersonalExecutionRequest): Promise<PersonalSnapshotMaterial>;
  /**
   * Native素材を固定した後、reserve前に実行条件を確定する。NIHO同意は同じoperationを保ったままここで待つ。録音を書き換えて同期し直した
   * （NIHO の AI へ工程のモデルを持ち替えた）ときは、同じ operation で読み直した素材を `material` で返す（controller はそれで固定する）。
   */
  prepareRequest?(input: {
    request: PersonalExecutionRequest;
    material: PersonalSnapshotMaterial;
  }): Promise<{ request: PersonalExecutionRequest; material?: PersonalSnapshotMaterial }>;
  /** native/C3側で固定版の実SHA-256・byte数と、認識に使う原音声の存続・利用期限を検査する（未結合）。 */
  verifyFixedInputs(snapshot: PersonalFixedSnapshot): Promise<{ verified: boolean; reason?: string }>;
  /** `resumed` は同じ snapshot の `waiting_auth` intent を原子的に再開予約した場合だけ返す。 */
  reserveIntent(intentId: string, snapshotSha256: string): Promise<{ status: "new" | "resumed" } | { status: "existing"; state: PersonalRunState }>;
  acquireLease(request: PersonalExecutionRequest): Promise<{ leaseId: string }>;
  guardExecution(input: {
    request: PersonalExecutionRequest;
    snapshot: PersonalFixedSnapshot;
    leaseId: string;
    phase: PersonalGuardPhase;
  }): Promise<{ ownerAccountId: string; rootId: string; snapshotSha256: string; leaseId: string; cancelled: boolean }>;
  releaseLease(request: PersonalExecutionRequest, leaseId: string): Promise<{ released: boolean; leaseId: string }>;
  executeTranscription(input: { snapshot: PersonalFixedSnapshot; leaseId: string }): Promise<PersonalCandidate>;
  executeGenerationStep(input: {
    snapshot: PersonalFixedSnapshot;
    stepId: string;
    sourceVersion: PersonalVersionRef;
    leaseId: string;
  }): Promise<PersonalCandidate>;
  persistCandidate(input: {
    snapshot: PersonalFixedSnapshot;
    candidate: PersonalCandidate;
    sha256: string;
    bytes: number;
    leaseId: string;
  }): Promise<PersonalStoredCandidate>;
  casCandidate(input: {
    snapshot: PersonalFixedSnapshot;
    candidate: PersonalStoredCandidate;
    /** candidate.stepId に対応する現在版だけを照合する。 */
    expectedCurrentArtifactSha: string | null;
    /**
     * 確定した後の集約（候補は `versions`〜`sourceVersion` へ移り、`retainedCandidates` から外れている）。Native の公開は現在本文・
     * runs.jsonl の行と一緒にこの集約を 1 つの保存単位で書くので、公開前の集約を渡さない。
     */
    aggregateAfterCommit: PersonalRunHistory;
    leaseId: string;
  }): Promise<{ status: "committed"; version: PersonalVersionRef } | { status: "input_changed"; reason: string }>;
  /**
   * 原子公開（任意）。ある場合、controller は `casCandidate → writeAggregate → appendSyncEvent` を別々に呼ばず、CAS 前に組み立てた
   * 「確定後の集約」と「確定 event の RunRecord」を照合値と一緒にこれ 1 回で渡す（Native の personal_publish が現在本文・版・
   * runs.jsonl の行・集約を 1 つの保存単位で書く）。displayVersion は Native が runs.jsonl の行に採番した表示の版の番号。
   */
  publishCandidate?(input: {
    snapshot: PersonalFixedSnapshot;
    candidate: PersonalStoredCandidate;
    /** candidate.stepId に対応する現在版だけを照合する（原文は source の照合値）。 */
    expectedCurrentArtifactSha: string | null;
    /** 確定後の集約（この版を versions に足し、retainedCandidates から外したもの）。 */
    aggregate: PersonalRunHistory;
    event: PersonalRunEvent;
    /** `projectPersonalRunEvent(event)`（数値の版は Native が採番して埋める）。 */
    record: RunRecord | null;
    leaseId: string;
  }): Promise<{ status: "committed"; version: PersonalVersionRef; displayVersion: number } | { status: "input_changed"; reason: string }>;
  nihoApiReadiness(input: { snapshot: PersonalFixedSnapshot }): Promise<{ ready: boolean; reason?: string }>;
  /** 生成完了を待たず、R1が耐久的に受付けたrunId/stateだけを返す。 */
  submitNihoContinuation(input: NihoContinuationSubmission): Promise<{ runId: string; state: PersonalRemoteState; reasonCode?: string | null }>;
  writeAggregate(history: PersonalRunHistory): Promise<void>;
  /** 未終端の受付イベントはrecord=null。既存RunRecordへ失敗として捏造しない。 */
  appendSyncEvent(input: { event: PersonalRunEvent; record: RunRecord | null; checkpoint?: RunCheckpoint | null }): Promise<void>;
  syncOutputAndHistory(input: { snapshot: PersonalFixedSnapshot; history: PersonalRunHistory; leaseId: string }): Promise<void>;
  markIntent(intentId: string, state: PersonalRunState): Promise<void>;
  now(): Date;
};

export class PersonalExecutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PersonalExecutionError";
  }
}

export class PersonalDispatchError extends Error {
  constructor(
    readonly resultUnknown: boolean,
    message: string,
    readonly record: RunRecord | null = null,
    readonly checkpoint: RunCheckpoint | null = null,
  ) {
    super(message);
    this.name = "PersonalDispatchError";
  }
}

export class PersonalRemoteRejectionError extends PersonalDispatchError {
  constructor(message: string) {
    super(false, message);
    this.name = "PersonalRemoteRejectionError";
  }
}

export class PersonalAuthenticationRequiredError extends Error {
  constructor(
    message = "本人の AI に再ログインしてから、もう一度実行してください。",
    readonly record: RunRecord | null = null,
    readonly checkpoint: RunCheckpoint | null = null,
  ) {
    super(message);
    this.name = "PersonalAuthenticationRequiredError";
  }
}

export class PersonalCancellationError extends Error {
  constructor(
    message = "実行を取り消しました。成功済みの原文と作ったページは残しています。",
    readonly record: RunRecord | null = null,
    readonly checkpoint: RunCheckpoint | null = null,
  ) {
    super(message);
    this.name = "PersonalCancellationError";
  }
}

const SHA256 = /^[a-f0-9]{64}$/;
/** 原文（工程 1）の公開の照合値のキー（expectedCurrentArtifactShaByStep の中。工程の id とは重ならない予約の id）。 */
const SOURCE_EXPECTED_KEY = "source";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const PROVIDERS = new Set(["this-mac", "gemini", "gpt", "claude", "deepgram"]);
const ORIGINS = new Set(["this_pc", "shared_mac", "niho_api"]);
const REMOTE_STATES: ReadonlySet<string> = new Set<PersonalRemoteState>([
  "queued", "running", "completed", "transcription_complete", "canceled", "failed", "input_expired",
  "result_unknown", "input_changed", "needs_budget_action", "needs_storage_action", "waiting_runner",
  "waiting_capacity", "waiting_auth",
]);

function safeId(value: string, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new PersonalExecutionError("INVALID_ID", `${field} が正しくありません。`);
  return value;
}

function safeSha(value: string, field: string): string {
  if (!SHA256.test(value)) throw new PersonalExecutionError("INVALID_SHA256", `${field} のSHA-256が正しくありません。`);
  return value;
}

function pathSegments(value: string): string[] {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    throw new PersonalExecutionError("PATH_NOT_ALLOWED", "同期する参照は許可された保存先の相対パスだけを使えます。");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..") || segments.some((segment) => ["settings.json", ".agents", "local-ai"].includes(segment))) {
    throw new PersonalExecutionError("PATH_NOT_ALLOWED", "設定・workspace・許可範囲外の参照は同期できません。");
  }
  return segments;
}

function exactPagePath(path: string, pageId: string): string {
  const segments = pathSegments(path);
  if (segments.length !== 2 || segments[0] !== "pages" || segments[1] !== `${pageId}.md`) {
    throw new PersonalExecutionError("PATH_NOT_ALLOWED", "参考ページの版参照が許可範囲外です。");
  }
  return path;
}

function recordingPath(path: string, recordingId: string, area: "inputs" | "source" | "step", stepId?: string): string {
  const segments = pathSegments(path);
  const prefix = ["recordings", recordingId];
  const expected = area === "inputs" ? [...prefix, "inputs"] : [...prefix, "versions", area === "source" ? "source" : safeId(stepId!, "stepId")];
  if (segments.length <= expected.length || expected.some((segment, index) => segments[index] !== segment)) {
    throw new PersonalExecutionError("PATH_NOT_ALLOWED", "録音ページの版参照が許可範囲外です。");
  }
  if (area !== "inputs" && !segments.at(-1)!.endsWith(".md")) {
    throw new PersonalExecutionError("PATH_NOT_ALLOWED", "版参照はimmutable Markdownである必要があります。");
  }
  return path;
}

function validateRoute(route: PersonalRoute): void {
  if (!route || !["local_full", "local_transcription_only", "generation_only"].includes(route.kind)) {
    throw new PersonalExecutionError("UNKNOWN_ROUTE", "未対応の実行経路です。");
  }
  if (route.kind === "generation_only" && !["this_pc", "niho_api"].includes(route.executor)) {
    throw new PersonalExecutionError("UNKNOWN_EXECUTOR", "未対応の実行先です。");
  }
}

function validateRequestShell(request: PersonalExecutionRequest): void {
  validateRoute(request.route);
  safeId(request.runId, "runId");
  safeId(request.intentId, "intentId");
  safeId(request.originDeviceId, "originDeviceId");
  safeId(request.ownerAccountId, "ownerAccountId");
  safeId(request.rootId, "rootId");
  safeId(request.recordingPageId, "recordingPageId");
  safeId(request.recordingId, "recordingId");
  safeId(request.consentVersion, "consentVersion");
  request.stepIds.forEach((stepId) => safeId(stepId, "stepId"));
  if (request.outputTarget) {
    safeId(request.outputTarget.stepId, "outputTarget.stepId");
    safeId(request.outputTarget.candidateId, "outputTarget.candidateId");
    safeId(request.outputTarget.artifactId, "outputTarget.artifactId");
    if (!request.stepIds.includes(request.outputTarget.stepId)) {
      throw new PersonalExecutionError("INVALID_OUTPUT_TARGET", "別案の出力先は実行する工程に固定してください。");
    }
    if (request.outputTarget.instruction !== undefined && request.outputTarget.instruction.length > 20_000) {
      throw new PersonalExecutionError("INVALID_INSTRUCTION", "追加の指示が長すぎます。");
    }
    for (const [id, version] of Object.entries(request.outputTarget.inputVersions)) {
      safeId(id, "outputTarget.inputVersions");
      if (!Number.isSafeInteger(version) || version < 0) throw new PersonalExecutionError("INVALID_OUTPUT_TARGET", "別案の入力版が正しくありません。");
    }
  }
  if (request.continuationOfRunId !== null) safeId(request.continuationOfRunId, "continuationOfRunId");
  if (!request.containerRef || !["root", "folder"].includes(request.containerRef.kind)) throw new PersonalExecutionError("UNKNOWN_CONTAINER", "未対応の保存先です。");
  if (request.containerRef.kind === "folder") safeId(request.containerRef.projectId, "containerRef.projectId");
}

/** 固定入力の canonical JSON（キーを JS の sort 順に並べ、undefined を除く）。Native（personal_run.rs）も同じ規則で hash を確かめる。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PersonalExecutionError("INVALID_SNAPSHOT", "固定入力に有限でない数値は使えません。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new PersonalExecutionError("INVALID_SNAPSHOT", "固定入力に保存できない値が含まれています。");
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function sha256Text(text: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(text));
}

function textBytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function expectSha256(actual: string, expected: string | undefined): void {
  if (expected !== undefined && safeSha(expected, "expectedSha256") !== actual) {
    throw new PersonalExecutionError("INPUT_HASH_MISMATCH", "固定した入力の内容が変わりました。同期をやり直してください。");
  }
}

function withoutHash(snapshot: PersonalFixedSnapshot): Omit<PersonalFixedSnapshot, "snapshotSha256"> {
  const { snapshotSha256: _ignored, ...rest } = snapshot;
  return rest;
}

function allowlistedModel(model: ResolvedStepModel): ResolvedStepModel {
  return {
    provider: model.provider,
    model: model.model,
    effort: model.effort,
    profileId: model.profileId,
    profileName: model.profileName,
    ...(model.redirected === undefined ? {} : { redirected: model.redirected }),
    ...(model.connection === undefined ? {} : { connection: model.connection }),
  };
}

/**
 * 固定入力の hash（flowSnapshotSha256）に入れるフローの形（allowlist した欄と、選んだ工程の固定モデルだけ）。実行の prompt も
 * この形のフローから組み立てる（personal-native.ts が hash と一致することを確かめてから使う）。
 */
export function personalFixedFlow(flow: FlowSnapshot, fixedModels: Record<string, ResolvedStepModel>): FlowSnapshot {
  return {
    version: flow.version,
    id: flow.id,
    revision: flow.revision,
    name: flow.name,
    guide: flow.guide,
    terms: flow.terms.map((term) => ({ term: term.term, reading: term.reading, variants: [...term.variants], note: term.note })),
    samples: flow.samples.map((sample) => ({ id: sample.id, name: sample.name, chars: sample.chars, truncatedFrom: sample.truncatedFrom })),
    steps: flow.steps.map((step) => ({ id: step.id, name: step.name, instruction: step.instruction, provider: step.provider, profile: step.profile })),
    models: fixedModels,
  };
}

const SPEAKER_MODES: ReadonlySet<string> = new Set<SpeakerMode>(["auto", "2", "3", "4plus", "none"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGlossary(value: unknown): value is GlossaryEntry[] {
  return Array.isArray(value) && value.every((term) =>
    isRecord(term) &&
    typeof term.term === "string" &&
    typeof term.reading === "string" &&
    typeof term.note === "string" &&
    Array.isArray(term.variants) &&
    term.variants.every((variant) => typeof variant === "string"),
  );
}

function invalidPromptMaterials(): PersonalExecutionError {
  return new PersonalExecutionError("INVALID_PROMPT_MATERIALS", "prompt に入れる素材の形が正しくありません。同期をやり直してください。");
}

/**
 * prompt の材料（あなたについて・参考ページのタイトル・背景情報）の形を確かめ、値の canonical JSON の SHA-256 を計算する。Native が
 * 付けた sha256 と違えば INPUT_HASH_MISMATCH。参考ページのタイトルは固定した参考ページと同じ並び、背景情報は録音の metadata と同じ
 * 値であること（違えば INVALID_PROMPT_MATERIALS）。
 */
export async function personalPromptMaterialsDigest(
  materials: PersonalPromptMaterials,
  referencePageIds: readonly string[],
  metadata: PersonalSnapshotMaterial["recordingMetadata"],
): Promise<PersonalPromptMaterialsDigest> {
  if (!isRecord(materials) || !isRecord(materials.about) || !isRecord(materials.referenceTitles) || !isRecord(materials.info)) throw invalidPromptMaterials();
  const about = materials.about.value;
  if (about !== null && !(isRecord(about) && typeof about.name === "string" && typeof about.text === "string")) throw invalidPromptMaterials();
  const titles = materials.referenceTitles.value;
  if (
    !Array.isArray(titles) ||
    titles.length !== referencePageIds.length ||
    titles.some((item, index) => !isRecord(item) || typeof item.title !== "string" || safeId(item.pageId, "referenceTitle.pageId") !== referencePageIds[index])
  ) {
    throw invalidPromptMaterials();
  }
  const info = materials.info.value;
  if (
    !isRecord(info) ||
    !SPEAKER_MODES.has(info.speakers) ||
    (info.language !== "ja" && info.language !== "en") ||
    typeof info.background !== "string" ||
    !isGlossary(info.terms) ||
    !Array.isArray(info.entities) ||
    info.speakers !== metadata.speakers ||
    info.language !== metadata.language ||
    info.background !== metadata.background ||
    canonical(info.terms) !== canonical(metadata.terms)
  ) {
    throw invalidPromptMaterials();
  }
  const digest = async (hashed: PersonalHashed<unknown>) => {
    if (typeof hashed.sha256 !== "string") throw invalidPromptMaterials();
    const sha256 = await sha256Text(canonical(hashed.value));
    expectSha256(sha256, hashed.sha256);
    return sha256;
  };
  return {
    aboutSha256: await digest(materials.about),
    referenceTitlesSha256: await digest(materials.referenceTitles),
    infoSha256: await digest(materials.info),
  };
}

/** 秘密・settings・絶対path・workspaceを受け取らず、明示allowlistだけから固定入力を作る。 */
export async function buildPersonalFixedSnapshot(request: PersonalExecutionRequest, material: PersonalSnapshotMaterial): Promise<PersonalFixedSnapshot> {
  validateRequestShell(request);
  const recordingId = safeId(request.recordingId, "recordingId");
  const recordingPageId = safeId(request.recordingPageId, "recordingPageId");
  const requestedStepIds = request.stepIds.map((stepId) => safeId(stepId, "stepId"));
  if (new Set(requestedStepIds).size !== requestedStepIds.length) throw new PersonalExecutionError("DUPLICATE_STEP", "同じ工程を重複して実行できません。");
  const stepMap = new Map(material.flow.steps.map((step) => [step.id, step]));
  for (const stepId of requestedStepIds) if (!stepMap.has(stepId)) throw new PersonalExecutionError("UNKNOWN_STEP", "フローに無い工程は実行できません。");
  // UI の選択配列順には依存せず、固定フローの工程順を実行順にする。
  const requestedSteps = new Set(requestedStepIds);
  const selectedStepIds = material.flow.steps.filter((step) => requestedSteps.has(step.id)).map((step) => step.id);
  if (!Number.isInteger(material.baseManifestRevision) || material.baseManifestRevision < 0) throw new PersonalExecutionError("INVALID_MANIFEST_REVISION", "同期した版番号が正しくありません。");

  const audio = material.audio.map((item) => ({
    path: recordingPath(item.path, recordingId, "inputs"),
    sha256: safeSha(item.sha256, "audio.sha256"),
    bytes: item.bytes,
    durationSec: item.durationSec,
    verification: item.verification,
  }));
  if (
    audio.some(
      (item) =>
        !Number.isSafeInteger(item.bytes) ||
        item.bytes <= 0 ||
        (item.durationSec !== null && (!Number.isFinite(item.durationSec) || item.durationSec <= 0)) ||
        !["native_sha256", "c3_object_sha256"].includes(item.verification),
    )
  ) {
    throw new PersonalExecutionError("INVALID_AUDIO_REF", "音声参照の検証情報が正しくありません。");
  }
  let transcriptionModel: PersonalTranscriptionModel | null = null;
  if (request.route.kind !== "generation_only") {
    const selectedTranscriptionModel = material.transcriptionModel;
    if (!selectedTranscriptionModel) throw new PersonalExecutionError("TRANSCRIPTION_MODEL_MISSING", "文字起こし方式を固定できません。");
    if (selectedTranscriptionModel.provider === "this-mac" && selectedTranscriptionModel.model === "niho-speech") {
      transcriptionModel = { provider: "this-mac", model: "niho-speech" };
    } else if (
      selectedTranscriptionModel.provider === "gemini" &&
      selectedTranscriptionModel.model === GEMINI_TRANSCRIPTION_MODEL &&
      selectedTranscriptionModel.effort === GEMINI_TRANSCRIPTION_EFFORT &&
      (selectedTranscriptionModel.connection === undefined || selectedTranscriptionModel.connection === "apiKey")
    ) {
      // サブスクリプションの Gemini は connection を持たない（以前と同じ固定値）。API キーの Gemini だけ connection を持つ（Native と同じ）
      transcriptionModel =
        selectedTranscriptionModel.connection === "apiKey"
          ? { provider: "gemini", model: GEMINI_TRANSCRIPTION_MODEL, effort: GEMINI_TRANSCRIPTION_EFFORT, connection: "apiKey" }
          : { provider: "gemini", model: GEMINI_TRANSCRIPTION_MODEL, effort: GEMINI_TRANSCRIPTION_EFFORT };
    } else if (
      selectedTranscriptionModel.provider === "deepgram" &&
      selectedTranscriptionModel.model === DEEPGRAM_MODEL &&
      selectedTranscriptionModel.connection === "apiKey"
    ) {
      transcriptionModel = { provider: "deepgram", model: DEEPGRAM_MODEL, connection: "apiKey" };
    } else {
      throw new PersonalExecutionError("TRANSCRIPTION_MODEL_UNSUPPORTED", "選択した文字起こし方式・モデルは本人Macで固定実行できません。");
    }
  }
  const sourceVersion = material.sourceVersion
    ? await (async (): Promise<PersonalVersionRef> => {
        if (!ORIGINS.has(material.sourceVersion!.origin)) throw new PersonalExecutionError("UNKNOWN_ORIGIN", "未対応の原文の出所です。");
        const sha256 = await sha256Text(material.sourceVersion!.content);
        expectSha256(sha256, material.sourceVersion!.expectedSha256);
        return {
          versionId: safeId(material.sourceVersion!.versionId, "sourceVersion.versionId"),
          path: recordingPath(material.sourceVersion!.path, recordingId, "source"),
          sha256,
          bytes: textBytes(material.sourceVersion!.content),
          originRunId: safeId(material.sourceVersion!.originRunId, "sourceVersion.originRunId"),
          origin: material.sourceVersion!.origin,
        };
      })()
    : null;
  const referencePages = await Promise.all(material.referencePages.map(async (item) => {
    const pageId = safeId(item.pageId, "reference.pageId");
    const sha256 = await sha256Text(item.content);
    expectSha256(sha256, item.expectedSha256);
    return { pageId, path: exactPagePath(item.path, pageId), versionId: safeId(item.versionId, "reference.versionId"), sha256, bytes: textBytes(item.content) };
  }));
  const priorSteps = await Promise.all(material.priorSteps.map(async (item) => {
    const stepId = safeId(item.stepId, "priorStep.stepId");
    const sha256 = await sha256Text(item.content);
    expectSha256(sha256, item.expectedSha256);
    return { stepId, versionId: safeId(item.versionId, "priorStep.versionId"), path: recordingPath(item.path, recordingId, "step", stepId), sha256, bytes: textBytes(item.content) };
  }));
  const expectedCurrentArtifactShaByStep: Record<string, string | null> = {};
  for (const stepId of selectedStepIds) {
    const expected = material.expectedCurrentArtifactShaByStep[stepId];
    if (expected === undefined) throw new PersonalExecutionError("EXPECTED_SHA_MISSING", `工程 ${stepId} の現在版照合値がありません。`);
    expectedCurrentArtifactShaByStep[stepId] = expected === null ? null : safeSha(expected, `${stepId}.expectedCurrentArtifactSha`);
  }
  // 文字起こしをする経路は、受付時の今の文字起こし（版になっていない手直しを含む）を原文の公開の照合値として固定する（素材にあるときだけ。
  // Native の素材は常に持つ。無い素材は従来どおり確定原文の版の SHA で照合する）
  const sourceExpected = material.expectedCurrentArtifactShaByStep[SOURCE_EXPECTED_KEY];
  if (request.route.kind !== "generation_only" && sourceExpected !== undefined) {
    expectedCurrentArtifactShaByStep[SOURCE_EXPECTED_KEY] = sourceExpected === null ? null : safeSha(sourceExpected, "source.expectedCurrentArtifactSha");
  }
  if (request.route.kind === "generation_only" && (audio.length > 0 || !sourceVersion)) throw new PersonalExecutionError("INVALID_GENERATION_INPUT", "後続だけの実行には確定原文が必要で、音声は送信できません。");
  if (request.route.kind === "generation_only" && !request.continuationOfRunId) throw new PersonalExecutionError("CONTINUATION_REQUIRED", "後続実行には成功した元Runの参照が必要です。");
  if (request.route.kind === "generation_only" && sourceVersion?.originRunId !== request.continuationOfRunId) throw new PersonalExecutionError("SOURCE_RUN_MISMATCH", "確定原文は指定した元Runで作成された版である必要があります。");
  if (request.route.kind !== "local_transcription_only" && selectedStepIds.length === 0) throw new PersonalExecutionError("STEP_REQUIRED", "後続工程が選択されていません。");
  if (request.route.kind !== "generation_only" && audio.length === 0) throw new PersonalExecutionError("AUDIO_REQUIRED", "文字起こしには検証済み音声参照が必要です。");
  if (request.route.kind === "local_transcription_only" && selectedStepIds.length > 0) throw new PersonalExecutionError("INVALID_STEP_SELECTION", "文字起こしだけの実行に後続工程は指定できません。");

  const fixedModels = Object.fromEntries(selectedStepIds.map((stepId) => {
    const model = material.flow.models[stepId];
    if (!model) throw new PersonalExecutionError("FIXED_MODEL_MISSING", `工程 ${stepId} の固定モデルがありません。`);
    if (!["claude", "gpt", "gemini"].includes(model.provider)) throw new PersonalExecutionError("UNKNOWN_PROVIDER", `工程 ${stepId} のproviderは未対応です。`);
    return [stepId, allowlistedModel(model)];
  }));
  const metadata = {
    speakers: material.recordingMetadata.speakers,
    language: material.recordingMetadata.language,
    background: material.recordingMetadata.background,
    terms: material.recordingMetadata.terms.map((term) => ({ term: term.term, reading: term.reading, variants: [...term.variants], note: term.note })),
  };
  const flow = personalFixedFlow(material.flow, fixedModels);
  // prompt の材料は、素材にあるときだけ固定入力に入れる（無い旧素材は今までどおりの hash）
  const promptMaterials = material.promptMaterials === undefined
    ? undefined
    : await personalPromptMaterialsDigest(material.promptMaterials, referencePages.map((page) => page.pageId), metadata);
  const draft: PersonalFixedSnapshot = {
    schemaVersion: 1,
    ownerAccountId: safeId(request.ownerAccountId, "ownerAccountId"),
    rootId: safeId(request.rootId, "rootId"),
    containerRef: request.containerRef.kind === "root" ? { kind: "root" } : { kind: "folder", projectId: safeId(request.containerRef.projectId, "containerRef.projectId") },
    recordingPageId,
    recordingId,
    baseManifestRevision: material.baseManifestRevision,
    route: request.route.kind === "generation_only" ? { kind: "generation_only", executor: request.route.executor } : { kind: request.route.kind },
    continuationOfRunId: request.continuationOfRunId ? safeId(request.continuationOfRunId, "continuationOfRunId") : null,
    consentVersion: safeId(request.consentVersion, "consentVersion"),
    transcriptionModel,
    selectedStepIds,
    stepNames: Object.fromEntries(selectedStepIds.map((stepId) => [stepId, stepMap.get(stepId)!.name])),
    input: {
      audio,
      sourceVersion,
      referencePages,
      priorSteps,
      expectedCurrentArtifactShaByStep,
      recordingMetadataSha256: await sha256Text(canonical(metadata)),
      ...(promptMaterials ? { promptMaterials } : {}),
    },
    flowSnapshotSha256: await sha256Text(canonical(flow)),
    fixedModels,
    ...(request.outputTarget ? { outputTarget: structuredClone(request.outputTarget) } : {}),
    snapshotSha256: "",
  };
  draft.snapshotSha256 = await sha256Text(canonical(withoutHash(draft)));
  return draft;
}

async function rehash(snapshot: PersonalFixedSnapshot): Promise<PersonalFixedSnapshot> {
  const next = { ...snapshot, snapshotSha256: "" };
  next.snapshotSha256 = await sha256Text(canonical(withoutHash(next)));
  return next;
}

/** 確定した原文から後続へ進むときの派生（Native の guard が同じ変換だけを受け入れる。共有 fixture で確かめる）。 */
export async function generationSnapshot(snapshot: PersonalFixedSnapshot, sourceVersion: PersonalVersionRef): Promise<PersonalFixedSnapshot> {
  return rehash({ ...snapshot, route: { kind: "generation_only", executor: "this_pc" }, input: { ...snapshot.input, audio: [], sourceVersion }, snapshotSha256: "" });
}

/** 工程を確定した後の派生（同上）。 */
export async function nextStepSnapshot(snapshot: PersonalFixedSnapshot, stepId: string, version: PersonalVersionRef): Promise<PersonalFixedSnapshot> {
  return rehash({
    ...snapshot,
    input: {
      ...snapshot.input,
      priorSteps: [...snapshot.input.priorSteps.filter((prior) => prior.stepId !== stepId), { stepId, versionId: version.versionId, path: version.path, sha256: version.sha256, bytes: version.bytes }],
    },
    snapshotSha256: "",
  });
}

function makeHistory(request: PersonalExecutionRequest, snapshot: PersonalFixedSnapshot, at: string): PersonalRunHistory {
  return {
    schemaVersion: 1,
    runId: safeId(request.runId, "runId"),
    intentId: safeId(request.intentId, "intentId"),
    originDeviceId: safeId(request.originDeviceId, "originDeviceId"),
    recordingPageId: snapshot.recordingPageId,
    recordingId: snapshot.recordingId,
    origin: "this_pc",
    continuationOfRunId: snapshot.continuationOfRunId,
    basisSnapshotSha256: snapshot.snapshotSha256,
    sourceVersion: snapshot.input.sourceVersion,
    versions: [],
    retainedCandidates: [],
    state: "running",
    transcriptionExecutions: 0,
    remoteRunId: null,
    remoteState: null,
    at,
  };
}

function result(history: PersonalRunHistory, remoteReasonCode: string | null = null): PersonalExecutionResult {
  return {
    runId: history.runId,
    state: history.state,
    sourceVersion: history.sourceVersion,
    versions: history.versions,
    retainedCandidates: history.retainedCandidates,
    transcriptionExecutions: history.transcriptionExecutions,
    remoteRunId: history.remoteRunId,
    remoteState: history.remoteState,
    ...(remoteReasonCode !== null ? { remoteReasonCode } : {}),
  };
}

async function eventIdFor(history: PersonalRunHistory, stepId: string, state: PersonalRunState, version: PersonalVersionRef | null, at: string): Promise<string> {
  return `r6-${await sha256Text(canonical({ intentId: history.intentId, stepId, state, versionId: version?.versionId ?? null, remoteRunId: history.remoteRunId, at }))}`;
}

/**
 * 終端の event を runs.jsonl の行（RunRecord）へ写す。数値の版は、公開した版に Native が採番した表示の番号（`version.displayVersion`）
 * があるときだけ入れる（公開の前は null で渡し、Native の personal_publish が採番して埋める。表示上だけの番号は作らない）。
 */
export async function projectPersonalRunEvent(event: PersonalRunEvent): Promise<RunRecord | null> {
  if (event.state === "running" || event.state === "submitted" || event.state === "waiting_auth") return null;
  const result: RunRecord["result"] = event.state === "completed" || event.state === "transcription_complete" ? "saved" : event.state === "canceled" ? "stopped" : "failed";
  const displayVersion = result === "saved" ? event.version?.displayVersion : undefined;
  return {
    id: event.eventId,
    eventId: event.eventId,
    kind: "run",
    at: event.at,
    stepId: event.stepId,
    stepName: event.stepName,
    version: displayVersion !== undefined && Number.isSafeInteger(displayVersion) && displayVersion > 0 ? displayVersion : null,
    result,
    originDeviceId: event.originDeviceId,
    continuationOfRunId: event.continuationOfRunId ?? undefined,
    inputBasisSha256: event.inputBasisSha256,
    sourceVersionId: event.sourceVersion?.versionId,
    sourceVersionSha256: event.sourceVersion?.sha256,
    sourceVersionPath: event.sourceVersion?.path,
    versionPath: event.version?.path,
    versionSha256: event.version?.sha256,
    remoteRunId: event.remoteRunId ?? undefined,
    reasonCode: event.reasonCode,
  };
}

async function makeEvent(history: PersonalRunHistory, snapshot: PersonalFixedSnapshot, stepId: string, state: PersonalRunState, version: PersonalVersionRef | null, at: string): Promise<PersonalRunEvent> {
  return {
    schemaVersion: 1,
    eventId: await eventIdFor(history, stepId, state, version, at),
    runId: history.runId,
    originDeviceId: history.originDeviceId,
    stepId,
    stepName: stepId === "source" ? "文字起こし" : stepId === "execution" ? "実行" : snapshot.stepNames[stepId] ?? stepId,
    state,
    at,
    continuationOfRunId: history.continuationOfRunId,
    inputBasisSha256: snapshot.snapshotSha256,
    sourceVersion: history.sourceVersion,
    version,
    remoteRunId: history.remoteRunId,
  };
}

function validateCandidate(candidate: PersonalCandidate, snapshot: PersonalFixedSnapshot, expectedStepId: string, kind: PersonalCandidate["kind"]): void {
  if (!candidate || candidate.kind !== kind || safeId(candidate.stepId, "candidate.stepId") !== expectedStepId) throw new PersonalExecutionError("INVALID_CANDIDATE", "実行結果の工程が固定した工程と一致しません。");
  if (!PROVIDERS.has(candidate.provider)) throw new PersonalExecutionError("UNKNOWN_PROVIDER", "未対応のproviderから結果が返りました。");
  const expectedArtifactId = snapshot.outputTarget?.stepId === expectedStepId ? snapshot.outputTarget.artifactId : expectedStepId;
  if (safeId(candidate.artifactId, "candidate.artifactId") !== expectedArtifactId) {
    throw new PersonalExecutionError("INVALID_CANDIDATE", "実行結果の保存先が受付時に固定した別案と一致しません。");
  }
  const fixedModel = kind === "source" ? snapshot.transcriptionModel : snapshot.fixedModels[expectedStepId];
  if (!fixedModel || candidate.provider !== fixedModel.provider || candidate.model !== fixedModel.model) {
    throw new PersonalExecutionError("CANDIDATE_MODEL_MISMATCH", "候補の AI またはモデルが受付時に固定した工程と一致しません。");
  }
  if (
    candidate.reportedModel != null &&
    (fixedModel.provider === "this-mac" || fixedModel.provider === "deepgram"
      ? candidate.reportedModel !== fixedModel.model
      : !personalReportedModelMatches(fixedModel, candidate.reportedModel))
  ) {
    throw new PersonalExecutionError("CANDIDATE_MODEL_MISMATCH", "providerが報告した実モデルが受付時に固定した工程と一致しません。");
  }
  safeId(candidate.versionId, "candidate.versionId");
  recordingPath(candidate.path, snapshot.recordingId, kind === "source" ? "source" : "step", expectedArtifactId);
}

function validateVersion(version: PersonalVersionRef, snapshot: PersonalFixedSnapshot, stepId: string, kind: PersonalCandidate["kind"]): void {
  safeId(version.versionId, "version.versionId");
  safeSha(version.sha256, "version.sha256");
  safeId(version.originRunId, "version.originRunId");
  if (!ORIGINS.has(version.origin) || !Number.isSafeInteger(version.bytes) || version.bytes < 0) throw new PersonalExecutionError("INVALID_VERSION", "保存された版参照が正しくありません。");
  const artifactId = snapshot.outputTarget?.stepId === stepId ? snapshot.outputTarget.artifactId : stepId;
  recordingPath(version.path, snapshot.recordingId, kind === "source" ? "source" : "step", artifactId);
}

async function guard(ports: PersonalExecutionPorts, request: PersonalExecutionRequest, snapshot: PersonalFixedSnapshot, leaseId: string, phase: PersonalGuardPhase): Promise<void> {
  const checked = await ports.guardExecution({ request, snapshot, leaseId, phase });
  if (checked.cancelled) throw new PersonalCancellationError();
  if (checked.leaseId !== leaseId) throw new PersonalExecutionError("LEASE_LOST", "実行権が失効しました。候補は履歴から確認できます。");
  if (checked.ownerAccountId !== snapshot.ownerAccountId) throw new PersonalExecutionError("ACCOUNT_CHANGED", "実行中にアカウントが切り替わりました。");
  if (checked.rootId !== snapshot.rootId) throw new PersonalExecutionError("ROOT_CHANGED", "実行中に保存先が切り替わりました。");
  if (checked.snapshotSha256 !== snapshot.snapshotSha256) throw new PersonalExecutionError("INPUT_CHANGED", "固定した入力が変わりました。候補は上書きせず残しました。");
}

/** R6の実行順・候補保持・送信の非再試行を一か所で守るcontroller。 */
export function createPersonalExecutionController(ports: PersonalExecutionPorts) {
  const inFlight = new Set<string>();
  return async function execute(request: PersonalExecutionRequest): Promise<PersonalExecutionResult> {
    safeId(request.intentId, "intentId");
    validateRequestShell(request);
    if (inFlight.has(request.intentId)) throw new PersonalExecutionError("DUPLICATE_IN_PROGRESS", "同じ実行を開始済みです。完了を待ってください。");
    inFlight.add(request.intentId);
    let leaseId: string | null = null;
    let history: PersonalRunHistory | null = null;
    let activeSnapshot: PersonalFixedSnapshot | null = null;
    let intentReserved = false;
    let remoteDispatchStarted = false;
    try {
      await ports.flushDirty(request);
      const sync = await ports.pullAndSync(request);
      if (!sync.complete) throw new PersonalExecutionError("SYNC_INCOMPLETE", sync.reason ?? "同期が終わっていません。同期を完了してから実行してください。");
      const identity = await ports.inspectOwnerContext();
      if (identity.ownerAccountId !== request.ownerAccountId) throw new PersonalExecutionError("ACCOUNT_CHANGED", "同期中にアカウントが切り替わりました。");
      if (identity.rootId !== request.rootId) throw new PersonalExecutionError("ROOT_CHANGED", "同期中に保存先が切り替わりました。");
      let material = await ports.readSnapshotMaterial(request);
      // 後続実行が参照する元Runは、画面がflush前に見ていた行ではなく、同じoperationが同期後に読んだ不変原文の版に束縛する。
      // 準備で素材を読み直したときは、読み直した素材に束縛し直す
      const bindContinuation = (current: PersonalExecutionRequest): PersonalExecutionRequest =>
        current.route.kind === "generation_only" ? { ...current, continuationOfRunId: material.sourceVersion?.originRunId ?? null } : current;
      request = bindContinuation(request);
      if (ports.prepareRequest) {
        const prepared = await ports.prepareRequest({ request, material });
        request = prepared.request;
        if (prepared.material) {
          material = prepared.material;
          request = bindContinuation(request);
        }
      }
      validateRequestShell(request);
      let snapshot = await buildPersonalFixedSnapshot(request, material);
      activeSnapshot = snapshot;
      const verification = await ports.verifyFixedInputs(snapshot);
      if (!verification.verified) throw new PersonalExecutionError("FIXED_INPUT_NOT_VERIFIED", verification.reason ?? "固定入力の実SHA-256を確認できません。");
      const reserved = await ports.reserveIntent(request.intentId, snapshot.snapshotSha256);
      if (reserved.status === "existing") throw new PersonalExecutionError(reserved.state === "result_unknown" ? "RESULT_UNKNOWN_NO_RETRY" : "INTENT_ALREADY_EXISTS", reserved.state === "result_unknown" ? "前回の受付結果を確認できないため、自動では送り直しません。" : "同じ実行はすでに記録されています。");
      intentReserved = true;
      ({ leaseId } = await ports.acquireLease(request));
      safeId(leaseId, "leaseId");
      history = makeHistory(request, snapshot, ports.now().toISOString());
      await ports.writeAggregate(history);

      const persistAndCas = async (basis: PersonalFixedSnapshot, raw: PersonalCandidate, expectedStepId: string, kind: PersonalCandidate["kind"]) => {
        validateCandidate(raw, basis, expectedStepId, kind);
        const sha256 = await sha256Text(raw.text);
        const bytes = textBytes(raw.text);
        // dispatch済みの結果は、取消・入力変更・lease失効が直後に判明しても候補として失わない。
        let saveGuardError: unknown = null;
        try {
          await guard(ports, request, basis, leaseId!, "before_persist");
        } catch (error) {
          saveGuardError = error;
        }
        const stored = await ports.persistCandidate({ snapshot: basis, candidate: raw, sha256, bytes, leaseId: leaseId! });
        if (
          !stored.immutable ||
          stored.sha256 !== sha256 ||
          stored.bytes !== bytes ||
          stored.path !== raw.path ||
          stored.versionId !== raw.versionId ||
          stored.stepId !== raw.stepId ||
          stored.artifactId !== raw.artifactId ||
          stored.kind !== raw.kind ||
          stored.provider !== raw.provider ||
          stored.model !== raw.model ||
          stored.reportedModel !== raw.reportedModel
        ) {
          throw new PersonalExecutionError("CANDIDATE_PERSIST_MISMATCH", "候補版を不変の内容として保存できませんでした。");
        }
        validateCandidate({ ...stored, text: "" }, basis, expectedStepId, kind);
        const retained: PersonalVersionRef = {
          versionId: stored.versionId, path: stored.path, sha256: stored.sha256, bytes: stored.bytes,
          originRunId: request.runId, origin: "this_pc",
        };
        history!.retainedCandidates.push(retained);
        await ports.writeAggregate(history!);
        const recordRetention = async (state: PersonalRunState, error?: unknown) => {
          history!.state = state;
          const event = await makeEvent(history!, basis, expectedStepId, state, retained, ports.now().toISOString());
          if (error instanceof PersonalExecutionError) event.reasonCode = error.code;
          await ports.writeAggregate(history!);
          await ports.appendSyncEvent({ event, record: await projectPersonalRunEvent(event) });
        };
        if (saveGuardError) {
          await recordRetention(saveGuardError instanceof PersonalCancellationError ? "canceled" : "input_changed", saveGuardError);
          throw saveGuardError;
        }
        const expectedCurrentArtifactSha = kind === "source"
          ? Object.hasOwn(basis.input.expectedCurrentArtifactShaByStep, SOURCE_EXPECTED_KEY)
            ? basis.input.expectedCurrentArtifactShaByStep[SOURCE_EXPECTED_KEY]
            : basis.input.sourceVersion?.sha256 ?? null
          : basis.input.expectedCurrentArtifactShaByStep[expectedStepId];
        if (expectedCurrentArtifactSha === undefined) throw new PersonalExecutionError("EXPECTED_SHA_MISSING", `工程 ${expectedStepId} の現在版照合値がありません。`);
        if (ports.publishCandidate) {
          // 原子公開: 確定後の集約と確定 event の行を CAS の前に組み立て、Native が現在本文・版・runs.jsonl の行・集約を 1 回で書く。
          // 公開した版は保存済み候補と同じ参照（派生の snapshot にはこの 6 欄だけを使い、表示の番号は履歴と返り値にだけ付ける）。
          const publishedRef: PersonalVersionRef = { ...retained };
          const aggregate: PersonalRunHistory = {
            ...structuredClone(history!),
            versions: [...structuredClone(history!.versions), { ...publishedRef }],
            retainedCandidates: history!.retainedCandidates.filter((version) => version.versionId !== stored.versionId).map((version) => ({ ...version })),
            sourceVersion: kind === "source" ? { ...publishedRef } : structuredClone(history!.sourceVersion),
          };
          const event = await makeEvent(aggregate, basis, expectedStepId, kind === "source" ? "transcription_complete" : "completed", publishedRef, ports.now().toISOString());
          let published: Awaited<ReturnType<NonNullable<PersonalExecutionPorts["publishCandidate"]>>>;
          try {
            await guard(ports, request, basis, leaseId!, "before_cas");
            published = await ports.publishCandidate({
              snapshot: basis,
              candidate: stored,
              expectedCurrentArtifactSha,
              aggregate,
              event,
              record: await projectPersonalRunEvent(event),
              leaseId: leaseId!,
            });
          } catch (error) {
            await recordRetention(error instanceof PersonalCancellationError ? "canceled" : "input_changed", error);
            throw error;
          }
          if (published.status === "input_changed") {
            await recordRetention("input_changed");
            return { changed: true as const, version: null };
          }
          // committed: Native は現在本文・版・runs.jsonl の行・集約（この版を足し、同じ番号を付けたもの）を書き終えた。検証の前に手元の
          // 履歴も同じ内容にする（検証に失敗しても、外側の catch が候補保持の古い履歴で集約を上書きせず、失敗の印だけを足す）
          const numbered: PersonalVersionRef = typeof published.displayVersion === "number"
            ? { ...publishedRef, displayVersion: published.displayVersion }
            : { ...publishedRef };
          history!.versions.push(numbered);
          history!.retainedCandidates = history!.retainedCandidates.filter((version) => version.versionId !== stored.versionId);
          if (kind === "source") history!.sourceVersion = { ...numbered };
          validateVersion(published.version, basis, expectedStepId, kind);
          if (
            published.version.versionId !== stored.versionId ||
            published.version.sha256 !== stored.sha256 ||
            published.version.bytes !== stored.bytes ||
            published.version.path !== stored.path ||
            published.version.originRunId !== request.runId ||
            published.version.origin !== "this_pc"
          ) throw new PersonalExecutionError("COMMITTED_VERSION_MISMATCH", "確定版が保存済み候補と一致しません。");
          if (!Number.isSafeInteger(published.displayVersion) || published.displayVersion < 1) {
            throw new PersonalExecutionError("INVALID_DISPLAY_VERSION", "保存した版の番号を確認できませんでした。履歴を確認してください。");
          }
          await ports.syncOutputAndHistory({ snapshot: basis, history: history!, leaseId: leaseId! });
          return { changed: false as const, version: publishedRef };
        }
        let committed: Awaited<ReturnType<PersonalExecutionPorts["casCandidate"]>>;
        try {
          await guard(ports, request, basis, leaseId!, "before_cas");
          // 確定した版は保存済み候補と同じ参照（下で照合する）。公開と同じ保存単位へ確定後の集約を入れるため、先に組み立てて渡す
          const aggregateAfterCommit: PersonalRunHistory = {
            ...history!,
            versions: [...history!.versions, retained],
            retainedCandidates: history!.retainedCandidates.filter((version) => version.versionId !== stored.versionId),
            sourceVersion: kind === "source" ? retained : history!.sourceVersion,
          };
          committed = await ports.casCandidate({ snapshot: basis, candidate: stored, expectedCurrentArtifactSha, aggregateAfterCommit, leaseId: leaseId! });
        } catch (error) {
          await recordRetention(error instanceof PersonalCancellationError ? "canceled" : "input_changed", error);
          throw error;
        }
        if (committed.status === "input_changed") {
          await recordRetention("input_changed");
          return { changed: true as const, version: null };
        }
        validateVersion(committed.version, basis, expectedStepId, kind);
        if (
          committed.version.versionId !== stored.versionId ||
          committed.version.sha256 !== stored.sha256 ||
          committed.version.bytes !== stored.bytes ||
          committed.version.path !== stored.path ||
          committed.version.originRunId !== request.runId ||
          committed.version.origin !== "this_pc"
        ) throw new PersonalExecutionError("COMMITTED_VERSION_MISMATCH", "確定版が保存済み候補と一致しません。");
        history!.versions.push(committed.version);
        history!.retainedCandidates = history!.retainedCandidates.filter((version) => version.versionId !== stored.versionId);
        if (kind === "source") history!.sourceVersion = committed.version;
        const event = await makeEvent(history!, basis, expectedStepId, kind === "source" ? "transcription_complete" : "completed", committed.version, ports.now().toISOString());
        await ports.writeAggregate(history!);
        await ports.appendSyncEvent({ event, record: await projectPersonalRunEvent(event) });
        await ports.syncOutputAndHistory({ snapshot: basis, history: history!, leaseId: leaseId! });
        return { changed: false as const, version: committed.version };
      };

      if (request.route.kind === "local_full" || request.route.kind === "local_transcription_only") {
        history.transcriptionExecutions = 1;
        await guard(ports, request, snapshot, leaseId, "before_dispatch");
        const source = await persistAndCas(snapshot, await ports.executeTranscription({ snapshot, leaseId }), "source", "source");
        if (source.changed) {
          history.state = "input_changed";
          await ports.writeAggregate(history);
          await ports.markIntent(request.intentId, history.state);
          return result(history);
        }
        if (request.route.kind === "local_transcription_only") {
          history.state = "transcription_complete";
          await ports.writeAggregate(history);
          await ports.syncOutputAndHistory({ snapshot, history, leaseId });
          await ports.markIntent(request.intentId, history.state);
          return result(history);
        }
        snapshot = await generationSnapshot(snapshot, source.version);
        activeSnapshot = snapshot;
      }

      const sourceVersion = snapshot.input.sourceVersion;
      if (!sourceVersion) throw new PersonalExecutionError("SOURCE_VERSION_REQUIRED", "確定原文が無いため後続工程を開始できません。");
      if (request.route.kind === "generation_only" && request.route.executor === "niho_api") {
        if (!material.sourceVersion?.synced) throw new PersonalExecutionError("SOURCE_NOT_SYNCED", "確定原文の同期が終わっていません。");
        if (sourceVersion.origin !== "this_pc") throw new PersonalExecutionError("SOURCE_ORIGIN_NOT_ALLOWED", "NIHO APIへ渡せるのは本人Macで確定した原文だけです。");
        const readiness = await ports.nihoApiReadiness({ snapshot });
        if (!readiness.ready) throw new PersonalExecutionError("NIHO_API_NOT_READY", readiness.reason ?? "NIHO APIの許可・同意・上限を確認できません。");
        await guard(ports, request, snapshot, leaseId, "before_dispatch");
        remoteDispatchStarted = true;
        const accepted = await ports.submitNihoContinuation({
          schemaVersion: 1,
          intentId: history.intentId,
          originDeviceId: history.originDeviceId,
          containerRef: snapshot.containerRef,
          recordingPageId: snapshot.recordingPageId,
          recordingId: snapshot.recordingId,
          continuationOfRunId: snapshot.continuationOfRunId!,
          consentVersion: snapshot.consentVersion,
          baseManifestRevision: snapshot.baseManifestRevision,
          selectedStepIds: [...snapshot.selectedStepIds],
          audio: [],
          sourceVersion,
          referencePages: snapshot.input.referencePages,
          priorSteps: snapshot.input.priorSteps,
          expectedCurrentArtifactShaByStep: { ...snapshot.input.expectedCurrentArtifactShaByStep },
          recordingMetadataSha256: snapshot.input.recordingMetadataSha256,
          flowSnapshotSha256: snapshot.flowSnapshotSha256,
          fixedModels: snapshot.fixedModels,
          snapshotSha256: snapshot.snapshotSha256,
        }).catch((error: unknown) => {
          if (error instanceof PersonalRemoteRejectionError || error instanceof PersonalDispatchError) throw error;
          throw new PersonalDispatchError(true, "NIHO APIの受付結果を確認できません。自動では送り直しません。");
        });
        try {
          safeId(accepted.runId, "remoteRunId");
          if (!REMOTE_STATES.has(accepted.state)) throw new PersonalExecutionError("INVALID_REMOTE_STATE", "NIHO APIから未対応の受付状態が返りました。");
        } catch {
          // 受付送信後なので、応答が壊れていても未受付とは断定せず同intentの再送を止める。
          throw new PersonalDispatchError(true, "NIHO APIへ送信しましたが、受付結果を確認できません。自動では送り直しません。");
        }
        history.remoteRunId = accepted.runId;
        history.remoteState = accepted.state;
        history.state = "submitted";
        const event = await makeEvent(history, snapshot, "remote", "submitted", null, ports.now().toISOString());
        await ports.writeAggregate(history);
        await ports.appendSyncEvent({ event, record: await projectPersonalRunEvent(event) });
        await ports.markIntent(request.intentId, history.state);
        return result(history, typeof accepted.reasonCode === "string" ? accepted.reasonCode : null);
      }

      for (const stepId of snapshot.selectedStepIds) {
        await guard(ports, request, snapshot, leaseId, "before_dispatch");
        const candidate = await ports.executeGenerationStep({ snapshot, stepId, sourceVersion, leaseId });
        const saved = await persistAndCas(snapshot, candidate, stepId, "artifact");
        if (saved.changed) {
          history.state = "input_changed";
          await ports.writeAggregate(history);
          await ports.markIntent(request.intentId, history.state);
          return result(history);
        }
        snapshot = await nextStepSnapshot(snapshot, stepId, saved.version);
        activeSnapshot = snapshot;
      }
      history.state = "completed";
      await ports.writeAggregate(history);
      await ports.syncOutputAndHistory({ snapshot, history, leaseId });
      await ports.markIntent(request.intentId, history.state);
      return result(history);
    } catch (error) {
      const state: PersonalRunState = error instanceof PersonalAuthenticationRequiredError
        ? "waiting_auth"
        : error instanceof PersonalDispatchError
          ? error.resultUnknown ? "result_unknown" : "failed"
          : remoteDispatchStarted ? "result_unknown" : error instanceof PersonalCancellationError ? "canceled" : "failed";
      if (history) {
        history.state = state;
        await ports.writeAggregate(history).catch(() => undefined);
        const at = ports.now().toISOString();
        const outcomeRecord = error instanceof PersonalAuthenticationRequiredError || error instanceof PersonalDispatchError || error instanceof PersonalCancellationError
          ? error.record
          : null;
        const outcomeCheckpoint = error instanceof PersonalAuthenticationRequiredError || error instanceof PersonalDispatchError || error instanceof PersonalCancellationError
          ? error.checkpoint
          : null;
        const event: PersonalRunEvent = {
          schemaVersion: 1,
          eventId: await eventIdFor(history, "execution", state, null, at),
          runId: history.runId,
          originDeviceId: history.originDeviceId,
          stepId: outcomeRecord?.stepId ?? "execution",
          stepName: outcomeRecord?.stepName ?? "実行",
          state,
          at,
          continuationOfRunId: history.continuationOfRunId,
          inputBasisSha256: activeSnapshot?.snapshotSha256 ?? history.basisSnapshotSha256,
          sourceVersion: history.sourceVersion,
          version: null,
          remoteRunId: history.remoteRunId,
          reasonCode: outcomeRecord?.reasonCode ?? (error instanceof PersonalExecutionError
            ? error.code
            : error instanceof PersonalAuthenticationRequiredError
              ? "not_authenticated"
              : error instanceof PersonalDispatchError
                ? error.resultUnknown ? "ResultUnknown" : "DispatchRejected"
                : error instanceof PersonalCancellationError ? "Canceled" : "ExecutionFailed"),
        };
        await ports.appendSyncEvent({ event, record: outcomeRecord ?? await projectPersonalRunEvent(event), checkpoint: outcomeCheckpoint }).catch(() => undefined);
      }
      if (intentReserved) await ports.markIntent(request.intentId, state).catch(() => undefined);
      throw error;
    } finally {
      try {
        if (leaseId !== null) {
          const released = await ports.releaseLease(request, leaseId);
          if (!released.released || released.leaseId !== leaseId) throw new PersonalExecutionError("LEASE_RELEASE_MISMATCH", "取得した実行権を正しく解放できませんでした。");
        }
      } finally {
        inFlight.delete(request.intentId);
      }
    }
  };
}
