"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  BUILT_IN_PROFILE_IDS,
  EFFORTS,
  LANGUAGES,
  MAC_CONTINUATION_PLACE_OPTIONS,
  PROVIDER_IDS,
  SOURCE_STEP_ID,
  STANDARD_PROFILE_ID,
  apiKeyAccount,
  apiServiceLabel,
  cliLabel,
  contractProvider,
  effortLabel,
  effortUnavailableReason,
  estimateRunCostUsd,
  fitEffort,
  formatUsd,
  languageLabel,
  modelLabel,
  modelOptions,
  providerLabel,
  type About,
  type ApiKeyAccount,
  type ApiKeyStatus,
  type Connection,
  type Effort,
  type Language,
  type Profile,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderStatus,
  type ProviderUsage,
  type RunRecord,
} from "@niho/docs-core";
import { errorMessage, type Bridge, type SpeechStatus } from "../lib/bridge";
import { formatDateTime, formatDuration, formatTokensShort, newId } from "../lib/format";
import {
  activeProfiles,
  activeProviders,
  addProvider,
  alignProviderModels,
  canRemoveProvider,
  effectiveEngine,
  engineLabel,
  engineRunsHere,
  hasDeepgram,
  removeProvider,
  setActiveProfiles,
  setConnection,
  setDeepgram,
  setEngine,
  speechUnsupportedNote,
  transcriptionEngines,
  type AppSettings,
} from "../lib/settings";
import type { DocsAccount as NihoAccount } from "../host/DocsAccount";
import { AccountConnection } from "./AccountConnection";
import { GoogleDocsConnectionCard } from "./GoogleDocs";
import { PcRunnerSettings } from "./PcRunnerSettings";
import type { GoogleDocsController } from "../lib/use-google-docs";

import { AboutCard, type AboutSaveState } from "./AboutCard";
import { ConfirmDialog } from "./ConfirmDialog";
import { usePopover } from "./usePopover";

/**
 * 設定（spec §7・モック v8）: あなたについて（先頭のカード。呼び名・パーソナライズ。AboutCard）・接続設定（方式の 1 択・登録した AI の行だけ＋「＋ 追加」・この Mac の音声認識）・モデル（プロファイル
 * × 登録した AI の モデル／思考量）・文字起こし（既定のエンジン＝Gemini → この Mac → Deepgram の順で登録した分だけ・言語）・
 * 保存先・使用量・アプリが毎回添える決まり（読むだけ）。
 *
 * 方式（サブスクリプション／API キー）は全体で 1 つ。上限・失敗でも自動で切り替えず、実行中（工程・会話・文字起こし）は切り替え
 * られない。方式ごとに 登録した AI・プロファイルの表・文字起こしのエンジンを持つ（案件とフローはそのまま）。
 *
 * サブスクリプション: AI の行は CLI 実行基盤（crate）の状態（入っているか・ログイン・版・ログインの方法）を出し、状態に合わせた
 * 操作を 1 つ出す（Claude Code は 導入／ログイン／更新、Codex CLI は このアプリ用のログイン、Antigravity CLI はターミナルでの
 * ログインの案内と確認）。API キー: 行は鍵の状態（未設定・保存済み〔末尾 4 文字〕・無効）と、鍵の入力欄と 保存（1 回の軽い
 * 呼び出しで確かめてからこの Mac へ。#18769）／確認。鍵は画面に戻らない。Deepgram は API キー方式だけ（文字起こしだけ）。
 * 行の ⋯ に 確認・解除（最後の 1 つは解除できない）。登録していない AI の名前はどこにも出さない（追加のダイアログだけ）。
 */

type RowAction = "install" | "auth" | "update" | "check";

const ACTION_LABELS: Record<RowAction, { label: string; busy: string }> = {
  install: { label: "導入", busy: "導入中…" },
  auth: { label: "ログイン", busy: "ログイン中…" },
  update: { label: "更新", busy: "更新中…" },
  check: { label: "確認", busy: "確認中…" },
};

/** CLI を入れるコマンド（画面からは入れない。Claude Code だけは公式のインストーラを画面から動かす）。 */
const INSTALL_COMMANDS: Partial<Record<ProviderId, string>> = {
  gpt: "brew install --cask codex",
  gemini: "brew install --cask antigravity-cli",
};

/** 状態に合わせて出す操作。 */
export function rowAction(provider: ProviderId, status: ProviderStatus): RowAction {
  if (provider === "claude") {
    if (!status.installed) return "install";
    if (!status.authenticated) return "auth";
    return "update";
  }
  // Codex CLI はこのアプリ用の CODEX_HOME へ `codex login` できる。Antigravity CLI はターミナルでログインする（確認だけ）
  if (provider === "gpt" && status.installed && !status.authenticated && status.reason === "auth_required") return "auth";
  return "check";
}

/** 互換（S1 の Claude Code の行）。 */
export function claudeAction(status: ProviderStatus): RowAction {
  return rowAction("claude", status);
}

/** CLI の行の状態の文（版・ログインの方法・古い版）。 */
export function providerStatusText(status: ProviderStatus | null | undefined): string {
  if (!status) return "確認中";
  if (!status.installed) return status.reason === "cli_version_failed" ? "起動できません" : "未導入";
  const login = status.authenticated
    ? `ログイン済み${status.login_method ? `（${status.login_method}）` : ""}`
    : status.reason === "auth_probe_failed"
      ? "ログインを確かめられません"
      : "未ログイン";
  const parts = [status.version ?? "", login];
  if (status.missing_cli_flags.length > 0) parts.push("古い版です。更新してください");
  return parts.filter(Boolean).join(" · ");
}

/** 互換（S1）。 */
export const claudeStatusText = providerStatusText;

/** できること（同じ会話の続き・思考量・ツールを切った実行）。 */
export function capabilityText(capabilities: ProviderCapabilities): string {
  const parts: string[] = [];
  if (capabilities.resume) parts.push("同じ会話での続き");
  if (capabilities.effort) parts.push("思考量の指定");
  if (capabilities.tools_off_proven) parts.push("ツールを切った実行");
  return parts.length > 0 ? `対応: ${parts.join("・")}` : "";
}

/** 状態に合わせた案内（導入のコマンド・ログインの仕方）。 */
function guidance(provider: ProviderId, status: ProviderStatus): { text: string; command?: string } | null {
  if (provider === "claude") return null;
  if (!status.installed) {
    const command = INSTALL_COMMANDS[provider];
    return {
      text: `ターミナルで次のコマンドを実行して ${cliLabel(provider)} を入れてから、「確認」を押してください。`,
      ...(command ? { command } : {}),
    };
  }
  if (!status.authenticated) {
    if (provider === "gpt") {
      return {
        text: "NIHO docs は Codex CLI をこのアプリ専用の設定で動かします。ターミナルの codex でログイン済みでも、ここで一度ログインしてください。",
      };
    }
    return { text: "ターミナルで agy を起動して Google のアカウントでログインしてから、「確認」を押してください。" };
  }
  if (status.missing_cli_flags.length > 0) {
    return { text: `${cliLabel(provider)} を最新版に更新してから、「確認」を押してください。` };
  }
  return null;
}

