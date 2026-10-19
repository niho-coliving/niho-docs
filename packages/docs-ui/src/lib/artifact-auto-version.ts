import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  DOCS_AUTO_VERSION_IDLE_MS,
  autoVersionDelay,
  shouldCreateAutoVersion,
  type ArtifactCandidate,
  type DocsAutoVersionReason,
  type RunRecord,
} from "@niho/docs-core";
import { errorMessage, type ProjectId } from "./bridge";
import type { DraftTarget } from "./artifact-autosave";
import { finalizeMarkdown, isMarkdownChanged } from "./markdown";

/**
 * 成果物・文字起こしの版を自動で残す（owner 2026-10-18・#18912。spec niho-docs-cloud §8.2「版を残す時」）。版を作るボタンは
 * 置かず、文書ごとに「この端末で版の後に利用者が直したか」を持ち、次の時に版を 1 つ残す（判定は docs-core の
 * `shouldCreateAutoVersion`。Web と同じ規則）:
 *
 * - `idle`: 最後の入力から `DOCS_AUTO_VERSION_IDLE_MS`（このフックのタイマー）
 * - `leave`: 文書を離れるとき（App が本文の書き残しの後に `createWhere`）
 * - `before_ai`: AI がその文書を書き換える直前（工程の実行・「AIと作る」の依頼・元に戻す）
 * - `before_restore`: 古い版に戻す直前
 *
 * 自動保存（artifact-autosave。本文だけを今の文書へ書く）のたびには作らない。版の前に、その書きかけを今の文書へ書き終える。
 * 工程の実行中・「AIと作る」の依頼中（`blocked`）は作らずに待ち、`resume` で作る（取りこぼさない）。作れなかったときは
 * `onError` で知らせ、本文の保存とは切り離す（版が作れなくても入力は失わない）。
 */

export type AutoVersionTarget = DraftTarget & {
  /** 版の記録の工程 id（別案なら案の工程。実行の対象かを見る）。 */
  flowStepId: string;
  /** 版の記録の工程の名前（別案なら案の名前）。 */
  stepName: string;
  /** 記事本文の別案（無ければ工程の文書）。 */
  candidate: ArtifactCandidate | null;
};

export type LatestVersion = {
  /** 最新の版の本文（版が無ければ null）。 */
  markdown: string | null;
  /** 最新の版の記録（前提・話者名を引き継ぐ）。 */
  record?: RunRecord;
};

type Entry = {
  target: AutoVersionTarget;
  /** この端末で、最新の版の後に利用者が直した。 */
  edited: boolean;
  /** 入力の通し番号（版を作る間に入力があれば、直したままにする）。 */
  seq: number;
  lastEditAt: number;
  timer: number | null;
  /** 実行・依頼の間で作れなかった理由（終わったら作る）。 */
  waiting: DocsAutoVersionReason | null;
  /** この端末が最後に版にした本文（保存する形）。 */
  versioned: string | null;
  chain: Promise<boolean>;
};

export type ArtifactAutoVersion = {
  /** 利用者が本文を直した（リモートの適用・AI の書き換え・開いた直後の整形では呼ばない）。 */
  edited: (key: string, target: AutoVersionTarget) => void;
  /** 版の後に直したか。 */
  isEdited: (key: string) => boolean;
  /** 条件を満たせば版を 1 つ残す。作った・作る必要が無かったなら true（作れなかった・待っているなら false）。 */
  create: (key: string, reason: DocsAutoVersionReason) => Promise<boolean>;
  /** 直した文書のうち `match` に当たるものを、それぞれ版にする（離れるとき・AI の前）。 */
  createWhere: (reason: DocsAutoVersionReason, match?: (key: string, target: AutoVersionTarget) => boolean) => Promise<boolean>;
  /** 実行・依頼が終わった後に、待っていた版を作る。 */
  resume: () => void;
  /** 別の経路で今の本文を版にした（話者名・この版に戻す）。直したかを外し、その本文を覚える。 */
  versioned: (key: string, markdown: string) => void;
  /** この本文は、この端末が最後に版にした本文と同じか（「AIと作る」の送る前の保存で同じ版を重ねない）。 */
  isVersioned: (key: string, markdown: string) => boolean;
  /** 書きかけを捨てた（変更の確認で解決した・最新を表示した）。直したかを外す。 */
  forget: (key: string) => void;
};

function clearTimer(entry: Entry) {
  if (entry.timer !== null) window.clearTimeout(entry.timer);
  entry.timer = null;
}

