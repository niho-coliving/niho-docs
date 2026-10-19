/**
 * Markdown の行の差分（「AIと作る」の「変更を見る」。S5 #18386）。前と後の行を最長共通部分列で並べ、同じ・足した・
 * 消した の 3 種にする。前後の同じ行を先に除き、残りが大きすぎるときは（全部消して全部足した、として）計算を打ち切る。
 */

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** 中央の比べる行の数の積の上限（これを超えたら LCS を取らない。数万行の文書でも固まらない）。 */
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  // 末尾の改行で空の行を 1 つ増やさない
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 前（before）から後（after）への行の差分。 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ kind: "same", text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle: DiffLine[] = [];
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    for (const text of midA) middle.push({ kind: "removed", text });
    for (const text of midB) middle.push({ kind: "added", text });
    return [...head, ...middle, ...tail];
  }
  // lengths[i][j] = midA[i..] と midB[j..] の最長共通部分列の長さ（1 次元の表に詰める）
  const width = midB.length + 1;
  const lengths = new Uint32Array((midA.length + 1) * width);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        midA[i] === midB[j]
          ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
    }
  }
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    const left = midA[i] ?? "";
    const right = midB[j] ?? "";
    if (left === right) {
      middle.push({ kind: "same", text: left });
      i++;
      j++;
    } else if ((lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0)) {
      middle.push({ kind: "removed", text: left });
      i++;
    } else {
      middle.push({ kind: "added", text: right });
      j++;
    }
  }
  for (; i < midA.length; i++) middle.push({ kind: "removed", text: midA[i] ?? "" });
  for (; j < midB.length; j++) middle.push({ kind: "added", text: midB[j] ?? "" });
  return [...head, ...middle, ...tail];
}

/** 変わった箇所の数（続いて変わった行を 1 か所に数える）と、足した・消した行の数。 */
export function diffSummary(lines: readonly DiffLine[]): { places: number; added: number; removed: number } {
  let places = 0;
  let added = 0;
  let removed = 0;
  let inChange = false;
  for (const line of lines) {
    if (line.kind === "same") {
      inChange = false;
      continue;
    }
    if (!inChange) places++;
    inChange = true;
    if (line.kind === "added") added++;
    else removed++;
  }
  return { places, added, removed };
}

/** 画面に出す並び: 変わった行と、その前後 `context` 行だけ。間の同じ行は `{ kind: "skip", count }` に畳む。 */
export type DiffRow = DiffLine | { kind: "skip"; count: number };

export function collapseDiff(lines: readonly DiffLine[], context = 2): DiffRow[] {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let offset = -context; offset <= context; offset++) {
      const target = index + offset;
      if (target >= 0 && target < lines.length) keep[target] = true;
    }
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) rows.push({ kind: "skip", count: skipped });
      skipped = 0;
      rows.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) rows.push({ kind: "skip", count: skipped });
  return rows;
}
