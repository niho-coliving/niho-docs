import { lstat, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ensurePrivateAcl } from './acl.mjs';
import { TranscriptionError } from './errors.mjs';

async function privateTree(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || info.uid !== process.getuid()) return false;
  if (info.isFile()) return (info.mode & 0o777) === 0o600;
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) return false;
  for (const entry of await readdir(path)) {
    if (!await privateTree(join(path,entry))) return false;
  }
  return true;
}

async function hasActiveChild(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const pid = /^\.active-child-([1-9][0-9]{0,9})$/.exec(entry.name)?.[1];
    if (pid) {
      try { process.kill(Number(pid), 0); return true; }
      catch (error) { if (error.code !== 'ESRCH') return true; }
    }
    if (entry.isDirectory() && await hasActiveChild(join(path, entry.name))) return true;
  }
  return false;
}

/**
 * Explicit startup-only recovery. Caller must first ensure one service instance
 * and no active attempt; an acknowledgement flag is not itself an OS lock.
 * Unknown entries, symlinks and trees with unsafe metadata are preserved.
 */
export async function cleanupStaleAttempts({ workRoot, singleInstanceConfirmed } = {}) {
  try {
    if (singleInstanceConfirmed !== true || typeof workRoot !== 'string' || !isAbsolute(workRoot)) {
      throw new TranscriptionError('invalid_configuration');
    }
    const root = await lstat(workRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o777) !== 0o700) {
      throw new TranscriptionError('workspace_invalid');
    }
    await ensurePrivateAcl(workRoot, 'workspace_invalid', { expectedStat: root });
    let removedAttempts=0;
    let skippedEntries=0;
    let activeAttempts=0;
    for (const entry of await readdir(workRoot)) {
      const path=join(workRoot,entry);
      const info=await lstat(path);
      if (!/^attempt-[A-Za-z0-9]{6}$/.test(entry) || !info.isDirectory() || !await privateTree(path)) {
        skippedEntries++;
        continue;
      }
      if (await hasActiveChild(path)) {
        skippedEntries++;
        activeAttempts++;
        continue;
      }
      await rm(path,{recursive:true,force:false});
      removedAttempts++;
    }
    return { removedAttempts,skippedEntries, ...(activeAttempts ? { activeAttempts } : {}) };
  } catch (error) {
    throw error instanceof TranscriptionError ? error : new TranscriptionError('workspace_cleanup_failed');
  }
}
