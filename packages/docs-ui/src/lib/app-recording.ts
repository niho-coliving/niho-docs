import { useEffect, useRef, useState } from "react";
import { folderRecordingPage, type AudioInput, type Recording } from "@niho/docs-core";
import { useRecording } from "../components/Recording";
import { errorMessage, type Bridge, type ProjectId, type RecordedAudio, type RecordingRef } from "./bridge";
import { newId } from "./format";
import { openProjectOf, saveRecordingChange } from "./project-view";

/** 元音声は Rust の recordings/、作成途中の保存先は WebView の永続ストレージ。本人の Mac のデータ。 */
export const RECORDING_JOURNAL_KEY = "niho-docs-recording-journal-v1";
export type CaptureTarget = {
  root: string;
  /** 保存先のフォルダ。null はフォルダを開いていなかった録音で、保存のときに新しいフォルダを作る（#18914）。 */
  projectId: ProjectId;
  /**
   * 旧版のジャーナルだけが持つ、録音を始めた文書ページ（文書ページからの録音の入口は #18881 でやめた）。新しい録音では書かない。
   * 前の版で文書ページから始め、未回収のまま更新された録音を回収するとき、その文書を参考（refs）に引き継ぐためだけに読む。
   */
  refPageId?: string;
  pageId?: string;
  /** 開始時に空だった既存ページ。途中で素材が入ったら新しいページにする。 */
  existing?: boolean;
  draft: Recording;
  imported?: AudioInput[];
};

function readJournal(): Record<string, CaptureTarget> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(RECORDING_JOURNAL_KEY) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, CaptureTarget] => {
      const value: unknown = entry[1];
      return !!value && typeof value === "object" && "root" in value && typeof value.root === "string" &&
        "projectId" in value && (value.projectId === null || typeof value.projectId === "string") && "draft" in value && !!value.draft &&
        typeof value.draft === "object" && "createdAt" in value.draft && typeof value.draft.createdAt === "string";
    }));
  } catch {
    return {};
  }
}

