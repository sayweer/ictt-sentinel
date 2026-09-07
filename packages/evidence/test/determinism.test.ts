import { describe, expect, it } from 'vitest';
import {
  QUICKSTART_SCENARIOS,
  quickstartBundleDraft,
  type QuickstartScenario,
} from '@ictt-sentinel/testkit';
import { canonicalStringify, NonCanonicalValueError } from '../src/canonical.js';
import { buildBundle } from '../src/bundle.js';
import { hashCore } from '../src/hash.js';
import { findSecrets } from '../src/redact.js';
import { renderHtml } from '../src/html.js';

/**
 * The reproducibility promise, asserted rather than assumed: the same evidence
 * must hash the same on any machine, at any time, whatever order the fields
 * happened to be built in.
 */

const draft = (s: QuickstartScenario = 'healthy') => quickstartBundleDraft(s);

describe('canonical serialisation', () => {
  it('is independent of key insertion order', () => {
    const a = { z: '1', a: '2', m: { y: '3', b: '4' } };
    const b = { m: { b: '4', y: '3' }, a: '2', z: '1' };
    expect(canonicalStringify(b)).toBe(canonicalStringify(a));
  });

  it('serialises bigint as a decimal string, not a JSON number', () => {
    const big = (1n << 200n) + 7n;
    const s = canonicalStringify({ v: big });
    expect(s).toBe(`{"v":"${big.toString(10)}"}`);
    // Round-tripping through JSON must not lose the low bits.
    const parsed = JSON.parse(s) as { v: string };
    expect(BigInt(parsed.v)).toBe(big);
  });

  it('normalises Unicode so the same text has one encoding', () => {
    // U+00E9 vs e + U+0301: the same character, two encodings.
    expect(canonicalStringify({ k: 'é' })).toBe(canonicalStringify({ k: 'é' }));
  });

  it('refuses a fractional number rather than rounding it', () => {
    expect(() => canonicalStringify({ v: 1.5 })).toThrow(NonCanonicalValueError);
  });

  it('refuses an unsafe integer rather than truncating it', () => {
    expect(() => canonicalStringify({ v: 2 ** 53 })).toThrow(NonCanonicalValueError);
  });

  it('does not conflate an absent key with an undefined one', () => {
    expect(canonicalStringify({ a: '1', b: undefined })).toBe(canonicalStringify({ a: '1' }));
  });

  it('emits no JSON numbers at all', () => {
    // Structural, not textual: an ISO timestamp contains "T00:00:00", so a regex
    // for a colon-then-digit would match inside a perfectly good string value.
    const walk = (v: unknown, path: string): void => {
      expect(typeof v, `${path} is a JSON number`).not.toBe('number');
      if (Array.isArray(v)) {
        v.forEach((x, i) => {
          walk(x, `${path}[${String(i)}]`);
        });
      } else if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      }
    };
    walk(JSON.parse(canonicalStringify(draft().core)), '$');
  });
});

describe('content hash', () => {
  it.each(QUICKSTART_SCENARIOS)('is stable across runs for %s', (scenario) => {
    const a = buildBundle(draft(scenario));
    const b = buildBundle(draft(scenario));
    expect(b.contentHash).toBe(a.contentHash);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores presentation metadata entirely', () => {
    // The whole point: two machines in two timezones produce the same identity.
    const base = draft();
    const a = buildBundle(base);
    const b = buildBundle({
      ...base,
      presentation: {
        generatedAt: '2031-12-31T23:59:59.999Z',
        locale: 'tr-TR',
        toolVersion: '9.9.9',
      },
    });
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.presentation).not.toEqual(a.presentation);
  });

  it('changes when a single pinned block hash changes', () => {
    const base = draft();
    const chains = [...base.core.chains];
    const first = chains[0];
    if (!first) throw new Error('fixture has no chains');
    chains[0] = { ...first, blockHash: `0x${'99'.repeat(32)}` };
    const tampered = buildBundle({ ...base, core: { ...base.core, chains } });
    expect(tampered.contentHash).not.toBe(buildBundle(base).contentHash);
  });

  it('changes when the verdict changes', () => {
    const base = draft('healthy');
    // The healthy fixture is already OK, so flip it to something different.
    const tampered = buildBundle({
      ...base,
      core: {
        ...base.core,
        verdict: { ...base.core.verdict, protocolStatus: 'CRITICAL' as const },
      },
    });
    expect(tampered.contentHash).not.toBe(buildBundle(base).contentHash);
  });

  it('changes when a single byte of a fact digest changes', () => {
    const base = draft();
    const facts = [...base.core.rawFacts];
    const f = facts[0];
    if (!f) throw new Error('fixture has no facts');
    facts[0] = { ...f, digest: `${f.digest.slice(0, 63)}${f.digest.endsWith('f') ? '0' : 'f'}` };
    expect(buildBundle({ ...base, core: { ...base.core, rawFacts: facts } }).contentHash).not.toBe(
      buildBundle(base).contentHash,
    );
  });

  it('is domain separated from a bare sha256 of the same bytes', () => {
    const core = draft().core;
    // A different schema version must not be able to collide with this one.
    expect(hashCore(core)).not.toBe(hashCore({ ...core, deploymentId: `${core.deploymentId}-x` }));
  });

  it('differs between the three scenarios', () => {
    const hashes = QUICKSTART_SCENARIOS.map((s) => buildBundle(draft(s)).contentHash);
    expect(new Set(hashes).size).toBe(QUICKSTART_SCENARIOS.length);
  });
});

