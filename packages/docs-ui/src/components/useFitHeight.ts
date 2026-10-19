"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * 書いた分だけ欄を伸ばす（値と窓の幅が変わったとき。欄の中ではスクロールさせない。CSS は `.ta.grow`）。
 * 測るあいだ欄を縮めるので、外側の箱の高さを留めておく（留めないと、ページの下端で打つたびにスクロールの位置が上へずれる）。
 */
export function useFitHeight(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const area = ref.current;
    if (!area) return;
    const fit = () => {
      const outer = area.parentElement;
      const pinned = outer?.style.minHeight ?? "";
      if (outer) outer.style.minHeight = `${outer.offsetHeight}px`;
      area.style.height = "auto";
      // scrollHeight は枠線を含まない（box-sizing は border-box）
      if (area.scrollHeight > 0) area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
      if (outer) outer.style.minHeight = pinned;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [ref, value]);
}
