import { describe, expect, it } from 'vitest';
import {
  HOME_CHAIN,
  REMOTE_CHAIN,
  happyPath,
  hex32,
  input,
  messageKey,
} from '@ictt-sentinel/testkit';
import { reduceAll } from '../src/aggregate.js';
import { type ChainCut, assessCut, cutPermitsEvaluation } from '../src/watermark.js';

const cut = (blockchainId: string, blockNumber: number): ChainCut => ({
  blockchainId,
  blockNumber: BigInt(blockNumber),
  blockHash: hex32(blockNumber),
});

const cuts = (home: number | null, remote: number | null): ReadonlyMap<string, ChainCut> => {
  const m = new Map<string, ChainCut>();
  if (home !== null) m.set(HOME_CHAIN, cut(HOME_CHAIN, home));
  if (remote !== null) m.set(REMOTE_CHAIN, cut(REMOTE_CHAIN, remote));
  return m;
};

const aggregate = (facts = happyPath()) => reduceAll(messageKey(), facts);

describe('assessCut', () => {
  it('is closed when both the cause and the effect are inside the cut', () => {
    // Source facts at 100, destination at 200.
    const a = assessCut([aggregate()], cuts(150, 250));
    expect(a.outcome).toBe('closed');
    expect(a.openEdges).toEqual([]);
    expect(cutPermitsEvaluation(a)).toBe(true);
  });

  it('is open when the destination effect is inside the cut but its cause is not', () => {
    // The failure this whole mechanism exists to prevent: a credit visible on the
    // destination while the debit that caused it is still outside the source cut.
    const a = assessCut([aggregate()], cuts(50, 250));
    expect(a.outcome).toBe('open');
    expect(a.openEdges[0]?.reason).toBe('source-fact-outside-cut');
    expect(a.openEdges[0]?.blockchainId).toBe(HOME_CHAIN);
    expect(cutPermitsEvaluation(a)).toBe(false);
  });

  it('is open when the destination effect has no observed cause at all', () => {
    const destinationOnly = happyPath().filter(
      (i) => i.kind === 'delivered' || i.kind === 'execution-succeeded',
    );
    const a = assessCut([reduceAll(messageKey(), destinationOnly)], cuts(150, 250));
    expect(a.outcome).toBe('open');
    expect(a.openEdges[0]?.reason).toBe('source-fact-not-observed');
  });

  it('imposes no obligation while the destination effect is outside the cut', () => {
    // Nothing has been credited yet, so there is nothing to reconcile.
    const a = assessCut([aggregate()], cuts(150, 150));
    expect(a.outcome).toBe('closed');
    expect(a.closedMessages).toEqual([]);
  });

  it('is a gap when a chain has no pinned cut', () => {
    const a = assessCut([aggregate()], cuts(150, null));
    expect(a.outcome).toBe('gap');
    expect(a.chainsWithoutCut).toEqual([REMOTE_CHAIN]);
    expect(cutPermitsEvaluation(a)).toBe(false);
  });

  it('ranks a gap above an open edge', () => {
    const a = assessCut([aggregate()], cuts(null, 250));
    expect(a.outcome).toBe('gap');
  });

  it('does not use wall-clock proximity as a substitute for closure', () => {
    // The facts carry no timestamp here at all. Closure is decided purely from
    // pinned heights and causal edges, so a "recent" read cannot stand in for one.
    const timeless = happyPath().map(({ observedAt: _drop, ...rest }) => rest);
    expect(assessCut([reduceAll(messageKey(), timeless)], cuts(150, 250)).outcome).toBe('closed');
    expect(assessCut([reduceAll(messageKey(), timeless)], cuts(50, 250)).outcome).toBe('open');
  });

  it('is independent of the order the aggregates are presented in', () => {
    const other = messageKey({ messageId: hex32(0xdef) });
    const a = aggregate();
    const b = reduceAll(other, happyPath(other));
    const forward = assessCut([a, b], cuts(150, 250));
    const reversed = assessCut([b, a], cuts(150, 250));
    expect(reversed).toEqual(forward);
  });

  it('reports every open edge, not just the first', () => {
    const other = messageKey({ messageId: hex32(0xdef) });
    const a = assessCut([aggregate(), reduceAll(other, happyPath(other))], cuts(50, 250));
    expect(a.outcome).toBe('open');
    expect(a.openEdges.length).toBeGreaterThanOrEqual(2);
  });

  it('treats a source fact exactly at the cut height as inside it', () => {
    const a = assessCut([aggregate()], cuts(100, 200));
    expect(a.outcome).toBe('closed');
    expect(a.closedMessages).toHaveLength(1);
  });

  it('holds a message open when only part of its source evidence is inside', () => {
    // icm-sent at 100 is inside, a later source-accounted at 140 is not.
    const facts = [
      ...happyPath().filter((i) => i.kind !== 'source-accounted'),
      input('source-accounted', { blockNumber: 140, logIndex: 2 }),
    ];
    const a = assessCut([reduceAll(messageKey(), facts)], cuts(120, 250));
    expect(a.outcome).toBe('open');
  });
});
