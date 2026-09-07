import type {
  FactPosition,
  MessageKey,
  RawFactRef,
  TransitionInput,
} from '@ictt-sentinel/state-machine';

/**
 * Deterministic message-lifecycle fixtures.
 *
 * One corpus, shared by the pure unit tests and the PostgreSQL integration
 * tests, so both are asserting against the same scenarios rather than two
 * hand-written approximations that can drift apart.
 *
 * Nothing here reads a clock or a random source: every id, hash and timestamp is
 * derived from its inputs.
 */

export const HOME_CHAIN = `0x${'11'.repeat(32)}`;
export const REMOTE_CHAIN = `0x${'22'.repeat(32)}`;
export const OTHER_CHAIN = `0x${'33'.repeat(32)}`;
export const MESSENGER = `0x${'ab'.repeat(20)}`;
export const OTHER_MESSENGER = `0x${'cd'.repeat(20)}`;

export const HOME_EVM_CHAIN_ID = 43114n;
export const REMOTE_EVM_CHAIN_ID = 43113n;

export const ADAPTER = { adapterId: 'teleporter@pinned', adapterVersion: 1 } as const;

export const AT = (offsetSeconds: number): Date =>
  new Date(Date.UTC(2026, 5, 1, 0, 0, 0) + offsetSeconds * 1000);

export const hex32 = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;

/** The default route. Every component participates in the key. */
export const messageKey = (over: Partial<MessageKey> = {}): MessageKey => ({
  sourceBlockchainId: HOME_CHAIN,
  destinationBlockchainId: REMOTE_CHAIN,
  teleporterMessengerAddress: MESSENGER,
  registryProtocolVersion: 1,
  messageId: hex32(0xabc),
  ...over,
});

export const position = (
  blockchainId: string,
  blockNumber: number,
  over: Partial<FactPosition> = {},
): FactPosition => ({
  blockchainId,
  blockNumber: BigInt(blockNumber),
  blockHash: hex32(blockNumber),
  ...over,
});

export const fact = (
  evmChainId: bigint,
  blockNumber: number,
  txIndex: number,
  logIndex: number,
): RawFactRef => ({
  evmChainId,
  blockHash: hex32(blockNumber),
  txHash: hex32(500_000 + blockNumber * 100 + txIndex),
  logIndex,
});

export interface InputOptions {
  readonly message?: MessageKey;
  readonly onSource?: boolean;
  readonly blockNumber?: number;
  readonly txIndex?: number;
  readonly logIndex?: number;
  readonly envelopeId?: string;
  readonly carriesEconomicEffect?: boolean;
  readonly unsupportedReason?: string;
  readonly observedAtSeconds?: number;
}

/**
 * Build one transition input.
 *
 * `onSource` picks which chain the fact sits on, which is what the causal
 * watermark reasons over; getting it wrong is the mistake the fixture exists to
 * make hard.
 */
export const input = (kind: TransitionInput['kind'], o: InputOptions = {}): TransitionInput => {
  const message = o.message ?? messageKey();
  const onSource = o.onSource ?? isSourceSide(kind);
  const chain = onSource ? message.sourceBlockchainId : message.destinationBlockchainId;
  const evm = onSource ? HOME_EVM_CHAIN_ID : REMOTE_EVM_CHAIN_ID;
  const blockNumber = o.blockNumber ?? (onSource ? 100 : 200);
  const txIndex = o.txIndex ?? 0;
  const logIndex = o.logIndex ?? 0;

  return {
    kind,
    message,
    fact: fact(evm, blockNumber, txIndex, logIndex),
    position: position(chain, blockNumber),
    ...(o.envelopeId === undefined ? {} : { envelopeId: o.envelopeId }),
    ...(o.carriesEconomicEffect === undefined
      ? {}
      : { carriesEconomicEffect: o.carriesEconomicEffect }),
    ...(o.unsupportedReason === undefined ? {} : { unsupportedReason: o.unsupportedReason }),
    ...(o.observedAtSeconds === undefined ? {} : { observedAt: AT(o.observedAtSeconds) }),
    ...ADAPTER,
  };
};

/** Which side of the route a kind is normally observed on. */
const isSourceSide = (kind: TransitionInput['kind']): boolean =>
  kind === 'source-application-emitted' ||
  kind === 'intent-observed' ||
  kind === 'source-accounted' ||
  kind === 'icm-sent' ||
  kind === 'send-retry' ||
  kind === 'envelope-resigned' ||
  kind === 'receipt-observed';

