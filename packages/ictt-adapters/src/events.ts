import { keccak256Hex } from './fingerprint.js';

/**
 * Event and call codecs for the pinned ICTT and Teleporter sources.
 *
 * Every signature below is copied from the source at the pinned commit
 * (icm-services @ 8fef6ef73767f4497a72d8348a0774a262e0c535):
 *
 *   ictt/interfaces/ITokenTransferrer.sol   TokensSent, TokensAndCallSent
 *   ictt/TokenHome/interfaces/ITokenHome.sol TokensRouted, TokensAndCallRouted,
 *                                           CollateralAdded, RemoteRegistered
 *   teleporter/ITeleporterMessenger.sol     ReceiveCrossChainMessage,
 *                                           MessageExecuted, MessageExecutionFailed
 *   ictt/interfaces/ITokenTransferrer.sol   TransferrerMessage, SingleHopSendMessage
 *
 * Decoding is strict on purpose. A log whose length, offsets or padding do not
 * match the pinned layout is refused with a typed error, never read as the
 * nearest plausible value: a mis-decoded amount is indistinguishable from a
 * real one once it reaches arithmetic. Recognising a contract is not this
 * module's job - an event signature says nothing about who emitted it - so
 * callers decode only logs from fingerprint-approved addresses.
 */

export class AbiDecodeError extends Error {
  override readonly name = 'AbiDecodeError';
}

const SEND_TOKENS_INPUT = '(bytes32,address,address,address,uint256,uint256,uint256,address)';
const SEND_AND_CALL_INPUT =
  '(bytes32,address,address,bytes,uint256,uint256,address,address,address,uint256,uint256)';
const TELEPORTER_MESSAGE =
  '(uint256,address,bytes32,address,uint256,address[],(uint256,address)[],bytes)';

export const EVENT_SIGNATURES = {
  tokensSent: `TokensSent(bytes32,address,${SEND_TOKENS_INPUT},uint256)`,
  tokensAndCallSent: `TokensAndCallSent(bytes32,address,${SEND_AND_CALL_INPUT},uint256)`,
  tokensRouted: `TokensRouted(bytes32,${SEND_TOKENS_INPUT},uint256)`,
  tokensAndCallRouted: `TokensAndCallRouted(bytes32,${SEND_AND_CALL_INPUT},uint256)`,
  collateralAdded: 'CollateralAdded(bytes32,address,uint256,uint256)',
  remoteRegistered: 'RemoteRegistered(bytes32,address,uint256,uint8)',
  receiveCrossChainMessage: `ReceiveCrossChainMessage(bytes32,bytes32,address,address,${TELEPORTER_MESSAGE})`,
  messageExecuted: 'MessageExecuted(bytes32,bytes32)',
  messageExecutionFailed: `MessageExecutionFailed(bytes32,bytes32,${TELEPORTER_MESSAGE})`,
} as const;

export type EventName = keyof typeof EVENT_SIGNATURES;

const hash = (text: string): string => keccak256Hex(new TextEncoder().encode(text));

export const EVENT_TOPICS: Readonly<Record<EventName, string>> = Object.fromEntries(
  Object.entries(EVENT_SIGNATURES).map(([name, signature]) => [name, hash(signature)]),
) as Record<EventName, string>;

/** `TransferrerMessageType`, in declaration order. */
export const TRANSFERRER_MESSAGE_TYPES = [
  'REGISTER_REMOTE',
  'SINGLE_HOP_SEND',
  'SINGLE_HOP_CALL',
  'MULTI_HOP_SEND',
  'MULTI_HOP_CALL',
] as const;
export type TransferrerMessageType = (typeof TRANSFERRER_MESSAGE_TYPES)[number];

/** A log as `eth_getLogs` returns it, already shape-checked by the caller. */
export interface EventLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

// ------------------------------------------------------------- word reading

const body = (data: string): string => {
  if (!/^0x([0-9a-f]{2})*$/.test(data)) throw new AbiDecodeError('data is not lowercase hex');
  return data.slice(2);
};

const wordAt = (hex: string, index: number): string => {
  const w = hex.slice(index * 64, index * 64 + 64);
  if (w.length !== 64) throw new AbiDecodeError('read past the end of the data');
  return w;
};

const uint = (w: string): bigint => BigInt(`0x${w}`);

const address = (w: string): string => {
  if (!w.startsWith('0'.repeat(24))) throw new AbiDecodeError('address word is not zero-padded');
  return `0x${w.slice(24)}`;
};

const bytes32 = (w: string): string => `0x${w}`;

/** An offset or length that must fit inside `limit` bytes and be word-aligned when asked. */
const position = (w: string, limit: number, aligned: boolean): number => {
  const value = uint(w);
  if (value > BigInt(limit)) throw new AbiDecodeError('offset or length out of bounds');
  const n = Number(value);
  if (aligned && n % 32 !== 0) throw new AbiDecodeError('offset is not word-aligned');
  return n;
};

