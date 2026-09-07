// @ictt-sentinel/invariant-core
//
// Exact causal reconciliation and physical coverage for the source-locked
// canonical ERC20 single-hop route, and for nothing else.
//
// Two gates in a fixed order. Gate A reconciles home accounting against remote
// supply exactly, with no tolerance. Gate B is a SECOND witness: it checks that
// the escrowed token balance covers the conservative liability, as a lower
// bound rather than an equality. Gate B never runs before Gate A passes, and
// neither gate can produce OK from incomplete evidence.
//
// Native, custom, rebase, fee-on-transfer and multi-hop deployments do not use
// this formula. They resolve to UNKNOWN.

export const PACKAGE_NAME = '@ictt-sentinel/invariant-core' as const;

export { REASON_CODES, REASON_META, FORBIDDEN_CLAIM_WORDS } from './reasons.js';
export type { ReasonCode, ReasonMeta } from './reasons.js';

export { CENSUS_STATES, CUT_STATES, SUPPORTED_FAMILY } from './inputs.js';
export type {
  CensusState,
  CreditedEffect,
  CutState,
  FreshnessInput,
  HomeEscrowInput,
  PendingEnvelope,
  PinnedBlock,
  ProofInput,
  ProvenanceInput,
  RemoteObservation,
  TokenScaleInput,
} from './inputs.js';

export { PROOF_RESULTS, isGreen, verdictFor } from './outcome.js';
export type {
  EvidenceRefs,
  Measurement,
  PendingBreakdown,
  ProofResult,
  RuleOutput,
} from './outcome.js';

export { evaluateGateA } from './gate-a.js';
export type { GateAResult, RemoteReconciliation } from './gate-a.js';

export { evaluateGateB, toHomeUnits } from './gate-b.js';
export type { GateBResult, RemoteLiability, ScaleOutcome } from './gate-b.js';

export { RULE_ID, evaluateCanonicalErc20, canonicalInputString } from './engine.js';
export type { CanonicalErc20Evaluation, Hasher } from './engine.js';

export { NATIVE_ASSESSMENTS, assessNative, assessMinterCensus } from './native.js';
export type {
  BurnedFeeReporting,
  MinterCensus,
  NativeAssessment,
  NativeInput,
  NativeResult,
  NativeSupplyComponents,
} from './native.js';

export { DRIFT_CONTROLS, DRIFT_STATUSES, assessDrift, classifyDiscoveredRemote } from './drift.js';
export type { DriftControl, DriftObservation, DriftResult, DriftStatus } from './drift.js';

export {
  CLAIM_MODES,
  COVERAGE_STATES,
  DATA_STATUSES,
  EXIT_CODES,
  PROTOCOL_STATUSES,
  aggregate,
  exitCodeFor,
  isOverallGreen,
} from './verdict.js';
export type {
  AggregationInput,
  ClaimMode,
  CoverageState,
  DataStatus,
  GlobalVerdict,
  ProtocolStatus,
  RuleContribution,
} from './verdict.js';
