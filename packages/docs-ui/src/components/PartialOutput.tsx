"use client";

import { useState, type SyntheticEvent } from "react";
import { formatChars } from "../lib/format";
import { renderMarkdown } from "../lib/markdown";

/**
 * 版にしなかった途中までの出力（停止・時間切れ・続きの上限・繋げられない続き）。会話の欄に「途中まで」として残す。
 * 開いたときに checkpoint から読む。読めたら「コピー」（成果物の「コピー」と同じ）と「続きを頼む」（途中までを添えた続きの
 * 依頼を入力欄に書く。送るのは人。#18788）を出す。続きを頼めない間（工程の実行中・依頼の最中など）は押せず、理由を 1 行出す。
 */
export function PartialOutput(props: {
  chars: number;
  load: () => Promise<string | null>;
  onCopy?: (text: string) => void;
  onContinue?: (text: string) => void;
  /** 続きを頼めない理由（入力欄が使えない理由と同じ）。 */
  continueBlocked?: string | null;
}) {
  const [text, setText] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open || html !== null) return;
    props.load().then(
      (loaded) => {
        if (loaded === null) {
          setFailed(true);
          return;
        }
        setText(loaded);
        setHtml(renderMarkdown(loaded));
      },
      () => setFailed(true),
    );
  };
  const blocked = props.continueBlocked ?? null;
  return (
    <details className="worklog partial" onToggle={onToggle}>
      <summary>途中まで（{formatChars(props.chars)}）</summary>
      <div className="worklog-body">
        {failed ? (
          <p className="err">途中までの出力を読めませんでした。</p>
        ) : html === null || text === null ? null : (
          <>
            <div className="doc partial-doc" dangerouslySetInnerHTML={{ __html: html }} />
            {(props.onCopy || props.onContinue) && (
              <div className="partial-acts">
                {props.onCopy && (
                  <button type="button" className="linkbtn" onClick={() => props.onCopy?.(text)}>
                    コピー
                  </button>
                )}
                {props.onContinue && (
                  <button type="button" className="linkbtn" disabled={blocked !== null} onClick={() => props.onContinue?.(text)}>
                    続きを頼む
                  </button>
                )}
              </div>
            )}
            {props.onContinue && blocked && <p className="help partial-note">{blocked}</p>}
          </>
        )}
      </div>
    </details>
  );
}
