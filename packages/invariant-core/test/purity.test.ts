import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The purity boundary for the accounting engine.
 *
 * A clock or a float here would make a verdict irreproducible, and an
 * irreproducible verdict is not evidence. `check-boundaries` already refuses a
 * layer-0 package that imports anything but `@ictt-sentinel/domain`; this covers
 * what needs no import.
 */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const sources = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => [f, readFileSync(join(SRC, f), 'utf8')] as const);

const statementsOf = (code: string): string =>
  code
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

describe('the accounting engine stays pure', () => {
  it('has source files to check', () => {
    expect(sources.length).toBeGreaterThan(4);
  });

  it.each([
    ['a wall clock', /\bDate\.now\s*\(|\bnew\s+Date\s*\(/],
    ['randomness', /\bMath\.random\s*\(|\brandomBytes\b|\brandomUUID\b/],
    ['the environment', /\bprocess\.env\b/],
    ['the network', /\bfetch\s*\(|from\s+'node:https?'/],
    ['the filesystem or crypto', /from\s+'node:(fs|crypto)'/],
    ['a database', /\bsql`|from\s+'postgres'/],
    ['floating point', /\bparseFloat\b|\bNumber\s*\(\s*[a-z]|\btoFixed\b|\bMath\.round\b/],
  ])('never reaches for %s', (_what, pattern) => {
    for (const [file, code] of sources) {
      expect(pattern.test(statementsOf(code)), `${file} matched ${pattern.source}`).toBe(false);
    }
  });

  it('imports nothing outside the domain package', () => {
    for (const [file, code] of sources) {
      for (const m of code.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1] ?? '';
        if (spec.startsWith('.')) continue;
        expect(spec, `${file} imports ${spec}`).toBe('@ictt-sentinel/domain');
      }
    }
  });

  it('uses bigint for every amount, never a number literal decimal', () => {
    // A decimal literal in an accounting file is a float by definition.
    for (const [file, code] of sources) {
      expect(/[^.\w]\d+\.\d+/.test(statementsOf(code)), `${file} has a decimal literal`).toBe(
        false,
      );
    }
  });
});
