import {
  COMPOSER_PAGES_MAX,
  COMPOSER_REFERENCES_MAX,
  MATERIAL_PACK_BUDGET,
  PAGE_SNAPSHOT_MAX_BYTES,
  SOURCE_STEP_ID,
  candidatesFor,
  composerChangedNote,
  composerEmptiedNote,
  composerFileNames as sharedComposerFileNames,
  composerPageFile,
  composerPageIds,
  composerReferenceFile,
  composerSnapshotTooLargeNote,
  countChars,
  newDocumentTitle,
  pageSnapshotBytes,
  pageTitle,
  type ComposerPrompt,
  type ComposerRequest,
  type TurnPageChange,
} from "@niho/docs-core";
import { isCommandError, type Bridge, type ChatNewDocument, type ChatPageChange, type ProjectId } from "./bridge";
import { finalizeMarkdown, isMarkdownChanged } from "./markdown";
import { loadRecordingView, openProjectOf } from "./project-view";

/**
 * 「AIと作る」の composer（#18722）。Cursor の composer と同じく、どのページで開いても既存の文書を直せて、新しい文書も作れる。
 *
 * - 作業場所には、開いている録音の文字起こし・成果物（録音ページ・成果物の子ページ）に加えて、同じ場所（フォルダ、または
 *   フォルダの外）の文書ページを直せる形で、ほかの録音の成果物を読むだけの形で写す（Rust の conversation.rs）。
 * - 依頼の後、直した文書ページは前の本文を会話に控えてから保存し（変更を見る・元に戻す）、新しい文書は開いているページの直後に
 *   文書ページとして足す（開く）。依頼の間に人が直した文書ページは上書きしない。
 * - 名前の完全一致で新しい文書を作っていた旧経路（派生文書・#18681）はこれに統合した。
 */

export type ComposerPage = { pageId: string; name: string; body: string };
export type ComposerReference = { pageId: string; artifactId: string; name: string; body: string };

export type ComposerPlace = {
  projectId: ProjectId;
  /** 開いているページ（文書ページか録音ページ。成果物の子ページはその録音ページ）。 */
  currentPageId: string;
  currentName: string;
  /** 開いているのが録音ページか（録音の文書は artifacts/ に写る。文書ページなら false）。 */
  recording: boolean;
  /** 同じ場所の文書ページ（直せる）。 */
  pages: ComposerPage[];
  /** ほかの録音の成果物（読むだけ）。 */
  references: ComposerReference[];
  /** 開いている録音の文書を読むだけにする理由（複数案があって案を開いていない録音ページ。直せるときは null）。 */
  recordingReadOnly: string | null;
};

/**
 * Rust が作業場所に写す上限・新しい文書の題・会話の控えの上限は、NIHO API の composer（#18748）と同じ値で動くよう
 * @niho/docs-core（composer.ts）に置いた。ここからも今までどおり読めるよう同じ名前で出す。
 */
export {
  COMPOSER_PAGES_MAX,
  COMPOSER_REFERENCES_MAX,
  CONVERSATION_SNAPSHOT_BUDGET_BYTES,
  PAGE_SNAPSHOT_MAX_BYTES,
  fitPageSnapshots,
  markPageUndone,
  newDocumentTitle,
} from "@niho/docs-core";

