import { buildFlowChoices,createBlankFlow,createFlowFromTemplate,defaultFlowChoice,flowChoiceKey,uniqueFlowName,type Flow,type FlowDesignDiff,type RunRecord } from "@niho/docs-core";
import { type FlowChoice } from "../components/FlowPicker";
import { type PersonalNihoAccess,type ProjectId,type RecordingRef } from "../lib/bridge";
import { newId } from "../lib/format";
import { fileStem } from "../lib/names";
import { activeProviders,effectiveEngine,type AppSettings } from "../lib/settings";

export type Phase = "loading" | "ready" | "error";
/** 「工程設計で作る」を押した録音（画面の名前と、押したときの移動の番号）。 */
export type FlowOrigin = { rec: RecordingRef; pageId: string; title: string; navigation: number };
/** 音声（フォルダの録音）を作った後に続けること（文章を入れる・録音を始める。#18914）。 */
export type RecordingThen = (rec: RecordingRef, pageId: string) => Promise<void>;
export type Draft = { markdown: string };
/** 履歴で開いた古い版（読むだけ。#18912）。表示している成果物の鍵と保存先が同じ間だけ出す。 */
export type ViewingVersion = { key: string; scopeId: string | null; version: number; versionPath?: string; markdown: string };
export type OpenedArtifactDocument = {
  key: string;
  handle: string;
  contextGeneration: number;
  scopeId: string;
  markdown: string;
  sha256: string | null;
};
export type CandidateDialogState = {
  projectId: ProjectId;
  pageId: string;
  recordingId: string;
  stepId: string;
  /** 別案を作る工程の名前（ダイアログの見出し。工程設計で付けた名前）。 */
  stepName: string;
  mode: "generate" | "duplicate";
  name: string;
  instruction: string;
  /** ダイアログを開いた対象録音内の複製元。処理中の画面選択には追随させない。 */
  sourceCandidateId: string | null;
  sourceArtifactId: string;
  sourceName: string;
};
export type NihoRunConfirmation = {
  access: PersonalNihoAccess;
  capturedKey: string;
  context: { generation: number | null; scopeId: string | null };
  modelLabel: string;
  /** 同意の後に、録音に固定した AI を NIHO の AI へ持ち替える。 */
  swap: boolean;
  sourceVersionLabel: string;
  accept: () => void;
  cancel: () => void;
};
/** トーストに添える操作（「作り直しました」の「元に戻す」だけ。#18915）。 */
export type ToastAction = { label: string; run: () => void };
/** 録音から作ったページの「作り直す」（⋯・本文の上の知らせ）で始めた実行。前の版があれば、終わった後に「元に戻す」を出す。`latestBefore` は作り直す前の最新の版の印（versionKey。版が無ければ null）。 */
export type RebuildRequest = { stepId: string; latestBefore: string | null };
/**
 * 「元に戻す」で戻す先（作り直しの直前の版）と、作り直しで足した版（その後に変わっていたら戻さない）。
 * 同じ番号の版が 2 台の Mac で別々に保存されることがあるので、版は番号でなく versionPath（無ければ番号）の印で見分ける。
 */
export type RebuildUndo = {
  rec: RecordingRef;
  viewKey: string;
  stepId: string;
  stepName: string;
  previousVersion: number;
  previousPath?: string;
  createdVersion: number;
  createdKey: string;
};

/** 版の印。同じ番号の別の版を取り違えないよう、versionPath があればそれで、無ければ番号で見分ける。 */
export const versionKey = (record: Pick<RunRecord, "version" | "versionPath">) => record.versionPath ?? `#${record.version}`;

