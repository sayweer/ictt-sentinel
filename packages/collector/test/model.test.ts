import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { TransferrerPayload } from '@ictt-sentinel/ictt-adapters';
import { assessRoute, type Delivery, type Fact, type Route, type SideFacts } from '../src/model.js';

const HOME = `0x${'aa'.repeat(32)}`;
const REMOTE = `0x${'bb'.repeat(32)}`;
const TOKEN_HOME = `0x${'11'.repeat(20)}`;
const TOKEN_REMOTE = `0x${'22'.repeat(20)}`;
const ROUTE: Route = {
  homeBlockchainId: HOME,
  tokenHomeAddress: TOKEN_HOME,
  remoteBlockchainId: REMOTE,
  remoteAddress: TOKEN_REMOTE,
};
const id = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const at = (block: number, log = 0) => ({
  blockNumber: BigInt(block),
  blockHash: id(block + 1_000_000),
  txHash: id(block * 100 + log),
  logIndex: log,
  blockTimestamp: BigInt(block),
});
const digestOf = (f: Fact<unknown>, chain: string) =>
  `${chain}:${f.at.txHash}:${String(f.at.logIndex)}`;

const send = (n: number, block: number, amount: bigint, to: 'home' | 'remote') => ({
  value: {
    messageId: id(n),
    sender: `0x${'99'.repeat(20)}`,
    destinationBlockchainId: to === 'remote' ? REMOTE : HOME,
    destinationTokenTransferrerAddress: to === 'remote' ? TOKEN_REMOTE : TOKEN_HOME,
    recipient: `0x${'98'.repeat(20)}`,
    multiHopFallback: `0x${'00'.repeat(20)}`,
    amount,
  },
  at: at(block),
});
const single = (amount: bigint): TransferrerPayload => ({
  messageType: 'SINGLE_HOP_SEND',
  singleHopSend: { recipient: `0x${'98'.repeat(20)}`, amount },
});
const deliver = (
  n: number,
  block: number,
  payload: TransferrerPayload,
  from: 'home' | 'remote',
  origin = from === 'home' ? TOKEN_HOME : TOKEN_REMOTE,
): Fact<Delivery> => ({
  value: {
    messageId: id(n),
    sourceBlockchainId: from === 'home' ? HOME : REMOTE,
    originSenderAddress: origin,
    destinationAddress: from === 'home' ? TOKEN_REMOTE : TOKEN_HOME,
    payload,
  },
  at: at(block, 1),
});
const outcome = (n: number, block: number, from: 'home' | 'remote', log = 2) => ({
  value: { messageId: id(n), sourceBlockchainId: from === 'home' ? HOME : REMOTE },
  at: at(block, log),
});
const side = (chain: string, pin: number, over: Partial<SideFacts> = {}): SideFacts => ({
  blockchainId: chain,
  pin: { blockNumber: BigInt(pin), blockHash: id(pin), timestamp: BigInt(pin) },
  sent: [],
  unsupportedSends: [],
  delivered: [],
  executed: [],
  failed: [],
  ...over,
});

describe('route assessment', () => {
  it('credits each execution to its unique source and leaves nothing in flight', () => {
    const r = assessRoute(
      ROUTE,
      side(HOME, 100, {
        sent: [send(1, 10, 500n, 'remote')],
        delivered: [deliver(2, 40, single(200n), 'remote')],
        executed: [outcome(2, 40, 'remote')],
      }),
      side(REMOTE, 100, {
        sent: [send(2, 30, 200n, 'home')],
        delivered: [deliver(1, 20, single(500n), 'home')],
        executed: [outcome(1, 20, 'home')],
      }),
      digestOf,
    );
    expect(r.pending).toEqual([]);
    expect(r.openEdges).toEqual([]);
    expect(r.unsupported).toEqual([]);
    expect(
      r.effects.map((e) => [e.amount, e.hasUniqueAuthorisedSource, e.routeMatchesSource]),
    ).toEqual([
      [500n, true, true],
      [200n, true, true],
    ]);
    expect(r.effects.every((e) => e.causalSourceFact !== null)).toBe(true);
  });

  it('keeps an undelivered send and a failed execution in flight, with chain-time ages', () => {
    const r = assessRoute(
      ROUTE,
      side(HOME, 100, {
        sent: [send(1, 10, 500n, 'remote')],
        delivered: [deliver(2, 60, single(70n), 'remote')],
        failed: [outcome(2, 60, 'remote')],
      }),
      side(REMOTE, 90, { sent: [send(2, 50, 70n, 'home')] }),
      digestOf,
    );
    expect(r.pending.map((p) => [p.direction, p.amount, p.ageSeconds])).toEqual([
      ['home-to-remote', 500n, 90],
      ['remote-to-home', 70n, 40],
    ]);
    expect(r.messages.map((m) => m.state)).toEqual(['SOURCE_ACCOUNTED', 'EXECUTED_FAILED']);
  });

  it('opens the cut when an execution inside it has its source outside', () => {
    const r = assessRoute(
      ROUTE,
      side(HOME, 100),
      side(REMOTE, 100, {
        delivered: [deliver(9, 20, single(5n), 'home')],
        executed: [outcome(9, 20, 'home')],
      }),
      digestOf,
    );
    expect(r.openEdges).toEqual([{ direction: 'home-to-remote', messageId: id(9) }]);
    // Without a source there is nothing to judge the credit against.
    expect(r.effects).toEqual([]);
  });

  it('marks an amount that differs from its source and a doubled execution', () => {
    const r = assessRoute(
      ROUTE,
      side(HOME, 100, { sent: [send(1, 10, 500n, 'remote')] }),
      side(REMOTE, 100, {
        delivered: [deliver(1, 20, single(501n), 'home')],
        executed: [outcome(1, 20, 'home'), outcome(1, 21, 'home', 3)],
      }),
      digestOf,
    );
    expect(r.effects[0]).toMatchObject({ routeMatchesSource: false, duplicateEffect: true });
  });

  it('ignores deliveries from other applications on the same messenger', () => {
    const r = assessRoute(
      ROUTE,
      side(HOME, 100),
      side(REMOTE, 100, {
        delivered: [deliver(7, 20, single(5n), 'home', `0x${'77'.repeat(20)}`)],
        executed: [outcome(7, 20, 'home')],
      }),
      digestOf,
    );
    expect(r.effects).toEqual([]);
    expect(r.openEdges).toEqual([]);
  });

  it('reports every shape the engine does not model', () => {
    const r = assessRoute(
      ROUTE,
      side(HOME, 100, {
        unsupportedSends: [
          {
            value: {
              messageId: id(3),
              destinationBlockchainId: REMOTE,
              destinationTokenTransferrerAddress: TOKEN_REMOTE,
              amount: 1n,
            },
            at: at(5),
          },
        ],
      }),
      side(REMOTE, 100, {
        sent: [
          {
            ...send(4, 5, 1n, 'home'),
            value: { ...send(4, 5, 1n, 'home').value, destinationBlockchainId: id(77) },
          },
        ],
        delivered: [deliver(5, 6, { messageType: 'SINGLE_HOP_CALL', singleHopSend: null }, 'home')],
      }),
      digestOf,
    );
    expect(r.unsupported).toEqual([
      'home-to-remote:SINGLE_HOP_CALL',
      'home-to-remote:routed-or-send-and-call',
      'remote-to-home:multi-hop',
    ]);
  });
});

