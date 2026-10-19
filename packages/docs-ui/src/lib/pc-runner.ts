/**
 * 「この Mac で続きを受ける」（#18804 S2。src-tauri/src/pc_runner.rs）。ON の間、スマホで「自分の Mac で続ける」を選んだ録音の
 * 修正・整理を、この Mac の AI で裏で実行する。画面は ON/OFF と状態の 1 行だけを持つ（受け取り・実行・提出は Rust）。
 * 文言の正は docs/design/design-guide-docs.md §4.1（メニューバーと同じ文）。エラーは画面がコードから文を作る（§7）。
 */

export type PcRunnerState = "off" | "starting" | "idle" | "running" | "needs_login" | "offline";

/** `pc_runner_status` と event `pc-runner://state` の値。`label` は実行中の工程名だけ。 */
export type PcRunnerStatus = {
  enabled: boolean;
  state: PcRunnerState;
  label: string | null;
  /** アカウント共有の実行先がこの Mac を指すための、サーバー発行 ID。 */
  runnerId: string | null;
};

export const PC_RUNNER_STATE_EVENT = "pc-runner://state";

export const PC_RUNNER_TITLE = "この Mac で続きを受ける";
export const PC_RUNNER_HELP =
  "スマホで「自分の Mac で続ける」を選んだ録音の修正・整理を、この Mac の AI で実行します。ON の間はメニューバーに常駐し、Mac へのログイン時に起動します。";
export const PC_RUNNER_SIGNED_OUT = "NIHO アカウントでログインすると使えます";
/** 手元で実行しようとしたときに、スマホからの依頼を実行していた（Rust の `pc_runner_busy`）。 */
export const PC_RUNNER_BUSY_MESSAGE = "スマホから依頼された工程をこの Mac で実行しています。終わってからもう一度お試しください。";
const UNKNOWN_ERROR = "うまくいきませんでした。時間をおいてもう一度お試しください。";

/** 状態の 1 行（メニューバーと同じ文）。 */
export function pcRunnerStatusLine(status: PcRunnerStatus): string {
  switch (status.state) {
    case "idle":
      return "待機中";
    case "running":
      return status.label ? `処理中: ${status.label}` : "処理中";
    case "needs_login":
      return "NIHO アカウントでのログインが必要です";
    case "offline":
      return "NIHO に接続できません";
    default:
      return "準備中";
  }
}

export type ThisMacSelection = { ok: true; runnerId: string } | { ok: false; reason: string };

/**
 * 設定の「残りの工程」でこの Mac を選べるか（#19107）。選べるのは、ON で、サーバー発行の ID を持つとき。選べないときは保存を呼ばず、
 * 今の実行先のまま、`reason` を「残りの工程」の行の下に 1 行で出す。実際の保存の失敗（`saveExecution` の失敗）とは分ける。
 * 理由ごとに次にすることが違う: OFF はスイッチを入れる、ログイン・接続は直す、登録中は待つ。
 */
export function resolveThisMacSelection(status: PcRunnerStatus): ThisMacSelection {
  if (status.enabled && status.runnerId) return { ok: true, runnerId: status.runnerId };
  if (!status.enabled) {
    return { ok: false, reason: `「この Mac」を選ぶには、先にこの画面の「${PC_RUNNER_TITLE}」をオンにしてください。` };
  }
  if (status.state === "needs_login") {
    return { ok: false, reason: `${pcRunnerStatusLine(status)}。ログインしてから、もう一度「この Mac」を選んでください。` };
  }
  if (status.state === "offline") {
    return { ok: false, reason: `${pcRunnerStatusLine(status)}。接続を確かめてから、もう一度「この Mac」を選んでください。` };
  }
  return { ok: false, reason: "この Mac を登録しています。少し待ってから、もう一度「この Mac」を選んでください。" };
}

/** この Mac の状態を読めなかったとき（保存はまだ試していない）。 */
export const THIS_MAC_STATUS_UNAVAILABLE = "この Mac の状態を確認できませんでした。もう一度お試しください。";

const ERROR_TEXT: Record<string, string> = {
  pc_runner_not_signed_in: PC_RUNNER_SIGNED_OUT,
  pc_runner_offline: "NIHO に接続できません。接続を確かめてから、もう一度お試しください。",
  pc_runner_save_failed: "設定を保存できませんでした。もう一度お試しください。",
  pc_runner_login_item_failed: "ログイン時に起動する設定を保存できませんでした。もう一度お試しください。",
  pc_runner_busy: PC_RUNNER_BUSY_MESSAGE,
  pc_runner_storage_local: "NIHO クラウドの保存先を選ぶと使えます。",
};

/** ON/OFF の失敗の文（対応の無いコードは決まった文。Rust の文は素通ししない）。 */
export function pcRunnerErrorText(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : null;
  return (typeof code === "string" && Object.hasOwn(ERROR_TEXT, code) && ERROR_TEXT[code]) || UNKNOWN_ERROR;
}
