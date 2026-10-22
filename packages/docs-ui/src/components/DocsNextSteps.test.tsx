/** @vitest-environment jsdom */

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DocsNextStepsBandView, DocsNextStepsEnd, DocsNextStepsSection, DocsRunMenu, type DocsNextStepsView } from "./DocsNextSteps";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rows: DocsNextStepsView["rows"] = [
  { stepId: "source", label: "文字起こし", status: "done", current: true, statusLabel: "このページ", openable: false },
  { stepId: "s1", label: "文字起こし修正", status: "todo", current: false, statusLabel: "未作成", openable: true },
  { stepId: "s2", label: "記事方針", status: "todo", current: false, statusLabel: "未作成", openable: true },
  { stepId: "s3", label: "記事本文", status: "todo", current: false, statusLabel: "未作成", openable: true },
];

function nextStepsTestView(overrides: Partial<DocsNextStepsView> = {}): DocsNextStepsView {
  return {
    rows,
    remaining: ["文字起こし修正", "記事方針", "記事本文"],
    running: false,
    summary: "残り 3",
    startable: true,
    reason: null,
    macGuide: false,
    checking: false,
    placeLine: "続きはクラウドで作ります",
    band: null,
    submitting: false,
    error: null,
    notice: null,
    start: vi.fn(),
    stop: vi.fn(),
    closeBand: vi.fn(),
    open: vi.fn(),
    ...overrides,
  };
}

function nextStepsDoneView(): DocsNextStepsView {
  return nextStepsTestView({
    rows: rows.map((row) => row.stepId === "source" ? row : { ...row, status: "done", statusLabel: "完了" }),
    remaining: [],
    summary: "すべて完了",
    placeLine: null,
  });
}

function nextStepsRunningView(): DocsNextStepsView {
  return nextStepsTestView({ running: true, startable: false, summary: "処理中", placeLine: null });
}

const roots: Root[] = [];

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => { root.render(node); });
  return container;
}

const buttonOf = (container: ParentNode, text: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === text || item.getAttribute("aria-label") === text);

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
});

describe("スマホの本文の末尾「次の工程」", () => {
  it("工程の列、主ボタン、場所の行、設定変更を表示する", async () => {
    const view = nextStepsTestView();
    const onOpenSettings = vi.fn();
    const container = await render(<DocsNextStepsEnd view={view} onOpenSettings={onOpenSettings} />);
    expect(container.querySelector("h2")?.textContent).toBe("次の工程");
    expect(Array.from(container.querySelectorAll('ol[aria-label="工程の進み具合"] li')).map((item) => item.textContent))
      .toEqual(["文字起こしこのページ", "文字起こし修正未作成", "記事方針未作成", "記事本文未作成"]);
    const primary = buttonOf(container, "続きを作成")!;
    expect(primary.className).toContain("w-full");
    expect(primary.disabled).toBe(false);
    await act(async () => { primary.click(); });
    expect(view.start).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("続きはクラウドで作ります");
    await act(async () => { buttonOf(container, "設定で変更")!.click(); });
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('[aria-label="工程の進み具合"]')).toHaveLength(1);
  });

  it("全部できていれば完了見出しになり、できた工程のページを開ける", async () => {
    const view = nextStepsDoneView();
    const container = await render(<DocsNextStepsEnd view={view} />);
    expect(container.querySelector("h2")?.textContent).toBe("すべての工程ができています");
    expect(buttonOf(container, "続きを作成")).toBeUndefined();
    expect(container.textContent).not.toContain("続きはクラウドで作ります");
    await act(async () => { buttonOf(container, "記事方針を開く")!.click(); });
    expect(view.open).toHaveBeenCalledWith("s2");
    expect(buttonOf(container, "文字起こしを開く")).toBeUndefined();
  });

  it("実行中・確認中・理由・エラー・Macアプリ案内を表示し、リンク先を差し替えられる", async () => {
    const running = await render(<DocsNextStepsEnd view={nextStepsRunningView()} />);
    const primary = buttonOf(running, "処理中…")!;
    expect(primary.disabled).toBe(true);
    expect(running.textContent).not.toContain("続きはクラウドで作ります");

    const reason = "途中までの工程が保存済みのため、Macアプリで続けてください。";
    const blocked = await render(<DocsNextStepsEnd view={nextStepsTestView({ startable: false, reason, macGuide: true, error: "受付できませんでした。", notice: "処理できませんでした" })} />);
    expect(buttonOf(blocked, "続きを作成")!.disabled).toBe(true);
    expect(blocked.textContent).toContain(reason);
    expect(blocked.querySelector('a[href="/docs/download"]')?.textContent).toContain("Macアプリで続ける");
    expect(blocked.querySelector('[role="alert"]')?.textContent).toBe("受付できませんでした。");
    expect(blocked.textContent).toContain("処理できませんでした");

    const custom = await render(<DocsNextStepsEnd view={nextStepsTestView({ macGuide: true })} macAppHref="/custom/mac-download" />);
    expect(custom.querySelector("a")?.getAttribute("href")).toBe("/custom/mac-download");

    const checking = await render(<DocsNextStepsEnd view={nextStepsTestView({ startable: false, checking: true })} />);
    expect(checking.textContent).toContain("利用条件を確認しています...");
    expect(buttonOf(checking, "続きを作成")!.disabled).toBe(true);
  });
});

