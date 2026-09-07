import type { ProofInput } from './inputs.js';
import { evaluateGateA, type GateAResult } from './gate-a.js';
import { evaluateGateB, type GateBResult } from './gate-b.js';
import type { ReasonCode } from './reasons.js';
import {
  type Measurement,
  type PendingBreakdown,
  type ProofResult,
  type RuleOutput,
  verdictFor,
} from './outcome.js';

/**
 * The canonical ERC20 rule.
 *
 * Two gates, strictly ordered: physical coverage is only meaningful once the
 * accounting it is meant to corroborate has reconciled. Gate B can never rescue
 * a Gate A that did not pass, and an overall PASS requires both.
 */

export const RULE_ID = 'ACC-ERC20-CANONICAL' as const;

export interface CanonicalErc20Evaluation {
  readonly output: RuleOutput;
  readonly gateA: GateAResult;
  readonly gateB: GateBResult;
}

/**
 * Hash function, injected.
 *
 * This package is layer 0 and may not import `node:crypto`, so the engine
 * produces a canonical STRING and the caller supplies the digest function. The
 * determinism that matters lives in the serialisation below, and that is what
 * the tests pin.
 */
export type Hasher = (canonical: string) => string;

/**
 * Canonical serialisation of the proof input.
 *
 * Deterministic and total over the fields a verdict depends on: the same pinned
 * blocks and the same observations must serialise identically on any machine,
 * which is what makes an evidence bundle reproducible. bigints become decimal
 * strings because JSON numbers are doubles, and every list is sorted so provider
 * arrival order cannot change the result.
 */
export const canonicalInputString = (input: ProofInput): string => {
  const canonical = {
    deploymentId: input.deploymentId,
    family: input.family,
    provenance: input.provenance,
    census: input.census,
    untrackedRemotes: [...input.untrackedRemotes].sort(),
    cut: input.cut,
    freshness: input.freshness,
    remotes: [...input.remotes]
      .map((r) => ({
        remoteBlockchainId: r.remoteBlockchainId,
        remoteAddress: r.remoteAddress,
        transferredBalance: r.transferredBalance?.toString(10) ?? null,
        remoteTotalSupply: r.remoteTotalSupply?.toString(10) ?? null,
        tokenMultiplier: r.scale.tokenMultiplier.toString(10),
        multiplyOnRemote: r.scale.multiplyOnRemote,
        homeDecimals: r.scale.homeDecimals,
        remoteDecimals: r.scale.remoteDecimals,
        established: r.scale.established,
        homePin: r.homePin ? `${r.homePin.blockNumber.toString(10)}:${r.homePin.blockHash}` : null,
        remotePin: r.remotePin
          ? `${r.remotePin.blockNumber.toString(10)}:${r.remotePin.blockHash}`
          : null,
        fingerprintRecognised: r.fingerprintRecognised,
        tokenBehaviourCanonical: r.tokenBehaviourCanonical,
        routeSingleHop: r.routeSingleHop,
        initialReserveImbalance: r.initialReserveImbalance.toString(10),
      }))
      .sort((a, b) =>
        `${a.remoteBlockchainId}${a.remoteAddress}` < `${b.remoteBlockchainId}${b.remoteAddress}`
          ? -1
          : 1,
      ),
    // Sorted, so provider arrival order cannot change the digest.
    pending: [...input.pending]
      .map((p) => ({ ...p, amount: p.amount.toString(10) }))
      .sort((a, b) => (a.messageKey < b.messageKey ? -1 : a.messageKey > b.messageKey ? 1 : 0)),
    effects: [...input.effects]
      .map((e) => ({ ...e, amount: e.amount.toString(10) }))
      .sort((a, b) => (a.messageKey < b.messageKey ? -1 : a.messageKey > b.messageKey ? 1 : 0)),
    homeEscrow: {
      escrowBalance: input.homeEscrow.escrowBalance?.toString(10) ?? null,
      homePin: input.homeEscrow.homePin
        ? `${input.homeEscrow.homePin.blockNumber.toString(10)}:${input.homeEscrow.homePin.blockHash}`
        : null,
      acceptedCollateralHomeUnits: input.homeEscrow.acceptedCollateralHomeUnits.toString(10),
    },
    pendingAgeLimitSeconds: input.pendingAgeLimitSeconds,
  };
  return JSON.stringify(canonical);
};

