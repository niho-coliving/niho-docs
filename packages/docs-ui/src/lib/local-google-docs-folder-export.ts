import { buildFolderExportTree, type FolderExportTree, type Project, type RecordingFile } from "@niho/docs-core";
import type { DocsDriveFolderExportPlan, DocsDriveLocalFolderExportFile, DocsDriveLocalFolderExportSnapshot } from "./bridge";
import { markdownHasTimestamps, markdownWithoutTimestamps } from "../editor/markdown";

/** Mac が owner、世代、hash を検証して返した手元の固定 snapshot。 */
export type LocalFolderExportPlan = {
  plan: DocsDriveFolderExportPlan;
  tree: FolderExportTree;
  snapshot: DocsDriveLocalFolderExportSnapshot;
  assetPathsByBody: ReadonlyMap<string, readonly string[]>;
};

function tabTitle(title: string): string {
  const flat = title.replace(/[\u0000-\u001f\u007f\ue000-\uf8ff]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(flat).slice(0, 100).join("").trimEnd() || "無題";
}

function contextChars(tree: FolderExportTree): number {
  const { info } = tree;
  const lines = info.background.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let chars = lines.length ? "背景".length + 1 + lines.reduce((total, line) => total + line.length + 1, 0) : 0;
  if (info.entities.length) {
    chars += "登場人物".length + 1;
    for (const entity of info.entities) chars += [entity.name, entity.reading, entity.role, entity.note].join("").length + 6;
  }
  if (info.terms.length) {
    chars += "固有名詞".length + 1;
    for (const term of info.terms) chars += [term.term, term.reading, term.note].join("").length + 6;
  }
  return chars;
}

/** 木だけを docs-core で共有し、API が固定 generation と最終の上限を検証する。 */
export async function buildLocalFolderExportPlan(
  snapshot: DocsDriveLocalFolderExportSnapshot,
  server: DocsDriveFolderExportPlan,
  readText: (file: DocsDriveLocalFolderExportFile) => Promise<string>,
): Promise<LocalFolderExportPlan> {
  const raw = snapshot.texts["project.json"];
  if (!raw) throw new Error("folder_unreadable");
  const project = JSON.parse(raw) as Project;
  if (project.id !== server.projectId) throw new Error("folder_changed");
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  const paths = new Set(files.keys());
  const tree = await buildFolderExportTree({
    project,
    files: { has: (path) => paths.has(path) },
    loadRecording: async (path) => {
      const file = files.get(path);
      return file && file.bytes <= 50 * 1024 * 1024
        ? JSON.parse(await readText(file)) as RecordingFile : null;
    },
  });
  const assetPathsByBody = new Map<string, readonly string[]>();
  const nodes = [] as DocsDriveFolderExportPlan["nodes"];
  for (const node of tree.nodes) {
    const title = tabTitle(node.title);
    const file = node.bodyPath ? files.get(node.bodyPath) : null;
    if (node.bodyPath && !file) throw new Error("folder_unreadable");
    // 1件ずつ読む。未選択ページの本文を snapshot に保持しない。
    const body = file && file.bytes <= 50 * 1024 * 1024 ? await readText(file) : null;
    const chars = node.kind === "context" ? contextChars(tree)
      : body?.length ?? (file ? server.limits.maxChars + 1 : 0);
    const without = body && node.timestamps !== false &&
      (node.timestamps === "source" || markdownHasTimestamps(body))
      ? markdownWithoutTimestamps(body).length : null;
    if (body && node.bodyPath) {
      const assets = [...body.matchAll(/niho-docs-asset:([A-Za-z0-9._-]{1,200}\.(?:png|jpe?g|gif|webp))/gi)]
        .map((match) => `assets/${match[1]}`)
        .filter((path) => paths.has(path));
      assetPathsByBody.set(node.bodyPath, assets);
    }
    nodes.push({ key: node.key, kind: node.kind, title, parentKey: node.parentKey, chars,
      ...(without !== null && without !== body?.length ? { charsWithoutTimestamps: without } : {}),
      defaultSelected: node.kind !== "context" });
  }
  return { snapshot, tree, assetPathsByBody, plan: { ...server, title: tree.title, nodes } };
}

/** 選んだページの構造・本文・写真だけを一時送信する。 */
export function localFolderExportFiles(prepared: LocalFolderExportPlan, include: readonly string[]): DocsDriveLocalFolderExportFile[] {
  const selected = new Set(include);
  const required = new Set(["project.json"]);
  for (const node of prepared.tree.nodes) {
    if (!selected.has(node.key)) continue;
    for (const path of node.structurePaths) required.add(path);
    if (!node.bodyPath) continue;
    required.add(node.bodyPath);
    for (const imagePath of prepared.assetPathsByBody.get(node.bodyPath) ?? []) required.add(imagePath);
  }
  const files = prepared.snapshot.files.filter((file) => required.has(file.path));
  if (files.length !== required.size) throw new Error("folder_changed");
  return files;
}
