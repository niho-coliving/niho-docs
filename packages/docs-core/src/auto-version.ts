/**
 * 成果物の版を自動で残す時の判定（owner 2026-10-18・#18912。spec niho-docs-cloud.md §8.2「版を残す時」）。Mac（apps/docs）と
 * Web/PWA が同じ規則を使う（Epic #18882）。版を作るボタンは置かず、次の時に版を 1 つ残す:
 *
 * - `idle`: 編集のまとまりの終わり（最後の入力から {@link DOCS_AUTO_VERSION_IDLE_MS}）
 * - `leave`: 文書を離れるとき（ページ・工程・別案・案件の切替、窓を閉じる）
 * - `before_ai`: AI がその文書を書き換える直前（工程の実行・再実行・「AIと作る」）
 * - `before_restore`: 古い版に戻す直前
 *
 * どの時も、この端末で版の後に利用者の編集があり、本文が空でなく、最新の版と中身が違うときだけ作る
 * （{@link shouldCreateAutoVersion}）。自動保存（本文だけを今の文書へ書く）のたびには作らない（spec §4 の 4）。
 * タイマー・保存・実行中の待ちは殻（Mac・Web）が持つ。ここは時刻と本文だけで決まる純粋な判定。
 */

import { finalizeMarkdown } from "./composer.js";

/** 編集のまとまりの区切り（最後の入力からこの時間、入力が無ければ版を残す）。 */
export const DOCS_AUTO_VERSION_IDLE_MS = 10 * 60_000;

/** 版を自動で残す理由。 */
export type DocsAutoVersionReason = "idle" | "leave" | "before_ai" | "before_restore";

export const DOCS_AUTO_VERSION_REASONS: readonly DocsAutoVersionReason[] = ["idle", "leave", "before_ai", "before_restore"];

/** 中身が同じか（保存する形 `finalizeMarkdown` にそろえて比べる。末尾の空白・改行の違いだけなら同じ）。 */
export function sameVersionContent(a: string, b: string): boolean {
  return finalizeMarkdown(a) === finalizeMarkdown(b);
}

export type AutoVersionInput = {
  /** この端末で、最新の版の後に利用者が本文を直した（リモートの適用・AI の書き換え・開いた直後の整形では立てない）。 */
  editedSinceVersion: boolean;
  /** 今の本文（書きかけ。無ければ今の文書）。 */
  current: string;
  /** 最新の版の本文（版がまだ無ければ null）。 */
  latestVersion: string | null;
  /**
   * 中身が違うか（殻のエディタの正規化。Mac の `isMarkdownChanged` のように、見た目が同じ書き方の違いを同じとみなす比べ方を
   * 渡す）。無ければ {@link sameVersionContent} で比べる。
   */
  isChanged?: (current: string, latestVersion: string) => boolean;
};

/**
 * 版を自動で 1 つ残すか。この端末で版の後に編集があり、今の本文が空でなく、最新の版と中身が違うときだけ true。
 * 版がまだ無い文書は、編集があり空でなければ true。
 */
export function shouldCreateAutoVersion(input: AutoVersionInput): boolean {
  if (!input.editedSinceVersion) return false;
  if (!finalizeMarkdown(input.current)) return false;
  if (input.latestVersion === null) return true;
  return input.isChanged
    ? input.isChanged(input.current, input.latestVersion)
    : !sameVersionContent(input.current, input.latestVersion);
}

/** 最後の入力の時刻から、`idle` で版を残す時刻。 */
export function autoVersionDueAt(lastEditAt: number, idleMs: number = DOCS_AUTO_VERSION_IDLE_MS): number {
  return lastEditAt + idleMs;
}

/** 今から `idle` の版を残すまでの待ち（ms。過ぎていれば 0）。殻はこの時間でタイマーを組み、入力のたびに組み直す。 */
export function autoVersionDelay(lastEditAt: number, now: number, idleMs: number = DOCS_AUTO_VERSION_IDLE_MS): number {
  return Math.max(0, autoVersionDueAt(lastEditAt, idleMs) - now);
}