const words = (hex: string): number => hex.length / 64;

const exactWords = (hex: string, n: number): void => {
  if (hex.length !== n * 64) throw new AbiDecodeError(`expected exactly ${String(n)} data words`);
};

const expectTopics = (log: EventLog, name: EventName, count: number): void => {
  if (log.topics.length !== count) throw new AbiDecodeError(`${name}: wrong topic count`);
  if (log.topics[0] !== EVENT_TOPICS[name]) throw new AbiDecodeError(`${name}: wrong topic0`);
  for (const t of log.topics) {
    if (!/^0x[0-9a-f]{64}$/.test(t)) throw new AbiDecodeError(`${name}: malformed topic`);
  }
};

const topic = (log: EventLog, i: number): string => {
  const t = log.topics[i];
  if (t === undefined) throw new AbiDecodeError('missing topic');
  return t;
};

/** A `bytes` value whose length word sits at byte offset `at` of `hex`. */
const dynamicBytes = (hex: string, at: number): string => {
  if (at % 32 !== 0) throw new AbiDecodeError('bytes offset is not word-aligned');
  const start = at / 32;
  const length = position(wordAt(hex, start), hex.length / 2, false);
  const from = (start + 1) * 64;
  const to = from + length * 2;
  if (to > hex.length) throw new AbiDecodeError('bytes run past the end of the data');
  // Solidity pads to a whole word; anything after the value must be zero.
  const padded = from + Math.ceil(length / 32) * 64;
  if (padded > hex.length || !/^0*$/.test(hex.slice(to, padded))) {
    throw new AbiDecodeError('bytes padding is not zero');
  }
  return hex.slice(from, to);
};

// --------------------------------------------------------------- ICTT events

/** `SendTokensInput` fields the accounting depends on. */
export interface SendTokensDestination {
  readonly destinationBlockchainId: string;
  readonly destinationTokenTransferrerAddress: string;
}

export interface TokensSentEvent extends SendTokensDestination {
  readonly messageId: string;
  readonly sender: string;
  readonly recipient: string;
  readonly multiHopFallback: string;
  /** Remote-denominated on TokenHome (`adjustedAmount`), burned amount on TokenRemote. */
  readonly amount: bigint;
}

/** `TokensSent(bytes32 indexed, address indexed, SendTokensInput, uint256)`. Fully static. */
export const decodeTokensSent = (log: EventLog): TokensSentEvent => {
  expectTopics(log, 'tokensSent', 3);
  const hex = body(log.data);
  exactWords(hex, 9);
  return {
    messageId: topic(log, 1),
    sender: address(topic(log, 2).slice(2)),
    destinationBlockchainId: bytes32(wordAt(hex, 0)),
    destinationTokenTransferrerAddress: address(wordAt(hex, 1)),
    recipient: address(wordAt(hex, 2)),
    multiHopFallback: address(wordAt(hex, 7)),
    amount: uint(wordAt(hex, 8)),
  };
};

export interface TokensRoutedEvent extends SendTokensDestination {
  readonly messageId: string;
  readonly amount: bigint;
}

/** `TokensRouted(bytes32 indexed, SendTokensInput, uint256)`. Fully static. */
export const decodeTokensRouted = (log: EventLog): TokensRoutedEvent => {
  expectTopics(log, 'tokensRouted', 2);
  const hex = body(log.data);
  exactWords(hex, 9);
  return {
    messageId: topic(log, 1),
    destinationBlockchainId: bytes32(wordAt(hex, 0)),
    destinationTokenTransferrerAddress: address(wordAt(hex, 1)),
    amount: uint(wordAt(hex, 8)),
  };
};

/**
 * `TokensAndCallSent` / `TokensAndCallRouted`: only the destination and amount.
 *
 * Send-and-call is not modelled economically; it is decoded far enough to know
 * which route it touched, so that route can be reported unsupported.
 */
export const decodeTokensAndCall = (
  log: EventLog,
  name: 'tokensAndCallSent' | 'tokensAndCallRouted',
): TokensRoutedEvent => {
  expectTopics(log, name, name === 'tokensAndCallSent' ? 3 : 2);
  const hex = body(log.data);
  if (words(hex) < 2) throw new AbiDecodeError(`${name}: data too short`);
  const tuple = position(wordAt(hex, 0), hex.length / 2, true) / 32;
  return {
    messageId: topic(log, 1),
    destinationBlockchainId: bytes32(wordAt(hex, tuple)),
    destinationTokenTransferrerAddress: address(wordAt(hex, tuple + 1)),
    amount: uint(wordAt(hex, 1)),
  };
};

