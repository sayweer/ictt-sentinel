import { ConfigError, type ConfigIssue, issue } from './errors.js';

/**
 * A SecretRef names an environment variable. It never carries its value.
 *
 * The product promise is "one .env file, zero chain signing keys": the manifest
 * says *which* variable holds a credential, the operator's secret store says
 * what it is, and the two never meet inside version control
 * (docs/SECURITY.md 3).
 */
declare const SECRET_REF: unique symbol;
export type SecretRef = string & { readonly [SECRET_REF]: 'SecretRef' };

/** Uppercase identifier: `A-Z`, digits and underscore, starting with a letter. */
const IDENTIFIER = /^[A-Z][A-Z0-9_]*$/;

/**
 * Prefixes a manifest may reference. Anything outside this list is refused, so
 * a manifest cannot point the resolver at an arbitrary process variable such as
 * `AWS_SECRET_ACCESS_KEY` or `PATH`.
 */
export const ALLOWED_SECRET_REF_PREFIXES: readonly string[] = ['ICTT_SENTINEL_'] as const;

/**
 * Variables this product must never define or read. Their presence anywhere is
 * a hard error, not a warning: a keyless tool that can reach a signing key is
 * no longer keyless (docs/adr/0001-keyless-read-only.md).
 */
export const FORBIDDEN_SECRET_NAMES: readonly string[] = [
  'BRIDGE_PRIVATE_KEY',
  'MINTER_PRIVATE_KEY',
  'PAUSER_PRIVATE_KEY',
  'MULTISIG_SIGNER_KEY',
  'MNEMONIC',
  'SEED_PHRASE',
] as const;

/**
 * Substrings that mark a name as signing material even under an allowed prefix,
 * so `ICTT_SENTINEL_MINTER_PRIVATE_KEY` cannot slip through the prefix check.
 */
const FORBIDDEN_FRAGMENTS: readonly string[] = [
  'PRIVATE_KEY',
  'PRIVATEKEY',
  'SIGNER_KEY',
  'SIGNING_KEY',
  'MNEMONIC',
  'SEED_PHRASE',
  'SEEDPHRASE',
  'KEYSTORE',
  'WALLET',
] as const;

export const validateSecretRefName = (name: string, path: string): readonly ConfigIssue[] => {
  const issues: ConfigIssue[] = [];
  if (!IDENTIFIER.test(name)) {
    issues.push(
      issue(
        'SECRET_REF_NOT_ALLOWLISTED',
        path,
        'a secretRef must be an UPPER_SNAKE_CASE identifier',
      ),
    );
    return issues;
  }
  if (FORBIDDEN_SECRET_NAMES.includes(name)) {
    issues.push(
      issue('SECRET_REF_FORBIDDEN', path, `"${name}" is signing material and is never read`),
    );
    return issues;
  }
  for (const fragment of FORBIDDEN_FRAGMENTS) {
    if (name.includes(fragment)) {
      issues.push(
        issue(
          'SECRET_REF_FORBIDDEN',
          path,
          `a secretRef containing "${fragment}" is signing material`,
        ),
      );
      return issues;
    }
  }
  if (!ALLOWED_SECRET_REF_PREFIXES.some((p) => name.startsWith(p))) {
    issues.push(
      issue(
        'SECRET_REF_NOT_ALLOWLISTED',
        path,
        `a secretRef must start with one of: ${ALLOWED_SECRET_REF_PREFIXES.join(', ')}`,
      ),
    );
  }
  return issues;
};

export const parseSecretRef = (name: string, path = 'secretRef'): SecretRef => {
  const issues = validateSecretRefName(name, path);
  if (issues.length > 0) throw new ConfigError(issues);
  return name as SecretRef;
};

/**
 * The environment as an injected map. `packages/config` never reads
 * `process.env` itself; the application passes it in, which keeps the layer
 * testable and keeps a single, auditable place where secrets enter the process
 * (.claude/rules/apps.md).
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * A resolved secret. The value is reachable only through `expose()`, so a stray
 * template literal or `JSON.stringify` cannot leak it.
 */
export class ResolvedSecret {
  readonly ref: SecretRef;
  readonly #value: string;

  constructor(ref: SecretRef, value: string) {
    this.ref = ref;
    this.#value = value;
  }

  /** Deliberately verbose: call sites that unwrap a secret should be greppable. */
  expose(): string {
    return this.#value;
  }

  toString(): string {
    return `[secret ${this.ref}]`;
  }

  toJSON(): string {
    return `[secret ${this.ref}]`;
  }

  get [Symbol.toStringTag](): string {
    return `Secret(${this.ref})`;
  }
}

export interface SecretResolution {
  readonly resolved: ReadonlyMap<SecretRef, ResolvedSecret>;
  readonly missing: readonly SecretRef[];
}

/**
 * Resolve secret references against an injected environment.
 *
 * Absent variables are reported as `missing`, never substituted with a default:
 * a silent fallback is how a check ends up running against the wrong endpoint.
 */
export const resolveSecrets = (refs: readonly SecretRef[], env: EnvSource): SecretResolution => {
  const resolved = new Map<SecretRef, ResolvedSecret>();
  const missing: SecretRef[] = [];
  for (const ref of refs) {
    const raw = env[ref];
    if (raw === undefined || raw === '') {
      missing.push(ref);
      continue;
    }
    resolved.set(ref, new ResolvedSecret(ref, raw));
  }
  return { resolved, missing };
};

/** Throwing variant for call sites that cannot proceed without every secret. */
export const requireSecrets = (
  refs: readonly SecretRef[],
  env: EnvSource,
): ReadonlyMap<SecretRef, ResolvedSecret> => {
  const { resolved, missing } = resolveSecrets(refs, env);
  if (missing.length > 0) {
    throw new ConfigError(
      missing.map((ref) =>
        issue('SECRET_MISSING', ref, 'is referenced by the manifest but not set'),
      ),
    );
  }
  return resolved;
};

/**
 * Refuse to run at all if the process environment defines signing material.
 * Names only: values are never read (docs/SECURITY.md 1).
 */
export const assertNoForbiddenSecrets = (env: EnvSource): void => {
  const present = FORBIDDEN_SECRET_NAMES.filter((n) => env[n] !== undefined);
  if (present.length > 0) {
    throw new ConfigError(
      present.map((n) =>
        issue(
          'SECRET_REF_FORBIDDEN',
          n,
          'is defined in the environment; this product never handles signing material',
        ),
      ),
      'refusing to start: signing material found in the environment',
    );
  }
};
