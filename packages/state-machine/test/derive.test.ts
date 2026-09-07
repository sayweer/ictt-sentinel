import { describe, expect, it } from 'vitest';
import {
  AT,
  MESSENGER,
  OTHER_CHAIN,
  OTHER_MESSENGER,
  deliveredButFailed,
  doubleEffect,
  emptyPayload,
  envelopeResigned,
  failedThenRetried,
  happyPath,
  input,
  messageKey,
  multiHop,
  receiptOnly,
  sendRetried,
} from '@ictt-sentinel/testkit';
import { deriveState, type EvaluationContext } from '../src/derive.js';
import { reduceAll } from '../src/aggregate.js';
import { messageKeyOf } from '../src/keys.js';
import type { TransitionInput } from '../src/inputs.js';

const CTX: EvaluationContext = {
  evaluatedAt: AT(60),
  staleAfterMs: 30 * 60 * 1000,
};

const derive = (inputs: readonly TransitionInput[], ctx: EvaluationContext = CTX) =>
  deriveState(reduceAll(inputs[0]?.message ?? messageKey(), inputs), ctx);

describe('lifecycle states', () => {
  it('reaches EXECUTED_SUCCESS on the happy path, with exactly one effect', () => {
    const d = derive(happyPath());
    expect(d.state).toBe('EXECUTED_SUCCESS');
    expect(d.verdict).toBe('OK');
    expect(d.effect.count).toBe(1);
    expect(d.effect.sourceFact).not.toBeNull();
    expect(d.effect.destinationFact).not.toBeNull();
  });

  it('keeps DELIVERED separate from execution', () => {
    // The dangerous product bug: a delivered message reported as succeeded.
    const delivered = happyPath().filter((i) => i.kind !== 'execution-succeeded');
    const d = derive(delivered);
    expect(d.state).toBe('DELIVERED');
    expect(d.verdict).not.toBe('OK');
    expect(d.effect.count).toBe(0);
  });

  it('does not close a failed execution as healthy', () => {
    const d = derive(deliveredButFailed());
    expect(d.state).toBe('EXECUTED_FAILED');
    expect(d.verdict).toBe('WARN');
    expect(d.effect.count).toBe(0);
    expect(d.executionAttempts).toBe(1);
  });

  it('reports a retried success as RETRIED_SUCCESS, with one effect', () => {
    const d = derive(failedThenRetried());
    expect(d.state).toBe('RETRIED_SUCCESS');
    expect(d.verdict).toBe('OK');
    // Failure plus retry is two attempts and still one economic effect.
    expect(d.executionAttempts).toBe(2);
    expect(d.effect.count).toBe(1);
  });

  it('reports RETRY_PENDING when a failure has another attempt in flight', () => {
    const d = derive([
      ...deliveredButFailed(),
      input('send-retry', { blockNumber: 105, logIndex: 0, envelopeId: 'env-1' }),
    ]);
    expect(d.state).toBe('RETRY_PENDING');
  });

  it('treats a receipt alone as liveness, not as a transfer', () => {
    const d = derive(receiptOnly());
    expect(d.state).toBe('RECEIPT_OBSERVED');
    expect(d.receiptObserved).toBe(true);
    expect(d.effect.count).toBe(0);
    expect(d.verdict).not.toBe('OK');
  });

  it('never lets a receipt override the lifecycle position', () => {
    const d = derive([...happyPath(), input('receipt-observed', { blockNumber: 130 })]);
    expect(d.state).toBe('EXECUTED_SUCCESS');
    expect(d.receiptObserved).toBe(true);
  });

  it('produces no economic effect for an empty-payload message', () => {
    const d = derive(emptyPayload());
    expect(d.state).toBe('EXECUTED_SUCCESS');
    expect(d.effect.count).toBe(0);
  });

  it('is UNCLASSIFIABLE for an unsupported multi-hop route', () => {
    // Never flattened into a single hop (docs/SUPPORT_MATRIX.md 1).
    const d = derive(multiHop());
    expect(d.state).toBe('UNCLASSIFIABLE');
    expect(d.verdict).toBe('UNKNOWN');
    expect(d.unsupportedReasons).toEqual(['multi-hop']);
  });

  it('is UNCLASSIFIABLE when unsupported facts sit alongside good ones', () => {
    // Fail-closed: not understanding part of the story invalidates the whole one.
    const d = derive([
      ...happyPath(),
      input('unsupported', { blockNumber: 240, unsupportedReason: 'unknown-fingerprint' }),
    ]);
    expect(d.state).toBe('UNCLASSIFIABLE');
    expect(d.verdict).toBe('UNKNOWN');
  });

  it('is ORPHANED when the facts left the canonical chain', () => {
    const d = derive([...happyPath(), input('orphaned', { blockNumber: 100, logIndex: 9 })]);
    expect(d.state).toBe('ORPHANED');
    expect(d.verdict).toBe('UNKNOWN');
  });

  it('reports version-policy states as UNKNOWN, not as failures of the bridge', () => {
    expect(derive([input('paused-version', { blockNumber: 100 })]).state).toBe('PAUSED_VERSION');
    expect(derive([input('unreceivable-by-version-policy', { blockNumber: 100 })]).state).toBe(
      'UNRECEIVABLE_BY_VERSION_POLICY',
    );
    for (const s of ['paused-version', 'unreceivable-by-version-policy'] as const) {
      expect(derive([input(s, { blockNumber: 100 })]).verdict).toBe('UNKNOWN');
    }
  });

  it('is UNCLASSIFIABLE with no facts at all, never OK', () => {
    const d = derive([input('receipt-observed', { blockNumber: 1 })].slice(0, 0));
    expect(d.state).toBe('UNCLASSIFIABLE');
    expect(d.verdict).toBe('UNKNOWN');
  });
});

