//! 修正の会話の道具（S5 #18386）: 隔離 workspace（[`FolderTools::dir`]）の中のファイルを読む・直す。3 社とも同じ名前・
//! 同じ意味で、JSON schema だけ各社の形で渡す（providers.rs）。
//!
//! - `list_files` {} → `dir` の下の普通のファイルの相対パスと大きさ（`.` で始まる名前・リンクは出さない）。
//! - `read_file` {path} → UTF-8 の本文（30 万字で切り、切ったことを添える）。
//! - `edit_file` {path, old_text, new_text} → ちょうど 1 か所を置き換える（0 か所・2 か所以上はエラー）。
//! - `write_file` {path, content} → 作るか上書き。
//! - パスは `dir` からの相対だけ。絶対パス・`..`・空・NUL・`.` で始まる部分・途中のどこかがリンク（部品ごとに
//!   `symlink_metadata`）を断る。書くのは `writable` のどれかの下の `.md` だけで、一時ファイル＋rename で書く（最後の部分が
//!   リンクでもたどらない）。
//! - 失敗は致命にせず、エラーの結果としてモデルに返す。文にフォルダの絶対パスを出さない（相対パスだけ）。

use crate::types::FolderTools;
use serde_json::{json, Map, Value};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub(crate) const LIST_FILES: &str = "list_files";
pub(crate) const READ_FILE: &str = "read_file";
pub(crate) const EDIT_FILE: &str = "edit_file";
pub(crate) const WRITE_FILE: &str = "write_file";

/// read_file で返す上限（字）。
const READ_MAX_CHARS: usize = 300_000;
/// edit_file で読むファイルの上限（バイト）。
const EDIT_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// list_files で返す上限（件）と、たどる深さ。
const LIST_MAX_FILES: usize = 2_000;
const LIST_MAX_DEPTH: usize = 12;
/// 画面に出すファイル名の上限（字）。
const SUMMARY_MAX_CHARS: usize = 120;
/// エラーの文に入れるパスの上限（字）。
const SHOWN_PATH_MAX_CHARS: usize = 200;

/// 道具の定義（名前・説明・引数。引数はどれも文字列で必須）。
pub(crate) struct ToolSpec {
  pub name: &'static str,
  pub description: String,
  pub params: Vec<(&'static str, &'static str)>,
}

impl ToolSpec {
  /// JSON schema（object・引数はどれも string で必須・ほかの名前は受けない）。Gemini は `additionalProperties` を付けない。
  pub fn schema(&self, closed: bool) -> Value {
    let mut properties = Map::new();
    for (name, description) in &self.params {
      properties.insert(
        (*name).to_string(),
        json!({ "type": "string", "description": description }),
      );
    }
    let required: Vec<&str> = self.params.iter().map(|(name, _)| *name).collect();
    let mut schema = json!({ "type": "object", "properties": properties, "required": required });
    if closed {
      schema["additionalProperties"] = json!(false);
    }
    schema
  }
}

fn writable_label(writable: &[String]) -> String {
  let names: Vec<String> = writable
    .iter()
    .map(|dir| format!("{}/", dir.trim_end_matches('/')))
    .collect();
  if names.is_empty() {
    "（書ける場所はありません）".into()
  } else {
    names.join("・")
  }
}

/// 4 つの道具（並びと文は会話の間で変えない。Anthropic は tools を含めて前の発言と同じであることを確かめる）。
pub(crate) fn specs(writable: &[String]) -> Vec<ToolSpec> {
  let place = writable_label(writable);
  let path = ("path", "作業フォルダからの相対パス（例 artifacts/abc12345.md）");
  vec![
    ToolSpec {
      name: LIST_FILES,
      description: "作業フォルダの中のファイルの一覧（作業フォルダからの相対パスと大きさ）を返す。".into(),
      params: vec![],
    },
    ToolSpec {
      name: READ_FILE,
      description: format!(
        "作業フォルダの中のファイルを 1 つ読み、UTF-8 の本文を返す。長いファイルは先頭の {READ_MAX_CHARS} 字までを返す。"
      ),
      params: vec![path],
    },
    ToolSpec {
      name: EDIT_FILE,
      description: format!(
        "ファイルの中の old_text とちょうど一致する 1 か所を new_text に置き換える。old_text は本文と空白・改行まで同じにし、\
         1 か所に決まるよう前後の文も含める。書けるのは {place} の下の .md ファイルだけ。"
      ),
      params: vec![
        path,
        (
          "old_text",
          "置き換える元の文（本文とちょうど同じ。ファイルの中で 1 か所だけにあること）",
        ),
        ("new_text", "置き換えた後の文"),
      ],
    },
    ToolSpec {
      name: WRITE_FILE,
      description: format!(
        "ファイルを作るか、本文の全体を content で置き換える。一部だけ直すときは edit_file を使う。書けるのは {place} の下の \
         .md ファイルだけ。"
      ),
      params: vec![path, ("content", "ファイルの本文の全体（UTF-8）")],
    },
  ]
}

