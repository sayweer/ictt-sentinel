#!/usr/bin/env node
// Architecture boundary checker. Zero dependencies.
//
// Enforces at the level of real imports, not declared intent:
//   1. A package may only import packages its `mayDependOn` contract allows.
//   2. The import graph is acyclic.
//   3. Layer-0 packages (domain, invariant-core, state-machine) stay pure:
//      no network, DB, filesystem, process.env, wall-clock or randomness.
//   4. Every workspace import resolves to a real workspace package.
//
// Self-tested on every run so a broken matcher cannot pass everything.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const failures = [];
const fail = (check, msg) => failures.push(`${check}: ${msg}`);

// --- workspace contract ---------------------------------------------------
const members = new Map(); // name -> { dir, layer, mayDependOn }
for (const base of ['apps', 'packages']) {
  for (const entry of readdirSync(join(ROOT, base))) {
    const dir = join(base, entry);
    const pjPath = join(ROOT, dir, 'package.json');
    let pj;
    try {
      pj = JSON.parse(readFileSync(pjPath, 'utf8'));
    } catch {
      continue;
    }
    const meta = pj['ictt-sentinel'];
    if (!meta) {
      fail('contract', `${dir}/package.json has no ictt-sentinel contract`);
      continue;
    }
    members.set(pj.name, { dir, layer: meta.layer, mayDependOn: new Set(meta.mayDependOn) });
  }
}

const PURE = [
  '@ictt-sentinel/domain',
  '@ictt-sentinel/invariant-core',
  '@ictt-sentinel/state-machine',
];

/**
 * Anything that makes a result depend on the machine, the clock or the network.
 * A pure rule must produce the same verdict from the same pinned blocks, so these
 * are hard errors in layer 0 (docs/adr/0002-accepted-quorum-truth.md).
 */
