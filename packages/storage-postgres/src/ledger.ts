import { createHash } from 'node:crypto';
import type { Amount } from '@ictt-sentinel/domain';
import { type Db, type Tx, advisoryLockKey, withAdvisoryLock } from './client.js';
import { AcceptedHashConflictError } from './errors.js';
import { amountToColumn, bigintToColumn } from './numeric.js';

/**
 * The raw fact ledger.
 *
 * Writes here are append-only and idempotent. Re-ingesting a batch that is
 * already stored is a no-op, which is what makes a crashed worker safe to restart
 * and a duplicated webhook harmless.
 */

export interface BlockFact {
  readonly chainKey: string;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly parentHash: string;
  readonly blockTimestamp: bigint;
  /** `accepted` is the canonical truth path; `candidate` can never become a fact. */
  readonly observedClass: 'accepted' | 'candidate';
  readonly observedAt: Date;
}

export interface LogFact {
  readonly chainKey: string;
  readonly blockHash: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly txIndex: number;
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly observedAt: Date;
}

export interface ObservationFact {
  readonly observationId: string;
  readonly deploymentId: string;
  readonly chainKey: string;
  readonly blockHash: string;
  readonly blockNumber: bigint;
  readonly subject: string;
  readonly amount: Amount | null;
  readonly finalityBasis: string;
  /** Quorum provenance. Counted distinct; two URLs of one upstream are one entry. */
  readonly providerGroups: readonly string[];
  readonly payloadDigest: string;
  readonly observedAt: Date;
  readonly expiresAt: Date;
}

export interface Checkpoint {
  readonly deploymentId: string;
  readonly chainKey: string;
  readonly lastBlockNumber: bigint;
  readonly lastBlockHash: string;
}

export interface IngestBatch {
  readonly deploymentId: string;
  readonly chainKey: string;
  readonly blocks: readonly BlockFact[];
  readonly logs: readonly LogFact[];
  readonly observations?: readonly ObservationFact[];
  /**
   * Advanced in the SAME transaction as the facts above, or not at all. A
   * checkpoint that outran its evidence is how a gap becomes invisible.
   */
  readonly checkpoint?: Checkpoint;
}

export interface IngestOutcome {
  readonly blocksInserted: number;
  readonly logsInserted: number;
  readonly observationsInserted: number;
  readonly checkpointAdvanced: boolean;
  /** Canonical digest of the batch, independent of arrival order. */
  readonly rangeDigest: string;
}

/** PostgreSQL unique_violation. */
const UNIQUE_VIOLATION = '23505';
const ACCEPTED_HEIGHT_INDEX = 'chain_blocks_one_accepted_per_height';

const isUniqueViolationOn = (e: unknown, constraint: string): boolean =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: string }).code === UNIQUE_VIOLATION &&
  ((e as { constraint_name?: string }).constraint_name === constraint ||
    (e as { constraint?: string }).constraint === constraint);

/**
 * Canonical digest over a set of logs.
 *
 * Sorted by (block_number, tx_index, log_index) before hashing, so the same facts
 * fetched in a different chunk order, from a different provider, or replayed in a
 * different sequence produce the same digest. That equality is the reproducibility
 * promise (docs/DATA_MODEL.md 4), so it is computed here rather than trusted.
 */
export const canonicalLogDigest = (logs: readonly LogFact[]): string => {
  const ordered = [...logs].sort(
    (a, b) =>
      Number(a.blockNumber - b.blockNumber) || a.txIndex - b.txIndex || a.logIndex - b.logIndex,
  );
  const h = createHash('sha256');
  for (const l of ordered) {
    h.update(
      [
        l.chainKey,
        l.blockHash,
        l.txHash,
        String(l.logIndex),
        l.blockNumber.toString(10),
        String(l.txIndex),
        l.address,
        l.topics.join(','),
        l.data,
      ].join('|'),
    );
    // Explicit record terminator. Every field is hex or decimal, so neither
    // this nor the field separator can occur inside a value, and two
    // different log sets cannot serialise to the same byte string.
    h.update('\n');
  }
  return h.digest('hex');
};

