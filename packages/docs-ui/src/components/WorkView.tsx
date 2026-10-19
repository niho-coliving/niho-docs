"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import type { Bridge } from "../lib/bridge";
import { FeatureToggleSwitch } from "niho-ui/components/feature-toggle-switch";
import {
  RUN_ACTION_LABELS,
  AI_OVERWROTE_EDIT_NOTICE,
  SOURCE_STEP_ID,
  STALE_LABELS,
  basisFor,
  canRunStep,
  countChars,
  effortLabel,
  estimateRunCostUsd,
  formatUsd,
  hasTranscriptParts,
  listTranscriptSpeakers,
  normalizeTranscriptSpeakerNames,
  providerLabel,
  staleNoticeText,
  staleReasons,
  type RunRecord,
  type TranscriptSpeakerEntry,
} from "@niho/docs-core";
import { formatChars, formatDateTime, formatDuration, formatElapsed, formatNumber } from "../lib/format";
import {
  markdownHasTimestamps,
  markdownWithoutTimestamps,
  renderMarkdown,
  renderTranscriptMarkdown,
} from "../lib/markdown";
import { candidateMarkdown, candidateVersions, recordingRef, stepMarkdown, stepName, transcriptOriginProvider, versionsOf, type RecordingView } from "../lib/project-view";
import { setTimestampPlaybackState, setTimestampSeekHandler } from "../lib/timestamps";
import { candidateChoiceReason, runGate } from "../lib/run-gate";
import { runIsOn, type ActiveRun, type RunNotice } from "../lib/run-state";
import type { SaveStatus } from "../lib/cloud";
import { engineLabel } from "../lib/settings";
import type { ChatController } from "../lib/use-chat";
import type { ChatTarget } from "../lib/chat";
import { BlockEditor } from "./BlockEditor";
import { EditorTools, type EditorToolControls } from "./EditorTools";
import { ChatPanel } from "./ChatPanel";
import { DocsWorkLayout } from "./DocsComposerRail";
import { RunGateNote, RunningBand } from "./RunBand";
import { ClockIcon } from "./icons";
import { CloudPageNotice, SaveStatusText } from "./SaveStatus";
import { useDocEditor } from "./useDocEditor";
import { useNow } from "./useNow";
import { usePopover } from "./usePopover";
import { TranscriptSpeakerRow } from "./TranscriptSpeakerRow";
import { AudioPlaybackBar, type AudioPlaybackHandle, type AudioPlaybackState } from "./AudioPlaybackBar";

/**
 * 録音の成果物の子ページ（P3 #18566）: 文書のページと同じページの形（タイトル＝工程の名前・メタ行・本文の BlockEditor）と、右の
 * 「AIと作る」（会話と入力欄。ChatPanel。タイトルバーの右端のボタンで開閉）。履歴はタイトルバーの右端（StepActions）、書き出し・検索・
 * 書式はタイトルバーの ⋯（App が PageTop に置く。owner 2026-10-18・#18941）。
 * 保存のボタンは置かない（本文は自動で保存し、版は App が編集のまとまりごとに自動で残す・#18912）。履歴で開いた古い版は読むだけで、
 * 本文の上の 1 行から「この版に戻す」「現在版に戻る」。
 */

/** 履歴で開いた古い版（読むだけ）。versionPath は開いた履歴の行の版のファイル（旧形式の番号の版には無い）。 */
export type ViewingVersion = { version: number; versionPath?: string; markdown: string };

/**
 * 履歴の行が開いている版か。2 台の Mac が同期前に同じ番号の版を作ると、番号が同じで versionPath の違う行が並ぶので、
 * versionPath があればそれも比べる（番号だけで比べると両方の行が選択中になり、日時・作成者・話者名も別の行のものを出す）。
 */
function isViewedRecord(record: RunRecord, viewing: Pick<ViewingVersion, "version" | "versionPath">): boolean {
  return record.version === viewing.version && (viewing.versionPath === undefined || record.versionPath === viewing.versionPath);
}

/** 旧 INPUT_CHANGED の版は正本へ反映していない。履歴から開けるよう、現在版とは扱わない。 */
function isLegacyUnpublished(record: RunRecord): boolean {
  return (record as RunRecord & { inputChanged?: boolean }).inputChanged === true;
}

