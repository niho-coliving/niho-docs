"use client";

import { useEffect, useState } from "react";
import { collapseDiff, diffLines, diffSummary, type DiffRow } from "@niho/docs-core";
import { errorMessage } from "../lib/bridge";

/** 「変更を見る」の「元に戻す」（会話のカードの「元に戻す」と同じ処理。#18788）。 */
export type DiffUndo = {
  /** 押せない理由（カードと同じ理由と、依頼・保存の最中）。 */
  disabledReason: string | null;
  /** 戻す前に確かめる文（この後に版が保存されているとき。カードと同じ）。無ければすぐ戻す。 */
  confirm: string | null;
  onUndo: () => void;
};

/**
 * 「変更を見る」: 依頼の前と AI が書いた後の行の差分（変わった行と前後 2 行だけ。間は畳む）。成果物は版どうし、文書ページは
 * 会話に控えた直す前・直した後の本文（composer #18722）。会話のカードで元に戻せる変更は、ここからも「元に戻す」（押したら閉じ、
 * 結果は会話とトースト、断った理由は入力欄の下に出る）。
 */
export function DiffDialog(props: {
  /** 「〈名前〉の変更」。 */
  name: string;
  /** 見出しの横の説明（「版 2 → 版 3」「直す前 → AI が直した後」）。 */
  caption: string;
  /** 前と後の本文（変わらない関数を渡す。変わるたびに読み直す）。 */
  load: () => Promise<{ before: string; after: string }>;
  /** 元に戻せる変更のときだけ。 */
  undo?: DiffUndo | null;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<DiffRow[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [summary, setSummary] = useState<{ places: number; added: number; removed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { load, onClose, undo } = props;
  const runUndo = () => {
    if (!undo || undo.disabledReason) return;
    if (undo.confirm && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    undo.onUndo();
    onClose();
  };
  useEffect(() => {
    let cancelled = false;
    load().then(
      ({ before, after }) => {
        if (cancelled) return;
        const lines = diffLines(before, after);
        setRows(collapseDiff(lines));
        setSummary(diffSummary(lines));
      },
      (failure: unknown) => {
        if (!cancelled) setError(errorMessage(failure, "変更を読めませんでした。"));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [load]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="veil" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dlg diffdlg" role="dialog" aria-modal="true" aria-labelledby="diff-title">
        <h2 id="diff-title">
          {props.name}の変更
          <small>{props.caption}</small>
        </h2>
        {error ? (
          <p className="err">{error}</p>
        ) : rows === null ? (
          <p className="help">読み込んでいます</p>
        ) : (
          <>
            <p className="help">
              {summary && summary.places > 0
                ? `${summary.places} か所（足した行 ${summary.added} · 消した行 ${summary.removed}）`
                : "変わった行はありません"}
            </p>
            <div className="diff" role="list">
              {rows.map((row, index) =>
                row.kind === "skip" ? (
                  <div className="dl skip" role="listitem" key={index}>
                    … {row.count} 行は同じ
                  </div>
                ) : (
                  <div className={`dl ${row.kind}`} role="listitem" key={index}>
                    <span className="mk" aria-label={row.kind === "added" ? "足した行" : row.kind === "removed" ? "消した行" : "同じ行"}>
                      {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : ""}
                    </span>
                    <span className="tx">{row.text || " "}</span>
                  </div>
                ),
              )}
            </div>
          </>
        )}
        {undo && undo.disabledReason && <p className="help">{undo.disabledReason}</p>}
        {undo && confirming && !undo.disabledReason && (
          <div className="result-confirm" role="alert">
            <span>{undo.confirm}</span>
            <button type="button" className="linkbtn" onClick={runUndo}>
              戻す
            </button>
            <button type="button" className="linkbtn" onClick={() => setConfirming(false)}>
              やめる
            </button>
          </div>
        )}
        <div className="acts">
          {undo && (
            <button type="button" className="btn outline" disabled={undo.disabledReason !== null} onClick={runUndo}>
              元に戻す
            </button>
          )}
          <button type="button" className="btn primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