const insertBlocks = async (tx: Tx, blocks: readonly BlockFact[]): Promise<number> => {
  let inserted = 0;
  for (const b of blocks) {
    const rows = await tx`
      insert into chain_blocks
        (chain_key, block_hash, block_number, parent_hash, block_timestamp, observed_class, observed_at)
      values
        (${b.chainKey}, ${b.blockHash}, ${bigintToColumn(b.blockNumber)}, ${b.parentHash},
         ${bigintToColumn(b.blockTimestamp)}, ${b.observedClass}, ${b.observedAt})
      on conflict (chain_key, block_hash) do nothing
      returning block_hash
    `;
    inserted += rows.length;
  }
  return inserted;
};

const insertLogs = async (tx: Tx, logs: readonly LogFact[]): Promise<number> => {
  let inserted = 0;
  for (const l of logs) {
    const rows = await tx`
      insert into chain_logs
        (chain_key, block_hash, tx_hash, log_index, block_number, tx_index, address, topics, data, observed_at)
      values
        (${l.chainKey}, ${l.blockHash}, ${l.txHash}, ${l.logIndex}, ${bigintToColumn(l.blockNumber)},
         ${l.txIndex}, ${l.address}, ${tx.array([...l.topics])}, ${l.data}, ${l.observedAt})
      on conflict (chain_key, block_hash, tx_hash, log_index) do nothing
      returning log_index
    `;
    inserted += rows.length;
  }
  return inserted;
};

const insertObservations = async (
  tx: Tx,
  observations: readonly ObservationFact[],
): Promise<number> => {
  let inserted = 0;
  for (const o of observations) {
    const rows = await tx`
      insert into observations
        (observation_id, deployment_id, chain_key, block_hash, block_number, subject, amount,
         finality_basis, provider_groups, payload_digest, observed_at, expires_at)
      values
        (${o.observationId}, ${o.deploymentId}, ${o.chainKey}, ${o.blockHash}, ${bigintToColumn(o.blockNumber)},
         ${o.subject}, ${o.amount === null ? null : amountToColumn(o.amount)},
         ${o.finalityBasis}, ${tx.array([...o.providerGroups])}, ${o.payloadDigest},
         ${o.observedAt}, ${o.expiresAt})
      on conflict (deployment_id, chain_key, block_hash, subject) do nothing
      returning observation_id
    `;
    inserted += rows.length;
  }
  return inserted;
};

const recordIntegrityIncident = async (
  db: Db,
  incident: {
    incidentId: string;
    kind: 'RPC_INTEGRITY_CONFLICT' | 'ACCEPTED_HASH_CONFLICT' | 'LOG_DIGEST_DIVERGENCE';
    chainKey: string;
    blockNumber: bigint | null;
    expectedHash: string | null;
    observedHash: string | null;
    detail: unknown;
  },
): Promise<void> => {
  await db.sql`
    insert into integrity_incidents
      (incident_id, kind, chain_key, block_number, expected_hash, observed_hash, detail)
    values
      (${incident.incidentId}, ${incident.kind}, ${incident.chainKey}, ${incident.blockNumber === null ? null : bigintToColumn(incident.blockNumber)},
       ${incident.expectedHash}, ${incident.observedHash}, ${db.sql.json(incident.detail as never)})
    on conflict (incident_id) do nothing
  `;
};

/**
 * Persist a batch of facts and, optionally, the checkpoint that covers it.
 *
 * On an accepted-hash conflict the transaction is rolled back - so no partial
 * facts and no checkpoint - a typed integrity incident is recorded in its own
 * transaction, and the error propagates. The previously stored evidence is left
 * exactly as it was: this is not a reorg to be rewound, it is two irreconcilable
 * observations of a final block.
 */
