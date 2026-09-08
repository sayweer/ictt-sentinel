#!/usr/bin/env node
// Supply-chain gate. Zero dependencies beyond the package manager already in use.
//
// Produces the two artifacts a pilot reviewer asks for and refuses to pass when
// either is unacceptable:
//
//   SBOM      CycloneDX 1.5, generated from the lockfile-resolved tree, written
//             to `artifacts/sbom.cdx.json`.
//   licenses  every distinct license in the runtime and development trees,
//             checked against an allowlist, written to
//             `artifacts/licenses.json`.
//
// It also asserts the things a supply chain can silently lose: exact pins, a
// frozen lockfile, CI actions pinned to immutable commit SHAs, and digest-pinned
// container base images.
//
// `--write` regenerates the artifacts. Without it the artifacts are regenerated
// in memory and compared, so a stale committed SBOM fails the gate rather than
// being quietly refreshed.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACTS = join(ROOT, 'artifacts');
const WRITE = process.argv.includes('--write');
const failures = [];
const fail = (check, msg) => failures.push(`${check}: ${msg}`);

const pnpm = (args) =>
  execFileSync('pnpm', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// --- 1. vulnerabilities ----------------------------------------------------
// A critical or high finding is never suppressed here. Passing one would need a
// user-approved risk acceptance recorded in docs/RELEASE_READINESS.md, and this
// script has no flag that grants it.
let audit;
try {
  audit = JSON.parse(pnpm(['audit', '--json']));
} catch (e) {
  // `pnpm audit` exits non-zero when it finds something; the JSON is still on
  // stdout and is what we judge by.
  try {
    audit = JSON.parse(e.stdout ?? '{}');
  } catch {
    fail('audit', 'pnpm audit produced no parseable report');
    audit = { metadata: { vulnerabilities: {} } };
  }
}
const vulns = audit.metadata?.vulnerabilities ?? {};
for (const level of ['critical', 'high']) {
  if ((vulns[level] ?? 0) > 0) {
    fail(
      'audit',
      `${String(vulns[level])} ${level} advisory/advisories; suppression is not offered`,
    );
  }
}

// --- 2. licenses -----------------------------------------------------------
// Permissive only. Anything copyleft or unknown stops the gate: a pilot operator
// has to be able to run this without a legal review of our dependency tree.
const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'CC-BY-4.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
]);

/**
 * Licenses allowed only for named build-time packages.
 *
 * MPL-2.0 is file-level weak copyleft: obligations attach to modifications of
 * MPL-licensed FILES, which this repository neither modifies nor redistributes.
 * `lightningcss` is Vite's CSS transformer, so it runs on a developer machine
 * and in CI and reaches no shipped artifact - `verify:bundle` proves the browser
 * bundle contains only React, react-dom, scheduler and this repository's own
 * code.
 *
 * Scoped rather than allowlisted outright, so the same license arriving in a
 * runtime dependency would still stop the gate.
 */
const SCOPED_LICENSES = new Map([
  ['MPL-2.0', new Set(['lightningcss', /^lightningcss-[a-z0-9-]+$/])],
]);

const scopeAllows = (license, name) => {
  const scope = SCOPED_LICENSES.get(license);
  if (scope === undefined) return false;
  for (const entry of scope) {
    if (typeof entry === 'string' ? entry === name : entry.test(name)) return true;
  }
  return false;
};

/** Third-party packages any workspace package ships at runtime. */
const runtimeThirdParty = new Set();
for (const base of ['apps', 'packages']) {
  for (const entry of readdirSync(join(ROOT, base))) {
    const path = join(ROOT, base, entry, 'package.json');
    if (!existsSync(path)) continue;
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!dep.startsWith('@ictt-sentinel/')) runtimeThirdParty.add(dep);
    }
  }
}

let licenses = {};
try {
  licenses = JSON.parse(pnpm(['licenses', 'list', '--json']));
} catch {
  fail('licenses', 'pnpm licenses list produced no parseable report');
}

