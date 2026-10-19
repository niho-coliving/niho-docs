//! Server-Sent Events の読み取り（3 社とも `text/event-stream`）。届いたバイト列を行に分け、空行で 1 つのイベントにする。
//! 行の途中・UTF-8 の文字の途中で切れた塊も、次の塊とつないでから読む。

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SseEvent {
  /// `event:` の値（無ければ空）。
  pub event: String,
  /// `data:` の行を改行でつないだもの。
  pub data: String,
}

#[derive(Default)]
pub struct SseParser {
  buffer: Vec<u8>,
  event: String,
  data: Vec<String>,
}

impl SseParser {
  /// 塊を足し、そこまでで終わったイベントを返す。
  pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
    self.buffer.extend_from_slice(chunk);
    let mut events = Vec::new();
    while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
      let mut line: Vec<u8> = self.buffer.drain(..=end).collect();
      line.pop();
      if line.last() == Some(&b'\r') {
        line.pop();
      }
      let line = String::from_utf8_lossy(&line).into_owned();
      if let Some(event) = self.line(&line) {
        events.push(event);
      }
    }
    events
  }

  /// 流れが終わったとき、空行の無い最後のイベントを返す。
  pub fn finish(&mut self) -> Option<SseEvent> {
    if !self.buffer.is_empty() {
      let rest = String::from_utf8_lossy(&std::mem::take(&mut self.buffer)).into_owned();
      let rest = rest.trim_end_matches(['\r', '\n']).to_string();
      if let Some(event) = self.line(&rest) {
        return Some(event);
      }
    }
    self.dispatch()
  }

  fn line(&mut self, line: &str) -> Option<SseEvent> {
    if line.is_empty() {
      return self.dispatch();
    }
    if line.starts_with(':') {
      return None;
    }
    let (field, value) = match line.find(':') {
      Some(index) => {
        let value = &line[index + 1..];
        (&line[..index], value.strip_prefix(' ').unwrap_or(value))
      }
      None => (line, ""),
    };
    match field {
      "event" => self.event = value.to_string(),
      "data" => self.data.push(value.to_string()),
      _ => {}
    }
    None
  }

  fn dispatch(&mut self) -> Option<SseEvent> {
    if self.data.is_empty() && self.event.is_empty() {
      return None;
    }
    let event = SseEvent {
      event: std::mem::take(&mut self.event),
      data: std::mem::take(&mut self.data).join("\n"),
    };
    Some(event)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn events_split_across_chunks_and_multibyte_characters_are_joined() {
    let text = "event: a\ndata: {\"t\":\"こんにちは\"}\n\n: ping\n\ndata: x\r\ndata: y\r\n\r\n";
    let bytes = text.as_bytes();
    let mut parser = SseParser::default();
    let mut events = Vec::new();
    // 1 バイトずつ渡す（UTF-8 の文字の途中でも切る）
    for byte in bytes {
      events.extend(parser.push(std::slice::from_ref(byte)));
    }
    assert_eq!(
      events,
      vec![
        SseEvent {
          event: "a".into(),
          data: "{\"t\":\"こんにちは\"}".into()
        },
        SseEvent {
          event: String::new(),
          data: "x\ny".into()
        },
      ]
    );
    assert_eq!(parser.finish(), None);
  }

  #[test]
  fn the_last_event_without_a_blank_line_is_returned_at_the_end() {
    let mut parser = SseParser::default();
    assert!(parser.push(b"data: {\"done\":true}").is_empty());
    assert_eq!(
      parser.finish(),
      Some(SseEvent {
        event: String::new(),
        data: "{\"done\":true}".into()
      })
    );
  }
}
