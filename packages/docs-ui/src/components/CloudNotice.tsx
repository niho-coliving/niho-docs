"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage, type Bridge } from "../lib/bridge";
import { hasOpenConflicts, type CloudController } from "../lib/cloud";
import type { TombstoneChoice } from "../lib/cloud-types";
import { ConfirmDialog } from "./ConfirmDialog";
import "../styles/cloud.css";

/**
 * レールの下端の NIHO クラウドの知らせ（UpdateNotice と同じ小さなカード）。気にかけることがあるときだけ出す: NIHO に接続できない
 * （「設定を開く」。設定の「同期」で様子を見て「今すぐ同期」できる）・ログインが要る（「ログイン」。サーバーが NIHO アカウントの接続を
 * 閉じている間は、押しても使えないので出さず、同期していないことだけ伝える）・別のアカウントの保存先（「ログインし直す」。接続を
 * 閉じている間は「設定を開く」）・クラウドの容量が足りない（「使用量を見る」＝設定の使用量）・クラウドに上げている途中（3/10）、
 * 開いているフォルダの確かめが要る変更（「変更を確認」）と、別の Mac で削除されたフォルダ（「復元する」「手元も消す」）。
 * 知らせには次の行動を添える（#18788。design-guide §6）。
 */

type Item = { key: string; text: ReactNode; actions?: ReactNode };

