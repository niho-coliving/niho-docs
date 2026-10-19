use super::*;
use crate::test_support::MemorySecretStore;

#[test]
fn secret_debug_does_not_print_the_value() {
  let secret = Secret::new("super-secret-value");
  assert_eq!(format!("{secret:?}"), "Secret(…)");
  assert_eq!(secret.expose(), "super-secret-value");
}

#[test]
fn memory_store_round_trips_and_delete_is_idempotent() {
  let store = MemorySecretStore::new();
  assert_eq!(store.get(SecretKind::RefreshToken).unwrap(), None);
  store.set(SecretKind::RefreshToken, &Secret::new("rt")).unwrap();
  assert_eq!(store.get(SecretKind::RefreshToken).unwrap().unwrap().expose(), "rt");
  store.delete(SecretKind::RefreshToken).unwrap();
  store.delete(SecretKind::RefreshToken).unwrap();
  assert_eq!(store.get(SecretKind::RefreshToken).unwrap(), None);
  assert_eq!(SecretKind::RefreshToken.account(), "refresh-token");
  assert_eq!(SecretKind::Pending.account(), "pending");
}

/// テストごとの一時ディレクトリ（終わったら消す）。
struct TempDir(std::path::PathBuf);

impl TempDir {
  fn new(name: &str) -> TempDir {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
      "niho-desktop-account-secret-{name}-{}-{}",
      std::process::id(),
      COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = std::fs::remove_dir_all(&self.0);
  }
}

