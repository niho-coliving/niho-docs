import { importSampleUrl } from "../src/lib/sample-url";
import {
  countChars,
  DEFAULT_CAPABILITIES,
  ROOT_RECORDING_ID,
  SAMPLE_MAX_CHARS,
  SOURCE_STEP_ID,
  selectedSourceArtifactId,
  candidatesFor,
  projectPages,
  rootRecording,
  type ApiKeyAccount,
  type ApiKeyStatus,
  type About,
  type AudioInput,
  type ClaudeUpdateResult,
  type ContractProvider,
  type DeepgramFileResult,
  type DocsPageShareState,
  type Flow,
  type FlowSnapshot,
  type FlowSample,
  type PageEntry,
  type Project,
  type ProviderStatus,
  type ProviderUsage,
  type ResolvedStepModel,
  type Recording,
  type RecordingFile,
  type RunCheckpoint,
  type RunRecord,
  type SpeakerMode,
  type TurnEnvelope,
  type TurnEvent,
  type TurnRequest,
} from "@niho/docs-core";
import type {
  AudioInfo,
  AudioFilePath,
  AudioPartRequest,
  Bridge,
  DeepgramRequest,
  CommandError,
  DocsDriveConnection,
  DocsDriveExportRequest,
  DocsDriveExportResult,
  DocsDriveFolderExportPlan,
  DocsDriveFolderExportRequest,
  DocsDriveFolderExportStatus,
  FileTranscript,
  LoadedPages,
  LoadedProject,
  LoadedRecording,
  NewPage,
  PreparedAudioFile,
  MicStatus,
  ProjectEntry,
  ProjectId,
  RecordedAudio,
  RecordingEvent,
  RecentId,
  RecordingRef,
  SampleImport,
  SpeechEvent,
  RestartOutcome,
  SpeechStatus,
  UpdateStatus,
  PersonalCandidateInput,
  PersonalGuardResult,
  PersonalMaterial,
  PersonalOpenRequest,
  PersonalOperationInfo,
  PersonalPrivateKind,
  PersonalPublishInput,
  PersonalPublishResult,
  PersonalRecordInput,
  PersonalReserveResult,
  PersonalNihoAccess,
  PersonalNihoConfirmAction,
  PersonalNihoConfirmResult,
  PersonalNihoPendingList,
  PersonalNihoSubmitResult,
} from "../src/lib/bridge";
import {
  canonical,
  generationSnapshot,
  nextStepSnapshot,
  sha256Text,
  type PersonalFixedSnapshot,
  type PersonalGuardPhase,
  type PersonalRemoteState,
  type PersonalRunHistory,
  type PersonalRunState,
  type PersonalStoredCandidate,
  type PersonalVersionRef,
} from "../src/lib/personal-execution";
import { GEMINI_TRANSCRIPTION_EFFORT, GEMINI_TRANSCRIPTION_MODEL } from "../src/lib/runner";
import { defaultSettings, type AppSettings } from "../src/lib/settings";
import type { ProviderId } from "@niho/docs-core";
import {
  DOCS_ROOT_PROJECT_ID,
  type CloudAppliedEvent,
  type CloudProjectEvent,
  type CloudRemoteEvent,
  type CloudState,
  type ClosingPreview,
  type ClosingProgress,
  type PreparedClosing,
  type ConflictEntry,
  type ConflictSide,
  type DeletedProject,
  type ProjectSyncSnapshot,
  type RemoteProject,
  type ResolveChoice,
  type TombstoneChoice,
  type VaultProviderKind,
  type VaultUsage,
} from "../src/lib/cloud-types";

/** 登録した AI を変えた設定（サブスクリプション方式）。 */
export function settingsWithProviders(providers: ProviderId[], base: AppSettings = defaultSettings()): AppSettings {
  return { ...base, connections: { ...base.connections, subscription: { ...base.connections.subscription, providers } } };
}

/** モデルの方式を API キーにし、API キーの AI（と Deepgram）を登録した設定（サブスクリプションの表は base のまま）。 */
export function apiKeySettings(providers: ProviderId[], deepgram = false, base: AppSettings = defaultSettings()): AppSettings {
  return {
    ...base,
    connection: "apiKey",
    connections: { ...base.connections, apiKey: { ...base.connections.apiKey, providers } },
    transcription: { ...base.transcription, deepgram },
  };
}
import { DEFAULT_EXECUTION_PREFERENCES, hashText, nihoApiProvider, type ArtifactState, type ChatTurnRequest, type ConversationFile, type ExecutionPreferences } from "@niho/docs-core";
import type { ChatTurnResult, TurnResult } from "../src/lib/bridge";
import type { PcRunnerStatus } from "../src/lib/pc-runner";
import { loadRecordingView, type RecordingView } from "../src/lib/project-view";

/**
 * テスト用の Bridge（Tauri の代わりにメモリ上の案件フォルダを持つ。パスの代わりに id で引く）。
 * 今の形の案件（flowSnapshot を持つ）は StoredProject そのものが root の録音。ページの録音は recordings、文書の本文は docs。
 * 規則は Rust の store.rs と同じ（pages の初期化・saveProject が pages を保つ・root の判定・setRecordingText の条件・
 * 録音のページの削除〔実行中は断る・root は project.json の flowSnapshot・source・refs を外す〕）。
 */

/** 録音 1 つの中身（root は StoredProject、ほかは StoredRecording）。 */
export type StoredRecordingData = {
  transcript: string | null;
  /** 工程 id → 最新版。 */
  artifacts: Record<string, string>;
  /** 工程 id → 版の中身（1 から）。 */
  versions: Record<string, string[]>;
  runs: RunRecord[];
  checkpoints: Record<string, RunCheckpoint>;
};

/** recording.json は読んだまま（P1 の録音は speakers・language・refs を持たない）。 */
export type StoredRecording = StoredRecordingData & { recording: RecordingFile };

/** FakeBridge は pages.json/project.json を配列へ正規化して保持する。 */
type FakeProject = Omit<Project, "pages"> & { pages?: PageEntry[] };

export type StoredProject = StoredRecordingData & {
  project: FakeProject;
  /** 録音のページ（recordings/<id>/）。 */
  recordings: Record<string, StoredRecording>;
  /** 文書のページの本文（pages/<id>.md）。 */
  docs: Record<string, string>;
};

const NO_RECORDING = { code: "store_no_recording", message: "録音のページが見つかりません。" };
const NO_PAGE = { code: "store_no_page", message: "ページが見つかりません。" };
const TEXT_REFUSED = { code: "store_bad_page", message: "音声か文章が入った録音には、文章を貼れません。" };
/** secrets.rs の `REENTER` と同じ文。 */
export const LEGACY_KEY_REENTER_MESSAGE = "以前の版で保存した API キーを読めませんでした。設定 › 接続設定で API キーを入れ直してください。";

function emptyData(): StoredRecordingData {
  return { transcript: null, artifacts: {}, versions: {}, runs: [], checkpoints: {} };
}

/** 会話のファイルの置き場の鍵（root は案件の id。今までのテストと同じ）。 */
export function conversationKey(rec: RecordingRef): string {
  const location = rec.projectId ?? "_outside";
  return rec.recordingId === ROOT_RECORDING_ID ? location : `${location}/${rec.recordingId}`;
}

/** 録音の見え方を偽物から作る（画面と同じ loadRecordingView。参考の文書の本文も読む）。既定は root の録音。 */
export async function recordingView(bridge: Bridge, projectId: ProjectId, recordingId: string = ROOT_RECORDING_ID): Promise<RecordingView> {
  const loaded = await bridge.loadPages(projectId);
  const project = loaded.project ?? {
    version: 1 as const,
    id: "outside",
    name: "",
    createdAt: "",
    info: { terms: [], background: "" },
    pages: loaded.pages,
  };
  const entry: PageEntry = loaded.pages.find((page) => page.id === recordingId) ?? {
    id: recordingId,
    kind: "rec",
    title: "",
    createdAt: project.createdAt,
  };
  return loadRecordingView(bridge, projectId, project, entry);
}

/** root の録音の指し方。 */
export function rootRef(projectId: string): RecordingRef {
  return { projectId, recordingId: ROOT_RECORDING_ID };
}

export type TurnScript = (request: TurnRequest, call: number) => TurnEvent[];
/** Gemini の文字起こしの区切り 1 つの台本（`transcribe_audio_part`）。 */
export type AudioPartScript = (request: AudioPartRequest, call: number, at: { file: number; part: number }) => TurnEvent[];

/** 偽の CLI の状態（既定はどれも入っていてログイン済み）。 */
export function fakeStatus(provider: ContractProvider, fields: Partial<ProviderStatus> = {}): ProviderStatus {
  const base: Record<ContractProvider, ProviderStatus> = {
    ClaudeCode: {
      installed: true,
      authenticated: true,
      version: "2.1.267 (Claude Code)",
      cli_path: "/opt/homebrew/bin/claude",
      login_method: "Claude Max account",
      reason: null,
      missing_cli_flags: [],
      capabilities: { ...DEFAULT_CAPABILITIES },
      models: [],
    },
    CodexCli: {
      installed: true,
      authenticated: true,
      version: "codex-cli 0.154.0",
      cli_path: "/opt/homebrew/bin/codex",
      login_method: "ChatGPT",
      reason: null,
      missing_cli_flags: [],
      capabilities: { ...DEFAULT_CAPABILITIES },
      models: ["gpt-5.6-terra", "gpt-5.6-luna"],
    },
    GeminiCli: {
      installed: true,
      authenticated: true,
      version: "1.3.5",
      cli_path: "/opt/homebrew/bin/agy",
      login_method: null,
      reason: null,
      missing_cli_flags: [],
      capabilities: { ...DEFAULT_CAPABILITIES },
      models: ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "claude-sonnet-4-6", "gpt-oss-120b-medium"],
    },
    AnthropicApi: apiStatus(["claude-sonnet-4-6", "claude-opus-4-8"]),
    OpenAiApi: apiStatus(["gpt-5.6-terra", "gpt-5.6-luna"]),
    GeminiApi: apiStatus(["gemini-3.8-flash", "gemini-3.8-pro"]),
  };
  return { ...base[provider], ...fields };
}
function apiStatus(models: string[] = []): ProviderStatus {
  return {
    installed: true,
    authenticated: true,
    version: null,
    cli_path: null,
    login_method: "API キー",
    reason: null,
    missing_cli_flags: [],
    capabilities: { ...DEFAULT_CAPABILITIES },
    models,
  };
}

/** 偽の鍵の確かめ（鍵の文字列 → 結果。無ければ「正しい鍵」）。 */
export type KeyCheckScript = (account: ApiKeyAccount, key: string) => { ok: true; models: string[] } | { ok: false; code: string; message: string };

/**
 * 修正の会話の台本（`run_chat_turn`）。隔離 workspace の代わりにコピーした録音の `artifacts` を書き換える。
 * 返したイベントと差分を呼び出し側へ返す。
 */
/**
 * 修正の会話の作業場所（本物の conversation.rs の隔離 workspace と同じ中身）。スクリプトは artifacts（工程の文書）・
 * pages（composer の文書ページ）・created（composer の artifacts/new/ のファイル名 → 本文）を書き換えて AI の作業を表す。
 */
export type StagedChat = StoredRecordingData & { pages: Record<string, string>; created: Record<string, string> };

export type ChatScript = (request: ChatTurnRequest, call: number, stored: StagedChat) => TurnEvent[];

/** flows/index.json（並びと最後に使ったフロー）。 */
export type FakeFlowIndex = { version: 1; order: string[]; lastUsed: string | null };

export class FakeBridge implements Bridge {
  importSampleUrl(flowId: string, url: string) { return importSampleUrl(this, flowId, url); }
  audioSourceUrl(path: string) { return `asset://localhost/${encodeURIComponent(path)}`; }
  pageShares = new Map<string, DocsPageShareState>();
  pageShareCalls: Array<{ action: string; pageId: string; projectId: string; textId: string | null }> = [];
  /** サーバーが NIHO アカウントの接続を受け付けるか（本番で APP_CONNECT_ENABLED=false なら false）。 */
  accountOpen = true;
  docsDrive: DocsDriveConnection = { status: "DISCONNECTED", connectedEmail: null, reason: null };
  docsDriveConnectionCalls = 0;
  docsDriveConnectCalls = 0;
  docsDriveDisconnectCalls = 0;
  docsDriveExportRequests: DocsDriveExportRequest[] = [];
  docsDriveStatusIds: string[] = [];
  docsDriveOpenedIds: string[] = [];
  docsDriveExportResults: Array<DocsDriveExportResult | { code: string; message: string }> = [];
  docsDriveStatusResults: Array<DocsDriveExportResult | { code: string; message: string }> = [];
  /** フォルダの書き出しの木（フォルダの id ごと。無ければ `folder_not_found`）。 */
  folderExportPlans = new Map<string, DocsDriveFolderExportPlan>();
  folderExportPlanCalls: string[] = [];
  folderExportLocalPlanCalls: string[] = [];
  folderExportLocalFiles: Array<{ generation: number; paths: string[] }> = [];
  folderExportRequests: DocsDriveFolderExportRequest[] = [];
  folderExportStatusIds: string[] = [];
  folderExportResumeIds: string[] = [];
  /** 次の呼び出しの結果（順に。code を持つものは投げる）。空なら既定（木は folderExportPlans・受付は作成中・照会は完了・続きは作成中）。 */
  folderExportPlanResults: Array<DocsDriveFolderExportPlan | CommandError> = [];
  folderExportResults: Array<DocsDriveFolderExportStatus | CommandError> = [];
  folderExportStatusResults: Array<DocsDriveFolderExportStatus | CommandError> = [];
  folderExportResumeResults: Array<DocsDriveFolderExportStatus | CommandError> = [];
  closingOtherMacs: ClosingPreview["preflight"]["otherMacs"] = [];
  settings: unknown = null;
  /**
   * 工程（フロー）の保存（Rust の store_flows.rs と同じ規則）: flows/<id>.json は flowFiles、flows/index.json は flowIndex
   * （無ければ null）、P4 より前の flows/active.json は activeFlow（index が無いときだけ 1 本目として読み、最初の書き込みで
   * flowFiles と flowIndex に移して消す）。
   */
  activeFlow: Flow | null = null;
  flowFiles = new Map<string, Flow>();
  flowIndex: FakeFlowIndex | null = null;
  /**
   * テストの読みやすさのため: 今のフロー（1 本だけのときの書き方。index があれば最後に使ったフローか並びの先頭、無ければ
   * active.json）。代入は P4 より前の active.json を置く（今ある利用者と同じ形から始まる）。
   */
  get flow(): Flow | null {
    const state = this.flowState();
    const id = state.lastUsed ?? state.order[0];
    return id ? (state.flows.get(id) ?? null) : null;
  }
  set flow(flow: Flow | null) {
    this.activeFlow = flow ? structuredClone(flow) : null;
  }
  projects = new Map<string, StoredProject>();
  projectOrder: string[] = [];
  recent: RecentId[] = [];
  recentCorrupt = false;
  recentTouchGate: Promise<void> | null = null;
  outside: StoredProject = {
    project: { version: 1, id: "outside", name: "", createdAt: "", info: { terms: [], background: "" }, pages: [] },
    ...emptyData(),
    recordings: {},
    docs: {},
  };
  locks = new Set<ProjectId>();
  turnRequests: TurnRequest[] = [];
  stoppedTurns: string[] = [];
  stopTurnResults: boolean[] = [];
  turnGate: Promise<void> | null = null;
  onTurnStarted: (() => void) | null = null;
  turnScript: TurnScript = () => [];
  /** 終端イベントを command の戻りの後に Channel へ届ける（Tauri の Channel の大きいメッセージ）。 */
  lateTerminal = false;
  /** 修正の会話の依頼（順に）と台本。 */
  chatRequests: Array<{ projectId: ProjectId; recordingId: string; request: ChatTurnRequest }> = [];
  chatScript: ChatScript = () => [];
  /** 修正の会話の最初のイベントの後で待つ（止める・途中の画面を見るテスト用）。 */
  chatGate: Promise<void> | null = null;
  /** 修正の会話の最初のイベントを流した後に呼ぶ（依頼の最中に人が保存する、など）。 */
  onChatStarted: ((stored: StoredRecordingData) => void | Promise<void>) | null = null;
  /** 録音（conversationKey。root は案件 id）→ 会話（conversations/<id>.json の代わり）。 */
  conversationFiles = new Map<string, Map<string, ConversationFile>>();
  /** 文書のページの本文を書いた呼び出し（順に）。 */
  pageWrites: Array<{ projectId: ProjectId; pageId: string; markdown: string }> = [];
  private openedDocuments = new Map<
    string,
    {
      contextGeneration: number;
      scopeId: string;
      protectionId: number;
      expected: string | null;
      kind:
        | { type: "page"; projectId: ProjectId; pageId: string }
        | { type: "artifact"; rec: RecordingRef; stepId: string; source: boolean };
    }
  >();
  private nextOpenedDocument = 1;
  pickedImage: string | null = null;
  images = new Map<string, string>();
  /** 文書のページの本文を書いた時刻（`${projectId}/${pageId}` → ms）。 */
  private docUpdated = new Map<string, number>();
  private documentChatData = new Map<string, StoredRecordingData>();
  transcribeResult: FileTranscript[] | { code: string; message: string } = [];
  transcribeSpeakerModes: SpeakerMode[] = [];
  /** この Mac の文字起こしに渡した言語（順に）。 */
  transcribeLanguages: string[] = [];
  speechEvents: SpeechEvent[] = [];
  transcribeGate: Promise<void> | null = null;
  onTranscribeStarted: (() => void) | null = null;
  copied: string[] = [];
  /** 写した音声の長さ（秒）。 */
  audioDurationSec = 60;
  /** CLI ごとの状態（provider_status が返すもの）。 */
  statuses: Record<ContractProvider, ProviderStatus> = {
    ClaudeCode: fakeStatus("ClaudeCode"),
    CodexCli: fakeStatus("CodexCli"),
    GeminiCli: fakeStatus("GeminiCli"),
    AnthropicApi: fakeStatus("AnthropicApi"),
    OpenAiApi: fakeStatus("OpenAiApi"),
    GeminiApi: fakeStatus("GeminiApi"),
  };
  /**
   * 鍵の保存先（app data の api-keys/）の代わり（account → 鍵）。画面へは返さない（`apiKeyStatus` は末尾 4 文字だけ）。テストは
   * 画面が保存したファイルに鍵が無いことをここの値で確かめる。
   */
  keychain = new Map<ApiKeyAccount, string>();
  /** 以前の版が Keychain に置いた鍵を移せなかった account（#18769）。保存・削除するまで入れ直しの案内を返す。 */
  keyReenter = new Set<ApiKeyAccount>();
  /** 鍵の確かめの台本（既定は「正しい鍵」でモデルの一覧は空）。 */
  keyCheck: KeyCheckScript = () => ({ ok: true, models: [] });
  /** 鍵の操作の呼び出し（順に。鍵は記録しない）。 */
  keyCalls: string[] = [];
  /** Deepgram の依頼と結果（無ければ 60 秒の音声の 1 発話）。 */
  deepgramRequests: Array<{ jobId: string; projectId: ProjectId; request: DeepgramRequest }> = [];
  deepgramResult: DeepgramFileResult[] | { code: string; message: string } | null = null;
  /** Claude Code の状態（S1 のテストの書き方）。 */
  get claude(): ProviderStatus {
    return this.statuses.ClaudeCode;
  }
  set claude(status: ProviderStatus) {
    this.statuses.ClaudeCode = status;
  }
  /** provider_status を呼んだ順。 */
  statusCalls: ContractProvider[] = [];
  /** provider_usage の結果（無ければ取得できない）。 */
  usage: Partial<Record<ContractProvider, ProviderUsage>> = {};
  /** Gemini の文字起こしの準備の結果（失敗も）。 */
  preparedAudio: PreparedAudioFile[] | { code: string; message: string } = [
    { durationSec: 95, parts: [{ startSec: 0, endSec: 48, soundSec: 42 }, { startSec: 48, endSec: 95, soundSec: 40 }] },
  ];
  audioPartRequests: Array<{ turnId: string; jobId: string; file: number; part: number; request: AudioPartRequest }> = [];
  audioPartScript: AudioPartScript = () => [];
  /** 区切りの最初のイベントの後で待つ（止める・途中の画面を見るテスト用）。 */
  audioPartGate: Promise<void> | null = null;
  releasedAudio: string[] = [];
  /** ログイン・導入・更新の呼び出し（順に）。 */
  maintenance: string[] = [];
  /** ログイン・導入・更新の失敗（あれば投げる）。 */
  maintenanceError: { code: string; message: string } | null = null;
  appPathsFailures = 0;
  pickedDocsRoot: string | null = null;
  docsRootOverride: string | null = null;
  /** 保存先ごとの about.json（保存先 → 内容。無い保存先は null を返す）。 */
  aboutFiles = new Map<string, About>();
  /** saveAbout で受けた内容（呼んだ順）。 */
  aboutSaves: About[] = [];
  /** 入れると saveAbout が失敗する。 */
  aboutSaveFailure: { code: string; message: string } | null = null;
  execution: ExecutionPreferences = { ...DEFAULT_EXECUTION_PREFERENCES };
  executionSaves: ExecutionPreferences[] = [];
  private acceptedStops = new Set<string>();
  /** お手本の文書の元のファイル（パス → 本文か失敗）。無いパスは sample_missing。 */
  sampleSources: Record<string, string | { code: string; message: string }> = {};
  sampleUrlSources: Record<string, { title: string; text: string } | { code: string; message: string }> = {};
  sampleUrlRequests: string[] = [];
  /** pickSampleFiles が返すパス。 */
  pickedSamples: string[] = [];
  /** 取り込んだお手本の本文（`${flowId}/${sampleId}` → 本文）。 */
  samples = new Map<string, string>();
  /** pruneSamples に渡った keep。 */
  prunedWith: string[][] = [];
  private nextId = 1;

  /** 名前で案件を探す（テストの読みやすさのため）。 */
  byName(name: string): StoredProject {
    const found = [...this.projects.values()].find((stored) => stored.project.name === name);
    if (!found) throw new Error(`project not found: ${name}`);
    return found;
  }

