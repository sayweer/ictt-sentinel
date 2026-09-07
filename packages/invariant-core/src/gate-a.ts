import { MAX_UINT256 } from '@ictt-sentinel/domain';
import type { ProofInput, RemoteObservation } from './inputs.js';
import { SUPPORTED_FAMILY } from './inputs.js';
import type { ReasonCode } from './reasons.js';

/**
 * Gate A - exact causal reconciliation for the canonical ERC20 single-hop route.
 *
 * The equation, and every sign in it, is taken from the pinned source rather
 * than assumed (icm-services @ 8fef6ef73767f4497a72d8348a0774a262e0c535):
 *
 *   Home -> Remote send        `_prepareSend`:            D += scaledAmount
 *   Remote execution success   `_withdraw` -> `_mint`:    S += amount
 *   Remote -> Home burn/send   `_burn`:                   S -= amount
 *   Home execution success     `_deductSenderBalance`:    D -= amount
 *
 *   =>  D_r - S_r = P_h2r + P_r2h
 *
 * BOTH sides are in REMOTE denomination, which is why nothing is re-scaled
 * before the subtraction:
 *
 *   - `_transferredBalances += scaledAmount` where
 *     `scaledAmount = TokenScalingUtils.applyTokenScale(...)` (home -> remote);
 *   - `_deductSenderBalance(..., amount)` is called with the amount whose NatSpec
 *     reads "denominated by the remote's token scale amount", under the comment
 *     "Deduct the balance transferred ... prior to scaling the amount";
 *   - the canonical ERC20 remote mints and burns that same remote-denominated
 *     amount, so `totalSupply` moves in step.
 *
 * `C_r` is structurally zero on this route - `__ERC20TokenRemote_init` calls
 * `__TokenRemote_init(settings, 0, tokenDecimals)` - so no initial-collateral
 * term is added here. Adding one would double count, because `_addCollateral`
 * never touches `_transferredBalances`.
 *
 * Both pendings push D ABOVE S, so `D - S` is non-negative on a healthy route.
 * `D < S` therefore cannot be explained by anything in flight.
 */

export interface RemoteReconciliation {
  readonly remoteBlockchainId: string;
  readonly remoteAddress: string;
  readonly transferredBalance: bigint;
  readonly remoteTotalSupply: bigint;
  /** `D - S`, in remote base units. Signed. */
  readonly delta: bigint;
  readonly pendingHomeToRemote: bigint;
  readonly pendingRemoteToHome: bigint;
  readonly pendingTotal: bigint;
  readonly reconciled: boolean;
}

export interface GateAResult {
  readonly outcome: 'pass' | 'fail' | 'unknown' | 'unsupported';
  readonly reasons: readonly ReasonCode[];
  /** True only for a proven economic breach, never for a coverage gap. */
  readonly critical: boolean;
  readonly perRemote: readonly RemoteReconciliation[];
  readonly totalDelta: bigint;
  readonly totalPending: bigint;
}

/** Input-contract failures. Every one of them is UNKNOWN, never an exception. */
const missingInputReasons = (input: ProofInput): readonly ReasonCode[] => {
  const out: ReasonCode[] = [];
  const p = input.provenance;

  if (p.manifestHash === null || p.policyHash === null) out.push('ACC-I01-NO-APPROVED-BASELINE');
  if (p.sourceLockCommitSha === null || p.adapterId === null || p.adapterVersion === null) {
    out.push('ACC-I02-NO-SOURCE-LOCK-VERSION');
  }
  // An unobserved remote is never zero liability, so a partial census cannot
  // support an aggregate claim.
  if (input.census !== 'complete-from-deployment-block') out.push('ACC-I03-CENSUS-INCOMPLETE');
  if (input.untrackedRemotes.length > 0) out.push('ACC-B02-UNTRACKED-REMOTE-LIABILITY');
  if (input.cut !== 'closed') out.push('ACC-I05-CAUSAL-CUT-OPEN');
  if (!input.freshness.fresh) out.push('ACC-I06-STALE-OBSERVATION');
  if (input.freshness.independentWitnessGroups < input.freshness.requiredWitnessGroups) {
    out.push('ACC-I04-NO-PINNED-BLOCK');
  }
  if (input.remotes.length === 0) out.push('ACC-I07-MISSING-OBSERVATION');

  for (const r of input.remotes) {
    if (r.transferredBalance === null || r.remoteTotalSupply === null) {
      out.push('ACC-I07-MISSING-OBSERVATION');
    }
    if (r.homePin === null || r.remotePin === null) out.push('ACC-I04-NO-PINNED-BLOCK');
    if (!r.scale.established) out.push('ACC-I08-UNKNOWN-TOKEN-SCALE');
  }
  return [...new Set(out)];
};

/** Shapes this engine refuses to interpret. All UNKNOWN, never a silent pass. */
const unsupportedReasons = (input: ProofInput): readonly ReasonCode[] => {
  const out: ReasonCode[] = [];
  if (input.family !== SUPPORTED_FAMILY) out.push('ACC-U01-UNSUPPORTED-FAMILY');
  for (const r of input.remotes) {
    if (!r.fingerprintRecognised) out.push('ACC-U02-UNKNOWN-FINGERPRINT');
    if (!r.tokenBehaviourCanonical) out.push('ACC-U03-UNSUPPORTED-TOKEN-BEHAVIOUR');
    if (!r.routeSingleHop) out.push('ACC-U04-UNSUPPORTED-ROUTE');
    // Canonical ERC20 is initialised with a zero reserve imbalance. A non-zero
    // value means this is not the family the equation was verified for.
    if (r.initialReserveImbalance !== 0n) out.push('ACC-U01-UNSUPPORTED-FAMILY');
  }
  return [...new Set(out)];
};

