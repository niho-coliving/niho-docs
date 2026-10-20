import { isCommandError, type Bridge, type PersonalNihoAccess } from "./bridge";
import {
  NIHO_API_PROFILE_NAME,
  NIHO_API_STEP_PROVIDERS,
  matchesNihoApi,
  nihoApiModelSwap,
  nihoApiProvider,
  type FlowSnapshot,
  type NihoApiDescriptor,
  type ResolvedStepModel,
} from "@niho/docs-core";
import { PersonalDispatchError, PersonalRemoteRejectionError, type PersonalExecutionPorts, type PersonalFixedSnapshot } from "./personal-execution";

/**
 * 本人 Mac で確定した原文から NIHO API へ後続だけを渡す ports（#18740。controller の nihoApiReadiness・submitNihoContinuation）。
 * 本文は Native（src-tauri/src/personal_niho.rs）が捕捉した Store と同期の状態から組む。ここからは intent と受け付けた固定入力の
 * hash だけを渡し、controller の `NihoContinuationSubmission` を HTTP の本文にしない。token・本文はここへ来ない。
 */

/**
 * Native が「何も送っていない」ことを保証して返す code（controller は failed にする。結果不明にしない）。送った後の結果は
 * personal_niho_rejected・personal_niho_result_unknown だけで、ここには入らない（personal_niho.test.ts が Native のソースと照らす）。
 */
export const PERSONAL_NIHO_NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "bad_id",
  "personal_bad_request",
  "personal_guard_failed",
  "personal_operation_missing",
  "personal_intent_mismatch",
  "personal_intent_not_reserved",
  "personal_intent_closed",
  "personal_intent_io",
  "personal_snapshot_invalid",
  "personal_snapshot_mismatch",
  "personal_not_signed_in",
  "personal_io",
  "personal_niho_route",
  "personal_niho_pending_exists",
  "personal_niho_run_active",
  "personal_niho_recording_busy",
  "personal_niho_legacy_recording",
  "personal_niho_not_synced",
  "personal_niho_source_not_current",
  "personal_niho_source_candidate",
  "personal_niho_partial_saved",
  "personal_niho_steps_mismatch",
  "personal_niho_input_changed",
  "personal_niho_reference_unavailable",
  "personal_niho_too_large",
  "personal_niho_not_ready",
  "personal_niho_auth_required",
  "personal_niho_offline",
  "personal_niho_unavailable",
  "personal_niho_io",
  "personal_niho_closed",
]);

const UNKNOWN_MESSAGE = "クラウドの受付結果を確認できません。自動では送り直しません。";
const MODEL_MISMATCH = "この録音に固定された AI モデルはクラウドで使えないため、この Mac で続けてください。";
/** API の受付の上限（apps/api の plannedCalls 1..32）。 */
const MAX_PLANNED_CALLS = 32;

/** 今の受付の工程の AI（開示された提供元とモデル）。どちらかが無ければ null。 */
function nihoApiDescriptor(access: PersonalNihoAccess): NihoApiDescriptor | null {
  return access.provider && access.model ? { provider: access.provider, model: access.model } : null;
}

/**
 * 今の受付の条件で、この工程のモデルを NIHO の AI で動かせるか。提供元を NIHO の AI で動かせるか（nihoApiProvider）と、固定モデルが
 * NIHO の AI と同じか（matchesNihoApi）は docs-core の規則（Web・API と同じ。Native の check_access も同じ表で確かめる）。
 */
export function personalNihoModelsReadiness(
  access: PersonalNihoAccess,
  models: readonly (ResolvedStepModel | undefined)[],
): { ready: boolean; reason?: string } {
  if (!access.available) {
    if (access.reasonCode === "BUDGET_EXHAUSTED") return { ready: false, reason: "クラウドの利用上限に達しています。この Mac で続けられます。" };
    if (access.reasonCode === "PERMISSION_DENIED") return { ready: false, reason: "クラウドの利用が許可されていません。この Mac で続けられます。" };
    return { ready: false, reason: "クラウドの AI は今は使えません。この Mac で続けられます。" };
  }
  const descriptor = nihoApiDescriptor(access);
  if (!descriptor || !nihoApiProvider(descriptor.provider) || models.some((model) => !matchesNihoApi(model, descriptor))) {
    return { ready: false, reason: MODEL_MISMATCH };
  }
  return { ready: true };
}

/** 「続きを NIHO に任せる」で、選んだ工程を NIHO の AI で動かす計画（{@link personalNihoModelPlan}）。 */
export type PersonalNihoModelPlan =
  | {
      ready: true;
      /** 持ち替えた後の工程のモデル（選んだ工程の順。確認に出す）。 */
      models: ResolvedStepModel[];
      /** 録音に書く持ち替え（工程 → NIHO の AI のモデル）。持ち替えが要らなければ空。 */
      swap: Record<string, ResolvedStepModel>;
    }
  | { ready: false; reason: string };

