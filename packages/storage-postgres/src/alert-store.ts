import type { Db, Tx } from './client.js';

/**
 * The alert outbox.
 *
 * An alert is a row keyed by its dedup key, not a message on a queue. That is
 * what makes the whole thing restart-safe: a process that dies between deciding
 * to alert and delivering it leaves a durable pending row, and a process that
 * re-evaluates the same evidence folds into the same row instead of paging
 * someone twice.
 *
 * The lifecycle RULE lives in `@ictt-sentinel/alerts` and is not duplicated
 * here. This module supplies atomicity - a locked read-modify-write - and calls
 * back into the caller's pure fold for the decision (.claude/rules/apps.md).
 */

export type AlertLifecycleState =
  | 'first_seen'
  | 'repeated'
  | 'escalated'
  | 'acknowledged'
  | 'recovered';

export type OutboxStatus = 'pending' | 'sent' | 'failed' | 'abandoned';

export interface AlertOutboxRow {
  readonly outboxId: string;
  readonly deploymentId: string;
  /** Groups the notification events of one incident. */
  readonly incidentKey: string;
  readonly evaluationId: string | null;
  readonly dedupKey: string;
  readonly payload: unknown;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly ruleId: string | null;
  readonly reasonCode: string | null;
  readonly verdictFrom: string | null;
  readonly verdictTo: string | null;
  readonly evidenceDigest: string | null;
  readonly lifecycleState: AlertLifecycleState;
  readonly occurrences: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: Date | null;
  readonly recoveredAt: Date | null;
  readonly nextAttemptAt: Date;
}

interface OutboxColumns {
  outbox_id: string;
  deployment_id: string;
  incident_key: string;
  evaluation_id: string | null;
  dedup_key: string;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  rule_id: string | null;
  reason_code: string | null;
  verdict_from: string | null;
  verdict_to: string | null;
  evidence_digest: string | null;
  lifecycle_state: AlertLifecycleState;
  occurrences: number;
  first_seen_at: Date;
  last_seen_at: Date;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  recovered_at: Date | null;
  next_attempt_at: Date;
}

const toRow = (c: OutboxColumns): AlertOutboxRow => ({
  outboxId: c.outbox_id,
  deploymentId: c.deployment_id,
  incidentKey: c.incident_key,
  evaluationId: c.evaluation_id,
  dedupKey: c.dedup_key,
  payload: c.payload,
  status: c.status,
  attempts: c.attempts,
  ruleId: c.rule_id,
  reasonCode: c.reason_code,
  verdictFrom: c.verdict_from,
  verdictTo: c.verdict_to,
  evidenceDigest: c.evidence_digest,
  lifecycleState: c.lifecycle_state,
  occurrences: c.occurrences,
  firstSeenAt: c.first_seen_at,
  lastSeenAt: c.last_seen_at,
  acknowledgedBy: c.acknowledged_by,
  acknowledgedAt: c.acknowledged_at,
  recoveredAt: c.recovered_at,
  nextAttemptAt: c.next_attempt_at,
});

export interface IncidentContext {
  /** The exact notification row for this dedup key, if one exists. */
  readonly existing: AlertOutboxRow | null;
  /** The newest still-open row of the same incident, if any. */
  readonly openIncident: AlertOutboxRow | null;
}

export interface FoldDecision {
  /** `null` means: this observation changes nothing, write nothing. */
  readonly row: AlertOutboxRow | null;
  /** Close every open row of the incident. Used by a genuine recovery. */
  readonly closeIncident: boolean;
}

export interface FoldResult {
  readonly row: AlertOutboxRow | null;
  readonly created: boolean;
  readonly closed: number;
}

/**
 * Apply a pure fold to one incident under a row lock.
 *
 * `SELECT ... FOR UPDATE` inside the transaction is what makes two agents
 * observing the same breach at the same instant produce one incident rather
 * than an insert race.
 *
 * The fold is handed both keys because they answer different questions. The
 * dedup key says "have we already paged exactly this"; the incident key says
 * "is there an open incident this belongs to". Collapsing them would either page
 * on every re-evaluation or never page again after the first one.
 */
