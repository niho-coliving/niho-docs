"use client";

import type { ReactNode } from "react";
import type { DocsDocumentActions, DocsDocumentSession } from "../host/DocsWorkspaceHost";
import { SessionDocPage } from "./SessionDocPage";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Editor } from "@tiptap/react";
import type { PageAction } from "../lib/block-editor/slash";
import { errorMessage, type Bridge, type ProjectId } from "../lib/bridge";
import {
  SAVED_LOCALLY,
  cloudProjectId as toCloudProjectId,
  pagePath,
  pathHasConflict,
  pendingPhase,
  saveDue,
  saveStatus,
  waitForApplied,
  type CloudController,
  type LocalSaveState,
} from "../lib/cloud";
import { changedOnDeviceText, updatedOnDeviceText } from "../lib/cloud-device";
import { LOCAL_SAVE_IDLE_MS, LOCAL_SAVE_MAX_WAIT_MS, type RemoteWriter } from "../lib/cloud-types";
import { formatDateTime } from "../lib/format";
import { BlockEditor } from "./BlockEditor";
import { EditorTools, type EditorToolControls } from "./EditorTools";
import { DocIcon } from "./icons";
import { PageTitle, type TitleCommit } from "./PageTitle";
import { CloudPageNotice, SaveStatusText } from "./SaveStatus";
import { useDocEditor } from "./useDocEditor";

/** 書き残す（ページ・案件を移る前と窓を閉じる前に App が呼ぶ。書きかけが無ければ何もしない）。書きかけが残らなければ true、保存に失敗して残ったら false。 */
export type DocFlush = () => Promise<boolean>;

export function updatedLabel(ms: number): string | null {
  if (!ms) return null;
  const at = formatDateTime(new Date(ms).toISOString());
  return at ? `${at} に更新` : null;
}

function sameLocal(a: LocalSaveState, b: LocalSaveState): boolean {
  return a.phase === b.phase && a.generation === b.generation;
}

/**
 * 文書のページ（#18564 P1）: タイトル・メタ行・本文（P2 のブロックのエディタ。成果物の子ページと同じ BlockEditor）。本文は最後の入力から
 * 250ms・最初の未保存の入力から 1 秒の早い方で自動で保存し（C3 #18595。spec niho-docs-cloud §7.2）、ページ・案件を移る前と閉じるときに
 * 書き残す。メタ行の更新日時の後ろに保存の状態（保存中・このMacに保存済み・クラウドに保存済みなど）。失敗したら知らせて書きかけを
 * 残す（次の変更か移動でもう一度書く）。開いて閉じただけなら書かない。
 * NIHO クラウドと同期している間は本文の path を守り（別の Mac の変更は反映を延ばす）、届いていれば「最新を表示」、両方で変わって
 * いれば「変更を確認」を本文の上に出す（フォルダ外のページは同期しない）。
 * 「AIと作る」が依頼を進める間は本文の編集を止める（AI が直したら App が作り直して読み直す）。「/」のメニューには `pageActions`
 * （「録音のページ」。P3 #18566）も出す。
 */
