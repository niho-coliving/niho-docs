"use client";

import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

/**
 * 確かめるダイアログ（ブラウザの `window.confirm` は Tauri の窓で出ないので使わない。design-guide §6）。
 * 確定のボタンは結果の動詞にする。消す操作は `danger`（赤字の `.btn.stop`。brand の色にしない）で、
 * 誤って Enter で消さないように、開いたときのフォーカスは「やめる」に置く。Esc は「やめる」と同じ。入力を聞くダイアログ（`focusField`）は
 * 最初の入力欄にフォーカスする。
 */
export function ConfirmDialog(props: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  wide?: boolean;
  /** 確定の処理中（二重に押せない）。 */
  busy?: boolean;
  /** 確定だけを押せない（入力がまだ無いなど）。 */
  confirmDisabled?: boolean;
  /** 開いたときのフォーカスを最初の入力欄に置く。 */
  focusField?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCancelRef = useRef(props.onCancel);
  onCancelRef.current = props.onCancel;
  const busyRef = useRef(props.busy);
  busyRef.current = props.busy;
  const danger = props.danger ?? false;

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, []);

  const focusField = props.focusField ?? false;
  useEffect(() => {
    const field = focusField ? dialogRef.current?.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled])") : null;
    if (field) {
      field.focus();
      return;
    }
    const target = (danger ? cancelRef : confirmRef).current;
    (target && !target.disabled ? target : dialogRef.current)?.focus();
  }, [danger, focusField, props.busy]);

  useEffect(() => {
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (!busyRef.current) onCancelRef.current();
    };
    document.addEventListener("keydown", onDocumentKeyDown);
    return () => document.removeEventListener("keydown", onDocumentKeyDown);
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busyRef.current) onCancelRef.current();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) { event.preventDefault(); return; }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="veil" role="presentation">
      <div ref={dialogRef} tabIndex={-1} className={`dlg${props.wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <h2 id={titleId}>{props.title}</h2>
        {props.children}
        <div className="acts">
          <button ref={cancelRef} type="button" className="btn outline" onClick={props.onCancel} disabled={props.busy}>
            {props.cancelLabel ?? "やめる"}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`btn ${danger ? "stop" : "primary"}`}
            onClick={props.onConfirm}
            disabled={props.busy || props.confirmDisabled}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
