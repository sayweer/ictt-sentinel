import { aggregate, exitCodeFor } from '@ictt-sentinel/invariant-core';
import { replayProof } from '@ictt-sentinel/evidence';
import {
  creditedEffect,
  pendingEnvelope,
  proofInput,
  remote,
  type ProofOptions,
} from '@ictt-sentinel/testkit';
import { deriveCollateralNeeded, applyTokenScale } from '@ictt-sentinel/ictt-adapters';
import type { Observed, Scenario } from '../registry.js';

/**
 * Accounting faults.
 *
 * These drive the real canonical ERC20 engine through `replayProof`, the same
 * function the CLI and the evidence bundle use. A scenario that recomputed the
 * equation itself would be checking arithmetic against arithmetic; what matters
 * is whether the shipped rule calls the breach.
 */

/** One evaluation, reported the way the CLI reports it. */
const evaluateFrom = (options: ProofOptions): Observed => {
  const input = proofInput(options);
  const { aggregation, evaluation } = replayProof(input);
  const verdict = aggregate(aggregation);
  return {
    protocolStatus: verdict.protocolStatus,
    dataStatus: verdict.dataStatus,
    reasonCodes: [...verdict.reasonCodes],
    exitCode: exitCodeFor(verdict),
    digest: evaluation.output.inputDigest,
  };
};

