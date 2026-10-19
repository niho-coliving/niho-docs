//! HTTP の口。コアは [`HttpClient`] だけを知り、本番は feature `reqwest` の [`ReqwestClient`]（rustls・OS の信頼する CA）、
//! テストは `test_support::FakeHttp`。失敗の文に URL・本文を入れない（URL には Web API key、本文には token が入る）。

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpMethod {
  Get,
  Post,
  Delete,
}

impl HttpMethod {
  pub fn as_str(self) -> &'static str {
    match self {
      HttpMethod::Get => "GET",
      HttpMethod::Post => "POST",
      HttpMethod::Delete => "DELETE",
    }
  }
}

#[derive(Clone)]
pub struct HttpRequest {
  pub method: HttpMethod,
  pub url: String,
  pub headers: Vec<(String, String)>,
  pub body: Option<Vec<u8>>,
  /// これより大きい本文は読まずに [`HttpErrorKind::TooLarge`]（顔写真の 512 KB）。
  pub max_body_bytes: Option<usize>,
  pub timeout: Duration,
}

impl HttpRequest {
  pub fn new(method: HttpMethod, url: impl Into<String>) -> HttpRequest {
    HttpRequest {
      method,
      url: url.into(),
      headers: Vec::new(),
      body: None,
      max_body_bytes: None,
      timeout: Duration::from_secs(20),
    }
  }

  pub fn header(mut self, name: &str, value: &str) -> HttpRequest {
    self.headers.push((name.to_string(), value.to_string()));
    self
  }

  pub fn json(mut self, value: &serde_json::Value) -> HttpRequest {
    self.body = Some(serde_json::to_vec(value).unwrap_or_default());
    self.header("content-type", "application/json")
  }

  pub fn bearer(self, token: &str) -> HttpRequest {
    self.header("authorization", &format!("Bearer {token}"))
  }

  pub fn max_body(mut self, bytes: usize) -> HttpRequest {
    self.max_body_bytes = Some(bytes);
    self
  }

  pub fn timeout(mut self, timeout: Duration) -> HttpRequest {
    self.timeout = timeout;
    self
  }

  pub fn header_value(&self, name: &str) -> Option<&str> {
    self
      .headers
      .iter()
      .find(|(key, _)| key.eq_ignore_ascii_case(name))
      .map(|(_, value)| value.as_str())
  }
}

/// header の値と本文は出さない（Authorization・token）。URL は query を落とす（Web API key）。
impl std::fmt::Debug for HttpRequest {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    let url = self.url.split('?').next().unwrap_or("");
    f.debug_struct("HttpRequest")
      .field("method", &self.method)
      .field("url", &url)
      .field(
        "headers",
        &self.headers.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(),
      )
      .field("body_bytes", &self.body.as_ref().map_or(0, Vec::len))
      .field("timeout", &self.timeout)
      .finish()
  }
}

#[derive(Clone)]
pub struct HttpResponse {
  pub status: u16,
  pub headers: Vec<(String, String)>,
  pub body: Vec<u8>,
}

/// 本文は出さない（token が入る）。
impl std::fmt::Debug for HttpResponse {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("HttpResponse")
      .field("status", &self.status)
      .field(
        "headers",
        &self.headers.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(),
      )
      .field("body_bytes", &self.body.len())
      .finish()
  }
}

impl HttpResponse {
  pub fn header_value(&self, name: &str) -> Option<&str> {
    self
      .headers
      .iter()
      .find(|(key, _)| key.eq_ignore_ascii_case(name))
      .map(|(_, value)| value.as_str())
  }

  pub fn json(&self) -> Option<serde_json::Value> {
    serde_json::from_slice(&self.body).ok()
  }
}

/// 通信そのものの失敗（HTTP の status が返ったものは [`HttpResponse`]）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpErrorKind {
  /// 接続できない・途中で切れた・TLS
  Network,
  Timeout,
  /// 本文が `max_body_bytes` を超えた
  TooLarge,
  Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HttpError {
  pub kind: HttpErrorKind,
}

impl HttpError {
  pub fn new(kind: HttpErrorKind) -> HttpError {
    HttpError { kind }
  }
}

pub type HttpFuture<'a> = Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + 'a>>;

pub trait HttpClient: Send + Sync {
  fn send(&self, request: HttpRequest) -> HttpFuture<'_>;
}

#[cfg(feature = "reqwest")]
mod reqwest_client {
  use super::*;

  /// 本番の HTTP（reqwest・rustls〔ring〕・OS の信頼する CA）。リダイレクトは追わない（token を別のホストへ送らない）。
  pub struct ReqwestClient {
    client: reqwest::Client,
  }

  impl ReqwestClient {
    pub fn new() -> Result<ReqwestClient, HttpError> {
      // rustls の暗号は ring（apps/docs の niho-api-ai と同じ。aws-lc を増やさない）
      if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
      }
      let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("niho-desktop-account/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| HttpError::new(HttpErrorKind::Other))?;
      Ok(ReqwestClient { client })
    }
  }

  fn classify(error: &reqwest::Error) -> HttpErrorKind {
    if error.is_timeout() {
      HttpErrorKind::Timeout
    } else if error.is_connect() || error.is_request() || error.is_body() || error.is_decode() {
      HttpErrorKind::Network
    } else {
      HttpErrorKind::Other
    }
  }

  impl HttpClient for ReqwestClient {
    fn send(&self, request: HttpRequest) -> HttpFuture<'_> {
      Box::pin(async move {
        let method = match request.method {
          HttpMethod::Get => reqwest::Method::GET,
          HttpMethod::Post => reqwest::Method::POST,
          HttpMethod::Delete => reqwest::Method::DELETE,
        };
        let mut builder = self.client.request(method, &request.url).timeout(request.timeout);
        for (name, value) in &request.headers {
          builder = builder.header(name.as_str(), value.as_str());
        }
        if let Some(body) = request.body {
          builder = builder.body(body);
        }
        let mut response = builder.send().await.map_err(|error| HttpError::new(classify(&error)))?;
        let status = response.status().as_u16();
        let headers = response
          .headers()
          .iter()
          .filter_map(|(name, value)| value.to_str().ok().map(|value| (name.to_string(), value.to_string())))
          .collect::<Vec<_>>();
        if let (Some(limit), Some(length)) = (request.max_body_bytes, response.content_length()) {
          if length > limit as u64 {
            return Err(HttpError::new(HttpErrorKind::TooLarge));
          }
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
          .chunk()
          .await
          .map_err(|error| HttpError::new(classify(&error)))?
        {
          body.extend_from_slice(&chunk);
          if request.max_body_bytes.is_some_and(|limit| body.len() > limit) {
            return Err(HttpError::new(HttpErrorKind::TooLarge));
          }
        }
        Ok(HttpResponse { status, headers, body })
      })
    }
  }
}

#[cfg(feature = "reqwest")]
pub use reqwest_client::ReqwestClient;

#[cfg(all(test, feature = "reqwest"))]
mod reqwest_tests {
  use std::io::{Read, Write};
  use std::net::TcpListener;

  use super::*;

  #[tokio::test]
  async fn authenticated_requests_do_not_follow_redirects() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut request = [0_u8; 2048];
      let _ = stream.read(&mut request);
      stream
        .write_all(
          b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/stolen\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .unwrap();
    });
    let client = ReqwestClient::new().unwrap();
    let response = client
      .send(HttpRequest::new(HttpMethod::Get, format!("http://{address}/auth")).bearer("SECRET"))
      .await
      .unwrap();
    assert_eq!(response.status, 302);
    server.join().unwrap();
  }
}
