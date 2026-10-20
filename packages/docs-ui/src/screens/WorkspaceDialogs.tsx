"use client";

import type { Step } from "@niho/docs-core";
import { NIHO_API_MODEL_SWAP_NOTE, candidatesFor, diffFlowDesign, type Flow, type PageEntry } from "@niho/docs-core";
import { CandidateComparison } from "../components/CandidateComparison";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ConflictDialog } from "../components/ConflictDialog";
import { FailureBand, type Failure, type FailureAction } from "../components/FailureBand";
import { FlowPickerDialog, type FlowChoice } from "../components/FlowPicker";
import { GoogleDocsExportDialog } from "../components/GoogleDocs";
import { GoogleDocsFolderExportDialog } from "../components/GoogleDocsFolderExport";
import { RecordingCloseGuard } from "../components/Recording";
import { type Bridge, type ProjectId, type RecordedAudio } from "../lib/bridge";
import { type ChatTarget } from "../lib/chat";
import { conflictLabel, readCurrentText, type ConflictNames } from "../lib/cloud";
import { formatRecordingLength } from "../lib/format";
import { stepName, type RecordingView } from "../lib/project-view";
import type { GoogleDocsController } from "../lib/use-google-docs";
import type { GoogleDocsFolderExportController } from "../lib/use-google-docs-folder-export";
import { KEEPS_ARTIFACTS, draftKey, flowDiffLines, type CandidateDialogState, type Draft, type NihoRunConfirmation, type RecordingThen, type ToastAction } from "./workspace-model";

import type { useAppRecording } from "../lib/app-recording";

type Props = {
  googleDocs: GoogleDocsController;
  folderExport: GoogleDocsFolderExportController;
  fileDropOver: boolean;
  flowPick: { target: string | null; name?: string; then?: RecordingThen; drop?: { paths: string[]; location: string | null; }; } | null;
  busy: boolean;
  chooseFlowForRecording: (choice: FlowChoice) => Promise<void>;
  setFlowPick: React.Dispatch<React.SetStateAction<{ target: string | null; name?: string; then?: RecordingThen; drop?: { paths: string[]; location: string | null; }; } | null>>;
  confirmUpdate: boolean;
  view: RecordingView | null;
  sourceFlow: Flow | null;
  updatingFlow: boolean;
  updateRecordingFlow: () => Promise<void>;
  setConfirmUpdate: React.Dispatch<React.SetStateAction<boolean>>;
  unregistered: string[];
  flowChange: { key: string; flow: Flow; } | null;
  flowChanging: { key: string; flowId: string; } | null;
  applyRecordingFlow: (current: RecordingView, target: Flow, confirmed: boolean) => Promise<void>;
  setFlowChange: React.Dispatch<React.SetStateAction<{ key: string; flow: Flow; } | null>>;
  unregisteredSteps: Step[];
  deletingFlow: { flow: Flow; usage: number; samples: boolean; } | null;
  deleteBusy: boolean;
  deleteFlow: () => Promise<void>;
  setDeletingFlow: React.Dispatch<React.SetStateAction<{ flow: Flow; usage: number; samples: boolean; } | null>>;
  aboutLeaveOpen: boolean;
  aboutSaving: boolean;
  discardAboutAndContinue: () => void;
  returnToAbout: () => void;
  closeConfirm: { flows: string[]; info: boolean; } | null;
  closing: boolean;
  discardAndClose: () => Promise<void>;
  setCloseConfirm: React.Dispatch<React.SetStateAction<{ flows: string[]; info: boolean; } | null>>;
  closeFailed: boolean;
  deleting: { projectId: ProjectId; pageId: string; title: string; kind: PageEntry["kind"]; audio?: boolean; } | null;
  deletePage: () => Promise<void>;
  setDeleting: React.Dispatch<React.SetStateAction<{ projectId: ProjectId; pageId: string; title: string; kind: PageEntry["kind"]; audio?: boolean; } | null>>;
  conflictReview: { projectId: string; path: string | null; } | null;
  bridge: Bridge;
  conflictNames: (projectId: string) => ConflictNames;
  onConflictResolved: (projectId: string, path: string) => void;
  setConflictReview: React.Dispatch<React.SetStateAction<{ projectId: string; path: string | null; } | null>>;
  nihoRunConfirmation: NihoRunConfirmation | null;
  viewRef: React.MutableRefObject<RecordingView | null>;
  cloudContextRef: React.MutableRefObject<{ generation: number | null; scopeId: string | null; }>;
  showFailure: (text: string, action?: FailureAction) => void;
  candidateDialog: CandidateDialogState | null;
  candidateBusy: boolean;
  createCandidate: () => Promise<void>;
  setCandidateDialog: React.Dispatch<React.SetStateAction<CandidateDialogState | null>>;
  failure: Failure | null;
  setFailure: React.Dispatch<React.SetStateAction<Failure | null>>;
  compareOpen: boolean;
  selectedTarget: ChatTarget | null;
  drafts: Record<string, Draft>;
  setCompareOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectPage: (pageId: string, stepId?: string | null, candidateId?: string | null, shouldApply?: () => boolean) => Promise<void>;
  toast: { text: string; action?: ToastAction; } | null;
  clearToast: () => void;
  discardingCapture: RecordedAudio | null;
  capture: ReturnType<typeof useAppRecording>;
  setDiscardingCapture: React.Dispatch<React.SetStateAction<RecordedAudio | null>>;
  stopRecordingAndClose: () => Promise<void>;
};

