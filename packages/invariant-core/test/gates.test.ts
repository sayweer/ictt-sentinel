import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bothDirectionsPending,
  coverageShortfall,
  creditedEffect,
  escrowSurplus,
  excessRemoteSupply,
  homeToRemotePending,
  pendingEnvelope,
  proofInput,
  remote,
  remoteToHomePending,
  SCALE_18_TO_6,
  unexplainedDelta,
} from '@ictt-sentinel/testkit';
import { evaluateCanonicalErc20 } from '../src/engine.js';
import { evaluateGateA } from '../src/gate-a.js';
import { evaluateGateB, toHomeUnits } from '../src/gate-b.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const run = (input: Parameters<typeof evaluateCanonicalErc20>[0]) =>
  evaluateCanonicalErc20(input, sha256);

describe('Gate A - exact reconciliation', () => {
  it('reconciles the quiet case where D equals S and nothing is in flight', () => {
    const e = run(proofInput({ escrowBalance: 10n ** 6n }));
    expect(e.gateA.outcome).toBe('pass');
    expect(e.gateA.reasons).toContain('ACC-A00-RECONCILED');
    expect(e.output.measurement).toEqual({
      expected: 0n,
      observed: 0n,
      delta: 0n,
      unit: 'remote-base-units',
    });
  });

  it.each([
    ['home to remote', homeToRemotePending(500n), 500n],
    ['remote to home', remoteToHomePending(250n), 250n],
    ['both directions at once', bothDirectionsPending(500n, 250n), 750n],
  ])('reconciles with %s pending', (_name, input, expectedPending) => {
    const e = run(input);
    expect(e.gateA.outcome).toBe('pass');
    // D - S equals the pending total exactly. No tolerance anywhere.
    expect(e.output.measurement?.observed).toBe(expectedPending);
    expect(e.output.measurement?.delta).toBe(0n);
    expect(e.output.pending?.total).toBe(expectedPending);
  });

  it('reports excess remote supply as a CRITICAL candidate', () => {
    // Both pendings raise D above S, so D < S cannot be anything in flight.
    const e = run(excessRemoteSupply(100n));
    expect(e.gateA.outcome).toBe('fail');
    expect(e.gateA.critical).toBe(true);
    expect(e.gateA.reasons).toContain('ACC-A01-EXCESS-REMOTE-REPRESENTATION');
    expect(e.output.result).toBe('FAIL');
    expect(e.output.verdictCandidate).toBe('CRITICAL');
  });

  it('does NOT call an unexplained surplus delta an economic finding', () => {
    // D > S but not by the pending total. Missing history and a decoder fault
    // look identical from here, so the honest answer is UNKNOWN.
    const e = run(unexplainedDelta(77n));
    expect(e.gateA.outcome).toBe('unknown');
    expect(e.gateA.critical).toBe(false);
    expect(e.gateA.reasons).toContain('ACC-A02-DELTA-UNEXPLAINED');
    expect(e.output.verdictCandidate).toBe('UNKNOWN');
    expect(e.output.verdictCandidate).not.toBe('CRITICAL');
  });

  it.each([
    ['duplicate effect', { duplicateEffect: true }, 'ACC-A03-DUPLICATE-ECONOMIC-EFFECT'],
    ['unauthorised mint', { hasUniqueAuthorisedSource: false }, 'ACC-A04-UNAUTHORISED-MINT'],
    ['no causal source', { causalSourceFact: null }, 'ACC-A04-UNAUTHORISED-MINT'],
    ['route mismatch', { routeMatchesSource: false }, 'ACC-A05-ROUTE-MISMATCH'],
  ])('fails on %s', (_name, over, code) => {
    const e = run(proofInput({ effects: [creditedEffect(over)], escrowBalance: 10n ** 6n }));
    expect(e.gateA.outcome).toBe('fail');
    expect(e.gateA.critical).toBe(true);
    expect(e.gateA.reasons).toContain(code);
  });

  it('never double counts initial collateral on this route', () => {
    // Canonical ERC20 remotes start with a zero reserve imbalance, so no
    // collateral term participates. Accepted collateral is tracked separately
    // and must not move the reconciliation.
    const withCollateral = run(
      proofInput({ acceptedCollateralHomeUnits: 10n ** 9n, escrowBalance: 10n ** 9n }),
    );
    const without = run(proofInput({ escrowBalance: 10n ** 9n }));
    expect(withCollateral.output.measurement).toEqual(without.output.measurement);
    expect(withCollateral.gateA.outcome).toBe('pass');
  });

  it('treats a non-zero initial reserve as a different family, not an extra term', () => {
    const e = run(proofInput({ remotes: [remote({ initialReserveImbalance: 1n })] }));
    expect(e.gateA.outcome).toBe('unsupported');
    expect(e.output.result).toBe('UNSUPPORTED');
    expect(e.output.verdictCandidate).toBe('UNKNOWN');
  });
});

