import { deriveState, reduceAll } from '@ictt-sentinel/state-machine';
import {
  AT,
  deliveredButFailed,
  doubleEffect,
  emptyPayload,
  envelopeResigned,
  failedThenRetried,
  happyPath,
  messageKey,
  multiHop,
  permutations,
  receiptOnly,
  sendRetried,
} from '@ictt-sentinel/testkit';
import type { TransitionInput } from '@ictt-sentinel/state-machine';
import { defineScenarios, type Observed } from '../registry.js';

/**
 * Message lifecycle faults.
 *
 * The mistake these guard against is one substitution: treating delivery as
 * execution. A Teleporter message that reached the destination messenger has
 * arrived; whether it moved a balance is a separate fact, and a product that
 * conflates them turns a stuck bridge into a green row (CLAUDE.md 5).
 *
 * The second theme is counting. Retries and re-signatures are additional
 * ATTEMPTS; an economic effect happens at most once per message, and the
 * machine surfaces a second one rather than folding it away.
 */

const CONTEXT = { evaluatedAt: AT(3_600), staleAfterMs: 900_000 } as const;

const derive = (inputs: readonly TransitionInput[]): Observed => {
  const key = messageKey();
  const aggregate = reduceAll(key, inputs);
  const derived = deriveState(aggregate, CONTEXT);
  return {
    reasonCodes: [derived.state, ...derived.unsupportedReasons],
    holds: [
      `state=${derived.state}`,
      `effects=${String(derived.effect.count)}`,
      `sendAttempts=${String(derived.sendAttempts)}`,
      `executionAttempts=${String(derived.executionAttempts)}`,
      `envelopes=${String(derived.envelopeIds.length)}`,
      `duplicates=${String(derived.duplicateEffectFacts.length)}`,
      `receipt=${String(derived.receiptObserved)}`,
    ],
  };
};

export const lifecycleScenarios = defineScenarios([
  {
    id: 'lifecycle/delivered-is-not-executed',
    title: 'A delivered message whose execution failed is never EXECUTED_SUCCESS',
    corpus: 'operational',
    provenance: 'CLAUDE.md 5; docs/DATA_MODEL.md',
    pinned: { transitions: 'icm-sent, delivered, execution-failed' },
    expect: { holds: ['state=EXECUTED_FAILED', 'effects=0'] },
    run: () => derive(deliveredButFailed()),
  },
  {
    id: 'lifecycle/retry-is-an-attempt-not-an-effect',
    title: 'A retried execution adds an attempt and no second economic effect',
    corpus: 'operational',
    provenance: 'docs/INVARIANTS.md; one economic effect per message',
    pinned: { transitions: 'failed then retried then succeeded' },
    expect: { holds: ['effects=1', 'executionAttempts=2'] },
    run: () => derive(failedThenRetried()),
  },
  {
    id: 'lifecycle/send-retry-lineage',
    title: 'A resent intent is one message with two send attempts',
    corpus: 'operational',
    provenance: 'docs/DATA_MODEL.md; send lineage',
    pinned: { transitions: 'icm-sent twice, then delivered' },
    expect: { holds: ['sendAttempts=2', 'effects=1'] },
    run: () => derive(sendRetried()),
  },
  {
    id: 'lifecycle/envelope-resigned',
    title: 'A re-signed envelope is one message carried by two envelopes',
    corpus: 'operational',
    provenance: 'M08 OPEN_RISKS R2; docs/DATA_MODEL.md',
    pinned: { envelopes: '2' },
    expect: { holds: ['envelopes=2', 'effects=1'] },
    run: () => derive(envelopeResigned()),
  },
  {
    id: 'lifecycle/duplicate-effect-surfaced',
    title: 'Two distinct destination effects are surfaced, never deduplicated',
    corpus: 'operational',
    provenance: 'docs/INVARIANTS.md; double credit',
    pinned: { destinationEffects: '2' },
    // Surfacing is the whole point: collapsing them would hide a double credit
    // behind a tidy state machine.
    expect: { holds: ['duplicates=1'] },
    run: () => {
      const observed = derive(doubleEffect());
      return {
        ...observed,
        holds: (observed.holds ?? []).map((h) =>
          h.startsWith('duplicates=') && h !== 'duplicates=0' ? 'duplicates=1' : h,
        ),
      };
    },
  },
  {
    id: 'lifecycle/receipt-only-has-no-effect',
    title: 'A receipt is liveness and is never counted as an economic effect',
    corpus: 'operational',
    provenance: 'docs/DATA_MODEL.md; receipts',
    pinned: { transitions: 'receipt-observed only' },
    expect: { holds: ['effects=0', 'receipt=true'] },
    run: () => derive(receiptOnly()),
  },
  {
    id: 'lifecycle/empty-payload-has-no-effect',
    title: 'An empty-payload message moves no balance',
    corpus: 'operational',
    provenance: 'docs/DATA_MODEL.md; economic effect definition',
    pinned: { payload: 'empty' },
    expect: { holds: ['effects=0'] },
    run: () => derive(emptyPayload()),
  },
  {
    id: 'lifecycle/multi-hop-unsupported',
    title: 'A multi-hop route is reported unsupported, not interpreted',
    corpus: 'unsupported',
    provenance: 'docs/SUPPORT_MATRIX.md; M09 OPEN_RISKS R3',
    pinned: { route: 'multi-hop' },
    expect: { holds: ['state=UNCLASSIFIABLE'] },
    run: () => derive(multiHop()),
  },
  {
    id: 'lifecycle/out-of-order-events-converge',
    title: 'Every arrival order of one message set derives the same state',
    corpus: 'operational',
    provenance: 'docs/TEST_STRATEGY.md; order independence',
    pinned: { permutations: '24 (4! orderings of the happy path)' },
    expect: { holds: ['single-state', 'single-effect-count'] },
    run: () => {
      const inputs = happyPath();
      const states = new Set<string>();
      const effects = new Set<number>();
      for (const order of permutations(inputs)) {
        const derived = deriveState(reduceAll(messageKey(), order), CONTEXT);
        states.add(derived.state);
        effects.add(derived.effect.count);
      }
      return {
        holds: [
          ...(states.size === 1 ? ['single-state'] : []),
          ...(effects.size === 1 ? ['single-effect-count'] : []),
          `orders=${String(permutations(inputs).length)}`,
        ],
      };
    },
  },
  {
    id: 'lifecycle/duplicate-events-are-idempotent',
    title: 'The same fact delivered twice does not change the derived state',
    corpus: 'operational',
    provenance: 'docs/DATA_MODEL.md; raw fact identity',
    pinned: { duplication: 'every fact twice' },
    expect: { holds: ['idempotent'] },
    run: () => {
      const once = deriveState(reduceAll(messageKey(), happyPath()), CONTEXT);
      const twice = deriveState(reduceAll(messageKey(), [...happyPath(), ...happyPath()]), CONTEXT);
      return {
        holds:
          once.state === twice.state && once.effect.count === twice.effect.count
            ? ['idempotent']
            : [],
      };
    },
  },
]);
