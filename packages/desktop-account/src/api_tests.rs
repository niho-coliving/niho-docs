use super::*;
use crate::client::{ClientId, EnvKind};
use crate::test_support::{api_error, json_response};
use serde_json::json;

fn env() -> Environment {
  Environment::new(ClientId::Camera, EnvKind::Prod, "key")
}

#[test]
fn exchange_request_sends_client_code_verifier_and_device_name() {
  let request = exchange_request(&env(), "code", &Secret::new("verifier"), "  My\u{0}Mac  ");
  assert_eq!(request.method, HttpMethod::Post);
  assert_eq!(request.url, "https://niho.life/api/auth/app-connect/exchange");
  assert_eq!(request.header_value("content-type"), Some("application/json"));
  let body: Value = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
  assert_eq!(
    body,
    json!({ "clientId": "niho-camera", "code": "code", "codeVerifier": "verifier", "deviceName": "MyMac" })
  );
}

#[test]
fn device_name_is_normalized_like_the_contracts() {
  assert_eq!(
    normalize_device_name("  Taku の MacBook Pro  "),
    Some("Taku の MacBook Pro".to_string())
  );
  assert_eq!(normalize_device_name("\u{1}\u{7f}"), None);
  assert_eq!(normalize_device_name(""), None);
  let long = "あ".repeat(100);
  assert_eq!(
    normalize_device_name(&long).unwrap().chars().count(),
    DEVICE_NAME_MAX_CHARS
  );
  // deviceName が空なら body に入れない（API の maxLength に 0 文字が引っかからない）
  let request = exchange_request(&env(), "c", &Secret::new("v"), "   ");
  let body: Value = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
  assert!(body.get("deviceName").is_none());
}

#[test]
fn other_requests_have_the_spec_shape() {
  let refresh = refresh_request(&env(), &Secret::new("rt"));
  assert_eq!(refresh.url, "https://niho.life/api/auth/app-connect/refresh");
  let body: Value = serde_json::from_slice(refresh.body.as_deref().unwrap()).unwrap();
  assert_eq!(body, json!({ "clientId": "niho-camera", "refreshToken": "rt" }));

  let sign_in = sign_in_request(&env(), &Secret::new("ct"));
  assert_eq!(
    sign_in.url,
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=key"
  );
  let body: Value = serde_json::from_slice(sign_in.body.as_deref().unwrap()).unwrap();
  assert_eq!(body, json!({ "token": "ct", "returnSecureToken": true }));

  let me = me_request(&env(), &Secret::new("id"));
  assert_eq!(me.method, HttpMethod::Get);
  assert_eq!(me.url, "https://niho.life/api/auth/me");
  assert_eq!(me.header_value("authorization"), Some("Bearer id"));

  let everywhere = sign_out_everywhere_request(&env(), &Secret::new("id"));
  assert_eq!(everywhere.method, HttpMethod::Post);
  assert_eq!(everywhere.url, "https://niho.life/api/auth/sign-out-everywhere");
  assert_eq!(everywhere.header_value("authorization"), Some("Bearer id"));
  let body: Value = serde_json::from_slice(everywhere.body.as_deref().unwrap()).unwrap();
  assert_eq!(body, json!({}));

  let delete = delete_connection_request(&env(), &Secret::new("id"), "conn_1");
  assert_eq!(delete.method, HttpMethod::Delete);
  assert_eq!(
    delete.url,
    "https://niho.life/api/auth/app-connections/conn_1?reason=logout"
  );
  assert_eq!(delete.header_value("authorization"), Some("Bearer id"));

  let avatar = avatar_request("https://storage.googleapis.com/x/y.jpg?sig=1", 512 * 1024);
  assert_eq!(avatar.max_body_bytes, Some(512 * 1024));
}

