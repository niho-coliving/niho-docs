import { TranscriptionError } from './errors.mjs';

// Matches packages/docs-core/src/transcript.ts: absolute seconds, floored,
// whitespace collapsed, non-empty paragraphs separated by an empty line.
function timestamp(seconds) {
  const total = Math.floor(seconds);
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
}

export function markdownCollector(maxBytes, { speakers = false } = {}) {
  const paragraphs = [];
  let bytes = 0;
  const push = (paragraph) => {
    const next = bytes + Buffer.byteLength(paragraph) + (paragraphs.length ? 2 : 1);
    if (next > maxBytes) throw new TranscriptionError('candidate_limit');
    bytes = next;
    paragraphs.push(paragraph);
  };
  return {
    section(part) {
      if (!Number.isSafeInteger(part) || part < 1) throw new TranscriptionError('sidecar_protocol');
      push(`## Part ${part}: 音声${part}`);
    },
    append({ start, text, speaker }) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (!normalized) return;
      const label = speakers ? `話者${speaker === null ? '?' : speaker}: ` : '';
      push(`[${timestamp(start)}] ${label}${normalized}`);
    },
    get bytes() { return bytes; },
    get hasText() { return paragraphs.length > 0; },
    text() { return paragraphs.length ? `${paragraphs.join('\n\n')}\n` : ''; },
  };
}
