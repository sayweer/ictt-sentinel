/**
 * Identity for messages and for the raw facts they are derived from.
 *
 * Two different identities, deliberately not one:
 *
 *   MessageKey  - the semantic message. `messageID` alone is NOT it: the same
 *                 id can legitimately recur under a different messenger or a
 *                 different registry protocol version, and collapsing those
 *                 merges two unrelated messages into one accounting story.
 *
 *   RawFactRef  - the on-chain log the fact came from. `blockNumber` is absent
 *                 on purpose; after a reorg the same height carries another
 *                 block, so the hash is the identity (docs/DATA_MODEL.md 2.1).
 */

export interface MessageKey {
  readonly sourceBlockchainId: string;
  readonly destinationBlockchainId: string;
  /** Chain-local. Never assume one messenger maps to one registry version. */
  readonly teleporterMessengerAddress: string;
  readonly registryProtocolVersion: number;
  readonly messageId: string;
}

/**
 * Where a fact sits on its chain.
 *
 * Kept apart from `RawFactRef`: that one is identity (and therefore carries no
 * height), this one is position (and therefore must carry both height and hash).
 */
export interface FactPosition {
  /** Avalanche ICM chain identity. Never an EVM chainId. */
  readonly blockchainId: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
}

export interface RawFactRef {
  /** EVM chainId, a separate identity space from the ICM blockchainId. */
  readonly evmChainId: bigint;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
}

const SEP = '|';

/**
 * Canonical serialisation of a message key.
 *
 * All five components participate. A key built from `messageId` alone would let
 * two messages on different routes share one aggregate, and the first thing that
 * breaks is the "at most one economic effect" rule.
 */
export const messageKeyOf = (k: MessageKey): string =>
  [
    k.sourceBlockchainId,
    k.destinationBlockchainId,
    k.teleporterMessengerAddress,
    String(k.registryProtocolVersion),
    k.messageId,
  ].join(SEP);

export const rawFactRefOf = (r: RawFactRef): string =>
  [r.evmChainId.toString(10), r.blockHash, r.txHash, String(r.logIndex)].join(SEP);

export const sameMessage = (a: MessageKey, b: MessageKey): boolean =>
  messageKeyOf(a) === messageKeyOf(b);

export const sameRawFact = (a: RawFactRef, b: RawFactRef): boolean =>
  rawFactRefOf(a) === rawFactRefOf(b);

/** Transaction identity, for reducing a whole transaction atomically. */
export const transactionKeyOf = (r: RawFactRef): string =>
  [r.evmChainId.toString(10), r.blockHash, r.txHash].join(SEP);