export interface RemoteRegisteredEvent {
  readonly remoteBlockchainId: string;
  readonly remoteTokenTransferrerAddress: string;
  readonly initialCollateralNeeded: bigint;
  readonly tokenDecimals: number;
}

export const decodeRemoteRegistered = (log: EventLog): RemoteRegisteredEvent => {
  expectTopics(log, 'remoteRegistered', 3);
  const hex = body(log.data);
  exactWords(hex, 2);
  const decimals = uint(wordAt(hex, 1));
  if (decimals > 255n) throw new AbiDecodeError('remoteRegistered: decimals exceed uint8');
  return {
    remoteBlockchainId: topic(log, 1),
    remoteTokenTransferrerAddress: address(topic(log, 2).slice(2)),
    initialCollateralNeeded: uint(wordAt(hex, 0)),
    tokenDecimals: Number(decimals),
  };
};

export interface CollateralAddedEvent {
  readonly remoteBlockchainId: string;
  readonly remoteTokenTransferrerAddress: string;
  readonly amount: bigint;
  readonly remaining: bigint;
}

export const decodeCollateralAdded = (log: EventLog): CollateralAddedEvent => {
  expectTopics(log, 'collateralAdded', 3);
  const hex = body(log.data);
  exactWords(hex, 2);
  return {
    remoteBlockchainId: topic(log, 1),
    remoteTokenTransferrerAddress: address(topic(log, 2).slice(2)),
    amount: uint(wordAt(hex, 0)),
    remaining: uint(wordAt(hex, 1)),
  };
};

// --------------------------------------------------------- Teleporter events

export interface ReceivedMessage {
  readonly messageId: string;
  readonly sourceBlockchainId: string;
  readonly originSenderAddress: string;
  readonly destinationBlockchainId: string;
  readonly destinationAddress: string;
  /** The application payload, undecoded. */
  readonly message: string;
}

/**
 * `ReceiveCrossChainMessage(bytes32 indexed messageID, bytes32 indexed
 * sourceBlockchainID, address indexed deliverer, address rewardRedeemer,
 * TeleporterMessage message)`.
 *
 * Delivery only. Execution is a separate event (`MessageExecuted`), and a
 * delivered message may still have failed to execute.
 */
export const decodeReceiveCrossChainMessage = (log: EventLog): ReceivedMessage => {
  expectTopics(log, 'receiveCrossChainMessage', 4);
  const hex = body(log.data);
  address(wordAt(hex, 0)); // rewardRedeemer, validated and not used
  const tuple = position(wordAt(hex, 1), hex.length / 2, true);
  const at = tuple / 32;
  const struct = hex.slice(tuple * 2);
  // Head: nonce, origin, destination chain, destination, gas, three offsets.
  if (words(struct) < 8) throw new AbiDecodeError('receiveCrossChainMessage: struct too short');
  const limit = struct.length / 2;
  position(wordAt(struct, 5), limit, true);
  position(wordAt(struct, 6), limit, true);
  const messageAt = position(wordAt(struct, 7), limit, true);
  return {
    messageId: topic(log, 1),
    sourceBlockchainId: topic(log, 2),
    originSenderAddress: address(wordAt(hex, at + 1)),
    destinationBlockchainId: bytes32(wordAt(hex, at + 2)),
    destinationAddress: address(wordAt(hex, at + 3)),
    message: `0x${dynamicBytes(struct, messageAt)}`,
  };
};

export interface MessageOutcomeEvent {
  readonly messageId: string;
  readonly sourceBlockchainId: string;
}

/** `MessageExecuted(bytes32 indexed, bytes32 indexed)`: the application call succeeded. */
export const decodeMessageExecuted = (log: EventLog): MessageOutcomeEvent => {
  expectTopics(log, 'messageExecuted', 3);
  exactWords(body(log.data), 0);
  return { messageId: topic(log, 1), sourceBlockchainId: topic(log, 2) };
};

/** `MessageExecutionFailed`: delivered, but the application call reverted. */
export const decodeMessageExecutionFailed = (log: EventLog): MessageOutcomeEvent => {
  expectTopics(log, 'messageExecutionFailed', 3);
  body(log.data);
  return { messageId: topic(log, 1), sourceBlockchainId: topic(log, 2) };
};

// ------------------------------------------------------- ICTT message payload

export interface TransferrerPayload {
  readonly messageType: TransferrerMessageType;
  /** Present for SINGLE_HOP_SEND only: the remote-denominated amount and recipient. */
  readonly singleHopSend: { readonly recipient: string; readonly amount: bigint } | null;
}

/**
 * `abi.decode(message, (TransferrerMessage))`, and the single-hop payload.
 *
 * TransferrerMessage is a dynamic struct `(uint8 messageType, bytes payload)`;
 * SingleHopSendMessage is the static `(address recipient, uint256 amount)`.
 * Other message types are classified but not interpreted.
 */
