"use client";

import { DocIcon, MicIcon } from "../components/icons";
import { formatDateTime } from "../lib/format";

export type { DocsRecentPage as RecentRow } from "../host/DocsWorkspaceHost";
import type { DocsRecentPage as RecentRow } from "../host/DocsWorkspaceHost";

/**
 * ホーム（タイトルバーのアプリ名・起動したときに前回のページが無いとき。#18929）。見出し「ホーム」と作成のカードは置かず「最近」だけにする。
 * 作成はタイトルバーの新規作成の ＋ とフォルダの行の ＋ に集める（Web/PWA の #18846 と同じ。owner 2026-10-18・#18867）。
 */
export function HomeScreen(props: { recent: RecentRow[]; hasPages: boolean; onOpen: (row: RecentRow) => void }) {
  return <div className="sheet home-sheet"><div className="pg home-page">
    <section className="recent" aria-labelledby="recent-title"><h2 id="recent-title">最近</h2>
      {props.recent.length === 0 ? <p className="help">{props.hasPages ? "最近開いたページはありません。" : "ページはまだありません。"}</p> : props.recent.map((row) =>
        <button type="button" className="recent-row" key={`${row.projectId ?? "_outside"}/${row.page.id}`} onClick={() => props.onOpen(row)}>
          <span className="recent-icon">{row.page.kind === "doc" ? <DocIcon /> : <MicIcon />}</span>
          <span className="recent-main"><strong>{row.title}</strong><small>{row.folder} · {formatDateTime(row.openedAt)}</small></span>
          {row.progress && <span className="recent-progress">{row.progress}</span>}
        </button>)}
    </section>
  </div></div>;
}
