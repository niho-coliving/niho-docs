"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  FLOW_CHOICE_LABEL,
  LANGUAGES,
  RECORDING_FIELD_LABELS,
  RECORDING_REF_WORDS,
  ROOT_RECORDING_ID,
  RUN_PLACE_CHANGE_LABEL,
  RUN_START_LABELS,
  SOURCE_STEP_ID,
  SPEAKER_MODES,
  addRecordingRef,
  buildFlowChoices,
  countChars,
  languageLabel,
  pageTitle,
  recordingRefOpenLabel,
  recordingRefRemoveLabel,
  recordingRefView,
  removeRecordingRef,
  runStartActions,
  speakerLabel,
  staleNoticeText,
  type AudioInput,
  type Flow,
  type FlowChoiceOption,
  type Language,
  type ProjectSource,
  type Recording,
  type RunRecord,
  type RunStartAction,
  type SpeakerMode,
} from "@niho/docs-core";
import { errorMessage, type AudioInfo, type Bridge, type RecordingRef } from "../lib/bridge";
import { formatAudioLength, formatChars, formatDateTime } from "../lib/format";
import { hasMaterial, recordingRef, rerunQueueOf, saveRecordingChange, stepMarkdown, type RecordingView } from "../lib/project-view";
import { candidateChoiceReason, runGate, type RunGate } from "../lib/run-gate";
import { runIsOn, type ActiveRun, type RunNotice } from "../lib/run-state";
import type { ChatController } from "../lib/use-chat";
import type { PersonalNihoConfirmAction, PersonalNihoPending } from "../lib/bridge";
import { ChatPanel } from "./ChatPanel";
import { DocsWorkLayout } from "./DocsComposerRail";
import { RunGateNote, RunningBand } from "./RunBand";
import { AudioPlaybackBar } from "./AudioPlaybackBar";
import { ConfirmDialog } from "./ConfirmDialog";
import { ChevronIcon, CloseIcon, DocIcon, FlowIcon, LanguageIcon, LinkIcon, MicIcon, PeopleIcon, PlusIcon } from "./icons";
import { PageTitle, type TitleCommit } from "./PageTitle";
import { usePopover } from "./usePopover";

/**
 * 録音の素材・props・実行操作は `RecordingControls` に集約する。空の音声欄はファイル選択と Mac 録音を案内し、
 * フォルダ外の既存録音はタイトル・成果物・実行帯を持つ `RecordingPage` で開く。フォルダ内に録音ページは作らない。
 */

/** 録音の素材を書き換えて保存する（読み直した値に当てる。project-view の saveRecordingChange）。 */
export function saveRecordingSource(bridge: Bridge, rec: RecordingRef, change: (source: ProjectSource) => ProjectSource): Promise<void> {
  return saveRecordingChange(bridge, rec, (recording) => ({ ...recording, source: change(recording.source) }));
}

/** 参考に選べる文書のページ（同じ案件。名前は画面の名前）。 */
export type DocChoice = { id: string; title: string };

