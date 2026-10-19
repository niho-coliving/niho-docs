/**
 * ドラッグ中（dragover。中身は読めない）に、運んでいるものの種類だけで見分ける道具（NIHO camera C1 #18389 で web の
 * `lib/article-authoring/article-image-transfer` から移した。記事の本文へのドロップと写真編集の面への写真のドロップが同じ見分け方を使う）。
 */

/** 画像ライブラリのタイルをドラッグしたときの独自の MIME。 */
export const SPOT_IMAGE_DRAG_MIME = "application/x-niho-spot-image";

type TransferTypes = { types?: ArrayLike<string> | null };

function transferTypes(dataTransfer: TransferTypes): string[] {
  return Array.from(dataTransfer.types ?? []);
}

/** ドラッグ中（dragover。中身は読めない）に、画像ライブラリのタイルか。 */
export function hasSpotImageDragData(dataTransfer: TransferTypes): boolean {
  return transferTypes(dataTransfer).includes(SPOT_IMAGE_DRAG_MIME);
}

/** ドラッグ中（dragover）に、ファイル（Finder など）を運んでいるか。 */
export function hasTransferFiles(dataTransfer: TransferTypes): boolean {
  return transferTypes(dataTransfer).includes("Files");
}
