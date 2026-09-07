import { type ReplayReason, isRetryable } from './reasons.js';

/**
 * Range planning and adaptive splitting.
 *
 * Pure: no clock, no randomness, no I/O. The same inputs always produce the same
 * plan, which is what makes a replay reproducible across machines and restarts.
 */

export interface BlockRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export interface PlanInput {
  /**
   * The manifest's trustworthy start: a TokenHome deployment/initialization
   * block, never "wherever the node still has history".
   */
  readonly startBlock: bigint;
  /** Agreed accepted head. Not `latest`, and not a per-provider answer. */
  readonly agreedHead: bigint;
  /** Endpoint capability: the widest log range the provider will actually serve. */
  readonly maxRangeBlocks: number;
  /** Attempts allowed per range before the budget is declared spent. */
  readonly retryBudget: number;
}

export const spanOf = (r: BlockRange): bigint => r.toBlock - r.fromBlock + 1n;

/**
 * Split a start..head window into bounded chunks.
 *
 * Ascending and contiguous: chunk n+1 starts exactly one block after chunk n
 * ends, so no height can fall between two chunks and be silently skipped.
 */
export const planRanges = (input: PlanInput): readonly BlockRange[] => {
  const { startBlock, agreedHead, maxRangeBlocks } = input;
  if (maxRangeBlocks < 1) throw new RangeError('maxRangeBlocks must be at least 1');
  if (agreedHead < startBlock) return [];

  const width = BigInt(maxRangeBlocks);
  const ranges: BlockRange[] = [];
  for (let from = startBlock; from <= agreedHead; from += width) {
    const to = from + width - 1n;
    ranges.push({ fromBlock: from, toBlock: to > agreedHead ? agreedHead : to });
  }
  return ranges;
};

/**
 * Halve a range after a timeout or a provider limit.
 *
 * Returns `null` for a single-block range: there is nothing left to divide, and
 * pretending otherwise would loop forever. The caller turns that into
 * RANGE_INDIVISIBLE rather than retrying.
 */
export const splitRange = (r: BlockRange): readonly [BlockRange, BlockRange] | null => {
  const span = spanOf(r);
  if (span <= 1n) return null;
  const half = span / 2n;
  return [
    { fromBlock: r.fromBlock, toBlock: r.fromBlock + half - 1n },
    { fromBlock: r.fromBlock + half, toBlock: r.toBlock },
  ] as const;
};

export interface AttemptState {
  readonly range: BlockRange;
  /** Attempts already spent on this range. */
  readonly attempts: number;
  /** Attempts allowed for this range before it must split or stop. */
  readonly retryBudget: number;
}

export type NextStep =
  | { readonly kind: 'retry'; readonly range: BlockRange; readonly attempts: number }
  | { readonly kind: 'split'; readonly ranges: readonly [BlockRange, BlockRange] }
  | { readonly kind: 'give-up'; readonly reason: ReplayReason };

/**
 * Decide what to do after a failed attempt. There is no fourth option, and in
 * particular no "retry forever": every path either makes the work strictly
 * smaller or stops with a typed reason.
 *
 * A structural failure short-circuits before the budget is even consulted -
 * splitting a pruned range still lands on the same missing history, so spending
 * attempts on it only delays the answer the operator needs.
 */
export const nextStep = (state: AttemptState, reason: ReplayReason): NextStep => {
  if (!isRetryable(reason)) return { kind: 'give-up', reason };

  if (state.attempts + 1 < state.retryBudget) {
    return { kind: 'retry', range: state.range, attempts: state.attempts + 1 };
  }

  // Budget spent. Halving is the last resort: a smaller window often succeeds
  // where a wide one hit a provider limit.
  const halves = splitRange(state.range);
  if (halves !== null) return { kind: 'split', ranges: halves };

  // One block wide and still failing: nothing left to divide.
  return {
    kind: 'give-up',
    reason: spanOf(state.range) === 1n ? 'RANGE_INDIVISIBLE' : 'RETRY_BUDGET_EXHAUSTED',
  };
};
