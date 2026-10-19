//! お手本の文書の取り込み（specs/initiatives/niho-docs.md §8.4・§10）。文書から本文を抽出し、正規化して先頭だけに切り詰める。
//!
//! - .md・.markdown・.txt: UTF-8（BOM 可）→ BOM 付きの UTF-16 → Shift_JIS（CP932。macOS の iconv）の順に読む。
//! - .docx: `word/document.xml` を流し読みし、見出し・箇条書き・太字を Markdown に写す（`word/styles.xml` で見出しの段を引く）。
//! - .pdf: macOS の PDFKit（osascript の JavaScript）で文字だけを読む。
//!
//! 保存（`flows/samples/<flowId>/<sampleId>.txt`）は store.rs。失敗はファイルごとに code と日本語の message で返す。

use crate::process::{child_command, signal_group, SIGKILL};
use crate::store::StoreError;
use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::{BytesStart, Event};
use quick_xml::name::{Namespace, ResolveResult};
use quick_xml::NsReader;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::thread;
use std::time::{Duration, Instant};

/// お手本の文書 1 本の字数（Unicode のスカラー値の数）の上限。
/// docs-core `packages/docs-core/src/rules.ts` の `SAMPLE_MAX_CHARS` と同じ値にする。
pub const SAMPLE_MAX_CHARS: usize = 30_000;
/// 1 ファイルの大きさの上限（20 MiB）。
pub const SAMPLE_MAX_BYTES: u64 = 20 * 1024 * 1024;
/// 取り込める拡張子（小文字）。選択のダイアログの filter にも使う。
pub const SAMPLE_EXTENSIONS: [&str; 5] = ["md", "markdown", "txt", "docx", "pdf"];
/// PDF の文字の読み取りの時間の上限（子プロセスを止める）。
const PDF_TIME_LIMIT: Duration = Duration::from_secs(60);
const ICONV_TIME_LIMIT: Duration = Duration::from_secs(30);
/// .docx の XML を展開する量の上限（壊れた・細工された zip で際限なく展開しない）。
const DOCUMENT_XML_MAX_BYTES: u64 = 256 * 1024 * 1024;
const STYLES_XML_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// 古い .doc・パスワード付きの .docx（OLE の複合文書）の先頭。
const OLE_MAGIC: [u8; 4] = [0xD0, 0xCF, 0x11, 0xE0];
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

const OSASCRIPT: &str = "/usr/bin/osascript";
const ICONV: &str = "/usr/bin/iconv";
/// PDFKit で各ページの文字を読み、ページの間を空行 1 つでつなぐ。開けない・ロックされているときは NUL で始まる印を返す。
const PDF_SCRIPT: &str = r#"ObjC.import('PDFKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) return "\u0000open";
  if (doc.isLocked) return "\u0000locked";
  const parts = [];
  for (let i = 0; i < doc.pageCount; i++) {
    const s = doc.pageAtIndex(i).string;
    parts.push(s && !s.isNil() ? ObjC.unwrap(s) : "");
  }
  return parts.join("\n\n");
}"#;

/// 取り込みの失敗（ファイルごと）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SampleError {
  pub code: &'static str,
  pub message: &'static str,
}

impl From<SampleError> for StoreError {
  fn from(error: SampleError) -> Self {
    StoreError {
      code: error.code.to_string(),
      message: error.message.to_string(),
    }
  }
}

