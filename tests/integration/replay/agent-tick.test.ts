import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Verdict } from '@ictt-sentinel/domain';
import { createAgentRegistry, runDeploymentTick } from '@ictt-sentinel/agent';
import type { DeploymentPlan } from '@ictt-sentinel/agent';
import {
  CHAIN,
  DEPLOYMENT,
  createTestDatabase,
  seedReference,
} from '../storage-postgres/harness.js';
import type { TestDatabase } from '../storage-postgres/harness.js';
import { AT, fakeSource } from './chain-fixture.js';

/**
 * The agent tick against a real database.
 *
 * The ACP-194 guard adds a required UNKNOWN per superseded lane on top of what
 * replay reported. That combination only exists inside `runDeploymentTick`,
 * which writes evaluations and alerts, so it is exercised here end to end rather
 * than through the pure helper alone.
 */

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('agent_tick');
  await seedReference(db.migrator);
}, 60_000);

afterAll(async () => {
  await db.drop();
});

const HELICON_MAINNET = new Date('2026-09-22T15:00:00Z');
const GROUPS = ['provider-alpha', 'provider-beta'];

const plan = (finality: 'accepted-quorum' | 'settled-quorum'): DeploymentPlan => ({
  deploymentId: DEPLOYMENT,
  maxHints: 10,
  freshness: { maxAgeSeconds: 3600, expiresAfterSeconds: 7200 },
  chains: [
    {
      chainKey: CHAIN,
      // C-Chain mainnet identity: the chain ACP-194 changed.
      identity: { evmChainId: 43114n, blockchainId: `0x${'01'.padStart(64, '0')}` },
      finality,
      config: {
        deploymentId: DEPLOYMENT,
        chainKey: CHAIN,
        startBlock: 1n,
        agreement: { requiredIndependentGroups: 2, archiveFallbackDeclared: false },
        retryBudget: 2,
        freshnessTtlMs: 60 * 60 * 1000,
        maxHintsConsidered: 10,
      },
    },
  ],
});

// The head advances between ticks, as a live chain's does; a head frozen for
// months is correctly reported stale and would hide what is under test.
const tick = (finality: 'accepted-quorum' | 'settled-quorum', now: Date, head: bigint) =>
  runDeploymentTick(
    {
      db: db.runtime,
      source: fakeSource({ head, groups: GROUPS, maxRangeBlocks: 3 }),
      registry: createAgentRegistry(),
      now: () => now,
      previousVerdict: new Map<string, Verdict>(),
      lastSuccessAt: new Map<string, number>(),
      outboxIdFor: (key) => `outbox-${key.slice(0, 24)}`,
      evidenceSchemaVersion: 'ictt-sentinel/evidence/v1',
      signal: new AbortController().signal,
    },
    plan(finality),
  );

describe('agent tick on a C-Chain lane', () => {
  it('reports OK under accepted-quorum before ACP-194 activated', async () => {
    const report = await tick('accepted-quorum', AT, 6n);
    expect(report.chains[0]?.report.status).toBe('complete');
    expect(report.verdict).toBe('OK');
    expect(report.reasonCodes).not.toContain('ACCEPTED_STATE_SUPERSEDED');
  });

  it('turns the same complete replay UNKNOWN under accepted-quorum after activation', async () => {
    const report = await tick('accepted-quorum', HELICON_MAINNET, 9n);
    // Replay itself still completed: the facts are facts. The verdict is not.
    expect(report.chains[0]?.report.status).toBe('complete');
    expect(report.chains[0]?.report.verdict).toBe('OK');
    expect(report.rawVerdict).toBe('UNKNOWN');
    expect(report.verdict).toBe('UNKNOWN');
    expect(report.reasonCodes).toContain('ACCEPTED_STATE_SUPERSEDED');
  });

  it('reports OK under settled-quorum after activation', async () => {
    const report = await tick('settled-quorum', HELICON_MAINNET, 12n);
    expect(report.verdict).toBe('OK');
    expect(report.reasonCodes).not.toContain('ACCEPTED_STATE_SUPERSEDED');
  });
});
