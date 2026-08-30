#!/usr/bin/env node
// Scaffold shape checker. Zero dependencies.
//
// Asserts that every workspace package is wired the same way, so a new package
// cannot quietly miss a gate: consistent tsconfig, exports, scripts, entrypoint,
// and project references that mirror the declared dependency contract.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const failures = [];
const fail = (check, msg) => failures.push(`${check}: ${msg}`);

const REQUIRED_SCRIPTS = ['lint', 'typecheck', 'build', 'test'];
const REQUIRED_ROOT_SCRIPTS = [
  'lint',
  'typecheck',
  'test',
  'test:unit',
  'test:integration',
  'build',
  'verify',
  'secrets:check',
  'boundaries:check',
];

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
for (const s of REQUIRED_ROOT_SCRIPTS) {
  if (!rootPkg.scripts?.[s]) fail('root-scripts', `package.json is missing the "${s}" script`);
}

// The cumulative gate must be a fixed sequence that stops at the first failure.
const verify = rootPkg.scripts?.verify ?? '';
if (verify.includes('||') || verify.includes(';')) {
  fail('verify', 'the verify script must chain with && so the first failure returns non-zero');
}
for (const s of ['secrets:check', 'boundaries:check', 'lint', 'typecheck', 'test', 'build']) {
  if (!verify.includes(s)) fail('verify', `the verify chain does not run "${s}"`);
}

const members = [];
for (const base of ['apps', 'packages']) {
  for (const entry of readdirSync(join(ROOT, base))) {
    if (statSync(join(ROOT, base, entry)).isDirectory()) members.push(`${base}/${entry}`);
  }
}

const nameToDir = new Map();
for (const dir of members) {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  nameToDir.set(pkg.name, dir);
}

for (const dir of members) {
  const pkgPath = join(ROOT, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const label = `${dir}/package.json`;

  for (const s of REQUIRED_SCRIPTS) {
    if (!pkg.scripts?.[s]) fail('scripts', `${label} is missing the "${s}" script`);
  }

  if (
    pkg.exports?.['.']?.types !== './dist/index.d.ts' ||
    pkg.exports?.['.']?.import !== './dist/index.js'
  ) {
    fail(
      'exports',
      `${label} must export { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } }`,
    );
  }
  if (pkg.type !== 'module') fail('exports', `${label} must set "type": "module"`);

  const entry = join(ROOT, dir, 'src', 'index.ts');
  if (!existsSync(entry)) fail('entrypoint', `${dir}/src/index.ts is missing`);

  const tsconfigPath = join(ROOT, dir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    fail('tsconfig', `${dir}/tsconfig.json is missing`);
    continue;
  }
  const ts = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
  if (!ts.extends?.endsWith('tsconfig.base.json')) {
    fail('tsconfig', `${dir}/tsconfig.json must extend tsconfig.base.json`);
  }
  if (ts.compilerOptions?.outDir !== 'dist' || ts.compilerOptions?.rootDir !== 'src') {
    fail('tsconfig', `${dir}/tsconfig.json must use rootDir "src" and outDir "dist"`);
  }

  // Project references must mirror the declared dependency contract exactly,
  // otherwise an incremental build can use a stale sibling.
  const declared = new Set(pkg['ictt-sentinel'].mayDependOn.map((n) => nameToDir.get(n)));
  const referenced = new Set(
    (ts.references ?? []).map((r) =>
      relative(ROOT, resolve(ROOT, dir, r.path))
        .split('\\')
        .join('/'),
    ),
  );
  for (const d of declared) {
    if (!referenced.has(d))
      fail('references', `${dir}/tsconfig.json is missing a project reference to ${d}`);
  }
  for (const r of referenced) {
    if (!declared.has(r))
      fail(
        'references',
        `${dir}/tsconfig.json references ${r}, which is not a declared dependency`,
      );
  }
}

// The root build config must reference every member so nothing escapes the build.
const buildCfg = JSON.parse(readFileSync(join(ROOT, 'tsconfig.build.json'), 'utf8'));
const buildRefs = new Set((buildCfg.references ?? []).map((r) => r.path.replace(/^\.\//, '')));
for (const dir of members) {
  if (!buildRefs.has(dir)) fail('build-graph', `tsconfig.build.json does not reference ${dir}`);
}

// Strictness is a gate, not a preference.
const base = JSON.parse(readFileSync(join(ROOT, 'tsconfig.base.json'), 'utf8'));
for (const flag of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']) {
  if (base.compilerOptions?.[flag] !== true)
    fail('strictness', `tsconfig.base.json must set "${flag}": true`);
}

const tooling = [
  'scripts/check-secrets.mjs',
  'scripts/check-boundaries.mjs',
  'scripts/bootstrap-check.mjs',
];
for (const t of tooling) {
  if (!existsSync(join(ROOT, t))) fail('tooling', `${t} is missing`);
}

console.log(`note   ${members.length} workspace member(s) checked`);
if (failures.length === 0) {
  console.log('\nverify:scaffold OK - 0 problems');
  process.exit(0);
}
console.error(`\nverify:scaffold FAILED - ${failures.length} problem(s):`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