describe('retry and lineage separation', () => {
  it('counts a send retry as a second attempt, not a second intent', () => {
    const d = derive(sendRetried());
    expect(d.sendAttempts).toBe(2);
    expect(d.effect.count).toBe(1);
    expect(d.state).toBe('EXECUTED_SUCCESS');
  });

  it('keeps a re-signed envelope apart from the application lineage', () => {
    // A validator-set change makes a NEW ICM envelope carrying the SAME message.
    const d = derive(envelopeResigned());
    expect(d.envelopeIds).toEqual(['env-1', 'env-2']);
    expect(d.effect.count).toBe(1);
    expect(d.state).toBe('EXECUTED_SUCCESS');
  });

  it('does not confuse a send retry with an execution retry', () => {
    const send = derive(sendRetried());
    const exec = derive(failedThenRetried());
    expect(send.sendAttempts).toBe(2);
    expect(send.executionAttempts).toBe(1);
    expect(exec.sendAttempts).toBe(1);
    expect(exec.executionAttempts).toBe(2);
  });
});

describe('at most one economic effect', () => {
  it('surfaces a second distinct execution as a CRITICAL breach', () => {
    const d = derive(doubleEffect());
    // Capped at one, and the evidence that the cap was needed is reported.
    expect(d.effect.count).toBe(1);
    expect(d.duplicateEffectFacts).toHaveLength(2);
    expect(d.verdict).toBe('CRITICAL');
  });

  it('does not treat a duplicated log as a second effect', () => {
    const facts = happyPath();
    const d = derive([...facts, ...facts]);
    expect(d.duplicateEffectFacts).toEqual([]);
    expect(d.effect.count).toBe(1);
    expect(d.verdict).toBe('OK');
  });
});

describe('composite key', () => {
  it('separates the same messageId across different messengers', () => {
    const a = messageKey();
    const b = messageKey({ teleporterMessengerAddress: OTHER_MESSENGER });
    expect(messageKeyOf(a)).not.toBe(messageKeyOf(b));
    expect(a.messageId).toBe(b.messageId);
  });

  it('separates the same messageId across registry protocol versions', () => {
    expect(messageKeyOf(messageKey())).not.toBe(
      messageKeyOf(messageKey({ registryProtocolVersion: 2 })),
    );
  });

  it('separates the same messageId across destinations', () => {
    expect(messageKeyOf(messageKey())).not.toBe(
      messageKeyOf(messageKey({ destinationBlockchainId: OTHER_CHAIN })),
    );
  });

  it('keeps one route stable', () => {
    expect(messageKeyOf(messageKey())).toBe(
      messageKeyOf(messageKey({ teleporterMessengerAddress: MESSENGER })),
    );
  });
});

describe('staleness', () => {
  const inFlight = () => happyPath().filter((i) => i.kind !== 'execution-succeeded');

  it('turns an in-flight message stale after the TTL', () => {
    const facts = inFlight().map((i) => ({ ...i, observedAt: AT(0) }));
    const d = derive(facts, { evaluatedAt: AT(3600), staleAfterMs: 60 * 1000 });
    expect(d.state).toBe('STALE');
    expect(d.verdict).toBe('UNKNOWN');
  });

  it('does not stale a message that already succeeded', () => {
    const facts = happyPath().map((i) => ({ ...i, observedAt: AT(0) }));
    const d = derive(facts, { evaluatedAt: AT(3600), staleAfterMs: 60 * 1000 });
    expect(d.state).toBe('EXECUTED_SUCCESS');
  });

  it('stays in flight inside the TTL', () => {
    const facts = inFlight().map((i) => ({ ...i, observedAt: AT(0) }));
    const d = derive(facts, { evaluatedAt: AT(30), staleAfterMs: 60 * 1000 });
    expect(d.state).toBe('DELIVERED');
  });
});
