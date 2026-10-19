//! 鍵の保存先（secrets.rs）: app data のファイル（権限・原子的な書き換え）と、旧い置き場から 1 回だけ移す層を、一時ディレクトリと
//! 偽の旧い置き場で確かめる。本物の Keychain は `#[ignore]` のテストだけ（テスト用の service 名）。

use super::*;
use crate::process::PrivateTempDir;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

const OLD_KEY: &str = "sk-ant-fake-legacy-0123456789";
const NEW_KEY: &str = "sk-ant-fake-new-9876543210";

fn mode(path: &Path) -> u32 {
  fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn names(dir: &Path) -> Vec<String> {
  let mut names: Vec<String> = fs::read_dir(dir)
    .unwrap()
    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
    .collect();
  names.sort();
  names
}

/// 偽の旧い置き場（Keychain の代わり）。読んだ回数（= 確認が出た回数）と消した回数を数える。
#[derive(Default)]
struct FakeLegacy {
  secrets: MemoryStore,
  unreadable: bool,
  reads: AtomicUsize,
  deletes: AtomicUsize,
}

impl FakeLegacy {
  fn with(account: Account, value: &str) -> Arc<FakeLegacy> {
    let legacy = FakeLegacy::default();
    legacy.secrets.set(account, &Secret::new(value)).unwrap();
    Arc::new(legacy)
  }

  fn unreadable(account: Account) -> Arc<FakeLegacy> {
    let legacy = FakeLegacy {
      unreadable: true,
      ..FakeLegacy::default()
    };
    legacy.secrets.set(account, &Secret::new(OLD_KEY)).unwrap();
    Arc::new(legacy)
  }

  fn reads(&self) -> usize {
    self.reads.load(Ordering::SeqCst)
  }
}

impl SecretStore for FakeLegacy {
  fn get(&self, account: Account) -> Result<Option<Secret>, SecretError> {
    self.reads.fetch_add(1, Ordering::SeqCst);
    if self.unreadable {
      return Err(KEYCHAIN_READ_FAILED);
    }
    self.secrets.get(account)
  }
  fn set(&self, account: Account, secret: &Secret) -> Result<(), SecretError> {
    self.secrets.set(account, secret)
  }
  fn delete(&self, account: Account) -> Result<(), SecretError> {
    self.deletes.fetch_add(1, Ordering::SeqCst);
    self.secrets.delete(account)
  }
  /// 中身を読まずに確かめる（確認は出ない）。
  fn exists(&self, account: Account) -> Result<bool, SecretError> {
    self.secrets.get(account).map(|secret| secret.is_some())
  }
}

/// 箱に入れた後も数を見られるように Arc で渡す。
struct Shared<T>(Arc<T>);

impl<T: SecretStore> SecretStore for Shared<T> {
  fn get(&self, account: Account) -> Result<Option<Secret>, SecretError> {
    self.0.get(account)
  }
  fn set(&self, account: Account, secret: &Secret) -> Result<(), SecretError> {
    self.0.set(account, secret)
  }
  fn delete(&self, account: Account) -> Result<(), SecretError> {
    self.0.delete(account)
  }
  fn exists(&self, account: Account) -> Result<bool, SecretError> {
    self.0.exists(account)
  }
}

/// 書けない保存先（新しい置き場への書き込みの失敗）。
struct ReadOnly;

impl SecretStore for ReadOnly {
  fn get(&self, _account: Account) -> Result<Option<Secret>, SecretError> {
    Ok(None)
  }
  fn set(&self, _account: Account, _secret: &Secret) -> Result<(), SecretError> {
    Err(WRITE_FAILED)
  }
  fn delete(&self, _account: Account) -> Result<(), SecretError> {
    Ok(())
  }
}

/// 今の向き: 新しい = ファイル、旧い = 偽の Keychain（消さない）。
fn migrating(dir: &Path, legacy: &Arc<FakeLegacy>) -> MigratingStore {
  MigratingStore::new(
    Box::new(FileStore::new(dir)),
    Box::new(Shared(legacy.clone())),
    false,
    dir.join(LEGACY_RECORD),
  )
}

fn record(dir: &Path) -> serde_json::Value {
  serde_json::from_slice(&fs::read(dir.join(LEGACY_RECORD)).unwrap()).unwrap()
}

#[test]
fn memory_store_round_trips() {
  let store = MemoryStore::default();
  assert_eq!(store.get(Account::Anthropic).unwrap(), None);
  store.set(Account::Anthropic, &Secret::new("sk-ant-test-0000")).unwrap();
  assert_eq!(
    store.get(Account::Anthropic).unwrap().unwrap().expose(),
    "sk-ant-test-0000"
  );
  store.delete(Account::Anthropic).unwrap();
  store.delete(Account::Anthropic).unwrap();
  assert_eq!(store.get(Account::Anthropic).unwrap(), None);
}

#[test]
fn file_store_writes_private_files_and_replaces_them_atomically() {
  let temp = PrivateTempDir::create("niho-docs-secrets").unwrap();
  let dir = temp.path().join("data").join(API_KEYS_DIR);
  let store = FileStore::new(&dir);
  // ディレクトリが無くても「無い」
  assert_eq!(store.get(Account::Gemini).unwrap(), None);
  assert!(!store.exists(Account::Gemini).unwrap());

  store.set(Account::Gemini, &Secret::new(OLD_KEY)).unwrap();
  assert_eq!(store.get(Account::Gemini).unwrap().unwrap().expose(), OLD_KEY);
  assert!(store.exists(Account::Gemini).unwrap());
  assert_eq!(mode(&dir), 0o700);
  assert_eq!(mode(&dir.join("gemini")), 0o600);

  // 上書き（一時ファイルは残らない。ほかの鍵には触らない）
  store.set(Account::Deepgram, &Secret::new("dg-fake-0000")).unwrap();
  store.set(Account::Gemini, &Secret::new(NEW_KEY)).unwrap();
  assert_eq!(store.get(Account::Gemini).unwrap().unwrap().expose(), NEW_KEY);
  assert_eq!(mode(&dir.join("gemini")), 0o600);
  assert_eq!(names(&dir), vec!["deepgram", "gemini"]);

  // 削除は 2 回目も成功
  store.delete(Account::Gemini).unwrap();
  store.delete(Account::Gemini).unwrap();
  assert_eq!(store.get(Account::Gemini).unwrap(), None);
  assert_eq!(names(&dir), vec!["deepgram"]);

  // 0700 でなくなっていたら書くときに直す
  fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
  store.set(Account::OpenAi, &Secret::new("sk-fake-openai")).unwrap();
  assert_eq!(mode(&dir), 0o700);
}

#[test]
fn file_store_reads_an_empty_file_as_missing() {
  let temp = PrivateTempDir::create("niho-docs-secrets").unwrap();
  let store = FileStore::new(temp.path());
  fs::write(temp.path().join("openai"), b"").unwrap();
  assert_eq!(store.get(Account::OpenAi).unwrap(), None);
  assert!(!store.exists(Account::OpenAi).unwrap());
}

#[test]
fn the_old_keychain_key_moves_to_the_file_once() {
  let temp = PrivateTempDir::create("niho-docs-secrets").unwrap();
  let legacy = FakeLegacy::with(Account::Anthropic, OLD_KEY);
  let store = migrating(temp.path(), &legacy);

  assert_eq!(store.get(Account::Anthropic).unwrap().unwrap().expose(), OLD_KEY);
  assert_eq!(legacy.reads(), 1);
  assert_eq!(fs::read_to_string(temp.path().join("anthropic")).unwrap(), OLD_KEY);
  assert_eq!(record(temp.path())["anthropic"], "moved");
  // Keychain の項目は消さない（新しいビルドからは消せない）
  assert_eq!(legacy.deletes.load(Ordering::SeqCst), 0);
  // 記録に鍵は入らない
  assert!(!fs::read_to_string(temp.path().join(LEGACY_RECORD))
    .unwrap()
    .contains(OLD_KEY));

  // 2 回目以降・次の起動はファイルから読む（確認は出ない）
  assert_eq!(store.get(Account::Anthropic).unwrap().unwrap().expose(), OLD_KEY);
  let relaunched = migrating(temp.path(), &legacy);
  assert_eq!(relaunched.get(Account::Anthropic).unwrap().unwrap().expose(), OLD_KEY);
  assert_eq!(legacy.reads(), 1);
}

#[test]
fn a_missing_old_key_is_checked_without_reading_it() {
  let temp = PrivateTempDir::create("niho-docs-secrets").unwrap();
  let legacy = Arc::new(FakeLegacy::default());
  let store = migrating(temp.path(), &legacy);
  assert_eq!(store.get(Account::OpenAi).unwrap(), None);
  assert_eq!(store.get(Account::OpenAi).unwrap(), None);
  assert_eq!(legacy.reads(), 0);
  assert_eq!(record(temp.path())["openai"], "absent");
  // 後から Keychain に現れても見ない（記録が先）
  legacy.secrets.set(Account::OpenAi, &Secret::new(OLD_KEY)).unwrap();
  assert_eq!(migrating(temp.path(), &legacy).get(Account::OpenAi).unwrap(), None);
  assert_eq!(legacy.reads(), 0);
}

#[test]
fn an_unreadable_old_key_asks_to_reenter_without_asking_the_keychain_again() {
  let temp = PrivateTempDir::create("niho-docs-secrets").unwrap();
  let legacy = FakeLegacy::unreadable(Account::Deepgram);
  let store = migrating(temp.path(), &legacy);

  assert_eq!(store.get(Account::Deepgram), Err(REENTER));
  assert_eq!(store.get(Account::Deepgram), Err(REENTER));
  assert_eq!(migrating(temp.path(), &legacy).get(Account::Deepgram), Err(REENTER));
  assert_eq!(legacy.reads(), 1);
  assert_eq!(record(temp.path())["deepgram"], "unreadable");

  // 入れ直したら新しい鍵を使う
  store.set(Account::Deepgram, &Secret::new(NEW_KEY)).unwrap();
  assert_eq!(store.get(Account::Deepgram).unwrap().unwrap().expose(), NEW_KEY);
  assert_eq!(record(temp.path())["deepgram"], "replaced");
  // 削除したら未設定（入れ直しの案内も旧い鍵も戻らない）
  store.delete(Account::Deepgram).unwrap();
  assert_eq!(store.get(Account::Deepgram).unwrap(), None);
  assert_eq!(migrating(temp.path(), &legacy).get(Account::Deepgram).unwrap(), None);
  assert_eq!(legacy.reads(), 1);
}

#[test]
fn deleting_before_the_move_does_not_bring_the_old_key_back() {
  let temp = PrivateTempDir::create("niho-docs-secrets").unwrap();
  let legacy = FakeLegacy::with(Account::Gemini, OLD_KEY);
  let store = migrating(temp.path(), &legacy);
  store.delete(Account::Gemini).unwrap();
  assert_eq!(store.get(Account::Gemini).unwrap(), None);
  assert_eq!(legacy.reads(), 0);

  // 移す前に入れ直した鍵も、旧い鍵で上書きされない
  let other = FakeLegacy::with(Account::OpenAi, OLD_KEY);
  let store = migrating(temp.path(), &other);
  store.set(Account::OpenAi, &Secret::new(NEW_KEY)).unwrap();
  assert_eq!(store.get(Account::OpenAi).unwrap().unwrap().expose(), NEW_KEY);
  assert_eq!(other.reads(), 0);
}

#[test]
fn deleting_a_key_also_removes_its_leftover_temp_files_and_only_those() {
  let temp = PrivateTempDir::create("niho-docs-secrets").unwrap();
  let store = FileStore::new(temp.path());
  store.set(Account::Anthropic, &Secret::new(NEW_KEY)).unwrap();
  store.set(Account::Gemini, &Secret::new(OLD_KEY)).unwrap();
  // 保存の途中で落ちて残った一時ファイル（鍵が入っている）。別の鍵の分・無関係なファイルは触らない
  for name in [
    ".anthropic.tmp-111-0",
    ".anthropic.tmp-222-5",
    ".gemini.tmp-1-1",
    "notes.txt",
  ] {
    fs::write(temp.path().join(name), NEW_KEY).unwrap();
  }
  store.delete(Account::Anthropic).unwrap();
  assert_eq!(names(temp.path()), [".gemini.tmp-1-1", "gemini", "notes.txt"]);
  assert_eq!(store.get(Account::Gemini).unwrap().unwrap().expose(), OLD_KEY);
  // 鍵が無くても残りの一時ファイルは消え、2 回目は何もしない
  fs::write(temp.path().join(".anthropic.tmp-9-9"), NEW_KEY).unwrap();
  store.delete(Account::Anthropic).unwrap();
  store.delete(Account::Anthropic).unwrap();
  assert_eq!(names(temp.path()), [".gemini.tmp-1-1", "gemini", "notes.txt"]);
}

#[test]
fn a_delete_that_cannot_record_replaced_fails_and_keeps_the_key_instead_of_bringing_the_old_one_back() {
  let temp = PrivateTempDir::create("niho-docs-secrets").unwrap();
  // 記録の置き場がファイルで塞がっている（移した・消したの印を書けない）
  let blocked = temp.path().join("blocked");
  fs::write(&blocked, b"").unwrap();
  let keys = temp.path().join(API_KEYS_DIR);
  let legacy = FakeLegacy::with(Account::Gemini, OLD_KEY);
  let store = MigratingStore::new(
    Box::new(FileStore::new(&keys)),
    Box::new(Shared(legacy.clone())),
    false,
    blocked.join(LEGACY_RECORD),
  );
  // 旧い置き場の鍵は新しい置き場へ移り、印は書けない
  assert_eq!(store.get(Account::Gemini).unwrap().unwrap().expose(), OLD_KEY);
  // 削除は「以後旧い置き場を見ない」を書けないので、消さずに断る
  assert_eq!(store.delete(Account::Gemini), Err(DELETE_FAILED));
  assert_eq!(
    FileStore::new(&keys).get(Account::Gemini).unwrap().unwrap().expose(),
    OLD_KEY
  );
  // 再起動（記録を読み直す）しても、鍵は新しい置き場に残ったまま。旧い置き場の鍵が戻って見えるのでも、消えたと偽るのでもない
  let restarted = MigratingStore::new(
    Box::new(FileStore::new(&keys)),
    Box::new(Shared(legacy.clone())),
    false,
    blocked.join(LEGACY_RECORD),
  );
  assert_eq!(restarted.get(Account::Gemini).unwrap().unwrap().expose(), OLD_KEY);
  // 保存は印を書けなくても成功する（新しい置き場に鍵があるうちは旧い置き場を見ない）
  store.set(Account::Gemini, &Secret::new(NEW_KEY)).unwrap();
  assert_eq!(store.get(Account::Gemini).unwrap().unwrap().expose(), NEW_KEY);
  // 印を書ける置き場なら、削除は印を書いてから消し、再起動の後も戻らない
  let writable = migrating(&keys, &legacy);
  writable.delete(Account::Gemini).unwrap();
  assert_eq!(record(&keys)["gemini"], serde_json::json!("replaced"));
  let again = migrating(&keys, &legacy);
  assert_eq!(again.get(Account::Gemini).unwrap(), None);
}

#[test]
fn concurrent_reads_ask_the_keychain_once() {
  let temp = PrivateTempDir::create("niho-docs-secrets").unwrap();
  let legacy = FakeLegacy::with(Account::Anthropic, OLD_KEY);
  let store = Arc::new(migrating(temp.path(), &legacy));
  let threads: Vec<_> = (0..8)
    .map(|_| {
      let store = store.clone();
      std::thread::spawn(move || store.get(Account::Anthropic).unwrap().unwrap().expose().to_string())
    })
    .collect();
  for thread in threads {
    assert_eq!(thread.join().unwrap(), OLD_KEY);
  }
  assert_eq!(legacy.reads(), 1);
}

#[test]
fn a_record_that_cannot_be_written_still_stops_a_second_prompt_in_the_same_launch() {
  let temp = PrivateTempDir::create("niho-docs-secrets").unwrap();
  // 記録の置き場がファイルで塞がっている
  let blocked = temp.path().join("blocked");
  fs::write(&blocked, b"").unwrap();
  let legacy = FakeLegacy::unreadable(Account::Gemini);
  let store = MigratingStore::new(
    Box::new(FileStore::new(&temp.path().join(API_KEYS_DIR))),
    Box::new(Shared(legacy.clone())),
    false,
    blocked.join(LEGACY_RECORD),
  );
  assert_eq!(store.get(Account::Gemini), Err(REENTER));
  assert_eq!(store.get(Account::Gemini), Err(REENTER));
  assert_eq!(legacy.reads(), 1);
}

#[test]
fn a_failed_write_keeps_the_old_key_usable_and_tries_again_later() {
  let temp = PrivateTempDir::create("niho-docs-secrets").unwrap();
  let legacy = FakeLegacy::with(Account::Anthropic, OLD_KEY);
  let store = MigratingStore::new(
    Box::new(ReadOnly),
    Box::new(Shared(legacy.clone())),
    false,
    temp.path().join(LEGACY_RECORD),
  );
  assert_eq!(store.get(Account::Anthropic).unwrap().unwrap().expose(), OLD_KEY);
  assert!(!temp.path().join(LEGACY_RECORD).exists());
  assert_eq!(store.get(Account::Anthropic).unwrap().unwrap().expose(), OLD_KEY);
  assert_eq!(legacy.reads(), 2);
}

/// Developer ID 署名の後の向き（新しい = Keychain の新しい service、旧い = ファイル）: 移したら平文のファイルを消す。
#[test]
fn the_reverse_move_removes_the_plain_file() {
  let temp = PrivateTempDir::create("niho-docs-secrets").unwrap();
  let files = temp.path().join(API_KEYS_DIR);
  FileStore::new(&files)
    .set(Account::OpenAi, &Secret::new(OLD_KEY))
    .unwrap();
  let keychain = Arc::new(MemoryStore::default());
  let store = MigratingStore::new(
    Box::new(Shared(keychain.clone())),
    Box::new(FileStore::new(&files)),
    true,
    files.join("keychain-move.json"),
  );
  assert_eq!(store.get(Account::OpenAi).unwrap().unwrap().expose(), OLD_KEY);
  assert_eq!(keychain.get(Account::OpenAi).unwrap().unwrap().expose(), OLD_KEY);
  assert!(!files.join("openai").exists());
}

/// アプリの保存先は app data の `api-keys/`（Keychain には書かない。読むのは移すときだけなので、ここでは get を呼ばない）。
#[test]
fn the_app_store_saves_under_app_data() {
  let temp = PrivateTempDir::create("niho-docs-secrets").unwrap();
  let store = app_store(temp.path(), true, None);
  store.set(Account::Deepgram, &Secret::new("dg-fake-app-store")).unwrap();
  let dir = temp.path().join(API_KEYS_DIR);
  assert_eq!(fs::read_to_string(dir.join("deepgram")).unwrap(), "dg-fake-app-store");
  assert_eq!(mode(&dir.join("deepgram")), 0o600);
  assert_eq!(record(&dir)["deepgram"], "replaced");
  store.delete(Account::Deepgram).unwrap();
  assert!(!dir.join("deepgram").exists());
}

#[test]
fn the_dev_keychain_service_differs_from_production() {
  assert_ne!(DEV_LEGACY_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE);
}

/// 本物の Keychain（テスト用の service 名だけ。偽の鍵を書いて読んで消す）。
/// `cargo test -p niho_docs --lib keychain_round_trip -- --ignored`
#[test]
#[ignore]
fn keychain_round_trip_with_the_test_service() {
  let store = KeychainStore::new("life.niho.docs.api-key.test");
  let fake = Secret::new("sk-fake-keychain-test-0123456789");
  store.delete(Account::Deepgram).unwrap();
  assert_eq!(store.get(Account::Deepgram).unwrap(), None);
  assert!(!store.exists(Account::Deepgram).unwrap());
  store.set(Account::Deepgram, &fake).unwrap();
  assert!(store.exists(Account::Deepgram).unwrap());
  assert_eq!(store.get(Account::Deepgram).unwrap().unwrap().expose(), fake.expose());
  // 上書き
  store
    .set(Account::Deepgram, &Secret::new("sk-fake-keychain-test-second"))
    .unwrap();
  assert_eq!(
    store.get(Account::Deepgram).unwrap().unwrap().expose(),
    "sk-fake-keychain-test-second"
  );
  store.delete(Account::Deepgram).unwrap();
  assert_eq!(store.get(Account::Deepgram).unwrap(), None);
  assert!(!store.exists(Account::Deepgram).unwrap());
}
