import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { TranscriptionError } from './errors.mjs';

const execFileAsync = promisify(execFile);
const commandOptions = { encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024 };

export function parseMacosAclOutput(output) {
  const [modeLine, ...entries] = String(output).split(/\r?\n/);
  if (!/^[bcdlps-][rwxStTs-]{9}[+@]*\s/.test(modeLine ?? '')) return undefined;
  const aclEntries = entries.filter((line) => /^\s+\d+:\s/.test(line));
  const hasEntries = aclEntries.length > 0;
  if (modeLine.includes('+') !== hasEntries) return undefined;
  if (aclEntries.some((line) => !/\s(?:allow|deny)\s/.test(line))) return undefined;
  return { hasAcl: hasEntries, allowsAccess: aclEntries.some((line) => /\sallow\s/.test(line)) };
}

function sameObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino && !left.isSymbolicLink() && !right.isSymbolicLink();
}

async function readAcl(path, runFile) {
  const { stdout } = await runFile('/bin/ls', ['-lde', path], commandOptions);
  const acl = parseMacosAclOutput(stdout);
  if (acl === undefined) throw new Error('acl_inspection_failed');
  return acl;
}

/**
 * Check a caller-owned path without changing it. A newly-created attempt can
 * opt into clearing ACLs inherited from its already-validated parent.
 */
export async function ensurePrivateAcl(path, code, {
  platform = process.platform,
  normalize = false,
  expectedStat,
  runFile = execFileAsync,
  statPath = lstat,
} = {}) {
  if (platform !== 'darwin') return;
  try {
    const initial = await statPath(path);
    if (initial.isSymbolicLink() || (expectedStat && !sameObject(expectedStat, initial))) {
      throw new Error('path_changed');
    }
    let acl = await readAcl(path, runFile);
    if (normalize && acl.hasAcl) {
      await runFile('/bin/chmod', ['-N', path], commandOptions);
      acl = await readAcl(path, runFile);
    }
    const after = await statPath(path);
    if (!sameObject(initial, after) || (expectedStat && !sameObject(expectedStat, after))
      || acl.allowsAccess || (normalize && acl.hasAcl)) {
      throw new Error('acl_not_private');
    }
  } catch {
    throw new TranscriptionError(code);
  }
}
