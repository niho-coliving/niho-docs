import type {
  About,
  ExecutionPreferences,
  ApiKeyAccount,
  ApiKeyStatus,
  AudioInput,
  ClaudeUpdateResult,
  DeepgramFileResult,
  ContractProvider,
  Flow,
  FlowSnapshot,
  FlowSample,
  ContractEffort,
  PageEntry,
  PageKind,
  Project,
  ProviderStatus,
  ProviderUsage,
  ResolvedStepModel,
  Recording,
  RecordingFile,
  CandidateSet,
  RunCheckpoint,
  RunRecord,
  SpeakerMode,
  SpeechHint,
  TurnEnvelope,
  TurnEvent,
  TurnRequest,
  DocsPageShareState,
} from "@niho/docs-core";
import type { AppSettings, SpeechUnsupported } from "../lib/settings";
import type {
  PersonalCandidate,
  PersonalExecutionRequest,
  PersonalFixedSnapshot,
  PersonalGuardPhase,
  PersonalPromptMaterials,
  PersonalRemoteState,
  PersonalRoute,
  PersonalRunHistory,
  PersonalRunState,
  PersonalSnapshotMaterial,
  PersonalStoredCandidate,
  PersonalVersionRef,
} from "../lib/personal-execution";
import type { ArtifactState, ChatTurnRequest, ConversationFile } from "@niho/docs-core";
import type {
  CloudAppliedEvent,
  CloudProjectEvent,
  CloudProjectStatusReply,
  CloudRemoteEvent,
  CloudRemoteProjectsReply,
  CloudState,
  ConflictEntry,
  ConflictSide,
  DeletedProject,
  ReopeningPreview,
  ResolveChoice,
  TombstoneChoice,
  VaultProviderKind,
  VaultUsage,
} from "../lib/cloud-types";
import { PC_RUNNER_BUSY_MESSAGE, type PcRunnerStatus } from "../lib/pc-runner";

/**
 * Tauri の command（apps/docs/src-tauri/src/lib.rs）の呼び口。テストは同じ形の偽物を渡す。
 * 案件・ページ・録音・工程・実行は id で指す（パスは Rust が id だけで作る）。工程の成果物・版・記録・会話は録音ごと
 * （`RecordingRef`。今の案件は案件フォルダ直下が録音 `root`）、実行のロックは案件ごと。
 */

/** 録音の指し方（録音単位のメソッドの第 1 引数。案件の id だけで呼び漏れないよう型で分ける）。 */
export type ProjectId = string | null;
export type RecordingRef = { projectId: ProjectId; recordingId: string };

/** native が同じ project gate 上で本文と編集保護を固定した、不透明な編集 handle。 */
export type OpenedDocument = { handle: string; contextGeneration: number; scopeId: string; markdown: string; sha256: string | null };

export type ProjectEntry = {
  id: string;
  project: Project;
  /** root の録音（今の案件）の文字起こしがあるか。 */
  hasTranscript: boolean;
  /** root の録音の artifacts/ にある工程の id。 */
  artifacts: string[];
  /** project.json・記録・録音・文書の本文で最後に触った時刻。 */
  updatedMs: number;
};

/**
 * 録音のページの様子（recording は recording.json を読んだまま。root なら null で、画面は project.json から読み替える。どちらも
 * 話者人数・言語・参考は docs-core の recordingOf で読み替えてから使う）。
 */
export type RecordingEntry = { id: string; recording: RecordingFile | null; hasTranscript: boolean; artifacts: string[] };

/** 文書のページ（updatedMs は本文の更新時刻。無ければ 0）。 */
export type DocEntry = { id: string; updatedMs: number };

/** 開いた案件（project.json と、ページの一覧の録音・文書の様子）。 */
export type LoadedProject = {
  id: string;
  project: Project;
  recordings: RecordingEntry[];
  docs: DocEntry[];
};

/** 録音 1 つの中身。 */
export type LoadedRecording = {
  projectId: ProjectId;
  id: string;
  /** recording.json を読んだまま（root は null。docs-core の recordingOf で読み替えてから使う）。 */
  recording: RecordingFile | null;
  transcript: string | null;
  /** 工程 id → 最新版。 */
  artifacts: Record<string, string>;
  runs: RunRecord[];
  /** 今のファイルがいちばん新しい版と違う工程（自動保存した書きかけ。`source` は文字起こし）。 */
  unversioned: string[];
  /** 写しがこの Mac に無い音声の file（クラウドから取得中・期限切れ）。 */
  missingInputs: string[];
};

/** フォルダ内外のページ一覧。外側は projectId/project が null。 */
export type LoadedPages = {
  projectId: ProjectId;
  project: Project | null;
  pages: PageEntry[];
  recordings: RecordingEntry[];
  docs: DocEntry[];
};

/** 足すページ（録音は recording.json の中身。id は Rust が決める）。 */
export type NewPage = { kind: PageKind; title: string; createdAt: string; recording?: Recording; afterPageId?: string };

export type ChatArtifactChange = { stepId: string; markdown: string | null };
/** composer（#18722）: AI が書き換えた文書ページ（消した文書ページは返らない）。 */
export type ChatPageChange = { pageId: string; markdown: string };
/** composer: AI が作った新しい文書（`file` は作業場所の artifacts/new/ の中の名前）。 */
export type ChatNewDocument = { file: string; markdown: string };
export type ChatTurnResult = { artifacts: ChatArtifactChange[]; pages?: ChatPageChange[]; created?: ChatNewDocument[]; finalEvent: TurnEvent };
/**
 * `runTurn`・`transcribeAudioPart` の戻り値。終端イベント（Done / Error）は Channel とは別にここでも受け取る。Tauri の Channel は
 * 8,192 バイト以上のメッセージを fetch で後から取りに行くので、本文の全文を載せた Done が invoke の戻りより後に届くことがある
 * （#18382 の実機）。届かずに終わったときは null。
 */
export type TurnResult = { finalEvent: TurnEvent | null };

/** 依頼の終端イベント（Done / Error）。 */
export type TerminalEvent = Extract<TurnEvent, { type: "Done" } | { type: "Error" }>;

/** 1 回の依頼の終端イベント: command の戻り値を優先し、無ければ Channel で受けたもの（`TurnResult` の注記）。 */
export function terminalEvent(result: TurnResult | null | undefined, fromChannel: TerminalEvent | null): TerminalEvent | null {
  const returned = result?.finalEvent;
  if (returned && (returned.type === "Done" || returned.type === "Error")) return returned;
  return fromChannel;
}

