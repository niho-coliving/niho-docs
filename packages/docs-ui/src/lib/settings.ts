import {
  EFFORTS,
  LANGUAGES,
  MAC_CONTINUATION_PLACE_OPTIONS,
  PROVIDER_IDS,
  STANDARD_PROFILE_ID,
  defaultProfiles,
  fitEffort,
  modelOptions,
  type Connection,
  type Effort,
  type Language,
  type Profile,
  type ProfileModel,
  type ProviderId,
  type TranscriptionEngine,
} from "@niho/docs-core";

/**
 * アプリの設定（Tauri の app data の settings.json。spec §4.1）。接続方式・方式ごとの 登録した AI とプロファイルと文字起こしの
 * エンジン・言語・保存先。
 *
 * 方式（サブスクリプション／API キー）は全体で 1 つを選び、上限・失敗でも自動で切り替えない（spec §2）。登録した AI の並び・
 * プロファイルの表・文字起こしのエンジンは方式ごとに別に持つ（API キー方式のモデルの表がサブスクリプションの表を上書きしない。
 * #18383）。画面・実行・工程設計・会話は `activeProviders`・`activeProfiles`・`effectiveEngine`（今の方式の値）だけを読む。
 * 鍵は settings.json に置かない（app data の api-keys/ だけ。Tauri の save_api_key。#18769）。
 *
 * 版 1（S1）は `providers`・`profiles` を直に持っていた。読むときにサブスクリプションの表へ移す（同じ挙動になる）。S2a の版 2 は
 * 文字起こしのエンジンを `transcription.engine` に持っていた。読むときにサブスクリプションのエンジンへ移す。
 */
export type { Connection };
export const CONNECTIONS: readonly Connection[] = ["subscription", "apiKey"];

/**
 * 方式ごとの値。`providers` は登録した順（工程に提供元の指定が無ければ先頭を使う）。`engine` は人が選んだ文字起こしのエンジン
 * （null は「使える中の先頭」。選んだエンジンが使えなくなったら先頭に追従する＝`effectiveEngine`）。`deepgram` は Deepgram を
 * 登録したか（API キー方式だけ。文字起こしだけに使い、AI の並びには入れない）。
 */
export type ConnectionSettings = {
  providers: ProviderId[];
  profiles: Profile[];
  engine: TranscriptionEngine | null;
  deepgram: boolean;
};

/**
 * 保存先（C3 #18595。spec niho-docs-cloud §15）: 「この Mac だけ」か「NIHO クラウド」と、この Mac の名前の上書き（null は Mac の
 * 名前）。書くのは Tauri の保存先の command だけ（save_settings はディスクの値を保つ）。画面は cloudState() の値を使う。
 */
export type VaultSettings = { provider: "local" | "niho"; deviceName: string | null };

/**
 * 続きの工程（原文の後）を作る場所（値と名前の正は docs-core の `MAC_CONTINUATION_PLACE_OPTIONS`。#18947）: この Mac か
 * クラウド（NIHO API）。文字起こしは常にこの Mac。
 */
export type ContinuationExecutor = (typeof MAC_CONTINUATION_PLACE_OPTIONS)[number]["value"];

const CONTINUATION_EXECUTORS: ReadonlySet<string> = new Set(MAC_CONTINUATION_PLACE_OPTIONS.map((option) => option.value));

export type AppSettings = {
  version: 4;
  connection: Connection;
  connections: Record<Connection, ConnectionSettings>;
  /** 文字起こしの言語と、時刻を画面・書き出しに含める端末の選択。 */
  transcription: { language: Language; showTimestamps: boolean };
  /** 保存先（null は ~/Documents/NIHO docs）。 */
  docsRoot: string | null;
  /**
   * AI の CLI の場所の上書き（診断用。画面は無く settings.json に書く。絶対パスだけ）。Rust が起動時に読み、
   * 環境変数 NIHO_DOCS_CLAUDE_CLI_PATH・NIHO_DOCS_CODEX_CLI_PATH・NIHO_DOCS_AGY_CLI_PATH があればそちらを使う。保存し直しても消さない。
   */
  cliPaths?: Partial<Record<CliPathKey, string>>;
  vault: VaultSettings;
  /** 続きの工程を作る場所（設定で選ぶ。#18947）。本文・指示・資格情報は保存しない。 */
  personalExecution: { continuation: ContinuationExecutor };
};

