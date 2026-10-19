"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { buildFlowChoices, flowStepLineParts, type FlowChoiceTemplateOption, type FlowTemplate } from "@niho/docs-core";

/** 選んだ作り方: テンプレートか白紙（工程 1 の文字起こしだけのフロー）。 */
export type FlowChoice = FlowTemplate | "blank";

const BLANK = "blank";

export const FLOW_PICKER_NOTE = "録音の作り方を選びます。あとから「工程設計」で増やし、録音のページごとに選び直せます。";

/**
 * 並べるテンプレート（#18883。録音のページの「工程」と Web/PWA と同じ docs-core の選択肢。フローが 1 つも無いときに出すので、
 * テンプレートはすべて並ぶ）。
 */
const TEMPLATE_CHOICES: readonly FlowChoiceTemplateOption[] = buildFlowChoices([]).options.flatMap((option) =>
  option.kind === "template" ? [option] : [],
);

/** 選んだカード（既定の選択は無い）。 */
function useFlowChoice() {
  const [picked, setPicked] = useState<string | null>(null);
  const choice: FlowChoice | null =
    picked === BLANK ? BLANK : (TEMPLATE_CHOICES.find((candidate) => candidate.id === picked)?.template ?? null);
  return { picked, setPicked, choice };
}

/**
 * 「工程を選ぶ」の並び: テンプレート 4 つ（記事制作・議事録・インサイト整理・コーチング。工程の列つき）と白紙が同格に並ぶ。
 * フローが 1 つも無いときだけ出す（最初に録音のページを足すときのダイアログと、工程設計の画面）。フローを足すのは工程設計の
 * 「＋ 追加」で、録音のページごとに「工程」で選ぶ（P4 #18567）。
 */
function FlowPickerGrid(props: { picked: string | null; onPick: (id: string) => void; disabled: boolean }) {
  return (
    <div className="tgrid" role="group" aria-label="工程を選ぶ">
      {TEMPLATE_CHOICES.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          className="tcard"
          aria-pressed={candidate.id === props.picked}
          disabled={props.disabled}
          onClick={() => props.onPick(candidate.id)}
        >
          <b>{candidate.name}</b>
          <span className="flowline">
            {flowStepLineParts(candidate.template.steps).map((name, index) => (
              <Fragment key={`${name}-${index}`}>
                {index > 0 && <i>›</i>}
                {name}
              </Fragment>
            ))}
          </span>
        </button>
      ))}
      <button
        type="button"
        className="tcard blank"
        aria-pressed={props.picked === BLANK}
        disabled={props.disabled}
        onClick={() => props.onPick(BLANK)}
      >
        白紙から
      </button>
    </div>
  );
}

/**
 * フローが無いときに録音のページを足そうとすると出すダイアログ。テンプレートを選ぶとそのまま録音のページを作り、白紙は工程設計へ
 * 進む（どちらへ進むかは呼び出し側）。開いたら最初のカードへフォーカスし、Tab はダイアログの中で回す。Esc は「キャンセル」と同じ。
 */
export function FlowPickerDialog(props: { busy: boolean; onChoose: (choice: FlowChoice) => void; onCancel: () => void }) {
  const titleId = useId();
  const { picked, setPicked, choice } = useFlowChoice();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCancelRef = useRef(props.onCancel);
  onCancelRef.current = props.onCancel;
  const busyRef = useRef(props.busy);
  busyRef.current = props.busy;

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        const inside = dialogRef.current?.contains(document.activeElement) ?? false;
        if (event.shiftKey && (!inside || document.activeElement === first)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!busyRef.current) onCancelRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="veil" role="presentation">
      <div ref={dialogRef} className="dlg wide" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>工程を選ぶ</h2>
        <p className="msg">{FLOW_PICKER_NOTE}</p>
        <FlowPickerGrid picked={picked} onPick={setPicked} disabled={props.busy} />
        <div className="acts">
          <button type="button" className="btn outline" onClick={props.onCancel} disabled={props.busy}>
            キャンセル
          </button>
          <button type="button" className="btn primary" disabled={!choice || props.busy} onClick={() => choice && props.onChoose(choice)}>
            続ける
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 工程設計の画面でフローがまだ無いとき: 同じ並びをその場に出す（選ぶと工程設計のまま、作った設計を出す。録音のページの「工程設計で
 * 作る」から来たときは、テンプレートならその録音に付けて戻る。どちらへ進むかは呼び出し側で、`note` で先に伝える）。
 */
export function FlowPickerPanel(props: { busy: boolean; note?: string; onChoose: (choice: FlowChoice) => void }) {
  const { picked, setPicked, choice } = useFlowChoice();
  return (
    <div className="page">
      <div className="narrow">
        <div className="phead">
          <h1>工程を選ぶ</h1>
        </div>
        <div className="pick">
          <p className="help">{props.note ?? FLOW_PICKER_NOTE}</p>
          <FlowPickerGrid picked={picked} onPick={setPicked} disabled={props.busy} />
          <div className="acts">
            <button type="button" className="btn primary" disabled={!choice || props.busy} onClick={() => choice && props.onChoose(choice)}>
              続ける
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
