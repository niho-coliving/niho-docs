use super::*;
use crate::client::{ClientId, EnvKind, Environment};

fn env() -> Environment {
  Environment::new(ClientId::Camera, EnvKind::Prod, "key")
}

/// RFC 7636 付録 B のベクタ。
#[test]
fn code_challenge_matches_rfc_7636_appendix_b() {
  let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert_eq!(code_challenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert!(is_valid_verifier(verifier));
  assert!(is_secret_43(&code_challenge(verifier)));
}

#[test]
fn random_values_are_43_char_base64url_and_differ() {
  let a = random_base64url_32().unwrap();
  let b = random_base64url_32().unwrap();
  assert!(is_secret_43(&a), "{a}");
  assert!(is_secret_43(&b), "{b}");
  assert!(is_valid_verifier(&a));
  assert!(is_valid_state(&a));
  assert_ne!(a, b);
}

#[test]
fn shape_checks_follow_the_contracts_regexes() {
  assert!(!is_secret_43(&"a".repeat(42)));
  assert!(is_secret_43(&"a".repeat(43)));
  assert!(!is_secret_43(&"a".repeat(44)));
  assert!(
    !is_secret_43(&format!("{}+", "a".repeat(42))),
    "base64（非 url）の + は不可"
  );
  assert!(!is_valid_verifier(&"a".repeat(42)));
  assert!(is_valid_verifier(&"a".repeat(128)));
  assert!(!is_valid_verifier(&"a".repeat(129)));
  assert!(is_valid_verifier(&format!("{}.~_-", "a".repeat(43))));
  assert!(!is_valid_verifier(&format!("{}/", "a".repeat(43))));
  assert!(is_valid_state(&"s".repeat(22)));
  assert!(!is_valid_state(&"s".repeat(21)));
  assert!(!is_valid_state(&"s".repeat(129)));
}

#[test]
fn connect_url_has_version_challenge_and_state() {
  let url = connect_url(
    &env(),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    "state-value_0123456789abc",
  );
  assert_eq!(
    url.as_str(),
    "https://niho.life/connect/niho-camera?v=1&challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&state=state-value_0123456789abc"
  );
  let docs = Environment::new(ClientId::Docs, EnvKind::Stg, "key");
  assert!(connect_url(&docs, "c", "s")
    .as_str()
    .starts_with("https://app-stg.niho.life/connect/niho-docs?v=1&"));
}

const CODE: &str = "Q0RFQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTI";
const STATE: &str = "c3RhdGUtc3RhdGUtc3RhdGUtc3RhdGUtc3RhdGUtc3Q";

#[test]
fn parse_callback_reads_code_and_state() {
  let parsed = parse_callback(
    ClientId::Camera,
    &format!("niho-camera://auth?code={CODE}&state={STATE}"),
  )
  .unwrap();
  assert_eq!(parsed.code, CODE);
  assert_eq!(parsed.state, STATE);
  // 並びが違っても・末尾の / があっても読む
  let parsed = parse_callback(
    ClientId::Camera,
    &format!("niho-camera://auth/?state={STATE}&code={CODE}"),
  )
  .unwrap();
  assert_eq!(parsed.code, CODE);
}

#[test]
fn parse_callback_rejects_other_schemes_paths_and_shapes() {
  let reject = |raw: String| {
    let error = parse_callback(ClientId::Camera, &raw).unwrap_err();
    assert_eq!(error.code, "callback_invalid", "{raw}");
  };
  reject(format!("niho-docs://auth?code={CODE}&state={STATE}"));
  reject(format!("https://auth?code={CODE}&state={STATE}"));
  reject(format!("niho-camera://other?code={CODE}&state={STATE}"));
  reject(format!("niho-camera://auth/extra?code={CODE}&state={STATE}"));
  reject(format!("niho-camera://auth?state={STATE}"));
  reject(format!("niho-camera://auth?code={CODE}"));
  reject(format!("niho-camera://auth?code=short&state={STATE}"));
  reject(format!("niho-camera://auth?code={CODE}&state=short"));
  reject(format!("niho-camera://auth?code={CODE}%0a&state={STATE}"));
  reject("not a url".to_string());
}
