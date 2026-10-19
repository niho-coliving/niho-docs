"use client";

import { useState } from "react";
import { formatVariants, parseVariants, type GlossaryEntry } from "@niho/docs-core";
import { usePopover } from "./usePopover";

/** 固有名詞の 4 列（表記・よみ・誤りやすい表記・補足）。文書ガイド（共通）と案件情報（案件ごと）が同じ形。 */

type Row = { key: number; term: string; reading: string; variants: string; note: string };

let nextKey = 1;

function toRows(entries: readonly GlossaryEntry[]): Row[] {
  return entries.map((entry) => ({
    key: nextKey++,
    term: entry.term,
    reading: entry.reading,
    variants: formatVariants(entry.variants),
    note: entry.note,
  }));
}

function toEntries(rows: readonly Row[]): GlossaryEntry[] {
  return rows.map((row) => ({ term: row.term, reading: row.reading, variants: parseVariants(row.variants), note: row.note }));
}

function RowMenu(props: { onRemove: () => void }) {
  const menu = usePopover();
  return (
    <div ref={menu.ref} style={{ position: "relative" }}>
      <button type="button" className="ibtn sm" title="その他" aria-label="その他" onClick={menu.toggle}>
        ⋯
      </button>
      {menu.open && (
        <div className="pop" role="menu">
          <button
            type="button"
            className="mi danger"
            role="menuitem"
            onClick={() => {
              menu.setOpen(false);
              props.onRemove();
            }}
          >
            削除
          </button>
        </div>
      )}
    </div>
  );
}

/** 編集中の文字（誤りやすい表記の「・」など）を保つため、行は手元の状態で持ち、変わるたびに外へ渡す。 */
export function Glossary(props: { entries: readonly GlossaryEntry[]; onChange: (entries: GlossaryEntry[]) => void }) {
  const [rows, setRows] = useState<Row[]>(() => toRows(props.entries));
  const update = (next: Row[]) => {
    setRows(next);
    props.onChange(toEntries(next));
  };
  const change = (key: number, field: "term" | "reading" | "variants" | "note", value: string) =>
    update(
      rows.map((row) => {
        if (row.key !== key) return row;
        const next: Row = { ...row };
        next[field] = value;
        return next;
      }),
    );
  return (
    <div className="gl">
      <div className="glh">
        <span>表記</span>
        <span>よみ</span>
        <span>誤りやすい表記</span>
        <span>補足</span>
        <span />
      </div>
      {rows.map((row) => (
        <div className="glr" key={row.key}>
          <input aria-label="表記" value={row.term} onChange={(event) => change(row.key, "term", event.target.value)} />
          <input aria-label="よみ" placeholder="よみ" value={row.reading} onChange={(event) => change(row.key, "reading", event.target.value)} />
          <input
            aria-label="誤りやすい表記"
            placeholder="—"
            value={row.variants}
            onChange={(event) => change(row.key, "variants", event.target.value)}
          />
          <input aria-label="補足" placeholder="—" value={row.note} onChange={(event) => change(row.key, "note", event.target.value)} />
          <RowMenu onRemove={() => update(rows.filter((candidate) => candidate.key !== row.key))} />
        </div>
      ))}
      <button
        type="button"
        className="link"
        onClick={() => update([...rows, { key: nextKey++, term: "", reading: "", variants: "", note: "" }])}
      >
        ＋ 追加
      </button>
    </div>
  );
}
