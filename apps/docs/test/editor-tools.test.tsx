// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import { findNext } from "prosemirror-search";
import { afterEach, expect, it, vi } from "vitest";
import { EditorTools, type EditorToolControls } from "../src/components/EditorTools";
import { BlockEditor } from "../src/components/BlockEditor";
import { useDocEditor } from "../src/components/useDocEditor";
import { FakeBridge } from "./fake-bridge";
import { docToMarkdown } from "../src/lib/markdown";
import { markdownSchema } from "../src/lib/markdown";
import type { ProjectId } from "../src/lib/bridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom の Range には座標が無い（画像の挿入やリンクで本文へ戻すときの scrollIntoView が読む）。0 の矩形を返す
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return new DOMRect(0, 0, 0, 0);
  };
}
const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

/**
 * 検索・書式の入口は App のタイトルバーの ⋯ と ⌘F（owner 2026-10-18・#18941）。ここでは EditorTools が渡す入口を、前と同じ名前の
 * ボタン（「検索を開く」「書式を表示」）にして押す。
 */
function Harness(props: { bridge: FakeBridge; onEditor: (editor: Editor | null) => void; showTools?: boolean; projectId?: ProjectId }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [controls, setControls] = useState<EditorToolControls | null>(null);
  const projectId = props.projectId === undefined ? "project" : props.projectId;
  const editor = useDocEditor({ documentKey: "search", markdown: "cat cat cat\n", editable: true, onChange: () => undefined,
    resolveAsset: (name) => props.bridge.readImageAsset(projectId, name) });
  useEffect(() => props.onEditor(editor), [editor, props.onEditor]);
  return <>
    <div className="pmeta">{props.showTools !== false && <EditorTools editor={editor} bridge={props.bridge} projectId={projectId} panelHost={host} onError={() => undefined} onControls={setControls} />}</div>
    {controls && <div className="menu">
      <button type="button" aria-label="検索を開く" disabled={!controls.available} onClick={controls.openSearch}>検索</button>
      <button type="button" aria-label={controls.toolbarOpen ? "書式を閉じる" : "書式を表示"} disabled={!controls.available} onClick={controls.toggleToolbar}>書式</button>
    </div>}
    <div ref={setHost} />
    <BlockEditor editor={editor} />
  </>;
}

afterEach(() => {
  for (const item of mounted) {
    act(() => item.root.unmount());
    item.container.remove();
  }
  mounted.length = 0;
});

it("選んだ案件画像を本文に参照として挿入し、保存済みの写真を表示する", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  let editor: Editor | null = null;
  const bridge = new FakeBridge();
  bridge.pickImageAsset = async () => "abc123.png";
  bridge.readImageAsset = async () => "data:image/png;base64,aGVsbG8=";
  await act(async () => root.render(<Harness bridge={bridge} onEditor={(value) => { editor = value; }} />));
  // メタ行の右端には 🔍・Aa を出さない（入口はタイトルバーの ⋯ と ⌘F。owner 2026-10-18・#18941）
  expect(container.querySelector(".pmeta")?.childElementCount).toBe(0);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="書式を表示"]')!.click());
  expect(container.querySelector('button[aria-label="書式を閉じる"]')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="画像を追加"]')!.click());
  expect(docToMarkdown(editor!.state.doc)).toContain("![写真](niho-docs-asset:abc123.png)");
  expect(container.querySelector<HTMLImageElement>('img[data-doc-asset="abc123.png"]')?.src).toBe("data:image/png;base64,aGVsbG8=");
});

it("画像選択中に保存が始まった場合は確定中の本文を変更しない", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  let editor: Editor | null = null;
  let resolveImage!: (name: string) => void;
  const bridge = new FakeBridge();
  bridge.pickImageAsset = () => new Promise<string>((resolve) => { resolveImage = resolve; });
  await act(async () => root.render(<Harness bridge={bridge} onEditor={(value) => { editor = value; }} />));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="書式を表示"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="画像を追加"]')!.click());
  const beforeSave = editor!.state.doc;
  await act(async () => editor!.setEditable(false));
  await act(async () => resolveImage("abc123.png"));
  expect(editor!.state.doc.eq(beforeSave)).toBe(true);
});

it("フォルダ外ページの画像も保存先直下から選んで表示する", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  let editor: Editor | null = null;
  const bridge = new FakeBridge();
  let pickedFor: ProjectId | undefined;
  let readFor: ProjectId | undefined;
  bridge.pickImageAsset = async (projectId) => { pickedFor = projectId; return "outside.png"; };
  bridge.readImageAsset = async (projectId) => { readFor = projectId; return "data:image/png;base64,aGVsbG8="; };
  await act(async () => root.render(<Harness bridge={bridge} projectId={null} onEditor={(value) => { editor = value; }} />));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="書式を表示"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="画像を追加"]')!.click());
  expect(pickedFor).toBeNull();
  expect(readFor).toBeNull();
  expect(docToMarkdown(editor!.state.doc)).toContain("![写真](niho-docs-asset:outside.png)");
  expect(container.querySelector<HTMLImageElement>('img[data-doc-asset="outside.png"]')?.src).toBe("data:image/png;base64,aGVsbG8=");
});

