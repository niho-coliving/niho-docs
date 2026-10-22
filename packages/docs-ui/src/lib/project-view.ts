import {
  ROOT_RECORDING_ID,
  EMPTY_PROJECT_INFO,
  SOURCE_STEP_ID,
  artifactIdFor,
  candidateFor,
  runMatchesCandidate,
  pageTitle,
  planProject,
  projectPages,
  recordingAutoReferencePages,
  RECORDING_AUTO_REFERENCE_MAX,
  projectWithRootRecording,
  recordingInfo,
  recordingOf,
  rootRecording,
  selectedSourceCandidate,
  flowHasTranscription,
  flowSourceIssue,
  sourceStepName,
  type Basis,
  type FlowSnapshot,
  type PageEntry,
  type Project,
  type ProjectPlan,
  type ProviderId,
  type PromptMaterials,
  type PromptRef,
  type ArtifactCandidate,
  type Recording,
  type RecordingFile,
  type RunRecord,
} from "@niho/docs-core";
import type { Bridge, LoadedPages, LoadedProject, LoadedRecording, ProjectId, RecordingRef } from "./bridge";

/**
 * 録音の見え方（工程ごとの成果物・済・stale・版）。録音は常に自分の flowSnapshot（作成時のフロー＋解決済みのモデル）を使う。
 * 工程設計でフローを直しても既存の録音へは自動で反映しない（録音のページの「この録音の工程を今の設計に更新」で snapshot を
 * 作り直す。docs-core の recordingWithCurrentFlow）。案件名・固有名詞・背景情報は案件（project.json）、話者人数・言語は録音
 * （P3 #18566）のもの。工程の入力には同じフォルダの独立文書を自動で足す（materials.refs）。
 */

const NO_RECORDING = { code: "store_no_recording", message: "録音のページが見つかりません。" };

export type RecordingView = {
  /** `${projectId}/${recordingId}`（書きかけ・会話・文書の鍵）。 */
  key: string;
  projectId: ProjectId;
  recordingId: string;
  project: Project;
  page: PageEntry;
  recording: Recording;
  flow: FlowSnapshot;
  sourceName: string;
  /**
   * 後工程に使う文字起こしの本文（#19108。台帳が無ければ transcript.md、あれば `sourceCandidateId` が指す案）。工程の入力・済・
   * stale はこれで決める。指定が台帳に無いときは空（後工程を止める）で、`sourceProblem` に理由を持つ。
   */
  source: string;
  /** 最初の文字起こし（transcript.md）の本文。文字起こしの最初の案のページはこれを出す。 */
  transcript: string;
  /** 後工程に使う文字起こしを決められない理由（指定した案が台帳に無い）。 */
  sourceProblem: string | null;
  /** artifact id → 最新版。既存の単一成果物は artifact id = step id。 */
  artifacts: Record<string, string>;
  runs: RunRecord[];
  plan: ProjectPlan;
  materials: PromptMaterials;
  /** 今の文書が版になっていない工程（自動保存した書きかけ。版は編集のまとまりごとに自動で残す・#18912）。 */
  unversioned: string[];
  /** 参考文書が実行上限を超えている場合、録音画面は開いたまま AI 工程だけを止める。 */
  executionBlockReason: string | null;
  /** 写しがこの Mac に無い音声の file（クラウドから取得中・期限切れ）。 */
  missingInputs: string[];
};

export function recordingKey(rec: RecordingRef): string {
  return `${rec.projectId ?? "_outside"}/${rec.recordingId}`;
}

export function recordingRef(view: Pick<RecordingView, "projectId" | "recordingId">): RecordingRef {
  return { projectId: view.projectId, recordingId: view.recordingId };
}

/** 版を足した記録（新しい順）。 */
export function versionsOf(runs: readonly RunRecord[], stepId: string, candidate: ArtifactCandidate | null = null): RunRecord[] {
  return runs.filter((run) => runMatchesCandidate(run, stepId, candidate) && typeof run.version === "number").reverse();
}