/** 開いているページと同じ場所の文書ページ・ほかの録音の成果物を読む（送る直前に。書きかけは呼ぶ側が先に保存する）。 */
export async function loadComposerPlace(
  bridge: Bridge,
  projectId: ProjectId,
  current: { pageId: string; recording: boolean; readOnly?: string | null },
): Promise<ComposerPlace> {
  const open = openProjectOf(await bridge.loadPages(projectId));
  const pages: ComposerPage[] = [];
  const references: ComposerReference[] = [];
  let currentName = "";
  const docIds = composerPageIds(open.pages.filter((page) => page.kind === "doc").map((page) => page.id), current.pageId);
  for (const page of open.pages) {
    if (page.kind === "doc") {
      const name = page.title.trim() || "無題";
      if (page.id === current.pageId) currentName = name;
      if (!docIds.has(page.id)) continue;
      const body = await bridge.readPage(projectId, page.id).catch(() => null);
      if (body !== null) pages.push({ pageId: page.id, name, body });
      continue;
    }
    const view = await loadRecordingView(bridge, projectId, open.project, page, []).catch(() => null);
    if (!view) continue;
    const title = pageTitle(view.page, view.recording);
    if (page.id === current.pageId) {
      currentName = title;
      continue;
    }
    if (view.source.trim()) references.push({ pageId: page.id, artifactId: SOURCE_STEP_ID, name: `${title} / ${view.sourceName}`, body: view.source });
    for (const step of view.flow.steps) {
      const candidates = candidatesFor(view.recording, step.id);
      const choices = candidates.length
        ? candidates.map((candidate) => ({ artifactId: candidate.artifactId, name: `${step.name} / ${candidate.name}` }))
        : [{ artifactId: step.id, name: step.name }];
      for (const choice of choices) {
        const body = view.artifacts[choice.artifactId] ?? "";
        if (body.trim()) references.push({ pageId: page.id, artifactId: choice.artifactId, name: `${title} / ${choice.name}`, body });
      }
    }
  }
  return {
    projectId,
    currentPageId: current.pageId,
    currentName,
    recording: current.recording,
    pages,
    references: references.slice(0, COMPOSER_REFERENCES_MAX),
    recordingReadOnly: current.recording ? (current.readOnly ?? null) : null,
  };
}

/** Rust へ渡す作業場所の中身（id だけ。本文は Rust が正本から読む）。 */
export function composerRequest(place: ComposerPlace): ComposerRequest {
  return {
    recording: place.recording,
    pages: place.pages.map((page) => page.pageId),
    references: place.references.map((ref) => ({ page_id: ref.pageId, artifact_id: ref.artifactId })),
    ...(place.recordingReadOnly ? { recording_writable: false } : {}),
  };
}

/** システム側の「## 文書の一覧」に並べる名前。 */
export function composerPrompt(place: ComposerPlace): ComposerPrompt {
  return {
    recording: place.recording,
    current: place.currentName,
    pages: place.pages.map((page) => ({ pageId: page.pageId, name: page.name })),
    references: place.references.map((ref) => ({ pageId: ref.pageId, artifactId: ref.artifactId, name: ref.name })),
    recordingReadOnly: place.recordingReadOnly,
  };
}

/** Codex の資料パックで省いた、ほかの録音の文書の本文の代わり。 */
export const COMPOSER_REFERENCE_OMITTED = "（長いため本文を省きました。この文書が要るときは、その録音のページで頼むよう伝えてください。）";

/**
 * Codex（ファイルを読めない）の完全な資料パックに足す文書ページ・読むだけの成果物。直せる文書ページは全文。ほかの録音の文書は
 * 通常の資料パックと同じ予算（字数）までを、成果物 → 文字起こしの順に本文で載せ、超えた分は名前だけにする（毎回すべてを送ると、
 * 録音の多いフォルダで文脈を使い切る）。
 */
export function composerExtra(place: ComposerPlace, budget = MATERIAL_PACK_BUDGET): Array<{ file: string; name: string; body: string }> {
  const ordered = [...place.references].sort((a, b) => Number(a.artifactId === SOURCE_STEP_ID) - Number(b.artifactId === SOURCE_STEP_ID));
  let left = budget;
  const references = ordered.map((ref) => {
    const chars = countChars(ref.body);
    const fits = chars <= left;
    if (fits) left -= chars;
    return { file: composerReferenceFile(ref.pageId, ref.artifactId), name: `${ref.name}（読むだけ）`, body: fits ? ref.body : COMPOSER_REFERENCE_OMITTED };
  });
  return [...place.pages.map((page) => ({ file: composerPageFile(page.pageId), name: page.name, body: page.body })), ...references];
}

/**
 * 作業の行（「〈名前〉を読みました」）のファイル名 → 画面の名前。作業の行に出るのはパスの最後の部分だけなので、文書ページは
 * `<id>.md`、ほかの録音の文書は `<録音の id>.<成果物の id>.md`（composerReferenceFile）、置き場のフォルダは名前で引く。
 */
export function composerFileNames(place: ComposerPlace): Record<string, string> {
  return sharedComposerFileNames(place);
}

