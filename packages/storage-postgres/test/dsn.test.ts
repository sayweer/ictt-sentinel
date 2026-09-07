import { describe, expect, it } from 'vitest';
import { describeDsn, dsnLabel, redactDsn } from '../src/dsn.js';
import {
  AcceptedHashConflictError,
  IdempotencyConflictError,
  StorageError,
} from '../src/errors.js';

const SECRET = 'sup3r-s3cret-pw';
const DSN = `postgres://ictt_runtime:${SECRET}@db.internal:5432/sentinel?sslmode=verify-full`;

describe('describeDsn', () => {
  it('extracts the non-secret parts', () => {
    const d = describeDsn(DSN);
    expect(d).toEqual({
      host: 'db.internal',
      port: 5432,
      database: 'sentinel',
      user: 'ictt_runtime',
      sslMode: 'verify-full',
    });
    expect(dsnLabel(d)).toBe('ictt_runtime@db.internal:5432/sentinel');
  });

  it('never echoes the input in a parse error', () => {
    // A malformed DSN is usually malformed around the password, so quoting the
    // input back is exactly how a credential reaches a log file.
    expect(() => describeDsn(`not a url ${SECRET}`)).toThrow(/value withheld/);
    try {
      describeDsn(`not a url ${SECRET}`);
    } catch (e) {
      expect((e as Error).message).not.toContain(SECRET);
    }
  });

  it('rejects a non-postgres scheme without quoting the value', () => {
    try {
      describeDsn(`mysql://u:${SECRET}@h/db`);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('postgres://');
      expect((e as Error).message).not.toContain(SECRET);
    }
  });
});

describe('redaction', () => {
  it('scrubs a DSN embedded in arbitrary text', () => {
    const scrubbed = redactDsn(`connect failed: ${DSN} refused`);
    expect(scrubbed).not.toContain(SECRET);
    expect(scrubbed).toContain('postgres://[redacted]');
  });

  it('scrubs through the StorageError constructor', () => {
    const e = new StorageError(`driver said: ${DSN}`);
    expect(e.message).not.toContain(SECRET);
  });

  it('keeps a subclass message free of credentials', () => {
    const e = new IdempotencyConflictError('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64));
    expect(e.name).toBe('IdempotencyConflictError');
    expect(e.message).not.toContain(SECRET);
  });
});

describe('AcceptedHashConflictError', () => {
  it('states that evidence is preserved, not rolled back', () => {
    const e = new AcceptedHashConflictError(
      'c-chain',
      42n,
      `0x${'a'.repeat(64)}`,
      `0x${'b'.repeat(64)}`,
    );
    expect(e.incidentKind).toBe('ACCEPTED_HASH_CONFLICT');
    expect(e.blockNumber).toBe(42n);
    expect(e.message).toContain('evidence preserved, no rollback');
    // The word this failure must never be reported as.
    expect(e.message).not.toMatch(/reorg/i);
  });
});
