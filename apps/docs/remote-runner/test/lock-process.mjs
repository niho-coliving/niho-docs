import { acquireRunnerLock } from '../lock.mjs';

const lock = await acquireRunnerLock(process.argv[2]);
process.stdout.write('ready\n');
process.stdin.resume();
process.stdin.once('end', async () => {
  await lock.release();
});
