// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import { BlockEditor, PageTitle } from "../src/components/BlockEditor";
import { useDocEditor } from "../src/components/useDocEditor";
import { shouldShowFormatBar } from "../src/lib/block-editor/blocks";
import { listRows } from "../src/lib/block-editor/rows";
import { PARAGRAPH_HINT } from "../src/lib/block-editor/placeholder";
import { markdownToDoc } from "../src/lib/markdown";
import { cursorTo, cursorToEnd, flush, markdownOf, topTypes, typeText } from "./block-editor-helpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Screen = { container: HTMLDivElement; editor: Editor; root: Root };
let screens: Screen[] = [];

function Harness(props: { markdown: string; editable: boolean; withTitle: boolean; onEditor: (editor: Editor) => void }) {
  const [title, setTitle] = useState("");
  const editor = useDocEditor({ documentKey: "doc", markdown: props.markdown, editable: props.editable, onChange: () => undefined });
  const { onEditor } = props;
  useEffect(() => {
    if (editor) onEditor(editor);
  }, [editor, onEditor]);
  return (
    <>
      {props.withTitle && <PageTitle value={title} onChange={setTitle} editor={editor} />}
      <BlockEditor editor={editor} />
    </>
  );
}

async function render(markdown = "", options: { editable?: boolean; withTitle?: boolean } = {}): Promise<Screen> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let editor: Editor | null = null;
  await act(async () => {
    root.render(
      <Harness
        markdown={markdown}
        editable={options.editable ?? true}
        withTitle={options.withTitle ?? false}
        onEditor={(value) => {
          editor = value;
        }}
      />,
    );
  });
  await act(flush);
  if (!editor) throw new Error("editor not created");
  const screen = { container, editor, root };
  screens.push(screen);
  return screen;
}

afterEach(() => {
  for (const screen of screens) {
    act(() => screen.root.unmount());
    screen.container.remove();
  }
  screens = [];
});

async function type(editor: Editor, text: string) {
  await act(async () => {
    typeText(editor, text);
    await flush();
  });
}

/** エディタの DOM にキーを投げる（ProseMirror の keydown の処理を通す）。 */
async function key(editor: Editor, name: string) {
  await act(async () => {
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    await flush();
  });
}

function options(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
}

describe("「/」のメニュー（描画）", () => {
  it("「/」で出て、↓・Enter で決まる。Esc で閉じる", async () => {
    const { container, editor } = await render();
    await type(editor, "/");
    expect(container.querySelector(".be-slash .h")?.textContent).toBe("基本ブロック");
    expect(options(container).map((option) => option.textContent)).toEqual([
      "Aaテキスト",
      "H1見出し1#",
      "H2見出し2##",
      "H3見出し3###",
      "•箇条書き-",
      "1.番号付きリスト1.",
      "☐チェックボックス[]",
      "❝引用>",
      "</>コード```",
      "—区切り線---",
    ]);
    expect(options(container)[0]?.getAttribute("aria-selected")).toBe("true");
    await key(editor, "ArrowDown");
    await key(editor, "ArrowDown");
    expect(options(container)[2]?.getAttribute("aria-selected")).toBe("true");
    await key(editor, "ArrowUp");
    await key(editor, "Enter");
    expect(container.querySelector(".be-slash")).toBeNull();
    expect(editor.state.doc.firstChild?.type.name).toBe("heading");
    expect(editor.state.doc.firstChild?.attrs.level).toBe(1);

    await type(editor, "見出し");
    await key(editor, "Enter");
    await type(editor, "/");
    expect(options(container)).toHaveLength(10);
    await key(editor, "Escape");
    expect(container.querySelector(".be-slash")).toBeNull();
    // 端で回る
    await type(editor, "／");
    expect(options(container)).toHaveLength(10);
    await key(editor, "ArrowUp");
    expect(options(container)[9]?.getAttribute("aria-selected")).toBe("true");
  });

  it("絞り込み・クリックで決まる。空でない行は下に足す", async () => {
    const { container, editor } = await render("前の行");
    await act(async () => cursorToEnd(editor));
    await type(editor, "/いんよう");
    expect(options(container).map((option) => option.textContent)).toEqual(["❝引用>"]);
    await act(async () => {
      options(container)[0]!.click();
      await flush();
    });
    expect(container.querySelector(".be-slash")).toBeNull();
    await type(editor, "引用の文");
    expect(markdownOf(editor)).toBe("前の行\n\n> 引用の文\n");
  });

  it("0 件なら何も出さない", async () => {
    const { container, editor } = await render();
    await type(editor, "/zzz");
    expect(container.querySelector(".be-slash")).toBeNull();
  });
});

