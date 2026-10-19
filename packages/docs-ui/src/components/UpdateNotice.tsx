"use client";

import { useEffect, useState } from "react";
import type { Bridge } from "../lib/bridge";
import { ConfirmDialog } from "./ConfirmDialog";
import "../styles/update-notice.css";

/**
 * 再起動を頼んでからこの時間たってもアプリが閉じなければ、閉じて開き直す案内へ切り替える
 * （NIHO Desktop の `DESKTOP_UPDATE_RESTART_STALL_MS` と同じ考え。終わるときに `.app` を差し替える分だけ長めにとる）。
 */
export const UPDATE_RESTART_STALL_MS = 30_000;

/**
 * 自動更新の案内（S4 #18385。NIHO Desktop の「更新して再起動」#16415 と同じ作法）。
 * 裏の確認（起動時と 1 時間ごと）が新しい版を取得したら、レールの下端（起動の失敗の画面では、その画面）に
 * 「新しい版があります」と「更新して再起動」を出す。押すと最新公開版を確認・取得して開き直す。
 * 工程・会話・文字起こし・録音が動いている間は、止めてよいか確かめてから開き直す。
 * 別の NIHO docs が工程を実行している間は開き直さない。閉じれば次に開いたときに切り替わる。
 * 自動更新を使っていない（updater の公開鍵が未設定・開発ビルド）ときは何も出さない。
 */
export function UpdateNotice(props: { bridge: Pick<Bridge, "watchUpdate" | "restartToUpdate" | "capabilities"> }) {
  const { bridge } = props;
  const [staged, setStaged] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [waitingClose, setWaitingClose] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [otherApp, setOtherApp] = useState(false);

  useEffect(() => {
    if (bridge.capabilities?.updates === false) return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    bridge
      .watchUpdate?.((status) => {
        // 差し替えた版だけを拾う（今の状態の読み出しが event より後に届いても、差し替え前へ戻さない）
        if (status.enabled && status.stagedVersion) setStaged(status.stagedVersion);
      })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      // 案内が出ないだけ（更新そのものは Rust 側で済んでいる）
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [bridge]);

  // 再起動を頼んだのにアプリが閉じないときは、閉じて開き直す案内へ切り替える（取得は済んでいる）
  useEffect(() => {
    if (!waitingClose) return;
    const timer = window.setTimeout(() => {
      setWaitingClose(false);
      setRestarting(false);
      setConfirming(false);
      setFailed(true);
    }, UPDATE_RESTART_STALL_MS);
    return () => window.clearTimeout(timer);
  }, [waitingClose]);

  const restart = async (force: boolean) => {
    setRestarting(true);
    setFailed(false);
    setRefreshFailed(false);
    setOtherApp(false);
    try {
      const outcome = await bridge.restartToUpdate?.(force);
      // restarting なら窓が閉じるので、押せないまま待つ（閉じなければ上の時間で案内を切り替える）
      if (outcome === "restarting") {
        setWaitingClose(true);
        return;
      }
      setRestarting(false);
      if (outcome === "refreshFailed") {
        setConfirming(false);
        setRefreshFailed(true);
      }
      if (outcome === "busy") setConfirming(true);
      if (outcome === "otherAppRunning") {
        setConfirming(false);
        setOtherApp(true);
      }
    } catch {
      setRestarting(false);
      setConfirming(false);
      setFailed(true);
    }
  };

  if (!staged || dismissed === staged) return null;
  return (
    <>
      <div className="update-notice" role="status">
        <div className="un-head">
          {failed ? (
            <span>再起動できませんでした。閉じて開き直すと {staged} になります。</span>
          ) : refreshFailed ? (
            <span>最新版を取得できませんでした。接続を確認して、もう一度お試しください。</span>
          ) : otherApp ? (
            <span>別の NIHO docs で工程が動いています。終わってから、もう一度押してください。</span>
          ) : restarting && !waitingClose ? (
            <span>最新版を確認・取得しています…</span>
          ) : (
            <span>
              新しい版 <b>{staged}</b> があります
            </span>
          )}
          <button type="button" className="ibtn sm" aria-label="閉じる" onClick={() => setDismissed(staged)}>
            ×
          </button>
        </div>
        {!failed && (
          <button type="button" className="btn primary sm" disabled={restarting} onClick={() => void restart(false)}>
            更新して再起動
          </button>
        )}
      </div>
      {confirming && (
        <ConfirmDialog
          title="動いている処理を止めて再起動しますか？"
          confirmLabel="止めて再起動"
          cancelLabel="あとで"
          danger
          busy={restarting}
          onConfirm={() => void restart(true)}
          onCancel={() => setConfirming(false)}
        >
          <p className="msg">
            工程の実行・AI との会話・文字起こし・録音のどれかが動いています。再起動するとそこで止まります（録音はそこまでを保存し、次に開いたときに「前回の録音」から録音のページへ保存できます）。終わってから更新するときは「あとで」を押してください。
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
