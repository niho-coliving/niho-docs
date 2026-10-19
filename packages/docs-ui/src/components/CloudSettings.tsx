"use client";

import { useEffect, useId, useRef, useState } from "react";
import { folderName } from "@niho/docs-core";
import { isCommandError, type Bridge, type CommandError } from "../lib/bridge";
import { formatBytes, type CloudController } from "../lib/cloud";
import type { ClosingPreview, ClosingProgress, PreparedClosing, CloudMigration, CloudState, DeletedProject, ReopeningPreview, VaultUsage } from "../lib/cloud-types";
import { formatDateTime } from "../lib/format";
import { ConfirmDialog } from "./ConfirmDialog";
import "../styles/cloud.css";

/**
 * 設定の「保存先」のクラウドの段（C3 #18595。spec niho-docs-cloud §15）。保存先は NIHO クラウドだけ（owner 決定 2026-10-17・
 * #18728）なので切り替えは出さず、保存先の説明・同期の様子・この Mac の名前・使用量・この Mac のページとフォルダをクラウドに上げる
 * 進み（中断・再開・上げられなかったもの）・削除したフォルダ（元に戻す）を出す。開発・試験の起動だけは「この Mac だけ」と出す。
 * 内部の id は出さない。画面の言葉は「フォルダ」（spec niho-docs §7.1）。
 */

function syncLine(state: CloudState): { dot: "" | "off" | "none"; text: string } {
  switch (state.status) {
    case "active":
      return state.message ? { dot: "off", text: "NIHO に接続できません" } : { dot: "", text: "同期しています" };
    case "signedOut":
    case "expired":
      return { dot: "off", text: "ログインが必要です" };
    case "otherAccount":
      return { dot: "off", text: "別のアカウントの保存先です" };
    default:
      return { dot: "none", text: "準備しています" };
  }
}

function migrationText(migration: CloudMigration): string {
  const count = `（${migration.done} / ${migration.total}）`;
  if (migration.running) return `この Mac のページとフォルダをクラウドに上げています${count}`;
  if (migration.cancelled) return `クラウドへの保存を中断しました${count}`;
  if (migration.failed.length > 0) return `クラウドに上げられなかったページかフォルダがあります${count}`;
  return `この Mac のページとフォルダをクラウドに上げる途中です${count}`;
}

function asError(error: unknown, fallback: string): CommandError {
  return isCommandError(error) ? error : { code: "", message: fallback };
}

