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
  TRANSCRIPTION_ENGINE_LABELS,
  type TranscriptionEngine,
} from "@niho/docs-core";

/**
 * アプリの設定（Tauri の app data の settings.json。spec §4.1）。モデルの方式・方式ごとの 登録した AI とプロファイル・文字起こしの
 * エンジンと言語・保存先。
 *
 * 登録と利用を分ける（owner 2026-10-19）。接続設定は登録で、サブスクリプションの AI と API キーの AI・Deepgram を同時に持てる。
 * 方式（`connection`。サブスクリプション／API キー）はモデルの方式＝文字起こし修正以降の工程と「AIと作る」で使う方式で、全体で 1 つを
 * 選び、上限・失敗でも自動で切り替えない（spec §2）。登録した AI の並び・プロファイルの表は方式ごとに別に持つ（API キー方式のモデルの
 * 表がサブスクリプションの表を上書きしない。#18383）。工程・工程設計・会話は `activeProviders`・`activeProfiles`（今の方式の値）だけを
 * 読む。文字起こしのエンジンは方式に依らず、登録したもの全部から選ぶ（`transcriptionEngines`・`effectiveEngine`）。
 * 鍵は settings.json に置かない（app data の api-keys/ だけ。Tauri の save_api_key。#18769）。
 *
 * 版 1（S1）は `providers`・`profiles` を直に持っていた。読むときにサブスクリプションの表へ移す（同じ挙動になる）。S2a の版 2 は
 * 文字起こしのエンジンを `transcription.engine` に持っていた。版 2〜4 はエンジンと Deepgram の登録を方式ごとの表に持っていた。読むときに
 * 今の方式のエンジンを `transcription.engine` へ、API キーの表の Deepgram の登録を `transcription.deepgram` へ移す。
 */
export type { Connection };
export const CONNECTIONS: readonly Connection[] = ["subscription", "apiKey"];

/** 方式ごとの値。`providers` は登録した順（工程に提供元の指定が無ければ先頭を使う）。 */
export type ConnectionSettings = {
  providers: ProviderId[];
  profiles: Profile[];
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
  version: 5;
  /** モデルの方式（文字起こし修正以降の工程と「AIと作る」）。文字起こしには効かない。 */
  connection: Connection;
  connections: Record<Connection, ConnectionSettings>;
  /**
   * 文字起こしの言語と、時刻を画面・書き出しに含める端末の選択。`engine` は人が選んだ既定のエンジン（null は「使える中の先頭」。
   * 選んだエンジンが使えなくなったら追従する＝`effectiveEngine`）。`deepgram` は Deepgram を登録したか（方式に依らない。文字起こし
   * だけに使い、AI の並びには入れない）。
   */
  transcription: { language: Language; showTimestamps: boolean; engine: TranscriptionEngineId | null; deepgram: boolean };
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
  return { providers, profiles: defaultProfiles(connection) };
}

