import { describe, expect, it } from 'vitest';
import { assessCompleteness, isGapClosed, REPLAY_STATUSES } from '../src/completeness.js';
import type { BlockRange } from '../src/plan.js';

const WINDOW: BlockRange = { fromBlock: 100n, toBlock: 199n };
const FULL: readonly BlockRange[] = [{ fromBlock: 100n, toBlock: 199n }];
const NOW = new Date('2026-04-01T12:00:00Z');
const TTL = 60 * 60 * 1000; // one hour

const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);

const assess = (over: Partial<Parameters<typeof assessCompleteness>[0]> = {}) =>
  assessCompleteness({
    window: WINDOW,
    committed: FULL,
    lastSuccessAt: at(1000),
    freshnessTtlMs: TTL,
    openReasons: [],
    now: NOW,
    ...over,
  });

describe('assessCompleteness', () => {
  it('is complete and OK only when the window is covered and fresh', () => {
    const r = assess();
    expect(r.status).toBe('complete');
    expect(r.verdict).toBe('OK');
    expect(r.gaps).toEqual([]);
  });

  it('is pending, never OK, before the first success', () => {
    const r = assess({ lastSuccessAt: null });
    expect(r.status).toBe('pending');
    expect(r.verdict).toBe('UNKNOWN');
  });

  it('turns a covered-but-old window into stale UNKNOWN', () => {
    // The rule this exists for: a previous OK must not stay green forever while
    // new collections are failing.
    const r = assess({ lastSuccessAt: at(TTL + 1) });
    expect(r.status).toBe('stale');
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.reasons).toContain('STALE_COLLECTION');
  });

  it('keeps OK exactly at the TTL boundary', () => {
    expect(assess({ lastSuccessAt: at(TTL) }).status).toBe('complete');
    expect(assess({ lastSuccessAt: at(TTL + 1) }).status).toBe('stale');
  });

  it('reports a gap as UNKNOWN even when the collection is fresh', () => {
    const r = assess({ committed: [{ fromBlock: 100n, toBlock: 150n }] });
    expect(r.status).toBe('gap');
    expect(r.verdict).toBe('UNKNOWN');
    expect(r.gaps).toEqual([{ fromBlock: 151n, toBlock: 199n }]);
  });

  it('ranks divergence above every other signal', () => {
    const r = assess({
      committed: [{ fromBlock: 100n, toBlock: 150n }],
      openReasons: ['PROVIDER_DIVERGENCE', 'SILENT_TRUNCATION'],
    });
    expect(r.status).toBe('divergent');
    expect(r.verdict).toBe('UNKNOWN');
  });

  it('reports a structural failure as blocked', () => {
    expect(assess({ openReasons: ['PRUNED_HISTORY'] }).status).toBe('blocked');
    expect(assess({ openReasons: ['RETRY_BUDGET_EXHAUSTED'] }).status).toBe('blocked');
    expect(assess({ openReasons: ['NONCANONICAL_BLOCK_REJECTED'] }).status).toBe('blocked');
  });

  it('never returns OK for any status other than complete', () => {
    // Exhaustive over the status set, so a future status cannot quietly be green.
    const cases = [
      assess({ lastSuccessAt: null }),
      assess({ committed: [] }),
      assess({ lastSuccessAt: at(TTL + 1) }),
      assess({ openReasons: ['PROVIDER_DIVERGENCE'] }),
      assess({ openReasons: ['PRUNED_HISTORY'] }),
      assess(),
    ];
    expect(new Set(cases.map((c) => c.status)).size).toBeGreaterThan(1);
    for (const c of cases) {
      if (c.status !== 'complete') expect(c.verdict).toBe('UNKNOWN');
      else expect(c.verdict).toBe('OK');
    }
    for (const c of cases) expect(REPLAY_STATUSES).toContain(c.status);
  });

  it('is a pure function of its inputs', () => {
    expect(assess()).toEqual(assess());
  });
});

describe('isGapClosed', () => {
  const gap: BlockRange = { fromBlock: 151n, toBlock: 199n };

  it('is closed only by full coverage of the gap', () => {
    expect(isGapClosed(gap, [{ fromBlock: 151n, toBlock: 199n }])).toBe(true);
  });

  it('stays open on partial recovery', () => {
    // Half a recovery range is not a closed gap.
    expect(isGapClosed(gap, [{ fromBlock: 151n, toBlock: 180n }])).toBe(false);
  });

  it('stays open when nothing was recovered', () => {
    expect(isGapClosed(gap, [])).toBe(false);
  });
});
