#!/usr/bin/env node
// Browser bundle audit. Zero dependencies.
//
// The console ships to a browser, so what ends up in the artifact is a security
// property, not a build detail. This checks the built output rather than the
// sources, because the question is what a reviewer would find in the file that
// actually loads:
//
//   1. No Node-only module reaches the bundle. An externalized `node:crypto` is
//      a crash waiting for the first user, and it means a server-side module was
//      pulled into a client.
//   2. No credential-shaped string is baked in.
//   3. No off-origin URL. The console talks to its own origin and nothing else,
//      which is what makes `connect-src 'self'` true rather than aspirational.
//   4. The shipped HTML actually carries the Content Security Policy.
//   5. No source map, which would publish the full source of a security tool.
//
// Self-tested on every run so a broken pattern cannot pass everything.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'apps/console/dist-web');
const failures = [];
const fail = (check, msg) => failures.push(`${check}: ${msg}`);

if (!existsSync(OUT)) {
  console.error(
    'verify:bundle FAILED - apps/console/dist-web is missing; run pnpm run console:build',
  );
  process.exit(1);
}

/** Node-only specifiers that must never appear in a browser artifact. */
const NODE_ONLY = [
  /(["'`])node:[a-z_]+\1/,
  /\brequire\s*\(\s*["'](?:fs|path|crypto|os|http|https|net|child_process)["']\s*\)/,
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bprocess\.(?:cwd|argv|versions)\b/,
];

/** Credential shapes. A bundle is public the moment it is served. */
const SECRET_SHAPES = [
  { name: 'pem-private-key', rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'postgres-dsn', rx: /postgres(?:ql)?:\/\/[^\s"'`]+/i },
  { name: 'aws-access-key', rx: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'github-token', rx: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'slack-webhook', rx: /hooks\.slack\.com\/services\/[A-Za-z0-9/]+/ },
  { name: 'evm-private-key', rx: /(?:private_?key|signer_?key)\s*[:=]\s*["']?0x[0-9a-fA-F]{64}/i },
];

/**
 * Off-origin URLs.
 *
 * `https://` in a string literal means the bundle knows about a host. The
 * console is supposed to know about exactly one: its own, which it never spells
 * out. Documentation URLs in comments are stripped by minification, so anything
 * left is real.
 */
const OFF_ORIGIN = /(["'`])(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^"'`]*\1/i;

/**
 * URLs that are text, not destinations.
 *
 * Listed one at a time with a reason. A broad pattern here would defeat the
 * whole check, so each entry has to earn its place:
 *
 *   react.dev/errors  concatenated into an invariant error message so a
 *                     developer can look the number up. Never fetched.
 *   w3.org namespaces XML namespace IDENTIFIERS passed to `createElementNS` and
 *                     `setAttributeNS`. They name a namespace; a browser has
 *                     never fetched them and the CSP would refuse it anyway.
 */
const INERT_URLS = [
  /^([`"'])https:\/\/react\.dev\/errors\/\1$/,
  /^([`"'])http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|1998\/Math\/MathML|XML\/1998\/namespace|2000\/xmlns\/)\1$/,
];

// --- self-test -------------------------------------------------------------
const CASES = [
  ['import x from "node:crypto";', NODE_ONLY, true],
  ['const a = require("fs");', NODE_ONLY, true],
  ['const p = __dirname;', NODE_ONLY, true],
  ['const ok = "node:not-a-specifier-here";', NODE_ONLY, false],
  ['const url = "/v1/deployments";', NODE_ONLY, false],
];
for (const [sample, rules, expected] of CASES) {
  const flagged = rules.some((rx) => rx.test(sample));
  if (flagged !== expected) {
    fail('selftest', `${JSON.stringify(sample)} expected flagged=${expected}, got ${flagged}`);
  }
}
const URL_CASES = [
  ['const a = "https://collector.example.com/x";', true],
  ['const b = "/v1/deployments";', false],
  ['const c = "#/d/acme";', false],
];
for (const [sample, expected] of URL_CASES) {
  const flagged = OFF_ORIGIN.test(sample);
  if (flagged !== expected) {
    fail('selftest', `${JSON.stringify(sample)} expected off-origin=${expected}, got ${flagged}`);
  }
}

// --- scan the artifact -----------------------------------------------------
const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(full);
  }
};
walk(OUT);

let scanned = 0;
for (const file of files) {
  const rel = file.slice(ROOT.length);
  if (file.endsWith('.map')) {
    fail('sourcemap', `${rel} ships a source map; the console publishes no source`);
    continue;
  }
  if (!/\.(js|css|html)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  scanned += 1;

  for (const rx of NODE_ONLY) {
    const m = rx.exec(text);
    if (m) fail('node-only', `${rel} contains a Node-only reference: ${m[0].slice(0, 60)}`);
  }
  for (const { name, rx } of SECRET_SHAPES) {
    if (rx.test(text)) fail('secret', `${rel} contains a ${name}`);
  }
  if (!file.endsWith('.css')) {
    const scan = new RegExp(OFF_ORIGIN.source, 'gi');
    for (const match of text.matchAll(scan)) {
      if (INERT_URLS.some((rx) => rx.test(match[0]))) continue;
      fail('off-origin', `${rel} references ${match[0].slice(0, 60)}`);
    }
  }
}

// --- policy in the shipped HTML -------------------------------------------
const htmlPath = join(OUT, 'index.html');
if (!existsSync(htmlPath)) {
  fail('html', 'dist-web/index.html is missing');
} else {
  const html = readFileSync(htmlPath, 'utf8');
  const required = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ];
  for (const directive of required) {
    if (!html.includes(directive)) fail('csp', `index.html is missing "${directive}"`);
  }
  if (!/http-equiv="Content-Security-Policy"/.test(html)) {
    fail('csp', 'index.html carries no Content-Security-Policy meta tag');
  }
  if (/\son\w+=/.test(html)) fail('csp', 'index.html contains an inline event handler');
}

console.log(`note   ${String(scanned)} bundle file(s) scanned in apps/console/dist-web`);
console.log(`note   ${String(CASES.length + URL_CASES.length)} pattern self-test case(s) passed`);

if (failures.length === 0) {
  console.log('\nverify:bundle OK - 0 findings');
  process.exit(0);
}
console.error(`\nverify:bundle FAILED - ${failures.length} finding(s):`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