export type AudioInfo = { path: string; name: string; durationSec: number | null };

/** source.audio と同じ順の、この Mac にある音声の実ファイル。無い写しは path が null。 */
export type AudioFilePath = { file: string; path: string | null };

/** 録音（#18590）の音声。案件に保存した後は `discardRecording` で一時録音を消す。 */
export type RecordedAudio = AudioInfo & { recordingId: string };
export type MicStatus = "authorized" | "denied" | "notDetermined" | "restricted";
export type RecordingEvent =
  | { type: "Started"; device: string | null }
  | { type: "Level"; db: number; durationSec: number }
  | { type: "Done"; audio: RecordedAudio }
  | { type: "Error"; code: string; message: string };

export type RecentId = { projectId: ProjectId; pageId: string; openedAt: string };

export type SpeechStatus = {
  found: boolean;
  fake: boolean;
  available: boolean;
  needsDownload: boolean;
  engine: string | null;
  error: string | null;
  /** 本物の sidecar が無く、偽物で代わりに動いているときの案内（開発ビルドだけ。`npm run sidecar:build`）。 */
  notice: string | null;
  diarization: { state: "ready" | "missing" | "corrupt"; detail: string | null };
  /** この Mac で動かない文字起こし（settings の `SpeechUnsupported`。確かめられなかったときと、古い本体は無い）。 */
  unsupported?: SpeechUnsupported | null;
};

export type SpeechEvent =
  | { type: "Stage"; stage: "convert" | "diarize" | "silence" | "transcribe"; file: number; files: number; part?: number; parts?: number }
  | { type: "Segment"; file: number; start: number; end: number; text: string; speaker?: number | null }
  | { type: "Progress"; file: number; part: number; parts: number; ratio: number };

export type FileTranscript = { jsonl: string; durationSec: number };

/** Gemini の文字起こしの準備の結果（音声ごとの長さと、区切りの境目＝元の音声の絶対秒）。 */
export type PreparedAudioFile = { durationSec: number; parts: Array<{ startSec: number; endSec: number; soundSec: number }> };

/** Deepgram の依頼（固有名詞の表記は docs-core の `deepgramKeyterms`。Rust がほかの設定を NIHO と同じに固定する）。 */
export type DeepgramRequest = { language: string; diarize: boolean; keyterms: string[] };

/** 区切り 1 つの文字起こしの依頼（指示文は docs-core で組み立てる。提供元は Gemini＝Antigravity CLI か Gemini API）。 */
export type AudioPartRequest = {
  provider: ContractProvider;
  model: string;
  effort: ContractEffort | null;
  system_prompt: string;
  user_prompt: string;
};

/** `details` は画面が文を組み立てるための数だけ（フォルダの書き出しの上限を超えた数・429 の待ち時間）。 */
export type CommandError = { code: string; message: string; details?: Record<string, unknown> };

/**
 * 自動更新の状態（src-tauri/src/updater.rs）。起動時と 1 時間ごとの確認が新しい版を取得すると stagedVersion が入り、
 * 「更新して再起動」か、次に開いたときにその版になる。enabled が false（updater の公開鍵が未設定・開発ビルド）なら画面には何も出さない。
 */
export type UpdateStatus = { enabled: boolean; stagedVersion: string | null };

/**
 * 「更新して再起動」の結果（restarting＝窓が閉じて開き直す・busy＝工程・会話・文字起こしが動いている・
 * otherAppRunning＝別の NIHO docs が工程を実行している〔force でも開き直さない〕・notStaged＝まだ取得していない・
 * refreshFailed＝最新公開版の確認・取得に失敗したため再起動せず、再試行できる）。
 */
export type RestartOutcome = "restarting" | "busy" | "otherAppRunning" | "notStaged" | "refreshFailed";

/** 本人の Google ドキュメント接続。内部 credential や token は Bridge へ出さない。 */
export type DocsDriveConnection = {
  status: "CONNECTED" | "DISCONNECTED" | "ERROR";
  connectedEmail: string | null;
  reason: string | null;
};

export type DocsDriveExportRequest = { exportId: string; title: string; markdown: string };
export type DocsDriveExportResult =
  | { exportId: string; status: "completed"; documentId: string; url: string }
  | { exportId: string; status: "pending"; retryable: boolean };

/**
 * フォルダの書き出し（#18838。src-tauri/src/google_docs.rs が API の応答を確かめてから返す）。本文は送らず、API が本人の NIHO クラウドから
 * 読む。木は API が docs-core で作り、画面はこれを出すだけにする。
 */
export type DocsDriveFolderExportNodeKind = "context" | "document" | "recording" | "step" | "candidate";
export type DocsDriveFolderExportNode = {
  /** `context`・`doc:<pageId>`・`rec:<pageId>`・`step:<pageId>:<stepId>`・`cand:<pageId>:<stepId>:<candidateId>`。 */
  key: string;
  kind: DocsDriveFolderExportNodeKind;
  title: string;
  /** 親の行（子より前に並ぶ）。ルートは null。 */
  parentKey: string | null;
  /** タブに入る本文の字数（UTF-16。タイムスタンプを残したとき）。 */
  chars: number;
  /** タイムスタンプを外すと字数が変わる行だけ。 */
  charsWithoutTimestamps?: number;
  defaultSelected: boolean;
};
export type DocsDriveFolderExportProgress = { done: number; total: number };
export type DocsDriveFolderExportFailureReason =
  | "google_unavailable"
  | "folder_changed"
  | "document_unavailable"
  | "drive_connection_changed"
  | "google_account_changed"
  | "auth_revoked"
  | "conversion_failed";
export type DocsDriveFolderExportStatus =
  | { exportId: string; createdAt: string; status: "pending"; retryable: boolean }
  | { exportId: string; createdAt: string; status: "building"; progress: DocsDriveFolderExportProgress }
  | { exportId: string; createdAt: string; status: "completed"; documentId: string; url: string; imagesSkipped: number }
  | {
      exportId: string;
      createdAt: string;
      status: "failed";
      /** 知らない理由は null。 */
      reason: DocsDriveFolderExportFailureReason | null;
      resumable: boolean;
      progress: DocsDriveFolderExportProgress | null;
    };
