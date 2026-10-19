"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  RUN_ACTION_LABELS,
  SOURCE_STEP_ID,
  canRunStep,
  conversationTitle,
  documentNameForFile,
  effortLabel,
  estimateRunCostUsd,
  formatUsd,
  inputsFor,
  mergeGlossaries,
  pageTitle,
  projectPages,
  shortModelLabel,
  toolLabel,
  workItemCount,
  type ChatTurn,
  type ConversationFile,
  type InputRef,
  type RunRecord,
  type TurnItem,
  type TurnPageChange,
  type TurnVersion,
} from "@niho/docs-core";
import { conversationEntries, type ChatTarget, type ConversationEntry, type LiveChat } from "../lib/chat";
import { formatAudioLength, formatChars, formatDateTime, formatDuration, formatElapsed, formatSendAmount } from "../lib/format";
import { candidateLatestVersion, latestVersionRecord, type RecordingView } from "../lib/project-view";
import type { ActiveRun } from "../lib/run-state";
import { engineLabel } from "../lib/settings";
import { NEW_CONVERSATION, displayedEntry, type ChatController } from "../lib/use-chat";
import { DiffDialog, type DiffUndo } from "./DiffDialog";
import { FailureBand, type Failure } from "./FailureBand";
import { InfoCircleIcon } from "./icons";
import { PartialOutput } from "./PartialOutput";
import { usePopover } from "./usePopover";
import { useNow } from "./useNow";
import "../styles/chat.css";

/**
 * 右の「AIと作る」（spec §7・モック v8）: 会話 1 つ（工程の実行「▶ 〈工程名〉を実行」と修正の依頼が同じ会話に並ぶ）と入力欄。
 * ⋯ で 新しい会話・最近の会話。部品は NIHO の記事制作の会話と同じ（思考・作業・返答・結果）: 思考は実行中だけ 1 行、終わったら
 * 「N 秒考えました」。作業は日本語の 1 行（ファイル名は工程名・文書の名前に写す）。終わった依頼は「作業 N 件 · M 秒」に畳む。
 * composer（#18722）で直した・作った文書ページは、成果物の版と同じく結果のカードで出す（変更を見る・元に戻す・開く）。
 */

// ---------------------------------------------------------------------------
// 工程の実行（runs.jsonl の記録・実行中の工程）

/** 参考ページの名前（実行の記録の参考は記録の id、実行中は今の参考。消したページは数だけ）。 */
function refsDetail(view: RecordingView, pageIds: readonly string[]): string {
  const pages = projectPages(view.project);
  const names = pageIds.flatMap((pageId) => {
    const page = pages.find((candidate) => candidate.id === pageId && candidate.kind === "doc");
    return page ? [pageTitle(page)] : [];
  });
  return names.length > 0 ? names.join("・") : `${pageIds.length} ページ`;
}

/** 工程の入力の 1 行（`record` があれば実行の記録の参考、無ければ今の参考）。 */
function inputLabel(input: InputRef, view: RecordingView, record?: RunRecord): { text: string; detail?: string } | null {
  switch (input.kind) {
    case "source":
    case "artifact":
      return { text: `${input.name}（最新版）を読みました` };
    case "refs": {
      const pageIds = record ? (record.refs ?? []).map((ref) => ref.pageId) : view.materials.refs.map((ref) => ref.pageId);
      return pageIds.length > 0 ? { text: "参考ページを読みました", detail: refsDetail(view, pageIds) } : null;
    }
    case "info":
      return {
        text: "背景情報を読みました",
        detail: `固有名詞 ${mergeGlossaries(view.project.info.terms, view.flow.terms).length} 語`,
      };
    case "guide":
      return view.flow.guide.trim() ? { text: "文書ガイドを読みました" } : null;
  }
}

function InputOps(props: { view: RecordingView; stepId: string; record?: RunRecord }) {
  const index = props.view.flow.steps.findIndex((step) => step.id === props.stepId);
  if (index < 0) return null;
  const ops = inputsFor(props.view.flow, index, props.view.sourceName)
    .map((input) => inputLabel(input, props.view, props.record))
    .filter((op): op is { text: string; detail?: string } => op !== null);
  return (
    <>
      {ops.map((op) => (
        <div className="op" key={op.text}>
          {op.text}
          {op.detail && <b>{op.detail}</b>}
        </div>
      ))}
    </>
  );
}

/** API キー方式の見込み金額の添え書き（サブスクリプションは出さない。トークン数が返らなければ推測せず「取得できません」）。 */
function costNote(record: RunRecord): string | null {
  if (record.connection !== "apiKey" || record.provider === "this-mac") return null;
  const cost = estimateRunCostUsd(record);
  return `見込み ${cost === null ? "取得できません" : formatUsd(cost)}`;
}

