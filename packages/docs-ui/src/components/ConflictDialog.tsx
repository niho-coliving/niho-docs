"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { collapseDiff, diffLines, type DiffRow } from "@niho/docs-core";
import { errorMessage, isCommandError, type Bridge } from "../lib/bridge";
import { isTextPath } from "../lib/cloud";
import { otherDeviceLabel, withDeviceLabel } from "../lib/cloud-device";
import type { ConflictEntry, ResolveChoice } from "../lib/cloud-types";
import { formatDateTime } from "../lib/format";
import "../styles/cloud.css";

/**
 * 変更の確認（spec niho-docs-cloud §8.1）: この Mac とクラウドの両方で変わった文書の両側を並べ、どちらを使うかを本人が選ぶ。
 * 「このMacの内容を使う」「クラウドの内容を使う」「両方を編集して保存」（文書だけ。この Mac の内容から直す）。片方で削除された
 * ものは「残す」「削除する」。解決は新しい版として保存され、確かめている間にクラウドがまた変わったら、知らせて両側を読み直す。
 * 選ぶまで、今の本文はそのまま。
 */

/** これより長い文書は、両側の全文の代わりに違いの行を出す（変わった行と前後 2 行だけ）。 */
const LONG_LINES = 40;

type Sides = { local: string | null; remote: string | null };

function lineCount(text: string | null): number {
  return text === null ? 0 : text.split("\n").length;
}

function isDeleteKind(entry: ConflictEntry): boolean {
  return entry.kind === "localDeletedRemoteEdited" || entry.kind === "remoteDeletedLocalEdited";
}

function SideBody(props: { deleted: boolean; text: string | null }) {
  if (props.deleted) return <p className="help">削除されました</p>;
  if (props.text === null) return <p className="help">この形式は表示できません</p>;
  return <pre>{props.text || " "}</pre>;
}