pub const MISSING: SampleError = SampleError {
  code: "sample_missing",
  message: "ファイルが見つかりません。",
};
pub const UNSUPPORTED: SampleError = SampleError {
  code: "sample_unsupported",
  message: "この形式は取り込めません。.md・.txt・.docx・.pdf の文書を選んでください。",
};
pub const TOO_LARGE: SampleError = SampleError {
  code: "sample_too_large",
  message: "ファイルが大きすぎるため取り込めません（20MB まで）。",
};
pub const ENCODING: SampleError = SampleError {
  code: "sample_encoding",
  message: "文字コードを読めませんでした。UTF-8 で保存した文書を選んでください。",
};
pub const PROTECTED: SampleError = SampleError {
  code: "sample_protected",
  message: "パスワード付きの文書や古い形式（.doc）は取り込めません。Word で .docx として保存し直してください。",
};
pub const UNREADABLE: SampleError = SampleError {
  code: "sample_unreadable",
  message: "文書を読めませんでした。ファイルが壊れていないか確かめてください。",
};
pub const LOCKED: SampleError = SampleError {
  code: "sample_locked",
  message: "パスワード付きの PDF は取り込めません。",
};
pub const NO_TEXT: SampleError = SampleError {
  code: "sample_no_text",
  message: "文書に文字がありません。",
};
pub const NO_TEXT_PDF: SampleError = SampleError {
  code: "sample_no_text",
  message: "文字を読み取れませんでした。画像だけの PDF は取り込めません。",
};

/// 抽出した本文（正規化・切り詰め済み）。
#[derive(Debug, Clone, PartialEq)]
pub struct SampleText {
  pub text: String,
  /// 保存する本文の字数。
  pub chars: usize,
  /// 切り詰めたときだけ、元の字数。
  pub truncated_from: Option<usize>,
}

/// 表示用のファイル名（元のファイル名。無ければパスのまま）。
pub fn display_name(path: &Path) -> String {
  path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// 文書から本文を抽出する（形式の判定・上限・正規化・切り詰めまで）。
pub fn extract(path: &Path) -> Result<SampleText, SampleError> {
  let meta = path
    .is_absolute()
    .then(|| fs::metadata(path).ok())
    .flatten()
    .filter(|meta| meta.is_file())
    .ok_or(MISSING)?;
  let ext = path
    .extension()
    .map(|ext| ext.to_string_lossy().to_lowercase())
    .unwrap_or_default();
  if !SAMPLE_EXTENSIONS.contains(&ext.as_str()) {
    return Err(UNSUPPORTED);
  }
  if meta.len() > SAMPLE_MAX_BYTES {
    return Err(TOO_LARGE);
  }
  let raw = match ext.as_str() {
    "pdf" => pdf_text(path)?,
    "docx" => docx_markdown(&read_limited(path)?)?,
    _ => decode_text(&read_limited(path)?)?,
  };
  let text = normalize(&raw);
  if text.is_empty() {
    return Err(if ext == "pdf" { NO_TEXT_PDF } else { NO_TEXT });
  }
  Ok(truncate(text))
}

/// 上限まで読む（確かめた後に大きくなったファイルも上限で止める）。
fn read_limited(path: &Path) -> Result<Vec<u8>, SampleError> {
  let file = fs::File::open(path).map_err(|error| match error.kind() {
    std::io::ErrorKind::NotFound => MISSING,
    _ => UNREADABLE,
  })?;
  let mut bytes = Vec::new();
  file
    .take(SAMPLE_MAX_BYTES + 1)
    .read_to_end(&mut bytes)
    .map_err(|_| UNREADABLE)?;
  if bytes.len() as u64 > SAMPLE_MAX_BYTES {
    return Err(TOO_LARGE);
  }
  Ok(bytes)
}

// ---------------------------------------------------------------------------
// 正規化・切り詰め

/// 改行を `\n` に揃え、`\n`・`\t` 以外の制御文字を落とし、行末の空白を落とし、3 つ以上続く改行を 2 つにして、全体を trim する。
pub fn normalize(text: &str) -> String {
  let unified = text.replace("\r\n", "\n").replace('\r', "\n");
  let mut out = String::with_capacity(unified.len());
  let mut newlines = 0usize;
  for (index, line) in unified.split('\n').enumerate() {
    if index > 0 {
      newlines += 1;
    }
    let line: String = line.chars().filter(|ch| *ch == '\t' || !ch.is_control()).collect();
    let line = line.trim_end();
    if line.is_empty() {
      continue;
    }
    if !out.is_empty() {
      out.push_str(if newlines >= 2 { "\n\n" } else { "\n" });
    }
    out.push_str(line);
    newlines = 0;
  }
  out.trim().to_string()
}

/// 上限を超えたら、上限までのうち最後の改行で切る（その位置が上限の半分より前なら上限ちょうどで切る）。
pub fn truncate(text: String) -> SampleText {
  let chars = text.chars().count();
  if chars <= SAMPLE_MAX_CHARS {
    return SampleText {
      text,
      chars,
      truncated_from: None,
    };
  }
  let end = text
    .char_indices()
    .nth(SAMPLE_MAX_CHARS)
    .map(|(index, _)| index)
    .unwrap_or(text.len());
  let head = &text[..end];
  let cut = match head.rfind('\n') {
    Some(index) if head[..index].chars().count() >= SAMPLE_MAX_CHARS / 2 => index,
    _ => end,
  };
  let kept = head[..cut].trim_end().to_string();
  SampleText {
    chars: kept.chars().count(),
    text: kept,
    truncated_from: Some(chars),
  }
}

// ---------------------------------------------------------------------------
// .txt・.md

/// UTF-8（BOM は落とす）→ BOM 付きの UTF-16 LE/BE → CP932（iconv）。
pub fn decode_text(bytes: &[u8]) -> Result<String, SampleError> {
  let utf8 = bytes.strip_prefix(&UTF8_BOM[..]).unwrap_or(bytes);
  if let Ok(text) = std::str::from_utf8(utf8) {
    return Ok(text.to_string());
  }
  if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE][..]) {
    return decode_utf16(rest, u16::from_le_bytes);
  }
  if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF][..]) {
    return decode_utf16(rest, u16::from_be_bytes);
  }
  decode_cp932(bytes).ok_or(ENCODING)
}

