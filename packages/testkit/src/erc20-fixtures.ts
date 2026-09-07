import type {
  CreditedEffect,
  PendingEnvelope,
  ProofInput,
  RemoteObservation,
} from '@ictt-sentinel/invariant-core';

/**
 * Canonical ERC20 single-hop fixtures.
 *
 * Built around the equation verified from the pinned source
 * (icm-services @ 8fef6ef73767f4497a72d8348a0774a262e0c535):
 *
 *   D_r - S_r = P_h2r + P_r2h        (all terms in REMOTE base units)
 *
 * Every scenario below is constructed so that equation holds, or so that it
 * fails in one specific, named way.
 */

export const ERC20_HOME_CHAIN = `0x${'aa'.repeat(32)}`;
export const ERC20_REMOTE_CHAIN = `0x${'bb'.repeat(32)}`;
export const ERC20_REMOTE_ADDRESS = `0x${'cc'.repeat(20)}`;
export const HOME_TOKEN = `0x${'dd'.repeat(20)}`;
export const SOURCE_LOCK_SHA = '8fef6ef73767f4497a72d8348a0774a262e0c535';

/** 6-decimal home token, 18-decimal remote: multiplier 1e12, multiplyOnRemote. */
export const SCALE_6_TO_18 = { tokenMultiplier: 10n ** 12n, multiplyOnRemote: true };
/** 18-decimal home, 6-decimal remote: the same multiplier the other way round. */
export const SCALE_18_TO_6 = { tokenMultiplier: 10n ** 12n, multiplyOnRemote: false };

const pin = (blockchainId: string, n: number) => ({
  blockchainId,
  blockNumber: BigInt(n),
  blockHash: `0x${n.toString(16).padStart(64, '0')}`,
});

export interface RemoteOptions {
  readonly transferredBalance?: bigint | null;
  readonly remoteTotalSupply?: bigint | null;
  readonly tokenMultiplier?: bigint;
  readonly multiplyOnRemote?: boolean;
  readonly homeDecimals?: number;
  readonly remoteDecimals?: number;
  readonly established?: boolean;
  readonly homePin?: boolean;
  readonly remotePin?: boolean;
  readonly fingerprintRecognised?: boolean;
  readonly tokenBehaviourCanonical?: boolean;
  readonly routeSingleHop?: boolean;
  readonly initialReserveImbalance?: bigint;
  readonly remoteAddress?: string;
}

export const remote = (o: RemoteOptions = {}): RemoteObservation => ({
  remoteBlockchainId: ERC20_REMOTE_CHAIN,
  remoteAddress: o.remoteAddress ?? ERC20_REMOTE_ADDRESS,
  transferredBalance: o.transferredBalance === undefined ? 1_000n : o.transferredBalance,
  remoteTotalSupply: o.remoteTotalSupply === undefined ? 1_000n : o.remoteTotalSupply,
  scale: {
    tokenMultiplier: o.tokenMultiplier ?? SCALE_6_TO_18.tokenMultiplier,
    multiplyOnRemote: o.multiplyOnRemote ?? SCALE_6_TO_18.multiplyOnRemote,
    homeDecimals: o.homeDecimals ?? 6,
    remoteDecimals: o.remoteDecimals ?? 18,
    established: o.established ?? true,
  },
  homePin: (o.homePin ?? true) ? pin(ERC20_HOME_CHAIN, 100) : null,
  remotePin: (o.remotePin ?? true) ? pin(ERC20_REMOTE_CHAIN, 200) : null,
  fingerprintRecognised: o.fingerprintRecognised ?? true,
  tokenBehaviourCanonical: o.tokenBehaviourCanonical ?? true,
  routeSingleHop: o.routeSingleHop ?? true,
  // Structurally zero for canonical ERC20; anything else is a different family.
  initialReserveImbalance: o.initialReserveImbalance ?? 0n,
});

export const pendingEnvelope = (
  direction: PendingEnvelope['direction'],
  amount: bigint,
  o: { messageKey?: string; ageSeconds?: number; remoteAddress?: string } = {},
): PendingEnvelope => ({
  messageKey: o.messageKey ?? `msg-${direction}-${amount.toString(10)}`,
  direction,
  amount,
  ageSeconds: o.ageSeconds ?? 30,
  remoteBlockchainId: ERC20_REMOTE_CHAIN,
  remoteAddress: o.remoteAddress ?? ERC20_REMOTE_ADDRESS,
});

export const creditedEffect = (o: Partial<CreditedEffect> = {}): CreditedEffect => ({
  messageKey: 'msg-effect-1',
  remoteBlockchainId: ERC20_REMOTE_CHAIN,
  remoteAddress: ERC20_REMOTE_ADDRESS,
  amount: 1_000n,
  hasUniqueAuthorisedSource: true,
  routeMatchesSource: true,
  duplicateEffect: false,
  causalSourceFact: 'home-accounted@100',
  ...o,
});

