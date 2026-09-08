import type { Verdict } from '@ictt-sentinel/domain';

/**
 * Health, split in two because the two questions have different answers.
 *
 *   LIVENESS   is this process functioning? A failed liveness check means
 *              restart me. It deliberately touches nothing external: a database
 *              outage that fails liveness would restart-loop the agent and
 *              destroy the very state that survives an outage.
 *
 *   READINESS  is the TRUTH PATH working? Database reachable, schema current,
 *              and a recent successful evaluation for every watched deployment.
 *              A failed readiness check means: do not believe what this agent is
 *              currently reporting.
 *
 * The hosted plane is deliberately NOT part of readiness. The local agent is the
 * truth authority; hosted is an optional mirror, and an agent that declared
 * itself unhealthy because a SaaS endpoint was unreachable would be reporting
 * the wrong outage (docs/ARCHITECTURE.md 2).
 *
 * `UNKNOWN` never counts as ready. That is the whole point of the lattice.
 */

export interface DeploymentHealth {
  readonly deploymentId: string;
  readonly lastSuccessAtMs: number | null;
  readonly lastVerdict: Verdict | null;
  readonly consecutiveFailures: number;
}

export interface AgentState {
  readonly startedAtMs: number;
  readonly databaseReachable: boolean;
  readonly schemaCurrent: boolean;
  readonly deployments: readonly DeploymentHealth[];
  /** Delivery trouble. Operational only: it never blocks readiness. */
  readonly alertingDegraded: boolean;
  /** Hosted ingest trouble. Also operational only. */
  readonly hostedIngestDegraded: boolean;
}

export interface HealthReport {
  readonly live: boolean;
  readonly ready: boolean;
  /** Machine codes, ordered, no free text. Safe to log and to expose. */
  readonly reasons: readonly string[];
  readonly uptimeSeconds: number;
  readonly degraded: readonly string[];
}

export const HEALTH_REASONS = {
  databaseUnreachable: 'DATABASE_UNREACHABLE',
  schemaOutdated: 'SCHEMA_OUTDATED',
  noDeployments: 'NO_DEPLOYMENTS_CONFIGURED',
  neverEvaluated: 'DEPLOYMENT_NEVER_EVALUATED',
  evaluationStale: 'DEPLOYMENT_EVALUATION_STALE',
  verdictUnknown: 'DEPLOYMENT_VERDICT_UNKNOWN',
} as const;

export interface ReadinessPolicy {
  /** How old the newest successful evaluation may be before readiness drops. */
  readonly maxEvaluationAgeSeconds: number;
}

/**
 * Derive both answers from state.
 *
 * Pure, so the container's health probes and the API's readiness endpoint agree
 * by construction rather than by two implementations happening to match.
 */
export const evaluateHealth = (
  state: AgentState,
  nowMs: number,
  policy: ReadinessPolicy,
): HealthReport => {
  const reasons: string[] = [];

  if (!state.databaseReachable) reasons.push(HEALTH_REASONS.databaseUnreachable);
  if (!state.schemaCurrent) reasons.push(HEALTH_REASONS.schemaOutdated);
  // Zero deployments is not ready. An agent watching nothing must not report a
  // green readiness probe that an operator reads as "everything is fine".
  if (state.deployments.length === 0) reasons.push(HEALTH_REASONS.noDeployments);

  for (const d of state.deployments) {
    if (d.lastSuccessAtMs === null) {
      reasons.push(`${HEALTH_REASONS.neverEvaluated}:${d.deploymentId}`);
      continue;
    }
    const ageSeconds = Math.floor((nowMs - d.lastSuccessAtMs) / 1000);
    if (ageSeconds > policy.maxEvaluationAgeSeconds || ageSeconds < 0) {
      reasons.push(`${HEALTH_REASONS.evaluationStale}:${d.deploymentId}`);
    }
    if (d.lastVerdict === 'UNKNOWN') {
      // Not an error, and not ready either. The agent is working; the answer is
      // simply not established, and readiness must not paint that green.
      reasons.push(`${HEALTH_REASONS.verdictUnknown}:${d.deploymentId}`);
    }
  }

  const degraded: string[] = [];
  if (state.alertingDegraded) degraded.push('ALERT_DELIVERY_DEGRADED');
  if (state.hostedIngestDegraded) degraded.push('HOSTED_INGEST_DEGRADED');

  return {
    live: true,
    ready: reasons.length === 0,
    reasons,
    uptimeSeconds: Math.max(0, Math.floor((nowMs - state.startedAtMs) / 1000)),
    degraded,
  };
};
