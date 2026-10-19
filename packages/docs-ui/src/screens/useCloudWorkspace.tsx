"use client";

import { pageTitle, parseAbout, SOURCE_STEP_ID, sourceStepName, type About, type Flow, type PageEntry, type PromptRef } from "@niho/docs-core";
import { useEffect, useMemo, useRef, useState } from "react";
import { type Failure, type FailureAction } from "../components/FailureBand";
import { type Screen, type Selection } from "../components/Rail";
import type { ProjectEntry } from "../host/DocsHost";
import type { ArtifactAutoVersion } from "../lib/artifact-auto-version";
import type { ArtifactAutosave } from "../lib/artifact-autosave";
import { errorMessage, type Bridge, type FlowList as FlowListData, type ProjectId, type RecordingRef } from "../lib/bridge";
import type { CloudController } from "../lib/cloud";
import { artifactPath, leaseLabel, localProjectId, nextRemoteLeaseExpiry, pagePath, remoteLeaseHolder, stepOfPath, cloudProjectId as toCloudProjectId, useCloudProtection, waitForApplied, type ConflictNames } from "../lib/cloud";
import { DOCS_ROOT_PROJECT_ID, type CloudAppliedEvent } from "../lib/cloud-types";
import { recordingRef, stepArtifactId, type OpenProject, type RecordingView } from "../lib/project-view";
import { ABOUT_FILE, artifactSaveKey, draftKey, PROJECT_FILE, type Draft, type OpenedArtifactDocument, type ToastAction } from "./workspace-model";

type Context = {
  openingRemote: string | null;
  guardAboutLeave: (action: () => void) => boolean;
  setOpeningRemote: React.Dispatch<React.SetStateAction<string | null>>;
  bridge: Bridge;
  refreshProjects: (shouldApply?: () => boolean) => Promise<ProjectEntry[]>;
  applyScreen: (next: Screen) => void;
  openProject: (projectId: ProjectId, pageId?: string | null) => Promise<OpenProject>;
  showFailure: (text: string, action?: FailureAction) => void;
  draftsRef: React.MutableRefObject<Record<string, Draft>>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, Draft>>>;
  flushDoc: () => Promise<boolean>;
  setFailure: React.Dispatch<React.SetStateAction<Failure | null>>;
  setConflictReview: React.Dispatch<React.SetStateAction<{ projectId: string; path: string | null; } | null>>;
  showToast: (text: string, action?: ToastAction) => void;
  cloud: CloudController;
  flowEditsRef: React.MutableRefObject<Record<string, Flow>>;
  reloadFlows: () => Promise<FlowListData>;
  aboutDirtyRef: React.MutableRefObject<boolean>;
  aboutSavingRef: React.MutableRefObject<boolean>;
  showAbout: (next: About) => void;
  openRef: React.MutableRefObject<OpenProject | null>;
  selectionRef: React.MutableRefObject<Selection | null>;
  setCloudDocReload: React.Dispatch<React.SetStateAction<number>>;
  reloadOpen: (projectId: ProjectId) => Promise<OpenProject>;
  viewRef: React.MutableRefObject<RecordingView | null>;
  openedArtifactRef: React.MutableRefObject<OpenedArtifactDocument | null>;
  autosave: ArtifactAutosave;
  autoVersion: ArtifactAutoVersion;
  setArtifactCaptureReload: React.Dispatch<React.SetStateAction<number>>;
  reloadView: (rec: RecordingRef, frozenRefs?: readonly PromptRef[], shouldApply?: () => boolean) => Promise<RecordingView>;
  rawTitle: (page: PageEntry) => string;
  putOpen: (next: OpenProject | null) => void;
  putSelection: (next: Selection | null) => void;
  putView: (next: RecordingView | null) => void;
  showPage: (project: OpenProject, next: Selection | null, shouldApply?: () => boolean) => Promise<void>;
  artifactRefreshing: boolean;
  setArtifactRefreshing: React.Dispatch<React.SetStateAction<boolean>>;
  putOpenedArtifact: (next: OpenedArtifactDocument | null) => void;
  screen: Screen;
  view: RecordingView | null;
  selection: Selection | null;
  artifactCaptureReload: number;
  drafts: Record<string, Draft>;
  openedArtifact: OpenedArtifactDocument | null;
  documentScopeId: string | null;
  artifactGenerationReloadRef: React.MutableRefObject<string | null>;
  infoEditing: boolean;
  open: OpenProject | null;
  aboutEditing: boolean;
  flowDrafts: Record<string, Flow>;
  folders: OpenProject[];
};

