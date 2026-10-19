//! token の更新（spec「token の寿命と更新」「更新の失敗時」）・ログアウト・起動時の復元。

use super::service_tests::{
  refresh_ok, refresh_ok_legacy, sign_in_ok, Harness, CUSTOM_TOKEN_2, ID_TOKEN, ID_TOKEN_2, REFRESH_TOKEN,
  REFRESH_TOKEN_2,
};
use super::*;
use crate::http::{HttpError, HttpErrorKind};
use crate::test_support::{api_error, json_response};
use serde_json::json;

#[tokio::test]
async fn id_token_refreshes_five_minutes_before_expiry_with_the_connection_refresh_token() {
  let h = Harness::new();
  h.sign_in().await;
  h.server.set("signIn", sign_in_ok(ID_TOKEN_2));

  h.clock.advance(Duration::from_secs(54 * 60));
  assert_eq!(
    h.service.id_token().await.unwrap().expose(),
    ID_TOKEN,
    "まだ 6 分あるので更新しない"
  );
  assert!(h.http.requests().is_empty());

  h.clock.advance(Duration::from_secs(60 + 1));
  assert_eq!(
    h.service.id_token().await.unwrap().expose(),
    ID_TOKEN_2,
    "5 分前から更新"
  );
  assert_eq!(
    h.http.paths(),
    vec![
      "POST /api/auth/app-connect/refresh",
      "POST /v1/accounts:signInWithCustomToken"
    ]
  );
  assert_eq!(
    h.request_body(0),
    json!({ "clientId": "niho-camera", "refreshToken": REFRESH_TOKEN })
  );
  assert_eq!(
    h.request_body(1),
    json!({ "token": CUSTOM_TOKEN_2, "returnSecureToken": true })
  );
  assert_eq!(
    h.secrets.peek(SecretKind::RefreshToken).unwrap().expose(),
    REFRESH_TOKEN_2,
    "接続 refresh token は取り替えた新しいものを保存する（D-15 改）"
  );
  assert!(h.log.has("account.refresh.succeeded"));
  h.assert_no_secret_in_logs();

  // maintain の次の予定は新しい期限の 5 分前
  let due = h.service.maintain().await.unwrap();
  assert_eq!(due, h.clock.now() + Duration::from_secs(55 * 60));
}

#[tokio::test]
async fn refresh_is_single_flight() {
  let h = Harness::new();
  h.sign_in().await;
  h.server.set("signIn", sign_in_ok(ID_TOKEN_2));
  h.clock.advance(Duration::from_secs(56 * 60));
  let (a, b, c) = tokio::join!(h.service.id_token(), h.service.id_token(), h.service.id_token());
  assert_eq!(a.unwrap().expose(), ID_TOKEN_2);
  assert_eq!(b.unwrap().expose(), ID_TOKEN_2);
  assert_eq!(c.unwrap().expose(), ID_TOKEN_2);
  assert_eq!(
    h.http.paths(),
    vec![
      "POST /api/auth/app-connect/refresh",
      "POST /v1/accounts:signInWithCustomToken"
    ],
    "同時に 2 本走らせない"
  );
}

#[tokio::test]
async fn revoked_connection_makes_the_account_expired_and_keeps_the_profile() {
  for (reason, expected) in [
    ("app_connection_revoked", ExpiredReason::ConnectionRevoked),
    ("session_revoked", ExpiredReason::SessionRevoked),
  ] {
    let h = Harness::new();
    let profile = h.sign_in().await;
    h.server
      .set("refresh", Ok(api_error(401, "UNAUTHORIZED", Some(reason))));
    h.clock.advance(Duration::from_secs(56 * 60));
    assert_eq!(h.service.id_token().await.unwrap_err().code, "expired");
    assert_eq!(
      h.service.state(),
      AccountState::Expired {
        profile: profile.clone(),
        reason: expected
      },
      "{reason}"
    );
    assert_eq!(
      h.secrets.peek(SecretKind::RefreshToken),
      None,
      "接続 refresh token は消す"
    );
    assert!(h.account_file().exists(), "プロフィールは残す");
    assert!(profile.avatar_path.as_ref().unwrap().exists(), "顔写真も残す");
    assert_eq!(
      h.http.paths(),
      vec!["POST /api/auth/app-connect/refresh"],
      "signIn しない"
    );
    // 2 回目は通信しない
    assert_eq!(h.service.id_token().await.unwrap_err().code, "expired");
    assert_eq!(h.http.paths().len(), 1);
    // 再起動しても期限切れのまま
    let restarted = h.restart();
    assert!(matches!(restarted.state(), AccountState::Expired { reason: r, .. } if r == expected));
    assert!(h.log.has("account.expired"));
    h.assert_no_secret_in_logs();
  }
}

