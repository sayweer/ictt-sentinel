import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export const readRepoFile = (rel: string): string => readFileSync(`${ROOT}${rel}`, 'utf8');

export const VALID_MANIFEST = readRepoFile('config/deployments/example.ictt.yml');
export const VALID_POLICY = readRepoFile('config/policies/default.yml');

/**
 * Apply a surgical edit to the known-good manifest.
 * Each negative fixture changes exactly one thing, so a failure names the rule
 * that caught it rather than a pile of unrelated errors.
 */
export const mutate = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) {
    throw new Error(`fixture anchor not found, the example manifest changed: ${from.slice(0, 60)}`);
  }
  return source.replace(from, to);
};
