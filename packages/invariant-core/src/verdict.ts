import type { ReasonCode } from './reasons.js';

/**
 * Global verdict aggregation.
 *
 * Four INDEPENDENT fields, never collapsed into one before the caller sees them.
 * A single colour throws away the difference between "we proved a breach" and
 * "we could not read the chain", and those need opposite responses.
 *
 * Aggregation is fail-closed at every branch, and a proven CRITICAL is never
 * hidden by a simultaneous UNKNOWN: both are reported.
 */

export const PROTOCOL_STATUSES = ['OK', 'WARN', 'CRITICAL', 'UNKNOWN'] as const;
export type ProtocolStatus = (typeof PROTOCOL_STATUSES)[number];

export const DATA_STATUSES = ['COMPLETE', 'STALE', 'PARTIAL', 'DIVERGENT', 'UNKNOWN'] as const;
export type DataStatus = (typeof DATA_STATUSES)[number];

/** What kind of claim the evidence actually supports. */
export const CLAIM_MODES = [
  /** Exact equality, established. */
  'EXACT',
  /** Exact once causally settled envelopes are accounted for. */
  'CAUSAL_EXACT',
  /** A reported upper bound is covered. Never an exact supply claim. */
  'SUFFICIENT_UPPER_BOUND',
  /** The evidence does not decide it either way. */
  'INDETERMINATE',
  'UNSUPPORTED',
] as const;
export type ClaimMode = (typeof CLAIM_MODES)[number];

export const COVERAGE_STATES = ['COMPLETE', 'PARTIAL', 'UNVERIFIED'] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

/** One rule's typed contribution to the aggregate. */
export interface RuleContribution {
  readonly ruleId: string;
  readonly result: 'PASS' | 'FAIL' | 'UNKNOWN' | 'UNSUPPORTED';
  /** True only for a proven deterministic breach with sufficient evidence. */
  readonly critical: boolean;
  /** False for optional checks, whose UNKNOWN does not block. */
  readonly required: boolean;
  readonly claimMode: ClaimMode;
  readonly reasons: readonly ReasonCode[];
  /** Policy or liveness deviation. Never an economic finding on its own. */
  readonly livenessOnly?: boolean;
}

export interface AggregationInput {
  readonly contributions: readonly RuleContribution[];
  readonly dataStatus: DataStatus;
  readonly coverage: CoverageState;
  /** Evaluations the policy required but that never ran. */
  readonly missingRequiredEvaluations: readonly string[];
  /** A previously OK evaluation whose freshness TTL has expired. */
  readonly previousOkExpired: boolean;
  /** An exception, timeout, parse error or null input on the evaluation path. */
  readonly evaluationFaults: readonly string[];
}

export interface GlobalVerdict {
  readonly protocolStatus: ProtocolStatus;
  readonly dataStatus: DataStatus;
  readonly claimMode: ClaimMode;
  readonly coverage: CoverageState;
  readonly reasonCodes: readonly ReasonCode[];
  /** Rules that proved a breach. Kept even when other fields are UNKNOWN. */
  readonly criticalRuleIds: readonly string[];
  /** Required rules that could not be established. Kept alongside a CRITICAL. */
  readonly unknownRuleIds: readonly string[];
  readonly assumptions: readonly string[];
  readonly exclusions: readonly string[];
  readonly runbook: string;
}

/** Weakest claim wins; an aggregate is only as strong as its softest member. */
const CLAIM_RANK: Readonly<Record<ClaimMode, number>> = {
  EXACT: 0,
  CAUSAL_EXACT: 1,
  SUFFICIENT_UPPER_BOUND: 2,
  INDETERMINATE: 3,
  UNSUPPORTED: 4,
};

const weakestClaim = (modes: readonly ClaimMode[]): ClaimMode =>
  modes.length === 0
    ? 'UNSUPPORTED'
    : modes.reduce(
        (worst, m) => (CLAIM_RANK[m] > CLAIM_RANK[worst] ? m : worst),
        modes[0] ?? 'UNSUPPORTED',
      );

/**
 * Aggregate into a global verdict.
 *
 * Precedence, in order, and each step is a refusal to be optimistic:
 *
 *   1. A proven breach is CRITICAL. Nothing downgrades it.
 *   2. Otherwise a required UNKNOWN - including a missing evaluation, an
 *      expired OK, or an evaluation fault - is UNKNOWN. A missing evaluation
 *      defaulting to OK is the failure this ordering exists to prevent.
 *   3. Otherwise a policy or liveness deviation is WARN.
 *   4. Only when every required control is complete, fresh and passing: OK.
 */