const pinRefs = (input: ProofInput): readonly string[] =>
  [
    ...new Set(
      [...input.remotes.flatMap((r) => [r.homePin, r.remotePin]), input.homeEscrow.homePin]
        .filter((p): p is NonNullable<typeof p> => p !== null)
        .map((p) => `${p.blockchainId}@${p.blockNumber.toString(10)}:${p.blockHash}`),
    ),
  ].sort();

const pendingBreakdown = (input: ProofInput, gateA: GateAResult): PendingBreakdown => ({
  homeToRemote: gateA.perRemote.reduce((a, r) => a + r.pendingHomeToRemote, 0n),
  remoteToHome: gateA.perRemote.reduce((a, r) => a + r.pendingRemoteToHome, 0n),
  total: gateA.totalPending,
  count: input.pending.length,
  overAgeCount: input.pending.filter((p) => p.ageSeconds > input.pendingAgeLimitSeconds).length,
});

/**
 * Assumptions the coverage claim rests on.
 *
 * Written into every output, because a lower-bound statement is only as strong
 * as what it assumed, and a reader who cannot see the assumptions cannot judge
 * the claim.
 */
const ASSUMPTIONS: readonly string[] = [
  'Both getTransferredBalance and remote totalSupply are in remote base units, verified from the pinned source; no rescaling is applied before the subtraction.',
  'Canonical ERC20 remotes are initialised with a zero reserve imbalance, so no initial-collateral term participates.',
  'Provider quorum is counted over independent provider groups and is not a cryptographic or Byzantine guarantee.',
  'Observed escrow is on-chain coverage at a pinned block; it is not legal recoverability and not absolute solvency.',
];

const EXCLUSIONS: readonly string[] = [
  'Native token remotes, custom ERC20 remotes, rebase, fee-on-transfer and blacklist wrappers.',
  'Multi-hop and remote-to-remote routes; they are never flattened into a single hop.',
  'Any claim about independent ICM/BLS verification; the assurance mode here is accepted state.',
];

const combine = (a: GateAResult, b: GateBResult): ProofResult => {
  if (a.outcome === 'unsupported') return 'UNSUPPORTED';
  if (a.outcome === 'unknown') return 'UNKNOWN';
  if (a.outcome === 'fail') return 'FAIL';
  // Gate A passed; the overall answer is now Gate B's.
  if (b.outcome === 'fail') return 'FAIL';
  if (b.outcome === 'unknown') return 'UNKNOWN';
  return 'PASS';
};

/**
 * Evaluate the canonical ERC20 rule.
 *
 * Pure: no clock, no network, no environment, no imports outside the domain
 * package. The digest function is supplied by the caller.
 */
export const evaluateCanonicalErc20 = (
  input: ProofInput,
  hash: Hasher,
): CanonicalErc20Evaluation => {
  const gateA = evaluateGateA(input);
  const gateB = evaluateGateB(input, gateA.outcome === 'pass');
  const result = combine(gateA, gateB);

  const reasons: readonly ReasonCode[] = [
    ...new Set([...gateA.reasons, ...(gateA.outcome === 'pass' ? gateB.reasons : [])]),
  ];

  // A shortfall in physical coverage is a coverage finding, not a proven
  // economic breach, so only Gate A can raise CRITICAL.
  const critical = gateA.critical;

  const measurement: Measurement | null =
    gateA.outcome === 'pass' || gateA.outcome === 'fail' || gateA.outcome === 'unknown'
      ? gateA.perRemote.length > 0
        ? {
            expected: gateA.totalPending,
            observed: gateA.totalDelta,
            delta: gateA.totalDelta - gateA.totalPending,
            unit: 'remote-base-units',
          }
        : null
      : null;

  return {
    output: {
      ruleId: RULE_ID,
      ruleVersion: input.provenance.ruleVersion,
      result,
      verdictCandidate: verdictFor(result, critical),
      reasons,
      measurement,
      pending: gateA.perRemote.length > 0 ? pendingBreakdown(input, gateA) : null,
      evidence: {
        pinnedBlocks: pinRefs(input),
        witnessGroups: input.freshness.independentWitnessGroups,
        requiredWitnessGroups: input.freshness.requiredWitnessGroups,
        sourceLockCommitSha: input.provenance.sourceLockCommitSha,
        adapterId: input.provenance.adapterId,
        adapterVersion: input.provenance.adapterVersion,
      },
      assumptions: ASSUMPTIONS,
      exclusions: EXCLUSIONS,
      inputDigest: hash(canonicalInputString(input)),
    },
    gateA,
    gateB,
  };
};
