"use client";

import { useEffect, useRef } from "react";
import { useEditor, type Editor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import { ENABLED_INPUT_RULES, buildBlockEditorExtensions } from "../lib/block-editor";
import { docToMarkdown, markdownToDoc } from "../lib/markdown";
import { DocAssetImage } from "../lib/doc-assets";
import { setTimestampMode, type TimestampMode } from "../lib/timestamps";

function toContent(markdown: string, timestampMode: TimestampMode): JSONContent {
  return markdownToDoc(markdown, timestampMode !== null).toJSON() as JSONContent;
}

/**
 * 文書の TipTap（Notion のようなブロックのエディタ。描くのは BlockEditor）。値は Markdown で受け渡す。
 * `documentKey`（案件・工程・版）が変わったときと、外から値が変わったときだけ中身を差し替える（自分の編集では差し替えない）。
 */
export function useDocEditor(props: {
  documentKey: string;
  markdown: string;
  editable: boolean;
  timestampMode?: TimestampMode;
  onChange: (markdown: string) => void;
  resolveAsset?: (name: string) => Promise<string>;
}): Editor | null {
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const resolveAssetRef = useRef(props.resolveAsset);
  resolveAssetRef.current = props.resolveAsset;
  const lastValueRef = useRef(props.markdown);
  const lastKeyRef = useRef(props.documentKey);
  const editor = useEditor({
    extensions: buildBlockEditorExtensions().map((extension) => extension.name === "docAssetImage" ? DocAssetImage.configure({ resolve: (name) => resolveAssetRef.current?.(name) ?? Promise.reject(new Error("image unavailable")) }) : extension),
    enableInputRules: ENABLED_INPUT_RULES,
    content: toContent(props.markdown, props.timestampMode ?? null),
    editable: props.editable,
    editorProps: { attributes: { class: "doc", "aria-label": "文書" } },
    onUpdate: ({ editor: current }) => {
      const markdown = docToMarkdown(current.state.doc);
      lastValueRef.current = markdown;
      onChangeRef.current(markdown);
    },
  });

  useEffect(() => {
    editor?.setEditable(props.editable, false);
  }, [editor, props.editable]);

  useEffect(() => {
    if (editor) setTimestampMode(editor, props.timestampMode ?? null);
  }, [editor, props.timestampMode]);

  useEffect(() => {
    if (!editor) return;
    const keyChanged = props.documentKey !== lastKeyRef.current;
    if (!keyChanged && props.markdown === lastValueRef.current) return;
    editor.commands.setContent(toContent(props.markdown, props.timestampMode ?? null), { emitUpdate: false });
    lastValueRef.current = props.markdown;
    lastKeyRef.current = props.documentKey;
  }, [editor, props.markdown, props.documentKey, props.timestampMode]);

  return editor;
}
