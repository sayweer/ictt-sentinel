import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAmount } from '@ictt-sentinel/domain';
import { ingestBatch, type IngestBatch } from '@ictt-sentinel/storage-postgres';
import {
  CHAIN,
  DEPLOYMENT,
  createTestDatabase,
  hex20,
  hex32,
  seedReference,
  type TestDatabase,
} from './harness.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('budget');
  await seedReference(db.migrator);
}, 60_000);

afterAll(async () => db.drop());

const AT = new Date('2026-06-01T00:00:00.000Z');
const amount = parseAmount(1_000n);
if (!amount.ok) throw new Error(amount.error);

describe('bounded PostgreSQL resource budget', () => {
  it('ingests 1000 accepted facts within the local time and database-growth budget', async () => {
    const rows = await db.runtime.sql<{ bytes: bigint }[]>`
      select pg_database_size(current_database())::bigint as bytes
    `;
    const before = rows[0]?.bytes ?? 0n;
    const count = 1_000;
    const batch: IngestBatch = {
      deploymentId: DEPLOYMENT,
      chainKey: CHAIN,
      blocks: Array.from({ length: count }, (_, index) => ({
        chainKey: CHAIN,
        blockHash: hex32(10_000 + index),
        blockNumber: BigInt(10_000 + index),
        parentHash: hex32(9_999 + index),
        blockTimestamp: 1_780_272_000n + BigInt(index),
        observedClass: 'accepted' as const,
        observedAt: AT,
      })),
      logs: Array.from({ length: count }, (_, index) => ({
        chainKey: CHAIN,
        blockHash: hex32(10_000 + index),
        txHash: hex32(20_000 + index),
        logIndex: 0,
        blockNumber: BigInt(10_000 + index),
        txIndex: 0,
        address: hex20(7),
        topics: [hex32(1)],
        data: '0x',
        observedAt: AT,
      })),
      observations: Array.from({ length: count }, (_, index) => ({
        observationId: `budget-${String(index).padStart(4, '0')}`,
        deploymentId: DEPLOYMENT,
        chainKey: CHAIN,
        blockHash: hex32(10_000 + index),
        blockNumber: BigInt(10_000 + index),
        subject: 'home.transferred-balance',
        amount: amount.value,
        finalityBasis: 'accepted-quorum',
        providerGroups: ['provider-alpha', 'provider-beta'],
        payloadDigest: hex32(30_000 + index).slice(2),
        observedAt: AT,
        expiresAt: new Date(AT.getTime() + 60_000),
      })),
    };

    const started = performance.now();
    const result = await ingestBatch(db.runtime, batch);
    const elapsedMs = performance.now() - started;
    const afterRows = await db.runtime.sql<{ bytes: bigint }[]>`
      select pg_database_size(current_database())::bigint as bytes
    `;
    const growthBytes = (afterRows[0]?.bytes ?? before) - before;

    expect(result.blocksInserted).toBe(count);
    expect(result.logsInserted).toBe(count);
    expect(result.observationsInserted).toBe(count);
    expect(elapsedMs).toBeLessThan(5_000);
    expect(growthBytes).toBeLessThan(32n * 1024n * 1024n);
  }, 15_000);
});
