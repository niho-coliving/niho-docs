import { Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { SearchQuery, search } from "prosemirror-search";

export const DocSearch = Extension.create({
  name: "docSearch",
  addProseMirrorPlugins() {
    return [search()];
  },
});

export type SearchMatch = { from: number; to: number };
export const SEARCH_COUNT_LIMIT = 10000;

export function literalQuery(value: string): SearchQuery {
  return new SearchQuery({ search: value, regexp: false, literal: true });
}

export function searchMatches(state: EditorState, query: SearchQuery, limit = Number.POSITIVE_INFINITY): SearchMatch[] {
  if (!query.valid) return [];
  const matches: SearchMatch[] = [];
  let position = 0;
  while (matches.length < limit) {
    const match = query.findNext(state, position);
    if (!match) break;
    matches.push({ from: match.from, to: match.to });
    position = match.to > match.from ? match.to : match.from + 1;
    if (position > state.doc.content.size) break;
  }
  return matches;
}

/** $& や $1 もそのまま書く。すべて置換は呼び出し側の 1 transaction へ後ろから積む。 */
export function replaceMatch(tr: Transaction, match: SearchMatch, value: string): Transaction {
  if (!value) return tr.delete(match.from, match.to);
  const marks = tr.doc.resolve(match.from).marksAcross(tr.doc.resolve(match.to));
  return tr.replaceWith(match.from, match.to, tr.doc.type.schema.text(value, marks));
}