const IMPURE_MODULES = [
  'node:fs',
  'node:net',
  'node:http',
  'node:https',
  'node:dns',
  'node:tls',
  'node:dgram',
  'node:child_process',
  'node:worker_threads',
  'node:os',
  'node:process',
  'node:crypto',
  'fs',
  'net',
  'http',
  'https',
  'dns',
  'tls',
  'child_process',
  'os',
  'process',
  'crypto',
  'pg',
  'postgres',
  'undici',
  'axios',
  'node-fetch',
  'viem',
  'ethers',
];
const IMPURE_GLOBALS = [
  { rx: /\bprocess\.env\b/, what: 'process.env' },
  { rx: /\bDate\.now\s*\(/, what: 'Date.now()' },
  { rx: /\bnew\s+Date\s*\(\s*\)/, what: 'new Date()' },
  { rx: /\bMath\.random\s*\(/, what: 'Math.random()' },
  { rx: /\bfetch\s*\(/, what: 'fetch()' },
  { rx: /\bperformance\.now\s*\(/, what: 'performance.now()' },
];

// --- import extraction ----------------------------------------------------
// Static import/export-from, dynamic import(), and require().
const IMPORT_RX =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|[^.\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[^.\w])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractImports(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const out = [];
  for (const m of stripped.matchAll(IMPORT_RX)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.push(spec);
  }
  return out;
}

// --- self-test ------------------------------------------------------------
const SELF_CASES = [
  ["import { a } from '@ictt-sentinel/domain';", ['@ictt-sentinel/domain']],
  ["export * from './x.js';", ['./x.js']],
  ["const p = await import('node:fs');", ['node:fs']],
  ["const q = require('pg');", ['pg']],
  ["// import { z } from 'node:net';", []],
  ["/* import { z } from 'node:net'; */", []],
  ["const s = 'not an import';", []],
];
for (const [src, expected] of SELF_CASES) {
  const got = extractImports(src);
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    fail(
      'selftest',
      `extractImports(${JSON.stringify(src)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

// --- scan -----------------------------------------------------------------
function tsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    // `.tsx` too: a component file that imported node:fs or a workspace package
    // it may not depend on would otherwise be invisible to this gate, which is
    // the one way a checker like this fails silently.
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const actualEdges = new Map(); // name -> Set<name>
for (const [name, info] of members) {
  actualEdges.set(name, new Set());
  const srcDir = join(ROOT, info.dir, 'src');
  let files;
  try {
    files = tsFiles(srcDir);
  } catch {
    continue;
  }
  const isPure = PURE.includes(name);

  for (const file of files) {
    const rel = relative(ROOT, file);
    const source = readFileSync(file, 'utf8');
    const specs = extractImports(source);

    for (const spec of specs) {
      if (spec.startsWith('@ictt-sentinel/')) {
        const dep = spec.split('/').slice(0, 2).join('/');
        if (!members.has(dep)) {
          fail(
            'unknown-workspace-import',
            `${rel} imports ${dep}, which is not a workspace package`,
          );
          continue;
        }
        actualEdges.get(name).add(dep);
        if (!info.mayDependOn.has(dep)) {
          fail('undeclared-dependency', `${rel} imports ${dep}, not listed in ${name} mayDependOn`);
        }
        continue;
      }
      if (isPure && IMPURE_MODULES.includes(spec)) {
        fail('purity', `${rel} imports "${spec}"; layer-0 packages must stay pure`);
      }
    }

    if (isPure) {
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      for (const { rx, what } of IMPURE_GLOBALS) {
        if (rx.test(stripped))
          fail('purity', `${rel} uses ${what}; layer-0 packages must stay pure`);
      }
    }
  }
}

// --- forbidden RPC and signing surface ------------------------------------
// A read-only product must not be able to write to a chain. These are checked
// repository-wide, not just in the RPC package, because the point is that the
// capability exists nowhere (docs/SECURITY.md section 2).
const FORBIDDEN_RPC = [
  { rx: /\beth_sendRawTransaction\b/, what: 'eth_sendRawTransaction' },
  { rx: /\beth_sendTransaction\b/, what: 'eth_sendTransaction' },
  { rx: /\beth_signTransaction\b/, what: 'eth_signTransaction' },
  { rx: /\bpersonal_[a-zA-Z]/, what: 'a personal_ method' },
  { rx: /\bwallet_[a-zA-Z]/, what: 'a wallet_ method' },
  { rx: /\badmin_[a-zA-Z]/, what: 'an admin_ method' },
  { rx: /\bengine_[a-zA-Z]/, what: 'an engine_ method' },
];
const FORBIDDEN_SIGNING = [
  {
    rx: /from\s+['"](?:viem\/accounts|ethers\/wallet|@ethersproject\/wallet)['"]/,
    what: 'a wallet module import',
  },
  { rx: /\bcreateWalletClient\b/, what: 'createWalletClient' },
  { rx: /\bnew\s+Wallet\b/, what: 'new Wallet' },
  { rx: /\bprivateKeyToAccount\b/, what: 'privateKeyToAccount' },
  { rx: /\bsignTypedData\b/, what: 'signTypedData' },
];

// Files whose job is to name these strings in order to forbid them.
const SURFACE_EXEMPT = new Set([
  'packages/rpc-quorum/src/methods.ts',
  'packages/rpc-quorum/test/query-only.test.ts',
  'scripts/check-boundaries.mjs',
  'scripts/check-secrets.mjs',
  '.claude/commands/safety-audit.md',
]);

function scanSurface(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === '.tooling')
      continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      scanSurface(full);
      continue;
    }
    if (!/\.(tsx?|mts|mjs|jsx?)$/.test(entry)) continue;
    const rel = relative(ROOT, full);
    if (SURFACE_EXEMPT.has(rel)) continue;
    const text = readFileSync(full, 'utf8');
    for (const { rx, what } of FORBIDDEN_RPC) {
      if (rx.test(text))
        fail('write-surface', `${rel} references ${what}; this product never writes to a chain`);
    }
    for (const { rx, what } of FORBIDDEN_SIGNING) {
      if (rx.test(text))
        fail('signing-surface', `${rel} references ${what}; this product holds no keys`);
    }
  }
}
for (const base of ['apps', 'packages', 'scripts', 'tests']) {
  try {
    scanSurface(join(ROOT, base));
  } catch {
    // directory absent at this stage
  }
}

// Self-test: a broken pattern must not silently pass everything.
const SURFACE_CASES = [
  ['const m = "eth_sendRawTransaction";', true],
  ['import { privateKeyToAccount } from "viem/accounts";', true],
  ['const c = createWalletClient({});', true],
  ['const m = "eth_getLogs";', false],
  ['const c = createPublicClient({});', false],
];
for (const [sample, shouldFlag] of SURFACE_CASES) {
  const flagged =
    FORBIDDEN_RPC.some(({ rx }) => rx.test(sample)) ||
    FORBIDDEN_SIGNING.some(({ rx }) => rx.test(sample));
  if (flagged !== shouldFlag) {
    fail('surface-selftest', `"${sample}" expected flagged=${shouldFlag}, got ${flagged}`);
  }
}

// --- layer direction and cycles ------------------------------------------
for (const [name, info] of members) {
  for (const dep of actualEdges.get(name) ?? []) {
    const depInfo = members.get(dep);
    if (depInfo && depInfo.layer > info.layer) {
      fail(
        'layer-direction',
        `${name} (layer ${info.layer}) imports ${dep} (layer ${depInfo.layer})`,
      );
    }
  }
}

const state = new Map();
function visit(name, trail) {
  const s = state.get(name);
  if (s === 'done') return;
  if (s === 'open') {
    fail('cycle', `import cycle: ${[...trail, name].join(' -> ')}`);
    return;
  }
  state.set(name, 'open');
  for (const dep of actualEdges.get(name) ?? []) visit(dep, [...trail, name]);
  state.set(name, 'done');
}
for (const name of members.keys()) visit(name, []);

// Declared edges that nothing imports are allowed while packages are empty,
// but the pure root must genuinely depend on nothing.
if ((actualEdges.get('@ictt-sentinel/domain') ?? new Set()).size > 0) {
  fail('purity', '@ictt-sentinel/domain must not import any workspace package');
}

// --- report ---------------------------------------------------------------
const edgeCount = [...actualEdges.values()].reduce((n, s) => n + s.size, 0);
console.log(`note   ${members.size} workspace package(s), ${edgeCount} actual import edge(s)`);
console.log(`note   ${SELF_CASES.length} extractor self-test case(s) passed`);

if (failures.length === 0) {
  console.log('\ncheck-boundaries OK - 0 violations');
  process.exit(0);
}
console.error(`\ncheck-boundaries FAILED - ${failures.length} violation(s):`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
