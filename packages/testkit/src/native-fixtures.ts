import type {
  AggregationInput,
  BurnedFeeReporting,
  DriftControl,
  DriftObservation,
  MinterCensus,
  NativeInput,
  NativeSupplyComponents,
  RuleContribution,
} from '@ictt-sentinel/invariant-core';

/**
 * Native, drift and verdict fixtures.
 *
 * The native numbers are built around the getter verified from the pinned
 * source: `U = _totalMinted + initialReserveImbalance - burnedTxFees -
 * burnedForTransfer` (docs/PROTOCOL_SOURCE_LOCK.md 5.1). `U` is a reported upper
 * bound and the fixtures never treat it as an exact supply.
 */

export const components = (o: Partial<NativeSupplyComponents> = {}): NativeSupplyComponents => ({
  totalMinted: 1_000n,
  initialReserveImbalance: 200n,
  burnedTxFeesAddressBalance: 50n,
  burnedForTransferAddressBalance: 150n,
  componentsFresh: true,
  fingerprintRecognised: true,
  ...o,
});

/** A census where every one of the five required parts is present. */
export const completeCensus = (o: Partial<MinterCensus> = {}): MinterCensus => ({
  manifestRosterProvided: true,
  genesisChainConfigRead: true,
  activationRulesKnown: true,
  roleHistoryCompleteFromActivation: true,
  allCandidateRolesRead: true,
  unexpectedRoleHolders: [],
  unauthorisedMintObserved: false,
  epochsCovered: 1,
  epochsExpected: 1,
  ...o,
});

export const feeReporting = (o: Partial<BurnedFeeReporting> = {}): BurnedFeeReporting => ({
  // The reward is re-minted, so it is already inside totalMinted and must not be
  // added a second time (docs/PROTOCOL_SOURCE_LOCK.md T04).
  reportedRewardAlreadyInTotalMinted: true,
  duplicateReportObserved: false,
  openReportEnvelopes: 0,
  ...o,
});

export interface NativeOptions {
  readonly components?: Partial<NativeSupplyComponents>;
  readonly census?: Partial<MinterCensus>;
  readonly feeReporting?: Partial<BurnedFeeReporting>;
  readonly eligibleHomeCoverage?: bigint | null;
  readonly trustworthySupplyLowerBound?: bigint | null;
}

/** Defaults: `U = 1000 + 200 - 50 - 150 = 1000`, coverage 1200, so `U < A`. */
export const nativeInput = (o: NativeOptions = {}): NativeInput => ({
  components: components(o.components),
  census: completeCensus(o.census),
  feeReporting: feeReporting(o.feeReporting),
  eligibleHomeCoverage: o.eligibleHomeCoverage === undefined ? 1_200n : o.eligibleHomeCoverage,
  trustworthySupplyLowerBound:
    o.trustworthySupplyLowerBound === undefined ? null : o.trustworthySupplyLowerBound,
  collateralNeeded: 0n,
  acceptedCollateral: 0n,
});

// ---------------------------------------------------------------------- drift

export const driftObservation = (
  control: DriftControl,
  o: Partial<DriftObservation> = {},
): DriftObservation => ({
  control,
  status: 'match',
  expected: 'expected-value',
  observed: 'expected-value',
  required: true,
  ...o,
});

/** Every required control matching. */
export const cleanBaseline = (): readonly DriftObservation[] => [
  driftObservation('implementation-code-hash'),
  driftObservation('proxy-implementation-slot'),
  driftObservation('contract-address'),
  driftObservation('chain-identity'),
  driftObservation('token-decimals'),
  driftObservation('minter-allowlist'),
  driftObservation('registered-remote-census'),
  driftObservation('admin-upgrade-authority'),
];

// -------------------------------------------------------------------- verdict

export const contribution = (o: Partial<RuleContribution> = {}): RuleContribution => ({
  ruleId: 'ACC-ERC20-CANONICAL',
  result: 'PASS',
  critical: false,
  required: true,
  claimMode: 'CAUSAL_EXACT',
  reasons: [],
  ...o,
});

export interface AggregationOptions {
  readonly contributions?: readonly RuleContribution[];
  readonly dataStatus?: AggregationInput['dataStatus'];
  readonly coverage?: AggregationInput['coverage'];
  readonly missingRequiredEvaluations?: readonly string[];
  readonly previousOkExpired?: boolean;
  readonly evaluationFaults?: readonly string[];
}

/** A fully healthy aggregation: the only shape that may be green. */
export const aggregationInput = (o: AggregationOptions = {}): AggregationInput => ({
  contributions: o.contributions ?? [contribution()],
  dataStatus: o.dataStatus ?? 'COMPLETE',
  coverage: o.coverage ?? 'COMPLETE',
  missingRequiredEvaluations: o.missingRequiredEvaluations ?? [],
  previousOkExpired: o.previousOkExpired ?? false,
  evaluationFaults: o.evaluationFaults ?? [],
});
