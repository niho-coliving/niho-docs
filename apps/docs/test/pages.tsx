import { act } from "react";
import { expect } from "vitest";
import { ROOT_RECORDING_ID, SOURCE_STEP_ID, countChars, createBlankFlow, createFlowSnapshot, defaultProfiles, type Recording, type RunRecord, type Step } from "@niho/docs-core";
import { DOCS_ROOT_PROJECT_ID } from "../src/lib/cloud-types";
import { finalizeMarkdown } from "../src/lib/markdown";
import { button, click, typeInto } from "./dom";
import type { FakeBridge } from "./fake-bridge";

/** ページの画面（#18564 P1）をテストで押すための小道具（レール・パンくず・録音のページ）。 */

/** レールの行（フォルダ・背景情報・ページ・成果物の子ページ）を表示名で探す。 */
export function railItem(container: HTMLElement, name: string): HTMLButtonElement {
  const items = [...container.querySelectorAll<HTMLButtonElement>(".rail .ti")];
  const found = items.find((item) => item.querySelector(".t")?.textContent === name);
  if (!found) throw new Error(`rail item not found: ${name} / ${items.map((item) => item.querySelector(".t")?.textContent).join(" | ")}`);
  return found;
}

/** レールのフォルダの中の文書の行（背景情報と成果物を除く。並び順）。 */
export function railPages(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".rail .trow.d1:not(.out) .ti .t")]
    .map((item) => item.textContent ?? "")
    .filter((name) => name !== "背景情報");
}

/**
 * レールの成果物の子ページ（並び順）。フォルダの録音は行を出さず、成果物をフォルダの直下に文書と同じ深さで並べる（#18914）。
 * ホームの録音は録音の行の下。
 */
export function railChildren(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".rail .trow.out .ti .t")].map((item) => item.textContent ?? "");
}

/** フォルダの中の行（背景情報を除く。文書と成果物を並び順に）。 */
export function railFolderRows(folder: HTMLElement): string[] {
  return [...folder.querySelectorAll(".trow.d1 .ti .t")]
    .map((item) => item.textContent ?? "")
    .filter((name) => name !== "背景情報");
}

/** レールのフォルダ（div.case）をフォルダ名で探す。 */
export function railFolder(container: HTMLElement, name: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(".rail div.case")].find((folder) => folder.querySelector(":scope > .trow .ti.case .t")?.textContent === name);
  if (!found) throw new Error(`rail folder not found: ${name}`);
  return found;
}

/** フォルダの「背景情報」の行（フォルダ名を省くと開いているフォルダか、先頭のフォルダ）。押すと背景情報のページ（音声の欄）が開く。 */
export function infoItem(container: HTMLElement, folderName?: string): HTMLButtonElement {
  const folder = folderName
    ? railFolder(container, folderName)
    : container.querySelector('.rail [aria-current="page"]')?.closest<HTMLElement>("div.case") ?? container.querySelector<HTMLElement>(".rail div.case");
  const found = [...(folder?.querySelectorAll<HTMLButtonElement>(".trow.d1 .ti") ?? [])].find((item) => item.querySelector(".t")?.textContent === "背景情報");
  if (!found) throw new Error(`info item not found: ${folderName ?? "(open folder)"}`);
  return found;
}

/** 背景情報のページを開く（フォルダの音声の欄。以前の録音のページ。#18914）。 */
export async function openAudio(container: HTMLElement, folderName?: string) {
  await click(infoItem(container, folderName));
}

/** レールで選んでいる行。 */
export function railCurrent(container: HTMLElement): string | null {
  const selected = container.querySelector('.rail [aria-current="page"]');
  if (selected?.classList.contains("case") && container.querySelector(".pg.folder-home")) return "背景情報";
  return selected?.querySelector(".t")?.textContent ?? null;
}

/**
 * 成果物の行（フォルダの録音はレールのフォルダの直下の行。#18914。ホームの録音は録音のページの「この録音から作ったページ」の列）。できている工程と
 * 実行中の工程だけがある。
 */
export function outputRow(container: HTMLElement, name: string): HTMLButtonElement {
  // 開いているフォルダがあれば、そのフォルダの成果物から探す（ほかのフォルダにも同じ名前の工程がある）
  const current = container.querySelector('.rail [aria-current="page"]')?.closest<HTMLElement>("div.case");
  const rows = [
    ...(current ?? container).querySelectorAll<HTMLButtonElement>(current ? ".trow.out .ti" : ".rail .trow.out .ti"),
    ...container.querySelectorAll<HTMLButtonElement>(".orow"),
  ];
  const found = rows.find((row) => row.querySelector(".t")?.textContent === name);
  if (!found) throw new Error(`output row not found: ${name} / ${rows.map((row) => row.querySelector(".t")?.textContent).join(" | ")}`);
  return found;
}

