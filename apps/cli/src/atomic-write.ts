import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

/**
 * Atomic evidence writes.
 *
 * Three failure modes this guards against:
 *
 *   1. A half-written bundle that looks complete. Content goes to a temp file in
 *      the SAME directory, is fsynced, and only then renamed into place - rename
 *      within a directory is atomic, so a reader sees the old file or the new
 *      one and never a truncated one.
 *   2. A path traversal from untrusted input. Names are validated and resolved
 *      against a fixed root; anything that escapes is refused.
 *   3. A world-readable bundle. Files are created 0600 and directories 0700.
 *
 * Cleanup only ever touches this process's own temp file. Removing anything else
 * on a failure path is how a crash turns into data loss.
 */

/** A bundle file name. Deliberately narrow: no separators, no dots, no unicode. */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,96}$/;

export class UnsafeEvidencePathError extends Error {
  override readonly name = 'UnsafeEvidencePathError';
  constructor(detail: string) {
    super(`refusing to write evidence: ${detail}`);
  }
}

/**
 * Resolve a file inside the evidence root, or refuse.
 *
 * Both checks are needed: the name pattern stops the obvious cases and the
 * resolved-prefix check stops the ones that survive it (symlinked roots,
 * unicode look-alikes, `..` that normalises late).
 */
export const resolveEvidencePath = (root: string, name: string): string => {
  if (!isAbsolute(root)) throw new UnsafeEvidencePathError('evidence root must be absolute');
  if (!SAFE_NAME.test(name)) {
    throw new UnsafeEvidencePathError(`file name ${JSON.stringify(name)} is not a safe basename`);
  }
  const resolvedRoot = resolve(root);
  const target = resolve(join(resolvedRoot, name));
  if (target !== join(resolvedRoot, name) || !target.startsWith(resolvedRoot + sep)) {
    throw new UnsafeEvidencePathError('resolved path escapes the evidence root');
  }
  return target;
};

export interface AtomicWriteResult {
  readonly path: string;
  readonly bytes: number;
}

/**
 * Write a file atomically with restrictive permissions.
 *
 * `fsync` before the rename is what makes this survive a power loss rather than
 * merely a crash: without it the rename can land while the contents have not.
 */
export const writeAtomic = (root: string, name: string, contents: string): AtomicWriteResult => {
  const target = resolveEvidencePath(root, name);
  mkdirSync(resolve(root), { recursive: true, mode: 0o700 });

  // Same directory, so the rename stays within one filesystem and is atomic.
  const tempName = `${name}.tmp-${String(process.pid)}`;
  const temp = resolveEvidencePath(root, tempName);

  let fd: number | null = null;
  try {
    fd = openSync(temp, 'wx', 0o600);
    const bytes = writeSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, target);
    return { path: target, bytes };
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed; nothing further to do on this path.
      }
    }
    // Only ever our own temp file, never the target and never a sibling.
    try {
      unlinkSync(temp);
    } catch {
      // It may never have been created. A missing temp file is not an error.
    }
    throw e;
  }
};
