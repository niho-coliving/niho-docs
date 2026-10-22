"use client";

import { NEXT_STEPS_WORDS, RUN_PLACE_CHANGE_LABEL, RUN_START_LABELS, continueMenuCaption, doneBandLine, runningBandLine, type NextStepRow } from "@niho/docs-core";
import { Check, ChevronDown, Laptop, Play } from "lucide-react";
import { useId, useState } from "react";

/** 「次の工程」の処理中・完了状態を表示する帯。 */
export type DocsNextStepsBand =
  | { kind: "running"; stepName: string; place: string }
  | { kind: "done"; names: string[] };

/** 「次の工程」画面が受け取る表示状態。判定や実行制御はホストが担う。 */
export type DocsNextStepsData = {
  rows: Array<NextStepRow & { openable: boolean }>;
  remaining: string[];
  running: boolean;
  summary: string;
  startable: boolean;
  reason: string | null;
  macGuide: boolean;
  checking: boolean;
  placeLine: string | null;
  band: DocsNextStepsBand | null;
  submitting: boolean;
  error: string | null;
  notice: string | null;
};

/** ホストが続きの作成を受け付けるためのコールバック。 */
export type ContinueMenuAction = () => void;

/** 「次の工程」画面に渡す状態とコールバック。 */
export type DocsNextStepsView = DocsNextStepsData & {
  start: ContinueMenuAction;
  stop: () => void;
  closeBand: () => void;
  open: (stepId: string) => void;
};

const DEFAULT_MAC_APP_HREF = "/docs/download";
const TEXT_BUTTON = "inline-flex min-h-9 items-center text-sub font-bold text-niho-accent-ink underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-dark/40 disabled:cursor-not-allowed disabled:opacity-50";