  async appPaths() {
    if (this.appPathsFailures > 0) {
      this.appPathsFailures--;
      throw { code: "path_unavailable", message: "保存先を読めませんでした。" };
    }
    return { docsRoot: this.docsRootOverride ?? "/Users/test/Documents/NIHO docs", dataDir: "/Users/test/Library/Application Support/life.niho.docs" };
  }
  async loadSettings() {
    return this.settings;
  }
  async saveSettings(settings: AppSettings) {
    this.settings = settings;
    this.docsRootOverride = settings.docsRoot || null;
  }
  /** 今のフローの状態（Rust の flow_state と同じ: index の並び → 並びに無いファイルを id の順。index が無ければ active.json）。 */
  private flowState(): { flows: Map<string, Flow>; order: string[]; lastUsed: string | null; legacy: string | null } {
    const flows = new Map(this.flowFiles);
    let listed: string[] = [];
    let lastUsed: string | null = null;
    let legacy: string | null = null;
    if (this.flowIndex) {
      listed = this.flowIndex.order;
      lastUsed = this.flowIndex.lastUsed;
    } else if (this.activeFlow) {
      legacy = this.activeFlow.id;
      flows.set(legacy, this.activeFlow);
      listed = [legacy];
      lastUsed = legacy;
    }
    const order: string[] = [];
    for (const id of [...listed, ...[...flows.keys()].sort()]) {
      if (flows.has(id) && !order.includes(id)) order.push(id);
    }
    return { flows, order, lastUsed: lastUsed !== null && order.includes(lastUsed) ? lastUsed : null, legacy };
  }
  /** 書き込みの前に active.json を移す（flows/<id>.json と index を書いてから active.json を消す）。 */
  private flowStateForWrite() {
    const state = this.flowState();
    if (state.legacy) {
      this.flowFiles.set(state.legacy, structuredClone(state.flows.get(state.legacy)!));
      this.flowIndex = { version: 1, order: [...state.order], lastUsed: state.lastUsed };
      this.activeFlow = null;
    }
    return state;
  }
  private writeFlowIndex(order: string[], lastUsed: string | null) {
    this.flowIndex = { version: 1, order: [...order], lastUsed };
  }
  /** フローの書き込みの呼び出し（順に。`save:<id>` など）。 */
  flowWrites: string[] = [];
  async listFlows() {
    const state = this.flowState();
    return { flows: state.order.map((id) => structuredClone(state.flows.get(id)!)), order: state.order, lastUsed: state.lastUsed };
  }
  async saveFlow(flow: Flow) {
    const state = this.flowStateForWrite();
    this.flowWrites.push(`save:${flow.id}`);
    this.flowFiles.set(flow.id, structuredClone(flow));
    let lastUsed = state.lastUsed;
    const order = [...state.order];
    if (!order.includes(flow.id)) {
      if (lastUsed === null) lastUsed = flow.id;
      order.push(flow.id);
    }
    this.writeFlowIndex(order, lastUsed);
  }
  async duplicateFlow(sourceId: string, flow: Flow) {
    const state = this.flowState();
    if (!state.flows.has(sourceId)) throw { code: "store_no_flow", message: "工程が見つかりません。" };
    if (state.flows.has(flow.id)) throw { code: "store_bad_id", message: "工程を複製できませんでした。もう一度お試しください。" };
    this.flowStateForWrite();
    this.flowWrites.push(`duplicate:${sourceId}:${flow.id}`);
    for (const sample of flow.samples) {
      const text = this.samples.get(`${sourceId}/${sample.id}`);
      if (text !== undefined) this.samples.set(`${flow.id}/${sample.id}`, text);
    }
    this.flowFiles.set(flow.id, structuredClone(flow));
    const order = [...state.order];
    const at = order.indexOf(sourceId);
    order.splice(at < 0 ? order.length : at + 1, 0, flow.id);
    this.writeFlowIndex(order, state.lastUsed);
  }
  async deleteFlow(flowId: string) {
    const state = this.flowState();
    if (!state.flows.has(flowId)) throw { code: "store_no_flow", message: "工程が見つかりません。" };
    this.flowStateForWrite();
    this.flowWrites.push(`delete:${flowId}`);
    this.flowFiles.delete(flowId);
    const order = state.order.filter((id) => id !== flowId);
    this.writeFlowIndex(order, state.lastUsed === flowId ? (order[0] ?? null) : state.lastUsed);
    for (const key of [...this.samples.keys()]) if (key.startsWith(`${flowId}/`)) this.samples.delete(key);
  }
  async setLastUsedFlow(flowId: string) {
    const state = this.flowState();
    if (!state.flows.has(flowId)) throw { code: "store_no_flow", message: "工程が見つかりません。" };
    this.flowStateForWrite();
    this.flowWrites.push(`lastUsed:${flowId}`);
    this.writeFlowIndex(state.order, flowId);
  }
  async flowUsage(flowId: string) {
    let count = 0;
    for (const recording of Object.values(this.outside.recordings)) if (recording.recording.flowSnapshot.id === flowId) count++;
    for (const stored of this.projects.values()) {
      if (stored.project.flowSnapshot?.id === flowId) count++;
      for (const recording of Object.values(stored.recordings)) if (recording.recording.flowSnapshot.id === flowId) count++;
    }
    return count;
  }
  private get aboutRoot() {
    return this.docsRootOverride ?? "/Users/test/Documents/NIHO docs";
  }
  /** いまの保存先に about.json を置く（アプリを開く前に呼ぶ）。 */
  presetAbout(about: About) {
    this.aboutFiles.set(this.aboutRoot, { ...about });
  }
  async loadAbout() {
    const stored = this.aboutFiles.get(this.aboutRoot);
    return stored ? { ...stored } : null;
  }
  async saveAbout(about: About) {
    if (this.aboutSaveFailure) throw { ...this.aboutSaveFailure };
    // Rust の store.rs と同じく、本文が 2,000 字を超えれば断る
    if (countChars(about.text) > 2000) throw { code: "store_bad_about", message: "「パーソナライズ」は 2,000 字までにしてください。" };
    this.aboutSaves.push({ ...about });
    this.aboutFiles.set(this.aboutRoot, { name: about.name, text: about.text });
  }
  async loadExecution() {
    return { ...this.execution };
  }
  async saveExecution(execution: ExecutionPreferences) {
    this.execution = { ...execution };
    this.executionSaves.push({ ...execution });
  }
  async pickSampleFiles() {
    return [...this.pickedSamples];
  }
  async importSamples(flowId: string, paths: string[]): Promise<SampleImport[]> {
    return paths.map((path) => {
      const name = path.split("/").pop() ?? path;
      const source = this.sampleSources[path];
      if (source === undefined) return { name, sample: null, error: { code: "sample_missing", message: "ファイルが見つかりません。" } };
      if (typeof source !== "string") return { name, sample: null, error: { ...source } };
      const chars = countChars(source);
      const text = chars > SAMPLE_MAX_CHARS ? Array.from(source).slice(0, SAMPLE_MAX_CHARS).join("") : source;
      const id = `s${this.nextId++}`;
      this.samples.set(`${flowId}/${id}`, text);
      const sample: FlowSample = { id, name, chars: countChars(text) };
      if (chars > SAMPLE_MAX_CHARS) sample.truncatedFrom = chars;
      return { name, sample, error: null };
    });
  }
  async fetchSampleUrl(url: string, _sameOriginRedirectOnly: string | null, _timeoutMs: number) {
    this.sampleUrlRequests.push(url);
    const source = this.sampleUrlSources[url];
    if (!source) throw { code: "sample_url_fetch", message: "記事を取得できませんでした。URL を確かめて、もう一度お試しください。" };
    if ("code" in source) throw source;
    const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = `<html><title>${escaped(source.title)}</title><body><article>${source.text.split("\n\n").map((p) => `<p>${escaped(p)}</p>`).join("")}</article></body></html>`;
    return { url, body: Array.from(new TextEncoder().encode(html)), contentType: "text/html" };
  }
  async saveSampleUrl(flowId: string, url: string, name: string, text: string): Promise<FlowSample> {
    const id = `s${this.nextId++}`;
    const chars = countChars(text);
    const saved = Array.from(text).slice(0, SAMPLE_MAX_CHARS).join("");
    this.samples.set(`${flowId}/${id}`, saved);
    return { id, name, chars: countChars(saved), sourceUrl: url, ...(chars > SAMPLE_MAX_CHARS ? { truncatedFrom: chars } : {}) };
  }
  async readSample(flowId: string, sampleId: string) {
    const text = this.samples.get(`${flowId}/${sampleId}`);
    if (text === undefined) {
      throw { code: "store_no_sample", message: "お手本の文書の本文が見つかりません。⋯ から削除して、入れ直してください。" };
    }
    return text;
  }
  async pruneSamples(flowId: string, keep: string[]) {
    this.prunedWith.push([...keep]);
    for (const key of [...this.samples.keys()]) {
      const [flow, id = ""] = key.split("/");
      if (flow === flowId && !keep.includes(id)) this.samples.delete(key);
    }
  }
  async listProjects(): Promise<ProjectEntry[]> {
    const ids = [...this.projectOrder.filter((id) => this.projects.has(id)), ...[...this.projects.keys()].filter((id) => !this.projectOrder.includes(id))];
    return ids.map((id) => ({
      id,
      project: structuredClone(this.projects.get(id)!.project),
      hasTranscript: this.projects.get(id)!.transcript !== null,
      artifacts: Object.keys(this.projects.get(id)!.artifacts),
      updatedMs: 0,
    }));
  }
  async saveProjectOrder(order: string[]) {
    this.projectOrder = [...new Set(order.filter((id) => this.projects.has(id)))];
    for (const id of this.projects.keys()) if (!this.projectOrder.includes(id)) this.projectOrder.push(id);
    return [...this.projectOrder];
  }
  async reorderProject(projectId: string, beforeProjectId: string | null) {
    if (!this.projects.has(projectId)) throw { code: "store_no_project", message: "フォルダが見つかりません。" };
    if (beforeProjectId !== null && !this.projects.has(beforeProjectId)) {
      throw { code: "store_stale_target", message: "移動先が変わりました。もう一度お試しください。" };
    }
    const order = this.projectOrder.filter((id) => id !== projectId && this.projects.has(id));
    const index = beforeProjectId === null ? order.length : order.indexOf(beforeProjectId);
    order.splice(index, 0, projectId);
    this.projectOrder = order;
    return [...order];
  }
  async deleteEmptyFolder(projectId: string) {
    const stored = this.require(projectId);
    const info = stored.project.info;
    const hasAssets = [...this.images.keys()].some((key) => key.startsWith(`${projectId}/`));
    if (this.pagesOf(stored).length > 0 || info.background.trim() || info.terms.length > 0 || (info.entities?.length ?? 0) > 0 ||
      Object.keys(stored.docs).length > 0 || Object.keys(stored.recordings).length > 0 || hasAssets) {
      throw { code: "store_folder_not_empty", message: "ページまたは背景情報が残っているため削除できません。" };
    }
    if (this.locks.has(projectId)) throw { code: "store_busy", message: "処理中のためフォルダを削除できません。" };
    this.projects.delete(projectId);
    this.projectOrder = this.projectOrder.filter((id) => id !== projectId);
  }
  async loadRecent() {
    if (this.recentCorrupt) throw { code: "store_bad_json", message: "最近開いたページの形式が正しくありません。" };
    return this.recent.filter((item) => {
      try { return this.pagesOf(this.require(item.projectId)).some((page) => page.id === item.pageId); }
      catch { return false; }
    }).map((item) => ({ ...item }));
  }
  async touchRecent(item: RecentId) {
    if (this.recentTouchGate) await this.recentTouchGate;
    if (this.recentCorrupt) {
      this.recentCorrupt = false;
      this.recent = [];
    }
    if (!this.pagesOf(this.require(item.projectId)).some((page) => page.id === item.pageId)) throw NO_PAGE;
    this.recent = [{ ...item }, ...this.recent.filter((old) => old.projectId !== item.projectId || old.pageId !== item.pageId)].slice(0, 30);
    return this.recent.map((entry) => ({ ...entry }));
  }
  private loadedPages(projectId: ProjectId): LoadedPages {
    const stored = this.require(projectId);
    const pages = this.pagesOf(stored);
    return {
      projectId,
      project: projectId === null ? null : structuredClone(stored.project),
      pages: structuredClone(pages),
      recordings: pages
        .filter((page) => page.kind === "rec")
        .flatMap((page) => {
          const recordingId = page.recordingId ?? page.id;
          const data = this.recordingData(stored, recordingId);
          if (!data) return [];
          const recording = recordingId === ROOT_RECORDING_ID ? null : structuredClone(stored.recordings[recordingId]!.recording);
          return [{ id: recordingId, recording, hasTranscript: data.transcript !== null, artifacts: Object.keys(data.artifacts) }];
        }),
      docs: pages
        .filter((page) => page.kind === "doc")
        .map((page) => ({ id: page.id, updatedMs: this.docUpdated.get(`${projectId ?? "_outside"}/${page.id}`) ?? 0 })),
    };
  }
  async loadPages(projectId: ProjectId): Promise<LoadedPages> {
    return this.loadedPages(projectId);
  }
  private audioOf(paths: string[], names: string[] = []): AudioInput[] {
    return paths.map((path, index) => ({
      file: `a${this.nextId++}.m4a`,
      hash: "0".repeat(64),
      name: names[index]?.trim() || path.split("/").pop() || path,
      durationSec: this.audioDurationSec,
    }));
  }
  async createProject(project: Project, text: string | null, textRecord: RunRecord | null, audio: string[], names: string[] = []) {
    const id = `p${this.nextId++}`;
    const created: FakeProject = { ...structuredClone(project), id, pages: project.pages ? projectPages(project) : undefined };
    this.copiedAudio.push(...audio);
    if (audio.length > 0) created.source = { kind: "audio", audio: this.audioOf(audio, names) };
    const stored: StoredProject = { project: created, ...emptyData(), recordings: {}, docs: {} };
    this.projects.set(id, stored);
    this.projectOrder.push(id);
    if (text !== null && textRecord) this.write(stored, "source", true, text, textRecord);
    return structuredClone(created);
  }
  /** importAudio の keep（同じ編集で残す音声の file）。 */
  importKeeps: string[][] = [];
  copiedAudio: string[] = [];
  async importAudio(rec: RecordingRef, paths: string[], keep: string[], names: string[] = []) {
    this.requireRec(rec);
    this.importKeeps.push([...keep]);
    this.copiedAudio.push(...paths);
    const imported = this.audioOf(paths, names);
    return imported.map((item, index) => {
      const recorded = this.leftovers.find((left) => left.path === paths[index]);
      return recorded ? { ...item, durationSec: recorded.durationSec } : item;
    });
  }
  async loadProject(projectId: string): Promise<LoadedProject> {
    const loaded = this.loadedPages(projectId);
    return { id: projectId, project: loaded.project!, recordings: loaded.recordings, docs: loaded.docs };
  }
  async loadRecording(rec: RecordingRef): Promise<LoadedRecording> {
    const stored = this.require(rec.projectId);
    const data = this.requireRec(rec);
    return {
      projectId: rec.projectId,
      id: rec.recordingId,
      recording: rec.recordingId === ROOT_RECORDING_ID ? null : structuredClone(stored.recordings[rec.recordingId]!.recording),
      transcript: data.transcript,
      artifacts: { ...data.artifacts },
      runs: data.runs.map((run) => ({ ...run })),
      unversioned: this.unversionedOf(rec, data),
      missingInputs: this.missingOf(rec),
    };
  }
  /** ページの一覧はディスクのもの（pages の command だけが変える）を保つ。 */
  async saveProject(projectId: string, project: Project) {
    const stored = this.require(projectId);
    if (project.id !== projectId) throw { code: "store_bad_json", message: "案件の id が食い違っています。" };
    const next: FakeProject = { ...structuredClone(project), pages: stored.project.pages ? [...stored.project.pages] : undefined };
    if (stored.project.pages) next.pages = stored.project.pages;
    else delete next.pages;
    if (stored.project.candidateSets) next.candidateSets = structuredClone(stored.project.candidateSets);
    else delete next.candidateSets;
    stored.project = next;
  }
  async saveRecording(rec: RecordingRef, recording: Recording) {
    if (rec.recordingId === ROOT_RECORDING_ID) throw { code: "store_bad_page", message: "この録音は案件といっしょに保存してください。" };
    const stored = this.require(rec.projectId);
    const found = stored.recordings[rec.recordingId];
    if (!found) throw NO_RECORDING;
    if (recording.id !== rec.recordingId) throw { code: "store_bad_json", message: "録音の id が食い違っています。" };
    const next = structuredClone(recording);
    if (found.recording.candidateSets) next.candidateSets = structuredClone(found.recording.candidateSets);
    else delete next.candidateSets;
    // 後工程に使う文字起こしの指定も専用の command だけが変える（Rust の save_recording と同じ）
    if (found.recording.sourceCandidateId) next.sourceCandidateId = found.recording.sourceCandidateId;
    else delete next.sourceCandidateId;
    found.recording = next;
  }
  async createCandidate(rec: RecordingRef, stepId: string, candidateSet: import("@niho/docs-core").CandidateSet, newArtifactId: string, duplicateMarkdown: string | null, record: RunRecord | null) {
    const data = this.requireRec(rec);
    const owner = rec.recordingId === ROOT_RECORDING_ID ? this.require(rec.projectId).project : this.require(rec.projectId).recordings[rec.recordingId]!.recording;
    const disk = owner.candidateSets?.[stepId];
    const incoming = structuredClone(candidateSet);
    const added = Object.values(incoming.items).find((item) => item.artifactId === newArtifactId);
    if (!added) throw { code: "store_bad_json", message: "追加する案が台帳にありません。" };
    const next = disk
      ? { ...structuredClone(disk), order: [...disk.order, added.id], items: { ...structuredClone(disk.items), [added.id]: added } }
      : incoming;
    if (duplicateMarkdown !== null) {
      if (!record) throw { code: "store_bad_json", message: "複製の記録がありません。" };
      this.write(data, newArtifactId, false, duplicateMarkdown, record);
    }
    owner.candidateSets = { ...(owner.candidateSets ?? {}), [stepId]: next };
  }
  /** 呼ばれた順の setSourceCandidate（テストが確かめる）。 */
  sourceCandidateCalls: Array<{ rec: RecordingRef; candidateId: string; expected: string | null }> = [];
  async setSourceCandidate(rec: RecordingRef, candidateId: string, expected: string | null) {
    this.sourceCandidateCalls.push({ rec: structuredClone(rec), candidateId, expected });
    const owner = rec.recordingId === ROOT_RECORDING_ID ? this.require(rec.projectId).project : this.require(rec.projectId).recordings[rec.recordingId]!.recording;
    if ((owner.sourceCandidateId ?? null) !== expected) {
      throw { code: "store_conflict", message: "後工程に使う文字起こしが、ほかの画面で変わりました。開き直してから選んでください。" };
    }
    if (!owner.candidateSets?.[SOURCE_STEP_ID]?.items[candidateId]) throw { code: "store_bad_page", message: "後工程に使う文字起こしが見つかりません。" };
    owner.sourceCandidateId = candidateId;
  }
  async renameCandidate(rec: RecordingRef, stepId: string, candidateId: string, name: string) {
    const owner = rec.recordingId === ROOT_RECORDING_ID ? this.require(rec.projectId).project : this.require(rec.projectId).recordings[rec.recordingId]!.recording;
    const candidate = owner.candidateSets?.[stepId]?.items[candidateId];
    if (!candidate) throw { code: "store_bad_page", message: "案が見つかりません。" };
    candidate.name = name.trim();
  }
  async setRecordingText(rec: RecordingRef, text: string, record: RunRecord) {
    if (rec.recordingId === ROOT_RECORDING_ID) throw TEXT_REFUSED;
    if (!text.trim()) throw { code: "store_bad_page", message: "文章を入れてください。" };
    const found = this.require(rec.projectId).recordings[rec.recordingId];
    if (!found) throw NO_RECORDING;
    const source = found.recording.source;
    if (source.kind !== "audio" || source.audio.length > 0 || found.transcript !== null) throw TEXT_REFUSED;
    this.write(found, "source", true, text, record);
    found.recording = { ...found.recording, source: { kind: "text" } };
  }
  /** pages（無ければ root を先頭に初期化した並び）。 */
  private pagesOf(stored: StoredProject): PageEntry[] {
    return [...projectPages(stored.project)];
  }
  /**
   * 1 フォルダに録音は 1 つ（Rust の create_page_at と同じ。#18914）。以前のデータ（1 フォルダに録音が 2 つ以上）の読み方を確かめる
   * ライブラリのテストだけが、置く間 false にする。
   */
  oneRecordingPerFolder = true;
  async createPage(projectId: ProjectId, page: NewPage): Promise<PageEntry> {
    const stored = this.require(projectId);
    if (page.kind !== "doc" && page.kind !== "rec") throw { code: "store_bad_page", message: "ページの種類が正しくありません。" };
    // Rust の create_page_at と同じく、フォルダの音声は 1 セット（#18914。ホームは今のまま）
    if (page.kind === "rec" && projectId !== null && this.oneRecordingPerFolder && this.pagesOf(stored).some((candidate) => candidate.kind === "rec")) {
      throw { code: "store_folder_has_recording", message: "このフォルダにはもう音声があります。背景情報のページで音声を追加してください。" };
    }
    const id = `${page.kind}${this.nextId++}`;
    const entry: PageEntry = { id, kind: page.kind, title: page.title, createdAt: page.createdAt };
    if (page.kind === "doc") {
      // Rust は空の本文のファイルを作る（更新時刻はそのとき）
      stored.docs[id] = "";
      this.docUpdated.set(`${projectId ?? "_outside"}/${id}`, Date.now());
    } else {
      if (!page.recording) throw { code: "store_bad_json", message: "録音の形が正しくありません。" };
      stored.recordings[id] = { recording: { ...structuredClone(page.recording), id }, ...emptyData() };
    }
    const pages = this.pagesOf(stored);
    if (page.afterPageId) {
      // Rust の create_document_after_at と同じく、録音・文書どちらのページの直後にも作れる（実行ロックは見ない）
      const index = pages.findIndex((candidate) => candidate.id === page.afterPageId);
      if (index < 0 || page.kind !== "doc") throw NO_PAGE;
      pages.splice(index + 1, 0, entry);
    } else if (page.kind === "rec" && projectId !== null && this.oneRecordingPerFolder) {
      // Rust の create_page_at と同じく、フォルダの録音は先頭（背景情報 › 工程のページ › 自分のページ。#18914）
      pages.unshift(entry);
    } else pages.push(entry);
    stored.project = { ...stored.project, pages };
    return { ...entry };
  }
  async renamePage(projectId: ProjectId, pageId: string, title: string) {
    const stored = this.require(projectId);
    if (!stored.project.pages && pageId !== ROOT_RECORDING_ID) throw NO_PAGE;
    const pages = this.pagesOf(stored);
    if (!pages.some((page) => page.id === pageId)) throw NO_PAGE;
    stored.project = { ...stored.project, pages: pages.map((page) => (page.id === pageId ? { ...page, title } : page)) };
  }
  /** 消したページ（順に）。 */
  deletedPages: Array<{ projectId: ProjectId; pageId: string }> = [];
  async deletePage(projectId: ProjectId, pageId: string) {
    const stored = this.require(projectId);
    const pages = this.pagesOf(stored);
    const page = pages.find((candidate) => candidate.id === pageId);
    if (!page) throw NO_PAGE;
    const rest = pages.filter((candidate) => candidate.id !== pageId);
    if (page.kind === "rec") {
      const recordingId = page.recordingId ?? pageId;
      if (this.locks.has(projectId)) throw { code: "store_busy", message: "実行中の録音があります。終わってから、もう一度削除してください。" };
      if (pageId === ROOT_RECORDING_ID) {
        // root: 案件フォルダ直下の録音の中身と project.json の flowSnapshot・source・refs（info は残す）
        const { flowSnapshot: _snapshot, source: _source, refs: _refs, candidateSets: _candidateSets, ...project } = stored.project;
        Object.assign(stored, emptyData());
        stored.project = { ...project, pages: rest };
      } else {
        delete stored.recordings[recordingId];
        stored.project = { ...stored.project, pages: rest };
      }
      this.conversationFiles.delete(conversationKey({ projectId, recordingId }));
    } else {
      delete stored.docs[pageId];
      stored.project = { ...stored.project, pages: rest };
      const key = conversationKey({ projectId, recordingId: pageId });
      this.documentChatData.delete(key);
      this.conversationFiles.delete(key);
    }
    this.deletedPages.push({ projectId, pageId });
  }
  async movePage(sourceProjectId: ProjectId, pageId: string, targetProjectId: ProjectId, beforePageId: string | null = null): Promise<PageEntry> {
    const source = this.require(sourceProjectId);
    const target = this.require(targetProjectId);
    const sourcePages = this.pagesOf(source);
    const entry = sourcePages.find((page) => page.id === pageId);
    if (!entry) throw NO_PAGE;
    // Rust の move_page_before と同じく、移動元・移動先が実行中なら動かさない
    if (this.locks.has(sourceProjectId) || this.locks.has(targetProjectId)) {
      throw { code: "store_busy", message: "実行中の録音があります。終わってから、もう一度実行してください。" };
    }
    if (beforePageId === pageId) throw { code: "store_bad_page", message: "同じページの位置には移動できません。" };
    if (sourceProjectId !== targetProjectId && beforePageId !== null && !this.pagesOf(target).some((page) => page.id === beforePageId)) {
      throw { code: "store_stale_target", message: "移動先が変わりました。もう一度お試しください。" };
    }
    if (sourceProjectId === targetProjectId) {
      const rest = sourcePages.filter((page) => page.id !== pageId);
      const index = beforePageId === null ? rest.length : rest.findIndex((page) => page.id === beforePageId);
      if (index < 0) throw { code: "store_stale_target", message: "移動先が変わりました。もう一度お試しください。" };
      rest.splice(index, 0, entry);
      source.project = { ...source.project, pages: rest };
      return structuredClone(entry);
    }
    if (entry.kind === "rec" && (this.locks.has(sourceProjectId) || this.locks.has(targetProjectId))) {
      throw { code: "store_busy", message: "この録音は実行中または会話の送信中です。終わってから移動してください。" };
    }
    if (entry.kind === "rec" && targetProjectId !== null && this.pagesOf(target).some((page) => page.kind === "rec")) {
      throw { code: "store_folder_has_recording", message: "移動先のフォルダにはもう音声があります。" };
    }

    const legacyRoot = entry.kind === "rec" && sourceProjectId !== null && pageId === ROOT_RECORDING_ID;
    const movedId = legacyRoot ? `page${this.nextId++}` : pageId;
    const movedRecordingId = legacyRoot ? `rec${this.nextId++}` : entry.recordingId ?? movedId;
    if (this.pagesOf(target).some((page) => page.id === movedId)) {
      throw { code: "store_conflict", message: "移動先に同じページがあります。" };
    }
    const moved = { ...entry, id: movedId, ...(entry.kind === "rec" ? { recordingId: movedRecordingId } : {}) };
    if (entry.kind === "doc") {
      target.docs[movedId] = source.docs[pageId] ?? "";
      delete source.docs[pageId];
      const sourceKey = `${sourceProjectId ?? "_outside"}/${pageId}`;
      const targetKey = `${targetProjectId ?? "_outside"}/${movedId}`;
      this.docUpdated.set(targetKey, this.docUpdated.get(sourceKey) ?? Date.now());
      this.docUpdated.delete(sourceKey);
    } else if (legacyRoot) {
      const recording = rootRecording(source.project);
      if (!recording) throw NO_RECORDING;
      target.recordings[movedRecordingId] = {
        recording: { ...structuredClone(recording), id: movedRecordingId, moveGeneration: 1 },
        transcript: source.transcript,
        artifacts: structuredClone(source.artifacts),
        versions: structuredClone(source.versions),
        runs: structuredClone(source.runs),
        checkpoints: structuredClone(source.checkpoints),
      };
      const { flowSnapshot: _flow, source: _input, refs: _refs, candidateSets: _candidateSets, ...withoutRoot } = source.project;
      Object.assign(source, emptyData());
      source.project = withoutRoot;
    } else {
      const sourceRecordingId = entry.recordingId ?? pageId;
      const recording = source.recordings[sourceRecordingId];
      if (!recording) throw NO_RECORDING;
      target.recordings[movedRecordingId] = {
        ...recording,
        recording: {
          ...recording.recording,
          id: movedRecordingId,
          moveGeneration: (recording.recording.moveGeneration ?? 0) + 1,
        },
      };
      delete source.recordings[sourceRecordingId];
    }

    source.project = { ...source.project, pages: sourcePages.filter((page) => page.id !== pageId) };
    const targetPages = this.pagesOf(target);
    const targetIndex = beforePageId === null ? targetPages.length : targetPages.findIndex((page) => page.id === beforePageId);
    if (targetIndex < 0) throw { code: "store_stale_target", message: "移動先が変わりました。もう一度お試しください。" };
    targetPages.splice(targetIndex, 0, moved);
    target.project = { ...target.project, pages: targetPages };
    if (entry.kind === "rec") {
      const from = conversationKey({ projectId: sourceProjectId, recordingId: entry.recordingId ?? pageId });
      const to = conversationKey({ projectId: targetProjectId, recordingId: movedRecordingId });
      const conversations = this.conversationFiles.get(from);
      if (conversations) this.conversationFiles.set(to, conversations);
      this.conversationFiles.delete(from);
    }
    return structuredClone(moved);
  }
  private requireDoc(projectId: ProjectId, pageId: string): StoredProject {
    const stored = this.require(projectId);
    if (!projectPages(stored.project).some((page) => page.id === pageId && page.kind === "doc")) throw NO_PAGE;
    return stored;
  }
  async readPage(projectId: ProjectId, pageId: string) {
    return this.requireDoc(projectId, pageId).docs[pageId] ?? "";
  }
  async writePage(projectId: ProjectId, pageId: string, markdown: string) {
    const stored = this.requireDoc(projectId, pageId);
    stored.docs[pageId] = markdown;
    this.pageWrites.push({ projectId, pageId, markdown });
    this.docUpdated.set(`${projectId ?? "_outside"}/${pageId}`, Date.now());
    return this.noteSave(projectId, `pages/${pageId}.md`);
  }
  async openPageDocument(projectId: ProjectId, pageId: string) {
    const syncProjectId = projectId ?? DOCS_ROOT_PROJECT_ID;
    const path = `pages/${pageId}.md`;
    const protectionId = await this.cloudProtect(syncProjectId, [path]);
    const stored = this.requireDoc(projectId, pageId);
    const exists = Object.hasOwn(stored.docs, pageId);
    const markdown = await this.readPage(projectId, pageId);
    const sha256 = exists ? hashText(markdown) : null;
    const handle = `opened-${this.nextOpenedDocument++}`;
    this.openedDocuments.set(handle, {
      contextGeneration: this.cloud.contextGeneration,
      scopeId: this.cloud.documentScopeId ?? "no-document-scope",
      protectionId,
      expected: sha256,
      kind: { type: "page", projectId, pageId },
    });
    return {
      handle,
      contextGeneration: this.cloud.contextGeneration,
      scopeId: this.cloud.documentScopeId ?? "no-document-scope",
      markdown,
      sha256,
    };
  }
  async openArtifactDocument(rec: RecordingRef, stepId: string, source: boolean) {
    const data = this.requireRec(rec);
    const prefix = rec.recordingId === ROOT_RECORDING_ID ? "" : `recordings/${rec.recordingId}/`;
    const path = source ? `${prefix}transcript.md` : `${prefix}artifacts/${stepId}.md`;
    const protectionId = await this.cloudProtect(rec.projectId ?? DOCS_ROOT_PROJECT_ID, [path]);
    const exists = source ? data.transcript !== null : Object.hasOwn(data.artifacts, stepId);
    const markdown = source ? (data.transcript ?? "") : (data.artifacts[stepId] ?? "");
    const sha256 = exists ? hashText(markdown) : null;
    const handle = `opened-${this.nextOpenedDocument++}`;
    this.openedDocuments.set(handle, {
      contextGeneration: this.cloud.contextGeneration,
      scopeId: this.cloud.documentScopeId ?? "no-document-scope",
      protectionId,
      expected: sha256,
      kind: { type: "artifact", rec: { ...rec }, stepId, source },
    });
    return {
      handle,
      contextGeneration: this.cloud.contextGeneration,
      scopeId: this.cloud.documentScopeId ?? "no-document-scope",
      markdown,
      sha256,
    };
  }
  async saveOpenedDocument(handle: string, markdown: string) {
    const opened = this.openedDocuments.get(handle);
    if (!opened || opened.scopeId !== this.cloud.documentScopeId) {
      throw { code: "store_context_changed", message: "保存先が変わりました。書きかけは残しています。" };
    }
    let current: string;
    let exists: boolean;
    if (opened.kind.type === "page") {
      const stored = this.requireDoc(opened.kind.projectId, opened.kind.pageId);
      current = await this.readPage(opened.kind.projectId, opened.kind.pageId);
      exists = Object.hasOwn(stored.docs, opened.kind.pageId);
    } else {
      const data = this.requireRec(opened.kind.rec);
      current = opened.kind.source ? (data.transcript ?? "") : (data.artifacts[opened.kind.stepId] ?? "");
      exists = opened.kind.source ? data.transcript !== null : Object.hasOwn(data.artifacts, opened.kind.stepId);
    }
    if ((exists ? hashText(current) : null) !== opened.expected) {
      throw { code: "store_stale_document", message: "開いた後に本文が変わりました。書きかけは残しています。" };
    }
    const generation =
      opened.kind.type === "page"
        ? await this.writePage(opened.kind.projectId, opened.kind.pageId, markdown)
        : await this.writeArtifactDraft(opened.kind.rec, opened.kind.stepId, opened.kind.source, markdown);
    opened.expected = hashText(markdown);
    return generation;
  }
  async saveOpenedArtifact(handle: string, markdown: string, record: RunRecord) {
    const opened = this.openedDocuments.get(handle);
    if (!opened || opened.kind.type !== "artifact" || opened.scopeId !== this.cloud.documentScopeId) {
      throw { code: "store_context_changed", message: "保存先が変わりました。書きかけは残しています。" };
    }
    const data = this.requireRec(opened.kind.rec);
    const current = opened.kind.source ? (data.transcript ?? "") : (data.artifacts[opened.kind.stepId] ?? "");
    const exists = opened.kind.source ? data.transcript !== null : Object.hasOwn(data.artifacts, opened.kind.stepId);
    if ((exists ? hashText(current) : null) !== opened.expected) {
      throw { code: "store_stale_document", message: "開いた後に本文が変わりました。書きかけは残しています。" };
    }
    const version = await this.saveArtifact(opened.kind.rec, opened.kind.stepId, opened.kind.source, markdown, record);
    opened.expected = hashText(markdown);
    return version;
  }
  async releaseOpenedDocument(handle: string) {
    const opened = this.openedDocuments.get(handle);
    this.openedDocuments.delete(handle);
    if (opened) await this.cloudRelease(opened.protectionId);
  }
  async pickImageAsset(projectId: ProjectId): Promise<string | null> {
    this.require(projectId);
    return this.pickedImage;
  }
  async readImageAsset(projectId: ProjectId, name: string): Promise<string> {
    this.require(projectId);
    const image = this.images.get(`${projectId ?? "_outside"}/${name}`);
    if (!image) throw { code: "store_bad_image", message: "画像を読めませんでした。" };
    return image;
  }
  private require(projectId: ProjectId): StoredProject {
    if (projectId === null) return this.outside;
    const stored = this.projects.get(projectId);
    if (!stored) throw { code: "store_no_project", message: "案件が見つかりません。" };
    return stored;
  }
  /** 録音の中身（root は flowSnapshot のある今の形の案件だけ）。 */
  private recordingData(stored: StoredProject, recordingId: string): StoredRecordingData | null {
    if (recordingId === ROOT_RECORDING_ID) return stored.project.flowSnapshot ? stored : null;
    return stored.recordings[recordingId] ?? null;
  }
  private requireRec(rec: RecordingRef): StoredRecordingData {
    const data = this.recordingData(this.require(rec.projectId), rec.recordingId);
    if (!data) throw NO_RECORDING;
    return data;
  }
  private requireChat(rec: RecordingRef): StoredRecordingData {
    const stored = this.require(rec.projectId);
    if (this.pagesOf(stored).some((page) => page.id === rec.recordingId && page.kind === "doc")) {
      const key = conversationKey(rec);
      const data = this.documentChatData.get(key) ?? emptyData();
      this.documentChatData.set(key, data);
      return data;
    }
    return this.requireRec(rec);
  }
  /** 録音のページ（テストから中身を見る）。 */
  recording(projectId: string, recordingId: string): StoredRecording {
    const found = this.require(projectId).recordings[recordingId];
    if (!found) throw new Error(`recording not found: ${recordingId}`);
    return found;
  }
  /** 録音の音声（root は project.json の source）。 */
  private audioCount(rec: RecordingRef): number {
    const stored = this.require(rec.projectId);
    const source = rec.recordingId === ROOT_RECORDING_ID ? stored.project.source : stored.recordings[rec.recordingId]?.recording.source;
    return source?.kind === "audio" ? source.audio.length : 0;
  }
  private write(stored: StoredRecordingData, stepId: string, source: boolean, markdown: string, record: RunRecord): number {
    const versions = (stored.versions[stepId] ??= []);
    versions.push(markdown);
    if (source) stored.transcript = markdown;
    else stored.artifacts[stepId] = markdown;
    stored.runs.push({ ...record, version: versions.length });
    return versions.length;
  }
  async saveArtifact(rec: RecordingRef, stepId: string, source: boolean, markdown: string, record: RunRecord) {
    return this.write(this.requireRec(rec), stepId, source, markdown, record);
  }
  async appendRun(rec: RecordingRef, record: RunRecord) {
    this.requireChat(rec).runs.push({ ...record });
  }
  async readVersion(rec: RecordingRef, stepId: string, version: number, versionPath?: string) {
    this.versionReads.push({ stepId, version, versionPath });
    const text = this.requireRec(rec).versions[stepId]?.[version - 1];
    if (text === undefined) throw { code: "store_no_version", message: "その版が見つかりません。" };
    return text;
  }
  async saveCheckpoint(rec: RecordingRef, runId: string, checkpoint: RunCheckpoint) {
    this.requireChat(rec).checkpoints[runId] = structuredClone(checkpoint);
  }
  async readCheckpoint(rec: RecordingRef, runId: string) {
    return this.requireChat(rec).checkpoints[runId] ?? null;
  }
  async acquireRunLock(projectId: ProjectId) {
    // フォルダ外の録音も予約の docs-root の lease を取る（Native の acquire_run_lock と同じ。#18721）
    if (this.leaseHeldBy !== null) {
      throw { code: "lease_held", message: `別の Mac（${this.leaseHeldBy}）で実行中です。終わってから実行してください。` };
    }
    // スマホから受けた工程をこの Mac で実行している間は断る（Native の pc_runner::refuse_local_run と同じ）
    if (this.pcRunner.state === "running") {
      throw { code: "pc_runner_busy", message: "スマホから依頼された工程をこの Mac で実行しています。終わってからもう一度お試しください。" };
    }
    if (this.locks.has(projectId)) throw { code: "store_busy", message: "実行中の録音があります。終わってから、もう一度実行してください。" };
    this.locks.add(projectId);
  }
  async releaseRunLock(projectId: ProjectId) {
    this.locks.delete(projectId);
  }
  async listAllRuns() {
    return [
      ...[...this.documentChatData.entries()].flatMap(([key, data]) => data.runs.map((run) => ({ ...run,
        project: key.split("/")[0] === "_outside" ? null : key.split("/")[0], recording: key.split("/")[1] }))),
      ...Object.entries(this.outside.recordings).flatMap(([recordingId, found]) =>
        found.runs.map((run) => ({ ...run, project: null, recording: recordingId })),
      ),
      ...[...this.projects.entries()].flatMap(([id, stored]) => [
        ...stored.runs.map((run) => ({ ...run, project: id, recording: ROOT_RECORDING_ID })),
        ...Object.entries(stored.recordings).flatMap(([recordingId, found]) =>
          found.runs.map((run) => ({ ...run, project: id, recording: recordingId })),
        ),
      ]),
    ];
  }
  async runTurn(turnId: string, request: TurnRequest, onEvent: (envelope: TurnEnvelope) => void, operation?: string | null): Promise<TurnResult> {
    this.sendGuard(operation, "turn");
    const call = this.turnRequests.length;
    this.turnRequests.push(request);
    this.onTurnStarted?.();
    const events = this.turnScript(request, call);
    const emit = this.turnEmitter(turnId, onEvent);
    if (events[0]) emit.send(events[0], 0);
    if (this.turnGate) await this.turnGate;
    events.slice(1).forEach((event, index) => emit.send(event, index + 1));
    return { finalEvent: emit.finalEvent() };
  }
  /**
   * 本物の command と同じく、終端イベント（Done / Error）を Channel で流し、戻り値にも載せる。`lateTerminal` のときは
   * Tauri の Channel の大きいメッセージ（fetch で後から取りに行く）のように、終端イベントを戻りの後に Channel へ届ける。
   */
  private turnEmitter(turnId: string, onEvent: (envelope: TurnEnvelope) => void) {
    let finalEvent: TurnEvent | null = null;
    return {
      send: (event: TurnEvent, seq: number) => {
        const stopped = event.type === "Done" && this.acceptedStops.has(turnId) ? { ...event, stop_reason: "Stopped" as const } : event;
        const terminal = stopped.type === "Done" || stopped.type === "Error";
        if (terminal) finalEvent = stopped;
        if (terminal && this.lateTerminal) setTimeout(() => onEvent({ turnId, seq, event: stopped }), 0);
        else onEvent({ turnId, seq, event: stopped });
      },
      finalEvent: () => finalEvent,
    };
  }
  async stopTurn(turnId: string) {
    this.stoppedTurns.push(turnId);
    const accepted = this.stopTurnResults.shift() ?? true;
    if (accepted) this.acceptedStops.add(turnId);
    return accepted;
  }
  async runChatTurn(
    turnId: string,
    rec: RecordingRef,
    _conversationId: string,
    request: ChatTurnRequest,
    onEvent: (envelope: TurnEnvelope) => void,
  ): Promise<ChatTurnResult> {
    // composer（#18722）: 文書ページの会話（recording が false）は録音の文書を写さず、recordingId は文書ページの id
    const composer = request.composer ?? null;
    const recording = composer?.recording ?? true;
    const stored = recording ? this.requireRec(rec) : this.requireChat(rec);
    const call = this.chatRequests.length;
    this.chatRequests.push({ projectId: rec.projectId, recordingId: rec.recordingId, request });
    // 本物（conversation.rs）と同じく、工程 1 の文字起こし・文章は artifacts/source.md として写す
    const baseline: Record<string, string> = recording
      ? {
          ...stored.artifacts,
          ...(stored.transcript !== null ? { [SOURCE_STEP_ID]: stored.transcript } : {}),
        }
      : {};
    const pageBaseline: Record<string, string> = {};
    for (const pageId of composer?.pages ?? []) pageBaseline[pageId] = await this.readPage(rec.projectId, pageId);
    const staged: StagedChat = { ...stored, artifacts: { ...baseline }, pages: { ...pageBaseline }, created: {} };
    const events = this.chatScript(request, call, staged);
    let finalEvent: TurnEvent | null = null;
    const emit = (event: TurnEvent, seq: number) => {
      const stopped = event.type === "Done" && this.acceptedStops.has(turnId) ? { ...event, stop_reason: "Stopped" as const } : event;
      if (stopped.type === "Done" || stopped.type === "Error") finalEvent = stopped;
      onEvent({ turnId, seq, event: stopped });
    };
    if (events[0]) emit(events[0], 0);
    await this.onChatStarted?.(stored);
    if (this.chatGate) await this.chatGate;
    events.slice(1).forEach((event, index) => emit(event, index + 1));
    const stepIds = new Set([...Object.keys(baseline), ...Object.keys(staged.artifacts)]);
    return {
      finalEvent: finalEvent ?? { type: "Error", reason_code: "TransientFailure", message: "" },
      artifacts: recording && composer?.recording_writable !== false
        ? [...stepIds]
            .filter((stepId) => baseline[stepId] !== staged.artifacts[stepId] && (!request.writable_artifact_id || request.writable_artifact_id === stepId))
            .sort()
            .map((stepId) => ({ stepId, markdown: staged.artifacts[stepId] ?? null }))
        : [],
      // 消した文書ページは返さない（本物と同じ）。新しい文書は名前の順
      pages: Object.keys(pageBaseline)
        .filter((pageId) => staged.pages[pageId] !== undefined && staged.pages[pageId] !== pageBaseline[pageId])
        .sort()
        .map((pageId) => ({ pageId, markdown: staged.pages[pageId]! })),
      created: Object.keys(staged.created)
        .sort()
        .filter((file) => staged.created[file]!.trim())
        .map((file) => ({ file, markdown: staged.created[file]! })),
    };
  }
  async artifactStates(rec: RecordingRef): Promise<ArtifactState[]> {
    const stored = this.requireRec(rec);
    const ids = new Set([...Object.keys(stored.artifacts), ...Object.keys(stored.versions).filter((id) => id !== SOURCE_STEP_ID)]);
    // 工程 1（transcript.md・versions/source/）は先頭（store_conversations.rs と同じ）
    const hasSource = stored.transcript !== null || (stored.versions[SOURCE_STEP_ID]?.length ?? 0) > 0;
    return [...(hasSource ? [SOURCE_STEP_ID] : []), ...[...ids].sort()].map((stepId) => {
      const body = stepId === SOURCE_STEP_ID ? (stored.transcript ?? undefined) : stored.artifacts[stepId];
      return {
        stepId,
        exists: body !== undefined,
        sha256: body === undefined ? null : hashText(body),
        size: body?.length ?? 0,
        mtimeMs: 0,
        latestVersion: stored.versions[stepId]?.length ?? 0,
      };
    });
  }
  async readArtifact(rec: RecordingRef, stepId: string) {
    return this.requireRec(rec).artifacts[stepId] ?? null;
  }
  async revertArtifact(rec: RecordingRef, stepId: string) {
    const stored = this.requireRec(rec);
    const versions = stored.versions[stepId] ?? [];
    const latest = versions[versions.length - 1];
    if (latest === undefined) throw { code: "store_no_version", message: "その版が見つかりません。" };
    stored.artifacts[stepId] = latest;
    return versions.length;
  }
  async listConversations(rec: RecordingRef) {
    this.requireChat(rec);
    return [...(this.conversationFiles.get(conversationKey(rec))?.values() ?? [])]
      .map((conversation) => structuredClone(conversation))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
  async saveConversation(rec: RecordingRef, conversation: ConversationFile) {
    this.requireChat(rec);
    const key = conversationKey(rec);
    const files = this.conversationFiles.get(key) ?? new Map<string, ConversationFile>();
    files.set(conversation.id, structuredClone(conversation));
    this.conversationFiles.set(key, files);
  }
  async providerStatus(provider: ContractProvider) {
    this.statusCalls.push(provider);
    return structuredClone(this.statuses[provider]);
  }
  async startAuth(provider: ContractProvider) {
    this.maintenance.push(provider === "ClaudeCode" ? "auth" : `auth:${provider}`);
    if (this.maintenanceError) throw this.maintenanceError;
    if (provider === "GeminiCli") {
      throw { code: "auth_unsupported", message: "Antigravity CLI のログインは、ターミナルで agy を起動して行ってください。" };
    }
    const login = provider === "ClaudeCode" ? "Claude Max account" : "ChatGPT";
    this.statuses[provider] = { ...this.statuses[provider], authenticated: true, reason: null, login_method: login };
    return structuredClone(this.statuses[provider]);
  }
  async providerUsage(provider: ContractProvider): Promise<ProviderUsage> {
    const usage = this.usage[provider];
    if (!usage) throw { code: "usage_unavailable", message: "使用量を取得できませんでした。" };
    return structuredClone(usage);
  }
  async prepareAudio(_jobId: string, rec: RecordingRef, onEvent: (event: SpeechEvent) => void, operation?: string | null) {
    this.sendGuard(operation, "audio_prepare");
    this.requireChat(rec);
    if (!Array.isArray(this.preparedAudio)) throw this.preparedAudio;
    const files = this.preparedAudio.length;
    this.preparedAudio.forEach((_, file) => {
      onEvent({ type: "Stage", stage: "convert", file, files });
      onEvent({ type: "Stage", stage: "silence", file, files });
    });
    return structuredClone(this.preparedAudio);
  }
  async transcribeAudioPart(
    turnId: string,
    jobId: string,
    file: number,
    part: number,
    request: AudioPartRequest,
    onEvent: (envelope: TurnEnvelope) => void,
    operation?: string | null,
  ): Promise<TurnResult> {
    this.sendGuard(operation, "audio_part", request.provider === "GeminiApi");
    const call = this.audioPartRequests.length;
    this.audioPartRequests.push({ turnId, jobId, file, part, request });
    const events = this.audioPartScript(request, call, { file, part });
    const emit = this.turnEmitter(turnId, onEvent);
    if (events[0]) emit.send(events[0], 0);
    if (this.audioPartGate) await this.audioPartGate;
    events.slice(1).forEach((event, index) => emit.send(event, index + 1));
    return { finalEvent: emit.finalEvent() };
  }
  async releaseAudio(jobId: string) {
    this.releasedAudio.push(jobId);
  }
  async transcribeDeepgram(jobId: string, rec: RecordingRef, request: DeepgramRequest, onEvent: (event: SpeechEvent) => void, operation?: string | null) {
    this.sendGuard(operation, "deepgram");
    this.requireChat(rec);
    this.deepgramRequests.push({ jobId, projectId: rec.projectId, request: structuredClone(request) });
    const files = this.audioCount(rec);
    for (let file = 0; file < files; file++) onEvent({ type: "Stage", stage: "transcribe", file, files });
    if (this.deepgramResult && !Array.isArray(this.deepgramResult)) throw this.deepgramResult;
    if (!this.keychain.has("deepgram")) {
      throw { code: "api_key_missing", message: "Deepgram の API キーが保存されていません。設定 › 接続設定で API キーを保存してください。" };
    }
    return structuredClone(
      this.deepgramResult ??
        Array.from({ length: files }, () => ({
          durationSec: this.audioDurationSec,
          utterances: [{ start: 1, end: 4, speaker: 0, transcript: "朝市 に 出して 三年目 です" }],
          transcript: "",
        })),
    );
  }
  private keyStatus(account: ApiKeyAccount, fields: Partial<ApiKeyStatus> = {}): ApiKeyStatus {
    const key = this.keychain.get(account);
    return {
      saved: key !== undefined,
      last4: key && key.length >= 12 ? key.slice(-4) : null,
      valid: null,
      models: [],
      reason: null,
      message: null,
      ...fields,
    };
  }
  async apiKeyStatus(account: ApiKeyAccount) {
    this.keyCalls.push(`status:${account}`);
    if (this.keyReenter.has(account) && !this.keychain.has(account)) {
      return this.keyStatus(account, { reason: "api_key_reenter", message: LEGACY_KEY_REENTER_MESSAGE });
    }
    return this.keyStatus(account);
  }
  async saveApiKey(account: ApiKeyAccount, key: string) {
    this.keyCalls.push(`save:${account}`);
    const trimmed = key.trim();
    const result = this.keyCheck(account, trimmed);
    if (!result.ok) throw { code: result.code, message: result.message };
    this.keychain.set(account, trimmed);
    this.keyReenter.delete(account);
    return this.keyStatus(account, { valid: true, models: result.models });
  }
  async checkApiKey(account: ApiKeyAccount) {
    this.keyCalls.push(`check:${account}`);
    const key = this.keychain.get(account);
    if (key === undefined) return this.keyStatus(account);
    const result = this.keyCheck(account, key);
    return result.ok
      ? this.keyStatus(account, { valid: true, models: result.models })
      : this.keyStatus(account, { valid: result.code === "api_key_invalid" ? false : null, reason: result.code, message: result.message });
  }
  async deleteApiKey(account: ApiKeyAccount) {
    this.keyCalls.push(`delete:${account}`);
    this.keychain.delete(account);
    this.keyReenter.delete(account);
    return this.keyStatus(account);
  }
  async installClaude() {
    this.maintenance.push("install");
    if (this.maintenanceError) throw this.maintenanceError;
    this.claude = { ...this.claude, installed: true, version: "2.1.267 (Claude Code)", reason: "auth_required" };
    return structuredClone(this.claude);
  }
  async updateClaude(): Promise<ClaudeUpdateResult> {
    this.maintenance.push("update");
    if (this.maintenanceError) throw this.maintenanceError;
    const before = this.claude.version;
    this.claude = { ...this.claude, version: "2.1.300 (Claude Code)", missing_cli_flags: [] };
    return { before_version: before, after_version: this.claude.version, status: structuredClone(this.claude) };
  }
  async speechStatus(): Promise<SpeechStatus> {
    return {
      found: true,
      fake: false,
      available: true,
      needsDownload: false,
      engine: "apple",
      error: null,
      notice: null,
      diarization: { state: "ready", detail: null },
    };
  }
  async speechDownload() {}
  async transcribe(
    _jobId: string,
    rec: RecordingRef,
    language: string,
    speakerMode: SpeakerMode,
    _hints: unknown,
    onEvent: (event: SpeechEvent) => void,
    operation?: string | null,
  ) {
    this.sendGuard(operation, "this_mac");
    this.requireRec(rec);
    this.transcribeLanguages.push(language);
    this.transcribeSpeakerModes.push(speakerMode);
    this.onTranscribeStarted?.();
    if (this.speechEvents[0]) onEvent(this.speechEvents[0]);
    if (this.transcribeGate) await this.transcribeGate;
    this.speechEvents.slice(1).forEach(onEvent);
    if (!Array.isArray(this.transcribeResult)) throw this.transcribeResult;
    return this.transcribeResult;
  }
  async stopTranscribe() {
    return true;
  }
  /** 音声の拡張子のファイルだけを音声として読む（長さは audioDurationSec）。 */
  async audioInfo(paths: string[]): Promise<AudioInfo[]> {
    if (this.audioInfoGate) await this.audioInfoGate;
    return paths
      .filter((path) => /\.(m4a|mp3|wav|aac|aif|aiff|caf|mp4|m4v|mov)$/i.test(path))
      .map((path) => ({ path, name: path.split("/").pop() ?? path, durationSec: this.audioDurationSec }));
  }
  audioFilePathRequests: RecordingRef[] = [];
  audioFilePathOverrides = new Map<string, string>();
  async audioFilePaths(rec: RecordingRef): Promise<AudioFilePath[]> {
    const stored = this.require(rec.projectId);
    const source = rec.recordingId === ROOT_RECORDING_ID ? stored.project.source : stored.recordings[rec.recordingId]?.recording.source;
    this.audioFilePathRequests.push({ ...rec });
    if (source?.kind !== "audio") return [];
    return source.audio.map(({ file }) => ({
      file,
      path: this.missingAudio.has(file) ? null : (this.audioFilePathOverrides.get(file) ?? `/fake/inputs/${file}`),
    }));
  }
  /** pickAudioFiles が返すファイル。 */
  pickedAudio: string[] = [];
  audioInfoGate: Promise<void> | null = null;
  async pickAudioFiles() {
    return this.audioInfo(this.pickedAudio);
  }
  async pickDocsRoot() {
    return this.pickedDocsRoot;
  }
  /** 「.md で保存」に渡したファイル名（順に）。 */
  exportedNames: string[] = [];
  exportedMarkdowns: string[] = [];
  async saveMarkdownAs(fileName: string, markdown: string) {
    this.exportedNames.push(fileName);
    this.exportedMarkdowns.push(markdown);
    return null;
  }
  async revealRoot() {}
  async revealArtifact() {}
  async revealPage() {}
  async copyText(text: string) {
    this.copied.push(text);
  }
  // ---- 録音（#18590） ----
  micState: MicStatus = "authorized";
  micStatusCalls: boolean[] = [];
  recordingError: { code: string; message: string } | null = null;
  duringStart: ((recordingId: string, onEvent: (event: RecordingEvent) => void) => void) | null = null;
  activeRecording: { id: string; onEvent: (event: RecordingEvent) => void } | null = null;
  recordedSec = 1425;
  discardedRecordings: string[] = [];
  leftovers: RecordedAudio[] = [];
  openedMicSettings = 0;
  closedAfterRecording = 0;
  async micStatus(request: boolean): Promise<MicStatus> {
    this.micStatusCalls.push(request);
    return this.micState;
  }
  async startRecording(recordingId: string, onEvent: (event: RecordingEvent) => void) {
    if (this.recordingError) throw this.recordingError;
    if (this.activeRecording) throw { code: "recording_busy", message: "ほかの録音が動いています。" };
    this.activeRecording = { id: recordingId, onEvent };
    this.duringStart?.(recordingId, onEvent);
    onEvent({ type: "Started", device: "MacBook Pro のマイク" });
    return { device: "MacBook Pro のマイク" };
  }
  emitRecording(event: RecordingEvent) {
    const current = this.activeRecording;
    if (event.type === "Done") {
      this.activeRecording = null;
      if (!this.leftovers.some((left) => left.recordingId === event.audio.recordingId)) this.leftovers.push(event.audio);
    }
    current?.onEvent(event);
  }
  recordedAudio(recordingId: string): RecordedAudio {
    return { recordingId, path: `/data/recordings/${recordingId}.m4a`, name: "録音 10/16 15:30", durationSec: this.recordedSec };
  }
  async stopRecording(recordingId: string) {
    if (this.activeRecording?.id !== recordingId) throw { code: "recording_missing", message: "録音が見つかりません。" };
    this.activeRecording = null;
    const audio = this.recordedAudio(recordingId);
    if (!this.leftovers.some((left) => left.recordingId === recordingId)) this.leftovers.push(audio);
    return audio;
  }
  async discardRecording(recordingId: string) {
    this.discardedRecordings.push(recordingId);
    if (this.activeRecording?.id === recordingId) this.activeRecording = null;
    this.leftovers = this.leftovers.filter((left) => left.recordingId !== recordingId);
  }
  async leftoverRecordings() {
    return structuredClone(this.leftovers);
  }
  async openMicrophoneSettings() {
    this.openedMicSettings += 1;
  }
  private recordingCloseListeners = new Set<() => void>();
  async onRecordingCloseRequested(handler: () => void) {
    this.recordingCloseListeners.add(handler);
    return () => {
      this.recordingCloseListeners.delete(handler);
    };
  }
  requestWindowClose() {
    for (const listener of [...this.recordingCloseListeners]) listener();
  }
  async closeAfterRecording() {
    const recordingId = this.activeRecording?.id;
    if (recordingId) await this.stopRecording(recordingId);
    this.closedAfterRecording += 1;
  }
  /** onFileDrop の購読（テストから `drop` でドロップを起こす）。 */
  private dropListeners = new Set<(paths: string[]) => void>();
  private dropHoverListeners = new Set<(over: boolean) => void>();
  get fileDropListenerCount() { return this.dropListeners.size; }
  async onFileDrop(handler: (paths: string[]) => void, onHover?: (over: boolean) => void) {
    this.dropListeners.add(handler);
    if (onHover) this.dropHoverListeners.add(onHover);
    return () => {
      this.dropListeners.delete(handler);
      if (onHover) this.dropHoverListeners.delete(onHover);
    };
  }
  /** Finder からファイルを落とす（購読している画面だけが受け取る）。 */
  drop(paths: string[]) {
    for (const listener of [...this.dropListeners]) listener(paths);
  }
  hoverDrop(over: boolean) {
    for (const listener of [...this.dropHoverListeners]) listener(over);
  }
  /** onCloseRequested の購読（テストから `requestClose` で窓を閉じる要求を起こす）。 */
  private closeListeners = new Set<() => Promise<boolean>>();
  async onCloseRequested(handler: () => Promise<boolean>) {
    this.closeListeners.add(handler);
    return () => {
      this.closeListeners.delete(handler);
    };
  }
  /** 窓を閉じる要求を起こす。購読が終わるのを待ち、閉じてよければ true（誰かが止めたら false）。 */
  async requestClose(): Promise<boolean> {
    let closes = true;
    for (const listener of [...this.closeListeners]) if (!(await listener())) closes = false;
    return closes;
  }
  /** 自動更新の状態（watchUpdate が最初に返す）。既定は自動更新を使っていない（公開鍵が未設定）。 */
  update: UpdateStatus = { enabled: false, stagedVersion: null };
  private updateListeners = new Set<(status: UpdateStatus) => void>();
  async watchUpdate(handler: (status: UpdateStatus) => void) {
    this.updateListeners.add(handler);
    handler(this.update);
    return () => {
      this.updateListeners.delete(handler);
    };
  }
  /** 裏の確認が新しい版を取得したことにする（購読している画面に届く）。 */
  stageUpdate(version: string) {
    this.update = { enabled: true, stagedVersion: version };
    for (const listener of [...this.updateListeners]) listener(this.update);
  }
  /** 工程・会話・文字起こしが動いているか（restartToUpdate が busy を返す）。 */
  updateBusy = false;
  /** 別の NIHO docs が工程を実行しているか（restartToUpdate が force でも otherAppRunning を返す）。 */
  updateOtherApp = false;
  /** restartToUpdate の呼び出し（force の値）。 */
  restartCalls: boolean[] = [];
  async restartToUpdate(force: boolean): Promise<RestartOutcome> {
    this.restartCalls.push(force);
    if (!this.update.stagedVersion) return "notStaged";
    if (this.updateOtherApp) return "otherAppRunning";
    return this.updateBusy && !force ? "busy" : "restarting";
  }

  // ---- NIHO クラウド（C3 #18595。src-tauri/src/cloud.rs の代わり） ----

  /** 保存先の状態（既定は「この Mac だけ」）。 */
  cloud: CloudState = cloudStateOf();
  /** 案件ごとの同期の状態（cloudProjectStatus が返す。emitCloudProject で画面へ届ける）。 */
  cloudSnapshots = new Map<string, ProjectSyncSnapshot>();
  /** personal controller の実Appテストでは cloudSyncNow の後に同期済みになる。待機・timeout の単体テストは false にする。 */
  personalAutoSync = true;
  /** 案件ごとの競合（.conflicts/index.json の代わり）と、その両側の本文（conflictId → 本文）。 */
  conflictEntries = new Map<string, ConflictEntry[]>();
  conflictCopies = new Map<string, { local: string | null; remote: string | null }>();
  remoteProjects: RemoteProject[] = [];
  /** command の捕捉済み reply を遅らせ、root/context 切替後の後着を再現する。 */
  cloudProjectStatusGate: Promise<void> | null = null;
  cloudRemoteProjectsGate: Promise<void> | null = null;
  cloudSetDeviceNameGate: Promise<void> | null = null;
  deletedProjects: DeletedProject[] = [];
  cloudUsageValue: VaultUsage | null = null;
  /** cloud の command の呼び出し（順に。名前と引数）。 */
  cloudCalls: Array<{ name: string; args: unknown[] }> = [];
  /** この Mac の保存の世代（writePage・writeArtifactDraft が進める）。 */
  saveGeneration = 0;
  /** 登録中の守り（id → 案件と path）。 */
  protections = new Map<number, { projectId: string; paths: string[] }>();
  private nextProtection = 1;
  /** 入れると次の cloudResolveConflict が投げる（1 回だけ）。 */
  resolveFailure: { code: string; message: string } | null = null;
  /** 入れると cloudSetProvider が投げる。 */
  providerFailure: { code: string; message: string } | null = null;
  /** 別の Mac が lease を持っている（acquireRunLock が lease_held で断る。値はその Mac の名前）。 */
  leaseHeldBy: string | null = null;
  /** cloudOpenProject の前に待つ（スピナーを見るテスト用）。 */
  openGate: Promise<void> | null = null;
  /** 写しがこの Mac に無い音声の file（loadRecording の missingInputs）。 */
  missingAudio = new Set<string>();
  /** 書きかけを今の path に保存した記録（順に）。 */
  artifactDraftWrites: Array<{ projectId: ProjectId; recordingId: string; stepId: string; markdown: string }> = [];
  /** 版の本文を読んだ呼び出し（順に。versionPath つき）。 */
  versionReads: Array<{ stepId: string; version: number; versionPath: string | undefined }> = [];
  /** 書きかけを今の path に保存した工程（conversationKey → 工程 id）。版を作ると外す。 */
  private drafted = new Map<string, Set<string>>();
  private cloudStateListeners = new Set<(state: CloudState) => void>();
  private cloudProjectListeners = new Set<(event: CloudProjectEvent) => void>();
  private cloudAppliedListeners = new Set<(event: CloudAppliedEvent) => void>();
  private cloudRemoteListeners = new Set<(event: CloudRemoteEvent) => void>();
  private cloudClosingProgressListeners = new Set<(progress: ClosingProgress) => void>();

  private recordCloud(name: string, ...args: unknown[]) {
    this.cloudCalls.push({ name, args });
  }
  /** 呼んだ cloud の command の引数（名前で絞る）。 */
  cloudCallsOf(name: string): unknown[][] {
    return this.cloudCalls.filter((call) => call.name === name).map((call) => call.args);
  }
  /** この Mac に保存した（NIHO クラウドなら、その path を未送信にして画面へ届ける）。保存の世代を返す。 */
  /** local Store は null のまま、同期状態だけ docs-root に写す。 */
  private noteSave(projectId: ProjectId, path: string): number | null {
    const syncProjectId = projectId ?? DOCS_ROOT_PROJECT_ID;
    const generation = ++this.saveGeneration;
    if (this.cloud.provider === "niho") {
      const snapshot = this.cloudSnapshots.get(syncProjectId) ?? syncSnapshot(syncProjectId);
      const next = { ...snapshot, localGeneration: generation, dirty: { ...snapshot.dirty, [path]: generation } };
      this.cloudSnapshots.set(syncProjectId, next);
      this.emitCloudProject(syncProjectId);
    }
    return generation;
  }
  /** クラウドに送り終えたことにする（未送信を消して画面へ届ける）。 */
  ackCloud(projectId: string) {
    const snapshot = this.cloudSnapshots.get(projectId) ?? syncSnapshot(projectId);
    this.cloudSnapshots.set(projectId, { ...snapshot, dirty: {}, acknowledgedGeneration: snapshot.localGeneration, lastError: null });
    this.emitCloudProject(projectId);
  }
  emitCloudState(state: CloudState = this.cloud) {
    if (state.documentScopeId !== this.cloud.documentScopeId) {
      // native は別 RootBinding の handle だけを破棄し、同じ scope の session refresh では保つ。
      for (const opened of this.openedDocuments.values()) this.protections.delete(opened.protectionId);
      this.openedDocuments.clear();
    }
    this.cloud = structuredClone(state);
    for (const listener of [...this.cloudStateListeners]) listener(structuredClone(this.cloud));
  }
  /** 案件の同期の状態を画面へ届ける（snapshot を渡せば置き換えてから）。 */
  emitCloudProject(projectId: string, snapshot?: ProjectSyncSnapshot, contextGeneration = this.cloud.contextGeneration) {
    if (snapshot && contextGeneration === this.cloud.contextGeneration) this.cloudSnapshots.set(projectId, structuredClone(snapshot));
    const current = snapshot ?? this.cloudSnapshots.get(projectId);
    if (!current) return;
    for (const listener of [...this.cloudProjectListeners]) {
      listener({ contextGeneration, projectId, snapshot: structuredClone(current) });
    }
  }
  emitCloudApplied(projectId: string, paths: string[], contextGeneration = this.cloud.contextGeneration) {
    for (const listener of [...this.cloudAppliedListeners]) listener({ contextGeneration, projectId, paths: [...paths] });
  }
  emitCloudRemote(projects: RemoteProject[] = this.remoteProjects, contextGeneration = this.cloud.contextGeneration) {
    if (contextGeneration === this.cloud.contextGeneration) this.remoteProjects = structuredClone(projects);
    const event = { contextGeneration, projects: structuredClone(projects) };
    for (const listener of [...this.cloudRemoteListeners]) listener(structuredClone(event));
  }
  /** 今の path の書きかけが版と違う工程（Rust の load_recording の unversioned と同じく、書きかけを保存した工程だけ）。 */
  private unversionedOf(rec: RecordingRef, data: StoredRecordingData): string[] {
    const steps = this.drafted.get(conversationKey(rec)) ?? new Set<string>();
    return [...steps].filter((stepId) => {
      const current = stepId === SOURCE_STEP_ID ? data.transcript : data.artifacts[stepId];
      return current !== undefined && current !== null && current !== data.versions[stepId]?.at(-1);
    });
  }
  private missingOf(rec: RecordingRef): string[] {
    const stored = this.require(rec.projectId);
    const source = rec.recordingId === ROOT_RECORDING_ID ? stored.project.source : stored.recordings[rec.recordingId]?.recording.source;
    const files = source?.kind === "audio" ? source.audio.map((audio) => audio.file) : [];
    return files.filter((file) => this.missingAudio.has(file));
  }

  async cloudState() {
    this.recordCloud("cloudState");
    return structuredClone(this.cloud);
  }
  async cloudStorageSelect(mode: "CLOUD" | "LOCAL") {
    this.recordCloud("cloudStorageSelect", mode);
    if (this.providerFailure) throw this.providerFailure;
    if (this.cloud.storage?.mode !== "UNSET") throw { code: "docs_storage_changed", message: "保存先が変わりました。" };
    this.cloud = {
      ...this.cloud,
      contextGeneration: this.cloud.contextGeneration + 1,
      provider: mode === "CLOUD" ? "niho" : "local",
      status: mode === "CLOUD" ? "active" : "local",
      storage: { mode, epoch: String(Number(this.cloud.storage.epoch) + 1), changedAt: new Date().toISOString(),
        cleanupPending: false, quotaBytes: 5 * 1024 ** 3, closing: null },
    };
    return structuredClone(this.cloud);
  }
  async cloudStorageReopeningPreview() {
    this.recordCloud("cloudStorageReopeningPreview");
    return { projectCount: 1, fileCount: 0, audioCount: 0, bytesTotal: 0, quotaBytes: 5 * 1024 ** 3 };
  }
  async cloudStorageReopen() {
    this.recordCloud("cloudStorageReopen");
    if (this.providerFailure) throw this.providerFailure;
    if (this.cloud.storage?.mode !== "LOCAL") throw { code: "docs_storage_changed", message: "保存先が変わりました。" };
    this.cloud = { ...this.cloud, contextGeneration: this.cloud.contextGeneration + 1,
      provider: "niho", status: "active", reopeningPending: false, storage: { ...this.cloud.storage,
        mode: "CLOUD", epoch: String(Number(this.cloud.storage.epoch) + 1), changedAt: new Date().toISOString() } };
    return structuredClone(this.cloud);
  }
  async cloudStorageClosingPreview(): Promise<ClosingPreview> {
    this.recordCloud("cloudStorageClosingPreview");
    if (this.cloud.storage?.mode !== "CLOUD" && this.cloud.storage?.mode !== "CLOSING") {
      throw { code: "docs_storage_changed", message: "保存先が変わりました。" };
    }
    return { preflight: { epoch: this.cloud.storage.epoch, transferBytes: "0", folders: 0, pages: 0,
      unexpiredAudio: 0, expiredAudio: 0, deletedFolders: 0, otherMacs: this.closingOtherMacs,
      active: { runs: 0, composerTurns: 0, folderExports: 0 } }, requiredFreeBytes: 0, availableFreeBytes: 1024 ** 3 };
  }
  async cloudStorageClosingPrepare(): Promise<PreparedClosing> {
    this.recordCloud("cloudStorageClosingPrepare");
    if (this.cloud.storage?.mode !== "CLOUD" && this.cloud.storage?.mode !== "CLOSING") {
      throw { code: "docs_storage_changed", message: "保存先が変わりました。" };
    }
    const epoch = this.cloud.storage.epoch;
    this.cloud = { ...this.cloud, storage: { ...this.cloud.storage, mode: "CLOSING",
      closing: { deviceName: this.cloud.deviceName, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() } } };
    const progress = { done: 0, total: 0 };
    for (const listener of this.cloudClosingProgressListeners) listener(progress);
    return { closingId: "test-closing", epoch, manifestDigest: "0".repeat(64),
      fileCount: 0, expiredAudioCount: 0, deletedFolderCount: 0 };
  }
  async cloudStorageClosingConfirm(prepared: PreparedClosing): Promise<CloudState> {
    this.recordCloud("cloudStorageClosingConfirm", prepared);
    if (this.cloud.storage?.mode !== "CLOSING") {
      throw { code: "docs_storage_changed", message: "保存先が変わりました。" };
    }
    this.cloud = { ...this.cloud, provider: "local", status: "local",
      contextGeneration: this.cloud.contextGeneration + 1,
      storage: { ...this.cloud.storage, mode: "LOCAL", epoch: String(Number(this.cloud.storage.epoch) + 1),
        closing: null, changedAt: new Date().toISOString() } };
    return structuredClone(this.cloud);
  }
  async cloudStorageClosingCancel(): Promise<void> {
    this.recordCloud("cloudStorageClosingCancel");
  }
  async onCloudClosingProgress(handler: (progress: ClosingProgress) => void): Promise<() => void> {
    this.cloudClosingProgressListeners.add(handler);
    return () => this.cloudClosingProgressListeners.delete(handler);
  }
  async cloudSetProvider(provider: VaultProviderKind, rebind?: boolean) {
    this.recordCloud("cloudSetProvider", provider, rebind ?? false);
    if (this.providerFailure) throw this.providerFailure;
    const contextGeneration = this.cloud.contextGeneration + Number(provider !== this.cloud.provider || rebind === true);
    this.cloud =
      provider === "niho"
        ? { ...this.cloud, contextGeneration, provider: "niho", status: "active", canRebind: false }
        : { ...this.cloud, contextGeneration, provider: "local", status: "local", migration: null, message: null };
    return structuredClone(this.cloud);
  }
  async cloudSetDeviceName(name: string) {
    this.recordCloud("cloudSetDeviceName", name);
    this.cloud = { ...this.cloud, contextGeneration: this.cloud.contextGeneration + 1, deviceName: name.trim() || "テストの Mac" };
    const reply = structuredClone(this.cloud);
    const gate = this.cloudSetDeviceNameGate;
    if (gate) await gate;
    return reply;
  }
  async cloudProjectStatus(projectId: string) {
    this.recordCloud("cloudProjectStatus", projectId);
    // Native は起動時に profile を同期する。App の実行先ゲートへ完了を返す。
    if (projectId === "profile" && this.cloud.status === "active" && !this.cloudSnapshots.has(projectId)) {
      this.cloudSnapshots.set(projectId, syncSnapshot(projectId, { lastSyncedAt: "2026-10-18T00:00:00.000Z" }));
    }
    const snapshot = this.cloudSnapshots.get(projectId);
    const reply = {
      contextGeneration: this.cloud.contextGeneration,
      snapshot: snapshot ? structuredClone(snapshot) : null,
    };
    const gate = this.cloudProjectStatusGate;
    if (gate) await gate;
    return reply;
  }
  async cloudPageShareGet(pageId: string, projectId: string, textId: string | null = null): Promise<DocsPageShareState> {
    this.pageShareCalls.push({ action: "get", pageId, projectId, textId });
    return this.pageShares.get(`${projectId}:${pageId}:${textId ?? ""}`) ?? { status: "PRIVATE", publicId: null, url: null, updatedAt: null };
  }
  async cloudPageShareSet(pageId: string, projectId: string, textId: string | null, published: boolean): Promise<DocsPageShareState> {
    this.pageShareCalls.push({ action: published ? "publish" : "stop", pageId, projectId, textId });
    const key = `${projectId}:${pageId}:${textId ?? ""}`;
    const previous = await this.cloudPageShareGet(pageId, projectId, textId);
    const publicId = previous.publicId ?? "s".repeat(22);
    const next: DocsPageShareState = { status: published ? "PUBLIC" : "PRIVATE", publicId, url: `https://niho.life/docs/p#${publicId}`, updatedAt: new Date().toISOString() };
    this.pageShares.set(key, next);
    return next;
  }
  async cloudPageShareRotate(pageId: string, projectId: string, textId: string | null, expectedPublicId: string): Promise<DocsPageShareState> {
    this.pageShareCalls.push({ action: "rotate", pageId, projectId, textId });
    const key = `${projectId}:${pageId}:${textId ?? ""}`;
    const previous = await this.cloudPageShareGet(pageId, projectId, textId);
    if (previous.publicId !== expectedPublicId) return previous;
    const publicId = "r".repeat(22);
    const next: DocsPageShareState = { status: "PUBLIC", publicId, url: `https://niho.life/docs/p#${publicId}`, updatedAt: new Date().toISOString() };
    this.pageShares.set(key, next);
    return next;
  }
  async cloudPageShareOpen(url: string): Promise<void> {
    this.pageShareCalls.push({ action: `open:${url}`, pageId: "", projectId: "", textId: null });
  }
  async cloudRemoteProjects() {
    this.recordCloud("cloudRemoteProjects");
    const reply = {
      contextGeneration: this.cloud.contextGeneration,
      projects: this.cloud.status === "active" ? structuredClone(this.remoteProjects) : [],
    };
    const gate = this.cloudRemoteProjectsGate;
    if (gate) await gate;
    return reply;
  }
  async cloudDeletedProjects() {
    this.recordCloud("cloudDeletedProjects");
    return structuredClone(this.deletedProjects);
  }
  /** クラウドにだけある案件を開く（project.json と文書のページ 1 枚を下ろす）。 */
  async cloudOpenProject(projectId: string) {
    this.recordCloud("cloudOpenProject", projectId);
    if (this.openGate) await this.openGate;
    const remote = this.remoteProjects.find((project) => project.projectId === projectId);
    if (!remote) throw { code: "cloud_open_failed", message: "クラウドから開けませんでした。" };
    if (!this.projects.has(projectId)) {
      const createdAt = "2026-10-16T00:00:00.000Z";
      const page: PageEntry = { id: `doc${this.nextId++}`, kind: "doc", title: "クラウドの文書", createdAt };
      const project: FakeProject = { version: 1, id: projectId, name: remote.name, createdAt, info: { terms: [], background: "" }, pages: [page] };
      this.projects.set(projectId, { project, ...emptyData(), recordings: {}, docs: { [page.id]: "クラウドから届いた本文" } });
    }
    this.remoteProjects = this.remoteProjects.map((project) => (project.projectId === projectId ? { ...project, local: true } : project));
  }
  async cloudRestoreProject(projectId: string) {
    this.recordCloud("cloudRestoreProject", projectId);
    this.deletedProjects = this.deletedProjects.filter((project) => project.projectId !== projectId);
  }
  async cloudTombstoneChoice(projectId: string, choice: TombstoneChoice) {
    this.recordCloud("cloudTombstoneChoice", projectId, choice);
  }
  async cloudSyncNow(projectId: string | null) {
    this.recordCloud("cloudSyncNow", projectId);
    if (this.personalAutoSync) {
      const id = projectId ?? DOCS_ROOT_PROJECT_ID;
      const snapshot = this.cloudSnapshots.get(id) ?? syncSnapshot(id);
      this.cloudSnapshots.set(id, {
        ...snapshot,
        syncing: false,
        dirty: {},
        pendingMutation: false,
        acknowledgedGeneration: snapshot.localGeneration,
        lastError: null,
        lastSyncedAt: new Date(Date.now() + this.cloudCalls.length).toISOString(),
      });
    }
  }
  async cloudFocus(projectId: string | null) {
    this.recordCloud("cloudFocus", projectId);
  }
  async cloudProtect(projectId: string, paths: string[]) {
    this.recordCloud("cloudProtect", projectId, [...paths]);
    const id = this.nextProtection++;
    this.protections.set(id, { projectId, paths: [...paths] });
    return id;
  }
  async cloudRelease(id: number) {
    this.recordCloud("cloudRelease", id);
    this.protections.delete(id);
  }
  /** 今守っている path（案件 → path）。 */
  protectedPaths(projectId: string): string[] {
    return [...this.protections.values()].filter((item) => item.projectId === projectId).flatMap((item) => item.paths);
  }
  async cloudConflicts(projectId: string) {
    this.recordCloud("cloudConflicts", projectId);
    return structuredClone(this.conflictEntries.get(projectId) ?? []);
  }
  async cloudConflictCopy(projectId: string, conflictId: string, side: ConflictSide) {
    this.recordCloud("cloudConflictCopy", projectId, conflictId, side);
    return this.conflictCopies.get(conflictId)?.[side] ?? null;
  }
  /** 競合を解決する（選んだ内容を今の文書に書き、その競合を消す。文書のページ・成果物だけ中身を書く）。 */
  async cloudResolveConflict(projectId: string, conflictId: string, choice: ResolveChoice, text?: string | null, remoteSha256?: string | null) {
    this.recordCloud("cloudResolveConflict", projectId, conflictId, choice, text ?? null, remoteSha256 ?? null);
    if (this.resolveFailure) {
      const failure = this.resolveFailure;
      this.resolveFailure = null;
      throw failure;
    }
    const entries = this.conflictEntries.get(projectId) ?? [];
    const entry = entries.find((candidate) => candidate.conflictId === conflictId);
    if (!entry) throw { code: "conflict_changed", message: "クラウドの内容がまた変わりました。もう一度確かめてください。" };
    const copies = this.conflictCopies.get(conflictId);
    const content = choice === "merged" ? (text ?? null) : choice === "remote" ? (copies?.remote ?? null) : undefined;
    const page = /^pages\/([^/]+)\.md$/.exec(entry.path)?.[1];
    const stored = this.projects.get(projectId);
    if (page && stored && content !== undefined && content !== null) stored.docs[page] = content;
    this.conflictEntries.set(
      projectId,
      entries.filter((candidate) => candidate.conflictId !== conflictId),
    );
    const snapshot = this.cloudSnapshots.get(projectId);
    if (snapshot) {
      this.cloudSnapshots.set(projectId, { ...snapshot, conflicts: snapshot.conflicts.filter((item) => item.conflictId !== conflictId) });
      this.emitCloudProject(projectId);
    }
  }
  async cloudUsage() {
    this.recordCloud("cloudUsage");
    return this.cloudUsageValue ? structuredClone(this.cloudUsageValue) : null;
  }
  async cloudMigrationStart() {
    this.recordCloud("cloudMigrationStart");
    const total = this.projects.size;
    this.cloud = { ...this.cloud, migration: { running: true, cancelled: false, total, done: 0, bytesTotal: 0, bytesDone: 0, failed: [] } };
    return structuredClone(this.cloud);
  }
  async cloudMigrationCancel() {
    this.recordCloud("cloudMigrationCancel");
    const migration = this.cloud.migration;
    this.cloud = { ...this.cloud, migration: migration ? { ...migration, running: false, cancelled: true } : null };
    return structuredClone(this.cloud);
  }
  /** 書きかけを今の path に書く（版は作らない。この案件の実行中は断る）。 */
  async writeArtifactDraft(rec: RecordingRef, stepId: string, source: boolean, markdown: string) {
    const data = this.requireRec(rec);
    if (this.locks.has(rec.projectId)) throw { code: "store_busy", message: "実行中は書き換えられません。" };
    if (source) data.transcript = markdown;
    else data.artifacts[stepId] = markdown;
    const key = conversationKey(rec);
    const steps = this.drafted.get(key) ?? new Set<string>();
    steps.add(stepId);
    this.drafted.set(key, steps);
    this.artifactDraftWrites.push({ projectId: rec.projectId, recordingId: rec.recordingId, stepId, markdown });
    const prefix = rec.recordingId === ROOT_RECORDING_ID ? "" : `recordings/${rec.recordingId}/`;
    return this.noteSave(rec.projectId, source ? `${prefix}transcript.md` : `${prefix}artifacts/${stepId}.md`);
  }
  async onCloudState(handler: (state: CloudState) => void) {
    this.cloudStateListeners.add(handler);
    return () => {
      this.cloudStateListeners.delete(handler);
    };
  }
  async onCloudProject(handler: (event: CloudProjectEvent) => void) {
    this.cloudProjectListeners.add(handler);
    return () => {
      this.cloudProjectListeners.delete(handler);
    };
  }
  async onCloudApplied(handler: (event: CloudAppliedEvent) => void) {
    this.cloudAppliedListeners.add(handler);
    return () => {
      this.cloudAppliedListeners.delete(handler);
    };
  }
  async onCloudRemote(handler: (event: CloudRemoteEvent) => void) {
    this.cloudRemoteListeners.add(handler);
    return () => {
      this.cloudRemoteListeners.delete(handler);
    };
  }

  // ---- この Mac で続きを受ける（#18804 S2。src-tauri/src/pc_runner.rs の代わり）----

  /** 今の状態（既定は OFF）。 */
  pcRunner: PcRunnerStatus = { enabled: false, state: "off", label: null, runnerId: null };
  /** 入れると次の setPcRunnerEnabled が投げる（1 回だけ）。 */
  pcRunnerFailure: { code: string; message: string } | null = null;
  /** setPcRunnerEnabled の呼び出し（順に）。 */
  pcRunnerCalls: boolean[] = [];
  private pcRunnerListeners = new Set<(status: PcRunnerStatus) => void>();
  async pcRunnerStatus() {
    return { ...this.pcRunner };
  }
  async setPcRunnerEnabled(enabled: boolean) {
    this.pcRunnerCalls.push(enabled);
    const failure = this.pcRunnerFailure;
    if (failure) {
      this.pcRunnerFailure = null;
      throw failure;
    }
    this.emitPcRunner(enabled
      ? { enabled: true, state: "idle", label: null, runnerId: "runner_mac_1" }
      : { enabled: false, state: "off", label: null, runnerId: this.pcRunner.runnerId });
    return { ...this.pcRunner };
  }
  async onPcRunnerState(handler: (status: PcRunnerStatus) => void) {
    this.pcRunnerListeners.add(handler);
    return () => {
      this.pcRunnerListeners.delete(handler);
    };
  }
  /** Rust の `pc-runner://state` の代わり（状態を変えて、購読している画面へ届ける）。 */
  emitPcRunner(status: PcRunnerStatus) {
    this.pcRunner = { ...status };
    for (const listener of [...this.pcRunnerListeners]) listener({ ...status });
  }
  async accountAvailable() {
    return this.accountOpen;
  }
  async docsDriveConnection() {
    this.docsDriveConnectionCalls += 1;
    return { ...this.docsDrive };
  }
  async docsDriveConnect() {
    this.docsDriveConnectCalls += 1;
  }
  async docsDriveDisconnect() {
    this.docsDriveDisconnectCalls += 1;
    this.docsDrive = { status: "DISCONNECTED", connectedEmail: null, reason: null };
    return { ...this.docsDrive };
  }
  async docsDriveExport(request: DocsDriveExportRequest) {
    this.docsDriveExportRequests.push(structuredClone(request));
    const next = this.docsDriveExportResults.shift();
    if (next && "code" in next) throw next;
    return next ?? { exportId: request.exportId, status: "completed" as const, documentId: "fake_document_123", url: "https://docs.google.com/document/d/fake_document_123/edit" };
  }
  async docsDriveExportStatus(exportId: string) {
    this.docsDriveStatusIds.push(exportId);
    const next = this.docsDriveStatusResults.shift();
    if (next && "code" in next) throw next;
    return next ?? { exportId, status: "pending" as const, retryable: false };
  }
  async docsDriveOpenDocument(documentId: string) {
    this.docsDriveOpenedIds.push(documentId);
  }
  async docsDriveFolderExportPlan(projectId: string) {
    this.folderExportPlanCalls.push(projectId);
    const next = this.folderExportPlanResults.shift();
    if (next && "code" in next) throw next;
    const plan = next ?? this.folderExportPlans.get(projectId);
    if (!plan) throw { code: "folder_not_found", message: "フォルダが見つかりませんでした。" };
    return structuredClone(plan);
  }
  async docsDriveFolderExportLocalPlan(projectId: string) {
    this.folderExportLocalPlanCalls.push(projectId);
    const plan = this.folderExportPlans.get(projectId);
    if (!plan) throw { code: "folder_not_found", message: "フォルダが見つかりませんでした。" };
    return { ...structuredClone(plan), revision: 0, nodes: [] };
  }
  async docsDriveFolderExportLocalSnapshot(projectId: string) {
    const stored = this.projects.get(projectId);
    if (!stored) throw { code: "folder_not_found", message: "フォルダが見つかりませんでした。" };
    const texts: Record<string, string> = { "project.json": JSON.stringify(stored.project) };
    for (const [id, markdown] of Object.entries(stored.docs)) texts[`pages/${id}.md`] = markdown;
    const files = Object.entries(texts).map(([path, value]) => ({ path, bytes: new TextEncoder().encode(value).length,
      sha256: "a".repeat(64) }));
    return { generation: this.cloud.contextGeneration, files, texts: { "project.json": JSON.stringify(stored.project) } };
  }
  async docsDriveFolderExportLocalText(projectId: string, generation: number, file: { path: string }) {
    if (generation !== this.cloud.contextGeneration) throw { code: "folder_changed", message: "" };
    const stored = this.projects.get(projectId);
    if (!stored) throw { code: "folder_not_found", message: "" };
    if (file.path === "project.json") return JSON.stringify(stored.project);
    const id = file.path.match(/^pages\/([^/]+)\.md$/)?.[1];
    if (id && id in stored.docs) return stored.docs[id]!;
    throw { code: "folder_changed", message: "" };
  }
  async docsDriveFolderExportLocal(request: DocsDriveFolderExportRequest, generation: number,
    files: Array<{ path: string }>) {
    this.folderExportLocalFiles.push({ generation, paths: files.map((file) => file.path) });
    return this.docsDriveFolderExport(request);
  }
  async docsDriveFolderExport(request: DocsDriveFolderExportRequest) {
    this.folderExportRequests.push(structuredClone(request));
    const next = this.folderExportResults.shift();
    if (next && "code" in next) throw next;
    return next ?? folderExportBuilding(request.exportId, 0, request.include.length);
  }
  async docsDriveFolderExportStatus(exportId: string) {
    this.folderExportStatusIds.push(exportId);
    const next = this.folderExportStatusResults.shift();
    if (next && "code" in next) throw next;
    return next ?? folderExportCompleted(exportId);
  }
  async docsDriveFolderExportResume(exportId: string) {
    this.folderExportResumeIds.push(exportId);
    const next = this.folderExportResumeResults.shift();
    if (next && "code" in next) throw next;
    return next ?? folderExportBuilding(exportId, 0, 1);
  }

  // ---- 本人 Mac 実行（R6 #18739。src-tauri/src/personal_run.rs の代わり。規則は Native と同じ） ----

  /** ログインしている本人の accountKey（null はログインしていない）。 */
  personalOwner: string | null = "a".repeat(64);
  /** 保存先 root の id。 */
  personalRootId = "r_AAAAAAAAAAAAAAAAAAAAAA";
  /** NIHO に届かない（lease を取れない）。端末内の文字起こし（this-mac）だけ始められる。 */
  personalLeaseUnavailable = false;
  /** 開いている operation（handle → 中身）。 */
  personalOps = new Map<string, FakePersonalOperation>();
  /** 実行の記録（`<owner>/<root>/<intentId>` → 記録）。app data に残る（新しい FakeBridge には引き継がない）。 */
  personalIntents = new Map<string, FakePersonalIntent>();
  /** intent の private 領域の途中記録（`<intentId>/<kind>` → 中身）。 */
  personalPrivate = new Map<string, unknown>();
  /** 不変の版ファイル（`<projectId|_outside>/<path>` → 本文）。 */
  personalVersionFiles = new Map<string, string>();
  /** 実行の集約（runId → PersonalRunHistory）。 */
  personalAggregates = new Map<string, PersonalRunHistory>();
  /** 返した lease（通信して返したものだけ。本人が変わった後は通信しない）。 */
  personalLeaseReleases: string[] = [];
  private nextPersonal = 1;

  /** 本人が切り替わった（開いている operation の guard は ownerAccountId を空で返し、送信・公開を断る）。 */
  switchPersonalAccount(owner: string | null) {
    this.personalOwner = owner;
    for (const op of this.personalOps.values()) op.accountChanged = true;
  }

  /** 開いている operation の lease を失った（guard は別の leaseId を返す）。 */
  losePersonalLease(handle: string) {
    const op = this.personalOps.get(handle);
    if (op) op.leaseLost = true;
  }

  private personalOp(handle: string): FakePersonalOperation {
    const op = this.personalOps.get(handle);
    if (!op || op.closed) throw PERSONAL_OPERATION_MISSING;
    return op;
  }

  private personalIntentKey(op: FakePersonalOperation): string {
    return `${op.ownerAccountId}/${op.rootId}/${op.request.intentId}`;
  }

  private personalCurrentOk(op: FakePersonalOperation): boolean {
    return !op.accountChanged && this.personalOwner === op.ownerAccountId;
  }

  private personalRecording(op: FakePersonalOperation): StoredRecordingData & { recording: RecordingFile; projectInfo: Project["info"]; refs: string[] } {
    const stored = this.require(op.request.projectId);
    if (op.request.recordingId === ROOT_RECORDING_ID && op.request.recordingPageId === ROOT_RECORDING_ID && stored.project.flowSnapshot) {
      const recording = stored.project as RecordingFile;
      return { ...stored, recording, projectInfo: stored.project.info, refs: [] };
    }
    const page = this.pagesOf(stored).find((candidate) => candidate.id === op.request.recordingPageId);
    if (!page) throw NO_PAGE;
    const found = stored.recordings[op.request.recordingId];
    if (page.kind !== "rec" || (page.recordingId ?? page.id) !== op.request.recordingId || !found || op.request.recordingId === ROOT_RECORDING_ID) throw NO_RECORDING;
    return { ...found, recording: found.recording, projectInfo: stored.project.info, refs: found.recording.refs ?? [] };
  }

  private personalGuardFailed(op: FakePersonalOperation, kind: "turn" | "audio_part" | "this_mac" | "audio_prepare" | "deepgram"): boolean {
    if (op.closed || op.cancelled || !this.personalCurrentOk(op) || op.leaseLost) return true;
    const route = op.request.route;
    const local = route.kind !== "generation_only";
    const allowed = kind === "turn"
      ? op.cloudLease && (route.kind === "local_full" || (route.kind === "generation_only" && route.executor === "this_pc"))
      : kind === "this_mac"
        ? local && op.request.transcriptionProvider === "this-mac"
        : op.cloudLease && local && op.request.transcriptionProvider === (kind === "deepgram" ? "deepgram" : "gemini");
    if (!allowed) return true;
    if ((kind === "turn" || kind === "audio_part" || kind === "deepgram") && !op.dispatchOpen) return true;
    return false;
  }

  /** 送信の command に operation が添えられたとき（Native の send_guard と同じ）。 */
  private sendGuard(
    operation: string | null | undefined,
    kind: "turn" | "audio_part" | "this_mac" | "audio_prepare" | "deepgram",
    geminiApi?: boolean,
  ) {
    if (!operation) return;
    const op = this.personalOps.get(operation);
    if (!op || this.personalGuardFailed(op, kind)) throw PERSONAL_GUARD_FAILED;
    // 区切りの送信は、固定した文字起こしの方式と同じ提供元だけ（Native の gemini_transcription_matches と同じ）
    if (geminiApi !== undefined && personalTranscriptionKey(op.request) !== (geminiApi ? "gemini-api" : "gemini")) throw PERSONAL_GUARD_FAILED;
  }

  async personalOpen(request: PersonalOpenRequest): Promise<PersonalOperationInfo> {
    this.personalCalls.push({ name: "personalOpen", args: [structuredClone(request)] });
    const route = request.route;
    const local = route.kind === "local_full" || route.kind === "local_transcription_only";
    const key = personalTranscriptionKey(request);
    const routeOk = local
      ? key !== undefined && key !== null
      : route.kind === "generation_only" && ["this_pc", "niho_api", "device_niho_api"].includes(route.executor) && key === null;
    if (!routeOk) throw { code: "personal_bad_request", message: "実行の依頼の形が正しくありません。" };
    if (!this.personalOwner) throw { code: "personal_not_signed_in", message: "NIHO アカウントでログインしてから実行してください。" };
    const owner = this.personalOwner;
    const draft: FakePersonalOperation = {
      handle: "", request: structuredClone(request), ownerAccountId: owner, rootId: this.personalRootId, leaseId: "", cloudLease: true,
      cancelled: false, closed: false, accountChanged: false, leaseLost: false, reserved: false, dispatchOpen: false, head: null,
      receipts: [], candidates: new Map(), audio: [],
    };
    this.personalRecording(draft);
    // 実行のロック（acquireRunLock と同じ鍵）→ lease（フォルダ外も予約の docs-root の lease を取る）
    if (this.locks.has(request.projectId)) throw { code: "store_busy", message: "実行中の録音があります。終わってから、もう一度実行してください。" };
    this.locks.add(request.projectId);
    if (this.leaseHeldBy !== null && !(route.kind === "generation_only" && route.executor === "device_niho_api")) {
      this.locks.delete(request.projectId);
      throw { code: "lease_held", message: `別の Mac（${this.leaseHeldBy}）で実行中です。終わってから実行してください。` };
    }
    if (route.kind === "generation_only" && route.executor === "device_niho_api") draft.cloudLease = false;
    else if (this.personalLeaseUnavailable) {
      if (!(route.kind === "local_transcription_only" && request.transcriptionProvider === "this-mac")) {
        this.locks.delete(request.projectId);
        throw { code: "personal_lease_unavailable", message: "NIHO に接続できないため、外部の AI を使う工程は始められません。端末内の文字起こしだけ始められます。" };
      }
      draft.cloudLease = false;
    }
    const serial = String(this.nextPersonal++);
    draft.handle = `pop_${serial.padStart(32, "0")}`;
    draft.leaseId = `ls_${serial.padStart(22, "0")}`;
    this.personalOps.set(draft.handle, draft);
    return { handle: draft.handle, ownerAccountId: owner, rootId: draft.rootId, leaseId: draft.leaseId, cloudLease: draft.cloudLease, contextGeneration: this.cloud.contextGeneration, deviceId: "d_fake" };
  }

  async personalCancel(handle: string) {
    this.personalCalls.push({ name: "personalCancel", args: [handle] });
    const op = this.personalOps.get(handle);
    if (!op) return false;
    op.cancelled = true;
    return true;
  }

  async personalClose(handle: string) {
    const op = this.personalOps.get(handle);
    if (!op) return { released: false, leaseId: "" };
    this.personalOps.delete(handle);
    op.closed = true;
    op.cancelled = true;
    this.locks.delete(op.request.projectId);
    if (op.cloudLease && !op.leaseLost && this.personalCurrentOk(op)) this.personalLeaseReleases.push(op.leaseId);
    return { released: true, leaseId: op.leaseId };
  }

  async personalGuard(handle: string, phase: PersonalGuardPhase, snapshot?: PersonalFixedSnapshot | null): Promise<PersonalGuardResult> {
    if (!["before_dispatch", "before_persist", "before_cas"].includes(phase)) throw { code: "personal_bad_request", message: "実行の依頼の形が正しくありません。" };
    const op = this.personalOp(handle);
    const current = this.personalCurrentOk(op);
    if (current && snapshot && op.head) {
      const accepted = await acceptDerived(op.head, op.receipts, snapshot);
      if (accepted) op.head = accepted;
    }
    return {
      ownerAccountId: current ? op.ownerAccountId : "",
      rootId: op.rootId,
      snapshotSha256: op.head?.snapshotSha256 ?? "",
      leaseId: op.leaseLost ? "" : op.leaseId,
      cancelled: op.cancelled,
    };
  }

  private personalSnapshotMatches(op: FakePersonalOperation, snapshot: PersonalFixedSnapshot, derived: boolean): boolean {
    const container = op.request.projectId === null ? { kind: "root" } : { kind: "folder", projectId: op.request.projectId };
    const identity = snapshot.ownerAccountId === op.ownerAccountId && snapshot.rootId === op.rootId &&
      snapshot.recordingPageId === op.request.recordingPageId && snapshot.recordingId === op.request.recordingId &&
      canonical(snapshot.containerRef) === canonical(container);
    if (derived) return identity;
    const key = personalTranscriptionKey(op.request);
    const transcription = key ? PERSONAL_TRANSCRIPTION_MODELS[key] : null;
    return identity && snapshot.schemaVersion === 1 && canonical(snapshot.route) === canonical(op.request.route) &&
      canonical(snapshot.transcriptionModel) === canonical(transcription) && canonical(snapshot.outputTarget ?? null) === canonical(op.request.outputTarget ?? null);
  }

  async personalReserveIntent(handle: string, intentId: string, snapshot: PersonalFixedSnapshot): Promise<PersonalReserveResult> {
    const op = this.personalOp(handle);
    if (intentId !== op.request.intentId) throw PERSONAL_INTENT_MISMATCH;
    if (op.cancelled || !this.personalCurrentOk(op)) throw PERSONAL_GUARD_FAILED;
    if (!(await snapshotHashValid(snapshot))) throw { code: "personal_snapshot_invalid", message: "固定した入力の形が正しくありません。もう一度実行してください。" };
    const audioMatches = snapshot.input.audio.length === op.audio.length &&
      snapshot.input.audio.every((item, index) => item.path === op.audio[index]!.path && item.sha256 === op.audio[index]!.sha256 && item.bytes === op.audio[index]!.bytes);
    if (!this.personalSnapshotMatches(op, snapshot, false) || !audioMatches) throw { code: "personal_snapshot_mismatch", message: "固定した入力が、この実行の録音・アカウント・保存先と一致しません。" };
    const key = this.personalIntentKey(op);
    const existing = this.personalIntents.get(key);
    let result: PersonalReserveResult;
    if (!existing) {
      this.personalIntents.set(key, { state: "reserved", snapshotSha256: snapshot.snapshotSha256, dispatches: [] });
      result = { status: "new" };
    } else if (existing.dispatches.some((marker) => !marker.terminal)) {
      result = { status: "existing", state: "result_unknown" };
    } else if (
      // 同じ固定入力の waiting_auth と、受け付けたまま送らずに終わった reserved は再開する（開いている operation が受け付けている間は除く。Native と同じ）
      (existing.state === "waiting_auth" ||
        (existing.state === "reserved" && ![...this.personalOps.values()].some((other) => !other.closed && other.reserved && this.personalIntentKey(other) === key))) &&
      existing.snapshotSha256 === snapshot.snapshotSha256
    ) {
      existing.state = "reserved";
      result = { status: "resumed" };
    } else {
      result = { status: "existing", state: (existing.state === "reserved" ? "running" : existing.state) as PersonalRunState };
    }
    if (result.status !== "existing") {
      op.reserved = true;
      op.head = structuredClone(snapshot);
      op.dispatchOpen = false;
    }
    return result;
  }

  private personalIntent(op: FakePersonalOperation): FakePersonalIntent {
    const intent = op.reserved ? this.personalIntents.get(this.personalIntentKey(op)) : undefined;
    if (!intent) throw { code: "personal_intent_not_reserved", message: "実行の受付が済んでいません。" };
    return intent;
  }

  private personalStepSelectable(op: FakePersonalOperation, stepId: string): boolean {
    if (stepId === SOURCE_STEP_ID) return op.request.route.kind !== "generation_only";
    return op.head?.selectedStepIds.includes(stepId) ?? false;
  }

  async personalMarkDispatch(handle: string, intentId: string, stepId: string) {
    const op = this.personalOp(handle);
    if (intentId !== op.request.intentId) throw PERSONAL_INTENT_MISMATCH;
    if (!this.personalStepSelectable(op, stepId)) throw { code: "personal_bad_request", message: "実行の依頼の形が正しくありません。" };
    if (op.cancelled || !this.personalCurrentOk(op) || op.leaseLost) throw PERSONAL_GUARD_FAILED;
    const intent = this.personalIntent(op);
    if (intent.state !== "reserved" && intent.state !== "running") throw { code: "personal_intent_closed", message: "この実行の記録はすでに終わっています。" };
    intent.state = "running";
    intent.dispatches.push({ stepId, terminal: false });
    op.dispatchOpen = true;
  }

  async personalMarkIntent(handle: string, intentId: string, state: PersonalRunState) {
    const op = this.personalOp(handle);
    if (intentId !== op.request.intentId) throw PERSONAL_INTENT_MISMATCH;
    const intent = this.personalIntent(op);
    if (intent.state === "result_unknown") return;
    // 結果の分かった intent（NIHO API の受付を Native が確かめた submitted など）を、後から結果不明に戻さない
    if (state === "result_unknown" && PERSONAL_TERMINAL_STATES.has(intent.state)) return;
    intent.state = state;
    if (PERSONAL_TERMINAL_STATES.has(state)) {
      intent.dispatches.forEach((marker) => { marker.terminal = true; });
      op.dispatchOpen = false;
    }
  }

  async personalSavePrivate(handle: string, intentId: string, kind: PersonalPrivateKind, payload: unknown) {
    const op = this.personalOp(handle);
    if (intentId !== op.request.intentId) throw PERSONAL_INTENT_MISMATCH;
    if (!["checkpoint", "partial_output", "run_record"].includes(kind)) throw { code: "personal_bad_request", message: "実行の依頼の形が正しくありません。" };
    this.personalIntent(op);
    this.personalPrivate.set(`${intentId}/${kind}`, structuredClone(payload));
  }

  async personalReadMaterial(handle: string, request: { stepIds: string[] }): Promise<PersonalMaterial> {
    const op = this.personalOp(handle);
    if (!this.personalCurrentOk(op)) throw PERSONAL_GUARD_FAILED;
    if (op.reserved) throw { code: "personal_material_locked", message: "実行を受け付けた後は、素材を読み直せません。もう一度実行してください。" };
    const data = this.personalRecording(op);
    const flow = data.recording.flowSnapshot;
    const stepIds = flow.steps.map((step) => step.id);
    if (request.stepIds.some((stepId) => !stepIds.includes(stepId))) throw { code: "personal_bad_request", message: "実行の依頼の形が正しくありません。" };
    const selected = stepIds.filter((stepId) => request.stepIds.includes(stepId));
    const rid = op.request.recordingId;
    const local = op.request.route.kind !== "generation_only";
    const source = data.recording.source;
    const audio = local && source.kind === "audio"
      ? source.audio.map((item) => ({ path: `recordings/${rid}/inputs/${item.file}`, sha256: item.hash, bytes: PERSONAL_FAKE_AUDIO_BYTES, durationSec: item.durationSec, verification: "native_sha256" as const }))
      : [];
    op.audio = audio.map((item) => ({ path: item.path, sha256: item.sha256, bytes: item.bytes }));
    const latest = async (stepId: string) => {
      const texts = data.versions[stepId] ?? [];
      const number = texts.length;
      if (number === 0) return null;
      // 版の置き場（文字起こしの別案は artifactId。Native の newest_version_row と同じ）
      const row = [...data.runs].reverse().find((run) => (run.artifactId ?? run.stepId) === stepId && run.version === number);
      const content = texts[number - 1]!;
      const path = (row?.versionPath as string | undefined) ?? `recordings/${rid}/versions/${stepId}/v${number}.md`;
      return { versionId: path.split("/").at(-1)!.replace(/\.md$/, ""), path, content, expectedSha256: await sha256Text(content), row };
    };
    // 原文は後工程に使う文字起こしの案（#19108。指定が台帳に無ければ断る。Native の selected_source_artifact と同じ）
    let sourceArtifactId: string;
    try {
      sourceArtifactId = selectedSourceArtifactId(data.recording);
    } catch {
      throw { code: "source_candidate_missing", message: "後工程に使う文字起こしが見つかりません。録音のページで選び直してください。" };
    }
    const latestSource = await latest(sourceArtifactId);
    const sourceOrigin = latestSource ? personalVersionOrigin(latestSource.row) : null;
    const sourceLatest = sourceOrigin ? latestSource : null;
    const last = selected.length > 0 ? stepIds.indexOf(selected.at(-1)!) : -1;
    const priorSteps = [];
    for (const stepId of stepIds.slice(0, Math.max(last, 0)).filter((candidate) => !selected.includes(candidate))) {
      const version = await latest(stepId);
      if (version) priorSteps.push({ stepId, versionId: version.versionId, path: version.path, content: version.content, expectedSha256: version.expectedSha256 });
    }
    const stored = this.require(op.request.projectId);
    const pages = this.pagesOf(stored);
    const references = [];
    const titles = [];
    const autoReferencePages = op.request.projectId === null ? [] : pages.filter((page) => page.kind === "doc" && !page.derivation);
    for (const page of autoReferencePages) {
      const pageId = page.id;
      const content = stored.docs[pageId] ?? "";
      if (!content.trim()) continue;
      const sha = await sha256Text(content);
      titles.push({ pageId, title: page.title });
      references.push({ pageId, path: `pages/${pageId}.md`, versionId: `p_${sha.slice(0, 32)}`, content, expectedSha256: sha });
    }
    const expected: Record<string, string | null> = {};
    for (const stepId of selected) {
      const artifactId = op.request.outputTarget?.stepId === stepId ? op.request.outputTarget.artifactId : stepId;
      expected[stepId] = data.artifacts[artifactId] === undefined ? null : await sha256Text(data.artifacts[artifactId]!);
    }
    if (local) {
      // 文字起こしの別案を作る実行は、その案の今の本文を照合値にする
      const sourceTarget = op.request.outputTarget?.stepId === SOURCE_STEP_ID ? op.request.outputTarget.artifactId : SOURCE_STEP_ID;
      const current = sourceTarget === SOURCE_STEP_ID ? data.transcript : (data.artifacts[sourceTarget] ?? null);
      expected[SOURCE_STEP_ID] = current === null ? null : await sha256Text(current);
    }
    const info = op.request.projectId === null ? { terms: [], background: "" } : data.projectInfo;
    const recording = data.recording as RecordingFile & { speakers?: SpeakerMode; language?: "ja" | "en" };
    const speakers = recording.speakers ?? info.speakers ?? "auto";
    const language = recording.language ?? info.language ?? "ja";
    const terms = info.terms.map((term) => ({ term: term.term, reading: term.reading, variants: [...term.variants], note: term.note }));
    const about = this.aboutFiles.get(this.aboutRoot) ?? null;
    const hashed = async <T,>(value: T) => ({ value, sha256: await sha256Text(canonical(value)) });
    return {
      baseManifestRevision: 0,
      recordingMetadata: {
        speakers,
        language,
        background: info.background,
        terms,
        sourceName: source.kind === "text" ? "文章" : "文字起こし",
      },
      flow: structuredClone(flow),
      audio,
      transcriptionModel: local && personalTranscriptionKey(op.request) ? structuredClone(PERSONAL_TRANSCRIPTION_MODELS[personalTranscriptionKey(op.request)!]) : null,
      sourceArtifactId,
      sourceVersion: sourceLatest
        ? {
            versionId: sourceLatest.versionId,
            path: sourceLatest.path,
            originRunId: personalOriginRunId(sourceLatest.row),
            origin: sourceOrigin!,
            content: sourceLatest.content,
            expectedSha256: sourceLatest.expectedSha256,
            synced: true,
          }
        : null,
      referencePages: references,
      priorSteps,
      expectedCurrentArtifactShaByStep: expected,
      promptMaterials: {
        about: await hashed(about ? { name: about.name, text: about.text } : null),
        referenceTitles: await hashed(titles),
        info: await hashed({ speakers, language, terms, background: info.background, entities: structuredClone(info.entities ?? []) }),
      },
    };
  }

  async personalSwapModels(handle: string, expectedFlow: FlowSnapshot, models: Record<string, ResolvedStepModel>): Promise<boolean> {
    const op = this.personalOp(handle);
    this.personalCalls.push({ name: "personalSwapModels", args: [handle, structuredClone(expectedFlow), structuredClone(models)] });
    if (!this.personalCurrentOk(op) || op.cancelled || op.request.route.kind !== "generation_only" || op.request.route.executor !== "niho_api") {
      throw PERSONAL_GUARD_FAILED;
    }
    const recording = this.personalRecording(op).recording;
    if (canonical(recording.flowSnapshot) !== canonical(expectedFlow)) return false;
    recording.flowSnapshot = { ...recording.flowSnapshot, models: { ...recording.flowSnapshot.models, ...structuredClone(models) } };
    return true;
  }

  async personalVerifyInputs(handle: string, snapshot: PersonalFixedSnapshot) {
    const op = this.personalOp(handle);
    if (!(await snapshotHashValid(snapshot))) return { verified: false, reason: "固定した入力の形が正しくありません。" };
    if (!this.personalSnapshotMatches(op, snapshot, true)) return { verified: false, reason: "固定した入力が、この実行の録音と一致しません。" };
    for (const audio of snapshot.input.audio) {
      const known = op.audio.find((item) => item.path === audio.path);
      if (!known || known.sha256 !== audio.sha256 || known.bytes !== audio.bytes || this.missingAudio.has(audio.path.split("/").at(-1)!)) {
        return { verified: false, reason: "音声の内容が変わりました。" };
      }
    }
    return { verified: true };
  }

  async personalPersistCandidate(handle: string, input: PersonalCandidateInput): Promise<PersonalStoredCandidate> {
    const op = this.personalOp(handle);
    const mismatch = { code: "personal_candidate_mismatch", message: "AI の結果が、実行を始めたときの工程・内容と一致しません。" };
    if ((input.kind === "source") !== (input.stepId === SOURCE_STEP_ID) || !this.personalStepSelectable(op, input.stepId)) throw mismatch;
    const artifactId = op.head?.outputTarget?.stepId === input.stepId ? op.head.outputTarget.artifactId : input.stepId;
    if (input.artifactId !== artifactId) throw mismatch;
    if ((await sha256Text(input.text)) !== input.sha256 || new TextEncoder().encode(input.text).byteLength !== input.bytes) throw mismatch;
    const fixed = input.kind === "source" ? op.head?.transcriptionModel : op.head?.fixedModels[input.stepId];
    if (!fixed) throw { code: "personal_intent_not_reserved", message: "実行の受付が済んでいません。" };
    if (fixed.provider !== input.provider || fixed.model !== input.model) throw mismatch;
    // 版のファイル名は保管庫の版 ID（v_ ＋ 22 字）で versionId と同じ（数字だけの旧形式の連番の名前は書かない）
    if (!PERSONAL_VERSION_ID.test(input.versionId) || input.path !== `recordings/${op.request.recordingId}/versions/${artifactId}/${input.versionId}.md`) {
      throw { code: "personal_path_not_allowed", message: "録音の版の場所が正しくありません。" };
    }
    const fileKey = `${op.request.projectId ?? "_outside"}/${input.path}`;
    const existing = this.personalVersionFiles.get(fileKey);
    if (existing !== undefined && existing !== input.text) throw { code: "personal_candidate_collision", message: "同じ場所に別の内容の版があります。もう一度実行してください。" };
    this.personalVersionFiles.set(fileKey, input.text);
    const stored: PersonalStoredCandidate = {
      stepId: input.stepId, artifactId, kind: input.kind, versionId: input.versionId, path: input.path, provider: input.provider, model: input.model,
      ...("reportedModel" in input ? { reportedModel: input.reportedModel } : {}),
      sha256: input.sha256, bytes: input.bytes, immutable: true,
    };
    op.candidates.set(input.versionId, { ...structuredClone(stored), text: input.text });
    const intent = op.reserved ? this.personalIntents.get(this.personalIntentKey(op)) : undefined;
    if (intent) {
      intent.dispatches.filter((marker) => marker.stepId === input.stepId).forEach((marker) => { marker.terminal = true; });
      op.dispatchOpen = intent.dispatches.some((marker) => !marker.terminal);
    }
    return structuredClone(stored);
  }

  async personalPublish(handle: string, input: PersonalPublishInput): Promise<PersonalPublishResult> {
    const op = this.personalOp(handle);
    if (input.intentId !== op.request.intentId) throw PERSONAL_INTENT_MISMATCH;
    if (op.cancelled || !this.personalCurrentOk(op) || op.leaseLost) throw PERSONAL_GUARD_FAILED;
    const candidate = op.candidates.get(input.candidateVersionId);
    if (!candidate || candidate.stepId !== input.stepId || candidate.artifactId !== input.artifactId || candidate.kind !== input.kind) throw { code: "personal_candidate_missing", message: "保存した候補が見つかりません。" };
    if (!op.head) throw { code: "personal_intent_not_reserved", message: "実行の受付が済んでいません。" };
    const recorded = op.head.input.expectedCurrentArtifactShaByStep[input.kind === "source" ? SOURCE_STEP_ID : input.stepId];
    if (recorded === undefined || recorded !== input.expectedCurrentSha) throw { code: "personal_expected_mismatch", message: "本文の照合値が、受け付けた固定入力と一致しません。" };
    const data = this.personalRecording(op);
    const source = input.kind === "source";
    // 最初の文字起こしだけが transcript.md。文字起こしの別案は artifacts/<artifactId>.md（#19108）
    const transcriptFile = source && input.artifactId === SOURCE_STEP_ID;
    if (source && !transcriptFile && !Object.values(data.recording.candidateSets?.[SOURCE_STEP_ID]?.items ?? {}).some((item) => item.artifactId === input.artifactId)) {
      throw { code: "personal_target_deleted", message: "この文字起こしは削除されたため、結果を反映できません。" };
    }
    const current = transcriptFile ? data.transcript : (data.artifacts[input.artifactId] ?? null);
    const currentSha = current === null ? null : await sha256Text(current);
    if (currentSha !== input.expectedCurrentSha) return { status: "input_changed", reason: "実行を始めた後に本文が変わったため、候補は残したまま反映しませんでした。" };
    const target = this.requireRec({ projectId: op.request.projectId, recordingId: op.request.recordingId });
    const versions = (target.versions[input.artifactId] ??= []);
    const newest = versions.at(-1);
    const at = input.record?.at ?? new Date().toISOString();
    if (current !== null && current.trim() !== "" && current !== candidate.text && current !== newest) {
      versions.push(current);
      target.runs.push({ id: `save-${versions.length}`, kind: "save", at, stepId: input.stepId, stepName: input.record?.stepName ?? "", version: versions.length, result: "saved", auto: true } as RunRecord);
    }
    versions.push(candidate.text);
    const model = source ? op.head.transcriptionModel : op.head.fixedModels[input.stepId];
    const row = {
      ...(input.record ?? { id: `run-${versions.length}`, kind: "run", at, stepName: "" }),
      stepId: input.stepId, version: versions.length, result: "saved", versionPath: candidate.path, versionSha256: candidate.sha256,
      originDeviceId: "fake-device", personalRunId: op.request.runId, origin: "this_pc", provider: candidate.provider, model: candidate.model,
      ...(op.head.outputTarget?.stepId === input.stepId
        ? { candidateId: op.head.outputTarget.candidateId, artifactId: op.head.outputTarget.artifactId, instruction: op.head.outputTarget.instruction }
        : {}),
      ...("reportedModel" in candidate ? { reportedModel: candidate.reportedModel, modelUsed: candidate.reportedModel } : {}),
      ...(model && "effort" in model ? { effort: model.effort } : {}),
      inputBasisSha256: op.head.snapshotSha256,
    } as unknown as RunRecord;
    target.runs.push(row);
    if (transcriptFile) target.transcript = candidate.text;
    else target.artifacts[input.artifactId] = candidate.text;
    // Native と同じく、集約の同じ版にも runs.jsonl の行と同じ表示の番号を付ける
    const aggregate = structuredClone(input.aggregate);
    const number = versions.length;
    for (const item of aggregate.versions) if (item.versionId === candidate.versionId) item.displayVersion = number;
    if (aggregate.sourceVersion?.versionId === candidate.versionId) aggregate.sourceVersion.displayVersion = number;
    this.personalAggregates.set(op.request.runId, aggregate);
    const version: PersonalVersionRef = { versionId: candidate.versionId, path: candidate.path, sha256: candidate.sha256, bytes: candidate.bytes, originRunId: op.request.runId, origin: "this_pc" };
    op.receipts.push({ stepId: input.stepId, kind: input.kind, version: structuredClone(version) });
    return { status: "committed", version, displayVersion: versions.length, localSaved: true, cloudAcked: false };
  }

  async personalRecord(handle: string, input: PersonalRecordInput) {
    const op = this.personalOp(handle);
    this.personalAggregates.set(op.request.runId, structuredClone(input.aggregate));
    if (input.record) {
      const data = this.requireRec({ projectId: op.request.projectId, recordingId: op.request.recordingId });
      data.runs.push({
        ...structuredClone(input.record), version: null, personalRunId: op.request.runId, origin: "this_pc",
      } as RunRecord);
      if (input.checkpoint) {
        if (input.checkpoint.runId !== input.record.id || input.checkpoint.value.runId !== input.record.id) throw PERSONAL_BAD_REQUEST;
        data.checkpoints[input.record.id] = structuredClone(input.checkpoint.value);
      }
    }
  }

  // ---- 確定した原文から NIHO API へ後続だけ（src-tauri/src/personal_niho.rs の代わり。規則は Native と同じ） ----

  /** 今の受付の条件（GET api-access の api の一部。提供元は開示の名前のまま）。code を入れると、その失敗で断る。 */
  personalNihoAccessResult: PersonalNihoAccess | { code: string; message: string } = {
    available: true, reasonCode: null, provider: "GOOGLE", model: "gemini-3.8-flash", consentVersion: "2026-10-16-v1",
    maxRunCostMicrousd: "120000", executorReasonCode: null,
  };
  /** 録音・原文・参考ページの同期が終わっていない（Native は VaultState の基準・未送信・競合で確かめる）。 */
  personalNihoUnsynced = false;
  /** 同期済みの版（personalReadMaterial の baseManifestRevision と同じ 0）。 */
  personalNihoBaseRevision = 0;
  /** 次の POST の応答（順に使う。無ければ受け付ける）。 */
  personalNihoPostResults: FakeNihoPost[] = [];
  /** 次の照会の応答（順に使う。無ければ、受け付けた run があれば受付、無ければ 404）。 */
  personalNihoLookupResults: Array<"normal" | "unknown"> = [];
  /** クラウドの manifest の版（release の fence。null は読めない）。 */
  personalNihoRevision: number | null = 0;
  /** 依頼の記録（`<owner>/<root>/<intentId>` → 記録）。app data に残る。 */
  personalNihoRecords = new Map<string, FakeNihoRecord>();
  /** NIHO API が受け付けた run（受付キー → run）。 */
  personalNihoAccepted = new Map<string, { runId: string; state: PersonalRemoteState; reasonCode: string | null }>();
  /** これから新しく受け付ける run の状態と reasonCode（Native の parse_run が受け取る run の view。既定は queued・reasonCode なし）。 */
  personalNihoNextRun: { state: PersonalRemoteState; reasonCode: string | null } = { state: "queued", reasonCode: null };
  /** 送った POST（順に。本文の bytes と受付キー）。 */
  personalNihoPosts: Array<{ key: string; body: string }> = [];
  /** 照会した受付キー（順に）。 */
  personalNihoLookups: string[] = [];
  /** NIHO の run の一覧（その録音の run。GET /api/me/docs-runs?…）。code を入れると一覧を確かめられない。 */
  personalNihoServerRuns: Array<{ projectId: ProjectId; recordingPageId: string; recordingId: string; state: string }> | { code: string; message: string } = [];
  /** run の一覧を確かめた回数。 */
  personalNihoListCalls = 0;
  /** この Mac で送信・確認している途中の依頼（`<owner>/<root>/<intentId>`）。 */
  private personalNihoInFlight = new Set<string>();
  private nextNihoRun = 1;
  private nextNihoKey = 1;

  /** 同じ録音（同じ置き場所のページか録音）の、結果を確かめていない依頼が今の本人・保存先の記録にあるか（Native と同じ）。 */
  private personalNihoPendingOn(op: FakePersonalOperation, exceptKey: string): boolean {
    const prefix = `${op.ownerAccountId}/${op.rootId}/`;
    return [...this.personalNihoRecords.entries()].some(([key, record]) =>
      key !== exceptKey && key.startsWith(prefix) && (record.phase === "prepared" || record.phase === "sent") &&
      record.projectId === op.request.projectId &&
      (record.recordingPageId === op.request.recordingPageId || record.recordingId === op.request.recordingId));
  }

  /** その録音の NIHO の run に実行中のもの（知らない状態も含む）があれば断る（Native の ensure_no_active_run と同じ）。 */
  private personalNihoEnsureNoActiveRun(op: FakePersonalOperation) {
    this.personalNihoListCalls += 1;
    const runs = this.personalNihoServerRuns;
    if (!Array.isArray(runs)) throw runs;
    const finished = new Set(["completed", "transcription_complete", "input_changed", "result_unknown", "failed", "canceled", "input_expired", "kept_current", "adopted"]);
    const active = runs.some((run) => run.projectId === op.request.projectId && run.recordingPageId === op.request.recordingPageId &&
      run.recordingId === op.request.recordingId && !finished.has(run.state));
    if (active) throw NIHO_RUN_ACTIVE;
  }

  /** 結果の分かった記録に intent を合わせる（何度呼んでも同じ）。 */
  private personalNihoSettleFor(key: string, record: FakeNihoRecord) {
    if (record.phase === "accepted") this.personalNihoSettleIntent(key, "submitted");
    else if (record.phase === "rejected" || record.phase === "absent") this.personalNihoSettleIntent(key, "failed");
  }

  private personalNihoOp(handle: string): FakePersonalOperation {
    const op = this.personalOp(handle);
    if (!(op.request.route.kind === "generation_only" && op.request.route.executor === "niho_api")) throw NIHO_ROUTE;
    return op;
  }

  async personalNihoEnsureIdle(handle: string): Promise<void> {
    this.personalCalls.push({ name: "personalNihoEnsureIdle", args: [handle] });
    const op = this.personalOp(handle);
    if (op.cancelled || op.closed || !this.personalCurrentOk(op)) throw PERSONAL_GUARD_FAILED;
    if (this.personalNihoPendingOn(op, "")) throw NIHO_PENDING_EXISTS;
    this.personalNihoEnsureNoActiveRun(op);
  }

  async personalNihoAccess(handle: string, plannedCalls: number): Promise<PersonalNihoAccess> {
    this.personalCalls.push({ name: "personalNihoAccess", args: [handle, plannedCalls] });
    if (!Number.isInteger(plannedCalls) || plannedCalls < 1 || plannedCalls > 32) throw PERSONAL_BAD_REQUEST;
    const op = this.personalOp(handle);
    if (!(op.request.route.kind === "generation_only" &&
      (op.request.route.executor === "niho_api" || op.request.route.executor === "device_niho_api"))) throw NIHO_ROUTE;
    if (op.cancelled || op.closed || !this.personalCurrentOk(op)) throw PERSONAL_GUARD_FAILED;
    const access = this.personalNihoAccessResult;
    if ("code" in access) throw access;
    return structuredClone(access);
  }

  /** Native の prepare と同じ検査で本文を 1 回だけ組む（送る前の失敗はここで投げる）。 */
  private async personalNihoBody(op: FakePersonalOperation, head: PersonalFixedSnapshot): Promise<string> {
    if (this.personalNihoUnsynced) throw NIHO_NOT_SYNCED;
    if (head.baseManifestRevision !== this.personalNihoBaseRevision) throw NIHO_INPUT_CHANGED;
    const data = this.personalRecording(op);
    const stored = this.require(op.request.projectId);
    const rid = op.request.recordingId;
    const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
    const fileRef = async (path: string, text: string) => ({ path, sha256: await sha256Text(text), bytes: bytes(text) });
    const source = head.input.sourceVersion;
    const sourcePath = new RegExp(`^recordings/${rid}/versions/source/(?:v_[A-Za-z0-9_-]{22}|[0-9]{1,20})\\.md$`);
    if (!source || source.origin !== "this_pc" || !sourcePath.test(source.path)) throw NIHO_SOURCE_NOT_CURRENT;
    const row = [...data.runs].reverse().find((run) => run.stepId === SOURCE_STEP_ID && run.versionPath === source.path);
    const versionText = typeof row?.version === "number" ? data.versions[SOURCE_STEP_ID]?.[row.version - 1] : undefined;
    if (versionText === undefined || data.transcript === null) throw NIHO_NOT_SYNCED;
    const sourceRef = await fileRef(source.path, versionText);
    if (sourceRef.sha256 !== source.sha256 || sourceRef.bytes !== source.bytes || (await sha256Text(data.transcript)) !== sourceRef.sha256) {
      throw NIHO_SOURCE_NOT_CURRENT;
    }
    const flow = data.recording.flowSnapshot;
    const stepIds = flow.steps.map((step) => step.id);
    if (stepIds.some((stepId) => data.artifacts[stepId] !== undefined)) throw NIHO_PARTIAL_SAVED;
    if (stepIds.length === 0 || canonical(head.selectedStepIds) !== canonical(stepIds)) throw NIHO_STEPS_MISMATCH;
    const steps = stepIds.map((stepId, index) => {
      const model = flow.models[stepId];
      const fixed = head.fixedModels[stepId];
      if (!model || !fixed || model.provider !== fixed.provider || model.model !== fixed.model || model.effort !== fixed.effort) throw NIHO_INPUT_CHANGED;
      return { stepKey: stepId, kind: index === 0 ? "REVISION" : "INSIGHT", provider: model.provider, model: model.model, effort: model.effort };
    });
    const projectId = op.request.projectId;
    return JSON.stringify({
      baseRevision: this.personalNihoBaseRevision,
      recordingPageId: op.request.recordingPageId,
      recordingId: rid,
      projectFile: await fileRef(projectId === null ? "pages.json" : "project.json", JSON.stringify(stored.project)),
      recordingFile: await fileRef(`recordings/${rid}/recording.json`, JSON.stringify(data.recording)),
      audio: [],
      sourceVersion: sourceRef,
      references: [],
      basis: [],
      transcriptionExecutor: null,
      generationExecutor: "niho_api",
      consentVersion: head.consentVersion,
      steps,
      containerRef: projectId === null ? { kind: "root" } : { kind: "folder", projectId },
    });
  }

  /** 今の受付の条件の検査（Native の check_access と同じ）。 */
  private personalNihoReady(access: PersonalNihoAccess, head: PersonalFixedSnapshot): void {
    if (!access.available) {
      throw {
        code: "personal_niho_not_ready",
        message: access.reasonCode === "BUDGET_EXHAUSTED"
          ? "NIHO API の上限に達しています。この Mac で続けられます。"
          : access.reasonCode === "PERMISSION_DENIED"
            ? "NIHO API の利用が許可されていません。この Mac で続けられます。"
            : "NIHO API を今は使えません。この Mac で続けられます。",
      };
    }
    if (access.consentVersion !== head.consentVersion) {
      throw { code: "personal_niho_not_ready", message: "NIHO API の利用条件が更新されました。内容を確かめてから、もう一度実行してください。" };
    }
    const models = head.selectedStepIds.map((stepId) => head.fixedModels[stepId]);
    // 開示された提供元 → 工程の provider は docs-core の表（Native の niho_api_step_provider と同じ）
    const provider = access.provider ? nihoApiProvider(access.provider) : null;
    if (!provider || models.some((model) => model?.provider !== provider || model.model !== access.model)) {
      throw { code: "personal_niho_not_ready", message: "この録音に固定された AI モデルが NIHO の AI と違うため、この Mac で続けてください。" };
    }
  }

  /** 送った POST の結果（偽のサーバー）。 */
  private personalNihoPost(record: FakeNihoRecord): { kind: "accepted"; runId: string; state: PersonalRemoteState; reasonCode: string | null } | { kind: "rejected"; reason: string } | { kind: "unknown" } {
    this.personalNihoPosts.push({ key: record.submissionKey, body: record.body });
    const next = this.personalNihoPostResults.shift() ?? "accept";
    const accept = () => {
      let run = this.personalNihoAccepted.get(record.submissionKey);
      if (!run) {
        run = { runId: `cmfakerun${String(this.nextNihoRun++).padStart(8, "0")}`, ...this.personalNihoNextRun };
        this.personalNihoAccepted.set(record.submissionKey, run);
      }
      return run;
    };
    if (next === "accept") return { kind: "accepted", ...accept() };
    if (next === "accept_lost") {
      accept();
      return { kind: "unknown" };
    }
    if (next === "unknown") return { kind: "unknown" };
    return { kind: "rejected", reason: next.reject };
  }

  private personalNihoLookup(record: FakeNihoRecord): { kind: "found"; runId: string; state: PersonalRemoteState; reasonCode: string | null } | { kind: "not_found" } | { kind: "unknown" } {
    this.personalNihoLookups.push(record.submissionKey);
    if ((this.personalNihoLookupResults.shift() ?? "normal") === "unknown") return { kind: "unknown" };
    const run = this.personalNihoAccepted.get(record.submissionKey);
    return run ? { kind: "found", ...run } : { kind: "not_found" };
  }

  /** intent の記録を結果の分かった状態にする（marker を閉じる）。 */
  private personalNihoSettleIntent(key: string, state: PersonalRunState) {
    const intent = this.personalIntents.get(key);
    if (!intent) return;
    intent.state = state;
    intent.dispatches.forEach((marker) => { marker.terminal = true; });
  }

  async personalNihoSubmit(handle: string, intentId: string, snapshotSha256: string): Promise<PersonalNihoSubmitResult> {
    this.personalCalls.push({ name: "personalNihoSubmit", args: [handle, intentId, snapshotSha256] });
    const op = this.personalOp(handle);
    if (intentId !== op.request.intentId) throw PERSONAL_INTENT_MISMATCH;
    this.personalNihoOp(handle);
    const key = this.personalIntentKey(op);
    // 同じ依頼の送信・確認がこの Mac で途中なら、何もしない
    if (this.personalNihoInFlight.has(key)) throw NIHO_IN_FLIGHT;
    this.personalNihoInFlight.add(key);
    try {
      // 同じ intent の 2 回目は送らない
      const existing = this.personalNihoRecords.get(key);
      if (existing) {
        this.personalNihoSettleFor(key, existing);
        if (existing.phase === "accepted") return { status: "accepted", runId: existing.runId!, state: existing.state!, reasonCode: existing.runReasonCode ?? null };
        if (existing.phase === "rejected") throw { code: "personal_niho_rejected", message: nihoRejectionMessage(existing.reasonCode ?? "") };
        if (existing.phase === "absent") throw NIHO_CLOSED;
        throw NIHO_RESULT_UNKNOWN_BEFORE;
      }
      if (op.cancelled || op.closed || !this.personalCurrentOk(op)) throw PERSONAL_GUARD_FAILED;
      // 同じ録音に結果を確かめていない依頼がある（新しい intent で二重に頼まない）
      if (this.personalNihoPendingOn(op, key)) throw NIHO_PENDING_EXISTS;
      if (!op.reserved || !op.head) throw { code: "personal_intent_not_reserved", message: "実行の受付が済んでいません。" };
      if (op.head.snapshotSha256 !== snapshotSha256) throw { code: "personal_snapshot_mismatch", message: "固定した入力が、この実行の録音・アカウント・保存先と一致しません。" };
      if (op.request.recordingId === ROOT_RECORDING_ID || op.request.recordingPageId === ROOT_RECORDING_ID) throw NIHO_LEGACY_RECORDING;
      const head = op.head;
      const body = await this.personalNihoBody(op, head);
      const access = this.personalNihoAccessResult;
      if ("code" in access) throw access;
      this.personalNihoReady(access, head);
      this.personalNihoEnsureNoActiveRun(op);
      if (op.cancelled || !this.personalCurrentOk(op)) throw PERSONAL_GUARD_FAILED;
      if (this.personalNihoPendingOn(op, key)) throw NIHO_PENDING_EXISTS;
      // 本文の bytes と受付キーを、最初の POST の前に残す → 外部への受付の直前の印 → 送信を始める段階
      const record: FakeNihoRecord = {
        intentId, submissionKey: `submit_${(this.nextNihoKey++).toString(16).padStart(32, "0")}`, body,
        baseRevision: head.baseManifestRevision, projectId: op.request.projectId, recordingPageId: op.request.recordingPageId,
        recordingId: op.request.recordingId, phase: "prepared", runId: null, state: null, reasonCode: null, createdAt: new Date().toISOString(),
      };
      this.personalNihoRecords.set(key, record);
      const intent = this.personalIntent(op);
      if (intent.state !== "reserved" && intent.state !== "running") {
        nihoAdvance(record, "absent", { reasonCode: "not_sent" });
        this.personalNihoSettleIntent(key, "failed");
        throw { code: "personal_intent_closed", message: "この実行の記録はすでに終わっています。" };
      }
      intent.state = "running";
      intent.dispatches.push({ stepId: "remote", terminal: false });
      op.dispatchOpen = true;
      nihoAdvance(record, "sent");
      // 送信直前の guard（取消・本人・lease）。送る前に止めたら、記録は「受け付けられていない」・intent は失敗
      if (op.cancelled || op.closed || !this.personalCurrentOk(op) || op.leaseLost || !op.cloudLease) {
        nihoAdvance(record, "absent", { reasonCode: "not_sent" });
        this.personalNihoSettleIntent(key, "failed");
        op.dispatchOpen = false;
        throw PERSONAL_GUARD_FAILED;
      }
      // 送った後: 結果は記録と intent に残し、そのまま返す
      const outcome = this.personalNihoPost(record);
      if (outcome.kind === "accepted") {
        nihoAdvance(record, "accepted", { runId: outcome.runId, state: outcome.state, runReasonCode: outcome.reasonCode });
        this.personalNihoSettleIntent(key, "submitted");
        return { status: "accepted", runId: outcome.runId, state: outcome.state, reasonCode: outcome.reasonCode };
      }
      if (outcome.kind === "rejected") {
        nihoAdvance(record, "rejected", { reasonCode: outcome.reason });
        this.personalNihoSettleIntent(key, "failed");
        throw { code: "personal_niho_rejected", message: nihoRejectionMessage(outcome.reason) };
      }
      throw NIHO_RESULT_UNKNOWN;
    } finally {
      this.personalNihoInFlight.delete(key);
    }
  }

  async personalNihoConfirm(intentId: string, action: PersonalNihoConfirmAction): Promise<PersonalNihoConfirmResult> {
    this.personalCalls.push({ name: "personalNihoConfirm", args: [intentId, action] });
    if (!["lookup", "resend", "release"].includes(action)) throw PERSONAL_BAD_REQUEST;
    if (!this.personalOwner) throw PERSONAL_NOT_SIGNED_IN;
    // 今の本人・保存先の記録だけを読む（別の本人の依頼には届かない）
    const key = `${this.personalOwner}/${this.personalRootId}/${intentId}`;
    // 同じ依頼の送信・確認がこの Mac で途中なら、何もしない（段階を戻さない・二重に送らない）
    if (this.personalNihoInFlight.has(key)) return { status: "in_flight" };
    this.personalNihoInFlight.add(key);
    try {
      const record = this.personalNihoRecords.get(key);
      if (!record) throw { code: "personal_niho_record_missing", message: "この依頼の記録が見つかりません。" };
      const settled = (): PersonalNihoConfirmResult | null => {
        this.personalNihoSettleFor(key, record);
        if (record.phase === "accepted") return { status: "accepted", runId: record.runId!, state: record.state!, reasonCode: record.runReasonCode ?? null };
        if (record.phase === "rejected") return { status: "rejected", reasonCode: record.reasonCode };
        if (record.phase === "absent") return { status: "absent" };
        return null;
      };
      const before = settled();
      if (before) return before;
      // この Mac で同じ録音の本人 Mac 実行が開いている間は送り直さない
      const busy = [...this.personalOps.values()].some((op) =>
        !op.closed && op.ownerAccountId === this.personalOwner && op.rootId === this.personalRootId && op.request.projectId === record.projectId &&
        (op.request.recordingPageId === record.recordingPageId || op.request.recordingId === record.recordingId));
      if (action === "resend" && busy) throw NIHO_RECORDING_BUSY;
      const accepted = (run: { runId: string; state: PersonalRemoteState; reasonCode: string | null }): PersonalNihoConfirmResult => {
        nihoAdvance(record, "accepted", { runId: run.runId, state: run.state, reasonCode: null, runReasonCode: run.reasonCode });
        return settled() ?? { status: "unknown" };
      };
      const found = this.personalNihoLookup(record);
      if (found.kind === "found") return accepted(found);
      if (found.kind === "unknown") return { status: "unknown" };
      if (action === "lookup") return { status: "absent_unproven" };
      if (action === "resend") {
        // 明示の再送: まだ結果の決まっていない記録だけ、同じ bytes・同じ受付キーで
        if (record.phase !== "prepared" && record.phase !== "sent") return settled() ?? { status: "unknown" };
        nihoAdvance(record, "sent");
        const outcome = this.personalNihoPost(record);
        if (outcome.kind === "accepted") return accepted(outcome);
        if (outcome.kind === "rejected") {
          nihoAdvance(record, "rejected", { reasonCode: outcome.reason });
          return settled() ?? { status: "unknown" };
        }
        return { status: "unknown" };
      }
      // release: manifest の版が固定した版を越えた後の再照会でも見つからないときだけ「受け付けられていない」
      if (this.personalNihoRevision === null) return { status: "unknown" };
      if (this.personalNihoRevision <= record.baseRevision) return { status: "cannot_confirm_yet" };
      const again = this.personalNihoLookup(record);
      if (again.kind === "found") return accepted(again);
      if (again.kind === "unknown") return { status: "unknown" };
      nihoAdvance(record, "absent", { reasonCode: "absent_after_revision" });
      return settled() ?? { status: "unknown" };
    } finally {
      this.personalNihoInFlight.delete(key);
    }
  }

  /** 読む記録の数・返す数の上限（Native の MAX_PENDING_SCAN・MAX_PENDING）。 */
  personalNihoPendingScanCap = 500;
  personalNihoPendingCap = 50;

  async personalNihoPending(): Promise<PersonalNihoPendingList> {
    this.personalCalls.push({ name: "personalNihoPending", args: [] });
    if (!this.personalOwner) throw PERSONAL_NOT_SIGNED_IN;
    const prefix = `${this.personalOwner}/${this.personalRootId}/`;
    const candidates = [...this.personalNihoRecords.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.intentId.localeCompare(left.intentId));
    let truncated = candidates.length > this.personalNihoPendingScanCap;
    const items = candidates
      .slice(0, this.personalNihoPendingScanCap)
      .filter((record) => record.phase === "prepared" || record.phase === "sent")
      .map((record) => ({
        intentId: record.intentId, recordingPageId: record.recordingPageId, recordingId: record.recordingId, projectId: record.projectId,
        phase: record.phase as "prepared" | "sent", runId: record.runId, createdAt: record.createdAt,
      }));
    if (items.length > this.personalNihoPendingCap) truncated = true;
    return { items: items.slice(0, this.personalNihoPendingCap), truncated };
  }

  personalDeviceText = "NIHO API が作成した文書";
  personalDeviceAcked: string[] = [];

  async personalDeviceGenerate(handle: string, snapshotSha256: string, stepId: string, versionId: string): Promise<{ text: string; runId: string }> {
    this.personalCalls.push({ name: "personalDeviceGenerate", args: [handle, snapshotSha256, stepId, versionId] });
    const op = this.personalOp(handle);
    if (op.request.route.kind !== "generation_only" || op.request.route.executor !== "device_niho_api" ||
      !op.dispatchOpen || op.head?.snapshotSha256 !== snapshotSha256 || !op.head.selectedStepIds.includes(stepId)) throw PERSONAL_GUARD_FAILED;
    return { text: this.personalDeviceText, runId: `device_${stepId}` };
  }

  async personalDeviceAck(handle: string, stepId: string, versionId: string): Promise<void> {
    this.personalCalls.push({ name: "personalDeviceAck", args: [handle, stepId, versionId] });
    const op = this.personalOp(handle);
    if (!op.receipts.some((receipt) => receipt.stepId === stepId && receipt.version.versionId === versionId)) throw PERSONAL_GUARD_FAILED;
    this.personalDeviceAcked.push(versionId);
  }
  async personalDeviceRecoverAcks(): Promise<{ acknowledged: number; pending: number }> {
    return { acknowledged: 0, pending: 0 };
  }

  /** personal の command の呼び出し（順に）。 */
  personalCalls: Array<{ name: string; args: unknown[] }> = [];
}

/** 偽の NIHO API の POST の応答: 受け付ける・受け付けたが応答が届かない・結果不明（5xx・通信の失敗・壊れた応答）・断る。 */
export type FakeNihoPost = "accept" | "accept_lost" | "unknown" | { reject: string };

/** FakeBridge の依頼の記録（Native の `<intentId>.niho.json` と同じ欄）。 */
export type FakeNihoRecord = {
  intentId: string;
  submissionKey: string;
  body: string;
  baseRevision: number;
  projectId: ProjectId;
  recordingPageId: string;
  recordingId: string;
  phase: "prepared" | "sent" | "accepted" | "rejected" | "absent";
  runId: string | null;
  state: PersonalRemoteState | null;
  reasonCode: string | null;
  /** accepted の run の reasonCode（reasonCode は断られた理由で別物）。 */
  runReasonCode?: string | null;
  createdAt: string;
};

const PERSONAL_BAD_REQUEST = { code: "personal_bad_request", message: "実行の依頼の形が正しくありません。" };
const PERSONAL_NOT_SIGNED_IN = { code: "personal_not_signed_in", message: "NIHO アカウントでログインしてから実行してください。" };
const NIHO_ROUTE = { code: "personal_niho_route", message: "この実行は NIHO API に任せる実行ではありません。" };
const NIHO_LEGACY_RECORDING = { code: "personal_niho_legacy_recording", message: "この録音は以前の形式のため、NIHO API には渡せません。この Mac で続けてください。" };
const NIHO_NOT_SYNCED = { code: "personal_niho_not_synced", message: "録音・原文・参考ページの同期が終わっていません。同期が終わってから、もう一度実行してください。" };
const NIHO_SOURCE_NOT_CURRENT = { code: "personal_niho_source_not_current", message: "今の原文が確定した版と違います。原文を保存して版にしてから、もう一度実行してください。" };
const NIHO_PARTIAL_SAVED = { code: "personal_niho_partial_saved", message: "途中までの工程が保存済みのため、NIHO API には渡せません。この Mac で続けてください。" };
const NIHO_STEPS_MISMATCH = { code: "personal_niho_steps_mismatch", message: "NIHO API に任せられるのは、この録音の工程を全部まとめて実行するときだけです。" };
const NIHO_INPUT_CHANGED = { code: "personal_niho_input_changed", message: "実行を始めた後に録音・工程・参考ページが変わりました。もう一度実行してください。" };
const NIHO_CLOSED = { code: "personal_niho_closed", message: "この依頼は受け付けられなかったことを確かめ済みです。新しく実行してください。" };
const NIHO_RESULT_UNKNOWN = { code: "personal_niho_result_unknown", message: "NIHO API へ送信しましたが、受付結果を確認できません。自動では送り直しません。" };
const NIHO_RESULT_UNKNOWN_BEFORE = { code: "personal_niho_result_unknown", message: "前回の依頼の受付結果を確認できていません。自動では送り直しません。受付結果を確認してください。" };
const NIHO_IN_FLIGHT = { code: "personal_niho_result_unknown", message: "この依頼は送信中です。受付結果を確かめてから、もう一度実行してください。" };
const NIHO_PENDING_EXISTS = { code: "personal_niho_pending_exists", message: "前の依頼の受付結果をまだ確かめていません。受付結果を確かめてから、もう一度実行してください。" };
const NIHO_RUN_ACTIVE = { code: "personal_niho_run_active", message: "この録音は NIHO で実行中です。終わってから、もう一度実行してください。" };
const NIHO_RECORDING_BUSY = { code: "personal_niho_recording_busy", message: "この録音は実行中です。終わってから、もう一度確かめてください。" };

/**
 * 記録の段階を進める（Native の may_advance と同じ: prepared →〔sent・absent・accepted〕、sent →〔accepted・rejected・absent〕。
 * 決まった結果は変えない）。進めたら true。
 */
function nihoAdvance(record: FakeNihoRecord, to: FakeNihoRecord["phase"], fields: Partial<FakeNihoRecord> = {}): boolean {
  const allowed = record.phase === "prepared" ? ["sent", "absent", "accepted"] : record.phase === "sent" ? ["accepted", "rejected", "absent"] : [];
  if (!allowed.includes(to)) return false;
  Object.assign(record, fields, { phase: to });
  return true;
}

/** 断られた理由の利用者向けの言い方（Native の rejection_message と同じ）。 */
function nihoRejectionMessage(reason: string): string {
  if (reason === "input_revision_changed") return "保存先が更新されたため、NIHO API が受け付けませんでした。同期を確かめて、もう一度実行してください。";
  if (reason === "api_model_unavailable") return "この録音に固定された AI モデルは NIHO API では使えません。この Mac で続けてください。";
  if (["flow_snapshot_mismatch", "reference_set_mismatch", "confirmed_transcript_version_required", "recording_page_mismatch", "recording_metadata_mismatch", "recording_path_invalid", "blob_missing", "metadata_hash_mismatch"].includes(reason)) {
    return "録音・工程・参考ページ・原文が NIHO の記録と一致しないため、受け付けられませんでした。同期を確かめて、もう一度実行してください。";
  }
  if (["api_budget_exhausted", "api_budget_unavailable", "api_price_changed"].includes(reason)) return "NIHO API の上限に達しているため、受け付けられませんでした。この Mac で続けられます。";
  if (["rate_limited", "user_queue_full", "global_queue_full"].includes(reason)) return "混み合っているため、受け付けられませんでした。少し待ってから、新しく実行してください。";
  if (reason === "not_authenticated") return "NIHO アカウントを確かめられなかったため、受け付けられませんでした。もう一度ログインしてから、新しく実行してください。";
  if (reason.startsWith("api_") || reason === "permission_revoked") return "NIHO API を今は使えないため、受け付けられませんでした。この Mac で続けられます。";
  return "NIHO API が依頼を受け付けませんでした。";
}

/** FakeBridge の本人 Mac 実行の operation（Native の PersonalOperation と同じ欄）。 */
export type FakePersonalOperation = {
  handle: string;
  request: PersonalOpenRequest;
  ownerAccountId: string;
  rootId: string;
  leaseId: string;
  cloudLease: boolean;
  cancelled: boolean;
  closed: boolean;
  accountChanged: boolean;
  leaseLost: boolean;
  reserved: boolean;
  dispatchOpen: boolean;
  head: PersonalFixedSnapshot | null;
  receipts: Array<{ stepId: string; kind: "source" | "artifact"; version: PersonalVersionRef }>;
  candidates: Map<string, PersonalStoredCandidate & { text: string }>;
  audio: Array<{ path: string; sha256: string; bytes: number }>;
};

type FakePersonalIntent = { state: string; snapshotSha256: string; dispatches: Array<{ stepId: string; terminal: boolean }> };

const PERSONAL_OPERATION_MISSING = { code: "personal_operation_missing", message: "実行の準備が見つかりません。もう一度実行してください。" };
const PERSONAL_GUARD_FAILED = { code: "personal_guard_failed", message: "実行を始めたときの状態から変わったため、送信しませんでした。" };
const PERSONAL_INTENT_MISMATCH = { code: "personal_intent_mismatch", message: "実行の記録が、この実行と一致しません。" };
const PERSONAL_TERMINAL_STATES = new Set(["submitted", "completed", "transcription_complete", "input_changed", "canceled", "failed"]);
/** 保管庫の版 ID（Rust の niho_desktop_vault::is_version_id と同じ）。 */
const PERSONAL_VERSION_ID = /^v_[A-Za-z0-9_-]{22}$/;

/** 版の出どころ（Native の origin_of と同じ。知らない値は null＝固定入力に使わない）。 */
function personalVersionOrigin(row: RunRecord | undefined): "this_pc" | "shared_mac" | "niho_api" | null {
  const origin = (row as { origin?: unknown } | undefined)?.origin;
  if (origin === undefined || origin === null) return row?.remoteRunId ? "shared_mac" : "this_pc";
  if (origin === "LOCAL" || origin === "this_pc") return "this_pc";
  if (origin === "shared_mac") return "shared_mac";
  if (origin === "niho_api" || origin === "NIHO_API_SNAPSHOT") return "niho_api";
  return null;
}

function personalOriginRunId(row: RunRecord | undefined): string {
  const fields = row as { personalRunId?: string; runId?: string; id?: string } | undefined;
  return fields?.personalRunId ?? fields?.runId ?? fields?.id ?? "";
}

/** FakeBridge の音声の大きさ（Native は実ファイルから計算する）。 */
export const PERSONAL_FAKE_AUDIO_BYTES = 187882;
const PERSONAL_TRANSCRIPTION_MODELS = {
  "this-mac": { provider: "this-mac", model: "niho-speech" },
  gemini: { provider: "gemini", model: GEMINI_TRANSCRIPTION_MODEL, effort: GEMINI_TRANSCRIPTION_EFFORT },
  "gemini-api": { provider: "gemini", model: GEMINI_TRANSCRIPTION_MODEL, effort: GEMINI_TRANSCRIPTION_EFFORT, connection: "apiKey" },
  deepgram: { provider: "deepgram", model: "nova-3", connection: "apiKey" },
} as const;

/**
 * 依頼の文字起こしのエンジン（Native の parse_transcription と同じ。Gemini は方式が無ければサブスクリプション、API キーだけ別。
 * Deepgram は API キーだけ、この Mac は方式を持たない）。後続だけの実行は null、形の合わない依頼は undefined。
 */
function personalTranscriptionKey(request: PersonalOpenRequest): keyof typeof PERSONAL_TRANSCRIPTION_MODELS | null | undefined {
  const connection = request.transcriptionConnection ?? null;
  switch (request.transcriptionProvider) {
    case null:
      return connection === null ? null : undefined;
    case "this-mac":
      return connection === null ? "this-mac" : undefined;
    case "gemini":
      return connection === "apiKey" ? "gemini-api" : connection === null || connection === "subscription" ? "gemini" : undefined;
    case "deepgram":
      return connection === null || connection === "apiKey" ? "deepgram" : undefined;
    default:
      return undefined;
  }
}

async function snapshotHashValid(snapshot: PersonalFixedSnapshot): Promise<boolean> {
  try {
    const { snapshotSha256, ...rest } = snapshot;
    return /^[a-f0-9]{64}$/.test(snapshotSha256) && (await sha256Text(canonical(rest))) === snapshotSha256;
  } catch {
    return false;
  }
}

/** Native の accept_derived と同じ: head と同じか、この operation の版による generationSnapshot・nextStepSnapshot だけを受け入れる。 */
async function acceptDerived(
  head: PersonalFixedSnapshot,
  receipts: FakePersonalOperation["receipts"],
  proposed: PersonalFixedSnapshot,
): Promise<PersonalFixedSnapshot | null> {
  if (!(await snapshotHashValid(proposed))) return null;
  if (proposed.snapshotSha256 === head.snapshotSha256) return head;
  for (const receipt of receipts) {
    const derived = receipt.kind === "source" ? await generationSnapshot(head, receipt.version) : await nextStepSnapshot(head, receipt.stepId, receipt.version);
    if (derived.snapshotSha256 === proposed.snapshotSha256) return derived;
  }
  return null;
}

/** 保存先の状態（既定は「この Mac だけ」）。 */
export function cloudStateOf(fields: Partial<CloudState> = {}): CloudState {
  return {
    contextGeneration: 1,
    documentScopeId: "fake-root-owner",
    provider: "local",
    status: "local",
    deviceName: "テストの Mac",
    accountName: null,
    canRebind: false,
    migration: null,
    message: null,
    storage: null,
    requiresAccount: false,
    reopeningPending: false,
    ...fields,
  };
}

/** NIHO クラウドと同期している状態。 */
export function activeCloud(fields: Partial<CloudState> = {}): CloudState {
  return cloudStateOf({ provider: "niho", status: "active", accountName: "文書 太郎", requiresAccount: true, ...fields });
}

const FOLDER_EXPORT_CREATED_AT = "2026-10-18T00:00:00.000Z";

/** フォルダの書き出しの作成中（google_docs.rs が返す形）。 */
export function folderExportBuilding(exportId: string, done: number, total: number): DocsDriveFolderExportStatus {
  return { exportId, createdAt: FOLDER_EXPORT_CREATED_AT, status: "building", progress: { done, total } };
}

/** フォルダの書き出しの完了（文書の id は Google の形）。 */
export function folderExportCompleted(exportId: string, documentId = "fake_folder_document", imagesSkipped = 0): DocsDriveFolderExportStatus {
  return {
    exportId,
    createdAt: FOLDER_EXPORT_CREATED_AT,
    status: "completed",
    documentId,
    url: `https://docs.google.com/document/d/${documentId}/edit`,
    imagesSkipped,
  };
}

/** 案件の同期の状態（既定は送り終えていて、競合も延ばした変更も無い）。 */
export function syncSnapshot(projectId: string, fields: Partial<ProjectSyncSnapshot> = {}): ProjectSyncSnapshot {
  return {
    projectId,
    revision: 1,
    syncing: false,
    localGeneration: 0,
    acknowledgedGeneration: 0,
    dirty: {},
    pendingMutation: false,
    conflicts: [],
    deferred: [],
    remoteWriters: {},
    quotaPaths: [],
    blocked: [],
    expiredAudio: [],
    audio: {},
    lastSyncedAt: null,
    lastError: null,
    retryAfter: null,
    tombstone: null,
    ...fields,
  };
}

/** 競合の 1 件（`.conflicts/index.json` の行）。 */
export function conflictEntryOf(fields: Partial<ConflictEntry> & Pick<ConflictEntry, "conflictId" | "path">): ConflictEntry {
  return {
    kind: "edit",
    origin: "sync",
    status: "open",
    baseSha256: "b".repeat(64),
    localSha256: "l".repeat(64),
    remoteSha256: "r".repeat(64),
    remoteRevision: 2,
    // 別の Mac（Mac アプリの端末 ID は d_。種類は remoteFile の writerDeviceKind）
    remoteDeviceId: "d_other_mac",
    remoteModifiedAt: "2026-10-16T01:00:00.000Z",
    localModifiedAt: "2026-10-16T01:05:00.000Z",
    localVersionId: null,
    remoteVersionId: null,
    localVersionPath: null,
    remoteVersionPath: null,
    localCopy: null,
    remoteCopy: null,
    remoteAvailable: true,
    resolutionGeneration: null,
    remoteFile: null,
    createdAt: "2026-10-16T01:06:00.000Z",
    updatedAt: "2026-10-16T01:06:00.000Z",
    ...fields,
  };
}

export function done(
  text: string,
  stop_reason: "EndTurn" | "MaxTokens" | "Stopped" = "EndTurn",
  session_id: string | null = "s1",
  model_used: string | null = null,
  /** CLI（Claude Code）が同じ実行の中で頼んだ続きの回数。 */
  continuations = 0,
): TurnEvent {
  return {
    type: "Done",
    text,
    stop_reason,
    session_id,
    usage: { input_tokens: 100, output_tokens: 50, cost_usd: null, model_used, cost_known: false },
    duration_ms: 10,
    continuations,
  };
}