#[test]
fn parse_exchange_reads_tokens_and_the_user_summary() {
  let response = json_response(
    200,
    &json!({
      "customToken": "ct", "refreshToken": "rt", "connectionId": "conn_1", "connectionExpiresAt": "2027-04-14T00:00:00.000Z",
      "user": { "id": "u1", "displayName": "たくや", "handle": "takuya", "iconImage": { "objectKey": "k", "signedUrl": "https://img/full", "expiresAt": "x", "thumb": { "signedUrl": "https://img/thumb", "width": 256 } } }
    }),
  );
  let exchange = parse_exchange(&response).unwrap();
  assert_eq!(exchange.custom_token.expose(), "ct");
  assert_eq!(exchange.refresh_token.expose(), "rt");
  assert_eq!(exchange.connection_id, "conn_1");
  assert_eq!(
    exchange.user,
    UserSummary {
      id: "u1".into(),
      display_name: Some("たくや".into()),
      handle: Some("takuya".into()),
      icon_url: Some("https://img/thumb".into()),
    }
  );
  // displayName / handle / iconImage が null でも読める
  let response = json_response(
    200,
    &json!({ "customToken": "ct", "refreshToken": "rt", "connectionId": "c", "connectionExpiresAt": "x",
      "user": { "id": "u1", "displayName": null, "handle": null, "iconImage": null } }),
  );
  let exchange = parse_exchange(&response).unwrap();
  assert_eq!(exchange.user.display_name, None);
  assert_eq!(exchange.user.icon_url, None);
  // 形が違えば Malformed
  let response = json_response(200, &json!({ "customToken": "ct" }));
  assert_eq!(parse_exchange(&response).unwrap_err(), CallFailure::Malformed);
  // http の署名 URL は使わない
  assert_eq!(icon_url(Some(&json!({ "signedUrl": "http://img/x" }))), None);
}

#[test]
fn api_failure_reads_code_and_reason_and_classifies_temporary() {
  let failure = ApiFailure::from_response(&api_error(400, "BAD_REQUEST", Some("code_expired")));
  assert_eq!(failure.status, 400);
  assert!(failure.code_is("BAD_REQUEST"));
  assert!(failure.reason_is("code_expired"));
  assert!(!CallFailure::Api(failure).is_temporary());
  assert!(CallFailure::Api(ApiFailure::from_response(&api_error(503, "SERVICE_UNAVAILABLE", None))).is_temporary());
  assert!(CallFailure::Api(ApiFailure::from_response(&api_error(429, "RATE_LIMITED", None))).is_temporary());
  assert!(CallFailure::Transport(crate::http::HttpErrorKind::Network).is_temporary());
  assert!(CallFailure::Malformed.is_temporary());
  // 本文が JSON でなくても落ちない
  let plain = HttpResponse {
    status: 502,
    headers: vec![],
    body: b"bad gateway".to_vec(),
  };
  let failure = ApiFailure::from_response(&plain);
  assert_eq!(failure.code, None);
  assert_eq!(
    failure.log_value(),
    json!({ "status": 502, "code": null, "reason": null })
  );
}

#[test]
fn parse_sign_in_and_me_and_refresh() {
  let sign_in = parse_sign_in(&json_response(
    200,
    &json!({ "idToken": "id", "refreshToken": "firebase-rt", "expiresIn": "3600" }),
  ))
  .unwrap();
  assert_eq!(sign_in.id_token.expose(), "id");
  assert_eq!(sign_in.expires_in, Duration::from_secs(3600));
  // L6 のサーバー: 取り替えた接続 refresh token を返す
  let refresh = parse_refresh(&json_response(
    200,
    &json!({ "customToken": "ct2", "expiresAt": "x", "refreshToken": "rt2", "connectionExpiresAt": "y" }),
  ))
  .unwrap();
  assert_eq!(refresh.custom_token.expose(), "ct2");
  assert_eq!(refresh.refresh_token.as_ref().map(Secret::expose), Some("rt2"));
  // 旧サーバー（取り替えない）: refreshToken が無い・空なら None（今の token を使い続ける）
  for body in [
    json!({ "customToken": "ct2", "expiresAt": "x", "connectionExpiresAt": "y" }),
    json!({ "customToken": "ct2", "expiresAt": "x", "refreshToken": "", "connectionExpiresAt": "y" }),
  ] {
    let legacy = parse_refresh(&json_response(200, &body)).unwrap();
    assert_eq!(legacy.custom_token.expose(), "ct2");
    assert!(legacy.refresh_token.is_none());
  }
  let me = parse_me(&json_response(
    200,
    &json!({ "user": { "id": "u1", "displayName": " 名前 ", "handle": "h" }, "userIconImage": { "signedUrl": "https://img/a" }, "memberships": [] }),
  ))
  .unwrap();
  assert_eq!(me.display_name, Some("名前".into()));
  assert_eq!(me.icon_url, Some("https://img/a".into()));
  assert_eq!(
    identity_toolkit_reason(&json_response(
      400,
      &json!({ "error": { "code": 400, "message": "INVALID_CUSTOM_TOKEN : extra" } })
    )),
    Some("INVALID_CUSTOM_TOKEN".into())
  );
}