/** 成果物の行があるか（まだ無い工程の行は出さない）。 */
export function hasOutputRow(container: HTMLElement, name: string): boolean {
  return [...container.querySelectorAll(".rail .trow.out .ti .t, .orow .t")].some((item) => item.textContent === name);
}

/** タイトルの入力欄。 */
export function titleInput(container: HTMLElement): HTMLTextAreaElement {
  const found = container.querySelector<HTMLTextAreaElement>('textarea.ptitle[aria-label="タイトル"]');
  if (!found) throw new Error("title not found");
  return found;
}

/** 「AIと作る」の開閉のボタン（タイトルバーの右端。無ければ null。名前は「AIと作る（作業中）」などにもなる）。 */
export function chatToggle(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(".window-titlebar .acts button.chat-toggle");
}

/** 「AIと作る」を開く（開いていれば何もしない）。 */
export async function openChat(container: HTMLElement) {
  const toggle = chatToggle(container);
  expect(toggle, "AIと作る の開閉のボタン").not.toBeNull();
  if (toggle!.getAttribute("aria-pressed") !== "true") await click(toggle!);
}

/** タイトルバーの ⋯（無ければ null）。 */
export function pageMenuButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('.window-titlebar .acts .pagemenu > button[aria-label="その他"]');
}

/** タイトルバーの ⋯ を開いて、そのメニューを返す（開いていればそのまま）。 */
export async function openPageMenu(container: HTMLElement): Promise<HTMLElement> {
  const trigger = pageMenuButton(container);
  expect(trigger, "タイトルバーの ⋯").not.toBeNull();
  if (trigger!.getAttribute("aria-expanded") !== "true") await click(trigger!);
  return container.querySelector<HTMLElement>('.window-titlebar .acts .pagemenu > .pop[role="menu"]')!;
}

/** ⋯ の項目（「検索」「書式を表示」「書き出し」など。押せるかどうかは問わない）。 */
export function pageMenuItems(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"]')].map((item) => item.firstChild?.textContent?.trim() ?? "");
}