export const foldAlert = async (
  db: Db,
  keys: { readonly incidentKey: string; readonly dedupKey: string },
  fold: (context: IncidentContext) => FoldDecision,
): Promise<FoldResult> =>
  db.sql.begin(async (tx: Tx) => {
    // Ordered lock acquisition: the incident group first, then the specific row,
    // so two concurrent folds on the same incident cannot deadlock each other.
    const incidentRows = await tx<OutboxColumns[]>`
      select outbox_id, deployment_id, incident_key, evaluation_id, dedup_key, payload, status, attempts,
             rule_id, reason_code, verdict_from, verdict_to, evidence_digest,
             lifecycle_state, occurrences, first_seen_at, last_seen_at,
             acknowledged_by, acknowledged_at, recovered_at, next_attempt_at
      from alert_outbox
      where incident_key = ${keys.incidentKey} and lifecycle_state <> 'recovered'
      order by last_seen_at desc
      for update
    `;
    const openIncident = incidentRows[0] === undefined ? null : toRow(incidentRows[0]);
    const existing =
      incidentRows.map(toRow).find((r) => r.dedupKey === keys.dedupKey) ??
      (await readByDedupKey(tx, keys.dedupKey));

    const decision = fold({ existing, openIncident });
    let closed = 0;

    if (decision.closeIncident && incidentRows.length > 0) {
      const closedRows = await tx`
        update alert_outbox
        set lifecycle_state = 'recovered', recovered_at = coalesce(recovered_at, now())
        where incident_key = ${keys.incidentKey} and lifecycle_state <> 'recovered'
        returning outbox_id
      `;
      closed = closedRows.length;
    }

    const next = decision.row;
    if (next === null) return { row: null, created: false, closed };

    if (existing === null) {
      await tx`
        insert into alert_outbox
          (outbox_id, deployment_id, incident_key, evaluation_id, dedup_key, payload, status, attempts,
           rule_id, reason_code, verdict_from, verdict_to, evidence_digest,
           lifecycle_state, occurrences, first_seen_at, last_seen_at,
           acknowledged_by, acknowledged_at, recovered_at, next_attempt_at)
        values
          (${next.outboxId}, ${next.deploymentId}, ${next.incidentKey}, ${next.evaluationId},
           ${next.dedupKey}, ${tx.json(next.payload as never)}, ${next.status}, ${next.attempts},
           ${next.ruleId}, ${next.reasonCode}, ${next.verdictFrom}, ${next.verdictTo},
           ${next.evidenceDigest}, ${next.lifecycleState}, ${next.occurrences},
           ${next.firstSeenAt}, ${next.lastSeenAt}, ${next.acknowledgedBy},
           ${next.acknowledgedAt}, ${next.recoveredAt}, ${next.nextAttemptAt})
      `;
      return { row: next, created: true, closed };
    }

    await tx`
      update alert_outbox set
        payload         = ${tx.json(next.payload as never)},
        status          = ${next.status},
        attempts        = ${next.attempts},
        rule_id         = ${next.ruleId},
        reason_code     = ${next.reasonCode},
        verdict_from    = ${next.verdictFrom},
        verdict_to      = ${next.verdictTo},
        evidence_digest = ${next.evidenceDigest},
        lifecycle_state = ${next.lifecycleState},
        occurrences     = ${next.occurrences},
        last_seen_at    = ${next.lastSeenAt},
        acknowledged_by = ${next.acknowledgedBy},
        acknowledged_at = ${next.acknowledgedAt},
        recovered_at    = ${next.recoveredAt},
        next_attempt_at = ${next.nextAttemptAt}
      where dedup_key = ${next.dedupKey}
    `;
    return { row: next, created: false, closed };
  }) as Promise<FoldResult>;

const readByDedupKey = async (tx: Tx, dedupKey: string): Promise<AlertOutboxRow | null> => {
  const rows = await tx<OutboxColumns[]>`
    select outbox_id, deployment_id, incident_key, evaluation_id, dedup_key, payload, status, attempts,
           rule_id, reason_code, verdict_from, verdict_to, evidence_digest,
           lifecycle_state, occurrences, first_seen_at, last_seen_at,
           acknowledged_by, acknowledged_at, recovered_at, next_attempt_at
    from alert_outbox
    where dedup_key = ${dedupKey}
    for update
  `;
  return rows[0] === undefined ? null : toRow(rows[0]);
};