fn decode_utf16(bytes: &[u8], unit: fn([u8; 2]) -> u16) -> Result<String, SampleError> {
  if bytes.len() % 2 != 0 {
    return Err(ENCODING);
  }
  let units = bytes.chunks_exact(2).map(|pair| unit([pair[0], pair[1]]));
  char::decode_utf16(units)
    .collect::<Result<String, _>>()
    .map_err(|_| ENCODING)
}

fn decode_cp932(bytes: &[u8]) -> Option<String> {
  let args = ["-f", "CP932", "-t", "UTF-8"].map(String::from);
  let output = run_child(Path::new(ICONV), &args, Some(bytes.to_vec()), ICONV_TIME_LIMIT).ok()?;
  if !output.success {
    return None;
  }
  String::from_utf8(output.stdout).ok()
}

// ---------------------------------------------------------------------------
// 子プロセス（iconv・osascript）

#[derive(Debug, PartialEq)]
enum ChildFailure {
  Spawn,
  TimedOut,
}

struct ChildOutput {
  success: bool,
  stdout: Vec<u8>,
}

/// 子プロセスを動かし、標準出力を全部受け取る。時間切れはプロセスグループごと止める（process.rs の起動の決まりに従う）。
fn run_child(
  program: &Path,
  args: &[String],
  input: Option<Vec<u8>>,
  limit: Duration,
) -> Result<ChildOutput, ChildFailure> {
  let mut command = child_command(program, args, None);
  command.stderr(Stdio::null());
  if input.is_none() {
    command.stdin(Stdio::null());
  }
  let mut child = command.spawn().map_err(|_| ChildFailure::Spawn)?;
  // 書き込みと読み取りを別の糸にする（大きな入力で pipe が詰まって止まらないように）
  let stdin = child.stdin.take();
  let writer = thread::spawn(move || {
    if let (Some(mut pipe), Some(input)) = (stdin, input) {
      let _ = pipe.write_all(&input);
    }
  });
  let stdout = child.stdout.take();
  let reader = thread::spawn(move || {
    let mut bytes = Vec::new();
    if let Some(mut pipe) = stdout {
      let _ = pipe.read_to_end(&mut bytes);
    }
    bytes
  });
  let deadline = Instant::now() + limit;
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break Some(status),
      Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
      _ => {
        signal_group(child.id(), SIGKILL);
        let _ = child.kill();
        let _ = child.wait();
        break None;
      }
    }
  };
  // 孫が pipe を握ったまま残らないように、グループごと止める
  signal_group(child.id(), SIGKILL);
  let _ = writer.join();
  let stdout = reader.join().unwrap_or_default();
  match status {
    Some(status) => Ok(ChildOutput {
      success: status.success(),
      stdout,
    }),
    None => Err(ChildFailure::TimedOut),
  }
}

