use super::*;
use std::path::PathBuf;
use std::process::Command;

/// テストごとの一時フォルダ（終わったら消す）。
struct TempDir(PathBuf);

impl TempDir {
  fn new(name: &str) -> Self {
    let path = std::env::temp_dir().join(format!(
      "niho-docs-samples-{name}-{}-{}",
      std::process::id(),
      crate::process::hex(&crate::process::random_bytes::<4>().unwrap())
    ));
    fs::create_dir_all(&path).unwrap();
    Self(path)
  }

  fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
    let path = self.0.join(name);
    fs::write(&path, bytes).unwrap();
    path
  }
}

impl Drop for TempDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

fn utf16(text: &str, little_endian: bool) -> Vec<u8> {
  let mut bytes = if little_endian {
    vec![0xFF, 0xFE]
  } else {
    vec![0xFE, 0xFF]
  };
  for unit in text.encode_utf16() {
    bytes.extend_from_slice(&if little_endian {
      unit.to_le_bytes()
    } else {
      unit.to_be_bytes()
    });
  }
  bytes
}

#[test]
fn text_files_are_read_as_utf8_utf16_or_cp932() {
  let dir = TempDir::new("text");
  let plain = dir.write("メモ.txt", "# 見出し\r\n\r\n本文です。".as_bytes());
  let sample = extract(&plain).unwrap();
  assert_eq!(sample.text, "# 見出し\n\n本文です。");
  assert_eq!(sample.chars, 12);
  assert_eq!(sample.truncated_from, None);

  let mut bom = UTF8_BOM.to_vec();
  bom.extend_from_slice("BOM 付き".as_bytes());
  assert_eq!(extract(&dir.write("a.MD", &bom)).unwrap().text, "BOM 付き");
  assert_eq!(
    extract(&dir.write("le.txt", &utf16("日本語の文章 😀", true)))
      .unwrap()
      .text,
    "日本語の文章 😀"
  );
  assert_eq!(
    extract(&dir.write("be.markdown", &utf16("日本語の文章", false)))
      .unwrap()
      .text,
    "日本語の文章"
  );
  // Shift_JIS（CP932）の「日本語の文章」
  let cp932 = [0x93, 0xFA, 0x96, 0x7B, 0x8C, 0xEA, 0x82, 0xCC, 0x95, 0xB6, 0x8F, 0xCD];
  assert_eq!(extract(&dir.write("sjis.txt", &cp932)).unwrap().text, "日本語の文章");

  // どれでも読めない（CP932 でも不正な並び）・BOM 付きの UTF-16 が壊れている
  assert_eq!(extract(&dir.write("bad.txt", &[0x82, 0xFF, 0xFE])), Err(ENCODING));
  assert_eq!(decode_text(&[0xFF, 0xFE, 0x00, 0xD8]), Err(ENCODING));
  assert_eq!(decode_text(&[0xFE, 0xFF, 0x00]), Err(ENCODING));
  assert_eq!(extract(&dir.write("empty.md", b" \n\t\r\n")), Err(NO_TEXT));
}

#[test]
fn formats_paths_and_sizes_are_checked_before_reading() {
  let dir = TempDir::new("checks");
  assert_eq!(extract(&dir.write("古い.doc", b"x")), Err(UNSUPPORTED));
  assert_eq!(extract(&dir.write("拡張子なし", b"x")), Err(UNSUPPORTED));
  assert_eq!(extract(Path::new("relative.txt")), Err(MISSING));
  assert_eq!(extract(&dir.0.join("none.txt")), Err(MISSING));
  fs::create_dir_all(dir.0.join("folder.txt")).unwrap();
  assert_eq!(extract(&dir.0.join("folder.txt")), Err(MISSING));
  // 20 MiB を超える（中身の無い疎なファイル）
  let large = dir.0.join("large.txt");
  fs::File::create(&large).unwrap().set_len(SAMPLE_MAX_BYTES + 1).unwrap();
  assert_eq!(extract(&large), Err(TOO_LARGE));
  assert_eq!(display_name(&large), "large.txt");
  let error = StoreError::from(TOO_LARGE);
  assert_eq!(error.code, "sample_too_large");
  assert_eq!(error.message, "ファイルが大きすぎるため取り込めません（20MB まで）。");
}

#[test]
fn text_is_normalized() {
  assert_eq!(
    normalize("\n  一行目　 \r\n\r\n\r\n\r\n二\u{7}行目\t\r三行目\u{0}\n\n\n\n\t\n四行目\u{feff}  \n"),
    "一行目\n\n二行目\n三行目\n\n四行目\u{feff}"
  );
  assert_eq!(normalize("a\n\nb\nc"), "a\n\nb\nc");
  assert_eq!(normalize("\t字下げ\n"), "字下げ");
  assert_eq!(normalize(" \u{1b}[0m \n"), "[0m");
}

