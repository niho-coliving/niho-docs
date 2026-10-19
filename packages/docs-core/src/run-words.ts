/**
 * 実行（run）の状態・実行の入口・印・経路の言葉（#18902・Epic #18882 S2）。Mac の録音のページと Web/PWA の録音の実行で、同じ事象に
 * 同じ文を出すため、利用者に見せる語はここだけに置く（正は docs/design/design-guide-docs.md §3。表を直してからここを直す）。
 * 置き場所・押せる条件・確認の出し方は各アプリが決める。内部の状態名（`input_changed` など）は画面に出さない（同 §7）。
 */

/** NIHO の実行の状態（API。正は specs/initiatives/niho-docs-remote-execution.md §4）。 */
export type RemoteRunState =
  | "queued"
  | "waiting_runner"
  | "waiting_capacity"
  | "waiting_auth"
  | "running"
  | "transcription_complete"
  | "completed"
  | "needs_budget_action"
  | "needs_storage_action"
  | "input_changed"
  | "result_unknown"
  | "failed"
  | "canceled"
  | "input_expired";

/** 実行の中の 1 工程の状態（API）。 */
export type RemoteRunStepState =
  | "pending"
  | "waiting_capacity"
  | "running"
  | "succeeded"
  | "needs_budget_action"
  | "needs_storage_action"
  | "input_changed"
  | "failed"
  | "canceled"
  | "result_unknown";

/** 状態ごとの見出し（条件で分かれる `waiting_runner`・`input_changed` は {@link remoteRunHeadline} が分ける）。 */
export const REMOTE_RUN_STATE_HEADLINES: Readonly<Record<RemoteRunState, string>> = {
  queued: "受付済み",
  waiting_runner: "実行機を待っています",
  waiting_capacity: "順番を待っています",
  waiting_auth: "Macアプリでログインが必要です",
  running: "処理中",
  transcription_complete: "文字起こし完了",
  completed: "完了",
  needs_budget_action: "許可・予算の確認待ち",
  needs_storage_action: "保存容量の確認待ち",
  input_changed: "入力が変わりました",
  result_unknown: "結果を確認できません",
  failed: "処理できませんでした",
  canceled: "取消済み",
  input_expired: "音声の再選択が必要です",
};

/** 宛先が自分の Mac の `waiting_runner` の見出し（`nextAction`。#18805）。 */
export const OWN_MAC_WAITING_HEADLINES = { start_mac: "Macの起動待ち", wait_for_mac: "Macの受け取り待ち" } as const;

/** 実行を始める前に入力が変わった `input_changed` の見出し（`reasonCode: input_changed_before_execution`。採用できる候補は無い）。 */
export const INPUT_CHANGED_BEFORE_EXECUTION_HEADLINE = "入力が変わりました";
export const KEPT_CURRENT_HEADLINE = "完了（今の本文を保った）";
/** AI 実行中に対象の本文が直されたとき、旧本文を版に残した知らせ。 */
export const AI_OVERWROTE_EDIT_NOTICE = "作っている間に直した内容は、版に残しました。";

const INPUT_CHANGED_BEFORE_EXECUTION = "input_changed_before_execution";

function isRemoteRunState(value: string): value is RemoteRunState {
  return Object.prototype.hasOwnProperty.call(REMOTE_RUN_STATE_HEADLINES, value);
}

/**
 * 実行の見出し。知らない状態・状態が無いときは null（呼び出し側は値を省いた文にする。design-guide-docs.md §7）。
 * - `ownMac`: 宛先が自分の Mac（`pcRunner` がある）。`waiting_runner` を起動待ち／受け取り待ちに分ける。
 * - `reasonCode`: `input_changed` を「入力が変わりました」（実行の前）と「候補の確認待ち」（実行中）に分ける。
 */
export function remoteRunHeadline(run: {
  state: string | null | undefined;
  reasonCode?: string | null;
  nextAction?: string | null;
  ownMac?: boolean;
}): string | null {
  const state = run.state;
  if (!state || !isRemoteRunState(state)) return null;
  if (state === "waiting_runner" && run.ownMac) {
    return run.nextAction === "wait_for_mac" ? OWN_MAC_WAITING_HEADLINES.wait_for_mac : OWN_MAC_WAITING_HEADLINES.start_mac;
  }
  if (state === "completed" && (run.reasonCode === "input_revision_changed" || run.reasonCode === "input_changed_after_execution")) return KEPT_CURRENT_HEADLINE;
  if (state === "input_changed" && run.reasonCode === INPUT_CHANGED_BEFORE_EXECUTION) return INPUT_CHANGED_BEFORE_EXECUTION_HEADLINE;
  return REMOTE_RUN_STATE_HEADLINES[state];
}

