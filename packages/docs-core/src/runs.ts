import type { Effort, ProviderId, ResolvedStepModel } from "./types.js";

/** クラウド同期で版の出所を特定する追加情報。既存行との互換のため全項目 optional。 */
export type RunCloudProvenance = {
  /** C0/C2 の和集合で同じ行を再送しても増殖させない stable event ID。 */
  eventId?: string;
  /** この行を最初に書いた app installation の deviceId。 */
  originDeviceId?: string;
  /** この記録が作った版ファイルの sha256。 */
  versionSha256?: string;
  /** この記録が作った版ファイルの案件相対 path。 */
  versionPath?: string;
  /** local continuation / remote Run の元になった成功 Run。 */
  continuationOfRunId?: string;
  /** 固定した入力集合の SHA-256。 */
  inputBasisSha256?: string;
  /** 再利用した確定原文の版 ID。 */
  sourceVersionId?: string;
  /** 再利用した確定原文のimmutable版ファイルのsha256。 */
  sourceVersionSha256?: string;
  /** 再利用した確定原文の案件相対path。 */
  sourceVersionPath?: string;
  /** NIHO API が受付時に返した Run ID（本文・秘密を含めない）。 */
  remoteRunId?: string;
};

/** NIHO の API へ渡す工程の種類（工程 1 の文字起こし／文章は含めない）。 */
export type RemoteStepKind = "REVISION" | "INSIGHT";

/**
 * 工程の種類（spec §5.1）: フロー全体での位置で決める。最初の工程（工程 2）が REVISION、それ以降が INSIGHT。続き・再実行で
 * 後ろの工程だけを送るときも、送る工程の中での位置ではなくフロー全体での位置で決める。フローに無い工程は null。
 */
export function remoteStepKind(flow: { readonly steps: readonly { readonly id: string }[] }, stepId: string): RemoteStepKind | null {
  const index = flow.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return null;
  return index === 0 ? "REVISION" : "INSIGHT";
}

/** NIHO の API へ渡す工程 1 つ（工程・種類・固定したモデル）。 */
export type RemoteRunStep = {
  stepKey: string;
  kind: RemoteStepKind;
  provider: ProviderId;
  model: string;
  effort: Effort;
};

/**
 * 録音に固定した工程（snapshot）から、NIHO の API へ渡す工程の一覧を作る。`stepIds` を渡せばその工程だけを渡した順に、
 * 省けばフローの全工程をフローの順に。種類は remoteStepKind（フロー全体での位置）、モデルは snapshot に固定した値のまま。
 * フローに無い工程・モデルが固定されていない工程があれば投げる（利用者向けの文は呼ぶ側が出す）。
 */
export function remoteRunSteps(
  snapshot: {
    readonly steps: readonly { readonly id: string }[];
    readonly models: Readonly<Record<string, Pick<ResolvedStepModel, "provider" | "model" | "effort"> | undefined>>;
  },
  stepIds?: readonly string[],
): RemoteRunStep[] {
  return (stepIds ?? snapshot.steps.map((step) => step.id)).map((stepKey) => {
    const kind = remoteStepKind(snapshot, stepKey);
    const model = snapshot.models[stepKey];
    if (!kind || !model) throw new Error(`step model is not fixed: ${stepKey}`);
    return { stepKey, kind, provider: model.provider, model: model.model, effort: model.effort };
  });
}