export type DocsDriveFolderExportPlan = {
  /** false なら受付は `folder_export_unavailable`（書き出しの仕組みが止まっている）。 */
  available: boolean;
  projectId: string;
  revision: number;
  /** フォルダの名前（題名の既定）。 */
  title: string;
  nodes: DocsDriveFolderExportNode[];
  limits: { maxTabs: number; maxChars: number };
  /** このフォルダで 24 時間以内に受け付けた、いちばん新しい書き出し。 */
  latest: DocsDriveFolderExportStatus | null;
};
export type DocsDriveFolderExportRequest = {
  exportId: string;
  projectId: string;
  revision: number;
  title: string;
  include: string[];
  timestamps: boolean;
};

/** お手本の文書の取り込みの結果（ファイルごと。取り込めたら sample、駄目なら error）。 */
/** Rust からの安全取得結果。HTML は共有 core で文字列解析し、DOM には挿入しない。 */
export type FetchedSamplePage = { url: string; body: number[]; contentType: string };

export type SampleImport = { name: string; sample: FlowSample | null; error: CommandError | null };

/**
 * 工程（フロー）の一覧（P4 #18567。Rust の list_flows）。flows は order の並び（flows/index.json。P4 より前の flows/active.json は
 * 1 本目として読む）。lastUsed は最後に使ったフロー（新しい録音のページの既定。無ければ並びの先頭）。
 */
export type FlowList = { flows: Flow[]; order: string[]; lastUsed: string | null };

/** 区切りの WAV の名前（Tauri の `transcribe_audio_part` が app data に書き、CLI の作業フォルダへ同じ名前で写す）。 */
export function audioPartFileName(file: number, part: number): string {
  return `f${file}-p${part}.wav`;
}

/**
 * 本人 Mac 実行（R6 #18739。src-tauri/src/personal_run.rs）の operation を開く依頼。Native が開始時の Store・namespace・実行の
 * ロック・lease を持ち、画面へは不透明な handle と本人・保存先の識別だけを返す。transcriptionProvider は端末内の経路だけ
 * （後続だけの実行は null）。
 */
export type PersonalOpenRequest = {
  projectId: ProjectId;
  recordingPageId: string;
  recordingId: string;
  intentId: string;
  runId: string;
  route: PersonalRoute;
  transcriptionProvider: "this-mac" | "gemini" | "deepgram" | null;
  outputTarget?: PersonalExecutionRequest["outputTarget"];
};

/** 開いた operation。cloudLease が false なのは NIHO に届かず、端末内の文字起こしだけを始めたとき。 */
export type PersonalOperationInfo = {
  handle: string;
  ownerAccountId: string;
  rootId: string;
  leaseId: string;
  cloudLease: boolean;
  contextGeneration: number;
  deviceId: string;
};

/** 送信前・保存前・CAS 前の確認。本人・保存先が開始時から変わった欄は空、lease を失ったら別の leaseId（controller が失敗にする）。 */
export type PersonalGuardResult = { ownerAccountId: string; rootId: string; snapshotSha256: string; leaseId: string; cancelled: boolean };

export type PersonalReserveResult = { status: "new" } | { status: "resumed" } | { status: "existing"; state: PersonalRunState };

/** intent の private 領域（同期しない）に置く途中記録の種類。 */
export type PersonalPrivateKind = "checkpoint" | "partial_output" | "run_record";

/**
 * prompt に実際に入る「あなたについて」・参考ページのタイトル・背景情報（本文と sha）。型の正は personal-execution.ts（固定入力の hash に
 * `input.promptMaterials` として含める）。
 */
export type { PersonalHashed, PersonalPromptMaterials } from "../lib/personal-execution";

/** 捕捉した Store から Native が読んだ固定入力の素材（音声は Native が SHA-256 を計算し、中身は渡さない）。 */
export type PersonalMaterial = PersonalSnapshotMaterial & { promptMaterials: PersonalPromptMaterials };

export type PersonalCandidateInput = PersonalCandidate & { sha256: string; bytes: number };

export type PersonalPublishInput = {
  intentId: string;
  stepId: string;
  kind: PersonalCandidate["kind"];
  candidateVersionId: string;
  artifactId: string;
  /** 公開の直前の現在本文の sha（null は「無い」）。違えば何も書かず input_changed。 */
  expectedCurrentSha: string | null;
  aggregate: PersonalRunHistory;
  record: RunRecord | null;
};

/** localSaved は「この Mac に保存済み」。クラウドの受領は別（slice 1 では cloudAcked は常に false）。 */
export type PersonalPublishResult =
  | { status: "committed"; version: PersonalVersionRef; displayVersion: number; localSaved: true; cloudAcked: false }
  | { status: "input_changed"; reason: string };

export type PersonalRecordInput = {
  aggregate: PersonalRunHistory;
  record: RunRecord | null;
  /** 失敗・停止の途中本文。record.id と同じ runId で、Native が同じ保存単位に公開する。 */
  checkpoint?: { runId: string; value: RunCheckpoint } | null;
};

/**
 * 本人 Mac で確定した原文から NIHO API へ後続だけを渡すときの、今の受付の条件（src-tauri/src/personal_niho.rs。
 * GET /api/me/docs-runs/api-access の一部）。provider は開示された提供元の名前のまま（`GOOGLE` など。形の違う値は null）で、
 * 工程の provider への読み替えと NIHO の AI で工程を動かせるかは docs-core の nihoApiProvider が決める。
 */
export type PersonalNihoAccess = {
  available: boolean;
  reasonCode: string | null;
  provider: string | null;
  model: string | null;
  consentVersion: string | null;
  maxRunCostMicrousd: string | null;
  executorReasonCode: string | null;
};

/** NIHO API が依頼を受け付けた（完了ではない）。 */
/** `reasonCode` は NIHO の run の reasonCode（`input_changed` が実行の前〔input_changed_before_execution〕か中かを分ける。無ければ null）。 */
export type PersonalNihoSubmitResult = { status: "accepted"; runId: string; state: PersonalRemoteState; reasonCode: string | null };

/** 結果を確かめられていない依頼への操作: 照会・同じ bytes と受付キーでの明示の再送・受け付けられていないことの証明。 */
export type PersonalNihoConfirmAction = "lookup" | "resend" | "release";

/**
 * 確かめた結果。absent_unproven は「照会では見つからないが、受け付けられていないとはまだ言えない」、cannot_confirm_yet は
 * 「クラウドの版がまだ進んでいないので証明できない」、absent は「受け付けられていない（新しく実行してよい）」、in_flight は
 * 「この Mac で同じ依頼を送信・確認している途中（何もしなかった）」。
 */
