import { describe, expect, it } from 'vitest';
import { type PriorityHint, admitHint, hintId, prioritise } from '../src/hints.js';
import { planRanges } from '../src/plan.js';
import { AT } from './fixtures.js';

const hint = (dedupKey: string, block: bigint): PriorityHint => ({
  hintId: hintId('webhook', dedupKey),
  deploymentId: 'acme-usdc',
  chainKey: 'home',
  suggestedBlockNumber: block,
  source: 'webhook',
  dedupKey,
  receivedAt: AT,
});

describe('hintId', () => {
  it('is deterministic, so a redelivery maps to the same row', () => {
    expect(hintId('webhook', 'evt-1')).toBe(hintId('webhook', 'evt-1'));
    expect(hintId('webhook', 'evt-1')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates sources that happen to share an event key', () => {
    expect(hintId('webhook', 'evt-1')).not.toBe(hintId('metrics-api', 'evt-1'));
  });
});

describe('admitHint', () => {
  const policy = { maxDepth: 3 };

  it('admits a new hint', () => {
    expect(admitHint(hint('evt-1', 10n), new Set(), 0, policy)).toMatchObject({ kind: 'accepted' });
  });

  it('drops a redelivered event instead of queueing the work twice', () => {
    expect(admitHint(hint('evt-1', 10n), new Set(['evt-1']), 1, policy)).toEqual({
      kind: 'duplicate',
      dedupKey: 'evt-1',
    });
  });

  it('is bounded: a flood is rejected rather than growing the queue', () => {
    // An unbounded hint queue is a denial-of-service surface reachable by anyone
    // who can post a webhook.
    expect(admitHint(hint('evt-9', 10n), new Set(), 3, policy)).toEqual({
      kind: 'rejected',
      reason: 'queue-full',
    });
  });

  it('checks duplication before capacity, so a redelivery never fills the queue', () => {
    expect(admitHint(hint('evt-1', 10n), new Set(['evt-1']), 3, policy)).toMatchObject({
      kind: 'duplicate',
    });
  });
});

describe('prioritise', () => {
  const planned = planRanges({
    startBlock: 100n,
    agreedHead: 399n,
    maxRangeBlocks: 100,
    retryBudget: 1,
  });

  it('moves a hinted range to the front', () => {
    const ordered = prioritise(planned, [hint('evt-1', 250n)]);
    expect(ordered[0]).toEqual({ fromBlock: 200n, toBlock: 299n });
  });

  it('is a permutation: hints can neither add nor remove coverage', () => {
    // The entire authority a hint has. Replay covers exactly the same heights
    // with and without hints; only the order changes.
    const ordered = prioritise(planned, [hint('evt-1', 250n), hint('evt-2', 380n)]);
    expect(ordered).toHaveLength(planned.length);
    expect([...ordered].sort((a, b) => Number(a.fromBlock - b.fromBlock))).toEqual([...planned]);
  });

  it('is deterministic and stable within a tier', () => {
    const a = prioritise(planned, [hint('evt-1', 250n)]);
    const b = prioritise(planned, [hint('evt-1', 250n)]);
    expect(a).toEqual(b);
    // Unhinted ranges keep ascending height order.
    const tail = a.slice(1);
    for (let i = 1; i < tail.length; i += 1) {
      expect(tail[i]!.fromBlock > tail[i - 1]!.fromBlock).toBe(true);
    }
  });

  it('leaves the plan untouched when nothing is hinted', () => {
    expect(prioritise(planned, [])).toEqual(planned);
  });

  it('ignores a hint outside the planned window', () => {
    // A hint pointing past the agreed head cannot conjure a range to replay.
    const ordered = prioritise(planned, [hint('evt-far', 99_999n)]);
    expect(ordered).toEqual(planned);
  });
});