export const ingestBatch = async (db: Db, batch: IngestBatch): Promise<IngestOutcome> => {
  const rangeDigest = canonicalLogDigest(batch.logs);
  const lane = `${batch.deploymentId}:${batch.chainKey}`;

  try {
    return await db.sql.begin(async (tx) =>
      withAdvisoryLock(tx, advisoryLockKey(lane), async () => {
        const blocksInserted = await insertBlocks(tx, batch.blocks);
        const logsInserted = await insertLogs(tx, batch.logs);
        const observationsInserted = await insertObservations(tx, batch.observations ?? []);

        let checkpointAdvanced = false;
        if (batch.checkpoint) {
          const c = batch.checkpoint;
          // Monotonic: a lower checkpoint is a stale worker's write, not progress.
          const rows = await tx`
            insert into replay_checkpoints
              (deployment_id, chain_key, last_block_number, last_block_hash, updated_at)
            values (${c.deploymentId}, ${c.chainKey}, ${bigintToColumn(c.lastBlockNumber)}, ${c.lastBlockHash}, now())
            on conflict (deployment_id, chain_key) do update
              set last_block_number = excluded.last_block_number,
                  last_block_hash   = excluded.last_block_hash,
                  updated_at        = now()
            where replay_checkpoints.last_block_number < excluded.last_block_number
            returning last_block_number
          `;
          checkpointAdvanced = rows.length > 0;
        }

        return {
          blocksInserted,
          logsInserted,
          observationsInserted,
          checkpointAdvanced,
          rangeDigest,
        };
      }),
    );
  } catch (e) {
    if (isUniqueViolationOn(e, ACCEPTED_HEIGHT_INDEX)) {
      const offending = batch.blocks.find((b) => b.observedClass === 'accepted');
      const chainKey = offending?.chainKey ?? batch.chainKey;
      const blockNumber = offending?.blockNumber ?? null;
      // The evidence already on disk. Read, never touched: it is one half of the
      // contradiction the incident records.
      let stored: string | null = null;
      if (blockNumber !== null) {
        const rows = await db.sql<{ block_hash: string }[]>`
          select block_hash from chain_blocks
          where chain_key = ${chainKey}
            and block_number = ${bigintToColumn(blockNumber)}
            and observed_class = 'accepted'
        `;
        stored = rows[0]?.block_hash ?? null;
      }

      const observedHash = offending?.blockHash ?? null;
      await recordIntegrityIncident(db, {
        incidentId: createHash('sha256')
          .update(`${chainKey}|${String(blockNumber)}|${String(stored)}|${String(observedHash)}`)
          .digest('hex'),
        kind: 'ACCEPTED_HASH_CONFLICT',
        chainKey,
        blockNumber,
        expectedHash: stored,
        observedHash,
        detail: {
          lane,
          note: 'accepted block hash changed; evidence preserved, no rollback, verdict is UNKNOWN',
        },
      });

      throw new AcceptedHashConflictError(
        chainKey,
        blockNumber ?? 0n,
        stored ?? 'unknown',
        observedHash ?? 'unknown',
      );
    }
    throw e;
  }
};

/**
 * Mark a previously observed candidate block as orphaned.
 *
 * This appends to the status history; the raw row and its logs stay. Accepted
 * blocks are rejected outright - orphaning one would be rewriting final history,
 * which is the integrity incident path, not this one.
 */
export const recordCandidateOrphan = async (
  db: Db,
  args: { eventId: string; chainKey: string; blockHash: string; reason: string },
): Promise<void> => {
  await db.sql.begin(async (tx) => {
    const rows = await tx<{ observed_class: string }[]>`
      select observed_class from chain_blocks
      where chain_key = ${args.chainKey} and block_hash = ${args.blockHash}
    `;
    const cls = rows[0]?.observed_class;
    if (cls === undefined) throw new Error(`unknown block ${args.chainKey}/${args.blockHash}`);
    if (cls !== 'candidate') {
      throw new Error(
        `refusing to orphan a block observed as ${cls}; only candidates may be orphaned`,
      );
    }
    await tx`
      insert into block_status_events (event_id, chain_key, block_hash, status, reason)
      values (${args.eventId}, ${args.chainKey}, ${args.blockHash}, 'orphaned', ${args.reason})
      on conflict (event_id) do nothing
    `;
  });
};

export const readCheckpoint = async (
  db: Db,
  deploymentId: string,
  chainKey: string,
): Promise<{ lastBlockNumber: bigint; lastBlockHash: string } | null> => {
  const rows = await db.sql<{ last_block_number: string; last_block_hash: string }[]>`
    select last_block_number, last_block_hash from replay_checkpoints
    where deployment_id = ${deploymentId} and chain_key = ${chainKey}
  `;
  const r = rows[0];
  return r
    ? { lastBlockNumber: BigInt(r.last_block_number), lastBlockHash: r.last_block_hash }
    : null;
};
