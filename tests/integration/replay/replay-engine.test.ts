import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ReplayConfig,
  buildCensus,
  persistRemoteCandidates,
  runReplay,
} from '@ictt-sentinel/replay';
import { readCheckpoint } from '@ictt-sentinel/storage-postgres';
import {
  CHAIN,
  DEPLOYMENT,
  createTestDatabase,
  hex20,
  hex32,
  seedReference,
} from '../storage-postgres/harness.js';
import type { TestDatabase } from '../storage-postgres/harness.js';
import { AT, fakeSource } from './chain-fixture.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('replay');
  await seedReference(db.migrator);
}, 60_000);

afterAll(async () => {
  await db.drop();
});

const config = (over: Partial<ReplayConfig> = {}): ReplayConfig => ({
  deploymentId: DEPLOYMENT,
  chainKey: CHAIN,
  startBlock: 1n,
  agreement: { requiredIndependentGroups: 2, archiveFallbackDeclared: false },
  retryBudget: 2,
  freshnessTtlMs: 60 * 60 * 1000,
  maxHintsConsidered: 10,
  ...over,
});

const GROUPS = ['provider-alpha', 'provider-beta'];

const countRows = async (table: string, where: string): Promise<number> => {
  const rows = await db.runtime.sql.unsafe<{ n: string }[]>(
    `select count(*)::text as n from ${table} where ${where}`,
  );
  return Number(rows[0]?.n ?? '-1');
};

describe('successful replay', () => {
  it('commits facts with witness provenance and advances the checkpoint', async () => {
    const port = fakeSource({ head: 6n, groups: GROUPS, maxRangeBlocks: 3 });
    const report = await runReplay(db.runtime, port, config(), [], AT);

    expect(report.status).toBe('complete');
    expect(report.verdict).toBe('OK');
    expect(report.checkpointBefore).toBeNull();
    expect(report.checkpointAfter).toBe(6n);

    // Every committed range names the independent groups that agreed on it.
    expect(report.ranges).toHaveLength(2);
    for (const r of report.ranges) {
      expect(r.status).toBe('complete');
      expect(r.providerGroups).toEqual(['provider-alpha', 'provider-beta']);
      expect(r.digest).toMatch(/^[0-9a-f]{64}$/);
    }

    expect(await countRows('chain_blocks', `chain_key = '${CHAIN}'`)).toBe(6);
    expect(await countRows('chain_logs', `chain_key = '${CHAIN}'`)).toBe(6);
  });

  it('is idempotent: a second pass produces no duplicate facts', async () => {
    const port = fakeSource({ head: 6n, groups: GROUPS, maxRangeBlocks: 3 });
    const again = await runReplay(db.runtime, port, config(), [], AT);

    // Resumed past the checkpoint, so there was nothing left to do.
    expect(again.ranges).toEqual([]);
    expect(again.checkpointAfter).toBe(6n);
    expect(await countRows('chain_blocks', `chain_key = '${CHAIN}'`)).toBe(6);
    expect(await countRows('chain_logs', `chain_key = '${CHAIN}'`)).toBe(6);
  });

  it('resumes from the last committed checkpoint after a restart', async () => {
    // A fresh process, a longer chain: it must pick up at 7, not replay from 1.
    const port = fakeSource({ head: 9n, groups: GROUPS, maxRangeBlocks: 3 });
    const report = await runReplay(db.runtime, port, config(), [], AT);
    expect(report.ranges.map((r) => r.range)).toEqual([{ fromBlock: 7n, toBlock: 9n }]);
    expect(report.checkpointAfter).toBe(9n);
    expect(await countRows('chain_blocks', `chain_key = '${CHAIN}'`)).toBe(9);
  });

  it('splits a range the provider will not serve, without losing coverage', async () => {
    const port = fakeSource({
      head: 13n,
      groups: GROUPS,
      maxRangeBlocks: 4,
      failWiderThan: 2,
    });
    const report = await runReplay(db.runtime, port, config(), [], AT);
    expect(report.status).toBe('complete');
    expect(report.checkpointAfter).toBe(13n);
    // Narrower ranges than planned, and still every height stored exactly once.
    expect(report.ranges.every((r) => r.range.toBlock - r.range.fromBlock + 1n <= 2n)).toBe(true);
    expect(await countRows('chain_blocks', `chain_key = '${CHAIN}'`)).toBe(13);
  });
});

