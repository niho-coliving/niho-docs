import type { ConversationFile, TurnPageChange } from "./conversation.js";

/**
 * 「AIと作る」の composer（#18722）の純粋な決まり。Mac（apps/docs の composer.ts）と NIHO API（apps/api の composer、#18748）が
 * 同じ値・同じ文言で動くよう、ここに置く。どのページで開いても既存の文書を直せて、新しい文書も作れる。
 */

/**
 * 作業場所に写す文書ページ・ほかの録音の成果物の上限（Rust の conversation.rs の COMPOSER_PAGES_MAX・COMPOSER_REFERENCES_MAX と
 * 同じ値）。画面とプロンプトも同じ範囲だけを載せ、写していない文書を AI に見せない。文書ページは開いているページを必ず含める。
 */
export const COMPOSER_PAGES_MAX = 300;
export const COMPOSER_REFERENCES_MAX = 300;
/** 1 回の依頼で受け取る新しい文書の数と、1 つの文書の大きさ（バイト）の上限（conversation.rs と同じ）。 */
export const COMPOSER_NEW_MAX = 10;
export const COMPOSER_DOC_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 会話に控える直す前・後の本文の上限（会話ファイルは 4 MiB まで。store_conversations.rs の MAX_CONVERSATION_BYTES）。
 * 1 回の変更で before＋after がこれを超える長い文書は控えない（その変更は「変更を見る」「元に戻す」を出さない）。
 */
export const PAGE_SNAPSHOT_MAX_BYTES = 256 * 1024;
/** 会話 1 つの中の控えの合計。超えるときは古い依頼の控えから外す（会話・差分の記録の保存を失敗させない）。 */
export const CONVERSATION_SNAPSHOT_BUDGET_BYTES = 2 * 1024 * 1024;

/** 依頼が最後まで終わらなかったときの知らせ（新しい文書は作らない）。 */
export const COMPOSER_NOT_FINISHED_NOTE = "最後まで終わらなかったため、新しい文書は作っていません。";

/** 依頼の間に人が直した文書ページは上書きしない。 */
export function composerChangedNote(name: string): string {
  return `${name}は依頼の途中で変わったため、AI の変更を反映せず、今の内容を保ちました。`;
}

/** AI が文書ページを空にしたときは反映しない。 */
export function composerEmptiedNote(name: string): string {
  return `${name}が空になったため、AI の変更を反映しませんでした。`;
}

/** 直す前・後の本文を控えられない長い文書。 */
export function composerSnapshotTooLargeNote(name: string): string {
  return `${name}は長いため、変更の表示と元に戻すは使えません（文書は直しました）。`;
}

/** UTF-8 のバイト数（TextEncoder と同じ数え方。対になっていないサロゲートは置換文字の 3 バイト）。 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** 保存する形（末尾は改行 1 つ。空なら空文字）。 */
export function finalizeMarkdown(markdown: string): string {
  const trimmed = markdown.replace(/\s+$/u, "");
  return trimmed ? `${trimmed}\n` : "";
}

/** 作業場所に入れる文書ページの id（台帳の順。上限を超えたら、開いているページを残して後ろから外す）。 */
export function composerPageIds(docIds: readonly string[], currentPageId: string): Set<string> {
  if (docIds.length <= COMPOSER_PAGES_MAX) return new Set(docIds);
  const hasCurrent = docIds.includes(currentPageId);
  const others = docIds.filter((id) => id !== currentPageId).slice(0, COMPOSER_PAGES_MAX - (hasCurrent ? 1 : 0));
  return new Set(hasCurrent ? [currentPageId, ...others] : others);
}

/**
 * 作業の行（「〈名前〉を読みました」）のファイル名 → 画面の名前。作業の行に出るのはパスの最後の部分だけなので、文書ページは
 * `<id>.md`、ほかの録音の文書は `<録音の id>.<成果物の id>.md`（composerReferenceFile）、置き場のフォルダは名前で引く。
 */
export function composerFileNames(place: {
  pages: ReadonlyArray<{ pageId: string; name: string }>;
  references: ReadonlyArray<{ pageId: string; artifactId: string; name: string }>;
}): Record<string, string> {
  return {
    pages: "文書ページのフォルダ",
    new: "新しい文書のフォルダ",
    reference: "ほかの録音の文書",
    ...Object.fromEntries(place.pages.map((page) => [`${page.pageId}.md`, page.name])),
    ...Object.fromEntries(place.references.map((ref) => [`${ref.pageId}.${ref.artifactId}.md`, ref.name])),
  };
}

/** 新しい文書の題: 本文の最初の行が「# 題名」ならその題名、無ければファイル名（拡張子なし）。 */
export function newDocumentTitle(file: string, markdown: string): string {
  const first = markdown.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const heading = /^#\s+(.+?)\s*#*\s*$/.exec(first.trim())?.[1]?.trim();
  if (heading) return heading;
  return file.replace(/\.md$/i, "").trim() || "新しい文書";
}

/** 1 つの変更が控える直す前・後の本文のバイト数。 */
export function pageSnapshotBytes(change: Pick<TurnPageChange, "before" | "after">): number {
  return (change.before === undefined ? 0 : utf8ByteLength(change.before))
    + (change.after === undefined ? 0 : utf8ByteLength(change.after));
}

/** 会話の中の文書ページの「元に戻す」を記録する。 */
export function markPageUndone(conversation: ConversationFile, turnId: string, pageId: string, now: Date): ConversationFile {
  return {
    ...conversation,
    updatedAt: now.toISOString(),
    turns: conversation.turns.map((turn) =>
      turn.id !== turnId
        ? turn
        : { ...turn, pages: (turn.pages ?? []).map((entry) => (entry.pageId === pageId && entry.change === "edited" ? { ...entry, undone: true } : entry)) },
    ),
  };
}

/** 控えの合計が上限を超えないよう、古い依頼の直す前・後の本文から外す（変更の記録と字数は残す）。 */
export function fitPageSnapshots(conversation: ConversationFile): ConversationFile {
  let total = conversation.turns.reduce((sum, turn) => sum + (turn.pages ?? []).reduce((acc, change) => acc + pageSnapshotBytes(change), 0), 0);
  if (total <= CONVERSATION_SNAPSHOT_BUDGET_BYTES) return conversation;
  const turns = conversation.turns.map((turn) => {
    if (total <= CONVERSATION_SNAPSHOT_BUDGET_BYTES || !turn.pages?.some((change) => pageSnapshotBytes(change) > 0)) return turn;
    return {
      ...turn,
      pages: turn.pages.map((change) => {
        const bytes = pageSnapshotBytes(change);
        if (bytes === 0 || total <= CONVERSATION_SNAPSHOT_BUDGET_BYTES) return change;
        total -= bytes;
        const { before: _before, after: _after, ...rest } = change;
        return rest;
      }),
    };
  });
  return { ...conversation, turns };
}
