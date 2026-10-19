import { SOURCE_STEP_ID } from "./inputs.js";
import type { ArtifactCandidate, CandidateSet, Flow, Recording, RunRecord, TranscriptionEngine } from "./types.js";

/** 別案を作れるのは最後の工程（最後の成果物）だけ。どのフローでも常に作れる（工程ごとの設定は持たない）。 */
export function stepSupportsCandidates(flow: Pick<Flow, "steps">, stepId: string): boolean {
  return flow.steps.length > 0 && flow.steps[flow.steps.length - 1]?.id === stepId;
}

/**
 * その録音のその工程に案を足せるか。最後の工程に加えて、音声のある録音の文字起こし（工程 1）も別のエンジンで案を足せる
 * （#19108。文章から作った録音は文字起こしをしないので足せない）。
 */
export function candidatesAllowed(recording: Pick<Recording, "flowSnapshot" | "source">, stepId: string): boolean {
  if (stepId === SOURCE_STEP_ID) return recording.source.kind === "audio" && recording.source.audio.length > 0;
  return stepSupportsCandidates(recording.flowSnapshot, stepId);
}

/** 文字起こしのエンジンの表示名（設定・案の名前・ページの行で同じ）。 */
export const TRANSCRIPTION_ENGINE_LABELS: Readonly<Record<TranscriptionEngine, string>> = {
  gemini: "Gemini",
  "this-mac": "この Mac",
  deepgram: "Deepgram",
};

/**
 * 新しい文字起こしの案の名前: エンジン名。同じエンジンの案があれば「Gemini 2」のように数を足す（エンジンは案の一意キーに
 * しない。名前はあとで変えられる）。台帳がまだ無い（2 つ目を足す）ときは、これから台帳に載せる最初の案 `primary` も数える。
 */
export function sourceCandidateName(
  recording: Pick<Recording, "candidateSets">,
  engine: TranscriptionEngine,
  primary?: Pick<ArtifactCandidate, "name" | "engine">,
): string {
  const label = TRANSCRIPTION_ENGINE_LABELS[engine];
  const listed: ReadonlyArray<Pick<ArtifactCandidate, "name" | "engine">> = candidatesFor(recording, SOURCE_STEP_ID);
  const existing = listed.length > 0 ? listed : primary ? [primary] : [];
  const names = new Set(existing.map((candidate) => candidate.name));
  const same = existing.filter((candidate) => candidate.engine === engine).length;
  if (same === 0 && !names.has(label)) return label;
  for (let n = Math.max(2, same + 1); ; n += 1) {
    const name = `${label} ${n}`;
    if (!names.has(name)) return name;
  }
}

export function candidateSet(recording: Pick<Recording, "candidateSets">, stepId: string): CandidateSet | null {
  const set = recording.candidateSets?.[stepId];
  if (!set || set.stepId !== stepId) return null;
  const order = set.order.filter((id, index) => id in set.items && set.order.indexOf(id) === index);
  return order.length === 0 ? null : { ...set, order };
}

export function candidatesFor(recording: Pick<Recording, "candidateSets">, stepId: string): ArtifactCandidate[] {
  const set = candidateSet(recording, stepId);
  return set ? set.order.map((id) => set.items[id]).filter((item): item is ArtifactCandidate => Boolean(item)) : [];
}

export function candidateFor(
  recording: Pick<Recording, "candidateSets">,
  stepId: string,
  candidateId: string | null | undefined,
): ArtifactCandidate | null {
  const set = candidateSet(recording, stepId);
  if (!set) return null;
  return (candidateId ? set.items[candidateId] : set.items[set.order[0] ?? ""]) ?? null;
}

/** 候補台帳が無い既存成果物は stepId の正本をそのまま使う。 */
export function artifactIdFor(
  recording: Pick<Recording, "candidateSets">,
  stepId: string,
  candidateId?: string | null,
): string {
  const candidate = candidateFor(recording, stepId, candidateId);
  if (candidate) return candidate.artifactId;
  if (candidateId && candidateSet(recording, stepId)) {
    throw new Error("指定された案が見つかりません。");
  }
  return stepId;
}