const licenseInventory = [];
for (const [license, packages] of Object.entries(licenses)) {
  for (const pkg of packages) {
    if (!ALLOWED_LICENSES.has(license)) {
      if (!scopeAllows(license, pkg.name)) {
        fail('licenses', `"${license}" (${pkg.name}) is not on the reviewed allowlist`);
      } else if (runtimeThirdParty.has(pkg.name)) {
        // The scope exists because the package is build-time only. If it ever
        // becomes a runtime dependency the exemption no longer applies.
        fail(
          'licenses',
          `"${license}" (${pkg.name}) is scoped to build time but is now a runtime dependency`,
        );
      }
    }
    for (const version of pkg.versions ?? []) {
      licenseInventory.push({
        name: pkg.name,
        version,
        license,
        scoped: !ALLOWED_LICENSES.has(license),
      });
    }
  }
}
licenseInventory.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));

// --- 3. SBOM ---------------------------------------------------------------
// CycloneDX, hand-built from the same resolved tree. The component root uses the
// canonical product name; there is no registry namespace here because this
// package is private and no registry owner has been established.
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    // Deliberately no `timestamp`: a field that changes on every run would make
    // the SBOM impossible to compare, and comparison is the point.
    component: {
      type: 'application',
      'bom-ref': 'pkg:generic/ictt-sentinel',
      name: 'ictt-sentinel',
      version: rootPkg.version,
      description: rootPkg.description,
      licenses: [{ license: { id: 'UNLICENSED' } }],
    },
    tools: [{ name: 'scripts/verify-supply-chain.mjs', vendor: 'ictt-sentinel' }],
  },
  components: licenseInventory.map((entry) => ({
    type: 'library',
    'bom-ref': `pkg:npm/${entry.name}@${entry.version}`,
    name: entry.name,
    version: entry.version,
    purl: `pkg:npm/${entry.name}@${entry.version}`,
    licenses: [{ license: { id: entry.license } }],
  })),
};

// --- 4. exact pins ---------------------------------------------------------
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
for (const base of ['apps', 'packages']) {
  for (const entry of readdirSync(join(ROOT, base))) {
    const path = join(ROOT, base, entry, 'package.json');
    if (!existsSync(path)) continue;
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    for (const field of ['dependencies', 'devDependencies']) {
      for (const [dep, range] of Object.entries(pkg[field] ?? {})) {
        if (range === 'workspace:*') continue;
        if (!EXACT.test(range)) {
          fail('pins', `${base}/${entry} ${field}.${dep} is "${range}", not an exact version`);
        }
      }
    }
  }
}
for (const [dep, range] of Object.entries(rootPkg.devDependencies ?? {})) {
  if (range !== 'workspace:*' && !EXACT.test(range)) {
    fail('pins', `root devDependencies.${dep} is "${range}", not an exact version`);
  }
}
if (!existsSync(join(ROOT, 'pnpm-lock.yaml'))) fail('pins', 'pnpm-lock.yaml is not committed');

