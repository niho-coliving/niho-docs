import type { ArtifactCandidate, CandidateSet, Flow, Recording, RunRecord } from "./types.js";

/** 別案を作れるのは最後の工程（最後の成果物）だけ。どのフローでも常に作れる（工程ごとの設定は持たない）。 */
export function stepSupportsCandidates(flow: Pick<Flow, "steps">, stepId: string): boolean {
  return flow.steps.length > 0 && flow.steps[flow.steps.length - 1]?.id === stepId;
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
  input: { stepId: string; candidate: ArtifactCandidate; primaryId: string; primaryName?: string; now: string },
): Recording {
  if (!stepSupportsCandidates(recording.flowSnapshot, input.stepId)) {
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