// ---------------------------------------------------------------------------
// .pdf

fn pdf_text(path: &Path) -> Result<String, SampleError> {
  pdf_text_with(Path::new(OSASCRIPT), path, PDF_TIME_LIMIT)
}

fn pdf_text_with(osascript: &Path, path: &Path, limit: Duration) -> Result<String, SampleError> {
  let mut args = ["-l", "JavaScript", "-e", PDF_SCRIPT].map(String::from).to_vec();
  args.push(path.to_string_lossy().into_owned());
  let output = run_child(osascript, &args, None, limit).map_err(|_| UNREADABLE)?;
  if !output.success {
    return Err(UNREADABLE);
  }
  pdf_output(&output.stdout)
}

/// osascript の出力（開けない・ロックは NUL で始まる印）。
fn pdf_output(stdout: &[u8]) -> Result<String, SampleError> {
  let text = String::from_utf8_lossy(stdout);
  if text.starts_with("\u{0}locked") {
    return Err(LOCKED);
  }
  if text.starts_with("\u{0}open") {
    return Err(UNREADABLE);
  }
  Ok(text.into_owned())
}

// ---------------------------------------------------------------------------
// .docx

const W_NAMESPACES: [&[u8]; 2] = [
  b"http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  b"http://purl.oclc.org/ooxml/wordprocessingml/main",
];
const MC_NAMESPACE: &[u8] = b"http://schemas.openxmlformats.org/markup-compatibility/2006";
/// 見出しの `#` の数の上限。
const MAX_HEADING: usize = 6;
/// basedOn をたどる深さの上限（循環で止まらないように）。
const MAX_STYLE_CHAIN: usize = 16;

/// .docx の本文を Markdown にする。
pub fn docx_markdown(bytes: &[u8]) -> Result<String, SampleError> {
  if bytes.starts_with(&OLE_MAGIC) {
    return Err(PROTECTED);
  }
  let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| UNREADABLE)?;
  // styles.xml は無くても読む（壊れていれば見出しの段を引かない）
  let styles = match archive.by_name("word/styles.xml") {
    Ok(file) => parse_styles(BufReader::new(file.take(STYLES_XML_MAX_BYTES))).unwrap_or_default(),
    Err(_) => Styles::default(),
  };
  let document = archive.by_name("word/document.xml").map_err(|_| UNREADABLE)?;
  document_markdown(BufReader::new(document.take(DOCUMENT_XML_MAX_BYTES)), &styles).ok_or(UNREADABLE)
}

/// 読む要素（wordprocessingml と mc の、使うものだけ）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tag {
  P,
  PPr,
  PStyle,
  OutlineLvl,
  NumPr,
  Ilvl,
  NumId,
  R,
  RPr,
  RStyle,
  B,
  T,
  Tab,
  Br,
  Cr,
  NoBreakHyphen,
  Style,
  Name,
  BasedOn,
  /// 中身を捨てる要素（削除・移動元・フィールドの命令・mc:Fallback）。
  Skip,
  Other,
}

