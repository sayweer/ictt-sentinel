#!/usr/bin/env node
// Verify (and optionally install) the project-pinned toolchain.
// Zero dependencies: Node built-ins only. Installs nothing globally.
//
//   node scripts/bootstrap-check.mjs            # verify only
//   node scripts/bootstrap-check.mjs --install   # download pinned Node into .tooling/
//
// The download is the official nodejs.org tarball and its SHA-256 is checked
// against the official SHASUMS256.txt before extraction.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const INSTALL = process.argv.includes('--install');

const problems = [];
const say = (m) => console.log(m);

const nvmrc = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim();
const nodeVersionFile = readFileSync(join(ROOT, '.node-version'), 'utf8').trim();
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const pmField = rootPkg.packageManager ?? '';
const [pmName, pmVersion] = pmField.split('@');

if (nvmrc !== nodeVersionFile) {
  problems.push(`.nvmrc (${nvmrc}) and .node-version (${nodeVersionFile}) disagree`);
}
if (pmName !== 'pnpm' || !pmVersion) {
  problems.push(`package.json packageManager must be "pnpm@<exact>", got "${pmField}"`);
}

const PLATFORM = { darwin: 'darwin', linux: 'linux' }[process.platform];
const ARCH = { arm64: 'arm64', x64: 'x64' }[process.arch];
const slug = PLATFORM && ARCH ? `node-v${nvmrc}-${PLATFORM}-${ARCH}` : null;
const toolDir = join(ROOT, '.tooling', `node-${nvmrc}`);
const toolNode = join(toolDir, 'bin', 'node');

async function install() {
  if (!slug) {
    problems.push(
      `no official tarball mapping for ${process.platform}/${process.arch}; install Node ${nvmrc} yourself`,
    );
    return;
  }
  const base = `https://nodejs.org/dist/v${nvmrc}`;
  const tarName = `${slug}.tar.xz`;
  say(`downloading ${base}/${tarName}`);

  const sums = await fetch(`${base}/SHASUMS256.txt`).then((r) => {
    if (!r.ok) throw new Error(`SHASUMS256.txt HTTP ${r.status}`);
    return r.text();
  });
  const line = sums
    .split('\n')
    .find((l) => l.trim().endsWith(` ${tarName}`) || l.trim().endsWith(`  ${tarName}`));
  if (!line) throw new Error(`${tarName} not listed in official SHASUMS256.txt`);
  const expected = line.trim().split(/\s+/)[0];

  const buf = Buffer.from(
    await fetch(`${base}/${tarName}`).then((r) => {
      if (!r.ok) throw new Error(`tarball HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
  );
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${tarName}\n  expected ${expected}\n  actual   ${actual}`,
    );
  }
  say(`checksum ok: ${actual}`);

  mkdirSync(join(ROOT, '.tooling'), { recursive: true });
  const tarPath = join(ROOT, '.tooling', tarName);
  writeFileSync(tarPath, buf);
  execFileSync('tar', ['-xJf', tarPath, '-C', join(ROOT, '.tooling')], { stdio: 'inherit' });
  rmSync(tarPath);
  if (existsSync(toolDir)) rmSync(toolDir, { recursive: true });
  execFileSync('mv', [join(ROOT, '.tooling', slug), toolDir]);
  say(`installed ${toolDir}`);

  execFileSync(
    toolNode,
    [join(toolDir, 'bin', 'corepack'), 'enable', '--install-directory', join(toolDir, 'bin')],
    {
      stdio: 'inherit',
    },
  );
  execFileSync(toolNode, [join(toolDir, 'bin', 'corepack'), 'install'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  say(`activated ${pmField}`);
}

if (INSTALL) {
  await install();
}

// --- verification ---------------------------------------------------------
const runningNode = process.versions.node;
const usingPinned = process.execPath.startsWith(toolDir);

say(`pinned node   : ${nvmrc}`);
say(`pinned pnpm   : ${pmVersion}`);
say(`running node  : ${runningNode}${usingPinned ? ' (project-pinned)' : ''}`);

// Two ways to satisfy the pin: the runtime already is the pinned version (CI,
// or a version manager), or the project-local toolchain provides it.
if (runningNode === nvmrc) {
  say(`runtime       : matches the pin, no project-local toolchain needed`);
} else if (existsSync(toolNode)) {
  const v = execFileSync(toolNode, ['--version'], { encoding: 'utf8' }).trim();
  if (v !== `v${nvmrc}`) {
    problems.push(`.tooling node reports ${v}, expected v${nvmrc}`);
  } else {
    say(`tooling node  : ${v} OK`);
    say(
      `\nNOTE: this process runs Node ${runningNode}, not the pinned ${nvmrc}.` +
        `\n      Run: source scripts/use-pinned-node.sh`,
    );
  }
} else {
  problems.push(
    `running Node ${runningNode} does not match the pin ${nvmrc} and no project-local ` +
      `toolchain exists at ${toolDir} (run with --install)`,
  );
}

if (problems.length === 0) {
  say('\nbootstrap-check OK');
  process.exit(0);
}
console.error(`\nbootstrap-check FAILED - ${problems.length} problem(s):`);
for (const p of problems) console.error(`  - ${p}`);
process.exit(1);
