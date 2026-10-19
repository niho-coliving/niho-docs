/**
 * 実行の経路の決め方（#18947）: 何をするかは押したボタン（録音のページの始め方）か、単独の工程の実行。続きをどこで作るかは設定
 * （`personalExecution.continuation`）。文字起こしは常にこの Mac。App の startRun と、実行の前に準備を確かめる工程（setupReasonFor）が
 * 同じ決め方を使う（押せるのに始めると準備不足で止まる、を作らない）。
 */

import { SOURCE_STEP_ID, type RunStartAction } from "@niho/docs-core";
import type { PersonalRoute } from "./personal-execution";
import type { ContinuationExecutor } from "./settings";

export type StartRoute = {
  route: PersonalRoute;
  /** この Mac で原文だけを作り、成功したら続きをクラウドで始める（「文書作成を開始」で続きがクラウドのとき）。 */
  chainToCloud: boolean;
};

/**
 * 経路を決める。
 * - `step`: 録音のページのボタン以外（単工程・別案・会話からの再実行・子ページの「残りの工程を実行」）から始めた
 * - 原文だけの単工程と「文字起こしだけ」は後続を呼ばない
 * - 原文を含まない単工程・別案・会話からの再実行は、CLOUD ではこの Mac、LOCAL で NIHO API を選んだときは端末から一時配送する
 * - 原文を含まない続きは設定の場所。原文から作るときは、続きがこの Mac なら全工程、クラウドなら原文だけ作ってからクラウドへ
 */
export function startRouteOf(input: {
  queue: readonly string[];
  step: boolean;
  action: RunStartAction | null;
  continuation: ContinuationExecutor;
  localStorage?: boolean;
  deviceDeliveryAvailable?: boolean;
}): StartRoute {
  const { queue, action } = input;
  const withSource = queue.includes(SOURCE_STEP_ID);
  const deviceDelivery = input.localStorage && input.continuation === "niho_api" && input.deviceDeliveryAvailable === true;
  const sourceOnly = action === "transcribeOnly" || (input.step && queue.length === 1 && queue[0] === SOURCE_STEP_ID);
  if (sourceOnly) return { route: { kind: "local_transcription_only" }, chainToCloud: false };
  if (action === null && input.step && !withSource && !deviceDelivery) {
    return { route: { kind: "generation_only", executor: "this_pc" }, chainToCloud: false };
  }
  if (!withSource) return { route: { kind: "generation_only", executor: deviceDelivery ? "device_niho_api" : input.continuation }, chainToCloud: false };
  if (input.continuation === "niho_api") return { route: { kind: "local_transcription_only" }, chainToCloud: true };
  return { route: { kind: "local_full" }, chainToCloud: false };
}

/**
 * 実行の前に準備（AI の導入・ログイン、音声モデル）を確かめる工程。null はこの Mac の準備を見ない（続きをクラウドに任せる）。
 * `mode`: true は単独の工程、始め方はそのボタン、false はボタン以外から始めた実行（startRouteOf の step）。
 */
export function setupQueueOf(
  queue: readonly string[],
  mode: boolean | RunStartAction,
  continuation: ContinuationExecutor,
  localStorage = false,
  deviceDeliveryAvailable = false,
): readonly string[] | null {
  if (mode === true) return localStorage && deviceDeliveryAvailable && continuation === "niho_api" && !queue.includes(SOURCE_STEP_ID) ? null : queue;
  const { route } = startRouteOf({ queue, step: mode === false, action: mode === false ? null : mode,
    continuation, localStorage, deviceDeliveryAvailable });
  if (route.kind === "local_transcription_only") return [SOURCE_STEP_ID];
  if (route.kind === "generation_only") return route.executor === "niho_api" || route.executor === "device_niho_api" ? null : queue.filter((id) => id !== SOURCE_STEP_ID);
  return queue;
}