fn classify(namespace: &ResolveResult, local: &[u8]) -> Tag {
  match namespace {
    ResolveResult::Bound(Namespace(uri)) if W_NAMESPACES.contains(uri) => match local {
      b"p" => Tag::P,
      b"pPr" => Tag::PPr,
      b"pStyle" => Tag::PStyle,
      b"outlineLvl" => Tag::OutlineLvl,
      b"numPr" => Tag::NumPr,
      b"ilvl" => Tag::Ilvl,
      b"numId" => Tag::NumId,
      b"r" => Tag::R,
      b"rPr" => Tag::RPr,
      b"rStyle" => Tag::RStyle,
      b"b" => Tag::B,
      b"t" => Tag::T,
      b"tab" => Tag::Tab,
      b"br" => Tag::Br,
      b"cr" => Tag::Cr,
      b"noBreakHyphen" => Tag::NoBreakHyphen,
      b"style" => Tag::Style,
      b"name" => Tag::Name,
      b"basedOn" => Tag::BasedOn,
      b"del" | b"moveFrom" | b"delText" | b"instrText" => Tag::Skip,
      _ => Tag::Other,
    },
    ResolveResult::Bound(Namespace(uri)) if *uri == MC_NAMESPACE && local == b"Fallback" => Tag::Skip,
    _ => Tag::Other,
  }
}

/// 属性の値（接頭辞を問わず局所名で引く）。
fn attribute(element: &BytesStart, local: &[u8]) -> Option<String> {
  element
    .attributes()
    .flatten()
    .find(|attr| attr.key.local_name().as_ref() == local)
    .and_then(|attr| attr.unescape_value().ok().map(|value| value.into_owned()))
}

/// ST_OnOff（`w:val` が無ければ on）。
fn on_off(element: &BytesStart) -> bool {
  !matches!(attribute(element, b"val").as_deref(), Some("0" | "false" | "off"))
}

fn small_number(element: &BytesStart) -> Option<u8> {
  attribute(element, b"val").and_then(|value| value.trim().parse::<u8>().ok())
}

/// `word/styles.xml` の 1 つのスタイル（使うものだけ）。
#[derive(Debug, Clone, Default, PartialEq)]
struct StyleDef {
  name: String,
  based_on: Option<String>,
  outline: Option<u8>,
  /// numPr の numId が 0 以外か（numId 0 は番号を外す）。
  numbered: Option<bool>,
  ilvl: Option<u8>,
  bold: Option<bool>,
}

#[derive(Debug, Clone, Default)]
struct Styles(HashMap<String, StyleDef>);

impl Styles {
  /// そのスタイルと basedOn の先祖（近い順）。
  fn chain(&self, id: Option<&str>) -> Vec<&StyleDef> {
    let mut chain = Vec::new();
    let mut next = id.map(str::to_string);
    while let Some(id) = next.take() {
      let Some(style) = self.0.get(&id) else { break };
      chain.push(style);
      if chain.len() >= MAX_STYLE_CHAIN {
        break;
      }
      next = style.based_on.clone();
    }
    chain
  }

  /// 見出しの段（"heading N" → N・"Title" → 1・outlineLvl → +1）。名前で判定する（日本語の Word は styleId が数字）。
  fn heading(&self, id: Option<&str>) -> Option<usize> {
    for style in self.chain(id) {
      let name = style.name.trim().to_lowercase();
      if name == "title" {
        return Some(1);
      }
      if let Some(level) = name
        .strip_prefix("heading")
        .and_then(|rest| rest.trim().parse::<usize>().ok())
        .filter(|level| (1..=9).contains(level))
      {
        return Some(level);
      }
      if let Some(level) = style.outline {
        return outline_heading(level);
      }
    }
    None
  }

  fn numbered(&self, id: Option<&str>) -> Option<bool> {
    self.chain(id).iter().find_map(|style| style.numbered)
  }

  fn ilvl(&self, id: Option<&str>) -> Option<u8> {
    self.chain(id).iter().find_map(|style| style.ilvl)
  }

  fn bold(&self, id: Option<&str>) -> Option<bool> {
    self.chain(id).iter().find_map(|style| style.bold)
  }
}