/** 受け付けた直後の知らせ（「受付済み」、受付の後に進んでいれば「受付済み · 処理中」のように続ける）。 */
export function remoteRunAcceptedLabel(run: Parameters<typeof remoteRunHeadline>[0]): string {
  const headline = remoteRunHeadline(run);
  const accepted = REMOTE_RUN_STATE_HEADLINES.queued;
  return headline === null || headline === accepted ? accepted : `${accepted} · ${headline}`;
}

/** 工程の進み具合の 1 行の状態（`pending`・`waiting_capacity` と知らない値は「待機中」）。 */
export const REMOTE_RUN_STEP_STATE_LABELS: Readonly<Partial<Record<RemoteRunStepState, string>>> = {
  succeeded: "完了",
  running: "処理中",
  input_changed: "完了（今の本文を保った）",
  failed: "失敗",
  canceled: "取消済み",
  needs_budget_action: "費用確認待ち",
  needs_storage_action: "保存確認待ち",
  result_unknown: "結果を確認",
};

export const REMOTE_RUN_STEP_WAITING_LABEL = "待機中";

export function remoteRunStepLabel(state: string, reasonCode?: string | null): string {
  if (state === "input_changed" && reasonCode === "input_changed_before_execution") return INPUT_CHANGED_BEFORE_EXECUTION_HEADLINE;
  return REMOTE_RUN_STEP_STATE_LABELS[state as RemoteRunStepState] ?? REMOTE_RUN_STEP_WAITING_LABEL;
}

/** 終わった Run の固定 reason だけを利用者の言葉に直す。未知の値は本文や内部値を出さない。 */
export function remoteRunFailureGuidance(reasonCode?: string | null, route?: string | null): { message: string; retryFromLatest: boolean } {
  switch (reasonCode) {
    case "prompt_too_large":
      return {
        message: route === "own_mac"
          ? "文字起こしや参考ページ、工程の指示が長すぎて、このMacのAIに渡せませんでした。入力全体は30万バイト、工程の指示は20万バイトまでです。内容を短くしてから「最新内容から再実行」を押してください。"
          : "文字起こしや参考ページを含む入力が上限を超え、AIに渡せませんでした。現在の上限は30万バイトです。内容を短くしてから「最新内容から再実行」を押してください。以前の上限で止まった場合は、そのまま押しても進むことがあります。",
        retryFromLatest: true,
      };
    case "prompt_input_unavailable":
    case "prompt_invalid":
      return { message: "元の内容を読み取れませんでした。文字起こしと参考ページが保存済みか確かめてから「最新内容から再実行」を押してください。", retryFromLatest: true };
    case "provider_refused":
      return { message: "AIがこの内容を受け付けませんでした。文字起こしや参考ページを見直してから「最新内容から再実行」を押してください。", retryFromLatest: true };
    case "provider_incomplete":
    case "candidate_too_large":
      return { message: "AIの回答が長く、最後まで保存できませんでした。入力や作る内容を短くしてから「最新内容から再実行」を押してください。", retryFromLatest: true };
    case "prompt_model_unavailable":
      return { message: "この工程に固定されたAIを利用できませんでした。設定の「AIと工程」を確かめ、続く場合はサポートへ連絡してください。", retryFromLatest: false };
    case "attempt_limit":
    case "transport_failure":
      return { message: "通信が繰り返し途切れ、処理を完了できませんでした。時間をおいて「失敗地点から再実行」を押してください。", retryFromLatest: false };
    case "pc_wait_expired":
      return { message: "指定したMacが期限までに受け取れませんでした。Macアプリを開いてから、続きを選び直してください。", retryFromLatest: false };
    case "pc_provider_not_ready":
      return { message: "指定したMacでAIを使えませんでした。Macアプリの設定でAIの登録とログインを確かめてください。", retryFromLatest: false };
    case "pc_provider_failed":
      return { message: "指定したMacのAIで作れませんでした。MacアプリのAI設定を確かめてから、続きを選び直してください。", retryFromLatest: false };
    case "speech_language_unsupported":
      return { message: "この言語の音声を文字起こしできませんでした。録音の言語を対応するものに直してから「最新内容から再実行」を押してください。", retryFromLatest: true };
    case "output_candidate_expired":
      return { message: "作成した内容の保存期限が過ぎました。「失敗地点から再実行」を押してください。", retryFromLatest: false };
    default:
      return { message: "失敗した理由を確認できませんでした。ページを読み直して「失敗地点から再実行」を押し、続く場合はサポートへ連絡してください。", retryFromLatest: false };
  }
}

