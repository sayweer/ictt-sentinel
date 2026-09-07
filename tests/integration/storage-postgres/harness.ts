import { randomBytes } from 'node:crypto';
import {
  type Db,
  createDb,
  ensureRoles,
  MIGRATOR_ROLE,
  RUNTIME_ROLE,
  migrate,
} from '@ictt-sentinel/storage-postgres';

/**
 * Integration harness: a real PostgreSQL, never a stand-in.
 *
 * A SQLite or in-memory double would pass while proving nothing about the two
 * things this milestone actually rests on - partial unique indexes and role
 * privileges - so there is no mock path here and no skip path either. Missing
 * configuration fails the suite loudly (docs/TEST_STRATEGY.md 1).
 */

const ADMIN_DSN_VAR = 'ICTT_SENTINEL_TEST_DATABASE_URL';

/**
 * Test-only login credentials, generated per process and never written anywhere.
 *
 * Role names are derived from the caller's label because vitest runs test files in
 * parallel workers: shared login roles would have each worker overwrite the
 * others' password mid-run.
 */
const LOGIN_PASSWORD = randomBytes(18).toString('hex');

export interface TestDatabase {
  /** Superuser connection on the maintenance database. */
  readonly admin: Db;
  /** Member of ictt_sentinel_migrator: owns the schema, may DDL. */
  readonly migrator: Db;
  /** Member of ictt_sentinel_runtime: the privileges the product actually runs with. */
  readonly runtime: Db;
  readonly database: string;
  /** Fresh runtime connection, for concurrency tests that need a second session. */
  connectRuntime(): Db;
  drop(): Promise<void>;
}

const adminDsn = (): string => {
  const dsn = process.env[ADMIN_DSN_VAR];
  if (dsn === undefined || dsn === '') {
    throw new Error(
      `${ADMIN_DSN_VAR} is not set. These are integration tests against a real PostgreSQL; ` +
        `start one (infra/postgres/docker-compose.yml) and export the DSN. ` +
        `They are never skipped and never fall back to a mock.`,
    );
  }
  return dsn;
};

const withDatabase = (dsn: string, database: string, user: string, password: string): string => {
  const url = new URL(dsn);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

const DB_NAME = /^[a-z][a-z0-9_]{0,48}$/;

export const createTestDatabase = async (label: string): Promise<TestDatabase> => {
  const base = adminDsn();
  const admin = createDb(base, { max: 2 });
  const database = `ictt_it_${label}_${randomBytes(4).toString('hex')}`;
  if (!DB_NAME.test(database)) throw new Error(`generated database name is invalid: ${database}`);

  const migratorLogin = `ictt_test_${label}_migrator`;
  const runtimeLogin = `ictt_test_${label}_runtime`;

  // Group roles are cluster-wide, so parallel workers would otherwise race the
  // same catalog rows ("tuple concurrently updated"). One lock, briefly held.
  await admin.sql`select pg_advisory_lock(4021, 7)`;
  try {
    await ensureRoles(admin.sql);
    for (const [login, group] of [
      [migratorLogin, MIGRATOR_ROLE],
      [runtimeLogin, RUNTIME_ROLE],
    ] as const) {
      await admin.sql.unsafe(`
        DO $it$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${login}') THEN
            CREATE ROLE ${login} LOGIN;
          END IF;
        END
        $it$;
      `);
      await admin.sql.unsafe(`ALTER ROLE ${login} WITH PASSWORD '${LOGIN_PASSWORD}'`);
      await admin.sql.unsafe(`GRANT ${group} TO ${login}`);
    }
  } finally {
    await admin.sql`select pg_advisory_unlock(4021, 7)`;
  }

  // CREATE DATABASE cannot run inside a transaction block.
  await admin.sql.unsafe(`CREATE DATABASE ${database} OWNER ${MIGRATOR_ROLE}`);

  const migrator = createDb(withDatabase(base, database, migratorLogin, LOGIN_PASSWORD), {
    max: 2,
  });
  // SET LOCAL ROLE inside the migration transaction, so every object is owned by
  // the group role rather than by this login.
  await migrate(migrator, { role: MIGRATOR_ROLE });

  const runtimeDsn = withDatabase(base, database, runtimeLogin, LOGIN_PASSWORD);
  const runtime = createDb(runtimeDsn, { max: 2 });
  const extras: Db[] = [];

  return {
    admin,
    migrator,
    runtime,
    database,
    connectRuntime: () => {
      const db = createDb(runtimeDsn, { max: 1 });
      extras.push(db);
      return db;
    },
    drop: async () => {
      await Promise.all([runtime.close(), migrator.close(), ...extras.map((d) => d.close())]);
      // Named database, dropped by name. No prune, no volume removal.
      await admin.sql.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.close();
    },
  };
};

// --------------------------------------------------------------- fact fixtures

export const hex32 = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
export const hex20 = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
export const digest = (s: string): string =>
  s
    .padEnd(64, '0')
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, '0');

export const DEPLOYMENT = 'acme-usdc';
export const CHAIN = 'home';

/** Seed the operator-curated reference rows every fact write depends on. */
export const seedReference = async (db: Db): Promise<void> => {
  await db.sql`
    insert into deployments (deployment_id, manifest_hash, asset_mode)
    values (${DEPLOYMENT}, ${digest('ab')}, 'canonical-erc20')
    on conflict do nothing
  `;
  await db.sql`
    insert into chains (chain_key, deployment_id, blockchain_id, evm_chain_id, finality_mode)
    values (${CHAIN}, ${DEPLOYMENT}, ${hex32(1)}, 43114, 'accepted-quorum')
    on conflict do nothing
  `;
  await db.sql`
    insert into chains (chain_key, deployment_id, blockchain_id, evm_chain_id, finality_mode)
    values ('remote', ${DEPLOYMENT}, ${hex32(2)}, 43113, 'accepted-quorum')
    on conflict do nothing
  `;
};