/// outlineLvl（0 始まり。9 は本文）を見出しの段にする。
fn outline_heading(level: u8) -> Option<usize> {
  (level < 9).then_some(level as usize + 1)
}

fn parse_styles<R: BufRead>(input: R) -> Option<Styles> {
  let mut reader = NsReader::from_reader(input);
  let mut buf = Vec::new();
  let mut stack: Vec<Tag> = Vec::new();
  let mut styles = HashMap::new();
  let mut current: Option<(String, StyleDef)> = None;
  loop {
    let (namespace, event) = reader.read_resolved_event_into(&mut buf).ok()?;
    let (start, empty) = match event {
      Event::Start(start) => (start, false),
      Event::Empty(start) => (start, true),
      Event::End(_) => {
        if stack.pop()? == Tag::Style {
          if let Some((id, style)) = current.take() {
            styles.insert(id, style);
          }
        }
        buf.clear();
        continue;
      }
      Event::Eof => break,
      _ => {
        buf.clear();
        continue;
      }
    };
    let tag = classify(&namespace, start.local_name().as_ref());
    if let Some((_, style)) = current.as_mut() {
      match tag {
        Tag::Name if stack.ends_with(&[Tag::Style]) => style.name = attribute(&start, b"val").unwrap_or_default(),
        Tag::BasedOn if stack.ends_with(&[Tag::Style]) => style.based_on = attribute(&start, b"val"),
        Tag::OutlineLvl if stack.ends_with(&[Tag::Style, Tag::PPr]) => style.outline = small_number(&start),
        Tag::NumPr if stack.ends_with(&[Tag::Style, Tag::PPr]) => {
          style.numbered.get_or_insert(true);
        }
        Tag::NumId if stack.ends_with(&[Tag::Style, Tag::PPr, Tag::NumPr]) => {
          style.numbered = Some(attribute(&start, b"val").as_deref().map(str::trim) != Some("0"));
        }
        Tag::Ilvl if stack.ends_with(&[Tag::Style, Tag::PPr, Tag::NumPr]) => style.ilvl = small_number(&start),
        Tag::B if stack.ends_with(&[Tag::Style, Tag::RPr]) => style.bold = Some(on_off(&start)),
        _ => {}
      }
    } else if tag == Tag::Style && !empty {
      current = attribute(&start, b"styleId").map(|id| (id, StyleDef::default()));
    }
    if !empty {
      stack.push(tag);
    }
    buf.clear();
  }
  stack.is_empty().then_some(Styles(styles))
}

/// 読みかけの run。
#[derive(Debug, Default)]
struct Run {
  text: String,
  bold: Option<bool>,
  style: Option<String>,
}

/// 読みかけの段落。
#[derive(Debug, Default)]
struct Paragraph {
  style: Option<String>,
  outline: Option<u8>,
  has_num_pr: bool,
  numbered: Option<bool>,
  ilvl: Option<u8>,
  /// (文字, 太字か)。
  spans: Vec<(String, bool)>,
  run: Option<Run>,
}

/// 書き出す段落（Markdown の 1 ブロック）。
struct Block {
  text: String,
  list: bool,
}

impl Paragraph {
  fn push_text(&mut self, text: &str) {
    match self.run.as_mut() {
      Some(run) => run.text.push_str(text),
      None => self.spans.push((text.to_string(), false)),
    }
  }

  fn close_run(&mut self, styles: &Styles) {
    if let Some(run) = self.run.take() {
      if !run.text.is_empty() {
        let bold = run.bold.or_else(|| styles.bold(run.style.as_deref())).unwrap_or(false);
        self.spans.push((run.text, bold));
      }
    }
  }

