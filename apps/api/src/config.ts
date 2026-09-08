import {
  assertNoForbiddenSecrets,
  validateSecretRefName,
  type EnvSource,
} from '@ictt-sentinel/config';

export class ApiConfigError extends Error {
  override readonly name = 'ApiConfigError';
}

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly bodyLimit: number;
  readonly rateLimit: number;
  readonly webhookSecretRefs: ReadonlyMap<string, string>;
}

const required = (env: EnvSource, name: string): string => {
  const value = env[name];
  if (value === undefined || value === '') throw new ApiConfigError(`${name} is required`);
  return value;
};
const integer = (
  env: EnvSource,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]{1,9}$/.test(raw)) throw new ApiConfigError(`${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max)
    throw new ApiConfigError(`${name} must be between ${String(min)} and ${String(max)}`);
  return value;
};

const BIND_HOST = /^(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|localhost|\[::1\]|::)$/;
const SOURCE = /^[a-z0-9][a-z0-9-]{1,62}\/[a-z0-9][a-z0-9-]{1,62}$/;

const webhookRefs = (raw: string | undefined): ReadonlyMap<string, string> => {
  if (raw === undefined || raw === '') return new Map();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ApiConfigError('ICTT_SENTINEL_API_WEBHOOK_SECRET_REFS is not valid JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ApiConfigError('ICTT_SENTINEL_API_WEBHOOK_SECRET_REFS must be an object');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64)
    throw new ApiConfigError('ICTT_SENTINEL_API_WEBHOOK_SECRET_REFS has too many sources');
  const result = new Map<string, string>();
  for (const [source, ref] of entries) {
    if (
      !SOURCE.test(source) ||
      typeof ref !== 'string' ||
      validateSecretRefName(ref, `webhook.${source}`).length > 0
    )
      throw new ApiConfigError('ICTT_SENTINEL_API_WEBHOOK_SECRET_REFS contains an invalid entry');
    result.set(source, ref);
  }
  return result;
};

export const loadApiConfig = (env: EnvSource): ApiConfig => {
  assertNoForbiddenSecrets(env);
  const host = env['ICTT_SENTINEL_API_HOST'] ?? '127.0.0.1';
  if (!BIND_HOST.test(host)) throw new ApiConfigError('ICTT_SENTINEL_API_HOST must be literal');
  return {
    databaseUrl: required(env, 'ICTT_SENTINEL_API_DATABASE_URL'),
    host,
    port: integer(env, 'ICTT_SENTINEL_API_PORT', 8080, 1024, 65_535),
    bodyLimit: integer(env, 'ICTT_SENTINEL_API_BODY_LIMIT', 4 * 1024 * 1024, 1024, 8 * 1024 * 1024),
    rateLimit: integer(env, 'ICTT_SENTINEL_API_RATE_LIMIT', 120, 1, 10_000),
    webhookSecretRefs: webhookRefs(env['ICTT_SENTINEL_API_WEBHOOK_SECRET_REFS']),
  };
};

export const describeApiConfig = (config: ApiConfig): Record<string, unknown> => ({
  host: config.host,
  port: config.port,
  bodyLimit: config.bodyLimit,
  rateLimit: config.rateLimit,
  webhookSources: [...config.webhookSecretRefs.keys()].sort(),
});
