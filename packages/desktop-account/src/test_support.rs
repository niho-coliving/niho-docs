//! テストの道具（feature `test-support` でアプリの dev-dependencies からも使える）: 偽の HttpClient・メモリの SecretStore・
//! 偽の時計・ログの記録。本番のコードは使わない。

use crate::error::AccountError;
use crate::http::{HttpClient, HttpError, HttpErrorKind, HttpFuture, HttpRequest, HttpResponse};
use crate::secret::{AccountSecretStore, Secret, SecretKind};
use crate::service::{Clock, LogFn};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
  mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// 進められる時計。
pub struct FakeClock {
  now: Mutex<SystemTime>,
}

impl FakeClock {
  /// 2026-01-01T00:00:00Z から始める。
  pub fn new() -> FakeClock {
    FakeClock {
      now: Mutex::new(UNIX_EPOCH + Duration::from_secs(1_767_225_600)),
    }
  }

  pub fn advance(&self, by: Duration) {
    let mut now = lock(&self.now);
    *now += by;
  }

  pub fn set(&self, at: SystemTime) {
    *lock(&self.now) = at;
  }
}

impl Default for FakeClock {
  fn default() -> FakeClock {
    FakeClock::new()
  }
}

impl Clock for FakeClock {
  fn now(&self) -> SystemTime {
    *lock(&self.now)
  }
}

/// メモリの SecretStore。失敗を仕込める（Keychain に書けない等）。
#[derive(Default)]
pub struct MemorySecretStore {
  secrets: Mutex<BTreeMap<SecretKind, Secret>>,
  fail_set: Mutex<BTreeSet<SecretKind>>,
  fail_get: Mutex<BTreeSet<SecretKind>>,
  fail_delete: Mutex<BTreeSet<SecretKind>>,
  /// 操作の記録（`set:pending` など。値は含まない）
  ops: Mutex<Vec<String>>,
}

impl MemorySecretStore {
  pub fn new() -> MemorySecretStore {
    MemorySecretStore::default()
  }

  pub fn fail_set(&self, kind: SecretKind, fail: bool) {
    let mut set = lock(&self.fail_set);
    if fail {
      set.insert(kind);
    } else {
      set.remove(&kind);
    }
  }

  pub fn fail_get(&self, kind: SecretKind, fail: bool) {
    let mut set = lock(&self.fail_get);
    if fail {
      set.insert(kind);
    } else {
      set.remove(&kind);
    }
  }

  pub fn fail_delete(&self, kind: SecretKind, fail: bool) {
    let mut set = lock(&self.fail_delete);
    if fail {
      set.insert(kind);
    } else {
      set.remove(&kind);
    }
  }

  pub fn peek(&self, kind: SecretKind) -> Option<Secret> {
    lock(&self.secrets).get(&kind).cloned()
  }

  pub fn put(&self, kind: SecretKind, secret: Secret) {
    lock(&self.secrets).insert(kind, secret);
  }

  pub fn ops(&self) -> Vec<String> {
    lock(&self.ops).clone()
  }

  fn record(&self, op: &str, kind: SecretKind) {
    lock(&self.ops).push(format!("{op}:{}", kind.account()));
  }
}

impl AccountSecretStore for MemorySecretStore {
  fn get(&self, kind: SecretKind) -> Result<Option<Secret>, AccountError> {
    self.record("get", kind);
    if lock(&self.fail_get).contains(&kind) {
      return Err(AccountError::keychain_read_failed());
    }
    Ok(lock(&self.secrets).get(&kind).cloned())
  }

  fn set(&self, kind: SecretKind, secret: &Secret) -> Result<(), AccountError> {
    self.record("set", kind);
    if lock(&self.fail_set).contains(&kind) {
      return Err(AccountError::keychain_write_failed());
    }
    lock(&self.secrets).insert(kind, secret.clone());
    Ok(())
  }

  fn delete(&self, kind: SecretKind) -> Result<(), AccountError> {
    self.record("delete", kind);
    if lock(&self.fail_delete).contains(&kind) {
      return Err(AccountError::keychain_delete_failed());
    }
    lock(&self.secrets).remove(&kind);
    Ok(())
  }
}

pub type Responder = Arc<dyn Fn(&HttpRequest) -> Result<HttpResponse, HttpError> + Send + Sync>;

/// 偽の HttpClient。request を記録し、`respond` の closure が返す。
pub struct FakeHttp {
  responder: Mutex<Responder>,
  requests: Mutex<Vec<HttpRequest>>,
  /// `hold()` の間、返事を止める（競合のテスト）。2 つ目は止める request の URL の一部（None なら全部）
  gate: Mutex<Option<(Arc<tokio::sync::Semaphore>, Option<String>)>>,
}

