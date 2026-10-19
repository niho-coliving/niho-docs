//! 公開記事の安全取得。本文解析は API と同じ TS core が担当し、ここでは解釈・実行しない。
//! URL と全 redirect の DNS を検査し、その IP に接続を固定する。proxy・自動 redirect は使わない。
use crate::samples::SampleError;
use reqwest::{header, redirect::Policy, Client, Url};
use serde::Serialize;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

const MAX_BYTES: usize = 5 * 1024 * 1024;
const TIME_LIMIT: Duration = Duration::from_secs(10);
const MAX_REDIRECTS: usize = 4;
const INVALID: SampleError = SampleError {
  code: "sample_url_invalid",
  message: "認証情報を含まない HTTPS の記事 URL を入力してください（2,048 文字まで）。",
};
const BLOCKED: SampleError = SampleError {
  code: "sample_url_blocked",
  message: "この URL の接続先は読み取れません。公開されている記事の URL を指定してください。",
};
const FETCH: SampleError = SampleError {
  code: "sample_url_fetch",
  message: "記事を取得できませんでした。URL とネットワークを確かめて、もう一度お試しください。",
};
const TIMEOUT: SampleError = SampleError {
  code: "sample_url_timeout",
  message: "記事の読み込みがタイムアウトしました。しばらく待ってから、もう一度お試しください。",
};
const TOO_LARGE: SampleError = SampleError {
  code: "sample_url_too_large",
  message: "記事の応答が大きすぎるため取り込めません（5MB まで）。",
};
const NOT_HTML: SampleError = SampleError {
  code: "sample_url_not_html",
  message: "記事の本文を読み取れるページを指定してください。",
};
const REDIRECT: SampleError = SampleError {
  code: "sample_url_redirect",
  message: "記事の転送先を確認できませんでした。転送後の公開記事の URL を指定してください。",
};

const ORIGIN: SampleError = SampleError {
  code: "sample_url_origin",
  message: "同じサイトの補助記事へ接続できなかったため本文から読み取ります。",
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedUrlPage {
  pub url: String,
  pub body: Vec<u8>,
  pub content_type: String,
}

pub fn parse_url(raw: &str) -> Result<Url, SampleError> {
  let raw = raw.trim();
  if raw.encode_utf16().count() > 2048 || raw.chars().any(char::is_control) {
    return Err(INVALID);
  }
  let mut url = Url::parse(raw).map_err(|_| INVALID)?;
  if url.scheme() != "https" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
    return Err(INVALID);
  }
  url.set_fragment(None);
  if url.as_str().len() > 2048 {
    return Err(INVALID);
  }
  let host = url.host_str().unwrap().trim_matches(['[', ']']).trim_end_matches('.');
  if host == "localhost"
    || host.ends_with(".localhost")
    || host.ends_with(".local")
    || host.ends_with(".internal")
    || !host.contains('.') && host.parse::<IpAddr>().is_err()
  {
    return Err(BLOCKED);
  }
  if let Ok(ip) = host.parse::<IpAddr>() {
    if !public_ip(ip) {
      return Err(BLOCKED);
    }
  }
  Ok(url)
}

/// 保守的な公開 unicast allowlist。IPv4 特殊用途と IPv6 変換・文書用・未割当アドレスは許可しない。
fn public_ip(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(ip) => {
      let [a, b, c, _] = ip.octets();
      !(matches!(a, 0 | 10 | 127 | 224..=255)
        || a == 100 && (64..=127).contains(&b)
        || a == 169 && b == 254
        || a == 172 && (16..=31).contains(&b)
        || a == 192
          && (b == 168
            || b == 0 && matches!(c, 0 | 2)
            || b == 88 && c == 99
            || b == 175 && c == 48
            || b == 31 && c == 196
            || b == 52 && c == 193)
        || a == 198 && (matches!(b, 18 | 19) || b == 51 && c == 100)
        || a == 203 && b == 0 && c == 113)
    }
    IpAddr::V6(ip) => {
      let s = ip.segments();
      s[0] & 0xe000 == 0x2000
        && s[0] != 0x2002
        && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
        && !(s[0] == 0x2620 && s[1] == 0x004f && s[2] == 0x8000)
        && s[0] != 0x3ffe
        && !(s[0] == 0x3fff && s[1] < 0x1000)
    }
  }
}

fn validate_addresses(addresses: &[SocketAddr]) -> Result<(), SampleError> {
  if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
    Err(BLOCKED)
  } else {
    Ok(())
  }
}

