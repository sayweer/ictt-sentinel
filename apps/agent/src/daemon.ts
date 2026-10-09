import { createHash } from 'node:crypto';
import type { EnvSource, Manifest, Policy } from '@ictt-sentinel/config';
import { combineVerdicts, type Verdict } from '@ictt-sentinel/domain';
import { httpTransport, type NotifierTransport } from '@ictt-sentinel/alerts';
import {
  SOURCE_LOCK_DOCUMENT_DIGEST,
  collectConfigured,
  type ChainReader,
} from '@ictt-sentinel/collector';
import type { EvidenceBundle, ProducerIdentity } from '@ictt-sentinel/evidence';
import {
  appendVerdictEvent,
  putEvaluation,
  readCheckpoint,
  readCompleteness,
  type Db,
} from '@ictt-sentinel/storage-postgres';
import type { LogSourcePort } from '@ictt-sentinel/replay';
import { drainOutbox, raiseAlert } from './alerting.js';
import type { AgentConfig } from './config.js';
import { type AgentState, type DeploymentHealth } from './health.js';
import { ingest, type IngestReport } from './ingest.js';
import { AGENT_METRICS, createAgentRegistry, type MetricsRegistry } from './metrics.js';
import { buildWatchPlan, type WatchPlan } from './plan.js';
import { runDeploymentTick, type EvaluationObservation, type TickReport } from './runtime.js';

const VERDICTS = ['OK', 'WARN', 'UNKNOWN', 'CRITICAL'] as const;

/** Economic evaluations are their own subject and their own alert rule. */
export const ECONOMIC_SUBJECT = 'canonical-erc20-economic';
export const ECONOMIC_RULE_ID = 'ACC-ERC20-CANONICAL';
/** Upper bound on logs read per chain per economic run (the CLI's maximum). */
export const ECONOMIC_MAX_LOGS = 10_000;

export interface EconomicReport {
  readonly verdict: Verdict;
  readonly reasonCodes: readonly string[];
  readonly evaluationId: string | null;
  readonly contentHash: string | null;
}

/**
 * Notification-safe reason codes: outbound payloads keep only
 * `[A-Z][A-Z0-9_]*`. Engine codes lose their dashes; a collector reason keeps
 * only its category (`remote:alpha:witness-divergence` becomes
 * `COLLECT_WITNESS_DIVERGENCE`, `unverifiable:<finding>` becomes
 * `COLLECT_UNVERIFIABLE`), so free text never reaches a notification.
 */
const alertCode = (reason: string, prefix = ''): string => {
  const category = reason.startsWith('unverifiable:') ? 'unverifiable' : reason.replace(/^.*:/, '');
  return `${prefix}${category.replace(/[^A-Za-z0-9]+/g, '_')}`
    .toUpperCase()
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
};
const isVerdict = (value: string): value is Verdict =>
  (VERDICTS as readonly string[]).includes(value);
const digest = (domain: string, value: string): string =>
  createHash('sha256').update(domain).update('\n').update(value).digest('hex');

export interface AgentServiceOptions {
  readonly config: AgentConfig;
  readonly manifest: Manifest;
  readonly policy: Policy;
  readonly db: Db;
  readonly env: EnvSource;
  readonly sourceFor: (signal: AbortSignal, plan: WatchPlan) => LogSourcePort;
  /** Loader digests of the reviewed manifest and policy, bound into economic evidence. */
  readonly manifestDigest: string;
  readonly policyDigest: string;
  /**
   * Query-only reads for the economic collector. Absent means the agent runs
   * replay only; the economic verdict is then simply not produced.
   */
  readonly economic?: {
    readonly reader: ChainReader;
    readonly producer: Omit<ProducerIdentity, 'schemaVersion'>;
  };
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly transport?: NotifierTransport;
}

export interface AgentService {
  readonly plan: WatchPlan;
  readonly registry: MetricsRegistry;
  state(): AgentState;
  hydrate(): Promise<void>;
  evaluate(signal: AbortSignal): Promise<TickReport>;
  drain(signal: AbortSignal): Promise<void>;
  mirror(bundle: EvidenceBundle, signal: AbortSignal): Promise<IngestReport>;
  /** Run the economic collector if its interval has elapsed; null when not due. */
  collectEconomic(signal: AbortSignal): Promise<EconomicReport | null>;
  recordOutcome(result: string): void;
}