export type PersonalNihoConfirmResult =
  | { status: "accepted"; runId: string; state: PersonalRemoteState; reasonCode: string | null }
  | { status: "rejected"; reasonCode: string | null }
  | { status: "absent" }
  | { status: "absent_unproven" }
  | { status: "cannot_confirm_yet" }
  | { status: "unknown" }
  | { status: "in_flight" };

/** 結果を確かめられていない依頼（再起動の後に「受付結果を確認できていない依頼」として出す）。 */
export type PersonalNihoPending = {
  intentId: string;
  recordingPageId: string;
  recordingId: string;
  projectId: ProjectId;
  phase: "prepared" | "sent";
  runId: string | null;
  createdAt: string;
};

/** 結果を確かめられていない依頼の一覧（新しい順・上限あり）。truncated は読む数・返す数の上限で打ち切ったとき true。 */
export type PersonalNihoPendingList = { items: PersonalNihoPending[]; truncated: boolean };

export function isCommandError(value: unknown): value is CommandError {
  return typeof value === "object" && value !== null && "code" in value && "message" in value;
}

export function errorMessage(error: unknown, fallback: string): string {
  // スマホから受けた工程をこの Mac で実行中（pc_runner.rs）。文は画面が持つ（design-guide-docs.md §4.1・§7）
  if (isCommandError(error) && error.code === "pc_runner_busy") return PC_RUNNER_BUSY_MESSAGE;
  if (isCommandError(error)) return error.message;
  return fallback;
}

/** 端末で提供できる機能。保存・実行の共通契約と、optional な端末機能を分ける。 */
export type DocsCapabilities = {
  desktopWindow: boolean;
  localExecution: boolean;
  flowDesign: boolean;
  nativeRecording: boolean;
  fileReveal: boolean;
  updates: boolean;
  /** Mac のローカル保管庫とクラウドの同期。Web の直接保存とは別。 */
  cloudSync?: boolean;
};

export const MAC_DOCS_CAPABILITIES: Readonly<DocsCapabilities> = Object.freeze({
  desktopWindow: true, localExecution: true, flowDesign: true, nativeRecording: true, fileReveal: true, updates: true,
});

/** 保存・実行・会話の I/O。Tauri や HTTP の実装はアプリの host に閉じる。 */
export interface Bridge {
  readonly capabilities?: Readonly<DocsCapabilities>;
  /** 音声 URL の解決。Web は署名付き URL／blob URL、Mac は asset URL。 */
  audioSourceUrl?(path: string): string;
  /** native media resource を明示的に読み直す必要があるホストだけ true。 */
  readonly explicitMediaLoad?: boolean;
  /** 公開 URL の安全な取得・抽出は host が担う。 */
  importSampleUrl?(flowId: string, url: string): Promise<{ sample: FlowSample; warnings: string[] }>;