/**
 * 月の使用量。`tokenRuns` はトークン数を提供元が返した実行の数（実行の数と違えば推測せず「取得できません」）。
 * `costUsd` は API キー方式の見込み金額の和（どれか 1 つでも出せなければ null＝「取得できません」）。
 */
export type Usage = {
  runs: number;
  tokenRuns: number;
  input: number;
  output: number;
  durationMs: number;
  audioSec: number;
  costUsd: number | null;
};

function emptyUsage(): Usage {
  return { runs: 0, tokenRuns: 0, input: 0, output: 0, durationMs: 0, audioSec: 0, costUsd: 0 };
}

const UNAVAILABLE = "取得できません";

/** 使用量の行（`models` は実際に使ったモデル。CLI が返した値、無ければ依頼したモデル）。 */
export type UsageRow = Usage & { models: string[] };

/**
 * 今月の使用量（runs.jsonl から。`connection` の方式の記録だけ。方式の無い古い記録はサブスクリプション）。AI ごとの行は工程の実行と
 * 「AIと作る」の依頼 1 回の記録だけを数え、文字起こしの実行はエンジン（Gemini・この Mac・Deepgram）に依らず「文字起こし」の行
 * だけに数える（同じ実行を 2 つの行に数えない）。
 */
export function summarizeUsage(
  runs: readonly RunRecord[],
  month: Date,
  connection: Connection = "subscription",
): { providers: Record<ProviderId, UsageRow>; speech: UsageRow } {
  const providers = Object.fromEntries(PROVIDER_IDS.map((id) => [id, { ...emptyUsage(), models: [] as string[] }])) as Record<
    ProviderId,
    UsageRow
  >;
  const speech: UsageRow = { ...emptyUsage(), models: [] };
  const add = (target: UsageRow, run: RunRecord) => {
    target.runs++;
    if (run.tokensKnown !== false && run.inputTokens !== undefined) {
      target.tokenRuns++;
      target.input += run.inputTokens;
      target.output += run.outputTokens ?? 0;
    }
    target.durationMs += run.durationMs ?? 0;
    target.audioSec += run.audioSec ?? 0;
    const cost = estimateRunCostUsd(run);
    target.costUsd = target.costUsd === null || cost === null ? null : target.costUsd + cost;
    // この Mac の音声認識はモデルの名前を持たない
    const used = run.provider === "this-mac" ? null : (run.modelUsed ?? run.model);
    if (used && !target.models.includes(used)) target.models.push(used);
  };
  for (const run of runs) {
    // 工程の実行と、「AIと作る」の依頼 1 回の記録（AI が書き換えた版の記録は同じ依頼なので数えない）
    if (run.kind !== "run" && !(run.kind === "agent" && run.turnRecord)) continue;
    if ((run.connection ?? "subscription") !== connection) continue;
    const at = new Date(run.at);
    if (at.getFullYear() !== month.getFullYear() || at.getMonth() !== month.getMonth()) continue;
    if (run.stepId === SOURCE_STEP_ID) {
      if (run.provider === "this-mac" || run.provider === "gemini" || run.provider === "deepgram") add(speech, run);
      continue;
    }
    if (!run.provider || run.provider === "this-mac" || run.provider === "deepgram") continue;
    add(providers[run.provider], run);
  }
  return { providers, speech };
}

function shortenHome(path: string): string {
  const match = /^\/Users\/[^/]+(\/.*)?$/.exec(path);
  return match ? `~${match[1] ?? ""}` : path;
}

function nameKey(name: string): string {
  return name.normalize("NFKC").trim();
}

/** Antigravity CLI の週の残り（Gemini の群）。返らなければ null。 */
function geminiRemaining(usage: ProviderUsage): string | null {
  const windows = usage.windows.filter((window) => /gemini/i.test(window.group) && window.remaining_fraction !== null);
  const weekly = windows.find((window) => window.window === "weekly" || /week/i.test(window.name)) ?? windows[0];
  if (!weekly || weekly.remaining_fraction === null) return null;
  const percent = Math.round(Math.max(0, Math.min(1, weekly.remaining_fraction)) * 100);
  return `週の残り ${percent}%${weekly.reset_time ? `（${formatDateTime(weekly.reset_time)} に戻る）` : ""}`;
}

// ---------------------------------------------------------------------------
// 接続設定の行

type RowNote = { kind: "help" | "err"; text: string };

