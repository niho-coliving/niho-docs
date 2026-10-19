import { describe, expect, it } from "vitest";
import { ROOT_RECORDING_ID, SOURCE_STEP_ID } from "@niho/docs-core";
import {
  AUDIO_TEXT,
  SAVE_TEXT,
  artifactPath,
  audioPath,
  audioStatusText,
  cloudProjectIdOf,
  conflictLabel,
  formatBytes,
  joinName,
  leaseLabel,
  leaseRunNote,
  pageOwnerOf,
  pagePath,
  pendingPhase,
  nextRemoteLeaseExpiry,
  readCurrentText,
  remoteLeaseHolder,
  saveDue,
  saveStatus,
  stepOfPath,
  type SaveStatusInput,
} from "../src/lib/cloud";
import type { Bridge } from "../src/lib/bridge";
import { DOCS_ROOT_PROJECT_ID, type CloudState, type ProjectSyncSnapshot } from "../src/lib/cloud-types";
import { normalizeSettings } from "../src/lib/settings";
import { activeCloud, cloudStateOf, syncSnapshot } from "./fake-bridge";

/** NIHO クラウドの画面の決まり（C3 #18595）: 保存の状態・自動保存の期限・設定の移行・path・文言。 */

const PATH = "pages/doc1.md";

function input(fields: Partial<SaveStatusInput> = {}): SaveStatusInput {
  return { local: "saved", savedGeneration: null, path: PATH, cloud: activeCloud(), snapshot: syncSnapshot("p1"), ...fields };
}

function snapshot(fields: Partial<ProjectSyncSnapshot>): ProjectSyncSnapshot {
  return syncSnapshot("p1", fields);
}

describe("saveStatus（spec §7.2 の三段階）", () => {
  const cases: Array<{ name: string; input: SaveStatusInput; text: string | null; tone?: "muted" | "warn" | "error" }> = [
    { name: "最初の未保存の入力から 250ms までは何も出さない", input: input({ local: "waiting" }), text: null },
    { name: "250ms を過ぎた・書いている途中は「保存中」", input: input({ local: "saving" }), text: SAVE_TEXT.saving, tone: "muted" },
    { name: "この Mac に書けなかった", input: input({ local: "failed" }), text: SAVE_TEXT.failed, tone: "error" },
    {
      name: "競合のある path は「変更の確認が必要」（この Mac だけでも）",
      input: input({
        cloud: cloudStateOf(),
        snapshot: snapshot({ conflicts: [{ conflictId: "c1", path: PATH, kind: "edit", status: "open", remoteDeviceId: null, remoteDeviceKind: null }] }),
      }),
      text: SAVE_TEXT.conflict,
      tone: "warn",
    },
    {
      name: "解決中の競合は数えない",
      input: input({ snapshot: snapshot({ conflicts: [{ conflictId: "c1", path: PATH, kind: "edit", status: "resolving", remoteDeviceId: null, remoteDeviceKind: null }] }) }),
      text: SAVE_TEXT.cloud,
    },
    { name: "この Mac だけ", input: input({ cloud: cloudStateOf(), snapshot: null }), text: SAVE_TEXT.local, tone: "muted" },
    { name: "状態を読む前もこの Mac だけとして出す", input: input({ cloud: null, snapshot: null }), text: SAVE_TEXT.local },
    { name: "容量の足りない path", input: input({ snapshot: snapshot({ quotaPaths: [PATH], dirty: { [PATH]: 3 } }) }), text: SAVE_TEXT.quota, tone: "warn" },
    { name: "ログアウト", input: input({ cloud: activeCloud({ status: "signedOut" }) }), text: SAVE_TEXT.login, tone: "warn" },
    { name: "期限切れ", input: input({ cloud: activeCloud({ status: "expired" }) }), text: SAVE_TEXT.login, tone: "warn" },
    {
      name: "同期の失敗がログインのとき",
      input: input({ snapshot: snapshot({ lastError: { kind: "authRequired", message: "ログインが必要です" } }) }),
      text: SAVE_TEXT.login,
    },
    { name: "別のアカウントの保存先は同期しない", input: input({ cloud: activeCloud({ status: "otherAccount" }) }), text: SAVE_TEXT.local },
    { name: "接続できない（全体の知らせ）", input: input({ cloud: activeCloud({ message: "NIHO に接続できません" }) }), text: SAVE_TEXT.offline, tone: "warn" },
    {
      name: "同期の失敗（オフライン）",
      input: input({ snapshot: snapshot({ lastError: { kind: "offline", message: "NIHO に接続できません" } }) }),
      text: SAVE_TEXT.offline,
    },
    {
      name: "同期の失敗（サーバー）",
      input: input({ snapshot: snapshot({ lastError: { kind: "server", message: "クラウドで整理中です" } }) }),
      text: SAVE_TEXT.offline,
    },
    { name: "未送信の path は「同期待ち」", input: input({ snapshot: snapshot({ dirty: { [PATH]: 4 }, localGeneration: 4 }) }), text: SAVE_TEXT.pending, tone: "muted" },
    {
      name: "届いた状態が保存より古ければ「同期待ち」（古い状態で送り終えたことにしない）",
      input: input({ savedGeneration: 5, snapshot: snapshot({ localGeneration: 4 }) }),
      text: SAVE_TEXT.pending,
    },
    { name: "同期の状態がまだ無い", input: input({ snapshot: null }), text: SAVE_TEXT.pending },
    { name: "起動直後（回復の前）", input: input({ cloud: activeCloud({ status: "starting" }) }), text: SAVE_TEXT.pending },
    { name: "別の Mac で削除された案件", input: input({ snapshot: snapshot({ tombstone: { needsChoice: true } }) }), text: SAVE_TEXT.pending },
    {
      name: "保存の世代まで届いていて、未送信も競合も無い",
      input: input({ savedGeneration: 5, snapshot: snapshot({ localGeneration: 5, acknowledgedGeneration: 5 }) }),
      text: SAVE_TEXT.cloud,
      tone: "muted",
    },
    {
      name: "ほかの path の未送信は数えない",
      input: input({ savedGeneration: 5, snapshot: snapshot({ localGeneration: 6, dirty: { "pages/other.md": 6 } }) }),
      text: SAVE_TEXT.cloud,
    },
    {
      name: "容量の失敗がほかの path だけなら、この path はクラウドに保存済み",
      input: input({ snapshot: snapshot({ lastError: { kind: "quota", message: "クラウドの容量が足りません" }, quotaPaths: ["inputs/a.m4a"] }) }),
      text: SAVE_TEXT.cloud,
    },
  ];
  for (const item of cases) {
    it(item.name, () => {
      const status = saveStatus(item.input);
      expect(status?.text ?? null).toBe(item.text);
      if (item.tone) expect(status?.tone).toBe(item.tone);
    });
  }

  it("文言は spec §7.2 のとおり", () => {
    expect(Object.values(SAVE_TEXT)).toEqual([
      "保存中",
      "このMacに保存できません",
      "変更の確認が必要",
      "このMacに保存済み",
      "クラウド容量が足りません",
      "このMacに保存済み・ログインが必要",
      "このMacに保存済み・オフライン",
      "このMacに保存済み・同期待ち",
      "クラウドに保存済み",
    ]);
  });
});

