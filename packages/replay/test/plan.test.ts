import { describe, expect, it } from 'vitest';
import { type BlockRange, nextStep, planRanges, spanOf, splitRange } from '../src/plan.js';
import { findRangeGaps } from '../src/range.js';

const window = (from: bigint, to: bigint): BlockRange => ({ fromBlock: from, toBlock: to });

describe('planRanges', () => {
  it('covers the whole window with no gap and no overlap', () => {
    const ranges = planRanges({
      startBlock: 100n,
      agreedHead: 349n,
      maxRangeBlocks: 100,
      retryBudget: 3,
    });
    expect(ranges).toEqual([
      { fromBlock: 100n, toBlock: 199n },
      { fromBlock: 200n, toBlock: 299n },
      { fromBlock: 300n, toBlock: 349n },
    ]);
    // The property that matters: nothing between start and head is unplanned.
    expect(findRangeGaps(ranges, window(100n, 349n))).toEqual([]);
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i]!.fromBlock).toBe(ranges[i - 1]!.toBlock + 1n);
    }
  });

  it('never exceeds the endpoint capability', () => {
    const ranges = planRanges({
      startBlock: 0n,
      agreedHead: 10_000n,
      maxRangeBlocks: 2048,
      retryBudget: 1,
    });
    for (const r of ranges) expect(spanOf(r)).toBeLessThanOrEqual(2048n);
  });

  it('plans a single range when head equals start', () => {
    expect(
      planRanges({ startBlock: 7n, agreedHead: 7n, maxRangeBlocks: 100, retryBudget: 1 }),
    ).toEqual([{ fromBlock: 7n, toBlock: 7n }]);
  });

  it('plans nothing when the head is behind the start', () => {
    expect(
      planRanges({ startBlock: 10n, agreedHead: 9n, maxRangeBlocks: 100, retryBudget: 1 }),
    ).toEqual([]);
  });

  it('handles heights above 2^53 without losing a block', () => {
    const start = (1n << 60n) + 1n;
    const ranges = planRanges({
      startBlock: start,
      agreedHead: start + 4n,
      maxRangeBlocks: 2,
      retryBudget: 1,
    });
    expect(ranges).toHaveLength(3);
    expect(ranges.at(-1)?.toBlock).toBe(start + 4n);
    expect(findRangeGaps(ranges, window(start, start + 4n))).toEqual([]);
  });

  it('rejects a capability of zero rather than looping forever', () => {
    expect(() =>
      planRanges({ startBlock: 1n, agreedHead: 2n, maxRangeBlocks: 0, retryBudget: 1 }),
    ).toThrow(/at least 1/);
  });
});

describe('splitRange', () => {
  it('halves a range without losing or duplicating a block', () => {
    const halves = splitRange(window(100n, 199n));
    expect(halves).not.toBeNull();
    const [a, b] = halves!;
    expect(a).toEqual({ fromBlock: 100n, toBlock: 149n });
    expect(b).toEqual({ fromBlock: 150n, toBlock: 199n });
    expect(spanOf(a) + spanOf(b)).toBe(spanOf(window(100n, 199n)));
  });

  it('splits an odd span without a gap', () => {
    const [a, b] = splitRange(window(1n, 3n))!;
    expect(b.fromBlock).toBe(a.toBlock + 1n);
    expect(spanOf(a) + spanOf(b)).toBe(3n);
  });

  it('refuses to split a single block', () => {
    expect(splitRange(window(5n, 5n))).toBeNull();
  });
});

describe('nextStep', () => {
  const range = window(100n, 199n);

  it('retries inside the budget', () => {
    expect(nextStep({ range, attempts: 0, retryBudget: 3 }, 'SILENT_TRUNCATION')).toEqual({
      kind: 'retry',
      range,
      attempts: 1,
    });
  });

  it('splits once the budget is spent', () => {
    const step = nextStep({ range, attempts: 2, retryBudget: 3 }, 'SILENT_TRUNCATION');
    expect(step.kind).toBe('split');
  });

  it('gives up immediately on a structural reason, without spending the budget', () => {
    // Splitting a pruned range still lands on the same missing history.
    expect(nextStep({ range, attempts: 0, retryBudget: 10 }, 'PRUNED_HISTORY')).toEqual({
      kind: 'give-up',
      reason: 'PRUNED_HISTORY',
    });
  });

  it('gives up with RANGE_INDIVISIBLE on a one-block range', () => {
    const single = window(42n, 42n);
    expect(nextStep({ range: single, attempts: 5, retryBudget: 3 }, 'SILENT_TRUNCATION')).toEqual({
      kind: 'give-up',
      reason: 'RANGE_INDIVISIBLE',
    });
  });

  it('terminates: repeated failure always narrows or stops', () => {
    // Drives the loop the engine runs, and asserts it cannot spin forever.
    let queue: BlockRange[] = [window(1n, 64n)];
    let steps = 0;
    const finished: BlockRange[] = [];
    while (queue.length > 0 && steps < 1000) {
      steps += 1;
      const r = queue.shift()!;
      const step = nextStep({ range: r, attempts: 99, retryBudget: 1 }, 'SILENT_TRUNCATION');
      if (step.kind === 'split') queue = [...step.ranges, ...queue];
      else finished.push(r);
    }
    expect(queue).toHaveLength(0);
    expect(steps).toBeLessThan(1000);
    // Every block ends up accounted for exactly once.
    expect(findRangeGaps(finished, window(1n, 64n))).toEqual([]);
    expect(finished.reduce((n, r) => n + spanOf(r), 0n)).toBe(64n);
  });
});
