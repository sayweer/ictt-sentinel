import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { type Db, type Tx, assertRoleName } from './client.js';
import { MigrationDriftError } from './errors.js';

/**
 * Explicit, versioned migration runner.
 *
 * Nothing calls this on application startup. An app that migrates itself needs a
 * credential that can DDL, on every process, forever; making it a separate
 * command keeps that privilege out of the running service (docs/SECURITY.md).
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface MigrationResult {
  readonly applied: readonly number[];
  readonly alreadyApplied: readonly number[];
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Load the migration set from disk, ordered by version. */
export const loadMigrations = (dir: string = MIGRATIONS_DIR): readonly Migration[] => {
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((file) => {
      const m = FILE_NAME.exec(file);
      if (!m?.[1] || !m[2]) {
        throw new Error(`migration file name must be NNNN_snake_case.sql, got ${file}`);
      }
      const sql = readFileSync(join(dir, file), 'utf8');
      return { version: Number(m[1]), name: m[2], checksum: sha256(sql), sql };
    })
    .sort((a, b) => a.version - b.version);

  migrations.forEach((mig, i) => {
    // A gap or a duplicate means two branches picked the same number; applying
    // them in filename order would give two databases different histories.
    if (mig.version !== i + 1) {
      throw new Error(
        `migration versions must be a dense 1..n sequence; expected ${String(i + 1)}, got ${String(mig.version)}`,
      );
    }
  });
  return migrations;
};

const hasMigrationsTable = async (tx: Tx): Promise<boolean> => {
  const rows = await tx<{ present: boolean }[]>`
    select to_regclass('public.schema_migrations') is not null as present
  `;
  return rows[0]?.present === true;
};

/**
 * Apply every pending migration, in one transaction per migration.
 *
 * Two guarantees matter here:
 *   - An applied migration is immutable. If the file changed after it ran, this
 *     raises MigrationDriftError instead of "repairing" the checksum, because the
 *     database has already taken the old shape and only a new migration can move it.
 *   - Concurrent runners serialise on an advisory lock rather than racing DDL.
 */
export interface MigrateOptions {
  readonly migrations?: readonly Migration[];
  /**
   * Role to assume for the run, so every object ends up owned by the migrator
   * group rather than by whichever login role happened to connect.
   */
  readonly role?: string;
}

export const migrate = async (db: Db, options: MigrateOptions = {}): Promise<MigrationResult> => {
  const migrations = options.migrations ?? loadMigrations();
  const applied: number[] = [];
  const alreadyApplied: number[] = [];

  await db.sql.begin(async (tx) => {
    // Held for the whole run: a second migrator waits instead of interleaving.
    await tx`select pg_advisory_xact_lock(4021, 1)`;
    if (options.role !== undefined) {
      // SET LOCAL cannot take a bound parameter, so the name is validated against
      // the identifier grammar first and reverts automatically at commit.
      await tx.unsafe(`SET LOCAL ROLE ${assertRoleName(options.role)}`);
    }

    const bootstrapped = await hasMigrationsTable(tx);
    const recorded = bootstrapped
      ? await tx<{ version: number; checksum: string }[]>`
          select version, checksum from schema_migrations order by version
        `
      : [];
    const byVersion = new Map(recorded.map((r) => [r.version, r.checksum]));

    for (const mig of migrations) {
      const seen = byVersion.get(mig.version);
      if (seen !== undefined) {
        if (seen !== mig.checksum) {
          throw new MigrationDriftError(mig.version, seen, mig.checksum);
        }
        alreadyApplied.push(mig.version);
        continue;
      }
      // `unsafe` is unavoidable for DDL: a migration body is a script, not a
      // parameterised statement. The input is a file shipped inside this package,
      // never anything derived from a request or a database row.
      await tx.unsafe(mig.sql);
      await tx`
        insert into schema_migrations (version, name, checksum)
        values (${mig.version}, ${mig.name}, ${mig.checksum})
      `;
      applied.push(mig.version);
    }
  });

  return { applied, alreadyApplied };
};
