import { createHash } from 'node:crypto';
import { combineVerdicts, type Verdict } from '@ictt-sentinel/domain';
import {
  runReplay,
  type LogSourcePort,
  type PriorityHint,
  type ReplayConfig,
  type ReplayReport,
} from '@ictt-sentinel/replay';
import {
  markHintsConsumed,
  readPendingHints,
  type Db,
} from '@ictt-sentinel/storage-postgres';
import { raiseAlert, type AlertSignal } from './alerting.js';
import { applyFreshness, type FreshnessPolicy } from './freshness.js';
import { AGENT_METRICS, type MetricsRegistry } from './metrics.js';

/**
 * One deployment's watch tick.
 *
 * The order is deliberate:
 *
 *   1. hints reorder work, and nothing else. They cannot add a range, remove
 *      one, or advance a checkpoint (docs/adr/0002-accepted-quorum-truth.md).
 *   2. replay each chain. Facts and their checkpoint move in one transaction,
 *      so a crash anywhere in this tick resumes rather than skips.
 *   3. combine the per-chain verdicts under the lattice.
 *   4. apply freshness LAST, so an evaluation that stopped being produced
 *      degrades instead of holding a stale green.
 *   5. alert on the transition.
 *
 * Steps 3-5 cannot make step 2 look better than it was: `combineVerdicts` and
 * `applyFreshness` only ever move a verdict up the lattice, never down.
 */

export interface ChainPlan {
  readonly chainKey: string;
  readonly config: ReplayConfig;
}

export interface DeploymentPlan {
  readonly deploymentId: string;
  readonly chains: readonly ChainPlan[];
  readonly maxHints: number;
  readonly freshness: FreshnessPolicy;
}

export interface TickReport {
  readonly deploymentId: string;
  readonly verdict: Verdict;
  readonly rawVerdict: Verdict;
  readonly stale: boolean;
  readonly reportable: boolean;
  readonly reasonCodes: readonly string[];
  readonly chains: readonly { readonly chainKey: string; readonly report: ReplayReport }[];
  readonly observationDigest: string;
  readonly alerted: boolean;
}

/**
 * Digest of what this tick observed.
 *
 * Content-addressed over the committed checkpoints, per-chain statuses and
 * reasons - never over the clock. Two ticks that observed the same thing produce
 * the same digest, which is what stops a re-evaluation from paging again, and a
 * tick that observed something new produces a different one, which is what makes
 * sure a genuine change does page.
 */
export const observationDigest = (
  deploymentId: string,
  chains: readonly { readonly chainKey: string; readonly report: ReplayReport }[],
): string => {
  const parts = [...chains]
    .sort((a, b) => a.chainKey.localeCompare(b.chainKey))
    .map(
      ({ chainKey, report }) =>
        `${chainKey}:${report.checkpointAfter?.toString(10) ?? 'none'}:${report.status}:${[...report.reasons].sort().join(',')}`,
    );
  return createHash('sha256')
    .update('ictt-sentinel/observation/v1')
    .update('\n')
    .update([deploymentId, ...parts].join('|'))
    .digest('hex');
};

export interface TickDeps {
  readonly db: Db;
  readonly source: LogSourcePort;
  readonly registry: MetricsRegistry;
  readonly now: () => Date;
  /** Last verdict per deployment, so a transition can be recognised. */
  readonly previousVerdict: Map<string, Verdict>;
  /**
   * When each deployment last produced a COMPLETE observation.
   *
   * This, not the tick clock, is what freshness is measured against: a tick that
   * ran and established nothing must not refresh the timestamp, or an agent
   * failing every minute would look permanently up to date.
   */
  readonly lastSuccessAt: Map<string, number>;
  readonly outboxIdFor: (dedupKey: string) => string;
  readonly evidenceSchemaVersion: string;
  readonly signal: AbortSignal;
}

