import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository-wide forbidden-surface scan.
 *
 * `scripts/check-boundaries.mjs` already refuses a signing or write surface.
 * This adds the third capability the product promises never to have - an
 * automatic circuit breaker - and re-runs the whole scan from inside the lab so
 * the counter is produced by the lab rather than trusted from another gate.
 *
 * A single self-test on every run, because a matcher that stopped matching would
 * otherwise report a reassuring zero.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface SurfaceFinding {
  readonly file: string;
  readonly what: string;
}

/** Names that would mean this product can act on a chain rather than watch it. */
const FORBIDDEN = [
  { rx: /\beth_sendRawTransaction\b/, what: 'a raw transaction submission method' },
  { rx: /\beth_signTransaction\b/, what: 'a transaction signing method' },
  { rx: /\bpersonal_[a-zA-Z]/, what: 'a personal_ namespace method' },
  { rx: /\bwallet_[a-zA-Z]/, what: 'a wallet_ namespace method' },
  { rx: /\bcreateWalletClient\b/, what: 'a wallet client' },
  { rx: /\bprivateKeyToAccount\b/, what: 'a private key to account conversion' },
  { rx: /\bnew\s+Wallet\b/, what: 'a wallet constructor' },
  // The auto-pause surface. Naming it is enough: a function called this could
  // only exist to stop a bridge, which is a chain write and an operator's call.
  { rx: /\bautoPause\b/i, what: 'an automatic pause' },
  { rx: /\bcircuitBreaker\b/i, what: 'a circuit breaker' },
  { rx: /\btriggerPause\b/i, what: 'a pause trigger' },
  { rx: /\bemergencyStop\b/i, what: 'an emergency stop' },
] as const;

/**
 * Files whose job is to name these strings in order to forbid them.
 *
 * Deliberately short and explicit: every entry is a checker or a test whose
 * subject IS the forbidden name.
 */
const EXEMPT = new Set([
  'packages/rpc-quorum/src/methods.ts',
  'packages/rpc-quorum/test/query-only.test.ts',
  'scripts/check-boundaries.mjs',
  'scripts/check-secrets.mjs',
  'tests/lab/surface.ts',
]);

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (
      entry === 'node_modules' ||
      entry === 'dist' ||
      entry === 'dist-web' ||
      entry === '.git' ||
      entry === '.tooling'
    ) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|mts|mjs|jsx?)$/.test(entry)) out.push(full);
  }
  return out;
};

export const scanForbiddenSurface = (): readonly SurfaceFinding[] => {
  const findings: SurfaceFinding[] = [];

  // Self-test first: a broken pattern must not pass everything silently.
  const positive = 'const x = autoPause();';
  const negative = 'const x = pauseDetected;';
  if (!FORBIDDEN.some(({ rx }) => rx.test(positive))) {
    findings.push({ file: 'self-test', what: 'the matcher failed to flag a known positive' });
  }
  if (FORBIDDEN.some(({ rx }) => rx.test(negative))) {
    findings.push({ file: 'self-test', what: 'the matcher flagged a known negative' });
  }

  for (const base of ['apps', 'packages', 'scripts', 'tests', 'infra']) {
    let files: string[];
    try {
      files = walk(join(ROOT, base));
    } catch {
      continue;
    }
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (EXEMPT.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const { rx, what } of FORBIDDEN) {
        if (rx.test(text)) findings.push({ file: rel, what });
      }
    }
  }
  return findings;
};
