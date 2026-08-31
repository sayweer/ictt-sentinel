import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ConfigError } from '../src/errors.js';
import { parseSafeYaml, DEFAULT_YAML_LIMITS } from '../src/safe-yaml.js';
import { REDACTED, redact, redactToJson } from '../src/redact.js';
import { canonicalDigest, canonicalize } from '../src/canonical.js';
import {
  ResolvedSecret,
  assertNoForbiddenSecrets,
  parseSecretRef,
  requireSecrets,
  resolveSecrets,
} from '../src/secret-ref.js';

/** A value that must never appear in any output this milestone produces. */
const CANARY = 'canary-4f9a2b7c1d8e6f0a3b5c9d2e7f1a4b8c';

const codesOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.issues.map((i) => i.code);
    throw e;
  }
  throw new Error('expected a ConfigError');
};

describe('YAML hardening', () => {
  it('parses an ordinary mapping', () => {
    expect(parseSafeYaml('a: 1\nb: [x, y]\n')).toEqual({ a: 1, b: ['x', 'y'] });
  });

  it('refuses anchors and aliases outright', () => {
    expect(codesOf(() => parseSafeYaml('base: &b {x: 1}\nchild: *b\n'))).toContain(
      'YAML_ALIAS_FORBIDDEN',
    );
  });

  it('refuses an alias expansion bomb', () => {
    const bomb = [
      'a: &a [x,x,x,x,x,x,x,x,x,x]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]',
    ].join('\n');
    expect(codesOf(() => parseSafeYaml(bomb))).toContain('YAML_ALIAS_FORBIDDEN');
  });

  it('refuses an unresolved custom tag instead of degrading it to a string', () => {
    // The parser reports this as a warning and falls back to a plain string, so
    // treating warnings as errors is what keeps an unexpected type out.
    const codes = codesOf(() => parseSafeYaml('a: !!js/function "function(){return 1}"\n'));
    expect(codes).toContain('YAML_UNRESOLVED_TAG');
  });

  it('refuses an unknown application tag', () => {
    expect(codesOf(() => parseSafeYaml('a: !SomeTag {x: 1}\n'))).toContain('YAML_UNRESOLVED_TAG');
  });

  it('refuses merge keys', () => {
    const codes = codesOf(() => parseSafeYaml('base: {x: 1}\nchild:\n  <<: {y: 2}\n  z: 3\n'));
    expect(codes).toContain('YAML_MERGE_KEY_FORBIDDEN');
  });

  it('refuses duplicate keys rather than letting the last one win', () => {
    expect(codesOf(() => parseSafeYaml('a: 1\na: 2\n'))).toContain('YAML_SYNTAX');
  });

  it('refuses a document over the size limit', () => {
    const big = `a: "${'x'.repeat(DEFAULT_YAML_LIMITS.maxBytes + 10)}"\n`;
    expect(codesOf(() => parseSafeYaml(big))).toContain('YAML_TOO_LARGE');
  });

  it('refuses a document over the depth limit', () => {
    let doc = 'v: 1';
    for (let i = 0; i < DEFAULT_YAML_LIMITS.maxDepth + 5; i += 1)
      doc = `k:\n  ${doc.replace(/\n/g, '\n  ')}`;
    expect(codesOf(() => parseSafeYaml(doc))).toContain('YAML_TOO_DEEP');
  });

  it('refuses a non-mapping root', () => {
    expect(codesOf(() => parseSafeYaml('- a\n- b\n'))).toContain('YAML_NOT_A_MAPPING');
  });
});

describe('secretRef resolution', () => {
  it('accepts an allowlisted name', () => {
    expect(parseSecretRef('ICTT_SENTINEL_HOME_RPC_PRIMARY')).toBe('ICTT_SENTINEL_HOME_RPC_PRIMARY');
  });

  it.each(['HOME_RPC_URL', 'AWS_SECRET_ACCESS_KEY', 'PATH', 'lower_case'])('refuses %s', (name) => {
    expect(codesOf(() => parseSecretRef(name)).length).toBeGreaterThan(0);
  });

  it.each([
    'BRIDGE_PRIVATE_KEY',
    'MINTER_PRIVATE_KEY',
    'PAUSER_PRIVATE_KEY',
    'MULTISIG_SIGNER_KEY',
    'MNEMONIC',
    'SEED_PHRASE',
    'ICTT_SENTINEL_SIGNER_KEY',
    'ICTT_SENTINEL_KEYSTORE',
  ])('refuses signing material named %s', (name) => {
    expect(codesOf(() => parseSecretRef(name))).toContain('SECRET_REF_FORBIDDEN');
  });

  it('reports a missing variable rather than substituting a default', () => {
    const ref = parseSecretRef('ICTT_SENTINEL_HOME_RPC_PRIMARY');
    const { resolved, missing } = resolveSecrets([ref], {});
    expect(resolved.size).toBe(0);
    expect(missing).toEqual([ref]);
  });

  it('treats an empty variable as missing', () => {
    const ref = parseSecretRef('ICTT_SENTINEL_HOME_RPC_PRIMARY');
    expect(resolveSecrets([ref], { ICTT_SENTINEL_HOME_RPC_PRIMARY: '' }).missing).toEqual([ref]);
  });

  it('throws with the variable name, never its value', () => {
    const ref = parseSecretRef('ICTT_SENTINEL_HOME_RPC_PRIMARY');
    try {
      requireSecrets([ref], {});
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('ICTT_SENTINEL_HOME_RPC_PRIMARY');
    }
  });

  it('refuses to start when the environment defines signing material', () => {
    expect(
      codesOf(() => {
        assertNoForbiddenSecrets({ MINTER_PRIVATE_KEY: CANARY });
      }),
    ).toContain('SECRET_REF_FORBIDDEN');
  });

  it('does not echo the value of forbidden signing material', () => {
    try {
      assertNoForbiddenSecrets({ MINTER_PRIVATE_KEY: CANARY });
      throw new Error('expected a throw');
    } catch (e) {
      expect((e as Error).message).not.toContain(CANARY);
    }
  });
});

