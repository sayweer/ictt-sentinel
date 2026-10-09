import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { domainSeparatedSha256 } from '@ictt-sentinel/evidence';

/**
 * The agent's producer identity for the evidence it writes.
 *
 * Content-addressed over the code that actually runs: the agent's own build and
 * every workspace package it resolves, so two agents producing the same digest
 * ran the same engine. Paths are hashed relative to their package, which keeps
 * the digest independent of where the agent is installed.
 */
export const agentProducerIdentity = (): {
  readonly producer: 'ictt-sentinel';
  readonly buildCommit: string;
  readonly artifactChecksum: string;
} => {
  const here = dirname(fileURLToPath(import.meta.url));
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const entries: string[] = [];
  const scan = (label: string, base: string, dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(label, base, path);
      else if (entry.name.endsWith(extension) && !entry.name.endsWith(`.d${extension}`))
        entries.push(`${label}/${relative(base, path)}\0${readFileSync(path, 'utf8')}`);
    }
  };
  scan('@ictt-sentinel/agent', here, here);
  const scope = join(here, '..', 'node_modules', '@ictt-sentinel');
  if (existsSync(scope))
    for (const name of readdirSync(scope)) {
      const root = realpathSync(join(scope, name));
      const built = join(root, extension === '.ts' ? 'src' : 'dist');
      if (existsSync(built)) scan(`@ictt-sentinel/${name}`, built, built);
    }
  return {
    producer: 'ictt-sentinel',
    buildCommit: 'artifact-addressed',
    artifactChecksum: domainSeparatedSha256('ictt-sentinel/build/v1', entries.sort().join('\0')),
  };
};
