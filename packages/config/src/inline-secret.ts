import { type ConfigIssue, issue } from './errors.js';

/**
 * Reject credential material embedded directly in a configuration document.
 *
 * The primary defence is the schema itself: it declares no field that could
 * hold a URL or a token, and unknown properties are rejected. This scan is the
 * second line, because a string can also be smuggled into a field that is
 * legitimately free-form.
 *
 * Runs before schema validation so the operator gets the security error rather
 * than a shape error that happens to mention the value.
 */

/** Keys that must not exist anywhere in a configuration document. */
const FORBIDDEN_KEYS = new Set([
  'url',
  'urls',
  'rpcurl',
  'rpcurls',
  'endpointurl',
  'uri',
  'dsn',
  'connectionstring',
  'databaseurl',
  'token',
  'accesstoken',
  'bearer',
  'authorization',
  'auth',
  'cookie',
  'header',
  'headers',
  'apikey',
  'apisecret',
  'clientsecret',
  'secret',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'privatekey',
  'secretkey',
  'signingkey',
  'signer',
  'wallet',
  'keystore',
  'mnemonic',
  'seedphrase',
  'seed',
  'credential',
  'credentials',
]);

const normaliseKey = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Value shapes that are credential material regardless of the field they sit in.
 * Each has a syntactic anchor so hex identifiers, slugs and prose are untouched.
 */
const FORBIDDEN_VALUES: readonly { rx: RegExp; what: string }[] = [
  { rx: /^[a-z][a-z0-9+.-]*:\/\//i, what: 'an absolute URL' },
  { rx: /\b[a-z][a-z0-9+.-]*:\/\/[^\s]*@/i, what: 'a URL with embedded credentials' },
  { rx: /-----BEGIN[^-]*PRIVATE KEY-----/, what: 'a PEM private key block' },
  { rx: /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, what: 'a JWT' },
  { rx: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, what: 'a GitHub token' },
  { rx: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, what: 'an AWS access key id' },
  { rx: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, what: 'a Slack token' },
  { rx: /^(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}$/, what: 'a BIP-39 style mnemonic' },
];

const scanValue = (value: string, path: string, issues: ConfigIssue[]): void => {
  for (const { rx, what } of FORBIDDEN_VALUES) {
    if (rx.test(value)) {
      issues.push(
        issue(
          'INLINE_SECRET',
          path,
          `looks like ${what}; configuration references a secret by name (secretRef), never by value`,
        ),
      );
      return;
    }
  }
};

const walk = (value: unknown, path: string, issues: ConfigIssue[]): void => {
  if (typeof value === 'string') {
    scanValue(value, path, issues);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      walk(v, `${path}[${String(i)}]`, issues);
    });
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      const child = path === '' ? k : `${path}.${k}`;
      if (FORBIDDEN_KEYS.has(normaliseKey(k))) {
        issues.push(
          issue(
            'FORBIDDEN_FIELD',
            child,
            `the field "${k}" may not appear in configuration; declare a secretRef instead`,
          ),
        );
        // Do not descend: whatever is under it is exactly what must not be read.
        continue;
      }
      walk(v, child, issues);
    }
  }
};

/** Collect inline-secret issues. Empty result means the document is clean. */
export const findInlineSecrets = (document: unknown): readonly ConfigIssue[] => {
  const issues: ConfigIssue[] = [];
  walk(document, '', issues);
  return issues;
};