/** 同期反映・競合確認と、編集中の本文を保護する handle の管理。 */
export function useCloudWorkspace(context: Context) {
  const {
    openingRemote, guardAboutLeave, setOpeningRemote, bridge,
    refreshProjects, applyScreen, openProject, showFailure,
    draftsRef, setDrafts, flushDoc, setFailure,
    setConflictReview, showToast, cloud, flowEditsRef,
    reloadFlows, aboutDirtyRef, aboutSavingRef, showAbout,
    openRef, selectionRef, setCloudDocReload, reloadOpen,
    viewRef, openedArtifactRef, autosave, autoVersion,
    setArtifactCaptureReload, reloadView, rawTitle, putOpen,
    putSelection, putView, showPage, artifactRefreshing,
    setArtifactRefreshing, putOpenedArtifact, screen, view,
    selection, artifactCaptureReload, drafts, openedArtifact,
    documentScopeId, artifactGenerationReloadRef, infoEditing, open,
    aboutEditing, flowDrafts, folders,
  } = context;

  // ---- NIHO クラウド（C3 #18595） ----

  /** クラウドにだけある案件を開く（文書から下ろして、この Mac の案件と同じように開く。音声は後ろで取得する）。 */
  const openRemote = async (projectId: string) => {
    if (openingRemote !== null) return;
    if (!guardAboutLeave(() => void openRemote(projectId))) return;
    setOpeningRemote(projectId);
    try {
      await bridge.cloudOpenProject(projectId);
      await refreshProjects();
      applyScreen("work");
      await openProject(projectId);
    } catch (error) {
      showFailure(errorMessage(error, "クラウドから開けませんでした。"));
    } finally {
      setOpeningRemote(null);
    }
  };

  /** 書きかけを外す（画面と自動保存の両方。保存した内容を出す）。 */
  const dropDraft = (key: string) => {
    if (!(key in draftsRef.current)) return;
    draftsRef.current = Object.fromEntries(Object.entries(draftsRef.current).filter(([entry]) => entry !== key));
    setDrafts((all) => {
      const next = { ...all };
      delete next[key];
      return next;
    });
  };

  /** 変更の確認を開く（文書の書きかけを先に書き残す。「この Mac」の側は今のファイル）。書き残せなければ開かない（保存前の
   * ファイルを「この Mac」として見せ、解決後の読み直しで書きかけを失わないように。書きかけは残り、次の変更でまた保存する）。 */
  const reviewConflict = async (projectId: string, path: string | null) => {
    if (!(await flushDoc())) {
      showFailure("書きかけをこのMacに保存できないため、変更の確認を開けません。保存できてから、もう一度お試しください。", {
        label: "もう一度開く",
        run: () => void reviewConflict(projectId, path),
      });
      return;
    }
    setFailure(null);
    setConflictReview({ projectId, path });
  };

  /** 変更の確認で保存した後: 知らせて、その文書（開いていれば本文・成果物・案件）を読み直す。 */
  const onConflictResolved = (projectId: string, path: string) => {
    showToast("変更を保存しました");
    void cloud.refreshSnapshot(projectId);
    if (projectId === "flows") {
      if (Object.keys(flowEditsRef.current).length === 0) void reloadFlows().catch(() => undefined);
      return;
    }
    if (projectId === "profile") {
      if (!aboutDirtyRef.current && !aboutSavingRef.current) {
        void bridge.loadAbout().then(
          (stored) => showAbout(parseAbout(stored)),
          () => undefined,
        );
      }
      return;
    }
    void refreshProjects().catch(() => undefined);
    const localId = localProjectId(projectId);
    const current = openRef.current;
    if (current?.id !== localId) return;
    const selected = selectionRef.current;
    if (selected && path === pagePath(selected.pageId)) setCloudDocReload((value) => value + 1);
    void reloadOpen(localId).catch(() => undefined);
    const shown = viewRef.current;
    if (shown?.projectId !== localId) return;
    // 解決した工程の書きかけは外す（古い書きかけで今の文書を書き戻さない）
    const step = stepOfPath(recordingRef(shown), path);
    if (step) {
      const key = draftKey(shown.key, step);
      const opened = openedArtifactRef.current;
      const saveKey = opened?.key === key ? artifactSaveKey(key, opened.scopeId) : key;
      autosave.markSaved(
        saveKey,
        {
          rec: recordingRef(shown),
          stepId: step,
          source: step === SOURCE_STEP_ID,
          ...(opened?.key === key ? { handle: opened.handle } : {}),
          draftKey: key,
          ...(opened?.key === key ? { scopeId: opened.scopeId } : {}),
        },
        (cloud.snapshots[projectId]?.localGeneration ?? 0) + 1,
      );
      dropDraft(key);
      // 解決は版を残す（競合の保護・解決）。書きかけを外したので「版の後に直した」も外す
      autoVersion.forget(saveKey);
      setArtifactCaptureReload((value) => value + 1);
    }
    void reloadView(recordingRef(shown)).catch(() => undefined);
  };

  /** 変更の確認の一覧の名前（内部の id は出さない）。 */
  const conflictNames = (projectId: string): ConflictNames => {
    const current = openRef.current?.id === localProjectId(projectId) ? openRef.current : null;
    return {
      page: (pageId) => {
        const entry = current?.pages.find((candidate) => candidate.id === pageId && candidate.kind === "doc");
        return entry ? pageTitle({ ...entry, title: rawTitle(entry) }) : null;
      },
      recording: (recordingId) => {
        const entry = current?.pages.find((candidate) => candidate.id === recordingId && candidate.kind === "rec");
        // フォルダの録音はフォルダの「音声」（録音のページの名前は画面に出さない。#18914）
        if (entry && current?.id !== null) return "音声";
        return entry ? pageTitle({ ...entry, title: rawTitle(entry) }, current?.recordings[recordingId]?.recording) : null;
      },
      step: (recordingId, id) => {
        const recording = current?.recordings[recordingId]?.recording;
        if (!recording) return null;
        if (id === SOURCE_STEP_ID) return sourceStepName(recording.source);
        return recording.flowSnapshot.steps.find((candidate) => candidate.id === id)?.name ?? null;
      },
    };
  };

  /** 別の Mac の変更をこの Mac に反映した: 開いている案件・録音・一覧・工程・あなたについて を読み直す（書きかけと開いている本文はそのまま）。 */
  const onCloudApplied = async (event: CloudAppliedEvent) => {
    if (event.projectId === "flows") {
      if (Object.keys(flowEditsRef.current).length === 0) await reloadFlows().catch(() => undefined);
      return;
    }
    if (event.projectId === "profile") {
      if (!aboutDirtyRef.current && !aboutSavingRef.current) {
        const stored = await bridge.loadAbout().catch(() => null);
        if (stored) showAbout(parseAbout(stored));
      }
      return;
    }
    const list = await refreshProjects().catch(() => null);
    const localId = localProjectId(event.projectId);
    const current = openRef.current;
    if (!current || current.id !== localId) return;
    if (localId !== null && list && !list.some((entry) => entry.id === current.id)) {
      // 別の Mac で削除された案件を手元から外した: 一覧の先頭を開く
      putOpen(null);
      putSelection(null);
      putView(null);
      const first = list[0];
      if (first) await openProject(first.id).catch(() => undefined);
      return;
    }
    const next = await reloadOpen(current.id).catch(() => null);
    if (!next) return;
    const selected = selectionRef.current;
    if (selected && !next.pages.some((page) => page.id === selected.pageId)) {
      const first = next.pages[0];
      await showPage(next, first ? { pageId: first.id, stepId: null } : null).catch(() => undefined);
      return;
    }
    const shown = viewRef.current;
    if (shown && shown.projectId === current.id) await reloadView(recordingRef(shown)).catch(() => undefined);
  };
  const appliedRef = useRef(onCloudApplied);
  appliedRef.current = onCloudApplied;
  const { subscribeApplied } = cloud;
  useEffect(() => subscribeApplied((event) => void appliedRef.current(event)), [subscribeApplied]);

  /** 成果物の「最新を表示」: 守りを外して同期し、別の Mac の変更が届いたら読み直す（書きかけがあるときは押せない）。 */
  const showLatestArtifact = async () => {
    const current = viewRef.current;
    const step = selectionRef.current?.stepId ?? null;
    if (!current || !step || artifactRefreshing) return;
    const syncProjectId = toCloudProjectId(current.projectId);
    const artifactId = stepArtifactId(current, step, selectionRef.current?.candidateId);
    const applied = waitForApplied(subscribeApplied, syncProjectId, artifactPath(recordingRef(current), artifactId));
    setArtifactRefreshing(true);
    const opened = openedArtifactRef.current;
    if (opened) await bridge.releaseOpenedDocument(opened.handle).catch(() => undefined);
    putOpenedArtifact(null);
    await bridge.cloudSyncNow(syncProjectId).catch(() => undefined);
    await applied;
    const key = draftKey(current.key, artifactId);
    dropDraft(key);
    // 別の Mac の本文に差し替える（リモートの適用。「版の後に直した」は外す）
    if (opened) autoVersion.forget(artifactSaveKey(key, opened.scopeId));
    await reloadView(recordingRef(current)).catch(() => undefined);
    setArtifactRefreshing(false);
  };

  // 成果物の editor は native が保護と本文 snapshot を同じ project gate 上で捕捉した handle だけを使う。
  const shownStep = screen === "work" && view && selection?.pageId === view.page.id ? selection.stepId : null;
  const shownArtifactId = view && shownStep ? stepArtifactId(view, shownStep, selection?.candidateId) : null;
  const shownArtifact = view && shownArtifactId ? artifactPath(recordingRef(view), shownArtifactId) : null;
  const shownArtifactKey = view && shownArtifactId ? draftKey(view.key, shownArtifactId) : null;
  const captureEnabled = shownArtifactKey !== null && !artifactRefreshing;
  const shownProjectId = view?.projectId ?? null;
  const shownRecordingId = view?.recordingId ?? null;
  const shownSource = shownStep === SOURCE_STEP_ID;
  const shownStoredMarkdown = view && shownArtifactId
    ? (shownSource ? view.source : view.artifacts[shownArtifactId])
    : undefined;
  useEffect(() => {
    if (!captureEnabled || !shownArtifactKey || !shownRecordingId || !shownArtifactId) {
      putOpenedArtifact(null);
      return;
    }
    let cancelled = false;
    let handle: string | null = null;
    putOpenedArtifact(null);
    bridge
      .openArtifactDocument(
        { projectId: shownProjectId, recordingId: shownRecordingId },
        shownArtifactId,
        shownSource,
      )
      .then(
        (opened) => {
          handle = opened.handle;
          if (cancelled) {
            void bridge.releaseOpenedDocument(opened.handle).catch(() => undefined);
            return;
          }
          const captured = { key: shownArtifactKey, ...opened };
          putOpenedArtifact(captured);
          const current = viewRef.current;
          if (!current || current.projectId !== shownProjectId || current.recordingId !== shownRecordingId) return;
          const next = shownSource
            ? {
                ...current,
                source: opened.markdown,
                materials: { ...current.materials, source: opened.markdown },
              }
            : {
                ...current,
                artifacts: { ...current.artifacts, [shownArtifactId]: opened.markdown },
                materials: {
                  ...current.materials,
                  artifacts: { ...current.materials.artifacts, [shownArtifactId]: opened.markdown },
                },
              };
          putView(next);
        },
        (error: unknown) => {
          if (!cancelled) showFailure(errorMessage(error, "本文を読めませんでした。"));
        },
      );
    return () => {
      cancelled = true;
      if (handle !== null) void bridge.releaseOpenedDocument(handle).catch(() => undefined);
      const current = openedArtifactRef.current;
      if (current?.key === shownArtifactKey) {
        // 再captureで差し替えたhandleも、この編集面を離れるときに解放する。
        if (current.handle !== handle) void bridge.releaseOpenedDocument(current.handle).catch(() => undefined);
        putOpenedArtifact(null);
      }
    };
  }, [artifactCaptureReload, bridge, captureEnabled, openedArtifactRef, putOpenedArtifact, putView, showFailure, shownArtifactId, shownArtifactKey, shownProjectId, shownRecordingId, shownSource, viewRef]);

  // 工程実行などが同じ保護中の本文を更新したときは、旧 protection を残したまま現在本文を capture して CAS 基準を進める。
  const replacingArtifactRef = useRef<string | null>(null);
  const replacingDraft = shownArtifactKey ? drafts[shownArtifactKey] : undefined;
  useEffect(() => {
    if (
      !openedArtifact ||
      !shownArtifactKey ||
      !shownRecordingId ||
      !shownArtifactId ||
      shownStoredMarkdown === undefined ||
      openedArtifact.markdown === shownStoredMarkdown ||
      // 未確定の編集がある間は、別の書込みを新しいCAS基準にしない。
      replacingDraft !== undefined ||
      replacingArtifactRef.current === openedArtifact.handle
    ) return;
    const previous = openedArtifact;
    let cancelled = false;
    replacingArtifactRef.current = previous.handle;
    void bridge
      .openArtifactDocument(
        { projectId: shownProjectId, recordingId: shownRecordingId },
        shownArtifactId,
        shownSource,
      )
      .then(async (opened) => {
        if (
          cancelled ||
          openedArtifactRef.current?.handle !== previous.handle ||
          opened.scopeId !== previous.scopeId
        ) {
          await bridge.releaseOpenedDocument(opened.handle).catch(() => undefined);
          return;
        }
        putOpenedArtifact({ key: shownArtifactKey, ...opened });
        await bridge.releaseOpenedDocument(previous.handle).catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (!cancelled) showFailure(errorMessage(error, "本文を読み直せませんでした。"));
      })
      .finally(() => {
        if (replacingArtifactRef.current === previous.handle) replacingArtifactRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, openedArtifact, openedArtifactRef, putOpenedArtifact, replacingDraft, showFailure, shownArtifactId, shownArtifactKey, shownProjectId, shownRecordingId, shownSource, shownStoredMarkdown]);

  const cloudContextGeneration = cloud.state?.contextGeneration ?? null;
  const shownLocal = shownArtifactKey && openedArtifact?.key === shownArtifactKey && openedArtifact.scopeId === documentScopeId
    ? autosave.states[artifactSaveKey(shownArtifactKey, openedArtifact.scopeId)]
    : undefined;
  useEffect(() => {
    if (!openedArtifact || cloudContextGeneration === null || openedArtifact.contextGeneration === cloudContextGeneration) return;
    if (documentScopeId !== null && openedArtifact.scopeId !== documentScopeId) {
      setArtifactCaptureReload((value) => value + 1);
      return;
    }
    if (shownLocal && shownLocal.phase !== "saved") {
      putOpenedArtifact({ ...openedArtifact, contextGeneration: cloudContextGeneration });
      return;
    }
    const request = `${openedArtifact.key}:${cloudContextGeneration}`;
    if (artifactGenerationReloadRef.current === request) return;
    artifactGenerationReloadRef.current = request;
    setArtifactCaptureReload((value) => value + 1);
  }, [artifactGenerationReloadRef, cloudContextGeneration, documentScopeId, openedArtifact, putOpenedArtifact, setArtifactCaptureReload, shownLocal]);

  // そのほかの編集面は既存の保護を使う（案件情報・あなたについて・保存していない工程設計）。
  useCloudProtection(
    bridge,
    cloud.active && infoEditing && open !== null,
    open ? toCloudProjectId(open.id) : null,
    PROJECT_FILE,
  );
  useCloudProtection(bridge, cloud.active && aboutEditing, "profile", ABOUT_FILE);
  const flowDraftPaths = useMemo(() => Object.keys(flowDrafts).sort().map((id) => `${id}.json`), [flowDrafts]);
  useCloudProtection(bridge, cloud.active && flowDraftPaths.length > 0, "flows", flowDraftPaths);

  /** レールのクラウドにだけある案件（同期している間だけ）。 */
  const remoteOnly = cloud.active
    ? cloud.remote.filter((project) => project.projectId !== DOCS_ROOT_PROJECT_ID && !project.local && !folders.some((folder) => folder.id === project.projectId))
    : [];
  // 別の Mac の lease が期限を迎えたら、実行を止めている表示を取り下げる（一覧の再取得はフォーカス時か 5 分間隔なので待たない）
  const [leaseTick, setLeaseTick] = useState(0);
  useEffect(() => {
    const expiry = nextRemoteLeaseExpiry(cloud.remote);
    if (expiry === null) return;
    const timer = window.setTimeout(() => setLeaseTick((tick) => tick + 1), Math.min(Math.max(0, expiry - Date.now()) + 250, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [cloud.remote, leaseTick]);
  const leaseNote = (projectId: string): string | null => {
    const holder = remoteLeaseHolder(cloud.remote, projectId);
    return holder === null ? null : leaseLabel(holder);
  };
  return {
    openRemote, dropDraft, reviewConflict, onConflictResolved,
    conflictNames, showLatestArtifact, remoteOnly, leaseNote,
  };
}