export const accountingScenarios: readonly Scenario[] = [
  {
    id: 'accounting/reconciled-baseline',
    title: 'The reconciled baseline, so the corpus has a control',
    corpus: 'operational',
    provenance: 'docs/PROTOCOL_SOURCE_LOCK.md 9.2 (D_r - S_r = P_h2r + P_r2h)',
    pinned: { transferredBalance: '1000', remoteSupply: '1000', pending: '0', escrow: '1' },
    // The control matters: a corpus in which nothing can pass would also report
    // zero false negatives while proving nothing.
    expect: { protocolStatus: 'OK', dataStatus: 'COMPLETE', exitCode: 0, digest: 'stable' },
    run: () => evaluateFrom({}),
  },
  {
    id: 'accounting/unbacked-remote-supply',
    title: 'Remote supply exceeds home accounting under a closed cut',
    corpus: 'deterministic-breach',
    provenance: 'docs/INVARIANTS.md 1; gate A',
    pinned: { transferredBalance: '1000', remoteSupply: '1100', cut: 'closed' },
    expect: { protocolStatus: 'CRITICAL', exitCode: 2, digest: 'stable' },
    run: () =>
      evaluateFrom({
        remotes: [remote({ transferredBalance: 1_000n, remoteTotalSupply: 1_100n })],
        escrowBalance: 10n ** 6n,
      }),
  },
  {
    id: 'accounting/unexplained-delta-is-not-a-breach',
    title: 'D above S with nothing in flight is UNKNOWN, never a shortfall',
    corpus: 'gap',
    // The asymmetry is deliberate and documented in gate-a.ts: missing history,
    // a decoder fault and a stale read all produce this same shape, so calling
    // it a breach would be the false positive that destroys the product's only
    // real asset. The opposite direction - remote supply exceeding home
    // accounting - has no such innocent reading and IS critical.
    provenance: 'packages/invariant-core/src/gate-a.ts (ACC-A02); docs/INVARIANTS.md 1',
    pinned: { transferredBalance: '1077', remoteSupply: '1000', pending: '0' },
    expect: {
      protocolStatus: 'UNKNOWN',
      exitCode: 3,
      reasonCodes: ['ACC-A02-DELTA-UNEXPLAINED'],
      digest: 'stable',
    },
    run: () =>
      evaluateFrom({
        remotes: [remote({ transferredBalance: 1_077n, remoteTotalSupply: 1_000n })],
        escrowBalance: 10n ** 6n,
      }),
  },
  {
    id: 'accounting/escrow-shortfall-is-warn-not-critical',
    title: 'A coverage shortfall is a second witness disagreeing, not a proven breach',
    corpus: 'operational',
    // Gate B compares an escrow balance against a conservatively rounded
    // liability. A wrong token address, an unread proxy or a stale read produce
    // the same shape, so only Gate A raises CRITICAL. Asserted here so the
    // boundary is a checked property rather than a comment in one file.
    provenance: 'packages/invariant-core/src/gate-b.ts; gates.test.ts "not a proven economic breach"',
    pinned: { liabilityHomeUnits: '5', escrow: '1' },
    expect: {
      protocolStatus: 'WARN',
      exitCode: 4,
      reasonCodes: ['ACC-B01-COVERAGE-SHORTFALL'],
      digest: 'stable',
    },
    run: () =>
      evaluateFrom({
        remotes: [
          remote({
            transferredBalance: 5n * 10n ** 12n,
            remoteTotalSupply: 5n * 10n ** 12n,
          }),
        ],
        escrowBalance: 1n,
      }),
  },
  {
    id: 'accounting/duplicate-economic-effect',
    title: 'One message credited twice is a double count, not a retry',
    corpus: 'deterministic-breach',
    provenance: 'docs/INVARIANTS.md; docs/DATA_MODEL.md (one economic effect per route)',
    pinned: { messageKey: 'msg-effect-1', credits: '2' },
    expect: { protocolStatus: 'CRITICAL', exitCode: 2 },
    run: () =>
      evaluateFrom({
        effects: [creditedEffect(), creditedEffect({ duplicateEffect: true })],
        escrowBalance: 10n ** 6n,
      }),
  },
  {
    id: 'accounting/unauthorised-mint',
    title: 'A credit with no unique authorised source is not accounted',
    corpus: 'deterministic-breach',
    provenance: 'docs/INVARIANTS.md; unmatched mint',
    pinned: { hasUniqueAuthorisedSource: 'false', amount: '1000' },
    expect: { protocolStatus: 'CRITICAL', exitCode: 2 },
    run: () =>
      evaluateFrom({
        effects: [creditedEffect({ hasUniqueAuthorisedSource: false })],
        escrowBalance: 10n ** 6n,
      }),
  },
  {
    id: 'accounting/route-mismatch',
    title: 'A credit whose route does not match its source is refused',
    corpus: 'deterministic-breach',
    provenance: 'docs/INVARIANTS.md; route binding',
    pinned: { routeMatchesSource: 'false' },
    expect: { protocolStatus: 'CRITICAL', exitCode: 2 },
    run: () =>
      evaluateFrom({
        effects: [creditedEffect({ routeMatchesSource: false })],
        escrowBalance: 10n ** 6n,
      }),
  },
  {
    id: 'accounting/pending-explains-delta',
    title: 'An in-flight envelope explains the delta and is not a breach',
    corpus: 'operational',
    provenance: 'docs/PROTOCOL_SOURCE_LOCK.md 9.2',
    pinned: { transferredBalance: '1500', remoteSupply: '1000', pendingH2R: '500' },
    // The counterpart to the breach cases: a product that called this CRITICAL
    // would be unusable, and a corpus without it would not notice.
    expect: { protocolStatus: 'OK', exitCode: 0, digest: 'stable' },
    run: () =>
      evaluateFrom({
        remotes: [remote({ transferredBalance: 1_500n, remoteTotalSupply: 1_000n })],
        pending: [pendingEnvelope('home-to-remote', 500n)],
        escrowBalance: 10n ** 6n,
      }),
  },
  {
    id: 'accounting/stranded-pending-envelope',
    title: 'A stranded envelope raises liveness without colouring the coverage answer',
    corpus: 'operational',
    // CLAUDE.md 9: a liveness or rate signal is never shown under a collateral
    // headline. The envelope still explains the delta arithmetically, so the
    // coverage verdict is unchanged and the age is reported separately.
    provenance: 'CLAUDE.md 9; gate-a.ts ACC-L01',
    pinned: { pendingAgeSeconds: '86400', limitSeconds: '900' },
    expect: { reasonCodes: ['ACC-L01-PENDING-AGE-EXCEEDED'] },
    run: () =>
      evaluateFrom({
        remotes: [remote({ transferredBalance: 1_500n, remoteTotalSupply: 1_000n })],
        pending: [pendingEnvelope('home-to-remote', 500n, { ageSeconds: 86_400 })],
        escrowBalance: 10n ** 6n,
        pendingAgeLimitSeconds: 900,
      }),
  },
  {
    id: 'accounting/open-cut',
    title: 'An open cut cannot support an exact reconciliation',
    corpus: 'gap',
    provenance: 'docs/DATA_MODEL.md; watermark/cut',
    pinned: { cut: 'open' },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3 },
    run: () => evaluateFrom({ cut: 'open' }),
  },
  {
    id: 'accounting/incomplete-remote-census',
    title: 'A census that cannot see every remote is not netted to zero',
    corpus: 'gap',
    provenance: 'docs/INVARIANTS.md; census completeness',
    pinned: { census: 'incomplete', untrackedRemotes: '1' },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3 },
    run: () =>
      evaluateFrom({
        census: 'incomplete',
        untrackedRemotes: [`0x${'ee'.repeat(20)}`],
      }),
  },
  {
    id: 'accounting/unapproved-permissionless-remote',
    title: 'A remote nobody approved is candidate drift, not liability zero',
    corpus: 'fingerprint',
    provenance: 'CLAUDE.md 5; docs/INVARIANTS.md',
    pinned: { untrackedRemotes: '1', approved: 'false' },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3 },
    run: () => evaluateFrom({ untrackedRemotes: [`0x${'99'.repeat(20)}`] }),
  },
  {
    id: 'accounting/unrecognised-fingerprint',
    title: 'Code that does not match an approved fingerprint yields UNKNOWN',
    corpus: 'fingerprint',
    provenance: 'CLAUDE.md 4; docs/SUPPORT_MATRIX.md',
    pinned: { fingerprintRecognised: 'false' },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3 },
    run: () => evaluateFrom({ remotes: [remote({ fingerprintRecognised: false })] }),
  },
  {
    id: 'accounting/non-canonical-token-behaviour',
    title: 'A rebase or fee-on-transfer token is not reconciled by this rule',
    corpus: 'unsupported',
    provenance: 'docs/SUPPORT_MATRIX.md; invariant-core header',
    pinned: { tokenBehaviourCanonical: 'false' },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3 },
    run: () => evaluateFrom({ remotes: [remote({ tokenBehaviourCanonical: false })] }),
  },
  {
    id: 'accounting/multi-hop-unsupported',
    title: 'A multi-hop route is not claimed by the single-hop rule',
    corpus: 'unsupported',
    provenance: 'M09 OPEN_RISKS R3; docs/SUPPORT_MATRIX.md',
    pinned: { routeSingleHop: 'false' },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3 },
    run: () => evaluateFrom({ remotes: [remote({ routeSingleHop: false })] }),
  },
  {
    id: 'accounting/unknown-family',
    title: 'A family this build does not interpret is UNSUPPORTED, never a guess',
    corpus: 'unsupported',
    provenance: 'CLAUDE.md 5; docs/PROTOCOL_SOURCE_LOCK.md 4',
    pinned: { family: 'teleporterV2-experimental' },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3 },
    run: () => evaluateFrom({ family: 'teleporterV2-experimental' }),
  },
  {
    id: 'accounting/scale-not-established',
    title: 'An unestablished token scale blocks the comparison',
    corpus: 'gap',
    provenance: 'docs/INVARIANTS.md; token scaling',
    pinned: { established: 'false', tokenMultiplier: '1e12' },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3 },
    run: () => evaluateFrom({ remotes: [remote({ established: false })] }),
  },
  {
    id: 'accounting/decimals-rounding-boundary',
    title: 'Scaling down truncates, and the liability is rounded up not down',
    corpus: 'operational',
    provenance: 'docs/PROTOCOL_SOURCE_LOCK.md; scaling',
    pinned: { remoteUnits: '1999999999999', multiplier: '1e12', direction: 'remote-to-home' },
    expect: {
      // One remote unit short of two home units must still require two, or the
      // shortfall hides in the rounding.
      holds: ['collateral-rounds-up', 'scale-truncates'],
    },
    run: () => {
      // One remote unit short of two home units. Collateral must round UP or the
      // shortfall hides in the rounding; a transfer must round DOWN or the
      // product would mint value that was never escrowed.
      const needed = deriveCollateralNeeded(10n ** 12n, true, 1_999_999_999_999n);
      const scaled = applyTokenScale(10n ** 12n, false, 1_999_999_999_999n);
      return {
        holds: [
          ...(needed.ok && needed.value === 2n ? ['collateral-rounds-up'] : []),
          ...(scaled.ok && scaled.value === 1n ? ['scale-truncates'] : []),
          `needed=${needed.ok ? needed.value.toString(10) : 'failed'}`,
          `scaled=${scaled.ok ? scaled.value.toString(10) : 'failed'}`,
        ],
      };
    },
  },
  {
    id: 'accounting/initial-collateral-not-double-counted',
    title: 'Accepted initial collateral is credited once, not twice',
    corpus: 'operational',
    provenance: 'docs/PROTOCOL_SOURCE_LOCK.md; collateralNeeded',
    pinned: { acceptedCollateralHomeUnits: '1', escrow: '1' },
    expect: { protocolStatus: 'OK', exitCode: 0, digest: 'stable' },
    run: () => evaluateFrom({ acceptedCollateralHomeUnits: 1n, escrowBalance: 1n }),
  },
  {
    id: 'accounting/stale-evidence-degrades',
    title: 'A previously reconciled result does not stay green once stale',
    corpus: 'gap',
    provenance: 'docs/adr/0003-fail-closed-verdicts.md; AGG-M02',
    pinned: { fresh: 'false' },
    expect: { protocolStatus: 'UNKNOWN', dataStatus: 'STALE', exitCode: 3 },
    run: () => evaluateFrom({ fresh: false }),
  },
  {
    id: 'accounting/required-evidence-removed',
    title: 'Deleting a required evaluation does not improve the verdict',
    corpus: 'gap',
    provenance: 'docs/adr/0003-fail-closed-verdicts.md; AGG-M01',
    pinned: { missingRequiredEvaluations: 'ACC-ERC20-CANONICAL' },
    expect: { protocolStatus: 'UNKNOWN', exitCode: 3 },
    run: () => {
      // The breach is removed from the contributions, exactly as an attacker
      // deleting evidence would leave things. The answer must get worse, not
      // better: an absent required rule is a blind spot.
      const verdict = aggregate({
        contributions: [],
        dataStatus: 'COMPLETE',
        coverage: 'COMPLETE',
        missingRequiredEvaluations: ['ACC-ERC20-CANONICAL'],
        previousOkExpired: false,
        evaluationFaults: [],
      });
      return {
        protocolStatus: verdict.protocolStatus,
        dataStatus: verdict.dataStatus,
        reasonCodes: [...verdict.reasonCodes],
        exitCode: exitCodeFor(verdict),
      };
    },
  },
  {
    id: 'accounting/critical-survives-alongside-unknown',
    title: 'A proven breach is not softened by a simultaneous blind spot',
    corpus: 'deterministic-breach',
    provenance: 'docs/RUNBOOK.md 11 (verdict-triage); lattice',
    pinned: { critical: '1', unknownRequired: '1' },
    expect: { protocolStatus: 'CRITICAL', exitCode: 2 },
    run: () => {
      const verdict = aggregate({
        contributions: [
          {
            ruleId: 'ACC-ERC20-CANONICAL',
            result: 'FAIL',
            critical: true,
            required: true,
            claimMode: 'CAUSAL_EXACT',
            reasons: [],
          },
          {
            ruleId: 'CFG-DRIFT',
            result: 'UNKNOWN',
            critical: false,
            required: true,
            claimMode: 'INDETERMINATE',
            reasons: [],
          },
        ],
        dataStatus: 'PARTIAL',
        coverage: 'PARTIAL',
        missingRequiredEvaluations: [],
        previousOkExpired: false,
        evaluationFaults: [],
      });
      return {
        protocolStatus: verdict.protocolStatus,
        exitCode: exitCodeFor(verdict),
        // Both are reported: an operator handling an incident needs to know the
        // other checks were blind too.
        holds: [
          ...(verdict.criticalRuleIds.length === 1 ? ['critical-kept'] : []),
          ...(verdict.unknownRuleIds.length === 1 ? ['unknown-kept'] : []),
        ],
      };
    },
  },
  {
    id: 'accounting/rate-anomaly-is-not-a-breach',
    title: 'A liveness or rate anomaly is WARN, never an economic CRITICAL',
    corpus: 'operational',
    provenance: 'CLAUDE.md 9; docs/RUNBOOK.md 11 (RSK-H01)',
    pinned: { ruleId: 'RSK-H01-RATE-ANOMALY', result: 'WARN' },
    expect: { protocolStatus: 'WARN', exitCode: 4, holds: ['no-critical-rule'] },
    run: () => {
      const verdict = aggregate({
        contributions: [
          {
            ruleId: 'ACC-ERC20-CANONICAL',
            result: 'PASS',
            critical: false,
            required: true,
            claimMode: 'CAUSAL_EXACT',
            reasons: [],
          },
          {
            ruleId: 'RSK-H01-RATE-ANOMALY',
            // A failing heuristic rule that is not critical: WARN by
            // construction, and it can never borrow the collateral headline.
            result: 'FAIL',
            critical: false,
            required: false,
            claimMode: 'CAUSAL_EXACT',
            reasons: [],
          },
        ],
        dataStatus: 'COMPLETE',
        coverage: 'COMPLETE',
        missingRequiredEvaluations: [],
        previousOkExpired: false,
        evaluationFaults: [],
      });
      return {
        protocolStatus: verdict.protocolStatus,
        exitCode: exitCodeFor(verdict),
        holds: verdict.criticalRuleIds.length === 0 ? ['no-critical-rule'] : [],
      };
    },
  },
];