function runNote(record: RunRecord): string {
  if (
    record.stepId === SOURCE_STEP_ID &&
    (record.provider === "this-mac" || record.provider === "gemini" || record.provider === "deepgram")
  ) {
    const engine = engineLabel(record.provider);
    const parts = [record.audioSec ? `${engine} · ${formatAudioLength(record.audioSec)}` : engine];
    const cost = costNote(record);
    if (cost) parts.push(cost);
    return parts.join(" · ");
  }
  const parts: string[] = [];
  if (record.model && record.provider && record.provider !== "this-mac" && record.provider !== "deepgram") {
    parts.push(shortModelLabel(record.provider, record.model));
  }
  if (record.effort) parts.push(effortLabel(record.effort));
  if (record.inputChars) parts.push(formatSendAmount(record.inputChars));
  if (record.continuations) parts.push(`続き ${record.continuations} 回`);
  const cost = costNote(record);
  if (cost) parts.push(cost);
  return parts.join(" · ");
}

function inputCount(view: RecordingView, record: RunRecord): number {
  const index = view.flow.steps.findIndex((step) => step.id === record.stepId);
  if (index < 0) return 0;
  return inputsFor(view.flow, index, view.sourceName)
    .map((input) => inputLabel(input, view, record))
    .filter((op) => op !== null).length;
}

function PastRun(props: {
  record: RunRecord;
  view: RecordingView;
  loadPartial: (runId: string) => Promise<string | null>;
  /** 途中までの出力の「コピー」「続きを頼む」（#18788）。 */
  onCopyPartial?: (text: string) => void;
  onContinuePartial?: (record: RunRecord, text: string) => void;
  continueBlocked?: string | null;
}) {
  const { record, view } = props;
  const isSource = record.stepId === SOURCE_STEP_ID;
  const opCount =
    (isSource ? 1 : inputCount(view, record)) + (record.continuations ? 1 : 0) + (record.result === "saved" ? 1 : 0);
  return (
    <>
      <div className="step-msg">
        ▶ {record.stepName}を実行<small>{runNote(record)}</small>
      </div>
      <div className="turn">
        <details className="worklog">
          <summary>
            作業 {opCount} 件{record.durationMs ? ` · ${formatDuration(record.durationMs)}` : ""}
          </summary>
          <div className="worklog-body">
            {isSource ? <div className="op">音声を読みました</div> : <InputOps view={view} stepId={record.stepId} record={record} />}
            {record.continuations ? <div className="op">続きを {record.continuations} 回頼みました</div> : null}
            {record.result === "saved" && <div className="op">{record.stepName}を保存しました</div>}
          </div>
        </details>
        {record.result === "saved" && record.version !== null && (
          <div className="result">
            <span className="grow">
              {record.stepName} 版 {record.version} を保存しました
              <small>
                {record.outputChars ? formatSendAmount(record.outputChars) : ""}
                {record.continuations ? ` · 続き ${record.continuations} 回` : ""}
              </small>
            </span>
          </div>
        )}
        {record.result === "failed" && <div className="op fail">{record.message ?? "実行できませんでした。"}</div>}
        {record.result === "stopped" && <div className="op stopped">{record.message ?? "止めました。"}</div>}
        {record.result !== "saved" && (record.partialChars ?? 0) > 0 && (
          <PartialOutput
            chars={record.partialChars ?? 0}
            load={() => props.loadPartial(record.id)}
            onCopy={props.onCopyPartial}
            onContinue={props.onContinuePartial ? (text) => props.onContinuePartial?.(record, text) : undefined}
            continueBlocked={props.continueBlocked}
          />
        )}
      </div>
    </>
  );
}