describe('Gate A - input contract produces UNKNOWN, never an exception', () => {
  it.each([
    ['no manifest hash', { manifestHash: null }, 'ACC-I01-NO-APPROVED-BASELINE'],
    ['no source lock', { sourceLockCommitSha: null }, 'ACC-I02-NO-SOURCE-LOCK-VERSION'],
    ['partial census', { census: 'partial' as const }, 'ACC-I03-CENSUS-INCOMPLETE'],
    ['open causal cut', { cut: 'open' as const }, 'ACC-I05-CAUSAL-CUT-OPEN'],
    ['gapped cut', { cut: 'gap' as const }, 'ACC-I05-CAUSAL-CUT-OPEN'],
    ['stale observations', { fresh: false }, 'ACC-I06-STALE-OBSERVATION'],
    ['too few witnesses', { witnessGroups: 1 }, 'ACC-I04-NO-PINNED-BLOCK'],
    ['untracked remote', { untrackedRemotes: ['0xdead'] }, 'ACC-B02-UNTRACKED-REMOTE-LIABILITY'],
  ])('is UNKNOWN with %s', (_name, over, code) => {
    const e = run(proofInput(over));
    expect(e.gateA.outcome).toBe('unknown');
    expect(e.gateA.reasons).toContain(code);
    expect(e.output.result).toBe('UNKNOWN');
    expect(e.output.verdictCandidate).toBe('UNKNOWN');
  });

  it.each([
    ['missing transferred balance', { transferredBalance: null }, 'ACC-I07-MISSING-OBSERVATION'],
    ['missing remote supply', { remoteTotalSupply: null }, 'ACC-I07-MISSING-OBSERVATION'],
    ['no home pin', { homePin: false }, 'ACC-I04-NO-PINNED-BLOCK'],
    ['no remote pin', { remotePin: false }, 'ACC-I04-NO-PINNED-BLOCK'],
    ['unestablished scale', { established: false }, 'ACC-I08-UNKNOWN-TOKEN-SCALE'],
  ])('is UNKNOWN with %s', (_name, over, code) => {
    const e = run(proofInput({ remotes: [remote(over)] }));
    expect(e.gateA.outcome).toBe('unknown');
    expect(e.gateA.reasons).toContain(code);
  });

  it.each([
    ['unknown fingerprint', { fingerprintRecognised: false }, 'ACC-U02-UNKNOWN-FINGERPRINT'],
    [
      'rebase or fee token',
      { tokenBehaviourCanonical: false },
      'ACC-U03-UNSUPPORTED-TOKEN-BEHAVIOUR',
    ],
    ['multi-hop route', { routeSingleHop: false }, 'ACC-U04-UNSUPPORTED-ROUTE'],
  ])('is UNSUPPORTED with %s', (_name, over, code) => {
    const e = run(proofInput({ remotes: [remote(over)] }));
    expect(e.output.result).toBe('UNSUPPORTED');
    expect(e.gateA.reasons).toContain(code);
    expect(e.output.verdictCandidate).toBe('UNKNOWN');
  });

  it('refuses a family it was not verified for', () => {
    const e = run(proofInput({ family: 'native-token' }));
    expect(e.output.result).toBe('UNSUPPORTED');
    expect(e.gateA.reasons).toContain('ACC-U01-UNSUPPORTED-FAMILY');
  });
});

describe('pending age is liveness, never a coverage headline', () => {
  it('reports an aged envelope without changing the reconciliation', () => {
    const input = proofInput({
      remotes: [remote({ transferredBalance: 1_500n, remoteTotalSupply: 1_000n })],
      pending: [pendingEnvelope('home-to-remote', 500n, { ageSeconds: 100_000 })],
      escrowBalance: 10n ** 6n,
    });
    const e = run(input);
    // Still reconciled, still OK; the age shows up beside it, not instead of it.
    expect(e.gateA.outcome).toBe('pass');
    expect(e.gateA.reasons).toContain('ACC-A00-RECONCILED');
    expect(e.gateA.reasons).toContain('ACC-L01-PENDING-AGE-EXCEEDED');
    expect(e.output.pending?.overAgeCount).toBe(1);
    expect(e.output.result).toBe('PASS');
  });
});

