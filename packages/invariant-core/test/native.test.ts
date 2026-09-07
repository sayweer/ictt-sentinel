import { describe, expect, it } from 'vitest';
import { components, completeCensus, nativeInput } from '@ictt-sentinel/testkit';
import { assessMinterCensus, assessNative } from '../src/native.js';

/**
 * The native rule may say three things and no more: `sufficient`,
 * `indeterminate`, `unknown`. There is no branch that reports an exact supply,
 * and none that reaches a red verdict from the upper bound alone.
 */

describe('reported upper bound', () => {
  it('computes U from the source-verified components', () => {
    // U = 1000 + 200 - 50 - 150 = 1000
    const r = assessNative(nativeInput());
    expect(r.intermediates.created).toBe(1_200n);
    expect(r.intermediates.burned).toBe(200n);
    expect(r.reportedUpperBound).toBe(1_000n);
  });

  it('U < A is sufficient, and says only that', () => {
    const r = assessNative(nativeInput({ eligibleHomeCoverage: 1_200n }));
    expect(r.assessment).toBe('sufficient');
    expect(r.critical).toBe(false);
    expect(r.headroom).toBe(200n);
    expect(r.reasons).toContain('ACC-N00-REPORTED-UPPER-BOUND-COVERED');
  });

  it('U == A is still sufficient', () => {
    const r = assessNative(nativeInput({ eligibleHomeCoverage: 1_000n }));
    expect(r.assessment).toBe('sufficient');
    expect(r.headroom).toBe(0n);
  });

  it('U > A alone is INDETERMINATE, never a proven shortfall', () => {
    // An unknown fee burn may already have reduced real supply below the bound,
    // so the upper bound exceeding coverage decides nothing by itself.
    const r = assessNative(nativeInput({ eligibleHomeCoverage: 900n }));
    expect(r.assessment).toBe('indeterminate');
    expect(r.critical).toBe(false);
    expect(r.reasons).toContain('ACC-N01-UPPER-BOUND-ABOVE-COVERAGE-INDETERMINATE');
  });

  it('turns red only when an established LOWER bound also exceeds coverage', () => {
    const r = assessNative(
      nativeInput({ eligibleHomeCoverage: 900n, trustworthySupplyLowerBound: 950n }),
    );
    expect(r.critical).toBe(true);
    expect(r.reasons).toContain('ACC-N02-SUPPLY-LOWER-BOUND-EXCEEDS-COVERAGE');
    // Even then the claim stays bounded language, never "exact supply".
    expect(r.assessment).toBe('indeterminate');
  });

  it('stays indeterminate when the lower bound does not exceed coverage', () => {
    const r = assessNative(
      nativeInput({ eligibleHomeCoverage: 900n, trustworthySupplyLowerBound: 850n }),
    );
    expect(r.critical).toBe(false);
    expect(r.assessment).toBe('indeterminate');
  });

  it.each([
    ['totalMinted', { totalMinted: null }],
    ['initialReserveImbalance', { initialReserveImbalance: null }],
    ['burnedTxFees', { burnedTxFeesAddressBalance: null }],
    ['burnedForTransfer', { burnedForTransferAddressBalance: null }],
  ])('is UNKNOWN when %s is missing', (_name, over) => {
    const r = assessNative(nativeInput({ components: over }));
    expect(r.assessment).toBe('unknown');
    expect(r.reasons).toContain('ACC-I07-MISSING-OBSERVATION');
  });

  it('is UNKNOWN on a stale component', () => {
    const r = assessNative(nativeInput({ components: { componentsFresh: false } }));
    expect(r.assessment).toBe('unknown');
    expect(r.reasons).toContain('ACC-I06-STALE-OBSERVATION');
  });

  it('is UNKNOWN on an unrecognised fingerprint', () => {
    const r = assessNative(nativeInput({ components: { fingerprintRecognised: false } }));
    expect(r.assessment).toBe('unknown');
    expect(r.reasons).toContain('ACC-U02-UNKNOWN-FINGERPRINT');
  });

  it('is UNKNOWN when coverage itself cannot be read', () => {
    const r = assessNative(nativeInput({ eligibleHomeCoverage: null }));
    expect(r.assessment).toBe('unknown');
    // The bound is still reported, because it was computable.
    expect(r.reportedUpperBound).toBe(1_000n);
  });
});