export function latestVersionRecord(runs: readonly RunRecord[], stepId: string, candidate: ArtifactCandidate | null = null): RunRecord | undefined {
  return versionsOf(runs, stepId, candidate)[0];
}

/**
 * 保存・履歴復元を遡り、この source 版を作った最後の文字起こし provider を返す。版の番号は置き場ごとなので、文字起こしの別案
 * （#19108）は `artifactId` の版だけを見る（最初の案は SOURCE_STEP_ID）。
 */
export function transcriptOriginProvider(
  runs: readonly RunRecord[],
  version: number | null,
  artifactId: string = SOURCE_STEP_ID,
): ProviderId | "this-mac" | "deepgram" | null {
  let current = version;
  const seen = new Set<number>();
  while (current !== null && current > 0 && !seen.has(current)) {
    seen.add(current);
    const record = runs.find((run) => run.stepId === SOURCE_STEP_ID && (run.artifactId ?? SOURCE_STEP_ID) === artifactId && run.version === current);
    if (!record) return null;
    if (record.kind === "run" && record.provider) return record.provider;
    current = record.restoredFrom ?? current - 1;
  }
  return null;
}

/** 工程の実行の記録（古い順）。会話の欄に出す。 */
export function runsOf(runs: readonly RunRecord[], stepId: string, candidate: ArtifactCandidate | null = null): RunRecord[] {
  return runs.filter((run) => runMatchesCandidate(run, stepId, candidate) && run.kind === "run");
}

/**
 * 録音の値（root は project.json から、ほかは recording.json を docs-core の recordingOf で読み替える。P1 の録音の話者人数・
 * 言語は案件の info）。無ければ録音が見つからない。
 */
export function viewRecording(project: Project, entry: Pick<PageEntry, "id" | "recordingId">, stored: RecordingFile | null): Recording {
  const id = entry.recordingId ?? entry.id;
  const recording = id === ROOT_RECORDING_ID ? rootRecording(project) : stored ? recordingOf(project, stored) : null;
  if (!recording) throw NO_RECORDING;
  return recording;
}

/** 参考の文書の本文（読めない文書は空として読む。空の文書は工程の入力に入らない）。 */
export async function readRefBodies(bridge: Bridge, projectId: ProjectId, refs: readonly string[]): Promise<Record<string, string>> {
  if (refs.length > RECORDING_AUTO_REFERENCE_MAX) throw new RangeError("参考文書の件数が上限を超えています。");
  const bodies = await Promise.all(refs.map((pageId) => bridge.readPage(projectId, pageId).catch(() => "")));
  return Object.fromEntries(refs.map((pageId, index) => [pageId, bodies[index] ?? ""]));
}

/** 工程の入力の参考ページ（フォルダの台帳順。タイトルは画面の名前、本文が空の文書は入れない）。 */
function promptRefs(pages: readonly PageEntry[], bodies: Readonly<Record<string, string>>): PromptRef[] {
  return pages.flatMap((page) => {
    const pageId = page.id;
    const body = bodies[pageId] ?? "";
    return body.trim() ? [{ pageId, title: pageTitle(page), body }] : [];
  });
}

/**
 * 録音の見え方を作る（`refBodies` は参考の文書の本文。無い文書は空として扱う）。`frozenRefs` を渡すと、参考ページはそれをそのまま使う
 * （一括実行の途中で参考の文書が変わっても、キューを始めたときの内容で最後まで通すため）。
 */
