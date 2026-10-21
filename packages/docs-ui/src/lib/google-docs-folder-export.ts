import type {
  DocsDriveFolderExportFailureReason,
  DocsDriveFolderExportNode,
  DocsDriveFolderExportPlan,
  DocsDriveFolderExportProgress,
} from "./bridge";

/**
 * フォルダの書き出し（#18838）の画面の部品: 文・木の選び方・目安の数。Web（apps/web/app/app/docs/_lib/docs-google-folder-export.ts）と
 * 同じ文・同じ規則にする。文の正は docs/design/design-guide-docs.md §5.1、仕組みの正は specs/initiatives/niho-docs-google-docs-export.md。
 * 応答の確かめは Rust（src-tauri/src/google_docs.rs）が済ませてから渡す。
 */

// ---- 文（design-guide-docs.md §5.1・spec の「止まった理由」の表） ----

export const FOLDER_EXPORT_TEXT = {
  title: "Google ドキュメントへ書き出す",
  description: "このフォルダのページを、タブに分けた 1 つの Google ドキュメントにします。元のページは変わりません。",
  unsaved: "保存が終わってから書き出せます。",
  localUnsaved: "この Mac に保存が終わってから書き出せます。確定後は選んだ本文を一時的に送って書き出せます。",
  localTransitNotice: "書き出しの間、選んだページをクラウドに一時的に置きます。完了後はすぐ削除し、再開できる失敗では最長24時間保持してから削除します。",
  /** Mac だけ: NIHO クラウドに保存していないフォルダ（この Mac だけ・別のアカウント・ログアウト）。 */
  notInCloud: "クラウドに保存しているフォルダだけ書き出せます。",
  unavailable: "今は書き出せません。時間をおいてもう一度お試しください。",
  loading: "フォルダの中身を読み込んでいます",
  loadFailed: "フォルダの中身を読めませんでした。時間をおいてもう一度お試しください。",
  folderChanged: "フォルダが更新されました。中身を読み直しました。",
  noSelection: "入れるページを選んでください。",
  sending: "Google ドキュメントを作成しています",
  pending: "書き出しの結果をまだ確認できていません。",
  buildingNote: "この画面を閉じても作成は続きます。",
  completed: "Google ドキュメントを作成しました。",
  /** 結果の分からない書き出しを照会したら、まだ届いていなかった（同じ内容で送り直せる）。 */
  notReceived: "書き出しの依頼が届いていませんでした。同じ内容で再試行できます。",
  /** 同じ Google アカウントへ接続し直すと、同じ書き出しを確かめられる。 */
  reconnect: "Google へ再接続して、同じ書き出しの結果を確認してください。",
  /** 別の Google アカウントへ接続し直した。前の書き出しは確かめられない。 */
  accountChanged: "接続先の Google アカウントが変わりました。前の書き出しはこのアカウントでは確認できません。",
  /** 対応の無い失敗（design-guide-docs.md §7）。 */
  unknownFailure: "うまくいきませんでした。時間をおいてもう一度お試しください。",
  // 以下は 1 ページの書き出しと同じ文（Mac の 1 ページの書き出しのダイアログ・Web の接続の案内）
  signedOut: "ログインしてから書き出してください。",
  notConnected: "本人の Google アカウントへ接続すると、文書やページを書き出せます。",
  connectionLost: "Google への接続が切れています。もう一度接続してください。",
  connectionCheckFailed: "Google との接続を確認できませんでした。",
  network: "通信できませんでした。通信が戻ると結果を確認します。",
  rejected: "Google ドキュメントを作成できませんでした。同じ内容で再試行できます。",
  titleInvalid: "タイトルは1〜200文字にしてください。",
  openFailed: "Google ドキュメントを開けませんでした。",
} as const;

export const FOLDER_EXPORT_RESTART_CONFIRM = {
  title: "新しい Google ドキュメントを作成しますか？",
  description: "前の書き出しとは別に、新しい Google ドキュメントを 1 つ作成します。",
  confirmLabel: "新しく書き出す",
} as const;

export function folderExportBuildingText(progress: DocsDriveFolderExportProgress): string {
  return `作成中（${progress.done} / ${progress.total} タブ）`;
}

export function folderExportImagesSkippedText(count: number): string {
  return `写真 ${count} 枚を入れられませんでした。`;
}

const CONNECTION_CHANGED_TEXT = "Google の接続が変わったため、途中で止めました。作成途中の文書は Google ドライブに残っています。";
const FAILURE_TEXT: Record<DocsDriveFolderExportFailureReason, string> = {
  google_unavailable: "途中で止まりました。",
  folder_changed: "フォルダが更新されたため、もう一度書き出してください。",
  drive_connection_changed: CONNECTION_CHANGED_TEXT,
  google_account_changed: CONNECTION_CHANGED_TEXT,
  auth_revoked: CONNECTION_CHANGED_TEXT,
  document_unavailable: "作成中の Google ドキュメントを開けなくなったため、止めました。",
  conversion_failed: "この中身を Google ドキュメントにできませんでした。",
};

/** 止まった理由の文（知らない理由は「途中で止まりました。」）。 */
export function folderExportFailureText(reason: DocsDriveFolderExportFailureReason | null): string {
  return reason ? FAILURE_TEXT[reason] : FAILURE_TEXT.google_unavailable;
}

