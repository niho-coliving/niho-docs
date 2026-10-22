use super::*;
use serde_json::json;

fn temp_root(name: &str) -> PathBuf {
  std::env::temp_dir().canonicalize().unwrap().join(format!(
    "niho-docs-store-{name}-{}-{}",
    std::process::id(),
    crate::process::hex(&crate::process::random_bytes::<4>().unwrap())
  ))
}

const ROOT: &str = ROOT_RECORDING_ID;

/// 今の形の案件（flowSnapshot と source を持つ。案件フォルダ直下が root の録音）。
fn project(name: &str) -> Value {
  json!({ "version": 1, "id": "", "name": name, "createdAt": "2026-10-15T00:00:00.000Z", "flowSnapshot": { "steps": [] }, "source": { "kind": "text" } })
}

fn save_record(id: &str) -> Value {
  json!({ "id": id, "kind": "save", "stepId": "source", "stepName": "文章", "result": "saved" })
}

fn candidate_project(name: &str) -> Value {
  let mut value = project(name);
  value["flowSnapshot"] = json!({
    "steps": [
      { "id": "shared1", "name": "記事方針", "instruction": "方針", "profile": "standard" },
      { "id": "h2n6v5pe", "name": "記事本文", "instruction": "本文", "profile": "standard" }
    ]
  });
  value
}

fn two_candidates(new_artifact_id: &str) -> Value {
  json!({
    "stepId": "h2n6v5pe",
    "order": ["candidate1", "candidate2"],
    "items": {
      "candidate1": { "id": "candidate1", "artifactId": "h2n6v5pe", "name": "最初の案", "createdAt": "2026-10-16T01:00:00.000Z" },
      "candidate2": { "id": "candidate2", "artifactId": new_artifact_id, "name": "別案", "createdAt": "2026-10-16T01:00:00.000Z" }
    }
  })
}

#[test]
fn ids_are_short_safe_segments() {
  for bad in ["", "A", "a/b", "..", ".a", "-a", "a b", "a:b", "あ", &"a".repeat(65)] {
    assert!(validate_id(bad).is_err(), "{bad:?}");
  }
  for good in ["source", "k7m2q9xa", "run-1", "a_b"] {
    assert!(validate_id(good).is_ok(), "{good:?}");
  }
  let id = new_id(10);
  assert_eq!(id.len(), 10);
  assert!(validate_id(&id).is_ok());
  assert_ne!(new_id(10), id);
}

#[test]
fn run_ids_take_mixed_case_but_never_path_characters() {
  // 画面が作る runId（`run_<22字>`）は大文字を含む。小文字だけの validate_id では最初の保存が落ちた
  for good in [
    "run_CIQ4YvBnzEx63eEoovemwF",
    "run-intent-p",
    "r6-Cancel_Ab",
    "-_",
    &"A".repeat(64),
  ] {
    assert!(validate_run_id(good).is_ok(), "{good:?}");
  }
  for bad in ["", "a/b", "..", "run.json", "a b", "a:b", "あ", &"a".repeat(65)] {
    assert_eq!(validate_run_id(bad).unwrap_err().code, "store_bad_id", "{bad:?}");
  }
}

#[test]
fn project_images_are_bounded_validated_and_kept_in_assets() {
  let root = temp_root("images");
  let store = Store::new(root.clone());
  let created = store.create_project(&project("写真"), None, None, &[]).unwrap();
  let id = created["id"].as_str().unwrap();
  let source = root.join("photo.png");
  fs::write(&source, b"\x89PNG\r\n\x1a\nimage-data").unwrap();
  let name = store.import_image_asset(id, &source).unwrap();
  assert!(name.ends_with(".png"));
  assert!(root.join("projects").join(id).join("assets").join(&name).is_file());
  assert!(store
    .read_image_asset(id, &name)
    .unwrap()
    .starts_with("data:image/png;base64,"));
  let outside_name = store.import_page_image_asset(None, &source).unwrap();
  assert!(root.join("assets").join(&outside_name).is_file());
  assert!(store
    .read_page_image_asset(None, &outside_name)
    .unwrap()
    .starts_with("data:image/png;base64,"));
  assert_eq!(
    store.read_image_asset(id, "../photo.png").unwrap_err().code,
    "store_bad_id"
  );
  fs::write(root.join("false.png"), b"not an image").unwrap();
  assert_eq!(
    store.import_image_asset(id, &root.join("false.png")).unwrap_err().code,
    "store_bad_image"
  );
  let huge = root.join("huge.png");
  fs::File::create(&huge).unwrap().set_len(10 * 1024 * 1024 + 1).unwrap();
  assert_eq!(
    store.import_image_asset(id, &huge).unwrap_err().code,
    "store_image_too_large"
  );
  #[cfg(unix)]
  {
    let link = root.join("linked.png");
    std::os::unix::fs::symlink(&source, &link).unwrap();
    assert_eq!(store.import_image_asset(id, &link).unwrap_err().code, "store_symlink");
    let asset = root.join("projects").join(id).join("assets").join(&name);
    fs::remove_file(&asset).unwrap();
    std::os::unix::fs::symlink(&source, &asset).unwrap();
    assert_eq!(store.read_image_asset(id, &name).unwrap_err().code, "store_symlink");
  }
  fs::remove_dir_all(root).unwrap();
}

#[test]
fn text_project_round_trip_with_versions_runs_and_checkpoints() {
  let root = temp_root("round-trip");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&project("運営会議 10/07"), Some("本文"), Some(&save_record("r1")), &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  assert!(validate_id(&id).is_ok());
  // フォルダ名は id で、表示名は project.json の中だけ
  assert!(root.join("projects").join(&id).join("project.json").is_file());
  assert!(!root.join("projects").join("運営会議 10／07").exists());
  assert_eq!(store.load_project(&id).unwrap().project["name"], "運営会議 10/07");
  let rec = first_recording_id(&store, &id);
  let loaded = store.load_recording(&id, ROOT).unwrap();
  assert_eq!(loaded.transcript.as_deref(), Some("本文"));
  assert_eq!(loaded.runs[0]["version"], 1);
  assert_eq!(
    fs::read_to_string(root.join(format!("projects/{id}/recordings/{rec}/inputs/text.md"))).unwrap(),
    "本文"
  );
  // 版は versions/source/v_<乱数>.md（runs の行の versionPath）
  let version_path = loaded.runs[0]["versionPath"].as_str().unwrap().to_string();
  assert!(version_path.starts_with("versions/source/v_"), "{version_path}");
  assert_eq!(
    fs::read_to_string(root.join(format!("projects/{id}/recordings/{rec}/{version_path}"))).unwrap(),
    "本文"
  );

  let run = json!({ "id": "r2", "kind": "run", "stepId": "k7m2q9xa", "stepName": "記事方針", "result": "saved" });
  assert_eq!(
    store
      .save_artifact(&id, ROOT, "k7m2q9xa", false, "# 方針 1", &run)
      .unwrap(),
    1
  );
  assert_eq!(
    store
      .save_artifact(&id, ROOT, "k7m2q9xa", false, "# 方針 2", &run)
      .unwrap(),
    2
  );
  store
    .append_run(&id, ROOT, &json!({ "id": "r3", "kind": "run", "result": "failed" }))
    .unwrap();
  store
    .save_checkpoint(
      &id,
      ROOT,
      "r3",
      &json!({ "schemaVersion": 1, "output": "途中", "state": "stopped" }),
    )
    .unwrap();
  assert_eq!(
    store.read_checkpoint(&id, ROOT, "r3").unwrap().unwrap()["output"],
    "途中"
  );
  assert_eq!(store.read_checkpoint(&id, ROOT, "r9").unwrap(), None);
  assert!(root
    .join(format!("projects/{id}/recordings/{rec}/runs/r3.json"))
    .is_file());

  let loaded = store.load_recording(&id, ROOT).unwrap();
  assert_eq!(loaded.artifacts.get("k7m2q9xa").map(String::as_str), Some("# 方針 2"));
  assert_eq!(store.read_version(&id, ROOT, "k7m2q9xa", 1).unwrap(), "# 方針 1");
  assert_eq!(
    loaded.runs.iter().map(|run| run["version"].clone()).collect::<Vec<_>>(),
    vec![json!(1), json!(1), json!(2), Value::Null]
  );
  assert!(store
    .artifact_path(&id, ROOT, "k7m2q9xa", false)
    .unwrap()
    .ends_with("artifacts/k7m2q9xa.md"));

  let listed = store.list_projects().unwrap();
  assert_eq!(listed.len(), 1);
  assert_eq!(listed[0].artifacts, vec!["k7m2q9xa".to_string()]);
  let wire = serde_json::to_value(&listed[0]).unwrap();
  assert_eq!(wire["hasTranscript"], true);
  assert_eq!(wire["id"], id.as_str());
  assert_eq!(store.list_all_runs().unwrap().len(), 4);

  // 名前を変えてもフォルダは id のまま
  let mut renamed = store.load_project(&id).unwrap().project;
  renamed["name"] = json!("新しい名前");
  store.save_project(&id, &renamed).unwrap();
  assert_eq!(store.load_project(&id).unwrap().project["name"], "新しい名前");
  let mut other = renamed.clone();
  other["id"] = json!("zzzz");
  assert!(store.save_project(&id, &other).is_err());
  let _ = fs::remove_dir_all(root);
}

#[test]
fn failed_run_log_append_rolls_back_the_new_version_and_latest_artifact() {
  let root = temp_root("artifact-rollback");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&project("保存 rollback"), None, None, &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  store
    .save_artifact(
      &id,
      ROOT,
      "k7m2q9xa",
      false,
      "# 以前の版",
      &json!({ "id": "r1", "kind": "run" }),
    )
    .unwrap();

  let project_dir = root.join(format!("projects/{id}"));
  let runs = project_dir.join("runs.jsonl");
  let backup = project_dir.join("runs.backup");
  fs::rename(&runs, &backup).unwrap();
  fs::create_dir(&runs).unwrap();

  let error = store
    .save_artifact(
      &id,
      ROOT,
      "k7m2q9xa",
      false,
      "# 保存されない版",
      &json!({ "id": "r2", "kind": "run" }),
    )
    .unwrap_err();
  assert_eq!(error.code, "store_io");
  assert_eq!(
    fs::read_to_string(project_dir.join("artifacts/k7m2q9xa.md")).unwrap(),
    "# 以前の版"
  );
  let versions: Vec<PathBuf> = fs::read_dir(project_dir.join("versions/k7m2q9xa"))
    .unwrap()
    .map(|entry| entry.unwrap().path())
    .collect();
  assert_eq!(versions.len(), 1, "{versions:?}");
  assert_eq!(fs::read_to_string(&versions[0]).unwrap(), "# 以前の版");

  fs::remove_dir(&runs).unwrap();
  fs::rename(&backup, &runs).unwrap();
  assert_eq!(store.load_recording(&id, ROOT).unwrap().runs.len(), 1);
  let _ = fs::remove_dir_all(root);
}

#[test]
fn candidate_creation_is_atomic_and_stale_recording_saves_preserve_the_latest_ledger() {
  let root = temp_root("candidate-atomic");
  let store = Store::new(root.clone());
  let created = store
    .create_project(
      &candidate_project("記事"),
      Some("素材"),
      Some(&save_record("source1")),
      &[],
    )
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let recording_id = first_recording_id(&store, &id);
  let stale = store.load_recording(&id, ROOT).unwrap().recording.unwrap();
  let record = json!({
    "id": "save2", "kind": "save", "at": "2026-10-16T01:00:00.000Z",
    "stepId": "h2n6v5pe", "stepName": "別案", "candidateId": "candidate2",
    "artifactId": "artifact2", "version": null, "result": "saved"
  });
  store
    .create_candidate_at(
      Some(&id),
      ROOT,
      "h2n6v5pe",
      &two_candidates("artifact2"),
      "artifact2",
      Some("# 複製本文"),
      Some(&record),
    )
    .unwrap();

  let loaded = store.load_recording(&id, ROOT).unwrap();
  assert_eq!(
    loaded.recording.as_ref().unwrap()["candidateSets"]["h2n6v5pe"]["order"],
    json!(["candidate1", "candidate2"])
  );
  assert_eq!(
    loaded.artifacts.get("artifact2").map(String::as_str),
    Some("# 複製本文")
  );
  assert_eq!(store.read_version(&id, ROOT, "artifact2", 1).unwrap(), "# 複製本文");
  assert_eq!(loaded.runs.last().unwrap()["candidateId"], "candidate2");

  // 候補追加前に画面が持っていた録音を通常保存しても、最新ディスクの台帳を消さない。
  store.save_recording(&id, ROOT, &stale).unwrap();
  assert_eq!(
    store.load_recording(&id, ROOT).unwrap().recording.unwrap()["candidateSets"]["h2n6v5pe"]["order"],
    json!(["candidate1", "candidate2"])
  );

  // metadata の atomic commit が失敗したら、新しい候補の本文・版・実行記録だけを戻す。
  let before_runs = store.load_recording(&id, ROOT).unwrap().runs;
  let mut third = store.load_recording(&id, ROOT).unwrap().recording.unwrap()["candidateSets"]["h2n6v5pe"].clone();
  third["order"].as_array_mut().unwrap().push(json!("candidate3"));
  third["items"]["candidate3"] = json!({
    "id": "candidate3", "artifactId": "artifact3", "name": "第三案", "createdAt": "2026-10-16T02:00:00.000Z"
  });
  let third_record = json!({
    "id": "save3", "kind": "save", "stepId": "h2n6v5pe", "stepName": "第三案",
    "candidateId": "candidate3", "artifactId": "artifact3", "result": "saved"
  });
  let error = store
    .create_candidate_with(
      Some(&id),
      ROOT,
      "h2n6v5pe",
      &third,
      "artifact3",
      Some("# 戻す本文"),
      Some(&third_record),
      |_path, _owner| Err(StoreError::new("store_test_commit", "commit failed")),
    )
    .unwrap_err();
  assert_eq!(error.code, "store_test_commit");
  let after = store.load_recording(&id, ROOT).unwrap();
  assert!(after.artifacts.get("artifact3").is_none());
  assert!(
    root
      .join(format!("projects/{id}/recordings/{recording_id}/versions/artifact3"))
      .exists()
      == false
  );
  assert_eq!(after.runs, before_runs);
  assert!(after.recording.unwrap()["candidateSets"]["h2n6v5pe"]["items"]["candidate3"].is_null());
  let _ = fs::remove_dir_all(root);
}

#[test]
fn editable_artifact_paths_accept_only_current_flow_source_and_candidate_artifacts() {
  let root = temp_root("editable-artifact-paths");
  let store = Store::new(root.clone());
  let created = store
    .create_project(
      &candidate_project("記事"),
      Some("素材"),
      Some(&save_record("source1")),
      &[],
    )
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  store
    .create_candidate_at(
      Some(&id),
      ROOT,
      "h2n6v5pe",
      &two_candidates("artifact2"),
      "artifact2",
      Some("# 別案"),
      Some(&json!({
        "id": "save2", "kind": "save", "stepId": "h2n6v5pe", "stepName": "別案",
        "candidateId": "candidate2", "artifactId": "artifact2", "result": "saved"
      })),
    )
    .unwrap();

  assert!(store
    .editable_artifact_file_at(Some(&id), ROOT, SOURCE_STEP_ID, true)
    .unwrap()
    .ends_with("transcript.md"));
  assert!(store
    .editable_artifact_file_at(Some(&id), ROOT, "shared1", false)
    .unwrap()
    .ends_with("artifacts/shared1.md"));
  assert!(store
    .editable_artifact_file_at(Some(&id), ROOT, "artifact2", false)
    .unwrap()
    .ends_with("artifacts/artifact2.md"));
  assert!(store
    .editable_artifact_file_at(Some(&id), ROOT, "unlisted2", false)
    .is_err());
  assert!(store
    .editable_artifact_file_at(Some(&id), ROOT, "artifact2", true)
    .is_err());
  let _ = fs::remove_dir_all(root);
}

fn two_transcripts() -> Value {
  json!({
    "stepId": "source",
    "order": ["tx1", "tx2"],
    "items": {
      "tx1": { "id": "tx1", "artifactId": "source", "name": "Gemini", "engine": "gemini", "createdAt": "2026-10-19T01:00:00.000Z" },
      "tx2": { "id": "tx2", "artifactId": "artifact-tx2", "name": "この Mac", "engine": "this-mac", "createdAt": "2026-10-19T01:00:00.000Z" }
    }
  })
}

#[test]
fn transcript_candidates_need_audio_save_apart_from_transcript_md_and_keep_the_selection() {
  let root = temp_root("transcript-candidates");
  let store = Store::new(root.clone());
  let created = store
    .create_project(
      &candidate_project("朝市"),
      Some("最初の文字起こし"),
      Some(&save_record("source1")),
      &[],
    )
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let recording_id = first_recording_id(&store, &id);
  let dir = root.join(format!("projects/{id}/recordings/{recording_id}"));

  // 文章から作った録音は文字起こしをしないので、文字起こしの案は作れない
  let error = store
    .create_candidate_at(
      Some(&id),
      ROOT,
      SOURCE_STEP_ID,
      &two_transcripts(),
      "artifact-tx2",
      None,
      None,
    )
    .unwrap_err();
  assert!(error.message.contains("音声のある録音"), "{}", error.message);

  let mut raw: Value = serde_json::from_str(&fs::read_to_string(dir.join("recording.json")).unwrap()).unwrap();
  raw["source"] =
    json!({ "kind": "audio", "audio": [{ "file": "a.m4a", "hash": "h", "name": "朝市.m4a", "durationSec": 190 }] });
  fs::write(dir.join("recording.json"), serde_json::to_string(&raw).unwrap()).unwrap();
  let stale = store.load_recording(&id, ROOT).unwrap().recording.unwrap();
  store
    .create_candidate_at(
      Some(&id),
      ROOT,
      SOURCE_STEP_ID,
      &two_transcripts(),
      "artifact-tx2",
      None,
      None,
    )
    .unwrap();

  // 文字起こしの別案は工程 1 でも artifacts/<artifactId>.md と versions/<artifactId>/ に書き、transcript.md を変えない
  let record = json!({
    "id": "run-tx2", "kind": "run", "at": "2026-10-19T01:05:00.000Z", "stepId": "source", "stepName": "文字起こし",
    "candidateId": "tx2", "artifactId": "artifact-tx2", "version": null, "result": "saved", "provider": "this-mac"
  });
  let version = store
    .save_artifact_at(Some(&id), ROOT, "artifact-tx2", true, "[00:00:00] 連売の朝", &record)
    .unwrap();
  assert_eq!(version, 1);
  assert_eq!(
    fs::read_to_string(dir.join("artifacts/artifact-tx2.md")).unwrap(),
    "[00:00:00] 連売の朝"
  );
  assert_eq!(
    fs::read_to_string(dir.join("transcript.md")).unwrap(),
    "最初の文字起こし"
  );
  let loaded = store.load_recording(&id, ROOT).unwrap();
  assert_eq!(loaded.transcript.as_deref(), Some("最初の文字起こし"));
  assert_eq!(
    loaded.artifacts.get("artifact-tx2").map(String::as_str),
    Some("[00:00:00] 連売の朝")
  );
  assert!(store
    .editable_artifact_file_at(Some(&id), ROOT, "artifact-tx2", false)
    .unwrap()
    .ends_with("artifacts/artifact-tx2.md"));

  // 後工程に使う案の切替は、画面が知っている今の指定と同じときだけ（別の画面の変更を上書きしない）
  store.set_source_candidate_at(Some(&id), ROOT, "tx2", None).unwrap();
  let conflict = store.set_source_candidate_at(Some(&id), ROOT, "tx1", None).unwrap_err();
  assert_eq!(conflict.code, "store_conflict");
  assert!(store
    .set_source_candidate_at(Some(&id), ROOT, "missing", Some("tx2"))
    .is_err());
  // 案を足す前の古い録音の写しを通常保存しても、台帳と後工程の指定は消えない
  store.save_recording(&id, ROOT, &stale).unwrap();
  let kept = store.load_recording(&id, ROOT).unwrap().recording.unwrap();
  assert_eq!(kept["sourceCandidateId"], "tx2");
  assert_eq!(kept["candidateSets"]["source"]["order"], json!(["tx1", "tx2"]));
  store
    .set_source_candidate_at(Some(&id), ROOT, "tx1", Some("tx2"))
    .unwrap();
  assert_eq!(
    store.load_recording(&id, ROOT).unwrap().recording.unwrap()["sourceCandidateId"],
    "tx1"
  );

  // 文字起こしの案の置き場に、共有工程や transcript.md の名前は使えない
  let mut alias = two_transcripts();
  alias["items"]["tx2"]["artifactId"] = json!("shared1");
  assert!(store
    .create_candidate_at(Some(&id), ROOT, SOURCE_STEP_ID, &alias, "shared1", None, None)
    .is_err());
  let _ = fs::remove_dir_all(root);
}

