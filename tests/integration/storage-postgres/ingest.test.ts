import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_UINT256, parseAmount } from '@ictt-sentinel/domain';
import {
  AcceptedHashConflictError,
  type BlockFact,
  type IngestBatch,
  type LogFact,
  type ObservationFact,
  ingestBatch,
  readCheckpoint,
  recordCandidateOrphan,
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
  db = await createTestDatabase('ingest');
  await seedReference(db.migrator);
}, 60_000);

afterAll(async () => {
  await db.drop();
});

const AT = new Date('2026-02-01T00:00:00Z');

const block = (n: number, opts: Partial<BlockFact> = {}): BlockFact => ({
  chainKey: CHAIN,
  blockHash: hex32(n),
  blockNumber: BigInt(n),
  parentHash: hex32(n - 1),
  blockTimestamp: 1_700_000_000n + BigInt(n),
  observedClass: 'accepted',
  observedAt: AT,
  ...opts,
});

const logOf = (n: number, txIndex: number, logIndex: number): LogFact => ({
  chainKey: CHAIN,
  blockHash: hex32(n),
  txHash: hex32(100_000 + n * 10 + txIndex),
  logIndex,
  blockNumber: BigInt(n),
  txIndex,
  address: hex20(7),
  topics: [hex32(1), hex32(2)],
  data: '0x00',
  observedAt: AT,
});

const amount = (v: bigint) => {
  const p = parseAmount(v);
  if (!p.ok) throw new Error(p.error);
  return p.value;
};

const observation = (n: number, subject: string, value: bigint): ObservationFact => ({
  observationId: `obs-${String(n)}-${subject}`,
  deploymentId: DEPLOYMENT,
  chainKey: CHAIN,
  blockHash: hex32(n),
  blockNumber: BigInt(n),
  subject,
  amount: amount(value),
  finalityBasis: 'accepted-quorum',
  providerGroups: ['provider-alpha', 'provider-beta'],
  payloadDigest: digest(`d${String(n)}`),
  observedAt: AT,
  expiresAt: new Date(AT.getTime() + 60_000),
});

const batchAt = (n: number): IngestBatch => ({
  deploymentId: DEPLOYMENT,
  chainKey: CHAIN,
  blocks: [block(n)],
  logs: [logOf(n, 0, 0), logOf(n, 0, 1), logOf(n, 1, 0)],
  checkpoint: {
    deploymentId: DEPLOYMENT,
    chainKey: CHAIN,
    lastBlockNumber: BigInt(n),
    lastBlockHash: hex32(n),
  },
});

const countLogs = async (): Promise<number> => {
  const rows = await db.runtime.sql<{ n: string }[]>`select count(*)::text as n from chain_logs`;
  return Number(rows[0]?.n ?? '-1');
};

describe('duplicate and concurrent ingest', () => {
  it('inserts a batch once, and the identical retry changes nothing', async () => {
    const first = await ingestBatch(db.runtime, batchAt(10));
    expect(first.blocksInserted).toBe(1);
    expect(first.logsInserted).toBe(3);
    expect(first.checkpointAdvanced).toBe(true);

    const retry = await ingestBatch(db.runtime, batchAt(10));
    expect(retry.blocksInserted).toBe(0);
    expect(retry.logsInserted).toBe(0);
    // Same facts, so the same digest: this is the reproducibility promise.
    expect(retry.rangeDigest).toBe(first.rangeDigest);
    // The checkpoint does not move backwards or re-fire for work already covered.
    expect(retry.checkpointAdvanced).toBe(false);
    expect(await countLogs()).toBe(3);
  });

  it('gives one canonical fact set when two workers race the same batch', async () => {
    const a = db.connectRuntime();
    const b = db.connectRuntime();
    const [ra, rb] = await Promise.all([ingestBatch(a, batchAt(20)), ingestBatch(b, batchAt(20))]);

    // Whoever wins the advisory lock does the work; the other sees it already done.
    expect(ra.logsInserted + rb.logsInserted).toBe(3);
    expect(ra.blocksInserted + rb.blocksInserted).toBe(1);

    const rows = await db.runtime.sql<{ n: string }[]>`
      select count(*)::text as n from chain_logs where block_number = '20'
    `;
    expect(Number(rows[0]?.n)).toBe(3);
  });

  it('produces the same digest when the same facts arrive in a different order', async () => {
    const forward = batchAt(30);
    const reversed: IngestBatch = { ...forward, logs: [...forward.logs].reverse() };
    const first = await ingestBatch(db.runtime, forward);
    const second = await ingestBatch(db.runtime, reversed);
    expect(second.rangeDigest).toBe(first.rangeDigest);
    expect(second.logsInserted).toBe(0);
  });
});

