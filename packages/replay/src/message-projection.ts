import type { Observation, TeleporterObservation } from '@ictt-sentinel/ictt-adapters';
import type { MessageKey, TransitionInput, TransitionKind } from '@ictt-sentinel/state-machine';

/**
 * Adapter observations to semantic transition inputs.
 *
 * This is the only place the two vocabularies meet. The state machine is layer 0
 * and cannot see an adapter type; the adapter decodes bytes and has no opinion
 * about lifecycle. The translation lives here, in the layer that is allowed to
 * depend on both.
 *
 * Nothing in this file guesses an event name or recomputes a message id: it
 * consumes what the pinned adapter already decided the bytes meant
 * (docs/PROTOCOL_SOURCE_LOCK.md).
 */

export interface RouteContext {
  /**
   * EVM chainId for an ICM blockchainId. Two separate identity spaces
   * (docs/DATA_MODEL.md 2.4); this mapping is supplied, never derived.
   */
  evmChainIdOf(blockchainId: string): bigint;
  /**
   * The messenger address in force on a chain. Chain-local: the same route can
   * have different messenger addresses on its two sides.
   */
  messengerAddressOf(blockchainId: string): string;
  /**
   * Registry protocol version for a messenger ON THAT CHAIN.
   *
   * Chain-local by contract. A messenger address is NOT assumed to map one-to-one
   * onto a registry version, and a version is NEVER used to infer an ABI family:
   * family comes from the bytecode fingerprint alone
   * (docs/PROTOCOL_SOURCE_LOCK.md 4).
   */
  registryProtocolVersionOf(blockchainId: string, messengerAddress: string): number;
}

export type ProjectionOutcome =
  | { readonly ok: true; readonly input: TransitionInput }
  | { readonly ok: false; readonly reason: string; readonly observation: Observation };

const TELEPORTER_KINDS: Readonly<Record<TeleporterObservation['kind'], TransitionKind>> = {
  'teleporter.message-sent': 'icm-sent',
  // Received is DELIVERY. It is not execution, and there is no branch here that
  // could make it one (docs/ARCHITECTURE.md 5).
  'teleporter.message-received': 'delivered',
  'teleporter.message-executed': 'execution-succeeded',
  'teleporter.message-execution-failed': 'execution-failed',
  'teleporter.receipt': 'receipt-observed',
};

/**
 * The message key is anchored to the SOURCE chain's messenger and registry
 * version.
 *
 * A route has two messengers, one per chain, so a key built from "the messenger"
 * would be ambiguous. Anchoring on the source side makes the key identical
 * whichever side of the route observed the fact.
 */
const keyFor = (
  sourceBlockchainId: string,
  destinationBlockchainId: string,
  messageId: string,
  ctx: RouteContext,
): MessageKey => {
  const messengerAddress = ctx.messengerAddressOf(sourceBlockchainId);
  return {
    sourceBlockchainId,
    destinationBlockchainId,
    teleporterMessengerAddress: messengerAddress,
    registryProtocolVersion: ctx.registryProtocolVersionOf(sourceBlockchainId, messengerAddress),
    messageId,
  };
};

/**
 * Project one Teleporter observation.
 *
 * A receipt is marked as carrying no economic effect: it is a relayer liveness
 * signal, and letting one contribute an effect would credit a transfer that the
 * application never executed.
 */
export const projectTeleporter = (
  o: TeleporterObservation,
  ctx: RouteContext,
): ProjectionOutcome => {
  const kind = TELEPORTER_KINDS[o.kind];

  const [sourceBlockchainId, destinationBlockchainId] =
    o.kind === 'teleporter.message-sent'
      ? [o.source.blockchainId, o.destinationBlockchainId]
      : o.kind === 'teleporter.receipt'
        ? [o.source.blockchainId, o.destinationBlockchainId]
        : [o.sourceBlockchainId, o.source.blockchainId];

  const message = keyFor(sourceBlockchainId, destinationBlockchainId, o.messageId, ctx);

  return {
    ok: true,
    input: {
      kind,
      message,
      fact: {
        evmChainId: ctx.evmChainIdOf(o.source.blockchainId),
        blockHash: o.source.blockHash,
        txHash: o.source.txHash,
        logIndex: o.source.logIndex,
      },
      position: {
        blockchainId: o.source.blockchainId,
        blockNumber: o.source.blockNumber,
        blockHash: o.source.blockHash,
      },
      // Delivery, receipts and failures move no value on their own; only a
      // successful execution does, and only the ICTT effect confirms it.
      carriesEconomicEffect: kind === 'execution-succeeded',
      adapterId: o.source.adapterId,
      adapterVersion: o.source.adapterVersion,
    },
  };
};

