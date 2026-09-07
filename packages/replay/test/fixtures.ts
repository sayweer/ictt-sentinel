import type { BlockFact, LogFact } from '@ictt-sentinel/storage-postgres';
import type { RangeObservation } from '../src/range.js';

/** Deterministic fixtures. No clock, no randomness: replay tests cannot flake. */

export const CHAIN = 'home';
export const AT = new Date('2026-04-01T00:00:00Z');

export const hex32 = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
export const hex20 = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

export const block = (n: number, over: Partial<BlockFact> = {}): BlockFact => ({
  chainKey: CHAIN,
  blockHash: hex32(n),
  blockNumber: BigInt(n),
  parentHash: hex32(n - 1),
  blockTimestamp: 1_700_000_000n + BigInt(n),
  observedClass: 'accepted',
  observedAt: AT,
  ...over,
});

export const log = (
  n: number,
  txIndex: number,
  logIndex: number,
  over: Partial<LogFact> = {},
): LogFact => ({
  chainKey: CHAIN,
  blockHash: hex32(n),
  txHash: hex32(900_000 + n * 100 + txIndex),
  logIndex,
  blockNumber: BigInt(n),
  txIndex,
  address: hex20(7),
  topics: [hex32(1)],
  data: '0x',
  observedAt: AT,
  ...over,
});

export interface ObservationOptions {
  readonly providerGroup?: string;
  readonly from?: number;
  readonly to?: number;
  readonly blocks?: readonly BlockFact[];
  readonly logs?: readonly LogFact[];
  readonly logCount?: number;
  readonly complete?: boolean;
  readonly viaArchive?: boolean;
  readonly startBlockHash?: string;
  readonly endBlockHash?: string;
}

/** A well-formed observation of blocks 10..11 unless overridden. */
export const observation = (o: ObservationOptions = {}): RangeObservation => {
  const from = o.from ?? 10;
  const to = o.to ?? 11;
  const blocks = o.blocks ?? [block(from), block(to)];
  const logs = o.logs ?? [log(from, 0, 0), log(from, 0, 1), log(to, 0, 0)];
  return {
    providerGroup: o.providerGroup ?? 'provider-alpha',
    range: { fromBlock: BigInt(from), toBlock: BigInt(to) },
    startBlockHash: o.startBlockHash ?? hex32(from),
    endBlockHash: o.endBlockHash ?? hex32(to),
    logCount: o.logCount ?? logs.length,
    logs,
    blocks,
    complete: o.complete ?? true,
    viaArchive: o.viaArchive ?? false,
  };
};
