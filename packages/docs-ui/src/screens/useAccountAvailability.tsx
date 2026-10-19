"use client";

import { useEffect, useRef, useState } from "react";
import { type Screen, type Selection } from "../components/Rail";
import type { DocsAccount as NihoAccount } from "../host/DocsAccount";
import { accountProfileOf } from "../host/DocsAccount";
import { type Bridge, type ProjectId, type RecentId } from "../lib/bridge";
import type { CloudController } from "../lib/cloud";
import { type OpenProject } from "../lib/project-view";
import { type Phase } from "./workspace-model";

type Context = {
  screen: Screen;
  account: NihoAccount;
  bridge: Bridge;
  setAccountOpen: React.Dispatch<React.SetStateAction<boolean | null>>;
  accountOpen: boolean | null;
  cloud: CloudController;
  phase: Phase;
  outside: OpenProject | null;
  recent: RecentId[];
  openRef: React.MutableRefObject<OpenProject | null>;
  selectionRef: React.MutableRefObject<Selection | null>;
  folders: OpenProject[];
  selectLocationPage: (projectId: ProjectId, pageId: string, stepId: string | null, candidateId?: string | null, shouldApply?: () => boolean) => Promise<void>;
};

/** 接続可否とログイン待機を扱い、起動時の前回ページを一度だけ開く。 */
export function useAccountAvailability(context: Context) {
  const {
    screen, account, bridge, setAccountOpen,
    accountOpen, cloud, phase, outside,
    recent, openRef, selectionRef, folders,
    selectLocationPage,
  } = context;

  // NIHO アカウントの接続をサーバーが受け付けるか: 起動したとき・設定を開くたび・ウィンドウに戻るたび、ログインしていない間は 1 分ごと
  // にも確かめる。閉じている間は、ログインしていない人にログインと Google ドキュメントの欄・書き出しを出さず、レールの知らせに
  // 「ログイン」を出さず、ログイン画面で塞がない（押しても使えない）。ログイン画面にいる間に閉じても（障害対応など）、締め出さない
  const settingsOpen = screen === "settings";
  const signedOutNow = account.state?.kind === "signedOut" || account.state?.kind === "signingIn";
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      bridge.accountAvailable().then(
        (available) => {
          if (!cancelled) setAccountOpen(available);
        },
        // 確かめられないとき（オフライン）は、まだ決まっていなければ開いているとして扱う（＝ログイン画面）。決まっていれば保つ
        () => {
          if (!cancelled) setAccountOpen((current) => current ?? true);
        },
      );
    };
    check();
    window.addEventListener("focus", check);
    const timer = signedOutNow ? window.setInterval(check, 60_000) : null;
    return () => {
      cancelled = true;
      window.removeEventListener("focus", check);
      if (timer !== null) window.clearInterval(timer);
    };
  }, [bridge, setAccountOpen, settingsOpen, signedOutNow]);
  const accountShown = accountOpen !== false || accountProfileOf(account.state) !== null;
  // 一度手元で続けた（ログインしていない・接続が閉じていた）ら、使っている途中で接続が開いても、ログインするまではログイン画面に
  // 切り替えない（書いている途中の画面を急に塞がない。レールの知らせに「ログイン」が出る）。次に起動したときはログイン画面から
  const [localFallback, setLocalFallback] = useState(false);
  useEffect(() => {
    if (!signedOutNow) setLocalFallback(false);
    else if (cloud.state?.requiresAccount && accountOpen === false) setLocalFallback(true);
  }, [accountOpen, cloud.state?.requiresAccount, signedOutNow]);

  // 起動したときは前回のページ（最近の先頭）を開く（owner 2026-10-18・#18867。Web/PWA の PC の幅と同じ）。最近は消えたページを除いて
  // 読むので、前回のページが消えていればその次に開いたページになり、1 つも無ければホームのまま。起動の 1 回だけで、ログインの画面・
  // ログインを確かめている間は待つ（塞いでいる画面の裏でページを開かない）。その前に利用者が別の画面へ移っていたら開かない。
  // ホームへ戻ったときは開かない（ホームは「最近」）
  const launchOpenedRef = useRef(false);
  // クラウドの状態（保存先が NIHO クラウドか）と、NIHO クラウドならアカウントの状態を読み終えるまでは待つ。読む前は `cloud.niho` も
  // `signedOutNow` も false になり、ログイン画面に切り替わる前に裏でページを開いてしまうため
  const launchStateKnown = bridge.capabilities?.cloudSync === false || (cloud.state !== null && (!cloud.state.requiresAccount || account.state !== null));
  const workShown = phase === "ready" && outside !== null && launchStateKnown &&
    !(cloud.state?.requiresAccount && signedOutNow && (accountOpen === null || (accountOpen && !localFallback))) &&
    cloud.state?.storage?.mode !== "UNSET";
  useEffect(() => {
    if (launchOpenedRef.current || !workShown || !outside) return;
    launchOpenedRef.current = true;
    const last = recent[0];
    if (!last || openRef.current !== null || selectionRef.current !== null || screen !== "work") return;
    const space = last.projectId === null ? outside : folders.find((folder) => folder.id === last.projectId);
    if (!space?.pages.some((page) => page.id === last.pageId)) return;
    void selectLocationPage(last.projectId, last.pageId, null);
  });
  return {
    signedOutNow, accountShown, localFallback,
  };
}