/** ファイルの表示名とは独立した、録音ページの日時付きタイトル。 */
function capturedPageTitle(audio: RecordedAudio, target: CaptureTarget): string {
  const named = /^録音 (\d{1,2}\/\d{1,2} \d{2}:\d{2})$/.exec(audio.name)?.[1];
  if (named) return `${named} の録音`;
  const started = new Date(target.draft.createdAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${started.getMonth() + 1}/${started.getDate()} ${pad(started.getHours())}:${pad(started.getMinutes())} の録音`;
}

/** 新しいフォルダ（名前は録音の日時）を作り、録音の保存先にする。checkpoint に残すので、再試行は同じフォルダを使う。 */
async function intoNewFolder(bridge: Bridge, audio: RecordedAudio, target: CaptureTarget, checkpoint: (target: CaptureTarget) => void): Promise<CaptureTarget> {
  const created = await bridge.createProject(
    { version: 1, id: "", name: capturedPageTitle(audio, target), createdAt: target.draft.createdAt, info: { terms: [], background: "", entities: [] }, pages: [] },
    null,
    null,
    [],
  );
  const next: CaptureTarget = { ...target, projectId: created.id, pageId: undefined, existing: false, imported: undefined };
  checkpoint(next);
  return next;
}

/**
 * 再試行は同じページ・取り込み結果を使う。元音声の削除は recording.json の保存後だけ。保存先はフォルダの音声（1 フォルダ 1 音声。
 * #18914）: フォルダに音声があればそこへ足し、無ければ作る。フォルダを開いていなかった録音（projectId が null）と、文章を貼った
 * フォルダの録音は、新しいフォルダを作って入れる。
 */
export async function saveCapturedRecording(
  bridge: Bridge,
  audio: RecordedAudio,
  initial: CaptureTarget,
  checkpoint: (target: CaptureTarget) => void,
): Promise<RecordingRef> {
  let target = initial;
  if (target.projectId === null) target = await intoNewFolder(bridge, audio, target, checkpoint);
  let opened = openProjectOf(await bridge.loadPages(target.projectId));
  let page = folderRecordingPage(opened.pages) ?? undefined;
  if (page && opened.recordings[page.recordingId ?? page.id]?.recording.source.kind !== "audio") {
    target = await intoNewFolder(bridge, audio, target, checkpoint);
    opened = openProjectOf(await bridge.loadPages(target.projectId));
    page = undefined;
  }
  if (!page) {
    // 旧版のジャーナルの開始元の文書は、まだ残っていれば参考に足す（無くなっていれば足さない）
    const legacyRef = target.refPageId && opened.pages.some((candidate) => candidate.kind === "doc" && candidate.id === target.refPageId)
      ? target.refPageId : null;
    const recording = legacyRef && !target.draft.refs.includes(legacyRef) ? { ...target.draft, refs: [...target.draft.refs, legacyRef] } : target.draft;
    page = await bridge.createPage(target.projectId, {
      kind: "rec", title: capturedPageTitle(audio, target), createdAt: target.draft.createdAt,
      recording,
    });
    target = { ...target, pageId: page.id, existing: false, imported: undefined };
    checkpoint(target);
    opened = openProjectOf(await bridge.loadPages(target.projectId));
  } else {
    // 別のページの取り込み結果は使わない（保存先の録音が変わったら写し直す）
    target = { ...target, pageId: page.id, imported: target.pageId === page.id ? target.imported : undefined };
    checkpoint(target);
  }
  // 録音の一覧は録音の id の表（ページの id とは別。以前の版はページの id で引いていた）
  const rec = { projectId: target.projectId, recordingId: page.recordingId ?? page.id };
  const source = opened.recordings[rec.recordingId]?.recording.source;
  if (source?.kind !== "audio") throw new Error("録音の保存先が変わりました。別の録音ページに保存してください。");
  const imported = target.imported ?? await bridge.importAudio(rec, [audio.path], source.audio.map((item) => item.file), [audio.name]);
  if (imported.length !== 1) throw new Error("音声を取り込めませんでした。元の録音は残っています。");
  target = { ...target, imported };
  checkpoint(target);
  // 音声も文字起こしも無かった録音（空の既存ページ）だけ日時を題にする。音声 1 セットに足すときは題を変えない
  const wasEmpty = !opened.recordings[rec.recordingId]?.hasTranscript && source.audio.every((item) => imported.some((mine) => mine.file === item.file));
  await saveRecordingChange(bridge, rec, (recording) => {
    if (recording.source.kind !== "audio") throw new Error("保存先の素材が変わりました。元の録音は残っています。");
    const files = new Set(recording.source.audio.map((item) => item.file));
    return { ...recording, source: { kind: "audio", audio: [...recording.source.audio, ...imported.filter((item) => !files.has(item.file))] } };
  });
  // 空の既存ページを使う場合も日時を付ける。失敗しても元音声を残して再試行できる。
  if (target.existing && wasEmpty && !page.title.trim()) await bridge.renamePage(target.projectId, page.id, capturedPageTitle(audio, target));
  await bridge.discardRecording(audio.recordingId);
  return rec;
}

/** App に常駐させ、ページ・案件・設定への移動で録音の所有権を失わない。 */
export function useAppRecording(options: {
  bridge: Bridge;
  root: string;
  fallback: () => CaptureTarget;
  onSaved: (rec: RecordingRef) => Promise<void>;
  onError: (message: string) => void;
}) {
  const host = useRef(options);
  host.current = options;
  const journal = useRef(readJournal());
  const [leftovers, setLeftovers] = useState<RecordedAudio[]>([]);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const activeId = useRef<string | null>(null);
  const starting = useRef(false);
  const mounted = useRef(true);
  const write = (id: string, target: CaptureTarget | null) => {
    const next = { ...journal.current };
    if (target) next[id] = target;
    else delete next[id];
    localStorage.setItem(RECORDING_JOURNAL_KEY, JSON.stringify(next));
    journal.current = next;
  };
  const refresh = async () => {
    if (options.bridge.capabilities?.nativeRecording === false) return;
    try {
      const found = await options.bridge.leftoverRecordings();
      if (mounted.current) setLeftovers(found);
    } catch {
      host.current.onError("前回の録音を確認できませんでした。アプリを開き直してください。");
    }
  };
  const finish = async (audio: RecordedAudio) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const fallbackTarget = (previous?: CaptureTarget): CaptureTarget => {
        const fallback = host.current.fallback();
        // 保存先が変わっても、録音開始時刻と工程 snapshot は録音時の値を使う。
        return previous ? { ...fallback, draft: previous.draft } : fallback;
      };
      let target = journal.current[audio.recordingId];
      if (!target || target.root !== host.current.root) target = fallbackTarget(target);
      // 案件を削除・移動していた場合は、復旧操作時に開いている案件へ保存する。
      try { await options.bridge.loadPages(target.projectId); }
      catch (error) {
        if (typeof error !== "object" || error === null || !("code" in error) || !["store_no_project", "store_not_found"].includes(String(error.code))) throw error;
        target = fallbackTarget(target);
      }
      write(audio.recordingId, target);
      const rec = await saveCapturedRecording(options.bridge, audio, target, (next) => write(audio.recordingId, next));
      write(audio.recordingId, null);
      activeId.current = null;
      setLeftovers((all) => all.filter((item) => item.recordingId !== audio.recordingId));
      try {
        await host.current.onSaved(rec);
      } catch {
        host.current.onError("録音はページに保存されました。ページを開けなかったため、レールから開いてください。");
      }
    } catch (error) {
      host.current.onError(errorMessage(error, "録音をページに保存できませんでした。前回の録音からもう一度保存できます。"));
      await refresh();
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const recording = useRecording(
    options.bridge,
    (audio) => void finish(audio),
    (recordingId) => {
      if (activeId.current === recordingId) {
        write(recordingId, null);
        activeId.current = null;
      }
      void refresh();
    },
  );
  useEffect(() => {
    mounted.current = true;
    void refresh();
    // 直前のアプリが落ちた sidecar は、親の終了検出・書き出しの間だけまだ所有者が居る。
    // 起動直後の走査だけで見逃さず、画面へ戻ったときにも復旧候補を読み直す。
    const refreshOnFocus = () => { void refresh(); };
    const retries = [2000, 10000, 30000].map((delay) => window.setTimeout(refreshOnFocus, delay));
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      mounted.current = false;
      retries.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [options.bridge]);
  useEffect(() => {
    if (recording.state.phase === "idle" && activeId.current && !savingRef.current) void refresh();
  }, [recording.state.phase]);
  const start = async (target: CaptureTarget) => {
    if (recording.active || savingRef.current || starting.current) return;
    starting.current = true;
    const id = newId("rec");
    try {
      write(id, target);
      activeId.current = id;
      if ((await recording.start(id)) === false) {
        write(id, null);
        activeId.current = null;
      }
    } catch (error) {
      host.current.onError(errorMessage(error, "録音の復旧情報を保存できないため、録音を始められませんでした。"));
    } finally {
      starting.current = false;
    }
  };
  const discard = async (audio: RecordedAudio): Promise<boolean> => {
    if (savingRef.current || recording.active) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      await options.bridge.discardRecording(audio.recordingId);
      write(audio.recordingId, null);
      await refresh();
      return true;
    } catch (error) {
      host.current.onError(errorMessage(error, "録音を捨てられませんでした。"));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return { ...recording, start, saving, leftovers, recover: finish, discard };
}
