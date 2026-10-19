//! 公開クライアントだけで検査できる ID・URL の契約。
//! 非公開サーバー側の登録表との照合は niho-app の統合テストで行う。

use super::*;

#[test]
fn client_id_round_trips_as_its_string() {
  for client in ClientId::ALL {
    assert_eq!(ClientId::parse(client.as_str()), Some(client));
    let json = serde_json::to_string(&client).unwrap();
    assert_eq!(json, format!("\"{}\"", client.as_str()));
    assert_eq!(serde_json::from_str::<ClientId>(&json).unwrap(), client);
  }
  assert_eq!(ClientId::parse("niho-desktop"), None);
  assert_eq!(ClientId::Camera.keychain_service(), "life.niho.camera.account");
  assert_eq!(ClientId::Docs.keychain_service(), "life.niho.docs.account");
}

#[test]
fn environment_urls_follow_the_spec() {
  let prod = Environment::new(ClientId::Camera, EnvKind::Prod, "key-prod");
  assert_eq!(prod.connect_base.as_str(), "https://niho.life/");
  assert_eq!(prod.api_base.as_str(), "https://niho.life/api");
  assert_eq!(
    prod.api_url("auth/app-connect/exchange").as_str(),
    "https://niho.life/api/auth/app-connect/exchange"
  );
  assert_eq!(
    prod.api_url("auth/app-connections/c1").as_str(),
    "https://niho.life/api/auth/app-connections/c1"
  );
  assert_eq!(prod.my_page_url().as_str(), "https://niho.life/account");
  assert_eq!(
    prod.sign_in_with_custom_token_url().as_str(),
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=key-prod"
  );

  let stg = Environment::new(ClientId::Docs, EnvKind::Stg, "key-stg");
  assert_eq!(stg.connect_base.as_str(), "https://app-stg.niho.life/");
  assert_eq!(stg.api_url("auth/me").as_str(), "https://app-stg.niho.life/api/auth/me");

  assert_eq!(EnvKind::from_build_env(Some("stg")), EnvKind::Stg);
  assert_eq!(EnvKind::from_build_env(Some(" stg ")), EnvKind::Stg);
  assert_eq!(EnvKind::from_build_env(Some("prod")), EnvKind::Prod);
  assert_eq!(EnvKind::from_build_env(Some("dev")), EnvKind::Prod);
  assert_eq!(EnvKind::from_build_env(None), EnvKind::Prod);
}

#[test]
fn test_environment_accepts_only_plain_loopback_origins() {
  let local = Environment::for_test(ClientId::Docs, EnvKind::Stg, "key", "http://127.0.0.1:4312/api").unwrap();
  assert_eq!(local.api_base().as_str(), "http://127.0.0.1:4312/api");
  for rejected in [
    "https://127.0.0.1:4312",
    "http://example.com:4312",
    "http://user:pass@127.0.0.1:4312",
    "http://127.0.0.1:4312/api?token=secret",
    "http://127.0.0.1:4312/api#fragment",
    "http://127.0.0.1:4312/%2e%2e/api",
    "http://127.0.0.1:4312/api/../private",
  ] {
    assert!(
      Environment::for_test(ClientId::Docs, EnvKind::Stg, "key", rejected).is_err(),
      "{rejected}"
    );
  }
}
