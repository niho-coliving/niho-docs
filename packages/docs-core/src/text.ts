/**
 * 文字列の小道具（字数・ハッシュ・語の正規化）。Tauri・Node・DOM に依存しない。
 */

/** 字数（コードポイント数）。サロゲートペアを 1 字に数える。 */
export function countChars(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    // 上位サロゲートの直後に下位サロゲートが続くときは 2 単位で 1 字
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    count++;
  }
  return count;
}

/**
 * 内容のハッシュ（64 bit の 16 進 16 桁）。前提が変わったかの判定にだけ使う（暗号用途ではない）。
 * 2 本の 32 bit の乗算ハッシュを混ぜる（cyrb53 と同じ形）。
 */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** 同じ語かどうかを比べる鍵（NFKC・小文字化・空白除去。spec §8.4 と同じ規則）。 */
export function termKey(term: string): string {
  return term.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}