/** 参考の「＋ ページ」（まだ付けていない文書のページのメニュー）。 */
function AddRefMenu(props: { choices: DocChoice[]; disabled: boolean; onAdd: (pageId: string) => void }) {
  const menu = usePopover();
  return (
    <div ref={menu.ref} className="addref">
      <button
        type="button"
        className="addchip"
        aria-label={RECORDING_REF_WORDS.addLabel}
        aria-expanded={menu.open}
        disabled={props.disabled}
        onClick={menu.toggle}
      >
        <PlusIcon />
        {RECORDING_REF_WORDS.add}
      </button>
      {menu.open && (
        <div className="pop" role="menu" aria-label={RECORDING_REF_WORDS.menuLabel}>
          {props.choices.map((choice) => (
            <button
              type="button"
              key={choice.id}
              className="mi"
              role="menuitem"
              title={choice.title}
              onClick={() => {
                menu.setOpen(false);
                props.onAdd(choice.id);
              }}
            >
              <DocIcon />
              <span>{choice.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function audioOf(source: ProjectSource): AudioInput[] {
  return source.kind === "audio" ? source.audio : [];
}

function AudioRow(props: {
  audio: AudioInput;
  first: boolean;
  last: boolean;
  disabled: boolean;
  /** NIHO クラウドの添え書き（取得中・上げている・期限切れ）。 */
  note?: string | null;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const menu = usePopover();
  return (
    <div className={`afile${props.note ? " noted" : ""}`} ref={menu.ref}>
      <span className="ic">♪</span>
      <span className="nm">{props.audio.name}</span>
      <span className="d">{props.audio.durationSec !== null ? formatAudioLength(props.audio.durationSec) : ""}</span>
      {props.note && <span className="anote">{props.note}</span>}
      <button type="button" className="ibtn sm" title="その他" aria-label={`${props.audio.name}のその他`} onClick={menu.toggle} disabled={props.disabled}>
        ⋯
      </button>
      {menu.open && (
        <div className="pop" role="menu">
          <button type="button" className="mi" role="menuitem" disabled={props.disabled || props.first} onClick={() => (menu.setOpen(false), props.onMove(-1))}>
            上へ移動
          </button>
          <button type="button" className="mi" role="menuitem" disabled={props.disabled || props.last} onClick={() => (menu.setOpen(false), props.onMove(1))}>
            下へ移動
          </button>
          <button type="button" className="mi danger" role="menuitem" disabled={props.disabled} onClick={() => (menu.setOpen(false), props.onRemove())}>
            解除
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 音声の欄の空の形（ドロップ枠と「ファイルを選択」「この Mac で録音」）。音声がまだ無いフォルダの背景情報のページ
 * （押すとフォルダの録音を作ってから続ける）と、素材の無い録音で同じ部品を使う。
 */
export function AudioEmpty(props: {
  dropOver?: boolean;
  disabled: boolean;
  recordDisabled: boolean;
  onPick: () => void;
  onRecord: () => void;
}) {
  return (
    <div className={`drop${props.dropOver ? " over" : ""}`}>
      <span>音声ファイルをここにドロップ</span>
      <div className="row">
        <button type="button" className="btn outline sm" disabled={props.disabled} onClick={props.onPick}>
          ファイルを選択
        </button>
        <button type="button" className="btn outline sm" disabled={props.recordDisabled} onClick={props.onRecord}>
          この Mac で録音
        </button>
      </div>
    </div>
  );
}

/** 録音の操作（素材・props の表・実行の帯）。フォルダの背景情報のページの「音声」と、フォルダの外の録音のページで使う。 */
export type RecordingControlsProps = {
  bridge: Bridge;
  recording: { active: boolean; saving: boolean; start: () => void };
  view: RecordingView;
  /** 同じ案件の文書のページ（並びは pages の順。参考のチップとメニュー）。 */
  docPages: DocChoice[];
  /** 参考のチップを押したとき（その文書のページを開く）。 */
  onOpenPage: (pageId: string) => void;
  /** 実行中の工程（どの案件でも 1 つ）。 */
  activeRun: ActiveRun | null;
  notice: RunNotice | null;
  /** ほかのフォルダ（かフォルダの外）が実行中で押せないときに、対象の名前を含めて案内する。 */
  blockedReason: string | null;
  /**
   * 実行の前に分かる準備の不足（工程の AI が未導入・未ログイン、音声モデルが未取得。run-readiness）を、実行する工程ごとに返す。
   * 2 つ目は始め方（続きの場所で、準備を確かめる工程が変わる。#18947）か、単独の工程（true）。
   */
  setupReasonFor: (queue: readonly string[], mode?: boolean | RunStartAction) => string | null;
  /** 準備の不足を直す・続きの場所を変える設定の画面を開く。 */
  onOpenSettings: () => void;
  /** 「AIと作る」の依頼がこの場所で動いている（実行のロックはフォルダ・フォルダの外の単位）。 */
  chatBusy: boolean;
  /** フォルダ画面から工程設計へ移る。 */
  onOpenFlowDesign?: () => void;
  /** 保存中の録音ページを移動できないよう、編集状態を親へ知らせる。 */
  onDropBlockedChange?: (blocked: boolean) => void;
  /** 文書を保存中の操作を止める。 */
  saving: boolean;
  /** ダイアログが無く、このページを出している（Finder からのドロップを受ける）。 */
  dropEnabled: boolean;
  /** 工程設計が変わった・登録していない AI の工程があるときだけ。 */
  flowUpdate: { unregistered: boolean; disabled: boolean; onUpdate: () => void } | null;
  /**
   * 「工程」の選択（#18883。並び・テンプレートの出し分け・選べない理由は Web/PWA と同じ docs-core の buildFlowChoices）。値は
   * あなたの工程なら flow の id、テンプレートなら `template:<id>`（選ぶと App が新しいフローとして保存してから付ける）。選択後の確認と
   * snapshot の更新は App が行う。
   */
  flowChoice: { flows: readonly Flow[]; pending: string | null; onChange: (value: string) => void };
  /** 始め方のボタンを押した（queue は残りの工程・原文だけ・すべて再実行の工程）。 */
  onRun: (queue: string[], action: RunStartAction) => void;
  onStop: () => void;
  /** 素材を変えた後に読み直す。 */
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
  /** 音声の行の添え書き（NIHO クラウドの取得中・期限切れ。C3 #18595）。 */
  audioNote?: (file: string) => string | null;
  /** 別の Mac が実行中の理由（実行の帯に出し、実行を押せなくする）。 */
  leaseNote?: string | null;
  /**
   * 始め方（#18947。何をするかはこのページのボタン、続きをどこで作るかは設定）: 帯の左の場所の 1 行と、始め方ごとの押せない理由
   * （クラウドが受けない続き・音声の無い文字起こし。setup は設定で直せる）。
   */
  start: { placeLine: string; note?: string | null; reasonFor: (action: RunStartAction) => RunGate | null };
  pendingNiho: PersonalNihoPending | null;
  onConfirmPendingNiho: (action: PersonalNihoConfirmAction) => void;
  /** props の表と実行の帯の間に置くもの（フォルダの外の録音のページの「この録音から作ったページ」の列）。 */
  outputs?: ReactNode;
};

export function RecordingControls(props: RecordingControlsProps) {
  const { bridge, view, activeRun } = props;
  const rec = recordingRef(view);
  const source = view.recording.source;
  const audio = audioOf(source);
  const runningHere = runIsOn(activeRun, view);
  // 実行中（同じフォルダかフォルダの外）は素材を変えない（文字起こしが写しを読んでいるかもしれない）
  const locked =
    (activeRun !== null && activeRun.projectId === view.projectId) || props.flowChoice.pending !== null || props.chatBusy || props.saving;
  const [busy, setBusy] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  /** 外す前に確かめる音声（アプリに写したファイルも消えるため）。 */
  const [removing, setRemoving] = useState<AudioInput | null>(null);
  /** 保存中の話者人数・言語（読み直すまで選んだ値を出す）。 */
  const [pending, setPending] = useState<{ speakers?: SpeakerMode; language?: Language }>({});
  const busyRef = useRef(false);
  const hostRef = useRef(props);
  hostRef.current = props;

  const change = async (work: () => Promise<void>): Promise<boolean> => {
    if (busyRef.current || locked) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
      await hostRef.current.onChanged();
      return true;
    } catch (error) {
      hostRef.current.onError(errorMessage(error, "保存できませんでした。"));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const addAudio = (infos: AudioInfo[]) => {
    if (infos.length === 0) {
      props.onError("音声ファイルではありません。");
      return;
    }
    void change(async () => { await appendAudio(bridge, rec, infos, audio.map((item) => item.file)); });
  };
  const addAudioRef = useRef(addAudio);
  addAudioRef.current = addAudio;
  const recording = props.recording;
  const recordingBusy = recording.active || recording.saving;

  useEffect(() => {
    props.onDropBlockedChange?.(busy || removing !== null || recordingBusy);
    return () => props.onDropBlockedChange?.(false);
  }, [busy, props.onDropBlockedChange, recordingBusy, removing]);

  const pick = async () => {
    try {
      const picked = await bridge.pickAudioFiles();
      if (picked.length > 0) addAudio(picked);
    } catch (error) {
      props.onError(errorMessage(error, "音声を選べませんでした。"));
    }
  };

  const moveAudio = (file: string, delta: -1 | 1) =>
    void change(() =>
      saveRecordingSource(bridge, rec, (current) => {
        if (current.kind !== "audio") return current;
        const next = [...current.audio];
        const index = next.findIndex((item) => item.file === file);
        const item = next[index];
        const other = next[index + delta];
        if (!item || !other) return current;
        next[index] = other;
        next[index + delta] = item;
        return { kind: "audio", audio: next };
      }),
    );

  const removeAudio = (file: string) =>
    void change(() =>
      saveRecordingSource(bridge, rec, (current) =>
        current.kind === "audio" ? { kind: "audio", audio: current.audio.filter((item) => item.file !== file) } : current,
      ),
    );

  // 話者人数・言語・参考はその場で保存する（読み直した録音に当てる）
  const saveRecording = (edit: (recording: Recording) => Recording) => change(() => saveRecordingChange(bridge, rec, edit));
  const changeSpeakers = (speakers: SpeakerMode) => {
    setPending((all) => ({ ...all, speakers }));
    void saveRecording((recording) => ({ ...recording, speakers })).finally(() => setPending({}));
  };
  const changeLanguage = (language: Language) => {
    setPending((all) => ({ ...all, language }));
    void saveRecording((recording) => ({ ...recording, language })).finally(() => setPending({}));
  };
  const addRef = (pageId: string) =>
    void saveRecording((recording) => ({ ...recording, refs: addRecordingRef(recording.refs, pageId) }));
  const removeRef = (pageId: string) =>
    void saveRecording((recording) => ({ ...recording, refs: removeRecordingRef(recording.refs, pageId) }));

  // Finder からのドロップ（音声の録音で、このページを出していてダイアログが無いときだけ）
  const acceptDrop = props.dropEnabled && source.kind === "audio" && !recordingBusy;
  useEffect(() => {
    if (!acceptDrop || !bridge.onFileDrop) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void bridge
      .onFileDrop(
        (paths) => {
          setDropOver(false);
          bridge.audioInfo(paths).then(
            (infos) => addAudioRef.current(infos),
            () => hostRef.current.onError("音声を読めませんでした。"),
          );
        },
        (over) => setDropOver(over),
      )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      unlisten?.();
      setDropOver(false);
    };
  }, [bridge, acceptDrop]);

  const plan = view.plan;
  const material = hasMaterial(view);
  const speakers = pending.speakers ?? view.recording.speakers;
  const language = pending.language ?? view.recording.language;
  // 工程の選択肢: あなたの工程（フローの並び）とテンプレート（手を加えていない写しを持っているものは出さない）。snapshot の元の
  // フローが一覧に無いときは、工程がまだ無い（工程が 0 本のときに作った録音の白紙の snapshot）なら事実どおりに、工程があれば
  // 削除済みのフローの名前を残す。
  const choices = buildFlowChoices(props.flowChoice.flows);
  const flowMissing = !props.flowChoice.flows.some((flow) => flow.id === view.flow.id);
  const flowValue = props.flowChoice.pending ?? view.flow.id;
  const optionValue = (option: FlowChoiceOption) => (option.kind === "flow" ? option.id : option.key);
  const flowLabel = (option: FlowChoiceOption) => (option.problem ? `${option.name}（${option.problem}）` : option.name);
  const missingLabel = view.flow.steps.length === 0
    ? "工程がまだありません"
    : `${view.flow.name}（${view.flow.id.startsWith("remote_") ? "この録音だけの工程" : "工程設計から削除済み"}）`;
  const selectedChoice = choices.options.find((option) => optionValue(option) === flowValue);
  const flowTitle = selectedChoice ? flowLabel(selectedChoice) : missingLabel;
  const needsFlow = view.flow.steps.length === 0;
  // 参考のチップ（付けた順。文書の名前は画面の名前）と、まだ付けていない文書（docs-core の recordingRefView）
  const { chips: refs, choices: refChoices, empty: refsEmpty } = recordingRefView(props.docPages, view.recording.refs);
  // すべて再実行: 音声があれば工程 1 から、文章（と音声の無い録音）は工程 2 から
  const rerunQueue = rerunQueueOf(view);
  const doneAt = view.runs
    .filter((record) => typeof record.version === "number")
    .reduce<string | null>((latest, record) => (latest === null || record.at > latest ? record.at : latest), null);
  const notice = props.notice && runIsOn(props.notice, view) ? props.notice : null;

  // 始め方（#18947）: 原文がまだ無ければ「文書作成を開始」と控えめな「文字起こしだけ」、原文の後は「続きを作成」、残りが無ければ
  // 「すべて再実行」。素材が無いうちも同じ 2 つを押せない形で出す
  const sourceDone = plan.steps.some((step) => step.stepId === SOURCE_STEP_ID && step.done);
  const actions = runStartActions({ sourceDone, remaining: plan.remaining.length });
  const queueOf = (action: RunStartAction): string[] =>
    action === "transcribeOnly" ? [SOURCE_STEP_ID] : action === "rerunAll" ? rerunQueue : plan.remaining;
  // 押せない理由は、録音から作ったページの帯と同じ判定（run-gate）で、始め方ごとに出す。押してから失敗する経路（別の Mac の実行・
  // 別案の未選択）を作らない。「文字起こしだけ」は文字起こしに関わる理由（素材・別の録音の実行・AIと作る・別の Mac・音声モデル）で
  // だけ止め、続きの AI の準備不足やクラウドの決まりでは止めない
  const gateFor = (action: RunStartAction) => {
    const queue = queueOf(action);
    return runGate({
      material,
      activeRun,
      recording: view,
      blockedReason: props.blockedReason,
      chatBusy: props.chatBusy,
      leaseNote: props.leaseNote ?? null,
      candidateReason: action === "transcribeOnly" ? null : candidateChoiceReason({ recording: view.recording, flow: view.flow, queue }),
      executionReason: props.start.reasonFor(action),
      setupReason: props.setupReasonFor(queue, action),
    });
  };

  let runbar;
  if (runningHere && activeRun) {
    runbar = <RunningBand stepName={activeRun.stepName} stopRequested={activeRun.stopRequested} onStop={props.onStop} />;
  } else if (actions.primary === "rerunAll") {
    const gate = gateFor("rerunAll");
    runbar = (
      <>
        {gate ? (
          // 完了後の再実行も、工程の実行と同じ理由で止める（準備の不足は直す場所へ移れる）
          <RunGateNote gate={gate} onOpenSettings={props.onOpenSettings} />
        ) : (
          <span className="note">{doneAt ? `${formatDateTime(doneAt)} に完了` : "完了"}</span>
        )}
        <span className="sp" />
        <button type="button" className="btn outline sm" disabled={rerunQueue.length === 0 || gate !== null || props.saving} onClick={() => props.onRun(rerunQueue, "rerunAll")}>
          {RUN_START_LABELS.rerunAll}
        </button>
      </>
    );
  } else {
    const { primary, secondary } = actions;
    const gate = gateFor(primary);
    const secondaryGate = secondary ? gateFor(secondary) : null;
    runbar = (
      <>
        {gate ? (
          <RunGateNote gate={gate} onOpenSettings={props.onOpenSettings} />
        ) : (
          // 場所はページでは選ばせず、1 行と設定への導線だけ出す
          <span className="note">
            {props.start.placeLine}
            <button type="button" className="link" onClick={props.onOpenSettings}>
              {RUN_PLACE_CHANGE_LABEL}
            </button>
          </span>
        )}
        <span className="sp" />
        {secondary && (
          <button
            type="button"
            className="link runalt"
            disabled={secondaryGate !== null || props.saving}
            onClick={() => props.onRun(queueOf(secondary), secondary)}
          >
            {RUN_START_LABELS[secondary]}
          </button>
        )}
        <button type="button" className="btn primary" disabled={gate !== null || props.saving} onClick={() => props.onRun(queueOf(primary), primary)}>
          {RUN_START_LABELS[primary]}
        </button>
      </>
    );
  }

  return (
    <>
      {source.kind === "audio" && audio.length > 0 && (
        <AudioPlaybackBar bridge={bridge} recording={rec} audio={audio} />
      )}

      {source.kind === "text" ? (
        <div className="afiles">
          <div className="afile">
            <span className="ic">▤</span>
            <span className="nm">{`文章 · ${formatChars(countChars(view.source))}`}</span>
          </div>
        </div>
      ) : (
        <>
          {audio.length === 0 ? (
            !recordingBusy && (
              <AudioEmpty
                dropOver={dropOver}
                disabled={busy || locked}
                recordDisabled={bridge.capabilities?.nativeRecording === false || recordingBusy || locked || busy}
                onPick={() => void pick()}
                onRecord={recording.start}
              />
            )
          ) : (
            <>
              <div className={`afiles${dropOver ? " over" : ""}`}>
                {audio.map((item, index) => (
                  <AudioRow
                    key={item.file}
                    audio={item}
                    first={index === 0}
                    last={index === audio.length - 1}
                    disabled={busy || locked || recordingBusy}
                    note={props.audioNote?.(item.file) ?? null}
                    onMove={(delta) => moveAudio(item.file, delta)}
                    onRemove={() => setRemoving(item)}
                  />
                ))}
              </div>
              {!recordingBusy && (
                <div className="row">
                  <button type="button" className="addaudio link" disabled={busy || locked} onClick={() => void pick()}>
                    ＋ 音声を追加
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      <div className="props">
        <label className="k" htmlFor="rec-speakers">
          <PeopleIcon />
          {RECORDING_FIELD_LABELS.speakers}
        </label>
        <div className="v">
          <select
            id="rec-speakers"
            className="sel sm"
            value={speakers}
            disabled={busy || locked}
            onChange={(event) => changeSpeakers(event.target.value as SpeakerMode)}
          >
            {SPEAKER_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {speakerLabel(mode)}
              </option>
            ))}
          </select>
        </div>
        <label className="k" htmlFor="rec-language">
          <LanguageIcon />
          {RECORDING_FIELD_LABELS.language}
        </label>
        <div className="v">
          <select
            id="rec-language"
            className="sel sm"
            value={language}
            disabled={busy || locked}
            onChange={(event) => changeLanguage(event.target.value as Language)}
          >
            {LANGUAGES.map((item) => (
              <option key={item} value={item}>
                {languageLabel(item)}
              </option>
            ))}
          </select>
        </div>
        <span className="k">
          <LinkIcon />
          {RECORDING_FIELD_LABELS.refs}
        </span>
        <div className="v refs">
          {refs.map((ref) => (
            <span className="chip" key={ref.id}>
              <button type="button" className="go" title={recordingRefOpenLabel(ref.title)} onClick={() => props.onOpenPage(ref.id)}>
                <DocIcon />
                <span>{ref.title}</span>
              </button>
              <button type="button" className="x" aria-label={recordingRefRemoveLabel(ref.title)} disabled={busy || locked} onClick={() => removeRef(ref.id)}>
                <CloseIcon />
              </button>
            </span>
          ))}
          {refChoices.length > 0 && <AddRefMenu choices={refChoices} disabled={busy || locked} onAdd={addRef} />}
          {refsEmpty && <span className="help">{RECORDING_REF_WORDS.empty}</span>}
        </div>
        <label className="k" htmlFor="rec-flow">
          <FlowIcon />
          {FLOW_CHOICE_LABEL}
        </label>
        <div className="v">
          <select
            id="rec-flow"
            className="sel sm"
            aria-label={FLOW_CHOICE_LABEL}
            value={flowValue}
            title={flowTitle}
            disabled={busy || locked}
            onChange={(event) => {
              if (!props.chatBusy) props.flowChoice.onChange(event.target.value);
            }}
          >
            {flowMissing && <option value={view.flow.id}>{missingLabel}</option>}
            {choices.groups.map(
              (group) =>
                group.options.length > 0 && (
                  <optgroup key={group.kind} label={group.label}>
                    {group.options.map((option) => (
                      <option
                        key={option.key}
                        value={optionValue(option)}
                        disabled={option.problem !== null && optionValue(option) !== view.flow.id}
                      >
                        {flowLabel(option)}
                      </option>
                    ))}
                  </optgroup>
                ),
            )}
          </select>
          {needsFlow && props.onOpenFlowDesign && (
            <button type="button" className="link" onClick={props.onOpenFlowDesign}>
              工程設計で作る
            </button>
          )}
        </div>
      </div>

      {props.outputs}

      {props.flowUpdate && (
        <div className="flownote">
          <span>{props.flowUpdate.unregistered ? "登録していない AI の工程があります" : "工程設計が変わりました"}</span>
          <button type="button" className="link" disabled={props.flowUpdate.disabled} onClick={props.flowUpdate.onUpdate}>
            この録音の工程を今の設計に更新
          </button>
        </div>
      )}
      {props.pendingNiho && (
        <div className="flownote" role="alert">
          <span>クラウドの受付結果を確認できません。自動では送り直しません。</span>
          <div className="row">
            <button type="button" className="link" disabled={activeRun !== null} onClick={() => props.onConfirmPendingNiho("lookup")}>受付を照会</button>
            <button type="button" className="link" disabled={activeRun !== null} onClick={() => props.onConfirmPendingNiho("resend")}>同じ内容で再送</button>
            <button type="button" className="link" disabled={activeRun !== null} onClick={() => props.onConfirmPendingNiho("release")}>未受付を確認</button>
          </div>
        </div>
      )}
      <div className="runbar">{runbar}</div>
      {props.start.note && <p className="model-swap-note">{props.start.note}</p>}
      {notice && <p className={`runnotice ${notice.kind === "failed" ? "err" : "help"}`}>{notice.message}</p>}
      {removing && (
        <ConfirmDialog
          title={`「${removing.name}」を外しますか`}
          confirmLabel="外す"
          danger
          busy={busy || locked || recordingBusy}
          onConfirm={() => {
            const file = removing.file;
            setRemoving(null);
            removeAudio(file);
          }}
          onCancel={() => setRemoving(null)}
        >
          <p className="msg">この録音から音声を外します。アプリに写した音声のファイルも消えます（元のファイルはそのままです）。</p>
        </ConfirmDialog>
      )}
    </>
  );
}

/** 録音に音声を足す（写してから、読み直した素材の後ろへ。`keep` は今の音声の file）。窓へのドロップ・「＋ 音声を追加」・背景情報のページで共通。 */
export async function appendAudio(bridge: Bridge, rec: RecordingRef, infos: readonly AudioInfo[], keep: readonly string[]): Promise<AudioInput[]> {
  const imported = await bridge.importAudio(rec, infos.map((info) => info.path), [...keep], infos.map((info) => info.name));
  await saveRecordingSource(bridge, rec, (current) =>
    current.kind === "audio" ? { kind: "audio", audio: [...current.audio, ...imported] } : current,
  );
  return imported;
}

/** 「AIと作る」の右の列（録音の会話。フォルダの背景情報のページとフォルダの外の録音のページで同じ）。 */
export function RecordingChatColumn(props: {
  view: RecordingView;
  activeRun: ActiveRun | null;
  chat: ChatController;
  loadPartial: (runId: string) => Promise<string | null>;
  chatBusy: boolean;
  saving: boolean;
  leaseNote?: string | null;
  setupReasonFor: (queue: readonly string[], explicit?: boolean) => string | null;
  onRunStep: (stepId: string) => void;
}) {
  const { view, activeRun } = props;
  const runningHere = runIsOn(activeRun, view);
  const runningInProject = activeRun !== null && activeRun.projectId === view.projectId && !runningHere;
  // 別の工程で実行を押せない理由（入力欄の「＋ → 工程を実行」。1 工程ずつ見る）
  const stepRunReason = (stepId: string): string | null =>
    candidateChoiceReason({ recording: view.recording, flow: view.flow, queue: [stepId] }) ?? props.setupReasonFor([stepId], true);
  return (
    <div className="col">
      <ChatPanel
        view={view}
        activeRun={runningHere ? activeRun : null}
        projectRunning={runningInProject}
        chat={props.chat}
        loadPartial={props.loadPartial}
        runBlocked={activeRun !== null || props.chatBusy || props.saving || Boolean(props.leaseNote)}
        stepRunReason={stepRunReason}
        saving={props.saving}
        onRunStep={props.onRunStep}
      />
    </div>
  );
}

export type RecordingPageProps = RecordingControlsProps & {
  /** 表示中の名前（打ちかけを含む）。 */
  title: string;
  focusTitle: boolean;
  onTitleFocused: () => void;
  onTitleInput: (title: string) => void;
  onTitleCommit: TitleCommit;
  onRunStep: (stepId: string) => void;
  onOpenStep: (stepId: string) => void;
  chat: ChatController;
  chatOpen: boolean;
  loadPartial: (runId: string) => Promise<string | null>;
};

/**
 * フォルダの外の録音のページ（以前のデータ。#18914 からはフォルダの外に録音を作らない）: タイトル・メタ行・録音の操作・作ったページの列。
 * 右に「AIと作る」（上の帯のボタンで開閉）。
 */
export function RecordingPage(props: RecordingPageProps) {
  const { view, activeRun } = props;
  const source = view.recording.source;
  const runningHere = runIsOn(activeRun, view);
  const outputs = (
    <>
      <div className="sec">この録音から作ったページ</div>
      <div className="orows">
        {view.plan.steps.map((step) => {
          const running = runningHere && activeRun?.stepId === step.stepId;
          const markdown = stepMarkdown(view, step.stepId);
          // 元にした内容が変わったページは、字数の代わりにページの本文の上と同じ 1 行の文（「前提変更」のピルは出さない。#18915）
          const staleText = step.stale && !running ? staleNoticeText(step.staleReasons, source.kind === "text" ? "text" : "audio") : null;
          const detail = running ? "実行中…" : step.done ? staleText ?? formatChars(countChars(markdown ?? "")) : "未作成";
          return (
            <button
              type="button"
              key={step.stepId}
              className={`orow${running ? " running" : ""}`}
              disabled={!step.done && !running}
              onClick={() => props.onOpenStep(step.stepId)}
            >
              <span className="n">{step.number}</span>
              <span className="body">
                <span className="t">{step.name}</span>
                <span className="d">{detail}</span>
              </span>
              {running ? (
                <span className="spin" />
              ) : step.done ? (
                <span className="go">
                  <ChevronIcon />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </>
  );

  return (
    <DocsWorkLayout chatOpen={props.chatOpen}>
      <div className="sheet">
        <div className="pg">
          <PageTitle
            value={props.title}
            placeholder={pageTitle({ ...view.page, title: "" }, view.recording)}
            autoFocus={props.focusTitle}
            onFocused={props.onTitleFocused}
            onInput={props.onTitleInput}
            onCommit={props.onTitleCommit}
          />
          <div className="pmeta">
            <MicIcon />
            <span>{source.kind === "text" ? "文章" : "録音"}</span>
            {formatDateTime(view.recording.createdAt) && (
              <>
                <span className="dotsep">·</span>
                <span>{formatDateTime(view.recording.createdAt)}</span>
              </>
            )}
          </div>
          <RecordingControls {...props} outputs={outputs} />
        </div>
      </div>
      {props.chatOpen && (
        <RecordingChatColumn
          view={view}
          activeRun={activeRun}
          chat={props.chat}
          loadPartial={props.loadPartial}
          chatBusy={props.chatBusy}
          saving={props.saving}
          leaseNote={props.leaseNote}
          setupReasonFor={props.setupReasonFor}
          onRunStep={props.onRunStep}
        />
      )}
    </DocsWorkLayout>
  );
}
