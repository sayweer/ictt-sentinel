/**
 * Recursive redaction.
 *
 * Applied to anything that may reach a log line, an error report, a snapshot or
 * an evidence bundle. Two independent passes, because either alone leaks:
 *
 *   1. Key-based: a value under a credential-shaped key is replaced wholesale.
 *   2. Value-based: a credential-shaped value is replaced wherever it sits,
 *      including inside a message string under an innocent key.
 *
 * Walks `Error.cause` chains and `AggregateError.errors`, which is where a
 * connection string most often survives an otherwise careful redaction.
 */

export const REDACTED = '[REDACTED]';

/** Keys whose value is replaced entirely, matched after normalisation. */
const SECRET_KEYS = new Set([
  'url',
  'urls',
  'rpcurl',
  'endpoint',
  'endpointurl',
  'uri',
  'dsn',
  'connectionstring',
  'databaseurl',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'bearer',
  'authorization',
  'auth',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'apikey',
  'xapikey',
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
  'credential',
  'credentials',
  'headers',
  'header',
]);

const normaliseKey = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Value shapes that are credential material wherever they appear.
 * Deliberately conservative: each pattern has a syntactic anchor, so ordinary
 * prose and hex identifiers are not mangled.
 *
 * Each rule carries its own replacement. A shared callback would be handed
 * `(match, offset, whole)` for the patterns without capture groups, which
 * silently rebuilds the string out of the wrong arguments.
 */
interface RedactRule {
  readonly rx: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

const constant = (): string => REDACTED;

const SECRET_VALUE_RULES: readonly RedactRule[] = [
  {
    // Any absolute URL. Path and query are where project ids and keys live, so
    // those go; scheme and host stay as a breadcrumb for debugging.
    rx: /\b([a-z][a-z0-9+.-]*):\/\/(?:[^\s/@]+@)?([^\s/:?#]+)(?::\d+)?(?:\S*)?/gi,
    replace: (_match, scheme = '', host = '') => `${scheme}://${host}/${REDACTED}`,
  },
  {
    // An inline assignment of a credential-shaped key inside free text, e.g.
    // `token=abc` in an error message. Key-based redaction only sees structured
    // fields, so without this a driver that stringifies its own config leaks.
    rx: /\b(tokens?|api[_-]?keys?|secrets?|passwords?|passwd|pwd|passphrase|authorization|bearer|access[_-]?tokens?|private[_-]?keys?|credentials?)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
    replace: (_match, key = '', sep = '') => `${key}${sep}${REDACTED}`,
  },
  {
    rx: /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
    replace: constant,
  },
  { rx: /-----BEGIN[^-]*PRIVATE KEY-----/g, replace: constant },
  { rx: /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: constant },
  { rx: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: constant },
  { rx: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: constant },
  { rx: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, replace: constant },
];

const redactString = (s: string): string => {
  let out = s;
  for (const { rx, replace } of SECRET_VALUE_RULES) {
    out = out.replace(rx, replace as (substring: string, ...args: unknown[]) => string);
  }
  return out;
};

const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Error);

/**
 * Redact an arbitrary value. Cycles are replaced with `[Circular]` rather than
 * throwing: a redactor that can crash is a redactor that gets bypassed.
 */
export const redact = (value: unknown, seen: WeakSet<object> = new WeakSet()): unknown => {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
    };
    if (value.stack !== undefined) out['stack'] = redactString(value.stack);
    if (value.cause !== undefined) out['cause'] = redact(value.cause, seen);
    if (value instanceof AggregateError) {
      out['errors'] = value.errors.map((e: unknown) => redact(e, seen));
    }
    return out;
  }

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.has(normaliseKey(k)) ? REDACTED : redact(v, seen);
    }
    return out;
  }

  // Maps and Sets hold data worth redacting rather than discarding.
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value) {
      const key = typeof k === 'string' ? k : JSON.stringify(k);
      out[key] = SECRET_KEYS.has(normaliseKey(key)) ? REDACTED : redact(v, seen);
    }
    return out;
  }
  if (value instanceof Set) return [...value].map((v) => redact(v, seen));

  // Any other class instance: name the type instead of stringifying it. A
  // default `[object Object]` would be useless, and a custom toString() could
  // just as easily print the credential it was holding.
  return `[${value.constructor.name}]`;
};

/** Convenience for log sinks: redact then serialise. */
export const redactToJson = (value: unknown): string => JSON.stringify(redact(value));
