import { type MessageAggregate, reduce } from './aggregate.js';
import type { TransitionInput } from './inputs.js';
import { transactionKeyOf } from './keys.js';

/**
 * Transaction-atomic folding.
 *
 * A transaction is reduced whole or not at all. Within one transaction the
 * protocol event and the economic log can appear in either order - the pinned
 * source emits `MessageExecuted` around the transfer effect, not reliably before
 * or after it - so folding half a transaction can produce a terminal state the
 * complete transaction would never have produced.
 */

export interface TransactionBatch {
  /** Every input here must come from one transaction. */
  readonly inputs: readonly TransitionInput[];
  /**
   * The adapter's assertion that this is the WHOLE transaction. Only the layer
   * that fetched the receipt can know it; the state machine will not guess.
   */
  readonly complete: boolean;
}

export class PartialTransactionError extends Error {
  override readonly name = 'PartialTransactionError';
  readonly transactionKey: string;
  constructor(transactionKey: string) {
    super(
      `refusing to reduce a partial transaction (${transactionKey}); ` +
        `a terminal state derived from half a transaction is not a fact`,
    );
    this.transactionKey = transactionKey;
  }
}

export class MixedTransactionError extends Error {
  override readonly name = 'MixedTransactionError';
  constructor(keys: readonly string[]) {
    super(
      `a transaction batch must come from one transaction, got ${String(keys.length)}: ${keys.join(', ')}`,
    );
  }
}

/**
 * Fold a whole transaction into an aggregate.
 *
 * Order inside the batch is irrelevant - the aggregate is a set - but
 * completeness is not. An incomplete batch raises rather than producing a state
 * that would change once the rest of the transaction arrived.
 */
export const reduceTransaction = (
  aggregate: MessageAggregate,
  batch: TransactionBatch,
): MessageAggregate => {
  if (batch.inputs.length === 0) return aggregate;

  const keys = [...new Set(batch.inputs.map((i) => transactionKeyOf(i.fact)))];
  if (keys.length > 1) throw new MixedTransactionError(keys);

  const txKey = keys[0];
  if (txKey === undefined) return aggregate;
  if (!batch.complete) throw new PartialTransactionError(txKey);

  // Only inputs for THIS aggregate's message; a transaction can carry several.
  return batch.inputs
    .filter((i) => i.message.messageId === aggregate.key.messageId)
    .reduce(reduce, aggregate);
};

/** Split loose inputs into per-transaction batches, canonically ordered. */
export const groupByTransaction = (
  inputs: readonly TransitionInput[],
): ReadonlyMap<string, readonly TransitionInput[]> => {
  const out = new Map<string, TransitionInput[]>();
  for (const i of inputs) {
    const key = transactionKeyOf(i.fact);
    const list = out.get(key);
    if (list) list.push(i);
    else out.set(key, [i]);
  }
  return new Map(
    [...out.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => [k, [...v].sort((x, y) => x.fact.logIndex - y.fact.logIndex)]),
  );
};
