"use client";

import { useState } from "react";
import type { PageEntry, Project } from "@niho/docs-core";
import { errorMessage, type Bridge } from "../lib/bridge";

/**
 * 「新しいフォルダ」のダイアログ（#18564 P1）: フォルダ名だけ。`pages: []` のフォルダを作り、最初の文書のページを足す（工程が無くても
 * 作れる。工程は音声を足すときに選ぶ）。背景情報・登場人物・固有名詞は背景情報のページ（FolderInfo。#18914 でダイアログから移した）。
 */

export type ProjectDialogProps = {
  mode: "new";
  bridge: Bridge;
  onClose: () => void;
  /** 作ったフォルダと、最初の文書のページ（足せなかったら null）。 */
  onDone: (projectId: string, page: PageEntry | null) => void;
};

export function ProjectDialog(props: ProjectDialogProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bridge = props.bridge;

  const submit = async () => {
    if (busy) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("フォルダ名を入れてください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const project: Project = {
        version: 1,
        id: "",
        name: trimmedName,
        createdAt: now,
        info: { terms: [], background: "", entities: [] },
        pages: [],
      };
      const created = await bridge.createProject(project, null, null, []);
      // 最初のページを足せなくてもフォルダはできている（レールの ＋ から足せる）
      const page = await bridge.createPage(created.id, { kind: "doc", title: "", createdAt: now }).catch(() => null);
      props.onDone(created.id, page);
    } catch (submitError) {
      setError(errorMessage(submitError, "保存できませんでした。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="veil" role="presentation">
      <div className="dlg narrow" role="dialog" aria-modal="true" aria-labelledby="info-title">
        <h2 id="info-title">新しいフォルダ</h2>
        <div className="fields">
          <div className="fld">
            <label htmlFor="info-name">フォルダ名</label>
            <input
              id="info-name"
              className="inp"
              value={name}
              placeholder="例: 佐藤さん コーチング"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) void submit();
              }}
              autoFocus
            />
          </div>
          {error && <p className="err">{error}</p>}
        </div>
        <div className="acts">
          <button type="button" className="btn outline" onClick={props.onClose} disabled={busy}>
            キャンセル
          </button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy}>
            作成
          </button>
        </div>
      </div>
    </div>
  );
}
