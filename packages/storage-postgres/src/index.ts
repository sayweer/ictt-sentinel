// @ictt-sentinel/storage-postgres
//
// PostgreSQL persistence for the append-only fact ledger, the judgement records
// derived from it and the mutable operational state around both.
//
// PostgreSQL is not "immutable" and this package never claims it is. What the
// schema and the privilege model give is append-only writes plus tamper-evidence:
// the runtime role cannot UPDATE or DELETE a fact, and an accepted block whose
// hash changes produces a typed integrity incident instead of a silent rewrite.

export const PACKAGE_NAME = '@ictt-sentinel/storage-postgres' as const;

export {
  createDb,
  withTransaction,
  withAdvisoryLock,
  advisoryLockKey,
  assertRoleName,
  ROLE_NAME,
} from './client.js';
export type { Db, DbOptions, Sql, Tx } from './client.js';

export { describeDsn, dsnLabel, redactDsn, REDACTED } from './dsn.js';
export type { DsnDescription } from './dsn.js';

export {
  StorageError,
  IdempotencyConflictError,
  AcceptedHashConflictError,
  ColumnDecodeError,
  MigrationDriftError,
} from './errors.js';

export { amountToColumn, bigintToColumn, columnToAmount, columnToBigint } from './numeric.js';

export { ensureRoles, MIGRATOR_ROLE, RUNTIME_ROLE } from './bootstrap.js';
export { migrate, loadMigrations } from './migrate.js';
export type { Migration, MigrationResult, MigrateOptions } from './migrate.js';

export {
  ingestBatch,
  canonicalLogDigest,
  recordCandidateOrphan,
  readCheckpoint,
} from './ledger.js';
export type {
  BlockFact,
  LogFact,
  ObservationFact,
  Checkpoint,
  IngestBatch,
  IngestOutcome,
} from './ledger.js';

export { putEvaluation, appendVerdictEvent, evaluationIdempotencyKey } from './evaluations.js';
export type {
  PinnedBlock,
  EvaluationInput,
  EvaluationRecord,
  EvaluationWriteResult,
} from './evaluations.js';

export { rebuildTransferTotals, readTransferTotals, TRANSFER_TOTALS } from './projection.js';
export type { TransferTotalRow, RebuildResult } from './projection.js';

export {
  enqueueHint,
  pendingHintDepth,
  readPendingHints,
  markHintsConsumed,
  recordDataQualityIncident,
  recordRemoteCandidate,
  upsertCompleteness,
  readCompleteness,
  readCommittedRanges,
  upsertRangeStatus,
} from './replay-store.js';
export type {
  HintRow,
  DataQualityIncident,
  RemoteCandidateRow,
  CompletenessRow,
  RangeStatusRow,
} from './replay-store.js';

export {
  DuplicateEconomicEffectError,
  writeTransitionBatch,
  readTransitions,
  countEconomicEffects,
} from './transition-store.js';
export type { TransitionRow } from './transition-store.js';