export function useArtifactAutoVersion(options: {
  /** その案件の実行のロックをこの窓が持っている（工程の実行・AIと作るの依頼）。 */
  blocked: (projectId: ProjectId) => boolean;
  /** 版にする前に、その書きかけを今の文書へ書き終える（書けなければ false。版は作らない）。 */
  flush: (key: string, target: AutoVersionTarget) => Promise<boolean>;
  /** 今の本文（書きかけ、無ければ今の文書）。分からない（保存先が変わった）なら null（版は作らない）。 */
  currentOf: (key: string, target: AutoVersionTarget) => string | null;
  /** 最新の版。 */
  latestOf: (key: string, target: AutoVersionTarget) => Promise<LatestVersion>;
  /** 版を作る（記録は App が組む）。 */
  save: (key: string, target: AutoVersionTarget, markdown: string, reason: DocsAutoVersionReason, latest: LatestVersion) => Promise<void>;
  onError: (message: string) => void;
  /** テストで短くする。 */
  idleMs?: number;
}): ArtifactAutoVersion {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const entries = useRef(new Map<string, Entry>());

  const create = useCallback((key: string, reason: DocsAutoVersionReason): Promise<boolean> => {
    const entry = entries.current.get(key);
    if (!entry) return Promise.resolve(true);
    const run = entry.chain.then(async (): Promise<boolean> => {
      if (entries.current.get(key) !== entry || !entry.edited) return true;
      const { blocked, flush, currentOf, latestOf, save, onError } = optionsRef.current;
      if (blocked(entry.target.rec.projectId)) {
        // 実行・依頼が終わってから作る（早い理由を残す）
        entry.waiting ??= reason;
        clearTimer(entry);
        return false;
      }
      entry.waiting = null;
      clearTimer(entry);
      const seq = entry.seq;
      const settle = () => {
        if (entry.seq === seq) entry.edited = false;
      };
      // 自動保存の途中の書きかけを先に書く（版の後に古い書きかけで今の文書を上書きしない）。書けなければ版も作らない
      if (!(await flush(key, entry.target))) return false;
      const current = currentOf(key, entry.target);
      if (current === null) return true;
      try {
        const latest = await latestOf(key, entry.target);
        if (
          !shouldCreateAutoVersion({
            editedSinceVersion: entry.edited,
            current,
            latestVersion: latest.markdown,
            isChanged: isMarkdownChanged,
          })
        ) {
          settle();
          return true;
        }
        const markdown = finalizeMarkdown(current);
        await save(key, entry.target, markdown, reason, latest);
        entry.versioned = markdown;
        settle();
        return true;
      } catch (error) {
        onError(errorMessage(error, "版を残せませんでした。本文は保存されています。"));
        return false;
      }
    });
    entry.chain = run.catch(() => false);
    return run;
  }, []);

  const edited = useCallback(
    (key: string, target: AutoVersionTarget) => {
      let entry = entries.current.get(key);
      if (!entry) {
        entry = {
          target,
          edited: false,
          seq: 0,
          lastEditAt: 0,
          timer: null,
          waiting: null,
          versioned: null,
          chain: Promise.resolve(true),
        };
        entries.current.set(key, entry);
      }
      entry.target = target;
      entry.edited = true;
      entry.seq += 1;
      entry.lastEditAt = Date.now();
      clearTimer(entry);
      const idleMs = optionsRef.current.idleMs ?? DOCS_AUTO_VERSION_IDLE_MS;
      entry.timer = window.setTimeout(() => {
        entry.timer = null;
        void create(key, "idle");
      }, autoVersionDelay(entry.lastEditAt, Date.now(), idleMs));
    },
    [create],
  );

  const createWhere = useCallback(
    async (reason: DocsAutoVersionReason, match?: (key: string, target: AutoVersionTarget) => boolean): Promise<boolean> => {
      const keys = [...entries.current].filter(([key, entry]) => entry.edited && (!match || match(key, entry.target))).map(([key]) => key);
      const results = await Promise.all(keys.map((key) => create(key, reason)));
      return results.every(Boolean);
    },
    [create],
  );

  const resume = useCallback(() => {
    for (const [key, entry] of entries.current) {
      if (entry.waiting && entry.edited && !optionsRef.current.blocked(entry.target.rec.projectId)) void create(key, entry.waiting);
    }
  }, [create]);

  const versioned = useCallback((key: string, markdown: string) => {
    const entry = entries.current.get(key);
    if (!entry) return;
    clearTimer(entry);
    entry.edited = false;
    entry.waiting = null;
    entry.versioned = finalizeMarkdown(markdown);
  }, []);

  const isVersioned = useCallback((key: string, markdown: string) => {
    const entry = entries.current.get(key);
    if (!entry || entry.versioned === null || entry.edited) return false;
    return !isMarkdownChanged(markdown, entry.versioned);
  }, []);

  const isEdited = useCallback((key: string) => entries.current.get(key)?.edited ?? false, []);

  const forget = useCallback((key: string) => {
    const entry = entries.current.get(key);
    if (!entry) return;
    clearTimer(entry);
    entries.current.delete(key);
  }, []);

  useEffect(
    () => () => {
      for (const entry of entries.current.values()) clearTimer(entry);
    },
    [],
  );

  return useMemo(
    () => ({ edited, isEdited, create, createWhere, resume, versioned, isVersioned, forget }),
    [edited, isEdited, create, createWhere, resume, versioned, isVersioned, forget],
  );
}
