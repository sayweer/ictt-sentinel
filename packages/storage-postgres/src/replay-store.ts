import type { Db } from './client.js';
import { bigintToColumn } from './numeric.js';

/**
 * Storage for the replay layer.
 *
 * Kept here rather than in `@ictt-sentinel/replay` so that every SQL statement in
 * the product lives behind one boundary; the replay package stays pure planning
 * plus orchestration and never writes a query of its own.
 */

// ----------------------------------------------------------------- hint queue

export interface HintRow {
  readonly hintId: string;
  readonly deploymentId: string;
  readonly chainKey: string;
  readonly suggestedBlockNumber: bigint;
  readonly source: 'webhook' | 'metrics-api' | 'data-api';
  readonly dedupKey: string;
}

/**
 * Enqueue a hint, or do nothing if this upstream event was already delivered.
 *
 * Returns whether the row was new, which is the replay-protection signal: a
 * redelivered webhook is silently absorbed instead of queueing the work twice.
 */
export const enqueueHint = async (db: Db, hint: HintRow): Promise<boolean> => {
  const rows = await db.sql`
    insert into webhook_hints
      (hint_id, deployment_id, chain_key, suggested_block_number, source, dedup_key)
    values
      (${hint.hintId}, ${hint.deploymentId}, ${hint.chainKey},
       ${bigintToColumn(hint.suggestedBlockNumber)}, ${hint.source}, ${hint.dedupKey})
    on conflict (dedup_key) do nothing
    returning hint_id
  `;
  return rows.length > 0;
};

export const pendingHintDepth = async (
  db: Db,
  deploymentId: string,
  chainKey: string,
): Promise<number> => {
  const rows = await db.sql<{ n: string }[]>`
    select count(*)::text as n from webhook_hints
    where deployment_id = ${deploymentId} and chain_key = ${chainKey} and consumed_at is null
  `;
  return Number(rows[0]?.n ?? '0');
};

export const readPendingHints = async (
  db: Db,
  deploymentId: string,
  chainKey: string,
  limit: number,
): Promise<
  readonly {
    hintId: string;
    suggestedBlockNumber: bigint;
    source: HintRow['source'];
    dedupKey: string;
    receivedAt: Date;
  }[]
> => {
  const rows = await db.sql<
    {
      hint_id: string;
      suggested_block_number: string;
      source: HintRow['source'];
      dedup_key: string;
      received_at: Date;
    }[]
  >`
    select hint_id, suggested_block_number::text, source, dedup_key, received_at
    from webhook_hints
    where deployment_id = ${deploymentId} and chain_key = ${chainKey} and consumed_at is null
    order by received_at
    limit ${limit}
  `;
  return rows.map((r) => ({
    hintId: r.hint_id,
    suggestedBlockNumber: BigInt(r.suggested_block_number),
    source: r.source,
    dedupKey: r.dedup_key,
    receivedAt: r.received_at,
  }));
};

export const markHintsConsumed = async (db: Db, dedupKeys: readonly string[]): Promise<number> => {
  if (dedupKeys.length === 0) return 0;
  const rows = await db.sql`
    update webhook_hints set consumed_at = now()
    where dedup_key in ${db.sql([...dedupKeys])} and consumed_at is null
    returning hint_id
  `;
  return rows.length;
};

// ------------------------------------------------------ data-quality incidents

export interface DataQualityIncident {
  readonly incidentId: string;
  readonly deploymentId: string;
  readonly chainKey: string;
  readonly reasonCode: string;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly providerGroup: string | null;
  readonly runbook: string;
  readonly detail: unknown;
}

export const recordDataQualityIncident = async (
  db: Db,
  incident: DataQualityIncident,
): Promise<void> => {
  await db.sql`
    insert into data_quality_incidents
      (incident_id, deployment_id, chain_key, reason_code, from_block, to_block,
       provider_group, runbook, detail)
    values
      (${incident.incidentId}, ${incident.deploymentId}, ${incident.chainKey},
       ${incident.reasonCode}, ${bigintToColumn(incident.fromBlock)},
       ${bigintToColumn(incident.toBlock)}, ${incident.providerGroup},
       ${incident.runbook}, ${db.sql.json(incident.detail as never)})
    on conflict (incident_id) do nothing
  `;
};

// ----------------------------------------------------------- remote candidates

export interface RemoteCandidateRow {
  readonly deploymentId: string;
  readonly remoteBlockchainId: string;
  readonly remoteAddress: string;
  readonly registeredAtBlock: bigint;
  readonly registeredAtBlockHash: string;
}

/**
 * Record a discovered remote as a candidate.
 *
 * There is no `approve` function in this module on purpose: promotion happens by
 * a human editing the manifest, which goes through review, not by a code path.
 */