/**
 * 実行の入口。単工程（入力欄の「＋ → 工程を実行」など）と Web の既存音声からの実行には同じ文を使う。
 * - run: 工程の名前や経路で変えない。Mac の録音ページは {@link RUN_START_LABELS}、Web の新しい音声は {@link AUDIO_START_LABELS} を使う
 * - stop: 動いている実行を止める（Web は止めると受付が取消済みになり再開しないので、押したあとに {@link RUN_STOP_CONFIRM} で確かめる）
 */
export const RUN_ACTION_LABELS = { run: "工程を実行", stop: "止める" } as const;

/** Web の音声の欄で使う開始アクション（#18939・#18947）。工程名で組み立てない。 */
export const AUDIO_START_LABELS = { document: "文書作成を開始", transcription: "文字起こしだけ実施する" } as const;

/** Web の「止める」の確認（受け付けた実行は止めると再開しない）。 */
export const RUN_STOP_CONFIRM = {
  title: "実行を止めますか？",
  description: "止めた実行は再開しません。処理中のものは止めるよう依頼します。すでに送ったデータは、すぐに消せない場合があります。",
  confirmLabel: RUN_ACTION_LABELS.stop,
} as const;

/** 前提変更の印（design-guide-docs.md §2）。確かめられないときは unknown。 */
export const STALE_LABELS = { stale: "前提変更", unknown: "前提を確認できません" } as const;

/**
 * Mac の録音のページの実行の始め方（#18947。何をするかはページのボタン、どこでやるかは設定）。
 * - create: 文字起こしから全工程（原文がまだ無いときの主ボタン）
 * - transcribeOnly: 文字起こしだけ（原文がまだ無いときの控えめな文字ボタン）
 * - continue: 原文の後の残りの工程（「続き」の語は原文ができた後だけ出す）
 * - rerunAll: 完了した録音をすべて作り直す
 */
export type RunStartAction = "create" | "transcribeOnly" | "continue" | "rerunAll";

export const RUN_START_LABELS = {
  create: "文書作成を開始",
  transcribeOnly: "文字起こしだけ実施する",
  continue: "続きを作成",
  rerunAll: "すべて再実行",
} as const satisfies Record<RunStartAction, string>;

/** 録音の状態で出すボタン（主ボタンと、原文がまだ無いときだけの控えめな「文字起こしだけ」）。 */
export function runStartActions(state: { sourceDone: boolean; remaining: number }): {
  primary: RunStartAction;
  secondary: RunStartAction | null;
} {
  if (state.remaining === 0) return { primary: "rerunAll", secondary: null };
  if (!state.sourceDone) return { primary: "create", secondary: "transcribeOnly" };
  return { primary: "continue", secondary: null };
}

/** 続きの工程を作る場所（this_device: この Mac、own_mac: 自分の別の Mac、cloud: クラウド）。 */
export type ContinuationPlace = "this_device" | "own_mac" | "cloud";

/** 場所の 1 行に添える、設定へ移る文字ボタン。 */
export const RUN_PLACE_CHANGE_LABEL = "設定で変更";

/** Mac の設定の「残りの工程」の作る場所（値は Mac アプリの続きの実行先）。 */
export const MAC_CONTINUATION_PLACE_OPTIONS = [
  { value: "this_pc", label: "この Mac" },
  { value: "niho_api", label: "クラウド" },
] as const;

/** 場所の名前（自分の Mac は Mac の名前。無ければ「あなたの Mac」）。 */
function placeName(place: ContinuationPlace, ownMacName?: string): string {
  if (place === "this_device") return "この Mac";
  if (place === "cloud") return "クラウド";
  return ownMacName?.trim() || "あなたの Mac";
}

/** 名前と前後の和文の境目に、名前の端がラテン文字なら半角空白を挟む（「この Mac で」「続きは takuya-macmini で」「クラウドで」）。 */
function spaced(before: string, name: string, after: string): string {
  const head = before && /^[A-Za-z0-9]/.test(name) ? " " : "";
  const tail = after && /[A-Za-z0-9]$/.test(name) ? " " : "";
  return `${before}${head}${name}${tail}${after}`;
}

/**
 * 実行の帯の左の場所の 1 行（ページでは場所を選ばせず、ここに出して「設定で変更」を添える。#18947）。
 * 原文ができた後は続きの場所だけ、まだなら文字起こしと続きの場所（同じなら 1 つ）を言う。
 */
export function runPlaceLine(input: {
  transcription: "this_device" | "cloud";
  continuation: ContinuationPlace;
  ownMacName?: string;
  sourceDone: boolean;
}): string {
  const continuation = placeName(input.continuation, input.ownMacName);
  if (input.sourceDone) return spaced("続きは", continuation, "で作ります");
  if (input.transcription === input.continuation) return spaced("", continuation, "で作ります");
  const transcription = placeName(input.transcription);
  return `${spaced("文字起こしは", transcription, "")}、${spaced("続きは", continuation, "で作ります")}`;
}