#[test]
fn long_text_is_cut_at_the_last_newline_or_at_the_limit() {
  // 上限の半分より後に改行がある: その改行で切る
  let text = format!("{}\n\n{}", "い".repeat(20_000), "う".repeat(20_000));
  let cut = truncate(text);
  assert_eq!(cut.text, "い".repeat(20_000));
  assert_eq!(cut.chars, 20_000);
  assert_eq!(cut.truncated_from, Some(40_002));

  // 改行が上限の半分より前にしか無い: 上限ちょうどで切る（絵文字も 1 字）
  let text = format!("{}\n{}", "え".repeat(100), "😀".repeat(40_000));
  let cut = truncate(text);
  assert_eq!(cut.chars, SAMPLE_MAX_CHARS);
  assert_eq!(cut.text, format!("{}\n{}", "え".repeat(100), "😀".repeat(29_899)));
  assert_eq!(cut.truncated_from, Some(40_101));

  // 上限ちょうどは切らない
  let cut = truncate("あ".repeat(SAMPLE_MAX_CHARS));
  assert_eq!((cut.chars, cut.truncated_from), (SAMPLE_MAX_CHARS, None));

  // ファイルからも
  let dir = TempDir::new("truncate");
  let paragraph = format!("{}\n\n", "お".repeat(999));
  let path = dir.write("長い.md", paragraph.repeat(40).as_bytes());
  let sample = extract(&path).unwrap();
  // 1 段落 1,001 字（本文 999 字＋空行）。40 段落の末尾の空行は trim で落ちる。
  // 30,000 字目は 30 段落目の途中なので、29 段落目の後の改行で切る
  assert_eq!(sample.truncated_from, Some(1_001 * 40 - 2));
  assert_eq!(sample.chars, 1_001 * 28 + 999);
  assert!(sample.text.ends_with('お'));
}

// ---------------------------------------------------------------------------
// .docx

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

fn docx(entries: &[(&str, &str)]) -> Vec<u8> {
  let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
  let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
  for (name, body) in entries {
    writer.start_file(*name, options).unwrap();
    writer.write_all(body.as_bytes()).unwrap();
  }
  writer.finish().unwrap().into_inner()
}

fn styles_xml() -> String {
  format!(
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="{W}">
  <w:docDefaults><w:rPrDefault><w:rPr><w:b/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="2"><w:name w:val="Heading 2"/><w:basedOn w:val="a"/></w:style>
  <w:style w:type="paragraph" w:styleId="a3"><w:name w:val="Title"/><w:basedOn w:val="a"/></w:style>
  <w:style w:type="paragraph" w:styleId="a5"><w:name w:val="List Paragraph"/><w:basedOn w:val="a"/></w:style>
  <w:style w:type="paragraph" w:styleId="chapter"><w:name w:val="章の見出し"/><w:basedOn w:val="a"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="mychapter"><w:name w:val="章の見出し（社内）"/><w:basedOn w:val="chapter"/></w:style>
  <w:style w:type="character" w:styleId="a6"><w:name w:val="Strong"/><w:rPr><w:b/><w:bCs/></w:rPr></w:style>
</w:styles>"#
  )
}

fn document_xml(body: &str) -> String {
  format!(
    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="{W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml" mc:Ignorable="wps"><w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>"#
  )
}

fn p(inner: &str) -> String {
  format!("<w:p>{inner}</w:p>")
}

