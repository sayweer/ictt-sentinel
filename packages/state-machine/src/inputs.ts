import type { FactPosition, MessageKey, RawFactRef } from './keys.js';

/**
 * Transition inputs.
 *
 * These are SEMANTIC, produced by an adapter from a source-locked event. The
 * state machine never sees an ABI name, a topic or a raw log, so it cannot guess
 * an event name or recompute a message id: it consumes what a pinned adapter
 * already decided the bytes meant.
 */

export const TRANSITION_KINDS = [
  /** The source application emitted its own intent event. */
  'source-application-emitted',
  /** A transfer intent, before the source accounting is confirmed. */
  'intent-observed',
  /** Source-side economic effect recorded (lock or burn accounted). */
  'source-accounted',
  /** The message left the source chain. */
  'icm-sent',
  /**
   * A further send attempt for the SAME Teleporter message id. A second attempt
   * to deliver one intent, never a second intent.
   */
  'send-retry',
  /**
   * Re-signing under a changed validator set produces a new ICM envelope while
   * the application lineage is unchanged. Tracked apart from `send-retry`.
   */
  'envelope-resigned',
  /** Received on the destination chain. Delivery only. */
  'delivered',
  'execution-succeeded',
  'execution-failed',
  /** A further execution attempt after a failure. */
  'execution-retried',
  /** Relayer receipt. Liveness signal, never economic evidence. */
  'receipt-observed',
  /** Destination policy refuses this messenger/registry version. */
  'unreceivable-by-version-policy',
  /** The messenger is paused at the relevant version. */
  'paused-version',
  /** The fact was reclassified off the canonical chain. */
  'orphaned',
  /** Unsupported family, shape or fingerprint. Always fail-closed. */
  'unsupported',
] as const;

export type TransitionKind = (typeof TRANSITION_KINDS)[number];

export interface TransitionInput {
  readonly kind: TransitionKind;
  readonly message: MessageKey;
  /** The raw fact this was derived from. Also the idempotency key. */
  readonly fact: RawFactRef;
  /**
   * Pinned position on the chain that produced it. Carries the block HASH as
   * well as the height, because a height alone is not a position after a reorg.
   * The causal watermark compares facts against per-chain cuts using this.
   */
  readonly position: FactPosition;
  /**
   * Identity of the underlying ICM envelope. Two envelopes can carry one
   * application lineage after a re-sign, so this is separate from the message key.
   */
  readonly envelopeId?: string;
  /**
   * True when this input carries an actual economic transfer. A receipt-only or
   * empty-payload message sets it false and therefore produces no effect.
   */
  readonly carriesEconomicEffect?: boolean;
  /** Why the input is unsupported. Present only for `unsupported`. */
  readonly unsupportedReason?: string;
  /**
   * Block timestamp of the fact, from chain data rather than a wall clock. The
   * pure core never reads a clock; staleness compares this against an evaluation
   * time the caller injects.
   */
  readonly observedAt?: Date;
  /** Adapter provenance, so a transition can be traced back to what decoded it. */
  readonly adapterId: string;
  readonly adapterVersion: number;
}

/** Inputs that can carry the source-side economic effect. */
export const SOURCE_EFFECT_KINDS: ReadonlySet<TransitionKind> = new Set(['source-accounted']);

/** Inputs that can carry the destination-side economic effect. */
export const DESTINATION_EFFECT_KINDS: ReadonlySet<TransitionKind> = new Set([
  'execution-succeeded',
  'execution-retried',
]);

/**
 * Whether an input asserts that the application executed.
 *
 * `delivered` is absent, and that absence is the point: delivery is not
 * execution, and a product that reports one as the other is the dangerous bug
 * (docs/ARCHITECTURE.md 5).
 */
export const assertsExecution = (kind: TransitionKind): boolean =>
  kind === 'execution-succeeded' || kind === 'execution-retried';
