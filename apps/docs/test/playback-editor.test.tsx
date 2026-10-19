// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockEditor } from "../src/components/BlockEditor";
import { useDocEditor } from "../src/components/useDocEditor";
import { docToMarkdown } from "../src/lib/markdown";
import { setTimestampMode, setTimestampPlaybackState, setTimestampSeekHandler } from "../src/lib/timestamps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Array<{ root: Root; container: HTMLDivElement }> = [];
afterEach(() => {
  for (const item of roots) {
    act(() => item.root.unmount());
    item.container.remove();
  }
  roots = [];
});

function Harness(props: { onEditor: (editor: Editor) => void; onDraftChange: (markdown: string) => void }) {
  const editor = useDocEditor({
    documentKey: "timestamp-playback",
    markdown: "[00:00:05] 一つ目\n\n[00:00:12] 二つ目\n",
    editable: true,
    timestampMode: "hidden",
    onChange: props.onDraftChange,
  });
  useEffect(() => { if (editor) props.onEditor(editor); }, [editor, props]);
  return <BlockEditor editor={editor} />;
}

describe("再生状態の ProseMirror meta", () => {
  it("現在段落とseek余白を描いても serialization と onDraftChange を変えない", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    const onDraftChange = vi.fn();
    let editor: Editor | null = null;
    await act(async () => root.render(<Harness onEditor={(value) => { editor = value; }} onDraftChange={onDraftChange} />));
    await act(async () => Promise.resolve());
    expect(editor).not.toBeNull();
    const transactions: boolean[] = [];
    editor!.on("transaction", ({ transaction }) => transactions.push(transaction.docChanged));
    const seek = vi.fn();
    setTimestampSeekHandler(editor!, seek);

    await act(async () => setTimestampPlaybackState(editor!, { positionSec: 13, playing: true, follow: false }));
    expect(transactions.at(-1)).toBe(false);
    expect(container.querySelectorAll(".transcript-playback-current")).toHaveLength(1);
    expect(container.querySelector(".transcript-playback-current")?.textContent).toContain("二つ目");
    expect(docToMarkdown(editor!.state.doc)).toBe("[00:00:05] 一つ目\n\n[00:00:12] 二つ目");
    expect(onDraftChange).not.toHaveBeenCalled();

    const gutters = container.querySelectorAll<HTMLElement>(".transcript-seek-gutter");
    expect(gutters).toHaveLength(2);
    await act(async () => gutters[0]!.click());
    expect(seek).toHaveBeenCalledWith(5);
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(docToMarkdown(editor!.state.doc)).toBe("[00:00:05] 一つ目\n\n[00:00:12] 二つ目");

    await act(async () => setTimestampMode(editor!, "shown"));
    expect(container.querySelector(".transcript-seek-gutter")).toBeNull();
    const timestamp = container.querySelector<HTMLElement>(".transcript-timestamp")!;
    expect(timestamp.getAttribute("aria-label")).toBe("[00:00:05]から頭出し");
    await act(async () => timestamp.click());
    expect(seek).toHaveBeenLastCalledWith(5);
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(docToMarkdown(editor!.state.doc)).toBe("[00:00:05] 一つ目\n\n[00:00:12] 二つ目");
  });
});