/// モデルが頼んだ 1 回の呼び出し。`id` はイベントの組（Anthropic の tool_use の id・OpenAI の call_id。Gemini は返った id
/// か、こちらで振った id）、`native_id` は Gemini の functionCall の id（返ったときだけ。結果に添える）。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ToolCall {
  pub id: String,
  pub name: String,
  /// 引数（読めなければ Null。道具がエラーの結果を返す）。
  pub input: Value,
  pub native_id: Option<String>,
}

/// 道具の結果（モデルへ返す文）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Outcome {
  pub ok: bool,
  pub text: String,
}

/// 画面の名前（local-ai の Claude Code の道具と同じ）。知らない名前は制御文字を除いて 64 字まで。
pub(crate) fn display_name(name: &str) -> String {
  match name {
    LIST_FILES => "Glob".into(),
    READ_FILE => "Read".into(),
    EDIT_FILE => "Edit".into(),
    WRITE_FILE => "Write".into(),
    other => other.chars().filter(|ch| !ch.is_control()).take(64).collect(),
  }
}

/// 画面に出してよいファイル名（パスの最後の部分）だけ。list_files・知らない道具は空。
pub(crate) fn summary(name: &str, input: &Value) -> String {
  match name {
    READ_FILE | EDIT_FILE | WRITE_FILE => input
      .get("path")
      .and_then(Value::as_str)
      .map(file_name_only)
      .unwrap_or_default(),
    _ => String::new(),
  }
}

fn file_name_only(path: &str) -> String {
  let name = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
  name
    .chars()
    .filter(|ch| !ch.is_control())
    .take(SUMMARY_MAX_CHARS)
    .collect()
}

/// 1 回実行する（失敗もモデルへ返す結果にする）。
pub(crate) fn run(tools: &FolderTools, call: &ToolCall) -> Outcome {
  let result = match call.name.as_str() {
    LIST_FILES => list_files(tools),
    READ_FILE => arg(&call.input, "path").and_then(|path| read_file(tools, path)),
    EDIT_FILE => arg(&call.input, "path").and_then(|path| {
      let old_text = arg(&call.input, "old_text")?;
      let new_text = arg(&call.input, "new_text")?;
      edit_file(tools, path, old_text, new_text)
    }),
    WRITE_FILE => arg(&call.input, "path").and_then(|path| write_file(tools, path, arg(&call.input, "content")?)),
    other => Err(format!(
      "{} という道具はありません。使えるのは list_files・read_file・edit_file・write_file です。",
      display_name(other)
    )),
  };
  match result {
    Ok(text) => Outcome { ok: true, text },
    Err(text) => Outcome { ok: false, text },
  }
}

fn arg<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
  if !input.is_object() {
    return Err("道具の入力（JSON）を読めませんでした。引数を JSON の object で渡してください。".into());
  }
  input
    .get(key)
    .and_then(Value::as_str)
    .ok_or_else(|| format!("入力に {key}（文字列）がありません。"))
}

/// エラーの文に入れるパス（モデルが渡した相対パス。制御文字を除いて短くする）。
fn shown(path: &str) -> String {
  path
    .chars()
    .filter(|ch| !ch.is_control())
    .take(SHOWN_PATH_MAX_CHARS)
    .collect()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
  Read,
  Write,
}