describe('atomicity and checkpoint discipline', () => {
  it('writes all logs of a transaction or none of them', async () => {
    const before = await countLogs();
    const broken: IngestBatch = {
      deploymentId: DEPLOYMENT,
      chainKey: CHAIN,
      blocks: [block(40)],
      // The third log points at a block that is not in the batch, so the foreign
      // key fails after two logs have already been inserted in this transaction.
      logs: [logOf(40, 0, 0), logOf(40, 0, 1), { ...logOf(40, 1, 0), blockHash: hex32(999) }],
      checkpoint: {
        deploymentId: DEPLOYMENT,
        chainKey: CHAIN,
        lastBlockNumber: 40n,
        lastBlockHash: hex32(40),
      },
    };
    await expect(ingestBatch(db.runtime, broken)).rejects.toThrow();
    expect(await countLogs()).toBe(before);

    const cp = await readCheckpoint(db.runtime, DEPLOYMENT, CHAIN);
    // The checkpoint never reached 40: a partial transaction cannot advance it.
    expect(cp?.lastBlockNumber).toBe(30n);
  });

  it('does not advance the checkpoint when the crash happens before commit', async () => {
    const before = await readCheckpoint(db.runtime, DEPLOYMENT, CHAIN);
    await expect(
      db.runtime.sql.begin(async (tx) => {
        await tx`
          insert into chain_blocks
            (chain_key, block_hash, block_number, parent_hash, block_timestamp, observed_class, observed_at)
          values (${CHAIN}, ${hex32(50)}, '50', ${hex32(49)}, '1700000050', 'accepted', now())
        `;
        await tx`
          update replay_checkpoints set last_block_number = '50', last_block_hash = ${hex32(50)}
          where deployment_id = ${DEPLOYMENT} and chain_key = ${CHAIN}
        `;
        // Process dies here, after both writes but before COMMIT.
        throw new Error('simulated crash before commit');
      }),
    ).rejects.toThrow('simulated crash before commit');

    const after = await readCheckpoint(db.runtime, DEPLOYMENT, CHAIN);
    expect(after?.lastBlockNumber).toBe(before?.lastBlockNumber);
    const rows = await db.runtime.sql<{ n: string }[]>`
      select count(*)::text as n from chain_blocks where block_number = '50'
    `;
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('resumes deterministically from the last committed checkpoint after a crash', async () => {
    await ingestBatch(db.runtime, batchAt(60));
    const resumed = await readCheckpoint(db.runtime, DEPLOYMENT, CHAIN);
    expect(resumed).toEqual({ lastBlockNumber: 60n, lastBlockHash: hex32(60) });

    // Replaying the already-covered range is safe and produces no new facts.
    const replay = await ingestBatch(db.runtime, batchAt(60));
    expect(replay.logsInserted).toBe(0);
    expect((await readCheckpoint(db.runtime, DEPLOYMENT, CHAIN))?.lastBlockNumber).toBe(60n);
  });

  it('never moves the checkpoint backwards', async () => {
    const stale: IngestBatch = {
      ...batchAt(10),
      checkpoint: {
        deploymentId: DEPLOYMENT,
        chainKey: CHAIN,
        lastBlockNumber: 10n,
        lastBlockHash: hex32(10),
      },
    };
    const result = await ingestBatch(db.runtime, stale);
    expect(result.checkpointAdvanced).toBe(false);
    expect((await readCheckpoint(db.runtime, DEPLOYMENT, CHAIN))?.lastBlockNumber).toBe(60n);
  });
});

describe('candidate blocks and integrity conflicts', () => {
  it('keeps an orphaned candidate row and its history', async () => {
    const candidate: IngestBatch = {
      deploymentId: DEPLOYMENT,
      chainKey: CHAIN,
      blocks: [block(70, { observedClass: 'candidate', blockHash: hex32(7000) })],
      logs: [],
    };
    await ingestBatch(db.runtime, candidate);
    await recordCandidateOrphan(db.runtime, {
      eventId: 'orphan-7000',
      chainKey: CHAIN,
      blockHash: hex32(7000),
      reason: 'not accepted at height',
    });

    const rows = await db.runtime.sql<{ n: string }[]>`
      select count(*)::text as n from chain_blocks where block_hash = ${hex32(7000)}
    `;
    // The raw row survives: an orphan is marked, never deleted.
    expect(Number(rows[0]?.n)).toBe(1);
    const history = await db.runtime.sql<{ status: string }[]>`
      select status from block_status_events where block_hash = ${hex32(7000)}
    `;
    expect(history.map((h) => h.status)).toEqual(['orphaned']);
  });

  it('refuses to orphan an accepted block', async () => {
    await expect(
      recordCandidateOrphan(db.runtime, {
        eventId: 'orphan-10',
        chainKey: CHAIN,
        blockHash: hex32(10),
        reason: 'attempted rewrite of final history',
      }),
    ).rejects.toThrow(/only candidates may be orphaned/);
  });

  it('raises a typed integrity incident when an accepted hash changes, without rolling back', async () => {
    const conflicting: IngestBatch = {
      deploymentId: DEPLOYMENT,
      chainKey: CHAIN,
      // Height 10 is already stored as hex32(10) and accepted.
      blocks: [block(10, { blockHash: hex32(9_999_10) })],
      logs: [],
    };

    await expect(ingestBatch(db.runtime, conflicting)).rejects.toThrow(AcceptedHashConflictError);

    // The original evidence is untouched.
    const stored = await db.runtime.sql<{ block_hash: string }[]>`
      select block_hash from chain_blocks
      where chain_key = ${CHAIN} and block_number = '10' and observed_class = 'accepted'
    `;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.block_hash).toBe(hex32(10));

    // And the contradiction is recorded as an incident, not repaired.
    const incidents = await db.runtime.sql<
      { kind: string; expected_hash: string; observed_hash: string }[]
    >`
      select kind, expected_hash, observed_hash from integrity_incidents
      where chain_key = ${CHAIN} and block_number = '10'
    `;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.kind).toBe('ACCEPTED_HASH_CONFLICT');
    expect(incidents[0]?.expected_hash).toBe(hex32(10));
    expect(incidents[0]?.observed_hash).toBe(hex32(9_999_10));
  });
});

