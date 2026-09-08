import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

// Resolve @ictt-sentinel/* to source so tests do not depend on build order.
const alias: Record<string, string> = {};
for (const base of ['apps', 'packages']) {
  for (const entry of readdirSync(join(ROOT, base))) {
    if (statSync(join(ROOT, base, entry)).isDirectory()) {
      alias[`@ictt-sentinel/${entry}`] = join(ROOT, base, entry, 'src', 'index.ts');
    }
  }
}

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/test/**/*.test.{ts,tsx}'],
          environment: 'node',
          // Lower group runs first, and alone. The integration project contains
          // architecture.test.ts, which writes deliberate boundary violations
          // into packages/*/src to prove the checker catches them. The CLI
          // reliability test content-addresses those same trees to derive the
          // build identity, so with both projects in parallel one run could see
          // a scratch file the next did not and the two checksums would differ.
          // Separating the groups removes the race without relaxing either test.
          sequence: { groupOrder: 0 },
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          sequence: { groupOrder: 1 },
        },
      },
      {
        resolve: { alias },
        test: {
          // The deterministic fault lab. Its own project so `pnpm run lab` can
          // run the whole adversarial corpus as one command, and so a lab
          // failure is never mistaken for an ordinary unit-test failure.
          name: 'lab',
          include: ['tests/lab/**/*.test.ts'],
          environment: 'node',
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
