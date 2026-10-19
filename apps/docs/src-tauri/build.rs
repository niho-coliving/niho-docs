fn main() {
  // 公開 Web API key は Rust のビルドにだけ埋め込む。未設定を配布しない。値は診断へ出さない。
  println!("cargo:rerun-if-env-changed=NIHO_ACCOUNT_ENV");
  println!("cargo:rerun-if-env-changed=NIHO_FIREBASE_API_KEY");
  let env = std::env::var("NIHO_ACCOUNT_ENV").unwrap_or_else(|_| "prod".into());
  assert!(env == "prod" || env == "stg", "NIHO_ACCOUNT_ENV must be prod or stg");
  let key = std::env::var("NIHO_FIREBASE_API_KEY").unwrap_or_default();
  assert!(!key.trim().is_empty(), "Set NIHO_FIREBASE_API_KEY for NIHO_ACCOUNT_ENV");
  assert!(
    key.trim() == key,
    "NIHO_FIREBASE_API_KEY must not contain surrounding whitespace"
  );
  tauri_build::build()
}
