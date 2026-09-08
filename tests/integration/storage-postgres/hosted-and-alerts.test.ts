import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acknowledgeTenantAlert,
  findGrant,
  findTokenByHash,
  ingestHostedEvaluation,
  readAlerts,
  readHostedEvaluation,
  readHostedEvaluations,
  claimNonce,
  IdempotencyPayloadConflictError,
  type HostedEvaluationInput,
} from '@ictt-sentinel/storage-postgres';
import { drainOutbox, raiseAlert, type AlertSignal } from '@ictt-sentinel/agent';
import {
  DEPLOYMENT,
  createTestDatabase,
  digest,
  seedReference,
  type TestDatabase,
} from './harness.js';

let db: TestDatabase;
const NOW = new Date('2026-06-01T00:00:00.000Z');
const IDEMPOTENCY_EXPIRES_AT = new Date('2027-06-01T00:00:00.000Z');
const tokenHash = (token: string): string =>
  createHash('sha256').update('ictt-sentinel/api-token/v1\n').update(token).digest('hex');

beforeAll(async () => {
  db = await createTestDatabase('hosted_alerts');
  await seedReference(db.migrator);
  await db.migrator.sql`
    insert into tenants (tenant_id, display_name)
    values ('tenant-a', 'Tenant A'), ('tenant-b', 'Tenant B')
  `;
  await db.migrator.sql`
    insert into deployment_tenants (deployment_id, tenant_id, sharing_level)
    values (${DEPLOYMENT}, 'tenant-a', 'approved-full')
  `;
  // A second deployment, so the restart case cannot interfere with the
  // lifecycle assertions on the primary one.
  await db.migrator.sql`
    insert into deployments (deployment_id, manifest_hash, asset_mode)
    values ('restart-case', ${digest('c0')}, 'canonical-erc20')
  `;
  await db.migrator.sql`
    insert into deployment_tenants (deployment_id, tenant_id, sharing_level)
    values ('restart-case', 'tenant-a', 'sanitized-metadata')
  `;
  await db.migrator.sql`
    insert into api_tokens
      (token_id, tenant_id, token_hash, scopes, description, created_at, expires_at)
    values
      ('token-a', 'tenant-a', ${tokenHash('tenant-a-token-0001')},
       ARRAY['status:read', 'ingest:write'], 'active', ${NOW}, ${new Date(NOW.getTime() + 60_000)}),
      ('token-expired', 'tenant-a', ${tokenHash('tenant-a-expired-01')},
       ARRAY['status:read'], 'expired', ${NOW}, ${new Date(NOW.getTime() + 1_000)})
  `;
}, 60_000);

afterAll(async () => {
  if (db !== undefined) {
    await db.drop();
  }
});

const hosted = (overrides: Partial<HostedEvaluationInput> = {}): HostedEvaluationInput => ({
  tenantId: 'tenant-a',
  deploymentId: DEPLOYMENT,
  evidenceDigest: digest('aa'),
  payloadHash: digest('bb'),
  sharingLevel: 'sanitized-metadata',
  verifyStatus: 'metadata-only',
  protocolStatus: 'UNKNOWN',
  dataStatus: 'COMPLETE',
  observedAt: NOW,
  expiresAt: new Date(NOW.getTime() + 60_000),
  payload: { schemaVersion: 'ictt-sentinel/evidence/v1', reasonCodes: ['REPLAY_OK'] },
  ...overrides,
});

describe('hosted evidence persistence', () => {
  it('serializes concurrent idempotent ingest and stores one immutable record', async () => {
    const a = db.connectRuntime();
    const b = db.connectRuntime();
    const [first, second] = await Promise.all([
      ingestHostedEvaluation(a, hosted(), 'concurrent-key-0001', IDEMPOTENCY_EXPIRES_AT),
      ingestHostedEvaluation(b, hosted(), 'concurrent-key-0001', IDEMPOTENCY_EXPIRES_AT),
    ]);
    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
    expect(first.response).toEqual(second.response);
    const rows = await readHostedEvaluations(db.runtime, 'tenant-a', DEPLOYMENT, 10, null);
    expect(rows).toHaveLength(1);
  });

  it('rejects key reuse with another payload and keeps the first bytes', async () => {
    await expect(
      ingestHostedEvaluation(
        db.runtime,
        hosted({ payloadHash: digest('cc') }),
        'concurrent-key-0001',
        IDEMPOTENCY_EXPIRES_AT,
      ),
    ).rejects.toThrow(IdempotencyPayloadConflictError);
    expect(
      (await readHostedEvaluation(db.runtime, 'tenant-a', DEPLOYMENT, digest('aa')))?.payloadHash,
    ).toBe(digest('bb'));
  });

  it('orders late uploads by observation time and isolates tenant reads', async () => {
    await ingestHostedEvaluation(
      db.runtime,
      hosted({
        evidenceDigest: digest('cc'),
        payloadHash: digest('dd'),
        observedAt: new Date(NOW.getTime() - 60_000),
        expiresAt: new Date(NOW.getTime() + 1_000),
      }),
      'older-upload-key-01',
      IDEMPOTENCY_EXPIRES_AT,
    );
    expect(
      (await readHostedEvaluations(db.runtime, 'tenant-a', DEPLOYMENT, 10, null)).map(
        (row) => row.evidenceDigest,
      ),
    ).toEqual([digest('aa'), digest('cc')]);
    expect(await readHostedEvaluations(db.runtime, 'tenant-b', DEPLOYMENT, 10, null)).toEqual([]);
    expect(await findGrant(db.runtime, 'tenant-b', DEPLOYMENT)).toBeNull();
  });

  it('enforces token expiry and atomically rejects nonce replay', async () => {
    expect(await findTokenByHash(db.runtime, tokenHash('tenant-a-token-0001'), NOW)).toMatchObject({
      tenantId: 'tenant-a',
    });
    expect(
      await findTokenByHash(
        db.runtime,
        tokenHash('tenant-a-expired-01'),
        new Date(NOW.getTime() + 2_000),
      ),
    ).toBeNull();
    const a = db.connectRuntime();
    const b = db.connectRuntime();
    const claims = await Promise.all([
      claimNonce(a, 'tenant-a', 'nonce-race-01', NOW, new Date(NOW.getTime() + 60_000)),
      claimNonce(b, 'tenant-a', 'nonce-race-01', NOW, new Date(NOW.getTime() + 60_000)),
    ]);
    expect(claims.sort()).toEqual([false, true]);
  });

  it('does not let the runtime rewrite hosted evidence', async () => {
    await expect(
      db.runtime.sql`update hosted_evaluations set protocol_status = 'OK'`,
    ).rejects.toMatchObject({ code: '42501' });
  });
});