#[tokio::test]
async fn deleted_or_disabled_account_wipes_everything() {
  for reply in [
    Ok(api_error(403, "ACCOUNT_DELETED", None)),
    Ok(api_error(403, "FORBIDDEN", Some("firebase_user_disabled"))),
  ] {
    let h = Harness::new();
    let profile = h.sign_in().await;
    h.server.set("refresh", reply);
    h.clock.advance(Duration::from_secs(56 * 60));
    assert_eq!(h.service.id_token().await.unwrap_err().code, "account_unavailable");
    assert_eq!(h.service.state(), AccountState::SignedOut);
    assert_eq!(h.secrets.peek(SecretKind::RefreshToken), None);
    assert!(!h.account_file().exists());
    assert!(!profile.avatar_path.unwrap().exists());
    assert_eq!(h.restart().state(), AccountState::SignedOut);
  }
}

#[tokio::test]
async fn flag_off_is_temporary_and_keeps_the_state() {
  let h = Harness::new();
  let profile = h.sign_in().await;
  h.server
    .set("refresh", Ok(api_error(404, "NOT_FOUND", Some("app_connect_disabled"))));
  h.clock.advance(Duration::from_secs(56 * 60));
  assert_eq!(
    h.service.id_token().await.unwrap().expose(),
    ID_TOKEN,
    "期限内tokenを使い続ける"
  );
  assert_eq!(
    h.service.state(),
    AccountState::SignedIn { profile },
    "停止中も既存状態を保つ"
  );
  assert!(h.secrets.peek(SecretKind::RefreshToken).is_some());
  assert_eq!(h.service.next_retry_at(), Some(h.clock.now() + Duration::from_secs(1)));
  assert_eq!(h.service.id_token().await.unwrap().expose(), ID_TOKEN);
  assert_eq!(h.http.paths().len(), 1, "バックオフ中に再試行しない");
}

#[tokio::test]
async fn network_failures_go_offline_with_exponential_backoff() {
  let h = Harness::new();
  let profile = h.sign_in().await;
  h.server.set("refresh", Err(HttpError::new(HttpErrorKind::Network)));
  h.clock.advance(Duration::from_secs(56 * 60));

  // 1 回目の失敗: まだ期限内の token はそのまま使える。状態はオフライン
  assert_eq!(
    h.service.id_token().await.unwrap().expose(),
    ID_TOKEN,
    "期限内の token は使える"
  );
  assert_eq!(
    h.service.state(),
    AccountState::Offline {
      profile: profile.clone()
    }
  );
  assert_eq!(h.http.paths().len(), 1);
  assert_eq!(h.service.next_retry_at(), Some(h.clock.now() + Duration::from_secs(1)));

  // バックオフ中は通信しない
  assert_eq!(h.service.id_token().await.unwrap().expose(), ID_TOKEN);
  assert_eq!(h.http.paths().len(), 1);

  // 1 → 2 → 4 秒
  h.clock.advance(Duration::from_secs(1));
  let _ = h.service.id_token().await;
  assert_eq!(h.http.paths().len(), 2);
  assert_eq!(h.service.next_retry_at(), Some(h.clock.now() + Duration::from_secs(2)));
  h.clock.advance(Duration::from_secs(2));
  let _ = h.service.id_token().await;
  assert_eq!(h.http.paths().len(), 3);
  assert_eq!(h.service.next_retry_at(), Some(h.clock.now() + Duration::from_secs(4)));
  assert_eq!(
    h.service.maintain().await,
    h.service.next_retry_at(),
    "次の手入れは再試行の時刻"
  );

  // 期限が切れた token はもう返さない（オフライン）
  h.clock.advance(Duration::from_secs(5 * 60));
  assert_eq!(h.service.id_token().await.unwrap_err().code, "offline");
  assert_eq!(h.http.paths().len(), 4);
  assert_eq!(h.service.refresh_profile().await.unwrap_err().code, "offline");

  // 上限は 5 分
  for _ in 0..12 {
    h.clock.advance(Duration::from_secs(10 * 60));
    let _ = h.service.id_token().await;
  }
  assert_eq!(h.service.next_retry_at(), Some(h.clock.now() + BACKOFF_MAX));

  // 復帰すると「ログイン済み」に戻り、バックオフが消える
  h.server.set("refresh", refresh_ok());
  h.server.set("signIn", sign_in_ok(ID_TOKEN_2));
  h.clock.advance(BACKOFF_MAX);
  assert_eq!(h.service.id_token().await.unwrap().expose(), ID_TOKEN_2);
  assert_eq!(h.service.state(), AccountState::SignedIn { profile });
  assert_eq!(h.service.next_retry_at(), None);
  let states = h.states.lock().unwrap().clone();
  assert_eq!(states.last().unwrap(), "signedIn");
  assert!(states.contains(&"offline".to_string()));
  h.assert_no_secret_in_logs();
}