  fn finish(mut self, styles: &Styles) -> Option<Block> {
    self.close_run(styles);
    let style = self.style.as_deref();
    let heading = match self.outline {
      Some(level) => outline_heading(level),
      None => styles.heading(style),
    };
    if let Some(level) = heading {
      let text: String = self.spans.iter().map(|(text, _)| text.as_str()).collect();
      let text = text.replace('\n', " ");
      let text = text.trim();
      return (!text.is_empty()).then(|| Block {
        text: format!("{} {text}", "#".repeat(level.min(MAX_HEADING))),
        list: false,
      });
    }
    let body = render_spans(&self.spans);
    let body = body.trim_matches(|ch: char| ch.is_ascii_whitespace());
    if body.trim().is_empty() {
      return None;
    }
    let numbered = self
      .numbered
      .or_else(|| styles.numbered(style))
      .unwrap_or(self.has_num_pr);
    if numbered {
      let level = self.ilvl.or_else(|| styles.ilvl(style)).unwrap_or(0).min(8) as usize;
      return Some(Block {
        text: format!("{}- {body}", "  ".repeat(level)),
        list: true,
      });
    }
    Some(Block {
      text: body.to_string(),
      list: false,
    })
  }
}

/// 続く太字の run をまとめて `**…**` で囲む（空白だけの太字は囲まない。前後の空白は外に出す）。
fn render_spans(spans: &[(String, bool)]) -> String {
  let mut merged: Vec<(String, bool)> = Vec::new();
  for (text, bold) in spans {
    match merged.last_mut() {
      Some((last, last_bold)) if *last_bold == *bold => last.push_str(text),
      _ => merged.push((text.clone(), *bold)),
    }
  }
  let mut out = String::new();
  for (text, bold) in merged {
    let core = text.trim();
    if !bold || core.is_empty() {
      out.push_str(&text);
      continue;
    }
    let lead = &text[..text.len() - text.trim_start().len()];
    let trail = &text[text.trim_end().len()..];
    out.push_str(lead);
    out.push_str("**");
    out.push_str(core);
    out.push_str("**");
    out.push_str(trail);
  }
  out
}

/// `word/document.xml` を流し読みして Markdown にする。XML が壊れていれば None。
fn document_markdown<R: BufRead>(input: R, styles: &Styles) -> Option<String> {
  let mut reader = NsReader::from_reader(input);
  let mut buf = Vec::new();
  let mut stack: Vec<Tag> = Vec::new();
  let mut skip = 0usize;
  let mut saw_root = false;
  // テキストボックスのように段落の中に段落があるので、段落はスタックで持ち、閉じたときに出す
  let mut paragraphs: Vec<Paragraph> = Vec::new();
  let mut blocks: Vec<Block> = Vec::new();
  loop {
    let (namespace, event) = reader.read_resolved_event_into(&mut buf).ok()?;
    match event {
      // 捨てる中身の中でも、要素の深さだけは数える
      Event::Start(start) if skip > 0 => {
        let tag = classify(&namespace, start.local_name().as_ref());
        stack.push(tag);
        skip += usize::from(tag == Tag::Skip);
      }
      Event::Empty(_) if skip > 0 => {}
      Event::Start(start) => {
        saw_root = true;
        let tag = classify(&namespace, start.local_name().as_ref());
        open(tag, &start, false, &stack, &mut paragraphs);
        stack.push(tag);
        skip += usize::from(tag == Tag::Skip);
      }
      Event::Empty(start) => {
        saw_root = true;
        let tag = classify(&namespace, start.local_name().as_ref());
        open(tag, &start, true, &stack, &mut paragraphs);
      }
      Event::End(_) => {
        let tag = stack.pop()?;
        if tag == Tag::Skip {
          skip -= 1;
        } else if skip == 0 {
          close(tag, styles, &mut paragraphs, &mut blocks);
        }
      }
      Event::Text(text) if skip == 0 && stack.last() == Some(&Tag::T) => {
        let text = text.xml10_content().ok()?;
        if let Some(paragraph) = paragraphs.last_mut() {
          paragraph.push_text(&text);
        }
      }
      Event::CData(text) if skip == 0 && stack.last() == Some(&Tag::T) => {
        let text = text.decode().ok()?;
        if let Some(paragraph) = paragraphs.last_mut() {
          paragraph.push_text(&text);
        }
      }
      Event::GeneralRef(reference) if skip == 0 && stack.last() == Some(&Tag::T) => {
        let resolved = match reference.resolve_char_ref() {
          Ok(Some(ch)) => Some(ch.to_string()),
          Ok(None) => reference
            .decode()
            .ok()
            .and_then(|name| resolve_predefined_entity(&name).map(str::to_string)),
          Err(_) => None,
        };
        if let (Some(text), Some(paragraph)) = (resolved, paragraphs.last_mut()) {
          paragraph.push_text(&text);
        }
      }
      Event::Eof => break,
      _ => {}
    }
    buf.clear();
  }
  // 途中で切れた XML（閉じていない要素が残る）・空の XML は壊れている
  if !stack.is_empty() || !saw_root {
    return None;
  }
  let mut out = String::new();
  let mut previous_list = false;
  for block in blocks {
    if !out.is_empty() {
      out.push_str(if previous_list && block.list { "\n" } else { "\n\n" });
    }
    out.push_str(&block.text);
    previous_list = block.list;
  }
  Some(out)
}