describe('numeric fidelity and tenant isolation', () => {
  it('stores and returns uint256 max exactly', async () => {
    await ingestBatch(db.runtime, {
      deploymentId: DEPLOYMENT,
      chainKey: CHAIN,
      blocks: [block(80)],
      logs: [],
      observations: [observation(80, 'home.transferred-balance', MAX_UINT256)],
    });
    const rows = await db.runtime.sql<{ amount: string }[]>`
      select amount::text from observations where observation_id = ${'obs-80-home.transferred-balance'}
    `;
    expect(rows[0]?.amount).toBe(MAX_UINT256.toString(10));
    expect(rows[0]?.amount).toHaveLength(78);
  });

  it('rejects an amount above uint256 at the column boundary', async () => {
    await expect(
      db.runtime.sql.unsafe(
        `insert into observations
           (observation_id, deployment_id, chain_key, block_hash, block_number, subject, amount,
            finality_basis, provider_groups, payload_digest, observed_at, expires_at)
         values ('over', '${DEPLOYMENT}', '${CHAIN}', '${hex32(80)}', 80, 'x', ${'9'.repeat(79)},
                 'accepted-quorum', ARRAY['g'], '${digest('aa')}', now(), now() + interval '1 minute')`,
      ),
    ).rejects.toMatchObject({ code: '22003' });
  });

  it('keeps one deployment invisible to another', async () => {
    await db.migrator.sql`
      insert into deployments (deployment_id, manifest_hash, asset_mode)
      values ('other-tenant', ${digest('cd')}, 'native')
    `;
    const mine = await db.runtime.sql<{ n: string }[]>`
      select count(*)::text as n from observations where deployment_id = ${DEPLOYMENT}
    `;
    const theirs = await db.runtime.sql<{ n: string }[]>`
      select count(*)::text as n from observations where deployment_id = 'other-tenant'
    `;
    expect(Number(mine[0]?.n)).toBeGreaterThan(0);
    expect(Number(theirs[0]?.n)).toBe(0);
  });

  it('requires at least one provider group on every observation', async () => {
    await expect(
      db.runtime.sql.unsafe(
        `insert into observations
           (observation_id, deployment_id, chain_key, block_hash, block_number, subject, amount,
            finality_basis, provider_groups, payload_digest, observed_at, expires_at)
         values ('nogroups', '${DEPLOYMENT}', '${CHAIN}', '${hex32(80)}', 80, 'y', 1,
                 'accepted-quorum', ARRAY[]::text[], '${digest('aa')}', now(), now() + interval '1 minute')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('requires an observation to expire, so a stale read cannot stay green', async () => {
    await expect(
      db.runtime.sql.unsafe(
        `insert into observations
           (observation_id, deployment_id, chain_key, block_hash, block_number, subject, amount,
            finality_basis, provider_groups, payload_digest, observed_at, expires_at)
         values ('noexpiry', '${DEPLOYMENT}', '${CHAIN}', '${hex32(80)}', 80, 'z', 1,
                 'accepted-quorum', ARRAY['g'], '${digest('aa')}', now(), now() - interval '1 second')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
