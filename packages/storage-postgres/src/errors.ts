import { redactDsn } from './dsn.js';

/**
 * Typed storage failures.
 *
 * Each of these is a distinct operational answer, not a generic "write failed":
 * an idempotency conflict means someone recomputed the same key from different
 * inputs, while an integrity conflict means the chain view itself disagreed with
 * evidence we already hold. Collapsing them into one error is how a chain-safety
 * incident gets silently retried away.
 */

export class StorageError extends Error {
  override readonly name: string = 'StorageError';
  constructor(message: string, options?: { cause?: unknown }) {
    // Every message crossing this constructor is scrubbed, so a driver error that
    // quoted the connection string cannot leak through a re-raise.
    super(redactDsn(message), options);
  }
}

/**
 * The same idempotency key was written before with a different payload.
 *
 * Retrying identical work is a no-op; this is the other case, and it means the
 * key does not actually cover everything the payload depends on.
 */
export class IdempotencyConflictError extends StorageError {
  override readonly name = 'IdempotencyConflictError';
  readonly idempotencyKey: string;
  readonly storedDigest: string;
  readonly incomingDigest: string;

  constructor(idempotencyKey: string, storedDigest: string, incomingDigest: string) {
    super(
      `idempotency key ${idempotencyKey} already stored with payload digest ` +
        `${storedDigest}, refusing to overwrite with ${incomingDigest}`,
    );
    this.idempotencyKey = idempotencyKey;
    this.storedDigest = storedDigest;
    this.incomingDigest = incomingDigest;
  }
}

/**
 * A height we already recorded as accepted came back with a different hash.
 *
 * This is deliberately NOT modelled as a reorg. On Avalanche acceptance is final,
 * so a changed accepted hash means one of the two observations is wrong. The
 * stored evidence is kept, no rollback happens, and the answer becomes
 * UNKNOWN/BLOCKED until a human resolves it (CLAUDE.md 5, docs/INVARIANTS.md).
 */
export class AcceptedHashConflictError extends StorageError {
  override readonly name = 'AcceptedHashConflictError';
  readonly incidentKind = 'ACCEPTED_HASH_CONFLICT' as const;
  readonly chainKey: string;
  readonly blockNumber: bigint;
  readonly storedHash: string;
  readonly observedHash: string;

  constructor(chainKey: string, blockNumber: bigint, storedHash: string, observedHash: string) {
    super(
      `accepted block ${chainKey}#${blockNumber.toString(10)} is already recorded as ` +
        `${storedHash} but was observed as ${observedHash}; evidence preserved, no rollback`,
    );
    this.chainKey = chainKey;
    this.blockNumber = blockNumber;
    this.storedHash = storedHash;
    this.observedHash = observedHash;
  }
}

/** A value crossed the SQL boundary in a shape the domain refuses to accept. */
export class ColumnDecodeError extends StorageError {
  override readonly name = 'ColumnDecodeError';
  constructor(column: string, reason: string) {
    super(`column ${column}: ${reason}`);
  }
}

/** A migration file changed after it was applied. The fix is a new migration. */
export class MigrationDriftError extends StorageError {
  override readonly name = 'MigrationDriftError';
  readonly version: number;

  constructor(version: number, appliedChecksum: string, fileChecksum: string) {
    super(
      `migration ${String(version)} was applied with checksum ${appliedChecksum} but the file now ` +
        `hashes to ${fileChecksum}; an applied migration is immutable, add a new one instead`,
    );
    this.version = version;
  }
}