/** `cliPaths` のキー（claude → Claude Code、gpt → Codex CLI、gemini → Antigravity CLI）。 */
export type CliPathKey = ProviderId;

function defaultConnection(connection: Connection, providers: ProviderId[]): ConnectionSettings {
  return { providers, profiles: defaultProfiles(connection), engine: null, deepgram: false };
}

export function defaultSettings(): AppSettings {
  return {
    version: 4,
    connection: "subscription",
    connections: { subscription: defaultConnection("subscription", ["claude"]), apiKey: defaultConnection("apiKey", []) },
    transcription: { language: "ja", showTimestamps: false },
    docsRoot: null,
    vault: { provider: "local", deviceName: null },
    personalExecution: { continuation: "this_pc" },
  };
}

/** 保存先の値（版 3 以降）。版 2 以前と形の合わない値は「この Mac だけ」・Mac の名前。 */
function normalizeVault(value: unknown): VaultSettings {
  if (!isRecord(value)) return { provider: "local", deviceName: null };
  const name = typeof value.deviceName === "string" ? value.deviceName.trim() : "";
  return { provider: value.provider === "niho" ? "niho" : "local", deviceName: name || null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is ProviderId {
  return PROVIDER_IDS.includes(value as ProviderId);
}

function normalizeProviders(value: unknown): ProviderId[] | null {
  if (!Array.isArray(value)) return null;
  const providers: ProviderId[] = [];
  for (const item of value) if (isProvider(item) && !providers.includes(item)) providers.push(item);
  return providers;
}

function normalizeModel(provider: ProviderId, value: unknown): ProfileModel | null {
  if (!isRecord(value) || typeof value.model !== "string" || !value.model.trim() || !EFFORTS.includes(value.effort as Effort)) return null;
  return { model: value.model, effort: fitEffort(provider, value.model, value.effort as Effort) };
}

/**
 * プロファイルの表を読む（形の合わない行は捨てる）。既定のプロファイル（標準・高性能・軽量）が欠けていたら足し（軽量は後から足したので、前の版の設定では末尾に足す）、どの行も
 * すべての AI の値を持つようにする（無い AI は既定の同じ行、無ければ標準の値）。
 */
function normalizeProfiles(value: unknown, connection: Connection): Profile[] {
  const defaults = defaultProfiles(connection);
  const standard = defaults.find((profile) => profile.id === STANDARD_PROFILE_ID) ?? defaults[0];
  const read: Profile[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || !isRecord(item.models)) continue;
      if (read.some((profile) => profile.id === item.id)) continue;
      const models: Profile["models"] = {};
      for (const provider of PROVIDER_IDS) {
        const model = normalizeModel(provider, (item.models as Record<string, unknown>)[provider]);
        if (model) models[provider] = model;
      }
      read.push({ id: item.id, name: item.name, models });
    }
  }
  for (const required of defaults) {
    if (!read.some((profile) => profile.id === required.id)) read.push(required);
  }
  return read.map((profile) => {
    const fallback = defaults.find((item) => item.id === profile.id) ?? standard;
    const models: Profile["models"] = {};
    for (const provider of PROVIDER_IDS) {
      const model = profile.models[provider] ?? fallback?.models[provider] ?? standard?.models[provider];
      if (model) models[provider] = { ...model };
    }
    return { ...profile, models };
  });
}

function normalizeEngine(value: unknown, connection: Connection): TranscriptionEngine | null {
  if (value === "gemini" || value === "this-mac") return value;
  return value === "deepgram" && connection === "apiKey" ? "deepgram" : null;
}