describe('burned fee reporting', () => {
  it('does not add the re-minted reward twice', () => {
    // The reward is already inside totalMinted; the bound must not grow.
    const withReport = assessNative(nativeInput({ feeReporting: { openReportEnvelopes: 2 } }));
    const without = assessNative(nativeInput());
    expect(withReport.reportedUpperBound).toBe(without.reportedUpperBound);
  });

  it('flags a duplicate report rather than netting it out', () => {
    const r = assessNative(nativeInput({ feeReporting: { duplicateReportObserved: true } }));
    expect(r.reasons).toContain('CFG-N04-DUPLICATE-FEE-REPORT');
  });

  it('refuses the bound when the re-mint semantics are not established', () => {
    const r = assessNative(
      nativeInput({ feeReporting: { reportedRewardAlreadyInTotalMinted: false } }),
    );
    expect(r.assessment).toBe('unknown');
    expect(r.reasons).toContain('CFG-N05-FEE-REMINT-SEMANTICS-UNVERIFIED');
  });
});

describe('minter exclusivity census', () => {
  it('is established only when all five parts are present', () => {
    expect(assessMinterCensus(completeCensus()).established).toBe(true);
  });

  it.each([
    ['manifest roster', { manifestRosterProvided: false }],
    ['genesis chain config', { genesisChainConfigRead: false }],
    ['activation rules', { activationRulesKnown: false }],
    ['role history', { roleHistoryCompleteFromActivation: false }],
    ['candidate role reads', { allCandidateRolesRead: false }],
  ])('is incomplete without %s', (_name, over) => {
    // `readAllowList(address)` is a point query; the allow list is not
    // enumerable, so a missing part means exclusivity cannot be claimed.
    const c = assessMinterCensus(completeCensus(over));
    expect(c.established).toBe(false);
    expect(c.reasons).toContain('CFG-N03-NATIVE-MINTER-CENSUS-INCOMPLETE');
  });

  it('splits role history by epoch across disable/re-enable upgrades', () => {
    const c = assessMinterCensus(completeCensus({ epochsCovered: 1, epochsExpected: 2 }));
    expect(c.established).toBe(false);
    expect(c.reasons).toContain('CFG-N03-NATIVE-MINTER-CENSUS-INCOMPLETE');
  });

  it('is a proven breach when an unexpected role holder exists', () => {
    const c = assessMinterCensus(completeCensus({ unexpectedRoleHolders: ['0xdead'] }));
    expect(c.critical).toBe(true);
    expect(c.reasons).toContain('CFG-N01-UNEXPECTED-MINTER-ROLE');
  });

  it('is a proven breach on an unauthorised mint', () => {
    const c = assessMinterCensus(completeCensus({ unauthorisedMintObserved: true }));
    expect(c.critical).toBe(true);
    expect(c.reasons).toContain('CFG-N02-UNAUTHORISED-NATIVE-MINT');
  });

  it('reports an unauthorised mint even when the census is otherwise incomplete', () => {
    const c = assessMinterCensus(
      completeCensus({ unauthorisedMintObserved: true, allCandidateRolesRead: false }),
    );
    expect(c.critical).toBe(true);
    expect(c.established).toBe(false);
  });
});

describe('exclusivity gates the positive claim', () => {
  it('never says sufficient while the census is incomplete', () => {
    // This is the rule the whole census exists for: a covered bound is not a
    // claim if anyone else might be minting.
    const r = assessNative(
      nativeInput({
        eligibleHomeCoverage: 10_000n,
        census: { allCandidateRolesRead: false },
      }),
    );
    expect(r.assessment).not.toBe('sufficient');
    expect(r.assessment).toBe('unknown');
    expect(r.minterExclusivityEstablished).toBe(false);
    expect(r.reasons).toContain('CFG-N03-NATIVE-MINTER-CENSUS-INCOMPLETE');
  });

  it('carries the breach through even with generous coverage', () => {
    const r = assessNative(
      nativeInput({
        eligibleHomeCoverage: 10_000n,
        census: { unexpectedRoleHolders: ['0xdead'] },
      }),
    );
    expect(r.critical).toBe(true);
    expect(r.assessment).not.toBe('sufficient');
  });
});

describe('language', () => {
  it('offers no assessment that could read as exact supply', () => {
    const seen = new Set<string>();
    for (const coverage of [900n, 1_000n, 1_200n]) {
      seen.add(assessNative(nativeInput({ eligibleHomeCoverage: coverage })).assessment);
    }
    for (const a of seen) expect(['sufficient', 'indeterminate', 'unknown']).toContain(a);
  });

  it('reports the components so the bound can be audited', () => {
    const r = assessNative(nativeInput({ components: components({ totalMinted: 5_000n }) }));
    expect(r.intermediates.created).toBe(5_200n);
    expect(r.intermediates.burned).toBe(200n);
    expect(r.reportedUpperBound).toBe(5_000n);
  });
});
