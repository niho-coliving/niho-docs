"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const STORAGE_PREFIX = "niho-docs:composer-rail-width:v1:";
const MIN_WIDTH = 300;
const MAX_WIDTH = 560;
const MIN_ARTICLE_WIDTH = 600;
const COLUMN_GAP = 16;
const KEY_STEP = 20;
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** 手動の幅は本文の読みやすい最小幅を残して制限する。画面を広げれば保存した好みへ戻る。 */
export function docsComposerRailWidthLimits(gridWidth: number | null, minArticleWidth = MIN_ARTICLE_WIDTH, columnGap = COLUMN_GAP) {
  const max = gridWidth && gridWidth > 0
    ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, gridWidth - minArticleWidth - columnGap))
    : MAX_WIDTH;
  return { min: MIN_WIDTH, max };
}

export function clampDocsComposerRailWidth(width: number, gridWidth: number | null, minArticleWidth = MIN_ARTICLE_WIDTH, columnGap = COLUMN_GAP) {
  const { min, max } = docsComposerRailWidthLimits(gridWidth, minArticleWidth, columnGap);
  return Math.max(min, Math.min(max, width));
}

function readPreferredWidth(userId: string) {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${userId}`);
    if (!raw || !/^\d+$/.test(raw)) return null;
    const width = Number(raw);
    return width >= MIN_WIDTH && width <= MAX_WIDTH ? width : null;
  } catch {
    return null;
  }
}

/** 記事制作のレールと同じくドラッグで調整し、本人・ブラウザごとに好みを残す。 */
export function useDocsComposerRailWidth(userId: string, enabled = true, minArticleWidth = MIN_ARTICLE_WIDTH, columnGap = COLUMN_GAP, defaultWidthCss = "clamp(340px,25vw,420px)") {
  const gridRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [preferredWidth, setPreferredWidth] = useState<number | null>(null);
  const [gridWidth, setGridWidth] = useState<number | null>(null);
  const [actualWidth, setActualWidth] = useState(340);
  const railElement = useCallback(() => railRef.current ?? gridRef.current?.querySelector<HTMLElement>(".col") ?? null, []);

  useEffect(() => { setPreferredWidth(readPreferredWidth(userId)); }, [userId]);
  useBrowserLayoutEffect(() => {
    if (!enabled) return;
    const measure = () => {
      const grid = gridRef.current?.getBoundingClientRect().width;
      const rail = railElement()?.getBoundingClientRect().width;
      if (grid && grid > 0) setGridWidth(grid);
      if (rail && rail > 0) setActualWidth(Math.round(rail));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (gridRef.current) observer?.observe(gridRef.current);
    if (railElement()) observer?.observe(railElement()!);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [enabled, railElement]);
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const liveGridWidth = () => gridRef.current?.getBoundingClientRect().width || gridWidth;
  const limits = docsComposerRailWidthLimits(gridWidth, minArticleWidth, columnGap);
  const widthCss = preferredWidth === null
    ? defaultWidthCss
    : `${clampDocsComposerRailWidth(preferredWidth, gridWidth, minArticleWidth, columnGap)}px`;
  const persist = useCallback((width: number | null) => {
    setPreferredWidth(width);
    try {
      if (width === null) window.localStorage.removeItem(`${STORAGE_PREFIX}${userId}`);
      else window.localStorage.setItem(`${STORAGE_PREFIX}${userId}`, String(Math.round(width)));
    } catch {
      // 保存できないブラウザでも、この画面では幅を調整できる。
    }
  }, [userId]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragCleanupRef.current?.();
    const handle = event.currentTarget;
    const startWidth = clampDocsComposerRailWidth(railElement()?.getBoundingClientRect().width || actualWidth, liveGridWidth(), minArticleWidth, columnGap);
    const initialPreference = preferredWidth;
    const startX = event.clientX;
    const pointerId = event.pointerId;
    let latest = startWidth;
    const oldCursor = document.body.style.cursor;
    const oldUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    try { handle.setPointerCapture?.(pointerId); } catch { /* window の listener で続ける */ }

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      latest = clampDocsComposerRailWidth(startWidth + startX - moveEvent.clientX, liveGridWidth(), minArticleWidth, columnGap);
      setPreferredWidth(latest);
      setActualWidth(latest);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("blur", onEnd);
      handle.removeEventListener("lostpointercapture", onEnd);
      if (handle.hasPointerCapture?.(pointerId)) {
        try { handle.releasePointerCapture(pointerId); } catch { /* 解放に失敗しても表示は戻す */ }
      }
      document.body.style.cursor = oldCursor;
      document.body.style.userSelect = oldUserSelect;
      dragCleanupRef.current = null;
    };
    const onEnd = (endEvent: Event) => {
      if ("pointerId" in endEvent && endEvent.pointerId !== pointerId) return;
      cleanup();
      if (latest === startWidth) setPreferredWidth(initialPreference);
      else persist(latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("blur", onEnd);
    handle.addEventListener("lostpointercapture", onEnd);
    dragCleanupRef.current = cleanup;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      persist(null);
      return;
    }
    const { min, max } = docsComposerRailWidthLimits(liveGridWidth(), minArticleWidth, columnGap);
    const current = railElement()?.getBoundingClientRect().width || actualWidth;
    const next = event.key === "ArrowLeft" ? current + KEY_STEP
      : event.key === "ArrowRight" ? current - KEY_STEP
      : event.key === "Home" ? min
      : event.key === "End" ? max
      : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    const width = clampDocsComposerRailWidth(next, liveGridWidth(), minArticleWidth, columnGap);
    if (Math.round(width) === Math.round(current)) return;
    setActualWidth(width);
    persist(width);
  };

  return {
    gridRef,
    railRef,
    widthCss,
    limits,
    actualWidth,
    onPointerDown,
    onKeyDown,
    reset: () => persist(null),
  };
}