describe("行の ＋ ⋮⋮（描画）", () => {
  // jsdom は座標が 0 なので、行ごとに縦 30px の矩形を当てる
  function layoutRows(editor: Editor) {
    listRows(editor.state.doc).forEach((row, index) => {
      const element = editor.view.nodeDOM(row.pos);
      if (element instanceof HTMLElement) element.getBoundingClientRect = () => new DOMRect(0, index * 30, 300, 24);
    });
  }

  async function hoverRow(container: HTMLElement, editor: Editor, index: number) {
    layoutRows(editor);
    await act(async () => {
      container.querySelector(".be")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: index * 30 + 5 }));
    });
  }

  /** カーソルを行頭・行末に置いて、エディタにフォーカスする（Tiptap の focus は rAF で遅れるので DOM に直接）。 */
  async function focusEditor(editor: Editor, at: "start" | "end") {
    await act(async () => {
      if (at === "end") cursorToEnd(editor);
      else cursorTo(editor, 1);
      (editor.view.dom as HTMLElement).focus();
      await flush();
    });
  }

  async function rowMenu(container: HTMLElement, editor: Editor, index: number, label: string) {
    await hoverRow(container, editor, index);
    await act(async () => container.querySelector<HTMLButtonElement>('.be-hdl [aria-label="行の操作"]')!.click());
    const item = [...container.querySelectorAll<HTMLButtonElement>('.be-hdl [role="menuitem"]')].find((button) => button.textContent === label);
    if (!item) throw new Error(`menu item not found: ${label}`);
    return item;
  }

  async function pick(container: HTMLElement, editor: Editor, index: number, label: string) {
    const item = await rowMenu(container, editor, index, label);
    await act(async () => item.click());
  }

  it("マウスが本文の上にあると出て、＋ で下に「/」の行を足してメニューを開く", async () => {
    const { container, editor } = await render("一行目\n\n二行目");
    await hoverRow(container, editor, 0);
    const add = container.querySelector<HTMLButtonElement>('.be-hdl [aria-label="下に行を足す"]');
    expect(add).not.toBeNull();
    await act(async () => {
      add!.click();
      await flush();
    });
    expect(markdownOf(editor)).toBe("一行目\n\n/\n\n二行目\n");
    expect(options(container)).toHaveLength(10);
    // マウスの位置の ＋ ⋮⋮ は隠れ、カーソルの行（足した「/」の行）のものが残る
    expect(container.querySelectorAll(".be-hdl")).toHaveLength(1);
  });

  it("⋮⋮ の複製・削除・テキストに戻す", async () => {
    const { container, editor } = await render("## 見出し\n\n本文");
    await pick(container, editor, 0, "複製");
    expect(markdownOf(editor)).toBe("## 見出し\n\n## 見出し\n\n本文\n");
    await pick(container, editor, 1, "削除");
    expect(markdownOf(editor)).toBe("## 見出し\n\n本文\n");
    await pick(container, editor, 0, "テキストに戻す");
    expect(markdownOf(editor)).toBe("見出し\n\n本文\n");
    // 操作のあとはカーソルが本文に戻るので、メニューは閉じて ＋ ⋮⋮ はカーソルの行に残る
    expect(container.querySelector('.be-hdl [role="menu"]')).toBeNull();
    expect(container.querySelectorAll(".be-hdl")).toHaveLength(1);
  });

  it("区切り線は「テキストに戻す」を押せない", async () => {
    const { container, editor } = await render("前\n\n---\n\n後");
    expect((await rowMenu(container, editor, 1, "テキストに戻す")).disabled).toBe(true);
  });

  it("マウスを使わなくても、カーソルのある行に名前つきで出る（hover だけにしない）", async () => {
    const { container, editor } = await render("一行目\n\n二行目");
    layoutRows(editor);
    expect(container.querySelector(".be-hdl")).toBeNull();
    await focusEditor(editor, "end");
    const handles = container.querySelector<HTMLElement>(".be-hdl");
    expect(handles).not.toBeNull();
    expect([...handles!.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual(["下に行を足す", "行の操作"]);
    // 2 行目（縦 30px の 2 つ目）の 1 行目の高さの中央に合わせる
    expect(handles!.style.top).toBe("31px");
    await focusEditor(editor, "start");
    expect(container.querySelector<HTMLElement>(".be-hdl")!.style.top).toBe("1px");
  });

  it("Tab で ＋ ⋮⋮ へ移っても消えず、外へ出ると消える。その間マウスで別の行へ動かさない", async () => {
    const { container, editor } = await render("一行目\n\n二行目");
    layoutRows(editor);
    await focusEditor(editor, "end");
    const add = container.querySelector<HTMLButtonElement>('.be-hdl [aria-label="下に行を足す"]')!;
    await act(async () => {
      add.focus();
      await flush();
    });
    expect(document.activeElement).toBe(add);
    expect(container.querySelector<HTMLElement>(".be-hdl")!.style.top).toBe("31px");
    // フォーカスが ＋ ⋮⋮ にある間は、マウスが 1 行目に載っても動かない
    await hoverRow(container, editor, 0);
    expect(container.querySelector<HTMLElement>(".be-hdl")!.style.top).toBe("31px");
    // 本文へ戻る（Shift+Tab）。カーソルの行のまま
    await act(async () => {
      (editor.view.dom as HTMLElement).focus();
      await flush();
    });
    expect(container.querySelector<HTMLElement>(".be-hdl")!.style.top).toBe("31px");
    // 外へ出ると隠す
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    await act(async () => {
      outside.focus();
      await flush();
    });
    expect(container.querySelector(".be-hdl")).toBeNull();
    outside.remove();
  });

  it("キーボードで ＋ を押すと下に「/」の行を足し、フォーカスは本文へ戻る", async () => {
    const { container, editor } = await render("一行目");
    layoutRows(editor);
    await focusEditor(editor, "end");
    const add = container.querySelector<HTMLButtonElement>('.be-hdl [aria-label="下に行を足す"]')!;
    await act(async () => {
      add.focus();
      await flush();
    });
    await act(async () => {
      add.click();
      await flush();
    });
    expect(markdownOf(editor)).toBe("一行目\n\n/\n");
    expect(document.activeElement).toBe(editor.view.dom);
    expect(container.querySelectorAll(".be-hdl")).toHaveLength(1);
  });

  it("区切り線を選んだときは、その区切り線の行に出す（次の行にしない）", async () => {
    const { container, editor } = await render("一行目\n\n---\n\n二行目");
    layoutRows(editor);
    await focusEditor(editor, "start");
    const hr = listRows(editor.state.doc)[1]!;
    await act(async () => {
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, hr.pos)));
      await flush();
    });
    // 区切り線（縦 30px の 2 つ目）の高さの中央。次の行なら 61px になる
    expect(container.querySelector<HTMLElement>(".be-hdl")!.style.top).toBe("30px");
    await act(async () => container.querySelector<HTMLButtonElement>('.be-hdl [aria-label="行の操作"]')!.click());
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('.be-hdl [role="menuitem"]')].find((button) => button.textContent === "削除")!.click();
      await flush();
    });
    expect(markdownOf(editor)).toBe("一行目\n\n二行目\n");
  });

  it("行の操作を開いたままフォーカスが外へ出たら、メニューも閉じる（マウスでまた出せる）", async () => {
    const { container, editor } = await render("一行目\n\n二行目");
    layoutRows(editor);
    await focusEditor(editor, "end");
    const grip = container.querySelector<HTMLButtonElement>('.be-hdl [aria-label="行の操作"]')!;
    await act(async () => {
      grip.focus();
      grip.click();
      await flush();
    });
    expect(container.querySelector('.be-hdl [role="menu"]')).not.toBeNull();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.be-hdl [role="menuitem"]')!.focus();
      outside.focus();
      await flush();
    });
    expect(container.querySelector(".be-hdl")).toBeNull();
    await hoverRow(container, editor, 0);
    expect(container.querySelector<HTMLElement>(".be-hdl")!.style.top).toBe("1px");
    expect(container.querySelector('.be-hdl [role="menu"]')).toBeNull();
    outside.remove();
  });

  it("⌘/ でカーソルの行の「行の操作」を開く（リストの行は Tab が入れ子に使われるため）。Esc で ⋮⋮ へ戻る", async () => {
    const { container, editor } = await render("- 一つ目\n- 二つ目");
    layoutRows(editor);
    await focusEditor(editor, "end");
    // マウスが別の行に載っていても、カーソルの行で開く
    await hoverRow(container, editor, 0);
    await act(async () => {
      editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "/", metaKey: true, bubbles: true, cancelable: true }));
      await flush();
    });
    expect(document.activeElement?.textContent).toBe("削除");
    const grip = container.querySelector<HTMLButtonElement>('.be-hdl [aria-label="行の操作"]')!;
    expect(grip.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await flush();
    });
    expect(container.querySelector('.be-hdl [role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(grip);
    // 開いていたのはカーソルの行（2 項目目）のメニュー
    await act(async () => grip.click());
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('.be-hdl [role="menuitem"]')].find((button) => button.textContent === "複製")!.click();
      await flush();
    });
    expect(markdownOf(editor)).toBe("- 一つ目\n- 二つ目\n- 二つ目\n");
  });

  it("本文から離れると隠し、編集できないとき（実行中）は出さない", async () => {
    const { container, editor } = await render("本文");
    await hoverRow(container, editor, 0);
    expect(container.querySelector(".be-hdl")).not.toBeNull();
    await act(async () => {
      container.querySelector(".be")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 900, clientY: 5 }));
    });
    expect(container.querySelector(".be-hdl")).toBeNull();

    const readonly = await render("本文", { editable: false });
    await hoverRow(readonly.container, readonly.editor, 0);
    expect(readonly.container.querySelector(".be-hdl")).toBeNull();
    await focusEditor(readonly.editor, "end");
    expect(readonly.container.querySelector(".be-hdl")).toBeNull();
  });
});

