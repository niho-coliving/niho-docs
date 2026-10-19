//! 同じ保存領域を使う Mac アプリは、コピー・旧版を含めて 1 プロセスだけにする。
//! OS のファイルロックを先に取り、2 回目の通常起動は既存の窓を開く通知だけ送って終える。

use sha2::{Digest, Sha256};
use std::fs::{DirBuilder, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{plugin::TauriPlugin, Manager, Resource, ResourceId, RunEvent, Wry};

const OPEN: u8 = 1;
const CALLBACK: u8 = 2;
const ACK: u8 = 1;
const NACK: u8 = 0;
const MAX_CALLBACK_BYTES: usize = 4096;
const NOTIFY_WAIT: Duration = Duration::from_secs(10);

struct Instance {
  // 最後に閉じる。ロックファイル自体は消さない（別 inode のロックを作らせない）。
  _lock: File,
  socket: PathBuf,
  stopped: Arc<AtomicBool>,
}

impl Resource for Instance {}

impl Drop for Instance {
  fn drop(&mut self) {
    self.stopped.store(true, Ordering::Release);
    let _ = std::fs::remove_file(&self.socket);
    // _lock を閉じると OS が排他を解く。クラッシュ時も OS が解くので PID 判定は要らない。
  }
}

struct InstanceId(ResourceId);

/// plugin はアカウント・同期・常駐処理より先に登録する。
pub(crate) fn init(dev: bool) -> TauriPlugin<Wry> {
  let ready = Arc::new(AtomicBool::new(false));
  let stopped = Arc::new(AtomicBool::new(false));
  let setup_ready = ready.clone();
  let setup_stopped = stopped.clone();
  tauri::plugin::Builder::new("docs-single-instance")
    .setup(move |app, _| {
      let data_dir = crate::data_dir_for(
        std::env::var(crate::DATA_DIR_ENV).ok().as_deref(),
        app.path().app_data_dir()?,
        dev,
      );
      std::fs::create_dir_all(&data_dir)?;
      let data_dir = data_dir.canonicalize()?;
      let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(data_dir.join(".instance.lock"))?;
      // 接続先の有無ではなく flock で先着を決める。同時起動・起動準備中も 1 つだけ通す。
      let mut acquired = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
      if !acquired {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::WouldBlock {
          return Err(error.into());
        }
        let background = crate::resident::is_background_launch(std::env::args());
        if background {
          std::process::exit(0);
        }
        let callbacks =
          niho_desktop_account::tauri::startup_callback_urls(app, niho_desktop_account::ClientId::Docs.scheme())?;
        let socket = socket_path(&data_dir)?;
        let deadline = Instant::now() + NOTIFY_WAIT;
        loop {
          // ACK は先行側の主スレッドで窓を表示し、callback を引き受けた後にだけ返る。
          if notify_existing(&socket, &callbacks).unwrap_or(false) {
            std::process::exit(0);
          }
          acquired = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
          if acquired {
            break;
          }
          if Instant::now() >= deadline {
            return Err(
              io::Error::new(
                io::ErrorKind::TimedOut,
                "既存の NIHO docs が終了中です。もう一度開いてください。",
              )
              .into(),
            );
          }
          std::thread::sleep(Duration::from_millis(50));
        }
      }

      let socket = socket_path(&data_dir)?;
      // 排他を持つプロセスだけが、クラッシュで残った socket を片付けて bind する。
      match std::fs::remove_file(&socket) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
      }
      let listener = UnixListener::bind(&socket)?;
      listener.set_nonblocking(true)?;
      let instance = Instance {
        _lock: file,
        socket,
        stopped: setup_stopped.clone(),
      };
      let stopped = instance.stopped.clone();
      let ready = setup_ready.clone();
      let handle = app.clone();
      std::thread::Builder::new()
        .name("docs-instance".into())
        .spawn(move || {
          while !stopped.load(Ordering::Acquire) {
            match listener.accept() {
              Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let request = read_request(&mut stream);
                if request.is_err() || !ready.load(Ordering::Acquire) || stopped.load(Ordering::Acquire) {
                  let _ = stream.write_all(&[NACK]);
                  continue;
                }
                let callback = request.unwrap();
                let handle = handle.clone();
                let main = handle.clone();
                let exiting = stopped.clone();
                let _ = handle.run_on_main_thread(move || {
                  if exiting.load(Ordering::Acquire) {
                    let _ = stream.write_all(&[NACK]);
                    return;
                  }
                  let accepted = callback.as_deref().map_or(true, |url| {
                    niho_desktop_account::tauri::accept_forwarded_callback(&main, url)
                  });
                  if accepted {
                    crate::resident::show_main_window(&main);
                  }
                  let _ = stream.write_all(&[if accepted { ACK } else { NACK }]);
                });
              }
              Err(error)
                if matches!(
                  error.kind(),
                  io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut | io::ErrorKind::Interrupted
                ) =>
              {
                std::thread::sleep(Duration::from_millis(25))
              }
              Err(_) => break,
            }
          }
        })?;
      let id = app.resources_table().add(instance);
      app.manage(InstanceId(id));
      Ok(())
    })
    .on_event(move |_app, event| match event {
      RunEvent::Ready => ready.store(true, Ordering::Release),
      RunEvent::Exit => stopped.store(true, Ordering::Release),
      _ => {}
    })
    .build()
}