  appPaths(): Promise<{ docsRoot: string; dataDir: string }>;
  loadSettings(): Promise<unknown>;
  saveSettings(settings: AppSettings): Promise<void>;
  /** 工程（フロー）の一覧（並び・最後に使ったフロー）。 */
  listFlows(): Promise<FlowList>;
  /** フローを保存する（flows/<id>.json。並びに無ければ末尾に足し、最後に使ったフローがまだ無ければ、これにする）。 */
  saveFlow(flow: Flow): Promise<void>;
  /** フローを複製する（画面が作った写し〔新しい id・名前・revision 1〕を書き、お手本の本文を写し、並びの元の直後に入れる）。 */
  duplicateFlow(sourceId: string, flow: Flow): Promise<void>;
  /** フローを消す（ファイルとお手本の本文。最後に使ったフローなら並びの先頭へ）。録音は自分の snapshot で実行できる。 */
  deleteFlow(flowId: string): Promise<void>;
  /** 最後に使ったフロー（新しい録音のページの既定）を変える。 */
  setLastUsedFlow(flowId: string): Promise<void>;
  /** そのフローから作った録音の数（すべての案件の root と recordings の flowSnapshot.id）。 */
  flowUsage(flowId: string): Promise<number>;
  /** 「あなたについて」（保存先の about.json。無ければ null。中身は parseAbout で読む）。 */
  loadAbout(): Promise<About | null>;
  /** 「あなたについて」を保存する（本文が 2,000 字を超えると Tauri が断る）。 */
  saveAbout(about: About): Promise<void>;
  /** 本人共通の実行先（保存先の execution.json）。 */
  loadExecution(): Promise<unknown | null>;
  saveExecution(execution: ExecutionPreferences): Promise<void>;
  /** お手本の文書を選ぶ（.md/.txt/.docx/.pdf。取り消しは空）。 */
  pickSampleFiles(): Promise<string[]>;
  /** お手本の文書を取り込む（本文を抽出して flows/samples/<flowId>/ に保存）。ファイルごとに結果を返す。 */
  importSamples(flowId: string, paths: string[]): Promise<SampleImport[]>;
  /** 公開 URL の取得のみ（補助取得も同じ DNS/IP/redirect 検証を行う）。 */
  fetchSampleUrl(url: string, sameOriginRedirectOnly: string | null, timeoutMs: number): Promise<FetchedSamplePage>;
  /** 共有 core の抽出済み本文を URL とともに検証・保存する。 */
  saveSampleUrl(flowId: string, url: string, name: string, text: string): Promise<FlowSample>;
  /** お手本の文書の本文。消えていれば store_no_sample。 */
  readSample(flowId: string, sampleId: string): Promise<string>;
  /** 保存したフローに無いお手本の本文を消す。 */
  pruneSamples(flowId: string, keep: string[]): Promise<void>;
  listProjects(): Promise<ProjectEntry[]>;
  saveProjectOrder(order: string[]): Promise<string[]>;
  reorderProject(projectId: string, beforeProjectId: string | null): Promise<string[]>;
  /** ページと共有情報が空で、フォルダ内に他のデータが無い場合だけ削除する。 */
  deleteEmptyFolder(projectId: string): Promise<void>;
  loadRecent(): Promise<RecentId[]>;
  touchRecent(item: RecentId): Promise<RecentId[]>;
  /**
   * 案件を作る（id は Rust が決める。音声は inputs/ に写す）。保存した project.json を返す。新しい画面は `pages: []` の案件を
   * 文章・音声なしで作る（今の形の案件〔root の録音〕を作れるのはテストと古い形のため）。
   */
  createProject(project: Project, text: string | null, textRecord: RunRecord | null, audio: string[], names?: string[]): Promise<Project>;
  /**
   * 音声を録音の inputs/ に写す（書くのは saveProject〔root〕か saveRecording）。keep は同じ編集で残す録音の音声の file
   * （合計 6 時間には、残す音声と足す音声だけを数える）。
   */
  importAudio(rec: RecordingRef, paths: string[], keep: string[], names?: string[]): Promise<AudioInput[]>;
  /** 案件とページの一覧の様子。 */
  loadProject(projectId: string): Promise<LoadedProject>;
  loadPages(projectId: ProjectId): Promise<LoadedPages>;
  /**
   * 案件情報を保存する（pages はディスクのものを保つ。root の録音の flowSnapshot・source・refs・info.speakers・info.language も
   * ここで書く）。
   */
  saveProject(projectId: string, project: Project): Promise<void>;
  loadRecording(rec: RecordingRef): Promise<LoadedRecording>;
  /** 録音のページの recording.json を保存する（root は saveProject。読み替えた値〔話者人数・言語・参考つき〕で書く）。 */
  saveRecording(rec: RecordingRef, recording: Recording): Promise<void>;
  /** 最新の録音台帳へ案を追加し、複製なら本文・初版・記録も同じ操作で確定する。 */
  createCandidate(rec: RecordingRef, stepId: string, candidateSet: CandidateSet, newArtifactId: string, duplicateMarkdown: string | null, record: RunRecord | null): Promise<void>;
  renameCandidate(rec: RecordingRef, stepId: string, candidateId: string, name: string): Promise<void>;
  /** 素材の無い録音（root 以外）に文章を貼る（工程 1 の版 1・source を文章に）。 */
  setRecordingText(rec: RecordingRef, text: string, record: RunRecord): Promise<void>;
  /** ページを足す（pages が無ければ root を先頭に初期化する）。足した 1 行を返す。 */
  createPage(projectId: ProjectId, page: NewPage): Promise<PageEntry>;
  renamePage(projectId: ProjectId, pageId: string, title: string): Promise<void>;
  /**
   * ページを消す（文書は本文、録音は成果物・版・記録・会話・音声の写しも。root は project.json の flowSnapshot・source・refs を
   * 外す）。録音は案件の実行中なら store_busy。
   */
  deletePage(projectId: ProjectId, pageId: string): Promise<void>;
  movePage(sourceProjectId: ProjectId, pageId: string, targetProjectId: ProjectId, beforePageId?: string | null): Promise<PageEntry>;
  /** 文書のページの本文（まだ書いていなければ空）。 */
  readPage(projectId: ProjectId, pageId: string): Promise<string>;
  /** 文書の本文を書く。保管庫の journal を通れば、この Mac の保存の世代を返す（無ければ null。フォルダ外のページは同期しないので null）。 */
  writePage(projectId: ProjectId, pageId: string, markdown: string): Promise<number | null>;
  /** 編集保護と本文 snapshot を 1 操作で取得する。production の本文 editor はこの handle で保存する。 */
  openPageDocument(projectId: ProjectId, pageId: string): Promise<OpenedDocument>;
  /** 実際に解決した録音の transcript／artifact を、編集保護と一緒に開く。 */
  openArtifactDocument(rec: RecordingRef, stepId: string, source: boolean): Promise<OpenedDocument>;
  /** handle が捕捉した context と開いた本文の SHA が現在も一致するときだけ保存する。 */
  saveOpenedDocument(handle: string, markdown: string): Promise<number | null>;
  /** handle に結び付いた成果物の現在本文・版・runs を同じ保存単位で確定する。 */
  saveOpenedArtifact(handle: string, markdown: string, record: RunRecord): Promise<number>;
  releaseOpenedDocument(handle: string): Promise<void>;
  /** ファイル選択で画像を案件の assets/ に写す。キャンセルは null。 */
  pickImageAsset(projectId: ProjectId): Promise<string | null>;
  /** id と拡張子を検証した案件画像だけを data URL で読む。 */
  readImageAsset(projectId: ProjectId, name: string): Promise<string>;
  saveArtifact(rec: RecordingRef, stepId: string, source: boolean, markdown: string, record: RunRecord): Promise<number>;
  appendRun(rec: RecordingRef, record: RunRecord): Promise<void>;
  /** 版の本文（`versionPath` は runs の行の versionPath。無ければ表示の番号から）。 */
  readVersion(rec: RecordingRef, stepId: string, version: number, versionPath?: string): Promise<string>;
  saveCheckpoint(rec: RecordingRef, runId: string, checkpoint: RunCheckpoint): Promise<void>;
  readCheckpoint(rec: RecordingRef, runId: string): Promise<RunCheckpoint | null>;
  /** 同じ案件の実行を 1 つにする（同じ案件の別の録音も。取れなければ store_busy）。 */
  acquireRunLock(projectId: ProjectId): Promise<void>;
  releaseRunLock(projectId: ProjectId): Promise<void>;
  listAllRuns(): Promise<Array<RunRecord & { project?: ProjectId; recording?: string }>>;
  /** `operation`（本人 Mac 実行の handle）を渡すと、Native が送信の直前に operation の guard を通す。 */
  runTurn(turnId: string, request: TurnRequest, onEvent: (envelope: TurnEnvelope) => void, operation?: string | null): Promise<TurnResult>;
  stopTurn(turnId: string): Promise<boolean>;
  providerStatus(provider: ContractProvider): Promise<ProviderStatus>;
  /** CLI の公式のログインを始める（ブラウザで本人がログインする。終わるまで最長 10 分待つ）。終わったら状態を返す。 */
  startAuth(provider: ContractProvider): Promise<ProviderStatus>;
  /** Claude Code を公式のインストーラで入れる（入っていれば何もしない）。 */
  installClaude(): Promise<ProviderStatus>;
  /** Claude Code を最新にする。 */
  updateClaude(): Promise<ClaudeUpdateResult>;
  speechStatus(language: string): Promise<SpeechStatus>;
  speechDownload(jobId: string, language: string, onEvent: (value: unknown) => void): Promise<void>;
  transcribe(
    jobId: string,
    rec: RecordingRef,
    language: string,
    speakerMode: SpeakerMode,
    hints: SpeechHint[],
    onEvent: (event: SpeechEvent) => void,
    operation?: string | null,
  ): Promise<FileTranscript[]>;
  stopTranscribe(jobId: string): Promise<boolean>;
  /**
   * Gemini（Antigravity CLI）の文字起こしの準備: 録音の音声を順に変換して区切りを決める（段階は onEvent の Stage）。
   * 止めるのは `stopTranscribe(jobId)`。終わったら `releaseAudio(jobId)`。
   */
  prepareAudio(jobId: string, rec: RecordingRef, onEvent: (event: SpeechEvent) => void, operation?: string | null): Promise<PreparedAudioFile[]>;
  /**
   * 区切り 1 つを WAV にして Antigravity CLI に読ませる（`run_turn` と同じ形でイベントが流れ、`stopTurn(turnId)` で止める）。
   * `file`・`part` は `prepareAudio` の結果の位置。CLI の作業フォルダでのファイル名は `audioPartFileName(file, part)`。
   */
  transcribeAudioPart(
    turnId: string,
    jobId: string,
    file: number,
    part: number,
    request: AudioPartRequest,
    onEvent: (envelope: TurnEnvelope) => void,
    operation?: string | null,
  ): Promise<TurnResult>;
  /** 準備した WAV を消す。 */
  releaseAudio(jobId: string): Promise<void>;
  /** 使用量の残り（Antigravity CLI の週の残りだけ。ほかの提供元・取れないときは失敗し、画面は「取得できません」）。 */
  providerUsage(provider: ContractProvider): Promise<ProviderUsage>;
  /**
   * Deepgram（API キー方式だけ）: 録音の音声の写しを順に送り、音声ごとの utterances を返す（Markdown は docs-core で組む）。
   * 段階は onEvent の Stage。止めるのは `stopTranscribe(jobId)`（止めたら speech_stopped）。
   */
  transcribeDeepgram(
    jobId: string,
    rec: RecordingRef,
    request: DeepgramRequest,
    onEvent: (event: SpeechEvent) => void,
    operation?: string | null,
  ): Promise<DeepgramFileResult[]>;
  /** API キーの状態（保存済みか・末尾 4 文字。呼び出しはしない。鍵そのものは返らない）。 */
  apiKeyStatus(account: ApiKeyAccount): Promise<ApiKeyStatus>;
  /** 1 回の軽い呼び出しで確かめてからこの Mac（app data の api-keys/）に保存する（失敗なら保存せずに投げる）。鍵は返らない。 */
  saveApiKey(account: ApiKeyAccount, key: string): Promise<ApiKeyStatus>;
  /** 保存済みの鍵で 1 回の軽い呼び出しをする（無効なら valid: false）。 */
  checkApiKey(account: ApiKeyAccount): Promise<ApiKeyStatus>;
  /** この Mac から鍵を消す。 */
  deleteApiKey(account: ApiKeyAccount): Promise<ApiKeyStatus>;
  audioInfo(paths: string[]): Promise<AudioInfo[]>;
  /** id から解決した録音の音声だけを asset protocol で読めるようにし、source.audio と同じ順で返す。 */
  audioFilePaths(rec: RecordingRef): Promise<AudioFilePath[]>;
  pickAudioFiles(): Promise<AudioInfo[]>;
  micStatus(request: boolean): Promise<MicStatus>;
  startRecording(recordingId: string, onEvent: (event: RecordingEvent) => void): Promise<{ device: string | null }>;
  stopRecording(recordingId: string): Promise<RecordedAudio>;
  discardRecording(recordingId: string): Promise<void>;
  leftoverRecordings(): Promise<RecordedAudio[]>;
  openMicrophoneSettings(): Promise<void>;
  onRecordingCloseRequested(handler: () => void): Promise<() => void>;
  closeAfterRecording(): Promise<void>;
  pickDocsRoot(): Promise<string | null>;
  saveMarkdownAs(fileName: string, markdown: string): Promise<string | null>;
  revealRoot(): Promise<void>;
  revealArtifact(rec: RecordingRef, stepId: string, source: boolean): Promise<void>;
  /** 文書のページの .md を Finder で表示する（「書き出し › Finder で表示」）。 */
  revealPage(projectId: ProjectId, pageId: string): Promise<void>;
  copyText(text: string): Promise<void>;
  /**
   * 「AIと作る」の修正の会話（S5）: Rust が用意する会話ごとの隔離 workspace で CLI を実行し、文書差分と終端イベントを返す。
   * 止めるのは `stopTurn`。
   */
  runChatTurn(
    turnId: string,
    rec: RecordingRef,
    conversationId: string,
    request: ChatTurnRequest,
    onEvent: (envelope: TurnEnvelope) => void,
  ): Promise<ChatTurnResult>;
  /** 工程の文書の状態（mtime・大きさ・SHA-256・最後の版）。依頼の前後に比べる。 */
  artifactStates(rec: RecordingRef): Promise<ArtifactState[]>;
  /** 工程の文書の今の中身（無ければ null）。 */
  readArtifact(rec: RecordingRef, stepId: string): Promise<string | null>;
  /** 工程の文書を最後の版の中身に戻す（版は足さない）。戻した版の番号。 */
  revertArtifact(rec: RecordingRef, stepId: string): Promise<number>;
  /** 録音の会話（conversations/*.json。新しい順。形は呼ぶ側が確かめる）。 */
  listConversations(rec: RecordingRef): Promise<unknown[]>;
  saveConversation(rec: RecordingRef, conversation: ConversationFile): Promise<void>;
  /** Finder からのドロップ（パス）と、ドラッグが窓の上にあるか。戻り値で購読をやめる。 */
  onFileDrop?(handler: (paths: string[]) => void, onHover?: (over: boolean) => void): Promise<() => void>;
  /** 窓を閉じる要求。handler が終わるまで閉じるのを待ち、false を返したら閉じない。戻り値で購読をやめる。 */
  onCloseRequested?(handler: () => Promise<boolean>): Promise<() => void>;
  /** 自動更新の状態（今の状態と、新しい版を取得したとき）。戻り値で購読をやめる。 */
  watchUpdate?(handler: (status: UpdateStatus) => void): Promise<() => void>;
  /** 取得した新しい版で開き直す。動いている処理があれば busy（force で止めて開き直す）。別の NIHO docs が実行中なら otherAppRunning。 */
  restartToUpdate?(force: boolean): Promise<RestartOutcome>;

