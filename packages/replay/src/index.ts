// @ictt-sentinel/replay
//
// Accepted-block replay: from a manifest's trustworthy start block to an agreed
// accepted head, completely, resumably and deterministically.
//
// Three boundaries this package does not cross:
//   * It plans and orchestrates; it never opens a socket or writes SQL itself.
//   * It advances a checkpoint only behind independent-witness agreement.
//   * A webhook hint can reorder work and nothing else - it cannot create a
//     fact, a verdict, or a reason to consider a range covered.

export const PACKAGE_NAME = '@ictt-sentinel/replay' as const;

export { planRanges, splitRange, nextStep, spanOf } from './plan.js';
export type { BlockRange, PlanInput, AttemptState, NextStep } from './plan.js';

export { REPLAY_REASONS, REASON_METADATA, isRetryable } from './reasons.js';
export type { ReplayReason, ReasonMetadata } from './reasons.js';

export { rangeDigest, canonicalBlockDigest, classifyObservation, findRangeGaps } from './range.js';
export type { RangeObservation, RangeOutcome, RangeResult } from './range.js';

export { agree, provenanceOf } from './agreement.js';
export type { Agreement, AgreementPolicy, WitnessProvenance } from './agreement.js';

export { REPLAY_STATUSES, assessCompleteness, isGapClosed } from './completeness.js';
export type { ReplayStatus, CompletenessInput, CompletenessResult } from './completeness.js';

export { HINT_SOURCES, admitHint, hintId, prioritise } from './hints.js';
export type { PriorityHint, HintSource, HintQueuePolicy, HintAdmission } from './hints.js';

export { buildCensus, globalCoverageKnown } from './census.js';
export type {
  ApprovedRemote,
  CensusInput,
  CensusResult,
  CrossCheckTask,
  RegisteredRemoteEvent,
  RemoteCandidate,
} from './census.js';

export type { FetchOutcome, LogSourcePort } from './ports.js';

export { runReplay, persistRemoteCandidates } from './engine.js';
export type { ReplayConfig, ReplayReport, RangeReport } from './engine.js';