#[test]
fn file_store_round_trips_overwrites_and_delete_is_idempotent() {
  let tmp = TempDir::new("roundtrip");
  let store = FileSecretStore::in_data_dir(&tmp.0);
  assert_eq!(store.dir(), tmp.0.join("account-secrets"));
  // 無ければ None（ディレクトリも無い）
  assert_eq!(store.get(SecretKind::RefreshToken).unwrap(), None);
  assert!(!store.dir().exists(), "読むだけではディレクトリを作らない");
  store.delete(SecretKind::RefreshToken).unwrap();

  store.set(SecretKind::RefreshToken, &Secret::new("rt-1")).unwrap();
  store
    .set(SecretKind::Pending, &Secret::new("{\"state\":\"s\"}"))
    .unwrap();
  assert_eq!(store.get(SecretKind::RefreshToken).unwrap().unwrap().expose(), "rt-1");
  assert_eq!(
    store.get(SecretKind::Pending).unwrap().unwrap().expose(),
    "{\"state\":\"s\"}"
  );
  assert_eq!(store.path(SecretKind::RefreshToken), store.dir().join("refresh-token"));
  assert_eq!(store.path(SecretKind::Pending), store.dir().join("pending"));

  // 上書き（取り替え）
  store.set(SecretKind::RefreshToken, &Secret::new("rt-2")).unwrap();
  assert_eq!(store.get(SecretKind::RefreshToken).unwrap().unwrap().expose(), "rt-2");

  // 一時ファイルは残らない（原子的な書き換え）
  let names: Vec<String> = std::fs::read_dir(store.dir())
    .unwrap()
    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
    .collect();
  let mut sorted = names.clone();
  sorted.sort();
  assert_eq!(
    sorted,
    vec!["pending".to_string(), "refresh-token".to_string()],
    "{names:?}"
  );

  // delete は冪等。ほかの種類は残る
  store.delete(SecretKind::RefreshToken).unwrap();
  store.delete(SecretKind::RefreshToken).unwrap();
  assert_eq!(store.get(SecretKind::RefreshToken).unwrap(), None);
  assert!(store.get(SecretKind::Pending).unwrap().is_some());

  // 新しい FileSecretStore（アプリの再起動・版の更新）でも読める
  let reopened = FileSecretStore::in_data_dir(&tmp.0);
  assert!(reopened.get(SecretKind::Pending).unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn file_store_uses_owner_only_permissions() {
  use std::os::unix::fs::PermissionsExt;
  let tmp = TempDir::new("perms");
  let store = FileSecretStore::in_data_dir(&tmp.0);
  store.set(SecretKind::RefreshToken, &Secret::new("rt")).unwrap();
  let mode = |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
  assert_eq!(mode(store.dir()), 0o700, "ディレクトリは 0700");
  assert_eq!(mode(&store.path(SecretKind::RefreshToken)), 0o600, "ファイルは 0600");

  // 既にあるディレクトリが緩い権限でも、書くときに 0700 に直す。上書きしたファイルも 0600
  std::fs::set_permissions(store.dir(), std::fs::Permissions::from_mode(0o755)).unwrap();
  store.set(SecretKind::RefreshToken, &Secret::new("rt-2")).unwrap();
  assert_eq!(mode(store.dir()), 0o700);
  assert_eq!(mode(&store.path(SecretKind::RefreshToken)), 0o600);
  store.set(SecretKind::Pending, &Secret::new("p")).unwrap();
  assert_eq!(mode(&store.path(SecretKind::Pending)), 0o600);
}

#[test]
fn file_store_failures_are_errors_without_the_value_or_path() {
  let tmp = TempDir::new("failures");
  // 置き場の親がファイル（ディレクトリを作れない）→ 書けない
  let blocker = tmp.0.join("not-a-dir");
  std::fs::write(&blocker, b"x").unwrap();
  let store = FileSecretStore::new(blocker.join("account-secrets"));
  let error = store
    .set(SecretKind::RefreshToken, &Secret::new("secret-value"))
    .unwrap_err();
  assert_eq!(error.code, "keychain_write_failed");
  assert!(!error.message.contains("secret-value"));
  assert!(!error.message.contains("not-a-dir"));

  // 保存先がディレクトリになっている → 読めない（Err。None にしない）
  let store = FileSecretStore::in_data_dir(&tmp.0);
  std::fs::create_dir_all(store.path(SecretKind::Pending)).unwrap();
  assert_eq!(store.get(SecretKind::Pending).unwrap_err().code, "keychain_read_failed");
  assert_eq!(
    store.delete(SecretKind::Pending).unwrap_err().code,
    "keychain_delete_failed"
  );

  // 空のファイルは無いのと同じ
  std::fs::write(store.path(SecretKind::RefreshToken), b"").unwrap();
  assert_eq!(store.get(SecretKind::RefreshToken).unwrap(), None);
}

/// 本物の Keychain（テスト用の service 名だけ。偽の値を書いて読んで消す）。
/// `cargo test -p niho-desktop-account keychain_round_trip -- --ignored`
#[test]
#[ignore]
fn keychain_round_trip_with_the_test_service() {
  let store = KeychainStore::new("life.niho.camera.account.test");
  store.delete(SecretKind::Pending).unwrap();
  assert_eq!(store.get(SecretKind::Pending).unwrap(), None);
  store.set(SecretKind::Pending, &Secret::new("{\"fake\":true}")).unwrap();
  assert_eq!(
    store.get(SecretKind::Pending).unwrap().unwrap().expose(),
    "{\"fake\":true}"
  );
  // 上書き
  store.set(SecretKind::Pending, &Secret::new("second")).unwrap();
  assert_eq!(store.get(SecretKind::Pending).unwrap().unwrap().expose(), "second");
  store.delete(SecretKind::Pending).unwrap();
  assert_eq!(store.get(SecretKind::Pending).unwrap(), None);
  // 共通の adapter を直接
  keychain::write("life.niho.camera.account.test", "adapter", b"bytes").unwrap();
  assert_eq!(
    keychain::read("life.niho.camera.account.test", "adapter").unwrap(),
    Some(b"bytes".to_vec())
  );
  keychain::delete("life.niho.camera.account.test", "adapter").unwrap();
  assert_eq!(
    keychain::read("life.niho.camera.account.test", "adapter").unwrap(),
    None
  );
}
