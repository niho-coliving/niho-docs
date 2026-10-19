"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactCandidate } from "@niho/docs-core";
import { renderMarkdown } from "../lib/markdown";

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
  /** その案を選択案として開く（比較は閉じる）。 */
  onOpen?: (candidateId: string) => void;
  onClose: () => void;
}) {
  const heading = props.stepName.trim() || "別案";
  const first = props.candidates.find((candidate) => candidate.id === props.currentId) ?? props.candidates[0];
  const second = props.candidates.find((candidate) => candidate.id !== first?.id) ?? props.candidates[1];
  const [leftId, setLeftId] = useState(first?.id ?? "");
  const [rightId, setRightId] = useState(second?.id ?? "");
  const closeRef = useRef<HTMLButtonElement>(null);
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
  const leftHtml = useMemo(
    () => renderMarkdown(left ? props.drafts[left.artifactId] ?? props.artifacts[left.artifactId] ?? "" : ""),
    [left, props.artifacts, props.drafts],
  );
  const rightHtml = useMemo(
    () => renderMarkdown(right ? props.drafts[right.artifactId] ?? props.artifacts[right.artifactId] ?? "" : ""),
    [right, props.artifacts, props.drafts],
  );
  return (
    <div className="veil" role="presentation">
      <div className="dlg candidate-compare" role="dialog" aria-modal="true" aria-label={`${heading}の比較`}>
        <div className="compare-head"><h2>{`${heading}を比較`}</h2><button ref={closeRef} type="button" className="btn outline sm" onClick={props.onClose}>閉じる</button></div>
        <div className="compare-grid">
          {[{ side: "left", value: leftId, set: setLeftId, candidate: left, html: leftHtml }, { side: "right", value: rightId, set: setRightId, candidate: right, html: rightHtml }].map((column) => (
            <section key={column.side}>
              <div className="compare-col-head">
                <select aria-label={column.side === "left" ? "左の別案" : "右の別案"} value={column.value} onChange={(event) => column.set(event.target.value)}>
                  {props.candidates.map((candidate) => <option key={candidate.id} value={candidate.id} disabled={(column.side === "left" ? rightId : leftId) === candidate.id}>{candidate.name}</option>)}
                </select>
                {props.onOpen && column.candidate && (column.candidate.id === props.currentId
                  ? <span className="help">開いている別案</span>
                  : <button type="button" className="btn outline sm" onClick={() => column.candidate && props.onOpen?.(column.candidate.id)}>この別案を開く</button>)}
              </div>
              <div className="compare-document doc" aria-label={`${column.candidate?.name ?? "別案"}の本文`} dangerouslySetInnerHTML={{ __html: column.html }} />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