describe('the accounting identity the engine relies on', () => {
  // A random single-hop history on two independent chains, replayed with the
  // pinned contract's own update rules, at two random pins.
  const transfer = fc.record({
    toRemote: fc.boolean(),
    amount: fc.bigInt({ min: 1n, max: 10n ** 24n }),
    sendBlock: fc.integer({ min: 1, max: 60 }),
    lag: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }),
    failsFirst: fc.boolean(),
  });

  it('holds D - S = pending whenever the cut is closed', () => {
    let closed = 0;
    let nonTrivial = 0;
    fc.assert(
      fc.property(
        fc.array(transfer, { maxLength: 25 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (history, homePin, remotePin) => {
          let d = 0n; // getTransferredBalance at homePin
          let s = 0n; // totalSupply at remotePin
          const home: {
            sent: Fact<ReturnType<typeof send>['value']>[];
            delivered: Fact<Delivery>[];
            executed: ReturnType<typeof outcome>[];
            failed: ReturnType<typeof outcome>[];
          } = { sent: [], delivered: [], executed: [], failed: [] };
          const remote: typeof home = { sent: [], delivered: [], executed: [], failed: [] };
          history.forEach((t, i) => {
            const n = i + 1;
            const [src, dst, srcPin, dstPin] = t.toRemote
              ? [home, remote, homePin, remotePin]
              : [remote, home, remotePin, homePin];
            if (t.sendBlock <= srcPin) {
              src.sent.push(send(n, t.sendBlock, t.amount, t.toRemote ? 'remote' : 'home'));
              if (t.toRemote) d += t.amount;
              else s -= t.amount;
            }
            if (t.lag === undefined) return;
            const block = t.sendBlock + t.lag;
            if (block > dstPin) return;
            dst.delivered.push(deliver(n, block, single(t.amount), t.toRemote ? 'home' : 'remote'));
            if (t.failsFirst) dst.failed.push(outcome(n, block, t.toRemote ? 'home' : 'remote'));
            const executedAt = t.failsFirst ? block + 1 : block;
            if (executedAt > dstPin) return;
            dst.executed.push(outcome(n, executedAt, t.toRemote ? 'home' : 'remote', 3));
            if (t.toRemote) s += t.amount;
            else d -= t.amount;
          });
          const r = assessRoute(
            ROUTE,
            side(HOME, homePin, home),
            side(REMOTE, remotePin, remote),
            digestOf,
          );
          if (r.openEdges.length > 0) return;
          closed += 1;
          if (r.pending.length > 0 && r.effects.length > 0) nonTrivial += 1;
          const pending = r.pending.reduce((acc, p) => acc + p.amount, 0n);
          expect(d - s).toBe(pending);
          expect(r.effects.every((e) => e.hasUniqueAuthorisedSource && e.routeMatchesSource)).toBe(
            true,
          );
        },
      ),
      { numRuns: 2_000, seed: 194 },
    );
    // The identity must actually be exercised: closed cuts with both credited
    // effects and transfers in flight, not only empty or open histories.
    expect(closed).toBeGreaterThan(400);
    expect(nonTrivial).toBeGreaterThan(200);
  });
});
