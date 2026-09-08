import type { EvidenceRecord, ProtocolStatus } from '../api/contract.js';

/**
 * Incidents, derived from the verdict timeline.
 *
 * The hosted API publishes a verdict timeline and an acknowledgement endpoint,
 * but no alert-listing endpoint. Rather than quietly adding one to make a screen
 * easier - the backend contract is not the console's to widen - the incident
 * view is derived from what the API already publishes.
 *
 * That derivation is honest and complete for what it shows: a run of
 * consecutive non-OK evaluations IS one incident, its oldest record IS the first
 * sighting, repeated records ARE the deduplication, and an OK that follows IS
 * the recovery. What it cannot show is the outbox's own lifecycle - the
 * acknowledgement state and the dedup key - and the page says so instead of
 * pretending. See `docs/milestones/13.md` OPEN_RISKS.
 */

export interface Incident {
  /** Stable within this view: the digest of the oldest record in the run. */
  readonly id: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  /** Evaluations folded into this incident. This is the deduplication count. */
  readonly occurrences: number;
  /** Worst protocol status reached while the incident was open. */
  readonly peak: Exclude<ProtocolStatus, 'OK'>;
  readonly current: ProtocolStatus;
  readonly recovered: boolean;
  readonly recoveredAt: string | null;
  /** Every evidence digest in the run, newest first, for drill-down. */
  readonly evidenceDigests: readonly string[];
}

const SEVERITY: Readonly<Record<ProtocolStatus, number>> = {
  OK: 0,
  WARN: 1,
  UNKNOWN: 2,
  CRITICAL: 3,
};

const worse = (a: ProtocolStatus, b: ProtocolStatus): ProtocolStatus =>
  SEVERITY[a] >= SEVERITY[b] ? a : b;

/**
 * Fold a newest-first timeline into incidents.
 *
 * Walks oldest-first so "first seen" means what it says. A run ends at the first
 * OK, and that OK is the recovery timestamp: the incident closed when the
 * deployment reconciled again, not when someone noticed.
 */
export const deriveIncidents = (timeline: readonly EvidenceRecord[]): readonly Incident[] => {
  const oldestFirst = [...timeline].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const incidents: Incident[] = [];
  let open: {
    id: string;
    firstSeen: string;
    lastSeen: string;
    occurrences: number;
    peak: ProtocolStatus;
    current: ProtocolStatus;
    digests: string[];
  } | null = null;

  const close = (recoveredAt: string | null): void => {
    if (open === null) return;
    incidents.push({
      id: open.id,
      firstSeen: open.firstSeen,
      lastSeen: open.lastSeen,
      occurrences: open.occurrences,
      // `open.peak` is non-OK by construction: a run only starts on a non-OK
      // record and `worse` never lowers it.
      peak: open.peak as Exclude<ProtocolStatus, 'OK'>,
      current: recoveredAt === null ? open.current : 'OK',
      recovered: recoveredAt !== null,
      recoveredAt,
      evidenceDigests: [...open.digests].reverse(),
    });
    open = null;
  };

  for (const record of oldestFirst) {
    if (record.protocolStatus === 'OK') {
      close(record.observedAt);
      continue;
    }
    if (open === null) {
      open = {
        id: record.evidenceDigest,
        firstSeen: record.observedAt,
        lastSeen: record.observedAt,
        occurrences: 1,
        peak: record.protocolStatus,
        current: record.protocolStatus,
        digests: [record.evidenceDigest],
      };
      continue;
    }
    open.lastSeen = record.observedAt;
    open.occurrences += 1;
    open.peak = worse(open.peak, record.protocolStatus);
    open.current = record.protocolStatus;
    open.digests.push(record.evidenceDigest);
  }
  close(null);

  // Newest first, which is the order an on-call engineer reads.
  return incidents.reverse();
};

/**
 * Why there is no acknowledge button here.
 *
 * Acknowledging needs the incident key the alerting layer computed from the
 * deployment, rule and reason. The verdict timeline does not carry the rule or
 * the reason, so the console cannot address the right incident - and a button
 * that acknowledges the wrong one is worse than no button.
 */
export const ACKNOWLEDGEMENT_IS_NOT_IN_THIS_VIEW =
  'Acknowledging mutes paging for one incident. It changes no verdict and performs no chain action. This view is derived from the verdict timeline and does not carry the incident key, so acknowledge from the alerting side.' as const;

export const RUNBOOK_HINT =
  'Start from the evidence bundle for the first sighting, not from this summary. Reason codes and their runbook entries live in docs/RUNBOOK.md.' as const;
