//! # niho_desktop_account（NIHO アカウントでログイン）
//!
//! NIHO camera（`apps/camera`）と NIHO docs（`apps/docs`）が**同じコードで**使う、NIHO アカウントでログインする土台
//! （`specs/initiatives/niho-account-desktop-login.md`「共通モジュール」・Epic #18551 の L3 #18555）。
//!
//! - アプリにログイン画面は無い。「NIHO でログイン」で既定のブラウザに niho.life の接続画面を開き、戻りの deep link
//!   （`niho-<app>://auth?code=…&state=…`）の一度きりのコードを PKCE（S256）の verifier と一緒に API へ交換する。
//! - 交換の返りの custom token は Identity Toolkit の REST（`signInWithCustomToken`）で ID token にする（Firebase SDK は同梱しない）。
//!   ID token は**メモリだけ**。Firebase の refresh token は捨てる。更新は NIHO の**接続 refresh token**（app data のファイル。
//!   spec D-16 改）で `POST /api/auth/app-connect/refresh` → `signInWithCustomToken` の 2 呼び出し（期限の 5 分前から・single-flight）。
//!   接続 refresh token は `refresh` のたびに取り替わり、新しい token を `signInWithCustomToken` より前に保存する（D-15 改）。
//! - コード・verifier・custom token・接続 refresh token・ID token はログにも、エラーの文にも、画面にも出さない。
//!
//! ## 公開 API（コア。Tauri に依存しない）
//!
//! | モジュール | 役割 | 主な入口 |
//! |---|---|---|
//! | [`client`] | client の登録表（`contracts/src/app-connect-contract.ts` と同じ値）と環境（prod / stg） | [`ClientId`]・[`Environment`]・[`EnvKind`] |
//! | [`secret`] | 秘密の値とその置き場（接続 refresh token・pending。app data のファイル。Keychain の adapter は署名の後のために残す） | [`Secret`]・[`SecretKind`]・[`AccountSecretStore`]・[`FileSecretStore`]・[`KeychainStore`]・[`keychain`] |
//! | [`http`] | HTTP の口（本番は feature `reqwest` の [`http::ReqwestClient`]、テストは偽） | [`HttpClient`]・[`HttpRequest`]・[`HttpResponse`] |
//! | [`service`] | アカウントの状態と流れ（begin_login・handle_callback・id_token・refresh_profile・logout・logout_everywhere・maintain） | [`AccountService`]・[`AccountState`]・[`Profile`]・[`BeginLogin`] |
//! | [`pkce`] | verifier / challenge / state の生成と、接続 URL・戻りの URL の解釈 | [`pkce::connect_url`]・[`pkce::parse_callback`] |
//! | [`error`] | 失敗（`{ code, message }`。文は利用者向けの日本語。秘密は入れない） | [`AccountError`]・[`error::code`] |
//!
//! ## Tauri の層（feature `tauri`・[`tauri`]）
//!
//! `.plugin(niho_desktop_account::tauri::deep_link()).plugin(niho_desktop_account::tauri::init(env))` で、deep link の受け口・
//! commands（`account_state` ほか）・event `niho-account://changed`・permissions（`permissions/`）がそろう。
//!
//! ## テストの道具
//!
//! feature `test-support` で [`test_support`]（偽の HttpClient・メモリの SecretStore・偽の時計）を公開する。

pub mod api;
pub mod client;
pub mod error;
pub mod http;
pub mod pending;
pub mod pkce;
mod ready;
pub mod secret;
pub mod service;
pub mod store;
#[cfg(feature = "tauri")]
pub mod tauri;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

pub use client::{ClientId, EnvKind, Environment};
pub use error::AccountError;
pub use http::{HttpClient, HttpRequest, HttpResponse};
pub use secret::{keychain, AccountSecretStore, FileSecretStore, KeychainStore, Secret, SecretKind};
pub use service::{
  AccountService, AccountSessionTicket, AccountState, BeginLogin, Clock, ExpiredReason, LogFn, Profile, ServiceConfig,
  SystemClock,
};
