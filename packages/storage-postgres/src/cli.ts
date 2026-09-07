import { createDb } from './client.js';
import { MIGRATOR_ROLE, ensureRoles } from './bootstrap.js';
import { migrate } from './migrate.js';
import { redactDsn } from './dsn.js';

/**
 * The explicit migration entry point.
 *
 * Deliberately a separate command rather than something the application runs at
 * startup. Self-migrating services need a DDL-capable credential in every process
 * forever; this keeps that privilege in one operator-run job (docs/RUNBOOK.md).
 *
 *   pnpm --filter @ictt-sentinel/storage-postgres run migrate
 *   pnpm --filter @ictt-sentinel/storage-postgres run migrate -- --bootstrap-roles
 *
 * The DSN is read from ICTT_SENTINEL_DATABASE_URL. Only the name of that variable
 * appears in code; the value is never logged, and any error text that might quote
 * it is scrubbed on the way out.
 */

const DSN_VAR = 'ICTT_SENTINEL_DATABASE_URL';

const main = async (argv: readonly string[]): Promise<number> => {
  const dsn = process.env[DSN_VAR];
  if (dsn === undefined || dsn === '') {
    process.stderr.write(`${DSN_VAR} is not set\n`);
    return 2;
  }

  const db = createDb(dsn, { max: 1 });
  try {
    if (argv.includes('--bootstrap-roles')) {
      // Requires a superuser connection, and is expected to run once per cluster.
      await ensureRoles(db.sql);
      process.stdout.write(`roles ensured on ${db.label}\n`);
    }
    const result = await migrate(db, { role: MIGRATOR_ROLE });
    process.stdout.write(
      `migrate ${db.label}: applied [${result.applied.join(', ')}], ` +
        `already applied [${result.alreadyApplied.join(', ')}]\n`,
    );
    return 0;
  } catch (e) {
    process.stderr.write(`${redactDsn(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  } finally {
    await db.close();
  }
};

process.exitCode = await main(process.argv.slice(2));