/**
 * 依頼の後、AI が直した文書ページを保存し、作った文書を文書ページとして足す。依頼の間に変わった文書ページ・空になった文書は
 * 反映せず、知らせ（notes）にする。新しい文書は開いているページの直後に並べる。
 */
export async function applyComposerChanges(input: {
  bridge: Bridge;
  place: ComposerPlace;
  pages: readonly ChatPageChange[];
  created: readonly ChatNewDocument[];
  now: () => Date;
}): Promise<{ changes: TurnPageChange[]; notes: string[] }> {
  const { bridge, place } = input;
  const changes: TurnPageChange[] = [];
  const notes: string[] = [];
  for (const change of input.pages) {
    const page = place.pages.find((candidate) => candidate.pageId === change.pageId);
    if (!page) continue;
    const markdown = finalizeMarkdown(change.markdown);
    if (!markdown.trim()) {
      notes.push(composerEmptiedNote(page.name));
      continue;
    }
    if (!isMarkdownChanged(markdown, page.body)) continue;
    const current = await bridge.readPage(place.projectId, page.pageId).catch(() => null);
    if (current === null || isMarkdownChanged(current, page.body)) {
      notes.push(composerChangedNote(page.name));
      continue;
    }
    await bridge.writePage(place.projectId, page.pageId, markdown);
    // 長い文書は直す前・後の本文を会話に控えない（会話ファイルの上限を超えて、記録・差分・元に戻すがすべて失われないように）
    const snapshot: Pick<TurnPageChange, "before" | "after"> = { before: page.body, after: markdown };
    const fits = pageSnapshotBytes(snapshot) <= PAGE_SNAPSHOT_MAX_BYTES;
    if (!fits) notes.push(composerSnapshotTooLargeNote(page.name));
    changes.push({
      pageId: page.pageId,
      title: page.name,
      change: "edited",
      chars: countChars(markdown),
      delta: countChars(markdown) - countChars(page.body),
      ...(fits ? snapshot : {}),
    });
  }
  // 新しい文書: 開いているページの直後に、作った順に並べる。依頼の完了処理は実行ロックを持ったままなので、ページの移動
  // （move_page はロック中だと止まる）ではなく、一度の台帳更新で直後に挿入する createPage(afterPageId) を使う
  let anchor = place.currentPageId;
  for (const document of input.created) {
    const markdown = finalizeMarkdown(document.markdown);
    if (!markdown.trim()) continue;
    const title = newDocumentTitle(document.file, markdown);
    const createdAt = input.now().toISOString();
    const entry = await bridge.createPage(place.projectId, { kind: "doc", title, createdAt, afterPageId: anchor })
      .catch((error: unknown) => {
        // 開いていたページが依頼の途中で消えたときは末尾に足す（文書は残す）
        if (!isCommandError(error) || error.code !== "store_no_page") throw error;
        return bridge.createPage(place.projectId, { kind: "doc", title, createdAt });
      });
    await bridge.writePage(place.projectId, entry.id, markdown);
    anchor = entry.id;
    changes.push({ pageId: entry.id, title, change: "created", chars: countChars(markdown), delta: countChars(markdown) });
  }
  return { changes, notes };
}

/** 「元に戻す」: AI が直した文書ページを、直す前の本文に戻す（その後に人が直していたら戻さない）。 */
export async function undoPageChange(input: { bridge: Bridge; projectId: ProjectId; change: TurnPageChange }): Promise<void> {
  const { bridge, projectId, change } = input;
  if (change.change !== "edited") {
    throw { code: "undo_new_document", message: "AI が新しく作った文書は戻せません。要らなければ、ページの ⋯ から削除してください。" };
  }
  if (change.before === undefined || change.after === undefined) {
    throw { code: "undo_unavailable", message: `${change.title}は長いため、直す前の本文を控えていません。元に戻せません。` };
  }
  const current = await bridge.readPage(projectId, change.pageId);
  if (isMarkdownChanged(current, change.after)) {
    throw { code: "undo_changed", message: `${change.title}はその後に変わっているため、元に戻せません。` };
  }
  await bridge.writePage(projectId, change.pageId, change.before);
}
