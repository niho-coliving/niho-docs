import { SOURCE_STEP_ID, isLanguage, isSpeakerMode, sourceStepName } from "./inputs.js";
import { createFlowSnapshot } from "./profiles.js";
import { stepSupportsCandidates } from "./candidates.js";
import type {
  Connection,
  Flow,
  Language,
  PageEntry,
  PageIndex,
  Profile,
  Project,
  ProjectSource,
  ProviderId,
  Recording,
  RecordingFile,
  RecordingInfo,
  SpeakerMode,
} from "./types.js";

/**
 * 案件のページ（#18564 P1・#18566 P3）: 案件＝ページの入れ物。ページは 文書（doc）と 録音（rec）の 2 種類。
 * 今の案件（pages の無い project.json）は、案件フォルダ直下を予約 id `root` の録音のページ 1 枚として読む
 * （ファイルは動かさない。root の録音の値は project.json の flowSnapshot・source・info.speakers・info.language・refs）。
 * 話者人数・言語・参考は録音ごと（P3）。P1 で作った録音（recording.json にそれらが無い）は読むときに読み替える。
 */

/** 今の案件の録音（案件フォルダ直下）の予約 id。Rust の new_id は `o` を使わないので、新しいページの id とは重ならない。 */
export const ROOT_RECORDING_ID = "root";

/** 文書のページの title が空のときの名前。 */
export const UNTITLED_DOC = "無題";
export const UNTITLED_FOLDER = "無題のフォルダ";
export const EMPTY_PROJECT_INFO = { terms: [], background: "" } as const;

export function folderName(project: Pick<Project, "name">): string {
  return project.name.trim() || UNTITLED_FOLDER;
}

/** 録音の話者人数・言語の既定（録音にも案件の info にも無いとき）。 */
const DEFAULT_SPEAKERS: SpeakerMode = "auto";
const DEFAULT_LANGUAGE: Language = "ja";

/** ページの一覧（pages があればそれ、無ければ root の録音があれば root の 1 枚、無ければ空）。 */
export function projectPages(project: Project): PageEntry[] {
  if (Array.isArray(project.pages)) {
    return project.pages.map((page) => page.kind === "rec" ? { ...page, recordingId: page.recordingId ?? page.id } : page);
  }
  if (project.pages) {
    const index = project.pages as PageIndex;
    return index.order.flatMap((id) => {
      const entry = index.items[id];
      if (!entry) return [];
      return [{ id, kind: entry.kind === "document" ? "doc" : "rec", title: entry.title, createdAt: entry.createdAt,
        ...(entry.kind === "recording" ? { recordingId: entry.recordingId } : {}),
        ...(entry.derivation ? { derivation: entry.derivation } : {}),
        ...(typeof entry.moveGeneration === "number" ? { moveGeneration: entry.moveGeneration } : {}) }];
    });
  }
  return project.flowSnapshot ? [{ id: ROOT_RECORDING_ID, kind: "rec", recordingId: ROOT_RECORDING_ID, title: "", createdAt: project.createdAt }] : [];
}

/**
 * 参考の id のうち、案件の文書のページのもの（消した文書・録音の id・重複は外す。付けた順）。参考は読むときにこれで整える
 * （ファイルは次の保存で整う）。
 */
export function docRefs(project: Project, refs: unknown): string[] {
  if (!Array.isArray(refs)) return [];
  const docs = new Set(projectPages(project).filter((page) => page.kind === "doc").map((page) => page.id));
  const kept: string[] = [];
  for (const id of refs) {
    if (typeof id === "string" && docs.has(id) && !kept.includes(id)) kept.push(id);
  }
  return kept;
}

/**
 * 録音の値に読み替える（ファイルは書き換えない。書くときは同じ場所へ）: 話者人数・言語は recording.json の値、無ければ案件の
 * info の値（root と P1 の案件）、それも無ければ 自動・日本語。参考は案件の文書のページだけ（無ければ空）。
 */
export function recordingOf(project: Project, raw: RecordingFile): Recording {
  const speakers = [raw.speakers, project.info.speakers].find(isSpeakerMode) ?? DEFAULT_SPEAKERS;
  const language = [raw.language, project.info.language].find(isLanguage) ?? DEFAULT_LANGUAGE;
  return { ...raw, speakers, language, refs: docRefs(project, raw.refs) };
}

