import { describe, expect, it } from 'vitest';
import { type AgreementPolicy, agree, provenanceOf } from '../src/agreement.js';
import { classifyObservation, type RangeResult } from '../src/range.js';
import { block, hex32, log, observation } from './fixtures.js';

const POLICY: AgreementPolicy = { requiredIndependentGroups: 2, archiveFallbackDeclared: false };

const resultFor = (group: string, over = {}): RangeResult => {
  const outcome = classifyObservation(observation({ providerGroup: group, ...over }));
  if (!outcome.ok) throw new Error(`fixture is not a valid observation: ${outcome.reason}`);
  return outcome.result;
};

describe('agree', () => {
  it('agrees when two independent groups return identical bytes', () => {
    const a = agree([resultFor('provider-alpha'), resultFor('provider-beta')], POLICY);
    expect(a.kind).toBe('agreed');
    if (a.kind === 'agreed') {
      expect(a.witnesses).toHaveLength(2);
      expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('blocks when groups disagree, and does NOT take a majority', () => {
    // Two agreeing and one disagreeing is not "2 of 3": it is evidence the chain
    // view is contested, and the honest answer is UNKNOWN.
    // Same heights, a different block at height 10, and logs that belong to it:
    // a well-formed answer that simply describes another chain view.
    const other = hex32(4242);
    const divergent = resultFor('provider-gamma', {
      blocks: [block(10, { blockHash: other }), block(11)],
      logs: [
        log(10, 0, 0, { blockHash: other }),
        log(10, 0, 1, { blockHash: other }),
        log(11, 0, 0),
      ],
      startBlockHash: other,
    });
    const a = agree([resultFor('provider-alpha'), resultFor('provider-beta'), divergent], {
      requiredIndependentGroups: 2,
      archiveFallbackDeclared: false,
    });
    expect(a).toMatchObject({ kind: 'blocked', reason: 'PROVIDER_DIVERGENCE' });
    if (a.kind === 'blocked') expect(a.byDigest.size).toBe(2);
  });

  it('blocks when too few independent groups answered', () => {
    const a = agree([resultFor('provider-alpha')], POLICY);
    expect(a).toMatchObject({ kind: 'blocked', reason: 'INSUFFICIENT_WITNESSES' });
  });

  it('counts one group once, however many endpoints it answered with', () => {
    // Two URLs behind one upstream are one witness (docs/INVARIANTS.md).
    const a = agree([resultFor('provider-alpha'), resultFor('provider-alpha')], POLICY);
    expect(a).toMatchObject({ kind: 'blocked', reason: 'INSUFFICIENT_WITNESSES' });
  });

  it('blocks an archive witness that policy never declared', () => {
    const a = agree(
      [resultFor('provider-alpha'), resultFor('provider-archive', { viaArchive: true })],
      POLICY,
    );
    expect(a).toMatchObject({ kind: 'blocked', reason: 'ARCHIVE_FALLBACK_UNAVAILABLE' });
  });

  it('accepts a declared, independent archive witness', () => {
    const a = agree(
      [resultFor('provider-alpha'), resultFor('provider-archive', { viaArchive: true })],
      { requiredIndependentGroups: 2, archiveFallbackDeclared: true },
    );
    expect(a.kind).toBe('agreed');
  });

  it('blocks an empty witness set', () => {
    expect(agree([], POLICY)).toMatchObject({ kind: 'blocked', reason: 'INSUFFICIENT_WITNESSES' });
  });

  it('requires the higher threshold when policy demands three groups', () => {
    const strict: AgreementPolicy = {
      requiredIndependentGroups: 3,
      archiveFallbackDeclared: false,
    };
    expect(agree([resultFor('a'), resultFor('b')], strict)).toMatchObject({
      kind: 'blocked',
      reason: 'INSUFFICIENT_WITNESSES',
    });
    expect(agree([resultFor('a'), resultFor('b'), resultFor('c')], strict).kind).toBe('agreed');
  });
});

describe('provenanceOf', () => {
  it('records which groups agreed and what the threshold was', () => {
    const a = agree([resultFor('provider-beta'), resultFor('provider-alpha')], POLICY);
    if (a.kind !== 'agreed') throw new Error('expected agreement');
    const p = provenanceOf(a, POLICY);
    // Sorted, so the same evidence serialises identically on every run.
    expect(p.providerGroups).toEqual(['provider-alpha', 'provider-beta']);
    expect(p.requiredIndependentGroups).toBe(2);
    expect(p.startBlockHash).toBe(hex32(10));
    expect(p.endBlockHash).toBe(hex32(11));
    expect(p.digest).toBe(a.digest);
  });
});