// --- 5. CI actions pinned to immutable commit SHAs -------------------------
const workflows = join(ROOT, '.github/workflows');
if (existsSync(workflows)) {
  for (const file of readdirSync(workflows)) {
    const text = readFileSync(join(workflows, file), 'utf8');
    for (const match of text.matchAll(/uses:\s*([^\s#]+)/g)) {
      const ref = match[1];
      if (ref.startsWith('./')) continue; // a local composite action
      if (!/@[0-9a-f]{40}$/.test(ref)) {
        fail('ci-pins', `.github/workflows/${file} uses "${ref}", not a 40-character commit SHA`);
      }
    }
  }
}

// --- 6. container base images pinned to digests ----------------------------
const containerFiles = ['infra/containers/Containerfile', 'infra/postgres/docker-compose.yml'];
for (const rel of containerFiles) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) continue;
  const text = readFileSync(path, 'utf8');

  // Compose services that build their own image locally have nothing to pin:
  // the digest does not exist until the build runs. Only images PULLED from a
  // registry are a supply-chain input, so the service block is inspected first.
  const locallyBuilt = new Set();
  for (const block of text.split(/^ {2}(?=\S)/m)) {
    if (!/^\s*build:/m.test(block)) continue;
    const image = /^\s*image:\s*(\S+)/m.exec(block);
    if (image) locallyBuilt.add(image[1].replace(/^['"]|['"]$/g, ''));
  }

  for (const match of text.matchAll(/^\s*(?:FROM|image:)\s+(\S+)/gm)) {
    const image = match[1].replace(/^['"]|['"]$/g, '');
    // A stage alias (`FROM build AS runtime`) refers to a stage in this file.
    if (!image.includes('/') && !image.includes(':')) continue;
    if (locallyBuilt.has(image)) continue;
    if (!image.includes('@sha256:')) {
      fail('image-pins', `${rel} references "${image}" without a digest`);
    }
  }
}

// --- 7. write or compare ---------------------------------------------------
const serialise = (value) => `${JSON.stringify(value, null, 2)}\n`;
const artifacts = [
  ['sbom.cdx.json', serialise(sbom)],
  [
    'licenses.json',
    serialise({ allowed: [...ALLOWED_LICENSES].sort(), components: licenseInventory }),
  ],
];

const RELEASE_FILES = [
  'artifacts/licenses.json',
  'artifacts/sbom.cdx.json',
  'config/deployments/example.ictt.yml',
  'config/policies/default.yml',
  'docs/BACKUP_RESTORE.md',
  'docs/INCIDENT_RUNBOOK.md',
  'docs/OPERATOR_QUESTIONNAIRE.md',
  'docs/PILOT_ONBOARDING.md',
  'docs/RELEASE_READINESS.md',
  'infra/containers/Containerfile',
  'infra/postgres/docker-compose.yml',
  'pnpm-lock.yaml',
];

const checksumManifest = () => {
  const lines = [];
  for (const rel of RELEASE_FILES) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) {
      fail('release-artifacts', `${rel} is missing`);
      continue;
    }
    lines.push(`${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${rel}`);
  }
  return `${lines.join('\n')}\n`;
};

if (WRITE) {
  mkdirSync(ARTIFACTS, { recursive: true });
  for (const [name, body] of artifacts) writeFileSync(join(ARTIFACTS, name), body, 'utf8');
  writeFileSync(join(ARTIFACTS, 'checksums.txt'), checksumManifest(), 'utf8');
} else {
  for (const [name, body] of artifacts) {
    const path = join(ARTIFACTS, name);
    if (!existsSync(path)) {
      fail('artifacts', `artifacts/${name} is missing; run pnpm run supply-chain:write`);
      continue;
    }
    if (readFileSync(path, 'utf8') !== body) {
      fail('artifacts', `artifacts/${name} is stale; run pnpm run supply-chain:write`);
    }
  }
  const expectedChecksums = checksumManifest();
  const checksumPath = join(ARTIFACTS, 'checksums.txt');
  if (!existsSync(checksumPath)) fail('release-artifacts', 'artifacts/checksums.txt is missing');
  else if (readFileSync(checksumPath, 'utf8') !== expectedChecksums) {
    fail('release-artifacts', 'artifacts/checksums.txt is stale');
  }
}

// --- report ----------------------------------------------------------------
console.log(`note   ${String(licenseInventory.length)} resolved package version(s)`);
console.log(`note   licenses: ${Object.keys(licenses).sort().join(', ')}`);
console.log(
  `note   advisories: critical=${String(vulns.critical ?? 0)} high=${String(vulns.high ?? 0)} moderate=${String(vulns.moderate ?? 0)} low=${String(vulns.low ?? 0)}`,
);

if (failures.length === 0) {
  console.log('\nverify:supply-chain OK - 0 findings');
  process.exit(0);
}
console.error(`\nverify:supply-chain FAILED - ${failures.length} finding(s):`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
