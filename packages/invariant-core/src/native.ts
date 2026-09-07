import { MAX_UINT256 } from '@ictt-sentinel/domain';
import type { ReasonCode } from './reasons.js';

/**
 * Native remote - a bounded claim, and only a bounded claim.
 *
 * The contract's own getter, verified from the pinned source
 * (`NativeTokenRemoteUpgradeable.totalNativeAssetSupply()`,
 * docs/PROTOCOL_SOURCE_LOCK.md 5.1):
 *
 *   burned  = BURNED_TX_FEES_ADDRESS.balance + BURNED_FOR_TRANSFER_ADDRESS.balance
 *   created = _totalMinted + getInitialReserveImbalance()
 *   U       = created - burned
 *
 * The NatSpec says this must not be confused with `IERC20.totalSupply`, and that
 * `initialReserveBalance` is in circulation before it is collateralised at home.
 *
 * So `U` is an ACCOUNTING RECONSTRUCTION, not a measurement. It bounds real
 * circulating supply from above only while this contract is the sole minter and
 * only while every path that reduces supply lands on those two burn addresses -
 * and that second assumption is NOT verified (RESEARCH_SYNTHESIS A03). Nothing
 * in this file calls `U` an exact supply, and no wrapper ERC20 `totalSupply()`
 * is ever read as native-chain supply.
 */

export interface NativeSupplyComponents {
  /** `_totalMinted`, including coins re-minted as burned-fee rewards. */
  readonly totalMinted: bigint | null;
  /** `getInitialReserveImbalance()`. In circulation before it is collateralised. */
  readonly initialReserveImbalance: bigint | null;
  readonly burnedTxFeesAddressBalance: bigint | null;
  readonly burnedForTransferAddressBalance: bigint | null;
  /** False when any component was read outside its freshness window. */
  readonly componentsFresh: boolean;
  /** False when the deployed fingerprint is not a recognised native remote. */
  readonly fingerprintRecognised: boolean;
}

/**
 * Native Minter allow-list census.
 *
 * `readAllowList(address)` is a POINT QUERY. The precompile exposes no
 * enumeration, so reading it for the remote's own address proves that address
 * holds a role - it proves nothing about whether anyone ELSE does. Exclusivity
 * therefore needs all five parts below, and without them the answer is UNKNOWN
 * rather than an optimistic yes.
 */
export interface MinterCensus {
  /** Operator's expected-role roster from the approved manifest. */
  readonly manifestRosterProvided: boolean;
  /** Genesis / upgrade chain config that seeds the allow list. */
  readonly genesisChainConfigRead: boolean;
  /** When the precompile activated, and any disable/re-enable upgrades. */
  readonly activationRulesKnown: boolean;
  /** Complete RoleSet / NativeCoinMinted history from activation, per epoch. */
  readonly roleHistoryCompleteFromActivation: boolean;
  /** Pinned role reads for EVERY candidate Admin/Manager/Enabled address. */
  readonly allCandidateRolesRead: boolean;
  /** Addresses holding a minting role beyond the expected roster. */
  readonly unexpectedRoleHolders: readonly string[];
  /** A mint with no authorised role behind it at that epoch. */
  readonly unauthorisedMintObserved: boolean;
  /**
   * Role history split by activation epoch. A disable/re-enable upgrade makes
   * one continuous history meaningless, so epochs are counted rather than merged.
   */
  readonly epochsCovered: number;
  readonly epochsExpected: number;
}

export interface BurnedFeeReporting {
  /**
   * `reportBurnedTxFees` is a SEPARATE channel: a delta is taken, the reward is
   * RE-MINTED (so `_totalMinted` rises) and the remainder is reported home
   * (docs/PROTOCOL_SOURCE_LOCK.md T04). The re-mint is already inside
   * `totalMinted`, so it is never added again here.
   */
  readonly reportedRewardAlreadyInTotalMinted: boolean;
  /** A repeated report for the same delta. */
  readonly duplicateReportObserved: boolean;
  /** Reports whose home-side execution has not closed: pending causal envelopes. */
  readonly openReportEnvelopes: number;
}

