#!/usr/bin/env node
import { loadRunnerConfig, parseCliArguments } from './config.mjs';
import { acquireRunnerLock } from './lock.mjs';
import { RunnerError, runnerError } from './runner-errors.mjs';
import { runConfiguredService } from './service.mjs';

function logger(entry) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new RunnerError('unsupported_runtime', { fatal: true });
  const paths = parseCliArguments(process.argv.slice(2));
  const config = await loadRunnerConfig(paths);
  const lock = await acquireRunnerLock(config.workRoot);
  const controller = new AbortController();
  let stopping = false;
  const stop = (signalName) => {
    if (stopping) return;
    stopping = true;
    logger({ event: 'shutdown_requested', code: signalName === 'SIGTERM' ? 'sigterm' : 'sigint' });
    controller.abort(new RunnerError('cancelled'));
  };
  const onSigterm = () => stop('SIGTERM');
  const onSigint = () => stop('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  try {
    await runConfiguredService({ config, lock, signal: controller.signal, logger });
  } finally {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    await lock.release();
  }
}

main().catch((caught) => {
  const error = runnerError(caught);
  logger({ event: 'runner_stopped', code: error.code });
  process.exitCode = error.code === 'cancelled' ? 0 : 1;
});
