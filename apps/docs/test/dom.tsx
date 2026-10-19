import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App";
import { DesktopShell } from "../src/components/WindowTitlebar";
import { folderName, projectPages } from "@niho/docs-core";
import type { FakeBridge } from "./fake-bridge";
import type { AccountTransport } from "niho-desktop-account/account-bridge";

/** jsdom で App を描いて押す・書くための小道具。 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom の Range には座標が無い。App の本文エディタ（ProseMirror の scrollIntoView）が非同期に読むと、テストの外で
// 未処理例外になり実行全体が落ちる。block-editor-helpers.ts と同じく 0 の矩形を返す。
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function getClientRects() {
    return [] as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return new DOMRect(0, 0, 0, 0);
  };
}

export type Screen = {
  container: HTMLDivElement;
  unmount: () => void;
};

// 本人実行は flush → sync → Native material → reserve → guard を同じ operation で順に固定し、各段で SHA-256 を取る。
// WebCrypto の digest は Node のスレッドプールで完了するため、microtask を何回回しても終わる保証が無く、
// 回数で待つと CI のような遅い環境で検証が早すぎて落ちる。実行中の digest を数え、0 のまま静まるまで待つ。
let pendingDigests = 0;

function trackDigests() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || (subtle.digest as { tracked?: boolean }).tracked) return;
  const original = subtle.digest.bind(subtle);
  const tracked = ((...args: Parameters<SubtleCrypto["digest"]>) => {
    pendingDigests += 1;
    return original(...args).finally(() => {
      pendingDigests -= 1;
    });
  }) as SubtleCrypto["digest"] & { tracked?: boolean };
  tracked.tracked = true;
  Object.defineProperty(subtle, "digest", { value: tracked, configurable: true, writable: true });
}

trackDigests();

const SETTLE_QUIET_TURNS = 16;
const SETTLE_LIMIT_MS = 30_000;

export async function settle() {
  const deadline = Date.now() + SETTLE_LIMIT_MS;
  let quiet = 0;
  while (quiet < SETTLE_QUIET_TURNS) {
    await act(async () => {
      await Promise.resolve();
    });
    quiet = pendingDigests === 0 ? quiet + 1 : 0;
    if (Date.now() > deadline) throw new Error(`settle: ${SETTLE_LIMIT_MS}ms 待っても非同期処理が収まりません（digest ${pendingDigests} 件）`);
  }
}

export async function renderApp(
  bridge: FakeBridge,
  options: { autoOpen?: boolean; openChat?: boolean } | AccountTransport = {},
): Promise<Screen> {
  const accountTransport = "invoke" in options ? options : undefined;
  const autoOpen = !("autoOpen" in options) || options.autoOpen !== false;
  const openChat = !("openChat" in options) || options.openChat !== false;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<DesktopShell><App bridge={bridge} accountTransport={accountTransport} /></DesktopShell>);
  });
  await settle();
  // P7 以降の本番起動はホーム。P1〜P6 の既存テストは対象ページの検証へ直接進めるため、seed 済みなら開く。
  if (autoOpen) {
    const folder = container.querySelector<HTMLButtonElement>(".rail .case .ti.case");
    // レールはフォルダが先・フォルダの外のページが後（#18867）。既存のテストが前提にしてきた「フォルダの外のページを先に開く」を保つ
    const rows = [...container.querySelectorAll<HTMLButtonElement>(".rail .trow > .ti:not(.case)")];
    const outsidePage = rows.find((item) => !item.closest(".case") && !/\bd[123]\b/.test(item.closest(".trow")?.className ?? ""));
    // フォルダは先頭のページを開く。録音が先頭なら背景情報のページ（フォルダの録音は行を出さない。#18914）
    const firstFolder = folder?.closest<HTMLElement>("div.case") ?? null;
    const firstName = firstFolder?.querySelector(":scope > .trow .ti.case .t")?.textContent ?? null;
    const stored = firstName ? [...bridge.projects.values()].find((item) => folderName(item.project) === firstName) : undefined;
    const firstPage = stored ? projectPages(stored.project)[0] : undefined;
    const folderRows = [...(firstFolder?.querySelectorAll<HTMLButtonElement>(".trow.d1 > .ti") ?? [])];
    const info = folderRows.find((item) => item.querySelector(".t")?.textContent === "背景情報");
    const firstDoc = folderRows.find((item) => !item.closest(".trow")?.classList.contains("out") && item !== info);
    const page = outsidePage ?? (firstPage?.kind === "rec" ? info : firstPage ? firstDoc ?? info : undefined);
    const target = page ?? folder;
    if (target) {
      await act(async () => target.click());
      await settle();
    }
  }
  // 「AIと作る」は閉じて始まる（owner 2026-10-18・#18941）。既存のテストは開いた右の列を見るので、開閉のボタンがあるページに
  // 着いたら開く（同じ起動中はページを移っても開いたまま）。閉じて始まることは pages.test の専用のテストで見る
  if (openChat) {
    const toggle = container.querySelector<HTMLButtonElement>('.window-titlebar .acts button.chat-toggle[aria-pressed="false"]');
    if (toggle) {
      await act(async () => toggle.click());
      await settle();
    }
  }
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

export function buttons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")];
}

export function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = buttons(container).find((candidate) => candidate.textContent?.trim() === text) ??
    buttons(container).find((candidate) => candidate.textContent?.includes(text));
  if (!found) throw new Error(`button not found: ${text} / ${buttons(container).map((candidate) => candidate.textContent).join(" | ")}`);
  return found;
}

export async function click(target: Element) {
  await act(async () => {
    (target as HTMLElement).click();
  });
  await settle();
}

/** React が見ている value を書き換えて input を起こす。 */
export async function typeInto(target: Element, value: string) {
  const element = target as HTMLInputElement | HTMLTextAreaElement;
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

export async function selectOption(target: Element, value: string) {
  const element = target as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}