#[tokio::test]
async fn server_errors_and_sign_in_config_errors_are_temporary() {
  for reply in [
    (
      "refresh",
      Ok(api_error(
        503,
        "SERVICE_UNAVAILABLE",
        Some("firebase_user_lookup_failed"),
      )),
    ),
    ("refresh", Ok(api_error(500, "INTERNAL", None))),
    ("refresh", Ok(api_error(429, "RATE_LIMITED", None))),
    ("refresh", Ok(json_response(200, &json!({ "nope": 1 })))),
    (
      "signIn",
      Ok(json_response(
        400,
        &json!({ "error": { "message": "INVALID_CUSTOM_TOKEN" } }),
      )),
    ),
    ("signIn", Ok(api_error(503, "x", None))),
    ("signIn", Err(HttpError::new(HttpErrorKind::Timeout))),
  ] {
    let h = Harness::new();
    let profile = h.sign_in().await;
    h.server.set(reply.0, reply.1);
    h.clock.advance(Duration::from_secs(61 * 60));
    assert_eq!(h.service.id_token().await.unwrap_err().code, "offline");
    assert_eq!(h.service.state(), AccountState::Offline { profile });
    assert!(h.secrets.peek(SecretKind::RefreshToken).is_some(), "token は残す");
    assert!(h.service.next_retry_at().is_some());
    h.assert_no_secret_in_logs();
  }
  // signIn の 400 は理由をログに残す
  let h = Harness::new();
  h.sign_in().await;
  h.server.set(
    "signIn",
    Ok(json_response(
      400,
      &json!({ "error": { "message": "CREDENTIAL_MISMATCH" } }),
    )),
  );
  h.clock.advance(Duration::from_secs(61 * 60));
  let _ = h.service.id_token().await;
  assert_eq!(
    h.log.payloads("account.sign_in.rejected"),
    vec![json!({ "reason": "CREDENTIAL_MISMATCH" })]
  );
}

#[tokio::test]
async fn keychain_problems_during_refresh() {
  // 接続 refresh token が Keychain から消えていた → 期限切れ
  let h = Harness::new();
  let profile = h.sign_in().await;
  h.secrets.delete(SecretKind::RefreshToken).unwrap();
  h.clock.advance(Duration::from_secs(56 * 60));
  assert_eq!(h.service.id_token().await.unwrap_err().code, "expired");
  assert_eq!(
    h.service.state(),
    AccountState::Expired {
      profile,
      reason: ExpiredReason::ConnectionRevoked
    }
  );
  assert!(h.http.paths().is_empty());

  // Keychain が読めない → 一時的（オフライン）
  let h = Harness::new();
  let profile = h.sign_in().await;
  h.secrets.fail_get(SecretKind::RefreshToken, true);
  h.clock.advance(Duration::from_secs(61 * 60));
  assert_eq!(h.service.id_token().await.unwrap_err().code, "offline");
  assert_eq!(h.service.state(), AccountState::Offline { profile });
}

