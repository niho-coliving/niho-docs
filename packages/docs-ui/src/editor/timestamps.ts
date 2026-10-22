import { Node as TiptapNode, mergeAttributes, type Editor } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { TIMESTAMP_PREFIX } from "@niho/docs-core";

/*
 * 文字起こしの時刻（最上位の段落の先頭の `[hh:mm:ss] `）を持つ node と、表示の切り替え・再生位置・頭出しの plugin。
 * schema に入れるのは createDocsMarkdown({ transcriptTimestamps: true }) のとき（Mac と Web の時刻付きページ。#18876）。
 */

export const TRANSCRIPT_TIMESTAMP_NODE = "transcriptTimestamp";

export type TimestampPrefix = { prefix: string; label: string; seconds: number };

export function timestampSeconds(label: string): number | null {
  const match = /^\[(\d+):([0-5]\d):([0-5]\d)]$/.exec(label);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/** 正本が作る、段落先頭の `[hh:mm:ss] ` だけを認識する。 */
export function timestampPrefix(text: string): TimestampPrefix | null {
  const prefix = TIMESTAMP_PREFIX.exec(text)?.[0];
  if (!prefix) return null;
  const label = prefix.slice(0, -1);
  const seconds = timestampSeconds(label);
  return seconds === null ? null : { prefix, label, seconds };
}

function mapTimestampNodes(fragment: Fragment, asText = false): Fragment {
  const children: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.type.name === TRANSCRIPT_TIMESTAMP_NODE) {
      if (asText) children.push(node.type.schema.text(node.attrs.prefix as string));
      return;
    }
    children.push(node.childCount > 0 ? node.copy(mapTimestampNodes(node.content, asText)) : node);
  });
  return Fragment.fromArray(children);
}

function normalizeParagraphTimestamp(node: ProseMirrorNode): ProseMirrorNode {
  if (node.type.name !== "paragraph") return node;
  let leadingText = "";
  for (let index = 0; index < node.childCount && leadingText.length < 128; index++) {
    const child = node.child(index);
    if (!child.isText) break;
    leadingText += child.text!.slice(0, 128 - leadingText.length);
  }
  const found = timestampPrefix(leadingText);
  if (!found) return node;

  const content: ProseMirrorNode[] = [];
  let remaining = found.prefix.length;
  node.content.forEach((child) => {
    if (remaining > 0 && child.isText) {
      const consumed = Math.min(remaining, child.text!.length);
      remaining -= consumed;
      if (consumed < child.text!.length) content.push(child.cut(consumed));
    } else {
      content.push(child);
    }
  });
  const timestampType = node.type.schema.nodes[TRANSCRIPT_TIMESTAMP_NODE];
  if (!timestampType) return node;
  content.unshift(timestampType.create(found));
  return node.copy(Fragment.fromArray(content));
}

/**
 * 時刻 node を使わず編集中だった本文が時刻付き成果物へ変わったとき、既存の段落を node 化する。
 * transaction で置き換えるため、保存後の選択位置も変更に合わせて移動する。
 */
export function normalizeTranscriptTimestamps(editor: Editor): void {
  const state = editor.state;
  const replacements: Array<{ from: number; to: number; node: ProseMirrorNode }> = [];
  state.doc.descendants((node, position) => {
    const normalized = normalizeParagraphTimestamp(node);
    if (normalized === node) return;
    const timestamp = normalized.firstChild;
    const prefix = typeof timestamp?.attrs.prefix === "string" ? timestamp.attrs.prefix : "";
    if (timestamp?.type.name === TRANSCRIPT_TIMESTAMP_NODE && prefix) {
      replacements.push({ from: position + 1, to: position + 1 + prefix.length, node: timestamp });
    }
  });
  if (replacements.length === 0) return;
  const transaction = state.tr;
  for (const replacement of replacements.reverse()) {
    transaction.replaceWith(replacement.from, replacement.to, replacement.node);
  }
  editor.view.dispatch(transaction);
}

function normalizePastedTimestamps(fragment: Fragment): Fragment {
  const children: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    const content = node.childCount > 0 ? normalizePastedTimestamps(node.content) : node.content;
    const copied = node.childCount > 0 ? node.copy(content) : node;
    children.push(normalizeParagraphTimestamp(copied));
  });
  return Fragment.fromArray(children);
}

const timestampModeKey = new PluginKey<TimestampMode>("transcriptTimestampMode");
const timestampPlaybackKey = new PluginKey<TimestampPlaybackPluginState>("transcriptTimestampPlayback");
export type TimestampMode = "shown" | "hidden" | null;
export type TimestampPlaybackState = { positionSec: number | null; playing: boolean; follow: boolean };
type TimestampPlaybackPluginState = TimestampPlaybackState & { decorations: DecorationSet; activeSeconds: number | null };
const playbackHandlers = new WeakMap<Editor, (second: number) => void>();

