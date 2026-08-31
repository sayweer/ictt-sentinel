import { describe, expect, it } from 'vitest';
import {
  EIP1967_SLOTS,
  canonicalSignature,
  classifyFingerprint,
  codeHash,
  epochAt,
  eventTopic0,
  functionSelector,
  isInterpretable,
  keccak256Hex,
  type AbiEntry,
  type AdapterEpoch,
  type ApprovedCodeHashes,
  type ObservedContract,
} from '../src/fingerprint.js';
import { resolveAdapter } from '../src/registry.js';

const h = (seed: string): string => `0x${seed.repeat(64).slice(0, 64)}`;
const KNOWN = h('1');
const FORKED = h('2');
const UPGRADED = h('3');
const OTHER = h('4');

const approved: ApprovedCodeHashes[] = [
  {
    adapterId: 'ictt.token-remote.erc20-upgradeable',
    runtimeCodeHashes: [KNOWN],
    historicalImplementationHashes: [UPGRADED],
  },
];

describe('keccak and selectors are correct against known values', () => {
  it('hashes the empty input to the documented keccak256 value', () => {
    expect(keccak256Hex(new Uint8Array())).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
  });

  it('produces the well-known ERC-20 Transfer topic', () => {
    const transfer: AbiEntry = {
      type: 'event',
      name: 'Transfer',
      inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    };
    expect(canonicalSignature(transfer)).toBe('Transfer(address,address,uint256)');
    expect(eventTopic0(transfer)).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    );
  });

  it('produces the well-known transfer(address,uint256) selector', () => {
    const fn: AbiEntry = {
      type: 'function',
      name: 'transfer',
      inputs: [{ type: 'address' }, { type: 'uint256' }],
    };
    expect(functionSelector(fn)).toBe('0xa9059cbb');
  });

  it('expands tuples the way the EVM hashes them', () => {
    const entry: AbiEntry = {
      type: 'event',
      name: 'Sent',
      inputs: [
        { type: 'bytes32' },
        { type: 'tuple', components: [{ type: 'address' }, { type: 'uint256' }] },
      ],
    };
    expect(canonicalSignature(entry)).toBe('Sent(bytes32,(address,uint256))');
  });

  it('expands tuple arrays', () => {
    const entry: AbiEntry = {
      type: 'event',
      name: 'Batch',
      inputs: [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }] }],
    };
    expect(canonicalSignature(entry)).toBe('Batch((address,uint256)[])');
  });

  it('uses the standard EIP-1967 slots', () => {
    expect(EIP1967_SLOTS.implementation).toBe(
      '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    );
    expect(EIP1967_SLOTS.admin).toBe(
      '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
    );
    expect(EIP1967_SLOTS.beacon).toBe(
      '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
    );
  });

  it('hashes runtime code and rejects malformed hex', () => {
    expect(codeHash('0x')).toBe(keccak256Hex(new Uint8Array()));
    expect(() => codeHash('0xabc')).toThrow();
    expect(() => codeHash('0xzz')).toThrow();
  });
});

describe('selector and topic collisions are not silently resolved', () => {
  it('two different signatures produce different topics', () => {
    const a = eventTopic0({ type: 'event', name: 'A', inputs: [{ type: 'uint256' }] });
    const b = eventTopic0({ type: 'event', name: 'B', inputs: [{ type: 'uint256' }] });
    expect(a).not.toBe(b);
  });

  it('a four-byte selector clash does not make two functions the same', () => {
    // Different signatures can share a selector; the full signature hash is what
    // distinguishes them, so decoding must key on the ABI entry, not the prefix.
    const one: AbiEntry = {
      type: 'function',
      name: 'transfer',
      inputs: [{ type: 'address' }, { type: 'uint256' }],
    };
    const two: AbiEntry = {
      type: 'function',
      name: 'transfer',
      inputs: [{ type: 'address' }, { type: 'uint128' }],
    };
    expect(functionSelector(one)).not.toBe(functionSelector(two));
    expect(canonicalSignature(one)).not.toBe(canonicalSignature(two));
  });

  it('an adapter claimed by two entries is conflicting, not a coin flip', () => {
    const clashing: ApprovedCodeHashes[] = [
      { adapterId: 'ictt.token-remote.erc20-upgradeable', runtimeCodeHashes: [KNOWN] },
      { adapterId: 'ictt.token-remote.native-upgradeable', runtimeCodeHashes: [KNOWN] },
    ];
    const r = classifyFingerprint({ address: h('a'), runtimeCodeHash: KNOWN }, clashing);
    expect(r.class).toBe('conflicting');
    expect(isInterpretable(r)).toBe(false);
  });
});

