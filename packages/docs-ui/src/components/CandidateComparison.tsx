"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { runMatchesCandidate, SOURCE_STEP_ID, type ArtifactCandidate, type AudioInput, type RunRecord } from "@niho/docs-core";
import type { Bridge, RecordingRef } from "../lib/bridge";
import type { ActiveRun } from "../lib/run-state";
import { formatDateTime } from "../lib/format";
import { renderMarkdown, renderTranscriptMarkdown } from "../lib/markdown";
import { AudioPlaybackBar, type AudioPlaybackHandle } from "./AudioPlaybackBar";

type TranscriptComparisonContext = {
  bridge: Bridge;
  recording: RecordingRef;
  audio: readonly AudioInput[];
  missingInputs: readonly string[];
  runs: readonly RunRecord[];
  activeRun: ActiveRun | null;
};

function transcriptDetails(
  candidate: ArtifactCandidate,
  markdown: string,
  context: TranscriptComparisonContext,
): { engine: string; createdAt: string; status: string } {
  const runs = context.runs
    .filter((run) => run.kind === "run" && runMatchesCandidate(run, SOURCE_STEP_ID, candidate))
    .sort((left, right) => right.at.localeCompare(left.at));
  const latest = runs[0];
  const active = context.activeRun;
  const isRunning = active !== null &&
    active.projectId === context.recording.projectId &&
    active.recordingId === context.recording.recordingId &&
    active.stepId === SOURCE_STEP_ID &&
    (active.candidateId === candidate.id || (!active.candidateId && candidate.artifactId === SOURCE_STEP_ID));
  const engine = candidate.engine ?? latest?.provider;
  const engineLabel = engine === "gemini"
    ? candidate.engineConnection === "apiKey" ? "Gemini（API キー）" : "Gemini"
    : engine === "this-mac" ? "この Mac"
      : engine === "deepgram" ? "Deepgram" : "記録なし";
  const status = isRunning ? "処理中"
    : latest?.result === "failed" ? "失敗"
      : latest?.result === "stopped" ? "停止"
        : markdown.trim() || latest?.result === "saved" ? "完了" : "未作成";
  return { engine: engineLabel, createdAt: formatDateTime(candidate.createdAt), status };
}

/**
 * 別案の比較（読み取り専用の 2 案の並び）。採用・勝者・代表案は持たない（spec §5）ので、比べた案は「この案を開く」で選択案として
 * 開く（レールの案の行と同じ。開いた案に、案名・本文の編集・再実行・書き出し・版・AI 会話が閉じる。#18788）。
 */
