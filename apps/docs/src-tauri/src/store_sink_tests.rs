//! 保存の口（C3 #18595）を通る store の書き込み。記録する偽の口で、保存単位・版の行・変更の知らせを確かめる。
//! 口と deviceId は process 全体に効くので、入れるテストは `sink_test_lock` で 1 つずつ走らせ、偽の口は自分の root の下だけを
//! 受け取る（ほかのテストの書き込みは今までどおり）。

use super::sink::remove_plain;
use super::versions::sha256_hex;
use super::*;
use serde_json::json;
use std::sync::Arc;

fn temp_root(name: &str) -> PathBuf {
  std::env::temp_dir().canonicalize().unwrap().join(format!(
    "niho-docs-sink-{name}-{}-{}",
    std::process::id(),
    crate::process::hex(&crate::process::random_bytes::<4>().unwrap())
  ))
}

const ROOT: &str = ROOT_RECORDING_ID;
const STEP: &str = "k7m2q9xa";

/// root の下の書き込みだけを受け取り、記録してから普通に書く偽の口。
struct RecordingSink {
  root: PathBuf,
  groups: Mutex<Vec<(SinkKind, Vec<SinkWrite>)>>,
  changed: Mutex<Vec<PathBuf>>,
}

impl SaveSink for RecordingSink {
  fn save(&self, writes: &[SinkWrite], kind: SinkKind) -> Option<std::result::Result<Option<u64>, StoreError>> {
    if !writes.iter().all(|write| write.path().starts_with(&self.root)) {
      return None;
    }
    for write in writes {
      let result = match write {
        SinkWrite::Put(path, bytes) => write_plain(path, bytes),
        SinkWrite::Delete(path) => remove_plain(path),
      };
      if let Err(error) = result {
        return Some(Err(error));
      }
    }
    let mut groups = self.groups.lock().unwrap();
    groups.push((kind, writes.to_vec()));
    Some(Ok(Some(groups.len() as u64)))
  }

  fn changed(&self, paths: &[PathBuf]) {
    let mine = paths.iter().filter(|path| path.starts_with(&self.root)).cloned();
    self.changed.lock().unwrap().extend(mine);
  }
}

impl RecordingSink {
  fn last_group(&self) -> (SinkKind, Vec<SinkWrite>) {
    self.groups.lock().unwrap().last().cloned().expect("a saved group")
  }

  fn changed(&self) -> Vec<PathBuf> {
    self.changed.lock().unwrap().clone()
  }
}

/// 口と deviceId を入れている間（落ちても外す）。
struct Installed {
  sink: Arc<RecordingSink>,
  _lock: std::sync::MutexGuard<'static, ()>,
}

impl Drop for Installed {
  fn drop(&mut self) {
    set_save_sink(None);
    set_device_id(None);
  }
}

fn install(root: &Path) -> Installed {
  let lock = sink_test_lock();
  let sink = Arc::new(RecordingSink {
    root: root.to_path_buf(),
    groups: Mutex::new(Vec::new()),
    changed: Mutex::new(Vec::new()),
  });
  set_save_sink(Some(sink.clone()));
  set_device_id(Some("d_test".to_string()));
  Installed { sink, _lock: lock }
}

fn text_project(store: &Store) -> String {
  let created = store
    .create_project_named(
      &json!({ "version": 1, "id": "", "name": "口", "createdAt": "2026-10-17T00:00:00.000Z", "flowSnapshot": { "steps": [] }, "source": { "kind": "text" } }),
      Some("本文"),
      Some(&json!({ "id": "s1", "kind": "save", "at": "2026-10-17T00:00:00.000Z", "stepId": "source", "stepName": "文章", "result": "saved" })),
      &[],
      &[],
    )
    .unwrap();
  created["id"].as_str().unwrap().to_string()
}

/// 旧形式の root の録音は読み込みで recordings/<id>/ へ移る（P6 #18607）。移った後の録音のフォルダと、版の path の頭。
fn root_recording(store: &Store, root: &Path, id: &str) -> (PathBuf, String) {
  store.load_recording(id, ROOT).unwrap();
  let prefix = store.recording_prefix_at(Some(id), ROOT).unwrap();
  (root.join(format!("projects/{id}/{prefix}")), prefix)
}

