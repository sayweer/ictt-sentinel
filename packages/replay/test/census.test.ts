import { describe, expect, it } from 'vitest';
import {
  type CensusInput,
  type RegisteredRemoteEvent,
  buildCensus,
  globalCoverageKnown,
} from '../src/census.js';
import { hex20, hex32 } from './fixtures.js';

const event = (n: number): RegisteredRemoteEvent => ({
  remoteBlockchainId: hex32(n),
  remoteAddress: hex20(n),
  registeredAtBlock: BigInt(1000 + n),
  registeredAtBlockHash: hex32(5000 + n),
});

const input = (over: Partial<CensusInput> = {}): CensusInput => ({
  homeStartBlock: 38_000_000n,
  agreedHead: 38_100_000n,
  historyFullyReplayed: true,
  observed: [event(1), event(2)],
  approved: [{ remoteBlockchainId: hex32(1), remoteAddress: hex20(1) }],
  ...over,
});

describe('buildCensus', () => {
  it('reports an unapproved remote as a candidate, never as trusted', () => {
    const c = buildCensus(input());
    expect(c.candidates).toHaveLength(1);
    expect(c.candidates[0]?.remoteBlockchainId).toBe(hex32(2));
    // There is no code path that emits anything else.
    expect(c.candidates.every((x) => x.trust === 'candidate')).toBe(true);
  });

  it('does not list an approved remote as a candidate', () => {
    const c = buildCensus(input());
    expect(c.candidates.map((x) => x.remoteBlockchainId)).not.toContain(hex32(1));
  });

  it('reports an approved remote that history never showed', () => {
    const c = buildCensus(input({ observed: [event(2)] }));
    expect(c.missingFromHistory).toEqual([
      { remoteBlockchainId: hex32(1), remoteAddress: hex20(1) },
    ]);
  });

  it('emits a mutual-verification task for every observed remote', () => {
    const c = buildCensus(input());
    expect(c.crossChecks).toHaveLength(2);
    expect(c.crossChecks[0]?.checks).toEqual([
      'home-blockchain-id-matches',
      'home-address-matches',
      'remote-code-fingerprint-recognised',
    ]);
  });

  it('is incomplete, with a reason, when history was not fully replayed', () => {
    // A partial list reported as "the census" is the fail-open this prevents.
    const c = buildCensus(input({ historyFullyReplayed: false }));
    expect(c.complete).toBe(false);
    expect(c.reasons).toContain('REMOTE_HISTORY_UNAVAILABLE');
    // The evidence is still reported - it is real, just not complete.
    expect(c.candidates).toHaveLength(1);
  });

  it('is complete with no drift when observation matches approval exactly', () => {
    const c = buildCensus(
      input({
        observed: [event(1)],
        approved: [{ remoteBlockchainId: hex32(1), remoteAddress: hex20(1) }],
      }),
    );
    expect(c.candidates).toEqual([]);
    expect(c.missingFromHistory).toEqual([]);
    expect(c.complete).toBe(true);
    expect(c.reasons).toEqual([]);
  });
});

describe('globalCoverageKnown', () => {
  const reachable = (...ns: number[]) => new Set(ns.map((n) => `${hex32(n)}|${hex20(n)}`));

  it('is known when the census is complete and every remote is reachable', () => {
    expect(globalCoverageKnown(buildCensus(input()), reachable(1, 2))).toBe(true);
  });

  it('is unknown when one remote has no reachable history', () => {
    // Coverage is a claim about the whole set; one unreadable member withdraws it.
    expect(globalCoverageKnown(buildCensus(input()), reachable(1))).toBe(false);
  });

  it('is unknown when the census itself is incomplete', () => {
    expect(
      globalCoverageKnown(buildCensus(input({ historyFullyReplayed: false })), reachable(1, 2)),
    ).toBe(false);
  });
});