#[tokio::test]
async fn me_returning_revoked_expires_the_account() {
  let h = Harness::new();
  h.sign_in().await;
  h.server
    .set("me", Ok(api_error(401, "UNAUTHORIZED", Some("app_connection_revoked"))));
  assert_eq!(h.service.refresh_profile().await.unwrap_err().code, "expired");
  assert!(matches!(
    h.service.state(),
    AccountState::Expired {
      reason: ExpiredReason::ConnectionRevoked,
      ..
    }
  ));
  assert_eq!(h.secrets.peek(SecretKind::RefreshToken), None);

  // /me のほかの失敗はプロフィールの失敗（状態は変えない）
  let h = Harness::new();
  let profile = h.sign_in().await;
  h.server.set("me", Ok(api_error(500, "INTERNAL", None)));
  assert_eq!(h.service.refresh_profile().await.unwrap_err().code, "profile_failed");
  assert_eq!(h.service.state(), AccountState::SignedIn { profile });

  // /me で顔写真が無くなったら消す
  let h = Harness::new();
  let profile = h.sign_in().await;
  let avatar = profile.avatar_path.clone().unwrap();
  h.server.set(
    "me",
    Ok(json_response(
      200,
      &json!({ "user": { "id": "user_1", "displayName": "名前", "handle": null }, "userIconImage": null, "memberships": [] }),
    )),
  );
  let updated = h.service.refresh_profile().await.unwrap();
  assert_eq!(updated.avatar_path, None);
  assert_eq!(updated.handle, None);
  assert_eq!(updated.display_name, "名前");
  assert!(!avatar.exists());
}

#[tokio::test]
async fn logout_revokes_this_connection_best_effort_and_clears_the_mac() {
  let h = Harness::new();
  let profile = h.sign_in().await;
  h.service.logout().await.unwrap();
  assert_eq!(h.http.paths(), vec!["DELETE /api/auth/app-connections/conn_1"]);
  let delete = &h.http.requests()[0];
  assert!(
    delete.url.ends_with("/api/auth/app-connections/conn_1?reason=logout"),
    "{}",
    delete.url
  );
  assert_eq!(
    delete.header_value("authorization"),
    Some(format!("Bearer {ID_TOKEN}").as_str())
  );
  assert_eq!(h.service.state(), AccountState::SignedOut);
  assert_eq!(h.secrets.peek(SecretKind::RefreshToken), None);
  assert_eq!(h.secrets.peek(SecretKind::Pending), None);
  assert!(!h.account_file().exists());
  assert!(!profile.avatar_path.unwrap().exists());
  assert_eq!(h.log.payloads("account.logout"), vec![json!({ "deleted": true })]);
  assert_eq!(h.restart().state(), AccountState::SignedOut);
  assert_eq!(h.service.id_token().await.unwrap_err().code, "signed_out");
  h.assert_no_secret_in_logs();

  // ネットが無ければ手元だけ消す
  let h = Harness::new();
  h.sign_in().await;
  h.server.set("delete", Err(HttpError::new(HttpErrorKind::Network)));
  h.service.logout().await.unwrap();
  assert_eq!(h.service.state(), AccountState::SignedOut);
  assert_eq!(h.log.payloads("account.logout"), vec![json!({ "deleted": false })]);

  // 期限内の ID token が無ければ DELETE しない（更新も試みない）
  let h = Harness::new();
  h.sign_in().await;
  h.clock.advance(Duration::from_secs(61 * 60));
  h.service.logout().await.unwrap();
  assert!(h.http.requests().is_empty());
  assert_eq!(h.log.payloads("account.logout"), vec![json!({ "deleted": null })]);

  // 期限切れからのログアウト（名前を消す）
  let h = Harness::new();
  h.sign_in().await;
  h.server.set(
    "refresh",
    Ok(api_error(401, "UNAUTHORIZED", Some("app_connection_revoked"))),
  );
  h.clock.advance(Duration::from_secs(56 * 60));
  let _ = h.service.id_token().await;
  h.http.clear();
  h.service.logout().await.unwrap();
  assert!(h.http.requests().is_empty());
  assert_eq!(h.service.state(), AccountState::SignedOut);
  assert!(!h.account_file().exists());

  // Keychain から消せないときは Err を返す（状態は未ログイン）
  let h = Harness::new();
  h.sign_in().await;
  h.secrets.fail_delete(SecretKind::RefreshToken, true);
  assert_eq!(h.service.logout().await.unwrap_err().code, "keychain_delete_failed");
  assert_eq!(h.service.state(), AccountState::SignedOut);
}

