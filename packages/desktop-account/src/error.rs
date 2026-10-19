//! 失敗（`{ code, message }`。apps/docs の `CommandError` と同じ形）。`message` は利用者向けの日本語で、画面にそのまま出せる。
//! コード・verifier・token・URL・HTTP の本文は入れない（spec 決まりごと 9）。TS 側は `code` で文言を組み替えてもよい。

use serde::Serialize;
use std::fmt;

/// `code` の一覧。TS（`niho-desktop-account` の `account-copy.ts`）と同じ値。
pub mod code {
  /// 保存先（接続 refresh token・pending）から読めない。code の名前は Keychain の時代のまま（TS と同じ値を保つ）。
  /// 保存先は spec D-16 改で app data のファイル（[`crate::secret::FileSecretStore`]）
  pub const KEYCHAIN_READ_FAILED: &str = "keychain_read_failed";
  /// 保存先に書けない（交換は成功。接続は DELETE した）
  pub const KEYCHAIN_WRITE_FAILED: &str = "keychain_write_failed";
  /// 保存先から消せない
  pub const KEYCHAIN_DELETE_FAILED: &str = "keychain_delete_failed";
  /// この Mac のファイル（プロフィール・顔写真）に書けない
  pub const STORAGE_FAILED: &str = "storage_failed";
  /// pending が無いのに deep link が来た（10 分超・「やめる」のあと）
  pub const LOGIN_NOT_PENDING: &str = "login_not_pending";
  /// deep link の形が違う（スキーム・path・code / state の文字種）
  pub const CALLBACK_INVALID: &str = "callback_invalid";
  /// `state` が pending と合わない（古い deep link・別の試行の戻り）
  pub const CALLBACK_STATE_MISMATCH: &str = "callback_state_mismatch";
  /// 同じ `state` の 2 回目（「開く」の二度押し）
  pub const CALLBACK_DUPLICATE: &str = "callback_duplicate";
  /// 交換の途中で「やめる」・ログアウト・別の試行が入った（作った接続は解除した）
  pub const CALLBACK_CANCELLED: &str = "callback_cancelled";
  /// `exchange` が `code_expired`
  pub const CODE_EXPIRED: &str = "code_expired";
  /// `exchange` が `code_invalid`（消費済み・verifier 不一致・`clientId` 不一致）
  pub const CODE_INVALID: &str = "code_invalid";
  /// `exchange` が 401 `session_revoked`（`start` のあとにパスワード変更・全体失効）
  pub const SESSION_REVOKED: &str = "session_revoked";
  /// 退会済み・無効化（403 `ACCOUNT_DELETED` / `firebase_user_disabled`）
  pub const ACCOUNT_UNAVAILABLE: &str = "account_unavailable";
  /// feature flag OFF（404 `app_connect_disabled`）
  pub const CONNECT_DISABLED: &str = "connect_disabled";
  /// 429
  pub const RATE_LIMITED: &str = "rate_limited";
  /// ネットワーク（接続できない・時間切れ）
  pub const NETWORK: &str = "network";
  /// 5xx・503・形の違う返り
  pub const SERVICE_UNAVAILABLE: &str = "service_unavailable";
  /// `signInWithCustomToken` が 400（鍵と project の不一致など設定の誤り）
  pub const SIGN_IN_FAILED: &str = "sign_in_failed";
  /// 接続が失効・期限切れ（状態は「期限切れ」。もう一度ログイン）
  pub const EXPIRED: &str = "expired";
  /// 更新できていない（状態は「オフライン」。あとで自動で再試行する）
  pub const OFFLINE: &str = "offline";
  /// ログインしていないのに ID token を求めた
  pub const SIGNED_OUT: &str = "signed_out";
  /// `/api/auth/me` の取り直しに失敗（ログインは成立）
  pub const PROFILE_FAILED: &str = "profile_failed";
  /// ログインの最中（pending あり）に始めからやり直そうとした、など状態が合わない
  pub const BUSY: &str = "busy";
  /// 既定のブラウザを開けなかった（Tauri の層）
  pub const BROWSER_FAILED: &str = "browser_failed";
  /// 「ほかの端末でもログアウトする」に失敗した（オフライン・503 など。この Mac はログイン済みのまま。L6・D-17）
  pub const SIGN_OUT_EVERYWHERE_FAILED: &str = "sign_out_everywhere_failed";
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AccountError {
  pub code: String,
  pub message: String,
}

impl AccountError {
  pub fn new(code: &str, message: &str) -> AccountError {
    AccountError {
      code: code.to_string(),
      message: message.to_string(),
    }
  }

  pub fn is(&self, code: &str) -> bool {
    self.code == code
  }