const signal = (overrides: Partial<AlertSignal> = {}): AlertSignal => ({
  deploymentId: DEPLOYMENT,
  evaluationId: null,
  ruleId: 'accounting-rule',
  reasonCode: 'ACC_A01_EXCESS',
  previousVerdict: 'OK',
  verdict: 'CRITICAL',
  evidenceHash: digest('ee'),
  evidenceSchemaVersion: 'ictt-sentinel/evidence/v1',
  reasonCodes: ['ACC_A01_EXCESS'],
  observedAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
  fresh: true,
  ...overrides,
});

describe('durable alert lifecycle', () => {
  it('deduplicates concurrent first observation, scopes ack, and closes on recovery', async () => {
    const a = db.connectRuntime();
    const b = db.connectRuntime();
    const results = await Promise.all([
      raiseAlert(a, signal(), NOW, (key) => key),
      raiseAlert(b, signal(), NOW, (key) => key),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    let rows = await readAlerts(db.runtime, DEPLOYMENT, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ occurrences: 2, lifecycleState: 'repeated' });

    const incident = results[0]?.incidentKey;
    if (incident === undefined) throw new Error('incident missing');
    expect(await acknowledgeTenantAlert(db.runtime, 'tenant-b', incident, 'foreign', NOW)).toBe(0);
    expect(await acknowledgeTenantAlert(db.runtime, 'tenant-a', incident, 'operator', NOW)).toBe(1);

    const recovery = await raiseAlert(
      db.runtime,
      signal({
        previousVerdict: 'CRITICAL',
        verdict: 'OK',
        evidenceHash: digest('ff'),
      }),
      new Date(NOW.getTime() + 1_000),
      (key) => key,
    );
    expect(recovery.closedIncidentRows).toBe(1);
    rows = await readAlerts(db.runtime, DEPLOYMENT, 10);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.evidenceDigest === digest('ee'))).toMatchObject({
      lifecycleState: 'recovered',
      status: 'cancelled',
    });
    expect(rows.find((row) => row.evidenceDigest === digest('ff'))).toMatchObject({
      lifecycleState: 'recovered',
      status: 'pending',
    });
  });

  it('retries notifier failure without changing the persisted verdict', async () => {
    const first = await drainOutbox({
      db: db.runtime,
      targets: [
        {
          targetId: 'oncall',
          kind: 'generic-webhook',
          secretRef: 'ICTT_SENTINEL_TEST_HOOK',
          minSeverity: 'WARN',
        },
      ],
      resolve: () => 'https://hooks.example.com/notify',
      transport: { post: () => Promise.reject(new Error('network partition')) },
      timeoutMs: 100,
      maxAttempts: 2,
      leaseMs: 1_000,
      backoffMs: 10,
      batchSize: 10,
      now: new Date(NOW.getTime() + 2_000),
      signal: new AbortController().signal,
      deliveryIdFor: (outbox, target, attempt) => `${outbox}-${target}-${String(attempt)}`,
    });
    expect(first).toMatchObject({ retrying: 1, delivered: 0 });
    const rows = await readAlerts(db.runtime, DEPLOYMENT, 10);
    expect(rows.find((row) => row.status === 'pending')).toMatchObject({
      verdictTo: 'OK',
      lifecycleState: 'recovered',
    });
  });

  it('does not page again for a breach it already opened before a restart', async () => {
    // A restarted agent has no in-memory verdict history, so it re-observes the
    // same live breach as a NONE -> CRITICAL transition. That is a different
    // dedup key, and a naive outbox would page the on-call engineer a second
    // time for an incident they are already handling.
    const restarted = await raiseAlert(
      db.runtime,
      signal({
        deploymentId: 'restart-case',
        previousVerdict: 'NONE',
        verdict: 'CRITICAL',
        evidenceHash: digest('c1'),
      }),
      NOW,
      (key) => key,
    );
    expect(restarted.created).toBe(true);
    expect(restarted.notified).toBe(true);

    const afterRestart = await raiseAlert(
      db.runtime,
      signal({
        deploymentId: 'restart-case',
        previousVerdict: 'NONE',
        verdict: 'CRITICAL',
        // New tick, new observation digest: a different notification identity
        // for what is still the same open incident.
        evidenceHash: digest('c2'),
      }),
      new Date(NOW.getTime() + 5_000),
      (key) => key,
    );
    expect(afterRestart.dedupKey).not.toBe(restarted.dedupKey);
    expect(afterRestart.incidentKey).toBe(restarted.incidentKey);
    expect(afterRestart.notified).toBe(false);

    const rows = await readAlerts(db.runtime, 'restart-case', 10);
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(1);
    expect(rows.find((row) => row.evidenceDigest === digest('c2'))).toMatchObject({
      lifecycleState: 'repeated',
      status: 'sent',
    });
  });
});