export function defaultSettings(): AppSettings {
  return {
    version: 5,
    connection: "subscription",
    connections: { subscription: defaultConnection("subscription", ["claude"]), apiKey: defaultConnection("apiKey", []) },
    transcription: { language: "ja", showTimestamps: false, engine: null, deepgram: false },
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

function normalizeEngine(value: unknown): TranscriptionEngineId | null {
  return TRANSCRIPTION_ENGINE_IDS.includes(value as TranscriptionEngineId) ? (value as TranscriptionEngineId) : null;
}

/** 版 4 までの方式ごとのエンジン（"gemini" はその方式の Gemini。Deepgram は API キー方式だけ）。 */
function legacyEngine(value: unknown, connection: Connection): TranscriptionEngineId | null {
  if (value === "gemini") return connection === "apiKey" ? "gemini-api" : "gemini-subscription";
  if (value === "this-mac") return "this-mac";
  return value === "deepgram" && connection === "apiKey" ? "deepgram" : null;
}

function normalizeConnection(value: unknown, connection: Connection, fallbackProviders: ProviderId[]): ConnectionSettings {
  const record = isRecord(value) ? value : {};
  return {
    providers: normalizeProviders(record.providers) ?? fallbackProviders,
    profiles: normalizeProfiles(record.profiles, connection),
  };
}

/**
 * 保存された設定を読む（形の合わない値は既定に戻す。版 1＝S1 の形はサブスクリプションの表へ移す。版 2 は保存先を「この Mac だけ」に
 * する。版 4 では個人実行の既定経路を足す）。
 */
export function normalizeSettings(value: unknown): AppSettings {
  const settings = defaultSettings();
  if (!isRecord(value)) return settings;
  if ((value.version === 2 || value.version === 3 || value.version === 4 || value.version === 5) && isRecord(value.connections)) {
    const connections = value.connections;
    settings.connections = {
      subscription: normalizeConnection(connections.subscription, "subscription", ["claude"]),
      apiKey: normalizeConnection(connections.apiKey, "apiKey", []),
    };
    if (CONNECTIONS.includes(value.connection as Connection)) settings.connection = value.connection as Connection;
    const transcription = isRecord(value.transcription) ? value.transcription : {};
    if (value.version === 5) {
      settings.transcription.engine = normalizeEngine(transcription.engine);
      settings.transcription.deepgram = transcription.deepgram === true;
    } else {
      // 版 2〜4 はエンジンを方式ごとの表に持っていた（今の方式のエンジンを既定として引き継ぐ）。S2a の版 2 はサブスクリプションの
      // エンジンを transcription.engine に持っていた。Deepgram の登録は API キーの表にあった
      const table = connections[settings.connection];
      const own = isRecord(table) ? table.engine : undefined;
      const fallback = settings.connection === "subscription" ? transcription.engine : undefined;
      settings.transcription.engine = legacyEngine(own ?? fallback, settings.connection);
      settings.transcription.deepgram = isRecord(connections.apiKey) && connections.apiKey.deepgram === true;
      // 版 4 の API キー方式で選んでいなかった人は、使える中の先頭＝API キーの Gemini で文字起こししていた。従量課金のエンジンは
      // 自動では選ばなくなったので、黙ってこの Mac に変わらないよう、移すときだけ明示の選択として引き継ぐ
      if (settings.transcription.engine === null && settings.connection === "apiKey" && settings.connections.apiKey.providers.includes("gemini")) {
        settings.transcription.engine = "gemini-api";
      }
    }
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
  if (value.version === 3 || value.version === 4 || value.version === 5) settings.vault = normalizeVault(value.vault);
  // 以前の実行方法（`route`）は読み替えない（NIHO docs は後方互換を作らない。#18872）。知らない値は既定（この Mac）
  if ((value.version === 4 || value.version === 5) && isRecord(value.personalExecution)) {
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

function withConnection(
  settings: AppSettings,
  connection: Connection,
  change: (current: ConnectionSettings) => ConnectionSettings,
): AppSettings {
  return { ...settings, connections: { ...settings.connections, [connection]: change(settings.connections[connection]) } };
}

function withActive(settings: AppSettings, change: (current: ConnectionSettings) => ConnectionSettings): AppSettings {
  return withConnection(settings, settings.connection, change);
}

export function setActiveProfiles(settings: AppSettings, profiles: Profile[]): AppSettings {
  return withActive(settings, (current) => ({ ...current, profiles }));
}

/** モデルの方式を切り替える（案件・フロー・文字起こしのエンジンはそのまま。実行中は画面と Tauri の両方で断る）。 */
export function setConnection(settings: AppSettings, connection: Connection): AppSettings {
  return settings.connection === connection ? settings : { ...settings, connection };
}

/** 既定の文字起こしのエンジンを選ぶ（方式に依らない）。 */
export function setEngine(settings: AppSettings, engine: TranscriptionEngineId): AppSettings {
  return { ...settings, transcription: { ...settings.transcription, engine } };
}

/** Deepgram を登録した（方式に依らない。鍵は api-keys/deepgram）。 */
export function hasDeepgram(settings: AppSettings): boolean {
  return settings.transcription.deepgram;
}

/** Deepgram の登録。 */
export function setDeepgram(settings: AppSettings, registered: boolean): AppSettings {
  return { ...settings, transcription: { ...settings.transcription, deepgram: registered } };
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
 * AI を登録する（`connection` の方式の並びの最後に足す。省くと今の方式）。CLI が使えるモデルの一覧（`available`）を返したときは、
 * プロファイルの その AI のモデルを一覧に合わせる（{@link alignProfilesToAvailable}）。
 */
export function addProvider(
  settings: AppSettings,
  provider: ProviderId,
  available: readonly string[] = [],
  connection: Connection = settings.connection,
): AppSettings {
  return withConnection(settings, connection, (current) => {
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
 * アカウントの一覧に無いまま実行に使われないように）。`connection` を省くと今の方式。変える必要が無ければ同じ設定を返す。
 */
export function alignProviderModels(
  settings: AppSettings,
  provider: ProviderId,
  available: readonly string[],
  connection: Connection = settings.connection,
): AppSettings {
  const current = settings.connections[connection];
  if (!current.providers.includes(provider)) return settings;
  const profiles = alignProfilesToAvailable(current.profiles, provider, available, connection);
  if (profiles.every((profile, index) => profile === current.profiles[index])) return settings;
  return withConnection(settings, connection, (table) => ({ ...table, profiles }));
}

/**
 * モデルの方式（工程・「AIと作る」で使う方式）の最後の 1 つは解除できない（AI が 0 になると工程を実行できず行き止まりになる）。
 * 使っていない方式の AI は、最後の 1 つでも解除できる。API キー方式で鍵を 1 つも保存していないとき（登録が 0）は、そもそも行が無い。
 */
export function canRemoveProvider(settings: AppSettings, provider: ProviderId, connection: Connection = settings.connection): boolean {
  const providers = settings.connections[connection].providers;
  return providers.includes(provider) && (connection !== settings.connection || providers.length > 1);
}

/** AI の登録を外す（プロファイルの値は残す。登録し直せば戻る）。解除できなければ変えない。 */
export function removeProvider(settings: AppSettings, provider: ProviderId, connection: Connection = settings.connection): AppSettings {
  if (!canRemoveProvider(settings, provider, connection)) return settings;
  return withConnection(settings, connection, (current) => ({ ...current, providers: current.providers.filter((item) => item !== provider) }));
}

// ---------------------------------------------------------------------------
// 文字起こし

/**
 * 文字起こしのエンジン（方式を含む。spec §5.5・owner 2026-10-19）。Gemini はサブスクリプション（Antigravity CLI）と API キー
 * （Gemini API）を別のエンジンにする。Deepgram は API キー、この Mac は方式を持たない。並びは owner 2026-10-15 の順
 * （Gemini → この Mac → Deepgram）。
 */
export type TranscriptionEngineId = "gemini-subscription" | "gemini-api" | "this-mac" | "deepgram";
export const TRANSCRIPTION_ENGINE_IDS: readonly TranscriptionEngineId[] = ["gemini-subscription", "gemini-api", "this-mac", "deepgram"];

/** エンジンの提供元（実行・記録の provider）。 */
export function engineProvider(engine: TranscriptionEngineId): TranscriptionEngine {
  return engine === "gemini-subscription" || engine === "gemini-api" ? "gemini" : engine;
}

/** エンジンの方式（この Mac は方式を持たない＝null）。 */
export function engineConnection(engine: TranscriptionEngineId): Connection | null {
  if (engine === "gemini-subscription") return "subscription";
  return engine === "gemini-api" || engine === "deepgram" ? "apiKey" : null;
}

/** 使った分だけ請求されるエンジン（人が選んだときだけ使い、自動で既定にも代わりにもしない）。 */
export function engineMetered(engine: TranscriptionEngineId): boolean {
  return engineConnection(engine) === "apiKey";
}

/**
 * 使える文字起こしのエンジン（登録したもの全部。モデルの方式に依らない）。Gemini はその方式で Gemini を登録しているとき、Deepgram は
 * 登録しているとき（鍵の確かめは実行の失敗が理由を出す。今までと同じ）。
 */
export function transcriptionEngines(settings: AppSettings): TranscriptionEngineId[] {
  const engines: TranscriptionEngineId[] = [];
  if (settings.connections.subscription.providers.includes("gemini")) engines.push("gemini-subscription");
  if (settings.connections.apiKey.providers.includes("gemini")) engines.push("gemini-api");
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
export function engineRunsHere(engine: TranscriptionEngineId, unsupported: SpeechUnsupported | null = speechUnsupported): boolean {
  const provider = engineProvider(engine);
  if (provider === "deepgram" || unsupported === null) return true;
  return unsupported === "engine" && provider === "gemini";
}

/** 設定の「文字起こし」に出す、使えない理由と代わりの手段。 */
export function speechUnsupportedNote(unsupported: SpeechUnsupported): string {
  return unsupported === "os"
    ? "この macOS では音声を処理できないため（macOS 26 以降で使えます）、「この Mac」と Gemini では文字起こしできません。接続設定で Deepgram の API キーを登録し、既定のエンジンに選ぶと文字起こしできます。"
    : "この Mac では音声認識を使えないため、「この Mac」では文字起こしできません。Gemini を登録するか、接続設定で Deepgram の API キーを登録して既定のエンジンに選ぶと文字起こしできます。";
}

/**
 * 実際に使うエンジン: 人が選んだもの（使えて、この Mac で動くときだけ）、無ければ使える中でこの Mac で動く、従量課金でない先頭。
 * 従量課金のエンジン（Gemini の API キー・Deepgram）は人が選んだときだけ使い、自動で既定にも代わりにもしない（意図しない請求を
 * 避ける。spec §2）。どれも当てはまらなければ、人が選んだもの（無ければ従量課金でない先頭）のまま、実行の前に理由を出す
 * （run-readiness）。`unsupported` を省くと、覚えている確認の結果で決める（実行はこちら）。
 */
export function effectiveEngine(settings: AppSettings, unsupported: SpeechUnsupported | null = speechUnsupported): TranscriptionEngineId {
  const engines = transcriptionEngines(settings);
  const chosen = settings.transcription.engine;
  const picked = chosen && engines.includes(chosen) ? chosen : null;
  const runnable = engines.filter((engine) => engineRunsHere(engine, unsupported));
  if (picked && runnable.includes(picked)) return picked;
  const unmetered = (engine: TranscriptionEngineId) => !engineMetered(engine);
  return runnable.find(unmetered) ?? picked ?? engines.find(unmetered) ?? "this-mac";
}

const ENGINE_LABELS: Record<TranscriptionEngine, string> = { gemini: "Gemini", "this-mac": "この Mac", deepgram: "Deepgram" };

/** 提供元の名前（実行の記録の provider）。 */
export function engineLabel(engine: TranscriptionEngine): string {
  return ENGINE_LABELS[engine];
}

/** 文字起こしを追加するときの、登録済み・端末対応済みエンジン一覧。 */
export function transcriptionEngineChoices(settings: AppSettings, unsupported: SpeechUnsupported | null = speechUnsupported):
  Array<{ engine: TranscriptionEngineId; label: string; reason: string | null }> {
  const registered = transcriptionEngines(settings);
  return TRANSCRIPTION_ENGINE_IDS.map((engine) => ({
    engine,
    label: engine === "gemini-subscription" ? "Gemini（サブスクリプション）" : engine === "gemini-api" ? "Gemini（API キー）" : engineLabel(engineProvider(engine)),
    reason: !registered.includes(engine)
      ? engine === "deepgram" || engine === "gemini-api" ? "API キーで登録すると使えます" : engine === "gemini-subscription" ? "サブスクリプションで登録すると使えます" : "設定で登録すると使えます"
      : !engineRunsHere(engine, unsupported) ? "この Mac では使えません" : null,
  }));
}

/** エンジンの名前。Gemini は両方の方式を登録しているときだけ方式を添える（「Gemini（API キー）」）。 */
export function engineIdLabel(settings: AppSettings, engine: TranscriptionEngineId): string {
  const label = engineLabel(engineProvider(engine));
  if (engineProvider(engine) !== "gemini") return label;
  const engines = transcriptionEngines(settings);
  if (!engines.includes("gemini-subscription") || !engines.includes("gemini-api")) return label;
  return `${label}（${engine === "gemini-api" ? "API キー" : "サブスクリプション"}）`;
}

/** エンジンの方式と使う仕組み（設定の文字起こしの行の補足）。 */
export function engineMeansLabel(engine: TranscriptionEngineId): string {
  switch (engine) {
    case "gemini-subscription":
      return "サブスクリプション · Antigravity CLI";
    case "gemini-api":
      return "API キー · Google Gemini";
    case "deepgram":
      return "API キー · Nova-3";
    default:
      return "この Mac の音声認識";
  }
}

/** エンジンの料金の種類（サブスクリプションは料金なしではなく契約の範囲＝利用上限を使う）。 */
export function engineBillingLabel(engine: TranscriptionEngineId): string {
  if (engine === "this-mac") return "料金なし";
  return engineMetered(engine) ? "従量課金" : "契約の範囲";
}
