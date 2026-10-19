//! UI の購読準備を起動時処理へ知らせる一度きりのシグナル。

use std::time::Duration;
use tokio::sync::Notify;

#[derive(Default)]
pub(crate) struct UiReady {
  notify: Notify,
}

impl UiReady {
  pub(crate) fn signal(&self) {
    // Notify は待機前の notify_one を 1 permit 保持するため、起動処理との競合で通知を失わない。
    self.notify.notify_one();
  }

  pub(crate) async fn wait(&self, timeout: Duration) -> bool {
    tokio::time::timeout(timeout, self.notify.notified()).await.is_ok()
  }
}

#[cfg(test)]
mod tests {
  use super::UiReady;
  use std::time::Duration;

  #[tokio::test]
  async fn signal_before_wait_is_remembered() {
    let ready = UiReady::default();
    ready.signal();
    assert!(ready.wait(Duration::from_millis(10)).await);
  }

  #[tokio::test]
  async fn wait_times_out_when_the_ui_does_not_signal() {
    assert!(!UiReady::default().wait(Duration::from_millis(1)).await);
  }
}