function normalizeConnection(value: unknown, connection: Connection, fallbackProviders: ProviderId[], fallbackEngine: unknown = null): ConnectionSettings {
  const record = isRecord(value) ? value : {};
  return {
    providers: normalizeProviders(record.providers) ?? fallbackProviders,
    profiles: normalizeProfiles(record.profiles, connection),
    engine: normalizeEngine(record.engine ?? fallbackEngine, connection),
    deepgram: connection === "apiKey" && record.deepgram === true,
  };
}

/**
 * 保存された設定を読む（形の合わない値は既定に戻す。版 1＝S1 の形はサブスクリプションの表へ移す。版 2 は保存先を「この Mac だけ」に
 * する。版 4 では個人実行の既定経路を足す）。
 */
export function normalizeSettings(value: unknown): AppSettings {
  const settings = defaultSettings();
  if (!isRecord(value)) return settings;
  if ((value.version === 2 || value.version === 3 || value.version === 4) && isRecord(value.connections)) {
    // S2a の版 2 は文字起こしのエンジンを transcription.engine に持っていた（サブスクリプションだけだった）
    const legacyEngine = isRecord(value.transcription) ? value.transcription.engine : null;
    settings.connections = {
      subscription: normalizeConnection(value.connections.subscription, "subscription", ["claude"], legacyEngine),
      apiKey: normalizeConnection(value.connections.apiKey, "apiKey", []),
    };
    if (CONNECTIONS.includes(value.connection as Connection)) settings.connection = value.connection as Connection;
  } else {
    // S1（版 1）: サブスクリプション固定・providers と profiles を直に持つ。文字起こしは この Mac しか無かった（人が選んだ値では
    // ないので「使える中の先頭」にする。登録した AI が Claude だけなら同じく この Mac）
    settings.connections.subscription = normalizeConnection({ providers: value.providers, profiles: value.profiles }, "subscription", ["claude"]);
  }
  if (isRecord(value.transcription) && LANGUAGES.includes(value.transcription.language as Language)) {
    settings.transcription.language = value.transcription.language as Language;
  }
  if (isRecord(value.transcription)) settings.transcription.showTimestamps = value.transcription.showTimestamps === true;
  if (typeof value.docsRoot === "string" && value.docsRoot.startsWith("/")) {
    settings.docsRoot = value.docsRoot;
  }
  if (isRecord(value.cliPaths)) {
    const cliPaths: Partial<Record<CliPathKey, string>> = {};
    for (const key of PROVIDER_IDS) {
      const path = value.cliPaths[key];
      if (typeof path === "string" && path.startsWith("/")) cliPaths[key] = path;
    }
    if (Object.keys(cliPaths).length > 0) settings.cliPaths = cliPaths;
  }
  if (value.version === 3 || value.version === 4) settings.vault = normalizeVault(value.vault);
  // 以前の実行方法（`route`）は読み替えない（NIHO docs は後方互換を作らない。#18872）。知らない値は既定（この Mac）
  if (value.version === 4 && isRecord(value.personalExecution)) {
    const continuation = value.personalExecution.continuation;
    if (typeof continuation === "string" && CONTINUATION_EXECUTORS.has(continuation)) {
      settings.personalExecution.continuation = continuation as ContinuationExecutor;
    }
  }
  return settings;
}

// ---------------------------------------------------------------------------
// 今の方式の値

export function activeConnection(settings: AppSettings): ConnectionSettings {
  return settings.connections[settings.connection];
}

/** 今の方式で登録した AI（登録した順）。 */
export function activeProviders(settings: AppSettings): readonly ProviderId[] {
  return activeConnection(settings).providers;
}

/** 今の方式のプロファイルの表。 */
export function activeProfiles(settings: AppSettings): readonly Profile[] {
  return activeConnection(settings).profiles;
}

function withActive(settings: AppSettings, change: (current: ConnectionSettings) => ConnectionSettings): AppSettings {
  return { ...settings, connections: { ...settings.connections, [settings.connection]: change(activeConnection(settings)) } };
}

export function setActiveProfiles(settings: AppSettings, profiles: Profile[]): AppSettings {
  return withActive(settings, (current) => ({ ...current, profiles }));
}

/** 方式を切り替える（案件・フローはそのまま。実行中は画面と Tauri の両方で断る）。 */
export function setConnection(settings: AppSettings, connection: Connection): AppSettings {
  return settings.connection === connection ? settings : { ...settings, connection };
}