export interface NativeInput {
  readonly components: NativeSupplyComponents;
  readonly census: MinterCensus;
  readonly feeReporting: BurnedFeeReporting;
  /** Eligible home coverage `A`, in the same denomination as `U`. */
  readonly eligibleHomeCoverage: bigint | null;
  /**
   * A supply LOWER bound, when one can be established independently. Only this
   * can turn `U > A` into a red economic verdict; the upper bound alone cannot.
   */
  readonly trustworthySupplyLowerBound: bigint | null;
  readonly collateralNeeded: bigint | null;
  readonly acceptedCollateral: bigint | null;
}

/** The only claims this engine will make about a native remote. */
export const NATIVE_ASSESSMENTS = ['sufficient', 'indeterminate', 'unknown'] as const;
export type NativeAssessment = (typeof NATIVE_ASSESSMENTS)[number];

export interface NativeResult {
  readonly assessment: NativeAssessment;
  /** Reported upper bound. Never described as exact supply. */
  readonly reportedUpperBound: bigint | null;
  readonly eligibleCoverage: bigint | null;
  /** `A - U`. Positive means the reported bound is covered. */
  readonly headroom: bigint | null;
  /** True only for a proven breach, which needs a LOWER bound above coverage. */
  readonly critical: boolean;
  readonly minterExclusivityEstablished: boolean;
  readonly reasons: readonly ReasonCode[];
  /** Intermediate values, so the bound can be audited rather than trusted. */
  readonly intermediates: {
    readonly created: bigint | null;
    readonly burned: bigint | null;
  };
}

const allPresent = (c: NativeSupplyComponents): boolean =>
  c.totalMinted !== null &&
  c.initialReserveImbalance !== null &&
  c.burnedTxFeesAddressBalance !== null &&
  c.burnedForTransferAddressBalance !== null;

/**
 * Minter exclusivity, or an explicit refusal to claim it.
 *
 * Every one of the five components is required. This is the check that stops
 * `readAllowList(remote)` from being mistaken for proof that nobody else can mint.
 */
export const assessMinterCensus = (
  census: MinterCensus,
): { established: boolean; critical: boolean; reasons: readonly ReasonCode[] } => {
  const reasons: ReasonCode[] = [];

  // A proven extra minter or an unauthorised mint is a configuration breach,
  // and it is provable even when the census is otherwise incomplete.
  const critical = census.unexpectedRoleHolders.length > 0 || census.unauthorisedMintObserved;
  if (census.unexpectedRoleHolders.length > 0) reasons.push('CFG-N01-UNEXPECTED-MINTER-ROLE');
  if (census.unauthorisedMintObserved) reasons.push('CFG-N02-UNAUTHORISED-NATIVE-MINT');

  const complete =
    census.manifestRosterProvided &&
    census.genesisChainConfigRead &&
    census.activationRulesKnown &&
    census.roleHistoryCompleteFromActivation &&
    census.allCandidateRolesRead &&
    census.epochsCovered >= census.epochsExpected;

  if (!complete) reasons.push('CFG-N03-NATIVE-MINTER-CENSUS-INCOMPLETE');

  return { established: complete && !critical, critical, reasons };
};

/**
 * Compute the reported upper bound and decide what may be claimed.
 *
 * The three outcomes are deliberately narrow. There is no branch that returns
 * "exact", none that returns a supply figure, and none that reaches a red
 * verdict from the upper bound alone.
 */