describe("空の行の案内", () => {
  it("1 行だけの空の文書・リスト・見出しに案内を出し、読み取り専用では出さない", async () => {
    const { container, editor } = await render();
    expect(container.querySelector("p.is-empty")?.getAttribute("data-placeholder")).toBe(PARAGRAPH_HINT);
    await type(editor, "- ");
    expect(container.querySelector("li p.is-empty")?.getAttribute("data-placeholder")).toBe("リスト");
    const heading = await render("## 見出し\n\n#");
    expect(heading.container.querySelector("h2")?.classList.contains("is-empty")).toBe(false);
    expect(heading.container.querySelector("h1.is-empty")?.getAttribute("data-placeholder")).toBe("見出し1");
    const readonly = await render("", { editable: false });
    expect(readonly.container.querySelector("[data-placeholder]")).toBeNull();
  });
});

describe("チェックボックス", () => {
  it("押すと済み・未済が切り替わり、読み上げの名前は日本語", async () => {
    const { container, editor } = await render("- [x] 済み\n- [ ] まだ");
    const boxes = [...container.querySelectorAll<HTMLInputElement>('ul[data-type="taskList"] input[type="checkbox"]')];
    expect(boxes.map((box) => box.getAttribute("aria-label"))).toEqual(["やること: 済み", "やること: まだ"]);
    expect(container.textContent).not.toContain("Task item");
    await act(async () => {
      boxes[1]!.click();
      await flush();
    });
    expect(markdownOf(editor)).toBe("- [x] 済み\n- [x] まだ\n");
  });
});

