// リリースビルドで Windows の余分なコンソール窓を出さない（Mac 専用だが Tauri の雛形どおり）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  niho_docs_lib::run()
}
