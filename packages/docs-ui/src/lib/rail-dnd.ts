import type { ProjectId } from "./bridge";

export const NIHO_DRAG_TYPE = "text/x-niho";

export type RailDrag =
  | { kind: "page"; projectId: ProjectId; pageId: string }
  | { kind: "folder"; projectId: string };

export type RailDropZone =
  | { kind: "page"; projectId: ProjectId; pageId: string; half: "before" | "after" }
  | { kind: "folder"; projectId: string; half: "before" | "after" }
  | { kind: "folder-end"; projectId: string }
  | { kind: "outside-start" }
  | { kind: "outside-end" };

export type RailDrop =
  | { kind: "page"; sourceProjectId: ProjectId; pageId: string; targetProjectId: ProjectId; beforePageId: string | null; mark: "before" | "after" | "into" }
  | { kind: "folder"; projectId: string; beforeProjectId: string | null; mark: "before" | "after" };

export type RailOrder = { projects: string[]; pages: (projectId: ProjectId) => readonly string[] };

export function encodeRailDrag(drag: RailDrag): string {
  return JSON.stringify(drag);
}

export function decodeRailDrag(value: string): RailDrag | null {
  try {
    const drag = JSON.parse(value) as Partial<RailDrag>;
    if (drag.kind === "folder" && typeof drag.projectId === "string") return { kind: "folder", projectId: drag.projectId };
    if (drag.kind === "page" && (drag.projectId === null || typeof drag.projectId === "string") && typeof drag.pageId === "string") {
      return { kind: "page", projectId: drag.projectId, pageId: drag.pageId };
    }
  } catch {
    // 外部や別アプリの data は内部 drag として扱わない。
  }
  return null;
}

function nextAfter(ids: readonly string[], id: string): string | null {
  const index = ids.indexOf(id);
  return index < 0 ? null : (ids[index + 1] ?? null);
}

/** mock v4 の dragTargetOf/applyDrop と同じ、表示状態を変えない落とし先判定。 */
export function railDropTarget(drag: RailDrag, zone: RailDropZone, order: RailOrder): RailDrop | null {
  if (drag.kind === "folder") {
    if (zone.kind !== "folder" || zone.projectId === drag.projectId) return null;
    let beforeProjectId = zone.half === "before" ? zone.projectId : nextAfter(order.projects, zone.projectId);
    const current = [...order.projects];
    const insertion = beforeProjectId === drag.projectId ? nextAfter(current, drag.projectId) : beforeProjectId;
    const without = current.filter((id) => id !== drag.projectId);
    const oldIndex = current.indexOf(drag.projectId);
    const newIndex = insertion === null ? without.length : without.indexOf(insertion);
    if (newIndex < 0 || newIndex === oldIndex) return null;
    beforeProjectId = insertion;
    return { kind: "folder", projectId: drag.projectId, beforeProjectId, mark: zone.half };
  }
  let targetProjectId: ProjectId;
  let beforePageId: string | null;
  let mark: "before" | "after" | "into";
  if (zone.kind === "page") {
    targetProjectId = zone.projectId;
    beforePageId = zone.half === "before" ? zone.pageId : nextAfter(order.pages(zone.projectId), zone.pageId);
    mark = zone.half;
  } else if (zone.kind === "folder" || zone.kind === "folder-end") {
    targetProjectId = zone.projectId;
    beforePageId = null;
    mark = "into";
  } else {
    targetProjectId = null;
    beforePageId = zone.kind === "outside-start" ? (order.pages(null)[0] ?? null) : null;
    mark = "into";
  }
  if (targetProjectId === drag.projectId) {
    const current = [...order.pages(targetProjectId)];
    const insertion = beforePageId === drag.pageId ? nextAfter(current, drag.pageId) : beforePageId;
    const without = current.filter((id) => id !== drag.pageId);
    const oldIndex = current.indexOf(drag.pageId);
    const newIndex = insertion === null ? without.length : without.indexOf(insertion);
    if (newIndex < 0 || newIndex === oldIndex) return null;
    beforePageId = insertion;
  }
  // legacy root 録音は別フォルダにも同じ `root` id がある。別containerへの移動ではtargetの `root` を有効な挿入位置として扱う。
  if (targetProjectId === drag.projectId && beforePageId === drag.pageId) return null;
  return { kind: "page", sourceProjectId: drag.projectId, pageId: drag.pageId, targetProjectId, beforePageId, mark };
}
