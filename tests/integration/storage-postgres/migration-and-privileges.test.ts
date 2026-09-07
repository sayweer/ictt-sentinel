import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MigrationDriftError,
  loadMigrations,
  migrate,
  MIGRATOR_ROLE,
} from '@ictt-sentinel/storage-postgres';
import { CHAIN, DEPLOYMENT, createTestDatabase, hex32, seedReference } from './harness.js';
import type { TestDatabase } from './harness.js';

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase('migrate');
}, 60_000);

afterAll(async () => {
  await db.drop();
});

describe('migration on a clean database', () => {
  it('applied every migration exactly once and recorded checksums', async () => {
    const rows = await db.migrator.sql<{ version: number; name: string; checksum: string }[]>`
      select version, name, checksum from schema_migrations order by version
    `;
    const onDisk = loadMigrations();
    // Version-count agnostic: later milestones add migrations, and what must
    // hold is that the database matches the files exactly.
    expect(rows.map((r) => r.version)).toEqual(onDisk.map((m) => m.version));
    expect(rows.map((r) => r.checksum)).toEqual(onDisk.map((m) => m.checksum));
  });

  it('is a no-op when run again', async () => {
    const result = await migrate(db.migrator, { role: MIGRATOR_ROLE });
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(loadMigrations().map((m) => m.version));
  });

  it('refuses to run when an applied migration file has changed', async () => {
    const tampered = loadMigrations().map((m) =>
      m.version === 2 ? { ...m, checksum: 'f'.repeat(64) } : m,
    );
    await expect(
      migrate(db.migrator, { migrations: tampered, role: MIGRATOR_ROLE }),
    ).rejects.toThrow(MigrationDriftError);
    // The database is untouched: a drifted file is reported, never reconciled.
    const rows = await db.migrator.sql<{ checksum: string }[]>`
      select checksum from schema_migrations where version = 2
    `;
    expect(rows[0]?.checksum).toBe(loadMigrations()[1]?.checksum);
  });

  it('owns every table with the migrator role, not a login role', async () => {
    const rows = await db.migrator.sql<{ tablename: string; tableowner: string }[]>`
      select tablename, tableowner from pg_tables where schemaname = 'public'
    `;
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) expect(r.tableowner).toBe(MIGRATOR_ROLE);
  });
});

describe('runtime privileges', () => {
  beforeAll(async () => {
    await seedReference(db.migrator);
    await db.runtime.sql`
      insert into chain_blocks
        (chain_key, block_hash, block_number, parent_hash, block_timestamp, observed_class, observed_at)
      values (${CHAIN}, ${hex32(10)}, '10', ${hex32(9)}, '1700000000', 'accepted', now())
    `;
  });

  it('is not a superuser and does not own the schema', async () => {
    const rows = await db.runtime.sql<{ usesuper: boolean; current_user: string }[]>`
      select usesuper, current_user from pg_user where usename = current_user
    `;
    expect(rows[0]?.usesuper).toBe(false);
    expect(rows[0]?.current_user).not.toBe(MIGRATOR_ROLE);
  });

  it('can append a fact', async () => {
    const rows = await db.runtime.sql`
      insert into chain_blocks
        (chain_key, block_hash, block_number, parent_hash, block_timestamp, observed_class, observed_at)
      values (${CHAIN}, ${hex32(11)}, '11', ${hex32(10)}, '1700000001', 'accepted', now())
      returning block_hash
    `;
    expect(rows).toHaveLength(1);
  });

  it.each([
    ['chain_blocks', `update chain_blocks set block_number = 0`],
    ['chain_logs', `update chain_logs set data = 'x'`],
    ['observations', `update observations set amount = 0`],
    ['message_transitions', `update message_transitions set message_id = 'x'`],
    ['evaluations', `update evaluations set verdict = 'OK'`],
    ['verdict_events', `update verdict_events set verdict = 'OK'`],
    ['evidence_bundles', `update evidence_bundles set export_hash = 'x'`],
  ])('cannot UPDATE %s', async (_table, statement) => {
    await expect(db.runtime.sql.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
  });

  it.each([
    ['chain_blocks', `delete from chain_blocks`],
    ['chain_logs', `delete from chain_logs`],
    ['observations', `delete from observations`],
    ['evaluations', `delete from evaluations`],
    ['integrity_incidents', `delete from integrity_incidents`],
  ])('cannot DELETE from %s', async (_table, statement) => {
    await expect(db.runtime.sql.unsafe(statement)).rejects.toMatchObject({ code: '42501' });
  });

  it('may change operational state, which is meant to move', async () => {
    await db.runtime.sql`
      insert into replay_checkpoints (deployment_id, chain_key, last_block_number, last_block_hash)
      values (${DEPLOYMENT}, ${CHAIN}, '10', ${hex32(10)})
    `;
    await db.runtime.sql`
      update replay_checkpoints set last_block_number = '11'
      where deployment_id = ${DEPLOYMENT} and chain_key = ${CHAIN}
    `;
    await db.runtime.sql`delete from replay_ranges where range_id = 'none'`;
  });

  it('cannot create a table', async () => {
    await expect(db.runtime.sql.unsafe('create table sneaky (id int)')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('schema-level identity rules', () => {
  it('does not constrain message_id on its own', async () => {
    // messageID is not globally unique. A bare UNIQUE(message_id) would silently
    // collapse two distinct routes that legitimately share one id.
    const rows = await db.migrator.sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'message_transitions'
    `;
    const singleColumnOnMessageId = rows.filter((r) => /\(\s*message_id\s*\)/.test(r.indexdef));
    expect(singleColumnOnMessageId).toEqual([]);
    // The real identity is the full routing tuple.
    const tuple = rows.find((r) => /message_transitions_identity_uq/.test(r.indexdef));
    expect(tuple?.indexdef).toContain('source_blockchain_id');
    expect(tuple?.indexdef).toContain('registry_protocol_version');
  });

  it('permits at most one accepted block per height', async () => {
    const rows = await db.migrator.sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where tablename = 'chain_blocks' and indexname = 'chain_blocks_one_accepted_per_height'
    `;
    expect(rows[0]?.indexdef).toMatch(/UNIQUE/);
    expect(rows[0]?.indexdef).toMatch(/WHERE \(observed_class = 'accepted'/);
  });

  it('stores every amount as NUMERIC, never a float type', async () => {
    const rows = await db.migrator.sql<
      { table_name: string; column_name: string; data_type: string }[]
    >`
      select table_name, column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
        and data_type in ('double precision', 'real')
    `;
    expect(rows).toEqual([]);

    const amounts = await db.migrator.sql<{ numeric_precision: number; numeric_scale: number }[]>`
      select numeric_precision, numeric_scale
      from information_schema.columns
      where table_schema = 'public' and column_name in ('amount', 'total_amount')
    `;
    expect(amounts.length).toBeGreaterThan(0);
    for (const a of amounts) {
      expect(a.numeric_precision).toBe(78);
      expect(a.numeric_scale).toBe(0);
    }
  });
});