  // ---- NIHO クラウド（C3 #18595。src-tauri/src/cloud.rs）----
  cloudState(): Promise<CloudState>;
  cloudStorageSelect(mode: "CLOUD" | "LOCAL"): Promise<CloudState>;
  cloudStorageReopeningPreview(): Promise<ReopeningPreview>;
  cloudStorageReopen(): Promise<CloudState>;
  /** 保存先を「この Mac だけ」/「NIHO クラウド」にする（rebind は別のアカウントの保存先をこのアカウントに結び直す）。 */
  cloudSetProvider(provider: VaultProviderKind, rebind?: boolean): Promise<CloudState>;
  /** この Mac の名前（空に戻すと Mac の名前）。 */
  cloudSetDeviceName(name: string): Promise<CloudState>;
  cloudProjectStatus(projectId: string): Promise<CloudProjectStatusReply>;
  cloudPageShareGet(pageId: string, projectId: string, textId?: string | null): Promise<DocsPageShareState>;
  cloudPageShareSet(pageId: string, projectId: string, textId: string | null, published: boolean): Promise<DocsPageShareState>;
  cloudPageShareRotate(pageId: string, projectId: string, textId: string | null, expectedPublicId: string): Promise<DocsPageShareState>;
  cloudPageShareOpen(url: string): Promise<void>;
  /** クラウドの案件の一覧（同期していなければ空。通信できなくても投げずに空を返す）。 */
  cloudRemoteProjects(): Promise<CloudRemoteProjectsReply>;
  cloudDeletedProjects(): Promise<DeletedProject[]>;
  /** クラウドにだけある案件を開く（文書から下ろす。音声は後ろで）。 */
  cloudOpenProject(projectId: string): Promise<void>;
  cloudRestoreProject(projectId: string): Promise<void>;
  cloudTombstoneChoice(projectId: string, choice: TombstoneChoice): Promise<void>;
  /** 今すぐ同期（null は送っていない案件・flows・profile と、クラウドで変わった案件）。 */
  cloudSyncNow(projectId: string | null): Promise<void>;
  /** 窓の前面化・表示中の 5 分ごと（開いている案件を確かめ、クラウドの一覧を読み直す）。 */
  cloudFocus(projectId: string | null): Promise<void>;
  /** 開いている文書の path を守る（その間の別の Mac の変更は反映を延ばす）。解除用の id を返す。 */
  cloudProtect(projectId: string, paths: string[]): Promise<number>;
  cloudRelease(id: number): Promise<void>;
  cloudConflicts(projectId: string): Promise<ConflictEntry[]>;
  /** 競合の片側の本文（UTF-8 の文書だけ。無い・バイナリは null）。 */
  cloudConflictCopy(projectId: string, conflictId: string, side: ConflictSide): Promise<string | null>;
  /**
   * 競合を解決する（`merged` は文書だけ）。`remoteSha256` は画面が見たクラウド側（違えば conflict_changed 「クラウドの内容がまた
   * 変わりました。もう一度確かめてください。」）。
   */
  cloudResolveConflict(
    projectId: string,
    conflictId: string,
    choice: ResolveChoice,
    text?: string | null,
    remoteSha256?: string | null,
  ): Promise<void>;
  cloudUsage(): Promise<VaultUsage | null>;
  cloudMigrationStart(): Promise<CloudState>;
  cloudMigrationCancel(): Promise<CloudState>;
  /** 最新の成果物・文字起こしの書きかけを今の path に自動保存する（版は作らない）。保存の世代（無ければ null）を返す。 */
  writeArtifactDraft(rec: RecordingRef, stepId: string, source: boolean, markdown: string): Promise<number | null>;
  onCloudState(handler: (state: CloudState) => void): Promise<() => void>;
  onCloudProject(handler: (event: CloudProjectEvent) => void): Promise<() => void>;
  onCloudApplied(handler: (event: CloudAppliedEvent) => void): Promise<() => void>;
  onCloudRemote(handler: (event: CloudRemoteEvent) => void): Promise<() => void>;

