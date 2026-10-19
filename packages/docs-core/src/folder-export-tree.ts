import { artifactIdFor, selectedSourceArtifactId } from "./candidates.js";
import { SOURCE_STEP_ID } from "./inputs.js";
import { ROOT_RECORDING_ID, folderName, pageTitle, projectPages, recordingChildren, recordingOf, rootRecording } from "./pages.js";
import type { PageEntry, Project, Recording, RecordingFile } from "./types.js";

/** 保存先に依存しない、フォルダ書き出しの木と選択規則。本文や題名は台帳に保存しない。 */
export const FOLDER_EXPORT_MAX_TABS = 100;
export const FOLDER_EXPORT_MAX_CHARS = 1_000_000;
export const FOLDER_EXPORT_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/;
export const FOLDER_EXPORT_CONTEXT_KEY = "context";
export const FOLDER_EXPORT_CONTEXT_TITLE = "背景情報";
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type FolderExportNodeKind = "context" | "step" | "document";
export type FolderExportNode = {
  key: string;
  kind: FolderExportNodeKind;
  title: string;
  parentKey: string | null;
  bodyPath: string | null;
  structurePaths: string[];
  timestamps: "source" | "artifact" | false;
};
export type FolderExportInfo = {
  background: string;
  entities: Array<{ name: string; reading: string; role: string; note: string }>;
  terms: Array<{ term: string; reading: string; note: string }>;
};
export type FolderExportTree = {
  title: string;
  info: FolderExportInfo;
  nodes: FolderExportNode[];
};

// ---------------------------------------------------------------------------
// 木

export type FolderExportFiles = { has(path: string): boolean };

/** フォルダの録音・文書の本文の場所。文書 `pages/<pageId>.md`、録音 `recordings/<recordingId>/`（root は直下）。 */
export function folderExportRecordingBase(recordingId: string): string {
  return recordingId === ROOT_RECORDING_ID ? "" : `recordings/${recordingId}/`;
}

function contextInfo(project: Project): FolderExportInfo {
  const info = project.info;
  return {
    background: info.background,
    entities: (info.entities ?? [])
      .filter((entity) => entity.name.trim())
      .map((entity) => ({ name: entity.name, reading: entity.reading, role: entity.role, note: entity.note })),
    terms: info.terms
      .filter((entry) => entry.term.trim())
      .map((entry) => ({ term: entry.term, reading: entry.reading, note: entry.note })),
  };
}

export function hasFolderExportContext(info: FolderExportInfo): boolean {
  return Boolean(info.background.trim()) || info.entities.length > 0 || info.terms.length > 0;
}

/**
 * レールのページの一覧（Mac の page_list と同じ: pages があればその順、台帳に root が無くても project.json に
 * flowSnapshot があれば root の録音を先頭に置く。pages が無ければ root の録音 1 枚）。
 */
function railPages(project: Project): PageEntry[] {
  const pages = projectPages(project);
  if (project.pages !== undefined && project.flowSnapshot && !pages.some((page) => page.id === ROOT_RECORDING_ID)) {
    return [{ id: ROOT_RECORDING_ID, kind: "rec", recordingId: ROOT_RECORDING_ID, title: "", createdAt: project.createdAt }, ...pages];
  }
  return pages;
}

/**
 * 書き出しのページを組む。背景情報、工程のページ、独自ページの順にすべて同じ深さで並べる。
 * `files.has` は保存先のファイルの一覧、`loadRecording` は検証済み recording.json を返す。
 */
