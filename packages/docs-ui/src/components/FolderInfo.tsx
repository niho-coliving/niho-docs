"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { cleanGlossary, cleanProjectEntities, projectEntitiesError, type GlossaryEntry, type Project, type ProjectEntity } from "@niho/docs-core";
import { errorMessage, type Bridge } from "../lib/bridge";
import type { DocFlush } from "./DocPage";
import { Glossary } from "./Glossary";
import { ProjectEntities } from "./ProjectEntities";
import { useFitHeight } from "./useFitHeight";

/**
 * 背景情報のページの 背景情報・登場人物・固有名詞（#18914。以前の背景情報のダイアログの欄をページに置いた）。フォルダのすべての
 * ページと工程に効くもの。保存はダイアログと同じく「保存」で、読み直したフォルダに当てる（画面の古い値で、ページの一覧や録音の
 * 値を戻さない）。保存していない変更があるうちにページを移るときは、移る前に保存する（`flushRef`。文書の書きかけと同じ口）。保存
 * できなければ移らない。窓を閉じる前の確かめには `onDirtyChange` で知らせる（#18788）。
 */
export function FolderInfo(props: {
  bridge?: Pick<Bridge, "loadProject" | "saveProject">;
  projectId: string;
  project: Project;
  locked?: boolean;
  readOnly?: boolean;
  /** 保存していない変更の有無が変わった（外れたら false）。 */
  onDirtyChange?: (dirty: boolean) => void;
  /** 保存できた後（一覧と開いているフォルダを読み直す）。 */
  onSaved?: () => Promise<void> | void;
  /** ページを移る前に書き残す口（App の文書の書きかけと同じ）。 */
  flushRef?: MutableRefObject<DocFlush | null>;
}) {
  const { bridge, projectId, project } = props;
  const [terms, setTerms] = useState<GlossaryEntry[]>(project.info.terms);
  const [background, setBackground] = useState(project.info.background);
  const [entities, setEntities] = useState<ProjectEntity[]>(project.info.entities ?? []);
  /** 最後に保存した（か開いたときの）値。変更の有無はこれと比べる。 */
  const [base, setBase] = useState(project.info);
  const baseRef = useRef(project.info);
  const projectIdRef = useRef(projectId);
  const [glossaryRevision, setGlossaryRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // 保存していない変更（空の行・前後の空白は変更に数えない。保存で落とすものと同じ）。保存では直した欄だけを書く。
  const changed = {
    background: background.trim() !== base.background.trim(),
    terms: JSON.stringify(cleanGlossary(terms)) !== JSON.stringify(cleanGlossary(base.terms)),
    entities: JSON.stringify(cleanProjectEntities(entities)) !== JSON.stringify(cleanProjectEntities(base.entities ?? [])),
  };
  const dirty = changed.background || changed.terms || changed.entities;
  const onDirtyChangeRef = useRef(props.onDirtyChange);
  onDirtyChangeRef.current = props.onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
    if (dirty) setSaved(false);
  }, [dirty]);
  useEffect(() => () => onDirtyChangeRef.current?.(false), []);
  const hostRef = useRef(props);
  hostRef.current = props;
  const busyRef = useRef(false);
  const latest = useRef({ dirty, changed, terms, background, entities });
  latest.current = { dirty, changed, terms, background, entities };

  // 別の Mac や同期から project.info が変わったら、未編集の各欄を新しい値へ追従させる。
  // 編集中の欄は手元の入力を保ち、base だけを新しい値へ進めるため、保存時に別欄の外部更新を巻き戻さない。
  useEffect(() => {
    const incoming = project.info;
    const previous = baseRef.current;
    if (projectIdRef.current !== projectId) {
      projectIdRef.current = projectId;
      baseRef.current = incoming;
      setTerms(incoming.terms);
      setBackground(incoming.background);
      setEntities(incoming.entities ?? []);
      setBase(incoming);
      setGlossaryRevision((revision) => revision + 1);
      setError(null);
      setSaved(false);
      return;
    }
    if (JSON.stringify(previous) === JSON.stringify(incoming)) return;
    const current = latest.current;
    if (JSON.stringify(cleanGlossary(current.terms)) === JSON.stringify(cleanGlossary(previous.terms))) {
      setTerms(incoming.terms);
      setGlossaryRevision((revision) => revision + 1);
    }
    if (current.background.trim() === previous.background.trim()) setBackground(incoming.background);
    if (JSON.stringify(cleanProjectEntities(current.entities)) === JSON.stringify(cleanProjectEntities(previous.entities ?? []))) {
      setEntities(incoming.entities ?? []);
    }
    baseRef.current = incoming;
    setBase(incoming);
    setSaved(false);
  }, [project.info, projectId]);

  /** 保存する（変更が無ければ何もしない）。保存できた（か変更が無い）なら true。 */
  const save = useCallback(async (): Promise<boolean> => {
    const now = latest.current;
    if (!now.dirty) return true;
    if (!bridge || props.readOnly) return false;
    if (busyRef.current) return false;
    const cleanedEntities = cleanProjectEntities(now.entities);
    if (now.changed.entities) {
      const entitiesError = projectEntitiesError(cleanedEntities);
      if (entitiesError) {
        setError(entitiesError);
        return false;
      }
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const fresh = (await bridge.loadProject(projectId)).project;
      // 直した欄だけを読み直したフォルダに当て、同期で届いた未編集欄を古い画面の値で戻さない。root の録音の話者人数・言語
      // （info.speakers・info.language）も読み直した値のまま残す
      const info = {
        ...fresh.info,
        ...(now.changed.terms ? { terms: cleanGlossary(now.terms) } : {}),
        ...(now.changed.background ? { background: now.background.trim() } : {}),
        ...(now.changed.entities ? { entities: cleanedEntities } : {}),
      };
      await bridge.saveProject(projectId, { ...fresh, info });
      baseRef.current = info;
      setTerms(info.terms);
      setBackground(info.background);
      setEntities(info.entities ?? []);
      setBase(info);
      setGlossaryRevision((revision) => revision + 1);
      setSaved(true);
      onDirtyChangeRef.current?.(false);
      await hostRef.current.onSaved?.();
      return true;
    } catch (saveError) {
      setError(errorMessage(saveError, "保存できませんでした。"));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [bridge, projectId, props.readOnly]);

  // ページを移る前に、保存していない変更を書き残す（書けなければ移らない）
  const flushRef = props.flushRef;
  useEffect(() => {
    if (!flushRef) return;
    const flush: DocFlush = () => save();
    flushRef.current = flush;
    return () => {
      if (flushRef.current === flush) flushRef.current = null;
    };
  }, [flushRef, save]);

  const locked = props.readOnly || (props.locked ?? false);
  return (
    <>
      <FolderInfoFields background={background} terms={terms} entities={entities} disabled={locked || busy}
        onBackground={setBackground} onTerms={setTerms} onEntities={setEntities} glossaryRevision={glossaryRevision} />
      {!props.readOnly && <div className="folder-save">
        {locked && <p className="help">このフォルダの工程の実行か「AIと作る」の依頼が終わってから変えられます。</p>}
        {error && <p className="err" role="alert">{error}</p>}
        {!error && saved && !dirty && <p className="help" role="status">保存しました</p>}
        <span className="sp" />
        <button type="button" className="btn primary sm" onClick={() => void save()} disabled={busy || locked || !dirty}>
          保存
        </button>
      </div>}
    </>
  );
}

/** Mac と vault session で同じ背景情報・登場人物・固有名詞の欄を使う。 */
export function FolderInfoFields(props: {
  background: string; terms: GlossaryEntry[]; entities: ProjectEntity[]; disabled?: boolean; glossaryRevision?: number | string;
  onBackground(value: string): void; onTerms(value: GlossaryEntry[]): void; onEntities(value: ProjectEntity[]): void;
}) {
  const { background, terms, entities, glossaryRevision } = props;
  const backgroundArea = useRef<HTMLTextAreaElement | null>(null);
  useFitHeight(backgroundArea, background);
  return (
      <fieldset className="fields folder-fields" disabled={props.disabled}>
        <div className="fld">
          <label htmlFor="info-bg">背景情報</label>
          <textarea ref={backgroundArea} id="info-bg" className="ta grow" style={{ minHeight: 84 }} value={background} onChange={(event) => props.onBackground(event.target.value)} />
        </div>
        <div className="fld">
          <span className="label">登場人物</span>
          <ProjectEntities entries={entities} onChange={props.onEntities} />
        </div>
        <div className="fld">
          <span className="label">固有名詞</span>
          <Glossary key={glossaryRevision} entries={terms} onChange={props.onTerms} />
        </div>
      </fieldset>
  );
}