  // ---- この Mac で続きを受ける（#18804 S2。src-tauri/src/pc_runner.rs）----
  pcRunnerStatus(): Promise<PcRunnerStatus>;
  /** ON は NIHO にログイン済みで登録が通ったときだけ（pc_runner_not_signed_in・pc_runner_offline で断る）。OFF は実行中の 1 件を終えてから止まる。 */
  setPcRunnerEnabled(enabled: boolean): Promise<PcRunnerStatus>;
  onPcRunnerState(handler: (status: PcRunnerStatus) => void): Promise<() => void>;
  /**
   * サーバーが NIHO アカウントのログイン（と、それを使う Google ドキュメント）を今受け付けるか。false はサーバーが閉じていると
   * 返したときだけ（確かめられないときは true）。
   */
  accountAvailable(): Promise<boolean>;
  /** NIHO ログイン中の本人の Google ドキュメント接続状態。 */
  docsDriveConnection(): Promise<DocsDriveConnection>;
  /** 接続 URL を API から取得・検証し、Rust が既定ブラウザで開く。 */
  docsDriveConnect(): Promise<void>;
  docsDriveDisconnect(): Promise<DocsDriveConnection>;
  /** 同じ exportId の POST は同じ snapshot の再試行だけに使う。 */
  docsDriveExport(request: DocsDriveExportRequest): Promise<DocsDriveExportResult>;
  docsDriveExportStatus(exportId: string): Promise<DocsDriveExportResult>;
  /** API が返した URL は受け取らず、検証済み documentId から Rust が URL を組み立てる。 */
  docsDriveOpenDocument(documentId: string): Promise<void>;
  /** フォルダの書き出しの木（`folder_not_found` など、失敗は決まった code）。 */
  docsDriveFolderExportPlan(projectId: string): Promise<DocsDriveFolderExportPlan>;
  /** 同じ exportId の POST は同じ内容の再試行だけに使う（通信が切れたら `export_result_unknown`）。 */
  docsDriveFolderExport(request: DocsDriveFolderExportRequest): Promise<DocsDriveFolderExportStatus>;
  docsDriveFolderExportStatus(exportId: string): Promise<DocsDriveFolderExportStatus>;
  /** 止まった書き出しの続きを、同じ文書へ作る（続けられなければ `export_not_resumable`）。 */
  docsDriveFolderExportResume(exportId: string): Promise<DocsDriveFolderExportStatus>;