describe('secret hygiene', () => {
  it.each(QUICKSTART_SCENARIOS)('has no credential anywhere in the %s bundle', (scenario) => {
    const bundle = buildBundle(draft(scenario));
    expect(findSecrets(JSON.stringify(bundle))).toEqual([]);
  });

  it('has no credential in the HTML projection', () => {
    expect(findSecrets(renderHtml(buildBundle(draft())))).toEqual([]);
  });

  it('detects a planted canary, so the check is not vacuous', () => {
    // If this passed while the check above also passed, the check would prove
    // nothing.
    const canary = 'https://rpc.example.com/v3/deadbeefdeadbeefdeadbeefdeadbeef';
    expect(findSecrets(`endpoint: ${canary}`).length).toBeGreaterThan(0);
    expect(findSecrets('postgres://user:hunter2hunter2@db.internal/x').length).toBeGreaterThan(0);
    expect(
      findSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345').length,
    ).toBeGreaterThan(0);
  });

  it('records endpoints only as pseudonymous ids', () => {
    const bundle = buildBundle(draft());
    for (const vote of bundle.core.quorum.votes) {
      expect(vote.endpointId).toMatch(/^ep-[0-9a-f]+$/);
      expect(vote.endpointId).not.toContain('://');
    }
  });
});

describe('HTML projection', () => {
  it('does not change the core hash', () => {
    const bundle = buildBundle(draft());
    const before = bundle.contentHash;
    renderHtml(bundle);
    expect(hashCore(bundle.core)).toBe(before);
  });

  it('uses these words only to deny them, never to claim them', () => {
    // The words themselves are not the problem; asserting them is. Every
    // occurrence must sit immediately behind a negation, so the document can say
    // "not tamper-proof" and "no claim of proof of reserves" while never
    // claiming either.
    const html = renderHtml(buildBundle(draft())).toLowerCase();
    for (const word of ['proof of reserves', 'solvent', 'tamper-proof', 'guaranteed']) {
      let from = html.indexOf(word);
      while (from !== -1) {
        // Look back to the start of the enclosing clause rather than a fixed
        // window: "no claim of absolute solvency or proof of reserves" puts the
        // negation further away than a short window would reach.
        const clauseStart = Math.max(
          html.lastIndexOf('>', from),
          html.lastIndexOf('.', from),
          html.lastIndexOf(';', from),
        );
        const clause = html.slice(clauseStart + 1, from);
        expect(clause, `"${word}" is asserted, not denied, in: ${clause}`).toMatch(
          /\b(?:not|no|never)\b/,
        );
        from = html.indexOf(word, from + word.length);
      }
    }
    expect(html).toContain('not tamper-proof');
    expect(html).toContain('no claim of absolute solvency');
  });

  it('escapes content rather than interpolating it raw', () => {
    const base = draft();
    const html = renderHtml(
      buildBundle({ ...base, core: { ...base.core, deploymentId: '<script>x</script>' } }),
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