function LegacyDocPage(props: {
  bridge: Bridge;
  projectId: ProjectId;
  pageId: string;
  /** 表示中の名前（打ちかけを含む）。 */
  title: string;
  updatedMs: number;
  editable?: boolean;
  focusTitle: boolean;
  onTitleFocused: () => void;
  onTitleInput: (title: string) => void;
  onTitleCommit: TitleCommit;
  onSaved: (ms: number) => void;
  onError: (message: string) => void;
  /** 表示中のページと、未保存分を含む最新本文。App はキーが一致する間だけ書き出しに使う。 */
  onSnapshot: (snapshot: { key: string; markdown: string } | null) => void;
  /** App が移る前に書き残すための口。 */
  flushRef: MutableRefObject<DocFlush | null>;
  /** 「/」のメニューのページの操作（「録音のページ」）。 */
  pageActions?: readonly PageAction[];
  /** NIHO クラウドの状態（無ければ「この Mac だけ」として出す）。 */
  cloud?: CloudController;
  /** 「変更を確認」（App が変更の確認を開く）。 */
  onReviewConflict?: (path: string) => void;
  /** 変わると本文を読み直す（変更の確認で保存した後）。 */
  reloadKey?: number;
  sharingActive?: boolean;
  onOpenSharing?: () => void;
  onLocalSaved?: (saved: boolean) => void;
  /** 検索・書式の入口（タイトルバーの ⋯ と ⌘F。App が持つ）。 */
  onEditorTools?: (controls: EditorToolControls | null) => void;
}) {
  const { bridge, projectId, pageId, cloud } = props;
  const [body, setBody] = useState<{
    key: string;
    markdown: string;
    handle: string;
    contextGeneration: number;
    scopeId: string;
    sha256: string | null;
  } | null>(null);
  /** 「最新を表示」で読み直した回数。 */
  const [refreshed, setRefreshed] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const documentKey = `${projectId}:${pageId}:${props.reloadKey ?? 0}:${refreshed}`;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const editorRef = useRef<Editor | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [toolHost, setToolHost] = useState<HTMLDivElement | null>(null);
  const [local, setLocal] = useState<LocalSaveState>(SAVED_LOCALLY);
  const onLocalSaved = useRef(props.onLocalSaved);
  onLocalSaved.current = props.onLocalSaved;
  const localReady = body?.key === documentKey && local.phase === "saved" && !refreshing && !loadError;
  useEffect(() => { onLocalSaved.current?.(Boolean(localReady)); }, [localReady]);
  const path = pagePath(pageId);
  const cloudProjectId = toCloudProjectId(projectId);
  const active = cloud?.active ?? false;
  const snapshot = cloud?.snapshots[cloudProjectId] ?? null;

  /** DocBody が受け取った handle（閉じるときに DocBody が書き残してから解放する）。 */
  const ownedHandles = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false;
    let adopted = false;
    let handle: string | null = null;
    setLoadError(null);
    bridge.openPageDocument(projectId, pageId).then(
      (opened) => {
        handle = opened.handle;
        if (cancelled) {
          void bridge.releaseOpenedDocument(opened.handle).catch(() => undefined);
          return;
        }
        adopted = true;
        setBody({ key: documentKey, ...opened });
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error, "本文を読めませんでした。"));
      },
    );
    return () => {
      cancelled = true;
      // 採用した後でも、DocBody が受け取る前に移動・アンマウントしたら（DocBody は作られない）ここで解放する。
      // 受け取った後は DocBody が書きかけを書き残してから解放するので、ここでは解放しない（保存の途中で外さない）
      if (handle !== null && (!adopted || !ownedHandles.current.has(handle))) {
        void bridge.releaseOpenedDocument(handle).catch(() => undefined);
      }
    };
  }, [bridge, projectId, pageId, attempt, documentKey]);

  const onLocalState = useCallback((next: LocalSaveState) => {
    setLocal((previous) => (sameLocal(previous, next) ? previous : next));
  }, []);

  const localRef = useRef(local);
  localRef.current = local;
  const contextGeneration = cloud?.state?.contextGeneration ?? null;
  const documentScopeId = cloud?.state?.documentScopeId ?? null;
  // 同じ RootBinding の session/engine refresh では capture を保つ。別 scope は書きかけが無いときだけ開き直す。
  useEffect(() => {
    if (!body || contextGeneration === null || body.contextGeneration === contextGeneration || refreshing) return;
    if (documentScopeId !== null && body.scopeId === documentScopeId) {
      setBody((current) =>
        current?.handle === body.handle ? { ...current, contextGeneration } : current,
      );
    } else if (localRef.current.phase === "saved") {
      setRefreshed((value) => value + 1);
    }
  }, [body, contextGeneration, documentScopeId, refreshing]);

  const status = saveStatus({ local: local.phase, savedGeneration: local.generation, path, cloud: cloud?.state ?? null, snapshot });
  const conflicted = pathHasConflict(snapshot, path);
  const deferred = active && (snapshot?.deferred.includes(path) ?? false);
  // 知らせで名指す端末（クラウド側を変えた端末・取り込みを待っている版の書き手）
  const conflict = snapshot?.conflicts.find((candidate) => candidate.status === "open" && candidate.path === path) ?? null;
  const conflictDevice = conflict && { deviceId: conflict.remoteDeviceId, deviceKind: conflict.remoteDeviceKind };
  const remoteWriter = snapshot?.remoteWriters[path] ?? null;
  // 「最新を表示」の間に待ちが外れても、同じ端末の名前を出し続ける
  const lastWriterRef = useRef<{ path: string; writer: RemoteWriter } | null>(null);
  if (remoteWriter) lastWriterRef.current = { path, writer: remoteWriter };
  const shownWriter = remoteWriter ?? (refreshing && lastWriterRef.current?.path === path ? lastWriterRef.current.writer : null);

  /** 「最新を表示」: 守りを外して同期し、別の Mac の変更が届いたら本文を読み直す（書きかけがあるときは押せない）。 */
  const showLatest = async () => {
    if (refreshing || !cloud || local.phase !== "saved") return;
    const applied = waitForApplied(cloud.subscribeApplied, cloudProjectId, path);
    setRefreshing(true);
    // React の cleanup より先に同期が始まると protection が残ったまま remote apply が延期される。
    // handle を明示的に閉じ終えてから同期し、届いた本文は新しい capture で開き直す。
    if (body) await bridge.releaseOpenedDocument(body.handle).catch(() => undefined);
    setBody(null);
    await bridge.cloudSyncNow(cloudProjectId).catch(() => undefined);
    await applied;
    setRefreshed((value) => value + 1);
    setRefreshing(false);
  };

  return (
    <DocumentPaper>
        <PageTitle
          value={props.title}
          placeholder="無題"
          autoFocus={props.focusTitle}
          onFocused={props.onTitleFocused}
          onInput={props.onTitleInput}
          onCommit={props.onTitleCommit}
          onEnter={() => {
            const editor = editorRef.current;
            if (!editor) return;
            // 先に同期でフォーカスを移す（続けて打った文字をタイトルに入れない）。先頭へのカーソルは focus("start")
            editor.view.focus();
            editor.commands.focus("start");
          }}
        />
        <div className="pmeta">
          <DocIcon />
          <span>文書</span>
          {updatedLabel(props.updatedMs) && (
            <>
              <span className="dotsep">·</span>
              <span>{updatedLabel(props.updatedMs)}</span>
            </>
          )}
          {!loadError && body?.key === documentKey && <SaveStatusText status={status} />}
          {props.sharingActive && <button type="button" className="docs-share-meta" onClick={props.onOpenSharing}>↗ リンクで共有中</button>}
        </div>
        {/* 検索・書式の入口はタイトルバーの ⋯ と ⌘F（owner 2026-10-18・#18941）。ここは検索の箱と書式の行の置き場 */}
        <EditorTools key={`${projectId}:${pageId}`} editor={editor} bridge={bridge} projectId={projectId} panelHost={toolHost} onError={props.onError} onControls={props.onEditorTools} />
        <div ref={setToolHost} />
        {conflicted ? (
          <CloudPageNotice text={changedOnDeviceText(conflictDevice)} action="変更を確認" onAction={() => props.onReviewConflict?.(path)} />
        ) : deferred || refreshing ? (
          <CloudPageNotice
            text={updatedOnDeviceText(shownWriter)}
            action="最新を表示"
            busy={refreshing}
            disabled={local.phase !== "saved"}
            onAction={() => void showLatest()}
          />
        ) : null}
        {loadError ? (
          <div className="loaderr">
            <p className="err">{loadError}</p>
            <button type="button" className="btn outline sm" onClick={() => setAttempt((value) => value + 1)}>
              読み込み直す
            </button>
          </div>
        ) : body?.key === documentKey ? (
          <DocBody
            key={documentKey}
            bridge={bridge}
            projectId={projectId}
            pageId={pageId}
            handle={body.handle}
            ownedHandles={ownedHandles}
            initial={body.markdown}
            editable={!refreshing && (props.editable ?? true)}
            editorRef={editorRef}
            onEditor={setEditor}
            flushRef={props.flushRef}
            pageActions={props.pageActions}
            onSaved={props.onSaved}
            onError={props.onError}
            onLocalState={onLocalState}
            onSnapshot={props.onSnapshot}
          />
        ) : null}
    </DocumentPaper>
  );
}

