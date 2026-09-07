import type { BlockFact, LogFact } from '@ictt-sentinel/storage-postgres';
import type { BlockRange, FetchOutcome, LogSourcePort, ReplayReason } from '@ictt-sentinel/replay';
import { CHAIN, hex20, hex32 } from '../storage-postgres/harness.js';

/**
 * A deterministic chain and a fake log source.
 *
 * Fake, not a mock of the thing under test: the engine's own decisions - agree,
 * split, block, commit - all run for real against a real PostgreSQL. What is
 * substituted is only the network, so each failure mode (truncation, divergence,
 * pruned history) can be produced exactly instead of hoped for.
 */

export const AT = new Date('2026-05-01T00:00:00Z');

export const blockAt = (n: number, over: Partial<BlockFact> = {}): BlockFact => ({
  chainKey: CHAIN,
  blockHash: hex32(n),
  blockNumber: BigInt(n),
  parentHash: hex32(n - 1),
  blockTimestamp: 1_700_000_000n + BigInt(n),
  observedClass: 'accepted',
  observedAt: AT,
  ...over,
});

export const logAt = (n: number, logIndex: number, over: Partial<LogFact> = {}): LogFact => ({
  chainKey: CHAIN,
  blockHash: hex32(n),
  txHash: hex32(700_000 + n),
  logIndex,
  blockNumber: BigInt(n),
  txIndex: 0,
  address: hex20(7),
  topics: [hex32(1)],
  data: '0x',
  observedAt: AT,
  ...over,
});

export interface FakeSourceOptions {
  readonly head: bigint;
  readonly groups: readonly string[];
  readonly maxRangeBlocks: number;
  /** Per-group scripted failures, keyed by `from-to`. */
  readonly failures?: Readonly<Record<string, Readonly<Record<string, ReplayReason>>>>;
  /** Groups whose block hash at a height differs, to produce divergence. */
  readonly divergentGroups?: readonly string[];
  /** Groups answering through an archive endpoint. */
  readonly archiveGroups?: readonly string[];
  /** Heights the source reports as candidate rather than accepted. */
  readonly candidateHeights?: readonly number[];
  /** Ranges wider than this fail once, to exercise adaptive splitting. */
  readonly failWiderThan?: number;
}

const key = (r: BlockRange): string => `${r.fromBlock.toString(10)}-${r.toBlock.toString(10)}`;

/**
 * Build a source over heights 1..head where every height has exactly one log.
 * `divergentGroups` see a different block hash, which is what a contested chain
 * view looks like from the engine's side.
 */
export const fakeSource = (opts: FakeSourceOptions): LogSourcePort => {
  const divergent = new Set(opts.divergentGroups ?? []);
  const archive = new Set(opts.archiveGroups ?? []);
  const candidates = new Set(opts.candidateHeights ?? []);

  return {
    agreedAcceptedHead: () => Promise.resolve(opts.head),
    providerGroups: () => opts.groups,
    maxRangeBlocks: () => opts.maxRangeBlocks,
    fetchRange: (_chainKey: string, providerGroup: string, range: BlockRange) => {
      const scripted = opts.failures?.[providerGroup]?.[key(range)];
      if (scripted) {
        return Promise.resolve<FetchOutcome>({ ok: false, reason: scripted, providerGroup });
      }
      if (
        opts.failWiderThan !== undefined &&
        range.toBlock - range.fromBlock + 1n > BigInt(opts.failWiderThan)
      ) {
        // What a provider limit actually looks like: a short answer, no error.
        return Promise.resolve<FetchOutcome>({
          ok: false,
          reason: 'SILENT_TRUNCATION',
          providerGroup,
        });
      }

      const blocks: BlockFact[] = [];
      const logs: LogFact[] = [];
      for (let h = range.fromBlock; h <= range.toBlock; h += 1n) {
        const n = Number(h);
        const hash = divergent.has(providerGroup) ? hex32(n + 500_000) : hex32(n);
        blocks.push(
          blockAt(n, {
            blockHash: hash,
            observedClass: candidates.has(n) ? 'candidate' : 'accepted',
          }),
        );
        logs.push(logAt(n, 0, { blockHash: hash }));
      }
      const first = blocks[0];
      const last = blocks.at(-1);
      if (!first || !last) throw new Error('empty range in fixture');

      return Promise.resolve<FetchOutcome>({
        ok: true,
        observation: {
          providerGroup,
          range,
          startBlockHash: first.blockHash,
          endBlockHash: last.blockHash,
          logCount: logs.length,
          logs,
          blocks,
          complete: true,
          viaArchive: archive.has(providerGroup),
        },
      });
    },
  };
};
