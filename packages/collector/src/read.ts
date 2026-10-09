import type { Endpoint } from '@ictt-sentinel/config';
import { canonicalStringify } from '@ictt-sentinel/evidence';
import type { ChainReader } from './probe.js';
import { bytes32, hexQuantity, object } from './values.js';

/**
 * What one witness reports for one chain at one pin.
 *
 * Plain strings throughout, so two witnesses' readings can be compared byte for
 * byte. Nothing here interprets an event: logs are checked for shape and for
 * belonging to the query that asked for them, and nothing more.
 */

export interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: number;
}

export interface LogQuery {
  readonly name: string;
  readonly address: string;
  /** topic0 followed by optional exact topics; null means any. */
  readonly topics: readonly (string | null)[];
  readonly fromBlock: bigint;
}

export interface CallQuery {
  readonly name: string;
  readonly to: string;
  readonly data: string;
}

export interface ChainReading {
  readonly pin: {
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly timestamp: string;
  };
  readonly logs: Readonly<Record<string, readonly RawLog[]>>;
  /** Hash and timestamp of every block that carries a returned log. */
  readonly blocks: Readonly<Record<string, { readonly hash: string; readonly timestamp: string }>>;
  readonly calls: Readonly<Record<string, string>>;
}

export class CollectionBoundExceeded extends Error {
  override readonly name = 'CollectionBoundExceeded';
}

