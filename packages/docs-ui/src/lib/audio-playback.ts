export type TimelineLocation = { index: number; startSec: number; offsetSec: number };

function validDuration(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** 結合順の各音声の開始秒。手前に長さ不明があれば、その後の通し秒はまだ決められない。 */
export function timelineStarts(durations: readonly (number | null)[]): Array<number | null> {
  let start: number | null = 0;
  return durations.map((duration) => {
    const current = start;
    start = start !== null && validDuration(duration) ? start + duration : null;
    return current;
  });
}

export function timelineDuration(durations: readonly (number | null)[]): number | null {
  const starts = timelineStarts(durations);
  const last = durations.length - 1;
  if (last < 0 || starts[last] === null || !validDuration(durations[last])) return durations.length === 0 ? 0 : null;
  return starts[last]! + durations[last]!;
}

/** 通し秒を source.audio の結合順の音声と、その音声内の秒へ変換する。 */
export function locateTimelineSecond(durations: readonly (number | null)[], second: number): TimelineLocation | null {
  if (!Number.isFinite(second) || second < 0 || durations.length === 0) return null;
  const starts = timelineStarts(durations);
  for (let index = 0; index < durations.length; index++) {
    const start = starts[index] ?? null;
    const duration = durations[index];
    if (start === null || !validDuration(duration)) return null;
    const end = start + duration;
    if (second < end || (index === durations.length - 1 && second <= end)) {
      return { index, startSec: start, offsetSec: Math.max(0, Math.min(duration, second - start)) };
    }
  }
  return null;
}

export function formatPlaybackTime(second: number | null): string {
  if (second === null || !Number.isFinite(second) || second < 0) return "--:--";
  const whole = Math.floor(second);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
