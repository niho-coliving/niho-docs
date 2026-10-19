use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::Arc;

use async_trait::async_trait;
use reqwest::{Method, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::scanner::verify_open_file;
use crate::types::{
    BlobReservation, CommitRequest, CommitResponse, FileKind, Lease, Manifest, ManifestFile,
    ProjectSummary, ProviderKind, ProviderSettings, Result, SyncScope, UploadMethod, Usage,
    VaultError, DOCS_ROOT_PROJECT_ID, PROFILE_PROJECT_ID,
};
use crate::{validate_project_id, validate_relative_path};
use sha2::{Digest, Sha256};

const INLINE_MAX_BYTES: usize = 256 * 1024;
const RESUMABLE_CHUNK_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const BUFFERED_TRANSFER_MAX_BYTES: u64 = RESUMABLE_CHUNK_BYTES as u64;
const TRANSFER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2 * 60 * 60);
const JSON_MAX_BYTES: usize = 16 * 1024 * 1024;
const ERROR_MAX_BYTES: usize = 64 * 1024;

fn ensure_buffered_transfer_limit(bytes: u64, operation: &str, streaming_api: &str) -> Result<()> {
    if bytes > BUFFERED_TRANSFER_MAX_BYTES {
        return Err(VaultError::InvalidResponse(format!(
            "buffered {operation} is limited to 8 MiB; use {streaming_api} for larger blobs"
        )));
    }
    Ok(())
}

#[async_trait]
pub trait IdTokenProvider: Send + Sync {
    /// 捕捉した login session / root binding がまだ同一かを確認する。
    fn ensure_current(&self) -> Result<()> {
        Ok(())
    }

    /// API request の直前に毎回呼ばれる。NIHO docs は捕捉した account session ticket から token を得る。
    async fn id_token(&self) -> Result<String>;
}

#[async_trait]
impl<F, Fut> IdTokenProvider for F
where
    F: Fn() -> Fut + Send + Sync,
    Fut: std::future::Future<Output = Result<String>> + Send,
{
    async fn id_token(&self) -> Result<String> {
        (self)().await
    }
}

#[async_trait]
pub trait VaultProvider: Send + Sync {
    /// HTTP 待機の前後とローカル apply 直前に使う context fence。
    fn check_context(&self) -> Result<()> {
        Ok(())
    }
    fn is_local(&self) -> bool {
        false
    }
    /// 端末（deviceId）ごとの保存先の設定。行が無ければ `local`・`updatedAt: null`。
    async fn get_settings(&self, device_id: &str) -> Result<ProviderSettings>;
    async fn put_settings(
        &self,
        device_id: &str,
        provider: ProviderKind,
    ) -> Result<ProviderSettings>;
    async fn list_projects(&self, reserved: bool, deleted: bool) -> Result<Vec<ProjectSummary>>;
    async fn get_or_create_project(&self, project_id: &str, name: Option<&str>)
        -> Result<Manifest>;
    async fn get_project(&self, project_id: &str) -> Result<Manifest>;
    async fn get_or_create_root(&self) -> Result<Manifest> {
        self.get_or_create_project(crate::types::DOCS_ROOT_PROJECT_ID, None)
            .await
    }
    async fn get_root(&self) -> Result<Manifest> {
        self.get_project(crate::types::DOCS_ROOT_PROJECT_ID).await
    }
    async fn upload_blob(
        &self,
        project_id: &str,
        file: &ManifestFile,
        bytes: Vec<u8>,
    ) -> Result<()>;
    async fn upload_blob_file(
        &self,
        project_id: &str,
        file: &ManifestFile,
        source: &mut File,
    ) -> Result<()> {
        ensure_buffered_transfer_limit(
            file.bytes,
            "upload fallback",
            "a provider override of upload_blob_file",
        )?;
        verify_open_file(source, file)?;
        let capacity = file.bytes as usize;
        let mut bytes = Vec::with_capacity(capacity);
        source.read_to_end(&mut bytes)?;
        self.upload_blob(project_id, file, bytes).await
    }
    async fn download_blob(&self, project_id: &str, file: &ManifestFile)
        -> Result<Option<Vec<u8>>>;
    async fn download_blob_file(
        &self,
        project_id: &str,
        file: &ManifestFile,
        destination: &mut File,
    ) -> Result<bool> {
        ensure_buffered_transfer_limit(
            file.bytes,
            "download fallback",
            "a provider override of download_blob_file",
        )?;
        let Some(bytes) = self.download_blob(project_id, file).await? else {
            return Ok(false);
        };
        verify_blob(file, &bytes)?;
        destination.set_len(0)?;
        destination.seek(SeekFrom::Start(0))?;
        destination.write_all(&bytes)?;
        destination.seek(SeekFrom::Start(0))?;
        Ok(true)
    }
    async fn commit(&self, project_id: &str, request: &CommitRequest) -> Result<CommitResponse>;
    /// Send the exact body persisted by the outbox. Mock providers remain compatible through
    /// the typed `commit` port, but may not observe bytes unless they override this method.
    async fn commit_raw(
        &self,
        project_id: &str,
        request: &CommitRequest,
        frozen_body: &[u8],
    ) -> Result<CommitResponse> {
        validate_frozen_commit_body(request, frozen_body)?;
        self.commit(project_id, request).await
    }
    async fn delete_project(&self, project_id: &str) -> Result<()>;
    async fn restore_project(&self, project_id: &str) -> Result<()>;
    async fn acquire_lease(
        &self,
        project_id: &str,
        device_id: &str,
        device_name: &str,
        lease_id: Option<&str>,
    ) -> Result<Lease>;
    async fn renew_lease(&self, project_id: &str, lease_id: &str) -> Result<Lease>;
    async fn release_lease(&self, project_id: &str, lease_id: &str) -> Result<()>;
    async fn usage(&self) -> Result<Usage>;
}

#[derive(Default)]
pub struct LocalProvider;