export const assessNative = (input: NativeInput): NativeResult => {
  const { components: c, census } = input;
  const minter = assessMinterCensus(census);
  const reasons: ReasonCode[] = [...minter.reasons];

  const empty = {
    reportedUpperBound: null,
    eligibleCoverage: input.eligibleHomeCoverage,
    headroom: null,
    minterExclusivityEstablished: minter.established,
    intermediates: { created: null, burned: null },
  };

  if (!c.fingerprintRecognised) {
    return {
      assessment: 'unknown',
      critical: minter.critical,
      reasons: [...reasons, 'ACC-U02-UNKNOWN-FINGERPRINT'],
      ...empty,
    };
  }
  if (!allPresent(c)) {
    return {
      assessment: 'unknown',
      critical: minter.critical,
      reasons: [...reasons, 'ACC-I07-MISSING-OBSERVATION'],
      ...empty,
    };
  }
  if (!c.componentsFresh) {
    return {
      assessment: 'unknown',
      critical: minter.critical,
      reasons: [...reasons, 'ACC-I06-STALE-OBSERVATION'],
      ...empty,
    };
  }
  if (input.feeReporting.duplicateReportObserved) {
    // The same burned-fee delta reported twice would inflate the bound; refuse
    // rather than net it out.
    reasons.push('CFG-N04-DUPLICATE-FEE-REPORT');
  }
  if (!input.feeReporting.reportedRewardAlreadyInTotalMinted) {
    // If the re-minted reward is NOT already inside totalMinted then the pinned
    // semantics this bound was derived from do not hold here.
    return {
      assessment: 'unknown',
      critical: minter.critical,
      reasons: [...reasons, 'CFG-N05-FEE-REMINT-SEMANTICS-UNVERIFIED'],
      ...empty,
    };
  }

  const created = (c.totalMinted ?? 0n) + (c.initialReserveImbalance ?? 0n);
  const burned = (c.burnedTxFeesAddressBalance ?? 0n) + (c.burnedForTransferAddressBalance ?? 0n);
  if (created > MAX_UINT256) {
    return {
      assessment: 'unknown',
      critical: minter.critical,
      reasons: [...reasons, 'ACC-A06-ARITHMETIC-OUT-OF-RANGE'],
      ...empty,
    };
  }
  const upperBound = created - burned;
  const intermediates = { created, burned };

  const coverage = input.eligibleHomeCoverage;
  if (coverage === null) {
    return {
      assessment: 'unknown',
      critical: minter.critical,
      reasons: [...reasons, 'ACC-I07-MISSING-OBSERVATION'],
      ...empty,
      reportedUpperBound: upperBound,
      intermediates,
    };
  }

  const headroom = coverage - upperBound;

  // Exclusivity gates the positive claim, not the arithmetic. Without it the
  // bound is not established as a bound at all.
  if (!minter.established) {
    return {
      assessment: minter.critical ? 'indeterminate' : 'unknown',
      critical: minter.critical,
      reasons,
      reportedUpperBound: upperBound,
      eligibleCoverage: coverage,
      headroom,
      minterExclusivityEstablished: false,
      intermediates,
    };
  }

  if (upperBound <= coverage) {
    return {
      assessment: 'sufficient',
      critical: false,
      reasons: [...reasons, 'ACC-N00-REPORTED-UPPER-BOUND-COVERED'],
      reportedUpperBound: upperBound,
      eligibleCoverage: coverage,
      headroom,
      minterExclusivityEstablished: true,
      intermediates,
    };
  }

  // U > A. On its own this is NOT evidence of a shortfall: an unknown fee burn
  // may already have reduced real supply below the reported bound. Only an
  // independently established LOWER bound above coverage makes it red.
  const lower = input.trustworthySupplyLowerBound;
  if (lower !== null && lower > coverage) {
    return {
      assessment: 'indeterminate',
      critical: true,
      reasons: [...reasons, 'ACC-N02-SUPPLY-LOWER-BOUND-EXCEEDS-COVERAGE'],
      reportedUpperBound: upperBound,
      eligibleCoverage: coverage,
      headroom,
      minterExclusivityEstablished: true,
      intermediates,
    };
  }

  return {
    assessment: 'indeterminate',
    critical: false,
    reasons: [...reasons, 'ACC-N01-UPPER-BOUND-ABOVE-COVERAGE-INDETERMINATE'],
    reportedUpperBound: upperBound,
    eligibleCoverage: coverage,
    headroom,
    minterExclusivityEstablished: true,
    intermediates,
  };
};