export const aggregate = (input: AggregationInput): GlobalVerdict => {
  const reasons = new Set<ReasonCode>();
  for (const c of input.contributions) for (const r of c.reasons) reasons.add(r);

  const criticalRuleIds = input.contributions.filter((c) => c.critical).map((c) => c.ruleId);

  // Required rules that could not be established, plus every other way an
  // answer can be absent.
  const unknownRuleIds = input.contributions
    .filter((c) => c.required && (c.result === 'UNKNOWN' || c.result === 'UNSUPPORTED'))
    .map((c) => c.ruleId);

  const missing = input.missingRequiredEvaluations;
  if (missing.length > 0) reasons.add('AGG-M01-REQUIRED-EVALUATION-MISSING');
  if (input.previousOkExpired) reasons.add('AGG-M02-PREVIOUS-OK-EXPIRED');
  if (input.evaluationFaults.length > 0) reasons.add('AGG-M03-EVALUATION-FAULT');

  const dataDegraded = input.dataStatus !== 'COMPLETE';
  if (input.dataStatus === 'STALE') reasons.add('ACC-I06-STALE-OBSERVATION');
  if (input.dataStatus === 'DIVERGENT') reasons.add('AGG-M04-WITNESS-DIVERGENCE');

  const claimMode = weakestClaim(input.contributions.map((c) => c.claimMode));

  const hasBlockingUnknown =
    unknownRuleIds.length > 0 ||
    missing.length > 0 ||
    input.previousOkExpired ||
    input.evaluationFaults.length > 0 ||
    dataDegraded ||
    input.coverage !== 'COMPLETE';

  // A liveness or policy deviation, and nothing stronger behind it.
  const hasWarn = input.contributions.some((c) => c.result === 'FAIL' && !c.critical);

  const protocolStatus: ProtocolStatus =
    criticalRuleIds.length > 0
      ? 'CRITICAL'
      : hasBlockingUnknown
        ? 'UNKNOWN'
        : hasWarn
          ? 'WARN'
          : 'OK';

  return {
    protocolStatus,
    dataStatus: input.dataStatus,
    claimMode,
    coverage: input.coverage,
    reasonCodes: [...reasons].sort(),
    criticalRuleIds: [...criticalRuleIds].sort(),
    // Reported even when the overall status is CRITICAL: an operator needs to
    // know that other required checks are ALSO unestablished.
    unknownRuleIds: [...unknownRuleIds].sort(),
    assumptions: [
      'Quorum is counted over independent provider groups; it is not a cryptographic or Byzantine guarantee.',
      'Native claims are reported upper bounds, never exact circulating supply.',
      'Observed on-chain state is coverage at a pinned block, not legal recoverability.',
    ],
    exclusions: [
      'Rate and volume anomalies are heuristic signals and never appear under a collateral headline.',
      'Unsupported families, routes and token behaviours resolve to UNKNOWN rather than being interpreted.',
    ],
    runbook: 'docs/RUNBOOK.md#verdict-triage',
  };
};

/**
 * Exit codes for CLI and CI.
 *
 * Only an overall OK is zero. A proven breach and an unestablished required
 * control get DIFFERENT non-zero codes, because they need different responses:
 * one is an incident, the other is a blind spot.
 */
export const EXIT_CODES = {
  ok: 0,
  critical: 2,
  requiredUnknown: 3,
  warn: 4,
} as const;

export const exitCodeFor = (v: GlobalVerdict): number => {
  switch (v.protocolStatus) {
    case 'OK':
      return EXIT_CODES.ok;
    case 'CRITICAL':
      return EXIT_CODES.critical;
    case 'UNKNOWN':
      return EXIT_CODES.requiredUnknown;
    case 'WARN':
      return EXIT_CODES.warn;
  }
};

/** Only a full OK is ever green. Nothing else, in any combination. */
export const isOverallGreen = (v: GlobalVerdict): boolean =>
  v.protocolStatus === 'OK' &&
  v.dataStatus === 'COMPLETE' &&
  v.coverage === 'COMPLETE' &&
  v.claimMode !== 'UNSUPPORTED' &&
  v.claimMode !== 'INDETERMINATE';
