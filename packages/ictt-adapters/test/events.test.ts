import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AbiDecodeError,
  CALLS,
  EVENT_TOPICS,
  decodeMessageExecuted,
  decodeReceiveCrossChainMessage,
  decodeRemoteSettingsResult,
  decodeTokensRouted,
  decodeTokensSent,
  decodeTransferrerMessage,
  decodeUintResult,
  type EventLog,
} from '../src/events.js';

/**
 * Real C-Chain mainnet logs are the strongest test of an ABI layout: a
 * signature or offset mistake would make them fail to decode or decode to
 * nonsense. See the provenance field in the fixture.
 */
interface LiveLog extends EventLog {
  readonly transactionHash: string;
}
const LIVE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./live-mainnet-logs.json', import.meta.url)), 'utf8'),
) as { tokensSent: LiveLog; receiveCrossChainMessage: LiveLog; messageExecuted: LiveLog };

const w = (value: bigint | number): string => BigInt(value).toString(16).padStart(64, '0');
const addr = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const b32 = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;

/** `abi.encode(TransferrerMessage({messageType, payload}))`. */
const transferrerMessage = (type: number, payloadWords: readonly string[]): string =>
  `0x${w(32)}${w(type)}${w(64)}${w(payloadWords.length * 32)}${payloadWords.join('')}`;

describe('event signatures from the pinned source', () => {
  it('match topic0 of real mainnet logs', () => {
    expect(LIVE.tokensSent.topics[0]).toBe(EVENT_TOPICS.tokensSent);
    expect(LIVE.receiveCrossChainMessage.topics[0]).toBe(EVENT_TOPICS.receiveCrossChainMessage);
    expect(LIVE.messageExecuted.topics[0]).toBe(EVENT_TOPICS.messageExecuted);
  });
});

describe('decoding real logs', () => {
  it('reads a TokensSent log word by word', () => {
    const e = decodeTokensSent(LIVE.tokensSent);
    expect(e.messageId).toBe(LIVE.tokensSent.topics[1]);
    expect(e.sender).toBe(`0x${(LIVE.tokensSent.topics[2] ?? '').slice(-40)}`);
    expect(e.destinationBlockchainId).toBe(`0x${LIVE.tokensSent.data.slice(2, 66)}`);
    expect(e.amount).toBe(BigInt(`0x${LIVE.tokensSent.data.slice(-64)}`));
  });

  it('reads the TeleporterMessage inside a ReceiveCrossChainMessage log', () => {
    const m = decodeReceiveCrossChainMessage(LIVE.receiveCrossChainMessage);
    expect(m.messageId).toBe(LIVE.receiveCrossChainMessage.topics[1]);
    expect(m.sourceBlockchainId).toBe(LIVE.receiveCrossChainMessage.topics[2]);
    // Values cross-checked by hand against the raw words of this log.
    expect(m.originSenderAddress).toBe('0x59211b32ac0bfc2cdd67ee1cb89979d2d33e74c8');
    expect(m.destinationAddress).toBe('0xa8baad3115a133b101ef935cb2e198fd04f1c659');
    expect(m.message.length).toBeGreaterThan(2);
  });

  it('pairs MessageExecuted with its delivery by message id', () => {
    expect(decodeMessageExecuted(LIVE.messageExecuted).messageId).toBe(
      decodeReceiveCrossChainMessage(LIVE.receiveCrossChainMessage).messageId,
    );
    expect(LIVE.messageExecuted.transactionHash).toBe(
      LIVE.receiveCrossChainMessage.transactionHash,
    );
  });
});