/**
 * 選んだ工程の固定モデルのうち NIHO の AI と違うものを、押した時に NIHO の AI へ持ち替える計画（docs-core の nihoApiModelSwap。
 * Web の Mac で作った録音の続きと同じ規則）。利用できない・提供元を NIHO の AI で動かせない・持ち替えても合わなければ ready: false。
 */
export function personalNihoModelPlan(
  access: PersonalNihoAccess,
  flow: Pick<FlowSnapshot, "steps" | "models">,
  stepIds: readonly string[],
): PersonalNihoModelPlan {
  const descriptor = access.available ? nihoApiDescriptor(access) : null;
  const swap = descriptor ? nihoApiModelSwap(flow, stepIds, descriptor) : null;
  const models = stepIds.map((stepId) => swap?.[stepId] ?? flow.models[stepId]);
  const readiness = personalNihoModelsReadiness(access, models);
  if (!readiness.ready || !swap) return { ready: false, reason: readiness.reason ?? MODEL_MISMATCH };
  return { ready: true, models: models.filter((model): model is ResolvedStepModel => model !== undefined), swap };
}

/**
 * 押す前の「実行方法」の AI の欄に出す、NIHO の AI に固定した工程のモデル（docs-core の nihoApiStepModel の形＝プロファイル名
 * 「NIHO API」・NIHO の AI で動かせる提供元）。今の NIHO の AI は押した時に確かめるので、1 つでも違う工程があれば null
 * （押した時に NIHO の AI へ持ち替える）。
 */
export function personalNihoFixedModels(flow: Pick<FlowSnapshot, "steps" | "models">): ResolvedStepModel[] | null {
  const models: ResolvedStepModel[] = [];
  for (const step of flow.steps) {
    const model = flow.models[step.id];
    if (!model || model.profileName !== NIHO_API_PROFILE_NAME || !NIHO_API_STEP_PROVIDERS.includes(model.provider)) return null;
    models.push(model);
  }
  return models;
}

/** 今の受付の条件が、この固定入力（同意の版・工程のモデル）を受け付けるか。 */
export function personalNihoReadiness(access: PersonalNihoAccess, snapshot: PersonalFixedSnapshot): { ready: boolean; reason?: string } {
  const models = snapshot.selectedStepIds.map((stepId) => snapshot.fixedModels[stepId]);
  const modelsReady = personalNihoModelsReadiness(access, models);
  if (!modelsReady.ready) return modelsReady;
  if (access.consentVersion !== snapshot.consentVersion) {
    return { ready: false, reason: "クラウドの利用条件が更新されました。内容を確かめてから、もう一度実行してください。" };
  }
  return { ready: true };
}

/** submit の失敗を controller の区別へ: 断られた・結果不明・送っていない。知らない失敗は送った後とみなす（自動で送り直さない）。 */
export function personalNihoSubmitError(error: unknown): PersonalDispatchError {
  if (!isCommandError(error)) return new PersonalDispatchError(true, UNKNOWN_MESSAGE);
  if (error.code === "personal_niho_rejected") return new PersonalRemoteRejectionError(error.message);
  if (error.code === "personal_niho_result_unknown") return new PersonalDispatchError(true, error.message || UNKNOWN_MESSAGE);
  if (PERSONAL_NIHO_NOT_SENT_CODES.has(error.code)) return new PersonalDispatchError(false, error.message);
  return new PersonalDispatchError(true, UNKNOWN_MESSAGE);
}

export function createPersonalNihoPorts(
  bridge: Pick<Bridge, "personalNihoAccess" | "personalNihoSubmit">,
  handle: string,
): Pick<PersonalExecutionPorts, "nihoApiReadiness" | "submitNihoContinuation"> {
  return {
    async nihoApiReadiness({ snapshot }) {
      const planned = snapshot.selectedStepIds.length;
      if (planned < 1 || planned > MAX_PLANNED_CALLS) return { ready: false, reason: "クラウドで実行する工程がありません。" };
      let access: PersonalNihoAccess;
      try {
        access = await bridge.personalNihoAccess(handle, planned);
      } catch (error) {
        return { ready: false, reason: isCommandError(error) ? error.message : "クラウドの利用条件を確認できませんでした。" };
      }
      return personalNihoReadiness(access, snapshot);
    },
    async submitNihoContinuation(input) {
      try {
        const accepted = await bridge.personalNihoSubmit(handle, input.intentId, input.snapshotSha256);
        return { runId: accepted.runId, state: accepted.state, reasonCode: accepted.reasonCode ?? null };
      } catch (error) {
        throw personalNihoSubmitError(error);
      }
    },
  };
}