describe("本文の上の帯", () => {
  it("処理中は止める、完了時は閉じるを呼び出す", async () => {
    const onStop = vi.fn();
    const onClose = vi.fn();
    const running = await render(<DocsNextStepsBandView band={{ kind: "running", stepName: "記事方針", place: "クラウドで作っています" }} onStop={onStop} onClose={onClose} />);
    expect(running.textContent).toBe("処理中: 記事方針 · クラウドで作っています止める");
    await act(async () => { buttonOf(running, "止める")!.click(); });
    expect(onStop).toHaveBeenCalledOnce();

    const done = await render(<DocsNextStepsBandView band={{ kind: "done", names: ["記事方針", "記事本文"] }} onStop={onStop} onClose={onClose} />);
    expect(done.textContent).toBe("記事方針・記事本文 を作りました。閉じる");
    await act(async () => { buttonOf(done, "閉じる")!.click(); });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("PC向けの工程セクションと続きのメニュー", () => {
  it("工程セクションを折り畳める", async () => {
    const container = await render(<DocsNextStepsSection view={nextStepsTestView()} />);
    const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(body.hidden).toBe(true);
  });

  it("理由・実行中の状態を添え書きに出し、続きの開始を呼び出す", async () => {
    const onPick = vi.fn();
    const reasoned = await render(<DocsRunMenu view={nextStepsTestView({ startable: false, reason: "クラウドの AI を今は利用できません。Macアプリで続けられます。" })} onPick={onPick} />);
    const item = reasoned.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.disabled).toBe(true);
    expect(item.textContent).toBe("続きを作成クラウドの AI を今は利用できません。Macアプリで続けられます。");
    await act(async () => { item.click(); });
    expect(onPick).not.toHaveBeenCalled();

    const ready = await render(<DocsRunMenu view={nextStepsTestView()} onPick={onPick} />);
    await act(async () => { ready.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click(); });
    expect(onPick).toHaveBeenCalledOnce();

    const single = await render(<DocsRunMenu view={nextStepsTestView({ remaining: ["記事本文"] })} onPick={onPick} />);
    expect(single.querySelector('[role="menuitem"]')!.textContent).toBe("続きを作成");
  });

  it("受付送信中は開始項目を押せない", async () => {
    const onPick = vi.fn();
    const container = await render(<DocsRunMenu view={nextStepsTestView({ submitting: true, startable: true })} onPick={onPick} />);
    const item = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.disabled).toBe(true);
    await act(async () => { item.click(); });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("渡された状態の概要を表示する", async () => {
    const summaryOf = async (view: DocsNextStepsView) => {
      const container = await render(<DocsNextStepsSection view={view} />);
      return container.querySelector("button[aria-expanded]")!.textContent;
    };
    expect(await summaryOf(nextStepsTestView())).toBe("工程残り 3");
    expect(await summaryOf(nextStepsDoneView())).toBe("工程すべて完了");
    expect(await summaryOf(nextStepsRunningView())).toBe("工程処理中");
  });
});
