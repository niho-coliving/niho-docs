"use client";

import { useEffect, useState } from "react";

/** 実行中だけ 1 秒ごとに今の時刻を返す（経過時間の表示）。 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}
