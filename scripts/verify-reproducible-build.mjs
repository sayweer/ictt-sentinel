#!/usr/bin/env node
// Rebuild the shipped JavaScript, declarations and browser assets and prove
// that the same source tree produces the same byte-for-byte artifact digest.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const roots = [];
for (const base of ['apps', 'packages']) {
  for (const entry of readdirSync(join(ROOT, base)).sort()) {
    const dist = join(ROOT, base, entry, 'dist');
    if (existsSync(dist)) roots.push(dist);
  }
}
const web = join(ROOT, 'apps/console/dist-web');
if (existsSync(web)) roots.push(web);

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (!path.endsWith('.tsbuildinfo')) files.push(path);
  }
};

const digest = () => {
  files.length = 0;
  for (const root of roots) walk(root);
  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(relative(ROOT, file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
};

if (roots.length === 0) {
  console.error('verify:reproducible-build FAILED - no built artifacts; run pnpm run build');
  process.exit(1);
}
const before = digest();
execFileSync('pnpm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
execFileSync('pnpm', ['run', 'console:build'], { cwd: ROOT, stdio: 'inherit' });
const after = digest();
if (before !== after) {
  console.error(`verify:reproducible-build FAILED\n  before ${before}\n  after  ${after}`);
  process.exit(1);
}
console.log(`verify:reproducible-build OK - ${String(files.length)} files, sha256:${after}`);
