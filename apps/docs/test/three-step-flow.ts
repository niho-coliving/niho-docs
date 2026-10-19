import { ADVANCED_PROFILE_ID, LIGHT_PROFILE_ID, type FlowTemplate } from "@niho/docs-core";

/**
 * 工程が 3 つ続くテスト用のテンプレート（後ろの工程は前の工程の成果物を読む）。
 *
 * 組み込みのテンプレートは owner の判断で工程の数が変わる（2026-10-18 にインサイト整理が 1 工程になった）。
 * 順に実行・前提変更・前の工程が済むまで押せない、のように工程どうしの関係を確かめるテストは、組み込みでなくこれを使う。
 * 形（名前・プロファイル）は 1 工程になる前のインサイト整理と同じにしてある。
 */
export const THREE_STEP_TEMPLATE: FlowTemplate = {
  id: "tpl-test-three-steps",
  name: "3 工程のテスト用フロー",
  guide: "",
  steps: [
    { id: "b8y4g2tn", name: "発言の抽出", profile: LIGHT_PROFILE_ID, instruction: "文字起こしから、分析に使う発言を抜き出す。" },
    { id: "u3e7z6rh", name: "インサイト", profile: ADVANCED_PROFILE_ID, instruction: "抜き出した発言を、インサイトにまとめる。" },
    { id: "f6p9a4wc", name: "次の打ち手", profile: ADVANCED_PROFILE_ID, instruction: "インサイトごとに、試せる打ち手を提案する。" },
  ],
};
