/** Fixed diagnostic codes only; never include paths, text, URLs or OS messages. */
export class TranscriptionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TranscriptionError';
    this.code = code;
  }
}
