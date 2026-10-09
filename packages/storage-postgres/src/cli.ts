import { readFileSync } from 'node:fs';
import { loadManifest } from '@ictt-sentinel/config';
import { createDb } from './client.js';
import { referenceRowsFor, registerDeployment } from './reference.js';
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
 *   pnpm --filter @ictt-sentinel/storage-postgres run migrate -- --register-deployment <manifest>
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
      // The bootstrap DSN intentionally points at the maintenance database.
      // Applying application migrations there would both violate that boundary
      // and fail ownership checks. Migration is a separate invocation against
      // the operator-created, migrator-owned application database.
      return 0;
    }
    const registerAt = argv.indexOf('--register-deployment');
    if (registerAt !== -1) {
      // Reference rows are operator-curated: written here by the migrator from a
      // reviewed manifest, read-only to the runtime role.
      const path = argv[registerAt + 1];
      if (path === undefined || path.startsWith('-')) {
        process.stderr.write('--register-deployment requires a manifest path\n');
        return 2;
      }
      const manifest = loadManifest(readFileSync(path, 'utf8'));
      if (manifest.value.spec.baseline.state !== 'approved') {
        process.stderr.write('only an operator-approved manifest baseline can be registered\n');
        return 2;
      }
      const result = await registerDeployment(
        db,
        referenceRowsFor(manifest.value, manifest.digest),
      );
      process.stdout.write(
        `registered ${manifest.value.metadata.name} on ${db.label}: ${String(result.inserted)} new row(s)\n`,
      );
      return 0;
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
