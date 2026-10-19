use super::*;
use std::collections::VecDeque;
use std::sync::Mutex;

fn page(html: &str) -> Page {
  Page {
    status: 200,
    location: None,
    content_type: "text/html; charset=utf-8".into(),
    bytes: html.as_bytes().to_vec(),
  }
}
fn article() -> String {
  format!("<html><title>公開記事</title><body><article><h2>見出し</h2><p>{}</p><p><strong>太字</strong>です。</p></article></body></html>", "地域の人と街について考えます。".repeat(15))
}
fn runtime() -> tokio::runtime::Runtime {
  tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .unwrap()
}
struct FakeNetwork {
  pages: Mutex<VecDeque<Page>>,
  visits: Mutex<Vec<String>>,
  mixed_dns: bool,
}
impl FakeNetwork {
  fn new(pages: Vec<Page>) -> Self {
    Self {
      pages: Mutex::new(pages.into()),
      visits: Mutex::new(vec![]),
      mixed_dns: false,
    }
  }
}
impl Network for FakeNetwork {
  async fn resolve(&self, host: &str, _: u16) -> Result<Vec<SocketAddr>, SampleError> {
    self.visits.lock().unwrap().push(format!("dns:{host}"));
    let mut ips = vec!["93.184.216.34:443".parse().unwrap()];
    if self.mixed_dns || host == "private.example.com" {
      ips.push("127.0.0.1:443".parse().unwrap());
    }
    Ok(ips)
  }
  async fn get(&self, url: &Url, addresses: &[SocketAddr]) -> Result<Page, SampleError> {
    assert_eq!(addresses, &["93.184.216.34:443".parse::<SocketAddr>().unwrap()]);
    self.visits.lock().unwrap().push(format!("get:{url}"));
    Ok(self.pages.lock().unwrap().pop_front().unwrap())
  }
}
fn redirect(location: &str) -> Page {
  Page {
    status: 302,
    location: Some(location.into()),
    content_type: String::new(),
    bytes: vec![],
  }
}

