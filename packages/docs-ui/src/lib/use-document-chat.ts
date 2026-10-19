import { createBlankFlow, planProject, type FlowSnapshot, type RecordingInfo } from "@niho/docs-core";
import type { OpenProject, RecordingView } from "./project-view";

/**
 * 文書ページの会話も App の単一 useChat を使い、画面を移っても停止と実行ロックを保つ。会話の表示には録音の見え方の形を借りる
 * （recordingId は文書ページの id。会話は page-chats/<pageId>/ に残る）。AI が読み書きする文書は composer の場所（composer.ts）で、
 * 同じ場所の文書ページと、ほかの録音の成果物（読むだけ）。移動の世代はページ台帳の moveGeneration を使い、移動前の会話は閲覧だけにする。
 */
export function useDocumentChat(open: OpenProject | null, pageId: string | null) {
  const page = open && pageId ? open.pages.find((candidate) => candidate.id === pageId && candidate.kind === "doc") : null;
  const flow: FlowSnapshot = { ...createBlankFlow("document-chat"), models: {} };
  const info: RecordingInfo = { speakers: "auto", language: "ja", terms: [], background: "" };
  const key = open && pageId ? `${open.id ?? "_outside"}/${pageId}` : null;
  const view: RecordingView | null = open && pageId && page && key ? {
    key, projectId: open.id, recordingId: pageId, project: open.project, page, flow,
    recording: { version: 1, id: pageId, createdAt: page.createdAt, flowSnapshot: flow, source: { kind: "text" },
      speakers: "auto", language: "ja", refs: [], moveGeneration: page.moveGeneration ?? 0 },
    sourceName: "文書", source: "", artifacts: {}, runs: [], unversioned: [], missingInputs: [],
    materials: { sourceName: "文書", source: "", artifacts: {}, refs: [], info },
    plan: planProject({ flow, sourceName: "文書", source: "", artifacts: {}, info, latestBasis: {} }),
  } : null;
  return { view };
}
