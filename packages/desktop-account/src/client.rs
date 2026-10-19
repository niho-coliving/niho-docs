//! client の登録表と環境。値の正は `contracts/src/app-connect-contract.ts`（spec「client の登録表」）。一致は
//! `client_tests.rs` が文字列の照合で守る。アプリを足すときは contracts と、ここの enum に 1 つ足す。

use serde::{Deserialize, Serialize};
use url::Url;

/// アプリ（`clientId`）。文字列は contracts の `APP_CONNECT_CLIENTS` のキーと同じ。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ClientId {
  #[serde(rename = "niho-camera")]
  Camera,
  #[serde(rename = "niho-docs")]
  Docs,
}

impl ClientId {
  pub const ALL: [ClientId; 2] = [ClientId::Camera, ClientId::Docs];

  /// `clientId`（API の入力・接続 URL の path）。
  pub fn as_str(self) -> &'static str {
    match self {
      ClientId::Camera => "niho-camera",
      ClientId::Docs => "niho-docs",
    }
  }

  /// 利用者に見せる名前（固有名詞。文言のアプリごとの区別はこれだけ）。
  pub fn name(self) -> &'static str {
    match self {
      ClientId::Camera => "NIHO photo",
      ClientId::Docs => "NIHO docs",
    }
  }

  pub fn bundle_id(self) -> &'static str {
    match self {
      ClientId::Camera => "life.niho.camera",
      ClientId::Docs => "life.niho.docs",
    }
  }

  /// 戻りの deep link の URL スキーム（`<scheme>://auth`）。
  pub fn scheme(self) -> &'static str {
    match self {
      ClientId::Camera => "niho-camera",
      ClientId::Docs => "niho-docs",
    }
  }

  /// Keychain の service 名（spec「共通モジュール」: `life.niho.<app>.account`）。
  pub fn keychain_service(self) -> String {
    format!("{}.account", self.bundle_id())
  }

  pub fn parse(value: &str) -> Option<ClientId> {
    ClientId::ALL.into_iter().find(|client| client.as_str() == value)
  }
}

/// 戻りの deep link の path（`<scheme>://auth`）。contracts の `APP_CONNECT_CALLBACK_PATH`。
pub const CALLBACK_PATH: &str = "auth";
/// 接続 URL（`/connect/<app>?v=1&…`）の版。contracts の `APP_CONNECT_PROTOCOL_VERSION`。
pub const PROTOCOL_VERSION: u32 = 1;
/// pending（verifier・state）の寿命。contracts の `APP_CONNECT_PENDING_TTL_MS`。
pub const PENDING_TTL_MS: u64 = 10 * 60 * 1000;
/// `deviceName` の最大長（文字）。contracts の `APP_CONNECT_DEVICE_NAME_MAX_LENGTH`。
pub const DEVICE_NAME_MAX_CHARS: usize = 80;

/// prod / stg。ビルドで固定する（spec「環境」）。URL に環境を入れない。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvKind {
  Prod,
  Stg,
}

impl EnvKind {
  /// `NIHO_ACCOUNT_ENV`（ビルド時の env）の値から。知らない値・無いときは prod。
  pub fn from_build_env(value: Option<&str>) -> EnvKind {
    match value.map(str::trim) {
      Some("stg") => EnvKind::Stg,
      _ => EnvKind::Prod,
    }
  }

  pub fn connect_base(self) -> &'static str {
    match self {
      EnvKind::Prod => "https://niho.life",
      EnvKind::Stg => "https://app-stg.niho.life",
    }
  }
}

/// アプリの環境（spec「共通モジュール」の `Environment`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Environment {
  pub(crate) client: ClientId,
  pub(crate) kind: EnvKind,
  /// `https://niho.life`（接続画面・マイページ）
  pub(crate) connect_base: Url,
  /// `https://niho.life/api`
  pub(crate) api_base: Url,
  /// Firebase の Web API key（公開値。web の `NEXT_PUBLIC_FIREBASE_API_KEY` と同じもの）
  pub(crate) firebase_api_key: String,
  /// Identity Toolkit の REST の base（既定は Google の本番。テストだけ差し替える）
  pub(crate) identity_toolkit_base: Url,
}

impl Environment {
  /// prod / stg の既定の URL で作る。`firebase_api_key` は env ごとの値をアプリがビルドで埋める。
  pub fn new(client: ClientId, kind: EnvKind, firebase_api_key: impl Into<String>) -> Environment {
    let connect_base = Url::parse(kind.connect_base()).expect("connect base is a valid URL");
    let api_base = connect_base.join("api").expect("api base is a valid URL");
    Environment {
      client,
      kind,
      connect_base,
      api_base,
      firebase_api_key: firebase_api_key.into(),
      identity_toolkit_base: Url::parse(IDENTITY_TOOLKIT_BASE).expect("identity toolkit base is a valid URL"),
    }
  }

  pub fn kind(&self) -> EnvKind {
    self.kind
  }

  pub fn api_base(&self) -> &Url {
    &self.api_base
  }

  /// ローカル HTTP fixture を使う crate test / test-support 専用 constructor。
  #[cfg(any(test, feature = "test-support"))]
  pub fn for_test(
    client: ClientId,
    kind: EnvKind,
    firebase_api_key: impl Into<String>,
    origin: &str,
  ) -> Result<Environment, &'static str> {
    if origin.contains('%') || origin.contains("..") {
      return Err("invalid test origin");
    }
    let mut connect_base = Url::parse(origin).map_err(|_| "invalid test origin")?;
    let host = connect_base.host_str().ok_or("invalid test origin")?;
    let local = host == "localhost"
      || host
        .parse::<std::net::IpAddr>()
        .is_ok_and(|address| address.is_loopback());
    if connect_base.scheme() != "http"
      || !local
      || !connect_base.username().is_empty()
      || connect_base.password().is_some()
      || connect_base.query().is_some()
      || connect_base.fragment().is_some()
      || !matches!(connect_base.path(), "" | "/" | "/api" | "/api/")
    {
      return Err("invalid test origin");
    }
    connect_base.set_path("/");
    let api_base = connect_base.join("api").map_err(|_| "invalid test origin")?;
    Ok(Environment {
      client,
      kind,
      connect_base: connect_base.clone(),
      api_base,
      firebase_api_key: firebase_api_key.into(),
      identity_toolkit_base: connect_base,
    })
  }

  /// `/api/...` の URL（`path` は先頭の `/` 無し。例 `auth/app-connect/exchange`）。
  pub fn api_url(&self, path: &str) -> Url {
    let mut base = self.api_base.clone();
    {
      let mut segments = base.path_segments_mut().expect("api base is not cannot-be-a-base");
      segments.pop_if_empty();
      for segment in path.split('/').filter(|segment| !segment.is_empty()) {
        segments.push(segment);
      }
    }
    base
  }

  /// マイページ（spec: `https://niho.life/account`）。
  pub fn my_page_url(&self) -> Url {
    self.connect_base.join("account").expect("my page is a valid URL")
  }

  /// `POST …/v1/accounts:signInWithCustomToken?key=<Web API key>`
  pub fn sign_in_with_custom_token_url(&self) -> Url {
    let mut url = self
      .identity_toolkit_base
      .join("v1/accounts:signInWithCustomToken")
      .expect("identity toolkit path is valid");
    url.query_pairs_mut().append_pair("key", &self.firebase_api_key);
    url
  }
}

pub const IDENTITY_TOOLKIT_BASE: &str = "https://identitytoolkit.googleapis.com";

#[cfg(test)]
#[path = "client_tests.rs"]
mod client_tests;