/// 相対パスを確かめて、`dir` の下の実際のパスにする。途中の部品はどれもリンクでないフォルダ、最後の部品はリンクでない
/// 普通のファイル（書くときは無くてもよい）。
fn resolve(tools: &FolderTools, path: &str, access: Access) -> Result<PathBuf, String> {
  let shown = shown(path);
  if path.trim().is_empty() || path.contains('\0') {
    return Err("path が空か、使えない文字を含みます。作業フォルダからの相対パスで指定してください。".into());
  }
  let relative = Path::new(path);
  if relative.has_root() || relative.is_absolute() {
    return Err(
      "絶対パスは使えません。作業フォルダからの相対パス（例 artifacts/abc12345.md）で指定してください。".into(),
    );
  }
  let mut parts: Vec<&str> = Vec::new();
  for component in relative.components() {
    match component {
      Component::CurDir => {}
      Component::Normal(part) => {
        let part = part
          .to_str()
          .ok_or_else(|| format!("{shown} は使えない文字を含みます。"))?;
        if part.starts_with('.') {
          return Err(format!("{shown} は「.」で始まる名前を含むため使えません。"));
        }
        parts.push(part);
      }
      Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
        return Err(format!(
          "{shown} は作業フォルダの外を指すため使えません。作業フォルダからの相対パスで指定してください。"
        ));
      }
    }
  }
  if parts.is_empty() {
    return Err("path がファイルを指していません。作業フォルダからの相対パスで指定してください。".into());
  }
  if access == Access::Write {
    let place = writable_label(&tools.writable);
    let name = parts[parts.len() - 1];
    let is_md = name.len() > 3
      && name
        .get(name.len() - 3..)
        .is_some_and(|ext| ext.eq_ignore_ascii_case(".md"));
    let inside = tools.writable.iter().any(|dir| {
      let base: Vec<&str> = Path::new(dir)
        .components()
        .filter_map(|component| match component {
          Component::Normal(part) => part.to_str(),
          _ => None,
        })
        .collect();
      !base.is_empty() && parts.len() > base.len() && parts[..base.len()] == base[..]
    });
    if !inside || !is_md {
      return Err(format!(
        "{shown} には書けません。書けるのは {place} の下の .md ファイルだけです。"
      ));
    }
  }
  let mut current = tools.dir.clone();
  let last = parts.len() - 1;
  for (index, part) in parts.iter().enumerate() {
    current.push(part);
    match std::fs::symlink_metadata(&current) {
      Ok(meta) if meta.file_type().is_symlink() => {
        return Err(format!("{shown} はリンクを通るため使えません。"));
      }
      Ok(meta) if index < last && !meta.is_dir() => {
        return Err(format!("{shown} が見つかりません。list_files で確かめてください。"));
      }
      Ok(meta) if index == last && !meta.is_file() => {
        return Err(format!(
          "{shown} はファイルではありません。list_files で確かめてください。"
        ));
      }
      Ok(_) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
        if access == Access::Write && index == last {
          break;
        }
        return Err(if access == Access::Write {
          format!("{shown} を書くフォルダがありません。list_files で確かめてください。")
        } else {
          format!("{shown} が見つかりません。list_files で確かめてください。")
        });
      }
      Err(_) => return Err(format!("{shown} を確かめられませんでした。")),
    }
  }
  Ok(current)
}

fn list_files(tools: &FolderTools) -> Result<String, String> {
  fn walk(dir: &Path, prefix: &str, depth: usize, files: &mut Vec<(String, u64)>, truncated: &mut bool) {
    let Ok(entries) = std::fs::read_dir(dir) else {
      return;
    };
    for entry in entries.flatten() {
      let name = entry.file_name();
      let Some(name) = name.to_str() else { continue };
      if name.starts_with('.') {
        continue;
      }
      // file_type はリンクをたどらない
      let Ok(kind) = entry.file_type() else { continue };
      let relative = if prefix.is_empty() {
        name.to_string()
      } else {
        format!("{prefix}/{name}")
      };
      if kind.is_dir() {
        if depth < LIST_MAX_DEPTH {
          walk(&entry.path(), &relative, depth + 1, files, truncated);
        }
      } else if kind.is_file() {
        if files.len() >= LIST_MAX_FILES {
          *truncated = true;
          return;
        }
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        files.push((relative, size));
      }
    }
  }
  if !std::fs::symlink_metadata(&tools.dir).is_ok_and(|meta| meta.is_dir()) {
    return Err("作業フォルダを読めませんでした。".into());
  }
  let mut files = Vec::new();
  let mut truncated = false;
  walk(&tools.dir, "", 0, &mut files, &mut truncated);
  files.sort();
  if files.is_empty() {
    return Ok("ファイルはありません。".into());
  }
  let mut lines: Vec<String> = files
    .iter()
    .map(|(path, size)| format!("{path}（{size} バイト）"))
    .collect();
  if truncated {
    lines.push(format!("（多いため、{LIST_MAX_FILES} 件までを出しました）"));
  }
  Ok(lines.join("\n"))
}