describe('Gate B - physical coverage', () => {
  it('does not run before Gate A passes', () => {
    const e = run(excessRemoteSupply());
    expect(e.gateB.outcome).toBe('unknown');
    expect(e.gateB.reasons).toContain('ACC-B03-GATE-A-NOT-PASSED');
  });

  it('passes when escrow covers the conservative liability', () => {
    const e = run(proofInput({ escrowBalance: 10n ** 6n }));
    expect(e.gateB.outcome).toBe('pass');
    expect(e.output.result).toBe('PASS');
    expect(e.output.verdictCandidate).toBe('OK');
  });

  it('accepts surplus: equality is not required', () => {
    // A donation raises the balance. Demanding equality would alarm on a
    // perfectly healthy deployment.
    const e = run(escrowSurplus());
    expect(e.gateB.outcome).toBe('pass');
    expect(e.gateB.surplus).toBeGreaterThan(0n);
    expect(e.output.result).toBe('PASS');
  });

  it('fails when escrow is below the conservative liability', () => {
    const e = run(coverageShortfall());
    expect(e.gateB.outcome).toBe('fail');
    expect(e.gateB.reasons).toContain('ACC-B01-COVERAGE-SHORTFALL');
    expect(e.output.result).toBe('FAIL');
    // A coverage shortfall is not a proven economic breach: only Gate A raises
    // CRITICAL.
    expect(e.output.verdictCandidate).toBe('WARN');
  });

  it('models floor, ceil and dust rather than tolerating a difference', () => {
    // 1000 remote units at multiplier 1e12 redeems to 0 home units and is
    // conservatively 1.
    const b = evaluateGateB(proofInput({ escrowBalance: 1n }), true);
    expect(b.floorLiability).toBe(0n);
    expect(b.conservativeLiability).toBe(1n);
    expect(b.totalDust).toBe(1n);
    expect(b.outcome).toBe('pass');
  });

  it('has no dust when the conversion multiplies instead of dividing', () => {
    const b = evaluateGateB(
      proofInput({
        remotes: [
          remote({
            transferredBalance: 7n,
            remoteTotalSupply: 7n,
            tokenMultiplier: SCALE_18_TO_6.tokenMultiplier,
            multiplyOnRemote: SCALE_18_TO_6.multiplyOnRemote,
            homeDecimals: 18,
            remoteDecimals: 6,
          }),
        ],
        escrowBalance: 7n * 10n ** 12n,
      }),
      true,
    );
    expect(b.totalDust).toBe(0n);
    expect(b.floorLiability).toBe(b.conservativeLiability);
    expect(b.outcome).toBe('pass');
  });

  it('cannot claim coverage while a registered remote is untracked', () => {
    // An unobserved remote is not zero liability.
    const b = evaluateGateB(proofInput({ untrackedRemotes: ['0xdead'] }), true);
    expect(b.outcome).toBe('unknown');
    expect(b.reasons).toContain('ACC-B02-UNTRACKED-REMOTE-LIABILITY');
  });

  it('cannot claim coverage from a partial census', () => {
    const b = evaluateGateB(proofInput({ census: 'partial' }), true);
    expect(b.outcome).toBe('unknown');
  });

  it('is UNKNOWN without an escrow observation', () => {
    expect(evaluateGateB(proofInput({ escrowBalance: null }), true).outcome).toBe('unknown');
    expect(evaluateGateB(proofInput({ homeEscrowPin: false }), true).outcome).toBe('unknown');
  });
});

describe('toHomeUnits', () => {
  it('truncates downward and rounds the ceiling up, matching Solidity division', () => {
    expect(toHomeUnits(5n, 2n, true)).toEqual({ ok: true, floor: 2n, ceil: 3n });
    expect(toHomeUnits(4n, 2n, true)).toEqual({ ok: true, floor: 2n, ceil: 2n });
  });

  it('multiplies exactly when multiplyOnRemote is false', () => {
    expect(toHomeUnits(3n, 5n, false)).toEqual({ ok: true, floor: 15n, ceil: 15n });
  });

  it('refuses a zero multiplier instead of dividing by zero', () => {
    expect(toHomeUnits(1n, 0n, true)).toEqual({ ok: false, reason: 'division-by-zero' });
  });

  it('refuses to wrap past uint256', () => {
    const max = (1n << 256n) - 1n;
    expect(toHomeUnits(max, 2n, false)).toEqual({ ok: false, reason: 'overflow' });
  });

  it('handles uint256 max in the dividing direction', () => {
    const max = (1n << 256n) - 1n;
    const r = toHomeUnits(max, 10n ** 12n, true);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.floor).toBe(max / 10n ** 12n);
      expect(r.ceil).toBe(r.floor + 1n);
    }
  });

  it('is zero-safe at the minimum amount', () => {
    expect(toHomeUnits(0n, 10n ** 12n, true)).toEqual({ ok: true, floor: 0n, ceil: 0n });
    expect(toHomeUnits(1n, 10n ** 12n, true)).toEqual({ ok: true, floor: 0n, ceil: 1n });
  });
});

describe('arithmetic boundaries', () => {
  it('refuses a supply above uint256 rather than clamping', () => {
    const over = (1n << 256n) + 1n;
    const a = evaluateGateA(proofInput({ remotes: [remote({ remoteTotalSupply: over })] }));
    expect(a.outcome).toBe('unknown');
    expect(a.reasons).toContain('ACC-A06-ARITHMETIC-OUT-OF-RANGE');
  });

  it('reconciles at uint256 max', () => {
    const max = (1n << 256n) - 1n;
    const e = run(
      proofInput({
        remotes: [remote({ transferredBalance: max, remoteTotalSupply: max })],
        escrowBalance: max,
      }),
    );
    expect(e.gateA.outcome).toBe('pass');
  });
});
