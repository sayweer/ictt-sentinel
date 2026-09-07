import postgres from 'postgres';
import { type DsnDescription, describeDsn, dsnLabel } from './dsn.js';
import { StorageError } from './errors.js';

/**
 * The connection boundary.
 *
 * Every statement in this package goes through a tagged template, so values are
 * always bound parameters and never interpolated text. There is deliberately no
 * `query(string)` escape hatch: one would be enough to reintroduce injection.
 */

export type Sql = postgres.Sql;
/** Inside `withTransaction` the same tagged-template API, scoped to the transaction. */
export type Tx = postgres.TransactionSql;

export interface Db {
  readonly sql: Sql;
  readonly description: DsnDescription;
  /** Credential-free identity, safe for logs and error messages. */
  readonly label: string;
  close(): Promise<void>;
}

export interface DbOptions {
  /** Pool size. One is the right answer for a migration runner. */
  readonly max?: number;
  /** Statement timeout in seconds; unbounded statements are an availability bug. */
  readonly statementTimeoutSeconds?: number;
}

/**
 * PostgreSQL identifier grammar. Role names cannot be bound parameters, so any
 * role name that reaches SQL as an identifier is matched against this first.
 */
export const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export const assertRoleName = (role: string): string => {
  if (!ROLE_NAME.test(role)) {
    throw new StorageError(`not a valid role name: ${JSON.stringify(role)}`);
  }
  return role;
};

export const createDb = (dsn: string, options: DbOptions = {}): Db => {
  const description = describeDsn(dsn);
  const label = dsnLabel(description);
  const { max = 4, statementTimeoutSeconds = 30 } = options;

  const sql: Sql = postgres(dsn, {
    max,
    // No custom type parsers: NUMERIC and int8 stay strings and are decoded
    // through numeric.ts. Any driver-side coercion to a JS number defeats that.
    types: {},
    prepare: true,
    onnotice: () => {
      // Notices are chatty (`role already exists`, index hints) and can echo
      // parameter values. Nothing here is load-bearing, so drop them rather than
      // route unfiltered server text into the application log.
    },
    connection: {
      application_name: 'ictt-sentinel',
      statement_timeout: statementTimeoutSeconds * 1000,
    },
  });

  return {
    sql,
    description,
    label,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
};

/**
 * Run work in a single transaction.
 *
 * The whole point of this helper is that a fact write and the checkpoint that
 * covers it share one transaction: if the process dies midway, both are gone and
 * the replay resumes from the last complete unit rather than from a checkpoint
 * that outran its evidence.
 */
export const withTransaction = async <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  db.sql.begin(fn) as Promise<T>;

/**
 * Session-level advisory lock, used as the single-writer guard for a
 * (deployment, chain) ingest lane.
 *
 * Two workers racing the same lane is not a hypothetical: it is what happens on a
 * rolling restart. The loser waits rather than interleaving writes with the
 * winner, which is what keeps checkpoint advancement linear.
 */
export const withAdvisoryLock = async <T>(
  tx: Tx,
  lockKey: readonly [number, number],
  fn: () => Promise<T>,
): Promise<T> => {
  const [a, b] = lockKey;
  // Transaction-scoped: released on commit or rollback, including a crash.
  await tx`select pg_advisory_xact_lock(${a}::int, ${b}::int)`;
  return fn();
};

/**
 * Stable 32-bit pair derived from a lane name, for `pg_advisory_xact_lock`.
 * FNV-1a; collisions only cost contention, never correctness.
 */
export const advisoryLockKey = (lane: string): readonly [number, number] => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < lane.length; i += 1) {
    h1 = Math.imul(h1 ^ lane.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ lane.charCodeAt(lane.length - 1 - i), 0x811c9dc5) >>> 0;
  }
  // pg advisory keys are signed int4.
  return [h1 | 0, h2 | 0] as const;
};
