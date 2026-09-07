import { describe, expect, it } from 'vitest';
import type { ObservationSource, TeleporterObservation } from '@ictt-sentinel/ictt-adapters';
import {
  HOME_CHAIN,
  MESSENGER,
  OTHER_MESSENGER,
  REMOTE_CHAIN,
  hex32,
} from '@ictt-sentinel/testkit';
import { messageKeyOf } from '@ictt-sentinel/state-machine';
import {
  type RouteContext,
  projectObservations,
  projectSourceAccounting,
  projectTeleporter,
  projectUnsupportedShape,
} from '../src/message-projection.js';

const EVM: Readonly<Record<string, bigint>> = { [HOME_CHAIN]: 43114n, [REMOTE_CHAIN]: 43113n };

/** Registry mapping is chain-local: each side answers for itself. */
const ctx: RouteContext = {
  evmChainIdOf: (id) => EVM[id] ?? 0n,
  messengerAddressOf: (id) => (id === HOME_CHAIN ? MESSENGER : OTHER_MESSENGER),
  registryProtocolVersionOf: (id) => (id === HOME_CHAIN ? 1 : 7),
};

const source = (
  blockchainId: string,
  blockNumber: number,
  logIndex: number,
): ObservationSource => ({
  blockchainId,
  contractAddress: MESSENGER,
  blockNumber: BigInt(blockNumber),
  blockHash: hex32(blockNumber),
  txHash: hex32(700_000 + blockNumber),
  txIndex: 0,
  logIndex,
  adapterId: 'teleporter@pinned',
  adapterVersion: 1,
});

const MESSAGE_ID = hex32(0xabc);

const sent: TeleporterObservation = {
  kind: 'teleporter.message-sent',
  messageId: MESSAGE_ID,
  destinationBlockchainId: REMOTE_CHAIN,
  destinationAddress: `0x${'ee'.repeat(20)}`,
  source: source(HOME_CHAIN, 100, 3),
};

const received: TeleporterObservation = {
  kind: 'teleporter.message-received',
  messageId: MESSAGE_ID,
  sourceBlockchainId: HOME_CHAIN,
  deliverer: `0x${'dd'.repeat(20)}`,
  source: source(REMOTE_CHAIN, 200, 0),
};

const executed: TeleporterObservation = {
  kind: 'teleporter.message-executed',
  messageId: MESSAGE_ID,
  sourceBlockchainId: HOME_CHAIN,
  source: source(REMOTE_CHAIN, 200, 1),
};

const failed: TeleporterObservation = {
  kind: 'teleporter.message-execution-failed',
  messageId: MESSAGE_ID,
  sourceBlockchainId: HOME_CHAIN,
  source: source(REMOTE_CHAIN, 200, 1),
};

const receipt: TeleporterObservation = {
  kind: 'teleporter.receipt',
  messageId: MESSAGE_ID,
  destinationBlockchainId: REMOTE_CHAIN,
  relayerRewardAddress: `0x${'cc'.repeat(20)}`,
  source: source(HOME_CHAIN, 120, 0),
};

const unwrap = (o: TeleporterObservation) => {
  const r = projectTeleporter(o, ctx);
  if (!r.ok) throw new Error(r.reason);
  return r.input;
};

