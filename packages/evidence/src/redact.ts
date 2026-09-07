/**
 * Secret hygiene for anything that leaves the process.
 *
 * An evidence bundle exists to be shared. That is exactly why a URL with an API
 * key in it, a DSN, or a bearer token must never reach one - the moment the
 * bundle is useful it is also a credential leak (docs/SECURITY.md).
 *
 * Endpoints therefore appear only as pseudonymous ids. This module is the
 * check that nothing else slipped through, applied to the bundle, the HTML
 * projection and every log line.
 */

export const REDACTED = '[redacted]';

/** Patterns that must never appear in shared output. */
const SECRET_PATTERNS: readonly { readonly name: string; readonly rx: RegExp }[] = [
  { name: 'postgres-dsn', rx: /\bpostgres(?:ql)?:\/\/[^\s"']+/gi },
  // Any http(s) URL: an RPC endpoint is a credential in this product, because
  // the key is usually in the path.
  { name: 'http-url', rx: /\bhttps?:\/\/[^\s"']+/gi },
  { name: 'ws-url', rx: /\bwss?:\/\/[^\s"']+/gi },
  { name: 'bearer-token', rx: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi },
  { name: 'basic-header', rx: /\bBasic\s+[A-Za-z0-9+/]+=*/gi },
  { name: 'basic-auth', rx: /\b[A-Za-z0-9._%-]+:[^\s@/"'\\]{1,}@[A-Za-z0-9.-]+/g },
  { name: 'private-key-hex', rx: /\b0x[0-9a-fA-F]{64}\b(?=\s*(?:key|secret|mnemonic))/gi },
  {
    name: 'api-key-assignment',
    rx: /\b(?:api[_-]?key|apikey|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}/gi,
  },
];

export interface SecretFinding {
  readonly pattern: string;
  readonly at: string;
}

/**
 * Scan a document for anything that looks like a credential.
 *
 * Used as a canary in the tests and as a last gate before writing: a positive
 * finding fails the export rather than being quietly scrubbed, because a bundle
 * that needed scrubbing was built wrong upstream.
 */
export const findSecrets = (text: string): readonly SecretFinding[] => {
  const found: SecretFinding[] = [];
  for (const { name, rx } of SECRET_PATTERNS) {
    const re = new RegExp(rx.source, rx.flags);
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      found.push({ pattern: name, at: `offset ${String(m.index)}` });
      if (!re.global) break;
      m = re.exec(text);
    }
  }
  return found;
};

/** Scrub for log lines, where refusing to print is worse than printing less. */
export const redact = (text: string): string => {
  let out = text;
  for (const { rx } of SECRET_PATTERNS) {
    out = out.replace(new RegExp(rx.source, rx.flags), REDACTED);
  }
  return out;
};

/**
 * Pseudonymous endpoint id.
 *
 * Stable for one deployment so two bundles can be compared, and carrying no
 * hostname, so it cannot be turned back into an endpoint by a reader.
 */
export const endpointPseudonym = (
  hash: (input: string) => string,
  deploymentId: string,
  endpointId: string,
): string => `ep-${hash(`${deploymentId}|${endpointId}`).slice(0, 16)}`;

export class SecretInEvidenceError extends Error {
  override readonly name = 'SecretInEvidenceError';
  readonly findings: readonly SecretFinding[];
  constructor(findings: readonly SecretFinding[]) {
    super(
      `refusing to emit evidence containing ${String(findings.length)} possible credential(s): ` +
        [...new Set(findings.map((f) => f.pattern))].join(', '),
    );
    this.findings = findings;
  }
}

/** Fail the export rather than emit something that must not be shared. */
export const assertSecretFree = (text: string): void => {
  const findings = findSecrets(text);
  if (findings.length > 0) throw new SecretInEvidenceError(findings);
};