#[test]
fn url_validation_rejects_schemes_credentials_private_and_local_hosts() {
  for raw in [
    "http://example.com",
    "file:///tmp/article",
    "https://user:pass@example.com",
    "https://user@example.com",
    "https://localhost./",
    "https://a.local",
    "https://a.internal",
    "https://intranet",
    "https://127.1",
    "https://0x7f000001",
    "https://[::1]",
    "https://10.0.0.1",
    "https://example.com/\npath",
  ] {
    assert!(parse_url(raw).is_err(), "{raw}");
  }
  assert_eq!(
    parse_url(&format!("https://example.com/{}", "a".repeat(2048))).err(),
    Some(INVALID)
  );
  assert_eq!(
    parse_url(" https://example.com/article#body ").unwrap().as_str(),
    "https://example.com/article"
  );
}
#[test]
fn special_address_ranges_and_transition_mechanisms_are_blocked() {
  for ip in [
    "0.0.0.0",
    "100.64.0.1",
    "169.254.169.254",
    "172.31.0.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "192.175.48.1",
    "192.31.196.1",
    "192.52.193.1",
    "198.19.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "64:ff9b:1::1",
    "2001::1",
    "2001:db8::1",
    "2002:808:808::1",
    "fc00::1",
    "fe80::1",
    "ff00::1",
    "3fff::1",
    "2620:4f:8000::1",
    "3ffe::1",
  ] {
    assert!(!public_ip(ip.parse().unwrap()), "{ip}");
  }
  for ip in [
    "8.8.8.8",
    "93.184.216.34",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ] {
    assert!(public_ip(ip.parse().unwrap()), "{ip}");
  }
}
#[test]
fn dns_must_have_only_public_addresses_before_any_connection() {
  let mut network = FakeNetwork::new(vec![]);
  network.mixed_dns = true;
  assert_eq!(
    runtime().block_on(fetch(&network, "https://example.com", None)).err(),
    Some(BLOCKED)
  );
  assert_eq!(*network.visits.lock().unwrap(), ["dns:example.com"]);
  assert_eq!(validate_addresses(&[]), Err(BLOCKED));
}
#[test]
fn redirects_are_validated_and_resolved_again_and_return_final_page_url() {
  let network = FakeNetwork::new(vec![redirect("/actual"), page(&article())]);
  let (_, source) = runtime()
    .block_on(fetch(&network, "https://example.com/original", None))
    .unwrap();
  assert_eq!(source, "https://example.com/actual");
  assert_eq!(
    *network.visits.lock().unwrap(),
    [
      "dns:example.com",
      "get:https://example.com/original",
      "dns:example.com",
      "get:https://example.com/actual"
    ]
  );
  let network = FakeNetwork::new(vec![redirect("https://private.example.com/secret")]);
  assert_eq!(
    runtime().block_on(fetch(&network, "https://example.com", None)).err(),
    Some(BLOCKED)
  );
  assert_eq!(network.visits.lock().unwrap().len(), 3);
  for location in [
    "http://example.com",
    "https://127.0.0.1",
    "https://user:pass@example.com",
  ] {
    let network = FakeNetwork::new(vec![redirect(location)]);
    assert!(runtime()
      .block_on(fetch(&network, "https://example.com", None))
      .is_err());
    assert_eq!(network.visits.lock().unwrap().len(), 2);
  }
}
#[test]
fn redirects_stop_at_four_and_missing_location_is_reported() {
  let network = FakeNetwork::new((0..5).map(|_| redirect("/again")).collect());
  assert_eq!(
    runtime().block_on(fetch(&network, "https://example.com", None)).err(),
    Some(REDIRECT)
  );
  assert_eq!(network.visits.lock().unwrap().len(), 10);
  assert_eq!(
    next_url(&Url::parse("https://example.com").unwrap(), None, 0),
    Err(REDIRECT)
  );
}
#[test]
fn content_type_status_and_body_limits_fail_before_extraction() {
  assert!(validate_content_type("Application/XHTML+XML; charset=utf-8").is_ok());
  for kind in ["", "text/plain", "image/png", "text/html-other"] {
    assert_eq!(validate_content_type(kind), Err(NOT_HTML));
  }
  let mut bytes = vec![0; MAX_BYTES - 1];
  append_body(&mut bytes, &[1]).unwrap();
  assert_eq!(append_body(&mut bytes, &[2]), Err(TOO_LARGE));
  assert_eq!(bytes.len(), MAX_BYTES);
  let mut missing = page("");
  missing.status = 404;
  assert_eq!(
    runtime()
      .block_on(fetch(&FakeNetwork::new(vec![missing]), "https://example.com", None))
      .err(),
    Some(FETCH)
  );
  let mut huge = page("");
  huge.bytes = vec![0; MAX_BYTES + 1];
  assert_eq!(
    runtime()
      .block_on(fetch(&FakeNetwork::new(vec![huge]), "https://example.com", None))
      .err(),
    Some(TOO_LARGE)
  );
}
#[test]
fn whole_import_timeout_covers_dns_waits() {
  struct Slow;
  impl Network for Slow {
    async fn resolve(&self, _: &str, _: u16) -> Result<Vec<SocketAddr>, SampleError> {
      std::future::pending().await
    }
    async fn get(&self, _: &Url, _: &[SocketAddr]) -> Result<Page, SampleError> {
      unreachable!()
    }
  }
  assert!(runtime().block_on(tokio_timeout()).is_err());
  async fn tokio_timeout() -> Result<Result<(Page, String), SampleError>, tokio::time::error::Elapsed> {
    tokio::time::timeout(Duration::from_millis(5), fetch(&Slow, "https://example.com", None)).await
  }
}

#[test]
fn auxiliary_fetches_allow_only_article_json_xml_and_keep_origin_after_public_dns_check() {
  assert_eq!(validate_content_type("application/json"), Ok(()));
  for kind in ["application/ld+json", "application/rss+xml", "application/atom+xml"] {
    assert_eq!(validate_content_type(kind), Ok(()));
  }
  let network = FakeNetwork::new(vec![redirect("https://other.example.com/article")]);
  assert_eq!(
    runtime()
      .block_on(fetch(&network, "https://example.com/rest", Some("https://example.com")))
      .err(),
    Some(ORIGIN)
  );
  assert_eq!(
    *network.visits.lock().unwrap(),
    [
      "dns:example.com",
      "get:https://example.com/rest",
      "dns:other.example.com"
    ]
  );
  let network = FakeNetwork::new(vec![redirect("https://private.example.com/secret")]);
  assert_eq!(
    runtime()
      .block_on(fetch(&network, "https://example.com/rest", Some("https://example.com")))
      .err(),
    Some(BLOCKED)
  );
}
