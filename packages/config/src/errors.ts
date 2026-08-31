/**
 * Configuration errors.
 *
 * An error message is an untrusted surface: it lands in logs, CI output and
 * evidence bundles. These errors therefore carry a code and a document path,
 * never the offending value (docs/SECURITY.md 3).
 */
export type ConfigErrorCode =
  | 'YAML_SYNTAX'
  | 'YAML_UNRESOLVED_TAG'
  | 'YAML_ALIAS_FORBIDDEN'
  | 'YAML_MERGE_KEY_FORBIDDEN'
  | 'YAML_TOO_LARGE'
  | 'YAML_TOO_DEEP'
  | 'YAML_NOT_A_MAPPING'
  | 'INLINE_SECRET'
  | 'FORBIDDEN_FIELD'
  | 'UNKNOWN_API_VERSION'
  | 'UNSUPPORTED_API_VERSION'
  | 'SCHEMA'
  | 'SECRET_REF_FORBIDDEN'
  | 'SECRET_REF_NOT_ALLOWLISTED'
  | 'SECRET_MISSING'
  | 'FAKE_QUORUM'
  | 'DUPLICATE_ENDPOINT'
  | 'BASELINE_NOT_APPROVED';

export interface ConfigIssue {
  readonly code: ConfigErrorCode;
  /** Dotted path inside the document, e.g. `spec.home.endpoints[1].secretRef`. */
  readonly path: string;
  /** Explanation. Must never quote the offending value. */
  readonly message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[], summary?: string) {
    const head = summary ?? `configuration rejected (${String(issues.length)} issue(s))`;
    super(
      `${head}\n${issues.map((i) => `  [${i.code}] ${i.path || '<root>'}: ${i.message}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export const issue = (code: ConfigErrorCode, path: string, message: string): ConfigIssue => ({
  code,
  path,
  message,
});
