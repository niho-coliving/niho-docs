// @vitest-environment jsdom
import { act, type MutableRefObject, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@niho/docs-core";
import { ProjectDialog, type ProjectDialogProps } from "../src/components/ProjectDialog";
import { FolderInfo } from "../src/components/FolderInfo";
import type { DocFlush } from "../src/components/DocPage";
import { button, click, typeInto } from "./dom";
import { FakeBridge } from "./fake-bridge";

/** 新しいフォルダのダイアログと、背景情報のページの 背景情報・登場人物・固有名詞（FolderInfo。#18914 でダイアログから移した）。 */

let root: Root | null = null;
let container: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
});

async function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

function unmount(view: HTMLElement) {
  act(() => root!.unmount());
  root = null;
  view.remove();
}

type InfoProps = { project: Project; onSaved?: () => void; onDirtyChange?: (dirty: boolean) => void; flushRef?: MutableRefObject<DocFlush | null>; locked?: boolean };

function folderInfo(bridge: FakeBridge, props: InfoProps) {
  return (
    <FolderInfo
      bridge={bridge}
      projectId={props.project.id}
      project={props.project}
      locked={props.locked}
      onSaved={props.onSaved ?? (() => undefined)}
      onDirtyChange={props.onDirtyChange}
      flushRef={props.flushRef}
    />
  );
}

async function setup() {
  const bridge = new FakeBridge();
  const project = await bridge.createProject({
    version: 1, id: "", name: "旧案件", createdAt: "2026-10-16T00:00:00.000Z",
    info: { speakers: "2", language: "ja", terms: [{ term: "朝市", reading: "あさいち", variants: [], note: "広場" }], background: "取材" },
    source: { kind: "text" },
  }, null, null, []);
  const onSaved = vi.fn();
  const view = await render(folderInfo(bridge, { project: structuredClone(project), onSaved }));
  return { bridge, project, onSaved, view };
}

const save = (view: HTMLElement) => button(view.querySelector<HTMLElement>(".folder-save")!, "保存");

