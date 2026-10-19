// エディタに道具の無い Markdown（表・画像）を文字のまま持つ node / mark と読み替え。実装は packages/docs-ui（Web/PWA と同じ。#18876）。
export { MarkdownRaw, MarkdownRawInline, addRawMarkdownRules } from "../editor/markdown-raw";
