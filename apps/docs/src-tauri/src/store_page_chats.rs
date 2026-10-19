//! 文書ページの会話の置き場（`page-chats/<pageId>/`）と、ページの直後に空の文書を作る保存。
//! 名前の完全一致で新しい文書を作っていた旧経路（派生文書）は、「AIと作る」の composer（#18722）に統合した。
use super::{validate_id, write_atomic, Result, Store, StoreError, WRITE_LOCK};
use serde_json::{json, Value};
use std::{borrow::Cow, collections::HashSet, fs};

#[cfg(test)]
mod tests {
  use super::*;

  fn fixture() -> (Store, std::path::PathBuf, String, String) {
    let root = std::env::temp_dir().join(format!(
      "niho-page-chats-{}",
      crate::process::hex(&crate::process::random_bytes::<8>().unwrap())
    ));
    let store = Store::new(root.clone());
    let project = store
      .create_project(
        &json!({"id":"", "name":"文書", "createdAt":"", "version":1,
          "flowSnapshot":{"steps":[{"id":"article","name":"記事案A","instruction":"","input":{"kind":"previous"},"profile":"standard"}]},
          "source":{"kind":"text"}}),
        None,
        None,
        &[],
      )
      .unwrap();
    let id = project["id"].as_str().unwrap().to_string();
    let pages = store.load_pages(Some(&id)).unwrap().pages;
    let page_id = pages[0]["id"].as_str().unwrap().to_string();
    (store, root, id, page_id)
  }

  #[test]
  fn empty_document_can_be_inserted_after_recording() {
    let (store, root, id, recording_page) = fixture();
    let last = store.create_page(&id, "doc", "末尾", "", None).unwrap();
    let page = store
      .create_document_after_at(Some(&id), &recording_page, "", "now")
      .unwrap();
    let pages = Store::page_list(&store.read_project(&id).unwrap());
    assert_eq!(pages[1], page);
    assert_eq!(pages[2], last);
    assert!(store.create_document_after_at(Some(&id), "missing", "", "").is_err());
    // 文書ページの直後にも作れる（composer が作った文書を並べる）。実行ロック中でも止まらない
    store.acquire_run_lock(&id).unwrap();
    let after_doc = store
      .create_document_after_at(Some(&id), page["id"].as_str().unwrap(), "", "now")
      .unwrap();
    store.release_run_lock(&id).unwrap();
    let pages = Store::page_list(&store.read_project(&id).unwrap());
    assert_eq!(pages[2], after_doc);
    assert_eq!(pages[3], last);
    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn document_chats_live_in_page_chats_and_recordings_in_their_folder() {
    let (store, root, id, recording_page) = fixture();
    let doc = store.create_page(&id, "doc", "メモ", "", None).unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    let doc_parts = store.chat_parts_at(Some(&id), &doc).unwrap();
    assert_eq!(doc_parts.last().map(|part| part.as_ref()), Some(doc.as_str()));
    assert!(doc_parts.iter().any(|part| part.as_ref() == "page-chats"));
    let rec_parts = store.chat_parts_at(Some(&id), &recording_page).unwrap();
    assert!(!rec_parts.iter().any(|part| part.as_ref() == "page-chats"));
    let _ = fs::remove_dir_all(root);
  }
}

impl Store {
  /// ページ（録音か文書）の直後に空文書を作る。録音IDとは別のページIDで位置を決める。台帳の更新は一度だけで、
  /// 実行ロックを見ないので、依頼の完了処理（ロック保持中）に AI が作った文書を並べるのにも使う。
  pub fn create_document_after_at(
    &self,
    project_id: Option<&str>,
    after_page_id: &str,
    title: &str,
    created_at: &str,
  ) -> Result<Value> {
    validate_id(after_page_id)?;
    self.migrate_page_owner_at(project_id)?;
    let _guard = WRITE_LOCK.lock();
    let mut owner = self.read_page_owner(project_id)?;
    let mut pages = Self::page_list(&owner);
    let index = pages
      .iter()
      .position(|page| {
        Self::page_field(page, "id") == Some(after_page_id)
          && matches!(Self::page_field(page, "kind"), Some("rec") | Some("doc"))
      })
      .ok_or_else(StoreError::no_page)?;
    let mut used = pages
      .iter()
      .filter_map(Self::page_id)
      .map(str::to_string)
      .collect::<HashSet<_>>();
    let id = self.fresh_global_id(&mut used);
    let base = self.page_space_parts(project_id)?;
    let file = self.under(&base, &["pages", &format!("{id}.md")])?;
    let entry = json!({"id": id, "kind":"doc", "title": title, "createdAt": created_at});
    write_atomic(&file, b"")?;
    pages.insert(index + 1, entry.clone());
    if let Err(error) = self.write_pages_at(project_id, &mut owner, pages) {
      let _ = fs::remove_file(file);
      return Err(error);
    }
    Ok(entry)
  }

  /// 会話の置き場: 文書ページは `page-chats/<pageId>/`、録音ページはその録音のフォルダ。
  pub(super) fn chat_parts_at<'a>(&self, project_id: Option<&'a str>, page_id: &'a str) -> Result<Vec<Cow<'a, str>>> {
    let owner = self.read_page_owner(project_id)?;
    if Self::page_list(&owner)
      .iter()
      .any(|page| Self::page_field(page, "id") == Some(page_id) && Self::page_field(page, "kind") == Some("doc"))
    {
      self.doc_file_at(project_id, page_id)?;
      let mut parts = self
        .page_space_parts(project_id)?
        .into_iter()
        .map(Cow::Borrowed)
        .collect::<Vec<_>>();
      parts.extend([Cow::Borrowed("page-chats"), Cow::Borrowed(page_id)]);
      Ok(parts)
    } else {
      self.recording_parts_at(project_id, page_id)
    }
  }

  pub(super) fn chat_file_at(
    &self,
    project_id: Option<&str>,
    page_id: &str,
    parts: &[&str],
  ) -> Result<std::path::PathBuf> {
    self.under(&self.chat_parts_at(project_id, page_id)?, parts)
  }
}