describe("背景情報のページの登場人物", () => {
  it("旧案件を開き、人物を追加・編集・削除して保存し、読み直したページと録音設定を保つ", async () => {
    const { bridge, project, view, onSaved } = await setup();
    expect(view.querySelector('[aria-label="登場人物1の名前"]')).toBeNull();
    await click(button(view, "登場人物を追加"));
    for (const [label, value] of [["名前", " 佐藤花子 "], ["よみ", " さとうはなこ "], ["役割", " 店主 "], ["補足", " 朝市の出店者 "]]) {
      await typeInto(view.querySelector(`[aria-label="登場人物1の${label}"]`)!, value!);
    }
    await click(button(view, "登場人物を追加"));
    await typeInto(view.querySelector('[aria-label="登場人物2の名前"]')!, "削除する人物");
    await click(view.querySelector('[aria-label="登場人物2を削除"]')!);
    await click(button(view, "登場人物を追加"));
    await typeInto(view.querySelector('[aria-label="登場人物2の補足"]')!, "空名なので保存しない");
    const fresh = bridge.projects.get(project.id)!.project;
    fresh.info.speakers = "3";
    fresh.info.language = "en";
    fresh.pages = [{ id: "new-page", kind: "doc", title: "追加済み", createdAt: project.createdAt }];
    await click(save(view));
    expect(onSaved).toHaveBeenCalledOnce();
    const saved = bridge.projects.get(project.id)!.project;
    expect(saved.info).toMatchObject({ speakers: "3", language: "en", terms: project.info.terms, background: "取材" });
    expect(saved.source).toEqual({ kind: "text" });
    expect(saved.pages).toEqual(fresh.pages);
    expect(saved.name).toBe("旧案件");
    expect(saved.info.entities).toEqual([{ id: expect.any(String), name: "佐藤花子", reading: "さとうはなこ", role: "店主", note: "朝市の出店者" }]);
    expect(view.querySelector(".folder-save [role='status']")?.textContent).toBe("保存しました");

    unmount(view);
    const reopened = await render(folderInfo(bridge, { project: saved }));
    expect(reopened.querySelector<HTMLInputElement>('[aria-label="登場人物1の名前"]')!.value).toBe("佐藤花子");
    await typeInto(reopened.querySelector('[aria-label="登場人物1の役割"]')!, "代表");
    await click(save(reopened));
    expect(bridge.projects.get(project.id)!.project.info.entities?.[0]!.role).toBe("代表");
    await click(reopened.querySelector('[aria-label="登場人物1を削除"]')!);
    await click(save(reopened));
    expect(bridge.projects.get(project.id)!.project.info.entities).toEqual([]);
  });

  it("新規案件は登場人物を空配列で作る", async () => {
    const bridge = new FakeBridge();
    const props: ProjectDialogProps = { mode: "new", bridge, onClose: () => {}, onDone: () => {} };
    const view = await render(<ProjectDialog {...props} />);
    await typeInto(view.querySelector("#info-name")!, "新しい案件");
    await click(button(view, "作成"));
    expect(bridge.byName("新しい案件").project.info.entities).toEqual([]);
  });

  it("別端末の背景情報を取り込み、手元の別欄を保存しても外部更新を巻き戻さない", async () => {
    const { bridge, project, view, onSaved } = await setup();
    const stored = bridge.projects.get(project.id)!;
    const external = structuredClone(stored.project);
    external.info.background = "別端末で更新した背景";
    external.info.terms = [{ term: "クラウド語", reading: "くらうどご", variants: [], note: "同期済み" }];
    stored.project = external;

    await act(async () => root!.render(folderInfo(bridge, { project: structuredClone(external), onSaved })));
    expect(view.querySelector<HTMLTextAreaElement>("#info-bg")!.value).toBe("別端末で更新した背景");
    expect(view.querySelector<HTMLInputElement>('[aria-label="表記"]')!.value).toBe("クラウド語");
    await typeInto(view.querySelector("#info-bg")!, "手元で追記");
    await click(save(view));

    expect(stored.project.info.background).toBe("手元で追記");
    expect(stored.project.info.terms).toEqual(external.info.terms);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("編集していない欄は同期に追従し、保存時は編集欄だけを再読込後のフォルダに反映する", async () => {
    const { bridge, project, view } = await setup();
    const stored = bridge.projects.get(project.id)!;
    await typeInto(view.querySelector("#info-bg")!, "手元で追記");

    const synced = structuredClone(stored.project);
    synced.info.terms = [{ term: "同期済み語", reading: "どうきずみご", variants: [], note: "同期" }];
    stored.project = synced;
    await act(async () => root!.render(folderInfo(bridge, { project: structuredClone(synced) })));

    expect(view.querySelector<HTMLTextAreaElement>("#info-bg")!.value).toBe("手元で追記");
    expect(view.querySelector<HTMLInputElement>('[aria-label="表記"]')!.value).toBe("同期済み語");

    // 表示更新の後、保存直前に届いた値も loadProject の結果から保つ。
    stored.project.info.terms = [{ term: "保存直前語", reading: "ほぞんちょくぜんご", variants: [], note: "最新" }];
    await click(save(view));

    expect(stored.project.info.background).toBe("手元で追記");
    expect(stored.project.info.terms.map((term) => term.term)).toEqual(["保存直前語"]);
    expect(view.querySelector<HTMLInputElement>('[aria-label="表記"]')!.value).toBe("保存直前語");
    expect(save(view).disabled).toBe(true);
  });

  it("50人で追加を止め、各入力に長さの上限を持たせる", async () => {
    const { bridge, project, view } = await setup();
    unmount(view);
    project.info.entities = Array.from({ length: 50 }, (_, index) => ({ id: `p-${index}`, name: `人物${index}`, reading: "", role: "", note: "" }));
    const full = await render(folderInfo(bridge, { project }));
    expect(button(full, "登場人物を追加").disabled).toBe(true);
    for (const [label, length] of [["名前", 200], ["よみ", 200], ["役割", 200], ["補足", 500]]) {
      expect(full.querySelector<HTMLInputElement>(`[aria-label="登場人物1の${label}"]`)!.maxLength).toBe(length);
    }
  });

  it("上限を超えた既存の人物情報は保存せず、入力を保持して修正を案内する", async () => {
    const { bridge, project, view } = await setup();
    unmount(view);
    project.info.entities = [{ id: "long-person", name: "佐藤", reading: "", role: "", note: "補".repeat(501) }];
    const onSaved = vi.fn();
    const invalid = await render(folderInfo(bridge, { project, onSaved }));
    const saveProject = vi.spyOn(bridge, "saveProject");
    // 読んだままでは変更が無いので保存は押せない。直そうとして 1 字足すと押せる（上限を超えたままなので保存しない）
    await typeInto(invalid.querySelector('[aria-label="登場人物1の補足"]')!, "補".repeat(502));
    await click(save(invalid));
    expect(saveProject).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(invalid.querySelector(".err")!.textContent).toContain("補足を500字以内");
    expect(invalid.querySelector<HTMLInputElement>('[aria-label="登場人物1の補足"]')!.value).toHaveLength(502);
    await typeInto(invalid.querySelector('[aria-label="登場人物1の補足"]')!, "補足を直す");
    await click(save(invalid));
    expect(bridge.projects.get(project.id)!.project.info.entities?.[0]!.note).toBe("補足を直す");
  });
});

describe("背景情報の保存していない変更（#18788・#18914）", () => {
  async function page() {
    const bridge = new FakeBridge();
    const project = await bridge.createProject({
      version: 1, id: "", name: "旧案件", createdAt: "2026-10-16T00:00:00.000Z",
      info: { speakers: "2", language: "ja", terms: [], background: "取材" },
      source: { kind: "text" },
    }, null, null, []);
    const onDirtyChange = vi.fn();
    const flushRef: MutableRefObject<DocFlush | null> = { current: null };
    const view = await render(folderInfo(bridge, { project: structuredClone(project), onDirtyChange, flushRef }));
    return { bridge, project, view, onDirtyChange, flushRef };
  }

  it("変更が無ければ保存は押せず、移る前の書き残しも何も書かない", async () => {
    const { bridge, view, onDirtyChange, flushRef } = await page();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(save(view).disabled).toBe(true);
    const saveProject = vi.spyOn(bridge, "saveProject");
    let flushed = false;
    await act(async () => { flushed = await flushRef.current!(); });
    expect(flushed).toBe(true);
    expect(saveProject).not.toHaveBeenCalled();
  });

  it("保存していない変更は知らせ、ページを移る前（flush）に保存する。保存できなければ移らない", async () => {
    const { bridge, project, view, onDirtyChange, flushRef } = await page();
    await typeInto(view.querySelector("#info-bg")!, "取材の続き");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(save(view).disabled).toBe(false);
    // 保存に失敗したら false（App は移らない）。入力は残す
    const saveProject = vi.spyOn(bridge, "saveProject").mockRejectedValueOnce({ code: "store_io", message: "保存に失敗しました。" });
    let flushed = true;
    await act(async () => { flushed = await flushRef.current!(); });
    expect(flushed).toBe(false);
    expect(view.querySelector(".err")?.textContent).toBe("保存に失敗しました。");
    expect(view.querySelector<HTMLTextAreaElement>("#info-bg")!.value).toBe("取材の続き");
    // 次の書き残しで保存できる
    await act(async () => { flushed = await flushRef.current!(); });
    expect(flushed).toBe(true);
    expect(saveProject).toHaveBeenCalledTimes(2);
    expect(bridge.projects.get(project.id)!.project.info.background).toBe("取材の続き");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("前後の空白だけの違いは変更に数えない", async () => {
    const { view, onDirtyChange } = await page();
    await typeInto(view.querySelector("#info-bg")!, " 取材 ");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(save(view).disabled).toBe(true);
  });

  it("フォルダの実行中は欄と保存を止め、理由を出す", async () => {
    const bridge = new FakeBridge();
    const project = await bridge.createProject({
      version: 1, id: "", name: "実行中", createdAt: "2026-10-16T00:00:00.000Z",
      info: { terms: [], background: "" }, pages: [],
    }, null, null, []);
    const view = await render(folderInfo(bridge, { project, locked: true }));
    expect(view.querySelector<HTMLFieldSetElement>(".folder-fields")!.disabled).toBe(true);
    expect(save(view).disabled).toBe(true);
    expect(view.querySelector(".folder-save .help")?.textContent).toBe("このフォルダの工程の実行か「AIと作る」の依頼が終わってから変えられます。");
  });
});