#[test]
fn candidate_ledger_rejects_invalid_identity_aliases_and_non_final_steps() {
  let root = temp_root("candidate-validation");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&candidate_project("記事"), None, None, &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let valid = two_candidates("artifact2");

  let mut key_mismatch = valid.clone();
  key_mismatch["items"]["candidate2"]["id"] = json!("otherid");
  let mut duplicate_order = valid.clone();
  duplicate_order["order"] = json!(["candidate1", "candidate1"]);
  let mut duplicate_artifact = valid.clone();
  duplicate_artifact["items"]["candidate2"]["artifactId"] = json!("h2n6v5pe");
  let mut shared_alias = valid.clone();
  shared_alias["items"]["candidate2"]["artifactId"] = json!("shared1");
  let mut source_alias = valid.clone();
  source_alias["items"]["candidate2"]["artifactId"] = json!(SOURCE_STEP_ID);
  let mut missing_original = valid.clone();
  missing_original["items"]["candidate1"]["artifactId"] = json!("unrelated");
  for bad in [
    key_mismatch,
    duplicate_order,
    duplicate_artifact,
    shared_alias,
    source_alias,
    missing_original,
  ] {
    assert_eq!(
      store
        .create_candidate_at(
          Some(&id),
          ROOT,
          "h2n6v5pe",
          &bad,
          bad["items"]["candidate2"]["artifactId"].as_str().unwrap(),
          None,
          None
        )
        .unwrap_err()
        .code,
      "store_bad_json"
    );
  }
  let mut invalid_path = valid.clone();
  invalid_path["items"]["candidate2"]["artifactId"] = json!("../outside");
  assert_eq!(
    store
      .create_candidate_at(Some(&id), ROOT, "h2n6v5pe", &invalid_path, "../outside", None, None)
      .unwrap_err()
      .code,
    "store_bad_id"
  );
  let mut owner_with_other_set = candidate_project("別台帳");
  owner_with_other_set["candidateSets"] = json!({
    "otherstep": {
      "stepId": "otherstep", "order": ["othercandidate"],
      "items": { "othercandidate": { "id": "othercandidate", "artifactId": "artifact2", "name": "別所属", "createdAt": "x" } }
    }
  });
  assert_eq!(
    Store::validate_candidate_set(&owner_with_other_set, "h2n6v5pe", &valid, "artifact2")
      .unwrap_err()
      .code,
    "store_bad_json"
  );

  // 別案は最後の工程なら常に作れる。以前の「出力」チェックを外して保存した工程（output.mode = single）でも拒否しない。
  let mut leftover = candidate_project("単一");
  leftover["flowSnapshot"]["steps"][1]["output"] = json!({ "mode": "single" });
  let single_created = store.create_project(&leftover, None, None, &[]).unwrap();
  let single_id = single_created["id"].as_str().unwrap();
  store
    .create_candidate_at(Some(single_id), ROOT, "h2n6v5pe", &valid, "artifact2", None, None)
    .unwrap();

  // 対象工程が最後でない snapshot も拒否する。
  let middle_created = store
    .create_project(&candidate_project("途中"), None, None, &[])
    .unwrap();
  let middle_id = middle_created["id"].as_str().unwrap();
  let mut middle = store.load_recording(middle_id, ROOT).unwrap().recording.unwrap();
  middle["flowSnapshot"]["steps"].as_array_mut().unwrap().push(json!({
    "id": "after1", "name": "後続", "instruction": "後続", "profile": "standard"
  }));
  store.save_recording(middle_id, ROOT, &middle).unwrap();
  assert_eq!(
    store
      .create_candidate_at(Some(middle_id), ROOT, "h2n6v5pe", &valid, "artifact2", None, None)
      .unwrap_err()
      .code,
    "store_bad_page"
  );
  let _ = fs::remove_dir_all(root);
}

