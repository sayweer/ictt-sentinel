import { describe, expect, it } from 'vitest';
import { AT, happyPath, input, messageKey } from '@ictt-sentinel/testkit';
import { emptyAggregate, reduceAll } from '../src/aggregate.js';
import { deriveState, type EvaluationContext } from '../src/derive.js';
import {
  MixedTransactionError,
  PartialTransactionError,
  groupByTransaction,
  reduceTransaction,
} from '../src/transaction.js';

const CTX: EvaluationContext = { evaluatedAt: AT(600), staleAfterMs: 30 * 60 * 1000 };

/**
 * The destination transaction of a successful transfer: the protocol event and
 * the economic effect land in ONE transaction, and the pinned source does not
 * guarantee which comes first.
 */
const executionTx = (executedFirst: boolean) => {
  const executed = input('execution-succeeded', {
    blockNumber: 200,
    txIndex: 0,
    logIndex: executedFirst ? 0 : 1,
  });
  const delivered = input('delivered', {
    blockNumber: 200,
    txIndex: 0,
    logIndex: executedFirst ? 1 : 0,
  });
  return executedFirst ? [executed, delivered] : [delivered, executed];
};

describe('reduceTransaction', () => {
  it('refuses a partial transaction rather than deriving a terminal state from it', () => {
    expect(() =>
      reduceTransaction(emptyAggregate(messageKey()), {
        inputs: executionTx(true),
        complete: false,
      }),
    ).toThrow(PartialTransactionError);
  });

  it('folds a complete transaction whole', () => {
    const a = reduceTransaction(emptyAggregate(messageKey()), {
      inputs: executionTx(true),
      complete: true,
    });
    expect(a.facts.size).toBe(2);
  });

  it('gives the same result whichever order the events sit in the transaction', () => {
    // MessageExecuted can precede or follow the economic log; both must reduce
    // to the same state.
    const first = reduceTransaction(emptyAggregate(messageKey()), {
      inputs: executionTx(true),
      complete: true,
    });
    const second = reduceTransaction(emptyAggregate(messageKey()), {
      inputs: executionTx(false),
      complete: true,
    });
    expect(deriveState(first, CTX).state).toBe(deriveState(second, CTX).state);
    expect(deriveState(first, CTX).effect.count).toBe(deriveState(second, CTX).effect.count);
  });

  it('rejects a batch that mixes transactions', () => {
    expect(() =>
      reduceTransaction(emptyAggregate(messageKey()), {
        inputs: [
          input('delivered', { blockNumber: 200, txIndex: 0 }),
          input('execution-succeeded', { blockNumber: 200, txIndex: 1 }),
        ],
        complete: true,
      }),
    ).toThrow(MixedTransactionError);
  });

  it('is a no-op for an empty batch', () => {
    const a = emptyAggregate(messageKey());
    expect(reduceTransaction(a, { inputs: [], complete: false })).toBe(a);
  });

  it('ignores inputs for another message inside the same transaction', () => {
    const mine = messageKey();
    const theirs = messageKey({ messageId: `0x${'9'.repeat(64)}` });
    const a = reduceTransaction(emptyAggregate(mine), {
      inputs: [
        input('delivered', { message: mine, blockNumber: 200, txIndex: 0, logIndex: 0 }),
        input('delivered', { message: theirs, blockNumber: 200, txIndex: 0, logIndex: 1 }),
      ],
      complete: true,
    });
    expect(a.facts.size).toBe(1);
  });
});

describe('groupByTransaction', () => {
  it('groups facts by transaction and orders them canonically', () => {
    const groups = groupByTransaction(happyPath());
    // Source facts share one transaction, destination facts another.
    expect(groups.size).toBe(2);
    for (const inputs of groups.values()) {
      const indices = inputs.map((i) => i.fact.logIndex);
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    }
  });

  it('is deterministic', () => {
    expect(groupByTransaction(happyPath())).toEqual(groupByTransaction([...happyPath()].reverse()));
  });
});

describe('partial transactions never reach a terminal state', () => {
  it('cannot produce EXECUTED_SUCCESS from half a transaction', () => {
    const complete = reduceAll(messageKey(), happyPath());
    expect(deriveState(complete, CTX).state).toBe('EXECUTED_SUCCESS');

    // The same facts, minus the execution log, is the "half transaction" case.
    // It must not read as success.
    const partial = reduceAll(
      messageKey(),
      happyPath().filter((i) => i.kind !== 'execution-succeeded'),
    );
    expect(deriveState(partial, CTX).state).not.toBe('EXECUTED_SUCCESS');
  });
});
