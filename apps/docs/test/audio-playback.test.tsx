// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AudioInput } from "@niho/docs-core";
import { AudioPlaybackBar, type AudioPlaybackHandle } from "../src/components/AudioPlaybackBar";
import { formatPlaybackTime, locateTimelineSecond, timelineDuration, timelineStarts } from "../src/lib/audio-playback";
import type { Bridge } from "../src/lib/bridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const audio: AudioInput[] = [
  { file: "first.m4a", hash: "0".repeat(64), name: "前半.m4a", durationSec: null },
  { file: "second.m4a", hash: "1".repeat(64), name: "後半.m4a", durationSec: null },
];

class FakeMedia {
  preload = "";
  src = "";
  playbackRate = 1;
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  playCalls = 0;
  pauseCalls = 0;
  loadCalls = 0;
  onloadedmetadata: (() => void) | null = null;
  ondurationchange: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playResult: Promise<void> | null = null;
  play() {
    this.paused = false;
    this.playCalls++;
    return this.playResult ?? Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.pauseCalls++;
  }
  load() { this.loadCalls++; }
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
}

let roots: Array<{ root: Root; container: HTMLDivElement }> = [];
afterEach(() => {
  for (const item of roots) {
    act(() => item.root.unmount());
    item.container.remove();
  }
  roots = [];
});

async function settle() {
  for (let index = 0; index < 4; index++) await act(async () => Promise.resolve());
}

describe("通し時刻の計算", () => {
  it("source.audio の順で開始秒・全体・seek先を計算する", () => {
    expect(timelineStarts([10, 20, 5])).toEqual([0, 10, 30]);
    expect(timelineDuration([10, 20, 5])).toBe(35);
    expect(locateTimelineSecond([10, 20, 5], 12)).toEqual({ index: 1, startSec: 10, offsetSec: 2 });
    expect(locateTimelineSecond([10, 20, 5], 30)).toEqual({ index: 2, startSec: 30, offsetSec: 0 });
    expect(timelineDuration([10, null, 5])).toBeNull();
    expect(locateTimelineSecond([10, null, 5], 12)).toBeNull();
    expect(formatPlaybackTime(3723)).toBe("01:02:03");
  });
});

