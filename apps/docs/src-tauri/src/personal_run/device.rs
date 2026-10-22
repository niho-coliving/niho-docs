//! LOCAL 保存先の本人 Mac から、固定した後続工程だけを NIHO API に一時配送する。
//! 本文は捕捉済み Store から読み、app data には接続世代・受付キー・run ID だけを残す。

use super::*;
use niho_desktop_account::http::{HttpClient, HttpMethod, HttpRequest, HttpResponse, ReqwestClient};
use serde_json::json;
use std::time::Duration;

const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESULT_BYTES: usize = 2 * 1024 * 1024;
const API_TIMEOUT: Duration = Duration::from_secs(30);
const RESULT_WAIT: usize = 180;

fn unavailable() -> CommandError {
  failure(
    "personal_device_unavailable",
    "NIHO API を今は使えません。少し待ってから、もう一度実行してください。",
  )
}

fn result_missing() -> CommandError {
  failure(
    "personal_device_result_missing",
    "結果を受け取れませんでした。依頼の状態を確認してから、もう一度頼んでください。",
  )
}

fn unknown() -> CommandError {
  failure(
    "personal_device_result_unknown",
    "NIHO に依頼しましたが結果を確認できません。自動では再依頼しません。",
  )
}

fn changed() -> CommandError {
  failure(
    "personal_device_input_changed",
    "固定した入力が変わりました。もう一度実行してください。",
  )
}