/// 録音のページの録音 id（P6 でページ id と分かれた）のフォルダ名。
fn recording_dir_name(page: &Value) -> String {
  page["recordingId"]
    .as_str()
    .or_else(|| page["id"].as_str())
    .unwrap()
    .to_string()
}

fn run_record(id: &str, at: &str) -> Value {
  json!({ "id": id, "kind": "run", "at": at, "stepId": STEP, "stepName": "記事方針", "result": "saved" })
}

fn paths_of(writes: &[SinkWrite]) -> Vec<PathBuf> {
  writes.iter().map(|write| write.path().to_path_buf()).collect()
}

fn is_random_version(path: &Path, step: &str) -> bool {
  let name = path.file_name().unwrap().to_string_lossy();
  path.parent().unwrap().ends_with(format!("versions/{step}")) && name.starts_with("v_") && name.ends_with(".md")
}

#[test]
fn a_document_save_is_one_put_and_returns_the_local_generation() {
  let root = temp_root("page");
  let installed = install(&root);
  let store = Store::new(root.clone());
  let created = store
    .create_project_named(
      &json!({ "version": 1, "id": "", "name": "文書", "createdAt": "2026-10-17T00:00:00.000Z", "pages": [] }),
      None,
      None,
      &[],
      &[],
    )
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let page = store
    .create_page(&id, "doc", "メモ", "2026-10-17T00:00:00.000Z", None)
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let generation = store.write_page(&id, &page, "# 本文").unwrap();
  let groups = installed.sink.groups.lock().unwrap().len() as u64;
  assert_eq!(generation, Some(groups));
  let (kind, writes) = installed.sink.last_group();
  let file = root.join(format!("projects/{id}/pages/{page}.md"));
  assert_eq!(kind, SinkKind::Edit);
  assert_eq!(writes, vec![SinkWrite::Put(file.clone(), "# 本文".as_bytes().to_vec())]);
  assert_eq!(fs::read_to_string(&file).unwrap(), "# 本文");
  drop(installed);
  // 口が無ければ今までどおり書き、世代は無い
  assert_eq!(store.write_page(&id, &page, "口なし").unwrap(), None);
  assert_eq!(fs::read_to_string(&file).unwrap(), "口なし");
  let _ = fs::remove_dir_all(root);
}

#[test]
fn a_version_is_one_group_with_a_random_file_and_provenance_in_the_run_row() {
  let root = temp_root("version");
  let installed = install(&root);
  let store = Store::new(root.clone());
  let id = text_project(&store);
  let (dir, prefix) = root_recording(&store, &root, &id);
  let version = store
    .save_artifact(
      &id,
      ROOT,
      STEP,
      false,
      "# 方針",
      &run_record("r1", "2026-10-17T01:00:00.000Z"),
    )
    .unwrap();
  assert_eq!(version, 1);
  let (kind, writes) = installed.sink.last_group();
  assert_eq!(kind, SinkKind::Version);
  let paths = paths_of(&writes);
  assert_eq!(paths.len(), 3, "{paths:?}");
  assert!(is_random_version(&paths[0], STEP), "{paths:?}");
  assert_eq!(paths[1], dir.join(format!("artifacts/{STEP}.md")));
  assert_eq!(paths[2], dir.join("runs.jsonl"));
  let row = store.load_recording(&id, ROOT).unwrap().runs.last().cloned().unwrap();
  let name = paths[0].file_name().unwrap().to_string_lossy().into_owned();
  assert_eq!(row["version"], 1);
  assert_eq!(row["versionPath"], format!("{prefix}versions/{STEP}/{name}"));
  assert_eq!(row["versionSha256"], sha256_hex("# 方針".as_bytes()));
  assert_eq!(row["originDeviceId"], "d_test");
  assert_eq!(fs::read_to_string(&paths[0]).unwrap(), "# 方針");
  // 表示の番号から runs の行の版を読む（`1.md` は無い）
  assert!(!dir.join(format!("versions/{STEP}/1.md")).exists());
  assert_eq!(store.read_version(&id, ROOT, STEP, 1).unwrap(), "# 方針");
  // 版を足さない記録にも originDeviceId（既にあれば変えない）
  store
    .append_run(&id, ROOT, &json!({ "id": "r2", "kind": "run", "result": "failed" }))
    .unwrap();
  store
    .append_run(
      &id,
      ROOT,
      &json!({ "id": "r3", "kind": "run", "result": "failed", "originDeviceId": "d_other" }),
    )
    .unwrap();
  let (kind, writes) = installed.sink.last_group();
  assert_eq!((kind, paths_of(&writes)), (SinkKind::Run, vec![dir.join("runs.jsonl")]));
  let runs = store.load_recording(&id, ROOT).unwrap().runs;
  assert_eq!(runs[runs.len() - 2]["originDeviceId"], "d_test");
  assert_eq!(runs[runs.len() - 1]["originDeviceId"], "d_other");
  let _ = fs::remove_dir_all(root);
}

