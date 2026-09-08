import { assertNoForbiddenSecrets, type EnvSource } from '@ictt-sentinel/config';
import {
  DEFAULT_SHARING_LEVEL,
  TARGET_KINDS,
  isSharingLevel,
  type AlertTarget,
  type SharingLevel,
} from '@ictt-sentinel/alerts';

/**
 * Agent configuration.
 *
 * The environment map is injected rather than read from `process.env` here, so
 * there is exactly one line in the whole application where the real environment
 * enters (`index.ts`), and every test drives this with a literal.
 *
 * Two rules this file enforces before anything else happens:
 *
 *   - Signing material in the environment is a refusal to start, not a warning.
 *     A keyless product that boots next to a minter key is one careless import
 *     away from not being keyless (CLAUDE.md 3).
 *   - Alert targets carry the env NAME of their URL. The URL itself is resolved
 *     at send time and never stored on this object, so a config dump cannot leak
 *     a webhook secret.
 */

export class AgentConfigError extends Error {
  override readonly name = 'AgentConfigError';
}

export interface AgentConfig {
  readonly databaseUrl: string;
  readonly manifestPath: string;
  readonly policyPath: string;
  readonly sharingLevel: SharingLevel;
  /** Only meaningful above `local-only`. */
  readonly hostedUrl: string | null;
  readonly ingestTokenRef: string | null;
  readonly maxConcurrency: number;
  readonly queueLimit: number;
  readonly tickIntervalMs: number;
  readonly jobTimeoutMs: number;
  readonly maxJobAttempts: number;
  readonly backoffMs: number;
  readonly shutdownGraceMs: number;
  readonly alertTargets: readonly AlertTarget[];
  readonly observe: { readonly enabled: boolean; readonly host: string; readonly port: number };
}

const PREFIX = 'ICTT_SENTINEL_';

const int = (env: EnvSource, key: string, fallback: number, min: number, max: number): number => {
  const raw = env[`${PREFIX}${key}`];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]{1,9}$/.test(raw)) {
    throw new AgentConfigError(`${PREFIX}${key} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new AgentConfigError(
      `${PREFIX}${key} must be between ${String(min)} and ${String(max)}`,
    );
  }
  return value;
};

const required = (env: EnvSource, key: string): string => {
  const raw = env[`${PREFIX}${key}`];
  if (raw === undefined || raw === '') {
    throw new AgentConfigError(`${PREFIX}${key} is required`);
  }
  return raw;
};

const SECRET_REF = /^[A-Z][A-Z0-9_]{2,63}$/;
const TARGET_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SEVERITIES = ['WARN', 'UNKNOWN', 'CRITICAL'] as const;

/**
 * Parse the alert target list.
 *
 * A JSON array of `{ targetId, kind, secretRef, minSeverity }`. Bounded at eight
 * targets: this is a notification fan-out, and a hundred of them is a
 * configuration mistake that would be discovered as an outage.
 */
const parseTargets = (raw: string | undefined): readonly AlertTarget[] => {
  if (raw === undefined || raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentConfigError(`${PREFIX}ALERT_TARGETS is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length > 8) {
    throw new AgentConfigError(`${PREFIX}ALERT_TARGETS must be an array of at most 8 targets`);
  }
  return parsed.map((entry: unknown, i): AlertTarget => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new AgentConfigError(`alert target ${String(i)} is not an object`);
    }
    const t = entry as Record<string, unknown>;
    const targetId = t['targetId'];
    const kind = t['kind'];
    const secretRef = t['secretRef'];
    const minSeverity = t['minSeverity'];
    if (typeof targetId !== 'string' || !TARGET_ID.test(targetId)) {
      throw new AgentConfigError(`alert target ${String(i)} has an invalid targetId`);
    }
    if (typeof kind !== 'string' || !(TARGET_KINDS as readonly string[]).includes(kind)) {
      throw new AgentConfigError(`alert target ${targetId} has an unknown kind`);
    }
    // A URL here instead of an env name would put a webhook secret in the
    // process configuration, in logs, and in every crash report.
    if (typeof secretRef !== 'string' || !SECRET_REF.test(secretRef)) {
      throw new AgentConfigError(
        `alert target ${targetId} must name an environment variable, not a URL`,
      );
    }
    if (
      typeof minSeverity !== 'string' ||
      !(SEVERITIES as readonly string[]).includes(minSeverity)
    ) {
      throw new AgentConfigError(`alert target ${targetId} has an invalid minSeverity`);
    }
    return {
      targetId,
      kind: kind as AlertTarget['kind'],
      secretRef,
      minSeverity: minSeverity as AlertTarget['minSeverity'],
    };
  });
};