describe('teleporter projection', () => {
  it('maps received to DELIVERY, never to execution', () => {
    // The rule the product cannot get wrong.
    expect(unwrap(received).kind).toBe('delivered');
    expect(unwrap(received).carriesEconomicEffect).toBe(false);
  });

  it('maps executed to a successful execution that carries the effect', () => {
    const i = unwrap(executed);
    expect(i.kind).toBe('execution-succeeded');
    expect(i.carriesEconomicEffect).toBe(true);
  });

  it('maps a failed execution to a failure that carries no effect', () => {
    const i = unwrap(failed);
    expect(i.kind).toBe('execution-failed');
    expect(i.carriesEconomicEffect).toBe(false);
  });

  it('maps a receipt to a liveness signal with no effect', () => {
    const i = unwrap(receipt);
    expect(i.kind).toBe('receipt-observed');
    expect(i.carriesEconomicEffect).toBe(false);
  });

  it('gives one message key whichever side observed the fact', () => {
    // Anchored on the source chain, so send and receive agree.
    expect(messageKeyOf(unwrap(sent).message)).toBe(messageKeyOf(unwrap(received).message));
    expect(messageKeyOf(unwrap(executed).message)).toBe(messageKeyOf(unwrap(sent).message));
  });

  it('anchors the key on the source registry version, not the destination one', () => {
    // The two chains report 1 and 7; the key must not flip depending on which
    // side decoded the log.
    expect(unwrap(received).message.registryProtocolVersion).toBe(1);
    expect(unwrap(received).message.teleporterMessengerAddress).toBe(MESSENGER);
  });

  it('carries the pinned position and the raw fact separately', () => {
    const i = unwrap(executed);
    // Identity has no height; position has both height and hash.
    expect(i.fact).toEqual({
      evmChainId: 43113n,
      blockHash: hex32(200),
      txHash: hex32(700_200),
      logIndex: 1,
    });
    expect(i.position).toEqual({
      blockchainId: REMOTE_CHAIN,
      blockNumber: 200n,
      blockHash: hex32(200),
    });
  });

  it('uses the EVM chainId of the chain that produced the log', () => {
    expect(unwrap(sent).fact.evmChainId).toBe(43114n);
    expect(unwrap(executed).fact.evmChainId).toBe(43113n);
  });

  it('preserves adapter provenance', () => {
    expect(unwrap(executed).adapterId).toBe('teleporter@pinned');
    expect(unwrap(executed).adapterVersion).toBe(1);
  });
});

describe('source accounting projection', () => {
  it('marks an empty-payload message as carrying no effect', () => {
    const i = projectSourceAccounting(
      {
        sourceBlockchainId: HOME_CHAIN,
        destinationBlockchainId: REMOTE_CHAIN,
        messageId: MESSAGE_ID,
        blockNumber: 100n,
        blockHash: hex32(100),
        txHash: hex32(700_100),
        logIndex: 2,
        adapterId: 'ictt@pinned',
        adapterVersion: 1,
        carriesEconomicEffect: false,
      },
      ctx,
    );
    expect(i.kind).toBe('source-accounted');
    expect(i.carriesEconomicEffect).toBe(false);
  });
});

describe('unsupported shapes', () => {
  it.each(['multi-hop', 'remote-to-remote', 'send-and-call'] as const)(
    'refuses to flatten %s into a single hop',
    (shape) => {
      const i = projectUnsupportedShape(
        {
          sourceBlockchainId: HOME_CHAIN,
          destinationBlockchainId: REMOTE_CHAIN,
          messageId: MESSAGE_ID,
          blockNumber: 100n,
          blockHash: hex32(100),
          txHash: hex32(700_100),
          logIndex: 4,
          adapterId: 'ictt@pinned',
          adapterVersion: 1,
          shape,
        },
        ctx,
      );
      expect(i.kind).toBe('unsupported');
      expect(i.unsupportedReason).toBe(shape);
      expect(i.carriesEconomicEffect).toBe(false);
    },
  );
});

describe('projectObservations', () => {
  it('projects lifecycle observations and reports the rest as skipped', () => {
    const { inputs, skipped } = projectObservations([sent, received, executed], ctx);
    expect(inputs.map((i) => i.kind)).toEqual(['icm-sent', 'delivered', 'execution-succeeded']);
    expect(skipped).toEqual([]);
  });

  it('does not silently drop a non-lifecycle observation', () => {
    const stateRead = {
      kind: 'ictt.remote-collateralized' as const,
      source: {
        blockchainId: REMOTE_CHAIN,
        contractAddress: MESSENGER,
        blockNumber: 200n,
        blockHash: hex32(200),
        adapterId: 'ictt@pinned',
        adapterVersion: 1,
      },
      isCollateralized: true,
      initialReserveImbalance: 0n,
    };
    const { inputs, skipped } = projectObservations([stateRead], ctx);
    expect(inputs).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.ok).toBe(false);
  });
});
