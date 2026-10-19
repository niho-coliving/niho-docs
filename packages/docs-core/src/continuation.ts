import { CONTINUATION_INSTRUCTION, CONTINUATION_MAX_OVERLAP } from "./rules.js";

/**
 * 重なりとして除く最短の字数。3 字以下の一致は偶然のことが多い（「…そう」＋「そうですね」のように、続きが重なり無しで
 * 始まっても末尾と先頭がそろう）ので、除くと本文が黙って欠ける。欠ける（省略）より重なる（目で見て直せる）ほうを選ぶ。
 * S0 #18381 の 5 の実測: 実際の長さの続きの繋ぎ目 3 か所は重なり 0 字、極端に小さい例の 1 か所は 5 字（「45: 四十」＋
 * 「5: 四十五」）。crate の内部の続き（`apps/docs/crates/local-ai/src/merge.rs`）と同じ規則で、変えるときは両方を揃える。
 */
export const CONTINUATION_MIN_OVERLAP = 4;

/**
 * 前の出力の末尾と続きの先頭の重なりの字数（最長一致・4〜400 字。空白だけの一致は段落の区切りなので除かない。重ならなければ 0）。
 * 字数はコードポイントで数える（crate の char と同じ。絵文字などサロゲートペアも 1 字）。
 */
export function continuationOverlap(previous: string, next: string, maxOverlap = CONTINUATION_MAX_OVERLAP): number {
  const nextChars = Array.from(next);
  const limit = Math.min(maxOverlap, Array.from(previous).length, nextChars.length);
  for (let length = limit; length >= CONTINUATION_MIN_OVERLAP; length--) {
    const head = nextChars.slice(0, length).join("");
    if (head.trim() === "") continue;
    if (previous.endsWith(head)) return length;
  }
  return 0;
}

/**
 * 続きの結合（spec §5.4）。前の出力の末尾と続きの先頭の重なり（最長一致・4〜400 字・空白だけは除かない）を除いて繋ぐ。
 * 同じ会話の続き（止まった箇所の直後から書く）に使う。新しい実行で頼んだ続きは、重なりが取れなければ結合しない
 * （`continuationOverlap` が 0 なら人に見せる）。
 */
export function joinContinuation(previous: string, next: string, maxOverlap = CONTINUATION_MAX_OVERLAP): string {
  return previous + Array.from(next).slice(continuationOverlap(previous, next, maxOverlap)).join("");
}

/**
 * CLI が同じ会話を続けられないとき（`resume` が無い・会話が見つからない）に、ここまでの出力を添えて新しい実行で続ける指示。
 */
export function buildFreshContinuationPrompt(userPrompt: string, outputSoFar: string): string {
  return `${userPrompt}\n\n## ここまでの出力\n\n${outputSoFar}\n\n${CONTINUATION_INSTRUCTION}`;
}