/// 要素の始まり（Empty も）。親（stack の末尾）で意味が決まる要素は、親を確かめてから段落・run に入れる。
fn open(tag: Tag, element: &BytesStart, empty: bool, stack: &[Tag], paragraphs: &mut Vec<Paragraph>) {
  if tag == Tag::P {
    if !empty {
      paragraphs.push(Paragraph::default());
    }
    return;
  }
  let Some(paragraph) = paragraphs.last_mut() else {
    return;
  };
  let in_ppr = stack.ends_with(&[Tag::P, Tag::PPr]);
  let in_num_pr = stack.ends_with(&[Tag::P, Tag::PPr, Tag::NumPr]);
  let in_rpr = stack.ends_with(&[Tag::R, Tag::RPr]);
  let in_run = stack.last() == Some(&Tag::R);
  match tag {
    Tag::R if !empty => paragraph.run = Some(Run::default()),
    Tag::PStyle if in_ppr => paragraph.style = attribute(element, b"val"),
    Tag::OutlineLvl if in_ppr => paragraph.outline = small_number(element),
    Tag::NumPr if in_ppr => paragraph.has_num_pr = true,
    Tag::NumId if in_num_pr => {
      paragraph.numbered = Some(attribute(element, b"val").as_deref().map(str::trim) != Some("0"));
    }
    Tag::Ilvl if in_num_pr => paragraph.ilvl = small_number(element),
    Tag::B if in_rpr => {
      if let Some(run) = paragraph.run.as_mut() {
        run.bold = Some(on_off(element));
      }
    }
    Tag::RStyle if in_rpr => {
      if let Some(run) = paragraph.run.as_mut() {
        run.style = attribute(element, b"val");
      }
    }
    Tag::Tab if in_run => paragraph.push_text("\t"),
    Tag::Br | Tag::Cr if in_run => paragraph.push_text("\n"),
    Tag::NoBreakHyphen if in_run => paragraph.push_text("-"),
    _ => {}
  }
}

/// 要素の終わり。run は段落の文字に、段落は Markdown のブロックにする。
fn close(tag: Tag, styles: &Styles, paragraphs: &mut Vec<Paragraph>, blocks: &mut Vec<Block>) {
  match tag {
    Tag::R => {
      if let Some(paragraph) = paragraphs.last_mut() {
        paragraph.close_run(styles);
      }
    }
    Tag::P => {
      if let Some(block) = paragraphs.pop().and_then(|paragraph| paragraph.finish(styles)) {
        blocks.push(block);
      }
    }
    _ => {}
  }
}

#[cfg(test)]
#[path = "samples_tests.rs"]
mod tests;
