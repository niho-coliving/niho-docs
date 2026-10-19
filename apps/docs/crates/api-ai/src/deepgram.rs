//! Deepgram の録音の文字起こし（同期の呼び出し。callback は使わない）。設定は NIHO 本体
//! （apps/api の ops の Deepgram の文字起こし）の写し: `model=nova-3`・`language`・`smart_format=false`・`punctuate=true`・
//! 話者を分けるときだけ `diarize_model=latest`・`utterances=true`・`paragraphs=false`・固有名詞の表記を `keyterm` の繰り返しで。
//! 音声はファイルのまま流して送る（`Authorization: Token <鍵>`）。

use crate::http::{self, classify_status, error_summary, transport_reason};
use crate::turn::{api_error, or_stop, read_limited, runtime, Raced, StopSignal};
use crate::types::{Account, ApiError, Config, DeepgramRequest, DeepgramResult, DeepgramUtterance, Reason, Secret};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

pub const DEEPGRAM_MODEL: &str = "nova-3";

/// 送る URL（鍵は入れない）。
pub fn listen_url(base: &str, request: &DeepgramRequest) -> Result<reqwest::Url, ApiError> {
  let mut url = reqwest::Url::parse(&format!("{base}/v1/listen"))
    .map_err(|_| api_error(Reason::TransientFailure, Account::Deepgram))?;
  let language = if request.language == "en" { "en" } else { "ja" };
  {
    let mut query = url.query_pairs_mut();
    query.append_pair("model", DEEPGRAM_MODEL);
    query.append_pair("language", language);
    query.append_pair("smart_format", "false");
    query.append_pair("punctuate", "true");
    if request.diarize {
      query.append_pair("diarize_model", "latest");
    }
    query.append_pair("utterances", "true");
    query.append_pair("paragraphs", "false");
    for keyterm in request
      .keyterms
      .iter()
      .map(|term| term.trim())
      .filter(|term| !term.is_empty())
    {
      query.append_pair("keyterm", keyterm);
    }
  }
  Ok(url)
}

fn content_type(path: &Path) -> &'static str {
  match path
    .extension()
    .and_then(|ext| ext.to_str())
    .map(str::to_ascii_lowercase)
    .as_deref()
  {
    Some("wav") => "audio/wav",
    Some("mp3") => "audio/mpeg",
    Some("m4a") | Some("mp4") => "audio/mp4",
    Some("aac") => "audio/aac",
    Some("flac") => "audio/flac",
    Some("ogg") | Some("oga") => "audio/ogg",
    Some("webm") => "audio/webm",
    _ => "application/octet-stream",
  }
}