#[test]
fn unversioned_edits_are_kept_as_an_automatic_version_before_a_run_overwrites_them() {
  let root = temp_root("auto-version");
  let installed = install(&root);
  let store = Store::new(root.clone());
  let id = text_project(&store);
  store
    .save_artifact(
      &id,
      ROOT,
      STEP,
      false,
      "# 1",
      &run_record("r1", "2026-10-17T01:00:00.000Z"),
    )
    .unwrap();
  assert!(store.load_recording(&id, ROOT).unwrap().unversioned.is_empty());
  // 最新の書きかけの自動保存は今の path だけ（版は足さない）
  let generation = store
    .write_artifact_draft(Some(&id), ROOT, STEP, false, "# 1 直した")
    .unwrap();
  assert!(generation.is_some());
  let (kind, writes) = installed.sink.last_group();
  let (dir, _) = root_recording(&store, &root, &id);
  assert_eq!(
    (kind, paths_of(&writes)),
    (SinkKind::Edit, vec![dir.join(format!("artifacts/{STEP}.md"))])
  );
  assert_eq!(
    store.load_recording(&id, ROOT).unwrap().unversioned,
    vec![STEP.to_string()]
  );
  // 工程の結果で置き換える前に、今の内容を「保存」の版（auto）として同じ保存単位で残す
  let at = "2026-10-17T02:00:00.000Z";
  let version = store
    .save_artifact(&id, ROOT, STEP, false, "# 2", &run_record("r2", at))
    .unwrap();
  assert_eq!(version, 3);
  let (kind, writes) = installed.sink.last_group();
  let paths = paths_of(&writes);
  assert_eq!(kind, SinkKind::Version);
  assert_eq!(paths.len(), 4, "{paths:?}");
  assert!(is_random_version(&paths[0], STEP) && is_random_version(&paths[1], STEP));
  let runs = store.load_recording(&id, ROOT).unwrap().runs;
  let (auto, run) = (&runs[runs.len() - 2], &runs[runs.len() - 1]);
  assert_eq!(auto["kind"], "save");
  assert_eq!(auto["auto"], true);
  assert_eq!(auto["result"], "saved");
  assert_eq!(auto["version"], 2);
  assert_eq!(auto["stepName"], "記事方針");
  // 自動の版は置き換える記録と同じ時刻（並びは番号で後ろの記録が新しい）
  assert_eq!(auto["at"], at);
  assert_eq!(run["version"], 3);
  assert_eq!(store.read_version(&id, ROOT, STEP, 2).unwrap(), "# 1 直した");
  assert_eq!(store.read_version(&id, ROOT, STEP, 3).unwrap(), "# 2");
  let loaded = store.load_recording(&id, ROOT).unwrap();
  assert_eq!(loaded.artifacts.get(STEP).map(String::as_str), Some("# 2"));
  assert!(loaded.unversioned.is_empty());
  // 今の内容がいちばん新しい版と同じなら、自動の版は作らない
  store
    .save_artifact(
      &id,
      ROOT,
      STEP,
      false,
      "# 3",
      &run_record("r3", "2026-10-17T03:00:00.000Z"),
    )
    .unwrap();
  assert_eq!(installed.sink.last_group().1.len(), 3);
  let _ = fs::remove_dir_all(root);
}

