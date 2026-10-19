/** 実行中の工程（画面の逐次表示と停止に使う。保存はしない）。 */

import type { ProjectId } from "./bridge";

export type SpeechProgress = {
  stage: "convert" | "diarize" | "silence" | "transcribe";
  file: number;
  files: number;
  part: number;
  parts: number;
  ratio: number;
  /** この音声で diarize 段階を通った。後続段階の完了表示に使う。 */
  diarized: boolean;
};

export type ActiveRun = {
  /** 実行のロックはフォルダ・フォルダの外の単位（同じ場所の別の録音は同時に実行しない）。 */
  projectId: ProjectId;
  recordingId: string;
  stepId: string;
  stepName: string;
  /** 複数案の処理は開始時の案へ固定する。通常工程は null。 */
  candidateId?: string | null;
  artifactId?: string | null;
  /** この後に続けて実行する工程（「工程を実行」の残り）。 */
  queue: string[];
  turnId: string | null;
  jobId: string | null;
  startedAt: number;
  thinking: string;
  text: string;
  continuation: number;
  speech: SpeechProgress | null;
  stopRequested: boolean;
  /** 実行の行と進みの行に出すモデル（「Claude 標準 · Sonnet 4.6 · 高」「Gemini」「この Mac」）。 */
  modelLabel: string;
  /** 会話の「▶ 実行」の行の添え書き。 */
  note: string;
};

/** 直近の失敗・停止（録音のページの実行の帯の下と、会話の欄に出す。記録は runs.jsonl にもある）。 */
export type RunNotice = { projectId: ProjectId; recordingId: string; stepId: string; kind: "failed" | "stopped" | "submitted"; message: string };

/** この録音の実行か。 */
export function runIsOn(
  run: { projectId: ProjectId; recordingId: string } | null,
  rec: { projectId: ProjectId; recordingId: string },
): boolean {
  return run !== null && run.projectId === rec.projectId && run.recordingId === rec.recordingId;
}

/**
 * ほかのフォルダ（かホーム）の実行中に、ここの実行を押せない理由（レールと中央の欄に 1 行出す。色だけで無効を伝えない）。
 * 実行はアプリ全体で 1 つなので、実行中のフォルダの名前を添える。ここの実行中・何も実行していないときは null。
 */
export function runBlockedReason(
  activeRun: Pick<ActiveRun, "projectId"> | null,
  projectId: ProjectId,
  projects: ReadonlyArray<{ id: ProjectId; project: { name: string } }>,
): string | null {
  if (!activeRun || activeRun.projectId === projectId) return null;
  const name = activeRun.projectId === null ? "ホーム" : projects.find((entry) => entry.id === activeRun.projectId)?.project.name;
  return name ? `「${name}」の実行が終わると実行できます。` : "ほかのフォルダの実行が終わると実行できます。";
}

/** ここの「AIと作る」の依頼中に、工程の実行を押せない理由。 */
export const CHAT_BUSY_RUN_REASON = "「AIと作る」の依頼が終わると実行できます。";
