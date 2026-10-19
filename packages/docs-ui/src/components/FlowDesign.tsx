"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  GUIDE_EXTRACTION_PROFILE_ID,
  PROVIDER_IDS,
  defaultProfiles,
  GUIDE_MAX_CHARS,
  SAMPLE_MAX_COUNT,
  STANDARD_PROFILE_ID,
  buildGuideExtractionPrompt,
  cleanGlossary,
  contractEffort,
  contractProvider,
  countChars,
  redirectedNote,
  requestEffort,
  duplicateStep,
  languageLabel,
  mergeExtractedTerms,
  moveStep,
  newStep,
  parseGuideExtraction,
  providerLabel,
  reasonMessage,
  resolveStepModel,
  sameFlowContent,
  stepIssues,
  validateFlow,
  type Flow,
  type FlowIssue,
  type FlowSample,
  type GlossaryEntry,
  type GuideSample,
  type ProviderId,
  type Profile,
  type Step,
  type TurnEvent,
} from "@niho/docs-core";
import { FlowStepInstructionField, FlowStepNameField } from "../flow/flow-step-fields";
import { errorMessage, terminalEvent, type Bridge } from "../lib/bridge";
import { importSampleUrl } from "../lib/sample-url";
import { formatChars, formatNumber, newId, newStepId } from "../lib/format";
import { activeProfiles, activeProviders, effectiveEngine, engineLabel, type AppSettings } from "../lib/settings";
import { ConfirmDialog } from "./ConfirmDialog";
import { Glossary } from "./Glossary";
import { useFitHeight } from "./useFitHeight";
import { usePopover } from "./usePopover";

/**
 * 工程設計（spec §7・§8.4）。上に 保存、その下に フローの一覧（P4 #18567。App が `list` に渡す）と名前の欄。先頭に文書ガイド
 * （お手本の文書・お手本から抽出・ガイド・固有名詞）、続いて工程カード（1 文字起こし＝固定、2〜＝名前・指示文・モデル）と
 * 「＋ 工程を追加」。ガイドと指示文はその場で書ける欄で、書いた分だけ伸びる（開く・閉じるは無い。owner 2026-10-16）。
 * 開いているフロー 1 本に効く（App が フローの id を key にするので、フローを替えると作り直す）。
 * 編集中の内容（draft）は App がフローごとに持ち、ほかのフローや画面へ移っても残る。編集・並び替え・抽出はどれも保存するまで
 * ファイルを変えない（お手本の本文だけは取り込み時に書き、未保存の取り込みを取り消したら削除する。保存済みの本文は保存時に消す）。
 */

/** 取り込めるお手本の文書の拡張子（src-tauri の samples.rs の SAMPLE_EXTENSIONS と同じ）。 */
const SAMPLE_EXTENSIONS = ["md", "markdown", "txt", "docx", "pdf"];

const SAVE_BLOCKED = "保存できません。印の付いたところを直してください。";