export type WorkViewProps = {
  bridge: Bridge;
  onError: (message: string) => void;
  view: RecordingView;
  stepId: string;
  /** 録音のページの名前（メタ行の「〈録音〉から」）。 */
  recordingTitle: string;
  activeRun: ActiveRun | null;
  anyRunActive: boolean;
  /** ほかの案件の実行中に、この案件の実行を押せない理由（run-state の runBlockedReason）。 */
  blockedReason: string | null;
  /** 別の Mac が実行中の理由（実行を押せなくする。cloud の leaseRunNote）。 */
  leaseNote?: string | null;
  /** 実行の前に分かる準備の不足（run-readiness）を、実行する工程ごとに返す。 */
  setupReasonFor: (queue: readonly string[], explicit?: boolean) => string | null;
  /** 準備の不足を直す設定の画面を開く。 */
  onOpenSettings: () => void;
  /** 実行中の工程を止める（録音のページの「止める」と同じ）。 */
  onStop: () => void;
  notice: RunNotice | null;
  draft: string | undefined;
  /** 履歴で開いた古い版（読むだけ。null は現在版）。 */
  viewing: ViewingVersion | null;
  /** 「この版に戻す」: 戻す前の内容を版に残してから、開いている版の本文を新しい版にして現在版にする。 */
  onRestoreVersion: () => void;
  /** 「現在版に戻る」: 古い版の表示をやめる。 */
  onCloseVersion: () => void;
  onDraftChange: (markdown: string) => void;
  onRunStep: (stepId: string) => void;
  /**
   * 「作り直す」（案でない子ページの、元にした内容が変わった知らせの 1 行。タイトルバーの ⋯ と同じ。#18915）。無ければその 1 行に
   * 操作を出さない。
   */
  onRebuild?: () => void;
  /** 実行中に直した対象本文を、直前に残した版から新しい版として戻す。 */
  onUndoOverwritten?: (created: RunRecord, previous: RunRecord) => void;
  onRunRemaining: () => void;
  onRenameSpeaker: (speaker: TranscriptSpeakerEntry, name: string | null) => void;
  /** 話者名・この版に戻すを保存中。 */
  saving: boolean;
  /** native が捕捉した編集 handle。変わったら editor をその snapshot で作り直す。 */
  documentRevision: string;
  documentReady: boolean;
  /** 版にしなかった途中までの出力（runs/<runId>.json の checkpoint）を読む。 */
  loadPartial: (runId: string) => Promise<string | null>;
  /** 「AIと作る」の会話（App の useChat）。 */
  chat: ChatController;
  /** 右の「AIと作る」を出すか（タイトルバーの右端の「AIと作る」で開閉）。 */
  chatOpen: boolean;
  /** 保存の状態（メタ行の末尾。C3 #18595）。 */
  saveStatus?: SaveStatus | null;
  sharingActive?: boolean;
  onOpenSharing?: () => void;
  /** 本文の上の知らせ（別の Mac で更新された・両方で変更された）。 */
  banner?: ReactNode;
  target?: ChatTarget | null;
  onCandidateNameChange?: (name: string) => void;
  onCandidateNameCommit?: (name: string) => void;
  onCompare?: () => void;
  /**
   * 文字起こしの案のページ（#19108）: 後工程に使う文字起こしの状態と切替。文字起こしの案が 2 つ以上のときだけ渡す。開くだけでは
   * 変えず、本文の上の 1 行の「この文字起こしを後工程に使う」だけで変える。
   */
  sourceUse?: {
    /** このページの文字起こしを後工程に使っている。 */
    selected: boolean;
    /** 今、後工程に使っている文字起こしの名前（決められなければ null）。 */
    selectedName: string | null;
    /** 変えた直後の 1 行（「元に戻す」があれば onUndo）。 */
    notice: { text: string; onUndo?: () => void } | null;
    /** 押せない（実行中・保存中）。 */
    disabled: boolean;
    onChoose: () => void;
  };
  showTimestamps: boolean;
  onShowTimestampsChange: (show: boolean) => void;
  /** 検索・書式の入口（タイトルバーの ⋯ と ⌘F。App が持つ）。 */
  onEditorTools?: (controls: EditorToolControls | null) => void;
};

function isTimestampArtifact(view: RecordingView, stepId: string, markdown: string): boolean {
  if (view.recording.source.kind === "text") return false;
  return stepId === SOURCE_STEP_ID || markdownHasTimestamps(markdown);
}

/** 版を書いた AI とプロファイル（「Claude 標準」）・文字起こしのエンジン（「この Mac」）・人の保存（「保存」）。 */
function versionAuthor(record: RunRecord): string | null {
  if (record.kind === "save") return "保存";
  if (record.provider === "this-mac" || record.provider === "deepgram") return engineLabel(record.provider);
  if (!record.provider) return null;
  return `${providerLabel(record.provider)} ${record.profile ?? ""}`.trim();
}

