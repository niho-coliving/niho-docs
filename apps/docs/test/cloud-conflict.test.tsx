// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ConflictDialog } from "../src/components/ConflictDialog";
import type { ConflictEntry } from "../src/lib/cloud-types";
import { button, click, typeInto } from "./dom";
import { FakeBridge, conflictEntryOf } from "./fake-bridge";

/**
 * 変更の確認（C3 #18595。spec niho-docs-cloud §8.1）: 両側を並べて選ぶ。選んだ内容で cloudResolveConflict を呼び（クラウド側の
 * sha256 を添える）、両方を編集して保存・削除と編集の競合・確かめている間にクラウドがまた変わったとき。
 */

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);

afterEach(() => {
  act(() => root.render(null));
});

async function settle() {
  for (let index = 0; index < 8; index++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const PROJECT = "p1";

function setup(entries: ConflictEntry[], copies: Record<string, { local: string | null; remote: string | null }>) {
  const bridge = new FakeBridge();
  bridge.conflictEntries.set(PROJECT, entries);
  for (const [id, sides] of Object.entries(copies)) bridge.conflictCopies.set(id, sides);
  const resolved: string[] = [];
  let closed = 0;
  const show = (path: string | null = null) =>
    act(async () => {
      root.render(
        <ConflictDialog
          bridge={bridge}
          projectId={PROJECT}
          path={path}
          labelOf={(target) => (target === "pages/doc1.md" ? "事前メモ" : target === "pages/doc2.md" ? "ふりかえり" : "フォルダの情報")}
          onResolved={(target) => resolved.push(target)}
          onClose={() => (closed += 1)}
        />,
      );
    });
  return { bridge, resolved, show, closed: () => closed };
}

function dialog(): HTMLElement {
  return container.querySelector<HTMLElement>('[role="dialog"]')!;
}

function resolveCalls(bridge: FakeBridge) {
  return bridge.cloudCallsOf("cloudResolveConflict");
}

describe("変更の確認", () => {
  it("両側を並べ（この Mac・クラウドと日時）、「このMacの内容を使う」はクラウド側の sha256 を添えて解決する", async () => {
    const { bridge, resolved, show, closed } = setup(
      [conflictEntryOf({ conflictId: "cf-internal-7", path: "pages/doc1.md", remoteSha256: "f".repeat(64) })],
      { "cf-internal-7": { local: "この Mac で書いた", remote: "別の Mac で書いた" } },
    );
    await show("pages/doc1.md");
    await settle();
    expect(dialog().querySelector("h2")?.textContent).toBe("変更の確認");
    const sides = [...dialog().querySelectorAll(".cfside")];
    // クラウド側はどの端末で変わったかを添える（既定の競合は別の Mac。端末 ID が d_）
    expect(sides.map((side) => side.querySelector("h3")?.textContent)).toEqual([
      expect.stringMatching(/^この Mac\d+\/\d+ \d\d:\d\d$/),
      expect.stringMatching(/^クラウド（別の Mac で変更）\d+\/\d+ \d\d:\d\d$/),
    ]);
    expect(dialog().querySelector(".msg")?.textContent).toContain("この Mac と別の Mac の両方で変更されました。使う内容を選んでください。");
    expect(sides.map((side) => side.querySelector("pre")?.textContent)).toEqual(["この Mac で書いた", "別の Mac で書いた"]);
    // 内部の id・path は出さない
    expect(dialog().textContent).not.toContain("cf-internal");
    expect(dialog().textContent).not.toContain("pages/");
    await click(button(dialog(), "このMacの内容を使う"));
    expect(resolveCalls(bridge)).toEqual([[PROJECT, "cf-internal-7", "local", null, "f".repeat(64)]]);
    expect(resolved).toEqual(["pages/doc1.md"]);
    expect(closed()).toBe(1);
  });

  it("クラウド側を変えた端末を名指す（スマホ・PC のブラウザ・種類の無いブラウザ・分からない端末）。再起動時の食い違いは名指さない", async () => {
    const file = (writerDeviceId: string, writerDeviceKind?: "mac" | "browser" | "phone") => ({
      path: "pages/doc1.md", sha256: "r".repeat(64), bytes: 4, kind: "text" as const, modifiedAt: "2026-10-16T01:00:00.000Z",
      writerDeviceId, ...(writerDeviceKind ? { writerDeviceKind } : {}),
    });
    const cases: Array<[Partial<ConflictEntry>, string, string]> = [
      [{ remoteDeviceId: "pwa_phone", remoteFile: file("pwa_phone", "phone") }, "クラウド（スマホで変更）", "この Mac とスマホの両方で変更されました。"],
      [{ remoteDeviceId: "pwa_desktop", remoteFile: file("pwa_desktop", "browser") }, "クラウド（PC のブラウザで変更）", "この Mac とPC のブラウザの両方で変更されました。"],
      [{ remoteDeviceId: "pwa_legacy", remoteFile: file("pwa_legacy") }, "クラウド（ブラウザで変更）", "この Mac とブラウザの両方で変更されました。"],
      [{ remoteDeviceId: "docs-run", remoteFile: file("docs-run") }, "クラウド（別の端末で変更）", "この Mac と別の端末の両方で変更されました。"],
      [{ origin: "recovery", remoteDeviceId: "d_this_mac", remoteFile: file("d_this_mac", "mac") }, "クラウド", "この Mac とクラウドの両方で変更されました。"],
    ];
    for (const [fields, heading, message] of cases) {
      const { show } = setup([conflictEntryOf({ conflictId: "c1", path: "pages/doc1.md", ...fields })], { c1: { local: "手元", remote: "クラウド" } });
      await show("pages/doc1.md");
      await settle();
      expect(dialog().querySelectorAll(".cfside h3")[1]?.textContent?.replace(/\d+\/\d+ \d\d:\d\d$/, "")).toBe(heading);
      expect(dialog().querySelector(".msg")?.textContent).toContain(`${message}使う内容を選んでください。`);
      // ボタンの言葉は変えない
      expect(button(dialog(), "クラウドの内容を使う")).toBeTruthy();
      act(() => root.render(null));
    }
  });

  it("「クラウドの内容を使う」", async () => {
    const { bridge, show } = setup([conflictEntryOf({ conflictId: "c1", path: "pages/doc1.md" })], {
      c1: { local: "手元", remote: "クラウド" },
    });
    await show("pages/doc1.md");
    await settle();
    await click(button(dialog(), "クラウドの内容を使う"));
    expect(resolveCalls(bridge)).toEqual([[PROJECT, "c1", "remote", null, "r".repeat(64)]]);
  });

  it("「両方を編集して保存」はこの Mac の内容から直し、クラウドの内容を横に出して「この内容で保存」", async () => {
    const { bridge, show } = setup([conflictEntryOf({ conflictId: "c1", path: "pages/doc1.md" })], {
      c1: { local: "手元の本文", remote: "クラウドの本文" },
    });
    await show("pages/doc1.md");
    await settle();
    await click(button(dialog(), "両方を編集して保存"));
    const textarea = dialog().querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toBe("手元の本文");
    expect(dialog().querySelector(".cfside pre")?.textContent).toBe("クラウドの本文");
    // ラベル（この Mac）で欄を指す
    expect(dialog().querySelector(`label[for="${textarea.id}"]`)?.textContent).toBe("この Mac");
    await typeInto(textarea, "手元の本文とクラウドの本文");
    await click(button(dialog(), "この内容で保存"));
    expect(resolveCalls(bridge)).toEqual([[PROJECT, "c1", "merged", "手元の本文とクラウドの本文", "r".repeat(64)]]);
  });

  it("JSON（フォルダの情報）は片方を選ぶだけ（両方を編集して保存は出さない）", async () => {
    const { show } = setup([conflictEntryOf({ conflictId: "c1", path: "project.json" })], {
      c1: { local: '{"name":"朝市"}', remote: '{"name":"朝市 2"}' },
    });
    await show();
    await settle();
    expect(dialog().textContent).toContain("フォルダの情報");
    expect([...dialog().querySelectorAll(".cfacts button")].map((item) => item.textContent)).toEqual([
      "やめる",
      "このMacの内容を使う",
      "クラウドの内容を使う",
    ]);
  });

  it("削除と編集の競合は「残す」「削除する」（削除は赤字）", async () => {
    const { bridge, show } = setup(
      [
        conflictEntryOf({ conflictId: "c1", path: "pages/doc1.md", kind: "remoteDeletedLocalEdited", remoteSha256: null }),
        conflictEntryOf({ conflictId: "c2", path: "pages/doc2.md", kind: "localDeletedRemoteEdited" }),
      ],
      { c1: { local: "手元で直した本文", remote: null }, c2: { local: null, remote: "クラウドで直した本文" } },
    );
    await show();
    await settle();
    // 2 件あるので選べる（名前で。id は出さない）
    expect([...dialog().querySelectorAll(".cflist button")].map((item) => [item.textContent, item.getAttribute("aria-pressed")])).toEqual([
      ["事前メモ", "true"],
      ["ふりかえり", "false"],
    ]);
    expect(dialog().textContent).toContain("片方で削除され、もう片方で変更されました。");
    expect([...dialog().querySelectorAll(".cfside")].map((side) => side.textContent)).toEqual([
      expect.stringContaining("手元で直した本文"),
      expect.stringContaining("削除されました"),
    ]);
    expect(button(dialog(), "削除する").className).toContain("stop");
    await click(button(dialog(), "残す"));
    expect(resolveCalls(bridge)).toEqual([[PROJECT, "c1", "keep", null, null]]);
    // 残りの 1 件に移る
    await settle();
    expect(dialog().querySelector(".cflist")).toBeNull();
    expect([...dialog().querySelectorAll(".cfside")].map((side) => side.textContent)).toEqual([
      expect.stringContaining("削除されました"),
      expect.stringContaining("クラウドで直した本文"),
    ]);
    await click(button(dialog(), "削除する"));
    expect(resolveCalls(bridge).at(-1)).toEqual([PROJECT, "c2", "delete", null, "r".repeat(64)]);
  });

  it("確かめている間にクラウドがまた変わったら、知らせて両側を読み直す（選んだ内容では保存しない）", async () => {
    const { bridge, resolved, show, closed } = setup([conflictEntryOf({ conflictId: "c1", path: "pages/doc1.md" })], {
      c1: { local: "手元", remote: "クラウド 1" },
    });
    await show("pages/doc1.md");
    await settle();
    bridge.resolveFailure = { code: "conflict_changed", message: "クラウドの内容がまた変わりました。もう一度確かめてください。" };
    bridge.conflictCopies.set("c1", { local: "手元", remote: "クラウド 2" });
    bridge.conflictEntries.set(PROJECT, [conflictEntryOf({ conflictId: "c1", path: "pages/doc1.md", remoteSha256: "2".repeat(64), updatedAt: "2026-10-16T02:00:00.000Z" })]);
    const reads = bridge.cloudCallsOf("cloudConflicts").length;
    await click(button(dialog(), "クラウドの内容を使う"));
    await settle();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("クラウドの内容がまた変わりました。もう一度確かめてください。");
    expect(bridge.cloudCallsOf("cloudConflicts").length).toBeGreaterThan(reads);
    expect([...dialog().querySelectorAll(".cfside pre")].map((side) => side.textContent)).toEqual(["手元", "クラウド 2"]);
    expect(resolved).toEqual([]);
    expect(closed()).toBe(0);
    // 読み直した後は新しいクラウド側の sha256 で解決する
    await click(button(dialog(), "クラウドの内容を使う"));
    expect(resolveCalls(bridge).at(-1)).toEqual([PROJECT, "c1", "remote", null, "2".repeat(64)]);
    expect(resolved).toEqual(["pages/doc1.md"]);
  });

  it("長い文書は違う行だけを出す（「−」は この Mac、「＋」は クラウド）", async () => {
    const lines = Array.from({ length: 60 }, (_, index) => `行 ${index + 1}`);
    const local = [...lines.slice(0, 30), "この Mac の行", ...lines.slice(30)].join("\n");
    const remote = [...lines.slice(0, 30), "クラウドの行", ...lines.slice(30)].join("\n");
    const { show } = setup([conflictEntryOf({ conflictId: "c1", path: "pages/doc1.md" })], { c1: { local, remote } });
    await show("pages/doc1.md");
    await settle();
    expect(dialog().querySelectorAll(".cfside pre")).toHaveLength(0);
    expect(dialog().querySelector(".dl.removed .tx")?.textContent).toBe("この Mac の行");
    expect(dialog().querySelector(".dl.added .tx")?.textContent).toBe("クラウドの行");
    expect(dialog().querySelector(".dl.skip")?.textContent).toContain("行は同じ");
  });

  it("確かめが要る変更が無ければそう出して閉じられる。解決中のものは出さない", async () => {
    const { show, closed } = setup([conflictEntryOf({ conflictId: "c1", path: "pages/doc1.md", status: "resolving" })], {});
    await show();
    await settle();
    expect(dialog().textContent).toContain("確かめが必要な変更はありません。");
    await click(button(dialog(), "閉じる"));
    expect(closed()).toBe(1);
  });
});
