import type { Verdict } from '@ictt-sentinel/domain';
import { type MessageAggregate, factsOfKind, has, supportingFacts } from './aggregate.js';
import { DESTINATION_EFFECT_KINDS, SOURCE_EFFECT_KINDS, type TransitionInput } from './inputs.js';
import { type RawFactRef, rawFactRefOf } from './keys.js';
import { type MessageState, isTerminal, stateVerdict } from './states.js';

/**
 * Deriving the semantic state from a set of facts.
 *
 * A pure fold over an unordered set, so the same accepted facts give the same
 * answer whatever order they were ingested in. Nothing in this file reads a
 * clock, opens a socket or touches `process.env`; the evaluation time is passed
 * in by the caller.
 */

export interface EvaluationContext {
  /** Injected, never `Date.now()`. Purity is what keeps replay reproducible. */
  readonly evaluatedAt: Date;
  /** How long an in-flight message may sit before it is reported as stale. */
  readonly staleAfterMs: number;
}

export interface EconomicEffect {
  /** At most one. This is the invariant the whole file is arranged around. */
  readonly count: 0 | 1;
  readonly sourceFact: RawFactRef | null;
  readonly destinationFact: RawFactRef | null;
}

export interface DerivedMessage {
  readonly state: MessageState;
  readonly verdict: Verdict;
  readonly effect: EconomicEffect;
  /**
   * Two or more DISTINCT destination effects for one message key. Surfaced, not
   * deduplicated: silently collapsing them would hide a double credit.
   */
  readonly duplicateEffectFacts: readonly RawFactRef[];
  /** Send attempts for one intent. More than one is normal after a send retry. */
  readonly sendAttempts: number;
  /** Execution attempts, including failures. */
  readonly executionAttempts: number;
  /** Distinct ICM envelopes. More than one means the message was re-signed. */
  readonly envelopeIds: readonly string[];
  /** Liveness only. Never promoted into the lifecycle position. */
  readonly receiptObserved: boolean;
  readonly unsupportedReasons: readonly string[];
  /** Raw facts this conclusion rests on, for the evidence bundle. */
  readonly supportingFacts: readonly RawFactRef[];
}

const carriesEffect = (f: TransitionInput): boolean => f.carriesEconomicEffect !== false;

const latestObservedAt = (aggregate: MessageAggregate): Date | null => {
  let latest: Date | null = null;
  for (const f of aggregate.facts.values()) {
    if (f.observedAt && (latest === null || f.observedAt > latest)) latest = f.observedAt;
  }
  return latest;
};

/**
 * Lifecycle position, before any staleness overlay.
 *
 * The order of these checks is the fail-closed precedence. Anything that means
 * "we do not understand this" outranks everything that means "here is what
 * happened", so an unsupported family can never be reported as a healthy send.
 */
const lifecycleState = (aggregate: MessageAggregate): MessageState => {
  if (aggregate.facts.size === 0) return 'UNCLASSIFIABLE';

  // 1. We do not know what we are looking at.
  if (has(aggregate, 'unsupported')) return 'UNCLASSIFIABLE';
  // 2. The facts left the canonical chain.
  if (has(aggregate, 'orphaned')) return 'ORPHANED';
  // 3. Version policy blocks it before any lifecycle reasoning applies.
  if (has(aggregate, 'paused-version')) return 'PAUSED_VERSION';
  if (has(aggregate, 'unreceivable-by-version-policy')) return 'UNRECEIVABLE_BY_VERSION_POLICY';

  // 4. Success. A retry that succeeded is reported as such rather than being
  //    flattened into a plain success: the operator needs to know it took two.
  if (has(aggregate, 'execution-retried')) return 'RETRIED_SUCCESS';
  if (has(aggregate, 'execution-succeeded')) return 'EXECUTED_SUCCESS';

  // 5. Failure. Never a healthy close, and distinguished by whether another
  //    attempt is already in flight.
  if (has(aggregate, 'execution-failed')) {
    return has(aggregate, 'send-retry') || has(aggregate, 'envelope-resigned')
      ? 'RETRY_PENDING'
      : 'EXECUTED_FAILED';
  }

  // 6. In flight, most advanced first. DELIVERED stops here on purpose.
  if (has(aggregate, 'delivered')) return 'DELIVERED';
  if (has(aggregate, 'icm-sent') || has(aggregate, 'send-retry')) return 'ICM_SENT';
  if (has(aggregate, 'source-accounted')) return 'SOURCE_ACCOUNTED';
  if (has(aggregate, 'intent-observed')) return 'INTENT_OBSERVED';
  if (has(aggregate, 'source-application-emitted')) return 'SOURCE_APPLICATION_EMITTED';

  // 7. A receipt and nothing else. A relayer signal is not a lifecycle position,
  //    so it only names the state when there is genuinely nothing stronger.
  if (has(aggregate, 'receipt-observed')) return 'RECEIPT_OBSERVED';

  return 'UNCLASSIFIABLE';
};