export function CandidateComparison(props: {
  candidates: readonly ArtifactCandidate[];
  artifacts: Readonly<Record<string, string>>;
  drafts: Readonly<Record<string, string>>;
  currentId: string;
  /** 別案のある工程の名前（見出し。工程設計で付けた名前）。 */
  stepName: string;
  /** 文字起こしの別案を比べる場合だけ渡す。音声・時刻からの頭出しと実行情報を表示する。 */
  transcript?: TranscriptComparisonContext;
  /** その案を選択案として開く（比較は閉じる）。 */
  onOpen?: (candidateId: string) => void;
  onClose: () => void;
}) {
  const heading = props.stepName.trim() || "別案";
  const first = props.candidates.find((candidate) => candidate.id === props.currentId) ?? props.candidates[0];
  const second = props.candidates.find((candidate) => candidate.id !== first?.id) ?? props.candidates[1];
  const [leftId, setLeftId] = useState(first?.id ?? "");
  const [rightId, setRightId] = useState(second?.id ?? "");
  const [mobileSide, setMobileSide] = useState<"left" | "right">("left");
  const closeRef = useRef<HTMLButtonElement>(null);
  const playbackRef = useRef<AudioPlaybackHandle>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  const left = props.candidates.find((candidate) => candidate.id === leftId) ?? first;
  const right = props.candidates.find((candidate) => candidate.id === rightId) ?? second;
  const leftMarkdown = left ? props.drafts[left.artifactId] ?? props.artifacts[left.artifactId] ?? "" : "";
  const rightMarkdown = right ? props.drafts[right.artifactId] ?? props.artifacts[right.artifactId] ?? "" : "";
  const seekableTranscript = Boolean(props.transcript && props.transcript.audio.length > 0);
  const leftHtml = useMemo(
    () => seekableTranscript ? renderTranscriptMarkdown(leftMarkdown, true) : renderMarkdown(leftMarkdown),
    [leftMarkdown, seekableTranscript],
  );
  const rightHtml = useMemo(
    () => seekableTranscript ? renderTranscriptMarkdown(rightMarkdown, true) : renderMarkdown(rightMarkdown),
    [rightMarkdown, seekableTranscript],
  );
  const seekFromTimestamp = (target: EventTarget | null): boolean => {
    if (!seekableTranscript || !(target instanceof Element)) return false;
    const timestamp = target.closest<HTMLElement>("[data-transcript-seek-seconds]");
    if (!timestamp) return false;
    const second = Number(timestamp.dataset.transcriptSeekSeconds);
    if (!Number.isFinite(second) || second < 0) return false;
    playbackRef.current?.seek(second);
    return true;
  };
  const detailsFor = (candidate: ArtifactCandidate | undefined, markdown: string) =>
    candidate && props.transcript ? transcriptDetails(candidate, markdown, props.transcript) : null;
  return (
    <div className="veil" role="presentation">
      <div className="dlg candidate-compare" role="dialog" aria-modal="true" aria-label={`${heading}の比較`}>
        <div className="compare-head"><h2>{`${heading}を比較`}</h2><button ref={closeRef} type="button" className="btn outline sm" onClick={props.onClose}>閉じる</button></div>
        {props.transcript && props.transcript.audio.length > 0 && (
          <div className="compare-audio">
            <p className="help">タイムスタンプを押すと、同じ音声のその位置から再生します。</p>
            <AudioPlaybackBar
              ref={playbackRef}
              bridge={props.transcript.bridge}
              recording={props.transcript.recording}
              audio={props.transcript.audio}
              missingInputs={props.transcript.missingInputs}
            />
          </div>
        )}
        <div className="compare-mobile-side" role="group" aria-label="表示する別案">
          <button type="button" className="btn outline sm" aria-pressed={mobileSide === "left"} onClick={() => setMobileSide("left")}>左の別案</button>
          <button type="button" className="btn outline sm" aria-pressed={mobileSide === "right"} onClick={() => setMobileSide("right")}>右の別案</button>
        </div>
        <div className="compare-grid" data-mobile-side={mobileSide}>
          {[{ side: "left", value: leftId, set: setLeftId, candidate: left, html: leftHtml, markdown: leftMarkdown }, { side: "right", value: rightId, set: setRightId, candidate: right, html: rightHtml, markdown: rightMarkdown }].map((column) => {
            const details = detailsFor(column.candidate, column.markdown);
            return (
            <section key={column.side} data-side={column.side}>
              <div className="compare-col-head">
                <select aria-label={column.side === "left" ? "左の別案" : "右の別案"} value={column.value} onChange={(event) => column.set(event.target.value)}>
                  {props.candidates.map((candidate) => <option key={candidate.id} value={candidate.id} disabled={(column.side === "left" ? rightId : leftId) === candidate.id}>{candidate.name}</option>)}
                </select>
                {details && (
                  <div className="compare-candidate-details">
                    <span>{details.engine}</span>
                    {details.createdAt && <span>作成 {details.createdAt}</span>}
                    <span>{details.status}</span>
                  </div>
                )}
                {props.onOpen && column.candidate && (column.candidate.id === props.currentId
                  ? <span className="help">開いている別案</span>
                  : <button type="button" className="btn outline sm" onClick={() => column.candidate && props.onOpen?.(column.candidate.id)}>この別案を開く</button>)}
              </div>
              <div
                className={`compare-document doc${seekableTranscript ? " timestamps-on" : ""}`}
                aria-label={`${column.candidate?.name ?? "別案"}の本文`}
                onMouseDown={(event) => {
                  if (seekableTranscript && event.target instanceof Element && event.target.closest("[data-transcript-seek-seconds]")) event.preventDefault();
                }}
                onClick={(event) => seekFromTimestamp(event.target)}
                onKeyDown={(event) => {
                  if ((event.key === "Enter" || event.key === " ") && seekFromTimestamp(event.target)) event.preventDefault();
                }}
                dangerouslySetInnerHTML={{ __html: column.html }}
              />
            </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
