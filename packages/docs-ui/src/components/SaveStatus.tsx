"use client";

import type { SaveStatus } from "../lib/cloud";
import "../styles/cloud.css";

/**
 * メタ行の保存の状態（「保存中」「このMacに保存済み」「クラウドに保存済み」など。spec niho-docs-cloud §7.2）。読み上げのために
 * 枠は常に置き、状態が無い間は空にする。注意（ログイン・オフライン・容量・競合）は注意の色、保存の失敗は赤字で、どれも文言を添える。
 */
export function SaveStatusText(props: { status: SaveStatus | null }) {
  const { status } = props;
  return (
    <span className={`savest${status && status.tone !== "muted" ? ` ${status.tone}` : ""}`} role="status">
      {status && (
        <>
          <span className="dotsep" aria-hidden="true">
            ·
          </span>
          {status.text}
        </>
      )}
    </span>
  );
}

/** 本文の上の知らせ（別の Mac で更新された →「最新を表示」・両方で変更された →「変更を確認」）。 */
export function CloudPageNotice(props: {
  text: string;
  action: string;
  disabled?: boolean;
  busy?: boolean;
  onAction: () => void;
}) {
  return (
    <div className="cloud-banner" role="status">
      <span>{props.text}</span>
      <button type="button" className="link" disabled={props.disabled || props.busy} aria-busy={props.busy || undefined} onClick={props.onAction}>
        {props.busy && <span className="spin" aria-hidden="true" />}
        {props.action}
      </button>
    </div>
  );
}
