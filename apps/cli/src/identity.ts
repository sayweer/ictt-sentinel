import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { domainSeparatedSha256, type ProducerIdentity } from '@ictt-sentinel/evidence';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** Content-address actual runtime modules, including the engine, rather than a placeholder SHA. */
export const buildIdentity = (): Omit<ProducerIdentity, 'schemaVersion'> => {
  const mode = import.meta.url.endsWith('.ts') ? 'src' : 'dist';
  const extension = mode === 'src' ? '.ts' : '.js';
  const files: string[] = [];
  const scan = (relative: string): void => {
    for (const entry of readdirSync(join(ROOT, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) scan(path);
      else if (entry.name.endsWith(extension)) files.push(path);
    }
  };
  scan(`apps/cli/${mode}`);
  for (const pkg of readdirSync(join(ROOT, 'packages'))) scan(`packages/${pkg}/${mode}`);
  const payload = files
    .sort()
    .map((path) => `${path}\0${readFileSync(join(ROOT, path), 'utf8')}`)
    .join('\0');
  return {
    producer: 'ictt-sentinel',
    buildCommit: 'artifact-addressed',
    artifactChecksum: domainSeparatedSha256('ictt-sentinel/build/v1', payload),
  };
};
export const sourceLockHash = (): string =>
  domainSeparatedSha256(
    'ictt-sentinel/source-lock/v1',
    readFileSync(join(ROOT, 'docs/PROTOCOL_SOURCE_LOCK.md'), 'utf8'),
  );