export function buildRecordingView(
  project: Project,
  entry: PageEntry,
  loaded: LoadedRecording,
  refBodies: Readonly<Record<string, string>> = {},
  projectId: ProjectId = project.id,
  frozenRefs?: readonly PromptRef[],
): RecordingView {
  const recording = viewRecording(project, entry, loaded.recording);
  const flow = recording.flowSnapshot;
  const artifacts: Record<string, string> = { ...loaded.artifacts };
  const latestBasis: Record<string, Basis | undefined> = {};
  for (const step of flow.steps) {
    const primaryCandidate = candidateFor(recording, step.id, null);
    latestBasis[step.id] = latestVersionRecord(loaded.runs, step.id, primaryCandidate)?.basis;
  }
  const sourceName = sourceStepName(recording.source);
  const transcript = loaded.transcript ?? "";
  // 後工程に使う文字起こし（別の案へ寄せない。決められなければ空にして後工程を止める）
  let sourceCandidate: ArtifactCandidate | null = null;
  let sourceProblem: string | null = null;
  try {
    sourceCandidate = selectedSourceCandidate(recording);
  } catch (error) {
    sourceProblem = error instanceof Error ? error.message : "後工程に使う文字起こしが見つかりません。";
  }
  const source = sourceProblem
    ? ""
    : !sourceCandidate || sourceCandidate.artifactId === SOURCE_STEP_ID
      ? transcript
      : artifacts[sourceCandidate.artifactId] ?? "";
  const transcriptSpeakerNames = sourceProblem ? undefined : latestVersionRecord(loaded.runs, SOURCE_STEP_ID, sourceCandidate)?.transcriptSpeakerNames;
  const autoPages = projectId === null ? [] : recordingAutoReferencePages(project);
  const tooManyPages = !frozenRefs && autoPages.length > RECORDING_AUTO_REFERENCE_MAX;
  const refs = frozenRefs ? [...frozenRefs] : tooManyPages ? [] : promptRefs(autoPages, refBodies);
  const sourceIssue = flowSourceIssue(flow, recording.source, source.trim().length > 0);
  const executionBlockReason = sourceIssue ?? (tooManyPages || refs.length > RECORDING_AUTO_REFERENCE_MAX
    ? `同じフォルダの文書が${RECORDING_AUTO_REFERENCE_MAX}件を超えているため、工程を実行できません。文書を別のフォルダへ移してください。`
    : null);
  const info = recordingInfo(project, recording);
  const plan = planProject({ flow, sourceName, source, ...(transcriptSpeakerNames ? { transcriptSpeakerNames } : {}), artifacts, refs, info, latestBasis });
  const rec = { projectId, recordingId: entry.recordingId ?? entry.id };
  return {
    key: recordingKey(rec),
    ...rec,
    project,
    page: entry,
    recording,
    flow,
    sourceName,
    source,
    transcript,
    sourceProblem,
    artifacts,
    runs: loaded.runs,
    plan,
    materials: { sourceName, source, ...(transcriptSpeakerNames ? { transcriptSpeakerNames } : {}), artifacts, refs, info },
    unversioned: loaded.unversioned ?? [],
    executionBlockReason,
    missingInputs: loaded.missingInputs ?? [],
  };
}

/** 録音を読んで見え方を作る（recording.json・成果物・記録と、参考の文書の本文。`frozenRefs` があれば参考は読み直さずそれを使う）。 */
export async function loadRecordingView(
  bridge: Bridge,
  projectId: ProjectId,
  project: Project,
  entry: PageEntry,
  frozenRefs?: readonly PromptRef[],
): Promise<RecordingView> {
  const rec = { projectId, recordingId: entry.recordingId ?? entry.id };
  const loaded = await bridge.loadRecording(rec);
  viewRecording(project, entry, loaded.recording);
  const autoPageIds = projectId === null ? [] : recordingAutoReferencePages(project).map((page) => page.id);
  const bodies = frozenRefs || autoPageIds.length > RECORDING_AUTO_REFERENCE_MAX
    ? {} : await readRefBodies(bridge, projectId, autoPageIds);
  return buildRecordingView(project, entry, loaded, bodies, projectId, frozenRefs);
}