struct Page {
  status: u16,
  location: Option<String>,
  content_type: String,
  bytes: Vec<u8>,
}
trait Network {
  async fn resolve(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, SampleError>;
  async fn get(&self, url: &Url, addresses: &[SocketAddr]) -> Result<Page, SampleError>;
}
struct PublicNetwork;
impl Network for PublicNetwork {
  async fn resolve(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, SampleError> {
    tokio::net::lookup_host((host, port))
      .await
      .map(|ips| ips.collect())
      .map_err(|_| BLOCKED)
  }
  async fn get(&self, url: &Url, addresses: &[SocketAddr]) -> Result<Page, SampleError> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
      let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let host = url.host_str().unwrap().trim_matches(['[', ']']);
    let client = Client::builder()
      .no_proxy()
      .redirect(Policy::none())
      .https_only(true)
      .resolve_to_addrs(host, addresses)
      .timeout(TIME_LIMIT)
      .user_agent(concat!("niho-docs-sample/", env!("CARGO_PKG_VERSION")))
      .build()
      .map_err(|_| FETCH)?;
    let mut response = client
      .get(url.clone())
      .header(
        header::ACCEPT,
        "text/html,application/xhtml+xml,application/amphtml,application/json,text/json,application/ld+json,application/rss+xml,application/atom+xml",
      )
      .send()
      .await
      .map_err(|e| if e.is_timeout() { TIMEOUT } else { FETCH })?;
    let status = response.status().as_u16();
    let location = response
      .headers()
      .get(header::LOCATION)
      .and_then(|v| v.to_str().ok())
      .map(String::from);
    let content_type = response
      .headers()
      .get(header::CONTENT_TYPE)
      .and_then(|v| v.to_str().ok())
      .unwrap_or("")
      .to_string();
    let mut bytes = Vec::new();
    if (200..300).contains(&status) {
      validate_content_type(&content_type)?;
      if response.content_length().is_some_and(|len| len > MAX_BYTES as u64) {
        return Err(TOO_LARGE);
      }
      while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| if e.is_timeout() { TIMEOUT } else { FETCH })?
      {
        append_body(&mut bytes, &chunk)?;
      }
    }
    Ok(Page {
      status,
      location,
      content_type,
      bytes,
    })
  }
}
fn append_body(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), SampleError> {
  if chunk.len() > MAX_BYTES.saturating_sub(bytes.len()) {
    return Err(TOO_LARGE);
  }
  bytes.extend_from_slice(chunk);
  Ok(())
}
fn validate_content_type(content_type: &str) -> Result<(), SampleError> {
  match content_type
    .split(';')
    .next()
    .unwrap_or("")
    .trim()
    .to_ascii_lowercase()
    .as_str()
  {
    "text/html" | "application/xhtml+xml" | "application/amphtml" => Ok(()),
    "application/json" | "text/json" | "application/ld+json" | "application/rss+xml" | "application/atom+xml" => Ok(()),
    _ => Err(NOT_HTML),
  }
}
fn next_url(current: &Url, location: Option<&str>, redirects: usize) -> Result<Url, SampleError> {
  if redirects >= MAX_REDIRECTS {
    return Err(REDIRECT);
  }
  let next = current.join(location.ok_or(REDIRECT)?).map_err(|_| REDIRECT)?;
  parse_url(next.as_str())
}
async fn fetch(network: &impl Network, raw: &str, same_origin: Option<&str>) -> Result<(Page, String), SampleError> {
  let first = parse_url(raw)?;
  let origin = same_origin.map(parse_url).transpose()?.map(|url| url.origin());
  let mut url = first;
  for redirects in 0..=MAX_REDIRECTS {
    let host = url.host_str().unwrap().trim_matches(['[', ']']);
    let addresses = network.resolve(host, url.port_or_known_default().unwrap()).await?;
    validate_addresses(&addresses)?;
    // private DNS は origin fallback へ逃がさない。比較は公開 IP の確認の後。
    if origin.as_ref().is_some_and(|origin| *origin != url.origin()) {
      return Err(ORIGIN);
    }
    let page = network.get(&url, &addresses).await?;
    if matches!(page.status, 301 | 302 | 303 | 307 | 308) {
      url = next_url(&url, page.location.as_deref(), redirects)?;
      continue;
    }
    if !(200..300).contains(&page.status) {
      return Err(FETCH);
    }
    validate_content_type(&page.content_type)?;
    if page.bytes.len() > MAX_BYTES {
      return Err(TOO_LARGE);
    }
    return Ok((page, url.to_string()));
  }
  Err(REDIRECT)
}

/// 全 redirect・DNS・body 読み取りを、共有 core が持つ残り時間（最大 10 秒）でまとめて止める。
pub async fn fetch_url(raw: &str, same_origin: Option<&str>, timeout_ms: u64) -> Result<FetchedUrlPage, SampleError> {
  if timeout_ms == 0 {
    return Err(TIMEOUT);
  }
  let (page, url) = tokio::time::timeout(
    Duration::from_millis(timeout_ms.min(TIME_LIMIT.as_millis() as u64)),
    fetch(&PublicNetwork, raw, same_origin),
  )
  .await
  .map_err(|_| TIMEOUT)??;
  Ok(FetchedUrlPage {
    url,
    body: page.bytes,
    content_type: page.content_type,
  })
}

#[cfg(test)]
#[path = "sample_url_tests.rs"]
mod tests;
