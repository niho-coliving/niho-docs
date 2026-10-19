/**
 * 案件のフォルダ名・成果物のファイル名（spec §4.1 の `projects/<案件名>/`・`artifacts/<工程名>.md`）。
 * Finder で読める形のまま、区切り文字だけを全角に置き換える（「運営会議 10/07」→「運営会議 10／07」）。
 * Rust 側（store.rs の validate_name）は 1 階層の安全な名前だけを受け付ける。
 */

const MAX_CHARS = 100;

export function fileStem(name: string): string {
  const replaced = name
    .normalize("NFC")
    .replace(/\//g, "／")
    .replace(/:/g, "：")
    .replace(/\\/g, "＼")
    // 制御文字（改行・タブなど）は空白にする
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  const clipped = [...replaced].slice(0, MAX_CHARS).join("").trim();
  return clipped || "無題";
}
