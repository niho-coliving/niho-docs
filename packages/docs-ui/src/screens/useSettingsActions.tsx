"use client";

import { DEFAULT_CAPABILITIES, hasAbout, parseAbout, type About, type ContractProvider, type Flow, type PromptMaterials, type ProviderCapabilities } from "@niho/docs-core";
import { type FailureAction } from "../components/FailureBand";
import { type FlowChoice } from "../components/FlowPicker";
import { type Selection } from "../components/Rail";
import type { ProjectEntry } from "../host/DocsHost";
import { errorMessage, isCommandError, type Bridge, type FlowList as FlowListData, type ProjectId, type RecentId, type RecordingRef } from "../lib/bridge";
import { type OpenProject, type RecordingView } from "../lib/project-view";
import { type ActiveRun } from "../lib/run-state";
import { type AppSettings } from "../lib/settings";
import { type ChatController } from "../lib/use-chat";
import { DOC_FLUSH_FAILED, newFlowOf, type FlowOrigin, type ToastAction } from "./workspace-model";

import type { useAppRecording } from "../lib/app-recording";

type Context = {
  guardAboutLeave: (action: () => void) => boolean;
  flowOriginRef: React.MutableRefObject<FlowOrigin | null>;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  flowsRef: React.MutableRefObject<Flow[]>;
  bridge: Bridge;
  persistSettings: (next: AppSettings) => Promise<void>;
  settingsRef: React.MutableRefObject<AppSettings>;
  reloadFlows: () => Promise<FlowListData>;
  setDesignFlowId: React.Dispatch<React.SetStateAction<string | null>>;
  showFailure: (text: string, action?: FailureAction) => void;
  navigationRef: React.MutableRefObject<number>;
  putFlowOrigin: (next: FlowOrigin | null) => void;
  runRef: React.MutableRefObject<ActiveRun | null>;
  chatSendingProjectRef: React.MutableRefObject<ProjectId | undefined>;
  rebuildRecordingFlow: (rec: RecordingRef, target: Flow) => Promise<void>;
  rememberFlow: (flowId: string) => Promise<boolean>;
  selectLocationPage: (projectId: ProjectId, pageId: string, stepId: string | null, candidateId?: string | null, shouldApply?: () => boolean) => Promise<void>;
  showToast: (text: string, action?: ToastAction) => void;
  chat: ChatController;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  persistedSettingsRef: React.MutableRefObject<AppSettings>;
  capabilitiesRef: React.MutableRefObject<Partial<Record<ContractProvider, ProviderCapabilities>>>;
  aboutSaveRef: React.MutableRefObject<Promise<unknown>>;
  aboutRef: React.MutableRefObject<About>;
  setAbout: React.Dispatch<React.SetStateAction<About>>;
  capture: ReturnType<typeof useAppRecording>;
  rootChangeRef: React.MutableRefObject<boolean>;
  setChangingRoot: React.Dispatch<React.SetStateAction<boolean>>;
  flushDocForLeave: () => Promise<void>;
  setDocsRoot: React.Dispatch<React.SetStateAction<string>>;
  flowEditsRef: React.MutableRefObject<Record<string, Flow>>;
  setFlowDrafts: React.Dispatch<React.SetStateAction<Record<string, Flow>>>;
  lastUsedFlowRef: React.MutableRefObject<string | null>;
  putFlows: (list: readonly Flow[], lastUsed: string | null) => void;
  showAbout: (next: About) => void;
  putOpen: (next: OpenProject | null) => void;
  putSelection: (next: Selection | null) => void;
  putView: (next: RecordingView | null) => void;
  refreshProjects: (shouldApply?: () => boolean) => Promise<ProjectEntry[]>;
  setRecent: React.Dispatch<React.SetStateAction<RecentId[]>>;
  setStartupRetry: React.Dispatch<React.SetStateAction<number>>;
  setFatal: React.Dispatch<React.SetStateAction<string | null>>;
};

