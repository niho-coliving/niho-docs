"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  TRANSCRIPT_SPEAKER_NAME_MAX_CHARS,
  resolveTranscriptSpeakerName,
  type TranscriptSpeakerEntry,
} from "@niho/docs-core";
import { usePopover } from "./usePopover";

function speakerDescription(speaker: TranscriptSpeakerEntry): string {
  return speaker.partIndex === null ? speaker.label : `Part ${speaker.partIndex}の${speaker.label}`;
}

function isImeEnter(event: ReactKeyboardEvent<HTMLInputElement>): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

function SpeakerPill(props: {
  speaker: TranscriptSpeakerEntry;
  speakers: readonly TranscriptSpeakerEntry[];
  candidates: readonly string[];
  disabled: boolean;
  onRename: (speaker: TranscriptSpeakerEntry, name: string | null) => void;
}) {
  const popover = usePopover<HTMLSpanElement>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [inputOpen, setInputOpen] = useState(false);
  const [input, setInput] = useState("");
  const validName = resolveTranscriptSpeakerName({ name: input, speaker: props.speaker, speakers: props.speakers });
  const close = (restoreFocus = false) => {
    popover.setOpen(false);
    setInputOpen(false);
    setInput("");
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  };
  const choose = (name: string | null) => {
    close(true);
    if (name !== props.speaker.name) props.onRename(props.speaker, name);
  };

  useEffect(() => {
    if (!popover.open) {
      setInputOpen(false);
      setInput("");
    }
  }, [popover.open]);

  return (
    <span
      ref={popover.ref}
      className="speaker-pill-wrap"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !popover.open) return;
        event.stopPropagation();
        close(true);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`speaker-pill${props.speaker.name ? " named" : ""}`}
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={popover.open}
        aria-label={`${speakerDescription(props.speaker)}の名前`}
        onClick={popover.toggle}
      >
        <span className="speaker-number" aria-hidden="true">{props.speaker.index}</span>
        <span className="speaker-label">{props.speaker.label}</span>
        <span className="speaker-caret" aria-hidden="true">⌄</span>
      </button>
      {popover.open && (
        <div className="pop speaker-menu" role="menu" aria-label={`${speakerDescription(props.speaker)}の名前`}>
          {props.candidates.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="menuitem"
              className={`mi${candidate === props.speaker.name ? " on" : ""}`}
              disabled={resolveTranscriptSpeakerName({ name: candidate, speaker: props.speaker, speakers: props.speakers }) === null}
              onClick={() => choose(candidate)}
            >
              {candidate}
            </button>
          ))}
          {props.candidates.length > 0 && <div className="speaker-separator" aria-hidden="true" />}
          {inputOpen ? (
            <div className="speaker-input-row">
              <input
                autoFocus
                className="inp"
                aria-label="名前"
                maxLength={TRANSCRIPT_SPEAKER_NAME_MAX_CHARS}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || isImeEnter(event)) return;
                  event.preventDefault();
                  if (validName) choose(validName);
                }}
              />
              <button type="button" className="btn primary" disabled={!validName} onClick={() => validName && choose(validName)}>
                付ける
              </button>
            </div>
          ) : (
            <button type="button" role="menuitem" className="mi" onClick={() => setInputOpen(true)}>
              入力…
            </button>
          )}
          {props.speaker.name && (
            <button type="button" role="menuitem" className="mi" onClick={() => choose(null)}>
              名前を外す
            </button>
          )}
        </div>
      )}
    </span>
  );
}

export function TranscriptSpeakerRow(props: {
  speakers: readonly TranscriptSpeakerEntry[];
  candidates: readonly string[];
  disabled: boolean;
  pending: boolean;
  unavailableReason?: string | null;
  onRename: (speaker: TranscriptSpeakerEntry, name: string | null) => void;
}) {
  const parts = useMemo(() => [...new Set(props.speakers.map((speaker) => speaker.partIndex))], [props.speakers]);
  if (props.speakers.length === 0) return null;
  if (props.unavailableReason) return <p className="speaker-unavailable">{props.unavailableReason}</p>;
  return (
    <div className="speaker-row" role="group" aria-label="話者">
      {parts.map((partIndex) => (
        <div key={partIndex ?? "none"} className="speaker-part" role="group" aria-label={partIndex === null ? "話者" : `Part ${partIndex}の話者`}>
          {partIndex !== null && <span className="speaker-part-label">Part {partIndex}</span>}
          {props.speakers
            .filter((speaker) => speaker.partIndex === partIndex)
            .map((speaker) => (
              <SpeakerPill
                key={speaker.key}
                speaker={speaker}
                speakers={props.speakers}
                candidates={props.candidates}
                disabled={props.disabled || props.pending}
                onRename={props.onRename}
              />
            ))}
        </div>
      ))}
      {props.pending && <span className="speaker-pending"><span className="spin" aria-hidden="true" />保存中</span>}
    </div>
  );
}
