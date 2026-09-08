import type { Endpoint } from '@ictt-sentinel/config';
import type { FetchOutcome, LogSourcePort } from '@ictt-sentinel/replay';
import type { BlockRange } from '@ictt-sentinel/replay';
import type { BlockFact, LogFact } from '@ictt-sentinel/storage-postgres';
import { assertLogRange, type ReadOperation } from '@ictt-sentinel/rpc-quorum';

/**
 * The agent's log source.
 *
 * Implements the replay engine's narrow read port over the query-only RPC
 * surface. Note what this file cannot express: there is no generic
 * `request(method, params)` here, only the domain operations
 * `@ictt-sentinel/rpc-quorum` allows, and the transport is injected so this
 * module opens no socket of its own (CLAUDE.md 3).
 *
 * Every value that reaches a fact is decoded and shape-checked. A provider is
 * an untrusted input: a malformed hex quantity is a refusal with a typed reason,
 * never a coerced number and never a silently skipped log. "Fewer logs than
 * really happened" is indistinguishable from "nothing happened", and that
 * mistake is exactly what this product exists to catch.
 */

export type EndpointRead = (
  endpoint: Endpoint,
  operation: ReadOperation,
  signal: AbortSignal,
) => Promise<unknown>;

export interface ChainWiring {
  readonly chainKey: string;
  /** Endpoints grouped by independent provider group, in policy order. */
  readonly endpoints: readonly Endpoint[];
  readonly maxRangeBlocks: number;
}

export interface LogSourceOptions {
  readonly chains: readonly ChainWiring[];
  readonly read: EndpointRead;
  readonly signal: AbortSignal;
  readonly now: () => Date;
}

const HEX_QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX20 = /^0x[0-9a-f]{40}$/;
const HEX_DATA = /^0x([0-9a-f]{2})*$/;

class DecodeError extends Error {
  override readonly name = 'DecodeError';
}

const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !HEX_QUANTITY.test(value) || value.length > 66) {
    throw new DecodeError('invalid RPC quantity');
  }
  return BigInt(value);
};

const smallQuantity = (value: unknown): number => {
  const v = quantity(value);
  // Log and transaction indices are small by construction. A value that does not
  // fit is a malformed provider response, not a very busy block.
  if (v > 1_000_000n) throw new DecodeError('index out of range');
  return Number(v);
};

const hash32 = (value: unknown): string => {
  if (typeof value !== 'string' || !HEX32.test(value)) throw new DecodeError('invalid bytes32');
  return value;
};

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DecodeError('expected an object');
  }
  return value as Record<string, unknown>;
};

const decodeBlock = (chainKey: string, value: unknown, observedAt: Date): BlockFact => {
  const b = object(value);
  return {
    chainKey,
    blockHash: hash32(b['hash']),
    blockNumber: quantity(b['number']),
    parentHash: hash32(b['parentHash']),
    blockTimestamp: quantity(b['timestamp']),
    // Only accepted blocks become facts. A candidate observation can never be
    // promoted here, which is why the class is a constant and not a parameter.
    observedClass: 'accepted',
    observedAt,
  };
};

const decodeLog = (chainKey: string, value: unknown, observedAt: Date): LogFact => {
  const l = object(value);
  if (l['removed'] === true) throw new DecodeError('provider returned a removed log');
  const topics = l['topics'];
  if (!Array.isArray(topics) || topics.length > 4) throw new DecodeError('invalid topic set');
  const address = l['address'];
  if (typeof address !== 'string' || !HEX20.test(address)) {
    throw new DecodeError('invalid log address');
  }
  const data = l['data'];
  if (typeof data !== 'string' || !HEX_DATA.test(data)) throw new DecodeError('invalid log data');
  return {
    chainKey,
    blockHash: hash32(l['blockHash']),
    txHash: hash32(l['transactionHash']),
    logIndex: smallQuantity(l['logIndex']),
    blockNumber: quantity(l['blockNumber']),
    txIndex: smallQuantity(l['transactionIndex']),
    address,
    topics: topics.map((t: unknown) => hash32(t)),
    data,
    observedAt,
  };
};

/**
 * Group endpoints by their independence unit.
 *
 * Quorum counts distinct provider groups, never URLs: two endpoints sharing an
 * upstream are one witness, and treating them as two is the single most
 * expensive way to be wrong here (docs/adr/0002-accepted-quorum-truth.md).
 */