/** ⋯ の項目を名前で押す（「検索」「書式を表示」など）。 */
export async function pageMenuAction(container: HTMLElement, name: string) {
  const menu = await openPageMenu(container);
  const item = [...menu.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"]')].find((candidate) => candidate.firstChild?.textContent?.trim() === name);
  expect(item, `⋯ の「${name}」`).toBeDefined();
  await click(item!);
}

/** ⋯ → 書き出し › を開いて、そのサブメニューを返す。 */
export async function openExportMenu(container: HTMLElement): Promise<HTMLElement> {
  const menu = await openPageMenu(container);
  const trigger = [...menu.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"]')].find((item) => item.textContent?.startsWith("書き出し"));
  expect(trigger, "⋯ の「書き出し ›」").toBeDefined();
  if (trigger!.getAttribute("aria-expanded") !== "true") await click(trigger!);
  return menu.querySelector<HTMLElement>('.submenu[aria-label="書き出し"]')!;
}

/** ⋯ → 書き出し › → 項目を押す。 */
export async function exportFromMenu(container: HTMLElement, item: "コピー" | ".md で保存" | "Google ドキュメント" | "Finder で表示" | "リンクで共有") {
  await click(button(await openExportMenu(container), item));
}

/** 録音から作ったページのタイトルバーの ⋯ を開き（開いていなければ）、その「作り直す」を返す（#18915）。 */
export async function rebuildItem(container: HTMLElement): Promise<HTMLButtonElement> {
  const pop = () => container.querySelector<HTMLElement>(".window-titlebar .acts .pagemenu .pop");
  if (!pop()) await click(container.querySelector<HTMLButtonElement>('.window-titlebar .acts .pagemenu button[aria-label="その他"]')!);
  return button(pop()!, "作り直す");
}

/** 録音から作ったページのタイトルバーの ⋯ →「作り直す」（以前のメタ行の「再実行」）。 */
export async function rebuild(container: HTMLElement) {
  await click(await rebuildItem(container));
}

/** 開いている子ページの版を「第 N 版」で返す（履歴の、開いている行。最新を開いていれば先頭の行）。履歴が無ければ null。 */
export async function shownVersion(container: HTMLElement): Promise<string | null> {
  const trigger = container.querySelector<HTMLButtonElement>('.window-titlebar .acts button[aria-label="履歴"]');
  if (!trigger) return null;
  await click(trigger);
  const rows = [...container.querySelectorAll(".pop.hist .hrow")];
  const row = rows.find((item) => item.classList.contains("on")) ?? rows[0];
  const number = /版 (\d+)/.exec(row?.querySelector("b")?.textContent ?? "")?.[1] ?? null;
  await click(trigger);
  return number === null ? null : `第 ${number} 版`;
}

/** タイトルバーのアプリ名（押すとホーム。レールに「ホーム」の行は無い。#18929）。 */
export function homeButton(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('.window-titlebar button[aria-label="NIHO docs ホームへ"]');
  if (!found) throw new Error("home button not found");
  return found;
}

/** タイトルバーのレールの右端の新規作成の ＋ から ページ・音声・フォルダ を選ぶ（作る場所は開いている場所。#18867・#18929）。 */
export async function newFromMenu(container: HTMLElement, item: "ページ" | "音声" | "フォルダ") {
  await click(container.querySelector<HTMLButtonElement>(".window-titlebar .tb-new")!);
  await click(button(container.querySelector<HTMLElement>(".window-titlebar .new-menu .pop")!, item));
}

/** 新規作成の ＋ → フォルダ（無題で作ってフォルダのホームを開き、題にフォーカスする）。 */
export async function newFolder(container: HTMLElement) {
  await newFromMenu(container, "フォルダ");
}

/** フォルダの行の ＋（〈フォルダ名〉に追加）から ページ か 音声 を足す。 */
export async function addPageInFolder(folder: HTMLElement, kind: "ページ" | "音声") {
  await click(folder.querySelector<HTMLButtonElement>(":scope > .trow .addpage > button")!);
  await click(button(folder.querySelector<HTMLElement>(":scope > .trow .addpage .pop")!, kind));
}

/** 今開いているフォルダならその行の ＋、それ以外（フォルダの外・ホーム）は新規作成の ＋ から ページ か 音声 を足す。 */
export async function addPage(container: HTMLElement, kind: "ページ" | "音声") {
  const currentFolder = container.querySelector('.rail [aria-current="page"]')?.closest<HTMLElement>("div.case");
  if (currentFolder) await addPageInFolder(currentFolder, kind);
  else await newFromMenu(container, kind);
}

/** 新しいフォルダを作り、その場で名前を付け、フォルダの行の ＋ から文書を 1 枚足す。 */
export async function createProjectByName(container: HTMLElement, name: string) {
  await newFolder(container);
  await typeInto(titleInput(container), name);
  await act(async () => {
    titleInput(container).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
  const folder = railItem(container, name).closest<HTMLElement>("div.case")!;
  await addPageInFolder(folder, "ページ");
  await until(() => railCurrent(container) === "無題");
}

/**
 * いちばん新しい素材の無い録音のページを、文章の録音にする（以前に貼った文章の録音の下ごしらえ。画面の「文章を貼る」は、
 * 素材を「ファイルを選択」「この Mac で録音」の 2 択にするためにやめた。owner 2026-10-18）。画面へは別の Mac の変更が届いたときと同じ
 * 知らせ（cloud の applied）で読み直させる。
 */
export async function seedText(bridge: FakeBridge, container: HTMLElement, text: string) {
  const empty = [...bridge.projects.values(), bridge.outside].flatMap((stored) =>
    Object.entries(stored.recordings)
      .filter(([, found]) => found.recording.source.kind === "audio" && found.recording.source.audio.length === 0 && found.transcript === null)
      .map(([recordingId]) => ({ projectId: stored === bridge.outside ? null : stored.project.id, recordingId })),
  );
  const order = (id: string) => Number(id.replace(/^\D+/, ""));
  const target = empty.sort((a, b) => order(b.recordingId) - order(a.recordingId))[0];
  if (!target) throw new Error("素材の無い録音のページがありません");
  const body = finalizeMarkdown(text);
  const record: RunRecord = {
    id: `save-${target.recordingId}`, kind: "save", at: new Date().toISOString(), stepId: SOURCE_STEP_ID, stepName: "文章",
    version: null, result: "saved", outputChars: countChars(body),
  };
  await act(() => bridge.setRecordingText(target, body, record));
  await act(async () => bridge.emitCloudApplied(target.projectId ?? DOCS_ROOT_PROJECT_ID, [`recordings/${target.recordingId}/recording.json`]));
  await until(() => container.querySelector(".afile .nm")?.textContent?.startsWith("文章 · ") ?? false);
}

/** 非同期の連鎖（と逐次表示の間引き）が終わるまで待つ（条件が満たされるまで、最大 2 秒）。 */
export async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(condition()).toBe(true);
}

/** 前に工程を実行した記録と成果物を置く（その工程の版 1）。 */
export async function seedRun(
  bridge: FakeBridge,
  projectId: string,
  step: Pick<Step, "id" | "name">,
  markdown: string,
  recordingId: string = ROOT_RECORDING_ID,
  at = "2026-10-15T00:01:00.000Z",
): Promise<RunRecord> {
  const record: RunRecord = {
    id: `run-${step.id}`,
    kind: "run",
    at,
    stepId: step.id,
    stepName: step.name,
    version: null,
    result: "saved",
    provider: "claude",
    model: "claude-sonnet-4-6",
    effort: "high",
    profile: "標準",
  };
  await bridge.saveArtifact({ projectId, recordingId }, step.id, false, markdown, record);
  return record;
}

// ---- 工程設計のフローの一覧（#18567 P4） ----

/** フローの一覧の行（名前・工程の数・開いているか・未保存の印）。 */
export function flowRows(container: HTMLElement): Array<{ name: string; steps: string; current: boolean; unsaved: boolean }> {
  return [...container.querySelectorAll<HTMLElement>(".flist .frow")].map((row) => ({
    name: row.querySelector(".nm")?.textContent ?? "",
    steps: row.querySelector(".cnt")?.textContent ?? "",
    current: row.querySelector(".fgo")?.getAttribute("aria-current") === "true",
    unsaved: row.querySelector(".pill") !== null,
  }));
}

/** フローの一覧の行のボタン（押すとそのフローを開く）。 */
export function flowRow(container: HTMLElement, name: string): HTMLButtonElement {
  const rows = [...container.querySelectorAll<HTMLButtonElement>(".flist .frow .fgo")];
  const found = rows.find((row) => row.querySelector(".nm")?.textContent === name);
  if (!found) throw new Error(`flow row not found: ${name} / ${rows.map((row) => row.querySelector(".nm")?.textContent).join(" | ")}`);
  return found;
}

/** フローの一覧の行の ⋯ から 複製・名前の変更・削除 を押す。 */
export async function flowRowMenu(container: HTMLElement, name: string, item: "複製" | "名前の変更" | "削除") {
  const row = flowRow(container, name).closest<HTMLElement>(".frow")!;
  await click(row.querySelector(`button[aria-label="「${name}」のその他"]`)!);
  await click(button(row.querySelector<HTMLElement>(".pop")!, item));
}

/** 「＋ 追加」からテンプレートか白紙を選ぶ。 */
export async function addFlow(container: HTMLElement, item: string) {
  await click(button(container.querySelector<HTMLElement>(".flist")!, "＋ 追加"));
  await click(button(container.querySelector<HTMLElement>('.flist [role="menu"][aria-label="追加する工程"]')!, item));
}

/** 録音のページの「工程」の選択。 */
export function flowSelect(container: HTMLElement): HTMLSelectElement {
  const found = container.querySelector<HTMLSelectElement>('select[aria-label="工程"]');
  if (!found) throw new Error("flow select not found");
  return found;
}

/**
 * 工程が 0 本の録音（工程が無かった頃に作った、白紙の工程の録音）を、画面を開く前に置く。いまの「＋ → 録音・音声」も窓へのドロップも、
 * 工程が 1 つも無ければ先に「工程を選ぶ」を出す（#18753・#18789）ので、この形の録音は新しくは作られない。
 */
export async function seedBlankRecording(bridge: FakeBridge, folderName: string) {
  const project = await bridge.createProject(
    { version: 1, id: "", name: folderName, createdAt: "2026-10-16T00:00:00Z", info: { terms: [], background: "" }, pages: [] },
    null,
    null,
    [],
  );
  const recording: Recording = {
    version: 1,
    id: "",
    createdAt: "2026-10-16T00:00:00Z",
    flowSnapshot: createFlowSnapshot(createBlankFlow("blank-seed"), defaultProfiles(), ["claude"]),
    source: { kind: "audio", audio: [] },
    speakers: "auto",
    language: "ja",
    refs: [],
  };
  await bridge.createPage(project.id, { kind: "rec", title: "最初の録音", createdAt: "2026-10-16T00:00:00Z", recording });
}