#[test]
fn moving_a_recording_keeps_candidate_ledgers_bodies_versions_and_conversations_together() {
  let root = temp_root("candidate-move");
  let store = Store::new(root.clone());
  let created = store.create_project(&pages_project("記事"), None, None, &[]).unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let mut recording = new_recording();
  recording["flowSnapshot"] = candidate_project("snapshot")["flowSnapshot"].clone();
  let page = store
    .create_page(&id, "rec", "取材", "2026-10-16T01:00:00.000Z", Some(&recording))
    .unwrap();
  let page_id = page["id"].as_str().unwrap();
  store
    .save_artifact(
      &id,
      page_id,
      "h2n6v5pe",
      false,
      "# 最初の案",
      &json!({ "id": "body1", "kind": "run", "stepId": "h2n6v5pe", "result": "saved" }),
    )
    .unwrap();
  store
    .create_candidate_at(
      Some(&id),
      page_id,
      "h2n6v5pe",
      &two_candidates("artifact2"),
      "artifact2",
      Some("# 別案"),
      Some(&json!({
        "id": "save2", "kind": "save", "stepId": "h2n6v5pe", "candidateId": "candidate2",
        "artifactId": "artifact2", "result": "saved"
      })),
    )
    .unwrap();
  store
    .save_conversation(
      &id,
      page_id,
      "candidate-conv",
      &json!({ "id": "candidate-conv", "updatedAt": "x", "candidateId": "candidate2", "artifactId": "artifact2" }),
    )
    .unwrap();

  let moved = store.move_page(Some(&id), page_id, None).unwrap();
  let moved_recording_id = moved["recordingId"].as_str().unwrap();
  let loaded = store.load_recording_at(None, moved_recording_id).unwrap();
  assert_eq!(
    loaded.recording.as_ref().unwrap()["candidateSets"]["h2n6v5pe"]["order"],
    json!(["candidate1", "candidate2"])
  );
  assert_eq!(loaded.artifacts.get("h2n6v5pe").map(String::as_str), Some("# 最初の案"));
  assert_eq!(loaded.artifacts.get("artifact2").map(String::as_str), Some("# 別案"));
  assert_eq!(
    store
      .read_version_at(None, moved_recording_id, "artifact2", 1, None)
      .unwrap(),
    "# 別案"
  );
  assert_eq!(
    store.list_conversations_at(None, moved_recording_id).unwrap()[0]["candidateId"],
    "candidate2"
  );
  let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn candidate_creation_refuses_symlinked_artifact_storage_without_committing_metadata() {
  use std::os::unix::fs::symlink;

  let root = temp_root("candidate-symlink");
  let outside = temp_root("candidate-symlink-outside");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&candidate_project("記事"), None, None, &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let recording_id = first_recording_id(&store, &id);
  let recording_dir = root.join(format!("projects/{id}/recordings/{recording_id}"));
  fs::create_dir_all(&outside).unwrap();
  symlink(&outside, recording_dir.join("artifacts")).unwrap();
  let error = store
    .create_candidate_at(
      Some(&id),
      ROOT,
      "h2n6v5pe",
      &two_candidates("artifact2"),
      "artifact2",
      Some("# 外へ出さない"),
      Some(&json!({ "id": "save2", "kind": "save", "stepId": "h2n6v5pe", "result": "saved" })),
    )
    .unwrap_err();
  assert_eq!(error.code, "store_symlink");
  assert!(store
    .load_recording(&id, ROOT)
    .unwrap()
    .recording
    .unwrap()
    .get("candidateSets")
    .is_none());
  assert!(fs::read_dir(&outside).unwrap().next().is_none());
  let _ = fs::remove_file(recording_dir.join("artifacts"));
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(outside);
}

#[test]
fn audio_is_copied_with_a_hash_and_unused_copies_are_removed() {
  let root = temp_root("audio");
  let outside = temp_root("audio-src");
  fs::create_dir_all(&outside).unwrap();
  let first = outside.join("座談会.m4a");
  let second = outside.join("2.MP3");
  fs::write(&first, b"abc").unwrap();
  fs::write(&second, b"xyz").unwrap();
  fs::write(outside.join("memo.txt"), b"x").unwrap();
  let store = Store::new(root.clone());
  let mut audio_project = project("音声");
  audio_project["source"] = json!({ "kind": "audio", "audio": [] });
  let created = store
    .create_project(&audio_project, None, None, &[first.clone()])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let rec = first_recording_id(&store, &id);
  let audio = created["source"]["audio"].as_array().unwrap();
  assert_eq!(audio.len(), 1);
  assert_eq!(audio[0]["name"], "座談会.m4a");
  // sha256("abc")
  assert_eq!(
    audio[0]["hash"],
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
  let file = audio[0]["file"].as_str().unwrap().to_string();
  assert!(file.ends_with(".m4a"));
  assert_eq!(
    fs::read(root.join(format!("projects/{id}/recordings/{rec}/inputs/{file}"))).unwrap(),
    b"abc"
  );
  assert_eq!(store.audio_paths(&id, &rec).unwrap().len(), 1);

  let added = store.import_audio(&id, &rec, &[second], &[file.clone()]).unwrap();
  assert!(added[0]["file"].as_str().unwrap().ends_with(".mp3"));
  assert!(store
    .import_audio(&id, &rec, &[outside.join("memo.txt")], &[file.clone()])
    .is_err());
  // 1 本目を外して 2 本目だけを残すと、1 本目の写しは消える（実行中は消さず、次の保存で消す）
  let mut saved = store.load_recording(&id, &rec).unwrap().recording.unwrap();
  saved["source"]["audio"] = json!(added);
  store.acquire_run_lock(&id).unwrap();
  store.save_recording(&id, &rec, &saved).unwrap();
  assert!(root
    .join(format!("projects/{id}/recordings/{rec}/inputs/{file}"))
    .exists());
  store.release_run_lock(&id).unwrap();
  store.save_recording(&id, &rec, &saved).unwrap();
  assert!(!root
    .join(format!("projects/{id}/recordings/{rec}/inputs/{file}"))
    .exists());
  assert_eq!(store.audio_paths(&id, &rec).unwrap().len(), 1);
  // 写しの無いファイル名は保存しない
  saved["source"]["audio"] = json!([{ "file": "nothere1.m4a", "hash": "", "name": "x", "durationSec": null }]);
  assert!(store.save_recording(&id, &rec, &saved).is_err());
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(outside);
}

#[test]
fn aifc_is_accepted_as_audio() {
  let root = temp_root("audio-aifc");
  let outside = temp_root("audio-aifc-src");
  fs::create_dir_all(&outside).unwrap();
  let source = outside.join("interview.AIFC");
  fs::write(&source, b"FORM....AIFC").unwrap();
  let store = Store::new(root.clone());
  let mut audio_project = project("AIFC");
  audio_project["source"] = json!({ "kind": "audio", "audio": [] });

  let created = store.create_project(&audio_project, None, None, &[source]).unwrap();
  let audio = created["source"]["audio"].as_array().unwrap();
  assert_eq!(audio.len(), 1);
  assert!(audio[0]["file"].as_str().unwrap().ends_with(".aifc"));

  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(outside);
}

/// 16 kHz・mono・16-bit の無音の WAV（`seconds` 秒。afinfo が長さを読める最小の形）。
fn silent_wav(seconds: usize) -> Vec<u8> {
  let data = seconds * 16_000 * 2;
  let mut bytes = Vec::with_capacity(44 + data);
  bytes.extend_from_slice(b"RIFF");
  bytes.extend_from_slice(&((36 + data) as u32).to_le_bytes());
  bytes.extend_from_slice(b"WAVEfmt ");
  bytes.extend_from_slice(&16u32.to_le_bytes());
  bytes.extend_from_slice(&1u16.to_le_bytes());
  bytes.extend_from_slice(&1u16.to_le_bytes());
  bytes.extend_from_slice(&16_000u32.to_le_bytes());
  bytes.extend_from_slice(&32_000u32.to_le_bytes());
  bytes.extend_from_slice(&2u16.to_le_bytes());
  bytes.extend_from_slice(&16u16.to_le_bytes());
  bytes.extend_from_slice(b"data");
  bytes.extend_from_slice(&(data as u32).to_le_bytes());
  bytes.resize(44 + data, 0);
  bytes
}

#[test]
fn a_file_over_two_gib_is_refused_before_it_is_copied() {
  let root = temp_root("audio-big");
  let outside = temp_root("audio-big-src");
  fs::create_dir_all(&outside).unwrap();
  let big = outside.join("big.m4a");
  // 疎なファイル（論理サイズだけ。ディスクは使わない）。ちょうど 2 GiB は断らない境目だが、写すと 2 GiB を書くので
  // ここでは 1 バイト超える側だけを見る
  fs::File::create(&big)
    .unwrap()
    .set_len(AUDIO_FILE_MAX_BYTES + 1)
    .unwrap();
  let store = Store::new(root.clone());
  let mut audio_project = project("大きい音声");
  audio_project["source"] = json!({ "kind": "audio", "audio": [] });

  let error = store
    .create_project(&audio_project, None, None, &[big.clone()])
    .unwrap_err();
  assert_eq!(error.code, "store_audio_too_large");
  // 案件の置き場は残らない
  assert_eq!(
    fs::read_dir(root.join("projects")).map(|dir| dir.count()).unwrap_or(0),
    0
  );

  // 既にある案件へ足すときも同じ。inputs/ に何も写らない
  let created = store.create_project(&project("文章"), Some("本文"), None, &[]).unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let inputs = root.join(format!("projects/{id}/inputs"));
  let before = fs::read_dir(&inputs).unwrap().count();
  let error = store.import_audio(&id, ROOT, &[big], &[]).unwrap_err();
  assert_eq!(error.code, "store_audio_too_large");
  assert_eq!(fs::read_dir(&inputs).unwrap().count(), before);
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(outside);
}

#[test]
fn audio_over_six_hours_in_total_is_refused_and_this_calls_copies_are_removed() {
  let root = temp_root("audio-long");
  let outside = temp_root("audio-long-src");
  fs::create_dir_all(&outside).unwrap();
  let first = outside.join("1.wav");
  let second = outside.join("2.wav");
  fs::write(&first, silent_wav(2)).unwrap();
  fs::write(&second, silent_wav(2)).unwrap();
  let store = Store::new(root.clone());
  let created = store
    .create_project(&project("長い音声"), Some("本文"), None, &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let root_inputs = root.join(format!("projects/{id}/inputs"));
  let root_before = fs::read_dir(&root_inputs).unwrap().count();

  // 6 時間まであと 3 秒: 2 秒の 1 本は入り、その上にもう 2 秒を足す 2 本目で超える（この呼び出しで写した 2 本とも消える）
  let ok = store
    .copy_audio(
      &["projects", &id, "inputs"],
      &[first.clone()],
      &[],
      AUDIO_TOTAL_MAX_SEC - 3.0,
    )
    .unwrap();
  assert_eq!(ok.len(), 1);
  assert_eq!(fs::read_dir(&root_inputs).unwrap().count(), root_before + 1);
  let error = store
    .copy_audio(
      &["projects", &id, "inputs"],
      &[first.clone(), second.clone()],
      &[],
      AUDIO_TOTAL_MAX_SEC - 3.0,
    )
    .unwrap_err();
  assert_eq!(error.code, "store_audio_too_long");
  assert_eq!(fs::read_dir(&root_inputs).unwrap().count(), root_before + 1);

  let rec = first_recording_id(&store, &id);
  // 音声の長さは録音の recording.json に保存した durationSec から数える。
  let kept = ok[0]["file"].as_str().unwrap().to_string();
  let mut with_audio = store.load_recording(&id, &rec).unwrap().recording.unwrap();
  with_audio["source"] = json!({ "kind": "audio", "audio": [
    { "file": kept, "hash": ok[0]["hash"], "name": "1.wav", "durationSec": AUDIO_TOTAL_MAX_SEC - 1.0 }
  ] });
  store.save_recording(&id, &rec, &with_audio).unwrap();
  let error = store
    .import_audio(&id, &rec, &[second.clone()], &[kept.clone()])
    .unwrap_err();
  assert_eq!(error.code, "store_audio_too_long");
  // 同じ編集で外す音声は数えない（入れ替え: 長い 1 本を外して 2 秒を足すのは通る）
  let swapped = store.import_audio(&id, &rec, &[second], &[]).unwrap();
  assert_eq!(swapped.len(), 1);
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(outside);
}

#[test]
fn about_round_trip_in_the_root_next_to_the_flow() {
  let root = temp_root("about");
  let store = Store::new(root.clone());
  assert_eq!(store.load_about().unwrap(), None);
  let about = json!({ "version": 1, "name": "佐藤", "text": "ライフコーチをしています。" });
  store.save_about(&about).unwrap();
  assert_eq!(store.load_about().unwrap(), Some(about.clone()));
  // 保存先の直下の about.json（フローとは別のファイル。app data の設定には置かない）
  assert!(root.join("about.json").is_file());
  store
    .save_flow(&json!({ "version": 1, "id": "f", "name": "f", "revision": 1, "guide": "", "terms": [], "samples": [], "steps": [] }))
    .unwrap();
  assert_eq!(store.load_about().unwrap(), Some(about));
  // 空でも保存できる（消した状態）
  let empty = json!({ "version": 1, "name": "", "text": "" });
  store.save_about(&empty).unwrap();
  assert_eq!(store.load_about().unwrap(), Some(empty));
  // 保存先を変えたら、新しい保存先の about.json を読む
  let other = temp_root("about-other");
  assert_eq!(Store::new(other.clone()).load_about().unwrap(), None);
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(other);
}

#[test]
fn about_over_the_limit_or_malformed_is_not_saved() {
  let root = temp_root("about-limit");
  let store = Store::new(root.clone());
  let saved = json!({ "version": 1, "name": "佐藤", "text": "前の内容" });
  store.save_about(&saved).unwrap();
  // 字数は文字（コードポイント）で数える。2,000 字ちょうどは通り、1 字超えは断る（バイト数ではない）
  let exact = json!({ "version": 1, "name": "", "text": "あ".repeat(2_000) });
  store.save_about(&exact).unwrap();
  let astral = json!({ "version": 1, "name": "", "text": "😀".repeat(2_000) });
  store.save_about(&astral).unwrap();
  store.save_about(&saved).unwrap();
  let over = json!({ "version": 1, "name": "", "text": "あ".repeat(2_001) });
  assert_eq!(store.save_about(&over).unwrap_err().code, "store_bad_about");
  for bad in [
    json!({ "version": 2, "name": "", "text": "" }),
    json!({ "name": "", "text": "" }),
    json!({ "version": 1, "name": 1, "text": "" }),
    json!({ "version": 1, "name": "" }),
    json!({ "version": 1, "name": "", "text": null }),
    json!("about"),
  ] {
    assert_eq!(store.save_about(&bad).unwrap_err().code, "store_bad_about", "{bad}");
  }
  // 断った保存は前の内容を壊さない
  assert_eq!(store.load_about().unwrap(), Some(saved));
  let _ = fs::remove_dir_all(root);
}

#[test]
fn execution_round_trip_is_separate_from_local_settings_and_rejects_bad_targets() {
  let root = temp_root("execution");
  let store = Store::new(root.clone());
  assert_eq!(store.load_execution().unwrap(), None);
  let own_mac = json!({ "version": 1, "route": "own_mac", "preferredMacRunnerId": "runner_mac_1" });
  store.save_execution(&own_mac).unwrap();
  assert_eq!(store.load_execution().unwrap(), Some(own_mac.clone()));
  assert!(root.join("execution.json").is_file());
  for bad in [
    json!({ "version": 1, "route": "cloud", "preferredMacRunnerId": "runner_mac_1" }),
    json!({ "version": 1, "route": "own_mac", "preferredMacRunnerId": "../runner" }),
    json!({ "version": 2, "route": "own_mac", "preferredMacRunnerId": null }),
  ] {
    assert_eq!(store.save_execution(&bad).unwrap_err().code, "store_bad_execution");
  }
  assert_eq!(store.load_execution().unwrap(), Some(own_mac));
  let _ = fs::remove_dir_all(root);
}

#[test]
fn about_through_a_symlink_is_refused() {
  let root = temp_root("about-symlink");
  let store = Store::new(root.clone());
  let outside = temp_root("about-symlink-outside");
  fs::create_dir_all(&outside).unwrap();
  fs::write(outside.join("target.json"), "{}").unwrap();
  fs::create_dir_all(&root).unwrap();
  #[cfg(unix)]
  {
    std::os::unix::fs::symlink(outside.join("target.json"), root.join("about.json")).unwrap();
    assert_eq!(store.load_about().unwrap_err().code, "store_symlink");
    let about = json!({ "version": 1, "name": "", "text": "x" });
    assert_eq!(store.save_about(&about).unwrap_err().code, "store_symlink");
    assert_eq!(fs::read_to_string(outside.join("target.json")).unwrap(), "{}");
  }
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(outside);
}

#[test]
fn symlinks_inside_the_root_are_refused() {
  let root = temp_root("symlink");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&project("リンク"), Some("本文"), None, &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let outside = temp_root("symlink-outside");
  fs::create_dir_all(&outside).unwrap();
  #[cfg(unix)]
  {
    std::os::unix::fs::symlink(&outside, root.join(format!("projects/{id}/artifacts"))).unwrap();
    let error = store
      .save_artifact(&id, ROOT, "k7m2q9xa", false, "# 本文", &json!({ "id": "r" }))
      .unwrap_err();
    assert_eq!(error.code, "store_symlink");
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
    std::os::unix::fs::symlink(&outside, root.join("projects/linked")).unwrap();
    assert!(store.load_project("linked").is_err());
    assert!(store.list_projects().unwrap().iter().all(|entry| entry.id != "linked"));
  }
  assert!(store.load_project("../x").is_err());
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(outside);
}

#[test]
fn folders_whose_project_json_is_not_the_same_id_are_not_read() {
  let root = temp_root("legacy");
  let store = Store::new(root.clone());
  // 旧形式（フォルダ名＝案件名・project.json に id が無い）と、別の案件を手で写したフォルダ
  for (folder, body) in [
    ("legacy", json!({ "version": 1, "name": "旧形式" })),
    ("copied1", json!({ "version": 1, "id": "other1", "name": "写し" })),
  ] {
    fs::create_dir_all(root.join("projects").join(folder)).unwrap();
    fs::write(
      root.join("projects").join(folder).join("project.json"),
      body.to_string(),
    )
    .unwrap();
  }
  fs::create_dir_all(root.join("projects/運営会議")).unwrap();
  fs::write(root.join("projects/運営会議/project.json"), "{}").unwrap();
  assert_eq!(store.list_projects().unwrap(), vec![]);
  assert_eq!(store.load_project("legacy").unwrap_err().code, "store_bad_json");
  assert_eq!(store.load_project("copied1").unwrap_err().code, "store_bad_json");
  assert_eq!(store.load_project("missing1").unwrap_err().code, "store_no_project");
  let _ = fs::remove_dir_all(root);
}

#[test]
fn one_run_per_project_with_a_lock_file() {
  let root = temp_root("lock");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&project("ロック"), Some("本文"), None, &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  store.acquire_run_lock(&id).unwrap();
  assert_eq!(store.acquire_run_lock(&id).unwrap_err().code, "store_busy");
  store.release_run_lock(&id).unwrap();
  store.acquire_run_lock(&id).unwrap();
  // 持ち主の居ない（落ちたアプリの）ロックは取り直せる
  store.release_run_lock(&id).unwrap();
  fs::write(root.join(format!("projects/{id}/.run.lock")), "999999").unwrap();
  store.acquire_run_lock(&id).unwrap();
  store.release_run_lock(&id).unwrap();
  let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn locks_held_by_another_app_are_told_apart_from_this_one() {
  let root = temp_root("lock-other");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&project("別の窓"), Some("本文"), None, &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  assert!(!store.has_active_run_lock().unwrap());
  assert!(!store.has_run_lock_of_another_process().unwrap());
  // この process のロックは、この窓の再起動で止められる
  store.acquire_run_lock(&id).unwrap();
  assert!(store.has_active_run_lock().unwrap());
  assert!(!store.has_run_lock_of_another_process().unwrap());
  store.release_run_lock(&id).unwrap();
  // 生きている別の process（親）のロックは止められない
  fs::write(
    root.join(format!("projects/{id}/.run.lock")),
    std::os::unix::process::parent_id().to_string(),
  )
  .unwrap();
  assert!(store.has_active_run_lock().unwrap());
  assert!(store.has_run_lock_of_another_process().unwrap());
  // 持ち主の居ないロックは数えない
  fs::write(root.join(format!("projects/{id}/.run.lock")), "999999").unwrap();
  assert!(!store.has_run_lock_of_another_process().unwrap());
  let _ = fs::remove_dir_all(root);
}

// ---- 工程（フロー）の保存（#18567 P4）: flows/<id>.json・index.json・P4 より前の active.json の移し替え ----

/// フロー 1 本（docs-core の Flow の形。お手本の文書の id は samples に）。
fn flow(id: &str, name: &str, samples: &[&str]) -> Value {
  let samples: Vec<Value> = samples
    .iter()
    .map(|sample| json!({ "id": sample, "name": format!("{sample}.md"), "chars": 2 }))
    .collect();
  json!({ "version": 1, "id": id, "name": name, "revision": 1, "guide": "", "terms": [], "samples": samples,
    "steps": [{ "id": "k7m2q9xa", "name": "議事録", "instruction": "x", "profile": "standard" }] })
}

fn flow_ids(store: &Store) -> (Vec<String>, Option<String>) {
  let list = store.list_flows().unwrap();
  let ids: Vec<String> = list
    .flows
    .iter()
    .map(|flow| flow["id"].as_str().unwrap().to_string())
    .collect();
  assert_eq!(ids, list.order, "flows は order の並び");
  (list.order, list.last_used)
}

fn read_index(root: &Path) -> Value {
  serde_json::from_str(&fs::read_to_string(root.join("flows/index.json")).unwrap()).unwrap()
}

#[test]
fn the_flow_before_p4_reads_as_the_first_flow_and_moves_on_the_first_write() {
  // 最初の書き込み（保存・複製・削除・最後に使ったフローの更新）のどれでも、先に flows/<id>.json と index.json を書いてから
  // active.json を消す
  type Write = fn(&Store) -> Result<()>;
  let writes: [(&str, Write); 4] = [
    ("save", |store| store.save_flow(&flow("flow-b", "記事制作", &[]))),
    ("duplicate", |store| {
      store.duplicate_flow("flow-a", &flow("flow-b", "議事録のコピー", &[]))
    }),
    ("last-used", |store| store.set_last_used_flow("flow-a")),
    ("delete", |store| store.delete_flow("flow-a")),
  ];
  for (name, write) in writes {
    let root = temp_root(&format!("legacy-flow-{name}"));
    let store = Store::new(root.clone());
    fs::create_dir_all(root.join("flows")).unwrap();
    let active = json!({ "version": 1, "id": "flow-a", "name": "議事録", "revision": 3, "guide": "ガイド", "terms": [],
      "samples": [], "steps": [] });
    fs::write(root.join("flows/active.json"), active.to_string()).unwrap();
    // 読むだけでは何も書かない（index が無く active.json があれば 1 本目・最後に使ったフロー）
    let list = store.list_flows().unwrap();
    assert_eq!(list.flows, vec![active.clone()], "{name}");
    assert_eq!(
      (list.order, list.last_used),
      (vec!["flow-a".to_string()], Some("flow-a".to_string())),
      "{name}"
    );
    assert!(root.join("flows/active.json").is_file(), "{name}");
    assert!(!root.join("flows/index.json").exists(), "{name}");
    assert!(!root.join("flows/flow-a.json").exists(), "{name}");

    write(&store).unwrap();
    assert!(!root.join("flows/active.json").exists(), "{name}");
    let index = read_index(&root);
    assert_eq!(index["version"], 1, "{name}");
    let (order, last_used) = flow_ids(&store);
    match name {
      "delete" => {
        assert!(!root.join("flows/flow-a.json").exists());
        assert_eq!((order, last_used), (vec![], None));
        assert_eq!(index, json!({ "version": 1, "order": [], "lastUsed": null }));
      }
      _ => {
        // 移したフローは active.json の中身のまま
        let moved: Value = serde_json::from_str(&fs::read_to_string(root.join("flows/flow-a.json")).unwrap()).unwrap();
        assert_eq!(moved, active, "{name}");
        assert_eq!(order[0], "flow-a", "{name}");
        assert_eq!(last_used.as_deref(), Some("flow-a"), "{name}");
      }
    }
    let _ = fs::remove_dir_all(root);
  }

  // 読めない active.json は移さず、消さない（新しい形は書く）
  let root = temp_root("legacy-flow-broken");
  let store = Store::new(root.clone());
  fs::create_dir_all(root.join("flows")).unwrap();
  fs::write(root.join("flows/active.json"), "{ 壊れた").unwrap();
  assert_eq!(flow_ids(&store), (vec![], None));
  store.save_flow(&flow("flow-b", "記事制作", &[])).unwrap();
  assert_eq!(
    flow_ids(&store),
    (vec!["flow-b".to_string()], Some("flow-b".to_string()))
  );
  assert_eq!(fs::read_to_string(root.join("flows/active.json")).unwrap(), "{ 壊れた");
  let _ = fs::remove_dir_all(root);
}

#[test]
fn flows_keep_their_order_and_the_last_used_one() {
  let root = temp_root("flows-order");
  let store = Store::new(root.clone());
  // どちらも無ければ空（何も書かない）
  assert_eq!(flow_ids(&store), (vec![], None));
  assert!(!root.join("flows").exists());

  // 初めてのフローが最後に使ったフローになり、あとのフローは末尾に足す
  store.save_flow(&flow("flow-a", "議事録", &[])).unwrap();
  store.save_flow(&flow("flow-b", "記事制作", &[])).unwrap();
  assert_eq!(
    flow_ids(&store),
    (vec!["flow-a".into(), "flow-b".into()], Some("flow-a".into()))
  );
  // 保存し直しても並びは変わらない
  let mut renamed = flow("flow-a", "週次の議事録", &[]);
  renamed["revision"] = json!(2);
  store.save_flow(&renamed).unwrap();
  let list = store.list_flows().unwrap();
  assert_eq!(list.flows[0]["name"], "週次の議事録");
  assert_eq!(list.order, vec!["flow-a", "flow-b"]);
  assert_eq!(
    read_index(&root),
    json!({ "version": 1, "order": ["flow-a", "flow-b"], "lastUsed": "flow-a" })
  );
  store.set_last_used_flow("flow-b").unwrap();
  assert_eq!(flow_ids(&store).1.as_deref(), Some("flow-b"));
  assert_eq!(store.set_last_used_flow("flow-x").unwrap_err().code, "store_no_flow");

  // 並びに無いファイルは後ろに id の順で足し、ファイルの無い id は外す。読めないファイル・中身の id が違うファイルは飛ばす
  fs::write(
    root.join("flows/index.json"),
    json!({ "version": 1, "order": ["flow-z", "flow-b"], "lastUsed": "flow-z" }).to_string(),
  )
  .unwrap();
  fs::write(
    root.join("flows/flow-c.json"),
    flow("flow-c", "インサイト整理", &[]).to_string(),
  )
  .unwrap();
  fs::write(root.join("flows/flow-d.json"), "{ 壊れた").unwrap();
  fs::write(
    root.join("flows/flow-e.json"),
    flow("flow-x", "id が違う", &[]).to_string(),
  )
  .unwrap();
  // Flow の形でないファイル（画面が描けない）も飛ばす
  fs::write(
    root.join("flows/flow-f.json"),
    json!({ "version": 1, "id": "flow-f", "name": "工程の欄が無い" }).to_string(),
  )
  .unwrap();
  let mut malformed_terms = flow("flow-g", "固有名詞の中身が不正", &[]);
  malformed_terms["terms"] = json!([{}]);
  fs::write(root.join("flows/flow-g.json"), malformed_terms.to_string()).unwrap();
  let mut malformed_samples = flow("flow-h", "お手本の中身が不正", &[]);
  malformed_samples["samples"] = json!([{}]);
  fs::write(root.join("flows/flow-h.json"), malformed_samples.to_string()).unwrap();
  let mut malformed_steps = flow("flow-i", "工程の中身が不正", &[]);
  malformed_steps["steps"] = json!([{}]);
  fs::write(root.join("flows/flow-i.json"), malformed_steps.to_string()).unwrap();
  fs::write(root.join("flows/memo.txt"), "x").unwrap();
  assert_eq!(
    flow_ids(&store),
    (vec!["flow-b".into(), "flow-a".into(), "flow-c".into()], None)
  );
  // 読めない index は空の並びと読み（ファイルは id の順）、次の書き込みで書き直す
  fs::write(root.join("flows/index.json"), "{ 壊れた").unwrap();
  assert_eq!(
    flow_ids(&store),
    (vec!["flow-a".into(), "flow-b".into(), "flow-c".into()], None)
  );
  store.set_last_used_flow("flow-c").unwrap();
  assert_eq!(
    read_index(&root),
    json!({ "version": 1, "order": ["flow-a", "flow-b", "flow-c"], "lastUsed": "flow-c" })
  );
  // 読めないファイルはそのまま残る
  assert_eq!(fs::read_to_string(root.join("flows/flow-d.json")).unwrap(), "{ 壊れた");
  let _ = fs::remove_dir_all(root);
}

/// お手本の文書を 1 本取り込む（本文は flows/samples/<flowId>/<sampleId>.txt）。
fn import_one_sample(store: &Store, flow_id: &str, dir: &Path, text: &str) -> String {
  fs::create_dir_all(dir).unwrap();
  let file = dir.join(format!("{flow_id}.md"));
  fs::write(&file, text).unwrap();
  store.import_sample(flow_id, &file).unwrap().id
}

#[test]
fn duplicating_a_flow_copies_its_samples_and_puts_it_right_after_the_source() {
  let root = temp_root("flows-duplicate");
  let source_dir = temp_root("flows-duplicate-src");
  let store = Store::new(root.clone());
  store.save_flow(&flow("flow-a", "議事録", &[])).unwrap();
  store.save_flow(&flow("flow-b", "記事制作", &[])).unwrap();
  let kept = import_one_sample(&store, "flow-a", &source_dir, "お手本の本文");
  // 保存していない取り込み（写しの samples に無い）は写さない
  let unsaved = import_one_sample(&store, "flow-a", &source_dir.join("2"), "保存していない本文");
  store.save_flow(&flow("flow-a", "議事録", &[kept.as_str()])).unwrap();

  store
    .duplicate_flow(
      "flow-a",
      &flow("flow-c", "議事録のコピー", &[kept.as_str(), "missing1"]),
    )
    .unwrap();
  assert_eq!(
    flow_ids(&store),
    (
      vec!["flow-a".into(), "flow-c".into(), "flow-b".into()],
      Some("flow-a".into())
    )
  );
  assert_eq!(store.list_flows().unwrap().flows[1]["name"], "議事録のコピー");
  let original = store.read_sample("flow-a", &kept).unwrap();
  assert!(original.contains("お手本の本文"));
  assert_eq!(store.read_sample("flow-c", &kept).unwrap(), original);
  assert_eq!(
    store.read_sample("flow-c", &unsaved).unwrap_err().code,
    "store_no_sample"
  );
  // 元に無い本文は写さない（読むときに見つからないと出る。元と同じ）
  assert_eq!(
    store.read_sample("flow-c", "missing1").unwrap_err().code,
    "store_no_sample"
  );
  // 写しの本文を消しても元は残る
  store.prune_samples("flow-c", &[]).unwrap();
  assert_eq!(store.read_sample("flow-a", &kept).unwrap(), original);

  // 同じ id のフロー・元の無いフロー・正しくない id は断る（何も書かない）
  for (source, copy, code) in [
    ("flow-a", flow("flow-b", "x", &[]), "store_bad_id"),
    ("flow-a", flow("flow-a", "x", &[]), "store_bad_id"),
    ("flow-x", flow("flow-d", "x", &[]), "store_no_flow"),
    ("../x", flow("flow-d", "x", &[]), "store_bad_id"),
    ("flow-a", flow("index", "x", &[]), "store_bad_id"),
  ] {
    assert_eq!(
      store.duplicate_flow(source, &copy).unwrap_err().code,
      code,
      "{source} {}",
      copy["id"]
    );
  }
  assert_eq!(store.list_flows().unwrap().order.len(), 3);
  assert!(!root.join("flows/flow-d.json").exists());
  assert_eq!(store.list_flows().unwrap().flows[2]["name"], "記事制作");
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(source_dir);
}

#[test]
fn deleting_a_flow_removes_its_file_and_samples_and_moves_the_last_used_one() {
  let root = temp_root("flows-delete");
  let source_dir = temp_root("flows-delete-src");
  let store = Store::new(root.clone());
  for (id, name) in [("flow-a", "議事録"), ("flow-b", "記事制作"), ("flow-c", "コーチング")] {
    store.save_flow(&flow(id, name, &[])).unwrap();
  }
  let sample = import_one_sample(&store, "flow-b", &source_dir, "本文");
  store
    .save_flow(&flow("flow-b", "記事制作", &[sample.as_str()]))
    .unwrap();
  store.set_last_used_flow("flow-b").unwrap();

  // 最後に使ったフローを消すと、並びの先頭が最後に使ったフローになる。お手本の本文のフォルダも消える
  store.delete_flow("flow-b").unwrap();
  assert!(!root.join("flows/flow-b.json").exists());
  assert!(!root.join("flows/samples/flow-b").exists());
  assert_eq!(
    flow_ids(&store),
    (vec!["flow-a".into(), "flow-c".into()], Some("flow-a".into()))
  );
  // 最後に使ったフローでなければ、そのまま
  store.delete_flow("flow-c").unwrap();
  assert_eq!(flow_ids(&store), (vec!["flow-a".into()], Some("flow-a".into())));
  store.delete_flow("flow-a").unwrap();
  assert_eq!(flow_ids(&store), (vec![], None));
  assert_eq!(
    read_index(&root),
    json!({ "version": 1, "order": [], "lastUsed": null })
  );
  assert_eq!(store.delete_flow("flow-a").unwrap_err().code, "store_no_flow");
  // 消した後に足すフローが、最後に使ったフローになる
  store.save_flow(&flow("flow-d", "記事制作", &[])).unwrap();
  assert_eq!(flow_ids(&store), (vec!["flow-d".into()], Some("flow-d".into())));
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(source_dir);
}

#[test]
fn flow_usage_counts_the_recordings_made_from_the_flow() {
  let root = temp_root("flows-usage");
  let store = Store::new(root.clone());
  let snapshot = |id: &str| json!({ "id": id, "steps": [] });
  // 今の形の案件（root の録音）
  let mut legacy = project("朝市");
  legacy["flowSnapshot"] = snapshot("flow-a");
  store
    .create_project(&legacy, Some("本文"), Some(&save_record("r1")), &[])
    .unwrap();
  // 録音のページを持つフォルダ（1 フォルダに録音は 1 つ。#18914）
  for (index, flow_id) in ["flow-a", "flow-a", "flow-b"].into_iter().enumerate() {
    let created = store
      .create_project(&pages_project(&format!("運営会議{index}")), None, None, &[])
      .unwrap();
    let id = created["id"].as_str().unwrap().to_string();
    let mut recording = new_recording();
    recording["flowSnapshot"] = snapshot(flow_id);
    store
      .create_page(&id, "rec", "", "2026-10-16T01:00:00.000Z", Some(&recording))
      .unwrap();
    store
      .create_page(&id, "doc", "", "2026-10-16T01:00:00.000Z", None)
      .unwrap();
  }
  assert_eq!(store.flow_usage("flow-a").unwrap(), 3);
  assert_eq!(store.flow_usage("flow-b").unwrap(), 1);
  assert_eq!(store.flow_usage("flow-c").unwrap(), 0);
  assert_eq!(store.flow_usage("../x").unwrap_err().code, "store_bad_id");
  let _ = fs::remove_dir_all(root);
}

#[test]
fn flow_ids_are_checked_and_links_are_refused() {
  let root = temp_root("flows-ids");
  let store = Store::new(root.clone());
  for bad in ["", "../x", "a/b", "A", "active", "index", ".hidden"] {
    assert_eq!(
      store.save_flow(&flow(bad, "x", &[])).unwrap_err().code,
      "store_bad_id",
      "{bad:?}"
    );
    assert_eq!(store.delete_flow(bad).unwrap_err().code, "store_bad_id", "{bad:?}");
    assert_eq!(
      store.set_last_used_flow(bad).unwrap_err().code,
      "store_bad_id",
      "{bad:?}"
    );
  }
  assert_eq!(
    store
      .save_flow(&json!({ "version": 1, "name": "id が無い" }))
      .unwrap_err()
      .code,
    "store_bad_json"
  );
  // Flow の形でないもの（画面が描けない）は書かない
  assert_eq!(
    store
      .save_flow(&json!({ "version": 1, "id": "flow-a", "name": "工程の欄が無い" }))
      .unwrap_err()
      .code,
    "store_bad_json"
  );
  assert!(!root.join("flows").exists());

  #[cfg(unix)]
  {
    let outside = temp_root("flows-ids-outside");
    fs::create_dir_all(&outside).unwrap();
    let outside_flow = flow("flow-x", "外", &[]).to_string();
    fs::write(outside.join("flow-x.json"), &outside_flow).unwrap();
    // flows/<id>.json がリンク: 一覧に出さず、上書きもしない
    store.save_flow(&flow("flow-a", "議事録", &[])).unwrap();
    std::os::unix::fs::symlink(outside.join("flow-x.json"), root.join("flows/flow-x.json")).unwrap();
    assert_eq!(flow_ids(&store).0, vec!["flow-a".to_string()]);
    assert_eq!(
      store.save_flow(&flow("flow-x", "上書き", &[])).unwrap_err().code,
      "store_symlink"
    );
    assert_eq!(fs::read_to_string(outside.join("flow-x.json")).unwrap(), outside_flow);
    fs::remove_file(root.join("flows/flow-x.json")).unwrap();
    // index.json がリンク
    fs::remove_file(root.join("flows/index.json")).unwrap();
    std::os::unix::fs::symlink(outside.join("flow-x.json"), root.join("flows/index.json")).unwrap();
    assert_eq!(store.list_flows().unwrap_err().code, "store_symlink");
    assert_eq!(
      store.save_flow(&flow("flow-b", "x", &[])).unwrap_err().code,
      "store_symlink"
    );
    fs::remove_file(root.join("flows/index.json")).unwrap();
    // お手本のフォルダがリンク: 複製・削除は何も変えずに断る（外のファイルを消さない）
    fs::create_dir_all(root.join("flows/samples")).unwrap();
    fs::write(outside.join("keepme12.txt"), "外の本文").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("flows/samples/flow-a")).unwrap();
    assert_eq!(
      store
        .duplicate_flow("flow-a", &flow("flow-c", "x", &["keepme12"]))
        .unwrap_err()
        .code,
      "store_symlink"
    );
    assert_eq!(store.delete_flow("flow-a").unwrap_err().code, "store_symlink");
    assert!(root.join("flows/flow-a.json").is_file());
    assert!(!root.join("flows/flow-c.json").exists());
    assert_eq!(fs::read_to_string(outside.join("keepme12.txt")).unwrap(), "外の本文");
    fs::remove_file(root.join("flows/samples/flow-a")).unwrap();
    // flows がリンク
    let _ = fs::remove_dir_all(root.join("flows"));
    std::os::unix::fs::symlink(&outside, root.join("flows")).unwrap();
    assert_eq!(store.list_flows().unwrap_err().code, "store_symlink");
    assert_eq!(
      store.save_flow(&flow("flow-a", "x", &[])).unwrap_err().code,
      "store_symlink"
    );
    assert_eq!(fs::read_to_string(outside.join("flow-x.json")).unwrap(), outside_flow);
    let _ = fs::remove_dir_all(outside);
  }
  let _ = fs::remove_dir_all(root);
}

#[test]
fn samples_are_imported_read_and_pruned_by_flow_and_sample_id() {
  let root = temp_root("samples");
  let outside = temp_root("samples-src");
  fs::create_dir_all(&outside).unwrap();
  let store = Store::new(root.clone());
  let first = outside.join("記事 1.md");
  let second = outside.join("記事 2.txt");
  fs::write(&first, "# 見出し\r\n\r\n本文。\n").unwrap();
  fs::write(&second, format!("{}\n\n{}", "あ".repeat(20_000), "い".repeat(20_000))).unwrap();

  let imported = store.import_sample("flow1", &first).unwrap();
  assert!(validate_id(&imported.id).is_ok());
  assert_eq!(imported.id.len(), 8);
  assert_eq!(imported.name, "記事 1.md");
  assert_eq!(imported.chars, 10);
  assert_eq!(imported.truncated_from, None);
  // 本文は flows/samples/<flowId>/<sampleId>.txt（正規化済み）
  let saved = root.join(format!("flows/samples/flow1/{}.txt", imported.id));
  assert_eq!(fs::read_to_string(&saved).unwrap(), "# 見出し\n\n本文。");
  assert_eq!(store.read_sample("flow1", &imported.id).unwrap(), "# 見出し\n\n本文。");
  let wire = serde_json::to_value(&imported).unwrap();
  assert_eq!(wire, json!({ "id": imported.id, "name": "記事 1.md", "chars": 10 }));

  let long = store.import_sample("flow1", &second).unwrap();
  assert_eq!(long.chars, 20_000);
  assert_eq!(long.truncated_from, Some(40_002));
  assert_eq!(serde_json::to_value(&long).unwrap()["truncatedFrom"], 40_002);
  assert_ne!(long.id, imported.id);

  // 取り込めないファイルは保存しない
  assert_eq!(
    store.import_sample("flow1", &outside.join("無い.md")).unwrap_err().code,
    "sample_missing"
  );
  fs::write(outside.join("古い.doc"), "x").unwrap();
  assert_eq!(
    store
      .import_sample("flow1", &outside.join("古い.doc"))
      .unwrap_err()
      .code,
    "sample_unsupported"
  );
  assert_eq!(fs::read_dir(root.join("flows/samples/flow1")).unwrap().count(), 2);

  // 不正な id
  for (flow, sample) in [
    ("../x", "abc"),
    ("Flow", "abc"),
    ("flow1", "../x"),
    ("flow1", "a/b"),
    ("flow1", ""),
  ] {
    assert_eq!(
      store.read_sample(flow, sample).unwrap_err().code,
      "store_bad_id",
      "{flow} {sample}"
    );
  }
  assert_eq!(store.import_sample("../x", &first).unwrap_err().code, "store_bad_id");
  assert_eq!(store.prune_samples("a/b", &[]).unwrap_err().code, "store_bad_id");
  assert_eq!(
    store.read_sample("flow1", "missing1").unwrap_err().code,
    "store_no_sample"
  );

  // 外したお手本の本文を消す（keep の不正な id は無視・ほかのファイルは残す）
  fs::write(root.join("flows/samples/flow1/memo.md"), "x").unwrap();
  store
    .prune_samples("flow1", &[long.id.clone(), "../x".to_string(), "".to_string()])
    .unwrap();
  assert!(!saved.exists());
  assert_eq!(
    store.read_sample("flow1", &imported.id).unwrap_err().code,
    "store_no_sample"
  );
  assert_eq!(store.read_sample("flow1", &long.id).unwrap().chars().count(), 20_000);
  assert!(root.join("flows/samples/flow1/memo.md").exists());
  // フォルダが無ければ何もしない
  store.prune_samples("flow2", &[]).unwrap();
  assert!(!root.join("flows/samples/flow2").exists());
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(outside);
}

#[test]
fn symlinks_inside_the_samples_folder_are_refused() {
  let root = temp_root("samples-link");
  let outside = temp_root("samples-link-outside");
  let source_dir = temp_root("samples-link-src");
  fs::create_dir_all(&outside).unwrap();
  fs::create_dir_all(&source_dir).unwrap();
  let source = source_dir.join("お手本.txt");
  fs::write(&source, "本文").unwrap();
  let store = Store::new(root.clone());
  #[cfg(unix)]
  {
    // flows/samples がリンク
    fs::create_dir_all(root.join("flows")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("flows/samples")).unwrap();
    assert_eq!(store.import_sample("flow1", &source).unwrap_err().code, "store_symlink");
    assert_eq!(store.read_sample("flow1", "abc").unwrap_err().code, "store_symlink");
    assert_eq!(store.prune_samples("flow1", &[]).unwrap_err().code, "store_symlink");
    assert!(fs::read_dir(&outside).unwrap().next().is_none());

    // flows/samples/<flowId> がリンク（外のファイルを消さない）
    fs::remove_file(root.join("flows/samples")).unwrap();
    fs::create_dir_all(root.join("flows/samples")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("flows/samples/flow1")).unwrap();
    fs::write(outside.join("keepme12.txt"), "外").unwrap();
    assert_eq!(store.import_sample("flow1", &source).unwrap_err().code, "store_symlink");
    assert_eq!(store.prune_samples("flow1", &[]).unwrap_err().code, "store_symlink");
    assert_eq!(
      store.read_sample("flow1", "keepme12").unwrap_err().code,
      "store_symlink"
    );
    assert!(outside.join("keepme12.txt").exists());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
  }
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(outside);
  let _ = fs::remove_dir_all(source_dir);
}

// ---- ページ（#18564 P1）: 案件＝ページの入れ物。今の案件は案件フォルダ直下を root の録音として読む ----

/// 新しい形の案件（pages: []・flowSnapshot と source を持たない。root の録音は無い）。
fn pages_project(name: &str) -> Value {
  json!({ "version": 1, "id": "", "name": name, "createdAt": "2026-10-16T00:00:00.000Z",
    "info": { "speakers": "auto", "language": "ja", "terms": [], "background": "" }, "pages": [] })
}

/// 新しい録音のページの recording.json（id は Rust が入れる）。
fn new_recording() -> Value {
  json!({ "version": 1, "id": "", "createdAt": "2026-10-16T01:00:00.000Z", "flowSnapshot": { "steps": [] },
    "source": { "kind": "audio", "audio": [] } })
}

/// 案件フォルダの中のファイル（相対パスと中身。project.json と pages/・recordings/ は除く）。
fn files_of(dir: &Path) -> BTreeMap<String, Vec<u8>> {
  fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
    for entry in fs::read_dir(dir).unwrap().filter_map(|entry| entry.ok()) {
      let path = entry.path();
      let rel = path.strip_prefix(base).unwrap().to_string_lossy().into_owned();
      if rel == "project.json" || rel == "pages" || rel == "recordings" {
        continue;
      }
      if path.is_dir() {
        walk(base, &path, out);
      } else {
        out.insert(rel, fs::read(&path).unwrap());
      }
    }
  }
  let mut out = BTreeMap::new();
  walk(dir, dir, &mut out);
  out
}

fn page_ids(store: &Store, id: &str) -> Vec<(String, String, String)> {
  let project = store.load_project(id).unwrap().project;
  let index = &project["pages"];
  index["order"]
    .as_array()
    .unwrap()
    .iter()
    .filter_map(|page_id| {
      let id = page_id.as_str()?;
      let page = &index["items"][id];
      Some((
        id.to_string(),
        match page["kind"].as_str().unwrap() {
          "document" => "doc",
          "recording" => "rec",
          kind => kind,
        }
        .to_string(),
        page["title"].as_str().unwrap_or_default().to_string(),
      ))
    })
    .collect()
}

fn recording_id(store: &Store, project_id: Option<&str>, page_id: &str) -> String {
  let pages = store.load_pages(project_id).unwrap();
  pages
    .pages
    .iter()
    .find(|page| page["id"] == page_id)
    .and_then(|page| page["recordingId"].as_str())
    .unwrap()
    .to_string()
}

fn first_recording_id(store: &Store, project_id: &str) -> String {
  let pages = store.load_pages(Some(project_id)).unwrap();
  pages
    .pages
    .iter()
    .find(|page| page["kind"] == "rec")
    .and_then(|page| page["recordingId"].as_str())
    .unwrap()
    .to_string()
}

#[test]
fn a_project_without_pages_migrates_root_recording_into_page_index_and_preserves_its_data() {
  let root = temp_root("legacy-root");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&project("朝市"), Some("本文"), Some(&save_record("r1")), &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let run = json!({ "id": "r2", "kind": "run", "stepId": "k7m2q9xa", "stepName": "発言の抽出", "result": "saved" });
  store
    .save_artifact(&id, ROOT, "k7m2q9xa", false, "# 抽出", &run)
    .unwrap();
  store
    .save_conversation(&id, ROOT, "conv-a", &json!({ "id": "conv-a", "updatedAt": "x" }))
    .unwrap();

  // 読み込み時に旧 root 録音を独立した pageId / recordingId へ一度だけ移す。
  let loaded = store.load_project(&id).unwrap();
  let page_id = loaded.project["pages"]["order"][0].as_str().unwrap();
  let rec_id = loaded.project["pages"]["items"][page_id]["recordingId"]
    .as_str()
    .unwrap();
  assert_ne!(page_id, ROOT);
  assert_ne!(rec_id, page_id);
  assert_eq!(loaded.project["pages"]["version"], 1);
  assert_eq!(loaded.project["pages"]["items"][page_id]["kind"], "recording");
  assert_eq!(loaded.recordings.len(), 1);
  assert_eq!(loaded.recordings[0].id, rec_id);
  assert_eq!(loaded.recordings[0].recording.as_ref().unwrap()["pageId"], page_id);
  assert!(loaded.recordings[0].has_transcript);
  assert_eq!(loaded.recordings[0].artifacts, vec!["k7m2q9xa".to_string()]);
  assert!(loaded.docs.is_empty());
  let wire = serde_json::to_value(&loaded).unwrap();
  assert_eq!(wire["recordings"][0]["hasTranscript"], true);
  assert_eq!(wire["recordings"][0]["recording"]["id"], rec_id);
  let rec_dir = root.join(format!("projects/{id}/recordings/{rec_id}"));
  assert!(rec_dir.join("recording.json").is_file());
  assert!(rec_dir.join("inputs/text.md").is_file());
  assert!(!root.join(format!("projects/{id}/transcript.md")).exists());
  // 旧 API の `root` も移行後の録音へ解決し、内容は従来どおり読める。
  let recording = store.load_recording(&id, ROOT).unwrap();
  assert_eq!(recording.transcript.as_deref(), Some("本文"));
  assert_eq!(recording.artifacts.get("k7m2q9xa").map(String::as_str), Some("# 抽出"));
  assert_eq!(recording.runs.len(), 2);
  assert_eq!(recording.recording.as_ref().unwrap()["pageId"], page_id);
  assert_eq!(serde_json::to_value(&recording).unwrap()["projectId"], id.as_str());
  assert_eq!(store.list_conversations(&id, ROOT).unwrap().len(), 1);

  // ページ追加は正本台帳へ追記し、既存の録音IDとデータを保つ。
  let before = files_of(&rec_dir);
  let doc = store
    .create_page(&id, "doc", "", "2026-10-16T02:00:00.000Z", None)
    .unwrap();
  let doc_id = doc["id"].as_str().unwrap().to_string();
  assert!(validate_id(&doc_id).is_ok());
  assert_eq!(doc["kind"], "doc");
  assert_eq!(doc["createdAt"], "2026-10-16T02:00:00.000Z");
  assert_eq!(
    page_ids(&store, &id),
    vec![
      (page_id.to_string(), "rec".to_string(), "".to_string()),
      (doc_id.clone(), "doc".to_string(), "".to_string())
    ]
  );
  let pages = store.load_project(&id).unwrap().project["pages"].clone();
  assert_eq!(pages["items"][page_id]["createdAt"], "2026-10-15T00:00:00.000Z");
  assert_eq!(pages["items"][page_id]["recordingId"], rec_id);
  assert_eq!(files_of(&rec_dir), before);
  assert_eq!(
    fs::read_to_string(root.join(format!("projects/{id}/pages/{doc_id}.md"))).unwrap(),
    ""
  );
  // 2 回目からは末尾に足すだけ
  let second = store
    .create_page(&id, "doc", "メモ", "2026-10-16T03:00:00.000Z", None)
    .unwrap();
  let listed = page_ids(&store, &id);
  assert_eq!(listed.len(), 3);
  assert_eq!(
    listed[2],
    (
      second["id"].as_str().unwrap().to_string(),
      "doc".to_string(),
      "メモ".to_string()
    )
  );
  let loaded = store.load_project(&id).unwrap();
  assert_eq!(loaded.recordings.len(), 1);
  assert_eq!(
    loaded.docs.iter().map(|doc| doc.id.clone()).collect::<Vec<_>>(),
    vec![doc_id, second["id"].as_str().unwrap().to_string()]
  );
  assert!(loaded.docs[0].updated_ms > 0);
  assert!(
    serde_json::to_value(&loaded).unwrap()["docs"][0]["updatedMs"]
      .as_u64()
      .unwrap()
      > 0
  );
  assert_eq!(files_of(&rec_dir), before);
  let _ = fs::remove_dir_all(root);
}

#[test]
fn a_new_style_project_has_no_root_recording() {
  let root = temp_root("new-style");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&pages_project("佐藤さん コーチング"), None, None, &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let loaded = store.load_project(&id).unwrap();
  assert!(loaded.recordings.is_empty() && loaded.docs.is_empty());
  assert_eq!(
    loaded.project["pages"],
    json!({ "version": 1, "order": [], "items": {} })
  );
  for error in [
    store.load_recording(&id, ROOT).unwrap_err(),
    store
      .save_artifact(&id, ROOT, "k7m2q9xa", false, "x", &json!({}))
      .unwrap_err(),
    store.audio_paths(&id, ROOT).unwrap_err(),
    store.list_conversations(&id, ROOT).unwrap_err(),
  ] {
    assert_eq!(error.code, "store_no_recording");
  }
  assert_eq!(store.rename_page(&id, ROOT, "x").unwrap_err().code, "store_no_page");
  // 案件情報の保存は音声の写しを持たない（inputs/ に触れない）
  let mut renamed = loaded.project.clone();
  renamed["name"] = json!("佐藤さん");
  store.save_project(&id, &renamed).unwrap();
  assert_eq!(store.load_project(&id).unwrap().project["name"], "佐藤さん");
  // 最初のページは root を足さない
  let doc = store
    .create_page(&id, "doc", "", "2026-10-16T02:00:00.000Z", None)
    .unwrap();
  assert_eq!(
    page_ids(&store, &id),
    vec![(
      doc["id"].as_str().unwrap().to_string(),
      "doc".to_string(),
      "".to_string()
    )]
  );
  let _ = fs::remove_dir_all(root);
}

#[test]
fn a_folder_recording_goes_first_even_when_added_after_pages() {
  // フォルダの中は 背景情報 › 工程のページ › 自分のページ の順（owner 2026-10-18・#18914）。文書の後から音声を足しても録音は先頭
  let root = temp_root("recording-first");
  let store = Store::new(root.clone());
  let id = store.create_project(&pages_project("取材"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store.create_page(&id, "doc", "事前メモ", "", None).unwrap();
  store.create_page(&id, "doc", "質問", "", None).unwrap();
  store
    .create_page(&id, "rec", "", "2026-10-16T01:00:00.000Z", Some(&new_recording()))
    .unwrap();
  assert_eq!(
    page_ids(&store, &id)
      .iter()
      .map(|page| page.1.clone())
      .collect::<Vec<_>>(),
    vec!["rec".to_string(), "doc".to_string(), "doc".to_string()]
  );
}

#[test]
fn folder_documents_keep_creation_order_behind_recording_outputs() {
  let root = temp_root("folder-document-order");
  let store = Store::new(root.clone());
  let id = store.create_project(&pages_project("取材"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store.create_page(&id, "doc", "最初", "", None).unwrap();
  store
    .create_page(&id, "rec", "", "2026-10-16T01:00:00.000Z", Some(&new_recording()))
    .unwrap();
  store.create_page(&id, "doc", "後から追加", "", None).unwrap();
  assert_eq!(
    page_ids(&store, &id)
      .iter()
      .map(|page| (page.1.clone(), page.2.clone()))
      .collect::<Vec<_>>(),
    vec![
      ("rec".to_string(), "".to_string()),
      ("doc".to_string(), "最初".to_string()),
      ("doc".to_string(), "後から追加".to_string()),
    ]
  );
  let _ = fs::remove_dir_all(root);
}

#[test]
fn a_folder_keeps_one_recording_and_refuses_a_second_one() {
  // 1 フォルダに録音（音声 1 セット）は 1 つ（owner 2026-10-18・#18914）。文書は何枚でも、フォルダの外は今のまま
  let root = temp_root("one-recording");
  let store = Store::new(root.clone());
  let id = store.create_project(&pages_project("取材"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let rec = store
    .create_page(&id, "rec", "", "2026-10-16T01:00:00.000Z", Some(&new_recording()))
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store.create_page(&id, "doc", "メモ", "", None).unwrap();
  let refused = store
    .create_page(&id, "rec", "", "2026-10-16T02:00:00.000Z", Some(&new_recording()))
    .unwrap_err();
  assert_eq!(refused.code, "store_folder_has_recording");
  assert_eq!(
    refused.message,
    "このフォルダにはもう音声があります。背景情報のページで音声を追加してください。"
  );
  // 断ったときは一覧も recordings/ も変えない
  assert_eq!(
    page_ids(&store, &id)
      .iter()
      .map(|page| page.1.clone())
      .collect::<Vec<_>>(),
    vec!["rec".to_string(), "doc".to_string()]
  );
  assert_eq!(
    fs::read_dir(root.join(format!("projects/{id}/recordings")))
      .unwrap()
      .count(),
    1
  );

  // フォルダの外は今のまま（以前のデータ）。録音のあるフォルダへは移せず、録音の無いフォルダへは移せる
  let outside = store
    .create_page_at(None, "rec", "外", "2026-10-16T03:00:00.000Z", Some(&new_recording()))
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store
    .create_page_at(None, "rec", "外 2", "2026-10-16T04:00:00.000Z", Some(&new_recording()))
    .unwrap();
  let moved = store.move_page(None, &outside, Some(&id)).unwrap_err();
  assert_eq!(moved.code, "store_folder_has_recording");
  assert_eq!(page_ids(&store, &id).len(), 2);
  let empty = store.create_project(&pages_project("空"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store.move_page(None, &outside, Some(&empty)).unwrap();
  assert_eq!(page_ids(&store, &empty).len(), 1);

  // 録音を消せば、もう一度作れる
  store.delete_page(&id, &rec).unwrap();
  store
    .create_page(&id, "rec", "", "2026-10-16T05:00:00.000Z", Some(&new_recording()))
    .unwrap();
  let _ = fs::remove_dir_all(root);
}

#[test]
fn recordings_keep_versions_runs_checkpoints_and_conversations_apart_from_root() {
  let root = temp_root("recordings");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&project("朝市"), Some("root の本文"), Some(&save_record("r1")), &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  // root もフォルダの録音なので、同じフォルダには 2 つ目を作らない（1 フォルダ 1 音声。#18914）
  assert_eq!(
    store
      .create_page(&id, "rec", "", "2026-10-16T01:00:00.000Z", Some(&new_recording()))
      .unwrap_err()
      .code,
    "store_folder_has_recording"
  );
  let rid = store
    .create_project(&pages_project("朝市の録音"), None, None, &[])
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let entry = store
    .create_page(&rid, "rec", "", "2026-10-16T01:00:00.000Z", Some(&new_recording()))
    .unwrap();
  let page_id = entry["id"].as_str().unwrap().to_string();
  let rec = entry["recordingId"].as_str().unwrap().to_string();
  assert_eq!(entry["kind"], "rec");
  let rec_dir = root.join(format!("projects/{rid}/recordings/{rec}"));
  assert!(rec_dir.join("inputs").is_dir());
  let stored: Value = serde_json::from_str(&fs::read_to_string(rec_dir.join("recording.json")).unwrap()).unwrap();
  assert_eq!(stored["id"], rec.as_str());
  assert_eq!(stored["pageId"], page_id);
  assert_eq!(stored["source"], json!({ "kind": "audio", "audio": [] }));

  let run = json!({ "id": "r2", "kind": "run", "stepId": "k7m2q9xa", "stepName": "発言の抽出", "result": "saved" });
  assert_eq!(
    store
      .save_artifact(&rid, &rec, "k7m2q9xa", false, "# 録音の抽出", &run)
      .unwrap(),
    1
  );
  store
    .append_run(&rid, &rec, &json!({ "id": "r3", "result": "failed" }))
    .unwrap();
  store
    .save_checkpoint(&rid, &rec, "r3", &json!({ "output": "途中" }))
    .unwrap();
  store
    .save_conversation(&rid, &rec, "conv-r", &json!({ "id": "conv-r", "updatedAt": "x" }))
    .unwrap();
  assert!(rec_dir.join("artifacts/k7m2q9xa.md").is_file());
  let saved = store.load_recording(&rid, &rec).unwrap().runs;
  let version_path = saved
    .iter()
    .find(|row| row["id"] == "r2")
    .and_then(|row| row["versionPath"].as_str())
    .unwrap()
    .to_string();
  assert!(
    version_path.starts_with(&format!("recordings/{rec}/versions/k7m2q9xa/v_")),
    "{version_path}"
  );
  assert!(root.join(format!("projects/{rid}/{version_path}")).is_file());
  assert!(rec_dir.join("runs/r3.json").is_file());
  assert!(rec_dir.join("conversations/conv-r.json").is_file());
  assert_eq!(store.read_version(&rid, &rec, "k7m2q9xa", 1).unwrap(), "# 録音の抽出");
  assert_eq!(
    store.read_checkpoint(&rid, &rec, "r3").unwrap().unwrap()["output"],
    "途中"
  );
  assert!(store
    .artifact_path(&rid, &rec, "k7m2q9xa", false)
    .unwrap()
    .ends_with(format!("recordings/{rec}/artifacts/k7m2q9xa.md")));
  let folder = store.chat_folder(&rid, &rec).unwrap();
  assert!(folder.ends_with(format!("recordings/{rec}")));
  assert_eq!(store.artifact_states(&rid, &rec).unwrap().len(), 1);

  // root と混ざらない
  let root_recording_id = first_recording_id(&store, &id);
  let root_view = store.load_recording(&id, ROOT).unwrap();
  assert!(root_view.artifacts.is_empty());
  assert_eq!(root_view.runs.len(), 1);
  assert_eq!(root_view.transcript.as_deref(), Some("root の本文"));
  // root の文書の状態は root の文字起こし（source）だけ（録音の成果物は入らない）
  let root_states = store.artifact_states(&id, ROOT).unwrap();
  assert_eq!(
    root_states
      .iter()
      .map(|state| state.step_id.as_str())
      .collect::<Vec<_>>(),
    vec!["source"]
  );
  assert!(store.list_conversations(&id, ROOT).unwrap().is_empty());
  assert_eq!(store.read_checkpoint(&id, ROOT, "r3").unwrap(), None);
  let recording = store.load_recording(&rid, &rec).unwrap();
  assert_eq!(recording.recording.as_ref().unwrap()["id"], rec.as_str());
  assert_eq!(recording.transcript, None);
  assert_eq!(
    recording.artifacts.get("k7m2q9xa").map(String::as_str),
    Some("# 録音の抽出")
  );
  assert_eq!(recording.runs.len(), 2);
  assert_eq!(store.list_conversations(&rid, &rec).unwrap().len(), 1);
  let loaded = store.load_project(&id).unwrap();
  assert_eq!(
    loaded
      .recordings
      .iter()
      .map(|entry| entry.id.clone())
      .collect::<Vec<_>>(),
    vec![root_recording_id.clone()]
  );
  let loaded = store.load_project(&rid).unwrap();
  assert_eq!(
    loaded
      .recordings
      .iter()
      .map(|entry| entry.id.clone())
      .collect::<Vec<_>>(),
    vec![rec.clone()]
  );
  assert_eq!(loaded.recordings[0].artifacts, vec!["k7m2q9xa".to_string()]);
  assert!(!loaded.recordings[0].has_transcript);

  // 使用量: root と録音の記録を、案件と録音の id を付けて
  let runs = store.list_all_runs().unwrap();
  assert_eq!(runs.len(), 3);
  assert_eq!(
    runs
      .iter()
      .filter(|run| run["recording"] == rec.as_str() && run["project"] == rid.as_str())
      .count(),
    2
  );
  assert_eq!(
    runs
      .iter()
      .filter(|run| run["recording"] == root_recording_id && run["project"] == id.as_str())
      .count(),
    1
  );

  // 読めない recording.json の録音は、案件を開けなくせずに一覧から外す
  fs::write(rec_dir.join("recording.json"), "{").unwrap();
  let loaded = store.load_project(&rid).unwrap();
  assert!(loaded.recordings.is_empty());
  assert_eq!(store.load_recording(&rid, &rec).unwrap_err().code, "store_no_recording");
  let _ = fs::remove_dir_all(root);
}

#[test]
fn recording_and_page_ids_are_checked_and_links_are_refused() {
  let root = temp_root("page-ids");
  let store = Store::new(root.clone());
  let created = store.create_project(&pages_project("確かめ"), None, None, &[]).unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let too_long = "a".repeat(65);
  for bad in ["../x", "", "A", "a/b", too_long.as_str()] {
    assert_eq!(
      store.load_recording(&id, bad).unwrap_err().code,
      "store_bad_id",
      "{bad:?}"
    );
    assert_eq!(store.read_page(&id, bad).unwrap_err().code, "store_bad_id", "{bad:?}");
    assert!(store
      .save_artifact(&id, bad, "k7m2q9xa", false, "x", &json!({}))
      .is_err());
  }
  // 無い録音・id の食い違う recording.json は読まない
  assert_eq!(
    store.load_recording(&id, "missing123").unwrap_err().code,
    "store_no_recording"
  );
  fs::create_dir_all(root.join(format!("projects/{id}/recordings/copied1234"))).unwrap();
  fs::write(
    root.join(format!("projects/{id}/recordings/copied1234/recording.json")),
    json!({ "id": "other12345" }).to_string(),
  )
  .unwrap();
  assert_eq!(
    store.load_recording(&id, "copied1234").unwrap_err().code,
    "store_no_recording"
  );
  assert_eq!(store.read_page(&id, "missing123").unwrap_err().code, "store_no_page");
  assert_eq!(
    store.create_page(&id, "sheet", "", "", None).unwrap_err().code,
    "store_bad_page"
  );
  assert_eq!(
    store.create_page(&id, "rec", "", "", None).unwrap_err().code,
    "store_bad_json"
  );
  #[cfg(unix)]
  {
    let outside = temp_root("page-ids-outside");
    fs::create_dir_all(&outside).unwrap();
    // recordings/ がリンク
    fs::remove_dir_all(root.join(format!("projects/{id}/recordings"))).unwrap();
    std::os::unix::fs::symlink(&outside, root.join(format!("projects/{id}/recordings"))).unwrap();
    assert_eq!(
      store
        .create_page(&id, "rec", "", "", Some(&new_recording()))
        .unwrap_err()
        .code,
      "store_symlink"
    );
    assert_eq!(store.load_recording(&id, "abc").unwrap_err().code, "store_symlink");
    // pages/ がリンク
    std::os::unix::fs::symlink(&outside, root.join(format!("projects/{id}/pages"))).unwrap();
    assert_eq!(
      store.create_page(&id, "doc", "", "", None).unwrap_err().code,
      "store_symlink"
    );
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
    let _ = fs::remove_dir_all(&outside);
  }
  let _ = fs::remove_dir_all(root);
}

#[test]
fn save_project_keeps_the_pages_on_disk() {
  let root = temp_root("keep-pages");
  let store = Store::new(root.clone());
  let created = store.create_project(&project("朝市"), Some("本文"), None, &[]).unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  // 画面の古い値（pages の無い・古い pages）で保存しても、ディスクの pages は消えない
  let stale = store.load_project(&id).unwrap().project;
  let doc = store
    .create_page(&id, "doc", "メモ", "2026-10-16T02:00:00.000Z", None)
    .unwrap();
  let mut renamed = stale.clone();
  renamed["name"] = json!("朝市 2");
  store.save_project(&id, &renamed).unwrap();
  let mut with_old_pages = renamed.clone();
  with_old_pages["pages"] = json!([{ "id": "zzzz222222", "kind": "doc", "title": "古い", "createdAt": "" }]);
  store.save_project(&id, &with_old_pages).unwrap();
  let saved = store.load_project(&id).unwrap();
  assert_eq!(saved.project["name"], "朝市 2");
  assert_eq!(saved.project["pages"]["order"].as_array().unwrap().len(), 2);
  assert_eq!(saved.project["pages"]["order"][1], doc["id"]);
  // pages がまだ無い案件では、画面から来た pages を書かない
  let other = store.create_project(&pages_project("別"), None, None, &[]).unwrap();
  let other_id = other["id"].as_str().unwrap().to_string();
  let mut injected = store.load_project(&other_id).unwrap().project;
  injected["pages"] = json!([]);
  store.save_project(&other_id, &injected).unwrap();
  assert_eq!(
    store.load_project(&other_id).unwrap().project["pages"],
    json!({ "version": 1, "order": [], "items": {} })
  );
  let _ = fs::remove_dir_all(root);
}

#[test]
fn doc_pages_are_read_written_renamed_and_deleted() {
  let root = temp_root("doc-pages");
  let store = Store::new(root.clone());
  let created = store.create_project(&project("朝市"), Some("本文"), None, &[]).unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  // root の名前を変えると pages を初期化してから書く
  store.rename_page(&id, ROOT, "第1回 セッション").unwrap();
  let root_page_id = page_ids(&store, &id)[0].0.clone();
  assert_eq!(
    page_ids(&store, &id),
    vec![(root_page_id, "rec".to_string(), "第1回 セッション".to_string())]
  );
  let doc = store
    .create_page(&id, "doc", "", "2026-10-16T02:00:00.000Z", None)
    .unwrap();
  let doc_id = doc["id"].as_str().unwrap().to_string();
  assert_eq!(store.read_page(&id, &doc_id).unwrap(), "");
  store.write_page(&id, &doc_id, "# 事前メモ\n\n- 問い\n").unwrap();
  assert_eq!(store.read_page(&id, &doc_id).unwrap(), "# 事前メモ\n\n- 問い\n");
  // 本文のファイルが無くなっても空として読む
  fs::remove_file(root.join(format!("projects/{id}/pages/{doc_id}.md"))).unwrap();
  assert_eq!(store.read_page(&id, &doc_id).unwrap(), "");
  store.write_page(&id, &doc_id, "書き直し").unwrap();
  store.rename_page(&id, &doc_id, "事前メモ").unwrap();
  assert_eq!(page_ids(&store, &id)[1].2, "事前メモ");
  assert_eq!(
    store.rename_page(&id, "missing123", "x").unwrap_err().code,
    "store_no_page"
  );
  // 録音のページは文書として読み書きしない（消すのは録音の削除。下の deleting_* のテスト）
  assert_eq!(store.read_page(&id, ROOT).unwrap_err().code, "store_no_page");
  assert_eq!(store.write_page(&id, ROOT, "x").unwrap_err().code, "store_no_page");
  assert_eq!(store.delete_page(&id, "missing123").unwrap_err().code, "store_no_page");
  store.delete_page(&id, &doc_id).unwrap();
  assert!(!root.join(format!("projects/{id}/pages/{doc_id}.md")).exists());
  assert_eq!(page_ids(&store, &id).len(), 1);
  assert_eq!(store.read_page(&id, &doc_id).unwrap_err().code, "store_no_page");
  let _ = fs::remove_dir_all(root);
}

// ---- 録音のページの削除（#18566 P3） ----

/// 録音に成果物・版・記録・checkpoint・会話を置く。
fn fill_recording(store: &Store, id: &str, rec: &str) {
  let run = json!({ "id": "r2", "kind": "run", "stepId": "k7m2q9xa", "stepName": "議事録", "result": "saved" });
  store
    .save_artifact(id, rec, "k7m2q9xa", false, "# 議事録", &run)
    .unwrap();
  store
    .save_checkpoint(id, rec, "r2", &json!({ "output": "途中" }))
    .unwrap();
  store
    .save_conversation(id, rec, "conv-a", &json!({ "id": "conv-a", "updatedAt": "x" }))
    .unwrap();
}

#[test]
fn deleting_a_recording_page_removes_its_folder_and_keeps_the_other_pages() {
  let root = temp_root("delete-rec");
  let audio_dir = temp_root("delete-rec-audio");
  fs::create_dir_all(&audio_dir).unwrap();
  fs::write(audio_dir.join("1.m4a"), b"abc").unwrap();
  let store = Store::new(root.clone());
  let created = store
    .create_project(&pages_project("佐藤さん"), None, None, &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let doc = store.create_page(&id, "doc", "事前メモ", "", None).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store.write_page(&id, &doc, "- 問い\n").unwrap();
  // 1 フォルダに録音は 1 つ（#18914）。ほかの録音は別のフォルダに置く
  let other = store
    .create_project(&pages_project("鈴木さん"), None, None, &[])
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let mut recs = Vec::new();
  for folder in [&id, &other] {
    let page_id = store
      .create_page(folder, "rec", "", "2026-10-16T01:00:00.000Z", Some(&new_recording()))
      .unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    fill_recording(&store, folder, &page_id);
    let rec_id = recording_id(&store, Some(folder), &page_id);
    recs.push((page_id, rec_id));
  }
  let (first, first_recording) = recs[0].clone();
  let (second, _) = recs[1].clone();
  // 1 つ目の録音に音声の写しも置く
  let audio = store
    .import_audio(&id, &first, &[audio_dir.join("1.m4a")], &[])
    .unwrap();
  let mut recording = store.load_recording(&id, &first).unwrap().recording.unwrap();
  recording["source"]["audio"] = json!(audio);
  store.save_recording(&id, &first, &recording).unwrap();
  let first_dir = root.join(format!("projects/{id}/recordings/{first_recording}"));
  assert!(first_dir.join("inputs").read_dir().unwrap().next().is_some());

  store.delete_page(&id, &first).unwrap();
  assert!(!first_dir.exists());
  assert_eq!(
    page_ids(&store, &id)
      .iter()
      .map(|page| page.0.clone())
      .collect::<Vec<_>>(),
    vec![doc.clone()]
  );
  assert_eq!(
    store.load_recording(&id, &first).unwrap_err().code,
    "store_no_recording"
  );
  // ほかの録音・文書は残る
  let kept = store.load_recording(&other, &second).unwrap();
  assert_eq!(kept.artifacts.get("k7m2q9xa").map(String::as_str), Some("# 議事録"));
  assert_eq!(kept.runs.len(), 1);
  assert_eq!(store.list_conversations(&other, &second).unwrap().len(), 1);
  assert_eq!(store.read_page(&id, &doc).unwrap(), "- 問い\n");
  assert!(store.load_project(&id).unwrap().recordings.is_empty());
  assert_eq!(store.load_project(&other).unwrap().recordings.len(), 1);
  // 使用量からも外れる
  assert!(store
    .list_all_runs()
    .unwrap()
    .iter()
    .all(|run| run["recording"] != first_recording.as_str()));
  assert_eq!(store.delete_page(&id, &first).unwrap_err().code, "store_no_page");
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(audio_dir);
}

#[test]
fn deleting_the_root_recording_removes_its_files_and_keeps_the_project() {
  let root = temp_root("delete-root");
  let audio_dir = temp_root("delete-root-audio");
  fs::create_dir_all(&audio_dir).unwrap();
  fs::write(audio_dir.join("1.m4a"), b"abc").unwrap();
  let store = Store::new(root.clone());
  let mut legacy = project("朝市");
  legacy["source"] = json!({ "kind": "audio", "audio": [] });
  legacy["info"] = json!({ "speakers": "2", "language": "ja", "terms": [], "background": "朝市の取材" });
  let created = store
    .create_project(&legacy, None, None, &[audio_dir.join("1.m4a")])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let dir = root.join(format!("projects/{id}"));
  store
    .save_artifact(&id, ROOT, "source", true, "[00:00:01] 本文", &save_record("s1"))
    .unwrap();
  fill_recording(&store, &id, ROOT);
  let doc = store.create_page(&id, "doc", "事前メモ", "", None).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store.write_page(&id, &doc, "メモ").unwrap();
  // root もフォルダの録音（1 フォルダ 1 音声。#18914）なので、2 つ目は作らない
  assert_eq!(
    store
      .create_page(&id, "rec", "", "", Some(&new_recording()))
      .unwrap_err()
      .code,
    "store_folder_has_recording"
  );
  let root_rec = first_recording_id(&store, &id);
  let root_rec_dir = dir.join(format!("recordings/{root_rec}"));
  let migrated_root = store.load_recording(&id, &root_rec).unwrap().recording.unwrap();
  assert_eq!(migrated_root["speakers"], "2");
  assert_eq!(migrated_root["language"], "ja");
  let mut with_refs = store.load_project(&id).unwrap().project;
  with_refs["refs"] = json!([doc.clone()]);
  store.save_project(&id, &with_refs).unwrap();
  for name in ROOT_RECORDING_FILES {
    assert!(root_rec_dir.join(name).exists(), "{name}");
  }

  store.delete_page(&id, ROOT).unwrap();
  for name in ROOT_RECORDING_FILES {
    assert!(!root_rec_dir.join(name).exists(), "{name}");
  }
  let saved = store.load_project(&id).unwrap().project;
  for key in ["flowSnapshot", "source", "refs", "candidateSets"] {
    assert!(saved.get(key).is_none(), "{key}");
  }
  // フォルダの共有情報・ほかのページは残る。録音の話者数と言語は録音と一緒に削除される。
  assert_eq!(saved["name"], "朝市");
  assert_eq!(saved["info"]["background"], "朝市の取材");
  assert!(saved["info"].get("speakers").is_none());
  assert_eq!(
    page_ids(&store, &id)
      .iter()
      .map(|page| page.0.clone())
      .collect::<Vec<_>>(),
    vec![doc.clone()]
  );
  assert_eq!(store.load_recording(&id, ROOT).unwrap_err().code, "store_no_recording");
  assert_eq!(store.read_page(&id, &doc).unwrap(), "メモ");
  assert!(dir.join("project.json").is_file());
  // root を消したフォルダには、新しい録音を 1 つ作れる
  let rec = store.create_page(&id, "rec", "", "", Some(&new_recording())).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let rec_storage_id = recording_id(&store, Some(&id), &rec);
  assert!(dir
    .join(format!("recordings/{rec_storage_id}/recording.json"))
    .is_file());
  assert!(store
    .list_all_runs()
    .unwrap()
    .iter()
    .all(|run| run["recording"] != ROOT));

  // pages の無い今の案件は、root を消すと空の pages を書く
  let only = store
    .create_project(&project("root だけ"), Some("本文"), Some(&save_record("s2")), &[])
    .unwrap();
  let only_id = only["id"].as_str().unwrap().to_string();
  let only_rec = first_recording_id(&store, &only_id);
  store.delete_page(&only_id, ROOT).unwrap();
  let emptied = store.load_project(&only_id).unwrap();
  assert_eq!(
    emptied.project["pages"],
    json!({ "version": 1, "order": [], "items": {} })
  );
  assert!(emptied.recordings.is_empty());
  assert!(!root.join(format!("projects/{only_id}/recordings/{only_rec}")).exists());
  assert_eq!(store.delete_page(&only_id, ROOT).unwrap_err().code, "store_no_page");
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(audio_dir);
}

#[test]
fn deleting_an_empty_folder_removes_only_empty_project_data() {
  let root = temp_root("delete-empty-folder");
  let store = Store::new(root.clone());
  let created = store.create_project(&pages_project("空"), None, None, &[]).unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let dir = root.join(format!("projects/{id}"));
  fs::create_dir_all(dir.join("pages")).unwrap();
  fs::create_dir_all(dir.join("recordings")).unwrap();
  fs::create_dir_all(dir.join("inputs")).unwrap();

  store.acquire_run_lock(&id).unwrap();
  assert_eq!(store.delete_empty_folder(&id).unwrap_err().code, "store_busy");
  store.release_run_lock(&id).unwrap();
  store.delete_empty_folder(&id).unwrap();
  assert!(!dir.exists());
  assert!(store.list_projects().unwrap().is_empty());

  let mut with_background = pages_project("背景あり");
  with_background["info"]["background"] = json!("共有情報");
  let mut with_terms = pages_project("固有名詞あり");
  with_terms["info"]["terms"] = json!(["鎌倉"]);
  let mut with_entities = pages_project("登場人物あり");
  with_entities["info"]["entities"] = json!([{ "id": "person1", "name": "佐藤" }]);
  for project in [with_background, with_terms, with_entities] {
    let created = store.create_project(&project, None, None, &[]).unwrap();
    let project_id = created["id"].as_str().unwrap();
    assert_eq!(
      store.delete_empty_folder(project_id).unwrap_err().code,
      "store_folder_not_empty"
    );
  }

  let created = store
    .create_project(&pages_project("ページあり"), None, None, &[])
    .unwrap();
  let project_id = created["id"].as_str().unwrap();
  store
    .create_page(project_id, "doc", "メモ", "2026-10-16T02:00:00.000Z", None)
    .unwrap();
  assert_eq!(
    store.delete_empty_folder(project_id).unwrap_err().code,
    "store_folder_not_empty"
  );

  let created = store
    .create_project(&pages_project("追加ファイルあり"), None, None, &[])
    .unwrap();
  let project_id = created["id"].as_str().unwrap();
  let dir = root.join(format!("projects/{project_id}"));
  fs::write(dir.join("unexpected.json"), "keep").unwrap();
  assert_eq!(
    store.delete_empty_folder(project_id).unwrap_err().code,
    "store_folder_not_empty"
  );
  assert_eq!(fs::read_to_string(dir.join("unexpected.json")).unwrap(), "keep");
  let _ = fs::remove_dir_all(root);
}

#[test]
fn deleting_a_document_removes_its_chat_and_empty_parent() {
  let root = temp_root("delete-doc-chat");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&pages_project("文書会話"), None, None, &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let page = store.create_page(&id, "doc", "メモ", "", None).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let chat_dir = root.join(format!("projects/{id}/page-chats/{page}"));
  fs::create_dir_all(chat_dir.join("conversations")).unwrap();
  fs::write(chat_dir.join("conversations/conv1.json"), "{}").unwrap();

  store.delete_page(&id, &page).unwrap();
  assert!(!chat_dir.exists());
  assert!(!chat_dir.parent().unwrap().exists());

  // 古い実行で残った空の親も、空フォルダ削除を妨げない。
  let project_dir = root.join(format!("projects/{id}"));
  fs::create_dir_all(project_dir.join("page-chats")).unwrap();
  store.delete_empty_folder(&id).unwrap();
  assert!(!project_dir.exists());
  let _ = fs::remove_dir_all(root);
}

#[test]
fn recording_pages_are_not_deleted_while_the_project_runs() {
  let root = temp_root("delete-busy");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&project("朝市"), Some("本文"), Some(&save_record("s1")), &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  // 1 フォルダに録音は 1 つ（#18914）。root ではない録音は別のフォルダに置く
  let other = store
    .create_project(&pages_project("運営会議"), None, None, &[])
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let rec = store
    .create_page(&other, "rec", "", "", Some(&new_recording()))
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let rec_storage_id = recording_id(&store, Some(&other), &rec);
  let root_storage_id = first_recording_id(&store, &id);
  let doc = store.create_page(&id, "doc", "", "", None).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store.acquire_run_lock(&id).unwrap();
  store.acquire_run_lock(&other).unwrap();
  for (folder, page) in [(&id, ROOT), (&other, rec.as_str())] {
    assert_eq!(
      store.delete_page(folder, page).unwrap_err().code,
      "store_busy",
      "{page}"
    );
  }
  assert_eq!(page_ids(&store, &id).len(), 2);
  assert_eq!(page_ids(&store, &other).len(), 1);
  assert!(root
    .join(format!("projects/{id}/recordings/{root_storage_id}/transcript.md"))
    .is_file());
  assert!(root
    .join(format!("projects/{other}/recordings/{rec_storage_id}"))
    .is_dir());
  // 「AIと作る」の文書会話も同じ案件ロックを使うため、文書も削除・移動できない。
  assert_eq!(store.delete_page(&id, &doc).unwrap_err().code, "store_busy");
  assert_eq!(
    store
      .move_page_before(Some(&id), &doc, Some(&id), Some(ROOT))
      .unwrap_err()
      .code,
    "store_busy"
  );
  assert!(store.read_page(&id, &doc).is_ok());
  store.release_run_lock(&id).unwrap();
  store.release_run_lock(&other).unwrap();
  store.delete_page(&id, &doc).unwrap();
  // 持ち主の居ない（落ちたアプリの）ロックは断らない
  fs::write(root.join(format!("projects/{id}/.run.lock")), "999999").unwrap();
  fs::write(root.join(format!("projects/{other}/.run.lock")), "999999").unwrap();
  store.delete_page(&other, &rec).unwrap();
  store.delete_page(&id, ROOT).unwrap();
  assert!(page_ids(&store, &id).is_empty());
  assert!(page_ids(&store, &other).is_empty());
  let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn deleting_a_recording_refuses_links_and_changes_nothing() {
  let root = temp_root("delete-link");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&project("リンク"), Some("本文"), Some(&save_record("s1")), &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let outside = temp_root("delete-link-outside");
  fs::create_dir_all(&outside).unwrap();
  fs::write(outside.join("keep.md"), "外のファイル").unwrap();
  // 旧 root の中身（artifacts/）にリンクがあれば移行を拒否し、元データを保つ。
  std::os::unix::fs::symlink(&outside, root.join(format!("projects/{id}/artifacts"))).unwrap();
  assert_eq!(store.load_project(&id).unwrap_err().code, "store_symlink");
  let saved = store.read_project(&id).unwrap();
  assert!(saved.get("flowSnapshot").is_some());
  assert!(root.join(format!("projects/{id}/transcript.md")).is_file());
  fs::remove_file(root.join(format!("projects/{id}/artifacts"))).unwrap();

  let root_storage_id = first_recording_id(&store, &id);
  assert_eq!(page_ids(&store, &id).len(), 1);
  // 1 フォルダに録音は 1 つ（#18914）。リンクを確かめる録音は別のフォルダに置く
  let other = store
    .create_project(&pages_project("リンク先"), None, None, &[])
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let rec = store
    .create_page(&other, "rec", "", "", Some(&new_recording()))
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let rec_storage_id = recording_id(&store, Some(&other), &rec);
  assert!(root
    .join(format!("projects/{id}/recordings/{root_storage_id}/transcript.md"))
    .is_file());
  // 録音ページ自体がリンクなら、削除せずに断る。
  let rec_dir = root.join(format!("projects/{other}/recordings/{rec_storage_id}"));
  let moved = temp_root("delete-link-moved");
  fs::rename(&rec_dir, &moved).unwrap();
  std::os::unix::fs::symlink(&moved, &rec_dir).unwrap();
  assert_eq!(store.delete_page(&other, &rec).unwrap_err().code, "store_symlink");
  assert_eq!(page_ids(&store, &other).len(), 1);
  assert!(moved.join("recording.json").is_file());
  assert_eq!(fs::read_to_string(outside.join("keep.md")).unwrap(), "外のファイル");
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(outside);
  let _ = fs::remove_dir_all(moved);
}

#[test]
fn text_is_pasted_only_into_an_empty_recording() {
  let root = temp_root("paste");
  let audio_dir = temp_root("paste-audio");
  fs::create_dir_all(&audio_dir).unwrap();
  fs::write(audio_dir.join("m.m4a"), b"abc").unwrap();
  let store = Store::new(root.clone());
  let created = store.create_project(&pages_project("朝市"), None, None, &[]).unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let rec = store
    .create_page(&id, "rec", "", "2026-10-16T01:00:00.000Z", Some(&new_recording()))
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  assert_eq!(
    store
      .set_recording_text(&id, &rec, "  ", &save_record("s0"))
      .unwrap_err()
      .code,
    "store_bad_page"
  );
  store
    .set_recording_text(&id, &rec, "貼った文章", &save_record("s1"))
    .unwrap();
  let loaded = store.load_recording(&id, &rec).unwrap();
  assert_eq!(loaded.transcript.as_deref(), Some("貼った文章"));
  assert_eq!(loaded.runs[0]["version"], 1);
  assert_eq!(loaded.recording.unwrap()["source"], json!({ "kind": "text" }));
  let rec_id = recording_id(&store, Some(&id), &rec);
  let rec_dir = root.join(format!("projects/{id}/recordings/{rec_id}"));
  assert_eq!(
    fs::read_to_string(rec_dir.join("inputs/text.md")).unwrap(),
    "貼った文章"
  );
  let version_path = loaded.runs[0]["versionPath"].as_str().unwrap().to_string();
  assert!(
    version_path.starts_with(&format!("recordings/{rec_id}/versions/source/v_")),
    "{version_path}"
  );
  assert_eq!(
    fs::read_to_string(root.join(format!("projects/{id}/{version_path}"))).unwrap(),
    "貼った文章"
  );
  // 2 回目（文章がある）・音声のある録音・root には貼れない
  assert_eq!(
    store
      .set_recording_text(&id, &rec, "もう一度", &save_record("s2"))
      .unwrap_err()
      .code,
    "store_bad_page"
  );
  // 1 フォルダに録音は 1 つ（#18914）。音声の録音は別のフォルダに置く
  let other_id = store
    .create_project(&pages_project("音声の朝市"), None, None, &[])
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let other = store
    .create_page(&other_id, "rec", "", "2026-10-16T01:00:00.000Z", Some(&new_recording()))
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let other_storage_id = recording_id(&store, Some(&other_id), &other);
  let audio = store
    .import_audio(&other_id, &other, &[audio_dir.join("m.m4a")], &[])
    .unwrap();
  let mut recording = store.load_recording(&other_id, &other).unwrap().recording.unwrap();
  recording["source"]["audio"] = json!(audio);
  store.save_recording(&other_id, &other, &recording).unwrap();
  let paths = store.audio_paths(&other_id, &other).unwrap();
  assert_eq!(paths.len(), 1);
  assert!(paths[0]
    .to_string_lossy()
    .contains(&format!("recordings/{other_storage_id}/inputs/")));
  assert_eq!(
    store
      .set_recording_text(&other_id, &other, "文章", &save_record("s3"))
      .unwrap_err()
      .code,
    "store_bad_page"
  );
  let legacy = store.create_project(&project("今の形"), None, None, &[]).unwrap();
  assert_eq!(
    store
      .set_recording_text(legacy["id"].as_str().unwrap(), ROOT, "文章", &save_record("s4"))
      .unwrap_err()
      .code,
    "store_bad_page"
  );
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(audio_dir);
}

#[test]
fn a_failed_paste_leaves_the_recording_as_it_was_and_can_be_retried() {
  let root = temp_root("paste-rollback");
  let store = Store::new(root.clone());
  let created = store.create_project(&pages_project("朝市"), None, None, &[]).unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let rec = store
    .create_page(&id, "rec", "", "2026-10-16T01:00:00.000Z", Some(&new_recording()))
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let rec_id = recording_id(&store, Some(&id), &rec);
  let rec_dir = root.join(format!("projects/{id}/recordings/{rec_id}"));
  let before = fs::read_to_string(rec_dir.join("recording.json")).unwrap();

  // 最後の recording.json の書き込みが失敗しても、足した文章・版・文字起こし・実行記録は残らない
  let error = store
    .set_recording_text_with(Some(&id), &rec, "貼った文章", &save_record("s1"), |_, _| {
      Err(StoreError::new("store_io", "ディスクがいっぱいです。"))
    })
    .unwrap_err();
  assert_eq!(error.code, "store_io");
  assert!(!rec_dir.join("inputs/text.md").exists());
  assert!(!rec_dir.join("transcript.md").exists());
  assert!(fs::read_dir(rec_dir.join("versions/source"))
    .map(|mut entries| entries.next().is_none())
    .unwrap_or(true));
  assert!(!rec_dir.join("runs.jsonl").exists());
  assert_eq!(fs::read_to_string(rec_dir.join("recording.json")).unwrap(), before);
  let loaded = store.load_recording(&id, &rec).unwrap();
  assert_eq!(loaded.transcript, None);
  assert!(loaded.runs.is_empty());

  // 失敗の後に、そのまま貼り直せる（版 1 から）
  store
    .set_recording_text(&id, &rec, "貼り直した文章", &save_record("s2"))
    .unwrap();
  let loaded = store.load_recording(&id, &rec).unwrap();
  assert_eq!(loaded.transcript.as_deref(), Some("貼り直した文章"));
  assert_eq!(loaded.runs.len(), 1);
  assert_eq!(loaded.runs[0]["version"], 1);
  let _ = fs::remove_dir_all(root);
}

#[test]
fn vtt_is_imported_only_into_an_empty_recording_and_keeps_the_original() {
  let root = temp_root("vtt-import");
  let store = Store::new(root.clone());
  let created = store.create_project(&pages_project("朝市"), None, None, &[]).unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let rec = store
    .create_page(&id, "rec", "", "2026-10-16T01:00:00.000Z", Some(&new_recording()))
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let original = b"\xef\xbb\xbfWEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\n<v Recorder>hello</v>\r\n";
  let markdown = "[00:00:00] Recorder: hello\n";
  assert!(store
    .import_transcript_at(
      Some(&id),
      &rec,
      "meeting.vtt",
      original,
      &"a".repeat(niho_desktop_vault::TEXT_MAX_BYTES as usize + 1),
      &save_record("vtt-too-large"),
    )
    .is_err());
  assert!(store.load_recording(&id, &rec).unwrap().transcript.is_none());
  store
    .import_transcript_at(
      Some(&id),
      &rec,
      "meeting.vtt",
      original,
      markdown,
      &save_record("vtt-1"),
    )
    .unwrap();

  let loaded = store.load_recording(&id, &rec).unwrap();
  assert_eq!(loaded.transcript.as_deref(), Some(markdown));
  assert_eq!(loaded.runs[0]["version"], 1);
  let source = &loaded.recording.unwrap()["source"];
  assert_eq!(source["kind"], "text");
  assert_eq!(source["transcriptImport"]["format"], "vtt");
  assert_eq!(source["transcriptImport"]["file"], "source.vtt");
  assert_eq!(source["transcriptImport"]["name"], "meeting.vtt");
  assert_eq!(source["transcriptImport"]["hash"].as_str().unwrap().len(), 64);
  let rec_id = recording_id(&store, Some(&id), &rec);
  assert_eq!(
    fs::read(root.join(format!("projects/{id}/recordings/{rec_id}/inputs/source.vtt"))).unwrap(),
    original
  );

  let error = store
    .import_transcript_at(
      Some(&id),
      &rec,
      "other.vtt",
      b"WEBVTT\n",
      "other",
      &save_record("vtt-2"),
    )
    .unwrap_err();
  assert_eq!(error.code, "store_bad_page");
  assert_eq!(
    store.load_recording(&id, &rec).unwrap().transcript.as_deref(),
    Some(markdown)
  );
  let _ = fs::remove_dir_all(root);
}

#[test]
fn failed_vtt_commit_rolls_back_and_the_same_recording_can_retry() {
  let root = temp_root("vtt-import-rollback");
  let store = Store::new(root.clone());
  let created = store.create_project(&pages_project("朝市"), None, None, &[]).unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let rec = store
    .create_page(&id, "rec", "", "2026-10-16T01:00:00.000Z", Some(&new_recording()))
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let rec_id = recording_id(&store, Some(&id), &rec);
  let rec_dir = root.join(format!("projects/{id}/recordings/{rec_id}"));
  let before = fs::read_to_string(rec_dir.join("recording.json")).unwrap();
  let original = b"WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n";
  let markdown = "[00:00:00] hello\n";

  let error = store
    .import_transcript_with(
      Some(&id),
      &rec,
      "meeting.vtt",
      original,
      markdown,
      &save_record("vtt-1"),
      |_, _| Err(StoreError::new("store_io", "ディスクがいっぱいです。")),
    )
    .unwrap_err();
  assert_eq!(error.code, "store_io");
  assert!(!rec_dir.join("inputs/source.vtt").exists());
  assert!(!rec_dir.join("transcript.md").exists());
  assert!(!rec_dir.join("runs.jsonl").exists());
  assert_eq!(fs::read_to_string(rec_dir.join("recording.json")).unwrap(), before);

  store
    .import_transcript_at(
      Some(&id),
      &rec,
      "meeting.vtt",
      original,
      markdown,
      &save_record("vtt-2"),
    )
    .unwrap();
  assert_eq!(store.load_recording(&id, &rec).unwrap().runs[0]["version"], 1);
  let _ = fs::remove_dir_all(root);
}

#[test]
fn save_recording_checks_the_id_and_the_audio_and_prunes_unused_copies() {
  let root = temp_root("save-recording");
  let audio_dir = temp_root("save-recording-audio");
  fs::create_dir_all(&audio_dir).unwrap();
  fs::write(audio_dir.join("1.m4a"), b"abc").unwrap();
  fs::write(audio_dir.join("2.m4a"), b"xyz").unwrap();
  let store = Store::new(root.clone());
  let created = store.create_project(&pages_project("朝市"), None, None, &[]).unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let rec = store
    .create_page(&id, "rec", "", "2026-10-16T01:00:00.000Z", Some(&new_recording()))
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let rec_id = recording_id(&store, Some(&id), &rec);
  let audio = store
    .import_audio(&id, &rec, &[audio_dir.join("1.m4a"), audio_dir.join("2.m4a")], &[])
    .unwrap();
  let inputs = root.join(format!("projects/{id}/recordings/{rec_id}/inputs"));
  let legacy_inputs = root.join(format!("projects/{id}/inputs"));
  let first = audio[0]["file"].as_str().unwrap().to_string();
  assert!(inputs.join(&first).is_file());
  // フォルダの inputs/ には写さない
  assert!(fs::read_dir(&legacy_inputs)
    .map(|mut entries| entries.next().is_none())
    .unwrap_or(true));
  let mut recording = store.load_recording(&id, &rec).unwrap().recording.unwrap();
  recording["source"]["audio"] = json!(audio);
  store.save_recording(&id, &rec, &recording).unwrap();
  assert_eq!(store.audio_paths(&id, &rec).unwrap().len(), 2);
  // 1 本目を外すと写しを消す（実行中は消さず、次の保存で消す）
  recording["source"]["audio"] = json!([audio[1].clone()]);
  store.acquire_run_lock(&id).unwrap();
  store.save_recording(&id, &rec, &recording).unwrap();
  assert!(inputs.join(&first).exists());
  store.release_run_lock(&id).unwrap();
  store.save_recording(&id, &rec, &recording).unwrap();
  assert!(!inputs.join(&first).exists());
  // id の食い違い・写しの無い音声は書かない。移行した root 録音も録音ページとして保存できる。
  let mut other = recording.clone();
  other["id"] = json!("zzzz222222");
  assert_eq!(
    store.save_recording(&id, &rec, &other).unwrap_err().code,
    "store_bad_json"
  );
  let mut missing = recording.clone();
  missing["source"]["audio"] = json!([{ "file": "nothere12.m4a", "hash": "", "name": "x", "durationSec": null }]);
  assert_eq!(
    store.save_recording(&id, &rec, &missing).unwrap_err().code,
    "store_bad_audio"
  );
  let legacy = store.create_project(&project("今の形"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let root_recording_id = first_recording_id(&store, &legacy);
  let root_recording = store.load_recording(&legacy, ROOT).unwrap().recording.unwrap();
  store.save_recording(&legacy, ROOT, &root_recording).unwrap();
  assert!(root
    .join(format!(
      "projects/{legacy}/recordings/{root_recording_id}/recording.json"
    ))
    .is_file());
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(audio_dir);
}

#[test]
fn the_project_list_is_touched_by_recordings_and_pages() {
  let root = temp_root("touched");
  let store = Store::new(root.clone());
  let created = store.create_project(&pages_project("朝市"), None, None, &[]).unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let before = store.list_projects().unwrap()[0].updated_ms;
  let doc = store.create_page(&id, "doc", "", "", None).unwrap();
  // mtime を古くしてから、本文だけを書く
  let old = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
  let dir = root.join(format!("projects/{id}"));
  fs::File::options()
    .write(true)
    .open(dir.join("project.json"))
    .unwrap()
    .set_modified(old)
    .unwrap();
  let stale = store.list_projects().unwrap()[0].updated_ms;
  store.write_page(&id, doc["id"].as_str().unwrap(), "本文").unwrap();
  let touched = store.list_projects().unwrap()[0].updated_ms;
  assert!(
    touched >= stale && touched >= before.saturating_sub(1000),
    "{before} {stale} {touched}"
  );
  assert!(touched > modified_ms(&dir.join("project.json")));
  let _ = fs::remove_dir_all(root);
}

// ---- フォルダとフォルダ外（#18607 P6） ----

#[test]
fn outside_pages_round_trip_without_a_project_json() {
  let root = temp_root("outside-pages");
  let store = Store::new(root.clone());
  let doc = store
    .create_page_at(None, "doc", "メモ", "2026-10-16T01:00:00.000Z", None)
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store.write_page_at(None, &doc, "フォルダ外の本文").unwrap();
  assert_eq!(store.read_page_at(None, &doc).unwrap(), "フォルダ外の本文");

  let rec_entry = store
    .create_page_at(None, "rec", "録音", "2026-10-16T02:00:00.000Z", Some(&new_recording()))
    .unwrap();
  let rec = rec_entry["id"].as_str().unwrap().to_string();
  let rec_storage_id = rec_entry["recordingId"].as_str().unwrap().to_string();
  store
    .set_recording_text_at(None, &rec, "貼った文章", &save_record("s1"))
    .unwrap();
  store
    .save_artifact_at(
      None,
      &rec,
      "k7m2q9xa",
      false,
      "# 成果物",
      &json!({ "id": "r1", "kind": "run", "stepId": "k7m2q9xa" }),
    )
    .unwrap();
  store
    .save_checkpoint_at(None, &rec, "r1", &json!({ "output": "途中" }))
    .unwrap();
  store
    .save_conversation_at(None, &rec, "conv-a", &json!({ "id": "conv-a", "updatedAt": "x" }))
    .unwrap();

  let pages = store.load_pages(None).unwrap();
  assert_eq!(pages.project_id, None);
  assert_eq!(pages.project, None);
  assert_eq!(pages.pages.len(), 2);
  assert_eq!(pages.docs.len(), 1);
  assert_eq!(pages.recordings.len(), 1);
  let loaded = store.load_recording_at(None, &rec).unwrap();
  assert_eq!(loaded.project_id, None);
  assert_eq!(loaded.transcript.as_deref(), Some("貼った文章"));
  assert_eq!(loaded.artifacts.get("k7m2q9xa").map(String::as_str), Some("# 成果物"));
  assert_eq!(
    store.read_checkpoint_at(None, &rec, "r1").unwrap().unwrap()["output"],
    "途中"
  );
  assert_eq!(store.list_conversations_at(None, &rec).unwrap().len(), 1);
  assert!(root.join("pages.json").is_file());
  assert!(root.join(format!("pages/{doc}.md")).is_file());
  assert!(root
    .join(format!("recordings/{rec_storage_id}/recording.json"))
    .is_file());
  assert!(!root.join("project.json").exists());
  let _ = fs::remove_dir_all(root);
}

#[test]
fn project_order_is_stable_sanitized_and_new_folders_are_appended() {
  let root = temp_root("folder-order");
  let store = Store::new(root.clone());
  let mut later = pages_project("後");
  later["createdAt"] = json!("2026-10-17T00:00:00.000Z");
  let mut first = pages_project("先");
  first["createdAt"] = json!("2026-10-16T00:00:00.000Z");
  let a = store.create_project(&later, None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let b = store.create_project(&first, None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  assert_eq!(
    store
      .list_projects()
      .unwrap()
      .iter()
      .map(|entry| entry.id.as_str())
      .collect::<Vec<_>>(),
    vec![a.as_str(), b.as_str()]
  );

  fs::remove_file(root.join("projects/index.json")).unwrap();
  assert_eq!(
    store
      .list_projects()
      .unwrap()
      .iter()
      .map(|entry| entry.id.as_str())
      .collect::<Vec<_>>(),
    vec![b.as_str(), a.as_str()]
  );
  let saved = store
    .save_project_order(&[a.clone(), a.clone(), "missing12".into()])
    .unwrap();
  assert_eq!(saved, vec![a.clone(), b.clone()]);
  let c = store.create_project(&pages_project("末尾"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  assert_eq!(
    store
      .list_projects()
      .unwrap()
      .iter()
      .map(|entry| entry.id.as_str())
      .collect::<Vec<_>>(),
    vec![a.as_str(), b.as_str(), c.as_str()]
  );
  let _ = fs::remove_dir_all(root);
}

#[test]
fn moving_pages_preserves_data_and_bumps_recording_generation_each_time() {
  let root = temp_root("move-pages");
  let store = Store::new(root.clone());
  let source = store.create_project(&pages_project("元"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let target = store.create_project(&pages_project("先"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let doc = store.create_page(&source, "doc", "メモ", "", None).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store.write_page(&source, &doc, "本文").unwrap();
  let source_chat = root.join(format!("projects/{source}/page-chats/{doc}"));
  fs::create_dir_all(source_chat.join("conversations")).unwrap();
  fs::write(source_chat.join("conversations/conv1.json"), "conversation").unwrap();
  assert_eq!(store.move_page(Some(&source), &doc, None).unwrap()["id"], doc);
  assert_eq!(store.read_page_at(None, &doc).unwrap(), "本文");
  assert!(!source_chat.parent().unwrap().exists());
  assert_eq!(
    fs::read_to_string(root.join(format!("page-chats/{doc}/conversations/conv1.json"))).unwrap(),
    "conversation"
  );
  let doc_generation = |project_id: Option<&str>| {
    store
      .load_pages(project_id)
      .unwrap()
      .pages
      .iter()
      .find(|page| page["id"] == doc.as_str())
      .map(|page| page["moveGeneration"].clone())
      .unwrap()
  };
  // 文書ページも移動のたびに世代が増え、移動前の会話を閲覧だけにする
  assert_eq!(doc_generation(None), 1);
  assert_eq!(store.move_page(None, &doc, Some(&target)).unwrap()["id"], doc);
  assert_eq!(store.read_page(&target, &doc).unwrap(), "本文");
  assert!(!root.join("page-chats").exists());
  assert_eq!(doc_generation(Some(&target)), 2);
  let outside_doc = store.create_page_at(None, "doc", "別文書", "", None).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store.acquire_run_lock(&target).unwrap();
  assert_eq!(
    store.move_page(Some(&target), &doc, None).unwrap_err().code,
    "store_busy"
  );
  assert_eq!(
    store.move_page(None, &outside_doc, Some(&target)).unwrap_err().code,
    "store_busy"
  );
  store.release_run_lock(&target).unwrap();

  let mut recording = new_recording();
  recording["flowSnapshot"]["id"] = json!("flow-one");
  let rec = store.create_page(&source, "rec", "取材", "", Some(&recording)).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  fill_recording(&store, &source, &rec);
  let moved = store.move_page(Some(&source), &rec, None).unwrap();
  assert_eq!(moved["id"], rec);
  let outside = store.load_recording_at(None, &rec).unwrap();
  assert_eq!(outside.recording.as_ref().unwrap()["moveGeneration"], 1);
  assert_eq!(outside.artifacts["k7m2q9xa"], "# 議事録");
  assert_eq!(outside.runs.len(), 1);
  assert_eq!(store.list_conversations_at(None, &rec).unwrap().len(), 1);
  assert_eq!(store.flow_usage("flow-one").unwrap(), 1);

  store.acquire_run_lock_at(None).unwrap();
  assert_eq!(
    store.move_page(None, &rec, Some(&target)).unwrap_err().code,
    "store_busy"
  );
  assert!(store.load_recording_at(None, &rec).is_ok());
  store.release_run_lock_at(None).unwrap();
  store.move_page(None, &rec, Some(&target)).unwrap();
  let moved_again = store.load_recording(&target, &rec).unwrap();
  assert_eq!(moved_again.recording.unwrap()["moveGeneration"], 2);
  assert_eq!(store.list_conversations(&target, &rec).unwrap().len(), 1);
  let _ = fs::remove_dir_all(root);
}

#[test]
fn moving_a_legacy_root_allocates_a_recording_id_and_moves_only_recording_files() {
  let root = temp_root("move-legacy-root");
  let store = Store::new(root.clone());
  let mut legacy = project("旧録音");
  legacy["info"] = json!({ "speakers": "2", "language": "ja", "terms": [], "background": "取材背景" });
  let created = store
    .create_project(&legacy, Some("本文"), Some(&save_record("s1")), &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  fill_recording(&store, &id, ROOT);
  let doc = store.create_page(&id, "doc", "残す", "", None).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store.write_page(&id, &doc, "残す本文").unwrap();
  fs::write(root.join(format!("projects/{id}/.run.lock")), "999999").unwrap();

  let moved = store.move_page(Some(&id), ROOT, None).unwrap();
  let page_id = moved["id"].as_str().unwrap();
  let rec = moved["recordingId"].as_str().unwrap();
  assert_ne!(page_id, ROOT);
  assert_ne!(rec, page_id);
  assert_eq!(moved["kind"], "rec");
  let recording = store.load_recording_at(None, rec).unwrap();
  let metadata = recording.recording.unwrap();
  assert_eq!(metadata["id"], rec);
  assert_eq!(metadata["pageId"], page_id);
  assert_eq!(metadata["speakers"], "2");
  assert_eq!(metadata["language"], "ja");
  assert_eq!(metadata["moveGeneration"], 1);
  assert_eq!(recording.transcript.as_deref(), Some("本文"));
  assert_eq!(recording.artifacts["k7m2q9xa"], "# 議事録");
  assert_eq!(store.list_conversations_at(None, rec).unwrap().len(), 1);

  let saved = store.load_project(&id).unwrap().project;
  assert!(saved.get("flowSnapshot").is_none());
  assert!(saved.get("source").is_none());
  assert!(saved.get("refs").is_none());
  assert!(saved.get("candidateSets").is_none());
  assert_eq!(store.read_page(&id, &doc).unwrap(), "残す本文");
  assert!(root.join(format!("projects/{id}/project.json")).is_file());
  assert!(root.join(format!("projects/{id}/.run.lock")).is_file());
  for name in ROOT_RECORDING_FILES {
    assert!(!root.join(format!("projects/{id}/{name}")).exists(), "{name}");
  }
  let _ = fs::remove_dir_all(root);
}

#[test]
fn moving_a_legacy_root_preserves_its_candidate_ledger_and_candidate_history() {
  let root = temp_root("move-legacy-root-candidates");
  let store = Store::new(root.clone());
  let mut legacy = candidate_project("旧記事");
  legacy["candidateSets"] = json!({ "h2n6v5pe": two_candidates("artifact2") });
  let created = store.create_project(&legacy, None, None, &[]).unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  store
    .save_artifact(
      &id,
      ROOT,
      "h2n6v5pe",
      false,
      "# 最初の案",
      &json!({ "id": "body1", "kind": "run", "stepId": "h2n6v5pe", "result": "saved" }),
    )
    .unwrap();
  store
    .save_artifact(
      &id,
      ROOT,
      "artifact2",
      false,
      "# 別案",
      &json!({
        "id": "body2", "kind": "run", "stepId": "h2n6v5pe", "candidateId": "candidate2",
        "artifactId": "artifact2", "result": "saved"
      }),
    )
    .unwrap();
  store
    .save_conversation(
      &id,
      ROOT,
      "candidate-conv",
      &json!({ "id": "candidate-conv", "updatedAt": "x", "candidateId": "candidate2", "artifactId": "artifact2" }),
    )
    .unwrap();

  let moved = store.move_page(Some(&id), ROOT, None).unwrap();
  let recording_id = moved["recordingId"].as_str().unwrap();
  let loaded = store.load_recording_at(None, recording_id).unwrap();
  assert_eq!(
    loaded.recording.as_ref().unwrap()["candidateSets"]["h2n6v5pe"]["order"],
    json!(["candidate1", "candidate2"])
  );
  assert_eq!(loaded.artifacts.get("artifact2").map(String::as_str), Some("# 別案"));
  assert_eq!(
    store.read_version_at(None, recording_id, "artifact2", 1, None).unwrap(),
    "# 別案"
  );
  assert_eq!(
    store.list_conversations_at(None, recording_id).unwrap()[0]["candidateId"],
    "candidate2"
  );
  assert!(store.load_project(&id).unwrap().project.get("candidateSets").is_none());
  let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn a_failed_target_list_write_rolls_back_the_move_and_both_lists() {
  use std::os::unix::fs::PermissionsExt;

  let root = temp_root("move-list-rollback");
  let store = Store::new(root.clone());
  let source = store.create_project(&pages_project("元"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let target = store.create_project(&pages_project("先"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let rec = store
    .create_page(&source, "rec", "取材", "", Some(&new_recording()))
    .unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let rec_storage_id = recording_id(&store, Some(&source), &rec);
  fill_recording(&store, &source, &rec);
  let source_before = store.load_project(&source).unwrap().project;
  let target_before = store.load_project(&target).unwrap().project;
  let target_dir = root.join(format!("projects/{target}"));
  fs::set_permissions(&target_dir, fs::Permissions::from_mode(0o555)).unwrap();

  let error = store.move_page(Some(&source), &rec, Some(&target)).unwrap_err();
  fs::set_permissions(&target_dir, fs::Permissions::from_mode(0o755)).unwrap();
  assert_eq!(error.code, "store_io");
  assert_eq!(store.load_project(&source).unwrap().project, source_before);
  assert_eq!(store.load_project(&target).unwrap().project, target_before);
  let kept = store.load_recording(&source, &rec).unwrap();
  assert_eq!(kept.artifacts["k7m2q9xa"], "# 議事録");
  assert_eq!(store.list_conversations(&source, &rec).unwrap().len(), 1);
  assert!(!root
    .join(format!("projects/{target}/recordings/{rec_storage_id}"))
    .exists());
  let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn moving_a_page_refuses_a_symlink_and_changes_nothing() {
  let root = temp_root("move-link");
  let outside = temp_root("move-link-outside");
  fs::create_dir_all(&outside).unwrap();
  fs::write(outside.join("keep.md"), "外の本文").unwrap();
  let store = Store::new(root.clone());
  let source = store.create_project(&pages_project("元"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let target = store.create_project(&pages_project("先"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let page = store.create_page(&source, "doc", "メモ", "", None).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let source_file = root.join(format!("projects/{source}/pages/{page}.md"));
  fs::remove_file(&source_file).unwrap();
  std::os::unix::fs::symlink(outside.join("keep.md"), &source_file).unwrap();
  let source_before = store.load_project(&source).unwrap().project;
  let target_before = store.load_project(&target).unwrap().project;

  assert_eq!(
    store.move_page(Some(&source), &page, Some(&target)).unwrap_err().code,
    "store_symlink"
  );
  assert_eq!(store.load_project(&source).unwrap().project, source_before);
  assert_eq!(store.load_project(&target).unwrap().project, target_before);
  assert_eq!(fs::read_to_string(outside.join("keep.md")).unwrap(), "外の本文");
  assert!(!root.join(format!("projects/{target}/pages/{page}.md")).exists());
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(outside);
}

#[cfg(unix)]
#[test]
fn moving_a_legacy_recording_refuses_linked_files_before_moving_anything() {
  let root = temp_root("move-root-link");
  let outside = temp_root("move-root-link-outside");
  fs::create_dir_all(&outside).unwrap();
  fs::write(outside.join("transcript.md"), "外の本文").unwrap();
  let store = Store::new(root.clone());
  let created = store.create_project(&project("旧録音"), None, None, &[]).unwrap();
  let id = created["id"].as_str().unwrap();
  let source_dir = root.join("projects").join(id);
  fs::write(source_dir.join("runs.jsonl"), "{\"id\":\"keep\"}\n").unwrap();
  std::os::unix::fs::symlink(outside.join("transcript.md"), source_dir.join("transcript.md")).unwrap();
  let before = fs::read(source_dir.join("project.json")).unwrap();
  assert_eq!(store.move_page(Some(id), ROOT, None).unwrap_err().code, "store_symlink");
  assert_eq!(fs::read(source_dir.join("project.json")).unwrap(), before);
  assert!(source_dir.join("runs.jsonl").is_file());
  assert!(!root.join("recordings").exists());
  assert!(!root.join("pages.json").exists());
  assert_eq!(fs::read_to_string(outside.join("transcript.md")).unwrap(), "外の本文");
  let _ = fs::remove_dir_all(root);
  let _ = fs::remove_dir_all(outside);
}

#[test]
fn failed_legacy_move_recovery_keeps_the_unrestored_data() {
  let root = temp_root("move-recovery-failure");
  let original = root.join("original");
  let target = root.join("target");
  fs::create_dir_all(&original).unwrap();
  fs::create_dir_all(&target).unwrap();
  fs::write(target.join("recording.json"), "{}").unwrap();
  fs::write(target.join("transcript.md"), "戻せなくても残す本文").unwrap();
  // 復旧先に既存ディレクトリが現れ、rename を戻せない状態を再現する。
  fs::create_dir_all(original.join("transcript.md")).unwrap();
  let files = vec![(original.join("transcript.md"), target.join("transcript.md"))];
  assert_eq!(
    Store::rollback_root_move(&target, &files).unwrap_err().code,
    "store_move_recovery"
  );
  assert_eq!(
    fs::read_to_string(target.join("transcript.md")).unwrap(),
    "戻せなくても残す本文"
  );
  assert!(target.join("recording.json").is_file());
  let _ = fs::remove_dir_all(root);
}

#[test]
fn recent_is_validated_deduplicated_capped_and_skips_stale_pages() {
  let root = temp_root("recent-pages");
  let store = Store::new(root.clone());
  let folder = store.create_project(&pages_project("最近"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let first = store.create_page(&folder, "doc", "最初", "", None).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store
    .touch_recent(Some(&folder), &first, "2026-10-16T01:00:00Z")
    .unwrap();
  store
    .touch_recent(Some(&folder), &first, "2026-10-16T02:00:00Z")
    .unwrap();
  assert_eq!(store.load_recent().unwrap().len(), 1);
  assert_eq!(store.load_recent().unwrap()[0].opened_at, "2026-10-16T02:00:00Z");
  for index in 0..35 {
    let page = store.create_page_at(None, "doc", "", "", None).unwrap()["id"]
      .as_str()
      .unwrap()
      .to_string();
    store
      .touch_recent(None, &page, &format!("2026-10-16T03:{index:02}:00Z"))
      .unwrap();
  }
  assert_eq!(store.load_recent().unwrap().len(), 30);
  let stale = store.load_recent().unwrap()[0].clone();
  store
    .delete_page_at(stale.project_id.as_deref(), &stale.page_id)
    .unwrap();
  assert_eq!(store.load_recent().unwrap().len(), 29);

  fs::write(
    root.join("recent.json"),
    r#"{"version":1,"ids":[{"projectId":{},"pageId":"x","openedAt":"now"}]}"#,
  )
  .unwrap();
  assert_eq!(store.load_recent().unwrap_err().code, "store_bad_json");
  store
    .touch_recent(Some(&folder), &first, "2026-10-16T04:00:00Z")
    .unwrap();
  assert_eq!(
    store.load_recent().unwrap(),
    vec![super::RecentId {
      project_id: Some(folder),
      page_id: first,
      opened_at: "2026-10-16T04:00:00Z".into(),
    }]
  );
  let _ = fs::remove_dir_all(root);
}

#[cfg(unix)]
#[test]
fn recent_refuses_a_symlink() {
  let root = temp_root("recent-link");
  let other = temp_root("recent-link-target");
  let store = Store::new(root.clone());
  let page = store.create_page_at(None, "doc", "", "", None).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store.load_recent().unwrap();
  std::os::unix::fs::symlink(&other, root.join("recent.json")).unwrap();
  assert_eq!(store.load_recent().unwrap_err().code, "store_symlink");
  assert_eq!(
    store
      .touch_recent(None, &page, "2026-10-16T05:00:00Z")
      .unwrap_err()
      .code,
    "store_symlink"
  );
  assert!(fs::symlink_metadata(root.join("recent.json"))
    .unwrap()
    .file_type()
    .is_symlink());
  let _ = fs::remove_dir_all(other);
  let _ = fs::remove_dir_all(root);
}

#[test]
fn page_reorder_and_positioned_move_are_atomic_and_do_not_bump_generation_in_place() {
  let root = temp_root("page-position");
  let store = Store::new(root.clone());
  let source = store.create_project(&pages_project("元"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let target = store.create_project(&pages_project("先"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let recording = new_recording();
  let rec = store.create_page(&source, "rec", "録音", "", Some(&recording)).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let doc = store.create_page(&source, "doc", "文書", "", None).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store
    .move_page_before(Some(&source), &rec, Some(&source), Some(&doc))
    .unwrap();
  let unchanged = store.load_recording(&source, &rec).unwrap().recording.unwrap();
  assert!(unchanged.get("moveGeneration").is_none());

  let target_a = store.create_page(&target, "doc", "A", "", None).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let target_b = store.create_page(&target, "doc", "B", "", None).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  store
    .move_page_before(Some(&source), &doc, Some(&target), Some(&target_b))
    .unwrap();
  let loaded = store.load_project(&target).unwrap();
  let pages = loaded.project["pages"]["order"]
    .as_array()
    .unwrap()
    .iter()
    .map(|page| page.as_str().unwrap())
    .collect::<Vec<_>>();
  assert_eq!(pages, vec![target_a.as_str(), doc.as_str(), target_b.as_str()]);
  assert_eq!(
    store
      .move_page_before(Some(&target), &doc, Some(&target), Some("missing-target"))
      .unwrap_err()
      .code,
    "store_stale_target"
  );
  let _ = fs::remove_dir_all(root);
}

#[test]
fn folder_reorder_refuses_a_stale_target() {
  let root = temp_root("folder-position");
  let store = Store::new(root.clone());
  let a = store.create_project(&pages_project("A"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  let b = store.create_project(&pages_project("B"), None, None, &[]).unwrap()["id"]
    .as_str()
    .unwrap()
    .to_string();
  assert_eq!(store.reorder_project(&b, Some(&a)).unwrap(), vec![b.clone(), a.clone()]);
  assert_eq!(
    store.reorder_project(&a, Some("missing-target")).unwrap_err().code,
    "store_stale_target"
  );
  let _ = fs::remove_dir_all(root);
}

#[test]
fn url_sample_snapshot_uses_existing_store_and_prune_contract() {
  let root = temp_root("url-sample");
  let store = Store::new(root.clone());
  let url = "https://example.com/article";
  let text = format!("## 記事\n\n{}\n\n第二段落\n\n第三段落", "本文の写し。".repeat(100));
  let sample = store.save_url_sample("flow1", url, "公開記事", &text).unwrap();
  assert_eq!(sample.source_url.as_deref(), Some(url));
  assert_eq!(store.read_sample("flow1", &sample.id).unwrap(), text);
  let mut saved_flow = flow("flow1", "工程", &[]);
  saved_flow["samples"] = json!([serde_json::to_value(&sample).unwrap()]);
  store.save_flow(&saved_flow).unwrap();
  assert_eq!(store.list_flows().unwrap().flows[0]["samples"][0]["sourceUrl"], url);
  store.prune_samples("flow1", &[sample.id.clone()]).unwrap();
  assert!(store.read_sample("flow1", &sample.id).is_ok());
  store.prune_samples("flow1", &[]).unwrap();
  assert_eq!(
    store.read_sample("flow1", &sample.id).unwrap_err().code,
    "store_no_sample"
  );
  fs::remove_dir_all(root).unwrap();
}

#[test]
fn url_sample_validation_rejects_bad_metadata_and_body_before_writing() {
  let root = temp_root("url-sample-validation");
  let store = Store::new(root.clone());
  let body = "記事本文。".repeat(100);
  for url in [
    "http://example.com",
    "https://user:pass@example.com",
    "https://127.0.0.1",
    "https://a.local",
  ] {
    assert!(store.save_url_sample("flow1", url, "記事", &body).is_err());
  }
  for (title, body) in [
    ("".to_string(), body.clone()),
    ("題".repeat(201), body.clone()),
    ("題".to_string(), "短い本文".to_string()),
    ("題".to_string(), "あ".repeat(50_001)),
  ] {
    assert_eq!(
      store
        .save_url_sample("flow1", "https://example.com", &title, &body)
        .unwrap_err()
        .code,
      "sample_url_body_invalid"
    );
  }
  assert!(!root.exists());
  let imported = store
    .save_url_sample("flow1", "https://example.com", "記事", &"あ".repeat(40_000))
    .unwrap();
  assert_eq!(imported.chars, 30_000);
  assert_eq!(imported.truncated_from, Some(40_000));
  fs::remove_dir_all(root).unwrap();
}

#[test]
fn page_markdown_path_points_at_the_doc_file_or_its_space() {
  let root = temp_root("page-markdown-path");
  let store = Store::new(root.clone());
  let created = store
    .create_project(&pages_project("運営会議"), None, None, &[])
    .unwrap();
  let id = created["id"].as_str().unwrap().to_string();
  let doc = store
    .create_page(&id, "doc", "取材メモ", "2026-10-16T01:00:00.000Z", None)
    .unwrap();
  let doc_id = doc["id"].as_str().unwrap().to_string();
  // その .md（「書き出し › Finder で表示」）。無ければフォルダ
  let file = root
    .join("projects")
    .join(&id)
    .join("pages")
    .join(format!("{doc_id}.md"));
  store.write_page(&id, &doc_id, "# 取材メモ\n").unwrap();
  assert_eq!(store.page_markdown_path_at(Some(&id), &doc_id).unwrap(), file);
  fs::remove_file(&file).unwrap();
  assert_eq!(
    store.page_markdown_path_at(Some(&id), &doc_id).unwrap(),
    root.join("projects").join(&id)
  );
  // フォルダの外のページは保存先の直下
  let outside = store
    .create_page_at(None, "doc", "外のメモ", "2026-10-16T02:00:00.000Z", None)
    .unwrap();
  let outside_id = outside["id"].as_str().unwrap().to_string();
  store.write_page_at(None, &outside_id, "外").unwrap();
  assert_eq!(
    store.page_markdown_path_at(None, &outside_id).unwrap(),
    root.join("pages").join(format!("{outside_id}.md"))
  );
  assert_eq!(
    store.page_markdown_path_at(Some(&id), "../x").unwrap_err().code,
    "store_bad_id"
  );
  fs::remove_dir_all(root).unwrap();
}
