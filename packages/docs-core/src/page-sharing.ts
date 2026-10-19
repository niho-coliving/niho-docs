/** 文書と録音から作ったページのリンク共有で、Mac・Web が同じ言葉と状態を使う。 */
export type DocsPageShareState = {
  status: "PRIVATE" | "PUBLIC";
  publicId: string | null;
  url: string | null;
  updatedAt: string | null;
};

export const DOCS_PAGE_SHARING_TEXT = {
  menu: "リンクで共有",
  active: "リンクで共有中",
  toggle: "リンクを知っている人に公開",
  privateHelp: "自分だけが見られます",
  publicHelp: "ログインなしで、最新の本文が見られます",
  copy: "コピー",
  copied: "コピーしました",
  open: "開いて確かめる",
  send: "送る",
  rotate: "リンクを作り直す",
  rotateTitle: "リンクを作り直しますか？",
  rotateHelp: "今のリンクでは見られなくなります。新しいリンクを送り直してください。",
  cancel: "キャンセル",
  confirmRotate: "作り直す",
  saving: "保存が終わってから共有できます。",
  offline: "インターネットにつながってから共有できます。",
  loggedOut: "NIHO にログインしてから共有できます。",
  unknown: "共有の結果を確認できませんでした。読み直してください。",
  failed: "共有を変更できませんでした。もう一度お試しください。",
} as const;

export function docsPageSharingBlockReason(input: {
  loggedIn: boolean;
  online: boolean;
  saved: boolean;
}): string | null {
  if (!input.loggedIn) return DOCS_PAGE_SHARING_TEXT.loggedOut;
  if (!input.online) return DOCS_PAGE_SHARING_TEXT.offline;
  if (!input.saved) return DOCS_PAGE_SHARING_TEXT.saving;
  return null;
}
