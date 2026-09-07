import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The purity boundary, asserted rather than assumed.
 *
 * A single `Date.now()` here would make replay irreproducible and every
 * order-independence property in this package untestable. `check-boundaries`
 * already forbids importing a higher layer; this covers the things that need no
 * import at all.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

const sources = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => [f, readFileSync(join(SRC, f), 'utf8')] as const);

/** Comments legitimately name what they forbid, so scan statements only. */
const statementsOf = (code: string): string =>
  code
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

describe('the pure core stays pure', () => {
  it('has source files to check', () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it.each([
    ['a wall clock', /\bDate\.now\s*\(/],
    ['a fresh Date', /\bnew\s+Date\s*\(\s*\)/],
    ['randomness', /\bMath\.random\s*\(|\bcrypto\.randomUUID\b|\brandomBytes\b/],
    ['the environment', /\bprocess\.env\b/],
    ['the network', /\bfetch\s*\(|\bXMLHttpRequest\b|from\s+'node:https?'/],
    ['the filesystem', /from\s+'node:fs'|\breadFileSync\b/],
    ['a database', /\bsql`|from\s+'postgres'/],
  ])('never reaches for %s', (_what, pattern) => {
    for (const [file, code] of sources) {
      expect(pattern.test(statementsOf(code)), `${file} matched ${pattern.source}`).toBe(false);
    }
  });

  it('imports nothing outside the domain package', () => {
    // Layer 0 may depend on layer 0 only. `check-boundaries` enforces this across
    // the workspace; this keeps the rule visible where it is easiest to break.
    for (const [file, code] of sources) {
      const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
      for (const spec of imports) {
        if (spec.startsWith('.')) continue;
        expect(spec, `${file} imports ${spec}`).toBe('@ictt-sentinel/domain');
      }
    }
  });
});