/** 履歴の行の説明（利用者の編集は「編集」・戻した版は「版 N から」・AI は工程名や「AIと作る」。design-guide-docs §2）。 */
function versionDescription(record: RunRecord): string {
  if (record.kind === "agent") return `AIと作る「${record.instruction ?? ""}」`;
  if (record.kind === "run") return `${record.stepName}を実行`;
  return record.restoredFrom ? `版 ${record.restoredFrom} から` : "編集";
}

function HistoryPopover(props: {
  view: RecordingView;
  stepId: string;
  /** 開いている古い版（null は現在版）。 */
  viewing: Pick<ViewingVersion, "version" | "versionPath"> | null;
  disabled: boolean;
  /** 古い版を読むだけで開く（null は現在版に戻る）。versionPath は選んだ履歴の行の版のファイル（同じ番号の版が複数あっても取り違えない）。 */
  onOpenVersion: (version: number | null, versionPath?: string) => void;
  target?: ChatTarget | null;
}) {
  const popover = usePopover();
  const versions = props.target
    ? candidateVersions(props.view, props.stepId, props.target.candidateId)
    : candidateVersions(props.view, props.stepId);
  return (
    <div ref={popover.ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="ibtn"
        title="履歴"
        aria-label="履歴"
        aria-pressed={popover.open}
        aria-expanded={popover.open}
        disabled={props.disabled}
        onClick={popover.toggle}
      >
        <ClockIcon />
      </button>
      {popover.open && (
        <div className="pop hist" role="menu">
          {versions.length === 0 && <div className="help" style={{ padding: "8px 10px" }}>版はまだありません</div>}
          {versions.map((record, index) => {
            const version = record.version ?? 0;
            // 番号ではなく行で現在版を決める（2 台の Mac が同期前に同じ番号の版を保存することがある）
            const isLatest = index === versions.findIndex((row) => !isLegacyUnpublished(row));
            // AI が書き換えた版（AIと作る）も実行と同じく提供元・モデル・所要・トークンを添える
            const isRun = record.kind === "run" || record.kind === "agent";
            // 文字起こしのエンジン（この Mac・Deepgram）はトークンを数えない
            const engine = record.provider === "this-mac" || record.provider === "deepgram" ? record.provider : null;
            const cost = estimateRunCostUsd(record);
            const meta = isRun
              ? [
                  versionAuthor(record),
                  engine !== "this-mac" ? (record.modelUsed ?? record.model ?? null) : null,
                  record.effort ? effortLabel(record.effort) : null,
                  record.durationMs ? formatDuration(record.durationMs) : null,
                  !engine
                    ? record.tokensKnown === false || record.inputTokens === undefined
                      ? "トークン 取得できません"
                      : `入 ${formatNumber(record.inputTokens)} / 出 ${formatNumber(record.outputTokens ?? 0)} トークン`
                    : null,
                  record.continuations ? `続き ${record.continuations} 回` : null,
                  // API キー方式の見込み金額（サブスクリプションは出さない。返らなければ推測しない）
                  record.connection === "apiKey" && engine !== "this-mac"
                    ? `見込み ${cost === null ? "取得できません" : formatUsd(cost)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "";
            return (
              <button
                type="button"
                key={record.id}
                role="menuitem"
                className={`hrow${props.viewing !== null && isViewedRecord(record, props.viewing) ? " on" : ""}`}
                onClick={() => {
                  popover.setOpen(false);
                  if (!isLatest) props.onOpenVersion(version, record.versionPath);
                  else if (props.viewing !== null) props.onOpenVersion(null);
                }}
              >
                <b>
                  版 {version}
                  {isLatest && <span className="pill">現在版</span>}
                </b>
                <span className="d">{versionDescription(record)}</span>
                <span className="t">{formatDateTime(record.at)}</span>
                {meta && <span className="m">{meta}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export type StepActionsProps = {
  view: RecordingView;
  stepId: string;
  activeRun: ActiveRun | null;
  /** 履歴で開いた古い版。 */
  viewing: ViewingVersion | null;
  /** 古い版を読むだけで開く（null は現在版に戻る）。versionPath は選んだ履歴の行の版のファイル（同じ番号の版が複数あっても取り違えない）。 */
  onOpenVersion: (version: number | null, versionPath?: string) => void;
  target?: ChatTarget | null;
};

/** その工程（開いている案）を実行中か。 */
function stepRunningHere(view: RecordingView, stepId: string, activeRun: ActiveRun | null, target: ChatTarget | null | undefined): boolean {
  return runIsOn(activeRun, view) && activeRun?.stepId === stepId && (activeRun?.candidateId ?? null) === (target?.candidateId ?? null);
}

/**
 * 成果物の子ページの操作（タイトルバーの右端）: 履歴（古い版を読むだけで開く）。書き出しは ⋯ の「書き出し ›」（stepExport・
 * owner 2026-10-18・#18941）。保存のボタンは置かない（本文は自動で保存し、版は編集のまとまりごとに自動で残す・#18912）。文書がまだ
 * 無い工程では出さず、その工程の実行中は押せない。
 */
export function StepActions(props: StepActionsProps) {
  const { view, stepId } = props;
  const saved = props.target ? candidateMarkdown(view, stepId, props.target.candidateId) : stepMarkdown(view, stepId);
  if (saved === undefined) return null;
  return (
    <HistoryPopover
      view={view}
      stepId={stepId}
      target={props.target}
      viewing={props.viewing}
      disabled={stepRunningHere(view, stepId, props.activeRun, props.target)}
      onOpenVersion={props.onOpenVersion}
    />
  );
}

/**
 * 成果物の子ページの書き出す本文（⋯ の「書き出し ›」）: 履歴で開いた古い版はその本文、書きかけがあればそれ。タイムスタンプを隠して
 * いれば外して書き出す。文書がまだ無い工程は null（書き出しを出さない）。その工程の実行中と本文が空の間は押せない。
 */
export function stepExport(props: {
  view: RecordingView;
  stepId: string;
  activeRun: ActiveRun | null;
  draft: string | undefined;
  viewing: ViewingVersion | null;
  target?: ChatTarget | null;
  showTimestamps: boolean;
}): { markdown: string; disabled: boolean } | null {
  const { view, stepId, draft, viewing } = props;
  const saved = props.target ? candidateMarkdown(view, stepId, props.target.candidateId) : stepMarkdown(view, stepId);
  if (saved === undefined) return null;
  const markdown = viewing ? viewing.markdown : (draft ?? saved);
  const exported = !props.showTimestamps && isTimestampArtifact(view, stepId, markdown) ? markdownWithoutTimestamps(markdown) : markdown;
  return { markdown: exported, disabled: stepRunningHere(view, stepId, props.activeRun, props.target) || !exported };
}

/** 本文（文書のページと同じ BlockEditor。「/」のメニューにページの操作は出さない）。 */
function StepDocument(props: WorkViewProps & { markdown: string; editable: boolean; timestampArtifact: boolean; onEditor: (editor: Editor | null) => void }) {
  const documentKey = `${props.view.key}::${props.target?.artifactId ?? props.stepId}::${props.viewing ? `${props.viewing.version}:${props.viewing.versionPath ?? ""}` : "latest"}::${props.documentRevision}`;
  const viewing = props.viewing !== null;
  const editor = useDocEditor({
    documentKey,
    markdown: props.markdown,
    editable: props.editable,
    resolveAsset: (name) => props.bridge.readImageAsset(props.view.projectId, name),
    timestampMode: props.timestampArtifact ? (props.showTimestamps ? "shown" : "hidden") : null,
    // 古い版は読むだけ（書きかけにしない）
    onChange: viewing ? noop : props.onDraftChange,
  });
  useEffect(() => {
    props.onEditor(editor);
    return () => props.onEditor(null);
  }, [editor, props.onEditor]);
  return (
    <div className="pbody">
      <BlockEditor editor={editor} />
    </div>
  );
}

function noop() {}

/** 古い版を開いている間の本文の上の 1 行（「版 N を表示中」・「この版に戻す」・「現在版に戻る」。design-guide-docs §2）。 */
function VersionViewBar(props: { version: number; busy: boolean; restoreDisabled: boolean; onRestore: () => void; onClose: () => void }) {
  return (
    <div className="version-view" role="status">
      <span className="note">版 {props.version} を表示中</span>
      <span className="sp" />
      <button type="button" className="btn primary sm" disabled={props.restoreDisabled || props.busy} aria-busy={props.busy || undefined} onClick={props.onRestore}>
        この版に戻す
      </button>
      <button type="button" className="btn ghost sm" disabled={props.busy} onClick={props.onClose}>
        現在版に戻る
      </button>
    </div>
  );
}

/** メタ行の項目を「·」でつなぐ（折り返しで「·」だけが行末に残らないよう、「·」は次の項目といっしょに折り返す）。 */
function joined(items: ReadonlyArray<ReactNode | null>): ReactNode[] {
  return items
    .filter((item): item is ReactNode => item !== null)
    .map((item, index) =>
      index === 0 ? (
        <Fragment key={index}>{item}</Fragment>
      ) : (
        <span className="seg" key={index}>
          <span className="dotsep">·</span>
          {item}
        </span>
      ),
    );
}

export type StepRunInput = Pick<
  WorkViewProps,
  "view" | "stepId" | "activeRun" | "blockedReason" | "leaseNote" | "setupReasonFor" | "saving" | "target"
> & { chat: Pick<ChatController, "sending" | "live"> };

/**
 * 子ページから実行できるか（実行の帯の理由・空のページの「〈工程〉を実行」・「作り直す」）。WorkView と、App がタイトルバーの ⋯ に置く
 * 「作り直す」で同じ判定にする（#18915）。
 */
export function stepRunState(input: StepRunInput) {
  const { view, stepId, activeRun } = input;
  const saved = input.target ? candidateMarkdown(view, stepId, input.target.candidateId) : stepMarkdown(view, stepId);
  const isSource = stepId === SOURCE_STEP_ID;
  const canRun = canRunStep(view.plan, stepId);
  const rerunnable = Boolean(saved) && !(isSource && view.recording.source.kind === "text");
  // 会話の依頼がこの案件（どの録音でも）で動いている間は、工程を実行しない（同じ案件の実行は 1 つ）
  const chatBusyHere = input.chat.sending && (input.chat.live === null || input.chat.live.projectId === view.projectId);
  // この録音のどの工程が動いていても、ここから止められる（録音のページへ戻らなくてよい）
  const runningOnRecording = runIsOn(activeRun, view);
  const fixedStepId = input.target?.stepId ?? null;
  const runQueue = rerunnable || canRun ? [stepId] : view.plan.remaining;
  // 押せない理由は録音のページの実行の帯と同じ判定（run-gate）。押してから失敗する経路（別の Mac の実行・別案の未選択）を作らない
  const gate = runningOnRecording
    ? null
    : runGate({
        activeRun,
        recording: view,
        blockedReason: input.blockedReason,
        chatBusy: chatBusyHere,
        leaseNote: input.leaseNote ?? null,
        candidateReason: candidateChoiceReason({ recording: view.recording, flow: view.flow, queue: runQueue, fixedStepId }),
        executionReason: !isSource && view.executionBlockReason ? { reason: view.executionBlockReason, setup: false } : null,
        setupReason: input.setupReasonFor(runQueue, rerunnable || canRun),
      });
  const runBlocked = runningOnRecording || gate !== null || input.saving;
  return { saved, canRun, rerunnable, chatBusyHere, runningOnRecording, fixedStepId, gate, runBlocked };
}

export function WorkView(props: WorkViewProps) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [toolHost, setToolHost] = useState<HTMLDivElement | null>(null);
  const playbackRef = useRef<AudioPlaybackHandle>(null);
  const [playback, setPlayback] = useState<AudioPlaybackState>({ positionSec: 0, playing: false, follow: true });
  const { view, stepId, activeRun } = props;
  const progress = view.plan.steps.find((step) => step.stepId === stepId);
  const name = props.target?.name ?? stepName(view, stepId);
  const { saved, canRun, rerunnable, chatBusyHere, runningOnRecording, fixedStepId, gate, runBlocked } = stepRunState(props);
  const runningHere = runIsOn(activeRun, view) && activeRun?.stepId === stepId && (activeRun?.candidateId ?? null) === (props.target?.candidateId ?? null);
  const now = useNow(runningHere);
  const viewing = props.viewing;
  const markdown = viewing ? viewing.markdown : (props.draft ?? saved ?? "");
  const versions = props.target ? candidateVersions(view, stepId, props.target.candidateId) : candidateVersions(view, stepId);
  // 表示している版（履歴の古い版を開いていればその版）の記録
  const currentVersion = versions.find((record) => !isLegacyUnpublished(record));
  const shown = viewing ? versions.find((record) => isViewedRecord(record, viewing)) : currentVersion;
  const shownVersion = viewing?.version ?? currentVersion?.version ?? (saved ? 1 : null);
  const isSource = stepId === SOURCE_STEP_ID;
  const flowIndex = view.flow.steps.findIndex((step) => step.id === stepId);
  const candidateStale = props.target && versions[0]?.basis && flowIndex >= 0
    ? staleReasons(
        versions[0].basis,
        basisFor(view.flow, flowIndex, { ...view.materials, candidateInstruction: props.target.instruction }),
      ).length > 0
    : false;
  const index = view.plan.steps.findIndex((step) => step.stepId === stepId);
  const previousDone = [...view.plan.steps.slice(0, Math.max(0, index))].reverse().find((step) => step.done);
  const lastDone = [...view.plan.steps].reverse().find((step) => step.done);
  // 別の工程で実行を押せない理由（入力欄の「＋ → 工程を実行」。1 工程ずつ見る）
  const stepRunReason = (id: string): string | null =>
    candidateChoiceReason({ recording: view.recording, flow: view.flow, queue: [id], fixedStepId }) ??
    (id === SOURCE_STEP_ID ? null : view.executionBlockReason) ?? props.setupReasonFor([id], true);
  // 実行の帯: 同じ録音の別の工程が動いているときは「止める」、押せないときは理由（準備の不足は設定への導線つき）
  const band =
    runningOnRecording && !runningHere && activeRun ? (
      <div className="runbar">
        <RunningBand stepName={activeRun.stepName} stopRequested={activeRun.stopRequested} onStop={props.onStop} />
      </div>
    ) : gate && (rerunnable || saved === undefined) ? (
      <div className="runbar">
        <RunGateNote gate={gate} onOpenSettings={props.onOpenSettings} />
      </div>
    ) : null;
  const displayedMarkdown = runningHere && activeRun ? activeRun.text : markdown;
  const timestampArtifact = isTimestampArtifact(view, stepId, displayedMarkdown);
  const liveHtml = useMemo(
    () =>
      runningHere && activeRun
        ? timestampArtifact
          ? renderTranscriptMarkdown(activeRun.text, props.showTimestamps)
          : renderMarkdown(activeRun.text)
        : "",
    [runningHere, activeRun, timestampArtifact, props.showTimestamps],
  );
  const displayedRecord = isSource
    ? viewing
      ? versions.find((record) => isViewedRecord(record, viewing))
      : versions[0]
    : undefined;
  const speakerNames = normalizeTranscriptSpeakerNames(displayedRecord?.transcriptSpeakerNames);
  const speakers = isSource ? listTranscriptSpeakers(markdown, speakerNames) : [];
  const speakerCandidates = isSource
    ? [...new Set([...view.project.info.terms.map((entry) => entry.term.trim()), ...Object.values(speakerNames)].filter(Boolean))]
    : [];
  const sourceOrigin = isSource ? transcriptOriginProvider(view.runs, displayedRecord?.version ?? null, props.target?.artifactId ?? SOURCE_STEP_ID) : null;
  const multipleAudioWithoutParts =
    isSource &&
    view.recording.source.kind === "audio" &&
    view.recording.source.audio.length > 1 &&
    !hasTranscriptParts(markdown) &&
    (sourceOrigin === "deepgram" || sourceOrigin === null);

  const changePlayback = useCallback((next: AudioPlaybackState) => {
    setPlayback(next);
    if (editor) setTimestampPlaybackState(editor, next);
  }, [editor]);
  useEffect(() => {
    if (!editor) return;
    setTimestampSeekHandler(editor, (second) => playbackRef.current?.seek(second));
    return () => setTimestampSeekHandler(editor, null);
  }, [editor]);
  useEffect(() => {
    if (editor) setTimestampPlaybackState(editor, playback);
  }, [editor, playback]);

  const seekFromRenderedTimestamp = (target: EventTarget | null): boolean => {
    const element = target instanceof Element ? target.closest<HTMLElement>("[data-transcript-seek-seconds]") : null;
    if (!element) return false;
    const second = Number(element.dataset.transcriptSeekSeconds);
    if (!Number.isFinite(second) || second < 0) return false;
    playbackRef.current?.seek(second);
    return true;
  };

  // 案でない子ページは文書のページと同じメタ行（〈録音〉から · 〈日時〉 · 〈保存の状態〉）。工程の番号・字数・書いた AI・版の番号・
  // 作り直しのボタンは出さない（版は履歴、作り直すはタイトルバーの ⋯。#18915）
  const shownAt = saved !== undefined && !runningHere && shown ? formatDateTime(shown.at) : "";
  // 元にした内容が変わった知らせ（本文の上の 1 行）。別の Mac の知らせ（banner）があればそちらだけを出す（帯を重ねない）
  const staleText = !props.target && progress?.stale && !runningHere
    ? staleNoticeText(progress.staleReasons, view.recording.source.kind === "text" ? "text" : "audio")
    : null;
  const rebuildDisabled = !rerunnable || runBlocked;
  const staleNotice = staleText ? (
    props.onRebuild ? (
      <CloudPageNotice text={staleText} action="作り直す" disabled={rebuildDisabled} onAction={props.onRebuild} />
    ) : (
      <div className="cloud-banner" role="status">
        <span>{staleText}</span>
      </div>
    )
  ) : null;
  const previousCurrentVersion = versions.find((record) => record !== shown && !isLegacyUnpublished(record));
  const overwritten = !props.target && !viewing && !view.unversioned.includes(stepId)
    && shown?.reasonCode === "target_changed_during_execution" && previousCurrentVersion && typeof previousCurrentVersion.version === "number"
    ? { created: shown, previous: previousCurrentVersion } : null;
  const overwrittenNotice = overwritten && props.onUndoOverwritten
    ? <CloudPageNotice text={AI_OVERWROTE_EDIT_NOTICE} action="元に戻す" disabled={props.saving || runningHere} onAction={() => props.onUndoOverwritten?.(overwritten.created, overwritten.previous)} />
    : null;
  // 後工程に使う文字起こし（#19108）: 変えた直後は結果の 1 行、それ以外は使っていない案のページだけに切替の 1 行
  const sourceUse = props.sourceUse;
  const sourceUseNotice = !sourceUse || viewing
    ? null
    : sourceUse.notice
      ? sourceUse.notice.onUndo
        ? <CloudPageNotice text={sourceUse.notice.text} action="元に戻す" disabled={sourceUse.disabled} onAction={sourceUse.notice.onUndo} />
        : <div className="cloud-banner" role="status"><span>{sourceUse.notice.text}</span></div>
      : !sourceUse.selected && saved !== undefined
        ? <CloudPageNotice
            text={sourceUse.selectedName ? `後工程には「${sourceUse.selectedName}」を使っています。` : "後工程に使う文字起こしが見つかりません。"}
            action="この文字起こしを後工程に使う"
            disabled={sourceUse.disabled}
            onAction={sourceUse.onChoose}
          />
        : null;
  const author = shown ? versionAuthor(shown) : null;
  const status: Array<ReactNode | null> = runningHere
    ? [<span className="pill warn">作成中</span>]
    : saved === undefined
      ? [<span className="pill mute">未作成</span>]
      : [
          <span>{formatChars(countChars(markdown))}</span>,
          author ? <span>{author}</span> : null,
          shown && formatDateTime(shown.at) ? <span>{formatDateTime(shown.at)}</span> : null,
          shownVersion !== null ? <span className="ver">第 {shownVersion} 版</span> : null,
        ];

  return (
    <DocsWorkLayout chatOpen={props.chatOpen}>
      <div className="sheet">
        <div className="pg">
          {props.target ? (
            <input
              className="ptitle candidate-title"
              aria-label="案の名前"
              value={name}
              onChange={(event) => props.onCandidateNameChange?.(event.target.value)}
              onBlur={(event) => props.onCandidateNameCommit?.(event.target.value)}
            />
          ) : <h1 className="ptitle">{name}</h1>}
          <div className="pmeta work-meta">
            {props.target ? (
              <div className="work-meta-info">
                <span className="pill mute">工程 {progress?.number ?? 1}</span>
                {joined([<span>{props.recordingTitle} から</span>, ...status])}
                {saved !== undefined && !runningHere && props.saveStatus !== undefined && <SaveStatusText status={props.saveStatus} />}
                {(props.target ? candidateStale : progress?.stale) && !runningHere && <span className="pill warn">{STALE_LABELS.stale}</span>}
                {props.sourceUse?.selected && <span className="pill used-later">後工程に使用</span>}
                <span className="sp" />
                {props.onCompare && <button type="button" className="btn ghost sm" onClick={props.onCompare}>比較</button>}
                {rerunnable && !runningHere && (
                  <button type="button" className="btn ghost sm" disabled={runBlocked} onClick={() => props.onRunStep(stepId)}>
                    再実行
                  </button>
                )}
              </div>
            ) : (
              <div className="work-meta-info">
                {/* 文書のページのメタ行（DocPage）と同じ組み方。joined の .seg は地の色の付く部品と同じ名前なので使わない */}
                <span>{props.recordingTitle} から</span>
                {shownAt ? <><span className="dotsep">·</span><span>{shownAt}</span></> : null}
                {saved !== undefined && !runningHere && props.saveStatus !== undefined && <SaveStatusText status={props.saveStatus} />}
                {props.sharingActive && !props.target && <button type="button" className="docs-share-meta" onClick={props.onOpenSharing}>↗ リンクで共有中</button>}
              </div>
            )}
            {timestampArtifact && (saved !== undefined || runningHere) && (
              <div className="work-meta-actions">
                <div className="timestamp-control">
                  <label className="timestamp-label" htmlFor="timestamp-toggle">タイムスタンプ</label>
                  <FeatureToggleSwitch
                    id="timestamp-toggle"
                    checked={props.showTimestamps}
                    disabled={false}
                    size="sm"
                    onChange={props.onShowTimestampsChange}
                    ariaLabel={`タイムスタンプを${props.showTimestamps ? "非表示" : "表示"}にする`}
                    className="docs-feature-toggle-switch"
                    thumbClassName="docs-feature-toggle-switch__thumb"
                  />
                </div>
              </div>
            )}
          </div>
          {/* 検索・書式の入口はタイトルバーの ⋯ と ⌘F（owner 2026-10-18・#18941）。ここは検索の箱と書式の行の置き場 */}
          {saved !== undefined && !runningHere && !viewing && <EditorTools key={`${view.key}:${stepId}`} editor={editor} bridge={props.bridge} projectId={view.projectId} panelHost={toolHost} onError={props.onError} onControls={props.onEditorTools} />}
          <div ref={setToolHost} />
          {timestampArtifact && view.recording.source.kind === "audio" && view.recording.source.audio.length > 0 && (
            <AudioPlaybackBar
              ref={playbackRef}
              bridge={props.bridge}
              recording={recordingRef(view)}
              audio={view.recording.source.audio}
              missingInputs={view.missingInputs}
              followParagraphs
              onStateChange={changePlayback}
            />
          )}
          {!runningHere && (props.banner ?? overwrittenNotice ?? staleNotice ?? sourceUseNotice)}
          {runningHere && activeRun ? (
            <div className="pbody">
              <div className="progress-line">
                <span className="spin" />
                {name}を作成中 · {activeRun.modelLabel} · {formatElapsed(now - activeRun.startedAt)}
                <button type="button" className="btn stop sm" onClick={props.onStop} disabled={activeRun.stopRequested}>
                  {RUN_ACTION_LABELS.stop}
                </button>
              </div>
              <div
                className={`doc${timestampArtifact ? (props.showTimestamps ? " timestamps-on" : " timestamps-off timestamps-live") : ""}`}
                onMouseDown={(event) => {
                  if (event.target instanceof Element && event.target.closest("[data-transcript-seek-seconds]")) event.preventDefault();
                }}
                onClick={(event) => seekFromRenderedTimestamp(event.target)}
                onKeyDown={(event) => {
                  if ((event.key === "Enter" || event.key === " ") && seekFromRenderedTimestamp(event.target)) event.preventDefault();
                }}
              >
                <div dangerouslySetInnerHTML={{ __html: liveHtml }} />
                <span className="cursor" />
              </div>
            </div>
          ) : saved !== undefined && !props.documentReady ? (
            <div className="pbody" role="status">本文を開いています…</div>
          ) : saved !== undefined ? (
            <>
              {band}
              {viewing && (
                <VersionViewBar
                  version={viewing.version}
                  busy={props.saving}
                  restoreDisabled={props.anyRunActive || chatBusyHere}
                  onRestore={props.onRestoreVersion}
                  onClose={props.onCloseVersion}
                />
              )}
              {isSource && speakers.length > 0 && (
                <TranscriptSpeakerRow
                  speakers={speakers}
                  candidates={speakerCandidates}
                  disabled={props.anyRunActive || chatBusyHere || viewing !== null}
                  pending={props.saving}
                  unavailableReason={
                    multipleAudioWithoutParts
                      ? "複数の音声で話者番号が重なるため、音声ごとの区切りがないこの版では名前を付けられません。"
                      : null
                  }
                  onRename={props.onRenameSpeaker}
                />
              )}
              <StepDocument
                {...props}
                markdown={markdown}
                editable={props.documentReady && !props.saving && !viewing && (!props.anyRunActive || activeRun?.projectId !== view.projectId)}
                timestampArtifact={timestampArtifact}
                onEditor={setEditor}
              />
            </>
          ) : (
            <div className="empty">
              {canRun ? (
                <>
                  {previousDone && <span>{previousDone.name}まで完了しています</span>}
                  <button type="button" className="btn primary" disabled={runBlocked} onClick={() => props.onRunStep(stepId)}>
                    {name}を実行
                  </button>
                </>
              ) : (
                <>
                  {lastDone && <span>{lastDone.name}まで完了しています</span>}
                  <button type="button" className="btn primary" disabled={runBlocked} onClick={props.onRunRemaining}>
                    残りの工程を実行
                  </button>
                </>
              )}
              {band}
              {props.notice && runIsOn(props.notice, view) && props.notice.stepId === stepId && (
                <p className={props.notice.kind === "failed" ? "err" : "help"}>{props.notice.message}</p>
              )}
            </div>
          )}
        </div>
      </div>
      {props.chatOpen && (
        <div className="col">
          <ChatPanel
            view={view}
            activeRun={runIsOn(activeRun, view) ? activeRun : null}
            projectRunning={activeRun !== null && activeRun.projectId === view.projectId && !runIsOn(activeRun, view)}
            chat={props.chat}
            loadPartial={props.loadPartial}
            runBlocked={props.anyRunActive || chatBusyHere || props.saving || Boolean(props.leaseNote) || Boolean(view.executionBlockReason)}
            stepRunReason={stepRunReason}
            saving={props.saving}
            onRunStep={props.onRunStep}
            target={props.target}
          />
        </div>
      )}
    </DocsWorkLayout>
  );
}