/** WorkspaceDialogs の描画。保存・実行・遷移の操作は controller から受け取る。 */
export function WorkspaceDialogs(props: Props) {
  const {
    googleDocs, folderExport, fileDropOver, flowPick,
    busy, chooseFlowForRecording, setFlowPick, confirmUpdate,
    view, sourceFlow, updatingFlow, updateRecordingFlow,
    setConfirmUpdate, unregistered, flowChange, flowChanging,
    applyRecordingFlow, setFlowChange, unregisteredSteps, deletingFlow,
    deleteBusy, deleteFlow, setDeletingFlow, aboutLeaveOpen,
    aboutSaving, discardAboutAndContinue, returnToAbout, closeConfirm,
    closing, discardAndClose, setCloseConfirm, closeFailed,
    deleting, deletePage, setDeleting, conflictReview,
    bridge, conflictNames, onConflictResolved, setConflictReview,
    nihoRunConfirmation, viewRef, cloudContextRef, showFailure,
    candidateDialog, candidateBusy, createCandidate, setCandidateDialog,
    failure, setFailure, compareOpen, selectedTarget,
    drafts, setCompareOpen, selectPage, toast,
    clearToast, discardingCapture, capture, setDiscardingCapture,
    stopRecordingAndClose,
  } = props;
  return (<>
<GoogleDocsExportDialog googleDocs={googleDocs} />
      <GoogleDocsFolderExportDialog controller={folderExport} />
      {fileDropOver && <div className="window-drop" aria-hidden="true"><span>音声をここにドロップ</span></div>}
      {flowPick && <FlowPickerDialog busy={busy} onChoose={(choice) => void chooseFlowForRecording(choice)} onCancel={() => setFlowPick(null)} />}
      {confirmUpdate && view && sourceFlow && (
        <ConfirmDialog
          title="この録音の工程を今の設計に更新しますか"
          confirmLabel="更新する"
          busy={updatingFlow}
          onConfirm={() => void updateRecordingFlow()}
          onCancel={() => setConfirmUpdate(false)}
        >
          <ul className="difflist">
            {flowDiffLines(diffFlowDesign(view.flow, sourceFlow), unregistered).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="msg">{KEEPS_ARTIFACTS}</p>
        </ConfirmDialog>
      )}
      {flowChange && view && view.key === flowChange.key && (
        <ConfirmDialog
          title={`この録音の工程を「${flowChange.flow.name}」にしますか`}
          confirmLabel="工程を変える"
          busy={flowChanging !== null}
          onConfirm={() => void applyRecordingFlow(view, flowChange.flow, true)}
          onCancel={() => setFlowChange(null)}
        >
          {(() => {
            // 選んだフローに残る工程のうち、登録を外した AI に解決済みのもの（作り直すと登録した AI で解決し直す）
            const kept = unregisteredSteps.filter((step) => flowChange.flow.steps.some((other) => other.id === step.id));
            const lines = flowDiffLines(
              diffFlowDesign(view.flow, flowChange.flow),
              kept.map((step) => step.name),
            );
            return lines.length > 0 ? (
              <ul className="difflist">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null;
          })()}
          <p className="msg">{KEEPS_ARTIFACTS}</p>
        </ConfirmDialog>
      )}
      {deletingFlow && (
        <ConfirmDialog
          title={`「${deletingFlow.flow.name}」を削除しますか`}
          confirmLabel="削除する"
          danger
          busy={deleteBusy}
          onConfirm={() => void deleteFlow()}
          onCancel={() => setDeletingFlow(null)}
        >
          {deletingFlow.usage > 0 && (
            <p className="msg">
              この工程を使っている録音が {deletingFlow.usage} 件あります。録音は作ったときの工程の写しで、これまでどおり実行できます。
            </p>
          )}
          {deletingFlow.samples && <p className="msg">お手本の文書も削除します。</p>}
          <p className="msg">元に戻せません。</p>
        </ConfirmDialog>
      )}
      {aboutLeaveOpen && (
        <ConfirmDialog
          title="保存していない変更があります"
          confirmLabel="破棄して移動"
          cancelLabel="戻る"
          danger
          busy={aboutSaving}
          onConfirm={discardAboutAndContinue}
          onCancel={returnToAbout}
        >
          <p className="msg">保存できていない「あなたについて」の変更があります。破棄するか、戻ってもう一度保存してください。</p>
        </ConfirmDialog>
      )}
      {closeConfirm && (
        <ConfirmDialog
          title="保存が終わっていない変更があります"
          confirmLabel="破棄して閉じる"
          cancelLabel="編集に戻る"
          danger
          busy={closing}
          onConfirm={() => void discardAndClose()}
          onCancel={() => setCloseConfirm(null)}
        >
          <ul className="difflist">
            {closeConfirm.flows.map((name) => (
              <li key={`flow:${name}`}>工程設計「{name}」</li>
            ))}
            {closeConfirm.info && <li>背景情報</li>}
          </ul>
          <p className="msg">閉じると、保存していない変更は失われます。残すときは編集に戻って保存してください。</p>
          {closeFailed && <p className="err">閉じられませんでした。もう一度押してください。</p>}
        </ConfirmDialog>
      )}
      {deleting && (
        <ConfirmDialog
          title={deleting.audio ? `「${deleting.title}」の音声を削除しますか` : `「${deleting.title}」を削除しますか`}
          confirmLabel="削除する"
          danger
          busy={deleteBusy}
          onConfirm={() => void deletePage()}
          onCancel={() => setDeleting(null)}
        >
          <p className="msg">
            {deleting.audio
              ? "このフォルダの音声と、この音声から作ったページ・版・会話を削除します。背景情報と文書のページは残ります。元に戻せません。"
              : deleting.kind === "rec"
              ? "この録音のページと、この録音から作ったページ・版・会話を削除します。元に戻せません。"
              : "この文書のページを削除します。元に戻せません。"}
          </p>
        </ConfirmDialog>
      )}
      {conflictReview && (
        <ConflictDialog
          bridge={bridge}
          projectId={conflictReview.projectId}
          path={conflictReview.path}
          labelOf={(path) => conflictLabel(conflictReview.projectId, path, conflictNames(conflictReview.projectId))}
          readLocal={(path) => readCurrentText(bridge, conflictReview.projectId, path)}
          onResolved={(path) => onConflictResolved(conflictReview.projectId, path)}
          onClose={() => setConflictReview(null)}
        />
      )}
      {nihoRunConfirmation && (
        <ConfirmDialog
          title="続きをクラウドで作りますか"
          confirmLabel="クラウドで作る"
          onConfirm={() => {
            const pending = nihoRunConfirmation;
            const same = viewRef.current?.key === pending.capturedKey &&
              cloudContextRef.current.generation === pending.context.generation && cloudContextRef.current.scopeId === pending.context.scopeId;
            if (same && pending.access.consentVersion) pending.accept();
            else {
              pending.cancel();
              showFailure("確認中に本人・保存先・録音が変わったため、送信しませんでした。");
            }
          }}
          onCancel={() => nihoRunConfirmation.cancel()}
        >
          <p className="msg">{nihoRunConfirmation.deviceDelivery
            ? "固定した原文・参考情報をクラウドへ一時送信し、結果をこの Mac に保存します。"
            : "クラウドで続きを作ります。受付後も完了するまで実行状態を確認してください。"}</p>
          {nihoRunConfirmation.swap && <p className="hint">{NIHO_API_MODEL_SWAP_NOTE}</p>}
          {(nihoRunConfirmation.swap || nihoRunConfirmation.deviceDelivery) && <p className="hint">AI: {nihoRunConfirmation.modelLabel}</p>}
          <p className="hint">原文: {nihoRunConfirmation.sourceVersionLabel}</p>
        </ConfirmDialog>
      )}
      {candidateDialog && (
        <ConfirmDialog
          title={candidateDialog.stepName ? `${candidateDialog.stepName}の別案を作成` : "別案を作成"}
          confirmLabel={candidateDialog.mode === "generate" ? "生成する" : "複製する"}
          busy={candidateBusy}
          onConfirm={() => void createCandidate()}
          onCancel={() => setCandidateDialog(null)}
        >
          {failure && <FailureBand message={failure.text} action={failure.action} onDismiss={() => setFailure(null)} />}
          <fieldset className="fields" disabled={candidateBusy}>
            <div className="candidate-modes" role="radiogroup" aria-label="別案の作り方">
              <label><input type="radio" name="candidate-mode" checked={candidateDialog.mode === "generate"} onChange={() => setCandidateDialog({ ...candidateDialog, mode: "generate" })} />共通素材から生成</label>
              <label><input type="radio" name="candidate-mode" checked={candidateDialog.mode === "duplicate"} onChange={() => setCandidateDialog({ ...candidateDialog, mode: "duplicate" })} />現在の本文を複製</label>
            </div>
            {candidateDialog.mode === "duplicate" && <p className="hint">複製元: {candidateDialog.sourceName}</p>}
            <div className="fld"><label htmlFor="candidate-name">案名</label><input id="candidate-name" className="in" value={candidateDialog.name} onChange={(event) => setCandidateDialog({ ...candidateDialog, name: event.target.value })} /></div>
            {candidateDialog.mode === "generate" && <div className="fld"><label htmlFor="candidate-instruction">追加の指示（任意）</label><textarea id="candidate-instruction" className="ta" value={candidateDialog.instruction} onChange={(event) => setCandidateDialog({ ...candidateDialog, instruction: event.target.value })} /></div>}
          </fieldset>
        </ConfirmDialog>
      )}
      {compareOpen && view && selectedTarget && (
        <CandidateComparison
          candidates={candidatesFor(view.recording, selectedTarget.stepId)}
          artifacts={view.artifacts}
          drafts={Object.fromEntries(
            candidatesFor(view.recording, selectedTarget.stepId).flatMap((candidate) => {
              const draft = drafts[draftKey(view.key, candidate.artifactId)];
              return draft ? [[candidate.artifactId, draft.markdown] as const] : [];
            }),
          )}
          currentId={selectedTarget.candidateId}
          stepName={stepName(view, selectedTarget.stepId)}
          onOpen={(candidateId) => {
            // レールの案の行と同じ（書きかけを書き残してから、その案を選択案として開く）
            setCompareOpen(false);
            void selectPage(view.page.id, selectedTarget.stepId, candidateId);
          }}
          onClose={() => setCompareOpen(false)}
        />
      )}
      {toast && (
        <div className={`toast${toast.action ? " with-action" : ""}`} role="status">
          {toast.text}
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                const action = toast.action;
                clearToast();
                action?.run();
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
      {discardingCapture && (
        <ConfirmDialog title="前回の録音を捨てますか？" confirmLabel="捨てる" danger busy={capture.saving}
          onConfirm={() => void capture.discard(discardingCapture).then((discarded) => { if (discarded) setDiscardingCapture(null); })}
          onCancel={() => setDiscardingCapture(null)}>
          <p className="msg">{discardingCapture.name}（{formatRecordingLength(discardingCapture.durationSec ?? 0)}）を削除します。元に戻せません。</p>
        </ConfirmDialog>
      )}
      <RecordingCloseGuard bridge={bridge} close={stopRecordingAndClose} />
  </>);
}
