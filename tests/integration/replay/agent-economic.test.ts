import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentService, type AgentConfig } from '@ictt-sentinel/agent';
import { referenceRowsFor, registerDeployment } from '@ictt-sentinel/storage-postgres';
import type { LogSourcePort } from '@ictt-sentinel/replay';
import { E12, NOW_S, healthy, simulate } from '../../../packages/collector/test/world.js';
import { createTestDatabase, type TestDatabase } from '../storage-postgres/harness.js';

/**
 * The agent running the economic collector against a real database.
 *
 * The deployment is registered the way an operator would (the migrator writes
 * the reference rows), the agent collects from the shared simulated deployment,
 * and the evaluation, verdict event and alert land under the runtime role.
 */

let db: TestDatabase;
const world = healthy();
const sim = simulate(world);

beforeAll(async () => {
  db = await createTestDatabase('economic');
  await registerDeployment(db.migrator, referenceRowsFor(sim.manifest.value, sim.manifest.digest));
}, 60_000);

afterAll(async () => {
  await db.drop();
});

const config: AgentConfig = {
  databaseUrl: 'unused',
  manifestPath: 'unused',
  policyPath: 'unused',
  sharingLevel: 'local-only',
  hostedUrl: null,
  ingestTokenRef: null,
  maxConcurrency: 1,
  queueLimit: 4,
  tickIntervalMs: 30_000,
  economicIntervalMs: 900_000,
  jobTimeoutMs: 120_000,
  maxJobAttempts: 1,
  backoffMs: 100,
  shutdownGraceMs: 1_000,
  alertTargets: [],
  observe: { enabled: false, host: '127.0.0.1', port: 9464 },
};

let clock = 0;
const service = () =>
  createAgentService({
    config,
    manifest: sim.manifest.value,
    policy: sim.policy.value,
    manifestDigest: sim.manifest.digest,
    policyDigest: sim.policy.digest,
    db: db.runtime,
    env: sim.env,
    economic: {
      reader: sim.reader,
      producer: {
        producer: 'ictt-sentinel',
        buildCommit: 'test',
        artifactChecksum: 'c'.repeat(64),
      },
    },
    sourceFor: () => {
      throw new Error('replay is not exercised here');
    },
    now: () => new Date(Number(NOW_S) * 1000),
    monotonicNow: () => clock,
  });

const outbox = (verdict: string) =>
  db.runtime.sql<{ n: string }[]>`
    select count(*)::text as n from alert_outbox
    where rule_id = 'ACC-ERC20-CANONICAL' and verdict_to = ${verdict}
  `;

describe('economic evaluation in the agent', () => {
  // Built once the database exists; one instance, so its previous verdict carries.
  let agent: ReturnType<typeof service>;
  beforeAll(() => {
    agent = service();
  });

  it('records an OK evaluation backed by the evidence content hash', async () => {
    const report = await agent.collectEconomic(new AbortController().signal);
    expect(report?.verdict).toBe('OK');
    expect(report?.evaluationId).not.toBeNull();
    const [row] = await db.runtime.sql<
      { subject: string; payload_digest: string; verdict: string }[]
    >`
      select subject, payload_digest, verdict from evaluations
      where evaluation_id = ${report?.evaluationId ?? ''}
    `;
    expect(row).toEqual({
      subject: 'canonical-erc20-economic',
      payload_digest: report?.contentHash,
      verdict: 'OK',
    });
  });

  it('does not run again before its interval', async () => {
    clock += 60_000;
    expect(await agent.collectEconomic(new AbortController().signal)).toBeNull();
  });

  it('raises a CRITICAL alert when the remote supply outgrows home accounting', async () => {
    world.remoteSupply = 1400n * E12;
    clock += 900_000;
    const report = await agent.collectEconomic(new AbortController().signal);
    expect(report?.verdict).toBe('CRITICAL');
    expect(report?.reasonCodes).toContain('ACC_A01_EXCESS_REMOTE_REPRESENTATION');
    expect((await outbox('CRITICAL'))[0]?.n).toBe('1');
  });

  it('raises UNKNOWN with the collector reason when no evidence can be built', async () => {
    const unreachable = createAgentService({
      ...{
        config,
        manifest: sim.manifest.value,
        policy: sim.policy.value,
        manifestDigest: sim.manifest.digest,
        policyDigest: sim.policy.digest,
        db: db.runtime,
        env: sim.env,
        sourceFor: (): LogSourcePort => {
          throw new Error('replay is not exercised here');
        },
      },
      economic: {
        reader: { now: () => sim.reader.now(), read: () => Promise.reject(new Error('down')) },
        producer: {
          producer: 'ictt-sentinel',
          buildCommit: 'test',
          artifactChecksum: 'c'.repeat(64),
        },
      },
    });
    const report = await unreachable.collectEconomic(new AbortController().signal);
    expect(report).toMatchObject({ verdict: 'UNKNOWN', evaluationId: null });
    expect(report?.reasonCodes).toEqual([
      'COLLECT_UNAVAILABLE',
      'COLLECT_NO_PIN',
      'COLLECT_NO_PIN',
    ]);
    expect(Number((await outbox('UNKNOWN'))[0]?.n)).toBeGreaterThan(0);
  });
});