describe('gap and divergence block the checkpoint', () => {
  it('does not advance the checkpoint when provider groups diverge', async () => {
    const before = await readCheckpoint(db.runtime, DEPLOYMENT, CHAIN);
    const port = fakeSource({
      head: 20n,
      groups: GROUPS,
      maxRangeBlocks: 3,
      divergentGroups: ['provider-beta'],
    });
    const report = await runReplay(db.runtime, port, config(), [], AT);

    expect(report.status).toBe('divergent');
    expect(report.verdict).toBe('UNKNOWN');
    expect(report.checkpointAfter).toBe(before?.lastBlockNumber ?? null);

    const incidents = await db.runtime.sql<{ reason_code: string; runbook: string }[]>`
      select reason_code, runbook from data_quality_incidents
      where deployment_id = ${DEPLOYMENT} and reason_code = 'PROVIDER_DIVERGENCE'
    `;
    expect(incidents.length).toBeGreaterThan(0);
    expect(incidents[0]?.runbook).toContain('RUNBOOK');
  });

  it('does not advance the checkpoint when history is pruned', async () => {
    const before = await readCheckpoint(db.runtime, DEPLOYMENT, CHAIN);
    const port = fakeSource({
      head: 20n,
      groups: GROUPS,
      maxRangeBlocks: 3,
      failures: { 'provider-alpha': { '14-16': 'PRUNED_HISTORY' } },
    });
    const report = await runReplay(db.runtime, port, config(), [], AT);

    expect(report.status).toBe('blocked');
    expect(report.verdict).toBe('UNKNOWN');
    expect(report.checkpointAfter).toBe(before?.lastBlockNumber ?? null);
    expect(await countRows('data_quality_incidents', `reason_code = 'PRUNED_HISTORY'`)).toBe(1);
  });

  it('blocks a single witness rather than trusting it', async () => {
    const before = await readCheckpoint(db.runtime, DEPLOYMENT, CHAIN);
    const port = fakeSource({ head: 20n, groups: ['provider-alpha'], maxRangeBlocks: 3 });
    const report = await runReplay(db.runtime, port, config(), [], AT);
    expect(report.verdict).toBe('UNKNOWN');
    expect(report.checkpointAfter).toBe(before?.lastBlockNumber ?? null);
    expect(
      await countRows('data_quality_incidents', `reason_code = 'INSUFFICIENT_WITNESSES'`),
    ).toBeGreaterThan(0);
  });

  it('refuses an archive witness that policy never declared', async () => {
    const port = fakeSource({
      head: 20n,
      groups: GROUPS,
      maxRangeBlocks: 3,
      archiveGroups: ['provider-beta'],
    });
    const report = await runReplay(db.runtime, port, config(), [], AT);
    expect(report.status).toBe('blocked');
    expect(
      await countRows('data_quality_incidents', `reason_code = 'ARCHIVE_FALLBACK_UNAVAILABLE'`),
    ).toBeGreaterThan(0);
  });

  it('keeps a candidate block out of the canonical path', async () => {
    const port = fakeSource({
      head: 20n,
      groups: GROUPS,
      maxRangeBlocks: 3,
      candidateHeights: [15],
    });
    const report = await runReplay(db.runtime, port, config(), [], AT);
    expect(report.status).toBe('blocked');
    expect(
      await countRows('data_quality_incidents', `reason_code = 'NONCANONICAL_BLOCK_REJECTED'`),
    ).toBeGreaterThan(0);
    // The candidate never became a stored fact.
    expect(await countRows('chain_blocks', `block_number = 15`)).toBe(0);
  });

  it('records a completeness projection that is UNKNOWN, not green', async () => {
    const rows = await db.runtime.sql<{ status: string; verdict: string; gap_count: number }[]>`
      select status, verdict, gap_count from projection_replay_completeness
      where deployment_id = ${DEPLOYMENT} and chain_key = ${CHAIN}
    `;
    expect(rows[0]?.verdict).toBe('UNKNOWN');
    expect(rows[0]?.status).not.toBe('complete');
  });

  it('cannot store a green row for an incomplete window, even by direct SQL', async () => {
    // The rule is a database constraint, not application discipline.
    await expect(
      db.runtime.sql.unsafe(
        `insert into projection_replay_completeness
           (deployment_id, chain_key, status, verdict, window_from, window_to,
            gap_count, reasons, evaluated_at)
         values ('${DEPLOYMENT}', '${CHAIN}', 'gap', 'OK', 1, 10, 1, ARRAY[]::text[], now())`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('determinism', () => {
  it('produces the same digests whatever the provider or chunk order', async () => {
    const forward = fakeSource({
      head: 8n,
      groups: ['provider-alpha', 'provider-beta'],
      maxRangeBlocks: 4,
    });
    const reversed = fakeSource({
      head: 8n,
      groups: ['provider-beta', 'provider-alpha'],
      maxRangeBlocks: 2,
    });

    const a = await createTestDatabase('deta');
    const b = await createTestDatabase('detb');
    try {
      await seedReference(a.migrator);
      await seedReference(b.migrator);
      const ra = await runReplay(a.runtime, forward, config(), [], AT);
      const rb = await runReplay(b.runtime, reversed, config(), [], AT);

      expect(ra.status).toBe('complete');
      expect(rb.status).toBe('complete');
      expect(ra.checkpointAfter).toBe(rb.checkpointAfter);

      // Different chunkings, so the range digests differ by construction; what
      // must match is the ledger they produced.
      const ledgerDigest = async (t: typeof a): Promise<string> => {
        const rows = await t.runtime.sql<{ d: string }[]>`
          select md5(string_agg(block_hash || ':' || tx_hash || ':' || log_index,
                                ',' order by block_number, tx_index, log_index)) as d
          from chain_logs
        `;
        return rows[0]?.d ?? '';
      };
      expect(await ledgerDigest(b)).toBe(await ledgerDigest(a));
    } finally {
      await a.drop();
      await b.drop();
    }
  }, 90_000);
});

describe('remote census drift', () => {
  it('persists a discovered remote as a candidate, never as trusted', async () => {
    const census = buildCensus({
      homeStartBlock: 1n,
      agreedHead: 20n,
      historyFullyReplayed: true,
      observed: [
        {
          remoteBlockchainId: hex32(77),
          remoteAddress: hex20(77),
          registeredAtBlock: 12n,
          registeredAtBlockHash: hex32(12),
        },
      ],
      approved: [],
    });
    expect(census.candidates).toHaveLength(1);

    await persistRemoteCandidates(db.runtime, DEPLOYMENT, census.candidates);

    const rows = await db.runtime.sql<{ trust: string }[]>`
      select trust from remote_candidates
      where deployment_id = ${DEPLOYMENT} and remote_blockchain_id = ${hex32(77)}
    `;
    expect(rows[0]?.trust).toBe('candidate');
  });

  it('has no schema path that marks a remote trusted', async () => {
    await expect(
      db.runtime.sql.unsafe(
        `insert into remote_candidates
           (deployment_id, remote_blockchain_id, remote_address,
            registered_at_block, registered_at_block_hash, trust)
         values ('${DEPLOYMENT}', '${hex32(78)}', '${hex20(78)}', 13, '${hex32(13)}', 'trusted')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
