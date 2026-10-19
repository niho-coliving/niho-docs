import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, type Bridge, type ProjectId, type RecordingRef } from "./bridge";
import { pendingPhase, saveDue, type LocalPhase, type LocalSaveState } from "./cloud";
import { LOCAL_SAVE_IDLE_MS, LOCAL_SAVE_MAX_WAIT_MS } from "./cloud-types";
import { finalizeMarkdown } from "./markdown";

/**
 * 成果物・文字起こしの書きかけの自動保存（C3 #18595。spec niho-docs-cloud §7.2）。書きかけを、最後の入力から 250ms・最初の
 * 未保存の入力から 1 秒の早い方で、今の文書（`artifacts/<stepId>.md`・`transcript.md`）に書く（版は作らない。版は
 * artifact-auto-version が編集のまとまりごとに自動で残す・#18912）。書きかけごとに書く順を守り、ページ・案件を移る前と窓を
 * 閉じる前に App が `flushAll` で書き残す。
 *
 * - 消された書きかけは書かない（`draftOf` が null を返す）。古い版は読むだけで開くので、書きかけにならない。
 * - 案件の実行中（実行のロックを持つ間）は書かずに待ち、`resume` で書く。
 */

export type DraftTarget = {
  rec: RecordingRef;
  stepId: string;
  source: boolean;
  handle?: string;
  /** scope を含む保存queueの鍵とは別の、draft map の論理鍵。 */
  draftKey?: string;
  scopeId?: string;
};

type Entry = DraftTarget & {
  /** まだ書いていない書きかけ（null は無し）。 */
  pending: string | null;
  /** 最初の未保存の入力の時刻。 */
  since: number | null;
  timer: number | null;
  /** 250ms 後に「保存中」へ切り替える。 */
  showTimer: number | null;
  writing: boolean;
  failed: boolean;
  /** 実行中で書けなかった（終わったら書く）。 */
  blocked: boolean;
  /** 空の書きかけ（保存しない。状態も出さない）。 */
  skipped: boolean;
  generation: number | null;
  chain: Promise<boolean>;
};

export type ArtifactAutosave = {
  /** 書きかけの鍵 → この Mac への保存の様子。 */
  states: Readonly<Record<string, LocalSaveState>>;
  /** 書きかけが変わった。 */
  change: (key: string, target: DraftTarget, markdown: string) => void;
  /** 今すぐ書く（書く途中のものは終わるまで待つ）。書きかけが残らなければ true。 */
  flush: (key: string) => Promise<boolean>;
  flushAll: () => Promise<boolean>;
  /** 実行が終わった後に、待っていた書きかけを書く。 */
  resume: () => void;
  /** 書きかけを今の文書の内容として確定した（この版に戻した・変更の確認で解決した。書きかけを捨て、その保存の世代にする）。 */
  markSaved: (key: string, target: DraftTarget, generation: number | null) => void;
  /** この書きかけを自動保存で扱った（書いた・書く予定がある）。 */
  touched: (key: string) => boolean;
};

function newEntry(target: DraftTarget): Entry {
  return {
    ...target,
    pending: null,
    since: null,
    timer: null,
    showTimer: null,
    writing: false,
    failed: false,
    blocked: false,
    skipped: false,
    generation: null,
    chain: Promise.resolve(true),
  };
}

function phaseOf(entry: Entry, now: number): LocalPhase {
  if (entry.writing) return "saving";
  if (entry.pending !== null) {
    if (entry.failed) return "failed";
    return entry.blocked ? "saving" : pendingPhase(entry.since, now);
  }
  if (entry.skipped) return "waiting";
  return entry.failed ? "failed" : "saved";
}

function clearTimers(entry: Entry) {
  if (entry.timer !== null) window.clearTimeout(entry.timer);
  if (entry.showTimer !== null) window.clearTimeout(entry.showTimer);
  entry.timer = null;
  entry.showTimer = null;
}