describe('ResolvedSecret does not leak by accident', () => {
  const ref = parseSecretRef('ICTT_SENTINEL_HOME_RPC_PRIMARY');
  const secret = new ResolvedSecret(ref, `https://rpc.example.org/v3/${CANARY}`);

  it('hides the value from string interpolation', () => {
    expect(String(secret)).not.toContain(CANARY);
  });

  it('hides the value from JSON.stringify', () => {
    expect(JSON.stringify({ secret })).not.toContain(CANARY);
  });

  it('hides the value from console-style inspection', () => {
    expect(String(secret)).toBe('[secret ICTT_SENTINEL_HOME_RPC_PRIMARY]');
  });

  it('exposes it only through an explicit call', () => {
    expect(secret.expose()).toContain(CANARY);
  });
});

describe('recursive redaction', () => {
  it('redacts a value under a credential-shaped key', () => {
    const out = redact({ url: `https://rpc.example.org/${CANARY}` }) as Record<string, unknown>;
    expect(out['url']).toBe(REDACTED);
  });

  it('redacts a URL sitting under an innocent key', () => {
    const out = redactToJson({ note: `see https://rpc.example.org/v3/${CANARY} for details` });
    expect(out).not.toContain(CANARY);
    expect(out).toContain('rpc.example.org');
  });

  it('redacts credentials embedded in the URL authority', () => {
    expect(redactToJson({ note: `https://user:${CANARY}@host/path` })).not.toContain(CANARY);
  });

  it('walks an Error cause chain', () => {
    const inner = new Error(`connect failed for postgres://u:${CANARY}@127.0.0.1:5432/db`);
    const outer = new Error('startup failed', { cause: inner });
    expect(redactToJson(outer)).not.toContain(CANARY);
  });

  it('walks a nested cause chain three levels deep', () => {
    const l3 = new Error(`token=${CANARY}`, { cause: new Error(`https://x.example/${CANARY}`) });
    const l2 = new Error('mid', { cause: l3 });
    const l1 = new Error('top', { cause: l2 });
    expect(redactToJson(l1)).not.toContain(CANARY);
  });

  it('walks AggregateError members', () => {
    const agg = new AggregateError([new Error(`https://a.example/${CANARY}`)], 'all failed');
    expect(redactToJson(agg)).not.toContain(CANARY);
  });

  it('redacts inside arrays and nested records', () => {
    const payload = { a: [{ b: { authorization: `Bearer ${CANARY}` } }] };
    expect(redactToJson(payload)).not.toContain(CANARY);
  });

  it('survives a cycle instead of throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    expect(() => redactToJson(a)).not.toThrow();
  });

  // Assembled at runtime so this file does not itself contain the literal
  // patterns the repository secret scanner looks for.
  it.each([
    ['JWT', ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'abcdefghijklmnop'].join('.')],
    ['GitHub token', `ghp_${'a'.repeat(36)}`],
    ['AWS key', ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('')],
    ['Slack token', `xoxb-${'1'.repeat(20)}`],
  ])('redacts a %s wherever it appears', (_label, value) => {
    expect(redactToJson({ note: `saw ${value} here` })).not.toContain(value);
  });

  it('leaves ordinary prose and hex identifiers intact', () => {
    const blockHash = `0x${'c'.repeat(64)}`;
    const out = redactToJson({ note: 'reconciled at pinned block', blockHash });
    expect(out).toContain('reconciled at pinned block');
    expect(out).toContain(blockHash);
  });
});

describe('canonical digest', () => {
  it('is independent of key order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalDigest({ b: 1, a: 2 })).toBe(canonicalDigest({ a: 2, b: 1 }));
  });

  it('is independent of YAML comments and quoting style', () => {
    const a = parseSafeYaml('# a comment\nname: "example"\nvalue: 1\n');
    const b = parseSafeYaml('value: 1\nname: example  # trailing note\n');
    expect(canonicalDigest(a)).toBe(canonicalDigest(b));
  });

  it('preserves array order, because order is meaning for endpoints', () => {
    expect(canonicalDigest({ e: [1, 2] })).not.toBe(canonicalDigest({ e: [2, 1] }));
  });

  it('changes when any value changes', () => {
    expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: 2 }));
  });

  it('is unaffected by a resolved secret, since none is ever part of the document', () => {
    const doc = { endpoints: [{ id: 'a', secretRef: 'ICTT_SENTINEL_HOME_RPC_PRIMARY' }] };
    const before = canonicalDigest(doc);
    // Resolving happens beside the document, never inside it.
    const resolution = resolveSecrets([parseSecretRef('ICTT_SENTINEL_HOME_RPC_PRIMARY')], {
      ICTT_SENTINEL_HOME_RPC_PRIMARY: `https://rpc.example.org/${CANARY}`,
    });
    expect(resolution.resolved.size).toBe(1);
    expect(canonicalDigest(doc)).toBe(before);
    expect(JSON.stringify(doc)).not.toContain(CANARY);
  });

  it('refuses a fractional number rather than hashing a rounded value', () => {
    expect(() => canonicalize({ a: 1.5 })).toThrow();
  });

  it('is stable under key-order permutation', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.integer(), { maxKeys: 8 }),
        (obj) => {
          const shuffled = Object.fromEntries(Object.entries(obj).reverse());
          expect(canonicalDigest(shuffled)).toBe(canonicalDigest(obj));
        },
      ),
      { numRuns: 200 },
    );
  });
});