/// 返りから要るものだけ読む（utterances・長さ・utterances が無いときの全文）。
pub fn parse_result(value: &Value) -> DeepgramResult {
  let utterances = value["results"]["utterances"]
    .as_array()
    .map(|items| {
      items
        .iter()
        .filter_map(|item| {
          let transcript = item.get("transcript")?.as_str()?.trim().to_string();
          Some(DeepgramUtterance {
            start: item.get("start").and_then(Value::as_f64).unwrap_or(0.0),
            end: item.get("end").and_then(Value::as_f64).unwrap_or(0.0),
            speaker: item
              .get("speaker")
              .and_then(Value::as_u64)
              .map(|speaker| speaker as u32),
            transcript,
          })
        })
        .filter(|utterance| !utterance.transcript.is_empty())
        .collect()
    })
    .unwrap_or_default();
  let transcript = value["results"]["channels"]
    .as_array()
    .map(|channels| {
      channels
        .iter()
        .filter_map(|channel| channel["alternatives"][0].get("transcript").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
    })
    .unwrap_or_default();
  DeepgramResult {
    duration_sec: value["metadata"].get("duration").and_then(Value::as_f64),
    utterances,
    transcript,
  }
}

/// 音声 1 つを文字起こしする（終わるまで戻らない。`stop` で止める＝接続を切って `Err(Stopped 相当)`）。
/// 止めたときは `Ok(None)`。
pub fn transcribe(
  config: &Config,
  key: &Secret,
  audio: &Path,
  request: &DeepgramRequest,
  timeout: Duration,
  stop: &StopSignal,
) -> Result<Option<DeepgramResult>, ApiError> {
  if key.expose().trim().is_empty() {
    return Err(api_error(Reason::NotConfigured, Account::Deepgram));
  }
  let url = listen_url(&config.endpoints.deepgram, request)?;
  let runtime = runtime()?;
  let outcome = runtime.block_on(async {
    let work = async {
      let client = http::client()?;
      let file = tokio::fs::File::open(audio)
        .await
        .map_err(|_| api_error(Reason::BadRequest, Account::Deepgram))?;
      let length = file.metadata().await.map(|meta| meta.len()).unwrap_or(0);
      config.log(
        "deepgram_started",
        json!({ "bytes": length, "keyterms": request.keyterms.len(), "diarize": request.diarize }),
      );
      let response = client
        .post(url)
        .header("Authorization", format!("Token {}", key.expose()))
        .header("Content-Type", content_type(audio))
        .header("Content-Length", length.to_string())
        .body(reqwest::Body::from(file))
        .send()
        .await
        .map_err(|error| api_error(transport_reason(&error), Account::Deepgram))?;
      let status = response.status().as_u16();
      let body = read_limited(response, 64 * 1024 * 1024).await;
      if !(200..300).contains(&status) {
        let reason = classify_status(status, &body);
        // Deepgram の 400 は音声の形の誤りが多い（モデルの指定はこちらの固定値）
        let reason = if reason == Reason::ModelNotFound {
          Reason::BadRequest
        } else {
          reason
        };
        config.log(
          "deepgram_failed",
          json!({ "status": status, "reason": reason.as_str(), "error": error_summary(&body, &[key.expose()]) }),
        );
        return Err(api_error(reason, Account::Deepgram));
      }
      let value: Value =
        serde_json::from_str(&body).map_err(|_| api_error(Reason::TransientFailure, Account::Deepgram))?;
      let result = parse_result(&value);
      config.log(
        "deepgram_done",
        json!({ "utterances": result.utterances.len(), "durationSec": result.duration_sec }),
      );
      Ok::<DeepgramResult, ApiError>(result)
    };
    or_stop(tokio::time::timeout(timeout, work), stop).await
  });
  match outcome {
    Raced::Stopped => Ok(None),
    Raced::Done(Err(_)) => Err(api_error(Reason::Timeout, Account::Deepgram)),
    Raced::Done(Ok(result)) => result.map(Some),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_url_copies_the_niho_settings_and_repeats_keyterms() {
    let url = listen_url(
      "https://api.deepgram.com",
      &DeepgramRequest {
        language: "ja".into(),
        diarize: true,
        keyterms: vec!["NIHO鎌倉".into(), "由比ガ浜".into()],
      },
    )
    .unwrap();
    let pairs: Vec<(String, String)> = url
      .query_pairs()
      .map(|(k, v)| (k.into_owned(), v.into_owned()))
      .collect();
    let get = |key: &str| {
      pairs
        .iter()
        .filter(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .collect::<Vec<_>>()
    };
    assert_eq!(url.path(), "/v1/listen");
    assert_eq!(get("model"), vec!["nova-3"]);
    assert_eq!(get("language"), vec!["ja"]);
    assert_eq!(get("smart_format"), vec!["false"]);
    assert_eq!(get("punctuate"), vec!["true"]);
    assert_eq!(get("diarize_model"), vec!["latest"]);
    assert_eq!(get("utterances"), vec!["true"]);
    assert_eq!(get("paragraphs"), vec!["false"]);
    assert_eq!(get("keyterm"), vec!["NIHO鎌倉", "由比ガ浜"]);
    assert!(get("callback").is_empty());
    let solo = listen_url(
      "https://api.deepgram.com",
      &DeepgramRequest {
        language: "en".into(),
        diarize: false,
        keyterms: vec![],
      },
    )
    .unwrap();
    assert!(!solo.as_str().contains("diarize"));
    assert!(solo.as_str().contains("language=en"));
  }

  #[test]
  fn results_keep_utterances_and_the_fallback_transcript() {
    let value = json!({
      "metadata": { "duration": 95.5, "request_id": "r" },
      "results": {
        "channels": [{ "alternatives": [{ "transcript": "全文 です" }] }],
        "utterances": [
          { "start": 0.5, "end": 3.0, "speaker": 0, "transcript": "こんにちは" },
          { "start": 3.2, "end": 4.0, "speaker": 1, "transcript": " " },
          { "start": 4.1, "end": 9.0, "speaker": 1, "transcript": "どうも" }
        ]
      }
    });
    let result = parse_result(&value);
    assert_eq!(result.duration_sec, Some(95.5));
    assert_eq!(result.utterances.len(), 2);
    assert_eq!(result.utterances[1].speaker, Some(1));
    assert_eq!(result.transcript, "全文 です");
  }
}
