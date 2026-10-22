"use client";

import { DOCS_STORAGE_WORDS } from "@niho/docs-core";
import type { ReactNode } from "react";
import { useState } from "react";

/** 保存先モードの表示と、ホストから受け取った補助領域を組み合わせる画面。 */
export type DocsStorageModeScreenProps = {
  selecting?: boolean;
  error?: string | null;
  onRetry?: () => void;
  accountContent: ReactNode;
  recordingRescue: ReactNode;
} & (
  | { mode: "UNSET"; onSelectCloud: () => void }
  | { mode: "LOCAL"; onSelectCloud?: () => void }
);

export function DocsStorageModeScreen({ mode, selecting, error, onSelectCloud, onRetry, accountContent, recordingRescue }: DocsStorageModeScreenProps) {
  const [showAccount, setShowAccount] = useState(false);
  return (
    <div className="min-h-dvh bg-niho-docs-surface px-4 pb-[max(36px,env(safe-area-inset-bottom))] pt-[max(20px,env(safe-area-inset-top))]">
      <main className="mx-auto w-full max-w-2xl space-y-5">
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <span className="text-lg font-extrabold text-niho-text">NIHO docs</span>
          <button type="button" onClick={() => setShowAccount((value) => !value)} aria-expanded={showAccount}
            className="min-h-11 rounded-xl border border-niho-border bg-white px-4 text-body font-bold text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-dark/40">設定</button>
        </header>
        {showAccount ? <section aria-label="アカウント" className="rounded-2xl border border-niho-border bg-white p-4 sm:p-6"><h2 className="text-base font-extrabold text-niho-text">アカウント</h2>{accountContent}</section> : null}
        <section className="rounded-2xl border border-niho-border bg-white p-5 sm:p-7">
          <h1 className="text-xl font-extrabold leading-snug text-niho-text">{mode === "LOCAL" ? DOCS_STORAGE_WORDS.localWeb : "保存先を選んでください"}</h1>
          {mode === "LOCAL" ? (
            <p className="mt-3 text-body leading-relaxed text-niho-text-sub">ページとフォルダは Mac アプリで開けます。NIHO クラウドへ戻すときは、Mac アプリの設定から操作してください。</p>
          ) : (
            <>
              <p className="mt-3 text-body leading-relaxed text-niho-text-sub">Web やスマホでページと録音を使うには、NIHO クラウドを選んでください。この Mac だけに保存する場合は Mac アプリで選べます。</p>
              <button type="button" disabled={selecting || !onSelectCloud} onClick={onSelectCloud}
                className="niho-accent-surface mt-5 min-h-11 w-full rounded-xl px-4 text-body font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-dark/40 disabled:opacity-60 sm:w-auto">
                {selecting ? "保存先を確認中…" : "NIHO クラウドを選ぶ"}
              </button>
              <p className="mt-3 text-sub leading-relaxed text-niho-text-sub">Mac アプリで使う場合は、この画面では選ばず Mac アプリを開いてください。</p>
            </>
          )}
          {error ? <p role="alert" className="mt-3 break-words text-body text-niho-danger">{error} {onRetry ? <button type="button" onClick={onRetry} className="min-h-11 font-bold underline">読み直す</button> : null}</p> : null}
        </section>
        {recordingRescue}
      </main>
    </div>
  );
}
