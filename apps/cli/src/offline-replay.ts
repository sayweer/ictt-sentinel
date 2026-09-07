import { existsSync, readFileSync } from 'node:fs';
import {
  canonicalStringify,
  domainSeparatedSha256,
  verifyBundle,
  type EvidenceBundle,
} from '@ictt-sentinel/evidence';
import { writeAtomic, resolveEvidencePath } from './atomic-write.js';

export interface ReplayCursor {
  readonly maxFacts: number;
  readonly resume: boolean;
}
export class InvalidCheckpointError extends Error {}
/** Bounded traversal of the embedded pinned fact ledger; cursor is bound to the whole input. */
export const replayOffline = (bundle: EvidenceBundle, root: string, options: ReplayCursor) => {
  const path = resolveEvidencePath(root, 'replay-checkpoint.json');
  let cursor = 0;
  if (options.resume) {
    if (!existsSync(path)) throw new InvalidCheckpointError('No checkpoint exists.');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const { digest, ...core } = raw;
    if (
      core['schemaVersion'] !== 'ictt-sentinel/checkpoint/v1' ||
      core['contentHash'] !== bundle.contentHash ||
      digest !== domainSeparatedSha256('ictt-sentinel/checkpoint/v1', canonicalStringify(core)) ||
      typeof core['cursor'] !== 'number' ||
      !Number.isSafeInteger(core['cursor']) ||
      core['cursor'] < 0 ||
      core['cursor'] > bundle.core.rawFacts.length
    ) {
      throw new InvalidCheckpointError('Checkpoint does not match this pinned input.');
    }
    cursor = core['cursor'];
  }
  const verified = verifyBundle(bundle);
  // No checkpoint advancement past disagreement, missing references or failed replay.
  if (!verified.verified)
    return {
      complete: false,
      resumedFrom: cursor,
      cursor,
      processed: 0,
      findings: verified.findings,
    };
  const end = Math.min(cursor + options.maxFacts, bundle.core.rawFacts.length);
  const checkpoint = {
    schemaVersion: 'ictt-sentinel/checkpoint/v1',
    contentHash: bundle.contentHash,
    cursor: end,
  };
  writeAtomic(
    root,
    'replay-checkpoint.json',
    JSON.stringify({
      ...checkpoint,
      digest: domainSeparatedSha256('ictt-sentinel/checkpoint/v1', canonicalStringify(checkpoint)),
    }),
  );
  return {
    complete: end === bundle.core.rawFacts.length,
    resumedFrom: cursor,
    cursor: end,
    processed: end - cursor,
    findings: verified.findings,
  };
};