/**
 * 録音を書き換えて保存する（root は project.json、ほかは recording.json）。読み直した案件と録音に変更を当てるので、画面の古い値で
 * ほかの欄を戻さない。P1 の録音は読み替えた値（話者人数・言語・参考つき）で書く（ファイルが整う）。
 */
export async function saveRecordingChange(
  bridge: Bridge,
  rec: RecordingRef,
  change: (recording: Recording) => Recording,
): Promise<void> {
  const project = rec.projectId === null ? openProjectOf(await bridge.loadPages(null)).project : (await bridge.loadProject(rec.projectId)).project;
  if (rec.recordingId === ROOT_RECORDING_ID) {
    if (rec.projectId === null) throw NO_RECORDING;
    const recording = rootRecording(project);
    if (!recording) throw NO_RECORDING;
    await bridge.saveProject(rec.projectId, projectWithRootRecording(project, change(recording)));
    return;
  }
  const fresh = await bridge.loadRecording(rec);
  if (!fresh.recording) throw NO_RECORDING;
  await bridge.saveRecording(rec, change(recordingOf(project, fresh.recording)));
}

/** 録音のページの様子（レールの子ページと済の数）。 */
export type RecordingSummary = { recording: Recording; hasTranscript: boolean; artifacts: string[] };

/** 開いている案件（ページの一覧・録音の様子・文書の本文の更新時刻）。 */
export type OpenProject = {
  id: ProjectId;
  /** 外側では表示・工程入力用の空の文脈。bridgeへ id を渡すときは必ず `id` を使う。 */
  project: Project;
  /** 読めたページだけ（recording.json を読めない録音は外す）。並びは pages の順。 */
  pages: PageEntry[];
  recordings: Record<string, RecordingSummary>;
  docUpdatedMs: Record<string, number>;
};

export function openProjectOf(loaded: LoadedProject | LoadedPages): OpenProject {
  const projectId = "projectId" in loaded ? loaded.projectId : loaded.id;
  const project =
    ("projectId" in loaded ? loaded.project : loaded.project) ??
    ({
      version: 1,
      id: "outside",
      name: "",
      createdAt: "",
      info: { terms: [...EMPTY_PROJECT_INFO.terms], background: EMPTY_PROJECT_INFO.background },
      pages: "pages" in loaded ? loaded.pages : [],
    } satisfies Project);
  const recordings: Record<string, RecordingSummary> = {};
  for (const entry of loaded.recordings) {
    const recording =
    entry.id === ROOT_RECORDING_ID ? rootRecording(project) : entry.recording ? recordingOf(project, entry.recording) : null;
    if (recording) recordings[entry.id] = { recording, hasTranscript: entry.hasTranscript, artifacts: entry.artifacts };
  }
  const docUpdatedMs: Record<string, number> = {};
  for (const doc of loaded.docs) docUpdatedMs[doc.id] = doc.updatedMs;
  const pages = ("pages" in loaded ? loaded.pages : projectPages(project)).filter((page) =>
    page.kind === "doc" ? page.id in docUpdatedMs : (page.recordingId ?? page.id) in recordings,
  );
  return { id: projectId, project, pages, recordings, docUpdatedMs };
}

/**
 * ページの名前を変えた後の開いている案件。レールの一覧（pages）と、参考ページの見出しを作る案件の値（project.pages）の両方を揃える
 * （どちらかだけだと、参考にした文書を改名しても録音の見え方には改名前の名前が残る）。
 */
export function withPageTitle(open: OpenProject, pageId: string, title: string): OpenProject {
  const rename = (page: PageEntry): PageEntry => (page.id === pageId ? { ...page, title } : page);
  return { ...open, project: { ...open.project, pages: projectPages(open.project).map(rename) }, pages: open.pages.map(rename) };
}

