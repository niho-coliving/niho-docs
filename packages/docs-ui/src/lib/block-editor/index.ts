import type { Extensions } from "@tiptap/core";
import { buildEditorExtensions } from "../markdown";
import { BlockInputRules } from "./input-rules";
import { BlockKeys } from "./keys";
import { BlockPlaceholder } from "./placeholder";
import { SlashCommand } from "./slash";
import { DocSearch } from "./search";

/** 文書のエディタの拡張（schema の拡張＋操作の拡張）。 */
export function buildBlockEditorExtensions(): Extensions {
  return [...buildEditorExtensions(), DocSearch, BlockInputRules, BlockKeys, SlashCommand, BlockPlaceholder];
}

/** input rule はこの拡張のものだけ（StarterKit の既定の規則は日本語の文中で効かない）。 */
export const ENABLED_INPUT_RULES = [BlockInputRules];