/** 今の方式の文字起こしのエンジンを選ぶ。 */
export function setEngine(settings: AppSettings, engine: TranscriptionEngine): AppSettings {
  return withActive(settings, (current) => ({ ...current, engine }));
}

/** Deepgram を登録した（API キー方式だけ）。 */
export function hasDeepgram(settings: AppSettings): boolean {
  return settings.connection === "apiKey" && settings.connections.apiKey.deepgram;
}

/** Deepgram の登録（API キー方式の表だけを変える）。 */
export function setDeepgram(settings: AppSettings, registered: boolean): AppSettings {
  return { ...settings, connections: { ...settings.connections, apiKey: { ...settings.connections.apiKey, deepgram: registered } } };
}

/**
 * プロファイルの その AI のモデルを、CLI が使えるモデルの一覧（`available`）に合わせる。一覧に無ければ、既定が一覧にあれば既定、
 * 無ければ一覧の先頭にする（思考量はモデルに合わせる）。一覧が空（未ログインなどで読めない）なら変えない。
 */
function alignProfilesToAvailable(
  profiles: readonly Profile[],
  provider: ProviderId,
  available: readonly string[],
  connection: Connection,
): Profile[] {
  const options = available.length > 0 ? modelOptions(provider, available, connection).map((option) => option.id) : [];
  const defaults = defaultProfiles(connection);
  return profiles.map((profile) => {
    const model = profile.models[provider];
    if (options.length === 0 || (model && options.includes(model.model))) return profile;
    const preferred = (defaults.find((item) => item.id === profile.id) ?? defaults[0])?.models[provider];
    const id = preferred && options.includes(preferred.model) ? preferred.model : (options[0] ?? model?.model ?? "");
    const effort = fitEffort(provider, id, model?.effort ?? preferred?.effort ?? "high");
    return { ...profile, models: { ...profile.models, [provider]: { model: id, effort } } };
  });
}

/**
 * AI を登録する（並びの最後に足す）。CLI が使えるモデルの一覧（`available`）を返したときは、プロファイルの その AI の
 * モデルを一覧に合わせる（{@link alignProfilesToAvailable}）。
 */
export function addProvider(settings: AppSettings, provider: ProviderId, available: readonly string[] = []): AppSettings {
  const connection = settings.connection;
  return withActive(settings, (current) => {
    if (current.providers.includes(provider)) return current;
    return {
      ...current,
      providers: [...current.providers, provider],
      profiles: alignProfilesToAvailable(current.profiles, provider, available, connection),
    };
  });
}

/**
 * 登録済みの AI のモデルを、ログイン・確認の後に CLI が返した一覧へ合わせる（未ログインで追加したときの控えのモデルが、
 * アカウントの一覧に無いまま実行に使われないように）。変える必要が無ければ同じ設定を返す。
 */
export function alignProviderModels(settings: AppSettings, provider: ProviderId, available: readonly string[]): AppSettings {
  const current = activeConnection(settings);
  if (!current.providers.includes(provider)) return settings;
  const profiles = alignProfilesToAvailable(current.profiles, provider, available, settings.connection);
  if (profiles.every((profile, index) => profile === current.profiles[index])) return settings;
  return setActiveProfiles(settings, profiles);
}

/**
 * 最後の 1 つは解除できない（AI が 0 になると工程を実行できず行き止まりになる）。API キー方式で鍵を 1 つも保存していないとき
 * （登録が 0）は、そもそも行が無い。
 */
export function canRemoveProvider(settings: AppSettings, provider: ProviderId): boolean {
  const providers = activeProviders(settings);
  return providers.includes(provider) && providers.length > 1;
}

/** AI の登録を外す（プロファイルの値は残す。登録し直せば戻る）。最後の 1 つなら変えない。 */
export function removeProvider(settings: AppSettings, provider: ProviderId): AppSettings {
  if (!canRemoveProvider(settings, provider)) return settings;
  return withActive(settings, (current) => ({ ...current, providers: current.providers.filter((item) => item !== provider) }));
}

