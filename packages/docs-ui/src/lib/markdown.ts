import { createDocsMarkdown } from "../editor/markdown";

/**
 * Markdown ↔ TipTap（ProseMirror）の往復。実装は packages/docs-ui（niho-docs-ui/editor/markdown）にあり、Web/PWA と同じものを使う
 * （#18876）。Mac は文字起こしの時刻を専用の node で持つ（transcriptTimestamps: true）。
 * エディタの操作（書き始めの記号・「/」・案内の文字・キー）は schema に影響しないので block-editor/ に置く。
 */
const markdown = createDocsMarkdown({ transcriptTimestamps: true });

/** schema を決める拡張だけ（往復の parser / serializer とエディタで共有する）。 */
export const buildEditorExtensions = markdown.buildEditorExtensions;
export const markdownSchema = markdown.markdownSchema;
export const markdownToDoc = markdown.markdownToDoc;
export const docToMarkdown = markdown.docToMarkdown;
/** Markdown → doc → Markdown を一度通した保存の形（見た目の同じ書き方の違いで「変更あり」にしない）。 */
export const canonicalMarkdown = markdown.canonicalMarkdown;
export const isMarkdownChanged = markdown.isMarkdownChanged;

export {
  finalizeMarkdown,
  markdownHasTimestamps,
  markdownWithoutTimestamps,
  renderMarkdown,
  renderTranscriptMarkdown,
} from "../editor/markdown";