/** 書きかけの鍵（`key` は録音の見え方の鍵 `${projectId}/${recordingId}`。chat.ts の draftKeyOf と同じ形）。 */
export const draftKey = (key: string, stepId: string) => `${key}::${stepId}`;
/** 同じ論理IDが別Rootにあっても、自動保存queueを共有しない。 */
export const artifactSaveKey = (key: string, scopeId: string) => `${key}::scope:${scopeId}`;
/** 打ちかけのページの名前の鍵。 */
export const titleKey = (projectId: ProjectId, pageId: string) => `${projectId ?? "_outside"}/${pageId}`;
export const audioTitle = (name: string) => fileStem(name.replace(/\.[^.]+$/, ""));
/** 工程の無いフロー（白紙から選んで、まだ工程を足して保存していない）では録音のページを作れない。 */
export const RUNNING_IN_PROJECT = "このフォルダは実行中です。終わってから、もう一度お試しください。";
/** 録音の工程を作り直すときの確かめの文（「今の設計に更新」と、別のフローを選んだとき）。 */
export const KEEPS_ARTIFACTS = "作ったページは残ります。元にした内容が変わったページは、本文の上でお知らせします。作り直すまで中身は変わりません。";
/** 逐次表示を描き直す間隔（細かい差分ごとに Markdown を組み直さない）。 */
export const LIVE_FLUSH_MS = 120;
/** 窓を閉じる前に文書の書きかけを書き終えるのを待つ上限（書き込みが終わらなくても窓を閉じられるように）。 */
export const CLOSE_FLUSH_MS = 5000;
export const NO_RECORDING = { code: "store_no_recording", message: "録音のページが見つかりません。" };
/** NIHO クラウドで守る（開いている間は別の Mac の変更の反映を延ばす）案件情報・あなたについて の path。 */
export const PROJECT_FILE = ["project.json"];
export const ABOUT_FILE = ["about.json"];
export const DOC_FLUSH_FAILED = Symbol("doc-flush-failed");

/**
 * 「この録音の工程を今の設計に更新」の確認に出す違い（空の項目は出さない）。`unregistered` は登録を外した AI に解決済みの工程
 * （更新すると登録した AI で解決し直す）。
 */
export function flowDiffLines(diff: FlowDesignDiff, unregistered: readonly string[]): string[] {
  const lines: string[] = [];
  if (unregistered.length > 0) lines.push(`登録した AI に切り替わる工程: ${unregistered.join("・")}`);
  if (diff.added.length > 0) lines.push(`増える工程: ${diff.added.join("・")}`);
  if (diff.removed.length > 0) lines.push(`外れる工程: ${diff.removed.join("・")}（作ったページは残ります）`);
  if (diff.renamed.length > 0) lines.push(`名前が変わる工程: ${diff.renamed.map((item) => `${item.from} → ${item.to}`).join("・")}`);
  if (diff.instructions.length > 0) lines.push(`指示文が変わる工程: ${diff.instructions.join("・")}`);
  if (diff.models.length > 0) lines.push(`モデルが変わる工程: ${diff.models.join("・")}`);
  if (diff.reordered) lines.push("工程の順序が変わります");
  if (diff.guide) lines.push("文書ガイドか固有名詞が変わります");
  return lines;
}

/**
 * 新しい録音のページの既定のフロー（P4 #18567・#18883）。Web/PWA と同じ docs-core の規則: 最後に使ったフローが使えればそれ、
 * 無ければ並びの先頭の使えるフロー、それも無ければ無し（テンプレートは既定にしない）。
 */
export function defaultFlowOf(flows: readonly Flow[], lastUsed: string | null): Flow | null {
  const found = defaultFlowChoice(buildFlowChoices(flows).options, [lastUsed ? flowChoiceKey("flow", lastUsed) : null]);
  return found?.kind === "flow" ? found.flow : null;
}

/** 工程設計で開くフロー（一覧で選んだフロー、無ければ最後に使ったフロー、無ければ並びの先頭。工程の無いフローも開ける）。 */
export function designFlowOf(flows: readonly Flow[], designFlowId: string | null, lastUsed: string | null): Flow | null {
  return flows.find((candidate) => candidate.id === designFlowId) ?? flows.find((candidate) => candidate.id === lastUsed) ?? flows[0] ?? null;
}

/** 実行の前の準備を取り直す印（接続の方式・登録した AI・文字起こしのエンジンと言語）。 */
export function readinessKeyOf(settings: AppSettings): string {
  return [settings.connection, activeProviders(settings).join(","), effectiveEngine(settings), settings.transcription.language].join("|");
}

/** 「工程を選ぶ」・「＋ 追加」で作るフロー（テンプレートか白紙。名前はほかのフローと重ならない）。 */
export function newFlowOf(choice: FlowChoice, flows: readonly Flow[]): Flow {
  const id = newId("flow");
  const created = choice === "blank" ? createBlankFlow(id) : createFlowFromTemplate(choice, id);
  return { ...created, name: uniqueFlowName(created.name, flows) };
}

/**
 * 画面の分岐（起動中・ログイン画面・本体）の外に、共通の確認（ログアウトの確認など。`niho-ui` の appDialog）を描く先を置く（L6 #18558）。
 */
