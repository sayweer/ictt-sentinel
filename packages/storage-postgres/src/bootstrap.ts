import type { Sql } from './client.js';

/**
 * One-time role creation. Runs as a superuser, separately from migrations.
 *
 * Kept out of the migration sequence on purpose: creating roles needs privileges
 * the migration runner must not hold, and folding the two together would mean
 * the day-to-day migration credential could also mint roles.
 *
 * Neither role is given LOGIN or a password here. Login roles are granted
 * membership by the operator (docs/RUNBOOK.md), so no credential is ever created
 * by this codebase.
 */

export const MIGRATOR_ROLE = 'ictt_sentinel_migrator';
export const RUNTIME_ROLE = 'ictt_sentinel_runtime';

export const ensureRoles = async (sql: Sql): Promise<void> => {
  await sql`
    DO $ictt$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ictt_sentinel_migrator') THEN
        CREATE ROLE ictt_sentinel_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ictt_sentinel_runtime') THEN
        CREATE ROLE ictt_sentinel_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
      END IF;
    END
    $ictt$;
  `;
};
