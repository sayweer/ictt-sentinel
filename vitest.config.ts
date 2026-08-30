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
          include: ['{apps,packages}/*/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