impl FakeHttp {
  /// 既定は全部 503。
  pub fn new() -> FakeHttp {
    FakeHttp {
      responder: Mutex::new(Arc::new(|_| {
        Ok(json_response(
          503,
          &serde_json::json!({ "error": { "code": "SERVICE_UNAVAILABLE" } }),
        ))
      })),
      requests: Mutex::new(Vec::new()),
      gate: Mutex::new(None),
    }
  }

  /// これ以降の request は `release()` まで返事を待つ（request の記録はすぐ行う）。
  pub fn hold(&self) {
    *lock(&self.gate) = Some((Arc::new(tokio::sync::Semaphore::new(0)), None));
  }

  /// URL に `path` を含む request だけ `release()` まで返事を待つ。
  pub fn hold_path(&self, path: &str) {
    *lock(&self.gate) = Some((Arc::new(tokio::sync::Semaphore::new(0)), Some(path.to_string())));
  }

  /// 待たせている request を全部進める。
  pub fn release(&self) {
    if let Some((gate, _)) = lock(&self.gate).take() {
      gate.add_permits(tokio::sync::Semaphore::MAX_PERMITS);
    }
  }

  pub fn respond(&self, responder: impl Fn(&HttpRequest) -> Result<HttpResponse, HttpError> + Send + Sync + 'static) {
    *lock(&self.responder) = Arc::new(responder);
  }

  pub fn requests(&self) -> Vec<HttpRequest> {
    lock(&self.requests).clone()
  }

  /// 記録した request の path（query を除く）の並び。
  pub fn paths(&self) -> Vec<String> {
    self
      .requests()
      .iter()
      .map(|request| {
        let url = url::Url::parse(&request.url).expect("request url");
        format!("{} {}", request.method.as_str(), url.path())
      })
      .collect()
  }

  pub fn clear(&self) {
    lock(&self.requests).clear();
  }
}

impl Default for FakeHttp {
  fn default() -> FakeHttp {
    FakeHttp::new()
  }
}

impl HttpClient for FakeHttp {
  fn send(&self, request: HttpRequest) -> HttpFuture<'_> {
    let responder = lock(&self.responder).clone();
    let gate = lock(&self.gate)
      .clone()
      .filter(|(_, path)| path.as_ref().is_none_or(|path| request.url.contains(path.as_str())))
      .map(|(gate, _)| gate);
    lock(&self.requests).push(request.clone());
    Box::pin(async move {
      if let Some(gate) = gate {
        if let Ok(permit) = gate.acquire().await {
          permit.forget();
        }
      }
      responder(&request)
    })
  }
}

pub fn json_response(status: u16, value: &Value) -> HttpResponse {
  HttpResponse {
    status,
    headers: vec![("content-type".to_string(), "application/json".to_string())],
    body: serde_json::to_vec(value).unwrap_or_default(),
  }
}

pub fn bytes_response(status: u16, content_type: &str, body: Vec<u8>) -> HttpResponse {
  HttpResponse {
    status,
    headers: vec![("content-type".to_string(), content_type.to_string())],
    body,
  }
}

/// API の失敗の形（`errorResponse(code, message, { reason })`）。
pub fn api_error(status: u16, code: &str, reason: Option<&str>) -> HttpResponse {
  let mut details = serde_json::Map::new();
  if let Some(reason) = reason {
    details.insert("reason".to_string(), Value::String(reason.to_string()));
  }
  json_response(
    status,
    &serde_json::json!({ "error": { "code": code, "message": "error", "supportId": null, "details": details } }),
  )
}

pub fn network_error() -> HttpError {
  HttpError::new(HttpErrorKind::Network)
}

/// ログの記録（秘密が出ていないことを確かめる）。
#[derive(Default)]
pub struct CapturedLog {
  lines: Mutex<Vec<(String, Value)>>,
}

impl CapturedLog {
  pub fn new() -> Arc<CapturedLog> {
    Arc::new(CapturedLog::default())
  }

  pub fn log_fn(self: &Arc<Self>) -> LogFn {
    let me = Arc::clone(self);
    Arc::new(move |kind, payload| {
      lock(&me.lines).push((kind.to_string(), payload));
    })
  }

  pub fn lines(&self) -> Vec<(String, Value)> {
    lock(&self.lines).clone()
  }

  pub fn kinds(&self) -> Vec<String> {
    self.lines().into_iter().map(|(kind, _)| kind).collect()
  }

  /// 全部を 1 つの文字列に（秘密の文字列が含まれないことを `contains` で確かめる）。
  pub fn text(&self) -> String {
    self
      .lines()
      .iter()
      .map(|(kind, payload)| format!("{kind} {payload}"))
      .collect::<Vec<_>>()
      .join("\n")
  }

  pub fn has(&self, kind: &str) -> bool {
    self.lines().iter().any(|(k, _)| k == kind)
  }

  pub fn payloads(&self, kind: &str) -> Vec<Value> {
    self
      .lines()
      .into_iter()
      .filter(|(k, _)| k == kind)
      .map(|(_, payload)| payload)
      .collect()
  }
}
