import { keccak_256 } from '@noble/hashes/sha3.js';

/**
 * Contract fingerprinting.
 *
 * The only thing that selects an adapter is an exact fingerprint match. There is
 * no heuristic decode, no "looks close enough", and no fallback to a similar
 * version: an unrecognised contract resolves to UNKNOWN, because interpreting
 * bytes with the wrong ABI produces a confident wrong number
 * (docs/adr/0003-fail-closed-verdicts.md).
 */

/** EIP-1967 storage slots. Values are fixed by the standard, not derived here. */
export const EIP1967_SLOTS = {
  /** keccak256('eip1967.proxy.implementation') - 1 */
  implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  /** keccak256('eip1967.proxy.admin') - 1 */
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  /** keccak256('eip1967.proxy.beacon') - 1 */
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
} as const;

const toHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export const keccak256Hex = (data: Uint8Array): string => toHex(keccak_256(data));

/** Hash of deployed runtime code, as `eth_getCode` returns it. */
export const codeHash = (runtimeCodeHex: string): string => {
  const body = runtimeCodeHex.startsWith('0x') ? runtimeCodeHex.slice(2) : runtimeCodeHex;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new TypeError('runtime code must be an even-length hex string');
  }
  const bytes = new Uint8Array(body.length / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return keccak256Hex(bytes);
};

/**
 * Canonical signature for an ABI entry, e.g. `Transfer(address,address,uint256)`.
 * Tuples expand to their component list, which is what the EVM hashes.
 */
export interface AbiParameter {
  readonly type: string;
  readonly name?: string;
  readonly components?: readonly AbiParameter[];
}

export interface AbiEntry {
  readonly type: string;
  readonly name?: string;
  readonly inputs?: readonly AbiParameter[];
  readonly anonymous?: boolean;
}

const canonicalType = (p: AbiParameter): string => {
  if (p.type.startsWith('tuple')) {
    const inner = (p.components ?? []).map(canonicalType).join(',');
    return `(${inner})${p.type.slice('tuple'.length)}`;
  }
  return p.type;
};

export const canonicalSignature = (entry: AbiEntry): string => {
  const name = entry.name ?? '';
  const inputs = (entry.inputs ?? []).map(canonicalType).join(',');
  return `${name}(${inputs})`;
};

/** Event `topic0`. */
export const eventTopic0 = (entry: AbiEntry): string =>
  keccak256Hex(utf8(canonicalSignature(entry)));

/** Function selector: first four bytes of the signature hash. */
export const functionSelector = (entry: AbiEntry): string =>
  keccak256Hex(utf8(canonicalSignature(entry))).slice(0, 10);

/**
 * Fingerprint classes.
 *
 * `known-historical-epoch` exists because an implementation upgrade splits a
 * replay: events before and after the upgrade were produced by different code,
 * so they must be decoded by different adapters rather than one guess applied
 * to the whole range.
 */
export const FINGERPRINT_CLASSES = [
  'exact-known-non-proxy',
  'known-proxy-known-implementation',
  'known-historical-epoch',
  'custom-or-unknown',
  'conflicting',
] as const;
export type FingerprintClass = (typeof FINGERPRINT_CLASSES)[number];

export interface ObservedContract {
  readonly address: string;
  /** keccak256 of the code at the address. */
  readonly runtimeCodeHash: string;
  /** EIP-1967 implementation slot, when the address is a proxy. */
  readonly implementationAddress?: string;
  readonly implementationCodeHash?: string;
  readonly beaconAddress?: string;
  readonly adminAddress?: string;
}

/**
 * Runtime code hashes an operator has reviewed and approved, per adapter.
 *
 * This is deliberately operator-supplied. Runtime bytecode cannot be derived
 * from published artifacts (constructor execution, immutables), so the pinned
 * upstream commit fixes the *source and ABI*, and the operator attests which
 * deployed code hash corresponds to it.
 */
export interface ApprovedCodeHashes {
  readonly adapterId: string;
  readonly runtimeCodeHashes: readonly string[];
  /** Ordered epochs for a proxy whose implementation changed over time. */
  readonly historicalImplementationHashes?: readonly string[];
}

export interface FingerprintResult {
  readonly class: FingerprintClass;
  readonly adapterId?: string;
  readonly reasons: readonly string[];
}

const norm = (h: string): string => h.toLowerCase();

/**
 * Classify an observed contract against the approved set.
 *
 * Matching more than one adapter is `conflicting`, not a pick: two adapters
 * claiming the same code hash means the approved set is wrong, and choosing one
 * would hide that.
 */