export function CloudNotice(props: {
  bridge: Bridge;
  cloud: CloudController;
  /** 開いているフォルダ（変更の確認・削除されたフォルダの知らせ）。フォルダの外は予約の保存先の id と「フォルダの外のページ」。 */
  openProject: { id: string; name: string } | null;
  /** サーバーが NIHO アカウントの接続を受け付けている（false の間は「ログイン」を出さない）。 */
  canLogin: boolean;
  onLogin: () => void;
  /** 別のアカウントの保存先: ログアウトしてから、ログインし直す。 */
  onRelogin: () => void;
  /** 設定（保存先・同期・使用量）を開く。 */
  onOpenSettings: () => void;
  onReviewConflicts: (projectId: string) => void;
  /** 成功の確認（トースト）。 */
  onNotice: (message: string) => void;
  /** 失敗と理由（ページの帯に残す）。 */
  onFailure: (message: string) => void;
}) {
  const { bridge, cloud, openProject } = props;
  const [busy, setBusy] = useState(false);
  const [confirmAside, setConfirmAside] = useState(false);
  const state = cloud.state;
  const snapshot = openProject ? (cloud.snapshots[openProject.id] ?? null) : null;
  const cleanupPending = state?.storage?.mode === "LOCAL" ? state.storage.cleanupPending : null;
  const previousCleanupPending = useRef<boolean | null>(null);
  useEffect(() => {
    if (previousCleanupPending.current === true && cleanupPending === false) {
      props.onNotice("クラウドから削除しました");
    }
    previousCleanupPending.current = cleanupPending;
  }, [cleanupPending, props.onNotice]);

  const choose = async (choice: TombstoneChoice) => {
    if (!openProject || busy) return;
    setBusy(true);
    try {
      await bridge.cloudTombstoneChoice(openProject.id, choice);
      props.onNotice(choice === "restore" ? "復元しました" : "手元から消しました");
    } catch (error) {
      props.onFailure(errorMessage(error, "同期できませんでした。"));
    } finally {
      setBusy(false);
      setConfirmAside(false);
    }
  };

  const items: Item[] = [];
  if (state?.status === "closing") {
    items.push({ key: "closing", text: "クラウドを閉じる手続き中です。この Mac の未送信の変更を残して同期を止めています。" });
  } else if (state?.storage?.mode === "LOCAL" && state.storage.cleanupPending) {
    items.push({ key: "cleanup", text: "クラウドの削除を続けています。この Mac の内容は使えます。" });
  } else if (state?.status === "local" && state.message) {
    items.push({ key: "local-transition", text: state.message });
  } else if (state?.status === "storageUnavailable") {
    items.push({ key: "storage-unavailable", text: "保存先を確認できないため、クラウドへの送信を止めています。この Mac の変更は残ります。" });
  }
  if (state && cloud.niho) {
    if (state.status === "signedOut" || state.status === "expired") {
      items.push(
        props.canLogin
          ? {
              key: "login",
              text: "ログインが必要です",
              actions: (
                <button type="button" className="btn primary sm" onClick={props.onLogin}>
                  ログイン
                </button>
              ),
            }
          : { key: "login", text: "いまは NIHO にログインできないため、同期していません" },
      );
    } else if (state.status === "otherAccount") {
      items.push({
        key: "other",
        text: "別のアカウントの保存先です",
        actions: props.canLogin ? (
          <button type="button" className="btn outline sm" onClick={props.onRelogin}>
            ログインし直す
          </button>
        ) : (
          <button type="button" className="btn outline sm" onClick={props.onOpenSettings}>
            設定を開く
          </button>
        ),
      });
    } else if (state.status === "active" && state.message) {
      items.push({
        key: "offline",
        text: "NIHO に接続できません",
        actions: (
          <button type="button" className="btn outline sm" onClick={props.onOpenSettings}>
            設定を開く
          </button>
        ),
      });
    }
    if (Object.values(cloud.snapshots).some((item) => item.quotaPaths.length > 0)) {
      items.push({
        key: "quota",
        text: "クラウドの容量が足りません",
        actions: (
          <button type="button" className="btn outline sm" onClick={props.onOpenSettings}>
            使用量を見る
          </button>
        ),
      });
    }
    const migration = state.migration;
    if (migration?.running) {
      items.push({
        key: "migration",
        text: (
          <>
            <span className="spin" aria-hidden="true" />
            クラウドに上げています {migration.done}/{migration.total}
          </>
        ),
      });
    }
  }
  if (openProject && hasOpenConflicts(snapshot)) {
    items.push({
      key: "conflict",
      text: "変更の確認が必要です",
      actions: (
        <button type="button" className="btn outline sm" onClick={() => props.onReviewConflicts(openProject.id)}>
          変更を確認
        </button>
      ),
    });
  }
  const profileSnapshot = cloud.snapshots.profile ?? null;
  if (cloud.active && hasOpenConflicts(profileSnapshot)) {
    items.push({
      key: "profile-conflict",
      text: "アカウント設定の確認が必要です",
      actions: (
        <button type="button" className="btn outline sm" onClick={() => props.onReviewConflicts("profile")}>
          変更を確認
        </button>
      ),
    });
  }
  if (openProject && cloud.active && snapshot?.tombstone?.needsChoice) {
    items.push({
      key: "tombstone",
      text: `「${openProject.name}」は別の Mac で削除されました`,
      actions: (
        <>
          <button type="button" className="btn outline sm" disabled={busy} onClick={() => void choose("restore")}>
            復元する
          </button>
          <button type="button" className="btn stop sm" disabled={busy} onClick={() => setConfirmAside(true)}>
            手元も消す
          </button>
        </>
      ),
    });
  }
  if (items.length === 0 && !confirmAside) return null;

  return (
    <>
      {items.length > 0 && (
        <div className="cloud-notice" role="status" aria-label="クラウド">
          {items.map((item) => (
            <div className="cn-item" key={item.key}>
              <span className="cn-text">{item.text}</span>
              {item.actions && <span className="cn-acts">{item.actions}</span>}
            </div>
          ))}
        </div>
      )}
      {confirmAside && openProject && (
        <ConfirmDialog
          title="手元のフォルダも消しますか"
          confirmLabel="手元も消す"
          danger
          busy={busy}
          onConfirm={() => void choose("moveAside")}
          onCancel={() => setConfirmAside(false)}
        >
          <p className="msg">
            「{openProject.name}」は別の Mac で削除されました。この Mac のフォルダは保存先の中の別の場所へ移し、一覧から外します。
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