// ------------------------------------------------------------------ scenarios

/** The happy path: accounted at source, sent, delivered, executed. */
export const happyPath = (message = messageKey()): readonly TransitionInput[] => [
  input('source-application-emitted', { message, blockNumber: 100, logIndex: 0 }),
  input('intent-observed', { message, blockNumber: 100, logIndex: 1 }),
  input('source-accounted', { message, blockNumber: 100, logIndex: 2 }),
  input('icm-sent', { message, blockNumber: 100, logIndex: 3, envelopeId: 'env-1' }),
  input('delivered', { message, blockNumber: 200, logIndex: 0 }),
  input('execution-succeeded', { message, blockNumber: 200, logIndex: 1 }),
];

/** Delivered, and the application call reverted. Never a healthy close. */
export const deliveredButFailed = (message = messageKey()): readonly TransitionInput[] => [
  input('source-accounted', { message, blockNumber: 100, logIndex: 2 }),
  input('icm-sent', { message, blockNumber: 100, logIndex: 3, envelopeId: 'env-1' }),
  input('delivered', { message, blockNumber: 200, logIndex: 0 }),
  input('execution-failed', { message, blockNumber: 200, logIndex: 1 }),
];

/** Failure, then a retry that succeeded. One economic effect, not two. */
export const failedThenRetried = (message = messageKey()): readonly TransitionInput[] => [
  ...deliveredButFailed(message),
  input('execution-retried', { message, blockNumber: 210, logIndex: 0 }),
];

/**
 * `retrySendCrossChainMessage`: a second SEND attempt for the same message id.
 * Two attempts, one intent, one effect.
 */
export const sendRetried = (message = messageKey()): readonly TransitionInput[] => [
  input('source-accounted', { message, blockNumber: 100, logIndex: 2 }),
  input('icm-sent', { message, blockNumber: 100, logIndex: 3, envelopeId: 'env-1' }),
  input('send-retry', { message, blockNumber: 105, logIndex: 0, envelopeId: 'env-1' }),
  input('delivered', { message, blockNumber: 200, logIndex: 0 }),
  input('execution-succeeded', { message, blockNumber: 200, logIndex: 1 }),
];

/**
 * Validator-set change forces a re-sign: a NEW ICM envelope carrying the SAME
 * application lineage. Two envelopes, one message, one effect.
 */
export const envelopeResigned = (message = messageKey()): readonly TransitionInput[] => [
  input('source-accounted', { message, blockNumber: 100, logIndex: 2 }),
  input('icm-sent', { message, blockNumber: 100, logIndex: 3, envelopeId: 'env-1' }),
  input('envelope-resigned', { message, blockNumber: 106, logIndex: 0, envelopeId: 'env-2' }),
  input('delivered', { message, blockNumber: 200, logIndex: 0 }),
  input('execution-succeeded', { message, blockNumber: 200, logIndex: 1 }),
];

/** A receipt and nothing else. Liveness, not an economic transfer. */
export const receiptOnly = (message = messageKey()): readonly TransitionInput[] => [
  input('receipt-observed', { message, blockNumber: 120, carriesEconomicEffect: false }),
];

/** Empty payload: the message moved, no value did. */
export const emptyPayload = (message = messageKey()): readonly TransitionInput[] => [
  input('source-accounted', {
    message,
    blockNumber: 100,
    logIndex: 2,
    carriesEconomicEffect: false,
  }),
  input('icm-sent', { message, blockNumber: 100, logIndex: 3 }),
  input('delivered', { message, blockNumber: 200, logIndex: 0 }),
  input('execution-succeeded', {
    message,
    blockNumber: 200,
    logIndex: 1,
    carriesEconomicEffect: false,
  }),
];

/** Two DISTINCT successful executions for one message. An accounting breach. */
export const doubleEffect = (message = messageKey()): readonly TransitionInput[] => [
  ...happyPath(message),
  input('execution-succeeded', { message, blockNumber: 220, logIndex: 0 }),
];

/** A multi-hop route, which this build refuses to flatten into one hop. */
export const multiHop = (message = messageKey()): readonly TransitionInput[] => [
  input('source-accounted', { message, blockNumber: 100, logIndex: 2 }),
  input('unsupported', {
    message,
    blockNumber: 100,
    logIndex: 4,
    unsupportedReason: 'multi-hop',
  }),
];

/** All permutations of a fixture, for order-independence checks. */
export const permutations = <T>(items: readonly T[]): readonly (readonly T[])[] => {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  items.forEach((item, i) => {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
};