export const classifyFingerprint = (
  observed: ObservedContract,
  approved: readonly ApprovedCodeHashes[],
): FingerprintResult => {
  const reasons: string[] = [];
  const isProxy =
    observed.implementationAddress !== undefined || observed.beaconAddress !== undefined;

  const target = isProxy ? observed.implementationCodeHash : observed.runtimeCodeHash;
  if (target === undefined) {
    return {
      class: 'custom-or-unknown',
      reasons: ['the proxy implementation code hash was not observed'],
    };
  }

  const current = approved.filter((a) => a.runtimeCodeHashes.some((h) => norm(h) === norm(target)));
  if (current.length > 1) {
    return {
      class: 'conflicting',
      reasons: [
        `code hash matches ${String(current.length)} adapters: ${current.map((a) => a.adapterId).join(', ')}`,
      ],
    };
  }

  if (current.length === 1) {
    const hit = current[0];
    if (hit === undefined)
      return { class: 'custom-or-unknown', reasons: ['internal: empty match'] };
    return {
      class: isProxy ? 'known-proxy-known-implementation' : 'exact-known-non-proxy',
      adapterId: hit.adapterId,
      reasons: [],
    };
  }

  // Not current, but recognisable as a past epoch of a known adapter. Still not
  // a pass: history can be replayed with it, the present cannot.
  const historical = approved.filter((a) =>
    (a.historicalImplementationHashes ?? []).some((h) => norm(h) === norm(target)),
  );
  if (historical.length === 1) {
    const hit = historical[0];
    if (hit === undefined)
      return { class: 'custom-or-unknown', reasons: ['internal: empty match'] };
    return {
      class: 'known-historical-epoch',
      adapterId: hit.adapterId,
      reasons: ['code matches a superseded implementation epoch, not the approved current one'],
    };
  }
  if (historical.length > 1) {
    return { class: 'conflicting', reasons: ['code hash matches more than one historical epoch'] };
  }

  reasons.push('runtime code hash is not in the approved set for any adapter');
  if (isProxy) reasons.push('contract is a proxy with an unrecognised implementation');
  return { class: 'custom-or-unknown', reasons };
};

/** Only an exact current match may be interpreted. Everything else is UNKNOWN. */
export const isInterpretable = (r: FingerprintResult): boolean =>
  r.class === 'exact-known-non-proxy' || r.class === 'known-proxy-known-implementation';

/**
 * An adapter epoch: the block range over which one implementation was in force.
 *
 * An upgrade splits a replay at an exact `(blockNumber, txIndex, logIndex)`
 * boundary. Decoding a log with the adapter from the wrong side of that boundary
 * is how a replay produces a confident wrong answer.
 */
export interface AdapterEpoch {
  readonly adapterId: string;
  readonly implementationCodeHash: string;
  readonly fromBlock: bigint;
  readonly fromTxIndex: number;
  readonly fromLogIndex: number;
  readonly toBlock?: bigint;
}

export type EpochLookup =
  | { readonly ok: true; readonly epoch: AdapterEpoch }
  | { readonly ok: false; readonly reason: string };

/**
 * Which epoch governs a given log position.
 *
 * An epoch runs from its start boundary until the next epoch's start boundary,
 * so an upgrade landing partway through a block leaves the earlier logs of that
 * same block with the old implementation. `toBlock` is only for an epoch that
 * genuinely ends without a successor.
 *
 * A position no epoch covers is not interpretable. There is no nearest match:
 * decoding a log with the adapter from the wrong side of an upgrade is how a
 * replay produces a confident wrong answer.
 */
export const epochAt = (
  epochs: readonly AdapterEpoch[],
  blockNumber: bigint,
  txIndex: number,
  logIndex: number,
): EpochLookup => {
  const ordered = [...epochs].sort((a, b) =>
    a.fromBlock === b.fromBlock
      ? a.fromTxIndex === b.fromTxIndex
        ? a.fromLogIndex - b.fromLogIndex
        : a.fromTxIndex - b.fromTxIndex
      : a.fromBlock < b.fromBlock
        ? -1
        : 1,
  );

  const hasStarted = (e: AdapterEpoch): boolean =>
    blockNumber > e.fromBlock ||
    (blockNumber === e.fromBlock &&
      (txIndex > e.fromTxIndex || (txIndex === e.fromTxIndex && logIndex >= e.fromLogIndex)));

  // The governing epoch is the last one that has started. Finding it first, and
  // only then testing its end, keeps an epoch that ended from hiding the fact
  // that it was the applicable one.
  let found: AdapterEpoch | undefined;
  for (const e of ordered) {
    if (!hasStarted(e)) break;
    found = e;
  }

  if (found === undefined) {
    return {
      ok: false,
      reason: 'the position precedes every adapter epoch; the range is not interpretable',
    };
  }
  if (found.toBlock !== undefined && blockNumber > found.toBlock) {
    return {
      ok: false,
      reason: 'the position falls in a gap after an epoch ended; the range is not interpretable',
    };
  }
  return { ok: true, epoch: found };
};
