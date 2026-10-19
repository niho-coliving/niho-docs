import {
  SOURCE_STEP_ID,
  cliLabel,
  contractProvider,
  type ContractProvider,
  type FlowSnapshot,
  type ProviderId,
  type ProviderStatus,
  type TranscriptionEngine,
} from "@niho/docs-core";
import type { SpeechStatus } from "./bridge";
import { stepModel } from "./runner";
import { activeProviders, effectiveEngine, engineRunsHere, rememberedSpeechSupport, type AppSettings, type SpeechUnsupported } from "./settings";

/** 実行の前に確かめた準備の状態（undefined はまだ確かめていない、null は確かめられなかった）。 */
export type RunReadinessStatuses = {
  providers: Partial<Record<ContractProvider, ProviderStatus | null>>;
  speech: SpeechStatus | null | undefined;
};

function providerReason(provider: ProviderId, status: ProviderStatus | null | undefined): string | null {
  if (!status) return null;
  if (!status.installed) return `${cliLabel(provider)} を導入すると実行できます`;
  if (!status.authenticated) return `${cliLabel(provider)} にログインすると実行できます`;
  return null;
}

/** この Mac で動かない文字起こしのエンジンのときの理由（代わりの手段まで 1 行で）。 */
function unsupportedReason(engine: TranscriptionEngine, unsupported: SpeechUnsupported | null | undefined): string | null {
  if (!unsupported || engineRunsHere(engine, unsupported)) return null;
  return unsupported === "os"
    ? "この macOS では音声を処理できません。Deepgram（API キー方式）を登録すると実行できます"
    : "この Mac では音声認識を使えません。Gemini か Deepgram（API キー方式）を登録すると実行できます";
}

/**
 * 「工程を実行」の前に分かる準備の不足を 1 行で返す（録音のページの実行の帯。設定への導線と一緒に出す）。見るのは、これから実行する
 * 工程の AI の CLI が未導入・未ログインか、文字起こしのエンジンがこの Mac で動かないか（#18753）、この Mac の文字起こしの音声モデルが
 * 未取得かだけ。まだ確かめていない・確かめられなかったものと、API キー方式の AI は止めない（実行の失敗が理由を出す）。登録していない
 * AI の工程は「この録音の工程を今の設計に更新」が案内する。
 */
export function runSetupReason(input: {
  queue: readonly string[];
  flow: FlowSnapshot;
  settings: AppSettings;
  statuses: RunReadinessStatuses;
}): string | null {
  const { queue, flow, settings, statuses } = input;
  const subscription = settings.connection === "subscription";
  const registered = activeProviders(settings);
  if (queue.includes(SOURCE_STEP_ID)) {
    const speech = statuses.speech;
    // 確かめた結果があればそれでエンジンを決める。確かめられなかった（再確認の失敗）・まだ確かめていないときは、覚えている結果で
    // 決める（実行と同じ）。理由も同じ結果から出す: 再確認が一時的に失敗しても、動かないエンジンの理由を消して実行を通さない
    const unsupportedState = speech ? (speech.unsupported ?? null) : rememberedSpeechSupport();
    const engine = effectiveEngine(settings, unsupportedState);
    const unsupported = unsupportedReason(engine, unsupportedState);
    if (unsupported) return unsupported;
    if (engine === "this-mac") {
      if (speech?.found && (speech.needsDownload || speech.diarization.state === "corrupt")) {
        return "この Mac の音声モデルを取得すると実行できます";
      }
    } else if (engine === "gemini" && subscription) {
      const reason = providerReason("gemini", statuses.providers[contractProvider("gemini")]);
      if (reason) return reason;
    }
  }
  if (!subscription) return null;
  for (const stepId of queue) {
    if (stepId === SOURCE_STEP_ID) continue;
    const model = stepModel(flow, stepId, settings);
    if (!model || !registered.includes(model.provider)) continue;
    const reason = providerReason(model.provider, statuses.providers[contractProvider(model.provider)]);
    if (reason) return reason;
  }
  return null;
}