fn record_io() -> CommandError {
  failure(
    "personal_device_record_io",
    "依頼の記録をこの Mac に保存できないため、送信しませんでした。",
  )
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceSession {
  connection_id: String,
  generation: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceRecord {
  connection_id: String,
  generation: String,
  project_id: Option<String>,
  recording_page_id: String,
  recording_id: String,
  personal_run_id: String,
  step_id: String,
  artifact_id: String,
  consent_version: String,
  version_id: String,
  submission_key: String,
  ack_key: String,
  input_sha256: String,
  input_bytes: usize,
  run_id: Option<String>,
  output_sha256: Option<String>,
  phase: String,
}

fn uuid_generation() -> CommandResult<String> {
  let bytes = crate::process::random_bytes::<16>().map_err(|_| record_io())?;
  let hex = crate::process::hex(&bytes);
  Ok(format!(
    "{}-{}-4{}-a{}-{}",
    &hex[..8],
    &hex[8..12],
    &hex[13..16],
    &hex[17..20],
    &hex[20..]
  ))
}

fn request_key(prefix: &str) -> CommandResult<String> {
  let bytes = crate::process::random_bytes::<16>().map_err(|_| record_io())?;
  Ok(format!("{prefix}_{}", crate::process::hex(&bytes)))
}

fn relative_session(op: &PersonalOperation) -> CommandResult<String> {
  Ok(format!("{}/device-session.json", intents_dir(&op.identity)?))
}

fn relative_record(op: &PersonalOperation, step_id: &str) -> CommandResult<String> {
  crate::safe_id(step_id)?;
  Ok(format!(
    "{}/{}.{}.device.json",
    intents_dir(&op.identity)?,
    op.intent_id,
    step_id
  ))
}

fn read_plain<T: serde::de::DeserializeOwned>(root: &Path, relative: &str) -> CommandResult<Option<T>> {
  validate_relative_path(relative).map_err(|_| record_io())?;
  let (dir, _) = relative.rsplit_once('/').ok_or_else(record_io)?;
  create_dirs_without_symlinks(root, dir).map_err(|_| record_io())?;
  let path = root.join(relative);
  match fs::symlink_metadata(&path) {
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 16 * 1024 => {
      let bytes = fs::read(path).map_err(|_| record_io())?;
      serde_json::from_slice(&bytes).map(Some).map_err(|_| record_io())
    }
    _ => Err(record_io()),
  }
}

fn write_plain<T: Serialize>(root: &Path, relative: &str, value: &T) -> CommandResult<()> {
  let bytes = serde_json::to_vec(value).map_err(|_| record_io())?;
  if bytes.len() > 16 * 1024 {
    return Err(record_io());
  }
  atomic_write(root, relative, &bytes).map_err(|_| record_io())
}

/// 利用者がもう一度「実行」を押したときは、同じ固定入力の前回の受付キーを先に探す。
/// 送信の曖昧さで新しい課金依頼を作らないため、壊れた記録・過剰な件数は停止する。
fn previous_record(
  state: &AppState,
  op: &PersonalOperation,
  session: &DeviceSession,
  step_id: &str,
  artifact_id: &str,
  consent_version: &str,
  input_sha256: &str,
  input_bytes: usize,
) -> CommandResult<Option<(String, DeviceRecord)>> {
  let dir = intents_dir(&op.identity)?;
  let path = create_dirs_without_symlinks(&state.data_dir, &dir).map_err(|_| record_io())?;
  let mut found: Option<(String, DeviceRecord)> = None;
  for (index, entry) in fs::read_dir(path).map_err(|_| record_io())?.enumerate() {
    if index >= 1000 {
      return Err(record_io());
    }
    let entry = entry.map_err(|_| record_io())?;
    let name = entry.file_name();
    let Some(name) = name.to_str() else {
      return Err(record_io());
    };
    if !name.ends_with(".device.json") {
      continue;
    }
    let relative = format!("{dir}/{name}");
    let record = read_plain::<DeviceRecord>(&state.data_dir, &relative)?.ok_or_else(record_io)?;
    if record.connection_id == session.connection_id
      && record.generation == session.generation
      && record.project_id == op.project_id
      && record.recording_page_id == op.recording_page_id
      && record.recording_id == op.recording_id
      && record.step_id == step_id
      && record.artifact_id == artifact_id
      && record.consent_version == consent_version
      && record.input_sha256 == input_sha256
      && record.input_bytes == input_bytes
      && ["prepared", "queued", "ready", "ack_pending"].contains(&record.phase.as_str())
    {
      if let Some((_, previous)) = &found {
        if previous.submission_key != record.submission_key || previous.run_id != record.run_id {
          return Err(record_io());
        }
      }
      if found.is_none() || relative == relative_record(op, step_id)? {
        found = Some((relative, record));
      }
    }
  }
  Ok(found)
}

fn session(state: &AppState, op: &PersonalOperation) -> CommandResult<DeviceSession> {
  let connection_id = op.captured.local_device_api_scope().ok_or_else(guard_failed)?;
  let relative = relative_session(op)?;
  if let Some(saved) = read_plain::<DeviceSession>(&state.data_dir, &relative)? {
    if saved.connection_id == connection_id {
      return Ok(saved);
    }
  }
  let next = DeviceSession {
    connection_id,
    generation: uuid_generation()?,
  };
  write_plain(&state.data_dir, &relative, &next)?;
  Ok(next)
}

fn fixed_flow(flow: &Value, models: &Value) -> CommandResult<Value> {
  let obj = flow.as_object().ok_or_else(changed)?;
  let mut fixed = Map::new();
  for key in ["version", "id", "revision", "name", "guide"] {
    fixed.insert(key.into(), obj.get(key).ok_or_else(changed)?.clone());
  }
  if obj.get("transcription").and_then(Value::as_bool) == Some(false) {
    fixed.insert("transcription".into(), json!(false));
  }
  let terms = obj.get("terms").and_then(Value::as_array).ok_or_else(changed)?;
  fixed.insert(
    "terms".into(),
    Value::Array(
      terms
        .iter()
        .map(|term| {
          let mut clean = Map::new();
          for key in ["term", "reading", "variants", "note"] {
            if let Some(value) = term.get(key) {
              clean.insert(key.into(), value.clone());
            }
          }
          Value::Object(clean)
        })
        .collect(),
    ),
  );
  let samples = obj.get("samples").and_then(Value::as_array).ok_or_else(changed)?;
  fixed.insert(
    "samples".into(),
    Value::Array(
      samples
        .iter()
        .map(|sample| {
          let mut clean = Map::new();
          for key in ["id", "name", "chars", "truncatedFrom"] {
            if let Some(value) = sample.get(key) {
              clean.insert(key.into(), value.clone());
            }
          }
          Value::Object(clean)
        })
        .collect(),
    ),
  );
  let steps = obj.get("steps").and_then(Value::as_array).ok_or_else(changed)?;
  fixed.insert(
    "steps".into(),
    Value::Array(
      steps
        .iter()
        .map(|step| {
          let mut clean = Map::new();
          for key in ["id", "name", "instruction", "provider", "profile"] {
            if let Some(value) = step.get(key) {
              clean.insert(key.into(), value.clone());
            }
          }
          Value::Object(clean)
        })
        .collect(),
    ),
  );
  fixed.insert("models".into(), models.clone());
  Ok(Value::Object(fixed))
}

fn same_version(material: &Value, fixed: &Value) -> bool {
  let Some(content) = material.get("content").and_then(Value::as_str) else {
    return false;
  };
  material.get("versionId") == fixed.get("versionId")
    && material.get("path") == fixed.get("path")
    && fixed.get("sha256").and_then(Value::as_str) == Some(sha256_hex(content.as_bytes()).as_str())
    && fixed.get("bytes").and_then(Value::as_u64) == Some(content.len() as u64)
}

/// 現在の Store を再読し、受け入れた snapshot の各 digest と版参照に一致する本文だけを配送用 JSON にする。
fn fixed_input(op: &PersonalOperation, step_id: &str, snapshot_sha256: &str) -> CommandResult<Vec<u8>> {
  let head = op.st().head.clone().ok_or_else(intent_not_reserved)?;
  if head.get("snapshotSha256").and_then(Value::as_str) != Some(snapshot_sha256) || !step_selectable(op, step_id) {
    return Err(changed());
  }
  let (material, _) = build_material(op, &[step_id.to_string()])?;
  let input = head.get("input").ok_or_else(changed)?;
  let prompt = material.get("promptMaterials").ok_or_else(changed)?;
  let digest = input.get("promptMaterials").ok_or_else(changed)?;
  for (key, fixed_key) in [
    ("about", "aboutSha256"),
    ("referenceTitles", "referenceTitlesSha256"),
    ("info", "infoSha256"),
  ] {
    if prompt.get(key).and_then(|value| value.get("sha256")) != digest.get(fixed_key) {
      return Err(changed());
    }
  }
  let metadata = material.get("recordingMetadata").ok_or_else(changed)?;
  let metadata_fixed = json!({
    "speakers": metadata.get("speakers"), "language": metadata.get("language"),
    "background": metadata.get("background"), "terms": metadata.get("terms"),
  });
  let metadata_hash = canonical(&metadata_fixed)
    .map(|text| sha256_hex(text.as_bytes()))
    .ok_or_else(changed)?;
  if input.get("recordingMetadataSha256").and_then(Value::as_str) != Some(metadata_hash.as_str()) {
    return Err(changed());
  }
  let flow = fixed_flow(
    material.get("flow").ok_or_else(changed)?,
    head.get("fixedModels").ok_or_else(changed)?,
  )?;
  let flow_hash = canonical(&flow)
    .map(|text| sha256_hex(text.as_bytes()))
    .ok_or_else(changed)?;
  if head.get("flowSnapshotSha256").and_then(Value::as_str) != Some(flow_hash.as_str()) {
    return Err(changed());
  }
  let source = material.get("sourceVersion").ok_or_else(changed)?;
  if !same_version(source, input.get("sourceVersion").ok_or_else(changed)?) {
    return Err(changed());
  }
  let fixed_refs = input
    .get("referencePages")
    .and_then(Value::as_array)
    .ok_or_else(changed)?;
  let refs = material
    .get("referencePages")
    .and_then(Value::as_array)
    .ok_or_else(changed)?;
  if fixed_refs.len() != refs.len()
    || !refs
      .iter()
      .zip(fixed_refs)
      .all(|(item, fixed)| item.get("pageId") == fixed.get("pageId") && same_version(item, fixed))
  {
    return Err(changed());
  }
  let fixed_prior = input.get("priorSteps").and_then(Value::as_array).ok_or_else(changed)?;
  let prior = material
    .get("priorSteps")
    .and_then(Value::as_array)
    .ok_or_else(changed)?;
  if fixed_prior.len() != prior.len()
    || !prior
      .iter()
      .zip(fixed_prior)
      .all(|(item, fixed)| item.get("stepId") == fixed.get("stepId") && same_version(item, fixed))
  {
    return Err(changed());
  }
  let titles = prompt
    .get("referenceTitles")
    .and_then(|value| value.get("value"))
    .and_then(Value::as_array)
    .ok_or_else(changed)?;
  if titles.len() != refs.len() {
    return Err(changed());
  }
  let reference_body: Vec<Value> = refs
    .iter()
    .zip(titles)
    .map(|(item, title)| {
      json!({
        "pageId": item["pageId"], "title": title["title"], "body": item["content"],
      })
    })
    .collect();
  let mut artifacts = Map::new();
  for item in prior {
    artifacts.insert(
      item["stepId"].as_str().ok_or_else(changed)?.into(),
      item["content"].clone(),
    );
  }
  let mut materials = json!({
    "sourceName": metadata["sourceName"], "source": source["content"], "artifacts": artifacts,
    "refs": reference_body, "info": prompt["info"]["value"],
  });
  if !prompt["about"]["value"].is_null() {
    materials["about"] = prompt["about"]["value"].clone();
  }
  if let Some(instruction) = op.output_target.as_ref().and_then(|target| target.get("instruction")) {
    materials["candidateInstruction"] = instruction.clone();
  }
  let index = flow["steps"]
    .as_array()
    .and_then(|steps| steps.iter().position(|step| step["id"] == step_id))
    .ok_or_else(changed)?;
  let kind = if index == 0 { "REVISION" } else { "INSIGHT" };
  let payload = json!({ "projectId": op.project_id.as_deref().unwrap_or(DOCS_ROOT_PROJECT_ID),
    "recordingId": op.recording_id, "stepKey": step_id, "kind": kind,
    "flow": flow, "materials": materials });
  let bytes = serde_json::to_vec(&payload).map_err(|_| changed())?;
  if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
    return Err(failure(
      "personal_device_too_large",
      "固定入力が大きすぎるため送れません。",
    ));
  }
  Ok(bytes)
}

fn api_path(op: &PersonalOperation, suffix: &str, session: &DeviceSession) -> CommandResult<url::Url> {
  let mut url = op
    .captured
    .niho_api_url(&format!("me/docs-device-runs{suffix}"))
    .ok_or_else(unavailable)?;
  if suffix.starts_with('/') && !suffix.ends_with("/start") && !suffix.ends_with("/ack") {
    url
      .query_pairs_mut()
      .append_pair("deviceId", &op.identity.device_id)
      .append_pair("generation", &session.generation);
  }
  Ok(url)
}

fn session_body(op: &PersonalOperation, session: &DeviceSession) -> Value {
  json!({ "deviceId": op.identity.device_id, "generation": session.generation })
}

async fn api_request(
  client: &ReqwestClient,
  cloud: &Cloud,
  op: &PersonalOperation,
  method: HttpMethod,
  url: url::Url,
  body: Option<&Value>,
  key: Option<&str>,
  max_body: usize,
) -> CommandResult<HttpResponse> {
  let token = op.captured.niho_id_token().await.map_err(|_| unavailable())?;
  let mut request = HttpRequest::new(method, url.to_string())
    .bearer(&token)
    .header("accept", "application/json")
    .max_body(max_body)
    .timeout(API_TIMEOUT);
  if let Some(body) = body {
    request = request.json(body);
  }
  if let Some(key) = key {
    request = request.header("Idempotency-Key", key);
  }
  send_guard(cloud, op, SendKind::DeviceNihoApi).await?;
  let response = client.send(request).await.map_err(|_| unknown())?;
  if op.captured.local_device_api_scope().is_none() {
    return Err(guard_failed());
  }
  Ok(response)
}

fn api_failure(response: &HttpResponse) -> CommandError {
  if response.status == 410 {
    return result_missing();
  }
  let value: Value = match serde_json::from_slice(&response.body) {
    Ok(value) => value,
    Err(_) => return unavailable(),
  };
  let code = value
    .get("error")
    .and_then(|error| error.get("details"))
    .and_then(|details| details.get("reason"))
    .and_then(Value::as_str)
    .unwrap_or("");
  let message = match code {
    "api_budget_exhausted" | "api_budget_unavailable" => {
      "NIHO API の今月の上限に達しました。上限を確認してから、もう一度頼んでください。"
    }
    "api_model_unavailable" => "この工程の AI モデルは NIHO API と一致しません。工程を確かめてください。",
    "device_session_changed" | "device_connection_required" => {
      "この Mac の接続が変わりました。ログインと保存先を確かめてください。"
    }
    "input_changed" | "storage_epoch_changed" => "保存先か固定入力が変わりました。もう一度実行してください。",
    "recording_run_active" => "この録音には実行中の依頼があります。結果を確かめてください。",
    "result_expired" => "結果を受け取れませんでした。もう一度頼んでください。",
    _ => "NIHO API が依頼を受け付けませんでした。状態を確かめてください。",
  };
  failure("personal_device_rejected", message)
}

fn response_json(response: &HttpResponse) -> CommandResult<Value> {
  if !(200..300).contains(&response.status) {
    return Err(api_failure(response));
  }
  serde_json::from_slice(&response.body).map_err(|_| unknown())
}

fn signed_upload(value: &Value, bytes: usize) -> CommandResult<Option<(String, Vec<(String, String)>)>> {
  let Some(upload) = value.get("upload") else {
    return Err(unknown());
  };
  if upload.is_null() {
    return Ok(None);
  }
  let url = upload.get("url").and_then(Value::as_str).ok_or_else(unknown)?;
  if !crate::pc_runner_api::valid_signed_upload_url(url) {
    return Err(unknown());
  }
  let headers = upload.get("headers").and_then(Value::as_object).ok_or_else(unknown)?;
  if headers.len() != 3
    || headers.get("content-type").and_then(Value::as_str) != Some("application/json")
    || headers.get("x-goog-if-generation-match").and_then(Value::as_str) != Some("0")
    || headers.get("x-goog-content-length-range").and_then(Value::as_str) != Some(format!("{bytes},{bytes}").as_str())
  {
    return Err(unknown());
  }
  Ok(Some((
    url.to_string(),
    headers
      .iter()
      .map(|(name, value)| (name.clone(), value.as_str().unwrap_or_default().to_string()))
      .collect(),
  )))
}

async fn put_signed(url: &str, headers: &[(String, String)], body: Vec<u8>) -> CommandResult<()> {
  let client = reqwest::Client::builder()
    .redirect(reqwest::redirect::Policy::none())
    .connect_timeout(Duration::from_secs(10))
    .build()
    .map_err(|_| unknown())?;
  let mut request = client.put(url).timeout(Duration::from_secs(120));
  for (name, value) in headers {
    request = request.header(name.as_str(), value.as_str());
  }
  let response = request.body(body).send().await.map_err(|_| unknown())?;
  if !response.status().is_success() && response.status().as_u16() != 412 {
    return Err(unknown());
  }
  Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Generated {
  text: String,
  run_id: String,
}

pub(crate) async fn generate(
  state: &AppState,
  cloud: &Cloud,
  handle: &str,
  snapshot_sha256: &str,
  step_id: &str,
  version_id: &str,
) -> CommandResult<Generated> {
  crate::safe_id(step_id)?;
  crate::safe_id(version_id)?;
  let op = operation_for(state, handle)?;
  if op.route.executor != Some(Executor::DeviceNihoApi) {
    return Err(guard_failed());
  }
  send_guard(cloud, &op, SendKind::DeviceNihoApi).await?;
  let head = op.st().head.clone().ok_or_else(intent_not_reserved)?;
  let verification = verify_inputs(state, handle, &Value::Object(head.clone()))?;
  if !verification.verified {
    return Err(changed());
  }
  let bytes = fixed_input(&op, step_id, snapshot_sha256)?;
  let payload: Value = serde_json::from_slice(&bytes).map_err(|_| changed())?;
  let model = head
    .get("fixedModels")
    .and_then(|models| models.get(step_id))
    .ok_or_else(changed)?;
  let client = ReqwestClient::new().map_err(|_| unavailable())?;
  let session = session(state, &op)?;
  let relative = relative_record(&op, step_id)?;
  let artifact_id = fixed_artifact_id(&op, CandidateKind::Artifact, step_id).ok_or_else(changed)?;
  let consent_version = head.get("consentVersion").and_then(Value::as_str).ok_or_else(changed)?;
  let input_sha256 = sha256_hex(&bytes);
  let prior = previous_record(
    state,
    &op,
    &session,
    step_id,
    &artifact_id,
    consent_version,
    &input_sha256,
    bytes.len(),
  )?;
  let reused = prior.is_some();
  if !reused {
    let access = super::niho::access(state, &client, handle, 1).await?;
    let step_provider = access.provider.as_deref().and_then(super::niho::niho_api_step_provider);
    if !access.available
      || model.get("provider").and_then(Value::as_str) != step_provider
      || model.get("model").and_then(Value::as_str) != access.model.as_deref()
      || head.get("consentVersion").and_then(Value::as_str) != access.consent_version.as_deref()
    {
      return Err(failure(
        "personal_device_not_ready",
        "NIHO API の利用条件とこの工程の AI が一致しません。内容を確かめてください。",
      ));
    }
  }
  let record = if let Some((old_relative, mut prior)) = prior {
    if prior.phase == "ack_pending" {
      return Err(failure(
        "personal_device_ack_pending",
        "前回の結果はこの Mac に保存済みです。受領通知を確認してください。",
      ));
    }
    if old_relative != relative {
      prior.version_id = version_id.into();
      prior.personal_run_id = op.run_id.clone();
      let encoded = serde_json::to_vec(&prior).map_err(|_| record_io())?;
      if !create_exclusive(&state.data_dir, &relative, &encoded).map_err(|_| record_io())? {
        return Err(record_io());
      }
      let mut old = prior.clone();
      old.phase = "transferred".into();
      write_plain(&state.data_dir, &old_relative, &old)?;
    } else if prior.version_id != version_id {
      return Err(unknown());
    }
    prior
  } else {
    let fresh = DeviceRecord {
      connection_id: session.connection_id.clone(),
      generation: session.generation.clone(),
      project_id: op.project_id.clone(),
      recording_page_id: op.recording_page_id.clone(),
      recording_id: op.recording_id.clone(),
      personal_run_id: op.run_id.clone(),
      step_id: step_id.into(),
      artifact_id,
      consent_version: consent_version.into(),
      version_id: version_id.into(),
      submission_key: request_key("device")?,
      ack_key: request_key("ack")?,
      input_sha256,
      input_bytes: bytes.len(),
      run_id: None,
      output_sha256: None,
      phase: "prepared".into(),
    };
    let encoded = serde_json::to_vec(&fresh).map_err(|_| record_io())?;
    if !create_exclusive(&state.data_dir, &relative, &encoded).map_err(|_| record_io())? {
      return Err(unknown());
    }
    fresh
  };

  let registered = api_request(
    &client,
    cloud,
    &op,
    HttpMethod::Post,
    api_path(&op, "/session", &session)?,
    Some(&session_body(&op, &session)),
    None,
    16 * 1024,
  )
  .await?;
  response_json(&registered)?;
  let mut record = record;
  if record.phase == "prepared" {
    let prepare = json!({
      "deviceId": op.identity.device_id, "generation": session.generation,
      "projectId": payload["projectId"], "recordingId": op.recording_id,
      "stepKey": step_id, "kind": payload["kind"],
      "inputSha256": record.input_sha256, "inputBytes": record.input_bytes,
      "consentVersion": head["consentVersion"],
    });
    let prepared = api_request(
      &client,
      cloud,
      &op,
      HttpMethod::Post,
      api_path(&op, "/", &session)?,
      Some(&prepare),
      Some(&record.submission_key),
      32 * 1024,
    )
    .await?;
    let prepared = response_json(&prepared)?;
    let run_id = prepared.get("runId").and_then(Value::as_str).ok_or_else(unknown)?;
    crate::safe_id(run_id)?;
    if record.run_id.as_deref().is_some_and(|known| known != run_id) {
      return Err(unknown());
    }
    record.run_id = Some(run_id.to_string());
    write_plain(&state.data_dir, &relative, &record)?;
    if let Some((url, headers)) = signed_upload(&prepared, bytes.len())? {
      send_guard(cloud, &op, SendKind::DeviceNihoApi).await?;
      put_signed(&url, &headers, bytes).await?;
    }
    let started = api_request(
      &client,
      cloud,
      &op,
      HttpMethod::Post,
      api_path(&op, &format!("/{run_id}/start"), &session)?,
      Some(&session_body(&op, &session)),
      None,
      32 * 1024,
    )
    .await?;
    response_json(&started)?;
    record.phase = "queued".into();
    write_plain(&state.data_dir, &relative, &record)?;
  } else if reused && record.phase == "queued" {
    // DB が QUEUED になった直後、Cloud Task の投入応答前に通信が切れた場合も同じ run を起動し直す。
    // start は runId に冪等で、同じ task 名の再投入はサーバー側で重複排除される。
    let run_id = record.run_id.as_deref().ok_or_else(unknown)?;
    let started = api_request(
      &client,
      cloud,
      &op,
      HttpMethod::Post,
      api_path(&op, &format!("/{run_id}/start"), &session)?,
      Some(&session_body(&op, &session)),
      None,
      32 * 1024,
    )
    .await?;
    response_json(&started)?;
  }
  let run_id = record.run_id.as_deref().ok_or_else(unknown)?;
  for _ in 0..RESULT_WAIT {
    if op.stop_requested() {
      return Err(unknown());
    }
    let status = api_request(
      &client,
      cloud,
      &op,
      HttpMethod::Get,
      api_path(&op, &format!("/{run_id}"), &session)?,
      None,
      None,
      32 * 1024,
    )
    .await?;
    let status = response_json(&status)?;
    match status.get("status").and_then(Value::as_str) {
      Some("ready") => {
        let result = api_request(
          &client,
          cloud,
          &op,
          HttpMethod::Get,
          api_path(&op, &format!("/{run_id}/result"), &session)?,
          None,
          None,
          MAX_RESULT_BYTES,
        )
        .await?;
        if result.status == 410 {
          record.phase = "expired".into();
          write_plain(&state.data_dir, &relative, &record)?;
          return Err(result_missing());
        }
        if result.status != 200 {
          return Err(api_failure(&result));
        }
        let text = String::from_utf8(result.body).map_err(|_| result_missing())?;
        if text.is_empty() {
          return Err(result_missing());
        }
        record.output_sha256 = Some(sha256_hex(text.as_bytes()));
        record.phase = "ready".into();
        write_plain(&state.data_dir, &relative, &record)?;
        return Ok(Generated {
          text,
          run_id: run_id.into(),
        });
      }
      Some("failed" | "expired") => {
        record.phase = "expired".into();
        write_plain(&state.data_dir, &relative, &record)?;
        return Err(result_missing());
      }
      Some("result_unknown") => return Err(unknown()),
      Some("queued" | "running" | "preparing") => tokio::time::sleep(Duration::from_secs(2)).await,
      _ => return Err(unknown()),
    }
  }
  Err(unknown())
}

pub(crate) async fn ack(state: &AppState, handle: &str, step_id: &str, version_id: &str) -> CommandResult<()> {
  let op = operation_for(state, handle)?;
  if op.route.executor != Some(Executor::DeviceNihoApi) || op.stop_requested() {
    return Err(guard_failed());
  }
  let relative = relative_record(&op, step_id)?;
  let mut record = read_plain::<DeviceRecord>(&state.data_dir, &relative)?.ok_or_else(record_io)?;
  if record.step_id != step_id
    || record.version_id != version_id
    || record.connection_id != op.captured.local_device_api_scope().ok_or_else(guard_failed)?
  {
    return Err(guard_failed());
  }
  let committed = op.st().receipts.iter().any(|receipt| {
    receipt.step_id == step_id
      && receipt.version.get("versionId").and_then(Value::as_str) == Some(version_id)
      && receipt.version.get("sha256").and_then(Value::as_str) == record.output_sha256.as_deref()
  });
  if !committed {
    return Err(guard_failed());
  }
  if record.phase == "acked" {
    return Ok(());
  }
  if record.phase != "ready" && record.phase != "ack_pending" {
    return Err(unknown());
  }
  record.phase = "ack_pending".into();
  write_plain(&state.data_dir, &relative, &record)?;
  let run_id = record.run_id.as_deref().ok_or_else(unknown)?;
  let session = DeviceSession {
    connection_id: record.connection_id.clone(),
    generation: record.generation.clone(),
  };
  let client = ReqwestClient::new().map_err(|_| unavailable())?;
  let token = op.captured.niho_id_token().await.map_err(|_| unavailable())?;
  precheck(&op)?;
  let url = api_path(&op, &format!("/{run_id}/ack"), &session)?;
  let request = HttpRequest::new(HttpMethod::Post, url.to_string())
    .bearer(&token)
    .json(&json!({ "deviceId": op.identity.device_id, "generation": record.generation, "ackKey": record.ack_key }))
    .max_body(32 * 1024)
    .timeout(API_TIMEOUT);
  let response = client.send(request).await.map_err(|_| unknown())?;
  response_json(&response)?;
  record.phase = "acked".into();
  write_plain(&state.data_dir, &relative, &record)
}

fn saved_result(captured: &CapturedOperation, record: &DeviceRecord) -> bool {
  let Some(expected) = record.output_sha256.as_deref() else {
    return false;
  };
  let Ok(rec) = captured.store().personal_recording(
    record.project_id.as_deref(),
    &record.recording_page_id,
    &record.recording_id,
  ) else {
    return false;
  };
  let path = format!(
    "recordings/{}/versions/{}/{}.md",
    record.recording_id, record.artifact_id, record.version_id
  );
  let Ok(Some(bytes)) = captured.store().personal_read_version(&rec, &record.artifact_id, &path) else {
    return false;
  };
  if sha256_hex(&bytes) != expected {
    return false;
  }
  let Ok(Some(row)) =
    captured
      .store()
      .personal_published_version_row(&rec, &record.step_id, &record.artifact_id, &path)
  else {
    return false;
  };
  row.get("versionSha256").and_then(Value::as_str) == Some(expected)
    && row.get("versionPath").and_then(Value::as_str) == Some(path.as_str())
    && row.get("personalRunId").and_then(Value::as_str) == Some(record.personal_run_id.as_str())
    && row.get("origin").and_then(Value::as_str) == Some("this_pc")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
  acknowledged: usize,
  pending: usize,
}

/// 再起動後、版と runs.jsonl をもう一度照合できた ACK だけを再送する。
pub(crate) async fn recover_acks(state: &AppState, cloud: &Cloud) -> CommandResult<Recovery> {
  let captured = cloud.capture_operation().await?;
  let Some(connection_id) = captured.local_device_api_scope() else {
    return Ok(Recovery {
      acknowledged: 0,
      pending: 0,
    });
  };
  let identity = captured.identity();
  let dir = intents_dir(&identity)?;
  let session_path = format!("{dir}/device-session.json");
  let Some(session) = read_plain::<DeviceSession>(&state.data_dir, &session_path)? else {
    return Ok(Recovery {
      acknowledged: 0,
      pending: 0,
    });
  };
  if session.connection_id != connection_id {
    return Ok(Recovery {
      acknowledged: 0,
      pending: 0,
    });
  }
  let path = create_dirs_without_symlinks(&state.data_dir, &dir).map_err(|_| record_io())?;
  let client = ReqwestClient::new().map_err(|_| unavailable())?;
  let mut recovery = Recovery {
    acknowledged: 0,
    pending: 0,
  };
  for (index, entry) in fs::read_dir(path).map_err(|_| record_io())?.enumerate() {
    if index >= 1000 {
      return Err(record_io());
    }
    let entry = entry.map_err(|_| record_io())?;
    let name = entry.file_name();
    let Some(name) = name.to_str() else {
      return Err(record_io());
    };
    if !name.ends_with(".device.json") {
      continue;
    }
    let relative = format!("{dir}/{name}");
    let Some(mut record) = read_plain::<DeviceRecord>(&state.data_dir, &relative)? else {
      continue;
    };
    if !["ready", "ack_pending"].contains(&record.phase.as_str())
      || record.connection_id != connection_id
      || record.generation != session.generation
    {
      continue;
    }
    if !saved_result(&captured, &record) {
      continue;
    }
    recovery.pending += 1;
    let Some(run_id) = record.run_id.as_deref() else {
      continue;
    };
    if crate::safe_id(run_id).is_err() {
      continue;
    }
    let Some(url) = captured.niho_api_url(&format!("me/docs-device-runs/{run_id}/ack")) else {
      continue;
    };
    let Ok(token) = captured.niho_id_token().await else {
      continue;
    };
    if captured.local_device_api_scope().as_deref() != Some(connection_id.as_str()) {
      break;
    }
    let request = HttpRequest::new(HttpMethod::Post, url.to_string())
      .bearer(&token)
      .json(
        &json!({ "deviceId": identity.device_id, "generation": session.generation,
        "ackKey": record.ack_key }),
      )
      .max_body(32 * 1024)
      .timeout(API_TIMEOUT);
    let Ok(response) = client.send(request).await else {
      continue;
    };
    if response_json(&response).is_err() {
      continue;
    }
    record.phase = "acked".into();
    write_plain(&state.data_dir, &relative, &record)?;
    recovery.acknowledged += 1;
    recovery.pending -= 1;
  }
  Ok(recovery)
}

#[tauri::command]
pub async fn personal_device_generate(
  state: tauri::State<'_, AppState>,
  cloud: tauri::State<'_, Cloud>,
  handle: String,
  snapshot_sha256: String,
  step_id: String,
  version_id: String,
) -> CommandResult<Generated> {
  generate(&state, &cloud, &handle, &snapshot_sha256, &step_id, &version_id).await
}

#[tauri::command]
pub async fn personal_device_ack(
  state: tauri::State<'_, AppState>,
  handle: String,
  step_id: String,
  version_id: String,
) -> CommandResult<()> {
  ack(&state, &handle, &step_id, &version_id).await
}

#[tauri::command]
pub async fn personal_device_recover_acks(
  state: tauri::State<'_, AppState>,
  cloud: tauri::State<'_, Cloud>,
) -> CommandResult<Recovery> {
  recover_acks(&state, &cloud).await
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn fixed_flow_keeps_transcription_disabled_and_preserves_legacy_hashes() {
    let mut flow = json!({ "version": 1, "id": "flow", "revision": 1, "name": "工程", "guide": "", "terms": [], "samples": [], "steps": [] });
    let models = json!({});
    let legacy = fixed_flow(&flow, &models).unwrap();
    flow["transcription"] = json!(true);
    assert_eq!(fixed_flow(&flow, &models).unwrap(), legacy);
    flow["transcription"] = json!(false);
    let disabled = fixed_flow(&flow, &models).unwrap();
    assert_eq!(disabled["transcription"], json!(false));
    assert_ne!(disabled, legacy);
  }
}
