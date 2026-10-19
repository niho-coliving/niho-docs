import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DEFAULT_LIMITS, transcribeAudio } from './engine.mjs';
import { TranscriptionError } from './errors.mjs';
import { markdownCollector } from './markdown.mjs';
import { validateAudioSnapshot } from './snapshot.mjs';

export const RECORDING_LIMITS = Object.freeze({
  maxFiles: 12,
  maxDurationSec: 6 * 3600,
  maxCandidateBytes: 8 * 1024 ** 2,
  maxSegments: DEFAULT_LIMITS.maxSegments,
});

function recordingLimits(overrides) {
  const limits = { ...RECORDING_LIMITS };
  for (const [key,value] of Object.entries(overrides ?? {})) {
    if (!Object.hasOwn(limits,key) || typeof value !== 'number' || !Number.isFinite(value)
      || value <= 0 || value > limits[key] || (key !== 'maxDurationSec' && !Number.isSafeInteger(value))) {
      throw new TranscriptionError('invalid_configuration');
    }
    limits[key]=value;
  }
  return limits;
}

/** Sequential, local-only recording-page transcription. No transport assumptions. */
export async function transcribeRecording({ audio, sidecarPath, workRoot, signal, language, speakerMode = 'none', limits, recordingLimits: overrides } = {}) {
  try {
    const cap = recordingLimits(overrides);
    // Existing core limits also cap the recording as a whole, so callers
    // cannot accidentally multiply a reduced budget by the number of files.
    for (const key of ['maxDurationSec','maxCandidateBytes','maxSegments']) {
      const value=limits?.[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
        || value > DEFAULT_LIMITS[key] || (key !== 'maxDurationSec' && !Number.isSafeInteger(value))) {
        throw new TranscriptionError('invalid_configuration');
      }
      cap[key]=Math.min(cap[key],value);
    }
    if (!Array.isArray(audio) || audio.length === 0 || audio.length > cap.maxFiles) {
      throw new TranscriptionError('recording_file_limit');
    }
    if (!['auto', 'none', '2', '3', '4plus'].includes(speakerMode)) throw new TranscriptionError('invalid_configuration');
    // Capture immutable primitive inputs before yielding; never read a mutable
    // caller array or snapshot again after a previous file has completed.
    const inputs = audio.map((entry) => {
      if (!entry || typeof entry.inputPath !== 'string' || !isAbsolute(entry.inputPath)) {
        throw new TranscriptionError('invalid_configuration');
      }
      return { inputPath: entry.inputPath, snapshot: validateAudioSnapshot(entry.snapshot) };
    });
    if (inputs.reduce((sum,entry) => sum + (entry.snapshot.durationSec ?? 0),0) > cap.maxDurationSec) {
      throw new TranscriptionError('duration_limit');
    }
    const files = [];
    const segments = [];
    const markdown = markdownCollector(cap.maxCandidateBytes, { speakers: speakerMode !== 'none' });
    let durationSec = 0;
    let processingMs = 0;
    for (const [fileIndex, entry] of inputs.entries()) {
      if (signal?.aborted) throw new TranscriptionError('cancelled');
      const remainingDuration = cap.maxDurationSec - durationSec;
      if (remainingDuration <= 0) throw new TranscriptionError('duration_limit');
      if (segments.length >= cap.maxSegments) throw new TranscriptionError('output_limit');
      // The per-file core verifies the actual private copy's hash/bytes before
      // *any* sidecar command, and rejects decoded duration before recognition.
      const result = await transcribeAudio({
        inputPath: entry.inputPath, expectedSource: entry.snapshot,
        sidecarPath,workRoot,signal,language,speakerMode,
        limits: {
          ...limits,
          maxDurationSec: Math.min(limits?.maxDurationSec ?? DEFAULT_LIMITS.maxDurationSec,remainingDuration),
          maxSegments: Math.min(limits?.maxSegments ?? DEFAULT_LIMITS.maxSegments,cap.maxSegments-segments.length),
          maxCandidateBytes: Math.min(limits?.maxCandidateBytes ?? DEFAULT_LIMITS.maxCandidateBytes,cap.maxCandidateBytes),
        },
      });
      const offsetSec = durationSec;
      files.push({ source: result.source, engine: result.engine, durationSec: result.durationSec, offsetSec, processingMs: result.processingMs });
      if (inputs.length > 1 && speakerMode !== 'none') markdown.section(fileIndex + 1);
      for (const segment of result.segments) {
        const shifted = { start: segment.start + offsetSec, end: segment.end + offsetSec, text: segment.text, ...(speakerMode === 'none' ? {} : { speaker: segment.speaker }) };
        markdown.append(shifted);
        segments.push(shifted);
      }
      durationSec += result.durationSec;
      processingMs += result.processingMs;
      if (durationSec > cap.maxDurationSec || !Number.isSafeInteger(processingMs)) throw new TranscriptionError('duration_limit');
    }
    if (signal?.aborted) throw new TranscriptionError('cancelled');
    const text = markdown.text();
    return {
      files,durationSec,processingMs,segments,markdown:text,
      candidate: { bytes:markdown.bytes,sha256:createHash('sha256').update(text).digest('hex') },
    };
  } catch (error) {
    throw error instanceof TranscriptionError ? error : new TranscriptionError('transcription_failed');
  }
}