/** 設定・あなたについて・保存先変更と、工程選択からの復帰。 */
export function useSettingsActions(context: Context) {
  const {
    guardAboutLeave, flowOriginRef, setBusy, flowsRef,
    bridge, persistSettings, settingsRef, reloadFlows,
    setDesignFlowId, showFailure, navigationRef, putFlowOrigin,
    runRef, chatSendingProjectRef, rememberFlow, selectLocationPage,
    showToast, chat, setSettings, persistedSettingsRef,
    capabilitiesRef, aboutSaveRef, aboutRef, setAbout,
    capture, rootChangeRef, setChangingRoot, flushDocForLeave,
    setDocsRoot, flowEditsRef, setFlowDrafts, lastUsedFlowRef,
    putFlows, showAbout, putOpen, putSelection,
    putView, refreshProjects, setRecent, setStartupRetry,
    setFatal,
  } = context;

  /**
   * 工程設計で、テンプレートか白紙から最初のフローを作る。録音のページの「工程設計で作る」から来たときは、テンプレートなら作った
   * フローをその録音の工程にして録音のページへ戻る（spec §7。白紙は工程設計のまま工程を足す）。録音の新規作成からは呼ばない。
   */
  const chooseFlow = async (choice: FlowChoice) => {
    if (!guardAboutLeave(() => void chooseFlow(choice))) return;
    const origin = flowOriginRef.current;
    setBusy(true);
    let created: Flow;
    try {
      created = newFlowOf(choice, flowsRef.current);
      await bridge.saveFlow(created);
      await persistSettings(settingsRef.current);
      await reloadFlows();
      setDesignFlowId(created.id);
    } catch (error) {
      showFailure(errorMessage(error, "保存できませんでした。"));
      return;
    } finally {
      setBusy(false);
    }
    if (!origin || origin.navigation !== navigationRef.current || created.steps.length === 0) return;
    putFlowOrigin(null);
    const later = `工程「${created.name}」を保存しました。${origin.rec.projectId !== null ? "背景情報のページ" : "録音のページ"}の「工程」で選んでください。`;
    // 同じ場所の実行中・会話中は録音の工程を変えない（工程設計のまま。録音のページの「工程」で後から選べる）
    if (runRef.current?.projectId === origin.rec.projectId || chatSendingProjectRef.current === origin.rec.projectId) {
      showFailure(later);
      return;
    }
    setBusy(true);
    try {
      await context.rebuildRecordingFlow(origin.rec, created);
      await rememberFlow(created.id);
    } catch (error) {
      showFailure(errorMessage(error, later));
      return;
    } finally {
      setBusy(false);
    }
    // 付けている間にほかの画面へ移っていたら、そのまま（録音には付いている）
    if (navigationRef.current !== origin.navigation) return;
    await selectLocationPage(origin.rec.projectId, origin.pageId, null);
    showToast(`この録音の工程を「${created.name}」にしました`);
  };

  const changeSettings = (next: AppSettings) => {
    const previous = settingsRef.current;
    // 方式は実行中（工程・会話・文字起こし）に切り替えない（Tauri も断る）
    if (next.connection !== previous.connection && (runRef.current || chat.sending || chat.live !== null)) {
      showFailure("実行が終わってから接続方式を切り替えてください。");
      return;
    }
    settingsRef.current = next;
    setSettings(next);
    void persistSettings(next).catch((error: unknown) => {
      // 古い保存が失敗しても、後から選んだ値へは戻さない。最後に保存できた版を基準に戻す。
      if (settingsRef.current !== next) return;
      const restored = persistedSettingsRef.current;
      settingsRef.current = restored;
      setSettings(restored);
      showFailure(errorMessage(error, "設定を保存できませんでした。"));
    });
  };

  /** 提供元ができること（まだ確かめていなければ、ここで 1 回確かめる）。 */
  const capabilitiesFor = async (contract: ContractProvider): Promise<ProviderCapabilities> => {
    const known = capabilitiesRef.current[contract];
    if (known) return known;
    try {
      const status = await bridge.providerStatus(contract);
      if (status.installed) {
        capabilitiesRef.current = { ...capabilitiesRef.current, [contract]: status.capabilities };
        return status.capabilities;
      }
    } catch {
      // 確かめられなければ既定（続きは同じ会話で頼み、だめなら新しい実行で続ける）
    }
    return DEFAULT_CAPABILITIES;
  };

  /** 「あなたについて」を保存する。保存できた内容から、次の実行・会話に使う。失敗は呼び元（設定のカード）が見せる。 */
  const saveAbout = (next: About): Promise<void> => {
    const task = aboutSaveRef.current
      .catch(() => undefined)
      .then(async () => {
        await bridge.saveAbout(next);
        aboutRef.current = next;
        setAbout(next);
      });
    aboutSaveRef.current = task;
    return task;
  };

  /** 工程の実行に渡す資料に「あなたについて」を添える（実行のたびに今の内容。案件の snapshot には入れない）。 */
  const withAbout = (materials: PromptMaterials): PromptMaterials => ({ ...materials, about: aboutRef.current });

  const changeRoot = async (root: string) => {
    if (!guardAboutLeave(() => void changeRoot(root))) return;
    if (capture.active || capture.saving) {
      showFailure("録音の保存が終わってから保存先を変更してください。");
      return;
    }
    if (runRef.current) {
      showFailure("実行が終わってから保存先を変更してください。");
      return;
    }
    if (rootChangeRef.current) return;
    rootChangeRef.current = true;
    setChangingRoot(true);
    try {
      await flushDocForLeave();
      // 保存の途中の「あなたについて」は、保存先を切り替える前に終わらせる（古い保存先へ書かれ、古い内容を新しい保存先へ写すのを防ぐ）
      await aboutSaveRef.current.catch(() => undefined);
      const next = { ...settingsRef.current, docsRoot: root };
      await persistSettings(next);
      settingsRef.current = next;
      setSettings(next);
      setDocsRoot((await bridge.appPaths()).docsRoot);
      // 新しい保存先にフローが無ければ今のフローをすべて写す（flows/ は保存先の中にある。並びと最後に使ったフローも保つ。
      // お手本の本文は写さない）。編集中の内容は捨てる
      flowEditsRef.current = {};
      setFlowDrafts({});
      setDesignFlowId(null);
      const previous = flowsRef.current;
      const previousLastUsed = lastUsedFlowRef.current;
      const there = await bridge.listFlows();
      if (there.flows.length === 0 && previous.length > 0) {
        for (const copied of previous) await bridge.saveFlow(copied);
        if (previousLastUsed && previousLastUsed !== previous[0]?.id) await bridge.setLastUsedFlow(previousLastUsed);
        await reloadFlows();
      } else {
        putFlows(there.flows, there.lastUsed);
      }
      // 「あなたについて」も新しい保存先の about.json を読み直す。無ければ今の内容を写す（フローと同じ）。写せなかったら最後に知らせる
      let aboutCopyFailure: unknown = null;
      const storedAbout = await bridge.loadAbout().catch(() => null);
      if (storedAbout) showAbout(parseAbout(storedAbout));
      else if (hasAbout(aboutRef.current)) {
        try {
          await bridge.saveAbout(aboutRef.current);
        } catch (error) {
          aboutCopyFailure = error;
        }
      }
      putOpen(null);
      putSelection(null);
      putView(null);
      await refreshProjects();
      try {
        setRecent(await bridge.loadRecent());
      } catch (error) {
        if (!isCommandError(error) || error.code !== "store_bad_json") throw error;
        setRecent([]);
        showFailure(errorMessage(error, "最近開いたページを読み直せませんでした。次にページを開くと作り直します。"));
      }
      if (aboutCopyFailure) {
        showFailure(
          `「あなたについて」を新しい保存先へ写せませんでした（再起動すると空になります）。${errorMessage(aboutCopyFailure, "書き込めませんでした。")}`,
        );
      }
    } catch (error) {
      if (error !== DOC_FLUSH_FAILED) showFailure(errorMessage(error, "保存先を変えられませんでした。"));
    } finally {
      rootChangeRef.current = false;
      setChangingRoot(false);
    }
  };

  const chooseStartupRoot = async () => {
    try {
      const root = await bridge.pickDocsRoot();
      if (!root) return;
      const next = { ...settingsRef.current, docsRoot: root };
      await persistSettings(next);
      settingsRef.current = next;
      setSettings(next);
      setStartupRetry((attempt) => attempt + 1);
    } catch (error) {
      setFatal(errorMessage(error, "保存先を選べませんでした。"));
    }
  };
  return {
    chooseFlow, changeSettings, saveAbout, changeRoot,
    chooseStartupRoot,
  };
}
