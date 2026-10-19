"use client";

import { contractProvider, parseAbout, type About, type ContractProvider, type Flow, type ProviderCapabilities } from "@niho/docs-core";
import { useCallback, useEffect } from "react";
import { type FailureAction } from "../components/FailureBand";
import { type Selection } from "../components/Rail";
import { errorMessage, isCommandError, type Bridge, type RecentId } from "../lib/bridge";
import { openProjectOf, type OpenProject, type RecordingView } from "../lib/project-view";
import { type RunReadinessStatuses } from "../lib/run-readiness";
import { activeProviders, effectiveEngine, normalizeSettings, type AppSettings } from "../lib/settings";
import { readinessKeyOf, type Phase } from "./workspace-model";

type Context = {
  bridge: Bridge;
  capabilitiesRef: React.MutableRefObject<Partial<Record<ContractProvider, ProviderCapabilities>>>;
  setReadiness: React.Dispatch<React.SetStateAction<RunReadinessStatuses>>;
  setPhase: React.Dispatch<React.SetStateAction<Phase>>;
  setFatal: React.Dispatch<React.SetStateAction<string | null>>;
  settingsRef: React.MutableRefObject<AppSettings>;
  persistedSettingsRef: React.MutableRefObject<AppSettings>;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  setDocsRoot: React.Dispatch<React.SetStateAction<string>>;
  showAbout: (next: About) => void;
  readinessKeyRef: React.MutableRefObject<string | null>;
  putFlows: (list: readonly Flow[], lastUsed: string | null) => void;
  setFolders: React.Dispatch<React.SetStateAction<OpenProject[]>>;
  setOutside: React.Dispatch<React.SetStateAction<OpenProject | null>>;
  setRecent: React.Dispatch<React.SetStateAction<RecentId[]>>;
  putOpen: (next: OpenProject | null) => void;
  putSelection: (next: Selection | null) => void;
  putView: (next: RecordingView | null) => void;
  showFailure: (text: string, action?: FailureAction) => void;
  startupRetry: number;
};

/** 保存先・設定・工程・ページ一覧を起動時に読み、実行準備を確かめる。 */
export function useDocsStartup(context: Context) {
  const {
    bridge, capabilitiesRef, setReadiness, setPhase,
    setFatal, settingsRef, persistedSettingsRef, setSettings,
    setDocsRoot, showAbout, readinessKeyRef, putFlows,
    setFolders, setOutside, setRecent, putOpen,
    putSelection, putView, showFailure, startupRetry,
  } = context;

  /**
   * 実行の前の準備を確かめ直す（登録した AI の状態と、できること・この Mac の音声モデル）。確かめられなかったものは null にして、
   * 実行を止めない（runSetupReason）。文字起こしのエンジンがサブスクリプションの Gemini なら、モデルの方式に依らず Antigravity CLI
   * も確かめる。
   */
  const refreshReadiness = useCallback(
    (settingsNow: AppSettings) => {
      const contracts = activeProviders(settingsNow).map((provider) => contractProvider(provider, settingsNow.connection));
      if (effectiveEngine(settingsNow) === "gemini-subscription") contracts.push(contractProvider("gemini", "subscription"));
      for (const contract of new Set(contracts)) {
        bridge.providerStatus(contract).then(
          (status) => {
            if (status.installed) capabilitiesRef.current = { ...capabilitiesRef.current, [contract]: status.capabilities };
            setReadiness((all) => ({ ...all, providers: { ...all.providers, [contract]: status } }));
          },
          () => setReadiness((all) => ({ ...all, providers: { ...all.providers, [contract]: null } })),
        );
      }
      bridge.speechStatus(settingsNow.transcription.language).then(
        (speech) => setReadiness((all) => ({ ...all, speech })),
        () => setReadiness((all) => ({ ...all, speech: null })),
      );
    },
    [bridge, capabilitiesRef, setReadiness],
  );

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setFatal(null);
    void (async () => {
      try {
        const loadedSettings = normalizeSettings(await bridge.loadSettings());
        const paths = bridge.capabilities?.desktopWindow === false ? { docsRoot: "", dataDir: "" } : await bridge.appPaths();
        const savedFlows = await bridge.listFlows();
        let savedRecent: RecentId[] = [];
        let recentLoadError: unknown = null;
        try {
          savedRecent = await bridge.loadRecent();
        } catch (error) {
          if (!isCommandError(error) || error.code !== "store_bad_json") throw error;
          recentLoadError = error;
        }
        // 「あなたについて」は無くても（読めなくても）始められる。空として始め、書けば保存し直す
        const storedAbout = await bridge.loadAbout().catch(() => null);
        if (cancelled) return;
        settingsRef.current = loadedSettings;
        persistedSettingsRef.current = loadedSettings;
        setSettings(loadedSettings);
        setDocsRoot(paths.docsRoot);
        showAbout(parseAbout(storedAbout));
        readinessKeyRef.current = readinessKeyOf(loadedSettings);
        refreshReadiness(loadedSettings);
        // フローがまだ無くても普段の画面（レールと案件の一覧）を出す。工程は録音を足すときか工程設計で選ぶ
        putFlows(savedFlows.flows, savedFlows.lastUsed);
        const list = await bridge.listProjects();
        const loadedFolders = await Promise.all(list.map((entry) => bridge.loadPages(entry.id)));
        const outside = openProjectOf(await bridge.loadPages(null));
        if (cancelled) return;
        setFolders(loadedFolders.map(openProjectOf));
        setOutside(outside);
        setRecent(savedRecent);
        putOpen(null);
        putSelection(null);
        putView(null);
        setPhase("ready");
        if (recentLoadError) showFailure(errorMessage(recentLoadError, "最近開いたページを読み直せませんでした。次にページを開くと作り直します。"));
      } catch (error) {
        if (cancelled) return;
        setFatal(errorMessage(error, "保存先を読めませんでした。"));
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, persistedSettingsRef, putFlows, putOpen, putSelection, putView, readinessKeyRef, refreshReadiness, setDocsRoot, setFatal, setFolders, setOutside, setPhase, setRecent, setSettings, settingsRef, showAbout, showFailure, startupRetry]);
  return {
    refreshReadiness,
  };
}
