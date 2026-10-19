import { countChars } from "./text.js";

/**
 * 「あなたについて」: 文書を作る本人の説明と書き方の希望（呼び名・パーソナライズ）。アプリ全体に 1 つで、保存先の about.json に置く。
 * 工程（文字起こしとお手本からの抽出を除く）の実行と「AIと作る」のシステム側に添える。案件の snapshot にも stale の前提にも入れない。
 */
export type About = {
  /** 呼び名（1 行）。 */
  name: string;
  /** パーソナライズ（自由記述。ABOUT_MAX_CHARS まで）。 */
  text: string;
};

export const EMPTY_ABOUT: About = { name: "", text: "" };

/** 本文の欄の名前（Web の設定と Mac アプリの設定で同じ。owner 2026-10-18・#18886）。 */
export const ABOUT_TEXT_LABEL = "パーソナライズ";

/** 本文の欄の例文（入力欄の placeholder。本人の説明と書き方の希望の両方を書けると分かるようにする）。 */
export const ABOUT_TEXT_EXAMPLE =
  "例: ライフコーチをしています。クライアントとのセッションを録音し、本人の変化や繰り返し出てくるテーマに気づくために使います。録音では私が聞き手です。まとめは箇条書きで短くしてください。";

/** 本文の上限字数。Rust の保存（src-tauri/src/store.rs の ABOUT_MAX_CHARS）と同じ値。 */
export const ABOUT_MAX_CHARS = 2_000;

/** 呼び名は 1 行にする（改行・連続する空白を 1 つの空白にして前後を除く）。 */
function oneLineName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** 呼び名も本文も空（空白だけを含む）か。空ならシステム側に節ごと入れない。 */
export function hasAbout(about: About): boolean {
  return oneLineName(about.name) !== "" || about.text.trim() !== "";
}

/**
 * システム側の「## あなたについて」の節。「呼び名: 〈name〉」の行（空なら省く）＋ 本文（空なら省く）。
 * 両方空なら空文字（節ごと入れない）。
 */
export function aboutSection(about: About): string {
  const name = oneLineName(about.name);
  const text = about.text.trim();
  const parts: string[] = [];
  if (name) parts.push(`呼び名: ${name}`);
  if (text) parts.push(text);
  if (parts.length === 0) return "";
  return `## あなたについて\n\n${parts.join("\n\n")}`;
}

/** 本文が上限を超えているときの理由（超えていなければ null。超えたら保存しない）。 */
export function aboutError(about: About): string | null {
  const chars = countChars(about.text);
  if (chars <= ABOUT_MAX_CHARS) return null;
  return `「${ABOUT_TEXT_LABEL}」は ${ABOUT_MAX_CHARS.toLocaleString("ja-JP")} 字までにしてください（今 ${chars.toLocaleString("ja-JP")} 字）。`;
}

/** 保存された値（about.json の中身）を読む。壊れた・欠けた値は空にする。呼び名は改行を空白にして前後を除く。 */
export function parseAbout(value: unknown): About {
  if (typeof value !== "object" || value === null) return { ...EMPTY_ABOUT };
  const record = value as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? oneLineName(record.name) : "",
    text: typeof record.text === "string" ? record.text : "",
  };
}