describe('ICTT payload', () => {
  it('reads the remote-denominated amount of a single-hop send', () => {
    const p = decodeTransferrerMessage(transferrerMessage(1, [w(0xabc), w(1_000_000n)]));
    expect(p).toEqual({
      messageType: 'SINGLE_HOP_SEND',
      singleHopSend: { recipient: addr(0xabc), amount: 1_000_000n },
    });
  });

  it('classifies every other type without interpreting it', () => {
    for (const [type, name] of [
      [0, 'REGISTER_REMOTE'],
      [2, 'SINGLE_HOP_CALL'],
      [3, 'MULTI_HOP_SEND'],
      [4, 'MULTI_HOP_CALL'],
    ] as const) {
      expect(decodeTransferrerMessage(transferrerMessage(type, [w(1), w(2), w(3)]))).toEqual({
        messageType: name,
        singleHopSend: null,
      });
    }
  });

  it('refuses an unknown type, a short payload and a truncated encoding', () => {
    expect(() => decodeTransferrerMessage(transferrerMessage(5, [w(1), w(2)]))).toThrow(
      AbiDecodeError,
    );
    expect(() => decodeTransferrerMessage(transferrerMessage(1, [w(1)]))).toThrow(AbiDecodeError);
    expect(() => decodeTransferrerMessage(`0x${w(32)}${w(1)}`)).toThrow(AbiDecodeError);
  });
});

describe('malformed logs are refused, never approximated', () => {
  const routed = (data: string): EventLog => ({
    address: addr(1),
    topics: [EVENT_TOPICS.tokensRouted, b32(7)],
    data,
  });
  const nineWords = Array.from({ length: 9 }, (_, i) => w(i)).join('');

  it('decodes a well-formed static log', () => {
    expect(decodeTokensRouted(routed(`0x${nineWords}`)).amount).toBe(8n);
  });

  it.each([
    ['one word short', `0x${nineWords.slice(64)}`],
    ['one word long', `0x${nineWords}${w(0)}`],
    ['dirty address padding', `0x${w(0)}${'1'.repeat(64)}${nineWords.slice(128)}`],
    ['uppercase hex', `0x${nineWords.slice(0, -64)}${'A'.repeat(64)}`],
  ])('%s', (_, data) => {
    expect(() => decodeTokensRouted(routed(data))).toThrow(AbiDecodeError);
  });

  it('refuses the wrong topic0 and the wrong topic count', () => {
    expect(() =>
      decodeTokensRouted({
        ...routed(`0x${nineWords}`),
        topics: [EVENT_TOPICS.tokensSent, b32(7)],
      }),
    ).toThrow(AbiDecodeError);
    expect(() =>
      decodeTokensRouted({ ...routed(`0x${nineWords}`), topics: [EVENT_TOPICS.tokensRouted] }),
    ).toThrow(AbiDecodeError);
  });

  it('never throws anything but AbiDecodeError on arbitrary data', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 640 }), (bytes) => {
        const data = `0x${Buffer.from(bytes).toString('hex')}`;
        for (const decode of [
          () => decodeTokensRouted(routed(data)),
          () => decodeTransferrerMessage(data),
          () =>
            decodeReceiveCrossChainMessage({
              ...LIVE.receiveCrossChainMessage,
              data,
            }),
        ]) {
          try {
            decode();
          } catch (e) {
            expect(e).toBeInstanceOf(AbiDecodeError);
          }
        }
      }),
      { numRuns: 300, seed: 21 },
    );
  });
});

describe('read-only calls', () => {
  it('use the standard selectors', () => {
    expect(CALLS.totalSupply()).toBe('0x18160ddd');
    expect(CALLS.balanceOf(addr(0xbeef))).toBe(`0x70a08231${w(0xbeef)}`);
  });

  it('decode single-word and settings results strictly', () => {
    expect(decodeUintResult(`0x${w(42)}`)).toBe(42n);
    expect(() => decodeUintResult(`0x${w(1)}${w(2)}`)).toThrow(AbiDecodeError);
    expect(decodeRemoteSettingsResult(`0x${w(1)}${w(0)}${w(1000)}${w(1)}`)).toEqual({
      registered: true,
      collateralNeeded: 0n,
      tokenMultiplier: 1000n,
      multiplyOnRemote: true,
    });
    expect(() => decodeRemoteSettingsResult(`0x${w(2)}${w(0)}${w(1)}${w(0)}`)).toThrow(
      AbiDecodeError,
    );
  });
});