fn read_file(tools: &FolderTools, path: &str) -> Result<String, String> {
  let target = resolve(tools, path, Access::Read)?;
  let shown = shown(path);
  let unreadable = || format!("{shown} を読めませんでした。");
  let file = std::fs::File::open(&target).map_err(|_| unreadable())?;
  let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
  // 1 字は UTF-8 で 4 バイトまで
  let limit = (READ_MAX_CHARS as u64) * 4;
  let mut bytes = Vec::new();
  file.take(limit).read_to_end(&mut bytes).map_err(|_| unreadable())?;
  let mut cut = size > bytes.len() as u64;
  let text = match String::from_utf8(bytes) {
    Ok(text) => text,
    // 上限で文字の途中を切ったときは、そこまでを使う
    Err(error) if cut && error.utf8_error().error_len().is_none() => {
      let valid = error.utf8_error().valid_up_to();
      let mut bytes = error.into_bytes();
      bytes.truncate(valid);
      String::from_utf8(bytes).map_err(|_| unreadable())?
    }
    Err(_) => return Err(format!("{shown} は UTF-8 の文字ではないため読めません。")),
  };
  let mut text = text;
  if let Some((index, _)) = text.char_indices().nth(READ_MAX_CHARS) {
    text.truncate(index);
    cut = true;
  }
  if cut {
    text.push_str(&format!(
      "\n\n（ファイルが長いため、先頭の {READ_MAX_CHARS} 字までを返しました。全体は {size} バイトです）"
    ));
  }
  Ok(text)
}

/// 一時ファイルに書いてから置き換える（最後の部分がリンクでもたどらず、そのリンクを置き換える）。
fn write_atomic(target: &Path, content: &str) -> std::io::Result<()> {
  use std::io::Write;
  let parent = target.parent().ok_or_else(|| std::io::Error::other("no parent"))?;
  let name = target
    .file_name()
    .and_then(|name| name.to_str())
    .ok_or_else(|| std::io::Error::other("bad name"))?;
  let temp = parent.join(format!(".{name}.niho-docs-{}.tmp", std::process::id()));
  let _ = std::fs::remove_file(&temp);
  let result = (|| {
    // create_new はリンクをたどらない（O_EXCL）
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&temp, target)
  })();
  if result.is_err() {
    let _ = std::fs::remove_file(&temp);
  }
  result
}

fn edit_file(tools: &FolderTools, path: &str, old_text: &str, new_text: &str) -> Result<String, String> {
  let target = resolve(tools, path, Access::Write)?;
  let shown = shown(path);
  if old_text.is_empty() {
    return Err("old_text が空です。置き換える元の文を、本文とちょうど同じ文字で指定してください。".into());
  }
  let size = std::fs::symlink_metadata(&target)
    .map_err(|_| format!("{shown} が見つかりません。新しく作るときは write_file を使ってください。"))?
    .len();
  if size > EDIT_MAX_BYTES {
    return Err(format!("{shown} は大きすぎるため直せません。"));
  }
  let bytes = std::fs::read(&target).map_err(|_| format!("{shown} を読めませんでした。"))?;
  let text = String::from_utf8(bytes).map_err(|_| format!("{shown} は UTF-8 の文字ではないため直せません。"))?;
  let count = text.match_indices(old_text).count();
  match count {
    0 => {
      return Err(format!(
        "{shown} に old_text と同じ文がありません。read_file で読み直し、空白・改行まで本文と同じ文で指定してください。"
      ))
    }
    1 => {}
    many => {
      return Err(format!(
        "{shown} に old_text と同じ文が {many} か所あります。前後の文も含めて、1 か所に決まるようにしてください。"
      ))
    }
  }
  let replaced = text.replacen(old_text, new_text, 1);
  write_atomic(&target, &replaced).map_err(|_| format!("{shown} を書けませんでした。"))?;
  Ok(format!("{shown} の 1 か所を置き換えました。"))
}

