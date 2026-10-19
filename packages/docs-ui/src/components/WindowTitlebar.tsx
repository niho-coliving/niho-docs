"use client";

import { createContext, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

const TitlebarActionsHost = createContext<HTMLElement | null>(null);
const TitlebarRailHost = createContext<HTMLElement | null>(null);
const TitlebarHomeSetter = createContext<Dispatch<SetStateAction<(() => void) | null>> | null>(null);

/** タイトルバーの右端（開いているページの操作の置き場）。`PageTop` がここへ描く。枠の外（無いとき）は null。 */
export function useTitlebarActionsHost(): HTMLElement | null {
  return useContext(TitlebarActionsHost);
}

/** タイトルバーの中でレールの右端にそろえた置き場（新規作成の ＋。`Rail` がここへ描く。#18929）。枠の外（無いとき）は null。 */
export function useTitlebarRailHost(): HTMLElement | null {
  return useContext(TitlebarRailHost);
}

/**
 * タイトルバーのアプリ名を「ホームへ戻る」ボタンにする（owner 2026-10-18・#18929。レールに「ホーム」の行は置かない）。
 * 呼んだ部品（`Rail`）が出ている間だけボタンにし、ログインの画面などレールの無い画面では名前だけにする。
 */
export function useTitlebarHome(onHome: () => void): void {
  const setHome = useContext(TitlebarHomeSetter);
  const latest = useRef(onHome);
  useEffect(() => { latest.current = onHome; });
  useEffect(() => {
    if (!setHome) return;
    const go = () => latest.current();
    setHome(() => go);
    return () => setHome((current) => (current === go ? null : current));
  }, [setHome]);
}

/**
 * macOS の窓の枠。標準のウィンドウボタンの横にアプリ名を一度だけ出し（押すとホーム）、レールの右端にそろえて新規作成の ＋、
 * 右端に開いているページの操作（「AIと作る」の開閉・⋯、成果物の子ページでは履歴。書き出し・検索・書式は ⋯ の中。owner 2026-10-18・
 * #18941）を置く。保存のボタンは置かない（#18912）。
 * 中央の上の帯とパンくずは無く、場所はレールの選択行が示す（owner 2026-10-18・#18881・#18929）。
 */
export function DesktopShell(props: { children: ReactNode; icon?: string; browser?: boolean }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [railHost, setRailHost] = useState<HTMLElement | null>(null);
  const [home, setHome] = useState<(() => void) | null>(null);
  return (
    <div className={`desktop-shell${props.browser ? " browser-shell" : ""}`} data-docs-app-root data-docs-shared-ui>
      <div className="window-titlebar" data-tauri-drag-region={props.browser ? undefined : true}>
        <div className="lead" data-tauri-drag-region={props.browser ? undefined : true}>
          {home
            ? <button type="button" className="tb-home" aria-label="NIHO docs ホームへ" onClick={home}>{props.icon && <img src={props.icon} alt="" draggable={false} />}<span>NIHO docs</span></button>
            : <>{props.icon && <img src={props.icon} alt="" draggable={false} />}<span data-tauri-drag-region={props.browser ? undefined : true}>NIHO docs</span></>}
          <div className="rail-acts" ref={setRailHost} />
        </div>
        <div className="acts" ref={setHost} />
      </div>
      <TitlebarHomeSetter.Provider value={setHome}>
        <TitlebarRailHost.Provider value={railHost}>
          <TitlebarActionsHost.Provider value={host}>{props.children}</TitlebarActionsHost.Provider>
        </TitlebarRailHost.Provider>
      </TitlebarHomeSetter.Provider>
    </div>
  );
}