#[async_trait]
impl VaultProvider for LocalProvider {
    fn is_local(&self) -> bool {
        true
    }
    async fn get_settings(&self, _device_id: &str) -> Result<ProviderSettings> {
        Ok(ProviderSettings {
            provider: ProviderKind::Local,
            updated_at: None,
        })
    }
    async fn put_settings(
        &self,
        _device_id: &str,
        provider: ProviderKind,
    ) -> Result<ProviderSettings> {
        Ok(ProviderSettings {
            provider,
            updated_at: None,
        })
    }
    async fn list_projects(&self, _reserved: bool, _deleted: bool) -> Result<Vec<ProjectSummary>> {
        Ok(Vec::new())
    }
    async fn get_or_create_project(
        &self,
        project_id: &str,
        _name: Option<&str>,
    ) -> Result<Manifest> {
        Ok(Manifest::empty(project_id))
    }
    async fn get_project(&self, project_id: &str) -> Result<Manifest> {
        Ok(Manifest::empty(project_id))
    }
    async fn upload_blob(
        &self,
        _project_id: &str,
        _file: &ManifestFile,
        _bytes: Vec<u8>,
    ) -> Result<()> {
        Ok(())
    }
    async fn download_blob(
        &self,
        _project_id: &str,
        _file: &ManifestFile,
    ) -> Result<Option<Vec<u8>>> {
        Ok(None)
    }
    async fn commit(&self, _project_id: &str, request: &CommitRequest) -> Result<CommitResponse> {
        Ok(CommitResponse {
            mutation_id: request.mutation_id.clone(),
            revision: request.base_revision.checked_add(1).ok_or_else(|| {
                VaultError::InvalidResponse("commit base revision overflow".into())
            })?,
            replayed: false,
        })
    }
    async fn delete_project(&self, _project_id: &str) -> Result<()> {
        Ok(())
    }
    async fn restore_project(&self, _project_id: &str) -> Result<()> {
        Ok(())
    }
    async fn acquire_lease(
        &self,
        _project_id: &str,
        _device_id: &str,
        _device_name: &str,
        _lease_id: Option<&str>,
    ) -> Result<Lease> {
        Ok(Lease {
            lease_id: String::new(),
            expires_at: String::new(),
        })
    }
    async fn renew_lease(&self, _project_id: &str, _lease_id: &str) -> Result<Lease> {
        self.acquire_lease("", "", "", None).await
    }
    async fn release_lease(&self, _project_id: &str, _lease_id: &str) -> Result<()> {
        Ok(())
    }
    async fn usage(&self) -> Result<Usage> {
        Ok(Usage {
            used_bytes: 0,
            reserved_bytes: 0,
            quota_bytes: 0,
            audio_bytes: 0,
            projects: Vec::new(),
        })
    }
}

pub struct NihoProvider {
    api_base: Url,
    client: reqwest::Client,
    token: Arc<dyn IdTokenProvider>,
    allow_local_signed_urls: bool,
    storage_change_hook: Option<Arc<dyn Fn() + Send + Sync>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NihoEnvironment {
    Production,
    Staging,
}

impl NihoProvider {
    pub fn new(environment: NihoEnvironment, token: Arc<dyn IdTokenProvider>) -> Result<Self> {
        let api_base = match environment {
            NihoEnvironment::Production => "https://niho.life/api",
            NihoEnvironment::Staging => "https://app-stg.niho.life/api",
        };
        Self::with_api_base(api_base, token, false)
    }

    /// ローカル HTTP fixture 専用。production code から任意 URL を注入しない。
    #[doc(hidden)]
    pub fn new_for_test(api_base: &str, token: Arc<dyn IdTokenProvider>) -> Result<Self> {
        Self::with_api_base(api_base, token, true)
    }

