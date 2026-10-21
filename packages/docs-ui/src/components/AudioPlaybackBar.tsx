"use client";

import type { AudioInput } from "@niho/docs-core";
import { Pause, Play } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AudioFilePath, Bridge, RecordingRef } from "../lib/bridge";
import { formatPlaybackTime, locateTimelineSecond, timelineDuration, timelineStarts } from "../lib/audio-playback";

export type AudioPlaybackState = { positionSec: number; playing: boolean; follow: boolean };
export type AudioPlaybackHandle = { seek: (second: number) => void; pause: () => void };

type PlaybackTrack = AudioInput & { path: string | null };

function sameOrderedFiles(audio: readonly AudioInput[], paths: readonly AudioFilePath[]): boolean {
  return audio.length === paths.length && audio.every((item, index) => item.file === paths[index]?.file);
}

function cleanupMedia(media: HTMLAudioElement, explicitLoad: boolean): void {
  if (!media.paused) media.pause();
  media.onloadedmetadata = null;
  media.ondurationchange = null;
  media.ontimeupdate = null;
  media.onended = null;
  media.onerror = null;
  media.removeAttribute("src");
  const nativeMedia = typeof HTMLMediaElement !== "undefined" && media instanceof HTMLMediaElement;
  try {
    if (explicitLoad || !nativeMedia) media.load();
  } catch {
    // src を外した時点で再生資源は破棄される。古い WebView の load 失敗は利用者へ出さない。
  }
}

