/** NIHO docs のユーザー単位の保存先。Mac と Web で同じ状態名を使う。 */
export const DOCS_STORAGE_MODES = ["UNSET", "CLOUD", "CLOSING", "LOCAL"] as const;
export type DocsStorageMode = (typeof DOCS_STORAGE_MODES)[number];

export const DOCS_STORAGE_WORDS = {
  cloud: "NIHO クラウド",
  local: "この Mac だけ",
  closing: "NIHO クラウドから移行中",
  localWeb: "このアカウントは、ページを Mac の中だけに保存しています",
  closingWeb: "クラウドからこの Mac に移している間は、ページと音声を読むことだけできます。",
} as const;