    fn with_api_base(
        api_base: &str,
        token: Arc<dyn IdTokenProvider>,
        test_fixture: bool,
    ) -> Result<Self> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let api_base = normalize_api_base(api_base, test_fixture)?;
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            api_base,
            client,
            token,
            allow_local_signed_urls: test_fixture,
            storage_change_hook: None,
        })
    }

    /// 保存先の fence 409 を受けたら、Mac のユーザー単位の保存先を即時読み直す。
    pub fn with_storage_change_hook(mut self, hook: Arc<dyn Fn() + Send + Sync>) -> Self {
        self.storage_change_hook = Some(hook);
        self
    }

    /// 未公開の再開 baseline の blob を、通常 vault と同じ署名 URL 検査と streaming 転送で送る。
    /// 呼び出し側は同じ file descriptor の内容と identity を前後で確認する。
    pub async fn upload_staged_blob_file(
        &self,
        method: UploadMethod,
        url: &str,
        headers: &BTreeMap<String, String>,
        source: &mut File,
        bytes: u64,
    ) -> Result<()> {
        self.upload_reservation_file(method, url, headers, source, bytes)
            .await
    }

    async fn error(&self, response: reqwest::Response) -> VaultError {
        let error = api_error(response).await;
        if matches!(&error, VaultError::Api { status: 409, code, .. } if code.starts_with("DOCS_STORAGE_"))
        {
            if let Some(hook) = &self.storage_change_hook {
                hook();
            }
        }
        error
    }

    fn endpoint(&self, suffix: &str) -> String {
        format!("{}me/docs-vault{}", self.api_base, suffix)
    }

    async fn api_request(&self, method: Method, suffix: &str) -> Result<reqwest::RequestBuilder> {
        self.token.ensure_current()?;
        let token = self.token.id_token().await?;
        self.token.ensure_current()?;
        Ok(self
            .client
            .request(method, self.endpoint(suffix))
            .bearer_auth(token))
    }

    /// NIHO docs のページ単位リンク共有。token と現在の root/session fence は通常の vault 通信と同じ。
    async fn page_sharing_request(
        &self,
        method: Method,
        page_id: &str,
        project_id: &str,
        text_id: Option<&str>,
        rotate: bool,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let valid_id = |value: &str| {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        };
        if !valid_id(page_id) || !valid_id(project_id) || text_id.is_some_and(|id| !valid_id(id)) {
            return Err(VaultError::InvalidPath(
                "invalid page sharing locator".into(),
            ));
        }
        let suffix = format!(
            "me/docs/pages/{page_id}/sharing{}",
            if rotate { "/rotate" } else { "" }
        );
        let mut url = self
            .api_base
            .join(&suffix)
            .map_err(|_| VaultError::InvalidPath("invalid sharing URL".into()))?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("projectId", project_id);
            if let Some(text_id) = text_id {
                query.append_pair("textId", text_id);
            }
        }
        self.token.ensure_current()?;
        let token = self.token.id_token().await?;
        self.token.ensure_current()?;
        let mut request = self.client.request(method, url).bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        self.json(request).await
    }

    pub async fn get_docs_page_sharing(
        &self,
        page_id: &str,
        project_id: &str,
        text_id: Option<&str>,
    ) -> Result<serde_json::Value> {
        self.page_sharing_request(Method::GET, page_id, project_id, text_id, false, None)
            .await
    }

    pub async fn set_docs_page_sharing(
        &self,
        page_id: &str,
        project_id: &str,
        text_id: Option<&str>,
        published: bool,
    ) -> Result<serde_json::Value> {
        self.page_sharing_request(
            Method::PATCH,
            page_id,
            project_id,
            text_id,
            false,
            Some(serde_json::json!({ "published": published })),
        )
        .await
    }

    pub async fn rotate_docs_page_sharing(
        &self,
        page_id: &str,
        project_id: &str,
        text_id: Option<&str>,
        expected_public_id: &str,
    ) -> Result<serde_json::Value> {
        if expected_public_id.len() != 22
            || !expected_public_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(VaultError::InvalidPath("invalid public ID".into()));
        }
        self.page_sharing_request(
            Method::POST,
            page_id,
            project_id,
            text_id,
            true,
            Some(serde_json::json!({ "expectedPublicId": expected_public_id })),
        )
        .await
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response> {
        self.token.ensure_current()?;
        let response = request.send().await.map_err(offline_error)?;
        self.token.ensure_current()?;
        Ok(response)
    }

    async fn json<T: DeserializeOwned>(&self, request: reqwest::RequestBuilder) -> Result<T> {
        let response = self.send(request).await?;
        if !response.status().is_success() {
            return Err(self.error(response).await);
        }
        let bytes = bounded_response_bytes(response, JSON_MAX_BYTES).await?;
        self.token.ensure_current()?;
        serde_json::from_slice(&bytes)
            .map_err(|_| VaultError::InvalidResponse("invalid JSON response".into()))
    }

    async fn manifest(
        &self,
        project_id: &str,
        request: reqwest::RequestBuilder,
    ) -> Result<Manifest> {
        #[derive(serde::Deserialize)]
        struct WireManifest {
            #[serde(default)]
            scope: Option<String>,
            #[serde(flatten)]
            manifest: Manifest,
        }
        let wire: WireManifest = self.json(request).await?;
        let expected_scope = if project_id == DOCS_ROOT_PROJECT_ID {
            "ROOT"
        } else {
            "FOLDER"
        };
        // 旧 FOLDER の最小応答は引き続き読めるが、新設 ROOT は明示した scope を必須にする。
        if wire
            .scope
            .as_deref()
            .is_some_and(|scope| scope != expected_scope)
            || (project_id == DOCS_ROOT_PROJECT_ID && wire.scope.is_none())
        {
            return Err(VaultError::InvalidResponse(
                "manifest wire scope mismatch".into(),
            ));
        }
        validate_manifest(project_id, wire.manifest)
    }

    async fn empty(&self, request: reqwest::RequestBuilder) -> Result<()> {
        let response = self.send(request).await?;
        if !response.status().is_success() {
            return Err(self.error(response).await);
        }
        Ok(())
    }

    async fn reserve_blob(
        &self,
        project_id: &str,
        file: &ManifestFile,
        inline: Option<String>,
    ) -> Result<BlobReservation> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            sha256: &'a str,
            bytes: u64,
            content_type: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            inline: Option<String>,
        }
        let body = Body {
            sha256: &file.sha256,
            bytes: file.bytes,
            content_type: file.kind.content_type(&file.path),
            inline,
        };
        self.json(
            self.api_request(Method::POST, &format!("/projects/{project_id}/blobs"))
                .await?
                .json(&body),
        )
        .await
    }

    async fn complete_upload(&self, project_id: &str, sha256: &str, upload_id: &str) -> Result<()> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            upload_id: &'a str,
        }
        self.empty(
            self.api_request(
                Method::POST,
                &format!("/projects/{project_id}/blobs/{sha256}/complete"),
            )
            .await?
            .json(&Body { upload_id }),
        )
        .await
    }

    async fn blob_response(
        &self,
        project_id: &str,
        file: &ManifestFile,
    ) -> Result<Option<reqwest::Response>> {
        if file.kind == FileKind::Audio && !file.available {
            return Ok(None);
        }
        let response = if matches!(file.kind, FileKind::Text | FileKind::Json) {
            self.send(
                self.api_request(
                    Method::GET,
                    &format!("/projects/{project_id}/blobs/{}/content", file.sha256),
                )
                .await?,
            )
            .await?
        } else {
            #[derive(serde::Deserialize)]
            struct SignedGet {
                url: String,
            }
            let signed_response = self
                .send(
                    self.api_request(
                        Method::GET,
                        &format!("/projects/{project_id}/blobs/{}", file.sha256),
                    )
                    .await?,
                )
                .await?;
            if signed_response.status() == StatusCode::GONE && file.kind == FileKind::Audio {
                return Ok(None);
            }
            if !signed_response.status().is_success() {
                return Err(self.error(signed_response).await);
            }
            let signed_bytes = bounded_response_bytes(signed_response, JSON_MAX_BYTES).await?;
            self.token.ensure_current()?;
            let signed: SignedGet = serde_json::from_slice(&signed_bytes)
                .map_err(|_| VaultError::InvalidResponse("invalid signed URL response".into()))?;
            // The signed URL includes the immutable object generation. Use it verbatim.
            let signed_url = self.signed_url(&signed.url)?;
            self.send(self.client.get(signed_url).timeout(TRANSFER_TIMEOUT))
                .await?
        };
        if response.status() == StatusCode::GONE && file.kind == FileKind::Audio {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(self.error(response).await);
        }
        Ok(Some(response))
    }

    async fn upload_reservation(
        &self,
        method: UploadMethod,
        url: &str,
        headers: &BTreeMap<String, String>,
        bytes: Vec<u8>,
    ) -> Result<()> {
        let signed_url = self.signed_url(url)?;
        validate_signed_headers(headers)?;
        if method == UploadMethod::Put {
            let mut request = self.client.put(signed_url.clone());
            for (key, value) in headers {
                request = request.header(key, value);
            }
            return match self
                .send(request.timeout(TRANSFER_TIMEOUT).body(bytes))
                .await
            {
                Ok(response) if response.status().is_success() => Ok(()),
                Ok(response) => Err(self.error(response).await),
                Err(error) => Err(error),
            };
        }

        let total = bytes.len() as u64;
        let mut offset = 0_u64;
        while offset < total {
            let end = offset
                .saturating_add(RESUMABLE_CHUNK_BYTES as u64)
                .min(total);
            let mut retries_without_progress = 0;
            loop {
                let mut request = self.client.put(signed_url.clone());
                for (key, value) in headers {
                    request = request.header(key, value);
                }
                request = request.header(
                    "Content-Range",
                    format!("bytes {offset}-{}/{}", end - 1, total),
                );
                match self
                    .send(request.body(bytes[offset as usize..end as usize].to_vec()))
                    .await
                {
                    Ok(response) if response.status().is_success() => return Ok(()),
                    Ok(response) if response.status().as_u16() == 308 => {
                        let next_offset = uploaded_offset(
                            response
                                .headers()
                                .get("range")
                                .and_then(|value| value.to_str().ok()),
                        );
                        if next_offset >= total {
                            return Ok(());
                        }
                        if next_offset > offset {
                            offset = next_offset;
                            break;
                        }
                    }
                    Ok(response) => return Err(self.error(response).await),
                    Err(_) => {
                        let status = self
                            .send(
                                self.client
                                    .put(signed_url.clone())
                                    .header("Content-Length", "0")
                                    .header("Content-Range", format!("bytes */{total}")),
                            )
                            .await;
                        if let Ok(response) = status {
                            if response.status().is_success() {
                                return Ok(());
                            }
                            if response.status().as_u16() == 308 {
                                let next_offset = uploaded_offset(
                                    response
                                        .headers()
                                        .get("range")
                                        .and_then(|value| value.to_str().ok()),
                                );
                                if next_offset >= total {
                                    return Ok(());
                                }
                                if next_offset > offset {
                                    offset = next_offset;
                                    break;
                                }
                            }
                        }
                    }
                }
                retries_without_progress += 1;
                if retries_without_progress >= 3 {
                    return Err(VaultError::Offline(
                        "resumable upload を再開できませんでした".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    async fn upload_reservation_file(
        &self,
        method: UploadMethod,
        url: &str,
        headers: &BTreeMap<String, String>,
        source: &mut File,
        total: u64,
    ) -> Result<()> {
        let signed_url = self.signed_url(url)?;
        validate_signed_headers(headers)?;
        if method == UploadMethod::Put {
            source.seek(SeekFrom::Start(0))?;
            let mut cloned = source.try_clone()?;
            cloned.seek(SeekFrom::Start(0))?;
            let async_file = tokio::fs::File::from_std(cloned);
            let mut request = self
                .client
                .put(signed_url.clone())
                .header("Content-Length", total)
                .timeout(TRANSFER_TIMEOUT)
                .body(async_file);
            for (key, value) in headers {
                request = request.header(key, value);
            }
            return match self.send(request).await {
                Ok(response) if response.status().is_success() => Ok(()),
                Ok(response) => Err(self.error(response).await),
                Err(error) => Err(error),
            };
        }

        let mut offset = 0_u64;
        while offset < total {
            let end = offset
                .saturating_add(RESUMABLE_CHUNK_BYTES as u64)
                .min(total);
            source.seek(SeekFrom::Start(offset))?;
            let chunk_len = usize::try_from(end - offset)
                .map_err(|_| VaultError::InvalidResponse("upload chunk too large".into()))?;
            let mut chunk = vec![0_u8; chunk_len];
            source.read_exact(&mut chunk)?;
            let mut retries_without_progress = 0;
            loop {
                let mut request = self.client.put(signed_url.clone());
                for (key, value) in headers {
                    request = request.header(key, value);
                }
                request = request.header(
                    "Content-Range",
                    format!("bytes {offset}-{}/{}", end - 1, total),
                );
                match self.send(request.body(chunk.clone())).await {
                    Ok(response) if response.status().is_success() => return Ok(()),
                    Ok(response) if response.status().as_u16() == 308 => {
                        let next_offset = uploaded_offset(
                            response
                                .headers()
                                .get("range")
                                .and_then(|value| value.to_str().ok()),
                        );
                        if next_offset >= total {
                            return Ok(());
                        }
                        if next_offset > offset {
                            offset = next_offset;
                            break;
                        }
                    }
                    Ok(response) => return Err(self.error(response).await),
                    Err(_) => {
                        let status = self
                            .send(
                                self.client
                                    .put(signed_url.clone())
                                    .header("Content-Length", "0")
                                    .header("Content-Range", format!("bytes */{total}")),
                            )
                            .await;
                        if let Ok(response) = status {
                            if response.status().is_success() {
                                return Ok(());
                            }
                            if response.status().as_u16() == 308 {
                                let next_offset = uploaded_offset(
                                    response
                                        .headers()
                                        .get("range")
                                        .and_then(|value| value.to_str().ok()),
                                );
                                if next_offset >= total {
                                    return Ok(());
                                }
                                if next_offset > offset {
                                    offset = next_offset;
                                    break;
                                }
                            }
                        }
                    }
                }
                retries_without_progress += 1;
                if retries_without_progress >= 3 {
                    return Err(VaultError::Offline(
                        "resumable upload を再開できませんでした".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    fn signed_url(&self, value: &str) -> Result<Url> {
        validate_signed_url(value, self.allow_local_signed_urls)
    }
}

fn uploaded_offset(range: Option<&str>) -> u64 {
    range
        .and_then(|value| value.rsplit('-').next())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|last| last.saturating_add(1))
        .unwrap_or(0)
}

#[async_trait]
impl VaultProvider for NihoProvider {
    fn check_context(&self) -> Result<()> {
        self.token.ensure_current()
    }

    async fn get_settings(&self, device_id: &str) -> Result<ProviderSettings> {
        let suffix = format!("/settings?deviceId={}", percent_encode(device_id));
        self.json(self.api_request(Method::GET, &suffix).await?)
            .await
    }

    async fn put_settings(
        &self,
        device_id: &str,
        provider: ProviderKind,
    ) -> Result<ProviderSettings> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            device_id: &'a str,
            provider: ProviderKind,
        }
        self.json(
            self.api_request(Method::PUT, "/settings")
                .await?
                .json(&Body {
                    device_id,
                    provider,
                }),
        )
        .await
    }

    async fn list_projects(&self, reserved: bool, deleted: bool) -> Result<Vec<ProjectSummary>> {
        // サーバーは literal の "1" だけを受け付ける。false は省く。
        let mut query = Vec::new();
        if reserved {
            query.push("reserved=1");
        }
        if deleted {
            query.push("deleted=1");
        }
        let suffix = if query.is_empty() {
            "/projects".to_owned()
        } else {
            format!("/projects?{}", query.join("&"))
        };
        let projects: Vec<ProjectSummary> = self
            .json(self.api_request(Method::GET, &suffix).await?)
            .await?;
        let mut ids = std::collections::BTreeSet::new();
        for project in &projects {
            validate_project_id(&project.project_id)?;
            if !ids.insert(&project.project_id) {
                return Err(VaultError::InvalidResponse(format!(
                    "duplicate projectId: {}",
                    project.project_id
                )));
            }
        }
        Ok(projects)
    }

    async fn get_or_create_project(
        &self,
        project_id: &str,
        name: Option<&str>,
    ) -> Result<Manifest> {
        validate_project_id(project_id)?;
        if project_id == DOCS_ROOT_PROJECT_ID {
            return Err(VaultError::InvalidPath(
                "docs-root requires the root endpoint".into(),
            ));
        }
        #[derive(Serialize)]
        struct Body<'a> {
            #[serde(skip_serializing_if = "Option::is_none")]
            name: Option<&'a str>,
        }
        self.manifest(
            project_id,
            self.api_request(Method::PUT, &format!("/projects/{project_id}"))
                .await?
                .json(&Body { name }),
        )
        .await
    }

    async fn get_project(&self, project_id: &str) -> Result<Manifest> {
        validate_project_id(project_id)?;
        if project_id == DOCS_ROOT_PROJECT_ID {
            return Err(VaultError::InvalidPath(
                "docs-root requires the root endpoint".into(),
            ));
        }
        self.manifest(
            project_id,
            self.api_request(Method::GET, &format!("/projects/{project_id}"))
                .await?,
        )
        .await
    }

    async fn get_or_create_root(&self) -> Result<Manifest> {
        self.manifest(
            DOCS_ROOT_PROJECT_ID,
            self.api_request(Method::PUT, "/root")
                .await?
                .json(&serde_json::json!({})),
        )
        .await
    }

    async fn get_root(&self) -> Result<Manifest> {
        self.manifest(
            DOCS_ROOT_PROJECT_ID,
            self.api_request(Method::GET, "/root").await?,
        )
        .await
    }

    async fn upload_blob(
        &self,
        project_id: &str,
        file: &ManifestFile,
        bytes: Vec<u8>,
    ) -> Result<()> {
        validate_project_id(project_id)?;
        validate_relative_path(&file.path)?;
        validate_project_path(project_id, &file.path)?;
        ensure_buffered_transfer_limit(
            file.bytes.max(bytes.len() as u64),
            "upload",
            "upload_blob_file",
        )?;
        verify_blob(file, &bytes)?;
        let inline = if bytes.len() <= INLINE_MAX_BYTES
            && matches!(file.kind, FileKind::Text | FileKind::Json)
        {
            std::str::from_utf8(&bytes).ok().map(str::to_owned)
        } else {
            None
        };
        match self.reserve_blob(project_id, file, inline).await? {
            BlobReservation::Exists | BlobReservation::Stored => Ok(()),
            BlobReservation::Upload {
                upload_id,
                method,
                url,
                headers,
                ..
            } => {
                self.upload_reservation(method, &url, &headers, bytes)
                    .await?;
                self.complete_upload(project_id, &file.sha256, &upload_id)
                    .await
            }
        }
    }

    async fn upload_blob_file(
        &self,
        project_id: &str,
        file: &ManifestFile,
        source: &mut File,
    ) -> Result<()> {
        validate_project_id(project_id)?;
        validate_relative_path(&file.path)?;
        validate_project_path(project_id, &file.path)?;
        verify_open_file(source, file)?;
        let inline = if file.bytes <= INLINE_MAX_BYTES as u64
            && matches!(file.kind, FileKind::Text | FileKind::Json)
        {
            let mut bytes = Vec::with_capacity(file.bytes as usize);
            source.read_to_end(&mut bytes)?;
            std::str::from_utf8(&bytes).ok().map(str::to_owned)
        } else {
            None
        };
        source.seek(SeekFrom::Start(0))?;
        match self.reserve_blob(project_id, file, inline).await? {
            BlobReservation::Exists | BlobReservation::Stored => Ok(()),
            BlobReservation::Upload {
                upload_id,
                method,
                url,
                headers,
                ..
            } => {
                self.upload_reservation_file(method, &url, &headers, source, file.bytes)
                    .await?;
                // Atomic editor saves keep this descriptor on the verified inode. Recheck before
                // making the uploaded object visible so an in-place mutation cannot be completed.
                verify_open_file(source, file)?;
                self.complete_upload(project_id, &file.sha256, &upload_id)
                    .await
            }
        }
    }

    async fn download_blob(
        &self,
        project_id: &str,
        file: &ManifestFile,
    ) -> Result<Option<Vec<u8>>> {
        validate_project_id(project_id)?;
        validate_relative_path(&file.path)?;
        validate_project_path(project_id, &file.path)?;
        ensure_buffered_transfer_limit(file.bytes, "download", "download_blob_file")?;
        let Some(mut response) = self.blob_response(project_id, file).await? else {
            return Ok(None);
        };
        let mut bytes = Vec::with_capacity(file.bytes as usize);
        while let Some(chunk) = response.chunk().await.map_err(invalid_http_response)? {
            let next_len = bytes
                .len()
                .checked_add(chunk.len())
                .ok_or_else(|| VaultError::InvalidResponse("blob byte count overflow".into()))?;
            if next_len as u64 > file.bytes || next_len as u64 > BUFFERED_TRANSFER_MAX_BYTES {
                return Err(VaultError::InvalidResponse("blob bytes mismatch".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        verify_blob(file, &bytes)?;
        self.token.ensure_current()?;
        Ok(Some(bytes))
    }

    async fn download_blob_file(
        &self,
        project_id: &str,
        file: &ManifestFile,
        destination: &mut File,
    ) -> Result<bool> {
        validate_project_id(project_id)?;
        validate_relative_path(&file.path)?;
        validate_project_path(project_id, &file.path)?;
        let Some(mut response) = self.blob_response(project_id, file).await? else {
            return Ok(false);
        };
        if response
            .content_length()
            .is_some_and(|content_length| content_length != file.bytes)
        {
            return Err(VaultError::InvalidResponse("blob bytes mismatch".into()));
        }
        destination.set_len(0)?;
        destination.seek(SeekFrom::Start(0))?;
        let mut bytes = 0_u64;
        let mut hasher = Sha256::new();
        while let Some(chunk) = response.chunk().await.map_err(invalid_http_response)? {
            bytes = bytes
                .checked_add(chunk.len() as u64)
                .ok_or_else(|| VaultError::InvalidResponse("blob byte count overflow".into()))?;
            if bytes > file.bytes {
                return Err(VaultError::InvalidResponse("blob bytes mismatch".into()));
            }
            hasher.update(&chunk);
            destination.write_all(&chunk)?;
        }
        if bytes != file.bytes {
            return Err(VaultError::InvalidResponse("blob bytes mismatch".into()));
        }
        if format!("{:x}", hasher.finalize()) != file.sha256 {
            return Err(VaultError::InvalidResponse("blob sha256 mismatch".into()));
        }
        destination.flush()?;
        destination.seek(SeekFrom::Start(0))?;
        self.token.ensure_current()?;
        Ok(true)
    }

    async fn commit(&self, project_id: &str, request: &CommitRequest) -> Result<CommitResponse> {
        let frozen_body = serde_json::to_vec(request)?;
        self.commit_raw(project_id, request, &frozen_body).await
    }

    async fn commit_raw(
        &self,
        project_id: &str,
        request: &CommitRequest,
        frozen_body: &[u8],
    ) -> Result<CommitResponse> {
        validate_frozen_commit_body(request, frozen_body)?;
        validate_commit_request(project_id, request)?;
        self.json(
            self.api_request(Method::POST, &format!("/projects/{project_id}/commit"))
                .await?
                .header("Content-Type", "application/json")
                .body(frozen_body.to_vec()),
        )
        .await
    }

    async fn delete_project(&self, project_id: &str) -> Result<()> {
        validate_project_id(project_id)?;
        self.empty(
            self.api_request(Method::DELETE, &format!("/projects/{project_id}"))
                .await?,
        )
        .await
    }

    async fn restore_project(&self, project_id: &str) -> Result<()> {
        validate_project_id(project_id)?;
        self.empty(
            self.api_request(Method::POST, &format!("/projects/{project_id}/restore"))
                .await?,
        )
        .await
    }

    async fn acquire_lease(
        &self,
        project_id: &str,
        device_id: &str,
        device_name: &str,
        lease_id: Option<&str>,
    ) -> Result<Lease> {
        validate_project_id(project_id)?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            device_id: &'a str,
            device_name: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            lease_id: Option<&'a str>,
        }
        self.json(
            self.api_request(Method::POST, &format!("/projects/{project_id}/lease"))
                .await?
                .json(&Body {
                    device_id,
                    device_name,
                    lease_id,
                }),
        )
        .await
    }

    async fn renew_lease(&self, project_id: &str, lease_id: &str) -> Result<Lease> {
        validate_project_id(project_id)?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            lease_id: &'a str,
        }
        self.json(
            self.api_request(Method::POST, &format!("/projects/{project_id}/lease/renew"))
                .await?
                .json(&Body { lease_id }),
        )
        .await
    }

    async fn release_lease(&self, project_id: &str, lease_id: &str) -> Result<()> {
        validate_project_id(project_id)?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Body<'a> {
            lease_id: &'a str,
        }
        self.empty(
            self.api_request(Method::DELETE, &format!("/projects/{project_id}/lease"))
                .await?
                .json(&Body { lease_id }),
        )
        .await
    }

    async fn usage(&self) -> Result<Usage> {
        self.json(self.api_request(Method::GET, "/usage").await?)
            .await
    }
}

fn validate_frozen_commit_body(request: &CommitRequest, frozen_body: &[u8]) -> Result<()> {
    let parsed: CommitRequest = serde_json::from_slice(frozen_body)
        .map_err(|_| VaultError::InvalidResponse("invalid frozen commit body".into()))?;
    if &parsed != request {
        return Err(VaultError::InvalidResponse(
            "typed commit request does not match frozen body".into(),
        ));
    }
    Ok(())
}

fn validate_commit_request(project_id: &str, request: &CommitRequest) -> Result<()> {
    validate_project_id(project_id)?;
    if request.mutation_id.len() != 22
        || !request
            .mutation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(VaultError::InvalidPath("invalid mutationId".into()));
    }
    for upsert in &request.upserts {
        validate_relative_path(&upsert.path)?;
        validate_project_path(project_id, &upsert.path)?;
    }
    for path in &request.deletes {
        validate_relative_path(path)?;
        validate_project_path(project_id, path)?;
    }
    Ok(())
}

async fn api_error(response: reqwest::Response) -> VaultError {
    let status = response.status().as_u16();
    let value = match bounded_response_bytes(response, ERROR_MAX_BYTES).await {
        Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_default(),
        Err(_) => serde_json::Value::Null,
    };
    let error = value.get("error").unwrap_or(&value);
    let code = error
        .get("code")
        .and_then(|value| value.as_str())
        .and_then(safe_error_code)
        .unwrap_or_else(|| "UNKNOWN".to_owned());
    let mut message = error
        .get("message")
        .and_then(|value| value.as_str())
        .unwrap_or("API request failed")
        .chars()
        .take(512)
        .collect::<String>();
    if contains_secret_material(&message) {
        message = "API request failed".into();
    }
    if status >= 500 {
        return VaultError::Offline(format!("API {status} {code}"));
    }
    // 停止スイッチ（#18892・spec D-18）: APP_CONNECT_ENABLED が OFF の間、API の認証が接続つき token を 401 にする。接続は失効して
    // いない一時停止なので、再ログインを求めず通信できないときと同じに扱い（手元は書き続け、開け直すと次の同期で戻る）。
    if status == 401
        && error
            .get("details")
            .and_then(|details| details.get("reason"))
            .and_then(|reason| reason.as_str())
            == Some("app_connect_disabled")
    {
        return VaultError::Offline(format!("API {status} app_connect_disabled"));
    }
    match (status, code.as_str()) {
        (401, _) => VaultError::AuthRequired,
        (403, _) => VaultError::Forbidden,
        (429, _) => VaultError::RateLimited,
        (409, "DOCS_VAULT_MUTATION_MISMATCH") => VaultError::MutationMismatch,
        (409, "DOCS_VAULT_IMMUTABLE_VERSION") => VaultError::ImmutableVersion {
            path: error
                .get("details")
                .and_then(|details| details.get("path"))
                .and_then(|path| path.as_str())
                .filter(|path| {
                    validate_relative_path(path).is_ok() && !contains_secret_material(path)
                })
                .unwrap_or_default()
                .to_owned(),
        },
        (409, "DOCS_VAULT_PROJECT_GC_IN_PROGRESS") => VaultError::ProjectBusy,
        (400, "DOCS_VAULT_BLOB_MISSING") => VaultError::BlobMissing,
        (410, "DOCS_VAULT_PROJECT_PURGED") => VaultError::ProjectPurged,
        (409, "DOCS_VAULT_REVISION_CONFLICT") => VaultError::RevisionConflict,
        (409, "DOCS_VAULT_PROJECT_DELETED") => VaultError::ProjectDeleted,
        (409, "DOCS_VAULT_LEASE_HELD") => VaultError::LeaseHeld {
            held_by: error
                .get("details")
                .and_then(|details| details.get("heldBy"))
                .and_then(|held_by| serde_json::from_value(held_by.clone()).ok()),
        },
        (413, "DOCS_VAULT_QUOTA_EXCEEDED") => VaultError::QuotaExceeded {
            path: String::new(),
        },
        (413, "DOCS_VAULT_BLOB_TOO_LARGE") => VaultError::BlobTooLarge(String::new()),
        _ => VaultError::Api {
            status,
            code,
            message,
        },
    }
}

async fn bounded_response_bytes(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(VaultError::InvalidResponse(
            "HTTP response exceeded size limit".into(),
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(invalid_http_response)? {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(VaultError::InvalidResponse(
                "HTTP response exceeded size limit".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn safe_error_code(value: &str) -> Option<String> {
    (value.len() <= 64
        && !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'))
    .then(|| value.to_owned())
}

fn contains_secret_material(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("http://")
        || lower.contains("https://")
        || lower.contains("bearer ")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains("authorization")
        || lower.contains("?x-goog-")
        || value.split('.').filter(|part| part.len() >= 16).count() >= 3
}

fn normalize_api_base(value: &str, test_fixture: bool) -> Result<Url> {
    if value.contains('%') {
        return Err(VaultError::InvalidPath("invalid API origin".into()));
    }
    let mut url =
        Url::parse(value).map_err(|_| VaultError::InvalidPath("invalid API origin".into()))?;
    let credentials = !url.username().is_empty() || url.password().is_some();
    if credentials || url.query().is_some() || url.fragment().is_some() {
        return Err(VaultError::InvalidPath("invalid API origin".into()));
    }
    let valid_path = matches!(url.path(), "" | "/" | "/api" | "/api/");
    if !valid_path || value.contains("..") {
        return Err(VaultError::InvalidPath("invalid API origin".into()));
    }
    if test_fixture {
        let local = url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if url.scheme() != "http" || !local {
            return Err(VaultError::InvalidPath(
                "test API must be loopback HTTP".into(),
            ));
        }
    } else if !matches!(
        (url.scheme(), url.host_str(), url.port()),
        ("https", Some("niho.life"), None) | ("https", Some("app-stg.niho.life"), None)
    ) {
        return Err(VaultError::InvalidPath("untrusted API origin".into()));
    }
    url.set_path("/api/");
    Ok(url)
}

fn validate_signed_url(value: &str, allow_local: bool) -> Result<Url> {
    let url =
        Url::parse(value).map_err(|_| VaultError::InvalidResponse("invalid signed URL".into()))?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(VaultError::InvalidResponse("invalid signed URL".into()));
    }
    let host = url.host_str().unwrap_or_default();
    let gcs = url.scheme() == "https"
        && (host == "storage.googleapis.com" || host.ends_with(".storage.googleapis.com"));
    let local = allow_local
        && url.scheme() == "http"
        && (host == "localhost"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback()));
    if !gcs && !local {
        return Err(VaultError::InvalidResponse(
            "untrusted signed URL host".into(),
        ));
    }
    Ok(url)
}

fn validate_signed_headers(headers: &BTreeMap<String, String>) -> Result<()> {
    if headers.keys().any(|key| {
        matches!(
            key.to_ascii_lowercase().as_str(),
            "authorization" | "cookie" | "host" | "proxy-authorization"
        )
    }) {
        return Err(VaultError::InvalidResponse(
            "unsafe signed URL header".into(),
        ));
    }
    Ok(())
}

/// query の値の percent-encoding（RFC 3986 の unreserved 以外）。
fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn offline_error(error: reqwest::Error) -> VaultError {
    VaultError::Offline(error.without_url().to_string())
}

fn invalid_http_response(error: reqwest::Error) -> VaultError {
    VaultError::InvalidResponse(error.without_url().to_string())
}

fn verify_blob(file: &ManifestFile, bytes: &[u8]) -> Result<()> {
    if bytes.len() as u64 != file.bytes {
        return Err(VaultError::InvalidResponse(format!(
            "blob bytes mismatch: {}",
            file.path
        )));
    }
    let actual = format!("{:x}", Sha256::digest(bytes));
    if actual != file.sha256 {
        return Err(VaultError::InvalidResponse(format!(
            "blob sha256 mismatch: {}",
            file.path
        )));
    }
    Ok(())
}

fn validate_manifest(project_id: &str, mut manifest: Manifest) -> Result<Manifest> {
    if manifest.schema_version != 1 {
        return Err(VaultError::InvalidResponse(
            "unsupported manifest schemaVersion".into(),
        ));
    }
    if manifest.deleted && manifest.project_id.is_empty() {
        manifest.project_id = project_id.to_owned();
    }
    if manifest.project_id != project_id {
        return Err(VaultError::InvalidResponse(
            "manifest projectId mismatch".into(),
        ));
    }
    if manifest.files.len() > crate::scanner::FILE_MAX_COUNT {
        return Err(VaultError::InvalidResponse(
            "manifest file count exceeds limit".into(),
        ));
    }
    let scope = match project_id {
        DOCS_ROOT_PROJECT_ID => SyncScope::Root,
        PROFILE_PROJECT_ID => SyncScope::Profile,
        _ => SyncScope::All,
    };
    let mut paths = std::collections::BTreeSet::new();
    for file in &manifest.files {
        validate_relative_path(&file.path)?;
        if !scope.contains(&file.path) {
            return Err(VaultError::InvalidResponse(
                "manifest path is outside target scope".into(),
            ));
        }
        if crate::scanner::is_server_ignored(&file.path)
            || crate::scanner::is_private_path(&file.path)
        {
            return Err(VaultError::InvalidResponse(format!(
                "manifest includes a sync-ignored path: {}",
                file.path
            )));
        }
        if !paths.insert(&file.path) {
            return Err(VaultError::InvalidResponse(format!(
                "duplicate manifest path: {}",
                file.path
            )));
        }
        let max_bytes = if file.kind == FileKind::Audio {
            crate::scanner::AUDIO_BLOB_MAX_BYTES
        } else {
            crate::scanner::BLOB_MAX_BYTES
        };
        // 非音声は 0 byte を許す。音声は 1 byte 以上。
        if (file.bytes == 0 && file.kind == FileKind::Audio) || file.bytes > max_bytes {
            return Err(VaultError::InvalidResponse(format!(
                "invalid manifest bytes: {}",
                file.path
            )));
        }
        if file.sha256.len() != 64 || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(VaultError::InvalidResponse(format!(
                "invalid manifest sha256: {}",
                file.path
            )));
        }
        if FileKind::from_path(&file.path) != file.kind {
            return Err(VaultError::InvalidResponse(format!(
                "manifest kind mismatch: {}",
                file.path
            )));
        }
        if chrono::DateTime::parse_from_rfc3339(&file.modified_at).is_err()
            || file.writer_device_id.is_empty()
        {
            return Err(VaultError::InvalidResponse(format!(
                "invalid manifest metadata: {}",
                file.path
            )));
        }
        if !file.available && file.kind != FileKind::Audio {
            return Err(VaultError::InvalidResponse(format!(
                "available=false on non-audio: {}",
                file.path
            )));
        }
    }
    if let Some((left, right)) = crate::scanner::find_case_folded_path_collision(
        manifest.files.iter().map(|file| file.path.as_str()),
    ) {
        return Err(VaultError::InvalidResponse(format!(
            "manifest case-folded path collision: {left} / {right}"
        )));
    }
    Ok(manifest)
}

fn validate_project_path(project_id: &str, path: &str) -> Result<()> {
    let allowed = match project_id {
        DOCS_ROOT_PROJECT_ID => SyncScope::Root.contains(path),
        PROFILE_PROJECT_ID => SyncScope::Profile.contains(path),
        _ => true,
    };
    if !allowed || crate::scanner::is_server_ignored(path) || crate::scanner::is_private_path(path)
    {
        return Err(VaultError::InvalidPath(
            "path is outside the project scope".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str) -> ManifestFile {
        ManifestFile {
            path: path.into(),
            sha256: "a".repeat(64),
            bytes: 1,
            kind: FileKind::from_path(path),
            modified_at: "2026-10-16T00:00:00Z".into(),
            writer_device_id: "device".into(),
            writer_device_kind: None,
            retained_until: None,
            available: true,
        }
    }

    #[test]
    fn remote_manifest_rejects_mismatch_duplicates_and_invalid_hashes() {
        let mut manifest = Manifest::empty("other");
        assert!(validate_manifest("p123", manifest.clone()).is_err());
        manifest.project_id = "p123".into();
        manifest.files = vec![file("page.md"), file("page.md")];
        assert!(validate_manifest("p123", manifest.clone()).is_err());
        manifest.files.truncate(1);
        manifest.files[0].sha256 = "bad".into();
        assert!(validate_manifest("p123", manifest).is_err());
    }

    #[test]
    fn remote_manifest_rejects_sync_ignored_and_case_conflicting_paths() {
        for ignored in [".run.lock", ".conflicts/page.md", ".DS_Store", "draft.tmp"] {
            let mut manifest = Manifest::empty("p123");
            manifest.files.push(file(ignored));
            assert!(validate_manifest("p123", manifest).is_err(), "{ignored}");
        }

        for paths in [
            ["Page.md", "page.md"],
            ["Folder/a.md", "folder/b.md"],
            ["page.md", "page.md/child.md"],
        ] {
            let mut manifest = Manifest::empty("p123");
            manifest.files = paths.into_iter().map(file).collect();
            assert!(validate_manifest("p123", manifest).is_err(), "{paths:?}");
        }
    }

    #[test]
    fn tombstone_without_project_id_is_completed_by_the_requested_id() {
        let mut manifest = Manifest::empty("");
        manifest.deleted = true;
        let manifest = validate_manifest("p123", manifest).unwrap();
        assert_eq!(manifest.project_id, "p123");
    }

    #[test]
    fn empty_documents_are_valid_but_empty_audio_and_private_paths_are_not() {
        let mut manifest = Manifest::empty("p123");
        let mut empty = file("empty.md");
        empty.bytes = 0;
        manifest.files = vec![empty];
        assert!(validate_manifest("p123", manifest).is_ok());
        let mut manifest = Manifest::empty("p123");
        let mut audio = file("silence.m4a");
        audio.bytes = 0;
        manifest.files = vec![audio];
        assert!(validate_manifest("p123", manifest).is_err());
        let mut manifest = Manifest::empty("p123");
        manifest.files = vec![file("codex-home/a.md")];
        assert!(validate_manifest("p123", manifest).is_err());
    }

    #[test]
    fn reserved_manifests_reject_paths_outside_their_wire_scope() {
        let mut root = Manifest::empty(DOCS_ROOT_PROJECT_ID);
        root.files = vec![file("pages/p1.md"), file("recordings/r1/runs.jsonl")];
        assert!(validate_manifest(DOCS_ROOT_PROJECT_ID, root.clone()).is_ok());
        root.files.push(file("flows/f1.json"));
        assert!(validate_manifest(DOCS_ROOT_PROJECT_ID, root).is_err());

        let mut profile = Manifest::empty(PROFILE_PROJECT_ID);
        profile.files = vec![file("about.json"), file("execution.json")];
        assert!(validate_manifest(PROFILE_PROJECT_ID, profile.clone()).is_ok());
        profile.files.push(file("pages/p1.md"));
        assert!(validate_manifest(PROFILE_PROJECT_ID, profile).is_err());
    }

    #[test]
    fn signed_urls_accept_only_gcs_or_explicit_loopback_fixtures() {
        assert!(validate_signed_url(
            "https://storage.googleapis.com/bucket/object?X-Goog-Signature=abc",
            false
        )
        .is_ok());
        assert!(validate_signed_url("https://bucket.storage.googleapis.com/object", false).is_ok());
        assert!(validate_signed_url("https://evil.example/object?token=secret", false).is_err());
        assert!(validate_signed_url("http://127.0.0.1:4312/upload", false).is_err());
        assert!(validate_signed_url("http://127.0.0.1:4312/upload", true).is_ok());
    }

    #[test]
    fn constructors_fix_production_origins_and_normalize_test_api_once() {
        let token: Arc<dyn IdTokenProvider> =
            Arc::new(|| async { Ok("t".to_owned()) as Result<String> });
        let with_api = NihoProvider::new(NihoEnvironment::Production, token.clone()).unwrap();
        assert_eq!(
            with_api.endpoint("/usage"),
            "https://niho.life/api/me/docs-vault/usage"
        );
        let origin = NihoProvider::new_for_test("http://127.0.0.1:9", token.clone()).unwrap();
        assert_eq!(
            origin.endpoint("/usage"),
            "http://127.0.0.1:9/api/me/docs-vault/usage"
        );
        assert_eq!(percent_encode("d_a+b/c"), "d_a%2Bb%2Fc");
        for rejected in [
            "https://evil.example/api",
            "http://user:pass@127.0.0.1:9",
            "http://127.0.0.1:9/api?token=secret",
            "http://127.0.0.1:9/api#fragment",
            "http://127.0.0.1:9/%2e%2e/api",
            "http://127.0.0.1:9/api/../private",
        ] {
            assert!(
                NihoProvider::new_for_test(rejected, token.clone()).is_err(),
                "{rejected}"
            );
        }
        assert!(normalize_api_base("https://evil.example/api", false).is_err());
        assert!(normalize_api_base("https://niho.life/%2e%2e/api", false).is_err());
    }

    #[test]
    fn manifest_limits_are_kind_specific_and_offsets_are_u64() {
        let mut manifest = Manifest::empty("p123");
        let mut audio = file("recording.aifc");
        audio.bytes = crate::scanner::AUDIO_BLOB_MAX_BYTES;
        manifest.files = vec![audio.clone()];
        assert!(validate_manifest("p123", manifest.clone()).is_ok());
        manifest.files[0].bytes += 1;
        assert!(validate_manifest("p123", manifest).is_err());

        let mut manifest = Manifest::empty("p123");
        let mut other = file("archive.bin");
        other.bytes = crate::scanner::BLOB_MAX_BYTES;
        manifest.files = vec![other];
        assert!(validate_manifest("p123", manifest.clone()).is_ok());
        manifest.files[0].bytes += 1;
        assert!(validate_manifest("p123", manifest).is_err());

        assert_eq!(
            uploaded_offset(Some("bytes=0-2147483648")),
            2_147_483_649_u64
        );
    }

    #[test]
    fn buffered_provider_apis_reject_more_than_eight_mib_before_allocation_or_network() {
        assert!(ensure_buffered_transfer_limit(
            BUFFERED_TRANSFER_MAX_BYTES,
            "upload",
            "upload_blob_file"
        )
        .is_ok());

        let temp = tempfile::tempdir().unwrap();
        let mut source = File::create(temp.path().join("source")).unwrap();
        let mut destination = File::create(temp.path().join("destination")).unwrap();
        let mut oversized = file("recording.aifc");
        oversized.bytes = BUFFERED_TRANSFER_MAX_BYTES + 1;
        let local = LocalProvider;
        let niho = NihoProvider::new_for_test(
            "http://127.0.0.1:1",
            Arc::new(|| async { Ok("token".to_owned()) as Result<String> }),
        )
        .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            let upload_fallback = local
                .upload_blob_file("p123", &oversized, &mut source)
                .await
                .unwrap_err();
            assert!(upload_fallback.to_string().contains("8 MiB"));
            assert!(upload_fallback.to_string().contains("upload_blob_file"));

            let download_fallback = local
                .download_blob_file("p123", &oversized, &mut destination)
                .await
                .unwrap_err();
            assert!(download_fallback.to_string().contains("8 MiB"));
            assert!(download_fallback.to_string().contains("download_blob_file"));

            let direct_upload = niho
                .upload_blob("p123", &oversized, Vec::new())
                .await
                .unwrap_err();
            assert!(direct_upload.to_string().contains("upload_blob_file"));

            let direct_download = niho.download_blob("p123", &oversized).await.unwrap_err();
            assert!(direct_download.to_string().contains("download_blob_file"));
        });
    }
}
