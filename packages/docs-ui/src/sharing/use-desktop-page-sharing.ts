import { DOCS_PAGE_SHARING_TEXT, docsPageSharingBlockReason, type DocsPageShareState } from "@niho/docs-core";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Bridge } from "../host/DocsHost";

export type DesktopShareLocator = { pageId: string; projectId: string; textId: string | null };
export type DesktopShareConnection = {
  bridge: Bridge;
  locator: DesktopShareLocator;
  contextGeneration: number | null;
  loggedIn: boolean;
  saved: boolean;
  onActive?: (active: boolean) => void;
};

/** Mac のネイティブ保存先を使うページ共有を操作する。保存・ログイン・通信状態は呼び出し元が渡す。 */
export function useDesktopPageSharing(connection: DesktopShareConnection | undefined) {
  const [state, setState] = useState<DocsPageShareState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const generation = useRef(0);
  const onActive = useRef(connection?.onActive);
  onActive.current = connection?.onActive;
  const pageId = connection?.locator.pageId;
  const projectId = connection?.locator.projectId;
  const textId = connection?.locator.textId ?? null;
  const contextGeneration = connection?.contextGeneration;
  const loggedIn = connection?.loggedIn ?? false;
  const bridge = connection?.bridge;

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);

  const refresh = useCallback(async () => {
    if (!bridge || !pageId || !projectId || !loggedIn) return;
    const request = ++generation.current;
    setLoading(true);
    setState(null);
    onActive.current?.(false);
    try {
      const next = await bridge.cloudPageShareGet(pageId, projectId, textId);
      if (request !== generation.current) return;
      setState(next);
      onActive.current?.(next.status === "PUBLIC");
      setError(null);
    } catch {
      if (request === generation.current) setError(DOCS_PAGE_SHARING_TEXT.unknown);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [bridge, pageId, projectId, textId, loggedIn]);

  useEffect(() => {
    generation.current += 1;
    setState(null);
    setError(null);
    setBusy(false);
    onActive.current?.(false);
    if (loggedIn) void refresh();
    return () => { generation.current += 1; };
  }, [pageId, projectId, textId, contextGeneration, loggedIn, refresh]);

  const toggle = async (published: boolean) => {
    if (!connection || busy) return;
    if (published && docsPageSharingBlockReason({ loggedIn, online, saved: connection.saved })) return;
    setBusy(true);
    const request = generation.current;
    try {
      const next = await connection.bridge.cloudPageShareSet(pageId!, projectId!, textId, published);
      if (request !== generation.current) return;
      setState(next);
      onActive.current?.(next.status === "PUBLIC");
      setError(null);
    } catch {
      if (request !== generation.current) return;
      setError(DOCS_PAGE_SHARING_TEXT.unknown);
      await refresh();
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };

  const rotate = async (expectedPublicId: string) => {
    if (!connection || busy) return;
    setBusy(true);
    const request = generation.current;
    try {
      const next = await connection.bridge.cloudPageShareRotate(pageId!, projectId!, textId, expectedPublicId);
      if (request !== generation.current) return;
      setState(next);
      onActive.current?.(next.status === "PUBLIC");
      setError(null);
    } catch {
      if (request !== generation.current) return;
      setError(DOCS_PAGE_SHARING_TEXT.unknown);
      await refresh();
    } finally {
      if (request === generation.current) setBusy(false);
    }
  };

  return {
    state,
    loading,
    busy,
    error,
    blockReason: docsPageSharingBlockReason({ loggedIn, online, saved: connection?.saved ?? false }),
    onRefresh: () => { void refresh(); },
    onToggle: (published: boolean) => { void toggle(published); },
    onRotate: (expectedPublicId: string) => { void rotate(expectedPublicId); },
    onCopy: async (url: string) => {
      if (!bridge) return false;
      try { await bridge.copyText(url); return true; } catch { return false; }
    },
    onOpen: (url: string) => { void bridge?.cloudPageShareOpen(url).catch(() => setError("共有ページを開けませんでした。")); },
  };
}