/** 2案目を足すときにだけ、既存成果物を壊さず最初の候補台帳を作る。 */
export function addCandidate(
  recording: Recording,
  input: {
    stepId: string;
    candidate: ArtifactCandidate;
    primaryId: string;
    primaryName?: string;
    /** 文字起こしの最初の案を作ったエンジン（分かるときだけ）。 */
    primaryEngine?: TranscriptionEngine;
    primaryConnection?: "subscription" | "apiKey";
    now: string;
  },
): Recording {
  if (!candidatesAllowed(recording, input.stepId)) {
    throw new Error("この工程には別案を追加できません。");
  }
  const existing = candidateSet(recording, input.stepId);
  if (existing?.items[input.candidate.id] || input.candidate.artifactId === input.stepId) {
    throw new Error("案の id が重なっています。");
  }
  const first: ArtifactCandidate = {
    id: input.primaryId,
    artifactId: input.stepId,
    name: input.primaryName?.trim() || "最初の案",
    createdAt: input.now,
    ...(input.stepId === SOURCE_STEP_ID && input.primaryEngine ? { engine: input.primaryEngine } : {}),
    ...(input.stepId === SOURCE_STEP_ID && input.primaryEngine === "gemini" && input.primaryConnection ? { engineConnection: input.primaryConnection } : {}),
  };
  const set: CandidateSet = existing
    ? { ...existing, order: [...existing.order, input.candidate.id], items: { ...existing.items, [input.candidate.id]: input.candidate } }
    : {
        stepId: input.stepId,
        order: [first.id, input.candidate.id],
        items: { [first.id]: first, [input.candidate.id]: input.candidate },
      };
  return { ...recording, candidateSets: { ...(recording.candidateSets ?? {}), [input.stepId]: set } };
}

export function renameCandidate(recording: Recording, stepId: string, candidateId: string, name: string): Recording {
  const set = candidateSet(recording, stepId);
  const current = set?.items[candidateId];
  if (!set || !current || !name.trim()) return recording;
  return {
    ...recording,
    candidateSets: {
      ...(recording.candidateSets ?? {}),
      [stepId]: { ...set, items: { ...set.items, [candidateId]: { ...current, name: name.trim() } } },
    },
  };
}

export function runMatchesCandidate(run: RunRecord, stepId: string, candidate: ArtifactCandidate | null): boolean {
  if (run.stepId !== stepId) return false;
  if (!candidate) return run.candidateId === undefined;
  if (run.candidateId !== undefined) return run.candidateId === candidate.id;
  return candidate.artifactId === stepId;
}

/**
 * 最初の文字起こし以外を後工程に使う録音で、続きをクラウドで作ろうとしたときの理由（#19108。クラウドは原文を最初の案の版でしか
 * 受け付けない。Mac の実行の帯・Native・API の受付で同じ文）。
 */
export const SOURCE_CANDIDATE_CLOUD_REASON =
  "最初の文字起こし以外を後工程に使う録音は、クラウドでは続きを作れません。設定の「残りの工程」を「この Mac」にすると作れます。";

/**
 * 後工程（文字起こし修正・記事方針・記事本文など）に使う文字起こしの案（#19108）。台帳が無ければ null（`transcript.md` の単一本文）。
 * 指定が無ければ最初の案。指定した案が台帳に無いときは別の案へ寄せず例外にする（選んだのと違う本文で後工程を作らない）。
 */
export function selectedSourceCandidate(recording: Pick<Recording, "candidateSets" | "sourceCandidateId">): ArtifactCandidate | null {
  const set = candidateSet(recording, SOURCE_STEP_ID);
  if (!set) {
    if (recording.sourceCandidateId) throw new Error("後工程に使う文字起こしが見つかりません。");
    return null;
  }
  const id = recording.sourceCandidateId ?? set.order[0];
  const candidate = id ? set.items[id] : undefined;
  if (!candidate) throw new Error("後工程に使う文字起こしが見つかりません。");
  return candidate;
}

/** 後工程に使う文字起こしの保存先（artifacts の id。最初の案と台帳の無い録音は SOURCE_STEP_ID＝`transcript.md`）。 */
export function selectedSourceArtifactId(recording: Pick<Recording, "candidateSets" | "sourceCandidateId">): string {
  return selectedSourceCandidate(recording)?.artifactId ?? SOURCE_STEP_ID;
}

/** その文字起こしの案を後工程に使うか（台帳の無い録音・最初の案は、指定が無ければ後工程に使う）。 */
export function isSelectedSourceCandidate(
  recording: Pick<Recording, "candidateSets" | "sourceCandidateId">,
  candidateId: string,
): boolean {
  try {
    return selectedSourceCandidate(recording)?.id === candidateId;
  } catch {
    return false;
  }
}

/** 後工程に使う文字起こしの案を変える（台帳に無い案は選べない）。最初の案を選んだときも id を残す（別端末の古い指定と区別する）。 */
export function withSourceCandidate(recording: Recording, candidateId: string): Recording {
  const set = candidateSet(recording, SOURCE_STEP_ID);
  if (!set?.items[candidateId]) throw new Error("後工程に使う文字起こしが見つかりません。");
  return { ...recording, sourceCandidateId: candidateId };
}
