import { describe, expect, it } from "vitest";
import { decodeRailDrag, encodeRailDrag, railDropTarget, type RailOrder } from "../src/lib/rail-dnd";

const order: RailOrder = {
  projects: ["folder-a", "folder-b", "folder-c"],
  pages: (projectId) => projectId === null ? ["outside-a", "outside-b"] : projectId === "folder-a" ? ["page-a", "page-b", "page-c"] : projectId === "folder-b" ? ["page-d", "page-e"] : [],
};

describe("レールのdrop判定", () => {
  it("ページ行の上半分/下半分をbeforePageIdへ変換し、別フォルダにも挿入できる", () => {
    expect(railDropTarget({ kind: "page", projectId: "folder-a", pageId: "page-a" }, { kind: "page", projectId: "folder-b", pageId: "page-e", half: "before" }, order)).toMatchObject({ targetProjectId: "folder-b", beforePageId: "page-e", mark: "before" });
    expect(railDropTarget({ kind: "page", projectId: "folder-a", pageId: "page-a" }, { kind: "page", projectId: "folder-b", pageId: "page-d", half: "after" }, order)).toMatchObject({ targetProjectId: "folder-b", beforePageId: "page-e", mark: "after" });
    const legacyRoots: RailOrder = { projects: ["folder-a", "folder-b"], pages: (id) => id === null ? [] : ["root"] };
    expect(railDropTarget({ kind: "page", projectId: "folder-a", pageId: "root" }, { kind: "page", projectId: "folder-b", pageId: "root", half: "before" }, legacyRoots)).toMatchObject({ targetProjectId: "folder-b", beforePageId: "root" });
  });

  it("folder内は末尾、外見出しは先頭、余白は外末尾になる", () => {
    const drag = { kind: "page", projectId: "folder-a", pageId: "page-b" } as const;
    expect(railDropTarget(drag, { kind: "folder-end", projectId: "folder-b" }, order)).toMatchObject({ targetProjectId: "folder-b", beforePageId: null, mark: "into" });
    expect(railDropTarget(drag, { kind: "outside-start" }, order)).toMatchObject({ targetProjectId: null, beforePageId: "outside-a" });
    expect(railDropTarget(drag, { kind: "outside-end" }, order)).toMatchObject({ targetProjectId: null, beforePageId: null });
  });

  it("folderはfolder間だけ、自分自身と同じ位置は無効", () => {
    expect(railDropTarget({ kind: "folder", projectId: "folder-a" }, { kind: "page", projectId: "folder-b", pageId: "page-d", half: "before" }, order)).toBeNull();
    expect(railDropTarget({ kind: "folder", projectId: "folder-a" }, { kind: "folder", projectId: "folder-a", half: "before" }, order)).toBeNull();
    expect(railDropTarget({ kind: "folder", projectId: "folder-a" }, { kind: "folder", projectId: "folder-b", half: "before" }, order)).toBeNull();
    expect(railDropTarget({ kind: "folder", projectId: "folder-b" }, { kind: "folder", projectId: "folder-a", half: "after" }, order)).toBeNull();
    expect(railDropTarget({ kind: "page", projectId: "folder-a", pageId: "page-b" }, { kind: "page", projectId: "folder-a", pageId: "page-a", half: "after" }, order)).toBeNull();
    expect(railDropTarget({ kind: "folder", projectId: "folder-c" }, { kind: "folder", projectId: "folder-a", half: "before" }, order)).toMatchObject({ beforeProjectId: "folder-a" });
  });

  it("text/x-nihoの自分の型だけを読み、Filesや壊れた値を受けない", () => {
    const drag = { kind: "page", projectId: null, pageId: "outside-a" } as const;
    expect(decodeRailDrag(encodeRailDrag(drag))).toEqual(drag);
    expect(decodeRailDrag("Files")).toBeNull();
    expect(decodeRailDrag('{"kind":"page","projectId":{},"pageId":"x"}')).toBeNull();
  });
});