  pub fn keychain_read_failed() -> AccountError {
    AccountError::new(
      code::KEYCHAIN_READ_FAILED,
      "この Mac に保存したログインの情報を読めませんでした。もう一度お試しください。",
    )
  }
  pub fn keychain_write_failed() -> AccountError {
    AccountError::new(
      code::KEYCHAIN_WRITE_FAILED,
      "この Mac に保存できませんでした。もう一度お試しください。",
    )
  }
  pub fn keychain_delete_failed() -> AccountError {
    AccountError::new(
      code::KEYCHAIN_DELETE_FAILED,
      "この Mac からログインの情報を消せませんでした。もう一度お試しください。",
    )
  }
  pub fn storage_failed() -> AccountError {
    AccountError::new(
      code::STORAGE_FAILED,
      "この Mac に保存できませんでした。もう一度お試しください。",
    )
  }
  pub fn login_not_pending() -> AccountError {
    AccountError::new(code::LOGIN_NOT_PENDING, "ログインを始めからやり直してください。")
  }
  pub fn callback_invalid() -> AccountError {
    AccountError::new(code::CALLBACK_INVALID, "ログインを始めからやり直してください。")
  }
  pub fn callback_state_mismatch() -> AccountError {
    AccountError::new(code::CALLBACK_STATE_MISMATCH, "")
  }
  pub fn callback_duplicate() -> AccountError {
    AccountError::new(code::CALLBACK_DUPLICATE, "")
  }
  pub fn callback_cancelled() -> AccountError {
    AccountError::new(code::CALLBACK_CANCELLED, "")
  }

  /// 画面に出さない失敗（spec「失敗の分岐」: 何も表示しない。ログだけ）。
  pub fn is_silent(&self) -> bool {
    self.is(code::CALLBACK_DUPLICATE) || self.is(code::CALLBACK_STATE_MISMATCH) || self.is(code::CALLBACK_CANCELLED)
  }
  pub fn code_expired() -> AccountError {
    AccountError::new(
      code::CODE_EXPIRED,
      "時間切れです。もう一度「NIHO でログイン」を押してください。",
    )
  }
  pub fn code_invalid() -> AccountError {
    AccountError::new(code::CODE_INVALID, "ログインを始めからやり直してください。")
  }
  pub fn session_revoked() -> AccountError {
    AccountError::new(code::SESSION_REVOKED, "ログインをやり直してください。")
  }
  pub fn account_unavailable() -> AccountError {
    AccountError::new(code::ACCOUNT_UNAVAILABLE, "このアカウントは使えません。")
  }
  pub fn connect_disabled() -> AccountError {
    AccountError::new(code::CONNECT_DISABLED, "いまは接続できません。")
  }
  pub fn rate_limited() -> AccountError {
    AccountError::new(code::RATE_LIMITED, "しばらくしてからもう一度お試しください。")
  }
  pub fn network() -> AccountError {
    AccountError::new(
      code::NETWORK,
      "ネットに接続できません。接続してから「NIHO でログイン」をやり直してください。",
    )
  }
  pub fn service_unavailable() -> AccountError {
    AccountError::new(
      code::SERVICE_UNAVAILABLE,
      "接続できません。しばらくしてからもう一度お試しください。",
    )
  }
  pub fn sign_in_failed() -> AccountError {
    AccountError::new(
      code::SIGN_IN_FAILED,
      "接続できません。しばらくしてからもう一度お試しください。",
    )
  }
  pub fn expired() -> AccountError {
    AccountError::new(
      code::EXPIRED,
      "ログインの期限が切れました。もう一度ログインしてください。",
    )
  }
  pub fn offline() -> AccountError {
    AccountError::new(code::OFFLINE, "オフラインです。接続すると自動で続けます。")
  }
  pub fn signed_out() -> AccountError {
    AccountError::new(code::SIGNED_OUT, "ログインしていません。")
  }
  pub fn profile_failed() -> AccountError {
    AccountError::new(code::PROFILE_FAILED, "プロフィールを取り直せませんでした。")
  }
  pub fn busy() -> AccountError {
    AccountError::new(code::BUSY, "ほかの操作が終わるまでお待ちください。")
  }
  pub fn browser_failed() -> AccountError {
    AccountError::new(
      code::BROWSER_FAILED,
      "ブラウザを開けませんでした。もう一度お試しください。",
    )
  }
  /// spec §画面「ログアウトの確認」の失敗の文（`niho-ui` の `ACCOUNT_LOGOUT_COPY` と同じ）。
  pub fn sign_out_everywhere_failed() -> AccountError {
    AccountError::new(
      code::SIGN_OUT_EVERYWHERE_FAILED,
      "ほかの端末をログアウトできませんでした。通信を確かめて、もう一度お試しください。",
    )
  }
}

impl fmt::Display for AccountError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(f, "{}: {}", self.code, self.message)
  }
}

impl std::error::Error for AccountError {}
