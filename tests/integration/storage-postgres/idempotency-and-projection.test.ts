import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAmount } from '@ictt-sentinel/domain';
import {
  IdempotencyConflictError,
  type EvaluationRecord,
  type IngestBatch,
  appendVerdictEvent,
  ingestBatch,
  putEvaluation,
  readTransferTotals,
  rebuildTransferTotals,
} from '@ictt-sentinel/storage-postgres';
import {
  CHAIN,
  DEPLOYMENT,
  createTestDatabase,
  digest,
  hex20,
  hex32,
  seedReference,
} from './harness.js';
import type { TestDatabase } from './harness.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('eval');
  await seedReference(db.migrator);
}, 60_000);

afterAll(async () => {
  await db.drop();
});

const AT = new Date('2026-03-01T00:00:00Z');
const amount = (v: bigint) => {
  const p = parseAmount(v);
  if (!p.ok) throw new Error(p.error);
  return p.value;
};

const facts = (
  n: number,
  value: bigint,
  cls: 'accepted' | 'candidate' = 'accepted',
): IngestBatch => ({
  deploymentId: DEPLOYMENT,
  chainKey: CHAIN,
  blocks: [
    {
      chainKey: CHAIN,
      blockHash: hex32(n),
      blockNumber: BigInt(n),
      parentHash: hex32(n - 1),
      blockTimestamp: 1_700_000_000n + BigInt(n),
      observedClass: cls,
      observedAt: AT,
    },
  ],
  logs: [
    {
      chainKey: CHAIN,
      blockHash: hex32(n),
      txHash: hex32(500_000 + n),
      logIndex: 0,
      blockNumber: BigInt(n),
      txIndex: 0,
      address: hex20(7),
      topics: [hex32(1)],
      data: '0x',
      observedAt: AT,
    },
  ],
  observations: [
    {
      observationId: `obs-${String(n)}`,
      deploymentId: DEPLOYMENT,
      chainKey: CHAIN,
      blockHash: hex32(n),
      blockNumber: BigInt(n),
      subject: 'home.transferred-balance',
      amount: amount(value),
      finalityBasis: 'accepted-quorum',
      providerGroups: ['provider-alpha', 'provider-beta'],
      payloadDigest: digest(`e${String(n)}`),
      observedAt: AT,
      expiresAt: new Date(AT.getTime() + 60_000),
    },
  ],
});

const record = (verdict: EvaluationRecord['verdict'], payloadDigest: string): EvaluationRecord => ({
  deploymentId: DEPLOYMENT,
  subject: 'home.transferred-balance',
  policyVersion: 'policy-1',
  adapterVersion: 'adapter-1',
  pinnedBlocks: [{ chainKey: CHAIN, blockNumber: 100n, blockHash: hex32(100) }],
  inputObservationDigests: [digest('e101'), digest('e102')],
  verdict,
  payloadDigest,
});

