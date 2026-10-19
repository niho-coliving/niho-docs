// 文書の中の検索・置き換え。実装は packages/docs-ui（Web/PWA と同じ。#18876）。
export {
  DocSearch,
  SEARCH_COUNT_LIMIT,
  literalQuery,
  replaceMatch,
  searchMatches,
  type SearchMatch,
} from "../../editor/search";