/**
 * root の録音（今の案件だけ。flowSnapshot・source・info.speakers・info.language・refs から作る。source が無ければ音声 0 本）。
 */
export function rootRecording(project: Project): Recording | null {
  if (!project.flowSnapshot) return null;
  return recordingOf(project, {
    version: 1,
    id: ROOT_RECORDING_ID,
    createdAt: project.createdAt,
    flowSnapshot: project.flowSnapshot,
    source: project.source ?? { kind: "audio", audio: [] },
    refs: project.refs,
    candidateSets: project.candidateSets,
  });
}

/**
 * root の録音の値を project.json に書き戻す（flowSnapshot・source・refs・info.speakers・info.language だけ。ほかは変えない）。
 */
export function projectWithRootRecording(project: Project, recording: Recording): Project {
  return {
    ...project,
    flowSnapshot: recording.flowSnapshot,
    source: recording.source,
    refs: recording.refs,
    candidateSets: recording.candidateSets,
    info: { ...project.info, speakers: recording.speakers, language: recording.language },
  };
}

/** 工程の入力の案件情報（録音の話者人数・言語 ＋ 案件の固有名詞・背景情報）。 */
export function recordingInfo(project: Project, recording: Pick<Recording, "speakers" | "language">): RecordingInfo {
  return { ...project.info, speakers: recording.speakers, language: recording.language };
}

/**
 * 「この録音の工程を今の設計に更新」と、録音の「工程」で別のフローを選んだとき（P4 #18567）: 録音の snapshot を `flow` から
 * 作り直す（モデルも今の設定で解決し直す）。成果物・版・実行の記録はそのまま残る（成果物は工程 id で引くので、`flow` に無い
 * 工程の成果物はファイルに残り、工程の列に出なくなる）。指示文・文書ガイド・前の工程が変わった工程は、前提の比較（plan.ts）で
 * stale になる。
 */
export function recordingWithCurrentFlow(
  recording: Recording,
  flow: Flow,
  profiles: readonly Profile[],
  providers: readonly ProviderId[],
  connection: Connection = "subscription",
): Recording {
  for (const stepId of Object.keys(recording.candidateSets ?? {})) {
    if (!stepSupportsCandidates(flow, stepId)) {
      throw new Error("複数案の本文があるため、その工程を削除したり最後から動かしたりできません。");
    }
  }
  return { ...recording, flowSnapshot: createFlowSnapshot(flow, profiles, providers, connection) };
}

/** 画面に出すページの名前（title が空なら、文書は「無題」、録音は素材が文章なら「文章」・それ以外は「録音」）。 */
export function pageTitle(
  entry: Pick<PageEntry, "kind" | "title">,
  recording?: { readonly source?: Pick<ProjectSource, "kind"> | null } | null,
): string {
  const title = entry.title.trim();
  if (title) return title;
  if (entry.kind === "doc") return UNTITLED_DOC;
  return recording?.source?.kind === "text" ? "文章" : "録音";
}

/**
 * フォルダの音声（録音のページ）。1 フォルダに録音は 1 つ（owner 2026-10-18・#18914）で、画面には録音のページを出さず、背景情報の
 * ページで音声を扱い、成果物をフォルダの直下に並べる。無ければ null。古いデータで 2 つ以上あれば先頭（作成口は 2 つ目を断る）。
 */
export function folderRecordingPage(pages: readonly PageEntry[]): PageEntry | null {
  return pages.find((page) => page.kind === "rec") ?? null;
}

/** 録音の子ページ（成果物）の 1 行。number は工程の番号（工程 1 が 1）。 */
export type RecordingChild = { stepId: string; number: number; name: string };

/**
 * 録音の子ページ（レールの成果物の行）: 工程 1 は文字起こし／文章があれば、工程 2〜 は成果物（artifacts/）のある工程を
 * flowSnapshot の順に。成果物はあっても今の工程に無いもの（工程設計の更新で外れた工程）は出さない。
 */
export function recordingChildren(recording: Recording, hasTranscript: boolean, artifacts: readonly string[]): RecordingChild[] {
  const children: RecordingChild[] = [];
  if (hasTranscript) children.push({ stepId: SOURCE_STEP_ID, number: 1, name: sourceStepName(recording.source) });
  recording.flowSnapshot.steps.forEach((step, index) => {
    if (artifacts.includes(step.id)) children.push({ stepId: step.id, number: index + 2, name: step.name });
  });
  return children;
}
