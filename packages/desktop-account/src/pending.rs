//! pending（「NIHO でログイン」を押してから戻ってくるまでの一時の状態。spec「用語」）。Keychain に JSON で置き、
//! 10 分で捨てる。アプリを閉じても deep link で起動したときに続けられる。

use crate::client::{ClientId, PENDING_TTL_MS};
use crate::secret::Secret;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
  /// PKCE の code_verifier（秘密。ログに出さない）
  pub verifier: String,
  pub state: String,
  pub client: ClientId,
  pub started_at_ms: u64,
  /// 戻りの deep link を受けて交換を始めた（この pending のコードは API に再提示しない）
  #[serde(default)]
  pub consumed: bool,
}

/// verifier は出さない。
impl std::fmt::Debug for Pending {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("Pending")
      .field("state", &self.state)
      .field("client", &self.client)
      .field("started_at_ms", &self.started_at_ms)
      .field("consumed", &self.consumed)
      .field("verifier", &"[REDACTED]")
      .finish()
  }
}

pub fn epoch_ms(time: SystemTime) -> u64 {
  time
    .duration_since(UNIX_EPOCH)
    .map(|elapsed| elapsed.as_millis() as u64)
    .unwrap_or_default()
}

impl Pending {
  pub fn started_at(&self) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(self.started_at_ms)
  }

  pub fn expires_at(&self) -> SystemTime {
    self.started_at() + Duration::from_millis(PENDING_TTL_MS)
  }

  pub fn is_expired(&self, now: SystemTime) -> bool {
    now >= self.expires_at()
  }

  /// Keychain に置く形（JSON 全体を 1 つの secret として）。
  pub fn to_secret(&self) -> Secret {
    Secret::new(serde_json::to_string(self).unwrap_or_default())
  }

  /// Keychain から読んだ形。壊れていれば `None`（捨てる）。
  pub fn from_secret(secret: &Secret, client: ClientId) -> Option<Pending> {
    let pending: Pending = serde_json::from_str(secret.expose()).ok()?;
    (pending.client == client
      && crate::pkce::is_valid_verifier(&pending.verifier)
      && crate::pkce::is_valid_state(&pending.state))
    .then_some(pending)
  }
}