#[tokio::test]
async fn restore_and_start_bring_back_the_saved_account() {
  let h = Harness::new();
  let profile = h.sign_in().await;

  // 再起動: ファイルのプロフィールで即「ログイン済み」。start で更新してプロフィールを取り直す
  let restarted = h.restart();
  assert_eq!(
    restarted.state(),
    AccountState::SignedIn {
      profile: profile.clone()
    }
  );
  assert!(h.http.requests().is_empty(), "restore は通信しない");
  h.server.set("signIn", sign_in_ok(ID_TOKEN_2));
  restarted.start().await;
  assert_eq!(
    h.http.paths(),
    vec![
      "POST /api/auth/app-connect/refresh",
      "POST /v1/accounts:signInWithCustomToken",
      "GET /api/auth/me",
      "GET /avatar.jpg"
    ]
  );
  assert_eq!(restarted.id_token().await.unwrap().expose(), ID_TOKEN_2);
  assert_eq!(
    restarted.state(),
    AccountState::SignedIn {
      profile: profile.clone()
    }
  );

  // ネットが無い起動: 保存してあるプロフィールで「オフライン」
  h.http.clear();
  h.server.set("refresh", Err(HttpError::new(HttpErrorKind::Network)));
  let offline = h.restart();
  offline.start().await;
  assert_eq!(
    offline.state(),
    AccountState::Offline {
      profile: profile.clone()
    }
  );
  assert!(h.log.has("account.start.profile_failed"));

  // Keychain の接続 refresh token だけ無い → 期限切れ
  h.secrets.delete(SecretKind::RefreshToken).unwrap();
  let expired = h.restart();
  assert_eq!(
    expired.state(),
    AccountState::Expired {
      profile: profile.clone(),
      reason: ExpiredReason::ConnectionRevoked
    }
  );
  assert!(h.log.has("account.restore.refresh_token_missing"));

  // Keychain が読めない → オフライン（ログイン済みとみなして待つ）
  h.secrets.put(SecretKind::RefreshToken, Secret::new(REFRESH_TOKEN));
  h.secrets.fail_get(SecretKind::RefreshToken, true);
  // 期限切れの印が付いたので一度消す
  let mut stored: StoredAccount = serde_json::from_str(&std::fs::read_to_string(h.account_file()).unwrap()).unwrap();
  stored.expired = None;
  std::fs::write(h.account_file(), serde_json::to_vec(&stored).unwrap()).unwrap();
  let unreadable = h.restart();
  assert_eq!(unreadable.state(), AccountState::Offline { profile });
  h.assert_no_secret_in_logs();
}

#[tokio::test]
async fn account_json_from_an_older_or_broken_version_is_ignored() {
  let h = Harness::new();
  std::fs::create_dir_all(h.dir.0.join("data")).unwrap();
  std::fs::write(h.account_file(), b"{ broken").unwrap();
  assert_eq!(h.restart().state(), AccountState::SignedOut);
  std::fs::write(
    h.account_file(),
    serde_json::to_vec(&json!({ "version": 2, "userId": "u", "connectionId": "c", "displayName": "x", "handle": null, "avatarFile": null }))
      .unwrap(),
  )
  .unwrap();
  assert_eq!(h.restart().state(), AccountState::SignedOut);
}

#[tokio::test]
async fn logging_out_while_the_profile_is_being_fetched_does_not_resurrect_it() {
  let h = Harness::new();
  let profile = h.sign_in().await;
  h.http.hold_path("/auth/me");
  let service = h.service.clone();
  let task = tokio::spawn(async move { service.refresh_profile().await });
  tokio::task::yield_now().await;
  assert_eq!(h.http.paths(), vec!["GET /api/auth/me"], "/me を待っている");

  // 待っている間にログアウト（DELETE はすぐ返る）→ 全部消えた後に /me が返る
  h.service.logout().await.unwrap();
  assert_eq!(h.service.state(), AccountState::SignedOut);
  h.http.release();
  assert_eq!(task.await.unwrap().unwrap_err().code, "signed_out");

  // プロフィール・顔写真は復活しない
  assert_eq!(h.service.state(), AccountState::SignedOut);
  assert!(!h.account_file().exists());
  assert!(!profile.avatar_path.unwrap().exists());
  assert_eq!(h.restart().state(), AccountState::SignedOut);
  assert!(h.log.has("account.profile.skipped"));
}