function LiveRun(props: { run: ActiveRun; view: RecordingView }) {
  const { run, view } = props;
  const isSource = run.stepId === SOURCE_STEP_ID;
  const speech = run.speech;
  return (
    <>
      <div className="step-msg">
        ▶ {run.stepName}を実行<small>{run.note}</small>
      </div>
      <div className="turn">
        {isSource ? (
          <>
            {speech && speech.stage !== "convert" && <div className="op">音声を変換しました</div>}
            {speech && speech.diarized && (speech.stage === "silence" || speech.stage === "transcribe") && (
              <div className="op">話者を分けました</div>
            )}
            {speech && speech.stage === "transcribe" && <div className="op">区切りを探しました</div>}
            <div className="op running">
              {!speech || speech.stage === "convert"
                ? `音声を変換しています${speech && speech.files > 1 ? `（${speech.file + 1} / ${speech.files}）` : ""}`
                : speech.stage === "diarize"
                  ? `話者を分けています${speech.files > 1 ? `（${speech.file + 1} / ${speech.files}）` : ""}`
                : speech.stage === "silence"
                  ? "区切りを探しています"
                  : `文字起こししています（${speech.part + 1} / ${speech.parts}${speech.files > 1 ? ` · 音声 ${speech.file + 1} / ${speech.files}` : ""}）`}
            </div>
          </>
        ) : (
          <>
            <InputOps view={view} stepId={run.stepId} />
            {run.continuation > 0 && <div className="op">続きを {run.continuation} 回頼みました</div>}
            <div className="op running">
              {run.text ? `${run.stepName}を書いています` : `${run.stepName}の構成を考えています`}
            </div>
            {run.thinking && (
              <div className="think live">
                <span className="spin" />
                <span className="txt">{run.thinking}</span>
              </div>
            )}
          </>
        )}
        {run.stopRequested && <div className="op stopped">止めています</div>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 修正の依頼（会話のファイルの turns・実行中の依頼）

function TurnItems(props: {
  items: readonly TurnItem[];
  view: RecordingView;
  live: boolean;
  /** composer の文書ページ・ほかの録音の文書のファイル名 → 画面の名前。 */
  names?: Readonly<Record<string, string>>;
}) {
  const { view } = props;
  return (
    <>
      {props.items.map((item, index) => {
        if (item.kind === "thinking") {
          return (
            <div className="think" key={index}>
              {Math.max(1, Math.round(item.ms / 1000))} 秒考えました
            </div>
          );
        }
        if (item.kind === "narration") {
          return (
            <div className="narr" key={index}>
              {item.text}
            </div>
          );
        }
        const running = props.live && item.ok === null;
        const name = documentNameForFile(item.file, view.flow, view.sourceName, props.names);
        return (
          <div className={`op${running ? " running" : item.ok === false ? " fail" : ""}`} key={index}>
            {toolLabel(item.tool, name, item.ok, running)}
          </div>
        );
      })}
    </>
  );
}

function RelayOps(props: { pack: string[] | null; record: number }) {
  const labels = props.pack?.map((name) => (name === "案件情報" ? "背景情報" : name)) ?? null;
  return (
    <>
      {props.record > 0 && <div className="op">前の会話の記録を引き継ぎました（{props.record}件）</div>}
      {labels && (
        <div className="op pack">
          資料を読みました（{labels.length}件）<b>{labels.join("・")}</b>
        </div>
      )}
    </>
  );
}

function VersionCard(props: {
  entry: TurnVersion;
  view: RecordingView;
  busy: boolean;
  onDiff: (entry: TurnVersion) => void;
  onUndo: (entry: TurnVersion) => void;
  undoReason: string | null;
}) {
  const { entry } = props;
  const [confirming, setConfirming] = useState(false);
  const latest = (entry.candidateId
    ? candidateLatestVersion(props.view, entry.stepId, entry.candidateId)
    : latestVersionRecord(props.view.runs, entry.stepId))?.version ?? entry.version;
  const later = latest > entry.version;
  const undone = entry.undoneAs !== undefined;
  const undo = () => {
    if (later && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    props.onUndo(entry);
  };
  return (
    <div className="result-wrap">
      <div className="result">
        <span className="grow">
          {undone
            ? `${entry.stepName} 版 ${entry.undoneAs} で元に戻しました`
            : `${entry.stepName} 版 ${entry.version} を保存しました`}
          <small>
            {undone
              ? `版 ${entry.previous ?? ""} の内容`
              : `${formatChars(entry.chars)}（${entry.delta >= 0 ? "+" : "−"}${formatChars(Math.abs(entry.delta))}）`}
          </small>
        </span>
        <button type="button" className="linkbtn" onClick={() => props.onDiff(entry)}>
          変更を見る
        </button>
        {!undone && entry.previous !== null && (
          <button type="button" className="linkbtn" disabled={props.busy || props.undoReason !== null} onClick={undo}>
            元に戻す
          </button>
        )}
      </div>
      {props.undoReason && !undone && entry.previous !== null && <p className="help candidate-undo-note">{props.undoReason}</p>}
      {confirming && (
        <div className="result-confirm" role="alert">
          <span>
            この後に版 {latest} が保存されています。版 {entry.previous} の内容を新しい版にしますか？
          </span>
          <button type="button" className="linkbtn" disabled={props.busy} onClick={undo}>
            戻す
          </button>
          <button type="button" className="linkbtn" onClick={() => setConfirming(false)}>
            やめる
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * composer（#18722）: 依頼で直した・作った文書ページ。直したページは「変更を見る」「元に戻す」（会話に控えた直す前の本文に
 * 戻す）、どれも「開く」で開ける（開いているページ・消したページには出さない）。
 */
function PageChangeCard(props: {
  change: TurnPageChange;
  busy: boolean;
  /** 開いているページ。 */
  current: boolean;
  /** ページがまだあるか。 */
  exists: boolean;
  undoReason: string | null;
  onDiff: (change: TurnPageChange) => void;
  onUndo: (change: TurnPageChange) => void;
  onOpen: (pageId: string) => void;
}) {
  const { change } = props;
  const edited = change.change === "edited";
  const diffable = edited && change.before !== undefined && change.after !== undefined;
  const undoable = diffable && !change.undone;
  return (
    <div className="result-wrap">
      <div className="result">
        <span className="grow">
          {change.undone ? `${change.title}を直す前の内容に戻しました` : edited ? `${change.title}を直しました` : `${change.title}を作りました`}
          {!change.undone && (
            <small>
              {edited
                ? `${formatChars(change.chars)}（${change.delta >= 0 ? "+" : "−"}${formatChars(Math.abs(change.delta))}）`
                : formatChars(change.chars)}
            </small>
          )}
        </span>
        {diffable && (
          <button type="button" className="linkbtn" onClick={() => props.onDiff(change)}>
            変更を見る
          </button>
        )}
        {undoable && (
          <button type="button" className="linkbtn" disabled={props.busy || props.undoReason !== null} onClick={() => props.onUndo(change)}>
            元に戻す
          </button>
        )}
        {props.exists && !props.current && (
          <button type="button" className="linkbtn" onClick={() => props.onOpen(change.pageId)}>
            開く
          </button>
        )}
      </div>
      {props.undoReason && undoable && <p className="help candidate-undo-note">{props.undoReason}</p>}
    </div>
  );
}

function ChatTurnView(props: {
  turn: ChatTurn;
  view: RecordingView;
  busy: boolean;
  undoReason: (entry: TurnVersion) => string | null;
  onDiff: (turn: ChatTurn, entry: TurnVersion) => void;
  onUndo: (turn: ChatTurn, entry: TurnVersion) => void;
  pageUndoReason: string | null;
  pageExists: (pageId: string) => boolean;
  onPageDiff: (turn: ChatTurn, change: TurnPageChange) => void;
  onPageUndo: (turn: ChatTurn, change: TurnPageChange) => void;
  onOpenPage: (pageId: string) => void;
}) {
  const { turn, view } = props;
  const count = workItemCount(turn.items);
  return (
    <>
      <div className="bubble me">{turn.input}</div>
      <div className="turn">
        <RelayOps pack={turn.pack} record={turn.record} />
        {count > 0 && (
          <details className="worklog">
            <summary>
              作業 {count} 件{turn.durationMs ? ` · ${formatDuration(turn.durationMs)}` : ""}
            </summary>
            <div className="worklog-body">
              <TurnItems items={turn.items} view={view} live={false} names={turn.names} />
            </div>
          </details>
        )}
        {turn.reply && <div className="bubble ai">{turn.reply}</div>}
        {turn.versions.map((entry) => (
          <VersionCard
            key={`${entry.stepId}-${entry.version}`}
            entry={entry}
            view={view}
            busy={props.busy}
            undoReason={props.undoReason(entry)}
            onDiff={(version) => props.onDiff(turn, version)}
            onUndo={(version) => props.onUndo(turn, version)}
          />
        ))}
        {(turn.pages ?? []).map((change) => (
          <PageChangeCard
            key={`${change.change}-${change.pageId}`}
            change={change}
            busy={props.busy}
            current={change.pageId === view.recordingId || change.pageId === view.page.id}
            exists={props.pageExists(change.pageId)}
            undoReason={props.pageUndoReason}
            onDiff={(entry) => props.onPageDiff(turn, entry)}
            onUndo={(entry) => props.onPageUndo(turn, entry)}
            onOpen={props.onOpenPage}
          />
        ))}
        {turn.notes.map((note) => (
          <div className="op note" key={note}>
            {note}
          </div>
        ))}
        {turn.result === "failed" && <div className="op fail">{turn.message ?? "送れませんでした。"}</div>}
        {turn.result === "stopped" && <div className="op stopped">{turn.message ?? "止めました。"}</div>}
        {turn.result === "running" && <div className="op stopped">中断しました。もう一度送ってください。</div>}
      </div>
    </>
  );
}

function LiveChatTurn(props: { live: LiveChat; view: RecordingView }) {
  const { live, view } = props;
  const now = useNow(true);
  const toolRunning = live.items.some((item) => item.kind === "tool" && item.ok === null);
  return (
    <>
      <div className="bubble me">{live.input}</div>
      <div className="turn">
        <RelayOps pack={live.pack} record={live.record} />
        <TurnItems items={live.items} view={view} live names={live.names} />
        {live.narration.trim() && <div className="narr">{live.narration.trim()}</div>}
        {live.thinking && (
          <div className="think live">
            <span className="spin" />
            <span className="txt">{live.thinking}</span>
          </div>
        )}
        {!toolRunning && !live.thinking && (
          <div className="op running" aria-live="polite">
            AI が作業しています · {formatElapsed(now - live.startedAt)}
          </div>
        )}
        {live.stopRequested && <div className="op stopped">止めています</div>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// ⋯（新しい会話・最近の会話）と入力欄

function entryTitle(entry: ConversationEntry): string {
  return entry.kind === "run" ? `▶ ${entry.record.stepName}を実行` : conversationTitle(entry.file);
}

function ChatMenu(props: {
  entries: ConversationEntry[];
  currentId: string | null;
  disabled: boolean;
  onPick: (id: string) => void;
  onNew: () => void;
}) {
  const popover = usePopover();
  const pick = (action: () => void) => () => {
    popover.setOpen(false);
    action();
  };
  return (
    <div ref={popover.ref} className="chatmenu-wrap">
      <button
        type="button"
        className="ib"
        title="会話"
        aria-label="会話の切り替え"
        aria-expanded={popover.open}
        aria-pressed={popover.open}
        onClick={popover.toggle}
      >
        ⋯
      </button>
      {popover.open && (
        <div className="pop chatmenu" role="menu">
          <button type="button" className="mi" role="menuitem" disabled={props.disabled} onClick={pick(props.onNew)}>
            新しい会話
          </button>
          <div className="pop-label">最近の会話</div>
          {props.entries.length === 0 && <div className="help pop-empty">会話はまだありません</div>}
          {props.entries.slice(0, 8).map((entry) => (
            <button
              type="button"
              key={entry.id}
              role="menuitem"
              className={`crow${entry.id === props.currentId ? " on" : ""}`}
              disabled={props.disabled}
              onClick={pick(() => props.onPick(entry.id))}
            >
              <span className="d">{entryTitle(entry)}</span>
              <span className="t">{formatDateTime(entry.at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 送信の ⏎（Web の入力欄と同じ記号。owner 2026-10-18・#18941）。 */
function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  );
}

/**
 * 見出しの横の ⓘ: 押すと説明の 1 文を吹き出しで出す（hover では出さない。外を押す・Esc で閉じる）。入力欄のプレースホルダーと
 * 空の会話の説明の文はやめて、ここへ寄せた（owner 2026-10-18・#18941。文は Web の docs-composer-panel と同じ）。
 */
function ChatInfo(props: { text: string }) {
  const popover = usePopover();
  const id = useId();
  return (
    <div ref={popover.ref} className="chat-info-wrap">
      <button
        type="button"
        className="chat-info"
        aria-label="AIと作る の説明"
        aria-expanded={popover.open}
        aria-controls={popover.open ? id : undefined}
        onClick={popover.toggle}
      >
        <InfoCircleIcon />
      </button>
      {popover.open && (
        <div id={id} className="pop chat-info-pop" role="note">
          {props.text}
        </div>
      )}
    </div>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  );
}

/** 入力欄から実行できる工程（工程 2 から。前の工程が済んでいない工程は押せない）。 */
export type ComposerStep = {
  stepId: string;
  name: string;
  canRun: boolean;
  /** この工程だけ実行できない理由（別案から選んでいない・準備の不足。#18789）。 */
  blockedReason?: string | null;
};

/**
 * 入力欄の ＋（モック v8 の「工程とスキル」。v1 はスキルが無いので工程だけ）: 工程を選ぶと、その工程を実行する（中央の
 * 工程の行・再実行と同じ。実行は同じ会話に「▶ 〈工程名〉を実行」として流れる）。
 */
function StepMenu(props: { steps: ComposerStep[]; disabled: boolean; onRun: (stepId: string) => void }) {
  const popover = usePopover();
  return (
    <div ref={popover.ref} className="stepmenu-wrap">
      <button
        type="button"
        className="plus"
        title={RUN_ACTION_LABELS.run}
        aria-label={RUN_ACTION_LABELS.run}
        aria-haspopup="menu"
        aria-expanded={popover.open}
        aria-pressed={popover.open}
        onClick={popover.toggle}
      >
        ＋
      </button>
      {popover.open && (
        <div className="pop stepmenu" role="menu">
          <div className="pop-label">{RUN_ACTION_LABELS.run}</div>
          {props.steps.length === 0 && <div className="help pop-empty">工程がありません</div>}
          {props.steps.map((step) => (
            <button
              type="button"
              key={step.stepId}
              role="menuitem"
              className="mi"
              disabled={props.disabled || !step.canRun || Boolean(step.blockedReason)}
              title={step.canRun ? (step.blockedReason ?? undefined) : "前の工程が済んでから実行できます"}
              onClick={() => {
                popover.setOpen(false);
                props.onRun(step.stepId);
              }}
            >
              ▶ {step.name}を実行
            </button>
          ))}
          {props.disabled && <div className="help pop-empty">実行中の作業が終わってから実行できます</div>}
        </div>
      )}
    </div>
  );
}

/** 入力欄（モック v8 の composer）: 1 行から書いた分だけ伸びる。Enter で送る（Shift＋Enter で改行・変換中は送らない）。 */
function Composer(props: {
  disabledReason: string | null;
  running: boolean;
  stopRequested: boolean;
  sending: boolean;
  steps: ComposerStep[];
  /** 文書ページの会話（工程の実行のメニューを出さない）。 */
  documentOnly?: boolean;
  /** 工程を実行できない（工程か会話の依頼が動いている）。 */
  runDisabled: boolean;
  /** 打ちかけ（録音ごとに useChat が持つ。録音のページと子ページを行き来しても残る）。 */
  text: string;
  onText: (text: string) => void;
  onRestore: (text: string) => void;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onRunStep: (stepId: string) => void;
  /** 送れなかった理由・会話を開けなかったこと（入力欄の下に残す帯。#18788）。 */
  failure?: (Failure & { onDismiss?: () => void }) | null;
  /** 変わったら入力欄にフォーカスする（「続きを頼む」で書いたとき）。 */
  focusToken?: number;
}) {
  const { text, onText: setText } = props;
  const area = useRef<HTMLTextAreaElement | null>(null);
  const focusToken = props.focusToken ?? 0;
  useEffect(() => {
    if (focusToken > 0) area.current?.focus();
  }, [focusToken]);
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    if (element.scrollHeight > 0) element.style.height = `${Math.min(element.scrollHeight, 168)}px`;
  }, [text]);
  const canSend = !props.disabledReason && !props.running && !props.sending && text.trim().length > 0;
  const submit = async () => {
    if (!canSend) return;
    const value = text;
    const restore = props.onRestore;
    setText("");
    const started = await props.onSend(value);
    if (!started) restore(value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void submit();
  };
  return (
    <div className="composer">
      <div className={`inputbox${props.disabledReason ? " off" : ""}`}>
        <textarea
          ref={area}
          rows={1}
          aria-label="直したいこと"
          value={text}
          disabled={Boolean(props.disabledReason)}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="inputrow">
          {!props.documentOnly && <StepMenu steps={props.steps} disabled={props.runDisabled} onRun={props.onRunStep} />}
          <span className="spacer" />
          {props.running ? (
            <button
              type="button"
              className="send stop"
              aria-label="停止"
              title="停止"
              disabled={props.stopRequested}
              onClick={props.onStop}
            >
              <StopIcon />
            </button>
          ) : (
            <button type="button" className="send" aria-label="送信" title="送信" disabled={!canSend} onClick={() => void submit()}>
              <SendIcon />
            </button>
          )}
        </div>
      </div>
      {props.failure && (
        <FailureBand className="composer-failure" message={props.failure.text} action={props.failure.action} onDismiss={props.failure.onDismiss} />
      )}
      {props.disabledReason && <p className="composer-note">{props.disabledReason}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** 「変更を見る」で開いているもの（成果物の版か、composer の文書ページ。「元に戻す」に依頼を添える）。 */
type DiffTarget = { kind: "version"; turn: ChatTurn; entry: TurnVersion } | { kind: "page"; turn: ChatTurn; change: TurnPageChange };

export function ChatPanel(props: {
  view: RecordingView;
  documentOnly?: boolean;
  /** この録音で実行中の工程（無ければ null）。 */
  activeRun: ActiveRun | null;
  /** 同じフォルダ（かフォルダの外）の別の録音を実行中（実行のロックはその単位なので送れない）。 */
  projectRunning?: boolean;
  chat: ChatController;
  loadPartial: (runId: string) => Promise<string | null>;
  /** 工程を実行できない（どこかで工程が動いている・この案件で会話の依頼が動いている）。 */
  runBlocked: boolean;
  /** 入力欄の「＋ → 工程を実行」で、その工程だけ実行できない理由（別案から選んでいない・準備の不足）。 */
  stepRunReason?: (stepId: string) => string | null;
  saving: boolean;
  onRunStep: (stepId: string) => void;
  /** 記事本文の案を開いているとき、会話・書込み・履歴をこの案に閉じる。 */
  target?: ChatTarget | null;
}) {
  const { view, chat, activeRun } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const target = props.target ?? null;
  const live = chat.live && chat.live.key === view.key && chat.live.candidateId === (target?.candidateId ?? null) ? chat.live : null;
  const liveElsewhere = chat.live !== null && chat.live !== live;
  const liveInProject = liveElsewhere && chat.live?.projectId === view.projectId;
  // 実行のロックはフォルダ・ホームの単位（画面の言葉は「同じフォルダ」「ホーム」。spec §7.1）
  const sameLocation = view.projectId === null ? "ホーム" : "同じフォルダ";
  const scopedRuns = view.runs.filter((run) =>
    target
      ? run.candidateId === target.candidateId || (run.candidateId === undefined && target.artifactId === target.stepId && run.stepId === target.stepId)
      : run.candidateId === undefined,
  );
  const entries = conversationEntries(chat.conversations, scopedRuns);
  const entry = displayedEntry(view, chat.conversations, chat.selection, target);
  const file: ConversationFile | null = entry?.kind === "file" ? entry.file : null;
  const staleConversation = file !== null && (file.locationGeneration ?? 0) !== (view.recording.moveGeneration ?? 0);
  const legacyCandidateConversation = Boolean(target && target.artifactId === target.stepId && file && file.candidateId === undefined);
  const runRecord =
    entry?.kind === "run"
      ? entry.record
      : file?.runId
        ? (view.runs.find((record) => record.id === file.runId && record.kind === "run") ?? null)
        : null;
  const liveHere = live !== null && (live.conversationId === (entry?.id ?? null) || (entry === null && !file));
  const turns = (file?.turns ?? []).filter((turn) => turn.id !== live?.turnId);
  const disabledReason = chat.unavailable
    ? chat.unavailable
    : props.saving
      ? "保存が終わってから送れます。"
      : activeRun
        ? "工程の実行が終わってから送れます。"
        : props.projectRunning
          ? `${sameLocation}の別の録音を実行しています。終わってから送れます。`
          : liveInProject
            ? `${sameLocation}の別の録音で AI が作業しています。終わってから送れます。`
            : liveElsewhere
              ? `${chat.live?.projectId === null ? "ホーム" : "ほかのフォルダ"}で AI が作業しています。終わってから送れます。`
              : chat.conversationsStatus === "loading"
                ? "会話を読み込んでいます…"
                : chat.conversationsStatus === "error"
                  ? "会話を開けてから送れます。"
                  : legacyCandidateConversation
                    ? "元の会話は閲覧と元に戻すだけです。案の編集は新しい会話から始めてください。"
                    : null;
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entry?.id, turns.length, live?.items.length, live?.narration.length, live?.thinking, activeRun?.text.length, activeRun?.thinking, activeRun?.speech?.part]);
  const onUndo = useCallback(
    (turn: ChatTurn, version: TurnVersion) => {
      if (file) void chat.undo(file.id, turn.id, version);
    },
    [chat, file],
  );
  const undoReason = useCallback((version: TurnVersion): string | null => {
    if (staleConversation) return "移動前の会話は閲覧だけです。";
    const artifactId = version.artifactId ?? version.stepId;
    const owner = Object.values(view.recording.candidateSets ?? {}).find((set) =>
      Object.values(set.items).some((candidate) => candidate.artifactId === artifactId || candidate.id === version.candidateId),
    );
    if (!owner) return null;
    if (!target || target.stepId !== owner.stepId || target.artifactId !== artifactId) return "元に戻すには、左から対象の案を開いてください。";
    return null;
  }, [staleConversation, target, view.recording.candidateSets]);
  const onPageUndo = useCallback(
    (turn: ChatTurn, change: TurnPageChange) => {
      if (file) void chat.undoPage(file.id, turn.id, change);
    },
    [chat, file],
  );
  const pageIds = new Set(projectPages(view.project).map((page) => page.id));
  const pageExists = (pageId: string) => pageIds.has(pageId);
  const pageUndoReason = staleConversation ? "移動前の会話は閲覧だけです。" : null;
  const { loadVersion } = chat;
  // 「変更を見る」: 成果物は版どうし、文書ページは会話に控えた直す前・直した後の本文
  const diffView = useMemo(() => {
    if (!diff) return null;
    if (diff.kind === "page") {
      const { change } = diff;
      return {
        name: change.title,
        caption: "直す前 → AI が直した後",
        load: async () => ({ before: change.before ?? "", after: change.after ?? "" }),
      };
    }
    const { entry } = diff;
    const id = entry.artifactId ?? entry.stepId;
    return {
      name: entry.stepName,
      caption: `${entry.previous === null ? "新しく作った文書" : `版 ${entry.previous}`} → 版 ${entry.version}`,
      load: async () => ({
        before: entry.previous === null ? "" : await loadVersion(id, entry.previous),
        after: await loadVersion(id, entry.version),
      }),
    };
  }, [diff, loadVersion]);
  // 「変更を見る」の「元に戻す」（#18788）: 会話のカードの「元に戻す」と同じ条件・同じ処理（押せない間は理由を 1 行）
  const cardBusy = live !== null || chat.sending || props.saving;
  const busyUndoReason = activeRun
    ? "工程の実行が終わってから元に戻せます。"
    : props.saving
      ? "保存が終わってから元に戻せます。"
      : cardBusy
        ? "「AIと作る」の依頼が終わってから元に戻せます。"
        : null;
  const diffUndo: DiffUndo | null = (() => {
    if (!diff || !file) return null;
    if (diff.kind === "page") {
      const { change } = diff;
      const undoable = change.change === "edited" && change.before !== undefined && change.after !== undefined && !change.undone;
      if (!undoable) return null;
      return { disabledReason: pageUndoReason ?? busyUndoReason, confirm: null, onUndo: () => onPageUndo(diff.turn, change) };
    }
    const { entry } = diff;
    if (entry.undoneAs !== undefined || entry.previous === null) return null;
    const latest = (entry.candidateId
      ? candidateLatestVersion(view, entry.stepId, entry.candidateId)
      : latestVersionRecord(view.runs, entry.stepId))?.version ?? entry.version;
    return {
      disabledReason: undoReason(entry) ?? busyUndoReason,
      confirm: latest > entry.version ? `この後に版 ${latest} が保存されています。版 ${entry.previous} の内容を新しい版にしますか？` : null,
      onUndo: () => onUndo(diff.turn, entry),
    };
  })();
  // 途中までの「続きを頼む」（#18788）: 途中までを添えた続きの依頼を入力欄に書く（送るのは人。打ちかけがあれば後ろに足す）
  const continueBlocked = disabledReason ?? (live !== null || chat.sending ? "AI の作業が終わってから頼めます。" : null);
  const continuePartial = (record: RunRecord, text: string) => {
    if (continueBlocked) return;
    const request = `${record.stepName}の途中までの出力です。この続きを書いて、${record.stepName}を仕上げてください。\n\n${text}`;
    chat.setDraft(chat.draft.trim() ? `${chat.draft}\n\n${request}` : request);
    setFocusToken((token) => token + 1);
  };
  const composerFailure =
    chat.conversationsStatus === "error"
      ? { text: "会話を開けませんでした。", action: { label: "もう一度開く", run: chat.reloadConversations } }
      : chat.failure
        ? { text: chat.failure, onDismiss: chat.dismissFailure }
        : null;
  // 見出しの ⓘ の説明（空の会話の本文には出さない。owner 2026-10-18・#18941）
  const infoText = props.documentOnly
    ? `直したいこと・作りたい文書を書くと、AI がこのページや${sameLocation}の文書を直したり、新しい文書を作ったりします。`
    : !target && Object.keys(view.recording.candidateSets ?? {}).length > 0
      ? `既存の案を直すときは左から案を開いてください。${sameLocation}の文書を直したり、新しい文書を作ったりもできます。`
      : `直したいことを書くと、AI が${target ? "この案の本文" : "この録音の文書"}を書き換えて版を足します。${sameLocation}の文書を直したり、新しい文書を作ったりもできます。`;
  const dayline = (() => {
    if (activeRun) return `新しい会話 · ${activeRun.stepName}`;
    if (runRecord) return `新しい会話 · ${runRecord.stepName}`;
    if (file) return `新しい会話 · ${formatDateTime(file.createdAt)}`;
    if (live) return "新しい会話";
    return null;
  })();
  return (
    <div className="rcard grow chatcard">
      <div className="ch">
        <h3>AIと作る{target ? ` · ${target.name}` : ""}</h3>
        <ChatInfo text={infoText} />
        <ChatMenu
          entries={entries}
          currentId={chat.selection === NEW_CONVERSATION ? null : (entry?.id ?? null)}
          disabled={live !== null || chat.sending || props.saving}
          onPick={(id) => chat.select(id)}
          onNew={chat.startNew}
        />
      </div>
      <div className="chat" ref={scrollRef}>
        {dayline && <div className="dayline">{dayline}</div>}
        {file?.notice && <p className="chat-move-notice">{file.notice}</p>}
        {staleConversation && <p className="chat-move-notice">移動前の会話は履歴の閲覧だけです。</p>}
        {activeRun ? (
          <LiveRun run={activeRun} view={view} />
        ) : (
          <>
            {runRecord && (
              <PastRun
                record={runRecord}
                view={view}
                loadPartial={props.loadPartial}
                onCopyPartial={chat.copy}
                onContinuePartial={continuePartial}
                continueBlocked={continueBlocked}
              />
            )}
            {turns.map((turn) => (
              <ChatTurnView
                key={turn.id}
                turn={turn}
                view={view}
                busy={live !== null || chat.sending || props.saving}
                undoReason={undoReason}
                onDiff={(turn, entry) => setDiff({ kind: "version", turn, entry })}
                onUndo={onUndo}
                pageUndoReason={pageUndoReason}
                pageExists={pageExists}
                onPageDiff={(turn, change) => setDiff({ kind: "page", turn, change })}
                onPageUndo={onPageUndo}
                onOpenPage={chat.openPage}
              />
            ))}
            {live && liveHere && <LiveChatTurn live={live} view={view} />}
          </>
        )}
      </div>
      <Composer
        documentOnly={props.documentOnly}
        disabledReason={disabledReason}
        running={live !== null}
        stopRequested={live?.stopRequested ?? false}
        sending={chat.sending}
        steps={view.plan.steps
          .filter((step) => step.stepId !== SOURCE_STEP_ID)
          .map((step) => ({
            stepId: step.stepId,
            name: step.name,
            canRun: canRunStep(view.plan, step.stepId),
            blockedReason: props.stepRunReason?.(step.stepId) ?? null,
          }))}
        runDisabled={props.runBlocked || live !== null}
        text={chat.draft}
        onText={chat.setDraft}
        onRestore={chat.restoreDraft}
        onSend={chat.send}
        onStop={chat.stop}
        onRunStep={props.onRunStep}
        failure={composerFailure}
        focusToken={focusToken}
      />
      {diffView && <DiffDialog name={diffView.name} caption={diffView.caption} load={diffView.load} undo={diffUndo} onClose={() => setDiff(null)} />}
    </div>
  );
}
