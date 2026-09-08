import { readFileSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  assertSendable,
  buildRequest,
  checkEndpointUrl,
  DEFAULT_TRANSPORT_POLICY,
  jsonDepth,
  type ReadOperation,
} from '@ictt-sentinel/rpc-quorum';
import { createDb } from '@ictt-sentinel/storage-postgres';
import type { Endpoint, Policy } from '@ictt-sentinel/config';

export class InputError extends Error {}
export class ReadFailure extends Error {}

/** Only explicit, non-secret input files enter this boundary. */
export const readDocument = (path: string): string => {
  if (/(^|\/)\.env($|\.)/.test(path) || statSync(path).size > 16 * 1024 * 1024)
    throw new InputError('Input file refused.');
  return readFileSync(path, 'utf8');
};
export const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new InputError('Expected object.');
  return value as Record<string, unknown>;
};
export const hexQuantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]*)$/.test(value) || value.length > 66)
    throw new ReadFailure('Invalid RPC quantity.');
  return BigInt(value);
};
export const bytes32 = (value: unknown): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value))
    throw new ReadFailure('Invalid bytes32.');
  return value;
};
export interface Pin {
  readonly blockchainId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
}
export const decodePins = (value: unknown): readonly Pin[] => {
  if (!Array.isArray(value) || value.length < 2 || value.length > 33)
    throw new InputError('Expected a bounded pin array.');
  const pins = value.map((v: unknown) => {
    const p = object(v);
    if (
      Object.keys(p).sort().join(',') !== 'blockHash,blockNumber,blockchainId' ||
      typeof p['blockNumber'] !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(p['blockNumber']) ||
      p['blockNumber'].length > 78
    )
      throw new InputError('Invalid explicit pin.');
    return {
      blockchainId: bytes32(p['blockchainId']),
      blockNumber: p['blockNumber'],
      blockHash: bytes32(p['blockHash']),
    };
  });
  if (new Set(pins.map((p) => p.blockchainId)).size !== pins.length)
    throw new InputError('Duplicate pin.');
  return pins;
};

export interface Runtime {
  read(endpoint: Endpoint, operation: ReadOperation, signal: AbortSignal): Promise<unknown>;
  database(signal: AbortSignal): Promise<boolean>;
  now(): number;
}

/** No generic RPC passthrough. Transport failures never carry endpoint values. */
export const createRuntime = (
  env: Readonly<Record<string, string | undefined>>,
  policy: Policy,
  fetcher: typeof fetch = fetch,
): Runtime => {
  const timeout = policy.spec.dataPath.requestTimeoutMs;
  return {
    now: Date.now,
    read: async (endpoint, operation, signal) => {
      const url = env[endpoint.secretRef];
      if (url === undefined || !checkEndpointUrl(url, DEFAULT_TRANSPORT_POLICY).ok)
        throw new ReadFailure('Endpoint unavailable.');
      const request = buildRequest(operation);
      assertSendable(request.method);
      for (let attempt = 0; attempt <= policy.spec.dataPath.maxRetries; attempt++) {
        signal.throwIfAborted();
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, timeout);
        try {
          const response = await fetcher(url, {
            method: 'POST',
            redirect: 'error',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...request }),
            signal: AbortSignal.any([signal, controller.signal]),
          });
          if (!response.ok || response.body === null) throw new ReadFailure('RPC unavailable.');
          const reader = response.body.getReader();
          let length = 0;
          const chunks: Uint8Array[] = [];
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              const chunk: unknown = next.value;
              if (!(chunk instanceof Uint8Array)) throw new ReadFailure('Invalid response chunk.');
              length += chunk.byteLength;
              if (length > DEFAULT_TRANSPORT_POLICY.maxResponseBytes)
                throw new ReadFailure('Response too large.');
              chunks.push(chunk);
            }
          } finally {
            await reader.cancel();
          }
          const decoded = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          if (
            decoded['jsonrpc'] !== '2.0' ||
            decoded['id'] !== 1 ||
            decoded['error'] !== undefined ||
            !('result' in decoded) ||
            jsonDepth(decoded) > DEFAULT_TRANSPORT_POLICY.maxJsonDepth
          )
            throw new ReadFailure('RPC response rejected.');
          return decoded['result'];
        } catch {
          signal.throwIfAborted();
          if (attempt === policy.spec.dataPath.maxRetries)
            throw new ReadFailure('RPC unavailable or timed out.');
        } finally {
          clearTimeout(timer);
        }
        await delay(policy.spec.dataPath.retryBackoffMs * 2 ** attempt, undefined, { signal });
      }
      throw new ReadFailure('RPC unavailable.');
    },
    database: async (signal) => {
      const dsn = env['DATABASE_URL'];
      if (!dsn) return false;
      const db = createDb(dsn, {
        max: 1,
        statementTimeoutSeconds: Math.max(1, Math.ceil(timeout / 1000)),
      });
      const query = db.sql`select to_regclass('chain_logs') is not null and to_regclass('evaluations') is not null and to_regclass('schema_migrations') is not null as ready`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        query.cancel();
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        signal.throwIfAborted();
        const rows = await Promise.race([
          query,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              cancel();
              reject(new ReadFailure('Database timeout.'));
            }, timeout);
          }),
        ]);
        signal.throwIfAborted();
        return rows[0]?.['ready'] === true;
      } catch {
        signal.throwIfAborted();
        return false;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        await db.close();
      }
    },
  };
};

/** Transitive shared domain OR provider means one failure domain. */
export const independentCount = (
  endpoints: readonly Pick<Endpoint, 'trustDomain' | 'providerGroup'>[],
): number => {
  const groups: { domains: Set<string>; providers: Set<string> }[] = [];
  for (const ep of endpoints) {
    const joined = groups.filter(
      (g) => g.domains.has(ep.trustDomain) || g.providers.has(ep.providerGroup),
    );
    const merged = { domains: new Set([ep.trustDomain]), providers: new Set([ep.providerGroup]) };
    for (const g of joined) {
      for (const d of g.domains) merged.domains.add(d);
      for (const p of g.providers) merged.providers.add(p);
      groups.splice(groups.indexOf(g), 1);
    }
    groups.push(merged);
  }
  return groups.length;
};