#[tokio::test]
async fn rotated_refresh_token_is_saved_before_sign_in_and_used_next_time() {
  let h = Harness::new();
  h.sign_in().await;
  h.server.set("signIn", sign_in_ok(ID_TOKEN_2));
  h.clock.advance(Duration::from_secs(56 * 60));
  // signInWithCustomToken を止めた状態で、新しい token がもう保存先にあること（順序: refresh → 保存 → signIn）
  h.http.hold_path("signInWithCustomToken");
  let service = h.service.clone();
  let task = tokio::spawn(async move { service.id_token().await });
  for _ in 0..50 {
    if h.http.paths().len() == 2 {
      break;
    }
    tokio::task::yield_now().await;
  }
  assert_eq!(
    h.http.paths(),
    vec![
      "POST /api/auth/app-connect/refresh",
      "POST /v1/accounts:signInWithCustomToken"
    ]
  );
  assert_eq!(
    h.secrets.peek(SecretKind::RefreshToken).unwrap().expose(),
    REFRESH_TOKEN_2,
    "signIn の応答より前に新しい token を書く"
  );
  h.http.release();
  assert_eq!(task.await.unwrap().unwrap().expose(), ID_TOKEN_2);

  // 次の更新は新しい token で
  h.http.clear();
  h.clock.advance(Duration::from_secs(56 * 60));
  let _ = h.service.id_token().await.unwrap();
  assert_eq!(
    h.request_body(0),
    json!({ "clientId": "niho-camera", "refreshToken": REFRESH_TOKEN_2 })
  );
  // 再起動しても新しい token（ファイルに残っている）
  h.http.clear();
  let restarted = h.restart();
  h.clock.advance(Duration::from_secs(61 * 60));
  let _ = restarted.id_token().await.unwrap();
  assert_eq!(
    h.request_body(0),
    json!({ "clientId": "niho-camera", "refreshToken": REFRESH_TOKEN_2 })
  );
  h.assert_no_secret_in_logs();
}

#[tokio::test]
async fn legacy_server_without_a_rotated_token_keeps_the_current_one() {
  let h = Harness::new();
  h.sign_in().await;
  h.server.set("refresh", refresh_ok_legacy());
  h.server.set("signIn", sign_in_ok(ID_TOKEN_2));
  let writes_before = h.secrets.ops().iter().filter(|op| *op == "set:refresh-token").count();
  h.clock.advance(Duration::from_secs(56 * 60));
  assert_eq!(h.service.id_token().await.unwrap().expose(), ID_TOKEN_2);
  assert_eq!(
    h.secrets.peek(SecretKind::RefreshToken).unwrap().expose(),
    REFRESH_TOKEN
  );
  assert_eq!(
    h.secrets.ops().iter().filter(|op| *op == "set:refresh-token").count(),
    writes_before,
    "旧サーバーでは書き換えない"
  );
  h.http.clear();
  h.clock.advance(Duration::from_secs(56 * 60));
  let _ = h.service.id_token().await.unwrap();
  assert_eq!(
    h.request_body(0),
    json!({ "clientId": "niho-camera", "refreshToken": REFRESH_TOKEN })
  );
}

