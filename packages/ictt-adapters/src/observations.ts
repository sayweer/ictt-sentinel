/**
 * Semantic observations.
 *
 * An adapter never hands back a raw ABI result. A decoded tuple carries no
 * meaning about which chain it came from, which contract produced it, or which
 * adapter epoch interpreted it, and that context is exactly what a cross-chain
 * verdict rests on. Every observation below is branded with its provenance.
 *
 * Decoding itself belongs to the RPC milestone; these are the types that
 * decoding must produce.
 */

declare const OBSERVATION: unique symbol;
type Observed<T, B extends string> = T & { readonly [OBSERVATION]: B };

/** Where an observation came from. Pinned, so it can be reproduced. */
export interface ObservationSource {
  /** Avalanche ICM chain identity, not an EVM chainId. */
  readonly blockchainId: string;
  readonly contractAddress: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly txHash: string;
  readonly txIndex: number;
  readonly logIndex: number;
  /** Adapter that decoded it, so a later reader knows what the bytes meant. */
  readonly adapterId: string;
  readonly adapterVersion: number;
}

interface WithSource {
  readonly source: ObservationSource;
}

// ---------------------------------------------------------------- ICTT: home

/**
 * `RemoteRegistered(bytes32 indexed, address indexed, uint256, uint8)`
 *
 * Registration is permissionless. Seeing this event establishes that a remote
 * asked to be registered, never that the operator trusts it
 * (docs/PRODUCT.md section 6).
 */
export interface RemoteRegisteredObservation extends WithSource {
  readonly kind: 'ictt.remote-registered';
  readonly remoteBlockchainId: string;
  readonly remoteTokenTransferrerAddress: string;
  readonly collateralNeeded: bigint;
  readonly remoteTokenDecimals: number;
}

/** `CollateralAdded(bytes32 indexed, address indexed, uint256, uint256)` */
export interface CollateralAddedObservation extends WithSource {
  readonly kind: 'ictt.collateral-added';
  readonly remoteBlockchainId: string;
  readonly remoteTokenTransferrerAddress: string;
  /** Amount credited as collateral, after excess was refunded. */
  readonly amount: bigint;
  readonly remainingCollateralNeeded: bigint;
}

/**
 * `getTransferredBalance(bytes32, address)`
 *
 * Kept apart from collateral on purpose: `_addCollateral` in the pinned source
 * never touches `_transferredBalances`, so adding the two without a
 * version-aware adapter double counts.
 */
export interface TransferredBalanceObservation {
  readonly kind: 'ictt.transferred-balance';
  readonly source: Omit<ObservationSource, 'txHash' | 'txIndex' | 'logIndex'>;
  readonly remoteBlockchainId: string;
  readonly remoteTokenTransferrerAddress: string;
  readonly transferredBalance: bigint;
}

/** `RemoteTokenTransferrerSettings` as read from home storage. */
export interface RemoteSettingsObservation {
  readonly kind: 'ictt.remote-settings';
  readonly source: Omit<ObservationSource, 'txHash' | 'txIndex' | 'logIndex'>;
  readonly remoteBlockchainId: string;
  readonly remoteTokenTransferrerAddress: string;
  readonly registered: boolean;
  readonly collateralNeeded: bigint;
  readonly tokenMultiplier: bigint;
  readonly multiplyOnRemote: boolean;
}

// -------------------------------------------------------------- ICTT: remote

/**
 * Native reported supply.
 *
 * The contract computes `(_totalMinted + initialReserveImbalance) - burned`,
 * where `burned` is the live balance of two known burn addresses. It is an
 * accounting reconstruction, not a measurement, so the type says so and carries
 * the assumption its bound depends on.
 */
export interface NativeReportedSupplyObservation {
  readonly kind: 'ictt.native-reported-supply';
  readonly source: Omit<ObservationSource, 'txHash' | 'txIndex' | 'logIndex'>;
  readonly reportedSupply: bigint;
  /**
   * The reported value bounds real circulating supply from above only while
   * this contract is the sole minter. Minter exclusivity is checked separately
   * (CFG-006); until it holds, the bound is not established.
   */
  readonly upperBoundRequiresMinterExclusivity: true;
}

/** `isCollateralized()` on a remote. */
export interface RemoteCollateralizedObservation {
  readonly kind: 'ictt.remote-collateralized';
  readonly source: Omit<ObservationSource, 'txHash' | 'txIndex' | 'logIndex'>;
  readonly isCollateralized: boolean;
  readonly initialReserveImbalance: bigint;
}

// ------------------------------------------------------------ Teleporter

/**
 * Message lifecycle observations.
 *
 * Delivery and execution are separate events on chain and stay separate here.
 * Collapsing them is the dangerous product bug: a message can be delivered and
 * still fail to execute (docs/ARCHITECTURE.md section 5).
 */
export interface MessageSentObservation extends WithSource {
  readonly kind: 'teleporter.message-sent';
  readonly messageId: string;
  readonly destinationBlockchainId: string;
  readonly destinationAddress: string;
}

export interface MessageReceivedObservation extends WithSource {
  readonly kind: 'teleporter.message-received';
  readonly messageId: string;
  readonly sourceBlockchainId: string;
  readonly deliverer: string;
}

/** Application executed successfully. Distinct from delivery. */
export interface MessageExecutedObservation extends WithSource {
  readonly kind: 'teleporter.message-executed';
  readonly messageId: string;
  readonly sourceBlockchainId: string;
}

/** Delivered, but the application call reverted. Never a healthy close. */
export interface MessageExecutionFailedObservation extends WithSource {
  readonly kind: 'teleporter.message-execution-failed';
  readonly messageId: string;
  readonly sourceBlockchainId: string;
}

export interface ReceiptObservation extends WithSource {
  readonly kind: 'teleporter.receipt';
  readonly messageId: string;
  readonly destinationBlockchainId: string;
  readonly relayerRewardAddress: string;
}

export type TeleporterObservation =
  | MessageSentObservation
  | MessageReceivedObservation
  | MessageExecutedObservation
  | MessageExecutionFailedObservation
  | ReceiptObservation;

export type IcttObservation =
  | RemoteRegisteredObservation
  | CollateralAddedObservation
  | TransferredBalanceObservation
  | RemoteSettingsObservation
  | NativeReportedSupplyObservation
  | RemoteCollateralizedObservation;

export type Observation = IcttObservation | TeleporterObservation;

/**
 * Delivery does not imply execution.
 *
 * Exported as a function so the rule is testable rather than a comment: a
 * `message-received` observation can never be read as a successful execution.
 */
export const impliesSuccessfulExecution = (o: Observation): boolean =>
  o.kind === 'teleporter.message-executed';

/** Transfers that this build does not flatten into a single hop. */
export const UNSUPPORTED_TRANSFER_SHAPES = [
  'multi-hop',
  'remote-to-remote',
  'send-and-call',
] as const;
export type UnsupportedTransferShape = (typeof UNSUPPORTED_TRANSFER_SHAPES)[number];

/**
 * A multi-hop transfer routes through home and a send-and-call carries an
 * application payload. Modelling either as a single hop would invent a causal
 * link that the chain never made, so they resolve to UNKNOWN instead.
 */
export const transferShapeSupport = (
  shape: UnsupportedTransferShape | 'single-hop',
): 'supported' | 'unknown' => (shape === 'single-hop' ? 'supported' : 'unknown');

export type { Observed };
