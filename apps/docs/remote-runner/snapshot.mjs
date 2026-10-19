import { timingSafeEqual } from 'node:crypto';
import { TranscriptionError } from './errors.mjs';

/** C1 audio blob ceiling (inclusive). engine.mjs / http-client.mjs / the API claim contract use the same bound. */
const MAX_AUDIO_BYTES = 2 * 1024 ** 3;

/** Freeze only the immutable source fields needed by the local engine. */
export function validateAudioSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || typeof snapshot.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sha256)
    || !Number.isSafeInteger(snapshot.bytes) || snapshot.bytes <= 0 || snapshot.bytes > MAX_AUDIO_BYTES
    || (snapshot.durationSec !== undefined && (typeof snapshot.durationSec !== 'number' || !Number.isFinite(snapshot.durationSec)
      || snapshot.durationSec <= 0 || snapshot.durationSec > 6 * 3600))) {
    throw new TranscriptionError('snapshot_invalid');
  }
  return Object.freeze({ sha256: snapshot.sha256, bytes: snapshot.bytes,
    ...(snapshot.durationSec === undefined ? {} : { durationSec: snapshot.durationSec }) });
}

/** source must describe the bytes actually copied for conversion, never a declaration. */
export function verifyAudioSnapshot(snapshot, source) {
  const expected = validateAudioSnapshot(snapshot);
  if (!source || source.bytes !== expected.bytes || typeof source.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(source.sha256)
    || !timingSafeEqual(Buffer.from(expected.sha256, 'hex'), Buffer.from(source.sha256, 'hex'))) {
    throw new TranscriptionError('snapshot_mismatch');
  }
  return expected;
}