#[tokio::test]
async fn failing_to_save_the_rotated_token_keeps_it_in_memory_and_continues() {
  let h = Harness::new();
  let profile = h.sign_in().await;
  h.server.set("signIn", sign_in_ok(ID_TOKEN_2));
  h.secrets.fail_set(SecretKind::RefreshToken, true);
  h.clock.advance(Duration::from_secs(56 * 60));

  // 保存に失敗しても更新は成立する（この起動の間はメモリの token を使う）
  assert_eq!(h.service.id_token().await.unwrap().expose(), ID_TOKEN_2);
  assert_eq!(h.service.state(), AccountState::SignedIn { profile });
  assert_eq!(
    h.secrets.peek(SecretKind::RefreshToken).unwrap().expose(),
    REFRESH_TOKEN,
    "保存先は古いまま"
  );
  assert_eq!(
    h.log.payloads("account.refresh.token_save_failed"),
    vec![json!({ "connectionId": "conn_1", "reason": "keychain_write_failed" })]
  );

  // 次の更新はメモリの新しい token で（古い token を送らない）。今度は保存できる
  h.secrets.fail_set(SecretKind::RefreshToken, false);
  h.http.clear();
  h.clock.advance(Duration::from_secs(56 * 60));
  let _ = h.service.id_token().await.unwrap();
  assert_eq!(
    h.request_body(0),
    json!({ "clientId": "niho-camera", "refreshToken": REFRESH_TOKEN_2 })
  );
  assert_eq!(
    h.secrets.peek(SecretKind::RefreshToken).unwrap().expose(),
    REFRESH_TOKEN_2
  );
  h.assert_no_secret_in_logs();
}

#[tokio::test]
async fn logging_out_while_refresh_waits_does_not_write_the_rotated_token() {
  let h = Harness::new();
  h.sign_in().await;
  h.clock.advance(Duration::from_secs(56 * 60));
  h.http.hold_path("/app-connect/refresh");
  let service = h.service.clone();
  let task = tokio::spawn(async move { service.id_token().await });
  for _ in 0..50 {
    if !h.http.paths().is_empty() {
      break;
    }
    tokio::task::yield_now().await;
  }
  assert_eq!(h.http.paths(), vec!["POST /api/auth/app-connect/refresh"]);
  // refresh の応答を待っている間に、別の経路（API の 401 app_connection_revoked）で期限切れになった
  h.service.expire(ExpiredReason::ConnectionRevoked);
  h.http.release();
  assert_eq!(task.await.unwrap().unwrap_err().code, "signed_out");
  assert!(h.log.has("account.refresh.rotated_token_dropped"));
  assert_eq!(h.http.paths().len(), 1, "signIn しない");
  assert!(matches!(h.service.state(), AccountState::Expired { .. }));
  assert_eq!(
    h.secrets.peek(SecretKind::RefreshToken),
    None,
    "期限切れのあとに取り替えた token を書き戻さない"
  );
}

#[tokio::test]
async fn logout_everywhere_calls_the_api_then_clears_the_mac_like_logout() {
  let h = Harness::new();
  let profile = h.sign_in().await;
  h.service.logout_everywhere().await.unwrap();
  assert_eq!(
    h.http.paths(),
    vec!["POST /api/auth/sign-out-everywhere"],
    "DELETE は呼ばない（API 側で失効済み）"
  );
  let request = &h.http.requests()[0];
  assert_eq!(
    request.header_value("authorization"),
    Some(format!("Bearer {ID_TOKEN}").as_str())
  );
  assert_eq!(h.request_body(0), json!({}));
  assert_eq!(h.service.state(), AccountState::SignedOut);
  assert_eq!(h.secrets.peek(SecretKind::RefreshToken), None);
  assert_eq!(h.secrets.peek(SecretKind::Pending), None);
  assert!(!h.account_file().exists());
  assert!(!profile.avatar_path.unwrap().exists());
  assert_eq!(
    h.log.payloads("account.logout_everywhere"),
    vec![json!({ "result": "revoked" })]
  );
  assert_eq!(h.restart().state(), AccountState::SignedOut);
  h.assert_no_secret_in_logs();
}

#[tokio::test]
async fn logout_everywhere_refreshes_the_id_token_first_when_it_is_stale() {
  let h = Harness::new();
  h.sign_in().await;
  h.server.set("signIn", sign_in_ok(ID_TOKEN_2));
  h.clock.advance(Duration::from_secs(61 * 60));
  h.service.logout_everywhere().await.unwrap();
  assert_eq!(
    h.http.paths(),
    vec![
      "POST /api/auth/app-connect/refresh",
      "POST /v1/accounts:signInWithCustomToken",
      "POST /api/auth/sign-out-everywhere"
    ]
  );
  assert_eq!(
    h.http.requests()[2].header_value("authorization"),
    Some(format!("Bearer {ID_TOKEN_2}").as_str())
  );
  assert_eq!(h.service.state(), AccountState::SignedOut);
  assert_eq!(
    h.secrets.peek(SecretKind::RefreshToken),
    None,
    "取り替えた token も消す"
  );
}

