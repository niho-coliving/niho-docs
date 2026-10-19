//! ローカルの偽の API サーバー（127.0.0.1 の空いている番号。HTTP/1.1・1 回ごとに接続を閉じる）。
//! 届いた依頼（道・ヘッダー・本文）を記録し、台本の返事（状態と本文・SSE の塊・返さずに待つ）を返す。

#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Recorded {
  pub method: String,
  /// 道とクエリ（`/v1/listen?model=nova-3`）。
  pub target: String,
  pub headers: Vec<(String, String)>,
  pub body: Vec<u8>,
}

impl Recorded {
  pub fn header(&self, name: &str) -> Option<&str> {
    self
      .headers
      .iter()
      .find(|(key, _)| key.eq_ignore_ascii_case(name))
      .map(|(_, value)| value.as_str())
  }

  pub fn json(&self) -> serde_json::Value {
    serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
  }

  pub fn path(&self) -> &str {
    self.target.split('?').next().unwrap_or("")
  }
}

pub enum Reply {
  /// 状態・追加のヘッダー・本文。
  Full(u16, Vec<(String, String)>, String),
  /// SSE（塊と、その前に待つ時間）。
  Sse(Vec<(Duration, String)>),
  /// 返さずに待つ（時間切れの確かめ）。
  Hang(Duration),
}

pub fn json_reply(status: u16, body: serde_json::Value) -> Reply {
  Reply::Full(
    status,
    vec![("Content-Type".into(), "application/json".into())],
    body.to_string(),
  )
}

/// `data: {..}\n\n` の並び（Anthropic は `event:` も付ける）。
pub fn sse(events: &[serde_json::Value]) -> Reply {
  Reply::Sse(
    events
      .iter()
      .map(|event| {
        let name = event.get("type").and_then(|value| value.as_str()).unwrap_or("");
        let chunk = if name.is_empty() {
          format!("data: {event}\n\n")
        } else {
          format!("event: {name}\ndata: {event}\n\n")
        };
        (Duration::ZERO, chunk)
      })
      .collect(),
  )
}

type Handler = dyn Fn(&Recorded, usize) -> Reply + Send + Sync;

pub struct FakeServer {
  pub base: String,
  pub requests: Arc<Mutex<Vec<Recorded>>>,
}

impl FakeServer {
  pub fn start(handler: impl Fn(&Recorded, usize) -> Reply + Send + Sync + 'static) -> Self {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let handler: Arc<Handler> = Arc::new(handler);
    let recorded = requests.clone();
    std::thread::spawn(move || {
      for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let handler = handler.clone();
        let recorded = recorded.clone();
        std::thread::spawn(move || serve(stream, &*handler, &recorded));
      }
    });
    Self { base, requests }
  }

  pub fn requests(&self) -> Vec<Recorded> {
    self.requests.lock().unwrap().clone()
  }
}

fn read_chunked(reader: &mut BufReader<TcpStream>) -> Vec<u8> {
  let mut body = Vec::new();
  loop {
    let mut size = String::new();
    if reader.read_line(&mut size).unwrap_or(0) == 0 {
      break;
    }
    let size = usize::from_str_radix(size.trim().split(';').next().unwrap_or("0"), 16).unwrap_or(0);
    if size == 0 {
      let mut end = String::new();
      let _ = reader.read_line(&mut end);
      break;
    }
    let mut chunk = vec![0; size];
    reader.read_exact(&mut chunk).unwrap();
    body.extend_from_slice(&chunk);
    let mut crlf = [0; 2];
    let _ = reader.read_exact(&mut crlf);
  }
  body
}

fn serve(stream: TcpStream, handler: &Handler, recorded: &Mutex<Vec<Recorded>>) {
  let mut reader = BufReader::new(stream.try_clone().unwrap());
  let mut line = String::new();
  if reader.read_line(&mut line).unwrap_or(0) == 0 {
    return;
  }
  let mut parts = line.split_whitespace();
  let method = parts.next().unwrap_or("").to_string();
  let target = parts.next().unwrap_or("").to_string();
  let mut headers = Vec::new();
  loop {
    let mut header = String::new();
    if reader.read_line(&mut header).unwrap_or(0) == 0 {
      break;
    }
    let header = header.trim_end();
    if header.is_empty() {
      break;
    }
    if let Some((key, value)) = header.split_once(':') {
      headers.push((key.trim().to_string(), value.trim().to_string()));
    }
  }
  let find = |name: &str| {
    headers
      .iter()
      .find(|(key, _): &&(String, String)| key.eq_ignore_ascii_case(name))
      .map(|(_, value)| value.clone())
  };
  let body = if find("transfer-encoding").is_some_and(|value| value.eq_ignore_ascii_case("chunked")) {
    read_chunked(&mut reader)
  } else {
    let length: usize = find("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    body
  };
  let request = Recorded {
    method,
    target,
    headers,
    body,
  };
  let call = {
    let mut all = recorded.lock().unwrap();
    all.push(request.clone());
    all.len() - 1
  };
  let mut stream = stream;
  match handler(&request, call) {
    Reply::Full(status, extra, body) => {
      let mut head = format!(
        "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
      );
      for (key, value) in extra {
        head.push_str(&format!("{key}: {value}\r\n"));
      }
      head.push_str("\r\n");
      let _ = stream.write_all(head.as_bytes());
      let _ = stream.write_all(body.as_bytes());
    }
    Reply::Sse(chunks) => {
      let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
      let _ = stream.flush();
      for (delay, chunk) in chunks {
        std::thread::sleep(delay);
        if stream.write_all(chunk.as_bytes()).is_err() {
          return;
        }
        let _ = stream.flush();
      }
    }
    Reply::Hang(duration) => {
      let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n");
      let _ = stream.flush();
      std::thread::sleep(duration);
    }
  }
  let _ = stream.shutdown(std::net::Shutdown::Both);
}