/** 本文のエディタと自動保存（読み込めてから作る。読み込む前に打った文字が消えないように）。 */
function DocBody(props: {
  bridge: Bridge;
  projectId: ProjectId;
  pageId: string;
  handle: string;
  /** 受け取った handle を記録する（親は受け取られていない handle だけを解放する）。 */
  ownedHandles: MutableRefObject<Set<string>>;
  initial: string;
  editable: boolean;
  editorRef: MutableRefObject<Editor | null>;
  onEditor: (editor: Editor | null) => void;
  flushRef: MutableRefObject<DocFlush | null>;
  pageActions?: readonly PageAction[];
  onSaved: (ms: number) => void;
  onError: (message: string) => void;
  onLocalState: (state: LocalSaveState) => void;
  onSnapshot: (snapshot: { key: string; markdown: string } | null) => void;
}) {
  const { bridge, projectId, pageId, handle, flushRef, ownedHandles } = props;
  /** まだ書いていない本文（null は書きかけなし）。 */
  const pending = useRef<string | null>(null);
  /** 書いた（書いている）本文。同じ本文への変更（開いた直後の整え直し・打って戻した）は書かない。 */
  const written = useRef(props.initial);
  /** 最初の未保存の入力の時刻（この時刻から 1 秒より後には延ばさない）。 */
  const since = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  /** 最初の入力から 250ms たったら「保存中」を出す。 */
  const showTimer = useRef<number | null>(null);
  const writing = useRef(false);
  const failed = useRef(false);
  const generation = useRef<number | null>(null);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const hostRef = useRef(props);
  hostRef.current = props;
  const snapshotKey = `${projectId}:${pageId}`;
  const latestMarkdownRef = useRef(props.initial);

  const report = useCallback(() => {
    const phase = writing.current
      ? "saving"
      : pending.current !== null
        ? failed.current
          ? "failed"
          : pendingPhase(since.current, Date.now())
        : failed.current
          ? "failed"
          : "saved";
    hostRef.current.onLocalState({ phase, generation: generation.current });
  }, []);

  const clearTimers = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    timer.current = null;
    showTimer.current = null;
  };

  const flush = useCallback((): Promise<boolean> => {
    clearTimers();
    // 書く順を守る（前の書き込みが終わってから、その時点の書きかけを書く）
    const write = writes.current.then(async (): Promise<boolean> => {
      const markdown = pending.current;
      if (markdown === null) return true;
      const previous = written.current;
      pending.current = null;
      since.current = null;
      written.current = markdown;
      writing.current = true;
      report();
      try {
        const saved = await bridge.saveOpenedDocument(handle, markdown);
        generation.current = typeof saved === "number" ? saved : null;
        failed.current = false;
        hostRef.current.onSaved(Date.now());
        return true;
      } catch (error) {
        // 書きかけは残す（次の変更か移動でもう一度書く）
        if (written.current === markdown) written.current = previous;
        if (pending.current === null) pending.current = markdown;
        failed.current = true;
        hostRef.current.onError(errorMessage(error, "文書を保存できませんでした。書きかけは残しています。"));
        return false;
      } finally {
        writing.current = false;
        report();
      }
    });
    writes.current = write;
    return write;
  }, [bridge, handle, report]);

  const editor = useDocEditor({
    documentKey: `${projectId}:doc:${pageId}`,
    markdown: props.initial,
    editable: props.editable,
    resolveAsset: (name) => bridge.readImageAsset(projectId, name),
    onChange: (markdown) => {
      latestMarkdownRef.current = markdown;
      hostRef.current.onSnapshot({ key: snapshotKey, markdown });
      // 書いた本文と同じ（開いた直後の整え直し・打って元に戻した）なら書かない
      if (markdown === written.current && !failed.current) {
        if (pending.current !== null) {
          pending.current = null;
          since.current = null;
          clearTimers();
          report();
        }
        return;
      }
      const now = Date.now();
      pending.current = markdown;
      if (since.current === null) {
        since.current = now;
        showTimer.current = window.setTimeout(report, LOCAL_SAVE_IDLE_MS);
      }
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush().catch(() => undefined), saveDue(now, since.current, LOCAL_SAVE_IDLE_MS, LOCAL_SAVE_MAX_WAIT_MS));
      report();
    },
  });
  props.editorRef.current = editor;

  useEffect(() => {
    props.onEditor(editor);
    return () => {
      props.editorRef.current = null;
      props.onEditor(null);
    };
  }, [editor, props.onEditor, props.editorRef]);

  useEffect(() => {
    ownedHandles.current.add(handle);
    latestMarkdownRef.current = props.initial;
    hostRef.current.onSnapshot({ key: snapshotKey, markdown: latestMarkdownRef.current });
    flushRef.current = flush;
    report();
    return () => {
      // 閉じる・移るときに書き残す（書きかけが無ければ書かない）。解放し終えるまで受け取った印を残す
      void flush()
        .catch(() => undefined)
        .finally(() =>
          bridge
            .releaseOpenedDocument(handle)
            .catch(() => undefined)
            .finally(() => ownedHandles.current.delete(handle)),
        );
      if (flushRef.current === flush) flushRef.current = null;
      hostRef.current.onSnapshot(null);
    };
  }, [bridge, flush, flushRef, handle, ownedHandles, props.initial, snapshotKey, report]);

  return (
    <div className="pbody">
      <BlockEditor editor={editor} pageActions={props.pageActions} />
    </div>
  );
}

/** 共通の文書の紙面。保存先によらず同じ骨格を使う。 */
export function DocumentPaper(props: { children: ReactNode }) {
  return <div className="sheet"><div className="pg">{props.children}</div></div>;
}

export function DocPage(props: Parameters<typeof LegacyDocPage>[0] | { session: DocsDocumentSession; actions?: DocsDocumentActions; busy?: boolean }) {
  return "session" in props ? <SessionDocPage session={props.session} actions={props.actions} busy={props.busy} /> : <LegacyDocPage {...props} />;
}
