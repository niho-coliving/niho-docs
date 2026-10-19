#![allow(dead_code)]

pub mod memory;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use niho_desktop_vault::{
    account_key, load_or_default_state, Device, EditProtection, LocalSaveReceipt, LocalSaver,
    Namespace, ProjectTarget, SaveGroup, SaveKind, SaveWrite, SyncEngine, SyncEvent, SyncStatus,
    VaultProvider, VaultState,
};

pub const ROOT_ID: &str = "r_AAAAAAAAAAAAAAAAAAAAAA";
pub const ROOT_ID_2: &str = "r_BBBBBBBBBBBBBBBBBBBBBB";

pub fn account(name: &str) -> Namespace {
    Namespace::Account {
        account_key: account_key("test", name),
    }
}

pub fn device(id: &str) -> Device {
    Device {
        device_id: id.into(),
        device_name: id.into(),
        device_kind: Some("mac".into()),
    }
}

pub fn engine(provider: Arc<dyn VaultProvider>, app: &Path, device_id: &str) -> Arc<SyncEngine> {
    SyncEngine::new(
        provider,
        app,
        account("me"),
        ROOT_ID.into(),
        device(device_id),
        Arc::new(EditProtection::default()),
    )
}

pub fn state(app: &Path, project_id: &str) -> VaultState {
    load_or_default_state(app, &account("me"), ROOT_ID, project_id).unwrap()
}

pub fn target(project_id: &str, working_copy: &Path) -> ProjectTarget {
    ProjectTarget::new(project_id, working_copy)
}

pub fn put(
    saver: &LocalSaver,
    target: &ProjectTarget,
    path: &str,
    bytes: &[u8],
) -> LocalSaveReceipt {
    saver
        .save(
            target,
            SaveGroup {
                writes: vec![SaveWrite::Put {
                    path: path.into(),
                    bytes: bytes.to_vec(),
                }],
                kind: SaveKind::Edit,
            },
        )
        .unwrap()
}

/// 作業用の directory（working copy・app data）を作る。
pub fn dirs(root: &Path, names: &[&str]) -> Vec<PathBuf> {
    names
        .iter()
        .map(|name| {
            let path = root.join(name);
            std::fs::create_dir_all(&path).unwrap();
            path
        })
        .collect()
}

pub fn walk_files(root: &Path) -> Vec<PathBuf> {
    if !root.exists() {
        return Vec::new();
    }
    let mut files = Vec::new();
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(walk_files(&path));
        } else {
            files.push(path);
        }
    }
    files.sort();
    files
}

/// 次の Done を待つ（他の event は読み捨てる）。
pub async fn wait_done(events: &mut tokio::sync::broadcast::Receiver<SyncEvent>) -> SyncStatus {
    loop {
        match events.recv().await {
            Ok(SyncEvent::Done { status, .. }) => return status,
            Ok(_) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(error) => panic!("event channel closed: {error}"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Recorded {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

pub struct Reply {
    pub status: u16,
    pub content_type: &'static str,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(status: u16, value: serde_json::Value) -> Self {
        Self {
            status,
            content_type: "application/json",
            headers: Vec::new(),
            body: value.to_string().into_bytes(),
        }
    }

    pub fn bytes(status: u16, bytes: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            content_type: "application/octet-stream",
            headers: Vec::new(),
            body: bytes.into(),
        }
    }
}

type Handler = dyn Fn(&Recorded) -> Reply + Send + Sync;

pub struct FakeServer {
    pub base: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
}

impl FakeServer {
    pub fn start(
        handler: impl Fn(&Recorded) -> Reply + Send + Sync + 'static,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let handler: Arc<Handler> = Arc::new(handler);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let handler = handler.clone();
                let recorded = recorded.clone();
                std::thread::spawn(move || serve(stream, handler.as_ref(), &recorded));
            }
        });
        Ok(Self { base, requests })
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }
}

fn serve(stream: TcpStream, handler: &Handler, recorded: &Mutex<Vec<Recorded>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or("").to_owned();
    let target = request_parts.next().unwrap_or("").to_owned();
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            headers.push((key.trim().to_owned(), value.trim().to_owned()));
        }
    }
    let length = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    let request = Recorded {
        method,
        target,
        headers,
        body,
    };
    recorded.lock().unwrap().push(request.clone());
    let response = handler(&request);
    let mut stream = stream;
    let mut head = format!(
        "HTTP/1.1 {} X\r\nContent-Length: {}\r\nContent-Type: {}\r\nConnection: close\r\n",
        response.status,
        response.body.len(),
        response.content_type
    );
    for (key, value) in response.headers {
        head.push_str(&format!("{key}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(&response.body).unwrap();
}

pub fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}