#[test]
fn legacy_numbered_versions_are_read_and_counted() {
  let root = temp_root("legacy");
  let store = Store::new(root.clone());
  let id = text_project(&store);
  let (dir, _) = root_recording(&store, &root, &id);
  fs::create_dir_all(dir.join(format!("versions/{STEP}"))).unwrap();
  fs::create_dir_all(dir.join("artifacts")).unwrap();
  fs::write(dir.join(format!("versions/{STEP}/1.md")), "旧 1").unwrap();
  fs::write(dir.join(format!("versions/{STEP}/2.md")), "旧 2").unwrap();
  fs::write(dir.join(format!("artifacts/{STEP}.md")), "旧 2").unwrap();
  let mut runs = fs::read_to_string(dir.join("runs.jsonl")).unwrap();
  for number in [1, 2] {
    runs.push_str(&format!(
      "{{\"id\":\"old{number}\",\"kind\":\"run\",\"at\":\"2026-10-0{number}T00:00:00.000Z\",\"stepId\":\"{STEP}\",\"stepName\":\"方針\",\"version\":{number},\"result\":\"saved\"}}\n"
    ));
  }
  fs::write(dir.join("runs.jsonl"), runs).unwrap();
  assert_eq!(store.read_version(&id, ROOT, STEP, 2).unwrap(), "旧 2");
  assert!(store.load_recording(&id, ROOT).unwrap().unversioned.is_empty());
  assert_eq!(store.artifact_states(&id, ROOT).unwrap()[1].latest_version, 2);
  let version = store
    .save_artifact(
      &id,
      ROOT,
      STEP,
      false,
      "新",
      &run_record("r9", "2026-10-17T00:00:00.000Z"),
    )
    .unwrap();
  assert_eq!(version, 3);
  // 旧形式のファイルは名前も中身も変えない
  assert_eq!(
    fs::read_to_string(dir.join(format!("versions/{STEP}/1.md"))).unwrap(),
    "旧 1"
  );
  assert!(!dir.join(format!("versions/{STEP}/3.md")).exists());
  assert_eq!(store.read_version(&id, ROOT, STEP, 3).unwrap(), "新");
  // 行の無い旧形式の工程は、連番の最大がいちばん新しい版
  fs::create_dir_all(dir.join("versions/b2b2b2b2")).unwrap();
  fs::write(dir.join("versions/b2b2b2b2/4.md"), "番号だけ").unwrap();
  fs::write(dir.join("artifacts/b2b2b2b2.md"), "番号だけ").unwrap();
  let loaded = store.load_recording(&id, ROOT).unwrap();
  assert!(!loaded.unversioned.contains(&"b2b2b2b2".to_string()));
  assert_eq!(store.revert_artifact(&id, ROOT, "b2b2b2b2").unwrap(), 4);
  let _ = fs::remove_dir_all(root);
}