const hintsFor = async (
  deps: TickDeps,
  plan: DeploymentPlan,
  chain: ChainPlan,
): Promise<{ hints: readonly PriorityHint[]; dedupKeys: readonly string[] }> => {
  const pending = await readPendingHints(deps.db, plan.deploymentId, chain.chainKey, plan.maxHints);
  deps.registry.set(AGENT_METRICS.hintQueueDepth, pending.length, {
    deployment: plan.deploymentId,
  });
  // Only `suggestedBlockNumber` is load-bearing: the engine uses it to order
  // ranges it had already planned. Everything else is provenance.
  const hints: readonly PriorityHint[] = pending.map((h) => ({
    hintId: h.hintId,
    deploymentId: plan.deploymentId,
    chainKey: chain.chainKey,
    suggestedBlockNumber: h.suggestedBlockNumber,
    source: h.source,
    dedupKey: h.dedupKey,
    receivedAt: h.receivedAt,
  }));
  return { hints, dedupKeys: pending.map((h) => h.dedupKey) };
};

export const runDeploymentTick = async (
  deps: TickDeps,
  plan: DeploymentPlan,
): Promise<TickReport> => {
  const now = deps.now();
  const chains: { chainKey: string; report: ReplayReport }[] = [];

  for (const chain of plan.chains) {
    deps.signal.throwIfAborted();
    const { hints, dedupKeys } = await hintsFor(deps, plan, chain);
    const report = await runReplay(deps.db, deps.source, chain.config, hints, now);
    chains.push({ chainKey: chain.chainKey, report });
    // Hints are consumed whatever the outcome. A hint that was considered has
    // done its only job; leaving it queued would replay the same reordering.
    if (dedupKeys.length > 0) await markHintsConsumed(deps.db, dedupKeys);
  }

  const rawVerdict = combineVerdicts(
    chains.map(({ report }) => ({ verdict: report.verdict, requirement: 'required' as const })),
  );
  const reasons = [...new Set(chains.flatMap(({ report }) => report.reasons))].sort();

  // A tick counts as a success only when every chain came back complete.
  // Anything less leaves the previous success timestamp where it was, so the
  // evaluation ages and eventually degrades.
  const complete = chains.length > 0 && chains.every(({ report }) => report.status === 'complete');
  if (complete) deps.lastSuccessAt.set(plan.deploymentId, now.getTime());
  const observedAtMs = deps.lastSuccessAt.get(plan.deploymentId) ?? 0;

  const fresh = applyFreshness(rawVerdict, observedAtMs, now.getTime(), plan.freshness);
  const digest = observationDigest(plan.deploymentId, chains);

  deps.registry.set(AGENT_METRICS.evaluationAge, fresh.ageSeconds, {
    deployment: plan.deploymentId,
  });
  if (fresh.stale) {
    deps.registry.increment(AGENT_METRICS.staleEvaluations, { deployment: plan.deploymentId });
  }

  for (const { report } of chains) {
    if (report.verdict === 'UNKNOWN') {
      deps.registry.increment(AGENT_METRICS.unknownRules, { deployment: plan.deploymentId });
    }
  }

  const previous = deps.previousVerdict.get(plan.deploymentId) ?? null;
  const signal: AlertSignal = {
    deploymentId: plan.deploymentId,
    evaluationId: null,
    ruleId: 'replay-completeness',
    reasonCode: reasons[0] ?? `REPLAY_${fresh.verdict}`,
    previousVerdict: previous ?? 'NONE',
    verdict: fresh.verdict,
    evidenceHash: digest,
    evidenceSchemaVersion: deps.evidenceSchemaVersion,
    reasonCodes: [...reasons, ...fresh.reasonCodes],
    observedAt: new Date(observedAtMs).toISOString(),
    expiresAt: new Date(now.getTime() + plan.freshness.expiresAfterSeconds * 1000).toISOString(),
    fresh: !fresh.stale,
  };
  const raised = await raiseAlert(deps.db, signal, now, deps.outboxIdFor);
  deps.previousVerdict.set(plan.deploymentId, fresh.verdict);

  return {
    deploymentId: plan.deploymentId,
    verdict: fresh.verdict,
    rawVerdict,
    stale: fresh.stale,
    reportable: fresh.reportable,
    reasonCodes: signal.reasonCodes,
    chains,
    observationDigest: digest,
    alerted: raised.notified,
  };
};
