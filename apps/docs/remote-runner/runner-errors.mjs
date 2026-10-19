/** Runner diagnostics are fixed codes. Never attach response bodies, URLs, or secrets. */
export class RunnerError extends Error {
  constructor(code, { fatal = false, outcomeUnknown = false } = {}) {
    super(code);
    this.name = 'RunnerError';
    this.code = code;
    this.fatal = fatal;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export function runnerError(error, fallback = 'runner_failed') {
  if (error instanceof RunnerError) return error;
  // The core exposes only fixed TranscriptionError codes. Do not preserve
  // arbitrary Node/system error codes in operator-visible diagnostics.
  if (error?.name === 'TranscriptionError' && typeof error.code === 'string') {
    return new RunnerError(error.code);
  }
  if (error?.code === 'cancelled') return new RunnerError('cancelled');
  return new RunnerError(fallback);
}
