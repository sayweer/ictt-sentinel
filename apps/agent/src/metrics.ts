/**
 * Metrics.
 *
 * A metrics endpoint is an exfiltration surface if you let it be one. Label
 * values end up in a time-series database that is usually less protected than
 * this process, is often shared across teams, and is frequently public inside a
 * company. So the registry enforces three rules rather than trusting call sites:
 *
 *   1. Label NAMES come from a fixed allowlist. A new dimension is a code change.
 *   2. Label VALUES are shape-checked. A URL, a DSN, a bearer token or anything
 *      long enough to hide one is refused, not truncated.
 *   3. Series count per metric is capped. An unbounded label value - a message
 *      id, a block hash, an error string - would otherwise take the scrape
 *      target down, and a dead scrape target is a blind operator.
 *
 * A refused sample increments `dropped`, so the loss is visible instead of silent.
 */

export const ALLOWED_LABELS = [
  'deployment',
  'chain',
  'rule',
  'result',
  'outcome',
  'state',
  'kind',
  'target',
  'level',
] as const;
export type LabelName = (typeof ALLOWED_LABELS)[number];

export type Labels = Partial<Record<LabelName, string>>;

/** Bounded, low-cardinality identifiers only. */
const LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Shapes that must never reach a time-series database. */
const FORBIDDEN_VALUE = [
  /:\/\//, // any URL scheme
  /@/, // userinfo or an email
  /^[A-Fa-f0-9]{32,}$/, // a hash, a token or a raw key
  /^0x[0-9a-fA-F]{40,}$/, // an address or a block hash
];

export const MAX_SERIES_PER_METRIC = 200;

export type MetricKind = 'counter' | 'gauge';

interface Series {
  readonly labels: Labels;
  value: number;
}

interface Metric {
  readonly name: string;
  readonly kind: MetricKind;
  readonly help: string;
  readonly series: Map<string, Series>;
}

export class MetricsRegistry {
  readonly #metrics = new Map<string, Metric>();
  #dropped = 0;

  define(name: string, kind: MetricKind, help: string): void {
    if (!this.#metrics.has(name)) {
      this.#metrics.set(name, { name, kind, help, series: new Map() });
    }
  }

  /** Samples refused because a label was unacceptable or the cap was reached. */
  get dropped(): number {
    return this.#dropped;
  }

  increment(name: string, labels: Labels = {}, by = 1): void {
    this.#write(name, labels, (current) => current + by);
  }

  set(name: string, value: number, labels: Labels = {}): void {
    this.#write(name, labels, () => value);
  }

  #write(name: string, labels: Labels, next: (current: number) => number): void {
    const metric = this.#metrics.get(name);
    if (metric === undefined || !acceptable(labels)) {
      this.#dropped += 1;
      return;
    }
    const key = seriesKey(labels);
    const existing = metric.series.get(key);
    if (existing !== undefined) {
      existing.value = next(existing.value);
      return;
    }
    if (metric.series.size >= MAX_SERIES_PER_METRIC) {
      this.#dropped += 1;
      return;
    }
    metric.series.set(key, { labels, value: next(0) });
  }

  /** Prometheus text exposition. No timestamps: the scraper supplies those. */
  render(): string {
    const lines: string[] = [];
    for (const metric of [...this.#metrics.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.kind}`);
      for (const series of metric.series.values()) {
        const rendered = renderLabels(series.labels);
        lines.push(`${metric.name}${rendered} ${String(series.value)}`);
      }
    }
    lines.push('# HELP ictt_sentinel_metric_samples_dropped_total Samples refused by the label policy or the series cap.');
    lines.push('# TYPE ictt_sentinel_metric_samples_dropped_total counter');
    lines.push(`ictt_sentinel_metric_samples_dropped_total ${String(this.#dropped)}`);
    return `${lines.join('\n')}\n`;
  }
}

const acceptable = (labels: Labels): boolean => {
  for (const [name, value] of Object.entries(labels)) {
    if (!(ALLOWED_LABELS as readonly string[]).includes(name)) return false;
    if (typeof value !== 'string' || !LABEL_VALUE.test(value)) return false;
    if (FORBIDDEN_VALUE.some((rx) => rx.test(value))) return false;
  }
  return true;
};

const seriesKey = (labels: Labels): string =>
  Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(',');

const renderLabels = (labels: Labels): string => {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return `{${entries.map(([k, v]) => `${k}="${String(v)}"`).join(',')}}`;
};

/**
 * The agent's metric set.
 *
 * Chosen to make the product's own data path visible, because a watcher whose
 * collection is broken looks exactly like a deployment with nothing to report
 * (docs/ARCHITECTURE.md 10).
 */
export const AGENT_METRICS = {
  jobs: 'ictt_sentinel_agent_jobs_total',
  queueDepth: 'ictt_sentinel_agent_queue_depth',
  backpressure: 'ictt_sentinel_agent_backpressure_rejected_total',
  evaluationAge: 'ictt_sentinel_evaluation_age_seconds',
  staleEvaluations: 'ictt_sentinel_stale_evaluations_total',
  unknownRules: 'ictt_sentinel_rule_unknown_total',
  alertDeliveries: 'ictt_sentinel_alert_delivery_total',
  hintQueueDepth: 'ictt_sentinel_hint_queue_depth',
  ingestAttempts: 'ictt_sentinel_hosted_ingest_total',
  lastSuccessAge: 'ictt_sentinel_last_success_age_seconds',
} as const;

export const createAgentRegistry = (): MetricsRegistry => {
  const registry = new MetricsRegistry();
  registry.define(AGENT_METRICS.jobs, 'counter', 'Evaluation jobs by terminal result.');
  registry.define(AGENT_METRICS.queueDepth, 'gauge', 'Jobs waiting for a concurrency slot.');
  registry.define(
    AGENT_METRICS.backpressure,
    'counter',
    'Submissions refused because the queue was full.',
  );
  registry.define(
    AGENT_METRICS.evaluationAge,
    'gauge',
    'Age of the newest evaluation per deployment, in seconds.',
  );
  registry.define(
    AGENT_METRICS.staleEvaluations,
    'counter',
    'Evaluations degraded to UNKNOWN because they aged past the policy limit.',
  );
  registry.define(AGENT_METRICS.unknownRules, 'counter', 'Rule evaluations that landed on UNKNOWN.');
  registry.define(AGENT_METRICS.alertDeliveries, 'counter', 'Alert deliveries by outcome.');
  registry.define(AGENT_METRICS.hintQueueDepth, 'gauge', 'Unconsumed speed hints per deployment.');
  registry.define(
    AGENT_METRICS.ingestAttempts,
    'counter',
    'Hosted-plane ingest attempts by outcome. Failure here never changes a verdict.',
  );
  registry.define(
    AGENT_METRICS.lastSuccessAge,
    'gauge',
    'Seconds since the last successful evaluation per deployment.',
  );
  return registry;
};
