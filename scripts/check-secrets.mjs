#!/usr/bin/env node
// Secret scanner. Zero dependencies, identical in local and CI.
//
// Two jobs:
//   1. Refuse the env names this product must never handle (docs/SECURITY.md 1).
//   2. Refuse committed credential material.
//
// A scanner that cannot fail is worse than none, so the rule set is self-tested
// against known-positive and known-negative samples on every run.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const findings = [];

/** Env names whose presence on an executable surface is a build error. */
const FORBIDDEN_ENV = [
  'BRIDGE_PRIVATE_KEY',
  'MINTER_PRIVATE_KEY',
  'PAUSER_PRIVATE_KEY',
  'MULTISIG_SIGNER_KEY',
];

/**
 * Match a forbidden env name where it would actually be consumed or defined:
 * `process.env.X`, `env.X`, `X=...`, `X: ...`, `${X}`, `$X`.
 */
const envUsageRx = (env) =>
  new RegExp(
    String.raw`(?:process\.env\.${env}\b|\benv\.${env}\b|\bENV\[["']${env}["']\]|^\s*-?\s*${env}\s*[:=]|\$\{?${env}\}?)`,
    'm',
  );

const RULES = [
  {
    id: 'private-key-block',
    rx: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/,
    msg: 'PEM private key block',
  },
  {
    id: 'evm-private-key',
    // 32-byte hex assigned to a key-ish name. The name requirement keeps block
    // hashes and bytecode fingerprints out of the result set.
    rx: /(?:private_?key|privkey|secret_?key|signer_?key)\s*[:=]\s*["']?0x[0-9a-fA-F]{64}\b/i,
    msg: 'EVM private key assigned to a key-named field',
  },
  {
    id: 'mnemonic',
    rx: /(?:mnemonic|seed_?phrase)\s*[:=]\s*["'][a-z]+(?:\s+[a-z]+){11,23}["']/i,
    msg: 'BIP-39 style mnemonic',
  },
  {
    id: 'aws-access-key',
    rx: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    msg: 'AWS access key id',
  },
  {
    id: 'github-token',
    rx: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    msg: 'GitHub token',
  },
  {
    id: 'slack-webhook',
    rx: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/,
    msg: 'Slack webhook URL with embedded secret',
  },
  {
    id: 'generic-bearer',
    rx: /\b(?:authorization|api[_-]?key|access[_-]?token)\s*[:=]\s*["'](?!\$\{)[A-Za-z0-9_-]{24,}["']/i,
    msg: 'hardcoded API key or bearer token',
  },
  {
    id: 'rpc-url-with-key',
    rx: /https:\/\/[a-z0-9.-]+\/(?:v[0-9]+\/)?[A-Za-z0-9_-]{28,}(?:["'\s]|$)/,
    msg: 'RPC URL with an embedded project key',
  },
];

// --- self-test ------------------------------------------------------------
const POSITIVE = [
  ['private-key-block', '-----BEGIN PRIVATE KEY-----'],
  ['evm-private-key', 'privateKey = "0x' + 'a'.repeat(64) + '"'],
  [
    'mnemonic',
    'mnemonic: "abandon ability able about above absent absorb abstract absurd abuse access accident"',
  ],
  ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
  ['github-token', 'ghp_' + 'a'.repeat(36)],
  [
    'slack-webhook',
    'https://hooks.slack.com/' + 'services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX',
  ],
  ['generic-bearer', 'api_key = "' + 'k'.repeat(32) + '"'],
  ['rpc-url-with-key', 'https://mainnet.example.org/v3/' + 'b'.repeat(32)],
];
const NEGATIVE = [
  'HOME_RPC_URL=${HOME_RPC_URL}',
  'rpcEnv: HOME_RPC_URL',
  'blockHash: "0x' + 'c'.repeat(64) + '"',
  'https://registry.npmjs.org/typescript',
  'Authorization: Bearer ${GITHUB_MCP_TOKEN}',
  'https://github.com/ava-labs/icm-services',
];

const ENV_POSITIVE = [
  'process.env.BRIDGE_PRIVATE_KEY',
  'MINTER_PRIVATE_KEY=0xdead',
  '  PAUSER_PRIVATE_KEY: ${PAUSER_PRIVATE_KEY}',
  'const k = env.MULTISIG_SIGNER_KEY;',
];
const ENV_NEGATIVE = [
  'these must never exist: BRIDGE_PRIVATE_KEY, MINTER_PRIVATE_KEY',
  'the product refuses MULTISIG_SIGNER_KEY entirely',
  'process.env.HOME_RPC_URL',
];

const selfTestFailures = [];
for (const [id, sample] of POSITIVE) {
  const rule = RULES.find((r) => r.id === id);
  if (!rule || !rule.rx.test(sample))
    selfTestFailures.push(`rule ${id} failed to match its own positive sample`);
}
for (const sample of NEGATIVE) {
  const hit = RULES.find((r) => r.rx.test(sample));
  if (hit)
    selfTestFailures.push(
      `rule ${hit.id} false-positives on benign sample: ${sample.slice(0, 60)}`,
    );
}
for (const sample of ENV_POSITIVE) {
  if (!FORBIDDEN_ENV.some((e) => envUsageRx(e).test(sample))) {
    selfTestFailures.push(`forbidden-env failed to match usage sample: ${sample}`);
  }
}
for (const sample of ENV_NEGATIVE) {
  const hit = FORBIDDEN_ENV.find((e) => envUsageRx(e).test(sample));
  if (hit)
    selfTestFailures.push(`forbidden-env false-positives on prose sample: ${sample.slice(0, 60)}`);
}

// --- scan -----------------------------------------------------------------
const SKIP_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.pdf',
  '.ico',
  '.woff',
  '.woff2',
  '.xz',
  '.gz',
  '.zip',
]);
// This file necessarily contains every pattern it looks for.
const SELF = 'scripts/check-secrets.mjs';

// Tracked files plus untracked ones that are not ignored: a secret sitting in a
// file that has not been committed yet is exactly the case worth catching.
let files;
try {
  files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
} catch {
  console.error('check-secrets: git ls-files failed; cannot determine the file set');
  process.exit(1);
}

for (const rel of files) {
  if (rel === SELF) continue;
  if (SKIP_EXT.has(extname(rel))) continue;
  let text;
  try {
    if (statSync(rel).size > 2_000_000) continue;
    text = readFileSync(rel, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  // Documentation is where the ban on these names is written down, so naming
  // them there is required, not a violation. Only executable surfaces count.
  const isDoc = extname(rel) === '.md';
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.rx.test(line)) findings.push(`${rel}:${i + 1}  ${rule.id}: ${rule.msg}`);
    }
    if (isDoc) return;
    for (const env of FORBIDDEN_ENV) {
      if (envUsageRx(env).test(line)) {
        findings.push(`${rel}:${i + 1}  forbidden-env: ${env} must not exist in this product`);
      }
    }
  });
}

// --- report ---------------------------------------------------------------
if (selfTestFailures.length > 0) {
  console.error(`check-secrets SELF-TEST FAILED - ${selfTestFailures.length} problem(s):`);
  for (const f of selfTestFailures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `note   ${RULES.length} content rules + ${FORBIDDEN_ENV.length} env rules self-tested (${POSITIVE.length + ENV_POSITIVE.length} positive, ${NEGATIVE.length + ENV_NEGATIVE.length} negative)`,
);
console.log(`note   scanned ${files.length} tracked file(s)`);

if (findings.length === 0) {
  console.log('\ncheck-secrets OK - 0 findings');
  process.exit(0);
}
console.error(`\ncheck-secrets FAILED - ${findings.length} finding(s):`);
for (const f of findings) console.error(`  - ${f}`);
process.exit(1);
