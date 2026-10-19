import { isLanguage, isSpeakerMode } from "./inputs.js";
import { EFFORTS, PROVIDER_IDS } from "./profiles.js";
import type { Effort, Flow, FlowSample, GlossaryEntry, Language, ProviderId, SpeakerMode, Step } from "./types.js";

/**
 * 保存した JSON（flows/<id>.json・recording.json）の「形」の検査（Epic #18882 S7-c）。Mac の画面・Web・API がこの検査を使い、
 * 受け付ける形を場所ごとに書き直さない。Rust は flows/*.json の検査だけ store_flows.rs に持つ（TS を呼べないため）。
 * apps/docs/fixtures/flow-shape/cases.json を Rust と shape.test.ts が同じように読み、同じ結果になることを確かめる。
 *
 * 形の検査は「欄があり、型が合う」ことだけを見る。意味の検査（名前の重複・空の指示文・プロファイルが設定にあるか）は validate.ts。
 * 知らない欄は通す（新しい版が足した欄で、古い版が読めなくならないように）。例外は recording.json の `info` だけ（2 欄に固定）。
 * 受け付ける形に既定値で補う道は作らない: 欄が足りない写しは、受付で断る（組み立ての段で初めて止まる写しを作らない）。
 */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** 0 以上の JavaScript safe integer。Rust 側も共有 fixture に合わせて同じ範囲に制限する。 */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && (EFFORTS as readonly string[]).includes(value);
}

/** 工程 id・録音 id・ページ id に使える id。API の `Id`・Web の `DOCS_SAFE_ID_PATTERN`・Rust の `safe_id` と同じ規則。 */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value);
}

export function isGlossaryEntryShape(value: unknown): value is GlossaryEntry {
  return (
    isObject(value) &&
    isString(value.term) &&
    isString(value.reading) &&
    isString(value.note) &&
    Array.isArray(value.variants) &&
    value.variants.every(isString)
  );
}

/** お手本の文書の 1 行。`sourceUrl` は画面の補足なので見ない（Rust の検査も見ない）。 */
export function isFlowSampleShape(value: unknown): value is FlowSample {
  return (
    isObject(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isCount(value.chars) &&
    (value.truncatedFrom === undefined || isCount(value.truncatedFrom))
  );
}

/** 工程 2 以降の 1 つ。工程 id の文字の規則は見ない（録音に固定するときに isFlowSnapshotShape が見る）。 */
export function isFlowStepShape(value: unknown): value is Step {
  return (
    isObject(value) &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.instruction) &&
    isString(value.profile) &&
    (value.provider === undefined || isProviderId(value.provider))
  );
}

/**
 * docs-core の Flow の形か。画面がそのまま描く欄と配列の要素まで見る。形の違うファイルは読まず、画面を止めない。
 * Mac の Rust（store_flows.rs の flow_shape_ok ＋ 中身の id が文字列）と同じ結果になる。
 */
export function isFlowShape(value: unknown): value is Flow {
  return (
    isObject(value) &&
    value.version === 1 &&
    isString(value.id) &&
    isString(value.name) &&
    isString(value.guide) &&
    isCount(value.revision) &&
    Array.isArray(value.terms) &&
    value.terms.every(isGlossaryEntryShape) &&
    Array.isArray(value.samples) &&
    value.samples.every(isFlowSampleShape) &&
    Array.isArray(value.steps) &&
    value.steps.every(isFlowStepShape)
  );
}

/** 録音に固定した工程のモデル。サーバーが実行に使う 3 欄だけ見る（profileId・profileName などの表示用の欄は見ない）。 */
export type SnapshotModelShape = { provider: ProviderId; model: string; effort: Effort; [key: string]: unknown };

export function isSnapshotModelShape(value: unknown): value is SnapshotModelShape {
  return isObject(value) && isProviderId(value.provider) && isString(value.model) && value.model.length > 0 && isEffort(value.effort);
}

/** 録音の flowSnapshot（Flow ＋ 工程 id ごとの固定したモデル）。models に無い工程があってよい（登録していない AI の工程）。 */
export type FlowSnapshotShape = Flow & { models: Record<string, SnapshotModelShape> };

/** 録音に固定できる Flow の写しの形か。Flow の形に加え、工程 id が安全な id で、models が固定したモデルの表であること。 */
export function isFlowSnapshotShape(value: unknown): value is FlowSnapshotShape {
  if (!isFlowShape(value)) return false;
  const models = (value as Flow & { models?: unknown }).models;
  return value.steps.every((step) => isSafeId(step.id)) && isObject(models) && Object.values(models).every(isSnapshotModelShape);
}

/**
 * recording.json の `info`（話者人数と言語の 2 欄だけ）。案件の固有名詞・背景は project.json の `info` が持つので、ここに知らない
 * 欄があれば断る（API はこの `info` を run の前提に保存し、prompt の案件情報と合わせて使うため、別の欄で案件情報を上書きさせない）。
 * Mac は保存のたびにこの 2 欄だけの形へそろえて書く（store.rs の canonical_recording）。
 */
export type StoredRecordingInfo = { speakers: SpeakerMode; language: Language };

export function isStoredRecordingInfoShape(value: unknown): value is StoredRecordingInfo {
  return isObject(value) && isSpeakerMode(value.speakers) && isLanguage(value.language) && Object.keys(value).length === 2;
}

/** recording.json の `source`。音声は inputs/ の写しのファイル名と SHA-256（16 進）を持つ。 */
export type StoredRecordingSource =
  | { kind: "audio"; audio: Array<{ file: string; hash: string; [key: string]: unknown }> }
  | { kind: "text" };

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function isStoredRecordingSourceShape(value: unknown): value is StoredRecordingSource {
  if (!isObject(value)) return false;
  if (value.kind === "text") return true;
  return (
    value.kind === "audio" &&
    Array.isArray(value.audio) &&
    value.audio.every(
      (item) => isObject(item) && isString(item.file) && item.file.length > 0 && isString(item.hash) && SHA256_HEX.test(item.hash),
    )
  );
}

/**
 * recording.json（保存した形）。Mac は保存のたびにこの形へそろえて書き（store.rs の canonical_recording）、Web も同じ形で書く。
 * API は受付でも prompt の組み立てでもこの検査を通ったものだけを読む。`refs` は無ければ参考なしではなく、必ず配列で持つ。
 */
export type StoredRecordingShape = {
  version: 1;
  id: string;
  pageId: string;
  flowSnapshot: FlowSnapshotShape;
  info: StoredRecordingInfo;
  source: StoredRecordingSource;
  refs: string[];
  [key: string]: unknown;
};

export function isStoredRecordingShape(value: unknown): value is StoredRecordingShape {
  return (
    isObject(value) &&
    value.version === 1 &&
    isSafeId(value.id) &&
    isSafeId(value.pageId) &&
    isFlowSnapshotShape(value.flowSnapshot) &&
    isStoredRecordingInfoShape(value.info) &&
    isStoredRecordingSourceShape(value.source) &&
    Array.isArray(value.refs) &&
    value.refs.every(isSafeId)
  );
}
