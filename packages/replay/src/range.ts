import { createHash } from 'node:crypto';
import type { BlockFact, LogFact } from '@ictt-sentinel/storage-postgres';
import { canonicalLogDigest } from '@ictt-sentinel/storage-postgres';
import type { BlockRange } from './plan.js';
import type { ReplayReason } from './reasons.js';

/**
 * What one provider group reports about one range.
 *
 * Deliberately not "the logs". A range is only usable as evidence if it also
 * carries the identity of its endpoints (start and end block HASHES, not just
 * heights), the count, an order-independent digest and an explicit completeness
 * claim. Anything less cannot be compared against a second witness.
 */

export interface RangeObservation {
  readonly providerGroup: string;
  readonly range: BlockRange;
  readonly startBlockHash: string;
  readonly endBlockHash: string;
  readonly logCount: number;
  readonly logs: readonly LogFact[];
  /** Blocks backing those logs. A log cannot be stored without its block. */
  readonly blocks: readonly BlockFact[];
  /** True only when the provider positively covered the whole range. */
  readonly complete: boolean;
  /** Whether this group was reached through a declared archive witness. */
  readonly viaArchive: boolean;
}

export type RangeOutcome =
  | { readonly ok: true; readonly result: RangeResult }
  | { readonly ok: false; readonly reason: ReplayReason; readonly providerGroup: string };

/** The comparable summary. Two groups agree iff their `digest` values match. */
export interface RangeResult {
  readonly providerGroup: string;
  readonly range: BlockRange;
  readonly startBlockHash: string;
  readonly endBlockHash: string;
  readonly logCount: number;
  /** Order-independent content digest, bound to the range and its end hashes. */
  readonly digest: string;
  readonly viaArchive: boolean;
  /** The facts themselves, carried so an agreed range can be persisted. */
  readonly blocks: readonly BlockFact[];
  readonly logs: readonly LogFact[];
}

/**
 * Digest of a range observation.
 *
 * The block hashes and the bounds are hashed together with the log content, so
 * two providers that return identical logs for *different* blocks at the same
 * heights do NOT agree. Height alone is not identity after a reorg
 * (docs/DATA_MODEL.md 2.1), and this is where that rule is enforced.
 */
export const rangeDigest = (o: RangeObservation): string =>
  createHash('sha256')
    .update(
      [
        o.range.fromBlock.toString(10),
        o.range.toBlock.toString(10),
        o.startBlockHash,
        o.endBlockHash,
        String(o.logCount),
        canonicalLogDigest(o.logs),
        canonicalBlockDigest(o.blocks),
      ].join('|'),
    )
    .digest('hex');

/**
 * Order-independent digest over the blocks of a range.
 *
 * Sorted by height then hash, so two providers that fetched the same blocks in
 * different chunk orders still agree, while a provider reporting a different
 * hash at the same height does not.
 */
export const canonicalBlockDigest = (blocks: readonly BlockFact[]): string => {
  const h = createHash('sha256');
  const ordered = [...blocks].sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.blockHash < b.blockHash
        ? -1
        : a.blockHash > b.blockHash
          ? 1
          : 0
      : a.blockNumber < b.blockNumber
        ? -1
        : 1,
  );
  for (const b of ordered) {
    h.update(`${b.chainKey}|${b.blockNumber.toString(10)}|${b.blockHash}|${b.observedClass}\n`);
  }
  return h.digest('hex');
};

/**
 * Turn a raw observation into a comparable result, or into a typed reason.
 *
 * The checks here are the ones a provider can fail while still returning HTTP
 * 200, which is exactly why they are done locally instead of trusted:
 *
 *   - a count that disagrees with the delivered logs is silent truncation;
 *   - an incomplete claim over an empty body is ambiguous, never "no logs";
 *   - a hole in a block's log indices is a missing log.
 */
export const classifyObservation = (o: RangeObservation): RangeOutcome => {
  const fail = (reason: ReplayReason): RangeOutcome => ({
    ok: false,
    reason,
    providerGroup: o.providerGroup,
  });

  if (o.logs.length !== o.logCount) return fail('SILENT_TRUNCATION');

  // The canonical truth path processes accepted blocks only. A speed-path
  // candidate reaching this point would become history, so it is refused here
  // rather than filtered downstream.
  if (o.blocks.some((b) => b.observedClass !== 'accepted')) {
    return fail('NONCANONICAL_BLOCK_REJECTED');
  }

  // Every log must have its block in the same observation, or the range is short
  // of the evidence needed to store it.
  const blockHashes = new Set(o.blocks.map((b) => b.blockHash));
  if (o.logs.some((l) => !blockHashes.has(l.blockHash))) return fail('MISSING_BLOCK');

  if (!o.complete) {
    // An empty body from an incomplete answer cannot be distinguished from a
    // range the endpoint never served. Treating it as "no logs here" is how a
    // gap silently becomes a green range.
    return fail(o.logs.length === 0 ? 'EMPTY_RESPONSE_AMBIGUITY' : 'SILENT_TRUNCATION');
  }

  const hole = findLogIndexHole(o.logs);
  if (hole) return fail('MISSING_LOG');

  return {
    ok: true,
    result: {
      providerGroup: o.providerGroup,
      range: o.range,
      startBlockHash: o.startBlockHash,
      endBlockHash: o.endBlockHash,
      logCount: o.logCount,
      digest: rangeDigest(o),
      viaArchive: o.viaArchive,
      blocks: o.blocks,
      logs: o.logs,
    },
  };
};

/**
 * A gap in the per-block log index sequence.
 *
 * Log indices are block-scoped and dense in every EVM client, so a jump means
 * the response dropped an entry rather than that the chain skipped one.
 */
const findLogIndexHole = (logs: readonly LogFact[]): boolean => {
  const byBlock = new Map<string, number[]>();
  for (const l of logs) {
    const key = `${l.chainKey}|${l.blockHash}`;
    const list = byBlock.get(key);
    if (list) list.push(l.logIndex);
    else byBlock.set(key, [l.logIndex]);
  }
  for (const indices of byBlock.values()) {
    const sorted = [...indices].sort((a, b) => a - b);
    let previous: number | undefined;
    for (const current of sorted) {
      if (previous !== undefined && current !== previous + 1) return true;
      previous = current;
    }
  }
  return false;
};

/** Heights covered by no planned range. Used to prove a plan has no holes. */
export const findRangeGaps = (
  covered: readonly BlockRange[],
  window: BlockRange,
): readonly BlockRange[] => {
  const sorted = [...covered].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : 1));
  const gaps: BlockRange[] = [];
  let cursor = window.fromBlock;
  for (const r of sorted) {
    if (r.fromBlock > cursor) gaps.push({ fromBlock: cursor, toBlock: r.fromBlock - 1n });
    if (r.toBlock >= cursor) cursor = r.toBlock + 1n;
  }
  if (cursor <= window.toBlock) gaps.push({ fromBlock: cursor, toBlock: window.toBlock });
  return gaps;
};