const inRange = (v: bigint): boolean => v >= 0n && v <= MAX_UINT256;

const reconcileRemote = (
  remote: RemoteObservation,
  input: ProofInput,
): RemoteReconciliation | null => {
  const d = remote.transferredBalance;
  const s = remote.remoteTotalSupply;
  if (d === null || s === null) return null;

  const mine = input.pending.filter(
    (p) =>
      p.remoteBlockchainId === remote.remoteBlockchainId &&
      p.remoteAddress === remote.remoteAddress,
  );
  const h2r = mine
    .filter((p) => p.direction === 'home-to-remote')
    .reduce((acc, p) => acc + p.amount, 0n);
  const r2h = mine
    .filter((p) => p.direction === 'remote-to-home')
    .reduce((acc, p) => acc + p.amount, 0n);

  const delta = d - s;
  const pendingTotal = h2r + r2h;
  return {
    remoteBlockchainId: remote.remoteBlockchainId,
    remoteAddress: remote.remoteAddress,
    transferredBalance: d,
    remoteTotalSupply: s,
    delta,
    pendingHomeToRemote: h2r,
    pendingRemoteToHome: r2h,
    pendingTotal,
    // Exact. No tolerance: a tolerance here would hide precisely the mismatch
    // this rule exists to find.
    reconciled: delta === pendingTotal,
  };
};

/**
 * Run Gate A.
 *
 * Precedence is fail-closed. Input gaps and unsupported shapes are answered
 * before any arithmetic, because a number computed from incomplete evidence
 * looks exactly like a number computed from complete evidence.
 */
export const evaluateGateA = (input: ProofInput): GateAResult => {
  const unsupported = unsupportedReasons(input);
  if (unsupported.length > 0) {
    return {
      outcome: 'unsupported',
      reasons: unsupported,
      critical: false,
      perRemote: [],
      totalDelta: 0n,
      totalPending: 0n,
    };
  }

  const missing = missingInputReasons(input);
  if (missing.length > 0) {
    return {
      outcome: 'unknown',
      reasons: missing,
      critical: false,
      perRemote: [],
      totalDelta: 0n,
      totalPending: 0n,
    };
  }

  for (const r of input.remotes) {
    if (
      !inRange(r.transferredBalance ?? 0n) ||
      !inRange(r.remoteTotalSupply ?? 0n) ||
      !inRange(r.scale.tokenMultiplier)
    ) {
      return {
        outcome: 'unknown',
        reasons: ['ACC-A06-ARITHMETIC-OUT-OF-RANGE'],
        critical: false,
        perRemote: [],
        totalDelta: 0n,
        totalPending: 0n,
      };
    }
  }

  const perRemote = input.remotes
    .map((r) => reconcileRemote(r, input))
    .filter((r): r is RemoteReconciliation => r !== null);

  // Per-effect correctness. Each of these is a proven breach on its own, so they
  // are collected before the aggregate arithmetic is even consulted.
  const effectReasons: ReasonCode[] = [];
  for (const e of input.effects) {
    if (e.duplicateEffect) effectReasons.push('ACC-A03-DUPLICATE-ECONOMIC-EFFECT');
    if (!e.hasUniqueAuthorisedSource || e.causalSourceFact === null) {
      effectReasons.push('ACC-A04-UNAUTHORISED-MINT');
    }
    if (!e.routeMatchesSource) effectReasons.push('ACC-A05-ROUTE-MISMATCH');
  }

  const totalDelta = perRemote.reduce((acc, r) => acc + r.delta, 0n);
  const totalPending = perRemote.reduce((acc, r) => acc + r.pendingTotal, 0n);

  // Liveness, tracked separately so it can never colour the coverage answer.
  const overAge = input.pending.filter((p) => p.ageSeconds > input.pendingAgeLimitSeconds);
  const livenessReasons: ReasonCode[] = overAge.length > 0 ? ['ACC-L01-PENDING-AGE-EXCEEDED'] : [];

  if (effectReasons.length > 0) {
    return {
      outcome: 'fail',
      reasons: [...new Set([...effectReasons, ...livenessReasons])],
      critical: true,
      perRemote,
      totalDelta,
      totalPending,
    };
  }

  const excess = perRemote.filter((r) => r.delta < 0n);
  if (excess.length > 0) {
    // Both pendings raise D above S, so a negative delta cannot be anything in
    // flight. With the input contract satisfied above, this is evidence.
    return {
      outcome: 'fail',
      reasons: [...new Set(['ACC-A01-EXCESS-REMOTE-REPRESENTATION' as const, ...livenessReasons])],
      critical: true,
      perRemote,
      totalDelta,
      totalPending,
    };
  }

  const mismatched = perRemote.filter((r) => !r.reconciled);
  if (mismatched.length > 0) {
    // D > S but not by the pending total. Missing history, a decoder fault and a
    // stale read all produce this shape, so it is UNKNOWN, not an economic
    // finding. Calling it a shortfall here would be the false positive that
    // destroys the product's only real asset.
    return {
      outcome: 'unknown',
      reasons: [...new Set(['ACC-A02-DELTA-UNEXPLAINED' as const, ...livenessReasons])],
      critical: false,
      perRemote,
      totalDelta,
      totalPending,
    };
  }

  return {
    outcome: 'pass',
    reasons: [...new Set(['ACC-A00-RECONCILED' as const, ...livenessReasons])],
    critical: false,
    perRemote,
    totalDelta,
    totalPending,
  };
};