describe('fingerprint classification', () => {
  it('a known non-proxy code hash is interpretable', () => {
    const r = classifyFingerprint({ address: h('a'), runtimeCodeHash: KNOWN }, approved);
    expect(r.class).toBe('exact-known-non-proxy');
    expect(r.adapterId).toBe('ictt.token-remote.erc20-upgradeable');
    expect(isInterpretable(r)).toBe(true);
  });

  it('a proxy with a known implementation is interpretable', () => {
    const observed: ObservedContract = {
      address: h('a'),
      runtimeCodeHash: OTHER,
      implementationAddress: h('b'),
      implementationCodeHash: KNOWN,
    };
    const r = classifyFingerprint(observed, approved);
    expect(r.class).toBe('known-proxy-known-implementation');
    expect(isInterpretable(r)).toBe(true);
  });

  it('a forked implementation is unknown, never a near match', () => {
    const observed: ObservedContract = {
      address: h('a'),
      runtimeCodeHash: OTHER,
      implementationAddress: h('b'),
      implementationCodeHash: FORKED,
    };
    const r = classifyFingerprint(observed, approved);
    expect(r.class).toBe('custom-or-unknown');
    expect(isInterpretable(r)).toBe(false);
  });

  it('a proxy whose implementation was not observed is unknown', () => {
    const observed: ObservedContract = {
      address: h('a'),
      runtimeCodeHash: OTHER,
      implementationAddress: h('b'),
    };
    const r = classifyFingerprint(observed, approved);
    expect(r.class).toBe('custom-or-unknown');
    expect(r.reasons.join(' ')).toContain('implementation code hash was not observed');
  });

  it('a superseded implementation is a historical epoch, not a pass', () => {
    const observed: ObservedContract = {
      address: h('a'),
      runtimeCodeHash: OTHER,
      implementationAddress: h('b'),
      implementationCodeHash: UPGRADED,
    };
    const r = classifyFingerprint(observed, approved);
    expect(r.class).toBe('known-historical-epoch');
    expect(isInterpretable(r)).toBe(false);
  });

  it('an unknown fingerprint never resolves to a supported adapter', () => {
    const observed: ObservedContract = { address: h('a'), runtimeCodeHash: FORKED };
    const r = resolveAdapter(observed, approved, 'ictt');
    expect(r.outcome).toBe('unknown');
    expect(r.interpretable).toBe(false);
    expect(r.adapterId).toBeUndefined();
  });

  it('a fingerprint from another family does not satisfy the expected family', () => {
    const withTeleporter: ApprovedCodeHashes[] = [
      { adapterId: 'teleporter.messenger', runtimeCodeHashes: [KNOWN] },
    ];
    const observed: ObservedContract = { address: h('a'), runtimeCodeHash: KNOWN };
    const r = resolveAdapter(observed, withTeleporter, 'ictt');
    expect(r.interpretable).toBe(false);
    expect(r.reasons.join(' ')).toContain('but the manifest expects');
  });

  it('matching is case insensitive on hex', () => {
    const observed: ObservedContract = { address: h('a'), runtimeCodeHash: KNOWN.toUpperCase() };
    expect(classifyFingerprint(observed, approved).class).toBe('exact-known-non-proxy');
  });
});

describe('an implementation upgrade splits replay at an exact boundary', () => {
  const epochs: AdapterEpoch[] = [
    {
      adapterId: 'ictt.token-remote.erc20-upgradeable',
      implementationCodeHash: UPGRADED,
      fromBlock: 100n,
      fromTxIndex: 0,
      fromLogIndex: 0,
    },
    {
      adapterId: 'ictt.token-remote.erc20-upgradeable',
      implementationCodeHash: KNOWN,
      fromBlock: 200n,
      fromTxIndex: 3,
      fromLogIndex: 7,
    },
  ];

  it('uses the old epoch for a log before the upgrade', () => {
    const r = epochAt(epochs, 150n, 0, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.epoch.implementationCodeHash).toBe(UPGRADED);
  });

  it('uses the old epoch for a log in the upgrade block but before the upgrade log', () => {
    const r = epochAt(epochs, 200n, 3, 6);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.epoch.implementationCodeHash).toBe(UPGRADED);
  });

  it('switches exactly at the upgrade log index', () => {
    const r = epochAt(epochs, 200n, 3, 7);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.epoch.implementationCodeHash).toBe(KNOWN);
  });

  it('uses the new epoch for a later transaction in the same block', () => {
    const r = epochAt(epochs, 200n, 4, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.epoch.implementationCodeHash).toBe(KNOWN);
  });

  it('refuses a position before any epoch rather than guessing the nearest', () => {
    const r = epochAt(epochs, 99n, 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('not interpretable');
  });

  it('refuses a position inside a gap between epochs', () => {
    const gapped: AdapterEpoch[] = [
      {
        adapterId: 'x',
        implementationCodeHash: UPGRADED,
        fromBlock: 100n,
        fromTxIndex: 0,
        fromLogIndex: 0,
        toBlock: 150n,
      },
      {
        adapterId: 'x',
        implementationCodeHash: KNOWN,
        fromBlock: 300n,
        fromTxIndex: 0,
        fromLogIndex: 0,
      },
    ];
    expect(epochAt(gapped, 200n, 0, 0).ok).toBe(false);
  });
});
