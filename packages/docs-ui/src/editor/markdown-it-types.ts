import type MarkdownIt from "markdown-it";

/**
 * markdown-it の token と core rule の state の型。
 * `import type { StateCore, Token } from "markdown-it"` は @types/markdown-it 14.2 から（Mac が読む版）で、Web が読む 14.1 は
 * root から export しない。どちらの版でも同じ形の MarkdownIt の型から取り出す（版の揃えは U2。#18876）。
 */
export type Token = ReturnType<MarkdownIt["parse"]>[number];
export type StateCore = Parameters<MarkdownIt["core"]["process"]>[0];
