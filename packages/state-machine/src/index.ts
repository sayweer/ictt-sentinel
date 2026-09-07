// @ictt-sentinel/state-machine
//
// Deterministic message lifecycle over source-locked facts.
//
// Pure by construction: no network, no database, no `process.env`, no clock and
// no randomness. Evaluation time is injected, chain timestamps come in with the
// facts, and state is derived from an unordered SET - so ingestion order cannot
// change the answer and re-applying a fact cannot either.
//
// Three separations this package exists to hold:
//   * delivery is not execution;
//   * a send retry, an execution retry and a re-signed envelope are three
//     different things, and only one of them can ever add an economic effect;
//   * a message key is the full route tuple, never `messageID` alone.

export const PACKAGE_NAME = '@ictt-sentinel/state-machine' as const;

export { messageKeyOf, rawFactRefOf, sameMessage, sameRawFact, transactionKeyOf } from './keys.js';
export type { FactPosition, MessageKey, RawFactRef } from './keys.js';

export {
  MESSAGE_STATES,
  TERMINAL_STATES,
  isTerminal,
  isHealthyState,
  stateVerdict,
} from './states.js';
export type { MessageState } from './states.js';

export {
  TRANSITION_KINDS,
  SOURCE_EFFECT_KINDS,
  DESTINATION_EFFECT_KINDS,
  assertsExecution,
} from './inputs.js';
export type { TransitionInput, TransitionKind } from './inputs.js';

export {
  MessageKeyMismatchError,
  emptyAggregate,
  factsOfKind,
  groupByMessage,
  has,
  reduce,
  reduceAll,
  supportingFacts,
} from './aggregate.js';
export type { MessageAggregate } from './aggregate.js';

export { deriveState } from './derive.js';
export type { DerivedMessage, EconomicEffect, EvaluationContext } from './derive.js';

export {
  MixedTransactionError,
  PartialTransactionError,
  groupByTransaction,
  reduceTransaction,
} from './transaction.js';
export type { TransactionBatch } from './transaction.js';

export { CUT_OUTCOMES, assessCut, cutPermitsEvaluation } from './watermark.js';
export type { ChainCut, CutAssessment, CutOutcome, OpenEdge } from './watermark.js';