fn write_file(tools: &FolderTools, path: &str, content: &str) -> Result<String, String> {
  let target = resolve(tools, path, Access::Write)?;
  let shown = shown(path);
  let existed = target.exists();
  write_atomic(&target, content).map_err(|_| format!("{shown} を書けませんでした。"))?;
  let chars = content.chars().count();
  Ok(if existed {
    format!("{shown} を書き直しました（{chars} 字）。")
  } else {
    format!("{shown} を作りました（{chars} 字）。")
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn folder(name: &str) -> FolderTools {
    let dir = std::env::temp_dir().join(format!("niho-api-ai-tools-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("artifacts")).unwrap();
    FolderTools {
      dir,
      writable: vec!["artifacts".into()],
    }
  }

  fn call(name: &str, input: Value) -> ToolCall {
    ToolCall {
      id: "t1".into(),
      name: name.into(),
      input,
      native_id: None,
    }
  }

  #[test]
  fn files_are_listed_read_edited_and_written_inside_the_folder() {
    let tools = folder("basic");
    std::fs::write(tools.dir.join("artifacts/a.md"), "# 見出し\n本文").unwrap();
    std::fs::create_dir_all(tools.dir.join(".git")).unwrap();
    std::fs::write(tools.dir.join(".git/config"), "x").unwrap();
    std::fs::write(tools.dir.join(".hidden.md"), "x").unwrap();
    let listed = run(&tools, &call(LIST_FILES, json!({})));
    assert_eq!(
      listed,
      Outcome {
        ok: true,
        text: "artifacts/a.md（18 バイト）".into()
      }
    );
    assert_eq!(
      run(&tools, &call(READ_FILE, json!({ "path": "./artifacts/a.md" }))).text,
      "# 見出し\n本文"
    );
    let edited = run(
      &tools,
      &call(
        EDIT_FILE,
        json!({ "path": "artifacts/a.md", "old_text": "見出し", "new_text": "新しい見出し" }),
      ),
    );
    assert!(edited.ok, "{edited:?}");
    assert_eq!(
      std::fs::read_to_string(tools.dir.join("artifacts/a.md")).unwrap(),
      "# 新しい見出し\n本文"
    );
    let written = run(
      &tools,
      &call(WRITE_FILE, json!({ "path": "artifacts/b.md", "content": "新しい文書" })),
    );
    assert_eq!(written.text, "artifacts/b.md を作りました（5 字）。");
    assert_eq!(
      std::fs::read_to_string(tools.dir.join("artifacts/b.md")).unwrap(),
      "新しい文書"
    );
    // 一時ファイルは残らない
    assert_eq!(std::fs::read_dir(tools.dir.join("artifacts")).unwrap().count(), 2);
    let _ = std::fs::remove_dir_all(&tools.dir);
  }

  #[test]
  fn edits_need_exactly_one_match() {
    let tools = folder("edit");
    std::fs::write(tools.dir.join("artifacts/a.md"), "同じ。同じ。").unwrap();
    let twice = run(
      &tools,
      &call(
        EDIT_FILE,
        json!({ "path": "artifacts/a.md", "old_text": "同じ。", "new_text": "x" }),
      ),
    );
    assert!(!twice.ok);
    assert!(twice.text.contains("2 か所"), "{}", twice.text);
    let none = run(
      &tools,
      &call(
        EDIT_FILE,
        json!({ "path": "artifacts/a.md", "old_text": "無い", "new_text": "x" }),
      ),
    );
    assert!(!none.ok && none.text.contains("同じ文がありません"));
    let missing = run(&tools, &call(EDIT_FILE, json!({ "path": "artifacts/a.md" })));
    assert_eq!(missing.text, "入力に old_text（文字列）がありません。");
    assert!(!run(&tools, &call(EDIT_FILE, Value::Null)).ok);
    assert_eq!(
      std::fs::read_to_string(tools.dir.join("artifacts/a.md")).unwrap(),
      "同じ。同じ。"
    );
    let _ = std::fs::remove_dir_all(&tools.dir);
  }

  #[test]
  fn paths_outside_links_and_non_markdown_writes_are_refused() {
    let tools = folder("paths");
    let outside = tools.dir.with_extension("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.md"), "外の秘密").unwrap();
    std::fs::write(tools.dir.join("notes.md"), "上").unwrap();
    #[cfg(unix)]
    {
      std::os::unix::fs::symlink(&outside, tools.dir.join("artifacts/linked")).unwrap();
      std::os::unix::fs::symlink(outside.join("secret.md"), tools.dir.join("artifacts/alias.md")).unwrap();
    }
    let dir_text = tools.dir.to_string_lossy().to_string();
    let absolute = outside.join("secret.md").to_string_lossy().to_string();
    for (name, input) in [
      (READ_FILE, json!({ "path": "../x.md" })),
      (READ_FILE, json!({ "path": absolute })),
      (READ_FILE, json!({ "path": "" })),
      (READ_FILE, json!({ "path": "artifacts/a\u{0}.md" })),
      (READ_FILE, json!({ "path": "artifacts/linked/secret.md" })),
      (READ_FILE, json!({ "path": "artifacts/alias.md" })),
      (READ_FILE, json!({ "path": "artifacts" })),
      (READ_FILE, json!({ "path": ".git/config" })),
      (WRITE_FILE, json!({ "path": "notes.md", "content": "x" })),
      (WRITE_FILE, json!({ "path": "artifacts/x.txt", "content": "x" })),
      (WRITE_FILE, json!({ "path": "artifacts/../notes.md", "content": "x" })),
      (WRITE_FILE, json!({ "path": "artifacts/alias.md", "content": "x" })),
      (
        WRITE_FILE,
        json!({ "path": "artifacts/linked/secret.md", "content": "x" }),
      ),
      (WRITE_FILE, json!({ "path": "artifacts/new/x.md", "content": "x" })),
      (
        EDIT_FILE,
        json!({ "path": "notes.md", "old_text": "上", "new_text": "x" }),
      ),
      ("run_shell", json!({ "command": "ls" })),
    ] {
      let outcome = run(&tools, &call(name, input.clone()));
      assert!(!outcome.ok, "{name} {input} → {outcome:?}");
      assert!(!outcome.text.contains(&dir_text), "{}", outcome.text);
      assert!(!outcome.text.contains("外の秘密"));
    }
    assert_eq!(std::fs::read_to_string(outside.join("secret.md")).unwrap(), "外の秘密");
    assert_eq!(std::fs::read_to_string(tools.dir.join("notes.md")).unwrap(), "上");
    assert!(!tools.dir.join("artifacts/x.txt").exists());
    // 一覧にリンクは出ない
    assert_eq!(run(&tools, &call(LIST_FILES, json!({}))).text, "notes.md（3 バイト）");
    let _ = std::fs::remove_dir_all(&tools.dir);
    let _ = std::fs::remove_dir_all(&outside);
  }

  #[test]
  fn long_files_are_cut_and_names_are_file_names_only() {
    let tools = folder("long");
    std::fs::write(tools.dir.join("artifacts/long.md"), "字".repeat(READ_MAX_CHARS + 10)).unwrap();
    let read = run(&tools, &call(READ_FILE, json!({ "path": "artifacts/long.md" })));
    assert!(read.ok);
    assert!(read.text.starts_with(&"字".repeat(READ_MAX_CHARS)));
    assert!(
      read.text.contains("先頭の 300000 字まで"),
      "{}",
      &read.text[read.text.len() - 200..]
    );
    assert_eq!(
      summary(READ_FILE, &json!({ "path": "artifacts/abc12345.md" })),
      "abc12345.md"
    );
    assert_eq!(summary(LIST_FILES, &json!({})), "");
    assert_eq!(display_name(EDIT_FILE), "Edit");
    assert_eq!(display_name(LIST_FILES), "Glob");
    let _ = std::fs::remove_dir_all(&tools.dir);
  }
}
