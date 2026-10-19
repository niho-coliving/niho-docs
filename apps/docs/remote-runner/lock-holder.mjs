// Started only by the fixed OS lock helper. The kernel lock is held until stdin closes.
process.stdout.write('ready\n');
process.stdin.resume();
process.stdin.once('end', () => { process.exitCode = 0; });