function timestampMode(editor: Editor): TimestampMode {
  return timestampModeKey.getState(editor.state) ?? null;
}

export function setTimestampMode(editor: Editor, mode: TimestampMode): void {
  if (timestampMode(editor) !== mode) editor.view.dispatch(editor.state.tr.setMeta(timestampModeKey, mode));
}

export function setTimestampSeekHandler(editor: Editor, handler: ((second: number) => void) | null): void {
  if (handler) playbackHandlers.set(editor, handler);
  else playbackHandlers.delete(editor);
}

export function setTimestampPlaybackState(editor: Editor, state: TimestampPlaybackState): void {
  const previous = timestampPlaybackKey.getState(editor.state);
  if (previous && previous.positionSec === state.positionSec && previous.playing === state.playing && previous.follow === state.follow) return;
  editor.view.dispatch(editor.state.tr.setMeta(timestampPlaybackKey, state));
}

function timestampParagraphs(doc: ProseMirrorNode): Array<{ from: number; to: number; seconds: number; label: string }> {
  const found: Array<{ from: number; to: number; seconds: number; label: string }> = [];
  doc.descendants((node, position) => {
    if (node.type.name !== "paragraph" || node.firstChild?.type.name !== TRANSCRIPT_TIMESTAMP_NODE) return;
    const label = typeof node.firstChild.attrs.label === "string" ? node.firstChild.attrs.label : "";
    const seconds = typeof node.firstChild.attrs.seconds === "number" ? node.firstChild.attrs.seconds : timestampSeconds(label);
    if (seconds !== null) found.push({ from: position, to: position + node.nodeSize, seconds, label });
  });
  return found;
}

export function activeTimestampSecond(timestamps: readonly number[], positionSec: number): number | null {
  let active: number | null = null;
  for (const timestamp of timestamps) {
    if (timestamp <= positionSec && (active === null || timestamp > active)) active = timestamp;
  }
  return active;
}

function playbackDecorations(
  doc: ProseMirrorNode,
  playback: TimestampPlaybackState,
  mode: TimestampMode,
  seekEnabled: boolean,
): { decorations: DecorationSet; activeSeconds: number | null } {
  const paragraphs = timestampParagraphs(doc);
  const active = playback.positionSec === null ? null : activeTimestampSecond(paragraphs.map((item) => item.seconds), playback.positionSec);
  const decorations: Decoration[] = [];
  for (const paragraph of paragraphs) {
    decorations.push(Decoration.node(paragraph.from, paragraph.to, {
      class: `transcript-timed-paragraph${paragraph.seconds === active ? " transcript-playback-current" : ""}`,
    }));
    if (mode === "hidden" && seekEnabled) {
      decorations.push(Decoration.widget(paragraph.from + 1, () => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "transcript-seek-gutter";
        button.dataset.transcriptSeekSeconds = String(paragraph.seconds);
        button.setAttribute("aria-label", `${paragraph.label}から頭出し`);
        button.title = `${paragraph.label}から頭出し`;
        button.contentEditable = "false";
        return button;
      }, { side: -1, ignoreSelection: true }));
    }
  }
  return { decorations: DecorationSet.create(doc, decorations), activeSeconds: active };
}

function seekSecondsFromEvent(event: Event): number | null {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-transcript-seek-seconds]") : null;
  if (!target) return null;
  const second = Number(target.dataset.transcriptSeekSeconds);
  return Number.isFinite(second) && second >= 0 ? second : null;
}

/**
 * 正本の時刻を文字列から切り離して保持する atom。非表示でも editor state には残り、保存時は同じ接頭辞へ戻る。
 */