export const decodeTransferrerMessage = (message: string): TransferrerPayload => {
  const hex = body(message);
  if (words(hex) < 4) throw new AbiDecodeError('transferrer message too short');
  const tuple = position(wordAt(hex, 0), hex.length / 2, true);
  const struct = hex.slice(tuple * 2);
  const typeIndex = uint(wordAt(struct, 0));
  const messageType = TRANSFERRER_MESSAGE_TYPES[Number(typeIndex)];
  if (typeIndex > 4n || messageType === undefined) {
    throw new AbiDecodeError('unknown transferrer message type');
  }
  const payload = dynamicBytes(struct, position(wordAt(struct, 1), struct.length / 2, true));
  if (messageType !== 'SINGLE_HOP_SEND') return { messageType, singleHopSend: null };
  exactWords(payload, 2);
  return {
    messageType,
    singleHopSend: { recipient: address(wordAt(payload, 0)), amount: uint(wordAt(payload, 1)) },
  };
};

// -------------------------------------------------------------------- calls

const selector = (signature: string): string => hash(signature).slice(0, 10);

const encodeAddress = (value: string): string => {
  if (!/^0x[0-9a-f]{40}$/.test(value)) throw new AbiDecodeError('address must be lowercase hex');
  return value.slice(2).padStart(64, '0');
};

const encodeBytes32 = (value: string): string => {
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new AbiDecodeError('bytes32 must be lowercase hex');
  return value.slice(2);
};

/** Calldata for the pinned read-only getters this product uses. */
export const CALLS = {
  /** TokenHome.getTransferredBalance(bytes32,address) -> uint256 */
  getTransferredBalance: (remoteBlockchainId: string, remoteAddress: string): string =>
    `${selector('getTransferredBalance(bytes32,address)')}${encodeBytes32(remoteBlockchainId)}${encodeAddress(remoteAddress)}`,
  /** TokenHome.getRemoteTokenTransferrerSettings(bytes32,address) -> (bool,uint256,uint256,bool) */
  getRemoteTokenTransferrerSettings: (remoteBlockchainId: string, remoteAddress: string): string =>
    `${selector('getRemoteTokenTransferrerSettings(bytes32,address)')}${encodeBytes32(remoteBlockchainId)}${encodeAddress(remoteAddress)}`,
  /** TokenHome.getTokenAddress() -> address */
  getTokenAddress: (): string => selector('getTokenAddress()'),
  /** IERC20.totalSupply() -> uint256 */
  totalSupply: (): string => selector('totalSupply()'),
  /** IERC20.balanceOf(address) -> uint256 */
  balanceOf: (holder: string): string =>
    `${selector('balanceOf(address)')}${encodeAddress(holder)}`,
  /** TokenRemote.getInitialReserveImbalance() -> uint256 */
  getInitialReserveImbalance: (): string => selector('getInitialReserveImbalance()'),
  /** TokenRemote.getTokenHomeBlockchainID() -> bytes32 */
  getTokenHomeBlockchainID: (): string => selector('getTokenHomeBlockchainID()'),
  /** TeleporterRegistry.getVersionFromAddress(address) -> uint256 */
  getVersionFromAddress: (messenger: string): string =>
    `${selector('getVersionFromAddress(address)')}${encodeAddress(messenger)}`,
  /** TokenRemote.getTokenHomeAddress() -> address */
  getTokenHomeAddress: (): string => selector('getTokenHomeAddress()'),
} as const;

/** A single-word return value. */
export const decodeUintResult = (result: string): bigint => {
  const hex = body(result);
  exactWords(hex, 1);
  return uint(wordAt(hex, 0));
};

export const decodeAddressResult = (result: string): string => {
  const hex = body(result);
  exactWords(hex, 1);
  return address(wordAt(hex, 0));
};

export const decodeBytes32Result = (result: string): string => {
  const hex = body(result);
  exactWords(hex, 1);
  return bytes32(wordAt(hex, 0));
};

const bool = (w: string): boolean => {
  if (w === '0'.repeat(64)) return false;
  if (w === `${'0'.repeat(63)}1`) return true;
  throw new AbiDecodeError('bool word is neither 0 nor 1');
};

export interface RemoteSettingsResult {
  readonly registered: boolean;
  readonly collateralNeeded: bigint;
  readonly tokenMultiplier: bigint;
  readonly multiplyOnRemote: boolean;
}

/** `RemoteTokenTransferrerSettings` is a static struct, returned as four words. */
export const decodeRemoteSettingsResult = (result: string): RemoteSettingsResult => {
  const hex = body(result);
  exactWords(hex, 4);
  return {
    registered: bool(wordAt(hex, 0)),
    collateralNeeded: uint(wordAt(hex, 1)),
    tokenMultiplier: uint(wordAt(hex, 2)),
    multiplyOnRemote: bool(wordAt(hex, 3)),
  };
};
