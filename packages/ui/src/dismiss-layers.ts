import { useEffect, useRef } from "react";

/**
 * 開いている一時的な面（シート・ダイアログ・ポップオーバー）の重なり。開いた順に積み、「戻る」（NIHO アプリの Android の
 * ハードウェアの戻る。apps/web の lib/native/android-hardware-back.ts）は一番新しい面だけを閉じる。入れ子のシートとダイアログの
 * 見た目の重なりと同じ順になる。
 *
 * 面の部品（Dialog・Popover・web の Sheet）とアプリの「戻る」が同じ重なりを読むよう、積む場所はここ 1 つにする。
 */
type DismissLayer = {
  id: symbol;
  close: () => void;
};

const layers: DismissLayer[] = [];

/** 面を積む（開いた順）。返す関数で外す。 */
export function registerDismissLayer(close: () => void): () => void {
  const layer = { id: Symbol("dismiss-layer"), close };
  layers.push(layer);

  return () => {
    const index = layers.findIndex((candidate) => candidate.id === layer.id);
    if (index >= 0) layers.splice(index, 1);
  };
}

/** 一番新しい面を閉じる。閉じる面が無ければ false。 */
export function dismissTopLayer(): boolean {
  const layer = layers.at(-1);
  if (!layer) return false;
  layer.close();
  return true;
}

/** `active` の間だけ面を積む（「戻る」で `close` を呼ぶ）。 */
export function useDismissLayer(active: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!active) return;
    return registerDismissLayer(() => closeRef.current());
  }, [active]);
}