const HOST = /^(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|localhost|\[::1\])$/;

export const loadAgentConfig = (env: EnvSource): AgentConfig => {
  // First, before anything is parsed or logged.
  assertNoForbiddenSecrets(env);

  const rawSharing = env[`${PREFIX}SHARING_LEVEL`];
  if (rawSharing !== undefined && rawSharing !== '' && !isSharingLevel(rawSharing)) {
    throw new AgentConfigError(`${PREFIX}SHARING_LEVEL is not a known sharing level`);
  }
  const sharingLevel: SharingLevel =
    rawSharing === undefined || rawSharing === '' ? DEFAULT_SHARING_LEVEL : rawSharing;

  const hostedUrl = env[`${PREFIX}HOSTED_URL`] ?? null;
  const ingestTokenRef = env[`${PREFIX}INGEST_TOKEN_REF`] ?? null;
  if (sharingLevel !== 'local-only') {
    if (hostedUrl === null || hostedUrl === '') {
      throw new AgentConfigError(`${PREFIX}HOSTED_URL is required above local-only sharing`);
    }
    if (ingestTokenRef === null || !SECRET_REF.test(ingestTokenRef)) {
      throw new AgentConfigError(
        `${PREFIX}INGEST_TOKEN_REF must name the environment variable holding the ingest token`,
      );
    }
  }

  const observeHost = env[`${PREFIX}OBSERVE_HOST`] ?? '127.0.0.1';
  if (!HOST.test(observeHost)) {
    throw new AgentConfigError(`${PREFIX}OBSERVE_HOST must be a literal address`);
  }

  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    manifestPath: required(env, 'MANIFEST_PATH'),
    policyPath: required(env, 'POLICY_PATH'),
    sharingLevel,
    hostedUrl: sharingLevel === 'local-only' ? null : hostedUrl,
    ingestTokenRef: sharingLevel === 'local-only' ? null : ingestTokenRef,
    maxConcurrency: int(env, 'MAX_CONCURRENCY', 2, 1, 16),
    queueLimit: int(env, 'QUEUE_LIMIT', 32, 1, 1024),
    tickIntervalMs: int(env, 'TICK_INTERVAL_MS', 30_000, 1_000, 3_600_000),
    jobTimeoutMs: int(env, 'JOB_TIMEOUT_MS', 120_000, 1_000, 600_000),
    maxJobAttempts: int(env, 'MAX_JOB_ATTEMPTS', 3, 1, 10),
    backoffMs: int(env, 'BACKOFF_MS', 1_000, 10, 60_000),
    shutdownGraceMs: int(env, 'SHUTDOWN_GRACE_MS', 15_000, 1_000, 120_000),
    alertTargets: parseTargets(env[`${PREFIX}ALERT_TARGETS`]),
    observe: {
      enabled: env[`${PREFIX}OBSERVE_ENABLED`] === 'true',
      host: observeHost,
      port: int(env, 'OBSERVE_PORT', 9464, 1024, 65_535),
    },
  };
};

/**
 * A redacted view for logs and for `--print-config`.
 *
 * Deliberately omits the DSN and never resolves a secretRef: what is printed is
 * the shape of the configuration, not its credentials.
 */
export const describeConfig = (config: AgentConfig): Record<string, unknown> => ({
  sharingLevel: config.sharingLevel,
  hostedConfigured: config.hostedUrl !== null,
  maxConcurrency: config.maxConcurrency,
  queueLimit: config.queueLimit,
  tickIntervalMs: config.tickIntervalMs,
  jobTimeoutMs: config.jobTimeoutMs,
  maxJobAttempts: config.maxJobAttempts,
  shutdownGraceMs: config.shutdownGraceMs,
  alertTargets: config.alertTargets.map((t) => ({
    targetId: t.targetId,
    kind: t.kind,
    minSeverity: t.minSeverity,
    secretRef: t.secretRef,
  })),
  observe: config.observe,
});