it("リンクはブラウザの prompt ではなくアプリ内のダイアログで聞き、空にして確定すると外す", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  let editor: Editor | null = null;
  const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
  const bridge = new FakeBridge();
  await act(async () => root.render(<Harness bridge={bridge} onEditor={(value) => { editor = value; }} />));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="書式を表示"]')!.click());
  const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
  const dialogButton = (name: string) => [...dialog()!.querySelectorAll("button")].find((item) => item.textContent === name)!;
  const input = () => dialog()!.querySelector<HTMLInputElement>('input[type="url"]')!;
  const setValue = async (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const afterClose = () => act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));

  await act(async () => editor!.commands.setTextSelection({ from: 1, to: 4 }));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="リンク"]')!.click());
  expect(dialog()?.querySelector("h2")?.textContent).toBe("リンクを追加");
  expect(document.activeElement).toBe(input());
  expect(dialogButton("追加する").disabled).toBe(true);
  await setValue(" https://niho.life ");
  await act(async () => dialogButton("追加する").click());
  await afterClose();
  expect(dialog()).toBeNull();
  expect(docToMarkdown(editor!.state.doc)).toContain("[cat](https://niho.life)");

  await act(async () => editor!.commands.setTextSelection(2));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="リンク"]')!.click());
  expect(dialog()?.querySelector("h2")?.textContent).toBe("リンクを編集");
  expect(input().value).toBe("https://niho.life");
  await setValue("");
  await act(async () => dialogButton("リンクを外す").click());
  await afterClose();
  expect(docToMarkdown(editor!.state.doc)).not.toContain("](https://niho.life)");
  expect(prompt).not.toHaveBeenCalled();
  prompt.mockRestore();
});

it("検索・文字列置換・一括置換の取り消しを本文の履歴に反映する", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  let editor: Editor | null = null;
  const bridge = new FakeBridge();
  await act(async () => root.render(<Harness bridge={bridge} onEditor={(value) => { editor = value; }} />));
  const button = (name: string) => {
    const found = [...container.querySelectorAll("button")].find((item) => item.textContent === name || item.getAttribute("aria-label") === name);
    if (!found) throw new Error(`missing button ${name}`);
    return found as HTMLButtonElement;
  };
  await act(async () => button("検索を開く").click());
  const search = container.querySelector<HTMLInputElement>('input[aria-label="検索語"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(search, "cat");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("3件");
  await act(async () => button("置換…").click());
  const replacement = container.querySelector<HTMLInputElement>('input[aria-label="置換後の文字"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(replacement, "$&.");
    replacement.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("すべて置換").click());
  expect(editor!.getText()).toBe("$&. $&. $&.");
  expect(container.textContent).toContain("3件を置換しました");
  await act(async () => button("元に戻す").click());
  expect(editor!.getText()).toBe("cat cat cat");
});

it("編集ツールを閉じると検索の状態も本文から解除する", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  let editor: Editor | null = null;
  const bridge = new FakeBridge();
  const render = (showTools: boolean) => root.render(<Harness bridge={bridge} showTools={showTools} onEditor={(value) => { editor = value; }} />);
  await act(async () => render(true));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="検索を開く"]')!.click());
  // 開いた検索の箱の語の欄へフォーカスする（⋯ の「検索」・⌘F と同じ入口）
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  expect(document.activeElement?.getAttribute("aria-label")).toBe("検索語");
  const search = container.querySelector<HTMLInputElement>('input[aria-label="検索語"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(search, "cat");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { findNext(editor!.state, editor!.view.dispatch); });
  const selectionBeforeClose = editor!.state.selection.from;
  await act(async () => render(false));
  await act(async () => { findNext(editor!.state, editor!.view.dispatch); });
  expect(editor!.state.selection.from).toBe(selectionBeforeClose);
  // 外れたら入口も外す（⋯ に検索・書式を残さない）
  expect(container.querySelector('button[aria-label="検索を開く"]')).toBeNull();
});

it("HTMLから貼り付けた案件画像の代替文字とタイトルを保つ", () => {
  const container = document.createElement("div");
  container.innerHTML = '<p><img data-doc-asset="abc123.png" alt="会話の写真" title="2026年の集まり"></p>';
  const doc = ProseMirrorDOMParser.fromSchema(markdownSchema).parse(container);
  expect(doc.firstChild?.firstChild?.attrs).toMatchObject({ name: "abc123.png", alt: "会話の写真", title: "2026年の集まり" });
});
