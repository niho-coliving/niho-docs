"use client";

import { AlertIcon, CloseIcon } from "./icons";

/** 失敗の帯の次の行動（「もう一度開く」「設定を開く」など。結果の動詞にする）。 */
export type FailureAction = { label: string; run: () => void; disabled?: boolean };

/** 帯に残す失敗（App のページの帯・入力欄の下）。 */
export type Failure = { text: string; action?: FailureAction };

/**
 * 失敗と理由を残す帯（#18788。design-guide §6「Error は状態と次の行動をセット」）。トーストは 2.2 秒で消えるので、失敗・断った理由は
 * この帯でページの上か入力欄の下に残す。消えるのは、次の成功の操作・ページの移動・「閉じる」のとき（置き場の側で消す）。
 * 色だけで伝えないように、印を添える。
 */
export function FailureBand(props: {
  message: string;
  action?: FailureAction | null;
  onDismiss?: () => void;
  className?: string;
}) {
  const { action } = props;
  return (
    <div className={`failure-band${props.className ? ` ${props.className}` : ""}`} role="alert">
      <span className="fb-icon">
        <AlertIcon />
      </span>
      <span className="fb-body">
        <span className="fb-msg">{props.message}</span>
        {action && (
          <button type="button" className="link fb-act" disabled={action.disabled} onClick={action.run}>
            {action.label}
          </button>
        )}
      </span>
      {props.onDismiss && (
        <button type="button" className="fb-close" aria-label="閉じる" title="閉じる" onClick={props.onDismiss}>
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
