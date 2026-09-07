/**
 * Connection string handling.
 *
 * A DSN carries a password. It must therefore never reach a log line, an error
 * message, an evidence bundle, a crash report or a test snapshot
 * (docs/SECURITY.md, CLAUDE.md 3). Every error raised by this package is built
 * from `describeDsn`, never from the DSN itself.
 */

export interface DsnDescription {
  /** Host and port only - enough to tell two databases apart in an incident. */
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** Present so an operator can see WHICH role failed, without its credential. */
  readonly user: string;
  readonly sslMode: string;
}

/** The literal that replaces a credential anywhere one could otherwise appear. */
export const REDACTED = '[redacted]';

/**
 * Parse a DSN into its non-secret parts.
 *
 * Throws a message that contains no fragment of the input: a malformed DSN is
 * usually malformed *around* the password, so echoing it back is how credentials
 * end up in logs.
 */
export const describeDsn = (dsn: string): DsnDescription => {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL (value withheld)');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`DATABASE_URL must use postgres:// (got ${url.protocol} - value withheld)`);
  }
  const port = url.port === '' ? 5432 : Number(url.port);
  const database = url.pathname.replace(/^\//, '');
  if (database === '') throw new Error('DATABASE_URL has no database name (value withheld)');
  return {
    host: url.hostname,
    port,
    database,
    user: decodeURIComponent(url.username),
    sslMode: url.searchParams.get('sslmode') ?? 'prefer',
  };
};

/** Stable, credential-free identity for logs and error messages. */
export const dsnLabel = (d: DsnDescription): string =>
  `${d.user}@${d.host}:${String(d.port)}/${d.database}`;

/**
 * Last-resort scrubber for text that may embed a DSN - driver errors quote the
 * connection string in some failure paths, and those strings flow into our own
 * error chain. Applied to every message this package re-raises.
 */
export const redactDsn = (text: string): string =>
  text.replace(/\b(postgres(?:ql)?:\/\/)[^\s'"]*/gi, `$1${REDACTED}`);
