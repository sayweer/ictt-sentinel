// @ictt-sentinel/agent
// Deterministic, keyless local watcher daemon.
export const PACKAGE_NAME = '@ictt-sentinel/agent' as const;

export { drainOutbox, raiseAlert } from './alerting.js';
export type { AlertSignal, DrainOptions, DrainReport, RaiseResult } from './alerting.js';
export { AgentConfigError, describeConfig, loadAgentConfig } from './config.js';
export type { AgentConfig } from './config.js';
export { createAgentService } from './daemon.js';
export type { AgentService, AgentServiceOptions } from './daemon.js';
export { applyFreshness, EXPIRED_REASON, STALE_REASON } from './freshness.js';
export type { FreshnessPolicy, FreshnessResult } from './freshness.js';
export { evaluateHealth, HEALTH_REASONS } from './health.js';
export type { AgentState, DeploymentHealth, HealthReport, ReadinessPolicy } from './health.js';
export { ingest, ingestIdempotencyKey } from './ingest.js';
export type { IngestOptions, IngestOutcome, IngestReport } from './ingest.js';
export { createLogSource } from './log-source.js';
export type { ChainWiring, EndpointRead, LogSourceOptions } from './log-source.js';
export {
  AGENT_METRICS,
  MAX_SERIES_PER_METRIC,
  MetricsRegistry,
  createAgentRegistry,
} from './metrics.js';
export type { Labels, MetricKind } from './metrics.js';
export { handleObserve, OBSERVE_PATHS } from './observe.js';
export type { ObserveContext, ObserveResponse } from './observe.js';
export { buildWatchPlan, chainKeyOf } from './plan.js';
export type { WatchPlan } from './plan.js';
export { createEndpointReader, RpcUnavailable } from './rpc.js';
export type { RpcOptions } from './rpc.js';
export { observationDigest, runDeploymentTick } from './runtime.js';
export type {
  ChainPlan,
  DeploymentPlan,
  EvaluationObservation,
  TickDeps,
  TickReport,
} from './runtime.js';
export { Scheduler } from './scheduler.js';
export type {
  Job,
  JobOutcome,
  JobResult,
  SchedulerOptions,
  SchedulerStats,
  SubmitResult,
} from './scheduler.js';
export { createObserveServer } from './serve.js';
export type { ObserveServerOptions } from './serve.js';
export { startAgent } from './main.js';
export type { AgentProcess } from './main.js';