export const recordRemoteCandidate = async (db: Db, row: RemoteCandidateRow): Promise<void> => {
  await db.sql`
    insert into remote_candidates
      (deployment_id, remote_blockchain_id, remote_address,
       registered_at_block, registered_at_block_hash)
    values
      (${row.deploymentId}, ${row.remoteBlockchainId}, ${row.remoteAddress},
       ${bigintToColumn(row.registeredAtBlock)}, ${row.registeredAtBlockHash})
    on conflict (deployment_id, remote_blockchain_id, remote_address) do nothing
  `;
};

// ------------------------------------------------------ completeness projection

export interface CompletenessRow {
  readonly deploymentId: string;
  readonly chainKey: string;
  readonly status: string;
  readonly verdict: string;
  readonly windowFrom: bigint;
  readonly windowTo: bigint;
  readonly gapCount: number;
  readonly reasons: readonly string[];
  readonly lastSuccessAt: Date | null;
  readonly evaluatedAt: Date;
}

export const upsertCompleteness = async (db: Db, row: CompletenessRow): Promise<void> => {
  await db.sql`
    insert into projection_replay_completeness
      (deployment_id, chain_key, status, verdict, window_from, window_to,
       gap_count, reasons, last_success_at, evaluated_at)
    values
      (${row.deploymentId}, ${row.chainKey}, ${row.status}, ${row.verdict},
       ${bigintToColumn(row.windowFrom)}, ${bigintToColumn(row.windowTo)},
       ${row.gapCount}, ${db.sql.array([...row.reasons])}, ${row.lastSuccessAt},
       ${row.evaluatedAt})
    on conflict (deployment_id, chain_key) do update
      set status = excluded.status,
          verdict = excluded.verdict,
          window_from = excluded.window_from,
          window_to = excluded.window_to,
          gap_count = excluded.gap_count,
          reasons = excluded.reasons,
          last_success_at = excluded.last_success_at,
          evaluated_at = excluded.evaluated_at
  `;
};

export const readCompleteness = async (
  db: Db,
  deploymentId: string,
  chainKey: string,
): Promise<{
  status: string;
  verdict: string;
  gapCount: number;
  reasons: string[];
  lastSuccessAt: Date | null;
  evaluatedAt: Date;
} | null> => {
  const rows = await db.sql<
    {
      status: string;
      verdict: string;
      gap_count: number;
      reasons: string[];
      last_success_at: Date | null;
      evaluated_at: Date;
    }[]
  >`
    select status, verdict, gap_count, reasons, last_success_at, evaluated_at
    from projection_replay_completeness
    where deployment_id = ${deploymentId} and chain_key = ${chainKey}
  `;
  const r = rows[0];
  return r
    ? {
        status: r.status,
        verdict: r.verdict,
        gapCount: r.gap_count,
        reasons: r.reasons,
        lastSuccessAt: r.last_success_at,
        evaluatedAt: r.evaluated_at,
      }
    : null;
};

/** Ranges already committed with quorum, used to resume and to find gaps. */
export const readCommittedRanges = async (
  db: Db,
  deploymentId: string,
  chainKey: string,
): Promise<readonly { fromBlock: bigint; toBlock: bigint }[]> => {
  const rows = await db.sql<{ from_block: string; to_block: string }[]>`
    select from_block::text, to_block::text from replay_ranges
    where deployment_id = ${deploymentId} and chain_key = ${chainKey} and status = 'complete'
    order by from_block
  `;
  return rows.map((r) => ({ fromBlock: BigInt(r.from_block), toBlock: BigInt(r.to_block) }));
};

export interface RangeStatusRow {
  readonly rangeId: string;
  readonly deploymentId: string;
  readonly chainKey: string;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly status: 'pending' | 'complete' | 'gap' | 'stale' | 'divergent' | 'blocked';
  readonly reasonCode: string | null;
  readonly providerGroup: string | null;
}

export const upsertRangeStatus = async (db: Db, row: RangeStatusRow): Promise<void> => {
  await db.sql`
    insert into replay_ranges
      (range_id, deployment_id, chain_key, from_block, to_block, status, reason_code, provider_group)
    values
      (${row.rangeId}, ${row.deploymentId}, ${row.chainKey}, ${bigintToColumn(row.fromBlock)},
       ${bigintToColumn(row.toBlock)}, ${row.status}, ${row.reasonCode}, ${row.providerGroup})
    on conflict (range_id) do update
      set status = excluded.status,
          reason_code = excluded.reason_code,
          provider_group = excluded.provider_group,
          updated_at = now()
  `;
};
