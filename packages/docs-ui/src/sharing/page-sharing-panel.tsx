import { DOCS_PAGE_SHARING_TEXT, type DocsPageShareState } from "@niho/docs-core";
import { useEffect, useRef, useState } from "react";

export type PageSharingPanelProps = {
  state: DocsPageShareState | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  blockReason: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onToggle: (published: boolean) => void;
  onRotate: (expectedPublicId: string) => void;
  onCopy: (url: string) => Promise<boolean>;
  onSend?: (url: string) => void;
  onOpen: (url: string) => void;
};

export function PageSharingPanel(props: PageSharingPanelProps) {
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { (confirming ? confirmCancelRef : closeRef).current?.focus(); }, [confirming]);
  const state = props.state;
  const published = state?.status === "PUBLIC";
  const url = published ? state?.url : null;

  const copy = () => {
    if (!url) return;
    setCopied(false);
    void props.onCopy(url).then((ok) => setCopied(ok));
  };

  return (
    <section className="docs-share-panel" aria-label={DOCS_PAGE_SHARING_TEXT.menu} onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (confirming) setConfirming(false); else props.onClose();
    }}>
      {confirming ? (
        <div role="alertdialog" aria-labelledby="docs-share-confirm-title" aria-describedby="docs-share-confirm-help">
          <h2 id="docs-share-confirm-title">{DOCS_PAGE_SHARING_TEXT.rotateTitle}</h2>
          <p id="docs-share-confirm-help" className="docs-share-muted">{DOCS_PAGE_SHARING_TEXT.rotateHelp}</p>
          <div className="docs-share-actions">
            <button ref={confirmCancelRef} type="button" onClick={() => setConfirming(false)}>{DOCS_PAGE_SHARING_TEXT.cancel}</button>
            <button type="button" className="docs-share-danger" disabled={props.busy || !state?.publicId} onClick={() => {
              if (!state?.publicId) return;
              setConfirming(false);
              props.onRotate(state.publicId);
            }}>{DOCS_PAGE_SHARING_TEXT.confirmRotate}</button>
          </div>
        </div>
      ) : (
        <>
          <div className="docs-share-head"><h2>{DOCS_PAGE_SHARING_TEXT.menu}</h2><button ref={closeRef} type="button" aria-label="閉じる" onClick={props.onClose}>×</button></div>
          {props.loading ? <p role="status" className="docs-share-muted">共有の状態を読み込んでいます</p> : null}
          {!state && !props.loading && props.blockReason ? <p role="status" className="docs-share-error">{props.blockReason}</p> : null}
          {state ? <>
            <label className="docs-share-toggle"><span>{DOCS_PAGE_SHARING_TEXT.toggle}</span><input type="checkbox" role="switch" checked={published} disabled={props.busy || (!published && Boolean(props.blockReason))} onChange={(event) => props.onToggle(event.currentTarget.checked)} /></label>
            <p className="docs-share-muted">{published ? DOCS_PAGE_SHARING_TEXT.publicHelp : DOCS_PAGE_SHARING_TEXT.privateHelp}</p>
            {!published && props.blockReason ? <p role="status" className="docs-share-error">{props.blockReason}</p> : null}
            {url ? <>
              <div className="docs-share-url"><input type="text" readOnly value={url} aria-label="共有リンク" onFocus={(event) => event.currentTarget.select()} /><button type="button" onClick={copy}>{DOCS_PAGE_SHARING_TEXT.copy}</button></div>
              <div role="status" className="docs-share-copy-status">{copied ? DOCS_PAGE_SHARING_TEXT.copied : ""}</div>
              <div className="docs-share-actions">
                <button type="button" onClick={() => props.onOpen(url)}>{DOCS_PAGE_SHARING_TEXT.open}</button>
                {props.onSend ? <button type="button" className="docs-share-send" onClick={() => props.onSend?.(url)}>{DOCS_PAGE_SHARING_TEXT.send}</button> : null}
              </div>
              <button type="button" className="docs-share-rotate" disabled={props.busy} onClick={() => setConfirming(true)}>{DOCS_PAGE_SHARING_TEXT.rotate}</button>
            </> : null}
          </> : null}
          {props.error ? <p role="alert" className="docs-share-error">{props.error} <button type="button" onClick={props.onRefresh}>読み直す</button></p> : null}
        </>
      )}
    </section>
  );
}