/**
 * Project the home-side accounting fact for a message.
 *
 * Collateral and transferred balance are deliberately NOT summed here: the
 * pinned source never touches `_transferredBalances` in `_addCollateral`, so the
 * caller passes whichever one actually recorded this message's economic effect.
 */
export const projectSourceAccounting = (
  args: {
    readonly sourceBlockchainId: string;
    readonly destinationBlockchainId: string;
    readonly messageId: string;
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly txHash: string;
    readonly logIndex: number;
    readonly adapterId: string;
    readonly adapterVersion: number;
    /** False for an empty-payload or receipt-only message. */
    readonly carriesEconomicEffect: boolean;
  },
  ctx: RouteContext,
): TransitionInput => ({
  kind: 'source-accounted',
  message: keyFor(args.sourceBlockchainId, args.destinationBlockchainId, args.messageId, ctx),
  fact: {
    evmChainId: ctx.evmChainIdOf(args.sourceBlockchainId),
    blockHash: args.blockHash,
    txHash: args.txHash,
    logIndex: args.logIndex,
  },
  position: {
    blockchainId: args.sourceBlockchainId,
    blockNumber: args.blockNumber,
    blockHash: args.blockHash,
  },
  carriesEconomicEffect: args.carriesEconomicEffect,
  adapterId: args.adapterId,
  adapterVersion: args.adapterVersion,
});

/**
 * A transfer shape this build refuses to interpret.
 *
 * Multi-hop and send-and-call are NOT flattened into a single hop: doing so would
 * invent a causal link the chain never made. They become `unsupported`, which
 * derives to UNCLASSIFIABLE and therefore UNKNOWN
 * (docs/SUPPORT_MATRIX.md 1, 8).
 */
export const projectUnsupportedShape = (
  args: {
    readonly sourceBlockchainId: string;
    readonly destinationBlockchainId: string;
    readonly messageId: string;
    readonly blockNumber: bigint;
    readonly blockHash: string;
    readonly txHash: string;
    readonly logIndex: number;
    readonly adapterId: string;
    readonly adapterVersion: number;
    /**
     * The shape the adapter recognised as unsupported. Kept as a plain string so
     * an unrecognised fingerprint - which has no name in the enum yet - can still
     * be reported rather than forced into the nearest known value.
     */
    readonly shape: string;
  },
  ctx: RouteContext,
): TransitionInput => ({
  kind: 'unsupported',
  message: keyFor(args.sourceBlockchainId, args.destinationBlockchainId, args.messageId, ctx),
  fact: {
    evmChainId: ctx.evmChainIdOf(args.sourceBlockchainId),
    blockHash: args.blockHash,
    txHash: args.txHash,
    logIndex: args.logIndex,
  },
  position: {
    blockchainId: args.sourceBlockchainId,
    blockNumber: args.blockNumber,
    blockHash: args.blockHash,
  },
  carriesEconomicEffect: false,
  unsupportedReason: args.shape,
  adapterId: args.adapterId,
  adapterVersion: args.adapterVersion,
});

/** Project a batch, keeping unprojectable observations visible rather than dropped. */
export const projectObservations = (
  observations: readonly Observation[],
  ctx: RouteContext,
): {
  readonly inputs: readonly TransitionInput[];
  readonly skipped: readonly ProjectionOutcome[];
} => {
  const inputs: TransitionInput[] = [];
  const skipped: ProjectionOutcome[] = [];

  for (const o of observations) {
    if (o.kind.startsWith('teleporter.')) {
      const outcome = projectTeleporter(o as TeleporterObservation, ctx);
      if (outcome.ok) inputs.push(outcome.input);
      else skipped.push(outcome);
      continue;
    }
    // ICTT state reads and registration events are not message lifecycle facts.
    // Silently dropping them would be wrong, so they are reported as skipped.
    skipped.push({
      ok: false,
      reason: `not a message lifecycle observation: ${o.kind}`,
      observation: o,
    });
  }

  return { inputs, skipped };
};
