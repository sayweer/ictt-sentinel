/**
 * Semantic message states.
 *
 * These names are OURS. They are not protocol event names and must never be
 * matched against one: an adapter turns a source-locked event into a transition
 * input, and only then does this vocabulary apply
 * (docs/PROTOCOL_SOURCE_LOCK.md 4).
 */

export const MESSAGE_STATES = [
  /** The application on the source chain emitted its own intent event. */
  'SOURCE_APPLICATION_EMITTED',
  /** A transfer intent was observed, before source accounting is confirmed. */
  'INTENT_OBSERVED',
  /** The source side recorded the economic effect (lock/burn accounted). */
  'SOURCE_ACCOUNTED',
  /** The ICM/Teleporter message left the source chain. */
  'ICM_SENT',
  /** Received on the destination chain. NOT execution. */
  'DELIVERED',
  'EXECUTED_SUCCESS',
  /** Delivered, application call reverted. Never a healthy close. */
  'EXECUTED_FAILED',
  'RETRY_PENDING',
  'RETRIED_SUCCESS',
  /** A relayer receipt was seen and nothing stronger. Liveness only. */
  'RECEIPT_OBSERVED',
  /** Destination policy will not accept this messenger/registry version. */
  'UNRECEIVABLE_BY_VERSION_POLICY',
  /** The messenger is paused at the relevant version. */
  'PAUSED_VERSION',
  /** Freshness expired without reaching a terminal state. */
  'STALE',
  /** Its facts were reclassified off the canonical chain. */
  'ORPHANED',
  /** Unsupported family, shape or fingerprint. Fail-closed. */
  'UNCLASSIFIABLE',
] as const;

export type MessageState = (typeof MESSAGE_STATES)[number];

/**
 * States from which no further progress is expected.
 *
 * `EXECUTED_FAILED` is deliberately NOT terminal: a failed execution can still be
 * retried into success, and treating it as closed is how a stuck message stops
 * being watched (docs/ARCHITECTURE.md 5).
 */
export const TERMINAL_STATES: ReadonlySet<MessageState> = new Set([
  'EXECUTED_SUCCESS',
  'RETRIED_SUCCESS',
  'ORPHANED',
]);

export const isTerminal = (s: MessageState): boolean => TERMINAL_STATES.has(s);

/**
 * States that may be surfaced as healthy.
 *
 * Exactly two. Everything else - including `DELIVERED`, which looks like success
 * and is not - stays out.
 */
const HEALTHY_STATES: ReadonlySet<MessageState> = new Set(['EXECUTED_SUCCESS', 'RETRIED_SUCCESS']);

export const isHealthyState = (s: MessageState): boolean => HEALTHY_STATES.has(s);

/**
 * How a state maps onto the verdict lattice.
 *
 * Nothing here returns OK for a state that has not actually executed, and
 * nothing returns OK for an unknown one. `UNCLASSIFIABLE`, `STALE` and the two
 * version-policy states are UNKNOWN, never a quiet pass
 * (docs/adr/0003-fail-closed-verdicts.md).
 */
export const stateVerdict = (s: MessageState): 'OK' | 'WARN' | 'UNKNOWN' | 'CRITICAL' => {
  switch (s) {
    case 'EXECUTED_SUCCESS':
    case 'RETRIED_SUCCESS':
      return 'OK';
    case 'EXECUTED_FAILED':
    case 'RETRY_PENDING':
      // A message that reached the destination and failed is a liveness problem
      // the operator must see; it is not by itself proof of an economic breach.
      return 'WARN';
    case 'SOURCE_APPLICATION_EMITTED':
    case 'INTENT_OBSERVED':
    case 'SOURCE_ACCOUNTED':
    case 'ICM_SENT':
    case 'DELIVERED':
    case 'RECEIPT_OBSERVED':
      // In flight. Not an error, but not a healthy close either.
      return 'WARN';
    case 'UNRECEIVABLE_BY_VERSION_POLICY':
    case 'PAUSED_VERSION':
    case 'STALE':
    case 'ORPHANED':
    case 'UNCLASSIFIABLE':
      return 'UNKNOWN';
  }
};