function isSamplePath(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && SAMPLE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/** 名前の無い工程も読み上げ・確認の題で呼べるように。 */
function stepLabel(step: Step): string {
  return step.name.trim() || "名前の無い工程";
}

type Final = Extract<TurnEvent, { type: "Done" } | { type: "Error" }>;
/** 抽出したガイドと固有名詞の候補（確かめてから入れる）。 */
type Extracted = { guide: string; candidates: GlossaryEntry[]; added: number };
type Confirm = { kind: "delete"; stepId: string };
type FocusRequest = { key: string; select?: boolean; scroll?: boolean };
type Notice = { message: string; settings?: boolean };

function IssueList(props: { issues: readonly FlowIssue[] }) {
  if (props.issues.length === 0) return null;
  return (
    <ul className="issues">
      {props.issues.map((issue) => (
        <li key={`${issue.code}-${issue.message}`}>
          <span className="ic" aria-hidden="true">
            ⚠
          </span>
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

function SampleRow(props: { sample: FlowSample; onRemove: () => void; onRead: () => Promise<string> }) {
  const menu = usePopover();
  const { sample } = props;
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const read = async () => {
    if (reading) return;
    menu.setOpen(false);
    setReading(true);
    setPreviewError(null);
    try { setPreview(await props.onRead()); }
    catch (error) { setPreviewError(errorMessage(error, "本文を読めませんでした。")); }
    finally { setReading(false); }
  };
  return (
    <div className="sample-entry">
      <div className="afile">
        <span className="ic" aria-hidden="true">
          ▤
        </span>
        <span className="nm">{sample.name}</span>
        <span className="d">
          {formatChars(sample.chars)}
          {sample.truncatedFrom !== undefined ? " · 先頭だけ" : ""}
        </span>
        <div ref={menu.ref}>
          <button
            type="button"
            className="ibtn sm"
            title="その他"
            aria-label={`「${sample.name}」のその他`}
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onClick={menu.toggle}
          >
            ⋯
          </button>
          {menu.open && (
            <div className="pop" role="menu">
              <button type="button" className="mi" role="menuitem" disabled={reading} onClick={() => void read()}>
                本文を確認
              </button>
              <button
                type="button"
                className="mi danger"
                role="menuitem"
                onClick={() => {
                  menu.setOpen(false);
                  props.onRemove();
                }}
              >
                削除
              </button>
            </div>
          )}
        </div>
      </div>
      {sample.sourceUrl && <p className="sample-source">出典: {sample.sourceUrl}</p>}
      {reading && <p className="msg" role="status">本文を読んでいます…</p>}
      {previewError && <p className="err" role="alert">{previewError}</p>}
      {preview !== null && (
        <div className="sample-preview">
          <pre tabIndex={0} aria-label={`「${sample.name}」の本文`}>{preview}</pre>
          <button type="button" className="link" onClick={() => setPreview(null)}>本文を閉じる</button>
        </div>
      )}
    </div>
  );
}

type HandleEvents = {
  onKeyDown: (event: ReactKeyboardEvent<HTMLSpanElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLSpanElement>) => void;
};

function StepCard(props: {
  step: Step;
  index: number;
  count: number;
  issues: FlowIssue[];
  dragging: boolean;
  profiles: readonly Profile[];
  providers: readonly ProviderId[];
  native: boolean;
  handle: HandleEvents;
  register: (key: string, element: HTMLElement | null) => void;
  onChange: (step: Step) => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { step, index, profiles, providers } = props;
  const menu = usePopover();
  const instruction = useRef<HTMLTextAreaElement | null>(null);
  useFitHeight(instruction, step.instruction);
  const label = stepLabel(step);
  // 工程が指す AI が登録されていなければ、登録した AI の先頭で実行する（選択肢は登録した AI だけ）
  const provider = props.native ? (step.provider && providers.includes(step.provider) ? step.provider : providers[0]) : step.provider;
  const redirected = props.native && step.provider !== undefined && !providers.includes(step.provider) ? providers[0] : undefined;
  const knownProfile = profiles.some((profile) => profile.id === step.profile);
  const nameIssue = props.issues.some((issue) =>
    ["empty-step-name", "duplicate-step-name", "reserved-step-name", "duplicate-step-id"].includes(issue.code),
  );
  const instructionIssue = props.issues.some((issue) => issue.code === "empty-instruction");
  const pick = (action: () => void) => () => {
    menu.setOpen(false);
    action();
  };
  return (
    <div
      ref={(element) => props.register(`card:${step.id}`, element)}
      className={`scard${props.issues.length > 0 ? " issue" : ""}${props.dragging ? " dragging" : ""}`}
    >
      <div className="top">
        <span
          ref={(element) => props.register(`handle:${step.id}`, element)}
          className="hd"
          role="button"
          tabIndex={0}
          aria-label={`${label}を並び替え`}
          title="ドラッグか ↑↓ で並び替え"
          {...props.handle}
        >
          ⋮⋮
        </span>
        <span className="num">{index + 2}</span>
        <FlowStepNameField
          inputRef={(element) => props.register(`name:${step.id}`, element)}
          className="inp"
          ariaLabel="工程の名前"
          error={nameIssue ? "工程名を確認してください。" : null}
          value={step.name}
          onChange={(value) => props.onChange({ ...step, name: value })}
        />
        <div className="sp" />
        <div ref={menu.ref}>
          <button
            type="button"
            className="ibtn sm"
            title="その他"
            aria-label="その他"
            aria-haspopup="menu"
            aria-expanded={menu.open}
            onClick={menu.toggle}
          >
            ⋯
          </button>
          {menu.open && (
            <div className="pop more" role="menu" aria-label={`${label}の操作`}>
              <button type="button" className="mi" role="menuitem" disabled={index === 0} onClick={pick(() => props.onMove(index - 1))}>
                上へ移動
              </button>
              <button
                type="button"
                className="mi"
                role="menuitem"
                disabled={index === props.count - 1}
                onClick={pick(() => props.onMove(index + 1))}
              >
                下へ移動
              </button>
              <button type="button" className="mi" role="menuitem" onClick={pick(props.onDuplicate)}>
                複製
              </button>
              <button type="button" className="mi danger" role="menuitem" onClick={pick(props.onDelete)}>
                削除
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="body">
        <span className="label">指示文</span>
        <div className="instr-wrap">
          <FlowStepInstructionField
            inputRef={(element) => {
              instruction.current = element;
              props.register(`instruction:${step.id}`, element);
            }}
            className="ta grow"
            ariaLabel={`${label}の指示文`}
            error={instructionIssue ? "指示文を入力してください。" : null}
            placeholder="AI への指示を書きます。例: 文字起こしから要点を箇条書きにする"
            value={step.instruction}
            onChange={(value) => props.onChange({ ...step, instruction: value })}
          />
        </div>
        <span className="label">モデル</span>
        <div className="row">
          {providers.length >= 2 && (
            <select
              className="sel"
              aria-label={`${label}の提供元`}
              value={provider ?? ""}
              onChange={(event) => { const next = { ...step }; if (!event.target.value) delete next.provider; else next.provider = event.target.value as ProviderId; props.onChange(next); }}
            >
              {!props.native && <option value="">実行時の既定</option>}
              {providers.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {providerLabel(candidate)}
                </option>
              ))}
            </select>
          )}
          <select
            ref={(element) => props.register(`profile:${step.id}`, element)}
            className="sel"
            aria-label={`${label}のモデル`}
            value={step.profile}
            onChange={(event) => props.onChange({ ...step, profile: event.target.value })}
          >
            {!knownProfile && (
              <option value={step.profile} disabled>
                {props.native ? "設定に無いモデル" : `Mac のプロファイル（${step.profile}）`}
              </option>
            )}
            {profiles.map((profile) => {
              const resolved = resolveStepModel({ profile: profile.id, ...(provider ? { provider } : {}) }, profiles, providers);
              return (
                <option key={profile.id} value={profile.id}>
                  {resolved ? profile.name : `${profile.name}（未設定）`}
                </option>
              );
            })}
          </select>
        </div>
        {redirected && (
          <>
            <span className="label" />
            <p className="help redirected">{redirectedNote(redirected)}</p>
          </>
        )}
      </div>
      <IssueList issues={props.issues} />
    </div>
  );
}

/** 文書のお手本だけの接続。ブラウザに native Bridge の代用品を要求しない。 */
export type FlowSampleAccess = {
  pick(flowId: string, room: number): Promise<FlowSample[]>;
  readSample(flowId: string, sampleId: string): Promise<string>;
  pruneSamples(flowId: string, keep: string[]): Promise<void>;
};

export function FlowDesign(props: {
  /** 保存済み（flows/<id>.json）。 */
  flow: Flow;
  /** 編集中（App がフローごとに持つ。ほかのフローや画面へ移っても残る）。 */
  draft: Flow;
  settings?: AppSettings;
  bridge?: Bridge;
  samples?: FlowSampleAccess;
  disabled?: boolean;
  /** 案件のダイアログが開いている間は false（ドロップは案件のダイアログが受ける）。 */
  dropEnabled: boolean;
  /** 画面をまたいで続いているお手本の取り込み。 */
  importingSamples: boolean;
  /** 保存の下に出すフローの一覧（FlowList）。 */
  list: ReactNode;
  /** 名前の欄にフォーカスして選ぶ（一覧の「名前の変更」・複製の後）。済んだら onNameFocused。 */
  focusName: boolean;
  onNameFocused: () => void;
  onChange: (draft: Flow) => void;
  onSave: (flow: Flow) => Promise<void>;
  onOpenSettings?: () => void;
  onImportingChange: (importing: boolean) => void;
}) {
  const { bridge, settings, draft } = props;
  const profiles = settings ? activeProfiles(settings) : defaultProfiles("subscription");
  const providers = settings ? activeProviders(settings) : PROVIDER_IDS;
  const sampleAccess = props.samples ?? bridge;
  const issues = validateFlow(draft, settings ? profiles : undefined);
  const [blocked, setBlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [glossaryKey, setGlossaryKey] = useState(0);
  const [importing, setImporting] = useState(false);
  const importBusy = importing || props.importingSamples;
  const [sampleUrl, setSampleUrl] = useState("");
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [dropOver, setDropOver] = useState(false);
  const [extractTurn, setExtractTurn] = useState<string | null>(null);
  const [extractNotice, setExtractNotice] = useState<Notice | null>(null);
  const [extracted, setExtracted] = useState<Extracted | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const countId = useId();

  // 非同期の処理（取り込み・抽出・ドラッグ）は描き直しを待たずに最新の draft を読む
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const elements = useRef(new Map<string, HTMLElement>());
  const guideArea = useRef<HTMLTextAreaElement | null>(null);
  useFitHeight(guideArea, draft.guide);
  const mountedRef = useRef(true);
  const extractTurnRef = useRef<string | null>(null);
  const stopRequestedRef = useRef(false);
  const importingRef = useRef(false);
  const pruneRef = useRef<Promise<void>>(Promise.resolve());
  const pendingPruneRef = useRef(false);
  const dragRef = useRef<string | null>(null);

  const change = (next: Flow) => {
    draftRef.current = next;
    onChangeRef.current(next);
  };
  const register = (key: string, element: HTMLElement | null) => {
    if (element) elements.current.set(key, element);
    else elements.current.delete(key);
  };

  useLayoutEffect(() => {
    if (!focusRequest) return;
    setFocusRequest(null);
    const target = elements.current.get(focusRequest.key);
    if (!target) return;
    target.focus();
    if (focusRequest.select && target instanceof HTMLInputElement) target.select();
    if (focusRequest.scroll) target.scrollIntoView?.({ block: "center" });
  }, [focusRequest]);

  // 一覧の「名前の変更」・複製の後: 名前の欄へ
  const onNameFocusedRef = useRef(props.onNameFocused);
  onNameFocusedRef.current = props.onNameFocused;
  useEffect(() => {
    if (!props.focusName) return;
    setFocusRequest({ key: "flowName", select: true, scroll: true });
    onNameFocusedRef.current();
  }, [props.focusName]);

  // 直して問題が無くなったら「保存できません」を消す
  useEffect(() => {
    if (issues.length === 0) setBlocked(false);
  }, [issues.length]);

  // 抽出中に画面を離れたら止める
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (importingRef.current) pendingPruneRef.current = true;
      const turnId = extractTurnRef.current;
      if (turnId && bridge) bridge.stopTurn(turnId).catch(() => undefined);
    };
  }, [bridge]);

  // ---- お手本の文書 ----

  const pruneUnsavedSamples = () => {
    const current = draftRef.current;
    const keep = [...new Set([...props.flow.samples.map((sample) => sample.id), ...current.samples.map((sample) => sample.id)])];
    pruneRef.current = pruneRef.current.catch(() => undefined).then(() => sampleAccess?.pruneSamples(current.id, keep));
    void pruneRef.current.catch((error: unknown) => {
      if (mountedRef.current) setImportErrors([errorMessage(error, "お手本の文書を削除できませんでした。")]);
    });
  };

  const importPaths = async (paths: string[]) => {
    if (!bridge || paths.length === 0 || importingRef.current || props.importingSamples) return;
    const room = Math.max(0, SAMPLE_MAX_COUNT - draftRef.current.samples.length);
    const accepted = paths.slice(0, room);
    const limit = paths.length > accepted.length ? [`お手本の文書は ${SAMPLE_MAX_COUNT} 本までです。`] : [];
    setImportErrors([]);
    setImportSuccess(null);
    if (accepted.length === 0) {
      setImportErrors(limit);
      return;
    }
    importingRef.current = true;
    setImporting(true);
    props.onImportingChange(true);
    const errors: string[] = [];
    try {
      await pruneRef.current;
      const results = await bridge.importSamples(draftRef.current.id, accepted);
      const added: FlowSample[] = [];
      for (const result of results) {
        if (result.sample) added.push(result.sample);
        if (result.error) errors.push(`${result.name}: ${result.error.message}`);
      }
      if (added.length > 0 && mountedRef.current) {
        change({ ...draftRef.current, samples: [...draftRef.current.samples, ...added] });
      }
    } catch (error) {
      errors.push(errorMessage(error, "お手本の文書を取り込めませんでした。"));
    } finally {
      importingRef.current = false;
      if (pendingPruneRef.current) {
        pendingPruneRef.current = false;
        pruneUnsavedSamples();
      }
      if (mountedRef.current) {
        setImporting(false);
        setImportErrors([...errors, ...limit]);
      }
      props.onImportingChange(false);
    }
  };
  const importUrl = async () => {
    const url = sampleUrl.trim();
    if (!bridge || !url || importingRef.current || props.importingSamples) return;
    setImportErrors([]);
    setImportSuccess(null);
    if (draftRef.current.samples.length >= SAMPLE_MAX_COUNT) {
      setImportErrors([`お手本の文書は ${SAMPLE_MAX_COUNT} 本までです。`]);
      return;
    }
    importingRef.current = true;
    setImporting(true);
    props.onImportingChange(true);
    try {
      await pruneRef.current;
      const { sample, warnings } = await importSampleUrl(bridge, draftRef.current.id, url);
      if (mountedRef.current) {
        change({ ...draftRef.current, samples: [...draftRef.current.samples, sample] });
        setSampleUrl("");
        setImportSuccess(`「${sample.name}」を取り込みました。本文は ⋯ から確認できます。${warnings.join(" ")}`);
      }
    } catch (error) {
      if (mountedRef.current) setImportErrors([errorMessage(error, "記事を取り込めませんでした。URL を確かめて、もう一度お試しください。")]);
    } finally {
      importingRef.current = false;
      if (pendingPruneRef.current) {
        pendingPruneRef.current = false;
        pruneUnsavedSamples();
      }
      if (mountedRef.current) setImporting(false);
      props.onImportingChange(false);
    }
  };
  const importRef = useRef(importPaths);
  importRef.current = importPaths;

  const pickSamples = async () => {
    if (importBusy) return;
    setImportErrors([]);
    setImportSuccess(null);
    try {
      if (props.samples) {
        props.onImportingChange(true);
        setImporting(true);
        try {
          const added = await props.samples.pick(draftRef.current.id, Math.max(0, SAMPLE_MAX_COUNT - draftRef.current.samples.length));
          if (added.length > 0) change({ ...draftRef.current, samples: [...draftRef.current.samples, ...added] });
        } finally { props.onImportingChange(false); if (mountedRef.current) setImporting(false); }
      } else if (bridge) await importPaths(await bridge.pickSampleFiles());
    } catch (error) {
      if (mountedRef.current) setImportErrors([errorMessage(error, "文書を選べませんでした。")]);
    }
  };

  const removeSample = (sampleId: string) => {
    const current = draftRef.current;
    change({ ...current, samples: current.samples.filter((sample) => sample.id !== sampleId) });
    if (!props.flow.samples.some((sample) => sample.id === sampleId)) {
      if (importingRef.current) pendingPruneRef.current = true;
      else pruneUnsavedSamples();
    }
  };

  // Finder からのドロップ（お手本の文書の形式だけ。ほかは無視する）
  useEffect(() => {
    if (!props.dropEnabled || !bridge?.onFileDrop) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    bridge
      .onFileDrop(
        (paths) => {
          setDropOver(false);
          const documents = paths.filter(isSamplePath);
          if (documents.length > 0) void importRef.current(documents);
        },
        (over) => setDropOver(over),
      )
      .then(
        (stop) => {
          if (disposed) stop();
          else unlisten = stop;
        },
        () => undefined,
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [bridge, props.dropEnabled]);

  // ---- お手本から抽出 ----

  const extract = async () => {
    if (!bridge || !settings || extractTurnRef.current) return;
    setExtractNotice(null);
    const profiles = activeProfiles(settings);
    const providers = activeProviders(settings);
    const resolved =
      resolveStepModel({ profile: GUIDE_EXTRACTION_PROFILE_ID }, profiles, providers) ??
      resolveStepModel({ profile: STANDARD_PROFILE_ID }, profiles, providers);
    if (!resolved) {
      setExtractNotice({ message: "モデルが設定にありません。設定のモデルを確かめてください。", settings: true });
      return;
    }
    const current = draftRef.current;
    const turnId = newId("turn");
    extractTurnRef.current = turnId;
    stopRequestedRef.current = false;
    setExtractTurn(turnId);
    const fail = (message: string) => {
      if (mountedRef.current) setExtractNotice({ message });
    };
    try {
      const samples: GuideSample[] = [];
      for (const sample of current.samples) {
        let text: string;
        try {
          text = await bridge.readSample(current.id, sample.id);
        } catch {
          fail(`お手本の文書「${sample.name}」の本文が見つかりません。⋯ から削除して、入れ直してください。`);
          return;
        }
        samples.push({ name: sample.name, text, ...(sample.truncatedFrom !== undefined ? { truncatedFrom: sample.truncatedFrom } : {}) });
      }
      if (stopRequestedRef.current) {
        fail("止めました。");
        return;
      }
      const prompt = buildGuideExtractionPrompt(samples);
      let streamed = "";
      let final: Final | null = null;
      const completed = await bridge.runTurn(
        turnId,
        {
          provider: contractProvider(resolved.provider, settings.connection),
          model: resolved.model.model,
          effort: (() => {
            const effort = requestEffort(resolved.provider, resolved.model.model, resolved.model.effort);
            return effort ? contractEffort(effort) : null;
          })(),
          system_prompt: prompt.systemPrompt,
          user_prompt: prompt.userPrompt,
          resume_session: null,
          workspace: newId("guide"),
          max_budget_usd: null,
        },
        (envelope) => {
          const event = envelope.event;
          if (event.type === "TextDelta") streamed += event.text;
          else if (event.type === "Done" || event.type === "Error") final = event;
        },
      );
      if (!mountedRef.current) return;
      const result = terminalEvent(completed, final as Final | null);
      if (!result) {
        fail(reasonMessage("InvalidStream", resolved.provider, settings.connection));
      } else if (result.type === "Error") {
        fail(result.message || reasonMessage(result.reason_code, resolved.provider, settings.connection));
      } else if (result.stop_reason === "Stopped") {
        fail("止めました。");
      } else {
        const parsed = parseGuideExtraction(result.text || streamed, samples);
        if (!parsed.ok) {
          fail(parsed.message);
        } else {
          const merged = mergeExtractedTerms(draftRef.current.terms, parsed.terms);
          setExtracted({ guide: parsed.guide, candidates: parsed.terms, added: merged.added });
        }
      }
    } catch (error) {
      fail(errorMessage(error, "抽出できませんでした。もう一度お試しください。"));
    } finally {
      extractTurnRef.current = null;
      if (mountedRef.current) setExtractTurn(null);
    }
  };

  const stopExtract = async () => {
    const turnId = extractTurnRef.current;
    if (!turnId || !bridge) return;
    stopRequestedRef.current = true;
    try {
      await bridge.stopTurn(turnId);
    } catch (error) {
      setExtractNotice({ message: errorMessage(error, "止められませんでした。") });
    }
  };

  const applyExtracted = () => {
    if (!extracted) return;
    const current = draftRef.current;
    change({ ...current, guide: extracted.guide, terms: mergeExtractedTerms(current.terms, extracted.candidates).terms });
    setExtracted(null);
    // Glossary は初期値だけを読むので、外から置き換えた固有名詞で描き直す
    setGlossaryKey((key) => key + 1);
  };

  // ---- 工程 ----

  const updateStep = (next: Step) => {
    const current = draftRef.current;
    change({ ...current, steps: current.steps.map((step) => (step.id === next.id ? next : step)) });
  };

  const moveTo = (stepId: string, to: number, focus: boolean) => {
    const current = draftRef.current;
    const from = current.steps.findIndex((step) => step.id === stepId);
    if (from < 0 || to < 0 || to >= current.steps.length || to === from) return;
    change({ ...current, steps: moveStep(current.steps, from, to) });
    if (focus) setFocusRequest({ key: `handle:${stepId}` });
  };

  const duplicate = (stepId: string) => {
    const current = draftRef.current;
    const index = current.steps.findIndex((step) => step.id === stepId);
    const step = current.steps[index];
    if (!step) return;
    const copy = duplicateStep(step, newStepId(), current.steps);
    const steps = [...current.steps];
    steps.splice(index + 1, 0, copy);
    change({ ...current, steps });
    setFocusRequest({ key: `name:${copy.id}`, select: true, scroll: true });
  };

  const removeStep = (stepId: string) => {
    const current = draftRef.current;
    change({ ...current, steps: current.steps.filter((step) => step.id !== stepId) });
  };

  const addStep = () => {
    const current = draftRef.current;
    const step = newStep(newStepId(), current.steps);
    change({ ...current, steps: [...current.steps, step] });
    setFocusRequest({ key: `name:${step.id}`, select: true, scroll: true });
  };

  // つまみのドラッグ: 動かすたびに、ほかのカードの中点より下にいくつあるかで位置を決める
  const handleEvents = (stepId: string): HandleEvents => ({
    onKeyDown: (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const index = draftRef.current.steps.findIndex((step) => step.id === stepId);
      moveTo(stepId, index + (event.key === "ArrowUp" ? -1 : 1), true);
    },
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.currentTarget.focus();
      dragRef.current = stepId;
      setDragId(stepId);
    },
    onPointerMove: (event) => {
      if (dragRef.current !== stepId) return;
      const steps = draftRef.current.steps;
      const from = steps.findIndex((step) => step.id === stepId);
      if (from < 0) return;
      let to = 0;
      for (const other of steps) {
        if (other.id === stepId) continue;
        const rect = elements.current.get(`card:${other.id}`)?.getBoundingClientRect();
        if (rect && event.clientY > rect.top + rect.height / 2) to++;
      }
      if (to !== from) change({ ...draftRef.current, steps: moveStep(steps, from, to) });
    },
    onPointerUp: (event) => {
      if (dragRef.current !== stepId) return;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      dragRef.current = null;
      setDragId(null);
    },
    onPointerCancel: () => {
      dragRef.current = null;
      setDragId(null);
    },
  });

  // ---- 保存 ----

  /** 画面の上から見て最初の問題の入力へ移る（名前 → 文書ガイド → 工程）。 */
  const focusFirstIssue = (list: readonly FlowIssue[]) => {
    if (list.some((issue) => issue.code === "empty-flow-name")) {
      setFocusRequest({ key: "flowName", scroll: true });
      return;
    }
    if (list.some((issue) => issue.code === "guide-too-long")) {
      setFocusRequest({ key: "guide", scroll: true });
      return;
    }
    if (list.some((issue) => issue.code === "no-steps")) {
      setFocusRequest({ key: "addstep", scroll: true });
      return;
    }
    const first = list.find((issue) => issue.stepId);
    if (!first?.stepId) return;
    const stepId = first.stepId;
    if (first.code === "empty-instruction") {
      setFocusRequest({ key: `instruction:${stepId}`, scroll: true });
    } else if (first.code === "unknown-profile") {
      setFocusRequest({ key: `profile:${stepId}`, scroll: true });
    } else {
      setFocusRequest({ key: `name:${stepId}`, scroll: true });
    }
  };

  const save = async () => {
    if (saving) return;
    setSaveError(null);
    if (issues.length > 0) {
      setBlocked(true);
      focusFirstIssue(issues);
      return;
    }
    setSaving(true);
    try {
      await props.onSave({ ...draft, name: draft.name.trim(), terms: cleanGlossary(draft.terms) });
      // 保存で空の行を落とした固有名詞で描き直す
      if (mountedRef.current) setGlossaryKey((key) => key + 1);
    } catch (error) {
      if (mountedRef.current) setSaveError(errorMessage(error, "保存できませんでした。もう一度お試しください。"));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  // ---- 描画 ----

  const nameIssues = issues.filter((issue) => issue.code === "empty-flow-name");
  const guideIssues = issues.filter((issue) => issue.code === "guide-too-long");
  const guideChars = countChars(draft.guide);
  const guideOver = guideChars > GUIDE_MAX_CHARS;
  const dirty = !sameFlowContent(draft, props.flow);
  const extracting = extractTurn !== null;
  const over = dropOver && props.dropEnabled;
  const deleting = confirm ? draft.steps.find((step) => step.id === confirm.stepId) : undefined;

  return (
    <div className="page">
      <div className="narrow">
        <div className="phead">
          <h1>工程設計</h1>
          <div className="sp" />
          <button type="button" className="btn primary" disabled={!dirty || saving || props.disabled || importBusy} onClick={() => void save()}>
            保存
          </button>
        </div>
        {blocked && issues.length > 0 && (
          <p className="err save-err" role="alert">
            {SAVE_BLOCKED}
          </p>
        )}
        {saveError && dirty && (
          <p className="err save-err" role="alert">
            {saveError}
          </p>
        )}
        {props.list}
        <fieldset disabled={props.disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="flowname">
          <input
            ref={(element) => register("flowName", element)}
            className="inp"
            aria-label="名前"
            aria-invalid={nameIssues.length > 0 || undefined}
            value={draft.name}
            onChange={(event) => change({ ...draftRef.current, name: event.target.value })}
          />
          <span className="cnt">{draft.steps.length + 1} 工程</span>
        </div>
        <IssueList issues={nameIssues} />

        <div className="gcard">
          <div className="gh">
            <h2>文書ガイド</h2>
            {extracting ? (
              <>
                <span className="busy" role="status">
                  <span className="spin" />
                  抽出しています…
                </span>
                <button type="button" className="btn stop sm" onClick={() => void stopExtract()}>
                  止める
                </button>
              </>
            ) : bridge && settings ? (
              <button
                type="button"
                className="btn outline sm"
                disabled={draft.samples.length === 0 || importBusy}
                onClick={() => void extract()}
              >
                お手本から抽出
              </button>
            ) : <p className="help">お手本からのAI抽出はMacアプリで使えます。ガイドはここで編集できます。</p>}
          </div>
          {extractNotice && (
            <p className="err gerr" role="alert">
              {extractNotice.message}
              {extractNotice.settings && (
                <>
                  {" "}
                  <button type="button" className="link" onClick={props.onOpenSettings}>
                    設定で変更
                  </button>
                </>
              )}
            </p>
          )}
          <div className="grow">
            <span className="label">お手本の文書</span>
            <div>
              <div className={`files${over ? " over" : ""}`}>
                {draft.samples.map((sample) => (
                  <SampleRow key={sample.id} sample={sample} onRemove={() => removeSample(sample.id)} onRead={() => sampleAccess ? sampleAccess.readSample(draft.id, sample.id) : Promise.reject(new Error("本文を開けませんでした。"))} />
                ))}
                {over && <div className="dropnote">ここにドロップして追加</div>}
                <div className="acts">
                  <button type="button" className="link" disabled={importBusy || !sampleAccess} onClick={() => void pickSamples()}>
                    ＋ 文書を追加
                  </button>
                  {importBusy && (
                    <span className="busy" role="status">
                      <span className="spin" />
                      取り込んでいます…
                    </span>
                  )}
                </div>
                {bridge && draft.samples.length === 0 && !importing && (
                  <p className="help">お手本の文書を1本以上追加すると、文書ガイドを抽出できます。</p>
                )}
              </div>
              {bridge ? <form className="sample-url" onSubmit={(event) => { event.preventDefault(); void importUrl(); }}>
                <label htmlFor={`${countId}-url`}>記事 URL</label>
                <div className="sample-url-input">
                  <input
                    id={`${countId}-url`}
                    type="url"
                    className="inp"
                    aria-label="記事 URL"
                    placeholder="https://…"
                    value={sampleUrl}
                    disabled={importBusy}
                    onChange={(event) => setSampleUrl(event.target.value)}
                  />
                  <button type="submit" className="btn outline sm" disabled={importBusy || !sampleUrl.trim()}>URL から取り込む</button>
                </div>
              </form> : <p className="help">PDF・Word・記事URLの取り込みはMacアプリで使えます。</p>}
              {importSuccess && <p className="msg" role="status">{importSuccess}</p>}
              {importErrors.length > 0 && (
                <div className="ferr" role="alert">
                  {importErrors.map((message, index) => (
                    <p key={`${index}-${message}`} className="err">
                      {message}
                    </p>
                  ))}
                </div>
              )}
            </div>
            <span className="label">ガイド</span>
            <div className="instr-wrap">
              <textarea
                ref={(element) => {
                  guideArea.current = element;
                  register("guide", element);
                }}
                className="ta grow"
                aria-label="ガイド"
                aria-describedby={countId}
                aria-invalid={guideOver || undefined}
                placeholder="お手本の文書を入れて抽出するか、ここに直接書きます"
                value={draft.guide}
                onChange={(event) => change({ ...draftRef.current, guide: event.target.value })}
              />
              <div className="gfoot">
                <span id={countId} className={`gcount${guideOver ? " over" : ""}`}>
                  {formatNumber(guideChars)} / {formatNumber(GUIDE_MAX_CHARS)} 字{guideOver ? " · 上限を超えています" : ""}
                </span>
              </div>
              <IssueList issues={guideIssues} />
            </div>
            <span className="label">固有名詞</span>
            <Glossary key={glossaryKey} entries={draft.terms} onChange={(terms) => change({ ...draftRef.current, terms })} />
          </div>
        </div>

        <div className="scard fixed">
          <div className="top">
            <span className="hd" aria-hidden="true" />
            <span className="num">1</span>
            <input className="inp" value="文字起こし" readOnly aria-label="工程の名前" />
          </div>
          <div className="body">
            <span className="label">エンジン</span>
            <div className="row">
              <span>
                {settings ? `${engineLabel(effectiveEngine(settings))} · ${languageLabel(settings.transcription.language)}` : "録音するときの設定を使います"}
              </span>
              {settings && props.onOpenSettings && <button type="button" className="link" onClick={props.onOpenSettings}>
                設定で変更
              </button>}
            </div>
          </div>
        </div>
        {draft.steps.length === 0 ? (
          <div className="gempty steps-empty">工程がありません。「＋ 工程を追加」で文字起こしの次の工程を作ります。</div>
        ) : (
          draft.steps.map((step, index) => (
            <StepCard
              key={step.id}
              step={step}
              index={index}
              count={draft.steps.length}
              issues={stepIssues(issues, step.id)}
              dragging={dragId === step.id}
              profiles={profiles}
              providers={providers}
              native={Boolean(settings)}
              handle={handleEvents(step.id)}
              register={register}
              onChange={updateStep}
              onMove={(to) => moveTo(step.id, to, true)}
              onDuplicate={() => duplicate(step.id)}
              onDelete={() => setConfirm({ kind: "delete", stepId: step.id })}
            />
          ))
        )}
        <button ref={(element) => register("addstep", element)} type="button" className="addstep" onClick={addStep}>
          ＋ 工程を追加
        </button>
        </fieldset>
      </div>

      {extracted && (
        <ConfirmDialog
          title="お手本から抽出したガイド"
          wide
          confirmLabel={draft.guide.trim() ? "置き換える" : "ガイドに入れる"}
          onConfirm={applyExtracted}
          onCancel={() => setExtracted(null)}
        >
          <p className="msg">
            {formatChars(countChars(extracted.guide))} · 固有名詞 +{extracted.added} 語（今の一覧にある語は足しません）
          </p>
          {extracted.added > 0 && (
            <ul className="difflist" aria-label="追加する固有名詞">
              {mergeExtractedTerms(draft.terms, extracted.candidates).terms.slice(draft.terms.length).map((entry) => (
                <li key={entry.term}>{entry.term}{entry.reading ? `（${entry.reading}）` : ""}</li>
              ))}
            </ul>
          )}
          {draft.guide.trim() && <p className="msg">今のガイドは置き換わります。保存するまでファイルは変わりません。</p>}
          <div className="guide-preview" tabIndex={0} aria-label="抽出したガイド">
            {extracted.guide}
          </div>
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={`「${stepLabel(deleting)}」を削除しますか`}
          confirmLabel="削除する"
          danger
          onConfirm={() => {
            removeStep(deleting.id);
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        >
          <p className="msg">この工程の名前と指示文を消します。保存するまでファイルは変わりません。作成済みの録音から作ったページは消えません。</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