describe('evaluation idempotency', () => {
  it('writes once and treats the identical retry as a no-op', async () => {
    const first = await putEvaluation(db.runtime, record('OK', digest('p1')));
    expect(first.inserted).toBe(true);

    const retry = await putEvaluation(db.runtime, record('OK', digest('p1')));
    expect(retry.inserted).toBe(false);
    expect(retry.evaluationId).toBe(first.evaluationId);

    const rows = await db.runtime.sql<{ n: string }[]>`
      select count(*)::text as n from evaluations where idempotency_key = ${first.idempotencyKey}
    `;
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('rejects the same key carrying a different payload instead of overwriting', async () => {
    await expect(putEvaluation(db.runtime, record('OK', digest('p2')))).rejects.toThrow(
      IdempotencyConflictError,
    );
    // The stored verdict is untouched; the disagreement is surfaced, not resolved.
    const rows = await db.runtime.sql<{ payload_digest: string }[]>`
      select payload_digest from evaluations where subject = 'home.transferred-balance'
    `;
    expect(rows.map((r) => r.payload_digest)).toEqual([digest('p1')]);
  });

  it('stores UNKNOWN as UNKNOWN', async () => {
    const unknown = await putEvaluation(db.runtime, {
      ...record('UNKNOWN', digest('p3')),
      subject: 'remote.census-completeness',
    });
    await appendVerdictEvent(db.runtime, {
      eventId: 'ev-1',
      evaluationId: unknown.evaluationId,
      verdict: 'UNKNOWN',
      reasonCode: 'DAT-002',
      detail: { note: 'pruned history' },
    });
    const rows = await db.runtime.sql<{ verdict: string }[]>`
      select verdict from evaluations where evaluation_id = ${unknown.evaluationId}
    `;
    expect(rows[0]?.verdict).toBe('UNKNOWN');
    // Nothing in the schema can turn it into OK on the way out.
    expect(rows[0]?.verdict).not.toBe('OK');
  });

  it('refuses an evaluation with no pinned block', async () => {
    await expect(
      db.runtime.sql.unsafe(
        `insert into evaluations
           (evaluation_id, idempotency_key, deployment_id, subject, policy_version, adapter_version,
            pinned_blocks, input_digest, verdict, payload_digest)
         values ('${'a'.repeat(64)}', '${'a'.repeat(64)}', '${DEPLOYMENT}', 'x', 'p', 'a',
                 '[]'::jsonb, '${digest('bb')}', 'OK', '${digest('cc')}')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('projection rebuild', () => {
  beforeAll(async () => {
    await ingestBatch(db.runtime, facts(101, 1_000n));
    await ingestBatch(db.runtime, facts(102, 2_500n));
    // A candidate observation that must never reach a read model.
    await ingestBatch(db.runtime, facts(103, 9_999_999n, 'candidate'));
  });

  it('rebuilds from raw facts and excludes candidate blocks', async () => {
    const built = await rebuildTransferTotals(db.runtime, { deploymentId: DEPLOYMENT, version: 1 });
    expect(built.rows).toBe(1);

    const rows = await readTransferTotals(db.runtime, { deploymentId: DEPLOYMENT, version: 1 });
    expect(rows).toHaveLength(1);
    // 1000 + 2500. The 9,999,999 candidate is filtered in the source query.
    expect(rows[0]?.totalAmount as bigint).toBe(3_500n);
    expect(rows[0]?.observationCount).toBe(2n);
  });

  it('is deterministic: a second rebuild gives the same digest', async () => {
    const a = await rebuildTransferTotals(db.runtime, { deploymentId: DEPLOYMENT, version: 1 });
    const b = await rebuildTransferTotals(db.runtime, { deploymentId: DEPLOYMENT, version: 1 });
    expect(b.sourceDigest).toBe(a.sourceDigest);
  });

  it('rebuilds at v2 from the same facts with the same source digest', async () => {
    const v1 = await rebuildTransferTotals(db.runtime, { deploymentId: DEPLOYMENT, version: 1 });
    const v2 = await rebuildTransferTotals(db.runtime, { deploymentId: DEPLOYMENT, version: 2 });

    // The projection version changed; what it was derived from did not.
    expect(v2.sourceDigest).toBe(v1.sourceDigest);
    expect(v2.version).toBe(2);

    const rowsV1 = await readTransferTotals(db.runtime, { deploymentId: DEPLOYMENT, version: 1 });
    const rowsV2 = await readTransferTotals(db.runtime, { deploymentId: DEPLOYMENT, version: 2 });
    expect(rowsV2.map((r) => r.totalAmount as bigint)).toEqual(
      rowsV1.map((r) => r.totalAmount as bigint),
    );

    // v1 survives the v2 build, so a rollback needs no second rebuild.
    expect(rowsV1).toHaveLength(1);
  });

  it('reflects new facts and changes the digest', async () => {
    const before = await rebuildTransferTotals(db.runtime, {
      deploymentId: DEPLOYMENT,
      version: 2,
    });
    await ingestBatch(db.runtime, facts(104, 500n));
    const after = await rebuildTransferTotals(db.runtime, { deploymentId: DEPLOYMENT, version: 2 });

    expect(after.sourceDigest).not.toBe(before.sourceDigest);
    const rows = await readTransferTotals(db.runtime, { deploymentId: DEPLOYMENT, version: 2 });
    expect(rows[0]?.totalAmount as bigint).toBe(4_000n);
  });

  it('records the projection version it last rebuilt', async () => {
    const rows = await db.runtime.sql<{ version: number; source_digest: string }[]>`
      select version, source_digest from projection_versions where projection_name = 'transfer_totals'
    `;
    expect(Number(rows[0]?.version)).toBe(2);
    expect(rows[0]?.source_digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