describe("書式のバー", () => {
  function state(markdown: string) {
    return EditorState.create({ doc: markdownToDoc(markdown) });
  }

  it("文字を選んだときだけ出す（空の選択・空白だけ・コード・区切り線・読み取り専用では出さない）", () => {
    const text = state("本文です");
    expect(shouldShowFormatBar(text.apply(text.tr.setSelection(TextSelection.create(text.doc, 1, 3))), true)).toBe(true);
    expect(shouldShowFormatBar(text.apply(text.tr.setSelection(TextSelection.create(text.doc, 1, 3))), false)).toBe(false);
    expect(shouldShowFormatBar(text.apply(text.tr.setSelection(TextSelection.create(text.doc, 2))), true)).toBe(false);
    const spaces = state("前　　後");
    expect(shouldShowFormatBar(spaces.apply(spaces.tr.setSelection(TextSelection.create(spaces.doc, 2, 4))), true)).toBe(false);
    const code = state("```\ncode\n```");
    expect(shouldShowFormatBar(code.apply(code.tr.setSelection(TextSelection.create(code.doc, 1, 3))), true)).toBe(false);
    const divider = state("前\n\n---\n\n後");
    expect(shouldShowFormatBar(divider.apply(divider.tr.setSelection(NodeSelection.create(divider.doc, 3))), true)).toBe(false);
  });
});

describe("タイトル", () => {
  it("Enter・↓ で本文の 1 行目の先頭へ移る（日本語入力の確定中の Enter は除く）", async () => {
    const { container, editor } = await render("本文", { withTitle: true });
    const title = container.querySelector<HTMLTextAreaElement>("textarea.page-title")!;
    expect(title.placeholder).toBe("無題");
    await act(async () => cursorToEnd(editor));
    await act(async () => {
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
    });
    expect(editor.state.selection.from).not.toBe(1);
    await act(async () => {
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await flush();
    });
    expect(editor.state.selection.from).toBe(1);
    await act(async () => cursorToEnd(editor));
    await act(async () => {
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await flush();
    });
    expect(editor.state.selection.from).toBe(1);
  });

  it("1 行目が区切り線なら、その前に空の段落を作って移る", async () => {
    const { container, editor } = await render("---\n\n後", { withTitle: true });
    const title = container.querySelector<HTMLTextAreaElement>("textarea.page-title")!;
    await act(async () => {
      title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await flush();
    });
    expect(topTypes(editor).slice(0, 2)).toEqual(["paragraph", "horizontalRule"]);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.from).toBe(1);
  });
});
