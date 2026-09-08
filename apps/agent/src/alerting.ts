import type { Verdict } from '@ictt-sentinel/domain';
import {
  decodeNotification,
  dedupKey,
  dispatch,
  incidentKey,
  isEscalation,
  observe,
  open,
  recover,
  sanitize,
  shouldNotify,
  type AlertIdentity,
  type AlertRecord,
  type AlertTarget,
  type NotifierTransport,
} from '@ictt-sentinel/alerts';
import {
  foldAlert,
  leaseDueAlerts,
  settleAlert,
  type AlertOutboxRow,
  type Db,
  type DeliveryRecord,
  type OutboxStatus,
} from '@ictt-sentinel/storage-postgres';

/**
 * Alerting glue.
 *
 * The rules live in `@ictt-sentinel/alerts` and the atomicity lives in
 * `@ictt-sentinel/storage-postgres`. This file only connects them, which is all
 * an application layer is allowed to do (.claude/rules/apps.md).
 *
 * The invariant worth restating because it is easy to break later: **nothing in
 * this file can change a verdict.** Delivery outcomes move an outbox row and a
 * metric. They never touch `evaluations`, `verdict_events` or an evidence bundle.
 */

export interface AlertSignal {
  readonly deploymentId: string;
  readonly evaluationId: string | null;
  readonly ruleId: string;
  readonly reasonCode: string;
  readonly previousVerdict: Verdict | 'NONE';
  readonly verdict: Verdict;
  readonly evidenceHash: string;
  readonly evidenceSchemaVersion: string;
  readonly reasonCodes: readonly string[];
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly fresh: boolean;
}

export interface RaiseResult {
  readonly dedupKey: string;
  readonly incidentKey: string;
  readonly written: boolean;
  readonly created: boolean;
  readonly notified: boolean;
  readonly closedIncidentRows: number;
}

const identityOf = (signal: AlertSignal): AlertIdentity => ({
  deploymentId: signal.deploymentId,
  ruleId: signal.ruleId,
  reasonCode: signal.reasonCode,
  from: signal.previousVerdict,
  to: signal.verdict,
  evidenceDigest: signal.evidenceHash,
});

/** Rebuild the pure record from a stored row, so the fold sees one shape. */
const toRecord = (row: AlertOutboxRow, identity: AlertIdentity): AlertRecord => ({
  dedupKey: row.dedupKey,
  identity,
  state: row.lifecycleState,
  firstSeenAt: row.firstSeenAt,
  lastSeenAt: row.lastSeenAt,
  occurrences: row.occurrences,
  currentVerdict: (row.verdictTo ?? identity.to) as Verdict,
  acknowledgedBy: row.acknowledgedBy,
  acknowledgedAt: row.acknowledgedAt,
  recoveredAt: row.recoveredAt,
});

/**
 * Fold one signal into the outbox.
 *
 * Three outcomes, decided inside a single locked transaction:
 *
 *   nothing        a repeat of evidence nobody needs to see again, or an OK for
 *                  a deployment that had no open incident. Writes nothing.
 *   escalation     opens or worsens an incident and queues a notification.
 *   recovery       closes every open row of the incident and queues one final
 *                  notification, so the person who was paged learns it ended.
 */
export const raiseAlert = async (
  db: Db,
  signal: AlertSignal,
  now: Date,
  outboxIdFor: (key: string) => string,
): Promise<RaiseResult> => {
  const identity = identityOf(signal);
  const keys = { dedupKey: dedupKey(identity), incidentKey: incidentKey(identity) };
  const decision = { notified: false };

  const result = await foldAlert(db, keys, ({ existing, openIncident }) => {
    const before: AlertRecord | null =
      existing !== null
        ? toRecord(existing, identity)
        : openIncident !== null
          ? toRecord(openIncident, identity)
          : null;

    const recovered = before === null ? null : recover(before, signal.verdict, now);
    const after: AlertRecord =
      recovered ??
      (before === null
        ? open({ identity, observedAt: now })
        : observe(before, { identity, observedAt: now }));

    // Nothing to record: no open incident and no worsening. Silence here is the
    // correct behaviour, and writing a row anyway would fill the outbox with
    // non-events that hide the real ones.
    if (before === null && !isEscalation(identity.from, identity.to)) {
      return { row: null, closeIncident: false };
    }

    const notify = shouldNotify(before, after);
    decision.notified = notify;

    const payload = sanitize({
      dedupKey: keys.dedupKey,
      deploymentId: signal.deploymentId,
      ruleId: signal.ruleId,
      state: after.state,
      severity: after.currentVerdict,
      occurrences: after.occurrences,
      reasonCodes: signal.reasonCodes,
      observedAt: signal.observedAt,
      expiresAt: signal.expiresAt,
      fresh: signal.fresh,
      evidenceHash: signal.evidenceHash,
      evidenceSchemaVersion: signal.evidenceSchemaVersion,
    });

    const row: AlertOutboxRow = {
      outboxId: existing?.outboxId ?? outboxIdFor(keys.dedupKey),
      deploymentId: signal.deploymentId,
      incidentKey: keys.incidentKey,
      evaluationId: signal.evaluationId,
      dedupKey: keys.dedupKey,
      payload,
      // An alert nobody should be paged about is stored, not queued: it stays in
      // the timeline without waking anyone at 3am.
      status: (notify ? 'pending' : (existing?.status ?? 'sent')) as OutboxStatus,
      attempts: existing?.attempts ?? 0,
      ruleId: signal.ruleId,
      reasonCode: signal.reasonCode,
      verdictFrom: identity.from,
      verdictTo: after.currentVerdict,
      evidenceDigest: signal.evidenceHash,
      lifecycleState: after.state,
      occurrences: after.occurrences,
      firstSeenAt: after.firstSeenAt,
      lastSeenAt: after.lastSeenAt,
      acknowledgedBy: after.acknowledgedBy,
      acknowledgedAt: after.acknowledgedAt,
      recoveredAt: after.recoveredAt,
      nextAttemptAt: now,
    };
    return { row, closeIncident: recovered !== null };
  });

  return {
    dedupKey: keys.dedupKey,
    incidentKey: keys.incidentKey,
    written: result.row !== null,
    created: result.created,
    notified: result.row !== null && decision.notified,
    closedIncidentRows: result.closed,
  };
};