/** 録音の進み（済の工程の数・全体。レールの録音の行）。 */
export function recordingProgress(recording: Recording, hasTranscript: boolean, artifacts: readonly string[]): { done: number; total: number } {
  const steps = recording.flowSnapshot.steps;
  const transcription = flowHasTranscription(recording.flowSnapshot);
  const done = (transcription && hasTranscript ? 1 : 0) + steps.filter((step) => artifacts.includes(step.id)).length;
  return { done, total: steps.length + (transcription ? 1 : 0) };
}

/** 録音に素材（音声か、文字起こし・文章）があるか。無ければ工程を実行できない。 */
export function hasMaterial(view: Pick<RecordingView, "recording" | "source">): boolean {
  if (view.source.trim()) return true;
  return view.recording.source.kind === "audio" && view.recording.source.audio.length > 0;
}

export function stepMarkdown(view: RecordingView, stepId: string): string | undefined {
  if (stepId === SOURCE_STEP_ID) return view.transcript.trim() ? view.transcript : undefined;
  return view.artifacts[stepId];
}

export function selectedCandidate(view: RecordingView, stepId: string, candidateId?: string | null): ArtifactCandidate | null {
  return candidateFor(view.recording, stepId, candidateId);
}

export function stepArtifactId(view: RecordingView, stepId: string, candidateId?: string | null): string {
  return artifactIdFor(view.recording, stepId, candidateId);
}

/** その置き場が最初の文字起こし（transcript.md・versions/source/）か。文字起こしの別案は工程 1 でも artifacts/ に置く（#19108）。 */
export function isTranscriptFile(artifactId: string): boolean {
  return artifactId === SOURCE_STEP_ID;
}

/**
 * 置き場の本文を差し替えた見え方（transcript.md は最初の文字起こし、ほかは artifacts）。後工程に使う文字起こしの置き場なら、
 * 工程の入力（source・materials.source）も同じ本文にする。
 */
export function withArtifactText(view: RecordingView, artifactId: string, markdown: string): RecordingView {
  let selected: string | null = null;
  try {
    selected = selectedSourceCandidate(view.recording)?.artifactId ?? SOURCE_STEP_ID;
  } catch {
    selected = null;
  }
  const next: RecordingView = isTranscriptFile(artifactId)
    ? { ...view, transcript: markdown }
    : {
        ...view,
        artifacts: { ...view.artifacts, [artifactId]: markdown },
        materials: { ...view.materials, artifacts: { ...view.materials.artifacts, [artifactId]: markdown } },
      };
  return selected === artifactId ? { ...next, source: markdown, materials: { ...next.materials, source: markdown } } : next;
}

export function candidateMarkdown(view: RecordingView, stepId: string, candidateId?: string | null): string | undefined {
  const artifactId = stepArtifactId(view, stepId, candidateId);
  if (isTranscriptFile(artifactId)) return stepMarkdown(view, SOURCE_STEP_ID);
  return view.artifacts[artifactId];
}

export function candidateVersions(view: RecordingView, stepId: string, candidateId?: string | null): RunRecord[] {
  return versionsOf(view.runs, stepId, selectedCandidate(view, stepId, candidateId));
}

export function candidateLatestVersion(view: RecordingView, stepId: string, candidateId?: string | null): RunRecord | undefined {
  return latestVersionRecord(view.runs, stepId, selectedCandidate(view, stepId, candidateId));
}

export function stepName(view: RecordingView, stepId: string): string {
  if (stepId === SOURCE_STEP_ID) return view.sourceName;
  return view.flow.steps.find((step) => step.id === stepId)?.name ?? "";
}

/** 「すべて再実行」の工程。音声があれば工程 1（文字起こし）から、文章と音声の無い録音は工程 2 から。 */
export function rerunQueueOf(view: RecordingView): string[] {
  const source = view.recording.source;
  const hasAudio = flowHasTranscription(view.flow) && source.kind === "audio" && source.audio.length > 0;
  return view.plan.steps.filter((step) => step.stepId !== SOURCE_STEP_ID || hasAudio).map((step) => step.stepId);
}