export async function buildFolderExportTree(params: {
  project: Project;
  files: FolderExportFiles;
  loadRecording: (path: string) => Promise<RecordingFile | null>;
}): Promise<FolderExportTree> {
  const { project, files } = params;
  const info = contextInfo(project);
  const nodes: FolderExportNode[] = [];
  const recordings: Array<{ pageId: string; base: string; recording: Recording }> = [];
  if (hasFolderExportContext(info)) {
    nodes.push({
      key: FOLDER_EXPORT_CONTEXT_KEY,
      kind: "context",
      title: FOLDER_EXPORT_CONTEXT_TITLE,
      parentKey: null,
      bodyPath: null,
      structurePaths: [],
      timestamps: false,
    });
  }
  const pages = railPages(project);
  const seen = new Set<string>();
  for (const entry of pages) {
    if (!SAFE_ID.test(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (entry.kind === "doc") continue;
    const recordingId = entry.recordingId ?? entry.id;
    if (!SAFE_ID.test(recordingId)) continue;
    const base = folderExportRecordingBase(recordingId);
    let recording: Recording | null = null;
    if (recordingId === ROOT_RECORDING_ID) {
      recording = rootRecording(project);
    } else if (files.has(`${base}recording.json`)) {
      let raw: RecordingFile | null = null;
      try {
        raw = await params.loadRecording(`${base}recording.json`);
      } catch {
        raw = null;
      }
      recording = raw ? recordingOf(project, raw) : null;
    }
    if (!recording) continue;
    recordings.push({ pageId: entry.id, base, recording });
  }

  // 録音ページは画面から無くなった。1工程を1ページとしてフォルダ直下へ置き、録音行や候補の旧階層を作らない。
  for (const stored of recordings) {
    const { pageId, base, recording } = stored;
    const textSource = recording.source.kind === "text";
    const artifactIds = recording.flowSnapshot.steps
      .map((step) => step.id)
      .filter((stepId) => SAFE_ID.test(stepId) && files.has(`${base}artifacts/${stepId}.md`));
    const children = recordingChildren(recording, files.has(`${base}transcript.md`), artifactIds);
    for (const child of children) {
      if (child.stepId === SOURCE_STEP_ID) {
        let sourceArtifactId: string;
        try {
          sourceArtifactId = selectedSourceArtifactId(recording);
        } catch {
          // 台帳の選択が壊れているときに最初の文字起こしへ寄せて書き出さない。
          continue;
        }
        if (!SAFE_ID.test(sourceArtifactId)) continue;
        const sourcePath = sourceArtifactId === SOURCE_STEP_ID ? `${base}transcript.md` : `${base}artifacts/${sourceArtifactId}.md`;
        if (!files.has(sourcePath)) continue;
        nodes.push({
          key: `step:${pageId}:${SOURCE_STEP_ID}`,
          kind: "step",
          title: child.name,
          parentKey: null,
          bodyPath: sourcePath,
          structurePaths: base ? [`${base}recording.json`] : [],
          timestamps: textSource ? false : sourceArtifactId === SOURCE_STEP_ID ? "source" : "artifact",
        });
        continue;
      }
      const marker = `${base}artifacts/${child.stepId}.md`;
      // 旧候補台帳が残る場合も工程は1ページ。現在の代表本文（order の先頭）だけを工程ページとして書き出す。
      const artifactId = artifactIdFor(recording, child.stepId);
      if (!SAFE_ID.test(artifactId)) continue;
      const bodyPath = `${base}artifacts/${artifactId}.md`;
      if (!files.has(bodyPath)) continue;
      const structurePaths = new Set<string>();
      if (base) structurePaths.add(`${base}recording.json`);
      if (bodyPath !== marker) structurePaths.add(marker);
      nodes.push({
        key: `step:${pageId}:${child.stepId}`,
        kind: "step",
        title: child.name,
        parentKey: null,
        bodyPath,
        structurePaths: [...structurePaths],
        timestamps: textSource ? false : "artifact",
      });
    }
  }

  // 独自ページは工程ページの後に置く。録音ページを含む project.pages の旧混在順は引き継がない。
  const seenDocuments = new Set<string>();
  for (const entry of pages) {
    if (entry.kind !== "doc" || !SAFE_ID.test(entry.id) || seenDocuments.has(entry.id)) continue;
    seenDocuments.add(entry.id);
    const bodyPath = `pages/${entry.id}.md`;
    if (!files.has(bodyPath)) continue;
    nodes.push({
      key: `doc:${entry.id}`,
      kind: "document",
      title: pageTitle(entry),
      parentKey: null,
      bodyPath,
      structurePaths: [],
      timestamps: false,
    });
  }
  return { title: folderName(project), info, nodes };
}

export type FolderExportSelectionError =
  { reason: "invalid_selection"; key: string };

/**
 * 入れる key をページの順に並べる。ページに無い key は誤り（400 invalid_selection）。
 */
export function orderFolderExportSelection(
  tree: Pick<FolderExportTree, "nodes">,
  include: readonly string[],
): { ok: true; keys: string[] } | { ok: false; error: FolderExportSelectionError } {
  const byKey = new Map(tree.nodes.map((node) => [node.key, node]));
  const selected = new Set(include);
  for (const key of include) {
    if (!byKey.has(key)) return { ok: false, error: { reason: "invalid_selection", key } };
  }
  return { ok: true, keys: tree.nodes.filter((node) => selected.has(node.key)).map((node) => node.key) };
}