fn run(text: &str) -> String {
  format!(r#"<w:r><w:t xml:space="preserve">{text}</w:t></w:r>"#)
}

fn bold_run(val: &str, text: &str) -> String {
  format!(r#"<w:r><w:rPr><w:rFonts w:hint="eastAsia"/><w:b{val}/></w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>"#)
}

fn styled(style: &str, inner: &str) -> String {
  p(&format!(r#"<w:pPr><w:pStyle w:val="{style}"/></w:pPr>{inner}"#))
}

fn item(ilvl: u8, inner: &str) -> String {
  p(&format!(
    r#"<w:pPr><w:pStyle w:val="a5"/><w:numPr><w:ilvl w:val="{ilvl}"/><w:numId w:val="1"/></w:numPr><w:rPr><w:b/></w:rPr></w:pPr>{inner}"#
  ))
}

#[test]
fn docx_headings_lists_bold_tables_and_text_boxes_become_markdown() {
  let body = [
    // Title（太字は見出しでは囲まない）
    styled("a3", &bold_run("", "運営会議の記録")),
    // 日本語の Word: styleId "1"・name "heading 1"
    styled("1", &run("はじめに")),
    p(&[
      run("今日は "),
      bold_run("", "大事な"),
      bold_run(r#" w:val="1""#, "お知らせ"),
      run("があります。"),
      bold_run("", "  "),
      bold_run(r#" w:val="0""#, "A&amp;B&#x2192;C"),
    ]
    .concat()),
    "<w:p/>".to_string(),
    p(r#"<w:pPr><w:pStyle w:val="a"/></w:pPr><w:r><w:t xml:space="preserve">   </w:t></w:r>"#),
    styled("2", &run("議題")),
    item(0, &run("予算")),
    item(1, &[run("備品"), r#"<w:r><w:tab/><w:t>3 件</w:t></w:r>"#.to_string()].concat()),
    item(
      0,
      &[
        run("日程"),
        r#"<w:del w:id="1" w:author="a"><w:r><w:delText>削除した</w:delText></w:r></w:del>"#.to_string(),
        r#"<w:moveFrom w:id="3" w:author="a"><w:r><w:t>移動元</w:t></w:r></w:moveFrom>"#.to_string(),
        r#"<w:ins w:id="2" w:author="a"><w:r><w:t>（追加）</w:t></w:r></w:ins>"#.to_string(),
      ]
      .concat(),
    ),
    styled("chapter", &run("表")),
    format!(
      "<w:tbl><w:tblPr/><w:tr><w:tc>{}</w:tc><w:tc>{}</w:tc></w:tr></w:tbl>",
      p(&run("項目")),
      p(&bold_run("", "金額"))
    ),
    p(&[
      run("図の前"),
      format!(
        r#"<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent>{}</w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>{}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>"#,
        p(&run("枠の中")),
        p(&run("古い枠"))
      ),
      run("図の後"),
      r#"<w:r><w:br/><w:t>次の行</w:t></w:r>"#.to_string(),
    ]
    .concat()),
    p(&format!(
      r#"<w:pPr><w:outlineLvl w:val="1"/></w:pPr>{}"#,
      run("段落の見出し")
    )),
    styled("mychapter", &run("基づくスタイルの見出し")),
    p(&[
      r#"<w:hyperlink r:id="rId5"><w:r><w:rPr><w:rStyle w:val="a6"/></w:rPr><w:t>強調</w:t></w:r></w:hyperlink>"#.to_string(),
      run("と"),
      r#"<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>"#.to_string(),
      run("1"),
      r#"<w:r><w:fldChar w:fldCharType="end"/></w:r>"#.to_string(),
    ]
    .concat()),
    format!(
      r#"<w:sdt><w:sdtPr><w:alias w:val="欄"/></w:sdtPr><w:sdtContent>{}</w:sdtContent></w:sdt>"#,
      p(&run("おわり"))
    ),
  ]
  .concat();
  let bytes = docx(&[
    ("[Content_Types].xml", "<Types/>"),
    ("word/styles.xml", &styles_xml()),
    ("word/document.xml", &document_xml(&body)),
  ]);
  let expected = "# 運営会議の記録

# はじめに

今日は **大事なお知らせ**があります。  A&B→C

## 議題

- 予算
  - 備品\t3 件
- 日程（追加）

### 表

項目

**金額**

枠の中

図の前図の後
次の行

## 段落の見出し

### 基づくスタイルの見出し

**強調**と1

おわり";
  assert_eq!(docx_markdown(&bytes).unwrap(), expected);

  // ファイルからも（正規化・字数まで）
  let dir = TempDir::new("docx");
  let sample = extract(&dir.write("記録.DOCX", &bytes)).unwrap();
  assert_eq!(sample.text, expected);
  assert_eq!(sample.chars, expected.chars().count());
}

#[test]
fn docx_without_styles_still_reads_outline_levels_and_lists() {
  let body = [
    p(&format!(
      r#"<w:pPr><w:outlineLvl w:val="7"/></w:pPr>{}"#,
      run("深い見出し")
    )),
    p(&format!(
      r#"<w:pPr><w:outlineLvl w:val="9"/></w:pPr>{}"#,
      run("本文の段")
    )),
    p(&format!(
      r#"<w:pPr><w:pStyle w:val="1"/></w:pPr>{}"#,
      run("スタイルの無い見出し")
    )),
    p(&format!(
      r#"<w:pPr><w:numPr><w:ilvl w:val="2"/><w:numId w:val="4"/></w:numPr></w:pPr>{}"#,
      run("三段目")
    )),
    p(&format!(
      r#"<w:pPr><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr>{}"#,
      run("番号を外した段落")
    )),
  ]
  .concat();
  let bytes = docx(&[("word/document.xml", &document_xml(&body))]);
  assert_eq!(
    docx_markdown(&bytes).unwrap(),
    "###### 深い見出し\n\n本文の段\n\nスタイルの無い見出し\n\n    - 三段目\n\n番号を外した段落"
  );
}

#[test]
fn broken_or_protected_docx_is_refused() {
  let dir = TempDir::new("docx-broken");
  // zip ではない
  assert_eq!(
    extract(&dir.write("壊れた.docx", b"PK\x03\x04 not really a zip")),
    Err(UNREADABLE)
  );
  // 古い .doc の改名・パスワード付き（OLE の複合文書）
  let mut ole = OLE_MAGIC.to_vec();
  ole.extend_from_slice(&[0xA1, 0xB1, 0x1A, 0xE1, 0, 0, 0, 0]);
  assert_eq!(extract(&dir.write("古い.docx", &ole)), Err(PROTECTED));
  // word/document.xml が無い
  assert_eq!(
    docx_markdown(&docx(&[("word/styles.xml", &styles_xml())])),
    Err(UNREADABLE)
  );
  // XML が壊れている（閉じ方が違う・途中で切れている・空）
  for broken in [
    document_xml(&p("<w:r><w:t>途中</w:r></w:t>")),
    format!(r#"<w:document xmlns:w="{W}"><w:body><w:p><w:r><w:t>途中"#),
    String::new(),
  ] {
    assert_eq!(
      docx_markdown(&docx(&[("word/document.xml", &broken)])),
      Err(UNREADABLE),
      "{broken}"
    );
  }
  // 壊れた styles.xml は無いものとして読む
  assert_eq!(
    docx_markdown(&docx(&[
      ("word/styles.xml", "<w:styles"),
      ("word/document.xml", &document_xml(&styled("1", &run("見出し")))),
    ])),
    Ok("見出し".to_string())
  );
  // 文字の無い文書
  assert_eq!(
    extract(&dir.write(
      "空.docx",
      &docx(&[(
        "word/document.xml",
        &document_xml("<w:p/><w:p><w:r><w:t> </w:t></w:r></w:p>")
      )])
    )),
    Err(NO_TEXT)
  );
}

// ---------------------------------------------------------------------------
// .pdf

const CUPSFILTER: &str = "/usr/sbin/cupsfilter";

/// cupsfilter で文字の PDF を作る（無い環境では None）。
fn text_pdf(dir: &TempDir, name: &str, text: &str) -> Option<PathBuf> {
  if !Path::new(CUPSFILTER).exists() || !Path::new(OSASCRIPT).exists() {
    eprintln!("skip: {CUPSFILTER} か {OSASCRIPT} が無いので PDF の取り込みを確かめられない");
    return None;
  }
  let input = dir.write(&format!("{name}.txt"), text.as_bytes());
  let output = Command::new(CUPSFILTER)
    .args(["-i", "text/plain", "-m", "application/pdf"])
    .arg(&input)
    .stderr(Stdio::null())
    .output()
    .unwrap();
  if !output.status.success() || !output.stdout.starts_with(b"%PDF") {
    eprintln!("skip: cupsfilter が PDF を作れなかった（{:?}）", output.status.code());
    return None;
  }
  Some(dir.write(&format!("{name}.pdf"), &output.stdout))
}

#[test]
fn pdf_text_is_read_with_pdfkit() {
  let dir = TempDir::new("pdf");
  let Some(path) = text_pdf(&dir, "議事録", "議事録の見出し\n\n本文の一行目です。ABC 123\n") else {
    return;
  };
  let sample = extract(&path).unwrap();
  assert!(sample.text.contains("議事録の見出し"), "{:?}", sample.text);
  assert!(sample.text.contains("本文の一行目です。ABC 123"), "{:?}", sample.text);
  assert_eq!(sample.truncated_from, None);

  // 文字の無い PDF（空のテキストから作った白紙）
  let blank = text_pdf(&dir, "白紙", "").unwrap();
  assert_eq!(extract(&blank), Err(NO_TEXT_PDF));
  // PDF ではない
  assert_eq!(extract(&dir.write("壊れた.PDF", b"not a pdf")), Err(UNREADABLE));
}

#[test]
fn pdf_markers_and_child_failures_are_mapped() {
  assert_eq!(pdf_output(b"\0locked\n"), Err(LOCKED));
  assert_eq!(pdf_output(b"\0open\n"), Err(UNREADABLE));
  assert_eq!(
    pdf_output("一頁\n\n二頁\n".as_bytes()),
    Ok("一頁\n\n二頁\n".to_string())
  );
  // osascript が無い・時間切れ（子プロセスはグループごと止める）
  let dir = TempDir::new("pdf-child");
  let pdf = dir.write("a.pdf", b"%PDF-1.4");
  assert_eq!(
    pdf_text_with(Path::new("/nonexistent/osascript"), &pdf, PDF_TIME_LIMIT),
    Err(UNREADABLE)
  );
  let started = Instant::now();
  let slow = run_child(
    Path::new("/bin/sleep"),
    &["30".to_string()],
    None,
    Duration::from_millis(200),
  );
  assert_eq!(slow.err(), Some(ChildFailure::TimedOut));
  assert!(started.elapsed() < Duration::from_secs(5));
}