#[tokio::test]
async fn logout_everywhere_treats_an_already_revoked_connection_as_done() {
  let h = Harness::new();
  h.sign_in().await;
  h.server.set(
    "signOutEverywhere",
    Ok(api_error(401, "UNAUTHORIZED", Some("app_connection_revoked"))),
  );
  h.service.logout_everywhere().await.unwrap();
  assert_eq!(h.service.state(), AccountState::SignedOut);
  assert!(!h.account_file().exists());
  assert_eq!(
    h.log.payloads("account.logout_everywhere"),
    vec![json!({ "result": "already_revoked" })]
  );
}

#[tokio::test]
async fn logout_everywhere_failures_keep_this_mac_signed_in() {
  for reply in [
    Err(HttpError::new(HttpErrorKind::Network)),
    Err(HttpError::new(HttpErrorKind::Timeout)),
    Ok(api_error(503, "SERVICE_UNAVAILABLE", Some("firebase_revoke_failed"))),
    Ok(api_error(500, "INTERNAL", None)),
    Ok(api_error(429, "RATE_LIMITED", None)),
    Ok(api_error(401, "UNAUTHORIZED", None)),
  ] {
    let h = Harness::new();
    let profile = h.sign_in().await;
    h.server.set("signOutEverywhere", reply);
    assert_eq!(
      h.service.logout_everywhere().await.unwrap_err().code,
      "sign_out_everywhere_failed"
    );
    assert_eq!(h.service.state(), AccountState::SignedIn { profile });
    assert_eq!(
      h.secrets.peek(SecretKind::RefreshToken).unwrap().expose(),
      REFRESH_TOKEN
    );
    assert!(h.account_file().exists());
    assert!(h.log.has("account.logout_everywhere.failed"));
    assert!(!h.log.has("account.wiped"));
    h.assert_no_secret_in_logs();
  }
}

#[tokio::test]
async fn logout_everywhere_is_not_available_offline_expired_or_signed_out() {
  // オフライン: 通信しない・手元は変えない
  let h = Harness::new();
  let profile = h.sign_in().await;
  h.server.set("refresh", Err(HttpError::new(HttpErrorKind::Network)));
  h.clock.advance(Duration::from_secs(61 * 60));
  let _ = h.service.id_token().await;
  assert_eq!(
    h.service.state(),
    AccountState::Offline {
      profile: profile.clone()
    }
  );
  h.http.clear();
  assert_eq!(
    h.service.logout_everywhere().await.unwrap_err().code,
    "sign_out_everywhere_failed"
  );
  assert!(h.http.requests().is_empty());
  assert_eq!(h.service.state(), AccountState::Offline { profile });

  // 期限切れ
  let h = Harness::new();
  h.sign_in().await;
  h.server.set(
    "refresh",
    Ok(api_error(401, "UNAUTHORIZED", Some("app_connection_revoked"))),
  );
  h.clock.advance(Duration::from_secs(56 * 60));
  let _ = h.service.id_token().await;
  h.http.clear();
  assert_eq!(h.service.logout_everywhere().await.unwrap_err().code, "expired");
  assert!(h.http.requests().is_empty());
  assert!(matches!(h.service.state(), AccountState::Expired { .. }));

  // 更新で期限切れがわかった（ID token が切れていて refresh が 401）
  let h = Harness::new();
  h.sign_in().await;
  h.server.set(
    "refresh",
    Ok(api_error(401, "UNAUTHORIZED", Some("app_connection_revoked"))),
  );
  h.clock.advance(Duration::from_secs(61 * 60));
  assert_eq!(h.service.logout_everywhere().await.unwrap_err().code, "expired");
  assert_eq!(h.server.count("signOutEverywhere"), 0);

  // 未ログイン
  let h = Harness::new();
  assert_eq!(h.service.logout_everywhere().await.unwrap_err().code, "signed_out");
  assert!(h.http.requests().is_empty());
}