function ProviderRow(props: {
  provider: ProviderId;
  status: ProviderStatus | null | undefined;
  busy: RowAction | null;
  note: RowNote | null;
  running: boolean;
  removable: boolean;
  onAction: (action: RowAction) => void;
  onRemove: () => void;
  onCopy: (text: string) => void;
}) {
  const { provider, status } = props;
  const menu = usePopover<HTMLSpanElement>();
  const action = status ? rowAction(provider, status) : null;
  const dot = !status?.installed ? "none" : status.authenticated && status.missing_cli_flags.length === 0 ? "" : "off";
  const caps = status?.installed ? capabilityText(status.capabilities) : "";
  const help = status ? guidance(provider, status) : null;
  const locked = props.busy !== null || status === undefined;
  /** 実行中は CLI のログイン・導入・更新をしない（crate も断る）。確認はできる。 */
  const blocked = props.running && action !== null && action !== "check";
  const label = cliLabel(provider);
  const pick = (run: () => void) => () => {
    menu.setOpen(false);
    run();
  };
  return (
    <div className="prow">
      <b>{label}</b>
      <span className="stc">
        <span className="st">
          <i className={dot} />
          {providerStatusText(status)}
        </span>
        {caps && <span className="help">{caps}</span>}
        {help && <span className="help">{help.text}</span>}
        {help?.command && (
          <span className="cmd">
            <code>{help.command}</code>
            <button type="button" className="link" onClick={() => props.onCopy(help.command ?? "")}>
              コピー
            </button>
          </span>
        )}
        {props.note && (
          <span className={props.note.kind} role={props.note.kind === "err" ? "alert" : "status"}>
            {props.note.text}
          </span>
        )}
        {blocked && !props.busy && action && <span className="help">実行が終わってから{ACTION_LABELS[action].label}できます。</span>}
      </span>
      <span className="acts" ref={menu.ref}>
        {action && (
          <button type="button" className="btn outline sm" disabled={locked || blocked} onClick={() => props.onAction(action)}>
            {props.busy === action ? ACTION_LABELS[action].busy : ACTION_LABELS[action].label}
          </button>
        )}
        <button
          type="button"
          className="ibtn sm"
          title="その他"
          aria-label={`${label}のその他`}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          onClick={menu.toggle}
        >
          ⋯
        </button>
        {menu.open && (
          <div className="pop more" role="menu" aria-label={`${label}の操作`}>
            {action !== "check" && (
              <button type="button" className="mi" role="menuitem" disabled={locked} onClick={pick(() => props.onAction("check"))}>
                確認
              </button>
            )}
            <button type="button" className="mi danger" role="menuitem" disabled={!props.removable} onClick={pick(props.onRemove)}>
              解除
            </button>
            {!props.removable && <p className="help menu-note">最後の 1 つは解除できません。AI が無いと工程を実行できないためです。</p>}
          </div>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// API キーの行（API キー方式）

type KeyAction = "save" | "check" | "delete";

const KEY_BUSY: Record<KeyAction, string> = { save: "確かめています…", check: "確かめています…", delete: "削除しています…" };

/** 鍵の状態の文と点（色だけにしない）。 */
function keyStatusText(status: ApiKeyStatus | null | undefined): { dot: string; text: string } {
  if (status === undefined) return { dot: "off", text: "確認中" };
  if (status === null) return { dot: "off", text: "保存先を読めません" };
  if (!status.saved) return { dot: "none", text: "未設定" };
  const tail = status.last4 ? ` · ••••${status.last4}` : "";
  if (status.valid === false) return { dot: "off", text: `無効${tail}` };
  return { dot: "", text: `保存済み${tail}${status.valid ? " · 確認済み" : ""}` };
}

function ApiKeyRow(props: {
  account: ApiKeyAccount;
  /** 行の補足（Deepgram は「文字起こしだけに使います」）。 */
  hint?: string;
  status: ApiKeyStatus | null | undefined;
  busy: KeyAction | null;
  note: RowNote | null;
  removable: boolean;
  onSave: (key: string) => Promise<boolean>;
  onCheck: () => void;
  onDelete: () => void;
  onRemove: () => void;
}) {
  const { status } = props;
  const label = apiServiceLabel(props.account);
  const menu = usePopover<HTMLSpanElement>();
  const [draft, setDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const inputId = useId();
  const state = keyStatusText(status);
  /** 鍵を入れる欄（未設定・無効・入れ直し）。 */
  const editing = status !== undefined && status !== null && (!status.saved || status.valid === false || replacing);
  const locked = props.busy !== null || status === undefined;
  const pick = (run: () => void) => () => {
    menu.setOpen(false);
    run();
  };
  const save = async () => {
    if (!draft.trim() || locked) return;
    // 鍵は画面の状態に残さない（保存できたら欄を空にする）
    if (await props.onSave(draft)) {
      setDraft("");
      setReplacing(false);
    }
  };
  return (
    <div className="prow">
      <b>{label}</b>
      <span className="stc">
        <span className="st">
          <i className={state.dot} />
          {state.text}
        </span>
        {props.hint && <span className="help">{props.hint}</span>}
        {editing && (
          <input
            id={inputId}
            className="inp key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={`${label}の API キー`}
            placeholder={status?.saved ? "新しい API キー" : "API キーを貼り付け"}
            value={draft}
            disabled={props.busy !== null}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
          />
        )}
        {props.note && (
          <span className={props.note.kind} role={props.note.kind === "err" ? "alert" : "status"}>
            {props.note.text}
          </span>
        )}
      </span>
      <span className="acts" ref={menu.ref}>
        {editing ? (
          <button type="button" className="btn outline sm" disabled={locked || !draft.trim()} onClick={() => void save()}>
            {props.busy === "save" ? KEY_BUSY.save : "保存"}
          </button>
        ) : (
          <button type="button" className="btn outline sm" disabled={locked} onClick={props.onCheck}>
            {props.busy === "check" ? KEY_BUSY.check : "確認"}
          </button>
        )}
        <button
          type="button"
          className="ibtn sm"
          title="その他"
          aria-label={`${label}のその他`}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          onClick={menu.toggle}
        >
          ⋯
        </button>
        {menu.open && (
          <div className="pop more" role="menu" aria-label={`${label}の操作`}>
            {status?.saved && (
              <>
                <button type="button" className="mi" role="menuitem" disabled={locked} onClick={pick(props.onCheck)}>
                  確認
                </button>
                <button type="button" className="mi" role="menuitem" disabled={locked} onClick={pick(() => setReplacing(true))}>
                  鍵を入れ直す
                </button>
                <button type="button" className="mi danger" role="menuitem" disabled={locked} onClick={pick(props.onDelete)}>
                  鍵を削除
                </button>
              </>
            )}
            <button type="button" className="mi danger" role="menuitem" disabled={!props.removable} onClick={pick(props.onRemove)}>
              解除
            </button>
            {!props.removable && <p className="help menu-note">最後の 1 つは解除できません。AI が無いと工程を実行できないためです。</p>}
          </div>
        )}
      </span>
    </div>
  );
}

/** 追加のダイアログの候補（API キー方式では Deepgram も出る）。 */
type AddCandidate = ProviderId | "deepgram";

function AddProviderDialog(props: {
  connection: Connection;
  candidates: readonly AddCandidate[];
  adding: boolean;
  error: string | null;
  onAdd: (candidate: AddCandidate) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const [picked, setPicked] = useState<AddCandidate | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCancelRef = useRef(props.onCancel);
  onCancelRef.current = props.onCancel;
  const addingRef = useRef(props.adding);
  addingRef.current = props.adding;
  // 開いたら最初の候補（無ければキャンセル）へフォーカスを移し、Tab はダイアログの中で回す（背後の設定へ出さない）
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        const inside = dialogRef.current?.contains(document.activeElement) ?? false;
        if (event.shiftKey && (!inside || document.activeElement === first)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!addingRef.current) onCancelRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="veil" role="presentation">
      <div ref={dialogRef} className="dlg add-ai" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>AI を追加</h2>
        <div className="vgrid" role="group" aria-label="追加する AI">
          {props.candidates.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={candidate === "deepgram" ? "vcard dg" : "vcard"}
              aria-pressed={picked === candidate}
              disabled={props.adding}
              onClick={() => setPicked(candidate)}
            >
              <b>{candidate === "deepgram" ? "Deepgram" : providerLabel(candidate)}</b>
              <span>
                {candidate === "deepgram"
                  ? "文字起こし · API キー"
                  : props.connection === "apiKey"
                    ? `${apiServiceLabel(apiKeyAccount(candidate))} の API キー`
                    : `${cliLabel(candidate)} でログイン`}
              </span>
            </button>
          ))}
        </div>
        {props.error && (
          <p className="err" role="alert">
            {props.error}
          </p>
        )}
        <div className="acts">
          <button type="button" className="btn outline" onClick={props.onCancel} disabled={props.adding}>
            キャンセル
          </button>
          <button type="button" className="btn primary" disabled={!picked || props.adding} onClick={() => picked && props.onAdd(picked)}>
            {props.adding ? "確かめています…" : "追加"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// モデル（プロファイル × 登録した AI）

function ModelCell(props: {
  profile: Profile;
  provider: ProviderId;
  connection: Connection;
  available: readonly string[];
  onChange: (provider: ProviderId, model: string, effort: Effort) => void;
}) {
  const { profile, provider } = props;
  const value = profile.models[provider];
  const options = modelOptions(provider, props.available, props.connection);
  const listed = (provider !== "claude" || props.connection === "apiKey") && props.available.length > 0;
  const model = value?.model ?? options[0]?.id ?? "";
  const effort = value?.effort ?? "high";
  const where = `${profile.name}・${providerLabel(provider)}`;
  return (
    <span className="cell model-cell">
      <select
        className="sel sm model-select"
        aria-label={`${where}のモデル`}
        value={model}
        onChange={(event) => props.onChange(provider, event.target.value, fitEffort(provider, event.target.value, effort))}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
        {model && !options.some((option) => option.id === model) && (
          <option value={model}>{`${modelLabel(provider, model)}${listed ? "（一覧に無い）" : ""}`}</option>
        )}
      </select>
      <select
        className="sel sm effort-select"
        aria-label={`${where}の思考量`}
        value={effort}
        onChange={(event) => props.onChange(provider, model, event.target.value as Effort)}
      >
        {EFFORTS.map((candidate) => {
          const reason = effortUnavailableReason(provider, model, candidate);
          return (
            <option key={candidate} value={candidate} disabled={reason !== null}>
              {reason ? `${effortLabel(candidate)}（${reason}）` : effortLabel(candidate)}
            </option>
          );
        })}
      </select>
    </span>
  );
}

function ProfileRow(props: {
  profile: Profile;
  providers: readonly ProviderId[];
  connection: Connection;
  available: Partial<Record<ProviderId, readonly string[]>>;
  editing: boolean;
  nameError: string | null;
  onModel: (provider: ProviderId, model: string, effort: Effort) => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  const { profile } = props;
  const menu = usePopover<HTMLSpanElement>();
  const fixed = BUILT_IN_PROFILE_IDS.includes(profile.id);
  const [name, setName] = useState(profile.name);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Enter・Esc で決めた後の blur（入力欄が消えるとき）で、もう一度決めない。 */
  const settledRef = useRef(false);
  useEffect(() => {
    if (props.editing) {
      settledRef.current = false;
      setName(profile.name);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [props.editing, profile.name]);
  const pick = (run: () => void) => () => {
    menu.setOpen(false);
    run();
  };
  return (
    <div className="pr">
      {props.editing ? (
        <span className="pname">
          <input
            ref={inputRef}
            className="inp"
            aria-label="プロファイルの名前"
            aria-invalid={props.nameError ? true : undefined}
            value={name}
            onChange={(event) => {
              settledRef.current = false;
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                settledRef.current = true;
                props.onRename(name);
              } else if (event.key === "Escape") {
                settledRef.current = true;
                props.onCancelRename();
              }
            }}
            onBlur={() => {
              if (!settledRef.current) props.onRename(name);
            }}
          />
          {props.nameError && (
            <span className="err" role="alert">
              {props.nameError}
            </span>
          )}
        </span>
      ) : (
        <b>{profile.name}</b>
      )}
      {props.providers.map((provider) => (
        <ModelCell
          key={provider}
          profile={profile}
          provider={provider}
          connection={props.connection}
          available={props.available[provider] ?? []}
          onChange={props.onModel}
        />
      ))}
      <span className="more" ref={menu.ref}>
        <button
          type="button"
          className="ibtn sm"
          title="その他"
          aria-label={`${profile.name}のその他`}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          onClick={menu.toggle}
        >
          ⋯
        </button>
        {menu.open && (
          <div className="pop more" role="menu" aria-label={`${profile.name}の操作`}>
            <button type="button" className="mi" role="menuitem" onClick={pick(props.onStartRename)}>
              名前を変更
            </button>
            <button type="button" className="mi danger" role="menuitem" disabled={fixed} onClick={pick(props.onDelete)}>
              削除
            </button>
            {fixed && <p className="help menu-note">標準・高性能・軽量は削除できません（工程の既定です）。</p>}
          </div>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Settings(props: {
  bridge: Bridge;
  account: NihoAccount;
  /**
   * NIHO アカウントのログインと Google ドキュメントの欄を出すか。サーバーが接続を閉じている間（本番の APP_CONNECT_ENABLED=false）は、
   * ログインしていない人には出さない（押しても使えない欄を見せない）。
   */
  accountAvailable: boolean;
  googleDocs: GoogleDocsController;
  settings: AppSettings;
  docsRoot: string;
  /** 工程または会話を実行中か（実行中はログイン・導入・更新をしない）。 */
  running?: boolean;
  rootChangeDisabled?: boolean;
  /** 「あなたについて」の保存済みの内容。保存先を変えて読み直したら aboutKey が変わり、カードを開き直す。 */
  about: About;
  aboutKey: number;
  onSaveAbout: (about: About) => Promise<void>;
  onAboutStateChange: (state: AboutSaveState) => void;
  onRegisterAboutDiscard: (discard: () => void) => void;
  onRegisterAboutFlush: (flush: () => Promise<boolean>) => void;
  onChange: (settings: AppSettings) => void;
  onChangeExecution: (continuation: AppSettings["personalExecution"]["continuation"]) => void;
  /** クラウド接続中は本人共通、未接続時はこの Mac だけの控え。 */
  executionScope: "account" | "local";
  executionProblem: string | null;
  /** 選んだ実行先を受け付けなかった理由（#19107。この Mac の受け入れが OFF など）。実行先は変えておらず、選択の表示も今のまま。 */
  executionNotice?: string | null;
  executionBusy: boolean;
  onChangeRoot: (root: string) => void;
  /** 保存先の「クラウド」の段（CloudSettings。C3 #18595）。 */
  cloudSettings?: ReactNode;
}) {
  const { bridge, settings } = props;
  const connection = settings.connection;
  const apiMode = connection === "apiKey";
  const providers = activeProviders(settings);
  const profiles = activeProfiles(settings);
  const deepgram = hasDeepgram(settings);
  /** CLI の状態（undefined は確認中、null は確かめられなかった）。 */
  const [statuses, setStatuses] = useState<Partial<Record<ProviderId, ProviderStatus | null>>>({});
  /** API キーの状態（undefined は確認中、null は保存先を読めない）。鍵そのものは持たない。 */
  const [keys, setKeys] = useState<Partial<Record<ApiKeyAccount, ApiKeyStatus | null>>>({});
  const [keyBusy, setKeyBusy] = useState<Partial<Record<ApiKeyAccount, KeyAction>>>({});
  const [keyNotes, setKeyNotes] = useState<Partial<Record<ApiKeyAccount, RowNote>>>({});
  /** 鍵を確かめたときに返ったモデル（API キー方式のモデルの選択肢）。 */
  const [apiModels, setApiModels] = useState<Partial<Record<ApiKeyAccount, string[]>>>({});
  const [deletingKey, setDeletingKey] = useState<ApiKeyAccount | null>(null);
  const [busy, setBusy] = useState<Partial<Record<ProviderId, RowAction>>>({});
  const [notes, setNotes] = useState<Partial<Record<ProviderId, RowNote>>>({});
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  /** Antigravity CLI の週の残り（undefined は取得中、null は取得できない）。 */
  const [geminiUsage, setGeminiUsage] = useState<string | null | undefined>(undefined);
  const [downloading, setDownloading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ busy: boolean; error: string | null } | null>(null);
  const [removing, setRemoving] = useState<AddCandidate | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; error: string | null } | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const language = settings.transcription.language;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const check = useCallback(
    async (provider: ProviderId) => {
      setStatuses((all) => ({ ...all, [provider]: undefined }));
      try {
        const status = await bridge.providerStatus(contractProvider(provider));
        setStatuses((all) => ({ ...all, [provider]: status }));
        return status;
      } catch {
        setStatuses((all) => ({ ...all, [provider]: null }));
        return null;
      }
    },
    [bridge],
  );

  /** 確かめに行った AI（登録した AI が増えたときだけ、増えた分を確かめる）。 */
  const checkedRef = useRef(new Set<ProviderId>());
  const providersKey = providers.join(",");
  useEffect(() => {
    if (apiMode) return;
    for (const provider of providersKey.split(",").filter(Boolean) as ProviderId[]) {
      if (checkedRef.current.has(provider)) continue;
      checkedRef.current.add(provider);
      void check(provider);
    }
  }, [check, providersKey, apiMode]);

  /** 鍵の行の状態（保存済みか・末尾 4 文字。呼び出しはしない）。 */
  const readKey = useCallback(
    async (account: ApiKeyAccount) => {
      try {
        const status = await bridge.apiKeyStatus(account);
        setKeys((all) => ({ ...all, [account]: status }));
        // 以前の版がキーチェーンに置いた鍵を移せなかったときは、入れ直しの案内を行に出す（#18769。黙って未設定にしない）
        const message = status.message;
        if (message) setKeyNotes((all) => ({ ...all, [account]: { kind: "err", text: message } }));
      } catch {
        setKeys((all) => ({ ...all, [account]: null }));
      }
    },
    [bridge],
  );
  const accountsKey = apiMode ? [...providers.map(apiKeyAccount), ...(deepgram ? ["deepgram" as const] : [])].join(",") : "";
  const readKeysRef = useRef(new Set<ApiKeyAccount>());
  useEffect(() => {
    for (const account of accountsKey.split(",").filter(Boolean) as ApiKeyAccount[]) {
      if (readKeysRef.current.has(account)) continue;
      readKeysRef.current.add(account);
      void readKey(account);
    }
  }, [accountsKey, readKey]);

  const keyAction = async (account: ApiKeyAccount, action: KeyAction, key?: string): Promise<boolean> => {
    setKeyBusy((all) => ({ ...all, [account]: action }));
    setKeyNotes((all) => ({ ...all, [account]: undefined }));
    try {
      const status =
        action === "save"
          ? await bridge.saveApiKey(account, key ?? "")
          : action === "check"
            ? await bridge.checkApiKey(account)
            : await bridge.deleteApiKey(account);
      setKeys((all) => ({ ...all, [account]: status }));
      if (status.models.length > 0) setApiModels((all) => ({ ...all, [account]: status.models }));
      const note: RowNote | undefined = status.message
        ? { kind: status.valid === false || status.valid === null ? "err" : "help", text: status.message }
        : action === "save"
          ? { kind: "help", text: "確かめてからこの Mac に保存しました。" }
          : action === "check" && status.valid
            ? { kind: "help", text: "API キーは使えます。" }
            : undefined;
      setKeyNotes((all) => ({ ...all, [account]: note }));
      return true;
    } catch (error) {
      setKeyNotes((all) => ({
        ...all,
        [account]: { kind: "err", text: errorMessage(error, "うまくいきませんでした。もう一度お試しください。") },
      }));
      return false;
    } finally {
      setKeyBusy((all) => ({ ...all, [account]: undefined }));
    }
  };

  /** ログイン・確認の後、CLI が返したモデルの一覧にプロファイルを合わせる（一覧が無ければ何もしない）。 */
  const alignModels = (provider: ProviderId, status: ProviderStatus | null) => {
    if (!status || status.models.length === 0) return;
    const next = alignProviderModels(settingsRef.current, provider, status.models);
    if (next !== settingsRef.current) props.onChange(next);
  };

  const runAction = async (provider: ProviderId, action: RowAction) => {
    setBusy((all) => ({ ...all, [provider]: action }));
    const say = (note: RowNote | null) => setNotes((all) => ({ ...all, [provider]: note ?? undefined }));
    const label = cliLabel(provider);
    if (action === "install") say({ kind: "help", text: `公式のインストーラで ${label} を入れています。数分かかることがあります。` });
    else if (action === "auth")
      say({
        kind: "help",
        text: `ブラウザで ${provider === "gpt" ? "ChatGPT" : providerLabel(provider)} にログインしてください。終わると、ここに戻ります。`,
      });
    else if (action === "update") say({ kind: "help", text: `${label} を最新にしています。` });
    else say(null);
    try {
      if (action === "update") {
        const result = await bridge.updateClaude();
        setStatuses((all) => ({ ...all, [provider]: result.status }));
        const { before_version: before, after_version: after } = result;
        say({
          kind: "help",
          text:
            before && after && before !== after
              ? `${label} を更新しました（${before} → ${after}）。`
              : after
                ? `${label} は最新です（${after}）。`
                : `${label} を最新にしました。`,
        });
      } else if (action === "install" || action === "auth") {
        const status = action === "auth" ? await bridge.startAuth(contractProvider(provider)) : await bridge.installClaude();
        setStatuses((all) => ({ ...all, [provider]: status }));
        if (action === "auth") alignModels(provider, status);
        say({ kind: "help", text: action === "auth" ? `${label} にログインしました。` : `${label} を入れました。` });
      } else {
        alignModels(provider, await check(provider));
      }
    } catch (error) {
      say({ kind: "err", text: errorMessage(error, "うまくいきませんでした。もう一度お試しください。") });
      await check(provider);
    } finally {
      setBusy((all) => ({ ...all, [provider]: undefined }));
    }
  };

  const checkSpeech = useCallback(async () => {
    try {
      setSpeech(await bridge.speechStatus(language));
    } catch {
      setSpeech(null);
    }
  }, [bridge, language]);

  useEffect(() => {
    void checkSpeech();
  }, [checkSpeech]);
  useEffect(() => {
    bridge.listAllRuns().then(setRuns, () => setRuns([]));
  }, [bridge]);
  // Antigravity CLI の週の残り（サブスクリプションの Gemini だけ）
  const hasGemini = providers.includes("gemini") && !apiMode;
  // ログイン（行の「ログイン」「確認」）で認証の状態が変わったら取り直す（未ログインで開いたときの「取得できません」を残さない）
  const geminiAuthenticated = statuses.gemini?.authenticated === true;
  useEffect(() => {
    if (!hasGemini) return;
    let cancelled = false;
    setGeminiUsage(undefined);
    bridge.providerUsage("GeminiCli").then(
      (usage) => !cancelled && setGeminiUsage(geminiRemaining(usage)),
      () => !cancelled && setGeminiUsage(null),
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, hasGemini, geminiAuthenticated]);

  const now = useMemo(() => new Date(), []);
  const usage = useMemo(() => summarizeUsage(runs, now, connection), [runs, now, connection]);

  const available = useMemo(() => {
    const lists: Partial<Record<ProviderId, readonly string[]>> = {};
    for (const provider of providers) {
      lists[provider] = apiMode ? (apiModels[apiKeyAccount(provider)] ?? []) : (statuses[provider]?.models ?? []);
    }
    return lists;
  }, [providers, statuses, apiMode, apiModels]);

  const changeProfiles = (change: (profiles: Profile[]) => Profile[]) => {
    const current = settingsRef.current;
    props.onChange(setActiveProfiles(current, change([...activeProfiles(current)])));
  };

  const setModel = (id: string, provider: ProviderId, model: string, effort: Effort) =>
    changeProfiles((list) =>
      list.map((profile) => (profile.id === id ? { ...profile, models: { ...profile.models, [provider]: { model, effort } } } : profile)),
    );

  const addProfile = () => {
    const names = new Set(profiles.map((profile) => nameKey(profile.name)));
    let suffix = profiles.length + 1;
    while (names.has(nameKey(`プロファイル ${suffix}`))) suffix++;
    const standard = profiles.find((profile) => profile.id === STANDARD_PROFILE_ID) ?? profiles[0];
    const id = newId("profile");
    changeProfiles((list) => [...list, { id, name: `プロファイル ${suffix}`, models: structuredClone(standard?.models ?? {}) }]);
    setRenaming({ id, error: null });
  };

  const rename = (id: string, value: string) => {
    const name = value.trim();
    if (!name) {
      setRenaming({ id, error: "名前を入れてください。" });
      return;
    }
    if (profiles.some((profile) => profile.id !== id && nameKey(profile.name) === nameKey(name))) {
      setRenaming({ id, error: "同じ名前のプロファイルがあります。" });
      return;
    }
    changeProfiles((list) => list.map((profile) => (profile.id === id ? { ...profile, name } : profile)));
    setRenaming(null);
  };

  const add = async (candidate: AddCandidate) => {
    if (candidate === "deepgram") {
      props.onChange(setDeepgram(settingsRef.current, true));
      setAdding(null);
      return;
    }
    if (apiMode) {
      // 行を足す（鍵はその行に入れて、確かめてから保存する）
      props.onChange(addProvider(settingsRef.current, candidate, apiModels[apiKeyAccount(candidate)] ?? []));
      setAdding(null);
      return;
    }
    setAdding({ busy: true, error: null });
    checkedRef.current.add(candidate);
    const status = await check(candidate);
    props.onChange(addProvider(settingsRef.current, candidate, status?.models ?? []));
    setAdding(null);
  };

  /** 解除（API キー方式は鍵もこの Mac から消す）。 */
  const remove = async (candidate: AddCandidate) => {
    const current = settingsRef.current;
    if (current.connection === "apiKey") {
      const account = candidate === "deepgram" ? "deepgram" : apiKeyAccount(candidate);
      try {
        await bridge.deleteApiKey(account);
      } catch (error) {
        setMessage(errorMessage(error, "API キーを削除できませんでした。"));
        return;
      }
      readKeysRef.current.delete(account);
      setKeys((all) => ({ ...all, [account]: undefined }));
      setKeyNotes((all) => ({ ...all, [account]: undefined }));
    }
    props.onChange(candidate === "deepgram" ? setDeepgram(current, false) : removeProvider(current, candidate));
    if (candidate !== "deepgram") setNotes((all) => ({ ...all, [candidate]: undefined }));
  };

  const download = async () => {
    setDownloading(true);
    setMessage(null);
    try {
      await bridge.speechDownload(newId("speech"), language, () => undefined);
      await checkSpeech();
    } catch (error) {
      setMessage(errorMessage(error, "取得できませんでした。"));
    } finally {
      setDownloading(false);
    }
  };

  const changeRoot = async () => {
    try {
      const picked = await bridge.pickDocsRoot();
      if (picked) props.onChangeRoot(picked);
    } catch (error) {
      setMessage(errorMessage(error, "保存先を変えられませんでした。"));
    }
  };

  const copy = (text: string) => {
    bridge.copyText(text).then(
      () => setMessage(null),
      (error: unknown) => setMessage(errorMessage(error, "コピーできませんでした。")),
    );
  };

  // この Mac で動かない文字起こし（#18753）: 開いたときに確かめた結果。確かめる前（undefined）は覚えている結果でエンジンを決める。
  // 動かない Mac では音声モデルの「取得」も出さない（取得できない）
  const unsupported = speech ? (speech.unsupported ?? null) : undefined;
  const speechReady = speech?.available === true && !speech.needsDownload && speech.diarization.state === "ready";
  const speechNeedsDownload = !unsupported && (speech?.needsDownload === true || speech?.diarization.state === "corrupt");
  const speechDot = !speech?.found ? "none" : speechReady ? "" : "off";
  const speechText = !speech
    ? "確認中"
    : !speech.found
      ? "未導入"
      : `${languageLabel(language)} · ${unsupported ? "使えません" : speechReady ? "準備済み" : speech.diarization.state === "corrupt" ? "要再取得" : speech.needsDownload ? "未取得" : "使えません"}${speech.fake ? "（偽物）" : ""}`;
  const candidates: AddCandidate[] = [
    ...PROVIDER_IDS.filter((provider) => !providers.includes(provider)),
    ...(apiMode && !deepgram ? (["deepgram"] as const) : []),
  ];
  const engines = transcriptionEngines(settings);
  const engine = effectiveEngine(settings, unsupported);
  const columns = { "--n": String(Math.max(1, providers.length)) } as CSSProperties;
  const running = props.running ?? false;
  const usageValue = (row: UsageRow, kind: "duration" | "cost") =>
    row.runs === 0 ? "—" : kind === "duration" ? formatDuration(row.durationMs) : row.costUsd === null ? UNAVAILABLE : formatUsd(row.costUsd);

  return (
    <div className="page">
      <div className="narrow">
        <div className="phead">
          <h1>設定</h1>
        </div>
        {message && <p className="err" style={{ marginBottom: 12 }}>{message}</p>}
        <AboutCard
          key={props.aboutKey}
          about={props.about}
          onSave={props.onSaveAbout}
          onStateChange={props.onAboutStateChange}
          onRegisterDiscard={props.onRegisterAboutDiscard}
          onRegisterFlush={props.onRegisterAboutFlush}
        />
        <div className="card">
          <div className="ch">
            <h2>接続設定</h2>
            <div className="sp" />
            <div className="seg" role="group" aria-label="接続の方式">
              {(["subscription", "apiKey"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={connection === mode}
                  disabled={running && connection !== mode}
                  onClick={() => connection !== mode && !running && props.onChange(setConnection(settingsRef.current, mode))}
                >
                  {mode === "subscription" ? "サブスクリプション" : "API キー"}
                </button>
              ))}
            </div>
          </div>
          {props.accountAvailable && <AccountConnection account={props.account} />}
          <div className="cb">
            <p className="help">
              {apiMode
                ? "API キーで使います。使った分だけ各社から請求されます。"
                : "この Mac でログイン済みの AI を使います。契約の範囲・利用上限・追加クレジットは各社の契約画面で確認してください。"}
            </p>
            {running && <p className="help">実行が終わってから方式を切り替えられます。</p>}
            {apiMode && providers.length === 0 && <p className="help">「＋ 追加」で AI を選び、その行に API キーを保存すると工程を実行できます。</p>}
          </div>
          <div className="cb flush">
            {!apiMode &&
              providers.map((provider) => (
                <ProviderRow
                  key={provider}
                  provider={provider}
                  status={statuses[provider]}
                  busy={busy[provider] ?? null}
                  note={notes[provider] ?? null}
                  running={running}
                  removable={canRemoveProvider(settings, provider)}
                  onAction={(action) => void runAction(provider, action)}
                  onRemove={() => setRemoving(provider)}
                  onCopy={copy}
                />
              ))}
            {apiMode &&
              providers.map((provider) => {
                const account = apiKeyAccount(provider);
                return (
                  <ApiKeyRow
                    key={provider}
                    account={account}
                    status={keys[account]}
                    busy={keyBusy[account] ?? null}
                    note={keyNotes[account] ?? null}
                    removable={canRemoveProvider(settings, provider)}
                    onSave={(key) => keyAction(account, "save", key)}
                    onCheck={() => void keyAction(account, "check")}
                    onDelete={() => setDeletingKey(account)}
                    onRemove={() => setRemoving(provider)}
                  />
                );
              })}
            {apiMode && deepgram && (
              <ApiKeyRow
                account="deepgram"
                hint="文字起こしだけに使います"
                status={keys.deepgram}
                busy={keyBusy.deepgram ?? null}
                note={keyNotes.deepgram ?? null}
                removable
                onSave={(key) => keyAction("deepgram", "save", key)}
                onCheck={() => void keyAction("deepgram", "check")}
                onDelete={() => setDeletingKey("deepgram")}
                onRemove={() => setRemoving("deepgram")}
              />
            )}
            <div className="prow">
              <b>この Mac の音声認識</b>
              <span className="stc">
                <span className="st">
                  <i className={speechDot} />
                  {speechText}
                </span>
                {speech?.notice && <span className="help">{speech.notice}</span>}
                {speech?.error && <span className="err">{speech.error}</span>}
              </span>
              <span className="acts">
                {speechNeedsDownload && (
                  <button type="button" className="btn outline sm" disabled={downloading} onClick={() => void download()}>
                    取得
                  </button>
                )}
              </span>
            </div>
            {candidates.length > 0 && (
              <button type="button" className="addrow" onClick={() => setAdding({ busy: false, error: null })}>
                ＋ 追加
              </button>
            )}
          </div>
        </div>

        {props.accountAvailable && <GoogleDocsConnectionCard googleDocs={props.googleDocs} />}

        {props.accountAvailable && bridge.capabilities?.localExecution !== false && (
          <PcRunnerSettings
            bridge={bridge}
            signedIn={props.account.state?.kind === "signedIn" || props.account.state?.kind === "offline"}
          />
        )}

        <div className="card">
          <div className="ch">
            <h2>モデル</h2>
            <div className="sp" />
            <span className="help">モデル × 思考量</span>
          </div>
          {providers.length === 0 ? (
            <div className="cb">
              <p className="help">接続設定で AI を追加すると、ここでモデルと思考量を選べます。</p>
            </div>
          ) : (
            <div className="cb flush" style={columns}>
              <div className="pr hd">
                <span />
                {providers.map((provider) => (
                  <span key={provider}>{providerLabel(provider)}</span>
                ))}
                <span />
              </div>
              {profiles.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  providers={providers}
                  connection={connection}
                  available={available}
                  editing={renaming?.id === profile.id}
                  nameError={renaming?.id === profile.id ? renaming.error : null}
                  onModel={(provider, model, effort) => setModel(profile.id, provider, model, effort)}
                  onStartRename={() => setRenaming({ id: profile.id, error: null })}
                  onRename={(name) => rename(profile.id, name)}
                  onCancelRename={() => setRenaming(null)}
                  onDelete={() => setDeleting(profile)}
                />
              ))}
              <button type="button" className="addrow" onClick={addProfile}>
                ＋ 追加
              </button>
            </div>
          )}
        </div>

        <div className="card">
          <div className="ch">
            <h2>文字起こし</h2>
          </div>
          {unsupported && (
            <div className="cb">
              <p className="help">{speechUnsupportedNote(unsupported)}</p>
            </div>
          )}
          <div className="cb flush">
            <div className="prow">
              <b>既定のエンジン</b>
              <div className="seg sm" role="group" aria-label="既定のエンジン">
                {engines.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={candidate === engine}
                    disabled={!engineRunsHere(candidate, unsupported)}
                    onClick={() => props.onChange(setEngine(settingsRef.current, candidate))}
                  >
                    {engineLabel(candidate)}
                  </button>
                ))}
              </div>
              <span />
            </div>
            <div className="prow">
              <b>言語</b>
              <select
                className="sel sm"
                aria-label="言語"
                value={language}
                onChange={(event) =>
                  props.onChange({ ...settings, transcription: { ...settings.transcription, language: event.target.value as Language } })
                }
              >
                {LANGUAGES.map((item) => (
                  <option key={item} value={item}>
                    {languageLabel(item)}
                  </option>
                ))}
              </select>
              <span />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="ch">
            <h2>残りの工程</h2>
          </div>
          <div className="cb flush">
            <div className="prow">
              <b>残りの工程</b>
              {/* 文字起こしの後の工程を作る場所（#18947）。実行中に変えても、次の実行から効く */}
              <div className="seg sm" role="group" aria-label="残りの工程">
                {MAC_CONTINUATION_PLACE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={props.executionBusy}
                    aria-pressed={props.executionScope === "account" && props.executionProblem !== null
                      ? false
                      : option.value === settings.personalExecution.continuation}
                    onClick={() => props.onChangeExecution(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <span />
            </div>
            <div className="prow">
              <span />
              {props.executionProblem || !props.executionNotice ? (
                <span className={props.executionProblem ? "bad" : "help"}>
                  {props.executionProblem ?? (props.executionScope === "account"
                    ? "NIHO アカウントで共有し、iPhone・Web・Mac の新しい実行に使います。"
                    : "この Mac だけの設定です。NIHO クラウドへ接続すると、アカウントの設定を使います。")}
                </span>
              ) : (
                // 選べない理由（実行先は変えていない）を押した場所の近くに表示する。
                <span className="help warn" role="alert">{props.executionNotice}</span>
              )}
              <span />
            </div>
          </div>
        </div>

        <div className="card">
          <div className="ch">
            <h2>保存先</h2>
          </div>
          <div className="cb flush">
            <div className="prow">
              <b>ページとフォルダ</b>
              <span className="path" title={props.docsRoot}>
                {shortenHome(props.docsRoot)}
              </span>
              <span className="acts">
                <button type="button" className="btn outline sm" onClick={() => void changeRoot()} disabled={props.rootChangeDisabled}>
                  変更
                </button>
                <button
                  type="button"
                  className="btn outline sm"
                  onClick={() => bridge.revealRoot().catch((error: unknown) => setMessage(errorMessage(error, "Finder で表示できませんでした。")))}
                >
                  Finder で表示
                </button>
              </span>
            </div>
            {props.cloudSettings}
          </div>
        </div>

        <div className="card">
          <div className="ch">
            <h2>
              使用量
              <span style={{ fontSize: 12.5, color: "var(--niho-text-muted)", fontWeight: 400, marginLeft: 6 }}>{now.getMonth() + 1} 月</span>
            </h2>
          </div>
          <div className="cb flush">
            <div className="urow hd">
              <span />
              <span>実行</span>
              <span>入力 / 出力</span>
              <span>{apiMode ? "見込み" : "所要"}</span>
            </div>
            {providers.map((provider) => {
              const row = usage.providers[provider];
              return (
                <div className="urow" key={provider}>
                  <span className="uname">
                    <b>{providerLabel(provider)}</b>
                    {row.models.length > 0 && (
                      <span className="help">{row.models.slice(0, 3).map((model) => modelLabel(provider, model)).join("・")}</span>
                    )}
                    {provider === "gemini" && !apiMode && (
                      <span className="help">{geminiUsage === undefined ? "週の残りを確かめています" : (geminiUsage ?? `週の残り ${UNAVAILABLE}`)}</span>
                    )}
                  </span>
                  <span className="num">{row.runs} 回</span>
                  <span className="num">
                    {row.runs === 0
                      ? "—"
                      : row.tokenRuns !== row.runs
                        ? UNAVAILABLE
                        : `${formatTokensShort(row.input)} / ${formatTokensShort(row.output)}`}
                  </span>
                  <span className="num">{usageValue(row, apiMode ? "cost" : "duration")}</span>
                </div>
              );
            })}
            <div className="urow">
              <span className="uname">
                <b>文字起こし</b>
                {usage.speech.models.length > 0 && (
                  <span className="help">
                    {usage.speech.models
                      .slice(0, 3)
                      .map((model) => (model === "nova-3" ? "Deepgram Nova-3" : modelLabel("gemini", model)))
                      .join("・")}
                  </span>
                )}
              </span>
              <span className="num">{usage.speech.runs} 回</span>
              <span className="num">{usage.speech.runs > 0 ? formatDuration(usage.speech.audioSec * 1000) : "—"}</span>
              <span className="num">{usageValue(usage.speech, apiMode ? "cost" : "duration")}</span>
            </div>
          </div>
        </div>
      </div>
      {adding && (
        <AddProviderDialog
          connection={connection}
          candidates={candidates}
          adding={adding.busy}
          error={adding.error}
          onAdd={(provider) => void add(provider)}
          onCancel={() => setAdding(null)}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`${
            removing === "deepgram" ? "Deepgram" : apiMode ? apiServiceLabel(apiKeyAccount(removing)) : cliLabel(removing)
          } の登録を解除しますか`}
          confirmLabel="解除する"
          danger
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            void remove(target);
          }}
          onCancel={() => setRemoving(null)}
        >
          {removing === "deepgram" ? (
            <p className="msg">文字起こしのエンジンから Deepgram が外れます。API キーもこの Mac から削除します。</p>
          ) : (
            <p className="msg">
              {providerLabel(removing)} を選んだ工程は、登録した AI の先頭で実行します。作成済みの録音で {providerLabel(removing)}{" "}
              を使う工程は、録音のページの「この録音の工程を今の設計に更新」まで実行しません。モデルの設定は残ります。
              {apiMode ? "API キーもこの Mac から削除します。" : ""}
            </p>
          )}
        </ConfirmDialog>
      )}
      {deletingKey && (
        <ConfirmDialog
          title={`${apiServiceLabel(deletingKey)} の API キーを削除しますか`}
          confirmLabel="削除する"
          danger
          onConfirm={() => {
            const account = deletingKey;
            setDeletingKey(null);
            void keyAction(account, "delete");
          }}
          onCancel={() => setDeletingKey(null)}
        >
          <p className="msg">この Mac から API キーを削除します。登録は残り、もう一度 API キーを保存すると使えます。</p>
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={`「${deleting.name}」を削除しますか`}
          confirmLabel="削除する"
          danger
          onConfirm={() => {
            changeProfiles((list) => list.filter((profile) => profile.id !== deleting.id));
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        >
          <p className="msg">このプロファイルを選んだ工程は、工程設計で選び直すまで保存できません。作成済みの録音はそのまま実行できます。</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