export interface ProofOptions {
  readonly remotes?: readonly RemoteObservation[];
  readonly pending?: readonly PendingEnvelope[];
  readonly effects?: readonly CreditedEffect[];
  readonly census?: ProofInput['census'];
  readonly cut?: ProofInput['cut'];
  readonly untrackedRemotes?: readonly string[];
  readonly fresh?: boolean;
  readonly witnessGroups?: number;
  readonly requiredWitnessGroups?: number;
  readonly escrowBalance?: bigint | null;
  readonly homeEscrowPin?: boolean;
  readonly acceptedCollateralHomeUnits?: bigint;
  readonly family?: string;
  readonly manifestHash?: string | null;
  readonly policyHash?: string | null;
  readonly sourceLockCommitSha?: string | null;
  readonly pendingAgeLimitSeconds?: number;
}

/**
 * A fully supported, fully evidenced proof input.
 *
 * Defaults reconcile exactly: D = S = 1000, no pending, so `D - S = 0 = pending`.
 * Escrow defaults to 1 home unit, which covers `ceil(1000 / 1e12) = 1`.
 */
export const proofInput = (o: ProofOptions = {}): ProofInput => ({
  deploymentId: 'acme-usdc',
  family: o.family ?? 'canonical-erc20-single-hop',
  provenance: {
    manifestHash: o.manifestHash === undefined ? 'ab'.repeat(32) : o.manifestHash,
    policyHash: o.policyHash === undefined ? 'cd'.repeat(32) : o.policyHash,
    sourceLockCommitSha:
      o.sourceLockCommitSha === undefined ? SOURCE_LOCK_SHA : o.sourceLockCommitSha,
    adapterId: 'ictt.token-home.erc20',
    adapterVersion: 1,
    ruleVersion: 'acc-erc20-canonical@1',
  },
  census: o.census ?? 'complete-from-deployment-block',
  untrackedRemotes: o.untrackedRemotes ?? [],
  cut: o.cut ?? 'closed',
  freshness: {
    fresh: o.fresh ?? true,
    independentWitnessGroups: o.witnessGroups ?? 2,
    requiredWitnessGroups: o.requiredWitnessGroups ?? 2,
  },
  remotes: o.remotes ?? [remote()],
  pending: o.pending ?? [],
  effects: o.effects ?? [],
  homeEscrow: {
    escrowBalance: o.escrowBalance === undefined ? 1n : o.escrowBalance,
    homePin: (o.homeEscrowPin ?? true) ? pin(ERC20_HOME_CHAIN, 100) : null,
    acceptedCollateralHomeUnits: o.acceptedCollateralHomeUnits ?? 0n,
  },
  pendingAgeLimitSeconds: o.pendingAgeLimitSeconds ?? 900,
});

// ------------------------------------------------------------------ scenarios

/** Home -> Remote in flight: D rose, S has not yet. */
export const homeToRemotePending = (amount = 500n): ProofInput =>
  proofInput({
    remotes: [remote({ transferredBalance: 1_000n + amount, remoteTotalSupply: 1_000n })],
    pending: [pendingEnvelope('home-to-remote', amount)],
    escrowBalance: 10n ** 6n,
  });

/** Remote -> Home in flight: S fell, D has not yet. */
export const remoteToHomePending = (amount = 250n): ProofInput =>
  proofInput({
    remotes: [remote({ transferredBalance: 1_000n, remoteTotalSupply: 1_000n - amount })],
    pending: [pendingEnvelope('remote-to-home', amount)],
    escrowBalance: 10n ** 6n,
  });

/** Both directions in flight at once. Both raise D above S. */
export const bothDirectionsPending = (h2r = 500n, r2h = 250n): ProofInput =>
  proofInput({
    remotes: [remote({ transferredBalance: 1_000n + h2r, remoteTotalSupply: 1_000n - r2h })],
    pending: [pendingEnvelope('home-to-remote', h2r), pendingEnvelope('remote-to-home', r2h)],
    escrowBalance: 10n ** 6n,
  });

/** Remote supply exceeds home accounting: unbacked representation. */
export const excessRemoteSupply = (excess = 100n): ProofInput =>
  proofInput({
    remotes: [remote({ transferredBalance: 1_000n, remoteTotalSupply: 1_000n + excess })],
    escrowBalance: 10n ** 6n,
  });

/** D above S by an amount nothing in flight explains. */
export const unexplainedDelta = (extra = 77n): ProofInput =>
  proofInput({
    remotes: [remote({ transferredBalance: 1_000n + extra, remoteTotalSupply: 1_000n })],
    escrowBalance: 10n ** 6n,
  });

/** Escrow below the conservative liability. */
export const coverageShortfall = (): ProofInput =>
  proofInput({
    remotes: [remote({ transferredBalance: 5n * 10n ** 12n, remoteTotalSupply: 5n * 10n ** 12n })],
    escrowBalance: 4n,
  });

/** Donation raises the balance above the liability. Still healthy. */
export const escrowSurplus = (): ProofInput =>
  proofInput({
    remotes: [remote({ transferredBalance: 5n * 10n ** 12n, remoteTotalSupply: 5n * 10n ** 12n })],
    escrowBalance: 9_999n,
  });