#[test]
fn a_version_is_read_by_its_path_and_paths_outside_the_steps_folder_are_refused() {
  let root = temp_root("version-path");
  let store = Store::new(root.clone());
  let id = text_project(&store);
  store
    .save_artifact(
      &id,
      ROOT,
      STEP,
      false,
      "# 版",
      &run_record("r1", "2026-10-17T01:00:00.000Z"),
    )
    .unwrap();
  let row = store.load_recording(&id, ROOT).unwrap().runs.last().cloned().unwrap();
  let path = row["versionPath"].as_str().unwrap().to_string();
  // path を先に読む（番号が違っても path の版）
  assert_eq!(
    store.read_version_at(Some(&id), ROOT, STEP, 42, Some(&path)).unwrap(),
    "# 版"
  );
  let name = path.rsplit('/').next().unwrap().to_string();
  for bad in [
    "../project.json".to_string(),
    "project.json".to_string(),
    format!("versions/{STEP}/../../project.json"),
    format!("versions/{STEP}/sub/{name}"),
    format!("versions/source/{name}"),
    format!("recordings/abcdefgh23/versions/{STEP}/{name}"),
    format!("versions/{STEP}/{name}.txt"),
    format!("versions/{STEP}/.md"),
  ] {
    assert_eq!(
      store
        .read_version_at(Some(&id), ROOT, STEP, 1, Some(&bad))
        .unwrap_err()
        .code,
      "store_bad_id",
      "{bad}"
    );
  }
  // 無い版は store_no_version
  assert_eq!(
    store
      .read_version_at(Some(&id), ROOT, STEP, 9, Some(&format!("versions/{STEP}/v_missing.md")))
      .unwrap_err()
      .code,
    "store_no_version"
  );
  let _ = fs::remove_dir_all(root);
}

#[test]
fn a_draft_is_refused_while_this_process_runs_the_project() {
  let root = temp_root("draft-lock");
  let installed = install(&root);
  let store = Store::new(root.clone());
  let id = text_project(&store);
  let (dir, _) = root_recording(&store, &root, &id);
  store.acquire_run_lock(&id).unwrap();
  let error = store
    .write_artifact_draft(Some(&id), ROOT, "source", true, "書きかけ")
    .unwrap_err();
  assert_eq!(
    (error.code.as_str(), error.message.as_str()),
    ("store_busy", "実行中は書き換えられません。")
  );
  assert_eq!(fs::read_to_string(dir.join("transcript.md")).unwrap(), "本文");
  store.release_run_lock(&id).unwrap();
  assert!(store
    .write_artifact_draft(Some(&id), ROOT, "source", true, "書きかけ")
    .unwrap()
    .is_some());
  let (kind, writes) = installed.sink.last_group();
  assert_eq!(
    (kind, paths_of(&writes)),
    (SinkKind::Edit, vec![dir.join("transcript.md")])
  );
  assert_eq!(
    store.load_recording(&id, ROOT).unwrap().unversioned,
    vec!["source".to_string()]
  );
  let _ = fs::remove_dir_all(root);
}

