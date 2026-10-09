import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadManifest, loadPolicy } from '@ictt-sentinel/config';
import { buildWatchPlan } from '@ictt-sentinel/agent';
import {
  ReferenceConflictError,
  referenceRowsFor,
  registerDeployment,
} from '@ictt-sentinel/storage-postgres';
import { createTestDatabase, type TestDatabase } from './harness.js';

/**
 * Operator-curated reference rows, registered by the migrator.
 *
 * Every fact the agent writes references a deployment and a chain row, and the
 * runtime role may only read them. Without this registration a real agent's
 * first commit would fail its foreign keys; the fixtures used to seed them by
 * hand, which is how the gap stayed hidden.
 */

let db: TestDatabase;
const manifest = loadManifest(readFileSync('config/deployments/example.ictt.yml', 'utf8'));
const rows = referenceRowsFor(manifest.value, manifest.digest);

beforeAll(async () => {
  db = await createTestDatabase('reference');
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe('registering a reviewed deployment', () => {
  it('writes the deployment and every chain once, and is a no-op the second time', async () => {
    expect((await registerDeployment(db.migrator, rows)).inserted).toBe(1 + rows.chains.length);
    expect((await registerDeployment(db.migrator, rows)).inserted).toBe(0);
  });

  it('registers exactly the chain keys the agent will write under', () => {
    const plan = buildWatchPlan(
      manifest.value,
      loadPolicy(readFileSync('config/policies/default.yml', 'utf8')).value,
    );
    expect(rows.chains.map((c) => c.chainKey)).toEqual(plan.chains.map((c) => c.chainKey));
  });

  it('refuses to re-label a registered deployment with another manifest', async () => {
    const other = referenceRowsFor(manifest.value, `sha256:${'f'.repeat(64)}`);
    await expect(registerDeployment(db.migrator, other)).rejects.toBeInstanceOf(
      ReferenceConflictError,
    );
  });

  it('is beyond the runtime role, which may only read reference data', async () => {
    await expect(registerDeployment(db.runtime, rows)).rejects.toThrow(/permission denied/);
    const [count] = await db.runtime.sql<{ n: string }[]>`select count(*)::text as n from chains`;
    expect(count?.n).toBe(String(rows.chains.length));
  });
});