describe("自動保存の期限（250ms・最大 1 秒）", () => {
  it("最後の入力から 250ms、最初の未保存の入力から 1 秒の早い方（後ろにずらさない）", () => {
    expect(saveDue(0, 0, 250, 1000)).toBe(250);
    expect(saveDue(600, 0, 250, 1000)).toBe(250);
    expect(saveDue(900, 0, 250, 1000)).toBe(100);
    expect(saveDue(1200, 0, 250, 1000)).toBe(0);
  });

  it("250ms までは何も出さず、その後は「保存中」", () => {
    expect(pendingPhase(1000, 1100)).toBe("waiting");
    expect(pendingPhase(1000, 1250)).toBe("saving");
    expect(pendingPhase(null, 1250)).toBe("waiting");
  });
});

describe("設定の版 4（保存先・続きの場所）", () => {
  it("版 2 は「この Mac だけ」・Mac の名前と続きはこの Mac にして今の版（5）で読む（ほかの値はそのまま）", () => {
    const settings = normalizeSettings({
      version: 2,
      connection: "apiKey",
      connections: { subscription: { providers: ["claude"], profiles: [] }, apiKey: { providers: ["gpt"], profiles: [] } },
      transcription: { language: "en" },
      docsRoot: "/Users/test/Documents/My docs",
    });
    expect(settings.version).toBe(5);
    expect(settings.vault).toEqual({ provider: "local", deviceName: null });
    expect(settings.connection).toBe("apiKey");
    expect(settings.connections.apiKey.providers).toEqual(["gpt"]);
    expect(settings.transcription.language).toBe("en");
    expect(settings.docsRoot).toBe("/Users/test/Documents/My docs");
    expect(settings.personalExecution).toEqual({ continuation: "this_pc" });
  });

  it("版 3 の保存先とこの Mac の名前を読み、保存し直しても版 4 の既定経路を足す。形の合わない値は既定に戻す", () => {
    const settings = normalizeSettings({
      version: 3,
      connection: "subscription",
      connections: { subscription: { providers: ["claude"], profiles: [] } },
      vault: { provider: "niho", deviceName: "  事務所の Mac  " },
    });
    expect(settings.vault).toEqual({ provider: "niho", deviceName: "事務所の Mac" });
    expect(normalizeSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    expect(normalizeSettings({ ...settings, vault: { provider: "drive", deviceName: 3 } }).vault).toEqual({ provider: "local", deviceName: null });
    expect(normalizeSettings({ ...settings, vault: null }).vault).toEqual({ provider: "local", deviceName: null });
  });
});

describe("案件の中の path と文言", () => {
  const root = { projectId: "p1", recordingId: ROOT_RECORDING_ID };
  const rec = { projectId: "p1", recordingId: "rec7" };

  it("文書・成果物・文字起こし・音声の path（root は案件フォルダ直下）", () => {
    expect(pagePath("doc1")).toBe("pages/doc1.md");
    expect(artifactPath(root, "a1")).toBe("artifacts/a1.md");
    expect(artifactPath(root, SOURCE_STEP_ID)).toBe("transcript.md");
    expect(artifactPath(rec, "a1")).toBe("recordings/rec7/artifacts/a1.md");
    expect(artifactPath(rec, SOURCE_STEP_ID)).toBe("recordings/rec7/transcript.md");
    expect(audioPath(rec, "abc.m4a")).toBe("recordings/rec7/inputs/abc.m4a");
    expect(stepOfPath(rec, "recordings/rec7/artifacts/a1.md")).toBe("a1");
    expect(stepOfPath(rec, "recordings/rec7/transcript.md")).toBe(SOURCE_STEP_ID);
    expect(stepOfPath(root, "recordings/rec7/artifacts/a1.md")).toBeNull();
    expect(stepOfPath(root, "pages/doc1.md")).toBeNull();
  });

  it("別の Mac の実行中・使用量の大きさ（英数字の名前の後ろは半角の空白）", () => {
    expect(joinName("Mac Studio", "で実行中")).toBe("Mac Studio で実行中");
    expect(leaseLabel("事務所のマック")).toBe("事務所のマックで実行中");
    expect(leaseRunNote("Mac Studio")).toBe("別の Mac（Mac Studio）で実行中です。終わると、この Mac でも実行できます。");
    const remote = [
      { projectId: "p1", name: "朝市", revision: 1, updatedAt: "", bytes: 0, local: true, lease: { deviceName: "Mac Studio", expiresAt: "", mine: false } },
      { projectId: "p2", name: "鎌倉", revision: 1, updatedAt: "", bytes: 0, local: true, lease: { deviceName: "テストの Mac", expiresAt: "", mine: true } },
    ];
    expect(remoteLeaseHolder(remote, "p1")).toBe("Mac Studio");
    expect(remoteLeaseHolder(remote, "p2")).toBeNull();
    // 期限が切れた lease は、一覧の再取得を待たずに無いものとして扱う（読めない期限は止める側）
    const at = (iso: string, name = "Mac Studio") => [{ projectId: "p1", name: "朝市", revision: 1, updatedAt: "", bytes: 0, local: true, lease: { deviceName: name, expiresAt: iso, mine: false } }];
    const now = Date.parse("2026-10-17T12:00:00.000Z");
    expect(remoteLeaseHolder(at("2026-10-17T12:00:01.000Z"), "p1", now)).toBe("Mac Studio");
    expect(remoteLeaseHolder(at("2026-10-17T12:00:00.000Z"), "p1", now)).toBeNull();
    expect(remoteLeaseHolder(at("2026-10-17T11:59:00.000Z"), "p1", now)).toBeNull();
    expect(remoteLeaseHolder(at("読めない期限"), "p1", now)).toBe("Mac Studio");
    expect(nextRemoteLeaseExpiry([...remote, ...at("2026-10-17T12:05:00.000Z"), ...at("2026-10-17T12:01:00.000Z"), ...at("2026-10-17T11:00:00.000Z")], now)).toBe(Date.parse("2026-10-17T12:01:00.000Z"));
    expect(nextRemoteLeaseExpiry(remote, now)).toBeNull();
    expect(formatBytes(1.2 * 1024 ** 3)).toBe("1.2 GB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5 GB");
    expect(formatBytes(320 * 1024 ** 2)).toBe("320 MB");
  });

  it("音声の行の添え書き（取得中・上げている・待っている・期限切れ。この Mac だけでは出さない）", () => {
    const path = audioPath(rec, "a.m4a");
    const base = { niho: true, path, file: "a.m4a", missingInputs: [] as string[] };
    expect(audioStatusText({ ...base, snapshot: snapshot({ audio: { [path]: "downloading" } }) })).toBe(AUDIO_TEXT.downloading);
    expect(audioStatusText({ ...base, snapshot: snapshot({ audio: { [path]: "uploading" } }) })).toBe(AUDIO_TEXT.uploading);
    expect(audioStatusText({ ...base, snapshot: snapshot({ audio: { [path]: "queued" } }) })).toBe(AUDIO_TEXT.waiting);
    expect(audioStatusText({ ...base, missingInputs: ["a.m4a"], snapshot: snapshot({}) })).toBe(AUDIO_TEXT.waiting);
    expect(audioStatusText({ ...base, missingInputs: ["a.m4a"], snapshot: snapshot({ expiredAudio: [path] }) })).toBe(
      "クラウドの音声は 30 日を過ぎたため削除されました。写しのある Mac から上げ直せます。",
    );
    expect(audioStatusText({ ...base, snapshot: snapshot({ expiredAudio: [path] }) })).toBeNull();
    expect(audioStatusText({ ...base, snapshot: snapshot({ audio: { [path]: "downloaded" } }) })).toBeNull();
    expect(audioStatusText({ ...base, niho: false, missingInputs: ["a.m4a"], snapshot: null })).toBeNull();
  });

  it("変更の確認の名前（内部の id を出さない）", () => {
    const names = {
      page: (pageId: string) => (pageId === "doc1" ? "事前メモ" : null),
      step: (recordingId: string, stepId: string) => (recordingId === "rec7" && stepId === "a1" ? "議事録" : null),
      recording: (recordingId: string) => (recordingId === "rec7" ? "第1回" : null),
    };
    expect(conflictLabel("p1", "pages/doc1.md", names)).toBe("事前メモ");
    expect(conflictLabel("p1", "pages/zz.md", names)).toBe("文書");
    expect(conflictLabel("p1", "project.json", names)).toBe("フォルダの情報");
    expect(conflictLabel("p1", "recordings/rec7/artifacts/a1.md", names)).toBe("議事録");
    expect(conflictLabel("p1", "recordings/rec7/recording.json", names)).toBe("第1回の設定");
    expect(conflictLabel("p1", "transcript.md", names)).toBe("文字起こし");
    expect(conflictLabel("profile", "about.json", names)).toBe("あなたについて");
    expect(conflictLabel("flows", "f1.json", names)).toBe("工程設計");
    expect(conflictLabel("p1", "assets/img.png", names)).toBe("ファイル");
  });
});

// 型の確かめ（FakeBridge の既定の状態は「この Mac だけ」）
const local: CloudState = cloudStateOf();
it("FakeBridge の既定はこの Mac だけ", () => {
  expect(local).toMatchObject({ provider: "local", status: "local", migration: null, message: null });
});

describe("フォルダ外のページの同期の鍵（docs-root・#18721）", () => {
  it("フォルダの外（null）を docs-root にし、docs-root を store の持ち主 null へ戻す", () => {
    expect(cloudProjectIdOf(null)).toBe(DOCS_ROOT_PROJECT_ID);
    expect(cloudProjectIdOf("p1")).toBe("p1");
    expect(pageOwnerOf(DOCS_ROOT_PROJECT_ID)).toBeNull();
    expect(pageOwnerOf("p1")).toBe("p1");
  });

  it("変更の確認の今の本文を、フォルダの外ではページの持ち主 null で読む", async () => {
    const reads: Array<[string | null, string]> = [];
    const bridge = {
      readPage: async (projectId: string | null, pageId: string) => {
        reads.push([projectId, pageId]);
        return "# メモ\n";
      },
    } as unknown as Bridge;
    expect(await readCurrentText(bridge, DOCS_ROOT_PROJECT_ID, "pages/pg1.md")).toBe("# メモ\n");
    expect(reads).toEqual([[null, "pg1"]]);
    // フォルダの外には「今の案件の録音」（root の録音）は無い
    expect(await readCurrentText(bridge, DOCS_ROOT_PROJECT_ID, "transcript.md")).toBeNull();
  });
});