#[test]
fn deletions_and_large_copies_are_reported_as_changes() {
  let root = temp_root("changes");
  let outside = temp_root("changes-src");
  fs::create_dir_all(&outside).unwrap();
  let installed = install(&root);
  let store = Store::new(root.clone());
  let created = store
    .create_project_named(
      &json!({ "version": 1, "id": "", "name": "変更", "createdAt": "2026-10-17T00:00:00.000Z", "pages": [] }),
      None,
      None,
      &[],
      &[],
    )
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let dir = root.join(format!("projects/{id}"));
  // 文書の削除は、一覧の書き換えと本文の削除の 1 つの保存単位
  let doc = store
    .create_page(&id, "doc", "メモ", "2026-10-17T00:00:00.000Z", None)
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store.delete_page(&id, &doc).unwrap();
  let (_, writes) = installed.sink.last_group();
  assert_eq!(writes.len(), 2);
  assert!(matches!(&writes[0], SinkWrite::Put(path, _) if *path == dir.join("project.json")));
  assert_eq!(writes[1], SinkWrite::Delete(dir.join(format!("pages/{doc}.md"))));
  assert!(!dir.join(format!("pages/{doc}.md")).exists());
  // 録音のページの削除は、消したフォルダを知らせる
  let recording =
    json!({ "version": 1, "id": "", "flowSnapshot": { "steps": [] }, "source": { "kind": "audio", "audio": [] } });
  let rec_page = store
    .create_page(&id, "rec", "", "2026-10-17T00:00:00.000Z", Some(&recording))
    .unwrap();
  let rec = rec_page["id"].as_str().unwrap().to_string();
  let rec_dir = recording_dir_name(&rec_page);
  // 音声の写しは journal を通さず、写してから知らせる
  let audio = outside.join("a.m4a");
  fs::write(&audio, b"abc").unwrap();
  let copied = store.import_audio_named(&id, &rec, &[audio], &[], &[]).unwrap();
  let file = copied[0]["file"].as_str().unwrap().to_string();
  let input = dir.join(format!("recordings/{rec_dir}/inputs/{file}"));
  assert!(installed.sink.changed().contains(&input));
  // 使わなくなった写しの削除も知らせる
  let mut saved = store.load_recording(&id, &rec).unwrap().recording.unwrap();
  saved["source"]["audio"] = json!([]);
  store.save_recording(&id, &rec, &saved).unwrap();
  assert!(!input.exists());
  assert_eq!(
    installed.sink.changed().iter().filter(|path| **path == input).count(),
    2
  );
  store.delete_page(&id, &rec).unwrap();
  assert!(installed
    .sink
    .changed()
    .contains(&dir.join(format!("recordings/{rec_dir}"))));
  // 画像は journal を通さず、書いてから知らせる
  let image = outside.join("photo.png");
  fs::write(&image, b"\x89PNG\r\n\x1a\nimage").unwrap();
  let name = store.import_image_asset(&id, &image).unwrap();
  assert!(installed.sink.changed().contains(&dir.join(format!("assets/{name}"))));
  // お手本の本文の整理・工程の削除
  let samples = root.join("flows/samples/flow1");
  fs::create_dir_all(&samples).unwrap();
  fs::write(samples.join("aaaa1111.txt"), "x").unwrap();
  store.prune_samples("flow1", &[]).unwrap();
  assert!(installed.sink.changed().contains(&samples.join("aaaa1111.txt")));
  let flow = json!({ "version": 1, "id": "flow1", "name": "工程", "revision": 1, "guide": "", "terms": [], "samples": [], "steps": [] });
  store.save_flow(&flow).unwrap();
  store.delete_flow("flow1").unwrap();
  assert!(installed.sink.changed().contains(&root.join("flows/flow1.json")));
  assert!(installed.sink.changed().contains(&samples));
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(outside);
}

#[test]
fn audio_missing_on_this_mac_is_listed_and_can_stay_in_the_recording() {
  let root = temp_root("missing-audio");
  let store = Store::new(root.clone());
  let created = store
    .create_project_named(
      &json!({ "version": 1, "id": "", "name": "音声", "createdAt": "2026-10-17T00:00:00.000Z", "pages": [] }),
      None,
      None,
      &[],
      &[],
    )
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let recording =
    json!({ "version": 1, "id": "", "flowSnapshot": { "steps": [] }, "source": { "kind": "audio", "audio": [] } });
  let rec_page = store
    .create_page(&id, "rec", "", "2026-10-17T00:00:00.000Z", Some(&recording))
    .unwrap();
  let rec = rec_page["id"].as_str().unwrap().to_string();
  let rec_dir = recording_dir_name(&rec_page);
  // 別の Mac が足した音声（recording.json には載っていて、写しはまだ届いていない）
  let file = root.join(format!("projects/{id}/recordings/{rec_dir}/recording.json"));
  let mut value: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
  value["source"]["audio"] = json!([{ "file": "abcdefgh23.m4a", "hash": "", "name": "取材", "durationSec": 60.0 }]);
  fs::write(&file, serde_json::to_string(&value).unwrap()).unwrap();
  let loaded = store.load_recording(&id, &rec).unwrap();
  assert_eq!(loaded.missing_inputs, vec!["abcdefgh23.m4a".to_string()]);
  // 既に載っている音声は写しが無くても保存できる（新しく足す音声は写しが要る）
  value["title"] = json!("直した");
  store.save_recording(&id, &rec, &value).unwrap();
  value["source"]["audio"]
    .as_array_mut()
    .unwrap()
    .push(json!({ "file": "zzzzzzzz22.m4a", "hash": "", "name": "x", "durationSec": null }));
  assert_eq!(
    store.save_recording(&id, &rec, &value).unwrap_err().code,
    "store_bad_audio"
  );
  let _ = fs::remove_dir_all(root);
}