export const AudioPlaybackBar = forwardRef<AudioPlaybackHandle, {
  bridge: Bridge;
  recording: RecordingRef;
  audio: readonly AudioInput[];
  /** 写しがこの Mac に無い音声の file（RecordingView.missingInputs）。クラウドから届いて変わったら、音声の場所を取り直す。 */
  missingInputs?: readonly string[];
  followParagraphs?: boolean;
  onStateChange?: (state: AudioPlaybackState) => void;
  /** unit test 用。production は WebView の HTMLAudioElement。 */
  createMedia?: () => HTMLAudioElement;
}>(function AudioPlaybackBar(props, ref) {
  const [tracks, setTracks] = useState<PlaybackTrack[] | null>(null);
  const [durations, setDurations] = useState<Array<number | null>>(() => props.audio.map((item) => item.durationSec));
  const [position, setPosition] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<Array<HTMLAudioElement | null>>([]);
  const tracksRef = useRef<PlaybackTrack[]>([]);
  const durationsRef = useRef<Array<number | null>>(durations);
  const currentRef = useRef(currentIndex);
  const positionRef = useRef(position);
  const playingRef = useRef(playing);
  const speedRef = useRef(speed);
  const playbackAttemptRef = useRef(0);
  // 本文の保存後に同じ音声台帳を読み直しても、再生中の media を作り直さない。
  const audioKey = JSON.stringify(props.audio);
  const stableAudio = useMemo(() => props.audio, [audioKey]);
  // 音声の台帳（source.audio）が同じでも、写しがこの Mac に届けば場所が変わる。届くまで「この Mac にない音声」と案内し続けない
  const missingKey = JSON.stringify(props.missingInputs ?? []);

  durationsRef.current = durations;
  currentRef.current = currentIndex;
  positionRef.current = position;
  playingRef.current = playing;
  speedRef.current = speed;
  tracksRef.current = tracks ?? [];

  const setPlayback = useCallback((value: boolean) => {
    playingRef.current = value;
    setPlaying(value);
  }, []);
  const setTimelinePosition = useCallback((value: number) => {
    const next = Math.max(0, value);
    positionRef.current = next;
    setPosition(next);
  }, []);

  const startAt = useCallback((index: number, offsetSec: number, shouldPlay: boolean) => {
    const attempt = ++playbackAttemptRef.current;
    const track = tracksRef.current[index];
    const media = mediaRef.current[index];
    if (!track?.path || !media) {
      mediaRef.current.forEach((item) => item?.pause());
      setPlayback(false);
      setError("この Mac にない音声があります。音声をこの Mac に保存してから再生してください。");
      return;
    }
    mediaRef.current.forEach((item, candidate) => {
      if (candidate !== index) item?.pause();
    });
    currentRef.current = index;
    setCurrentIndex(index);
    media.playbackRate = speedRef.current;
    try {
      media.currentTime = Math.max(0, offsetSec);
    } catch {
      setPlayback(false);
      setError(`「${track.name}」を再生できません。ファイルを確かめてください。`);
      return;
    }
    const start = timelineStarts(durationsRef.current)[index];
    if (start !== null && start !== undefined) setTimelinePosition(start + Math.max(0, offsetSec));
    if (!shouldPlay) return;
    setError(null);
    setPlayback(true);
    void media.play().catch(() => {
      if (playbackAttemptRef.current !== attempt || mediaRef.current[index] !== media) return;
      setPlayback(false);
      setError(`「${track.name}」を再生できません。ファイルを確かめてください。`);
    });
  }, [setPlayback, setTimelinePosition]);

  const seek = useCallback((second: number) => {
    const location = locateTimelineSecond(durationsRef.current, second);
    if (!location) {
      setError("音声の長さを読み込み中です。読み込み後にもう一度お試しください。");
      return;
    }
    setError(null);
    startAt(location.index, location.offsetSec, playingRef.current);
  }, [startAt]);
  const pause = useCallback(() => {
    playbackAttemptRef.current++;
    mediaRef.current.forEach((media) => media?.pause());
    setPlayback(false);
  }, [setPlayback]);
  useImperativeHandle(ref, () => ({ seek, pause }), [pause, seek]);

  useEffect(() => {
    let current = true;
    playbackAttemptRef.current++;
    setTracks(null);
    setDurations(stableAudio.map((item) => item.durationSec));
    setTimelinePosition(0);
    setPlayback(false);
    setError(null);
    void props.bridge.audioFilePaths(props.recording).then(
      (paths) => {
        if (!current) return;
        if (!sameOrderedFiles(stableAudio, paths)) {
          setTracks(stableAudio.map((item) => ({ ...item, path: null })));
          setError("音声の並びを確認できませんでした。ページを開き直してください。");
          return;
        }
        setTracks(stableAudio.map((item, index) => ({ ...item, path: paths[index]!.path })));
      },
      (reason: unknown) => {
        if (!current) return;
        setTracks(stableAudio.map((item) => ({ ...item, path: null })));
        void reason;
        setError("音声を開けませんでした。時間をおいてもう一度お試しください。");
      },
    );
    return () => {
      current = false;
    };
  }, [stableAudio, missingKey, props.bridge, props.recording.projectId, props.recording.recordingId, setPlayback, setTimelinePosition]);

  useEffect(() => {
    if (!tracks) return;
    const make = props.createMedia ?? (() => document.createElement("audio"));
    const media = tracks.map((track, index) => {
      if (!track.path) return null;
      const item = make();
      item.preload = "metadata";
      item.src = props.bridge.audioSourceUrl?.(track.path) ?? track.path;
      item.playbackRate = speedRef.current;
      const readDuration = () => {
        const value = Number.isFinite(item.duration) && item.duration >= 0 ? item.duration : null;
        if (value === null) return;
        setDurations((all) => {
          if (all[index] === value) return all;
          const next = [...all];
          next[index] = value;
          durationsRef.current = next;
          return next;
        });
      };
      item.onloadedmetadata = readDuration;
      item.ondurationchange = readDuration;
      item.ontimeupdate = () => {
        if (currentRef.current !== index) return;
        const start = timelineStarts(durationsRef.current)[index];
        if (start !== null && start !== undefined) setTimelinePosition(start + item.currentTime);
      };
      item.onended = () => {
        if (currentRef.current !== index) return;
        const next = index + 1;
        if (next >= tracksRef.current.length) {
          const total = timelineDuration(durationsRef.current);
          if (total !== null) setTimelinePosition(total);
          setPlayback(false);
          return;
        }
        startAt(next, 0, true);
      };
      item.onerror = () => {
        if (currentRef.current === index) setPlayback(false);
        setError(`「${track.name}」を再生できません。ファイルを確かめてください。`);
      };
      if (props.bridge.explicitMediaLoad) item.load();
      return item;
    });
    mediaRef.current = media;
    return () => {
      playbackAttemptRef.current++;
      media.forEach((item) => item && cleanupMedia(item, props.bridge.explicitMediaLoad ?? false));
      if (mediaRef.current === media) mediaRef.current = [];
    };
  }, [tracks, props.bridge, props.createMedia, setPlayback, setTimelinePosition, startAt]);

  useEffect(() => {
    speedRef.current = speed;
    mediaRef.current.forEach((item) => {
      if (item) item.playbackRate = speed;
    });
  }, [speed]);

  useEffect(() => {
    props.onStateChange?.({ positionSec: position, playing, follow });
  }, [follow, playing, position, props.onStateChange]);

  if (props.audio.length === 0) return null;
  const total = timelineDuration(durations);
  const missing = tracks?.some((track) => track.path === null) ?? false;
  const loading = tracks === null || (total === null && !missing);
  const toggle = () => {
    if (playingRef.current) {
      playbackAttemptRef.current++;
      mediaRef.current.forEach((item) => item?.pause());
      setPlayback(false);
      return;
    }
    const totalNow = timelineDuration(durationsRef.current);
    const from = totalNow !== null && positionRef.current >= totalNow ? 0 : positionRef.current;
    const location = locateTimelineSecond(durationsRef.current, from);
    if (location) startAt(location.index, location.offsetSec, true);
    else if (from === 0 && tracksRef.current.length > 0) startAt(0, 0, true);
    else setError("音声の長さを読み込み中です。読み込み後にもう一度お試しください。");
  };

  return (
    <div className="audio-playback" aria-label="音声の再生">
      <div className="audio-playback-controls">
        <button type="button" className="audio-playback-toggle" aria-label={playing ? "一時停止" : "再生"} onClick={toggle} disabled={tracks === null}>
          {playing ? <Pause /> : <Play />}
        </button>
        <span className="audio-playback-time" aria-label={`再生位置 ${formatPlaybackTime(position)}、全体 ${formatPlaybackTime(total)}`}>
          {formatPlaybackTime(position)} / {formatPlaybackTime(total)}
        </span>
        <input
          className="audio-playback-seek"
          type="range"
          min={0}
          max={total ?? 0}
          step={0.1}
          value={Math.min(position, total ?? 0)}
          disabled={tracks === null || total === null || total === 0}
          aria-label="再生位置"
          onChange={(event) => seek(Number(event.target.value))}
        />
        <label className="audio-playback-speed">
          <span>速度</span>
          <select aria-label="再生速度" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
            {[0.75, 1, 1.25, 1.5, 2].map((value) => <option key={value} value={value}>{value}倍</option>)}
          </select>
        </label>
        {props.followParagraphs && (
          <label className="audio-playback-follow">
            <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
            再生中の段落を追う
          </label>
        )}
      </div>
      {loading && !error && <p className="audio-playback-note" role="status">音声を読み込み中</p>}
      {missing && <p className="audio-playback-note" role="status">この Mac にない音声があります。</p>}
      {error && <p className="audio-playback-error" role="alert">{error}</p>}
    </div>
  );
});