export function ConflictDialog(props: {
  bridge: Bridge;
  projectId: string;
  /** 1 つの文書だけ（null は案件の確かめが要る変更すべて）。 */
  path: string | null;
  /** 一覧に出す名前（内部の id は出さない）。 */
  labelOf: (path: string) => string;
  /** 今のこの Mac の本文（読めなければ null。無ければ変更が重なったときの写しを出す）。 */
  readLocal?: (path: string) => Promise<string | null>;
  /** 解決して保存した（呼び元が知らせて、その文書を読み直す）。 */
  onResolved: (path: string) => void;
  onClose: () => void;
}) {
  const { bridge, projectId, path } = props;
  const titleId = useId();
  const editId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [entries, setEntries] = useState<ConflictEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sides, setSides] = useState<Sides | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 読み直しの印（解決の後・クラウドがまた変わったとき）。 */
  const [reload, setReload] = useState(0);
  const hostRef = useRef(props);
  hostRef.current = props;
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!busyRef.current) hostRef.current.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    bridge.cloudConflicts(projectId).then(
      (all) => {
        if (cancelled) return;
        const open = all.filter((entry) => entry.status === "open" && (path === null || entry.path === path));
        setEntries(open);
        setSelectedId((current) => (current && open.some((entry) => entry.conflictId === current) ? current : (open[0]?.conflictId ?? null)));
      },
      (failure: unknown) => {
        if (cancelled) return;
        setEntries([]);
        setError(errorMessage(failure, "変更を読めませんでした。"));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, projectId, path, reload]);

  const entry = entries?.find((candidate) => candidate.conflictId === selectedId) ?? null;
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const conflictId = entry?.conflictId ?? null;
  const updatedAt = entry?.updatedAt ?? null;

  // 選んだ変更の両側を読む（同じ変更でも、読み直しの印か更新の時刻が変われば読み直す）
  useEffect(() => {
    const current = entryRef.current;
    if (!current || current.conflictId !== conflictId) {
      setSides(null);
      return;
    }
    let cancelled = false;
    setSides(null);
    setEditing(null);
    const copy = (side: "local" | "remote") => bridge.cloudConflictCopy(projectId, current.conflictId, side).catch(() => null);
    const local = async (): Promise<string | null> => {
      if (current.kind === "localDeletedRemoteEdited") return null;
      const text = (await hostRef.current.readLocal?.(current.path).catch(() => null)) ?? null;
      return text ?? (await copy("local"));
    };
    const remote = async (): Promise<string | null> => (current.kind === "remoteDeletedLocalEdited" ? null : copy("remote"));
    void Promise.all([local(), remote()]).then(([localText, remoteText]) => {
      if (!cancelled) setSides({ local: localText, remote: remoteText });
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, projectId, conflictId, updatedAt, reload]);

  const resolve = async (choice: ResolveChoice, text?: string) => {
    if (!entry || busyRef.current) return;
    setBusy(true);
    setError(null);
    try {
      await bridge.cloudResolveConflict(projectId, entry.conflictId, choice, text ?? null, entry.remoteSha256);
      hostRef.current.onResolved(entry.path);
      const rest = (entries ?? []).filter((candidate) => candidate.conflictId !== entry.conflictId);
      if (rest.length === 0) {
        hostRef.current.onClose();
        return;
      }
      setEditing(null);
      setReload((value) => value + 1);
    } catch (failure) {
      setError(errorMessage(failure, "変更を保存できませんでした。"));
      // 確かめている間にクラウドがまた変わった: 両側を読み直す（選んだ内容では保存しない）
      if (isCommandError(failure) && failure.code === "conflict_changed") {
        setEditing(null);
        setReload((value) => value + 1);
      }
    } finally {
      setBusy(false);
    }
  };

  const deleteKind = entry ? isDeleteKind(entry) : false;
  const mergeable = entry !== null && !deleteKind && isTextPath(entry.path) && sides !== null && sides.local !== null && sides.remote !== null;
  const rows = useMemo((): DiffRow[] | null => {
    if (!sides || sides.local === null || sides.remote === null) return null;
    if (Math.max(lineCount(sides.local), lineCount(sides.remote)) <= LONG_LINES) return null;
    return collapseDiff(diffLines(sides.local, sides.remote));
  }, [sides]);
  const localAt = entry?.localModifiedAt ? formatDateTime(entry.localModifiedAt) : "";
  const remoteAt = entry?.remoteModifiedAt ? formatDateTime(entry.remoteModifiedAt) : "";
  // クラウド側を変えた端末（同期の競合だけ。再起動時の食い違いと、クラウド側が削除された版は名指さない）
  const remoteDevice =
    entry && entry.origin === "sync" && entry.remoteDeviceId
      ? otherDeviceLabel({ deviceId: entry.remoteDeviceId, deviceKind: entry.remoteFile?.writerDeviceKind ?? null })
      : null;
  const remoteHeading = remoteDevice ? `クラウド（${withDeviceLabel(remoteDevice, "で変更")}）` : "クラウド";

  return (
    <div className="veil" role="presentation">
      <div className="dlg cfdlg" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>変更の確認</h2>
        {entries === null ? (
          <p className="help">読み込んでいます</p>
        ) : entries.length === 0 ? (
          <p className="msg">確かめが必要な変更はありません。</p>
        ) : (
          <>
            {entries.length > 1 && (
              <div className="cflist" role="group" aria-label="確かめる文書">
                {entries.map((candidate) => (
                  <button
                    type="button"
                    key={candidate.conflictId}
                    aria-pressed={candidate.conflictId === selectedId}
                    disabled={busy}
                    onClick={() => setSelectedId(candidate.conflictId)}
                  >
                    {props.labelOf(candidate.path)}
                  </button>
                ))}
              </div>
            )}
            {entry && (
              <p className="msg">
                {entries.length === 1 && <b>{props.labelOf(entry.path)}</b>}
                {entries.length === 1 && "："}
                {deleteKind
                  ? "片方で削除され、もう片方で変更されました。残すか削除するかを選んでください。"
                  : `この Mac と${withDeviceLabel(remoteDevice ?? "クラウド", "の両方で変更されました。")}使う内容を選んでください。選ぶまで、今の本文はそのままです。`}
              </p>
            )}
            {entry && sides === null && <p className="help">読み込んでいます</p>}
            {entry && sides && editing !== null && (
              <div className="cfsides">
                <div className="cfside">
                  <h3>
                    <label htmlFor={editId}>この Mac</label>
                    <span className="t">直してから保存します</span>
                  </h3>
                  <textarea id={editId} className="ta" value={editing} onChange={(event) => setEditing(event.target.value)} disabled={busy} />
                </div>
                <div className="cfside">
                  <h3>
                    {remoteHeading}{remoteAt && <span className="t">{remoteAt}</span>}
                  </h3>
                  <SideBody deleted={false} text={sides.remote} />
                </div>
              </div>
            )}
            {entry && sides && editing === null && (
              <>
                <div className="cfsides">
                  <div className="cfside">
                    <h3>
                      この Mac{localAt && <span className="t">{localAt}</span>}
                    </h3>
                    {!rows && <SideBody deleted={entry.kind === "localDeletedRemoteEdited"} text={sides.local} />}
                  </div>
                  <div className="cfside">
                    <h3>
                      {remoteHeading}{remoteAt && <span className="t">{remoteAt}</span>}
                    </h3>
                    {!rows && <SideBody deleted={entry.kind === "remoteDeletedLocalEdited"} text={sides.remote} />}
                  </div>
                </div>
                {rows && (
                  <>
                    <p className="help">長い文書なので、違う行だけを出しています（「−」は この Mac、「＋」は クラウドの行）。</p>
                    <div className="diff" role="list">
                      {rows.map((row, index) =>
                        row.kind === "skip" ? (
                          <div className="dl skip" role="listitem" key={index}>
                            … {row.count} 行は同じ
                          </div>
                        ) : (
                          <div className={`dl ${row.kind}`} role="listitem" key={index}>
                            <span className="mk" aria-label={row.kind === "added" ? "クラウドの行" : row.kind === "removed" ? "この Mac の行" : "同じ行"}>
                              {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : ""}
                            </span>
                            <span className="tx">{row.text || " "}</span>
                          </div>
                        ),
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <div className="cfacts">
          {editing !== null ? (
            <>
              <button ref={cancelRef} type="button" className="btn outline" disabled={busy} onClick={() => setEditing(null)}>
                戻る
              </button>
              <button type="button" className="btn primary" disabled={busy || !entry} onClick={() => void resolve("merged", editing)}>
                この内容で保存
              </button>
            </>
          ) : (
            <>
              <button ref={cancelRef} type="button" className="btn outline" disabled={busy} onClick={props.onClose}>
                {entries !== null && entries.length === 0 ? "閉じる" : "やめる"}
              </button>
              {entry && sides && deleteKind && (
                <>
                  <button type="button" className="btn stop" disabled={busy} onClick={() => void resolve("delete")}>
                    削除する
                  </button>
                  <button type="button" className="btn primary" disabled={busy} onClick={() => void resolve("keep")}>
                    残す
                  </button>
                </>
              )}
              {entry && sides && !deleteKind && (
                <>
                  <button type="button" className="btn outline" disabled={busy} onClick={() => void resolve("local")}>
                    このMacの内容を使う
                  </button>
                  <button type="button" className="btn outline" disabled={busy} onClick={() => void resolve("remote")}>
                    クラウドの内容を使う
                  </button>
                  {mergeable && (
                    <button type="button" className="btn outline" disabled={busy} onClick={() => setEditing(sides.local ?? "")}>
                      両方を編集して保存
                    </button>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