/**
 * Lease pending alerts that are due.
 *
 * One transaction takes the rows and immediately pushes `next_attempt_at` past
 * the lease window, so a drainer that crashes mid-delivery does not strand them:
 * the lease simply expires and another tick picks them up. `SKIP LOCKED` lets a
 * second drainer take different rows instead of blocking, and `limit` keeps one
 * tick from pulling an entire backlog into memory.
 *
 * The attempt counter is incremented at LEASE time, not at success time. A
 * delivery that hangs forever must still consume its budget, or a wedged target
 * would be retried until the end of the world.
 */
export const leaseDueAlerts = async (
  db: Db,
  now: Date,
  limit: number,
  leaseMs: number,
): Promise<readonly AlertOutboxRow[]> =>
  db.sql.begin(async (tx: Tx) => {
    const rows = await tx<OutboxColumns[]>`
      select outbox_id, deployment_id, incident_key, evaluation_id, dedup_key, payload, status, attempts,
             rule_id, reason_code, verdict_from, verdict_to, evidence_digest,
             lifecycle_state, occurrences, first_seen_at, last_seen_at,
             acknowledged_by, acknowledged_at, recovered_at, next_attempt_at
      from alert_outbox
      where status = 'pending' and next_attempt_at <= ${now}
      order by next_attempt_at, created_at
      limit ${limit}
      for update skip locked
    `;
    if (rows.length === 0) return [];
    const leased = rows.map(toRow).map((r) => ({ ...r, attempts: r.attempts + 1 }));
    const until = new Date(now.getTime() + leaseMs);
    await tx`
      update alert_outbox
      set attempts = attempts + 1, next_attempt_at = ${until}
      where outbox_id in ${tx(leased.map((r) => r.outboxId))}
    `;
    return leased;
  }) as Promise<readonly AlertOutboxRow[]>;

export interface DeliveryRecord {
  readonly deliveryId: string;
  readonly outboxId: string;
  readonly target: string;
  readonly outcome: 'delivered' | 'rejected' | 'error';
  readonly detail: unknown;
}

/**
 * Record delivery attempts and move the outbox row.
 *
 * `abandoned` exists so a permanently rejecting target stops being retried
 * forever. It is not a success: the alert stays visible with its attempt history
 * and never reads as delivered.
 */
export const settleAlert = async (
  db: Db,
  outboxId: string,
  deliveries: readonly DeliveryRecord[],
  next: { readonly status: OutboxStatus; readonly attempts: number; readonly nextAttemptAt: Date },
): Promise<void> => {
  await db.sql.begin(async (tx: Tx) => {
    for (const d of deliveries) {
      await tx`
        insert into alert_deliveries (delivery_id, outbox_id, target, outcome, detail)
        values (${d.deliveryId}, ${d.outboxId}, ${d.target}, ${d.outcome},
                ${tx.json(d.detail as never)})
        on conflict (delivery_id) do nothing
      `;
    }
    await tx`
      update alert_outbox
      set status = ${next.status}, attempts = ${next.attempts},
          next_attempt_at = ${next.nextAttemptAt}
      where outbox_id = ${outboxId}
    `;
  });
};

/**
 * Acknowledge an alert.
 *
 * Mutes paging and nothing else. It does not change the verdict, does not clear
 * the breach and does not touch a chain; a recovered alert is left alone so a
 * late acknowledgement cannot reopen a closed incident.
 */
export const acknowledgeAlert = async (
  db: Db,
  incidentKey: string,
  by: string,
  at: Date,
): Promise<number> => {
  const rows = await db.sql`
    update alert_outbox
    set lifecycle_state = 'acknowledged', acknowledged_by = ${by}, acknowledged_at = ${at}
    where incident_key = ${incidentKey} and lifecycle_state <> 'recovered'
    returning outbox_id
  `;
  return rows.length;
};

export const readAlerts = async (
  db: Db,
  deploymentId: string,
  limit: number,
): Promise<readonly AlertOutboxRow[]> => {
  const rows = await db.sql<OutboxColumns[]>`
    select outbox_id, deployment_id, incident_key, evaluation_id, dedup_key, payload, status, attempts,
           rule_id, reason_code, verdict_from, verdict_to, evidence_digest,
           lifecycle_state, occurrences, first_seen_at, last_seen_at,
           acknowledged_by, acknowledged_at, recovered_at, next_attempt_at
    from alert_outbox
    where deployment_id = ${deploymentId}
    order by last_seen_at desc
    limit ${limit}
  `;
  return rows.map(toRow);
};