describe("音声の連続再生と頭出し", () => {
  it("本文保存で音声台帳を読み直しても再生を保ち、古いplayの失敗で新しい頭出しを止めない", async () => {
    const media: FakeMedia[] = [];
    let reads = 0;
    const bridge = {
      audioSourceUrl: (path: string) => `asset://localhost/${encodeURIComponent(path)}`, audioFilePaths: async () => {
      reads++;
      return audio.map((item) => ({ file: item.file, path: `/docs/inputs/${item.file}` }));
    } } as unknown as Bridge;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    const player = createRef<AudioPlaybackHandle>();
    const createMedia = () => {
      const item = new FakeMedia();
      media.push(item);
      return item as unknown as HTMLAudioElement;
    };
    const render = () => root.render(<AudioPlaybackBar ref={player} bridge={bridge}
      recording={{ projectId: "p1", recordingId: "r1" }}
      audio={audio.map((item) => ({ ...item, durationSec: 10 }))} createMedia={createMedia} />);
    await act(async () => render());
    await settle();
    let rejectOldPlay: (error: Error) => void = () => {};
    media[0]!.playResult = new Promise<void>((_resolve, reject) => { rejectOldPlay = reject; });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="再生"]')!.click());
    await act(async () => render());
    expect(reads).toBe(1);
    expect(media).toHaveLength(2);
    expect(media[0]!.paused).toBe(false);
    await act(async () => player.current!.seek(12));
    await act(async () => rejectOldPlay(new Error("old play aborted by seek")));
    expect(media[1]!.currentTime).toBe(2);
    expect(media[1]!.paused).toBe(false);
    expect(container.querySelector('[aria-label="一時停止"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("metadata で不明時間を補い、次の音声へ継続し、停止中のseekでは再生を始めない", async () => {
    const media: FakeMedia[] = [];
    let selectedPosition: number | null | undefined;
    const bridge = {
      audioSourceUrl: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
      audioFilePaths: async () => [
        { file: "first.m4a", path: "/docs/inputs/first.m4a" },
        { file: "second.m4a", path: "/docs/inputs/second.m4a" },
      ],
    } as unknown as Bridge;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    const player = createRef<AudioPlaybackHandle>();
    await act(async () => {
      root.render(
        <AudioPlaybackBar
          ref={player}
          bridge={bridge}
          recording={{ projectId: "p1", recordingId: "r1" }}
          audio={audio}
          followParagraphs
          onStateChange={(state) => { selectedPosition = state.positionSec; }}
          createMedia={() => {
            const item = new FakeMedia();
            media.push(item);
            return item as unknown as HTMLAudioElement;
          }}
        />,
      );
    });
    await settle();
    expect(selectedPosition).toBeNull();
    expect(container.querySelector<HTMLInputElement>(".audio-playback-follow input")?.checked).toBe(true);
    expect(media.map((item) => item.src)).toEqual([
      "asset://localhost/%2Fdocs%2Finputs%2Ffirst.m4a",
      "asset://localhost/%2Fdocs%2Finputs%2Fsecond.m4a",
    ]);
    await act(async () => {
      media[0]!.duration = 10;
      media[0]!.onloadedmetadata?.();
      media[1]!.duration = 20;
      media[1]!.onloadedmetadata?.();
    });
    expect(container.textContent).toContain("00:00 / 00:30");
    expect(selectedPosition).toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="再生"]')!.click());
    expect(media[0]!.playCalls).toBe(1);
    expect(selectedPosition).toBe(0);
    await act(async () => media[0]!.onended?.());
    expect(media[1]!.playCalls).toBe(1);
    expect(media[1]!.currentTime).toBe(0);

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="一時停止"]')!.click());
    const before = media[0]!.playCalls + media[1]!.playCalls;
    await act(async () => player.current!.seek(4));
    expect(media[0]!.currentTime).toBe(4);
    expect(selectedPosition).toBe(4);
    expect(media[0]!.playCalls + media[1]!.playCalls).toBe(before);

    await act(async () => player.current!.seek(12));
    expect(media[1]!.currentTime).toBe(2);
    expect(media[0]!.playCalls + media[1]!.playCalls).toBe(before);
    await act(async () => media[1]!.onerror?.());
    expect(container.textContent).toContain("「後半.m4a」を再生できません。ファイルを確かめてください。");

    act(() => root.unmount());
    roots = roots.filter((item) => item.root !== root);
    expect(media.every((item) => item.paused && item.src === "" && item.loadCalls === 1)).toBe(true);
  });

  it("欠落音声を source.audio の位置に残したまま日本語で案内する", async () => {
    const bridge = {
      audioSourceUrl: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
      audioFilePaths: async () => [
        { file: "first.m4a", path: "/docs/inputs/first.m4a" },
        { file: "second.m4a", path: null },
      ],
    } as unknown as Bridge;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    await act(async () => root.render(<AudioPlaybackBar bridge={bridge} recording={{ projectId: "p1", recordingId: "r1" }} audio={audio.map((item) => ({ ...item, durationSec: 10 }))} />));
    await settle();
    expect(container.textContent).toContain("この Mac にない音声があります。");
  });

  it("欠落していた音声がこの Mac に届いたら（missingInputs が変わったら）音声の場所を取り直して再生できる", async () => {
    let arrived = false;
    let reads = 0;
    const bridge = {
      audioSourceUrl: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
      audioFilePaths: async () => {
        reads++;
        return [
          { file: "first.m4a", path: "/docs/inputs/first.m4a" },
          { file: "second.m4a", path: arrived ? "/docs/inputs/second.m4a" : null },
        ];
      },
    } as unknown as Bridge;
    const media: FakeMedia[] = [];
    const createMedia = () => {
      const item = new FakeMedia();
      media.push(item);
      return item as unknown as HTMLAudioElement;
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    const withDurations = audio.map((item) => ({ ...item, durationSec: 10 }));
    const render = (missingInputs: string[]) => root.render(
      <AudioPlaybackBar bridge={bridge} recording={{ projectId: "p1", recordingId: "r1" }} audio={withDurations} missingInputs={missingInputs} createMedia={createMedia} />,
    );
    await act(async () => render(["second.m4a"]));
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="再生"]')!.click());
    await act(async () => render(["second.m4a"]));
    expect(reads).toBe(1);
    // 同じ missingInputs では取り直さない（再生を保つ）
    expect(media.filter(Boolean)).toHaveLength(1);
    arrived = true;
    await act(async () => render([]));
    await settle();
    expect(reads).toBe(2);
    expect(media).toHaveLength(3);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="再生"]')!.click());
    expect(container.textContent).not.toContain("この Mac にない音声があります。");
  });
});