export function CloudSettings(props: {
  bridge: Bridge;
  cloud: CloudController;
  /** 工程・会話・文字起こしの実行中（保存先の結び直しはしない）。 */
  running: boolean;
  /** 上げられなかったフォルダの名前（移行の記録に名前が無いとき）。 */
  projectName: (projectId: string) => string | null;
  /** 削除したフォルダを元に戻した（フォルダの一覧を読み直す）。 */
  onProjectsChanged: () => void;
  onNotice: (message: string) => void;
}) {
  const { bridge, cloud } = props;
  const state = cloud.state;
  const niho = cloud.niho;
  const nameId = useId();
  const [confirmRebind, setConfirmRebind] = useState(false);
  const [reopeningPreview, setReopeningPreview] = useState<ReopeningPreview | null>(null);
  const [reopeningBusy, setReopeningBusy] = useState(false);
  const [closingPreview, setClosingPreview] = useState<ClosingPreview | null>(null);
  const [preparedClosing, setPreparedClosing] = useState<PreparedClosing | null>(null);
  const [closingBusy, setClosingBusy] = useState(false);
  const [closingProgress, setClosingProgress] = useState<ClosingProgress | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CommandError | null>(null);
  const [name, setName] = useState(state?.deviceName ?? "");
  const editingName = useRef(false);
  const [usage, setUsage] = useState<VaultUsage | null | undefined>(undefined);
  const [deleted, setDeleted] = useState<DeletedProject[] | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const migrationDone = state?.migration?.done ?? null;

  useEffect(() => {
    if (!editingName.current) setName(state?.deviceName ?? "");
  }, [state?.deviceName]);

  useEffect(() => {
    let closed = false;
    let unlisten: (() => void) | undefined;
    void bridge.onCloudClosingProgress((progress) => { if (!closed) setClosingProgress(progress); }).then((stop) => {
      if (closed) stop(); else unlisten = stop;
    });
    return () => { closed = true; unlisten?.(); };
  }, [bridge]);

  // 使用量（移行が進むたびに読み直す）
  useEffect(() => {
    if (!cloud.active) {
      setUsage(undefined);
      return;
    }
    let cancelled = false;
    bridge.cloudUsage().then(
      (value) => {
        if (!cancelled) setUsage(value);
      },
      () => {
        if (!cancelled) setUsage(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, cloud.active, migrationDone]);

  useEffect(() => {
    if (!cloud.active) {
      setDeleted(null);
      return;
    }
    let cancelled = false;
    bridge.cloudDeletedProjects().then(
      (list) => {
        if (!cancelled) setDeleted(list);
      },
      () => {
        if (!cancelled) setDeleted([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, cloud.active]);

  /** 別のアカウントの保存先を、今ログインしているアカウントで使う（そのままクラウドに上げ始める）。 */
  const rebind = async () => {
    setBusy(true);
    setError(null);
    try {
      cloud.putState(await bridge.cloudSetProvider("niho", true));
      try {
        cloud.putState(await bridge.cloudMigrationStart());
      } catch (failure) {
        setError(asError(failure, "クラウドに上げられませんでした。"));
      }
    } catch (failure) {
      setError(asError(failure, "このアカウントで使えませんでした。"));
    } finally {
      setBusy(false);
      setConfirmRebind(false);
    }
  };

  const saveName = async () => {
    editingName.current = false;
    const next = name.trim();
    if (!state || next === state.deviceName) return;
    try {
      cloud.putState(await bridge.cloudSetDeviceName(next));
    } catch (failure) {
      setName(state.deviceName);
      setError(asError(failure, "名前を保存できませんでした。"));
    }
  };

  const migrate = async (start: boolean) => {
    setMigrationBusy(true);
    setError(null);
    try {
      cloud.putState(await (start ? bridge.cloudMigrationStart() : bridge.cloudMigrationCancel()));
    } catch (failure) {
      setError(asError(failure, start ? "クラウドに上げられませんでした。" : "中断できませんでした。"));
    } finally {
      setMigrationBusy(false);
    }
  };

  const restore = async (project: DeletedProject) => {
    setRestoring(project.projectId);
    setError(null);
    try {
      await bridge.cloudRestoreProject(project.projectId);
      setDeleted((list) => (list ?? []).filter((item) => item.projectId !== project.projectId));
      props.onProjectsChanged();
      props.onNotice("元に戻しました");
    } catch (failure) {
      setError(asError(failure, "元に戻せませんでした。"));
    } finally {
      setRestoring(null);
    }
  };

  const syncNow = () => {
    void bridge.cloudSyncNow(null).catch((failure: unknown) => setError(asError(failure, "同期できませんでした。")));
  };

  const previewReopening = async () => {
    setPreviewBusy(true);
    setError(null);
    try {
      setReopeningPreview(await bridge.cloudStorageReopeningPreview());
    } catch (failure) {
      setError(asError(failure, "この Mac の内容を確認できませんでした。"));
    } finally {
      setPreviewBusy(false);
    }
  };

  const reopen = async () => {
    setReopeningBusy(true);
    setError(null);
    try {
      cloud.putState(await bridge.cloudStorageReopen());
      setReopeningPreview(null);
      props.onNotice("NIHO クラウドで開けるようになりました");
    } catch (failure) {
      setError(asError(failure, "クラウドへ移せませんでした。もう一度お試しください。"));
      setReopeningPreview(null);
    } finally {
      setReopeningBusy(false);
    }
  };

  const previewClosing = async () => {
    setPreviewBusy(true);
    setError(null);
    try {
      setClosingPreview(await bridge.cloudStorageClosingPreview());
    } catch (failure) {
      setError(asError(failure, "クラウドの内容を確認できませんでした。"));
    } finally {
      setPreviewBusy(false);
    }
  };

  const prepareClosing = async () => {
    setClosingBusy(true);
    setClosingProgress(null);
    setError(null);
    setClosingPreview(null);
    try {
      setPreparedClosing(await bridge.cloudStorageClosingPrepare());
    } catch (failure) {
      setError(asError(failure, "受信を完了できませんでした。途中から再開できます。"));
    } finally {
      setClosingBusy(false);
    }
  };

  const cancelClosing = async () => {
    try { await bridge.cloudStorageClosingCancel(); }
    catch (failure) { setError(asError(failure, "受信を中断できませんでした。")); }
  };

  const confirmClosing = async () => {
    if (!preparedClosing) return;
    setClosingBusy(true);
    setError(null);
    try {
      cloud.putState(await bridge.cloudStorageClosingConfirm(preparedClosing));
      setPreparedClosing(null);
      props.onProjectsChanged();
      props.onNotice("この Mac だけに保存するようになりました");
    } catch (failure) {
      setError(asError(failure, "切り替えを確かめられませんでした。受信済みデータは残っています。"));
    } finally {
      setClosingBusy(false);
    }
  };

  const line = state && niho ? syncLine(state) : null;
  const migration = niho ? (state?.migration ?? null) : null;
  const total = usage ? usage.usedBytes + usage.reservedBytes : 0;
  const over = usage ? usage.quotaBytes > 0 && total >= usage.quotaBytes : false;
  const quotaPaths = Object.values(cloud.snapshots).some((snapshot) => snapshot.quotaPaths.length > 0);
  const percent = usage && usage.quotaBytes > 0 ? Math.min(100, Math.round((total / usage.quotaBytes) * 100)) : 0;

  return (
    <>
      <div className="prow">
        <b>保存先</b>
        <span className="stc">
          <span className="st">{state?.storage?.mode === "CLOSING" ? "NIHO クラウドから移行中" : niho ? "NIHO クラウド" : state?.storage?.mode === "LOCAL" ? "この Mac だけ" : "この Mac だけ（開発版）"}</span>
          <span className="help">
            {state?.storage?.mode === "CLOSING"
              ? "この Mac へ受信するまで同期を止めています。受信を再開できます。"
              : niho
              ? "ページとフォルダはこの Mac と NIHO クラウドの両方に保存され、別の Mac やスマホからも開けます。録音の音声もクラウドに保存されます（クラウドでは 30 日で消え、この Mac には残ります）。"
              : state?.storage?.mode === "LOCAL"
                ? "ページと音声はこの Mac に保存します。Web やほかの Mac とは同期しません。"
                : "開発版では NIHO クラウドに保存しません。NIHO_DOCS_CLOUD=1 を付けて起動したときだけ同期します。"}
          </span>
          {error && (
            <span className="err" role="alert">
              {error.message}
            </span>
          )}
        </span>
        <span className="acts">
          {state?.storage?.mode === "LOCAL" && state.requiresAccount && (
            <button type="button" className="btn outline sm" disabled={previewBusy || reopeningBusy || props.running}
              onClick={() => void previewReopening()}>
              {previewBusy ? "内容を確認中…" : "変更"}
            </button>
          )}
          {state?.storage?.mode === "CLOUD" && state.requiresAccount && bridge.capabilities?.cloudClosing === true && (
            <button type="button" className="btn outline sm" disabled={previewBusy || closingBusy || props.running}
              onClick={() => void previewClosing()}>
              {previewBusy ? "内容を確認中…" : "変更"}
            </button>
          )}
          {state?.storage?.mode === "CLOSING" && state.requiresAccount && (
            <button type="button" className="btn outline sm" disabled={closingBusy || props.running}
              onClick={() => void prepareClosing()}>
              {closingBusy ? "受信・照合中…" : "受信を再開"}
            </button>
          )}
        </span>
      </div>

      {niho && state && line && (
        <div className="prow">
          <b>同期</b>
          <span className="stc">
            <span className="st">
              <i className={line.dot} />
              {line.text}
            </span>
          </span>
          <span className="acts">
            {state.status === "otherAccount" && state.canRebind && (
              <button type="button" className="btn outline sm" disabled={busy || props.running} onClick={() => setConfirmRebind(true)}>
                このアカウントで使う
              </button>
            )}
            {state.status === "active" && (
              <button type="button" className="btn outline sm" onClick={syncNow}>
                今すぐ同期
              </button>
            )}
          </span>
        </div>
      )}

      {closingBusy && !preparedClosing && (
        <div className="prow" role="status">
          <b>クラウドを受信中</b>
          <span className="stc">{closingProgress && closingProgress.total > 0
            ? `${closingProgress.done} / ${closingProgress.total} 個を照合しました`
            : "実行中の処理が終わるのを待つか、受信の準備をしています"}</span>
          <span className="acts"><button type="button" className="btn outline sm" onClick={() => void cancelClosing()}>中断する</button></span>
        </div>
      )}

      {niho && state && (
        <div className="prow">
          <b>
            <label htmlFor={nameId}>この Mac の名前</label>
          </b>
          <span className="stc">
            <input
              id={nameId}
              className="inp"
              value={name}
              maxLength={80}
              onFocus={() => {
                editingName.current = true;
              }}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => void saveName()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
            <span className="help">別の Mac で実行中の表示に出る名前です。空にすると Mac の名前に戻ります。</span>
          </span>
          <span className="acts" />
        </div>
      )}

      {cloud.active && (
        <div className="prow">
          <b>使用量</b>
          <span className="stc">
            {usage === undefined ? (
              <span className="help">確かめています</span>
            ) : usage === null ? (
              <span className="help">取得できません</span>
            ) : (
              <span className="cloud-usage">
                <span className={`bar${over ? " full" : ""}`} aria-hidden="true">
                  <i style={{ width: `${percent}%` }} />
                </span>
                <span>
                  {formatBytes(usage.usedBytes)} / {formatBytes(usage.quotaBytes)}
                </span>
              </span>
            )}
            {(over || quotaPaths) && (
              <span className="help warn">容量の上限に達したため、一部のファイルをクラウドに上げられません。手元には保存されています。</span>
            )}
          </span>
          <span className="acts" />
        </div>
      )}

      {migration && (
        <div className="prow">
          <b>移行</b>
          <span className="stc">
            <span className="st">
              {migration.running && <span className="spin" aria-hidden="true" />}
              {migrationText(migration)}
            </span>
            {migration.bytesTotal > 0 && (
              <span className="help">
                {formatBytes(migration.bytesDone)} / {formatBytes(migration.bytesTotal)}
              </span>
            )}
            {migration.failed.length > 0 && (
              <ul className="cloud-failed" aria-label="クラウドに上げられなかったページとフォルダ">
                {migration.failed.map((failure) => (
                  <li key={failure.projectId}>
                    {folderName({ name: failure.name || props.projectName(failure.projectId) || "" })} · {failure.reason}
                  </li>
                ))}
              </ul>
            )}
          </span>
          <span className="acts">
            {migration.running ? (
              <button type="button" className="btn outline sm" disabled={migrationBusy} onClick={() => void migrate(false)}>
                中断する
              </button>
            ) : (
              <button type="button" className="btn outline sm" disabled={migrationBusy || !cloud.active} onClick={() => void migrate(true)}>
                再開する
              </button>
            )}
          </span>
        </div>
      )}

      {cloud.active && (
        <div className="prow">
          <b>削除したフォルダ</b>
          <span className="stc">
            {deleted === null ? (
              <span className="help">確かめています</span>
            ) : deleted.length === 0 ? (
              <span className="help">ありません</span>
            ) : (
              <ul className="cloud-list" aria-label="削除したフォルダ">
                {deleted.map((project) => (
                  <li key={project.projectId}>
                    <span className="nm">{folderName(project)}</span>
                    {project.deletedAt && formatDateTime(project.deletedAt) && (
                      <span className="help">{formatDateTime(project.deletedAt)} に削除</span>
                    )}
                    <button
                      type="button"
                      className="btn outline sm"
                      disabled={restoring !== null}
                      aria-label={`${folderName(project)}を元に戻す`}
                      onClick={() => void restore(project)}
                    >
                      {restoring === project.projectId ? "元に戻しています…" : "元に戻す"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </span>
          <span className="acts" />
        </div>
      )}

      {confirmRebind && (
        <ConfirmDialog
          title="この保存先をこのアカウントで使う"
          confirmLabel="このアカウントで使う"
          busy={busy}
          onConfirm={() => void rebind()}
          onCancel={() => setConfirmRebind(false)}
        >
          <p className="msg">
            この保存先は別の NIHO アカウントと同期していました。これからは今ログインしているアカウントのクラウドに保存します。手元のページとフォルダはそのまま使えます。
          </p>
        </ConfirmDialog>
      )}

      {reopeningPreview && (
        <ConfirmDialog
          title="NIHO クラウドに保存する"
          confirmLabel={reopeningBusy ? "クラウドに移しています…" : "クラウドに移す"}
          busy={reopeningBusy}
          onConfirm={() => void reopen()}
          onCancel={() => setReopeningPreview(null)}
        >
          <p className="msg">
            この Mac のページと音声を NIHO クラウドへ移します。完了すると、ほかの Mac やスマホからも開けます。
            移行中はこの Mac での編集を一時停止します。
          </p>
          <p className="msg">
            {reopeningPreview.projectCount} フォルダ・{reopeningPreview.fileCount} ファイル（{formatBytes(reopeningPreview.bytesTotal)}）を確認しました。
            無料枠は {formatBytes(reopeningPreview.quotaBytes)} です。音声 {reopeningPreview.audioCount} 件は、クラウドでは 30 日で消え、この Mac には残ります。
          </p>
        </ConfirmDialog>
      )}

      {closingPreview && (
        <ConfirmDialog
          title="クラウドからこの Mac に移す"
          confirmLabel="受信を始める"
          confirmDisabled={closingPreview.availableFreeBytes < closingPreview.requiredFreeBytes}
          onConfirm={() => void prepareClosing()}
          onCancel={() => setClosingPreview(null)}
        >
          <p className="msg">まずクラウドの全データをこの Mac に受信して照合します。受信が完了するまでクラウドは削除しません。</p>
          <p className="msg">フォルダ {closingPreview.preflight.folders} 件・ページ {closingPreview.preflight.pages} 件・音声 {closingPreview.preflight.unexpiredAudio} 件を受信します。削除済みフォルダ {closingPreview.preflight.deletedFolders} 件は、確定後に Mac のゴミ箱へ移します。</p>
          <p className="msg">受信量 {formatBytes(Number(closingPreview.preflight.transferBytes))}。必要な空き容量 {formatBytes(closingPreview.requiredFreeBytes)}、現在 {formatBytes(closingPreview.availableFreeBytes)}。</p>
          {closingPreview.availableFreeBytes < closingPreview.requiredFreeBytes && <p className="err">この Mac の空き容量が足りません。</p>}
          <p className="msg">期限切れ音声 {closingPreview.preflight.expiredAudio} 件はクラウドから取得できません。ほかの Mac {closingPreview.preflight.otherMacs.length} 台の未送信分は各 Mac に残ります。</p>
          {closingPreview.preflight.otherMacs.length > 0 && (
            <ul className="msg closing-other-macs">
              {closingPreview.preflight.otherMacs.map((mac, index) => (
                <li key={`${mac.name}-${index}`}>{mac.name}（最終接続: {new Date(mac.lastUsedAt).toLocaleString("ja-JP")}）</li>
              ))}
            </ul>
          )}
          {closingPreview.preflight.active.runs + closingPreview.preflight.active.composerTurns + closingPreview.preflight.active.folderExports > 0 &&
            <p className="msg">実行中の処理が終わるまで受信を待ちます。</p>}
        </ConfirmDialog>
      )}

      {preparedClosing && (
        <ConfirmDialog
          title="クラウド保存を止める"
          confirmLabel={closingBusy ? "確認中…" : "クラウドから削除"}
          danger
          busy={closingBusy}
          onConfirm={() => void confirmClosing()}
          onCancel={() => setPreparedClosing(null)}
        >
          <p className="msg">このアカウントのクラウド保存を止めます。ほかの Mac の内容は各 Mac に残り、以後同期されません。スマホや Web では開けなくなります。</p>
          <p className="msg">クラウドの {preparedClosing.fileCount} ファイルをこの Mac に受信し、全件照合しました。削除したフォルダ {preparedClosing.deletedFolderCount} 件は確定後に Mac のゴミ箱へ移します。期限切れ音声 {preparedClosing.expiredAudioCount} 件は取得できません。</p>
          <p className="msg">クラウドから削除した後も、復旧用バックアップから復元される可能性があります。</p>
        </ConfirmDialog>
      )}
    </>
  );
}
