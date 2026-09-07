import { MAX_UINT256 } from '@ictt-sentinel/domain';
import type { ProofInput } from './inputs.js';
import type { ReasonCode } from './reasons.js';

/**
 * Gate B - physical Home escrow coverage. The SECOND witness, never a
 * replacement for the transferred-balance reconciliation in Gate A.
 *
 * Backing is measured with `getTokenAddress().balanceOf(homeContract)`: the
 * balance of the token the home contract actually escrows. Not the native
 * balance, and not some wrapper's own supply.
 *
 * Liabilities are converted from remote units into home units with the pinned
 * `TokenScalingUtils` semantics, in BOTH directions of rounding:
 *
 *   floor - what the protocol would really release. `removeTokenScale` divides
 *           with Solidity truncation when `multiplyOnRemote` is true.
 *   ceil  - the conservative economic liability, rounding the same division up.
 *   dust  - ceil - floor. Real, small, and modelled rather than tolerated.
 *
 * The safety test is `escrow >= ceil`, a LOWER-BOUND coverage check. Equality is
 * not required and not expected: donations and surplus raise the balance, and
 * truncation leaves dust behind. An `escrow == liability` rule would raise a
 * false alarm on a perfectly healthy deployment.
 *
 * What this is not: an on-chain balance is not legal recoverability and not
 * absolute solvency. It is observed coverage at a pinned block
 * (docs/INVARIANTS.md 6).
 *
 * NOTE ON DUPLICATION: `removeTokenScale` is also ported in
 * `@ictt-sentinel/ictt-adapters`, which this layer-0 package may not import. The
 * two are held together by a differential test over a wide input space rather
 * than by hope; if they ever disagree, that test fails.
 */

export interface RemoteLiability {
  readonly remoteBlockchainId: string;
  readonly remoteAddress: string;
  /** Obligation in remote base units, straight from `getTransferredBalance`. */
  readonly remoteUnits: bigint;
  /** Protocol-redeemable floor, in home base units. */
  readonly floorHomeUnits: bigint;
  /** Conservative economic ceiling, in home base units. */
  readonly ceilHomeUnits: bigint;
  /** `ceil - floor`. Zero whenever the conversion multiplies instead of divides. */
  readonly dust: bigint;
}

export interface GateBResult {
  readonly outcome: 'pass' | 'fail' | 'unknown';
  readonly reasons: readonly ReasonCode[];
  readonly escrowBalance: bigint;
  readonly floorLiability: bigint;
  readonly conservativeLiability: bigint;
  readonly totalDust: bigint;
  /** `escrow - conservativeLiability`. Positive is surplus, negative a shortfall. */
  readonly surplus: bigint;
  readonly perRemote: readonly RemoteLiability[];
}

export type ScaleOutcome =
  | { readonly ok: true; readonly floor: bigint; readonly ceil: bigint }
  | { readonly ok: false; readonly reason: 'overflow' | 'division-by-zero' | 'negative' };

/**
 * Remote units to home units, both roundings.
 *
 * Mirrors `TokenScalingUtils._scaleTokens` with `isSendToRemote = false`:
 *
 *   multiplyOnRemote == false -> amount * tokenMultiplier   (exact, no rounding)
 *   multiplyOnRemote == true  -> amount / tokenMultiplier   (truncating)
 *
 * Only the dividing branch can produce dust, so the other returns floor == ceil.
 */
export const toHomeUnits = (
  remoteAmount: bigint,
  tokenMultiplier: bigint,
  multiplyOnRemote: boolean,
): ScaleOutcome => {
  if (remoteAmount < 0n || tokenMultiplier < 0n) return { ok: false, reason: 'negative' };

  if (!multiplyOnRemote) {
    const product = remoteAmount * tokenMultiplier;
    // Solidity reverts here rather than wrapping; so do we.
    if (product > MAX_UINT256) return { ok: false, reason: 'overflow' };
    return { ok: true, floor: product, ceil: product };
  }

  if (tokenMultiplier === 0n) return { ok: false, reason: 'division-by-zero' };
  const floor = remoteAmount / tokenMultiplier;
  const ceil = remoteAmount % tokenMultiplier === 0n ? floor : floor + 1n;
  return { ok: true, floor, ceil };
};

/**
 * Run Gate B. Only ever called after Gate A passes; the caller enforces that and
 * this function states it in its reasons if asked to run regardless.
 */
export const evaluateGateB = (input: ProofInput, gateAPassed: boolean): GateBResult => {
  const empty = {
    escrowBalance: 0n,
    floorLiability: 0n,
    conservativeLiability: 0n,
    totalDust: 0n,
    surplus: 0n,
    perRemote: [] as readonly RemoteLiability[],
  };

  if (!gateAPassed) {
    return { outcome: 'unknown', reasons: ['ACC-B03-GATE-A-NOT-PASSED'], ...empty };
  }

  // An unobserved registered remote cannot be treated as zero liability, so no
  // aggregate coverage claim is possible while one exists.
  if (input.untrackedRemotes.length > 0) {
    return { outcome: 'unknown', reasons: ['ACC-B02-UNTRACKED-REMOTE-LIABILITY'], ...empty };
  }
  if (input.census !== 'complete-from-deployment-block') {
    return { outcome: 'unknown', reasons: ['ACC-I03-CENSUS-INCOMPLETE'], ...empty };
  }

  const escrow = input.homeEscrow.escrowBalance;
  if (escrow === null || input.homeEscrow.homePin === null) {
    return { outcome: 'unknown', reasons: ['ACC-I07-MISSING-OBSERVATION'], ...empty };
  }

  const perRemote: RemoteLiability[] = [];
  for (const r of input.remotes) {
    const remoteUnits = r.transferredBalance;
    if (remoteUnits === null) {
      return { outcome: 'unknown', reasons: ['ACC-I07-MISSING-OBSERVATION'], ...empty };
    }
    const scaled = toHomeUnits(remoteUnits, r.scale.tokenMultiplier, r.scale.multiplyOnRemote);
    if (!scaled.ok) {
      return { outcome: 'unknown', reasons: ['ACC-A06-ARITHMETIC-OUT-OF-RANGE'], ...empty };
    }
    perRemote.push({
      remoteBlockchainId: r.remoteBlockchainId,
      remoteAddress: r.remoteAddress,
      remoteUnits,
      floorHomeUnits: scaled.floor,
      ceilHomeUnits: scaled.ceil,
      dust: scaled.ceil - scaled.floor,
    });
  }

  const floorLiability = perRemote.reduce((a, r) => a + r.floorHomeUnits, 0n);
  const conservativeLiability = perRemote.reduce((a, r) => a + r.ceilHomeUnits, 0n);
  const totalDust = conservativeLiability - floorLiability;
  const surplus = escrow - conservativeLiability;

  const totals = {
    escrowBalance: escrow,
    floorLiability,
    conservativeLiability,
    totalDust,
    surplus,
    perRemote,
  };

  // Lower bound, not equality. Surplus is normal and must not raise an alarm.
  return surplus >= 0n
    ? { outcome: 'pass', reasons: ['ACC-B00-COVERAGE-SUFFICIENT'], ...totals }
    : { outcome: 'fail', reasons: ['ACC-B01-COVERAGE-SHORTFALL'], ...totals };
};