// ---------------------------------------------------------------------------
// 文字起こし

/**
 * 使える文字起こしのエンジン（Gemini → この Mac → Deepgram の順。owner 2026-10-15）。Gemini は今の方式で登録しているとき
 * だけ、Deepgram は API キー方式で登録しているときだけ。
 */
export function transcriptionEngines(settings: AppSettings): TranscriptionEngine[] {
  const engines: TranscriptionEngine[] = [];
  if (activeProviders(settings).includes("gemini")) engines.push("gemini");
  engines.push("this-mac");
  if (hasDeepgram(settings)) engines.push("deepgram");
  return engines;
}

/**
 * この Mac で動かない文字起こし（speech_status の確認で分かる。#18753）。`os` は macOS 26 より前で、文字起こしの部品
 * （niho-speech。macOS 26 向けに作る）が起動しない: この Mac の文字起こしも、Gemini に送る音声の準備も使えない（Deepgram は部品を
 * 使わない）。`engine` は部品は動くが、この Mac で音声認識を使えない: この Mac の文字起こしだけ使えない。
 */
export type SpeechUnsupported = "os" | "engine";

let speechUnsupported: SpeechUnsupported | null = null;

/**
 * 確かめた結果を覚える（Tauri の bridge が speech_status のたびに呼ぶ。起動時の準備の確認と、設定を開いたとき）。Mac の能力は
 * 動いている間は変わらないので、確かめられなかったときは前の結果のまま。`effectiveEngine` は動かないエンジンを既定にしない。
 */
export function rememberSpeechSupport(unsupported: SpeechUnsupported | null): void {
  speechUnsupported = unsupported;
}

/** 覚えている確認の結果（まだ確かめていなければ null。Mac の能力は動いている間は変わらないので、確かめ直しに失敗しても保たれる）。 */
export function rememberedSpeechSupport(): SpeechUnsupported | null {
  return speechUnsupported;
}

/** そのエンジンがこの Mac で動くか（`unsupported` を省くと、覚えている結果で決める）。 */
export function engineRunsHere(engine: TranscriptionEngine, unsupported: SpeechUnsupported | null = speechUnsupported): boolean {
  if (engine === "deepgram" || unsupported === null) return true;
  return unsupported === "engine" && engine === "gemini";
}

/** 設定の「文字起こし」に出す、使えない理由と代わりの手段。 */
export function speechUnsupportedNote(unsupported: SpeechUnsupported): string {
  return unsupported === "os"
    ? "この macOS では音声を処理できないため（macOS 26 以降で使えます）、「この Mac」と Gemini では文字起こしできません。API キー方式で Deepgram を登録すると文字起こしできます。"
    : "この Mac では音声認識を使えないため、「この Mac」では文字起こしできません。Gemini を登録するか、API キー方式で Deepgram を登録すると文字起こしできます。";
}

/**
 * 実際に使うエンジン: 今の方式で人が選んだもの（使えて、この Mac で動くときだけ）、無ければ使える中でこの Mac で動く先頭。
 * どれも動かなければ、人が選んだもの（無ければ使える中の先頭）のまま、実行の前に理由を出す（run-readiness）。`unsupported` を
 * 省くと、覚えている確認の結果で決める（実行はこちら）。
 */
export function effectiveEngine(settings: AppSettings, unsupported: SpeechUnsupported | null = speechUnsupported): TranscriptionEngine {
  const engines = transcriptionEngines(settings);
  const chosen = activeConnection(settings).engine;
  const picked = chosen && engines.includes(chosen) ? chosen : null;
  const runnable = engines.filter((engine) => engineRunsHere(engine, unsupported));
  if (picked && runnable.includes(picked)) return picked;
  return runnable[0] ?? picked ?? engines[0] ?? "this-mac";
}

const ENGINE_LABELS: Record<TranscriptionEngine, string> = { gemini: "Gemini", "this-mac": "この Mac", deepgram: "Deepgram" };

export function engineLabel(engine: TranscriptionEngine): string {
  return ENGINE_LABELS[engine];
}
