import { type MessageKey, type RawFactRef, messageKeyOf, rawFactRefOf } from './keys.js';
import type { TransitionInput } from './inputs.js';

/**
 * The facts known about one message.
 *
 * A SET, not a sequence. This is the design decision the whole milestone rests
 * on: because state is derived from an unordered set keyed by raw fact identity,
 * ingestion order cannot change the answer and re-applying a fact cannot change
 * it either. Order independence and idempotency are structural here, not
 * properties a sequential state machine would have to be careful to preserve.
 */

export interface MessageAggregate {
  readonly key: MessageKey;
  /** Keyed by `rawFactRefOf`, so the same log can only ever appear once. */
  readonly facts: ReadonlyMap<string, TransitionInput>;
}

export const emptyAggregate = (key: MessageKey): MessageAggregate => ({
  key,
  facts: new Map(),
});

/** Raised when an input is folded into an aggregate for a different message. */
export class MessageKeyMismatchError extends Error {
  override readonly name = 'MessageKeyMismatchError';
  constructor(expected: MessageKey, got: MessageKey) {
    super(
      `transition input belongs to ${messageKeyOf(got)}, not ${messageKeyOf(expected)}; ` +
        `messageId alone is not identity`,
    );
  }
}

/**
 * Fold one input into an aggregate.
 *
 * Idempotent by raw fact identity: a duplicated log, a redelivered webhook and a
 * replayed range all land on the same map entry. The first observation wins,
 * which keeps the result independent of which duplicate arrived first.
 */
export const reduce = (aggregate: MessageAggregate, input: TransitionInput): MessageAggregate => {
  if (messageKeyOf(input.message) !== messageKeyOf(aggregate.key)) {
    throw new MessageKeyMismatchError(aggregate.key, input.message);
  }
  const id = rawFactRefOf(input.fact);
  if (aggregate.facts.has(id)) return aggregate;

  const facts = new Map(aggregate.facts);
  facts.set(id, input);
  return { key: aggregate.key, facts };
};

/** Fold a batch. Equivalent to repeated `reduce`, in any order. */
export const reduceAll = (key: MessageKey, inputs: readonly TransitionInput[]): MessageAggregate =>
  inputs.reduce(reduce, emptyAggregate(key));

/** Group loose inputs into one aggregate per message key. */
export const groupByMessage = (
  inputs: readonly TransitionInput[],
): ReadonlyMap<string, MessageAggregate> => {
  const out = new Map<string, MessageAggregate>();
  for (const input of inputs) {
    const id = messageKeyOf(input.message);
    out.set(id, reduce(out.get(id) ?? emptyAggregate(input.message), input));
  }
  return out;
};

/** Inputs of a given kind, in canonical order so callers stay deterministic. */
export const factsOfKind = (
  aggregate: MessageAggregate,
  kind: TransitionInput['kind'],
): readonly TransitionInput[] =>
  [...aggregate.facts.entries()]
    .filter(([, v]) => v.kind === kind)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => v);

export const has = (aggregate: MessageAggregate, kind: TransitionInput['kind']): boolean =>
  [...aggregate.facts.values()].some((f) => f.kind === kind);

/** Every raw fact backing this aggregate, canonically ordered. */
export const supportingFacts = (aggregate: MessageAggregate): readonly RawFactRef[] =>
  [...aggregate.facts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, v]) => v.fact);
