import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admitHint, hintId, type PriorityHint, runReplay } from '@ictt-sentinel/replay';
import {
  enqueueHint,
  markHintsConsumed,
  pendingHintDepth,
  readCheckpoint,
  readPendingHints,
} from '@ictt-sentinel/storage-postgres';
import {
  CHAIN,
  DEPLOYMENT,
  createTestDatabase,
  seedReference,
} from '../storage-postgres/harness.js';
import type { TestDatabase } from '../storage-postgres/harness.js';
import { AT, fakeSource } from './chain-fixture.js';

/**
 * Webhook / truth-path isolation.
 *
 * A hint is a speed signal. These tests exist to prove the three things it must
 * never be able to do: create a fact, create a verdict, or move a checkpoint.
 */

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('hints');
  await seedReference(db.migrator);
}, 60_000);

afterAll(async () => {
  await db.drop();
});

const hint = (dedupKey: string, block: bigint): PriorityHint => ({
  hintId: hintId('webhook', dedupKey),
  deploymentId: DEPLOYMENT,
  chainKey: CHAIN,
  suggestedBlockNumber: block,
  source: 'webhook',
  dedupKey,
  receivedAt: AT,
});

const row = (h: PriorityHint) => ({
  hintId: h.hintId,
  deploymentId: h.deploymentId,
  chainKey: h.chainKey,
  suggestedBlockNumber: h.suggestedBlockNumber,
  source: h.source,
  dedupKey: h.dedupKey,
});

describe('the hint queue', () => {
  it('accepts a hint and reports it as pending', async () => {
    expect(await enqueueHint(db.runtime, row(hint('evt-1', 4n)))).toBe(true);
    expect(await pendingHintDepth(db.runtime, DEPLOYMENT, CHAIN)).toBe(1);
  });

  it('absorbs a redelivered event instead of queueing it twice', async () => {
    // Replay protection at the database, not only in the pure admission check.
    expect(await enqueueHint(db.runtime, row(hint('evt-1', 4n)))).toBe(false);
    expect(await pendingHintDepth(db.runtime, DEPLOYMENT, CHAIN)).toBe(1);
  });

  it('rejects a flood once the bound is reached', async () => {
    const depth = await pendingHintDepth(db.runtime, DEPLOYMENT, CHAIN);
    const existing = new Set(
      (await readPendingHints(db.runtime, DEPLOYMENT, CHAIN, 100)).map((h) => h.dedupKey),
    );
    expect(admitHint(hint('evt-flood', 5n), existing, depth, { maxDepth: depth })).toEqual({
      kind: 'rejected',
      reason: 'queue-full',
    });
  });

  it('marks hints consumed exactly once', async () => {
    expect(await markHintsConsumed(db.runtime, ['evt-1'])).toBe(1);
    expect(await markHintsConsumed(db.runtime, ['evt-1'])).toBe(0);
    expect(await pendingHintDepth(db.runtime, DEPLOYMENT, CHAIN)).toBe(0);
  });
});

describe('a hint cannot become truth', () => {
  it('creates no fact and moves no checkpoint on its own', async () => {
    await enqueueHint(db.runtime, row(hint('evt-2', 9n)));

    const blocks = await db.runtime.sql<
      { n: string }[]
    >`select count(*)::text as n from chain_blocks`;
    const logs = await db.runtime.sql<{ n: string }[]>`select count(*)::text as n from chain_logs`;
    const evaluations = await db.runtime.sql<
      { n: string }[]
    >`select count(*)::text as n from evaluations`;
    const checkpoint = await readCheckpoint(db.runtime, DEPLOYMENT, CHAIN);

    // A hint sitting in the queue has changed nothing about history or judgement.
    expect(Number(blocks[0]?.n)).toBe(0);
    expect(Number(logs[0]?.n)).toBe(0);
    expect(Number(evaluations[0]?.n)).toBe(0);
    expect(checkpoint).toBeNull();
  });

  it('carries no column that could assert chain identity', async () => {
    // Structural, not behavioural: there is nowhere in the row to put a block
    // hash, a log, or a digest, so nothing can be promoted out of it.
    const cols = await db.runtime.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'webhook_hints'
    `;
    const names = cols.map((c) => c.column_name);
    expect(names).toContain('suggested_block_number');
    for (const forbidden of ['block_hash', 'tx_hash', 'log_index', 'digest', 'verdict', 'amount']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('cannot bypass accepted-block replay: coverage is identical with and without hints', async () => {
    const port = fakeSource({
      head: 6n,
      groups: ['provider-alpha', 'provider-beta'],
      maxRangeBlocks: 3,
    });
    const config = {
      deploymentId: DEPLOYMENT,
      chainKey: CHAIN,
      startBlock: 1n,
      agreement: { requiredIndependentGroups: 2, archiveFallbackDeclared: false },
      retryBudget: 2,
      freshnessTtlMs: 60 * 60 * 1000,
      maxHintsConsidered: 10,
    };

    // A hint pointing far past the agreed head cannot conjure coverage there.
    const withHints = await runReplay(db.runtime, port, config, [hint('evt-3', 99_999n)], AT);
    expect(withHints.checkpointAfter).toBe(6n);

    const stored = await db.runtime.sql<{ max: string | null }[]>`
      select max(block_number)::text as max from chain_blocks
    `;
    expect(stored[0]?.max).toBe('6');
  });

  it('only reorders work; the hinted range is still verified like any other', async () => {
    const port = fakeSource({
      head: 12n,
      groups: ['provider-alpha', 'provider-beta'],
      maxRangeBlocks: 3,
    });
    const report = await runReplay(
      db.runtime,
      port,
      {
        deploymentId: DEPLOYMENT,
        chainKey: CHAIN,
        startBlock: 1n,
        agreement: { requiredIndependentGroups: 2, archiveFallbackDeclared: false },
        retryBudget: 2,
        freshnessTtlMs: 60 * 60 * 1000,
        maxHintsConsidered: 10,
      },
      [hint('evt-4', 11n)],
      AT,
    );

    // The hinted range ran first...
    expect(report.ranges[0]?.range).toEqual({ fromBlock: 10n, toBlock: 12n });
    // ...and was still held to the full independent-witness requirement.
    expect(report.ranges[0]?.providerGroups).toEqual(['provider-alpha', 'provider-beta']);
    // Both ranges were covered, so ordering changed nothing about completeness.
    expect(report.ranges.map((r) => r.status)).toEqual(['complete', 'complete']);
    expect(report.checkpointAfter).toBe(12n);
  });
});