const byGroup = (endpoints: readonly Endpoint[]): Map<string, readonly Endpoint[]> => {
  const groups = new Map<string, Endpoint[]>();
  for (const e of endpoints) {
    const existing = groups.get(e.providerGroup);
    if (existing === undefined) groups.set(e.providerGroup, [e]);
    else existing.push(e);
  }
  return groups;
};

export const createLogSource = (options: LogSourceOptions): LogSourcePort => {
  const wiring = new Map(options.chains.map((c) => [c.chainKey, c]));
  const groupsFor = new Map(options.chains.map((c) => [c.chainKey, byGroup(c.endpoints)]));

  const endpointsOf = (chainKey: string, group: string): readonly Endpoint[] =>
    groupsFor.get(chainKey)?.get(group) ?? [];

  const readOne = async (chainKey: string, group: string, op: ReadOperation): Promise<unknown> => {
    const endpoints = endpointsOf(chainKey, group);
    let lastError: unknown = new DecodeError('no endpoint in this provider group');
    for (const endpoint of endpoints) {
      try {
        return await options.read(endpoint, op, options.signal);
      } catch (e) {
        // Try the next URL in the SAME group. This is redundancy inside one
        // witness, not a second witness: the group still counts once.
        lastError = e;
      }
    }
    throw lastError;
  };

  return {
    /**
     * The head every independent group already agrees on.
     *
     * The minimum across groups, not the maximum and not any single provider's
     * answer: a height one witness has not seen is a height this product has no
     * business treating as history.
     */
    agreedAcceptedHead: async (chainKey) => {
      const groups = [...(groupsFor.get(chainKey)?.keys() ?? [])];
      if (groups.length === 0) throw new DecodeError('no provider group configured');
      let agreed: bigint | null = null;
      for (const group of groups) {
        const head = quantity(await readOne(chainKey, group, { op: 'head-block-number' }));
        agreed = agreed === null || head < agreed ? head : agreed;
      }
      if (agreed === null) throw new DecodeError('no head could be established');
      return agreed;
    },

    providerGroups: (chainKey) => [...(groupsFor.get(chainKey)?.keys() ?? [])],

    maxRangeBlocks: (chainKey) => wiring.get(chainKey)?.maxRangeBlocks ?? 1,

    fetchRange: async (chainKey, providerGroup, range: BlockRange): Promise<FetchOutcome> => {
      const observedAt = options.now();
      try {
        assertLogRange(range.fromBlock, range.toBlock, wiring.get(chainKey)?.maxRangeBlocks ?? 1);

        const rawLogs = await readOne(chainKey, providerGroup, {
          op: 'logs',
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        });
        if (!Array.isArray(rawLogs)) throw new DecodeError('log response is not an array');
        const logs = rawLogs.map((l: unknown) => decodeLog(chainKey, l, observedAt));

        // Every block that backs a log, plus the two range endpoints, because the
        // range digest binds the logs to the identity of its boundaries.
        const heights = new Set<bigint>([range.fromBlock, range.toBlock]);
        for (const log of logs) heights.add(log.blockNumber);
        const blocks: BlockFact[] = [];
        for (const height of [...heights].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
          const raw = await readOne(chainKey, providerGroup, {
            op: 'block-by-ref',
            ref: { kind: 'number', number: height },
            fullTransactions: false,
          });
          blocks.push(decodeBlock(chainKey, raw, observedAt));
        }

        const start = blocks.find((b) => b.blockNumber === range.fromBlock);
        const end = blocks.find((b) => b.blockNumber === range.toBlock);
        if (start === undefined || end === undefined) {
          // The provider answered without covering its own range bounds. That is
          // silent truncation, and it is refused rather than averaged over.
          return { ok: false, reason: 'SILENT_TRUNCATION', providerGroup };
        }
        // A log whose block was not returned means the response is internally
        // inconsistent; the range cannot be treated as covered.
        const known = new Set(blocks.map((b) => b.blockHash));
        if (logs.some((l) => !known.has(l.blockHash))) {
          return { ok: false, reason: 'MISSING_BLOCK', providerGroup };
        }

        return {
          ok: true,
          observation: {
            providerGroup,
            range,
            startBlockHash: start.blockHash,
            endBlockHash: end.blockHash,
            logCount: logs.length,
            logs,
            blocks,
            complete: true,
            viaArchive: endpointsOf(chainKey, providerGroup).some((e) => e.archiveDepth === 'full'),
          },
        };
      } catch (e) {
        return {
          ok: false,
          reason: e instanceof DecodeError ? 'EMPTY_RESPONSE_AMBIGUITY' : 'RETRY_BUDGET_EXHAUSTED',
          providerGroup,
        };
      }
    },
  };
};
