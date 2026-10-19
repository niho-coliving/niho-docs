// 文字起こしの時刻の node と、表示の切り替え・再生位置・頭出し。実装は packages/docs-ui（#18876）。
export {
  TRANSCRIPT_TIMESTAMP_NODE,
  TranscriptTimestamp,
  activeTimestampSecond,
  setTimestampMode,
  setTimestampPlaybackState,
  setTimestampSeekHandler,
  timestampPrefix,
  timestampSeconds,
  type TimestampMode,
  type TimestampPlaybackState,
  type TimestampPrefix,
} from "../editor/timestamps";