const economicEffectOf = (
  aggregate: MessageAggregate,
): { effect: EconomicEffect; duplicates: readonly RawFactRef[] } => {
  const sourceFacts = [...aggregate.facts.values()].filter(
    (f) => SOURCE_EFFECT_KINDS.has(f.kind) && carriesEffect(f),
  );
  const destinationFacts = [...aggregate.facts.values()].filter(
    (f) => DESTINATION_EFFECT_KINDS.has(f.kind) && carriesEffect(f),
  );

  // Distinct raw facts, canonically ordered. A retry of the SAME execution log is
  // one fact; two different successful executions are two, and that is a breach.
  const distinct = [...new Map(destinationFacts.map((f) => [rawFactRefOf(f.fact), f])).values()]
    .sort((a, b) => (rawFactRefOf(a.fact) < rawFactRefOf(b.fact) ? -1 : 1))
    .map((f) => f.fact);

  const first = distinct[0] ?? null;
  const sourceFirst =
    [...sourceFacts]
      .sort((a, b) => (rawFactRefOf(a.fact) < rawFactRefOf(b.fact) ? -1 : 1))
      .map((f) => f.fact)[0] ?? null;

  return {
    // Capped at one by construction. `duplicates` carries the evidence that the
    // cap had to be applied, so the breach is reported rather than absorbed.
    effect: { count: first === null ? 0 : 1, sourceFact: sourceFirst, destinationFact: first },
    duplicates: distinct.length > 1 ? distinct : [],
  };
};

/**
 * Derive the message state.
 *
 * `duplicateEffectFacts` escalates the verdict to CRITICAL: two credited
 * executions for one message key is an accounting breach, and no lifecycle
 * position should be allowed to report it as merely successful.
 */
export const deriveState = (
  aggregate: MessageAggregate,
  context: EvaluationContext,
): DerivedMessage => {
  const base = lifecycleState(aggregate);
  const { effect, duplicates } = economicEffectOf(aggregate);

  // Staleness only applies to something still in flight. A terminal state does
  // not decay, and an UNKNOWN one is already not green.
  const observedAt = latestObservedAt(aggregate);
  const stale =
    !isTerminal(base) &&
    stateVerdict(base) === 'WARN' &&
    observedAt !== null &&
    context.evaluatedAt.getTime() - observedAt.getTime() > context.staleAfterMs;

  const state: MessageState = stale ? 'STALE' : base;

  const envelopeIds = [
    ...new Set(
      [...aggregate.facts.values()]
        .map((f) => f.envelopeId)
        .filter((id): id is string => id !== undefined),
    ),
  ].sort();

  return {
    state,
    verdict: duplicates.length > 0 ? 'CRITICAL' : stateVerdict(state),
    effect,
    duplicateEffectFacts: duplicates,
    // One intent can legitimately have several send attempts.
    sendAttempts:
      factsOfKind(aggregate, 'icm-sent').length + factsOfKind(aggregate, 'send-retry').length,
    executionAttempts:
      factsOfKind(aggregate, 'execution-succeeded').length +
      factsOfKind(aggregate, 'execution-failed').length +
      factsOfKind(aggregate, 'execution-retried').length,
    envelopeIds,
    receiptObserved: has(aggregate, 'receipt-observed'),
    unsupportedReasons: [
      ...new Set(
        [...aggregate.facts.values()]
          .map((f) => f.unsupportedReason)
          .filter((r): r is string => r !== undefined),
      ),
    ].sort(),
    supportingFacts: supportingFacts(aggregate),
  };
};
