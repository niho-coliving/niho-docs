"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ABOUT_TEXT_EXAMPLE, ABOUT_TEXT_LABEL, aboutError, type About } from "@niho/docs-core";
import { isCommandError } from "../lib/bridge";

/** 入力が止まってから保存するまでの間（ms）。欄から離れたときは待たずに保存する。 */
export const ABOUT_SAVE_DELAY_MS = 800;

export type AboutSaveState = { dirty: boolean; saving: boolean };

function sameAbout(left: About, right: About): boolean {
  return left.name === right.name && left.text === right.text;
}

/**
 * 設定の先頭のカード「あなたについて」（spec §5.3c・モック v1）。呼び名（1 行）とパーソナライズ（2,000 字まで）を、入力をやめたら
 * 保存する（保存ボタンは無い）。実行中でも書ける。上限を超えているあいだは理由を出して保存しない。
 * `about` は開いた時点の保存済みの内容。保存先を変えて読み直したときは、親が key を変えて開き直す。
 */
export function AboutCard(props: {
  about: About;
  onSave: (about: About) => Promise<void>;
  onStateChange?: (state: AboutSaveState) => void;
  onRegisterDiscard?: (discard: () => void) => void;
  onRegisterFlush?: (flush: () => Promise<boolean>) => void;
}) {
  const [draft, setDraft] = useState<About>(props.about);
  const [failure, setFailure] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const nameId = useId();
  const textId = useId();
  const helpId = useId();
  const errorId = useId();
  const draftRef = useRef(draft);
  /** 最後に書き込みが成功した内容。画面を離れる判断と「破棄」に使う。 */
  const confirmedRef = useRef(props.about);
  const savingRef = useRef(false);
  const inFlightRef = useRef<About | null>(null);
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  const drainRef = useRef<Promise<boolean> | null>(null);
  const timerRef = useRef<number | null>(null);
  const onSaveRef = useRef(props.onSave);
  onSaveRef.current = props.onSave;
  const onStateChangeRef = useRef(props.onStateChange);
  onStateChangeRef.current = props.onStateChange;
  const onRegisterDiscardRef = useRef(props.onRegisterDiscard);
  onRegisterDiscardRef.current = props.onRegisterDiscard;
  const onRegisterFlushRef = useRef(props.onRegisterFlush);
  onRegisterFlushRef.current = props.onRegisterFlush;

  const reportState = (next: About, saving = savingRef.current) => {
    const pendingDifferentValue = saving && inFlightRef.current !== null && !sameAbout(next, inFlightRef.current);
    onStateChangeRef.current?.({ dirty: !sameAbout(next, confirmedRef.current) || pendingDifferentValue, saving });
  };

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  /** 書きかけを保存する（上限を超えている・変えていなければ何もしない）。 */
  const flush = useCallback((): Promise<boolean> => {
    clearTimer();
    if (drainRef.current) return drainRef.current;
    const task = (async () => {
      while (true) {
        const next = draftRef.current;
        if (sameAbout(next, confirmedRef.current)) return true;
        if (aboutError(next)) return false;
        savingRef.current = true;
        inFlightRef.current = next;
        setSaveState("saving");
        reportState(next, true);
        let errorMessage: string | null = null;
        try {
          await onSaveRef.current(next);
          confirmedRef.current = next;
        } catch (error) {
          errorMessage = isCommandError(error) ? `保存できませんでした。${error.message}` : "保存できませんでした。";
        } finally {
          savingRef.current = false;
          inFlightRef.current = null;
        }
        const latest = draftRef.current;
        if (errorMessage && sameAbout(latest, next)) {
          setFailure(errorMessage);
          setSaveState("idle");
          reportState(latest, false);
          return false;
        }
        if (errorMessage) setFailure(null);
        else setFailure(null);
        if (sameAbout(latest, confirmedRef.current)) {
          setSaveState(errorMessage ? "idle" : "saved");
          reportState(latest, false);
          return !errorMessage;
        }
        setSaveState("idle");
        reportState(latest, false);
      }
    })();
    drainRef.current = task;
    void task.finally(() => {
      if (drainRef.current === task) drainRef.current = null;
    });
    return task;
  }, [clearTimer]);
  flushRef.current = flush;

  const flushBeforeLeave = useCallback(async () => {
    const saved = await flushRef.current();
    return saved && sameAbout(draftRef.current, confirmedRef.current);
  }, []);

  const change = (next: About) => {
    draftRef.current = next;
    setDraft(next);
    clearTimer();
    setFailure(null);
    if (savingRef.current || drainRef.current) {
      setSaveState("idle");
      reportState(next, true);
      return;
    }
    if (sameAbout(next, confirmedRef.current)) {
      setSaveState("idle");
      reportState(next, false);
      return;
    }
    setSaveState("idle");
    reportState(next, false);
    if (aboutError(next)) return;
    timerRef.current = window.setTimeout(() => void flushRef.current(), ABOUT_SAVE_DELAY_MS);
  };

  const discard = useCallback(() => {
    clearTimer();
    const confirmed = confirmedRef.current;
    draftRef.current = confirmed;
    setDraft(confirmed);
    setFailure(null);
    setSaveState("idle");
    reportState(confirmed, false);
  }, [clearTimer]);

  useEffect(() => {
    onRegisterDiscardRef.current?.(discard);
    return () => onRegisterDiscardRef.current?.(() => undefined);
  }, [discard]);

  useEffect(() => {
    onRegisterFlushRef.current?.(flushBeforeLeave);
    return () => onRegisterFlushRef.current?.(async () => true);
  }, [flushBeforeLeave]);

  // 画面を離れるときは親の確認を通す。確認後の破棄を保存し直さないよう、ここでは自動 flush しない。
  useEffect(
    () => () => {
      clearTimer();
    },
    [clearTimer],
  );

  const overLimit = aboutError(draft);
  return (
    <div className="card">
      <div className="ch">
        <h2>あなたについて</h2>
      </div>
      <div className="cb about">
        <div className="fld">
          <label htmlFor={nameId}>呼び名</label>
          <input
            id={nameId}
            className="inp name"
            value={draft.name}
            placeholder="例: 佐藤"
            aria-describedby={helpId}
            // 呼び名は 1 行（貼り付けた改行は空白にする）
            onChange={(event) => change({ ...draftRef.current, name: event.target.value.replace(/[\r\n]+/g, " ") })}
            onBlur={() => void flushRef.current()}
          />
        </div>
        <div className="fld">
          <label htmlFor={textId}>{ABOUT_TEXT_LABEL}</label>
          <textarea
            id={textId}
            className="ta"
            rows={6}
            value={draft.text}
            placeholder={ABOUT_TEXT_EXAMPLE}
            aria-describedby={overLimit ? `${errorId} ${helpId}` : helpId}
            aria-invalid={overLimit ? true : undefined}
            onChange={(event) => change({ ...draftRef.current, text: event.target.value })}
            onBlur={() => void flushRef.current()}
          />
          {overLimit && (
            <p id={errorId} className="err" role="alert">
              {overLimit}
            </p>
          )}
        </div>
        {failure && (
          <div className="about-save-error">
            <p className="err" role="alert">
              {failure}
            </p>
            <button type="button" className="btn outline sm" onClick={() => void flushRef.current()}>
              もう一度
            </button>
          </div>
        )}
        <div className="about-save-status">
          <p id={helpId} className="help">
            すべての録音の工程と「AIと作る」に添えます。
          </p>
          {saveState === "saving" && <span role="status">保存しています…</span>}
          {saveState === "saved" && <span role="status">保存しました</span>}
        </div>
      </div>
    </div>
  );
}