  // ---- 本人 Mac 実行（R6 #18739。src-tauri/src/personal_run.rs）。ports からだけ使う（slice 2）----
  /** operation を開く（ログイン済みが前提。lease_held・store_busy・personal_lease_unavailable・personal_not_signed_in で断る）。 */
  personalOpen(request: PersonalOpenRequest): Promise<PersonalOperationInfo>;
  /** 取り消す（束縛した turn・job を止める）。 */
  personalCancel(handle: string): Promise<boolean>;
  /** 閉じる（開始時の Store のロックと、自分が取った lease だけ返す）。二度目は released: false。 */
  personalClose(handle: string): Promise<{ released: boolean; leaseId: string }>;
  personalGuard(handle: string, phase: PersonalGuardPhase, snapshot?: PersonalFixedSnapshot | null): Promise<PersonalGuardResult>;
  personalReserveIntent(handle: string, intentId: string, snapshot: PersonalFixedSnapshot): Promise<PersonalReserveResult>;
  /** 外部実行の直前の dispatch marker（保存できなければ投げる。呼び出し側は送らない）。 */
  personalMarkDispatch(handle: string, intentId: string, stepId: string): Promise<void>;
  personalMarkIntent(handle: string, intentId: string, state: PersonalRunState): Promise<void>;
  personalSavePrivate(handle: string, intentId: string, kind: PersonalPrivateKind, payload: unknown): Promise<void>;
  personalReadMaterial(handle: string, request: { stepIds: string[] }): Promise<PersonalMaterial>;
  /** 同意後のモデル持ち替え。確認した flowSnapshot が変わっていれば false で書かない。 */
  personalSwapModels(handle: string, expectedFlow: FlowSnapshot, models: Record<string, ResolvedStepModel>): Promise<boolean>;
  personalVerifyInputs(handle: string, snapshot: PersonalFixedSnapshot): Promise<{ verified: boolean; reason?: string }>;
  personalPersistCandidate(handle: string, candidate: PersonalCandidateInput): Promise<PersonalStoredCandidate>;
  personalPublish(handle: string, input: PersonalPublishInput): Promise<PersonalPublishResult>;
  personalRecord(handle: string, input: PersonalRecordInput): Promise<void>;

  // ---- 確定した原文から NIHO API へ後続だけ（#18740。src-tauri/src/personal_niho.rs）。本文・token は Native の中だけ ----
  /** 同じ録音の未確定受付・NIHO側の実行中 run が無いことを確かめる。 */
  personalNihoEnsureIdle(handle: string): Promise<void>;
  /** 今の受付の条件（operation は後続だけ・NIHO API の経路だけ）。 */
  personalNihoAccess(handle: string, plannedCalls: number): Promise<PersonalNihoAccess>;
  /**
   * 受け付けた固定入力（hash）から Native が本文を組み、bytes と受付キーを永続化してから 1 回だけ送る。送る前に止めたら
   * personal_guard_failed・personal_niho_*（何も送っていない）、送った後は personal_niho_rejected か personal_niho_result_unknown。
   */
  personalNihoSubmit(handle: string, intentId: string, snapshotSha256: string): Promise<PersonalNihoSubmitResult>;
  /** operation なし（再起動の後も使える）。今ログインしている本人・保存先の依頼だけ。 */
  personalNihoConfirm(intentId: string, action: PersonalNihoConfirmAction): Promise<PersonalNihoConfirmResult>;
  personalNihoPending(): Promise<PersonalNihoPendingList>;
}




/**
 * Mac のファイル・窓・CLI・録音・本人実行は optional。Web は未対応の操作を実装しない。
 * 読み書きは不透明な編集 handle と SHA に結び付け、競合や結果不明の拒否を握り潰さない。
 * U2 では既存 Bridge と同じ引数・結果を保つ。U3 の CAS／衝突／再送は host 実装が責任を持つ。
 */
export const NATIVE_DOCS_OPERATIONS = [
  "appPaths",
  "pickDocsRoot",
  "revealRoot",
  "revealArtifact",
  "revealPage",
  "onFileDrop",
  "onCloseRequested",
  "watchUpdate",
  "restartToUpdate",
  "audioInfo",
  "pickAudioFiles",
  "micStatus",
  "startRecording",
  "stopRecording",
  "discardRecording",
  "leftoverRecordings",
  "openMicrophoneSettings",
  "onRecordingCloseRequested",
  "closeAfterRecording",
  "providerStatus",
  "startAuth",
  "installClaude",
  "updateClaude",
  "speechStatus",
  "speechDownload",
  "transcribe",
  "stopTranscribe",
  "prepareAudio",
  "transcribeAudioPart",
  "releaseAudio",
  "providerUsage",
  "transcribeDeepgram",
  "apiKeyStatus",
  "saveApiKey",
  "checkApiKey",
  "deleteApiKey",
  "runTurn",
  "stopTurn",
  "pickSampleFiles",
  "importSamples",
  "fetchSampleUrl",
  "saveSampleUrl",
  "pcRunnerStatus",
  "loadExecution",
  "saveExecution",
  "setPcRunnerEnabled",
  "onPcRunnerState",
  "personalOpen",
  "personalCancel",
  "personalClose",
  "personalGuard",
  "personalReserveIntent",
  "personalMarkDispatch",
  "personalMarkIntent",
  "personalSavePrivate",
  "personalReadMaterial",
  "personalSwapModels",
  "personalVerifyInputs",
  "personalPersistCandidate",
  "personalPublish",
  "personalRecord",
  "personalNihoEnsureIdle",
  "personalNihoAccess",
  "personalNihoSubmit",
  "personalNihoConfirm",
  "personalNihoPending",
  "cloudStorageSelect",
  "cloudStorageReopeningPreview",
  "cloudStorageReopen",
  "cloudSetProvider",
  "cloudSetDeviceName",
  "cloudMigrationStart",
  "cloudMigrationCancel",
  "cloudState",
  "cloudProjectStatus",
  "cloudPageShareGet",
  "cloudPageShareSet",
  "cloudPageShareRotate",
  "cloudPageShareOpen",
  "cloudRemoteProjects",
  "cloudDeletedProjects",
  "cloudOpenProject",
  "cloudRestoreProject",
  "cloudTombstoneChoice",
  "cloudSyncNow",
  "cloudFocus",
  "cloudProtect",
  "cloudRelease",
  "cloudConflicts",
  "cloudConflictCopy",
  "cloudResolveConflict",
  "cloudUsage",
  "onCloudState",
  "onCloudProject",
  "onCloudApplied",
  "onCloudRemote",
] as const satisfies readonly (keyof Bridge)[];
export type NativeDocsOperation = (typeof NATIVE_DOCS_OPERATIONS)[number];
export type DocsHost = Omit<Bridge, NativeDocsOperation> & Partial<Pick<Bridge, NativeDocsOperation>>;
