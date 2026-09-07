/**
 * The proof input contract.
 *
 * Everything an evaluation rests on is named here, so that a missing piece is a
 * typed UNKNOWN rather than an exception or - far worse - a default that reads
 * as evidence. There is no optional-with-a-fallback field in this file: absence
 * is always modelled explicitly.
 */

/** A pinned chain position. Number AND hash; a height alone is not a pin. */
export interface PinnedBlock {
  readonly blockchainId: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

/** How the census of registered remotes was established. */
export const CENSUS_STATES = ['complete-from-deployment-block', 'partial', 'unknown'] as const;
export type CensusState = (typeof CENSUS_STATES)[number];

/** What the causal watermark concluded for this evaluation. */
export const CUT_STATES = ['closed', 'open', 'gap'] as const;
export type CutState = (typeof CUT_STATES)[number];

/** Contract family this engine is allowed to interpret. */
export const SUPPORTED_FAMILY = 'canonical-erc20-single-hop' as const;

export interface ProvenanceInput {
  /** Approved manifest hash. Absent means there is no baseline to judge against. */
  readonly manifestHash: string | null;
  readonly policyHash: string | null;
  /** Immutable upstream commit the contract semantics are bound to. */
  readonly sourceLockCommitSha: string | null;
  readonly adapterId: string | null;
  readonly adapterVersion: number | null;
  readonly ruleVersion: string;
}

export interface TokenScaleInput {
  /** From `RemoteTokenTransferrerSettings`, read at a pinned block. */
  readonly tokenMultiplier: bigint;
  readonly multiplyOnRemote: boolean;
  readonly homeDecimals: number;
  readonly remoteDecimals: number;
  /** False when the pair's scaling could not be established on both sides. */
  readonly established: boolean;
}

/**
 * One registered remote, as observed at a pinned block.
 *
 * `transferredBalance` and `remoteTotalSupply` are BOTH in remote denomination.
 * Verified from the pinned source: `_transferredBalances` is incremented by
 * `applyTokenScale(...)` output and decremented by the pre-scaling remote amount
 * (`TokenHome.sol` @ 8fef6ef, `_prepareSend` / `_processReceivedTransfer`).
 * They are therefore subtracted directly, with NO further scaling.
 */
export interface RemoteObservation {
  readonly remoteBlockchainId: string;
  readonly remoteAddress: string;
  /** `TokenHome.getTransferredBalance(...)`. Remote denomination. */
  readonly transferredBalance: bigint | null;
  /** Canonical ERC20 remote `totalSupply()`. Remote denomination. */
  readonly remoteTotalSupply: bigint | null;
  readonly scale: TokenScaleInput;
  readonly homePin: PinnedBlock | null;
  readonly remotePin: PinnedBlock | null;
  /** Recognised source-locked fingerprint on both sides. */
  readonly fingerprintRecognised: boolean;
  /** Token behaviour the canonical rule assumes: no rebase, fee or blacklist. */
  readonly tokenBehaviourCanonical: boolean;
  /** Single-hop route. Multi-hop is never flattened into this model. */
  readonly routeSingleHop: boolean;
  /**
   * Structurally zero for canonical ERC20 (`__TokenRemote_init(settings, 0, ...)`,
   * verified in Milestone 04). Present so a non-zero value is a loud UNSUPPORTED
   * rather than a silent extra term.
   */
  readonly initialReserveImbalance: bigint;
}

/** An envelope whose two sides have not both closed yet. */
export interface PendingEnvelope {
  readonly messageKey: string;
  readonly direction: 'home-to-remote' | 'remote-to-home';
  /** Remote denomination, matching D and S. */
  readonly amount: bigint;
  /** Ages are a liveness signal only, never an economic finding. */
  readonly ageSeconds: number;
  /** The message route this envelope belongs to. */
  readonly remoteBlockchainId: string;
  readonly remoteAddress: string;
}

/** A credited effect and the source message that authorises it. */
export interface CreditedEffect {
  readonly messageKey: string;
  readonly remoteBlockchainId: string;
  readonly remoteAddress: string;
  readonly amount: bigint;
  /** False when no unique authorised source message backs this effect. */
  readonly hasUniqueAuthorisedSource: boolean;
  /** False when route, origin or transferrer do not agree with the source. */
  readonly routeMatchesSource: boolean;
  /** More than one credited execution observed for this route. */
  readonly duplicateEffect: boolean;
  /** The source accounting fact this effect is causally linked to. */
  readonly causalSourceFact: string | null;
}

export interface FreshnessInput {
  /** All required observations are inside their freshness window. */
  readonly fresh: boolean;
  /** Independent provider groups behind the observations. */
  readonly independentWitnessGroups: number;
  readonly requiredWitnessGroups: number;
}

export interface HomeEscrowInput {
  /**
   * `getTokenAddress().balanceOf(homeContract)` at the pinned home block.
   * Never the native balance and never a wrapper's own supply.
   */
  readonly escrowBalance: bigint | null;
  readonly homePin: PinnedBlock | null;
  /** Collateral actually accepted, tracked in its own ledger (never in D). */
  readonly acceptedCollateralHomeUnits: bigint;
}

export interface ProofInput {
  readonly deploymentId: string;
  readonly family: string;
  readonly provenance: ProvenanceInput;
  readonly census: CensusState;
  /** Registered remotes the census knows about but could not observe. */
  readonly untrackedRemotes: readonly string[];
  readonly cut: CutState;
  readonly freshness: FreshnessInput;
  readonly remotes: readonly RemoteObservation[];
  readonly pending: readonly PendingEnvelope[];
  readonly effects: readonly CreditedEffect[];
  readonly homeEscrow: HomeEscrowInput;
  /** Maximum pending age policy allows before it becomes a liveness finding. */
  readonly pendingAgeLimitSeconds: number;
}
