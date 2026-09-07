import { createHash } from 'node:crypto';
import { type Amount, type Parsed } from '@ictt-sentinel/domain';
import type { Db } from './client.js';
import { ColumnDecodeError } from './errors.js';
import { bigintToColumn, columnToAmount, columnToBigint } from './numeric.js';

/**
 * Derived read models.
 *
 * A projection holds nothing the raw facts do not already imply, which is what
 * makes it safe to drop and rebuild at a new version. The rebuild is also the
 * standing check on the ledger: the same facts must always produce the same
 * `sourceDigest`, whatever order they arrived in and whichever version computed it.
 */

export const TRANSFER_TOTALS = 'transfer_totals';

export interface TransferTotalRow {
  readonly deploymentId: string;
  readonly chainKey: string;
  readonly subject: string;
  readonly totalAmount: Amount;
  readonly observationCount: bigint;
}

export interface RebuildResult {
  readonly projection: string;
  readonly version: number;
  readonly rows: number;
  /** Content digest of the source facts, independent of projection version. */
  readonly sourceDigest: string;
}

const unwrap = <T>(parsed: Parsed<T>, column: string): T => {
  if (!parsed.ok) throw new ColumnDecodeError(column, parsed.error);
  return parsed.value;
};

interface AggregateRow {
  readonly deployment_id: string;
  readonly chain_key: string;
  readonly subject: string;
  readonly total_amount: string;
  readonly observation_count: string;
}

/**
 * Aggregate over accepted blocks only.
 *
 * The join to `chain_blocks` with `observed_class = 'accepted'` is the reason a
 * candidate observation cannot reach a read model: it is filtered in the source
 * query, not after the fact, so there is no path where a speed-path row is summed
 * and later subtracted.
 */
const aggregate = async (db: Db, deploymentId: string): Promise<readonly AggregateRow[]> =>
  db.sql<AggregateRow[]>`
    select
      o.deployment_id,
      o.chain_key,
      o.subject,
      coalesce(sum(o.amount), 0)::text as total_amount,
      count(*)::text                   as observation_count
    from observations o
    join chain_blocks b
      on b.chain_key = o.chain_key
     and b.block_hash = o.block_hash
    where o.deployment_id = ${deploymentId}
      and b.observed_class = 'accepted'
    group by o.deployment_id, o.chain_key, o.subject
    order by o.chain_key, o.subject
  `;

/**
 * Digest of the aggregated source facts.
 *
 * Computed from the ordered aggregate rather than from insertion order, so two
 * databases that ingested the same facts through different chunkings agree.
 */
const digestOf = (rows: readonly AggregateRow[]): string => {
  const h = createHash('sha256');
  for (const r of rows) {
    h.update(
      `${r.deployment_id}|${r.chain_key}|${r.subject}|${r.total_amount}|${r.observation_count}\n`,
    );
  }
  return h.digest('hex');
};

/**
 * Rebuild the transfer-totals projection at a given version.
 *
 * Rows for that version are replaced wholesale inside one transaction: a
 * half-rebuilt read model that still answers queries would be worse than one that
 * is briefly absent. Older versions are left in place so a rollback does not need
 * a second rebuild.
 */
export const rebuildTransferTotals = async (
  db: Db,
  args: { deploymentId: string; version: number },
): Promise<RebuildResult> => {
  const rows = await aggregate(db, args.deploymentId);
  const sourceDigest = digestOf(rows);

  // Decode through the domain types before writing: an amount that no longer fits
  // uint256 means the ledger is wrong, and the projection must not launder it.
  const decoded: TransferTotalRow[] = rows.map((r) => ({
    deploymentId: r.deployment_id,
    chainKey: r.chain_key,
    subject: r.subject,
    totalAmount: unwrap(columnToAmount(r.total_amount), 'observations.amount sum'),
    observationCount: unwrap(columnToBigint(r.observation_count), 'observation_count'),
  }));

  await db.sql.begin(async (tx) => {
    await tx`
      delete from projection_transfer_totals
      where projection_version = ${args.version} and deployment_id = ${args.deploymentId}
    `;
    for (const row of decoded) {
      await tx`
        insert into projection_transfer_totals
          (projection_version, deployment_id, chain_key, subject, total_amount, observation_count, source_digest)
        values
          (${args.version}, ${row.deploymentId}, ${row.chainKey}, ${row.subject},
           ${(row.totalAmount as bigint).toString(10)}, ${bigintToColumn(row.observationCount)}, ${sourceDigest})
      `;
    }
    await tx`
      insert into projection_versions (projection_name, version, source_digest, rebuilt_at)
      values (${TRANSFER_TOTALS}, ${args.version}, ${sourceDigest}, now())
      on conflict (projection_name) do update
        set version = excluded.version,
            source_digest = excluded.source_digest,
            rebuilt_at = excluded.rebuilt_at
    `;
  });

  return {
    projection: TRANSFER_TOTALS,
    version: args.version,
    rows: decoded.length,
    sourceDigest,
  };
};

/** Read the projection back. Amounts come back as domain Amounts, never strings. */
export const readTransferTotals = async (
  db: Db,
  args: { deploymentId: string; version: number },
): Promise<readonly TransferTotalRow[]> => {
  const rows = await db.sql<
    { chain_key: string; subject: string; total_amount: string; observation_count: string }[]
  >`
    select chain_key, subject, total_amount::text, observation_count::text
    from projection_transfer_totals
    where projection_version = ${args.version} and deployment_id = ${args.deploymentId}
    order by chain_key, subject
  `;
  return rows.map((r) => ({
    deploymentId: args.deploymentId,
    chainKey: r.chain_key,
    subject: r.subject,
    totalAmount: unwrap(columnToAmount(r.total_amount), 'projection_transfer_totals.total_amount'),
    observationCount: unwrap(
      columnToBigint(r.observation_count),
      'projection_transfer_totals.observation_count',
    ),
  }));
};