export interface DrainOptions {
  readonly db: Db;
  readonly targets: readonly AlertTarget[];
  readonly resolve: (secretRef: string) => string | undefined;
  readonly transport: NotifierTransport;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly leaseMs: number;
  readonly backoffMs: number;
  readonly batchSize: number;
  readonly now: Date;
  readonly signal: AbortSignal;
  readonly deliveryIdFor: (outboxId: string, targetId: string, attempt: number) => string;
}

export interface DrainReport {
  readonly leased: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly abandoned: number;
  readonly undecodable: number;
}

/**
 * Deliver what is due.
 *
 * Every leased row is settled exactly once, including the failures. A row that
 * exhausted its budget becomes `abandoned` and stops being retried, but it is
 * never marked `sent`: an operator looking at the outbox can always tell "we
 * told you" from "we tried and could not".
 */
export const drainOutbox = async (options: DrainOptions): Promise<DrainReport> => {
  const rows = await leaseDueAlerts(options.db, options.now, options.batchSize, options.leaseMs);
  let delivered = 0;
  let retrying = 0;
  let abandoned = 0;
  let undecodable = 0;

  for (const row of rows) {
    if (options.signal.aborted) break;
    const payload = decodeNotification(row.payload);
    if (payload === null) {
      // A row this build cannot read is not silently dropped and not forwarded
      // half-formed. It is parked with a recorded reason.
      undecodable += 1;
      await settleAlert(
        options.db,
        row.outboxId,
        [
          {
            deliveryId: options.deliveryIdFor(row.outboxId, 'decoder', row.attempts),
            outboxId: row.outboxId,
            target: 'decoder',
            outcome: 'rejected',
            detail: { reason: 'stored payload does not match the notification schema' },
          },
        ],
        { status: 'abandoned', attempts: row.attempts, nextAttemptAt: options.now },
      );
      continue;
    }

    const outcome = await dispatch(payload.severity, options.targets, options.resolve, {
      payload,
      transport: options.transport,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    // A skipped target produced no attempt, so it produces no delivery record.
    const deliveries: DeliveryRecord[] = outcome.reports.flatMap((r) =>
      r.outcome === 'skipped'
        ? []
        : [
            {
              deliveryId: options.deliveryIdFor(row.outboxId, r.targetId, row.attempts),
              outboxId: row.outboxId,
              target: r.targetId,
              outcome: r.outcome,
              detail: { reason: r.reason, httpStatus: r.httpStatus, attempt: row.attempts },
            },
          ],
    );

    const anyDelivered = outcome.reports.some((r) => r.outcome === 'delivered');
    // No target configured at all is not a delivery. It is an operator having
    // set up a watcher that cannot shout, and it is recorded as such.
    const allSkipped = outcome.reports.every((r) => r.outcome === 'skipped');
    const budgetLeft = row.attempts < options.maxAttempts;
    const status: OutboxStatus =
      anyDelivered || (allSkipped && outcome.reports.length > 0)
        ? 'sent'
        : budgetLeft
          ? 'pending'
          : 'abandoned';

    if (anyDelivered) delivered += 1;
    else if (status === 'pending') retrying += 1;
    else if (status === 'abandoned') abandoned += 1;

    await settleAlert(options.db, row.outboxId, deliveries, {
      status,
      attempts: row.attempts,
      nextAttemptAt: new Date(
        options.now.getTime() + options.backoffMs * 2 ** Math.min(row.attempts, 10),
      ),
    });
  }

  return { leased: rows.length, delivered, retrying, abandoned, undecodable };
};