function withCommas(value: number): string {
  return String(Math.max(0, Math.trunc(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 「8,532字」・1 万以上は「3.4万字」（小数 1 桁で切り捨て・「100万字」）。 */
export function formatFolderExportChars(chars: number): string {
  if (chars < 10_000) return `${withCommas(chars)}字`;
  return `${Math.floor(chars / 1_000) / 10}万字`;
}

// ---- 木と選び方 ----

export type FolderExportLimits = DocsDriveFolderExportPlan["limits"];
export type FolderExportMeasure = { tabs: number; chars: number };
export type FolderExportRow = { node: DocsDriveFolderExportNode; depth: number };

/** 行（木の並びのまま。字下げの段は親をたどった数）。 */
export function folderExportRows(nodes: readonly DocsDriveFolderExportNode[]): FolderExportRow[] {
  const depth = new Map<string, number>();
  return nodes.map((node) => {
    const level = node.parentKey === null ? 0 : (depth.get(node.parentKey) ?? 0) + 1;
    depth.set(node.key, level);
    return { node, depth: level };
  });
}

/** 既定の選び方（`defaultSelected`。親を外している子は入れない）。 */
export function defaultFolderExportSelection(nodes: readonly DocsDriveFolderExportNode[]): Set<string> {
  const selected = new Set<string>();
  for (const node of nodes) {
    if (node.defaultSelected && (node.parentKey === null || selected.has(node.parentKey))) selected.add(node.key);
  }
  return selected;
}

/** 選ぶと親も入り、外すと子も外れる。 */
export function toggleFolderExportSelection(
  nodes: readonly DocsDriveFolderExportNode[],
  selected: ReadonlySet<string>,
  key: string,
  checked: boolean,
): Set<string> {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const next = new Set(selected);
  if (!byKey.has(key)) return next;
  if (checked) {
    let current: string | null = key;
    const seen = new Set<string>();
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      next.add(current);
      current = byKey.get(current)?.parentKey ?? null;
    }
    return next;
  }
  const removed = new Set([key]);
  for (const node of nodes) {
    if (node.parentKey !== null && removed.has(node.parentKey)) removed.add(node.key);
  }
  for (const removedKey of removed) next.delete(removedKey);
  return next;
}

/**
 * 読み直した木へ選び方を移す（前からある行は前の選び方のまま・新しい行は既定。親を外している子は入れない）。
 * フォルダが更新されても、選び直しは要るときだけにする（design-guide-docs.md §5.1）。
 */
export function reconcileFolderExportSelection(
  previous: readonly DocsDriveFolderExportNode[],
  nodes: readonly DocsDriveFolderExportNode[],
  selected: ReadonlySet<string>,
): Set<string> {
  const known = new Set(previous.map((node) => node.key));
  const next = new Set<string>();
  for (const node of nodes) {
    const wanted = known.has(node.key) ? selected.has(node.key) : node.defaultSelected;
    if (wanted && (node.parentKey === null || next.has(node.parentKey))) next.add(node.key);
  }
  return next;
}

/** 送る include（木の並び）。 */
export function folderExportInclude(nodes: readonly DocsDriveFolderExportNode[], selected: ReadonlySet<string>): string[] {
  return nodes.filter((node) => selected.has(node.key)).map((node) => node.key);
}

/** 時刻を外すと字数が変わる行があるか（タイムスタンプの欄を出すか）。 */
export function hasFolderExportTimestamps(nodes: readonly DocsDriveFolderExportNode[]): boolean {
  return nodes.some((node) => node.charsWithoutTimestamps !== undefined);
}

export function folderExportNodeChars(node: DocsDriveFolderExportNode, timestamps: boolean): number {
  return timestamps ? node.chars : node.charsWithoutTimestamps ?? node.chars;
}

/** 録音の表紙の、子 1 つぶんの字数（成果物へのリンクの 1 行 = 題名 + 改行）。plan の題名はタブの題名で、API の表紙と同じ数え方。 */
function folderExportCoverLinkChars(child: DocsDriveFolderExportNode): number {
  return child.title.length + 1;
}

/**
 * 目安（タブは選んだ行の数・字数は選んだ行の合計）。録音の表紙は、plan では全部の成果物へのリンクを含む字数なので、
 * 外した成果物のリンクの分を引く（API の `measureFolderExportSelection` は選んだ子だけで表紙を組む）。
 */
export function measureFolderExportSelection(
  nodes: readonly DocsDriveFolderExportNode[],
  selected: ReadonlySet<string>,
  timestamps: boolean,
): FolderExportMeasure {
  let tabs = 0;
  let chars = 0;
  const droppedCoverChars = new Map<string, number>();
  for (const node of nodes) {
    if (node.parentKey === null || selected.has(node.key)) continue;
    droppedCoverChars.set(node.parentKey, (droppedCoverChars.get(node.parentKey) ?? 0) + folderExportCoverLinkChars(node));
  }
  for (const node of nodes) {
    if (!selected.has(node.key)) continue;
    tabs += 1;
    chars += folderExportNodeChars(node, timestamps);
    if (node.kind === "recording") chars -= droppedCoverChars.get(node.key) ?? 0;
  }
  return { tabs, chars };
}

/** 「タブ 12/100 · 3.4万字/100万字」。 */
export function folderExportBudgetText(measure: FolderExportMeasure, limits: FolderExportLimits): string {
  return `タブ ${measure.tabs}/${limits.maxTabs} · ${formatFolderExportChars(measure.chars)}/${formatFolderExportChars(limits.maxChars)}`;
}

/** 上限を超えたときの文（超えていなければ空）。 */
export function folderExportOverLimitTexts(measure: FolderExportMeasure, limits: FolderExportLimits): string[] {
  const texts: string[] = [];
  if (measure.tabs > limits.maxTabs) texts.push(`タブが多すぎます。あと ${measure.tabs - limits.maxTabs} 個外してください。`);
  if (measure.chars > limits.maxChars) texts.push(`文字数が多すぎます。あと約 ${withCommas(measure.chars - limits.maxChars)} 字分のページを外してください。`);
  return texts;
}
