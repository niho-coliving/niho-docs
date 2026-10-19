import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MAC_DOCS_CAPABILITIES, type Bridge, type RecordingRef, type ProjectId, type SpeechStatus } from "niho-docs-ui/host/DocsHost";
import type { CloudState, CloudProjectEvent, CloudAppliedEvent, CloudRemoteEvent, ReopeningPreview } from "./cloud-types";
import type { UpdateStatus, RecordingEvent } from "niho-docs-ui/host/DocsHost";
import type { PcRunnerStatus } from "./pc-runner";
import { PC_RUNNER_STATE_EVENT } from "./pc-runner";
import { rememberSpeechSupport } from "./settings";
import { importSampleUrl } from "./sample-url";
export * from "niho-docs-ui/host/DocsHost";

/** operation を渡したときだけ command の引数に足す（今までの呼び出しの形は変えない）。 */
function withOperation(operation: string | null | undefined): { operation?: string } {
  return operation ? { operation } : {};
}

/** 録音単位の command の引数（Rust の project_id・recording_id）。 */
function ids(rec: RecordingRef): { projectId: ProjectId; recordingId: string } {
  return { projectId: rec.projectId, recordingId: rec.recordingId };
}

function channel<T>(handler: (value: T) => void): Channel<T> {
  const created = new Channel<T>();
  created.onmessage = handler;
  return created;
}