fn socket_path(data_dir: &Path) -> io::Result<PathBuf> {
  // macOS の Unix socket のパス長制限に収める。ユーザー専用の短い一時ディレクトリを使う。
  let uid = unsafe { libc::geteuid() };
  let dir = PathBuf::from(format!("/tmp/niho-docs-{uid}"));
  match DirBuilder::new().mode(0o700).create(&dir) {
    Ok(()) => {}
    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
    Err(error) => return Err(error),
  }
  let metadata = std::fs::symlink_metadata(&dir)?;
  if !metadata.is_dir() || metadata.uid() != uid || metadata.permissions().mode() & 0o077 != 0 {
    return Err(io::Error::new(
      io::ErrorKind::PermissionDenied,
      "NIHO docs の起動用フォルダを使えません。",
    ));
  }
  // 本番・開発版・明示的な試験用の保存領域は独立。アプリの場所と版は鍵に含めない。
  let digest = Sha256::digest(data_dir.as_os_str().as_encoded_bytes());
  Ok(dir.join(format!("{}.sock", crate::process::hex(&digest[..16]))))
}

fn read_request(stream: &mut UnixStream) -> io::Result<Option<String>> {
  let mut header = [0u8; 3];
  stream.read_exact(&mut header)?;
  let length = usize::from(u16::from_be_bytes([header[1], header[2]]));
  if length > MAX_CALLBACK_BYTES {
    return Err(io::Error::new(io::ErrorKind::InvalidData, "起動用 URL が長すぎます。"));
  }
  match (header[0], length) {
    (OPEN, 0) => Ok(None),
    (CALLBACK, 1..) => {
      let mut bytes = vec![0; length];
      stream.read_exact(&mut bytes)?;
      String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "起動用 URL を読めません。"))
    }
    _ => Err(io::Error::new(io::ErrorKind::InvalidData, "起動通知を読めません。")),
  }
}

fn send_request(socket: &Path, callback: Option<&str>) -> io::Result<bool> {
  let mut stream = UnixStream::connect(socket)?;
  stream.set_read_timeout(Some(Duration::from_secs(2)))?;
  stream.set_write_timeout(Some(Duration::from_secs(2)))?;
  let bytes = callback.map_or(&[][..], str::as_bytes);
  if bytes.len() > MAX_CALLBACK_BYTES {
    return Err(io::Error::new(io::ErrorKind::InvalidInput, "起動用 URL が長すぎます。"));
  }
  let length =
    u16::try_from(bytes.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "起動用 URL が長すぎます。"))?;
  stream.write_all(&[if callback.is_some() { CALLBACK } else { OPEN }])?;
  stream.write_all(&length.to_be_bytes())?;
  stream.write_all(bytes)?;
  let mut response = [NACK];
  stream.read_exact(&mut response)?;
  Ok(response[0] == ACK)
}

fn notify_existing(socket: &Path, callbacks: &[String]) -> io::Result<bool> {
  if callbacks.is_empty() {
    return send_request(socket, None);
  }
  for callback in callbacks {
    if !send_request(socket, Some(callback))? {
      return Ok(false);
    }
  }
  Ok(true)
}

/// 終了処理と更新の差し替えが終わった後、background の子を起動する直前にだけ呼ぶ。
/// ふつうの終了と Tauri の再起動は resources_table の cleanup が解放する。
pub(crate) fn release_for_background_relaunch(app: &tauri::AppHandle) {
  if let Some(id) = app.try_state::<InstanceId>() {
    let _ = app.resources_table().close(id.0);
  }
}