export function useArtifactAutosave(options: {
  bridge: Bridge;
  /** 書く直前の書きかけ（消されたなら null。書かずに捨てる）。 */
  draftOf: (key: string, target: DraftTarget) => string | null;
  /** その案件の実行のロックをこの窓が持っている（工程の実行・AIと作るの依頼）。 */
  blocked: (projectId: ProjectId) => boolean;
  onError: (message: string) => void;
  /** 書けなかった書きかけを書き直せて、書けていない書きかけが無くなった（onError で出した失敗を消す）。 */
  onRecovered?: () => void;
}): ArtifactAutosave {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const entries = useRef(new Map<string, Entry>());
  const [states, setStates] = useState<Record<string, LocalSaveState>>({});

  const report = useCallback((key: string) => {
    const entry = entries.current.get(key);
    if (!entry) return;
    const next: LocalSaveState = { phase: phaseOf(entry, Date.now()), generation: entry.generation };
    setStates((all) => {
      const previous = all[key];
      if (previous && previous.phase === next.phase && previous.generation === next.generation) return all;
      return { ...all, [key]: next };
    });
  }, []);

  const flush = useCallback(
    (key: string): Promise<boolean> => {
      const entry = entries.current.get(key);
      if (!entry) return Promise.resolve(true);
      clearTimers(entry);
      // 書く順を守る（前の書き込みが終わってから、その時点の書きかけを書く）
      const run = entry.chain.then(async (): Promise<boolean> => {
        if (entries.current.get(key) !== entry || entry.pending === null) return true;
        const { bridge, draftOf, blocked, onError, onRecovered } = optionsRef.current;
        const latest = draftOf(key, entry);
        if (latest === null) {
          entry.pending = null;
          entry.since = null;
          entry.failed = false;
          entry.blocked = false;
          report(key);
          return true;
        }
        if (blocked(entry.rec.projectId)) {
          entry.blocked = true;
          report(key);
          return false;
        }
        entry.blocked = false;
        const markdown = finalizeMarkdown(latest);
        if (!markdown) {
          entry.pending = null;
          entry.since = null;
          entry.skipped = true;
          report(key);
          return true;
        }
        const captured = entry.pending;
        entry.pending = null;
        entry.since = null;
        entry.writing = true;
        report(key);
        try {
          const generation = entry.handle
            ? await bridge.saveOpenedDocument(entry.handle, markdown)
            : await bridge.writeArtifactDraft(entry.rec, entry.stepId, entry.source, markdown);
          entry.generation = typeof generation === "number" ? generation : null;
          const recovered = entry.failed;
          entry.failed = false;
          if (recovered && ![...entries.current.values()].some((other) => other.failed)) onRecovered?.();
          return true;
        } catch (error) {
          // 書きかけは残す（次の変更か移動でもう一度書く）
          if (entry.pending === null) entry.pending = captured;
          entry.failed = true;
          onError(errorMessage(error, "ページを保存できませんでした。書きかけは残しています。"));
          return false;
        } finally {
          entry.writing = false;
          report(key);
        }
      });
      entry.chain = run.catch(() => false);
      return run;
    },
    [report],
  );

  const change = useCallback(
    (key: string, target: DraftTarget, markdown: string) => {
      let entry = entries.current.get(key);
      if (!entry) {
        entry = newEntry(target);
        entries.current.set(key, entry);
      } else {
        entry.rec = target.rec;
        entry.stepId = target.stepId;
        entry.source = target.source;
        entry.handle = target.handle;
        entry.draftKey = target.draftKey;
        entry.scopeId = target.scopeId;
      }
      const now = Date.now();
      entry.pending = markdown;
      entry.skipped = false;
      if (entry.since === null) {
        entry.since = now;
        entry.showTimer = window.setTimeout(() => report(key), LOCAL_SAVE_IDLE_MS);
      }
      if (entry.timer !== null) window.clearTimeout(entry.timer);
      entry.timer = window.setTimeout(() => void flush(key), saveDue(now, entry.since, LOCAL_SAVE_IDLE_MS, LOCAL_SAVE_MAX_WAIT_MS));
      report(key);
    },
    [flush, report],
  );

  const flushAll = useCallback(async (): Promise<boolean> => {
    const results = await Promise.all([...entries.current.keys()].map((key) => flush(key)));
    return results.every(Boolean);
  }, [flush]);

  const resume = useCallback(() => {
    for (const [key, entry] of entries.current) {
      if (entry.blocked && entry.pending !== null) void flush(key);
    }
  }, [flush]);

  const markSaved = useCallback(
    (key: string, target: DraftTarget, generation: number | null) => {
      let entry = entries.current.get(key);
      if (!entry) {
        entry = newEntry(target);
        entries.current.set(key, entry);
      } else {
        entry.rec = target.rec;
        entry.stepId = target.stepId;
        entry.source = target.source;
        entry.handle = target.handle;
        entry.draftKey = target.draftKey;
        entry.scopeId = target.scopeId;
      }
      clearTimers(entry);
      entry.pending = null;
      entry.since = null;
      entry.failed = false;
      entry.blocked = false;
      entry.skipped = false;
      entry.generation = generation;
      report(key);
    },
    [report],
  );

  const touched = useCallback((key: string) => entries.current.has(key), []);

  useEffect(
    () => () => {
      for (const entry of entries.current.values()) clearTimers(entry);
    },
    [],
  );

  return useMemo(
    () => ({ states, change, flush, flushAll, resume, markSaved, touched }),
    [states, change, flush, flushAll, resume, markSaved, touched],
  );
}
