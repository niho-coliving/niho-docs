"use client";

import type { MutableRefObject, ReactNode } from "react";
import { recordingChildren, type PageEntry } from "@niho/docs-core";
import type { DocsValueSession } from "../host/DocsWorkspaceHost";
import type { ProjectInfo } from "@niho/docs-core";
import { SessionFolderInfo, SessionTitle } from "./SessionMetadata";
import type { Bridge } from "../lib/bridge";
import { formatDateTime } from "../lib/format";
import type { OpenProject } from "../lib/project-view";
import type { DocFlush } from "./DocPage";
import { FolderInfo } from "./FolderInfo";
import { DocsWorkLayout } from "./DocsComposerRail";
import { FolderIcon } from "./icons";
import { PageTitle, type TitleCommit } from "./PageTitle";
import { AudioEmpty, RecordingControls, type RecordingControlsProps } from "./RecordingPage";

/** 音声がまだ無いフォルダの「音声」の欄（押すとフォルダの録音を作り、背景情報のページのまま続ける）。 */
export type FolderAudioStart = {
  disabled: boolean;
  recordDisabled: boolean;
  onPick: () => void;
  onRecord: () => void;
};

/**
 * フォルダのページ＝背景情報のページ（owner 2026-10-18・#18914）。フォルダの行とレールの「背景情報」で開く。題（フォルダ名。その場で
 * 書く）・メタ行・背景情報・登場人物・固有名詞（FolderInfo）・「音声」（通常は1セット。旧データに複数あれば選択して RecordingControls、
 * まだ無ければ空の欄）。ページの一覧と「成果物」の列は置かない（ページと成果物はレールのフォルダの直下に並ぶ）。右に「AIと作る」
 * （選択した録音があるときだけ。録音の会話）。
 */
export function FolderHome(props: {
  bridge?: Pick<Bridge, "loadProject" | "saveProject">;
  folder: OpenProject;
  title: string;
  titleSession?: DocsValueSession<string>;
  infoSession?: DocsValueSession<ProjectInfo>;
  autoFocus?: boolean;
  readOnly?: boolean;
  locked?: boolean;
  onTitleFocused?: () => void;
  onTitleInput?: (title: string) => void;
  onTitleCommit?: TitleCommit;
  /** 背景情報の欄（保存していない変更の知らせ・保存の後・ページを移る前に書き残す口）。 */
  info?: { onDirtyChange: (dirty: boolean) => void; onSaved: () => Promise<void>; flushRef: MutableRefObject<DocFlush | null>; reloadKey?: number };
  /** フォルダの音声の操作（音声があるとき。見え方を読み終えるまでは "loading" で、欄を出さない）。 */
  controls?: RecordingControlsProps | "loading" | null;
  /** 古いデータに複数録音がある場合、背景情報ページで切り替えて操作する。 */
  recordingPages?: readonly PageEntry[];
  activeRecordingPageId?: string | null;
  onSelectRecording?: (pageId: string) => void;
  /** 音声がまだ無いときの欄。 */
  start?: FolderAudioStart;
  /** 右の「AIと作る」（音声があって開いているときだけ）。 */
  chat?: ReactNode;
}) {
  const { project } = props.folder;
  const recordingPages = props.recordingPages ?? [];
  const created = formatDateTime(project.createdAt).split(" ")[0] ?? "";
  // ページの数はレールのフォルダの直下に並ぶ行（文書と、できている成果物）
  const outputs = recordingPages.reduce((count, page) => {
    const summary = props.folder.recordings[page.recordingId ?? page.id];
    return count + (summary ? recordingChildren(summary.recording, summary.hasTranscript, summary.artifacts).length : 0);
  }, 0);
  const pageCount = props.folder.pages.filter((page) => page.kind === "doc").length + outputs;
  return (
    <DocsWorkLayout chatOpen={Boolean(props.chat)}>
      <div className="sheet">
        <div className="pg folder-home">
          {props.titleSession ? <SessionTitle session={props.titleSession} folder locked={props.locked} /> : <PageTitle
            value={props.title}
            placeholder="無題のフォルダ"
            autoFocus={props.autoFocus}
            disabled={props.readOnly || props.locked}
            onFocused={props.onTitleFocused}
            onInput={props.onTitleInput}
            onCommit={props.onTitleCommit}
          />}
          <div className="pmeta">
            <FolderIcon />
            <span>フォルダ</span>
            <span className="dotsep">·</span>
            <span>{pageCount} ページ</span>
            {created && (
              <>
                <span className="dotsep">·</span>
                <span>{created} 作成</span>
              </>
            )}
          </div>
          {props.infoSession ? <SessionFolderInfo session={props.infoSession} locked={props.locked} /> : <FolderInfo
            key={`${props.folder.id}:${props.info?.reloadKey ?? 0}`}
            bridge={props.bridge}
            projectId={props.folder.id as string}
            project={project}
            locked={props.locked}
            readOnly={props.readOnly}
            onDirtyChange={props.info?.onDirtyChange}
            onSaved={props.info?.onSaved}
            flushRef={props.info?.flushRef}
          />}
          {!props.readOnly && <section className="folder-audio" aria-labelledby="folder-audio-title">
            <h2 className="sec" id="folder-audio-title">音声</h2>
            {recordingPages.length > 1 && (
              <div className="row" role="group" aria-label="フォルダの録音">
                {recordingPages.map((page, index) => {
                  const summary = props.folder.recordings[page.recordingId ?? page.id];
                  const title = page.title.trim() || (summary?.recording.source.kind === "text" ? "文章" : "録音");
                  return (
                    <button
                      type="button"
                      className="btn outline sm"
                      key={page.id}
                      aria-pressed={props.activeRecordingPageId === page.id}
                      onClick={() => props.onSelectRecording?.(page.id)}
                    >
                      {title} {index + 1}
                    </button>
                  );
                })}
              </div>
            )}
            {props.controls === "loading" ? null : props.controls ? (
              <RecordingControls {...props.controls} />
            ) : props.start ? (
              <AudioEmpty
                disabled={props.start.disabled}
                recordDisabled={props.start.recordDisabled}
                onPick={props.start.onPick}
                onRecord={props.start.onRecord}
              />
            ) : null}
          </section>}
        </div>
      </div>
      {props.chat}
    </DocsWorkLayout>
  );
}