export const tauriBridge: Bridge = {
  capabilities: MAC_DOCS_CAPABILITIES,
  audioSourceUrl: (path) => convertFileSrc(path),
  explicitMediaLoad: true,
  importSampleUrl: (flowId, url) => importSampleUrl(tauriBridge, flowId, url),
  appPaths: () => invoke("app_paths"),
  loadSettings: () => invoke("load_settings"),
  saveSettings: (settings) => invoke("save_settings", { settings }),
  listFlows: () => invoke("list_flows"),
  saveFlow: (flow) => invoke("save_flow", { flow }),
  duplicateFlow: (sourceId, flow) => invoke("duplicate_flow", { sourceId, flow }),
  deleteFlow: (flowId) => invoke("delete_flow", { flowId }),
  setLastUsedFlow: (flowId) => invoke("set_last_used_flow", { flowId }),
  flowUsage: (flowId) => invoke("flow_usage", { flowId }),
  loadAbout: () => invoke("load_about"),
  saveAbout: (about) => invoke("save_about", { about: { version: 1, ...about } }),
  loadExecution: () => invoke("load_execution"),
  saveExecution: (execution) => invoke("save_execution", { execution }),
  pickSampleFiles: () => invoke("pick_sample_files"),
  importSamples: (flowId, paths) => invoke("import_samples", { flowId, paths }),
  fetchSampleUrl: (url, sameOriginRedirectOnly, timeoutMs) => invoke("fetch_sample_url", { url, sameOriginRedirectOnly, timeoutMs }),
  saveSampleUrl: (flowId, url, name, text) => invoke("save_sample_url", { flowId, url, name, text }),
  readSample: (flowId, sampleId) => invoke("read_sample", { flowId, sampleId }),
  pruneSamples: (flowId, keep) => invoke("prune_samples", { flowId, keep }),
  listProjects: () => invoke("list_projects"),
  saveProjectOrder: (order) => invoke("save_project_order", { order }),
  reorderProject: (projectId, beforeProjectId) => invoke("reorder_project", { projectId, beforeProjectId }),
  deleteEmptyFolder: (projectId) => invoke("delete_empty_folder", { projectId }),
  loadRecent: () => invoke("load_recent"),
  touchRecent: (item) => invoke("touch_recent", { item }),
  createProject: (project, text, textRecord, audio, names = []) => invoke("create_project", { project, text, textRecord, audio, names }),
  importAudio: (rec, paths, keep, names = []) => invoke("import_audio", { ...ids(rec), paths, names, keep }),
  loadProject: (projectId) => invoke("load_project", { projectId }),
  loadPages: (projectId) => invoke("load_pages", { projectId }),
  saveProject: (projectId, project) => invoke("save_project", { projectId, project }),
  loadRecording: (rec) => invoke("load_recording", ids(rec)),
  saveRecording: (rec, recording) => invoke("save_recording", { ...ids(rec), recording }),
  createCandidate: (rec, stepId, candidateSet, newArtifactId, duplicateMarkdown, record) =>
    invoke("create_candidate", { ...ids(rec), stepId, candidateSet, newArtifactId, duplicateMarkdown, record }),
  renameCandidate: (rec, stepId, candidateId, name) => invoke("rename_candidate", { ...ids(rec), stepId, candidateId, name }),
  setSourceCandidate: (rec, candidateId, expected) => invoke("set_source_candidate", { ...ids(rec), candidateId, expected }),
  setRecordingText: (rec, text, record) => invoke("set_recording_text", { ...ids(rec), text, record }),
  createPage: (projectId, page) =>
    invoke("create_page", { projectId, kind: page.kind, title: page.title, createdAt: page.createdAt, recording: page.recording ?? null, afterPageId: page.afterPageId ?? null }),
  renamePage: (projectId, pageId, title) => invoke("rename_page", { projectId, pageId, title }),
  deletePage: (projectId, pageId) => invoke("delete_page", { projectId, pageId }),
  movePage: (sourceProjectId, pageId, targetProjectId, beforePageId) =>
    invoke("move_page", { sourceProjectId, pageId, targetProjectId, beforePageId: beforePageId ?? null }),
  readPage: (projectId, pageId) => invoke("read_page", { projectId, pageId }),
  writePage: (projectId, pageId, markdown) => invoke("write_page", { projectId, pageId, markdown }),
  openPageDocument: (projectId, pageId) => invoke("open_page_document", { projectId, pageId }),
  openArtifactDocument: (rec, stepId, source) => invoke("open_artifact_document", { ...ids(rec), stepId, source }),
  saveOpenedDocument: (handle, markdown) => invoke("save_opened_document", { handle, markdown }),
  saveOpenedArtifact: (handle, markdown, record) => invoke("save_opened_artifact", { handle, markdown, record }),
  releaseOpenedDocument: (handle) => invoke("release_opened_document", { handle }),
  pickImageAsset: (projectId) => invoke("pick_image_asset", { projectId }),
  readImageAsset: (projectId, name) => invoke("read_image_asset", { projectId, name }),
  saveArtifact: (rec, stepId, source, markdown, record) => invoke("save_artifact", { ...ids(rec), stepId, source, markdown, record }),
  appendRun: (rec, record) => invoke("append_run", { ...ids(rec), record }),
  readVersion: (rec, stepId, version, versionPath) =>
    invoke("read_version", { ...ids(rec), stepId, version, versionPath: versionPath ?? null }),
  saveCheckpoint: (rec, runId, checkpoint) => invoke("save_checkpoint", { ...ids(rec), runId, checkpoint }),
  readCheckpoint: (rec, runId) => invoke("read_checkpoint", { ...ids(rec), runId }),
  acquireRunLock: (projectId) => invoke("acquire_run_lock", { projectId }),
  releaseRunLock: (projectId) => invoke("release_run_lock", { projectId }),
  listAllRuns: () => invoke("list_all_runs"),
  runTurn: (turnId, request, onEvent, operation) => invoke("run_turn", { turnId, request, ...withOperation(operation), onEvent: channel(onEvent) }),
  stopTurn: (turnId) => invoke("stop_turn", { turnId }),
  providerStatus: (provider) => invoke("provider_status", { provider }),
  startAuth: (provider) => invoke("start_auth", { provider }),
  installClaude: () => invoke("install_claude"),
  updateClaude: () => invoke("update_claude"),
  // 確かめるたびに、この Mac で動かない文字起こしを覚える（settings の effectiveEngine が既定にしない）
  speechStatus: (language) =>
    invoke<SpeechStatus>("speech_status", { language }).then((status) => {
      rememberSpeechSupport(status.unsupported ?? null);
      return status;
    }),
  speechDownload: (jobId, language, onEvent) => invoke("speech_download", { jobId, language, onEvent: channel(onEvent) }),
  transcribe: (jobId, rec, language, speakerMode, hints, onEvent, operation) =>
    invoke("transcribe", { jobId, ...ids(rec), language, speakerMode, hints, ...withOperation(operation), onEvent: channel(onEvent) }),
  stopTranscribe: (jobId) => invoke("stop_transcribe", { jobId }),
  prepareAudio: (jobId, rec, onEvent, operation) =>
    invoke("prepare_audio", { jobId, ...ids(rec), ...withOperation(operation), onEvent: channel(onEvent) }),
  transcribeAudioPart: (turnId, jobId, file, part, request, onEvent, operation) =>
    invoke("transcribe_audio_part", { turnId, jobId, file, part, request, ...withOperation(operation), onEvent: channel(onEvent) }),
  releaseAudio: (jobId) => invoke("release_audio", { jobId }),
  providerUsage: (provider) => invoke("provider_usage", { provider }),
  transcribeDeepgram: (jobId, rec, request, onEvent, operation) =>
    invoke("transcribe_deepgram", { jobId, ...ids(rec), request, ...withOperation(operation), onEvent: channel(onEvent) }),
  apiKeyStatus: (account) => invoke("api_key_status", { account }),
  saveApiKey: (account, key) => invoke("save_api_key", { account, key }),
  checkApiKey: (account) => invoke("check_api_key", { account }),
  deleteApiKey: (account) => invoke("delete_api_key", { account }),
  audioInfo: (paths) => invoke("audio_info", { paths }),
  audioFilePaths: (rec) => invoke("audio_file_paths", ids(rec)),
  pickAudioFiles: () => invoke("pick_audio_files"),
  micStatus: (request) => invoke("mic_status", { request }),
  startRecording: (recordingId, onEvent) => invoke("start_recording", { recordingId, onEvent: channel(onEvent) }),
  stopRecording: (recordingId) => invoke("stop_recording", { recordingId }),
  discardRecording: (recordingId) => invoke("discard_recording", { recordingId }),
  leftoverRecordings: () => invoke("leftover_recordings"),
  openMicrophoneSettings: () => invoke("open_microphone_settings"),
  onRecordingCloseRequested: (handler) => listen("recording-close-requested", () => handler()),
  closeAfterRecording: () => invoke("close_after_recording"),
  pickDocsRoot: () => invoke("pick_docs_root"),
  saveMarkdownAs: (fileName, markdown) => invoke("save_markdown_as", { fileName, markdown }),
  revealRoot: () => invoke("reveal_root"),
  revealArtifact: (rec, stepId, source) => invoke("reveal_artifact", { ...ids(rec), stepId, source }),
  revealPage: (projectId, pageId) => invoke("reveal_page", { projectId, pageId }),
  copyText: (text) => invoke("copy_text", { text }),
  runChatTurn: (turnId, rec, conversationId, request, onEvent) =>
    invoke("run_chat_turn", { turnId, ...ids(rec), conversationId, request, onEvent: channel(onEvent) }),
  artifactStates: (rec) => invoke("artifact_states", ids(rec)),
  readArtifact: (rec, stepId) => invoke("read_artifact", { ...ids(rec), stepId }),
  revertArtifact: (rec, stepId) => invoke("revert_artifact", { ...ids(rec), stepId }),
  listConversations: (rec) => invoke("list_conversations", ids(rec)),
  saveConversation: (rec, conversation) =>
    invoke("save_conversation", { ...ids(rec), conversationId: conversation.id, conversation }),
  onFileDrop: async (handler, onHover) => {
    const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        onHover?.(false);
        handler(event.payload.paths);
      } else if (event.payload.type === "enter" || event.payload.type === "over") {
        onHover?.(true);
      } else {
        onHover?.(false);
      }
    });
    return unlisten;
  },
  onCloseRequested: (handler) =>
    getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await handler())) event.preventDefault();
    }),
  watchUpdate: async (handler) => {
    // 先に購読してから今の状態を読む（読むまでのあいだに差し替わっても取りこぼさない）
    const unlisten = await listen<UpdateStatus>("update-staged", (event) => handler(event.payload));
    handler(await invoke<UpdateStatus>("update_status"));
    return unlisten;
  },
  restartToUpdate: (force) => invoke("restart_to_update", { force }),
  cloudState: () => invoke("cloud_state"),
  cloudStorageSelect: (mode) => invoke<CloudState>("cloud_storage_select", { mode }),
  cloudStorageReopeningPreview: () => invoke<ReopeningPreview>("cloud_storage_reopening_preview"),
  cloudStorageReopen: () => invoke<CloudState>("cloud_storage_reopen"),
  cloudSetProvider: (provider, rebind) => invoke("cloud_set_provider", { provider, rebind: rebind ?? null }),
  cloudSetDeviceName: (name) => invoke("cloud_set_device_name", { name }),
  cloudProjectStatus: (projectId) => invoke("cloud_project_status", { projectId }),
  cloudPageShareGet: (pageId, projectId, textId) => invoke("cloud_page_share_get", { pageId, projectId, textId: textId ?? null }),
  cloudPageShareSet: (pageId, projectId, textId, published) => invoke("cloud_page_share_set", { pageId, projectId, textId, published }),
  cloudPageShareRotate: (pageId, projectId, textId, expectedPublicId) => invoke("cloud_page_share_rotate", { pageId, projectId, textId, expectedPublicId }),
  cloudPageShareOpen: (url) => invoke("cloud_page_share_open", { url }),
  cloudRemoteProjects: () => invoke("cloud_remote_projects"),
  cloudDeletedProjects: () => invoke("cloud_deleted_projects"),
  cloudOpenProject: (projectId) => invoke("cloud_open_project", { projectId }),
  cloudRestoreProject: (projectId) => invoke("cloud_restore_project", { projectId }),
  cloudTombstoneChoice: (projectId, choice) => invoke("cloud_tombstone_choice", { projectId, choice }),
  cloudSyncNow: (projectId) => invoke("cloud_sync_now", { projectId }),
  cloudFocus: (projectId) => invoke("cloud_focus", { projectId }),
  cloudProtect: (projectId, paths) => invoke("cloud_protect", { projectId, paths }),
  cloudRelease: (id) => invoke("cloud_release", { id }),
  cloudConflicts: (projectId) => invoke("cloud_conflicts", { projectId }),
  cloudConflictCopy: (projectId, conflictId, side) => invoke("cloud_conflict_copy", { projectId, conflictId, side }),
  cloudResolveConflict: (projectId, conflictId, choice, text, remoteSha256) =>
    invoke("cloud_resolve_conflict", { projectId, conflictId, choice, text: text ?? null, remoteSha256: remoteSha256 ?? null }),
  cloudUsage: () => invoke("cloud_usage"),
  cloudMigrationStart: () => invoke("cloud_migration_start"),
  cloudMigrationCancel: () => invoke("cloud_migration_cancel"),
  writeArtifactDraft: (rec, stepId, source, markdown) => invoke("write_artifact_draft", { ...ids(rec), stepId, source, markdown }),
  onCloudState: (handler) => listen<CloudState>("cloud://state", (event) => handler(event.payload)),
  onCloudProject: (handler) => listen<CloudProjectEvent>("cloud://project", (event) => handler(event.payload)),
  onCloudApplied: (handler) => listen<CloudAppliedEvent>("cloud://applied", (event) => handler(event.payload)),
  onCloudRemote: (handler) => listen<CloudRemoteEvent>("cloud://remote", (event) => handler(event.payload)),
  pcRunnerStatus: () => invoke("pc_runner_status"),
  setPcRunnerEnabled: (enabled) => invoke("pc_runner_set_enabled", { enabled }),
  onPcRunnerState: (handler) => listen<PcRunnerStatus>(PC_RUNNER_STATE_EVENT, (event) => handler(event.payload)),
  accountAvailable: () => invoke("docs_account_available"),
  docsDriveConnection: () => invoke("docs_drive_connection"),
  docsDriveConnect: () => invoke("docs_drive_connect"),
  docsDriveDisconnect: () => invoke("docs_drive_disconnect"),
  docsDriveExport: (requestData) => invoke("docs_drive_export", { requestData }),
  docsDriveExportStatus: (exportId) => invoke("docs_drive_export_status", { exportId }),
  docsDriveOpenDocument: (documentId) => invoke("docs_drive_open_document", { documentId }),
  docsDriveFolderExportPlan: (projectId) => invoke("docs_drive_folder_export_plan", { projectId }),
  docsDriveFolderExport: (requestData) => invoke("docs_drive_folder_export", { requestData }),
  docsDriveFolderExportStatus: (exportId) => invoke("docs_drive_folder_export_status", { exportId }),
  docsDriveFolderExportResume: (exportId) => invoke("docs_drive_folder_export_resume", { exportId }),
  personalOpen: (request) => invoke("personal_open", { request }),
  personalCancel: (handle) => invoke("personal_cancel", { handle }),
  personalClose: (handle) => invoke("personal_close", { handle }),
  personalGuard: (handle, phase, snapshot) => invoke("personal_guard", { handle, phase, snapshot: snapshot ?? null }),
  personalReserveIntent: (handle, intentId, snapshot) => invoke("personal_reserve_intent", { handle, intentId, snapshot }),
  personalMarkDispatch: (handle, intentId, stepId) => invoke("personal_mark_dispatch", { handle, intentId, stepId }),
  personalMarkIntent: (handle, intentId, state) => invoke("personal_mark_intent", { handle, intentId, runState: state }),
  personalSavePrivate: (handle, intentId, kind, payload) => invoke("personal_save_private", { handle, intentId, kind, payload }),
  personalReadMaterial: (handle, request) => invoke("personal_read_material", { handle, request }),
  personalSwapModels: (handle, expectedFlow, models) => invoke("personal_swap_models", { handle, expectedFlow, models }),
  personalVerifyInputs: (handle, snapshot) => invoke("personal_verify_inputs", { handle, snapshot }),
  personalPersistCandidate: (handle, candidate) => invoke("personal_persist_candidate", { handle, candidate }),
  personalPublish: (handle, input) => invoke("personal_publish", { handle, input }),
  personalRecord: (handle, input) => invoke("personal_record", { handle, input }),
  personalNihoEnsureIdle: (handle) => invoke("personal_niho_ensure_idle", { handle }),
  personalNihoAccess: (handle, plannedCalls) => invoke("personal_niho_access", { handle, plannedCalls }),
  personalNihoSubmit: (handle, intentId, snapshotSha256) => invoke("personal_niho_submit", { handle, intentId, snapshotSha256 }),
  personalNihoConfirm: (intentId, action) => invoke("personal_niho_confirm", { intentId, action }),
  personalNihoPending: () => invoke("personal_niho_pending"),
};