export const TranscriptTimestamp = TiptapNode.create<{ seekEnabled: boolean }>({
  name: TRANSCRIPT_TIMESTAMP_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  marks: "",

  addOptions() { return { seekEnabled: true }; },

  addAttributes() {
    return {
      prefix: { default: "[00:00:00] ", rendered: false },
      label: { default: "[00:00:00]", rendered: false },
      seconds: { default: 0, rendered: false },
    };
  },

  parseHTML() {
    return [{
      tag: "span[data-transcript-timestamp]",
      getAttrs: (element) => {
        const text = element.textContent ?? "";
        const found = timestampPrefix(text);
        return found && text === found.prefix ? found : false;
      },
    }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const prefix = typeof node.attrs.prefix === "string" ? node.attrs.prefix : "";
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: "transcript-timestamp",
        "data-transcript-timestamp": "true",
        contenteditable: "false",
        ...(this.options.seekEnabled ? {
          "data-transcript-seek-seconds": String(node.attrs.seconds),
          role: "button",
          tabindex: "0",
          "aria-label": `${String(node.attrs.label)}から頭出し`,
        } : {}),
      }),
      prefix,
    ];
  },

  renderText({ node }) {
    return typeof node.attrs.prefix === "string" ? node.attrs.prefix : "";
  },

  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        if (timestampMode(this.editor) === null) return false;
        const { selection } = this.editor.state;
        if (!(selection instanceof TextSelection) || !selection.empty || selection.$from.parentOffset !== 1) return false;
        return selection.$from.parent.firstChild?.type.name === TRANSCRIPT_TIMESTAMP_NODE;
      },
      Delete: () => {
        if (timestampMode(this.editor) === null) return false;
        const { selection } = this.editor.state;
        if (!(selection instanceof TextSelection) || !selection.empty) return false;
        const $from = selection.$from;
        if ($from.parent.type.name !== "paragraph" || $from.parentOffset !== $from.parent.content.size) return false;
        const next = $from.doc.nodeAt($from.after($from.depth));
        return next?.type.name === "paragraph" && next.firstChild?.type.name === TRANSCRIPT_TIMESTAMP_NODE;
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<TimestampMode>({
        key: timestampModeKey,
        state: {
          init: () => null,
          apply: (transaction, previous) => {
            const next = transaction.getMeta(timestampModeKey);
            return next === "shown" || next === "hidden" || next === null ? next : previous;
          },
        },
        appendTransaction: (_transactions, _oldState, state) => {
          if (timestampModeKey.getState(state) === null) return null;
          const { selection } = state;
          if (!(selection instanceof TextSelection) || !selection.empty || selection.$from.parentOffset !== 0) return null;
          if (selection.$from.parent.firstChild?.type.name !== TRANSCRIPT_TIMESTAMP_NODE) return null;
          return state.tr.setSelection(TextSelection.create(state.doc, selection.from + 1));
        },
        props: {
          attributes: (state) => {
            const mode = timestampModeKey.getState(state);
            return mode ? { class: mode === "shown" ? "timestamps-on" : "timestamps-off" } : { class: "" };
          },
          transformCopied: (slice, view) => {
            if (timestampModeKey.getState(view.state) !== "hidden") return slice;
            return new Slice(mapTimestampNodes(slice.content), slice.openStart, slice.openEnd);
          },
          transformPasted: (slice, view) => {
            const mode = timestampModeKey.getState(view.state);
            const content = mode === null
              ? mapTimestampNodes(slice.content, true)
              : normalizePastedTimestamps(slice.content);
            return new Slice(content, slice.openStart, slice.openEnd);
          },
        },
      }),
      new Plugin<TimestampPlaybackPluginState>({
        key: timestampPlaybackKey,
        state: {
          init: (_config, state) => ({
            positionSec: null,
            playing: false,
            follow: true,
            decorations: DecorationSet.empty,
            activeSeconds: null,
          }),
          apply: (transaction, previous, _oldState, newState) => {
            const meta = transaction.getMeta(timestampPlaybackKey) as TimestampPlaybackState | undefined;
            const playback = meta ?? previous;
            const modeChanged = transaction.getMeta(timestampModeKey) !== undefined;
            if (!transaction.docChanged && !meta && !modeChanged) {
              return { ...previous, decorations: previous.decorations.map(transaction.mapping, transaction.doc) };
            }
            const decorated = playbackDecorations(transaction.doc, playback, timestampModeKey.getState(newState) ?? null, this.options.seekEnabled);
            return { positionSec: playback.positionSec, playing: playback.playing, follow: playback.follow, ...decorated };
          },
        },
        view: (view) => {
          let scrolled: number | null = null;
          return {
            update: (next) => {
              const playback = timestampPlaybackKey.getState(next.state);
              if (!playback?.playing || !playback.follow || playback.activeSeconds === null) {
                scrolled = null;
                return;
              }
              if (scrolled === playback.activeSeconds) return;
              scrolled = playback.activeSeconds;
              requestAnimationFrame(() => {
                next.dom.querySelector<HTMLElement>(".transcript-playback-current")?.scrollIntoView?.({ block: "nearest" });
              });
            },
          };
        },
        props: {
          decorations: (state) => timestampPlaybackKey.getState(state)?.decorations ?? null,
          handleDOMEvents: {
            mousedown: (_view, event) => {
              if (seekSecondsFromEvent(event) === null) return false;
              event.preventDefault();
              return true;
            },
            click: (_view, event) => {
              const seconds = seekSecondsFromEvent(event);
              if (seconds === null) return false;
              playbackHandlers.get(this.editor)?.(seconds);
              event.preventDefault();
              return true;
            },
            keydown: (_view, event) => {
              if (event.key !== "Enter" && event.key !== " ") return false;
              const seconds = seekSecondsFromEvent(event);
              if (seconds === null) return false;
              playbackHandlers.get(this.editor)?.(seconds);
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ];
  },
});