/** Web の実行の経路（API の `route`。文字起こしは NIHO、続きは NIHO・自分の Mac・この PC の Macアプリ）。 */
export type RemoteRunRoute = "niho_full" | "niho_transcription" | "own_mac" | "this_pc";

/** Web の経路の並び・名前・説明（`this_pc` は Mac のブラウザでだけ出す。出し分けは Web が決める）。 */
export const REMOTE_RUN_ROUTE_OPTIONS: readonly { value: RemoteRunRoute; label: string; description: string }[] = [
  { value: "niho_full", label: "クラウドで続きを作る", description: "文字起こしから、選んだ工程の最後までクラウドで作ります。" },
  { value: "niho_transcription", label: "クラウドで文字起こしだけ", description: "クラウドで文字起こしだけ済ませ、続きは Mac で行います。" },
  {
    value: "own_mac",
    label: "自分の Mac で続ける",
    description: "文字起こしはクラウドで行い、続きは自分の Mac に登録した AI で作ります。",
  },
  { value: "this_pc", label: "この PC の契約", description: "Mac の NIHO docs で、その Mac に登録した AI の契約を使います。" },
];

export function remoteRunRouteLabel(route: RemoteRunRoute): string {
  return REMOTE_RUN_ROUTE_OPTIONS.find((option) => option.value === route)!.label;
}

/**
 * 録音に固定した AI を、押した時に NIHO の AI へ持ち替えるときの 1 行（docs-core の nihoApiModelSwap が持ち替える工程を返したとき。
 * Web の Mac で作った録音の続きと、Mac の「続きを NIHO に任せる」で同じ文）。
 */
export const NIHO_API_MODEL_SWAP_NOTE = "Mac で選んだ AI の代わりに、クラウドの AI で作ります。";

// ---- 設定の「AIと工程」の言葉（owner 2026-10-18・Epic #18937。画面に「NIHO」を出さない。design-guide-docs.md §3「経路の呼び名」） ----

/** 共有の文字起こし Mac と NIHO API の呼び名。 */
export const CLOUD_LABEL = "クラウド";

/**
 * 設定の「続き」（修正・インサイト以降の工程をどこで作るか）の選択肢。「どこでやるか」だけを設定で決め、
 * 「文字起こしだけ」はページの控えめな文字のボタン（#18947。`runStartActions`）なので選択肢に入れない。
 * `this_pc`・`niho_transcription` は出さない（保存されていれば `niho_full` として扱う）。
 */
export type ContinuationChoice = Extract<RemoteRunRoute, "niho_full" | "own_mac">;

export const CONTINUATION_CHOICES: readonly { value: ContinuationChoice; label: string }[] = [
  { value: "niho_full", label: CLOUD_LABEL },
  { value: "own_mac", label: "自分の Mac" },
];

/** 「続き」の選択肢の名前。自分の Mac は登録した Mac の名前を添える（名前の無い Mac は添えない）。 */
export function continuationChoiceLabel(value: ContinuationChoice, macName?: string | null): string {
  const label = CONTINUATION_CHOICES.find((choice) => choice.value === value)!.label;
  const name = macName?.trim();
  return value === "own_mac" && name ? `${label}（${name}）` : label;
}

/** 保存されている経路を設定の「続き」の値にする（`own_mac` 以外はクラウド）。 */
export function toContinuationChoice(route: RemoteRunRoute | string | null | undefined): ContinuationChoice {
  return route === "own_mac" ? route : "niho_full";
}

/** 使えないときだけ出す帯の文（使えるときの状態は常時出さない）。 */
export const CLOUD_STATUS_WORDS = {
  speechStopped: "クラウドでの文字起こしは受付を止めています。",
  /** Web・スマホ（この Mac の文字起こしが無い）。 */
  speechStoppedNoLocal: "再開まで、新しい録音は始められません。",
  /** Mac（この Mac で文字起こしできる）。 */
  speechStoppedMac: "再開まで、この Mac での文字起こしは使えます。",
  apiStopped: "クラウドの AI は今は使えません。",
  unknown: "状態を確認できませんでした。",
} as const;

/** クラウドの AI が使えない理由（`api-access` の `reasonCode` → 1 文）。 */
export const CLOUD_API_REASON_MESSAGES: Readonly<Record<string, string>> = {
  API_DISABLED: "まだ使えるようになっていません。",
  PERMISSION_DENIED: "使う許可がまだありません。使いたいときは運営に連絡してください。",
  BUDGET_UNAVAILABLE: "運営が上限をまだ決めていないため、使えません。",
  BUDGET_EXHAUSTED: "今月の上限に達したため、来月まで使えません。",
};
export const CLOUD_API_REASON_UNKNOWN = "理由を確認できませんでした。時間をおいて再読み込みしてください。";