function StatusDot({ status, current }: { status: NextStepRow["status"]; current: boolean }) {
  if (status === "done") {
    return <span aria-hidden="true" className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${current ? "bg-niho-dark text-white" : "bg-niho-accent-soft text-niho-accent-ink"}`}><Check className="h-3 w-3" strokeWidth={3} /></span>;
  }
  if (status === "running") return <span aria-hidden="true" className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-niho-accent-soft border-t-niho-dark motion-reduce:animate-none" />;
  if (status === "waiting") return <span aria-hidden="true" className="h-5 w-5 shrink-0 rounded-full border-2 border-dashed border-niho-border" />;
  return <span aria-hidden="true" className="h-5 w-5 shrink-0 rounded-full border-2 border-niho-border" />;
}

/** 工程の列を表示する部品。 */
export function DocsNextStepsList({ view }: { view: DocsNextStepsView }) {
  return <ol aria-label="工程の進み具合" className="divide-y divide-niho-border border-y border-niho-border">
    {view.rows.map((row) => {
      const content = <>
        <StatusDot status={row.status} current={row.current} />
        <span className={`min-w-0 flex-1 break-words text-sub ${row.current ? "font-extrabold text-niho-text" : "font-bold text-niho-text"}`}>{row.label}</span>
        <span className={`shrink-0 text-sub ${row.status === "running" && !row.current ? "font-bold text-niho-accent-ink" : "text-niho-text-muted"}`}>{row.statusLabel}</span>
      </>;
      return <li key={row.stepId} aria-current={row.current ? "page" : undefined}>
        {row.openable
          ? <button type="button" onClick={() => view.open(row.stepId)} aria-label={`${row.label}を開く`} className="flex min-h-11 w-full min-w-0 items-center gap-2.5 px-1 text-left hover:bg-niho-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-dark/40">{content}</button>
          : <div className="flex min-h-11 min-w-0 items-center gap-2.5 px-1">{content}</div>}
      </li>;
    })}
  </ol>;
}

function Controls({ view, onOpenSettings, macAppHref = DEFAULT_MAC_APP_HREF }: { view: DocsNextStepsView; onOpenSettings?: () => void; macAppHref?: string }) {
  const remaining = view.remaining.length;
  return <div className="min-w-0">
    {view.notice ? <p role="status" className="mt-2 text-sub leading-relaxed text-niho-text-sub">{view.notice}</p> : null}
    {remaining > 0 ? <button
      type="button"
      onClick={view.start}
      disabled={!view.startable || view.running || view.submitting}
      className={`niho-accent-surface mt-3 inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-body font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-dark/40 disabled:cursor-not-allowed disabled:opacity-50 w-full`}
    >{view.running || view.submitting ? NEXT_STEPS_WORDS.runningButton : RUN_START_LABELS.continue}</button> : null}
    {view.checking && remaining > 0 ? <p role="status" className="mt-2 text-sub text-niho-text-muted">利用条件を確認しています...</p> : null}
    {view.reason && !view.running ? <p className="mt-2 text-sub leading-relaxed text-niho-text-sub">{view.reason}</p> : null}
    {view.macGuide && !view.running ? <a href={macAppHref} className={`mt-1 inline-flex min-h-9 items-center gap-2 ${TEXT_BUTTON}`}><Laptop className="h-4 w-4" aria-hidden="true" />Macアプリで続ける</a> : null}
    {view.error ? <p role="alert" className="mt-2 break-words text-sub leading-relaxed text-niho-danger">{view.error}</p> : null}
    {view.placeLine && !view.running ? <p className="mt-2 flex flex-wrap items-center gap-x-2 text-sub leading-relaxed text-niho-text-muted">
      <span>{view.placeLine}</span>
      {onOpenSettings ? <button type="button" onClick={onOpenSettings} className={TEXT_BUTTON}>{RUN_PLACE_CHANGE_LABEL}</button> : null}
    </p> : null}
  </div>;
}

/** PC向けの折り畳み可能な「次の工程」。 */
export function DocsNextStepsSection({ view, onOpenSettings, macAppHref }: { view: DocsNextStepsView; onOpenSettings?: () => void; macAppHref?: string }) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  return <section aria-label={NEXT_STEPS_WORDS.heading} className="mt-3 shrink-0 rounded-xl border border-niho-border bg-white px-3 py-1">
    <button
      type="button"
      aria-expanded={open}
      aria-controls={bodyId}
      onClick={() => setOpen((value) => !value)}
      className="flex min-h-10 w-full items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-dark/40"
    >
      <ChevronDown className={`h-4 w-4 shrink-0 text-niho-text-muted transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden="true" />
      <span className="text-body font-extrabold text-niho-text">{NEXT_STEPS_WORDS.heading}</span>
      <span className={`ml-auto text-sub ${view.running ? "font-bold text-niho-accent-ink" : "text-niho-text-muted"}`}>{view.summary}</span>
    </button>
    <div id={bodyId} hidden={!open} className="pb-2">
      <DocsNextStepsList view={view} />
      <Controls view={view} onOpenSettings={onOpenSettings} macAppHref={macAppHref} />
    </div>
  </section>;
}

/** スマホ向けの本文末尾に置く「次の工程」。 */
export function DocsNextStepsEnd({ view, onOpenSettings, macAppHref }: { view: DocsNextStepsView; onOpenSettings?: () => void; macAppHref?: string }) {
  const headingId = useId();
  const allDone = view.remaining.length === 0;
  return <section aria-labelledby={headingId} className="mt-8 min-w-0 border-t border-niho-border pt-5">
    <h2 id={headingId} className="text-sub font-extrabold text-niho-text-muted">{allDone ? NEXT_STEPS_WORDS.allDoneHeading : NEXT_STEPS_WORDS.mobileHeading}</h2>
    <div className="mt-2"><DocsNextStepsList view={view} /></div>
    <Controls view={view} onOpenSettings={onOpenSettings} macAppHref={macAppHref} />
  </section>;
}

/** 処理中または工程完了を本文上部に表示する帯。 */
export function DocsNextStepsBandView({ band, onStop, onClose }: { band: DocsNextStepsBand; onStop: () => void; onClose: () => void }) {
  if (band.kind === "done") {
    return <div role="status" className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-niho-accent-soft px-3 py-2 text-sub leading-relaxed text-niho-text-sub">
      <span aria-hidden="true" className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-niho-dark text-white"><Check className="h-3 w-3" strokeWidth={3} /></span>
      <span className="min-w-0 break-words">{doneBandLine(band.names)}</span>
      <button type="button" onClick={onClose} className={`ml-auto ${TEXT_BUTTON}`}>{NEXT_STEPS_WORDS.close}</button>
    </div>;
  }
  const line = runningBandLine({ stepName: band.stepName, place: band.place });
  return <div role="status" className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-niho-accent-soft px-3 py-2 text-sub leading-relaxed text-niho-text-sub">
    <span aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-niho-border border-t-niho-dark motion-reduce:animate-none" />
    <span className="min-w-0 break-words"><b className="font-bold text-niho-text">{line.lead}</b> <span className="text-niho-text-muted">{line.place}</span></span>
    <button type="button" onClick={onStop} className={`ml-auto ${TEXT_BUTTON}`}>{NEXT_STEPS_WORDS.stop}</button>
  </div>;
}

/** 続きの作成を選ぶメニュー項目。 */
export function DocsRunMenu({ view, onPick, id }: { view: DocsNextStepsView; onPick: ContinueMenuAction; id?: string }) {
  const caption = continueMenuCaption(view.remaining);
  const blocked = !view.startable || view.running || view.submitting;
  const subline = view.running ? NEXT_STEPS_WORDS.runBusy : view.reason ?? caption;
  return <div id={id} role="menu" aria-label={NEXT_STEPS_WORDS.menuHeading} className="absolute inset-x-0 bottom-full z-10 mb-2 rounded-[14px] border border-niho-border bg-white p-1.5 shadow-[0_8px_24px_rgba(53,45,35,0.12)]">
    <div className="flex items-center justify-between px-2.5 py-1.5 text-xs font-bold text-niho-text-muted"><span>{NEXT_STEPS_WORDS.menuHeading}</span><span className="font-normal">{NEXT_STEPS_WORDS.menuHint}</span></div>
    <button
      type="button"
      role="menuitem"
      disabled={blocked}
      onClick={onPick}
      className="flex min-h-11 w-full min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-niho-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-dark/40 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
    >
      <Play className="mt-0.5 h-4 w-4 shrink-0 text-niho-accent-ink" aria-hidden="true" />
      <span className="min-w-0"><b className="block text-sub font-bold text-niho-text">{RUN_START_LABELS.continue}</b>{subline ? <small className="block break-words text-xs leading-relaxed text-niho-text-muted">{subline}</small> : null}</span>
    </button>
  </div>;
}
