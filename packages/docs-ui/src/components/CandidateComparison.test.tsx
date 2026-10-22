// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SOURCE_STEP_ID, type ArtifactCandidate, type RunRecord } from "@niho/docs-core";
import type { Bridge } from "../lib/bridge";
import { CandidateComparison } from "./CandidateComparison";

const { seek } = vi.hoisted(() => ({ seek: vi.fn() }));

vi.mock("./AudioPlaybackBar", async () => {
  const React = await import("react");
  return {
    AudioPlaybackBar: React.forwardRef<{ seek: (second: number) => void }, { audio: readonly unknown[] }>((props, ref) => {
      React.useImperativeHandle(ref, () => ({ seek }), []);
      return React.createElement("div", { "data-testid": "shared-audio", "data-audio-count": props.audio.length });
    }),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);

afterEach(() => {
  act(() => root.render(null));
  container.innerHTML = "";
});

beforeEach(() => seek.mockClear());

function sourceCandidate(overrides: Partial<ArtifactCandidate> = {}): ArtifactCandidate {
  return {
    id: "candidate-source",
    artifactId: SOURCE_STEP_ID,
    name: "この Mac",
    createdAt: "2026-10-21T01:00:00.000Z",
    engine: "this-mac",
    ...overrides,
  };
}

describe("文字起こしの別案の比較", () => {
  it("共通音声を表示し、両側の時刻から頭出しできる。エンジン・日時・状態も示す", async () => {
    const first = sourceCandidate();
    const second = sourceCandidate({
      id: "candidate-gemini",
      artifactId: "artifact-gemini",
      name: "Gemini",
      engine: "gemini",
      engineConnection: "apiKey",
      createdAt: "2026-10-21T02:00:00.000Z",
    });
    const run: RunRecord = {
      id: "run-gemini",
      kind: "run",
      at: "2026-10-21T02:01:00.000Z",
      stepId: SOURCE_STEP_ID,
      stepName: "文字起こし",
      candidateId: second.id,
      artifactId: second.artifactId,
      version: 1,
      result: "saved",
      provider: "gemini",
    };
    act(() => root.render(
      <CandidateComparison
        candidates={[first, second]}
        artifacts={{
          [SOURCE_STEP_ID]: "[00:00:03] 最初の聞き取り",
          [second.artifactId]: "[00:00:12] 別の聞き取り",
        }}
        drafts={{}}
        currentId={first.id}
        stepName="文字起こしの別案"
        transcript={{
          bridge: {} as unknown as Bridge,
          recording: { projectId: "project", recordingId: "recording" },
          audio: [{ file: "audio.m4a", hash: "0".repeat(64), name: "取材.m4a", durationSec: 60 }],
          missingInputs: [],
          runs: [run],
          activeRun: null,
        }}
        onClose={() => undefined}
      />,
    ));

    expect(container.querySelector('[data-testid="shared-audio"]')?.getAttribute("data-audio-count")).toBe("1");
    expect(container.textContent).toContain("Gemini（API キー）");
    expect(container.textContent).toContain("完了");

    const rightTimestamp = container.querySelector<HTMLElement>('[data-transcript-seek-seconds="12"]');
    expect(rightTimestamp).not.toBeNull();
    await act(async () => rightTimestamp!.click());
    expect(seek).toHaveBeenCalledWith(12);

    const rightSide = container.querySelector<HTMLButtonElement>('.compare-mobile-side button[aria-pressed="false"]');
    expect(rightSide?.textContent).toBe("右の別案");
    await act(async () => rightSide!.click());
    expect(container.querySelector(".compare-grid")?.getAttribute("data-mobile-side")).toBe("right");
    expect(rightSide?.getAttribute("aria-pressed")).toBe("true");
  });
});