export class ReadingRefused extends Error {
  override readonly name = 'ReadingRefused';
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const HEX_DATA = /^0x([0-9a-f]{2})*$/;

const block = async (
  runtime: ChainReader,
  endpoint: Endpoint,
  number: bigint,
  signal: AbortSignal,
): Promise<{ hash: string; timestamp: bigint }> => {
  const b = object(
    await runtime.read(
      endpoint,
      { op: 'block-by-ref', ref: { kind: 'number', number }, fullTransactions: false },
      signal,
    ),
  );
  if (hexQuantity(b['number']) !== number) throw new ReadingRefused('block number mismatch');
  return { hash: bytes32(b['hash']), timestamp: hexQuantity(b['timestamp']) };
};

const decodeLog = (value: unknown, query: LogQuery, from: bigint, to: bigint): RawLog => {
  const l = object(value);
  const topics = l['topics'];
  const data = l['data'];
  const address = l['address'];
  const n = hexQuantity(l['blockNumber']);
  const logIndex = hexQuantity(l['logIndex']);
  if (
    l['removed'] !== false ||
    typeof address !== 'string' ||
    address.toLowerCase() !== query.address ||
    !Array.isArray(topics) ||
    topics.length === 0 ||
    topics.length > 4 ||
    !topics.every((t: unknown) => typeof t === 'string' && HEX32.test(t)) ||
    typeof data !== 'string' ||
    !HEX_DATA.test(data) ||
    n < from ||
    n > to ||
    logIndex > 1_000_000n
  )
    throw new ReadingRefused('log outside its query or malformed');
  // The provider must have applied the filter it was given; a log it should
  // not have returned means the answer cannot be trusted as complete either.
  query.topics.forEach((t, i) => {
    if (t !== null && topics[i] !== t) throw new ReadingRefused('log does not match its filter');
  });
  return {
    address: address.toLowerCase(),
    topics: topics as string[],
    data,
    blockNumber: n.toString(),
    blockHash: bytes32(l['blockHash']),
    transactionHash: bytes32(l['transactionHash']),
    logIndex: Number(logIndex),
  };
};

const order = (a: RawLog, b: RawLog): number => {
  const x = BigInt(a.blockNumber);
  const y = BigInt(b.blockNumber);
  return x === y ? a.logIndex - b.logIndex : x < y ? -1 : 1;
};

/**
 * Read one chain through one endpoint at a pin.
 *
 * Log scans run from each query's start block to the pin in windows no wider
 * than policy allows, and the whole reading is bounded by `maxLogs`: exceeding
 * it is a refusal, never a truncated answer.
 */
export const readChain = async (args: {
  readonly runtime: ChainReader;
  readonly endpoint: Endpoint;
  readonly pin: { readonly blockNumber: bigint; readonly blockHash: string };
  readonly logs: readonly LogQuery[];
  readonly calls: readonly CallQuery[];
  readonly maxRangeBlocks: number;
  readonly maxLogs: number;
  readonly signal: AbortSignal;
}): Promise<ChainReading> => {
  const { runtime, endpoint, pin, signal } = args;
  const pinned = await block(runtime, endpoint, pin.blockNumber, signal);
  if (pinned.hash !== pin.blockHash) throw new ReadingRefused('pinned hash differs');

  let total = 0;
  const logs: Record<string, RawLog[]> = {};
  for (const query of args.logs) {
    const found: RawLog[] = [];
    for (let from = query.fromBlock; from <= pin.blockNumber;) {
      signal.throwIfAborted();
      const span = BigInt(args.maxRangeBlocks) - 1n;
      const to = from + span < pin.blockNumber ? from + span : pin.blockNumber;
      const raw = await runtime.read(
        endpoint,
        { op: 'logs', fromBlock: from, toBlock: to, address: query.address, topics: query.topics },
        signal,
      );
      if (!Array.isArray(raw)) throw new ReadingRefused('log response is not an array');
      total += raw.length;
      if (total > args.maxLogs) throw new CollectionBoundExceeded('log bound exceeded');
      for (const value of raw) found.push(decodeLog(value, query, from, to));
      from = to + 1n;
    }
    logs[query.name] = found.sort(order);
  }

  const blocks: Record<string, { hash: string; timestamp: string }> = {};
  const heights = [...new Set(Object.values(logs).flatMap((l) => l.map((x) => x.blockNumber)))];
  for (const height of heights.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))) {
    const b = await block(runtime, endpoint, BigInt(height), signal);
    blocks[height] = { hash: b.hash, timestamp: b.timestamp.toString() };
  }
  // A log whose block hash is not the hash of its block is a contradiction
  // inside one provider's answer.
  for (const l of Object.values(logs).flat())
    if (blocks[l.blockNumber]?.hash !== l.blockHash)
      throw new ReadingRefused('log block hash differs');

  const calls: Record<string, string> = {};
  for (const call of args.calls) {
    const result = await runtime.read(
      endpoint,
      { op: 'call', to: call.to, data: call.data, at: { kind: 'number', number: pin.blockNumber } },
      signal,
    );
    if (typeof result !== 'string' || !HEX_DATA.test(result))
      throw new ReadingRefused('call result is not hex');
    calls[call.name] = result;
  }

  // The pin must still be the same block after everything was read.
  const after = await block(runtime, endpoint, pin.blockNumber, signal);
  if (after.hash !== pin.blockHash) throw new ReadingRefused('pinned hash changed during reading');

  return {
    pin: {
      blockNumber: pin.blockNumber.toString(),
      blockHash: pin.blockHash,
      timestamp: pinned.timestamp.toString(),
    },
    logs,
    blocks,
    calls,
  };
};

/**
 * Agreement among independent witnesses' readings.
 *
 * Byte-identical or nothing: two readers that disagree on anything are not a
 * quorum with a minority, they are evidence the chain view is not settled
 * (policy `onDisagreement: UNKNOWN`).
 */
export const agreeOnReadings = <K>(
  readings: readonly { readonly witness: K; readonly reading: ChainReading }[],
  required: number,
):
  | { readonly ok: true; readonly reading: ChainReading; readonly witnesses: readonly K[] }
  | { readonly ok: false; readonly reason: 'divergent' | 'insufficient' } => {
  const distinct = new Set(readings.map((r) => canonicalStringify(r.reading)));
  const first = readings[0];
  if (distinct.size > 1) return { ok: false, reason: 'divergent' };
  if (first === undefined || readings.length < required)
    return { ok: false, reason: 'insufficient' };
  return { ok: true, reading: first.reading, witnesses: readings.map((r) => r.witness) };
};