const schemaReady = async (db: Db): Promise<boolean> => {
  try {
    const rows = await db.sql`
      select to_regclass('projection_replay_completeness') is not null
        and to_regclass('alert_outbox') is not null
        and (select max(version) from schema_migrations) = 8 as ready
    `;
    return rows[0]?.['ready'] === true;
  } catch {
    return false;
  }
};

export const createAgentService = (options: AgentServiceOptions): AgentService => {
  const plan = buildWatchPlan(options.manifest, options.policy);
  const registry = createAgentRegistry();
  const now = options.now ?? (() => new Date());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const previousVerdict = new Map<string, Verdict>();
  const lastSuccessAt = new Map<string, number>();
  let health: DeploymentHealth = {
    deploymentId: plan.deployment.deploymentId,
    lastSuccessAtMs: null,
    lastVerdict: null,
    consecutiveFailures: 0,
  };
  let databaseReachable = false;
  let currentSchema = false;
  let alertingDegraded = false;
  let hostedIngestDegraded = false;
  const startedAtMs = now().getTime();

  const snapshot = (): AgentState => ({
    startedAtMs,
    databaseReachable,
    schemaCurrent: currentSchema,
    deployments: [health],
    alertingDegraded,
    hostedIngestDegraded,
  });

  const hydrate = async (): Promise<void> => {
    currentSchema = await schemaReady(options.db);
    databaseReachable = currentSchema;
    if (!currentSchema) return;
    const rows = await Promise.all(
      plan.deployment.chains.map((chain) =>
        readCompleteness(options.db, plan.deployment.deploymentId, chain.chainKey),
      ),
    );
    const present = rows.filter((row) => row !== null);
    if (present.length !== plan.deployment.chains.length) return;
    const verdicts = present.map((row) => (isVerdict(row.verdict) ? row.verdict : 'UNKNOWN'));
    const verdict = combineVerdicts(verdicts.map((v) => ({ verdict: v, requirement: 'required' })));
    previousVerdict.set(plan.deployment.deploymentId, verdict);
    const successes = present.map((row) => row.lastSuccessAt?.getTime() ?? 0);
    const last = Math.min(...successes);
    if (last > 0) lastSuccessAt.set(plan.deployment.deploymentId, last);
    health = {
      ...health,
      lastSuccessAtMs: last > 0 ? last : null,
      lastVerdict: verdict,
    };
  };

  const recordEvaluation = async (observation: EvaluationObservation): Promise<string | null> => {
    const checkpoints = await Promise.all(
      plan.deployment.chains.map(async (chain) => ({
        chainKey: chain.chainKey,
        checkpoint: await readCheckpoint(options.db, observation.deploymentId, chain.chainKey),
      })),
    );
    const pinnedBlocks = checkpoints.flatMap(({ chainKey, checkpoint }) =>
      checkpoint === null
        ? []
        : [
            {
              chainKey,
              blockNumber: checkpoint.lastBlockNumber,
              blockHash: checkpoint.lastBlockHash,
            },
          ],
    );
    // The schema requires at least one full block identity. A first failed scan
    // has no evidence to pin, so it remains UNKNOWN in readiness and alerting
    // without inventing a number/hash pair.
    if (pinnedBlocks.length === 0) return null;
    const statusDigest = digest(
      'ictt-sentinel/agent-evaluation-status/v1',
      [
        observation.observationDigest,
        observation.verdict,
        observation.stale ? 'stale' : 'fresh',
        observation.reportable ? 'reportable' : 'expired',
      ].join('|'),
    );
    const inputObservationDigests = [
      statusDigest,
      ...observation.chains.flatMap(({ report }) =>
        report.ranges.flatMap((range) => (range.digest === null ? [] : [range.digest])),
      ),
    ];
    const stored = await putEvaluation(options.db, {
      deploymentId: observation.deploymentId,
      subject: 'replay-completeness',
      policyVersion: `${options.policy.apiVersion}/${options.policy.metadata.name}`,
      adapterVersion: 'accepted-log-replay/v1',
      pinnedBlocks,
      inputObservationDigests,
      verdict: observation.verdict,
      payloadDigest: statusDigest,
    });
    const reasonCode = observation.reasonCodes[0] ?? `REPLAY_${observation.verdict}`;
    await appendVerdictEvent(options.db, {
      eventId: digest(
        'ictt-sentinel/agent-verdict-event/v1',
        `${stored.evaluationId}|${observation.verdict}|${reasonCode}`,
      ),
      evaluationId: stored.evaluationId,
      verdict: observation.verdict,
      reasonCode,
      detail: {
        stale: observation.stale,
        reportable: observation.reportable,
        observationDigest: observation.observationDigest,
      },
    });
    return stored.evaluationId;
  };

  const evaluate = async (signal: AbortSignal): Promise<TickReport> => {
    const started = monotonicNow();
    try {
      const report = await runDeploymentTick(
        {
          db: options.db,
          source: options.sourceFor(signal, plan),
          registry,
          now,
          previousVerdict,
          lastSuccessAt,
          outboxIdFor: (key) => digest('ictt-sentinel/alert-outbox/v1', key),
          recordEvaluation,
          evidenceSchemaVersion: 'ictt-sentinel/evidence/v1',
          signal,
        },
        plan.deployment,
      );
      databaseReachable = true;
      currentSchema = true;
      health = {
        ...health,
        lastSuccessAtMs: lastSuccessAt.get(report.deploymentId) ?? health.lastSuccessAtMs,
        lastVerdict: report.verdict,
        consecutiveFailures: 0,
      };
      return report;
    } catch (error) {
      try {
        await options.db.sql`select 1`;
        databaseReachable = true;
      } catch {
        databaseReachable = false;
      }
      health = { ...health, consecutiveFailures: health.consecutiveFailures + 1 };
      throw error;
    } finally {
      registry.set(
        AGENT_METRICS.evidenceGenerationLatency,
        Math.max(0, monotonicNow() - started) / 1000,
        { deployment: plan.deployment.deploymentId },
      );
    }
  };

  const drain = async (signal: AbortSignal): Promise<void> => {
    const report = await drainOutbox({
      db: options.db,
      targets: options.config.alertTargets,
      resolve: (ref) => options.env[ref],
      transport: options.transport ?? httpTransport(),
      timeoutMs: Math.min(options.config.jobTimeoutMs, 10_000),
      maxAttempts: options.config.maxJobAttempts,
      leaseMs: options.config.jobTimeoutMs,
      backoffMs: options.config.backoffMs,
      batchSize: 32,
      now: now(),
      signal,
      deliveryIdFor: (outboxId, targetId, attempt) =>
        digest('ictt-sentinel/alert-delivery/v1', `${outboxId}|${targetId}|${String(attempt)}`),
    });
    for (const [outcome, count] of [
      ['delivered', report.delivered],
      ['retrying', report.retrying],
      ['abandoned', report.abandoned + report.undecodable],
    ] as const) {
      if (count > 0) registry.increment(AGENT_METRICS.alertDeliveries, { outcome }, count);
    }
    alertingDegraded = report.retrying > 0 || report.abandoned > 0 || report.undecodable > 0;
  };

  const mirror = async (bundle: EvidenceBundle, signal: AbortSignal): Promise<IngestReport> => {
    const token =
      options.config.ingestTokenRef === null
        ? undefined
        : options.env[options.config.ingestTokenRef];
    const report = await ingest({
      hostedUrl: options.config.hostedUrl,
      token,
      sharingLevel: options.config.sharingLevel,
      bundle,
      timeoutMs: Math.min(options.config.jobTimeoutMs, 10_000),
      signal,
      fetcher: fetch,
    });
    registry.increment(AGENT_METRICS.ingestAttempts, { outcome: report.outcome });
    hostedIngestDegraded = ['unauthorized', 'conflict', 'unreachable'].includes(report.outcome);
    return report;
  };

  const economicPrevious = new Map<string, Verdict>();
  let economicLastRunMs: number | null = null;

  const collectEconomic = async (signal: AbortSignal): Promise<EconomicReport | null> => {
    const economic = options.economic;
    if (economic === undefined) return null;
    const started = monotonicNow();
    if (
      economicLastRunMs !== null &&
      started - economicLastRunMs < options.config.economicIntervalMs
    )
      return null;
    economicLastRunMs = started;
    const deploymentId = plan.deployment.deploymentId;
    const result = await collectConfigured({
      manifest: { value: options.manifest, digest: options.manifestDigest },
      policy: { value: options.policy, digest: options.policyDigest },
      pins: null,
      env: options.env,
      runtime: economic.reader,
      maxLogs: ECONOMIC_MAX_LOGS,
      producer: economic.producer,
      sourceLockHash: SOURCE_LOCK_DOCUMENT_DIGEST,
      signal,
    });
    const at = now();
    let report: EconomicReport;
    let expiresAt: string;
    let fresh: boolean;
    if (result.status === 'evidence') {
      const bundle = result.bundle;
      const verdict = bundle.core.verdict.protocolStatus;
      const keyOf = new Map(
        plan.deployment.chains.map((c) => [c.identity.blockchainId.toLowerCase(), c.chainKey]),
      );
      const stored = await putEvaluation(options.db, {
        deploymentId,
        subject: ECONOMIC_SUBJECT,
        policyVersion: `${options.policy.apiVersion}/${options.policy.metadata.name}`,
        adapterVersion: `${bundle.core.sourceLock.adapterId}@${String(bundle.core.sourceLock.adapterVersion)}`,
        pinnedBlocks: bundle.core.chains.map((c) => ({
          chainKey: keyOf.get(c.blockchainId) ?? c.blockchainId,
          blockNumber: BigInt(c.blockNumber),
          blockHash: c.blockHash,
        })),
        inputObservationDigests: [bundle.contentHash],
        verdict,
        payloadDigest: bundle.contentHash,
      });
      const reasonCodes = bundle.core.verdict.reasonCodes.map((c) => alertCode(c));
      await appendVerdictEvent(options.db, {
        eventId: digest(
          'ictt-sentinel/agent-verdict-event/v1',
          `${stored.evaluationId}|${verdict}|${reasonCodes[0] ?? ''}`,
        ),
        evaluationId: stored.evaluationId,
        verdict,
        reasonCode: reasonCodes[0] ?? `ECONOMIC_${verdict}`,
        detail: { contentHash: bundle.contentHash, subject: ECONOMIC_SUBJECT },
      });
      if (options.config.hostedUrl !== null) await mirror(bundle, signal);
      report = {
        verdict,
        reasonCodes,
        evaluationId: stored.evaluationId,
        contentHash: bundle.contentHash,
      };
      expiresAt = bundle.core.completeness.expiresAt;
      fresh = bundle.core.completeness.fresh;
    } else {
      // No bundle means no pinned blocks to store an evaluation under; the
      // UNKNOWN is still alerted, with the reasons named.
      report = {
        verdict: 'UNKNOWN',
        reasonCodes: [
          'COLLECT_UNAVAILABLE',
          ...result.reasons.map((r) => alertCode(r, 'COLLECT_')),
        ],
        evaluationId: null,
        contentHash: null,
      };
      expiresAt = new Date(
        at.getTime() + options.policy.spec.evidence.maxAgeSeconds * 1000,
      ).toISOString();
      fresh = false;
    }
    await raiseAlert(
      options.db,
      {
        deploymentId,
        evaluationId: report.evaluationId,
        ruleId: ECONOMIC_RULE_ID,
        reasonCode: report.reasonCodes[0] ?? `ECONOMIC_${report.verdict}`,
        previousVerdict: economicPrevious.get(deploymentId) ?? 'NONE',
        verdict: report.verdict,
        evidenceHash:
          report.contentHash ??
          digest('ictt-sentinel/economic-unavailable/v1', report.reasonCodes.join('|')),
        evidenceSchemaVersion: 'ictt-sentinel/evidence/v1',
        reasonCodes: report.reasonCodes,
        observedAt: at.toISOString(),
        expiresAt,
        fresh,
      },
      at,
      (key) => digest('ictt-sentinel/alert-outbox/v1', key),
    );
    economicPrevious.set(deploymentId, report.verdict);
    return report;
  };

  return {
    plan,
    registry,
    state: snapshot,
    collectEconomic,
    hydrate,
    evaluate,
    drain,
    mirror,
    recordOutcome: (result) => {
      registry.increment(AGENT_METRICS.jobs, {
        deployment: plan.deployment.deploymentId,
        result,
      });
    },
  };
};
